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

    func decodeFlexibleBoolIfPresent(forKey key: Key) -> Bool? {
        if let v = try? decodeIfPresent(Bool.self, forKey: key) { return v }
        if let i = try? decodeIfPresent(Int.self, forKey: key) { return i != 0 }
        if let d = try? decodeIfPresent(Double.self, forKey: key), d.isFinite { return d != 0 }
        if let s = try? decodeIfPresent(String.self, forKey: key) {
            let cleaned = s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if ["true", "yes", "1", "done", "completed"].contains(cleaned) { return true }
            if ["false", "no", "0"].contains(cleaned) { return false }
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
        case name, equipment, primaryMuscle, primary_muscle, overlap, _overlap, overlapPercent, overlap_percentage, matchPercent, match_percentage
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name = c.decodeFlexibleStringIfPresent(forKey: .name) ?? "Exercise"
        self.equipment = c.decodeFlexibleStringIfPresent(forKey: .equipment)
        self.primaryMuscle = c.decodeFlexibleStringIfPresent(forKey: .primaryMuscle)
            ?? c.decodeFlexibleStringIfPresent(forKey: .primary_muscle)
        let rawOverlap = c.decodeFlexibleIntIfPresent(forKey: .overlap)
            ?? c.decodeFlexibleIntIfPresent(forKey: ._overlap)
            ?? c.decodeFlexibleIntIfPresent(forKey: .overlapPercent)
            ?? c.decodeFlexibleIntIfPresent(forKey: .overlap_percentage)
            ?? c.decodeFlexibleIntIfPresent(forKey: .matchPercent)
            ?? c.decodeFlexibleIntIfPresent(forKey: .match_percentage)
        self.overlap = rawOverlap.map { min(100, max(0, $0)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encodeIfPresent(equipment, forKey: .equipment)
        try c.encodeIfPresent(primaryMuscle, forKey: .primaryMuscle)
        try c.encodeIfPresent(overlap, forKey: .overlap)
    }
}

struct WatchExercise: Codable, Identifiable, Equatable {
    var id: String { clientExerciseId ?? name }
    let clientExerciseId: String?
    let name: String
    let slug: String?
    let sets: Int
    let reps: String
    let restSeconds: Int
    let equipment: String?
    let primaryMuscle: String?
    let secondaryMuscles: [String]?
    let isCompound: Bool?
    let movementPattern: String?
    let loadUnit: String?
    let plannedTargetWeightLbs: Double?
    let tracksWeight: Bool?
    let isTimed: Bool?
    let plannedDurationSeconds: Int?
    let recommendation: String?
    let recommendedReps: String?
    let completedSets: Int?
    let isDone: Bool?
    let isGuide: Bool?
    /// "warmup" | "primary" | "secondary" | "isolation" | "core" | "cooldown"
    /// — shown as a badge on the active card so the user knows to
    /// dial intensity up or down for that slot. Optional for back-compat.
    let slotRole: String?
    let slotLabel: String?
    let prescriptionType: String?
    /// Phone-ranked same-slot substitutions. The watch only displays
    /// these and sends the chosen name back; the phone validates and
    /// applies the swap to keep planner metadata authoritative.
    let swapOptions: [WatchSwapOption]

    enum CodingKeys: String, CodingKey {
        case clientExerciseId, name, slug, sets, reps, restSeconds, equipment, primaryMuscle, secondaryMuscles, isCompound, movementPattern, loadUnit, plannedTargetWeightLbs, tracksWeight, isTimed, plannedDurationSeconds, recommendation, recommendedReps, completedSets, isDone, isGuide, slotRole, slotLabel, prescriptionType, swapOptions
    }

    init(
        clientExerciseId: String? = nil,
        name: String,
        slug: String? = nil,
        sets: Int,
        reps: String,
        restSeconds: Int,
        equipment: String?,
        primaryMuscle: String? = nil,
        secondaryMuscles: [String]? = nil,
        isCompound: Bool? = nil,
        movementPattern: String? = nil,
        loadUnit: String? = nil,
        plannedTargetWeightLbs: Double?,
        tracksWeight: Bool? = nil,
        isTimed: Bool? = nil,
        plannedDurationSeconds: Int? = nil,
        recommendation: String?,
        recommendedReps: String? = nil,
        completedSets: Int? = nil,
        isDone: Bool? = nil,
        isGuide: Bool?,
        slotRole: String?,
        slotLabel: String? = nil,
        prescriptionType: String? = nil,
        swapOptions: [WatchSwapOption] = []
    ) {
        self.clientExerciseId = clientExerciseId
        self.name = name
        self.slug = slug
        self.sets = sets
        self.reps = reps
        self.restSeconds = restSeconds
        self.equipment = equipment
        self.primaryMuscle = primaryMuscle
        self.secondaryMuscles = secondaryMuscles
        self.isCompound = isCompound
        self.movementPattern = movementPattern
        self.loadUnit = loadUnit
        self.plannedTargetWeightLbs = plannedTargetWeightLbs
        self.tracksWeight = tracksWeight
        self.isTimed = isTimed
        self.plannedDurationSeconds = plannedDurationSeconds
        self.recommendation = recommendation
        self.recommendedReps = recommendedReps
        self.completedSets = completedSets
        self.isDone = isDone
        self.isGuide = isGuide
        self.slotRole = slotRole
        self.slotLabel = slotLabel
        self.prescriptionType = prescriptionType
        self.swapOptions = swapOptions
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.clientExerciseId = c.decodeFlexibleStringIfPresent(forKey: .clientExerciseId)
        self.name = c.decodeFlexibleStringIfPresent(forKey: .name) ?? "Exercise"
        self.slug = c.decodeFlexibleStringIfPresent(forKey: .slug)
        self.sets = max(0, c.decodeFlexibleIntIfPresent(forKey: .sets) ?? 1)
        self.reps = c.decodeFlexibleStringIfPresent(forKey: .reps) ?? ""
        self.restSeconds = max(0, c.decodeFlexibleIntIfPresent(forKey: .restSeconds) ?? 60)
        self.equipment = c.decodeFlexibleStringIfPresent(forKey: .equipment)
        self.primaryMuscle = c.decodeFlexibleStringIfPresent(forKey: .primaryMuscle)
        self.secondaryMuscles = try? c.decodeIfPresent([String].self, forKey: .secondaryMuscles)
        self.isCompound = c.decodeFlexibleBoolIfPresent(forKey: .isCompound)
        self.movementPattern = c.decodeFlexibleStringIfPresent(forKey: .movementPattern)
        self.loadUnit = c.decodeFlexibleStringIfPresent(forKey: .loadUnit)
        self.plannedTargetWeightLbs = c.decodeFlexibleDoubleIfPresent(forKey: .plannedTargetWeightLbs)
        self.tracksWeight = try? c.decodeIfPresent(Bool.self, forKey: .tracksWeight)
        self.isTimed = try? c.decodeIfPresent(Bool.self, forKey: .isTimed)
        if let plannedDurationSeconds = c.decodeFlexibleIntIfPresent(forKey: .plannedDurationSeconds), plannedDurationSeconds > 0 {
            self.plannedDurationSeconds = plannedDurationSeconds
        } else {
            self.plannedDurationSeconds = nil
        }
        self.recommendation = c.decodeFlexibleStringIfPresent(forKey: .recommendation)
        self.recommendedReps = c.decodeFlexibleStringIfPresent(forKey: .recommendedReps)
        if let completedSets = c.decodeFlexibleIntIfPresent(forKey: .completedSets) {
            self.completedSets = max(0, completedSets)
        } else {
            self.completedSets = nil
        }
        self.isDone = c.decodeFlexibleBoolIfPresent(forKey: .isDone)
        self.isGuide = try? c.decodeIfPresent(Bool.self, forKey: .isGuide)
        self.slotRole = c.decodeFlexibleStringIfPresent(forKey: .slotRole)
        self.slotLabel = c.decodeFlexibleStringIfPresent(forKey: .slotLabel)
        self.prescriptionType = c.decodeFlexibleStringIfPresent(forKey: .prescriptionType)
        self.swapOptions = (try? c.decodeIfPresent([WatchSwapOption].self, forKey: .swapOptions)) ?? []
    }

    var tracksWeightInput: Bool {
        if let tracksWeight = tracksWeight {
            return tracksWeight
        }
        let nameText = name.lowercased()
        if watchTextMatches(nameText, "farmer|suitcase carry|loaded carry") {
            return true
        }
        let primary = (primaryMuscle ?? "").lowercased()
        if primary == "cardio" || primary == "mobility" || primary == "recovery" {
            return false
        }
        let prescription = (prescriptionType ?? "").lowercased()
        if watchTextMatches(prescription, "cardio|conditioning|mobility|stretch|recovery|cooldown|flow|duration|timed") {
            return false
        }
        let equipmentText = (equipment ?? "").lowercased()
        let equipmentTokens = equipmentText
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && $0 != "optional" }
        if let first = equipmentTokens.first, ["bodyweight", "body weight", "none", "bw"].contains(first) {
            return false
        }
        if !equipmentTokens.isEmpty,
           equipmentTokens.allSatisfy({ watchTextMatches($0, "resistance[ _-]?bands?\\b|^bands?$|mini[ _-]?band|loop[ _-]?band") }) {
            return false
        }
        if watchTextMatches(nameText, "stretch|foam.?roll|cat.?cow|pigeon|child.?s pose|spinal.?twist|world.?s greatest|90.?90|thoracic|downward.?dog|cobra|butterfly|savasana|yoga|vinyasa|\\byin\\b|\\bflow\\b|mobility|pose\\b|breathwork|breathing|meditation") {
            return false
        }
        if watchTextMatches(nameText, "treadmill|stationary bike|elliptical|rowing machine|stair climber|assault bike|battle ropes|jump rope|sprint|jogging|running|cycling|swimming|hiit|intervals|mountain climber|hill sprint|cardio|zone ?2|tempo|steady state|long run|boxing|kickboxing|martial.?arts|mma|sparring|bag.?work|shadow.?box") {
            return false
        }
        return true
    }
}

private func watchTextMatches(_ text: String, _ pattern: String) -> Bool {
    text.range(of: pattern, options: .regularExpression) != nil
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

struct WatchHRZone: Codable, Equatable, Identifiable {
    var id: Int { zone }
    let zone: Int
    let label: String
    let low: Int
    let high: Int

    enum CodingKeys: String, CodingKey {
        case zone, label, low, high
    }

    init(zone: Int, label: String, low: Int, high: Int) {
        self.zone = zone
        self.label = label
        self.low = low
        self.high = high
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.zone = c.decodeFlexibleIntIfPresent(forKey: .zone) ?? 0
        self.label = c.decodeFlexibleStringIfPresent(forKey: .label) ?? ""
        self.low = c.decodeFlexibleIntIfPresent(forKey: .low) ?? 0
        self.high = c.decodeFlexibleIntIfPresent(forKey: .high) ?? 0
    }
}

struct WatchWorkout: Codable, Equatable {
    let focus: String
    let stimulus: String?
    let sourceContext: String?
    let templateId: String?
    let planDayId: Int?
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
    /// Phone-computed HR zones from the same endpoint used for cardio
    /// prescriptions. The watch uses these for live zone display so
    /// "current zone" matches "recommended zone".
    let hrZones: [WatchHRZone]?
    let syncedAtMs: Double
    /// Owning user id. Optional for back-compat — when present and
    /// non-empty, ConnectivityStore rejects workouts that don't match
    /// the currently stored userId, preventing cross-account leakage.
    let userId: String?

    enum CodingKeys: String, CodingKey {
        case focus, stimulus, sourceContext, templateId, planDayId, durationMinutes, dateISO, status, sessionId, readiness, readinessLabel, exercises, warmupSteps, hrZones, syncedAtMs, userId
    }

    init(
        focus: String,
        stimulus: String? = nil,
        sourceContext: String? = nil,
        templateId: String? = nil,
        planDayId: Int? = nil,
        durationMinutes: Int,
        dateISO: String,
        status: WatchWorkoutStatus,
        sessionId: String?,
        readiness: Int?,
        readinessLabel: String?,
        exercises: [WatchExercise],
        warmupSteps: [String]?,
        hrZones: [WatchHRZone]?,
        syncedAtMs: Double,
        userId: String?
    ) {
        self.focus = focus
        self.stimulus = stimulus
        self.sourceContext = sourceContext
        self.templateId = templateId
        self.planDayId = planDayId
        self.durationMinutes = durationMinutes
        self.dateISO = dateISO
        self.status = status
        self.sessionId = sessionId
        self.readiness = readiness
        self.readinessLabel = readinessLabel
        self.exercises = exercises
        self.warmupSteps = warmupSteps
        self.hrZones = hrZones
        self.syncedAtMs = syncedAtMs
        self.userId = userId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.focus = c.decodeFlexibleStringIfPresent(forKey: .focus) ?? "Workout"
        self.stimulus = c.decodeFlexibleStringIfPresent(forKey: .stimulus)
        self.sourceContext = c.decodeFlexibleStringIfPresent(forKey: .sourceContext)
        self.templateId = c.decodeFlexibleStringIfPresent(forKey: .templateId)
        self.planDayId = c.decodeFlexibleIntIfPresent(forKey: .planDayId)
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
        let decodedZones = (try? c.decodeIfPresent([WatchHRZone].self, forKey: .hrZones)) ?? []
        self.hrZones = decodedZones
            .filter { $0.zone >= 1 && $0.zone <= 5 && $0.low > 0 && $0.high >= $0.low }
            .sorted { $0.zone < $1.zone }
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

private func watchFlexibleInt(_ value: Any?) -> Int? {
    if let i = value as? Int { return i }
    if let d = value as? Double, d.isFinite { return Int(d.rounded()) }
    if let n = value as? NSNumber {
        let d = n.doubleValue
        return d.isFinite ? Int(d.rounded()) : nil
    }
    if let s = value as? String {
        let cleaned = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if let i = Int(cleaned) { return i }
        if let d = Double(cleaned), d.isFinite { return Int(d.rounded()) }
    }
    return nil
}

private func watchFlexibleBool(_ value: Any?) -> Bool? {
    if let b = value as? Bool { return b }
    if let n = value as? NSNumber { return n.boolValue }
    if let s = value as? String {
        let cleaned = s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if ["true", "yes", "1", "done", "completed"].contains(cleaned) { return true }
        if ["false", "no", "0"].contains(cleaned) { return false }
    }
    return nil
}

func watchCompletedExerciseIndexes(from raw: Any?) -> Set<Int> {
    guard let raw else { return [] }
    var result = Set<Int>()
    if let values = raw as? [Any] {
        for value in values {
            if let index = watchFlexibleInt(value), index >= 0 {
                result.insert(index)
            } else if let row = value as? [String: Any],
                      let index = watchFlexibleInt(row["exerciseIndex"]),
                      watchFlexibleBool(row["isDone"]) == true {
                result.insert(index)
            } else if let row = value as? NSDictionary,
                      let index = watchFlexibleInt(row["exerciseIndex"]),
                      watchFlexibleBool(row["isDone"]) == true {
                result.insert(index)
            }
        }
    } else if let index = watchFlexibleInt(raw), index >= 0 {
        result.insert(index)
    }
    return result
}

func watchProgressCompletedExerciseIndexes(_ progress: [String: Any]?, workout: WatchWorkout? = nil) -> Set<Int> {
    guard let progress else { return [] }
    if let workout {
        guard workout.status == .active else { return [] }
        if let workoutSessionId = workout.sessionId?.trimmingCharacters(in: .whitespacesAndNewlines),
           !workoutSessionId.isEmpty,
           let progressSessionId = progress["sessionId"] as? String,
           !progressSessionId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           progressSessionId.trimmingCharacters(in: .whitespacesAndNewlines) != workoutSessionId {
            return []
        }
    }
    return watchCompletedExerciseIndexes(from: progress["completedExerciseIndexes"])
        .union(watchCompletedExerciseIndexes(from: progress["exerciseCompletion"]))
}

func watchExerciseIsDone(_ exercise: WatchExercise, at index: Int, progress: [String: Any]? = nil, workout: WatchWorkout? = nil) -> Bool {
    if exercise.isDone == true { return true }
    if let completedSets = exercise.completedSets, completedSets >= max(1, exercise.sets) {
        return true
    }
    return watchProgressCompletedExerciseIndexes(progress, workout: workout).contains(index)
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

// ─── Templates ──────────────────────────────────────────────────────
//
// Saved-templates list synced to the watch so the user can start a
// strength workout from the Strength picker without picking up the
// phone. Mirrors the JS-side WatchTemplatesPayload — see
// modules/thallo-watch-bridge/index.ts. Both sides MUST stay in sync;
// adding a field here requires adding it on the JS side too.

struct WatchTemplateExercise: Codable, Equatable {
    let name: String
    let sets: Int
    let reps: String
    let restSeconds: Int?
    let equipment: String?
    let primaryMuscle: String?
    let secondaryMuscles: [String]?
    let isCompound: Bool?
    let movementPattern: String?
    let imageUrl: String?
    let videoId: String?
    let demoExerciseDbId: String?
    let slug: String?

    enum CodingKeys: String, CodingKey {
        case name, sets, reps, restSeconds, equipment, primaryMuscle, secondaryMuscles, isCompound, movementPattern, imageUrl, videoId, demoExerciseDbId, slug
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name = c.decodeFlexibleStringIfPresent(forKey: .name) ?? "Exercise"
        self.sets = max(0, c.decodeFlexibleIntIfPresent(forKey: .sets) ?? 0)
        self.reps = c.decodeFlexibleStringIfPresent(forKey: .reps) ?? "8-12"
        if let restSeconds = c.decodeFlexibleIntIfPresent(forKey: .restSeconds), restSeconds >= 0 {
            self.restSeconds = restSeconds
        } else {
            self.restSeconds = nil
        }
        self.equipment = c.decodeFlexibleStringIfPresent(forKey: .equipment)
        self.primaryMuscle = c.decodeFlexibleStringIfPresent(forKey: .primaryMuscle)
        self.secondaryMuscles = (try? c.decodeIfPresent([String].self, forKey: .secondaryMuscles))?
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        self.isCompound = try? c.decodeIfPresent(Bool.self, forKey: .isCompound)
        self.movementPattern = c.decodeFlexibleStringIfPresent(forKey: .movementPattern)
        self.imageUrl = c.decodeFlexibleStringIfPresent(forKey: .imageUrl)
        self.videoId = c.decodeFlexibleStringIfPresent(forKey: .videoId)
        self.demoExerciseDbId = c.decodeFlexibleStringIfPresent(forKey: .demoExerciseDbId)
        self.slug = c.decodeFlexibleStringIfPresent(forKey: .slug)
    }
}

struct WatchTemplate: Codable, Equatable {
    let id: String
    let name: String
    let focus: String
    let exercises: [WatchTemplateExercise]
}

struct WatchTemplatesDay: Codable, Equatable {
    let templates: [WatchTemplate]
    let syncedAtMs: Double
}

// ─── Daily activity ─────────────────────────────────────────────────

struct WatchActivityDay: Codable, Equatable {
    let dateISO: String
    let stepsToday: Int?
    let stepGoal: Int?
    let syncedAtMs: Double

    enum CodingKeys: String, CodingKey {
        case dateISO, stepsToday, stepGoal, syncedAtMs
    }

    init(dateISO: String, stepsToday: Int?, stepGoal: Int? = nil, syncedAtMs: Double) {
        self.dateISO = dateISO
        self.stepsToday = stepsToday.map { max(0, $0) }
        self.stepGoal = stepGoal.map { max(0, $0) }
        self.syncedAtMs = syncedAtMs
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.dateISO = c.decodeFlexibleStringIfPresent(forKey: .dateISO) ?? String(ISO8601DateFormatter().string(from: Date()).prefix(10))
        if let steps = c.decodeFlexibleIntIfPresent(forKey: .stepsToday) {
            self.stepsToday = max(0, steps)
        } else {
            self.stepsToday = nil
        }
        if let goal = c.decodeFlexibleIntIfPresent(forKey: .stepGoal) {
            self.stepGoal = max(0, goal)
        } else {
            self.stepGoal = nil
        }
        self.syncedAtMs = c.decodeFlexibleDoubleIfPresent(forKey: .syncedAtMs) ?? Date().timeIntervalSince1970 * 1000
    }
}

// ─── Hydration ──────────────────────────────────────────────────────

struct WatchHydrationDay: Codable, Equatable {
    let dateISO: String
    let ounces: Double
    let targetOunces: Double
    let targetOuncesMin: Double?
    let targetOuncesMax: Double?
    let syncedAtMs: Double

    enum CodingKeys: String, CodingKey {
        case dateISO, ounces, targetOunces, target_ounces, targetOuncesMin, targetOuncesMax, target_ounces_min, target_ounces_max, syncedAtMs
    }

    init(dateISO: String, ounces: Double, targetOunces: Double, targetOuncesMin: Double? = nil, targetOuncesMax: Double? = nil, syncedAtMs: Double) {
        self.dateISO = dateISO
        self.ounces = ounces
        self.targetOunces = targetOunces
        self.targetOuncesMin = targetOuncesMin
        self.targetOuncesMax = targetOuncesMax
        self.syncedAtMs = syncedAtMs
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.dateISO = c.decodeFlexibleStringIfPresent(forKey: .dateISO) ?? String(ISO8601DateFormatter().string(from: Date()).prefix(10))
        self.ounces = max(0, c.decodeFlexibleDoubleIfPresent(forKey: .ounces) ?? 0)
        self.targetOunces = max(0, c.decodeFlexibleDoubleIfPresent(forKey: .targetOunces)
            ?? c.decodeFlexibleDoubleIfPresent(forKey: .target_ounces)
            ?? 64)
        self.targetOuncesMin = c.decodeFlexibleDoubleIfPresent(forKey: .targetOuncesMin)
            ?? c.decodeFlexibleDoubleIfPresent(forKey: .target_ounces_min)
        self.targetOuncesMax = c.decodeFlexibleDoubleIfPresent(forKey: .targetOuncesMax)
            ?? c.decodeFlexibleDoubleIfPresent(forKey: .target_ounces_max)
        self.syncedAtMs = c.decodeFlexibleDoubleIfPresent(forKey: .syncedAtMs) ?? Date().timeIntervalSince1970 * 1000
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(dateISO, forKey: .dateISO)
        try c.encode(ounces, forKey: .ounces)
        try c.encode(targetOunces, forKey: .targetOunces)
        try c.encodeIfPresent(targetOuncesMin, forKey: .targetOuncesMin)
        try c.encodeIfPresent(targetOuncesMax, forKey: .targetOuncesMax)
        try c.encode(syncedAtMs, forKey: .syncedAtMs)
    }
}

// ─── Lifestyle factors ─────────────────────────────────────────────

struct WatchLifestyleDay: Codable, Equatable {
    let dateISO: String
    let hasLog: Bool
    let alcoholLevel: String?
    let alcoholDrinks: Double?
    let alcoholTiming: String?
    let cannabisLevel: String?
    let cannabisTiming: String?
    let bowelMovementCount: Int?
    let bowelConsistency: String?
    let stressLevel: String?
    let illnessState: String?
    let caffeineMg: Double?
    let caffeineTiming: String?
    let lateCaffeine: Bool?
    let appetite: String?
    let syncedAtMs: Double

    enum CodingKeys: String, CodingKey {
        case dateISO, hasLog, alcoholLevel, alcoholDrinks, alcoholTiming
        case cannabisLevel, cannabisTiming, bowelMovementCount, bowelConsistency
        case stressLevel, illnessState, caffeineMg, caffeineTiming, lateCaffeine
        case appetite, syncedAtMs
    }

    init(
        dateISO: String,
        hasLog: Bool,
        alcoholLevel: String? = nil,
        alcoholDrinks: Double? = nil,
        alcoholTiming: String? = nil,
        cannabisLevel: String? = nil,
        cannabisTiming: String? = nil,
        bowelMovementCount: Int? = nil,
        bowelConsistency: String? = nil,
        stressLevel: String? = nil,
        illnessState: String? = nil,
        caffeineMg: Double? = nil,
        caffeineTiming: String? = nil,
        lateCaffeine: Bool? = nil,
        appetite: String? = nil,
        syncedAtMs: Double
    ) {
        self.dateISO = dateISO
        self.hasLog = hasLog
        self.alcoholLevel = alcoholLevel
        self.alcoholDrinks = alcoholDrinks
        self.alcoholTiming = alcoholTiming
        self.cannabisLevel = cannabisLevel
        self.cannabisTiming = cannabisTiming
        self.bowelMovementCount = bowelMovementCount
        self.bowelConsistency = bowelConsistency
        self.stressLevel = stressLevel
        self.illnessState = illnessState
        self.caffeineMg = caffeineMg
        self.caffeineTiming = caffeineTiming
        self.lateCaffeine = lateCaffeine
        self.appetite = appetite
        self.syncedAtMs = syncedAtMs
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.dateISO = c.decodeFlexibleStringIfPresent(forKey: .dateISO) ?? String(ISO8601DateFormatter().string(from: Date()).prefix(10))
        self.hasLog = c.decodeFlexibleBoolIfPresent(forKey: .hasLog) ?? false
        self.alcoholLevel = c.decodeFlexibleStringIfPresent(forKey: .alcoholLevel)
        self.alcoholDrinks = c.decodeFlexibleDoubleIfPresent(forKey: .alcoholDrinks)
        self.alcoholTiming = c.decodeFlexibleStringIfPresent(forKey: .alcoholTiming)
        self.cannabisLevel = c.decodeFlexibleStringIfPresent(forKey: .cannabisLevel)
        self.cannabisTiming = c.decodeFlexibleStringIfPresent(forKey: .cannabisTiming)
        self.bowelMovementCount = c.decodeFlexibleIntIfPresent(forKey: .bowelMovementCount)
        self.bowelConsistency = c.decodeFlexibleStringIfPresent(forKey: .bowelConsistency)
        self.stressLevel = c.decodeFlexibleStringIfPresent(forKey: .stressLevel)
        self.illnessState = c.decodeFlexibleStringIfPresent(forKey: .illnessState)
        self.caffeineMg = c.decodeFlexibleDoubleIfPresent(forKey: .caffeineMg)
        self.caffeineTiming = c.decodeFlexibleStringIfPresent(forKey: .caffeineTiming)
        self.lateCaffeine = c.decodeFlexibleBoolIfPresent(forKey: .lateCaffeine)
        self.appetite = c.decodeFlexibleStringIfPresent(forKey: .appetite)
        self.syncedAtMs = c.decodeFlexibleDoubleIfPresent(forKey: .syncedAtMs) ?? Date().timeIntervalSince1970 * 1000
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
    let groupLabel: String?
    let taken: Bool
    let skipped: Bool

    private var cleanGroupLabel: String? {
        let trimmed = (groupLabel ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private var cleanTiming: String? {
        let trimmed = (timing ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    var groupKind: String {
        if cleanGroupLabel != nil { return "custom" }
        if cleanTiming != nil { return "timing" }
        return "other"
    }

    var groupKey: String {
        if let label = cleanGroupLabel { return "c:\(label.lowercased())" }
        if let timing = cleanTiming { return "t:\(timing)" }
        return "other"
    }

    var groupDisplayLabel: String {
        if let label = cleanGroupLabel { return label }
        if let timing = cleanTiming {
            return timing.replacingOccurrences(of: "_", with: " ").capitalized
        }
        return "Other"
    }
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

// ─── Flexible decoders for the strict payload structs ────────────────
//
// These channels previously relied on Swift's synthesized (strict)
// Codable. A single type drift from the phone — a macro arriving as
// 30.5 instead of 31, a null, or a missing key — would throw and
// silently drop the ENTIRE channel (call sites decode with `try?`),
// blanking nutrition / supplements / readiness on the wrist. The
// workout decoder already tolerates this via the flexible helpers;
// these extensions bring the remaining channels to the same standard.
// Both sides still agree on key names — this only widens the accepted
// value types so a rounding change on the phone can't blank a tab.
// (Defined in extensions so the memberwise initializers are preserved.)

extension WatchMealParseItem {
    enum CodingKeys: String, CodingKey { case name, serving, calories, protein, carbs, fat }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            name: c.decodeFlexibleStringIfPresent(forKey: .name) ?? "",
            serving: c.decodeFlexibleStringIfPresent(forKey: .serving) ?? "",
            calories: c.decodeFlexibleIntIfPresent(forKey: .calories) ?? 0,
            protein: c.decodeFlexibleIntIfPresent(forKey: .protein) ?? 0,
            carbs: c.decodeFlexibleIntIfPresent(forKey: .carbs) ?? 0,
            fat: c.decodeFlexibleIntIfPresent(forKey: .fat) ?? 0
        )
    }
}

extension WatchMealItem {
    enum CodingKeys: String, CodingKey { case mealType, name, calories, proteinG, carbsG, fatG, checked }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            mealType: c.decodeFlexibleStringIfPresent(forKey: .mealType) ?? "",
            name: c.decodeFlexibleStringIfPresent(forKey: .name) ?? "",
            calories: c.decodeFlexibleIntIfPresent(forKey: .calories) ?? 0,
            proteinG: c.decodeFlexibleIntIfPresent(forKey: .proteinG) ?? 0,
            carbsG: c.decodeFlexibleIntIfPresent(forKey: .carbsG) ?? 0,
            fatG: c.decodeFlexibleIntIfPresent(forKey: .fatG) ?? 0,
            checked: c.decodeFlexibleBoolIfPresent(forKey: .checked) ?? false
        )
    }
}

extension WatchMealTargets {
    enum CodingKeys: String, CodingKey { case calories, proteinG, carbsG, fatG }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            calories: c.decodeFlexibleIntIfPresent(forKey: .calories) ?? 0,
            proteinG: c.decodeFlexibleIntIfPresent(forKey: .proteinG) ?? 0,
            carbsG: c.decodeFlexibleIntIfPresent(forKey: .carbsG) ?? 0,
            fatG: c.decodeFlexibleIntIfPresent(forKey: .fatG) ?? 0
        )
    }
}

extension WatchMealsDay {
    enum CodingKeys: String, CodingKey { case dateISO, targets, actual, score, meals, syncedAtMs }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let zero = WatchMealTargets(calories: 0, proteinG: 0, carbsG: 0, fatG: 0)
        self.init(
            dateISO: c.decodeFlexibleStringIfPresent(forKey: .dateISO) ?? "",
            targets: (try? c.decodeIfPresent(WatchMealTargets.self, forKey: .targets)) ?? zero,
            actual: (try? c.decodeIfPresent(WatchMealTargets.self, forKey: .actual)) ?? zero,
            score: c.decodeFlexibleIntIfPresent(forKey: .score),
            meals: (try? c.decodeIfPresent([WatchMealItem].self, forKey: .meals)) ?? [],
            syncedAtMs: c.decodeFlexibleDoubleIfPresent(forKey: .syncedAtMs) ?? 0
        )
    }
}

extension WatchSupplementItem {
    enum CodingKeys: String, CodingKey { case id, name, dose, timing, groupLabel, taken, skipped }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: c.decodeFlexibleIntIfPresent(forKey: .id) ?? 0,
            name: c.decodeFlexibleStringIfPresent(forKey: .name) ?? "",
            dose: c.decodeFlexibleStringIfPresent(forKey: .dose),
            timing: c.decodeFlexibleStringIfPresent(forKey: .timing),
            groupLabel: c.decodeFlexibleStringIfPresent(forKey: .groupLabel),
            taken: c.decodeFlexibleBoolIfPresent(forKey: .taken) ?? false,
            skipped: c.decodeFlexibleBoolIfPresent(forKey: .skipped) ?? false
        )
    }
}

extension WatchSupplementsDay {
    enum CodingKeys: String, CodingKey { case dateISO, items, syncedAtMs }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            dateISO: c.decodeFlexibleStringIfPresent(forKey: .dateISO) ?? "",
            items: (try? c.decodeIfPresent([WatchSupplementItem].self, forKey: .items)) ?? [],
            syncedAtMs: c.decodeFlexibleDoubleIfPresent(forKey: .syncedAtMs) ?? 0
        )
    }
}

extension WatchReadinessFactor {
    enum CodingKeys: String, CodingKey { case label, value, status, detail }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            label: c.decodeFlexibleStringIfPresent(forKey: .label) ?? "",
            value: c.decodeFlexibleIntIfPresent(forKey: .value) ?? 0,
            status: c.decodeFlexibleStringIfPresent(forKey: .status) ?? "ok",
            detail: c.decodeFlexibleStringIfPresent(forKey: .detail)
        )
    }
}

extension WatchReadinessSnapshot {
    enum CodingKeys: String, CodingKey { case score, label, summary, factors, syncedAtMs }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            score: c.decodeFlexibleIntIfPresent(forKey: .score),
            label: c.decodeFlexibleStringIfPresent(forKey: .label),
            summary: c.decodeFlexibleStringIfPresent(forKey: .summary),
            factors: (try? c.decodeIfPresent([WatchReadinessFactor].self, forKey: .factors)) ?? [],
            syncedAtMs: c.decodeFlexibleDoubleIfPresent(forKey: .syncedAtMs) ?? 0
        )
    }
}
