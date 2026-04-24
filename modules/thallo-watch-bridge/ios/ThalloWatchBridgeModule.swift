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
        // change on the phone.
        Events("command", "reachabilityChanged")

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
        guard WCSession.isSupported() else { return }
        let s = WCSession.default
        s.delegate = self
        if s.activationState != .activated {
            s.activate()
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
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) {
        // Rare — iOS calls this after a watch swap. Reactivate.
        WCSession.default.activate()
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        dispatchCommand(message)
    }
    func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        dispatchCommand(message)
        replyHandler(["ok": true])
    }
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        dispatchCommand(userInfo)
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
