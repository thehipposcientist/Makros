// Subscription tier helpers + feature-gating utilities.
//
// Single source of truth for "is this user pro?". All feature gates route
// through `isPro()` so beta/full-access and future entitlement changes apply
// consistently across the app.
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
import Constants from 'expo-constants';
import * as core from './subscriptionCore';
import { FEATURE_LABEL, FREE_MEAL_ROUTINE_LIMIT, FREE_SAVED_MEAL_LIMIT, FREE_WORKOUT_TEMPLATE_LIMIT, type ProFeature, type Tier } from './subscriptionCore';

export {
  FREE_MEAL_ROUTINE_LIMIT,
  FREE_SAVED_MEAL_LIMIT,
  FREE_WORKOUT_TEMPLATE_LIMIT,
  type ProFeature,
  type Tier,
};

declare const require: (moduleName: string) => any;

export function isBetaFullAccessEnabled(): boolean {
  const isDevRuntime = typeof __DEV__ !== 'undefined' && __DEV__ === true;
  if (!isDevRuntime) return false;
  const extra = Constants.expoConfig?.extra ?? {};
  return extra.freeBetaFullAccess === true || process.env.EXPO_PUBLIC_FREE_BETA_FULL_ACCESS === '1';
}

export function tierOf(profile: UserProfile | null | undefined): Tier {
  return isBetaFullAccessEnabled() ? 'pro' : core.tierOf(profile);
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

export const labelFor = core.labelFor;

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
