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
  /stretch|foam roll|cat.?cow|pigeon.?pose|child.?s pose|spinal twist|world.?s greatest|hip 90|thoracic|shoulder dislocate|downward dog|cobra|bird.?dog|dead bug|superman|glute bridge|clamshell|band pull.?apart|wall slide|butterfly|savasana|couch stretch|dead hang|hamstring stretch|calf stretch|quad stretch|forward fold|straddle|yoga|vinyasa|flow|mobility|pose\b/i;

const GUIDE_NAME_RE =
  /stretch|foam roll|cat.?cow|pigeon|child.?s pose|spinal twist|world.?s greatest|90.?90|hip 90|thoracic|shoulder dislocate|downward dog|cobra|butterfly|savasana|couch stretch|hamstring stretch|calf stretch|quad stretch|forward fold|straddle|yoga|vinyasa|\byin\b|\bflow\b|mobility|pose\b|breathwork|breathing|meditation/i;

/** Cardio modalities — treadmill, bike, rower, swimming, etc. No weight,
 *  reps are really a duration. */
const CARDIO_NAME_RE =
  /treadmill|stationary bike|elliptical|rowing machine|stair climber|assault bike|battle ropes|jump rope|sprint|jogging|running|cycling|swimming|hiit|intervals|mountain climber|hill sprint|cardio|zone ?2|tempo|steady state|long run|boxing|kickboxing|martial.?arts|mma|sparring|bag.?work|shadow.?box/i;

/** Hold-for-time exercises (plank family, wall sit, hollow hold, L-sit)
 *  plus loaded carries where weight should stay visible. */
const HOLD_NAME_RE =
  /plank|dead hang|wall sit|hollow.?hold|\bl[-\s]?sit\b|farmer.?walk|farmer.?carry|suitcase carry|loaded carry/i;

/** Equipment slugs/names where load is a meaningful progression signal even
 *  if the target is time or distance, e.g. sled pushes, weighted planks,
 *  loaded carries, and cable isometric holds. */
const LOADABLE_EQUIPMENT_RE =
  /\b(barbell|dumbbells?|adjustable[ _-]?dumbbells?|ez[ _-]?curl[ _-]?bar|kettlebells?|trap[ _-]?bar|weight[ _-]?plates?|weighted[ _-]?vest|sandbag|medicine[ _-]?ball|cable[ _-]?machine|smith[ _-]?machine|landmine[ _-]?attachment|sled|ruck[ _-]?pack)\b/i;

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

const GUIDE_TRAINING_TYPES = new Set([
  'mobility', 'stretch', 'recovery', 'flow',
]);

const GUIDE_ARCHETYPES = new Set([
  'mobility_flow',
  'stretch_block',
  'recovery_easy',
  'stress_relief_easy',
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

/** Equipment strings that mean "resistance band only" — e.g. monster
 *  walks, band pull-aparts, lateral band walks. Bands don't have a
 *  scalar weight to recommend in the way plates do, so we treat them
 *  as bodyweight-equivalent for input rendering. Loaded band-assisted
 *  exercises (banded squat, banded bench) declare additional loadable
 *  equipment and won't match here. */
function _equipmentIsBandOnly(raw: unknown): boolean {
  if (!raw) return false;
  let tokens: string[] = [];
  if (Array.isArray(raw)) {
    tokens = raw.map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const slug = (item as any).slug ?? (item as any).name ?? '';
        return String(slug);
      }
      return '';
    });
  } else {
    tokens = String(raw).split(',');
  }
  const cleaned = tokens
    .map(t => t.toLowerCase().trim())
    .filter(t => t && t !== 'optional');
  if (cleaned.length === 0) return false;
  return cleaned.every(t => /resistance.?bands?\b|^bands?$|mini.?band|loop.?band/.test(t));
}

function _equipmentHasLoadable(raw: unknown): boolean {
  if (!raw) return false;
  if (Array.isArray(raw)) {
    return raw.some(item => {
      if (typeof item === 'string') return LOADABLE_EQUIPMENT_RE.test(item);
      if (!item || typeof item !== 'object') return false;
      const role = String((item as any).role ?? '').toLowerCase();
      const required = (item as any).required;
      if (required === false && role === 'optional') return false;
      const slug = (item as any).slug ?? (item as any).name ?? '';
      return LOADABLE_EQUIPMENT_RE.test(String(slug));
    });
  }
  return String(raw)
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
    .some(t => LOADABLE_EQUIPMENT_RE.test(t));
}

function _finiteNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[^\d.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Tracking modes (`default_tracking_mode` on the Exercise schema)
 *  that imply weight is not the unit of progression. Loaded carries
 *  are the one exception — they're tracked by time but weight matters
 *  — so callers must check the loaded-carry name pattern first. */
const NON_WEIGHT_TRACKING_MODES = new Set(['time', 'distance', 'calories']);

/** Anything that looks time-based in the reps field. Accepts string,
 *  number, null — safely coerces. */
export function isTimeBasedReps(reps: unknown): boolean {
  if (reps == null) return false;
  const s = String(reps).trim();
  if (!s) return false;
  return TIMED_REPS_RE.test(s);
}

export function isGuideExercise(ex: any, workout?: any): boolean {
  if (!ex) return false;
  const name = String(ex.name ?? '').toLowerCase();
  const reps = String(ex.reps ?? ex.targetReps ?? '').toLowerCase();
  const primaryMuscle = String(ex.primaryMuscle ?? ex.primary_muscle ?? ex._primary_muscle ?? '').toLowerCase();
  if (primaryMuscle === 'mobility' || primaryMuscle === 'recovery') return true;

  const slotRole = String(ex.slotRole ?? ex.slot_role ?? ex._role ?? '').toLowerCase();
  if (slotRole === 'mobility' || slotRole === 'recovery' || slotRole === 'stretch' || slotRole === 'cooldown') return true;

  const prescriptionType = String(ex.prescriptionType ?? ex.prescription_type ?? ex._prescription_type ?? '').toLowerCase();
  if (/mobility|stretch|recovery|cooldown|flow/.test(prescriptionType)) return true;

  const trainingType = String(ex.trainingType ?? ex.training_type ?? ex._training_type ?? ex.stimulus ?? '').toLowerCase();
  if (GUIDE_TRAINING_TYPES.has(trainingType)) return true;

  const archetype = String(ex.archetype ?? ex._archetype ?? '').toLowerCase();
  if (GUIDE_ARCHETYPES.has(archetype) || /mobility|stretch|recovery|stress.?relief/.test(archetype)) return true;

  if (GUIDE_NAME_RE.test(name)) return true;

  const workoutText = String(`${workout?.stimulus ?? ''} ${workout?.focus ?? ''}`).toLowerCase();
  if (/mobility|recovery|stretch|restore|yoga|flow/.test(workoutText) && GUIDE_NAME_RE.test(`${name} ${reps}`)) {
    return true;
  }

  return false;
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
 *      isn't a loaded carry (carries still need their load input)
 */
export function shouldHideWeight(ex: any): boolean {
  if (!ex) return false;
  const name = String(ex.name ?? '').toLowerCase();
  const equipment = ex.equipment ?? ex.gear ?? ex.equipment_slugs ?? ex.equipmentSlugs;

  // Loaded implements are weighted even when the movement is tracked by
  // time or distance: sled pushes, sandbag carries, weighted planks,
  // cable holds, medicine-ball core work, etc.
  if (_equipmentHasLoadable(equipment)) return false;
  // Legacy cached rows may not carry equipment; keep name-only carry
  // exceptions for older workout snapshots.
  if (/farmer|suitcase carry|loaded carry|sandbag.*carry|ruck/.test(name)) return false;

  // ── Structured-field fast path (avoids regex when planner data is present) ──
  const primaryMuscle = String(ex.primaryMuscle ?? ex.primary_muscle ?? ex._primary_muscle ?? '').toLowerCase();
  if (primaryMuscle === 'cardio') return true;
  if (primaryMuscle === 'mobility') return true;

  const trainingType = String(ex.trainingType ?? ex._training_type ?? ex.training_type ?? ex.stimulus ?? '').toLowerCase();
  if (trainingType && BODYWEIGHT_TRAINING_TYPES.has(trainingType)) return true;
  if (trainingType === 'cardio' || trainingType === 'conditioning') return true;

  // Tracking-mode signal — once loadable implements have been ruled out,
  // time/distance/calories tracked movements generally do not progress by
  // numeric load. Catches Monster Walk / banded walks / cardio intervals.
  const trackingMode = String(
    ex.defaultTrackingMode ?? ex.default_tracking_mode ?? ex._default_tracking_mode ?? ''
  ).toLowerCase();
  if (trackingMode && NON_WEIGHT_TRACKING_MODES.has(trackingMode)) return true;

  // ── Regex fallback (for old cached data without structured fields) ──
  if (_equipmentIsBodyweight(equipment)) return true;
  // Band-only equipment — bands don't have a scalar weight to log /
  // recommend. Banded compound lifts (banded squat, banded bench)
  // declare additional loadable equipment so they bypass this check.
  if (_equipmentIsBandOnly(equipment)) return true;
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

export function watchExerciseTracksWeight(exercise: any): boolean {
  return !shouldHideWeight(exercise);
}

export function watchExerciseTargetWeightLbs(exercise: any): number | null {
  if (!watchExerciseTracksWeight(exercise)) return null;
  return _finiteNumber(
    exercise?.plannedTargetWeightLbs
      ?? exercise?.targetWeightLbs
      ?? exercise?.recommendedWeightLbs
      ?? exercise?.weight,
  );
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
  const primaryMuscle = String(ex.primaryMuscle ?? ex.primary_muscle ?? ex._primary_muscle ?? '').toLowerCase();
  if (primaryMuscle === 'cardio') return true;
  if (primaryMuscle === 'mobility') return true;

  const trainingType = String(ex.trainingType ?? ex._training_type ?? ex.training_type ?? ex.stimulus ?? '').toLowerCase();
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
