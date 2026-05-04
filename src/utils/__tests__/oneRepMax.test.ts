// Tests for the averaged Epley+Brzycki 1RM estimator. Pure helper, no
// async. Verifies the formula matches the literature reference values
// + the rep-count cap is enforced + RIR adjustment works.

import { estimate1RM, estimate1RMOrZero, formatEstimated1RM, ONE_RM_REP_LIMIT } from '../oneRepMax.ts';

describe('estimate1RM — single-rep case', () => {
  it('returns the exact lifted weight when reps = 1', () => {
    expect(estimate1RM(225, 1)).toBe(225);
  });

  it('handles fractional weights', () => {
    expect(estimate1RM(187.5, 1)).toBe(187.5);
  });
});

describe('estimate1RM — averaged Epley + Brzycki', () => {
  it('matches literature reference: 200 lb × 5 reps → ~232 lb', () => {
    // Epley:   200 × (1 + 5/30) = 233.33
    // Brzycki: 200 × 36 / 32    = 225
    // Avg:     ~229.17
    const result = estimate1RM(200, 5);
    expect(result).toBe(229.17);
  });

  it('matches literature reference: 135 lb × 8 reps → ~166 lb', () => {
    // Epley:   135 × (1 + 8/30) = 171
    // Brzycki: 135 × 36 / 29    = 167.59
    // Avg:     169.29
    const result = estimate1RM(135, 8);
    expect(result).toBe(169.29);
  });

  it('matches literature reference: 315 lb × 3 reps → ~336 lb', () => {
    // Epley:   315 × (1 + 3/30) = 346.5
    // Brzycki: 315 × 36 / 34    = 333.53
    // Avg:     ~340.01
    const result = estimate1RM(315, 3);
    expect(result).toBe(340.01);
  });

  it('produces monotonically larger 1RMs as reps increase (same weight)', () => {
    const r1 = estimate1RM(100, 1)!;
    const r5 = estimate1RM(100, 5)!;
    const r10 = estimate1RM(100, 10)!;
    expect(r1 < r5).toBe(true);
    expect(r5 < r10).toBe(true);
  });

  it('produces monotonically larger 1RMs as weight increases (same reps)', () => {
    const w100 = estimate1RM(100, 5)!;
    const w200 = estimate1RM(200, 5)!;
    // Doubling weight should double the estimate (within 1¢ — both
    // values are independently rounded so we can't expect exact
    // equality across every input).
    expect(Math.abs(w200 - w100 * 2) < 0.02).toBe(true);
    expect(w200 > w100).toBe(true);
  });
});

describe('estimate1RM — rep cap', () => {
  it('refuses to estimate for reps > 10', () => {
    expect(estimate1RM(100, 11)).toBe(null);
    expect(estimate1RM(100, 15)).toBe(null);
    expect(estimate1RM(100, 100)).toBe(null);
  });

  it('exposes the rep limit for callers to display matching copy', () => {
    expect(ONE_RM_REP_LIMIT).toBe(10);
  });

  it('still estimates exactly at the boundary (10 reps)', () => {
    const result = estimate1RM(100, 10);
    expect(result != null && result > 0).toBe(true);
  });
});

describe('estimate1RM — invalid inputs', () => {
  it('returns null for zero weight', () => {
    expect(estimate1RM(0, 5)).toBe(null);
  });

  it('returns null for negative weight', () => {
    expect(estimate1RM(-10, 5)).toBe(null);
  });

  it('returns null for zero reps', () => {
    expect(estimate1RM(100, 0)).toBe(null);
  });

  it('returns null for negative reps', () => {
    expect(estimate1RM(100, -1)).toBe(null);
  });

  it('returns null for null / undefined inputs', () => {
    expect(estimate1RM(null, 5)).toBe(null);
    expect(estimate1RM(100, null)).toBe(null);
    expect(estimate1RM(undefined, 5)).toBe(null);
    expect(estimate1RM(100, undefined)).toBe(null);
  });

  it('returns null for NaN', () => {
    expect(estimate1RM(NaN, 5)).toBe(null);
    expect(estimate1RM(100, NaN)).toBe(null);
  });
});

describe('estimate1RM — RIR adjustment', () => {
  it('adds RIR to effective reps before estimating', () => {
    // 200 × 5 with 2 RIR → effective 7 reps (could have done 7 to failure)
    const noRir = estimate1RM(200, 5)!;
    const withRir = estimate1RM(200, 5, { rir: 2 })!;
    expect(withRir > noRir).toBe(true);
    // Should equal the same as 200 × 7 reps with no RIR.
    expect(withRir).toBe(estimate1RM(200, 7));
  });

  it('treats negative RIR as 0 (lifter went past failure)', () => {
    expect(estimate1RM(200, 5, { rir: -2 })).toBe(estimate1RM(200, 5));
  });

  it('treats RIR=0 the same as no RIR', () => {
    expect(estimate1RM(200, 5, { rir: 0 })).toBe(estimate1RM(200, 5));
  });

  it('returns null when reps + RIR exceeds the cap', () => {
    // 200 × 8 with 5 RIR → effective 13 reps → past the cap.
    expect(estimate1RM(200, 8, { rir: 5 })).toBe(null);
  });

  it('handles fractional RIR (rare but possible)', () => {
    const a = estimate1RM(100, 5, { rir: 1 })!;
    const b = estimate1RM(100, 5, { rir: 1.5 })!;
    expect(b > a).toBe(true);
  });
});

describe('estimate1RMOrZero', () => {
  it('returns 0 for invalid inputs', () => {
    expect(estimate1RMOrZero(0, 5)).toBe(0);
    expect(estimate1RMOrZero(100, 100)).toBe(0);
    expect(estimate1RMOrZero(null, null)).toBe(0);
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
