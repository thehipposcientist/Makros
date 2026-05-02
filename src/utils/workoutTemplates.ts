import type { SavedWorkoutTemplate, WorkoutDay } from '../types';

export const WORKOUT_TEMPLATES_KEY = 'workoutTemplates';

export interface WorkoutTemplateStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface UpsertWorkoutTemplateOptions {
  storage: WorkoutTemplateStorage;
  profile?: unknown;
  loadProfile?: () => Promise<unknown>;
  canCreateWorkoutTemplate?: (profile: any, currentCount: number) => boolean;
  freeWorkoutTemplateLimit?: number;
}

export function parseWorkoutTemplates(raw: string | null | undefined): SavedWorkoutTemplate[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function loadWorkoutTemplatesFromStorage(
  storage: Pick<WorkoutTemplateStorage, 'getItem'>,
): Promise<SavedWorkoutTemplate[]> {
  const raw = await storage.getItem(WORKOUT_TEMPLATES_KEY);
  return parseWorkoutTemplates(raw);
}

export async function saveWorkoutTemplatesToStorage(
  storage: Pick<WorkoutTemplateStorage, 'setItem'>,
  templates: SavedWorkoutTemplate[],
): Promise<void> {
  await storage.setItem(WORKOUT_TEMPLATES_KEY, JSON.stringify(templates));
}

export async function deleteWorkoutTemplateFromStorage(
  storage: WorkoutTemplateStorage,
  templateId: string,
): Promise<SavedWorkoutTemplate[]> {
  const templates = await loadWorkoutTemplatesFromStorage(storage);
  if (!templateId) return templates;
  const next = templates.filter(t => t.id !== templateId);
  if (next.length !== templates.length) {
    await saveWorkoutTemplatesToStorage(storage, next);
  }
  return next;
}

export async function upsertWorkoutTemplateInStorage(
  template: SavedWorkoutTemplate,
  options: UpsertWorkoutTemplateOptions,
): Promise<SavedWorkoutTemplate[]> {
  const { storage } = options;
  const templates = await loadWorkoutTemplatesFromStorage(storage);
  const idx = templates.findIndex(t => t.id === template.id);

  if (idx < 0 && options.canCreateWorkoutTemplate) {
    let profile = Object.prototype.hasOwnProperty.call(options, 'profile')
      ? options.profile
      : undefined;
    if (profile === undefined && options.loadProfile) {
      try {
        profile = await options.loadProfile();
      } catch {
        profile = null;
      }
    }
    if (!options.canCreateWorkoutTemplate(profile, templates.length)) {
      throw new Error(
        `Free accounts can save up to ${options.freeWorkoutTemplateLimit ?? 3} workout templates. Upgrade to Pro for unlimited.`,
      );
    }
  }

  const next = idx >= 0
    ? templates.map(t => t.id === template.id ? template : t)
    : [template, ...templates];
  await saveWorkoutTemplatesToStorage(storage, next);
  return next;
}

export function workoutFromTemplateForToday(
  template: SavedWorkoutTemplate,
  now: Date = new Date(),
): WorkoutDay {
  return {
    ...template.workout,
    day: now.toLocaleDateString('en-US', { weekday: 'long' }),
    _source_context: 'saved_template',
    _template_id: template.id,
  } as WorkoutDay;
}
