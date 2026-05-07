import ActivityKit
import AppIntents
import Foundation

@available(iOSApplicationExtension 17.0, *)
struct AdjustRestTimerIntent: AppIntent {
    static var title: LocalizedStringResource = "Adjust Rest Timer"
    static var openAppWhenRun = false

    @Parameter(title: "Workout ID")
    var workoutId: String

    @Parameter(title: "Delta Seconds")
    var deltaSeconds: Int

    init() {
        self.workoutId = ""
        self.deltaSeconds = 0
    }

    init(workoutId: String, deltaSeconds: Int) {
        self.workoutId = workoutId
        self.deltaSeconds = deltaSeconds
    }

    func perform() async throws -> some IntentResult {
        guard !workoutId.isEmpty, deltaSeconds != 0 else { return .result() }

        let now = Date()
        let nowMs = now.timeIntervalSince1970 * 1000
        for activity in Activity<RestTimerAttributes>.activities where activity.attributes.workoutId == workoutId {
            let state = activity.content.state
            if state.mode == "elapsed" { continue }
            let remainingSeconds = max(0, ceil((state.endDateMs - nowMs) / 1000))
            let nextRemainingSeconds = max(0, remainingSeconds + Double(deltaSeconds))

            if nextRemainingSeconds <= 0 {
                await activity.end(nil, dismissalPolicy: .immediate)
                continue
            }

            let elapsedSeconds = max(0, (nowMs - state.startedAtMs) / 1000)
            let nextDurationSeconds = max(1, elapsedSeconds + nextRemainingSeconds)
            let nextState = RestTimerAttributes.ContentState(
                mode: state.mode,
                startedAtMs: state.startedAtMs,
                durationSeconds: nextDurationSeconds,
                endDateMs: nowMs + nextRemainingSeconds * 1000,
                exerciseName: state.exerciseName,
                setNumber: state.setNumber,
                totalSets: state.totalSets,
                nextSetRecommendation: state.nextSetRecommendation,
                themeColorHex: state.themeColorHex,
                paused: state.paused,
                elapsedSeconds: state.elapsedSeconds,
                heartRate: state.heartRate,
                hrZone: state.hrZone,
                hrZoneLabel: state.hrZoneLabel,
                hrZoneLow: state.hrZoneLow,
                hrZoneHigh: state.hrZoneHigh,
                hrZoneColorHex: state.hrZoneColorHex
            )
            await activity.update(.init(state: nextState, staleDate: nil))
        }

        return .result()
    }
}
