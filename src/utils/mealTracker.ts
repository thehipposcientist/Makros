import AsyncStorage from '@react-native-async-storage/async-storage';
import { DailyNutritionPlan, MealSuggestion } from '../types';

const CHECKS_KEY    = 'mealChecks';
const EDITS_KEY     = 'mealEdits';
const PRESERVED_KEY = 'preservedCheckedMeals';

export type MealChecks = Record<string, boolean>; // { breakfast: true, lunch: false, dinner: false }

// ── Meal check state (done/not done per day) ───────────────────────────────────

export async function getMealChecks(date: string): Promise<MealChecks> {
  try {
    const raw = await AsyncStorage.getItem(CHECKS_KEY);
    const all: Record<string, MealChecks> = raw ? JSON.parse(raw) : {};
    return all[date] ?? {};
  } catch {
    return {};
  }
}

export async function saveMealChecks(date: string, checks: MealChecks): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(CHECKS_KEY);
    const all: Record<string, MealChecks> = raw ? JSON.parse(raw) : {};
    all[date] = checks;
    const keys = Object.keys(all).sort().reverse().slice(0, 14);
    const pruned: Record<string, MealChecks> = {};
    keys.forEach(k => { pruned[k] = all[k]; });
    await AsyncStorage.setItem(CHECKS_KEY, JSON.stringify(pruned));
  } catch {}
}

// ── Meal edits (custom nutrition plan per day) ─────────────────────────────────

export async function getSavedNutritionPlan(date: string): Promise<DailyNutritionPlan | null> {
  try {
    const raw = await AsyncStorage.getItem(EDITS_KEY);
    const all: Record<string, DailyNutritionPlan> = raw ? JSON.parse(raw) : {};
    return all[date] ?? null;
  } catch {
    return null;
  }
}

export async function saveNutritionPlan(date: string, plan: DailyNutritionPlan): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(EDITS_KEY);
    const all: Record<string, DailyNutritionPlan> = raw ? JSON.parse(raw) : {};
    all[date] = plan;
    const keys = Object.keys(all).sort().reverse().slice(0, 7);
    const pruned: Record<string, DailyNutritionPlan> = {};
    keys.forEach(k => { pruned[k] = all[k]; });
    await AsyncStorage.setItem(EDITS_KEY, JSON.stringify(pruned));
  } catch {}
}

// ── Preserved meals (survive plan regeneration) ───────────────────────────────
// When the user checks a meal as eaten, we snapshot its exact content here.
// On the next loadPlans, the snapshot is overlaid onto the new plan for that
// date — regenerating a plan never clobbers meals the user has already logged.
//
// Shape:
//   {
//     "2026-04-13": {
//       fixed: { breakfast: {...}, dinner: {...} },
//       extras: [
//         { _localId: "xyz", meal: "Pre-workout shake", ... },
//         ...
//       ],
//     },
//     ...
//   }
//
// Fixed slots overwrite plan[slot] on load. Extras are appended to
// plan.extraMeals, matched by `_localId` so a second check of the same
// extra doesn't duplicate it.

type PreservedDay = {
  fixed: Record<string, MealSuggestion>;
  extras: MealSuggestion[];
};
type PreservedMap = Record<string, PreservedDay>;

async function _readPreserved(): Promise<PreservedMap> {
  try {
    const raw = await AsyncStorage.getItem(PRESERVED_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    // Lazy migration from the old flat-record shape. Old entries are
    // `{ breakfast: {...}, lunch: {...} }`. New shape is wrapped.
    const migrated: PreservedMap = {};
    for (const [date, value] of Object.entries(parsed as any)) {
      if (value && typeof value === 'object' && 'fixed' in (value as any)) {
        migrated[date] = value as PreservedDay;
      } else {
        migrated[date] = { fixed: (value as any) ?? {}, extras: [] };
      }
    }
    return migrated;
  } catch {
    return {};
  }
}

async function _writePreserved(map: PreservedMap): Promise<void> {
  // Keep only the last 14 days to bound storage.
  const keys = Object.keys(map).sort().reverse().slice(0, 14);
  const pruned: PreservedMap = {};
  keys.forEach(k => { pruned[k] = map[k]; });
  try { await AsyncStorage.setItem(PRESERVED_KEY, JSON.stringify(pruned)); } catch {}
}

export async function getPreservedMeals(date: string): Promise<PreservedDay> {
  const all = await _readPreserved();
  return all[date] ?? { fixed: {}, extras: [] };
}

/** Snapshot a meal the user just checked off. Handles both fixed slots
 *  ("breakfast"/"lunch"/"dinner"/"snack") and extras (mealType starting
 *  with "extra_" or equal to "new_extra"). Extras get a stable `_localId`
 *  so they can be deduped on subsequent passes. */
export async function savePreservedMeal(date: string, mealType: string, meal: MealSuggestion): Promise<void> {
  const all = await _readPreserved();
  const day: PreservedDay = all[date] ?? { fixed: {}, extras: [] };
  if (mealType.startsWith('extra_') || mealType === 'new_extra') {
    const withId: MealSuggestion = (meal as any)._localId
      ? meal
      : { ...meal, _localId: `preserved_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` } as MealSuggestion;
    // Dedupe by _localId so a re-check doesn't append a duplicate.
    const existingIdx = day.extras.findIndex(e => (e as any)._localId === (withId as any)._localId);
    if (existingIdx >= 0) day.extras[existingIdx] = withId;
    else day.extras.push(withId);
  } else {
    day.fixed[mealType] = meal;
  }
  all[date] = day;
  await _writePreserved(all);
}

/** Clear a preserved meal. For extras, pass the mealType of the extra in
 *  the currently-rendered plan (e.g. "extra_2") — we resolve it to a
 *  `_localId` using the caller-provided meal object. */
export async function clearPreservedMeal(date: string, mealType: string, mealLocalId?: string): Promise<void> {
  const all = await _readPreserved();
  if (!all[date]) return;
  const day = all[date];
  if (mealType.startsWith('extra_') || mealType === 'new_extra') {
    if (!mealLocalId) return;
    day.extras = day.extras.filter(e => (e as any)._localId !== mealLocalId);
  } else {
    delete day.fixed[mealType];
  }
  if (Object.keys(day.fixed).length === 0 && day.extras.length === 0) {
    delete all[date];
  }
  await _writePreserved(all);
}
