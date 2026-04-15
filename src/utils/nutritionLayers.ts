/**
 * Layered nutrition display rules.
 *
 * The app shows different nutrients in different places. This file is
 * the single source of truth for WHICH nutrients belong WHERE and what
 * their daily targets + "concerning" thresholds are.
 *
 * Layer 1 — always visible (meal cards, daily totals, weekly charts)
 * Layer 2 — on demand (meal detail "more nutrition", daily modal expand)
 * Layer 3 — advanced only (behind a second toggle, rarely surfaced)
 */

export const NUTRIENT_LAYER_1 = [
  'calories', 'protein', 'carbs', 'fat',
  'fiber', 'sugar', 'sodium',
] as const;

export const NUTRIENT_LAYER_2 = [
  'saturatedFat', 'monounsaturatedFat', 'polyunsaturatedFat',
  'omega3', 'omega6', 'cholesterol',
  'potassium', 'calcium', 'iron', 'magnesium',
  'vitaminD', 'vitaminC', 'vitaminB12',
] as const;

export const NUTRIENT_LAYER_3 = [
  'addedSugar', 'folate', 'zinc', 'vitaminA', 'vitaminB6',
  'niacin', 'thiamin', 'riboflavin', 'phosphorus', 'selenium',
  'copper', 'manganese', 'iodine',
] as const;

export type Layer1Nutrient = typeof NUTRIENT_LAYER_1[number];
export type Layer2Nutrient = typeof NUTRIENT_LAYER_2[number];
export type Layer3Nutrient = typeof NUTRIENT_LAYER_3[number];
export type NutrientKey = Layer1Nutrient | Layer2Nutrient | Layer3Nutrient;

export type NutrientDirection = 'min' | 'max';

export interface NutrientTarget {
  amount: number;
  unit: string;
  direction: NutrientDirection;
  label: string;
}

/**
 * Daily targets. These are general adult recommendations — the app
 * should override with user-specific values when macros are computed
 * (calories / protein / carbs / fat come from the calorie calculator,
 * not from this table).
 *
 * `direction = min` → higher is better; warn when < target.
 * `direction = max` → lower is better; warn when > target.
 */
export const DAILY_TARGETS: Partial<Record<NutrientKey, NutrientTarget>> = {
  // Layer 1
  fiber:       { amount: 28,   unit: 'g',  direction: 'min', label: 'Fiber' },
  sugar:       { amount: 50,   unit: 'g',  direction: 'max', label: 'Sugar' },
  sodium:      { amount: 2300, unit: 'mg', direction: 'max', label: 'Sodium' },
  // Layer 2
  saturatedFat:{ amount: 20,   unit: 'g',  direction: 'max', label: 'Saturated fat' },
  omega3:      { amount: 1600, unit: 'mg', direction: 'min', label: 'Omega-3' },
  cholesterol: { amount: 300,  unit: 'mg', direction: 'max', label: 'Cholesterol' },
  potassium:   { amount: 3400, unit: 'mg', direction: 'min', label: 'Potassium' },
  calcium:     { amount: 1000, unit: 'mg', direction: 'min', label: 'Calcium' },
  iron:        { amount: 18,   unit: 'mg', direction: 'min', label: 'Iron' },
  magnesium:   { amount: 400,  unit: 'mg', direction: 'min', label: 'Magnesium' },
  vitaminD:    { amount: 15,   unit: 'mcg',direction: 'min', label: 'Vitamin D' },
  vitaminC:    { amount: 90,   unit: 'mg', direction: 'min', label: 'Vitamin C' },
  vitaminB12:  { amount: 2.4,  unit: 'mcg',direction: 'min', label: 'Vitamin B12' },
  // Layer 3 (only surfaced when critically off)
  addedSugar:  { amount: 36,   unit: 'g',  direction: 'max', label: 'Added sugar' },
  zinc:        { amount: 11,   unit: 'mg', direction: 'min', label: 'Zinc' },
  folate:      { amount: 400,  unit: 'mcg',direction: 'min', label: 'Folate' },
};

/**
 * Insight rule: when to surface a nutrient as a problem.
 *
 * Returns null if the nutrient is within a safe band (±15% of target),
 * otherwise returns a severity + one-line summary + ratio.
 */
export type InsightSeverity = 'critical' | 'notable' | 'info';

export interface NutrientInsight {
  key: NutrientKey;
  label: string;
  severity: InsightSeverity;
  actual: number;
  target: number;
  unit: string;
  direction: NutrientDirection;
  ratio: number;
  summary: string;
}

export function evaluateNutrient(key: NutrientKey, actual: number): NutrientInsight | null {
  const t = DAILY_TARGETS[key];
  if (!t) return null;
  if (actual == null || !Number.isFinite(actual)) return null;

  const ratio = actual / t.amount;
  let severity: InsightSeverity | null = null;

  if (t.direction === 'min') {
    // Higher = better. Warn when below target.
    if (ratio < 0.60) severity = 'critical';
    else if (ratio < 0.85) severity = 'notable';
  } else {
    // Lower = better. Warn when above target.
    if (ratio > 1.40) severity = 'critical';
    else if (ratio > 1.15) severity = 'notable';
  }
  if (!severity) return null;

  // Short summary — the insight engine may override with a more
  // specific suggested fix.
  const direction = t.direction === 'min' ? 'low' : 'high';
  const summary = `${t.label} is ${direction} — ${Math.round(actual)}${t.unit} vs target ${t.amount}${t.unit}.`;

  return {
    key,
    label: t.label,
    severity,
    actual,
    target: t.amount,
    unit: t.unit,
    direction: t.direction,
    ratio,
    summary,
  };
}

/**
 * Rank-ordered suggested fixes for common gaps. Used by the insight
 * card to show an actionable next step, not just a complaint.
 */
export const FIX_SUGGESTIONS: Partial<Record<NutrientKey, string>> = {
  fiber:        'Add a cup of berries to breakfast or swap white rice for black beans.',
  sodium:       'Sodium is mostly in packaged + restaurant meals — home-cook one more meal a day.',
  omega3:       'A 4 oz salmon fillet twice a week or a daily tablespoon of ground flax.',
  potassium:    'Add a banana, avocado, or a cup of cooked spinach.',
  calcium:      'Add Greek yogurt or a cup of cottage cheese.',
  magnesium:    'Add a handful of pumpkin seeds, almonds, or dark chocolate.',
  vitaminD:     'Fatty fish twice a week, or a 1000 IU D3 supplement if sunlight is low.',
  saturatedFat: 'Swap butter for olive oil on one meal a day.',
  addedSugar:   'Check drinks and sauces first — that\'s where most added sugar hides.',
};

/**
 * Backend ships micronutrients in snake_case (saturated_fat, vitamin_d,
 * omega_3, vitamin_b12) per MICRONUTRIENT_FIELDS in meal_assembler.py.
 * The frontend insight engine uses camelCase. This map translates the
 * backend keys to the canonical camelCase the engine expects.
 */
const BACKEND_KEY_ALIASES: Record<string, NutrientKey> = {
  // Fats
  saturated_fat: 'saturatedFat',
  monounsaturated_fat: 'monounsaturatedFat',
  polyunsaturated_fat: 'polyunsaturatedFat',
  omega_3: 'omega3',
  omega_6: 'omega6',
  // Vitamins
  vitamin_a: 'vitaminA',
  vitamin_c: 'vitaminC',
  vitamin_d: 'vitaminD',
  vitamin_b6: 'vitaminB6',
  vitamin_b12: 'vitaminB12',
  folate_b9: 'folate',
  thiamin_b1: 'thiamin',
  riboflavin_b2: 'riboflavin',
  niacin_b3: 'niacin',
  // Minerals — these happen to already match
  // calcium, iron, magnesium, phosphorus, potassium, zinc, selenium, copper, manganese
  // Legacy matches — pass through
  fiber: 'fiber',
  sugar: 'sugar',
  sodium: 'sodium',
  cholesterol: 'cholesterol',
};

/**
 * Normalize a totals dict so the insight engine sees canonical
 * camelCase keys regardless of whether the source used snake_case
 * (backend micronutrients blob) or camelCase (already-normalized
 * client state). Safe to call on any dict.
 */
export function normalizeNutrientKeys(raw: Record<string, any>): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const canonical = BACKEND_KEY_ALIASES[k] || (k as NutrientKey);
    // Last-writer-wins: if the same canonical key was already set, keep
    // the larger value (handles the rare case where both keys are present).
    if (out[canonical] == null || v > out[canonical]) {
      out[canonical] = v;
    }
  }
  return out;
}

/**
 * Collect all Layer-1 + Layer-2 insights for a day's totals. Sorted
 * critical → notable, then by severity of deviation. Caller decides
 * how many to show (recommend ≤3).
 *
 * Accepts either snake_case or camelCase input — calls
 * `normalizeNutrientKeys` internally.
 */
export function computeDayInsights(dayTotals: Record<string, number>): NutrientInsight[] {
  const normalized = normalizeNutrientKeys(dayTotals);
  const candidates: NutrientInsight[] = [];
  const keys: NutrientKey[] = [...NUTRIENT_LAYER_1, ...NUTRIENT_LAYER_2] as any;
  for (const k of keys) {
    if (!(k in DAILY_TARGETS)) continue;
    const v = normalized[k];
    const ins = evaluateNutrient(k, v);
    if (ins) candidates.push(ins);
  }
  candidates.sort((a, b) => {
    const sev = { critical: 0, notable: 1, info: 2 };
    if (sev[a.severity] !== sev[b.severity]) return sev[a.severity] - sev[b.severity];
    const da = a.direction === 'min' ? 1 - a.ratio : a.ratio - 1;
    const db = b.direction === 'min' ? 1 - b.ratio : b.ratio - 1;
    return db - da;
  });
  return candidates;
}
