// Root view.
//
// Top-level TabView (page style) has primary pages:
//   • Today's workout (Start / Skip / Active-handoff) — default page
//   • Today's meals, hydration, supplements, sleep, readiness,
//     lifestyle, quick start, and weight — swipe horizontally.
// ActiveWorkoutView takes over while a workout is active.
//
// The active-workout state is tracked on this view:
//   • `active` = true when the USER tapped Start on the watch OR the
//     phone pushed `status: active`. Either way, we show the active UI.
//   • `active` = false when the user taps End on the watch OR the
//     phone pushes a terminal status (completed/skipped/scheduled).
// That lets Start/Skip sync bidirectionally — phone and watch can each
// originate the action and the other side mirrors.

import SwiftUI
import WatchKit

struct ContentView: View {
    @EnvironmentObject var conn: ConnectivityStore
    @EnvironmentObject var theme: ThemeStore
    /// Watched so we can defer HKWorkoutSession.startActivity until the
    /// scene is actually .active. Calling startActivity while watchOS
    /// considers the app transitioning (e.g. just after the HK auth
    /// dialog dismisses, or during a `startWatchApp`-triggered launch)
    /// throws the "HKClient application cannot start a workout session
    /// while in the background" error and the session never starts.
    @Environment(\.scenePhase) private var scenePhase

    @State private var active: Bool = false
    @StateObject private var heartRate: HeartRateStore = HeartRateStore()
    /// Set when `openActiveWorkout()` was called before scenePhase
    /// reached .active. Carries the resolved focus string so the
    /// scenePhase observer can replay the start once foreground is
    /// claimed without re-resolving from stale state.
    @State private var pendingStartFocus: String? = nil
    @State private var hasPrewarmedAuth: Bool = false
    // Set to true when the user explicitly taps Start so onReceive can
    // accept the phone's first active echo without the age check.
    @State private var watchStartPending: Bool = false
    @State private var pendingLocalSessionId: String? = nil
    /// Watch-started local workout snapshot. Populated whenever the
    /// user starts from the wrist so ActiveWorkoutView can keep running
    /// from cached data instead of waiting for the phone to echo active
    /// state. Cleared on workout end / cancel.
    ///
    /// Persisted to UserDefaults under `thallo.watchInitiatedWorkout`
    /// because watchOS aggressively suspends and re-launches widget /
    /// app extensions; without persistence, a brief background event
    /// would reset @State and the user would lose their workout
    /// mid-session. Hydrated on .onAppear and persisted on every
    /// assignment via the explicit set helper.
    @State private var watchInitiatedWorkout: WatchWorkout? = nil

    /// Keys for the persisted watch-initiated workout. The "AtMs"
    /// timestamp gates resume staleness — sessions older than 4h on
    /// re-launch are dropped (user finished and walked away without
    /// the watch picking up the end command, etc.).
    private static let kWatchInitiatedWorkoutKey = "thallo.watchInitiatedWorkout"
    private static let kWatchInitiatedSessionIdKey = "thallo.watchInitiatedSessionId"
    private static let kWatchInitiatedAtMsKey = "thallo.watchInitiatedAtMs"
    private static let watchInitiatedTTLMs: Double = 4 * 60 * 60 * 1000
    @State private var selectedPage: Int = 0
    // Show a brief "← swipe →" hint on the first launch the user
    // sees, then never again (persisted in UserDefaults). Covers the
    // "I didn't know there were pages" discoverability gap.
    @State private var showSwipeHint: Bool = !UserDefaults.standard.bool(forKey: "watchSwipeHintShown")

    private var displayedWorkout: WatchWorkout {
        conn.workout ?? WatchWorkout(
            focus: "Workout",
            durationMinutes: 60,
            dateISO: String(ISO8601DateFormatter().string(from: Date()).prefix(10)),
            status: .scheduled,
            sessionId: nil,
            readiness: nil,
            readinessLabel: nil,
            exercises: [],
            warmupSteps: nil,
            hrZones: nil,
            syncedAtMs: Date().timeIntervalSince1970 * 1000,
            userId: nil
        )
    }

    private var activeDisplayedWorkout: WatchWorkout {
        // A local wrist-started session takes precedence — the user
        // explicitly began this workout on the watch, and it must stay
        // available even when the phone is off or slow to echo state.
        if let w = watchInitiatedWorkout { return w }
        let w = displayedWorkout
        guard let sid = pendingLocalSessionId, !sid.isEmpty else { return w }
        if w.status == .completed || w.status == .skipped || w.status == .rest {
            return w
        }
        let resolvedSessionId = w.status == .active ? (w.sessionId ?? sid) : sid
        return activeSnapshot(from: w, sessionId: resolvedSessionId)
    }

    private func activeSnapshot(from w: WatchWorkout, sessionId: String) -> WatchWorkout {
        WatchWorkout(
            focus: w.focus,
            durationMinutes: w.durationMinutes,
            dateISO: w.dateISO,
            status: .active,
            sessionId: sessionId,
            readiness: w.readiness,
            readinessLabel: w.readinessLabel,
            exercises: w.exercises,
            warmupSteps: w.warmupSteps,
            hrZones: w.hrZones,
            syncedAtMs: max(w.syncedAtMs, Date().timeIntervalSince1970 * 1000),
            userId: w.userId
        )
    }

    /// Returns the workout with stale `.active` downgraded to `.scheduled`
    /// so the Today tab shows "Start" instead of "Rejoin workout" when the
    /// active status is from a previous account or expired session.
    private var todayWorkout: WatchWorkout? {
        guard let w = conn.workout else { return nil }
        if w.status == .active, !shouldResumeWorkout(w) {
            return WatchWorkout(
                focus: w.focus, durationMinutes: w.durationMinutes,
                dateISO: w.dateISO, status: .scheduled, sessionId: w.sessionId,
                readiness: w.readiness, readinessLabel: w.readinessLabel,
                exercises: w.exercises, warmupSteps: w.warmupSteps, hrZones: w.hrZones,
                syncedAtMs: w.syncedAtMs, userId: w.userId
            )
        }
        return w
    }

    /// Auto-resume only when: status is active, session wasn't already
    /// ended by this watch, and the push is recent (< 15 min). Cross-
    /// account protection is handled upstream in absorbContext, so no
    /// userId check here.
    private func shouldResumeWorkout(_ w: WatchWorkout) -> Bool {
        guard w.status == .active else { return false }
        let sid = w.sessionId ?? ""
        if !sid.isEmpty {
            let lastEnded = UserDefaults.standard.string(forKey: "thallo.lastEndedSessionId") ?? ""
            if sid == lastEnded {
                HeartRateStore.saveDiag("skip: sessionId=lastEnded")
                return false
            }
        }
        let ageMs = Date().timeIntervalSince1970 * 1000 - w.syncedAtMs
        if ageMs > 15 * 60 * 1000 {
            HeartRateStore.saveDiag("skip: stale \(Int(ageMs/1000))s")
            return false
        }
        HeartRateStore.saveDiag("resume OK sid=\(sid.prefix(8))")
        return true
    }

    private func consumePendingLaunch() {
        guard UserDefaults.standard.bool(forKey: "thallo.pendingWorkoutLaunch") else { return }
        UserDefaults.standard.set(false, forKey: "thallo.pendingWorkoutLaunch")
        if active { return }
        // Always pull fresh state from the phone first. Force = true:
        // this is an explicit user action (HK shortcut → "start workout
        // on watch") and must bypass the cooldown chain so the active
        // workout snapshot is current before we decide whether to
        // resume vs send the start command.
        conn.requestPull(force: true)
        if let w = conn.workout, shouldResumeWorkout(w) {
            HeartRateStore.saveDiag("pendingLaunch→active (valid session)")
            openActiveWorkout()
        } else {
            HeartRateStore.saveDiag("pendingLaunch: no valid active workout, waiting for pull")
        }
    }

    private func heartRateStartFocus(for workout: WatchWorkout?) -> String? {
        guard let workout else { return nil }
        let setlessCardioExercises = workout.exercises.filter { ex in
            ex.sets <= 0 && isStartCardioExercise(ex)
        }
        if !setlessCardioExercises.isEmpty && setlessCardioExercises.count == workout.exercises.count {
            let name = setlessCardioExercises[0].name.trimmingCharacters(in: .whitespacesAndNewlines)
            if !name.isEmpty { return name }
        }
        return workout.focus
    }

    private func isStartCardioExercise(_ ex: WatchExercise) -> Bool {
        let blob = [
            ex.name,
            ex.equipment ?? "",
            ex.primaryMuscle ?? "",
            ex.prescriptionType ?? ""
        ].joined(separator: " ").lowercased()
        if blob.contains("cardio") { return true }
        if blob.contains("stationary bike") || blob.contains("treadmill") || blob.contains("elliptical") || blob.contains("rower") || blob.contains("stair climber") { return true }
        return blob.range(of: "run|running|jog|walk|walking|hike|hiking|ride|bike|cycling|spin|swim|rowing|interval|zone ?2|hiit", options: .regularExpression) != nil
    }

    private func openActiveWorkout() {
        active = true
        if heartRate.running { return }
        // Pass the workout's focus so HeartRateStore can configure
        // HKWorkoutSession with the correct activity type +
        // (.outdoor for runs/bikes/hikes so the watch GPS feeds
        // distance into the live builder). Without this, every
        // session was forced to traditionalStrengthTraining +
        // .indoor and runs collected zero distance.
        //
        // Prefer the watch-initiated workout's focus over conn.workout
        // — the user's planned phone workout (e.g. "Strength") would
        // otherwise win and a watch-started Run would boot HK as
        // .traditionalStrengthTraining, leaving the user on the lift
        // ExerciseTab with the "Loading workout from phone…" shell
        // instead of the cardio tab.
        let workoutForStart = watchInitiatedWorkout ?? conn.workout ?? todayWorkout
        let focus = heartRateStartFocus(for: workoutForStart)
        // watchOS rejects HKWorkoutSession.startActivity if the app
        // hasn't fully claimed foreground yet — happens during the
        // launch handshake from `startWatchApp` and right after the
        // first-run HK auth dialog dismisses. Stash the focus and let
        // the scenePhase observer replay the start once .active is
        // reached. Otherwise start immediately.
        if scenePhase == .active {
            heartRate.start(focus: focus)
        } else {
            HeartRateStore.saveDiag("openActiveWorkout deferred (phase=\(scenePhase))")
            pendingStartFocus = focus
        }
    }

    private func makeLocalSessionId() -> String {
        "watch-\(Int(Date().timeIntervalSince1970 * 1000))-\(String(UUID().uuidString.prefix(8)))"
    }

    /// Persist or clear the watch-initiated workout snapshot. Called
    /// every time the in-memory state changes so a watchOS extension
    /// kill mid-workout can be recovered on relaunch.
    private func persistWatchInitiated(_ workout: WatchWorkout?, sessionId: String?) {
        if let workout, let sessionId, !sessionId.isEmpty,
           let data = try? JSONEncoder().encode(workout) {
            UserDefaults.standard.set(data, forKey: Self.kWatchInitiatedWorkoutKey)
            UserDefaults.standard.set(sessionId, forKey: Self.kWatchInitiatedSessionIdKey)
            UserDefaults.standard.set(Date().timeIntervalSince1970 * 1000,
                                       forKey: Self.kWatchInitiatedAtMsKey)
        } else {
            UserDefaults.standard.removeObject(forKey: Self.kWatchInitiatedWorkoutKey)
            UserDefaults.standard.removeObject(forKey: Self.kWatchInitiatedSessionIdKey)
            UserDefaults.standard.removeObject(forKey: Self.kWatchInitiatedAtMsKey)
        }
    }

    /// Pull a persisted watch-initiated workout back into @State on
    /// app launch. Returns true when a fresh-enough session was
    /// restored (caller should re-present the active view).
    private func hydrateWatchInitiated() -> Bool {
        let lastEnded = UserDefaults.standard.string(forKey: "thallo.lastEndedSessionId") ?? ""
        guard let data = UserDefaults.standard.data(forKey: Self.kWatchInitiatedWorkoutKey),
              let restored = try? JSONDecoder().decode(WatchWorkout.self, from: data),
              let sid = UserDefaults.standard.string(forKey: Self.kWatchInitiatedSessionIdKey),
              !sid.isEmpty else {
            return false
        }
        // Don't resurrect a session the user already ended — the
        // end command sets `thallo.lastEndedSessionId`, so the
        // sessionId-equality check filters out stale persists.
        if sid == lastEnded {
            persistWatchInitiated(nil, sessionId: nil)
            return false
        }
        let ageMs = Date().timeIntervalSince1970 * 1000
            - UserDefaults.standard.double(forKey: Self.kWatchInitiatedAtMsKey)
        if ageMs > Self.watchInitiatedTTLMs {
            HeartRateStore.saveDiag("hydrate watchInitiated: stale \(Int(ageMs / 1000))s")
            persistWatchInitiated(nil, sessionId: nil)
            return false
        }
        watchInitiatedWorkout = restored
        pendingLocalSessionId = sid
        HeartRateStore.saveDiag("hydrate watchInitiated OK sid=\(sid.prefix(8))")
        return true
    }

    private func startOrRejoinWorkout() {
        selectedPage = 0
        if let w = todayWorkout, w.status == .active {
            HeartRateStore.saveDiag("Start shortcut → rejoin active")
            pendingLocalSessionId = nil
            openActiveWorkout()
        } else {
            HeartRateStore.saveDiag("Start shortcut → active + phone command")
            ActiveWorkoutState.clearPersistedStore()
            let sessionId = makeLocalSessionId()
            let localWorkout = activeSnapshot(from: todayWorkout ?? displayedWorkout, sessionId: sessionId)
            watchInitiatedWorkout = localWorkout
            pendingLocalSessionId = sessionId
            persistWatchInitiated(localWorkout, sessionId: sessionId)
            watchStartPending = true
            openActiveWorkout()
            conn.sendCommand("start_workout", payload: ["sessionId": sessionId])
        }
    }

    private func handleWidgetURL(_ url: URL) {
        let route = ([url.host ?? ""] + url.pathComponents.filter { $0 != "/" })
            .joined(separator: "/")
            .lowercased()
        // Widget tap is an explicit user wake — force a fresh pull so
        // the surface they tapped renders current data, not stale cache.
        // Page indices match the TabView in `body`:
        //   0 Today · 1 Meals · 2 Hydration · 3 Supplements
        //   4 Sleep · 5 Readiness · 6 Lifestyle · 7 QuickStart · 8 Weight
        if route.contains("start-workout") {
            startOrRejoinWorkout()
            return
        }
        if route.contains("hydration") {
            selectedPage = 2
        } else if route.contains("sleep") {
            selectedPage = 4
        } else if route.contains("readiness") {
            selectedPage = 5
        } else if route.contains("lifestyle") {
            selectedPage = 6
        } else {
            selectedPage = 0
        }
        conn.requestPull(force: true)
    }

    private func localDateISO(_ date: Date = Date()) -> String {
        let comps = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", comps.year ?? 1970, comps.month ?? 1, comps.day ?? 1)
    }

    private var shouldShowStartupLoading: Bool {
        conn.isStartupLoading && !active
    }

    var body: some View {
        NavigationStack {
            ZStack {
                theme.background.ignoresSafeArea()
                if shouldShowStartupLoading {
                    StartupSyncView()
                        .transition(.opacity)
                } else {
                    TabView(selection: $selectedPage) {
                        TodayView(workout: todayWorkout, onStart: {
                            startOrRejoinWorkout()
                        }, onSkip: {
                            wlog("[watch] Skip tapped")
                            conn.sendCommand("skip_workout")
                        })
                        .tag(0)
                        MealsView(meals: conn.meals)
                            .tag(1)
                        HydrationView()
                            .tag(2)
                        SupplementsView()
                            .tag(3)
                        SleepView()
                            .tag(4)
                        ReadinessView()
                            .tag(5)
                        LifestyleView()
                            .tag(6)
                        QuickStartView(onStartCustom: { category, subtype, label, venue in
                            HeartRateStore.saveDiag("QuickStart tapped: \(label)")
                            // Build a synthetic WatchWorkout so the watch can
                            // open ActiveWorkoutView IMMEDIATELY without
                            // waiting for the phone roundtrip. The focus
                            // string drives HKLiveWorkoutBuilder's activity
                            // type + outdoor flag in HeartRateStore.start.
                            ActiveWorkoutState.clearPersistedStore()
                            let sessionId = makeLocalSessionId()
                            let synthetic = WatchWorkout(
                                focus: label,
                                durationMinutes: 30,
                                dateISO: localDateISO(),
                                status: .active,
                                sessionId: sessionId,
                                readiness: nil,
                                readinessLabel: nil,
                                exercises: [],
                                warmupSteps: nil,
                                hrZones: conn.workout?.hrZones,
                                syncedAtMs: Date().timeIntervalSince1970 * 1000,
                                userId: conn.workout?.userId
                            )
                            watchInitiatedWorkout = synthetic
                            pendingLocalSessionId = sessionId
                            persistWatchInitiated(synthetic, sessionId: sessionId)
                            watchStartPending = true
                            // Phone command goes out in parallel — backend
                            // session creation and history mirroring happen
                            // best-effort. Watch starts immediately either way.
                            var payload: [String: Any] = [
                                "category": category, "subtype": subtype,
                                "label": label, "source": "watch",
                                "sessionId": sessionId,
                            ]
                            if let venue = venue {
                                payload["venue"] = venue
                            }
                            conn.sendCommand("start_custom_workout", payload: payload)
                            openActiveWorkout()
                        }, onStartTemplate: { template in
                            HeartRateStore.saveDiag("StartTemplate: \(template.name)")
                            // Build a synthetic WatchWorkout with the
                            // template's exercises so ActiveWorkoutView
                            // opens immediately on the wrist with the
                            // right slots. Phone receives the command and
                            // mirrors the session into history.
                            ActiveWorkoutState.clearPersistedStore()
                            let sessionId = makeLocalSessionId()
                            let watchExercises = template.exercises.map { ex in
                                WatchExercise(
                                    name: ex.name,
                                    sets: max(1, ex.sets),
                                    reps: ex.reps,
                                    restSeconds: ex.restSeconds ?? 90,
                                    equipment: ex.equipment,
                                    primaryMuscle: ex.primaryMuscle,
                                    plannedTargetWeightLbs: nil,
                                    recommendation: nil,
                                    isGuide: nil,
                                    slotRole: nil,
                                    swapOptions: []
                                )
                            }
                            let synthetic = WatchWorkout(
                                focus: template.focus,
                                durationMinutes: max(20, template.exercises.count * 5),
                                dateISO: localDateISO(),
                                status: .active,
                                sessionId: sessionId,
                                readiness: nil,
                                readinessLabel: nil,
                                exercises: watchExercises,
                                warmupSteps: nil,
                                hrZones: conn.workout?.hrZones,
                                syncedAtMs: Date().timeIntervalSince1970 * 1000,
                                userId: conn.workout?.userId
                            )
                            watchInitiatedWorkout = synthetic
                            pendingLocalSessionId = sessionId
                            persistWatchInitiated(synthetic, sessionId: sessionId)
                            watchStartPending = true
                            conn.sendCommand("start_template_session", payload: [
                                "sessionId": sessionId,
                                "templateId": template.id,
                                "templateName": template.name,
                                "focus": template.focus,
                                "source": "watch",
                            ])
                            openActiveWorkout()
                        })
                        .tag(7)
                        WeightView()
                            .tag(8)
                    }
                    .tabViewStyle(.page)
                    .transition(.opacity)
                    .overlay(alignment: .top) {
                        if showSwipeHint {
                            SwipeHintPill()
                                .transition(.opacity)
                                .onAppear {
                                    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                                        withAnimation(.easeOut(duration: 0.3)) {
                                            showSwipeHint = false
                                        }
                                        UserDefaults.standard.set(true, forKey: "watchSwipeHintShown")
                                    }
                                }
                        }
                    }
                }
            }
            .onOpenURL { url in handleWidgetURL(url) }
            .navigationDestination(isPresented: $active) {
                ActiveWorkoutView(
                    workout: activeDisplayedWorkout,
                    hr: heartRate,
                    playStartCountdown: watchStartPending && (activeDisplayedWorkout.sessionId?.hasPrefix("watch-") ?? false),
                    onEndWorkout: { finalMetrics in
                        active = false
                        pendingStartFocus = nil
                        let sid = activeDisplayedWorkout.sessionId ?? conn.workout?.sessionId ?? ""
                        var payload = finalMetrics ?? [:]
                        if !sid.isEmpty {
                            payload["sessionId"] = sid
                        }
                        conn.sendCommand("end_workout", payload: payload)
                        heartRate.end()
                        if !sid.isEmpty {
                            UserDefaults.standard.set(sid, forKey: "thallo.lastEndedSessionId")
                        }
                        pendingLocalSessionId = nil
                        watchInitiatedWorkout = nil
                        persistWatchInitiated(nil, sessionId: nil)
                        UserDefaults.standard.set(false, forKey: "thallo.pendingWorkoutLaunch")
                    },
                    onCancelWorkout: {
                        active = false
                        pendingStartFocus = nil
                        heartRate.discard()
                        let sid = activeDisplayedWorkout.sessionId ?? conn.workout?.sessionId ?? ""
                        conn.sendCommand("cancel_workout", payload: ["sessionId": sid])
                        if !sid.isEmpty {
                            UserDefaults.standard.set(sid, forKey: "thallo.lastEndedSessionId")
                        }
                        pendingLocalSessionId = nil
                        watchInitiatedWorkout = nil
                        persistWatchInitiated(nil, sessionId: nil)
                        UserDefaults.standard.set(false, forKey: "thallo.pendingWorkoutLaunch")
                    }
                )
                .navigationBarBackButtonHidden(true)
                // CRITICAL: navigationDestination(isPresented:) does NOT propagate
                // @EnvironmentObject to its destination on watchOS 9+. Without these
                // explicit injections, ActiveWorkoutView crashes on first render with
                // "No ObservableObject of type ThemeStore found" — and because the
                // phone's applicationContext retains status:active, every relaunch
                // re-presents the same crashing view (the "can't get back in" loop).
                .environmentObject(conn)
                .environmentObject(theme)
            }
        }
        .onAppear {
            // Pre-request HK authorization on first appear so the
            // consent dialog has been answered long before the user
            // taps Start. Without this, the auth dialog appears
            // mid-startActivity, briefly suspends the app, and the
            // subsequent `beginSession` is rejected with the "cannot
            // start a workout session while in the background" error.
            // Idempotent — watchOS only shows the dialog once.
            if !hasPrewarmedAuth {
                hasPrewarmedAuth = true
                heartRate.prewarmAuth()
            }
            // Restore a watch-initiated cardio session that was killed
            // by a watchOS extension reload. Runs BEFORE the daily-
            // workout reconcile so a custom Ride started 2 minutes ago
            // wins over an irrelevant lift sitting in conn.workout.
            if !active, hydrateWatchInitiated() {
                HeartRateStore.saveDiag("onAppear restore custom cardio")
                openActiveWorkout()
                return
            }
            consumePendingLaunch()
            if let w = conn.workout, !active, shouldResumeWorkout(w) {
                HeartRateStore.saveDiag("onAppear reconcile→active")
                openActiveWorkout()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            // Replay any deferred start now that the scene is foreground.
            // Guarded by `active && !heartRate.running` so a transient
            // .inactive→.active flap doesn't double-start a live session.
            guard phase == .active else { return }
            if let focus = pendingStartFocus, active, !heartRate.running {
                pendingStartFocus = nil
                HeartRateStore.saveDiag("scenePhase=.active → replay start focus=\(focus)")
                heartRate.start(focus: focus)
            } else {
                pendingStartFocus = nil
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .watchWorkoutLaunch)) { _ in
            consumePendingLaunch()
        }
        .onReceive(conn.$theme) { palette in theme.palette = palette }
        .onReceive(conn.$workout) { w in
            guard let w = w else { return }
            HeartRateStore.saveDiag("rcv workout sync status=\(w.status) sid=\(w.sessionId?.prefix(8) ?? "nil")")

            // For non-active pushes, ignore the dismissal/clear when a
            // watch-initiated session is currently displayed and the
            // incoming sessionId doesn't match. Otherwise yesterday's
            // plan workout going .completed (or a routine .rest push
            // for a recovery day) would tear down a fresh watch-started
            // run/cardio that the phone doesn't know about yet.
            if w.status != .active {
                let displayedSid = activeDisplayedWorkout.sessionId ?? ""
                let incomingSid = w.sessionId ?? ""
                let watchInitiatedActive = watchInitiatedWorkout != nil
                let sameSession = !displayedSid.isEmpty && displayedSid == incomingSid
                if active && watchInitiatedActive && !sameSession {
                    HeartRateStore.saveDiag("ignored \(w.status) for sid=\(incomingSid.prefix(8)) — watch sid=\(displayedSid.prefix(8))")
                    return
                }
            }

            switch w.status {
            case .active:
                if let sid = w.sessionId, sid == pendingLocalSessionId {
                    pendingLocalSessionId = nil
                }
                if !active {
                    let pending = watchStartPending
                    if pending || shouldResumeWorkout(w) {
                        HeartRateStore.saveDiag("rcv active → active pending=\(pending)")
                        watchStartPending = false
                        openActiveWorkout()
                    }
                }
            case .completed, .skipped:
                watchStartPending = false
                pendingLocalSessionId = nil
                pendingStartFocus = nil
                ActiveWorkoutState.clearPersistedStore()
                if active {
                    active = false
                    heartRate.discard()
                }
                watchInitiatedWorkout = nil
                persistWatchInitiated(nil, sessionId: nil)
            case .rest, .scheduled:
                watchStartPending = false
                pendingLocalSessionId = nil
                pendingStartFocus = nil
            }
        }
    }
}

private struct StartupSyncView: View {
    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        ProgressView()
            .controlSize(.large)
            .tint(theme.primary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityLabel("Syncing with phone")
    }
}

// ─── Today's workout ────────────────────────────────────────────────

private struct TodayView: View {
    let workout: WatchWorkout?
    let onStart: () -> Void
    let onSkip: () -> Void

    @EnvironmentObject var theme: ThemeStore
    // Pull meals from the same store so we can render a nutrition
    // score chip below the readiness chip without needing another
    // payload. The meals day carries a `score: Int?` populated by
    // the phone's /meals/score endpoint.
    @EnvironmentObject var conn: ConnectivityStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                logoHeader
                if shouldShowSyncing {
                    SyncingPhoneView()
                } else if let workout = workout {
                    WatchSyncStrip(label: "workout", syncedAtMs: workout.syncedAtMs)
                    workoutBody(workout)
                } else {
                    WatchSyncStrip(label: "workout", syncedAtMs: conn.hydration?.syncedAtMs)
                    emptyPrompt
                }
            }
            .padding(10)
        }
    }

    // Small Thallo wordmark at the top — anchors the view and matches
    // the phone's brand. Tapping or long-pressing the logo sends
    // `pull_state` to the phone, giving the user a manual force-sync
    // escape hatch when the auto-push didn't land for any reason.
    private var logoHeader: some View {
        Button {
            WKInterfaceDevice.current().play(.click)
            conn.requestPull(force: true)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "sparkles")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(theme.primary)
                Text("THALLO")
                    .font(.system(size: 11, weight: .heavy))
                    .tracking(2.2)
                    .foregroundColor(theme.primary)
                Spacer()
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 9))
                    .foregroundColor(theme.textMuted)
            }
            .padding(.bottom, 2)
        }
        .buttonStyle(.plain)
    }

    private var shouldShowSyncing: Bool {
        if let workout, isLoadingPlaceholder(workout) { return true }
        return conn.isSyncingWithPhone && workout == nil
    }

    private func isLoadingPlaceholder(_ workout: WatchWorkout) -> Bool {
        let focus = workout.focus.trimmingCharacters(in: .whitespacesAndNewlines)
        return workout.status == .scheduled
            && workout.exercises.isEmpty
            && workout.durationMinutes == 0
            && (focus == "Loading…" || focus == "Loading..." || focus == "Loading")
    }

    private var emptyPrompt: some View {
        // Differentiate "no data yet" from "user is signed out" — the
        // signed-out case is permanent until they sign in on phone, so
        // the wording shouldn't make it sound like data is on its way.
        // currentUserId is the watch's own UserDefaults snapshot of who
        // last signed in on the iPhone; phone wipes it via setUserId(null)
        // on sign-out.
        let signedIn = !(conn.currentUserId ?? "").isEmpty
        return VStack(spacing: 10) {
            Image(systemName: signedIn ? "iphone" : "person.crop.circle.badge.exclamationmark")
                .font(.system(size: 28))
                .foregroundColor(signedIn ? theme.textMuted : theme.warning)
            Text(signedIn ? "Open Thallo" : "Sign in on iPhone")
                .font(.headline)
                .foregroundColor(theme.textPrimary)
            Text(signedIn
                 ? "Launch the iPhone app once so your workout syncs over."
                 : "Sign in to Thallo on your iPhone, then open the app to start syncing.")
                .font(.caption2)
                .foregroundColor(theme.textMuted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 10)
        }
        .padding(.vertical, 20)
    }

    @ViewBuilder
    private func workoutBody(_ workout: WatchWorkout) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            statusHeader(workout)

            // Skipped / rest / completed days don't need the exercise
            // list or the Start button — show only the status card.
            if workout.status == .scheduled || workout.status == .active {
                exerciseList(workout)
                actionButtons(workout)
            } else {
                terminalMessage(workout)
            }
        }
    }

    private func statusHeader(_ workout: WatchWorkout) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(topLabel(for: workout.status))
                    .font(.system(size: 9, weight: .bold))
                    .tracking(1.2)
                    .foregroundColor(statusColor(for: workout.status))
                if workout.status != .scheduled {
                    statusPill(workout.status)
                }
            }
            Text(workout.focus)
                .font(.system(size: 22, weight: .heavy))
                .foregroundColor(theme.textPrimary)
                .lineLimit(2)
            if workout.status == .scheduled || workout.status == .active {
                HStack(spacing: 6) {
                    Image(systemName: "clock")
                        .font(.system(size: 10))
                    Text("\(workout.durationMinutes) min · \(workout.exercises.count) exercises")
                        .font(.system(size: 11))
                }
                .foregroundColor(theme.textSecondary)
                // Readiness + Nutrition chips — side-by-side compact
                // row. Each is color-coded by tier so a glance tells
                // the user whether to push training / how their
                // nutrition is trending today. Both are optional —
                // chips hide when data isn't available.
                HStack(spacing: 6) {
                    // Readiness chip reads from `conn.readiness` first so
                    // the Today chip and the Readiness tab share ONE
                    // source. Falls back to the value embedded in the
                    // workout payload when the readiness payload hasn't
                    // landed yet, OR when it landed with a nil score.
                    // The `flatMap` matters: a plain `?? workout.readiness`
                    // would NOT fall through when conn.readiness exists
                    // but its `score` is nil — `Optional<Optional<Int>>`
                    // is non-nil at the outer level so `??` short-circuits.
                    let resolvedReadiness: Int? = conn.readiness.flatMap { $0.score } ?? workout.readiness
                    if let r = resolvedReadiness {
                        let color = r >= 70 ? theme.success
                            : r >= 40 ? theme.warning : theme.error
                        HStack(spacing: 4) {
                            Image(systemName: "bolt.fill")
                                .font(.system(size: 9))
                            Text("\(r) READY")
                                .font(.system(size: 10, weight: .heavy))
                                .tracking(0.3)
                        }
                        .foregroundColor(color)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(color.opacity(0.15))
                        .cornerRadius(6)
                    }
                    if let n = conn.meals?.score {
                        let color = n >= 70 ? theme.success
                            : n >= 45 ? theme.warning : theme.error
                        HStack(spacing: 4) {
                            Image(systemName: "fork.knife")
                                .font(.system(size: 9))
                            Text("\(n) FUEL")
                                .font(.system(size: 10, weight: .heavy))
                                .tracking(0.3)
                        }
                        .foregroundColor(color)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(color.opacity(0.15))
                        .cornerRadius(6)
                    }
                }
                .padding(.top, 2)
            }
        }
    }

    private func statusPill(_ status: WatchWorkoutStatus) -> some View {
        Text(statusPillLabel(status))
            .font(.system(size: 9, weight: .heavy))
            .tracking(0.5)
            .foregroundColor(statusColor(for: status))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(statusColor(for: status).opacity(0.18))
            .cornerRadius(6)
    }

    private func topLabel(for status: WatchWorkoutStatus) -> String {
        switch status {
        case .scheduled: return "TODAY"
        case .active:    return "IN PROGRESS"
        case .completed: return "TODAY"
        case .skipped:   return "TODAY"
        case .rest:      return "REST DAY"
        }
    }

    private func statusPillLabel(_ status: WatchWorkoutStatus) -> String {
        switch status {
        case .scheduled: return ""
        case .active:    return "ACTIVE"
        case .completed: return "DONE"
        case .skipped:   return "SKIPPED"
        case .rest:      return "REST"
        }
    }

    private func statusColor(for status: WatchWorkoutStatus) -> Color {
        switch status {
        case .scheduled, .active: return theme.primary
        case .completed:          return theme.success
        case .skipped, .rest:     return theme.textMuted
        }
    }

    private func exerciseList(_ workout: WatchWorkout) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(workout.exercises.enumerated()), id: \.element.id) { idx, ex in
                let done = watchExerciseIsDone(ex, at: idx, progress: conn.latestProgress, workout: workout)
                HStack(alignment: .top, spacing: 8) {
                    ZStack {
                        Circle()
                            .fill(done ? theme.success.opacity(0.2) : theme.primary.opacity(0.18))
                        if done {
                            Image(systemName: "checkmark")
                                .font(.system(size: 8, weight: .black))
                                .foregroundColor(theme.success)
                        } else {
                            Text("\(idx + 1)")
                                .font(.system(size: 10, weight: .heavy, design: .rounded))
                                .foregroundColor(theme.primary)
                        }
                    }
                    .frame(width: 18, height: 18)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 5) {
                            Text(ex.name)
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(done ? theme.textSecondary : theme.textPrimary)
                                .strikethrough(done, color: theme.success)
                                .lineLimit(2)
                            if done {
                                Text("DONE")
                                    .font(.system(size: 8, weight: .black))
                                    .foregroundColor(theme.success)
                                    .padding(.horizontal, 4)
                                    .padding(.vertical, 1)
                                    .background(theme.success.opacity(0.16))
                                    .cornerRadius(4)
                            }
                        }
                        detailLine(for: ex)
                    }
                }
                .padding(.vertical, 4)
                .padding(.horizontal, 6)
                .background(done ? theme.success.opacity(0.08) : theme.surface.opacity(0.6))
                .cornerRadius(8)
            }
        }
        .padding(.top, 4)
    }

    private func actionButtons(_ workout: WatchWorkout) -> some View {
        VStack(spacing: 6) {
            // Empty exercises = phone pushed a placeholder (Loading…) because
            // its schedule[0]/workoutPlan didn't have a real workout when the
            // last push fired. Hide Start (would do nothing) and show a Sync
            // button that re-pulls from the phone.
            if workout.exercises.isEmpty && workout.status == .scheduled {
                Button {
                    WKInterfaceDevice.current().play(.click)
                    conn.requestPull(force: true)
                } label: {
                    HStack {
                        Image(systemName: "arrow.clockwise")
                        Text("Sync from phone").fontWeight(.bold)
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .padding(.vertical, 9)
                .background(theme.primary)
                .foregroundColor(theme.background)
                .cornerRadius(10)
            } else if workout.status == .scheduled {
                Button(action: onStart) {
                    HStack {
                        Image(systemName: "play.circle.fill")
                        Text("Start").fontWeight(.bold)
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .padding(.vertical, 9)
                .background(theme.primary)
                .foregroundColor(theme.background)
                .cornerRadius(10)
                Button(action: onSkip) {
                    HStack {
                        Image(systemName: "forward.fill")
                        Text("Skip today")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .padding(.vertical, 9)
                .background(theme.surfaceRaised)
                .foregroundColor(theme.textSecondary)
                .cornerRadius(10)
            } else if workout.status == .active {
                Button(action: onStart) {
                    HStack {
                        Image(systemName: "arrow.right.circle.fill")
                        Text("Rejoin workout").fontWeight(.bold)
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .padding(.vertical, 9)
                .background(theme.primary)
                .foregroundColor(theme.background)
                .cornerRadius(10)
            }
        }
        .padding(.top, 4)
    }

    @ViewBuilder
    private func terminalMessage(_ workout: WatchWorkout) -> some View {
        VStack(spacing: 8) {
            Image(systemName: workout.status == .completed ? "checkmark.seal.fill"
                  : workout.status == .skipped ? "moon.fill"
                  : "bed.double.fill")
                .font(.system(size: 28))
                .foregroundColor(statusColor(for: workout.status))
            Text(terminalCaption(workout.status))
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(theme.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
    }

    private func terminalCaption(_ status: WatchWorkoutStatus) -> String {
        switch status {
        case .completed: return "Workout done for today"
        case .skipped:   return "You skipped today"
        case .rest:      return "Rest day — take it easy"
        default:         return ""
        }
    }

    @ViewBuilder
    private func detailLine(for ex: WatchExercise) -> some View {
        let parts: [String] = {
            var p: [String] = ["\(ex.sets) × \(ex.reps)"]
            if let eq = ex.equipment, !eq.isEmpty {
                let pretty = eq
                    .split(separator: ",")
                    .map { $0.trimmingCharacters(in: .whitespaces)
                            .replacingOccurrences(of: "_", with: " ")
                            .capitalized }
                    .joined(separator: ", ")
                p.append(pretty)
            }
            if ex.tracksWeightInput, let w = ex.plannedTargetWeightLbs, w > 0 {
                p.append("\(Int(w)) lb")
            }
            return p
        }()
        Text(parts.joined(separator: " · "))
            .font(.system(size: 10))
            .foregroundColor(theme.textMuted)
            .lineLimit(2)
    }
}

private struct SyncingPhoneView: View {
    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        VStack(spacing: 10) {
            ProgressView()
                .tint(theme.primary)
            Text("Syncing with phone")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(theme.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
    }
}

private struct WatchSyncStrip: View {
    let label: String
    let syncedAtMs: Double?

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var conn: ConnectivityStore

    private var statusText: String {
        conn.isReachable ? "Phone live" : "Queued"
    }

    private var statusColor: Color {
        conn.isReachable ? theme.success : theme.warning
    }

    var body: some View {
        Button {
            WKInterfaceDevice.current().play(.click)
            conn.requestPull(force: true)
        } label: {
            HStack(spacing: 6) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 7, height: 7)
                Text(statusText)
                    .font(.system(size: 10, weight: .heavy))
                    .foregroundColor(statusColor)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if let age = ageLabel() {
                    Text("\(label) \(age)")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(theme.textMuted)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                } else {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundColor(theme.textMuted)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(theme.surface)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(statusColor.opacity(0.35), lineWidth: 1)
            )
            .cornerRadius(8)
        }
        .buttonStyle(.plain)
    }

    private func ageLabel() -> String? {
        guard let syncedAtMs, syncedAtMs > 0 else { return nil }
        let ageSec = max(0, Int((Date().timeIntervalSince1970 * 1000 - syncedAtMs) / 1000))
        if ageSec < 5 { return "now" }
        if ageSec < 60 { return "\(ageSec)s" }
        let ageMin = ageSec / 60
        if ageMin < 60 { return "\(ageMin)m" }
        return "\(ageMin / 60)h"
    }
}

// ─── Meals ──────────────────────────────────────────────────────────

private struct MealsView: View {
    let meals: WatchMealsDay?
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var conn: ConnectivityStore
    @State private var showSpeechMeal = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) {
                    Image(systemName: "fork.knife")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(theme.primary)
                    Text("TODAY'S MEALS")
                        .font(.system(size: 11, weight: .heavy))
                        .tracking(1.8)
                        .foregroundColor(theme.primary)
                    Spacer()
                    Button {
                        WKInterfaceDevice.current().play(.click)
                        showSpeechMeal = true
                    } label: {
                        Image(systemName: "mic.fill")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundColor(theme.primary)
                            .padding(5)
                            .background(theme.primary.opacity(0.15))
                            .clipShape(Circle())
                    }
                    .buttonStyle(.plain)
                }
                if let meals = meals {
                    macroSummary(meals)
                    if meals.meals.isEmpty {
                        emptyMeals
                    } else {
                        mealList(meals)
                    }
                } else {
                    emptyPrompt
                }
            }
            .padding(10)
        }
        .sheet(isPresented: $showSpeechMeal) {
            SpeechMealView(isPresented: $showSpeechMeal)
                .environmentObject(conn)
                .environmentObject(theme)
        }
    }

    private func macroSummary(_ meals: WatchMealsDay) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .lastTextBaseline, spacing: 4) {
                Text("\(meals.actual.calories)")
                    .font(.system(size: 26, weight: .heavy, design: .rounded))
                    .foregroundColor(theme.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.65)
                Text("/ \(meals.targets.calories) kcal")
                    .font(.system(size: 10))
                    .foregroundColor(theme.textMuted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                Spacer()
                // Nutrition Score chip — same tier thresholds as the
                // phone's NutritionCard: 70+/45+/else.
                if let s = meals.score {
                    let color = s >= 70 ? theme.success
                        : s >= 45 ? theme.warning : theme.error
                    Text("\(s)")
                        .font(.system(size: 13, weight: .heavy))
                        .foregroundColor(color)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(color.opacity(0.18))
                        .cornerRadius(6)
                }
            }
            HStack(spacing: 6) {
                macroLine(label: "P", actual: meals.actual.proteinG, target: meals.targets.proteinG, color: theme.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                macroLine(label: "C", actual: meals.actual.carbsG,   target: meals.targets.carbsG,   color: theme.warning)
                    .frame(maxWidth: .infinity, alignment: .leading)
                macroLine(label: "F", actual: meals.actual.fatG,     target: meals.targets.fatG,     color: theme.success)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(10)
        .background(theme.surface)
        .cornerRadius(10)
    }

    private func macroLine(label: String, actual: Int, target: Int, color: Color) -> some View {
        // Progress-bar variant: numbers + a tiny fill bar so the user
        // sees adherence at a glance without doing the % math. Cap the
        // bar at 100% — overflow stays as text rather than visually
        // implying "done."
        let pct = target > 0 ? min(1.0, Double(actual) / Double(target)) : 0.0
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 3) {
                Text(label)
                    .font(.system(size: 9, weight: .heavy))
                    .foregroundColor(color)
                Text("\(actual)")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(theme.textPrimary)
                Text("/\(target)g")
                    .font(.system(size: 9))
                    .foregroundColor(theme.textMuted)
            }
            .lineLimit(1)
            .minimumScaleFactor(0.75)
            ZStack(alignment: .leading) {
                Rectangle()
                    .fill(color.opacity(0.18))
                    .frame(height: 3)
                    .cornerRadius(1.5)
                Rectangle()
                    .fill(color)
                    .frame(width: max(2, CGFloat(pct) * 44), height: 3)
                    .cornerRadius(1.5)
            }
            .frame(width: 44)
        }
    }

    private func mealList(_ meals: WatchMealsDay) -> some View {
        VStack(spacing: 6) {
            ForEach(meals.meals) { m in
                Button {
                    // Optimistic: flip the check locally so the tick
                    // + macro totals update instantly. Phone authors
                    // the next push and overrides if needed.
                    conn.toggleMealLocal(mealType: m.mealType)
                    conn.sendCommand("toggle_meal", payload: [
                        "dateISO": meals.dateISO,
                        "mealType": m.mealType,
                        "check": !m.checked,
                    ])
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: m.checked ? "checkmark.circle.fill" : "circle")
                            .font(.system(size: 18))
                            .foregroundColor(m.checked ? theme.success : theme.textMuted)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(m.name)
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(theme.textPrimary)
                                .lineLimit(1)
                            Text("\(m.calories) cal · \(m.proteinG)g P")
                                .font(.system(size: 10))
                                .foregroundColor(theme.textMuted)
                        }
                        Spacer()
                    }
                    .padding(10)
                    .background(theme.surface)
                    .cornerRadius(10)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var emptyMeals: some View {
        VStack(spacing: 8) {
            Text("No meals logged yet today")
                .font(.system(size: 11))
                .foregroundColor(theme.textMuted)
                .padding(.vertical, 4)
            Button {
                WKInterfaceDevice.current().play(.click)
                showSpeechMeal = true
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "mic.fill")
                        .font(.system(size: 10))
                    Text("Log with speech")
                        .font(.system(size: 11, weight: .semibold))
                }
                .foregroundColor(theme.background)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(theme.primary)
                .cornerRadius(9)
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 10)
    }

    private var emptyPrompt: some View {
        Text("Open Thallo on your iPhone to sync today's meals.")
            .font(.system(size: 11))
            .foregroundColor(theme.textMuted)
            .multilineTextAlignment(.center)
            .padding(.vertical, 24)
    }
}

// ─── Hydration ──────────────────────────────────────────────────────

private struct HydrationView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var conn: ConnectivityStore
    @State private var pendingOunces: Double = 0
    @State private var seeded: Bool = false

    private var dateISO: String {
        conn.hydration?.dateISO ?? localDateISO()
    }

    private var ounces: Double {
        conn.hydration?.ounces ?? 0
    }

    private var target: Double {
        max(1, conn.hydration?.targetOunces ?? 64)
    }

    private var targetLower: Double {
        if let explicit = conn.hydration?.targetOuncesMin, explicit > 0 {
            return explicit
        }
        return max(1, min(target, floor(target * 0.90 / 4.0) * 4.0))
    }

    private var targetUpper: Double {
        if let explicit = conn.hydration?.targetOuncesMax, explicit > 0 {
            return max(targetLower, explicit)
        }
        return max(target, ceil(target * 1.10 / 4.0) * 4.0)
    }

    private var targetRangeLabel: String {
        "\(formatOz(targetLower))-\(formatOz(targetUpper))"
    }

    private var percent: Int {
        min(999, max(0, Int(((ounces / targetLower) * 100).rounded())))
    }

    private var fillRatio: Double {
        min(1, max(0, ounces / targetUpper))
    }

    var body: some View {
        ZStack {
            theme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 6) {
                        Image(systemName: "drop.fill")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundColor(theme.primary)
                        Text("HYDRATION")
                            .font(.system(size: 10, weight: .heavy))
                            .tracking(1.1)
                            .foregroundColor(theme.primary)
                        Spacer()
                        Text("\(percent)%")
                            .font(.system(size: 10, weight: .heavy))
                            .foregroundColor(percent >= 100 ? theme.success : theme.textMuted)
                    }
                    WatchSyncStrip(label: "water", syncedAtMs: conn.hydration?.syncedAtMs)

                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .lastTextBaseline, spacing: 4) {
                            Text(formatOz(ounces))
                                .font(.system(size: 34, weight: .black, design: .rounded))
                                .foregroundColor(theme.textPrimary)
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                            Text("/ \(targetRangeLabel) oz")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundColor(theme.textMuted)
                        }
                        GeometryReader { proxy in
                            ZStack(alignment: .leading) {
                                RoundedRectangle(cornerRadius: 4)
                                    .fill(theme.surfaceRaised)
                                RoundedRectangle(cornerRadius: 4)
                                    .fill(theme.primary)
                                    .frame(width: max(5, proxy.size.width * CGFloat(fillRatio)))
                            }
                        }
                        .frame(height: 8)
                    }
                    .padding(10)
                    .background(theme.surface)
                    .cornerRadius(10)

                    HStack(spacing: 6) {
                        quickButton(8)
                        quickButton(16)
                        quickButton(24)
                    }

                    Button {
                        logDelta(-8)
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "minus.circle.fill")
                                .font(.system(size: 11))
                            Text("8 oz")
                                .font(.system(size: 11, weight: .bold))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .foregroundColor(theme.textSecondary)
                        .background(theme.surfaceRaised)
                        .cornerRadius(9)
                    }
                    .buttonStyle(.plain)

                    Text("SET TOTAL")
                        .font(.system(size: 8, weight: .heavy))
                        .tracking(0.7)
                        .foregroundColor(theme.textMuted)
                        .padding(.top, 4)

                    ZStack {
                        Capsule()
                            .fill(theme.surface)
                            .overlay(
                                Capsule().stroke(theme.primary.opacity(0.45), lineWidth: 1.5),
                            )
                        Text("\(formatOz(pendingOunces)) oz")
                            .font(.system(size: 22, weight: .black, design: .rounded))
                            .foregroundColor(theme.textPrimary)
                    }
                    .frame(height: 44)
                    .focusable(true)
                    .digitalCrownRotation(
                        $pendingOunces,
                        from: 0,
                        through: 300,
                        by: 1,
                        sensitivity: .low,
                        isContinuous: false,
                        isHapticFeedbackEnabled: true,
                    )

                    Button {
                        logTotal(pendingOunces)
                    } label: {
                        Text("Set")
                            .font(.system(size: 13, weight: .bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(theme.primary)
                            .foregroundColor(theme.background)
                            .cornerRadius(9)
                    }
                    .buttonStyle(.plain)
                }
                .padding(10)
            }
        }
        .onAppear { seedPendingIfNeeded() }
        .onChange(of: conn.hydration?.ounces ?? -1) { _, _ in
            pendingOunces = ounces
            seeded = true
        }
    }

    private func quickButton(_ oz: Double) -> some View {
        Button {
            logDelta(oz)
        } label: {
            VStack(spacing: 3) {
                Image(systemName: "plus.circle.fill")
                    .font(.system(size: 12, weight: .bold))
                Text("\(Int(oz)) oz")
                    .font(.system(size: 11, weight: .heavy))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .foregroundColor(theme.background)
            .background(theme.primary)
            .cornerRadius(9)
        }
        .buttonStyle(.plain)
    }

    private func logDelta(_ rawDelta: Double) {
        let delta = (rawDelta * 10).rounded() / 10
        let next = max(0, ((ounces + delta) * 10).rounded() / 10)
        WKInterfaceDevice.current().play(.success)
        conn.setHydrationLocal(ounces: next, dateISO: dateISO)
        pendingOunces = next
        conn.sendCommand("log_hydration", payload: [
            "dateISO": dateISO,
            "ounces": next,
            "deltaOz": delta,
        ])
    }

    private func logTotal(_ rawOunces: Double) {
        let next = max(0, (rawOunces * 10).rounded() / 10)
        WKInterfaceDevice.current().play(.success)
        conn.setHydrationLocal(ounces: next, dateISO: dateISO)
        pendingOunces = next
        conn.sendCommand("log_hydration", payload: [
            "dateISO": dateISO,
            "ounces": next,
        ])
    }

    private func seedPendingIfNeeded() {
        guard !seeded else { return }
        pendingOunces = ounces
        seeded = true
    }

    private func localDateISO(_ date: Date = Date()) -> String {
        let comps = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", comps.year ?? 1970, comps.month ?? 1, comps.day ?? 1)
    }

    private func formatOz(_ value: Double) -> String {
        let rounded = value.rounded()
        return abs(value - rounded) < 0.05 ? "\(Int(rounded))" : String(format: "%.1f", value)
    }
}
// ─── Swipe hint pill ────────────────────────────────────────────────

/// Small primary-tinted hint that appears once per install at the top
/// of the root TabView to teach the swipe gesture. Auto-dismisses
/// after a few seconds and is persisted so it won't re-appear.
private struct SwipeHintPill: View {
    @EnvironmentObject var theme: ThemeStore
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.left.and.right")
                .font(.system(size: 9, weight: .heavy))
            Text("SWIPE FOR MORE")
                .font(.system(size: 9, weight: .heavy))
                .tracking(0.8)
        }
        .foregroundColor(theme.background)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(theme.primary)
        .cornerRadius(8)
        .padding(.top, 4)
    }
}

// ─── Supplements tab ────────────────────────────────────────────────

private struct WatchSupplementGroup: Identifiable {
    let id: String
    let kind: String
    let label: String
    let timing: String?
    let groupLabel: String?
    let items: [WatchSupplementItem]

    var pendingCount: Int {
        items.filter { !$0.taken && !$0.skipped }.count
    }

    static func build(from items: [WatchSupplementItem]) -> [WatchSupplementGroup] {
        var buckets: [String: [WatchSupplementItem]] = [:]
        var meta: [String: (kind: String, label: String, timing: String?, groupLabel: String?)] = [:]

        for item in items {
            let key = item.groupKey
            buckets[key, default: []].append(item)
            if meta[key] == nil {
                meta[key] = (
                    kind: item.groupKind,
                    label: item.groupDisplayLabel,
                    timing: item.groupKind == "timing" ? item.timing : nil,
                    groupLabel: item.groupKind == "custom" ? item.groupDisplayLabel : nil
                )
            }
        }

        let timingOrder: [String: Int] = [
            "morning": 0,
            "pre_workout": 1,
            "post_workout": 2,
            "with_meal": 3,
            "evening": 4,
            "bedtime": 5,
        ]
        let kindOrder: [String: Int] = ["custom": 0, "timing": 1, "other": 2]

        return buckets.compactMap { key, values in
            guard let m = meta[key] else { return nil }
            return WatchSupplementGroup(
                id: key,
                kind: m.kind,
                label: m.label,
                timing: m.timing,
                groupLabel: m.groupLabel,
                items: values
            )
        }
        .sorted { a, b in
            if a.kind != b.kind {
                return (kindOrder[a.kind] ?? 99) < (kindOrder[b.kind] ?? 99)
            }
            if a.kind == "timing", b.kind == "timing" {
                return (timingOrder[a.timing ?? ""] ?? 99) < (timingOrder[b.timing ?? ""] ?? 99)
            }
            return a.label.localizedCaseInsensitiveCompare(b.label) == .orderedAscending
        }
    }
}

private struct SupplementsView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var conn: ConnectivityStore

    var body: some View {
        ZStack {
            theme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("SUPPLEMENTS")
                            .font(.system(size: 10, weight: .heavy))
                            .tracking(1.0)
                            .foregroundColor(theme.primary)
                        Spacer()
                        Text("today")
                            .font(.system(size: 9))
                            .foregroundColor(theme.textMuted)
                    }

                    if let list = conn.supplements?.items, !list.isEmpty {
                        let pending = list.filter { !$0.taken && !$0.skipped }
                        let groups = WatchSupplementGroup.build(from: list)
                        if pending.count >= 2 {
                            Button {
                                conn.takeAllSupplementsLocal()
                                conn.sendCommand("take_all_supplements")
                            } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: "checkmark.circle.fill")
                                        .font(.system(size: 12))
                                    Text("Take all (\(pending.count))")
                                        .font(.system(size: 12, weight: .heavy))
                                }
                                .foregroundColor(theme.background)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                                .background(theme.primary)
                                .cornerRadius(9)
                            }
                            .buttonStyle(.plain)
                        }
                        ForEach(groups) { group in
                            VStack(alignment: .leading, spacing: 5) {
                                HStack(spacing: 6) {
                                    Text(group.label.uppercased())
                                        .font(.system(size: 9, weight: .heavy))
                                        .tracking(0.7)
                                        .foregroundColor(theme.textMuted)
                                    Text("· \(group.items.count)")
                                        .font(.system(size: 9))
                                        .foregroundColor(theme.textMuted)
                                    Spacer()
                                    if group.kind != "other" && group.pendingCount >= 2 {
                                        Button {
                                            conn.takeSupplementGroupLocal(groupKey: group.id)
                                            var payload: [String: Any] = [:]
                                            if let groupLabel = group.groupLabel { payload["groupLabel"] = groupLabel }
                                            if let timing = group.timing { payload["timing"] = timing }
                                            conn.sendCommand("take_supplement_group", payload: payload)
                                        } label: {
                                            Text("Take \(group.pendingCount)")
                                                .font(.system(size: 10, weight: .heavy))
                                                .foregroundColor(theme.primary)
                                                .padding(.horizontal, 8)
                                                .padding(.vertical, 4)
                                                .background(theme.primary.opacity(0.15))
                                                .cornerRadius(8)
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                                ForEach(group.items) { s in
                                    Button {
                                        conn.toggleSupplementLocal(id: s.id)
                                        conn.sendCommand(
                                            "toggle_supplement",
                                            payload: ["id": s.id, "taken": !s.taken],
                                        )
                                    } label: {
                                        HStack(spacing: 8) {
                                            Image(systemName: s.taken
                                                ? "checkmark.circle.fill"
                                                : (s.skipped ? "xmark.circle" : "circle"))
                                                .font(.system(size: 18))
                                                .foregroundColor(s.taken ? theme.success : theme.textMuted)
                                            VStack(alignment: .leading, spacing: 1) {
                                                Text(s.name)
                                                    .font(.system(size: 12, weight: .semibold))
                                                    .foregroundColor(theme.textPrimary)
                                                    .lineLimit(1)
                                                if let dose = s.dose, !dose.isEmpty {
                                                    Text(dose)
                                                        .font(.system(size: 10))
                                                        .foregroundColor(theme.textMuted)
                                                }
                                            }
                                            Spacer()
                                        }
                                        .padding(10)
                                        .background(theme.surface)
                                        .cornerRadius(10)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    } else {
                        Text("Nothing scheduled today.")
                            .font(.system(size: 11))
                            .foregroundColor(theme.textMuted)
                            .padding(.vertical, 24)
                    }
                }
                .padding(10)
            }
        }
    }
}

// ─── Sleep tab ──────────────────────────────────────────────────────

private struct SleepView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var conn: ConnectivityStore

    var body: some View {
        ZStack {
            theme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Image(systemName: "moon.zzz.fill")
                            .font(.system(size: 11))
                            .foregroundColor(theme.primary)
                        Text("SLEEP")
                            .font(.system(size: 10, weight: .heavy))
                            .tracking(1.0)
                            .foregroundColor(theme.primary)
                        Spacer()
                        Text("last night")
                            .font(.system(size: 9))
                            .foregroundColor(theme.textMuted)
                    }
                    // Show whatever sleep data we have, including an explicit
                    // unavailable note when last night was not recorded.
                    if let s = conn.sleep, s.score != nil || s.hoursLastNight != nil || s.restingHr != nil || s.hrvMs != nil || s.label != nil || s.summary != nil {
                        // Score dial — same visual language as the
                        // readiness chip on Today.
                        HStack(alignment: .center, spacing: 12) {
                            if let score = s.score {
                                let color = scoreColor(score)
                                ZStack {
                                    Circle()
                                        .stroke(color.opacity(0.25), lineWidth: 5)
                                        .frame(width: 56, height: 56)
                                    Circle()
                                        .trim(from: 0, to: CGFloat(min(100, max(0, score))) / 100)
                                        .stroke(color, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                                        .frame(width: 56, height: 56)
                                        .rotationEffect(.degrees(-90))
                                    Text("\(score)")
                                        .font(.system(size: 18, weight: .black, design: .rounded))
                                        .foregroundColor(theme.textPrimary)
                                }
                            }
                            VStack(alignment: .leading, spacing: 2) {
                                if let h = s.hoursLastNight {
                                    Text(String(format: "%.1f h", h))
                                        .font(.system(size: 22, weight: .black, design: .rounded))
                                        .foregroundColor(theme.textPrimary)
                                }
                                if let l = s.label {
                                    Text(l.uppercased())
                                        .font(.system(size: 10, weight: .heavy))
                                        .tracking(0.6)
                                        .foregroundColor(scoreColor(s.score ?? 0))
                                }
                            }
                        }
                        if let summary = s.summary {
                            Text(summary)
                                .font(.system(size: 11))
                                .foregroundColor(theme.textSecondary)
                                .lineLimit(3)
                                .padding(.top, 2)
                        }
                        // Vital tiles — RHR + HRV.
                        HStack(spacing: 8) {
                            if let rhr = s.restingHr {
                                vitalTile(label: "RHR", value: "\(Int(rhr.rounded()))", unit: "bpm")
                            }
                            if let hrv = s.hrvMs {
                                vitalTile(label: "HRV", value: "\(Int(hrv.rounded()))", unit: "ms")
                            }
                        }
                        // Stage breakdown if available.
                        if let asleep = s.asleepMin, asleep > 0 {
                            VStack(alignment: .leading, spacing: 3) {
                                Text("STAGES")
                                    .font(.system(size: 8, weight: .heavy))
                                    .tracking(0.6)
                                    .foregroundColor(theme.textMuted)
                                HStack(spacing: 6) {
                                    if let rem = s.remMin, rem > 0 {
                                        stageChip(label: "REM", min: rem, color: theme.primary)
                                    }
                                    if let deep = s.deepMin, deep > 0 {
                                        stageChip(label: "Deep", min: deep, color: theme.success)
                                    }
                                    let core = max(0, asleep - (s.remMin ?? 0) - (s.deepMin ?? 0))
                                    if core > 0 {
                                        stageChip(label: "Core", min: core, color: theme.warning)
                                    }
                                }
                            }
                            .padding(.top, 4)
                        }
                    } else {
                        Text("Open Thallo on iPhone to sync sleep.")
                            .font(.system(size: 11))
                            .foregroundColor(theme.textMuted)
                            .multilineTextAlignment(.center)
                            .padding(.vertical, 24)
                    }
                }
                .padding(10)
            }
        }
    }

    private func scoreColor(_ score: Int) -> Color {
        if score >= 80 { return theme.success }
        if score >= 60 { return theme.primary }
        if score >= 40 { return theme.warning }
        return theme.error
    }

    private func vitalTile(label: String, value: String, unit: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.system(size: 8, weight: .heavy))
                .tracking(0.6)
                .foregroundColor(theme.textMuted)
            HStack(alignment: .lastTextBaseline, spacing: 2) {
                Text(value)
                    .font(.system(size: 16, weight: .black, design: .rounded))
                    .foregroundColor(theme.textPrimary)
                Text(unit)
                    .font(.system(size: 9))
                    .foregroundColor(theme.textMuted)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.surface)
        .cornerRadius(8)
    }

    private func stageChip(label: String, min: Int, color: Color) -> some View {
        let h = min / 60
        let m = min % 60
        let txt = h > 0 ? "\(h)h \(m)m" : "\(m)m"
        return HStack(spacing: 3) {
            Circle().fill(color).frame(width: 5, height: 5)
            Text("\(label) \(txt)")
                .font(.system(size: 9, weight: .semibold))
                .foregroundColor(theme.textSecondary)
        }
    }
}

// ─── Quick-start tab — start a custom workout from the watch ────────

private struct QuickStartView: View {
    let onStartCustom: (_ category: String, _ subtype: String, _ label: String, _ venue: String?) -> Void
    var onStartTemplate: ((WatchTemplate) -> Void)? = nil
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var conn: ConnectivityStore

    private static let activities: [(category: String, subtype: String, label: String, icon: String, venue: String?)] = [
        ("cardio", "run",     "Outdoor Run",  "figure.run", "outdoor"),
        ("cardio", "run",     "Indoor Run",   "figure.run", "indoor"),
        ("cardio", "walk",    "Outdoor Walk", "figure.walk", "outdoor"),
        ("cardio", "walk",    "Indoor Walk",  "figure.walk", "indoor"),
        ("cardio", "hike",    "Hike",         "figure.hiking", "outdoor"),
        ("cardio", "ride",    "Outdoor Ride", "figure.outdoor.cycle", "outdoor"),
        ("cardio", "ride",    "Indoor Ride",  "figure.indoor.cycle", "indoor"),
        ("cardio", "spin",    "Spin",         "figure.indoor.cycle", "indoor"),
        ("cardio", "swim",    "Pool Swim",    "figure.pool.swim", "indoor"),
        ("cardio", "swim",    "Open Water Swim", "water.waves", "outdoor"),
        ("cardio", "row",     "Indoor Row",   "figure.rower", "indoor"),
        ("cardio", "row",     "Outdoor Row",  "figure.rower", "outdoor"),
        ("cardio", "stair",   "Stair",        "figure.stairs", "indoor"),
        ("cardio", "hiit",    "HIIT",         "flame.fill", "indoor"),
        ("sport",  "soccer",  "Outdoor Soccer", "soccerball", "outdoor"),
        ("sport",  "soccer",  "Indoor Soccer",  "soccerball", "indoor"),
        ("sport",  "basketball", "Indoor Basketball",  "basketball.fill", "indoor"),
        ("sport",  "basketball", "Outdoor Basketball", "basketball.fill", "outdoor"),
        ("sport",  "tennis", "Outdoor Tennis", "tennis.racket", "outdoor"),
        ("sport",  "tennis", "Indoor Tennis",  "tennis.racket", "indoor"),
        ("sport",  "pickleball", "Outdoor Pickleball", "tennisball.fill", "outdoor"),
        ("sport",  "pickleball", "Indoor Pickleball",  "tennisball.fill", "indoor"),
        ("sport",  "volleyball", "Indoor Volleyball",  "volleyball.fill", "indoor"),
        ("sport",  "volleyball", "Outdoor Volleyball", "volleyball.fill", "outdoor"),
        ("sport",  "beach_volleyball", "Beach Volleyball", "sun.max.fill", "outdoor"),
        ("sport",  "golf", "Golf", "flag.fill", "outdoor"),
        ("sport",  "martial_arts", "Martial Arts", "shield.fill", "indoor"),
        ("mobility", "yoga", "Indoor Yoga",  "figure.yoga", "indoor"),
        ("mobility", "yoga", "Outdoor Yoga", "sun.max.fill", "outdoor"),
        ("mobility", "pilates", "Pilates",  "figure.yoga", nil),
    ]

    var body: some View {
        ZStack {
            theme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Image(systemName: "play.circle.fill")
                            .font(.system(size: 11))
                            .foregroundColor(theme.primary)
                        Text("CUSTOM WORKOUT")
                            .font(.system(size: 10, weight: .heavy))
                            .tracking(1.0)
                            .foregroundColor(theme.primary)
                        Spacer()
                    }
                    Text("Pick an activity to start tracking now.")
                        .font(.system(size: 10))
                        .foregroundColor(theme.textMuted)
                        .padding(.bottom, 4)
                    ForEach(0..<Self.activities.count, id: \.self) { i in
                        let a = Self.activities[i]
                        Button {
                            WKInterfaceDevice.current().play(.start)
                            onStartCustom(a.category, a.subtype, a.label, a.venue)
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: a.icon)
                                    .font(.system(size: 14))
                                    .foregroundColor(theme.primary)
                                    .frame(width: 22, height: 22)
                                Text(a.label)
                                    .font(.system(size: 13, weight: .bold))
                                    .foregroundColor(theme.textPrimary)
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 10))
                                    .foregroundColor(theme.textMuted)
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .background(theme.surface)
                            .cornerRadius(10)
                        }
                        .buttonStyle(.plain)
                    }

                    // ── Saved-templates section ────────────────────
                    // Synced from the phone via syncTemplates. Renders
                    // the user's saved strength templates as one-tap
                    // launches; tapping fires onStartTemplate which
                    // synthesizes a WatchWorkout with the template's
                    // exercises and opens ActiveWorkoutView.
                    if let templates = conn.templates?.templates, !templates.isEmpty,
                       let onStartTemplate {
                        HStack {
                            Image(systemName: "bookmark.fill")
                                .font(.system(size: 11))
                                .foregroundColor(theme.primary)
                            Text("STRENGTH TEMPLATES")
                                .font(.system(size: 10, weight: .heavy))
                                .tracking(1.0)
                                .foregroundColor(theme.primary)
                            Spacer()
                        }
                        .padding(.top, 8)
                        ForEach(templates, id: \.id) { template in
                            Button {
                                WKInterfaceDevice.current().play(.start)
                                onStartTemplate(template)
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "bookmark.fill")
                                        .font(.system(size: 13))
                                        .foregroundColor(theme.primary)
                                        .frame(width: 22, height: 22)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(template.name)
                                            .font(.system(size: 13, weight: .bold))
                                            .foregroundColor(theme.textPrimary)
                                            .lineLimit(1)
                                        Text("\(template.exercises.count) ex · \(template.focus)")
                                            .font(.system(size: 10))
                                            .foregroundColor(theme.textMuted)
                                            .lineLimit(1)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 10))
                                        .foregroundColor(theme.textMuted)
                                }
                                .padding(.horizontal, 10)
                                .padding(.vertical, 8)
                                .background(theme.surface)
                                .cornerRadius(10)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(10)
            }
        }
    }
}

// ─── Readiness drill-down tab ──────────────────────────────────────

private struct ReadinessView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var conn: ConnectivityStore

    var body: some View {
        ZStack {
            theme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Image(systemName: "bolt.heart.fill")
                            .font(.system(size: 11))
                            .foregroundColor(theme.primary)
                        Text("READINESS")
                            .font(.system(size: 10, weight: .heavy))
                            .tracking(1.0)
                            .foregroundColor(theme.primary)
                        Spacer()
                        Text("today")
                            .font(.system(size: 9))
                            .foregroundColor(theme.textMuted)
                    }
                    if let r = conn.readiness {
                        // Score dial + label.
                        HStack(alignment: .center, spacing: 12) {
                            if let score = r.score {
                                let color = scoreColor(score)
                                ZStack {
                                    Circle()
                                        .stroke(color.opacity(0.25), lineWidth: 5)
                                        .frame(width: 60, height: 60)
                                    Circle()
                                        .trim(from: 0, to: CGFloat(min(100, max(0, score))) / 100)
                                        .stroke(color, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                                        .frame(width: 60, height: 60)
                                        .rotationEffect(.degrees(-90))
                                    Text("\(score)")
                                        .font(.system(size: 20, weight: .black, design: .rounded))
                                        .foregroundColor(theme.textPrimary)
                                }
                            }
                            VStack(alignment: .leading, spacing: 2) {
                                if let l = r.label {
                                    Text(l.uppercased())
                                        .font(.system(size: 11, weight: .heavy))
                                        .tracking(0.6)
                                        .foregroundColor(scoreColor(r.score ?? 0))
                                }
                                if let s = r.summary {
                                    Text(s)
                                        .font(.system(size: 10))
                                        .foregroundColor(theme.textSecondary)
                                        .lineLimit(3)
                                }
                            }
                        }
                        // Per-factor bars.
                        if !r.factors.isEmpty {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("FACTORS")
                                    .font(.system(size: 8, weight: .heavy))
                                    .tracking(0.6)
                                    .foregroundColor(theme.textMuted)
                                    .padding(.top, 4)
                                ForEach(r.factors, id: \.label) { f in
                                    let color = factorColor(f.status)
                                    VStack(alignment: .leading, spacing: 2) {
                                        HStack {
                                            Text(f.label)
                                                .font(.system(size: 10, weight: .bold))
                                                .foregroundColor(theme.textPrimary)
                                            Spacer()
                                            if let detail = f.detail {
                                                Text(detail)
                                                    .font(.system(size: 9))
                                                    .foregroundColor(theme.textMuted)
                                            }
                                        }
                                        ZStack(alignment: .leading) {
                                            Rectangle()
                                                .fill(theme.surface)
                                                .frame(height: 4)
                                                .cornerRadius(2)
                                            Rectangle()
                                                .fill(color)
                                                .frame(width: max(2, CGFloat(min(100, max(0, f.value))) * 1.0), height: 4)
                                                .cornerRadius(2)
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        Text("Open Thallo on iPhone to sync readiness signals.")
                            .font(.system(size: 11))
                            .foregroundColor(theme.textMuted)
                            .multilineTextAlignment(.center)
                            .padding(.vertical, 24)
                    }
                }
                .padding(10)
            }
        }
    }

    private func scoreColor(_ score: Int) -> Color {
        if score >= 75 { return theme.success }
        if score >= 55 { return theme.primary }
        if score >= 35 { return theme.warning }
        return theme.error
    }

    private func factorColor(_ status: String) -> Color {
        switch status {
        case "good": return theme.success
        case "ok":   return theme.warning
        case "low":  return theme.error
        default:     return theme.primary
        }
    }
}

// ─── Lifestyle quick-log tab ───────────────────────────────────────

private struct LifestyleView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var conn: ConnectivityStore

    private var dateISO: String {
        conn.lifestyle?.dateISO ?? localDateISO()
    }

    private var summaryItems: [String] {
        guard let l = conn.lifestyle, l.hasLog else { return [] }
        var items: [String] = []
        if let stress = l.stressLevel { items.append("Stress \(display(stress))") }
        if let timing = l.caffeineTiming, timing == "late" || l.lateCaffeine == true { items.append("Late caffeine") }
        if let alcohol = l.alcoholLevel, alcohol != "none" { items.append("Alcohol \(display(alcohol))") }
        if let cannabis = l.cannabisLevel, cannabis != "none" { items.append("Cannabis \(display(cannabis))") }
        if let illness = l.illnessState, illness != "healthy" { items.append(display(illness)) }
        if let appetite = l.appetite { items.append("Appetite \(display(appetite))") }
        if l.bowelMovementCount != nil || l.bowelConsistency != nil { items.append("Digestion logged") }
        return items
    }

    var body: some View {
        ZStack {
            theme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 6) {
                        Image(systemName: "sparkles")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundColor(theme.primary)
                        Text("LIFESTYLE")
                            .font(.system(size: 10, weight: .heavy))
                            .foregroundColor(theme.primary)
                        Spacer()
                        Text("today")
                            .font(.system(size: 9))
                            .foregroundColor(theme.textMuted)
                    }
                    WatchSyncStrip(label: "lifestyle", syncedAtMs: conn.lifestyle?.syncedAtMs)

                    if summaryItems.isEmpty {
                        Text("No factors logged today")
                            .font(.system(size: 11))
                            .foregroundColor(theme.textMuted)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.vertical, 10)
                            .background(theme.surface)
                            .cornerRadius(10)
                    } else {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(summaryItems.prefix(4), id: \.self) { item in
                                Text(item)
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundColor(theme.textSecondary)
                                    .lineLimit(1)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                        .background(theme.surface)
                        .cornerRadius(10)
                    }

                    quickSection("Stress") {
                        HStack(spacing: 6) {
                            optionButton("Low", active: conn.lifestyle?.stressLevel == "low", payload: ["stressLevel": "low"])
                            optionButton("Mod", active: conn.lifestyle?.stressLevel == "moderate", payload: ["stressLevel": "moderate"])
                            optionButton("High", active: conn.lifestyle?.stressLevel == "high", payload: ["stressLevel": "high"])
                        }
                    }

                    quickSection("Caffeine") {
                        HStack(spacing: 6) {
                            optionButton("None", active: conn.lifestyle?.caffeineTiming == "unknown", payload: ["caffeineTiming": "unknown", "caffeineMg": 0, "lateCaffeine": false])
                            optionButton("AM", active: conn.lifestyle?.caffeineTiming == "morning", payload: ["caffeineTiming": "morning", "caffeineMg": 100, "lateCaffeine": false])
                            optionButton("Late", active: conn.lifestyle?.lateCaffeine == true || conn.lifestyle?.caffeineTiming == "late", payload: ["caffeineTiming": "late", "caffeineMg": 100, "lateCaffeine": true])
                        }
                    }

                    quickSection("Alcohol") {
                        HStack(spacing: 6) {
                            optionButton("None", active: conn.lifestyle?.alcoholLevel == "none", payload: ["alcoholLevel": "none", "alcoholDrinks": 0])
                            optionButton("Light", active: conn.lifestyle?.alcoholLevel == "light", payload: ["alcoholLevel": "light", "alcoholDrinks": 1])
                            optionButton("Mod", active: conn.lifestyle?.alcoholLevel == "moderate", payload: ["alcoholLevel": "moderate", "alcoholDrinks": 2])
                        }
                    }

                    quickSection("Cannabis") {
                        HStack(spacing: 6) {
                            optionButton("None", active: conn.lifestyle?.cannabisLevel == "none", payload: ["cannabisLevel": "none"])
                            optionButton("Light", active: conn.lifestyle?.cannabisLevel == "light", payload: ["cannabisLevel": "light"])
                            optionButton("Mod", active: conn.lifestyle?.cannabisLevel == "moderate", payload: ["cannabisLevel": "moderate"])
                        }
                    }

                    quickSection("Digestion") {
                        HStack(spacing: 6) {
                            optionButton("0 BM", active: conn.lifestyle?.bowelMovementCount == 0, payload: ["bowelMovementCount": 0])
                            optionButton("1 BM", active: conn.lifestyle?.bowelMovementCount == 1, payload: ["bowelMovementCount": 1])
                            optionButton("Normal", active: conn.lifestyle?.bowelConsistency == "normal", payload: ["bowelConsistency": "normal"])
                        }
                        HStack(spacing: 6) {
                            optionButton("Hard", active: conn.lifestyle?.bowelConsistency == "hard", payload: ["bowelConsistency": "hard"])
                            optionButton("Loose", active: conn.lifestyle?.bowelConsistency == "loose", payload: ["bowelConsistency": "loose"])
                            optionButton("Mixed", active: conn.lifestyle?.bowelConsistency == "mixed", payload: ["bowelConsistency": "mixed"])
                        }
                    }

                    quickSection("Body") {
                        HStack(spacing: 6) {
                            optionButton("Healthy", active: conn.lifestyle?.illnessState == "healthy", payload: ["illnessState": "healthy"])
                            optionButton("Run down", active: conn.lifestyle?.illnessState == "rundown", payload: ["illnessState": "rundown"])
                            optionButton("Sick", active: conn.lifestyle?.illnessState == "sick", payload: ["illnessState": "sick"])
                        }
                        HStack(spacing: 6) {
                            optionButton("Low appetite", active: conn.lifestyle?.appetite == "low", payload: ["appetite": "low"])
                            optionButton("Normal", active: conn.lifestyle?.appetite == "normal", payload: ["appetite": "normal"])
                            optionButton("High", active: conn.lifestyle?.appetite == "high", payload: ["appetite": "high"])
                        }
                    }
                }
                .padding(10)
            }
        }
    }

    private func quickSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(.system(size: 8, weight: .heavy))
                .foregroundColor(theme.textMuted)
            content()
        }
    }

    private func optionButton(_ label: String, active: Bool, payload: [String: Any]) -> some View {
        Button {
            var body = payload
            body["dateISO"] = dateISO
            WKInterfaceDevice.current().play(.success)
            conn.mergeLifestyleLocal(body)
            conn.sendCommand("log_lifestyle", payload: body)
        } label: {
            Text(label)
                .font(.system(size: 10, weight: .bold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 7)
                .foregroundColor(active ? theme.background : theme.textSecondary)
                .background(active ? theme.primary : theme.surfaceRaised)
                .cornerRadius(8)
        }
        .buttonStyle(.plain)
    }

    private func display(_ value: String) -> String {
        switch value {
        case "moderate": return "mod"
        case "rundown": return "run down"
        case "not_sure": return "not sure"
        default: return value
        }
    }

    private func localDateISO(_ date: Date = Date()) -> String {
        let comps = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", comps.year ?? 1970, comps.month ?? 1, comps.day ?? 1)
    }
}

// ─── Body weight quick-log tab ────────────────────────────────────

private struct WeightView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var conn: ConnectivityStore
    @State private var pendingLbs: Double = 170
    @State private var seeded: Bool = false
    @State private var logStatus: WeightLogStatus = .idle
    @State private var lastSubmittedLbs: Double?
    @State private var clearLogStatusItem: DispatchWorkItem?

    private enum WeightLogStatus {
        case idle
        case sent
        case queued
        case saved
    }

    var body: some View {
        ZStack {
            theme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Image(systemName: "scalemass.fill")
                            .font(.system(size: 11))
                            .foregroundColor(theme.primary)
                        Text("WEIGHT")
                            .font(.system(size: 10, weight: .heavy))
                            .tracking(1.0)
                            .foregroundColor(theme.primary)
                        Spacer()
                        if let d = conn.weight?.daysSinceLastLog {
                            Text(d == 0 ? "logged today" : (d == 1 ? "1d ago" : "\(d)d ago"))
                                .font(.system(size: 9))
                                .foregroundColor(d > 3 ? theme.warning : theme.textMuted)
                        }
                    }
                    // Headline = most recent logged weight. The 7-day EMA + slope
                    // sit underneath as context so the user sees both "what I
                    // actually weighed" and "where the trend is going" at a
                    // glance. Falls back to EMA when no individual log exists
                    // (early-onboarding case).
                    if let latest = conn.weight?.latestLbs {
                        HStack(alignment: .lastTextBaseline, spacing: 4) {
                            Text(String(format: "%.1f", latest))
                                .font(.system(size: 32, weight: .black, design: .rounded))
                                .foregroundColor(theme.textPrimary)
                            Text("lb")
                                .font(.system(size: 11))
                                .foregroundColor(theme.textMuted)
                        }
                        if let ema = conn.weight?.emaLbs, abs(ema - latest) > 0.05 {
                            Text(String(format: "%.1f lb 7-day avg", ema))
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundColor(theme.textSecondary)
                        }
                        if let slope = conn.weight?.slopeLbsPerWeek, abs(slope) > 0.05 {
                            let arrow = slope > 0 ? "arrow.up" : "arrow.down"
                            let color = abs(slope) > 1.5 ? theme.warning : theme.textSecondary
                            HStack(spacing: 3) {
                                Image(systemName: arrow)
                                    .font(.system(size: 9))
                                Text(String(format: "%.1f lb / wk", abs(slope)))
                                    .font(.system(size: 10, weight: .semibold))
                            }
                            .foregroundColor(color)
                        }
                    } else if let ema = conn.weight?.emaLbs {
                        // No latest log — fall back to EMA-only display.
                        HStack(alignment: .lastTextBaseline, spacing: 4) {
                            Text(String(format: "%.1f", ema))
                                .font(.system(size: 32, weight: .black, design: .rounded))
                                .foregroundColor(theme.textPrimary)
                            Text("lb avg")
                                .font(.system(size: 11))
                                .foregroundColor(theme.textMuted)
                        }
                    }
                    // Quick-log dial.
                    Text("LOG TODAY")
                        .font(.system(size: 8, weight: .heavy))
                        .tracking(0.6)
                        .foregroundColor(theme.textMuted)
                        .padding(.top, 6)
                    ZStack {
                        Capsule()
                            .fill(theme.surface)
                            .overlay(
                                Capsule().stroke(theme.primary.opacity(0.4), lineWidth: 1.5),
                            )
                        Text(String(format: "%.1f lb", pendingLbs))
                            .font(.system(size: 22, weight: .black, design: .rounded))
                            .foregroundColor(theme.textPrimary)
                    }
                    .frame(height: 44)
                    .focusable(true)
                    .digitalCrownRotation(
                        $pendingLbs,
                        from: 50,
                        through: 600,
                        by: 0.2,
                        sensitivity: .low,
                        isContinuous: false,
                        isHapticFeedbackEnabled: true,
                    )
                    Button {
                        submitWeightLog()
                    } label: {
                        Text(logButtonTitle)
                            .font(.system(size: 13, weight: .bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(logStatus == .saved ? theme.success : theme.primary)
                            .foregroundColor(theme.background)
                            .cornerRadius(9)
                    }
                    .buttonStyle(.plain)
                    if let message = logStatusMessage {
                        HStack(spacing: 5) {
                            Image(systemName: logStatusIcon)
                                .font(.system(size: 10, weight: .bold))
                            Text(message)
                                .font(.system(size: 10, weight: .semibold))
                                .lineLimit(2)
                                .minimumScaleFactor(0.8)
                        }
                        .foregroundColor(logStatusColor)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 6)
                        .background(logStatusColor.opacity(0.14))
                        .cornerRadius(8)
                    }
                    Text("Turn the Digital Crown to adjust.")
                        .font(.system(size: 9))
                        .foregroundColor(theme.textMuted)
                }
                .padding(10)
            }
        }
        .onAppear {
            // Seed pendingLbs once with the latest known weight so the user
            // lands at a sensible value rather than 170. Prefer the actual
            // last logged weight; fall back to the 7-day EMA when no
            // individual log is available yet. If neither is on hand at
            // appear time (snapshot may still be in flight from the phone),
            // the .onChange below catches up when it arrives.
            seedPendingFromSnapshotIfNeeded()
        }
        .onChange(of: conn.weight?.latestLbs) { _, _ in
            // The snapshot frequently arrives AFTER .onAppear fires (WCSession
            // delivery is asynchronous), which is why the dial used to stick
            // at 170 on first launch. Re-seed reactively the moment the
            // latest weight lands, exactly once.
            seedPendingFromSnapshotIfNeeded()
        }
        .onChange(of: conn.weight?.syncedAtMs ?? 0) { _, _ in
            confirmLogIfSnapshotMatches()
        }
    }

    private var logButtonTitle: String {
        switch logStatus {
        case .idle: return "Log"
        case .sent: return "Sent"
        case .queued: return "Queued"
        case .saved: return "Logged"
        }
    }

    private var logStatusMessage: String? {
        guard let lbs = lastSubmittedLbs else { return nil }
        switch logStatus {
        case .idle:
            return nil
        case .sent:
            return "Sent \(formatLbs(lbs)) to iPhone"
        case .queued:
            return "Queued \(formatLbs(lbs)); open iPhone to sync"
        case .saved:
            return "Logged \(formatLbs(lbs)) today"
        }
    }

    private var logStatusIcon: String {
        switch logStatus {
        case .saved: return "checkmark.circle.fill"
        case .queued: return "clock.fill"
        default: return "arrow.up.circle.fill"
        }
    }

    private var logStatusColor: Color {
        switch logStatus {
        case .saved: return theme.success
        case .queued: return theme.warning
        default: return theme.primary
        }
    }

    private func seedPendingFromSnapshotIfNeeded() {
        guard !seeded else { return }
        // Prefer the most recent logged weight; fall back to the EMA so we
        // still land near the user's real range when no individual log
        // exists yet (e.g. a fresh install with only HK-imported averages).
        if let latest = conn.weight?.latestLbs {
            pendingLbs = latest
            seeded = true
        } else if let ema = conn.weight?.emaLbs {
            pendingLbs = ema
            seeded = true
        }
    }

    private func submitWeightLog() {
        let lbs = roundedWeight(pendingLbs)
        lastSubmittedLbs = lbs
        logStatus = conn.isReachable ? .sent : .queued
        WKInterfaceDevice.current().play(.success)
        conn.sendCommand("log_weight", payload: ["lbs": lbs])
        scheduleLogStatusClear(after: conn.isReachable ? 8 : 12)
    }

    private func confirmLogIfSnapshotMatches() {
        guard let lbs = lastSubmittedLbs,
              let snapshot = conn.weight,
              snapshot.daysSinceLastLog == 0,
              let latest = snapshot.latestLbs,
              abs(latest - lbs) < 0.11
        else { return }
        logStatus = .saved
        scheduleLogStatusClear(after: 5)
    }

    private func scheduleLogStatusClear(after seconds: TimeInterval) {
        clearLogStatusItem?.cancel()
        let item = DispatchWorkItem {
            logStatus = .idle
            lastSubmittedLbs = nil
        }
        clearLogStatusItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
    }

    private func roundedWeight(_ value: Double) -> Double {
        (value * 10).rounded() / 10
    }

    private func formatLbs(_ value: Double) -> String {
        String(format: "%.1f lb", value)
    }
}

// ─── Speech-to-meal ─────────────────────────────────────────────────
//
// Flow:
//  1. User taps mic button on MealsView → sheet presents SpeechMealView
//  2. User types / dictates a description (watchOS TextField opens dictation)
//  3. Taps "Parse" → watch sends parse_meal_speech command to phone
//  4. Phone calls /ai/parse-meal-text → pushes mealParsePreview via WCSession
//  5. conn.pendingMealItems updates → view transitions to review list
//  6. User confirms → watch sends confirm_meal_speech with items to phone
//  7. Phone logs the meal and re-pushes meals; sheet auto-dismisses

private struct SpeechMealView: View {
    @Binding var isPresented: Bool
    @EnvironmentObject var conn: ConnectivityStore
    @EnvironmentObject var theme: ThemeStore

    @State private var transcript: String = ""
    @State private var isParsing: Bool = false
    @State private var didLog: Bool = false
    @State private var parseError: String?
    @State private var parseRequestId: UUID?
    @FocusState private var transcriptFieldFocused: Bool

    var body: some View {
        ZStack {
            theme.background.ignoresSafeArea()
            Group {
                if didLog {
                    doneView
                } else if let parseError {
                    errorView(parseError)
                } else if isParsing && (conn.pendingMealItems ?? []).isEmpty {
                    parsingView
                } else if let items = conn.pendingMealItems, !items.isEmpty {
                    reviewView(items)
                } else {
                    inputView
                }
            }
        }
        .onReceive(conn.$pendingMealItems) { items in
            if let items = items, !items.isEmpty, isParsing {
                isParsing = false
                parseRequestId = nil
            }
        }
        .onReceive(conn.$pendingMealParseError) { error in
            guard let error = error?.trimmingCharacters(in: .whitespacesAndNewlines), !error.isEmpty else { return }
            isParsing = false
            parseRequestId = nil
            parseError = error
        }
    }

    private var inputView: some View {
        VStack(spacing: 10) {
            Image(systemName: "mic.fill")
                .font(.system(size: 22))
                .foregroundColor(theme.primary)
            Text("Describe your meal")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(theme.textPrimary)
            TextField("e.g. 2 cups rice, 6 oz chicken", text: $transcript, axis: .vertical)
                .font(.system(size: 12))
                .foregroundColor(theme.textPrimary)
                .lineLimit(3...5)
                .padding(8)
                .background(theme.surface)
                .cornerRadius(8)
                .focused($transcriptFieldFocused)
                .onAppear {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        transcriptFieldFocused = true
                    }
                }
            Button {
                let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { return }
                WKInterfaceDevice.current().play(.click)
                isParsing = true
                parseError = nil
                let requestId = UUID()
                parseRequestId = requestId
                conn.pendingMealItems = nil
                conn.pendingMealParseError = nil
                conn.sendCommand("parse_meal_speech", payload: ["text": text])
                DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
                    if parseRequestId == requestId && isParsing {
                        isParsing = false
                        parseError = "Phone did not respond. Open Thallo on your iPhone, then try again."
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 11))
                    Text("Parse").fontWeight(.bold)
                }
                .foregroundColor(transcript.isEmpty ? theme.textMuted : theme.background)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(transcript.isEmpty ? theme.surface : theme.primary)
                .cornerRadius(9)
            }
            .buttonStyle(.plain)
            .disabled(transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(12)
    }

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 22))
                .foregroundColor(theme.warning)
            Text(message)
                .font(.system(size: 12))
                .foregroundColor(theme.textSecondary)
                .multilineTextAlignment(.center)
            Button {
                WKInterfaceDevice.current().play(.click)
                parseError = nil
                parseRequestId = nil
                conn.pendingMealParseError = nil
            } label: {
                Text("Try Again")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(theme.background)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(theme.primary)
                    .cornerRadius(9)
            }
            .buttonStyle(.plain)
        }
        .padding(12)
    }

    private var parsingView: some View {
        VStack(spacing: 10) {
            ProgressView()
                .tint(theme.primary)
            Text("Parsing…")
                .font(.system(size: 12))
                .foregroundColor(theme.textSecondary)
            if !transcript.isEmpty {
                Text(transcript)
                    .font(.system(size: 10))
                    .foregroundColor(theme.textMuted)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(12)
    }

    @ViewBuilder
    private func reviewView(_ items: [WatchMealParseItem]) -> some View {
        ScrollView {
            VStack(spacing: 8) {
                Text("REVIEW MEAL")
                    .font(.system(size: 10, weight: .heavy))
                    .tracking(1.2)
                    .foregroundColor(theme.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                ForEach(items) { item in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.name)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundColor(theme.textPrimary)
                            .lineLimit(2)
                        Text(item.serving)
                            .font(.system(size: 10))
                            .foregroundColor(theme.textMuted)
                        HStack(spacing: 6) {
                            Text("\(item.calories) cal")
                            Text("P \(item.protein)g")
                            Text("C \(item.carbs)g")
                            Text("F \(item.fat)g")
                        }
                        .font(.system(size: 9))
                        .foregroundColor(theme.textSecondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(theme.surface)
                    .cornerRadius(8)
                }
                Button {
                    WKInterfaceDevice.current().play(.success)
                    conn.sendCommand("confirm_meal_speech", payload: [
                        "items": items.map { item in
                            [
                                "name": item.name,
                                "serving": item.serving,
                                "calories": item.calories,
                                "protein": item.protein,
                                "carbs": item.carbs,
                                "fat": item.fat,
                            ] as [String: Any]
                        },
                    ])
                    conn.pendingMealItems = nil
                    didLog = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                        isPresented = false
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 12))
                        Text("Log Meal").fontWeight(.bold)
                    }
                    .foregroundColor(theme.background)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(theme.success)
                    .cornerRadius(9)
                }
                .buttonStyle(.plain)
                Button {
                    conn.pendingMealItems = nil
                    conn.pendingMealParseError = nil
                    parseRequestId = nil
                    isPresented = false
                } label: {
                    Text("Cancel")
                        .font(.system(size: 11))
                        .foregroundColor(theme.textSecondary)
                }
                .buttonStyle(.plain)
            }
            .padding(12)
        }
    }

    private var doneView: some View {
        VStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 32))
                .foregroundColor(theme.success)
            Text("Logged!")
                .font(.system(size: 16, weight: .bold))
                .foregroundColor(theme.textPrimary)
        }
    }
}
