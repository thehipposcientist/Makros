import ActivityKit
import Foundation

// Activity attributes are the STATIC data for the Live Activity — set once
// when the activity starts and never change. Dynamic values (remaining
// seconds, set recommendation) live in ContentState below.
public struct RestTimerAttributes: ActivityAttributes {
    public typealias RestTimerState = ContentState

    public struct ContentState: Codable, Hashable {
        // Timing context lets the widget animate the lock-screen ring locally
        // without needing update pushes every second.
        public var mode: String?
        public var startedAtMs: Double
        public var durationSeconds: Double
        public var endDateMs: Double
        public var exerciseName: String
        public var setNumber: Int
        public var totalSets: Int
        public var nextSetRecommendation: String
        public var themeColorHex: String
        public var paused: Bool?
        public var elapsedSeconds: Double?
        public var heartRate: Int?
        public var hrZone: Int?
        public var hrZoneLabel: String?
        public var hrZoneLow: Int?
        public var hrZoneHigh: Int?
        public var hrZoneColorHex: String?
        // ── Cardio mode (mode == "cardio") ─────────────────────────
        // Optional fields populated for outdoor / indoor cardio
        // Live Activities. The widget renders the cardio variant
        // (time + distance + pace + calories) when distanceMeters
        // is non-nil; the rest / elapsed paths ignore them.
        public var distanceMeters: Double?
        public var paceSecPerKm: Double?
        public var activeCalories: Double?
        public var distanceUnit: String?  // "mi" or "km" — display preference

        public init(
            mode: String? = "rest",
            startedAtMs: Double,
            durationSeconds: Double,
            endDateMs: Double,
            exerciseName: String,
            setNumber: Int,
            totalSets: Int,
            nextSetRecommendation: String,
            themeColorHex: String,
            paused: Bool? = false,
            elapsedSeconds: Double? = 0,
            heartRate: Int? = nil,
            hrZone: Int? = nil,
            hrZoneLabel: String? = nil,
            hrZoneLow: Int? = nil,
            hrZoneHigh: Int? = nil,
            hrZoneColorHex: String? = nil,
            distanceMeters: Double? = nil,
            paceSecPerKm: Double? = nil,
            activeCalories: Double? = nil,
            distanceUnit: String? = nil
        ) {
            self.mode = mode
            self.startedAtMs = startedAtMs
            self.durationSeconds = durationSeconds
            self.endDateMs = endDateMs
            self.exerciseName = exerciseName
            self.setNumber = setNumber
            self.totalSets = totalSets
            self.nextSetRecommendation = nextSetRecommendation
            self.themeColorHex = themeColorHex
            self.paused = paused
            self.elapsedSeconds = elapsedSeconds
            self.heartRate = heartRate
            self.hrZone = hrZone
            self.hrZoneLabel = hrZoneLabel
            self.hrZoneLow = hrZoneLow
            self.hrZoneHigh = hrZoneHigh
            self.hrZoneColorHex = hrZoneColorHex
            self.distanceMeters = distanceMeters
            self.paceSecPerKm = paceSecPerKm
            self.activeCalories = activeCalories
            self.distanceUnit = distanceUnit
        }
    }

    // No static attributes — all state is dynamic. Required by ActivityKit
    // to have at least one field in the parent struct, so a dummy flag.
    public var workoutId: String

    public init(workoutId: String) {
        self.workoutId = workoutId
    }
}
