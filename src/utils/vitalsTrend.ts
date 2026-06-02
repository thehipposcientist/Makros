/**
 * Apple Health metric trend classifiers.
 *
 * Used by the Apple Health vitals card on the Progress screen to attach
 * a small "how is this doing" indicator to each metric. The framing
 * follows the same rule as the rest of the wellness aggregate work:
 *
 *   • Prefer a *personal trend* (current vs your own baseline) over a
 *     population threshold. A "good" RHR for a 25-year-old runner and
 *     for a 60-year-old desk worker are very different numbers.
 *   • When no personal baseline exists, fall back to a *soft reference*
 *     using widely accepted bands (e.g. 7–9h sleep). Frame as "in the
 *     typical range" — never "good / poor".
 *   • Return `null` rather than guessing when there's not enough data.
 *
 * Pure functions, no React imports — testable in isolation. The Progress
 * screen passes baselines from sleepHistory (already computed for the
 * Thallo Score recovery pillar).
 */

/** Three-state outcome consumed by the UI:
 *   • `improving`  — semantic "moving in the healthy direction" (green).
 *   • `monitor`    — drift worth flagging (amber). Not a clinical alarm.
 *   • `onTrack`    — within typical range (subtle / neutral).
 *   • `null`       — not enough data to say anything honestly. */
export type VitalTrend = 'improving' | 'onTrack' | 'monitor' | null;

export interface VitalTrendResult {
  trend: VitalTrend;
  /** 1–3 word label suitable for a chip next to the value. Empty string
   *  when `trend` is null — UI hides the chip entirely. */
  label: string;
}

const NULL_RESULT: VitalTrendResult = { trend: null, label: '' };

/** Resting heart rate. Lower than your 30d baseline reads as
 *  "improving" (recovery / fitness signal). Higher reads as "monitor".
 *  Without a baseline we punt — RHR norms span 50–90 across age + fitness
 *  so a population threshold would mislead more than it informs. */
export function classifyRestingHeartRate(
  current: number | null | undefined,
  baseline30d: number | null | undefined,
): VitalTrendResult {
  if (current == null || !Number.isFinite(current) || current <= 0) return NULL_RESULT;
  if (baseline30d == null || !Number.isFinite(baseline30d) || baseline30d <= 0) {
    return NULL_RESULT;
  }
  const delta = current - baseline30d;
  // ±2 bpm is the typical day-to-day noise floor for resting HR — bands
  // open at ±3 so "improving" / "monitor" reflect a real signal, not a
  // single noisy sample. Above-baseline drift is folded into one band
  // (we don't grade severity in the chip; the recovery pillar already
  // does that with finer granularity in healthScore.ts).
  if (delta <= -3) return { trend: 'improving', label: 'below baseline' };
  if (delta < 3) return { trend: 'onTrack', label: 'on track' };
  return { trend: 'monitor', label: `+${Math.round(delta)} vs baseline` };
}

/** HRV — higher than baseline is good. Personal baseline only; absolute
 *  HRV varies wildly across individuals and devices, so a population
 *  threshold would be misleading. */
export function classifyHrv(
  current: number | null | undefined,
  baseline30d: number | null | undefined,
): VitalTrendResult {
  if (current == null || !Number.isFinite(current) || current <= 0) return NULL_RESULT;
  if (baseline30d == null || !Number.isFinite(baseline30d) || baseline30d <= 0) {
    return NULL_RESULT;
  }
  const ratio = current / baseline30d;
  if (ratio >= 1.10) return { trend: 'improving', label: 'above baseline' };
  if (ratio >= 0.92) return { trend: 'onTrack', label: 'on track' };
  return { trend: 'monitor', label: 'below baseline' };
}

/** 7-day average sleep duration. Population bands here are stable enough
 *  to use without a personal baseline (7–9h is the canonical adult
 *  recommendation). Framed as "typical range" rather than "healthy". */
export function classifyAvgSleepHours(
  hours: number | null | undefined,
): VitalTrendResult {
  if (hours == null || !Number.isFinite(hours) || hours <= 0) return NULL_RESULT;
  if (hours >= 7 && hours <= 9) return { trend: 'improving', label: 'in target range' };
  if (hours >= 6 && hours < 7) return { trend: 'monitor', label: 'below 7h' };
  if (hours > 9 && hours <= 10) return { trend: 'onTrack', label: 'long sleeper' };
  if (hours < 6) return { trend: 'monitor', label: 'short sleep' };
  return { trend: 'onTrack', label: 'long sleep' };
}

/** Daily step average. Population reference at 7,500 / 10,000 — these
 *  are widely cited and don't carry medical weight, so a soft chip is
 *  honest here. */
export function classifyAvgSteps(
  stepsPerDay: number | null | undefined,
): VitalTrendResult {
  if (stepsPerDay == null || !Number.isFinite(stepsPerDay) || stepsPerDay < 0) return NULL_RESULT;
  if (stepsPerDay >= 10000) return { trend: 'improving', label: 'above 10k' };
  if (stepsPerDay >= 7500) return { trend: 'onTrack', label: 'above 7.5k' };
  if (stepsPerDay >= 5000) return { trend: 'monitor', label: 'below 7.5k' };
  return { trend: 'monitor', label: 'low movement' };
}

/** 7-day average active calories per day. Reference bands at 2k / 1.2k
 *  match the recovery pillar's load thresholds. Same caveat as steps —
 *  soft, non-clinical. */
export function classifyActiveEnergy(
  kcalPerDay: number | null | undefined,
): VitalTrendResult {
  if (kcalPerDay == null || !Number.isFinite(kcalPerDay) || kcalPerDay < 0) return NULL_RESULT;
  if (kcalPerDay >= 2800) return { trend: 'improving', label: 'high burn' };
  if (kcalPerDay >= 2000) return { trend: 'improving', label: 'above 2k' };
  if (kcalPerDay >= 1200) return { trend: 'onTrack', label: 'on track' };
  return { trend: 'monitor', label: 'low burn' };
}
