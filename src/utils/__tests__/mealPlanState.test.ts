import {
  ensureMealClientKeys,
  findMealHistoryEntryForSuggestion,
  inferMealCheckKeyFromHistoryEntry,
  inferMealChecksFromHistory,
  isUserEditedMealPlan,
  markMealPlanUserEdited,
  mealCheckKeyForType,
  mergeBackendMealSuggestionsIntoPlan,
  mergeMealHistoryIntoChecksByDate,
  moveMealInPlanWithChecks,
  setMealCheckedInChecksByDate,
  upsertMealInPlansByDate,
} from '../mealPlanState.ts';

const date = '2026-05-03';

const basePlan = {
  targets: { calories: 2200, protein: 160, carbs: 240, fat: 70 },
  meals: [
    { meal: 'Breakfast', foods: [], calories: 450, protein: 30, carbs: 45, fat: 15 },
  ],
};

describe('meal plan state helpers', () => {
  it('distinguishes user-edited day plans from plain generated templates', () => {
    const generated: any = {
      targets: basePlan.targets,
      meals: [
        { meal: 'Generated Breakfast', foods: [], calories: 450, protein: 30, _clientMealKey: 'plan_0_abc' },
      ],
    };
    const localEdit: any = {
      targets: basePlan.targets,
      meals: [
        { meal: 'Photo Scan Meal', foods: [], calories: 520, protein: 42, _localId: 'manual_scan_1' },
      ],
    };

    expect(isUserEditedMealPlan(generated)).toBe(false);
    expect(isUserEditedMealPlan(localEdit)).toBe(true);
    expect(isUserEditedMealPlan(markMealPlanUserEdited(generated))).toBe(true);
  });

  it('keeps both back-to-back manually added meals with the newest first', () => {
    let plansByDate: any = { [date]: basePlan };

    const first = upsertMealInPlansByDate(
      plansByDate,
      date,
      'new_meal',
      { meal: 'Protein Shake', foods: [], calories: 260, protein: 35, carbs: 12, fat: 6 },
      { makeLocalId: () => 'manual_1' },
    );
    plansByDate = first.plansByDate;

    const second = upsertMealInPlansByDate(
      plansByDate,
      date,
      'new_meal',
      { meal: 'Greek Yogurt Bowl', foods: [], calories: 310, protein: 28, carbs: 38, fat: 7 },
      { makeLocalId: () => 'manual_2' },
    );

    expect(second.plansByDate[date].meals.map((m: any) => m.meal)).toEqual([
      'Greek Yogurt Bowl',
      'Protein Shake',
      'Breakfast',
    ]);
    expect(first.mealType).toBe('local_manual_1');
    expect(second.mealType).toBe('local_manual_2');
    expect((second.plansByDate[date].meals[0] as any)._localId).toBe('manual_2');
    expect((second.plansByDate[date].meals[1] as any)._localId).toBe('manual_1');
  });

  it('does not cap manual/photo-added meals at the generated fill target', () => {
    const fullGeneratedDay: any = {
      [date]: {
        targets: basePlan.targets,
        meals: [
          { meal: 'Breakfast', foods: [], calories: 450, protein: 30 },
          { meal: 'Lunch', foods: [], calories: 550, protein: 45 },
          { meal: 'Dinner', foods: [], calories: 650, protein: 50 },
        ],
      },
    };

    const result = upsertMealInPlansByDate(
      fullGeneratedDay,
      date,
      'new_meal',
      { meal: 'Photo Scan Bowl', foods: [], calories: 430, protein: 35, carbs: 40, fat: 12 },
      { makeLocalId: () => 'photo_scan_1' },
    );

    expect(result.plansByDate[date].meals.map((m: any) => m.meal)).toEqual([
      'Photo Scan Bowl',
      'Breakfast',
      'Lunch',
      'Dinner',
    ]);
    expect(result.mealType).toBe('local_photo_scan_1');
  });

  it('merges auto-checks for consecutive added meals', () => {
    let checksByDate: any = {};
    const first = setMealCheckedInChecksByDate(checksByDate, date, 'meal_1', true);
    checksByDate = first.checksByDate;
    const second = setMealCheckedInChecksByDate(checksByDate, date, 'meal_2', true);

    expect(second.dateChecks).toEqual({ meal_1: true, meal_2: true });
  });

  it('replaces an existing meal index without disturbing appended meals', () => {
    const withExtras: any = {
      [date]: {
        ...basePlan,
        meals: [
          ...basePlan.meals,
          { meal: 'Protein Shake', foods: [], calories: 260, protein: 35, carbs: 12, fat: 6 },
          { meal: 'Greek Yogurt Bowl', foods: [], calories: 310, protein: 28, carbs: 38, fat: 7 },
        ],
      },
    };

    const result = upsertMealInPlansByDate(
      withExtras,
      date,
      'meal_1',
      { meal: 'Updated Shake', foods: [], calories: 300, protein: 40, carbs: 14, fat: 6 },
    );

    expect(result.plansByDate[date].meals.map((m: any) => m.meal)).toEqual([
      'Breakfast',
      'Updated Shake',
      'Greek Yogurt Bowl',
    ]);
  });

  it('stamps matching backend meal ids onto local preserved meals instead of duplicating them', () => {
    const plan: any = {
      targets: basePlan.targets,
      meals: [
        {
          meal: 'Naked Protein',
          foods: [],
          items: [{ name: 'Naked Whey', quantity: 1, unit: 'scoop', calories: 120, protein: 25, carbs: 3, fat: 1 }],
          calories: 120,
          protein: 25,
          carbs: 3,
          fat: 1,
          _localId: 'manual_1',
        },
      ],
    };

    const result: any = mergeBackendMealSuggestionsIntoPlan(plan, [{
      meal: 'Naked Protein',
      foods: [],
      items: [{ name: 'Naked Whey', quantity: 1, unit: 'scoop', calories: 120, protein: 25, carbs: 3, fat: 1 }],
      calories: 120,
      protein: 25,
      carbs: 3,
      fat: 1,
      _localId: 'history_501',
      _loggedMealId: 501,
    } as any]);

    expect(result.meals.length).toBe(1);
    expect(result.meals[0]._localId).toBe('manual_1');
    expect(result.meals[0]._loggedMealId).toBe(501);
  });

  it('reconciles a renamed backend meal by content instead of appending a duplicate', () => {
    const plan: any = {
      targets: basePlan.targets,
      meals: [
        {
          meal: 'Protein Shake',
          foods: ['Whey', 'Banana'],
          calories: 245,
          protein: 29,
          carbs: 31,
          fat: 2,
          _clientMealKey: 'shake_slot',
        },
      ],
    };

    const result: any = mergeBackendMealSuggestionsIntoPlan(plan, [{
      meal: 'Post Workout Shake',
      foods: [],
      items: [
        { name: 'Whey', quantity: 1, unit: 'scoop', calories: 140, protein: 28, carbs: 4, fat: 2 },
        { name: 'Banana', quantity: 1, unit: 'piece', calories: 105, protein: 1, carbs: 27, fat: 0 },
      ],
      calories: 245,
      protein: 29,
      carbs: 31,
      fat: 2,
      _localId: 'history_601',
      _loggedMealId: 601,
    } as any]);

    expect(result.meals.length).toBe(1);
    expect(result.meals[0].meal).toBe('Post Workout Shake');
    expect(result.meals[0]._clientMealKey).toBe('shake_slot');
    expect(result.meals[0]._loggedMealId).toBe(601);
  });

  it('stamps backend history by client meal key even when enriched details changed', () => {
    const plan: any = {
      targets: basePlan.targets,
      meals: [
        {
          meal: 'Oats and Eggs',
          foods: [],
          items: [
            { name: 'oats', quantity: 1, unit: 'bowl', calories: 320, protein: 12, carbs: 48, fat: 8 },
            { name: 'eggs', quantity: 2, unit: 'piece', calories: 140, protein: 12, carbs: 1, fat: 10 },
          ],
          calories: 460,
          protein: 24,
          carbs: 49,
          fat: 18,
          _clientMealKey: 'meal_0',
        },
      ],
    };

    const result: any = mergeBackendMealSuggestionsIntoPlan(plan, [{
      meal: 'Oats and Eggs',
      foods: [],
      items: [{ name: 'oats and eggs', quantity: 1, unit: 'serving', calories: 455, protein: 24, carbs: 48, fat: 18 }],
      calories: 455,
      protein: 24,
      carbs: 48,
      fat: 18,
      _localId: 'history_701',
      _clientMealKey: 'meal_0',
      _loggedMealId: 701,
    } as any, {
      meal: 'Oats and Eggs',
      foods: [],
      items: [{ name: 'oats and eggs duplicate', quantity: 1, unit: 'serving', calories: 455, protein: 24, carbs: 48, fat: 18 }],
      calories: 455,
      protein: 24,
      carbs: 48,
      fat: 18,
      _localId: 'history_702',
      _clientMealKey: 'meal_0',
      _loggedMealId: 702,
    } as any]);

    expect(result.meals.length).toBe(1);
    expect(result.meals[0].meal).toBe('Oats and Eggs');
    expect(result.meals[0]._loggedMealId).toBe(701);
  });

  it('uses backend content for an already-stamped logged routine meal', () => {
    const plan: any = {
      targets: basePlan.targets,
      meals: [
        {
          meal: 'Routine Shake',
          foods: [],
          items: [{ name: 'whey', quantity: 1, unit: 'scoop', calories: 140, protein: 28, carbs: 4, fat: 2 }],
          calories: 140,
          protein: 28,
          carbs: 4,
          fat: 2,
          _routineId: 'routine_1',
          _clientMealKey: 'meal_1',
          _loggedMealId: 801,
        },
      ],
    };

    const result: any = mergeBackendMealSuggestionsIntoPlan(plan, [{
      meal: 'Routine Shake Edited',
      foods: [],
      items: [
        { name: 'whey', quantity: 1, unit: 'scoop', calories: 140, protein: 28, carbs: 4, fat: 2 },
        { name: 'banana', quantity: 1, unit: 'piece', calories: 105, protein: 1, carbs: 27, fat: 0 },
      ],
      calories: 245,
      protein: 29,
      carbs: 31,
      fat: 2,
      _localId: 'history_801',
      _clientMealKey: 'meal_1',
      _loggedMealId: 801,
    } as any]);

    expect(result.meals.length).toBe(1);
    expect(result.meals[0].meal).toBe('Routine Shake Edited');
    expect(result.meals[0].calories).toBe(245);
    expect(result.meals[0]._routineId).toBe('routine_1');
    expect(result.meals[0]._loggedMealId).toBe(801);
  });

  it('promotes newly logged plan meals to the top', () => {
    const plan: any = {
      targets: basePlan.targets,
      meals: [
        { meal: 'Breakfast', foods: [], calories: 450, protein: 30, carbs: 45, fat: 15, _clientMealKey: 'breakfast_key' },
        { meal: 'Chicken Bowl', foods: [], calories: 520, protein: 44, carbs: 55, fat: 12, _clientMealKey: 'chicken_key' },
      ],
    };

    const result: any = mergeBackendMealSuggestionsIntoPlan(plan, [{
      meal: 'Chicken Bowl',
      foods: [],
      items: [{ name: 'Chicken', quantity: 1, unit: 'bowl', calories: 520, protein: 44, carbs: 55, fat: 12 }],
      calories: 520,
      protein: 44,
      carbs: 55,
      fat: 12,
      _localId: 'history_502',
      _clientMealKey: 'chicken_key',
      _loggedMealId: 502,
    } as any]);

    expect(result.meals.map((m: any) => m.meal)).toEqual(['Chicken Bowl', 'Breakfast']);
    expect(result.meals[0]._loggedMealId).toBe(502);
  });

  it('prepends backend meals that are not already represented locally', () => {
    const plan: any = {
      targets: basePlan.targets,
      meals: [
        { meal: 'Breakfast', foods: [], calories: 450, protein: 30, carbs: 45, fat: 15 },
      ],
    };

    const result: any = mergeBackendMealSuggestionsIntoPlan(plan, [{
      meal: 'Greek Yogurt Bowl',
      foods: [],
      items: [{ name: 'Greek yogurt', quantity: 1, unit: 'bowl', calories: 310, protein: 28, carbs: 38, fat: 7 }],
      calories: 310,
      protein: 28,
      carbs: 38,
      fat: 7,
      _localId: 'history_502',
      _loggedMealId: 502,
    } as any]);

    expect(result.meals.map((m: any) => m.meal)).toEqual(['Greek Yogurt Bowl', 'Breakfast']);
    expect(result.meals[0]._loggedMealId).toBe(502);
  });

  it('keeps a copied logged meal even when name and macros match the original', () => {
    const plan: any = {
      targets: basePlan.targets,
      meals: [
        { meal: 'Egg Breakfast', foods: [], calories: 310, protein: 22, carbs: 4, fat: 20, _loggedMealId: 501 },
      ],
    };

    const result: any = mergeBackendMealSuggestionsIntoPlan(plan, [{
      meal: 'Egg Breakfast copy',
      foods: [],
      items: [{ name: 'eggs', quantity: 2, unit: 'piece', calories: 310, protein: 22, carbs: 4, fat: 20 }],
      calories: 310,
      protein: 22,
      carbs: 4,
      fat: 20,
      _localId: 'history_502',
      _loggedMealId: 502,
    } as any]);

    expect(result.meals.map((m: any) => m._loggedMealId)).toEqual([502, 501]);
  });

  it('infers checked plan meals from backend history item signatures', () => {
    const plan: any = {
      targets: basePlan.targets,
      meals: [
        {
          meal: 'Oats',
          foods: [],
          items: [{ name: 'oats', quantity: 1, unit: 'cup', calories: 300, protein: 10, carbs: 52, fat: 6 }],
          calories: 300,
          protein: 10,
          carbs: 52,
          fat: 6,
          _clientMealKey: 'oats_key',
        },
        {
          meal: 'Chicken Bowl',
          foods: [],
          items: [{ name: 'chicken', quantity: 1, unit: 'serving', calories: 450, protein: 42, carbs: 45, fat: 10 }],
          calories: 450,
          protein: 42,
          carbs: 45,
          fat: 10,
          _clientMealKey: 'chicken_key',
        },
      ],
    };

    const key = inferMealCheckKeyFromHistoryEntry({
      id: 101,
      meal_date: date,
      meal_type: 'lunch',
      source: 'generated',
      name: 'Chicken Bowl',
      totals: { calories: 450, protein_g: 42, carbs_g: 45, fat_g: 10 },
      items: [{ food_name: 'chicken', quantity: 1, unit: 'serving', calories: 450, protein_g: 42, carbs_g: 45, fat_g: 10 }],
    }, plan);

    expect(key).toBe('chicken_key');
  });

  it('uses backend client meal keys before ambiguous snack names', () => {
    const plan: any = {
      targets: basePlan.targets,
      meals: [
        { meal: 'Shake', foods: [], calories: 200, protein: 25, carbs: 10, fat: 4, _clientMealKey: 'shake_0' },
        { meal: 'Shake', foods: [], calories: 200, protein: 25, carbs: 10, fat: 4, _clientMealKey: 'shake_1' },
        { meal: 'Shake', foods: [], calories: 200, protein: 25, carbs: 10, fat: 4, _clientMealKey: 'shake_2' },
        { meal: 'Shake', foods: [], calories: 200, protein: 25, carbs: 10, fat: 4, _clientMealKey: 'shake_3' },
        { meal: 'Shake', foods: [], calories: 200, protein: 25, carbs: 10, fat: 4, _clientMealKey: 'shake_4' },
        { meal: 'Shake', foods: [], calories: 200, protein: 25, carbs: 10, fat: 4, _clientMealKey: 'shake_5' },
      ],
    };

    const key = inferMealCheckKeyFromHistoryEntry({
      id: 105,
      meal_date: date,
      meal_type: 'snack',
      client_meal_key: 'shake_5',
      source: 'generated',
      name: 'Shake',
      totals: { calories: 200, protein_g: 25, carbs_g: 10, fat_g: 4 },
      items: [],
    }, plan);

    expect(key).toBe('shake_5');
  });

  it('infers renamed history rows from food names and totals when item details differ', () => {
    const plan: any = {
      targets: basePlan.targets,
      meals: [
        {
          meal: 'Protein Shake',
          foods: ['Whey', 'Banana'],
          calories: 245,
          protein: 29,
          carbs: 31,
          fat: 2,
          _clientMealKey: 'shake_slot',
        },
      ],
    };

    const key = inferMealCheckKeyFromHistoryEntry({
      id: 106,
      meal_date: date,
      meal_type: 'snack',
      source: 'generated',
      name: 'Post Workout Shake',
      totals: { calories: 245, protein_g: 29, carbs_g: 31, fat_g: 2 },
      items: [
        { food_name: 'Whey', quantity: 1, unit: 'scoop', calories: 140, protein_g: 28, carbs_g: 4, fat_g: 2 },
        { food_name: 'Banana', quantity: 1, unit: 'piece', calories: 105, protein_g: 1, carbs_g: 27, fat_g: 0 },
      ],
    }, plan);

    expect(key).toBe('shake_slot');
  });

  it('resolves today logged meals by backend id before deleting local state', () => {
    const meal: any = {
      meal: 'Today Chicken Bowl',
      foods: [],
      calories: 520,
      protein: 44,
      _loggedMealId: 801,
    };

    const entry = findMealHistoryEntryForSuggestion([
      {
        id: 800,
        meal_date: date,
        client_meal_key: 'meal_1',
        name: 'Wrong meal',
        totals: { calories: 300 },
        items: [],
      },
      {
        id: 801,
        meal_date: date,
        client_meal_key: 'meal_0',
        name: 'Today Chicken Bowl',
        totals: { calories: 520, protein_g: 44 },
        items: [],
      },
    ], date, 'meal_0', meal, { ...basePlan, meals: [meal] } as any);

    expect(entry?.id).toBe(801);
  });

  it('resolves today logged meals by client meal key when the plan has not been stamped with the backend id yet', () => {
    const plan: any = {
      targets: basePlan.targets,
      meals: [
        {
          meal: 'Oats',
          foods: [],
          items: [{ name: 'oats', quantity: 1, unit: 'cup', calories: 300, protein: 10, carbs: 52, fat: 6 }],
          calories: 300,
          protein: 10,
          carbs: 52,
          fat: 6,
          _clientMealKey: 'oats_key',
        },
      ],
    };

    const entry = findMealHistoryEntryForSuggestion([
      {
        id: 901,
        meal_date: date,
        meal_type: 'breakfast',
        client_meal_key: 'meal_0',
        source: 'generated',
        name: 'Oats',
        totals: { calories: 300, protein_g: 10, carbs_g: 52, fat_g: 6 },
        items: [{ food_name: 'oats', quantity: 1, unit: 'cup', calories: 300, protein_g: 10, carbs_g: 52, fat_g: 6 }],
      },
    ], date, 'meal_0', plan.meals[0], plan);

    expect(entry?.id).toBe(901);
  });

  it('returns null when history entry cannot be matched by id, items, or name+cals', () => {
    // Removed legacy meal_type → fixed-index fallback. Entries that
    // lost their original meal_N key now stay unmatched rather than
    // silently claim a slot.
    const key = inferMealCheckKeyFromHistoryEntry({
      id: 102,
      meal_date: date,
      meal_type: 'dinner',
      source: 'generated',
      name: 'Renamed on server',
      totals: { calories: 999, protein_g: 1, carbs_g: 1, fat_g: 1 },
      items: [],
    }, {
      targets: basePlan.targets,
      meals: [
        { meal: 'Breakfast', foods: [], calories: 300, protein: 20, carbs: 30, fat: 10, _clientMealKey: 'breakfast_key' },
        { meal: 'Lunch', foods: [], calories: 500, protein: 40, carbs: 50, fat: 15, _clientMealKey: 'lunch_key' },
        { meal: 'Dinner', foods: [], calories: 600, protein: 45, carbs: 60, fat: 20 },
      ],
    } as any);

    expect(key).toBeNull();
  });

  it('merges backend-inferred checks without dropping existing local checks', () => {
    const plansByDate: any = {
      [date]: {
        targets: basePlan.targets,
        meals: [
          { meal: 'Breakfast', foods: [], calories: 300, protein: 20, carbs: 30, fat: 10, _clientMealKey: 'breakfast_key' },
          { meal: 'Lunch', foods: [], calories: 500, protein: 40, carbs: 50, fat: 15, _clientMealKey: 'lunch_key' },
        ],
      },
    };

    const result = mergeMealHistoryIntoChecksByDate(
      { [date]: { meal_0: true } },
      plansByDate,
      [{
        id: 103,
        meal_date: date,
        meal_type: 'lunch',
        source: 'generated',
        name: 'Lunch',
        totals: { calories: 500, protein_g: 40, carbs_g: 50, fat_g: 15 },
        items: [],
      }],
    );

    expect(result.changedDates).toEqual([date]);
    expect(result.checksByDate[date]).toEqual({ breakfast_key: true, lunch_key: true });
  });

  it('does not infer checks for future history rows', () => {
    const checks = inferMealChecksFromHistory([{
      id: 104,
      meal_date: '2026-05-08',
      meal_type: 'breakfast',
      source: 'generated',
      name: 'Breakfast',
      items: [],
    }], {
      '2026-05-08': basePlan as any,
    }, { maxDate: date });

    expect(checks).toEqual({});
  });

  it('skips stale backend rows when reconciliation says the row is locally deleted', () => {
    const plansByDate: any = {
      [date]: {
        targets: basePlan.targets,
        meals: [
          { meal: 'Breakfast', foods: [], calories: 300, protein: 20, carbs: 30, fat: 10, _clientMealKey: 'breakfast_key' },
        ],
      },
    };

    const result = mergeMealHistoryIntoChecksByDate(
      { [date]: { breakfast_key: false } },
      plansByDate,
      [{
        id: 105,
        meal_date: date,
        meal_type: 'breakfast',
        client_meal_key: 'breakfast_key',
        name: 'Breakfast',
        items: [],
      }],
      {
        shouldIncludeEntry: (_entry, inferredKey) => inferredKey !== 'breakfast_key',
      },
    );

    expect(result.changedDates).toEqual([]);
    expect(result.checksByDate[date]).toEqual({ breakfast_key: false });
  });

  it('moves a logged meal above another meal without losing the checked row', () => {
    const plan: any = {
      targets: basePlan.targets,
      meals: [
        { meal: 'Egg Breakfast', foods: [], calories: 310, protein: 22, _savedMealId: 7, _loggedMealId: 501, _clientMealKey: 'egg_key' },
        { meal: 'Chicken Bowl', foods: [], calories: 520, protein: 44, _loggedMealId: 502, _clientMealKey: 'chicken_key' },
        { meal: 'Greek Yogurt', foods: [], calories: 240, protein: 28, _routineId: 'routine_yogurt', _clientMealKey: 'yogurt_key' },
      ],
    };

    const result: any = moveMealInPlanWithChecks(plan, { egg_key: true, chicken_key: true }, 'chicken_key', -1);

    expect(result.plan.meals.map((m: any) => m.meal)).toEqual(['Chicken Bowl', 'Egg Breakfast', 'Greek Yogurt']);
    expect(result.plan.meals[0]._loggedMealId).toBe(502);
    expect(result.plan.meals[1]._loggedMealId).toBe(501);
    expect(result.checks).toEqual({ egg_key: true, chicken_key: true });
  });

  it('moves a checked meal down past an unchecked meal without changing its stable check key', () => {
    const plan: any = {
      targets: basePlan.targets,
      meals: [
        { meal: 'Egg Breakfast', foods: [], calories: 310, protein: 22, _savedMealId: 7, _loggedMealId: 501, _clientMealKey: 'egg_key' },
        { meal: 'Chicken Bowl', foods: [], calories: 520, protein: 44, _clientMealKey: 'chicken_key' },
        { meal: 'Greek Yogurt', foods: [], calories: 240, protein: 28, _routineId: 'routine_yogurt', _clientMealKey: 'yogurt_key' },
      ],
    };

    const result: any = moveMealInPlanWithChecks(plan, { egg_key: true }, 'egg_key', 1);

    expect(result.plan.meals.map((m: any) => m.meal)).toEqual(['Chicken Bowl', 'Egg Breakfast', 'Greek Yogurt']);
    expect(result.checks).toEqual({ egg_key: true });
  });

  it('normalizes legacy meal_N checks to stable row keys before moving', () => {
    const plan: any = ensureMealClientKeys({
      targets: basePlan.targets,
      meals: [
        { meal: 'Egg Breakfast', foods: [], calories: 310, protein: 22, _loggedMealId: 501 },
        { meal: 'Chicken Bowl', foods: [], calories: 520, protein: 44 },
      ],
    } as any);

    const eggKey = mealCheckKeyForType(plan, 'meal_0');
    const result: any = moveMealInPlanWithChecks(plan, { meal_0: true }, 'meal_0', 1);

    expect(result.plan.meals.map((m: any) => m.meal)).toEqual(['Chicken Bowl', 'Egg Breakfast']);
    expect(result.checks).toEqual({ [eggKey as string]: true });
  });

  it('skips hidden legacy rows when moving visible meals', () => {
    const plan: any = {
      targets: basePlan.targets,
      removedMealIds: ['meal_1'],
      meals: [
        { meal: 'Egg Breakfast', foods: [], calories: 310, protein: 22, _loggedMealId: 501, _clientMealKey: 'egg_key' },
        { meal: 'Hidden old meal', foods: [], calories: 100, protein: 5, _clientMealKey: 'hidden_key' },
        { meal: 'Chicken Bowl', foods: [], calories: 520, protein: 44, _loggedMealId: 502, _clientMealKey: 'chicken_key' },
      ],
    };

    const result: any = moveMealInPlanWithChecks(plan, { egg_key: true, chicken_key: true }, 'chicken_key', -1);

    expect(result.fromIndex).toBe(2);
    expect(result.toIndex).toBe(0);
    expect(result.plan.meals.map((m: any) => m.meal)).toEqual(['Chicken Bowl', 'Hidden old meal', 'Egg Breakfast']);
    expect(result.plan.removedMealIds).toEqual(['meal_1']);
    expect(result.checks).toEqual({ egg_key: true, chicken_key: true });
  });
});
