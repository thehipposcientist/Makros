export type PhotoGradientStops = [string, string, ...string[]];
export type PhotoGradientLocations = [number, number, ...number[]];

export function hexWithAlpha(hex: string, alpha: number): string {
  const raw = hex.replace('#', '');
  if (raw.length !== 3 && raw.length !== 6) return hex;
  const expanded = raw.length === 3 ? raw.split('').map(ch => ch + ch).join('') : raw;
  const clamped = Math.max(0, Math.min(1, alpha));
  const channel = Math.round(clamped * 255).toString(16).padStart(2, '0').toUpperCase();
  return `#${expanded}${channel}`;
}

export function isLightHexColor(hex: string): boolean {
  const raw = hex.replace('#', '');
  const expanded = raw.length === 3 ? raw.split('').map(ch => ch + ch).join('') : raw;
  if (expanded.length !== 6) return false;
  const r = Number.parseInt(expanded.slice(0, 2), 16);
  const g = Number.parseInt(expanded.slice(2, 4), 16);
  const b = Number.parseInt(expanded.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return false;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55;
}

export function darkPhotoBaseForColors(themeColors: { background: string }): string {
  return isLightHexColor(themeColors.background) ? '#020617' : themeColors.background;
}

export function lightPhotoOverlayColors(themeHue: string, surface: string): {
  colors: PhotoGradientStops;
  locations: PhotoGradientLocations;
} {
  return {
    colors: [
      hexWithAlpha(surface, 0.12),
      hexWithAlpha(themeHue, 0.16),
      hexWithAlpha(surface, 0.24),
    ],
    locations: [0, 0.46, 1],
  };
}

export function darkPhotoOverlayColors(themeHue: string, darkBase: string, bottomAlpha = 0.86): {
  colors: PhotoGradientStops;
  locations: PhotoGradientLocations;
} {
  return {
    colors: [
      hexWithAlpha(darkBase, 0.2),
      hexWithAlpha(themeHue, 0.16),
      hexWithAlpha(darkBase, bottomAlpha),
    ],
    locations: [0, 0.52, 1],
  };
}

export function photoBottomFadeStops(target: string): {
  colors: PhotoGradientStops;
  locations: PhotoGradientLocations;
} {
  return {
    colors: [
      hexWithAlpha(target, 0),
      hexWithAlpha(target, 0.02),
      hexWithAlpha(target, 0.08),
      hexWithAlpha(target, 0.18),
      hexWithAlpha(target, 0.34),
      hexWithAlpha(target, 0.55),
      hexWithAlpha(target, 0.76),
      hexWithAlpha(target, 0.92),
      target,
    ],
    locations: [0, 0.14, 0.28, 0.43, 0.57, 0.7, 0.82, 0.92, 1],
  };
}

export function darkPhotoHueOverlayColor(darkBase: string): string {
  return hexWithAlpha(darkBase, 0.18);
}

export function lightPhotoPanelChrome(themeHue: string, surface: string) {
  return {
    backgroundColor: hexWithAlpha(surface, 0.88),
    borderColor: hexWithAlpha(themeHue, 0.26),
  };
}
