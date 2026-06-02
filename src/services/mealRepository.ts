/**
 * mealRepository — the single, centralized mutation layer for everything
 * meal-related. Favorites and routines are TEMPLATES; daily meal logs are
 * independent dated INSTANCES. Every create/update/delete goes through one
 * of the functions here so callers can never accidentally:
 *   - call create when they meant update (ids are explicit + required),
 *   - mutate a favorite/routine while editing a logged meal (separate fns),
 *   - pass a favorite id into a log mutation (branded id types below),
 *   - double-create on retries (idempotency keys are generated here).
 *
 * The database is the source of truth. These functions return the server's
 * response; callers reconcile their optimistic cache from it. Nothing here
 * writes AsyncStorage — caching/optimism lives in the caller's mutation
 * wrapper, never inside the repository.
 *
 * Contract summary (maps to the product spec A–H):
 *   A logMealFromFavorite — one log, snapshot favorite, never touches favorite
 *   B updateFavoriteMeal  — favorite only, zero logs
 *   D logMealFromRoutine  — one log per occurrence, idempotent
 *   E updateMealRoutine   — routine only, never rewrites logs
 *   F updateRoutineOccurrenceForOneDay — that date only
 *   G updateDailyMealLog  — that log row only, never the template
 *   H delete*             — instance vs template are separate calls
 */
import * as api from './api';
import type {
  SavedMeal,
  SavedMealItem,
  MealRoutine,
  MealRoutineItem,
  MealRoutineInput,
} from './api';
import {
  type FavoriteId,
  type RoutineId,
  type LogId,
  newIdempotencyKey,
} from './mealMutationKeys';

// Re-export the pure identity/key helpers so `mealRepository` stays the single
// public surface for the mutation layer.
export {
  type FavoriteId,
  type RoutineId,
  type LogId,
  asFavoriteId,
  asRoutineId,
  asLogId,
  newIdempotencyKey,
  routineOccurrenceKey,
  planLogIdempotencyKey,
  addSavedMutationKey,
} from './mealMutationKeys';

// ─── Favorites (templates) ──────────────────────────────────────────────────

export type FavoriteInput = {
  name: string;
  notes?: string | null;
  items: SavedMealItem[];
  image_url?: string | null;
  image_source?: string | null;
  /** Omit → generated. Pass the same token through a retry so the
   *  server's (user_id, idempotency_key) partial unique index collapses
   *  duplicate saves to one row. */
  idempotencyKey?: string;
};

/** Create a new favorite template. Does NOT log a meal. */
export async function createFavoriteMeal(token: string, input: FavoriteInput): Promise<SavedMeal> {
  const { idempotencyKey, ...rest } = input;
  return api.createSavedMeal(token, {
    ...rest,
    idempotency_key: idempotencyKey ?? newIdempotencyKey('fav'),
  });
}

/** Edit a favorite template in place (rule B). Updates only the favorite;
 *  historical logs keep their snapshots; creates zero logs. */
export async function updateFavoriteMeal(
  token: string,
  id: FavoriteId,
  patch: { name?: string; notes?: string | null; items?: SavedMealItem[]; image_url?: string | null; image_source?: string | null },
): Promise<SavedMeal> {
  return api.updateSavedMeal(token, id, patch);
}

/** Delete/archive a favorite template (rule H). Logged meals it produced are
 *  unlinked server-side, not deleted. */
export async function deleteFavoriteMeal(token: string, id: FavoriteId): Promise<void> {
  return api.deleteSavedMeal(token, id);
}

// ─── Routines (templates) ───────────────────────────────────────────────────

/** Create a new recurring routine template. Does NOT log a meal. */
export async function createMealRoutine(token: string, input: MealRoutineInput): Promise<MealRoutine> {
  return api.createMealRoutineApi(token, input);
}

/** Edit a routine template / its schedule in place (rule E). Never duplicates
 *  the routine; never rewrites already-logged meals. */
export async function updateMealRoutine(
  token: string,
  id: RoutineId,
  patch: Partial<MealRoutineInput>,
): Promise<MealRoutine> {
  return api.updateMealRoutineApi(token, id, patch);
}

/** Archive a routine (rule H). Historical logs are kept. */
export async function deleteMealRoutine(token: string, id: RoutineId): Promise<{ archived: number }> {
  return api.deleteMealRoutineApi(token, id);
}

// ─── Daily meal logs (instances) ────────────────────────────────────────────

export type ManualLogInput = {
  date: string;             // YYYY-MM-DD
  mealType: string;         // slot or coarse type
  meal: Record<string, any>;
  consumedAt?: string;      // ISO
  idempotencyKey?: string;  // omit → generated
};

/** Log a one-off manual meal (source_type "manual"). Returns the new log id. */
export async function logMealManually(token: string, input: ManualLogInput): Promise<{ id: number }> {
  return api.logMealChecked(token, {
    meal_date: input.date,
    meal_type: input.mealType,
    meal: input.meal,
    source: 'manual_add',
    consumed_at: input.consumedAt,
    idempotency_key: input.idempotencyKey ?? newIdempotencyKey('manual'),
  });
}

/** Log a meal FROM a favorite (rule A): creates one log that snapshots the
 *  favorite's current items; never modifies the favorite; idempotent. */
export async function logMealFromFavorite(
  token: string,
  favoriteId: FavoriteId,
  opts: { date?: string; mealType?: string; consumedAt?: string; idempotencyKey?: string } = {},
): Promise<{ meal_id: number; saved_meal_id: number; times_logged: number }> {
  return api.logSavedMeal(token, favoriteId, {
    meal_date: opts.date,
    meal_type: opts.mealType,
    consumed_at: opts.consumedAt,
    idempotency_key: opts.idempotencyKey ?? newIdempotencyKey('fav'),
  });
}

/** Log a routine OCCURRENCE (rule D): creates exactly one log for that
 *  (routine, date) occurrence; logging the same occurrence twice de-dupes. */
export async function logMealFromRoutine(
  token: string,
  routineId: RoutineId,
  opts: { occurrenceDate?: string; occurrenceKey?: string; mealType?: string; consumedAt?: string; idempotencyKey?: string } = {},
): Promise<{ meal_id: number; source_routine_id: number; routine_occurrence_key: string; deduped: boolean }> {
  return api.logMealRoutineOccurrence(token, routineId, {
    occurrence_date: opts.occurrenceDate,
    occurrence_key: opts.occurrenceKey,
    meal_type: opts.mealType,
    consumed_at: opts.consumedAt,
    idempotency_key: opts.idempotencyKey ?? newIdempotencyKey('routine'),
  });
}

/** Edit a single daily log row (rule G). Updates only that log + its items;
 *  never the favorite/routine it came from. Provenance ids are preserved
 *  server-side except where a name/items change explicitly detaches them. */
export async function updateDailyMealLog(
  token: string,
  logId: LogId,
  patch: { meal_type?: string; consumed_at?: string | null; notes?: string | null; name?: string; items?: any[] },
): Promise<any> {
  return api.updateMeal(token, logId, patch);
}

/** Delete a single daily log instance (rule H). Templates are untouched. */
export async function deleteDailyMealLog(token: string, logId: LogId): Promise<void> {
  return api.deleteLoggedMeal(token, logId);
}

/** Edit ONE day of a routine (rule F). If logged, updates that day's Meal;
 *  otherwise writes a one-day exception. Never edits the base routine. */
export async function updateRoutineOccurrenceForOneDay(
  token: string,
  routineId: RoutineId,
  occurrenceDate: string,
  patch: { occurrenceKey?: string; name?: string; items?: MealRoutineItem[]; overrideTime?: string; skipped?: boolean },
): Promise<Record<string, any>> {
  return api.updateMealRoutineOccurrence(token, routineId, {
    occurrence_date: occurrenceDate,
    occurrence_key: patch.occurrenceKey,
    name: patch.name,
    items: patch.items,
    override_time: patch.overrideTime,
    skipped: patch.skipped,
  });
}
