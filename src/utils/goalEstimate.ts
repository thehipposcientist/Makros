import { UserProfile, BodyScanEntry } from '../types';
import { GoalConfig } from '../hooks/useMetaData';

const PACE_LBS_PER_WEEK: Record<string, Record<string, number>> = {
  fat_loss:    { conservative: 0.5,  moderate: 1.0,  aggressive: 1.5 },
  toning:      { conservative: 0.5,  moderate: 0.75, aggressive: 1.0 },
  muscle_gain: { conservative: 0.25, moderate: 0.5,  aggressive: 1.0 },
  body_recomp: { conservative: 0.25, moderate: 0.5,  aggressive: 0.75 },
};

// Profiles store primary goal ids (lose_fat, build_muscle, ...). The pace
// table keys off bucket names. Without this map the lookup whiffs and
// no ETA shows on the Progress weight card.
export function resolveGoalBucket(goal: string | null | undefined): string {
  if (!goal) return '';
  return GOAL_TO_BUCKET[goal] ?? goal;
}

const GOAL_TO_BUCKET: Record<string, string> = {
  build_muscle: 'muscle_gain', lean_bulk: 'muscle_gain', gain_weight: 'muscle_gain',
  improve_aesthetics: 'muscle_gain', build_glutes: 'muscle_gain',
  build_upper_body: 'muscle_gain', build_lower_body: 'muscle_gain',
  build_arms: 'muscle_gain', build_shoulders: 'muscle_gain',
  lose_fat: 'fat_loss', get_lean: 'fat_loss', cut: 'fat_loss',
  preserve_muscle_cutting: 'fat_loss',
  body_recomp: 'body_recomp',
  tone: 'toning', get_toned: 'toning',
};

export interface GoalEstimate {
  weeks: number;
  days: number;
  date: Date;
  label: string;
}

export function getGoalEstimate(profile: UserProfile, goalConfig: GoalConfig): GoalEstimate | null {
  const { goal, goalDetails, physicalStats } = profile;
  const { pace, targetWeightLbs } = goalDetails;

  const weightGoals   = new Set(goalConfig.weight_goals);
  const timelineGoals = new Set(goalConfig.timeline_goals);

  let weeks: number | null = null;

  // Resolve to bucket so primary goal ids ("lose_fat", "build_muscle")
  // hit the bucket-keyed pace table ("fat_loss", "muscle_gain").
  const bucket = GOAL_TO_BUCKET[goal] ?? goal;

  if ((weightGoals.has(goal) || weightGoals.has(bucket)) && targetWeightLbs != null && targetWeightLbs > 0) {
    const lbsPerWeek = PACE_LBS_PER_WEEK[bucket]?.[pace] ?? PACE_LBS_PER_WEEK[goal]?.[pace];
    if (lbsPerWeek && lbsPerWeek > 0 && physicalStats?.weightLbs) {
      const delta = Math.abs(physicalStats.weightLbs - targetWeightLbs);
      weeks = Math.ceil(delta / lbsPerWeek);
    }
  } else if (timelineGoals.has(goal) || timelineGoals.has(bucket)) {
    weeks = goalConfig.timeline_weeks[bucket]?.[pace] ?? goalConfig.timeline_weeks[goal]?.[pace] ?? null;
  }

  if (!weeks || weeks <= 0) return null;

  const days = Math.max(1, Math.ceil(weeks * 7));
  const date = new Date();
  date.setDate(date.getDate() + days);

  let label = '';
  if (days < 14) {
    label = days === 1 ? '1 day away' : `${days} days away`;
  } else {
    label = weeks === 1 ? '1 week away' : `${weeks} weeks away`;
  }

  return {
    weeks,
    days,
    date,
    label,
  };
}

// ── Recomp projection ────────────────────────────────────────────────────────

export interface RecompProjection {
  /** Display range for expected weekly scale weight change, e.g. "±0.25 lb/week" */
  scaleNote: string;
  /** Low end of weekly estimated fat loss in lbs */
  fatLossLow: number;
  /** High end of weekly estimated fat loss in lbs */
  fatLossHigh: number;
  /** Human label for the fat loss range, e.g. "0.2–0.5 lb/week" */
  fatLossRange: string;
  leanMassNote: string;
  bestSignals: string[];
  /** Optional note for paces where the visual change may be slower. */
  caveat: string | null;
  timelineWeeks: number;
}

// Calorie context mirrors backend goal_params.py BODY_RECOMP adjustments:
//   conservative: -8% capped at -250 cal/day (fat-priority recomp)
//   moderate:     -5% capped at -250 cal/day (balanced 95% maintenance)
//   aggressive:    0% maintenance (muscle-priority recomp)
const RECOMP_CONFIG: Record<string, {
  fatLow: number; fatHigh: number;
  scaleNote: string; leanNote: string; caveat: string | null;
}> = {
  conservative: {
    fatLow: 0.25, fatHigh: 0.55,
    scaleNote: 'slight loss or stable',
    leanNote: 'maintain',
    caveat: null,
  },
  moderate: {
    fatLow: 0.2, fatHigh: 0.45,
    scaleNote: '±0.25 lb/week',
    leanNote: 'maintain or slowly increase',
    caveat: null,
  },
  aggressive: {
    fatLow: 0.1, fatHigh: 0.3,
    scaleNote: 'mostly stable',
    leanNote: 'slowly building (muscle focus)',
    caveat: 'Maintenance calories prioritize training output. Fat loss may be slower, but body composition can still improve through strength gains.',
  },
};

// ── Progress bar (start → expected → current → target) ─────────────────

export interface GoalProgressBar {
  /** Start weight in lbs, when the goal began. */
  startWeightLbs: number;
  /** Most recent weight in lbs. */
  currentWeightLbs: number;
  /** Target weight in lbs. */
  targetWeightLbs: number;
  /** Where the user "should be" given pace × weeks since goal start, in lbs. */
  expectedWeightLbs: number;
  /** 0..1 fraction of the start→target distance the user has covered. */
  actualPct: number;
  /** 0..1 fraction the user should have covered by now given pace. */
  expectedPct: number;
  /** lbs ahead (positive) or behind (negative) the expected curve. */
  deltaFromExpectedLbs: number;
  /** Whether the user is ahead of, on, or behind pace. ≥0.5 lb buffer
   *  on either side counts as "on" so daily weight noise doesn't
   *  flip the verdict. */
  verdict: 'ahead' | 'on' | 'behind';
  /** Days elapsed since the goal started. */
  daysElapsed: number;
  /** -1 for fat loss, +1 for weight gain — direction current weight
   *  needs to move to reach target. */
  direction: -1 | 1;
  /** lbs/week the user's pace prescribes for this goal — same value used
   *  to compute the expected curve, exposed so trajectory charts can
   *  draw the planned line without re-resolving the pace table. */
  lbsPerWeek: number;
  /** Total days the goal plan covers, start → target at the user's pace. */
  totalPlannedDays: number;
}

/** Build the inputs for a start → current → target progress bar. Returns
 *  null when the goal isn't a weight-change goal, or when the inputs
 *  needed (start weight, target weight, goal start date, pace) aren't
 *  populated yet. The "expected" position uses pace × weeks elapsed —
 *  the same lbs-per-week table the ETA estimator uses, so the bar and
 *  the ETA always agree. */
export function computeGoalProgressBar(
  profile: UserProfile,
  goalConfig: GoalConfig,
  options?: { now?: Date },
): GoalProgressBar | null {
  const { goal, goalDetails, physicalStats } = profile;
  const weightGoals = new Set(goalConfig.weight_goals);
  const bucket = GOAL_TO_BUCKET[goal] ?? goal;
  if (!(weightGoals.has(goal) || weightGoals.has(bucket))) return null;

  const targetWeightLbs = goalDetails.targetWeightLbs ?? null;
  const startWeightLbs = goalDetails.startWeightLbs ?? null;
  const pace = goalDetails.pace ?? 'moderate';
  const goalStartedAt = goalDetails.goalStartedAt ?? null;
  // Prefer the latest weightEntry; fall back to the cached profile weight.
  const latestEntry = profile.weightEntries && profile.weightEntries.length > 0
    ? [...profile.weightEntries].sort((a, b) => String(b.logged_at ?? b.date).localeCompare(String(a.logged_at ?? a.date)))[0]
    : null;
  const currentWeightLbs = latestEntry?.weight_lbs ?? physicalStats?.weightLbs ?? null;

  if (!startWeightLbs || !currentWeightLbs || !targetWeightLbs || !goalStartedAt) {
    return null;
  }
  if (startWeightLbs === targetWeightLbs) return null;

  const lbsPerWeek = PACE_LBS_PER_WEEK[bucket]?.[pace] ?? PACE_LBS_PER_WEEK[goal]?.[pace];
  if (!lbsPerWeek || lbsPerWeek <= 0) return null;

  const now = options?.now ?? new Date();
  const startedMs = new Date(goalStartedAt).getTime();
  if (!Number.isFinite(startedMs) || startedMs > now.getTime()) return null;

  const direction: -1 | 1 = targetWeightLbs < startWeightLbs ? -1 : 1;
  const totalDelta = Math.abs(targetWeightLbs - startWeightLbs);

  // Signed progress: positive = moving toward target.
  const actualDelta = (currentWeightLbs - startWeightLbs) * direction;

  const elapsedMs = now.getTime() - startedMs;
  const elapsedWeeks = elapsedMs / (7 * 86400 * 1000);
  // Cap expected at 100% — once the planned timeline is hit, the bar
  // shouldn't push past the target marker.
  const expectedDelta = Math.min(Math.max(0, elapsedWeeks * lbsPerWeek), totalDelta);

  const actualPct = clamp01(actualDelta / totalDelta);
  const expectedPct = clamp01(expectedDelta / totalDelta);

  const deltaFromExpectedLbs = round1(actualDelta - expectedDelta);
  const verdict: 'ahead' | 'on' | 'behind' =
    Math.abs(deltaFromExpectedLbs) < 0.5 ? 'on'
    : deltaFromExpectedLbs > 0 ? 'ahead'
      : 'behind';
  // Expected current weight in lbs (where the user "should be").
  const expectedWeightLbs = startWeightLbs + (direction * expectedDelta);
  const daysElapsed = Math.max(0, Math.round(elapsedMs / 86400000));
  const totalPlannedDays = Math.max(1, Math.ceil((totalDelta / lbsPerWeek) * 7));

  return {
    startWeightLbs: round1(startWeightLbs),
    currentWeightLbs: round1(currentWeightLbs),
    targetWeightLbs: round1(targetWeightLbs),
    expectedWeightLbs: round1(expectedWeightLbs),
    actualPct,
    expectedPct,
    deltaFromExpectedLbs,
    verdict,
    daysElapsed,
    direction,
    lbsPerWeek,
    totalPlannedDays,
  };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ── Fat-mass progress (start → current) ─────────────────────────────

export interface FatMassProgress {
  /** Estimated fat-mass (lbs) at goal start. Null when start BF% is unknown. */
  startFatLbs: number | null;
  /** Estimated fat-mass (lbs) right now. Null when current BF% is unknown
   *  AND we can't impute it (i.e. no scale-delta either). */
  currentFatLbs: number | null;
  /** Positive = fat lost since goal start. Null when no signed delta is computable. */
  fatLostLbs: number | null;
  /** Scale-weight delta minus fat-mass delta. Positive = lean mass gained.
   *  Null when either side is unknown. */
  leanMassDeltaLbs: number | null;
  /** measured: scans on both ends. imputed: one scan + scale-weight delta.
   *  trend-only: no scans, only scale weight (fat split assumed). unknown: no signal. */
  confidence: 'measured' | 'imputed' | 'trend-only' | 'unknown';
  /** Short human label for the headline. e.g. "8.4 lb fat lost", or null. */
  label: string | null;
}

/** Estimate fat-mass change since the goal started. Inputs:
 *   - `startWeightLbs` / `startBodyFatPct` from goalDetails (server snapshot)
 *   - `currentWeightLbs` from the latest weight entry or profile
 *   - `currentBodyFatPct` from the most recent BodyScan (caller's responsibility to pick)
 *
 *  Confidence levels:
 *   - measured: both scans present → exact fat-mass delta.
 *   - imputed:  one scan + scale delta → assume LBM preserved on the
 *               unscanned end, attribute remainder to fat.
 *   - trend-only: no scans → assume an 80/20 fat/lean split of scale
 *                 delta for fat-loss/lean-bulk; null fat-mass for recomp
 *                 (handled by caller — recomp without scans gets nulls).
 *   - unknown: missing start weight or current weight → returns null. */
export function computeFatMassProgress(input: {
  startWeightLbs: number | null | undefined;
  startBodyFatPct: number | null | undefined;
  currentWeightLbs: number | null | undefined;
  currentBodyFatPct: number | null | undefined;
  goalBucket: 'fat_loss' | 'muscle_gain' | 'body_recomp' | 'toning' | string;
}): FatMassProgress | null {
  const sw = finitePositive(input.startWeightLbs);
  const cw = finitePositive(input.currentWeightLbs);
  if (!sw || !cw) return null;

  const sbf = finitePositive(input.startBodyFatPct);
  const cbf = finitePositive(input.currentBodyFatPct);
  const scaleDelta = sw - cw; // positive = weight lost

  // Both scans → measured fat-mass delta.
  if (sbf != null && cbf != null) {
    const startFat = sw * (sbf / 100);
    const currentFat = cw * (cbf / 100);
    const fatLost = startFat - currentFat;
    return {
      startFatLbs: round1(startFat),
      currentFatLbs: round1(currentFat),
      fatLostLbs: round1(fatLost),
      leanMassDeltaLbs: round1(fatLost - scaleDelta), // positive = lean gained
      confidence: 'measured',
      label: formatFatLabel(fatLost),
    };
  }

  // Start scan only — assume LBM preserved, attribute scale delta to fat.
  if (sbf != null && cbf == null) {
    const startFat = sw * (sbf / 100);
    const startLean = sw - startFat;
    const currentFat = Math.max(0, cw - startLean);
    const fatLost = startFat - currentFat;
    return {
      startFatLbs: round1(startFat),
      currentFatLbs: round1(currentFat),
      fatLostLbs: round1(fatLost),
      leanMassDeltaLbs: 0,
      confidence: 'imputed',
      label: formatFatLabel(fatLost),
    };
  }

  // Current scan only — back-solve start LBM from current LBM assuming preserved.
  if (sbf == null && cbf != null) {
    const currentFat = cw * (cbf / 100);
    const currentLean = cw - currentFat;
    const startFat = Math.max(0, sw - currentLean);
    const fatLost = startFat - currentFat;
    return {
      startFatLbs: round1(startFat),
      currentFatLbs: round1(currentFat),
      fatLostLbs: round1(fatLost),
      leanMassDeltaLbs: 0,
      confidence: 'imputed',
      label: formatFatLabel(fatLost),
    };
  }

  // No scans on either end. Recomp: not estimable (scale stays flat, no BF
  // anchor) — caller will hide the UI. Fat-loss / lean-bulk: assume 80/20
  // fat/lean split of the scale delta.
  if (input.goalBucket === 'body_recomp') {
    return {
      startFatLbs: null,
      currentFatLbs: null,
      fatLostLbs: null,
      leanMassDeltaLbs: null,
      confidence: 'unknown',
      label: null,
    };
  }

  if (Math.abs(scaleDelta) < 0.5) {
    return null;
  }

  const fatLost = scaleDelta * 0.8;
  return {
    startFatLbs: null,
    currentFatLbs: null,
    fatLostLbs: round1(fatLost),
    leanMassDeltaLbs: round1(fatLost - scaleDelta),
    confidence: 'trend-only',
    label: formatFatLabel(fatLost),
  };
}

function finitePositive(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

function formatFatLabel(fatLostLbs: number): string | null {
  const r = round1(fatLostLbs);
  if (r === 0) return 'fat mass holding steady';
  return r > 0 ? `${r.toFixed(1)} lb fat lost` : `${Math.abs(r).toFixed(1)} lb fat gained`;
}

// ── Recomp trajectory (start → expected band → current BF%) ─────────

export interface RecompTrajectory {
  /** BF% at goal start (from BodyScan within 30d of goal set). */
  startBodyFatPct: number;
  /** BF% from the most recent BodyScan on or after the goal start.
   *  Null when no scan exists in that window. */
  currentBodyFatPct: number | null;
  /** Mid-pace expected BF% at today (the dashed line on the chart). */
  expectedBodyFatPctNow: number;
  /** Slow-end expected BF% at today (less drop = higher %). */
  planLowBodyFatPctNow: number;
  /** Fast-end expected BF% at today (more drop = lower %). */
  planHighBodyFatPctNow: number;
  /** Slow-end BF% at end of timeline. */
  planEndBodyFatPctLow: number;
  /** Fast-end BF% at end of timeline. */
  planEndBodyFatPctHigh: number;
  daysElapsed: number;
  totalPlannedDays: number;
  /** Scan points since goal start, ordered by day. The first entry is a
   *  synthetic start anchor so the actual line never floats. */
  actualPoints: Array<{ day: number; bfPct: number }>;
  /** ahead = dropping faster than the band, behind = slower, on = inside.
   *  Null when no scans have landed since goal start. */
  verdict: 'ahead' | 'on' | 'behind' | null;
  /** Percentage points ahead (positive) or behind (negative) the mid-pace
   *  line at today. Null when verdict is null. */
  verdictDeltaPct: number | null;
}

/** Build the inputs for a body-recomp BF% trajectory chart. Body-recomp
 *  goals don't have a scale target — the planned trajectory is a *range*
 *  of plausible BF% outcomes (slow → fast pace), and the actual line is
 *  built from BodyScan history. Returns null when:
 *   - The goal isn't body_recomp.
 *   - The start BF% snapshot is missing (no BodyScan was on file at goal
 *     start — without it, we can't anchor the y-axis honestly).
 *   - Goal start date or current weight is missing.
 *
 *  BF% drop is estimated as (fatLossLbs / startWeightLbs × 100), which
 *  assumes preserved lean mass — the same assumption recomp pace tables
 *  bake in. */
export function computeRecompTrajectory(
  profile: UserProfile,
  goalConfig: GoalConfig,
  bodyScanHistory: BodyScanEntry[],
  options?: { now?: Date },
): RecompTrajectory | null {
  const bucket = GOAL_TO_BUCKET[profile.goal] ?? profile.goal;
  if (bucket !== 'body_recomp') return null;

  const startBodyFatPct = finitePositive(profile.goalDetails?.startBodyFatPct);
  const goalStartedAt = profile.goalDetails?.goalStartedAt ?? null;
  const startWeightLbs = finitePositive(profile.goalDetails?.startWeightLbs)
    ?? finitePositive(profile.physicalStats?.weightLbs);
  if (!startBodyFatPct || !goalStartedAt || !startWeightLbs) return null;

  const pace = profile.goalDetails?.pace ?? 'moderate';
  const cfg = RECOMP_CONFIG[pace] ?? RECOMP_CONFIG.moderate;
  const timelineWeeks = goalConfig.timeline_weeks?.['body_recomp']?.[pace] ?? 24;
  const totalPlannedDays = Math.max(1, Math.ceil(timelineWeeks * 7));

  const now = options?.now ?? new Date();
  const startedMs = new Date(goalStartedAt).getTime();
  if (!Number.isFinite(startedMs) || startedMs > now.getTime()) return null;
  const elapsedMs = now.getTime() - startedMs;
  const daysElapsed = Math.max(0, Math.round(elapsedMs / 86400000));
  const elapsedWeeks = daysElapsed / 7;

  const bfDropPerLb = 100 / startWeightLbs;
  const planLowDropNow = Math.min(cfg.fatLow * elapsedWeeks * bfDropPerLb, startBodyFatPct);
  const planHighDropNow = Math.min(cfg.fatHigh * elapsedWeeks * bfDropPerLb, startBodyFatPct);
  const planMidDropNow = (planLowDropNow + planHighDropNow) / 2;
  const planLowEndDrop = Math.min(cfg.fatLow * timelineWeeks * bfDropPerLb, startBodyFatPct);
  const planHighEndDrop = Math.min(cfg.fatHigh * timelineWeeks * bfDropPerLb, startBodyFatPct);

  const planLowBodyFatPctNow = round1(startBodyFatPct - planLowDropNow);
  const planHighBodyFatPctNow = round1(startBodyFatPct - planHighDropNow);
  const expectedBodyFatPctNow = round1(startBodyFatPct - planMidDropNow);
  const planEndBodyFatPctLow = round1(startBodyFatPct - planLowEndDrop);
  const planEndBodyFatPctHigh = round1(startBodyFatPct - planHighEndDrop);

  // Scans since goal start, deduped by day (last wins).
  const dayToScan = new Map<number, number>();
  for (const scan of bodyScanHistory) {
    const scanDateStr = scan.date;
    if (!scanDateStr) continue;
    const scanMs = new Date(scanDateStr + 'T12:00:00').getTime();
    if (!Number.isFinite(scanMs) || scanMs < startedMs) continue;
    const day = Math.round((scanMs - startedMs) / 86400000);
    if (day < 0 || day > daysElapsed) continue;
    const bf = finitePositive(scan.bodyFatPct);
    if (bf == null) continue;
    dayToScan.set(day, bf);
  }

  const actualPoints: Array<{ day: number; bfPct: number }> = [
    { day: 0, bfPct: startBodyFatPct },
  ];
  const sortedDays = [...dayToScan.keys()].sort((a, b) => a - b);
  for (const d of sortedDays) {
    if (d === 0) {
      actualPoints[0] = { day: 0, bfPct: dayToScan.get(0)! };
    } else {
      actualPoints.push({ day: d, bfPct: dayToScan.get(d)! });
    }
  }

  const latestScanDay = sortedDays.length > 0 ? sortedDays[sortedDays.length - 1] : null;
  const currentBodyFatPct = latestScanDay != null ? dayToScan.get(latestScanDay)! : null;

  let verdict: 'ahead' | 'on' | 'behind' | null = null;
  let verdictDeltaPct: number | null = null;
  if (currentBodyFatPct != null && daysElapsed > 0) {
    // Actual drop minus mid-pace expected drop, in percentage points.
    const actualDrop = startBodyFatPct - currentBodyFatPct;
    const expectedDrop = planMidDropNow;
    verdictDeltaPct = round1(actualDrop - expectedDrop);
    verdict = Math.abs(verdictDeltaPct) < 0.3
      ? 'on'
      : verdictDeltaPct > 0 ? 'ahead' : 'behind';
  }

  return {
    startBodyFatPct: round1(startBodyFatPct),
    currentBodyFatPct: currentBodyFatPct != null ? round1(currentBodyFatPct) : null,
    expectedBodyFatPctNow,
    planLowBodyFatPctNow,
    planHighBodyFatPctNow,
    planEndBodyFatPctLow,
    planEndBodyFatPctHigh,
    daysElapsed,
    totalPlannedDays,
    actualPoints,
    verdict,
    verdictDeltaPct,
  };
}

export function getRecompProjection(
  profile: UserProfile,
  goalConfig: GoalConfig,
): RecompProjection | null {
  const bucket = GOAL_TO_BUCKET[profile.goal] ?? profile.goal;
  if (bucket !== 'body_recomp') return null;

  const pace = profile.goalDetails?.pace ?? 'moderate';
  const cfg = RECOMP_CONFIG[pace] ?? RECOMP_CONFIG.moderate;
  const timelineWeeks = goalConfig.timeline_weeks?.['body_recomp']?.[pace] ?? 24;

  return {
    scaleNote: cfg.scaleNote,
    fatLossLow: cfg.fatLow,
    fatLossHigh: cfg.fatHigh,
    fatLossRange: `${cfg.fatLow}–${cfg.fatHigh} lb/week`,
    leanMassNote: cfg.leanNote,
    bestSignals: ['Waist trend', 'Weekly average weight', 'Strength trend', 'Progress photos'],
    caveat: cfg.caveat,
    timelineWeeks,
  };
}
