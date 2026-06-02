import {
  appleHealthMetricsFromWorkoutSession,
  isExtraWorkoutActivitySession,
  manualActivityFromCompletion,
  mergeCompletionIntoWorkoutSession,
  mergeSessionIntoWorkoutSummary,
  sanitizeWorkoutHistorySession,
  workoutSessionCountsForPlan,
  workoutSummaryFromCompletion,
  workoutSummaryFromSession,
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

  it('hydrates imported Strava completions with details', () => {
    const manual = manualActivityFromCompletion({
      ...plannedLegCompletion,
      id: 22,
      focus_label: 'Cycling',
      source_context: 'import_strava',
      import_source: 'strava',
      activity_category: 'cardio',
      activity_subtype: 'Ride',
      activity_intensity: 'moderate',
      activity_source: 'strava',
      distance_miles: 12.4,
      calories_burned: 520,
      activity_details: {
        movingSeconds: 2400,
        elapsedSeconds: 2520,
        elevationGainFt: 610,
        avgWatts: 184,
      },
      hr_summary: { avgBpm: 148 },
    });

    expect(manual).toEqual({
      category: 'cardio',
      subtype: 'Ride',
      intensity: 'moderate',
      source: 'strava',
      distanceMiles: 12.4,
      caloriesBurned: 520,
      avgHeartRate: 148,
      details: {
        movingSeconds: 2400,
        elapsedSeconds: 2520,
        elevationGainFt: 610,
        avgWatts: 184,
      },
    });
  });

  it('hydrates custom strength completions as user-logged workouts', () => {
    const custom = manualActivityFromCompletion({
      ...plannedLegCompletion,
      id: 3,
      focus_label: 'Custom Upper',
      source_context: 'custom_strength',
      activity_category: 'strength',
      activity_subtype: 'custom_upper',
      activity_intensity: 'hard',
    });

    expect(custom).toEqual({
      category: 'strength',
      subtype: 'custom_upper',
      intensity: 'hard',
      source: 'live_tracker',
    });
  });

  it('hydrates custom cardio completions as live-tracked workouts', () => {
    const custom = manualActivityFromCompletion({
      ...plannedLegCompletion,
      id: 4,
      focus_label: 'Run',
      source_context: 'custom_cardio',
      activity_category: 'cardio',
      activity_subtype: 'run',
      activity_intensity: 'moderate',
      distance_miles: 3.2,
      hr_summary: { avgBpm: 151 },
    });

    expect(custom).toEqual({
      category: 'cardio',
      subtype: 'run',
      intensity: 'moderate',
      source: 'live_tracker',
      distanceMiles: 3.2,
      avgHeartRate: 151,
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

  it('shows custom workouts as extras unless they target a PlanDay', () => {
    expect(isExtraWorkoutActivitySession({
      id: 'custom-upper',
      date: '2026-05-04T18:00:00.000Z',
      focus: 'Upper',
      durationSeconds: 3600,
      completed: true,
      sourceContext: 'custom_strength',
      exercises: [{ name: 'Bench', targetSets: 3, targetReps: '8', targetRestSeconds: 90, sets: [{ reps: 8, weightLbs: 135 }] }],
    } as any)).toBe(true);

    expect(isExtraWorkoutActivitySession({
      id: 'manual-plan-custom',
      date: '2026-05-04T18:00:00.000Z',
      focus: 'Upper',
      durationSeconds: 3600,
      completed: true,
      sourceContext: 'custom_strength',
      planDayId: 42,
      exercises: [{ name: 'Bench', targetSets: 3, targetReps: '8', targetRestSeconds: 90, sets: [{ reps: 8, weightLbs: 135 }] }],
    } as any)).toBe(false);
  });

  it('does not let custom cardio satisfy the scheduled workout', () => {
    const customRide = {
      id: 'ride',
      date: '2026-05-04T18:00:00.000Z',
      focus: 'Ride',
      durationSeconds: 1800,
      completed: true,
      exercises: [],
      sourceContext: 'custom_cardio',
      manualActivity: { category: 'cardio', subtype: 'ride', intensity: 'moderate' },
    } as any;

    expect(isExtraWorkoutActivitySession(customRide)).toBe(true);
    expect(workoutSessionCountsForPlan(customRide)).toBe(false);
  });

  it('only counts template completions for the plan when a PlanDay id is present', () => {
    expect(workoutSessionCountsForPlan({
      id: 'template-extra',
      date: '2026-05-04T18:00:00.000Z',
      focus: 'Push',
      durationSeconds: 3600,
      completed: true,
      sourceContext: 'saved_template',
      exercises: [{ name: 'Bench', targetSets: 3, targetReps: '8', targetRestSeconds: 90, sets: [{ reps: 8, weightLbs: 135 }] }],
    } as any)).toBe(false);

    expect(workoutSessionCountsForPlan({
      id: 'template-plan',
      date: '2026-05-04T18:00:00.000Z',
      focus: 'Push',
      durationSeconds: 3600,
      completed: true,
      sourceContext: 'saved_template',
      planDayId: 42,
      exercises: [{ name: 'Bench', targetSets: 3, targetReps: '8', targetRestSeconds: 90, sets: [{ reps: 8, weightLbs: 135 }] }],
    } as any)).toBe(true);
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

  it('fills completion-only summaries from the matching session sets', () => {
    const completion = {
      ...plannedLegCompletion,
      external_source_id: 'local-planned',
      calories_burned: 213,
      hr_summary: { avgBpm: 128, maxBpm: 161, zoneMinutes: [4, 12, 18, 5, 0] },
    } as any;
    const completionOnly = workoutSummaryFromCompletion(completion)!;
    const sessionSummary = workoutSummaryFromSession({
      id: 'local-planned',
      date: '2026-05-04T18:00:00.000Z',
      focus: 'Legs',
      durationSeconds: 3600,
      completed: true,
      sourceContext: 'planned',
      exercises: [
        {
          name: 'Squat',
          targetSets: 2,
          targetReps: '5',
          targetRestSeconds: 120,
          equipment: 'barbell',
          sets: [
            { setNumber: 1, reps: 5, weightLbs: 225 },
            { setNumber: 2, reps: 5, weightLbs: 225 },
          ],
        },
        {
          name: 'Leg Press',
          targetSets: 1,
          targetReps: '8',
          targetRestSeconds: 90,
          equipment: 'machine',
          sets: [{ setNumber: 1, reps: 8, weightLbs: 360 }],
        },
      ],
    } as any, completion)!;

    const merged = mergeSessionIntoWorkoutSummary(
      { ...completionOnly, headline: 'AI recap stays put' },
      sessionSummary,
    );

    expect(completionOnly.totalSets).toBe(0);
    expect(completionOnly.totalReps).toBe(0);
    expect(merged.totalSets).toBe(3);
    expect(merged.totalReps).toBe(18);
    expect(merged.caloriesBurned).toBe(213);
    expect(merged.hrAvg).toBe(128);
    expect(merged.headline).toBe('AI recap stays put');
    expect(merged.exercises?.map(ex => ex.name)).toEqual(['Squat', 'Leg Press']);
  });

  it('hydrates completion-only summaries from persisted training scores', () => {
    const summary = workoutSummaryFromCompletion({
      ...plannedLegCompletion,
      id: 31,
      training_score: 82,
      training_rating: 'Crushed',
      training_pillars: { effort: 28, volume: 22, duration: 14, consistency: 12 },
      training_pillar_breakdown: [
        { key: 'stimulus', label: 'Stimulus', value: 28, max: 30, present: true },
      ],
    } as any);

    expect(summary?.trainingScore).toBe(82);
    expect(summary?.trainingRating).toBe('Crushed');
    expect(summary?.trainingPillars?.effort).toBe(28);
    expect(summary?.trainingPillarBreakdown?.[0]?.key).toBe('stimulus');
  });

  it('lets Apple Health completion metrics override local estimates', () => {
    const appleCompletion = {
      ...plannedLegCompletion,
      id: 12,
      source_context: 'apple_health',
      activity_category: 'cardio',
      activity_subtype: 'walk',
      activity_source: 'apple_health',
      import_source: 'apple_health',
      calories_burned: 118,
      hr_summary: { avgBpm: 104, maxBpm: 132, zoneMinutes: [18, 9, 2, 0, 0] },
    } as any;

    const summary = workoutSummaryFromSession({
      id: 'local-walk',
      date: '2026-05-04T18:00:00.000Z',
      focus: 'Walk',
      durationSeconds: 1800,
      completed: true,
      exercises: [],
      sourceContext: 'custom_cardio',
      manualActivity: {
        category: 'cardio',
        subtype: 'walk',
        intensity: 'easy',
        source: 'live_tracker',
        caloriesBurned: 260,
        avgHeartRate: 91,
      },
    } as any, appleCompletion)!;

    expect(summary.caloriesBurned).toBe(118);
    expect(summary.hrAvg).toBe(104);
    expect(summary.hrMax).toBe(132);
    expect(summary.hrZoneMinutes).toEqual([18, 9, 2, 0, 0]);
    expect(appleHealthMetricsFromWorkoutSession({
      id: 'hk-walk',
      date: '2026-05-04T18:00:00.000Z',
      focus: 'Walk',
      durationSeconds: 1800,
      completed: true,
      exercises: [],
      manualActivity: {
        category: 'cardio',
        subtype: 'walk',
        source: 'apple_health',
        caloriesBurned: 118,
        avgHeartRate: 104,
      },
    } as any)).toEqual({
      caloriesBurned: 118,
      hrSummary: { avgBpm: 104, maxBpm: 104, zoneMinutes: [] },
    });
  });

  it('keeps local manual estimates when the completion is not from Apple Health', () => {
    const manualCompletion = {
      ...plannedLegCompletion,
      id: 13,
      source_context: 'manual_activity',
      activity_category: 'cardio',
      activity_subtype: 'walk',
      calories_burned: 118,
      hr_summary: { avgBpm: 104, maxBpm: 132, zoneMinutes: [18, 9, 2, 0, 0] },
    } as any;

    const summary = workoutSummaryFromSession({
      id: 'manual-walk',
      date: '2026-05-04T18:00:00.000Z',
      focus: 'Walk',
      durationSeconds: 1800,
      completed: true,
      exercises: [],
      manualActivity: {
        category: 'cardio',
        subtype: 'walk',
        intensity: 'easy',
        source: 'manual',
        caloriesBurned: 260,
        avgHeartRate: 91,
      },
    } as any, manualCompletion)!;

    expect(summary.caloriesBurned).toBe(260);
    expect(summary.hrAvg).toBe(91);
  });
});
