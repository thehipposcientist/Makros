import {
  exerciseEquipmentLabel,
  isExerciseUsableWithEquipment,
  rankSwapCandidates,
  rankWorkoutAddCandidates,
  scoreSwapCandidate,
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

describe('exercise swap ranking', () => {
  it('can rank a planned exercise that is not present in the library', () => {
    const ranked = rankSwapCandidates(
      {
        name: 'AI Incline Press',
        equipment: 'dumbbells',
        primary_muscle: 'chest',
        secondary_muscles: ['shoulders', 'triceps'],
        movement_pattern: 'horizontal_push',
        is_compound: true,
      },
      library,
      ['dumbbells', 'cable'],
      5,
    );

    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.map(item => item.name)).toContain('Dumbbell Bench Press');
  });

  it('falls back to movement-pattern scoring when the planned row has no muscle tag', () => {
    const score = scoreSwapCandidate(
      {
        name: 'Mystery Press',
        equipment: 'dumbbells',
        primary_muscle: '',
        secondary_muscles: [],
        movement_pattern: 'horizontal_push',
        is_compound: true,
      },
      library[0],
    );

    expect(score).toBeGreaterThan(0);
  });
});

describe('exercise equipment alternatives', () => {
  const preacherCurl = {
    name: 'Preacher Curl',
    equipment: 'gym',
    primary_muscle: 'biceps',
    secondary_muscles: [],
    movement_pattern: 'isolation',
    is_compound: false,
    gear: [
      { slug: 'preacher_bench', name: 'Preacher curl bench', role: 'support', required: true },
      { slug: 'ez_curl_bar', name: 'EZ curl bar', role: 'primary', required: false },
      { slug: 'barbell', name: 'Barbell', role: 'primary', required: false },
      { slug: 'dumbbells', name: 'Dumbbells', role: 'primary', required: false },
    ],
  };

  it('requires support gear plus one primary implement', () => {
    expect(isExerciseUsableWithEquipment(preacherCurl, ['Preacher curl bench'])).toBe(false);
    expect(isExerciseUsableWithEquipment(preacherCurl, ['Dumbbells'])).toBe(false);
    expect(isExerciseUsableWithEquipment(preacherCurl, ['Preacher curl bench', 'Dumbbells'])).toBe(true);
    expect(isExerciseUsableWithEquipment(preacherCurl, ['Preacher bench', 'Curling bar'])).toBe(true);
  });

  it('labels the owned implement before the support surface', () => {
    expect(exerciseEquipmentLabel(preacherCurl, ['Preacher curl bench', 'Dumbbells'])).toBe(
      'Dumbbells, Preacher curl bench',
    );
    expect(exerciseEquipmentLabel(preacherCurl, ['Preacher bench', 'Curling bar'])).toBe(
      'EZ curl bar, Preacher curl bench',
    );
  });

  it('does not let a single cable station satisfy dual-cable exercises', () => {
    const singleArmCableRow = {
      name: 'Single Arm Cable Row',
      equipment: 'cable',
      primary_muscle: 'back',
      secondary_muscles: ['biceps'],
      movement_pattern: 'horizontal_pull',
      is_compound: true,
      gear: [
        { slug: 'single_cable_station', name: 'Single cable station', role: 'primary', required: true },
        { slug: 'd_handle', name: 'Cable D-handle', role: 'support', required: true },
      ],
    };
    const bilateralCablePress = {
      name: 'Bilateral Cable Chest Press',
      equipment: 'cable',
      primary_muscle: 'chest',
      secondary_muscles: ['triceps'],
      movement_pattern: 'horizontal_push',
      is_compound: true,
      gear: [
        { slug: 'dual_cable_station', name: 'Dual cable station', role: 'primary', required: true },
        { slug: 'd_handle', name: 'Cable D-handle', role: 'support', required: true },
      ],
    };

    expect(isExerciseUsableWithEquipment(singleArmCableRow, ['Single cable station'])).toBe(true);
    expect(isExerciseUsableWithEquipment(bilateralCablePress, ['Single cable station'])).toBe(false);
    expect(isExerciseUsableWithEquipment(singleArmCableRow, ['Dual cable station'])).toBe(true);
    expect(isExerciseUsableWithEquipment(bilateralCablePress, ['Dual cable station'])).toBe(true);
    expect(isExerciseUsableWithEquipment(bilateralCablePress, ['Cable machine'])).toBe(true);
  });
});
