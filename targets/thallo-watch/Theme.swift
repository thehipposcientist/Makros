// Theme palette mirrored from the iOS app.
//
// The phone pushes the user's currently-selected AppTheme colors over
// WatchConnectivity as a compact dict; we decode into `WatchPalette`
// and publish through the environment so every SwiftUI view just uses
// `@EnvironmentObject var theme`.
//
// Until the first sync arrives we fall back to the phone app's default
// `aurora` palette.

import SwiftUI

struct WatchPalette: Codable, Equatable {
    var themeName: String?
    var interfaceStyle: String?
    var syncedAtMs: Double?
    var distanceUnit: String?
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
        themeName: "aurora",
        interfaceStyle: "dark",
        syncedAtMs: nil,
        distanceUnit: "mi",
        background:    "#060B14",
        surface:       "#0C1420",
        surfaceRaised: "#14202E",
        primary:       "#40E8A0",
        textPrimary:   "#E8F0F8",
        textSecondary: "#90A8C0",
        textMuted:     "#506878",
        success:       "#40D888",
        warning:       "#E8B040",
        error:         "#F06070"
    )
    static let aurora = appDefault
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
    @Published var palette: WatchPalette = .aurora
    private static let lightThemeNames: Set<String> = [
        "sunrise", "cardinal", "parchment", "linen",
        "clover",
        "butter", "summer", "lilac", "sky", "glacier", "citrus", "terra", "rose",
        "paper"
    ]

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
    var distanceUnit: String { palette.distanceUnit == "km" ? "km" : "mi" }
    var preferredColorScheme: ColorScheme {
        switch palette.interfaceStyle?.lowercased() {
        case "light":
            return .light
        case "dark":
            return .dark
        default:
            guard let themeName = palette.themeName?.lowercased() else { return .dark }
            return Self.lightThemeNames.contains(themeName) ? .light : .dark
        }
    }
}
