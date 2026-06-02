import type { FoodItem } from '../hooks/useMetaData';
import type { FoodUnit, MealItem, MealSuggestion, SavedMealTemplate } from '../types';

export interface MacroTotals {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

interface BuildGapMealSuggestionInput {
  targets?: Partial<MacroTotals> | null;
  consumed: Partial<MacroTotals>;
  pantryFoods: FoodItem[];
  savedMeals?: SavedMealTemplate[];
  seed?: string;
}

export interface GapMealSuggestion {
  meal: MealSuggestion;
  gap: MacroTotals;
  source: 'pantry' | 'saved_meal';
  fitScore: number;
}

const ZERO: MacroTotals = { calories: 0, protein: 0, carbs: 0, fat: 0 };
const MACRO_KEYS: Array<keyof MacroTotals> = ['calories', 'protein', 'carbs', 'fat'];
const MAX_SUGGESTED_MEAL_CALORIES = 1200;
const PANTRY_CALORIE_OVERSHOOT_LIMIT = 1.08;
const SAVED_MEAL_CALORIE_OVERSHOOT_LIMIT = 1.15;
const QUALITY_MICRO_TARGETS: Record<string, number> = {
  calcium: 1000,
  iron: 18,
  potassium: 4700,
  magnesium: 420,
  vitamin_d: 20,
  vitamin_b12: 2.4,
};
const UNIT_ALIASES: Record<string, FoodUnit> = {
  g: 'g', gram: 'g', grams: 'g',
  kg: 'kg', kilogram: 'kg', kilograms: 'kg',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  ml: 'ml', milliliter: 'ml', milliliters: 'ml',
  l: 'l', liter: 'l', liters: 'l',
  'fl oz': 'fl_oz', fl_oz: 'fl_oz', floz: 'fl_oz',
  cup: 'cup', cups: 'cup',
  tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  pint: 'pint', pints: 'pint',
  quart: 'quart', quarts: 'quart',
  gallon: 'gallon', gallons: 'gallon',
  piece: 'piece', pieces: 'piece',
  slice: 'slice', slices: 'slice',
  scoop: 'scoop', scoops: 'scoop',
  serving: 'serving', servings: 'serving',
};

function asTotals(input?: Partial<MacroTotals> | null): MacroTotals {
  return {
    calories: Math.round(Number(input?.calories ?? 0)),
    protein: Math.round(Number(input?.protein ?? 0)),
    carbs: Math.round(Number(input?.carbs ?? 0)),
    fat: Math.round(Number(input?.fat ?? 0)),
  };
}

export function positiveMacroGap(
  targets?: Partial<MacroTotals> | null,
  consumed: Partial<MacroTotals> = ZERO,
): MacroTotals {
  const t = asTotals(targets);
  const c = asTotals(consumed);
  return {
    calories: Math.max(0, t.calories - c.calories),
    protein: Math.max(0, t.protein - c.protein),
    carbs: Math.max(0, t.carbs - c.carbs),
    fat: Math.max(0, t.fat - c.fat),
  };
}

function hasActionableGap(gap: MacroTotals): boolean {
  return gap.calories >= 120 || gap.protein >= 12 || gap.carbs >= 20 || gap.fat >= 8;
}

function targetFromGap(gap: MacroTotals): MacroTotals {
  const macroCalories = (gap.protein * 4) + (gap.carbs * 4) + (gap.fat * 9);
  const targetCalories = Math.min(
    MAX_SUGGESTED_MEAL_CALORIES,
    Math.max(160, gap.calories, macroCalories),
  );
  return {
    calories: targetCalories,
    protein: gap.protein || Math.round((targetCalories * 0.3) / 4),
    carbs: gap.carbs || Math.round((targetCalories * 0.45) / 4),
    fat: gap.fat || Math.round((targetCalories * 0.25) / 9),
  };
}

function normalizeFoodName(name: string): string {
  return String(name ?? '').trim().toLowerCase();
}

function uniqueFoods(foods: FoodItem[]): FoodItem[] {
  const seen = new Set<string>();
  const out: FoodItem[] = [];
  for (const food of foods) {
    const key = normalizeFoodName(food.name);
    if (!key || seen.has(key) || Number(food.calories ?? 0) <= 0) continue;
    seen.add(key);
    out.push(food);
  }
  return out;
}

function density(value: number, calories: number, kcalPerGram: number): number {
  if (calories <= 0) return 0;
  return (value * kcalPerGram) / calories;
}

function isPlantLike(food: FoodItem): boolean {
  const name = normalizeFoodName(food.name);
  const category = String((food as any).category ?? '').toLowerCase();
  return category === 'vegetables' || category === 'fruits' || Number((food as any).plant_count ?? 0) > 0 || /broccoli|spinach|kale|lettuce|greens|zucchini|asparagus|pepper|carrot|tomato|cucumber|cauliflower|berry|berries|apple|banana|orange|grape|melon|kiwi|mango/.test(name);
}

function roleFor(food: FoodItem): 'protein' | 'carb' | 'fat' | 'plant' {
  const calories = Number(food.calories ?? 0);
  const proteinDensity = density(Number(food.protein ?? 0), calories, 4);
  const carbDensity = density(Number(food.carbs ?? 0), calories, 4);
  const fatDensity = density(Number(food.fat ?? 0), calories, 9);
  if (isPlantLike(food) && calories <= 160) return 'plant';
  if ((food.protein ?? 0) >= 10 && proteinDensity >= carbDensity && proteinDensity >= fatDensity * 0.75) return 'protein';
  if ((food.fat ?? 0) >= 6 && fatDensity >= proteinDensity && fatDensity >= carbDensity) return 'fat';
  if ((food.carbs ?? 0) >= 12) return 'carb';
  return isPlantLike(food) ? 'plant' : 'carb';
}

function numericFoodField(food: FoodItem, ...keys: string[]): number {
  for (const key of keys) {
    const value = Number((food as any)[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function foodQualityScore(food: FoodItem): number {
  const calories = Math.max(1, Number(food.calories ?? 0));
  const fiber = numericFoodField(food, 'fiber', 'fiber_g');
  const addedSugar = numericFoodField(food, 'added_sugar_g', 'added_sugar', 'added_sugars_g');
  const saturatedFat = numericFoodField(food, 'saturated_fat', 'saturated_fat_g', 'sat_fat_g');
  const sodium = numericFoodField(food, 'sodium', 'sodium_mg');
  const omega3 = numericFoodField(food, 'omega_3', 'omega_3_g');
  const plantCount = Math.max(
    Number((food as any).plant_count ?? 0) || 0,
    isPlantLike(food) ? 1 : 0,
  );
  const bucket = String((food as any).processing_bucket ?? (food as any).food_quality ?? '').toLowerCase();

  let score = 45;
  score += Math.min(18, ((fiber / calories) * 1000 / 14) * 18);
  score += Math.min(12, plantCount * 3);
  if ((food as any).omega3_rich || (food as any).omega3_flag || omega3 >= 0.25) score += 10;
  else if (omega3 > 0) score += 5;
  if (bucket === 'minimally_processed' || bucket === 'whole') score += 8;
  else if (bucket === 'processed') score += 2;
  else if (bucket === 'ultra_processed') score -= 16;

  for (const [key, target] of Object.entries(QUALITY_MICRO_TARGETS)) {
    const amount = numericFoodField(food, key, `${key}_mg`, `${key}_mcg`);
    if (amount > 0) score += Math.min(4, (amount / Math.max(1, target * 0.25)) * 4);
  }

  const addedSugarPct = (addedSugar * 4 / calories) * 100;
  const satFatPct = (saturatedFat * 9 / calories) * 100;
  const sodiumDensity = (sodium / calories) * 1000;
  score -= Math.min(18, Math.max(0, addedSugarPct - 5) * 1.4);
  score -= Math.min(14, Math.max(0, satFatPct - 10) * 1.0);
  score -= Math.min(12, Math.max(0, sodiumDensity - 1100) / 250);
  return Math.max(0, Math.min(100, score));
}

function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickFood(
  foods: FoodItem[],
  role: 'protein' | 'carb' | 'fat' | 'plant',
  used: Set<string>,
  seed: string,
): FoodItem | null {
  const scored = foods
    .filter(f => roleFor(f) === role && !used.has(normalizeFoodName(f.name)))
    .map(food => {
      const calories = Number(food.calories ?? 0);
      const protein = Number(food.protein ?? 0);
      const carbs = Number(food.carbs ?? 0);
      const fat = Number(food.fat ?? 0);
      const score =
        role === 'protein'
          ? protein * 3 + density(protein, calories, 4) * 35 - fat + foodQualityScore(food) * 0.35
          : role === 'carb'
            ? carbs * 2 + density(carbs, calories, 4) * 25 - fat * 0.5 + foodQualityScore(food) * 0.4
            : role === 'fat'
              ? fat * 4 + density(fat, calories, 9) * 25 + foodQualityScore(food) * 0.25
              : (isPlantLike(food) ? 40 : 0) - calories * 0.08 + carbs * 0.2 + foodQualityScore(food) * 0.55;
      return { food, score };
    })
    .filter(x => Number.isFinite(x.score))
    .sort((a, b) => b.score - a.score || a.food.name.localeCompare(b.food.name));

  if (!scored.length) return null;
  const bestScore = scored[0].score;
  const nearBestCutoff = bestScore > 0 ? bestScore * 0.96 : bestScore - 0.01;
  const top = scored
    .filter(x => x.score >= nearBestCutoff)
    .slice(0, Math.min(3, scored.length));
  return top[hash(`${seed}|${role}`) % top.length].food;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function roundQuantity(qty: number, unit: FoodUnit): number {
  if (unit === 'g' || unit === 'ml') return Math.max(5, Math.round(qty / 5) * 5);
  if (unit === 'oz' || unit === 'fl_oz') return Math.max(0.5, Math.round(qty * 2) / 2);
  if (unit === 'cup') return Math.max(0.25, Math.round(qty * 4) / 4);
  if (unit === 'tbsp' || unit === 'tsp') return Math.max(0.5, Math.round(qty * 2) / 2);
  if (unit === 'piece' || unit === 'slice') return Math.max(1, Math.round(qty));
  if (unit === 'scoop') return Math.max(0.5, Math.round(qty * 2) / 2);
  return Math.max(0.25, Math.round(qty * 4) / 4);
}

function normalizeUnit(raw?: string | null): FoodUnit | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
  return UNIT_ALIASES[key] ?? UNIT_ALIASES[key.replace(' ', '_')] ?? null;
}

function parseServingAmount(str?: string | null): { quantity: number; unit: FoodUnit } | null {
  const s = String(str ?? '').trim();
  if (!s) return null;
  const match = s.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z.]+(?:\s+[a-zA-Z.]+)?)?/);
  if (!match) return null;
  const quantity = Number(match[1]);
  if (!Number.isFinite(quantity)) return null;
  return { quantity, unit: normalizeUnit(match[2]) ?? 'serving' };
}

function guessServingForFood(name: string): { quantity: number; unit: FoodUnit } {
  const n = normalizeFoodName(name);
  const has = (...terms: string[]) => terms.some(term => n.includes(term));
  if (has('milk', 'juice', 'water', 'broth', 'soup', 'smoothie', 'shake', 'coffee', 'tea', 'kombucha')) return { quantity: 1, unit: 'cup' };
  if (has('egg', 'apple', 'banana', 'orange', 'peach', 'pear', 'kiwi', 'avocado', 'tomato', 'pepper', 'onion')) return { quantity: 1, unit: 'piece' };
  if (has('bread', 'toast', 'bacon', 'deli', 'slice')) return { quantity: 1, unit: 'slice' };
  if (has('protein powder', 'whey', 'casein', 'collagen')) return { quantity: 1, unit: 'scoop' };
  if (has('oil', 'butter', 'dressing', 'sauce', 'honey', 'mayo', 'ketchup', 'mustard')) return { quantity: 1, unit: 'tbsp' };
  if (has('oat', 'rice', 'pasta', 'quinoa', 'yogurt', 'bean', 'lentil', 'broccoli', 'spinach', 'kale', 'lettuce', 'carrot', 'potato', 'berries', 'cottage cheese')) return { quantity: 1, unit: 'cup' };
  return { quantity: 3, unit: 'oz' };
}

function servingFor(food: FoodItem): { quantity: number; unit: FoodUnit } {
  const parsed = parseServingAmount(food.unit);
  if (parsed && parsed.unit !== 'serving') return parsed;
  return guessServingForFood(food.name);
}

function scaleFood(food: FoodItem, scale: number): MealItem {
  const base = servingFor(food);
  const quantity = roundQuantity(base.quantity * scale, base.unit);
  const actualScale = base.quantity > 0 ? quantity / base.quantity : scale;
  const calories = Math.round(Number(food.calories ?? 0) * actualScale);
  const protein = Math.round(Number(food.protein ?? 0) * actualScale);
  const carbs = Math.round(Number(food.carbs ?? 0) * actualScale);
  const fat = Math.round(Number(food.fat ?? 0) * actualScale);
  return {
    name: food.name,
    food_id: food.id ?? null,
    quantity,
    unit: base.unit,
    calories,
    protein,
    carbs,
    fat,
    baseQuantity: base.quantity > 0 ? base.quantity : 1,
    baseCalories: Math.round(Number(food.calories ?? 0)),
    baseProtein: Math.round(Number(food.protein ?? 0)),
    baseCarbs: Math.round(Number(food.carbs ?? 0)),
    baseFat: Math.round(Number(food.fat ?? 0)),
  };
}

function itemTotals(items: MealItem[]): MacroTotals {
  return items.reduce(
    (acc, item) => ({
      calories: acc.calories + Math.round(item.calories ?? 0),
      protein: acc.protein + Math.round(item.protein ?? 0),
      carbs: acc.carbs + Math.round(item.carbs ?? 0),
      fat: acc.fat + Math.round(item.fat ?? 0),
    }),
    { ...ZERO },
  );
}

function fitScore(macros: MacroTotals, target: MacroTotals): number {
  return MACRO_KEYS.reduce((score, key) => {
    const shortfall = Math.max(0, target[key] - macros[key]);
    if (key === 'protein') {
      const overshoot = Math.max(0, macros.protein - target.protein);
      return score
        + (shortfall / Math.max(12, target.protein)) * 5
        + (overshoot / Math.max(18, target.protein)) * 0.6;
    }
    const weight = key === 'calories' ? 0.7 : 1;
    const unit = key === 'calories' ? 180 : 18;
    return score + (Math.abs(macros[key] - target[key]) / Math.max(unit, target[key])) * weight;
  }, 0);
}

function formatQuantity(qty: number): string {
  if (Number.isInteger(qty)) return String(qty);
  return qty.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function formatItemAmount(item: MealItem): string {
  const qty = formatQuantity(item.quantity);
  return item.unit === 'piece' ? qty : `${qty} ${item.unit}`;
}

function syncMealFromItems(meal: MealSuggestion): MealSuggestion {
  const items = meal.items ?? [];
  if (!items.length) return meal;
  const totals = itemTotals(items);
  return {
    ...meal,
    foods: items.map(item => item.name),
    amounts: items.map(formatItemAmount),
    calories: totals.calories,
    protein: totals.protein,
    carbs: totals.carbs,
    fat: totals.fat,
  };
}

function buildSavedMealCandidate(
  savedMeals: SavedMealTemplate[],
  target: MacroTotals,
): GapMealSuggestion | null {
  let best: GapMealSuggestion | null = null;
  for (const template of savedMeals ?? []) {
    const macros = asTotals(template);
    if (macros.calories <= 0) continue;
    const score = fitScore(macros, target);
    const meal: MealSuggestion = {
      meal: template.name,
      foods: template.items ?? [],
      calories: macros.calories,
      protein: macros.protein,
      carbs: macros.carbs,
      fat: macros.fat,
    };
    const candidate: GapMealSuggestion = {
      meal,
      gap: target,
      source: 'saved_meal',
      fitScore: score,
    };
    if (!best || candidate.fitScore < best.fitScore) best = candidate;
  }
  if (!best || best.meal.calories > target.calories * SAVED_MEAL_CALORIE_OVERSHOOT_LIMIT || best.fitScore > 1.15) return null;
  return best;
}

function buildPantryCandidate(
  pantryFoods: FoodItem[],
  target: MacroTotals,
  seed: string,
): GapMealSuggestion | null {
  const foods = uniqueFoods(pantryFoods);
  if (!foods.length) return null;

  const used = new Set<string>();
  const selected: Array<{ food: FoodItem; role: 'protein' | 'carb' | 'fat' | 'plant'; scale: number }> = [];
  const addRole = (role: 'protein' | 'carb' | 'fat' | 'plant', scale: number) => {
    const food = pickFood(foods, role, used, seed);
    if (!food) return;
    used.add(normalizeFoodName(food.name));
    selected.push({ food, role, scale });
  };

  addRole('protein', 1);
  if (target.carbs >= 18 || target.calories >= 300) addRole('carb', 1);
  if (target.fat >= 7 || target.calories >= 450) addRole('fat', 1);
  if (target.calories >= 220) addRole('plant', 1);

  if (!selected.length) {
    const fallback = foods.slice().sort((a, b) => b.protein - a.protein || b.calories - a.calories)[0];
    selected.push({ food: fallback, role: 'protein', scale: 1 });
  }

  const scaleFor = (entry: typeof selected[number]): number => {
    const food = entry.food;
    if (entry.role === 'protein' && food.protein > 0) return clamp(target.protein / food.protein, 0.5, 3.25);
    if (entry.role === 'carb' && food.carbs > 0) return clamp(target.carbs / food.carbs, 0.5, 3.25);
    if (entry.role === 'fat' && food.fat > 0) return clamp(target.fat / food.fat, 0.25, 2.5);
    return 1;
  };

  let itemScales = selected.map(entry => scaleFor(entry));
  let items = selected.map((entry, index) => scaleFood(entry.food, itemScales[index]));
  let totals = itemTotals(items);

  if (totals.calories > target.calories * 1.15) {
    const ratio = target.calories / totals.calories;
    itemScales = itemScales.map(scale => scale * ratio);
    items = selected.map((entry, index) => scaleFood(entry.food, itemScales[index]));
    totals = itemTotals(items);
  }

  const calorieShortfall = target.calories - totals.calories;
  if (calorieShortfall > 100) {
    const macroShortfalls = [
      { role: 'protein' as const, kcal: Math.max(0, target.protein - totals.protein) * 4 },
      { role: 'carb' as const, kcal: Math.max(0, target.carbs - totals.carbs) * 4 },
      { role: 'fat' as const, kcal: Math.max(0, target.fat - totals.fat) * 9 },
    ].sort((a, b) => b.kcal - a.kcal);
    const fillerRole = macroShortfalls[0]?.kcal > 0 ? macroShortfalls[0].role : 'carb';
    const fillerIdx = selected.findIndex(entry => entry.role === fillerRole);
    if (fillerIdx >= 0) {
      const entry = selected[fillerIdx];
      const extraScale = calorieShortfall / Math.max(1, entry.food.calories);
      itemScales[fillerIdx] = itemScales[fillerIdx] + extraScale;
      items[fillerIdx] = scaleFood(entry.food, itemScales[fillerIdx]);
      totals = itemTotals(items);
    }
  }

  const calorieCap = target.calories * PANTRY_CALORIE_OVERSHOOT_LIMIT;
  if (totals.calories > calorieCap && totals.protein >= target.protein) {
    const ratio = calorieCap / Math.max(1, totals.calories);
    itemScales = itemScales.map(scale => scale * ratio);
    items = selected.map((entry, index) => scaleFood(entry.food, itemScales[index]));
    totals = itemTotals(items);
  }

  if (target.protein > 0 && totals.protein < target.protein) {
    const proteinIdx = selected.findIndex(entry => entry.role === 'protein' && Number(entry.food.protein ?? 0) > 0);
    if (proteinIdx >= 0) {
      const entry = selected[proteinIdx];
      for (let guard = 0; guard < 4 && totals.protein < target.protein; guard += 1) {
        const gramsShort = target.protein - totals.protein + 2;
        itemScales[proteinIdx] += gramsShort / Math.max(1, Number(entry.food.protein ?? 0));
        items[proteinIdx] = scaleFood(entry.food, itemScales[proteinIdx]);
        totals = itemTotals(items);
      }
    }
  }

  const meal = syncMealFromItems({
    meal: 'Target Meal',
    foods: [],
    items,
    calories: totals.calories,
    protein: totals.protein,
    carbs: totals.carbs,
    fat: totals.fat,
  });

  return {
    meal,
    gap: target,
    source: 'pantry',
    fitScore: fitScore(totals, target),
  };
}

export function buildGapMealSuggestion(input: BuildGapMealSuggestionInput): GapMealSuggestion | null {
  const gap = positiveMacroGap(input.targets, input.consumed);
  if (!hasActionableGap(gap)) return null;

  const target = targetFromGap(gap);
  const pantry = buildPantryCandidate(input.pantryFoods ?? [], target, input.seed ?? 'gap-meal');
  const saved = buildSavedMealCandidate(input.savedMeals ?? [], target);

  if (saved && (!pantry || saved.fitScore <= pantry.fitScore * 0.9)) {
    return { ...saved, gap };
  }
  if (pantry) return { ...pantry, gap };
  return saved ? { ...saved, gap } : null;
}
