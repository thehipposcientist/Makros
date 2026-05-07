// Theme palette mirrored from the iOS app.
//
// The phone pushes the user's currently-selected AppTheme colors over
// WatchConnectivity as a compact dict; we decode into `WatchPalette`
// and publish through the environment so every SwiftUI view just uses
// `@EnvironmentObject var theme`.
//
// Until the first sync arrives we fall back to the phone app's default
// `slate` palette.

import SwiftUI

struct WatchPalette: Codable, Equatable {
    var themeName: String?
    var syncedAtMs: Double?
    var background:    String
    var surface:       String
    var surfaceRaised: String
    var primary:       String
    var textPrimary:   String
    var textSecondary: String
    var textMuted:     String
    var success:       String
    var warning:       String
    var error:         String

    static let appDefault = WatchPalette(
        themeName: "slate",
        syncedAtMs: nil,
        background:    "#182030",
        surface:       "#222C3E",
        surfaceRaised: "#2C3850",
        primary:       "#F07848",
        textPrimary:   "#E8F4FF",
        textSecondary: "#A8C0D8",
        textMuted:     "#6888A8",
        success:       "#40C878",
        warning:       "#F0A030",
        error:         "#FF5058"
    )
    static let midnight = appDefault
}

extension Color {
    /// Parse a hex string like `#RRGGBB` / `#AARRGGBB`. Falls back to
    /// gray on malformed input so bad user data never crashes the UI.
    init(hex: String) {
        let trimmed = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: trimmed).scanHexInt64(&int)
        let r, g, b, a: UInt64
        switch trimmed.count {
        case 3: // short #RGB
            (a, r, g, b) = (255, (int >> 8) * 17, (int >> 4 & 0xF) * 17, (int & 0xF) * 17)
        case 6: // #RRGGBB
            (a, r, g, b) = (255, int >> 16, int >> 8 & 0xFF, int & 0xFF)
        case 8: // #AARRGGBB
            (a, r, g, b) = (int >> 24, int >> 16 & 0xFF, int >> 8 & 0xFF, int & 0xFF)
        default:
            (a, r, g, b) = (255, 120, 120, 120)
        }
        self.init(.sRGB,
                  red:   Double(r) / 255,
                  green: Double(g) / 255,
                  blue:  Double(b) / 255,
                  opacity: Double(a) / 255)
    }
}

final class ThemeStore: ObservableObject {
    @Published var palette: WatchPalette = .midnight

    var background:    Color { Color(hex: palette.background) }
    var surface:       Color { Color(hex: palette.surface) }
    var surfaceRaised: Color { Color(hex: palette.surfaceRaised) }
    var primary:       Color { Color(hex: palette.primary) }
    var textPrimary:   Color { Color(hex: palette.textPrimary) }
    var textSecondary: Color { Color(hex: palette.textSecondary) }
    var textMuted:     Color { Color(hex: palette.textMuted) }
    var success:       Color { Color(hex: palette.success) }
    var warning:       Color { Color(hex: palette.warning) }
    var error:         Color { Color(hex: palette.error) }
}
