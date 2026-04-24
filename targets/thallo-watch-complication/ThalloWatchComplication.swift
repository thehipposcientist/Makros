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

import WidgetKit
import SwiftUI

// MARK: - Shared payload

private struct ComplicationPayload: Codable {
    let focus: String           // "Push" / "Rest" / "Run"
    let readiness: Int?         // 0-100, optional
    let sessionsPlanned: Int    // weekly target
    let sessionsDone: Int       // count this week
    let updatedAtMs: Double
}

private let kPayloadKey = "thallo.complication.payload"

private func loadPayload() -> ComplicationPayload {
    let defaults = UserDefaults(suiteName: "group.com.thallo.app") ?? .standard
    if let data = defaults.data(forKey: kPayloadKey),
       let decoded = try? JSONDecoder().decode(ComplicationPayload.self, from: data) {
        return decoded
    }
    // Empty-state fallback — shows up before the watch app has
    // pushed any data. Don't render an error state; the host face
    // is supposed to look "OK, nothing scheduled" not broken.
    return ComplicationPayload(
        focus: "Open Thallo",
        readiness: nil,
        sessionsPlanned: 0,
        sessionsDone: 0,
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
                Text(p.focus.prefix(4).uppercased())
                    .font(.system(size: 11, weight: .heavy))
                if let r = p.readiness {
                    Text("\(r)")
                        .font(.system(size: 16, weight: .black, design: .rounded))
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
            HStack(spacing: 4) {
                if let r = p.readiness {
                    Text("\(r) READY")
                        .font(.system(size: 10, weight: .heavy))
                        .widgetAccentable()
                }
                Text("· \(p.sessionsDone)/\(p.sessionsPlanned)")
                    .font(.system(size: 10))
            }
        }
    }
}

private struct InlineView: View {
    let p: ComplicationPayload
    var body: some View {
        if let r = p.readiness {
            Text("Thallo · \(p.focus) · \(r)")
        } else {
            Text("Thallo · \(p.focus)")
        }
    }
}

// MARK: - Widget

private struct ThalloComplicationView: View {
    let entry: ThalloEntry
    @Environment(\.widgetFamily) var family
    var body: some View {
        switch family {
        case .accessoryCircular: CircularView(p: entry.payload)
        case .accessoryRectangular: RectangularView(p: entry.payload)
        case .accessoryInline: InlineView(p: entry.payload)
        default: InlineView(p: entry.payload)
        }
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
