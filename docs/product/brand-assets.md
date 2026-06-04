# Brand Assets

Thallo's current brand set lives under `assets/images/`.

## Canonical Files

- `assets/images/thallo-icon.png`: app launcher icon and store-facing square icon. Use for opaque square contexts only.
- `assets/images/thallo-adaptive-icon.png`: transparent Android adaptive foreground derived from the pulse-dot tile. Pair with `#06100F`.
- `assets/images/thallo-favicon.png`: web favicon and small browser/site icon derived from the pulse-dot tile.
- `src/components/BrandMark.tsx`: in-app wrapper for the canonical pulse-dot icon asset, used for compact headers, loading, auth, and animated brand surfaces.
- `assets/images/thallo-icon-mark.png`: transparent rounded pulse-dot tile for in-app and web UI rendering.
- `assets/images/thallo-logo-white-transparent-New.png`: white wordmark for dark or photographic surfaces.
- `assets/images/thallo-logo-black.png`: dark wordmark for light surfaces and generated exports.
- `assets/images/thallo-logo-compact-white.png` and `assets/images/thallo-logo-compact-black.png`: `THALLO`-only compact wordmarks for small nav/header/footer slots where the tagline would be unreadable.
- `assets/images/thallo-splash.png`: native splash-screen pulse mark only. Pair with `#06100F` and `contain`.
- `assets/images/thallo-social-card.png`: 1200 x 630 social preview art. The matching public web copy lives at `public/thallo-social-card.png`.
- `assets/images/brand/thallo-brand-board-dark-source.png`: current source/reference board for the pulse-dot app icon and wordmark system. Do not use it directly in app UI because it includes presentation mockups and excess background.

Native app, watch app, widget, and complication icon catalogs should be regenerated from `assets/images/thallo-icon.png` so the installed icon family stays visually aligned. Do not reintroduce the previous mark.

## Usage Recommendations

Use `BrandMark` anywhere the display size is small enough that the wordmark would become unreadable: compact headers, badges, loading surfaces, and small brand accents.

Use the wordmark when there is enough width for the `TOTAL HEALTH.` line to breathe. If the rendered width is below roughly 180 px, prefer `BrandMark` or hide the tagline with a dedicated future wordmark crop.

Use the compact wordmark in top bars, footers, and auth panels narrower than roughly 220 px. Use the full wordmark for large auth, share cards, and presentation-size surfaces.

Keep dark surfaces on `#06100F` or existing app dark neutrals, then use the white wordmark. Keep light surfaces near white/soft mint and use the dark wordmark. Avoid placing the source boards inside app screens.
