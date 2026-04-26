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
// End workout button writes to HealthKit (HeartRateStore.end calls
// HKWorkoutBuilder.finishWorkout) and tells the phone to finalize.

import SwiftUI
import Combine
import WatchKit

// ─── Flow state owned by the watch ─────────────────────────────────

final class ActiveWorkoutState: ObservableObject {
    @Published var exerciseIndex: Int = 0 { didSet { persist() } }
    @Published var setNumber: Int = 1 { didSet { persist() } }   // 1-indexed within the current exercise
    @Published var restRemaining: Int? = nil { didSet { persist() } }   // seconds; nil = not resting
    @Published var paused: Bool = false { didSet { persist() } }
    // Log-set inputs. Seeded from the exercise's planned target on
    // entry so a first-time user already has a reasonable number.
    @Published var pendingWeight: Double = 0 { didSet { persist() } }
    @Published var pendingReps: Int = 0 { didSet { persist() } }
    // Cache of per-set logs so the user can see "last set: 135×8"
    // when dialing in the next set's weight.
    @Published var lastLoggedWeight: Double? = nil { didSet { persist() } }
    @Published var lastLoggedReps: Int? = nil { didSet { persist() } }

    private var cancellables: Set<AnyCancellable> = []
    // Defaults key — persists across watch-app background / kill so
    // users mid-workout don't lose their place when iOS reclaims
    // memory or they background to glance at a notification.
    private static let kPersistKey = "thallo.activeWorkoutState"
    private var hydrating = false

    init() {
        hydrate()
        // Still listen to phone progress pushes so if a user logs
        // a set on the phone the watch advances too.
        NotificationCenter.default.publisher(for: .watchProgressUpdate)
            .sink { [weak self] note in
                guard let self, let info = note.userInfo else { return }
                if let idx = info["exerciseIndex"] as? Int { self.exerciseIndex = idx }
                if let setN = info["setNumber"] as? Int { self.setNumber = setN }
                if let rest = info["restRemainingSec"] as? Int { self.restRemaining = rest }
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
        let blob: [String: Any] = [
            "exerciseIndex": exerciseIndex,
            "setNumber": setNumber,
            "restRemaining": restRemaining as Any,
            "paused": paused,
            "pendingWeight": pendingWeight,
            "pendingReps": pendingReps,
            "lastLoggedWeight": lastLoggedWeight as Any,
            "lastLoggedReps": lastLoggedReps as Any,
        ]
        UserDefaults.standard.set(blob, forKey: Self.kPersistKey)
    }

    private func hydrate() {
        guard let blob = UserDefaults.standard.dictionary(forKey: Self.kPersistKey) else { return }
        hydrating = true
        if let v = blob["exerciseIndex"] as? Int { exerciseIndex = v }
        if let v = blob["setNumber"] as? Int { setNumber = v }
        if let v = blob["restRemaining"] as? Int { restRemaining = v }
        if let v = blob["paused"] as? Bool { paused = v }
        if let v = blob["pendingWeight"] as? Double { pendingWeight = v }
        if let v = blob["pendingReps"] as? Int { pendingReps = v }
        if let v = blob["lastLoggedWeight"] as? Double { lastLoggedWeight = v }
        if let v = blob["lastLoggedReps"] as? Int { lastLoggedReps = v }
        hydrating = false
    }

    /// Wipe persisted state — call on workout end / cancel so the
    /// next workout starts from a clean slate.
    func clearPersisted() {
        UserDefaults.standard.removeObject(forKey: Self.kPersistKey)
    }

    /// Prime the weight / reps inputs for the current exercise.
    /// Called when advancing to a new exercise so the user doesn't
    /// have to dial from zero.
    func seed(for ex: WatchExercise) {
        if pendingWeight == 0, let w = ex.plannedTargetWeightLbs {
            pendingWeight = w
        }
        if pendingReps == 0 {
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
                guard let r = self.restRemaining, r > 0 else { return }
                let next = r - 1
                self.restRemaining = next
                if next == 0 {
                    // Rest over — double-notification haptic. Same
                    // pattern Apple Workout uses on interval ends.
                    WKInterfaceDevice.current().play(.notification)
                }
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
    @StateObject private var state = ActiveWorkoutState()
    @State private var showCountdown: Bool = true

    var body: some View {
        ZStack {
            TabView {
                ExerciseTab(
                    workout: workout,
                    state: state,
                    hr: hr,
                    onEndWorkout: onEndWorkout,
                    onCancelWorkout: onCancelWorkout,
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
            state.startTick()
            if let ex = workout.exercises.first {
                state.seed(for: ex)
            }
        }
        .onDisappear { state.stopTick() }
    }
}

// ─── Start countdown overlay ───────────────────────────────────────

/// 3-2-1-go intro shown when the active workout view first mounts.
/// Mirrors the phone overlay (see `StartCountdownOverlay.tsx`) so the
/// two surfaces feel synchronised when a workout is started from the
/// wrist — phone countdown runs locally as soon as the phone flips the
/// watch to `.active`, watch runs its own.
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

    var isLastExercise: Bool {
        state.exerciseIndex >= workout.exercises.count - 1
    }

    // Small HR chip color mirrors the HR tab's zone palette so the two
    // views read consistently. Falls back to muted when no zone yet.
    var hrChipColor: Color {
        guard let z = hr.zone else { return theme.error }
        switch z {
        case 1: return theme.textMuted
        case 2: return theme.success
        case 3: return theme.primary
        case 4: return theme.warning
        case 5: return theme.error
        default: return theme.textSecondary
        }
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
            Button("Skip exercise", role: .destructive) { advanceExercise() }
            Button("Cancel", role: .cancel) {}
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
        VStack(alignment: .leading, spacing: 3) {
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
                        Text("\(bpm)")
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
                Text("SET")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(theme.textMuted)
                Text("\(state.setNumber) of \(ex.sets)")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(theme.textPrimary)
                Text("·")
                    .foregroundColor(theme.textMuted)
                Text(ex.reps)
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
            if let rec = ex.recommendation {
                Text(rec)
                    .font(.system(size: 11))
                    .foregroundColor(theme.primary)
                    .lineLimit(2)
            }
            if let lw = state.lastLoggedWeight, let lr = state.lastLoggedReps {
                Text("Last: \(Int(lw)) lb × \(lr)")
                    .font(.system(size: 10))
                    .foregroundColor(theme.textMuted)
            }
        }
    }

    // ─── Log-set card (Crown → weight or reps) ─────────────────────

    private func logSetCard(_ ex: WatchExercise) -> some View {
        VStack(alignment: .leading, spacing: 10) {
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
                Button(action: togglePause) {
                    Image(systemName: state.paused ? "play.fill" : "pause.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .padding(.vertical, 8)
                .background(theme.surfaceRaised)
                .foregroundColor(theme.textSecondary)
                .cornerRadius(8)
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
        if isLastSet, let next = nextExercise {
            Text("Up next: \(next.name) · \(next.sets) × \(next.reps)")
                .lineLimit(2)
        } else if let ex = currentExercise {
            Text("Up next: set \(state.setNumber + 1) of \(ex.sets) · \(ex.reps)")
                .lineLimit(1)
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
            // Cancel — distinct from End. End LOGS the workout (writes
            // to Health, saves history); Cancel DISCARDS everything so
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
        // Haptic click — different from the rest-end notification so
        // the two are distinguishable by feel.
        WKInterfaceDevice.current().play(.click)

        // Ship the log to the phone so history + recommendations stay
        // aligned. Phone handler parses and feeds the deterministic
        // weight-rec engine for the next set.
        conn.sendCommand("log_set", payload: [
            "exerciseIndex": state.exerciseIndex,
            "setNumber": state.setNumber,
            "weightLbs": state.pendingWeight,
            "reps": state.pendingReps,
            "exerciseName": ex.name,
        ])
        state.lastLoggedWeight = state.pendingWeight
        state.lastLoggedReps = state.pendingReps

        if state.setNumber >= ex.sets {
            // Last set of this exercise → advance to next exercise.
            advanceExercise()
        } else {
            // Next set of same exercise → start rest.
            state.setNumber += 1
            state.restRemaining = ex.restSeconds
        }
    }

    private func advanceExercise() {
        if isLastExercise {
            // Finished the whole workout — auto-end. Phone writes to
            // Health via HKWorkoutBuilder.finishWorkout().
            onEndWorkout()
            return
        }
        let nextIdx = state.exerciseIndex + 1
        state.exerciseIndex = nextIdx
        state.setNumber = 1
        state.restRemaining = nil
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
        state.restRemaining = nil
        WKInterfaceDevice.current().play(.click)
    }

    private func togglePause() {
        state.paused.toggle()
        WKInterfaceDevice.current().play(.click)
    }

    private func formatTime(_ s: Int) -> String {
        let mm = s / 60
        let ss = s % 60
        return String(format: "%d:%02d", mm, ss)
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
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(theme.textPrimary)
                    }
                    .padding(.vertical, 6)
                    .padding(.horizontal, 12)
                    .background(zoneColor.opacity(0.22))
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
        guard let z = hr.zone else { return theme.textMuted }
        switch z {
        case 1: return theme.textMuted
        case 2: return theme.success
        case 3: return theme.primary
        case 4: return theme.warning
        case 5: return theme.error
        default: return theme.textSecondary
        }
    }

    private func zoneLabel(_ z: Int) -> String {
        switch z {
        case 1: return "Recovery"
        case 2: return "Easy"
        case 3: return "Tempo"
        case 4: return "Threshold"
        case 5: return "Max effort"
        default: return ""
        }
    }
}
