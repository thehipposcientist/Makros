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
                    TimerText(endDateMs: context.state.endDateMs,
                              accent: Color(hex: context.state.themeColorHex))
                        .font(.system(size: 26, weight: .heavy, design: .rounded))
                        .monospacedDigit()
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(recommendationText(context.state.nextSetRecommendation))
                            .font(.footnote)
                            .foregroundStyle(.white)
                            .lineLimit(2)
                        if #available(iOSApplicationExtension 17.0, *) {
                            RestAdjustControls(workoutId: context.attributes.workoutId, accent: Color(hex: context.state.themeColorHex))
                        }
                    }
                }
            } compactLeading: {
                Image(systemName: "timer")
                    .foregroundStyle(Color(hex: context.state.themeColorHex))
            } compactTrailing: {
                TimerText(endDateMs: context.state.endDateMs,
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
        HStack(spacing: 14) {
            TimerCircle(state: state, accent: accent)

            VStack(alignment: .leading, spacing: 4) {
                Text("REST")
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
                Text("Next: \(recommendationText(state.nextSetRecommendation))")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                if #available(iOSApplicationExtension 17.0, *) {
                    RestAdjustControls(workoutId: workoutId, accent: accent)
                        .padding(.top, 2)
                }
            }
            Spacer()
        }
    }
}

private struct TimerCircle: View {
    let state: RestTimerAttributes.ContentState
    let accent: Color

    var body: some View {
        TimelineView(.periodic(from: Date(), by: 1)) { timeline in
            let remaining = remainingSeconds(endDateMs: state.endDateMs, at: timeline.date)
            let progress = timerProgress(state: state, remainingSeconds: remaining)

            ZStack {
                Circle()
                    .stroke(accent.opacity(0.22), lineWidth: 5)
                Circle()
                    .trim(from: 0, to: progress)
                    .stroke(accent, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(.linear(duration: 0.95), value: progress)
                Text(formatRemaining(remaining))
                    .font(.system(size: 18, weight: .heavy, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(accent)
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                    .frame(width: 48, height: 24, alignment: .center)
            }
            .frame(width: 68, height: 68, alignment: .center)
        }
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
private struct TimerText: View {
    let endDateMs: Double
    let accent: Color

    var body: some View {
        TimelineView(.periodic(from: Date(), by: 1)) { timeline in
            Text(formatRemaining(remainingSeconds(endDateMs: endDateMs, at: timeline.date)))
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
    let setNumber = max(1, state.setNumber + 1)
    return state.totalSets > 0 ? "Set \(setNumber) of \(state.totalSets)" : "Set \(setNumber)"
}

private func recommendationText(_ text: String) -> String {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? "Recommendation loading" : trimmed
}
