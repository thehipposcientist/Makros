// ─── Goal types ───────────────────────────────────────────────────────────────

export type Goal =
  | 'fat_loss'
  | 'muscle_gain'
  | 'body_recomp'
  | 'strength'
  | 'endurance'
  | 'athletic_performance'
  | 'toning'
  | 'maintain'
  | 'flexibility'
  | 'stress_relief';

export type GoalPace = 'conservative' | 'moderate' | 'aggressive';
export type Gender = 'male' | 'female' | 'nonbinary' | 'prefer_not_to_say';
export type Equipment = 'home' | 'gym' | 'dumbbells' | 'bodyweight' | 'other';

export interface GoalOption {
  value: Goal;
  label: string;
  icon: string;
  description: string;
}

export interface PaceOption {
  value: GoalPace;
  icon: string;
  label: string;
  rate: string;
  description: string;
}

// ─── User data ────────────────────────────────────────────────────────────────

export interface PhysicalStats {
  weightLbs: number;
  heightFeet: number;
  heightInches: number;
  age: number;
  gender: Gender;
}

export interface GoalDetails {
  pace: GoalPace;
  targetWeightLbs?: number; // for fat_loss, toning, muscle_gain
  timelineWeeks?: number;   // derived from pace for performance/recomp goals
}

export interface CustomFoodItem {
  name: string;
  unit: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface UserProfile {
  goal: Goal;
  goalDetails: GoalDetails;
  physicalStats: PhysicalStats;
  daysPerWeek: number;
  workoutDurationMinutes: number;
  equipment: string[];           // specific item names e.g. 'Dumbbells', 'Barbell'
  foodsAvailable: string[];
  customFoods: CustomFoodItem[]; // user-added foods with AI-fetched macros
}

// ─── Workout plan types ───────────────────────────────────────────────────────

export interface Exercise {
  name: string;
  sets: number;
  reps: string;
  restSeconds: number;
  equipment: Equipment;
}

export interface WorkoutDay {
  day: string;
  focus: string;
  exercises: Exercise[];
}

export interface WorkoutPlan {
  name: string;
  totalDays: number;
  days: WorkoutDay[];
}

// ─── Nutrition plan types ─────────────────────────────────────────────────────

export interface NutritionTargets {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface MealSuggestion {
  meal: string;
  foods: string[];
  calories: number;
  protein: number;
}

export interface DailyNutritionPlan {
  breakfast: MealSuggestion;
  lunch: MealSuggestion;
  dinner: MealSuggestion;
  targets: NutritionTargets;
}

export interface DailyPlan {
  date: string;
  workout: WorkoutDay | null;
  nutrition: DailyNutritionPlan;
}

// ─── Workout session tracking ─────────────────────────────────────────────────

export interface CompletedSet {
  setNumber: number;
  reps: number;
  weightLbs: number;
}

export interface SessionExercise {
  name: string;
  targetSets: number;
  targetReps: string;
  equipment: string;
  sets: CompletedSet[];
  aiRecommendation?: string; // e.g. "Try 165 lbs for 8 reps"
}

export interface WorkoutSession {
  id: string;
  date: string;           // ISO date string
  focus: string;
  durationSeconds: number;
  exercises: SessionExercise[];
  completed: boolean;
}

// ─── Navigation types ─────────────────────────────────────────────────────────

export type RootStackParamList = {
  Onboarding: undefined;
  Home: undefined;
};
