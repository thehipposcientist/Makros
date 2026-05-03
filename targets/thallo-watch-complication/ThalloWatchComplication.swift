// Watch complication for the Thallo app. Renders today's workout
// focus + readiness score in three accessory styles:
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
    let hydrationOunces: Double?
    let hydrationTargetOunces: Double?
    let dateISO: String?
    let updatedAtMs: Double
}

private let kSuiteName = "group.com.thallo.app"
private let kPayloadKey = "thallo.complication.payload"
private let kOpenURL = URL(string: "thallowatch://open")!
private let kStartWorkoutURL = URL(string: "thallowatch://start-workout")!
private let kHydrationAddURL = URL(string: "thallowatch://hydration/add?oz=8")!

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

private struct CircularView: View {
    let p: ComplicationPayload
    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Text(shortFocus(p.focus))
                    .font(.system(size: 11, weight: .heavy))
                if let r = p.readiness {
                    Text("\(r)")
                        .font(.system(size: 16, weight: .black, design: .rounded))
                } else if let hydration = hydrationPercent(p) {
                    Text("\(hydration)%")
                        .font(.system(size: 13, weight: .black, design: .rounded))
                }
            }
        }
    }
}

private struct RectangularView: View {
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
                    Text("\(r) RDY")
                        .font(.system(size: 10, weight: .heavy))
                        .widgetAccentable()
                }
                if let hydration = hydrationPercent(p) {
                    Text("\(hydration)% H2O")
                        .font(.system(size: 10, weight: .heavy))
                } else if let minutes = p.durationMinutes {
                    Text("\(minutes) min")
                        .font(.system(size: 10, weight: .heavy))
                }
            }
            HStack(spacing: 6) {
                actionLink(title: startTitle(p), systemImage: "figure.strengthtraining.traditional", url: kStartWorkoutURL)
                actionLink(title: "+8", systemImage: "drop.fill", url: kHydrationAddURL)
            }
            .padding(.top, 1)
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

private struct InlineView: View {
    let p: ComplicationPayload
    var body: some View {
        if let hydration = hydrationPercent(p), let r = p.readiness {
            Text("Thallo \(p.focus) \(r)R \(hydration)%H2O")
        } else if let r = p.readiness {
            Text("Thallo \(p.focus) \(r)R")
        } else if let hydration = hydrationPercent(p) {
            Text("Thallo \(p.focus) \(hydration)%H2O")
        } else {
            Text("Thallo \(p.focus)")
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

private func startTitle(_ p: ComplicationPayload) -> String {
    p.workoutStatus == "active" ? "Rejoin" : "Start"
}

// MARK: - Widget

private struct ThalloComplicationView: View {
    let entry: ThalloEntry
    @Environment(\.widgetFamily) var family
    var body: some View {
        Group {
            switch family {
            case .accessoryCircular: CircularView(p: entry.payload)
            case .accessoryRectangular: RectangularView(p: entry.payload)
            case .accessoryInline: InlineView(p: entry.payload)
            default: InlineView(p: entry.payload)
            }
        }
        .widgetURL(kOpenURL)
    }
}

@main
struct ThalloWatchComplication: Widget {
    let kind: String = "ThalloWatchComplication"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ThalloProvider()) { entry in
            ThalloComplicationView(entry: entry)
        }
        .configurationDisplayName("Thallo")
        .description("Today's workout focus + readiness on your watch face.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}
