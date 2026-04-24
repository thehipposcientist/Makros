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

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(conn)
                .environmentObject(theme)
                .preferredColorScheme(.dark)
        }
    }
}
