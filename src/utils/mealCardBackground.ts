import type { DailyNutritionPlan, UserProfile } from '../types';
import { MEAL_CARD_BACKGROUNDS, selectCardBackground } from '../constants/cardBackgroundRotations';

type MealCardBackgroundKey = keyof typeof MEAL_CARD_BACKGROUNDS;
type MealDietMode = 'vegan' | 'vegetarian' | null;

function mealPlanText(plan: DailyNutritionPlan): string {
  const removed = new Set(plan.removedMealIds ?? []);
  return (plan.meals ?? [])
    .filter((_meal, idx) => !removed.has(`meal_${idx}`))
    .map(meal => [
      meal.meal,
      meal.name,
      ...(meal.foods ?? []),
      ...(meal.items ?? []).map(item => item.name),
    ].filter(Boolean).join(' '))
    .join(' ')
    .toLowerCase();
}

function mealDietMode(dietaryPreference: UserProfile['dietaryPreference'] | null | undefined): MealDietMode {
  const pref = String(dietaryPreference ?? '').trim().toLowerCase();
  if (!pref) return null;
  if (/\b(vegan|plant[-_ ]?based)\b/.test(pref)) return 'vegan';
  if (/\bvegetarian\b/.test(pref)) return 'vegetarian';
  return null;
}

const MEAT_OR_SEAFOOD_RE = /\b(chicken|beef|steak|sirloin|turkey|poultry|pork|bacon|ham|lamb|fish|salmon|tuna|tilapia|cod|shrimp|prawn|crab|lobster|scallop)\b/;
const PLANT_DIET_RE = /\b(vegan|vegetarian|plant[-_ ]?based)\b/;
const PLANT_PROTEIN_RE = /\b(tofu|tempeh|seitan|edamame|lentil|bean|beans|chickpea|hummus|falafel|pea protein|soy|black beans|kidney beans)\b/;

const PLANT_SAFE_FALLBACKS: MealCardBackgroundKey[] = [
  'veggieDinner',
  'veganPrep',
  'quinoa',
  'mediterranean',
  'salad',
  'oatmeal',
  'smoothie',
  'noodle',
];

const DEFAULT_MEAL_FALLBACKS: MealCardBackgroundKey[] = [
  'veggieDinner',
  'quinoa',
  'burrito',
  'mediterranean',
  'salad',
  'oatmeal',
  'smoothie',
  'pasta',
  'noodle',
];

function fallbackMealBackgroundKey(dateKey: string, dietMode: MealDietMode): MealCardBackgroundKey {
  const cycle = dietMode ? PLANT_SAFE_FALLBACKS : DEFAULT_MEAL_FALLBACKS;
  const dayNum = Number(dateKey.slice(-2));
  return cycle[Number.isFinite(dayNum) ? dayNum % cycle.length : 0];
}

function plantForwardBackgroundKey(text: string): MealCardBackgroundKey | null {
  if (/\b(smoothie|shake|protein drink|acai)\b/.test(text)) return /\b(breakfast|morning)\b/.test(text) ? 'breakfastSmoothie' : 'smoothie';
  if (/\b(oat|oats|oatmeal|overnight oats|porridge|granola)\b/.test(text)) return 'oatmeal';
  if (/\b(quinoa)\b/.test(text)) return 'quinoa';
  if (/\b(falafel|hummus|mediterranean|pita|tahini)\b/.test(text)) return 'mediterranean';
  if (/\b(salad|lettuce|greens|arugula|cabbage|spinach|kale)\b/.test(text)) return 'salad';
  if (/\b(meal prep|lunchbox|container|containers)\b/.test(text)) return 'veganPrep';
  if (/\b(noodle|noodles|ramen|pho|soba|udon|rice noodle)\b/.test(text)) return 'noodle';
  if (/\b(vegetable|veggie|vegan|plant[-_ ]?based|tofu|tempeh|seitan|edamame|lentil|bean|beans|chickpea|hummus|sweet potato|potato|broccoli|mushroom)\b/.test(text)) return 'veggieDinner';
  return null;
}

function veganMealBackgroundKey(text: string, dateKey: string): MealCardBackgroundKey {
  return plantForwardBackgroundKey(text) ?? fallbackMealBackgroundKey(dateKey, 'vegan');
}

function vegetarianMealBackgroundKey(text: string, dateKey: string): MealCardBackgroundKey {
  if (MEAT_OR_SEAFOOD_RE.test(text)) return fallbackMealBackgroundKey(dateKey, 'vegetarian');
  const plantKey = plantForwardBackgroundKey(text);
  if (plantKey) return plantKey;
  if (/\b(yogurt|greek yogurt|parfait|cottage cheese)\b/.test(text)) return 'yogurt';
  if (/\b(egg|eggs|omelet|omelette|breakfast)\b/.test(text)) return 'breakfast';
  if (/\b(burrito|taco|tacos|mexican|salsa|guacamole|black beans)\b/.test(text)) return 'burrito';
  if (/\b(pasta|spaghetti|penne|linguine|italian)\b/.test(text)) return 'pasta';
  return fallbackMealBackgroundKey(dateKey, 'vegetarian');
}

function mealCardBackgroundKey(
  plan: DailyNutritionPlan,
  dateKey: string,
  dietaryPreference?: UserProfile['dietaryPreference'] | null,
): MealCardBackgroundKey {
  const text = mealPlanText(plan);
  if (!text.trim()) return 'emptyPlate';

  const dietMode = mealDietMode(dietaryPreference);
  if (dietMode === 'vegan') return veganMealBackgroundKey(text, dateKey);
  if (dietMode === 'vegetarian') return vegetarianMealBackgroundKey(text, dateKey);

  if (PLANT_DIET_RE.test(text) || (PLANT_PROTEIN_RE.test(text) && !MEAT_OR_SEAFOOD_RE.test(text))) {
    const plantKey = plantForwardBackgroundKey(text);
    if (plantKey) return plantKey;
  }
  if (/\b(smoothie|shake|protein drink|yogurt bowl|acai)\b/.test(text)) return /\b(breakfast|morning)\b/.test(text) ? 'breakfastSmoothie' : 'smoothie';
  if (/\b(oat|oats|oatmeal|overnight oats|porridge|granola)\b/.test(text)) return 'oatmeal';
  if (/\b(yogurt|greek yogurt|parfait|cottage cheese)\b/.test(text)) return 'yogurt';
  if (/\b(egg|eggs|bacon|omelet|omelette|breakfast)\b/.test(text)) return 'breakfast';
  if (/\b(burrito|taco|tacos|mexican|salsa|guacamole|black beans)\b/.test(text)) return 'burrito';
  if (/\b(pasta|spaghetti|penne|linguine|italian)\b/.test(text)) return 'pasta';
  if (/\b(noodle|noodles|ramen|pho|soba|udon|rice noodle)\b/.test(text)) return 'noodle';
  if (/\b(quinoa)\b/.test(text)) return 'quinoa';
  if (/\b(falafel|hummus|mediterranean|pita)\b/.test(text)) return 'mediterranean';
  if (/\b(salmon|fish|cod|tuna|tilapia)\b/.test(text)) {
    if (/\b(tuna|salad|egg)\b/.test(text)) return 'tunaSalad';
    return /\b(bean|beans|asparagus|broccoli|greens|green)\b/.test(text) ? 'salmonBeans' : 'salmon';
  }
  if (/\b(steak|beef|sirloin)\b/.test(text)) return 'steak';
  if (/\b(chicken|turkey|poultry)\b/.test(text)) {
    if (/\b(meal prep|lunchbox|container|containers)\b/.test(text)) return 'mealPrepChicken';
    if (/\b(caesar|salad|lettuce|greens)\b/.test(text)) return 'caesar';
    if (/\b(rice|bowl|broccoli|sesame)\b/.test(text)) return 'chickenRice';
    return 'chicken';
  }
  if (/\b(salad|lettuce|greens|arugula|cabbage)\b/.test(text)) return 'salad';
  if (/\b(meal prep|lunchbox|container|containers)\b/.test(text)) return 'veganPrep';
  if (/\b(vegetarian|veggie|vegetable|vegan|plant based|tofu|tempeh|lentil|bean|chickpea)\b/.test(text)) return 'veggieDinner';

  return fallbackMealBackgroundKey(dateKey, null);
}

export function mealCardBackgroundSource(
  plan: DailyNutritionPlan,
  dateKey: string,
  dietaryPreference?: UserProfile['dietaryPreference'] | null,
) {
  const key = mealCardBackgroundKey(plan, dateKey, dietaryPreference);
  return selectCardBackground(MEAL_CARD_BACKGROUNDS[key], `${dateKey}:${key}:${mealPlanText(plan)}`);
}
