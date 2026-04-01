import AsyncStorage from '@react-native-async-storage/async-storage';
import { DailyNutritionPlan } from '../types';

const CHECKS_KEY = 'mealChecks';
const EDITS_KEY  = 'mealEdits';

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
