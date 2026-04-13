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

/** Wipe every per-day nutrition save. Called after a successful plan
 *  regeneration so the new rotating templates win on the next load
 *  instead of being shadowed by stale day-specific edits. */
export async function clearAllSavedNutritionPlans(): Promise<void> {
  try {
    await AsyncStorage.removeItem(EDITS_KEY);
  } catch {}
}

// ── Preserved meals (survive plan regeneration) ───────────────────────────────
// When the user checks a meal as eaten, we snapshot its exact content here.
// On the next loadPlans, the snapshot is merged into the day's meals[] list
// so regenerating a plan never clobbers meals the user has already logged.
//
// New shape (no more fixed/extras split — meals are uniform now):
//   {
//     "2026-04-13": [
//       { _localId: "xyz", meal: "Power bowl", ... },
//       { _localId: "abc", meal: "Pre-workout shake", ... },
//     ],
//     ...
//   }
//
// Each preserved meal carries a stable `_localId` so a re-check (or a
// regenerated plan) doesn't duplicate it.

type PreservedMap = Record<string, MealSuggestion[]>;

async function _readPreserved(): Promise<PreservedMap> {
  try {
    const raw = await AsyncStorage.getItem(PRESERVED_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    // Lazy migration from older shapes:
    //   v1: { breakfast: {...}, lunch: {...} }   (flat slot map)
    //   v2: { fixed: {breakfast: {...}}, extras: [...] }
    //   v3: [ {...}, {...} ]                      (current — flat list)
    const migrated: PreservedMap = {};
    for (const [date, value] of Object.entries(parsed as any)) {
      if (Array.isArray(value)) {
        migrated[date] = value as MealSuggestion[];
        continue;
      }
      const list: MealSuggestion[] = [];
      if (value && typeof value === 'object') {
        const v = value as any;
        if (v.fixed && typeof v.fixed === 'object') {
          for (const m of Object.values(v.fixed)) {
            if (m) list.push(m as MealSuggestion);
          }
        }
        if (Array.isArray(v.extras)) {
          for (const m of v.extras) if (m) list.push(m as MealSuggestion);
        }
        // v1 flat-slot fallback
        if (!v.fixed && !v.extras) {
          for (const m of Object.values(v)) if (m && typeof m === 'object') list.push(m as MealSuggestion);
        }
      }
      migrated[date] = list;
    }
    return migrated;
  } catch {
    return {};
  }
}

async function _writePreserved(map: PreservedMap): Promise<void> {
  const keys = Object.keys(map).sort().reverse().slice(0, 14);
  const pruned: PreservedMap = {};
  keys.forEach(k => { pruned[k] = map[k]; });
  try { await AsyncStorage.setItem(PRESERVED_KEY, JSON.stringify(pruned)); } catch {}
}

export async function getPreservedMeals(date: string): Promise<MealSuggestion[]> {
  const all = await _readPreserved();
  return all[date] ?? [];
}

/** Snapshot a meal the user just checked off. Every meal gets (or already
 *  has) a stable `_localId` so subsequent checks of the same meal dedupe. */
export async function savePreservedMeal(date: string, _mealType: string, meal: MealSuggestion): Promise<void> {
  const all = await _readPreserved();
  const list = all[date] ?? [];
  const withId: MealSuggestion = (meal as any)._localId
    ? meal
    : { ...meal, _localId: `preserved_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` } as MealSuggestion;
  const existingIdx = list.findIndex(e => (e as any)._localId === (withId as any)._localId);
  if (existingIdx >= 0) list[existingIdx] = withId;
  else list.push(withId);
  all[date] = list;
  await _writePreserved(all);
}

/** Clear a preserved meal by `_localId`. */
export async function clearPreservedMeal(date: string, _mealType: string, mealLocalId?: string): Promise<void> {
  const all = await _readPreserved();
  if (!all[date]) return;
  if (!mealLocalId) return;
  all[date] = all[date].filter(e => (e as any)._localId !== mealLocalId);
  if (all[date].length === 0) delete all[date];
  await _writePreserved(all);
}
