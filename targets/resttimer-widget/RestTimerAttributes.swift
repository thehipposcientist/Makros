import ActivityKit
import Foundation

// Activity attributes are the STATIC data for the Live Activity — set once
// when the activity starts and never change. Dynamic values (remaining
// seconds, set recommendation) live in ContentState below.
public struct RestTimerAttributes: ActivityAttributes {
    public typealias RestTimerState = ContentState

    public struct ContentState: Codable, Hashable {
        // Absolute end time (ms since epoch) so the widget can render a
        // live-ticking countdown via Text(timerInterval:) without needing
        // update pushes every second.
        public var endDateMs: Double
        public var exerciseName: String
        public var setNumber: Int
        public var totalSets: Int
        public var nextSetRecommendation: String
        public var themeColorHex: String

        public init(
            endDateMs: Double,
            exerciseName: String,
            setNumber: Int,
            totalSets: Int,
            nextSetRecommendation: String,
            themeColorHex: String
        ) {
            self.endDateMs = endDateMs
            self.exerciseName = exerciseName
            self.setNumber = setNumber
            self.totalSets = totalSets
            self.nextSetRecommendation = nextSetRecommendation
            self.themeColorHex = themeColorHex
        }
    }

    // No static attributes — all state is dynamic. Required by ActivityKit
    // to have at least one field in the parent struct, so a dummy flag.
    public var workoutId: String

    public init(workoutId: String) {
        self.workoutId = workoutId
    }
}
