// Active workout screen. Two tabs (TabView with page style) so the
// user can swipe between:
//   • EXERCISE — current exercise, set counter, recommendation line,
//     rest timer with Start / Skip Rest buttons
//   • HEART    — live heart rate + zone
// Phone mirrors state via WatchConnectivity `progress` messages so the
// set counter / rest remaining / recommendation stay in sync even if
// the user taps "Done Set" on the phone.

import SwiftUI
import Combine
import WatchKit

final class ActiveWorkoutState: ObservableObject {
    @Published var exerciseIndex: Int = 0
    @Published var setNumber: Int = 1
    @Published var restRemaining: Int? = nil      // seconds
    @Published var recommendation: String? = nil
    private var cancellables: Set<AnyCancellable> = []

    init() {
        NotificationCenter.default.publisher(for: .watchProgressUpdate)
            .sink { [weak self] note in
                guard let self, let info = note.userInfo else { return }
                if let idx = info["exerciseIndex"] as? Int { self.exerciseIndex = idx }
                if let setN = info["setNumber"] as? Int { self.setNumber = setN }
                if let rest = info["restRemainingSec"] as? Int { self.restRemaining = rest }
                else if (info["restRemainingSec"] as? NSNull) != nil { self.restRemaining = nil }
                if let rec = info["recommendation"] as? String { self.recommendation = rec }
            }
            .store(in: &cancellables)
    }

    // Local 1hz tick — decrements restRemaining so the watch doesn't
    // depend on the phone pushing every second (saves battery). When
    // the timer hits zero we fire a haptic so the user knows rest is
    // up without needing to look at the watch. `notification` gives
    // the strongest cue available on watchOS.
    private var timer: AnyCancellable?
    private var lastRestTickFired: Int? = nil
    func startTick() {
        timer?.cancel()
        timer = Timer.publish(every: 1, on: .main, in: .common)
            .autoconnect()
            .sink { [weak self] _ in
                guard let self else { return }
                guard let r = self.restRemaining, r > 0 else { return }
                let next = r - 1
                self.restRemaining = next
                if next == 0 {
                    // Rest is up — double-tap haptic that Apple's own
                    // Workout app uses for interval transitions.
                    WKInterfaceDevice.current().play(.notification)
                }
            }
    }
    func stopTick() { timer?.cancel(); timer = nil }
}

struct ActiveWorkoutView: View {
    let workout: WatchWorkout
    @ObservedObject var hr: HeartRateStore
    /// End the workout everywhere (watch + phone).
    let onEndWorkout: () -> Void
    /// Close just the watch UI; phone keeps tracking. Lets the user
    /// fall back to Apple's native Workout app without losing their
    /// phone-side logged sets.
    let onCloseWatchOnly: () -> Void

    @EnvironmentObject var theme: ThemeStore
    @StateObject private var state = ActiveWorkoutState()

    var currentExercise: WatchExercise? {
        workout.exercises.indices.contains(state.exerciseIndex)
            ? workout.exercises[state.exerciseIndex] : nil
    }

    var body: some View {
        TabView {
            ExerciseTab(
                workout: workout,
                state: state,
                onEndWorkout: onEndWorkout,
                onCloseWatchOnly: onCloseWatchOnly
            )
            HeartRateTab(hr: hr)
        }
        .tabViewStyle(.page)
        .onAppear { state.startTick() }
        .onDisappear { state.stopTick() }
    }
}

// ─── Exercise tab ───────────────────────────────────────────────────

private struct ExerciseTab: View {
    let workout: WatchWorkout
    @ObservedObject var state: ActiveWorkoutState
    let onEndWorkout: () -> Void
    let onCloseWatchOnly: () -> Void

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var conn: ConnectivityStore

    var currentExercise: WatchExercise? {
        workout.exercises.indices.contains(state.exerciseIndex)
            ? workout.exercises[state.exerciseIndex] : nil
    }

    var body: some View {
        ZStack {
            theme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if let ex = currentExercise {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("EXERCISE \(state.exerciseIndex + 1) / \(workout.exercises.count)")
                                .font(.system(size: 9, weight: .bold))
                                .tracking(1)
                                .foregroundColor(theme.textMuted)
                            Text(ex.name)
                                .font(.system(size: 17, weight: .heavy))
                                .foregroundColor(theme.textPrimary)
                                .lineLimit(2)
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
                            }

                            if let rec = state.recommendation {
                                Text(rec)
                                    .font(.system(size: 11))
                                    .foregroundColor(theme.primary)
                                    .lineLimit(3)
                                    .padding(.top, 3)
                            }
                        }

                        // Rest timer card.
                        RestTimerCard(
                            restRemaining: state.restRemaining,
                            defaultRest: ex.restSeconds,
                            onStartRest: { conn.sendCommand("start_rest", payload: ["seconds": ex.restSeconds]) },
                            onSkipRest:  { conn.sendCommand("skip_rest") },
                            onDoneSet:   { conn.sendCommand("log_set") }
                        )

                        // Two exit paths:
                        //   • End workout — stops HR session on the
                        //     watch AND tells the phone to end.
                        //   • Close watch — dismisses the watch UI,
                        //     stops the watch HR session, but the
                        //     phone's workout keeps running. Lets the
                        //     user switch to Apple's Workout app
                        //     without losing logged sets.
                        HStack(spacing: 6) {
                            Button(action: onCloseWatchOnly) {
                                HStack {
                                    Image(systemName: "arrow.down.right.and.arrow.up.left")
                                    Text("Close watch")
                                        .font(.system(size: 11, weight: .semibold))
                                }
                                .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.plain)
                            .padding(.vertical, 8)
                            .background(theme.surfaceRaised)
                            .foregroundColor(theme.textSecondary)
                            .cornerRadius(10)
                            Button(action: onEndWorkout) {
                                HStack {
                                    Image(systemName: "stop.fill")
                                    Text("End")
                                        .font(.system(size: 11, weight: .semibold))
                                }
                                .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.plain)
                            .padding(.vertical, 8)
                            .background(theme.surfaceRaised)
                            .foregroundColor(theme.error)
                            .cornerRadius(10)
                        }
                    }
                }
                .padding(10)
            }
        }
    }
}

private struct RestTimerCard: View {
    let restRemaining: Int?
    let defaultRest: Int
    let onStartRest: () -> Void
    let onSkipRest: () -> Void
    let onDoneSet: () -> Void

    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let r = restRemaining, r > 0 {
                VStack(alignment: .leading, spacing: 2) {
                    Text("RESTING")
                        .font(.system(size: 9, weight: .bold))
                        .tracking(1)
                        .foregroundColor(theme.warning)
                    Text(formatTime(r))
                        .font(.system(size: 32, weight: .heavy, design: .rounded))
                        .foregroundColor(theme.textPrimary)
                }
                Button(action: onSkipRest) {
                    Text("Skip rest")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .padding(.vertical, 7)
                .background(theme.surfaceRaised)
                .foregroundColor(theme.textSecondary)
                .cornerRadius(8)
            } else {
                HStack(spacing: 6) {
                    Button(action: onDoneSet) {
                        Text("Done set")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, 8)
                    .background(theme.primary)
                    .foregroundColor(theme.background)
                    .cornerRadius(8)
                    Button(action: onStartRest) {
                        Text("+\(defaultRest)s")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, 8)
                    .background(theme.surfaceRaised)
                    .foregroundColor(theme.textSecondary)
                    .cornerRadius(8)
                }
            }
        }
        .padding(10)
        .background(theme.surface)
        .cornerRadius(12)
    }

    private func formatTime(_ s: Int) -> String {
        let mm = s / 60
        let ss = s % 60
        return String(format: "%d:%02d", mm, ss)
    }
}

// ─── Heart rate tab ─────────────────────────────────────────────────

private struct HeartRateTab: View {
    @ObservedObject var hr: HeartRateStore
    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        ZStack {
            theme.background.ignoresSafeArea()
            VStack(spacing: 8) {
                Text("HEART RATE")
                    .font(.system(size: 9, weight: .bold))
                    .tracking(1)
                    .foregroundColor(theme.textMuted)

                HStack(alignment: .lastTextBaseline, spacing: 4) {
                    Text(hr.heartRate.map { "\($0)" } ?? "—")
                        .font(.system(size: 52, weight: .heavy, design: .rounded))
                        .foregroundColor(zoneColor)
                    Text("bpm")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(theme.textSecondary)
                }

                if let z = hr.zone {
                    VStack(spacing: 2) {
                        Text("ZONE \(z)")
                            .font(.system(size: 10, weight: .heavy))
                            .tracking(0.6)
                            .foregroundColor(zoneColor)
                        Text(zoneLabel(z))
                            .font(.system(size: 11))
                            .foregroundColor(theme.textSecondary)
                    }
                    .padding(.vertical, 4)
                    .padding(.horizontal, 10)
                    .background(zoneColor.opacity(0.15))
                    .cornerRadius(8)
                } else if hr.running {
                    Text("Reading…")
                        .font(.system(size: 11))
                        .foregroundColor(theme.textMuted)
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
