// Subscription tier helpers + feature-gating utilities.
//
// Single source of truth for "is this user pro?". All feature gates route
// through `isPro()` so beta/full-access and future entitlement changes apply
// consistently across the app.
//
// FREE — manual tracking and starter tools:
//   - Manual workouts + custom activity logging
//   - Manual meals, hydration, saved meals, meal routines, and supplements
//   - Weight + body measurements
//   - Basic history / progress views + friends
//   - Up to 5 saved workout templates, unlimited saved meals, 7 meal routines
//
// PRO — guided planning, AI help, and deeper insights:
//   - Visible generated workout PlanWeeks + day rebuilds + manual week planning
//   - AI meal plans, meal swaps, food lookup, and supplement lookup
//   - Food/supplement/equipment/body/form photo analysis
//   - Coach chat for training + nutrition
//   - Nutrition scoring, gut/supplement insights, weekly digest
//   - Readiness, fatigue, sleep, and recovery cards

import type { UserProfile } from '../types';
import Constants from 'expo-constants';
import * as core from './subscriptionCore';
import {
  FEATURE_LABEL,
  FREE_MEAL_ROUTINE_LIMIT,
  FREE_SAVED_MEAL_LIMIT,
  FREE_TIER_CAPABILITIES,
  FREE_TIER_SUMMARY,
  FREE_WORKOUT_TEMPLATE_LIMIT,
  PRO_TIER_CAPABILITIES,
  PRO_TIER_SUMMARY,
  SIGNUP_TRIAL_DAYS,
  isTrialing as coreIsTrialing,
  subscriptionStatusLabel as coreSubscriptionStatusLabel,
  trialDaysRemaining as coreTrialDaysRemaining,
  type ProFeature,
  type SubscriptionStatus,
  type Tier,
  type TierCapability,
} from './subscriptionCore';

export {
  FREE_MEAL_ROUTINE_LIMIT,
  FREE_SAVED_MEAL_LIMIT,
  FREE_TIER_CAPABILITIES,
  FREE_TIER_SUMMARY,
  FREE_WORKOUT_TEMPLATE_LIMIT,
  PRO_TIER_CAPABILITIES,
  PRO_TIER_SUMMARY,
  SIGNUP_TRIAL_DAYS,
  type ProFeature,
  type SubscriptionStatus,
  type Tier,
  type TierCapability,
};

declare const require: (moduleName: string) => any;

export function isBetaFullAccessEnabled(): boolean {
  if (process.env.EXPO_PUBLIC_DISABLE_FREE_BETA_FULL_ACCESS === '1') return false;
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

export const labelFor = core.labelFor;

export function trialDaysRemaining(profile: UserProfile | null | undefined, nowMs = Date.now()): number {
  return coreTrialDaysRemaining(profile, nowMs);
}

export function isTrialing(profile: UserProfile | null | undefined, nowMs = Date.now()): boolean {
  return !isBetaFullAccessEnabled() && coreIsTrialing(profile, nowMs);
}

export function subscriptionStatusLabel(profile: UserProfile | null | undefined, nowMs = Date.now()): string {
  return isBetaFullAccessEnabled() ? 'Pro beta' : coreSubscriptionStatusLabel(profile, nowMs);
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
