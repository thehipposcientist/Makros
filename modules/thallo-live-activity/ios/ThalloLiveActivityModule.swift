import ActivityKit
import ExpoModulesCore
import Foundation

// ThalloLiveActivityModule — exposes ActivityKit start/update/end to JS.
//
// The widget target (targets/resttimer-widget/) provides the UI and data
// schema via RestTimerAttributes.swift. Both the widget extension AND the
// main app target must have a matching `RestTimerAttributes` struct — the
// Swift compiler links them by module-qualified name. We redeclare the
// struct here so the main app target can encode/decode activities.

@available(iOS 16.2, *)
public struct RestTimerAttributes: ActivityAttributes {
    public typealias RestTimerState = ContentState

    public struct ContentState: Codable, Hashable {
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
    }

    public var workoutId: String
}

private func doubleValue(_ value: Any?, fallback: Double) -> Double {
    if let value = value as? Double { return value }
    if let value = value as? Int { return Double(value) }
    if let value = value as? NSNumber { return value.doubleValue }
    return fallback
}

private func intValue(_ value: Any?, fallback: Int) -> Int {
    if let value = value as? Int { return value }
    if let value = value as? Double { return Int(value) }
    if let value = value as? NSNumber { return value.intValue }
    return fallback
}

private func boolValue(_ value: Any?, fallback: Bool) -> Bool {
    if let value = value as? Bool { return value }
    if let value = value as? NSNumber { return value.boolValue }
    if let value = value as? String {
        let lower = value.lowercased()
        if lower == "true" || lower == "1" { return true }
        if lower == "false" || lower == "0" { return false }
    }
    return fallback
}

public class ThalloLiveActivityModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ThalloLiveActivityModule")

        // Start a new Live Activity and return its ID (or null on failure).
        AsyncFunction("startActivity") { (payload: [String: Any]) -> String? in
            guard #available(iOS 16.2, *) else { return nil }
            guard ActivityAuthorizationInfo().areActivitiesEnabled else { return nil }

            let fallbackStartMs = Date().timeIntervalSince1970 * 1000
            let fallbackEndMs = Date().addingTimeInterval(60).timeIntervalSince1970 * 1000
            let endDateMs = doubleValue(payload["endDateMs"], fallback: fallbackEndMs)
            let startedAtMs = doubleValue(payload["startedAtMs"], fallback: fallbackStartMs)
            let durationSeconds = doubleValue(payload["durationSeconds"], fallback: max(1, (endDateMs - startedAtMs) / 1000))
            let state = RestTimerAttributes.ContentState(
                mode: (payload["mode"] as? String) ?? "rest",
                startedAtMs: startedAtMs,
                durationSeconds: durationSeconds,
                endDateMs: endDateMs,
                exerciseName: (payload["exerciseName"] as? String) ?? "Exercise",
                setNumber: intValue(payload["setNumber"], fallback: 0),
                totalSets: intValue(payload["totalSets"], fallback: 0),
                nextSetRecommendation: (payload["nextSetRecommendation"] as? String) ?? "",
                themeColorHex: (payload["themeColorHex"] as? String) ?? "#15C7B8",
                paused: boolValue(payload["paused"], fallback: false),
                elapsedSeconds: doubleValue(payload["elapsedSeconds"], fallback: 0)
            )
            let attrs = RestTimerAttributes(
                workoutId: (payload["workoutId"] as? String) ?? UUID().uuidString
            )

            do {
                let activity = try Activity<RestTimerAttributes>.request(
                    attributes: attrs,
                    content: .init(state: state, staleDate: nil),
                    pushType: nil
                )
                return activity.id
            } catch {
                NSLog("[ThalloLiveActivity] startActivity failed: \(error)")
                return nil
            }
        }

        // Update an existing activity by ID.
        AsyncFunction("updateActivity") { (activityId: String, payload: [String: Any]) -> Bool in
            guard #available(iOS 16.2, *) else { return false }
            for activity in Activity<RestTimerAttributes>.activities where activity.id == activityId {
                let startedAtMs = doubleValue(payload["startedAtMs"], fallback: activity.content.state.startedAtMs)
                let endDateMs = doubleValue(payload["endDateMs"], fallback: activity.content.state.endDateMs)
                let state = RestTimerAttributes.ContentState(
                    mode: (payload["mode"] as? String) ?? activity.content.state.mode,
                    startedAtMs: startedAtMs,
                    durationSeconds: doubleValue(payload["durationSeconds"], fallback: activity.content.state.durationSeconds),
                    endDateMs: endDateMs,
                    exerciseName: (payload["exerciseName"] as? String) ?? activity.content.state.exerciseName,
                    setNumber: intValue(payload["setNumber"], fallback: activity.content.state.setNumber),
                    totalSets: intValue(payload["totalSets"], fallback: activity.content.state.totalSets),
                    nextSetRecommendation: (payload["nextSetRecommendation"] as? String) ?? activity.content.state.nextSetRecommendation,
                    themeColorHex: (payload["themeColorHex"] as? String) ?? activity.content.state.themeColorHex,
                    paused: boolValue(payload["paused"], fallback: activity.content.state.paused ?? false),
                    elapsedSeconds: doubleValue(payload["elapsedSeconds"], fallback: activity.content.state.elapsedSeconds ?? 0)
                )
                await activity.update(.init(state: state, staleDate: nil))
                return true
            }
            return false
        }

        AsyncFunction("getActivityState") { (activityId: String) -> [String: Any]? in
            guard #available(iOS 16.2, *) else { return nil }
            for activity in Activity<RestTimerAttributes>.activities where activity.id == activityId {
                let state = activity.content.state
                return [
                    "mode": state.mode ?? "rest",
                    "startedAtMs": state.startedAtMs,
                    "durationSeconds": state.durationSeconds,
                    "endDateMs": state.endDateMs,
                    "exerciseName": state.exerciseName,
                    "setNumber": state.setNumber,
                    "totalSets": state.totalSets,
                    "nextSetRecommendation": state.nextSetRecommendation,
                    "themeColorHex": state.themeColorHex,
                    "paused": state.paused ?? false,
                    "elapsedSeconds": state.elapsedSeconds ?? 0,
                    "workoutId": activity.attributes.workoutId
                ]
            }
            return nil
        }

        // End the activity. dismissalPolicy 'immediate' removes it from the
        // lock screen right away; otherwise iOS keeps it for ~4 hours as a
        // "ghost" banner. We always want immediate for rest timers.
        AsyncFunction("endActivity") { (activityId: String) -> Bool in
            guard #available(iOS 16.2, *) else { return false }
            for activity in Activity<RestTimerAttributes>.activities where activity.id == activityId {
                await activity.end(nil, dismissalPolicy: .immediate)
                return true
            }
            return false
        }

        // Nuclear option: end every outstanding Thallo activity. Useful
        // when the app relaunches and we don't know what's still live.
        AsyncFunction("endAllActivities") { () -> Void in
            guard #available(iOS 16.2, *) else { return }
            for activity in Activity<RestTimerAttributes>.activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }

        // Check if Live Activities are supported + enabled by the user.
        Function("areActivitiesEnabled") { () -> Bool in
            if #available(iOS 16.2, *) {
                return ActivityAuthorizationInfo().areActivitiesEnabled
            }
            return false
        }
    }
}
