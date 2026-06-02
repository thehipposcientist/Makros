import { buildSuggestedMeals, SUGGESTED_MEAL_TEMPLATE_COUNT } from '../suggestedMeals.ts';

describe('suggested meals', () => {
  it('prioritizes meals that match available foods', () => {
    const suggestions = buildSuggestedMeals({
      foodsAvailable: ['Chicken Breast', 'Brown Rice', 'Greek Yogurt'],
      limit: 3,
    });

    expect(suggestions[0]?.name).toBe('Chicken Rice Power Bowl');
    expect(suggestions[0]?.reason).toContain('Chicken Breast');
    expect(suggestions.some(meal => meal.name === 'Greek Yogurt Berry Bowl')).toBe(true);
  });

  it('filters diet and allergy conflicts', () => {
    const suggestions = buildSuggestedMeals({
      dietaryPreference: 'vegan',
      allergies: ['soy'],
      foodsAvailable: ['Tofu', 'Quinoa', 'Lentils', 'Hummus'],
      limit: 5,
    });

    expect(suggestions.some(meal => meal.name.includes('Tofu'))).toBe(false);
    expect(suggestions.every(meal => !meal.items.some(item => /chicken|turkey|salmon|tuna|steak|egg|yogurt/i.test(item.food_name)))).toBe(true);
    expect(suggestions[0]?.name).toBe('Lentil Hummus Quinoa Bowl');
  });

  it('does not suggest a meal already saved by name', () => {
    const suggestions = buildSuggestedMeals({
      foodsAvailable: ['Chicken Breast', 'Brown Rice'],
      existingMealNames: ['Chicken Rice Power Bowl'],
      limit: 3,
    });

    expect(suggestions.some(meal => meal.name === 'Chicken Rice Power Bowl')).toBe(false);
  });

  it('has a broad template pool and recipe details for review', () => {
    const suggestions = buildSuggestedMeals({ limit: 8 });

    expect(SUGGESTED_MEAL_TEMPLATE_COUNT).toBeGreaterThan(24);
    expect(suggestions.length).toBe(8);
    expect(suggestions[0]?.prepTimeMinutes).toBeGreaterThan(0);
    expect(suggestions[0]?.recipeSteps.length).toBeGreaterThan(2);
    expect(suggestions[0]?.totalCarbsG).toBeGreaterThan(-1);
    expect(suggestions[0]?.totalFatG).toBeGreaterThan(-1);
  });
});
