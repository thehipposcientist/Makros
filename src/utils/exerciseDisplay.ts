/**
 * exerciseDisplay — shared predicates for deciding what inputs to render
 * for a given exercise. The planner emits exercises with wildly different
 * shapes (strength sets with sets×reps and weight, timed stretches with
 * "60s hold", cardio intervals in minutes, mobility flows) and the UI
 * needs ONE place that answers:
 *
 *   - shouldHideWeight(ex):  is this a bodyweight / stretch / cardio /
 *                            mobility / hold-for-time movement? If so,
 *                            don't render a weight input and don't log
 *                            a 0-lb set.
 *   - shouldHideReps(ex):    is the "reps" target really a duration
 *                            string ("60s hold", "3 min", "flow")?
 *                            If so, the reps column is a duration, not a
 *                            count — render it inline, not as a numeric
 *                            input.
 *
 * Both predicates are tolerant of the planner's various field names and
 * the AI plan generator's occasional shape drift. Pass in whatever you
 * have — the bag-of-fields object works fine.
 */

/** Case-insensitive keyword list that unambiguously marks an exercise
 *  as bodyweight-only (stretches, yoga poses, mobility drills, holds).
 *  Weight input is never useful for any of these. */
const BODYWEIGHT_NAME_RE =
  /stretch|foam roll|cat.?cow|pigeon.?pose|child.?s pose|spinal twist|world.?s greatest|hip 90|thoracic|shoulder dislocate|downward dog|cobra|bird.?dog|dead bug|superman|glute bridge|clamshell|band pull.?apart|face pull|wall slide|butterfly|savasana|couch stretch|dead hang|hamstring stretch|calf stretch|quad stretch|forward fold|straddle|yoga|vinyasa|flow|mobility|pose\b/i;

/** Cardio modalities — treadmill, bike, rower, swimming, etc. No weight,
 *  reps are really a duration. */
const CARDIO_NAME_RE =
  /treadmill|stationary bike|elliptical|rowing machine|stair climber|assault bike|battle ropes|jump rope|sprint|jogging|running|cycling|swimming|hiit|intervals|mountain climber|hill sprint|cardio|zone ?2|tempo|steady state|long run|boxing|kickboxing|sparring|bag.?work|shadow.?box/i;

/** Hold-for-time exercises (plank family, carries, wall sit, hollow
 *  hold, L-sit). Reps are a duration, weight sometimes relevant
 *  (farmer's carry), sometimes not (plank). */
const HOLD_NAME_RE =
  /plank|dead hang|wall sit|hollow.?hold|l.?sit|farmer.?walk|farmer.?carry|suitcase carry|loaded carry/i;

/** A reps string that's actually a time target. Matches:
 *   "60s", "60 sec", "60 seconds"
 *   "60-90s", "30-60 sec"
 *   "3 min", "5-8 min", "25 minutes"
 *   "flow", "hold", "each side", "per side"
 *   "amrap", "max time", "to failure" (really a duration or effort)
 */
const TIMED_REPS_RE =
  /(\b\d+\s*-?\s*\d*\s*s(ec|econds?)?\b)|(\b\d+\s*-?\s*\d*\s*m(in(ute)?s?)?\b)|flow|hold|each side|per side|amrap|max time|to failure/i;

/** Archetype tags emitted by the backend planner that mean "no weight,
 *  reps are time". Matched case-insensitively. Keep in sync with
 *  backend/app/services/workout/archetypes.py. */
const TIME_BASED_ARCHETYPES = new Set([
  'mobility_flow',
  'stretch_block',
  'recovery_easy',
  'stress_relief_easy',
  'cond_zone2',
  'cond_intervals_short',
  'cond_intervals_long',
  'cond_tempo',
]);

/** Training types that mean "no weight". */
const BODYWEIGHT_TRAINING_TYPES = new Set([
  'mobility', 'stretch', 'recovery', 'flow',
]);

/** Training types that mean "no reps either — duration is the unit". */
const TIME_TRAINING_TYPES = new Set([
  'mobility', 'stretch', 'recovery', 'flow', 'conditioning', 'cardio',
]);

/** Equipment strings that mean "bodyweight only". The planner emits
 *  comma-separated equipment slugs ("barbell, flat_bench") so we
 *  parse the first token. */
function _equipmentIsBodyweight(raw: unknown): boolean {
  if (!raw) return false;
  const s = String(raw).toLowerCase().trim();
  if (!s) return false;
  const first = s.split(',')[0].trim();
  return first === 'bodyweight' || first === 'none' || first === 'bw';
}

/** Anything that looks time-based in the reps field. Accepts string,
 *  number, null — safely coerces. */
export function isTimeBasedReps(reps: unknown): boolean {
  if (reps == null) return false;
  const s = String(reps).trim();
  if (!s) return false;
  return TIMED_REPS_RE.test(s);
}

/** Predicate: should the UI hide the weight input for this exercise?
 *
 *  True when ANY of these are true:
 *    - equipment is bodyweight/none/bw
 *    - name matches stretch / yoga / mobility / pose keywords
 *    - name matches a cardio modality (treadmill, bike, etc.)
 *    - primary_muscle is 'mobility'
 *    - archetype is MOBILITY_FLOW / STRETCH_BLOCK / RECOVERY_EASY
 *    - training_type is 'mobility' / 'stretch' / 'recovery' / 'flow'
 *    - reps string is time-based ("60s", "3 min", "flow") AND the name
 *      isn't a loaded carry (farmer's walk carries weight but is timed)
 */
export function shouldHideWeight(ex: any): boolean {
  if (!ex) return false;
  const name = String(ex.name ?? '').toLowerCase();
  // Loaded carry is an exception — it's timed but IS weighted
  if (/farmer|suitcase carry|loaded carry/.test(name)) return false;

  // ── Structured-field fast path (avoids regex when planner data is present) ──
  const primaryMuscle = String(ex.primary_muscle ?? ex._primary_muscle ?? '').toLowerCase();
  if (primaryMuscle === 'cardio') return true;
  if (primaryMuscle === 'mobility') return true;

  const trainingType = String(ex._training_type ?? ex.training_type ?? ex.stimulus ?? '').toLowerCase();
  if (trainingType && BODYWEIGHT_TRAINING_TYPES.has(trainingType)) return true;
  if (trainingType === 'cardio' || trainingType === 'conditioning') return true;

  // ── Regex fallback (for old cached data without structured fields) ──
  if (_equipmentIsBodyweight(ex.equipment)) return true;
  if (BODYWEIGHT_NAME_RE.test(name)) return true;
  if (CARDIO_NAME_RE.test(name)) return true;
  if (HOLD_NAME_RE.test(name) && !/farmer|suitcase|loaded/.test(name)) return true;

  const archetype = String(ex._archetype ?? ex.archetype ?? '').toLowerCase();
  if (archetype && TIME_BASED_ARCHETYPES.has(archetype)) return true;

  // If the reps string looks like a pure duration/flow AND it's not a
  // carry, weight is almost never meaningful.
  if (isTimeBasedReps(ex.reps ?? ex.targetReps)) return true;

  return false;
}

/** Predicate: should the UI hide the numeric reps input? True when the
 *  reps field is really a duration target ("60s hold", "3 min", "flow").
 *  Callers should render the target string inline instead of a number
 *  input, and log a single set with reps=0 + durationSeconds set.
 */
export function shouldHideReps(ex: any): boolean {
  if (!ex) return false;
  const name = String(ex.name ?? '').toLowerCase();

  // ── Structured-field fast path ──
  const primaryMuscle = String(ex.primary_muscle ?? ex._primary_muscle ?? '').toLowerCase();
  if (primaryMuscle === 'cardio') return true;
  if (primaryMuscle === 'mobility') return true;

  const trainingType = String(ex._training_type ?? ex.training_type ?? ex.stimulus ?? '').toLowerCase();
  if (trainingType && TIME_TRAINING_TYPES.has(trainingType)) return true;

  const archetype = String(ex._archetype ?? ex.archetype ?? '').toLowerCase();
  if (archetype && TIME_BASED_ARCHETYPES.has(archetype)) return true;

  // Reps string that is actually a time target
  if (isTimeBasedReps(ex.reps ?? ex.targetReps)) return true;

  // ── Regex fallback (old cached data without structured fields) ──
  if (CARDIO_NAME_RE.test(name)) return true;

  return false;
}

/** Convenience: human display for the reps/duration column when
 *  shouldHideReps() is true. Falls back to the raw reps string. */
export function formatDurationTarget(ex: any): string {
  const raw = ex?.reps ?? ex?.targetReps ?? '';
  const s = String(raw).trim();
  return s || '—';
}
