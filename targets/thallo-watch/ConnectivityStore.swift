// WatchConnectivity bridge — pulls the user's current workout + theme
// from the paired phone and keeps them in sync.
//
// Message shapes the phone sends:
//   { kind: "workoutEnvelope", payload: <WatchWorkoutEnvelope JSON> }
//   { kind: "workout",         payload: <WatchWorkout JSON> } // legacy
//   { kind: "theme",    payload: <WatchPalette JSON> }
//   { kind: "hydration", payload: <WatchHydrationDay JSON> }
//   { kind: "progress", set: Int, restRemainingSec: Int?,
//                       progressRevision: Double?, sessionId: String?,
//                       heartRate: Int?, recommendation: String? }
//
// We also respond to the phone's `sendMessage` requests when the watch
// initiates a session ("start workout", "skip today") and send commands
// like `log_set` / `swap_exercise` back to the phone. Phone handles the
// network + persistence — watch is a view + input surface only.

import Foundation
import WatchConnectivity

final class ConnectivityStore: NSObject, ObservableObject, WCSessionDelegate {
    static let shared = ConnectivityStore()

    @Published var workout: WatchWorkout?
    @Published var meals: WatchMealsDay?
    @Published var hydration: WatchHydrationDay?
    @Published var supplements: WatchSupplementsDay?
    @Published var sleep: WatchSleepSnapshot?
    @Published var readiness: WatchReadinessSnapshot?
    @Published var weight: WatchWeightSnapshot?
    @Published var theme: WatchPalette = .midnight
    @Published var latestProgress: [String: Any]?
    @Published var isReachable: Bool = false
    @Published var lastError: String?
    /// AI-parsed meal items awaiting user review on the watch speech-to-meal flow.
    /// Set when the phone calls syncMealParsePreview; consumed (set nil) after the
    /// user confirms or cancels the review sheet.
    @Published var pendingMealItems: [WatchMealParseItem]?

    private let session: WCSession?
    private static let userIdKey = "thallo.watchUserId"
    private static let lastWorkoutRevisionKey = "thallo.lastWorkoutRevision"
    private static let storedThemeKey = "thallo.storedTheme"
    private static let lastThemeSyncedAtMsKey = "thallo.lastThemeSyncedAtMs"
    private static let storedSleepKey = "thallo.storedSleep"
    private static let storedHydrationKey = "thallo.storedHydration"
    private static let storedProgressKey = "thallo.latestWorkoutProgress"
    private var queuedCommands: [[String: Any]] = []

    private override init() {
        self.session = WCSession.isSupported() ? WCSession.default : nil
        super.init()
        if let storedTheme = Self.loadStored(WatchPalette.self, key: Self.storedThemeKey) {
            self.theme = storedTheme
        }
        if let storedSleep = Self.loadStored(WatchSleepSnapshot.self, key: Self.storedSleepKey) {
            self.sleep = storedSleep
        }
        if let storedHydration = Self.loadStored(WatchHydrationDay.self, key: Self.storedHydrationKey) {
            self.hydration = storedHydration
        }
        self.latestProgress = UserDefaults.standard.dictionary(forKey: Self.storedProgressKey)
        session?.delegate = self
        session?.activate()
        syncComplicationSnapshot()
    }

    private static func loadStored<T: Decodable>(_ type: T.Type, key: String) -> T? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    private static func saveStored<T: Encodable>(_ value: T, key: String) {
        if let data = try? JSONEncoder().encode(value) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    /// The stored userId for the current watch session.
    var currentUserId: String? {
        UserDefaults.standard.string(forKey: Self.userIdKey)
    }

    /// Handle userId changes. Three cases:
    ///   - nil: key wasn't in the payload → do nothing (don't wipe on normal messages)
    ///   - empty string: explicit logout → wipe + clear stored userId
    ///   - non-empty string: new or same user → wipe if different, store new
    private func handleUserSwitch(_ incomingUserId: String?) {
        guard let incoming = incomingUserId else {
            // Key not present in payload — no user signal, do nothing.
            return
        }
        let stored = UserDefaults.standard.string(forKey: Self.userIdKey)
        if incoming.isEmpty {
            // Explicit sign-out / clear.
            if stored != nil {
                print("[watch] userId cleared — wiping state")
                HeartRateStore.saveDiag("userId cleared → wiping state")
                wipeUserState()
                UserDefaults.standard.removeObject(forKey: Self.userIdKey)
            }
        } else {
            if let prev = stored, prev != incoming {
                print("[watch] userId changed \(prev) → \(incoming) — wiping state")
                HeartRateStore.saveDiag("userId changed \(prev.prefix(4))→\(incoming.prefix(4)) → wiping state")
                wipeUserState()
            } else {
                HeartRateStore.saveDiag("userId same \(incoming.prefix(4)) — no wipe")
            }
            UserDefaults.standard.set(incoming, forKey: Self.userIdKey)
        }
    }

    private func wipeUserState() {
        workout = nil
        meals = nil
        hydration = nil
        supplements = nil
        sleep = nil
        readiness = nil
        weight = nil
        pendingMealItems = nil
        latestProgress = nil
        theme = .midnight
        // Clear persisted watch state so stale flags from a previous
        // account can't auto-start HealthKit on the next app open.
        UserDefaults.standard.removeObject(forKey: "thallo.pendingWorkoutLaunch")
        UserDefaults.standard.removeObject(forKey: "thallo.lastEndedSessionId")
        UserDefaults.standard.removeObject(forKey: "thallo.activeWorkoutState")
        UserDefaults.standard.removeObject(forKey: "thallo.hrDiag")
        UserDefaults.standard.removeObject(forKey: "thallo.hrDiagList")
        UserDefaults.standard.removeObject(forKey: "thallo.lastAbsorb")
        UserDefaults.standard.removeObject(forKey: "thallo.lastClearWorkoutMs")
        UserDefaults.standard.removeObject(forKey: Self.lastWorkoutRevisionKey)
        UserDefaults.standard.removeObject(forKey: Self.storedThemeKey)
        UserDefaults.standard.removeObject(forKey: Self.lastThemeSyncedAtMsKey)
        UserDefaults.standard.removeObject(forKey: Self.storedSleepKey)
        UserDefaults.standard.removeObject(forKey: Self.storedHydrationKey)
        UserDefaults.standard.removeObject(forKey: Self.storedProgressKey)
        ThalloComplicationSync.clear()
    }

    // ─── WCSessionDelegate ──────────────────────────────────────────

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async {
            self.isReachable = session.isReachable
            if activationState == .activated {
                self.flushQueuedCommands()
            }
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
                self.absorbContext(session.receivedApplicationContext)
                self.sendCommand("pull_state")
            }
        }
    }

    /// Explicitly ask the phone to re-push all state. Called on
    /// WC activation, on reachability → true, and whenever the watch
    /// app becomes visible again (see `ThalloWatchApp` scene phase).
    func requestPull() {
        if let session = session {
            absorbContext(session.receivedApplicationContext)
        }
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

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        DispatchQueue.main.async { self.absorbMessage(userInfo) }
    }

    // ─── Message routing ────────────────────────────────────────────

    private func absorbContext(_ ctx: [String: Any]) {
        // Visibility: every absorbed context logs the top-level keys it
        // carried. Without this, a context that arrives WITHOUT a workout
        // key looks identical to one where workout decode silently
        // failed — both leave the latest diag pointing at handleUserSwitch.
        let keysSorted = ctx.keys.sorted().joined(separator: ",")
        HeartRateStore.saveDiag("absorbContext keys=[\(keysSorted)]")

        // Only process userId when the key is explicitly present in
        // the payload. Missing key = "no user signal" (e.g. a plain
        // workout/meals message that predates userId stamping).
        if ctx.keys.contains("userId") {
            let incomingUserId = ctx["userId"] as? String ?? ""
            handleUserSwitch(incomingUserId)
        }

        let contextUserId = normalizedUserId(ctx["userId"] as? String)
        let envelopeHandled = absorbWorkoutEnvelope(ctx["workoutEnvelope"], contextUserId: contextUserId)
        if !envelopeHandled {
            absorbLegacyWorkout(ctx)
        }
        if var progress = ctx["progress"] as? [String: Any] {
            if progress["userId"] == nil, let uid = ctx["userId"] {
                progress["userId"] = uid
            }
            absorbProgress(progress)
        }
        if let m = ctx["meals"] as? [String: Any] {
            if let data = try? JSONSerialization.data(withJSONObject: m),
               let decoded = try? JSONDecoder().decode(WatchMealsDay.self, from: data) {
                if meals == nil || decoded.syncedAtMs >= (meals?.syncedAtMs ?? 0) {
                    self.meals = decoded
                }
            }
        }
        if let h = ctx["hydration"] as? [String: Any] {
            if let data = try? JSONSerialization.data(withJSONObject: h),
               let decoded = try? JSONDecoder().decode(WatchHydrationDay.self, from: data) {
                if hydration == nil || decoded.syncedAtMs >= (hydration?.syncedAtMs ?? 0) {
                    self.hydration = decoded
                    Self.saveStored(decoded, key: Self.storedHydrationKey)
                }
            }
        }
        absorbTheme(ctx["theme"])
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
                    Self.saveStored(decoded, key: Self.storedSleepKey)
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
        syncComplicationSnapshot()
    }

    private func syncComplicationSnapshot() {
        ThalloComplicationSync.update(
            workout: workout,
            hydration: hydration,
            readiness: readiness,
            sleep: sleep
        )
    }

    private func absorbTheme(_ raw: Any?) {
        guard let raw = raw else { return }
        guard let dict = raw as? [String: Any] else {
            HeartRateStore.saveDiag("theme key present but not a dict")
            return
        }
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let decoded = try? JSONDecoder().decode(WatchPalette.self, from: data) else {
            HeartRateStore.saveDiag("theme decode FAIL keys=[\(dict.keys.sorted().joined(separator: ","))]")
            return
        }
        if let incomingMs = decoded.syncedAtMs {
            let lastMs = UserDefaults.standard.double(forKey: Self.lastThemeSyncedAtMsKey)
            if incomingMs < lastMs {
                HeartRateStore.saveDiag("theme stale rejected theme=\(decoded.themeName ?? "unknown")")
                return
            }
            UserDefaults.standard.set(incomingMs, forKey: Self.lastThemeSyncedAtMsKey)
        }
        self.theme = decoded
        Self.saveStored(decoded, key: Self.storedThemeKey)
        HeartRateStore.saveDiag("theme accepted theme=\(decoded.themeName ?? "unknown")")
    }

    private func absorbProgress(_ raw: [String: Any]) {
        var msg = raw
        if msg["kind"] == nil {
            msg["kind"] = "progress"
        }
        if msg.keys.contains("userId") {
            handleUserSwitch(msg["userId"] as? String)
        }
        if let incomingRevision = flexibleDouble(msg["progressRevision"]),
           let previous = latestProgress,
           let previousRevision = flexibleDouble(previous["progressRevision"]),
           incomingRevision <= previousRevision {
            HeartRateStore.saveDiag("progress cache stale rejected rev=\(Int(incomingRevision)) last=\(Int(previousRevision))")
            return
        }
        latestProgress = msg
        UserDefaults.standard.set(msg, forKey: Self.storedProgressKey)
        NotificationCenter.default.post(name: .watchProgressUpdate, object: nil, userInfo: msg)
    }

    private func absorbWorkoutEnvelope(_ raw: Any?, contextUserId: String?) -> Bool {
        guard let raw = raw else { return false }
        guard let dict = raw as? [String: Any] else {
            HeartRateStore.saveDiag("workoutEnvelope key present but not a dict")
            HeartRateStore.saveLastAbsorb("workoutEnvelope wrong type")
            return false
        }
        let keys = dict.keys.sorted().joined(separator: ",")
        let exerciseCount = ((dict["workout"] as? [String: Any])?["exercises"] as? [Any])?.count ?? -1
        guard let data = try? JSONSerialization.data(withJSONObject: dict) else {
            HeartRateStore.saveDiag("workoutEnvelope JSONser FAILED keys=[\(keys)]")
            HeartRateStore.saveLastAbsorb("envelope JSONser FAILED")
            return false
        }
        do {
            let envelope = try JSONDecoder().decode(WatchWorkoutEnvelope.self, from: data)
            guard envelope.channel == "workout" else {
                HeartRateStore.saveDiag("ignored workoutEnvelope channel=\(envelope.channel)")
                HeartRateStore.saveLastAbsorb("ignored envelope channel")
                return true
            }

            let envelopeUserId = normalizedUserId(envelope.userId) ?? contextUserId
            if let envelopeUserId = envelopeUserId {
                handleUserSwitch(envelopeUserId)
            }

            let lastRevision = UserDefaults.standard.double(forKey: Self.lastWorkoutRevisionKey)
            if envelope.revision < lastRevision {
                HeartRateStore.saveDiag("rcv workoutEnvelope stale rev=\(Int(envelope.revision)) last=\(Int(lastRevision))")
                HeartRateStore.saveLastAbsorb("stale envelope rev (rejected)")
                return true
            }

            if envelope.reason == "clear" {
                workout = nil
                UserDefaults.standard.set(envelope.revision, forKey: Self.lastWorkoutRevisionKey)
                HeartRateStore.saveDiag("rcv workoutEnvelope clear rev=\(Int(envelope.revision))")
                HeartRateStore.saveLastAbsorb("clear envelope → nil")
                return true
            }

            let stored = currentUserId ?? ""
            let workoutUserId = normalizedUserId(envelope.workout.userId) ?? envelopeUserId ?? ""
            if !stored.isEmpty && !workoutUserId.isEmpty && workoutUserId != stored {
                let msg = "rejected: userId \(workoutUserId.prefix(4))≠\(stored.prefix(4))"
                HeartRateStore.saveDiag("rejected workoutEnvelope: userId \(workoutUserId.prefix(4))≠stored \(stored.prefix(4))")
                HeartRateStore.saveLastAbsorb(msg)
                return true
            }

            self.workout = envelope.workout
            UserDefaults.standard.set(envelope.revision, forKey: Self.lastWorkoutRevisionKey)
            let msg = "accepted env \(envelope.reason ?? "unknown") status=\(envelope.workout.status) ex=\(envelope.workout.exercises.count)"
            HeartRateStore.saveDiag("rcv workoutEnvelope accepted rev=\(Int(envelope.revision)) reason=\(envelope.reason ?? "nil") status=\(envelope.workout.status) sid=\(envelope.workout.sessionId?.prefix(8) ?? "nil") ex=\(envelope.workout.exercises.count)")
            HeartRateStore.saveLastAbsorb(msg)
            return true
        } catch {
            let msg = "envelope decode FAIL keys=[\(keys)] ex=\(exerciseCount) err=\(error.localizedDescription.prefix(60))"
            HeartRateStore.saveDiag("workoutEnvelope decode FAIL keys=[\(keys)] ex=\(exerciseCount) err=\(error)")
            HeartRateStore.saveLastAbsorb(msg)
            return false
        }
    }

    private func normalizedUserId(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty
        else { return nil }
        return trimmed
    }

    private func absorbLegacyWorkout(_ ctx: [String: Any]) {
        guard let w = ctx["workout"] as? [String: Any] else {
            if ctx.keys.contains("workout") {
                HeartRateStore.saveDiag("workout key present but not a dict")
                HeartRateStore.saveLastAbsorb("workout key wrong type")
            }
            return
        }

        if let clearMs = flexibleDouble(w["clearWorkoutMs"]) {
            let lastCleared = UserDefaults.standard.double(forKey: "thallo.lastClearWorkoutMs")
            if clearMs > lastCleared {
                HeartRateStore.saveDiag("rcv clearWorkoutMs → nil workout")
                HeartRateStore.saveLastAbsorb("clearWorkoutMs → nil")
                workout = nil
                UserDefaults.standard.set(clearMs, forKey: "thallo.lastClearWorkoutMs")
            }
        }

        let wKeys = w.keys.sorted().joined(separator: ",")
        let exerciseCount = (w["exercises"] as? [Any])?.count ?? -1
        guard let data = try? JSONSerialization.data(withJSONObject: w) else {
            let msg = "JSONser FAILED keys=[\(wKeys)] ex=\(exerciseCount)"
            HeartRateStore.saveDiag("workout JSONser FAILED keys=[\(wKeys)] ex=\(exerciseCount)")
            HeartRateStore.saveLastAbsorb(msg)
            return
        }

        do {
            let decoded = try JSONDecoder().decode(WatchWorkout.self, from: data)
            let stored = currentUserId ?? ""
            let wUserId = decoded.userId ?? ""
            if !stored.isEmpty && !wUserId.isEmpty && wUserId != stored {
                let msg = "rejected: userId \(wUserId.prefix(4))≠\(stored.prefix(4))"
                HeartRateStore.saveDiag("rejected workout: userId \(wUserId.prefix(4))≠stored \(stored.prefix(4))")
                HeartRateStore.saveLastAbsorb(msg)
            } else if workout == nil || decoded.syncedAtMs >= (workout?.syncedAtMs ?? 0) {
                let msg = "accepted legacy status=\(decoded.status) ex=\(decoded.exercises.count)"
                HeartRateStore.saveDiag("rcv legacy workout accepted status=\(decoded.status) sid=\(decoded.sessionId?.prefix(8) ?? "nil") ex=\(decoded.exercises.count)")
                HeartRateStore.saveLastAbsorb(msg)
                self.workout = decoded
            } else {
                HeartRateStore.saveDiag("rcv legacy workout stale syncedAtMs")
                HeartRateStore.saveLastAbsorb("stale legacy syncedAtMs (rejected)")
            }
        } catch {
            let msg = "decode FAIL keys=[\(wKeys)] ex=\(exerciseCount) err=\(error.localizedDescription.prefix(60))"
            HeartRateStore.saveDiag("workout decode FAIL keys=[\(wKeys)] ex=\(exerciseCount) err=\(error)")
            HeartRateStore.saveLastAbsorb(msg)
        }
    }

    private func flexibleDouble(_ value: Any?) -> Double? {
        if let d = value as? Double, d.isFinite { return d }
        if let i = value as? Int { return Double(i) }
        if let n = value as? NSNumber {
            let d = n.doubleValue
            return d.isFinite ? d : nil
        }
        if let s = value as? String, let d = Double(s.trimmingCharacters(in: .whitespacesAndNewlines)), d.isFinite {
            return d
        }
        return nil
    }

    private func absorbMessage(_ msg: [String: Any]) {
        guard let kind = msg["kind"] as? String else {
            // No kind key — this is a context-style push that arrived via
            // sendMessage/transferUserInfo because updateApplicationContext
            // failed (size limit, session state, etc.). Route straight into
            // absorbContext so workout/meals/theme are processed normally.
            HeartRateStore.saveDiag("absorbMessage: no kind — routing to absorbContext (keys=\(msg.keys.sorted().joined(separator: ",")))")
            absorbContext(msg)
            return
        }
        // Forward userId from the message into the context dict so
        // absorbContext can process user switches on individual messages
        // (not just full applicationContext pushes).
        let userId = msg["userId"]
        func ctxWith(_ key: String, _ payload: Any) -> [String: Any] {
            var ctx: [String: Any] = [key: payload]
            if let uid = userId { ctx["userId"] = uid }
            return ctx
        }
        switch kind {
        case "workoutEnvelope":
            if let payload = msg["payload"] as? [String: Any] {
                absorbContext(ctxWith("workoutEnvelope", payload))
            }
        case "workout":
            if let payload = msg["payload"] as? [String: Any] {
                absorbContext(ctxWith("workout", payload))
            }
        case "meals":
            if let payload = msg["payload"] as? [String: Any] {
                absorbContext(ctxWith("meals", payload))
            }
        case "hydration":
            if let payload = msg["payload"] as? [String: Any] {
                absorbContext(ctxWith("hydration", payload))
            }
        case "theme":
            if let payload = msg["payload"] as? [String: Any] {
                absorbContext(ctxWith("theme", payload))
            }
        case "progress":
            if var payload = msg["payload"] as? [String: Any] {
                payload["kind"] = "progress"
                if payload["userId"] == nil, let uid = userId {
                    payload["userId"] = uid
                }
                absorbProgress(payload)
            } else {
                absorbProgress(msg)
            }
        case "mealParsePreview":
            // Phone pushed AI-parsed meal items after processing the watch's
            // speech transcription. Set pendingMealItems so SpeechMealView can
            // transition from the "Parsing..." spinner to the review screen.
            if let rawItems = msg["payload"] as? [[String: Any]] {
                let parsed = rawItems.compactMap { dict -> WatchMealParseItem? in
                    guard let data = try? JSONSerialization.data(withJSONObject: dict),
                          let item = try? JSONDecoder().decode(WatchMealParseItem.self, from: data)
                    else { return nil }
                    return item
                }
                if !parsed.isEmpty { self.pendingMealItems = parsed }
            }
        default:
            break
        }
    }

    // ─── Local optimistic mutations ─────────────────────────────────

    private func localDateISO(_ date: Date = Date()) -> String {
        let comps = Calendar.current.dateComponents([.year, .month, .day], from: date)
        let y = comps.year ?? 1970
        let m = comps.month ?? 1
        let d = comps.day ?? 1
        return String(format: "%04d-%02d-%02d", y, m, d)
    }

    private func updateHydrationLocal(to ounces: Double, dateISO: String? = nil) {
        let next = max(0, (ounces * 10).rounded() / 10)
        let previous = hydration
        let updated = WatchHydrationDay(
            dateISO: dateISO ?? previous?.dateISO ?? localDateISO(),
            ounces: next,
            targetOunces: previous?.targetOunces ?? 64,
            syncedAtMs: Date().timeIntervalSince1970 * 1000,
        )
        hydration = updated
        Self.saveStored(updated, key: Self.storedHydrationKey)
        syncComplicationSnapshot()
    }

    func addHydrationLocal(deltaOz: Double) {
        updateHydrationLocal(to: (hydration?.ounces ?? 0) + deltaOz)
    }

    func setHydrationLocal(ounces: Double, dateISO: String? = nil) {
        updateHydrationLocal(to: ounces, dateISO: dateISO)
    }

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
        guard let session else {
            print("[watch] sendCommand(\(command)) FAILED — WCSession unavailable")
            HeartRateStore.saveDiag("→ \(command) FAIL: unavailable")
            lastError = "Watch session unavailable."
            return
        }
        var body = payload
        body["kind"] = "command"
        body["command"] = command
        let tsMs = Date().timeIntervalSince1970 * 1000
        body["tsMs"] = tsMs
        if let userId = currentUserId, !userId.isEmpty {
            body["userId"] = userId
        }
        if command != "watch_log" {
            body["commandId"] = "\(command)-\(Int(tsMs))-\(UUID().uuidString)"
        }
        guard session.activationState == .activated else {
            if command != "watch_log" {
                print("[watch] sendCommand(\(command)) — not activated, queueing")
                HeartRateStore.saveDiag("→ \(command) queued: not activated")
            }
            queuedCommands.append(body)
            session.activate()
            return
        }
        sendCommandBody(body, command: command, session: session)
    }

    private func flushQueuedCommands() {
        guard let session, session.activationState == .activated, !queuedCommands.isEmpty else { return }
        let pending = queuedCommands
        queuedCommands.removeAll()
        for body in pending {
            let command = body["command"] as? String ?? "<unknown>"
            sendCommandBody(body, command: command, session: session)
        }
    }

    private func sendCommandBody(_ body: [String: Any], command: String, session: WCSession) {
        if session.isReachable {
            // Skip the chatty per-message log for forwarded `watch_log`
            // commands so the unified log doesn't double-up every line.
            if command != "watch_log" {
                print("[watch] sendCommand(\(command)) — reachable, sendMessage")
                HeartRateStore.saveDiag("→ \(command) reach=Y")
            }
            session.sendMessage(body, replyHandler: nil) { [weak self] err in
                print("[watch] sendMessage(\(command)) error: \(err.localizedDescription)")
                if command != "watch_log" {
                    session.transferUserInfo(body)
                    HeartRateStore.saveDiag("→ \(command) fallback transfer")
                }
                DispatchQueue.main.async {
                    self?.lastError = err.localizedDescription
                    HeartRateStore.saveDiag("→ \(command) ERR: \(err.localizedDescription.prefix(40))")
                }
            }
        } else {
            // Queue for later delivery via transferUserInfo when phone
            // isn't reachable (locked / app backgrounded).
            if command != "watch_log" {
                print("[watch] sendCommand(\(command)) — NOT reachable, queuing via transferUserInfo")
                HeartRateStore.saveDiag("→ \(command) reach=N (queued)")
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
