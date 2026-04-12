/**
 * Conversion helpers between legacy `foods[]`/`amounts[]` parallel arrays and
 * the canonical `MealItem[]` shape. These run any time a plan is read or
 * written so the rest of the app can assume structured items are present.
 */
import { FoodUnit, MealItem, MealSuggestion } from '../types';

/** Alias map so we recognize common typo / plural / synonym forms. */
const UNIT_ALIASES: Record<string, FoodUnit> = {
  // Weight
  g: 'g', gram: 'g', grams: 'g',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  // Volume
  ml: 'ml', milliliter: 'ml', milliliters: 'ml',
  'fl_oz': 'fl_oz', floz: 'fl_oz', 'fl.oz': 'fl_oz', 'fl oz': 'fl_oz',
  cup: 'cup', cups: 'cup',
  tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  // Count
  piece: 'piece', pieces: 'piece', pc: 'piece', pcs: 'piece', whole: 'piece',
  slice: 'slice', slices: 'slice',
  scoop: 'scoop', scoops: 'scoop',
  serving: 'serving', servings: 'serving',
};

function normalizeUnit(raw: string | undefined | null): FoodUnit | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
  return UNIT_ALIASES[key] ?? UNIT_ALIASES[key.replace(' ', '_')] ?? null;
}

/** Parse a stand-alone amount string like "3 oz", "1 cup", "200g", "2".
 *  Returns null if nothing parseable. Unit defaults to 'serving' when a
 *  number is present but no unit can be identified. */
export function parseAmountString(str: string): { quantity: number; unit: FoodUnit } | null {
  if (!str) return null;
  const s = str.trim().replace(/^about\s+/i, '');
  // Match "<num><optional space><optional unit>" — everything after is ignored.
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z.]+(?:\s+[a-zA-Z.]+)?)?/);
  if (!m) return null;
  const quantity = parseFloat(m[1]);
  if (Number.isNaN(quantity)) return null;
  const unit = normalizeUnit(m[2]) ?? 'serving';
  return { quantity, unit };
}

/** Split a food string that may have an embedded quantity — "2 eggs",
 *  "3 oz chicken", "scrambled eggs". Returns the clean name plus an optional
 *  parsed amount. If no quantity is detected the whole string is the name. */
export function splitFoodString(foodStr: string): {
  name: string;
  quantity?: number;
  unit?: FoodUnit;
} {
  const raw = (foodStr ?? '').trim();
  if (!raw) return { name: '' };
  // Try "<num> <unit> <rest>"
  let m = raw.match(/^(\d+(?:\.\d+)?)\s+([a-zA-Z.]+)\s+(.+)$/);
  if (m) {
    const unit = normalizeUnit(m[2]);
    if (unit) {
      return { name: m[3].trim(), quantity: parseFloat(m[1]), unit };
    }
  }
  // Try "<num> <rest>" — rest is the name, assume piece
  m = raw.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
  if (m) {
    return { name: m[2].trim(), quantity: parseFloat(m[1]), unit: 'piece' };
  }
  // No numeric prefix — treat entire string as name
  return { name: raw };
}

/** Build a MealItem[] from the legacy parallel arrays. Used during migration
 *  at read time so the rest of the app can operate on `items` regardless of
 *  how the data was written originally. */
export function itemsFromLegacy(
  foods: string[] = [],
  amounts: string[] = [],
  totalMacros?: { calories?: number; protein?: number; carbs?: number; fat?: number },
): MealItem[] {
  if (!foods.length) return [];
  // Divide total macros evenly across items as a rough starting point. This
  // is a lossy one-way transform — the better source is a structured plan
  // from the updated backend prompt.
  const n = foods.length;
  const perItemCalories = totalMacros?.calories ? totalMacros.calories / n : 0;
  const perItemProtein  = totalMacros?.protein  ? totalMacros.protein  / n : 0;
  const perItemCarbs    = totalMacros?.carbs    ? totalMacros.carbs    / n : 0;
  const perItemFat      = totalMacros?.fat      ? totalMacros.fat      / n : 0;

  return foods.map((f, i) => {
    const amountParsed = parseAmountString(amounts?.[i] ?? '');
    const split = splitFoodString(f);
    const quantity = amountParsed?.quantity ?? split.quantity ?? 1;
    const unit: FoodUnit = amountParsed?.unit ?? split.unit ?? 'serving';
    return {
      name: split.name || f.trim(),
      quantity,
      unit,
      calories: Math.round(perItemCalories),
      protein:  Math.round(perItemProtein),
      carbs:    Math.round(perItemCarbs),
      fat:      Math.round(perItemFat),
    };
  });
}

/** Ensure a meal has structured `items`. If already present, returned as-is —
 *  UNLESS the items all have zero macros while the meal-level totals are
 *  non-zero (the AI sometimes returns per-item macros as 0 even when the
 *  meal totals are correct). In that case we redistribute the totals
 *  evenly across the items so the display and save path have real numbers.
 *  Otherwise derive from legacy fields. Pure — never mutates input. */
export function ensureItems(meal: MealSuggestion): MealSuggestion {
  if (meal.items && meal.items.length > 0) {
    const itemTotal =
      meal.items.reduce((s, i) => s + (i.calories ?? 0), 0);
    const mealTotal = meal.calories ?? 0;
    if (itemTotal === 0 && mealTotal > 0) {
      const n = meal.items.length;
      const per = {
        calories: mealTotal / n,
        protein:  (meal.protein ?? 0) / n,
        carbs:    (meal.carbs ?? 0) / n,
        fat:      (meal.fat ?? 0) / n,
      };
      return {
        ...meal,
        items: meal.items.map(i => ({
          ...i,
          calories: Math.round(per.calories),
          protein:  Math.round(per.protein),
          carbs:    Math.round(per.carbs),
          fat:      Math.round(per.fat),
        })),
      };
    }
    return meal;
  }
  const items = itemsFromLegacy(meal.foods ?? [], meal.amounts ?? [], {
    calories: meal.calories,
    protein:  meal.protein,
    carbs:    meal.carbs,
    fat:      meal.fat,
  });
  if (items.length === 0) return meal;
  return { ...meal, items };
}

/** Write legacy `foods`/`amounts` arrays from `items`. Used at save time so
 *  old readers (and the backend) still see something.
 *
 *  Macro totals are recomputed from item macros so they stay in sync —
 *  BUT only when the item macros actually have data. If every item has
 *  zero macros (which can happen when the backend AI returns per-item
 *  zeros), we preserve the original meal-level totals rather than
 *  clobbering them with zero. Otherwise an edit to a valid meal would
 *  silently reset its calories to 0 on save. */
export function syncLegacyFieldsFromItems(meal: MealSuggestion): MealSuggestion {
  if (!meal.items || meal.items.length === 0) return meal;
  const foods = meal.items.map(i => i.name);
  const amounts = meal.items.map(i => formatItemAmount(i));
  const totals = meal.items.reduce(
    (acc, i) => ({
      calories: acc.calories + (i.calories ?? 0),
      protein:  acc.protein  + (i.protein  ?? 0),
      carbs:    acc.carbs    + (i.carbs    ?? 0),
      fat:      acc.fat      + (i.fat      ?? 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
  const hasItemMacros = totals.calories > 0 || totals.protein > 0 || totals.carbs > 0 || totals.fat > 0;
  return {
    ...meal,
    foods,
    amounts,
    calories: hasItemMacros ? totals.calories : meal.calories,
    protein:  hasItemMacros ? totals.protein  : meal.protein,
    carbs:    hasItemMacros ? totals.carbs    : meal.carbs,
    fat:      hasItemMacros ? totals.fat      : meal.fat,
  };
}

/** "2 piece" → "2", "3 oz" → "3 oz", "1 serving" → "1 serving". The piece
 *  unit collapses because it's implicit — "2 eggs" not "2 piece eggs". */
export function formatItemAmount(item: MealItem): string {
  if (item.unit === 'piece') return `${formatQty(item.quantity)}`;
  return `${formatQty(item.quantity)} ${item.unit}`;
}

function formatQty(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}
