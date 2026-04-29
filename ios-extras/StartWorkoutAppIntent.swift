// "Start Thallo workout" App Intent.
//
// On first run after install (and any time the user re-donates via
// the Shortcuts app), iOS surfaces this as a Siri suggestion. Users
// can also explicitly add it as a Shortcut, say "Start Thallo
// workout" to Siri, or trigger it from the Lock Screen / Home Screen
// via the Shortcuts widget.
//
// The intent itself is intentionally tiny: it just opens the app via
// the URL scheme `thallo://start-workout`. The phone app's deep-link
// router catches it and mounts ActiveWorkoutScreen for today's
// scheduled workout. We don't try to do "headless" workout logging
// from the intent — App Intents on watchOS / iOS 16 don't have
// access to our React Native runtime, and starting a workout requires
// the full app context anyway.
//
// IMPORTANT: This file is drop-in source for an App Intents target. To
// ship it, make it a member of the Intents extension target generated
// for the app. The JS deep-link handler for `thallo://start-workout`
// is wired in app/index.tsx.
//
// Native target checklist:
//   1. Adding an Intents extension target in Xcode (or a separate
//      `expo-target` of type `app-intent` once @bacons supports it).
//   2. Marking the file as a member of that target.
//   3. Declaring the intent in the main app's Info.plist
//      `NSUserActivityTypes` so the URL scheme handoff works.
//   4. Adding `thallo://` to `LSApplicationQueriesSchemes` if needed.

#if canImport(AppIntents)

import AppIntents

@available(iOS 16.0, *)
struct StartThalloWorkoutIntent: AppIntent {
    static var title: LocalizedStringResource = "Start Thallo Workout"
    static var description = IntentDescription(
        "Opens Thallo and starts today's workout."
    )
    static var openAppWhenRun: Bool = true

    func perform() async throws -> some IntentResult & OpensIntent {
        // Hand off to the app via deep link. The Expo Router root
        // listens for thallo://start-workout and routes to the
        // ActiveWorkoutScreen with today's planned session.
        guard let url = URL(string: "thallo://start-workout") else {
            return .result()
        }
        return .result(opensURL: url)
    }
}

@available(iOS 16.0, *)
struct ThalloShortcutsProvider: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartThalloWorkoutIntent(),
            phrases: [
                "Start \(.applicationName) workout",
                "Begin my \(.applicationName) workout",
                "Open my workout in \(.applicationName)",
            ],
            shortTitle: "Start workout",
            systemImageName: "figure.strengthtraining.traditional",
        )
    }
}

#endif
