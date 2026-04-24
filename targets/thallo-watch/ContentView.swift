// Root view. Three states:
//   1. No workout synced yet → "Open Thallo on your phone" prompt
//   2. Today's workout summary → Start + Skip buttons
//   3. Active workout → handed off to ActiveWorkoutView

import SwiftUI

struct ContentView: View {
    @EnvironmentObject var conn: ConnectivityStore
    @EnvironmentObject var theme: ThemeStore
    @State private var active: Bool = false
    // @StateObject (not @State) because HeartRateStore is an
    // ObservableObject — @State won't republish @Published changes
    // and the BPM number would freeze after the first sample.
    @StateObject private var heartRate: HeartRateStore = HeartRateStore()

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

                // Full exercise list — ScrollView already wraps this,
                // so showing every row is fine. Each row reads
                // "Bench Press · Barbell" on top and "4 × 5-8 · 135 lb"
                // underneath so the user can glance at the full plan
                // without opening the phone.
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(workout.exercises.enumerated()), id: \.element.id) { idx, ex in
                        HStack(alignment: .top, spacing: 8) {
                            // Index pill — keeps the eye anchored.
                            Text("\(idx + 1)")
                                .font(.system(size: 10, weight: .heavy, design: .rounded))
                                .foregroundColor(theme.primary)
                                .frame(width: 18, height: 18)
                                .background(theme.primary.opacity(0.18))
                                .clipShape(Circle())
                            VStack(alignment: .leading, spacing: 2) {
                                Text(ex.name)
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundColor(theme.textPrimary)
                                    .lineLimit(2)
                                detailLine(for: ex)
                            }
                        }
                        .padding(.vertical, 4)
                        .padding(.horizontal, 6)
                        .background(theme.surface.opacity(0.6))
                        .cornerRadius(8)
                    }
                }
                .padding(.top, 4)

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

    /// Secondary line on each exercise row. Format:
    ///   "4 × 5-8 · Barbell · 135 lb"
    /// Fields trimmed gracefully when missing so the line always
    /// reads cleanly (never a lone " · " orphan).
    @ViewBuilder
    private func detailLine(for ex: WatchExercise) -> some View {
        let parts: [String] = {
            var p: [String] = ["\(ex.sets) × \(ex.reps)"]
            if let eq = ex.equipment, !eq.isEmpty {
                // Humanize "barbell, flat_bench" → "Barbell · Flat Bench"
                let pretty = eq
                    .split(separator: ",")
                    .map { $0.trimmingCharacters(in: .whitespaces)
                            .replacingOccurrences(of: "_", with: " ")
                            .capitalized }
                    .joined(separator: ", ")
                p.append(pretty)
            }
            if let w = ex.plannedTargetWeightLbs, w > 0 {
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
