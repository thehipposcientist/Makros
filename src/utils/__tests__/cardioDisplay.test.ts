import {
  cardioContextAllowsOutdoorData,
  inferCardioVenue,
  isIndoorCardioEquipment,
  isSetlessCardioExercise,
} from '../cardioDisplay.ts';

describe('cardioDisplay', () => {
  it('keeps stationary bike sessions out of outdoor GPS display', () => {
    const workout = {
      focus: 'Zone 2 Cardio',
      exercises: [
        {
          name: 'Stationary Bike',
          equipment: 'stationary_bike',
          primaryMuscle: 'cardio',
          cardioGuidance: { modality: 'bike', rpm_range: '80-95 rpm' },
        },
      ],
    };

    expect(isIndoorCardioEquipment(workout.exercises[0])).toBe(true);
    expect(inferCardioVenue(workout)).toBe('indoor');
    expect(cardioContextAllowsOutdoorData(workout)).toBe(false);
  });

  it('allows outdoor ride data when the venue or exercise says outdoor', () => {
    expect(cardioContextAllowsOutdoorData({
      focus: 'Outdoor Ride',
      _custom_activity_category: 'cardio',
      _custom_cardio_subtype: 'ride',
      _custom_activity_venue: 'outdoor',
      exercises: [],
    })).toBe(true);

    expect(cardioContextAllowsOutdoorData({
      focus: 'Zone 2 Cardio',
      exercises: [
        {
          name: 'Outdoor Cycling',
          equipment: 'road bike',
          primaryMuscle: 'cardio',
          cardioGuidance: { modality: 'outdoor_bike' },
        },
      ],
    })).toBe(true);
  });

  it('recognizes explicit zero-set cardio as setless', () => {
    expect(isSetlessCardioExercise({
      name: 'Stationary Bike',
      targetSets: 0,
      targetReps: '25 min',
      primaryMuscle: 'cardio',
    })).toBe(true);

    expect(isSetlessCardioExercise({
      name: 'Bench Press',
      targetSets: 0,
      targetReps: '8-10',
      primaryMuscle: 'chest',
    })).toBe(false);
  });
});
