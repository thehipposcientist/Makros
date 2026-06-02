import ActivityKit
import Foundation
import SwiftUI
import WidgetKit

// Hex → Color helper. Accepts "#RRGGBB" or "RRGGBB".
private extension Color {
    init(hex: String) {
        let cleaned = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var rgb: UInt64 = 0
        Scanner(string: cleaned).scanHexInt64(&rgb)
        let r = Double((rgb & 0xFF0000) >> 16) / 255.0
        let g = Double((rgb & 0x00FF00) >> 8) / 255.0
        let b = Double(rgb & 0x0000FF) / 255.0
        self = Color(red: r, green: g, blue: b)
    }
}

struct RestTimerWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RestTimerAttributes.self) { context in
            // Lock-screen / notification-center view
            LockScreenView(state: context.state, workoutId: context.attributes.workoutId)
                .padding(16)
                .activityBackgroundTint(Color.black.opacity(0.85))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                // Expanded (long-press on Dynamic Island)
                DynamicIslandExpandedRegion(.leading) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.state.exerciseName)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text(setProgressText(context.state))
                            .font(.subheadline.bold())
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    TimerText(state: context.state,
                              accent: Color(hex: context.state.themeColorHex))
                        .font(.system(size: 26, weight: .heavy, design: .rounded))
                        .monospacedDigit()
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        if hasHeartRateZone(context.state) {
                            HeartRateZoneBadge(state: context.state)
                        }
                        Text(statusText(context.state))
                            .font(.footnote)
                            .foregroundStyle(.white)
                            .lineLimit(2)
                        if #available(iOSApplicationExtension 17.0, *), isRestTimer(context.state) {
                            RestAdjustControls(workoutId: context.attributes.workoutId, accent: Color(hex: context.state.themeColorHex))
                        }
                    }
                }
            } compactLeading: {
                Image(systemName: "timer")
                    .foregroundStyle(Color(hex: context.state.themeColorHex))
            } compactTrailing: {
                TimerText(state: context.state,
                          accent: Color(hex: context.state.themeColorHex))
                    .monospacedDigit()
                    .font(.caption.bold())
            } minimal: {
                Image(systemName: "timer")
                    .foregroundStyle(Color(hex: context.state.themeColorHex))
            }
        }
    }
}

private struct LockScreenView: View {
    let state: RestTimerAttributes.ContentState
    let workoutId: String
    var accent: Color { Color(hex: state.themeColorHex) }

    var body: some View {
        if isCardioMode(state) {
            CardioLockScreenView(state: state, accent: accent)
        } else {
            HStack(spacing: 14) {
                TimerCircle(state: state, accent: accent)

                VStack(alignment: .leading, spacing: 4) {
                    Text(isElapsedWorkout(state) ? "WORKOUT" : "REST")
                        .font(.system(size: 11, weight: .heavy))
                        .foregroundStyle(accent)
                        .tracking(1.5)
                    Text(state.exerciseName)
                        .font(.headline)
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    Text(setProgressText(state))
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.75))
                        .lineLimit(1)
                    if hasHeartRateZone(state) {
                        HeartRateZoneBadge(state: state)
                    }
                    Text(statusText(state))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white)
                        .lineLimit(2)
                    if #available(iOSApplicationExtension 17.0, *), isRestTimer(state) {
                        RestAdjustControls(workoutId: workoutId, accent: accent)
                            .padding(.top, 2)
                    }
                }
                Spacer()
            }
        }
    }
}

// ─── Cardio lock-screen layout ─────────────────────────────────────
//
// Used when state.mode == "cardio". Big elapsed time + distance row
// up top; pace + HR + calories chips underneath. Designed to read at a
// glance from the lock screen while the user is running/biking and
// shouldn't be tapping the screen.

private struct CardioLockScreenView: View {
    let state: RestTimerAttributes.ContentState
    let accent: Color

    private var startDate: Date { Date(timeIntervalSince1970: state.startedAtMs / 1000.0) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Header row — focus name + sport badge.
            HStack(spacing: 6) {
                Text(state.exerciseName.isEmpty ? "CARDIO" : state.exerciseName.uppercased())
                    .font(.system(size: 11, weight: .heavy))
                    .foregroundStyle(accent)
                    .tracking(1.4)
                    .lineLimit(1)
                Spacer()
                if hasHeartRateZone(state) {
                    HeartRateZoneBadge(state: state)
                }
            }

            // Big elapsed time + distance.
            HStack(alignment: .firstTextBaseline, spacing: 14) {
                Text(timerInterval: startDate...Date(timeIntervalSinceNow: 60_000),
                     pauseTime: nil,
                     countsDown: false,
                     showsHours: true)
                    .font(.system(size: 32, weight: .heavy, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Spacer()
                Text(distanceLabel(state))
                    .font(.system(size: 26, weight: .heavy, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }

            // Pace + calories chips. Pace honors the user's distance unit
            // preference (per-mi or per-km).
            HStack(spacing: 8) {
                metricChip(label: "PACE", value: paceLabel(state), accent: accent)
                metricChip(label: "KCAL", value: caloriesLabel(state), accent: .orange)
                if let bpm = state.heartRate, bpm > 0 {
                    metricChip(label: "HR", value: "\(bpm)", accent: Color(hex: state.hrZoneColorHex ?? zoneColorHex(state.hrZone)))
                }
            }
        }
    }

    private func metricChip(label: String, value: String, accent: Color) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.system(size: 9, weight: .heavy))
                .tracking(0.6)
                .foregroundStyle(.white.opacity(0.6))
            Text(value)
                .font(.system(size: 14, weight: .heavy, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(accent)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 5)
        .padding(.horizontal, 8)
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }
}

private func isCardioMode(_ state: RestTimerAttributes.ContentState) -> Bool {
    return (state.mode ?? "") == "cardio"
}

private func distanceLabel(_ state: RestTimerAttributes.ContentState) -> String {
    let meters = state.distanceMeters ?? 0
    if meters <= 0 { return "—" }
    let unit = state.distanceUnit ?? "mi"
    let km = meters / 1000.0
    let value = unit == "km" ? km : km * 0.6213711922
    let suffix = unit == "km" ? "km" : "mi"
    if value < 100 {
        return String(format: "%.2f %@", value, suffix)
    }
    return String(format: "%.0f %@", value, suffix)
}

private func paceLabel(_ state: RestTimerAttributes.ContentState) -> String {
    guard let pace = state.paceSecPerKm, pace > 0 else { return "—" }
    let unit = state.distanceUnit ?? "mi"
    // sec/km → sec/mi: a mile is 1/0.6213 ≈ 1.609 km, so per-mile pace
    // is the per-km pace divided by miles-per-km.
    let secForUnit = unit == "km" ? pace : (pace / 0.6213711922)
    let minutes = Int(secForUnit) / 60
    let seconds = Int(secForUnit) % 60
    let suffix = unit == "km" ? "/km" : "/mi"
    return String(format: "%d:%02d%@", minutes, seconds, suffix)
}

private func caloriesLabel(_ state: RestTimerAttributes.ContentState) -> String {
    let cals = state.activeCalories ?? 0
    if cals <= 0 { return "—" }
    return "\(Int(cals.rounded()))"
}

private struct TimerCircle: View {
    let state: RestTimerAttributes.ContentState
    let accent: Color

    private var startDate: Date { Date(timeIntervalSince1970: state.startedAtMs / 1000.0) }
    private var endDate: Date { Date(timeIntervalSince1970: state.endDateMs / 1000.0) }

    var body: some View {
        ZStack {
            Circle()
                .stroke(accent.opacity(0.22), lineWidth: 5)
            if isElapsedWorkout(state) {
                Image(systemName: state.paused == true ? "pause.fill" : "timer")
                    .font(.system(size: 12, weight: .heavy))
                    .foregroundStyle(accent.opacity(0.75))
                    .offset(y: -18)
                TimerText(state: state, accent: accent)
                    .font(.system(size: 17, weight: .heavy, design: .rounded))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.62)
                    .frame(width: 58, height: 26, alignment: .center)
                    .multilineTextAlignment(.center)
                    .offset(y: 5)
            } else {
                // ProgressView(timerInterval:) auto-animates in Live Activities
                // without burning the widget's refresh budget. .circular renders
                // a system ring; we tint it to match the theme.
                ProgressView(timerInterval: startDate...endDate, countsDown: true) {
                    EmptyView()
                } currentValueLabel: {
                    EmptyView()
                }
                .progressViewStyle(.circular)
                .tint(accent)
                .frame(width: 68, height: 68)
                // Text(timerInterval:countsDown:) is the ONLY pattern that ticks
                // reliably on the lock screen — TimelineView(.periodic) gets
                // throttled to ~1/min by ActivityKit when the app is
                // backgrounded, which is why the previous version showed a
                // frozen number.
                Text(timerInterval: startDate...endDate, countsDown: true)
                    .font(.system(size: 18, weight: .heavy, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(accent)
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                    .frame(width: 48, height: 24, alignment: .center)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(width: 68, height: 68, alignment: .center)
    }
}

private struct HeartRateZoneBadge: View {
    let state: RestTimerAttributes.ContentState

    private var zoneColor: Color {
        Color(hex: state.hrZoneColorHex ?? zoneColorHex(state.hrZone))
    }

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "heart.fill")
                .font(.system(size: 9, weight: .bold))
            if let bpm = state.heartRate, bpm > 0 {
                Text("\(bpm)")
                    .monospacedDigit()
            }
            if let zone = state.hrZone, zone > 0 {
                Text("Z\(zone)")
                    .fontWeight(.heavy)
            }
            if let range = zoneRangeText(state) {
                Text(range)
                    .foregroundStyle(.white.opacity(0.75))
            }
        }
        .font(.caption2.weight(.bold))
        .foregroundStyle(zoneColor)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(zoneColor.opacity(0.18), in: Capsule())
        .overlay(
            Capsule()
                .stroke(zoneColor.opacity(0.55), lineWidth: 1)
        )
    }
}

@available(iOSApplicationExtension 17.0, *)
private struct RestAdjustControls: View {
    let workoutId: String
    let accent: Color

    var body: some View {
        HStack(spacing: 8) {
            adjustButton(title: "-15", deltaSeconds: -15)
            adjustButton(title: "+15", deltaSeconds: 15)
        }
        .buttonStyle(.plain)
    }

    private func adjustButton(title: String, deltaSeconds: Int) -> some View {
        Button(intent: AdjustRestTimerIntent(workoutId: workoutId, deltaSeconds: deltaSeconds)) {
            Text(title)
                .font(.caption2.weight(.heavy))
                .monospacedDigit()
                .foregroundStyle(.white)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(accent.opacity(0.28), in: Capsule())
                .overlay(
                    Capsule()
                        .stroke(accent.opacity(0.7), lineWidth: 1)
                )
        }
        .accessibilityLabel(deltaSeconds < 0 ? "Subtract 15 seconds" : "Add 15 seconds")
    }
}

// Renders a live-ticking countdown without requiring per-second pushes.
// Uses Text(timerInterval:countsDown:) — the only Live-Activity-safe
// pattern for ticking text. TimelineView(.periodic) gets refresh-budgeted
// by ActivityKit and visibly stalls when the app is backgrounded.
private struct TimerText: View {
    let state: RestTimerAttributes.ContentState
    let accent: Color

    var body: some View {
        if isElapsedWorkout(state) {
            if state.paused == true {
                Text(formatElapsed(Int(state.elapsedSeconds ?? 0)))
                    .foregroundStyle(accent)
            } else {
                let start = Date(timeIntervalSince1970: state.startedAtMs / 1000.0)
                Text(timerInterval: start...Date.distantFuture, countsDown: false)
                    .foregroundStyle(accent)
            }
        } else {
            let end = Date(timeIntervalSince1970: state.endDateMs / 1000.0)
            Text(timerInterval: Date()...end, countsDown: true)
                .foregroundStyle(accent)
        }
    }
}

private func remainingSeconds(endDateMs: Double, at date: Date) -> Int {
    let end = Date(timeIntervalSince1970: endDateMs / 1000.0)
    return max(0, Int(ceil(end.timeIntervalSince(date))))
}

private func timerProgress(state: RestTimerAttributes.ContentState, remainingSeconds: Int) -> CGFloat {
    let start = Date(timeIntervalSince1970: state.startedAtMs / 1000.0)
    let end = Date(timeIntervalSince1970: state.endDateMs / 1000.0)
    let fallbackTotal = max(1, end.timeIntervalSince(start))
    let total = max(1, state.durationSeconds > 0 ? state.durationSeconds : fallbackTotal)
    let progress = min(1, max(0, Double(remainingSeconds) / total))
    return CGFloat(progress)
}

private func formatRemaining(_ seconds: Int) -> String {
    let minutes = seconds / 60
    let remainder = seconds % 60
    return String(format: "%d:%02d", minutes, remainder)
}

private func setProgressText(_ state: RestTimerAttributes.ContentState) -> String {
    if isElapsedWorkout(state) {
        return state.paused == true ? "Paused" : "Live timer"
    }
    let displaySet = max(1, state.setNumber + 1)
    let setNumber = state.totalSets > 0 ? min(displaySet, state.totalSets) : displaySet
    return state.totalSets > 0 ? "Set \(setNumber) of \(state.totalSets)" : "Set \(setNumber)"
}

private func isElapsedWorkout(_ state: RestTimerAttributes.ContentState) -> Bool {
    return state.mode == "elapsed"
}

private func isRestTimer(_ state: RestTimerAttributes.ContentState) -> Bool {
    return !isElapsedWorkout(state)
}

private func hasHeartRateZone(_ state: RestTimerAttributes.ContentState) -> Bool {
    if let bpm = state.heartRate, bpm > 0 { return true }
    if let zone = state.hrZone, zone > 0 { return true }
    return false
}

private func zoneColorHex(_ zone: Int?) -> String {
    switch zone {
    case 1: return "#38BDF8"
    case 2: return "#22C55E"
    case 3: return "#EAB308"
    case 4: return "#F97316"
    case 5: return "#EF4444"
    default: return "#38BDF8"
    }
}

private func zoneRangeText(_ state: RestTimerAttributes.ContentState) -> String? {
    guard let low = state.hrZoneLow, let high = state.hrZoneHigh, low > 0, high >= low else {
        return state.hrZoneLabel
    }
    return "\(low)-\(high)"
}

private func statusText(_ state: RestTimerAttributes.ContentState) -> String {
    if isElapsedWorkout(state) {
        return state.paused == true ? "Paused" : recommendationText(state.nextSetRecommendation)
    }
    return "Next: \(recommendationText(state.nextSetRecommendation))"
}

private func formatElapsed(_ seconds: Int) -> String {
    let clamped = max(0, seconds)
    let hours = clamped / 3600
    let minutes = (clamped % 3600) / 60
    let remainder = clamped % 60
    if hours > 0 {
        return String(format: "%d:%02d:%02d", hours, minutes, remainder)
    }
    return String(format: "%d:%02d", minutes, remainder)
}

private func recommendationText(_ text: String) -> String {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? "Recommendation loading" : trimmed
}
