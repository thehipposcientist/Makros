// Active workout screen — standalone. The watch owns the flow state
// (current exercise, current set, rest countdown) so users can run
// a full session from the wrist without touching the phone. Every
// logged set fires a command to the phone so its history stays in
// sync, but the watch doesn't WAIT for the phone to advance.
//
// Layout: TabView with two pages (swipe left/right):
//   • EXERCISE — current slot, set counter, Crown-driven weight +
//                reps inputs, Log Set button, rest timer, up-next
//                preview during rest.
//   • HEART    — live bpm + zone.
//
// End workout tells the phone to finalize. The watch does not block
// workout tracking on a HealthKit session; set logging stays local-first.

import SwiftUI
import Combine
import WatchKit
import Foundation
import UserNotifications

private struct WatchLocalRecommendation {
    let text: String
    let weightLbs: Double?
    let reps: String?
}

private func addExerciseCommandPayload(
    for exercise: WatchTemplateExercise,
    sessionId: String,
    clientExerciseId: String? = nil
) -> [String: Any] {
    let trimmed = exercise.name.trimmingCharacters(in: .whitespacesAndNewlines)
    var payload: [String: Any] = [
        "name": trimmed,
        "sessionId": sessionId,
        "sets": max(0, exercise.sets),
        "targetSets": max(0, exercise.sets),
        "reps": exercise.reps,
        "targetReps": exercise.reps,
        "tsMs": Date().timeIntervalSince1970 * 1000,
    ]
    if let clientExerciseId, !clientExerciseId.isEmpty {
        payload["clientExerciseId"] = clientExerciseId
    }
    if let restSeconds = exercise.restSeconds {
        payload["restSeconds"] = restSeconds
        payload["targetRestSeconds"] = restSeconds
    }
    if let equipment = exercise.equipment { payload["equipment"] = equipment }
    if let primaryMuscle = exercise.primaryMuscle { payload["primaryMuscle"] = primaryMuscle }
    if let secondaryMuscles = exercise.secondaryMuscles, !secondaryMuscles.isEmpty { payload["secondaryMuscles"] = secondaryMuscles }
    if let isCompound = exercise.isCompound { payload["isCompound"] = isCompound }
    if let movementPattern = exercise.movementPattern { payload["movementPattern"] = movementPattern }
    if let imageUrl = exercise.imageUrl { payload["imageUrl"] = imageUrl }
    if let videoId = exercise.videoId { payload["videoId"] = videoId }
    if let demoExerciseDbId = exercise.demoExerciseDbId { payload["demoExerciseDbId"] = demoExerciseDbId }
    if let slug = exercise.slug { payload["slug"] = slug }
    return payload
}

// ─── Flow state owned by the watch ─────────────────────────────────

final class ActiveWorkoutState: ObservableObject {
    @Published var exerciseIndex: Int = 0 { didSet { persist() } }
    @Published var setNumber: Int = 1 { didSet { persist() } }   // 1-indexed within the current exercise
    @Published var restRemaining: Int? = nil { didSet { persist() } }   // seconds; nil = not resting
    @Published var paused: Bool = false { didSet { persist() } }
    private var restEndAtMs: Double? = nil { didSet { persist() } }
    // Timestamp of the last natural rest expiry (set by reconcileRestClock).
    // Used to distinguish a phone-pushed "restRemainingSec: 0" that races
    // with the just-fired notification from a deliberate user skip — so
    // setRest(0) does not cancel the ding notification that is about to fire.
    private var restNaturallyEndedAtMs: Double = 0
    private var sessionId: String? = nil { didSet { persist() } }
    private var lastProgressRevision: Double = 0 { didSet { persist() } }
    // Log-set inputs. Seeded from the exercise's planned target on
    // entry so a first-time user already has a reasonable number.
    @Published var pendingWeight: Double = 0 { didSet { persist() } }
    @Published var pendingReps: Int = 0 { didSet { persist() } }
    // Cache of per-set logs so the user can see "last set: 135×8"
    // when dialing in the next set's weight.
    @Published var lastLoggedWeight: Double? = nil { didSet { persist() } }
    @Published var lastLoggedReps: Int? = nil { didSet { persist() } }
    @Published var currentRecommendation: String? = nil { didSet { persist() } }
    @Published var liveRecommendedWeightLbs: Double? = nil { didSet { persist() } }
    @Published var liveRecommendedReps: String? = nil { didSet { persist() } }
    @Published var completedExerciseIndexes: Set<Int> = [] { didSet { persist() } }
    @Published var timedTimerKey: String? = nil { didSet { persist() } }
    @Published var timedElapsedSeconds: Int = 0 { didSet { persist() } }
    @Published var timedTimerRunning: Bool = false { didSet { persist() } }
    private var timedStartedAtMs: Double? = nil { didSet { persist() } }
    private var sessionStartedAtMs: Double? = nil { didSet { persist() } }
    private var loggedSetsByExercise: [String: [[String: Any]]] = [:] { didSet { persist() } }
    private var lastAutoSeededWeight: Double? = nil
    private var lastAutoSeededReps: Int? = nil

    private var cancellables: Set<AnyCancellable> = []
    // Defaults key — persists across watch-app background / kill so
    // users mid-workout don't lose their place when iOS reclaims
    // memory or they background to glance at a notification.
    private static let kPersistKey = "thallo.activeWorkoutState"
    private var hydrating = false

    init() {
        hydrate()
        if let latest = ConnectivityStore.shared.latestProgress {
            var info: [AnyHashable: Any] = [:]
            for (key, value) in latest {
                info[AnyHashable(key)] = value
            }
            applyProgress(info)
        }
        // Still listen to phone progress pushes so if a user logs
        // a set on the phone the watch advances too.
        NotificationCenter.default.publisher(for: .watchProgressUpdate)
            .sink { [weak self] note in
                guard let self, let info = note.userInfo else { return }
                self.applyProgress(info)
            }
            .store(in: &cancellables)
    }

    /// Persist the in-memory flow state to UserDefaults. Called
    /// implicitly by every `@Published` setter via `didSet`. We
    /// intentionally serialise the whole struct on each change rather
    /// than diffing — the payload is tiny (~80 bytes) and watchOS
    /// background terminations can happen between any two writes.
    private func persist() {
        if hydrating { return }
        var blob: [String: Any] = [
            "exerciseIndex": exerciseIndex,
            "setNumber": setNumber,
            "paused": paused,
            "pendingWeight": pendingWeight,
            "pendingReps": pendingReps,
        ]
        if let restRemaining { blob["restRemaining"] = restRemaining }
        if let restEndAtMs { blob["restEndAtMs"] = restEndAtMs }
        if let sessionId { blob["sessionId"] = sessionId }
        if lastProgressRevision > 0 { blob["lastProgressRevision"] = lastProgressRevision }
        if let lastLoggedWeight { blob["lastLoggedWeight"] = lastLoggedWeight }
        if let lastLoggedReps { blob["lastLoggedReps"] = lastLoggedReps }
        if let currentRecommendation { blob["currentRecommendation"] = currentRecommendation }
        if let liveRecommendedWeightLbs { blob["liveRecommendedWeightLbs"] = liveRecommendedWeightLbs }
        if let liveRecommendedReps { blob["liveRecommendedReps"] = liveRecommendedReps }
        if !completedExerciseIndexes.isEmpty { blob["completedExerciseIndexes"] = completedExerciseIndexes.sorted() }
        if let timedTimerKey { blob["timedTimerKey"] = timedTimerKey }
        blob["timedElapsedSeconds"] = timedElapsedSeconds
        blob["timedTimerRunning"] = timedTimerRunning
        if let timedStartedAtMs { blob["timedStartedAtMs"] = timedStartedAtMs }
        if let sessionStartedAtMs { blob["sessionStartedAtMs"] = sessionStartedAtMs }
        if !loggedSetsByExercise.isEmpty { blob["loggedSetsByExercise"] = loggedSetsByExercise }
        UserDefaults.standard.set(blob, forKey: Self.kPersistKey)
    }

    private func hydrate() {
        guard let blob = UserDefaults.standard.dictionary(forKey: Self.kPersistKey) else { return }
        hydrating = true
        if let v = blob["exerciseIndex"] as? Int { exerciseIndex = v }
        if let v = blob["setNumber"] as? Int { setNumber = v }
        if let v = blob["restRemaining"] as? Int { restRemaining = v }
        if let v = blob["restEndAtMs"] as? Double { restEndAtMs = v }
        if let v = blob["sessionId"] as? String { sessionId = v }
        if let v = Self.flexibleDouble(blob["lastProgressRevision"]) { lastProgressRevision = v }
        if let v = blob["paused"] as? Bool { paused = v }
        if let v = blob["pendingWeight"] as? Double { pendingWeight = v }
        if let v = blob["pendingReps"] as? Int { pendingReps = v }
        if let v = blob["lastLoggedWeight"] as? Double { lastLoggedWeight = v }
        if let v = blob["lastLoggedReps"] as? Int { lastLoggedReps = v }
        if let v = blob["currentRecommendation"] as? String { currentRecommendation = v }
        if let v = Self.flexibleDouble(blob["liveRecommendedWeightLbs"]) { liveRecommendedWeightLbs = v }
        if let v = Self.flexibleString(blob["liveRecommendedReps"]) { liveRecommendedReps = v }
        completedExerciseIndexes = watchCompletedExerciseIndexes(from: blob["completedExerciseIndexes"])
        if let v = Self.flexibleString(blob["timedTimerKey"]) { timedTimerKey = v }
        if let v = Self.flexibleInt(blob["timedElapsedSeconds"]) { timedElapsedSeconds = max(0, v) }
        if let v = blob["timedTimerRunning"] as? Bool { timedTimerRunning = v }
        if let v = Self.flexibleDouble(blob["timedStartedAtMs"]) { timedStartedAtMs = v }
        if let v = Self.flexibleDouble(blob["sessionStartedAtMs"]) { sessionStartedAtMs = v }
        if let v = blob["loggedSetsByExercise"] as? [String: [[String: Any]]] { loggedSetsByExercise = v }
        reconcileRestClock()
        reconcileTimedClock()
        hydrating = false
    }

    /// Wipe persisted state — call on workout end / cancel so the
    /// next workout starts from a clean slate.
    func clearPersisted() {
        currentRecommendation = nil
        liveRecommendedWeightLbs = nil
        liveRecommendedReps = nil
        completedExerciseIndexes = []
        loggedSetsByExercise = [:]
        sessionStartedAtMs = nil
        // Workout ended/cancelled — drop any armed rest-over ding so it
        // can't fire after the session is over.
        Self.cancelRestEndNotification()
        Self.clearPersistedStore()
    }

    static func clearPersistedStore() {
        UserDefaults.standard.removeObject(forKey: Self.kPersistKey)
    }

    func attach(to workout: WatchWorkout) {
        let incomingSessionId = Self.normalizedSessionId(workout.sessionId)
        let fallbackSessionId = "\(workout.dateISO)|\(workout.focus)"
        let nextSessionId: String
        if workout.status == .active,
           incomingSessionId == nil,
           let currentSessionId = Self.normalizedSessionId(sessionId) {
            nextSessionId = currentSessionId
        } else {
            nextSessionId = incomingSessionId ?? fallbackSessionId
        }
        // Within the same session we must NOT clobber `paused`. Hydrating
        // from UserDefaults restores it, but if attach() then forces it
        // back to false, a watch process death while the user was paused
        // resumes the rest timer behind their back. Only reset paused
        // when the session changes (resetForSession handles that).
        if let sessionId, sessionId != nextSessionId {
            resetForSession(nextSessionId)
        } else if sessionId == nil {
            if hasNonDefaultState {
                resetForSession(nextSessionId)
            } else {
                self.sessionId = nextSessionId
                if sessionStartedAtMs == nil {
                    sessionStartedAtMs = Self.nowMs()
                }
            }
        }
        if workout.exercises.isEmpty {
            exerciseIndex = 0
            setNumber = 1
            clearRest()
        } else if exerciseIndex == workout.exercises.count {
            setNumber = 1
            clearRest()
            resetTimedTimer()
            currentRecommendation = nil
            liveRecommendedWeightLbs = nil
            liveRecommendedReps = nil
        } else if !workout.exercises.indices.contains(exerciseIndex) {
            exerciseIndex = 0
            setNumber = 1
            clearRest()
        } else {
            let maxSets = max(1, workout.exercises[exerciseIndex].sets)
            setNumber = min(max(1, setNumber), maxSets)
        }
        completedExerciseIndexes = Set(completedExerciseIndexes.filter { workout.exercises.indices.contains($0) })
        reconcileRestClock()
    }

    private var hasNonDefaultState: Bool {
        exerciseIndex != 0
        || setNumber != 1
        || restRemaining != nil
        || paused
        || pendingWeight != 0
        || pendingReps != 0
        || lastLoggedWeight != nil
        || lastLoggedReps != nil
        || currentRecommendation != nil
        || liveRecommendedWeightLbs != nil
        || liveRecommendedReps != nil
        || !completedExerciseIndexes.isEmpty
        || timedTimerKey != nil
        || timedElapsedSeconds > 0
        || timedTimerRunning
        || !loggedSetsByExercise.isEmpty
    }

    private static func normalizedSessionId(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty
        else { return nil }
        return trimmed
    }

    private func progressWouldMoveBackward(_ info: [AnyHashable: Any]) -> Bool {
        let incomingIndex = Self.flexibleInt(info["exerciseIndex"])
        let incomingSetNumber = Self.flexibleInt(info["setNumber"])
        if incomingIndex == nil && incomingSetNumber == nil { return false }

        let targetIndex = incomingIndex ?? exerciseIndex
        let targetSetNumber = incomingSetNumber ?? setNumber
        if targetIndex < exerciseIndex { return true }
        if targetIndex == exerciseIndex && targetSetNumber < setNumber { return true }
        return false
    }

    private func acceptProgress(_ info: [AnyHashable: Any]) -> Bool {
        if let incomingSessionId = Self.normalizedSessionId(info["sessionId"] as? String) {
            if let currentSessionId = Self.normalizedSessionId(sessionId) {
                if incomingSessionId != currentSessionId {
                    HeartRateStore.saveDiag("progress stale session rejected")
                    return false
                }
            } else {
                sessionId = incomingSessionId
            }
        }
        let allowsExerciseBacktrack = Self.flexibleBool(info["allowExerciseBacktrack"])
            || Self.flexibleString(info["progressKind"]) == "active_exercise"
        if !allowsExerciseBacktrack && progressWouldMoveBackward(info) {
            let incomingIndex = Self.flexibleInt(info["exerciseIndex"]) ?? -1
            let incomingSetNumber = Self.flexibleInt(info["setNumber"]) ?? -1
            HeartRateStore.saveDiag("progress backward rejected ex=\(incomingIndex) set=\(incomingSetNumber) current=\(exerciseIndex)/\(setNumber)")
            return false
        }
        guard let revision = Self.flexibleDouble(info["progressRevision"]) else {
            return true
        }
        if revision <= lastProgressRevision {
            HeartRateStore.saveDiag("progress stale rejected rev=\(Int(revision)) last=\(Int(lastProgressRevision))")
            return false
        }
        lastProgressRevision = revision
        return true
    }

    private func applyProgress(_ info: [AnyHashable: Any]) {
        guard acceptProgress(info) else { return }
        let completedFromProgress = watchCompletedExerciseIndexes(from: info["completedExerciseIndexes"])
            .union(watchCompletedExerciseIndexes(from: info["exerciseCompletion"]))
        let previousExerciseIndex = exerciseIndex
        var exerciseChanged = false
        if let idx = Self.flexibleInt(info["exerciseIndex"]) {
            if idx != exerciseIndex {
                clearLiveRecommendation()
                exerciseChanged = true
            }
            exerciseIndex = idx
        }
        if let setN = Self.flexibleInt(info["setNumber"]) { setNumber = setN }
        if let rest = Self.flexibleInt(info["restRemainingSec"]) {
            let endAt = Self.flexibleDouble(info["restEndsAtMs"])
            setRest(seconds: rest, endAtMs: endAt)
        } else if info.keys.contains("restRemainingSec") {
            clearRest()
        }
        if let rec = Self.flexibleString(info["recommendation"]) {
            currentRecommendation = rec
            applyLiveRecommendationFields(info, fallbackText: rec)
        } else if info.keys.contains("recommendation") {
            let incomingExerciseIndex = Self.flexibleInt(info["exerciseIndex"]) ?? previousExerciseIndex
            if shouldClearLiveRecommendation(
                exerciseChanged: exerciseChanged,
                incomingExerciseIndex: incomingExerciseIndex,
                completedFromProgress: completedFromProgress
            ) {
                clearLiveRecommendation()
            } else {
                applyLiveRecommendationFields(info, fallbackText: nil)
            }
        } else {
            applyLiveRecommendationFields(info, fallbackText: nil)
        }
        if info.keys.contains("completedExerciseIndexes") || info.keys.contains("exerciseCompletion") {
            completedExerciseIndexes = completedFromProgress
        }
    }

    private func shouldClearLiveRecommendation(
        exerciseChanged: Bool,
        incomingExerciseIndex: Int,
        completedFromProgress: Set<Int>
    ) -> Bool {
        if exerciseChanged { return true }
        if completedFromProgress.contains(incomingExerciseIndex) { return true }
        return currentRecommendation == nil
            && liveRecommendedWeightLbs == nil
            && liveRecommendedReps == nil
    }

    private func clearLiveRecommendation() {
        currentRecommendation = nil
        liveRecommendedWeightLbs = nil
        liveRecommendedReps = nil
    }

    private func applyLiveRecommendationFields(_ info: [AnyHashable: Any], fallbackText: String?) {
        if info.keys.contains("recommendedWeightLbs") {
            let weight = Self.flexibleDouble(info["recommendedWeightLbs"])
            liveRecommendedWeightLbs = (weight ?? 0) > 0 ? weight : nil
        }
        if info.keys.contains("recommendedReps") {
            liveRecommendedReps = Self.flexibleString(info["recommendedReps"])
        }
        if let fallbackText,
           liveRecommendedWeightLbs == nil || liveRecommendedReps == nil {
            let parsed = Self.parseRecommendationTarget(fallbackText)
            if liveRecommendedWeightLbs == nil, let weight = parsed.weightLbs {
                liveRecommendedWeightLbs = weight
            }
            if liveRecommendedReps == nil, let reps = parsed.reps {
                liveRecommendedReps = reps
            }
        }
    }

    private func resetForSession(_ nextSessionId: String) {
        exerciseIndex = 0
        setNumber = 1
        paused = false
        clearRest()
        pendingWeight = 0
        pendingReps = 0
        lastLoggedWeight = nil
        lastLoggedReps = nil
        currentRecommendation = nil
        liveRecommendedWeightLbs = nil
        liveRecommendedReps = nil
        completedExerciseIndexes = []
        loggedSetsByExercise = [:]
        sessionStartedAtMs = Self.nowMs()
        lastAutoSeededWeight = nil
        lastAutoSeededReps = nil
        resetTimedTimer()
        // The previous session's revision counter would otherwise persist
        // and reject the new session's first few progress messages if the
        // phone's `nextProgressRevision()` hasn't yet caught up.
        lastProgressRevision = 0
        sessionId = nextSessionId
    }

    func setRest(seconds: Int?, endAtMs: Double? = nil) {
        guard let seconds, seconds > 0 else {
            // If rest ended naturally within the last 3 seconds, the scheduled
            // ding notification has not fired yet. Don't cancel it — just clear
            // the visual state and let the notification play. If the rest was
            // manually skipped by the user, restNaturallyEndedAtMs will be old
            // (or zero) so we fall through to clearRest() as before.
            let justEndedNaturally = restNaturallyEndedAtMs > 0
                && (Self.nowMs() - restNaturallyEndedAtMs) < 3000
            if justEndedNaturally {
                restRemaining = nil
                restEndAtMs = nil
                paused = false
            } else {
                clearRest()
            }
            return
        }
        let endAt = endAtMs ?? (Self.nowMs() + Double(seconds) * 1000)
        restEndAtMs = endAt
        restRemaining = max(0, Int(ceil((endAt - Self.nowMs()) / 1000)))
        paused = false
        Self.scheduleRestEndNotification(atMs: endAt)
    }

    func clearRest() {
        restRemaining = nil
        restEndAtMs = nil
        paused = false
        Self.cancelRestEndNotification()
    }

    // ─── Rest-over audible alert ─────────────────────────────────────
    // reconcileRestClock plays a haptic when rest ends, but a haptic is
    // silent and only fires while the app is awake. A local notification
    // with a sound makes the rest-over alert *ding* even when the watch
    // app is backgrounded or fully suspended. Both rest-arming paths —
    // local set logging and phone-pushed progress — funnel through
    // setRest, so scheduling here covers everything. Natural completion
    // (reconcileRestClock) clears restEndAtMs directly without calling
    // clearRest, so the pending notification survives to deliver the ding.
    private static let restEndNotificationId = "thallo.rest.timer"
    private static var didRequestNotificationAuth = false

    private static func scheduleRestEndNotification(atMs endMs: Double) {
        cancelRestEndNotification()
        let secs = (endMs - nowMs()) / 1000
        guard secs >= 1 else { return }
        if !didRequestNotificationAuth {
            didRequestNotificationAuth = true
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
        let content = UNMutableNotificationContent()
        content.title = "Rest complete"
        content.body = "Time for your next set."
        content.sound = .default
        content.interruptionLevel = .timeSensitive
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: secs, repeats: false)
        let request = UNNotificationRequest(identifier: restEndNotificationId, content: content, trigger: trigger)
        UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
    }

    private static func cancelRestEndNotification() {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [restEndNotificationId])
    }

    func reconcileRestClock(playHaptic: Bool = false) {
        guard !paused, let endAt = restEndAtMs else { return }
        let previous = restRemaining ?? 0
        let next = max(0, Int(ceil((endAt - Self.nowMs()) / 1000)))
        restRemaining = next
        if next == 0 {
            restEndAtMs = nil
            restNaturallyEndedAtMs = Self.nowMs()
            if previous > 0, playHaptic {
                WKInterfaceDevice.current().play(.notification)
            }
        }
    }

    func startTimedTimer(key: String) {
        if timedTimerKey != key {
            timedTimerKey = key
            timedElapsedSeconds = 0
        }
        timedStartedAtMs = Self.nowMs() - Double(timedElapsedSeconds) * 1000
        timedTimerRunning = true
    }

    func pauseTimedTimer() {
        reconcileTimedClock()
        timedTimerRunning = false
        timedStartedAtMs = nil
    }

    func resetTimedTimer(key: String? = nil) {
        timedTimerKey = key
        timedElapsedSeconds = 0
        timedTimerRunning = false
        timedStartedAtMs = nil
    }

    func timedElapsed(for key: String) -> Int {
        guard timedTimerKey == key else { return 0 }
        guard timedTimerRunning, let startedAtMs = timedStartedAtMs else {
            return timedElapsedSeconds
        }
        return max(timedElapsedSeconds, Int(floor((Self.nowMs() - startedAtMs) / 1000)))
    }

    func timedTimerIsRunning(for key: String) -> Bool {
        timedTimerKey == key && timedTimerRunning
    }

    func reconcileTimedClock() {
        guard timedTimerRunning, let timedStartedAtMs else { return }
        timedElapsedSeconds = max(0, Int(floor((Self.nowMs() - timedStartedAtMs) / 1000)))
    }

    private static func nowMs() -> Double {
        Date().timeIntervalSince1970 * 1000
    }

    private static func flexibleInt(_ value: Any?) -> Int? {
        if let v = value as? Int { return v }
        if let v = value as? Double, v.isFinite { return Int(v.rounded()) }
        if let v = value as? NSNumber { return v.intValue }
        if let v = value as? String { return Int(v.trimmingCharacters(in: .whitespacesAndNewlines)) }
        return nil
    }

    private static func flexibleDouble(_ value: Any?) -> Double? {
        if let v = value as? Double, v.isFinite { return v }
        if let v = value as? Int { return Double(v) }
        if let v = value as? NSNumber { return v.doubleValue }
        if let v = value as? String { return Double(v.trimmingCharacters(in: .whitespacesAndNewlines)) }
        return nil
    }

    private static func flexibleBool(_ value: Any?) -> Bool {
        if let v = value as? Bool { return v }
        if let v = value as? NSNumber { return v.boolValue }
        if let v = value as? String {
            let normalized = v.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return normalized == "true" || normalized == "1" || normalized == "yes"
        }
        return false
    }

    private static func flexibleString(_ value: Any?) -> String? {
        if let v = value as? String {
            let trimmed = v.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        if let v = value as? Int { return String(v) }
        if let v = value as? Double, v.isFinite {
            return v.rounded() == v ? String(Int(v)) : String(v)
        }
        if let v = value as? NSNumber { return v.stringValue }
        return nil
    }

    private static func isoString(ms: Double) -> String {
        ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    private static func finiteDouble(_ value: Any?) -> Double? {
        guard let value = flexibleDouble(value), value.isFinite else { return nil }
        return value
    }

    private static func nonEmptyArray(_ value: [String]?) -> [String]? {
        let cleaned = (value ?? [])
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return cleaned.isEmpty ? nil : cleaned
    }

    func recordLoggedSet(
        exerciseIndex: Int,
        setNumber: Int,
        weightLbs: Double,
        reps: Int,
        durationSeconds: Int?,
        rir: Int?,
        heartRateAvg: Int?
    ) {
        guard exerciseIndex >= 0, setNumber > 0 else { return }
        let key = String(exerciseIndex)
        var sets = loggedSetsByExercise[key] ?? []
        var row: [String: Any] = [
            "set_number": setNumber,
            "reps": max(0, reps),
            "weight_lbs": max(0, weightLbs),
        ]
        if let durationSeconds, durationSeconds > 0 { row["duration_seconds"] = durationSeconds }
        if let rir { row["rir"] = max(0, min(4, rir)) }
        if let heartRateAvg, heartRateAvg > 0 { row["heart_rate_avg"] = heartRateAvg }
        if let existing = sets.firstIndex(where: { Self.flexibleInt($0["set_number"]) == setNumber }) {
            sets[existing] = row
        } else {
            sets.append(row)
        }
        sets.sort { (Self.flexibleInt($0["set_number"]) ?? 0) < (Self.flexibleInt($1["set_number"]) ?? 0) }
        loggedSetsByExercise[key] = sets
    }

    func endWorkoutCommandPayload(for workout: WatchWorkout, finalMetrics: [String: Any]?) -> [String: Any] {
        let endedMs = Self.nowMs()
        let startMs = sessionStartedAtMs ?? max(endedMs - Double(max(1, workout.durationMinutes)) * 60_000, 0)
        let elapsedSecondsFromClock = max(1, Int((endedMs - startMs) / 1000))
        let metricsElapsed = Self.flexibleInt(finalMetrics?["elapsedSeconds"])
        let completionDuration = max(1, metricsElapsed ?? elapsedSecondsFromClock)
        let sourceIdSeed = Self.normalizedSessionId(sessionId) ?? Self.normalizedSessionId(workout.sessionId) ?? "\(workout.dateISO)-\(workout.focus)"
        let sourceId = "watch:\(sourceIdSeed)"
        var completion: [String: Any] = [
            "workout_date": String(workout.dateISO.prefix(10)),
            "focus_label": workout.focus,
            "duration_seconds": completionDuration,
            "source_context": workout.sourceContext ?? defaultSourceContext(for: workout, finalMetrics: finalMetrics),
            "started_at": Self.isoString(ms: startMs),
            "ended_at": Self.isoString(ms: endedMs),
            "external_source_id": sourceId,
            "idempotency_key": sourceId,
        ]
        if let stimulus = workout.stimulus { completion["stimulus"] = stimulus }
        if let templateId = workout.templateId { completion["template_id"] = templateId }
        if let planDayId = workout.planDayId { completion["plan_day_id"] = planDayId }

        let exercises = completionExercises(for: workout)
        if !exercises.isEmpty { completion["exercises"] = exercises }
        applyActivityMetrics(finalMetrics, workout: workout, into: &completion)

        var payload = finalMetrics ?? [:]
        payload["completion"] = completion
        payload["completionId"] = sourceId
        if payload["sessionId"] == nil, let sid = Self.normalizedSessionId(workout.sessionId) ?? Self.normalizedSessionId(sessionId) {
            payload["sessionId"] = sid
        }
        return payload
    }

    private func completionExercises(for workout: WatchWorkout) -> [[String: Any]] {
        workout.exercises.enumerated().compactMap { index, exercise in
            let sets = loggedSetsByExercise[String(index)] ?? []
            guard !sets.isEmpty else { return nil }
            var row: [String: Any] = [
                "name": exercise.name,
                "target_sets": max(0, exercise.sets),
                "target_reps": exercise.reps,
                "order_index": index,
                "sets": sets,
            ]
            if let slug = exercise.slug { row["slug"] = slug }
            if let equipment = exercise.equipment { row["equipment"] = equipment }
            if let primary = exercise.primaryMuscle { row["primary_muscle"] = primary }
            if let secondary = Self.nonEmptyArray(exercise.secondaryMuscles) { row["secondary_muscles"] = secondary }
            if let isCompound = exercise.isCompound { row["is_compound"] = isCompound }
            if let movementPattern = exercise.movementPattern { row["movement_pattern"] = movementPattern }
            return row
        }
    }

    private func defaultSourceContext(for workout: WatchWorkout, finalMetrics: [String: Any]?) -> String {
        if workout.templateId != nil { return "saved_template" }
        let focus = workout.focus.lowercased()
        if finalMetrics != nil || focus.range(of: "cardio|run|walk|ride|bike|cycl|hike|swim|row|elliptical|stair|hiit|interval", options: .regularExpression) != nil {
            return "custom_cardio"
        }
        return "planned"
    }

    private func applyActivityMetrics(_ finalMetrics: [String: Any]?, workout: WatchWorkout, into completion: inout [String: Any]) {
        let focus = workout.focus.lowercased()
        let hasCardioMetrics = finalMetrics != nil
        let category: String
        if focus.range(of: "mobility|yoga|stretch|foam", options: .regularExpression) != nil {
            category = "mobility"
        } else if focus.contains("recovery") {
            category = "recovery"
        } else if hasCardioMetrics || focus.range(of: "cardio|run|walk|ride|bike|cycl|hike|swim|row|elliptical|stair|hiit|interval|tempo|zone ?2", options: .regularExpression) != nil {
            category = "cardio"
        } else {
            category = "strength"
        }
        completion["activity_category"] = category
        completion["activity_source"] = "watch"
        completion["activity_intensity"] = focus.range(of: "hiit|interval|sprint|heavy|strength|power", options: .regularExpression) != nil ? "hard" : category == "mobility" || category == "recovery" ? "easy" : "moderate"

        if category == "cardio" {
            completion["activity_subtype"] = cardioSubtype(for: focus)
            completion["cardio_style"] = focus.range(of: "hiit|interval|sprint|tempo", options: .regularExpression) != nil ? "intervals" : "steady"
        }

        guard let finalMetrics else { return }
        if let meters = Self.finiteDouble(finalMetrics["distanceMeters"]), meters > 0 {
            completion["distance_miles"] = (meters / 1000.0) * 0.6213711922
        }
        if let calories = Self.finiteDouble(finalMetrics["activeCalories"]), calories > 0 {
            completion["calories_burned"] = Int(calories.rounded())
        }
        if let bpm = Self.flexibleInt(finalMetrics["heartRate"]), bpm > 0 {
            completion["hr_summary"] = ["avgBpm": bpm, "maxBpm": bpm, "zoneMinutes": []]
        }
        var details: [String: Any] = [:]
        if let elapsed = Self.flexibleInt(finalMetrics["elapsedSeconds"]), elapsed > 0 {
            details["movingSeconds"] = elapsed
            details["durationSource"] = "watch"
        }
        if let steps = Self.flexibleInt(finalMetrics["steps"]), steps > 0 { details["steps"] = steps }
        if let elevation = Self.finiteDouble(finalMetrics["elevationGainFt"]), elevation > 0 { details["elevationGainFt"] = elevation }
        if let pace = Self.finiteDouble(finalMetrics["paceSecPerKm"]), pace > 0 {
            details["avgPaceSecPerKm"] = pace
            details["avgPaceSecPerMi"] = pace / 0.6213711922
        }
        if !details.isEmpty { completion["activity_details"] = details }
        if let routeCoords = finalMetrics["routeCoords"] as? [[String: Any]], !routeCoords.isEmpty {
            completion["route_coords"] = routeCoords
        }
    }

    private func cardioSubtype(for focus: String) -> String {
        if focus.range(of: "walk|treadmill", options: .regularExpression) != nil { return "walking" }
        if focus.range(of: "run|jog", options: .regularExpression) != nil { return "running" }
        if focus.contains("hike") { return "hiking" }
        if focus.range(of: "ride|bike|cycl|spin", options: .regularExpression) != nil { return "cycling" }
        if focus.contains("swim") { return "swimming" }
        if focus.range(of: "\\brow|rowing", options: .regularExpression) != nil { return "rowing" }
        if focus.contains("elliptical") { return "elliptical" }
        if focus.contains("stair") { return "stair_climber" }
        if focus.range(of: "hiit|interval", options: .regularExpression) != nil { return "hiit" }
        return "cardio"
    }

    private static func parseRecommendationTarget(_ text: String) -> (weightLbs: Double?, reps: String?) {
        let pattern = #"(?i)(\d+(?:\.\d+)?)\s*(lb|lbs|kg)?\s*[x×]\s*([0-9]+(?:\s*[-–—]\s*[0-9]+)?\+?)"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..<text.endIndex, in: text)),
              let weightRange = Range(match.range(at: 1), in: text),
              let rawWeight = Double(String(text[weightRange]))
        else { return (nil, nil) }
        var weightLbs = rawWeight
        if let unitRange = Range(match.range(at: 2), in: text),
           text[unitRange].lowercased().hasPrefix("kg") {
            weightLbs = rawWeight * 2.2046226218
        }
        let reps = Range(match.range(at: 3), in: text)
            .map { String(text[$0]).replacingOccurrences(of: " ", with: "") }
        return (weightLbs, reps)
    }

    private static func firstRepCount(_ raw: String?) -> Int? {
        guard let raw else { return nil }
        let regex = try? NSRegularExpression(pattern: "\\d+")
        let nsRange = NSRange(raw.startIndex..<raw.endIndex, in: raw)
        let values = regex?.matches(in: raw, range: nsRange).compactMap { match -> Int? in
            guard let range = Range(match.range, in: raw) else { return nil }
            return Int(raw[range])
        } ?? []
        guard let first = values.first else { return nil }
        let hasRange = raw.range(of: "\\d+\\s*[-–—]\\s*\\d+", options: .regularExpression) != nil
        if hasRange && values.count >= 2 {
            return max(0, (first + values[1]) / 2)
        }
        return first
    }

    private static func sameWeight(_ lhs: Double?, _ rhs: Double?) -> Bool {
        guard let lhs, let rhs else { return false }
        return abs(lhs - rhs) < 0.01
    }

    func clearAutoSeededInputs() {
        lastAutoSeededWeight = nil
        lastAutoSeededReps = nil
    }

    /// Prime the weight / reps inputs for the current exercise.
    /// Called when advancing to a new exercise so the user doesn't
    /// have to dial from zero.
    func seed(for ex: WatchExercise) {
        let timed = ex.isTimed ?? (ex.plannedDurationSeconds != nil)
        if ex.tracksWeightInput == false {
            pendingWeight = 0
            lastAutoSeededWeight = nil
        } else if ex.isGuide != true, !timed {
            let preferredWeight = liveRecommendedWeightLbs ?? ex.plannedTargetWeightLbs
            let canAutoSeedWeight = pendingWeight == 0
                || Self.sameWeight(pendingWeight, lastAutoSeededWeight)
                || Self.sameWeight(pendingWeight, ex.plannedTargetWeightLbs)
            if canAutoSeedWeight {
                pendingWeight = preferredWeight ?? 0
                lastAutoSeededWeight = preferredWeight
            }
        }
        if timed {
            pendingReps = 0
            lastAutoSeededReps = nil
        } else {
            let plannedReps = Self.firstRepCount(ex.reps) ?? 8
            let preferredReps = Self.firstRepCount(liveRecommendedReps ?? ex.recommendedReps) ?? plannedReps
            let canAutoSeedReps = pendingReps == 0
                || pendingReps == lastAutoSeededReps
                || pendingReps == plannedReps
            if canAutoSeedReps {
                pendingReps = preferredReps
                lastAutoSeededReps = preferredReps
            }
        }
    }

    func jump(to index: Int, in workout: WatchWorkout) {
        guard workout.exercises.indices.contains(index) else { return }
        exerciseIndex = index
        setNumber = 1
        clearRest()
        pendingWeight = 0
        pendingReps = 0
        lastLoggedWeight = nil
        lastLoggedReps = nil
        currentRecommendation = nil
        liveRecommendedWeightLbs = nil
        liveRecommendedReps = nil
        lastAutoSeededWeight = nil
        lastAutoSeededReps = nil
        seed(for: workout.exercises[index])
    }

    func markExerciseDone(_ index: Int) {
        guard index >= 0 else { return }
        completedExerciseIndexes.insert(index)
    }

    func finishPlannedExercises(in workout: WatchWorkout) {
        guard !workout.exercises.isEmpty else { return }
        exerciseIndex = workout.exercises.count
        setNumber = 1
        clearRest()
        pendingWeight = 0
        pendingReps = 0
        lastLoggedWeight = nil
        lastLoggedReps = nil
        currentRecommendation = nil
        liveRecommendedWeightLbs = nil
        liveRecommendedReps = nil
        lastAutoSeededWeight = nil
        lastAutoSeededReps = nil
        resetTimedTimer()
    }

    // ─── Rest countdown (watch-owned) ─────────────────────────────

    private var timer: AnyCancellable?
    func startTick() {
        timer?.cancel()
        timer = Timer.publish(every: 1, on: .main, in: .common)
            .autoconnect()
            .sink { [weak self] _ in
                guard let self, !self.paused else { return }
                self.reconcileRestClock(playHaptic: true)
                self.reconcileTimedClock()
            }
    }
    func stopTick() { timer?.cancel(); timer = nil }
}

// ─── Root ──────────────────────────────────────────────────────────

struct ActiveWorkoutView: View {
    let workout: WatchWorkout
    @ObservedObject var hr: HeartRateStore
    let onEndWorkout: ([String: Any]?) -> Void
    let onCancelWorkout: () -> Void

    @EnvironmentObject var theme: ThemeStore
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var state = ActiveWorkoutState()
    @State private var showCountdown: Bool
    @State private var lastExerciseName: String? = nil
    @State private var optimisticWorkout: WatchWorkout? = nil
    @State private var pendingOptimisticExerciseIds: Set<String> = []

    private static let countdownConsumedSessionKey = "thallo.activeWorkoutCountdownSessionId"

    init(
        workout: WatchWorkout,
        hr: HeartRateStore,
        playStartCountdown: Bool = false,
        onEndWorkout: @escaping ([String: Any]?) -> Void,
        onCancelWorkout: @escaping () -> Void
    ) {
        self.workout = workout
        self.hr = hr
        self.onEndWorkout = onEndWorkout
        self.onCancelWorkout = onCancelWorkout
        let sessionId = workout.sessionId ?? ""
        let alreadyPlayed = !sessionId.isEmpty &&
            UserDefaults.standard.string(forKey: Self.countdownConsumedSessionKey) == sessionId
        _showCountdown = State(initialValue: playStartCountdown && !alreadyPlayed)
    }

    private var displayedWorkout: WatchWorkout {
        optimisticWorkout ?? workout
    }

    private var shouldUseCardioSurface: Bool {
        let activeWorkout = displayedWorkout
        let setlessCardioOnly = !activeWorkout.exercises.isEmpty
            && activeWorkout.exercises.allSatisfy { $0.sets <= 0 && isWatchCardioExercise($0) }
        if !activeWorkout.exercises.isEmpty && !setlessCardioOnly { return false }
        if HeartRateStore.isMixedStrengthCardioFocus(activeWorkout.focus) { return false }
        return hr.isCardio || HeartRateStore.isCardioFocus(activeWorkout.focus)
            || activeWorkout.exercises.contains(where: isWatchCardioExercise)
    }

    var body: some View {
        let activeWorkout = displayedWorkout
        ZStack {
            // Cardio sessions get a dedicated tab as the FIRST page —
            // big elapsed time + distance + pace + HR + calories — so
            // the wrist-up glance lands on the metrics that matter for
            // the sport. Lift sessions keep the existing exercise/HR
            // pair. Infer from the focus immediately so watch-started
            // runs don't mount as an empty lift shell and then swap
            // TabView page sets after HealthKit resolves the activity.
            TabView {
                if shouldUseCardioSurface {
                    CardioActiveTab(
                        hr: hr,
                        sessionId: activeWorkout.sessionId,
                        onEndWorkout: {
                            let payload = state.endWorkoutCommandPayload(for: activeWorkout, finalMetrics: $0)
                            state.clearPersisted()
                            onEndWorkout(payload)
                        },
                        onCancelWorkout: {
                            state.clearPersisted()
                            onCancelWorkout()
                        },
                    )
                    HeartRateTab(hr: hr, showsElapsedTime: true)
                    // The live route map used to live here as a third
                    // tab for outdoor cardio. Removed because MapKit's
                    // pan gesture ate the page swipe-back, trapping the
                    // user. GPS still records silently — the route
                    // polyline shows on the post-workout summary on the
                    // phone where the screen's actually big enough to
                    // read.
                } else {
                    ExerciseTab(
                        workout: activeWorkout,
                        state: state,
                        hr: hr,
                        onOptimisticAddExercise: applyOptimisticExerciseAdd,
                        onEndWorkout: { payload in
                            state.clearPersisted()
                            onEndWorkout(payload)
                        },
                        onCancelWorkout: {
                            state.clearPersisted()
                            onCancelWorkout()
                        },
                    )
                    WorkoutPlanTab(
                        workout: activeWorkout,
                        state: state,
                        hr: hr,
                        onOptimisticAddExercise: applyOptimisticExerciseAdd,
                    )
                    HeartRateTab(hr: hr)
                }
            }
            .tabViewStyle(.page)
            if showCountdown {
                StartCountdownOverlay(onComplete: {
                    // Fade the overlay out — withAnimation lets the
                    // opacity transition inside the overlay run before
                    // the view is removed.
                    withAnimation(.easeOut(duration: 0.25)) {
                        showCountdown = false
                    }
                })
                .transition(.opacity)
            }
        }
        .onAppear {
            HeartRateStore.saveDiag("ActiveView.onAppear")
            hr.setZones(activeWorkout.hrZones)
            if showCountdown, let sessionId = activeWorkout.sessionId, !sessionId.isEmpty {
                UserDefaults.standard.set(sessionId, forKey: Self.countdownConsumedSessionKey)
            }
            state.attach(to: activeWorkout)
            state.startTick()
            seedCurrentExerciseIfNeeded()
        }
        .onChange(of: workout) { _, newWorkout in
            reconcileOptimisticWorkout(with: newWorkout)
            state.attach(to: displayedWorkout)
            seedCurrentExerciseIfNeeded()
        }
        .onChange(of: workout.hrZones) { _, zones in
            hr.setZones(zones)
        }
        .onChange(of: state.exerciseIndex) { _, _ in seedCurrentExerciseIfNeeded() }
        .onChange(of: state.liveRecommendedWeightLbs) { _, _ in seedCurrentExerciseIfNeeded() }
        .onChange(of: state.liveRecommendedReps) { _, _ in seedCurrentExerciseIfNeeded() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                state.reconcileRestClock()
            }
        }
        .onDisappear { state.stopTick() }
    }

    private func seedCurrentExerciseIfNeeded() {
        let activeWorkout = displayedWorkout
        guard !activeWorkout.exercises.isEmpty else { return }
        if !activeWorkout.exercises.indices.contains(state.exerciseIndex) {
            if state.exerciseIndex == activeWorkout.exercises.count {
                return
            }
            state.exerciseIndex = 0
            state.setNumber = 1
            state.clearRest()
            state.pendingWeight = 0
            state.pendingReps = 0
            state.lastLoggedWeight = nil
            state.lastLoggedReps = nil
            state.currentRecommendation = nil
            state.liveRecommendedWeightLbs = nil
            state.liveRecommendedReps = nil
            state.clearAutoSeededInputs()
        }
        if activeWorkout.exercises.indices.contains(state.exerciseIndex) {
            let ex = activeWorkout.exercises[state.exerciseIndex]
            state.setNumber = min(max(1, state.setNumber), max(1, ex.sets))
            if let lastExerciseName, lastExerciseName != ex.name {
                state.pendingWeight = 0
                state.pendingReps = 0
                state.lastLoggedWeight = nil
                state.lastLoggedReps = nil
                state.currentRecommendation = nil
                state.liveRecommendedWeightLbs = nil
                state.liveRecommendedReps = nil
                state.clearAutoSeededInputs()
            }
            lastExerciseName = ex.name
            state.seed(for: ex)
        }
    }

    private func applyOptimisticExerciseAdd(_ templateExercise: WatchTemplateExercise, clientExerciseId: String) {
        let trimmed = templateExercise.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        var nextExercises = displayedWorkout.exercises
        if nextExercises.contains(where: { exerciseMatches($0, clientExerciseId: clientExerciseId, name: trimmed) }) {
            HeartRateStore.saveDiag("Watch add skipped duplicate exercise=\(trimmed)")
            return
        }
        let watchExercise = WatchExercise(
            clientExerciseId: clientExerciseId,
            name: trimmed,
            sets: max(1, templateExercise.sets),
            reps: templateExercise.reps,
            restSeconds: templateExercise.restSeconds ?? 90,
            equipment: templateExercise.equipment,
            primaryMuscle: templateExercise.primaryMuscle,
            plannedTargetWeightLbs: nil,
            tracksWeight: nil,
            isTimed: nil,
            plannedDurationSeconds: nil,
            recommendation: nil,
            recommendedReps: nil,
            completedSets: 0,
            isDone: false,
            isGuide: nil,
            slotRole: nil,
            slotLabel: nil,
            prescriptionType: nil,
            swapOptions: []
        )
        nextExercises.append(watchExercise)
        pendingOptimisticExerciseIds.insert(clientExerciseId)
        let updated = copyWorkout(displayedWorkout, exercises: nextExercises, syncedAtMs: Date().timeIntervalSince1970 * 1000)
        optimisticWorkout = updated
        state.jump(to: nextExercises.count - 1, in: updated)
        HeartRateStore.saveDiag("Watch add optimistic exercise=\(trimmed) id=\(clientExerciseId.prefix(8)) ex=\(nextExercises.count)")
    }

    private func reconcileOptimisticWorkout(with incoming: WatchWorkout) {
        guard let local = optimisticWorkout, !pendingOptimisticExerciseIds.isEmpty else {
            optimisticWorkout = nil
            pendingOptimisticExerciseIds.removeAll()
            return
        }
        if local.sessionId != incoming.sessionId {
            optimisticWorkout = nil
            pendingOptimisticExerciseIds.removeAll()
            HeartRateStore.saveDiag("Watch add reconciliation cleared: session changed")
            return
        }
        var mergedExercises = incoming.exercises
        var remaining = pendingOptimisticExerciseIds
        for localExercise in local.exercises {
            guard let localId = localExercise.clientExerciseId,
                  pendingOptimisticExerciseIds.contains(localId)
            else { continue }
            if mergedExercises.contains(where: { exerciseMatches($0, clientExerciseId: localId, name: localExercise.name) }) {
                remaining.remove(localId)
                HeartRateStore.saveDiag("Watch add snapshot matched optimistic exercise=\(localExercise.name) id=\(localId.prefix(8))")
            } else {
                mergedExercises.append(localExercise)
                HeartRateStore.saveDiag("Watch add preserving optimistic exercise during snapshot exercise=\(localExercise.name) id=\(localId.prefix(8))")
            }
        }
        pendingOptimisticExerciseIds = remaining
        if remaining.isEmpty {
            optimisticWorkout = nil
            HeartRateStore.saveDiag("Watch add reconciliation complete")
        } else {
            optimisticWorkout = copyWorkout(incoming, exercises: mergedExercises, syncedAtMs: max(incoming.syncedAtMs, local.syncedAtMs))
        }
    }

    private func exerciseMatches(_ exercise: WatchExercise, clientExerciseId: String, name: String) -> Bool {
        if exercise.clientExerciseId == clientExerciseId { return true }
        return exercise.clientExerciseId == nil
            && exercise.name.trimmingCharacters(in: .whitespacesAndNewlines).caseInsensitiveCompare(name) == .orderedSame
    }

    private func copyWorkout(_ source: WatchWorkout, exercises: [WatchExercise], syncedAtMs: Double) -> WatchWorkout {
        WatchWorkout(
            focus: source.focus,
            durationMinutes: source.durationMinutes,
            dateISO: source.dateISO,
            status: source.status,
            sessionId: source.sessionId,
            readiness: source.readiness,
            readinessLabel: source.readinessLabel,
            exercises: exercises,
            warmupSteps: source.warmupSteps,
            hrZones: source.hrZones,
            syncedAtMs: syncedAtMs,
            userId: source.userId
        )
    }
}

// ─── Start countdown overlay ───────────────────────────────────────

/// 3-2-1-go intro shown when the active workout view first mounts.
/// Only plays for a workout that was started from the watch itself;
/// phone-originated starts open this view directly without trying to
/// sync the animation across devices.
private struct StartCountdownOverlay: View {
    let onComplete: () -> Void
    @EnvironmentObject var theme: ThemeStore

    // Ticks match the phone side's cadence: 3 / 2 / 1 at 700ms each,
    // resolved by the motivational phrase for 1100ms.
    //
    // ⚠️ Keep this pool in sync with `src/constants/startPhrases.ts`.
    // Swift + TS don't share modules so the list is duplicated by
    // hand — the header comment in the TS file calls this out too.
    private static let phrases = [
        "LET'S GO!", "LIGHTS OUT.", "LOCK IN.", "SHOW UP.", "EARN IT.",
        "GAME TIME.", "DIG IN.", "RISE UP.", "YOUR MOVE.", "MAKE IT COUNT.",
        "NO EXCUSES.", "LEAVE IT ALL.", "BEAST MODE.", "FULL SEND.", "STAY HUNGRY.",
        "GRIND ON.", "BREAK LIMITS.", "OWN IT.", "ATTACK.", "NO MERCY.",
        "DOMINATE.", "FOCUS UP.", "LEVEL UP.", "WORK.", "PUSH HARDER.",
        "HEART IN.", "BRING HEAT.", "GO TIME.", "CLAIM IT.", "NO QUIT.",
        "OUTWORK.", "SEND IT.", "WAR MODE.", "NEXT REP.", "UNLEASH.",
        "RAW POWER.", "STAY SHARP.", "BE RUTHLESS.", "ALL IN.", "TRUST IT.",
        "TUNE IN.", "DRIVE.", "KEEP GOING.", "EVERY REP.", "EARN TODAY.",
        "FUEL UP.", "OUTLAST.", "WIN REPS.", "CRUSH IT.", "OWN THE HOUR.",
        "LIGHT IT UP.", "KEEP PUSHING.", "SWEAT NOW.", "NO OFF DAYS.", "RAISE THE BAR.",
        "HEAD DOWN.", "CHIN UP.", "STAY STRONG.", "HOLD THE LINE.", "OUTGRIND.",
        "FIRE UP.", "BE THE WORK.", "NO COMFORT.", "HUSTLE.", "SAVAGE.",
        "GO BIG.", "ONE MORE.", "EFFORT FIRST.", "BEAT YESTERDAY.", "MAKE MOVES.",
        "PROVE IT.", "STACK WINS.", "MOVE WEIGHT.", "BUILD IT.", "OWN THE DAY.",
        "DIAL IN.", "RAISE HELL.", "UNBROKEN.", "BURN IT.", "SET PACE.",
        "SPARK UP.", "GO HEAVIER.", "NO STEP BACK.", "PRIDE ON.", "NOTHING EASY.",
        "FORGE ON.", "RUN IT UP.", "WORK SPEAKS.", "KEEP EDGE.", "BREAKTHROUGH.",
        "HEAT CHECK.", "GO AGAIN.", "FULL BORE.", "GAME ON.", "DO THE WORK.",
        "REP FOR REP.", "RISE TO IT.", "MAKE THEM LOOK.", "STRONGER TODAY.",
        "FINISH STRONG.", "NO BLINKING.",
    ]
    private static let ticks: [(label: String, ms: Int, isFinal: Bool)] = [
        ("3", 700, false),
        ("2", 700, false),
        ("1", 700, false),
        (phrases.randomElement() ?? "LET'S GO!", 1100, true),
    ]

    @State private var idx: Int = 0
    @State private var scale: CGFloat = 1.35
    @State private var opacity: Double = 0

    var body: some View {
        let tick = Self.ticks[min(idx, Self.ticks.count - 1)]
        ZStack {
            // Near-opaque themed backdrop so the underlying workout
            // view doesn't leak through mid-animation.
            theme.background.opacity(0.95).ignoresSafeArea()
            // Coloured halo — matches the phone version's ring behind
            // the numeral. Same primary @ 10% fill + 33% border.
            Circle()
                .fill(theme.primary.opacity(0.1))
                .overlay(
                    Circle().stroke(theme.primary.opacity(0.33), lineWidth: 2)
                )
                .frame(width: 140, height: 140)
            VStack(spacing: 6) {
                Text(tick.label)
                    // Final phrase starts at 20pt (smaller than the
                    // 70pt digit) so even long strings like
                    // "MAKE IT COUNT." fit inside the 140pt halo.
                    // minimumScaleFactor lets it shrink further as
                    // needed. frame(maxWidth:) clamps to halo diameter.
                    .font(.system(size: tick.isFinal ? 20 : 70, weight: .black, design: .rounded))
                    .foregroundColor(theme.primary)
                    .minimumScaleFactor(0.4)
                    .lineLimit(1)
                    .frame(maxWidth: 124)
                    .scaleEffect(scale)
                    .opacity(opacity)
                if !tick.isFinal {
                    Text("STARTING")
                        .font(.system(size: 8, weight: .heavy))
                        .tracking(1.4)
                        .foregroundColor(theme.textMuted)
                        .opacity(opacity)
                }
            }
        }
        .onAppear { playTick() }
    }

    private func playTick() {
        guard idx < Self.ticks.count else {
            onComplete()
            return
        }
        let tick = Self.ticks[idx]
        // Light haptic on counts, success on the final go-word — the
        // watch's taptic engine separates these clearly.
        WKInterfaceDevice.current().play(tick.isFinal ? .success : .click)
        scale = 1.35
        opacity = 0
        withAnimation(.easeOut(duration: 0.18)) {
            scale = 1.0
            opacity = 1
        }
        let ms = tick.ms
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms - 220)) {
            withAnimation(.easeIn(duration: 0.2)) {
                opacity = 0
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms)) {
            idx += 1
            playTick()
        }
    }
}

// ─── Exercise tab ──────────────────────────────────────────────────

private struct WatchPendingRirLog: Equatable {
    let exerciseIndex: Int
    let setNumber: Int
    let weightLbs: Double
    let reps: Int
}

private func hrZoneColor(_ zone: Int?) -> Color {
    switch zone {
    case 1: return Color(hex: "#38BDF8")
    case 2: return Color(hex: "#22C55E")
    case 3: return Color(hex: "#EAB308")
    case 4: return Color(hex: "#F97316")
    case 5: return Color(hex: "#EF4444")
    default: return Color(hex: "#38BDF8")
    }
}

private struct ExerciseTab: View {
    let workout: WatchWorkout
    @ObservedObject var state: ActiveWorkoutState
    @ObservedObject var hr: HeartRateStore
    let onOptimisticAddExercise: (WatchTemplateExercise, String) -> Void
    let onEndWorkout: ([String: Any]?) -> Void
    let onCancelWorkout: () -> Void

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var conn: ConnectivityStore

    // Digital-crown focus flags. Only one receives Crown input at a
    // time; tapping the label swaps focus so the user can switch
    // between weight and reps without buttons.
    @State private var crownTarget: CrownTarget = .weight
    @State private var showMenu: Bool = false
    @State private var showSwapSheet: Bool = false
    @State private var pendingSwapName: String? = nil
    @State private var pendingRirLog: WatchPendingRirLog? = nil
    @State private var pendingCircuit: WatchCircuitKind? = nil
    @State private var cardioMetricEmitTimer: Timer? = nil
    /// "Add exercise" sheet — built from the unique exercise names
    /// across the user's synced templates (a meaningful "recents"
    /// proxy without needing a separate sync layer). Tap → fires
    /// `add_exercise` to phone which appends to the active session.
    @State private var showAddExerciseSheet: Bool = false
    // Confirm before cutting a rest short — accidental wrist-taps on
    // the rest card were silently skipping recovery between sets.
    // Mirrors the same confirmation the phone shows.
    @State private var showSkipRestConfirm: Bool = false

    enum CrownTarget { case weight, reps }

    var currentExercise: WatchExercise? {
        workout.exercises.indices.contains(state.exerciseIndex)
            ? workout.exercises[state.exerciseIndex] : nil
    }

    var nextExercise: WatchExercise? {
        let idx = state.exerciseIndex + 1
        return workout.exercises.indices.contains(idx)
            ? workout.exercises[idx] : nil
    }

    var isLastSet: Bool {
        guard let ex = currentExercise else { return false }
        return state.setNumber >= ex.sets
    }

    private var currentExerciseIsCardio: Bool {
        guard let ex = currentExercise else { return false }
        return isWatchCardioExercise(ex)
    }

    private var currentTimedCardioElapsedSeconds: Int? {
        guard let ex = currentExercise, isWatchCardioExercise(ex), isTimedExercise(ex) else { return nil }
        let elapsed = state.timedElapsed(for: timedTimerKey(for: ex))
        return elapsed > 0 ? elapsed : nil
    }

    private var cardioMetricsElapsedSeconds: Int {
        currentTimedCardioElapsedSeconds ?? hr.elapsedSeconds
    }

    private func displaySetNumber(for ex: WatchExercise) -> Int {
        min(max(1, state.setNumber), max(1, ex.sets))
    }

    private func isGuideExercise(_ ex: WatchExercise) -> Bool {
        if ex.isGuide == true { return true }
        let name = ex.name.lowercased()
        let role = (ex.slotRole ?? "").lowercased()
        if ["mobility", "recovery", "stretch", "cooldown"].contains(role) { return true }
        return name.range(
            of: "stretch|foam.?roll|cat.?cow|pigeon|child.?s pose|spinal.?twist|world.?s greatest|90.?90|thoracic|downward.?dog|cobra|butterfly|savasana|yoga|vinyasa|\\byin\\b|\\bflow\\b|mobility|pose\\b|breathwork|breathing|meditation",
            options: .regularExpression
        ) != nil
    }

    private func isTimedExercise(_ ex: WatchExercise) -> Bool {
        if let isTimed = ex.isTimed { return isTimed }
        return plannedDurationSeconds(for: ex) != nil
    }

    private func tracksWeightInput(for ex: WatchExercise) -> Bool {
        !isGuideExercise(ex) && ex.tracksWeightInput
    }

    private func durationTargetText(for ex: WatchExercise) -> String {
        if let seconds = plannedDurationSeconds(for: ex) {
            return formatTime(seconds)
        }
        let raw = ex.reps.trimmingCharacters(in: .whitespacesAndNewlines)
        return raw.isEmpty ? "Timed" : raw
    }

    private func setTargetText(for ex: WatchExercise) -> String {
        isTimedExercise(ex) ? durationTargetText(for: ex) : ex.reps
    }

    private func liveRecommendationText(for ex: WatchExercise) -> String? {
        guard !isGuideExercise(ex), !isTimedExercise(ex) else { return nil }
        let live = state.currentRecommendation?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let live, !live.isEmpty { return live }
        let planned = ex.recommendation?.trimmingCharacters(in: .whitespacesAndNewlines)
        return planned?.isEmpty == false ? planned : nil
    }

    private func targetRepMax(_ raw: String) -> Int? {
        let regex = try? NSRegularExpression(pattern: "\\d+")
        let nsRange = NSRange(raw.startIndex..<raw.endIndex, in: raw)
        let values = regex?.matches(in: raw, range: nsRange).compactMap { match -> Int? in
            guard let range = Range(match.range, in: raw) else { return nil }
            return Int(raw[range])
        } ?? []
        guard let first = values.first else { return nil }
        let hasRange = raw.range(of: "\\d+\\s*[-–—]\\s*\\d+", options: .regularExpression) != nil
        return hasRange && values.count >= 2 ? values[1] : first
    }

    private func firstRepCount(_ raw: String) -> Int? {
        let regex = try? NSRegularExpression(pattern: "\\d+")
        let nsRange = NSRange(raw.startIndex..<raw.endIndex, in: raw)
        let values = regex?.matches(in: raw, range: nsRange).compactMap { match -> Int? in
            guard let range = Range(match.range, in: raw) else { return nil }
            return Int(raw[range])
        } ?? []
        guard let first = values.first else { return nil }
        let hasRange = raw.range(of: "\\d+\\s*[-–—]\\s*\\d+", options: .regularExpression) != nil
        if hasRange && values.count >= 2 {
            return max(0, (first + values[1]) / 2)
        }
        return first
    }

    private func localLoadIncrement(for ex: WatchExercise) -> Double {
        let equipment = (ex.equipment ?? "").lowercased()
        if equipment.range(of: "bodyweight|body weight|\\bnone\\b|\\bbw\\b", options: .regularExpression) != nil {
            return 0
        }
        let primary = (ex.primaryMuscle ?? "").lowercased()
        let isLowerBody = ["quads", "hamstrings", "glutes", "adductors", "abductors"].contains(primary)
        if equipment.range(of: "barbell|trap bar|trap_bar|ez curl|ez_curl|landmine", options: .regularExpression) != nil {
            return isLowerBody ? 10 : 5
        }
        if equipment.contains("dumbbell") { return 2.5 }
        if equipment.range(of: "machine|cable|plate|leg press|leg_press|pulldown|smith", options: .regularExpression) != nil {
            return 2.5
        }
        return 5
    }

    private func loadUnitDisplaySuffix(_ ex: WatchExercise) -> String {
        if let raw = ex.loadUnit?.lowercased()
            .replacingOccurrences(of: "-", with: "_")
            .replacingOccurrences(of: " ", with: "_") {
            if ["total", "total_load", "single_implement", "single_dumbbell"].contains(raw) {
                return ""
            }
            if ["per_dumbbell", "per_db", "per_hand", "dumbbell_each"].contains(raw) {
                return " each"
            }
            if ["per_side", "per_arm", "per_leg", "per_handle", "single_side"].contains(raw) {
                return " per side"
            }
        }
        let name = "\(ex.name) \(ex.slug ?? "")"
            .lowercased()
            .replacingOccurrences(of: "_", with: " ")
        let text = "\(ex.equipment ?? "") \(name)".lowercased()
        if text.range(of: "\\bdual[ _-]?cable[ _-]?station\\b|\\bdual cable\\b", options: .regularExpression) != nil {
            return " per side"
        }
        if text.contains("cable") && name.range(of: "\\b(pallof|woodchop)\\b", options: .regularExpression) != nil {
            return " per side"
        }
        if name.range(
            of: "\\b(goblet|sumo\\s+squat|dumbbell\\s+hip\\s+thrust|dumbbell\\s+pullover|(dumbbell|weighted)\\s+(sit[- ]?up|crunch)|standing\\s+dumbbell\\s+triceps?\\s+extension|overhead\\s+dumbbell\\s+triceps?\\s+extension)\\b",
            options: .regularExpression
        ) != nil {
            return ""
        }
        if name.contains("suitcase") && text.range(of: "\\bdumbbell(s)?\\b|\\bdb\\b", options: .regularExpression) != nil {
            return " per side"
        }
        return text.range(of: "\\bdumbbell(s)?\\b|\\bdb\\b", options: .regularExpression) != nil ? " each" : ""
    }

    private func localRecommendationAfterWatchLog(
        for ex: WatchExercise,
        nextSetNumber: Int,
        loggedWeight: Double,
        loggedReps: Int,
        rir: Int?,
        weighted: Bool
    ) -> WatchLocalRecommendation? {
        let targetReps = ex.reps.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? String(max(1, loggedReps))
            : ex.reps
        if weighted && loggedWeight > 0 {
            var nextWeight = loggedWeight
            let cue: String
            if let rir {
                if rir <= 1 {
                    cue = "Close to failure. Repeat this load and protect form."
                } else if rir == 2 {
                    cue = "Strong set. Repeat this load and own the rep range."
                } else if rir == 3 {
                    nextWeight = loggedWeight + localLoadIncrement(for: ex) * 2
                    cue = "Room in reserve. Add a small jump if setup feels locked in."
                } else {
                    nextWeight = loggedWeight + localLoadIncrement(for: ex) * 2
                    cue = "Clearly under target effort. Add load on the next set."
                }
            } else {
                cue = "Match your last set with clean form."
            }
            let displayWeight = "\(formatWeight(nextWeight)) lb\(loadUnitDisplaySuffix(ex))"
            return WatchLocalRecommendation(
                text: "Set \(nextSetNumber): \(displayWeight) x \(targetReps) - \(cue)",
                weightLbs: nextWeight,
                reps: targetReps
            )
        }

        let repsText = loggedReps > 0 ? String(loggedReps) : targetReps
        let cue = loggedReps > 0
            ? "Match or beat your last set with clean reps."
            : "Use a comfortable load for clean reps."
        return WatchLocalRecommendation(
            text: "Set \(nextSetNumber): \(targetReps) reps - \(cue)",
            weightLbs: nil,
            reps: repsText
        )
    }

    private func shouldPromptRir(actualReps: Int, targetReps: String) -> Bool {
        guard actualReps > 0, let maxReps = targetRepMax(targetReps) else { return false }
        return actualReps >= maxReps
    }

    var isLastExercise: Bool {
        state.exerciseIndex >= workout.exercises.count - 1
    }

    // Small HR chip color mirrors the HR tab's zone palette so the two
    // views read consistently. Falls back to muted when no zone yet.
    var hrChipColor: Color {
        hrZoneColor(hr.zone)
    }

    private static let exerciseTopID = "exercise-top"
    @State private var warmupDismissed: Bool = false

    var body: some View {
        ScrollViewReader { proxy in
            ZStack {
                theme.background.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        Color.clear
                            .frame(height: 0)
                            .id(Self.exerciseTopID)
                        // Warm-up card — only shown before the first set of
                        // the first exercise. Once the user taps "Start" it
                        // collapses and won't reappear during this session.
                        if !warmupDismissed,
                           let steps = workout.warmupSteps, !steps.isEmpty,
                           state.exerciseIndex == 0, state.setNumber == 1 {
                            warmupCard(steps: steps)
                        }
                        if let ex = currentExercise {
                            header(ex)
                            // Either the rest timer OR the set input
                            // panel — never both; less visual noise.
                            if let rest = state.restRemaining, rest > 0 {
                                restCard(rest: rest)
                            } else {
                                logSetCard(ex)
                            }
                            footer()
                        } else if workout.exercises.isEmpty {
                            // Placeholder / empty-shell workout — keep the
                            // screen ALIVE with live HR + timer so watchOS
                            // doesn't background the app during the first
                            // few seconds while HKWorkoutSession spins up
                            // and the phone push lands. Without this, an
                            // empty-exercises shell rendered "Workout done"
                            // immediately and watchOS pre-empted the app
                            // (the "watch closes on Start" bug).
                            //
                            // A `watch-` prefixed sessionId means the user
                            // started this from QuickStart on the wrist. It
                            // is NOT loading from phone — saying so would
                            // mislead the user into waiting forever for a
                            // payload that's never coming. (Cardio sessions
                            // route to CardioActiveTab, but a watch-started
                            // strength shell with no exercises ends up here.)
                            let isWatchInitiated = workout.sessionId?.hasPrefix("watch-") == true
                            if isWatchInitiated {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(workout.focus.uppercased())
                                        .font(.system(size: 11, weight: .heavy))
                                        .tracking(1.2)
                                        .foregroundColor(theme.textMuted)
                                    // Primary metric — elapsed time. Yoga,
                                    // stretch and sport workouts have no
                                    // distance/sets to anchor on, so the timer
                                    // is the at-a-glance feedback the user
                                    // wants to see on every wrist-up. Mirrors
                                    // CardioActiveTab's big-timer-up-top layout.
                                    Text(formatElapsed(hr.elapsedSeconds))
                                        .font(.system(size: 36, weight: .black, design: .rounded))
                                        .foregroundColor(theme.textPrimary)
                                        .monospacedDigit()
                                    HStack(spacing: 6) {
                                        Image(systemName: "heart.fill")
                                            .foregroundColor(theme.error)
                                            .font(.system(size: 12))
                                        Text(hr.heartRate.map { "\($0)" } ?? "—")
                                            .font(.system(size: 22, weight: .heavy, design: .rounded))
                                            .foregroundColor(theme.textPrimary)
                                            .monospacedDigit()
                                        Text("BPM")
                                            .font(.system(size: 9, weight: .heavy))
                                            .foregroundColor(theme.textMuted)
                                    }
                                    Text("Tracking on watch")
                                        .font(.system(size: 10, weight: .semibold))
                                        .foregroundColor(theme.textSecondary)
                                    if let err = hr.errorMessage {
                                        Text("HR: \(err)")
                                            .font(.system(size: 10))
                                            .foregroundColor(theme.warning)
                                            .lineLimit(3)
                                    }
                                    Text(hr.running ? "HR session active" : "Starting HR session…")
                                        .font(.system(size: 9))
                                        .foregroundColor(hr.running ? theme.success : theme.textMuted)
                                }
                                .padding(8)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(theme.surface)
                                .cornerRadius(8)
                            } else {
                                phoneSyncingCard()
                            }
                            // The empty-exercises placeholder previously had
                            // no End / Cancel controls, so any watch-initiated
                            // session that landed here (sport, mobility, or a
                            // cardio that hadn't yet been classified by
                            // `hr.isCardio`) trapped the user with HR + no
                            // way out — navigation back button is also hidden.
                            footer()
                        } else {
                            completedPlannedWorkCard()
                            // Without an End button here the user couldn't
                            // finalize the session once every exercise was
                            // logged — they had to swipe back to a logged
                            // exercise just to find the footer.
                            footer()
                        }
                    }
                    .padding(10)
                }
            }
            .confirmationDialog("Exercise options", isPresented: $showMenu) {
                if let ex = currentExercise, !ex.swapOptions.isEmpty {
                    Button("Swap exercise") { showSwapSheet = true }
                }
                Button("Add exercise") { showAddExerciseSheet = true }
                Button("Skip exercise", role: .destructive) { advanceExercise() }
                Button("Cancel", role: .cancel) {}
            }
            .sheet(isPresented: $showSwapSheet) {
                if let ex = currentExercise {
                    SwapExerciseSheet(
                        exercise: ex,
                        pendingName: pendingSwapName,
                        onSelect: requestSwap,
                    )
                }
            }
            .sheet(isPresented: $showAddExerciseSheet) {
                AddExerciseSheet(
                    templates: conn.templates?.templates ?? [],
                    currentExerciseNames: Set(workout.exercises.map { $0.name.lowercased() }),
                    onPick: requestAddExercise,
                    onCancel: { showAddExerciseSheet = false }
                )
            }
            .onChange(of: state.exerciseIndex) { _, _ in
                scrollExerciseToTop(proxy)
            }
            .onChange(of: currentExercise?.id) { _, _ in
                let newName = currentExercise?.name
                if pendingSwapName == newName {
                    pendingSwapName = nil
                }
                pendingRirLog = nil
                syncHeartRateActivityForCurrentExercise()
            }
            .onChange(of: workout.exercises) { _, _ in
                pendingCircuit = nil
            }
            .onAppear {
                syncHeartRateActivityForCurrentExercise()
            }
            .onDisappear {
                stopCardioMetricEmitter()
            }
        }
    }

    private func scrollExerciseToTop(_ proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.22)) {
            proxy.scrollTo(Self.exerciseTopID, anchor: .top)
        }
    }

    private func phoneSyncingCard() -> some View {
        VStack(spacing: 10) {
            ProgressView()
                .tint(theme.primary)
            Text("Syncing with phone")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(theme.textSecondary)
        }
        .frame(maxWidth: .infinity, minHeight: 110)
        .padding(10)
        .background(theme.surface)
        .cornerRadius(8)
    }

    private func completedPlannedWorkCard() -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundColor(theme.success)
                Text("PLANNED WORK DONE")
                    .font(.system(size: 10, weight: .black))
                    .tracking(1.0)
                    .foregroundColor(theme.success)
            }
            if hr.running || hr.elapsedSeconds > 0 {
                HStack(spacing: 4) {
                    Image(systemName: "stopwatch")
                        .font(.system(size: 10))
                        .foregroundColor(theme.textMuted)
                    Text(formatElapsed(hr.elapsedSeconds))
                        .font(.system(size: 18, weight: .heavy, design: .rounded))
                        .foregroundColor(theme.textSecondary)
                        .monospacedDigit()
                }
            }
            if !hasWatchCoreCircuit(workout.exercises) {
                completedActionButton(
                    icon: pendingCircuit == .core ? "clock" : WatchCircuitKind.core.icon,
                    title: pendingCircuit == .core ? "Adding Core…" : "Add Core",
                    color: theme.primary
                ) {
                    requestCircuit(.core)
                }
            }
            if !hasWatchStretchBlock(workout.exercises) {
                completedActionButton(
                    icon: pendingCircuit == .stretch ? "clock" : WatchCircuitKind.stretch.icon,
                    title: pendingCircuit == .stretch ? "Adding Stretch…" : "Add Stretch",
                    color: theme.primary
                ) {
                    requestCircuit(.stretch)
                }
            }
            completedActionButton(
                icon: "plus.circle.fill",
                title: "Add Exercise",
                color: theme.textPrimary
            ) {
                showAddExerciseSheet = true
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.surface)
        .cornerRadius(12)
    }

    private func completedActionButton(
        icon: String,
        title: String,
        color: Color,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: icon)
                    .font(.system(size: 12, weight: .bold))
                Text(title)
                    .font(.system(size: 12, weight: .heavy))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Spacer(minLength: 0)
            }
            .padding(9)
            .foregroundColor(color)
            .background(color.opacity(0.12))
            .cornerRadius(9)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func warmupCard(steps: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "flame.fill")
                    .font(.system(size: 10))
                    .foregroundColor(theme.primary)
                Text("WARM-UP")
                    .font(.system(size: 9, weight: .heavy))
                    .tracking(1.2)
                    .foregroundColor(theme.primary)
                Spacer()
            }
            ForEach(Array(steps.prefix(5).enumerated()), id: \.offset) { _, step in
                Text("• \(step)")
                    .font(.system(size: 11))
                    .foregroundColor(theme.textSecondary)
                    .lineLimit(3)
            }
            Button {
                WKInterfaceDevice.current().play(.click)
                withAnimation(.easeOut(duration: 0.22)) { warmupDismissed = true }
            } label: {
                Text("Start lifts")
                    .font(.system(size: 12, weight: .bold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(theme.primary)
                    .foregroundColor(theme.background)
                    .cornerRadius(9)
            }
            .buttonStyle(.plain)
            .padding(.top, 4)
        }
        .padding(10)
        .background(theme.surface)
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(theme.primary.opacity(0.5), lineWidth: 1),
        )
        .cornerRadius(12)
    }

    private func header(_ ex: WatchExercise) -> some View {
        let timed = isTimedExercise(ex)
        return VStack(alignment: .leading, spacing: 3) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    Text("EXERCISE \(state.exerciseIndex + 1) / \(workout.exercises.count)")
                        .font(.system(size: 9, weight: .bold))
                        .tracking(1)
                        .foregroundColor(theme.textMuted)
                    if let role = ex.slotRole, !role.isEmpty, role != "primary" {
                        Text(role.uppercased())
                            .font(.system(size: 8, weight: .heavy))
                            .tracking(0.6)
                            .foregroundColor(theme.warning)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(theme.warning.opacity(0.15))
                            .cornerRadius(4)
                    }
                    Spacer(minLength: 0)
                }

                HStack(spacing: 5) {
                    // Persistent elapsed-time chip — gives the user a
                    // running session clock without leaving the exercise
                    // tab. Hidden until HR session has actually started so
                    // pre-warm seconds don't show as a confusing "0:01"
                    // before the workout truly begins.
                    if hr.running && !(currentExerciseIsCardio && timed) {
                        HStack(spacing: 3) {
                            Image(systemName: "stopwatch")
                                .font(.system(size: 8))
                            Text(formatElapsed(hr.elapsedSeconds))
                                .font(.system(size: 11, weight: .heavy, design: .rounded))
                                .monospacedDigit()
                                .lineLimit(1)
                        }
                        .foregroundColor(theme.textSecondary)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(theme.surfaceRaised)
                        .cornerRadius(5)
                    }

                    // Persistent HR chip — always visible while a reading
                    // exists so users don't have to swipe to the HR tab
                    // just to glance at their bpm mid-set.
                    if let bpm = hr.heartRate {
                        HStack(spacing: 3) {
                            Image(systemName: "heart.fill")
                                .font(.system(size: 8))
                            Text(hr.zone.map { "Z\($0) \(bpm)" } ?? "\(bpm)")
                                .font(.system(size: 11, weight: .heavy, design: .rounded))
                                .lineLimit(1)
                        }
                        .foregroundColor(hrChipColor)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(hrChipColor.opacity(0.15))
                        .cornerRadius(5)
                    }
                    Spacer(minLength: 0)
                }
            }
            // Long-press opens the skip/swap menu — can't add swap
            // yet without a library sync to the watch, but skip is
            // the most-requested escape hatch.
            Text(ex.name)
                .font(.system(size: 17, weight: .heavy))
                .foregroundColor(theme.textPrimary)
                .lineLimit(2)
                .onLongPressGesture { showMenu = true }
            HStack(spacing: 4) {
                Text(timed ? (ex.sets > 1 ? "ROUND" : "TIME") : "SET")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(theme.textMuted)
                Text("\(displaySetNumber(for: ex)) of \(ex.sets)")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(theme.textPrimary)
                Text("·")
                    .foregroundColor(theme.textMuted)
                Text(setTargetText(for: ex))
                    .font(.system(size: 12))
                    .foregroundColor(theme.textSecondary)
                if state.paused {
                    Text("PAUSED")
                        .font(.system(size: 9, weight: .heavy))
                        .foregroundColor(theme.warning)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(theme.warning.opacity(0.15))
                        .cornerRadius(4)
                }
            }
            if let rec = liveRecommendationText(for: ex) {
                Text(rec)
                    .font(.system(size: 11))
                    .foregroundColor(theme.primary)
                    .lineLimit(2)
            }
            if !isGuideExercise(ex), !timed, let lr = state.lastLoggedReps {
                if tracksWeightInput(for: ex), let lw = state.lastLoggedWeight {
                    Text("Last: \(Int(lw)) lb × \(lr)")
                        .font(.system(size: 10))
                        .foregroundColor(theme.textMuted)
                } else {
                    Text("Last: \(lr) reps")
                        .font(.system(size: 10))
                        .foregroundColor(theme.textMuted)
                }
            }
            if let pendingSwapName {
                Text("Swapping to \(pendingSwapName)…")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(theme.warning)
                    .lineLimit(1)
            }
        }
    }

    // ─── Log-set card (Crown → weight or reps) ─────────────────────

    @ViewBuilder
    private func logSetCard(_ ex: WatchExercise) -> some View {
        if isTimedExercise(ex) {
            timedSetCard(ex)
        } else if isGuideExercise(ex) {
            guideSetCard(ex)
        } else if let pending = pendingRirLog,
                  pending.exerciseIndex == state.exerciseIndex,
                  pending.setNumber == displaySetNumber(for: ex) {
            rirPromptCard(pending)
        } else {
            let weighted = tracksWeightInput(for: ex)
            let crownIsWeight = weighted && crownTarget == .weight
            VStack(alignment: .leading, spacing: 10) {
                if weighted {
                    recommendedWeightRow(ex)
                }
                // Weight row — pill + stepper buttons. Stepper gives the
                // user an obvious way to change the number without having
                // to know the Digital Crown is the input device. Crown
                // still works when the pill is focused.
                if weighted {
                    HStack(spacing: 4) {
                        Button {
                            state.pendingWeight = max(0, state.pendingWeight - 5)
                            WKInterfaceDevice.current().play(.click)
                        } label: {
                            Text("−").font(.system(size: 22, weight: .black))
                                .frame(width: 34, height: 34)
                                .background(theme.surfaceRaised)
                                .cornerRadius(8)
                                .foregroundColor(theme.textPrimary)
                        }
                        .buttonStyle(.plain)
                        crownPill("Weight", value: "\(Int(state.pendingWeight)) lb", active: crownTarget == .weight) {
                            crownTarget = .weight
                        }
                        Button {
                            state.pendingWeight = state.pendingWeight + 5
                            WKInterfaceDevice.current().play(.click)
                        } label: {
                            Text("+").font(.system(size: 22, weight: .black))
                                .frame(width: 34, height: 34)
                                .background(theme.surfaceRaised)
                                .cornerRadius(8)
                                .foregroundColor(theme.textPrimary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                HStack(spacing: 4) {
                    Button {
                        state.pendingReps = max(0, state.pendingReps - 1)
                        WKInterfaceDevice.current().play(.click)
                    } label: {
                        Text("−").font(.system(size: 22, weight: .black))
                            .frame(width: 34, height: 34)
                            .background(theme.surfaceRaised)
                            .cornerRadius(8)
                            .foregroundColor(theme.textPrimary)
                    }
                    .buttonStyle(.plain)
                    crownPill("Reps", value: "\(state.pendingReps)", active: !weighted || crownTarget == .reps) {
                        crownTarget = .reps
                    }
                    Button {
                        state.pendingReps = state.pendingReps + 1
                        WKInterfaceDevice.current().play(.click)
                    } label: {
                        Text("+").font(.system(size: 22, weight: .black))
                            .frame(width: 34, height: 34)
                            .background(theme.surfaceRaised)
                            .cornerRadius(8)
                            .foregroundColor(theme.textPrimary)
                    }
                    .buttonStyle(.plain)
                }
                Text(weighted ? "Tap a field then turn the Digital Crown, or use −/+" : "Turn the Digital Crown, or use −/+")
                    .font(.system(size: 9))
                    .foregroundColor(theme.textMuted)
                    .lineLimit(2)
                Button(action: logSet) {
                    HStack {
                        Image(systemName: "checkmark.circle.fill")
                        Text(isLastSet ? (isLastExercise ? "Log final set" : "Log & next exercise") : "Log set")
                            .fontWeight(.bold)
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .padding(.vertical, 9)
                .background(theme.primary)
                .foregroundColor(theme.background)
                .cornerRadius(10)
            }
            .padding(10)
            .background(theme.surface)
            .cornerRadius(12)
            // Bind Crown to whichever input is active. Weight moves in
            // 2.5 lb increments (dumbbell granularity); reps in 1.
            .focusable(true)
            .digitalCrownRotation(
                crownIsWeight
                  ? Binding(get: { state.pendingWeight }, set: { state.pendingWeight = max(0, $0) })
                  : Binding(get: { Double(state.pendingReps) },
                            set: {
                                state.pendingReps = max(0, Int($0.rounded()))
                            }),
                from: 0,
                through: crownIsWeight ? 1000 : 50,
                by: crownIsWeight ? 2.5 : 1,
                sensitivity: .low,
                isContinuous: false,
                isHapticFeedbackEnabled: true
            )
        }
    }

    private func timedSetCard(_ ex: WatchExercise) -> some View {
        let timerKey = timedTimerKey(for: ex)
        let elapsed = state.timedElapsed(for: timerKey)
        let running = state.timedTimerIsRunning(for: timerKey)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "stopwatch.fill")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundColor(theme.primary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(ex.sets > 1 ? "TIMED ROUND" : "TIMED")
                        .font(.system(size: 9, weight: .heavy))
                        .tracking(0.8)
                        .foregroundColor(theme.primary)
                    Text(durationTargetText(for: ex))
                        .font(.system(size: 18, weight: .black, design: .rounded))
                        .foregroundColor(theme.textPrimary)
                    if !ex.reps.isEmpty && ex.reps != durationTargetText(for: ex) {
                        Text(ex.reps)
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(theme.textMuted)
                            .lineLimit(1)
                    }
                }
            }

            VStack(alignment: .center, spacing: 3) {
                Text(formatElapsed(elapsed))
                    .font(.system(size: 38, weight: .black, design: .rounded))
                    .foregroundColor(running ? theme.primary : theme.textPrimary)
                    .monospacedDigit()
                Text(running ? "Running" : elapsed > 0 ? "Paused" : "Ready")
                    .font(.system(size: 9, weight: .heavy))
                    .foregroundColor(theme.textMuted)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)

            if isWatchCardioExercise(ex) {
                cardioMetricsPanel
            }

            HStack(spacing: 6) {
                if running {
                    Button {
                        state.pauseTimedTimer()
                        WKInterfaceDevice.current().play(.click)
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "pause.fill")
                            Text("Pause")
                                .fontWeight(.bold)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, 9)
                    .background(theme.error.opacity(0.18))
                    .foregroundColor(theme.error)
                    .cornerRadius(10)
                } else {
                    Button {
                        syncHeartRateActivityForCurrentExercise()
                        state.startTimedTimer(key: timerKey)
                        WKInterfaceDevice.current().play(.click)
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: elapsed > 0 ? "play.fill" : "play.circle.fill")
                            Text(elapsed > 0 ? "Resume" : "Start")
                                .fontWeight(.bold)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, 9)
                    .background(theme.primary)
                    .foregroundColor(theme.background)
                    .cornerRadius(10)
                }
                if elapsed > 0 && !running {
                    Button {
                        state.resetTimedTimer(key: timerKey)
                        WKInterfaceDevice.current().play(.click)
                    } label: {
                        Image(systemName: "arrow.counterclockwise")
                            .font(.system(size: 13, weight: .bold))
                            .frame(width: 32, height: 36)
                    }
                    .buttonStyle(.plain)
                    .background(theme.surfaceRaised)
                    .foregroundColor(theme.textSecondary)
                    .cornerRadius(10)
                }
            }

            Button(action: logSet) {
                HStack {
                    Image(systemName: "checkmark.circle.fill")
                    Text(isLastSet ? "Done" : "Log round")
                        .fontWeight(.bold)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .padding(.vertical, 9)
            .background(theme.primary)
            .foregroundColor(theme.background)
            .cornerRadius(10)
        }
        .padding(10)
        .background(theme.surface)
        .cornerRadius(12)
    }

    private func rirPromptCard(_ pending: WatchPendingRirLog) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 6) {
                Image(systemName: "target")
                    .font(.system(size: 13, weight: .heavy))
                    .foregroundColor(theme.primary)
                Text("REPS IN RESERVE")
                    .font(.system(size: 9, weight: .heavy))
                    .tracking(0.8)
                    .foregroundColor(theme.primary)
            }
            Text("How many more reps could you have done?")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(theme.textPrimary)
                .lineLimit(2)
            HStack(spacing: 4) {
                ForEach([0, 1, 2, 3, 4], id: \.self) { rir in
                    Button {
                        commitLoggedSet(rir: rir, pendingLog: pending)
                    } label: {
                        Text(rir == 4 ? "4+" : "\(rir)")
                            .font(.system(size: 12, weight: .black))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                    }
                    .buttonStyle(.plain)
                    .background(theme.primary)
                    .foregroundColor(theme.background)
                    .cornerRadius(8)
                }
            }
            Button {
                commitLoggedSet(rir: nil, pendingLog: pending)
            } label: {
                Text("Skip")
                    .font(.system(size: 11, weight: .bold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 7)
            }
            .buttonStyle(.plain)
            .background(theme.surfaceRaised)
            .foregroundColor(theme.textMuted)
            .cornerRadius(8)
        }
        .padding(10)
        .background(theme.surface)
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(theme.primary.opacity(0.45), lineWidth: 1)
        )
        .cornerRadius(12)
    }

    private func guideSetCard(_ ex: WatchExercise) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "figure.cooldown")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundColor(theme.primary)
                VStack(alignment: .leading, spacing: 2) {
                    Text("GUIDE")
                        .font(.system(size: 9, weight: .heavy))
                        .tracking(0.8)
                        .foregroundColor(theme.primary)
                    Text(ex.reps.isEmpty ? "Move by feel" : ex.reps)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(theme.textSecondary)
                        .lineLimit(2)
                }
            }
            Button(action: logSet) {
                HStack {
                    Image(systemName: "checkmark.circle.fill")
                    Text(isLastSet ? "Done" : "Mark step")
                        .fontWeight(.bold)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .padding(.vertical, 9)
            .background(theme.primary)
            .foregroundColor(theme.background)
            .cornerRadius(10)
        }
        .padding(10)
        .background(theme.surface)
        .cornerRadius(12)
    }

    @ViewBuilder
    private func recommendedWeightRow(_ ex: WatchExercise) -> some View {
        let recommended = state.liveRecommendedWeightLbs ?? ex.plannedTargetWeightLbs
        if !isGuideExercise(ex), tracksWeightInput(for: ex), let recommended = recommended, recommended > 0 {
            let recommendedReps = state.liveRecommendedReps ?? ex.recommendedReps ?? ex.reps
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("RECOMMENDED")
                        .font(.system(size: 8, weight: .heavy))
                        .tracking(0.8)
                        .foregroundColor(theme.textMuted)
                    Text("\(formatWeight(recommended)) lb")
                        .font(.system(size: 16, weight: .black, design: .rounded))
                        .foregroundColor(theme.textPrimary)
                    Text(recommendedReps)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(theme.textSecondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Button {
                    state.pendingWeight = recommended
                    if let reps = firstRepCount(recommendedReps) {
                        state.pendingReps = reps
                    }
                    WKInterfaceDevice.current().play(.click)
                } label: {
                    Text("Use")
                        .font(.system(size: 11, weight: .bold))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 6)
                        .background(theme.primary.opacity(0.18))
                        .foregroundColor(theme.primary)
                        .cornerRadius(8)
                }
                .buttonStyle(.plain)
            }
            .padding(8)
            .background(theme.primary.opacity(0.1))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(theme.primary.opacity(0.35), lineWidth: 1)
            )
            .cornerRadius(10)
        }
    }

    private func crownPill(_ label: String, value: String, active: Bool, onTap: @escaping () -> Void) -> some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 1) {
                Text(label.uppercased())
                    .font(.system(size: 9, weight: .heavy))
                    .tracking(0.5)
                    .foregroundColor(active ? theme.primary : theme.textMuted)
                Text(value)
                    .font(.system(size: 18, weight: .heavy, design: .rounded))
                    .foregroundColor(theme.textPrimary)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(active ? theme.primary.opacity(0.15) : theme.surfaceRaised)
            .cornerRadius(10)
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(active ? theme.primary : Color.clear, lineWidth: 1.5)
            )
        }
        .buttonStyle(.plain)
    }

    // ─── Rest timer card (with up-next) ───────────────────────────

    private func restCard(rest: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text("RESTING")
                        .font(.system(size: 10, weight: .black))
                        .tracking(1.2)
                        .foregroundColor(theme.warning)
                    if state.paused {
                        Text("PAUSED")
                            .font(.system(size: 9, weight: .heavy))
                            .foregroundColor(theme.textMuted)
                    }
                }
                Text(formatTime(rest))
                    .font(.system(size: 38, weight: .black, design: .rounded))
                    .foregroundColor(theme.warning)
                    .shadow(color: theme.warning.opacity(0.35), radius: 5)
            }

            // Up-next preview. Shows "Next set: reps target" OR (if
            // this was the last set of the exercise) "Next: exercise".
            upNextLine()
                .font(.system(size: 10))
                .foregroundColor(theme.textSecondary)

            HStack(spacing: 6) {
                Button(action: { showSkipRestConfirm = true }) {
                    Text("Skip rest")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .padding(.vertical, 8)
                .background(theme.primary)
                .foregroundColor(theme.background)
                .cornerRadius(8)
            }
        }
        .padding(10)
        .background(theme.surface)
        .cornerRadius(12)
        // Confirm before actually clearing the rest timer. watchOS
        // surfaces this as a full-screen sheet so an accidental tap can
        // be dismissed with the side button. Title shows the seconds
        // remaining so the user can decide whether the rest is short
        // enough to ride out.
        .confirmationDialog(
            skipRestPromptTitle(rest: rest),
            isPresented: $showSkipRestConfirm,
            titleVisibility: .visible
        ) {
            Button("Skip rest", role: .destructive, action: skipRest)
            Button("Keep resting", role: .cancel) {}
        }
    }

    private func skipRestPromptTitle(rest: Int) -> String {
        if rest <= 0 { return "Skip rest?" }
        return "Skip rest? \(rest)s left"
    }

    @ViewBuilder
    private func upNextLine() -> some View {
        if let ex = currentExercise {
            if state.setNumber > ex.sets, let next = nextExercise {
                Text("Up next: \(next.name) · \(next.sets) × \(setTargetText(for: next))")
                    .lineLimit(2)
            } else if let rec = liveRecommendationText(for: ex) {
                Text("Up next: \(rec)")
                    .lineLimit(3)
            } else {
                let setLabel = isTimedExercise(ex) ? "round" : "set"
                Text("Up next: \(setLabel) \(displaySetNumber(for: ex)) of \(ex.sets) · \(setTargetText(for: ex))")
                    .lineLimit(1)
            }
        } else {
            Text("")
        }
    }

    // ─── Footer (End / Cancel workout) ─────────────────────────────

    @State private var showEndConfirm: Bool = false
    @State private var showCancelConfirm: Bool = false

    private func footer() -> some View {
        VStack(spacing: 6) {
            Button(action: { showEndConfirm = true }) {
                HStack {
                    Image(systemName: "stop.fill")
                    Text("End workout")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .padding(.vertical, 8)
            .background(theme.surfaceRaised)
            .foregroundColor(theme.error)
            .cornerRadius(10)
            // Cancel — distinct from End. End logs the workout to Thallo
            // history; Cancel discards everything so
            // a misstart / accidental tap doesn't muddy the record.
            Button(role: .destructive) {
                showCancelConfirm = true
            } label: {
                Text("Cancel workout")
                    .font(.system(size: 11, weight: .semibold))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .padding(.vertical, 6)
            .foregroundColor(theme.textMuted)
        }
        .padding(.top, 4)
        .confirmationDialog(
            "End and save this workout?",
            isPresented: $showEndConfirm,
            titleVisibility: .visible
        ) {
            Button("End and save workout") {
                WKInterfaceDevice.current().play(.success)
                onEndWorkout(state.endWorkoutCommandPayload(for: workout, finalMetrics: nil))
            }
            Button("Keep going", role: .cancel) {}
        } message: {
            Text("This will send the session to your phone and save it to Thallo.")
        }
        .confirmationDialog(
            "Cancel this workout? Sets you've logged will be discarded.",
            isPresented: $showCancelConfirm,
            titleVisibility: .visible
        ) {
            Button("Discard workout", role: .destructive) {
                // Failure haptic so the user knows this was destructive
                // by feel alone. Parent handler sends cancel_workout
                // and tears down the watch's HR session + UI without
                // logging anything to Health.
                WKInterfaceDevice.current().play(.failure)
                onCancelWorkout()
            }
            Button("Keep going", role: .cancel) {}
        }
    }

    // ─── Actions ───────────────────────────────────────────────────

    private func logSet() {
        guard let ex = currentExercise else { return }
        let guide = isGuideExercise(ex)
        let timed = isTimedExercise(ex)
        if !guide, !timed, shouldPromptRir(actualReps: state.pendingReps, targetReps: ex.reps) {
            pendingRirLog = WatchPendingRirLog(
                exerciseIndex: state.exerciseIndex,
                setNumber: displaySetNumber(for: ex),
                weightLbs: state.pendingWeight,
                reps: state.pendingReps
            )
            WKInterfaceDevice.current().play(.click)
            return
        }
        commitLoggedSet(rir: nil)
    }

    private func commitLoggedSet(rir: Int?, pendingLog: WatchPendingRirLog? = nil) {
        guard let ex = currentExercise else { return }
        let guide = isGuideExercise(ex)
        let timed = isTimedExercise(ex)
        let weighted = tracksWeightInput(for: ex)
        let timedKey = timed ? timedTimerKey(for: ex) : nil
        let elapsedTimedSeconds = timedKey.map { state.timedElapsed(for: $0) } ?? 0
        // Haptic click — different from the rest-end notification so
        // the two are distinguishable by feel.
        WKInterfaceDevice.current().play(.click)

        // Ship the log to the phone so history + recommendations stay
        // aligned. Phone handler parses and feeds the deterministic
        // weight-rec engine for the next set.
        let setNumber = pendingLog?.setNumber ?? displaySetNumber(for: ex)
        let loggedWeight = pendingLog?.weightLbs ?? state.pendingWeight
        let loggedReps = pendingLog?.reps ?? state.pendingReps
        var payload: [String: Any] = [
            "sessionId": workout.sessionId ?? "",
            "exerciseIndex": state.exerciseIndex,
            "setNumber": setNumber,
            "weightLbs": guide || !weighted ? 0 : loggedWeight,
            "reps": guide || timed ? 0 : loggedReps,
            "exerciseName": ex.name,
        ]
        if let clientExerciseId = ex.clientExerciseId {
            payload["clientExerciseId"] = clientExerciseId
        }
        if let rir, !guide, !timed {
            payload["rir"] = max(0, min(4, rir))
        }
        if timed {
            if elapsedTimedSeconds > 0 {
                payload["durationSeconds"] = elapsedTimedSeconds
            } else if let durationSeconds = plannedDurationSeconds(for: ex) {
                payload["durationSeconds"] = durationSeconds
            }
        } else if let durationSeconds = plannedDurationSeconds(for: ex) {
            payload["durationSeconds"] = durationSeconds
        }
        state.recordLoggedSet(
            exerciseIndex: state.exerciseIndex,
            setNumber: setNumber,
            weightLbs: guide || !weighted ? 0 : loggedWeight,
            reps: guide || timed ? 0 : loggedReps,
            durationSeconds: payload["durationSeconds"] as? Int,
            rir: rir,
            heartRateAvg: hr.heartRate
        )
        conn.sendCommand("log_set", payload: payload)
        pendingRirLog = nil
        if timed {
            state.resetTimedTimer()
        }
        if timed || guide {
            state.lastLoggedWeight = nil
            state.lastLoggedReps = nil
        } else if !weighted {
            state.lastLoggedWeight = nil
            state.lastLoggedReps = loggedReps
        } else {
            state.lastLoggedWeight = loggedWeight
            state.lastLoggedReps = loggedReps
        }

        if setNumber >= ex.sets {
            // Last set of this exercise → advance to next exercise.
            state.markExerciseDone(state.exerciseIndex)
            advanceExercise()
        } else {
            // Next set of same exercise.
            if !guide, !timed, let rec = localRecommendationAfterWatchLog(
                for: ex,
                nextSetNumber: setNumber + 1,
                loggedWeight: loggedWeight,
                loggedReps: loggedReps,
                rir: rir,
                weighted: weighted
            ) {
                state.currentRecommendation = rec.text
                state.liveRecommendedWeightLbs = rec.weightLbs
                state.liveRecommendedReps = rec.reps
            }
            state.setNumber += 1
            if guide {
                state.clearRest()
            } else {
                state.setRest(seconds: ex.restSeconds)
            }
        }
    }

    private func requestAddExercise(_ exercise: WatchTemplateExercise) {
        showAddExerciseSheet = false
        let trimmed = exercise.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let clientExerciseId = "watch-ex-\(Int(Date().timeIntervalSince1970 * 1000))-\(String(UUID().uuidString.prefix(8)))"
        onOptimisticAddExercise(exercise, clientExerciseId)
        let sid = workout.sessionId ?? ""
        conn.sendCommand("add_exercise", payload: addExerciseCommandPayload(for: exercise, sessionId: sid, clientExerciseId: clientExerciseId))
        WKInterfaceDevice.current().play(.success)
    }

    private func requestCircuit(_ kind: WatchCircuitKind) {
        pendingCircuit = kind
        conn.sendCommand("add_circuit", payload: [
            "circuitType": kind.rawValue,
            "sessionId": workout.sessionId ?? "",
        ])
        WKInterfaceDevice.current().play(.success)
    }

    private func requestSwap(_ option: WatchSwapOption) {
        pendingSwapName = option.name
        showSwapSheet = false
        state.clearRest()
        state.resetTimedTimer()
        WKInterfaceDevice.current().play(.click)
        conn.sendCommand("swap_exercise", payload: [
            "sessionId": workout.sessionId ?? "",
            "exerciseIndex": state.exerciseIndex,
            "fromExerciseName": currentExercise?.name ?? "",
            "toExerciseName": option.name,
        ])
    }

    private func advanceExercise() {
        pendingRirLog = nil
        state.resetTimedTimer()
        if isLastExercise {
            state.finishPlannedExercises(in: workout)
            WKInterfaceDevice.current().play(.success)
            return
        }
        let nextIdx = state.exerciseIndex + 1
        state.exerciseIndex = nextIdx
        state.setNumber = 1
        state.clearRest()
        // Seed weight/reps for the new exercise so Crown starts at
        // a useful value.
        state.pendingWeight = 0
        state.pendingReps = 0
        state.clearAutoSeededInputs()
        if workout.exercises.indices.contains(nextIdx) {
            state.seed(for: workout.exercises[nextIdx])
        }
        syncHeartRateActivityForCurrentExercise()
        WKInterfaceDevice.current().play(.success)
    }

    private var cardioMetricsPanel: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                metricPill(title: "HR", value: hr.heartRate.map { "\($0)" } ?? "—", accent: hrChipColor)
                metricPill(
                    title: "CAL",
                    value: hr.activeCalories > 0 ? "\(Int(hr.activeCalories.rounded()))" : "—",
                    accent: theme.warning
                )
            }
            if hr.displayDistanceMeters > 0 || hr.needsManualDistance {
                HStack(spacing: 6) {
                    metricPill(title: "DIST", value: compactDistanceLabel, accent: theme.textPrimary)
                    metricPill(title: "PACE", value: compactPaceLabel, accent: theme.primary)
                }
            }
        }
        .padding(8)
        .background(theme.surface)
        .cornerRadius(10)
    }

    private func metricPill(title: String, value: String, accent: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.system(size: 8, weight: .heavy))
                .tracking(0.7)
                .foregroundColor(theme.textMuted)
            Text(value)
                .font(.system(size: 16, weight: .heavy, design: .rounded))
                .foregroundColor(accent)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 7)
        .padding(.vertical, 6)
        .background(theme.surfaceRaised)
        .cornerRadius(8)
    }

    private var compactDistanceLabel: String {
        let meters = hr.displayDistanceMeters
        if meters <= 0 { return "—" }
        if theme.distanceUnit == "km" {
            let km = meters / 1000.0
            return km < 100 ? String(format: "%.2f km", km) : String(format: "%.0f km", km)
        }
        let mi = (meters / 1000.0) * 0.6213711922
        return mi < 100 ? String(format: "%.2f mi", mi) : String(format: "%.0f mi", mi)
    }

    private var compactPaceLabel: String {
        let meters = hr.displayDistanceMeters
        guard meters >= 30, cardioMetricsElapsedSeconds > 0 else { return "—" }
        let secPerKm = Double(cardioMetricsElapsedSeconds) / (meters / 1000.0)
        let seconds = theme.distanceUnit == "km" ? secPerKm : secPerKm / 0.6213711922
        let minPart = Int(seconds) / 60
        let secPart = Int(seconds) % 60
        return String(format: "%d:%02d", minPart, secPart)
    }

    private func syncHeartRateActivityForCurrentExercise() {
        if let ex = currentExercise, isWatchCardioExercise(ex) {
            hr.beginActivity(focus: watchCardioFocus(for: ex, workoutFocus: workout.focus))
            startCardioMetricEmitter()
        } else if HeartRateStore.isMixedStrengthCardioFocus(workout.focus), hr.isCardio {
            hr.beginActivity(focus: workout.focus)
            stopCardioMetricEmitter()
        } else {
            stopCardioMetricEmitter()
        }
    }

    private func startCardioMetricEmitter() {
        cardioMetricEmitTimer?.invalidate()
        sendCardioMetricsToPhone()
        cardioMetricEmitTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { _ in
            sendCardioMetricsToPhone()
        }
    }

    private func stopCardioMetricEmitter() {
        cardioMetricEmitTimer?.invalidate()
        cardioMetricEmitTimer = nil
    }

    private func sendCardioMetricsToPhone() {
        guard currentExerciseIsCardio, hr.isCardio else { return }
        var payload = watchCardioMetricsPayload(hr: hr, sessionId: workout.sessionId)
        let elapsed = cardioMetricsElapsedSeconds
        payload["elapsedSeconds"] = elapsed
        let meters = hr.displayDistanceMeters
        if meters >= 30, elapsed > 0 {
            payload["paceSecPerKm"] = Double(elapsed) / (meters / 1000.0)
        }
        payload["exerciseIndex"] = state.exerciseIndex
        conn.sendCommand("cardio_metrics", payload: payload)
    }

    private func skipRest() {
        state.clearRest()
        WKInterfaceDevice.current().play(.click)
        conn.sendCommand("skip_rest", payload: [
            "sessionId": workout.sessionId ?? "",
            "exerciseIndex": state.exerciseIndex,
            "setNumber": state.setNumber,
        ])
    }

    private func plannedDurationSeconds(for ex: WatchExercise) -> Int? {
        if ex.isTimed == false {
            return nil
        }
        if let planned = ex.plannedDurationSeconds, planned > 0 {
            return planned
        }
        let reps = ex.reps.lowercased()
        let name = ex.name.lowercased()
        let primary = normalizedWatchToken(ex.primaryMuscle)
        let prescription = normalizedWatchToken(ex.prescriptionType)
        let timedName = name.range(
            of: "treadmill|bike|\\browing\\b|rowing machine|\\brower\\b|elliptical|stair|\\brun\\b|running|\\bjog\\b|jogging|cycling|swim|cardio|zone ?2|tempo|steady state|long run|^(brisk |incline |outdoor |treadmill )?walk(ing)?\\b(?!\\s+lunges?\\b)|yoga|mobility|stretch",
            options: .regularExpression
        ) != nil
        let cardioLike = primary == "cardio"
            || prescription.range(of: "cardio|conditioning|interval|tempo|zone 2|duration|timed", options: .regularExpression) != nil
            || timedName
        let hasDistanceUnit = reps.range(
            of: "\\b\\d+(?:\\.\\d+)?\\s*(?:[-–—]\\s*\\d+(?:\\.\\d+)?\\s*)?(yd|yds|yard|yards|m|meter|meters|metre|metres|ft|feet|km|mi|mile|miles)\\b",
            options: .regularExpression
        ) != nil
        if hasDistanceUnit { return nil }
        let hasDurationUnit = reps.range(
            of: "\\b\\d+(?:\\.\\d+)?\\s*(?:[-–—]\\s*\\d+(?:\\.\\d+)?\\s*)?(s|sec|secs|second|seconds|min|mins|minute|minutes)\\b",
            options: .regularExpression
        ) != nil
        guard cardioLike || hasDurationUnit else { return nil }
        let regex = try? NSRegularExpression(pattern: "\\d+(?:\\.\\d+)?")
        let nsRange = NSRange(reps.startIndex..<reps.endIndex, in: reps)
        let values = regex?.matches(in: reps, range: nsRange).compactMap { match -> Double? in
            guard let range = Range(match.range, in: reps) else { return nil }
            return Double(String(reps[range]))
        } ?? []
        guard let first = values.first else { return nil }
        let planned = values.count >= 2 && reps.contains("-") ? (first + values[1]) / 2 : first
        let unitIsMinutes = reps.range(of: "\\b\\d+(?:\\.\\d+)?\\s*(min|mins|minute|minutes)\\b", options: .regularExpression) != nil
            || (cardioLike && !hasDurationUnit)
        return max(1, Int((unitIsMinutes ? planned * 60 : planned).rounded()))
    }

    private func timedTimerKey(for ex: WatchExercise) -> String {
        "\(state.exerciseIndex)-\(displaySetNumber(for: ex))"
    }

    private func formatTime(_ s: Int) -> String {
        let mm = s / 60
        let ss = s % 60
        return String(format: "%d:%02d", mm, ss)
    }

    private func formatWeight(_ value: Double) -> String {
        let rounded = (value * 10).rounded() / 10
        return rounded.rounded() == rounded ? "\(Int(rounded))" : String(format: "%.1f", rounded)
    }
}

private enum WatchCircuitKind: String {
    case core
    case stretch

    var title: String {
        switch self {
        case .core: return "Core Circuit"
        case .stretch: return "Stretch Block"
        }
    }

    var icon: String {
        switch self {
        case .core: return "repeat"
        case .stretch: return "figure.cooldown"
        }
    }
}

private func normalizedWatchToken(_ raw: String?) -> String {
    raw?
        .lowercased()
        .replacingOccurrences(of: "[^a-z0-9]+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

private func isWatchCardioExercise(_ ex: WatchExercise) -> Bool {
    let primary = normalizedWatchToken(ex.primaryMuscle)
    let prescription = normalizedWatchToken(ex.prescriptionType)
    if primary == "cardio" { return true }
    if prescription.range(of: "cardio|conditioning|interval|tempo|zone 2|duration|timed", options: .regularExpression) != nil {
        return true
    }
    return ex.name.lowercased().range(
        of: "treadmill|stationary bike|elliptical|rowing machine|\\brower\\b|\\browing\\b|stair climber|assault bike|battle ropes|jump rope|sprint|jogging|running|cycling|swimming|hiit|intervals|mountain climber|hill sprint|cardio|zone ?2|tempo|steady state|long run|^(brisk |incline |outdoor |treadmill )?walk(ing)?\\b(?!\\s+lunges?\\b)|boxing|kickboxing|martial.?arts|mma|sparring|bag.?work|shadow.?box",
        options: .regularExpression
    ) != nil
}

private func watchCardioFocus(for ex: WatchExercise, workoutFocus: String?) -> String {
    let name = ex.name.trimmingCharacters(in: .whitespacesAndNewlines)
    if !name.isEmpty { return name }
    return workoutFocus ?? "Cardio"
}

private func watchCardioMetricsPayload(hr: HeartRateStore, sessionId: String?) -> [String: Any] {
    var payload: [String: Any] = [
        "activityTypeRaw": Int(hr.activityType.rawValue),
        "elapsedSeconds": hr.elapsedSeconds,
        "distanceMeters": hr.displayDistanceMeters,
        "activeCalories": hr.activeCalories,
        "steps": hr.stepCount,
        "elevationGainFt": hr.elevationGainFeet,
        "sentAtMs": Date().timeIntervalSince1970 * 1000,
    ]
    if let sessionId, !sessionId.isEmpty { payload["sessionId"] = sessionId }
    if let bpm = hr.heartRate { payload["heartRate"] = bpm }
    if let pace = hr.averagePaceSecPerKm { payload["paceSecPerKm"] = pace }
    if let point = hr.routeCoords.last {
        var routePoint: [String: Any] = [
            "lat": point.lat,
            "lon": point.lon,
            "t_ms": point.timestampMs,
        ]
        if let acc = point.horizontalAccuracyM { routePoint["acc_m"] = acc }
        if let alt = point.altitudeM { routePoint["alt_m"] = alt }
        if let vAcc = point.verticalAccuracyM { routePoint["v_acc_m"] = vAcc }
        payload["routePoint"] = routePoint
    }
    return payload
}

private func isWatchCoreCircuitExercise(_ ex: WatchExercise) -> Bool {
    let role = normalizedWatchToken(ex.slotRole)
    let prescription = normalizedWatchToken(ex.prescriptionType)
    let primary = normalizedWatchToken(ex.primaryMuscle)
    if ["warmup", "mobility", "recovery", "stretch", "cooldown"].contains(role) { return false }
    return role == "core" || primary == "core" || prescription.contains("core")
}

private func isWatchStretchBlockExercise(_ ex: WatchExercise) -> Bool {
    let role = normalizedWatchToken(ex.slotRole)
    let prescription = normalizedWatchToken(ex.prescriptionType)
    if ["warmup", "primary", "secondary", "isolation", "core"].contains(role) { return false }
    return role == "mobility"
        || role == "stretch"
        || role == "cooldown"
        || prescription == "stretch hold"
        || prescription == "yoga flow"
        || prescription == "mobility"
}

private func watchGroupedRun(
    in exercises: [WatchExercise],
    at index: Int,
    predicate: (WatchExercise) -> Bool
) -> [Int] {
    guard exercises.indices.contains(index), predicate(exercises[index]) else { return [] }
    var start = index
    while start > 0, predicate(exercises[start - 1]) { start -= 1 }
    var end = index
    while end + 1 < exercises.count, predicate(exercises[end + 1]) { end += 1 }
    guard end - start + 1 >= 2 else { return [] }
    return Array(start...end)
}

private func watchCoreCircuitRun(in exercises: [WatchExercise], at index: Int) -> [Int] {
    watchGroupedRun(in: exercises, at: index, predicate: isWatchCoreCircuitExercise)
}

private func watchStretchBlockRun(in exercises: [WatchExercise], at index: Int) -> [Int] {
    watchGroupedRun(in: exercises, at: index, predicate: isWatchStretchBlockExercise)
}

private func hasWatchCoreCircuit(_ exercises: [WatchExercise]) -> Bool {
    exercises.contains(where: isWatchCoreCircuitExercise)
}

private func hasWatchStretchBlock(_ exercises: [WatchExercise]) -> Bool {
    exercises.contains(where: isWatchStretchBlockExercise)
}

private struct WorkoutPlanTab: View {
    let workout: WatchWorkout
    @ObservedObject var state: ActiveWorkoutState
    @ObservedObject var hr: HeartRateStore
    let onOptimisticAddExercise: (WatchTemplateExercise, String) -> Void

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var conn: ConnectivityStore
    @State private var swapTargetIndex: Int? = nil
    @State private var pendingSwapIndex: Int? = nil
    @State private var pendingSwapName: String? = nil
    @State private var pendingCircuit: WatchCircuitKind? = nil
    @State private var pendingAddedName: String? = nil
    @State private var showAddExerciseSheet = false

    var body: some View {
        ZStack {
            theme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    header
                    if let steps = workout.warmupSteps, !steps.isEmpty {
                        warmupPlanCard(steps: steps)
                    }
                    if workout.exercises.isEmpty {
                        emptyPlan
                    } else {
                        ForEach(Array(workout.exercises.enumerated()), id: \.offset) { index, ex in
                            groupBannerIfNeeded(index: index)
                            planRow(index: index, exercise: ex)
                        }
                    }
                    circuitActions
                    addExerciseButton
                }
                .padding(10)
            }
        }
        .sheet(isPresented: Binding(
            get: { swapTargetIndex != nil },
            set: { if !$0 { swapTargetIndex = nil } }
        )) {
            if let idx = swapTargetIndex, workout.exercises.indices.contains(idx) {
                SwapExerciseSheet(
                    exercise: workout.exercises[idx],
                    pendingName: pendingSwapIndex == idx ? pendingSwapName : nil,
                    onSelect: { option in requestSwap(option, at: idx) },
                )
            }
        }
        .sheet(isPresented: $showAddExerciseSheet) {
            AddExerciseSheet(
                templates: conn.templates?.templates ?? [],
                currentExerciseNames: Set(workout.exercises.map { $0.name.lowercased() }),
                onPick: requestAddExercise,
                onCancel: { showAddExerciseSheet = false }
            )
        }
        .onChange(of: workout.exercises) { _, _ in
            pendingCircuit = nil
            pendingAddedName = nil
            if let idx = pendingSwapIndex,
               workout.exercises.indices.contains(idx),
               workout.exercises[idx].name == pendingSwapName {
                pendingSwapIndex = nil
                pendingSwapName = nil
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text("PLAN")
                    .font(.system(size: 9, weight: .black))
                    .tracking(1.2)
                    .foregroundColor(theme.primary)
                Spacer()
                if hr.running {
                    HStack(spacing: 3) {
                        Image(systemName: "stopwatch")
                            .font(.system(size: 8))
                        Text(formatElapsed(hr.elapsedSeconds))
                            .font(.system(size: 10, weight: .heavy, design: .rounded))
                            .monospacedDigit()
                    }
                    .foregroundColor(theme.textSecondary)
                }
                if let bpm = hr.heartRate {
                    HStack(spacing: 3) {
                        Image(systemName: "heart.fill")
                            .font(.system(size: 8))
                        Text("\(bpm)")
                            .font(.system(size: 10, weight: .heavy, design: .rounded))
                            .monospacedDigit()
                    }
                    .foregroundColor(hrZoneColor(hr.zone))
                }
            }
            Text(workout.focus)
                .font(.system(size: 16, weight: .heavy))
                .foregroundColor(theme.textPrimary)
                .lineLimit(2)
            Text("\(workout.exercises.count) exercises")
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(theme.textMuted)
        }
        .padding(10)
        .background(theme.surface)
        .cornerRadius(10)
    }

    private var emptyPlan: some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(systemName: "list.bullet.rectangle")
                .font(.system(size: 18, weight: .bold))
                .foregroundColor(theme.textMuted)
            Text("Waiting for exercises from phone")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(theme.textSecondary)
                .lineLimit(2)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.surface)
        .cornerRadius(10)
    }

    private func warmupPlanCard(steps: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "flame.fill")
                    .font(.system(size: 10, weight: .bold))
                Text("WARM-UP")
                    .font(.system(size: 9, weight: .black))
                    .tracking(1)
                Spacer(minLength: 0)
                Text("\(steps.count)")
                    .font(.system(size: 9, weight: .heavy, design: .rounded))
                    .foregroundColor(theme.textMuted)
            }
            .foregroundColor(theme.primary)
            ForEach(Array(steps.prefix(5).enumerated()), id: \.offset) { index, step in
                HStack(alignment: .top, spacing: 5) {
                    Text("\(index + 1)")
                        .font(.system(size: 9, weight: .black, design: .rounded))
                        .foregroundColor(theme.background)
                        .frame(width: 16, height: 16)
                        .background(theme.primary)
                        .clipShape(Circle())
                    Text(step)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(theme.textSecondary)
                        .lineLimit(3)
                }
            }
        }
        .padding(9)
        .background(theme.primary.opacity(0.1))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(theme.primary.opacity(0.35), lineWidth: 1)
        )
        .cornerRadius(10)
    }

    @ViewBuilder
    private func groupBannerIfNeeded(index: Int) -> some View {
        let coreRun = watchCoreCircuitRun(in: workout.exercises, at: index)
        let stretchRun = watchStretchBlockRun(in: workout.exercises, at: index)
        if coreRun.first == index {
            groupBanner(title: "Core Circuit", icon: "repeat", detail: "\(coreRun.count) moves")
        } else if stretchRun.first == index {
            groupBanner(title: "Stretch Block", icon: "figure.cooldown", detail: "\(stretchRun.count) poses")
        }
    }

    private func groupBanner(title: String, icon: String, detail: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .bold))
            VStack(alignment: .leading, spacing: 1) {
                Text(title.uppercased())
                    .font(.system(size: 9, weight: .black))
                    .tracking(0.8)
                Text(detail)
                    .font(.system(size: 9, weight: .semibold))
            }
            Spacer(minLength: 0)
        }
        .foregroundColor(theme.primary)
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(theme.primary.opacity(0.12))
        .cornerRadius(9)
    }

    private func planRow(index: Int, exercise: WatchExercise) -> some View {
        let done = state.completedExerciseIndexes.contains(index)
            || watchExerciseIsDone(exercise, at: index, progress: conn.latestProgress, workout: workout)
        let current = !done && index == state.exerciseIndex
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 7) {
                ZStack {
                    Circle()
                        .fill(done ? theme.success.opacity(0.2) : current ? theme.primary : theme.surfaceRaised)
                    if done {
                        Image(systemName: "checkmark")
                            .font(.system(size: 10, weight: .black))
                            .foregroundColor(theme.success)
                    } else {
                        Text("\(index + 1)")
                            .font(.system(size: 11, weight: .black, design: .rounded))
                            .foregroundColor(current ? theme.background : theme.textPrimary)
                    }
                }
                .frame(width: 24, height: 24)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 5) {
                        Text(exercise.name)
                            .font(.system(size: 12, weight: .heavy))
                            .foregroundColor(done ? theme.textSecondary : theme.textPrimary)
                            .strikethrough(done, color: theme.success)
                            .lineLimit(2)
                        if done {
                            Text("DONE")
                                .font(.system(size: 8, weight: .black))
                                .foregroundColor(theme.success)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 1)
                                .background(theme.success.opacity(0.16))
                                .cornerRadius(4)
                        } else if current {
                            Text("NOW")
                                .font(.system(size: 8, weight: .black))
                                .foregroundColor(theme.background)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 1)
                                .background(theme.primary)
                                .cornerRadius(4)
                        }
                    }
                    Text(planMeta(for: exercise, at: index))
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(theme.textMuted)
                        .lineLimit(2)
                    if pendingSwapIndex == index, let pendingSwapName {
                        Text("Swapping to \(pendingSwapName)…")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundColor(theme.warning)
                            .lineLimit(1)
                    }
                }
            }
            HStack(spacing: 6) {
                if !current && !done {
                    planActionButton(icon: "arrow.turn.down.right", label: "Go") {
                        state.jump(to: index, in: workout)
                        WKInterfaceDevice.current().play(.success)
                    }
                }
                if !done && !exercise.swapOptions.isEmpty {
                    planActionButton(icon: "arrow.triangle.2.circlepath", label: "Swap") {
                        swapTargetIndex = index
                    }
                }
            }
        }
        .padding(9)
        .background(done ? theme.success.opacity(0.08) : current ? theme.primary.opacity(0.13) : theme.surface)
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(done ? theme.success.opacity(0.35) : current ? theme.primary.opacity(0.55) : Color.clear, lineWidth: 1)
        )
        .cornerRadius(10)
    }

    private func planActionButton(icon: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .bold))
                Text(label)
                    .font(.system(size: 10, weight: .heavy))
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(theme.surfaceRaised)
            .foregroundColor(theme.textSecondary)
            .cornerRadius(8)
        }
        .buttonStyle(.plain)
    }

    private var circuitActions: some View {
        VStack(spacing: 6) {
            if !hasWatchCoreCircuit(workout.exercises) {
                circuitButton(.core)
            }
            if !hasWatchStretchBlock(workout.exercises) {
                circuitButton(.stretch)
            }
        }
    }

    private func circuitButton(_ kind: WatchCircuitKind) -> some View {
        Button {
            requestCircuit(kind)
        } label: {
            HStack(spacing: 7) {
                Image(systemName: pendingCircuit == kind ? "clock" : kind.icon)
                    .font(.system(size: 12, weight: .bold))
                Text(pendingCircuit == kind ? "Adding \(kind.title)…" : "Add \(kind.title)")
                    .font(.system(size: 12, weight: .heavy))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Spacer(minLength: 0)
            }
            .padding(10)
            .foregroundColor(theme.primary)
            .background(theme.primary.opacity(0.12))
            .cornerRadius(10)
        }
        .buttonStyle(.plain)
    }

    private var addExerciseButton: some View {
        Button {
            showAddExerciseSheet = true
        } label: {
            HStack(spacing: 7) {
                Image(systemName: pendingAddedName == nil ? "plus.circle.fill" : "clock")
                    .font(.system(size: 13, weight: .bold))
                Text(pendingAddedName.map { "Adding \($0)…" } ?? "Add Exercise")
                    .font(.system(size: 12, weight: .heavy))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                Spacer(minLength: 0)
            }
            .padding(10)
            .foregroundColor(theme.textPrimary)
            .background(theme.surface)
            .cornerRadius(10)
        }
        .buttonStyle(.plain)
    }

    private func planMeta(for ex: WatchExercise, at index: Int) -> String {
        var parts: [String] = []
        let coreRun = watchCoreCircuitRun(in: workout.exercises, at: index)
        parts.append(coreRun.isEmpty ? "\(ex.sets) x \(targetText(for: ex))" : "\(ex.sets) rounds x \(targetText(for: ex))")
        if ex.restSeconds > 0 { parts.append("\(ex.restSeconds)s rest") }
        if let equipment = ex.equipment, !equipment.isEmpty { parts.append(equipment) }
        if let label = ex.slotLabel ?? ex.slotRole, !label.isEmpty { parts.append(label) }
        return parts.joined(separator: " · ")
    }

    private func targetText(for ex: WatchExercise) -> String {
        if let seconds = ex.plannedDurationSeconds, seconds > 0 {
            return formatClock(seconds)
        }
        let reps = ex.reps.trimmingCharacters(in: .whitespacesAndNewlines)
        return reps.isEmpty ? "Timed" : reps
    }

    private func formatClock(_ seconds: Int) -> String {
        let m = seconds / 60
        let s = seconds % 60
        return String(format: "%d:%02d", m, s)
    }

    private func requestSwap(_ option: WatchSwapOption, at index: Int) {
        guard workout.exercises.indices.contains(index) else { return }
        let current = workout.exercises[index]
        pendingSwapIndex = index
        pendingSwapName = option.name
        swapTargetIndex = nil
        if index == state.exerciseIndex {
            state.clearRest()
        }
        WKInterfaceDevice.current().play(.click)
        conn.sendCommand("swap_exercise", payload: [
            "sessionId": workout.sessionId ?? "",
            "exerciseIndex": index,
            "fromExerciseName": current.name,
            "toExerciseName": option.name,
        ])
    }

    private func requestAddExercise(_ exercise: WatchTemplateExercise) {
        showAddExerciseSheet = false
        let trimmed = exercise.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let clientExerciseId = "watch-ex-\(Int(Date().timeIntervalSince1970 * 1000))-\(String(UUID().uuidString.prefix(8)))"
        pendingAddedName = trimmed
        onOptimisticAddExercise(exercise, clientExerciseId)
        conn.sendCommand("add_exercise", payload: addExerciseCommandPayload(for: exercise, sessionId: workout.sessionId ?? "", clientExerciseId: clientExerciseId))
        WKInterfaceDevice.current().play(.success)
    }

    private func requestCircuit(_ kind: WatchCircuitKind) {
        pendingCircuit = kind
        conn.sendCommand("add_circuit", payload: [
            "circuitType": kind.rawValue,
            "sessionId": workout.sessionId ?? "",
        ])
        WKInterfaceDevice.current().play(.success)
    }
}

private struct SwapExerciseSheet: View {
    let exercise: WatchExercise
    let pendingName: String?
    let onSelect: (WatchSwapOption) -> Void

    @EnvironmentObject var theme: ThemeStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(exercise.swapOptions) { option in
                        Button {
                            onSelect(option)
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 5) {
                                    Text(option.name)
                                        .font(.system(size: 13, weight: .bold))
                                        .foregroundColor(theme.textPrimary)
                                        .lineLimit(2)
                                    if pendingName == option.name {
                                        Image(systemName: "clock")
                                            .font(.system(size: 9, weight: .bold))
                                            .foregroundColor(theme.warning)
                                    }
                                }
                                HStack(spacing: 5) {
                                    if let overlap = option.overlap {
                                        swapOverlapBadge(overlap)
                                    }
                                    if let equipment = option.equipment {
                                        Text(equipment)
                                            .lineLimit(1)
                                            .minimumScaleFactor(0.75)
                                    }
                                }
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundColor(theme.textMuted)
                                .lineLimit(1)
                            }
                            .padding(.vertical, 2)
                        }
                    }
                } header: {
                    Text("Keeps \(exercise.sets) × \(exercise.reps)")
                }
            }
            .listStyle(.carousel)
            .navigationTitle("Swap")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func swapOverlapBadge(_ overlap: Int) -> some View {
        let color = swapOverlapColor(overlap)
        return Text("\(overlap)% overlap")
            .font(.system(size: 10, weight: .heavy))
            .foregroundColor(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.16))
            .cornerRadius(6)
            .lineLimit(1)
            .layoutPriority(1)
    }

    private func swapOverlapColor(_ overlap: Int) -> Color {
        if overlap >= 80 { return theme.success }
        if overlap >= 60 { return theme.warning }
        return theme.error
    }
}

// ─── Heart rate tab ────────────────────────────────────────────────

private struct HeartRateTab: View {
    @ObservedObject var hr: HeartRateStore
    var showsElapsedTime: Bool = false
    @EnvironmentObject var theme: ThemeStore
    @Environment(\.isLuminanceReduced) private var dim

    var body: some View {
        let showElapsed = showsElapsedTime || hr.isCardio
        ZStack {
            // Themed background with a subtle accent glow behind the
            // bpm readout so dark themes get a pop of color without
            // washing out the numeral itself.
            theme.background.ignoresSafeArea()
            if !dim {
                // Skip the glow under always-on to preserve burn-in budget.
                RadialGradient(
                    colors: [zoneColor.opacity(0.28), Color.clear],
                    center: .center,
                    startRadius: 0,
                    endRadius: 110,
                )
                .ignoresSafeArea()
            }
            VStack(spacing: 8) {
                Text("HEART RATE")
                    .font(.system(size: 9, weight: .bold))
                    .tracking(1)
                    .foregroundColor(theme.primary)

                if showElapsed {
                    HStack(spacing: 4) {
                        Image(systemName: "stopwatch")
                            .font(.system(size: 9, weight: .bold))
                        Text(formatElapsed(hr.elapsedSeconds))
                            .font(.system(size: 17, weight: .heavy, design: .rounded))
                            .monospacedDigit()
                    }
                    .foregroundColor(theme.textPrimary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(theme.surface)
                    .cornerRadius(8)
                }

                HStack(alignment: .lastTextBaseline, spacing: 4) {
                    Text(hr.heartRate.map { "\($0)" } ?? "—")
                        .font(.system(size: showElapsed ? 50 : 56, weight: .black, design: .rounded))
                        .foregroundColor(zoneColor)
                        .shadow(color: zoneColor.opacity(0.45), radius: 6)
                        // Always-on dim: drop opacity to keep the
                        // numeral legible but not burn-in risky.
                        .opacity(dim ? 0.55 : 1)
                    Text("bpm")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(theme.textSecondary)
                }

                if let z = hr.zone {
                    VStack(spacing: 2) {
                        Text("ZONE \(z)")
                            .font(.system(size: 11, weight: .black))
                            .tracking(0.8)
                            .foregroundColor(zoneColor)
                        Text(zoneLabel(z))
                            .font(.system(size: 11, weight: .bold))
                            .foregroundColor(zoneColor)
                            .lineLimit(1)
                            .minimumScaleFactor(0.72)
                        if let range = hr.currentZoneDefinition {
                            Text("\(range.low)-\(range.high) bpm")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundColor(theme.textSecondary)
                                .monospacedDigit()
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                        }
                    }
                    .padding(.vertical, 6)
                    .padding(.horizontal, 10)
                    .background(zoneColor.opacity(0.28))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(zoneColor.opacity(0.6), lineWidth: 1),
                    )
                    .cornerRadius(10)
                } else if hr.running {
                    Text("Reading…")
                        .font(.system(size: 11))
                        .foregroundColor(theme.primary)
                } else if let err = hr.errorMessage {
                    Text(err)
                        .font(.system(size: 10))
                        .foregroundColor(theme.error)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 8)
                }
            }
            .padding()
        }
    }

    private var zoneColor: Color {
        hr.zone == nil ? theme.textMuted : hrZoneColor(hr.zone)
    }

    private func zoneLabel(_ z: Int) -> String {
        if let label = hr.currentZoneDefinition?.label, !label.isEmpty {
            return label
        }
        switch z {
        case 1: return "Recovery"
        case 2: return "Aerobic"
        case 3: return "Tempo"
        case 4: return "Threshold"
        case 5: return "Max effort"
        default: return ""
        }
    }
}

// ─── Cardio active tab ─────────────────────────────────────────────
//
// Shown for run / walk / bike / hike / swim / row / elliptical / mixed
// cardio sessions. Replaces the lift-oriented ExerciseTab on those
// activity types — the user wants live time + distance + pace + HR +
// calories, not weight/reps entry.
//
// Indoor activities with no auto distance source (stationary bike,
// rower, elliptical, indoor pool without configured length) surface a
// "Set distance" tile that opens a Crown-driven manual entry sheet.

private struct CardioActiveTab: View {
    @ObservedObject var hr: HeartRateStore
    var sessionId: String?
    var onEndWorkout: ([String: Any]?) -> Void
    var onCancelWorkout: () -> Void
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var conn: ConnectivityStore
    @Environment(\.isLuminanceReduced) private var dim

    @State private var showActions = false
    @State private var showEndConfirm = false
    /// Shown when the user taps the manual distance tile or ends an
    /// indoor non-distance activity (bike / row / elliptical / stair /
    /// HIIT). End-mode finalizes the session after save/skip; tile-mode
    /// just updates the live metric.
    @State private var showEndDistancePrompt = false
    @State private var distancePromptEndsWorkout = false
    /// Periodic emit timer — sends `cardio_metrics` command to phone
    /// every 5s while the cardio tab is mounted. The phone uses these
    /// updates to mirror live distance/pace/HR/calories on its
    /// ActiveWorkoutScreen so users glancing at the phone see the same
    /// numbers they see on the watch.
    @State private var emitTimer: Timer?

    /// Where this activity's distance comes from. Drives whether the
    /// distance + pace tiles render mid-workout and which source badge
    /// shows on the distance tile.
    private enum DistanceMode {
        /// Outdoor with a native HK distance type (run/walk/hike/cycling
        /// outdoor). GPS feeds distance into HKLiveWorkoutBuilder.
        case gps
        /// Indoor with a native HK distance type — only run/walk/hike,
        /// where the watch's pedometer/motion sensor estimates distance
        /// without GPS. Treadmill is the canonical case.
        case pedometer
        /// No native source on the watch. Stationary bike, rower,
        /// elliptical, stair, HIIT — distance only known by the
        /// machine's own display, asked for at End.
        case manualOnly
        /// Cardio-style activity without meaningful distance, such as
        /// volleyball. Show time, HR, and calories without prompting.
        case none
    }

    private var distanceMode: DistanceMode {
        if HeartRateStore.distanceQuantityType(for: hr.activityType, location: hr.locationType) != nil {
            return hr.locationType == .outdoor ? .gps : .pedometer
        }
        if hr.needsManualDistance { return .manualOnly }
        return .none
    }

    private var showsDistanceMetrics: Bool {
        switch distanceMode {
        case .gps, .pedometer, .manualOnly:
            return true
        case .none:
            return false
        }
    }

    private var prefersSpeed: Bool {
        hr.activityType == .cycling
    }

    private var showsStepOrElevationMetrics: Bool {
        switch hr.activityType {
        case .running, .walking, .hiking:
            return true
        default:
            return false
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                // Big elapsed time — primary glance metric for cardio.
                Text(formatElapsed(hr.elapsedSeconds))
                    .font(.system(size: 38, weight: .black, design: .rounded))
                    .foregroundColor(theme.textPrimary)
                    .monospacedDigit()
                    .opacity(dim ? 0.65 : 1)

                if showsDistanceMetrics {
                    // Distance tile — auto from HK when available; manual
                    // machine cardio can tap it to enter console distance.
                    distanceTile
                    // Pace/speed + HR row.
                    HStack(spacing: 6) {
                        metricTile(
                            title: prefersSpeed ? "AVG MPH" : "PACE /\(theme.distanceUnit.uppercased())",
                            value: prefersSpeed ? speedMphLabel : paceLabel,
                            accent: theme.primary,
                        )
                        metricTile(
                            title: "HR",
                            value: hr.heartRate.map { "\($0)" } ?? "—",
                            accent: hrZoneColor(hr.zone),
                        )
                    }
                } else {
                    // No live distance or pace exists, so don't
                    // pretend. Just HR full width. Machine cardio asks
                    // for distance at End; court sports simply finish.
                    metricTile(
                        title: "HR",
                        value: hr.heartRate.map { "\($0)" } ?? "—",
                        accent: hrZoneColor(hr.zone),
                    )
                }

                // Calories chip — useful for every cardio mode.
                metricTile(
                    title: "CALORIES",
                    value: hr.activeCalories > 0 ? "\(Int(hr.activeCalories.rounded()))" : "—",
                    accent: theme.warning,
                )

                if showsStepOrElevationMetrics {
                    HStack(spacing: 6) {
                        metricTile(
                            title: "STEPS",
                            value: hr.stepCount > 0 ? "\(hr.stepCount)" : "—",
                            accent: theme.textPrimary,
                        )
                        metricTile(
                            title: "ELEV FT",
                            value: hr.elevationGainFeet > 0 ? "\(Int(hr.elevationGainFeet.rounded()))" : "—",
                            accent: theme.textPrimary,
                        )
                    }
                }

                // Two explicit actions — End-and-save (primary) +
                // Cancel-without-save (secondary, destructive). The
                // earlier single "End workout" button hid both behind
                // a confirmation dialog and users couldn't find a way
                // to discard a session they started by mistake.
                HStack(spacing: 6) {
                    Button(action: { showEndConfirm = true }) {
                        HStack(spacing: 4) {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 12, weight: .bold))
                            Text("End")
                                .font(.system(size: 12, weight: .bold))
                        }
                        .foregroundColor(theme.primary)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity)
                        .background(theme.primary.opacity(0.15))
                        .cornerRadius(10)
                    }
                    .buttonStyle(.plain)
                    Button(action: { showActions = true }) {
                        HStack(spacing: 4) {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 12, weight: .bold))
                            Text("Cancel")
                                .font(.system(size: 12, weight: .bold))
                        }
                        .foregroundColor(theme.error)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity)
                        .background(theme.error.opacity(0.15))
                        .cornerRadius(10)
                    }
                    .buttonStyle(.plain)
                }
                .buttonStyle(.plain)
                .padding(.top, 4)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
        }
        .background(theme.background.ignoresSafeArea())
        .sheet(isPresented: $showEndDistancePrompt) {
            ManualDistanceSheet(
                initialMeters: hr.displayDistanceMeters,
                distanceUnit: theme.distanceUnit,
                title: "Distance from machine",
                primaryLabel: distancePromptEndsWorkout ? "Save" : "Set",
                cancelLabel: distancePromptEndsWorkout ? "Skip" : "Cancel",
                onCommit: { meters in
                    hr.setManualDistance(meters: meters)
                    showEndDistancePrompt = false
                    if distancePromptEndsWorkout {
                        let payload = currentMetricsPayload(includeRoute: true)
                        sendMetricsToPhone(payload)
                        onEndWorkout(payload)
                    }
                },
                onCancel: {
                    showEndDistancePrompt = false
                    if distancePromptEndsWorkout {
                        let payload = currentMetricsPayload(includeRoute: true)
                        sendMetricsToPhone(payload)
                        onEndWorkout(payload)
                    }
                },
            )
            .environmentObject(theme)
        }
        .confirmationDialog(
            "End and save this workout?",
            isPresented: $showEndConfirm,
            titleVisibility: .visible
        ) {
            Button("End workout") {
                WKInterfaceDevice.current().play(.success)
                handleEndTapped()
            }
            Button("Keep going", role: .cancel) {}
        } message: {
            Text("This will send the session to your phone and save it to Thallo.")
        }
        .confirmationDialog(
            "Cancel workout?",
            isPresented: $showActions,
            titleVisibility: .visible
        ) {
            Button("Discard workout", role: .destructive, action: onCancelWorkout)
            Button("Keep going", role: .cancel) {}
        } message: {
            Text("Nothing will be saved.")
        }
        .onAppear { startEmittingMetrics() }
        .onDisappear { stopEmittingMetrics() }
    }

    private func handleEndTapped() {
        if distanceMode == .manualOnly && hr.displayDistanceMeters <= 0 {
            distancePromptEndsWorkout = true
            showEndDistancePrompt = true
        } else {
            let payload = currentMetricsPayload(includeRoute: true)
            sendMetricsToPhone(payload)
            onEndWorkout(payload)
        }
    }

    // Source badge tells the user where the number came from so they
    // know how much to trust it: GPS, pedometer, or manual machine entry.
    private var distanceTile: some View {
        VStack(spacing: 2) {
            Text(distanceLabel)
                .font(.system(size: 26, weight: .heavy, design: .rounded))
                .foregroundColor(theme.textPrimary)
                .monospacedDigit()
                .opacity(dim ? 0.65 : 1)
            HStack(spacing: 4) {
                Image(systemName: sourceBadgeIcon)
                    .font(.system(size: 8, weight: .bold))
                    .foregroundColor(sourceBadgeColor)
                Text(sourceBadgeLabel)
                    .font(.system(size: 9, weight: .heavy))
                    .tracking(0.6)
                    .foregroundColor(sourceBadgeColor)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(theme.surface)
        .cornerRadius(10)
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(theme.surfaceRaised, lineWidth: 0.5),
        )
        .onTapGesture {
            if distanceMode == .manualOnly {
                distancePromptEndsWorkout = false
                showEndDistancePrompt = true
            }
        }
    }

    private var sourceBadgeIcon: String {
        switch distanceMode {
        case .gps:
            // Filled when fix acquired, hollow circle while waiting.
            return hr.currentLocation != nil ? "location.fill" : "location.slash"
        case .pedometer: return "figure.walk"
        case .manualOnly: return "pencil"
        case .none: return "heart.fill"
        }
    }

    private var sourceBadgeColor: Color {
        switch distanceMode {
        case .gps:
            return hr.currentLocation != nil ? theme.success : theme.warning
        case .pedometer: return theme.textSecondary
        case .manualOnly: return hr.displayDistanceMeters > 0 ? theme.primary : theme.textMuted
        case .none: return theme.textMuted
        }
    }

    private var sourceBadgeLabel: String {
        switch distanceMode {
        case .gps:
            return hr.currentLocation != nil ? "GPS" : "GPS · WAITING"
        case .pedometer: return "PEDOMETER"
        case .manualOnly: return hr.displayDistanceMeters > 0 ? "MANUAL" : "TAP TO SET"
        case .none: return ""
        }
    }

    private func startEmittingMetrics() {
        emitTimer?.invalidate()
        // Emit immediately + every 5s. Watch+phone are usually within a
        // few hundred ms of each other; 5s is the right balance between
        // freshness and WatchConnectivity throughput. A 60-min run = 720
        // updates × ~120 bytes = ~85 KB total.
        sendMetricsToPhone(currentMetricsPayload())
        emitTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { _ in
            sendMetricsToPhone(currentMetricsPayload())
        }
    }

    private func stopEmittingMetrics() {
        emitTimer?.invalidate()
        emitTimer = nil
    }

    private func currentMetricsPayload(includeRoute: Bool = false) -> [String: Any] {
        var payload = watchCardioMetricsPayload(hr: hr, sessionId: sessionId)
        if includeRoute, !hr.routeCoords.isEmpty {
            payload["routeCoords"] = hr.routeCoords.prefix(12_000).map { point -> [String: Any] in
                var row: [String: Any] = [
                    "lat": point.lat,
                    "lon": point.lon,
                    "t_ms": point.timestampMs,
                ]
                if let acc = point.horizontalAccuracyM { row["acc_m"] = acc }
                if let alt = point.altitudeM { row["alt_m"] = alt }
                if let vAcc = point.verticalAccuracyM { row["v_acc_m"] = vAcc }
                return row
            }
        }
        return payload
    }

    private func sendMetricsToPhone(_ payload: [String: Any]) {
        conn.sendCommand("cardio_metrics", payload: payload)
    }

    private var distanceLabel: String {
        let m = hr.displayDistanceMeters
        if m <= 0 { return "—" }
        let prefersMetric = theme.distanceUnit == "km"
        if prefersSpeed {
            let mi = (m / 1000.0) * 0.6213711922
            return mi < 100 ? String(format: "%.2f mi", mi) : String(format: "%.0f mi", mi)
        }
        if prefersMetric {
            let km = m / 1000.0
            return km < 100 ? String(format: "%.2f km", km) : String(format: "%.0f km", km)
        }
        let mi = (m / 1000.0) * 0.6213711922
        return mi < 100 ? String(format: "%.2f mi", mi) : String(format: "%.0f mi", mi)
    }

    private var speedMphLabel: String {
        let meters = hr.displayDistanceMeters
        guard meters >= 30, hr.elapsedSeconds > 0 else { return "—" }
        let miles = (meters / 1000.0) * 0.6213711922
        let hours = Double(hr.elapsedSeconds) / 3600.0
        guard hours > 0 else { return "—" }
        let mph = miles / hours
        return mph < 100 ? String(format: "%.1f", mph) : String(format: "%.0f", mph)
    }

    private var paceLabel: String {
        guard let secPerKm = hr.averagePaceSecPerKm else { return "—" }
        let secForUnit = theme.distanceUnit == "km" ? secPerKm : secPerKm / 0.6213711922
        let m = Int(secForUnit) / 60
        let s = Int(secForUnit) % 60
        return String(format: "%d:%02d", m, s)
    }

    private func metricTile(title: String, value: String, accent: Color) -> some View {
        VStack(spacing: 2) {
            Text(title)
                .font(.system(size: 9, weight: .bold))
                .tracking(0.6)
                .foregroundColor(theme.textSecondary)
            Text(value)
                .font(.system(size: 18, weight: .heavy, design: .rounded))
                .foregroundColor(accent)
                .monospacedDigit()
                .opacity(dim ? 0.65 : 1)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .background(theme.surface)
        .cornerRadius(10)
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(theme.surfaceRaised, lineWidth: 0.5),
        )
    }

}

// Shared elapsed-time formatter for both ExerciseTab + CardioActiveTab
// so timer rendering is identical across lift / yoga / cardio surfaces.
fileprivate func formatElapsed(_ seconds: Int) -> String {
    let h = seconds / 3600
    let m = (seconds % 3600) / 60
    let s = seconds % 60
    if h > 0 { return String(format: "%d:%02d:%02d", h, m, s) }
    return String(format: "%d:%02d", m, s)
}

// Crown-driven manual distance entry. Used by indoor cardio
// (stationary bike / rower / elliptical) where the watch can't read
// distance from a sensor — the user reads the equipment console and
// sets the value. Updates here are authoritative; the next set wipes
// the prior value (this is a "current odometer" entry, not a delta).

private struct ManualDistanceSheet: View {
    let initialMeters: Double
    var distanceUnit: String = "mi"
    /// Sheet header — defaults to "Set distance" for the legacy mid-
    /// workout entry path; the End-of-workout prompt overrides with
    /// "Distance from machine" so the user knows where the number's
    /// supposed to come from.
    var title: String = "Set distance"
    /// Primary button label. "Set" for mid-workout, "Save" for End.
    var primaryLabel: String = "Set"
    /// Secondary button label. "Cancel" mid-workout (close sheet, keep
    /// going), "Skip" on End (finalize without distance).
    var cancelLabel: String = "Cancel"
    var onCommit: (Double) -> Void
    var onCancel: () -> Void
    @EnvironmentObject var theme: ThemeStore

    @State private var displayDistance: Double = 0

    var body: some View {
        VStack(spacing: 8) {
            Text(title)
                .font(.system(size: 14, weight: .bold))
                .foregroundColor(theme.textPrimary)
                .padding(.top, 8)
            Text(String(format: "%.2f %@", displayDistance, normalizedUnit))
                .font(.system(size: 36, weight: .black, design: .rounded))
                .foregroundColor(theme.primary)
                .monospacedDigit()
                .focusable(true)
                .digitalCrownRotation(
                    $displayDistance,
                    from: 0, through: 200,
                    by: 0.01, sensitivity: .medium,
                    isContinuous: false, isHapticFeedbackEnabled: true,
                )
            Text("Read the value from your equipment console.")
                .font(.system(size: 10))
                .foregroundColor(theme.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 8)
            HStack(spacing: 8) {
                Button(action: onCancel) {
                    Text(cancelLabel)
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(theme.textSecondary)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity)
                        .background(theme.surface)
                        .cornerRadius(8)
                }
                .buttonStyle(.plain)
                Button(action: { onCommit(displayDistance * metersPerDisplayUnit) }) {
                    Text(primaryLabel)
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(.white)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity)
                        .background(theme.primary)
                        .cornerRadius(8)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 8)
        }
        .background(theme.background.ignoresSafeArea())
        .onAppear { displayDistance = max(0, initialMeters / metersPerDisplayUnit) }
    }

    private var normalizedUnit: String { distanceUnit == "km" ? "km" : "mi" }
    private var metersPerDisplayUnit: Double { normalizedUnit == "km" ? 1000.0 : 1609.344 }
}

// ─── Add-exercise sheet ────────────────────────────────────────────
//
// Mid-workout Quick Add. Shows a flat list of unique exercise names
// pulled from the user's synced templates (a recents proxy that
// works without requiring a separate sync layer). Excludes exercises
// already in the current workout to avoid silent dupes. Tapping
// fires the parent's onPick which sends an `add_exercise` command
// to the phone via WatchConnectivity.

private struct AddExerciseSheet: View {
    let templates: [WatchTemplate]
    let currentExerciseNames: Set<String>
    var onPick: (WatchTemplateExercise) -> Void
    var onCancel: () -> Void
    @EnvironmentObject var theme: ThemeStore

    /// Flatten all template exercises → unique names → exclude
    /// already-in-workout. Sorted alphabetically so the list is
    /// stable across renders even if template ordering shifts.
    private var availableExercises: [WatchTemplateExercise] {
        var seen = Set<String>()
        var unique: [WatchTemplateExercise] = []
        for template in templates {
            for ex in template.exercises {
                let key = ex.name.lowercased()
                if currentExerciseNames.contains(key) { continue }
                if seen.contains(key) { continue }
                seen.insert(key)
                unique.append(ex)
            }
        }
        return unique.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private func subtitle(for exercise: WatchTemplateExercise) -> String {
        var parts: [String] = []
        if exercise.sets > 0 {
            parts.append("\(exercise.sets)x \(exercise.reps)")
        } else {
            parts.append(exercise.reps)
        }
        if let equipment = exercise.equipment, !equipment.isEmpty {
            parts.append(equipment)
        }
        return parts.filter { !$0.isEmpty }.joined(separator: " | ")
    }

    var body: some View {
        ZStack {
            theme.background.ignoresSafeArea()
            VStack(spacing: 6) {
                HStack {
                    Text("Add exercise")
                        .font(.system(size: 13, weight: .heavy))
                        .foregroundColor(theme.textPrimary)
                    Spacer()
                    Button(action: onCancel) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 18))
                            .foregroundColor(theme.textMuted)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 8)
                .padding(.top, 6)
                if availableExercises.isEmpty {
                    Spacer()
                    Image(systemName: "tray")
                        .font(.system(size: 22))
                        .foregroundColor(theme.textMuted)
                    Text("No saved exercises to add yet.\nSave a template on your phone to populate this list.")
                        .font(.system(size: 10))
                        .foregroundColor(theme.textMuted)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 12)
                    Spacer()
                } else {
                    ScrollView {
                        VStack(spacing: 6) {
                            ForEach(availableExercises, id: \.name) { exercise in
                                Button {
                                    onPick(exercise)
                                } label: {
                                    HStack(spacing: 8) {
                                        Image(systemName: "plus.circle.fill")
                                            .font(.system(size: 13))
                                            .foregroundColor(theme.primary)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(exercise.name)
                                                .font(.system(size: 12, weight: .bold))
                                                .foregroundColor(theme.textPrimary)
                                                .lineLimit(2)
                                                .multilineTextAlignment(.leading)
                                            Text(subtitle(for: exercise))
                                                .font(.system(size: 9, weight: .semibold))
                                                .foregroundColor(theme.textMuted)
                                                .lineLimit(1)
                                        }
                                        Spacer()
                                    }
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 8)
                                    .background(theme.surface)
                                    .cornerRadius(10)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 8)
                        .padding(.bottom, 10)
                    }
                }
            }
        }
    }
}
