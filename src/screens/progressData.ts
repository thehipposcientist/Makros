// Pure data-shaping helpers used by ProgressScreen.
//
// Extracted so the aggregation logic can be unit-tested without rendering
// the (very large) Progress screen. Every function here takes plain JSON
// shapes (the same payloads the API returns) and returns plain JSON —
// no React, no AsyncStorage, no native modules.
//
// Tests live in `src/screens/__tests__/progressData.test.ts`.

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

export interface AdherenceTrendsShape {
  direction?: 'improving' | 'slipping' | 'steady' | string;
  recent?: {
    avg_calories?: number;
    avg_calories_when_logged?: number;
    tracking_rate_pct?: number;
    protein_hit_pct?: number | null;
  };
  tracking_delta_pct?: number;
  protein_hit_delta_pct?: number | null;
  calorie_delta?: number;
  calorie_delta_when_logged?: number;
  current_logging_streak_days?: number;
  current_protein_streak_days?: number | null;
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

/** Headline calorie value used by BOTH the Trend card and the Facts card.
 *  Sourcing from the same place is what guarantees the two cards agree —
 *  the prior bug had Trend reading the recent-half-only value while Facts
 *  read the full window. Returning a single tiny helper makes it obvious
 *  to future readers that these surfaces share one number. */
export function headlineLoggedCalories(
  averages: MealAveragesShape | null | undefined,
  trends?: AdherenceTrendsShape | null,
): number {
  if (averages) {
    return Number(averages.avg_calories_when_logged ?? averages.avg_calories ?? 0);
  }
  // Fallback to the trend's recent value only when the averages call hasn't
  // resolved yet — keeps the Trend card from rendering "0 cal" briefly.
  const recent = trends?.recent;
  return Number(recent?.avg_calories_when_logged ?? recent?.avg_calories ?? 0);
}

/** Formatted delta string ("+200 vs prior") for the Trend card. */
export function calorieDeltaLabel(trends: AdherenceTrendsShape): string {
  const d = Number(trends.calorie_delta_when_logged ?? trends.calorie_delta ?? 0);
  return `${d >= 0 ? '+' : ''}${Math.round(d)}`;
}

/** Maps direction → label/color-bucket for the Trend card. Color value is
 *  the bucket name (semantic), not a hex; the screen maps it to theme
 *  colors at render time. Keeps this helper free of theme deps. */
export function trendDirectionInfo(direction: string | undefined) {
  const dir = String(direction ?? 'steady');
  if (dir === 'improving') return { label: 'Improving', bucket: 'success' as const };
  if (dir === 'slipping')  return { label: 'Slipping',  bucket: 'warning' as const };
  return { label: 'Steady', bucket: 'neutral' as const };
}

/** Sanity check: do the headline numbers from Trend and Facts agree?
 *  This is the invariant we want to maintain — both cards display
 *  "logged cal" so they MUST resolve to the same number. The screen calls
 *  this in dev to assert. Returns the absolute diff (0 = perfect match). */
export function trendFactsCalorieDiff(
  averages: MealAveragesShape | null | undefined,
  trends: AdherenceTrendsShape | null | undefined,
): number {
  if (!averages || !trends) return 0;
  const headline = headlineLoggedCalories(averages, trends);
  // What the Trend card WOULD show if it were sourcing from `recent` directly.
  const trendOwn = Number(trends.recent?.avg_calories_when_logged ?? trends.recent?.avg_calories ?? 0);
  return Math.abs(headline - trendOwn);
}
