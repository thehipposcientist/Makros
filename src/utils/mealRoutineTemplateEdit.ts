import type { MealRoutineEntry, MealRoutineFood, MealSuggestion } from '../types';
import { ensureItems, macroTotalsFromMeal } from './mealItems.ts';

export function routineEntryFromEditedMeal(
  existing: MealRoutineEntry,
  updated: MealSuggestion,
  makeFoodId: (index: number) => string = index => `${Date.now()}_${index}`,
): MealRoutineEntry {
  const withItems = ensureItems(updated);
  const snapItems = withItems.items ?? [];
  const macros = macroTotalsFromMeal(updated);
  const foods: MealRoutineFood[] = snapItems.length > 0
    ? snapItems.map((it, i) => ({
        id: makeFoodId(i),
        name: it.name,
        quantity: it.unit === 'piece' ? String(it.quantity) : `${it.quantity} ${it.unit}`,
      }))
    : (updated.foods ?? []).map((f, i) => ({
        id: makeFoodId(i),
        name: f,
        quantity: updated.amounts?.[i],
      }));

  return {
    ...existing,
    name: updated.meal,
    foods,
    items: snapItems.length > 0 ? snapItems : undefined,
    calories: macros.calories,
    protein: macros.protein,
    carbs: macros.carbs,
    fat: macros.fat,
  };
}
