// Subscription tier helpers + feature-gating utilities.
//
// Single source of truth for "is this user pro?". All feature gates route
// through `isPro()` so flipping the dev toggle instantly changes UI + API
// behavior across the app.
//
// FREE — basic tracking, enough to experience the app:
//   - Manual workout logging + set tracking
//   - Manual meal logging (no AI)
//   - Weight + body measurements
//   - Basic workout history (sets, reps, duration)
//
// PRO — full coaching, deeper insights, best results:
//   - Personalized workout plan generation + day regeneration
//   - AI meal plans + food photo scanning
//   - AI coach chat (trainer + nutritionist)
//   - Smart starting-weight recommendations
//   - In-workout AI set review
//   - Gut & longevity nutrition insights
//   - Nutrition scoring + weekly digest
//   - Recovery + fatigue tracking with adaptive recommendations
//   - Apple Health integration (HR, sleep, readiness)
//   - Workout calorie + HR zone tracking
//   - Charts, trends, and progress analytics

import { Alert } from 'react-native';
import type { UserProfile } from '../types';

export type Tier = 'free' | 'pro';

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

const FEATURE_LABEL: Record<ProFeature, string> = {
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
  return profile?.subscriptionTier ?? 'pro';
}

export function isPro(profile: UserProfile | null | undefined): boolean {
  return tierOf(profile) === 'pro';
}

export function isFree(profile: UserProfile | null | undefined): boolean {
  return tierOf(profile) === 'free';
}

/** Gate a pro feature. Returns true if the user can proceed; returns false
 *  AND shows an upgrade alert when they can't. Caller should short-circuit
 *  on false. */
export function requirePro(
  profile: UserProfile | null | undefined,
  feature: ProFeature,
  opts?: { onUpgrade?: () => void; silent?: boolean },
): boolean {
  if (isPro(profile)) return true;
  if (opts?.silent) return false;
  Alert.alert(
    'Upgrade to Pro',
    `${FEATURE_LABEL[feature]} is a Thallo Pro feature. Upgrade for personalized plans, deeper insights, and AI coaching.`,
    [
      { text: 'Not now', style: 'cancel' },
      { text: 'Upgrade', onPress: () => opts?.onUpgrade?.() },
    ],
  );
  return false;
}

/** Non-throwing silent check. Use from render paths that should just hide
 *  the button rather than alert. */
export function canUse(profile: UserProfile | null | undefined, _feature: ProFeature): boolean {
  return isPro(profile);
}

export function labelFor(feature: ProFeature): string {
  return FEATURE_LABEL[feature];
}
