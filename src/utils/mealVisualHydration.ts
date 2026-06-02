export type MealVisualHydrationState = {
  authToken?: string | null;
  mealPlanHydrating: boolean;
  mealHistoryHydrated: boolean;
  mealHistoryLoading: boolean;
  hasVisibleMealPlan?: boolean;
};

export function shouldHoldMealPlanForVisualSync(state: MealVisualHydrationState): boolean {
  if (state.mealPlanHydrating && !state.hasVisibleMealPlan) return true;
  if (!state.authToken) return false;
  return !state.mealHistoryHydrated;
}
