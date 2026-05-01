// Smoke tests for the subscription tier helpers.
//
// These exist primarily to prevent regression of the launch-blocker fix
// where `tierOf` defaulted to `'pro'`. Defaulting to Pro silently unlocks
// paid features for any user whose profile fetch hasn't resolved yet,
// which is unsafe once StoreKit/RevenueCat is the entitlement authority.
//
// Pure functions only — no React Native runtime needed.

import { FREE_WORKOUT_TEMPLATE_LIMIT, canCreateWorkoutTemplate, isFree, isPro, labelFor, tierOf, workoutTemplateLimit } from '../subscription';

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
        'ai_plan_generation', 'ai_meal_plan', 'ai_coach', 'apple_health',
      ] as const;
      for (const f of features) {
        const label = labelFor(f);
        expect(typeof label).toBe('string');
        expect(label.length).toBeGreaterThan(0);
      }
    });
  });

  describe('workout template limits', () => {
    it('caps free users at three templates', () => {
      const freeProfile = { subscriptionTier: 'free' } as any;
      expect(workoutTemplateLimit(freeProfile)).toBe(FREE_WORKOUT_TEMPLATE_LIMIT);
      expect(canCreateWorkoutTemplate(freeProfile, 2)).toBe(true);
      expect(canCreateWorkoutTemplate(freeProfile, 3)).toBe(false);
    });

    it('allows unlimited templates for pro users', () => {
      const proProfile = { subscriptionTier: 'pro' } as any;
      expect(workoutTemplateLimit(proProfile)).toBe(Infinity);
      expect(canCreateWorkoutTemplate(proProfile, 100)).toBe(true);
    });
  });
});
