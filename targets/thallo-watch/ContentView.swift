// Root view. Three states:
//   1. No workout synced yet → "Open Thallo on your phone" prompt
//   2. Today's workout summary → Start + Skip buttons
//   3. Active workout → handed off to ActiveWorkoutView

import SwiftUI

struct ContentView: View {
    @EnvironmentObject var conn: ConnectivityStore
    @EnvironmentObject var theme: ThemeStore
    @State private var active: Bool = false
    @State private var heartRate: HeartRateStore = HeartRateStore()

    var body: some View {
        ZStack {
            theme.background.ignoresSafeArea()
            Group {
                if active, let workout = conn.workout {
                    ActiveWorkoutView(workout: workout, hr: heartRate) {
                        active = false
                        heartRate.end()
                        conn.sendCommand("end_workout")
                    }
                } else if let workout = conn.workout {
                    TodayView(workout: workout, onStart: {
                        active = true
                        heartRate.start()
                        conn.sendCommand("start_workout")
                    }, onSkip: {
                        conn.sendCommand("skip_workout")
                    })
                } else {
                    EmptyState()
                }
            }
        }
        .onReceive(conn.$theme) { palette in theme.palette = palette }
    }
}

// ─── Empty state ────────────────────────────────────────────────────

private struct EmptyState: View {
    @EnvironmentObject var theme: ThemeStore
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "iphone")
                .font(.system(size: 28))
                .foregroundColor(theme.textMuted)
            Text("Open Thallo")
                .font(.headline)
                .foregroundColor(theme.textPrimary)
            Text("Launch the iPhone app once so your workout syncs over.")
                .font(.caption2)
                .foregroundColor(theme.textMuted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 10)
        }
    }
}

// ─── Today's workout ────────────────────────────────────────────────

private struct TodayView: View {
    let workout: WatchWorkout
    let onStart: () -> Void
    let onSkip: () -> Void

    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("TODAY")
                        .font(.system(size: 9, weight: .bold))
                        .tracking(1.2)
                        .foregroundColor(theme.textMuted)
                    Text(workout.focus)
                        .font(.system(size: 24, weight: .heavy))
                        .foregroundColor(theme.textPrimary)
                        .lineLimit(2)
                    HStack(spacing: 6) {
                        Image(systemName: "clock")
                            .font(.system(size: 10))
                        Text("\(workout.durationMinutes) min · \(workout.exercises.count) exercises")
                            .font(.system(size: 11))
                    }
                    .foregroundColor(theme.textSecondary)
                }

                // Exercise preview list — first 3 visible, rest
                // collapsed behind a summary count.
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(workout.exercises.prefix(3)) { ex in
                        HStack(alignment: .top, spacing: 6) {
                            Circle()
                                .fill(theme.primary)
                                .frame(width: 5, height: 5)
                                .padding(.top, 5)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(ex.name)
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundColor(theme.textPrimary)
                                    .lineLimit(1)
                                Text("\(ex.sets) × \(ex.reps)")
                                    .font(.system(size: 10))
                                    .foregroundColor(theme.textMuted)
                            }
                        }
                    }
                    if workout.exercises.count > 3 {
                        Text("+ \(workout.exercises.count - 3) more")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(theme.textMuted)
                            .padding(.leading, 11)
                    }
                }
                .padding(.top, 2)

                VStack(spacing: 6) {
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
                }
                .padding(.top, 4)
            }
            .padding(10)
        }
    }
}
