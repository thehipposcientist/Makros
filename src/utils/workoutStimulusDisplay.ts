type WorkoutStimulusExercise = {
  name?: string | null;
  reps?: string | number | null;
  primary_muscle?: string | null;
  primaryMuscle?: string | null;
  _primary_muscle?: string | null;
  slotRole?: string | null;
  slot_role?: string | null;
  _role?: string | null;
  slotLabel?: string | null;
  slot_label?: string | null;
  _slot?: string | null;
  prescriptionType?: string | null;
  prescription_type?: string | null;
  _prescription_type?: string | null;
  cardioGuidance?: unknown;
  setScheme?: readonly { targetReps?: string | number | null }[] | null;
};

type WorkoutStimulusSet = NonNullable<WorkoutStimulusExercise['setScheme']>[number];

type WorkoutStimulusInput = {
  focus?: string | null;
  stimulus?: string | null;
  exercises?: readonly WorkoutStimulusExercise[] | null;
};

const HIDDEN_SINGLE_DAY_STIMULI = new Set(['conditioning', 'cardio', 'mobility', 'recovery']);

function normalized(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rawText(value: unknown): string {
  return String(value ?? '').toLowerCase().trim();
}

export function normalizeWorkoutStimulus(raw: unknown): string | null {
  const value = String(raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!value) return null;
  if (value === 'heavy' || value === 'strength') return 'strength';
  if (value === 'hypertrophy' || value === 'growth') return 'hypertrophy';
  if (value === 'volume' || value === 'endurance') return 'volume';
  if (value === 'power' || value === 'speed') return 'power';
  if (value === 'mixed' || value === 'blend') return 'mixed';
  return value;
}

function isCardioExercise(exercise: WorkoutStimulusExercise): boolean {
  const primary = normalized(exercise.primaryMuscle ?? exercise.primary_muscle ?? exercise._primary_muscle);
  if (primary === 'cardio') return true;

  const prescription = rawText(
    exercise.prescriptionType
      ?? exercise.prescription_type
      ?? exercise._prescription_type,
  );
  if (prescription.startsWith('cardio_') || prescription.startsWith('cardio ')) return true;

  const role = normalized(exercise.slotRole ?? exercise.slot_role ?? exercise._role);
  if (role === 'cardio') return true;

  const slot = normalized(exercise.slotLabel ?? exercise.slot_label ?? exercise._slot);
  if (/\bcardio\b/.test(slot)) return true;

  return !!exercise.cardioGuidance && typeof exercise.cardioGuidance === 'object';
}

function isWarmupExercise(exercise: WorkoutStimulusExercise): boolean {
  const role = normalized(exercise.slotRole ?? exercise.slot_role ?? exercise._role);
  if (role === 'warmup') return true;

  const slot = normalized(exercise.slotLabel ?? exercise.slot_label ?? exercise._slot);
  return /\bwarm\b/.test(slot);
}

function repMidpoint(raw: unknown): number | null {
  const text = String(raw ?? '').toLowerCase().trim();
  if (!text || /\b(?:sec|secs|second|seconds|min|mins|minute|minutes|yd|yard|yards|mi|mile|miles)\b|(?:\d\s*s\b)|(?:\d\s*m\b)/.test(text)) {
    return null;
  }
  const matches = text.match(/\d+(?:\.\d+)?/g);
  if (!matches?.length) return null;
  const first = Number(matches[0]);
  if (!Number.isFinite(first) || first <= 0 || first > 50) return null;
  const second = matches[1] != null ? Number(matches[1]) : first;
  if (!Number.isFinite(second) || second <= 0 || second > 50) return first;
  return (first + second) / 2;
}

function firstLiftRepMidpoint(workout: WorkoutStimulusInput): number | null {
  const rows = Array.isArray(workout.exercises) ? workout.exercises : [];
  for (const exercise of rows) {
    if (isWarmupExercise(exercise) || isCardioExercise(exercise)) continue;
    const schemeTarget = exercise.setScheme?.find((set: WorkoutStimulusSet) => repMidpoint(set?.targetReps) != null)?.targetReps;
    const midpoint = repMidpoint(schemeTarget ?? exercise.reps);
    if (midpoint != null) return midpoint;
  }
  return null;
}

function inferLiftStimulusForPlusCardio(workout: WorkoutStimulusInput): string {
  const focus = normalized(workout.focus);
  if (/\b(?:heavy|strength)\b/.test(focus)) return 'strength';
  if (/\bpower\b/.test(focus)) return 'power';
  if (/\bvolume\b/.test(focus)) return 'volume';

  const midpoint = firstLiftRepMidpoint(workout);
  if (midpoint == null) return 'hypertrophy';
  if (midpoint <= 6) return 'strength';
  if (midpoint > 12) return 'volume';
  return 'hypertrophy';
}

function hasVisiblePlusCardio(workout: WorkoutStimulusInput): boolean {
  const focus = normalized(workout.focus);
  return /\+\s*cardio\b/.test(focus) && (workout.exercises ?? []).some(isCardioExercise);
}

export function workoutStimulusDisplayKeys(workout: WorkoutStimulusInput | null | undefined): string[] {
  if (!workout) return [];
  const key = normalizeWorkoutStimulus(workout.stimulus);
  if (!key) return [];
  if (key === 'mixed' && hasVisiblePlusCardio(workout)) {
    return [inferLiftStimulusForPlusCardio(workout), 'cardio'];
  }
  if (HIDDEN_SINGLE_DAY_STIMULI.has(key)) return [];
  return [key];
}
