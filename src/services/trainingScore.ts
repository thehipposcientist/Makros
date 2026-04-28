// Training score — 0-100 measure of "how well did this workout match its
// intended stimulus?".
//
// The score is archetype-aware: a strength lift, a hypertrophy lift, a
// Zone 2 cardio, a HIIT day, and a mobility flow are scored differently
// because they're trying to do different things. A heavy 5x3 squat that
// barely moves the heart rate is GOOD strength work; the same HR profile
// in a HIIT session would be a failure. The old "single 40/25/20/15
// cardio-biased formula" produced bad incentives — this replaces it.
//
// Design rules:
//   - Pure function. No DB, no async.
//   - Score still returns max 100. Rating buckets unchanged.
//   - Pillar weights live in a config map keyed by archetype, with light
//     modifiers per goal. Easy to tune without touching the main fn.
//   - Missing data degrades gracefully. The HR / zone pillar weight is
//     redistributed into duration + completion when HR data is absent.
//   - Backwards compat: the legacy `focusKind: 'lift' | 'cardio' | ...`
//     input still works — we map it to a canonical archetype. The legacy
//     `pillars: { effort, volume, duration, consistency }` is still
//     emitted (mapped from the new pillar set) so existing UI keeps
//     rendering.

// ─── Public types ───────────────────────────────────────────────────────────

/** Canonical training archetypes. The scoring config is keyed off this. */
export type TrainingScoreArchetype =
  | 'strength_lift'
  | 'hypertrophy_lift'
  | 'mixed_lift'
  | 'zone2_cardio'
  | 'interval_cardio'
  | 'general_cardio'
  | 'athletic_conditioning'
  | 'mobility_recovery';

/** Legacy focus-kind, kept for backward-compatible callers. */
export type TrainingScoreFocusKind = 'lift' | 'cardio' | 'mixed' | 'mobility' | 'recovery';

export interface TrainingScoreInput {
  // ── Workout type ──
  /** Preferred — passed by the active session. */
  archetype?: TrainingScoreArchetype;
  /** Legacy fallback when archetype isn't known. We derive from this. */
  focusKind?: TrainingScoreFocusKind;
  /** Optional cardio shape — distinguishes Z2 / intervals / tempo when
   *  the caller only knows it's "cardio". Used to refine the archetype. */
  cardioVariant?: 'zone2' | 'intervals' | 'tempo' | 'general';

  // ── User context ──
  /** App goal id (muscle_gain / fat_loss / body_recomp / endurance /
   *  athletic_performance / general_health / strength / longevity / …).
   *  Aliases are normalized inside _resolveGoal. Optional. */
  goal?: string | null;

  // ── Duration ──
  actualDurationSec: number;
  estimatedDurationSec?: number | null;

  // ── Volume + completion ──
  setsCompleted?: number | null;
  setsPlanned?: number | null;
  exercisesCompleted?: number | null;
  exercisesPlanned?: number | null;

  // ── Heart rate ──
  hrAvg?: number | null;
  hrMax?: number | null;
  /** [Z1, Z2, Z3, Z4, Z5] in minutes. */
  hrZoneMinutes?: [number, number, number, number, number] | null;

  // ── Subjective ──
  /** 1-5 self-rated intensity from the post-workout feedback form. */
  selfIntensity?: number | null;

  // ── Progression signal (optional) ──
  /** True when the user beat their last session's load or reps on at
   *  least one set. Drives the progression pillar — when missing, that
   *  pillar collapses to neutral and its weight redistributes. */
  progressionAchieved?: boolean | null;
  /** True when the user hit the prescribed target reps on the prescribed
   *  load at least once. Also feeds the progression pillar. */
  hitTargetLoad?: boolean | null;

  // ── Interval-specific ──
  /** For HIIT/intervals: completed intervals ÷ planned intervals. Falls
   *  back to setsCompleted/setsPlanned when not provided. */
  intervalsCompleted?: number | null;
  intervalsPlanned?: number | null;
}

/** Full pillar breakdown — the UI can iterate this dynamically and show
 *  per-archetype max values (no longer hard-coded to 40/25/20/15). */
export interface TrainingScorePillarBreakdown {
  key: TrainingScorePillarKey;
  label: string;
  value: number;
  max: number;
  /** True when the underlying signal was present. UI can de-emphasize
   *  pillars whose weight got redistributed. */
  present: boolean;
}

/** Legacy pillar shape, retained so existing UI renders unchanged.
 *  - `effort` ← stimulus pillar (renamed for the legacy field name)
 *  - `volume` ← volume pillar
 *  - `duration` ← duration pillar
 *  - `consistency` ← consistency pillar
 * For archetypes whose effective max isn't 40/25/20/15 we proportionally
 * scale into those legacy slots so the existing UI's denominator labels
 * (`E xx/40`) still read accurately. */
export interface TrainingScorePillars {
  effort: number;
  volume: number;
  duration: number;
  consistency: number;
}

export type TrainingScorePillarKey =
  | 'stimulus'
  | 'volume'
  | 'duration'
  | 'consistency'
  | 'progression'
  | 'zoneCompliance'
  | 'intervalIntensity'
  | 'workRestCompletion'
  | 'movementCompletion'
  | 'lowIntensityCompliance'
  | 'hr';

export interface TrainingScore {
  score: number;
  rating: 'Crushed' | 'Solid' | 'Light' | 'Below';
  archetype: TrainingScoreArchetype;
  pillars: TrainingScorePillars;
  pillarBreakdown: TrainingScorePillarBreakdown[];
  insights: string[];
  signalsPresent: number;
  signalsTotal: number;
}

// ─── Pillar weight config — keyed by archetype ───────────────────────────────
//
// Each archetype's weights MUST sum to 100. Missing-signal redistribution
// happens at compute time (not here) — the config just states the intent.

type PillarWeights = Partial<Record<TrainingScorePillarKey, number>>;

const ARCHETYPE_WEIGHTS: Record<TrainingScoreArchetype, PillarWeights> = {
  // Heavy lift — load + technique + completion. HR is ambient.
  strength_lift: {
    stimulus: 30,
    volume: 25,
    consistency: 15,
    duration: 10,
    progression: 15,
    hr: 5,
  },
  // Bodybuilding-style — total volume + every-rep completion + steady
  // progression. HR irrelevant.
  hypertrophy_lift: {
    stimulus: 25,
    volume: 35,
    consistency: 20,
    duration: 10,
    progression: 10,
  },
  // Lift + cardio finisher — balanced pillar set. HR matters more here.
  mixed_lift: {
    stimulus: 25,
    volume: 25,
    consistency: 20,
    duration: 15,
    hr: 15,
  },
  // Zone 2 — staying in the right zone is the whole point. Z3+ HURTS.
  zone2_cardio: {
    zoneCompliance: 40,
    duration: 35,
    consistency: 15,
    progression: 10,
  },
  // HIIT — intervals must hit Z3+, work/rest must complete.
  interval_cardio: {
    intervalIntensity: 40,
    workRestCompletion: 25,
    duration: 20,
    consistency: 10,
    progression: 5,
  },
  // Tempo / general cardio — HR + duration + completion balance.
  general_cardio: {
    stimulus: 25,
    duration: 30,
    consistency: 15,
    hr: 20,
    progression: 10,
  },
  // Conditioning / metcon / athletic mix — density matters most.
  athletic_conditioning: {
    intervalIntensity: 30,
    duration: 25,
    workRestCompletion: 20,
    consistency: 15,
    progression: 10,
  },
  // Recovery / mobility — was the user there for the full session and
  // staying low intensity? No fake fixed effort score.
  mobility_recovery: {
    duration: 40,
    movementCompletion: 35,
    consistency: 15,
    lowIntensityCompliance: 10,
  },
};

// ─── Goal modifiers — lightweight nudges ────────────────────────────────────
//
// Each goal can shift up to ~10 points across pillars. The same key can't
// cumulatively exceed its archetype's max (clamped at compute time).

type GoalModifier = Partial<Record<TrainingScorePillarKey, number>>;

const GOAL_MODIFIERS: Record<string, GoalModifier> = {
  muscle_gain:        { volume:  +5, progression: +3, hr: -3 },
  build_muscle:       { volume:  +5, progression: +3, hr: -3 },
  strength:           { stimulus: +5, progression: +5, hr: -3 },
  build_strength:     { stimulus: +5, progression: +5, hr: -3 },
  fat_loss:           { duration: +3, hr: +5, intervalIntensity: +3 },
  lose_fat:           { duration: +3, hr: +5, intervalIntensity: +3 },
  endurance:          { duration: +5, zoneCompliance: +5, hr: -2 },
  athletic_performance: { intervalIntensity: +5, stimulus: +3, progression: +3 },
  body_recomp:        { volume: +2, consistency: +2, hr: +2 },
  general_health:     { consistency: +5, zoneCompliance: +3, lowIntensityCompliance: +3 },
  longevity:          { consistency: +5, zoneCompliance: +3, lowIntensityCompliance: +3 },
  toning:             { duration: +2, hr: +3 },
  maintain:           { consistency: +3 },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Z3+ minutes ÷ total HR-tracked minutes. Higher = more high-intensity. */
function z3PlusRatio(zones: [number, number, number, number, number] | null | undefined): number | null {
  if (!zones) return null;
  const total = zones.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  return (zones[2] + zones[3] + zones[4]) / total;
}

/** Z1+Z2 minutes ÷ total. Used for Z2 compliance + low-intensity checks. */
function z1z2Ratio(zones: [number, number, number, number, number] | null | undefined): number | null {
  if (!zones) return null;
  const total = zones.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  return (zones[0] + zones[1]) / total;
}

/** Pull a single number out of a 0..1 ratio applied to the pillar's max. */
const ratioPoints = (ratio: number, max: number) => Math.round(clamp(ratio, 0, 1) * max);

function _resolveGoal(goal: string | null | undefined): GoalModifier {
  if (!goal) return {};
  const g = String(goal).toLowerCase().trim();
  return GOAL_MODIFIERS[g] ?? {};
}

/** Apply goal modifier to archetype weights without exceeding the
 *  archetype's intent — caps at +50% of original weight per pillar so
 *  goals can nudge but not flip the formula. Result then gets normalized
 *  back to a 100-point sum. */
function _applyGoalModifier(weights: PillarWeights, modifier: GoalModifier): PillarWeights {
  const keys = new Set<TrainingScorePillarKey>([
    ...(Object.keys(weights) as TrainingScorePillarKey[]),
    ...(Object.keys(modifier) as TrainingScorePillarKey[]),
  ]);
  const adjusted: PillarWeights = {};
  let total = 0;
  for (const k of keys) {
    const base = weights[k] ?? 0;
    const delta = modifier[k] ?? 0;
    // Don't introduce a brand new pillar via modifier alone — the
    // archetype must opt into it. (Prevents e.g. muscle_gain adding
    // intervalIntensity weight to a strength_lift.)
    if (base <= 0) continue;
    const v = Math.max(0, base + delta);
    adjusted[k] = v;
    total += v;
  }
  if (total <= 0) return weights;
  const factor = 100 / total;
  for (const k of Object.keys(adjusted) as TrainingScorePillarKey[]) {
    adjusted[k] = +(((adjusted[k] ?? 0) * factor).toFixed(2));
  }
  return adjusted;
}

// ─── Archetype derivation ───────────────────────────────────────────────────

/** Convenience: derive an archetype from a workout focus + stimulus
 *  string. Mirrors the old `focusKindFromName` shape but returns the
 *  richer archetype enum. */
export function archetypeFromWorkout(
  focus: string | null | undefined,
  stimulus?: string | null,
  cardioVariant?: 'zone2' | 'intervals' | 'tempo' | 'general' | null,
): TrainingScoreArchetype {
  const f = (focus || '').toLowerCase();
  const s = (stimulus || '').toLowerCase();
  const cv = cardioVariant ?? null;

  // Mobility / recovery — earliest exit so 'recovery + cardio' label
  // doesn't leak into a cardio archetype.
  if (s === 'recovery' || s === 'mobility' || s === 'stretch') return 'mobility_recovery';
  if (/recover|rest|mobil|stretch|yoga|flow/.test(f)) return 'mobility_recovery';

  // Cardio / conditioning
  const isCardio = s === 'conditioning' || /cardio|zone|interval|sprint|tempo|run|bike|swim|row|hiit/.test(f);
  const isMixed = /\+/.test(f);

  if (isCardio && !isMixed) {
    if (cv === 'zone2' || /\bzone\s*2\b|\bz2\b/.test(f)) return 'zone2_cardio';
    if (cv === 'intervals' || /interval|hiit|sprint/.test(f)) return 'interval_cardio';
    if (/condition|metcon|circuit|amrap/.test(f)) return 'athletic_conditioning';
    return 'general_cardio';
  }

  if (isMixed) return 'mixed_lift';

  // Lifting fallthrough
  if (s === 'strength' || s === 'power') return 'strength_lift';
  if (s === 'volume') return 'hypertrophy_lift';
  // hypertrophy, mixed, anything else → hypertrophy default for lifting
  return 'hypertrophy_lift';
}

/** Legacy adapter: focusKind → archetype. Used when the caller hasn't
 *  upgraded to passing `archetype` directly. */
function _legacyFocusKindToArchetype(
  fk: TrainingScoreFocusKind,
  cardioVariant: TrainingScoreInput['cardioVariant'],
): TrainingScoreArchetype {
  if (fk === 'lift') return 'hypertrophy_lift';
  if (fk === 'mixed') return 'mixed_lift';
  if (fk === 'mobility' || fk === 'recovery') return 'mobility_recovery';
  // cardio
  if (cardioVariant === 'zone2') return 'zone2_cardio';
  if (cardioVariant === 'intervals') return 'interval_cardio';
  return 'general_cardio';
}

// ─── Pillar scorers ─────────────────────────────────────────────────────────
//
// Each scorer takes the input + the pillar's effective max (after weight
// distribution) and returns { points, present, insight? }. `present` is
// false when the underlying signal is missing — the engine then strips
// the pillar and redistributes its weight.

type PillarResult = { points: number; present: boolean; insight?: string };

function scoreStimulus(input: TrainingScoreInput, archetype: TrainingScoreArchetype, max: number): PillarResult {
  // Lifting: stimulus = "did you complete the prescribed work"?
  // Heavily weights set / target completion. HR isn't part of stimulus
  // for lifts.
  if (archetype === 'strength_lift' || archetype === 'hypertrophy_lift') {
    const setsRatio = (input.setsPlanned && input.setsPlanned > 0)
      ? clamp((input.setsCompleted ?? 0) / input.setsPlanned, 0, 1.1)
      : null;
    const exRatio = (input.exercisesPlanned && input.exercisesPlanned > 0)
      ? clamp((input.exercisesCompleted ?? 0) / input.exercisesPlanned, 0, 1.1)
      : null;
    const targetBonus = input.hitTargetLoad ? 0.1 : 0;
    if (setsRatio == null && exRatio == null) {
      return { points: Math.round(max * 0.6), present: false };
    }
    const blended = ((setsRatio ?? 0.7) + (exRatio ?? 0.7)) / 2 + targetBonus;
    return {
      points: ratioPoints(blended, max),
      present: true,
      insight: blended < 0.6 ? 'Stimulus light — prescribed work not fully completed' : undefined,
    };
  }

  // Mixed lift: blend completion + light HR boost.
  if (archetype === 'mixed_lift') {
    const setsRatio = (input.setsPlanned && input.setsPlanned > 0)
      ? clamp((input.setsCompleted ?? 0) / input.setsPlanned, 0, 1.1)
      : null;
    const exRatio = (input.exercisesPlanned && input.exercisesPlanned > 0)
      ? clamp((input.exercisesCompleted ?? 0) / input.exercisesPlanned, 0, 1.1)
      : null;
    if (setsRatio == null && exRatio == null) {
      return { points: Math.round(max * 0.6), present: false };
    }
    const blended = ((setsRatio ?? 0.7) + (exRatio ?? 0.7)) / 2;
    return { points: ratioPoints(blended, max), present: true };
  }

  // Cardio (general / tempo): stimulus = sustained HR effort. Use Z3+
  // when available, fall back to self-intensity.
  const z3p = z3PlusRatio(input.hrZoneMinutes);
  if (z3p != null) {
    // General cardio target ~50% Z3+; full credit for hitting target.
    const ratio = z3p / 0.50;
    if (ratio >= 1.0) return { points: max, present: true, insight: undefined };
    if (ratio >= 0.7) return { points: Math.round(max * 0.85), present: true };
    if (ratio >= 0.5) return { points: Math.round(max * 0.65), present: true };
    if (ratio >= 0.3) return { points: Math.round(max * 0.45), present: true, insight: 'Light effort — limited Z3+ time' };
    return { points: Math.round(max * 0.25), present: true, insight: 'Mostly Z1–Z2 — too easy for the intent' };
  }
  if (input.selfIntensity != null) {
    return { points: ratioPoints(clamp(input.selfIntensity, 1, 5) / 5, max), present: true };
  }
  return { points: Math.round(max * 0.6), present: false };
}

function scoreVolume(input: TrainingScoreInput, max: number): PillarResult {
  if (input.setsCompleted == null || input.setsPlanned == null || input.setsPlanned <= 0) {
    return { points: Math.round(max * 0.6), present: false };
  }
  const ratio = input.setsCompleted / input.setsPlanned;
  let insight: string | undefined;
  if (ratio < 0.5) insight = 'Most planned sets skipped';
  else if (ratio < 0.7) insight = 'Cut workout short on sets';
  // Going 110%+ doesn't get extra credit — capped at 100% of the prescribed work.
  return { points: ratioPoints(ratio, max), present: true, insight };
}

function scoreDuration(input: TrainingScoreInput, archetype: TrainingScoreArchetype, max: number): PillarResult {
  if (!input.actualDurationSec || input.actualDurationSec <= 0) {
    return { points: Math.round(max * 0.6), present: false };
  }
  if (!input.estimatedDurationSec || input.estimatedDurationSec <= 0) {
    const min = input.actualDurationSec / 60;
    if (min >= 45) return { points: max, present: true };
    if (min >= 30) return { points: Math.round(max * 0.85), present: true };
    if (min >= 15) return { points: Math.round(max * 0.6), present: true };
    if (min >= 5)  return { points: Math.round(max * 0.3), present: true };
    return { points: Math.round(max * 0.1), present: true };
  }
  const ratio = input.actualDurationSec / input.estimatedDurationSec;
  // Strength-style archetypes don't penalize going OVER (more rest is
  // fine if duration is reasonable).
  const overTolerance = archetype === 'strength_lift' ? 1.40 : 1.20;
  let insight: string | undefined;
  let pts: number;
  if (ratio >= 0.85 && ratio <= overTolerance) pts = max;
  else if (ratio > overTolerance) pts = Math.round(max * 0.85);
  else if (ratio >= 0.70) pts = Math.round(max * 0.80);
  else if (ratio >= 0.55) pts = Math.round(max * 0.55);
  else if (ratio >= 0.40) { pts = Math.round(max * 0.30); insight = 'Cut session short'; }
  else { pts = Math.round(max * 0.10); insight = 'Very short session'; }
  return { points: pts, present: true, insight };
}

function scoreConsistency(input: TrainingScoreInput, max: number): PillarResult {
  if (input.exercisesCompleted == null || input.exercisesPlanned == null || input.exercisesPlanned <= 0) {
    return { points: Math.round(max * 0.6), present: false };
  }
  const ratio = input.exercisesCompleted / input.exercisesPlanned;
  let insight: string | undefined;
  if (ratio < 0.5) insight = 'Most planned exercises skipped';
  else if (ratio < 0.7) insight = 'Skipped some planned exercises';
  return { points: ratioPoints(ratio, max), present: true, insight };
}

function scoreProgression(input: TrainingScoreInput, max: number): PillarResult {
  // Both signals optional — when both null, neutral fallback.
  if (input.progressionAchieved == null && input.hitTargetLoad == null) {
    return { points: Math.round(max * 0.6), present: false };
  }
  let pts = 0;
  if (input.progressionAchieved) pts += Math.round(max * 0.6);
  if (input.hitTargetLoad) pts += Math.round(max * 0.4);
  return {
    points: clamp(pts, 0, max),
    present: true,
    insight: pts === 0 ? 'No progression vs last session' : undefined,
  };
}

function scoreZoneCompliance(input: TrainingScoreInput, max: number): PillarResult {
  // Z2 cardio: target 70%+ of time in Z1+Z2. Going into Z3+ HURTS — the
  // user is overshooting the prescribed easy-aerobic stimulus.
  const lowRatio = z1z2Ratio(input.hrZoneMinutes);
  if (lowRatio == null) {
    return { points: Math.round(max * 0.6), present: false };
  }
  let insight: string | undefined;
  let pts: number;
  if (lowRatio >= 0.85) pts = max;
  else if (lowRatio >= 0.75) pts = Math.round(max * 0.85);
  else if (lowRatio >= 0.65) pts = Math.round(max * 0.70);
  else if (lowRatio >= 0.50) { pts = Math.round(max * 0.50); insight = 'Drifted out of Zone 2 — keep effort easy'; }
  else { pts = Math.round(max * 0.30); insight = 'Too much Z3+ — this was a tempo workout, not Zone 2'; }
  return { points: pts, present: true, insight };
}

function scoreIntervalIntensity(input: TrainingScoreInput, max: number): PillarResult {
  // HIIT / intervals: reward Z3-Z5 time. Target ≥45% of total HR-tracked
  // time in high zones.
  const z3p = z3PlusRatio(input.hrZoneMinutes);
  if (z3p == null) {
    // No HR — fall back to interval completion ratio.
    if (input.intervalsPlanned && input.intervalsPlanned > 0 && input.intervalsCompleted != null) {
      const ratio = input.intervalsCompleted / input.intervalsPlanned;
      return { points: ratioPoints(ratio, max), present: true };
    }
    if (input.selfIntensity != null) {
      return { points: ratioPoints(clamp(input.selfIntensity, 1, 5) / 5, max), present: true };
    }
    return { points: Math.round(max * 0.6), present: false };
  }
  const ratio = z3p / 0.45;
  if (ratio >= 1.10) return { points: max, present: true };
  if (ratio >= 0.90) return { points: Math.round(max * 0.90), present: true };
  if (ratio >= 0.70) return { points: Math.round(max * 0.70), present: true };
  if (ratio >= 0.50) return { points: Math.round(max * 0.50), present: true, insight: 'Intervals too easy — push harder in work bouts' };
  return { points: Math.round(max * 0.30), present: true, insight: 'Mostly Z1–Z2 — this was supposed to be a HIIT session' };
}

function scoreWorkRestCompletion(input: TrainingScoreInput, max: number): PillarResult {
  // Did the user actually complete the planned interval count?
  if (input.intervalsPlanned && input.intervalsPlanned > 0 && input.intervalsCompleted != null) {
    return { points: ratioPoints(input.intervalsCompleted / input.intervalsPlanned, max), present: true };
  }
  // Fallback: treat sets as intervals (common when intervals are logged
  // as sets in HIIT sessions).
  if (input.setsPlanned && input.setsPlanned > 0 && input.setsCompleted != null) {
    return { points: ratioPoints(input.setsCompleted / input.setsPlanned, max), present: true };
  }
  return { points: Math.round(max * 0.6), present: false };
}

function scoreMovementCompletion(input: TrainingScoreInput, max: number): PillarResult {
  // Mobility/recovery: how many of the planned movements did the user
  // actually go through. We use exercises as the unit.
  if (input.exercisesPlanned && input.exercisesPlanned > 0 && input.exercisesCompleted != null) {
    return { points: ratioPoints(input.exercisesCompleted / input.exercisesPlanned, max), present: true };
  }
  return { points: Math.round(max * 0.6), present: false };
}

function scoreLowIntensityCompliance(input: TrainingScoreInput, max: number): PillarResult {
  // Mobility/recovery: stay in Z1+Z2. High HR = the user didn't actually
  // recover. When HR data is missing, give neutral credit (the user
  // probably stayed easy).
  const lowRatio = z1z2Ratio(input.hrZoneMinutes);
  if (lowRatio == null) {
    return { points: Math.round(max * 0.7), present: false };
  }
  if (lowRatio >= 0.90) return { points: max, present: true };
  if (lowRatio >= 0.75) return { points: Math.round(max * 0.85), present: true };
  if (lowRatio >= 0.55) return { points: Math.round(max * 0.60), present: true };
  return { points: Math.round(max * 0.30), present: true, insight: 'Recovery / mobility shouldn\'t spike HR — kept it too high' };
}

function scoreHr(input: TrainingScoreInput, max: number): PillarResult {
  // Generic HR bonus — used by mixed_lift / general_cardio. Higher HR
  // engagement = more credit. Maxes at ~50% Z3+ (so 70% of session in
  // Z3+ doesn't unfairly outscore a focused training day).
  const z3p = z3PlusRatio(input.hrZoneMinutes);
  if (z3p == null) {
    if (input.selfIntensity != null) {
      return { points: ratioPoints(clamp(input.selfIntensity, 1, 5) / 5, max), present: true };
    }
    return { points: Math.round(max * 0.6), present: false };
  }
  const ratio = z3p / 0.50;
  return { points: ratioPoints(ratio, max), present: true };
}

// ─── Main entry point ───────────────────────────────────────────────────────

const PILLAR_LABELS: Record<TrainingScorePillarKey, string> = {
  stimulus: 'Stimulus',
  volume: 'Volume',
  duration: 'Duration',
  consistency: 'Consistency',
  progression: 'Progression',
  zoneCompliance: 'Zone 2 Compliance',
  intervalIntensity: 'Interval Intensity',
  workRestCompletion: 'Work/Rest Completion',
  movementCompletion: 'Movement Completion',
  lowIntensityCompliance: 'Low-Intensity Compliance',
  hr: 'Heart Rate',
};

export function computeTrainingScore(input: TrainingScoreInput): TrainingScore {
  // 1. Resolve archetype (preferred → legacy fallback → default).
  const archetype: TrainingScoreArchetype =
    input.archetype
    ?? (input.focusKind ? _legacyFocusKindToArchetype(input.focusKind, input.cardioVariant) : 'hypertrophy_lift');

  // 2. Apply goal modifier to base weights, normalize to 100.
  const baseWeights = ARCHETYPE_WEIGHTS[archetype];
  const goalMod = _resolveGoal(input.goal);
  const weights = _applyGoalModifier(baseWeights, goalMod);

  // 3. Score each active pillar.
  type Scored = { key: TrainingScorePillarKey; max: number; result: PillarResult };
  const scored: Scored[] = [];
  for (const [key, max] of Object.entries(weights) as Array<[TrainingScorePillarKey, number]>) {
    if (!max || max <= 0) continue;
    let r: PillarResult;
    switch (key) {
      case 'stimulus':              r = scoreStimulus(input, archetype, max); break;
      case 'volume':                r = scoreVolume(input, max); break;
      case 'duration':              r = scoreDuration(input, archetype, max); break;
      case 'consistency':           r = scoreConsistency(input, max); break;
      case 'progression':           r = scoreProgression(input, max); break;
      case 'zoneCompliance':        r = scoreZoneCompliance(input, max); break;
      case 'intervalIntensity':     r = scoreIntervalIntensity(input, max); break;
      case 'workRestCompletion':    r = scoreWorkRestCompletion(input, max); break;
      case 'movementCompletion':    r = scoreMovementCompletion(input, max); break;
      case 'lowIntensityCompliance':r = scoreLowIntensityCompliance(input, max); break;
      case 'hr':                    r = scoreHr(input, max); break;
      default:                      r = { points: 0, present: false }; break;
    }
    scored.push({ key, max, result: r });
  }

  // 4. Missing-signal redistribution. Pillars whose signal wasn't
  //    present (e.g. HR missing) collapse to NEUTRAL and their weight
  //    is redistributed proportionally onto present pillars. We avoid
  //    inflating individual pillars beyond 1.5x their original max so
  //    a single signal never dominates the score.
  const presentPillars = scored.filter(s => s.result.present);
  const absentPillars  = scored.filter(s => !s.result.present);
  const totalAbsentMax = absentPillars.reduce((sum, s) => sum + s.max, 0);
  const totalPresentMax = presentPillars.reduce((sum, s) => sum + s.max, 0);

  let total = 0;
  const breakdown: TrainingScorePillarBreakdown[] = [];
  if (totalAbsentMax > 0 && totalPresentMax > 0) {
    // Redistribute the absent pillars' weight onto the present ones,
    // pro rata, capped at +50% of original max each.
    const factor = (totalPresentMax + totalAbsentMax) / totalPresentMax;
    const cappedFactor = Math.min(factor, 1.5);
    for (const s of presentPillars) {
      const scaledMax = s.max * cappedFactor;
      const scaledPoints = (s.result.points / s.max) * scaledMax;
      total += scaledPoints;
      breakdown.push({
        key: s.key,
        label: PILLAR_LABELS[s.key],
        value: Math.round(scaledPoints),
        max: Math.round(scaledMax),
        present: true,
      });
    }
    // Absent pillars contribute 0 (their weight is on the present ones).
    for (const s of absentPillars) {
      breakdown.push({
        key: s.key,
        label: PILLAR_LABELS[s.key],
        value: 0,
        max: 0,
        present: false,
      });
    }
  } else {
    // Either everything's present, or everything's absent (rare). Use
    // raw points — absent pillars already returned a 60% neutral.
    for (const s of scored) {
      total += s.result.points;
      breakdown.push({
        key: s.key,
        label: PILLAR_LABELS[s.key],
        value: s.result.points,
        max: s.max,
        present: s.result.present,
      });
    }
  }

  const score = Math.round(clamp(total, 0, 100));
  const rating: TrainingScore['rating'] =
    score >= 85 ? 'Crushed' :
    score >= 65 ? 'Solid' :
    score >= 45 ? 'Light' : 'Below';

  // 5. Insights (max 4) + legacy pillars mapping for backwards-compat UI.
  const insights: string[] = [];
  for (const s of scored) {
    if (s.result.insight) insights.push(s.result.insight);
  }

  // Legacy pillar mapping. UI consumers expect effort/volume/duration/
  // consistency in /40, /25, /20, /15 max respectively. We project the
  // archetype-aware values into those slots so existing rendering keeps
  // working without changes:
  //   - effort = stimulus+hr+intervalIntensity+zoneCompliance combined,
  //              scaled to /40
  //   - volume = volume+workRestCompletion+movementCompletion, scaled /25
  //   - duration = duration, scaled /20
  //   - consistency = consistency+progression+lowIntensityCompliance,
  //                   scaled /15
  const grouped = (keys: TrainingScorePillarKey[]) => {
    const items = breakdown.filter(b => keys.includes(b.key));
    const got = items.reduce((s, b) => s + b.value, 0);
    const max = items.reduce((s, b) => s + b.max, 0);
    return max > 0 ? got / max : 0;
  };
  const pillars: TrainingScorePillars = {
    effort:      Math.round(grouped(['stimulus', 'hr', 'intervalIntensity', 'zoneCompliance']) * 40),
    volume:      Math.round(grouped(['volume', 'workRestCompletion', 'movementCompletion']) * 25),
    duration:    Math.round(grouped(['duration']) * 20),
    consistency: Math.round(grouped(['consistency', 'progression', 'lowIntensityCompliance']) * 15),
  };

  const signalsTotal = scored.length;
  const signalsPresent = presentPillars.length;

  return {
    score,
    rating,
    archetype,
    pillars,
    pillarBreakdown: breakdown,
    insights: insights.slice(0, 4),
    signalsPresent,
    signalsTotal,
  };
}

/** Convenience for legacy callers — derive `focusKind` from a workout
 *  focus + stimulus string. Kept so the existing
 *  `focusKindFromName(workout.focus, workout.stimulus)` call site at
 *  `ActiveWorkoutScreen.tsx:2752` keeps working. */
export function focusKindFromName(focus: string | null | undefined, stimulus?: string | null): TrainingScoreFocusKind {
  if (stimulus) {
    const s = stimulus.toLowerCase();
    if (s === 'recovery') return 'recovery';
    if (s === 'mobility' || s === 'stretch') return 'mobility';
    if (s === 'conditioning' || s === 'cardio') return 'cardio';
    if (s === 'mixed') return 'mixed';
    if (s === 'strength' || s === 'hypertrophy' || s === 'volume' || s === 'power') return 'lift';
  }
  const f = (focus || '').toLowerCase();
  if (/recover|rest/.test(f)) return 'recovery';
  if (/mobil|stretch|yoga|flow/.test(f)) return 'mobility';
  if (/cardio|zone|interval|sprint|tempo|run|bike|swim|row/.test(f)) {
    if (/\+/.test(f)) return 'mixed';
    return 'cardio';
  }
  if (/\+\s*cardio/.test(f)) return 'mixed';
  return 'lift';
}
