// Display-layer conversion helpers for body weight + distance.
//
// Storage is always canonical (lbs for weight, miles for distance) — every
// backend column, every analytics computation, every plan-generation input
// stays on the canonical unit so a user toggling display preference never
// triggers a data migration. Formatters here convert at render time only.
//
// Adding kg/km support across the app is staged. The core workout,
// progress, gear, and share surfaces now route their primary displays
// through these helpers; less visible legacy copy can migrate as touched.

export type WeightUnit = 'lbs' | 'kg';
export type DistanceUnit = 'mi' | 'km';

const LBS_PER_KG = 2.2046226218;
const MI_PER_KM = 0.6213711922;

// ─── Weight ──────────────────────────────────────────────────────────────────

/** Convert canonical lbs → display unit. Identity when unit is lbs. */
export function lbsToUnit(lbs: number, unit: WeightUnit): number {
  if (unit === 'kg') return lbs / LBS_PER_KG;
  return lbs;
}

/** Convert a user-entered display-unit value back to canonical lbs.
 *  Use this on every input handler so storage stays consistent regardless
 *  of which unit the user typed in. */
export function unitToLbs(value: number, unit: WeightUnit): number {
  if (unit === 'kg') return value * LBS_PER_KG;
  return value;
}

/** Render a weight in the user's preferred unit with sensible precision.
 *  Body weight uses 1 decimal in kg, integer in lbs (matching common app
 *  conventions). Lifting weight uses integers either way. */
export function formatWeight(
  lbs: number | null | undefined,
  unit: WeightUnit = 'lbs',
  opts?: { precision?: number; suffix?: boolean },
): string {
  if (lbs == null || !Number.isFinite(lbs)) return '—';
  const value = lbsToUnit(lbs, unit);
  const precision = opts?.precision ?? (unit === 'kg' ? 1 : 0);
  const formatted = precision > 0 ? value.toFixed(precision) : Math.round(value).toString();
  if (opts?.suffix === false) return formatted;
  return `${formatted} ${unit}`;
}

/** Suffix only — useful when you've already formatted the number. */
export function weightSuffix(unit: WeightUnit = 'lbs'): string {
  return unit;
}

// ─── Distance ────────────────────────────────────────────────────────────────

/** Convert canonical miles → display unit. Identity when unit is mi. */
export function miToUnit(mi: number, unit: DistanceUnit): number {
  if (unit === 'km') return mi / MI_PER_KM;
  return mi;
}

/** Convert a user-entered display-unit value back to canonical miles. */
export function unitToMi(value: number, unit: DistanceUnit): number {
  if (unit === 'km') return value * MI_PER_KM;
  return value;
}

/** Render a distance in the user's preferred unit. Defaults to 1 decimal
 *  for both units since "5.2 mi" / "8.4 km" reads better than rounding. */
export function formatDistance(
  mi: number | null | undefined,
  unit: DistanceUnit = 'mi',
  opts?: { precision?: number; suffix?: boolean },
): string {
  if (mi == null || !Number.isFinite(mi)) return '—';
  const value = miToUnit(mi, unit);
  const precision = opts?.precision ?? 1;
  const formatted = value.toFixed(precision);
  if (opts?.suffix === false) return formatted;
  return `${formatted} ${unit}`;
}

export function distanceSuffix(unit: DistanceUnit = 'mi'): string {
  return unit;
}

// ─── Profile resolvers ───────────────────────────────────────────────────────
// Tiny convenience wrappers so call sites don't repeat
// `profile?.weightUnit ?? 'lbs'`. Nullable profile because some surfaces
// run before the profile has hydrated.

export function resolveWeightUnit(profile: { weightUnit?: WeightUnit | null } | null | undefined): WeightUnit {
  return profile?.weightUnit ?? 'lbs';
}

export function resolveDistanceUnit(profile: { distanceUnit?: DistanceUnit | null } | null | undefined): DistanceUnit {
  return profile?.distanceUnit ?? 'mi';
}
