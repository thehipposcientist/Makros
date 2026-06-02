// Smoke tests for the subscription tier helpers.
//
// These exist primarily to prevent regression of the launch-blocker fix
// where `tierOf` defaulted to `'pro'`. Defaulting to Pro silently unlocks
// paid features for any user whose profile fetch hasn't resolved yet,
// which is unsafe once StoreKit/RevenueCat is the entitlement authority.
//
// Pure functions only — no React Native runtime needed.

import {
  FREE_MEAL_ROUTINE_LIMIT,
  FREE_SAVED_MEAL_LIMIT,
  FREE_TIER_CAPABILITIES,
  FREE_WORKOUT_TEMPLATE_LIMIT,
  PRO_TIER_CAPABILITIES,
  SIGNUP_TRIAL_DAYS,
  canCreateSavedMeal,
  canCreateWorkoutTemplate,
  isFree,
  isPro,
  isTrialing,
  labelFor,
  savedMealLimit,
  subscriptionStatusLabel,
  tierOf,
  trialDaysRemaining,
  workoutTemplateLimit,
} from '../subscriptionCore.ts';

describe('subscription helpers', () => {
  describe('tierOf', () => {
    it('defaults to free when profile is null', () => {
      expect(tierOf(null)).toBe('free');
    });

    it('defaults to free when profile is undefined', () => {
      expect(tierOf(undefined)).toBe('free');
    });

    it('defaults to free when subscriptionTier is missing', () => {
      // @ts-expect-error — intentionally constructing a profile without the field
      expect(tierOf({})).toBe('free');
    });

    it('returns the configured tier when present', () => {
      // @ts-expect-error — narrow shape OK for this assertion
      expect(tierOf({ subscriptionTier: 'pro' })).toBe('pro');
      // @ts-expect-error — narrow shape OK for this assertion
      expect(tierOf({ subscriptionTier: 'free' })).toBe('free');
    });

    it('treats an expired trial as free even when cached tier says pro', () => {
      const profile = {
        subscriptionTier: 'pro',
        subscriptionStatus: 'trialing',
        trialEndsAt: '2026-05-10T00:00:00Z',
      } as any;
      expect(tierOf(profile)).toBe('free');
    });

    it('requires trialing profiles to include a future trial end', () => {
      const profile = {
        subscriptionTier: 'pro',
        subscriptionStatus: 'trialing',
      } as any;
      expect(tierOf(profile, Date.parse('2026-05-18T12:00:00Z'))).toBe('free');
    });

    it('uses expiry dates for temporary and promotional pro grants', () => {
      const now = Date.parse('2026-05-18T12:00:00Z');
      expect(tierOf({
        subscriptionTier: 'pro',
        subscriptionStatus: 'temporary',
        subscriptionExpiresAt: '2026-05-19T12:00:00Z',
      } as any, now)).toBe('pro');
      expect(tierOf({
        subscriptionTier: 'pro',
        subscriptionStatus: 'promotional',
        subscriptionExpiresAt: '2026-05-17T12:00:00Z',
      } as any, now)).toBe('free');
    });

    it('fails closed for unknown subscription statuses', () => {
      expect(tierOf({
        subscriptionTier: 'pro',
        subscriptionStatus: 'typo_active',
      } as any, Date.parse('2026-05-18T12:00:00Z'))).toBe('free');
    });
  });

  describe('isPro / isFree', () => {
    it('returns false for null/undefined', () => {
      expect(isPro(null)).toBe(false);
      expect(isPro(undefined)).toBe(false);
      expect(isFree(null)).toBe(true);
      expect(isFree(undefined)).toBe(true);
    });
  });

  describe('labelFor', () => {
    it('returns a non-empty label for every known feature', () => {
      const features = [
        'ai_plan_generation', 'ai_meal_plan', 'ai_coach', 'ai_supplement_lookup', 'apple_health',
      ] as const;
      for (const f of features) {
        const label = labelFor(f);
        expect(typeof label).toBe('string');
        expect(label.length).toBeGreaterThan(0);
      }
    });
  });

  describe('workout template limits', () => {
    it('caps free users at the template limit', () => {
      const freeProfile = { subscriptionTier: 'free' } as any;
      expect(workoutTemplateLimit(freeProfile)).toBe(FREE_WORKOUT_TEMPLATE_LIMIT);
      expect(canCreateWorkoutTemplate(freeProfile, FREE_WORKOUT_TEMPLATE_LIMIT - 1)).toBe(true);
      expect(canCreateWorkoutTemplate(freeProfile, FREE_WORKOUT_TEMPLATE_LIMIT)).toBe(false);
    });

    it('allows unlimited templates for pro users', () => {
      const proProfile = { subscriptionTier: 'pro' } as any;
      expect(workoutTemplateLimit(proProfile)).toBe(Infinity);
      expect(canCreateWorkoutTemplate(proProfile, 100)).toBe(true);
    });
  });

  describe('saved meal limits', () => {
    it('allows unlimited saved meals for free and pro users', () => {
      const freeProfile = { subscriptionTier: 'free' } as any;
      const proProfile = { subscriptionTier: 'pro' } as any;
      expect(savedMealLimit(freeProfile)).toBe(Infinity);
      expect(savedMealLimit(proProfile)).toBe(Infinity);
      expect(canCreateSavedMeal(freeProfile, 500)).toBe(true);
    });
  });

  describe('tier comparison copy', () => {
    it('keeps visible free/pro comparison copy populated with the free caps', () => {
      expect(FREE_TIER_CAPABILITIES.length).toBeGreaterThan(0);
      expect(PRO_TIER_CAPABILITIES.length).toBeGreaterThan(0);
      const freeCopy = FREE_TIER_CAPABILITIES.map(item => item.label).join(' ');
      expect(freeCopy).toContain(String(FREE_WORKOUT_TEMPLATE_LIMIT));
      expect(freeCopy.toLowerCase()).toContain('unlimited saved meals');
      expect(freeCopy).toContain(String(FREE_MEAL_ROUTINE_LIMIT));
      expect(FREE_SAVED_MEAL_LIMIT).toBe(Infinity);
      expect(PRO_TIER_CAPABILITIES.map(item => item.label).join(' ').length).toBeGreaterThan(0);
      expect(SIGNUP_TRIAL_DAYS).toBe(7);
    });
  });

  describe('trial labels', () => {
    it('reports trial days remaining and label', () => {
      const now = Date.parse('2026-05-18T12:00:00Z');
      const profile = {
        subscriptionTier: 'pro',
        subscriptionStatus: 'trialing',
        trialEndsAt: '2026-05-20T12:00:00Z',
      } as any;
      expect(isTrialing(profile, now)).toBe(true);
      expect(trialDaysRemaining(profile, now)).toBe(2);
      expect(subscriptionStatusLabel(profile, now)).toBe('Pro trial · 2 days left');
    });

    it('keeps cancelled signup trials pro until their end date', () => {
      const now = Date.parse('2026-05-18T12:00:00Z');
      const profile = {
        subscriptionTier: 'pro',
        subscriptionStatus: 'trial_cancelled',
        trialEndsAt: '2026-05-20T12:00:00Z',
        subscriptionExpiresAt: '2026-05-20T12:00:00Z',
      } as any;
      expect(tierOf(profile, now)).toBe('pro');
      expect(isTrialing(profile, now)).toBe(false);
      expect(subscriptionStatusLabel(profile, now)).toBe('Pro trial ending · 2 days left');
      expect(tierOf(profile, Date.parse('2026-05-21T12:00:00Z'))).toBe('free');
    });
  });
});
