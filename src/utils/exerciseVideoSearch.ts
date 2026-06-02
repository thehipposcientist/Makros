export type ExerciseVideoGear = {
  slug?: string | null;
  name?: string | null;
  category?: string | null;
  required?: boolean | null;
  role?: string | null;
};

export type ExerciseVideoSearchSource = {
  name?: string | null;
  equipment?: string | null;
  gear?: ExerciseVideoGear[] | null;
};

const BROAD_EQUIPMENT_LABELS = new Set([
  'full',
  'full gym',
  'gym',
  'home',
  'home friendly',
  'home-friendly',
  'minimal',
  'minimal equipment',
  'other',
  'cardio',
  'none',
]);

const EQUIPMENT_SEARCH_PHRASES: Record<string, string> = {
  adjustable_dumbbells: 'dumbbell',
  barbell: 'barbell',
  bodyweight: 'bodyweight',
  cable_machine: 'cable',
  single_cable_station: 'cable',
  dual_cable_station: 'cable',
  dumbbells: 'dumbbell',
  ez_curl_bar: 'EZ bar',
  kettlebell: 'kettlebell',
  kettlebells: 'kettlebell',
  landmine_attachment: 'landmine',
  lat_pulldown_machine: 'lat pulldown machine',
  leg_curl_machine: 'leg curl machine',
  leg_extension_machine: 'leg extension machine',
  mini_band: 'mini band',
  pull_up_bar: 'pull-up bar',
  resistance_bands: 'resistance band',
  smith_machine: 'Smith machine',
  suspension_trainer: 'suspension trainer',
  trap_bar: 'trap bar',
  weighted_vest: 'weighted vest',
  weight_plates: 'weight plate',
};

const EQUIPMENT_FAMILIES = [
  new Set(['band', 'bands', 'resistance', 'mini', 'loop']),
  new Set(['dumbbell', 'dumbbells', 'db']),
  new Set(['barbell', 'bb']),
  new Set(['cable', 'cables', 'pulley']),
  new Set(['machine', 'selectorized', 'hammer']),
  new Set(['kettlebell', 'kettlebells', 'kb']),
  new Set(['bodyweight', 'calisthenic', 'calisthenics', 'no-equipment']),
];

function tokenize(value?: string | null): string[] {
  return String(value ?? '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function equipmentFamilyTokens(value?: string | null): Set<string> | null {
  const tokens = new Set(tokenize(value));
  if (tokens.size === 0) return null;
  return EQUIPMENT_FAMILIES.find(family => [...tokens].some(token => family.has(token))) ?? null;
}

function humanizeEquipment(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function cleanEquipmentPhrase(equipment?: string | null): string | null {
  const raw = String(equipment ?? '').trim();
  if (!raw) return null;
  for (const part of raw.split(/[,/|]+/)) {
    const label = part.trim();
    if (!label) continue;
    const key = label.toLowerCase().replace(/[-\s]+/g, '_');
    const normalizedLabel = label.toLowerCase().replace(/_/g, ' ').trim();
    if (BROAD_EQUIPMENT_LABELS.has(key) || BROAD_EQUIPMENT_LABELS.has(normalizedLabel)) {
      continue;
    }
    return EQUIPMENT_SEARCH_PHRASES[key] ?? humanizeEquipment(label);
  }
  return null;
}

function gearSortKey(item: ExerciseVideoGear): string {
  const role = String(item.role ?? 'primary').toLowerCase();
  const roleRank = role === 'primary' ? 0 : role === 'support' ? 1 : role === 'optional' ? 2 : 9;
  const requiredRank = item.required === false ? 1 : 0;
  return `${roleRank}:${requiredRank}:${item.name ?? item.slug ?? ''}`;
}

export function preferredExerciseVideoEquipment(exercise?: ExerciseVideoSearchSource | null): string | null {
  const gear = (exercise?.gear ?? [])
    .filter(item => item && (item.name || item.slug))
    .slice()
    .sort((a, b) => gearSortKey(a).localeCompare(gearSortKey(b)));
  const preferredGear = gear[0];
  if (preferredGear?.name || preferredGear?.slug) {
    return preferredGear.name ?? preferredGear.slug ?? null;
  }
  return cleanEquipmentPhrase(exercise?.equipment ?? null);
}

export function buildExerciseVideoSearchQuery(exerciseName: string, equipment?: string | null): string {
  const name = exerciseName.trim();
  const phrase = cleanEquipmentPhrase(equipment);
  if (!phrase) return `${name} proper form tutorial`;

  const nameTokens = new Set(tokenize(name));
  const phraseTokens = new Set(tokenize(phrase));
  const nameFamily = equipmentFamilyTokens(name);
  const phraseFamily = equipmentFamilyTokens(phrase);
  const duplicatesName = phraseTokens.size > 0 && [...phraseTokens].every(token => nameTokens.has(token));
  const duplicatesFamily = !!nameFamily && !!phraseFamily && nameFamily === phraseFamily;
  if (duplicatesName || duplicatesFamily) {
    return `${name} proper form tutorial`;
  }
  return `${phrase} ${name} proper form tutorial`;
}

export function buildExerciseVideoSearchUrl(exerciseName: string, equipment?: string | null): string {
  return `https://m.youtube.com/results?search_query=${encodeURIComponent(
    buildExerciseVideoSearchQuery(exerciseName, equipment),
  )}`;
}
