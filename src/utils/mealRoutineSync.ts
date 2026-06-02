/**
 * Backend persistence for meal routines. Routines used to live only in the
 * device-local `mealRoutines` store (lost on reinstall, no cross-device sync,
 * client-string ids). They are now first-class server rows (table
 * `meal_routines`); this module bridges the session-local working copy to the
 * backend:
 *
 *   - syncMealRoutinesFromBackend: pull server rows into memory (durability
 *     + cross-device); DB-backed rows win, local-only rows remain drafts.
 *   - reconcileRoutinesToBackend: push the local set to the server (create /
 *     update) and stamp each entry's `backendId`.
 *   - archiveMealRoutineInBackend: explicit delete/archive for a known user
 *     action. Reconcile intentionally does not treat an empty local cache as
 *     an instruction to delete server rows.
 *
 * The device-side string `id` (used for
 * `_routineId` matching) is left untouched; `backendId` is the durable link.
 */
import type { MealItem, MealRoutineEntry, MealRoutineFood } from '../types';
import * as api from '../services/api';
import { loadMealRoutines, saveMealRoutines } from './workoutHistory';
import { inferBackendIdFromRoutineEntry } from './mealRoutineSyncCore';

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().trim();

function itemsFromBackend(items: api.MealRoutineItem[]): MealItem[] {
  return (items ?? []).map(it => ({
    name: it.food_name,
    food_id: it.food_id ?? null,
    serving_grams: it.serving_grams ?? null,
    quantity: it.quantity,
    unit: it.unit as any,
    calories: it.calories,
    protein: it.protein_g,
    carbs: it.carbs_g,
    fat: it.fat_g,
  })) as MealItem[];
}

function itemsToBackend(entry: MealRoutineEntry): api.MealRoutineItem[] {
  const items = entry.items ?? [];
  if (items.length > 0) {
    return items.map(it => ({
      food_name: it.name,
      food_id: (it as any).food_id ?? null,
      serving_grams: (it as any).serving_grams ?? null,
      quantity: Number((it as any).quantity ?? 1),
      unit: String((it as any).unit ?? 'serving'),
      calories: Number((it as any).calories ?? 0),
      protein_g: Number((it as any).protein ?? 0),
      carbs_g: Number((it as any).carbs ?? 0),
      fat_g: Number((it as any).fat ?? 0),
    }));
  }
  // Legacy foods-only routine: no per-item macros to snapshot.
  return (entry.foods ?? []).map((f: MealRoutineFood) => ({
    food_name: f.name,
    food_id: null,
    quantity: 1,
    unit: 'serving',
    calories: 0,
    protein_g: 0,
    carbs_g: 0,
    fat_g: 0,
  }));
}

function backendToEntry(r: api.MealRoutine): MealRoutineEntry {
  const items = itemsFromBackend(r.items);
  return {
    id: `routine_backend_${r.id}`,
    backendId: r.id,
    displayOrder: r.display_order ?? 0,
    name: r.name,
    mealType: r.meal_type ?? 'custom',
    foods: items.map((it, i) => ({
      id: `${r.id}_${i}`,
      name: it.name,
      quantity: (it as any).unit === 'piece' ? String((it as any).quantity) : `${(it as any).quantity} ${(it as any).unit}`,
    })),
    items: items.length > 0 ? items : undefined,
    createdAt: r.created_at,
    calories: r.total_calories,
    protein: r.total_protein_g,
    carbs: r.total_carbs_g,
    fat: r.total_fat_g,
  };
}

export function stampMealRoutineDisplayOrder(routines: MealRoutineEntry[]): MealRoutineEntry[] {
  return routines.map((routine, index) => ({ ...routine, displayOrder: index }));
}

function sortMealRoutinesForDisplay(routines: MealRoutineEntry[]): MealRoutineEntry[] {
  return [...routines].sort((a, b) => {
    const aOrder = Number.isFinite(Number(a.displayOrder)) ? Number(a.displayOrder) : Number.MAX_SAFE_INTEGER;
    const bOrder = Number.isFinite(Number(b.displayOrder)) ? Number(b.displayOrder) : Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;
    const aCreated = Date.parse(a.createdAt ?? '') || 0;
    const bCreated = Date.parse(b.createdAt ?? '') || 0;
    if (aCreated !== bCreated) return aCreated - bCreated;
    return String(a.id).localeCompare(String(b.id));
  });
}

function entryToInput(entry: MealRoutineEntry, fallbackOrder = 0): api.MealRoutineInput {
  const items = itemsToBackend(entry);
  const mt = entry.mealType && entry.mealType !== 'custom' ? entry.mealType : undefined;
  const displayOrder = Number.isFinite(Number(entry.displayOrder)) ? Number(entry.displayOrder) : fallbackOrder;
  // Default to all 7 days when the client doesn't supply a schedule.
  // The current "make routine" surface has no day-of-week picker — users
  // expect the routine to recur daily. Sending [] would persist as
  // "never auto-scheduled" on the backend and the routine would be
  // invisible to fresh-install / multi-device flows where the local
  // AsyncStorage cache hasn't hydrated yet.
  const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6];
  return {
    name: entry.name,
    meal_type: mt,
    display_order: displayOrder,
    items,
    days_of_week: ALL_WEEK,
    // Stable client key so a retried / double-submitted create dedupes on the
    // backend instead of inserting a duplicate routine. entry.id is the local
    // UUID and is preserved across reconciles.
    ...(entry.id ? { idempotency_key: `routine:${entry.id}` } : {}),
  };
}

/** Pull server routines into the session-local working copy. Local entries are matched to
 *  server rows by `backendId` then by name; matched entries keep the local
 *  string id for `_routineId` UI matching, but their saved content comes from
 *  the server. Local-only entries remain optimistic drafts until reconcile
 *  creates a backend row. Server-only routines (created on another device)
 *  are added. Returns the merged list. */
export async function syncMealRoutinesFromBackend(token: string): Promise<MealRoutineEntry[]> {
  const serverRows = await api.listMealRoutines(token);
  const local = await loadMealRoutines();
  const usedServerIds = new Set<number>();
  const merged: MealRoutineEntry[] = local.map(entry => {
    const entryBackendId = inferBackendIdFromRoutineEntry(entry);
    const match = serverRows.find(r =>
      (entryBackendId != null && r.id === entryBackendId) ||
      (entryBackendId == null && norm(r.name) === norm(entry.name) && !usedServerIds.has(r.id)),
    );
    if (match) {
      usedServerIds.add(match.id);
      return { ...backendToEntry(match), id: entry.id };
    }
    return entry;
  });
  for (const r of serverRows) {
    if (!usedServerIds.has(r.id)) merged.push(backendToEntry(r));
  }
  const ordered = sortMealRoutinesForDisplay(merged);
  await saveMealRoutines(ordered);
  return ordered;
}

// Serialize reconciles. Two reconciles that both ran before the first's
// create landed would each fail to match by name and double-create. Chaining
// them means the second always sees the first's writes.
let reconcileChain: Promise<unknown> = Promise.resolve();

/** Push the local routine set to the backend: create rows that don't exist
 *  yet (matched by backendId, else name, to avoid duplicate-create on repeated
 *  reconciles) and update changed ones. Stamps `backendId` onto created
 *  entries and refreshes memory. Serialized so concurrent calls can't race
 *  into duplicate-create.
 *
 *  Important reinstall guard: this does NOT archive unmatched server rows.
 *  A fresh install starts with an empty local routine cache; treating that
 *  cache as an authoritative delete list is exactly how account-owned
 *  routines get wiped. Deletions go through archiveMealRoutineInBackend.
 */
export function reconcileRoutinesToBackend(
  token: string,
  next: MealRoutineEntry[],
): Promise<MealRoutineEntry[]> {
  const run = reconcileChain.then(
    () => _reconcileRoutinesToBackend(token, next),
    () => _reconcileRoutinesToBackend(token, next),
  );
  reconcileChain = run.catch(() => {});
  return run;
}

async function _reconcileRoutinesToBackend(
  token: string,
  next: MealRoutineEntry[],
): Promise<MealRoutineEntry[]> {
  let serverRows: api.MealRoutine[];
  try {
    serverRows = await api.listMealRoutines(token);
  } catch {
    return next; // offline -> session copy already holds the change; retry on next sync
  }
  const byId = new Map(serverRows.map(r => [r.id, r]));
  const matchedServerIds = new Set<number>();
  const out: MealRoutineEntry[] = [];
  const mutationErrors: string[] = [];

  const orderedNext = stampMealRoutineDisplayOrder(next);

  for (const [index, entry] of orderedNext.entries()) {
    try {
      const entryBackendId = inferBackendIdFromRoutineEntry(entry);
      let serverId = entryBackendId != null && byId.has(entryBackendId) ? entryBackendId : null;
      if (serverId == null) {
        const byName = serverRows.find(r => norm(r.name) === norm(entry.name) && !matchedServerIds.has(r.id));
        if (byName) serverId = byName.id;
      }
      if (serverId != null) {
        matchedServerIds.add(serverId);
        await api.updateMealRoutineApi(token, serverId, entryToInput(entry, index));
        out.push({ ...entry, backendId: serverId, displayOrder: index });
      } else {
        const created = await api.createMealRoutineApi(token, entryToInput(entry, index));
        matchedServerIds.add(created.id);
        out.push({ ...entry, backendId: created.id, displayOrder: index });
      }
    } catch (err: any) {
      out.push(entry); // keep the local entry; next sync retries
      mutationErrors.push(err?.message ?? 'Routine sync failed');
    }
  }

  const orderedOut = stampMealRoutineDisplayOrder(out);
  await saveMealRoutines(orderedOut);
  if (mutationErrors.length > 0) {
    throw new Error(mutationErrors[0]);
  }
  return orderedOut;
}

/** Archive a routine only in response to an explicit user delete/unpin. */
export async function archiveMealRoutineInBackend(
  token: string,
  entry: MealRoutineEntry,
): Promise<boolean> {
  let serverId = inferBackendIdFromRoutineEntry(entry);
  if (serverId == null) {
    const rows = await api.listMealRoutines(token);
    const match = rows.find(r => norm(r.name) === norm(entry.name));
    serverId = match?.id ?? null;
  }
  if (serverId == null) return false;
  await api.deleteMealRoutineApi(token, serverId);
  return true;
}
