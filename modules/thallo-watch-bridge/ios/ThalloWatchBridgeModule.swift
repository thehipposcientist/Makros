// Phone-side WatchConnectivity bridge. Mirrors the JS API in
// `modules/thallo-watch-bridge/index.ts`. All outbound writes land in
// `updateApplicationContext` so the watch picks them up on cold start
// too — not just while reachable.

import ExpoModulesCore
import Foundation
import WatchConnectivity
import HealthKit
import UIKit
import os.log

private let wcLog = OSLog(subsystem: "com.thallo.app.watchbridge", category: "WC")
// TTL policy — drop stale REQUESTS, never casually drop user-entered
// FACTS. `pull_state` is a refresh request that is worthless once stale,
// so it keeps a short 2-minute window. Workout-session mutations
// (log_set / start / end / swap / add) are durable facts the user
// performed on the watch: a phone that was offline for days must still
// replay them on next launch, hence the 7-day window. Day-scoped logs
// (toggle_meal / log_hydration / supplements) keep 24h since they are
// only meaningful for the day they were taken.
private let staleWorkoutCommandWindowMs: Double = 7 * 24 * 60 * 60 * 1000
private let staleQueuedCommandWindowMs: Double = 24 * 60 * 60 * 1000
private let stalePullStateCommandWindowMs: Double = 2 * 60 * 1000
private let pullStateDispatchCooldownMs: Double = 3 * 1000
private let maxQueuedCommandEvents = 50
private let snapshotSchemaVersion = 1

public class ThalloWatchBridgeModule: Module {
    private let sessionHolder = _SessionHolder()

    public func definition() -> ModuleDefinition {
        Name("ThalloWatchBridgeModule")

        // `command` carries watch→phone taps (Start / Skip / Log set
        // / etc). `reachabilityChanged` fires when the WCSession
        // reachability flips — used by the JS side to re-push the
        // current app state the moment the watch app becomes
        // available, so opening the watch app gets an immediate
        // refresh instead of having to wait for the next state
        // change on the phone.
        Events("command", "reachabilityChanged")

        OnCreate {
            self.sessionHolder.activate { [weak self] name, body in
                self?.sendEvent(name, body)
            }
        }

        Function("setUserId") { (userId: String?) in
            self.sessionHolder.setUserId(userId)
        }

        Function("beginCommandListener") {
            self.sessionHolder.beginCommandListener()
        }

        Function("endCommandListener") {
            self.sessionHolder.endCommandListener()
        }

        Function("drainQueuedCommands") { () -> [[String: Any]] in
            return self.sessionHolder.drainQueuedCommands()
        }

        // Query helpers — the JS API wraps these as booleans.
        Function("isAvailable") { () -> Bool in
            WCSession.isSupported()
        }
        Function("isPaired") { () -> Bool in
            guard WCSession.isSupported() else { return false }
            return WCSession.default.isPaired
        }
        Function("isReachable") { () -> Bool in
            guard WCSession.isSupported() else { return false }
            return WCSession.default.isReachable
        }
        Function("isWatchAppInstalled") { () -> Bool in
            guard WCSession.isSupported() else { return false }
            return WCSession.default.isWatchAppInstalled
        }

        AsyncFunction("syncWorkout") { (payload: [String: Any]) -> Bool in
            let cleaned = _SessionHolder.stripNulls(payload)
            if let workout = cleaned["workout"] as? [String: Any] {
                // v2 workout sync ships a versioned envelope. Keep the legacy
                // top-level workout key in applicationContext so older watch
                // builds can still render today's session after a phone update.
                return self.sessionHolder.sendContext([
                    "workoutEnvelope": cleaned,
                    "workout": workout,
                ], realtimeKind: "workoutEnvelope")
            }
            return self.sessionHolder.sendContext(["workout": cleaned], realtimeKind: "workout")
        }

        AsyncFunction("syncTheme") { (palette: [String: Any]) -> Bool in
            return self.sessionHolder.sendContext(["theme": palette], realtimeKind: "theme")
        }

        AsyncFunction("syncCellularAuth") { (payload: [String: Any]) -> Bool in
            return self.sessionHolder.sendContext(["cellular": payload], realtimeKind: "cellular")
        }

        AsyncFunction("syncMeals") { (payload: [String: Any]) -> Bool in
            return self.sessionHolder.sendContext(["meals": payload], realtimeKind: "meals")
        }

        AsyncFunction("syncSupplements") { (payload: [String: Any]) -> Bool in
            return self.sessionHolder.sendContext(["supplements": payload], realtimeKind: "supplements")
        }

        AsyncFunction("syncHydration") { (payload: [String: Any]) -> Bool in
            return self.sessionHolder.sendContext(["hydration": payload], realtimeKind: "hydration")
        }

        AsyncFunction("syncActivity") { (payload: [String: Any]) -> Bool in
            return self.sessionHolder.sendContext(["activity": payload], realtimeKind: "activity")
        }

        AsyncFunction("syncLifestyle") { (payload: [String: Any]) -> Bool in
            return self.sessionHolder.sendContext(["lifestyle": payload], realtimeKind: "lifestyle")
        }

        AsyncFunction("syncSleep") { (payload: [String: Any]) -> Bool in
            return self.sessionHolder.sendContext(["sleep": payload], realtimeKind: "sleep")
        }

        AsyncFunction("syncReadiness") { (payload: [String: Any]) -> Bool in
            return self.sessionHolder.sendContext(["readiness": payload], realtimeKind: "readiness")
        }

        AsyncFunction("syncWeight") { (payload: [String: Any]) -> Bool in
            return self.sessionHolder.sendContext(["weight": payload], realtimeKind: "weight")
        }

        // Saved-templates list for the watch's Strength picker. Stored
        // in applicationContext so a cold watch launch can hydrate
        // immediately; no realtime push (the list rarely changes).
        AsyncFunction("syncTemplates") { (payload: [String: Any]) -> Bool in
            return self.sessionHolder.sendContext(["templates": payload], realtimeKind: "templates")
        }

        // Push parsed meal items to the watch for review after speech transcription.
        // Uses sendMessage (real-time) rather than applicationContext so the watch
        // gets the result while the user is waiting on the review screen.
        AsyncFunction("syncMealParsePreview") { (payload: [String: Any]) -> Bool in
            var msg = payload
            msg["kind"] = "mealParsePreview"
            return self.sessionHolder.sendMessage(msg)
        }

        // Live progress messages during an active session. They are sent
        // immediately and also written into applicationContext so a watch
        // view that wakes up after the realtime packet still hydrates the
        // latest set/rest state.
        AsyncFunction("updateProgress") { (progress: [String: Any]) -> Bool in
            var payload = progress
            payload["kind"] = "progress"
            return self.sessionHolder.sendProgress(payload)
        }

        AsyncFunction("startWatchWorkout") { () -> Bool in
            guard HKHealthStore.isHealthDataAvailable() else { return false }
            let store = HKHealthStore()
            let config = HKWorkoutConfiguration()
            config.activityType = .traditionalStrengthTraining
            config.locationType = .indoor
            return await withCheckedContinuation { cont in
                store.startWatchApp(with: config) { success, _ in
                    cont.resume(returning: success)
                }
            }
        }
    }
}

// Keeps the WCSession delegate alive across hot reloads and routes
// incoming commands into the Expo event stream.
private class _SessionHolder: NSObject, WCSessionDelegate {
    private let queuedCommandsKey = "thallo.watchBridge.queuedCommands"
    private let legacyQueuedHydrationCommandsKey = "thallo.watchBridge.queuedHydrationCommands"
    private let recentCommandIdsKey = "thallo.watchBridge.recentCommandIds"
    private let lastSnapshotKey = "thallo.watchBridge.lastSnapshot"
    private let snapshotVersionKey = "thallo.watchBridge.snapshotVersion"
    private var dispatchEvent: ((String, [String: Any]) -> Void)?
    private var userId: String?
    private var commandListenerCount = 0
    private var queuedCommands: [[String: Any]] = []
    private var pendingContext: [String: Any] = [:]
    private var pendingMessages: [[String: Any]] = []
    private var latestProgressContext: [String: Any]?
    private var latestApplicationContext: [String: Any] = [:]
    private let outboundLock = NSRecursiveLock()
    private var recentCommandIds: [String] = []
    private var recentCommandIdSet: Set<String> = []
    private var recentCommandIdsLoaded = false
    private var lastPullStateDispatchedAtMs: Double = 0
    private var snapshotVersionSequence: Int = 0
    private var lifecycleObserverTokens: [NSObjectProtocol] = []

    func setUserId(_ id: String?) {
        withOutboundLock { self.userId = id }
    }

    func beginCommandListener() {
        commandListenerCount += 1
    }

    func endCommandListener() {
        commandListenerCount = max(0, commandListenerCount - 1)
    }

    func drainQueuedCommands() -> [[String: Any]] {
        let queued = compactQueuedCommandEvents(queuedCommands + loadQueuedCommands())
        queuedCommands.removeAll()
        saveQueuedCommands([])
        logDiag("command.drained", ["count": queued.count])
        return queued
    }

    func activate(sendEvent: @escaping (String, [String: Any]) -> Void) {
        self.dispatchEvent = sendEvent
        installLifecycleObservers()
        guard WCSession.isSupported() else {
            os_log("[wc-bridge] WCSession not supported on this device", log: wcLog, type: .error)
            return
        }
        let s = WCSession.default
        s.delegate = self
        withOutboundLock {
            self.snapshotVersionSequence = UserDefaults.standard.integer(forKey: self.snapshotVersionKey)
            // Prefer the OS-persisted applicationContext (authoritative
            // last write). If it is empty — e.g. a context write never
            // succeeded — fall back to the snapshot the bridge persisted
            // itself, so a cold / background launch can still answer the
            // watch from cache before React Native is running.
            let osContext = s.applicationContext
            self.latestApplicationContext = osContext.isEmpty ? self.loadPersistedSnapshot() : osContext
        }
        os_log("[wc-bridge] activate called, preState=%d, paired=%d, reachable=%d", log: wcLog, type: .default, s.activationState.rawValue, s.isPaired ? 1 : 0, s.isReachable ? 1 : 0)
        logDiag("activate.called", [
            "preState": s.activationState.rawValue,
        ])
        if s.activationState != .activated {
            s.activate()
        }
    }

    static func stripNulls(_ dict: [String: Any]) -> [String: Any] {
        var result: [String: Any] = [:]
        for (key, value) in dict {
            if value is NSNull { continue }
            if let nested = value as? [String: Any] {
                result[key] = stripNulls(nested)
            } else if let arr = value as? [Any] {
                result[key] = arr.compactMap { item -> Any? in
                    if item is NSNull { return nil }
                    if let d = item as? [String: Any] { return stripNulls(d) }
                    return item
                }
            } else {
                result[key] = value
            }
        }
        return result
    }

    // Structured bridge telemetry. Previously a no-op; now emits to the
    // unified log so the watch-sync command lifecycle (received / queued /
    // drained / deduped / dropped / snapshot published) is inspectable
    // from Console.app and sysdiagnose without a debugger attached.
    private func logDiag(_ event: String, _ extra: [String: Any] = [:]) {
        if extra.isEmpty {
            os_log("[wc-bridge] %{public}@", log: wcLog, type: .default, event)
            return
        }
        let detail = extra
            .map { "\($0.key)=\($0.value)" }
            .sorted()
            .joined(separator: " ")
        os_log("[wc-bridge] %{public}@ %{public}@", log: wcLog, type: .default, event, detail)
    }

    private func stampUserId(_ dict: inout [String: Any]) {
        if let uid = userId, !uid.isEmpty {
            dict["userId"] = uid
        }
    }

    private func withOutboundLock<T>(_ work: () -> T) -> T {
        outboundLock.lock()
        defer { outboundLock.unlock() }
        return work()
    }

    private func mergedApplicationContext(for session: WCSession) -> [String: Any] {
        var merged = session.applicationContext
        for (key, value) in latestApplicationContext {
            merged[key] = value
        }
        return merged
    }

    @discardableResult
    func sendContext(_ dict: [String: Any], realtimeKind: String? = nil) -> Bool {
        return withOutboundLock {
            guard WCSession.isSupported() else { return false }
            let s = WCSession.default
            let cleaned = Self.stripNulls(dict)
            guard s.activationState == .activated else {
                for (k, v) in cleaned { pendingContext[k] = v }
                logDiag("sendContext.pending", [
                    "keys": cleaned.keys.sorted().joined(separator: ","),
                ])
                s.activate()
                return true
            }
            flushPendingOutbound()
            return sendContextActivated(cleaned, session: s, realtimeKind: realtimeKind)
        }
    }

    @discardableResult
    private func sendContextActivated(_ cleaned: [String: Any], session s: WCSession, realtimeKind: String? = nil) -> Bool {
        return withOutboundLock {
            var merged = mergedApplicationContext(for: s)
            for (k, v) in cleaned { merged[k] = v }
            if let progress = cleaned["progress"] as? [String: Any] {
                rememberLatestProgress(progress)
            } else {
                preserveLatestProgress(in: &merged)
            }
            if let uid = userId, !uid.isEmpty {
                merged["userId"] = uid
            } else {
                merged.removeValue(forKey: "userId")
            }
            stampSnapshotMeta(&merged, source: realtimeKind)
            do {
                try s.updateApplicationContext(merged)
                latestApplicationContext = merged
                persistLatestSnapshot(merged)
                logDiag("snapshot.published", [
                    "keys": cleaned.keys.sorted().joined(separator: ","),
                    "bytes": approximateBytes(cleaned),
                ])
                if s.isReachable {
                    let realtime = realtimeMessage(for: cleaned, kind: realtimeKind)
                    logDiag("sendContext.realtime", [
                        "keys": cleaned.keys.sorted().joined(separator: ","),
                        "kind": realtimeKind ?? "",
                    ])
                    _ = sendMessageActivated(realtime, session: s)
                }
                return true
            } catch {
                latestApplicationContext = merged
                os_log("[wc-bridge] updateApplicationContext failed: %{public}@", log: wcLog, type: .error, "\(error)")
                logDiag("sendContext.failed", [
                    "keys": cleaned.keys.sorted().joined(separator: ","),
                    "error": error.localizedDescription,
                ])
                var fallback = cleaned
                stampUserId(&fallback)
                if s.isReachable {
                    _ = sendMessageActivated(realtimeMessage(for: cleaned, kind: realtimeKind), session: s)
                    return true
                }
                s.transferUserInfo(fallback)
                return true
            }
        }
    }

    private func realtimeMessage(for cleaned: [String: Any], kind: String?) -> [String: Any] {
        guard let kind, let payload = cleaned[kind] else {
            var stamped = cleaned
            stampUserId(&stamped)
            return stamped
        }
        var msg: [String: Any] = [
            "kind": kind,
            "payload": payload,
        ]
        stampUserId(&msg)
        return msg
    }

    private func approximateBytes(_ dict: [String: Any]) -> Int {
        guard JSONSerialization.isValidJSONObject(dict),
              let data = try? JSONSerialization.data(withJSONObject: dict)
        else { return -1 }
        return data.count
    }

    @discardableResult
    func sendMessage(_ dict: [String: Any]) -> Bool {
        return withOutboundLock {
            guard WCSession.isSupported() else { return false }
            let s = WCSession.default
            let cleaned = Self.stripNulls(dict)
            guard s.activationState == .activated else {
                pendingMessages.append(cleaned)
                s.activate()
                return true
            }
            var stamped = cleaned
            stampUserId(&stamped)
            flushPendingOutbound()
            return sendMessageActivated(stamped, session: s)
        }
    }

    @discardableResult
    func sendProgress(_ dict: [String: Any]) -> Bool {
        return withOutboundLock {
            guard WCSession.isSupported() else { return false }
            let s = WCSession.default
            let cleaned = Self.stripNulls(dict)
            guard s.activationState == .activated else {
                pendingContext["progress"] = cleaned
                pendingMessages.append(cleaned)
                rememberLatestProgress(cleaned)
                s.activate()
                return true
            }

            var stamped = cleaned
            stampUserId(&stamped)
            rememberLatestProgress(stamped)
            flushPendingOutbound()
            do {
                var merged = mergedApplicationContext(for: s)
                merged["progress"] = stamped
                if let uid = userId, !uid.isEmpty {
                    merged["userId"] = uid
                } else {
                    merged.removeValue(forKey: "userId")
                }
                stampSnapshotMeta(&merged, source: "progress")
                try s.updateApplicationContext(merged)
                latestApplicationContext = merged
                persistLatestSnapshot(merged)
                logDiag("sendProgress.updated", [
                    "revision": stamped["progressRevision"] ?? "",
                    "sessionId": stamped["sessionId"] ?? "",
                ])
            } catch {
                os_log("[wc-bridge] progress applicationContext failed: %{public}@", log: wcLog, type: .error, error.localizedDescription)
                logDiag("sendProgress.contextFailed", ["error": error.localizedDescription])
            }
            return sendMessageActivated(stamped, session: s)
        }
    }

    private func rememberLatestProgress(_ progress: [String: Any]) {
        guard !progress.isEmpty else { return }
        let incomingRevision = numericMs(progress["progressRevision"]) ?? 0
        let currentRevision = numericMs(latestProgressContext?["progressRevision"]) ?? -1
        if latestProgressContext == nil || incomingRevision >= currentRevision {
            latestProgressContext = progress
        }
    }

    private func preserveLatestProgress(in merged: inout [String: Any]) {
        guard let latest = latestProgressContext else { return }
        let latestRevision = numericMs(latest["progressRevision"]) ?? 0
        let mergedProgress = merged["progress"] as? [String: Any]
        let mergedRevision = numericMs(mergedProgress?["progressRevision"]) ?? -1
        if latestRevision >= mergedRevision {
            merged["progress"] = latest
        }
    }

    @discardableResult
    private func sendMessageActivated(_ cleaned: [String: Any], session s: WCSession) -> Bool {
        if s.isReachable {
            s.sendMessage(cleaned, replyHandler: nil) { err in
                os_log("[wc-bridge] sendMessage failed: %{public}@", log: wcLog, type: .error, err.localizedDescription)
                s.transferUserInfo(cleaned)
            }
            return true
        }
        s.transferUserInfo(cleaned)
        return true
    }

    private func flushPendingOutbound() {
        withOutboundLock {
            guard WCSession.isSupported() else { return }
            let s = WCSession.default
            guard s.activationState == .activated else { return }
            if !pendingContext.isEmpty {
                let context = pendingContext
                pendingContext.removeAll()
                _ = sendContextActivated(context, session: s)
            }
            if !pendingMessages.isEmpty {
                let messages = pendingMessages
                pendingMessages.removeAll()
                for message in messages {
                    var stamped = message
                    stampUserId(&stamped)
                    _ = sendMessageActivated(stamped, session: s)
                }
            }
        }
    }

    // MARK: Snapshot cache

    /// Stamp a transport envelope onto the outbound snapshot so the watch
    /// — and anyone reading the logs — can tell which version of phone
    /// state it is looking at and where it came from. Watch-side `Codable`
    /// decoders ignore the unknown `_meta` key, so this is purely additive.
    private func stampSnapshotMeta(_ dict: inout [String: Any], source: String?) {
        snapshotVersionSequence += 1
        var meta: [String: Any] = [
            "schemaVersion": snapshotSchemaVersion,
            "snapshotVersion": snapshotVersionSequence,
            "generatedAt": Date().timeIntervalSince1970 * 1000,
            "source": "phone-bridge",
        ]
        if let source, !source.isEmpty { meta["channel"] = source }
        dict["_meta"] = meta
        UserDefaults.standard.set(snapshotVersionSequence, forKey: snapshotVersionKey)
    }

    /// Persist the latest merged snapshot so a cold / background launch
    /// can answer the watch even before React Native is running. iOS
    /// already persists `applicationContext`; this is a belt-and-braces
    /// copy for the case where the context write itself failed.
    private func persistLatestSnapshot(_ snapshot: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(snapshot),
              let data = try? JSONSerialization.data(withJSONObject: snapshot) else { return }
        UserDefaults.standard.set(data, forKey: lastSnapshotKey)
    }

    private func loadPersistedSnapshot() -> [String: Any] {
        guard let data = UserDefaults.standard.data(forKey: lastSnapshotKey),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return dict
    }

    /// Answer a watch `pull_state` directly from the bridge's cached
    /// snapshot before JS has a chance to rebuild a fresher one. This keeps
    /// the watch responsive when the phone app is suspended / backgrounded /
    /// cold-launching, and it is harmless while JS is active because the JS
    /// handler follows up with an authoritative snapshot. The snapshot already
    /// carries its `_meta` from when it was built, so it is re-sent as-is.
    private func respondToPullStateFromCache() {
        withOutboundLock {
            guard WCSession.isSupported() else { return }
            let s = WCSession.default
            guard s.activationState == .activated else { return }
            var snapshot = latestApplicationContext
            if snapshot.isEmpty { snapshot = loadPersistedSnapshot() }
            guard !snapshot.isEmpty else {
                logDiag("pullState.native.noCache")
                return
            }
            do {
                try s.updateApplicationContext(snapshot)
                latestApplicationContext = snapshot
            } catch {
                os_log("[wc-bridge] pullState native context failed: %{public}@", log: wcLog, type: .error, "\(error)")
            }
            if s.isReachable {
                _ = sendMessageActivated(snapshot, session: s)
            }
            logDiag("pullState.native.responded", [
                "reachable": s.isReachable ? 1 : 0,
                "keys": snapshot.keys.sorted().joined(separator: ","),
            ])
        }
    }

    // MARK: WCSessionDelegate
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        logDiag("activationDidComplete", [
            "completedState": activationState.rawValue,
            "error": error?.localizedDescription ?? "",
        ])
        if activationState == .activated {
            flushPendingOutbound()
        }
        // Fire a reachability event on activation too so the JS side
        // can push a fresh snapshot even if reachability was already
        // true by the time the listener wired up.
        DispatchQueue.main.async {
            self.dispatchEvent?("reachabilityChanged", [
                "reachable": session.isReachable,
                "paired": session.isPaired,
                "installed": session.isWatchAppInstalled,
            ])
        }
    }
    func sessionReachabilityDidChange(_ session: WCSession) {
        logDiag("reachabilityDidChange")
        // The watch app just opened / closed. When reachable, JS
        // re-pushes the current workout + meals + theme so the watch
        // wakes up with the latest state instead of whatever was
        // queued last.
        DispatchQueue.main.async {
            self.dispatchEvent?("reachabilityChanged", [
                "reachable": session.isReachable,
                "paired": session.isPaired,
                "installed": session.isWatchAppInstalled,
            ])
        }
    }
    func sessionDidBecomeInactive(_ session: WCSession) {
        logDiag("sessionDidBecomeInactive")
    }
    func sessionDidDeactivate(_ session: WCSession) {
        logDiag("sessionDidDeactivate")
        // Rare — iOS calls this after a watch swap. Reactivate.
        WCSession.default.activate()
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        let kind = (message["kind"] as? String) ?? "<missing>"
        let cmd = (message["command"] as? String) ?? "<none>"
        os_log("[wc-bridge] didReceiveMessage kind=%{public}@ command=%{public}@", log: wcLog, type: .default, kind, cmd)
        logDiag("didReceiveMessage", [
            "kind": kind,
            "command": cmd,
            "keyCount": message.count,
        ])
        dispatchCommand(message)
    }
    func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        let kind = (message["kind"] as? String) ?? "<missing>"
        let cmd = (message["command"] as? String) ?? "<none>"
        os_log("[wc-bridge] didReceiveMessage(reply) kind=%{public}@ command=%{public}@", log: wcLog, type: .default, kind, cmd)
        logDiag("didReceiveMessage(reply)", [
            "kind": kind,
            "command": cmd,
            "keyCount": message.count,
        ])
        dispatchCommand(message)
        replyHandler(["ok": true])
    }
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        let kind = (userInfo["kind"] as? String) ?? "<missing>"
        let cmd = (userInfo["command"] as? String) ?? "<none>"
        os_log("[wc-bridge] didReceiveUserInfo kind=%{public}@ command=%{public}@", log: wcLog, type: .default, kind, cmd)
        logDiag("didReceiveUserInfo", [
            "kind": kind,
            "command": cmd,
            "keyCount": userInfo.count,
        ])
        dispatchCommand(userInfo)
    }
    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        // Phone normally writes context, doesn't read it — but log
        // anyway in case the watch ever sends one.
        logDiag("didReceiveApplicationContext", [
            "keyCount": applicationContext.count,
        ])
    }

    private func dispatchCommand(_ msg: [String: Any]) {
        guard (msg["kind"] as? String) == "command",
              let cmd = msg["command"] as? String else {
            os_log("[wc-bridge] dispatchCommand: not a command (kind=%{public}@)", log: wcLog, type: .default, (msg["kind"] as? String) ?? "<nil>")
            return
        }
        if shouldDropStaleCommand(cmd, msg) {
            return
        }
        if shouldDropDuplicatePullState(cmd, msg) {
            return
        }
        if let commandId = msg["commandId"] as? String, !commandId.isEmpty {
            ensureRecentCommandIdsLoaded()
            if recentCommandIdSet.contains(commandId) {
                os_log("[wc-bridge] duplicate command ignored=%{public}@", log: wcLog, type: .default, cmd)
                logDiag("dispatchCommand.duplicate", [
                    "command": cmd,
                    "commandId": commandId,
                ])
                return
            }
            rememberCommandId(commandId)
        }
        logDiag("command.received", ["command": cmd])
        var payload = msg
        payload.removeValue(forKey: "kind")
        payload.removeValue(forKey: "command")
        os_log("[wc-bridge] dispatching command=%{public}@ to JS", log: wcLog, type: .default, cmd)
        let event: [String: Any] = ["command": cmd, "payload": payload]
        if cmd == "pull_state" {
            // Always answer a watch refresh from the native snapshot cache.
            // When the phone app is backgrounded, JS listeners can still be
            // registered even though React Native is suspended; waiting for JS
            // in that state makes the watch look stale. If JS is actually
            // active it will still receive the command below and push a fresher
            // authoritative snapshot immediately after this cached response.
            respondToPullStateFromCache()
        }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if self.commandListenerCount > 0 && self.isApplicationActive {
                self.logDiag("command.dispatched", ["command": cmd])
                self.dispatchEvent?("command", event)
            } else {
                // No JS command listener attached — the phone app is
                // suspended / backgrounded / cold-launching. Queue durable
                // commands until the app becomes active; dispatching into a
                // suspended React Native bridge can silently strand a watch tap.
                let reason = self.commandListenerCount > 0 ? "background" : "noListener"
                self.queueCommandEvent(event, command: cmd, reason: reason)
                os_log("[wc-bridge] queued command=%{public}@ until JS listener attaches", log: wcLog, type: .default, cmd)
            }
        }
    }

    private var isApplicationActive: Bool {
        UIApplication.shared.applicationState == .active
    }

    private func installLifecycleObservers() {
        guard lifecycleObserverTokens.isEmpty else { return }
        let token = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.dispatchQueuedCommandsIfPossible(source: "appActive")
        }
        lifecycleObserverTokens.append(token)
    }

    private func queueCommandEvent(_ event: [String: Any], command: String, reason: String) {
        queuedCommands.append(event)
        persistQueuedCommand(event)
        if queuedCommands.count > maxQueuedCommandEvents {
            queuedCommands.removeFirst(queuedCommands.count - maxQueuedCommandEvents)
        }
        logDiag("command.queued", [
            "command": command,
            "depth": queuedCommands.count,
            "reason": reason,
        ])
    }

    private func dispatchQueuedCommandsIfPossible(source: String) {
        guard commandListenerCount > 0, isApplicationActive else { return }
        let queued = compactQueuedCommandEvents(queuedCommands + loadQueuedCommands())
        guard !queued.isEmpty else { return }
        queuedCommands.removeAll()
        saveQueuedCommands([])
        logDiag("command.flushQueuedToJS", [
            "count": queued.count,
            "source": source,
        ])
        for event in queued {
            guard let command = event["command"] as? String else { continue }
            logDiag("command.dispatchedQueued", ["command": command, "source": source])
            dispatchEvent?("command", event)
        }
    }

    private func loadQueuedCommands() -> [[String: Any]] {
        let current = UserDefaults.standard.array(forKey: queuedCommandsKey) as? [[String: Any]] ?? []
        let legacy = UserDefaults.standard.array(forKey: legacyQueuedHydrationCommandsKey) as? [[String: Any]] ?? []
        if !legacy.isEmpty {
            UserDefaults.standard.removeObject(forKey: legacyQueuedHydrationCommandsKey)
        }
        return current + legacy
    }

    private func saveQueuedCommands(_ events: [[String: Any]]) {
        if events.isEmpty {
            UserDefaults.standard.removeObject(forKey: queuedCommandsKey)
        } else {
            UserDefaults.standard.set(events, forKey: queuedCommandsKey)
        }
    }

    private func persistQueuedCommand(_ event: [String: Any]) {
        guard shouldPersistQueuedCommand(event) else { return }
        var events = loadQueuedCommands()
        events.append(event)
        saveQueuedCommands(compactQueuedCommandEvents(events))
    }

    private func shouldPersistQueuedCommand(_ event: [String: Any]) -> Bool {
        guard let command = event["command"] as? String else { return false }
        return durableQueuedCommands.contains(command)
    }

    private var durableQueuedCommands: Set<String> {
        [
            "start_workout",
            "start_custom_workout",
            "skip_workout",
            "end_workout",
            "cancel_workout",
            "log_set",
            "skip_rest",
            "swap_exercise",
            // add_exercise is a durable mutation: when the watch's
            // mid-workout Quick-Add fires while the JS listener isn't
            // attached (phone restart, app launch), it must persist
            // through UserDefaults so the next ActiveWorkoutScreen
            // mount drains it. Without this it stays in-memory only
            // and dies with the process.
            "add_exercise",
            "add_circuit",
            "toggle_meal",
            "log_hydration",
            "log_lifestyle",
            "toggle_supplement",
            "take_supplement_group",
            "take_all_supplements",
            "log_weight",
            "parse_meal_speech",
            "confirm_meal_speech",
            "pull_state",
        ]
    }

    private func compactQueuedCommandEvents(_ events: [[String: Any]]) -> [[String: Any]] {
        let nowMs = Date().timeIntervalSince1970 * 1000
        let deduped = dedupCommandEvents(events).filter { event in
            guard shouldPersistQueuedCommand(event),
                  let command = event["command"] as? String
            else { return false }
            let payload = event["payload"] as? [String: Any]
            guard let tsMs = numericMs(payload?["tsMs"]) else { return true }
            let window = staleWindowMs(for: command)
            return nowMs - tsMs <= window
        }
        if deduped.count > maxQueuedCommandEvents {
            return Array(deduped.suffix(maxQueuedCommandEvents))
        }
        return deduped
    }

    private func dedupCommandEvents(_ events: [[String: Any]]) -> [[String: Any]] {
        var seen = Set<String>()
        var deduped: [[String: Any]] = []
        for event in events {
            let commandId = (event["payload"] as? [String: Any])?["commandId"] as? String
            if let commandId = commandId, !commandId.isEmpty {
                if seen.contains(commandId) { continue }
                seen.insert(commandId)
            }
            deduped.append(event)
        }
        return deduped
    }

    private func shouldDropStaleCommand(_ command: String, _ msg: [String: Any]) -> Bool {
        guard let tsMs = numericMs(msg["tsMs"]) else { return false }

        let ageMs = Date().timeIntervalSince1970 * 1000 - tsMs
        let window = staleWindowMs(for: command)
        guard ageMs > window else { return false }
        os_log("[wc-bridge] stale command ignored=%{public}@ ageMs=%.0f", log: wcLog, type: .default, command, ageMs)
        logDiag("dispatchCommand.staleDropped", [
            "command": command,
            "ageMs": ageMs,
        ])
        return true
    }

    private func shouldDropDuplicatePullState(_ command: String, _ msg: [String: Any]) -> Bool {
        guard command == "pull_state" else { return false }
        // Force pulls always pass and do NOT extend the cooldown
        // window. A force is an explicit "I need fresh state now"
        // signal — letting it poison the bucket would silently drop
        // a follow-up non-force pull that the watch sends moments
        // later (e.g. user taps the refresh strip then locks/unlocks
        // and the wake-pull arrives within 3s).
        if (msg["force"] as? Bool) == true {
            return false
        }
        let nowMs = Date().timeIntervalSince1970 * 1000
        if nowMs - lastPullStateDispatchedAtMs < pullStateDispatchCooldownMs {
            os_log("[wc-bridge] duplicate pull_state ignored", log: wcLog, type: .default)
            logDiag("dispatchCommand.pullStateCooldown")
            return true
        }
        lastPullStateDispatchedAtMs = nowMs
        return false
    }

    private func isWorkoutCommand(_ command: String) -> Bool {
        [
            "start_workout",
            "start_custom_workout",
            "skip_workout",
            "log_set",
            "swap_exercise",
            "skip_rest",
            "add_exercise",
            "add_circuit",
            "end_workout",
            "cancel_workout",
        ].contains(command)
    }

    private func staleWindowMs(for command: String) -> Double {
        if command == "pull_state" { return stalePullStateCommandWindowMs }
        return isWorkoutCommand(command) ? staleWorkoutCommandWindowMs : staleQueuedCommandWindowMs
    }

    private func numericMs(_ value: Any?) -> Double? {
        if let d = value as? Double, d.isFinite { return d }
        if let i = value as? Int { return Double(i) }
        if let n = value as? NSNumber {
            let d = n.doubleValue
            return d.isFinite ? d : nil
        }
        if let s = value as? String,
           let d = Double(s.trimmingCharacters(in: .whitespacesAndNewlines)),
           d.isFinite {
            return d
        }
        return nil
    }

    private func ensureRecentCommandIdsLoaded() {
        guard !recentCommandIdsLoaded else { return }
        recentCommandIdsLoaded = true
        let ids = UserDefaults.standard.stringArray(forKey: recentCommandIdsKey) ?? []
        recentCommandIds = ids
        recentCommandIdSet = Set(ids)
    }

    private func rememberCommandId(_ commandId: String) {
        ensureRecentCommandIdsLoaded()
        recentCommandIds.append(commandId)
        recentCommandIdSet.insert(commandId)
        if recentCommandIds.count > 100 {
            let overflow = recentCommandIds.count - 100
            let dropped = recentCommandIds.prefix(overflow)
            for id in dropped { recentCommandIdSet.remove(id) }
            recentCommandIds.removeFirst(overflow)
        }
        UserDefaults.standard.set(recentCommandIds, forKey: recentCommandIdsKey)
    }
}
