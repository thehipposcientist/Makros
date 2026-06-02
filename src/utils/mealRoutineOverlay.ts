import type { DailyNutritionPlan, MealRoutineEntry } from '../types';

function routineBackendAlias(routine: Pick<MealRoutineEntry, 'id' | 'backendId'>): string | null {
  const explicit = Number(routine.backendId ?? 0) || 0;
  const parsed = /^routine_backend_(\d+)$/.exec(String(routine.id ?? '').trim());
  const id = explicit > 0 ? explicit : parsed ? Number(parsed[1]) : 0;
  return Number.isSafeInteger(id) && id > 0 ? `routine_backend_${id}` : null;
}

export function suppressedRoutineIdSet(
  plan: Pick<DailyNutritionPlan, 'suppressedRoutineIds'> | null | undefined,
): Set<string> {
  return new Set(
    (plan?.suppressedRoutineIds ?? [])
      .map(id => String(id ?? '').trim())
      .filter(Boolean),
  );
}

export function activeMealRoutinesForPlan(
  plan: Pick<DailyNutritionPlan, 'suppressedRoutineIds'> | null | undefined,
  routines: MealRoutineEntry[],
): MealRoutineEntry[] {
  const suppressed = suppressedRoutineIdSet(plan);
  return routines.filter(r => {
    if (!r?.id || suppressed.has(r.id)) return false;
    const backendAlias = routineBackendAlias(r);
    return !backendAlias || !suppressed.has(backendAlias);
  });
}

/** Add a routine id to `suppressedRoutineIds` on the plan for `fromDate` AND
 *  every later plan in the map, dropping any routine-backed meal entry that
 *  was already materialized for that routine. Used by the "remove from today"
 *  flow so removal propagates forward symmetrically with how adding a routine
 *  propagates via applyRoutines. Pure — returns a new map plus the dates that
 *  actually changed so callers persist only what moved. */
export function suppressRoutineForwardInPlans(
  plansByDate: Record<string, DailyNutritionPlan>,
  routineId: string,
  fromDate: string,
): { plans: Record<string, DailyNutritionPlan>; changedDates: string[] } {
  const id = String(routineId ?? '').trim();
  if (!id || !fromDate) return { plans: plansByDate, changedDates: [] };
  const out: Record<string, DailyNutritionPlan> = { ...plansByDate };
  const changed: string[] = [];
  for (const [date, plan] of Object.entries(plansByDate)) {
    if (!plan || date < fromDate) continue;
    const existing = new Set(
      (plan.suppressedRoutineIds ?? [])
        .map(s => String(s ?? '').trim())
        .filter(Boolean),
    );
    const meals = plan.meals ?? [];
    const hasRoutineMeal = meals.some(m => String((m as any)?._routineId ?? '') === id);
    if (existing.has(id) && !hasRoutineMeal) continue;
    existing.add(id);
    const nextMeals = hasRoutineMeal
      ? meals.filter(m => String((m as any)?._routineId ?? '') !== id)
      : meals;
    out[date] = { ...plan, suppressedRoutineIds: Array.from(existing), meals: nextMeals };
    changed.push(date);
  }
  return { plans: out, changedDates: changed };
}
