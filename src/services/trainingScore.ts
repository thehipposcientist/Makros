// Training score — 0-100 measure of "how productive was this workout?"
//
// Computed at workout finish from the data we already have (HR zones,
// duration, sets logged vs planned). Stored on `StoredWorkoutSummary`
// so the Progress tab can chart it against the day's readiness score.
//
// Design rules:
//   - Pure function. No DB, no async.
//   - Missing inputs collapse to neutral (60% of pillar) — same pattern
//     as preparedness/sleep scoring. Never punish for un-readable data.
//   - Goal-aware: lifting users care about volume/effort, cardio users
//     care about Z2/intervals, hybrid users get a blended formula.

export type TrainingScoreFocusKind = 'lift' | 'cardio' | 'mixed' | 'mobility' | 'recovery';

export interface TrainingScoreInput {
  // Workout type — drives pillar weights.
  focusKind: TrainingScoreFocusKind;
  // Duration: actual seconds the user actually trained, vs the
  // estimated/planned seconds the planner emitted.
  actualDurationSec: number;
  estimatedDurationSec?: number | null;
  // Volume: sets the user actually completed vs sets the plan asked for.
  // Both `null` is fine — pillar collapses to neutral.
  setsCompleted?: number | null;
  setsPlanned?: number | null;
  exercisesCompleted?: number | null;
  exercisesPlanned?: number | null;
  // HR data from Apple Health. Zones in minutes (Z1..Z5). hrAvg/hrMax
  // both optional — when available they sharpen the effort pillar.
  hrAvg?: number | null;
  hrMax?: number | null;
  hrZoneMinutes?: [number, number, number, number, number] | null;
  // Optional self-reported intensity (1-5 from feedback form).
  selfIntensity?: number | null;
}

export interface TrainingScorePillars {
  effort: number;       // 0-40
  volume: number;       // 0-25
  duration: number;     // 0-20
  consistency: number;  // 0-15
}

export interface TrainingScore {
  score: number;                       // 0-100
  rating: 'Crushed' | 'Solid' | 'Light' | 'Below';
  pillars: TrainingScorePillars;
  insights: string[];
  /** Which pillars had real data — UI can de-emphasize neutral ones. */
  signalsPresent: number;
  signalsTotal: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Z3+ minutes ÷ total HR-tracked minutes. Higher = more effort. */
function effortFromZones(zones: [number, number, number, number, number] | null | undefined): number | null {
  if (!zones) return null;
  const total = zones.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const z3plus = zones[2] + zones[3] + zones[4];
  return z3plus / total;
}

/** Score the effort pillar (0-40). Different defaults per focus kind. */
function scoreEffort(input: TrainingScoreInput): { points: number; insight?: string; present: boolean } {
  const zoneRatio = effortFromZones(input.hrZoneMinutes);
  // Mobility/recovery aren't supposed to be high-effort — being in Z1
  // is GOOD. Score these days against a fixed 0.7 of full effort credit
  // so they always read as "earned".
  if (input.focusKind === 'mobility' || input.focusKind === 'recovery') {
    return { points: Math.round(40 * 0.7), present: true };
  }
  if (zoneRatio != null) {
    // Lift: target 35-65% Z3+ (compound lifts spike HR but most rest periods are Z1-2).
    // Cardio: target 50-80% Z3+ (Z2 = Z3 in our rough mapping when not zone-aware).
    // Mixed: blend.
    let target = 0.50;
    if (input.focusKind === 'lift') target = 0.45;
    else if (input.focusKind === 'cardio') target = 0.65;
    else if (input.focusKind === 'mixed') target = 0.55;
    const ratio = zoneRatio / target;
    let points: number;
    if (ratio >= 1.10) points = 40;
    else if (ratio >= 0.90) points = 36;
    else if (ratio >= 0.70) points = 28;
    else if (ratio >= 0.50) points = 18;
    else points = 8;
    let insight: string | undefined;
    if (ratio < 0.50) insight = 'Mostly Z1–Z2 — light effort session';
    else if (ratio >= 1.10) insight = 'High-effort session — solid work';
    return { points, insight, present: true };
  }
  // No HR data — fall back to self-reported intensity (1-5).
  if (input.selfIntensity != null) {
    const v = clamp(input.selfIntensity, 1, 5);
    const points = Math.round((v / 5) * 40);
    return { points, present: true };
  }
  // Neutral fallback. Don't punish for missing data.
  return { points: Math.round(40 * 0.6), present: false };
}

/** Score volume pillar (0-25). Lifts care about sets, cardio cares about distance/time (we proxy via duration). */
function scoreVolume(input: TrainingScoreInput): { points: number; insight?: string; present: boolean } {
  if (input.focusKind === 'cardio') {
    // Cardio "volume" is duration credit — earned by actually putting in time.
    // We give 18 baseline + up to 7 for stretching past estimate.
    if (!input.actualDurationSec || input.actualDurationSec <= 0) {
      return { points: Math.round(25 * 0.6), present: false };
    }
    const est = input.estimatedDurationSec ?? input.actualDurationSec;
    const ratio = input.actualDurationSec / Math.max(1, est);
    let points: number;
    if (ratio >= 1.0) points = 25;
    else if (ratio >= 0.85) points = 22;
    else if (ratio >= 0.70) points = 17;
    else if (ratio >= 0.50) points = 11;
    else points = 4;
    return { points, present: true };
  }
  // Lift / mixed: sets completed vs planned.
  if (input.setsCompleted == null || input.setsPlanned == null || input.setsPlanned <= 0) {
    return { points: Math.round(25 * 0.6), present: false };
  }
  const ratio = input.setsCompleted / input.setsPlanned;
  let points: number;
  let insight: string | undefined;
  if (ratio >= 1.0) points = 25;
  else if (ratio >= 0.85) points = 21;
  else if (ratio >= 0.70) points = 16;
  else if (ratio >= 0.50) { points = 10; insight = 'Cut workout short on sets'; }
  else { points = 4; insight = 'Most planned sets skipped'; }
  return { points, insight, present: true };
}

/** Duration pillar (0-20) — actual / estimated. Going over isn't punished. */
function scoreDuration(input: TrainingScoreInput): { points: number; insight?: string; present: boolean } {
  if (!input.actualDurationSec || input.actualDurationSec <= 0) {
    return { points: Math.round(20 * 0.6), present: false };
  }
  if (!input.estimatedDurationSec || input.estimatedDurationSec <= 0) {
    // No estimate to compare to — give full credit for putting in any time at all,
    // scaled by absolute minutes (10min → 50% credit, 30min → 80%, 45min+ → full).
    const min = input.actualDurationSec / 60;
    let points: number;
    if (min >= 45) points = 20;
    else if (min >= 30) points = 16;
    else if (min >= 15) points = 12;
    else if (min >= 5) points = 6;
    else points = 2;
    return { points, present: true };
  }
  const ratio = input.actualDurationSec / input.estimatedDurationSec;
  let points: number;
  let insight: string | undefined;
  if (ratio >= 0.85 && ratio <= 1.20) points = 20;
  else if (ratio >= 0.70) points = 16;
  else if (ratio >= 0.55) points = 11;
  else if (ratio >= 0.40) { points = 6; insight = 'Cut session short'; }
  else { points = 2; insight = 'Very short session'; }
  return { points, insight, present: true };
}

/** Consistency pillar (0-15) — exercises completed vs planned. */
function scoreConsistency(input: TrainingScoreInput): { points: number; insight?: string; present: boolean } {
  if (input.exercisesCompleted == null || input.exercisesPlanned == null || input.exercisesPlanned <= 0) {
    return { points: Math.round(15 * 0.6), present: false };
  }
  const ratio = input.exercisesCompleted / input.exercisesPlanned;
  let points: number;
  let insight: string | undefined;
  if (ratio >= 1.0) points = 15;
  else if (ratio >= 0.85) points = 13;
  else if (ratio >= 0.70) points = 10;
  else if (ratio >= 0.50) { points = 6; insight = 'Skipped some planned exercises'; }
  else { points = 2; insight = 'Most exercises skipped'; }
  return { points, insight, present: true };
}

export function computeTrainingScore(input: TrainingScoreInput): TrainingScore {
  const e = scoreEffort(input);
  const v = scoreVolume(input);
  const d = scoreDuration(input);
  const c = scoreConsistency(input);

  const total = clamp(e.points + v.points + d.points + c.points, 0, 100);
  const rating: TrainingScore['rating'] =
    total >= 85 ? 'Crushed' :
    total >= 65 ? 'Solid' :
    total >= 45 ? 'Light' : 'Below';

  const insights: string[] = [];
  for (const p of [e, v, d, c]) if (p.insight) insights.push(p.insight);

  const signalsPresent = [e, v, d, c].filter(p => p.present).length;

  return {
    score: Math.round(total),
    rating,
    pillars: {
      effort: e.points,
      volume: v.points,
      duration: d.points,
      consistency: c.points,
    },
    insights: insights.slice(0, 4),
    signalsPresent,
    signalsTotal: 4,
  };
}

/** Convenience: derive focusKind from a workout focus string. */
export function focusKindFromName(focus: string | null | undefined): TrainingScoreFocusKind {
  const f = (focus || '').toLowerCase();
  if (/recover|rest/.test(f)) return 'recovery';
  if (/mobil|stretch|yoga|flow/.test(f)) return 'mobility';
  if (/cardio|zone|interval|sprint|tempo|run|bike|swim|row/.test(f)) {
    if (/\+/.test(f)) return 'mixed'; // "Push + Cardio" etc.
    return 'cardio';
  }
  if (/\+\s*cardio/.test(f)) return 'mixed';
  return 'lift';
}
