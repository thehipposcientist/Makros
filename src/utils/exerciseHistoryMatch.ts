export type ExerciseHistoryMatchInput = string | {
  name?: string | null;
  equipment?: string | null;
  slug?: string | null;
};

function exerciseHistoryInputName(input: ExerciseHistoryMatchInput): string {
  return typeof input === 'string' ? input : String(input?.name ?? input?.slug ?? '');
}

function exerciseHistoryInputEquipment(input: ExerciseHistoryMatchInput): string {
  return typeof input === 'string' ? '' : String(input?.equipment ?? '');
}

export function normalizeExerciseHistoryName(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\bpull\s+downs?\b/g, 'pulldown')
    .replace(/\bpulldowns\b/g, 'pulldown')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(?:barbell|dumbbell|dumbbells|machine|cable|smith|bodyweight|weighted)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Equipment classes that materially change which load number is correct.
// "Single-Arm Dumbbell Bench Press" must NOT inherit history from
// "Barbell Bench Press" because the per-arm dumbbell load is a fraction
// of the barbell total.
const EQUIPMENT_CLASS_TOKENS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bbarbells?\b|\btrap\s*bar\b|\bez[- ]?curl\b|\blandmine\b/, 'barbell'],
  [/\bsmith\s*machine\b|\bsmith\b/, 'smith'],
  [/\bdumbbells?\b/, 'dumbbell'],
  [/\bkettlebells?\b/, 'kettlebell'],
  [/\bcables?\b/, 'cable'],
  [/\bmachine\b/, 'machine'],
  [/\bbands?\b|\bresistance\s*bands?\b/, 'band'],
  [/\bbody\s*weight\b|\bbodyweight\b/, 'bodyweight'],
];

// Some canonical exercise names are historically displayed without the
// implement, but in gym convention they mean the barbell version.
const IMPLIED_BARBELL_NAMES = new Set([
  'bench press',
  'back squat',
  'front squat',
  'squat',
  'deadlift',
  'romanian deadlift',
  'rdl',
  'overhead press',
  'military press',
  'strict press',
  'barbell row',
  'bent over row',
  'pendlay row',
]);

function _looseLower(name: string): string {
  return String(name ?? '').toLowerCase().replace(/[_-]+/g, ' ');
}

function extractEquipmentClass(input: ExerciseHistoryMatchInput): string | null {
  const equipment = _looseLower(exerciseHistoryInputEquipment(input));
  for (const [re, label] of EQUIPMENT_CLASS_TOKENS) {
    if (re.test(equipment)) return label;
  }
  const lower = _looseLower(exerciseHistoryInputName(input));
  for (const [re, label] of EQUIPMENT_CLASS_TOKENS) {
    if (re.test(lower)) return label;
  }
  const impliedName = normalizeExerciseHistoryName(lower);
  if (IMPLIED_BARBELL_NAMES.has(impliedName)) return 'barbell';
  return null;
}

const LATERALITY_RE = /\b(?:single|one|alt(?:ernating)?|unilateral|iso(?:lateral)?)\s+(?:arm|leg|side|hand|sided)\b|\bsuitcase\b/;

function hasLateralityToken(input: ExerciseHistoryMatchInput): boolean {
  return LATERALITY_RE.test(_looseLower(exerciseHistoryInputName(input)));
}

function latPulldownVariantSignature(input: ExerciseHistoryMatchInput): string | null {
  const lower = _looseLower(exerciseHistoryInputName(input))
    .replace(/\bpull\s+downs?\b/g, 'pulldown')
    .replace(/\bpulldowns\b/g, 'pulldown');
  if (!/\bpulldown\b/.test(lower)) return null;
  const modifiers = new Set<string>();
  if (/\bwide\b/.test(lower)) modifiers.add('wide');
  if (/\b(?:close|narrow)\b/.test(lower)) modifiers.add('close');
  if (/\bneutral\b/.test(lower)) modifiers.add('neutral');
  if (/\b(?:reverse|underhand|supinated)\b/.test(lower)) modifiers.add('underhand');
  if (/\b(?:overhand|pronated)\b/.test(lower)) modifiers.add('overhand');
  if (/\bkneeling\b/.test(lower)) modifiers.add('kneeling');
  if (/\b(?:straight|stiff)\s+arm\b/.test(lower)) modifiers.add('straight_arm');
  if (hasLateralityToken(input)) modifiers.add('unilateral');
  return [...modifiers].sort().join('|');
}

function hasLatPulldownVariantConflict(
  a: ExerciseHistoryMatchInput,
  b: ExerciseHistoryMatchInput,
): boolean {
  const variantA = latPulldownVariantSignature(a);
  const variantB = latPulldownVariantSignature(b);
  return variantA !== null && variantB !== null && variantA !== variantB;
}

export function exerciseHistoryEntriesMatch(
  a: ExerciseHistoryMatchInput,
  b: ExerciseHistoryMatchInput,
): boolean {
  const nameA = exerciseHistoryInputName(a);
  const nameB = exerciseHistoryInputName(b);
  const exactA = String(nameA ?? '').trim().toLowerCase();
  const exactB = String(nameB ?? '').trim().toLowerCase();
  if (!exactA || !exactB) return false;

  const equipA = extractEquipmentClass(a);
  const equipB = extractEquipmentClass(b);
  if (equipA && equipB && equipA !== equipB) return false;

  if (hasLateralityToken(a) !== hasLateralityToken(b)) return false;
  if (hasLatPulldownVariantConflict(a, b)) return false;
  if (exactA === exactB) return true;

  const normA = normalizeExerciseHistoryName(nameA);
  const normB = normalizeExerciseHistoryName(nameB);
  if (!normA || !normB) return false;
  if (normA === normB) return true;

  const shorter = normA.length <= normB.length ? normA : normB;
  const longer = normA.length > normB.length ? normA : normB;
  return shorter.split(' ').length >= 2 && longer.includes(shorter);
}

export function exerciseHistoryNamesMatch(a: string, b: string): boolean {
  return exerciseHistoryEntriesMatch(a, b);
}
