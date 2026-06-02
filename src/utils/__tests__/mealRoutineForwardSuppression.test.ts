/**
 * `suppressRoutineForwardInPlans` is a FORWARD-fanning helper — by
 * design, it suppresses a routine on the given date AND every later
 * date in the plan map. This used to be wired into the "Just today"
 * delete path, which silently propagated the suppression across every
 * future plan and made the prompt's label misleading. The "Just today"
 * path no longer calls it; only "Unpin routine" (the all-days path)
 * should.
 *
 * These tests pin the helper's actual semantics so the contract is
 * unambiguous: if a future caller wants single-day behavior, they must
 * write their own helper, not reuse this one.
 */
import { suppressRoutineForwardInPlans } from '../mealRoutineOverlay.ts';
import type { DailyNutritionPlan } from '../../types';

function planWithRoutine(routineId: string): DailyNutritionPlan {
  return {
    meals: [
      { meal: 'Oats', _routineId: routineId, items: [], calories: 0, protein: 0, carbs: 0, fat: 0 } as any,
    ],
    removedMealIds: [],
    targets: { calories: 0, protein: 0, carbs: 0, fat: 0 },
  } as DailyNutritionPlan;
}

describe('suppressRoutineForwardInPlans', () => {
  it('suppresses the routine on the given date', () => {
    const plans = { '2026-05-22': planWithRoutine('r1') };
    const { plans: out, changedDates } = suppressRoutineForwardInPlans(plans, 'r1', '2026-05-22');
    expect(out['2026-05-22'].suppressedRoutineIds).toEqual(['r1']);
    expect(out['2026-05-22'].meals.length).toBe(0);
    expect(changedDates).toEqual(['2026-05-22']);
  });

  it('ALSO suppresses on every later date in the map — this is the forward fan-out', () => {
    const plans = {
      '2026-05-22': planWithRoutine('r1'),
      '2026-05-23': planWithRoutine('r1'),
      '2026-05-24': planWithRoutine('r1'),
    };
    const { plans: out, changedDates } = suppressRoutineForwardInPlans(plans, 'r1', '2026-05-22');
    expect(changedDates.sort()).toEqual(['2026-05-22', '2026-05-23', '2026-05-24']);
    for (const d of changedDates) {
      expect(out[d].suppressedRoutineIds).toEqual(['r1']);
      expect(out[d].meals.length).toBe(0);
    }
  });

  it('leaves earlier dates untouched', () => {
    const plans = {
      '2026-05-20': planWithRoutine('r1'),
      '2026-05-22': planWithRoutine('r1'),
    };
    const { plans: out, changedDates } = suppressRoutineForwardInPlans(plans, 'r1', '2026-05-22');
    expect(changedDates).toEqual(['2026-05-22']);
    // 2026-05-20 was BEFORE fromDate; it must keep its routine meal.
    expect(out['2026-05-20'].suppressedRoutineIds).toBe(undefined);
    expect(out['2026-05-20'].meals.length).toBe(1);
  });

  it('does NOT touch other routines on the same date', () => {
    const plans = {
      '2026-05-22': {
        ...planWithRoutine('r1'),
        meals: [
          ...planWithRoutine('r1').meals,
          { meal: 'Eggs', _routineId: 'r2', items: [], calories: 0, protein: 0, carbs: 0, fat: 0 } as any,
        ],
      },
    } as Record<string, DailyNutritionPlan>;
    const { plans: out } = suppressRoutineForwardInPlans(plans, 'r1', '2026-05-22');
    expect(out['2026-05-22'].suppressedRoutineIds).toEqual(['r1']);
    // r2's meal stays.
    expect(out['2026-05-22'].meals.length).toBe(1);
    expect((out['2026-05-22'].meals[0] as any)._routineId).toBe('r2');
  });

  it('still records the suppression even if no matching meal is materialized', () => {
    // The helper proactively flags the routine on each plan so a later
    // applyRoutines pass cannot re-introduce it. This is intentional.
    const plans = { '2026-05-22': planWithRoutine('r1') };
    const { plans: out, changedDates } = suppressRoutineForwardInPlans(plans, 'r2', '2026-05-22');
    expect(changedDates).toEqual(['2026-05-22']);
    expect(out['2026-05-22'].suppressedRoutineIds).toEqual(['r2']);
    // r1's existing meal stays — only r2 is suppressed.
    expect(out['2026-05-22'].meals.length).toBe(1);
  });

  it('no-ops when both routineId and fromDate are blank', () => {
    const plans = { '2026-05-22': planWithRoutine('r1') };
    const { plans: out, changedDates } = suppressRoutineForwardInPlans(plans, '', '2026-05-22');
    expect(changedDates).toEqual([]);
    expect(out).toBe(plans);
  });
});
