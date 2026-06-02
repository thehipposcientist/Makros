import {
  isGuideExercise,
  shouldHideReps,
  shouldHideWeight,
  watchExerciseTargetWeightLbs,
  watchExerciseTracksWeight,
} from '../exerciseDisplay.ts';

describe('exercise display predicates', () => {
  it('keeps dynamic calf and hamstring strength exercises reps-based', () => {
    const seatedCalfRaise = {
      name: 'Seated Calf Raise',
      reps: '12-15',
      targetReps: '12-15',
      primary_muscle: 'calves',
      exercise_type: 'strength',
    };
    const seatedHamstringCurl = {
      name: 'Seated Hamstring Curl',
      reps: '10-15',
      targetReps: '10-15',
      primary_muscle: 'hamstrings',
      exercise_type: 'strength',
    };

    expect(isGuideExercise(seatedCalfRaise)).toBe(false);
    expect(isGuideExercise(seatedHamstringCurl)).toBe(false);
    expect(shouldHideReps(seatedCalfRaise)).toBe(false);
    expect(shouldHideReps(seatedHamstringCurl)).toBe(false);
  });

  it('still treats named stretches as guide-style duration work', () => {
    expect(isGuideExercise({ name: 'Calf Wall Stretch', reps: '30s hold' })).toBe(true);
    expect(isGuideExercise({ name: 'Hamstring Stretch', reps: '45s hold' })).toBe(true);
  });

  it('keeps band-only Spanish squat reps-only across phone and watch tracking', () => {
    const spanishSquat = {
      name: 'Spanish Squat',
      equipment: 'resistance_bands',
      reps: '12-15',
      targetWeightLbs: 140,
      primary_muscle: 'quads',
    };

    expect(shouldHideWeight(spanishSquat)).toBe(true);
    expect(watchExerciseTracksWeight(spanishSquat)).toBe(false);
    expect(watchExerciseTargetWeightLbs(spanishSquat)).toBeNull();
  });

  it('keeps loadable strength exercises weighted on watch', () => {
    const barbellSquat = {
      name: 'Back Squat',
      equipment: 'barbell',
      reps: '5-8',
      targetWeightLbs: 225,
      primary_muscle: 'quads',
    };

    expect(shouldHideWeight(barbellSquat)).toBe(false);
    expect(watchExerciseTracksWeight(barbellSquat)).toBe(true);
    expect(watchExerciseTargetWeightLbs(barbellSquat)).toBe(225);
  });

  it('keeps band squat weighted when it is a barbell plus bands setup', () => {
    const bandSquat = {
      name: 'Band Squat',
      equipment: 'barbell, resistance_bands, squat_rack',
      reps: '5-8',
      targetWeightLbs: 245,
      primary_muscle: 'quads',
    };

    expect(shouldHideWeight(bandSquat)).toBe(false);
    expect(watchExerciseTracksWeight(bandSquat)).toBe(true);
    expect(watchExerciseTargetWeightLbs(bandSquat)).toBe(245);
  });

  it('keeps loaded time and distance movements weighted', () => {
    const loaded = [
      { name: 'Weighted Plank', equipment: 'weight_plates', reps: '30s hold', default_tracking_mode: 'time', targetWeightLbs: 45 },
      { name: 'Sled Push', equipment: 'sled', reps: '30 yds', default_tracking_mode: 'distance', targetWeightLbs: 180 },
      { name: 'Sandbag Carry', equipment: 'sandbag', reps: '40m', default_tracking_mode: 'distance', targetWeightLbs: 80 },
      { name: 'Cable Pallof Hold', equipment: 'cable_machine, d_handle', reps: '30s hold', default_tracking_mode: 'time', targetWeightLbs: 35 },
      { name: 'Rucking', equipment: 'ruck_pack', reps: '30 min', default_tracking_mode: 'distance', primary_muscle: 'cardio', targetWeightLbs: 35 },
    ];

    for (const exercise of loaded) {
      expect(shouldHideWeight(exercise)).toBe(false);
      expect(watchExerciseTracksWeight(exercise)).toBe(true);
      expect(watchExerciseTargetWeightLbs(exercise)).toBe(exercise.targetWeightLbs);
    }
  });

  it('does not mistake medicine ball sit-ups for L-sit holds', () => {
    const medicineBallSitup = {
      name: 'Medicine Ball Sit-up',
      equipment: 'medicine_ball',
      reps: '10-15',
      targetWeightLbs: 12,
      primary_muscle: 'core',
    };
    const lSit = {
      name: 'L-Sit Hold',
      equipment: 'bodyweight',
      reps: '30s hold',
      primary_muscle: 'core',
    };

    expect(shouldHideWeight(medicineBallSitup)).toBe(false);
    expect(watchExerciseTracksWeight(medicineBallSitup)).toBe(true);
    expect(watchExerciseTargetWeightLbs(medicineBallSitup)).toBe(12);
    expect(shouldHideWeight(lSit)).toBe(true);
  });

  it('keeps row, walk, plank, and crunch strength variants reps-based', () => {
    const exercises = [
      { name: 'Pendlay Row', equipment: 'barbell', reps: '6-8', primary_muscle: 'back' },
      { name: 'Seated Cable Row', equipment: 'cable_machine', reps: '8-12', primary_muscle: 'back' },
      { name: 'Walking Lunges', equipment: 'dumbbells', reps: '10-12', primary_muscle: 'quads' },
      { name: 'Banded Lateral Walk', equipment: 'resistance_bands', reps: '12-15', primary_muscle: 'glutes' },
      { name: 'Plank Shoulder Tap', equipment: 'bodyweight', reps: '8-12', primary_muscle: 'core' },
      { name: 'Cable Crunch', equipment: 'cable_machine', reps: '10-15', primary_muscle: 'core' },
    ];

    for (const exercise of exercises) {
      expect(shouldHideReps(exercise)).toBe(false);
    }
  });

  it('does not classify lying leg curls as guide steps', () => {
    const singleLegLyingLegCurl = {
      name: 'Single-Leg Lying Leg Curl',
      equipment: 'leg_curl_machine',
      reps: '10-12',
      targetWeightLbs: 70,
      primary_muscle: 'hamstrings',
      exercise_type: 'strength',
    };

    expect(isGuideExercise(singleLegLyingLegCurl)).toBe(false);
    expect(shouldHideReps(singleLegLyingLegCurl)).toBe(false);
    expect(shouldHideWeight(singleLegLyingLegCurl)).toBe(false);
    expect(watchExerciseTracksWeight(singleLegLyingLegCurl)).toBe(true);
    expect(watchExerciseTargetWeightLbs(singleLegLyingLegCurl)).toBe(70);
  });

  it('uses equipment, not just name, to decide face pull weight input', () => {
    const cableFacePull = {
      name: 'Face Pull',
      equipment: 'cable_machine,rope_attachment',
      reps: '12-15',
      targetWeightLbs: 35,
      primary_muscle: 'shoulders',
      exercise_type: 'strength',
    };
    const bandFacePull = {
      ...cableFacePull,
      equipment: 'resistance_bands',
      targetWeightLbs: 35,
    };

    expect(shouldHideWeight(cableFacePull)).toBe(false);
    expect(watchExerciseTracksWeight(cableFacePull)).toBe(true);
    expect(watchExerciseTargetWeightLbs(cableFacePull)).toBe(35);
    expect(shouldHideWeight(bandFacePull)).toBe(true);
    expect(watchExerciseTracksWeight(bandFacePull)).toBe(false);
    expect(watchExerciseTargetWeightLbs(bandFacePull)).toBeNull();
  });
});
