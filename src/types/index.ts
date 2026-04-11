// ─── Goal types ───────────────────────────────────────────────────────────────

/** @deprecated — use primaryGoal (string) from goalConfig instead */
export type Goal = string;
export type GoalPace = 'conservative' | 'moderate' | 'aggressive';
export type Gender = 'male' | 'female' | 'nonbinary' | 'prefer_not_to_say';
export type Equipment = 'home' | 'gym' | 'dumbbells' | 'bodyweight' | 'other';
export type AppThemeName =
  | 'midnight' | 'neon'    | 'ocean'   | 'forest'
  | 'ember'    | 'wine'    | 'obsidian'| 'amethyst'
  | 'citrus'   | 'flamingo'| 'cocoa'   | 'slate'
  | 'scarlet'  | 'sunrise' | 'arctic'  | 'rose'    | 'blossom'
  | 'parchment'| 'meadow';

export interface GoalOption {
  value: string;
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
  targetWeightLbs?: number;  // for fat-loss / muscle-gain goals
  targetEvent?: string;      // for strength, endurance, athletic (e.g. "315lb deadlift", "half marathon")
  timelineWeeks?: number;    // derived from pace for performance/recomp goals
  startWeightLbs?: number;   // weight at goal start — used for progress meter
  goalStartedAt?: string;    // ISO date when goal was set — used for timeline meter
}

// Hierarchical goal selection (new model)
export interface GoalSelection {
  primaryGoal: string;          // id from PRIMARY_GOALS
  category: string;             // GoalCategoryId — derived from primaryGoal
  modifiers: string[];          // up to 2 modifier ids
  targetFocus?: string;         // optional target focus id
}

export interface CustomFoodItem {
  name: string;
  unit: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface SavedMealTemplate {
  id: string;
  name: string;
  items: string[];
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

// ─── Injury tracking ─────────────────────────────────────────────────────────

export type InjuryStatus = 'active' | 'recovering' | 'resolved';

export interface InjuryEntry {
  id: string;
  description: string;           // e.g. "Lower back pain when deadlifting"
  bodyPart: string;              // e.g. "Lower back"
  reportedAt: string;            // ISO date string
  status: InjuryStatus;
  notes?: string;                // optional follow-up notes
}

// ─── User history log ─────────────────────────────────────────────────────────

export interface UserLogEntry {
  id: string;
  date: string;                  // ISO date string
  type: 'injury_added' | 'injury_status_update' | 'plan_generated' | 'weight_updated' | 'goal_updated';
  summary: string;               // human-readable one-liner
}

export interface UserProfile {
  // ── Hierarchical goal (new model) ──────────────────────────────────────────
  goal: Goal;                    // primary goal id (from goalConfig PRIMARY_GOALS)
  goalSelection?: GoalSelection; // full hierarchical selection (category + modifiers + target focus)
  goalDetails: GoalDetails;

  // ── Legacy (kept for backward compat — ignored when goalSelection exists) ──
  secondaryGoal?: Goal;          // @deprecated — replaced by modifiers
  focusedMuscleGroup?: string;   // @deprecated — replaced by goalSelection.targetFocus

  themePreference?: AppThemeName;
  physicalStats: PhysicalStats;
  daysPerWeek: number;
  workoutDurationMinutes: number;
  equipment: string[];           // specific item names e.g. 'Dumbbells', 'Barbell'
  foodsAvailable: string[];
  supplementsAvailable?: string[];  // supplements the user has / takes
  customFoods: CustomFoodItem[]; // user-added foods with AI-fetched macros
  savedMeals?: SavedMealTemplate[];
  mealRoutine?: string;          // user's fixed meal habits
  injuries?: string;             // legacy: free-text injuries
  injuryEntries?: InjuryEntry[]; // structured injury tracking with statuses
  experienceLevel?: 'beginner' | 'intermediate' | 'advanced';
  lastWorkoutContext?: string;   // what user last trained and when (new user onboarding context)
  customMacros?: CustomMacros;   // user-set macro overrides (replace computed TDEE targets)
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
  trainerNote?: string;  // AI explanation of why this plan was structured this way
}

// ─── Nutrition plan types ─────────────────────────────────────────────────────

export interface NutritionTargets {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

/** User-set macro overrides — if present, these replace computed TDEE/macro values. */
export interface CustomMacros {
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
}

export interface MealMicronutrients {
  fiber?: number;       // grams
  sugar?: number;       // grams
  sodium?: number;      // mg
  cholesterol?: number; // mg
  vitaminA?: number;    // % DV
  vitaminC?: number;    // % DV
  vitaminD?: number;    // % DV
  calcium?: number;     // % DV
  iron?: number;        // % DV
  potassium?: number;   // mg
}

export interface MealSuggestion {
  meal: string;
  foods: string[];
  amounts?: string[];   // portion per food item, parallel to foods[] e.g. ["6 oz", "1 cup", "2 cups"]
  calories: number;
  protein: number;
  carbs?: number;
  fat?: number;
  fiber?: number;       // grams — top-level shortcut for display
  micronutrients?: MealMicronutrients;
  instructions?: string; // brief recipe/cooking notes
  isRoutine?: boolean;   // user eats this meal every day — AI keeps it fixed
}

export interface SupplementItem {
  name: string;          // e.g. "Creatine Monohydrate"
  dose: string;          // e.g. "5g"
  timing: string;        // e.g. "Post-workout or anytime"
  purpose: string;       // e.g. "Increases muscle power and recovery"
  checked?: boolean;     // user has taken it today
}

export interface WorkoutSummary {
  caloriesBurned: number;
  motivationMessage: string;
  achievements: string[];
  recommendations: string[];
}

export interface StoredWorkoutSummary extends WorkoutSummary {
  id: string;
  date: string;        // ISO
  focus: string;
  durationSeconds: number;
  totalSets: number;
  totalReps: number;
}

export interface GoalHistoryEntry {
  id: string;
  goal: string;               // primary goal id
  pace: GoalPace;
  startedAt: string;          // ISO
  endedAt?: string;           // ISO — undefined means current active goal
  startWeightLbs?: number;
}

export interface PlanChangeEntry {
  id: string;
  changedAt: string;          // ISO timestamp
  changedBy: 'trainer' | 'nutritionist';
  summary: string;            // human-readable description of what changed
  question: string;           // the chat message that triggered the change
}

export interface MealRoutineFood {
  id: string;
  name: string;
  quantity?: string;          // e.g. "1 cup", "200g"
}

export interface MealRoutineEntry {
  id: string;
  name: string;               // e.g. "High Protein Breakfast"
  mealType?: string;          // breakfast | lunch | dinner | snack | custom
  foods: MealRoutineFood[];
  notes?: string;
  photoUri?: string;          // local file URI from camera/gallery
  createdAt: string;          // ISO
}

export interface DailyNutritionPlan {
  breakfast: MealSuggestion;
  lunch: MealSuggestion;
  dinner: MealSuggestion;
  snack?: MealSuggestion;
  extraMeals?: MealSuggestion[];
  removedMeals?: string[];
  targets: NutritionTargets;
  nutritionistNote?: string;   // AI explanation of why this plan was chosen
  supplementStack?: SupplementItem[]; // recommended supplements
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
  durationSeconds?: number; // for timed exercises (cardio, jump rope, etc.)
  rir?: number;
  feedback?: 'easy' | 'good' | 'grind' | 'hard' | 'failure' | 'pain' | 'form_breakdown';
}

export interface SessionExercise {
  name: string;
  targetSets: number;
  targetReps: string;
  targetRestSeconds: number;
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
  skipped?: boolean;      // true when the user skipped this day
  skipReason?: string;    // reason selected or typed by user
  feedback?: PostWorkoutFeedback;  // collected after finish
}

// ─── Post-workout feedback ────────────────────────────────────────────────────

export type WorkoutFeeling = 'great' | 'good' | 'okay' | 'rough';
export type WorkoutIntensity = 1 | 2 | 3 | 4 | 5; // 1=way too easy → 5=way too hard

export interface PostWorkoutFeedback {
  feeling: WorkoutFeeling;
  intensity: WorkoutIntensity;
  sorenessAreas: string[];
  notes: string;
}

// ─── Navigation types ─────────────────────────────────────────────────────────

export type RootStackParamList = {
  Onboarding: undefined;
  Home: undefined;
};
