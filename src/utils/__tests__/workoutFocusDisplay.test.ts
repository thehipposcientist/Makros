import { displayFocusForExercises, displayFocusForWorkout } from '../workoutFocusDisplay.ts';
import { workoutStimulusDisplayKeys } from '../workoutStimulusDisplay.ts';

describe('workout focus display labels', () => {
  it('renames stale plus-cardio focus when the generated block is core', () => {
    const focus = displayFocusForExercises('Push + Cardio', [
      { name: 'Bench Press', primary_muscle: 'chest' },
      { name: 'Dead Bug', primary_muscle: 'core', slotRole: 'core', prescriptionType: 'core_circuit' },
      { name: 'Side Plank', _primary_muscle: 'core', _role: 'core' },
    ]);

    expect(focus).toBe('Push + Core');
  });

  it('keeps plus-cardio focus when the day actually contains cardio work', () => {
    const focus = displayFocusForWorkout({
      focus: 'Upper + Cardio',
      exercises: [
        { name: 'Incline Press', primary_muscle: 'chest' },
        { name: 'Bike Intervals', primary_muscle: 'cardio', prescriptionType: 'cardio_intervals' },
      ],
    });

    expect(focus).toBe('Upper + Cardio');
  });

  it('strips plus-cardio when no cardio or core rows are present', () => {
    const focus = displayFocusForExercises('Pull + Cardio', [
      { name: 'Lat Pulldown', primary_muscle: 'back' },
      { name: 'Cable Curl', primary_muscle: 'biceps' },
    ]);

    expect(focus).toBe('Pull');
  });

  it('leaves ordinary focus labels unchanged', () => {
    expect(displayFocusForExercises('Legs', [{ name: 'Squat', primary_muscle: 'quads' }])).toBe('Legs');
  });
});

describe('workout stimulus display labels', () => {
  it('splits plus-cardio mixed days into hypertrophy and cardio tags', () => {
    expect(workoutStimulusDisplayKeys({
      focus: 'Upper + Cardio',
      stimulus: 'mixed',
      exercises: [
        { name: 'Incline Press', primary_muscle: 'chest', reps: '8-10' },
        { name: 'Bike Finisher', primary_muscle: 'cardio', prescriptionType: 'cardio_steady' },
      ],
    })).toEqual(['hypertrophy', 'cardio']);
  });

  it('uses a strength tag for plus-cardio days with heavy lift prescriptions', () => {
    expect(workoutStimulusDisplayKeys({
      focus: 'Full Body + Cardio',
      stimulus: 'mixed',
      exercises: [
        { name: 'Trap Bar Deadlift', primary_muscle: 'glutes', reps: '3-5' },
        { name: 'Treadmill Walk', primary_muscle: 'cardio', prescriptionType: 'cardio_steady' },
      ],
    })).toEqual(['strength', 'cardio']);
  });

  it('keeps ordinary mixed sessions as mixed when they are not plus-cardio lift days', () => {
    expect(workoutStimulusDisplayKeys({
      focus: 'Full Body Circuit',
      stimulus: 'mixed',
      exercises: [
        { name: 'Kettlebell Swing', primary_muscle: 'glutes', reps: '12' },
        { name: 'Battle Ropes', primary_muscle: 'cardio', prescriptionType: 'cardio_intervals' },
      ],
    })).toEqual(['mixed']);
  });

  it('does not add a redundant badge to dedicated cardio days', () => {
    expect(workoutStimulusDisplayKeys({
      focus: 'Zone 2 Cardio',
      stimulus: 'conditioning',
      exercises: [
        { name: 'Treadmill Run', primary_muscle: 'cardio', prescriptionType: 'cardio_steady' },
      ],
    })).toEqual([]);
  });
});
