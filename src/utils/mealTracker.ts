import { DailyNutritionPlan, MealSuggestion } from '../types';

// Meals are server-owned. Do not persist meal checks, edited day plans, or
// preserved logged-meal snapshots in AsyncStorage; reinstall/cross-device
// behavior must come from Meal/UserDayState reads.
export type MealChecks = Record<string, boolean>;

export interface DietConsistencyScore {
  total: number;
  adherence: number;
  streak: number;
  spread: number;
  daysTracked: number;
  mealsChecked: number;
}

export async function computeDietConsistency(
  windowDays: number = 14,
): Promise<DietConsistencyScore> {
  void windowDays;
  return {
    total: 0,
    adherence: 0,
    streak: 0,
    spread: 0,
    daysTracked: 0,
    mealsChecked: 0,
  };
}

export async function getMealChecks(date: string): Promise<MealChecks> {
  void date;
  return {};
}

export async function saveMealChecks(date: string, checks: MealChecks): Promise<void> {
  void date; void checks;
}

export async function getSavedNutritionPlan(date: string): Promise<DailyNutritionPlan | null> {
  void date;
  return null;
}

export async function saveNutritionPlan(date: string, plan: DailyNutritionPlan): Promise<void> {
  void date; void plan;
}

export async function getAllSavedNutritionPlans(): Promise<Record<string, DailyNutritionPlan>> {
  return {};
}

export async function getAllMealChecks(): Promise<Record<string, MealChecks>> {
  return {};
}

export async function clearAllSavedNutritionPlans(): Promise<void> {}

export async function clearSavedNutritionPlansForDates(dates: string[]): Promise<void> {
  void dates;
}

export async function clearAllPreservedMeals(): Promise<void> {}

export async function clearPreservedMealsForDates(dates: string[]): Promise<void> {
  void dates;
}

export async function clearAllMealChecksExceptToday(todayKey: string): Promise<void> {
  void todayKey;
}

export async function clearMealChecksForDates(dates: string[]): Promise<void> {
  void dates;
}

export async function getPreservedMeals(date: string): Promise<MealSuggestion[]> {
  void date;
  return [];
}

export async function savePreservedMeal(
  date: string,
  mealType: string,
  meal: MealSuggestion,
): Promise<void> {
  void date; void mealType; void meal;
}

export async function clearPreservedMeal(
  date: string,
  mealType: string,
  mealLocalId?: string,
): Promise<void> {
  void date; void mealType; void mealLocalId;
}

export async function clearPreservedMealBySignature(
  date: string,
  mealName: string,
  calories: number,
): Promise<void> {
  void date; void mealName; void calories;
}
