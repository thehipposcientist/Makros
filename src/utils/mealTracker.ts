import AsyncStorage from '@react-native-async-storage/async-storage';
import { DailyNutritionPlan, MealSuggestion } from '../types';

const CHECKS_KEY    = 'mealChecks';
const EDITS_KEY     = 'mealEdits';
const PRESERVED_KEY = 'preservedCheckedMeals';

export type MealChecks = Record<string, boolean>; // { breakfast: true, lunch: false, dinner: false }

// ── Meal check state (done/not done per day) ───────────────────────────────────

export interface DietConsistencyScore {
  /** 0–100 overall diet consistency score. */
  total: number;
  /** 0–60 — fraction of expected meals checked off over the window. */
  adherence: number;
  /** 0–25 — % of tracked days where at least one meal was checked. */
  streak: number;
  /** 0–15 — how evenly meals were logged (penalizes day clusters). */
  spread: number;
  /** Number of tracked days in the window. */
  daysTracked: number;
  /** Total meals checked across the window. */
  mealsChecked: number;
  /** Expected mealsPerDay × daysInWindow. */
  mealsExpected: number;
}

/** Compute a diet-consistency score across the last `windowDays` days,
 *  using stored `mealChecks` as the source of truth. Always returns a
 *  valid score object — when no meals have been logged yet, returns a
 *  zeroed score with mealsExpected populated so the card can render
 *  an "empty state" instead of disappearing entirely. Previously this
 *  returned null on an empty store, which made the diet score card
 *  invisible for fresh users.
 *
 *  This mirrors how the fitness score is computed in ProgressScreen —
 *  same 14-day window, same 0–100 scale — so the two scores sit
 *  side-by-side and feel comparable. */
export async function computeDietConsistency(
  mealsPerDay: number,
  windowDays: number = 14,
): Promise<DietConsistencyScore> {
  const per = Math.max(1, Math.min(10, Math.round(mealsPerDay || 3)));
  const emptyScore: DietConsistencyScore = {
    total: 0,
    adherence: 0,
    streak: 0,
    spread: 0,
    daysTracked: 0,
    mealsChecked: 0,
    mealsExpected: per * windowDays,
  };
  try {
    const raw = await AsyncStorage.getItem(CHECKS_KEY);
    if (!raw) return emptyScore;
    const all: Record<string, MealChecks> = JSON.parse(raw);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Build the set of date keys we care about (YYYY-MM-DD for today and
    // the previous `windowDays - 1` days). Missing days count as 0.
    const windowKeys: string[] = [];
    for (let i = 0; i < windowDays; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      windowKeys.push(`${yyyy}-${mm}-${dd}`);
    }

    // `per` already declared at the top of the function for the
    // empty-state object — reuse it here.
    let mealsChecked = 0;
    const daysWithChecks: boolean[] = [];
    for (const key of windowKeys) {
      const checks = all[key] ?? {};
      const count = Object.values(checks).filter(Boolean).length;
      if (count > 0) {
        mealsChecked += Math.min(count, per);
        daysWithChecks.push(true);
      } else {
        daysWithChecks.push(false);
      }
    }

    const mealsExpected = per * windowDays;
    const adherencePct = mealsExpected > 0 ? mealsChecked / mealsExpected : 0;
    const adherence = Math.round(Math.min(60, adherencePct * 60));

    const daysTracked = daysWithChecks.filter(Boolean).length;
    const streak = Math.round(Math.min(25, (daysTracked / windowDays) * 25));

    // Spread: penalize logging only on a few isolated days. If tracked
    // days cluster (stddev of gap > windowDays/3), cut the spread score.
    let spread = 0;
    if (daysTracked >= 2) {
      const idxs = daysWithChecks
        .map((v, i) => (v ? i : -1))
        .filter(i => i >= 0);
      const gaps: number[] = [];
      for (let i = 1; i < idxs.length; i++) gaps.push(idxs[i] - idxs[i - 1]);
      const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const variance = gaps.reduce((a, b) => a + (b - meanGap) ** 2, 0) / gaps.length;
      const std = Math.sqrt(variance);
      const evenness = Math.max(0, 1 - std / (windowDays / 3));
      spread = Math.round(Math.min(15, evenness * 15));
    } else if (daysTracked === 1) {
      spread = 3;
    }

    const total = Math.min(100, adherence + streak + spread);
    return {
      total,
      adherence,
      streak,
      spread,
      daysTracked,
      mealsChecked,
      mealsExpected,
    };
  } catch {
    return emptyScore;
  }
}

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

/** Clear a preserved meal by content signature (name + rounded calories). */
export async function clearPreservedMealBySignature(date: string, mealName: string, calories: number): Promise<void> {
  const all = await _readPreserved();
  if (!all[date]) return;
  const sig = `${mealName}__${Math.round(calories)}`;
  all[date] = all[date].filter(e => `${e.meal}__${Math.round(e.calories ?? 0)}` !== sig);
  if (all[date].length === 0) delete all[date];
  await _writePreserved(all);
}
