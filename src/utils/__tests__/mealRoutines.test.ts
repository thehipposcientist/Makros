import { activeMealRoutinesForPlan, suppressedRoutineIdSet } from '../mealRoutineOverlay.ts';
import { applyRoutinesToAllWithChecks } from '../mealRoutineApply.ts';
import { routineEntryFromEditedMeal } from '../mealRoutineTemplateEdit.ts';
import { inferBackendIdFromRoutineEntry } from '../mealRoutineSyncCore.ts';
import { shouldHoldMealPlanForVisualSync } from '../mealVisualHydration.ts';

const breakfastRoutine = {
  id: 'routine_breakfast',
  name: 'Protein Breakfast',
  mealType: 'custom',
  foods: [{ id: 'food_1', name: 'Eggs', quantity: '2 piece' }],
  items: [{
    name: 'Eggs',
    quantity: 2,
    unit: 'piece',
    calories: 220,
    protein: 18,
    carbs: 2,
    fat: 14,
  }],
  createdAt: '2026-05-01T12:00:00.000Z',
  calories: 220,
  protein: 18,
  carbs: 2,
  fat: 14,
} as any;

describe('meal routine overlays', () => {
  it('excludes a suppressed routine for a today-only edit', () => {
    const active = activeMealRoutinesForPlan({
      suppressedRoutineIds: ['routine_breakfast'],
    }, [breakfastRoutine]);

    expect(active).toEqual([]);
  });

  it('excludes a suppressed backend alias for a today-only edit', () => {
    const active = activeMealRoutinesForPlan({
      suppressedRoutineIds: ['routine_backend_42'],
    }, [{ ...breakfastRoutine, id: 'routine_local', backendId: 42 }]);

    expect(active).toEqual([]);
  });

  it('keeps an unsuppressed routine available on normal days', () => {
    const active = activeMealRoutinesForPlan({}, [breakfastRoutine]);

    expect(active.length).toBe(1);
    expect(active[0].id).toBe('routine_breakfast');
  });

  it('normalizes blank suppression ids out of the set', () => {
    const ids = suppressedRoutineIdSet({
      suppressedRoutineIds: ['', '  routine_breakfast  ', null as any],
    });

    expect(ids.has('routine_breakfast')).toBe(true);
    expect(ids.has('')).toBe(false);
  });

  it('keeps checked meal identity stable when a front-row meal is pinned as routine', () => {
    const date = '2026-05-25';
    const taggedPlan = {
      meals: [
        {
          meal: 'Eggs',
          calories: 220,
          protein: 18,
          carbs: 2,
          fat: 14,
          _clientMealKey: 'eggs_key',
          _routineId: 'routine_breakfast',
        },
        {
          meal: 'Chicken Bowl',
          calories: 520,
          protein: 44,
          carbs: 48,
          fat: 16,
          _clientMealKey: 'chicken_key',
        },
      ],
      targets: { calories: 2000, protein: 150, carbs: 200, fat: 65 },
    } as any;

    const result = applyRoutinesToAllWithChecks(
      { [date]: taggedPlan },
      { [date]: { eggs_key: true, chicken_key: true } },
      [breakfastRoutine],
    );

    expect(result.plansByDate[date].meals.length).toBe(2);
    expect(result.plansByDate[date].meals.map((m: any) => m._clientMealKey)).toEqual(['eggs_key', 'chicken_key']);
    expect(result.checksByDate[date]).toEqual({ eggs_key: true, chicken_key: true });
  });
});

describe('meal routine backend identity', () => {
  it('uses explicit backendId first', () => {
    expect(inferBackendIdFromRoutineEntry({ id: 'routine_backend_7', backendId: 42 } as any)).toBe(42);
  });

  it('recovers backend id from server-derived local ids', () => {
    expect(inferBackendIdFromRoutineEntry({ id: 'routine_backend_123' } as any)).toBe(123);
  });

  it('ignores draft or invalid ids', () => {
    expect(inferBackendIdFromRoutineEntry({ id: 'routine_abc' } as any)).toBeNull();
    expect(inferBackendIdFromRoutineEntry({ id: 'routine_backend_0' } as any)).toBeNull();
  });
});

describe('meal visual hydration gate', () => {
  it('holds the plan while local plan/routine hydration is running', () => {
    expect(shouldHoldMealPlanForVisualSync({
      authToken: 'token',
      mealPlanHydrating: true,
      mealHistoryHydrated: true,
      mealHistoryLoading: false,
    })).toBe(true);
  });

  it('keeps an existing plan visible while local hydration reruns', () => {
    expect(shouldHoldMealPlanForVisualSync({
      authToken: 'token',
      mealPlanHydrating: true,
      mealHistoryHydrated: true,
      mealHistoryLoading: false,
      hasVisibleMealPlan: true,
    })).toBe(false);
  });

  it('holds authenticated meal UI until the first backend history hydration settles', () => {
    expect(shouldHoldMealPlanForVisualSync({
      authToken: 'token',
      mealPlanHydrating: false,
      mealHistoryHydrated: false,
      mealHistoryLoading: false,
    })).toBe(true);
  });

  it('keeps the plan visible during later backend history refreshes', () => {
    expect(shouldHoldMealPlanForVisualSync({
      authToken: 'token',
      mealPlanHydrating: false,
      mealHistoryHydrated: true,
      mealHistoryLoading: true,
    })).toBe(false);
  });

  it('releases once plan and backend history are both settled', () => {
    expect(shouldHoldMealPlanForVisualSync({
      authToken: 'token',
      mealPlanHydrating: false,
      mealHistoryHydrated: true,
      mealHistoryLoading: false,
    })).toBe(false);
  });

  it('does not block signed-out/local-only users on backend history', () => {
    expect(shouldHoldMealPlanForVisualSync({
      authToken: null,
      mealPlanHydrating: false,
      mealHistoryHydrated: false,
      mealHistoryLoading: false,
    })).toBe(false);
  });
});

describe('routine template edits from meal editor', () => {
  it('turns an every-day meal edit into a template snapshot, preserving backend identity', () => {
    const edited = {
      meal: 'Protein Breakfast Deluxe',
      _routineId: 'routine_backend_42',
      _loggedMealId: 99,
      items: [
        { name: 'Eggs', quantity: 3, unit: 'piece', calories: 330, protein: 27, carbs: 3, fat: 21 },
        { name: 'Toast', quantity: 1, unit: 'slice', calories: 100, protein: 4, carbs: 18, fat: 1 },
      ],
      foods: ['stale'],
      calories: 1,
      protein: 1,
      carbs: 1,
      fat: 1,
    } as any;

    const entry = routineEntryFromEditedMeal(
      { ...breakfastRoutine, id: 'routine_backend_42', backendId: 42 },
      edited,
      i => `food-${i}`,
    );

    expect(entry.id).toBe('routine_backend_42');
    expect(entry.backendId).toBe(42);
    expect(entry.name).toBe('Protein Breakfast Deluxe');
    expect(entry.items?.length).toBe(2);
    expect(entry.foods).toEqual([
      { id: 'food-0', name: 'Eggs', quantity: '3' },
      { id: 'food-1', name: 'Toast', quantity: '1 slice' },
    ]);
    expect(entry.calories).toBe(430);
    expect(entry.protein).toBe(31);
    expect((entry as any)._loggedMealId).toBe(undefined);
  });
});
