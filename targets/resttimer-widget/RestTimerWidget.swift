import ActivityKit
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
            LockScreenView(state: context.state)
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
                        Text("Set \(context.state.setNumber) of \(context.state.totalSets)")
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
                    Text(context.state.nextSetRecommendation)
                        .font(.footnote)
                        .foregroundStyle(.white)
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
    var accent: Color { Color(hex: state.themeColorHex) }

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                Circle()
                    .stroke(accent.opacity(0.25), lineWidth: 4)
                Circle()
                    .trim(from: 0, to: 1)
                    .stroke(accent, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                TimerText(endDateMs: state.endDateMs, accent: accent)
                    .font(.system(size: 18, weight: .heavy, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(accent)
            }
            .frame(width: 64, height: 64)

            VStack(alignment: .leading, spacing: 4) {
                Text("REST")
                    .font(.system(size: 11, weight: .heavy))
                    .foregroundStyle(accent)
                    .tracking(1.5)
                Text(state.exerciseName)
                    .font(.headline)
                    .foregroundStyle(.white)
                    .lineLimit(1)
                Text("Set \(state.setNumber + 1) of \(state.totalSets) · \(state.nextSetRecommendation)")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.75))
                    .lineLimit(2)
            }
            Spacer()
        }
    }
}

// Renders a live-ticking countdown without requiring per-second push
// updates — SwiftUI's Text(timerInterval:countsDown:) handles the tick
// itself using the provided end date.
private struct TimerText: View {
    let endDateMs: Double
    let accent: Color

    var body: some View {
        let end = Date(timeIntervalSince1970: endDateMs / 1000.0)
        Text(timerInterval: Date()...end, countsDown: true)
            .foregroundStyle(accent)
    }
}
