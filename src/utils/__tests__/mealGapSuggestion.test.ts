import {
  buildGapMealSuggestion,
  positiveMacroGap,
} from '../mealGapSuggestion.ts';

const pantryFoods = [
  { name: 'Chicken breast', unit: '3 oz', calories: 140, protein: 26, carbs: 0, fat: 3 },
  { name: 'White rice', unit: '1 cup', calories: 200, protein: 4, carbs: 45, fat: 0 },
  { name: 'Broccoli', unit: '1 cup', calories: 55, protein: 4, carbs: 11, fat: 0 },
  { name: 'Olive oil', unit: '1 tbsp', calories: 119, protein: 0, carbs: 0, fat: 14 },
];

describe('meal gap suggestion', () => {
  it('computes only positive remaining macros', () => {
    expect(positiveMacroGap(
      { calories: 2200, protein: 160, carbs: 240, fat: 70 },
      { calories: 2300, protein: 120, carbs: 260, fat: 60 },
    )).toEqual({ calories: 0, protein: 40, carbs: 0, fat: 10 });
  });

  it('builds a reviewable pantry meal from the day macro gap', () => {
    const suggestion = buildGapMealSuggestion({
      targets: { calories: 2200, protein: 160, carbs: 240, fat: 70 },
      consumed: { calories: 1700, protein: 105, carbs: 160, fat: 55 },
      pantryFoods,
      seed: '2026-05-04',
    });

    expect(suggestion?.source).toBe('pantry');
    expect((suggestion?.meal.items?.length ?? 0) > 0).toBe(true);
    expect((suggestion?.meal.calories ?? 0) >= 350).toBe(true);
    expect((suggestion?.meal.calories ?? 0) <= 650).toBe(true);
    expect((suggestion?.meal.protein ?? 0) >= 30).toBe(true);
    expect(suggestion?.meal.foods.length).toBe(suggestion?.meal.items?.length);
  });

  it('uses a favorite when no pantry foods can build the meal', () => {
    const suggestion = buildGapMealSuggestion({
      targets: { calories: 2200, protein: 160, carbs: 240, fat: 70 },
      consumed: { calories: 1700, protein: 105, carbs: 160, fat: 55 },
      pantryFoods: [],
      savedMeals: [
        { id: 'fav_1', name: 'Chicken Rice Bowl', items: ['Chicken breast', 'White rice'], calories: 520, protein: 52, carbs: 72, fat: 12 },
      ],
    });

    expect(suggestion?.source).toBe('saved_meal');
    expect(suggestion?.meal.meal).toBe('Chicken Rice Bowl');
  });

  it('returns null when targets are already covered', () => {
    const suggestion = buildGapMealSuggestion({
      targets: { calories: 2200, protein: 160, carbs: 240, fat: 70 },
      consumed: { calories: 2190, protein: 155, carbs: 235, fat: 67 },
      pantryFoods,
    });

    expect(suggestion).toBe(null);
  });

  it('keeps pantry suggestions close to a small remaining calorie gap', () => {
    const suggestion = buildGapMealSuggestion({
      targets: { calories: 2200, protein: 160, carbs: 240, fat: 70 },
      consumed: { calories: 2110, protein: 115, carbs: 240, fat: 70 },
      pantryFoods,
      seed: 'small-gap',
    });

    expect(suggestion?.source).toBe('pantry');
    expect((suggestion?.meal.calories ?? 0) <= 180).toBe(true);
  });
});
