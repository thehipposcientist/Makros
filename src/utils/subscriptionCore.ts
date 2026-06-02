// Pure subscription-tier helpers. Keep React Native UI side effects in
// `subscription.ts` so these can run in the lightweight frontend test runner.

import type { SubscriptionStatus, SubscriptionTier, UserProfile } from '../types';

export type Tier = SubscriptionTier;
export type { SubscriptionStatus };

// Free-tier caps: manual tracking should feel complete, while Pro owns
// generated plans, AI workflows, readiness, scoring, and deeper insights.
export const FREE_WORKOUT_TEMPLATE_LIMIT = 5;
export const FREE_SAVED_MEAL_LIMIT = Number.POSITIVE_INFINITY;
export const FREE_MEAL_ROUTINE_LIMIT = 7;
export const SIGNUP_TRIAL_DAYS = 7;

export type ProFeature =
  | 'ai_plan_generation'
  | 'ai_day_regenerate'
  | 'ai_meal_plan'
  | 'ai_coach'
  | 'ai_food_scan'
  | 'ai_equipment_scan'
  | 'ai_supplement_scan'
  | 'ai_supplement_lookup'
  | 'ai_lab_scan'
  | 'ai_meal_voice'
  | 'ai_form_analysis'
  | 'ai_body_scan'
  | 'ai_weight_recommendation'
  | 'ai_plan_review'
  | 'ai_food_enrichment'
  | 'ai_in_workout_review'
  | 'nutrition_insights'
  | 'nutrition_scoring'
  | 'supplement_insights'
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
  ai_equipment_scan:        'Equipment photo scanning',
  ai_supplement_scan:       'Supplement photo scanning',
  ai_supplement_lookup:     'AI supplement lookup',
  ai_lab_scan:              'Lab report scanning',
  ai_meal_voice:            'Speech-to-meal',
  ai_form_analysis:         'Form analysis',
  ai_body_scan:             'Body photo analysis',
  ai_weight_recommendation: 'AI starting-weight fallback',
  ai_plan_review:           'Plan review',
  ai_food_enrichment:       'AI food lookup',
  ai_in_workout_review:     'In-workout set feedback',
  nutrition_insights:        'Gut and longevity insights',
  nutrition_scoring:         'Nutrition scoring',
  supplement_insights:       'Supplement insights',
  weekly_digest:             'Weekly progress digest',
  recovery_tracking:         'Readiness and fatigue tracking',
  apple_health:              'Health-powered readiness',
  workout_analytics:         'Workout analytics',
  progress_charts:           'Advanced charts and trends',
};

export type TierCapability = {
  icon: string;
  label: string;
};

export const FREE_TIER_SUMMARY =
  `Free: manual strength/cardio workouts, meal logging, hydration, supplements, basic progress, ${FREE_WORKOUT_TEMPLATE_LIMIT} workout templates, unlimited saved meals, and ${FREE_MEAL_ROUTINE_LIMIT} meal routines.`;

export const PRO_TIER_SUMMARY =
  `Pro: guided PlanWeeks, custom planning, AI meal and supplement help, coach chat, scans, readiness, nutrition scoring, health context, and advanced trends. New accounts start with a ${SIGNUP_TRIAL_DAYS}-day trial.`;

export const FREE_TIER_CAPABILITIES: readonly TierCapability[] = [
  { icon: 'barbell-outline', label: 'Manual strength, cardio, and custom activity logging' },
  { icon: 'bookmark-outline', label: `Up to ${FREE_WORKOUT_TEMPLATE_LIMIT} saved workout templates you can reuse or share` },
  { icon: 'restaurant-outline', label: `Manual meals, hydration, unlimited saved meals, and ${FREE_MEAL_ROUTINE_LIMIT} meal routines` },
  { icon: 'medical-outline', label: 'Supplement stack, dose logging, and rule-based supplement suggestions' },
  { icon: 'scale-outline', label: 'Weight, body measurements, basic history, and progress views' },
  { icon: 'people-outline', label: 'Workouts-only, nutrition-only, or full-app setup with friends, exercise library, equipment, injury, and preference settings' },
];

export const PRO_TIER_CAPABILITIES: readonly TierCapability[] = [
  { icon: 'calendar-outline', label: 'Guided 7-day PlanWeeks with auto-renewal' },
  { icon: 'swap-horizontal-outline', label: 'Change Focus, swaps, day rebuilds, templates, and manual week planning' },
  { icon: 'restaurant-outline', label: 'AI meal plans, meal swaps, grocery help, and food enrichment' },
  { icon: 'chatbubble-outline', label: 'Coach chat, set feedback, weight recommendations, and AI warmups' },
  { icon: 'camera-outline', label: 'Food, supplement, equipment, form, body, and lab report scans' },
  { icon: 'leaf-outline', label: 'Nutrition scoring, gut insights, supplement insights, and weekly digest' },
  { icon: 'pulse-outline', label: 'Readiness, fatigue, sleep, Apple Health context, and advanced trends' },
];

const TRIAL_STATUSES = new Set<SubscriptionStatus>(['trialing', 'trial_cancelled']);
const EXPIRING_PRO_STATUSES = new Set<SubscriptionStatus>([
  'active',
  'grace_period',
  'cancelled',
  'promotional',
  'temporary',
]);
const NON_EXPIRING_PRO_STATUSES = new Set<SubscriptionStatus>(['beta']);
const INACTIVE_STATUSES = new Set<SubscriptionStatus>([
  'free',
  'expired',
  'revoked',
  'billing_issue',
]);

export function tierOf(profile: UserProfile | null | undefined, nowMs = Date.now()): Tier {
  const tier = profile?.subscriptionTier === 'pro' ? 'pro' : 'free';
  const status = String(profile?.subscriptionStatus ?? '').toLowerCase();
  if (tier !== 'pro') return 'free';
  if (!status) return 'pro';
  if (TRIAL_STATUSES.has(status as SubscriptionStatus)) {
    return hasFutureIso(profile?.trialEndsAt, nowMs) ? 'pro' : 'free';
  }
  if (EXPIRING_PRO_STATUSES.has(status as SubscriptionStatus)) {
    return hasIsoExpired(profile?.subscriptionExpiresAt, nowMs) ? 'free' : 'pro';
  }
  if (NON_EXPIRING_PRO_STATUSES.has(status as SubscriptionStatus)) return 'pro';
  if (INACTIVE_STATUSES.has(status as SubscriptionStatus)) return 'free';
  return 'free';
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

export function savedMealLimit(_profile: UserProfile | null | undefined): number {
  return Number.POSITIVE_INFINITY;
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

export function hasIsoExpired(value: string | null | undefined, nowMs = Date.now()): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= nowMs;
}

export function hasFutureIso(value: string | null | undefined, nowMs = Date.now()): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > nowMs;
}

export function trialDaysRemaining(profile: UserProfile | null | undefined, nowMs = Date.now()): number {
  const endsAt = profile?.trialEndsAt;
  if (!endsAt) return 0;
  const parsed = Date.parse(endsAt);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.ceil((parsed - nowMs) / (24 * 60 * 60 * 1000)));
}

export function isTrialing(profile: UserProfile | null | undefined, nowMs = Date.now()): boolean {
  return profile?.subscriptionStatus === 'trialing' && tierOf(profile, nowMs) === 'pro';
}

export function subscriptionStatusLabel(profile: UserProfile | null | undefined, nowMs = Date.now()): string {
  if (!profile) return 'Free';
  const status = String(profile.subscriptionStatus ?? '').toLowerCase();
  if (status === 'trial_cancelled' && tierOf(profile, nowMs) === 'pro') {
    const days = trialDaysRemaining(profile, nowMs);
    return `Pro trial ending · ${days} day${days === 1 ? '' : 's'} left`;
  }
  if (isTrialing(profile, nowMs)) {
    const days = trialDaysRemaining(profile, nowMs);
    return `Pro trial · ${days} day${days === 1 ? '' : 's'} left`;
  }
  if (tierOf(profile, nowMs) === 'pro') {
    if (status === 'grace_period') return 'Pro · grace period';
    if (status === 'cancelled') return 'Pro · ends soon';
    if (status === 'beta') return 'Pro beta';
    return 'Pro';
  }
  if (status === 'expired') return 'Free · trial ended';
  return 'Free';
}
