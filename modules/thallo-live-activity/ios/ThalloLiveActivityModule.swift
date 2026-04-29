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
        public var endDateMs: Double
        public var exerciseName: String
        public var setNumber: Int
        public var totalSets: Int
        public var nextSetRecommendation: String
        public var themeColorHex: String
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

public class ThalloLiveActivityModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ThalloLiveActivityModule")

        // Start a new Live Activity and return its ID (or null on failure).
        AsyncFunction("startActivity") { (payload: [String: Any]) -> String? in
            guard #available(iOS 16.2, *) else { return nil }
            guard ActivityAuthorizationInfo().areActivitiesEnabled else { return nil }

            let state = RestTimerAttributes.ContentState(
                endDateMs: doubleValue(payload["endDateMs"], fallback: Date().addingTimeInterval(60).timeIntervalSince1970 * 1000),
                exerciseName: (payload["exerciseName"] as? String) ?? "Exercise",
                setNumber: intValue(payload["setNumber"], fallback: 0),
                totalSets: intValue(payload["totalSets"], fallback: 0),
                nextSetRecommendation: (payload["nextSetRecommendation"] as? String) ?? "",
                themeColorHex: (payload["themeColorHex"] as? String) ?? "#15C7B8"
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
                let state = RestTimerAttributes.ContentState(
                    endDateMs: doubleValue(payload["endDateMs"], fallback: activity.content.state.endDateMs),
                    exerciseName: (payload["exerciseName"] as? String) ?? activity.content.state.exerciseName,
                    setNumber: intValue(payload["setNumber"], fallback: activity.content.state.setNumber),
                    totalSets: intValue(payload["totalSets"], fallback: activity.content.state.totalSets),
                    nextSetRecommendation: (payload["nextSetRecommendation"] as? String) ?? activity.content.state.nextSetRecommendation,
                    themeColorHex: (payload["themeColorHex"] as? String) ?? activity.content.state.themeColorHex
                )
                await activity.update(.init(state: state, staleDate: nil))
                return true
            }
            return false
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
