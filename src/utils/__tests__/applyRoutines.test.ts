// Tests for the routine→plan merge engine (mealRoutineApply). This is the
// function behind "editing a routine duplicates it": routines are re-derived
// onto each day's plan on every read, so the matching rule has to survive a
// routine's content changing without leaving a stale copy AND re-prepending a
// fresh one.

import type { DailyNutritionPlan, MealRoutineEntry, MealSuggestion } from '../../types';
import {
  applyRoutines,
  applyRoutinesToAllWithChecks,
} from '../mealRoutineApply.ts';

function makeRoutine(id: string, name: string, itemCount: number, extra: Partial<MealRoutineEntry> = {}): MealRoutineEntry {
  const items = Array.from({ length: itemCount }, (_, i) => ({
    name: `${name} item ${i}`,
    quantity: 1,
    unit: 'serving',
    calories: 100,
    protein: 10,
    carbs: 10,
    fat: 5,
  })) as any;
  return {
    id,
    name,
    foods: [],
    createdAt: '2026-05-22T00:00:00Z',
    items,
    calories: itemCount * 100,
    protein: itemCount * 10,
    carbs: itemCount * 10,
    fat: itemCount * 5,
    ...extra,
  } as MealRoutineEntry;
}

function makeMeal(name: string, itemCount: number, extra: Record<string, any> = {}): MealSuggestion {
  const items = Array.from({ length: itemCount }, (_, i) => ({
    name: `${name} item ${i}`,
    quantity: 1,
    unit: 'serving',
    calories: 100,
    protein: 10,
    carbs: 10,
    fat: 5,
  })) as any;
  return {
    meal: name,
    foods: items.map((it: any) => it.name),
    amounts: items.map(() => '1 serving'),
    items,
    calories: itemCount * 100,
    protein: itemCount * 10,
    carbs: itemCount * 10,
    fat: itemCount * 5,
    ...extra,
  } as MealSuggestion;
}

function plan(meals: MealSuggestion[], extra: Record<string, any> = {}): DailyNutritionPlan {
  return { meals, targets: { calories: 2000, protein: 150, carbs: 200, fat: 60 }, ...extra } as DailyNutritionPlan;
}

describe('applyRoutines — duplication on edit', () => {
  it('does NOT duplicate when a routine was edited (item count changed) and the day still has the old untagged copy', () => {
    // Routine "Oatmeal" was edited from 2 → 3 items. The day plan still has
    // the stale 2-item untagged copy (un-persisted overlay / fresh plan).
    const routines = [makeRoutine('r1', 'Oatmeal', 3)];
    const p = plan([makeMeal('Oatmeal', 2)]);
    const out = applyRoutines(p, routines);
    expect(out.meals.length).toBe(1);
    expect((out.meals[0] as any)._routineId).toBe('r1');
    expect(out.meals[0].items?.length).toBe(3); // refreshed to the edited routine
  });

  it('is idempotent — applying twice yields the same single meal', () => {
    const routines = [makeRoutine('r1', 'Oatmeal', 3)];
    const once = applyRoutines(plan([makeMeal('Oatmeal', 2)]), routines);
    const twice = applyRoutines(once, routines);
    expect(twice.meals.length).toBe(1);
    expect((twice.meals[0] as any)._routineId).toBe('r1');
  });

  it('adopts a STALE-id meal into the active routine instead of demote+duplicate', () => {
    // Reproduces the "creating a routine duplicates the meal" bug: a meal still
    // carries an optimistic id from before the routine reconciled to the
    // backend, while the live routine now has the backend-aligned id. The old
    // logic demoted the stale-id meal AND re-prepended the routine → 2 rows.
    const routines = [makeRoutine('routine_backend_7', 'Oatmeal', 3, { backendId: 7 })];
    const p = plan([makeMeal('Oatmeal', 2, { _routineId: 'routine_1699_abc' })]);
    const out = applyRoutines(p, routines);
    expect(out.meals.length).toBe(1);
    expect((out.meals[0] as any)._routineId).toBe('routine_backend_7');
    expect(out.meals[0].items?.length).toBe(3); // refreshed from the live routine
  });

  it('collapses two rows that resolve to the same routine into one (logged wins)', () => {
    // A logged routine row (id alias) AND a stale optimistic copy of the same
    // routine both ended up in the plan mid-session. The dedupe invariant keeps
    // exactly one, preferring the logged copy as authoritative.
    const routines = [makeRoutine('routine_local', 'Oatmeal', 3, { backendId: 7 })];
    const p = plan([
      makeMeal('Oatmeal', 1, { _routineId: 'routine_backend_7', _loggedMealId: 55 }),
      makeMeal('Oatmeal', 3, { _routineId: 'routine_local' }),
    ]);
    const out = applyRoutines(p, routines);
    expect(out.meals.length).toBe(1);
    expect((out.meals[0] as any)._loggedMealId).toBe(55);
  });

  it('adds a newly-pinned routine to a persisted (remote-style) day without clobbering logged meals', () => {
    // Models the future-day bug: a day's plan was already persisted to
    // day-state (so it loads as "remote"), then the user pins a NEW routine.
    // loadPlans now re-applies routines to remote plans, so the routine must
    // appear on that day while the user's logged meal is preserved.
    const routines = [makeRoutine('r1', 'Oatmeal', 2)];
    const persisted = plan([
      makeMeal('Grilled Chicken', 3, { _loggedMealId: 7, _clientMealKey: 'log_7' }),
    ]);
    const out = applyRoutines(persisted, routines);
    expect(out.meals.length).toBe(2);
    expect(out.meals.map(m => m.meal)).toEqual(['Oatmeal', 'Grilled Chicken']);
    expect((out.meals[1] as any)._loggedMealId).toBe(7);
  });

  it('does not resurrect a routine the day suppressed even when re-applied', () => {
    // Re-applying routines to a persisted plan must respect that plan's
    // suppressedRoutineIds so a routine the user removed for that day stays
    // gone across reloads.
    const routines = [makeRoutine('r1', 'Oatmeal', 2)];
    const persisted = plan(
      [makeMeal('Grilled Chicken', 3, { _loggedMealId: 7 })],
      { suppressedRoutineIds: ['r1'] },
    );
    const out = applyRoutines(persisted, routines);
    expect(out.meals.map(m => m.meal)).toEqual(['Grilled Chicken']);
  });

  it('does not collapse two DISTINCT same-named routines', () => {
    // The dedupe invariant keys on routine entry id, never on name, so two
    // separate routines that happen to share a name both survive.
    const routines = [makeRoutine('r1', 'Snack', 1), makeRoutine('r2', 'Snack', 2)];
    const p = plan([
      makeMeal('Snack', 1, { _routineId: 'r1' }),
      makeMeal('Snack', 2, { _routineId: 'r2' }),
    ]);
    const out = applyRoutines(p, routines);
    expect(out.meals.length).toBe(2);
  });
});

describe('applyRoutines — id-based identity', () => {
  it('case 1: refreshes an id-tagged routine meal from the latest snapshot', () => {
    const routines = [makeRoutine('r1', 'Oatmeal', 3)];
    const p = plan([makeMeal('Oatmeal', 1, { _routineId: 'r1' })]);
    const out = applyRoutines(p, routines);
    expect(out.meals.length).toBe(1);
    expect(out.meals[0].items?.length).toBe(3);
  });

  it('matches backend-derived routine ids to the local working-copy id after a rename', () => {
    const routines = [makeRoutine('routine_local', 'Protein Breakfast Deluxe', 3, { backendId: 42 })];
    const p = plan([
      makeMeal('Protein Breakfast', 1, { _routineId: 'routine_backend_42' }),
    ]);
    const out = applyRoutines(p, routines);

    expect(out.meals.length).toBe(1);
    expect(out.meals[0].meal).toBe('Protein Breakfast Deluxe');
    expect((out.meals[0] as any)._routineId).toBe('routine_local');
    expect((out.meals[0] as any).source_routine_id).toBe(42);
  });

  it('refreshes stale untagged routine rows by client key after a rename', () => {
    const routines = [makeRoutine('routine_local', 'Protein Breakfast Deluxe', 3, { backendId: 42 })];
    const p = plan([
      makeMeal('Protein Breakfast', 1, {
        _clientMealKey: 'routine_routine_backend_42',
        isRoutine: false,
      }),
    ]);
    const out = applyRoutines(p, routines);

    expect(out.meals.length).toBe(1);
    expect(out.meals[0].meal).toBe('Protein Breakfast Deluxe');
    expect((out.meals[0] as any)._routineId).toBe('routine_local');
    expect((out.meals[0] as any)._clientMealKey).toBe('routine_routine_backend_42');
  });

  it('keeps a LOGGED routine meal authoritative (does not overwrite from template)', () => {
    const routines = [makeRoutine('r1', 'Oatmeal', 3)];
    const p = plan([makeMeal('Oatmeal', 1, { _routineId: 'r1', _loggedMealId: 99 })]);
    const out = applyRoutines(p, routines);
    expect(out.meals.length).toBe(1);
    expect(out.meals[0].items?.length).toBe(1); // user-eaten snapshot preserved
    expect((out.meals[0] as any)._loggedMealId).toBe(99);
  });

  it('keeps a LOGGED backend-id routine meal authoritative while normalizing identity', () => {
    const routines = [makeRoutine('routine_local', 'Oatmeal Deluxe', 3, { backendId: 42 })];
    const p = plan([makeMeal('Oatmeal', 1, { _routineId: 'routine_backend_42', _loggedMealId: 99 })]);
    const out = applyRoutines(p, routines);

    expect(out.meals.length).toBe(1);
    expect(out.meals[0].meal).toBe('Oatmeal');
    expect(out.meals[0].items?.length).toBe(1);
    expect((out.meals[0] as any)._routineId).toBe('routine_local');
    expect((out.meals[0] as any).source_routine_id).toBe(42);
  });

  it('case 2: demotes a meal whose routine was removed (keeps the meal, strips tag)', () => {
    const p = plan([makeMeal('Oatmeal', 2, { _routineId: 'gone' })]);
    const out = applyRoutines(p, []);
    expect(out.meals.length).toBe(1);
    expect((out.meals[0] as any)._routineId).toBe(undefined);
  });

  it('prepends an active routine that has no matching meal', () => {
    const routines = [makeRoutine('r1', 'Oatmeal', 2)];
    const p = plan([makeMeal('Chicken', 1)]);
    const out = applyRoutines(p, routines);
    expect(out.meals.length).toBe(2);
    expect((out.meals[0] as any)._routineId).toBe('r1'); // routine first
    expect(out.meals[1].meal).toBe('Chicken');
  });

  it('orders newly inserted routines by shared display order', () => {
    const routines = [
      makeRoutine('r2', 'Second Routine', 1, { displayOrder: 1 }),
      makeRoutine('r1', 'First Routine', 1, { displayOrder: 0 }),
    ];
    const out = applyRoutines(plan([makeMeal('Chicken', 1)]), routines);

    expect(out.meals.map(m => m.meal)).toEqual(['First Routine', 'Second Routine', 'Chicken']);
  });

  it('reorders existing routine slots without moving generated meals', () => {
    const routines = [
      makeRoutine('r2', 'Second Routine', 1, { displayOrder: 1 }),
      makeRoutine('r1', 'First Routine', 1, { displayOrder: 0 }),
    ];
    const p = plan([
      makeMeal('Second Routine', 1, { _routineId: 'r2' }),
      makeMeal('Chicken', 1),
      makeMeal('First Routine', 1, { _routineId: 'r1' }),
    ]);
    const out = applyRoutines(p, routines);

    expect(out.meals.map(m => m.meal)).toEqual(['First Routine', 'Chicken', 'Second Routine']);
  });

  it('respects suppressedRoutineIds (just-today detach)', () => {
    const routines = [makeRoutine('r1', 'Oatmeal', 2)];
    const p = plan([makeMeal('Chicken', 1)], { suppressedRoutineIds: ['r1'] });
    const out = applyRoutines(p, routines);
    expect(out.meals.length).toBe(1);
    expect(out.meals[0].meal).toBe('Chicken');
  });

  it('drops a stale routine-tagged row when that routine is suppressed for the day', () => {
    const routines = [makeRoutine('r1', 'Oatmeal', 2)];
    const p = plan([makeMeal('Oatmeal', 2, { _routineId: 'r1' })], { suppressedRoutineIds: ['r1'] });
    const out = applyRoutines(p, routines);
    expect(out.meals.length).toBe(0);
  });

  it('drops a backend-alias routine row when the local routine id is suppressed', () => {
    const routines = [makeRoutine('routine_local', 'Oatmeal', 2, { backendId: 42 })];
    const p = plan([
      makeMeal('Oatmeal', 2, {
        _routineId: 'routine_backend_42',
        source_routine_id: 42,
      }),
    ], { suppressedRoutineIds: ['routine_local'] });
    const out = applyRoutines(p, routines);
    expect(out.meals.length).toBe(0);
  });

  it('drops a stale backend routine client-key row when the local routine id is suppressed', () => {
    const routines = [makeRoutine('routine_local', 'Oatmeal', 2, { backendId: 42 })];
    const p = plan([
      makeMeal('Oatmeal', 2, {
        _clientMealKey: 'routine_routine_backend_42',
        isRoutine: false,
      }),
    ], { suppressedRoutineIds: ['routine_local'] });
    const out = applyRoutines(p, routines);
    expect(out.meals.length).toBe(0);
  });

  it('drops a previously demoted routine row when its client key still identifies a suppressed routine', () => {
    const routines = [makeRoutine('r1', 'Oatmeal', 2)];
    const p = plan([makeMeal('Oatmeal', 2, { _clientMealKey: 'routine_r1', isRoutine: false })], { suppressedRoutineIds: ['r1'] });
    const out = applyRoutines(p, routines);
    expect(out.meals.length).toBe(0);
  });

  it('keeps a just-today detached edit while suppressing the original routine', () => {
    const routines = [makeRoutine('r1', 'Oatmeal', 2)];
    const p = plan([makeMeal('Oatmeal with berries', 3, { _localId: 'manual_today' })], { suppressedRoutineIds: ['r1'] });
    const out = applyRoutines(p, routines);
    expect(out.meals.length).toBe(1);
    expect(out.meals[0].meal).toBe('Oatmeal with berries');
    expect((out.meals[0] as any)._routineId).toBe(undefined);
  });

  it('disambiguates two same-named routines by item count', () => {
    const routines = [makeRoutine('r1', 'Meal', 2), makeRoutine('r2', 'Meal', 3)];
    const p = plan([makeMeal('Meal', 3)]);
    const out = applyRoutines(p, routines);
    // The 3-item untagged meal adopts r2 (the 3-item routine); r1 prepends.
    const tagged = out.meals.find(m => (m as any)._routineId === 'r2');
    expect(tagged !== undefined).toBe(true);
    expect(tagged!.items?.length).toBe(3);
    expect(out.meals.length).toBe(2);
  });
});

describe('applyRoutinesToAllWithChecks', () => {
  it('normalizes legacy meal_<idx> checks to the original meal stable key before prepending routines', () => {
    const routines = [makeRoutine('r1', 'Oatmeal', 2)];
    const plans = { '2026-05-22': plan([makeMeal('Chicken', 1)]) };
    const checks = { '2026-05-22': { meal_0: true } };
    const out = applyRoutinesToAllWithChecks(plans, checks, routines);
    const chickenKey = (out.plansByDate['2026-05-22'].meals[1] as any)._clientMealKey;
    expect(out.checksByDate['2026-05-22'][chickenKey]).toBe(true);
    expect(out.checksByDate['2026-05-22'].meal_0).toBe(undefined);
    expect(out.checksByDate['2026-05-22'].meal_1).toBe(undefined);
  });
});
