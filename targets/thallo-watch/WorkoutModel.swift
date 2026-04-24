// Trimmed-down workout model for the watch. The phone's
// `WorkoutDay` shape is much richer (micronutrients, image URLs,
// archetype metadata, etc.). None of that is useful at the wrist, so
// we send a slim struct over WatchConnectivity and decode here.

import Foundation

struct WatchExercise: Codable, Identifiable, Equatable {
    var id: String { name }
    let name: String
    let sets: Int
    let reps: String
    let restSeconds: Int
    let equipment: String?
    let plannedTargetWeightLbs: Double?
    // Pre-set AI recommendation line pushed from the phone. When
    // present, the active-workout view renders it as a subtitle below
    // the set counter ("Start with 135 × 8, RIR 2").
    let recommendation: String?
}

struct WatchWorkout: Codable, Equatable {
    let focus: String
    let durationMinutes: Int
    let dateISO: String
    let exercises: [WatchExercise]
    /// Last mutation timestamp so we can ignore stale messages that
    /// arrive out of order after a phone reconnect.
    let syncedAtMs: Double
}
