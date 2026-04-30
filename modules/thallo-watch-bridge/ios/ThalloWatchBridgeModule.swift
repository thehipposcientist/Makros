// Phone-side WatchConnectivity bridge. Mirrors the JS API in
// `modules/thallo-watch-bridge/index.ts`. All outbound writes land in
// `updateApplicationContext` so the watch picks them up on cold start
// too — not just while reachable.

import ExpoModulesCore
import WatchConnectivity
import HealthKit
import os.log

private let wcLog = OSLog(subsystem: "com.thallo.app.watchbridge", category: "WC")

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
        // change on the phone. `watchSessionDiag` is a verbose
        // diagnostic firehose — every WCSession delegate callback
        // (activation / reachability / receive paths) emits one entry
        // with full session state. JS turns each event into a
        // `[wc-diag]` console.log line, visible in Console.app with
        // the iPhone tethered (filter "ThalloWatch" or "wc-diag").
        Events("command", "reachabilityChanged", "watchSessionDiag")

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

        AsyncFunction("syncMeals") { (payload: [String: Any]) -> Bool in
            return self.sessionHolder.sendContext(["meals": payload], realtimeKind: "meals")
        }

        AsyncFunction("syncSupplements") { (payload: [String: Any]) -> Bool in
            return self.sessionHolder.sendContext(["supplements": payload], realtimeKind: "supplements")
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

        // Push parsed meal items to the watch for review after speech transcription.
        // Uses sendMessage (real-time) rather than applicationContext so the watch
        // gets the result while the user is waiting on the review screen.
        AsyncFunction("syncMealParsePreview") { (payload: [String: Any]) -> Bool in
            var msg = payload
            msg["kind"] = "mealParsePreview"
            return self.sessionHolder.sendMessage(msg)
        }

        // Live progress messages during an active session. We use
        // sendMessage (not applicationContext) so the watch sees each
        // tick when reachable; transferUserInfo is the fallback so
        // updates still flow when the watch is asleep / off-wrist.
        AsyncFunction("updateProgress") { (progress: [String: Any]) -> Bool in
            var payload = progress
            payload["kind"] = "progress"
            return self.sessionHolder.sendMessage(payload)
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
    private var dispatchEvent: ((String, [String: Any]) -> Void)?
    private var userId: String?
    private var commandListenerCount = 0
    private var queuedCommands: [[String: Any]] = []
    private var pendingContext: [String: Any] = [:]
    private var pendingMessages: [[String: Any]] = []
    private var recentCommandIds: [String] = []
    private var recentCommandIdSet: Set<String> = []

    func setUserId(_ id: String?) { self.userId = id }

    func beginCommandListener() {
        commandListenerCount += 1
    }

    func endCommandListener() {
        commandListenerCount = max(0, commandListenerCount - 1)
    }

    func drainQueuedCommands() -> [[String: Any]] {
        let queued = queuedCommands
        queuedCommands.removeAll()
        return queued
    }

    func activate(sendEvent: @escaping (String, [String: Any]) -> Void) {
        self.dispatchEvent = sendEvent
        guard WCSession.isSupported() else {
            os_log("[wc-bridge] WCSession not supported on this device", log: wcLog, type: .error)
            sendEvent("watchSessionDiag", [
                "event": "activate.unsupported",
                "ts": Date().timeIntervalSince1970 * 1000,
            ])
            return
        }
        let s = WCSession.default
        s.delegate = self
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

    /// Emit a verbose diagnostic line. Captures full WCSession state at
    /// the moment of every delegate callback (activationState, paired,
    /// installed, reachable). JS forwards each entry to console.log
    /// with a `[wc-diag]` prefix — visible via Console.app on Mac.
    private func logDiag(_ event: String, _ extra: [String: Any] = [:]) {
        guard WCSession.isSupported() else { return }
        let s = WCSession.default
        var payload: [String: Any] = [
            "event": event,
            "ts": Date().timeIntervalSince1970 * 1000,
            "activationState": s.activationState.rawValue,
            "paired": s.isPaired,
            "installed": s.isWatchAppInstalled,
            "reachable": s.isReachable,
        ]
        for (k, v) in extra { payload[k] = v }
        DispatchQueue.main.async { [weak self] in
            self?.dispatchEvent?("watchSessionDiag", payload)
        }
    }

    private func stampUserId(_ dict: inout [String: Any]) {
        if let uid = userId, !uid.isEmpty {
            dict["userId"] = uid
        }
    }

    @discardableResult
    func sendContext(_ dict: [String: Any], realtimeKind: String? = nil) -> Bool {
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

    @discardableResult
    private func sendContextActivated(_ cleaned: [String: Any], session s: WCSession, realtimeKind: String? = nil) -> Bool {
        do {
            var merged = s.applicationContext
            for (k, v) in cleaned { merged[k] = v }
            if let uid = userId, !uid.isEmpty {
                merged["userId"] = uid
            } else {
                merged.removeValue(forKey: "userId")
            }
            try s.updateApplicationContext(merged)
            logDiag("sendContext.updated", [
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
            os_log("[wc-bridge] updateApplicationContext failed: %{public}@", log: wcLog, type: .error, "\(error)")
            logDiag("sendContext.failed", [
                "keys": cleaned.keys.sorted().joined(separator: ","),
                "error": error.localizedDescription,
            ])
            var fallback = cleaned
            stampUserId(&fallback)
            if s.isReachable {
                _ = sendMessageActivated(fallback, session: s)
                return true
            }
            s.transferUserInfo(fallback)
            return true
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
        if let commandId = msg["commandId"] as? String, !commandId.isEmpty {
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
        var payload = msg
        payload.removeValue(forKey: "kind")
        payload.removeValue(forKey: "command")
        os_log("[wc-bridge] dispatching command=%{public}@ to JS", log: wcLog, type: .default, cmd)
        let event: [String: Any] = ["command": cmd, "payload": payload]
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if self.commandListenerCount > 0 {
                self.dispatchEvent?("command", event)
            } else {
                self.queuedCommands.append(event)
                if self.queuedCommands.count > 50 {
                    self.queuedCommands.removeFirst(self.queuedCommands.count - 50)
                }
                os_log("[wc-bridge] queued command=%{public}@ until JS listener attaches", log: wcLog, type: .default, cmd)
            }
        }
    }

    private func rememberCommandId(_ commandId: String) {
        recentCommandIds.append(commandId)
        recentCommandIdSet.insert(commandId)
        if recentCommandIds.count > 100 {
            let overflow = recentCommandIds.count - 100
            let dropped = recentCommandIds.prefix(overflow)
            for id in dropped { recentCommandIdSet.remove(id) }
            recentCommandIds.removeFirst(overflow)
        }
    }
}
