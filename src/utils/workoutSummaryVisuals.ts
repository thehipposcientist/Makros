import type { ImageSourcePropType } from 'react-native';

type WorkoutVisualGender = 'male' | 'female' | 'neutral' | string | null | undefined;

export type WorkoutVisualInput = {
  focus?: string | null;
  stimulus?: string | null;
  exercises?: Array<{
    name?: string | null;
    primary_muscle?: string | null;
    primaryMuscle?: string | null;
  }> | null;
  activityCategory?: string | null;
  activitySubtype?: string | null;
  sourceContext?: string | null;
};

// Recap art is intentionally cross-mapped away from HomeScreen's plan-card
// primary image for the same workout type, so finishing a workout feels
// like a distinct artifact instead of a repeat of the scheduled card.
const WORKOUT_SUMMARY_BACKGROUNDS = {
  male: {
    press: require('../../assets/images/card-backgrounds/workout-card-free-weights-day-male.jpg'),
    row: require('../../assets/images/card-backgrounds/workout-card-pull-day-male.jpg'),
    pullup: require('../../assets/images/card-backgrounds/workout-card-pull-day-rowing.jpg'),
    // Legs-focus summary used to land on `workout-card-hinge-day-male.jpg`
    // (a deadlift photo) — wrong subject for a generic legs recap and
    // also the same image the plan tab uses for deadlift days. Using
    // the leg-extension photo instead: still legs-themed, currently
    // unused for the `squat` key in either map, keeps the cross-map
    // distinction from the plan-tab's legs image.
    squat: require('../../assets/images/card-backgrounds/workout-card-leg-extension-day-male.jpg'),
    deadlift: require('../../assets/images/card-backgrounds/workout-card-legs-day-male.jpg'),
    legExtension: require('../../assets/images/card-backgrounds/workout-card-free-weights-day-male.jpg'),
    dumbbell: require('../../assets/images/card-backgrounds/workout-card-push-day-male.jpg'),
    kettlebell: require('../../assets/images/card-backgrounds/workout-card-hinge-day-male.jpg'),
    hiit: require('../../assets/images/card-backgrounds/workout-card-treadmill-day-neutral.jpg'),
    pilates: require('../../assets/images/card-backgrounds/workout-card-pilates-day.jpg'),
    recovery: require('../../assets/images/card-backgrounds/workout-card-sauna-day.jpg'),
    cycling: require('../../assets/images/card-backgrounds/workout-card-hiit-day-male.jpg'),
    swimming: require('../../assets/images/card-backgrounds/workout-card-swimming-day-neutral.jpg'),
    running: require('../../assets/images/card-backgrounds/workout-card-treadmill-day-neutral.jpg'),
    walking: require('../../assets/images/card-backgrounds/workout-card-walking-day.jpg'),
    hiking: require('../../assets/images/card-backgrounds/workout-card-hiking-mountains-day.jpg'),
    treadmill: require('../../assets/images/card-backgrounds/workout-card-running-day-male.jpg'),
    sauna: require('../../assets/images/card-backgrounds/workout-card-sauna-day.jpg'),
    combat: require('../../assets/images/card-backgrounds/workout-card-martial-arts-day.jpg'),
    sport: require('../../assets/images/card-backgrounds/workout-card-soccer-day.jpg'),
    active: require('../../assets/images/card-backgrounds/workout-card-yard-work-day.jpg'),
    gym: require('../../assets/images/card-backgrounds/workout-card-generic-gym-day-neutral.jpg'),
  },
  female: {
    press: require('../../assets/images/card-backgrounds/workout-card-free-weights-day-female.jpg'),
    row: require('../../assets/images/card-backgrounds/workout-card-pull-day-male.jpg'),
    pullup: require('../../assets/images/card-backgrounds/workout-card-pull-day-male.jpg'),
    squat: require('../../assets/images/card-backgrounds/workout-card-leg-extension-day-female.jpg'),
    deadlift: require('../../assets/images/card-backgrounds/workout-card-legs-day-female.jpg'),
    legExtension: require('../../assets/images/card-backgrounds/workout-card-free-weights-day-female.jpg'),
    dumbbell: require('../../assets/images/card-backgrounds/workout-card-push-day-female.jpg'),
    kettlebell: require('../../assets/images/card-backgrounds/workout-card-hinge-day-female.jpg'),
    hiit: require('../../assets/images/card-backgrounds/workout-card-treadmill-day-female.jpg'),
    pilates: require('../../assets/images/card-backgrounds/workout-card-pilates-day.jpg'),
    recovery: require('../../assets/images/card-backgrounds/workout-card-sauna-day.jpg'),
    cycling: require('../../assets/images/card-backgrounds/workout-card-hiit-day-female.jpg'),
    swimming: require('../../assets/images/card-backgrounds/workout-card-swimming-day-neutral.jpg'),
    running: require('../../assets/images/card-backgrounds/workout-card-treadmill-day-female.jpg'),
    walking: require('../../assets/images/card-backgrounds/workout-card-walking-day.jpg'),
    hiking: require('../../assets/images/card-backgrounds/workout-card-hiking-mountains-day.jpg'),
    treadmill: require('../../assets/images/card-backgrounds/workout-card-running-day-female.jpg'),
    sauna: require('../../assets/images/card-backgrounds/workout-card-sauna-day.jpg'),
    combat: require('../../assets/images/card-backgrounds/workout-card-martial-arts-day.jpg'),
    sport: require('../../assets/images/card-backgrounds/workout-card-soccer-day.jpg'),
    active: require('../../assets/images/card-backgrounds/workout-card-yard-work-day.jpg'),
    gym: require('../../assets/images/card-backgrounds/workout-card-generic-gym-day-neutral.jpg'),
  },
  neutral: {
    press: require('../../assets/images/card-backgrounds/workout-card-free-weights-day-male.jpg'),
    row: require('../../assets/images/card-backgrounds/workout-card-pull-day-male.jpg'),
    pullup: require('../../assets/images/card-backgrounds/workout-card-pull-day-rowing.jpg'),
    squat: require('../../assets/images/card-backgrounds/workout-card-leg-extension-day-male.jpg'),
    deadlift: require('../../assets/images/card-backgrounds/workout-card-legs-day-male.jpg'),
    legExtension: require('../../assets/images/card-backgrounds/workout-card-free-weights-day-female.jpg'),
    dumbbell: require('../../assets/images/card-backgrounds/workout-card-push-day-male.jpg'),
    kettlebell: require('../../assets/images/card-backgrounds/workout-card-hinge-day-female.jpg'),
    hiit: require('../../assets/images/card-backgrounds/workout-card-treadmill-day-neutral.jpg'),
    pilates: require('../../assets/images/card-backgrounds/workout-card-pilates-day.jpg'),
    recovery: require('../../assets/images/card-backgrounds/workout-card-sauna-day.jpg'),
    cycling: require('../../assets/images/card-backgrounds/workout-card-hiit-day-male.jpg'),
    swimming: require('../../assets/images/card-backgrounds/workout-card-swimming-day-male.jpg'),
    running: require('../../assets/images/card-backgrounds/workout-card-treadmill-day-neutral.jpg'),
    walking: require('../../assets/images/card-backgrounds/workout-card-walking-day.jpg'),
    hiking: require('../../assets/images/card-backgrounds/workout-card-hiking-mountains-day.jpg'),
    treadmill: require('../../assets/images/card-backgrounds/workout-card-running-day-male.jpg'),
    sauna: require('../../assets/images/card-backgrounds/workout-card-sauna-day.jpg'),
    combat: require('../../assets/images/card-backgrounds/workout-card-martial-arts-day.jpg'),
    sport: require('../../assets/images/card-backgrounds/workout-card-soccer-day.jpg'),
    active: require('../../assets/images/card-backgrounds/workout-card-yard-work-day.jpg'),
    gym: require('../../assets/images/card-backgrounds/workout-card-free-weights-day-female.jpg'),
  },
} as const;

export type WorkoutSummaryBackgroundKey = keyof typeof WORKOUT_SUMMARY_BACKGROUNDS.male;

const FOCUS_KEY_PATTERNS: [RegExp, string][] = [
  [/\bpush\b/, 'push'], [/\bchest\b|\bpecs?\b/, 'chest'], [/\bpress(?:ing)?\b/, 'push'],
  [/\bpull\b/, 'pull'], [/\bback\b/, 'back'], [/\bbiceps?\b/, 'pull'], [/\blats?\b/, 'pull'],
  [/\blegs?\b/, 'legs'], [/\bquads?\b/, 'legs'], [/\bhamstrings?\b/, 'legs'], [/\bglutes?\b/, 'legs'], [/\blower(?:\s+body)?\b/, 'lower'],
  [/\bupper(?:\s+body)?\b/, 'upper'],
  [/\bfull\s+body\b/, 'full_body'], [/\btotal(?:\s+body)?\b/, 'full_body'],
  [/\bshoulders?\b/, 'shoulders'],
  [/\barms?\b/, 'arms'],
  [/\bcardio\b/, 'cardio'], [/\bzone\s*2\b/, 'cardio'], [/\bintervals?\b/, 'cardio'],
];

const STRENGTH_FOCUS_KEYS = new Set([
  'push',
  'chest',
  'pull',
  'back',
  'legs',
  'lower',
  'upper',
  'full_body',
  'shoulders',
  'arms',
]);

const CORE_STRENGTH_RE = /\b(core|abs?|abdominal|oblique)s?\b|crunch|plank|sit[- ]?up|russian twist|leg raise|knee raise|hollow|woodchop|woodchopper|pallof|dead bug|bird dog/i;
const CARDIO_TEXT_RE = /\b(cardio|zone ?2|interval|hiit|metcon|run|jog|sprint|walk|walking|hike|hiking|treadmill|cycle|cycling|bike|ride|spin|swim|swimming|pool|row|elliptical|stair)\b/;
const ACTIVITY_INTENT_RE = /\b(cardio|conditioning|zone ?2|intervals?|hiit|metcon|circuit|run|running|jog|jogging|sprint|walk|walking|hike|hiking|trail|treadmill|cycle|cycling|bike|ride|spin|swim|swimming|pool|row|rowing|elliptical|stair)\b/;

function backgroundGender(gender: WorkoutVisualGender): keyof typeof WORKOUT_SUMMARY_BACKGROUNDS {
  return gender === 'male' || gender === 'female' ? gender : 'neutral';
}

function resolveFocusKey(focus: string): string | null {
  const lower = focus
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
  for (const [pattern, key] of FOCUS_KEY_PATTERNS) {
    if (pattern.test(lower)) return key;
  }
  return null;
}

function primaryFocusSegment(focus: string): string {
  return focus.split(/\s*\+\s*/)[0]?.trim() ?? focus;
}

function strengthBackgroundKeyForFocusKey(focusKey: string | null): WorkoutSummaryBackgroundKey | null {
  if (focusKey === 'legs' || focusKey === 'lower') return 'squat';
  if (focusKey === 'push' || focusKey === 'chest' || focusKey === 'shoulders' || focusKey === 'arms') return 'press';
  if (focusKey === 'pull' || focusKey === 'back') return 'row';
  if (focusKey === 'upper') return 'press';
  if (focusKey === 'full_body') return 'gym';
  return null;
}

function strengthBackgroundKeyForText(text: string): WorkoutSummaryBackgroundKey | null {
  if (/\b(deadlift|rdl|romanian|hinge|hip thrust|good morning)\b/.test(text)) return 'deadlift';
  if (/\b(pull ?up|chin ?up)\b/.test(text)) return 'pullup';
  if (/\b(kettlebell|kb swing|goblet)\b/.test(text)) return 'kettlebell';
  if (/\b(dumbbell|db |curl|lateral raise)\b/.test(text)) return 'dumbbell';
  if (/\b(farmer'?s?\s+(walk|carry)|loaded carry|suitcase carry)\b/.test(text)) return 'dumbbell';
  if (/\b(bench|press|push|chest|tricep|shoulder)\b/.test(text)) return 'press';
  if (/\b(row|pull|lat|back|bicep)\b/.test(text)) return 'row';
  if (/\b(leg extension|quad|quads)\b/.test(text)) return 'legExtension';
  if (/\b(squat|lunge|calf|monster walk|lateral band walk)\b/.test(text)) return 'squat';
  if (/\b(hamstring|glute)\b/.test(text)) return 'deadlift';
  return null;
}

function unambiguousStrengthBackgroundKeyForText(text: string): WorkoutSummaryBackgroundKey | null {
  if (/\b(deadlift|rdl|romanian|hinge|hip thrust|good morning)\b/.test(text)) return 'deadlift';
  if (/\b(farmer'?s?\s+(walk|carry)|loaded carry|suitcase carry)\b/.test(text)) return 'dumbbell';
  if (/\b(leg extension|quad|quads)\b/.test(text)) return 'legExtension';
  if (/\b(squat|lunge|calf|monster walk|lateral band walk)\b/.test(text)) return 'squat';
  if (/\b(hamstring|glute)\b/.test(text)) return 'deadlift';
  return null;
}

function strengthTypeLabelForFocusKey(focusKey: string | null): string | null {
  if (focusKey === 'legs' || focusKey === 'lower') return 'Lower Body';
  if (focusKey === 'upper') return 'Upper Body';
  if (focusKey === 'full_body') return 'Full Body';
  if (focusKey === 'shoulders') return 'Shoulders';
  if (focusKey === 'arms') return 'Arms';
  if (focusKey === 'chest') return 'Chest';
  if (focusKey === 'back') return 'Back';
  if (focusKey === 'push') return 'Push';
  if (focusKey === 'pull') return 'Pull';
  return null;
}

function workoutSummaryLooksCoreStrength(input: WorkoutVisualInput): boolean {
  const category = String(input.activityCategory ?? '').toLowerCase();
  if (category && category !== 'cardio' && category !== 'strength') return false;
  const focus = String(input.focus ?? '').toLowerCase();
  const subtype = String(input.activitySubtype ?? '').toLowerCase();
  const exerciseText = (input.exercises ?? [])
    .slice(0, 4)
    .map(ex => `${ex.name ?? ''} ${ex.primary_muscle ?? ex.primaryMuscle ?? ''}`)
    .join(' ')
    .toLowerCase();
  const text = `${focus} ${subtype} ${exerciseText}`;
  return CORE_STRENGTH_RE.test(text) && !CARDIO_TEXT_RE.test(text);
}

export function workoutSummaryBackgroundKey(input: WorkoutVisualInput): WorkoutSummaryBackgroundKey {
  const focus = String(input.focus ?? '').toLowerCase();
  const stimulus = String(input.stimulus ?? '').toLowerCase();
  const category = String(input.activityCategory ?? '').toLowerCase();
  const subtype = String(input.activitySubtype ?? '').toLowerCase();
  const sourceContext = String(input.sourceContext ?? '').toLowerCase();
  const exerciseText = (input.exercises ?? [])
    .slice(0, 4)
    .map(ex => `${ex.name ?? ''} ${ex.primary_muscle ?? ex.primaryMuscle ?? ''}`)
    .join(' ')
    .toLowerCase();
  const text = `${focus} ${stimulus} ${category} ${subtype} ${sourceContext} ${exerciseText}`;
  const focusKey = resolveFocusKey(focus);
  const primaryFocusKey = resolveFocusKey(primaryFocusSegment(focus));
  const primaryStrengthKey = focus.includes('+') && primaryFocusKey && STRENGTH_FOCUS_KEYS.has(primaryFocusKey)
    ? primaryFocusKey
    : null;
  const focusHasActivityIntent = ACTIVITY_INTENT_RE.test(focus);
  const declaredStrengthFocus = !!focusKey && STRENGTH_FOCUS_KEYS.has(focusKey) && !focusHasActivityIntent;

  if (workoutSummaryLooksCoreStrength(input) && !declaredStrengthFocus) {
    return 'gym';
  }

  if (/\b(boxing|kickboxing|martial|martial_arts|mma|sparring|bag work|heavy bag|shadow boxing)\b/.test(text)) {
    return 'combat';
  }
  if (category === 'sport' || /\b(soccer|basketball|tennis|pickleball|volleyball|golf|climbing|skiing|surfing)\b/.test(text)) {
    return 'sport';
  }
  if (category === 'active' || /\b(yard|garden|gardening|house cleaning|cleaning|construction|shoveling|moving|lifting|chopping|wood|dancing|kids)\b/.test(text)) {
    return 'active';
  }
  if (/\b(sauna|cold plunge|ice bath|contrast|breathwork)\b/.test(text)) {
    return 'sauna';
  }
  if (category === 'cardio' || category === 'recovery' || category === 'mobility') {
    const activityText = `${category} ${subtype}`;
    if (/\b(swim|swimming|pool)\b/.test(activityText)) return 'swimming';
    if (/\b(cycle|cycling|bike|ride|spin)\b/.test(activityText)) return 'cycling';
    if (/\b(hike|hiking|trail)\b/.test(activityText)) return 'hiking';
    if (/\b(walk|walking)\b/.test(activityText)) return 'walking';
    if (/\b(run|running|jog|jogging|sprint)\b/.test(activityText)) return 'running';
    if (/\b(treadmill|elliptical|stair|row|rowing)\b/.test(activityText)) return 'treadmill';
    if (/\b(hiit|metcon|circuit|rope|battle rope|interval)\b/.test(activityText)) return 'hiit';
    if (category === 'cardio') return 'treadmill';
  }
  const primaryStrengthBackground = strengthBackgroundKeyForFocusKey(primaryStrengthKey);
  if (primaryStrengthBackground) return primaryStrengthBackground;
  if (/\bpilates\b/.test(text)) {
    return 'pilates';
  }
  if (category === 'recovery' || stimulus === 'recovery' || /\b(recover|recovery|mobility|stretch|stretching|yoga|flow|rest|meditation)\b/.test(text)) {
    return 'recovery';
  }
  if (!focusHasActivityIntent) {
    const focusStrengthBackground = strengthBackgroundKeyForFocusKey(focusKey);
    if (focusStrengthBackground) return focusStrengthBackground;
  }
  const exerciseStrengthBackground = strengthBackgroundKeyForText(exerciseText);
  if (exerciseStrengthBackground) return exerciseStrengthBackground;
  const focusStrengthBackground = focusHasActivityIntent
    ? unambiguousStrengthBackgroundKeyForText(focus)
    : strengthBackgroundKeyForText(`${focus} ${stimulus}`);
  if (focusStrengthBackground) return focusStrengthBackground;
  if (category === 'cardio' || stimulus === 'conditioning' || /\b(cardio|zone ?2|interval|hiit|metcon|circuit|rope|battle rope|run|jog|sprint|walk|walking|hike|hiking|treadmill|cycle|cycling|bike|ride|spin|swim|swimming|pool|row|elliptical|stair)\b/.test(text)) {
    if (/\b(swim|swimming|pool)\b/.test(text)) return 'swimming';
    if (/\b(cycle|cycling|bike|ride|spin)\b/.test(text)) return 'cycling';
    if (/\b(treadmill|elliptical|stair|row)\b/.test(text)) return 'treadmill';
    if (/\b(run|jog|sprint)\b/.test(text)) return 'running';
    if (/\b(hike|hiking|trail)\b/.test(text)) return 'hiking';
    if (/\b(walk|walking)\b/.test(text)) return 'walking';
    if (/\b(hiit|metcon|circuit|rope|battle rope|interval)\b/.test(text)) return 'hiit';
    return 'treadmill';
  }

  return 'gym';
}

export function workoutSummaryIsCardioLike(input: WorkoutVisualInput): boolean {
  const category = String(input.activityCategory ?? '').toLowerCase();
  if (workoutSummaryLooksCoreStrength(input)) {
    return false;
  }
  if (category === 'cardio' || category === 'sport' || category === 'active' || category === 'mobility') {
    return true;
  }
  const key = workoutSummaryBackgroundKey(input);
  return key === 'running'
    || key === 'walking'
    || key === 'hiking'
    || key === 'cycling'
    || key === 'swimming'
    || key === 'treadmill'
    || key === 'combat'
    || key === 'hiit';
}

export function workoutSummaryBackgroundSource(
  input: WorkoutVisualInput,
  gender?: WorkoutVisualGender,
): ImageSourcePropType {
  return WORKOUT_SUMMARY_BACKGROUNDS[backgroundGender(gender)][workoutSummaryBackgroundKey(input)];
}

export function workoutSummaryTypeLabel(input: WorkoutVisualInput): string {
  const key = workoutSummaryBackgroundKey(input);
  const category = String(input.activityCategory ?? '').toLowerCase();
  const focus = String(input.focus ?? '');
  const primaryFocusKey = resolveFocusKey(primaryFocusSegment(focus));
  const focusKey = primaryFocusKey ?? resolveFocusKey(focus);
  if (key === 'combat') return 'Combat';
  if (category === 'sport') return 'Sport';
  if (category === 'active' || key === 'active') return 'Active';
  if (key === 'sauna') return 'Recovery';
  if (key === 'running') return 'Run';
  if (key === 'walking') return 'Walk';
  if (key === 'hiking') return 'Hike';
  if (key === 'cycling') return 'Ride';
  if (key === 'swimming') return 'Swim';
  if (key === 'treadmill') return category === 'cardio' || focusKey === 'cardio' ? 'Cardio' : 'Conditioning';
  if (key === 'hiit') return 'Intervals';
  if (key === 'pilates') return 'Pilates';
  if (key === 'recovery') return category === 'mobility' ? 'Mobility' : 'Recovery';
  const strengthLabel = strengthTypeLabelForFocusKey(focusKey);
  if (strengthLabel) return strengthLabel;
  if (key === 'squat' || key === 'deadlift' || key === 'legExtension') return 'Lower Body';
  if (key === 'row' || key === 'pullup') return 'Pull';
  if (key === 'press') return 'Push';
  return 'Strength';
}

export function workoutSummaryIconName(input: WorkoutVisualInput): string {
  const key = workoutSummaryBackgroundKey(input);
  if (key === 'sauna') return 'thermometer-outline';
  if (key === 'combat') return 'shield-outline';
  if (key === 'sport') return 'football-outline';
  if (key === 'active') return 'hammer-outline';
  if (key === 'running' || key === 'walking' || key === 'hiking') return 'footsteps-outline';
  if (key === 'cycling') return 'bicycle-outline';
  if (key === 'swimming') return 'water-outline';
  if (key === 'treadmill' || key === 'hiit') return 'pulse-outline';
  if (key === 'pilates') return 'body-outline';
  if (key === 'recovery') return 'leaf-outline';
  return 'barbell-outline';
}
