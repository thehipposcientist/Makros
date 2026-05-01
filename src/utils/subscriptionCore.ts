// Pure subscription-tier helpers. Keep React Native UI side effects in
// `subscription.ts` so these can run in the lightweight frontend test runner.

import type { UserProfile } from '../types';

export type Tier = 'free' | 'pro';

export const FREE_WORKOUT_TEMPLATE_LIMIT = 3;

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
  ai_plan_generation:       'Personalized training plans',
  ai_day_regenerate:        'Rebuild your week',
  ai_meal_plan:             'AI meal plans',
  ai_coach:                 'AI coach chat',
  ai_food_scan:             'Food photo scanning',
  ai_form_analysis:         'Form analysis',
  ai_weight_recommendation: 'Smart starting weights',
  ai_plan_review:           'AI plan review',
  ai_food_enrichment:       'AI food lookup',
  ai_in_workout_review:     'In-workout AI feedback',
  nutrition_insights:        'Gut & longevity insights',
  nutrition_scoring:         'Nutrition scoring',
  weekly_digest:             'Weekly progress digest',
  recovery_tracking:         'Recovery + fatigue tracking',
  apple_health:              'Apple Health sync',
  workout_analytics:         'Workout calorie + HR tracking',
  progress_charts:           'Charts + trends',
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

export function canUse(profile: UserProfile | null | undefined, _feature: ProFeature): boolean {
  return isPro(profile);
}

export function labelFor(feature: ProFeature): string {
  return FEATURE_LABEL[feature];
}
