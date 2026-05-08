import type { ImageSourcePropType } from 'react-native';

export type EquipmentVisualInput =
  | string
  | {
      slug?: string | null;
      name?: string | null;
      aliases?: string[] | null;
      category?: string | null;
      icon?: string | null;
    }
  | null
  | undefined;

export interface ExerciseEquipmentMatchInput {
  name?: string | null;
  equipment?: string | null;
  gear?: Array<{
    slug?: string | null;
    name?: string | null;
    category?: string | null;
    required?: boolean | null;
  }> | null;
}

const EQUIPMENT_IMAGE_ALIASES: Array<{ keys: string[]; source: ImageSourcePropType }> = [
  {
    keys: [
      'smith_machine',
      'smith machine',
    ],
    source: require('../../ChatGPT Image May 8, 2026, 03_48_05 AM (1).png'),
  },
  {
    keys: [
      'pec_deck_machine',
      'pec deck machine',
      'pec dec machine',
      'pectoral fly machine',
      'pectorla fly machine',
      'chest fly machine',
      'pec fly machine',
      'pec deck',
      'pec dec',
      'pectoral fly',
    ],
    source: require('../../Pec Dec Machine.png'),
  },
  {
    keys: [
      'plate_loaded_chest_press_machine',
      'plate loaded chest press machine',
      'plate loaded incline press machine',
      'iso lateral incline press',
      'iso lateral chest press',
      'hammer strength incline press',
      'hammer strength chest press',
      'leverage chest press machine',
      'incline chest press machine',
    ],
    source: require('../../ChatGPT Image May 8, 2026, 04_11_24 AM (1).png'),
  },
];

const IMAGE_BY_KEY = new Map<string, ImageSourcePropType>();
for (const entry of EQUIPMENT_IMAGE_ALIASES) {
  for (const key of entry.keys) {
    IMAGE_BY_KEY.set(normalizeEquipmentKey(key), entry.source);
  }
}

export function normalizeEquipmentKey(value: string | null | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[_/]+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function equipmentCandidateKeys(input: EquipmentVisualInput): string[] {
  if (!input) return [];
  if (typeof input === 'string') return [normalizeEquipmentKey(input)].filter(Boolean);
  return [
    input.slug,
    input.name,
    ...(input.aliases ?? []),
  ].map(normalizeEquipmentKey).filter(Boolean);
}

export function equipmentDisplayName(input: EquipmentVisualInput): string {
  if (!input) return '';
  if (typeof input === 'string') return input;
  return input.name || input.slug || '';
}

export function getEquipmentImageSource(input: EquipmentVisualInput): ImageSourcePropType | null {
  const candidates = equipmentCandidateKeys(input);
  for (const key of candidates) {
    const exact = IMAGE_BY_KEY.get(key);
    if (exact) return exact;
  }
  for (const key of candidates) {
    for (const [needle, source] of IMAGE_BY_KEY.entries()) {
      if (needle.length >= 6 && key.includes(needle)) return source;
      if (key.length >= 6 && needle.includes(key)) return source;
    }
  }
  return null;
}

export function hasEquipmentImage(input: EquipmentVisualInput): boolean {
  return !!getEquipmentImageSource(input);
}

function equipmentNeedles(input: EquipmentVisualInput): string[] {
  const keys = equipmentCandidateKeys(input);
  const expanded = new Set<string>();
  for (const key of keys) {
    expanded.add(key);
    expanded.add(key.replace(/\bmachine\b/g, '').trim());
    expanded.add(key.replace(/\bequipment\b/g, '').trim());
  }
  return [...expanded].filter(key => key.length > 0);
}

function exerciseEquipmentHaystack(exercise: ExerciseEquipmentMatchInput): string[] {
  const values: string[] = [
    exercise.equipment ?? '',
  ];
  for (const gear of exercise.gear ?? []) {
    values.push(gear.slug ?? '', gear.name ?? '');
  }
  return values.map(normalizeEquipmentKey).filter(Boolean);
}

export function equipmentMatchesExercise(
  equipment: EquipmentVisualInput,
  exercise: ExerciseEquipmentMatchInput,
): boolean {
  const needles = equipmentNeedles(equipment);
  if (needles.length === 0) return false;
  const haystack = exerciseEquipmentHaystack(exercise);
  if (haystack.length === 0) return false;

  for (const hay of haystack) {
    for (const needle of needles) {
      if (hay === needle) return true;
      if (needle.length >= 5 && hay.includes(needle)) return true;
      if (hay.length >= 5 && needle.includes(hay)) return true;
    }
  }
  return false;
}

export function matchesEquipmentSearch(equipment: EquipmentVisualInput, query: string): boolean {
  const tokens = normalizeEquipmentKey(query).split(' ').filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = equipmentCandidateKeys(equipment).join(' ');
  return tokens.every(token => haystack.includes(token));
}
