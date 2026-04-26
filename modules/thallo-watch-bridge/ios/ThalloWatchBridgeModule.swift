// Phone-side WatchConnectivity bridge. Mirrors the JS API in
// `modules/thallo-watch-bridge/index.ts`. All outbound writes land in
// `updateApplicationContext` so the watch picks them up on cold start
// too — not just while reachable.

import ExpoModulesCore
import WatchConnectivity

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
        // with full session state so we can debug "paired=true but
        // reachable=false / nothing arrives from watch" failures
        // straight from the in-app DevLogsViewer.
        Events("command", "reachabilityChanged", "watchSessionDiag")

        OnCreate {
            self.sessionHolder.activate { [weak self] name, body in
                self?.sendEvent(name, body)
            }
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
    }
}

// Keeps the WCSession delegate alive across hot reloads and routes
// incoming commands into the Expo event stream.
private class _SessionHolder: NSObject, WCSessionDelegate {
    private var dispatchEvent: ((String, [String: Any]) -> Void)?

    func activate(sendEvent: @escaping (String, [String: Any]) -> Void) {
        self.dispatchEvent = sendEvent
        guard WCSession.isSupported() else {
            sendEvent("watchSessionDiag", [
                "event": "activate.unsupported",
                "ts": Date().timeIntervalSince1970 * 1000,
            ])
            return
        }
        let s = WCSession.default
        s.delegate = self
        logDiag("activate.called", [
            "preState": s.activationState.rawValue,
        ])
        if s.activationState != .activated {
            s.activate()
        }
    }

    /// Emit a verbose diagnostic line. Captures full WCSession state at
    /// the moment of every delegate callback so the in-app DevLogsViewer
    /// can show the actual session lifecycle — activationState, paired,
    /// installed, reachable — without needing Mac + Console.app.
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

    @discardableResult
    func sendContext(_ dict: [String: Any]) -> Bool {
        guard WCSession.isSupported() else { return false }
        let s = WCSession.default
        guard s.activationState == .activated else { return false }
        do {
            var merged = s.applicationContext
            for (k, v) in dict { merged[k] = v }
            try s.updateApplicationContext(merged)
            return true
        } catch {
            // Fall back to message delivery if updateContext rejects
            // (duplicate payload, backoff, etc.).
            if s.isReachable {
                s.sendMessage(dict, replyHandler: nil, errorHandler: nil)
                return true
            }
            // Last resort: queue via transferUserInfo for guaranteed
            // eventual delivery when the watch app next activates.
            // Without this fallback, the push was silently lost any
            // time updateApplicationContext threw AND the watch app
            // wasn't reachable — exactly the "start workout while watch
            // is closed" case the user was hitting.
            s.transferUserInfo(dict)
            return true
        }
    }

    @discardableResult
    func sendMessage(_ dict: [String: Any]) -> Bool {
        guard WCSession.isSupported() else { return false }
        let s = WCSession.default
        guard s.activationState == .activated else { return false }
        if s.isReachable {
            s.sendMessage(dict, replyHandler: nil, errorHandler: nil)
            return true
        }
        // Queue for later — transferUserInfo is guaranteed delivery
        // to the watch once it's awake + reachable.
        s.transferUserInfo(dict)
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
        logDiag("didReceiveMessage", [
            "kind": (message["kind"] as? String) ?? "<missing>",
            "command": (message["command"] as? String) ?? "<none>",
            "keyCount": message.count,
        ])
        dispatchCommand(message)
    }
    func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        logDiag("didReceiveMessage(reply)", [
            "kind": (message["kind"] as? String) ?? "<missing>",
            "command": (message["command"] as? String) ?? "<none>",
            "keyCount": message.count,
        ])
        dispatchCommand(message)
        replyHandler(["ok": true])
    }
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        logDiag("didReceiveUserInfo", [
            "kind": (userInfo["kind"] as? String) ?? "<missing>",
            "command": (userInfo["command"] as? String) ?? "<none>",
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
              let cmd = msg["command"] as? String else { return }
        var payload = msg
        payload.removeValue(forKey: "kind")
        payload.removeValue(forKey: "command")
        dispatchEvent?("command", ["command": cmd, "payload": payload])
    }
}
