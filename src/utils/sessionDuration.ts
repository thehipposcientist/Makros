export function sessionDurationRange(sessionMinutes?: number | null): { min: number | null; max: number | null } {
  const max = Number(sessionMinutes);
  if (!Number.isFinite(max) || max <= 0) return { min: null, max: null };
  return {
    min: Math.max(1, Math.round(max - 15)),
    max: Math.round(max),
  };
}

export function clampDisplayedSessionMinutes(rawMinutes: number, sessionMinutes?: number | null): number {
  const raw = Math.max(1, Math.round(Number(rawMinutes) || 1));
  const range = sessionDurationRange(sessionMinutes);
  if (range.min == null || range.max == null) return raw;
  return Math.min(Math.max(raw, range.min), range.max);
}
