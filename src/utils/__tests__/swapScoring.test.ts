import {
  rankWorkoutAddCandidates,
  scoreWorkoutAddCandidate,
  workoutAddAlignmentPercent,
} from '../swapScoring.ts';

const pushWorkout = [
  {
    name: 'Dumbbell Bench Press',
    equipment: 'dumbbells',
    primary_muscle: 'chest',
    secondary_muscles: ['triceps', 'shoulders'],
    movement_pattern: 'horizontal_push',
    is_compound: true,
  },
  {
    name: 'Seated Dumbbell Shoulder Press',
    equipment: 'dumbbells',
    primary_muscle: 'shoulders',
    secondary_muscles: ['triceps'],
    movement_pattern: 'vertical_push',
    is_compound: true,
  },
];

const library = [
  ...pushWorkout,
  {
    name: 'Dumbbell Lateral Raise',
    equipment: 'dumbbells',
    primary_muscle: 'shoulders',
    secondary_muscles: [],
    movement_pattern: 'shoulder_abduction',
    is_compound: false,
  },
  {
    name: 'Cable Chest Fly',
    equipment: 'cable',
    primary_muscle: 'chest',
    secondary_muscles: ['shoulders'],
    movement_pattern: 'fly',
    is_compound: false,
  },
  {
    name: 'Triceps Pushdown',
    equipment: 'cable',
    primary_muscle: 'triceps',
    secondary_muscles: [],
    movement_pattern: 'elbow_extension',
    is_compound: false,
  },
  {
    name: 'Lat Pulldown',
    equipment: 'cable',
    primary_muscle: 'back',
    secondary_muscles: ['biceps'],
    movement_pattern: 'vertical_pull',
    is_compound: true,
  },
  {
    name: 'Leg Extension',
    equipment: 'machine',
    primary_muscle: 'quads',
    secondary_muscles: [],
    movement_pattern: 'knee_extension',
    is_compound: false,
  },
  {
    name: 'Seated Leg Curl',
    equipment: 'machine',
    primary_muscle: 'hamstrings',
    secondary_muscles: [],
    movement_pattern: 'knee_flexion',
    is_compound: false,
  },
  {
    name: 'Cable Biceps Curl',
    equipment: 'cable',
    primary_muscle: 'biceps',
    secondary_muscles: [],
    movement_pattern: 'elbow_flexion',
    is_compound: false,
  },
  {
    name: 'Standing Calf Raise',
    equipment: 'machine',
    primary_muscle: 'calves',
    secondary_muscles: [],
    movement_pattern: 'calf_raise',
    is_compound: false,
  },
  {
    name: 'Cable Face Pull',
    equipment: 'cable',
    primary_muscle: 'shoulders',
    secondary_muscles: ['back'],
    movement_pattern: 'horizontal_pull',
    is_compound: false,
  },
  {
    name: 'Cable Crunch',
    equipment: 'cable',
    primary_muscle: 'core',
    secondary_muscles: [],
    movement_pattern: 'crunch',
    is_compound: false,
  },
  {
    name: 'Hip Thrust',
    equipment: 'barbell',
    primary_muscle: 'glutes',
    secondary_muscles: ['hamstrings'],
    movement_pattern: 'hip_thrust',
    is_compound: true,
  },
];

describe('workout add-exercise ranking', () => {
  it('returns the top ten options ordered by fit for the current workout', () => {
    const ranked = rankWorkoutAddCandidates(
      pushWorkout,
      library,
      ['dumbbells', 'cable', 'machine', 'barbell'],
      'Push',
      10,
    );
    const names = ranked.map(item => item.name);

    expect(ranked.length).toBe(10);
    expect(names.includes('Dumbbell Bench Press')).toBe(false);
    expect(names.includes('Seated Dumbbell Shoulder Press')).toBe(false);
    const firstFour = names.slice(0, 4);
    expect(firstFour).toContain('Dumbbell Lateral Raise');
    expect(firstFour).toContain('Cable Chest Fly');
    expect(firstFour).toContain('Triceps Pushdown');
    expect(ranked[0]._alignment).toBeGreaterThan(0);
    expect(101).toBeGreaterThan(ranked[0]._alignment);
  });

  it('keeps equipment filtering before ranking', () => {
    const ranked = rankWorkoutAddCandidates(
      pushWorkout,
      library,
      ['dumbbells'],
      'Push',
      10,
    );
    expect(ranked.map(item => item.name)).toEqual(['Dumbbell Lateral Raise']);
  });

  it('can rank from the workout focus when the session has no exercises yet', () => {
    const legScore = scoreWorkoutAddCandidate(library[6], [], 'Legs');
    const chestScore = scoreWorkoutAddCandidate(library[3], [], 'Legs');
    expect(legScore).toBeGreaterThan(chestScore);
  });

  it('normalizes add fit score for display as workout alignment', () => {
    const score = scoreWorkoutAddCandidate(library[2], pushWorkout, 'Push');
    expect(workoutAddAlignmentPercent(score)).toBe(79);
    expect(workoutAddAlignmentPercent(-1)).toBe(0);
  });
});
