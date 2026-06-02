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
export type HeightUnit = 'in' | 'cm';

const LBS_PER_KG = 2.2046226218;
const MI_PER_KM = 0.6213711922;
const CM_PER_IN = 2.54;

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
 *  Body weight uses 1 decimal in kg. Pounds stay integer unless the
 *  stored value is a real half-step, so 22.5 lb does not render as 23 lb. */
export function formatWeight(
  lbs: number | null | undefined,
  unit: WeightUnit = 'lbs',
  opts?: { precision?: number; suffix?: boolean },
): string {
  if (lbs == null || !Number.isFinite(lbs)) return '—';
  const value = lbsToUnit(lbs, unit);
  const defaultPrecision = unit === 'kg'
    ? 1
    : (Math.abs(value - Math.round(value)) > 0.001 ? 1 : 0);
  const precision = opts?.precision ?? defaultPrecision;
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

export function resolveHeightUnit(profile: { heightUnit?: HeightUnit | null } | null | undefined): HeightUnit {
  return profile?.heightUnit ?? 'in';
}

// ─── Height ──────────────────────────────────────────────────────────────────
// Canonical storage stays as `heightFeet` + `heightInches` on the profile.
// These helpers convert at input/output time only — the metric user types cm,
// we store ft+in; later the same ft+in renders back as cm for display.

export function feetInchesToCm(feet: number, inches: number): number {
  const ft = Number.isFinite(feet) ? feet : 0;
  const inch = Number.isFinite(inches) ? inches : 0;
  return (ft * 12 + inch) * CM_PER_IN;
}

export function cmToFeetInches(cm: number): { feet: number; inches: number } {
  if (!Number.isFinite(cm) || cm <= 0) return { feet: 0, inches: 0 };
  const totalIn = cm / CM_PER_IN;
  const feet = Math.floor(totalIn / 12);
  const inches = Math.round(totalIn - feet * 12);
  // Rounding can push inches to 12 — fold into the next foot so a metric
  // input never round-trips back as e.g. `5'12"`.
  if (inches === 12) return { feet: feet + 1, inches: 0 };
  return { feet, inches };
}

/** Render canonical feet+inches in the user's chosen height unit.
 *  Imperial: `5'10"`. Metric: `178 cm`. */
export function formatHeight(
  feet: number | null | undefined,
  inches: number | null | undefined,
  unit: HeightUnit = 'in',
  opts?: { suffix?: boolean },
): string {
  const ft = Number.isFinite(feet) ? Number(feet) : 0;
  const inch = Number.isFinite(inches) ? Number(inches) : 0;
  if (ft <= 0 && inch <= 0) return '—';
  if (unit === 'cm') {
    const cm = Math.round(feetInchesToCm(ft, inch));
    return opts?.suffix === false ? `${cm}` : `${cm} cm`;
  }
  return `${ft}'${inch}"`;
}
