// Pure data-shaping helpers used by ProgressScreen.
//
// Extracted so the aggregation logic can be unit-tested without rendering
// the (very large) Progress screen. Every function here takes plain JSON
// shapes (the same payloads the API returns) and returns plain JSON —
// no React, no AsyncStorage, no native modules.
//
// Tests live in `src/screens/__tests__/progressData.test.ts`.

import { categorizeExercise, type LiftCategory } from '../utils/oneRepMax.ts';
import {
  inferChartMuscleFromName,
  inferRelativeStrengthSecondaries,
  isNonStrengthExercise,
  relativeStrengthPrimaryForName,
  shouldExcludeRelativeStrengthSecondary,
} from '../utils/workoutProgressFilters.ts';

export interface MealAveragesShape {
  window_days: number;
  days_with_data: number;
  avg_calories: number;
  avg_calories_when_logged?: number;
  avg_protein_g: number;
  avg_protein_g_when_logged?: number;
  avg_carbs_g: number;
  avg_carbs_g_when_logged?: number;
  avg_fat_g: number;
  avg_fat_g_when_logged?: number;
  avg_meals_per_day: number;
  total_meals_logged: number;
  daily?: Array<{
    date: string;          // YYYY-MM-DD
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    meal_count: number;
  }>;
}

/** Macros headline shown on the Nutrition & Gut Facts card. Honors the
 *  "when logged" companion when present (server returns both). Falls back
 *  to the window-divided average otherwise. */
export function macrosHeadlineFromAverages(m: MealAveragesShape) {
  return {
    calories: m.avg_calories_when_logged ?? m.avg_calories,
    protein:  m.avg_protein_g_when_logged  ?? m.avg_protein_g,
    carbs:    m.avg_carbs_g_when_logged    ?? m.avg_carbs_g,
    fat:      m.avg_fat_g_when_logged      ?? m.avg_fat_g,
  };
}

/** The per-day rows shown under the Macros headline — sorted newest-first
 *  and capped at `limit`. Skipped (no-meal) days are omitted because the
 *  backend's `daily` array already filters those out. */
export function recentLoggedDays(m: MealAveragesShape, limit = 5) {
  const rows = [...(m.daily ?? [])];
  rows.sort((a, b) => b.date.localeCompare(a.date));
  return rows.slice(0, limit);
}

/** Bar denominator for the dailyRows chart. Uses the max of (avg, observed
 *  rows) so above-average days don't all clamp to 100% — the previous bug
 *  was using the avg alone. */
export function dailyBarDenominator(loggedCal: number, dailyRows: Array<{ calories: number }>): number {
  const maxObserved = dailyRows.reduce((acc, r) => Math.max(acc, r.calories), 0);
  return Math.max(loggedCal, maxObserved, 1);
}

// ─── Direct re-derivation from meal history ────────────────────────────
//
// `mealAverages.daily` is the backend's per-day rollup. Users repeatedly
// reported the daily numbers looking "way off" vs what they see on the
// meal tab — usually because the two surfaces went through slightly
// different aggregation paths (dedupe windows, skip filters). To remove
// any chance of drift, the screen now optionally re-derives the rows
// client-side from the SAME `getMealHistory` payload the meal tab
// renders. If the history is loaded, we trust it. Otherwise we fall back
// to mealAverages.daily.

export interface MealHistoryItemShape {
  food_name: string;
  quantity: number;
  unit: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

export interface MealHistoryEntryShape {
  id: number;
  meal_date: string;        // YYYY-MM-DD
  meal_type: string | null;
  name: string;
  source: string | null;
  consumed_at?: string | null;
  created_at?: string | null;
  items: MealHistoryItemShape[];
  totals: { calories: number; protein_g: number; carbs_g: number; fat_g: number };
}

export interface DailyRowShape {
  date: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  meal_count: number;
}

export function macrosHeadlineFromDailyRows(rows: DailyRowShape[]) {
  if (rows.length === 0) return null;
  const totals = rows.reduce(
    (acc, row) => ({
      calories: acc.calories + Number(row.calories ?? 0),
      protein: acc.protein + Number(row.protein_g ?? 0),
      carbs: acc.carbs + Number(row.carbs_g ?? 0),
      fat: acc.fat + Number(row.fat_g ?? 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
  const denom = rows.length;
  return {
    calories: totals.calories / denom,
    protein: totals.protein / denom,
    carbs: totals.carbs / denom,
    fat: totals.fat / denom,
  };
}

/** Aggregate per-day totals straight from meal history. Mirrors the
 *  meal-tab math exactly so the user sees one set of numbers across both
 *  surfaces. Returns rows newest-first, only days with at least one meal. */
export function aggregateDailyFromHistory(history: MealHistoryEntryShape[]): DailyRowShape[] {
  const byDate = new Map<string, DailyRowShape>();
  for (const m of history) {
    const date = m.meal_date;
    if (!date) continue;
    const cur = byDate.get(date) ?? { date, calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, meal_count: 0 };
    // Trust meal.totals — that's the value the meal tab shows for the meal.
    cur.calories += Number(m.totals?.calories ?? 0);
    cur.protein_g += Number(m.totals?.protein_g ?? 0);
    cur.carbs_g += Number(m.totals?.carbs_g ?? 0);
    cur.fat_g += Number(m.totals?.fat_g ?? 0);
    cur.meal_count += 1;
    byDate.set(date, cur);
  }
  // Round to 1 decimal so the rendered numbers don't show 2049.99999…
  const rows = Array.from(byDate.values()).map(r => ({
    ...r,
    calories: Math.round(r.calories * 10) / 10,
    protein_g: Math.round(r.protein_g * 10) / 10,
    carbs_g: Math.round(r.carbs_g * 10) / 10,
    fat_g: Math.round(r.fat_g * 10) / 10,
  }));
  rows.sort((a, b) => b.date.localeCompare(a.date));
  return rows;
}

/** Pick the most reliable daily-row source. Prefer client-aggregated
 *  history (proven to match the meal tab); fall back to the server-rolled
 *  averages.daily only when history isn't loaded yet. */
export function selectDailyRows(
  history: MealHistoryEntryShape[] | null | undefined,
  averagesDaily: DailyRowShape[] | undefined,
  limit = 5,
): DailyRowShape[] {
  if (history != null) {
    return aggregateDailyFromHistory(history).slice(0, limit);
  }
  const rows = [...(averagesDaily ?? [])];
  rows.sort((a, b) => b.date.localeCompare(a.date));
  return rows.slice(0, limit);
}

export interface CardioHrZoneSourceShape {
  id?: string | number | null;
  date?: string | null;
  workout_date?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  ended_at?: string | null;
  focus?: string | null;
  focus_label?: string | null;
  stimulus?: string | null;
  sourceContext?: string | null;
  source_context?: string | null;
  activityCategory?: string | null;
  activity_category?: string | null;
  activitySubtype?: string | null;
  activity_subtype?: string | null;
  cardioStyle?: string | null;
  cardio_style?: string | null;
  activitySource?: string | null;
  activity_source?: string | null;
  importSource?: string | null;
  import_source?: string | null;
  distanceMiles?: number | null;
  distance_miles?: number | null;
  durationSeconds?: number | null;
  duration_seconds?: number | null;
  hrZoneMinutes?: number[] | null;
  hr_zone_minutes?: number[] | null;
  hr_summary?: { zoneMinutes?: number[] | null } | null;
  routeCoords?: unknown[] | null;
  route_coords?: unknown[] | null;
}

const CARDIO_TEXT_RE = /\b(cardio|conditioning|zone\s*2|interval|hiit|run|running|jog|jogging|bike|biking|cycling|cycle|ride|row|rowing|swim|swimming|elliptical|stair|hike|hiking|walk|walking|tempo|sprint|endurance|aerobic)\b/;

function normalizedText(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function positiveNumber(value: unknown): boolean {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

/** Predicate for Progress cardio HR-zone aggregates. Explicit
 *  activity_category wins: only `cardio` rows count. Older rows that
 *  predate category metadata can still count when their focus/metrics
 *  clearly indicate cardio. */
export function isCardioHrZoneSource(source: CardioHrZoneSourceShape): boolean {
  const activityCategory = normalizedText(source.activityCategory ?? source.activity_category);
  if (activityCategory) return activityCategory === 'cardio';

  const sourceContext = normalizedText(source.sourceContext ?? source.source_context);
  if (sourceContext === 'custom_cardio') return true;

  const cardioStyle = normalizedText(source.cardioStyle ?? source.cardio_style);
  if (cardioStyle && cardioStyle !== 'recovery') return true;

  if (positiveNumber(source.distanceMiles ?? source.distance_miles)) return true;

  const routeCoords = source.routeCoords ?? source.route_coords;
  if (Array.isArray(routeCoords) && routeCoords.length > 0) return true;

  const text = [
    source.focus ?? source.focus_label,
    source.stimulus,
    source.activitySubtype ?? source.activity_subtype,
  ].map(normalizedText).filter(Boolean).join(' ');

  return CARDIO_TEXT_RE.test(text);
}

export type HrZoneMinutesTuple = [number, number, number, number, number];

export interface HrZoneSourceContributor {
  id: string;
  name: string;
  date: string;
  sourceLabel: string;
  durationMin: number | null;
  minutes: number;
}

export interface HrZoneSourceBreakdown {
  zoneMinutes: HrZoneMinutesTuple;
  contributors: [
    HrZoneSourceContributor[],
    HrZoneSourceContributor[],
    HrZoneSourceContributor[],
    HrZoneSourceContributor[],
    HrZoneSourceContributor[],
  ];
}

export function normalizeHrZoneMinutes(raw: unknown): HrZoneMinutesTuple {
  const source = Array.isArray(raw) ? raw : [];
  const zones = source.slice(0, 5).map(value => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  while (zones.length < 5) zones.push(0);
  return zones as HrZoneMinutesTuple;
}

function hrZoneMinutesFromSource(source: CardioHrZoneSourceShape): HrZoneMinutesTuple {
  return normalizeHrZoneMinutes(
    source.hrZoneMinutes
      ?? source.hr_zone_minutes
      ?? source.hr_summary?.zoneMinutes,
  );
}

function sourceDateKey(source: CardioHrZoneSourceShape): string | null {
  return dateKeyFromRaw(
    source.date
      ?? source.workout_date
      ?? source.started_at
      ?? source.completed_at
      ?? source.ended_at,
  );
}

function sourceDisplayName(source: CardioHrZoneSourceShape): string {
  const name = String(
    source.focus
      ?? source.focus_label
      ?? source.activitySubtype
      ?? source.activity_subtype
      ?? 'Workout',
  ).trim();
  return name || 'Workout';
}

function prettySourceToken(raw: string): string {
  const token = raw.trim();
  if (!token) return '';
  return token
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase())
    .replace(/\bIos\b/g, 'iOS')
    .replace(/\bAi\b/g, 'AI')
    .replace(/\bHr\b/g, 'HR');
}

export function hrZoneSourceLabel(source: CardioHrZoneSourceShape): string {
  const importSource = String(source.importSource ?? source.import_source ?? '').trim();
  if (importSource) return prettySourceToken(importSource);

  const activitySource = normalizedText(source.activitySource ?? source.activity_source);
  const sourceContext = normalizedText(source.sourceContext ?? source.source_context);
  const sourceKey = activitySource || sourceContext;
  if (sourceKey === 'apple_health') return 'Apple Health';
  if (sourceKey === 'watch') return 'Watch';
  if (sourceKey === 'live_tracker') return 'Live tracker';
  if (sourceKey === 'manual' || sourceKey === 'manual_activity') return 'Manual log';
  if (sourceKey === 'coach_log') return 'Coach log';
  if (sourceKey === 'planned') return 'Planned workout';
  if (sourceKey === 'saved_template') return 'Saved template';
  if (sourceKey === 'custom_cardio') return 'Custom cardio';
  if (sourceKey === 'custom_strength') return 'Custom strength';
  return 'Thallo';
}

function sourceDurationMinutes(source: CardioHrZoneSourceShape): number | null {
  const seconds = Number(source.durationSeconds ?? source.duration_seconds);
  if (Number.isFinite(seconds) && seconds > 0) return seconds / 60;
  return null;
}

export function buildHrZoneSourceBreakdown(
  sources: CardioHrZoneSourceShape[],
  startDate: string,
  endDate: string,
  options: { cardioOnly?: boolean } = {},
): HrZoneSourceBreakdown {
  const zoneMinutes = normalizeHrZoneMinutes(null);
  const contributors: HrZoneSourceBreakdown['contributors'] = [[], [], [], [], []];

  sources.forEach((source, index) => {
    const date = sourceDateKey(source);
    if (!date || !dateKeyInWindow(date, startDate, endDate)) return;
    if (options.cardioOnly && !isCardioHrZoneSource(source)) return;
    const zones = hrZoneMinutesFromSource(source);
    if (!zones.some(min => min > 0)) return;
    const sourceId = source.id != null ? String(source.id) : `${date}-${sourceDisplayName(source)}-${index}`;
    zones.forEach((minutes, zoneIndex) => {
      if (minutes <= 0) return;
      zoneMinutes[zoneIndex] += minutes;
      contributors[zoneIndex].push({
        id: `${sourceId}-z${zoneIndex + 1}`,
        name: sourceDisplayName(source),
        date,
        sourceLabel: hrZoneSourceLabel(source),
        durationMin: sourceDurationMinutes(source),
        minutes,
      });
    });
  });

  contributors.forEach(list => list.sort((a, b) => b.minutes - a.minutes));
  return { zoneMinutes, contributors };
}

export interface StrengthVolumeSetShape {
  reps?: number | null;
  actualReps?: number | null;
  actual_reps?: number | null;
  weightLbs?: number | null;
  weight_lbs?: number | null;
  actualWeightLbs?: number | null;
  actual_weight_lbs?: number | null;
  rir?: number | null;
  actualRir?: number | null;
  actual_rir?: number | null;
  rpe?: number | null;
  setType?: string | null;
  set_type?: string | null;
}

export interface StrengthVolumeExerciseShape {
  name?: string | null;
  primaryMuscle?: string | null;
  primary_muscle?: string | null;
  secondaryMuscles?: string[] | null;
  secondary_muscles?: string[] | null;
  slotRole?: string | null;
  slot_role?: string | null;
  prescriptionType?: string | null;
  prescription_type?: string | null;
  exerciseType?: string | null;
  exercise_type?: string | null;
  movementPattern?: string | null;
  movement_pattern?: string | null;
  flowCategory?: string | null;
  flow_category?: string | null;
  sets?: StrengthVolumeSetShape[] | null;
}

export interface StrengthVolumeSessionShape {
  id?: string | number | null;
  date?: string | null;
  completed?: boolean | null;
  skipped?: boolean | null;
  exercises?: StrengthVolumeExerciseShape[] | null;
}

export interface StrengthVolumeWindowSummary {
  startDate: string;
  endDate: string;
  volumeLbs: number;
  loadedSets: number;
  sessionCount: number;
}

export type StrengthLoadBalanceStatus =
  | 'no_data'
  | 'low'
  | 'balanced'
  | 'high'
  | 'spike';

export interface StrengthLoadMuscleSummary {
  muscle: string;
  currentSets: number;
  previousSets: number;
  baselineSets: number;
  primarySets: number;
  secondarySets: number;
  currentVolumeLbs: number;
  previousVolumeLbs: number;
  targetMin: number;
  targetMax: number;
  deltaSets: number;
  deltaPct: number | null;
  spikeRatio: number;
  status: StrengthLoadBalanceStatus;
  score: number;
}

export interface StrengthLoadBalanceSummary {
  current: StrengthVolumeWindowSummary;
  previous: StrengthVolumeWindowSummary | null;
  weeks: StrengthVolumeWindowSummary[];
  muscles: StrengthLoadMuscleSummary[];
  score: number | null;
  label: string;
  status: StrengthLoadBalanceStatus;
  detail: string;
  activeMuscleCount: number;
  inRangeMuscleCount: number;
  lowMuscles: StrengthLoadMuscleSummary[];
  highMuscles: StrengthLoadMuscleSummary[];
  spikeMuscles: StrengthLoadMuscleSummary[];
  topMuscles: StrengthLoadMuscleSummary[];
  windowDays: number;
}

export type StrengthVolumeComparison =
  | 'percent'
  | 'absolute'
  | 'insufficient_previous'
  | 'no_previous';

export interface StrengthVolumeTrendBreakdown {
  weeks: StrengthVolumeWindowSummary[];
  current: StrengthVolumeWindowSummary;
  previous: StrengthVolumeWindowSummary | null;
  deltaPct: number | null;
  deltaLbs: number | null;
  comparison: StrengthVolumeComparison;
  windowDays: number;
  weekCount: number;
  bucketMode: 'fixed_week' | 'rolling';
  elapsedDays: number;
}

const NON_STRENGTH_VOLUME_PRIMARY_MUSCLES = new Set([
  'cardio',
  'mobility',
  'recovery',
  'stretch',
  'systemic',
]);

const NON_STRENGTH_VOLUME_TAGS = new Set([
  'cardio',
  'conditioning',
  'mobility',
  'recovery',
  'stretch',
  'warmup',
]);

const NON_STRENGTH_VOLUME_NAME_RE = /treadmill|stationary bike|elliptical|rowing machine|stair climber|assault bike|battle rope|jump rope|sprint|jogging|running|cycling|swimming|hiit|intervals|mountain climber|hill sprint|cardio|zone.?2|tempo (run|ride|bike|row|swim)|boxing|kickboxing|martial.?arts|mma|bag.?work|shadow.?box|yoga|vinyasa|pilates|mobility|stretch|foam.?roll|recovery flow|sun.?salutation|downward.?dog|cobra flow|child.?s pose|seated forward fold|spinal twist|couch stretch|deep squat hold|90\/90|cat.?cow|thread.?the.?needle|dead hang|wall sit|hollow.?hold|plank|burpee/i;

const STRENGTH_LOAD_TARGET_RANGES: Record<string, [number, number]> = {
  chest: [8, 18],
  back: [10, 20],
  shoulders: [8, 16],
  biceps: [6, 14],
  triceps: [6, 14],
  quads: [8, 18],
  hamstrings: [6, 14],
  glutes: [6, 14],
  calves: [4, 12],
  core: [4, 12],
};

const STRENGTH_LOAD_MUSCLE_ALIASES: Record<string, string> = {
  abs: 'core',
  abdominals: 'core',
  obliques: 'core',
  lats: 'back',
  traps: 'back',
  upper_back: 'back',
  upperback: 'back',
  forearms: 'biceps',
  adductors: 'quads',
  abductors: 'glutes',
};

const WARMUP_SET_TYPES = new Set(['warmup', 'warm_up', 'mobility', 'recovery', 'technique']);

function dateKeyFromDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dateKeyFromRaw(raw: unknown): string | null {
  if (raw instanceof Date) return dateKeyFromDate(raw);
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const match = text.match(/\d{4}-\d{2}-\d{2}/);
  if (match) return match[0];
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : dateKeyFromDate(parsed);
}

function parseDateKeyMs(key: string): number {
  const parts = key.split('-').map(Number);
  if (parts.length !== 3 || parts.some(part => !Number.isFinite(part))) return 0;
  return Date.UTC(parts[0], parts[1] - 1, parts[2]);
}

function shiftDateKey(key: string, days: number): string {
  const shifted = new Date(parseDateKeyMs(key));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function dateKeyInWindow(key: string, startDate: string, endDate: string): boolean {
  const ms = parseDateKeyMs(key);
  return ms >= parseDateKeyMs(startDate) && ms <= parseDateKeyMs(endDate);
}

function daySpanInclusive(startDate: string, endDate: string): number {
  const startMs = parseDateKeyMs(startDate);
  const endMs = parseDateKeyMs(endDate);
  if (!startMs || !endMs || endMs < startMs) return 1;
  return Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);
}

function minDateKey(a: string, b: string): string {
  return parseDateKeyMs(a) <= parseDateKeyMs(b) ? a : b;
}

function maxDateKey(a: string, b: string): string {
  return parseDateKeyMs(a) >= parseDateKeyMs(b) ? a : b;
}

function startOfCalendarWeekKey(today: string): string {
  const d = new Date(parseDateKeyMs(today));
  const day = d.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + mondayOffset);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export type RelativeStrengthSource = 'primary' | 'secondary' | 'rolling';

export type RelativeStrengthProfile = {
  muscle: string;
  exercise: string;
  score: number;
  estimatedStrengthLbs: number;
  ratio: number;
  targetRatio: number;
  source: RelativeStrengthSource;
  date: string | null;
  sampleCount: number;
  contributionPct?: number;
  contributingExercises?: number;
};

const RELATIVE_STRENGTH_TARGETS: Record<string, number> = {
  chest: 1.25,
  back: 1.05,
  shoulders: 0.72,
  biceps: 0.30,
  triceps: 0.42,
  quads: 1.45,
  hamstrings: 1.15,
  glutes: 1.25,
  calves: 0.65,
  core: 0.55,
};

const RELATIVE_STRENGTH_FEMALE_FACTORS: Record<string, number> = {
  chest: 0.62, back: 0.65, shoulders: 0.65, biceps: 0.65, triceps: 0.65,
  quads: 0.72, hamstrings: 0.72, glutes: 0.72, calves: 0.72, core: 0.70,
};

function relativeStrengthTargets(sex: string | null | undefined): Record<string, number> {
  if (String(sex ?? '').trim().toLowerCase() !== 'female') return RELATIVE_STRENGTH_TARGETS;
  const out: Record<string, number> = {};
  for (const [muscle, target] of Object.entries(RELATIVE_STRENGTH_TARGETS)) {
    out[muscle] = Math.round(target * (RELATIVE_STRENGTH_FEMALE_FACTORS[muscle] ?? 0.67) * 100) / 100;
  }
  return out;
}

const DEFAULT_SECONDARY_CONTRIBUTION = 0.24;

const RELATIVE_STRENGTH_ALIASES: Record<string, string> = {
  abs: 'core',
  abdominals: 'core',
  obliques: 'core',
  lats: 'back',
  traps: 'back',
  upper_back: 'back',
  upperback: 'back',
  rear_delt: 'shoulders',
  rear_delts: 'shoulders',
  delts: 'shoulders',
  hamstring: 'hamstrings',
  quad: 'quads',
  bicep: 'biceps',
  tricep: 'triceps',
};

function canonicalRelativeStrengthMuscle(raw: unknown): string | null {
  const key = String(raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!key) return null;
  if (RELATIVE_STRENGTH_TARGETS[key] != null) return key;
  return RELATIVE_STRENGTH_ALIASES[key] ?? null;
}

function relativeStrengthSetEstimate(set: StrengthVolumeSetShape, category: LiftCategory): number | null {
  // Isolation loads are useful progress data, but not stable 1RM inputs for this bodyweight-relative profile.
  if (category === 'isolation') return null;
  const weight = Number(set?.weightLbs ?? set?.weight_lbs ?? set?.actualWeightLbs ?? set?.actual_weight_lbs);
  const reps = Number(set?.reps ?? set?.actualReps ?? set?.actual_reps);
  if (!Number.isFinite(weight) || weight <= 0 || !Number.isFinite(reps) || reps <= 0 || reps > 20) return null;
  const rirRaw = Number(set?.rir ?? set?.actualRir ?? set?.actual_rir);
  const rir = Number.isFinite(rirRaw) && rirRaw > 0 ? rirRaw : 0;
  const cap = category === 'main_compound' ? 10 : 12;
  const effectiveReps = Math.min(reps + rir, cap);
  return Math.round((weight * (1 + effectiveReps / 30)) * 10) / 10;
}

function clampRelativeStrengthScore(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function buildRelativeStrengthProfiles(
  history: StrengthVolumeSessionShape[],
  bodyweightLbs: number | null | undefined,
  options: {
    today?: string | Date | null;
    bulkE1RMMap?: Record<string, number> | null;
    showcase?: Array<{ name: string; oneRepMaxLbs: number }> | null;
    sex?: string | null;
  } = {},
): RelativeStrengthProfile[] {
  const bw = Number(bodyweightLbs);
  if (!Number.isFinite(bw) || bw <= 0) return [];
  const targets = relativeStrengthTargets(options.sex);
  const today = dateKeyFromRaw(options.today ?? new Date()) ?? dateKeyFromDate(new Date());
  const start = shiftDateKey(today, -29);
  const candidatesByMuscle = new Map<string, RelativeStrengthProfile[]>();

  const consider = (candidate: Omit<RelativeStrengthProfile, 'score' | 'ratio'>) => {
    const targetRatio = targets[candidate.muscle];
    if (!targetRatio || candidate.estimatedStrengthLbs <= 0) return;
    const ratio = candidate.estimatedStrengthLbs / bw;
    const rawScore = clampRelativeStrengthScore((ratio / targetRatio) * 70);
    if (rawScore == null) return;
    const score = candidate.source === 'secondary' ? Math.min(82, rawScore) : rawScore;
    const next: RelativeStrengthProfile = {
      ...candidate,
      targetRatio,
      score,
      ratio: Math.round(ratio * 100) / 100,
    };
    const arr = candidatesByMuscle.get(next.muscle);
    if (arr) {
      arr.push(next);
    } else {
      candidatesByMuscle.set(next.muscle, [next]);
    }
  };

  for (const session of history) {
    if (!session.completed || session.skipped) continue;
    const sessionDate = dateKeyFromRaw(session.date);
    if (!sessionDate || !dateKeyInWindow(sessionDate, start, today)) continue;
    for (const exercise of session.exercises ?? []) {
      if (isNonStrengthExercise(exercise as any)) continue;
      const category = categorizeExercise({
        isCompound: (exercise as any).isCompound ?? (exercise as any).is_compound ?? null,
        isMachine: (exercise as any).isMachine ?? (exercise as any).is_machine ?? null,
        name: exercise.name,
      });
      const primary = relativeStrengthPrimaryForName(exercise.name, canonicalRelativeStrengthMuscle(
        (exercise as any).primaryMuscle
        ?? (exercise as any).primary_muscle
        ?? inferChartMuscleFromName(String(exercise.name ?? '')),
      ));
      const rawSecondaryCamel = (exercise as any).secondaryMuscles;
      const rawSecondarySnake = (exercise as any).secondary_muscles;
      const explicitSecondaries = [
        ...(Array.isArray(rawSecondaryCamel) ? rawSecondaryCamel : []),
        ...(Array.isArray(rawSecondarySnake) ? rawSecondarySnake : []),
      ]
        .map(canonicalRelativeStrengthMuscle)
        .filter((muscle): muscle is string => (
          !!muscle
          && muscle !== primary
          && !shouldExcludeRelativeStrengthSecondary(exercise.name, muscle)
        ));
      const secondaries = explicitSecondaries.length > 0
        ? Array.from(new Set(explicitSecondaries))
        : inferRelativeStrengthSecondaries(exercise.name, primary);

      let bestSetEstimate: number | null = null;
      let sampleCount = 0;
      for (const set of exercise.sets ?? []) {
        const estimate = relativeStrengthSetEstimate(set, category);
        if (estimate == null) continue;
        sampleCount += 1;
        if (bestSetEstimate == null || estimate > bestSetEstimate) bestSetEstimate = estimate;
      }
      if (bestSetEstimate == null) continue;
      if (primary) {
        consider({
          muscle: primary,
          exercise: String(exercise.name ?? '').trim(),
          estimatedStrengthLbs: bestSetEstimate,
          targetRatio: targets[primary],
          source: 'primary',
          date: sessionDate,
          sampleCount,
        });
      }
      const primaryTarget = primary ? targets[primary] : null;
      for (const muscle of secondaries) {
        const muscleTarget = targets[muscle];
        const contribution = primaryTarget && muscleTarget
          ? Math.min(1, muscleTarget / primaryTarget)
          : DEFAULT_SECONDARY_CONTRIBUTION;
        consider({
          muscle,
          exercise: String(exercise.name ?? '').trim(),
          estimatedStrengthLbs: Math.round(bestSetEstimate * contribution * 10) / 10,
          targetRatio: muscleTarget,
          source: 'secondary',
          date: sessionDate,
          sampleCount,
          contributionPct: Math.round(contribution * 100),
        });
      }
    }
  }

  const addRolling = (name: string, lbs: number) => {
    if (!Number.isFinite(lbs) || lbs <= 0) return;
    if (categorizeExercise({ name }) === 'isolation') return;
    const muscle = canonicalRelativeStrengthMuscle(inferChartMuscleFromName(name));
    if (!muscle) return;
    const existing = candidatesByMuscle.get(muscle) ?? [];
    if (existing.some(c => c.source === 'primary')) return;
    consider({
      muscle,
      exercise: name,
      estimatedStrengthLbs: Math.round(lbs),
      targetRatio: targets[muscle],
      source: 'rolling',
      date: null,
      sampleCount: 0,
    });
  };

  for (const [name, lbs] of Object.entries(options.bulkE1RMMap ?? {})) {
    addRolling(name, Number(lbs));
  }
  for (const lift of options.showcase ?? []) {
    addRolling(lift.name, Number(lift.oneRepMaxLbs));
  }

  const sourceRank: Record<RelativeStrengthSource, number> = {
    primary: 2,
    rolling: 1,
    secondary: 0,
  };
  const out: RelativeStrengthProfile[] = [];
  for (const candidates of candidatesByMuscle.values()) {
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => {
      const scoreDelta = b.score - a.score;
      if (Math.abs(scoreDelta) > 1) return scoreDelta;
      const sourceDelta = sourceRank[b.source] - sourceRank[a.source];
      if (sourceDelta !== 0) return sourceDelta;
      return scoreDelta || b.estimatedStrengthLbs - a.estimatedStrengthLbs;
    });
    const top = candidates[0];
    const primaries = candidates.filter(c => c.source === 'primary');
    const distinctContributors = new Set(candidates.map(c => c.exercise.toLowerCase().trim()).filter(Boolean)).size;
    const distinctPrimary = new Set(primaries.map(c => c.exercise.toLowerCase().trim()).filter(Boolean)).size;
    let blendedScore = top.score;
    if (top.source === 'primary' && distinctPrimary >= 2 && primaries.length >= 2) {
      const second = primaries[1];
      const closeness = top.score > 0 ? Math.min(1, second.score / top.score) : 0;
      const bonus = Math.round(closeness * 5);
      blendedScore = Math.min(100, top.score + bonus);
    }
    out.push({
      ...top,
      score: blendedScore,
      contributingExercises: distinctContributors,
    });
  }
  return out;
}

function finitePositiveNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function strengthSetReps(set: StrengthVolumeSetShape): number {
  return finitePositiveNumber(set.reps ?? set.actualReps ?? set.actual_reps);
}

function strengthSetVolumeLbs(set: StrengthVolumeSetShape): number {
  const reps = strengthSetReps(set);
  const weight = finitePositiveNumber(set.weightLbs ?? set.weight_lbs ?? set.actualWeightLbs ?? set.actual_weight_lbs);
  return reps > 0 && weight > 0 ? reps * weight : 0;
}

function numericOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function canonicalStrengthLoadMuscle(raw: unknown): string | null {
  const text = normalizedText(raw);
  if (!text) return null;
  if (STRENGTH_LOAD_TARGET_RANGES[text]) return text;
  return STRENGTH_LOAD_MUSCLE_ALIASES[text] ?? null;
}

function inferStrengthLoadMuscleFromName(name: unknown): string | null {
  const n = String(name ?? '').toLowerCase();
  if (NON_STRENGTH_VOLUME_NAME_RE.test(n)) return null;
  if (/bench|push.?up|chest|pec|fly/.test(n)) return 'chest';
  if (/row|pulldown|pull.?up|chin.?up|lat|deadlift|trap/.test(n)) return 'back';
  if (/shoulder|overhead|ohp|lateral raise|rear delt|face pull/.test(n)) return 'shoulders';
  if (/curl|bicep/.test(n)) return 'biceps';
  if (/tricep|dip|skull/.test(n)) return 'triceps';
  if (/squat|leg press|lunge|split squat|step.?up|extension/.test(n)) return 'quads';
  if (/romanian|rdl|hamstring|leg curl|good morning/.test(n)) return 'hamstrings';
  if (/hip thrust|glute|kickback|bridge/.test(n)) return 'glutes';
  if (/calf/.test(n)) return 'calves';
  if (/\babs?\b|crunch|plank|\bcore\b|russian twist|leg raise|sit.?up|hollow|knee raise|woodchopper/.test(n)) return 'core';
  return null;
}

function inferSecondaryStrengthLoadMusclesFromName(name: unknown, primary: string | null): string[] {
  const n = String(name ?? '').toLowerCase();
  if (NON_STRENGTH_VOLUME_NAME_RE.test(n)) return [];
  const out: string[] = [];
  const add = (muscle: string) => {
    if (muscle !== primary && !out.includes(muscle)) out.push(muscle);
  };
  if (/bench|push.?up|chest|pec|fly/.test(n)) {
    add('triceps');
    add('shoulders');
  }
  if (/row|pulldown|pull.?up|chin.?up|lat/.test(n)) {
    add('biceps');
  }
  if (/shoulder press|overhead|ohp|military press|pike push/.test(n)) {
    add('triceps');
  }
  if (/squat|leg press|lunge|split squat|step.?up/.test(n)) {
    add('glutes');
  }
  if (/deadlift|romanian|rdl|hamstring|leg curl|good morning/.test(n)) {
    add('hamstrings');
    add('glutes');
    add('back');
  }
  return out;
}

function primaryStrengthLoadMuscle(exercise: StrengthVolumeExerciseShape): string | null {
  return canonicalStrengthLoadMuscle(exercise.primaryMuscle ?? exercise.primary_muscle)
    ?? inferStrengthLoadMuscleFromName(exercise.name);
}

function secondaryStrengthLoadMuscles(exercise: StrengthVolumeExerciseShape, primary: string | null): string[] {
  const raw = exercise.secondaryMuscles ?? exercise.secondary_muscles ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const muscle = canonicalStrengthLoadMuscle(item);
    if (!muscle || muscle === primary || seen.has(muscle)) continue;
    seen.add(muscle);
    out.push(muscle);
  }
  if (out.length === 0) {
    for (const muscle of inferSecondaryStrengthLoadMusclesFromName(exercise.name, primary)) {
      if (seen.has(muscle)) continue;
      seen.add(muscle);
      out.push(muscle);
    }
  }
  return out;
}

function isCountableStrengthLoadSet(set: StrengthVolumeSetShape): boolean {
  if (strengthSetReps(set) <= 0) return false;
  const setType = normalizedText(set.setType ?? set.set_type);
  if (WARMUP_SET_TYPES.has(setType)) return false;

  const rir = numericOrNull(set.rir ?? set.actualRir ?? set.actual_rir);
  if (rir != null) return rir <= 4;
  const rpe = numericOrNull(set.rpe);
  if (rpe != null) return rpe >= 6;
  return true;
}

function isLoadedStrengthVolumeSet(set: StrengthVolumeSetShape): boolean {
  if (strengthSetVolumeLbs(set) <= 0) return false;
  const setType = normalizedText(set.setType ?? set.set_type);
  return !WARMUP_SET_TYPES.has(setType);
}

function isNonStrengthVolumeExercise(exercise: StrengthVolumeExerciseShape): boolean {
  const primary = normalizedText(exercise.primaryMuscle ?? exercise.primary_muscle);
  if (NON_STRENGTH_VOLUME_PRIMARY_MUSCLES.has(primary)) return true;
  const tags = [
    exercise.slotRole,
    exercise.slot_role,
    exercise.prescriptionType,
    exercise.prescription_type,
    exercise.exerciseType,
    exercise.exercise_type,
    exercise.movementPattern,
    exercise.movement_pattern,
    exercise.flowCategory,
    exercise.flow_category,
  ].map(normalizedText);
  if (tags.some(tag => NON_STRENGTH_VOLUME_TAGS.has(tag))) return true;
  return NON_STRENGTH_VOLUME_NAME_RE.test(String(exercise.name ?? ''));
}

function sessionStrengthVolume(session: StrengthVolumeSessionShape): { volumeLbs: number; loadedSets: number } {
  let volumeLbs = 0;
  let loadedSets = 0;
  for (const exercise of session.exercises ?? []) {
    if (isNonStrengthVolumeExercise(exercise)) continue;
    for (const set of exercise.sets ?? []) {
      const setVolume = strengthSetVolumeLbs(set);
      if (!isLoadedStrengthVolumeSet(set)) continue;
      volumeLbs += setVolume;
      loadedSets += 1;
    }
  }
  return {
    volumeLbs: Math.round(volumeLbs),
    loadedSets,
  };
}

type MuscleLoadAccumulator = {
  primarySets: number;
  secondarySets: number;
  totalSets: number;
  volumeLbs: number;
};

type StrengthLoadWindowSummary = StrengthVolumeWindowSummary & {
  byMuscle: Record<string, MuscleLoadAccumulator>;
};

function emptyStrengthLoadWindow(startDate: string, endDate: string): StrengthLoadWindowSummary {
  return {
    startDate,
    endDate,
    volumeLbs: 0,
    loadedSets: 0,
    sessionCount: 0,
    byMuscle: {},
  };
}

function addMuscleLoad(
  target: Record<string, MuscleLoadAccumulator>,
  muscle: string,
  credit: number,
  volumeLbs: number,
  primary: boolean,
) {
  const cur = target[muscle] ?? { primarySets: 0, secondarySets: 0, totalSets: 0, volumeLbs: 0 };
  if (primary) cur.primarySets += credit;
  else cur.secondarySets += credit;
  cur.totalSets += credit;
  cur.volumeLbs += volumeLbs * credit;
  target[muscle] = cur;
}

function sessionStrengthLoad(session: StrengthVolumeSessionShape): {
  volumeLbs: number;
  loadedSets: number;
  byMuscle: Record<string, MuscleLoadAccumulator>;
} {
  let volumeLbs = 0;
  let loadedSets = 0;
  const byMuscle: Record<string, MuscleLoadAccumulator> = {};

  for (const exercise of session.exercises ?? []) {
    if (isNonStrengthVolumeExercise(exercise)) continue;
    const primary = primaryStrengthLoadMuscle(exercise);
    const secondaries = secondaryStrengthLoadMuscles(exercise, primary);
    for (const set of exercise.sets ?? []) {
      if (!isCountableStrengthLoadSet(set)) continue;
      const setVolume = strengthSetVolumeLbs(set);
      volumeLbs += setVolume;
      loadedSets += 1;
      if (primary) addMuscleLoad(byMuscle, primary, 1, setVolume, true);
      for (const secondary of secondaries) {
        addMuscleLoad(byMuscle, secondary, 0.5, setVolume, false);
      }
    }
  }

  return {
    volumeLbs: Math.round(volumeLbs),
    loadedSets,
    byMuscle,
  };
}

function strengthLoadForWindow(
  history: StrengthVolumeSessionShape[],
  startDate: string,
  endDate: string,
): StrengthLoadWindowSummary {
  const sessionKeys = new Set<string>();
  const out = emptyStrengthLoadWindow(startDate, endDate);

  history.forEach((session, index) => {
    if (!session.completed || session.skipped) return;
    const date = dateKeyFromRaw(session.date);
    if (!date || !dateKeyInWindow(date, startDate, endDate)) return;
    const key = session.id != null ? String(session.id) : `${date}:${index}`;
    if (sessionKeys.has(key)) return;
    sessionKeys.add(key);
    const load = sessionStrengthLoad(session);
    if (load.loadedSets === 0) return;
    out.volumeLbs += load.volumeLbs;
    out.loadedSets += load.loadedSets;
    out.sessionCount += 1;
    for (const [muscle, values] of Object.entries(load.byMuscle)) {
      const cur = out.byMuscle[muscle] ?? { primarySets: 0, secondarySets: 0, totalSets: 0, volumeLbs: 0 };
      cur.primarySets += values.primarySets;
      cur.secondarySets += values.secondarySets;
      cur.totalSets += values.totalSets;
      cur.volumeLbs += values.volumeLbs;
      out.byMuscle[muscle] = cur;
    }
  });

  out.volumeLbs = Math.round(out.volumeLbs);
  for (const values of Object.values(out.byMuscle)) {
    values.primarySets = Math.round(values.primarySets * 10) / 10;
    values.secondarySets = Math.round(values.secondarySets * 10) / 10;
    values.totalSets = Math.round(values.totalSets * 10) / 10;
    values.volumeLbs = Math.round(values.volumeLbs);
  }
  return out;
}

function publicStrengthVolumeWindow(window: StrengthLoadWindowSummary): StrengthVolumeWindowSummary {
  return {
    startDate: window.startDate,
    endDate: window.endDate,
    volumeLbs: window.volumeLbs,
    loadedSets: window.loadedSets,
    sessionCount: window.sessionCount,
  };
}

export function strengthVolumeForWindow(
  history: StrengthVolumeSessionShape[],
  startDate: string,
  endDate: string,
): StrengthVolumeWindowSummary {
  const sessionKeys = new Set<string>();
  const out: StrengthVolumeWindowSummary = {
    startDate,
    endDate,
    volumeLbs: 0,
    loadedSets: 0,
    sessionCount: 0,
  };

  history.forEach((session, index) => {
    if (!session.completed || session.skipped) return;
    const date = dateKeyFromRaw(session.date);
    if (!date || !dateKeyInWindow(date, startDate, endDate)) return;
    const key = session.id != null ? String(session.id) : `${date}:${index}`;
    if (sessionKeys.has(key)) return;
    sessionKeys.add(key);
    const volume = sessionStrengthVolume(session);
    if (volume.loadedSets === 0) return;
    out.volumeLbs += volume.volumeLbs;
    out.loadedSets += volume.loadedSets;
    out.sessionCount += 1;
  });

  return out;
}

function muscleLoadStatus(
  currentSets: number,
  baselineSets: number,
  targetMin: number,
  targetMax: number,
): { status: StrengthLoadBalanceStatus; spikeRatio: number } {
  const spikeRatio = baselineSets >= 2 ? currentSets / baselineSets : 1;
  if (currentSets <= 0 && baselineSets <= 0) return { status: 'no_data', spikeRatio };
  if (currentSets < targetMin) return { status: 'low', spikeRatio };
  if (spikeRatio >= 1.5) return { status: 'spike', spikeRatio };
  if (currentSets > targetMax) return { status: 'high', spikeRatio };
  return { status: 'balanced', spikeRatio };
}

function muscleLoadScore(
  currentSets: number,
  targetMin: number,
  targetMax: number,
  status: StrengthLoadBalanceStatus,
): number {
  if (status === 'no_data') return 0;
  if (currentSets < targetMin) {
    return Math.round(Math.max(0, Math.min(1, currentSets / targetMin)) * 100);
  }
  if (currentSets <= targetMax) {
    return status === 'spike' ? 70 : 100;
  }
  const highCeiling = targetMax * 1.5;
  if (currentSets <= highCeiling) {
    const overflowRatio = (currentSets - targetMax) / Math.max(1, highCeiling - targetMax);
    return Math.round(85 - overflowRatio * 25);
  }
  return 45;
}

function strengthLoadLabel(score: number | null): string {
  if (score == null) return 'Needs data';
  if (score >= 85) return 'Dialed';
  if (score >= 70) return 'Balanced';
  if (score >= 50) return 'Building';
  return 'Sparse';
}

function labelMuscle(muscle: string): string {
  return muscle.replace(/_/g, ' ');
}

function shortMuscleList(rows: StrengthLoadMuscleSummary[], limit = 2): string {
  return rows.slice(0, limit).map(row => labelMuscle(row.muscle)).join(', ');
}

function strengthLoadDetail(summary: {
  activeMuscleCount: number;
  inRangeMuscleCount: number;
  lowMuscles: StrengthLoadMuscleSummary[];
  highMuscles: StrengthLoadMuscleSummary[];
  spikeMuscles: StrengthLoadMuscleSummary[];
  topMuscles: StrengthLoadMuscleSummary[];
  currentLoadedSets: number;
}): string {
  if (summary.activeMuscleCount === 0) {
    return summary.currentLoadedSets > 0
      ? 'hard sets need muscle tags for balance'
      : 'no hard strength sets in this window';
  }
  if (summary.spikeMuscles.length > 0) {
    return `${shortMuscleList(summary.spikeMuscles)} spiking vs baseline`;
  }
  if (summary.lowMuscles.length > 0 && summary.inRangeMuscleCount > 0) {
    return `${summary.inRangeMuscleCount}/${summary.activeMuscleCount} muscles in range; ${shortMuscleList(summary.lowMuscles)} low`;
  }
  if (summary.lowMuscles.length > 0) {
    return `${shortMuscleList(summary.lowMuscles)} below target range`;
  }
  if (summary.highMuscles.length > 0) {
    return `${shortMuscleList(summary.highMuscles)} above target range`;
  }
  return `${shortMuscleList(summary.topMuscles)} in range`;
}

export function buildStrengthLoadBalance(
  history: StrengthVolumeSessionShape[],
  options: {
    today?: string | Date;
    windowDays?: number;
    weekCount?: number;
  } = {},
): StrengthLoadBalanceSummary {
  const today = dateKeyFromRaw(options.today ?? new Date()) ?? dateKeyFromDate(new Date());
  const windowDays = Math.max(1, Math.round(options.windowDays ?? 7));
  const weekCount = Math.max(2, Math.round(options.weekCount ?? 4));

  const loadWeeks: StrengthLoadWindowSummary[] = [];
  let endDate = today;
  for (let i = 0; i < weekCount; i += 1) {
    const startDate = shiftDateKey(endDate, -(windowDays - 1));
    loadWeeks.push(strengthLoadForWindow(history, startDate, endDate));
    endDate = shiftDateKey(startDate, -1);
  }

  const current = loadWeeks[0];
  const previous = loadWeeks[1] ?? null;
  const baselineWeeks = loadWeeks.slice(1);
  const muscles: StrengthLoadMuscleSummary[] = [];
  let weightedScoreTotal = 0;
  let weightTotal = 0;

  const targetScale = windowDays / 7;

  for (const [muscle, [weeklyTargetMin, weeklyTargetMax]] of Object.entries(STRENGTH_LOAD_TARGET_RANGES)) {
    const targetMin = Math.max(1, Math.round(weeklyTargetMin * targetScale));
    const targetMax = Math.max(targetMin, Math.round(weeklyTargetMax * targetScale));
    const currentLoad = current.byMuscle[muscle] ?? { primarySets: 0, secondarySets: 0, totalSets: 0, volumeLbs: 0 };
    const previousLoad = previous?.byMuscle[muscle] ?? { primarySets: 0, secondarySets: 0, totalSets: 0, volumeLbs: 0 };
    const baselineSets = baselineWeeks.length > 0
      ? baselineWeeks.reduce((sum, week) => sum + (week.byMuscle[muscle]?.totalSets ?? 0), 0) / baselineWeeks.length
      : 0;
    const active = currentLoad.totalSets > 0 || previousLoad.totalSets > 0 || baselineSets > 0;
    if (!active) continue;

    const { status, spikeRatio } = muscleLoadStatus(currentLoad.totalSets, baselineSets, targetMin, targetMax);
    const score = muscleLoadScore(currentLoad.totalSets, targetMin, targetMax, status);
    const weight = (targetMin + targetMax) / 2;
    weightedScoreTotal += score * weight;
    weightTotal += weight;
    const deltaSets = currentLoad.totalSets - previousLoad.totalSets;
    const deltaPct = previousLoad.totalSets > 0
      ? Math.round((deltaSets / previousLoad.totalSets) * 100)
      : null;
    muscles.push({
      muscle,
      currentSets: Math.round(currentLoad.totalSets * 10) / 10,
      previousSets: Math.round(previousLoad.totalSets * 10) / 10,
      baselineSets: Math.round(baselineSets * 10) / 10,
      primarySets: Math.round(currentLoad.primarySets * 10) / 10,
      secondarySets: Math.round(currentLoad.secondarySets * 10) / 10,
      currentVolumeLbs: Math.round(currentLoad.volumeLbs),
      previousVolumeLbs: Math.round(previousLoad.volumeLbs),
      targetMin,
      targetMax,
      deltaSets: Math.round(deltaSets * 10) / 10,
      deltaPct,
      spikeRatio: Math.round(spikeRatio * 100) / 100,
      status,
      score,
    });
  }

  muscles.sort((a, b) => {
    const statusRank: Record<StrengthLoadBalanceStatus, number> = {
      spike: 0,
      low: 1,
      high: 2,
      balanced: 3,
      no_data: 4,
    };
    const statusDelta = statusRank[a.status] - statusRank[b.status];
    if (statusDelta !== 0) return statusDelta;
    return b.currentSets - a.currentSets;
  });

  const lowMuscles = muscles.filter(row => row.status === 'low');
  const highMuscles = muscles.filter(row => row.status === 'high');
  const spikeMuscles = muscles.filter(row => row.status === 'spike');
  const topMuscles = [...muscles]
    .filter(row => row.currentSets > 0)
    .sort((a, b) => b.currentSets - a.currentSets);
  const activeMuscleCount = muscles.length;
  const inRangeMuscleCount = muscles.filter(row => row.status === 'balanced').length;
  const score = weightTotal > 0 ? Math.round(weightedScoreTotal / weightTotal) : null;
  const status: StrengthLoadBalanceStatus = activeMuscleCount === 0
    ? 'no_data'
    : spikeMuscles.length > 0
      ? 'spike'
      : lowMuscles.length > 0
        ? 'low'
        : highMuscles.length > 0
          ? 'high'
          : 'balanced';
  const detail = strengthLoadDetail({
    activeMuscleCount,
    inRangeMuscleCount,
    lowMuscles,
    highMuscles,
    spikeMuscles,
    topMuscles,
    currentLoadedSets: current.loadedSets,
  });

  return {
    current: publicStrengthVolumeWindow(current),
    previous: previous ? publicStrengthVolumeWindow(previous) : null,
    weeks: loadWeeks.map(publicStrengthVolumeWindow),
    muscles,
    score,
    label: strengthLoadLabel(score),
    status,
    detail,
    activeMuscleCount,
    inRangeMuscleCount,
    lowMuscles,
    highMuscles,
    spikeMuscles,
    topMuscles,
    windowDays,
  };
}

export function buildStrengthVolumeTrend(
  history: StrengthVolumeSessionShape[],
  options: {
    today?: string | Date;
    windowDays?: number;
    weekCount?: number;
    weekStartDate?: string | Date;
    bucketMode?: 'fixed_week' | 'rolling';
    minComparableLoadedSets?: number;
    minComparableVolumeLbs?: number;
    maxUsefulDeltaPct?: number;
  } = {},
): StrengthVolumeTrendBreakdown {
  const today = dateKeyFromRaw(options.today ?? new Date()) ?? dateKeyFromDate(new Date());
  const windowDays = Math.max(1, Math.round(options.windowDays ?? 7));
  const weekCount = Math.max(2, Math.round(options.weekCount ?? 9));
  const bucketMode = options.bucketMode ?? 'fixed_week';
  const minComparableLoadedSets = Math.max(1, Math.round(options.minComparableLoadedSets ?? 3));
  const minComparableVolumeLbs = Math.max(0, Number(options.minComparableVolumeLbs ?? 1000));
  const maxUsefulDeltaPct = Math.max(0, Number(options.maxUsefulDeltaPct ?? 300));

  const weeks: StrengthVolumeWindowSummary[] = [];
  let current: StrengthVolumeWindowSummary;
  let previous: StrengthVolumeWindowSummary | null = null;
  let elapsedDays = windowDays;

  if (bucketMode === 'rolling') {
    let endDate = today;
    for (let i = 0; i < weekCount; i += 1) {
      const startDate = shiftDateKey(endDate, -(windowDays - 1));
      weeks.push(strengthVolumeForWindow(history, startDate, endDate));
      endDate = shiftDateKey(startDate, -1);
    }
    current = weeks[0];
    previous = weeks[1] ?? null;
  } else {
    const rawWeekStart = dateKeyFromRaw(options.weekStartDate);
    const weekStart = rawWeekStart ?? startOfCalendarWeekKey(today);
    const weekEnd = shiftDateKey(weekStart, windowDays - 1);
    const currentEnd = maxDateKey(weekStart, minDateKey(today, weekEnd));
    elapsedDays = daySpanInclusive(weekStart, currentEnd);

    for (let i = 0; i < weekCount; i += 1) {
      const startDate = shiftDateKey(weekStart, -windowDays * i);
      const endDate = i === 0 ? currentEnd : shiftDateKey(startDate, windowDays - 1);
      weeks.push(strengthVolumeForWindow(history, startDate, endDate));
    }

    current = weeks[0];
    const previousStartDate = shiftDateKey(weekStart, -windowDays);
    const previousEndDate = shiftDateKey(previousStartDate, elapsedDays - 1);
    previous = strengthVolumeForWindow(history, previousStartDate, previousEndDate);
  }

  const deltaLbs = previous ? current.volumeLbs - previous.volumeLbs : null;
  let deltaPct: number | null = null;
  let comparison: StrengthVolumeComparison = 'no_previous';

  if (previous && previous.volumeLbs > 0) {
    const comparable = previous.loadedSets >= minComparableLoadedSets
      && previous.volumeLbs >= minComparableVolumeLbs;
    if (!comparable) {
      comparison = 'insufficient_previous';
    } else {
      const rawDeltaPct = Math.round(((current.volumeLbs - previous.volumeLbs) / previous.volumeLbs) * 100);
      if (Math.abs(rawDeltaPct) <= maxUsefulDeltaPct) {
        deltaPct = rawDeltaPct;
        comparison = 'percent';
      } else {
        comparison = 'absolute';
      }
    }
  }

  return {
    weeks,
    current,
    previous,
    deltaPct,
    deltaLbs,
    comparison,
    windowDays,
    weekCount,
    bucketMode,
    elapsedDays,
  };
}
