import SwiftUI
import HealthKit
import WatchKit
import UserNotifications

@main
struct ThalloWatchApp: App {
    @WKApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var conn = ConnectivityStore.shared
    @StateObject private var theme = ThemeStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(conn)
                .environmentObject(theme)
                .preferredColorScheme(theme.preferredColorScheme)
                .onAppear { theme.palette = conn.theme }
                .onReceive(conn.$theme) { palette in theme.palette = palette }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                conn.requestPullOnWake()
            }
        }
    }
}

final class AppDelegate: NSObject, WKApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching() {
        // Become the notification delegate so our own local notifications
        // (the rest-over ding) play their sound even while the watch app
        // is in the foreground — otherwise watchOS delivers them silently
        // to Notification Center while the user is looking at the timer.
        UNUserNotificationCenter.current().delegate = self
    }

    func handle(_ workoutConfiguration: HKWorkoutConfiguration) {
        UserDefaults.standard.set(true, forKey: "thallo.pendingWorkoutLaunch")
        NotificationCenter.default.post(name: .watchWorkoutLaunch, object: workoutConfiguration)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.sound])
    }
}
