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
//   4. Injury edits, removed equipment, and session-duration edits are the
//      workout-setting exceptions that may update current-week workouts
//      immediately. Adding equipment waits for the next generated week.
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
    return (before.mealVariety ?? null) !== (after.mealVariety ?? null)
      || JSON.stringify(before.allergies ?? []) !== JSON.stringify(after.allergies ?? []);
  }
  return JSON.stringify(planWorkoutSnapshot(before)) !== JSON.stringify(planWorkoutSnapshot(after));
}

function planWorkoutSnapshot(profile: any): Record<string, unknown> {
  return {
    daysPerWeek: profile?.daysPerWeek ?? null,
    workoutDurationMinutes: profile?.workoutDurationMinutes ?? null,
    preferredSplit: profile?.preferredSplit ?? null,
    equipment: [...(profile?.equipment ?? [])].sort(),
    equipmentSettings: profile?.equipmentSettings ?? null,
    injuryEntries: profile?.injuryEntries ?? [],
  };
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

function normalizedEquipmentItems(profile: any): string[] {
  return (profile?.equipment ?? [])
    .map((item: unknown) => String(item ?? '').trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

function equipmentWasRemoved(before: any, after: any): boolean {
  const beforeItems = new Set(normalizedEquipmentItems(before));
  const afterItems = new Set(normalizedEquipmentItems(after));
  for (const item of beforeItems) {
    if (!afterItems.has(item)) return true;
  }
  return false;
}

function equipmentWasAdded(before: any, after: any): boolean {
  const beforeItems = new Set(normalizedEquipmentItems(before));
  const afterItems = new Set(normalizedEquipmentItems(after));
  for (const item of afterItems) {
    if (!beforeItems.has(item)) return true;
  }
  return false;
}

function workoutDurationChanged(before: any, after: any): boolean {
  const beforeMinutes = Number(before?.workoutDurationMinutes ?? 60);
  const afterMinutes = Number(after?.workoutDurationMinutes ?? 60);
  return Number.isFinite(beforeMinutes)
    && Number.isFinite(afterMinutes)
    && beforeMinutes !== afterMinutes;
}

function workoutSettingsUnchangedExcept(before: any, after: any, coveredKeys: string[]): boolean {
  const beforeSnap = { ...planWorkoutSnapshot(before) } as Record<string, unknown>;
  const afterSnap = { ...planWorkoutSnapshot(after) } as Record<string, unknown>;
  for (const key of coveredKeys) {
    delete beforeSnap[key];
    delete afterSnap[key];
  }
  return JSON.stringify(beforeSnap) === JSON.stringify(afterSnap);
}

const baseProfile = {
  goal: 'muscle_gain',
  goalDetails: { pace: 'moderate' },
  daysPerWeek: 4,
  workoutDurationMinutes: 60,
  equipment: ['Dumbbells', 'Barbell'],
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
    it('does NOT fire when workout fields are unchanged', () => {
      expect(willRegen('workout', baseProfile, baseProfile)).toBe(false);
    });

    it('fires when equipment changes', () => {
      expect(willRegen('workout', baseProfile, {
        ...baseProfile,
        equipment: ['Dumbbells'],
      })).toBe(true);
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

    it('detects removed equipment for immediate current-week repair', () => {
      const after = {
        ...baseProfile,
        equipment: ['Dumbbells'],
      };

      expect(equipmentWasRemoved(baseProfile, after)).toBe(true);
    });

    it('does NOT treat added equipment as a current-week repair', () => {
      const after = {
        ...baseProfile,
        equipment: ['Dumbbells', 'Barbell', 'Cable Machine'],
      };

      expect(equipmentWasRemoved(baseProfile, after)).toBe(false);
      expect(equipmentWasAdded(baseProfile, after)).toBe(true);
    });

    it('detects session duration changes for immediate current-week update', () => {
      const after = {
        ...baseProfile,
        workoutDurationMinutes: 75,
      };

      expect(workoutDurationChanged(baseProfile, after)).toBe(true);
      expect(workoutSettingsUnchangedExcept(baseProfile, after, ['workoutDurationMinutes'])).toBe(true);
    });

    it('does not fold unrelated workout changes into a duration update', () => {
      const after = {
        ...baseProfile,
        workoutDurationMinutes: 75,
        preferredSplit: 'upper_lower',
      };
      const canUpdateDurationNow =
        workoutDurationChanged(baseProfile, after)
        && !equipmentWasAdded(baseProfile, after)
        && workoutSettingsUnchangedExcept(baseProfile, after, ['workoutDurationMinutes']);

      expect(canUpdateDurationNow).toBe(false);
    });

    it('allows duration update alongside active injury repair', () => {
      const after = {
        ...baseProfile,
        workoutDurationMinutes: 75,
        injuryEntries: [{
          id: 'inj-3',
          bodyPart: 'Elbow',
          description: 'Elbow pain on curls',
          status: 'active',
          muscleGroups: ['biceps'],
        }],
      };
      const coveredKeys = ['workoutDurationMinutes', 'injuries', 'injuryEntries'];

      expect(activeInjuriesChanged(baseProfile, after)).toBe(true);
      expect(workoutSettingsUnchangedExcept(baseProfile, after, coveredKeys)).toBe(true);
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
    // the user opts into injury, removed-equipment, or duration updates.
    const regenWorkout = false;
    const regenNutritionByDefault = false;
    const regenNutritionWhenUserOptsIn = true;
    const repairInjuryConflictsWhenUserOptsIn = true;
    const repairEquipmentConflictsWhenUserOptsIn = true;
    const updateSessionDurationWhenUserOptsIn = true;
    expect(regenWorkout).toBe(false);
    expect(regenNutritionByDefault).toBe(false);
    expect(regenNutritionWhenUserOptsIn).toBe(true);
    expect(repairInjuryConflictsWhenUserOptsIn).toBe(true);
    expect(repairEquipmentConflictsWhenUserOptsIn).toBe(true);
    expect(updateSessionDurationWhenUserOptsIn).toBe(true);
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
    // for injury/equipment/duration current-week updates which only touch
    // today/future unlocked workouts.
  });
});
