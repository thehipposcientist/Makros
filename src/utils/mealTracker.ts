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
// When the user checks a meal as eaten, we snapshot that meal's exact content
// here. On the next loadPlans, the snapshot is overlaid onto whatever the new
// plan contains for that (date, mealType). Result: regenerating a plan never
// clobbers meals the user has already logged.

type PreservedMap = Record<string, Record<string, MealSuggestion>>;

async function _readPreserved(): Promise<PreservedMap> {
  try {
    const raw = await AsyncStorage.getItem(PRESERVED_KEY);
    return raw ? JSON.parse(raw) : {};
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

export async function getPreservedMeals(date: string): Promise<Record<string, MealSuggestion>> {
  const all = await _readPreserved();
  return all[date] ?? {};
}

export async function savePreservedMeal(date: string, mealType: string, meal: MealSuggestion): Promise<void> {
  const all = await _readPreserved();
  all[date] = { ...(all[date] ?? {}), [mealType]: meal };
  await _writePreserved(all);
}

export async function clearPreservedMeal(date: string, mealType: string): Promise<void> {
  const all = await _readPreserved();
  if (!all[date]) return;
  delete all[date][mealType];
  if (Object.keys(all[date]).length === 0) delete all[date];
  await _writePreserved(all);
}
