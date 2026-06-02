import type { MealRoutineEntry } from '../types';

export function inferBackendIdFromRoutineEntry(entry: Pick<MealRoutineEntry, 'id' | 'backendId'>): number | null {
  if (entry.backendId != null && Number.isFinite(Number(entry.backendId))) {
    const id = Number(entry.backendId);
    return id > 0 ? id : null;
  }
  const match = /^routine_backend_(\d+)$/.exec(String(entry.id ?? '').trim());
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
