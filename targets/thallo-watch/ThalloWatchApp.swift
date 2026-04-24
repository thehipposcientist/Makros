// watchOS app entrypoint. Two store objects are long-lived and live
// in the environment:
//   • ConnectivityStore — receives workout + theme from the phone
//   • ThemeStore        — mirrors the palette into SwiftUI-friendly
//                          Color values for every view
//
// HeartRateStore is per-session (created inside ContentView when the
// user starts a workout and torn down on end).

import SwiftUI

@main
struct ThalloWatchApp: App {
    @StateObject private var conn = ConnectivityStore.shared
    @StateObject private var theme = ThemeStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(conn)
                .environmentObject(theme)
                .preferredColorScheme(.dark)
        }
        .onChange(of: scenePhase) { _, phase in
            // Whenever the watch app becomes active (user raised wrist
            // or tapped from the complication / Smart Stack), ask the
            // phone for a fresh state snapshot. Closes the gap where
            // applicationContext was queued hours ago and meals have
            // moved on since.
            if phase == .active {
                conn.requestPull()
            }
        }
    }
}
