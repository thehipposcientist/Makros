type WorkoutFocusExercise = {
  name?: string | null;
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
};

type WorkoutFocusInput = {
  focus?: string | null;
  exercises?: readonly WorkoutFocusExercise[] | null;
};

const PLUS_CARDIO_RE = /\s*\+\s*cardio\b/i;

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

function withoutPlusCardio(focus: string): string {
  return focus.replace(PLUS_CARDIO_RE, '').replace(/\s+/g, ' ').trim();
}

function isCardioExercise(exercise: WorkoutFocusExercise): boolean {
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

function isCoreExercise(exercise: WorkoutFocusExercise): boolean {
  const primary = normalized(exercise.primaryMuscle ?? exercise.primary_muscle ?? exercise._primary_muscle);
  if (primary === 'core') return true;

  const role = normalized(exercise.slotRole ?? exercise.slot_role ?? exercise._role);
  if (role === 'core') return true;

  const prescription = normalized(
    exercise.prescriptionType
      ?? exercise.prescription_type
      ?? exercise._prescription_type,
  );
  if (prescription === 'core circuit' || prescription.startsWith('core ')) return true;

  const slot = normalized(exercise.slotLabel ?? exercise.slot_label ?? exercise._slot);
  return /\bcore\b/.test(slot);
}

export function displayFocusForExercises(
  focus: string | null | undefined,
  exercises: readonly WorkoutFocusExercise[] | null | undefined,
): string {
  const rawFocus = String(focus || 'Workout').trim() || 'Workout';
  if (!PLUS_CARDIO_RE.test(rawFocus)) return rawFocus;

  const baseFocus = withoutPlusCardio(rawFocus) || 'Workout';
  const rows = Array.isArray(exercises) ? exercises : [];
  if (rows.some(isCardioExercise)) return rawFocus;
  if (rows.some(isCoreExercise)) return `${baseFocus} + Core`;
  return baseFocus;
}

export function displayFocusForWorkout(workout: WorkoutFocusInput | null | undefined): string {
  return displayFocusForExercises(workout?.focus, workout?.exercises);
}
