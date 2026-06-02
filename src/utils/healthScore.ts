/**
 * Health Score v2 — modular, multi-pillar wellness aggregate.
 *
 * Replaces the v1 single-formula score that was mostly an
 * activity/workout-consistency read. v2 splits the score into
 * independent sub-scores and only blends pillars that actually have
 * data — missing data does NOT mint free points. Coverage and
 * confidence are surfaced so the UI can communicate how complete the
 * read is.
 *
 * Pillars + weights (renormalized across pillars that have data):
 *   recovery     25%   — sleep score, RHR vs baseline, HRV vs baseline, training load
 *   training     20%   — adherence vs target, in-app workout volume consistency
 *   nutrition    20%   — calorie / protein / macro adherence, goal-aware
 *   cardio       10%   — VO2 max, Zone 2 minutes, cardio frequency, RHR trend
 *   strength     10%   — strength progression markers (PRs, e1RM trend)
 *   activity      5%   — steps + active energy (intentionally small)
 *   gutSupport   10%   — fiber, plant variety, hydration, fermented flag
 *
 * Inputs: only `appWorkouts14d` + `targetDaysPerWeek` are required.
 * Everything else is optional — callers pass only the data they have.
 *
 * Backwards compatibility: legacy `fitnessScore` / `recoveryMarker` /
 * `scoreInputs` / `recoveryInputs` fields are still populated on the
 * return value. `fitnessScore` is now an alias for `overallScore`
 * (rounded), so existing screens see the new score with no code
 * change. Legacy `scoreInputs` reflects the v1 activity-style
 * pillar contributions for diagnostic purposes only.
 */

import type {
  HealthSummary,
  HealthScoreResult,
  HealthPillarKey,
  RecoveryMarker,
} from '../types';

/** User-facing label for the overall score. Centralized so we can
 *  rename without grepping every screen. Intentionally not "Health
 *  Score" — the score is a wellness aggregate, not a clinical /
 *  medical read, and the renamed label leaves room for that
 *  distinction in copy. */
export const THALLO_SCORE_LABEL = 'Thallo Score';

// ── Public input types ─────────────────────────────────────────────────────

/** Optional nutrition rollup — caller passes whatever it has. */
export interface NutritionContext {
  /** Pre-computed 0–100 weekly nutrition score from the server-side
   *  scorer. When present, the pillar uses this directly and skips
   *  ratio-based scoring — the server has access to a richer view
   *  (per-day macro hits, fiber, sodium, energy availability) than
   *  we can reconstruct from adherence ratios alone. */
  weeklyNutritionScore?: number | null;
  /** Number of logged days backing `weeklyNutritionScore`. Drives
   *  whether the pillar trusts the override — fewer than 3 days and
   *  we still mark the pillar `available` but flag the gap. */
  weeklyDaysWithData?: number | null;
  /** 7d adherence ratios — actual / target. 1.0 = on target. Values
   *  > 1 are clipped on the upper side for kcal (overshooting calories
   *  is bad) but rewarded for protein (undershooting protein is bad).
   *  Used as the fallback path when no `weeklyNutritionScore` is
   *  available. */
  calorieAdherence7d?: number | null;
  proteinAdherence7d?: number | null;
  carbAdherence7d?: number | null;
  fatAdherence7d?: number | null;
  fiberGramsPerDay?: number | null;
  /** Goal so we can adjust how strict each lever is. e.g. fat-loss
   *  weights protein heavier than recomp; longevity weights fiber
   *  heavier than muscle gain. */
  goal?: string | null;
}

/** Optional gut-support / nutrition-quality rollup. Named "gutSupport"
 *  to make clear this is a wellness aggregate, not a clinical read. */
export interface GutSupportContext {
  fiberGramsPerDay?: number | null;
  plantVariety7d?: number | null;       // distinct plant foods in 7d
  hydrationOzPerDay?: number | null;    // 7d avg
  hydrationTargetOzPerDay?: number | null;
  fermentedFoodDays7d?: number | null;  // days with at least one fermented food
  giSymptomFlag?: boolean | null;       // user-reported, optional
}

/** Optional cardio rollup. */
export interface CardioContext {
  vo2Max?: number | null;
  zone2Minutes7d?: number | null;
  cardioSessions7d?: number | null;
  /** Personal RHR baseline trend signal: lower = better. Pass the
   *  delta in bpm of recent 7d vs 30d median (negative is improving). */
  rhrTrendBpm7dVs30d?: number | null;
  /** Future hook — heart rate recovery (1-min post-exercise). Not yet
   *  collected, but the pillar will pick it up when populated. */
  hrRecoveryBpm?: number | null;
}

/** Optional strength progression rollup. If nothing is passed, the
 *  strength pillar is omitted from scoring (no default points). */
export interface StrengthContext {
  /** Number of estimated-1RM PRs in last 28 days. */
  e1rmPrs28d?: number | null;
  /** Number of volume PRs (set × reps × weight) in last 28 days. */
  volumePrs28d?: number | null;
  /** Number of rep PRs in last 28 days. */
  repPrs28d?: number | null;
  /** Mean weekly tonnage trend — current 4-week avg vs prior 4-week
   *  avg, as a ratio. >1 means progressive overload trending up. */
  tonnageTrend4wRatio?: number | null;
  /** Whether the user has logged any strength work in the last 14
   *  days. False / undefined → strength pillar excluded. */
  hasRecentStrengthWork?: boolean | null;
}

export interface ScoreContext {
  /** Required — completed in-app workouts in last 14 days. */
  appWorkouts14d: number;
  /** Required — target days per week (drives adherence). */
  targetDaysPerWeek: number;
  /** Apple Health rollup (or null when not connected). */
  health: HealthSummary | null;
  /** All optional. Pillars without data are excluded from scoring. */
  nutrition?: NutritionContext | null;
  gutSupport?: GutSupportContext | null;
  cardio?: CardioContext | null;
  strength?: StrengthContext | null;
  /** Personal baselines for RHR / HRV. Without these the recovery
   *  pillar falls back to coarse population thresholds. */
  baselines?: {
    rhrMedian7d?: number | null;
    rhrMedian30d?: number | null;
    hrvMedian7d?: number | null;
    hrvMedian30d?: number | null;
  };
}

// ── Sub-score primitive ────────────────────────────────────────────────────

interface SubScoreResult {
  score: number;        // 0..100
  available: boolean;   // false → excluded from blend
  notes: string[];      // human-readable "why this score"
  missing: string[];    // signals that would improve accuracy
  /** Tagged identifiers for the inputs that backed this pillar. The
   *  values are stringly-typed here and narrowed at the
   *  `pillarSources` boundary in `calculateHealthScore`. Used by the
   *  explainer modal to say "Recovery: sleep + RHR + load". */
  signals?: string[];
  /** Nutrition pillar only — distinguishes the server short-circuit
   *  from the client ratio fallback so UI can explain a sudden score
   *  jump when the server score appears or disappears. */
  source?: 'server' | 'clientFallback' | 'unavailable';
}

const NEUTRAL: SubScoreResult = { score: 0, available: false, notes: [], missing: [] };

const PILLAR_WEIGHTS: Record<keyof HealthScoreResult['subScores'], number> = {
  recovery: 25,
  training: 20,
  nutrition: 20,
  cardio: 10,
  strength: 10,
  activity: 5,
  gutSupport: 10,
};

// ── Public API ─────────────────────────────────────────────────────────────

export function calculateHealthScore(ctx: ScoreContext): HealthScoreResult {
  const recovery = recoveryScore(ctx);
  const training = trainingScore(ctx);
  const nutrition = nutritionScore(ctx);
  const cardio = cardioScore(ctx);
  const strength = strengthScore(ctx);
  const activity = activityScore(ctx);
  const gutSupport = gutSupportScore(ctx);

  // Blend pillars that have data; renormalize weights so a missing
  // pillar doesn't drop the score, it just shifts mass to the
  // pillars we do have.
  const blend: Array<{ key: keyof typeof PILLAR_WEIGHTS; result: SubScoreResult }> = [
    { key: 'recovery', result: recovery },
    { key: 'training', result: training },
    { key: 'nutrition', result: nutrition },
    { key: 'cardio', result: cardio },
    { key: 'strength', result: strength },
    { key: 'activity', result: activity },
    { key: 'gutSupport', result: gutSupport },
  ];

  const totalWeight = Object.values(PILLAR_WEIGHTS).reduce((a, b) => a + b, 0);
  let availableWeight = 0;
  let weightedSum = 0;
  const subScores: HealthScoreResult['subScores'] = {};
  const explanation: string[] = [];
  const missingSignals: string[] = [];
  const missingByPillar: Partial<Record<HealthPillarKey, string[]>> = {};

  // Per-pillar summary used for top-factor extraction below. We can't
  // walk the blend twice cleanly because the result objects don't
  // carry the pillar key once flattened, so build this alongside.
  const availablePillars: Array<{
    key: HealthPillarKey;
    score: number;
    note: string | null;
  }> = [];

  for (const { key, result } of blend) {
    if (result.missing.length > 0) {
      missingByPillar[key] = [...result.missing];
    }
    if (!result.available) {
      for (const m of result.missing) if (!missingSignals.includes(m)) missingSignals.push(m);
      continue;
    }
    const w = PILLAR_WEIGHTS[key];
    availableWeight += w;
    weightedSum += result.score * w;
    subScores[key] = Math.round(result.score);
    const note = result.notes[0] ?? null;
    if (note) explanation.push(`${labelFor(key)}: ${note}`);
    availablePillars.push({ key, score: result.score, note });
    for (const m of result.missing) if (!missingSignals.includes(m)) missingSignals.push(m);
  }

  const overallScore = availableWeight > 0
    ? Math.round(weightedSum / availableWeight)
    : null;
  const dataCoverage = totalWeight > 0
    ? Math.round((availableWeight / totalWeight) * 100) / 100
    : 0;
  const confidence: HealthScoreResult['confidence'] =
    dataCoverage >= 0.75 ? 'high'
    : dataCoverage >= 0.4 ? 'medium'
    : 'low';

  // Top positive / negative factors. Threshold is generous on the
  // positive side (>=70 = "helping") and lenient on the negative side
  // (<=60 = "hurting") so the modal almost always has something to
  // say without flagging neutral pillars as problems. Capped at 2.
  const topPositiveFactors = availablePillars
    .filter(p => p.score >= 70)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map(formatFactor);
  const topNegativeFactors = availablePillars
    .filter(p => p.score < 60)
    .sort((a, b) => a.score - b.score)
    .slice(0, 2)
    .map(formatFactor);

  // ── Pillar source metadata ─────────────────────────────────────────────
  // Narrow each pillar's `signals` array into a typed source object.
  // Anything not in the result's `signals` is treated as not used. The
  // explicit cast at the boundary keeps the typed channel out of the
  // pillar implementations themselves (they emit plain strings).
  const pillarSources: HealthScoreResult['pillarSources'] = {
    nutritionScoreSource: nutrition.available
      ? (nutrition.source ?? 'clientFallback')
      : 'unavailable',
    recoverySignalsUsed:
      (recovery.signals ?? []) as HealthScoreResult['pillarSources']['recoverySignalsUsed'],
    cardioSignalsUsed:
      (cardio.signals ?? []) as HealthScoreResult['pillarSources']['cardioSignalsUsed'],
    strengthSignalsUsed:
      (strength.signals ?? []) as HealthScoreResult['pillarSources']['strengthSignalsUsed'],
    gutSignalsUsed:
      (gutSupport.signals ?? []) as HealthScoreResult['pillarSources']['gutSignalsUsed'],
    activitySignalsUsed:
      (activity.signals ?? []) as HealthScoreResult['pillarSources']['activitySignalsUsed'],
  };

  // ── Legacy v1 fields ────────────────────────────────────────────────────
  // Build the old recoveryMarker + scoreInputs so existing UI doesn't
  // break. recoveryMarker uses the same logic the v1 score did
  // (red/yellow/green from sleep delta / RHR / load).
  const legacy = legacyV1Inputs(ctx);

  return {
    // Legacy aliases
    fitnessScore: overallScore ?? 0,
    recoveryMarker: legacy.recoveryMarker,
    scoreInputs: legacy.scoreInputs,
    recoveryInputs: legacy.recoveryInputs,
    // v2
    overallScore,
    confidence,
    dataCoverage,
    subScores,
    missingSignals,
    missingByPillar,
    explanation,
    scoreLabel: THALLO_SCORE_LABEL,
    topPositiveFactors,
    topNegativeFactors,
    pillarSources,
  };
}

/** Format a pillar summary line for top-factor display. Falls back to
 *  the pillar label when the pillar didn't surface a note. */
function formatFactor(p: { key: HealthPillarKey; score: number; note: string | null }): string {
  return p.note ? `${labelFor(p.key)} — ${p.note}` : labelFor(p.key);
}

// ── Pillar: recovery ───────────────────────────────────────────────────────

/** Recovery pillar. Prefers the dedicated sleep score (built from
 *  stages, efficiency, HRV vs baseline, score caps, etc.) so we don't
 *  duplicate logic. Adds RHR-vs-baseline and HRV-vs-baseline
 *  adjustments when personal medians are available, and a small
 *  training-load modifier. */
export function recoveryScore(ctx: ScoreContext): SubScoreResult {
  const h = ctx.health;
  const b = ctx.baselines ?? {};
  const notes: string[] = [];
  const missing: string[] = [];
  const signals: string[] = [];

  // Source 1 — dedicated sleep score (preferred).
  let sleepComponent: number | null = null;
  if (h?.sleepScore?.score != null) {
    sleepComponent = h.sleepScore.score;
    signals.push('sleep');
    notes.push(`sleep score ${sleepComponent}`);
  } else if (h?.lastNightSleepHours != null) {
    // Fallback — coarse hour-based read so a user without stage data
    // still gets a recovery read instead of being excluded.
    sleepComponent = sleepHoursFallback(h.lastNightSleepHours);
    signals.push('sleep');
    notes.push(`sleep ${h.lastNightSleepHours.toFixed(1)}h (no stage data)`);
    missing.push('Apple Health sleep stages for full sleep score');
  } else {
    missing.push('last night sleep duration');
  }

  // Source 2 — RHR vs personal baseline.
  let rhrComponent: number | null = null;
  if (h?.restingHeartRate != null) {
    const rhr = h.restingHeartRate;
    signals.push('rhr');
    if (b.rhrMedian30d != null && b.rhrMedian30d > 0) {
      // Personalized: deviation from your own median wins over a
      // population threshold. +5 bpm above baseline = clear stress
      // signal; -2 bpm below = great recovery.
      const delta = rhr - b.rhrMedian30d;
      rhrComponent = delta <= -2 ? 100
        : delta <= 0 ? 90
        : delta <= 3 ? 75
        : delta <= 5 ? 55
        : delta <= 8 ? 35
        : 15;
      if (delta > 3) notes.push(`RHR +${Math.round(delta)} bpm above baseline`);
    } else {
      rhrComponent = rhr <= 55 ? 95
        : rhr <= 65 ? 80
        : rhr <= 75 ? 60
        : rhr <= 85 ? 40
        : 20;
      missing.push('30-day RHR baseline for personalized scoring');
    }
  } else {
    missing.push('resting heart rate');
  }

  // Source 3 — HRV vs personal baseline.
  let hrvComponent: number | null = null;
  if (h?.hrvAvg != null) {
    signals.push('hrv');
    if (b.hrvMedian30d != null && b.hrvMedian30d > 0) {
      const ratio = h.hrvAvg / b.hrvMedian30d;
      hrvComponent = ratio >= 1.10 ? 100
        : ratio >= 0.98 ? 85
        : ratio >= 0.92 ? 65
        : ratio >= 0.85 ? 45
        : 25;
      if (ratio < 0.92) notes.push(`HRV below baseline`);
    } else {
      // Without baseline, HRV is too noisy across individuals to
      // score absolutely — give it neutral weight (50) so it doesn't
      // dominate the pillar. Flag the missing signal.
      hrvComponent = 50;
      missing.push('30-day HRV baseline for personalized scoring');
    }
  } else {
    missing.push('HRV (heart rate variability)');
  }

  // Source 4 — recent training load. Heavy load with no other recovery
  // signal pulls the pillar down; light load nudges it up.
  const workouts7d = h?.workouts7d ?? Math.round(ctx.appWorkouts14d / 2);
  const target = Math.max(1, ctx.targetDaysPerWeek);
  let loadComponent = 75;
  if (workouts7d >= target + 2) loadComponent = 50;
  else if (workouts7d >= target + 1) loadComponent = 65;
  else if (workouts7d <= Math.max(0, target - 2)) loadComponent = 80;
  signals.push('load');

  // Blend — sleep weighted heaviest. Skip absent components so we
  // don't dilute with neutrals.
  const parts: Array<{ value: number; weight: number }> = [];
  if (sleepComponent != null) parts.push({ value: sleepComponent, weight: 0.45 });
  if (rhrComponent != null) parts.push({ value: rhrComponent, weight: 0.20 });
  if (hrvComponent != null) parts.push({ value: hrvComponent, weight: 0.20 });
  parts.push({ value: loadComponent, weight: 0.15 });

  if (parts.length <= 1) {
    // Only training load → not enough signal to call it a recovery
    // read. Mark unavailable so the pillar drops out of the blend.
    return {
      score: 0,
      available: false,
      notes,
      missing: missing.length > 0 ? missing : ['recovery data (sleep, RHR, or HRV)'],
      signals: [],
    };
  }

  const totalWeight = parts.reduce((a, p) => a + p.weight, 0);
  const score = parts.reduce((a, p) => a + p.value * p.weight, 0) / totalWeight;
  return {
    score: clamp(score, 0, 100),
    available: true,
    notes: notes.length > 0 ? notes : ['recovery markers in normal range'],
    missing,
    signals,
  };
}

// ── Pillar: training ───────────────────────────────────────────────────────

/** Training pillar — adherence + load consistency. Prefers in-app log
 *  data over HealthKit workout count to avoid double-counting (HK
 *  surfaces auto-detected walks etc., which inflate "consistency"
 *  without representing planned training). */
export function trainingScore(ctx: ScoreContext): SubScoreResult {
  const target14 = Math.max(1, ctx.targetDaysPerWeek * 2);
  const adherence = Math.min(1.5, ctx.appWorkouts14d / target14);
  // 1.0 adherence = full credit; > 1 small bonus capped at 100.
  const adherenceComponent = Math.min(100, Math.round(adherence * 90 + (adherence > 1 ? 10 : 0)));

  // Load consistency — weekly volume close to its 4-week mean is
  // healthier than feast-or-famine. Without a tonnage trend we still
  // approximate via session-count variance proxy: session count this
  // week vs target.
  const target7 = Math.max(1, ctx.targetDaysPerWeek);
  const week = Math.round(ctx.appWorkouts14d / 2);
  const ratio = week / target7;
  const consistencyComponent = ratio >= 0.85 && ratio <= 1.20 ? 95
    : ratio >= 0.65 && ratio <= 1.40 ? 80
    : ratio >= 0.4 && ratio <= 1.60 ? 60
    : 40;

  const score = adherenceComponent * 0.7 + consistencyComponent * 0.3;
  const notes: string[] = [];
  if (adherence < 0.7) notes.push(`only ${ctx.appWorkouts14d} sessions in 14d vs ${target14} target`);
  else if (adherence >= 1.0) notes.push(`${ctx.appWorkouts14d}/${target14} sessions on target`);
  // Note: this pillar is a count-based read. We do not yet weight by
  // session duration / volume / completion quality, so a very short
  // "junk" session counts the same as a full one. When the planner
  // exposes per-session quality (e.g. completed sets ratio), feed it
  // here behind a new signal so we don't reward churn.
  return {
    score: clamp(score, 0, 100),
    available: true,
    notes,
    missing: [],
    signals: [],
  };
}

// ── Pillar: cardio ─────────────────────────────────────────────────────────

export function cardioScore(ctx: ScoreContext): SubScoreResult {
  const c = ctx.cardio ?? {};
  const h = ctx.health;
  const notes: string[] = [];
  const missing: string[] = [];
  const signals: string[] = [];
  const parts: Array<{ value: number; weight: number }> = [];

  // VO2 max — primary cardio fitness marker. Cooper-style bands;
  // age- and sex-adjusted thresholds would be ideal future work.
  if (c.vo2Max != null) {
    const v = c.vo2Max;
    const value = v >= 50 ? 95
      : v >= 42 ? 80
      : v >= 35 ? 65
      : v >= 28 ? 45
      : 25;
    parts.push({ value, weight: 0.50 });
    signals.push('vo2Max');
    notes.push(`VO₂ max ${v.toFixed(1)} ml/kg/min`);
  } else if (h?.vo2Max != null) {
    const v = h.vo2Max;
    const value = v >= 50 ? 95 : v >= 42 ? 80 : v >= 35 ? 65 : v >= 28 ? 45 : 25;
    parts.push({ value, weight: 0.50 });
    signals.push('vo2Max');
    notes.push(`VO₂ max ${v.toFixed(1)} ml/kg/min`);
  } else {
    missing.push('VO₂ max from Apple Health');
  }

  // Zone 2 minutes — endurance base building.
  if (c.zone2Minutes7d != null) {
    const z2 = c.zone2Minutes7d;
    const value = z2 >= 150 ? 95 : z2 >= 90 ? 75 : z2 >= 45 ? 55 : z2 >= 15 ? 35 : 15;
    parts.push({ value, weight: 0.25 });
    signals.push('zone2Minutes');
    if (z2 < 90) notes.push(`Zone 2: ${Math.round(z2)} min/wk`);
  } else {
    missing.push('Zone 2 minutes per week');
  }

  // Cardio session frequency.
  if (c.cardioSessions7d != null) {
    const s = c.cardioSessions7d;
    const value = s >= 3 ? 90 : s >= 2 ? 70 : s >= 1 ? 50 : 25;
    parts.push({ value, weight: 0.10 });
    signals.push('cardioSessions');
  } else {
    missing.push('cardio session count');
  }

  // RHR trend — 7d vs 30d median. Negative delta = improving.
  if (c.rhrTrendBpm7dVs30d != null) {
    const d = c.rhrTrendBpm7dVs30d;
    const value = d <= -3 ? 95 : d <= 0 ? 80 : d <= 2 ? 60 : d <= 5 ? 40 : 25;
    parts.push({ value, weight: 0.15 });
    signals.push('rhrTrend');
  } else {
    missing.push('RHR trend (7d vs 30d)');
  }

  // HR recovery — future hook. Boost score weight when it lands.
  if (c.hrRecoveryBpm != null) {
    const r = c.hrRecoveryBpm;
    const value = r >= 25 ? 95 : r >= 18 ? 75 : r >= 12 ? 55 : 30;
    parts.push({ value, weight: 0.10 });
    signals.push('hrRecovery');
  }

  if (parts.length === 0) {
    return { score: 0, available: false, notes, missing, signals: [] };
  }
  const totalWeight = parts.reduce((a, p) => a + p.weight, 0);
  let score = parts.reduce((a, p) => a + p.value * p.weight, 0) / totalWeight;

  // Session count is a weak proxy: it proves the user did cardio-ish
  // work, but not whether it challenged aerobic capacity. Prevent a few
  // walks or route-only imports from looking like a strong cardio read
  // when VO2, HR-zone, RHR trend, or HR-recovery data is absent.
  const hasPrimarySignal = signals.some(s =>
    s === 'vo2Max' || s === 'zone2Minutes' || s === 'rhrTrend' || s === 'hrRecovery'
  );
  if (!hasPrimarySignal && signals.includes('cardioSessions')) {
    score = Math.min(score, 55);
    notes.push('session count only — connect HR or VO₂ data for cardio quality');
  }

  return { score: clamp(score, 0, 100), available: true, notes, missing, signals };
}

// ── Pillar: strength ───────────────────────────────────────────────────────

/** Strength pillar — strictly opt-in. If the caller doesn't pass any
 *  strength data (or passes `hasRecentStrengthWork: false`), the
 *  pillar is excluded so the user isn't penalized for a focus that
 *  doesn't include lifting. */
export function strengthScore(ctx: ScoreContext): SubScoreResult {
  const s = ctx.strength;
  if (!s || s.hasRecentStrengthWork === false) {
    return { ...NEUTRAL, missing: ['recent strength training (last 14 days)'], signals: [] };
  }
  const notes: string[] = [];
  const signals: string[] = [];
  const parts: Array<{ value: number; weight: number }> = [];

  // PR cadence — having recent PRs across e1RM / volume / rep dimensions
  // is the cleanest single signal of progressive overload.
  const e1rm = s.e1rmPrs28d ?? null;
  const volume = s.volumePrs28d ?? null;
  const rep = s.repPrs28d ?? null;
  const totalPrs = (e1rm ?? 0) + (volume ?? 0) + (rep ?? 0);
  if (e1rm != null || volume != null || rep != null) {
    const value = totalPrs >= 6 ? 95
      : totalPrs >= 3 ? 80
      : totalPrs >= 1 ? 65
      : 40;
    parts.push({ value, weight: 0.55 });
    if (e1rm != null) signals.push('e1rmPRs');
    if (volume != null) signals.push('volumePRs');
    if (rep != null) signals.push('repPRs');
    if (totalPrs > 0) notes.push(`${totalPrs} PR${totalPrs === 1 ? '' : 's'} in 28d`);
    else notes.push('no PRs in 28d');
  }

  // Tonnage trend — 4-week vs prior 4-week. Above 1.0 = trending up.
  // Bands soften the bottom end so a single deload week doesn't
  // crater the pillar — a planned deload typically lands near 0.85
  // when measured over 4w vs prior 4w. We label that transparently
  // rather than scoring it like a regression.
  if (s.tonnageTrend4wRatio != null) {
    const r = s.tonnageTrend4wRatio;
    const value = r >= 1.05 ? 95 : r >= 0.98 ? 80 : r >= 0.92 ? 65 : r >= 0.85 ? 55 : 35;
    parts.push({ value, weight: 0.45 });
    signals.push('tonnageTrend');
    if (r < 0.85) notes.push('weekly tonnage trending down');
    else if (r < 0.92) notes.push('lower tonnage week (possible deload)');
  }

  if (parts.length === 0) {
    return { ...NEUTRAL, missing: ['strength PR / tonnage data'], signals: [] };
  }
  const totalWeight = parts.reduce((a, p) => a + p.weight, 0);
  const score = parts.reduce((a, p) => a + p.value * p.weight, 0) / totalWeight;
  return { score: clamp(score, 0, 100), available: true, notes, missing: [], signals };
}

// ── Pillar: nutrition ──────────────────────────────────────────────────────

/** Nutrition pillar — calorie / protein / macro adherence. Goal-aware:
 *  fat-loss is strict on calorie ceiling, muscle-gain rewards hitting
 *  protein and slight surplus, recomp is lenient, longevity weights
 *  fiber heavily. */
export function nutritionScore(ctx: ScoreContext): SubScoreResult {
  const n = ctx.nutrition;
  if (!n) return { ...NEUTRAL, missing: ['7-day nutrition adherence'], source: 'unavailable' };

  // Server-side weekly score short-circuit. The Thallo server scorer
  // already produces a 0–100 weekly score from per-day data we don't
  // reconstruct on the client (energy availability, fiber, calorie
  // stability CV, etc.). When that's available, prefer it.
  if (n.weeklyNutritionScore != null && Number.isFinite(n.weeklyNutritionScore)) {
    const score = clamp(n.weeklyNutritionScore, 0, 100);
    const days = Number(n.weeklyDaysWithData ?? 0);
    const notes: string[] = [];
    const missing: string[] = [];
    // Attribute the source so the UI can explain a sudden number
    // change when the server score appears or drops out, rather than
    // looking like a silent jump in the formula.
    if (days > 0) notes.push(`server weekly nutrition score (${days} logged days)`);
    else notes.push('server weekly nutrition score');
    if (days < 3) missing.push('more logged meal days for stable nutrition score');
    return { score, available: true, notes, missing, source: 'server' };
  }

  const goal = (n.goal ?? '').toLowerCase();
  const isFatLoss = /fat|lose|cut|lean/.test(goal);
  const isMuscleGain = /muscle|bulk|gain|mass/.test(goal);
  const isRecomp = /recomp|body_recomp/.test(goal);
  const isEndurance = /endurance|cardio|run|marathon/.test(goal);
  const isLongevity = /longevity|health|maintain/.test(goal);

  const notes: string[] = [];
  const missing: string[] = [];
  const parts: Array<{ value: number; weight: number }> = [];

  // Calorie adherence — penalty shape depends on goal.
  if (n.calorieAdherence7d != null) {
    const r = n.calorieAdherence7d;
    let value: number;
    if (isFatLoss) {
      // Hitting target or slight under is best; over is bad.
      value = r <= 1.02 && r >= 0.85 ? 95
        : r > 1.02 && r <= 1.10 ? 70
        : r > 1.10 ? 35
        : r >= 0.75 ? 70   // under-eating reduces adherence quality
        : 40;
    } else if (isMuscleGain) {
      // Slight surplus rewarded; deficit penalized.
      value = r >= 1.0 && r <= 1.15 ? 95
        : r >= 0.92 && r < 1.0 ? 75
        : r > 1.15 ? 60
        : 35;
    } else {
      // Maintain / recomp / longevity / endurance — close to 1.0.
      value = r >= 0.92 && r <= 1.08 ? 95
        : r >= 0.85 && r <= 1.15 ? 75
        : 45;
    }
    parts.push({ value, weight: 0.30 });
    if (value < 70) notes.push(`calories ${Math.round(r * 100)}% of target`);
  } else {
    missing.push('calorie adherence (7-day)');
  }

  // Protein adherence — heavily weighted for fat-loss + muscle-gain.
  if (n.proteinAdherence7d != null) {
    const r = n.proteinAdherence7d;
    const value = r >= 1.0 ? 95
      : r >= 0.9 ? 80
      : r >= 0.75 ? 60
      : 35;
    const weight = (isFatLoss || isMuscleGain) ? 0.30 : 0.20;
    parts.push({ value, weight });
    if (r < 0.9) notes.push(`protein ${Math.round(r * 100)}% of target`);
  } else {
    missing.push('protein adherence (7-day)');
  }

  // Carb adherence — endurance weights this heavier; fat-loss less.
  if (n.carbAdherence7d != null) {
    const r = n.carbAdherence7d;
    const value = r >= 0.85 && r <= 1.20 ? 90 : r >= 0.7 && r <= 1.35 ? 70 : 45;
    const weight = isEndurance ? 0.20 : isFatLoss ? 0.10 : 0.15;
    parts.push({ value, weight });
  }

  // Fat adherence.
  if (n.fatAdherence7d != null) {
    const r = n.fatAdherence7d;
    const value = r >= 0.7 && r <= 1.30 ? 90 : r >= 0.5 && r <= 1.60 ? 70 : 50;
    parts.push({ value, weight: 0.10 });
  }

  // Fiber — most important for longevity/health goals.
  if (n.fiberGramsPerDay != null) {
    const f = n.fiberGramsPerDay;
    const value = f >= 30 ? 95 : f >= 22 ? 75 : f >= 15 ? 55 : 35;
    const weight = isLongevity ? 0.20 : 0.10;
    parts.push({ value, weight });
    if (f < 22) notes.push(`fiber ${Math.round(f)}g/day`);
  } else {
    missing.push('daily fiber grams');
  }

  if (parts.length === 0) {
    return { ...NEUTRAL, missing, source: 'unavailable' };
  }
  const totalWeight = parts.reduce((a, p) => a + p.weight, 0);
  const score = parts.reduce((a, p) => a + p.value * p.weight, 0) / totalWeight;
  return { score: clamp(score, 0, 100), available: true, notes, missing, source: 'clientFallback' };
}

// ── Pillar: gutSupport / nutrition quality ─────────────────────────────────

/** Gut-support pillar — fiber + plant variety + hydration + fermented
 *  food flag + optional GI symptoms. Named "support" rather than
 *  "health" so it reads as a wellness aggregate, not a clinical
 *  diagnosis. */
export function gutSupportScore(ctx: ScoreContext): SubScoreResult {
  const g = ctx.gutSupport;
  if (!g) return { ...NEUTRAL, missing: ['gut-support inputs (fiber, plants, hydration)'], signals: [] };
  const notes: string[] = [];
  const missing: string[] = [];
  const signals: string[] = [];
  const parts: Array<{ value: number; weight: number }> = [];

  if (g.fiberGramsPerDay != null) {
    const f = g.fiberGramsPerDay;
    parts.push({
      value: f >= 30 ? 95 : f >= 22 ? 75 : f >= 15 ? 55 : 30,
      weight: 0.30,
    });
    signals.push('fiber');
  } else {
    missing.push('daily fiber grams');
  }

  if (g.plantVariety7d != null) {
    const p = g.plantVariety7d;
    parts.push({
      value: p >= 30 ? 95 : p >= 20 ? 80 : p >= 12 ? 60 : 40,
      weight: 0.25,
    });
    signals.push('plantVariety');
    if (p < 20) notes.push(`${p} distinct plants in 7d`);
  } else {
    missing.push('plant-food variety (7-day)');
  }

  if (g.hydrationOzPerDay != null) {
    const target = g.hydrationTargetOzPerDay ?? 80;
    const ratio = g.hydrationOzPerDay / target;
    parts.push({
      value: ratio >= 0.95 ? 95 : ratio >= 0.80 ? 75 : ratio >= 0.65 ? 55 : 35,
      weight: 0.20,
    });
    signals.push('hydration');
    if (ratio < 0.80) notes.push(`hydration ${Math.round(ratio * 100)}% of target`);
  } else {
    missing.push('daily hydration ounces');
  }

  if (g.fermentedFoodDays7d != null) {
    const d = g.fermentedFoodDays7d;
    parts.push({
      value: d >= 4 ? 95 : d >= 2 ? 75 : d >= 1 ? 55 : 35,
      weight: 0.15,
    });
    signals.push('fermentedDays');
  } else {
    missing.push('fermented food days (7-day)');
  }

  // GI symptom flag — soft penalty when set, neutral when absent.
  if (g.giSymptomFlag === true) {
    parts.push({ value: 35, weight: 0.10 });
    signals.push('giFlag');
    notes.push('GI symptoms reported');
  } else if (g.giSymptomFlag === false) {
    parts.push({ value: 90, weight: 0.10 });
    signals.push('giFlag');
  }

  if (parts.length === 0) {
    return { ...NEUTRAL, missing, signals: [] };
  }
  const totalWeight = parts.reduce((a, p) => a + p.weight, 0);
  const score = parts.reduce((a, p) => a + p.value * p.weight, 0) / totalWeight;
  return { score: clamp(score, 0, 100), available: true, notes, missing, signals };
}

// ── Pillar: activity ───────────────────────────────────────────────────────

/** Activity pillar — non-exercise daily movement (steps + active
 *  energy). Intentionally small weight (5%) in v2 because adherence
 *  to planned training is the more meaningful signal; this pillar is
 *  the "did you also walk around today" check. */
export function activityScore(ctx: ScoreContext): SubScoreResult {
  const h = ctx.health;
  if (!h || (h.avgSteps7d == null && h.activeEnergy7d == null)) {
    return { ...NEUTRAL, missing: ['daily steps and active energy'], signals: [] };
  }
  const notes: string[] = [];
  const missing: string[] = [];
  const signals: string[] = [];
  const parts: Array<{ value: number; weight: number }> = [];

  if (h.avgSteps7d != null) {
    const s = h.avgSteps7d;
    parts.push({
      value: s >= 10000 ? 95 : s >= 7500 ? 80 : s >= 5000 ? 60 : s >= 2500 ? 40 : 20,
      weight: 0.65,
    });
    signals.push('steps');
    if (s < 7500) notes.push(`${Math.round(s).toLocaleString()} steps/day avg`);
  } else {
    missing.push('daily step count');
  }

  if (h.activeEnergy7d != null) {
    const e = h.activeEnergy7d;
    parts.push({
      value: e >= 2800 ? 95 : e >= 2000 ? 80 : e >= 1200 ? 60 : 40,
      weight: 0.35,
    });
    signals.push('activeEnergy');
  } else {
    missing.push('weekly active energy');
  }

  const totalWeight = parts.reduce((a, p) => a + p.weight, 0);
  const score = parts.reduce((a, p) => a + p.value * p.weight, 0) / totalWeight;
  return { score: clamp(score, 0, 100), available: true, notes, missing, signals };
}

// ── Legacy v1 fields ───────────────────────────────────────────────────────

/** Reproduces the v1 scoreInputs / recoveryMarker / recoveryInputs
 *  block so existing screens reading those fields keep working. v2
 *  consumers should ignore these and use `subScores`. */
function legacyV1Inputs(ctx: ScoreContext): {
  scoreInputs: HealthScoreResult['scoreInputs'];
  recoveryInputs: HealthScoreResult['recoveryInputs'];
  recoveryMarker: RecoveryMarker;
} {
  const h = ctx.health;
  const target14 = Math.max(1, ctx.targetDaysPerWeek * 2);
  const workoutRatio = Math.min(1, ctx.appWorkouts14d / target14);
  const workoutPoints = Math.round(workoutRatio * 40);

  const stepsPoints = h?.avgSteps7d != null
    ? Math.min(15, Math.round((h.avgSteps7d / 10000) * 15))
    : 0;

  const consistencyPoints = h?.workouts7d != null
    ? Math.round(Math.min(1, h.workouts7d / Math.max(1, ctx.targetDaysPerWeek)) * 15)
    : Math.round(Math.min(1, Math.round(ctx.appWorkouts14d / 2) / Math.max(1, ctx.targetDaysPerWeek)) * 15);

  let heartRatePoints = 5;
  if (h?.restingHeartRate != null) {
    heartRatePoints = Math.min(10, Math.max(0, Math.round(10 - ((h.restingHeartRate - 50) / 3))));
  }

  let sleepPoints = 0;
  if (h?.avgSleepHours7d != null) {
    const hrs = h.avgSleepHours7d;
    if (hrs >= 7 && hrs <= 9) sleepPoints = 15;
    else if (hrs >= 6) sleepPoints = Math.round(((hrs - 5) / 2) * 15);
    else if (hrs > 9) sleepPoints = Math.max(8, 15 - Math.round((hrs - 9) * 3));
    else sleepPoints = Math.max(0, Math.round((hrs / 6) * 10));
  }

  const activeEnergyPoints = h?.activeEnergy7d != null
    ? Math.min(5, Math.round((h.activeEnergy7d / 2000) * 5))
    : 0;

  // Recovery marker — sleep delta vs 7d avg, RHR status, recent load.
  let sleepVsAverage: number | null = null;
  if (h?.lastNightSleepHours != null && h?.avgSleepHours7d != null) {
    sleepVsAverage = Math.round((h.lastNightSleepHours - h.avgSleepHours7d) * 10) / 10;
  }
  const rhrStatus: 'normal' | 'elevated' | 'unknown' = h?.restingHeartRate != null
    ? (h.restingHeartRate > 75 ? 'elevated' : 'normal')
    : 'unknown';
  const workouts = h?.workouts7d ?? Math.round(ctx.appWorkouts14d / 2);
  const recentLoad: 'light' | 'moderate' | 'heavy' = workouts >= ctx.targetDaysPerWeek + 1
    ? 'heavy'
    : workouts <= Math.max(1, ctx.targetDaysPerWeek - 2)
      ? 'light'
      : 'moderate';

  let redFlags = 0;
  let yellowFlags = 0;
  if (sleepVsAverage != null) {
    if (sleepVsAverage < -1.5) redFlags++;
    else if (sleepVsAverage < -0.5) yellowFlags++;
  }
  if (rhrStatus === 'elevated') yellowFlags++;
  if (recentLoad === 'heavy') yellowFlags++;
  const recoveryMarker: RecoveryMarker = redFlags >= 1 || (yellowFlags >= 2 && recentLoad === 'heavy')
    ? 'red'
    : yellowFlags >= 1 ? 'yellow'
      : 'green';

  return {
    scoreInputs: {
      workoutPoints,
      stepsPoints,
      consistencyPoints,
      heartRatePoints,
      sleepPoints,
      activeEnergyPoints,
    },
    recoveryInputs: { sleepVsAverage, rhrStatus, recentLoad },
    recoveryMarker,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function sleepHoursFallback(hours: number): number {
  if (hours >= 7 && hours <= 9) return 90;
  if (hours >= 6) return 70;
  if (hours >= 5) return 50;
  return 30;
}

function labelFor(key: keyof typeof PILLAR_WEIGHTS): string {
  switch (key) {
    case 'recovery':   return 'Recovery';
    case 'training':   return 'Training';
    case 'nutrition':  return 'Nutrition';
    case 'cardio':     return 'Cardio';
    case 'strength':   return 'Strength';
    case 'activity':   return 'Activity';
    case 'gutSupport': return 'Gut support';
  }
}

/**
 * Human-readable labels for the recovery marker.
 */
export const RECOVERY_LABELS: Record<RecoveryMarker, { emoji: string; label: string; advice: string }> = {
  green:  { emoji: '🟢', label: 'Good to go',    advice: 'Recovery looks solid — train as planned.' },
  yellow: { emoji: '🟡', label: 'Moderate',       advice: 'Consider lighter intensity or extra rest between sets.' },
  red:    { emoji: '🔴', label: 'Recovery needed', advice: 'Your body could use a break — try active recovery or a rest day.' },
};
