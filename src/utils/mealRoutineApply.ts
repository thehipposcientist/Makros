// Pure routine→plan merge logic, extracted from workoutHistory so it carries
// NO React-Native / AsyncStorage deps and can be unit-tested in node. This is
// the most bug-prone part of meal handling (it's what made "editing a routine
// duplicates it" possible), so it gets its own home + tests.
//
// Derive-don't-persist: routines are the source of truth for "this meal
// repeats every day". Plans never stamp `isRoutine: true` directly — every
// code path that writes a DailyNutritionPlan passes it through applyRoutines
// first, so AI regen can't wipe routines and future days get them for free.
import type { DailyNutritionPlan, MealRoutineEntry, MealSuggestion } from '../types';
// Explicit .ts extensions: these are the only runtime relative imports in this
// module, and the extension lets the (leaf-only) node test runner resolve them
// so the merge logic can be unit-tested. tsconfig has allowImportingTsExtensions
// and Metro resolves explicit source extensions, so this is safe at build time.
import { migrateNutritionPlanShape } from './mealItems.ts';
import { ensureMealClientKeys, normalizeMealChecksForPlan } from './mealPlanState.ts';
import { activeMealRoutinesForPlan, suppressedRoutineIdSet } from './mealRoutineOverlay.ts';

function routineDisplayOrder(routine: MealRoutineEntry, fallback: number): number {
  const n = Number(routine.displayOrder);
  return Number.isFinite(n) ? n : fallback;
}

function routineBackendId(value: unknown): number | null {
  const n = Number(value ?? 0) || 0;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function routineBackendIdFromClientId(value: unknown): number | null {
  const match = /^routine_backend_(\d+)$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return routineBackendId(match[1]);
}

function routineBackendAlias(routine: Pick<MealRoutineEntry, 'id' | 'backendId'>): string | null {
  const id = routineBackendId(routine.backendId) ?? routineBackendIdFromClientId(routine.id);
  return id != null ? `routine_backend_${id}` : null;
}

function mealRoutineBackendAlias(meal: MealSuggestion): string | null {
  const id = routineBackendId((meal as any).source_routine_id) ?? routineBackendIdFromClientId((meal as any)._routineId);
  return id != null ? `routine_backend_${id}` : null;
}

/** Build a MealSuggestion from a MealRoutineEntry. Prefers the structured
 *  `items[]` snapshot when available (new routines) and falls back to the
 *  legacy foods[]/amounts[] shape for routines saved before items existed. */
export function mealFromRoutine(routine: MealRoutineEntry, fallback?: MealSuggestion): MealSuggestion {
  const hasItems = routine.items && routine.items.length > 0;
  const foods = hasItems ? routine.items!.map(i => i.name) : routine.foods.map(f => f.name);
  const amounts = hasItems
    ? routine.items!.map(i => (i.unit === 'piece' ? String(i.quantity) : `${i.quantity} ${i.unit}`))
    : routine.foods.map(f => f.quantity ?? '');
  // If we have structured items, recompute totals from them so routine and
  // plan stay in sync. Otherwise trust the snapshot or fall through.
  const totals = hasItems
    ? routine.items!.reduce(
        (acc, it) => ({
          calories: acc.calories + (it.calories ?? 0),
          protein:  acc.protein  + (it.protein  ?? 0),
          carbs:    acc.carbs    + (it.carbs    ?? 0),
          fat:      acc.fat      + (it.fat      ?? 0),
        }),
        { calories: 0, protein: 0, carbs: 0, fat: 0 },
      )
    : {
        calories: routine.calories ?? fallback?.calories ?? 0,
        protein:  routine.protein  ?? fallback?.protein  ?? 0,
        carbs:    routine.carbs    ?? fallback?.carbs    ?? 0,
        fat:      routine.fat      ?? fallback?.fat      ?? 0,
      };
  const micros: Record<string, number> = {};
  if (hasItems) {
    for (const it of routine.items!) {
      for (const [k, v] of Object.entries(it.micronutrients ?? {})) {
        if (typeof v === 'number') micros[k] = (micros[k] ?? 0) + v;
      }
    }
  }
  return {
    meal:     routine.name,
    items:    hasItems ? routine.items : undefined,
    foods,
    amounts,
    calories: totals.calories,
    protein:  totals.protein,
    carbs:    totals.carbs,
    fat:      totals.fat,
    isRoutine: true,
    estimated_alignment: fallback?.estimated_alignment ?? '',
    ...(routineBackendId(routine.backendId) != null ? { source_routine_id: routineBackendId(routine.backendId) } : {}),
    ...(Object.keys(micros).length > 0 ? { micronutrients: micros } : {}),
  } as MealSuggestion;
}

/** Apply routines to a plan.
 *
 *  Every routine becomes one entry in `plan.meals[]`, tagged with
 *  `_routineId`. Routine-backed entries are refreshed from the latest routine
 *  snapshot (so content edits propagate); stale routine ids get demoted to
 *  one-off entries so unpinning a routine doesn't make the meal vanish.
 *
 *  Pure function — returns a new plan object, doesn't mutate input. */
export function applyRoutines(
  plan: DailyNutritionPlan,
  routines: MealRoutineEntry[],
): DailyNutritionPlan {
  const incoming = migrateNutritionPlanShape(plan) as DailyNutritionPlan;
  const existingMeals = (incoming.meals ?? []).slice();

  const suppressedRoutineIds = suppressedRoutineIdSet(incoming);
  for (const routine of routines) {
    const backendAlias = routineBackendAlias(routine);
    const aliases = [routine.id, backendAlias].filter(Boolean) as string[];
    if (aliases.some(id => suppressedRoutineIds.has(id))) {
      for (const id of aliases) suppressedRoutineIds.add(id);
    }
  }
  const activeRoutines = activeMealRoutinesForPlan(
    { ...incoming, suppressedRoutineIds: Array.from(suppressedRoutineIds) },
    routines,
  );
  const routineOrderById = new Map(activeRoutines.map((r, i) => [r.id, routineDisplayOrder(r, i)]));
  // Re-discover untagged routine meals by NAME, not name+item-count. A
  // routine's id is the durable identity (case 1 below); this name index is
  // only for adopting an untagged meal that IS the routine but lost its tag
  // (fresh AI plan, un-persisted overlay). Name is stable across content
  // edits, whereas item count changes the moment a routine is edited — the
  // old name+count key stopped matching after an edit, so the stale copy
  // survived AND the routine re-prepended = the "editing a routine
  // duplicates it" bug. Item count now only disambiguates the rare case of
  // two active routines sharing a name.
  const normName = (s: string) => (s ?? '').toLowerCase().trim();
  const normKey = (value: unknown) => String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  const suppressedRoutineKeys = new Set(
    Array.from(suppressedRoutineIds).map(id => `routine_${normKey(id)}`),
  );
  const routinesByIdentity = new Map<string, MealRoutineEntry>();
  const routinesByClientKey = new Map<string, MealRoutineEntry>();
  for (const r of activeRoutines) {
    routinesByIdentity.set(r.id, r);
    const backendAlias = routineBackendAlias(r);
    if (backendAlias) routinesByIdentity.set(backendAlias, r);
    for (const id of [r.id, backendAlias]) {
      const key = `routine_${normKey(id)}`;
      if (key !== 'routine_') routinesByClientKey.set(key, r);
    }
  }
  const isSuppressedMeal = (meal: MealSuggestion, rid: string, mealClientKey: string): boolean => {
    if (rid && suppressedRoutineIds.has(rid)) return true;
    const backendAlias = mealRoutineBackendAlias(meal);
    if (backendAlias && suppressedRoutineIds.has(backendAlias)) return true;
    return !rid && !!mealClientKey && suppressedRoutineKeys.has(mealClientKey);
  };
  const routineForMeal = (meal: MealSuggestion, rid: string, mealClientKey: string): MealRoutineEntry | undefined => {
    if (rid && routinesByIdentity.has(rid)) return routinesByIdentity.get(rid);
    const backendAlias = mealRoutineBackendAlias(meal);
    if (backendAlias) return routinesByIdentity.get(backendAlias);
    if (mealClientKey) return routinesByClientKey.get(mealClientKey);
    return undefined;
  };
  const routineItemCount = (r: MealRoutineEntry): number =>
    (r.items?.length ?? r.foods?.length ?? 0);
  const activeRoutinesByName = new Map<string, MealRoutineEntry[]>();
  for (const r of activeRoutines) {
    const k = normName(r.name);
    const arr = activeRoutinesByName.get(k);
    if (arr) arr.push(r); else activeRoutinesByName.set(k, [r]);
  }

  // Walk current meals and UPDATE IN PLACE so array index positions are
  // preserved. Drop-and-reappend (the old behavior) shifted indices, which
  // broke check-state keyed by `meal_<idx>`.
  //
  // Rules (in-place):
  //   (1) routine-backed meal whose routine is still active → refresh from
  //       the latest routine snapshot (unless already logged), keep position.
  //   (2) routine-backed meal whose routine was removed → demote, keep pos.
  //   (3) untagged meal matching an active routine by NAME → adopt in place
  //       (add _routineId). Marks the routine "placed" so it isn't re-added.
  //   (4) any other meal → keep as-is.
  const placedRoutineIds = new Set<string>();
  const inplace: MealSuggestion[] = [];
  for (const m of existingMeals) {
    if (!m || typeof m !== 'object') continue;
    const rid = String((m as any)._routineId ?? '').trim();
    const mealClientKey = normKey((m as any)._clientMealKey ?? (m as any).client_meal_key);

    if (isSuppressedMeal(m, rid, mealClientKey)) {
      continue;
    }

    const matchedRoutine = routineForMeal(m, rid, mealClientKey);
    const hasRoutineIdentity = !!rid || !!mealRoutineBackendAlias(m) || mealClientKey.startsWith('routine_');
    if (hasRoutineIdentity && matchedRoutine) {
      // Once a routine meal has been LOGGED, its contents are authoritative —
      // it's what the user actually ate / edited. Do NOT overwrite them with
      // the routine template, or an edit gets reverted and can resurface as a
      // duplicate. Keep the meal as-is and mark the routine placed.
      if ((m as any)._loggedMealId != null) {
        const backendId = routineBackendId(matchedRoutine.backendId);
        inplace.push({
          ...m,
          _routineId: matchedRoutine.id,
          ...(backendId != null ? { source_routine_id: backendId } : {}),
        } as MealSuggestion);
        placedRoutineIds.add(matchedRoutine.id);
        continue;
      }
      // case (1): not yet logged — refresh from the live routine snapshot.
      const refreshed = mealFromRoutine(matchedRoutine);
      const tracking: Record<string, any> = {};
      if ((m as any)._clientMealKey != null) tracking._clientMealKey = (m as any)._clientMealKey;
      if ((m as any)._localId != null) tracking._localId = (m as any)._localId;
      if ((m as any).consumed_at != null) tracking.consumed_at = (m as any).consumed_at;
      inplace.push({ ...refreshed, _routineId: matchedRoutine.id, ...tracking } as MealSuggestion);
      placedRoutineIds.add(matchedRoutine.id);
      continue;
    }
    // No id / alias / client-key match yet. Try to adopt an active routine by
    // NAME *before* considering a demote. One rule covers two cases:
    //   • an untagged generated/overlay meal that IS a routine, and
    //   • a meal carrying a STALE routine id whose routine drifted to a new id
    //     this session. Without adopting here, that stale-id meal would demote
    //     below AND the unplaced routine would re-prepend = the "creating a
    //     routine duplicates the meal" bug that only an app restart cleared.
    const mealItemCount = (m.items?.length ?? m.foods?.length ?? 0);
    // Prefer the not-yet-placed same-named routine; if several share the name,
    // disambiguate by item count so two same-named routines stay distinct.
    const nameCandidates = (activeRoutinesByName.get(normName(m.meal)) ?? [])
      .filter(r => !placedRoutineIds.has(r.id));
    const matchingRoutine = nameCandidates.length <= 1
      ? nameCandidates[0]
      : (nameCandidates.find(r => routineItemCount(r) === mealItemCount) ?? nameCandidates[0]);
    if (matchingRoutine) {
      // Adopt in place, keeping position. A LOGGED meal stays authoritative
      // (what the user actually ate wins over the template) and only has its
      // identity normalized; an unlogged meal refreshes from the snapshot.
      const backendId = routineBackendId(matchingRoutine.backendId);
      if ((m as any)._loggedMealId != null) {
        inplace.push({
          ...m,
          _routineId: matchingRoutine.id,
          ...(backendId != null ? { source_routine_id: backendId } : {}),
        } as MealSuggestion);
      } else {
        const refreshed = mealFromRoutine(matchingRoutine);
        const tracking: Record<string, any> = {};
        if ((m as any)._clientMealKey != null) tracking._clientMealKey = (m as any)._clientMealKey;
        if ((m as any)._localId != null) tracking._localId = (m as any)._localId;
        if ((m as any).consumed_at != null) tracking.consumed_at = (m as any).consumed_at;
        inplace.push({ ...refreshed, _routineId: matchingRoutine.id, ...tracking } as MealSuggestion);
      }
      placedRoutineIds.add(matchingRoutine.id);
      continue;
    }

    if (hasRoutineIdentity) {
      // No active routine matches by id, alias, client-key, OR name — the
      // routine was genuinely removed. Demote to a one-off, keep position.
      const { _routineId: _drop, source_routine_id: _dropSourceRoutineId, ...rest } = m as any;
      inplace.push({ ...rest, isRoutine: false } as MealSuggestion);
      continue;
    }

    inplace.push({ ...m, isRoutine: false });
  }

  // Place any routines that weren't already in the plan ahead of generated
  // meals — routines are the user's repeat-eating template.
  const inserted: MealSuggestion[] = activeRoutines
    .filter(r => !placedRoutineIds.has(r.id))
    .map(r => ({ ...mealFromRoutine(r), _routineId: r.id }) as MealSuggestion);

  const meals = [...inserted, ...inplace];
  const routineSlots = meals
    .map((meal, index) => ({
      meal,
      index,
      routineId: String((meal as any)?._routineId ?? '').trim(),
    }))
    .filter(slot => slot.routineId && routineOrderById.has(slot.routineId));
  if (routineSlots.length > 1) {
    const orderedRoutineSlots = [...routineSlots].sort((a, b) => {
      const aOrder = routineOrderById.get(a.routineId) ?? Number.MAX_SAFE_INTEGER;
      const bOrder = routineOrderById.get(b.routineId) ?? Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.index - b.index;
    });
    routineSlots.forEach((slot, i) => {
      meals[slot.index] = orderedRoutineSlots[i].meal;
    });
  }

  // Invariant: collapse only the OPTIMISTIC/stale duplicates of a routine, not
  // legitimately-distinct logged rows. Optimistic ids minted when a routine is
  // created can drift from the backend-aligned ids already in a loaded/remote
  // plan; if both survive we'd render the meal twice (the duplicate that only
  // an app restart cleared). But two rows with DISTINCT `_loggedMealId` are
  // separate real logs (e.g. a routine occurrence plus a same-named meal the
  // user logged and that got name-adopted) and must both survive. Rule per
  // routine entry: keep every distinct logged row; keep at most one un-logged
  // row, and drop un-logged rows entirely once any logged row exists for that
  // routine (the un-logged copy is the stale/optimistic one).
  const resolveEntryId = (meal: MealSuggestion): string | null => {
    const rid = String((meal as any)._routineId ?? '').trim();
    if (rid && routinesByIdentity.has(rid)) return routinesByIdentity.get(rid)!.id;
    const alias = mealRoutineBackendAlias(meal);
    if (alias && routinesByIdentity.has(alias)) return routinesByIdentity.get(alias)!.id;
    return null;
  };
  const loggedEntryIds = new Set<string>();
  for (const meal of meals) {
    const entryId = resolveEntryId(meal);
    if (entryId != null && (meal as any)._loggedMealId != null) loggedEntryIds.add(entryId);
  }
  const dedupedMeals: MealSuggestion[] = [];
  const seenLoggedIdsByEntry = new Map<string, Set<string>>();
  const keptUnloggedEntries = new Set<string>();
  for (const meal of meals) {
    const entryId = resolveEntryId(meal);
    if (entryId == null) {
      dedupedMeals.push(meal);
      continue;
    }
    const loggedId = (meal as any)._loggedMealId;
    if (loggedId != null) {
      const seen = seenLoggedIdsByEntry.get(entryId) ?? new Set<string>();
      if (seen.has(String(loggedId))) continue; // exact same log already kept
      seen.add(String(loggedId));
      seenLoggedIdsByEntry.set(entryId, seen);
      dedupedMeals.push(meal);
      continue;
    }
    // Un-logged row: drop it if this routine already has a logged row, or if we
    // already kept one un-logged row for it.
    if (loggedEntryIds.has(entryId) || keptUnloggedEntries.has(entryId)) continue;
    keptUnloggedEntries.add(entryId);
    dedupedMeals.push(meal);
  }

  return ensureMealClientKeys({
    ...incoming,
    meals: dedupedMeals,
  });
}

/** Apply routines to a whole map of plans. Returns a new map. */
export function applyRoutinesToAll(
  plansByDate: Record<string, DailyNutritionPlan>,
  routines: MealRoutineEntry[],
): Record<string, DailyNutritionPlan> {
  const out: Record<string, DailyNutritionPlan> = {};
  for (const [k, p] of Object.entries(plansByDate)) {
    out[k] = applyRoutines(p, routines);
  }
  return out;
}

/** Align FUTURE days' routine state with `todayKey`'s. Future plans inherit
 *  today's `suppressedRoutineIds` (overwriting any future-only overlay) and
 *  are then re-passed through applyRoutines so their meals[] reflect the
 *  current active routine set. Past plans are left alone. Pure. */
export function realignFutureRoutinesWithToday(
  plansByDate: Record<string, DailyNutritionPlan>,
  todayKey: string,
  routines: MealRoutineEntry[],
): Record<string, DailyNutritionPlan> {
  if (!todayKey) return plansByDate;
  const todayPlan = plansByDate[todayKey];
  const todaySuppressed = (todayPlan?.suppressedRoutineIds ?? [])
    .map(s => String(s ?? '').trim())
    .filter(Boolean);
  const out: Record<string, DailyNutritionPlan> = { ...plansByDate };
  for (const [date, plan] of Object.entries(plansByDate)) {
    if (!plan || date <= todayKey) continue;
    const intermediate = { ...plan, suppressedRoutineIds: [...todaySuppressed] };
    out[date] = applyRoutines(intermediate, routines);
  }
  return out;
}

/** Same as `applyRoutines` but also returns how many routine rows were
 *  prepended to the front of `meals[]`, so callers can re-key `meal_<idx>`
 *  state. Pure function. */
export function applyRoutinesWithShift(
  plan: DailyNutritionPlan,
  routines: MealRoutineEntry[],
): { plan: DailyNutritionPlan; prependedCount: number } {
  const before = (plan.meals ?? []).length;
  const next = applyRoutines(plan, routines);
  const after = (next.meals ?? []).length;
  // The only path that adds rows is the prepend at the front, so the delta is
  // the prepended count. Negative is impossible — clamp defensively.
  const prependedCount = Math.max(0, after - before);
  return { plan: next, prependedCount };
}

/** Apply routines across a whole plan map AND shift the per-day check map by
 *  the prepended-routine count for each day. Returns both new maps. */
export function applyRoutinesToAllWithChecks(
  plansByDate: Record<string, DailyNutritionPlan>,
  checksByDate: Record<string, Record<string, boolean>>,
  routines: MealRoutineEntry[],
): {
  plansByDate: Record<string, DailyNutritionPlan>;
  checksByDate: Record<string, Record<string, boolean>>;
} {
  const outPlans: Record<string, DailyNutritionPlan> = {};
  const outChecks: Record<string, Record<string, boolean>> = { ...checksByDate };
  for (const [k, p] of Object.entries(plansByDate)) {
    const keyedPlan = ensureMealClientKeys(p);
    const normalizedBefore = normalizeMealChecksForPlan(keyedPlan, checksByDate[k] ?? {});
    const { plan: nextPlan } = applyRoutinesWithShift(keyedPlan, routines);
    outPlans[k] = nextPlan;
    if (checksByDate[k]) {
      outChecks[k] = normalizeMealChecksForPlan(nextPlan, normalizedBefore);
    }
  }
  return { plansByDate: outPlans, checksByDate: outChecks };
}
