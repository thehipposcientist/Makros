import {
  inferMealCheckKeyFromHistoryEntry,
  inferMealChecksFromHistory,
  mergeMealHistoryIntoChecksByDate,
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

  it('infers checked plan meals from backend history item signatures', () => {
    const plan: any = {
      targets: basePlan.targets,
      meals: [
        {
          meal: 'Oats',
          foods: [],
          items: [{ name: 'oats', quantity: 1, unit: 'cup', calories: 300, protein: 10, carbs: 52, fat: 6 }],
          calories: 300,
          protein: 10,
          carbs: 52,
          fat: 6,
        },
        {
          meal: 'Chicken Bowl',
          foods: [],
          items: [{ name: 'chicken', quantity: 1, unit: 'serving', calories: 450, protein: 42, carbs: 45, fat: 10 }],
          calories: 450,
          protein: 42,
          carbs: 45,
          fat: 10,
        },
      ],
    };

    const key = inferMealCheckKeyFromHistoryEntry({
      id: 101,
      meal_date: date,
      meal_type: 'lunch',
      source: 'generated',
      name: 'Chicken Bowl',
      totals: { calories: 450, protein_g: 42, carbs_g: 45, fat_g: 10 },
      items: [{ food_name: 'chicken', quantity: 1, unit: 'serving', calories: 450, protein_g: 42, carbs_g: 45, fat_g: 10 }],
    }, plan);

    expect(key).toBe('meal_1');
  });

  it('falls back to generated meal type when history lost the original meal_N key', () => {
    const key = inferMealCheckKeyFromHistoryEntry({
      id: 102,
      meal_date: date,
      meal_type: 'dinner',
      source: 'generated',
      name: 'Renamed on server',
      totals: { calories: 999, protein_g: 1, carbs_g: 1, fat_g: 1 },
      items: [],
    }, {
      targets: basePlan.targets,
      meals: [
        { meal: 'Breakfast', foods: [], calories: 300, protein: 20, carbs: 30, fat: 10 },
        { meal: 'Lunch', foods: [], calories: 500, protein: 40, carbs: 50, fat: 15 },
        { meal: 'Dinner', foods: [], calories: 600, protein: 45, carbs: 60, fat: 20 },
      ],
    } as any);

    expect(key).toBe('meal_2');
  });

  it('merges backend-inferred checks without dropping existing local checks', () => {
    const plansByDate: any = {
      [date]: {
        targets: basePlan.targets,
        meals: [
          { meal: 'Breakfast', foods: [], calories: 300, protein: 20, carbs: 30, fat: 10 },
          { meal: 'Lunch', foods: [], calories: 500, protein: 40, carbs: 50, fat: 15 },
        ],
      },
    };

    const result = mergeMealHistoryIntoChecksByDate(
      { [date]: { meal_0: true } },
      plansByDate,
      [{
        id: 103,
        meal_date: date,
        meal_type: 'lunch',
        source: 'generated',
        name: 'Lunch',
        totals: { calories: 500, protein_g: 40, carbs_g: 50, fat_g: 15 },
        items: [],
      }],
    );

    expect(result.changedDates).toEqual([date]);
    expect(result.checksByDate[date]).toEqual({ meal_0: true, meal_1: true });
  });

  it('does not infer checks for future history rows', () => {
    const checks = inferMealChecksFromHistory([{
      id: 104,
      meal_date: '2026-05-08',
      meal_type: 'breakfast',
      source: 'generated',
      name: 'Breakfast',
      items: [],
    }], {
      '2026-05-08': basePlan as any,
    }, { maxDate: date });

    expect(checks).toEqual({});
  });
});
