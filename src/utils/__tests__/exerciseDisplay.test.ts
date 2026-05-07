import { isGuideExercise, shouldHideReps } from '../exerciseDisplay.ts';

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
});
