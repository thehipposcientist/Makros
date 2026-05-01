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

import type { UserProfile } from '../types';
import {
  FEATURE_LABEL,
  canCreateWorkoutTemplate,
  canUse,
  isFree,
  isPro,
  labelFor,
  tierOf,
  workoutTemplateLimit,
  FREE_WORKOUT_TEMPLATE_LIMIT,
  type ProFeature,
  type Tier,
} from './subscriptionCore';

export {
  canCreateWorkoutTemplate,
  canUse,
  FREE_WORKOUT_TEMPLATE_LIMIT,
  isFree,
  isPro,
  labelFor,
  tierOf,
  workoutTemplateLimit,
  type ProFeature,
  type Tier,
};

declare const require: (moduleName: string) => any;

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
  const { Alert } = require('react-native');
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
