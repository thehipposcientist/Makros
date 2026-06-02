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
  it('uses stable meal keys and phone check state for watch rows', () => {
    const payload = buildWatchMealsPayload(
      plan,
      { oats_key: true, chicken_key: false },
      '2026-05-24',
      82,
      { syncedAtMs: 123 },
    );

    expect(payload.meals.map(m => m.mealType)).toEqual(['oats_key', 'chicken_key']);
    expect(payload.meals.map(m => m.checked)).toEqual([true, false]);
    expect(payload.actual).toEqual({ calories: 300, proteinG: 10, carbsG: 52, fatG: 6 });
    expect(payload.score).toBe(82);
  });

  it('normalizes legacy meal_N checks before calculating watch totals', () => {
    const payload = buildWatchMealsPayload(
      plan,
      { meal_1: true },
      '2026-05-24',
      null,
      { syncedAtMs: 123 },
    );

    expect(payload.meals.map(m => m.mealType)).toEqual(['oats_key', 'chicken_key']);
    expect(payload.meals.map(m => m.checked)).toEqual([false, true]);
    expect(payload.actual).toEqual({ calories: 520, proteinG: 44, carbsG: 55, fatG: 12 });
  });
});
