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
import type { MealRoutineEntry } from '../types';
import * as api from '../services/api';
import { loadMealRoutines, saveMealRoutines } from './workoutHistory';
import {
  inferBackendIdFromRoutineEntry,
  mealRoutineEntryFromBackend,
  mealRoutineInputFromEntry,
} from './mealRoutineSyncCore';

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().trim();

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
      return { ...mealRoutineEntryFromBackend(match), id: entry.id };
    }
    return entry;
  });
  for (const r of serverRows) {
    if (!usedServerIds.has(r.id)) merged.push(mealRoutineEntryFromBackend(r));
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
        await api.updateMealRoutineApi(token, serverId, mealRoutineInputFromEntry(entry, index));
        out.push({ ...entry, backendId: serverId, displayOrder: index });
      } else {
        const created = await api.createMealRoutineApi(token, mealRoutineInputFromEntry(entry, index));
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
