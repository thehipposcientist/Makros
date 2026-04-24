// Trimmed-down workout + meal models for the watch. The phone's shapes
// are much richer (micronutrients, image URLs, archetype metadata);
// none of that is useful at the wrist, so we send slim structs over
// WatchConnectivity and decode here.

import Foundation

// ─── Workout ─────────────────────────────────────────────────────────

struct WatchExercise: Codable, Identifiable, Equatable {
    var id: String { name }
    let name: String
    let sets: Int
    let reps: String
    let restSeconds: Int
    let equipment: String?
    let plannedTargetWeightLbs: Double?
    let recommendation: String?
}

/// Lifecycle state of today's workout — the watch renders different
/// UI for each. Mirrors the phone's own state machine: `scheduled`
/// is the default, `active` is the in-progress session, `completed`
/// after the user finishes, `skipped` after tap-skip or swap-to-rest.
enum WatchWorkoutStatus: String, Codable {
    case scheduled
    case active
    case completed
    case skipped
    case rest
}

struct WatchWorkout: Codable, Equatable {
    let focus: String
    let durationMinutes: Int
    let dateISO: String
    let status: WatchWorkoutStatus
    let exercises: [WatchExercise]
    let syncedAtMs: Double
}

// ─── Meals ───────────────────────────────────────────────────────────

struct WatchMealItem: Codable, Identifiable, Equatable {
    var id: String { mealType }
    let mealType: String
    let name: String
    let calories: Int
    let proteinG: Int
    let carbsG: Int
    let fatG: Int
    let checked: Bool
}

struct WatchMealTargets: Codable, Equatable {
    let calories: Int
    let proteinG: Int
    let carbsG: Int
    let fatG: Int
}

struct WatchMealsDay: Codable, Equatable {
    let dateISO: String
    let targets: WatchMealTargets
    let actual: WatchMealTargets
    let meals: [WatchMealItem]
    let syncedAtMs: Double
}
