import { DailyNutritionPlan, MealItem } from '../types';

export interface NutritionScoreResult {
  score: number;
  adherence: number;
  quality: number;
  micro: number;
  confidence: string;
  tags: string[];
  wins: string[];
  improvements: string[];
  likely_gaps: string[];
  indicators: Record<string, any>;
}

const RDA: Record<string, number> = {
  fiber: 28,
  calcium: 1000,
  iron: 18,
  potassium: 4700,
  magnesium: 420,
  vitamin_d: 20,
  vitamin_c: 90,
  vitamin_a: 900,
  vitamin_b12: 2.4,
  zinc: 11,
};

const KEY_MICROS = ['calcium', 'iron', 'potassium', 'magnesium', 'vitamin_d', 'vitamin_c'];

const MICRO_ALIASES: Record<string, string> = {
  calcium_mg: 'calcium', iron_mg: 'iron', potassium_mg: 'potassium',
  magnesium_mg: 'magnesium', vitamin_d_mcg: 'vitamin_d', vitamin_c_mg: 'vitamin_c',
  vitamin_a_mcg: 'vitamin_a', vitamin_b12_mcg: 'vitamin_b12', zinc_mg: 'zinc',
  fiber_g: 'fiber',
  vitaminD: 'vitamin_d', vitaminC: 'vitamin_c', vitaminA: 'vitamin_a',
  vitaminB12: 'vitamin_b12',
};

function normalizeMicroKey(key: string): string {
  return MICRO_ALIASES[key] ?? key;
}

const WHOLE_FOOD_KEYWORDS = [
  // Proteins
  'chicken', 'turkey', 'beef', 'pork', 'lamb', 'bison', 'venison', 'steak',
  'salmon', 'tuna', 'fish', 'shrimp', 'cod', 'tilapia', 'halibut', 'sardine',
  'mackerel', 'trout', 'bass', 'crab', 'lobster', 'scallop', 'clam', 'mussel',
  'egg', 'whey', 'casein',
  // Grains & carbs
  'rice', 'oats', 'oatmeal', 'quinoa', 'sweet potato', 'potato', 'bread',
  'pasta', 'noodle', 'tortilla', 'wrap', 'couscous', 'barley', 'buckwheat',
  'corn', 'polenta', 'farro', 'millet',
  // Vegetables
  'broccoli', 'spinach', 'kale', 'lettuce', 'tomato', 'pepper', 'carrot',
  'cucumber', 'zucchini', 'asparagus', 'green bean', 'pea', 'onion',
  'mushroom', 'cauliflower', 'celery', 'cabbage', 'beet', 'squash',
  'eggplant', 'artichoke', 'brussels', 'radish', 'turnip', 'bok choy',
  'edamame', 'okra', 'arugula', 'watercress', 'collard', 'chard',
  // Fruits
  'apple', 'banana', 'berries', 'orange', 'avocado', 'mango', 'grape',
  'peach', 'pear', 'melon', 'watermelon', 'pineapple', 'strawberr',
  'blueberr', 'raspberry', 'cherry', 'plum', 'fig', 'date', 'kiwi',
  'papaya', 'coconut', 'pomegranate', 'lemon', 'lime', 'grapefruit',
  // Dairy
  'milk', 'yogurt', 'greek yogurt', 'cheese', 'cottage cheese', 'cream cheese',
  'mozzarella', 'cheddar', 'parmesan', 'feta', 'ricotta', 'kefir', 'skyr',
  // Legumes & plant protein
  'beans', 'lentils', 'tofu', 'tempeh', 'chickpeas', 'hummus', 'peanut butter',
  'almond butter', 'soy', 'seitan',
  // Fats & oils
  'olive oil', 'coconut oil', 'butter', 'ghee', 'nuts', 'almond', 'peanut',
  'walnut', 'cashew', 'pecan', 'pistachio', 'macadamia', 'flax', 'chia',
  'hemp seed', 'sunflower seed', 'pumpkin seed', 'sesame',
  // Other whole foods
  'honey', 'maple syrup', 'salsa', 'guacamole', 'sauerkraut', 'kimchi',
];

const PROCESSED_KEYWORDS = [
  'protein bar', 'granola bar', 'energy bar', 'cereal', 'chips', 'candy',
  'soda', 'energy drink', 'sport drink', 'instant', 'frozen dinner',
  'frozen pizza', 'pizza', 'hot dog', 'nugget', 'fries', 'french fries',
  'donut', 'doughnut', 'cookie', 'cake', 'ice cream', 'pastry', 'muffin',
  'pop tart', 'ramen', 'corn dog', 'bagel bite', 'croissant',
  'cracker', 'pretzel', 'popcorn', 'brownie', 'waffle', 'pancake mix',
  'mac and cheese', 'macaroni and cheese', 'canned soup', 'packaged',
  'microwave', 'toaster', 'processed', 'deli meat', 'bacon', 'sausage',
  'salami', 'pepperoni', 'jerky', 'slim jim',
  'granola', 'rice cake', 'bagel', 'english muffin', 'flour tortilla',
  'trail mix', 'dark chocolate',
];

const FRUIT_VEG_KEYWORDS = [
  // Vegetables
  'broccoli', 'spinach', 'kale', 'lettuce', 'tomato', 'pepper', 'carrot',
  'cucumber', 'zucchini', 'asparagus', 'green bean', 'pea', 'corn',
  'onion', 'mushroom', 'cauliflower', 'celery', 'cabbage', 'beet',
  'squash', 'eggplant', 'artichoke', 'brussels', 'radish', 'bok choy',
  'edamame', 'okra', 'arugula', 'watercress', 'collard', 'chard',
  'salad', 'mixed greens', 'coleslaw',
  // Fruits
  'apple', 'banana', 'berries', 'blueberr', 'strawberr', 'raspberry',
  'orange', 'mango', 'pineapple', 'grape', 'peach', 'pear', 'melon',
  'watermelon', 'avocado', 'cherry', 'plum', 'fig', 'kiwi', 'papaya',
  'pomegranate', 'grapefruit', 'lemon', 'lime', 'date',
];

const GOAL_WEIGHTS: Record<string, [number, number, number]> = {
  muscle_gain: [0.40, 0.35, 0.25],
  strength: [0.40, 0.35, 0.25],
  fat_loss: [0.40, 0.40, 0.20],
  body_recomp: [0.38, 0.37, 0.25],
  endurance: [0.35, 0.35, 0.30],
  athletic_performance: [0.35, 0.35, 0.30],
  hyrox: [0.35, 0.35, 0.30],
  general_health: [0.30, 0.35, 0.35],
  maintain: [0.30, 0.35, 0.35],
};

export function classifyFood(name: string, persisted?: 'whole' | 'processed' | 'unknown'): 'whole' | 'processed' | 'unknown' {
  if (persisted) return persisted;
  const lower = name.toLowerCase();
  if (PROCESSED_KEYWORDS.some(k => lower.includes(k))) return 'processed';
  if (WHOLE_FOOD_KEYWORDS.some(k => lower.includes(k))) return 'whole';
  return 'unknown';
}

function isFruitOrVeg(name: string): boolean {
  const lower = name.toLowerCase();
  return FRUIT_VEG_KEYWORDS.some(k => lower.includes(k));
}

function collectAllItems(plan: DailyNutritionPlan): MealItem[] {
  const removed = new Set(plan.removedMealIds ?? []);
  return plan.meals
    .filter((_, i) => !removed.has(String(i)))
    .flatMap(m => m.items ?? []);
}

export function computeNutritionScore(
  plan: DailyNutritionPlan | null,
  goal: string = 'body_recomp',
  sex?: string,
): NutritionScoreResult {
  const empty: NutritionScoreResult = {
    score: 0, adherence: 0, quality: 0, micro: 0,
    confidence: 'low', tags: [], wins: [], improvements: ['Add meals to your plan'],
    likely_gaps: [], indicators: {},
  };
  if (!plan || !plan.meals.length) return empty;

  // Sex-aware iron RDA: male = 8mg, female/unknown = 18mg
  const effectiveRDA = { ...RDA };
  if (sex && sex.toLowerCase() === 'male') {
    effectiveRDA.iron = 8;
  }

  const targets = plan.targets;
  const removed = new Set(plan.removedMealIds ?? []);
  const activeMeals = plan.meals.filter((_, i) => !removed.has(String(i)));
  const items = collectAllItems(plan);

  const totalCal = activeMeals.reduce((s, m) => s + (m.calories || 0), 0);
  const totalPro = activeMeals.reduce((s, m) => s + (m.protein || 0), 0);
  const totalFiber = activeMeals.reduce((s, m) => s + (m.fiber || 0), 0);

  // Collect micronutrients — normalize keys to canonical names
  const micros: Record<string, number> = {};
  for (const it of items) {
    if (it.micronutrients) {
      for (const [k, v] of Object.entries(it.micronutrients)) {
        const canonical = normalizeMicroKey(k);
        micros[canonical] = (micros[canonical] || 0) + (v || 0);
      }
    }
  }
  // Meal-level micronutrients as fallback (avoid double-counting)
  const itemsHaveMicros = items.some(it => it.micronutrients && Object.keys(it.micronutrients).length > 0);
  for (const m of activeMeals) {
    const mealMicros = m.micronutrients;
    if (mealMicros && typeof mealMicros === 'object' && !itemsHaveMicros) {
      for (const [k, v] of Object.entries(mealMicros)) {
        if (typeof v === 'number') {
          const canonical = normalizeMicroKey(k);
          micros[canonical] = (micros[canonical] || 0) + v;
        }
      }
    }
  }

  // Food classification — uses persisted quality from backend when available
  let wholeCount = 0, processedCount = 0, fvServings = 0;
  for (const it of items) {
    const cls = classifyFood(it.name, it.food_quality);
    if (cls === 'whole') wholeCount++;
    else if (cls === 'processed') processedCount++;
    if (isFruitOrVeg(it.name)) fvServings++;
  }
  const totalFoods = Math.max(1, items.length);
  const wholePct = (wholeCount / totalFoods) * 100;
  const processedPct = (processedCount / totalFoods) * 100;

  const mealsLogged = activeMeals.length;
  const mealsExpected = Math.max(1, plan.meals.length);
  const loggingCompleteness = Math.min(1, mealsLogged / mealsExpected);

  // Calorie alignment: within ±10% = perfect, degrades to 0 at ±40%
  const calAlignment = targets.calories > 0
    ? (() => {
        const deviation = Math.abs(1 - totalCal / targets.calories);
        if (deviation <= 0.10) return 1.0;
        return Math.max(0, 1 - (deviation - 0.10) / 0.30);
      })()
    : 0.5;

  // Protein alignment: full credit at 100%+ of target
  const proRatio = targets.protein > 0 ? totalPro / targets.protein : 0.5;
  const proAlignment = proRatio >= 1.0 ? 1.0 : Math.max(0, proRatio);

  const effectiveFiber = (micros['fiber'] || 0) > 0 ? micros['fiber'] : totalFiber;
  const fiberAlignment = effectiveFiber >= RDA.fiber ? 1.0 : Math.max(0, effectiveFiber / RDA.fiber);

  // ── Adherence (0-100) ──
  // Logging completeness affects confidence, not adherence directly.
  // Someone who logs 1 meal shouldn't look like they ate badly.
  const calPts = calAlignment * 50;
  const proPts = proAlignment * 50;
  const adherence = Math.round(Math.min(100, calPts + proPts));

  // ── Quality (0-100) ──
  const wholePts = Math.min(35, wholePct / 100 * 35);
  const processedPenalty = Math.min(20, processedPct / 100 * 20);
  const fiberPts = fiberAlignment * 20;
  const fvPts = Math.min(15, (fvServings / 5) * 15);
  // Hydration bonus (0-10 pts) — infrastructure for when client-side tracking is added
  const hydrationPts = 0;
  const quality = Math.round(Math.min(100, Math.max(0, wholePts - processedPenalty + fiberPts + fvPts + hydrationPts)));

  // ── Micronutrient Coverage (0-100) ──
  const foodsWithMicros = items.filter(it => it.micronutrients && Object.keys(it.micronutrients).length > 0).length;
  const hasMealLevelMicros = Object.keys(micros).length > 0;
  const microConfidence = totalFoods === 0 && !hasMealLevelMicros ? 'none'
    : (foodsWithMicros / totalFoods) >= 0.7 ? 'high'
    : (foodsWithMicros / totalFoods) >= 0.4 || hasMealLevelMicros ? 'medium' : 'low';

  let micro = 50;
  const gaps: string[] = [];
  if (microConfidence !== 'none') {
    let hits = 0, checked = 0;
    for (const key of KEY_MICROS) {
      const rdaVal = effectiveRDA[key] || 0;
      if (rdaVal <= 0) continue;
      checked++;
      const logged = micros[key] || 0;
      const ratio = logged / rdaVal;
      if (ratio >= 0.7) hits++;
      else if (ratio < 0.4) {
        gaps.push(key.replace(/_/g, ' '));
      }
    }
    if (checked > 0) micro = Math.round((hits / checked) * 100);
    // Low confidence: compress toward neutral to avoid false precision
    if (microConfidence === 'low') micro = Math.round(micro * 0.5 + 25);
    else if (microConfidence === 'medium') micro = Math.round(micro * 0.75 + 12.5);
  }

  // ── Confidence ──
  const confidence = loggingCompleteness < 0.3 ? 'low'
    : (loggingCompleteness < 0.7 || microConfidence === 'low') ? 'medium' : 'high';

  // ── Weighted total ──
  // Scale by confidence so partial data doesn't over-inflate
  const confidenceFactor = confidence === 'high' ? 1.0 : confidence === 'medium' ? 0.9 : 0.75;
  const [wAdh, wQual, wMicro] = GOAL_WEIGHTS[goal] ?? [0.35, 0.40, 0.25];
  const rawTotal = adherence * wAdh + quality * wQual + micro * wMicro;
  const score = Math.round(Math.min(100, Math.max(0, rawTotal * confidenceFactor)));

  // ── Tags + Wins + Improvements ──
  const tags: string[] = [];
  const wins: string[] = [];
  const improvements: string[] = [];

  // Use actual ratio for directional messaging, not just alignment score
  const calRatio = targets.calories > 0 ? totalCal / targets.calories : 1;
  const proRatio2 = targets.protein > 0 ? totalPro / targets.protein : 1;

  if (calRatio >= 0.90 && calRatio <= 1.10) {
    tags.push('Calories on target'); wins.push('Calories on target');
  } else if (calRatio > 1.10) {
    const over = Math.round((calRatio - 1) * 100);
    improvements.push(`Calories ${over}% over target`);
  } else if (totalCal > 0) {
    const under = Math.round((1 - calRatio) * 100);
    improvements.push(`Calories ${under}% under target — add ${Math.round(targets.calories - totalCal)} cal`);
  }

  if (proRatio2 >= 0.90) {
    tags.push('Protein on target'); wins.push('Protein on target');
  } else if (totalPro > 0) {
    const gap = Math.round(targets.protein - totalPro);
    improvements.push(`Protein ${gap}g below target — need more`);
  }

  if (fiberAlignment >= 0.8) { tags.push('Fiber on track'); wins.push('Fiber on track'); }
  else if (effectiveFiber > 0 && effectiveFiber < RDA.fiber * 0.5) improvements.push('Fiber low');

  if (fvServings >= 4) { tags.push('Produce goal hit'); wins.push('Good produce intake'); }
  else if (fvServings < 2) improvements.push('More fruits and vegetables');

  if (wholePct >= 70) { tags.push('Mostly whole foods'); wins.push('Mostly whole foods'); }
  if (processedPct > 50) { tags.push('High processed-food day'); improvements.push('High processed food intake'); }

  if (micro >= 70) tags.push('Micronutrient coverage: strong (est.)');
  else if (micro >= 45) tags.push('Micronutrient coverage: decent (est.)');
  else tags.push('Micronutrient coverage: low (est.)');

  for (const gap of gaps.slice(0, 3)) {
    tags.push(`Likely low ${gap}`);
    improvements.push(`Likely low ${gap}`);
  }

  if (confidence === 'low') improvements.push('Log more meals for a better score');

  return {
    score, adherence, quality, micro, confidence,
    tags, wins: wins.slice(0, 3), improvements: improvements.slice(0, 3),
    likely_gaps: gaps,
    indicators: {
      calories_alignment: Math.round(calAlignment * 100) / 100,
      protein_alignment: Math.round(proAlignment * 100) / 100,
      fiber_alignment: Math.round(fiberAlignment * 100) / 100,
      logging_completeness: Math.round(loggingCompleteness * 100) / 100,
      whole_food_pct: Math.round(wholePct),
      processed_food_pct: Math.round(processedPct),
      fruit_veg_servings: Math.round(fvServings * 10) / 10,
      micro_confidence: microConfidence,
      total_calories: totalCal,
      target_calories: targets.calories,
      total_protein: totalPro,
      target_protein: targets.protein,
    },
  };
}
