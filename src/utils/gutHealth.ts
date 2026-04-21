/**
 * Gut-health signals derived from nutrition logs.
 *
 * Two core metrics that are cheap to compute and evidence-backed:
 *   1. Plant diversity — distinct plant foods logged in the last 7 days.
 *      The "30 plants per week" heuristic comes from the American Gut
 *      Project. Higher diversity correlates with microbiome variety.
 *   2. Fiber intake — aggregated from the micronutrient panel already
 *      on each meal. Surfaced here so the UI can show "on track" vs
 *      "under" without the caller having to sum manually.
 *
 * Deliberately NOT making hormone or microbiome-composition claims —
 * those require sequencing / blood panels we don't have.
 */
import type { DailyNutritionPlan, MealSuggestion } from '../types';

// Plant-food detection via keyword match. Broad enough to catch typical
// logged items ("Spinach", "Spinach (cooked)", "Baby spinach salad").
// We lowercase + substring-match; the seed food library uses consistent
// names so false-positive rate is low in practice.
const PLANT_KEYWORDS = [
  // Leafy greens
  'spinach', 'kale', 'arugula', 'romaine', 'lettuce', 'chard', 'collard', 'mixed greens', 'bok choy', 'watercress',
  // Cruciferous
  'broccoli', 'cauliflower', 'brussels sprout', 'cabbage',
  // Alliums
  'onion', 'garlic', 'leek', 'scallion', 'shallot', 'chive',
  // Roots / tubers
  'sweet potato', 'potato', 'carrot', 'beet', 'radish', 'turnip', 'parsnip', 'yam',
  // Squash family
  'zucchini', 'squash', 'pumpkin', 'cucumber',
  // Nightshades + peppers
  'tomato', 'pepper', 'eggplant', 'chili',
  // Stalks / pods
  'asparagus', 'celery', 'artichoke', 'fennel', 'green bean', 'snap pea', 'snow pea', 'okra',
  // Mushrooms
  'mushroom', 'portobello', 'shiitake', 'cremini',
  // Legumes (prebiotic-rich)
  'lentil', 'chickpea', 'black bean', 'pinto', 'kidney bean', 'navy bean', 'edamame', 'soybean', 'tofu', 'tempeh',
  // Whole grains
  'oat', 'quinoa', 'brown rice', 'wild rice', 'barley', 'buckwheat', 'farro', 'bulgur', 'millet', 'rye', 'spelt',
  'whole wheat', 'whole grain', 'sprouted',
  // Fruits
  'apple', 'banana', 'orange', 'berry', 'berries', 'blueberr', 'strawberr', 'raspberr', 'blackberr',
  'grape', 'cherry', 'peach', 'pear', 'plum', 'mango', 'pineapple', 'kiwi', 'watermelon', 'cantaloupe', 'melon',
  'papaya', 'pomegranate', 'avocado', 'fig', 'date', 'apricot',
  // Nuts + seeds
  'almond', 'walnut', 'cashew', 'pecan', 'pistachio', 'hazelnut', 'brazil nut', 'peanut',
  'chia seed', 'flax', 'pumpkin seed', 'sunflower seed', 'sesame', 'hemp seed',
  // Fermented (prebiotic → gut)
  'kimchi', 'sauerkraut', 'kombucha', 'miso', 'kefir', 'yogurt',
  // Herbs (not weighted heavily but count as diversity)
  'basil', 'parsley', 'cilantro', 'mint', 'oregano', 'rosemary', 'thyme', 'dill', 'ginger', 'turmeric',
];

/** Normalize a food name → canonical plant key for de-duping the
 *  7-day count. "Baby spinach salad" and "Sautéed spinach" both
 *  resolve to "spinach" so we don't over-count the same species. */
function plantKey(name: string): string | null {
  const lower = name.toLowerCase();
  for (const kw of PLANT_KEYWORDS) {
    if (lower.includes(kw)) return kw;
  }
  return null;
}

export interface PlantDiversityResult {
  /** Distinct plant-food keys counted across the window. */
  distinctCount: number;
  /** 0–100 score against a 30-plant weekly target. */
  score: number;
  /** "on_track" (25+), "building" (15–24), "low" (<15). */
  tier: 'on_track' | 'building' | 'low';
  /** Short banner copy for UI display. */
  message: string;
  /** Sorted list of plant names found, for debug or detail modal. */
  plantsFound: string[];
}

export function computePlantDiversity(
  plansByDate: Record<string, DailyNutritionPlan>,
  checkedByDate: Record<string, Record<string, boolean>>,
  windowDays: number = 7,
): PlantDiversityResult {
  // Only count meals the user CHECKED OFF — we care about what they
  // actually ate, not what was planned. Missing check state → skip
  // the day.
  const today = new Date();
  const keys: Set<string> = new Set();
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(today.getTime() - i * 86400000);
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const plan = plansByDate[dateKey];
    const checks = checkedByDate[dateKey];
    if (!plan || !checks) continue;
    (plan.meals ?? []).forEach((meal, idx) => {
      const key = `meal_${idx}`;
      if (!checks[key]) return;
      extractPlantsFromMeal(meal, keys);
    });
  }

  const distinctCount = keys.size;
  const score = Math.min(100, Math.round((distinctCount / 30) * 100));
  let tier: PlantDiversityResult['tier'] = 'low';
  if (distinctCount >= 25) tier = 'on_track';
  else if (distinctCount >= 15) tier = 'building';

  const message =
    tier === 'on_track' ? `${distinctCount} plants — excellent diversity`
    : tier === 'building' ? `${distinctCount} plants — aim for 25+ / week`
    : `${distinctCount} plants — add variety for gut health`;

  return {
    distinctCount,
    score,
    tier,
    message,
    plantsFound: Array.from(keys).sort(),
  };
}

function extractPlantsFromMeal(meal: MealSuggestion, out: Set<string>) {
  const items = meal.items ?? [];
  if (items.length > 0) {
    for (const it of items) {
      const k = plantKey(it.name);
      if (k) out.add(k);
    }
    return;
  }
  // Fallback for older meals that stored foods/amounts instead of items[]
  for (const name of (meal.foods ?? [])) {
    const k = plantKey(name);
    if (k) out.add(k);
  }
}

// ── Fiber aggregation ──────────────────────────────────────────────────

export interface FiberDayResult {
  /** Total fiber consumed (grams) across checked meals today. */
  grams: number;
  /** Target based on sex + age + goal. Default 30g. */
  target: number;
  /** 0–100 progress toward target. */
  pct: number;
  /** "on_track" / "low". */
  tier: 'on_track' | 'low';
  message: string;
}

export function computeFiberToday(
  plan: DailyNutritionPlan | null,
  checks: Record<string, boolean> | null,
  targetGrams: number = 30,
): FiberDayResult {
  let grams = 0;
  if (plan?.meals && checks) {
    (plan.meals ?? []).forEach((meal, idx) => {
      if (!checks[`meal_${idx}`]) return;
      for (const item of (meal.items ?? [])) {
        const fiber = Number((item as any).fiber ?? 0);
        if (fiber > 0) grams += fiber;
      }
    });
  }
  grams = Math.round(grams * 10) / 10;
  const pct = Math.min(100, Math.round((grams / Math.max(1, targetGrams)) * 100));
  const tier: FiberDayResult['tier'] = pct >= 80 ? 'on_track' : 'low';
  const message = tier === 'on_track'
    ? `${grams}g fiber today — on track`
    : `${grams}g / ${targetGrams}g fiber — add more whole plants`;
  return { grams, target: targetGrams, pct, tier, message };
}

/** Age + sex + goal-aware fiber target. Longevity bumps +10g above baseline. */
export function recommendedFiberTarget(sex: string | undefined, age: number | undefined, goal: string | undefined): number {
  const base = sex === 'female' ? 25 : 38;
  const goalBump = (goal || '').toLowerCase() === 'longevity' ? 5 : 0;
  const ageDrop = age != null && age >= 65 ? 5 : 0;  // elderly get slightly lower targets
  return Math.max(20, base + goalBump - ageDrop);
}
