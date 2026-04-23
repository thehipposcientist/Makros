// Subscription tier helpers + feature-gating utilities.
//
// Single source of truth for "is this user pro?". All feature gates route
// through `isPro()` so flipping the dev toggle instantly changes UI + API
// behavior across the app.
//
// What free users CAN do:
//   - Manual workout logging, manual set tracking
//   - Manual meal logging (no AI skeleton, no barcode scan)
//   - Track weight, view history + PRs
//   - See their own charts + adherence trends
//   - Read-only: recovery, preparedness (from manual data only)
//
// What free users CANNOT do:
//   - Generate AI workout plans / regenerate day
//   - Generate AI meal plans
//   - Ask the AI coach (trainer / nutritionist)
//   - AI food scanning (photo-to-meal, barcode-to-food via AI lookup)
//   - AI workout form analysis (photo/video)
//   - AI starting-weight recommendations
//   - AI plan review / swap
//
// Bump FEATURE in one place when a new AI endpoint ships — no grep hunt.

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
  | 'ai_in_workout_review';

const FEATURE_LABEL: Record<ProFeature, string> = {
  ai_plan_generation:       'AI plan generation',
  ai_day_regenerate:        'Regenerate workouts',
  ai_meal_plan:             'AI meal plans',
  ai_coach:                 'AI coach chat',
  ai_food_scan:             'Food photo scanning',
  ai_form_analysis:         'Form check (photo/video)',
  ai_weight_recommendation: 'Smart starting weights',
  ai_plan_review:           'AI plan review',
  ai_food_enrichment:       'AI food lookup',
  ai_in_workout_review:     'In-workout set review',
};

export function tierOf(profile: UserProfile | null | undefined): Tier {
  // Default to `pro` when the field is missing so existing users keep
  // everything. New signups should be created with subscriptionTier='free'.
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
    'Pro feature',
    `${FEATURE_LABEL[feature]} is a Thallo Pro feature. Upgrade to unlock AI-generated plans, coaching, and more.`,
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
