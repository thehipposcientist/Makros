/**
 * Sleep-source quality detection.
 *
 * Apple Health is an aggregator: HR / HRV / RHR / respiratory and *asleep
 * totals* come through reliably from most rings, but **sleep STAGES**
 * (deep / REM / light) do not. WHOOP in particular writes only an asleep
 * total to HealthKit — no stages, no sleep score, and hours late. Scoring
 * readiness/sleep on a stage-less total silently produces a weaker, less
 * trustworthy number than the user's own ring app shows.
 *
 * This module classifies how complete the sleep data actually is, so the
 * UI can (a) mark a readiness/sleep read as "limited data" instead of
 * pretending it's full-fidelity, and (b) prompt the user to connect a
 * direct sleep source (Oura / WHOOP) that returns clean staged sleep.
 *
 * Pure functions only — no I/O, no React. See docs/architecture/oura-integration.md
 * ("Sleep-source quality detection") for how this feeds the connect CTA.
 */

export type SleepDataQuality =
  | 'rich'     // total + stage breakdown present (Apple Watch, Oura, etc.)
  | 'thin'     // asleep total present but NO stages (the WHOOP-via-HealthKit case)
  | 'missing'; // no usable sleep duration at all

/** Minimal night shape — accepts the relevant fields off SleepScoreInput /
 *  a daily health snapshot without coupling to either type. */
export interface SleepQualityNight {
  totalSleepHours?: number | null;
  deepSleepHours?: number | null;
  remSleepHours?: number | null;
  /** Explicit "stages were provided" signal when the caller already knows
   *  (e.g. a populated SleepStages object). Optional — when omitted we
   *  infer staging from deep/REM hours. */
  hasStages?: boolean | null;
}

function isPos(n: number | null | undefined): boolean {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/** Classify a single night's sleep data completeness. */
export function classifySleepNight(night: SleepQualityNight | null | undefined): SleepDataQuality {
  if (!night || !isPos(night.totalSleepHours)) return 'missing';
  const staged = night.hasStages === true || isPos(night.deepSleepHours) || isPos(night.remSleepHours);
  return staged ? 'rich' : 'thin';
}

export interface SleepWindowAssessment {
  /** Dominant classification across the considered window. */
  quality: SleepDataQuality;
  nightsConsidered: number;
  richNights: number;
  thinNights: number;
  missingNights: number;
  /** True when the data is too thin to score confidently AND the user has
   *  no direct sleep provider connected — drives a "limited data" marker on
   *  the readiness/sleep card and a connect CTA. */
  limited: boolean;
  /** Copy for the connect CTA, or null when data is fine. */
  ctaMessage: string | null;
}

export interface AssessSleepOptions {
  /** Set true once the user has connected a direct sleep source (Oura/WHOOP).
   *  When connected we never nag — the direct sync fills the gap. */
  hasDirectSleepProvider?: boolean;
  /** How many most-recent nights to weigh. Defaults to 7. */
  windowNights?: number;
}

export const LIMITED_SLEEP_CTA_THIN =
  'Connect Oura or WHOOP for full sleep stages and a sharper readiness score.';
export const LIMITED_SLEEP_CTA_MISSING =
  'No sleep data yet — wear your watch to sleep, or connect Oura or WHOOP.';

/**
 * Assess sleep-data quality over a window of recent nights. `limited` is
 * true when stage-rich nights are a minority (the majority of nights are
 * thin/missing) and the user hasn't connected a direct provider.
 *
 * Nights are expected newest-first or oldest-first — order doesn't matter;
 * only the most recent `windowNights` are counted, so pass them pre-sliced
 * if order is ambiguous.
 */
export function assessSleepWindow(
  nights: Array<SleepQualityNight | null | undefined>,
  opts: AssessSleepOptions = {},
): SleepWindowAssessment {
  const windowNights = opts.windowNights ?? 7;
  const considered = nights.slice(0, Math.max(0, windowNights));
  let rich = 0, thin = 0, missing = 0;
  for (const n of considered) {
    const q = classifySleepNight(n);
    if (q === 'rich') rich++;
    else if (q === 'thin') thin++;
    else missing++;
  }
  const total = considered.length;

  // Dominant classification: prefer rich if it's the plurality, else
  // whichever of thin/missing is larger (thin wins ties — "we have data,
  // it's just incomplete" is the more actionable message).
  let quality: SleepDataQuality = 'missing';
  if (total > 0) {
    if (rich >= thin && rich >= missing && rich > 0) quality = 'rich';
    else if (thin >= missing) quality = thin > 0 ? 'thin' : (missing > 0 ? 'missing' : 'rich');
    else quality = 'missing';
  }

  const hasProvider = opts.hasDirectSleepProvider === true;
  // Limited when stage-rich nights are a minority of an actual window and
  // no direct provider is filling the gap.
  const limited = !hasProvider && total > 0 && rich * 2 < total;

  let ctaMessage: string | null = null;
  if (limited) {
    ctaMessage = missing > thin ? LIMITED_SLEEP_CTA_MISSING : LIMITED_SLEEP_CTA_THIN;
  }

  return { quality, nightsConsidered: total, richNights: rich, thinNights: thin, missingNights: missing, limited, ctaMessage };
}

/** Convenience: is a single night's sleep too thin to score with confidence
 *  (and no direct provider connected)? */
export function isLimitedSleepNight(
  night: SleepQualityNight | null | undefined,
  hasDirectSleepProvider = false,
): boolean {
  if (hasDirectSleepProvider) return false;
  return classifySleepNight(night) !== 'rich';
}
