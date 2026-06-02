function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function readinessSleepHoursFromSummary(summary: any | null | undefined): number | null {
  const raw = summary?.raw ?? summary ?? null;
  const sleepMinutes = finiteNumber(summary?.sleepMinutes);
  if (sleepMinutes != null && sleepMinutes > 0) return sleepMinutes / 60;
  return finiteNumber(raw?.lastNightSleepHours)
    ?? finiteNumber(raw?.sleepScore?.duration)
    ?? finiteNumber(summary?.lastNightSleepHours)
    ?? finiteNumber(summary?.sleepScore?.duration);
}

export function readinessSleepScoreFromSummary(summary: any | null | undefined): number | null {
  const raw = summary?.raw ?? summary ?? null;
  return finiteNumber(raw?.sleepScore?.score)
    ?? finiteNumber(summary?.sleepScore?.score);
}

export function readinessHrvMsFromSummary(summary: any | null | undefined): number | null {
  const raw = summary?.raw ?? summary ?? null;
  return finiteNumber(raw?.sleepScore?.hrvAvg)
    ?? finiteNumber(summary?.sleepScore?.hrvAvg)
    ?? finiteNumber(summary?.hrv)
    ?? finiteNumber(raw?.hrvAvg)
    ?? finiteNumber(summary?.hrvAvg);
}
