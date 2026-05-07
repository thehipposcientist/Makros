import SwiftUI
import HealthKit
import WatchKit

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
                .preferredColorScheme(.dark)
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

final class AppDelegate: NSObject, WKApplicationDelegate {
    func handle(_ workoutConfiguration: HKWorkoutConfiguration) {
        UserDefaults.standard.set(true, forKey: "thallo.pendingWorkoutLaunch")
        NotificationCenter.default.post(name: .watchWorkoutLaunch, object: workoutConfiguration)
    }
}
