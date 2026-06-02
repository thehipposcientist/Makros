import { buildWatchMealsPayload } from '../watchMealsPayload.ts';

const plan: any = {
  targets: { calories: 2200, protein: 160, carbs: 240, fat: 70 },
  meals: [
    {
      meal: 'Oats',
      foods: [],
      calories: 300,
      protein: 10,
      carbs: 52,
      fat: 6,
      _clientMealKey: 'oats_key',
    },
    {
      meal: 'Chicken Bowl',
      foods: [],
      calories: 520,
      protein: 44,
      carbs: 55,
      fat: 12,
      _clientMealKey: 'chicken_key',
    },
  ],
};

describe('watch meal payload', () => {
  it('reports per-meal check state but totals ALL visible meals (matches phone NutritionCard)', () => {
    const payload = buildWatchMealsPayload(
      plan,
      { oats_key: true, chicken_key: false },
      '2026-05-24',
      82,
      { syncedAtMs: 123 },
    );

    expect(payload.meals.map(m => m.mealType)).toEqual(['oats_key', 'chicken_key']);
    expect(payload.meals.map(m => m.checked)).toEqual([true, false]);
    // The phone's NutritionCard sums every visible meal regardless of checked
    // state, so the watch must too — otherwise the wrist total disagreed with
    // the phone whenever a meal was left unchecked.
    expect(payload.actual).toEqual({ calories: 820, proteinG: 54, carbsG: 107, fatG: 18 });
    expect(payload.score).toBe(82);
  });

  it('totals are independent of which meals are checked', () => {
    const allChecked = buildWatchMealsPayload(
      plan, { oats_key: true, chicken_key: true }, '2026-05-24', null, { syncedAtMs: 1 },
    );
    const noneChecked = buildWatchMealsPayload(
      plan, {}, '2026-05-24', null, { syncedAtMs: 1 },
    );
    expect(allChecked.actual).toEqual(noneChecked.actual);
    expect(allChecked.actual).toEqual({ calories: 820, proteinG: 54, carbsG: 107, fatG: 18 });
    // ...but the per-meal checkboxes still differ for the watch row UI.
    expect(allChecked.meals.map(m => m.checked)).toEqual([true, true]);
    expect(noneChecked.meals.map(m => m.checked)).toEqual([false, false]);
  });

  it('normalizes legacy meal_N checks for the row flags without changing totals', () => {
    const payload = buildWatchMealsPayload(
      plan,
      { meal_1: true },
      '2026-05-24',
      null,
      { syncedAtMs: 123 },
    );

    expect(payload.meals.map(m => m.mealType)).toEqual(['oats_key', 'chicken_key']);
    expect(payload.meals.map(m => m.checked)).toEqual([false, true]);
    expect(payload.actual).toEqual({ calories: 820, proteinG: 54, carbsG: 107, fatG: 18 });
  });
});
