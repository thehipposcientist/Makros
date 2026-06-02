// Hydration target helpers. The backend value from `/meals/hydration` is
// authoritative; this client copy keeps local-only previews and reminders
// close to the same shape when the API is unavailable.

export type GenderInput = 'male' | 'female' | 'nonbinary' | 'prefer_not_to_say' | string | null | undefined;

export interface HydrationInputs {
  weightLbs: number;
  /** Today's training minutes — pass MAX(planned, actual completed) so
   *  the bonus survives a heavier-than-planned day. */
  workoutMinutes?: number;
  gender?: GenderInput;
  /** Today's protein consumed (grams). High-protein loads raise water
   *  needs because of nitrogen-clearance kidney work. */
  proteinGToday?: number;
  /** Standard drinks logged today. Net diuretic — adds back the fluid
   *  cost so the user replenishes. */
  alcoholServingsToday?: number;
  isHotDay?: boolean;
}

export const HYDRATION_QUICK_ADD_OUNCES = [8, 16, 24, 32, 40] as const;
// Reminder cadences in hours. 0.5 = every 30 minutes — the slot builder
// works in minutes so sub-hour intervals are first-class.
export const HYDRATION_REMINDER_INTERVAL_HOURS = [0.5, 1, 2, 3, 4] as const;

export type HydrationReminderIntervalHours = typeof HYDRATION_REMINDER_INTERVAL_HOURS[number];

export interface HydrationReminderWindowInput {
  startHour: number;
  endHour: number;
  intervalHours?: number;
}

export function formatHydrationQuickAddLabel(ounces: number): string {
  return `+${Math.round(ounces)} oz`;
}

function finitePositiveNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function roundDownTo(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

function roundUpTo(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

export function hydrationTargetRangeOz(targetOz: number | null | undefined): { min: number; max: number } | null {
  const target = finitePositiveNumber(targetOz);
  if (target == null) return null;
  const midpoint = Math.round(target);
  return {
    min: Math.max(1, Math.min(midpoint, roundDownTo(target * 0.9, 4))),
    max: Math.max(midpoint, roundUpTo(target * 1.1, 4)),
  };
}

export function formatHydrationTargetRange(targetOz: number | null | undefined): string {
  const range = hydrationTargetRangeOz(targetOz);
  if (!range) return '';
  return `${range.min}-${range.max}`;
}

export function normalizeHydrationReminderHour(hour: number, fallback: number = 10): number {
  if (!Number.isFinite(hour)) return fallback;
  return Math.max(0, Math.min(23, Math.round(hour)));
}

export function normalizeHydrationReminderInterval(hours: number | undefined): HydrationReminderIntervalHours {
  const n = Number(hours);
  return (HYDRATION_REMINDER_INTERVAL_HOURS as readonly number[]).includes(n)
    ? (n as HydrationReminderIntervalHours)
    : 2;
}

/** Compact label for a hydration reminder interval — "30m" for the
 *  sub-hour cadence, "2h" for whole hours. */
export function formatHydrationReminderInterval(hours: number): string {
  return hours < 1 ? `${Math.round(hours * 60)}m` : `${hours}h`;
}

export function isHourInHydrationReminderWindow(hour: number, startHour: number, endHour: number): boolean {
  const h = normalizeHydrationReminderHour(hour, 0);
  const start = normalizeHydrationReminderHour(startHour, 10);
  const end = normalizeHydrationReminderHour(endHour, 20);
  if (start === end) return h === start;
  if (start < end) return h >= start && h <= end;
  return h >= start || h <= end;
}

/** Reminder fire times as minutes-since-local-midnight (0–1439). The
 *  daily window (start/end) is hour-granular, but the interval can be
 *  sub-hourly — `intervalHours` 0.5 fires every 30 minutes. Handles a
 *  window that wraps past midnight (start 22:00 → end 06:00). */
export function buildHydrationReminderSlots(input: HydrationReminderWindowInput): number[] {
  const startHour = normalizeHydrationReminderHour(input.startHour, 10);
  const endHour = normalizeHydrationReminderHour(input.endHour, 20);
  const interval = normalizeHydrationReminderInterval(input.intervalHours);
  const stepMin = Math.max(1, Math.round(interval * 60));
  const startMin = startHour * 60;
  const endMin = endHour * 60;
  // Window length in minutes — when start > end the window spans midnight.
  const spanMin = startMin <= endMin ? endMin - startMin : (24 * 60 - startMin) + endMin;
  const slots: number[] = [];
  for (let offset = 0; offset <= spanMin; offset += stepMin) {
    const minute = (startMin + offset) % (24 * 60);
    if (!slots.includes(minute)) slots.push(minute);
  }
  return slots;
}

export function dailyWaterOz(input: HydrationInputs | number, legacyWorkoutMinutes?: number, legacyHot?: boolean, legacyGender?: GenderInput): number {
  // Back-compat: original signature was (weightLbs, workoutMinutes, isHotDay, gender).
  const i: HydrationInputs = typeof input === 'number'
    ? { weightLbs: input, workoutMinutes: legacyWorkoutMinutes, isHotDay: legacyHot, gender: legacyGender }
    : input;

  const g = (i.gender ?? '').toString().toLowerCase();
  // 0.52 oz/lb ≈ 35 ml/kg (men), 0.45 oz/lb ≈ 30 ml/kg (women), 0.48
  // neutral midpoint — aligns the per-lb scaling with IOM total-water
  // guidance (~3.7L men, ~2.7L women) at typical bodyweights.
  const ozPerLb = g === 'male' ? 0.52 : g === 'female' ? 0.45 : 0.48;
  const safeWeight = i.weightLbs > 0 ? i.weightLbs : 150;
  // Floor: 64oz (~2L) — IOM lower bound for healthy adults at rest.
  // Ceiling: 140oz (~4.1L) — guards against dilutional hyponatremia for
  // very heavy users where the linear scaling would otherwise spiral.
  const base = Math.max(64, Math.min(140, safeWeight * ozPerLb));

  // Sweat replacement, capped at +48oz so a 90-min session doesn't push
  // toward overhydration. Beyond 90 min the user should be pairing fluid
  // with electrolytes anyway.
  const workoutMinutes = i.workoutMinutes ?? 0;
  const activityBonus = Math.min(48, Math.max(0, workoutMinutes / 30) * 16);

  // Protein bonus — keyed off today's CONSUMED protein, not target. The
  // recommendation rises as the user logs heavy-protein meals through
  // the day; ahead-of-meals it stays at the resting baseline.
  let proteinBonus = 0;
  const protein = i.proteinGToday ?? 0;
  if (protein > 0 && safeWeight > 0) {
    const perLb = protein / safeWeight;
    if (perLb >= 1.5) proteinBonus = 16;
    else if (perLb >= 1.0) proteinBonus = 8;
  }

  // Alcohol bonus — diuretic. Capped at +36oz; a binge has bigger
  // problems than fluid balance.
  const alcoholBonus = Math.min(36, Math.max(0, i.alcoholServingsToday ?? 0) * 12);

  const heatBonus = i.isHotDay ? 16 : 0;
  return Math.round(base + activityBonus + proteinBonus + alcoholBonus + heatBonus);
}

export function dailyWaterLiters(weightLbs: number, workoutMinutes: number = 0, gender: GenderInput = null): number {
  return Math.round(dailyWaterOz({ weightLbs, workoutMinutes, gender }) * 0.0296 * 10) / 10;
}

export function formatWaterTarget(weightLbs: number, workoutMinutes: number = 0, gender: GenderInput = null): string {
  const oz = dailyWaterOz({ weightLbs, workoutMinutes, gender });
  const L = dailyWaterLiters(weightLbs, workoutMinutes, gender);
  const cups = Math.round(oz / 8);
  return `${oz}oz (${L}L / ~${cups} cups)`;
}
