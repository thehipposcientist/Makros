import { estimateActivityCaloriesDetailed } from '../activityEnergy.ts';

describe('activity calorie estimates', () => {
  it('uses distance and bodyweight to make manual walks less undercounted', () => {
    const estimate = estimateActivityCaloriesDetailed({
      category: 'cardio',
      subtype: 'walk',
      durationMinutes: 30,
      distanceMiles: 2,
      bodyweightLbs: 180,
      intensity: 'moderate',
      cardioStyle: 'steady',
    });
    if (!estimate || estimate.calories <= 160 || estimate.calories >= 200) {
      throw new Error(`Expected walk estimate around 160-200 kcal, received ${estimate?.calories}`);
    }
    expect(estimate?.confidence).toBe('medium');
  });

  it('keeps no-distance walks conservative', () => {
    const estimate = estimateActivityCaloriesDetailed({
      category: 'cardio',
      subtype: 'walk',
      durationMinutes: 30,
      bodyweightLbs: 180,
      intensity: 'easy',
      cardioStyle: 'easy',
    });
    if (!estimate || estimate.calories <= 90 || estimate.calories >= 130) {
      throw new Error(`Expected no-distance walk estimate around 90-130 kcal, received ${estimate?.calories}`);
    }
    expect(estimate?.confidence).toBe('low');
  });

  it('scores a run higher than the same-duration walk', () => {
    const walk = estimateActivityCaloriesDetailed({
      category: 'cardio',
      subtype: 'walk',
      durationMinutes: 30,
      distanceMiles: 2,
      bodyweightLbs: 180,
      intensity: 'moderate',
    });
    const run = estimateActivityCaloriesDetailed({
      category: 'cardio',
      subtype: 'run',
      durationMinutes: 30,
      distanceMiles: 3,
      bodyweightLbs: 180,
      intensity: 'moderate',
    });
    expect(run?.calories ?? 0).toBeGreaterThan(walk?.calories ?? 0);
  });
});
