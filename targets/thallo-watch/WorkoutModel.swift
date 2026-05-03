// Trimmed-down workout + meal models for the watch. The phone's shapes
// are much richer (micronutrients, image URLs, archetype metadata);
// none of that is useful at the wrist, so we send slim structs over
// WatchConnectivity and decode here.

import Foundation

private extension KeyedDecodingContainer {
    func decodeFlexibleIntIfPresent(forKey key: Key) -> Int? {
        if let v = try? decodeIfPresent(Int.self, forKey: key) { return v }
        if let v = try? decodeIfPresent(Double.self, forKey: key), v.isFinite { return Int(v.rounded()) }
        if let s = try? decodeIfPresent(String.self, forKey: key) {
            let cleaned = s.trimmingCharacters(in: .whitespacesAndNewlines)
            if let i = Int(cleaned) { return i }
            if let d = Double(cleaned), d.isFinite { return Int(d.rounded()) }
        }
        return nil
    }

    func decodeFlexibleDoubleIfPresent(forKey key: Key) -> Double? {
        if let v = try? decodeIfPresent(Double.self, forKey: key), v.isFinite { return v }
        if let v = try? decodeIfPresent(Int.self, forKey: key) { return Double(v) }
        if let s = try? decodeIfPresent(String.self, forKey: key) {
            let cleaned = s.trimmingCharacters(in: .whitespacesAndNewlines)
            if let d = Double(cleaned), d.isFinite { return d }
        }
        return nil
    }

    func decodeFlexibleStringIfPresent(forKey key: Key) -> String? {
        if let s = try? decodeIfPresent(String.self, forKey: key) {
            let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        if let i = try? decodeIfPresent(Int.self, forKey: key) { return String(i) }
        if let d = try? decodeIfPresent(Double.self, forKey: key), d.isFinite {
            return d.rounded() == d ? String(Int(d)) : String(d)
        }
        return nil
    }
}

// ─── Workout ─────────────────────────────────────────────────────────

struct WatchSwapOption: Codable, Identifiable, Equatable {
    var id: String { name }
    let name: String
    let equipment: String?
    let primaryMuscle: String?
    let overlap: Int?

    enum CodingKeys: String, CodingKey {
        case name, equipment, primaryMuscle, overlap
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name = c.decodeFlexibleStringIfPresent(forKey: .name) ?? "Exercise"
        self.equipment = c.decodeFlexibleStringIfPresent(forKey: .equipment)
        self.primaryMuscle = c.decodeFlexibleStringIfPresent(forKey: .primaryMuscle)
        self.overlap = c.decodeFlexibleIntIfPresent(forKey: .overlap)
    }
}

struct WatchExercise: Codable, Identifiable, Equatable {
    var id: String { name }
    let name: String
    let sets: Int
    let reps: String
    let restSeconds: Int
    let equipment: String?
    let plannedTargetWeightLbs: Double?
    let recommendation: String?
    let isGuide: Bool?
    /// "warmup" | "primary" | "secondary" | "isolation" | "core" | "cooldown"
    /// — shown as a badge on the active card so the user knows to
    /// dial intensity up or down for that slot. Optional for back-compat.
    let slotRole: String?
    /// Phone-ranked same-slot substitutions. The watch only displays
    /// these and sends the chosen name back; the phone validates and
    /// applies the swap to keep planner metadata authoritative.
    let swapOptions: [WatchSwapOption]

    enum CodingKeys: String, CodingKey {
        case name, sets, reps, restSeconds, equipment, plannedTargetWeightLbs, recommendation, isGuide, slotRole, swapOptions
    }

    init(
        name: String,
        sets: Int,
        reps: String,
        restSeconds: Int,
        equipment: String?,
        plannedTargetWeightLbs: Double?,
        recommendation: String?,
        isGuide: Bool?,
        slotRole: String?,
        swapOptions: [WatchSwapOption] = []
    ) {
        self.name = name
        self.sets = sets
        self.reps = reps
        self.restSeconds = restSeconds
        self.equipment = equipment
        self.plannedTargetWeightLbs = plannedTargetWeightLbs
        self.recommendation = recommendation
        self.isGuide = isGuide
        self.slotRole = slotRole
        self.swapOptions = swapOptions
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name = c.decodeFlexibleStringIfPresent(forKey: .name) ?? "Exercise"
        self.sets = max(1, c.decodeFlexibleIntIfPresent(forKey: .sets) ?? 1)
        self.reps = c.decodeFlexibleStringIfPresent(forKey: .reps) ?? ""
        self.restSeconds = max(0, c.decodeFlexibleIntIfPresent(forKey: .restSeconds) ?? 60)
        self.equipment = c.decodeFlexibleStringIfPresent(forKey: .equipment)
        self.plannedTargetWeightLbs = c.decodeFlexibleDoubleIfPresent(forKey: .plannedTargetWeightLbs)
        self.recommendation = c.decodeFlexibleStringIfPresent(forKey: .recommendation)
        self.isGuide = try? c.decodeIfPresent(Bool.self, forKey: .isGuide)
        self.slotRole = c.decodeFlexibleStringIfPresent(forKey: .slotRole)
        self.swapOptions = (try? c.decodeIfPresent([WatchSwapOption].self, forKey: .swapOptions)) ?? []
    }
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
    /// Unique per-session identifier. Generated by the phone when a
    /// workout becomes active. The watch uses this to distinguish a
    /// fresh start from a stale `.active` lingering in applicationContext.
    let sessionId: String?
    /// 0-100 readiness score pushed from the phone's preparedness
    /// engine. Nil when HealthKit data is too thin to score.
    let readiness: Int?
    /// "Primed" / "Ready" / "Moderate" / "Fatigued" — same label the
    /// iOS TrainingReadinessCard uses. Shown on Today view as a chip.
    let readinessLabel: String?
    let exercises: [WatchExercise]
    /// Plain-text warm-up bullets from the phone's buildWarmupPlan
    /// (or AI warmup when it resolves). Shown as a dismissable card
    /// on the exercise tab before the first set. Nil / empty = no
    /// warmup (recovery / cardio / cold-start days).
    let warmupSteps: [String]?
    let syncedAtMs: Double
    /// Owning user id. Optional for back-compat — when present and
    /// non-empty, ConnectivityStore rejects workouts that don't match
    /// the currently stored userId, preventing cross-account leakage.
    let userId: String?

    enum CodingKeys: String, CodingKey {
        case focus, durationMinutes, dateISO, status, sessionId, readiness, readinessLabel, exercises, warmupSteps, syncedAtMs, userId
    }

    init(
        focus: String,
        durationMinutes: Int,
        dateISO: String,
        status: WatchWorkoutStatus,
        sessionId: String?,
        readiness: Int?,
        readinessLabel: String?,
        exercises: [WatchExercise],
        warmupSteps: [String]?,
        syncedAtMs: Double,
        userId: String?
    ) {
        self.focus = focus
        self.durationMinutes = durationMinutes
        self.dateISO = dateISO
        self.status = status
        self.sessionId = sessionId
        self.readiness = readiness
        self.readinessLabel = readinessLabel
        self.exercises = exercises
        self.warmupSteps = warmupSteps
        self.syncedAtMs = syncedAtMs
        self.userId = userId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.focus = c.decodeFlexibleStringIfPresent(forKey: .focus) ?? "Workout"
        self.durationMinutes = max(0, c.decodeFlexibleIntIfPresent(forKey: .durationMinutes) ?? 0)
        self.dateISO = c.decodeFlexibleStringIfPresent(forKey: .dateISO) ?? String(ISO8601DateFormatter().string(from: Date()).prefix(10))
        if let status = try? c.decodeIfPresent(WatchWorkoutStatus.self, forKey: .status) {
            self.status = status
        } else if let raw = c.decodeFlexibleStringIfPresent(forKey: .status),
                  let status = WatchWorkoutStatus(rawValue: raw.lowercased()) {
            self.status = status
        } else {
            self.status = .scheduled
        }
        self.sessionId = c.decodeFlexibleStringIfPresent(forKey: .sessionId)
        self.readiness = c.decodeFlexibleIntIfPresent(forKey: .readiness)
        self.readinessLabel = c.decodeFlexibleStringIfPresent(forKey: .readinessLabel)
        self.exercises = (try? c.decodeIfPresent([WatchExercise].self, forKey: .exercises)) ?? []
        self.warmupSteps = try? c.decodeIfPresent([String].self, forKey: .warmupSteps)
        self.syncedAtMs = c.decodeFlexibleDoubleIfPresent(forKey: .syncedAtMs) ?? Date().timeIntervalSince1970 * 1000
        self.userId = c.decodeFlexibleStringIfPresent(forKey: .userId)
    }
}

struct WatchWorkoutEnvelope: Codable, Equatable {
    let schemaVersion: Int
    let channel: String
    let eventId: String
    let revision: Double
    let reason: String?
    let sentAtMs: Double
    let userId: String?
    let workout: WatchWorkout

    enum CodingKeys: String, CodingKey {
        case schemaVersion, channel, eventId, revision, reason, sentAtMs, userId, workout
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.workout = try c.decode(WatchWorkout.self, forKey: .workout)
        self.schemaVersion = c.decodeFlexibleIntIfPresent(forKey: .schemaVersion) ?? 1
        self.channel = c.decodeFlexibleStringIfPresent(forKey: .channel) ?? "workout"
        self.revision = c.decodeFlexibleDoubleIfPresent(forKey: .revision) ?? self.workout.syncedAtMs
        self.eventId = c.decodeFlexibleStringIfPresent(forKey: .eventId) ?? "legacy-\(Int(self.revision))"
        self.reason = c.decodeFlexibleStringIfPresent(forKey: .reason)
        self.sentAtMs = c.decodeFlexibleDoubleIfPresent(forKey: .sentAtMs) ?? self.workout.syncedAtMs
        self.userId = c.decodeFlexibleStringIfPresent(forKey: .userId) ?? self.workout.userId
    }
}

// ─── Meals ───────────────────────────────────────────────────────────

/// A single AI-parsed food item pushed back to the watch for review
/// before the user confirms logging via speech-to-meal.
struct WatchMealParseItem: Codable, Identifiable, Equatable {
    var id: String { name + serving }
    let name: String
    let serving: String
    let calories: Int
    let protein: Int
    let carbs: Int
    let fat: Int
}

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
    /// 0-100 unified Nutrition Score (adherence + quality + micro).
    /// Matches what /meals/score returns on the phone. Nil when the
    /// day has no logged meals yet.
    let score: Int?
    let meals: [WatchMealItem]
    let syncedAtMs: Double
}

// ─── Hydration ──────────────────────────────────────────────────────

struct WatchHydrationDay: Codable, Equatable {
    let dateISO: String
    let ounces: Double
    let targetOunces: Double
    let syncedAtMs: Double

    enum CodingKeys: String, CodingKey {
        case dateISO, ounces, targetOunces, target_ounces, syncedAtMs
    }

    init(dateISO: String, ounces: Double, targetOunces: Double, syncedAtMs: Double) {
        self.dateISO = dateISO
        self.ounces = ounces
        self.targetOunces = targetOunces
        self.syncedAtMs = syncedAtMs
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.dateISO = c.decodeFlexibleStringIfPresent(forKey: .dateISO) ?? String(ISO8601DateFormatter().string(from: Date()).prefix(10))
        self.ounces = max(0, c.decodeFlexibleDoubleIfPresent(forKey: .ounces) ?? 0)
        self.targetOunces = max(0, c.decodeFlexibleDoubleIfPresent(forKey: .targetOunces)
            ?? c.decodeFlexibleDoubleIfPresent(forKey: .target_ounces)
            ?? 64)
        self.syncedAtMs = c.decodeFlexibleDoubleIfPresent(forKey: .syncedAtMs) ?? Date().timeIntervalSince1970 * 1000
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(dateISO, forKey: .dateISO)
        try c.encode(ounces, forKey: .ounces)
        try c.encode(targetOunces, forKey: .targetOunces)
        try c.encode(syncedAtMs, forKey: .syncedAtMs)
    }
}

// ─── Supplements ─────────────────────────────────────────────────────

struct WatchSupplementItem: Codable, Identifiable, Equatable {
    /// Stable per-stack-item id — matches the phone's StackItem.id so
    /// watch-originated "take" commands can round-trip to api.logDose
    /// without the watch needing to know the full product taxonomy.
    let id: Int
    let name: String
    let dose: String?       // pre-formatted "200 IU" / "5 g" etc
    let timing: String?     // "morning" / "with_food" / "post_workout"
    let taken: Bool
    let skipped: Bool
}

struct WatchSupplementsDay: Codable, Equatable {
    let dateISO: String
    let items: [WatchSupplementItem]
    let syncedAtMs: Double
}

// ─── Sleep ──────────────────────────────────────────────────────────

// ─── Readiness drill-down ──────────────────────────────────────────

struct WatchReadinessFactor: Codable, Equatable {
    /// "Sleep" / "RHR" / "HRV" / "Recovery" / "Fueling".
    let label: String
    /// 0–100 sub-score for that factor. Watch renders as a colored bar.
    let value: Int
    /// "good" / "ok" / "low" — drives the bar color independent of value.
    let status: String
    /// Short human note like "7.4h last night" or "elevated 4 bpm".
    let detail: String?
}

struct WatchReadinessSnapshot: Codable, Equatable {
    /// 0–100 composite readiness (mirrors the phone's TrainingReadinessCard).
    let score: Int?
    /// "Primed" / "Ready" / "Moderate" / "Fatigued" / "Hold" — same
    /// label set the phone surfaces.
    let label: String?
    /// One-line takeaway phrased like a coach.
    let summary: String?
    /// Per-factor breakdown so the user sees which signals are low.
    let factors: [WatchReadinessFactor]
    let syncedAtMs: Double
}

// ─── Body weight quick-log ─────────────────────────────────────────

struct WatchWeightSnapshot: Codable, Equatable {
    /// Most recently logged weight (lbs). Used to seed the Digital
    /// Crown wheel so the user lands on a sensible value.
    let latestLbs: Double?
    /// Days since the last log — drives the "log today" prompt.
    let daysSinceLastLog: Int?
    /// 7-day EMA trend for the headline display.
    let emaLbs: Double?
    /// Slope in lbs/wk — positive = gaining, negative = losing.
    let slopeLbsPerWeek: Double?
    let syncedAtMs: Double
}

struct WatchSleepSnapshot: Codable, Equatable {
    /// 0–100 sleep score. Mirrors the phone's `scoreSleep()` output.
    let score: Int?
    /// Hours slept last night (in-bed time, not strictly asleep).
    let hoursLastNight: Double?
    /// Minutes of asleep / awake / REM / deep / core if HK provided
    /// stage breakdown; nil otherwise.
    let asleepMin: Int?
    let remMin: Int?
    let deepMin: Int?
    /// Resting heart rate (latest 7-day average from HealthKit).
    /// Stored as Double because HealthKit returns fractional values (e.g. 62.5).
    let restingHr: Double?
    /// Average HRV over recent days (ms); nil if HRV not authorised.
    let hrvMs: Double?
    /// Short label: "Excellent" / "Good" / "OK" / "Low".
    let label: String?
    /// Brief one-line takeaway phrased like a coach's note.
    let summary: String?
    let syncedAtMs: Double
}
