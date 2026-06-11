/**
 * Pure identity + idempotency helpers for the meal mutation layer. Kept in a
 * standalone, dependency-free module so they can be unit-tested in node and
 * imported anywhere without dragging the whole API client. `mealRepository`
 * re-exports these as its public surface.
 */

// ─── Branded ids ──────────────────────────────────────────────────────────────
// Distinct compile-time types over `number` so a FavoriteId can never be passed
// where a RoutineId / LogId is expected — the "entity bleed" class of bug.
declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type FavoriteId = Brand<number, 'FavoriteId'>;
export type RoutineId = Brand<number, 'RoutineId'>;
export type LogId = Brand<number, 'LogId'>;

export const asFavoriteId = (n: number): FavoriteId => n as FavoriteId;
export const asRoutineId = (n: number): RoutineId => n as RoutineId;
export const asLogId = (n: number): LogId => n as LogId;

// ─── Idempotency / occurrence keys ─────────────────────────────────────────────

/** A fresh client idempotency token for a create/log op. Pass the SAME token
 *  through a retry / optimistic replay so the server collapses it to one row. */
export function newIdempotencyKey(prefix = 'mlog'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Stable occurrence key for a routine on a given date. Deterministic so an
 *  optimistic log and the server agree, and so it never drifts with timezone
 *  formatting (occurrenceDate is already a YYYY-MM-DD string). */
export function routineOccurrenceKey(routineId: number, occurrenceDate: string, timeLabel?: string): string {
  return `routine:${routineId}:${occurrenceDate}:${timeLabel ?? ''}`;
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForStableJson);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = normalizeForStableJson(v);
  }
  return out;
}

export function stableJsonHash(value: unknown): string {
  const input = JSON.stringify(normalizeForStableJson(value));
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function watchSpeechIdempotencyKey(
  date: string,
  payload: Record<string, any> | null | undefined,
  items: unknown[],
): string {
  const commandId = String(payload?.commandId ?? '').trim();
  if (commandId) return `watch_speech:${date}:cmd:${commandId}`;
  const tsMs = Number(payload?.tsMs ?? 0);
  if (Number.isFinite(tsMs) && tsMs > 0) return `watch_speech:${date}:ts:${Math.floor(tsMs)}`;
  return `watch_speech:${date}:hash:${stableJsonHash({
    text: payload?.text ?? payload?.rawText ?? null,
    items,
  })}`;
}

export function savedMealLogIdempotencyKey(
  savedMealId: number,
  date: string,
  mealType: string,
  consumedAt: string,
): string {
  return `fav:${savedMealId}:${date}:${mealType}:${consumedAt}`;
}

/** Stable idempotency key for a plan/manual check-off, keyed on the logical
 *  meal identity (NOT a timestamp) so a double-tap or an edit-before-the-log
 *  -returns both produce the same key and collapse to one row. */
export function planLogIdempotencyKey(
  date: string,
  mealType: string,
  meal: { _clientMealKey?: string; client_meal_key?: string; _localId?: string; meal?: string; name?: string; calories?: number } | null | undefined,
): string {
  const clientKey = meal?._clientMealKey || meal?.client_meal_key;
  const localId = meal?._localId;
  const identity = clientKey
    ? clientKey
    : localId
      ? localId
    : `${meal?.meal || meal?.name || ''}:${Math.round(Number(meal?.calories) || 0)}`;
  return `plan:${date}:${mealType}:${identity}`;
}

/** Stable in-flight lock key for the "Add Favorite to Day" flow. Two
 *  taps on the same favorite on the same date must collapse to one
 *  add; two taps on the SAME favorite on DIFFERENT dates must NOT
 *  collapse (they're separate intents).
 *
 *  We prefer the SavedMeal's real `id`. Optimistic favorites — created
 *  client-side before the backend round-trip resolves — surface only as
 *  `_optimisticId`, so we accept that as a fallback. A name+rounded-
 *  calories tuple is the last resort for the rare case a saved meal
 *  has neither id form populated. */
export function addSavedMutationKey(
  date: string,
  saved: {
    id?: number | null;
    _optimisticId?: number | string;
    name?: string | null;
    total_calories?: number | null;
    items?: unknown[] | null;
  } | null | undefined,
): string {
  const id = saved?.id ?? saved?._optimisticId;
  if (id != null && id !== '') return `addSaved:${date}:${id}`;
  const name = (saved?.name ?? '').toLowerCase().trim();
  const cals = Math.round(Number(saved?.total_calories ?? 0) || 0);
  const itemHash = Array.isArray(saved?.items) && saved.items.length > 0
    ? stableJsonHash(saved.items.map(item => stableJsonHash(item)).sort())
    : 'no_items';
  return `addSaved:${date}:sig:${name}|${cals}|${itemHash}`;
}
