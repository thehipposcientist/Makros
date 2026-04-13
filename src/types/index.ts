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
  | 'parchment'| 'meadow'
  | 'void'     | 'dusk'    | 'steel'   | 'sand'    | 'lavender'
  | 'aurora'   | 'copper'  | 'storm';

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

/** User-saved exercise from AI search. Stored in userProfile.customExercises
 *  (AsyncStorage) and merged into the library view on read. Deliberately
 *  client-only for now so we don't need a new backend table + migration. */
export interface CustomExerciseItem {
  id: string;                    // locally generated UUID-ish
  name: string;
  primary_muscle: string;        // matches the Exercise library muscle strings
  equipment: string;             // free-form to match the library's equipment tokens
  sets?: number;
  reps?: string;
  rest_seconds?: number;
  description?: string;          // the AI's "why" copy
  form_cues?: string[];
  source: 'ai' | 'manual';
  createdAt: string;             // ISO
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
  customExercises?: CustomExerciseItem[]; // AI-found exercises the user saved to their library
  /** How many distinct daily meal templates the AI generates. The client
   *  rotates these across 7 days (e.g. variety=2 → ABABABA, variety=7 → all
   *  unique). Lower = faster plan generation; higher = more variety.
   *  Default 3 matches the old hardcoded A/B/C behaviour. */
  mealVariety?: number;
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

/** Canonical unit system for meal items. Kept as a string union so it
 *  serializes cleanly to AsyncStorage/JSON without enum mapping.
 *  - Weight:  g, oz, lb
 *  - Volume:  ml, fl_oz, cup, tbsp, tsp
 *  - Discrete: piece (eggs, apples), slice (bread), scoop (protein powder),
 *    serving (generic "as the label says") */
export type FoodUnit =
  | 'g' | 'oz' | 'lb'
  | 'ml' | 'fl_oz' | 'cup' | 'tbsp' | 'tsp'
  | 'piece' | 'slice' | 'scoop' | 'serving';

/** Display labels for each unit, used in the MealEditModal unit picker. */
export const FOOD_UNIT_LABELS: Record<FoodUnit, string> = {
  g: 'g', oz: 'oz', lb: 'lb',
  ml: 'ml', fl_oz: 'fl oz', cup: 'cup', tbsp: 'tbsp', tsp: 'tsp',
  piece: 'piece', slice: 'slice', scoop: 'scoop', serving: 'serving',
};

export const FOOD_UNIT_GROUPS: { label: string; units: FoodUnit[] }[] = [
  { label: 'Weight', units: ['g', 'oz', 'lb'] },
  { label: 'Volume', units: ['ml', 'fl_oz', 'cup', 'tbsp', 'tsp'] },
  { label: 'Count',  units: ['piece', 'slice', 'scoop', 'serving'] },
];

/** One structured food entry inside a MealSuggestion. Quantity and unit are
 *  edited independently from the name so the user can change "2 eggs" → "3
 *  eggs" or "3 oz milk" → "1 cup milk" without re-picking the food.
 *
 *  Macros are snapshotted at add-time and NOT auto-recalculated when the
 *  quantity changes. Building per-gram recalculation on top of the
 *  food_servings table is a follow-up feature — for now edits are
 *  display-only on the frontend. */
export interface MealItem {
  name: string;         // "eggs", "chicken breast", "oatmeal" — no quantity
  quantity: number;     // 2, 1.5, 200
  unit: FoodUnit;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  // Baseline rate used by the edit UI to scale macros proportionally when
  // the user changes `quantity`. Captured at add-time so zero → N edits
  // still work (scaling off `current` breaks when current hits 0).
  // Optional so existing saved meals without these fields keep working;
  // the edit UI captures them lazily on first load.
  baseQuantity?: number;
  baseCalories?: number;
  baseProtein?: number;
  baseCarbs?: number;
  baseFat?: number;
}

export interface MealSuggestion {
  meal: string;
  /** Canonical structured list. Prefer this over `foods`/`amounts` in new code. */
  items?: MealItem[];
  /** @deprecated Parallel arrays preserved for backwards compat with older
   *  saved plans and the backend schema. New code should read from `items`
   *  and fall through to these only when migrating old data. */
  foods: string[];
  amounts?: string[];
  calories: number;
  protein: number;
  carbs?: number;
  fat?: number;
  fiber?: number;       // grams — top-level shortcut for display
  micronutrients?: MealMicronutrients;
  instructions?: string; // brief recipe/cooking notes (first variation)
  // Additional recipe variations fetched via the "Try another way" button
  // in the recipe modal. Index 0 mirrors `instructions` when set; later
  // entries are alternate preparations of the same ingredient list.
  instructionVariants?: string[];
  isRoutine?: boolean;   // user eats this meal every day — AI keeps it fixed
  estimated_alignment?: string;
  // Stable client-side IDs used for extra meals. `_localId` identifies a
  // preserved (user-checked) extra so it survives plan regeneration.
  // `_routineId` identifies an extra pinned as a routine.
  _localId?: string;
  _routineId?: string;
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
  // Snapshot of macros at the time the routine was pinned. Used to rebuild the
  // MealSuggestion when the routine is applied to a day without losing nutrient
  // totals. Optional for backwards compat with older routines saved before
  // this field was added.
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  // Canonical structured snapshot of the items at pin time. Preferred over
  // `foods` when applying the routine back to a day's plan because each item
  // carries its own per-item macros, unit, and quantity.
  items?: MealItem[];
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

// ─── Body scan ───────────────────────────────────────────────────────────────

export interface BodyScanEntry {
  id: string;
  date: string;
  bodyFatPct: number;
  bodyFatRange: string;
  muscleMass: string;
  category: string;
  strengths: string[];
  improvements: string[];
  assessment: string;
  weightLbs?: number;
}

// ─── Apple Health / fitness scoring ───────────────────────────────────────────

export type RecoveryMarker = 'green' | 'yellow' | 'red';

export interface HealthSummary {
  restingHeartRate: number | null;    // bpm
  avgSteps7d: number | null;
  workouts7d: number | null;          // Apple Health workout count
  avgSleepHours7d: number | null;
  lastNightSleepHours: number | null;
  activeEnergy7d: number | null;      // kcal, optional
  fetchedAt: string;                  // ISO timestamp
}

export interface HealthScoreResult {
  fitnessScore: number;               // 0-100
  recoveryMarker: RecoveryMarker;
  scoreInputs: {
    workoutPoints: number;            // 0-40
    stepsPoints: number;              // 0-15
    consistencyPoints: number;        // 0-15
    heartRatePoints: number;          // 0-10
    sleepPoints: number;              // 0-15
    activeEnergyPoints: number;       // 0-5
  };
  recoveryInputs: {
    sleepVsAverage: number | null;    // hours above/below 7d avg
    rhrStatus: 'normal' | 'elevated' | 'unknown';
    recentLoad: 'light' | 'moderate' | 'heavy';
  };
}

// ─── Navigation types ─────────────────────────────────────────────────────────

export type RootStackParamList = {
  Onboarding: undefined;
  Home: undefined;
};
