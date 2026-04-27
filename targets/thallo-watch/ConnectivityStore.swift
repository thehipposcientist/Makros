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
    @Published var supplements: WatchSupplementsDay?
    @Published var sleep: WatchSleepSnapshot?
    @Published var readiness: WatchReadinessSnapshot?
    @Published var weight: WatchWeightSnapshot?
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
            // Pull-on-wake handshake: actively ask the phone for the
            // latest state. Without this, we're at the mercy of
            // whatever was last queued in applicationContext — which
            // may be stale by minutes or hours if the phone's state
            // has moved on since the last push. Phone responds by
            // re-pushing workout + meals + theme.
            self.sendCommand("pull_state")
        }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        DispatchQueue.main.async {
            self.isReachable = session.isReachable
            // Every time reachability becomes true (phone app opened
            // or came back into range), ask for a refresh. Cheap,
            // idempotent, closes the "wife's watch not pulling meals"
            // gap directly.
            if session.isReachable {
                self.sendCommand("pull_state")
            }
        }
    }

    /// Explicitly ask the phone to re-push all state. Called on
    /// WC activation, on reachability → true, and whenever the watch
    /// app becomes visible again (see `ThalloWatchApp` scene phase).
    func requestPull() {
        sendCommand("pull_state")
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
        if let s = ctx["supplements"] as? [String: Any] {
            if let data = try? JSONSerialization.data(withJSONObject: s),
               let decoded = try? JSONDecoder().decode(WatchSupplementsDay.self, from: data) {
                if supplements == nil || decoded.syncedAtMs >= (supplements?.syncedAtMs ?? 0) {
                    self.supplements = decoded
                }
            }
        }
        if let s = ctx["sleep"] as? [String: Any] {
            if let data = try? JSONSerialization.data(withJSONObject: s),
               let decoded = try? JSONDecoder().decode(WatchSleepSnapshot.self, from: data) {
                if sleep == nil || decoded.syncedAtMs >= (sleep?.syncedAtMs ?? 0) {
                    self.sleep = decoded
                }
            }
        }
        if let r = ctx["readiness"] as? [String: Any] {
            if let data = try? JSONSerialization.data(withJSONObject: r),
               let decoded = try? JSONDecoder().decode(WatchReadinessSnapshot.self, from: data) {
                if readiness == nil || decoded.syncedAtMs >= (readiness?.syncedAtMs ?? 0) {
                    self.readiness = decoded
                }
            }
        }
        if let w = ctx["weight"] as? [String: Any] {
            if let data = try? JSONSerialization.data(withJSONObject: w),
               let decoded = try? JSONDecoder().decode(WatchWeightSnapshot.self, from: data) {
                if weight == nil || decoded.syncedAtMs >= (weight?.syncedAtMs ?? 0) {
                    self.weight = decoded
                }
            }
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

    // ─── Local optimistic mutations ─────────────────────────────────

    /// Flip a meal's `checked` flag locally and recompute the `actual`
    /// macro totals so the UI updates the instant a tap happens. The
    /// phone is the source of truth — whatever it pushes back on the
    /// next `applicationContext` / message overwrites this. Needed
    /// because WC delivery to a backgrounded phone can take seconds
    /// and leaving the watch UI stale during that window felt broken.
    func toggleMealLocal(mealType: String) {
        guard let day = meals else { return }
        var newMeals: [WatchMealItem] = []
        var actCal = 0, actPro = 0, actCarb = 0, actFat = 0
        for m in day.meals {
            let updated: WatchMealItem
            if m.mealType == mealType {
                updated = WatchMealItem(
                    mealType: m.mealType,
                    name: m.name,
                    calories: m.calories,
                    proteinG: m.proteinG,
                    carbsG: m.carbsG,
                    fatG: m.fatG,
                    checked: !m.checked,
                )
            } else {
                updated = m
            }
            if updated.checked {
                actCal += updated.calories
                actPro += updated.proteinG
                actCarb += updated.carbsG
                actFat += updated.fatG
            }
            newMeals.append(updated)
        }
        self.meals = WatchMealsDay(
            dateISO: day.dateISO,
            targets: day.targets,
            actual: WatchMealTargets(
                calories: actCal, proteinG: actPro, carbsG: actCarb, fatG: actFat,
            ),
            score: day.score,
            meals: newMeals,
            syncedAtMs: day.syncedAtMs,
        )
    }

    // Optimistic: flip a supplement's `taken` flag locally so the
    // watch UI updates instantly on tap. Phone push overwrites with
    // authoritative state after api.logDose completes.
    func toggleSupplementLocal(id: Int) {
        guard let day = supplements else { return }
        var next: [WatchSupplementItem] = []
        for s in day.items {
            if s.id == id {
                next.append(WatchSupplementItem(
                    id: s.id, name: s.name, dose: s.dose, timing: s.timing,
                    taken: !s.taken, skipped: s.skipped && s.taken,
                ))
            } else {
                next.append(s)
            }
        }
        self.supplements = WatchSupplementsDay(
            dateISO: day.dateISO, items: next, syncedAtMs: day.syncedAtMs,
        )
    }

    /// Mark every pending supplement as taken locally. Mirrors the
    /// "Take All (N)" button on the phone.
    func takeAllSupplementsLocal() {
        guard let day = supplements else { return }
        let next = day.items.map { s in
            (s.taken || s.skipped)
              ? s
              : WatchSupplementItem(id: s.id, name: s.name, dose: s.dose, timing: s.timing, taken: true, skipped: false)
        }
        self.supplements = WatchSupplementsDay(
            dateISO: day.dateISO, items: next, syncedAtMs: day.syncedAtMs,
        )
    }

    // ─── Outgoing ───────────────────────────────────────────────────

    /// Fired when the user taps Start / Skip on the watch. Phone
    /// receives, kicks off its own workout state, then mirrors progress
    /// back via `progress` messages.
    func sendCommand(_ command: String, payload: [String: Any] = [:]) {
        // CRITICAL: only `print()` in here, never `wlog()`. `wlog()`
        // calls back into `sendCommand("watch_log", ...)` which would
        // recurse forever. The unified-log entries are still visible
        // in Console.app — just not forwarded to the phone.
        guard let session, session.activationState == .activated else {
            print("[watch] sendCommand(\(command)) FAILED — session not activated")
            lastError = "Watch session not active — open the iPhone app once to pair."
            return
        }
        var body = payload
        body["kind"] = "command"
        body["command"] = command
        body["tsMs"] = Date().timeIntervalSince1970 * 1000
        if session.isReachable {
            // Skip the chatty per-message log for forwarded `watch_log`
            // commands so the unified log doesn't double-up every line.
            if command != "watch_log" {
                print("[watch] sendCommand(\(command)) — reachable, sendMessage")
            }
            session.sendMessage(body, replyHandler: nil) { [weak self] err in
                print("[watch] sendMessage(\(command)) error: \(err.localizedDescription)")
                DispatchQueue.main.async { self?.lastError = err.localizedDescription }
            }
        } else {
            // Queue for later delivery via transferUserInfo when phone
            // isn't reachable (locked / app backgrounded).
            if command != "watch_log" {
                print("[watch] sendCommand(\(command)) — NOT reachable, queuing via transferUserInfo")
            }
            session.transferUserInfo(body)
        }
    }
}

extension Notification.Name {
    static let watchProgressUpdate = Notification.Name("watchProgressUpdate")
    static let watchWorkoutLaunch = Notification.Name("thallo.watchWorkoutLaunch")
}

/// Watch-side logger. Prints to the unified log (visible in Mac
/// Console.app) AND forwards the line to the paired iPhone via
/// WCSession, where the phone re-emits it via console.log so it
/// shows up in the same Console.app stream. Use this instead of
/// plain `print()` for
/// anything you want to inspect from a TestFlight install without
/// tethering the watch to a Mac.
func wlog(_ msg: String) {
    print(msg)
    ConnectivityStore.shared.sendCommand("watch_log", payload: ["msg": msg])
}
