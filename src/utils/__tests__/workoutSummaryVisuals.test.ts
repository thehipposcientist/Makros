(globalThis as any).require = (id: string) => id;

const {
  workoutSummaryBackgroundKey,
  workoutSummaryIsCardioLike,
  workoutSummaryTypeLabel,
} = await import('../workoutSummaryVisuals.ts');

describe('workout summary visuals', () => {
  it('uses explicit walk activity metadata over stale run focus text', () => {
    const input = {
      focus: 'Outdoor Run',
      activityCategory: 'cardio',
      activitySubtype: 'walk',
      sourceContext: 'apple_health',
    };

    expect(workoutSummaryBackgroundKey(input)).toBe('walking');
    expect(workoutSummaryTypeLabel(input)).toBe('Walk');
  });

  it('does not render imported core training as cardio', () => {
    const input = {
      focus: 'Core Training',
      activityCategory: 'cardio',
      activitySubtype: 'Core Training',
      sourceContext: 'apple_health',
    };

    expect(workoutSummaryBackgroundKey(input)).toBe('gym');
    expect(workoutSummaryTypeLabel(input)).toBe('Strength');
  });

  it('keeps lower-body strength summaries from falling through to walk art', () => {
    const input = {
      focus: 'Lower',
      stimulus: 'hypertrophy',
      exercises: [
        { name: 'Walking Lunge', primary_muscle: 'quads' },
        { name: 'Romanian Deadlift', primary_muscle: 'hamstrings' },
      ],
    };

    expect(workoutSummaryBackgroundKey(input)).toBe('squat');
    expect(workoutSummaryTypeLabel(input)).toBe('Lower Body');
    expect(workoutSummaryIsCardioLike(input)).toBe(false);
  });

  it('uses declared strength focus before incidental cardio-like exercise names', () => {
    const cases = [
      { focus: 'Push', exercise: 'Treadmill Walk', key: 'press', label: 'Push' },
      { focus: 'Pull', exercise: 'Farmer Walk', key: 'row', label: 'Pull' },
      { focus: 'Upper', exercise: 'Treadmill Walk', key: 'press', label: 'Upper Body' },
      { focus: 'Full Body', exercise: 'Battle Rope Finisher', key: 'gym', label: 'Full Body' },
      { focus: 'Arms', exercise: 'Easy Jog', key: 'press', label: 'Arms' },
      { focus: 'Shoulders', exercise: 'Walkout Plank', key: 'press', label: 'Shoulders' },
    ];

    for (const item of cases) {
      const input = {
        focus: item.focus,
        stimulus: 'hypertrophy',
        exercises: [{ name: item.exercise, primary_muscle: 'chest' }],
      };

      expect(workoutSummaryBackgroundKey(input)).toBe(item.key);
      expect(workoutSummaryTypeLabel(input)).toBe(item.label);
      expect(workoutSummaryIsCardioLike(input)).toBe(false);
    }
  });

  it('does not confuse pilates with lats or warmup with arms', () => {
    expect(workoutSummaryBackgroundKey({ focus: 'Pilates' })).toBe('pilates');
    expect(workoutSummaryTypeLabel({ focus: 'Pilates' })).toBe('Pilates');

    expect(workoutSummaryBackgroundKey({ focus: 'Cardio Warmup' })).toBe('treadmill');
    expect(workoutSummaryTypeLabel({ focus: 'Cardio Warmup' })).toBe('Cardio');
  });
});
