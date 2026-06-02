/**
 * Archetype-aware training-score acceptance tests.
 *
 * Run: `node --experimental-strip-types src/services/__tests__/trainingScore.test.mjs`
 *
 * Covers the 5 acceptance criteria for the scoring refactor:
 *   1. Strength lift with low HR can still score high (HR shouldn't dominate)
 *   2. Z2 cardio with too much Z3+ scores LOWER than a clean Z2
 *   3. HIIT rewards high intensity (Z3+ time)
 *   4. Mobility scored by duration/completion, not fake fixed effort
 *   5. Missing HR data still produces a valid score
 */
import {
  computeTrainingScore,
  archetypeFromWorkout,
} from '../trainingScore.ts';

let passed = 0;
let failed = 0;
function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, why) {
  failed++;
  console.error(`  ✗ ${label}: ${why}`);
  process.exitCode = 1;
}
function assert(cond, label, why = '') {
  if (cond) ok(label);
  else fail(label, why || 'expected truthy');
}

console.log('\n[trainingScore]\n');

// ─── 1. Strength lift with low HR scores high ────────────────────────────────
{
  // 5×3 heavy squat: low HR average, mostly Z1-Z2, but every set
  // completed, full duration, hit target load, progressed.
  const ts = computeTrainingScore({
    archetype: 'strength_lift',
    goal: 'strength',
    actualDurationSec: 50 * 60,
    estimatedDurationSec: 50 * 60,
    setsCompleted: 15,
    setsPlanned: 15,
    exercisesCompleted: 4,
    exercisesPlanned: 4,
    hrAvg: 105,
    hrMax: 130,
    hrZoneMinutes: [35, 12, 3, 0, 0], // Mostly Z1-Z2, very little Z3+
    hitTargetLoad: true,
    progressionAchieved: true,
  });
  assert(ts.score >= 80, 'strength lift with low HR scores ≥80', `got ${ts.score}, pillars=${JSON.stringify(ts.pillars)}`);
  assert(ts.archetype === 'strength_lift', 'archetype resolved as strength_lift');
  assert(ts.rating === 'Crushed' || ts.rating === 'Solid', `rating is Crushed/Solid (got ${ts.rating})`);
}

// ─── 2. Zone 2 with too much Z3+ scores LOWER than a clean Z2 session ────────
{
  // Clean Z2: 35 min in Z2, 5 min Z1, no Z3+
  const cleanZ2 = computeTrainingScore({
    archetype: 'zone2_cardio',
    actualDurationSec: 40 * 60,
    estimatedDurationSec: 40 * 60,
    hrZoneMinutes: [5, 35, 0, 0, 0],
    setsCompleted: 1,
    setsPlanned: 1,
    exercisesCompleted: 1,
    exercisesPlanned: 1,
  });
  // Too much Z3+: 15 min in Z2, 25 min in Z3+ — overshoot the prescribed easy stimulus
  const overshotZ2 = computeTrainingScore({
    archetype: 'zone2_cardio',
    actualDurationSec: 40 * 60,
    estimatedDurationSec: 40 * 60,
    hrZoneMinutes: [3, 12, 18, 7, 0],
    setsCompleted: 1,
    setsPlanned: 1,
    exercisesCompleted: 1,
    exercisesPlanned: 1,
  });
  assert(cleanZ2.score > overshotZ2.score, 'clean Z2 outscores Z2-with-too-much-Z3+',
         `clean=${cleanZ2.score}, overshot=${overshotZ2.score}`);
  assert(cleanZ2.score >= 75, 'clean Z2 scores ≥75', `got ${cleanZ2.score}`);
}

// ─── 3. HIIT session rewards high intensity ──────────────────────────────────
{
  // Hard HIIT: 60% of time in Z3-Z5, all intervals completed
  const hardHiit = computeTrainingScore({
    archetype: 'interval_cardio',
    actualDurationSec: 25 * 60,
    estimatedDurationSec: 25 * 60,
    hrZoneMinutes: [3, 7, 8, 5, 2], // ~60% in Z3+
    intervalsCompleted: 8,
    intervalsPlanned: 8,
    exercisesCompleted: 1,
    exercisesPlanned: 1,
  });
  // Easy "HIIT" — barely got into Z3
  const softHiit = computeTrainingScore({
    archetype: 'interval_cardio',
    actualDurationSec: 25 * 60,
    estimatedDurationSec: 25 * 60,
    hrZoneMinutes: [10, 12, 3, 0, 0], // ~12% in Z3+
    intervalsCompleted: 8,
    intervalsPlanned: 8,
    exercisesCompleted: 1,
    exercisesPlanned: 1,
  });
  assert(hardHiit.score > softHiit.score, 'hard HIIT outscores soft "HIIT"',
         `hard=${hardHiit.score}, soft=${softHiit.score}`);
  assert(hardHiit.score >= 75, 'hard HIIT scores ≥75', `got ${hardHiit.score}`);
}

// ─── 4. Mobility scored by duration/completion ───────────────────────────────
{
  // Full mobility flow: full duration, all movements done
  const fullMob = computeTrainingScore({
    archetype: 'mobility_recovery',
    actualDurationSec: 20 * 60,
    estimatedDurationSec: 20 * 60,
    exercisesCompleted: 8,
    exercisesPlanned: 8,
    hrZoneMinutes: [18, 2, 0, 0, 0],
    setsCompleted: 8,
    setsPlanned: 8,
  });
  // Half-baked mobility: only 5 min, 3/8 movements done, HR way too high
  const halfMob = computeTrainingScore({
    archetype: 'mobility_recovery',
    actualDurationSec: 5 * 60,
    estimatedDurationSec: 20 * 60,
    exercisesCompleted: 3,
    exercisesPlanned: 8,
    hrZoneMinutes: [1, 1, 2, 1, 0],
    setsCompleted: 3,
    setsPlanned: 8,
  });
  assert(fullMob.score > halfMob.score, 'full mobility session outscores half-done one',
         `full=${fullMob.score}, half=${halfMob.score}`);
  assert(fullMob.score >= 80, 'full mobility ≥80 (was previously fixed at 70%)',
         `got ${fullMob.score}`);
  assert(halfMob.score < 60, 'half-done mobility <60 (no fixed effort floor)',
         `got ${halfMob.score}`);
}

// ─── 5. Missing HR data still produces a valid score ─────────────────────────
{
  // Strength lift, NO HR data at all
  const noHr = computeTrainingScore({
    archetype: 'strength_lift',
    actualDurationSec: 45 * 60,
    estimatedDurationSec: 45 * 60,
    setsCompleted: 12,
    setsPlanned: 12,
    exercisesCompleted: 4,
    exercisesPlanned: 4,
    hitTargetLoad: true,
    progressionAchieved: true,
    // no hrAvg, hrMax, or hrZoneMinutes
  });
  assert(typeof noHr.score === 'number' && !isNaN(noHr.score), 'noHr score is a number');
  assert(noHr.score >= 0 && noHr.score <= 100, `noHr score in [0,100] (${noHr.score})`);
  assert(noHr.score >= 75, 'noHr strength lift still scores well',
         `got ${noHr.score}`);

  // Z2 cardio with NO HR data — should fall back gracefully on duration + completion
  const noHrZ2 = computeTrainingScore({
    archetype: 'zone2_cardio',
    actualDurationSec: 40 * 60,
    estimatedDurationSec: 40 * 60,
    setsCompleted: 1,
    setsPlanned: 1,
    exercisesCompleted: 1,
    exercisesPlanned: 1,
  });
  assert(noHrZ2.score >= 0 && noHrZ2.score <= 100, `Z2 no-HR score in [0,100] (${noHrZ2.score})`);
  // The pillar redistribution should give meaningful credit even without zone data.
  assert(noHrZ2.score >= 60, 'Z2 no-HR still scores reasonably well',
         `got ${noHrZ2.score}`);
}

// ─── Bonus: archetype derivation ─────────────────────────────────────────────
{
  assert(archetypeFromWorkout('Push', 'strength') === 'strength_lift', 'derive strength_lift from stimulus');
  assert(archetypeFromWorkout('Pull', 'hypertrophy') === 'hypertrophy_lift', 'derive hypertrophy_lift');
  assert(archetypeFromWorkout('Zone 2 Run', 'conditioning') === 'zone2_cardio', 'derive zone2_cardio');
  assert(archetypeFromWorkout('HIIT Sprints', 'conditioning') === 'interval_cardio', 'derive interval_cardio');
  assert(archetypeFromWorkout('Mobility Flow', 'mobility') === 'mobility_recovery', 'derive mobility_recovery');
  assert(archetypeFromWorkout('Pilates', 'mobility') === 'mobility_recovery', 'derive pilates mobility_recovery');
  assert(archetypeFromWorkout('Push + Cardio', 'mixed') === 'mixed_lift', 'derive mixed_lift');
}

// ─── Bonus: goal modifier doesn't break the 100-point scale ──────────────────
{
  for (const goal of ['muscle_gain', 'fat_loss', 'strength', 'endurance', 'general_health', 'body_recomp']) {
    const ts = computeTrainingScore({
      archetype: 'hypertrophy_lift',
      goal,
      actualDurationSec: 45 * 60,
      estimatedDurationSec: 45 * 60,
      setsCompleted: 12,
      setsPlanned: 12,
      exercisesCompleted: 4,
      exercisesPlanned: 4,
      hrZoneMinutes: [10, 25, 8, 2, 0],
    });
    assert(ts.score >= 0 && ts.score <= 100, `goal=${goal} score in [0,100] (${ts.score})`);
  }
}

// ─── Regression: removed/skipped planned work cannot rate as "Crushed" ───────
{
  const halfDone = computeTrainingScore({
    archetype: 'hypertrophy_lift',
    goal: 'muscle_gain',
    actualDurationSec: 28 * 60,
    estimatedDurationSec: 55 * 60,
    setsCompleted: 6,
    setsPlanned: 15,
    exercisesCompleted: 2,
    exercisesPlanned: 5,
    progressionAchieved: false,
    hitTargetLoad: false,
  });
  assert(halfDone.score < 65, 'half-completed planned lift does not score Solid/Crushed',
         `got ${halfDone.score} (${halfDone.rating})`);
  assert(halfDone.rating === 'Light' || halfDone.rating === 'Below',
         `half-completed rating is Light/Below (got ${halfDone.rating})`);
}

// ─── Refinement spec: stricter Crushed + reweighted scoring ──────────────────
//
// New rules baked in by the algorithm refresh (see trainingScore.ts):
//   - Crushed threshold raised to 90 (was 85).
//   - Z2 weighted compliance — Z2 drives, Z1 partial, Z3+ subtracts.
//   - Duration capped at ~0.90 × pillar_max so it can't carry a score.
//   - Missing-signal pillars collapse to 0 + redistribute weight (no
//     fake 0.6×max neutral).
//   - Partial progression credit via loadGainRatio / repGainRatio /
//     setsGain / rirImprovement; legacy boolean path still works.

// Hypertrophy 18/20 sets, 6/6 exercises, target load hit, no progression PR.
// Should be a clearly "great" session — but not 90+ since the user didn't
// actually progress vs last time.
{
  const ts = computeTrainingScore({
    archetype: 'hypertrophy_lift',
    actualDurationSec: 60 * 60,
    estimatedDurationSec: 55 * 60,
    setsCompleted: 18,
    setsPlanned: 20,
    exercisesCompleted: 6,
    exercisesPlanned: 6,
    hitTargetLoad: true,
    progressionAchieved: false,
  });
  assert(ts.score >= 75, 'hypertrophy with no PR scores ≥75 (still a strong session)',
         `got ${ts.score} (${ts.rating})`);
  assert(ts.score < 90, 'hypertrophy with no PR does NOT crack Crushed',
         `got ${ts.score} (${ts.rating}) — Crushed should require either full completion + PR, or detailed progression signals`);
}

// Same hypertrophy session, but the user actually progressed (added load
// + slight rep gain). Detailed progression signals push it into Crushed.
{
  const ts = computeTrainingScore({
    archetype: 'hypertrophy_lift',
    actualDurationSec: 60 * 60,
    estimatedDurationSec: 55 * 60,
    setsCompleted: 20,
    setsPlanned: 20,
    exercisesCompleted: 6,
    exercisesPlanned: 6,
    hitTargetLoad: true,
    loadGainRatio: 0.025,   // +2.5% load
    repGainRatio: 0.05,     // +5% reps
  });
  assert(ts.score >= 90, 'hypertrophy with full completion + real PR earns Crushed',
         `got ${ts.score} (${ts.rating})`);
  assert(ts.rating === 'Crushed', `rating is Crushed (got ${ts.rating})`);
}

// Z2 mostly Z1 — leisure walk being labeled as Zone 2. Should NOT score
// like a clean Z2 base ride. Compares against the clean Z2 baseline from
// earlier in the file.
{
  const mostlyZ1 = computeTrainingScore({
    archetype: 'zone2_cardio',
    actualDurationSec: 40 * 60,
    estimatedDurationSec: 40 * 60,
    hrZoneMinutes: [35, 5, 0, 0, 0],   // 87% Z1, 13% Z2
    setsCompleted: 1,
    setsPlanned: 1,
    exercisesCompleted: 1,
    exercisesPlanned: 1,
  });
  const cleanZ2 = computeTrainingScore({
    archetype: 'zone2_cardio',
    actualDurationSec: 40 * 60,
    estimatedDurationSec: 40 * 60,
    hrZoneMinutes: [5, 35, 0, 0, 0],   // 87% Z2, 13% Z1
    setsCompleted: 1,
    setsPlanned: 1,
    exercisesCompleted: 1,
    exercisesPlanned: 1,
  });
  assert(mostlyZ1.score < cleanZ2.score - 10,
         'mostly-Z1 session scores meaningfully lower than clean Z2',
         `mostlyZ1=${mostlyZ1.score} vs cleanZ2=${cleanZ2.score}`);
  assert(mostlyZ1.rating !== 'Crushed', `mostly-Z1 cannot be Crushed (got ${mostlyZ1.rating})`);
}

// HIIT with high Z3+ + completed intervals — should score well (Crushed
// or near-Crushed).
{
  const hardHiit = computeTrainingScore({
    archetype: 'interval_cardio',
    actualDurationSec: 30 * 60,
    estimatedDurationSec: 30 * 60,
    hrZoneMinutes: [3, 5, 10, 8, 4],   // ~73% in Z3+
    intervalsCompleted: 10,
    intervalsPlanned: 10,
    exercisesCompleted: 1,
    exercisesPlanned: 1,
  });
  assert(hardHiit.score >= 85, 'hard HIIT with completed intervals scores ≥85',
         `got ${hardHiit.score} (${hardHiit.rating})`);
}

// Strength workout WITHOUT HR — should not be punished. Missing-pillar
// redistribution carries the load.
{
  const strengthNoHr = computeTrainingScore({
    archetype: 'strength_lift',
    actualDurationSec: 50 * 60,
    estimatedDurationSec: 50 * 60,
    setsCompleted: 15,
    setsPlanned: 15,
    exercisesCompleted: 4,
    exercisesPlanned: 4,
    hitTargetLoad: true,
    progressionAchieved: true,
    // no hrZoneMinutes / hrAvg — HR pillar is absent
  });
  assert(strengthNoHr.score >= 85,
         'strength lift without HR is not punished — completion + progression carries it',
         `got ${strengthNoHr.score} (${strengthNoHr.rating})`);
}

// Mobility workout WITHOUT HR — duration + movement completion drive it.
// Should easily land in Solid territory.
{
  const mobilityNoHr = computeTrainingScore({
    archetype: 'mobility_recovery',
    actualDurationSec: 20 * 60,
    estimatedDurationSec: 20 * 60,
    exercisesCompleted: 8,
    exercisesPlanned: 8,
    setsCompleted: 8,
    setsPlanned: 8,
    // no hrZoneMinutes — Low-Intensity Compliance pillar is absent
  });
  assert(mobilityNoHr.score >= 80,
         'mobility without HR scores well — duration + completion carry it',
         `got ${mobilityNoHr.score} (${mobilityNoHr.rating})`);
}

// Duration alone can't carry a mediocre workout — half-skipped lift that
// happened to last the full estimated duration shouldn't score great.
{
  const longButSkipped = computeTrainingScore({
    archetype: 'hypertrophy_lift',
    actualDurationSec: 60 * 60,
    estimatedDurationSec: 60 * 60,   // perfect duration ratio
    setsCompleted: 8,
    setsPlanned: 18,                 // less than half
    exercisesCompleted: 3,
    exercisesPlanned: 6,
    hitTargetLoad: false,
    progressionAchieved: false,
  });
  assert(longButSkipped.score < 65,
         'full-duration but half-skipped lift is not Solid (duration cannot carry it)',
         `got ${longButSkipped.score} (${longButSkipped.rating})`);
}

console.log(`\ntrainingScore: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
