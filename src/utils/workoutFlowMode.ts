type FlowExercise = {
  name?: string | null;
  reps?: string | number | null;
  targetReps?: string | number | null;
  prescriptionType?: string | null;
  prescription_type?: string | null;
  flowCategory?: string | null;
  flow_category?: string | null;
  slotRole?: string | null;
  slot_role?: string | null;
  _role?: string | null;
  primaryMuscle?: string | null;
  primary_muscle?: string | null;
  movementPattern?: string | null;
  movement_pattern?: string | null;
};

type FlowWorkout = {
  focus?: string | null;
  stimulus?: string | null;
  exercises?: FlowExercise[] | null;
  _custom_activity_category?: string | null;
  _custom_cardio_subtype?: string | null;
};

const GUIDED_FLOW_PRESCRIPTIONS = new Set([
  'yoga_flow',
  'stretch_hold',
  'mobility',
]);

const FLOW_KEYWORD_RE = /\b(recover|recovery|mobility|stretch|stretching|yoga|flow|foam(?:\s|_|-)?roll|pilates|breathwork|breathing)\b/;
const FLOW_EXERCISE_NAME_RE = /\b(stretch|foam(?:\s|_|-)?roll|cat(?:\s|-)?cow|pigeon|child'?s pose|spinal twist|world'?s greatest|90\/90|90-90|thoracic|downward dog|cobra|butterfly|savasana|yoga|vinyasa|mobility|pose|breathwork|breathing|pilates)\b/;

export function exerciseFlowCategory(ex: FlowExercise | null | undefined): string | null {
  const category = ex?.flowCategory ?? ex?.flow_category ?? null;
  return typeof category === 'string' && category.trim().length > 0 ? category.trim() : null;
}

export function isRecoveryFlowWorkout(workout: FlowWorkout | null | undefined): boolean {
  const category = String(workout?._custom_activity_category ?? '').trim().toLowerCase();
  if (category === 'mobility' || category === 'recovery') return true;
  const stimulus = String(workout?.stimulus ?? '').trim().toLowerCase();
  if (stimulus === 'mobility' || stimulus === 'recovery') return true;
  const text = `${workout?.focus ?? ''} ${workout?._custom_cardio_subtype ?? ''}`.toLowerCase();
  return FLOW_KEYWORD_RE.test(text);
}

export function isGuidedFlowExercise(ex: FlowExercise | null | undefined): boolean {
  if (!ex) return false;
  if (exerciseFlowCategory(ex)) return true;

  const prescription = String(ex.prescriptionType ?? ex.prescription_type ?? '').toLowerCase();
  if (GUIDED_FLOW_PRESCRIPTIONS.has(prescription)) return true;

  const role = String(ex.slotRole ?? ex.slot_role ?? ex._role ?? '').toLowerCase();
  if (['mobility', 'recovery', 'stretch', 'cooldown'].includes(role)) return true;

  const primary = String(ex.primaryMuscle ?? ex.primary_muscle ?? '').toLowerCase();
  const pattern = String(ex.movementPattern ?? ex.movement_pattern ?? '').toLowerCase();
  if (primary === 'mobility' || pattern === 'mobility') return true;

  return FLOW_EXERCISE_NAME_RE.test(String(ex.name ?? '').toLowerCase());
}

export function isGuidedFlowSession(workout: FlowWorkout | null | undefined): boolean {
  const exercises = workout?.exercises ?? [];
  if (!Array.isArray(exercises) || exercises.length === 0) return false;

  const allFlowTaggedTimed = exercises.every(ex => {
    const prescription = String(ex?.prescriptionType ?? ex?.prescription_type ?? '').toLowerCase();
    return GUIDED_FLOW_PRESCRIPTIONS.has(prescription) && !!exerciseFlowCategory(ex);
  });
  if (allFlowTaggedTimed) return true;

  if (!isRecoveryFlowWorkout(workout)) return false;
  return exercises.every(isGuidedFlowExercise);
}

export function workoutStartActionLabel(workout: FlowWorkout | null | undefined): string {
  return isRecoveryFlowWorkout(workout) ? 'Start Flow' : 'Start Workout';
}
