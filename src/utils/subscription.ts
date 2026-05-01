// Subscription tier helpers + feature-gating utilities.
//
// Single source of truth for "is this user pro?". All feature gates route
// through `isPro()` so flipping the dev toggle instantly changes UI + API
// behavior across the app.
//
// FREE — manual tracking and starter tools:
//   - Manual workouts + custom activity logging
//   - Manual meals, hydration, and meal routines
//   - Weight + body measurements
//   - Basic history / progress views
//   - Up to 3 saved workout templates
//
// PRO — guided planning, AI help, and deeper insights:
//   - Visible generated workout PlanWeeks + day rebuilds
//   - AI meal plans, meal swaps, and food lookup
//   - Food/body/form photo analysis
//   - Coach chat for training + nutrition
//   - Nutrition scoring, gut insights, weekly digest
//   - Readiness, fatigue, sleep, and recovery cards

import type { UserProfile } from '../types';
import {
  FEATURE_LABEL,
  canCreateMealRoutine,
  canCreateSavedMeal,
  canCreateWorkoutTemplate,
  canUse,
  isFree,
  isPro,
  labelFor,
  mealRoutineLimit,
  savedMealLimit,
  tierOf,
  workoutTemplateLimit,
  FREE_MEAL_ROUTINE_LIMIT,
  FREE_SAVED_MEAL_LIMIT,
  FREE_WORKOUT_TEMPLATE_LIMIT,
  type ProFeature,
  type Tier,
} from './subscriptionCore';

export {
  canCreateMealRoutine,
  canCreateSavedMeal,
  canCreateWorkoutTemplate,
  canUse,
  FREE_MEAL_ROUTINE_LIMIT,
  FREE_SAVED_MEAL_LIMIT,
  FREE_WORKOUT_TEMPLATE_LIMIT,
  isFree,
  isPro,
  labelFor,
  mealRoutineLimit,
  savedMealLimit,
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
    `${FEATURE_LABEL[feature]} is a Thallo Pro feature. Upgrade for guided plans, AI help, readiness, and deeper insights.`,
    [
      { text: 'Not now', style: 'cancel' },
      { text: 'Upgrade', onPress: () => opts?.onUpgrade?.() },
    ],
  );
  return false;
}
