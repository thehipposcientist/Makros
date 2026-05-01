// Preparedness / Recovery score — 0-100.
//
// Consumer wellness composite of multiple signals, not a medical score.
// Answers "how ready is the user to train hard today?"
//
// Weighting:
//   - Sleep score            30%  (how last night went)
//   - HRV vs baseline        20%  (autonomic state)
//   - Muscle fatigue         20%  (accumulated load from workouts)
//   - Nutrition adherence    15%  (protein hit + calorie window)
//   - Resting HR vs baseline 10%  (cardio stress marker)
//   - Yesterday's strain      5%  (inverse — very hard day yesterday deducts)
//
// Missing inputs collapse to a neutral 60% of their pillar weight so the
// user never gets punished for not having a signal we couldn't read.

import type { SleepScore } from '../types';
import { clamp, rollingMedian } from './sleepScore';

export interface PreparednessInput {
  sleepScore?: SleepScore | null;
  hrvMs?: number | null;
  hrvHistory?: number[] | null;             // last 14-30 nights
  restingHeartRate?: number | null;
  rhrHistory?: number[] | null;             // last 14-30 days RHR
  muscleFatigueAvg?: number | null;         // 0-1 avg across muscles
  readinessFromBackend?: number | null;     // 0-100 from /workouts/fatigue
  proteinGrams?: number | null;
  proteinTargetGrams?: number | null;
  calorieIntake?: number | null;
  calorieTarget?: number | null;
  yesterdayWorkoutMinutes?: number | null;  // total logged training yesterday
  age?: number | null;
  /** Optional cycle phase — small ±3pt modifier. Menses slight -, ovulation slight +. */
  cyclePhase?: 'menses' | 'follicular' | 'ovulation' | 'luteal' | null;
}

export interface PreparednessPillars {
  sleep: number;         // 0-30
  hrv: number;           // 0-20
  fatigue: number;       // 0-20
  nutrition: number;     // 0-15
  restingHr: number;     // 0-10
  yesterdayStrain: number; // 0-5
  wellness?: number;     // 0-10 optional user-reported readiness context
}

export interface PreparednessResult {
  score: number;
  label: 'Primed' | 'Ready' | 'Moderate' | 'Fatigued' | '—';
  pillars: PreparednessPillars;
  insights: string[];
  /** Concrete, actionable suggestions when a pillar comes back weak.
   *  Surfaced in the readiness card so a poor sleep score isn't just a
   *  flat statement of fact — the user sees what to do about it
   *  ("Train lighter today, dim screens 30 min before bed tonight..."). */
  recommendations: string[];
  missing: string[]; // which inputs were missing (for UI hints)
  /** Number of pillars that received real input data (max 6). UI uses
   *  this to show e.g. "62 · 3/6 signals" so the user understands the
   *  score is partial. */
  signalsPresent: number;
  signalsTotal: number;
  /** Raw sum across pillars before reweighting, and the max possible
   *  given which pillars had real data. score = raw / maxPossible * 100. */
  raw: number;
  maxPossible: number;
}

export function scorePreparedness(input: PreparednessInput): PreparednessResult {
  const insights: string[] = [];
  const missing: string[] = [];
  // Track which pillars received real signal so we can reweight the
  // total against just what's present. Without this, missing inputs
  // collapsed to ~60% neutral and the score floated around 60 forever
  // — a user with no Apple Health saw "Moderate Ready" before logging
  // a single thing. Now: 0/6 signals → no score until at least 2 pillars.
  const present: Record<string, boolean> = {};

  // ── Sleep pillar (30) ─────────────────────────────────────────────────────
  let sleep: number;
  if (input.sleepScore?.score != null) {
    // Map sleep score 0-100 onto 0-30, lightly compressed so 70+ sleep = strong.
    sleep = Math.round((input.sleepScore.score / 100) * 30);
    if (input.sleepScore.score < 55) insights.push('Last night’s sleep was below par');
    present.sleep = true;
  } else {
    sleep = 0;
    missing.push('sleep');
  }

  // ── HRV vs baseline (20) ─────────────────────────────────────────────────
  let hrv: number;
  if (input.hrvMs == null) {
    hrv = 0;
    missing.push('hrv');
  } else {
    present.hrv = true;
    const hist = input.hrvHistory ?? [];
    const baseline = hist.length >= 7 ? rollingMedian(hist) : null;
    if (baseline && baseline > 0) {
      const ratio = input.hrvMs / baseline;
      if (ratio >= 1.10) hrv = 20;
      else if (ratio >= 0.98) hrv = 17;
      else if (ratio >= 0.90) hrv = 13;
      else if (ratio >= 0.80) { hrv = 8; insights.push('HRV below your baseline'); }
      else { hrv = 3; insights.push('HRV well below your baseline'); }
    } else {
      // No baseline yet — use age-adjusted rough guide.
      const ref = ageHrvReference(input.age ?? null);
      const ratio = input.hrvMs / ref;
      if (ratio >= 1.1) hrv = 17;
      else if (ratio >= 0.85) hrv = 13;
      else if (ratio >= 0.65) hrv = 9;
      else hrv = 5;
    }
  }

  // ── Muscle fatigue pillar (20) ───────────────────────────────────────────
  let fatigue: number;
  if (input.readinessFromBackend != null) {
    fatigue = Math.round((input.readinessFromBackend / 100) * 20);
    if (input.readinessFromBackend < 40) insights.push('Accumulated fatigue is high');
    present.fatigue = true;
  } else if (input.muscleFatigueAvg != null) {
    fatigue = Math.round((1 - clamp(input.muscleFatigueAvg, 0, 1)) * 20);
    present.fatigue = true;
  } else {
    fatigue = 0;
    missing.push('fatigue');
  }

  // ── Nutrition pillar (15) ────────────────────────────────────────────────
  let nutrition: number;
  const hasProtein = input.proteinGrams != null && input.proteinTargetGrams != null && input.proteinTargetGrams > 0;
  const hasCalories = input.calorieIntake != null && input.calorieTarget != null && input.calorieTarget > 0;
  if (!hasProtein && !hasCalories) {
    nutrition = 0;
    missing.push('nutrition');
  } else {
    present.nutrition = true;
    let pts = 0;
    // Protein (8 pts): hit at least 85% of target.
    if (hasProtein) {
      const pRatio = input.proteinGrams! / input.proteinTargetGrams!;
      if (pRatio >= 0.95) pts += 8;
      else if (pRatio >= 0.85) pts += 6;
      else if (pRatio >= 0.70) pts += 3;
      else { pts += 1; insights.push('Protein well below target'); }
    } else {
      pts += 5; // neutral partial
    }
    // Calories (7 pts): stay within ±15% of target.
    if (hasCalories) {
      const cRatio = input.calorieIntake! / input.calorieTarget!;
      const dev = Math.abs(cRatio - 1);
      if (dev <= 0.10) pts += 7;
      else if (dev <= 0.20) pts += 5;
      else if (dev <= 0.30) pts += 3;
      else { pts += 1; insights.push('Calories far from target'); }
    } else {
      pts += 4;
    }
    nutrition = clamp(pts, 0, 15);
  }

  // ── Resting HR vs baseline (10) ──────────────────────────────────────────
  let restingHr: number;
  if (input.restingHeartRate == null) {
    restingHr = 0;
    missing.push('rhr');
  } else {
    present.restingHr = true;
    const hist = (input.rhrHistory ?? []).filter((v) => v > 0);
    const base = hist.length >= 7 ? rollingMedian(hist) : null;
    if (base && base > 0) {
      const delta = input.restingHeartRate - base;
      // Elevated RHR (>+5 bpm) signals stress / illness / overreach.
      if (delta <= -3) restingHr = 10;
      else if (delta <= 2) restingHr = 9;
      else if (delta <= 5) restingHr = 6;
      else if (delta <= 8) { restingHr = 3; insights.push(`Resting HR +${Math.round(delta)} above baseline`); }
      else { restingHr = 1; insights.push('Resting HR elevated — rest or hydrate'); }
    } else {
      // No baseline — absolute check (mild)
      if (input.restingHeartRate <= 65) restingHr = 9;
      else if (input.restingHeartRate <= 75) restingHr = 7;
      else restingHr = 5;
    }
  }

  // ── Yesterday strain (5) — inverse modifier ──────────────────────────────
  // Treated as always-present: zero training is a known signal (= max
  // strain credit), not missing data. Don't gate signalsPresent on this.
  let yesterdayStrain: number;
  if (input.yesterdayWorkoutMinutes == null) {
    yesterdayStrain = 5; // assume rested if we have no data
  } else {
    const m = input.yesterdayWorkoutMinutes;
    if (m < 30) yesterdayStrain = 5;
    else if (m < 60) yesterdayStrain = 4;
    else if (m < 90) yesterdayStrain = 3;
    else if (m < 120) yesterdayStrain = 2;
    else { yesterdayStrain = 1; insights.push('Heavy session yesterday — consider lighter day'); }
  }

  // Optional cycle-phase modifier: ±3 pts max.
  let cycleMod = 0;
  if (input.cyclePhase === 'ovulation') cycleMod = 3;
  else if (input.cyclePhase === 'follicular') cycleMod = 1;
  else if (input.cyclePhase === 'menses') cycleMod = -2;

  // Reweight: only count pillar maxes for pillars that received real
  // data. yesterdayStrain (5) is always counted. Score = raw / max * 100.
  // This means a user with only sleep + nutrition data gets a score
  // honestly representing those two pillars — not anchored at ~60 by
  // neutral fallbacks for the four they don't have.
  const PILLAR_MAX = { sleep: 30, hrv: 20, fatigue: 20, nutrition: 15, restingHr: 10 };
  const STRAIN_MAX = 5;
  let maxPossible = STRAIN_MAX; // strain always contributes
  if (present.sleep) maxPossible += PILLAR_MAX.sleep;
  if (present.hrv) maxPossible += PILLAR_MAX.hrv;
  if (present.fatigue) maxPossible += PILLAR_MAX.fatigue;
  if (present.nutrition) maxPossible += PILLAR_MAX.nutrition;
  if (present.restingHr) maxPossible += PILLAR_MAX.restingHr;

  const raw = sleep + hrv + fatigue + nutrition + restingHr + yesterdayStrain + cycleMod;
  // If we have nothing real, surface a 0-score that the UI can recognize
  // and replace with a "Connect Apple Health to see readiness" empty
  // state. 5/100 (just strain credit) would be misleading otherwise.
  const signalsPresent = Object.values(present).filter(Boolean).length;
  const total = signalsPresent === 0
    ? 0
    : clamp((raw / maxPossible) * 100, 0, 100);

  const label: PreparednessResult['label'] =
    total >= 85 ? 'Primed' :
    total >= 70 ? 'Ready' :
    total >= 50 ? 'Moderate' : 'Fatigued';

  return {
    score: Math.round(total),
    label,
    pillars: { sleep, hrv, fatigue, nutrition, restingHr, yesterdayStrain },
    insights: insights.slice(0, 4),
    recommendations: buildRecoveryRecommendations({
      sleep, hrv, fatigue, nutrition, restingHr, yesterdayStrain,
    }, present),
    missing,
    signalsPresent,
    signalsTotal: 5, // sleep, hrv, fatigue, nutrition, rhr (strain not user-driven)
    raw,
    maxPossible,
  };
}

/** Concrete actions a user can take when a pillar comes back weak.
 *  Each branch only fires when the pillar received REAL data (so we don't
 *  recommend "sleep more" because no Apple Health = score 0). Caps at 4
 *  total to keep the card scannable. Sleep tips lead because it's the
 *  pillar with the largest weight (30/100) and the most actionable. */
function buildRecoveryRecommendations(
  pillars: PreparednessPillars,
  present: Record<string, boolean>,
): string[] {
  const recs: string[] = [];

  // Sleep — pillar max is 30, "below par" threshold from insights is < 55%
  // of max, so surface tips at the same cutoff (sleep < 17/30).
  if (present.sleep && pillars.sleep < 17) {
    recs.push('Train lighter today — keep RPE under 7 and skip max effort sets.');
    recs.push('Tonight: 7+ hrs in a cool, dark room. No caffeine after 2pm and dim screens 30 min before bed.');
  }
  // HRV well below baseline — body is stressed, recovery is the play.
  if (present.hrv && pillars.hrv < 10) {
    recs.push('HRV says recover — swap intervals for steady cardio, hydrate, prioritize protein.');
  }
  // Fatigue — accumulated muscle load is high.
  if (present.fatigue && pillars.fatigue < 10) {
    recs.push('Reduce volume today (3 sets instead of 4) or shift to active recovery / mobility.');
  }
  // Nutrition pillar is 0-15. Tips when meaningfully under-fueled.
  if (present.nutrition && pillars.nutrition < 7) {
    recs.push('Hit calorie + protein target before training — undereating compounds the fatigue.');
  }

  return recs.slice(0, 4);
}

function ageHrvReference(age: number | null): number {
  if (age == null) return 50;
  if (age < 30) return 70;
  if (age < 40) return 60;
  if (age < 50) return 50;
  if (age < 60) return 40;
  return 32;
}
