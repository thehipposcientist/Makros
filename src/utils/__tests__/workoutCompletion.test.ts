import {
  isExtraWorkoutActivitySession,
  manualActivityFromCompletion,
  mergeCompletionIntoWorkoutSession,
  sanitizeWorkoutHistorySession,
} from '../workoutCompletion.ts';

const plannedLegCompletion = {
  id: 1,
  workout_date: '2026-05-04',
  focus_label: 'Legs',
  duration_seconds: 3600,
  completed_at: '2026-05-04T18:00:00.000Z',
  source_context: 'planned',
  activity_category: 'strength',
  activity_subtype: 'legs',
  activity_intensity: 'hard',
} as any;

describe('workout completion hydration', () => {
  it('does not convert planned strength completions into manual activities', () => {
    expect(manualActivityFromCompletion(plannedLegCompletion)).toBe(undefined);

    const merged = mergeCompletionIntoWorkoutSession({
      id: 'local-planned',
      date: '2026-05-04T18:00:00.000Z',
      focus: 'Legs',
      durationSeconds: 3600,
      completed: true,
      exercises: [
        { name: 'Squat', targetSets: 3, targetReps: '5', targetRestSeconds: 120, sets: [{ setNumber: 1, reps: 5, weightLbs: 225 }] },
      ],
      manualActivity: {
        category: 'strength',
        subtype: 'legs',
        intensity: 'hard',
      },
    } as any, plannedLegCompletion);

    expect(merged.manualActivity).toBe(undefined);
    expect(isExtraWorkoutActivitySession(merged)).toBe(false);
  });

  it('hydrates actual manual activity completions', () => {
    const manual = manualActivityFromCompletion({
      ...plannedLegCompletion,
      id: 2,
      focus_label: 'run',
      source_context: 'manual_activity',
      activity_category: 'cardio',
      activity_subtype: 'run',
      activity_intensity: 'moderate',
      activity_source: 'manual',
      distance_miles: 3.1,
      calories_burned: 340,
      hr_summary: { avgBpm: 142 },
    });

    expect(manual).toEqual({
      category: 'cardio',
      subtype: 'run',
      intensity: 'moderate',
      source: 'manual',
      distanceMiles: 3.1,
      caloriesBurned: 340,
      avgHeartRate: 142,
    });
  });

  it('only shows no-exercise manual activities as extra workout activity cards', () => {
    expect(isExtraWorkoutActivitySession({
      id: 'manual-run',
      date: '2026-05-04T19:00:00.000Z',
      focus: 'run',
      durationSeconds: 1800,
      completed: true,
      exercises: [],
      manualActivity: { category: 'cardio', subtype: 'run', intensity: 'moderate' },
    } as any)).toBe(true);

    expect(isExtraWorkoutActivitySession({
      id: 'stale-planned',
      date: '2026-05-04T18:00:00.000Z',
      focus: 'Legs',
      durationSeconds: 3600,
      completed: true,
      exercises: [{ name: 'Squat', targetSets: 3, targetReps: '5', targetRestSeconds: 120, sets: [] }],
      manualActivity: { category: 'strength', subtype: 'legs', intensity: 'hard' },
    } as any)).toBe(false);
  });

  it('scrubs stale manual flags from cached lift history rows', () => {
    const cleaned = sanitizeWorkoutHistorySession({
      id: 'stale-local-row',
      date: '2026-05-04T18:00:00.000Z',
      focus: 'Legs',
      durationSeconds: 3600,
      completed: true,
      exercises: [{ name: 'Squat', targetSets: 3, targetReps: '5', targetRestSeconds: 120, sets: [] }],
      manualActivity: { category: 'strength', subtype: 'legs', intensity: 'hard' },
    } as any);

    expect(cleaned.manualActivity).toBe(undefined);
    expect(cleaned.focus).toBe('Legs');
  });
});
