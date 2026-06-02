// WatchConnectivity bridge — pulls the user's current workout + theme
// from the paired phone and keeps them in sync.
//
// Message shapes the phone sends:
//   { kind: "workoutEnvelope", payload: <WatchWorkoutEnvelope JSON> }
//   { kind: "workout",         payload: <WatchWorkout JSON> } // legacy
//   { kind: "theme",    payload: <WatchPalette JSON> }
//   { kind: "hydration", payload: <WatchHydrationDay JSON> }
//   { kind: "activity", payload: <WatchActivityDay JSON> }
//   { kind: "lifestyle", payload: <WatchLifestyleDay JSON> }
//   { kind: "supplements", payload: <WatchSupplementsDay JSON> }
//   { kind: "sleep", payload: <WatchSleepSnapshot JSON> }
//   { kind: "readiness", payload: <WatchReadinessSnapshot JSON> }
//   { kind: "weight", payload: <WatchWeightSnapshot JSON> }
//   { kind: "mealParsePreview", payload: [<WatchMealParseItem JSON>],
//     error?: String }
//   { kind: "progress", set: Int, restRemainingSec: Int?,
//                       progressRevision: Double?, sessionId: String?,
//                       heartRate: Int?, recommendation: String?,
//                       completedExerciseIndexes: [Int]?,
//                       exerciseCompletion: [[String: Any]]? }
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
    @Published var activity: WatchActivityDay?
    @Published var lifestyle: WatchLifestyleDay?
    @Published var supplements: WatchSupplementsDay?
    @Published var sleep: WatchSleepSnapshot?
    @Published var readiness: WatchReadinessSnapshot?
    @Published var weight: WatchWeightSnapshot?
    /// User's saved workout templates synced from the phone. Populated
    /// after the first phone push; nil until then. Drives the watch's
    /// Strength picker so users can start a saved workout from the
    /// wrist without opening the phone.
    @Published var templates: WatchTemplatesDay?
    @Published var theme: WatchPalette = .aurora
    @Published var latestProgress: [String: Any]?
    @Published var isReachable: Bool = false
    @Published var lastError: String?
    /// AI-parsed meal items awaiting user review on the watch speech-to-meal flow.
    /// Set when the phone calls syncMealParsePreview; consumed (set nil) after the
    /// user confirms or cancels the review sheet.
    @Published var pendingMealItems: [WatchMealParseItem]?
    @Published var pendingMealParseError: String?
    @Published var isSyncingWithPhone: Bool = false
    @Published var isStartupLoading: Bool = true

    private let session: WCSession?
    private static let userIdKey = "thallo.watchUserId"
    private static let lastWorkoutRevisionKey = "thallo.lastWorkoutRevision"
    private static let storedThemeKey = "thallo.storedTheme"
    private static let lastThemeSyncedAtMsKey = "thallo.lastThemeSyncedAtMs"
    private static let storedSleepKey = "thallo.storedSleep"
    private static let storedHydrationKey = "thallo.storedHydration"
    private static let storedActivityKey = "thallo.storedActivity"
    private static let storedProgressKey = "thallo.latestWorkoutProgress"
    // 2026 offline-pass additions. Every channel the watch UI reads
    // gets its own UserDefaults key so the app can render last-known
    // state on cold launch — without it the watch sat blank whenever
    // the phone app wasn't already running.
    private static let storedMealsKey = "thallo.storedMeals"
    private static let storedLifestyleKey = "thallo.storedLifestyle"
    private static let storedSupplementsKey = "thallo.storedSupplements"
    private static let storedReadinessKey = "thallo.storedReadiness"
    private static let storedWeightKey = "thallo.storedWeight"
    private static let storedTemplatesKey = "thallo.storedTemplates"
    private static let storedWorkoutKey = "thallo.storedWorkout"
    // Outgoing commands (log_hydration, log_set, etc.) buffered when
    // WCSession isn't yet activated. Persisted across launches so an
    // `+8oz` tap that happened just before the user killed the app
    // still reaches the phone on next session activation.
    private static let storedQueuedCommandsKey = "thallo.queuedCommands"
    private let pullRequestCooldownSeconds: TimeInterval = 5
    private let phoneSyncTimeoutSeconds: TimeInterval = 6
    private let startupLoadingTimeoutSeconds: TimeInterval = 6
    private let directReadinessRefreshCooldownSeconds: TimeInterval = 60
    private let directReadinessRefreshStaleSeconds: TimeInterval = 10 * 60
    private var queuedCommands: [[String: Any]] = []
    private var lastPullRequestAt: Date = .distantPast
    private var lastDirectReadinessRefreshAt: Date = .distantPast
    private var directReadinessRefreshInFlight: Bool = false
    private var wakePullRetryItems: [DispatchWorkItem] = []
    private var phoneSyncTimeoutItem: DispatchWorkItem?
    private var startupLoadingTimeoutItem: DispatchWorkItem?

    private override init() {
        self.session = WCSession.isSupported() ? WCSession.default : nil
        super.init()
        // Cold-launch hydration of last-known state. Previously this
        // block DELETED storedSleep/Hydration/Progress on every launch
        // — which is what made the watch render blank when the phone
        // app wasn't running. The reverse is correct: load whatever
        // we last saw from the phone, and let the next push (when /
        // if it arrives) supersede via the `syncedAtMs` checks in
        // absorbContext.
        if let storedTheme = Self.loadStored(WatchPalette.self, key: Self.storedThemeKey) {
            self.theme = storedTheme
        }
        self.hydration = Self.loadStored(WatchHydrationDay.self, key: Self.storedHydrationKey)
        self.activity = Self.loadStored(WatchActivityDay.self, key: Self.storedActivityKey)
        self.lifestyle = Self.loadStored(WatchLifestyleDay.self, key: Self.storedLifestyleKey)
        self.sleep = Self.loadStored(WatchSleepSnapshot.self, key: Self.storedSleepKey)
        self.meals = Self.loadStored(WatchMealsDay.self, key: Self.storedMealsKey)
        self.supplements = Self.loadStored(WatchSupplementsDay.self, key: Self.storedSupplementsKey)
        self.readiness = Self.loadStored(WatchReadinessSnapshot.self, key: Self.storedReadinessKey)
        self.weight = Self.loadStored(WatchWeightSnapshot.self, key: Self.storedWeightKey)
        self.templates = Self.loadStored(WatchTemplatesDay.self, key: Self.storedTemplatesKey)
        self.workout = Self.loadStored(WatchWorkout.self, key: Self.storedWorkoutKey)
        // latestProgress is [String: Any] (heart rate, set index, etc.)
        // — store as raw JSON since it isn't Codable.
        if let data = UserDefaults.standard.data(forKey: Self.storedProgressKey),
           let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            self.latestProgress = dict
        }
        // Restore any commands that were queued when the user last
        // backgrounded / killed the app. flushQueuedCommands() drains
        // them in session(activationDidCompleteWith:).
        if let data = UserDefaults.standard.data(forKey: Self.storedQueuedCommandsKey),
           let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
            self.queuedCommands = arr
        }
        self.isStartupLoading = shouldStayInStartupLoading
        if isStartupLoading {
            scheduleStartupLoadingTimeout()
        }
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

    /// Encode an optional value, deleting the key when nil so a wipe-
    /// to-nil assignment doesn't leave stale data behind.
    private static func persistOptional<T: Encodable>(_ value: T?, key: String) {
        if let value {
            saveStored(value, key: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    /// `latestProgress` is `[String: Any]?` (live HR, current set,
    /// rest seconds) — not Codable. Use JSONSerialization for it.
    private static func persistProgress(_ progress: [String: Any]?) {
        guard let progress, JSONSerialization.isValidJSONObject(progress) else {
            UserDefaults.standard.removeObject(forKey: storedProgressKey)
            return
        }
        if let data = try? JSONSerialization.data(withJSONObject: progress) {
            UserDefaults.standard.set(data, forKey: storedProgressKey)
        }
    }

    private static func isLoadingWorkoutPlaceholder(_ workout: WatchWorkout?) -> Bool {
        guard let workout else { return false }
        let focus = workout.focus.trimmingCharacters(in: .whitespacesAndNewlines)
        return workout.status == .scheduled
            && workout.exercises.isEmpty
            && workout.durationMinutes == 0
            && (focus == "Loading…" || focus == "Loading..." || focus == "Loading")
    }

    private static func hasUsableStartupSnapshot(
        workout: WatchWorkout?,
        meals: WatchMealsDay?,
        hydration: WatchHydrationDay?,
        activity: WatchActivityDay?,
        lifestyle: WatchLifestyleDay?,
        supplements: WatchSupplementsDay?,
        sleep: WatchSleepSnapshot?,
        readiness: WatchReadinessSnapshot?,
        weight: WatchWeightSnapshot?,
        templates: WatchTemplatesDay?
    ) -> Bool {
        if let workout, !isLoadingWorkoutPlaceholder(workout) {
            return true
        }
        return meals != nil
            || hydration != nil
            || activity != nil
            || lifestyle != nil
            || supplements != nil
            || sleep != nil
            || readiness != nil
            || weight != nil
            || templates != nil
    }

    private var hasUsableStartupSnapshot: Bool {
        Self.hasUsableStartupSnapshot(
            workout: workout,
            meals: meals,
            hydration: hydration,
            activity: activity,
            lifestyle: lifestyle,
            supplements: supplements,
            sleep: sleep,
            readiness: readiness,
            weight: weight,
            templates: templates
        )
    }

    private var shouldStayInStartupLoading: Bool {
        !hasUsableStartupSnapshot || Self.isLoadingWorkoutPlaceholder(workout)
    }

    private func scheduleStartupLoadingTimeout() {
        startupLoadingTimeoutItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            self?.completeStartupLoading("timeout")
        }
        startupLoadingTimeoutItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + startupLoadingTimeoutSeconds, execute: item)
    }

    private func completeStartupLoading(_ reason: String) {
        guard isStartupLoading else { return }
        startupLoadingTimeoutItem?.cancel()
        startupLoadingTimeoutItem = nil
        isStartupLoading = false
        HeartRateStore.saveDiag("startup loading done: \(reason)")
    }

    private func completeStartupLoadingIfReady(_ reason: String) {
        guard isStartupLoading, !shouldStayInStartupLoading else { return }
        completeStartupLoading(reason)
    }

    private func beginPhoneSync() {
        phoneSyncTimeoutItem?.cancel()
        isSyncingWithPhone = true
        let item = DispatchWorkItem { [weak self] in
            self?.isSyncingWithPhone = false
            self?.phoneSyncTimeoutItem = nil
        }
        phoneSyncTimeoutItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + phoneSyncTimeoutSeconds, execute: item)
    }

    private func finishPhoneSync() {
        phoneSyncTimeoutItem?.cancel()
        phoneSyncTimeoutItem = nil
        isSyncingWithPhone = false
    }

    private var readinessAgeSeconds: TimeInterval? {
        guard let syncedAtMs = readiness?.syncedAtMs, syncedAtMs > 0 else { return nil }
        return max(0, Date().timeIntervalSince1970 - (syncedAtMs / 1000))
    }

    private func refreshReadinessDirectIfNeeded(reason: String) {
        guard WatchCellularClient.shared.hasUsableConfig else { return }
        if directReadinessRefreshInFlight {
            HeartRateStore.saveDiag("readiness direct skipped: in flight")
            return
        }
        if let age = readinessAgeSeconds, age < directReadinessRefreshStaleSeconds {
            HeartRateStore.saveDiag("readiness direct skipped: fresh")
            return
        }
        let now = Date()
        if now.timeIntervalSince(lastDirectReadinessRefreshAt) < directReadinessRefreshCooldownSeconds {
            HeartRateStore.saveDiag("readiness direct skipped: cooldown")
            return
        }
        directReadinessRefreshInFlight = true
        lastDirectReadinessRefreshAt = now
        HeartRateStore.saveDiag("readiness direct start: \(reason)")
        WatchCellularClient.shared.fetchReadiness { [weak self] snapshot in
            DispatchQueue.main.async {
                guard let self else { return }
                self.directReadinessRefreshInFlight = false
                if let snapshot {
                    _ = self.absorbReadinessSnapshot(snapshot, source: "direct")
                    self.finishPhoneSync()
                    self.completeStartupLoadingIfReady("readiness direct")
                    HeartRateStore.saveDiag("readiness direct ok")
                } else {
                    self.finishPhoneSync()
                    HeartRateStore.saveDiag("readiness direct failed")
                }
            }
        }
    }

    /// Persist the in-flight outgoing-command queue so taps that
    /// happened while WC wasn't yet activated survive an app kill.
    private func persistQueuedCommands() {
        if queuedCommands.isEmpty {
            UserDefaults.standard.removeObject(forKey: Self.storedQueuedCommandsKey)
            return
        }
        // Every command is already [String: Any] composed of JSON-safe
        // scalars (set in `sendCommand`), so JSONSerialization works.
        guard JSONSerialization.isValidJSONObject(queuedCommands) else { return }
        if let data = try? JSONSerialization.data(withJSONObject: queuedCommands) {
            UserDefaults.standard.set(data, forKey: Self.storedQueuedCommandsKey)
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
        activity = nil
        lifestyle = nil
        supplements = nil
        sleep = nil
        readiness = nil
        weight = nil
        pendingMealItems = nil
        latestProgress = nil
        theme = .aurora
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
        UserDefaults.standard.removeObject(forKey: Self.storedActivityKey)
        UserDefaults.standard.removeObject(forKey: Self.storedProgressKey)
        UserDefaults.standard.removeObject(forKey: Self.storedMealsKey)
        UserDefaults.standard.removeObject(forKey: Self.storedLifestyleKey)
        UserDefaults.standard.removeObject(forKey: Self.storedSupplementsKey)
        UserDefaults.standard.removeObject(forKey: Self.storedReadinessKey)
        UserDefaults.standard.removeObject(forKey: Self.storedWeightKey)
        UserDefaults.standard.removeObject(forKey: Self.storedTemplatesKey)
        UserDefaults.standard.removeObject(forKey: Self.storedWorkoutKey)
        UserDefaults.standard.removeObject(forKey: Self.storedQueuedCommandsKey)
        queuedCommands.removeAll()
        WatchCellularClient.shared.clear()
        ThalloComplicationSync.clear()
    }

    // ─── WCSessionDelegate ──────────────────────────────────────────

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async {
            self.isReachable = session.isReachable
            if activationState == .activated {
                self.flushQueuedCommands()
            }
            // Pull-on-wake handshake: hydrate queued applicationContext,
            // then actively ask the phone for the
            // latest state. Without this, we're at the mercy of
            // whatever was last queued in applicationContext — which
            // may be stale by minutes or hours if the phone's state
            // has moved on since the last push. Phone responds by
            // re-pushing workout + meals + theme.
            self.requestPullOnWake()
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
                self.requestPullOnWake()
            }
        }
    }

    /// Opening the watch app can report `.active` a beat before
    /// WCSession flips to reachable. Retry a couple of times so a
    /// normal app open behaves like tapping the refresh strip.
    ///
    /// Wake pulls are FORCEFUL. A wake event is an explicit user/system
    /// action ("user opened the watch app") that must always result in
    /// a fresh push from the phone. The 5s `pullRequestCooldownSeconds`
    /// in `requestPull()` plus the 3s bridge cooldown plus the 5s
    /// HomeScreen claim cooldown previously combined to silently drop
    /// any wake that landed within 5s of a prior pull — which is the
    /// "Phone live but data not up to date" symptom (lock the watch,
    /// unlock 2s later, no refresh, but reachability is still true so
    /// the strip says Phone live).
    func requestPullOnWake() {
        cancelWakePullRetries()
        if requestPull(force: true) { return }
        for delay in [1.0, 3.0] {
            let item = DispatchWorkItem { [weak self] in
                self?.requestPull(force: true)
            }
            wakePullRetryItems.append(item)
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
        }
    }

    private func cancelWakePullRetries() {
        for item in wakePullRetryItems { item.cancel() }
        wakePullRetryItems.removeAll()
    }

    /// Explicitly ask the phone to re-push all state. Called on
    /// WC activation, on reachability → true, and whenever the watch
    /// app becomes visible again (see `ThalloWatchApp` scene phase).
    @discardableResult
    func requestPull(force: Bool = false) -> Bool {
        guard let session else {
            refreshReadinessDirectIfNeeded(reason: "wc_unavailable")
            finishPhoneSync()
            completeStartupLoading("unavailable")
            HeartRateStore.saveDiag("pull_state skipped: unavailable")
            return false
        }
        absorbContext(session.receivedApplicationContext, completesPhoneSync: false)
        let now = Date()
        if !force && now.timeIntervalSince(lastPullRequestAt) < pullRequestCooldownSeconds {
            HeartRateStore.saveDiag("pull_state skipped: cooldown")
            return false
        }
        lastPullRequestAt = now
        let payload: [String: Any] = force ? ["force": true] : [:]
        cancelWakePullRetries()
        beginPhoneSync()
        refreshReadinessDirectIfNeeded(reason: session.isReachable ? "pull_reachable" : "phone_unreachable")
        if !session.isReachable {
            if force {
                sendCommand("pull_state", payload: payload)
                HeartRateStore.saveDiag("pull_state queued: phone not reachable")
                return true
            }
            finishPhoneSync()
            HeartRateStore.saveDiag("pull_state skipped: phone not reachable")
            return false
        }
        sendCommand("pull_state", payload: payload)
        return true
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

    private func absorbContext(_ ctx: [String: Any], completesPhoneSync: Bool = true) {
        if completesPhoneSync {
            finishPhoneSync()
        }
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
        // Workout decoders run their own per-payload user check (and need
        // to honor explicit clear payloads), so they always run.
        let envelopeHandled = absorbWorkoutEnvelope(ctx["workoutEnvelope"], contextUserId: contextUserId)
        if !envelopeHandled {
            absorbLegacyWorkout(ctx)
        }
        // Everything below this line is user-scoped data. If we have a
        // stored user and the incoming context does not name them, drop
        // the rest — a stale or unstamped push must not overwrite the
        // current user's meals/hydration/supplements/etc. Theme survives
        // because clearWatchData pushes a default palette that we WANT
        // to land regardless of stamping.
        let userScopedAllowed = isUserScopedDataAllowed(contextUserId: contextUserId)
        if !userScopedAllowed {
            HeartRateStore.saveDiag("ctx user-scoped channels rejected stored=\(currentUserId?.prefix(4) ?? "nil") incoming=\(contextUserId?.prefix(4) ?? "nil")")
        }
        if let c = ctx["cellular"] as? [String: Any] {
            if (c["clear"] as? Bool) == true || userScopedAllowed {
                WatchCellularClient.shared.configure(from: c)
                HeartRateStore.saveDiag("cellular auth \(c["clear"] as? Bool == true ? "cleared" : "configured")")
            }
        }
        if var progress = ctx["progress"] as? [String: Any], userScopedAllowed {
            if progress["userId"] == nil, let uid = ctx["userId"] {
                progress["userId"] = uid
            }
            absorbProgress(progress)
        }
        if let m = ctx["meals"] as? [String: Any], userScopedAllowed {
            if let data = try? JSONSerialization.data(withJSONObject: m),
               let decoded = try? JSONDecoder().decode(WatchMealsDay.self, from: data) {
                if meals == nil || decoded.syncedAtMs >= (meals?.syncedAtMs ?? 0) {
                    self.meals = decoded
                    Self.persistOptional(decoded, key: Self.storedMealsKey)
                }
            }
        }
        if let h = ctx["hydration"] as? [String: Any], userScopedAllowed {
            if let data = try? JSONSerialization.data(withJSONObject: h),
                let decoded = try? JSONDecoder().decode(WatchHydrationDay.self, from: data) {
                if hydration == nil || decoded.syncedAtMs >= (hydration?.syncedAtMs ?? 0) {
                    self.hydration = decoded
                    Self.persistOptional(decoded, key: Self.storedHydrationKey)
                }
            }
        }
        if let a = ctx["activity"] as? [String: Any], userScopedAllowed {
            if let data = try? JSONSerialization.data(withJSONObject: a),
               let decoded = try? JSONDecoder().decode(WatchActivityDay.self, from: data) {
                if activity == nil || decoded.syncedAtMs >= (activity?.syncedAtMs ?? 0) {
                    self.activity = decoded
                    Self.persistOptional(decoded, key: Self.storedActivityKey)
                }
            }
        }
        if let l = ctx["lifestyle"] as? [String: Any], userScopedAllowed {
            if let data = try? JSONSerialization.data(withJSONObject: l),
               let decoded = try? JSONDecoder().decode(WatchLifestyleDay.self, from: data) {
                if lifestyle == nil || decoded.syncedAtMs >= (lifestyle?.syncedAtMs ?? 0) {
                    self.lifestyle = decoded
                    Self.persistOptional(decoded, key: Self.storedLifestyleKey)
                }
            }
        }
        absorbTheme(ctx["theme"])
        if let s = ctx["supplements"] as? [String: Any], userScopedAllowed {
            if let data = try? JSONSerialization.data(withJSONObject: s),
               let decoded = try? JSONDecoder().decode(WatchSupplementsDay.self, from: data) {
                if supplements == nil || decoded.syncedAtMs >= (supplements?.syncedAtMs ?? 0) {
                    self.supplements = decoded
                    Self.persistOptional(decoded, key: Self.storedSupplementsKey)
                }
            }
        }
        if let s = ctx["sleep"] as? [String: Any], userScopedAllowed {
            if let data = try? JSONSerialization.data(withJSONObject: s),
               let decoded = try? JSONDecoder().decode(WatchSleepSnapshot.self, from: data) {
                if sleep == nil || decoded.syncedAtMs >= (sleep?.syncedAtMs ?? 0) {
                    self.sleep = decoded
                    Self.persistOptional(decoded, key: Self.storedSleepKey)
                }
            }
        }
        if let r = ctx["readiness"] as? [String: Any], userScopedAllowed {
            if let data = try? JSONSerialization.data(withJSONObject: r),
               let decoded = try? JSONDecoder().decode(WatchReadinessSnapshot.self, from: data) {
                _ = absorbReadinessSnapshot(decoded, source: "phone")
            }
        }
        if let w = ctx["weight"] as? [String: Any], userScopedAllowed {
            if let data = try? JSONSerialization.data(withJSONObject: w),
               let decoded = try? JSONDecoder().decode(WatchWeightSnapshot.self, from: data) {
                if weight == nil || decoded.syncedAtMs >= (weight?.syncedAtMs ?? 0) {
                    self.weight = decoded
                    Self.persistOptional(decoded, key: Self.storedWeightKey)
                }
            }
        }
        if let t = ctx["templates"] as? [String: Any], userScopedAllowed {
            if let data = try? JSONSerialization.data(withJSONObject: t),
               let decoded = try? JSONDecoder().decode(WatchTemplatesDay.self, from: data) {
                if templates == nil || decoded.syncedAtMs >= (templates?.syncedAtMs ?? 0) {
                    self.templates = decoded
                    Self.persistOptional(decoded, key: Self.storedTemplatesKey)
                }
            }
        }
        syncComplicationSnapshot()
        if ctx.keys.contains("userId"), normalizedUserId(ctx["userId"] as? String) == nil {
            completeStartupLoading("signed out")
        } else {
            completeStartupLoadingIfReady("snapshot")
        }
    }

    /// True if the incoming context carries a userId that matches the
    /// current watch user — or if no user is stored yet (first launch /
    /// post-wipe). Returns false when the watch knows who the user is
    /// but the push doesn't name anyone, since that's the shape of a
    /// stale or cross-account leak that the guard exists to block.
    private func isUserScopedDataAllowed(contextUserId: String?) -> Bool {
        let stored = currentUserId ?? ""
        if stored.isEmpty { return true }
        guard let incoming = contextUserId else { return false }
        return incoming == stored
    }

    private func syncComplicationSnapshot() {
        ThalloComplicationSync.update(
            workout: workout,
            hydration: hydration,
            activity: activity,
            readiness: readiness,
            sleep: sleep
        )
    }

    @discardableResult
    private func absorbReadinessSnapshot(_ decoded: WatchReadinessSnapshot, source: String) -> Bool {
        guard readiness == nil || decoded.syncedAtMs >= (readiness?.syncedAtMs ?? 0) else {
            HeartRateStore.saveDiag("readiness \(source) ignored: stale")
            return false
        }
        readiness = decoded
        Self.persistOptional(decoded, key: Self.storedReadinessKey)
        syncComplicationSnapshot()
        HeartRateStore.saveDiag("readiness \(source) accepted")
        return true
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
        // Progress messages carry live workout state (current set, rest
        // timer, heart rate). They are user-private and must not land
        // when the watch knows who the user is but the push doesn't
        // name them — same threat model as the meals/hydration guard.
        let stored = currentUserId ?? ""
        if !stored.isEmpty {
            let incoming = normalizedUserId(msg["userId"] as? String)
            if incoming == nil || incoming != stored {
                HeartRateStore.saveDiag("progress rejected stored=\(stored.prefix(4)) incoming=\(incoming?.prefix(4) ?? "nil")")
                return
            }
        }
        if let incomingRevision = flexibleDouble(msg["progressRevision"]),
           let previous = latestProgress,
           let previousRevision = flexibleDouble(previous["progressRevision"]),
           incomingRevision <= previousRevision {
            HeartRateStore.saveDiag("progress cache stale rejected rev=\(Int(incomingRevision)) last=\(Int(previousRevision))")
            return
        }
        latestProgress = msg
        Self.persistProgress(msg)
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
                Self.persistOptional(nil as WatchWorkout?, key: Self.storedWorkoutKey)
                UserDefaults.standard.set(envelope.revision, forKey: Self.lastWorkoutRevisionKey)
                HeartRateStore.saveDiag("rcv workoutEnvelope clear rev=\(Int(envelope.revision))")
                HeartRateStore.saveLastAbsorb("clear envelope → nil")
                return true
            }

            let stored = currentUserId ?? ""
            let workoutUserId = normalizedUserId(envelope.workout.userId) ?? envelopeUserId ?? ""
            // Reject if the watch knows its user but the envelope is
            // either unstamped or names someone else. Clear envelopes
            // (reason="clear") already returned above and bypass this
            // — a sign-out wipe must always land.
            if !stored.isEmpty && (workoutUserId.isEmpty || workoutUserId != stored) {
                let msg = "rejected: userId \(workoutUserId.isEmpty ? "nil" : String(workoutUserId.prefix(4)))≠\(stored.prefix(4))"
                HeartRateStore.saveDiag("rejected workoutEnvelope: userId \(workoutUserId.isEmpty ? "nil" : String(workoutUserId.prefix(4)))≠stored \(stored.prefix(4))")
                HeartRateStore.saveLastAbsorb(msg)
                return true
            }

            self.workout = envelope.workout
            Self.persistOptional(envelope.workout, key: Self.storedWorkoutKey)
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
                Self.persistOptional(nil as WatchWorkout?, key: Self.storedWorkoutKey)
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
            // Tightened: reject when stored userId is set and the legacy
            // workout payload either omits userId or names a different
            // user. The clearWorkoutMs path above already wiped + returned
            // for explicit clears, so this can't block sign-out.
            if !stored.isEmpty && (wUserId.isEmpty || wUserId != stored) {
                let msg = "rejected: userId \(wUserId.isEmpty ? "nil" : String(wUserId.prefix(4)))≠\(stored.prefix(4))"
                HeartRateStore.saveDiag("rejected workout: userId \(wUserId.isEmpty ? "nil" : String(wUserId.prefix(4)))≠stored \(stored.prefix(4))")
                HeartRateStore.saveLastAbsorb(msg)
            } else if workout == nil || decoded.syncedAtMs >= (workout?.syncedAtMs ?? 0) {
                let msg = "accepted legacy status=\(decoded.status) ex=\(decoded.exercises.count)"
                HeartRateStore.saveDiag("rcv legacy workout accepted status=\(decoded.status) sid=\(decoded.sessionId?.prefix(8) ?? "nil") ex=\(decoded.exercises.count)")
                HeartRateStore.saveLastAbsorb(msg)
                self.workout = decoded
                Self.persistOptional(decoded, key: Self.storedWorkoutKey)
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
        finishPhoneSync()
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
        case "lifestyle":
            if let payload = msg["payload"] as? [String: Any] {
                absorbContext(ctxWith("lifestyle", payload))
            }
        case "supplements":
            if let payload = msg["payload"] as? [String: Any] {
                absorbContext(ctxWith("supplements", payload))
            }
        case "sleep":
            if let payload = msg["payload"] as? [String: Any] {
                absorbContext(ctxWith("sleep", payload))
            }
        case "readiness":
            if let payload = msg["payload"] as? [String: Any] {
                absorbContext(ctxWith("readiness", payload))
            }
        case "weight":
            if let payload = msg["payload"] as? [String: Any] {
                absorbContext(ctxWith("weight", payload))
            }
        case "activity":
            if let payload = msg["payload"] as? [String: Any] {
                absorbContext(ctxWith("activity", payload))
            }
        case "templates":
            if let payload = msg["payload"] as? [String: Any] {
                absorbContext(ctxWith("templates", payload))
            }
        case "theme":
            if let payload = msg["payload"] as? [String: Any] {
                absorbContext(ctxWith("theme", payload))
            }
        case "cellular":
            if let payload = msg["payload"] as? [String: Any] {
                absorbContext(ctxWith("cellular", payload))
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
            if let error = msg["error"] as? String, !error.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                self.pendingMealParseError = error
                self.pendingMealItems = nil
                return
            }
            if let rawItems = msg["payload"] as? [[String: Any]] {
                let parsed = rawItems.compactMap { dict -> WatchMealParseItem? in
                    guard let data = try? JSONSerialization.data(withJSONObject: dict),
                          let item = try? JSONDecoder().decode(WatchMealParseItem.self, from: data)
                    else { return nil }
                    return item
                }
                if !parsed.isEmpty {
                    self.pendingMealParseError = nil
                    self.pendingMealItems = parsed
                }
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
            targetOuncesMin: previous?.targetOuncesMin,
            targetOuncesMax: previous?.targetOuncesMax,
            syncedAtMs: Date().timeIntervalSince1970 * 1000,
        )
        hydration = updated
        // Persist immediately so an `+8oz` tap survives an app kill
        // even before the phone has confirmed the backend write.
        Self.persistOptional(updated, key: Self.storedHydrationKey)
        syncComplicationSnapshot()
    }

    func addHydrationLocal(deltaOz: Double) {
        updateHydrationLocal(to: (hydration?.ounces ?? 0) + deltaOz)
    }

    func setHydrationLocal(ounces: Double, dateISO: String? = nil) {
        updateHydrationLocal(to: ounces, dateISO: dateISO)
    }

    func mergeLifestyleLocal(_ payload: [String: Any]) {
        let previous = lifestyle
        func cleanString(_ key: String, _ existing: String?) -> String? {
            guard payload.keys.contains(key) else { return existing }
            guard let raw = payload[key] else { return nil }
            let value = String(describing: raw).trimmingCharacters(in: .whitespacesAndNewlines)
            return value.isEmpty ? nil : value
        }
        func cleanDouble(_ key: String, _ existing: Double?) -> Double? {
            guard payload.keys.contains(key) else { return existing }
            if let d = payload[key] as? Double, d.isFinite { return d }
            if let i = payload[key] as? Int { return Double(i) }
            if let s = payload[key] as? String, let d = Double(s), d.isFinite { return d }
            return nil
        }
        func cleanInt(_ key: String, _ existing: Int?) -> Int? {
            guard payload.keys.contains(key) else { return existing }
            if let i = payload[key] as? Int { return i }
            if let d = payload[key] as? Double, d.isFinite { return Int(d.rounded()) }
            if let s = payload[key] as? String, let i = Int(s) { return i }
            return nil
        }
        func cleanBool(_ key: String, _ existing: Bool?) -> Bool? {
            guard payload.keys.contains(key) else { return existing }
            if let b = payload[key] as? Bool { return b }
            if let i = payload[key] as? Int { return i != 0 }
            if let s = payload[key] as? String {
                let value = s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                if ["true", "yes", "1"].contains(value) { return true }
                if ["false", "no", "0"].contains(value) { return false }
            }
            return nil
        }

        let caffeineTiming = cleanString("caffeineTiming", previous?.caffeineTiming)
        let explicitLate = cleanBool("lateCaffeine", previous?.lateCaffeine)
        let inferredLate = (caffeineTiming == "evening" || caffeineTiming == "late")
        let updated = WatchLifestyleDay(
            dateISO: cleanString("dateISO", previous?.dateISO) ?? localDateISO(),
            hasLog: true,
            alcoholLevel: cleanString("alcoholLevel", previous?.alcoholLevel),
            alcoholDrinks: cleanDouble("alcoholDrinks", previous?.alcoholDrinks),
            alcoholTiming: cleanString("alcoholTiming", previous?.alcoholTiming),
            cannabisLevel: cleanString("cannabisLevel", previous?.cannabisLevel),
            cannabisTiming: cleanString("cannabisTiming", previous?.cannabisTiming),
            bowelMovementCount: cleanInt("bowelMovementCount", previous?.bowelMovementCount),
            bowelConsistency: cleanString("bowelConsistency", previous?.bowelConsistency),
            stressLevel: cleanString("stressLevel", previous?.stressLevel),
            illnessState: cleanString("illnessState", previous?.illnessState),
            caffeineMg: cleanDouble("caffeineMg", previous?.caffeineMg),
            caffeineTiming: caffeineTiming,
            lateCaffeine: explicitLate ?? (inferredLate ? true : nil),
            appetite: cleanString("appetite", previous?.appetite),
            syncedAtMs: Date().timeIntervalSince1970 * 1000
        )
        lifestyle = updated
        Self.persistOptional(updated, key: Self.storedLifestyleKey)
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
        let updated = WatchMealsDay(
            dateISO: day.dateISO,
            targets: day.targets,
            actual: WatchMealTargets(
                calories: actCal, proteinG: actPro, carbsG: actCarb, fatG: actFat,
            ),
            score: day.score,
            meals: newMeals,
            syncedAtMs: day.syncedAtMs,
        )
        self.meals = updated
        Self.persistOptional(updated, key: Self.storedMealsKey)
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
                    groupLabel: s.groupLabel,
                    taken: !s.taken, skipped: s.skipped && s.taken,
                ))
            } else {
                next.append(s)
            }
        }
        let updated = WatchSupplementsDay(
            dateISO: day.dateISO, items: next, syncedAtMs: day.syncedAtMs,
        )
        self.supplements = updated
        Self.persistOptional(updated, key: Self.storedSupplementsKey)
    }

    /// Mark every pending supplement as taken locally. Mirrors the
    /// "Take All (N)" button on the phone.
    func takeAllSupplementsLocal() {
        guard let day = supplements else { return }
        let next = day.items.map { s in
            (s.taken || s.skipped)
              ? s
              : WatchSupplementItem(id: s.id, name: s.name, dose: s.dose, timing: s.timing, groupLabel: s.groupLabel, taken: true, skipped: false)
        }
        let updated = WatchSupplementsDay(
            dateISO: day.dateISO, items: next, syncedAtMs: day.syncedAtMs,
        )
        self.supplements = updated
        Self.persistOptional(updated, key: Self.storedSupplementsKey)
    }

    /// Mark every pending supplement in a group as taken locally. Phone
    /// persists via `take_supplement_group` and re-pushes authoritative state.
    func takeSupplementGroupLocal(groupKey: String) {
        guard let day = supplements else { return }
        let next = day.items.map { s in
            (s.groupKey == groupKey && !s.taken && !s.skipped)
              ? WatchSupplementItem(id: s.id, name: s.name, dose: s.dose, timing: s.timing, groupLabel: s.groupLabel, taken: true, skipped: false)
              : s
        }
        let updated = WatchSupplementsDay(
            dateISO: day.dateISO, items: next, syncedAtMs: day.syncedAtMs,
        )
        self.supplements = updated
        Self.persistOptional(updated, key: Self.storedSupplementsKey)
    }

    // ─── Outgoing ───────────────────────────────────────────────────

    /// Fired when the user taps Start / Skip on the watch. Phone
    /// receives, kicks off its own workout state, then mirrors progress
    /// back via `progress` messages.
    func sendCommand(_ command: String, payload: [String: Any] = [:]) {
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
        body["commandId"] = "\(command)-\(Int(tsMs))-\(UUID().uuidString)"
        guard session.activationState == .activated else {
            print("[watch] sendCommand(\(command)) — not activated, queueing")
            HeartRateStore.saveDiag("→ \(command) queued: not activated")
            queuedCommands.append(body)
            // Persist immediately so a tap that lands during cold-
            // start (before WCSession activates) survives an app kill
            // happening in the activation window.
            persistQueuedCommands()
            session.activate()
            return
        }
        sendCommandBody(body, command: command, session: session)
    }

    private func flushQueuedCommands() {
        guard let session, session.activationState == .activated, !queuedCommands.isEmpty else { return }
        let pending = queuedCommands
        queuedCommands.removeAll()
        persistQueuedCommands()
        for body in pending {
            let command = body["command"] as? String ?? "<unknown>"
            sendCommandBody(body, command: command, session: session)
        }
    }

    private func sendCommandBody(_ body: [String: Any], command: String, session: WCSession) {
        if session.isReachable {
            print("[watch] sendCommand(\(command)) — reachable, sendMessage")
            HeartRateStore.saveDiag("→ \(command) reach=Y")
            session.sendMessage(body, replyHandler: nil) { [weak self] err in
                print("[watch] sendMessage(\(command)) error: \(err.localizedDescription)")
                if command != "pull_state" {
                    session.transferUserInfo(body)
                    HeartRateStore.saveDiag("→ \(command) fallback transfer")
                }
                DispatchQueue.main.async {
                    if command == "pull_state" {
                        self?.finishPhoneSync()
                    }
                    self?.lastError = err.localizedDescription
                    HeartRateStore.saveDiag("→ \(command) ERR: \(err.localizedDescription.prefix(40))")
                }
            }
        } else {
            // Queue for later delivery via transferUserInfo when phone
            // isn't reachable (locked / app backgrounded).
            if command == "pull_state" {
                if (body["force"] as? Bool) == true {
                    print("[watch] sendCommand(\(command)) — NOT reachable, queuing force pull via transferUserInfo")
                    HeartRateStore.saveDiag("→ \(command) reach=N (force queued)")
                    session.transferUserInfo(body)
                    return
                }
                print("[watch] sendCommand(\(command)) — NOT reachable, dropping wake-only pull")
                HeartRateStore.saveDiag("→ \(command) reach=N (dropped)")
                return
            }
            print("[watch] sendCommand(\(command)) — NOT reachable, queuing via transferUserInfo")
            HeartRateStore.saveDiag("→ \(command) reach=N (queued)")
            if WatchCellularClient.shared.canSendDirectCommand(command) {
                print("[watch] sendCommand(\(command)) — cellular fallback attempting")
                HeartRateStore.saveDiag("→ \(command) cellular attempt")
                WatchCellularClient.shared.sendCommand(body) { ok in
                    if ok {
                        HeartRateStore.saveDiag("→ \(command) cellular ok")
                    } else {
                        session.transferUserInfo(body)
                        HeartRateStore.saveDiag("→ \(command) cellular fail; WC queued")
                    }
                }
                return
            }
            session.transferUserInfo(body)
        }
    }
}

extension Notification.Name {
    static let watchProgressUpdate = Notification.Name("watchProgressUpdate")
    static let watchWorkoutLaunch = Notification.Name("thallo.watchWorkoutLaunch")
}

func wlog(_ msg: String) {
    print(msg)
}
