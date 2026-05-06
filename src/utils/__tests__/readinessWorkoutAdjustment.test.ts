import {
  recommendReadinessWorkoutAdjustment,
  reduceWorkoutForReadiness,
} from '../readinessWorkoutAdjustment.ts';

function legDay() {
  return {
    day: 'Monday',
    focus: 'Legs',
    stimulus: 'strength',
    exercises: [
      {
        name: 'Back Squat',
        sets: 4,
        reps: '5',
        restSeconds: 120,
        equipment: 'gym',
        primary_muscle: 'quads',
        targetWeightLbs: 200,
        setScheme: [
          { setNumber: 1, setType: 'heavy_top', targetReps: '5', targetRir: 1, targetWeightLbs: 200, progressionMode: 'load_first' },
          { setNumber: 2, setType: 'backoff', targetReps: '6', targetRir: 2, targetWeightLbs: 180, progressionMode: 'load_first' },
          { setNumber: 3, setType: 'backoff', targetReps: '6', targetRir: 2, targetWeightLbs: 180, progressionMode: 'load_first' },
          { setNumber: 4, setType: 'backoff', targetReps: '6', targetRir: 2, targetWeightLbs: 180, progressionMode: 'load_first' },
        ],
      },
      {
        name: 'Leg Curl',
        sets: 3,
        reps: '10-12',
        restSeconds: 60,
        equipment: 'machine',
        primary_muscle: 'hamstrings',
      },
      {
        name: 'Dead Bug',
        sets: 2,
        reps: '10',
        restSeconds: 45,
        equipment: 'bodyweight',
        primary_muscle: 'core',
        _role: 'core',
      },
    ],
  } as any;
}

describe('readiness workout adjustment', () => {
  it('does not recommend changes when focus readiness is normal', () => {
    const rec = recommendReadinessWorkoutAdjustment({
      workout: legDay(),
      focusReadiness: { legs: 0.72 },
      muscleFatigue: { quads: 0.25, hamstrings: 0.25, glutes: 0.2, calves: 0.1 },
    });
    expect(rec).toBe(null);
  });

  it('suggests a lighter heavy day at moderate readiness', () => {
    const rec = recommendReadinessWorkoutAdjustment({
      workout: legDay(),
      focusReadiness: { legs: 0.52 },
      muscleFatigue: { quads: 0.58, hamstrings: 0.45, glutes: 0.32, calves: 0.1 },
    });

    expect(rec?.kind).toBe('lighten');
    expect(rec?.severity).toBe('moderate');
    expect(rec?.readiness).toBe(52);
  });

  it('turns a lighter day into lower volume and lower loading', () => {
    const workout = legDay();
    const rec = recommendReadinessWorkoutAdjustment({
      workout,
      focusReadiness: { legs: 0.38 },
      muscleFatigue: { quads: 0.7, hamstrings: 0.55, glutes: 0.45, calves: 0.1 },
    });
    expect(rec?.kind).toBe('lighten');

    const lighter = reduceWorkoutForReadiness({ workout, recommendation: rec! });
    expect(lighter._source_context).toBe('readiness_lighter_day');
    expect(lighter.stimulus).toBe('hypertrophy');
    expect(lighter.exercises[0].sets).toBe(2);
    expect(lighter.exercises[0].targetWeightLbs).toBe(180);
    expect(lighter.exercises[0].setScheme?.length).toBe(2);
    expect(lighter.exercises[0].setScheme?.[0].targetRir).toBe(3);
    expect(lighter.exercises[2].sets).toBe(2);
  });

  it('suggests recovery below 30 percent readiness', () => {
    const rec = recommendReadinessWorkoutAdjustment({
      workout: legDay(),
      focusReadiness: { legs: 0.24 },
      muscleFatigue: { quads: 0.9, hamstrings: 0.8, glutes: 0.7, calves: 0.4 },
    });

    expect(rec?.kind).toBe('recovery');
    expect(rec?.severity).toBe('very_high');
  });
});
