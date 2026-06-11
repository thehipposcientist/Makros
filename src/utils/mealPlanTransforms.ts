import type { MealSuggestion } from '../types';
import { ensureItems, syncLegacyFieldsFromItems } from './mealItems.ts';

export type SavedMealReferenceLike = {
  id?: number;
  _optimisticId?: number;
  name: string;
  items?: any[];
  total_calories?: number;
  total_protein_g?: number;
  total_carbs_g?: number;
  total_fat_g?: number;
};

export function mealItemMicronutrientSnapshot(raw: Record<string, any>): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  const existing = raw.micronutrients && typeof raw.micronutrients === 'object'
    ? raw.micronutrients
    : null;
  if (existing) {
    for (const [key, value] of Object.entries(existing)) {
      if (value == null || value === '') continue;
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = n;
    }
  }

  const mappings: Array<[string, string[]]> = [
    ['fiber', ['fiber_g', 'fiber']],
    ['sugar', ['sugar_g', 'sugar']],
    ['added_sugar_g', ['added_sugar_g', 'added_sugar', 'addedSugar']],
    ['sodium', ['sodium_mg', 'sodium']],
    ['saturated_fat', ['saturated_fat_g', 'saturated_fat', 'saturatedFat']],
    ['cholesterol', ['cholesterol_mg', 'cholesterol']],
    ['caffeine', ['caffeine_mg', 'caffeine']],
    ['monounsaturated_fat', ['monounsaturated_fat_g', 'monounsaturated_fat', 'monounsaturatedFat']],
    ['polyunsaturated_fat', ['polyunsaturated_fat_g', 'polyunsaturated_fat', 'polyunsaturatedFat']],
    ['omega_3', ['omega_3_g', 'omega_3', 'omega3']],
    ['potassium', ['potassium_mg', 'potassium']],
    ['calcium', ['calcium_mg', 'calcium']],
    ['iron', ['iron_mg', 'iron']],
    ['magnesium', ['magnesium_mg', 'magnesium']],
    ['vitamin_d', ['vitamin_d_mcg', 'vitamin_d', 'vitaminD']],
    ['vitamin_b12', ['vitamin_b12_mcg', 'vitamin_b12', 'vitaminB12']],
    ['folate', ['folate_mcg', 'folate', 'folate_b9']],
    ['zinc', ['zinc_mg', 'zinc']],
  ];

  for (const [target, keys] of mappings) {
    if (out[target] != null) continue;
    for (const key of keys) {
      if (raw[key] == null || raw[key] === '') continue;
      const n = Number(raw[key]);
      if (Number.isFinite(n)) {
        out[target] = n;
        break;
      }
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export function savedMealToSuggestion(
  saved: SavedMealReferenceLike,
  consumedAt?: string,
  mealId?: number,
  opts: { localId?: string } = {},
): MealSuggestion {
  const mappedItems = (saved.items || []).map((it: any) => {
    const qty = Number(it.quantity || 1);
    const cal = Number(it.calories || 0);
    const pro = Number(it.protein_g ?? it.protein ?? 0);
    const carbs = Number(it.carbs_g ?? it.carbs ?? 0);
    const fat = Number(it.fat_g ?? it.fat ?? 0);
    const micronutrients = mealItemMicronutrientSnapshot(it);
    return {
      name: String(it.food_name || it.name || 'Item'),
      food_id: it.food_id ?? null,
      serving_id: it.serving_id ?? null,
      serving_grams: it.serving_grams ?? null,
      quantity: qty,
      unit: String(it.unit || 'serving'),
      calories: cal,
      protein: pro,
      carbs,
      fat,
      baseQuantity: qty > 0 ? qty : 1,
      baseCalories: cal,
      baseProtein: pro,
      baseCarbs: carbs,
      baseFat: fat,
      ...(micronutrients ? { micronutrients } : {}),
    };
  });
  const itemTotals = mappedItems.reduce(
    (acc, it) => ({
      calories: acc.calories + Number(it.calories || 0),
      protein: acc.protein + Number(it.protein || 0),
      carbs: acc.carbs + Number(it.carbs || 0),
      fat: acc.fat + Number(it.fat || 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
  const totals = mappedItems.length > 0 ? itemTotals : {
    calories: Number(saved.total_calories || 0),
    protein: Number(saved.total_protein_g || 0),
    carbs: Number(saved.total_carbs_g || 0),
    fat: Number(saved.total_fat_g || 0),
  };
  const localId = mealId ? `saved_log_${mealId}` : (opts.localId || `saved_${saved.id ?? 'meal'}_${Date.now()}`);
  return {
    meal: saved.name || 'Saved meal',
    name: saved.name || 'Saved meal',
    items: mappedItems as any,
    foods: mappedItems.map(it => it.name),
    amounts: mappedItems.map(it => `${it.quantity} ${it.unit}`),
    calories: totals.calories,
    protein: totals.protein,
    carbs: totals.carbs,
    fat: totals.fat,
    _localId: localId,
    _clientMealKey: mealId ? `log_${mealId}` : `local_${localId}`,
    _consumedAt: consumedAt,
    ...(mealId ? { _loggedMealId: mealId } : {}),
    ...(saved.id ? { _savedMealId: Number(saved.id) } : {}),
  } as MealSuggestion;
}

export function duplicateMealForPlan(meal: MealSuggestion, localId?: string): MealSuggestion {
  const withItems = ensureItems(meal);
  const rest = { ...(withItems as any) };
  delete rest._routineId;
  delete rest._savedMealId;
  delete rest.saved_meal_id;
  delete rest._loggedMealId;
  delete rest.logged_meal_id;
  delete rest._localId;
  delete rest._clientMealKey;
  delete rest.client_meal_key;
  delete rest._consumedAt;
  delete rest.consumed_at;
  delete rest.source_type;
  delete rest.source_routine_id;
  delete rest.routine_occurrence_key;
  delete rest._version;
  delete rest.isRoutine;
  const clonedItems = Array.isArray(withItems.items)
    ? withItems.items.map(item => ({
        ...item,
        ...(item.micronutrients ? { micronutrients: { ...item.micronutrients } } : {}),
      }))
    : undefined;
  const clone = {
    ...rest,
    meal: withItems.meal || withItems.name || 'Meal',
    name: withItems.name || withItems.meal || 'Meal',
    foods: [...(withItems.foods ?? [])],
    ...(withItems.amounts ? { amounts: [...withItems.amounts] } : {}),
    ...(clonedItems ? { items: clonedItems } : {}),
    ...(withItems.micronutrients ? { micronutrients: { ...withItems.micronutrients } } : {}),
    ...(withItems.instructionVariants ? { instructionVariants: [...withItems.instructionVariants] } : {}),
    _savedMealId: null,
    _localId: localId || `duplicate_meal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  } as MealSuggestion;
  return clonedItems?.length ? syncLegacyFieldsFromItems(clone) : clone;
}
