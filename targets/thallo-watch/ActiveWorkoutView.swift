// Active workout screen — standalone. The watch owns the flow state
// (current exercise, current set, rest countdown) so users can run
// a full session from the wrist without touching the phone. Every
// logged set fires a command to the phone so its history stays in
// sync, but the watch doesn't WAIT for the phone to advance.
//
// Layout: TabView with two pages (swipe left/right):
//   • EXERCISE — current slot, set counter, Crown-driven weight +
//                reps inputs, Log Set button, rest timer, up-next
//                preview during rest.
//   • HEART    — live bpm + zone.
//
// End workout tells the phone to finalize. The watch does not block
// workout tracking on a HealthKit session; set logging stays local-first.

import SwiftUI
import Combine
import WatchKit
import Foundation

// ─── Flow state owned by the watch ─────────────────────────────────

final class ActiveWorkoutState: ObservableObject {
    @Published var exerciseIndex: Int = 0 { didSet { persist() } }
    @Published var setNumber: Int = 1 { didSet { persist() } }   // 1-indexed within the current exercise
    @Published var restRemaining: Int? = nil { didSet { persist() } }   // seconds; nil = not resting
    @Published var paused: Bool = false { didSet { persist() } }
    private var restEndAtMs: Double? = nil { didSet { persist() } }
    private var sessionId: String? = nil { didSet { persist() } }
    private var lastProgressRevision: Double = 0 { didSet { persist() } }
    // Log-set inputs. Seeded from the exercise's planned target on
    // entry so a first-time user already has a reasonable number.
    @Published var pendingWeight: Double = 0 { didSet { persist() } }
    @Published var pendingReps: Int = 0 { didSet { persist() } }
    // Cache of per-set logs so the user can see "last set: 135×8"
    // when dialing in the next set's weight.
    @Published var lastLoggedWeight: Double? = nil { didSet { persist() } }
    @Published var lastLoggedReps: Int? = nil { didSet { persist() } }
    @Published var currentRecommendation: String? = nil { didSet { persist() } }

    private var cancellables: Set<AnyCancellable> = []
    // Defaults key — persists across watch-app background / kill so
    // users mid-workout don't lose their place when iOS reclaims
    // memory or they background to glance at a notification.
    private static let kPersistKey = "thallo.activeWorkoutState"
    private var hydrating = false

    init() {
        hydrate()
        if let latest = ConnectivityStore.shared.latestProgress {
            var info: [AnyHashable: Any] = [:]
            for (key, value) in latest {
                info[AnyHashable(key)] = value
            }
            applyProgress(info)
        }
        // Still listen to phone progress pushes so if a user logs
        // a set on the phone the watch advances too.
        NotificationCenter.default.publisher(for: .watchProgressUpdate)
            .sink { [weak self] note in
                guard let self, let info = note.userInfo else { return }
                self.applyProgress(info)
            }
            .store(in: &cancellables)
    }

    /// Persist the in-memory flow state to UserDefaults. Called
    /// implicitly by every `@Published` setter via `didSet`. We
    /// intentionally serialise the whole struct on each change rather
    /// than diffing — the payload is tiny (~80 bytes) and watchOS
    /// background terminations can happen between any two writes.
    private func persist() {
        if hydrating { return }
        var blob: [String: Any] = [
            "exerciseIndex": exerciseIndex,
            "setNumber": setNumber,
            "paused": paused,
            "pendingWeight": pendingWeight,
            "pendingReps": pendingReps,
        ]
        if let restRemaining { blob["restRemaining"] = restRemaining }
        if let restEndAtMs { blob["restEndAtMs"] = restEndAtMs }
        if let sessionId { blob["sessionId"] = sessionId }
        if lastProgressRevision > 0 { blob["lastProgressRevision"] = lastProgressRevision }
        if let lastLoggedWeight { blob["lastLoggedWeight"] = lastLoggedWeight }
        if let lastLoggedReps { blob["lastLoggedReps"] = lastLoggedReps }
        if let currentRecommendation { blob["currentRecommendation"] = currentRecommendation }
        UserDefaults.standard.set(blob, forKey: Self.kPersistKey)
    }

    private func hydrate() {
        guard let blob = UserDefaults.standard.dictionary(forKey: Self.kPersistKey) else { return }
        hydrating = true
        if let v = blob["exerciseIndex"] as? Int { exerciseIndex = v }
        if let v = blob["setNumber"] as? Int { setNumber = v }
        if let v = blob["restRemaining"] as? Int { restRemaining = v }
        if let v = blob["restEndAtMs"] as? Double { restEndAtMs = v }
        if let v = blob["sessionId"] as? String { sessionId = v }
        if let v = Self.flexibleDouble(blob["lastProgressRevision"]) { lastProgressRevision = v }
        if let v = blob["paused"] as? Bool { paused = v }
        if let v = blob["pendingWeight"] as? Double { pendingWeight = v }
        if let v = blob["pendingReps"] as? Int { pendingReps = v }
        if let v = blob["lastLoggedWeight"] as? Double { lastLoggedWeight = v }
        if let v = blob["lastLoggedReps"] as? Int { lastLoggedReps = v }
        if let v = blob["currentRecommendation"] as? String { currentRecommendation = v }
        reconcileRestClock()
        hydrating = false
    }

    /// Wipe persisted state — call on workout end / cancel so the
    /// next workout starts from a clean slate.
    func clearPersisted() {
        currentRecommendation = nil
        Self.clearPersistedStore()
    }

    static func clearPersistedStore() {
        UserDefaults.standard.removeObject(forKey: Self.kPersistKey)
    }

    func attach(to workout: WatchWorkout) {
        let nextSessionId = workout.sessionId ?? "\(workout.dateISO)|\(workout.focus)"
        if paused {
            paused = false
        }
        if let sessionId, sessionId != nextSessionId {
            resetForSession(nextSessionId)
        } else if sessionId == nil {
            if hasNonDefaultState {
                resetForSession(nextSessionId)
            } else {
                self.sessionId = nextSessionId
            }
        }
        if !workout.exercises.indices.contains(exerciseIndex) {
            exerciseIndex = 0
            setNumber = 1
            clearRest()
        } else {
            let maxSets = max(1, workout.exercises[exerciseIndex].sets)
            setNumber = min(max(1, setNumber), maxSets)
        }
        reconcileRestClock()
    }

    private var hasNonDefaultState: Bool {
        exerciseIndex != 0
        || setNumber != 1
        || restRemaining != nil
        || paused
        || pendingWeight != 0
        || pendingReps != 0
        || lastLoggedWeight != nil
        || lastLoggedReps != nil
        || currentRecommendation != nil
    }

    private func acceptProgress(_ info: [AnyHashable: Any]) -> Bool {
        if let incomingSessionId = info["sessionId"] as? String,
           !incomingSessionId.isEmpty {
            if let currentSessionId = sessionId, !currentSessionId.isEmpty {
                if incomingSessionId != currentSessionId {
                    HeartRateStore.saveDiag("progress stale session rejected")
                    return false
                }
            } else {
                sessionId = incomingSessionId
            }
        }
        guard let revision = Self.flexibleDouble(info["progressRevision"]) else {
            return true
        }
        if revision <= lastProgressRevision {
            HeartRateStore.saveDiag("progress stale rejected rev=\(Int(revision)) last=\(Int(lastProgressRevision))")
            return false
        }
        lastProgressRevision = revision
        return true
    }

    private func applyProgress(_ info: [AnyHashable: Any]) {
        guard acceptProgress(info) else { return }
        if let idx = info["exerciseIndex"] as? Int {
            if idx != exerciseIndex {
                currentRecommendation = nil
            }
            exerciseIndex = idx
        }
        if let setN = Self.flexibleInt(info["setNumber"]) { setNumber = setN }
        if let rest = Self.flexibleInt(info["restRemainingSec"]) {
            let endAt = Self.flexibleDouble(info["restEndsAtMs"])
            setRest(seconds: rest, endAtMs: endAt)
        } else if info.keys.contains("restRemainingSec") {
            clearRest()
        }
        if let rec = info["recommendation"] as? String {
            currentRecommendation = rec
        } else if info.keys.contains("recommendation") {
            currentRecommendation = nil
        }
    }

    private func resetForSession(_ nextSessionId: String) {
        exerciseIndex = 0
        setNumber = 1
        clearRest()
        pendingWeight = 0
        pendingReps = 0
        lastLoggedWeight = nil
        lastLoggedReps = nil
        currentRecommendation = nil
        sessionId = nextSessionId
    }

    func setRest(seconds: Int?, endAtMs: Double? = nil) {
        guard let seconds, seconds > 0 else {
            clearRest()
            return
        }
        let endAt = endAtMs ?? (Self.nowMs() + Double(seconds) * 1000)
        restEndAtMs = endAt
        restRemaining = max(0, Int(ceil((endAt - Self.nowMs()) / 1000)))
        paused = false
    }

    func clearRest() {
        restRemaining = nil
        restEndAtMs = nil
        paused = false
    }

    func reconcileRestClock(playHaptic: Bool = false) {
        guard !paused, let endAt = restEndAtMs else { return }
        let previous = restRemaining ?? 0
        let next = max(0, Int(ceil((endAt - Self.nowMs()) / 1000)))
        restRemaining = next
        if next == 0 {
            restEndAtMs = nil
            if previous > 0, playHaptic {
                WKInterfaceDevice.current().play(.notification)
            }
        }
    }

    private static func nowMs() -> Double {
        Date().timeIntervalSince1970 * 1000
    }

    private static func flexibleInt(_ value: Any?) -> Int? {
        if let v = value as? Int { return v }
        if let v = value as? Double, v.isFinite { return Int(v.rounded()) }
        if let v = value as? NSNumber { return v.intValue }
        if let v = value as? String { return Int(v.trimmingCharacters(in: .whitespacesAndNewlines)) }
        return nil
    }

    private static func flexibleDouble(_ value: Any?) -> Double? {
        if let v = value as? Double, v.isFinite { return v }
        if let v = value as? Int { return Double(v) }
        if let v = value as? NSNumber { return v.doubleValue }
        if let v = value as? String { return Double(v.trimmingCharacters(in: .whitespacesAndNewlines)) }
        return nil
    }

    /// Prime the weight / reps inputs for the current exercise.
    /// Called when advancing to a new exercise so the user doesn't
    /// have to dial from zero.
    func seed(for ex: WatchExercise) {
        let timed = ex.isTimed == true || ex.plannedDurationSeconds != nil
        if pendingWeight == 0, ex.isGuide != true, !timed, let w = ex.plannedTargetWeightLbs {
            pendingWeight = w
        }
        if timed {
            pendingReps = 0
        } else if pendingReps == 0 {
            // Parse "5-8" → 6, "8" → 8, "30s" → 30, fall back to 8.
            let s = ex.reps.lowercased()
            let clean = s.replacingOccurrences(of: "s", with: "")
            if let dash = clean.firstIndex(of: "-") {
                let lo = Int(clean[clean.startIndex..<dash].trimmingCharacters(in: .whitespaces)) ?? 8
                let hi = Int(clean[clean.index(after: dash)...].trimmingCharacters(in: .whitespaces)) ?? lo
                pendingReps = (lo + hi) / 2
            } else {
                pendingReps = Int(clean.trimmingCharacters(in: .whitespaces)) ?? 8
            }
        }
    }

    // ─── Rest countdown (watch-owned) ─────────────────────────────

    private var timer: AnyCancellable?
    func startTick() {
        timer?.cancel()
        timer = Timer.publish(every: 1, on: .main, in: .common)
            .autoconnect()
            .sink { [weak self] _ in
                guard let self, !self.paused else { return }
                self.reconcileRestClock(playHaptic: true)
            }
    }
    func stopTick() { timer?.cancel(); timer = nil }
}

// ─── Root ──────────────────────────────────────────────────────────

struct ActiveWorkoutView: View {
    let workout: WatchWorkout
    @ObservedObject var hr: HeartRateStore
    let onEndWorkout: () -> Void
    let onCancelWorkout: () -> Void

    @EnvironmentObject var theme: ThemeStore
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var state = ActiveWorkoutState()
    @State private var showCountdown: Bool
    @State private var lastExerciseName: String? = nil

    private static let countdownConsumedSessionKey = "thallo.activeWorkoutCountdownSessionId"

    init(
        workout: WatchWorkout,
        hr: HeartRateStore,
        playStartCountdown: Bool = false,
        onEndWorkout: @escaping () -> Void,
        onCancelWorkout: @escaping () -> Void
    ) {
        self.workout = workout
        self.hr = hr
        self.onEndWorkout = onEndWorkout
        self.onCancelWorkout = onCancelWorkout
        let sessionId = workout.sessionId ?? ""
        let alreadyPlayed = !sessionId.isEmpty &&
            UserDefaults.standard.string(forKey: Self.countdownConsumedSessionKey) == sessionId
        _showCountdown = State(initialValue: playStartCountdown && !alreadyPlayed)
    }

    var body: some View {
        ZStack {
            TabView {
                ExerciseTab(
                    workout: workout,
                    state: state,
                    hr: hr,
                    onEndWorkout: {
                        state.clearPersisted()
                        onEndWorkout()
                    },
                    onCancelWorkout: {
                        state.clearPersisted()
                        onCancelWorkout()
                    },
                )
                HeartRateTab(hr: hr)
            }
            .tabViewStyle(.page)
            if showCountdown {
                StartCountdownOverlay(onComplete: {
                    // Fade the overlay out — withAnimation lets the
                    // opacity transition inside the overlay run before
                    // the view is removed.
                    withAnimation(.easeOut(duration: 0.25)) {
                        showCountdown = false
                    }
                })
                .transition(.opacity)
            }
        }
        .onAppear {
            HeartRateStore.saveDiag("ActiveView.onAppear")
            hr.setZones(workout.hrZones)
            if showCountdown, let sessionId = workout.sessionId, !sessionId.isEmpty {
                UserDefaults.standard.set(sessionId, forKey: Self.countdownConsumedSessionKey)
            }
            state.attach(to: workout)
            state.startTick()
            seedCurrentExerciseIfNeeded()
        }
        .onChange(of: workout.sessionId) { _, _ in
            state.attach(to: workout)
            seedCurrentExerciseIfNeeded()
        }
        .onChange(of: workout.hrZones) { _, zones in
            hr.setZones(zones)
        }
        .onChange(of: workout.exercises) { _, _ in seedCurrentExerciseIfNeeded() }
        .onChange(of: state.exerciseIndex) { _, _ in seedCurrentExerciseIfNeeded() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                state.reconcileRestClock()
            }
        }
        .onDisappear { state.stopTick() }
    }

    private func seedCurrentExerciseIfNeeded() {
        guard !workout.exercises.isEmpty else { return }
        if !workout.exercises.indices.contains(state.exerciseIndex) {
            state.exerciseIndex = 0
            state.setNumber = 1
            state.clearRest()
            state.pendingWeight = 0
            state.pendingReps = 0
            state.lastLoggedWeight = nil
            state.lastLoggedReps = nil
            state.currentRecommendation = nil
        }
        if workout.exercises.indices.contains(state.exerciseIndex) {
            let ex = workout.exercises[state.exerciseIndex]
            state.setNumber = min(max(1, state.setNumber), max(1, ex.sets))
            if let lastExerciseName, lastExerciseName != ex.name {
                state.pendingWeight = 0
                state.pendingReps = 0
                state.lastLoggedWeight = nil
                state.lastLoggedReps = nil
                state.currentRecommendation = nil
            }
            lastExerciseName = ex.name
            state.seed(for: ex)
        }
    }
}

// ─── Start countdown overlay ───────────────────────────────────────

/// 3-2-1-go intro shown when the active workout view first mounts.
/// Only plays for a workout that was started from the watch itself;
/// phone-originated starts open this view directly without trying to
/// sync the animation across devices.
private struct StartCountdownOverlay: View {
    let onComplete: () -> Void
    @EnvironmentObject var theme: ThemeStore

    // Ticks match the phone side's cadence: 3 / 2 / 1 at 700ms each,
    // resolved by the motivational phrase for 1100ms.
    //
    // ⚠️ Keep this pool in sync with `src/constants/startPhrases.ts`.
    // Swift + TS don't share modules so the list is duplicated by
    // hand — the header comment in the TS file calls this out too.
    private static let phrases = [
        "LET'S GO!", "LIGHTS OUT.", "LOCK IN.", "SHOW UP.", "EARN IT.",
        "GAME TIME.", "DIG IN.", "RISE UP.", "YOUR MOVE.", "MAKE IT COUNT.",
        "NO EXCUSES.", "LEAVE IT ALL.", "BEAST MODE.", "FULL SEND.", "STAY HUNGRY.",
        "GRIND ON.", "BREAK LIMITS.", "OWN IT.", "ATTACK.", "NO MERCY.",
        "DOMINATE.", "FOCUS UP.", "LEVEL UP.", "WORK.", "PUSH HARDER.",
        "HEART IN.", "BRING HEAT.", "GO TIME.", "CLAIM IT.", "NO QUIT.",
        "OUTWORK.", "SEND IT.", "WAR MODE.", "NEXT REP.", "UNLEASH.",
        "RAW POWER.", "STAY SHARP.", "BE RUTHLESS.", "ALL IN.", "TRUST IT.",
        "TUNE IN.", "DRIVE.", "KEEP GOING.", "EVERY REP.", "EARN TODAY.",
        "FUEL UP.", "OUTLAST.", "WIN REPS.", "CRUSH IT.", "OWN THE HOUR.",
        "LIGHT IT UP.", "KEEP PUSHING.", "SWEAT NOW.", "NO OFF DAYS.", "RAISE THE BAR.",
        "HEAD DOWN.", "CHIN UP.", "STAY STRONG.", "HOLD THE LINE.", "OUTGRIND.",
        "FIRE UP.", "BE THE WORK.", "NO COMFORT.", "HUSTLE.", "SAVAGE.",
        "GO BIG.", "ONE MORE.", "EFFORT FIRST.", "BEAT YESTERDAY.", "MAKE MOVES.",
        "PROVE IT.", "STACK WINS.", "MOVE WEIGHT.", "BUILD IT.", "OWN THE DAY.",
        "DIAL IN.", "RAISE HELL.", "UNBROKEN.", "BURN IT.", "SET PACE.",
        "SPARK UP.", "GO HEAVIER.", "NO STEP BACK.", "PRIDE ON.", "NOTHING EASY.",
        "FORGE ON.", "RUN IT UP.", "WORK SPEAKS.", "KEEP EDGE.", "BREAKTHROUGH.",
        "HEAT CHECK.", "GO AGAIN.", "FULL BORE.", "GAME ON.", "DO THE WORK.",
        "REP FOR REP.", "RISE TO IT.", "MAKE THEM LOOK.", "STRONGER TODAY.",
        "FINISH STRONG.", "NO BLINKING.",
    ]
    private static let ticks: [(label: String, ms: Int, isFinal: Bool)] = [
        ("3", 700, false),
        ("2", 700, false),
        ("1", 700, false),
        (phrases.randomElement() ?? "LET'S GO!", 1100, true),
    ]

    @State private var idx: Int = 0
    @State private var scale: CGFloat = 1.35
    @State private var opacity: Double = 0

    var body: some View {
        let tick = Self.ticks[min(idx, Self.ticks.count - 1)]
        ZStack {
            // Near-opaque themed backdrop so the underlying workout
            // view doesn't leak through mid-animation.
            theme.background.opacity(0.95).ignoresSafeArea()
            // Coloured halo — matches the phone version's ring behind
            // the numeral. Same primary @ 10% fill + 33% border.
            Circle()
                .fill(theme.primary.opacity(0.1))
                .overlay(
                    Circle().stroke(theme.primary.opacity(0.33), lineWidth: 2)
                )
                .frame(width: 140, height: 140)
            VStack(spacing: 6) {
                Text(tick.label)
                    // Final phrase starts at 20pt (smaller than the
                    // 70pt digit) so even long strings like
                    // "MAKE IT COUNT." fit inside the 140pt halo.
                    // minimumScaleFactor lets it shrink further as
                    // needed. frame(maxWidth:) clamps to halo diameter.
                    .font(.system(size: tick.isFinal ? 20 : 70, weight: .black, design: .rounded))
                    .foregroundColor(theme.primary)
                    .minimumScaleFactor(0.4)
                    .lineLimit(1)
                    .frame(maxWidth: 124)
                    .scaleEffect(scale)
                    .opacity(opacity)
                if !tick.isFinal {
                    Text("STARTING")
                        .font(.system(size: 8, weight: .heavy))
                        .tracking(1.4)
                        .foregroundColor(theme.textMuted)
                        .opacity(opacity)
                }
            }
        }
        .onAppear { playTick() }
    }

    private func playTick() {
        guard idx < Self.ticks.count else {
            onComplete()
            return
        }
        let tick = Self.ticks[idx]
        // Light haptic on counts, success on the final go-word — the
        // watch's taptic engine separates these clearly.
        WKInterfaceDevice.current().play(tick.isFinal ? .success : .click)
        scale = 1.35
        opacity = 0
        withAnimation(.easeOut(duration: 0.18)) {
            scale = 1.0
            opacity = 1
        }
        let ms = tick.ms
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms - 220)) {
            withAnimation(.easeIn(duration: 0.2)) {
                opacity = 0
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms)) {
            idx += 1
            playTick()
        }
    }
}

// ─── Exercise tab ──────────────────────────────────────────────────

private struct WatchPendingRirLog {
    let exerciseIndex: Int
    let setNumber: Int
    let weightLbs: Double
    let reps: Int
}

private func hrZoneColor(_ zone: Int?) -> Color {
    switch zone {
    case 1: return Color(hex: "#38BDF8")
    case 2: return Color(hex: "#22C55E")
    case 3: return Color(hex: "#EAB308")
    case 4: return Color(hex: "#F97316")
    case 5: return Color(hex: "#EF4444")
    default: return Color(hex: "#38BDF8")
    }
}

private struct ExerciseTab: View {
    let workout: WatchWorkout
    @ObservedObject var state: ActiveWorkoutState
    @ObservedObject var hr: HeartRateStore
    let onEndWorkout: () -> Void
    let onCancelWorkout: () -> Void

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var conn: ConnectivityStore

    // Digital-crown focus flags. Only one receives Crown input at a
    // time; tapping the label swaps focus so the user can switch
    // between weight and reps without buttons.
    @State private var crownTarget: CrownTarget = .weight
    @State private var showMenu: Bool = false
    @State private var showSwapSheet: Bool = false
    @State private var pendingSwapName: String? = nil
    @State private var pendingRirLog: WatchPendingRirLog? = nil

    enum CrownTarget { case weight, reps }

    var currentExercise: WatchExercise? {
        workout.exercises.indices.contains(state.exerciseIndex)
            ? workout.exercises[state.exerciseIndex] : nil
    }

    var nextExercise: WatchExercise? {
        let idx = state.exerciseIndex + 1
        return workout.exercises.indices.contains(idx)
            ? workout.exercises[idx] : nil
    }

    var isLastSet: Bool {
        guard let ex = currentExercise else { return false }
        return state.setNumber >= ex.sets
    }

    private func displaySetNumber(for ex: WatchExercise) -> Int {
        min(max(1, state.setNumber), max(1, ex.sets))
    }

    private func isGuideExercise(_ ex: WatchExercise) -> Bool {
        if ex.isGuide == true { return true }
        let name = ex.name.lowercased()
        let role = (ex.slotRole ?? "").lowercased()
        if ["mobility", "recovery", "stretch", "cooldown"].contains(role) { return true }
        return name.range(
            of: "stretch|foam.?roll|cat.?cow|pigeon|child.?s pose|spinal.?twist|world.?s greatest|90.?90|thoracic|downward.?dog|cobra|butterfly|savasana|yoga|vinyasa|yin|flow|mobility|pose\\b|breathwork|breathing|meditation",
            options: .regularExpression
        ) != nil
    }

    private func isTimedExercise(_ ex: WatchExercise) -> Bool {
        if ex.isTimed == true { return true }
        if ex.isTimed == false { return false }
        return plannedDurationSeconds(for: ex) != nil
    }

    private func durationTargetText(for ex: WatchExercise) -> String {
        if let seconds = plannedDurationSeconds(for: ex) {
            return formatTime(seconds)
        }
        let raw = ex.reps.trimmingCharacters(in: .whitespacesAndNewlines)
        return raw.isEmpty ? "Timed" : raw
    }

    private func setTargetText(for ex: WatchExercise) -> String {
        isTimedExercise(ex) ? durationTargetText(for: ex) : ex.reps
    }

    private func targetRepMax(_ raw: String) -> Int? {
        let regex = try? NSRegularExpression(pattern: "\\d+")
        let nsRange = NSRange(raw.startIndex..<raw.endIndex, in: raw)
        let values = regex?.matches(in: raw, range: nsRange).compactMap { match -> Int? in
            guard let range = Range(match.range, in: raw) else { return nil }
            return Int(raw[range])
        } ?? []
        guard let first = values.first else { return nil }
        let hasRange = raw.range(of: "\\d+\\s*[-–—]\\s*\\d+", options: .regularExpression) != nil
        return hasRange && values.count >= 2 ? values[1] : first
    }

    private func shouldPromptRir(actualReps: Int, targetReps: String) -> Bool {
        guard actualReps > 0, let maxReps = targetRepMax(targetReps) else { return false }
        return actualReps >= maxReps + 2
    }

    var isLastExercise: Bool {
        state.exerciseIndex >= workout.exercises.count - 1
    }

    // Small HR chip color mirrors the HR tab's zone palette so the two
    // views read consistently. Falls back to muted when no zone yet.
    var hrChipColor: Color {
        hrZoneColor(hr.zone)
    }

    @State private var warmupDismissed: Bool = false

    var body: some View {
        ZStack {
            theme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    // Warm-up card — only shown before the first set of
                    // the first exercise. Once the user taps "Start" it
                    // collapses and won't reappear during this session.
                    if !warmupDismissed,
                       let steps = workout.warmupSteps, !steps.isEmpty,
                       state.exerciseIndex == 0, state.setNumber == 1 {
                        warmupCard(steps: steps)
                    }
                    if let ex = currentExercise {
                        header(ex)
                        // Either the rest timer OR the set input
                        // panel — never both; less visual noise.
                        if let rest = state.restRemaining, rest > 0 {
                            restCard(rest: rest)
                        } else {
                            logSetCard(ex)
                        }
                        footer()
                    } else if workout.exercises.isEmpty {
                        // Placeholder / empty-shell workout — keep the
                        // screen ALIVE with live HR + timer so watchOS
                        // doesn't background the app during the first
                        // few seconds while HKWorkoutSession spins up
                        // and the phone push lands. Without this, an
                        // empty-exercises shell rendered "Workout done"
                        // immediately and watchOS pre-empted the app
                        // (the "watch closes on Start" bug).
                        VStack(alignment: .leading, spacing: 8) {
                            Text(workout.focus.uppercased())
                                .font(.system(size: 11, weight: .heavy))
                                .tracking(1.2)
                                .foregroundColor(theme.textMuted)
                            HStack(spacing: 6) {
                                Image(systemName: "heart.fill")
                                    .foregroundColor(theme.error)
                                    .font(.system(size: 14))
                                Text(hr.heartRate.map { "\($0)" } ?? "—")
                                    .font(.system(size: 36, weight: .black, design: .rounded))
                                    .foregroundColor(theme.textPrimary)
                                Text("BPM")
                                    .font(.system(size: 9, weight: .heavy))
                                    .foregroundColor(theme.textMuted)
                            }
                            Text("Loading workout from phone…")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundColor(theme.textSecondary)
                            if let err = hr.errorMessage {
                                Text("HR: \(err)")
                                    .font(.system(size: 10))
                                    .foregroundColor(theme.warning)
                                    .lineLimit(3)
                            }
                            Text(hr.running ? "HR session active" : "Starting HR session…")
                                .font(.system(size: 10))
                                .foregroundColor(hr.running ? theme.success : theme.textMuted)
                        }
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(theme.surface)
                        .cornerRadius(8)
                    } else {
                        Text("Workout done")
                            .font(.headline)
                            .foregroundColor(theme.textPrimary)
                    }
                }
                .padding(10)
            }
        }
        .confirmationDialog("Exercise options", isPresented: $showMenu) {
            if let ex = currentExercise, !ex.swapOptions.isEmpty {
                Button("Swap exercise") { showSwapSheet = true }
            }
            Button("Skip exercise", role: .destructive) { advanceExercise() }
            Button("Cancel", role: .cancel) {}
        }
        .sheet(isPresented: $showSwapSheet) {
            if let ex = currentExercise {
                SwapExerciseSheet(
                    exercise: ex,
                    pendingName: pendingSwapName,
                    onSelect: requestSwap,
                )
            }
        }
        .onChange(of: currentExercise?.name) { _, newName in
            if pendingSwapName == newName {
                pendingSwapName = nil
            }
            pendingRirLog = nil
        }
    }

    @ViewBuilder
    private func warmupCard(steps: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "flame.fill")
                    .font(.system(size: 10))
                    .foregroundColor(theme.primary)
                Text("WARM-UP")
                    .font(.system(size: 9, weight: .heavy))
                    .tracking(1.2)
                    .foregroundColor(theme.primary)
                Spacer()
            }
            ForEach(Array(steps.prefix(5).enumerated()), id: \.offset) { _, step in
                Text("• \(step)")
                    .font(.system(size: 11))
                    .foregroundColor(theme.textSecondary)
                    .lineLimit(3)
            }
            Button {
                WKInterfaceDevice.current().play(.click)
                withAnimation(.easeOut(duration: 0.22)) { warmupDismissed = true }
            } label: {
                Text("Start lifts")
                    .font(.system(size: 12, weight: .bold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(theme.primary)
                    .foregroundColor(theme.background)
                    .cornerRadius(9)
            }
            .buttonStyle(.plain)
            .padding(.top, 4)
        }
        .padding(10)
        .background(theme.surface)
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(theme.primary.opacity(0.5), lineWidth: 1),
        )
        .cornerRadius(12)
    }

    private func header(_ ex: WatchExercise) -> some View {
        let timed = isTimedExercise(ex)
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Text("EXERCISE \(state.exerciseIndex + 1) / \(workout.exercises.count)")
                    .font(.system(size: 9, weight: .bold))
                    .tracking(1)
                    .foregroundColor(theme.textMuted)
                if let role = ex.slotRole, !role.isEmpty, role != "primary" {
                    Text(role.uppercased())
                        .font(.system(size: 8, weight: .heavy))
                        .tracking(0.6)
                        .foregroundColor(theme.warning)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(theme.warning.opacity(0.15))
                        .cornerRadius(4)
                }
                Spacer(minLength: 0)
                // Persistent HR chip — always visible while a reading
                // exists so users don't have to swipe to the HR tab
                // just to glance at their bpm mid-set.
                if let bpm = hr.heartRate {
                    HStack(spacing: 3) {
                        Image(systemName: "heart.fill")
                            .font(.system(size: 8))
                        Text(hr.zone.map { "Z\($0) \(bpm)" } ?? "\(bpm)")
                            .font(.system(size: 11, weight: .heavy, design: .rounded))
                    }
                    .foregroundColor(hrChipColor)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(hrChipColor.opacity(0.15))
                    .cornerRadius(5)
                }
            }
            // Long-press opens the skip/swap menu — can't add swap
            // yet without a library sync to the watch, but skip is
            // the most-requested escape hatch.
            Text(ex.name)
                .font(.system(size: 17, weight: .heavy))
                .foregroundColor(theme.textPrimary)
                .lineLimit(2)
                .onLongPressGesture { showMenu = true }
            HStack(spacing: 4) {
                Text(timed ? (ex.sets > 1 ? "ROUND" : "TIME") : "SET")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(theme.textMuted)
                Text("\(displaySetNumber(for: ex)) of \(ex.sets)")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(theme.textPrimary)
                Text("·")
                    .foregroundColor(theme.textMuted)
                Text(setTargetText(for: ex))
                    .font(.system(size: 12))
                    .foregroundColor(theme.textSecondary)
                if state.paused {
                    Text("PAUSED")
                        .font(.system(size: 9, weight: .heavy))
                        .foregroundColor(theme.warning)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(theme.warning.opacity(0.15))
                        .cornerRadius(4)
                }
            }
            if !isGuideExercise(ex), !timed, let rec = (state.currentRecommendation ?? ex.recommendation) {
                Text(rec)
                    .font(.system(size: 11))
                    .foregroundColor(theme.primary)
                    .lineLimit(2)
            }
            if !isGuideExercise(ex), !timed, let lw = state.lastLoggedWeight, let lr = state.lastLoggedReps {
                Text("Last: \(Int(lw)) lb × \(lr)")
                    .font(.system(size: 10))
                    .foregroundColor(theme.textMuted)
            }
            if let pendingSwapName {
                Text("Swapping to \(pendingSwapName)…")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(theme.warning)
                    .lineLimit(1)
            }
        }
    }

    // ─── Log-set card (Crown → weight or reps) ─────────────────────

    @ViewBuilder
    private func logSetCard(_ ex: WatchExercise) -> some View {
        if isGuideExercise(ex) {
            guideSetCard(ex)
        } else if isTimedExercise(ex) {
            timedSetCard(ex)
        } else if let pending = pendingRirLog,
                  pending.exerciseIndex == state.exerciseIndex,
                  pending.setNumber == displaySetNumber(for: ex) {
            rirPromptCard(pending)
        } else {
            VStack(alignment: .leading, spacing: 10) {
                recommendedWeightRow(ex)
                // Weight row — pill + stepper buttons. Stepper gives the
                // user an obvious way to change the number without having
                // to know the Digital Crown is the input device. Crown
                // still works when the pill is focused.
                HStack(spacing: 4) {
                    Button {
                        state.pendingWeight = max(0, state.pendingWeight - 5)
                        WKInterfaceDevice.current().play(.click)
                    } label: {
                        Text("−").font(.system(size: 22, weight: .black))
                            .frame(width: 34, height: 34)
                            .background(theme.surfaceRaised)
                            .cornerRadius(8)
                            .foregroundColor(theme.textPrimary)
                    }
                    .buttonStyle(.plain)
                    crownPill("Weight", value: "\(Int(state.pendingWeight)) lb", active: crownTarget == .weight) {
                        crownTarget = .weight
                    }
                    Button {
                        state.pendingWeight = state.pendingWeight + 5
                        WKInterfaceDevice.current().play(.click)
                    } label: {
                        Text("+").font(.system(size: 22, weight: .black))
                            .frame(width: 34, height: 34)
                            .background(theme.surfaceRaised)
                            .cornerRadius(8)
                            .foregroundColor(theme.textPrimary)
                    }
                    .buttonStyle(.plain)
                }
                HStack(spacing: 4) {
                    Button {
                        state.pendingReps = max(0, state.pendingReps - 1)
                        WKInterfaceDevice.current().play(.click)
                    } label: {
                        Text("−").font(.system(size: 22, weight: .black))
                            .frame(width: 34, height: 34)
                            .background(theme.surfaceRaised)
                            .cornerRadius(8)
                            .foregroundColor(theme.textPrimary)
                    }
                    .buttonStyle(.plain)
                    crownPill("Reps", value: "\(state.pendingReps)", active: crownTarget == .reps) {
                        crownTarget = .reps
                    }
                    Button {
                        state.pendingReps = state.pendingReps + 1
                        WKInterfaceDevice.current().play(.click)
                    } label: {
                        Text("+").font(.system(size: 22, weight: .black))
                            .frame(width: 34, height: 34)
                            .background(theme.surfaceRaised)
                            .cornerRadius(8)
                            .foregroundColor(theme.textPrimary)
                    }
                    .buttonStyle(.plain)
                }
                Text("Tap a field then turn the Digital Crown, or use −/+")
                    .font(.system(size: 9))
                    .foregroundColor(theme.textMuted)
                    .lineLimit(2)
                Button(action: logSet) {
                    HStack {
                        Image(systemName: "checkmark.circle.fill")
                        Text(isLastSet ? "Log & next exercise" : "Log set")
                            .fontWeight(.bold)
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .padding(.vertical, 9)
                .background(theme.primary)
                .foregroundColor(theme.background)
                .cornerRadius(10)
            }
            .padding(10)
            .background(theme.surface)
            .cornerRadius(12)
            // Bind Crown to whichever input is active. Weight moves in
            // 2.5 lb increments (dumbbell granularity); reps in 1.
            .focusable(true)
            .digitalCrownRotation(
                crownTarget == .weight
                  ? Binding(get: { state.pendingWeight }, set: { state.pendingWeight = max(0, $0) })
                  : Binding(get: { Double(state.pendingReps) },
                            set: { state.pendingReps = max(0, Int($0.rounded())) }),
                from: 0,
                through: crownTarget == .weight ? 1000 : 50,
                by: crownTarget == .weight ? 2.5 : 1,
                sensitivity: .low,
                isContinuous: false,
                isHapticFeedbackEnabled: true
            )
        }
    }

    private func timedSetCard(_ ex: WatchExercise) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "stopwatch.fill")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundColor(theme.primary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(ex.sets > 1 ? "TIMED ROUND" : "TIMED")
                        .font(.system(size: 9, weight: .heavy))
                        .tracking(0.8)
                        .foregroundColor(theme.primary)
                    Text(durationTargetText(for: ex))
                        .font(.system(size: 18, weight: .black, design: .rounded))
                        .foregroundColor(theme.textPrimary)
                    if !ex.reps.isEmpty && ex.reps != durationTargetText(for: ex) {
                        Text(ex.reps)
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(theme.textMuted)
                            .lineLimit(1)
                    }
                }
            }
            Button(action: logSet) {
                HStack {
                    Image(systemName: "checkmark.circle.fill")
                    Text(isLastSet ? "Done" : "Log round")
                        .fontWeight(.bold)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .padding(.vertical, 9)
            .background(theme.primary)
            .foregroundColor(theme.background)
            .cornerRadius(10)
        }
        .padding(10)
        .background(theme.surface)
        .cornerRadius(12)
    }

    private func rirPromptCard(_ pending: WatchPendingRirLog) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 6) {
                Image(systemName: "target")
                    .font(.system(size: 13, weight: .heavy))
                    .foregroundColor(theme.primary)
                Text("REPS IN RESERVE")
                    .font(.system(size: 9, weight: .heavy))
                    .tracking(0.8)
                    .foregroundColor(theme.primary)
            }
            Text("How many more reps could you have done?")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(theme.textPrimary)
                .lineLimit(2)
            HStack(spacing: 4) {
                ForEach([0, 1, 2, 3, 4], id: \.self) { rir in
                    Button {
                        commitLoggedSet(rir: rir, pendingLog: pending)
                    } label: {
                        Text(rir == 4 ? "4+" : "\(rir)")
                            .font(.system(size: 12, weight: .black))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                    }
                    .buttonStyle(.plain)
                    .background(theme.primary)
                    .foregroundColor(theme.background)
                    .cornerRadius(8)
                }
            }
            Button {
                commitLoggedSet(rir: nil, pendingLog: pending)
            } label: {
                Text("Skip")
                    .font(.system(size: 11, weight: .bold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 7)
            }
            .buttonStyle(.plain)
            .background(theme.surfaceRaised)
            .foregroundColor(theme.textMuted)
            .cornerRadius(8)
        }
        .padding(10)
        .background(theme.surface)
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(theme.primary.opacity(0.45), lineWidth: 1)
        )
        .cornerRadius(12)
    }

    private func guideSetCard(_ ex: WatchExercise) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "figure.cooldown")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundColor(theme.primary)
                VStack(alignment: .leading, spacing: 2) {
                    Text("GUIDE")
                        .font(.system(size: 9, weight: .heavy))
                        .tracking(0.8)
                        .foregroundColor(theme.primary)
                    Text(ex.reps.isEmpty ? "Move by feel" : ex.reps)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(theme.textSecondary)
                        .lineLimit(2)
                }
            }
            Button(action: logSet) {
                HStack {
                    Image(systemName: "checkmark.circle.fill")
                    Text(isLastSet ? "Done" : "Mark step")
                        .fontWeight(.bold)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .padding(.vertical, 9)
            .background(theme.primary)
            .foregroundColor(theme.background)
            .cornerRadius(10)
        }
        .padding(10)
        .background(theme.surface)
        .cornerRadius(12)
    }

    @ViewBuilder
    private func recommendedWeightRow(_ ex: WatchExercise) -> some View {
        if !isGuideExercise(ex), let recommended = ex.plannedTargetWeightLbs, recommended > 0 {
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("RECOMMENDED")
                        .font(.system(size: 8, weight: .heavy))
                        .tracking(0.8)
                        .foregroundColor(theme.textMuted)
                    Text("\(formatWeight(recommended)) lb")
                        .font(.system(size: 16, weight: .black, design: .rounded))
                        .foregroundColor(theme.textPrimary)
                    Text(ex.reps)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(theme.textSecondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Button {
                    state.pendingWeight = recommended
                    WKInterfaceDevice.current().play(.click)
                } label: {
                    Text("Use")
                        .font(.system(size: 11, weight: .bold))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 6)
                        .background(theme.primary.opacity(0.18))
                        .foregroundColor(theme.primary)
                        .cornerRadius(8)
                }
                .buttonStyle(.plain)
            }
            .padding(8)
            .background(theme.primary.opacity(0.1))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(theme.primary.opacity(0.35), lineWidth: 1)
            )
            .cornerRadius(10)
        }
    }

    private func crownPill(_ label: String, value: String, active: Bool, onTap: @escaping () -> Void) -> some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 1) {
                Text(label.uppercased())
                    .font(.system(size: 9, weight: .heavy))
                    .tracking(0.5)
                    .foregroundColor(active ? theme.primary : theme.textMuted)
                Text(value)
                    .font(.system(size: 18, weight: .heavy, design: .rounded))
                    .foregroundColor(theme.textPrimary)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(active ? theme.primary.opacity(0.15) : theme.surfaceRaised)
            .cornerRadius(10)
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(active ? theme.primary : Color.clear, lineWidth: 1.5)
            )
        }
        .buttonStyle(.plain)
    }

    // ─── Rest timer card (with up-next) ───────────────────────────

    private func restCard(rest: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text("RESTING")
                        .font(.system(size: 10, weight: .black))
                        .tracking(1.2)
                        .foregroundColor(theme.warning)
                    if state.paused {
                        Text("PAUSED")
                            .font(.system(size: 9, weight: .heavy))
                            .foregroundColor(theme.textMuted)
                    }
                }
                Text(formatTime(rest))
                    .font(.system(size: 38, weight: .black, design: .rounded))
                    .foregroundColor(theme.warning)
                    .shadow(color: theme.warning.opacity(0.35), radius: 5)
            }

            // Up-next preview. Shows "Next set: reps target" OR (if
            // this was the last set of the exercise) "Next: exercise".
            upNextLine()
                .font(.system(size: 10))
                .foregroundColor(theme.textSecondary)

            HStack(spacing: 6) {
                Button(action: skipRest) {
                    Text("Skip rest")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .padding(.vertical, 8)
                .background(theme.primary)
                .foregroundColor(theme.background)
                .cornerRadius(8)
            }
        }
        .padding(10)
        .background(theme.surface)
        .cornerRadius(12)
    }

    @ViewBuilder
    private func upNextLine() -> some View {
        if let ex = currentExercise {
            if state.setNumber > ex.sets, let next = nextExercise {
                Text("Up next: \(next.name) · \(next.sets) × \(setTargetText(for: next))")
                    .lineLimit(2)
            } else {
                let setLabel = isTimedExercise(ex) ? "round" : "set"
                Text("Up next: \(setLabel) \(displaySetNumber(for: ex)) of \(ex.sets) · \(setTargetText(for: ex))")
                    .lineLimit(1)
            }
        } else {
            Text("")
        }
    }

    // ─── Footer (End / Cancel workout) ─────────────────────────────

    @State private var showCancelConfirm: Bool = false

    private func footer() -> some View {
        VStack(spacing: 6) {
            Button(action: onEndWorkout) {
                HStack {
                    Image(systemName: "stop.fill")
                    Text("End workout")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .padding(.vertical, 8)
            .background(theme.surfaceRaised)
            .foregroundColor(theme.error)
            .cornerRadius(10)
            // Cancel — distinct from End. End logs the workout to Thallo
            // history; Cancel discards everything so
            // a misstart / accidental tap doesn't muddy the record.
            Button(role: .destructive) {
                showCancelConfirm = true
            } label: {
                Text("Cancel workout")
                    .font(.system(size: 11, weight: .semibold))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .padding(.vertical, 6)
            .foregroundColor(theme.textMuted)
        }
        .padding(.top, 4)
        .confirmationDialog(
            "Cancel this workout? Sets you've logged will be discarded.",
            isPresented: $showCancelConfirm,
            titleVisibility: .visible
        ) {
            Button("Discard workout", role: .destructive) {
                // Failure haptic so the user knows this was destructive
                // by feel alone. Parent handler sends cancel_workout
                // and tears down the watch's HR session + UI without
                // logging anything to Health.
                WKInterfaceDevice.current().play(.failure)
                onCancelWorkout()
            }
            Button("Keep going", role: .cancel) {}
        }
    }

    // ─── Actions ───────────────────────────────────────────────────

    private func logSet() {
        guard let ex = currentExercise else { return }
        let guide = isGuideExercise(ex)
        let timed = isTimedExercise(ex)
        if !guide, !timed, shouldPromptRir(actualReps: state.pendingReps, targetReps: ex.reps) {
            pendingRirLog = WatchPendingRirLog(
                exerciseIndex: state.exerciseIndex,
                setNumber: displaySetNumber(for: ex),
                weightLbs: state.pendingWeight,
                reps: state.pendingReps
            )
            WKInterfaceDevice.current().play(.click)
            return
        }
        commitLoggedSet(rir: nil)
    }

    private func commitLoggedSet(rir: Int?, pendingLog: WatchPendingRirLog? = nil) {
        guard let ex = currentExercise else { return }
        let guide = isGuideExercise(ex)
        let timed = isTimedExercise(ex)
        // Haptic click — different from the rest-end notification so
        // the two are distinguishable by feel.
        WKInterfaceDevice.current().play(.click)

        // Ship the log to the phone so history + recommendations stay
        // aligned. Phone handler parses and feeds the deterministic
        // weight-rec engine for the next set.
        let setNumber = pendingLog?.setNumber ?? displaySetNumber(for: ex)
        let loggedWeight = pendingLog?.weightLbs ?? state.pendingWeight
        let loggedReps = pendingLog?.reps ?? state.pendingReps
        var payload: [String: Any] = [
            "sessionId": workout.sessionId ?? "",
            "exerciseIndex": state.exerciseIndex,
            "setNumber": setNumber,
            "weightLbs": guide || timed ? 0 : loggedWeight,
            "reps": guide || timed ? 0 : loggedReps,
            "exerciseName": ex.name,
        ]
        if let rir, !guide, !timed {
            payload["rir"] = max(0, min(4, rir))
        }
        if let durationSeconds = plannedDurationSeconds(for: ex) {
            payload["durationSeconds"] = durationSeconds
        }
        conn.sendCommand("log_set", payload: payload)
        pendingRirLog = nil
        if timed || guide {
            state.lastLoggedWeight = nil
            state.lastLoggedReps = nil
        } else {
            state.lastLoggedWeight = loggedWeight
            state.lastLoggedReps = loggedReps
        }

        if setNumber >= ex.sets {
            // Last set of this exercise → advance to next exercise.
            advanceExercise()
        } else {
            // Next set of same exercise.
            state.setNumber += 1
            if guide {
                state.clearRest()
            } else {
                state.setRest(seconds: ex.restSeconds)
            }
        }
    }

    private func requestSwap(_ option: WatchSwapOption) {
        pendingSwapName = option.name
        showSwapSheet = false
        state.clearRest()
        WKInterfaceDevice.current().play(.click)
        conn.sendCommand("swap_exercise", payload: [
            "sessionId": workout.sessionId ?? "",
            "exerciseIndex": state.exerciseIndex,
            "fromExerciseName": currentExercise?.name ?? "",
            "toExerciseName": option.name,
        ])
    }

    private func advanceExercise() {
        pendingRirLog = nil
        if isLastExercise {
            // Finished the whole workout — auto-end. Phone owns the
            // authoritative Thallo completion.
            onEndWorkout()
            return
        }
        let nextIdx = state.exerciseIndex + 1
        state.exerciseIndex = nextIdx
        state.setNumber = 1
        state.clearRest()
        // Seed weight/reps for the new exercise so Crown starts at
        // a useful value.
        state.pendingWeight = 0
        state.pendingReps = 0
        if workout.exercises.indices.contains(nextIdx) {
            state.seed(for: workout.exercises[nextIdx])
        }
        WKInterfaceDevice.current().play(.success)
    }

    private func skipRest() {
        state.clearRest()
        WKInterfaceDevice.current().play(.click)
        conn.sendCommand("skip_rest", payload: [
            "sessionId": workout.sessionId ?? "",
            "exerciseIndex": state.exerciseIndex,
            "setNumber": state.setNumber,
        ])
    }

    private func plannedDurationSeconds(for ex: WatchExercise) -> Int? {
        if let planned = ex.plannedDurationSeconds, planned > 0 {
            return planned
        }
        let reps = ex.reps.lowercased()
        let name = ex.name.lowercased()
        let timedName = name.range(of: "treadmill|bike|row|elliptical|stair|run|jog|cycling|swim|cardio|plank|dead.?hang|wall.?sit|hollow.?hold|carry|walk|yoga|mobility|stretch", options: .regularExpression) != nil
        let hasDurationUnit = reps.range(of: "s(ec|econds?)?\\b|m(in|inutes?)?\\b", options: .regularExpression) != nil
        guard timedName || hasDurationUnit else { return nil }
        let regex = try? NSRegularExpression(pattern: "\\d+(?:\\.\\d+)?")
        let nsRange = NSRange(reps.startIndex..<reps.endIndex, in: reps)
        let values = regex?.matches(in: reps, range: nsRange).compactMap { match -> Double? in
            guard let range = Range(match.range, in: reps) else { return nil }
            return Double(String(reps[range]))
        } ?? []
        guard let first = values.first else { return nil }
        let planned = values.count >= 2 && reps.contains("-") ? (first + values[1]) / 2 : first
        let unitIsMinutes = reps.range(of: "m(in|inutes?)?\\b", options: .regularExpression) != nil
            || name.range(of: "treadmill|bike|row|elliptical|stair|run|jog|cycling|swim|cardio|walk|yoga|mobility|stretch", options: .regularExpression) != nil
        return max(1, Int((unitIsMinutes ? planned * 60 : planned).rounded()))
    }

    private func formatTime(_ s: Int) -> String {
        let mm = s / 60
        let ss = s % 60
        return String(format: "%d:%02d", mm, ss)
    }

    private func formatWeight(_ value: Double) -> String {
        let rounded = (value * 10).rounded() / 10
        return rounded.rounded() == rounded ? "\(Int(rounded))" : String(format: "%.1f", rounded)
    }
}

private struct SwapExerciseSheet: View {
    let exercise: WatchExercise
    let pendingName: String?
    let onSelect: (WatchSwapOption) -> Void

    @EnvironmentObject var theme: ThemeStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(exercise.swapOptions) { option in
                        Button {
                            onSelect(option)
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 5) {
                                    Text(option.name)
                                        .font(.system(size: 13, weight: .bold))
                                        .foregroundColor(theme.textPrimary)
                                        .lineLimit(2)
                                    if pendingName == option.name {
                                        Image(systemName: "clock")
                                            .font(.system(size: 9, weight: .bold))
                                            .foregroundColor(theme.warning)
                                    }
                                }
                                HStack(spacing: 5) {
                                    if let equipment = option.equipment {
                                        Text(equipment)
                                    }
                                    if let overlap = option.overlap {
                                        Text("\(overlap)% match")
                                    }
                                }
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundColor(theme.textMuted)
                                .lineLimit(1)
                            }
                            .padding(.vertical, 2)
                        }
                    }
                } header: {
                    Text("Keeps \(exercise.sets) × \(exercise.reps)")
                }
            }
            .listStyle(.carousel)
            .navigationTitle("Swap")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}

// ─── Heart rate tab ────────────────────────────────────────────────

private struct HeartRateTab: View {
    @ObservedObject var hr: HeartRateStore
    @EnvironmentObject var theme: ThemeStore
    @Environment(\.isLuminanceReduced) private var dim

    var body: some View {
        ZStack {
            // Themed background with a subtle accent glow behind the
            // bpm readout so dark themes get a pop of color without
            // washing out the numeral itself.
            theme.background.ignoresSafeArea()
            if !dim {
                // Skip the glow under always-on to preserve burn-in budget.
                RadialGradient(
                    colors: [zoneColor.opacity(0.28), Color.clear],
                    center: .center,
                    startRadius: 0,
                    endRadius: 110,
                )
                .ignoresSafeArea()
            }
            VStack(spacing: 8) {
                Text("HEART RATE")
                    .font(.system(size: 9, weight: .bold))
                    .tracking(1)
                    .foregroundColor(theme.primary)

                HStack(alignment: .lastTextBaseline, spacing: 4) {
                    Text(hr.heartRate.map { "\($0)" } ?? "—")
                        .font(.system(size: 56, weight: .black, design: .rounded))
                        .foregroundColor(zoneColor)
                        .shadow(color: zoneColor.opacity(0.45), radius: 6)
                        // Always-on dim: drop opacity to keep the
                        // numeral legible but not burn-in risky.
                        .opacity(dim ? 0.55 : 1)
                    Text("bpm")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(theme.textSecondary)
                }

                if let z = hr.zone {
                    VStack(spacing: 2) {
                        Text("ZONE \(z)")
                            .font(.system(size: 11, weight: .black))
                            .tracking(0.8)
                            .foregroundColor(zoneColor)
                        Text(zoneLabel(z))
                            .font(.system(size: 11, weight: .bold))
                            .foregroundColor(zoneColor)
                            .lineLimit(1)
                            .minimumScaleFactor(0.72)
                        if let range = hr.currentZoneDefinition {
                            Text("\(range.low)-\(range.high) bpm")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundColor(theme.textSecondary)
                                .monospacedDigit()
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                        }
                    }
                    .padding(.vertical, 6)
                    .padding(.horizontal, 10)
                    .background(zoneColor.opacity(0.28))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(zoneColor.opacity(0.6), lineWidth: 1),
                    )
                    .cornerRadius(10)
                } else if hr.running {
                    Text("Reading…")
                        .font(.system(size: 11))
                        .foregroundColor(theme.primary)
                } else if let err = hr.errorMessage {
                    Text(err)
                        .font(.system(size: 10))
                        .foregroundColor(theme.error)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 8)
                }
            }
            .padding()
        }
    }

    private var zoneColor: Color {
        hr.zone == nil ? theme.textMuted : hrZoneColor(hr.zone)
    }

    private func zoneLabel(_ z: Int) -> String {
        if let label = hr.currentZoneDefinition?.label, !label.isEmpty {
            return label
        }
        switch z {
        case 1: return "Recovery"
        case 2: return "Aerobic"
        case 3: return "Tempo"
        case 4: return "Threshold"
        case 5: return "Max effort"
        default: return ""
        }
    }
}
