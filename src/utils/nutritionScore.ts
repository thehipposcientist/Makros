// Client-side Nutrition Score — offline/free plan-preview fallback.
//
// The authoritative projected-plan score comes from the backend at
// /meals/score via `getNutritionScore(token)`. Use `computeNutritionScore`
// here when the backend is unavailable or for free/offline plan previews.
// The shape mirrors the backend so the UI can render either source without
// branching.
//
// Classification is NOT done here anymore — we read `food_quality` directly
// from backend-enriched meal items. That ends the drift between the two
// keyword lists we used to maintain.

import { DailyNutritionPlan, MealItem, MealSuggestion } from '../types';

export interface NutritionScoreBreakdownItem {
  label: string;
  value_pct: number;
  raw: number;
  target: number | null;
  unit: string;
  on_track: boolean;
}

export interface NutritionScoreResult {
  score: number;
  adherence: number;
  quality: number;
  micro: number;
  confidence: 'low' | 'medium' | 'high';
  tags: string[];
  wins: string[];
  improvements: string[];
  likely_gaps: string[];
  indicators: Record<string, any>;
  adherence_breakdown: NutritionScoreBreakdownItem[];
  quality_breakdown: NutritionScoreBreakdownItem[];
  micro_breakdown: NutritionScoreBreakdownItem[];
}

// Plan-preview gut facts — reported as descriptive info (no scores).
export interface PlanGutHealth {
  fiber_g: number;
  fiber_per_1000_kcal: number;
  omega3_mg: number;
  distinct_plant_foods: number;
  fermented_servings: number;
  probiotic_servings: number;
  seafood_servings: number;
  plant_protein_g: number;
  animal_protein_g: number;
  processing_counts: Record<string, number>;
  item_count: number;
}

// RDA targets used for preview-time micro scoring
const RDA: Record<string, number> = {
  fiber: 28,
  calcium: 1000,
  iron: 18,
  potassium: 4700,
  magnesium: 420,
  vitamin_d: 20,
  vitamin_b12: 2.4,
  zinc: 11,
  selenium: 55,
  folate: 400,
};

// Priority-6 — matches backend KEY_MICROS. Vitamin C dropped.
const KEY_MICROS = ['calcium', 'iron', 'potassium', 'magnesium', 'vitamin_d', 'vitamin_b12'];

const MICRO_ALIASES: Record<string, string> = {
  calcium_mg: 'calcium', iron_mg: 'iron', potassium_mg: 'potassium',
  magnesium_mg: 'magnesium', vitamin_d_mcg: 'vitamin_d',
  vitamin_b12_mcg: 'vitamin_b12', zinc_mg: 'zinc',
  fiber_g: 'fiber', selenium_mcg: 'selenium', folate_mcg: 'folate',
  folate_b9: 'folate',
  vitaminD: 'vitamin_d', vitaminB12: 'vitamin_b12',
};

function normalizeMicroKey(key: string): string {
  return MICRO_ALIASES[key] ?? key;
}

const GOAL_WEIGHTS: Record<string, [number, number, number]> = {
  fat_loss: [0.45, 0.35, 0.20],
  muscle_gain: [0.45, 0.30, 0.25],
  strength: [0.45, 0.30, 0.25],
  body_recomp: [0.40, 0.35, 0.25],
  endurance: [0.40, 0.35, 0.25],
  athletic_performance: [0.40, 0.35, 0.25],
  hyrox: [0.40, 0.35, 0.25],
  general_health: [0.30, 0.40, 0.30],
  maintain: [0.30, 0.40, 0.30],
  longevity: [0.30, 0.40, 0.30],
  healthy_aging: [0.30, 0.40, 0.30],
  heart_health: [0.30, 0.40, 0.30],
  toning: [0.45, 0.35, 0.20],
};

function bd(label: string, valuePct: number, raw: number, target: number | null, unit: string, onTrack: boolean): NutritionScoreBreakdownItem {
  return { label, value_pct: Math.max(0, Math.min(100, Math.round(valuePct))), raw: Math.round(raw * 10) / 10, target, unit, on_track: onTrack };
}

function curve(value: number, low: number, mid: number, target: number, outOf: number): number {
  if (value <= low) return 0;
  if (value >= target) return outOf;
  if (value <= mid) return outOf * 0.6 * (value - low) / (mid - low);
  return outOf * 0.6 + outOf * 0.4 * (value - mid) / (target - mid);
}

function collectAllItems(plan: DailyNutritionPlan): MealItem[] {
  const removed = new Set(plan.removedMealIds ?? []);
  return plan.meals
    .filter((_, i) => !removed.has(String(i)))
    .flatMap(m => m.items ?? []);
}

export function computePlanGutHealth(
  meals: MealSuggestion[],
  dailyMicros: Record<string, number>,
  totalCalories: number,
): PlanGutHealth {
  const items: MealItem[] = meals.flatMap(m => m.items ?? []);
  const fiber_g = dailyMicros.fiber || 0;
  const fiber_per_1000_kcal = totalCalories > 0
    ? Math.round(fiber_g / totalCalories * 1000 * 10) / 10 : 0;
  const omega3_mg = dailyMicros.omega3 || 0;

  let distinct_plant_foods = 0;
  let fermented_servings = 0;
  let probiotic_servings = 0;
  let seafood_servings = 0;
  let plant_protein_g = 0;
  let animal_protein_g = 0;
  const processing_counts: Record<string, number> = {
    minimally_processed: 0, processed: 0, ultra_processed: 0, unknown: 0,
  };

  for (const it of items) {
    distinct_plant_foods += (it as any).plant_count ?? 0;
    if ((it as any).fermented) fermented_servings++;
    if ((it as any).probiotic) probiotic_servings++;
    if ((it as any).seafood) seafood_servings++;

    const prot = (it as any).protein ?? 0;
    const src = (it as any).protein_source;
    if (src === 'plant') plant_protein_g += prot;
    else if (src === 'animal') animal_protein_g += prot;
    else if (src === 'mixed') { plant_protein_g += prot * 0.5; animal_protein_g += prot * 0.5; }

    const bucket = (it as any).processing_bucket
      ?? ((it as any).food_quality === 'whole' ? 'minimally_processed'
        : (it as any).food_quality === 'processed' ? 'processed'
        : 'unknown');
    processing_counts[bucket] = (processing_counts[bucket] || 0) + 1;
  }

  return {
    fiber_g, fiber_per_1000_kcal, omega3_mg,
    distinct_plant_foods,
    fermented_servings, probiotic_servings, seafood_servings,
    plant_protein_g: Math.round(plant_protein_g),
    animal_protein_g: Math.round(animal_protein_g),
    processing_counts, item_count: items.length,
  };
}

export function computeNutritionScore(
  plan: DailyNutritionPlan | null,
  goal: string = 'body_recomp',
  sex?: string,
): NutritionScoreResult {
  const empty: NutritionScoreResult = {
    score: 0, adherence: 0, quality: 0, micro: 0, confidence: 'low',
    tags: [], wins: [], improvements: ['Add meals to your plan'],
    likely_gaps: [], indicators: {},
    adherence_breakdown: [], quality_breakdown: [], micro_breakdown: [],
  };
  if (!plan || !plan.meals.length) return empty;

  const effectiveRDA = { ...RDA };
  if (sex && sex.toLowerCase() === 'male') effectiveRDA.iron = 8;

  const targets = plan.targets;
  const removed = new Set(plan.removedMealIds ?? []);
  const activeMeals = plan.meals.filter((_, i) => !removed.has(String(i)));
  const items = collectAllItems(plan);

  const totalCal = activeMeals.reduce((s, m) => s + (m.calories || 0), 0);
  const totalPro = activeMeals.reduce((s, m) => s + (m.protein || 0), 0);

  const micros: Record<string, number> = {};
  for (const it of items) {
    if ((it as any).micronutrients) {
      for (const [k, v] of Object.entries((it as any).micronutrients as Record<string, number>)) {
        const canonical = normalizeMicroKey(k);
        micros[canonical] = (micros[canonical] || 0) + (v || 0);
      }
    }
  }
  const itemsHaveMicros = items.some(it => (it as any).micronutrients && Object.keys((it as any).micronutrients).length > 0);
  for (const m of activeMeals) {
    const mm = (m as any).micronutrients;
    if (mm && typeof mm === 'object' && !itemsHaveMicros) {
      for (const [k, v] of Object.entries(mm as Record<string, number>)) {
        if (typeof v === 'number') {
          const canonical = normalizeMicroKey(k);
          micros[canonical] = (micros[canonical] || 0) + v;
        }
      }
    }
  }

  const fiber_g = micros['fiber'] ?? activeMeals.reduce((s, m) => s + ((m as any).fiber || 0), 0);
  const added_sugar_g = micros['added_sugar'] ?? 0;
  const sodium_mg = micros['sodium_mg'] ?? micros['sodium'] ?? 0;
  const sat_fat_g = micros['saturated_fat'] ?? 0;

  // Processing mix + plant diversity + omega-3 from per-item flags
  let minProc = 0, upf = 0, totalClassified = 0;
  let plantCount = 0;
  let omega3Servings = 0;
  let seafoodServings = 0;
  const seenPlants = new Set<string>();
  for (const it of items) {
    const fq = (it as any).food_quality;
    const bucket = (it as any).processing_bucket ??
      (fq === 'whole' ? 'minimally_processed' : fq === 'processed' ? 'processed' : null);
    if (bucket === 'minimally_processed') minProc++;
    else if (bucket === 'ultra_processed') upf++;
    if (bucket) totalClassified++;
    if ((it as any).plant_count) {
      for (let i = 0; i < ((it as any).plant_count as number); i++) seenPlants.add(`${it.name}-${i}`);
    }
    if ((it as any).omega3_rich) omega3Servings++;
    if ((it as any).seafood) seafoodServings++;
  }
  plantCount = seenPlants.size;
  const minProcPct = totalClassified > 0 ? (minProc / totalClassified) * 100 : 0;
  const upfPct = totalClassified > 0 ? (upf / totalClassified) * 100 : 0;

  // Adherence
  const calAlignment = targets.calories > 0
    ? (() => {
        const dev = Math.abs(1 - totalCal / targets.calories);
        if (dev <= 0.10) return 1.0;
        return Math.max(0, 1 - (dev - 0.10) / 0.30);
      })()
    : 0.5;
  const proRatio = targets.protein > 0 ? totalPro / targets.protein : 0.5;
  const proAlignment = proRatio >= 0.95 ? 1.0 : Math.max(0, proRatio / 0.95);

  const adherence = Math.round(Math.min(100, calAlignment * 50 + proAlignment * 50));
  const adherence_breakdown: NutritionScoreBreakdownItem[] = [
    bd('Calories', calAlignment * 100, totalCal, targets.calories, 'kcal', calAlignment >= 0.9),
    bd('Protein', proAlignment * 100, totalPro, targets.protein, 'g', proAlignment >= 0.95),
  ];

  // Food Quality — 7 inputs
  const fiberDensity = totalCal > 0 ? (fiber_g / totalCal) * 1000 : 0;
  const fiberPts = curve(fiberDensity, 6, 10, 14, 20);
  const addedSugarPct = totalCal > 0 ? (added_sugar_g * 4 / totalCal) * 100 : 0;
  let addedSugarPts: number;
  if (addedSugarPct <= 5) addedSugarPts = 15;
  else if (addedSugarPct <= 10) addedSugarPts = 15 - (addedSugarPct - 5) * 0.6;
  else if (addedSugarPct <= 15) addedSugarPts = 12 - (addedSugarPct - 10) * 1.2;
  else addedSugarPts = Math.max(0, 6 - (addedSugarPct - 15) * 0.4);

  const satFatPct = totalCal > 0 ? (sat_fat_g * 9 / totalCal) * 100 : 0;
  let satFatPts: number;
  if (satFatPct <= 7) satFatPts = 15;
  else if (satFatPct <= 10) satFatPts = 15 - (satFatPct - 7) * 1.0;
  else if (satFatPct <= 14) satFatPts = 12 - (satFatPct - 10) * 1.5;
  else satFatPts = Math.max(0, 6 - (satFatPct - 14) * 0.5);

  let sodiumPts: number;
  if (sodium_mg <= 0) sodiumPts = 5;
  else if (sodium_mg <= 2300) sodiumPts = 10;
  else if (sodium_mg <= 3500) sodiumPts = 10 - (sodium_mg - 2300) / 1200 * 4;
  else if (sodium_mg <= 4500) sodiumPts = 6 - (sodium_mg - 3500) / 1000 * 6;
  else sodiumPts = 0;

  const processedPts = Math.max(0, 20 * (minProcPct / 100 - 0.5 * upfPct / 100));
  const plantPts = plantCount >= 5 ? 10 : (plantCount / 5) * 10;
  let omegaPts = 0;
  if (omega3Servings >= 1) omegaPts = 10;
  else if (seafoodServings >= 1) omegaPts = 7;
  else omegaPts = 0;

  const qualityRaw = fiberPts + addedSugarPts + satFatPts + sodiumPts + processedPts + plantPts + omegaPts;
  const quality = Math.round(Math.min(100, Math.max(0, qualityRaw)));

  const quality_breakdown: NutritionScoreBreakdownItem[] = [
    bd('Fiber density', fiberPts / 20 * 100, fiberDensity, 14, 'g/1000kcal', fiberPts >= 14),
    bd('Added sugar', addedSugarPts / 15 * 100, addedSugarPct, 10, '% cals', addedSugarPts >= 12),
    bd('Saturated fat', satFatPts / 15 * 100, satFatPct, 10, '% cals', satFatPts >= 12),
    bd('Sodium', sodiumPts / 10 * 100, sodium_mg, 2300, 'mg', sodiumPts >= 8),
    bd('Minimally processed', processedPts / 20 * 100, minProcPct, 70, '%', processedPts >= 14),
    bd('Plant diversity', plantPts / 10 * 100, plantCount, 5, 'foods', plantPts >= 8),
    bd('Omega-3', omegaPts / 10 * 100, omega3Servings, 1, 'servings', omegaPts >= 8),
  ];

  // Micronutrient Coverage — priority 6
  const foodsWithMicros = items.filter(it => (it as any).micronutrients && Object.keys((it as any).micronutrients).length > 0).length;
  const hasMealLevelMicros = Object.keys(micros).length > 0;
  const totalFoods = Math.max(1, items.length);
  const microConfidence: 'none' | 'low' | 'medium' | 'high' =
    totalFoods === 0 && !hasMealLevelMicros ? 'none'
      : (foodsWithMicros / totalFoods) >= 0.7 ? 'high'
      : (foodsWithMicros / totalFoods) >= 0.4 || hasMealLevelMicros ? 'medium' : 'low';

  const microDisplay: Record<string, string> = {
    calcium: 'Calcium', iron: 'Iron', potassium: 'Potassium',
    magnesium: 'Magnesium', vitamin_d: 'Vitamin D', vitamin_b12: 'Vitamin B12',
  };
  const microUnit: Record<string, string> = {
    calcium: 'mg', iron: 'mg', potassium: 'mg', magnesium: 'mg',
    vitamin_d: 'mcg', vitamin_b12: 'mcg',
  };

  let micro = 50;
  const gaps: string[] = [];
  const micro_breakdown: NutritionScoreBreakdownItem[] = [];
  if (microConfidence !== 'none') {
    let hits = 0, checked = 0;
    for (const key of KEY_MICROS) {
      const rdaVal = effectiveRDA[key] || 0;
      if (rdaVal <= 0) continue;
      checked++;
      const logged = micros[key] || 0;
      const ratio = logged / rdaVal;
      const onTrack = ratio >= 0.7;
      if (onTrack) hits++;
      else if (ratio < 0.4) gaps.push(microDisplay[key] || key);
      micro_breakdown.push(bd(microDisplay[key] || key, Math.min(100, ratio * 100), logged, rdaVal, microUnit[key] || '', onTrack));
    }
    micro = checked > 0 ? Math.round((hits / checked) * 100) : 50;
    if (microConfidence === 'low') micro = Math.round(micro * 0.5 + 25);
    else if (microConfidence === 'medium') micro = Math.round(micro * 0.75 + 12.5);
  }

  // Confidence
  const mealsLogged = activeMeals.length;
  const mealsExpected = Math.max(1, plan.meals.length);
  const loggingCompleteness = Math.min(1, mealsLogged / mealsExpected);
  const confidence: 'low' | 'medium' | 'high' =
    loggingCompleteness < 0.3 ? 'low'
      : (loggingCompleteness < 0.7 || microConfidence === 'low') ? 'medium' : 'high';
  const confidenceFactor = confidence === 'high' ? 1.0 : confidence === 'medium' ? 0.9 : 0.75;

  const [wAdh, wQual, wMicro] = GOAL_WEIGHTS[goal] ?? [0.40, 0.35, 0.25];
  const rawTotal = adherence * wAdh + quality * wQual + micro * wMicro;
  const score = Math.round(Math.min(100, Math.max(0, rawTotal * confidenceFactor)));

  // Tags + wins + improvements
  const tags: string[] = [];
  const wins: string[] = [];
  const improvements: string[] = [];
  const calRatio = targets.calories > 0 ? totalCal / targets.calories : 1;
  const proRatio2 = targets.protein > 0 ? totalPro / targets.protein : 1;

  if (calRatio >= 0.9 && calRatio <= 1.1) {
    tags.push('Calories on target'); wins.push('Calories on target');
  } else if (calRatio > 1.1) {
    improvements.push(`Calories ${Math.round((calRatio - 1) * 100)}% over target`);
  } else if (totalCal > 0) {
    improvements.push(`Calories ${Math.round((1 - calRatio) * 100)}% under target`);
  }

  if (proRatio2 >= 0.9) { tags.push('Protein on target'); wins.push('Protein on target'); }
  else if (totalPro > 0) improvements.push(`Protein ${Math.round(targets.protein - totalPro)}g below target`);

  if (fiberPts >= 14) { tags.push('Fiber on track'); wins.push('Fiber on track'); }
  else if (fiberDensity < 8 && totalCal > 0) improvements.push('Fiber low');

  if (minProcPct >= 70) { tags.push('Mostly whole foods'); wins.push('Mostly whole foods'); }
  if (upfPct >= 35) improvements.push('Ultra-processed food intake high');
  if (addedSugarPct > 10) improvements.push(`Added sugar ${Math.round(addedSugarPct)}% of calories`);
  if (satFatPct > 10) improvements.push(`Saturated fat ${Math.round(satFatPct)}% of calories`);
  if (plantCount >= 5) wins.push(`${plantCount} distinct plants`);
  else if (plantCount < 3 && totalCal > 0) improvements.push('Add more plant variety');
  if (omegaPts >= 8) wins.push('Omega-3 source included');

  for (const gap of gaps.slice(0, 3)) improvements.push(`Low ${gap.toLowerCase()}`);
  if (confidence === 'low') improvements.push('Log more meals for a better score');

  return {
    score, adherence, quality, micro, confidence,
    tags, wins: wins.slice(0, 4), improvements: improvements.slice(0, 4),
    likely_gaps: gaps,
    adherence_breakdown, quality_breakdown, micro_breakdown,
    indicators: {
      calories_alignment: Math.round(calAlignment * 100) / 100,
      protein_alignment: Math.round(proAlignment * 100) / 100,
      fiber_density: Math.round(fiberDensity * 10) / 10,
      added_sugar_pct_cals: Math.round(addedSugarPct * 10) / 10,
      sat_fat_pct_cals: Math.round(satFatPct * 10) / 10,
      sodium_mg: Math.round(sodium_mg),
      minimally_processed_pct: Math.round(minProcPct),
      ultra_processed_pct: Math.round(upfPct),
      distinct_plant_foods: plantCount,
      omega3_servings: omega3Servings,
      seafood_servings_weekly: seafoodServings,
      logging_completeness: Math.round(loggingCompleteness * 100) / 100,
      micro_confidence: microConfidence,
      total_calories: totalCal,
      target_calories: targets.calories,
      total_protein: totalPro,
      target_protein: targets.protein,
    },
  };
}

// Legacy export kept for callers that still expect a boolean classifier.
// Returns the persisted quality if provided, else 'unknown'. Never guesses.
export function classifyFood(_name: string, persisted?: 'whole' | 'processed' | 'unknown'): 'whole' | 'processed' | 'unknown' {
  return persisted ?? 'unknown';
}
