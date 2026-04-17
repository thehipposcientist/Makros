/**
 * Thallo Motion System — shared animation presets, springs, and helpers.
 *
 * Every animation in the app should use these constants so motion
 * feels consistent. Springs are tuned for "strong, clean, controlled"
 * — the fitness app equivalent of Apple's default spring configs.
 *
 * Accessibility: all animated components should check
 * `useReducedMotion()` and skip/shorten animations when true.
 */
import { Easing } from 'react-native';

// ── Spring configs ──────────────────────────────────────────────
// Named after their feel, not their use case, so they compose freely.

/** Snappy — for buttons, chips, toggles. Feels immediate. */
export const SPRING_SNAPPY = { damping: 18, stiffness: 300, mass: 0.8 };

/** Responsive — for cards expanding, sheets opening. Feels quick but smooth. */
export const SPRING_RESPONSIVE = { damping: 20, stiffness: 200, mass: 1 };

/** Gentle — for page transitions, large layout shifts. Feels deliberate. */
export const SPRING_GENTLE = { damping: 22, stiffness: 120, mass: 1.2 };

/** Bouncy — for celebration moments only. Slight overshoot. */
export const SPRING_BOUNCY = { damping: 12, stiffness: 180, mass: 0.9 };

// ── Timing presets ──────────────────────────────────────────────

/** Quick — 180ms. Micro-interactions: button press, checkbox, chip select. */
export const TIMING_QUICK = { duration: 180, easing: Easing.out(Easing.cubic) };

/** Standard — 280ms. Card expand, tab switch, modal content. */
export const TIMING_STANDARD = { duration: 280, easing: Easing.out(Easing.cubic) };

/** Smooth — 400ms. Chart transitions, summary reveals. */
export const TIMING_SMOOTH = { duration: 400, easing: Easing.inOut(Easing.cubic) };

/** Celebration — 600ms. Achievement badge, PR reveal. */
export const TIMING_CELEBRATION = { duration: 600, easing: Easing.out(Easing.back(1.2)) };

// ── Stagger helpers ─────────────────────────────────────────────

/** Stagger delay for list items. index * BASE_STAGGER_MS. */
export const BASE_STAGGER_MS = 50;

/** Max stagger delay — cap so long lists don't feel sluggish. */
export const MAX_STAGGER_MS = 400;

export function staggerDelay(index: number, base = BASE_STAGGER_MS): number {
  return Math.min(index * base, MAX_STAGGER_MS);
}
