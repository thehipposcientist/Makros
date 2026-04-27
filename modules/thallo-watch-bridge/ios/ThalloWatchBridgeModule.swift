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
            return self.sessionHolder.sendContext(["workout": payload])
        }

        AsyncFunction("syncTheme") { (palette: [String: Any]) -> Bool in
            return self.sessionHolder.sendContext(["theme": palette])
        }

        AsyncFunction("syncMeals") { (payload: [String: Any]) -> Bool in
            return self.sessionHolder.sendContext(["meals": payload])
        }

        AsyncFunction("syncSupplements") { (payload: [String: Any]) -> Bool in
            return self.sessionHolder.sendContext(["supplements": payload])
        }

        AsyncFunction("syncSleep") { (payload: [String: Any]) -> Bool in
            return self.sessionHolder.sendContext(["sleep": payload])
        }

        AsyncFunction("syncReadiness") { (payload: [String: Any]) -> Bool in
            return self.sessionHolder.sendContext(["readiness": payload])
        }

        AsyncFunction("syncWeight") { (payload: [String: Any]) -> Bool in
            return self.sessionHolder.sendContext(["weight": payload])
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

    func setUserId(_ id: String?) { self.userId = id }

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
    func sendContext(_ dict: [String: Any]) -> Bool {
        guard WCSession.isSupported() else { return false }
        let s = WCSession.default
        guard s.activationState == .activated else { return false }
        let cleaned = Self.stripNulls(dict)
        do {
            var merged = s.applicationContext
            for (k, v) in cleaned { merged[k] = v }
            if let uid = userId, !uid.isEmpty {
                merged["userId"] = uid
            } else {
                merged.removeValue(forKey: "userId")
            }
            try s.updateApplicationContext(merged)
            return true
        } catch {
            os_log("[wc-bridge] updateApplicationContext failed: %{public}@", log: wcLog, type: .error, "\(error)")
            var fallback = cleaned
            stampUserId(&fallback)
            if s.isReachable {
                s.sendMessage(fallback, replyHandler: nil, errorHandler: nil)
                return true
            }
            s.transferUserInfo(fallback)
            return true
        }
    }

    @discardableResult
    func sendMessage(_ dict: [String: Any]) -> Bool {
        guard WCSession.isSupported() else { return false }
        let s = WCSession.default
        guard s.activationState == .activated else { return false }
        var cleaned = Self.stripNulls(dict)
        stampUserId(&cleaned)
        if s.isReachable {
            s.sendMessage(cleaned, replyHandler: nil) { err in
                os_log("[wc-bridge] sendMessage failed: %{public}@", log: wcLog, type: .error, err.localizedDescription)
            }
            return true
        }
        s.transferUserInfo(cleaned)
        return true
    }

    // MARK: WCSessionDelegate
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        logDiag("activationDidComplete", [
            "completedState": activationState.rawValue,
            "error": error?.localizedDescription ?? "",
        ])
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
        var payload = msg
        payload.removeValue(forKey: "kind")
        payload.removeValue(forKey: "command")
        os_log("[wc-bridge] dispatching command=%{public}@ to JS", log: wcLog, type: .default, cmd)
        DispatchQueue.main.async { [weak self] in
            self?.dispatchEvent?("command", ["command": cmd, "payload": payload])
        }
    }
}
