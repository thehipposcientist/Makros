/**
 * Conversion helpers between legacy `foods[]`/`amounts[]` parallel arrays and
 * the canonical `MealItem[]` shape. These run any time a plan is read or
 * written so the rest of the app can assume structured items are present.
 */
import type { FoodUnit, MealItem, MealSuggestion } from '../types';

export interface MealMacroTotals {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

/** Alias map so we recognize common typo / plural / synonym forms. */
const UNIT_ALIASES: Record<string, FoodUnit> = {
  // Weight
  g: 'g', gram: 'g', grams: 'g',
  kg: 'kg', kilogram: 'kg', kilograms: 'kg',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  // Volume
  ml: 'ml', milliliter: 'ml', milliliters: 'ml',
  l: 'l', liter: 'l', liters: 'l', litre: 'l', litres: 'l',
  'fl_oz': 'fl_oz', floz: 'fl_oz', 'fl.oz': 'fl_oz', 'fl oz': 'fl_oz',
  cup: 'cup', cups: 'cup',
  pint: 'pint', pints: 'pint', pt: 'pint',
  quart: 'quart', quarts: 'quart', qt: 'quart',
  gallon: 'gallon', gallons: 'gallon', gal: 'gallon',
  tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp', tbs: 'tbsp', tbl: 'tbsp',
  tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  // Count
  piece: 'piece', pieces: 'piece', pc: 'piece', pcs: 'piece', whole: 'piece',
  slice: 'slice', slices: 'slice',
  scoop: 'scoop', scoops: 'scoop',
  serving: 'serving', servings: 'serving',
};

// ── Unit conversion ─────────────────────────────────────────────────────────
//
// Volume is normalized to milliliters. Weight to grams. Discrete units
// (piece/slice/scoop/serving) cannot convert across systems — switching
// from "1 piece" to "1 cup" is meaningful only to a human.
//
// Used by `convertQuantity` so the meal edit modal can change unit while
// preserving the same physical amount (and therefore the same macros).

const VOLUME_TO_ML: Partial<Record<FoodUnit, number>> = {
  ml: 1,
  l: 1000,
  fl_oz: 29.5735,
  cup: 240,        // US cooking cup
  pint: 473.176,
  quart: 946.353,
  gallon: 3785.41,
  tbsp: 14.7868,
  tsp: 4.92892,
};

const WEIGHT_TO_G: Partial<Record<FoodUnit, number>> = {
  g: 1,
  kg: 1000,
  oz: 28.3495,
  lb: 453.592,
};

const GRAMS_PER_OZ = 28.3495;

/** Convert a quantity from one unit to another, preserving the physical
 *  amount. Returns null when the conversion crosses systems
 *  (volume↔weight, count↔volume, etc.) and a single number can't be
 *  derived without knowing the food's density.
 *
 *  Examples:
 *    convertQuantity(1, 'cup', 'fl_oz')  → 8.115
 *    convertQuantity(1, 'lb', 'g')        → 453.59
 *    convertQuantity(1, 'cup', 'piece')   → null  (no universal conversion)
 */
export function convertQuantity(
  qty: number,
  fromUnit: FoodUnit,
  toUnit: FoodUnit,
): number | null {
  if (fromUnit === toUnit) return qty;
  const fromVol = VOLUME_TO_ML[fromUnit];
  const toVol   = VOLUME_TO_ML[toUnit];
  if (fromVol != null && toVol != null) {
    return (qty * fromVol) / toVol;
  }
  const fromWt = WEIGHT_TO_G[fromUnit];
  const toWt   = WEIGHT_TO_G[toUnit];
  if (fromWt != null && toWt != null) {
    return (qty * fromWt) / toWt;
  }
  return null;
}

function normalizeUnit(raw: string | undefined | null): FoodUnit | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
  return UNIT_ALIASES[key] ?? UNIT_ALIASES[key.replace(' ', '_')] ?? null;
}

// Unicode-fraction → decimal map. Includes the common vulgar fractions
// produced by `niceFraction` in planGenerator (½ ¼ ¾) plus a few others
// for completeness. Without this mapping, "1½ oz" parsed as quantity=1
// and the unit regex (which expects a letter next) failed to match,
// silently defaulting the unit to 'serving' — that was the
// "Generate / Fill the gaps shows servings instead of useable amounts"
// bug.
const UNICODE_FRACTIONS: Record<string, number> = {
  '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3,
  '¼': 0.25, '¾': 0.75,
  '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
  '⅙': 1 / 6, '⅚': 5 / 6,
  '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
};
const UNICODE_FRACTION_CHARS = Object.keys(UNICODE_FRACTIONS).join('');

/** Parse a stand-alone amount string like "3 oz", "1 cup", "200g", "2",
 *  "1½ oz", "½ cup", "1/2 cup". Returns null if nothing parseable. Unit
 *  defaults to 'serving' when a number is present but no unit can be
 *  identified. */
export function parseAmountString(str: string): { quantity: number; unit: FoodUnit } | null {
  if (!str) return null;
  const s = str.trim().replace(/^about\s+/i, '');
  // Handle ASCII fractions: "1/2 cup", "1/4 cup", "3/4 lb"
  const fracMatch = s.match(/^(\d+)\/(\d+)\s*([a-zA-Z.]+(?:\s+[a-zA-Z.]+)?)?/);
  if (fracMatch) {
    const num = parseInt(fracMatch[1], 10);
    const den = parseInt(fracMatch[2], 10);
    if (den > 0) {
      const quantity = num / den;
      const unit = normalizeUnit(fracMatch[3]) ?? 'serving';
      return { quantity, unit };
    }
  }
  // Handle unicode fractions: "1½ oz", "½ cup", "2¾ tbsp".
  const uniRe = new RegExp(`^(\\d*)([${UNICODE_FRACTION_CHARS}])\\s*([a-zA-Z.]+(?:\\s+[a-zA-Z.]+)?)?`);
  const uniMatch = s.match(uniRe);
  if (uniMatch) {
    const whole = uniMatch[1] ? parseInt(uniMatch[1], 10) : 0;
    const fracVal = UNICODE_FRACTIONS[uniMatch[2]] ?? 0;
    const quantity = whole + fracVal;
    if (quantity > 0) {
      const unit = normalizeUnit(uniMatch[3]) ?? 'serving';
      return { quantity, unit };
    }
  }
  // Match "<num><optional space><optional unit>" — everything after is ignored.
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z.]+(?:\s+[a-zA-Z.]+)?)?/);
  if (!m) return null;
  const quantity = parseFloat(m[1]);
  if (Number.isNaN(quantity)) return null;
  const unit = normalizeUnit(m[2]) ?? 'serving';
  return { quantity, unit };
}

function roundPortionQuantity(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const roundedWhole = Math.round(value);
  if (Math.abs(value - roundedWhole) < 0.03) return roundedWhole;
  return Math.round(value * 100) / 100;
}

function positiveNumber(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function gramsFromServingText(label: string | undefined | null): number | null {
  if (!label) return null;
  const matches = [...label.matchAll(/(\d+(?:\.\d+)?)\s*(kg|kilogram|kilograms|g|gram|grams|oz|ounce|ounces|lb|lbs|pound|pounds)\b/gi)];
  if (matches.length === 0) return null;
  const match = matches[matches.length - 1];
  const qty = positiveNumber(match[1]);
  if (qty == null) return null;
  const unit = match[2].toLowerCase();
  if (unit === 'kg' || unit === 'kilogram' || unit === 'kilograms') return qty * 1000;
  if (unit === 'g' || unit === 'gram' || unit === 'grams') return qty;
  if (unit === 'oz' || unit === 'ounce' || unit === 'ounces') return qty * GRAMS_PER_OZ;
  if (unit === 'lb' || unit === 'lbs' || unit === 'pound' || unit === 'pounds') return qty * 453.592;
  return null;
}

export function gramsFromFoodAmount(quantity: number, unit: FoodUnit): number | null {
  return convertQuantity(quantity, unit, 'g');
}

export function gramsFromFoodServing(
  serving?: string | null,
  servingGrams?: number | null,
): number | null {
  return positiveNumber(servingGrams) ?? gramsFromServingText(serving);
}

export function preferredAmountForFoodServing(
  foodName: string,
  serving?: string | null,
  servingGrams?: number | null,
): { quantity: number; unit: FoodUnit } {
  const parsed = serving ? parseAmountString(serving) : null;
  if (parsed && parsed.unit !== 'serving') return parsed;

  const grams = gramsFromFoodServing(serving, servingGrams);
  if (grams != null) {
    return { quantity: roundPortionQuantity(grams / GRAMS_PER_OZ), unit: 'oz' };
  }

  return parsed ?? guessUnitForFood(foodName);
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

export function macroTotalsFromItems(
  items: MealItem[] = [],
  fallback?: Partial<MealSuggestion>,
): MealMacroTotals {
  if (items.length === 0) {
    return {
      calories: Math.round(fallback?.calories ?? 0),
      protein:  Math.round(fallback?.protein ?? 0),
      carbs:    Math.round(fallback?.carbs ?? 0),
      fat:      Math.round(fallback?.fat ?? 0),
    };
  }
  const totals = items.reduce(
    (acc, i) => ({
      calories: acc.calories + (i.calories ?? 0),
      protein:  acc.protein  + (i.protein ?? 0),
      carbs:    acc.carbs    + (i.carbs ?? 0),
      fat:      acc.fat      + (i.fat ?? 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
  return {
    calories: Math.round(totals.calories),
    protein:  Math.round(totals.protein),
    carbs:    Math.round(totals.carbs),
    fat:      Math.round(totals.fat),
  };
}

export function macroTotalsFromMeal(meal: MealSuggestion): MealMacroTotals {
  const withItems = ensureItems(meal);
  return macroTotalsFromItems(withItems.items ?? [], withItems);
}

function roundScaled(value: number | null | undefined, factor: number, decimals = 2): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  const scale = 10 ** decimals;
  return Math.round(value * factor * scale) / scale;
}

function scaleMicronutrients(micros: Record<string, number> | undefined, factor: number): Record<string, number> | undefined {
  if (!micros) return undefined;
  return Object.fromEntries(
    Object.entries(micros).map(([key, value]) => [
      key,
      typeof value === 'number' ? Math.round(value * factor * 100) / 100 : value,
    ]),
  ) as Record<string, number>;
}

/** Scale one food item by a quantity fraction. Used by duplicate/split
 *  controls and kept here so UI actions preserve the same macro math as
 *  normal quantity editing. */
export function scaleMealItem(item: MealItem, factor: number): MealItem {
  const safeFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const scaledServingGrams = roundScaled(item.serving_grams ?? undefined, safeFactor);
  const scaled: MealItem = {
    ...item,
    quantity: roundScaled(item.quantity, safeFactor) ?? item.quantity,
    calories: Math.round((item.calories ?? 0) * safeFactor),
    protein: Math.round((item.protein ?? 0) * safeFactor),
    carbs: Math.round((item.carbs ?? 0) * safeFactor),
    fat: Math.round((item.fat ?? 0) * safeFactor),
    baseQuantity: roundScaled(item.baseQuantity ?? item.quantity, safeFactor),
    baseCalories: Math.round((item.baseCalories ?? item.calories ?? 0) * safeFactor),
    baseProtein: Math.round((item.baseProtein ?? item.protein ?? 0) * safeFactor),
    baseCarbs: Math.round((item.baseCarbs ?? item.carbs ?? 0) * safeFactor),
    baseFat: Math.round((item.baseFat ?? item.fat ?? 0) * safeFactor),
    ...(scaledServingGrams != null ? { serving_grams: scaledServingGrams } : {}),
    ...(item.micronutrients ? { micronutrients: scaleMicronutrients(item.micronutrients, safeFactor) } : {}),
  };
  return scaled;
}

export function splitMealItemByFraction(item: MealItem, fraction = 0.5): [MealItem, MealItem] {
  const keep = Math.max(0.05, Math.min(0.95, Number.isFinite(fraction) ? fraction : 0.5));
  return [scaleMealItem(item, keep), scaleMealItem(item, 1 - keep)];
}

/** Write legacy `foods`/`amounts` arrays from `items`. Used at save time so
 *  old readers (and the backend) still see something.
 *
 *  Macro totals are recomputed from item macros so they stay in sync.
 *  A non-empty all-zero item list is valid: users can log coffee, water,
 *  or other zero-calorie entries without carrying stale meal totals. */
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
  return {
    ...meal,
    foods,
    amounts,
    calories: totals.calories,
    protein:  totals.protein,
    carbs:    totals.carbs,
    fat:      totals.fat,
  };
}

/** Format an item's quantity + unit for display. The "piece" unit
 *  collapses because it's implicit — "2 eggs" not "2 piece eggs".
 *
 *  When the underlying unit is the meaningless "serving", substitute a
 *  useable unit derived from the food name: oz for solids, fl oz for
 *  liquids, tbsp for spreadables, scoop for powders, piece for whole
 *  foods. Quantity is back-calculated from calories so the displayed
 *  amount actually represents the macros. The data-layer `item.unit`
 *  stays "serving" so backend payloads don't shift; this is display
 *  cosmetics only. */
export function formatItemAmount(item: MealItem): string {
  const qty = formatQty(item.quantity);
  if (item.unit === 'piece') return qty;

  if (item.unit === 'serving') {
    const display = displayForServing(item);
    if (display) return display;
    // Calorie-less item under the meaningless "serving" unit (water,
    // coffee, tea). Derive a real unit from the food class so the row
    // reads "1 cup" instead of bare "1".
    const guess = guessUnitForFood(item.name);
    const guessQty = item.quantity > 0 ? item.quantity : guess.quantity;
    if (guess.unit === 'piece') return formatQty(guessQty);
    return `${formatQty(guessQty)} ${guess.unit}`;
  }

  return `${qty} ${item.unit}`;
}

/** Convert a `unit: 'serving'` item into a sensible display string by
 *  classifying the food and back-calculating the amount from calories.
 *  Returns null when the food is calorie-less (caller decides what to do). */
function displayForServing(item: MealItem): string | null {
  const cal = item.calories ?? 0;
  if (cal <= 0) return null;
  const cls = classifyFood(item.name);
  // Rough calorie densities by food class. These are intentionally on
  // the conservative side so the displayed number errs slightly
  // generous rather than underselling portion size.
  if (cls === 'liquid') {
    // Liquids vary wildly (water vs whole milk vs juice). Anchor to a
    // mid-density beverage (~12 cal / fl oz, e.g. milk).
    const flOz = Math.max(1, Math.round(cal / 12));
    return `${flOz} fl oz`;
  }
  if (cls === 'powder') {
    // Most protein/supplement powders are ~120 cal / scoop. One scoop
    // is the natural display unit.
    const scoops = Math.max(1, Math.round(cal / 120));
    return `${scoops} scoop${scoops !== 1 ? 's' : ''}`;
  }
  if (cls === 'spreadable') {
    // Oils / nut butters / sauces — ~100 cal / tbsp.
    const tbsp = Math.max(1, Math.round(cal / 100));
    return `${tbsp} tbsp`;
  }
  if (cls === 'countable') {
    // Eggs, bread slices, pieces of fruit, etc — fall back to piece.
    return formatQty(item.quantity);
  }
  // solid — proteins, grains, veg. ~28g per oz, ~1.5 cal/g for mixed
  // solids → ~42 cal / oz.
  const oz = Math.max(1, Math.round(cal / 42));
  return `${oz} oz`;
}

function formatQty(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/** Pick a food-type-aware default `(quantity, unit)` for a food name. Mirrors
 *  the backend's `_guess_unit_for_food`. Used when the food library doesn't
 *  carry an explicit serving and we'd otherwise fall back to "1 serving".
 *  Never returns "serving" — every item gets a real, convertible unit. */
export function guessUnitForFood(name: string): { quantity: number; unit: FoodUnit } {
  const n = name.toLowerCase();
  const has = (...ks: string[]) => ks.some(k => n.includes(k));

  if (has('milk', 'juice', 'water', 'broth', 'soup', 'smoothie', 'shake', 'coffee', 'tea', 'beverage', 'drink', 'kombucha')) {
    return { quantity: 1, unit: 'cup' };
  }
  if (has('egg', 'apple', 'banana', 'orange', 'peach', 'pear', 'plum', 'kiwi', 'avocado', 'tomato', 'pepper', 'onion')) {
    return { quantity: 1, unit: 'piece' };
  }
  if (has('bread', 'toast', 'bacon', 'cheese slice', 'deli', 'turkey slice', 'ham slice', 'pizza')) {
    return { quantity: 1, unit: 'slice' };
  }
  if (has('protein powder', 'whey', 'casein', 'creatine', 'pre-workout', 'preworkout', 'bcaa', 'electrolyte powder')) {
    return { quantity: 1, unit: 'scoop' };
  }
  if (has('oil', 'butter', 'peanut butter', 'almond butter', 'dressing', 'sauce', 'honey', 'maple syrup', 'jam', 'mayo', 'ketchup', 'mustard')) {
    return { quantity: 1, unit: 'tbsp' };
  }
  if (has('oat', 'rice', 'pasta', 'quinoa', 'couscous', 'barley', 'noodle', 'yogurt', 'bean', 'lentil', 'broccoli', 'spinach', 'kale', 'lettuce', 'carrot', 'potato', 'sweet potato', 'cauliflower', 'berries', 'berry', 'cottage cheese')) {
    return { quantity: 1, unit: 'cup' };
  }
  // Default for proteins / nuts / generic solids.
  return { quantity: 3, unit: 'oz' };
}

export type FoodCategory = 'liquid' | 'solid' | 'countable' | 'spreadable' | 'powder';

export function classifyFood(name: string): FoodCategory {
  const n = name.toLowerCase();
  const has = (...ks: string[]) => ks.some(k => n.includes(k));
  if (has('milk', 'juice', 'water', 'broth', 'soup', 'smoothie', 'shake', 'coffee', 'tea',
         'beverage', 'drink', 'kombucha', 'wine', 'beer', 'soda', 'cream', 'half and half',
         'almond milk', 'oat milk', 'soy milk', 'coconut milk', 'coconut water'))
    return 'liquid';
  if (has('protein powder', 'whey', 'casein', 'creatine', 'pre-workout', 'preworkout',
         'bcaa', 'electrolyte powder', 'collagen powder', 'matcha powder', 'cocoa powder'))
    return 'powder';
  if (has('oil', 'butter', 'peanut butter', 'almond butter', 'dressing', 'sauce', 'honey',
         'maple syrup', 'jam', 'jelly', 'mayo', 'ketchup', 'mustard', 'hummus', 'tahini',
         'nutella', 'cream cheese', 'sour cream', 'guacamole', 'salsa'))
    return 'spreadable';
  if (has('egg', 'apple', 'banana', 'orange', 'peach', 'pear', 'plum', 'kiwi', 'avocado',
         'bread', 'toast', 'tortilla', 'wrap', 'muffin', 'bagel', 'waffle', 'pancake',
         'bacon', 'sausage link', 'pizza', 'cookie', 'brownie', 'bar'))
    return 'countable';
  return 'solid';
}

const _LIQUID_UNITS: FoodUnit[] = ['ml', 'l', 'fl_oz', 'cup', 'pint', 'quart', 'gallon', 'tbsp', 'tsp'];
const _SOLID_UNITS: FoodUnit[] = ['g', 'kg', 'oz', 'lb', 'cup', 'tbsp', 'tsp'];
const _COUNTABLE_UNITS: FoodUnit[] = ['piece', 'slice', 'g', 'oz'];
const _SPREADABLE_UNITS: FoodUnit[] = ['tbsp', 'tsp', 'g', 'oz', 'cup'];
const _POWDER_UNITS: FoodUnit[] = ['scoop', 'g', 'oz', 'tbsp', 'tsp'];

export function validUnitsForFood(name: string): FoodUnit[] {
  switch (classifyFood(name)) {
    case 'liquid':     return _LIQUID_UNITS;
    case 'solid':      return _SOLID_UNITS;
    case 'countable':  return _COUNTABLE_UNITS;
    case 'spreadable': return _SPREADABLE_UNITS;
    case 'powder':     return _POWDER_UNITS;
  }
}

/** Normalize a meal item's unit. Replaces "serving" with a food-type guess
 *  and rescales macros so the displayed quantity stays accurate. Idempotent. */
export function normalizeServingUnit(item: MealItem): MealItem {
  if (item.unit !== ('serving' as FoodUnit)) return item;
  const guess = guessUnitForFood(item.name);
  // Macros stay the same — we're swapping the LABEL of "1 serving" for
  // "1 cup" / "3 oz" etc. The macros were computed for that single serving
  // either way, so no scaling needed unless the guess quantity differs.
  return {
    ...item,
    unit: guess.unit,
    quantity: guess.quantity,
    baseQuantity: guess.quantity,
  };
}

/** Walk every meal in a plan and replace any "serving" unit with a real one.
 *  Cheap fix for cached meals from before the unit-upgrade landed. */
export function normalizeServingUnitsInPlan(plan: any): any {
  if (!plan || !Array.isArray(plan.meals)) return plan;
  const meals = plan.meals.map((m: any) => {
    if (!m || !Array.isArray(m.items)) return m;
    const items = m.items.map((it: any) => normalizeServingUnit(it));
    return { ...m, items };
  });
  return { ...plan, meals };
}

/** Convert any legacy `{breakfast, lunch, dinner, snack, extraMeals}` plan
 *  shape into the new `{meals: [...]}` shape. Idempotent: a plan that
 *  already has `meals` passes through untouched. Used by every reader that
 *  hits AsyncStorage / day-state so callers can assume the new shape. */
export function migrateNutritionPlanShape(plan: any): any {
  if (!plan || typeof plan !== 'object') return plan;
  if (Array.isArray(plan.meals)) return plan;

  const meals: any[] = [];
  for (const key of ['breakfast', 'lunch', 'dinner', 'snack'] as const) {
    const m = plan[key];
    if (m && typeof m === 'object' && (m.calories || m.meal || m.items)) {
      meals.push(m);
    }
  }
  for (const m of plan.extraMeals ?? []) {
    if (m) meals.push(m);
  }

  // Strip the old slot fields so downstream code can't accidentally read them.
  const {
    breakfast: _b, lunch: _l, dinner: _d, snack: _s,
    extraMeals: _e, removedMeals: _r,
    ...rest
  } = plan;

  return { ...rest, meals };
}
