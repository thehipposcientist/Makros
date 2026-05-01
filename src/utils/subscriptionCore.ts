// Pure subscription-tier helpers. Keep React Native UI side effects in
// `subscription.ts` so these can run in the lightweight frontend test runner.

import type { UserProfile } from '../types';

export type Tier = 'free' | 'pro';

// Free-tier caps — chosen to match the standard set across competing apps:
//   - MyFitnessPal Free: 10 recipes / 0 plans
//   - Cronometer Free: ~25 custom foods / no meal plan
//   - Lose It! Free: 10 custom foods / no plans
// Three workout templates and five saved meals + three meal routines puts
// Thallo's free experience just slightly ahead of the median, leaving room
// for Pro to differentiate on generated planning + AI coaching rather than
// raw count gates.
export const FREE_WORKOUT_TEMPLATE_LIMIT = 3;
export const FREE_SAVED_MEAL_LIMIT = 5;
export const FREE_MEAL_ROUTINE_LIMIT = 3;

export type ProFeature =
  | 'ai_plan_generation'
  | 'ai_day_regenerate'
  | 'ai_meal_plan'
  | 'ai_coach'
  | 'ai_food_scan'
  | 'ai_form_analysis'
  | 'ai_weight_recommendation'
  | 'ai_plan_review'
  | 'ai_food_enrichment'
  | 'ai_in_workout_review'
  | 'nutrition_insights'
  | 'nutrition_scoring'
  | 'weekly_digest'
  | 'recovery_tracking'
  | 'apple_health'
  | 'workout_analytics'
  | 'progress_charts';

export const FEATURE_LABEL: Record<ProFeature, string> = {
  ai_plan_generation:       'Generated workout PlanWeeks',
  ai_day_regenerate:        'Change Focus and day rebuilds',
  ai_meal_plan:             'AI meal plans',
  ai_coach:                 'Coach chat',
  ai_food_scan:             'Food photo scanning',
  ai_form_analysis:         'Form analysis',
  ai_weight_recommendation: 'AI starting-weight fallback',
  ai_plan_review:           'Plan review',
  ai_food_enrichment:       'AI food lookup',
  ai_in_workout_review:     'In-workout set feedback',
  nutrition_insights:        'Gut and longevity insights',
  nutrition_scoring:         'Nutrition scoring',
  weekly_digest:             'Weekly progress digest',
  recovery_tracking:         'Readiness and fatigue tracking',
  apple_health:              'Health-powered readiness',
  workout_analytics:         'Workout analytics',
  progress_charts:           'Advanced charts and trends',
};

export function tierOf(profile: UserProfile | null | undefined): Tier {
  return profile?.subscriptionTier ?? 'free';
}

export function isPro(profile: UserProfile | null | undefined): boolean {
  return tierOf(profile) === 'pro';
}

export function isFree(profile: UserProfile | null | undefined): boolean {
  return tierOf(profile) === 'free';
}

export function workoutTemplateLimit(profile: UserProfile | null | undefined): number {
  return isPro(profile) ? Infinity : FREE_WORKOUT_TEMPLATE_LIMIT;
}

export function canCreateWorkoutTemplate(
  profile: UserProfile | null | undefined,
  currentCount: number,
): boolean {
  return currentCount < workoutTemplateLimit(profile);
}

export function savedMealLimit(profile: UserProfile | null | undefined): number {
  return isPro(profile) ? Infinity : FREE_SAVED_MEAL_LIMIT;
}

export function canCreateSavedMeal(
  profile: UserProfile | null | undefined,
  currentCount: number,
): boolean {
  return currentCount < savedMealLimit(profile);
}

export function mealRoutineLimit(profile: UserProfile | null | undefined): number {
  return isPro(profile) ? Infinity : FREE_MEAL_ROUTINE_LIMIT;
}

export function canCreateMealRoutine(
  profile: UserProfile | null | undefined,
  currentCount: number,
): boolean {
  return currentCount < mealRoutineLimit(profile);
}

export function canUse(profile: UserProfile | null | undefined, _feature: ProFeature): boolean {
  return isPro(profile);
}

export function labelFor(feature: ProFeature): string {
  return FEATURE_LABEL[feature];
}
