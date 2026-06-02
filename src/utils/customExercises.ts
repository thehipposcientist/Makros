import type { CustomExerciseItem } from '../types';

export const CUSTOM_EXERCISE_PRIMARY_MUSCLES = [
  'chest',
  'back',
  'shoulders',
  'biceps',
  'triceps',
  'quads',
  'hamstrings',
  'glutes',
  'calves',
  'core',
  'cardio',
  'full_body',
] as const;

export type CustomExercisePrimaryMuscle = typeof CUSTOM_EXERCISE_PRIMARY_MUSCLES[number];

export const CUSTOM_EXERCISE_PROGRAMMING_TAGS = [
  'favorite',
  'warmup',
  'finisher',
  'pump',
  'heavy_friendly',
  'volume_friendly',
  'joint_friendly',
  'unilateral',
  'machine',
] as const;

export type CustomExerciseProgrammingTag = typeof CUSTOM_EXERCISE_PROGRAMMING_TAGS[number];

export function customExerciseTagLabel(tag: string): string {
  switch (tag) {
    case 'heavy_friendly': return 'Heavy-friendly';
    case 'volume_friendly': return 'Volume-friendly';
    case 'joint_friendly': return 'Joint-friendly';
    default:
      return tag
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
  }
}

export function normalizeCustomExerciseProgrammingTags(value: unknown): string[] {
  const allowed = new Set<string>(CUSTOM_EXERCISE_PROGRAMMING_TAGS);
  const raw = Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const item of raw) {
    const tag = String(item ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!allowed.has(tag) || out.includes(tag)) continue;
    out.push(tag);
  }
  return out;
}

export type ManualCustomExerciseInput = {
  name: string;
  equipment: string;
  equipmentSlugs?: string[];
  equipmentBucket?: string | null;
  primaryMuscle: string;
  secondaryMuscles?: string[];
  sets?: number;
  reps?: string;
  restSeconds?: number;
  defaultTrackingMode?: CustomExerciseItem['default_tracking_mode'];
  isCompound?: boolean | null;
  movementPattern?: string | null;
  description?: string;
  formCues?: string[];
  aliases?: string[];
  programmingTags?: string[];
  imageUrl?: string | null;
  videoId?: string | null;
  demoExerciseDbId?: string | null;
  source?: CustomExerciseItem['source'];
  planEligible?: boolean;
  aiConfidence?: CustomExerciseItem['ai_confidence'];
  validationStatus?: CustomExerciseItem['validation_status'];
};

export type AiExerciseLike = {
  name: string;
  primary_muscle?: string | null;
  secondary_muscles?: string[] | null;
  equipment?: string | null;
  movement_pattern?: string | null;
  is_compound?: boolean | null;
  image_url?: string | null;
  video_id?: string | null;
  demo_exercise_db_id?: string | null;
  sets?: number | null;
  reps?: string | null;
  rest_seconds?: number | null;
  why?: string | null;
  form_cues?: string[] | null;
  aliases?: string[] | null;
};

export function normalizeExerciseNameKey(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function createManualCustomExercise(input: ManualCustomExerciseInput): CustomExerciseItem {
  const name = input.name.trim();
  const equipment = input.equipment.trim();
  const reps = String(input.reps ?? '').trim() || '8-12';
  const sets = Number(input.sets);
  const restSeconds = Number(input.restSeconds);
  const secondaryMuscles = (input.secondaryMuscles ?? [])
    .map(m => String(m ?? '').trim())
    .filter((m, idx, arr) => !!m && m !== input.primaryMuscle && arr.indexOf(m) === idx);
  const formCues = (input.formCues ?? [])
    .map(cue => String(cue ?? '').trim())
    .filter((cue, idx, arr) => !!cue && arr.indexOf(cue) === idx)
    .slice(0, 5);
  const aliases = (input.aliases ?? [])
    .map(alias => String(alias ?? '').trim())
    .filter((alias, idx, arr) => !!alias && arr.indexOf(alias) === idx)
    .slice(0, 5);
  const programmingTags = normalizeCustomExerciseProgrammingTags(input.programmingTags).slice(0, 12);

  return {
    id: `custom_${Date.now()}`,
    name,
    primary_muscle: input.primaryMuscle,
    secondary_muscles: secondaryMuscles,
    equipment,
    equipment_slugs: input.equipmentSlugs ?? [],
    equipment_bucket: input.equipmentBucket ?? undefined,
    movement_pattern: input.movementPattern?.trim() || null,
    exercise_type: input.movementPattern === 'cardio' ? 'cardio' : input.movementPattern === 'mobility' ? 'mobility' : 'strength',
    default_tracking_mode: input.defaultTrackingMode ?? (/\b(sec|second|min|minute|hold)\b/i.test(reps) ? 'time' : 'reps'),
    is_compound: input.isCompound ?? null,
    image_url: input.imageUrl ?? null,
    video_id: input.videoId ?? null,
    demo_exercise_db_id: input.demoExerciseDbId ?? null,
    sets: Number.isFinite(sets) && sets > 0 ? Math.max(1, Math.floor(sets)) : 3,
    reps,
    rest_seconds: Number.isFinite(restSeconds) && restSeconds >= 0 ? Math.max(0, Math.round(restSeconds)) : 60,
    description: input.description?.trim() ?? '',
    form_cues: formCues,
    aliases,
    programming_tags: programmingTags,
    source: input.source ?? 'manual',
    plan_eligible: input.planEligible,
    ai_confidence: input.aiConfidence ?? null,
    validation_status: input.validationStatus,
    createdAt: new Date().toISOString(),
  };
}

export function customExerciseFromAiResult(ex: AiExerciseLike, id = `custom_${Date.now()}`): CustomExerciseItem {
  const sets = Number(ex.sets);
  const restSeconds = Number(ex.rest_seconds);
  return {
    id,
    name: String(ex.name ?? '').trim(),
    primary_muscle: String(ex.primary_muscle ?? 'full_body'),
    secondary_muscles: Array.isArray(ex.secondary_muscles) ? ex.secondary_muscles : [],
    equipment: String(ex.equipment ?? 'other'),
    equipment_slugs: [],
    equipment_bucket: undefined,
    movement_pattern: ex.movement_pattern ?? null,
    exercise_type: ex.movement_pattern === 'cardio' ? 'cardio' : ex.movement_pattern === 'mobility' ? 'mobility' : 'strength',
    default_tracking_mode: /\b(sec|second|min|minute|hold)\b/i.test(String(ex.reps ?? '')) ? 'time' : 'reps',
    image_url: ex.image_url ?? null,
    video_id: ex.video_id ?? null,
    demo_exercise_db_id: ex.demo_exercise_db_id ?? null,
    is_compound: typeof ex.is_compound === 'boolean' ? ex.is_compound : null,
    sets: Number.isFinite(sets) && sets > 0 ? Math.max(1, Math.floor(sets)) : 3,
    reps: String(ex.reps ?? '8-12'),
    rest_seconds: Number.isFinite(restSeconds) && restSeconds >= 0 ? Math.max(0, Math.round(restSeconds)) : 60,
    description: String(ex.why ?? ''),
    form_cues: Array.isArray(ex.form_cues) ? ex.form_cues : [],
    aliases: Array.isArray(ex.aliases) ? ex.aliases : [],
    programming_tags: [],
    source: 'ai',
    plan_eligible: true,
    ai_confidence: 'medium',
    validation_status: 'needs_review',
    createdAt: new Date().toISOString(),
  };
}

export function customExerciseFromApi(row: any): CustomExerciseItem | null {
  const serverId = Number(row?.id);
  const name = String(row?.name ?? '').trim();
  if (!name) return null;
  return {
    id: Number.isFinite(serverId) && serverId > 0 ? `server_custom_${serverId}` : `custom_${Date.now()}`,
    server_id: Number.isFinite(serverId) && serverId > 0 ? serverId : undefined,
    name,
    primary_muscle: String(row?.primary_muscle ?? 'full_body'),
    secondary_muscles: Array.isArray(row?.secondary_muscles) ? row.secondary_muscles : [],
    equipment: String(row?.equipment ?? ''),
    equipment_slugs: Array.isArray(row?.equipment_slugs) ? row.equipment_slugs : [],
    equipment_bucket: row?.equipment_bucket ? String(row.equipment_bucket) : undefined,
    movement_pattern: row?.movement_pattern ?? null,
    exercise_type: row?.exercise_type ? String(row.exercise_type) : undefined,
    default_tracking_mode: row?.default_tracking_mode ? String(row.default_tracking_mode) : undefined,
    is_compound: typeof row?.is_compound === 'boolean' ? row.is_compound : null,
    image_url: row?.image_url ?? null,
    video_id: row?.video_id ?? null,
    demo_exercise_db_id: row?.demo_exercise_db_id ?? null,
    sets: Number.isFinite(Number(row?.sets)) ? Number(row.sets) : 3,
    reps: String(row?.reps ?? '8-12'),
    rest_seconds: Number.isFinite(Number(row?.rest_seconds)) ? Number(row.rest_seconds) : 60,
    description: String(row?.description ?? ''),
    form_cues: Array.isArray(row?.form_cues) ? row.form_cues : [],
    aliases: Array.isArray(row?.aliases) ? row.aliases : [],
    programming_tags: normalizeCustomExerciseProgrammingTags(row?.programming_tags),
    source: row?.source === 'manual' ? 'manual' : 'ai',
    plan_eligible: Boolean(row?.plan_eligible),
    ai_confidence: row?.ai_confidence ?? null,
    validation_status: row?.validation_status ? String(row.validation_status) : undefined,
    createdAt: String(row?.created_at ?? new Date().toISOString()),
    updatedAt: row?.updated_at ? String(row.updated_at) : undefined,
  };
}

export function customExerciseToApiPayload(ce: CustomExerciseItem) {
  return {
    name: ce.name,
    primary_muscle: ce.primary_muscle,
    secondary_muscles: ce.secondary_muscles ?? [],
    equipment: ce.equipment,
    equipment_slugs: ce.equipment_slugs ?? [],
    equipment_bucket: ce.equipment_bucket ?? null,
    movement_pattern: ce.movement_pattern ?? null,
    exercise_type: ce.exercise_type ?? null,
    default_tracking_mode: ce.default_tracking_mode ?? null,
    is_compound: ce.is_compound ?? null,
    image_url: ce.image_url ?? null,
    video_id: ce.video_id ?? null,
    demo_exercise_db_id: ce.demo_exercise_db_id ?? null,
    sets: ce.sets ?? 3,
    reps: ce.reps ?? '8-12',
    rest_seconds: ce.rest_seconds ?? 60,
    description: ce.description ?? '',
    form_cues: ce.form_cues ?? [],
    aliases: ce.aliases ?? [],
    programming_tags: normalizeCustomExerciseProgrammingTags(ce.programming_tags),
    source: ce.source ?? 'manual',
    plan_eligible: ce.plan_eligible ?? undefined,
    ai_confidence: ce.ai_confidence ?? null,
    validation_status: ce.validation_status ?? null,
  };
}

export function mergeCustomExercises(...lists: Array<CustomExerciseItem[] | null | undefined>): CustomExerciseItem[] {
  const byName = new Map<string, CustomExerciseItem>();
  for (const list of lists) {
    for (const item of list ?? []) {
      const key = normalizeExerciseNameKey(item.name);
      if (!key) continue;
      const existing = byName.get(key);
      if (!existing) {
        byName.set(key, item);
        continue;
      }
      byName.set(key, {
        ...existing,
        ...item,
        secondary_muscles: item.secondary_muscles?.length ? item.secondary_muscles : existing.secondary_muscles,
        form_cues: item.form_cues?.length ? item.form_cues : existing.form_cues,
        aliases: item.aliases?.length ? item.aliases : existing.aliases,
        programming_tags: item.programming_tags?.length ? item.programming_tags : existing.programming_tags,
        server_id: item.server_id ?? existing.server_id,
        id: item.server_id ? item.id : existing.id,
        createdAt: existing.createdAt || item.createdAt,
      });
    }
  }
  return Array.from(byName.values());
}

export function customExerciseToLibraryItem(ce: CustomExerciseItem) {
  return {
    id: ce.id as any,
    name: ce.name,
    slug: (ce as any).slug ?? null,
    primary_muscle: ce.primary_muscle,
    secondary_muscles: ce.secondary_muscles ?? [],
    equipment: ce.equipment,
    equipment_slugs: ce.equipment_slugs ?? [],
    equipment_bucket: ce.equipment_bucket ?? null,
    movement_pattern: ce.movement_pattern ?? null,
    exercise_type: ce.exercise_type ?? null,
    default_tracking_mode: ce.default_tracking_mode ?? null,
    image_url: ce.image_url ?? null,
    video_id: ce.video_id ?? null,
    demo_exercise_db_id: ce.demo_exercise_db_id ?? null,
    is_compound: ce.is_compound ?? null,
    sets: ce.sets,
    reps: ce.reps,
    rest_seconds: ce.rest_seconds,
    description: ce.description ?? '',
    form_cues: ce.form_cues ?? [],
    aliases: ce.aliases ?? [],
    programming_tags: normalizeCustomExerciseProgrammingTags(ce.programming_tags),
    is_custom: true,
  };
}
