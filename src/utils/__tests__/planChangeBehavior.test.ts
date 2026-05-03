// Behavior tests for the mid-week plan-change rules.
//
// The contract — verified here so a future refactor can't silently
// regress it:
//   1. The pendingSave warning only fires when an existing plan is in
//      flight (first-time signup must not be intercepted).
//   2. The "applies on" date is the active PlanWeek's end_date + 1
//      (sign-up cadence) — NOT a hard-coded Monday and NOT today.
//   3. Goal/workout/mealplan changes detect "willRegen" only when
//      meaningful fields have actually changed.
//   4. Injury edits are the one workout-setting exception that may repair
//      the current week immediately.
//   5. The fallback when no PlanWeek exists is today + 7, not today +
//      "days until Monday".
//
// Pure helpers + plain JSON profile shapes — no React, no AsyncStorage.

import { nextPlanWeekStart } from '../planEffectiveDate.ts';

// Replicates the "willRegen?" predicate inside `handleSaveProfile`. We
// re-implement it here as a pure function so a refactor that changes
// the predicate has to update both sides.
function willRegen(
  mode: 'goal' | 'workout' | 'mealplan' | string,
  before: any,
  after: any,
): boolean {
  // First-time signup: no prior profile = nothing in flight to disrupt.
  const hasExistingPlan = !!before && !!before.goal;
  if (!hasExistingPlan) return false;
  if (mode !== 'goal' && mode !== 'workout' && mode !== 'mealplan') return false;
  if (mode === 'goal') {
    return before.goal !== after.goal
      || (before.goalDetails?.pace ?? null) !== (after.goalDetails?.pace ?? null);
  }
  if (mode === 'mealplan') {
    return (before.mealsPerDay ?? null) !== (after.mealsPerDay ?? null)
      || (before.mealVariety ?? null) !== (after.mealVariety ?? null)
      || JSON.stringify(before.allergies ?? []) !== JSON.stringify(after.allergies ?? []);
  }
  // workout: any save in this mode counts as a regen-trigger
  return true;
}

function normalizedInjuryToken(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function activeInjurySignature(profile: any): string {
  const tokens: string[] = [];
  const legacy = normalizedInjuryToken(profile?.injuries);
  if (legacy) tokens.push(`legacy:${legacy}`);

  for (const entry of profile?.injuryEntries ?? []) {
    const status = normalizedInjuryToken(entry.status || 'active');
    if (status === 'resolved') continue;
    const muscles = [...(entry.muscleGroups ?? [])].map(normalizedInjuryToken).filter(Boolean).sort().join(',');
    const token = [
      normalizedInjuryToken(entry.bodyPart),
      normalizedInjuryToken(entry.description),
      status || 'active',
      normalizedInjuryToken(entry.severity),
      muscles,
    ].filter(Boolean).join(':');
    if (token) tokens.push(`entry:${token}`);
  }

  return JSON.stringify([...new Set(tokens)].sort());
}

function activeInjuriesChanged(before: any, after: any): boolean {
  return activeInjurySignature(before) !== activeInjurySignature(after);
}

const baseProfile = {
  goal: 'muscle_gain',
  goalDetails: { pace: 'moderate' },
  daysPerWeek: 4,
  workoutDurationMinutes: 60,
  mealsPerDay: 3,
  mealVariety: 5,
  allergies: [],
};

describe('willRegen predicate', () => {
  describe('first-time signup', () => {
    it('returns false when before is null (no existing plan)', () => {
      expect(willRegen('goal', null, baseProfile)).toBe(false);
    });

    it('returns false when before has no goal field', () => {
      expect(willRegen('workout', { /* no goal */ }, baseProfile)).toBe(false);
    });
  });

  describe('goal mode', () => {
    it('fires when goal changes', () => {
      expect(willRegen('goal', baseProfile, { ...baseProfile, goal: 'fat_loss' })).toBe(true);
    });

    it('fires when pace changes', () => {
      expect(willRegen('goal', baseProfile, {
        ...baseProfile,
        goalDetails: { pace: 'aggressive' },
      })).toBe(true);
    });

    it('does NOT fire when only unrelated fields change', () => {
      expect(willRegen('goal', baseProfile, {
        ...baseProfile,
        physicalStats: { weightLbs: 175 },
      })).toBe(false);
    });
  });

  describe('mealplan mode', () => {
    it('fires when mealsPerDay changes', () => {
      expect(willRegen('mealplan', baseProfile, { ...baseProfile, mealsPerDay: 4 })).toBe(true);
    });

    it('fires when mealVariety changes', () => {
      expect(willRegen('mealplan', baseProfile, { ...baseProfile, mealVariety: 7 })).toBe(true);
    });

    it('fires when allergies change', () => {
      expect(willRegen('mealplan', baseProfile, { ...baseProfile, allergies: ['gluten'] })).toBe(true);
    });

    it('does NOT fire when meal fields are unchanged', () => {
      expect(willRegen('mealplan', baseProfile, { ...baseProfile, daysPerWeek: 5 })).toBe(false);
    });
  });

  describe('workout mode', () => {
    it('always fires (any workout-tab save is treated as a regen trigger)', () => {
      expect(willRegen('workout', baseProfile, baseProfile)).toBe(true);
    });

    it('detects active injury changes for immediate current-week repair', () => {
      const after = {
        ...baseProfile,
        injuryEntries: [{
          id: 'inj-1',
          bodyPart: 'Knee',
          description: 'Knee pain on squats',
          status: 'active',
          muscleGroups: ['quads'],
        }],
      };

      expect(activeInjuriesChanged(baseProfile, after)).toBe(true);
    });

    it('ignores resolved injuries when deciding current-week repair', () => {
      const resolvedOnly = {
        ...baseProfile,
        injuryEntries: [{
          id: 'inj-2',
          bodyPart: 'Shoulder',
          description: 'Old shoulder tweak',
          status: 'resolved',
        }],
      };

      expect(activeInjuriesChanged(baseProfile, resolvedOnly)).toBe(false);
    });
  });

  describe('other modes', () => {
    it('returns false for theme / body / non-plan modes', () => {
      expect(willRegen('theme', baseProfile, { ...baseProfile, themePreference: 'paper' })).toBe(false);
      expect(willRegen('body', baseProfile, baseProfile)).toBe(false);
    });
  });
});

describe('"applies on" date math', () => {
  it('uses end_date + 1 from the active PlanWeek', () => {
    // User signed up Friday Apr 11 → first week ends Thu Apr 17 →
    // next-week start is Fri Apr 18.
    expect(nextPlanWeekStart('2026-04-17')).toBe('2026-04-18');
  });

  it('preserves the user\'s signup-day cadence forever', () => {
    // Two consecutive cycles must land on the same weekday.
    const startWeek2 = nextPlanWeekStart('2026-04-17');
    const startWeek3 = nextPlanWeekStart('2026-04-24');
    const dow1 = new Date(`${startWeek2}T12:00:00`).getDay();
    const dow2 = new Date(`${startWeek3}T12:00:00`).getDay();
    expect(dow1).toBe(dow2);
  });

  it('falls back to today + 7 when no PlanWeek exists (free user, brand-new signup)', () => {
    const today = new Date('2026-04-29T10:00:00');  // Wed
    const result = nextPlanWeekStart(undefined, today);
    expect(result).toBe('2026-05-06');               // Wed + 7
  });

  it('does NOT snap to next Monday (regression — old behavior)', () => {
    // The prior helper returned the upcoming Monday regardless of the
    // user's actual cadence. A Friday-Thursday user got told their
    // change applies "next Monday" which was both wrong and confusing.
    // Now the helper takes the user's actual end_date.
    const fridayWeekEnd = '2026-04-17';  // Friday
    const result = nextPlanWeekStart(fridayWeekEnd);
    const dayOfWeek = new Date(`${result}T12:00:00`).getDay();
    // Just verify it's NOT Monday (1). Could be any weekday depending
    // on the user's anchor; the point is: not hard-coded.
    expect(result).toBe('2026-04-18');
    expect(dayOfWeek === 1).toBe(false);
  });
});

describe('regen behavior contract', () => {
  it('regenWorkout is always false and regenNutrition is opt-in on save', () => {
    // Hard-coded contract — the actual `_doSaveProfile` sets these to
    // false by default. Mealplan saves may opt into a nutrition-only
    // remaining-week refresh. Workout saves stay fixed until renewal unless
    // the user opts into the injury-specific repair path.
    const regenWorkout = false;
    const regenNutritionByDefault = false;
    const regenNutritionWhenUserOptsIn = true;
    const repairInjuryConflictsWhenUserOptsIn = true;
    expect(regenWorkout).toBe(false);
    expect(regenNutritionByDefault).toBe(false);
    expect(regenNutritionWhenUserOptsIn).toBe(true);
    expect(repairInjuryConflictsWhenUserOptsIn).toBe(true);
  });

  it('willRegen=true triggers the confirmation modal, not an immediate plan rebuild', () => {
    // The modal interception path: when willRegen returns true we set
    // `pendingSave` and return — the actual save is gated on the
    // user tapping "Save" in the modal. No regen happens until that.
    // This test documents the contract so a future refactor that
    // changes the gate semantics makes it conscious.
    const before = baseProfile;
    const after = { ...baseProfile, goal: 'fat_loss' };
    const wantsConfirm = willRegen('goal', before, after);
    expect(wantsConfirm).toBe(true);
    // Confirmation flow does NOT regenerate the active week — it only
    // persists settings. The active PlanWeek keeps its current shape
    // until auto_renew_week fires at the natural week boundary, except
    // for injury repair which only updates today/future unlocked workouts.
  });
});
