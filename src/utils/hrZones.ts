// Canonical heart-rate zone math.
//
// Single source of truth for both frontend and backend. The Python
// implementation in `backend/app/services/workout/cardio.py` mirrors
// this file's constants and formulas exactly — a parity test fixes
// that contract so a change in one place forces a matching change in
// the other.
//
// Method: % of Maximum Heart Rate (MHR).
//
//   zoneBpm(p) = maxHR × p
//
// Five zones (Z1..Z5). Bands match the Apple Fitness / Garmin / Whoop
// convention (50/60/70/80/90/100% MHR) so users coming from those
// platforms see the same zone for the same heart rate. Apple Watch's
// Workout app, Garmin's default zones, Strava, and Polar all default
// to %MHR; Garmin/Polar offer %HRR (Karvonen) as an advanced option.
//
// ── Why %MHR and not %HRR (Karvonen) ──
// %HRR is more physiologically rigorous — it accounts for the fact
// that two users with the same MHR but different RHRs have different
// useful working ranges. But it also produces zone numbers that
// disagree with every consumer fitness platform: a heart rate that
// reads as "Zone 3 (Aerobic)" on an Apple Watch reads as "Zone 1/2
// (Recovery)" under Karvonen. Users notice. Resolved in favor of
// matching consumer expectations rather than physiological purity.
//
// Resting HR is no longer required for the zone math, but we still
// resolve it (Apple Health / profile / fallback) and surface it on
// `HRZonesResult` because other features (recovery score, HR summary
// cards) consume it.

import type { HRZone } from '../services/api';

// ── Public types ───────────────────────────────────────────────────────────

export type HRZoneNumber = 1 | 2 | 3 | 4 | 5;

/** Where the max-HR value came from. Surfaced in `HRZonesResult.maxHRSource`
 *  so UI can render confidence ("Estimated from age" vs "Your measured max"). */
export type HRMaxSource = 'user_entered' | 'observed' | 'estimated_tanaka';

/** Where the resting-HR value came from, in priority order. */
export type HRRestingSource = 'apple_health_7d' | 'apple_health_30d' | 'user_profile' | 'fallback';

export interface HRZonesInput {
  /** Required for the Tanaka estimate fallback. Ignored when a higher-
   *  priority source (user-entered / observed maxHR) wins. */
  age: number | null;
  /** Max HR the user has explicitly entered in their profile. */
  userMaxHR?: number | null;
  /** Max HR observed during recent training with high confidence
   *  (e.g. peak from an interval session). Wins over the estimate. */
  observedMaxHR?: number | null;
  /** Resting HR averaged over the last 7 days (Apple Health). Carried
   *  for display only — the zone math doesn't use it. */
  rhr7d?: number | null;
  /** Resting HR averaged over the last 30 days (Apple Health). */
  rhr30d?: number | null;
  /** Resting HR the user has explicitly entered in their profile. */
  profileRHR?: number | null;
}

export interface HRZonesResult {
  method: 'pct_max_hr';
  /** Max HR used for the zone calculation. */
  maxHR: number;
  /** Resting HR resolved for display. Not used in the zone math under
   *  the %MHR method. */
  restingHR: number;
  maxHRSource: HRMaxSource;
  restingHRSource: HRRestingSource;
  /** Five zones (Z1..Z5), low-inclusive / high-exclusive (the highest
   *  zone is closed at MHR so a max-effort reading still maps to Z5). */
  zones: HRZone[];
}

// ── Constants (mirrored in backend) ───────────────────────────────────────

/** Per-zone %MHR bands. Bpm = `maxHR × pct`. Labels match the
 *  Garmin/Polar convention so users coming from those ecosystems
 *  recognize the names. */
export const HR_ZONE_BANDS: ReadonlyArray<{
  zone: HRZoneNumber;
  label: string;
  lowPct: number;
  highPct: number;
}> = [
  { zone: 1, label: 'Warm Up',   lowPct: 0.50, highPct: 0.60 },
  { zone: 2, label: 'Easy',      lowPct: 0.60, highPct: 0.70 },
  { zone: 3, label: 'Aerobic',   lowPct: 0.70, highPct: 0.80 },
  { zone: 4, label: 'Threshold', lowPct: 0.80, highPct: 0.90 },
  { zone: 5, label: 'Maximum',   lowPct: 0.90, highPct: 1.00 },
];

/** Fallback resting HR for display when no source is available.
 *  Population mean for adults. */
export const FALLBACK_RESTING_HR = 60;

/** Fallback max HR when age is also missing. Equivalent to a
 *  ~26-year-old's Tanaka estimate. */
export const FALLBACK_MAX_HR = 190;

/** Display colors per zone (Z1..Z5). Index 0 is Z1, index 4 is Z5. */
export const HR_ZONE_COLORS = ['#38BDF8', '#22C55E', '#EAB308', '#F97316', '#EF4444'] as const;

// ── Resolvers ──────────────────────────────────────────────────────────────

/** Tanaka formula. More accurate than `220 - age` across age ranges
 *  (especially over 40). Cited in HUNT3 and Tanaka 2001. */
export function estimateMaxHRTanaka(age: number): number {
  return Math.round(208 - 0.7 * age);
}

/** Pick the best available max HR following the priority chain:
 *    user-entered → observed → Tanaka estimate → 190 fallback. */
export function resolveMaxHR(input: HRZonesInput): { maxHR: number; source: HRMaxSource } {
  const user = positiveNumber(input.userMaxHR);
  if (user != null) return { maxHR: Math.round(user), source: 'user_entered' };
  const observed = positiveNumber(input.observedMaxHR);
  if (observed != null) return { maxHR: Math.round(observed), source: 'observed' };
  const age = positiveNumber(input.age);
  if (age != null) return { maxHR: estimateMaxHRTanaka(age), source: 'estimated_tanaka' };
  return { maxHR: FALLBACK_MAX_HR, source: 'estimated_tanaka' };
}

/** Pick the best available resting HR:
 *    7d Apple Health → 30d Apple Health → profile → 60 fallback.
 *  Carried on `HRZonesResult` for display; the zone math itself does
 *  not depend on RHR under the %MHR method. */
export function resolveRestingHR(input: HRZonesInput): { restingHR: number; source: HRRestingSource } {
  const r7 = positiveNumber(input.rhr7d);
  if (r7 != null) return { restingHR: Math.round(r7), source: 'apple_health_7d' };
  const r30 = positiveNumber(input.rhr30d);
  if (r30 != null) return { restingHR: Math.round(r30), source: 'apple_health_30d' };
  const profile = positiveNumber(input.profileRHR);
  if (profile != null) return { restingHR: Math.round(profile), source: 'user_profile' };
  return { restingHR: FALLBACK_RESTING_HR, source: 'fallback' };
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Build the 5-zone %MHR ladder. Always returns a defined result
 *  (priority chain bottoms out at fallback values). */
export function computeHrZones(input: HRZonesInput): HRZonesResult {
  const { maxHR, source: maxHRSource } = resolveMaxHR(input);
  const { restingHR, source: restingHRSource } = resolveRestingHR(input);
  const mhrBpm = (pct: number) => Math.round(maxHR * pct);

  const zones: HRZone[] = HR_ZONE_BANDS.map((band) => ({
    zone: band.zone,
    label: band.label,
    low: mhrBpm(band.lowPct),
    // Z5 is closed at the actual max HR so a max-effort reading still
    // maps to Z5. Interior zones use the %MHR table directly.
    high: band.zone === 5 ? maxHR : mhrBpm(band.highPct),
  }));

  return {
    method: 'pct_max_hr',
    maxHR,
    restingHR,
    maxHRSource,
    restingHRSource,
    zones,
  };
}

// ── Color + lookup helpers ────────────────────────────────────────────────

export function hrZoneColorHex(zone: number | null | undefined, fallback = '#38BDF8'): string {
  const n = Number(zone);
  if (!Number.isFinite(n)) return fallback;
  // Zones are 1-indexed (Z1..Z5); colors are 0-indexed.
  const idx = Math.max(0, Math.min(HR_ZONE_COLORS.length - 1, Math.round(n) - 1));
  return HR_ZONE_COLORS[idx] ?? fallback;
}

/** Map a bpm value to one of the precomputed zones. Bands are treated
 *  as `[low, high)` half-open so a value sitting exactly on a boundary
 *  belongs to the higher zone (matches Apple/Garmin display behavior).
 *  Z5 is closed on the right. Below-Z1 values snap to Z1; above-MHR
 *  values snap to Z5. */
export function zoneForHeartRate(bpm: number | null | undefined, zones: HRZone[] | null | undefined): HRZone | null {
  const value = Number(bpm);
  if (!Number.isFinite(value) || value <= 0 || !Array.isArray(zones) || zones.length === 0) return null;
  const sorted = zones
    .filter((z) => Number.isFinite(Number(z.zone)) && Number.isFinite(Number(z.low)) && Number.isFinite(Number(z.high)))
    .sort((a, b) => Number(a.zone) - Number(b.zone));
  if (sorted.length === 0) return null;
  const top = sorted[sorted.length - 1];
  if (value >= Number(top.low) && value <= Number(top.high)) return top;
  const match = sorted.find((z) => value >= Number(z.low) && value < Number(z.high));
  if (match) return match;
  if (value < Number(sorted[0].low)) return sorted[0];
  return top;
}

export function hrZoneRangeText(zone: HRZone | null | undefined): string | null {
  if (!zone) return null;
  const low = Math.round(Number(zone.low));
  const high = Math.round(Number(zone.high));
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return `${low}-${high} bpm`;
}

export function liveActivityHrZoneFields(
  bpm: number | null | undefined,
  zones: HRZone[] | null | undefined,
): {
  heartRate?: number;
  hrZone?: number;
  hrZoneLabel?: string;
  hrZoneLow?: number;
  hrZoneHigh?: number;
  hrZoneColorHex?: string;
} {
  const heartRate = Number(bpm);
  if (!Number.isFinite(heartRate) || heartRate <= 0) return {};
  const zone = zoneForHeartRate(heartRate, zones);
  if (!zone) return { heartRate: Math.round(heartRate) };
  return {
    heartRate: Math.round(heartRate),
    hrZone: Math.round(Number(zone.zone)),
    hrZoneLabel: zone.label,
    hrZoneLow: Math.round(Number(zone.low)),
    hrZoneHigh: Math.round(Number(zone.high)),
    hrZoneColorHex: hrZoneColorHex(zone.zone),
  };
}

// ── Internal helpers ───────────────────────────────────────────────────────

function positiveNumber(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
