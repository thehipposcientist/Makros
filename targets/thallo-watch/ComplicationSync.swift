import Foundation
import WidgetKit

private struct ThalloComplicationPayload: Codable {
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
    let stepsToday: Int?
    let stepGoal: Int?
    let dateISO: String
    let updatedAtMs: Double
}

enum ThalloComplicationSync {
    static let suiteName = "group.com.thallo.app"
    static let payloadKey = "thallo.complication.payload"

    static func update(
        workout: WatchWorkout?,
        hydration: WatchHydrationDay?,
        activity: WatchActivityDay?,
        readiness: WatchReadinessSnapshot?,
        sleep: WatchSleepSnapshot?
    ) {
        // Merge incoming values with whatever is already cached so a
        // partial update (e.g. only hydration changed) doesn't blank
        // the other complications. Without this, the next sleep-only
        // sync would write nil hydration on top of the good cached
        // value, causing the Hydration complication to flash to "--".
        let cached = loadCachedPayload()
        // Workout-derived fields collapse to nil when no workout was
        // pushed in this update; we then fall back to the cached value
        // so sleep/hydration-only updates don't blank the workout tile.
        let workoutFocusOrCached: String = {
            if let w = workout { return displayFocus(w) }
            return cached?.focus ?? "Open Thallo"
        }()
        let stepsTodayOrCached = activity != nil ? activity?.stepsToday : cached?.stepsToday
        let stepGoalOrCached = activity != nil ? activity?.stepGoal : cached?.stepGoal
        let payload = ThalloComplicationPayload(
            focus: workoutFocusOrCached,
            workoutStatus: workout?.status.rawValue ?? cached?.workoutStatus,
            durationMinutes: workout?.durationMinutes ?? cached?.durationMinutes,
            exerciseCount: workout?.exercises.count ?? cached?.exerciseCount,
            readiness: readiness?.score ?? cached?.readiness,
            readinessLabel: readiness?.label ?? cached?.readinessLabel,
            sleepScore: sleep?.score ?? cached?.sleepScore,
            sleepHours: sleep?.hoursLastNight ?? cached?.sleepHours,
            sleepLabel: sleep?.label ?? cached?.sleepLabel,
            hydrationOunces: hydration?.ounces ?? cached?.hydrationOunces,
            hydrationTargetOunces: hydration?.targetOunces ?? cached?.hydrationTargetOunces,
            stepsToday: stepsTodayOrCached,
            stepGoal: stepGoalOrCached,
            dateISO: workout?.dateISO
                ?? hydration?.dateISO
                ?? activity?.dateISO
                ?? cached?.dateISO
                ?? localDateISO(),
            updatedAtMs: Date().timeIntervalSince1970 * 1000
        )
        guard let data = try? JSONEncoder().encode(payload) else { return }
        sharedDefaults().set(data, forKey: payloadKey)
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// Read the last-written payload back so partial updates can merge
    /// rather than overwrite. Returns nil on first launch / after clear.
    private static func loadCachedPayload() -> ThalloComplicationPayload? {
        guard let data = sharedDefaults().data(forKey: payloadKey) else { return nil }
        return try? JSONDecoder().decode(ThalloComplicationPayload.self, from: data)
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
