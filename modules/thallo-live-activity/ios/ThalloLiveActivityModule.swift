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
        public var heartRate: Int?
        public var hrZone: Int?
        public var hrZoneLabel: String?
        public var hrZoneLow: Int?
        public var hrZoneHigh: Int?
        public var hrZoneColorHex: String?
        // Cardio mode fields — see RestTimerAttributes.swift in
        // targets/resttimer-widget for the canonical comments. Both
        // structs MUST stay in sync because the Codable-based
        // ActivityKit IPC links them by qualified name.
        public var distanceMeters: Double?
        public var paceSecPerKm: Double?
        public var activeCalories: Double?
        public var distanceUnit: String?
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

private func optionalDoubleValue(_ value: Any?) -> Double? {
    if value == nil || value is NSNull { return nil }
    if let value = value as? Double, value.isFinite { return value }
    if let value = value as? Int { return Double(value) }
    if let value = value as? NSNumber { return value.doubleValue }
    if let value = value as? String {
        let cleaned = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.isEmpty { return nil }
        if let d = Double(cleaned), d.isFinite { return d }
    }
    return nil
}

private func optionalIntValue(_ value: Any?) -> Int? {
    if value == nil || value is NSNull { return nil }
    if let value = value as? Int { return value }
    if let value = value as? Double, value.isFinite { return Int(value.rounded()) }
    if let value = value as? NSNumber { return value.intValue }
    if let value = value as? String {
        let cleaned = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.isEmpty { return nil }
        if let i = Int(cleaned) { return i }
        if let d = Double(cleaned), d.isFinite { return Int(d.rounded()) }
    }
    return nil
}

private func optionalStringValue(_ value: Any?) -> String? {
    if value == nil || value is NSNull { return nil }
    if let value = value as? String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
    if let value = value as? Int { return String(value) }
    if let value = value as? Double, value.isFinite {
        return value.rounded() == value ? String(Int(value)) : String(value)
    }
    if let value = value as? NSNumber { return String(value.intValue) }
    return nil
}

private func anyOrNull(_ value: Any?) -> Any {
    return value ?? NSNull()
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
                elapsedSeconds: doubleValue(payload["elapsedSeconds"], fallback: 0),
                heartRate: optionalIntValue(payload["heartRate"]),
                hrZone: optionalIntValue(payload["hrZone"]),
                hrZoneLabel: optionalStringValue(payload["hrZoneLabel"]),
                hrZoneLow: optionalIntValue(payload["hrZoneLow"]),
                hrZoneHigh: optionalIntValue(payload["hrZoneHigh"]),
                hrZoneColorHex: optionalStringValue(payload["hrZoneColorHex"]),
                distanceMeters: optionalDoubleValue(payload["distanceMeters"]),
                paceSecPerKm: optionalDoubleValue(payload["paceSecPerKm"]),
                activeCalories: optionalDoubleValue(payload["activeCalories"]),
                distanceUnit: optionalStringValue(payload["distanceUnit"])
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
                    elapsedSeconds: doubleValue(payload["elapsedSeconds"], fallback: activity.content.state.elapsedSeconds ?? 0),
                    heartRate: payload.keys.contains("heartRate") ? optionalIntValue(payload["heartRate"]) : activity.content.state.heartRate,
                    hrZone: payload.keys.contains("hrZone") ? optionalIntValue(payload["hrZone"]) : activity.content.state.hrZone,
                    hrZoneLabel: payload.keys.contains("hrZoneLabel") ? optionalStringValue(payload["hrZoneLabel"]) : activity.content.state.hrZoneLabel,
                    hrZoneLow: payload.keys.contains("hrZoneLow") ? optionalIntValue(payload["hrZoneLow"]) : activity.content.state.hrZoneLow,
                    hrZoneHigh: payload.keys.contains("hrZoneHigh") ? optionalIntValue(payload["hrZoneHigh"]) : activity.content.state.hrZoneHigh,
                    hrZoneColorHex: payload.keys.contains("hrZoneColorHex") ? optionalStringValue(payload["hrZoneColorHex"]) : activity.content.state.hrZoneColorHex,
                    distanceMeters: payload.keys.contains("distanceMeters") ? optionalDoubleValue(payload["distanceMeters"]) : activity.content.state.distanceMeters,
                    paceSecPerKm: payload.keys.contains("paceSecPerKm") ? optionalDoubleValue(payload["paceSecPerKm"]) : activity.content.state.paceSecPerKm,
                    activeCalories: payload.keys.contains("activeCalories") ? optionalDoubleValue(payload["activeCalories"]) : activity.content.state.activeCalories,
                    distanceUnit: payload.keys.contains("distanceUnit") ? optionalStringValue(payload["distanceUnit"]) : activity.content.state.distanceUnit
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
                    "heartRate": anyOrNull(state.heartRate),
                    "hrZone": anyOrNull(state.hrZone),
                    "hrZoneLabel": anyOrNull(state.hrZoneLabel),
                    "hrZoneLow": anyOrNull(state.hrZoneLow),
                    "hrZoneHigh": anyOrNull(state.hrZoneHigh),
                    "hrZoneColorHex": anyOrNull(state.hrZoneColorHex),
                    "distanceMeters": anyOrNull(state.distanceMeters),
                    "paceSecPerKm": anyOrNull(state.paceSecPerKm),
                    "activeCalories": anyOrNull(state.activeCalories),
                    "distanceUnit": anyOrNull(state.distanceUnit),
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
