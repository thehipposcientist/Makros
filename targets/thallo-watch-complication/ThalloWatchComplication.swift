// Watch complications for the Thallo app. Renders today's workout,
// readiness, sleep, and hydration in three accessory styles:
//   • accessoryCircular     — corner of the watch face
//   • accessoryRectangular  — Smart Stack / modular face
//   • accessoryInline       — single-line text complication
//
// Data source: SharedDefaults — the main watch app writes a JSON blob
// into UserDefaults on every WCSession update so the complication
// timeline can read it without its own WCSession (extensions can't
// reliably keep WCSession alive). Provider refreshes on a 30-min
// timeline + on every workout / meal push from the phone (the
// watch app calls WidgetCenter.shared.reloadAllTimelines()).

import Foundation
import WidgetKit
import SwiftUI

// MARK: - Shared payload

private struct ComplicationPayload: Codable {
    let focus: String
    let workoutStatus: String?
    let durationMinutes: Int?
    let exerciseCount: Int?
    let readiness: Int?
    let readinessLabel: String?
    let sleepScore: Int?
    let sleepHours: Double?
    let sleepLabel: String?
    let hydrationOunces: Double?
    let hydrationTargetOunces: Double?
    let dateISO: String?
    let updatedAtMs: Double
}

private let kSuiteName = "group.com.thallo.app"
private let kPayloadKey = "thallo.complication.payload"
private let kOpenURL = URL(string: "thallowatch://open")!
private let kStartWorkoutURL = URL(string: "thallowatch://start-workout")!
private let kHydrationURL = URL(string: "thallowatch://hydration")!

private func loadPayload() -> ComplicationPayload {
    let defaults = UserDefaults(suiteName: kSuiteName) ?? .standard
    if let data = defaults.data(forKey: kPayloadKey),
       let decoded = try? JSONDecoder().decode(ComplicationPayload.self, from: data) {
        return decoded
    }
    // Empty-state fallback — shows up before the watch app has
    // pushed any data. Don't render an error state; the host face
    // is supposed to look "OK, nothing scheduled" not broken.
    return ComplicationPayload(
        focus: "Open Thallo",
        workoutStatus: nil,
        durationMinutes: nil,
        exerciseCount: nil,
        readiness: nil,
        readinessLabel: nil,
        sleepScore: nil,
        sleepHours: nil,
        sleepLabel: nil,
        hydrationOunces: nil,
        hydrationTargetOunces: nil,
        dateISO: nil,
        updatedAtMs: 0,
    )
}

// MARK: - Timeline provider

private struct ThalloEntry: TimelineEntry {
    let date: Date
    let payload: ComplicationPayload
}

private struct ThalloProvider: TimelineProvider {
    func placeholder(in context: Context) -> ThalloEntry {
        ThalloEntry(date: Date(), payload: loadPayload())
    }
    func getSnapshot(in context: Context, completion: @escaping (ThalloEntry) -> Void) {
        completion(ThalloEntry(date: Date(), payload: loadPayload()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<ThalloEntry>) -> Void) {
        // Single entry now + refresh every 30 min. The watch app calls
        // WidgetCenter.reloadAllTimelines() on every WCSession update
        // so the complication picks up new payloads instantly when
        // the watch app is open; the 30-min cadence is just a safety
        // net for users who haven't opened the watch app today.
        let entry = ThalloEntry(date: Date(), payload: loadPayload())
        let next = Calendar.current.date(byAdding: .minute, value: 30, to: Date()) ?? Date()
        completion(Timeline(entries: [entry], policy: .after(next)))
    }
}

// MARK: - Views

private enum ComplicationMode {
    case daily
    case workout
    case readiness
    case sleep
    case hydration
}

private struct CircularView: View {
    let p: ComplicationPayload
    let mode: ComplicationMode

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            circularMetric
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private var circularMetric: some View {
        switch mode {
        case .readiness:
            MetricStack(label: "RDY", value: scoreText(p.readiness), systemImage: "bolt.fill")
        case .sleep:
            MetricStack(label: "SLP", value: scoreText(p.sleepScore) ?? sleepHoursText(p), systemImage: "moon.zzz.fill")
        case .hydration:
            MetricStack(label: "H2O", value: percentText(hydrationPercent(p)), systemImage: "drop.fill")
        case .workout:
            MetricStack(label: shortFocus(p.focus), value: workoutCircularValue(p), systemImage: "figure.strengthtraining.traditional")
        case .daily:
            if let r = p.readiness {
                MetricStack(label: shortFocus(p.focus), value: "\(r)", systemImage: nil)
            } else if let sleep = p.sleepScore {
                MetricStack(label: "SLP", value: "\(sleep)", systemImage: "moon.zzz.fill")
            } else {
                MetricStack(label: shortFocus(p.focus), value: percentText(hydrationPercent(p)), systemImage: nil)
            }
        }
    }
}

private struct RectangularView: View {
    let p: ComplicationPayload
    let mode: ComplicationMode

    var body: some View {
        switch mode {
        case .daily:
            DailyRectangularView(p: p)
        case .workout:
            WorkoutRectangularView(p: p)
        case .readiness:
            ScoreRectangularView(
                title: "READINESS",
                value: scoreText(p.readiness) ?? "--",
                label: p.readinessLabel ?? "Training",
                systemImage: "bolt.fill"
            )
        case .sleep:
            ScoreRectangularView(
                title: "SLEEP",
                value: scoreText(p.sleepScore) ?? sleepHoursText(p) ?? "--",
                label: p.sleepLabel ?? "Last night",
                systemImage: "moon.zzz.fill"
            )
        case .hydration:
            HydrationRectangularView(p: p)
        }
    }
}

private struct DailyRectangularView: View {
    let p: ComplicationPayload

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("THALLO")
                .font(.system(size: 9, weight: .heavy))
                .tracking(0.8)
                .widgetAccentable()
            Text(p.focus)
                .font(.system(size: 14, weight: .heavy))
                .lineLimit(1)
            HStack(spacing: 5) {
                if let r = p.readiness {
                    metricText("\(r) RDY", accent: true)
                }
                if let sleep = p.sleepScore {
                    metricText("\(sleep) SLP")
                }
                if let hydration = hydrationPercent(p) {
                    metricText("\(hydration)% H2O")
                } else if let minutes = p.durationMinutes {
                    metricText("\(minutes) min")
                }
            }
            HStack(spacing: 6) {
                actionLink(title: startTitle(p), systemImage: "figure.strengthtraining.traditional", url: kStartWorkoutURL)
                actionLink(title: "Water", systemImage: "drop.fill", url: kHydrationURL)
            }
            .padding(.top, 1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .multilineTextAlignment(.leading)
    }

    @ViewBuilder
    private func metricText(_ title: String, accent: Bool = false) -> some View {
        let text = Text(title)
            .font(.system(size: 10, weight: .heavy))
            .lineLimit(1)
        if accent {
            text.widgetAccentable()
        } else {
            text
        }
    }

    private func actionLink(title: String, systemImage: String, url: URL) -> some View {
        Link(destination: url) {
            HStack(spacing: 2) {
                Image(systemName: systemImage)
                    .font(.system(size: 8, weight: .heavy))
                Text(title)
                    .font(.system(size: 9, weight: .heavy))
                    .lineLimit(1)
            }
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(.quaternary, in: Capsule())
        }
    }
}

private struct WorkoutRectangularView: View {
    let p: ComplicationPayload

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("WORKOUT")
                .font(.system(size: 9, weight: .heavy))
                .tracking(0.8)
                .widgetAccentable()
            Text(p.focus)
                .font(.system(size: 15, weight: .heavy))
                .lineLimit(1)
            HStack(spacing: 5) {
                if let minutes = p.durationMinutes, minutes > 0 {
                    Text("\(minutes) min")
                }
                if let count = p.exerciseCount, count > 0 {
                    Text("\(count) moves")
                }
            }
            .font(.system(size: 10, weight: .heavy))
            .lineLimit(1)
            Link(destination: kStartWorkoutURL) {
                Label(startTitle(p), systemImage: "figure.strengthtraining.traditional")
                    .font(.system(size: 9, weight: .heavy))
                    .lineLimit(1)
            }
            .padding(.top, 1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .multilineTextAlignment(.leading)
    }
}

private struct ScoreRectangularView: View {
    let title: String
    let value: String
    let label: String
    let systemImage: String

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Image(systemName: systemImage)
                .font(.system(size: 14, weight: .heavy))
                .widgetAccentable()
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.system(size: 9, weight: .heavy))
                    .tracking(0.8)
                    .widgetAccentable()
                Text(value)
                    .font(.system(size: 23, weight: .black, design: .rounded))
                    .lineLimit(1)
                Text(label)
                    .font(.system(size: 10, weight: .heavy))
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .multilineTextAlignment(.leading)
    }
}

private struct HydrationRectangularView: View {
    let p: ComplicationPayload

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("HYDRATION")
                .font(.system(size: 9, weight: .heavy))
                .tracking(0.8)
                .widgetAccentable()
            HStack(alignment: .lastTextBaseline, spacing: 4) {
                Text(percentText(hydrationPercent(p)) ?? "--")
                    .font(.system(size: 23, weight: .black, design: .rounded))
                Text("H2O")
                    .font(.system(size: 10, weight: .heavy))
            }
            if let ounces = p.hydrationOunces, let target = p.hydrationTargetOunces {
                Text("\(Int(ounces.rounded())) / \(Int(target.rounded())) oz")
                    .font(.system(size: 10, weight: .heavy))
                    .lineLimit(1)
            }
            Link(destination: kHydrationURL) {
                Label("Open", systemImage: "drop.fill")
                    .font(.system(size: 9, weight: .heavy))
                    .lineLimit(1)
            }
            .padding(.top, 1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .multilineTextAlignment(.leading)
    }
}

private struct InlineView: View {
    let p: ComplicationPayload
    let mode: ComplicationMode

    var body: some View {
        switch mode {
        case .readiness:
            Text("Thallo Ready \(scoreText(p.readiness) ?? "--")")
        case .sleep:
            Text("Thallo Sleep \(scoreText(p.sleepScore) ?? sleepHoursText(p) ?? "--")")
        case .hydration:
            Text("Thallo Water \(percentText(hydrationPercent(p)) ?? "--")")
        case .workout:
            Text("Thallo \(p.focus) \(workoutInlineDetail(p))")
        case .daily:
            if let hydration = hydrationPercent(p), let r = p.readiness {
                Text("Thallo \(p.focus) \(r)R \(hydration)%H2O")
            } else if let r = p.readiness {
                Text("Thallo \(p.focus) \(r)R")
            } else if let sleep = p.sleepScore {
                Text("Thallo \(p.focus) \(sleep)S")
            } else if let hydration = hydrationPercent(p) {
                Text("Thallo \(p.focus) \(hydration)%H2O")
            } else {
                Text("Thallo \(p.focus)")
            }
        }
    }
}

private struct MetricStack: View {
    let label: String
    let value: String?
    let systemImage: String?

    var body: some View {
        VStack(spacing: 0) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 10, weight: .heavy))
                    .widgetAccentable()
            }
            Text(label)
                .font(.system(size: 9, weight: .heavy))
                .lineLimit(1)
            if let value {
                Text(value)
                    .font(.system(size: 16, weight: .black, design: .rounded))
                    .lineLimit(1)
            }
        }
    }
}

private func hydrationPercent(_ p: ComplicationPayload) -> Int? {
    guard let ounces = p.hydrationOunces,
          let target = p.hydrationTargetOunces,
          target > 0
    else { return nil }
    return min(999, max(0, Int(((ounces / target) * 100).rounded())))
}

private func shortFocus(_ focus: String) -> String {
    String(focus.prefix(4)).uppercased()
}

private func scoreText(_ value: Int?) -> String? {
    guard let value else { return nil }
    return "\(value)"
}

private func percentText(_ value: Int?) -> String? {
    guard let value else { return nil }
    return "\(value)%"
}

private func sleepHoursText(_ p: ComplicationPayload) -> String? {
    guard let hours = p.sleepHours else { return nil }
    return String(format: "%.1fh", hours)
}

private func workoutCircularValue(_ p: ComplicationPayload) -> String? {
    if p.workoutStatus == "completed" { return "Done" }
    if p.workoutStatus == "skipped" { return "Skip" }
    if p.workoutStatus == "rest" { return "Rest" }
    if let minutes = p.durationMinutes, minutes > 0 { return "\(minutes)" }
    return nil
}

private func workoutInlineDetail(_ p: ComplicationPayload) -> String {
    if p.workoutStatus == "active" { return "Active" }
    if p.workoutStatus == "completed" { return "Done" }
    if p.workoutStatus == "skipped" { return "Skipped" }
    if p.workoutStatus == "rest" { return "Rest" }
    if let minutes = p.durationMinutes, minutes > 0 { return "\(minutes)m" }
    return ""
}

private func startTitle(_ p: ComplicationPayload) -> String {
    p.workoutStatus == "active" ? "Rejoin" : "Start"
}

// MARK: - Widget

private struct ThalloComplicationView: View {
    let entry: ThalloEntry
    let mode: ComplicationMode
    @Environment(\.widgetFamily) var family
    var body: some View {
        Group {
            switch family {
            case .accessoryCircular: CircularView(p: entry.payload, mode: mode)
            case .accessoryRectangular: RectangularView(p: entry.payload, mode: mode)
            case .accessoryInline: InlineView(p: entry.payload, mode: mode)
            default: InlineView(p: entry.payload, mode: mode)
            }
        }
        .widgetURL(kOpenURL)
    }
}

private struct ThalloDailyComplication: Widget {
    let kind: String = "ThalloWatchComplication"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ThalloProvider()) { entry in
            ThalloComplicationView(entry: entry, mode: .daily)
        }
        .configurationDisplayName("Thallo")
        .description("Workout, readiness, sleep, and water at a glance.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

private struct ThalloWorkoutComplication: Widget {
    let kind: String = "ThalloWorkoutComplication"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ThalloProvider()) { entry in
            ThalloComplicationView(entry: entry, mode: .workout)
        }
        .configurationDisplayName("Thallo Workout")
        .description("Today's workout focus and start shortcut.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

private struct ThalloReadinessComplication: Widget {
    let kind: String = "ThalloReadinessComplication"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ThalloProvider()) { entry in
            ThalloComplicationView(entry: entry, mode: .readiness)
        }
        .configurationDisplayName("Thallo Readiness")
        .description("Training readiness score.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

private struct ThalloSleepComplication: Widget {
    let kind: String = "ThalloSleepComplication"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ThalloProvider()) { entry in
            ThalloComplicationView(entry: entry, mode: .sleep)
        }
        .configurationDisplayName("Thallo Sleep")
        .description("Sleep score or last night's sleep duration.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

private struct ThalloHydrationComplication: Widget {
    let kind: String = "ThalloHydrationComplication"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ThalloProvider()) { entry in
            ThalloComplicationView(entry: entry, mode: .hydration)
        }
        .configurationDisplayName("Thallo Water")
        .description("Hydration progress and quick access to water logging.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

@main
struct ThalloComplicationBundle: WidgetBundle {
    var body: some Widget {
        ThalloDailyComplication()
        ThalloWorkoutComplication()
        ThalloReadinessComplication()
        ThalloSleepComplication()
        ThalloHydrationComplication()
    }
}
