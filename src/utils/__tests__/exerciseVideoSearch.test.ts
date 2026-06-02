import {
  buildExerciseVideoSearchQuery,
  preferredExerciseVideoEquipment,
} from '../exerciseVideoSearch.ts';

describe('exercise video search', () => {
  it('adds concrete equipment for generic loaded exercises', () => {
    expect(buildExerciseVideoSearchQuery('Sumo Squat', 'dumbbells')).toBe(
      'dumbbell Sumo Squat proper form tutorial',
    );
  });

  it('does not duplicate equipment already present in the name', () => {
    expect(buildExerciseVideoSearchQuery('Dumbbell Bench Press', 'dumbbells')).toBe(
      'Dumbbell Bench Press proper form tutorial',
    );
  });

  it('ignores broad equipment buckets', () => {
    expect(buildExerciseVideoSearchQuery('Hip Thrust', 'gym')).toBe(
      'Hip Thrust proper form tutorial',
    );
  });

  it('prefers primary gear over support surfaces', () => {
    const equipment = preferredExerciseVideoEquipment({
      name: 'Step-ups',
      equipment: 'dumbbells',
      gear: [
        { slug: 'plyo_box', name: 'Plyo box', role: 'support', required: true },
        { slug: 'dumbbells', name: 'Dumbbells', role: 'primary', required: false },
      ],
    });
    expect(equipment).toBe('Dumbbells');
  });
});
