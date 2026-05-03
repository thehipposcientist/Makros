import Foundation
import WidgetKit

private struct ThalloComplicationPayload: Codable {
    let focus: String
    let workoutStatus: String?
    let durationMinutes: Int?
    let exerciseCount: Int?
    let readiness: Int?
    let readinessLabel: String?
    let hydrationOunces: Double?
    let hydrationTargetOunces: Double?
    let dateISO: String
    let updatedAtMs: Double
}

enum ThalloComplicationSync {
    static let suiteName = "group.com.thallo.app"
    static let payloadKey = "thallo.complication.payload"

    static func update(
        workout: WatchWorkout?,
        hydration: WatchHydrationDay?,
        readiness: WatchReadinessSnapshot?
    ) {
        let payload = ThalloComplicationPayload(
            focus: displayFocus(workout),
            workoutStatus: workout?.status.rawValue,
            durationMinutes: workout?.durationMinutes,
            exerciseCount: workout?.exercises.count,
            readiness: readiness?.score ?? workout?.readiness,
            readinessLabel: readiness?.label ?? workout?.readinessLabel,
            hydrationOunces: hydration?.ounces,
            hydrationTargetOunces: hydration?.targetOunces,
            dateISO: workout?.dateISO ?? hydration?.dateISO ?? localDateISO(),
            updatedAtMs: Date().timeIntervalSince1970 * 1000
        )
        guard let data = try? JSONEncoder().encode(payload) else { return }
        sharedDefaults().set(data, forKey: payloadKey)
        WidgetCenter.shared.reloadAllTimelines()
    }

    static func clear() {
        sharedDefaults().removeObject(forKey: payloadKey)
        WidgetCenter.shared.reloadAllTimelines()
    }

    private static func displayFocus(_ workout: WatchWorkout?) -> String {
        guard let workout else { return "Open Thallo" }
        switch workout.status {
        case .completed:
            return "Done"
        case .skipped:
            return "Skipped"
        case .rest:
            return "Rest Day"
        case .active, .scheduled:
            return workout.focus.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "Workout"
                : workout.focus
        }
    }

    private static func sharedDefaults() -> UserDefaults {
        UserDefaults(suiteName: suiteName) ?? .standard
    }

    private static func localDateISO(_ date: Date = Date()) -> String {
        let comps = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", comps.year ?? 1970, comps.month ?? 1, comps.day ?? 1)
    }
}
