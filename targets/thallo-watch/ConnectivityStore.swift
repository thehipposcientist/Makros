// WatchConnectivity bridge — pulls the user's current workout + theme
// from the paired phone and keeps them in sync.
//
// Message shapes the phone sends:
//   { kind: "workout",  payload: <WatchWorkout JSON> }
//   { kind: "theme",    payload: <WatchPalette JSON> }
//   { kind: "progress", set: Int, restRemainingSec: Int?,
//                       heartRate: Int?, recommendation: String? }
//
// We also respond to the phone's `sendMessage` requests when the watch
// initiates a session ("start workout", "skip today"). Phone handles
// the network + persistence — watch is a view + input surface only.

import Foundation
import WatchConnectivity

final class ConnectivityStore: NSObject, ObservableObject, WCSessionDelegate {
    static let shared = ConnectivityStore()

    @Published var workout: WatchWorkout?
    @Published var meals: WatchMealsDay?
    @Published var theme: WatchPalette = .midnight
    @Published var isReachable: Bool = false
    @Published var lastError: String?

    private let session: WCSession?

    private override init() {
        self.session = WCSession.isSupported() ? WCSession.default : nil
        super.init()
        session?.delegate = self
        session?.activate()
    }

    // ─── WCSessionDelegate ──────────────────────────────────────────

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async {
            self.isReachable = session.isReachable
            // Hydrate whatever's already queued in applicationContext
            // (survives cold start on both sides).
            self.absorbContext(session.receivedApplicationContext)
        }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        DispatchQueue.main.async { self.isReachable = session.isReachable }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        DispatchQueue.main.async { self.absorbContext(applicationContext) }
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        DispatchQueue.main.async { self.absorbMessage(message) }
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        DispatchQueue.main.async { self.absorbMessage(message) }
        replyHandler(["ok": true])
    }

    // ─── Message routing ────────────────────────────────────────────

    private func absorbContext(_ ctx: [String: Any]) {
        if let w = ctx["workout"] as? [String: Any] {
            if let data = try? JSONSerialization.data(withJSONObject: w),
               let decoded = try? JSONDecoder().decode(WatchWorkout.self, from: data) {
                // Ignore out-of-order: keep the newer syncedAtMs.
                if workout == nil || decoded.syncedAtMs >= (workout?.syncedAtMs ?? 0) {
                    self.workout = decoded
                }
            }
        }
        if let m = ctx["meals"] as? [String: Any] {
            if let data = try? JSONSerialization.data(withJSONObject: m),
               let decoded = try? JSONDecoder().decode(WatchMealsDay.self, from: data) {
                if meals == nil || decoded.syncedAtMs >= (meals?.syncedAtMs ?? 0) {
                    self.meals = decoded
                }
            }
        }
        if let t = ctx["theme"] as? [String: Any],
           let data = try? JSONSerialization.data(withJSONObject: t),
           let decoded = try? JSONDecoder().decode(WatchPalette.self, from: data) {
            self.theme = decoded
        }
    }

    private func absorbMessage(_ msg: [String: Any]) {
        guard let kind = msg["kind"] as? String else { return }
        switch kind {
        case "workout":
            if let payload = msg["payload"] as? [String: Any] {
                absorbContext(["workout": payload])
            }
        case "meals":
            if let payload = msg["payload"] as? [String: Any] {
                absorbContext(["meals": payload])
            }
        case "theme":
            if let payload = msg["payload"] as? [String: Any] {
                absorbContext(["theme": payload])
            }
        case "progress":
            // Live updates (current set, rest remaining, HR) handled by
            // ActiveWorkoutStore — nothing to persist on ConnectivityStore.
            NotificationCenter.default.post(name: .watchProgressUpdate, object: nil, userInfo: msg)
        default:
            break
        }
    }

    // ─── Outgoing ───────────────────────────────────────────────────

    /// Fired when the user taps Start / Skip on the watch. Phone
    /// receives, kicks off its own workout state, then mirrors progress
    /// back via `progress` messages.
    func sendCommand(_ command: String, payload: [String: Any] = [:]) {
        guard let session, session.activationState == .activated else {
            lastError = "Watch session not active — open the iPhone app once to pair."
            return
        }
        var body = payload
        body["kind"] = "command"
        body["command"] = command
        body["tsMs"] = Date().timeIntervalSince1970 * 1000
        if session.isReachable {
            session.sendMessage(body, replyHandler: nil) { [weak self] err in
                DispatchQueue.main.async { self?.lastError = err.localizedDescription }
            }
        } else {
            // Queue for later delivery via transferUserInfo when phone
            // isn't reachable (locked / app backgrounded).
            session.transferUserInfo(body)
        }
    }
}

extension Notification.Name {
    static let watchProgressUpdate = Notification.Name("watchProgressUpdate")
}
