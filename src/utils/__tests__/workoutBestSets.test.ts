import { buildWorkoutBestSetHighlights } from '../workoutBestSets.ts';

describe('workout best set highlights', () => {
  it('prioritizes heaviest sets over higher-volume backoff sets', () => {
    const rows = buildWorkoutBestSetHighlights([
      {
        name: 'Back Squat',
        targetSets: 3,
        targetReps: '5',
        targetRestSeconds: 120,
        sets: [
          { setNumber: 1, weightLbs: 225, reps: 5 },
          { setNumber: 2, weightLbs: 185, reps: 12 },
        ],
      },
    ] as any);

    expect(rows[0].label).toBe('Back Squat: 225 lb x 5');
    expect(rows[0].detail).toBe('Heaviest set');
  });

  it('shows PRs before normal best sets and dedupes the same exercise by PR priority', () => {
    const rows = buildWorkoutBestSetHighlights([
      {
        name: 'Bench Press',
        targetSets: 3,
        targetReps: '5',
        targetRestSeconds: 120,
        sets: [{ setNumber: 1, weightLbs: 225, reps: 5 }],
      },
      {
        name: 'Row',
        targetSets: 3,
        targetReps: '8',
        targetRestSeconds: 90,
        sets: [{ setNumber: 1, weightLbs: 155, reps: 8 }],
      },
    ] as any, [
      {
        exercise_name: 'Bench Press',
        kind: 'volume_record',
        new_value: 1125,
        old_value: 1000,
        reps: 5,
        weight_lbs: 225,
      },
      {
        exercise_name: 'Bench Press',
        kind: 'heaviest_weight',
        new_value: 225,
        old_value: 215,
        reps: 5,
        weight_lbs: 225,
      },
    ] as any);

    expect(rows[0].label).toBe('PR - Bench Press: 225 lb x 5');
    expect(rows[1].label).toBe('Row: 155 lb x 8');
  });

  it('falls back to existing achievement text when no set data is available', () => {
    const rows = buildWorkoutBestSetHighlights([], [], 4, ['Leg press: 300 lbs x 10']);
    expect(rows).toEqual([
      {
        key: 'fallback-0',
        exerciseName: '',
        label: 'Leg press: 300 lbs x 10',
        source: 'fallback',
      },
    ]);
  });
});
