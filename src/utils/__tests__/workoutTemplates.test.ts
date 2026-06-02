import {
  WORKOUT_TEMPLATES_KEY,
  deleteWorkoutTemplateFromStorage,
  loadWorkoutTemplatesFromStorage,
  parseWorkoutTemplates,
  upsertWorkoutTemplateInStorage,
  workoutFromTemplateForToday,
} from '../workoutTemplates.ts';

function makeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const writes: Array<{ key: string; value: string }> = [];
  return {
    data,
    writes,
    async getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    async setItem(key: string, value: string) {
      writes.push({ key, value });
      data.set(key, value);
    },
  };
}

function template(id: string, name = `Template ${id}`) {
  return {
    id,
    name,
    createdAt: `2026-05-0${id.length}.000Z`,
    updatedAt: `2026-05-0${id.length}.000Z`,
    workout: {
      day: 'Wednesday',
      focus: name,
      stimulus: 'hypertrophy',
      exercises: [
        {
          name: 'Dumbbell Bench Press',
          sets: 3,
          reps: '8-12',
          restSeconds: 90,
          equipment: 'Dumbbells',
          primary_muscle: 'chest',
        },
        {
          name: 'Seated Row',
          sets: 4,
          reps: '10',
          restSeconds: 75,
          equipment: 'Cable',
          primary_muscle: 'back',
        },
      ],
    },
  } as any;
}

describe('workout template persistence', () => {
  it('loads an empty list for missing, corrupt, or non-array storage', async () => {
    expect(parseWorkoutTemplates(null)).toEqual([]);
    expect(parseWorkoutTemplates('{nope')).toEqual([]);
    expect(parseWorkoutTemplates('{"id":"not-array"}')).toEqual([]);

    const storage = makeStorage({ [WORKOUT_TEMPLATES_KEY]: '{bad-json' });
    expect(await loadWorkoutTemplatesFromStorage(storage)).toEqual([]);
  });

  it('creates a new template, prepends it, and persists the complete workout shape', async () => {
    const existing = [template('old', 'Old Upper')];
    const storage = makeStorage({
      [WORKOUT_TEMPLATES_KEY]: JSON.stringify(existing),
    });
    const created = template('new', 'Push Favorite');

    const next = await upsertWorkoutTemplateInStorage(created, {
      storage,
      profile: { subscriptionTier: 'pro' },
      canCreateWorkoutTemplate: () => true,
      freeWorkoutTemplateLimit: 5,
    });

    expect(next.map(t => t.id)).toEqual(['new', 'old']);
    expect(next[0].workout.exercises[0]).toEqual(created.workout.exercises[0]);
    expect(JSON.parse(storage.data.get(WORKOUT_TEMPLATES_KEY)!).map((t: any) => t.id)).toEqual(['new', 'old']);
  });

  it('updates an existing template in place without creating a duplicate or checking the create cap', async () => {
    const existing = [template('a', 'A'), template('b', 'B'), template('c', 'C')];
    const storage = makeStorage({
      [WORKOUT_TEMPLATES_KEY]: JSON.stringify(existing),
    });
    const edited = {
      ...existing[1],
      name: 'B Edited',
      updatedAt: '2026-05-02T12:00:00.000Z',
      workout: {
        ...existing[1].workout,
        focus: 'B Edited',
        exercises: existing[1].workout.exercises.slice(0, 1),
      },
    };
    let capChecks = 0;

    const next = await upsertWorkoutTemplateInStorage(edited, {
      storage,
      profile: { subscriptionTier: 'free' },
      canCreateWorkoutTemplate: () => {
        capChecks += 1;
        return false;
      },
      freeWorkoutTemplateLimit: 3,
    });

    expect(capChecks).toBe(0);
    expect(next.map(t => t.id)).toEqual(['a', 'b', 'c']);
    expect(next[1].name).toBe('B Edited');
    expect(next[1].workout.exercises.length).toBe(1);
  });

  it('blocks a new free-tier template at the cap and does not mutate storage', async () => {
    const existing = [template('a'), template('b'), template('c'), template('d'), template('e')];
    const storage = makeStorage({
      [WORKOUT_TEMPLATES_KEY]: JSON.stringify(existing),
    });

    let error = '';
    try {
      await upsertWorkoutTemplateInStorage(template('f'), {
        storage,
        profile: { subscriptionTier: 'free' },
        canCreateWorkoutTemplate: (_profile, count) => count < 5,
        freeWorkoutTemplateLimit: 5,
      });
    } catch (e: any) {
      error = e?.message ?? String(e);
    }

    expect(error).toContain('Free accounts can save up to 5 workout templates');
    expect(JSON.parse(storage.data.get(WORKOUT_TEMPLATES_KEY)!).map((t: any) => t.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(storage.writes.length).toBe(0);
  });

  it('allows pro users to create beyond the free cap', async () => {
    const existing = [template('a'), template('b'), template('c')];
    const storage = makeStorage({
      [WORKOUT_TEMPLATES_KEY]: JSON.stringify(existing),
    });

    const next = await upsertWorkoutTemplateInStorage(template('d'), {
      storage,
      profile: { subscriptionTier: 'pro' },
      canCreateWorkoutTemplate: () => true,
      freeWorkoutTemplateLimit: 3,
    });

    expect(next.map(t => t.id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('deletes only the requested template and no-ops for unknown ids', async () => {
    const storage = makeStorage({
      [WORKOUT_TEMPLATES_KEY]: JSON.stringify([template('a'), template('b'), template('c')]),
    });

    const afterDelete = await deleteWorkoutTemplateFromStorage(storage, 'b');
    expect(afterDelete.map(t => t.id)).toEqual(['a', 'c']);

    const writesAfterDelete = storage.writes.length;
    const afterMissing = await deleteWorkoutTemplateFromStorage(storage, 'missing');
    expect(afterMissing.map(t => t.id)).toEqual(['a', 'c']);
    expect(storage.writes.length).toBe(writesAfterDelete);
  });
});

describe('starting a saved workout template', () => {
  it('uses the saved workout unchanged except for setting today as the workout day', () => {
    const saved = template('launch', 'Saturday Push');
    const launched = workoutFromTemplateForToday(saved, new Date(2026, 4, 4, 12));

    expect(launched.day).toBe('Monday');
    expect(launched.focus).toBe(saved.workout.focus);
    expect(launched.exercises).toEqual(saved.workout.exercises);
    expect(saved.workout.day).toBe('Wednesday');
  });
});
