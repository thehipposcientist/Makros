// Tests for the centralized set-level e1RM helper. Pure function, no
// async. Locks down: Epley math, category-aware rep windows, RIR
// adjustment, and the categorizer that maps exercise flags / names
// onto the three category buckets.

import {
  estimate1RM,
  estimate1RMOrZero,
  formatEstimated1RM,
  setE1RM,
  ONE_RM_REP_LIMIT,
  REP_LIMIT_BY_CATEGORY,
  MAX_EFFECTIVE_REPS_BY_CATEGORY,
  getMaxEffectiveReps,
  categorizeExercise,
} from '../oneRepMax.ts';

describe('setE1RM — pure Epley', () => {
  it('matches Epley exactly: 200 × 5 = 233.33 (rounded to 2dp)', () => {
    // Epley: 200 * (1 + 5/30) = 233.333…
    expect(setE1RM(200, 5, null)).toBe(233.33);
  });

  it('matches Epley exactly: 135 × 8 = 171', () => {
    // 135 * (1 + 8/30) = 171.0
    expect(setE1RM(135, 8, null)).toBe(171);
  });

  it('matches Epley exactly: 315 × 3 = 346.5', () => {
    expect(setE1RM(315, 3, null)).toBe(346.5);
  });

  it('1-rep short-circuit returns the lifted weight unchanged', () => {
    expect(setE1RM(225, 1, null)).toBe(225);
    expect(setE1RM(187.5, 1, null)).toBe(187.5);
  });

  it('rejects invalid inputs', () => {
    expect(setE1RM(0, 5, null)).toBe(null);
    expect(setE1RM(-100, 5, null)).toBe(null);
    expect(setE1RM(100, 0, null)).toBe(null);
    expect(setE1RM(100, -1, null)).toBe(null);
    expect(setE1RM(null, 5, null)).toBe(null);
    expect(setE1RM(NaN, 5, null)).toBe(null);
  });

  it('adds RIR onto reps before applying Epley', () => {
    // 200 × 5 with 2 RIR → effective 7 reps → 200 × (1 + 7/30) = 246.66
    expect(setE1RM(200, 5, 2)).toBe(246.67);
  });

  it('clamps negative RIR to 0 (negative reps in reserve isn\'t a thing)', () => {
    expect(setE1RM(200, 5, -3)).toBe(setE1RM(200, 5, 0));
  });
});

describe('setE1RM — effective rep cap', () => {
  it('main_compound caps effective reps at 10 — 225 × 10 @ 4 RIR → 300, not 330', () => {
    // Raw effective = 14, capped to 10 → 225 × (1 + 10/30) = 300.
    expect(setE1RM(225, 10, 4, 'main_compound')).toBe(300);
    // Default category (omitted) also resolves to main_compound.
    expect(setE1RM(225, 10, 4)).toBe(300);
  });

  it('machine_compound caps effective reps at 12 — 100 × 12 @ 4 RIR → 140, not ~153', () => {
    // Raw effective = 16, capped to 12 → 100 × (1 + 12/30) = 140.
    expect(setE1RM(100, 12, 4, 'machine_compound')).toBe(140);
  });

  it('cap is a no-op when reps + RIR are below the cap', () => {
    // 200 × 5 @ 2 RIR → effective = 7, well under cap 10.
    // Result identical to the pre-cap test up above: 246.67.
    expect(setE1RM(200, 5, 2, 'main_compound')).toBe(246.67);
  });

  it('isolation returns null', () => {
    expect(setE1RM(30, 12, 1, 'isolation')).toBe(null);
  });

  it('exposes the cap table for callers to inspect', () => {
    expect(MAX_EFFECTIVE_REPS_BY_CATEGORY.main_compound).toBe(10);
    expect(MAX_EFFECTIVE_REPS_BY_CATEGORY.machine_compound).toBe(12);
    expect(MAX_EFFECTIVE_REPS_BY_CATEGORY.isolation).toBe(null);
    expect(getMaxEffectiveReps('main_compound')).toBe(10);
    expect(getMaxEffectiveReps('isolation')).toBe(null);
  });
});

describe('estimate1RM — category windows', () => {
  it('main_compound accepts 1–10 reps', () => {
    expect(estimate1RM(225, 1, { category: 'main_compound' })).toBe(225);
    expect(estimate1RM(225, 10, { category: 'main_compound' })! > 0).toBe(true);
  });

  it('main_compound rejects 11+ reps', () => {
    expect(estimate1RM(135, 11, { category: 'main_compound' })).toBe(null);
    expect(estimate1RM(135, 15, { category: 'main_compound' })).toBe(null);
  });

  it('machine_compound accepts 3–12 reps', () => {
    expect(estimate1RM(225, 3, { category: 'machine_compound' })! > 0).toBe(true);
    expect(estimate1RM(225, 12, { category: 'machine_compound' })! > 0).toBe(true);
  });

  it('machine_compound rejects 1–2 reps (machines are noisy at heavy singles)', () => {
    expect(estimate1RM(225, 1, { category: 'machine_compound' })).toBe(null);
    expect(estimate1RM(225, 2, { category: 'machine_compound' })).toBe(null);
  });

  it('machine_compound rejects 13+ reps', () => {
    expect(estimate1RM(225, 13, { category: 'machine_compound' })).toBe(null);
  });

  it('isolation always returns null regardless of reps', () => {
    expect(estimate1RM(50, 5, { category: 'isolation' })).toBe(null);
    expect(estimate1RM(50, 8, { category: 'isolation' })).toBe(null);
    expect(estimate1RM(50, 12, { category: 'isolation' })).toBe(null);
  });

  it('default category is main_compound (preserves behavior of existing call sites)', () => {
    // No category passed → 11 reps should reject
    expect(estimate1RM(135, 11)).toBe(null);
    // 8 reps still scores
    expect(estimate1RM(135, 8)! > 0).toBe(true);
  });

  it('exposes window constants for callers to inspect', () => {
    expect(REP_LIMIT_BY_CATEGORY.main_compound!.min).toBe(1);
    expect(REP_LIMIT_BY_CATEGORY.main_compound!.max).toBe(10);
    expect(REP_LIMIT_BY_CATEGORY.machine_compound!.min).toBe(3);
    expect(REP_LIMIT_BY_CATEGORY.machine_compound!.max).toBe(12);
    expect(REP_LIMIT_BY_CATEGORY.isolation).toBe(null);
    expect(ONE_RM_REP_LIMIT).toBe(10);
  });
});

describe('estimate1RM — RIR effective rep window', () => {
  it('RIR pushes effective reps past the cap → null', () => {
    // 200 × 8, RIR 5 → effective 13 reps, past main_compound cap.
    expect(estimate1RM(200, 8, { rir: 5 })).toBe(null);
  });

  it('RIR within the window is fine', () => {
    // 200 × 5, RIR 2 → effective 7 → in 1–10 → ok
    const r = estimate1RM(200, 5, { rir: 2 })!;
    expect(r > 0).toBe(true);
  });

  it('treats null/undefined RIR the same as 0', () => {
    const a = estimate1RM(200, 5);
    const b = estimate1RM(200, 5, { rir: null });
    const c = estimate1RM(200, 5, { rir: undefined });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe('estimate1RMOrZero', () => {
  it('returns 0 for invalid inputs', () => {
    expect(estimate1RMOrZero(0, 5)).toBe(0);
    expect(estimate1RMOrZero(100, 100)).toBe(0);
    expect(estimate1RMOrZero(null, null)).toBe(0);
  });

  it('returns 0 for isolation category', () => {
    expect(estimate1RMOrZero(100, 5, { category: 'isolation' })).toBe(0);
  });

  it('returns the estimate for valid inputs', () => {
    expect(estimate1RMOrZero(225, 1)).toBe(225);
  });
});

describe('formatEstimated1RM', () => {
  it('formats valid estimates as rounded "X lb"', () => {
    expect(formatEstimated1RM(232.5)).toBe('233 lb');
    expect(formatEstimated1RM(232.1)).toBe('232 lb');
  });

  it('returns "—" for null / zero / negative', () => {
    expect(formatEstimated1RM(null)).toBe('—');
    expect(formatEstimated1RM(0)).toBe('—');
    expect(formatEstimated1RM(-1)).toBe('—');
  });
});

describe('categorizeExercise — flag-based', () => {
  it('isCompound=true + isMachine=false → main_compound', () => {
    expect(categorizeExercise({ isCompound: true, isMachine: false })).toBe('main_compound');
  });

  it('isCompound=true + isMachine=true → machine_compound', () => {
    expect(categorizeExercise({ isCompound: true, isMachine: true })).toBe('machine_compound');
  });

  it('isCompound=false → isolation', () => {
    expect(categorizeExercise({ isCompound: false })).toBe('isolation');
    expect(categorizeExercise({ isCompound: false, isMachine: true })).toBe('isolation');
  });

  it('accepts snake_case fields (legacy data shape)', () => {
    expect(categorizeExercise({ is_compound: true, is_machine: true } as any)).toBe('machine_compound');
  });
});

describe('categorizeExercise — name fallback', () => {
  it('main_compound name patterns', () => {
    expect(categorizeExercise({ name: 'Barbell Back Squat' })).toBe('main_compound');
    expect(categorizeExercise({ name: 'Bench Press' })).toBe('main_compound');
    expect(categorizeExercise({ name: 'Romanian Deadlift' })).toBe('main_compound');
    expect(categorizeExercise({ name: 'Overhead Press' })).toBe('main_compound');
  });

  it('machine_compound name patterns', () => {
    expect(categorizeExercise({ name: 'Lat Pulldown' })).toBe('machine_compound');
    expect(categorizeExercise({ name: 'Leg Press' })).toBe('machine_compound');
    expect(categorizeExercise({ name: 'Hack Squat' })).toBe('machine_compound');
    expect(categorizeExercise({ name: 'Smith Bench Press' })).toBe('machine_compound');
  });

  it('isolation name patterns', () => {
    expect(categorizeExercise({ name: 'Dumbbell Bicep Curl' })).toBe('isolation');
    expect(categorizeExercise({ name: 'Lateral Raise' })).toBe('isolation');
    expect(categorizeExercise({ name: 'Leg Extension' })).toBe('isolation');
    expect(categorizeExercise({ name: 'Pec Deck Fly' })).toBe('isolation');
  });

  it('falls back to isolation for empty / unknown names', () => {
    expect(categorizeExercise({})).toBe('isolation');
    expect(categorizeExercise({ name: '' })).toBe('isolation');
    expect(categorizeExercise({ name: 'wibble wobble' })).toBe('isolation');
  });

  it('explicit flag wins over name heuristic', () => {
    // "lat pulldown" name suggests machine_compound, but explicit
    // isCompound=false should override → isolation.
    expect(categorizeExercise({ name: 'Lat Pulldown', isCompound: false })).toBe('isolation');
  });
});
