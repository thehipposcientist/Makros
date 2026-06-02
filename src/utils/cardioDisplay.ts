import { defaultVenueForActivity, venueImpliesGps, type ActivityVenue } from './activityVenue.ts';

type CardioExerciseLike = {
  name?: unknown;
  equipment?: unknown;
  primaryMuscle?: unknown;
  primary_muscle?: unknown;
  _primary_muscle?: unknown;
  movementPattern?: unknown;
  movement_pattern?: unknown;
  prescriptionType?: unknown;
  prescription_type?: unknown;
  targetSets?: unknown;
  sets?: unknown;
  targetReps?: unknown;
  reps?: unknown;
  cardioGuidance?: Record<string, unknown> | null;
  cardio_guidance?: Record<string, unknown> | null;
  cardio_modality?: unknown;
};

type CardioWorkoutLike = {
  focus?: unknown;
  stimulus?: unknown;
  _custom_activity_category?: unknown;
  _custom_cardio_subtype?: unknown;
  _custom_activity_venue?: unknown;
  exercises?: CardioExerciseLike[] | null;
};

function normalize(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function canonicalVenue(value: unknown): ActivityVenue | null {
  const v = normalize(value);
  return v === 'indoor' || v === 'outdoor' ? v : null;
}

function guidanceFor(exercise: CardioExerciseLike | null | undefined): Record<string, unknown> {
  const guidance = exercise?.cardioGuidance ?? exercise?.cardio_guidance;
  return guidance && typeof guidance === 'object' ? guidance : {};
}

function exerciseText(exercise: CardioExerciseLike | null | undefined): string {
  const guidance = guidanceFor(exercise);
  return normalize([
    exercise?.name,
    exercise?.equipment,
    exercise?.primaryMuscle,
    exercise?.primary_muscle,
    exercise?._primary_muscle,
    exercise?.movementPattern,
    exercise?.movement_pattern,
    exercise?.prescriptionType,
    exercise?.prescription_type,
    exercise?.targetReps,
    exercise?.reps,
    guidance.modality,
    exercise?.cardio_modality,
  ].filter(Boolean).join(' '));
}

const INDOOR_CARDIO_RE = /\b(?:indoor|stationary|spin|peloton|trainer|treadmill|elliptical|rower|rowing machine|stair climber|stairmaster|skierg|ski erg|versa climber|versaclimber|assault bike|fan bike|airbike|air bike|echo bike|bikeerg|bike erg|exercise bike)\b/;
const OUTDOOR_CARDIO_RE = /\b(?:outdoor|road|trail|open water)\b/;
const CARDIO_TEXT_RE = /\b(?:cardio|conditioning|zone 2|steady|interval|hiit|run|running|jog|walk|walking|hike|hiking|ride|bike|biking|cycle|cycling|swim|swimming|row|rowing|elliptical|stair|spin|treadmill)\b/;

export function isIndoorCardioEquipment(exercise: CardioExerciseLike | null | undefined): boolean {
  const text = exerciseText(exercise);
  return INDOOR_CARDIO_RE.test(text);
}

function isOutdoorCardioExercise(exercise: CardioExerciseLike | null | undefined): boolean {
  const text = exerciseText(exercise);
  return OUTDOOR_CARDIO_RE.test(text) && CARDIO_TEXT_RE.test(text);
}

function inferSubtypeFromText(rawText: unknown): string | null {
  const text = normalize(rawText);
  if (!text) return null;
  if (/\b(?:hike|hiking)\b/.test(text)) return 'hike';
  if (/\b(?:run|running|jog|jogging|treadmill)\b/.test(text)) return 'run';
  if (/\b(?:walk|walking)\b/.test(text)) return 'walk';
  if (/\b(?:ride|bike|biking|cycle|cycling|spin|stationary bike|peloton|trainer)\b/.test(text)) return 'ride';
  if (/\b(?:swim|swimming|open water|pool)\b/.test(text)) return 'swim';
  if (/\b(?:row|rowing|rower)\b/.test(text)) return 'row';
  if (/\b(?:elliptical)\b/.test(text)) return 'elliptical';
  if (/\b(?:stair|stairs|stair climber)\b/.test(text)) return 'stair';
  return null;
}

export function inferCardioVenue(workout: CardioWorkoutLike | null | undefined): ActivityVenue {
  const explicitVenue = canonicalVenue(workout?._custom_activity_venue);
  if (explicitVenue) return explicitVenue;

  const exercises = Array.isArray(workout?.exercises) ? workout!.exercises! : [];
  const focusText = normalize(workout?.focus);
  if (INDOOR_CARDIO_RE.test(focusText)) return 'indoor';
  if (exercises.some(isIndoorCardioEquipment) && !exercises.some(isOutdoorCardioExercise)) {
    return 'indoor';
  }
  if (OUTDOOR_CARDIO_RE.test(focusText) || exercises.some(isOutdoorCardioExercise)) {
    return 'outdoor';
  }

  const subtype = normalize(workout?._custom_cardio_subtype)
    || inferSubtypeFromText(focusText)
    || inferSubtypeFromText(exercises.map(exerciseText).join(' '));
  return defaultVenueForActivity(
    normalize(workout?._custom_activity_category) || 'cardio',
    subtype,
  );
}

export function cardioContextAllowsOutdoorData(workout: CardioWorkoutLike | null | undefined): boolean {
  const category = normalize(workout?._custom_activity_category) || 'cardio';
  const exercises = Array.isArray(workout?.exercises) ? workout!.exercises! : [];
  const subtype = normalize(workout?._custom_cardio_subtype)
    || inferSubtypeFromText(workout?.focus)
    || inferSubtypeFromText(exercises.map(exerciseText).join(' '));
  return venueImpliesGps(inferCardioVenue(workout), category, subtype);
}

export function isSetlessCardioExercise(exercise: CardioExerciseLike | null | undefined): boolean {
  const targetSets = Number(exercise?.targetSets ?? exercise?.sets);
  if (!Number.isFinite(targetSets) || targetSets !== 0) return false;

  const text = exerciseText(exercise);
  const primary = normalize(exercise?.primaryMuscle ?? exercise?.primary_muscle ?? exercise?._primary_muscle);
  const movement = normalize(exercise?.movementPattern ?? exercise?.movement_pattern);
  const prescription = normalize(exercise?.prescriptionType ?? exercise?.prescription_type);
  return primary === 'cardio'
    || movement === 'cardio'
    || prescription.startsWith('cardio')
    || CARDIO_TEXT_RE.test(text);
}
