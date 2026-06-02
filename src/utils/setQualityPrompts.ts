export function parseTargetRepMax(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw);
  const m = s.match(/(\d+)\s*[-\u2013\u2014]\s*(\d+)/);
  if (m) return parseInt(m[2], 10);
  const n = s.match(/(\d+)/);
  return n ? parseInt(n[1], 10) : null;
}

export function parseTargetRepMin(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw);
  const m = s.match(/(\d+)\s*[-\u2013\u2014]\s*(\d+)/);
  if (m) return parseInt(m[1], 10);
  const n = s.match(/(\d+)/);
  return n ? parseInt(n[1], 10) : null;
}

export function shouldPromptRir(actualReps: number, targetReps: string | number | null | undefined): boolean {
  const targetMax = parseTargetRepMax(targetReps);
  return actualReps > 0 && targetMax != null && actualReps >= targetMax;
}

export function shouldPromptUnderperformance(actualReps: number, targetReps: string | number | null | undefined): boolean {
  const targetMin = parseTargetRepMin(targetReps);
  return targetMin != null && actualReps <= Math.max(1, targetMin - 2);
}
