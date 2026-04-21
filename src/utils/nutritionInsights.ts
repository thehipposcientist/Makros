/**
 * Small, opinionated coaching flags derived from today's meal plan +
 * check timestamps. Each insight is a one-line message the UI can
 * surface as a gentle nudge.
 *
 * Deliberately pragmatic — no hormonal claims, just behavior patterns
 * with evidence:
 *   - Per-meal protein ≥15g supports muscle protein synthesis (MPS
 *     needs ~0.4 g/kg per meal to saturate).
 *   - Last meal >2h before bed helps sleep quality (digestion reduces
 *     deep sleep).
 *   - Evenly-spaced protein across the day beats dumping it all at
 *     dinner for muscle maintenance.
 */
import type { DailyNutritionPlan, MealSuggestion } from '../types';

export type InsightTier = 'good' | 'watch' | 'flag';

export interface NutritionInsight {
  id: string;
  tier: InsightTier;
  title: string;
  detail: string;
}

/** Flags per-meal protein shortfall. A "meal" with <15g protein is
 *  basically a snack for MPS purposes. */
export function proteinTimingInsights(plan: DailyNutritionPlan | null): NutritionInsight[] {
  if (!plan?.meals?.length) return [];
  const lowProteinMeals = plan.meals.filter(m => (m.protein ?? 0) < 15);
  if (lowProteinMeals.length === 0) {
    const min = Math.min(...plan.meals.map(m => m.protein ?? 0));
    return [{
      id: 'protein_timing_good',
      tier: 'good',
      title: 'Protein distribution',
      detail: `Every meal hits ≥${Math.round(min)}g protein — supports muscle protein synthesis across the day.`,
    }];
  }
  const names = lowProteinMeals.map(m => m.meal).slice(0, 3).join(', ');
  return [{
    id: 'protein_timing_low',
    tier: 'watch',
    title: 'Low-protein meal(s)',
    detail: `${lowProteinMeals.length} meal${lowProteinMeals.length > 1 ? 's' : ''} under 15g protein (${names}). Add a protein source — MPS benefits from 20g+ per sitting.`,
  }];
}

/** Late-eating flag using meal-check timestamps. Assumes typical bedtime
 *  of 22:30 unless user has a configured bedtime. */
export function lateEatingInsight(
  lastMealTimeHHMM: string | null,
  bedtimeHHMM: string = '22:30',
): NutritionInsight | null {
  if (!lastMealTimeHHMM) return null;
  const parse = (s: string) => {
    const [h, m] = s.split(':').map(n => parseInt(n, 10));
    return (h || 0) * 60 + (m || 0);
  };
  const lastMins = parse(lastMealTimeHHMM);
  const bedMins = parse(bedtimeHHMM);
  const gap = bedMins - lastMins;
  if (gap >= 120) {
    return {
      id: 'late_eating_ok',
      tier: 'good',
      title: 'Meal timing',
      detail: `Last meal ${Math.round(gap / 60)}h before bed — gives digestion time before sleep.`,
    };
  }
  if (gap >= 60) {
    return {
      id: 'late_eating_watch',
      tier: 'watch',
      title: 'Late last meal',
      detail: `Last meal only ${Math.round(gap / 60)}h before bed — aim for 2h+ for better sleep.`,
    };
  }
  return {
    id: 'late_eating_flag',
    tier: 'flag',
    title: 'Very late eating',
    detail: `Last meal <1h before typical bedtime. Late eating often fragments sleep and impairs recovery.`,
  };
}

/** Chronic deficit warning — flags if the user has been in a large
 *  deficit for too long (hormone + thyroid risk after 6+ weeks). Needs
 *  rolling avg calories + maintenance estimate from the caller. */
export function chronicDeficitInsight(
  avgDailyCalories: number | null,
  maintenanceCalories: number,
  deficitWeeks: number,
): NutritionInsight | null {
  if (avgDailyCalories == null || maintenanceCalories <= 0) return null;
  const deficit = maintenanceCalories - avgDailyCalories;
  if (deficit < 400) return null;
  if (deficitWeeks < 6) return null;
  return {
    id: 'chronic_deficit',
    tier: 'flag',
    title: 'Extended deficit',
    detail: `You've been ~${Math.round(deficit)} kcal under maintenance for ${deficitWeeks}+ weeks. Consider a diet break to preserve thyroid + muscle.`,
  };
}

/** Chronic surplus without training stimulus — adds fat without muscle.
 *  Useful as a gentle nudge when user is in a bulk but not hitting lifts. */
export function chronicSurplusInsight(
  avgDailyCalories: number | null,
  maintenanceCalories: number,
  workoutsThisWeek: number,
): NutritionInsight | null {
  if (avgDailyCalories == null || maintenanceCalories <= 0) return null;
  const surplus = avgDailyCalories - maintenanceCalories;
  if (surplus < 400) return null;
  if (workoutsThisWeek >= 3) return null;
  return {
    id: 'surplus_no_training',
    tier: 'watch',
    title: 'Surplus without training',
    detail: `Eating ~${Math.round(surplus)} kcal over maintenance with <3 workouts this week. Without the training stimulus, most of that becomes fat.`,
  };
}
