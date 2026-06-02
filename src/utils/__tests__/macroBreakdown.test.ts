import {
  macroContributionsFromMeals,
  proteinSourceTotalsFromMeals,
  sumNutrientFromMeals,
} from '../macroBreakdown.ts';

describe('macro breakdown helpers', () => {
  it('builds source rows from the same item macros as the donut total', () => {
    const meals = [{
      meal: 'Lunch',
      foods: [],
      calories: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      items: [
        { name: 'rice', quantity: 1, unit: 'cup', calories: 205, protein: 4, carbs: 45, fat: 1 },
        { name: 'chicken', quantity: 5, unit: 'oz', calories: 240, protein: 44, carbs: 0, fat: 5 },
      ],
    }] as any;

    expect(macroContributionsFromMeals(meals, 'protein')).toEqual([
      { name: 'chicken', meal: 'Lunch', amount: 44 },
      { name: 'rice', meal: 'Lunch', amount: 4 },
    ]);
    expect(macroContributionsFromMeals(meals, 'carbs')).toEqual([
      { name: 'rice', meal: 'Lunch', amount: 45 },
    ]);
  });

  it('falls back to legacy meal totals when structured items are missing', () => {
    const meals = [{
      meal: 'Snack',
      foods: [],
      calories: 180,
      protein: 8,
      carbs: 22,
      fat: 6,
    }] as any;

    expect(macroContributionsFromMeals(meals, 'calories')).toEqual([
      { name: 'Snack', meal: '', amount: 180 },
    ]);
  });

  it('sums item-level nutrient snapshots and avoids double-counting meal totals', () => {
    const meals = [{
      meal: 'Breakfast',
      foods: [],
      calories: 400,
      protein: 20,
      carbs: 55,
      fat: 10,
      micronutrients: { fiber: 99 },
      items: [
        { name: 'oats', quantity: 1, unit: 'cup', calories: 210, protein: 6, carbs: 38, fat: 4, fiber_g: 7, sugar_g: 2 },
        { name: 'berries', quantity: 1, unit: 'cup', calories: 70, protein: 1, carbs: 17, fat: 0, micronutrients: { fiber: 4, sugar: 9 } },
      ],
    }] as any;

    expect(sumNutrientFromMeals(meals, ['fiber_g', 'fiber'], 'fiber')).toBe(11);
    expect(sumNutrientFromMeals(meals, ['sugar_g', 'sugar'])).toBe(11);
  });

  it('ignores null item snapshots so meal-level fallback can still render', () => {
    const meals = [{
      meal: 'Snack',
      foods: [],
      calories: 200,
      protein: 8,
      carbs: 30,
      fat: 5,
      micronutrients: { fiber: 6 },
      items: [
        { name: 'bar', quantity: 1, unit: 'piece', calories: 200, protein: 8, carbs: 30, fat: 5, fiber_g: null },
      ],
    }] as any;

    expect(sumNutrientFromMeals(meals, ['fiber_g', 'fiber'], 'fiber')).toBe(6);
  });

  it('includes unclassified protein so the type breakdown can add up', () => {
    const meals = [{
      meal: 'Dinner',
      foods: [],
      calories: 600,
      protein: 60,
      carbs: 50,
      fat: 20,
      items: [
        { name: 'tofu', quantity: 1, unit: 'cup', calories: 180, protein: 20, carbs: 6, fat: 10, protein_source: 'plant' },
        { name: 'sauce', quantity: 1, unit: 'serving', calories: 120, protein: 4, carbs: 18, fat: 4 },
      ],
    }] as any;

    expect(proteinSourceTotalsFromMeals(meals)).toEqual({
      plant_total_g: 20,
      animal_total_g: 0,
      unclassified_total_g: 4,
      plant_pct: 83,
      animal_pct: 0,
      unclassified_pct: 17,
      plant: [{ name: 'tofu', protein_g: 20 }],
      animal: [],
      unclassified: [{ name: 'sauce', protein_g: 4 }],
    });
  });
});
