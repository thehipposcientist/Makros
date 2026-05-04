// Tests for the session-to-payload converter. This runs on every
// completed workout — the output ships to the backend and to HealthKit.
// Bugs here corrupt logged history.

import {
  sessionExercisesToLoggedPayload,
  workoutSessionToLoggedPayload,
} from '../workoutLogPayload.ts';

describe('sessionExercisesToLoggedPayload — input validation', () => {
  it('returns [] for null', () => {
    expect(sessionExercisesToLoggedPayload(null)).toEqual([]);
  });
  it('returns [] for undefined', () => {
    expect(sessionExercisesToLoggedPayload(undefined)).toEqual([]);
  });
  it('returns [] for non-array', () => {
    expect(sessionExercisesToLoggedPayload('not an array' as any)).toEqual([]);
  });
  it('returns [] for empty array', () => {
    expect(sessionExercisesToLoggedPayload([])).toEqual([]);
  });
  it('drops exercises with no name', () => {
    const out = sessionExercisesToLoggedPayload([
      { sets: [] } as any,
      { name: '', sets: [] } as any,
      { name: 'Bench Press', sets: [] } as any,
    ]);
    expect(out.length).toBe(1);
    expect(out[0].name).toBe('Bench Press');
  });
});

describe('sessionExercisesToLoggedPayload — order_index', () => {
  it('preserves the input order via order_index', () => {
    const out = sessionExercisesToLoggedPayload([
      { name: 'A', sets: [] } as any,
      { name: 'B', sets: [] } as any,
      { name: 'C', sets: [] } as any,
    ]);
    expect(out.map(e => e.order_index)).toEqual([0, 1, 2]);
  });

  it('reindexes after dropping nameless entries (index reflects emitted position, not original)', () => {
    const out = sessionExercisesToLoggedPayload([
      { name: 'A', sets: [] } as any,
      { sets: [] } as any,        // dropped
      { name: 'B', sets: [] } as any,
    ]);
    // .filter then .map happens — so 'B' lands at original index 1 (post-filter)
    // since map runs against the filtered array.
    expect(out.length).toBe(2);
    expect(out[0].name).toBe('A');
    expect(out[0].order_index).toBe(0);
    expect(out[1].name).toBe('B');
    expect(out[1].order_index).toBe(1);
  });
});

describe('sessionExercisesToLoggedPayload — set normalization', () => {
  it('parses numeric strings into numbers', () => {
    const out = sessionExercisesToLoggedPayload([{
      name: 'Squat',
      sets: [{ setNumber: '1', reps: '5', weightLbs: '225.5' }],
    }] as any);
    expect(out[0].sets[0].set_number).toBe(1);
    expect(out[0].sets[0].reps).toBe(5);
    expect(out[0].sets[0].weight_lbs).toBe(225.5);
  });
  it('falls back to set position when set_number is missing', () => {
    const out = sessionExercisesToLoggedPayload([{
      name: 'Curl',
      sets: [{ reps: 10 }, { reps: 8 }, { reps: 6 }],
    }] as any);
    expect(out[0].sets.map(s => s.set_number)).toEqual([1, 2, 3]);
  });
  it('discards NaN-producing strings (returns undefined)', () => {
    const out = sessionExercisesToLoggedPayload([{
      name: 'Squat',
      sets: [{ reps: 'abc', weightLbs: '' }],
    }] as any);
    expect(out[0].sets[0].reps).toBe(undefined);
    expect(out[0].sets[0].weight_lbs).toBe(undefined);
  });
  it('discards Infinity / -Infinity', () => {
    const out = sessionExercisesToLoggedPayload([{
      name: 'Squat',
      sets: [{ reps: Infinity, weightLbs: -Infinity }],
    }] as any);
    expect(out[0].sets[0].reps).toBe(undefined);
    expect(out[0].sets[0].weight_lbs).toBe(undefined);
  });
});

describe('sessionExercisesToLoggedPayload — snake/camel coalescing', () => {
  it('reads weight_lbs (snake) when weightLbs absent', () => {
    const out = sessionExercisesToLoggedPayload([{
      name: 'Squat',
      sets: [{ weight_lbs: 225 }],
    }] as any);
    expect(out[0].sets[0].weight_lbs).toBe(225);
  });
  it('camel takes precedence over snake when both present', () => {
    const out = sessionExercisesToLoggedPayload([{
      name: 'Squat',
      sets: [{ weightLbs: 250, weight_lbs: 999 }],
    }] as any);
    expect(out[0].sets[0].weight_lbs).toBe(250);
  });
  it('reads cardio_metrics from either casing', () => {
    const o1 = sessionExercisesToLoggedPayload([{
      name: 'Run',
      sets: [{ cardioMetrics: { hr: 150 } }],
    }] as any);
    const o2 = sessionExercisesToLoggedPayload([{
      name: 'Run',
      sets: [{ cardio_metrics: { hr: 160 } }],
    }] as any);
    expect((o1[0].sets[0].cardio_metrics as any).hr).toBe(150);
    expect((o2[0].sets[0].cardio_metrics as any).hr).toBe(160);
  });
});

describe('sessionExercisesToLoggedPayload — exercise metadata', () => {
  it('reads slug from any of slug / exerciseSlug / _slug', () => {
    const a = sessionExercisesToLoggedPayload([{ name: 'A', slug: 's1', sets: [] }] as any);
    const b = sessionExercisesToLoggedPayload([{ name: 'B', exerciseSlug: 's2', sets: [] }] as any);
    const c = sessionExercisesToLoggedPayload([{ name: 'C', _slug: 's3', sets: [] }] as any);
    expect(a[0].slug).toBe('s1');
    expect(b[0].slug).toBe('s2');
    expect(c[0].slug).toBe('s3');
  });
  it('falls back to sets.length when targetSets missing', () => {
    const out = sessionExercisesToLoggedPayload([{
      name: 'Squat',
      sets: [{ reps: 5 }, { reps: 5 }, { reps: 5 }],
    }] as any);
    expect(out[0].target_sets).toBe(3);
  });
  it('uses targetSets when present even if sets array is shorter', () => {
    const out = sessionExercisesToLoggedPayload([{
      name: 'Squat',
      targetSets: 5,
      sets: [{ reps: 5 }, { reps: 5 }],  // user only logged 2 of 5
    }] as any);
    expect(out[0].target_sets).toBe(5);
  });
  it('preserves null vs string for targetReps (passes string through)', () => {
    const a = sessionExercisesToLoggedPayload([{ name: 'A', targetReps: '6-8', sets: [] }] as any);
    const b = sessionExercisesToLoggedPayload([{ name: 'B', sets: [] }] as any);
    expect(a[0].target_reps).toBe('6-8');
    expect(b[0].target_reps).toBe(null);
  });
});

describe('sessionExercisesToLoggedPayload — null defaults', () => {
  it('null-safety: feedback non-string → null', () => {
    const out = sessionExercisesToLoggedPayload([{
      name: 'Squat',
      sets: [{ feedback: 123 }],
    }] as any);
    expect(out[0].sets[0].feedback).toBe(null);
  });
  it('actual_pace must be a string or it becomes null', () => {
    const out = sessionExercisesToLoggedPayload([{
      name: 'Run',
      sets: [{ actualPace: 360 }],
    }] as any);
    expect(out[0].sets[0].actual_pace).toBe(null);
  });
});

describe('workoutSessionToLoggedPayload', () => {
  it('delegates to sessionExercisesToLoggedPayload via session.exercises', () => {
    const session = {
      exercises: [{ name: 'Bench', sets: [{ reps: 5, weightLbs: 185 }] }],
    } as any;
    const out = workoutSessionToLoggedPayload(session);
    expect(out.length).toBe(1);
    expect(out[0].name).toBe('Bench');
    expect(out[0].sets[0].weight_lbs).toBe(185);
  });
  it('handles a session with no exercises array', () => {
    expect(workoutSessionToLoggedPayload({} as any)).toEqual([]);
  });
});
