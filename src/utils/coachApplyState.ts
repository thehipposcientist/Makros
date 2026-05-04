const DAY_STATUS_REFRESH_FIELDS = new Set([
  'skipped_focus',
  'skip_reason',
  'macro_overrides',
  'paused_dates',
  'cleared_dates',
]);

export function coachApplyNeedsDayStatusRefresh(
  fields: Record<string, unknown> | null | undefined,
): boolean {
  if (!fields || typeof fields !== 'object') return false;
  return Object.keys(fields).some(key => DAY_STATUS_REFRESH_FIELDS.has(key));
}

export function isRecoverySkipReason(reason: string | null | undefined): boolean {
  const text = String(reason ?? '').trim().toLowerCase();
  if (!text) return false;
  return text.includes('coach swapped to recovery')
    || text.includes('recovery guidance')
    || text.includes('active recovery');
}

export function skippedDayTitle(
  focus: string | null | undefined,
  reason: string | null | undefined,
): string {
  return isRecoverySkipReason(reason) ? 'Recovery Day' : (focus || 'Workout');
}

export function skippedDayBadgeLabel(reason: string | null | undefined): string {
  return isRecoverySkipReason(reason) ? 'Recovery' : 'Skipped';
}

export function skippedDayUndoLabel(reason: string | null | undefined): string {
  return isRecoverySkipReason(reason) ? 'Undo recovery' : 'Unskip Workout';
}
