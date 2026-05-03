import {
  setMealCheckedInChecksByDate,
  upsertMealInPlansByDate,
} from '../mealPlanState.ts';

const date = '2026-05-03';

const basePlan = {
  targets: { calories: 2200, protein: 160, carbs: 240, fat: 70 },
  meals: [
    { meal: 'Breakfast', foods: [], calories: 450, protein: 30, carbs: 45, fat: 15 },
  ],
};

describe('meal plan state helpers', () => {
  it('keeps both back-to-back manually added meals', () => {
    let plansByDate: any = { [date]: basePlan };

    const first = upsertMealInPlansByDate(
      plansByDate,
      date,
      'new_meal',
      { meal: 'Protein Shake', foods: [], calories: 260, protein: 35, carbs: 12, fat: 6 },
      { makeLocalId: () => 'manual_1' },
    );
    plansByDate = first.plansByDate;

    const second = upsertMealInPlansByDate(
      plansByDate,
      date,
      'new_meal',
      { meal: 'Greek Yogurt Bowl', foods: [], calories: 310, protein: 28, carbs: 38, fat: 7 },
      { makeLocalId: () => 'manual_2' },
    );

    expect(second.plansByDate[date].meals.map((m: any) => m.meal)).toEqual([
      'Breakfast',
      'Protein Shake',
      'Greek Yogurt Bowl',
    ]);
    expect(first.mealType).toBe('meal_1');
    expect(second.mealType).toBe('meal_2');
    expect((second.plansByDate[date].meals[1] as any)._localId).toBe('manual_1');
    expect((second.plansByDate[date].meals[2] as any)._localId).toBe('manual_2');
  });

  it('merges auto-checks for consecutive added meals', () => {
    let checksByDate: any = {};
    const first = setMealCheckedInChecksByDate(checksByDate, date, 'meal_1', true);
    checksByDate = first.checksByDate;
    const second = setMealCheckedInChecksByDate(checksByDate, date, 'meal_2', true);

    expect(second.dateChecks).toEqual({ meal_1: true, meal_2: true });
  });

  it('replaces an existing meal index without disturbing appended meals', () => {
    const withExtras: any = {
      [date]: {
        ...basePlan,
        meals: [
          ...basePlan.meals,
          { meal: 'Protein Shake', foods: [], calories: 260, protein: 35, carbs: 12, fat: 6 },
          { meal: 'Greek Yogurt Bowl', foods: [], calories: 310, protein: 28, carbs: 38, fat: 7 },
        ],
      },
    };

    const result = upsertMealInPlansByDate(
      withExtras,
      date,
      'meal_1',
      { meal: 'Updated Shake', foods: [], calories: 300, protein: 40, carbs: 14, fat: 6 },
    );

    expect(result.plansByDate[date].meals.map((m: any) => m.meal)).toEqual([
      'Breakfast',
      'Updated Shake',
      'Greek Yogurt Bowl',
    ]);
  });
});
