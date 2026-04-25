// ─── Goal types ───────────────────────────────────────────────────────────────

/** @deprecated — use primaryGoal (string) from goalConfig instead */
export type Goal = string;
export type GoalPace = 'conservative' | 'moderate' | 'aggressive';
export type Gender = 'male' | 'female' | 'nonbinary' | 'prefer_not_to_say';
export type Equipment = 'home' | 'gym' | 'dumbbells' | 'bodyweight' | 'other';
export type AppThemeName =
  | 'midnight' | 'neon'    | 'ocean'   | 'forest'
  | 'ember'    | 'wine'    | 'obsidian'| 'amethyst'
  | 'citrus'              | 'cocoa'   | 'slate'
  | 'scarlet'  | 'sunrise' | 'arctic'  | 'rose'    | 'blossom'
  | 'parchment'| 'meadow'
  | 'void'     | 'dusk'    | 'steel'   | 'sand'    | 'lavender'
  | 'aurora'   | 'copper'  | 'storm'
  | 'linen'    | 'mint'
  | 'butter'   | 'seaglass' | 'lilac' | 'cloud';

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
  /** Cached integer age. Derived from `birthdate` when it's set so the
   *  value stays accurate year-over-year without the user re-entering. */
  age: number;
  /** ISO date (YYYY-MM-DD). Source of truth once collected. Optional so
   *  existing users who signed up before birthday collection can still
   *  load their profile — a soft prompt backfills them over time. */
  birthdate?: string;
  gender: Gender;
}

// ─── Manual activity logging ──────────────────────────────────────────────────

export type ActivityCategory = 'strength' | 'cardio' | 'mobility' | 'sport' | 'active' | 'recovery';
export type StrengthSubtype = 'push' | 'pull' | 'legs' | 'upper_body' | 'lower_body' | 'full_body';
export type CardioSubtype = 'walk' | 'run' | 'ride' | 'hike' | 'swim' | 'row' | 'stair' | 'elliptical' | 'bootcamp' | 'other';
export type MobilitySubtype = 'yoga' | 'stretching' | 'foam_roll' | 'pilates';
export type SportSubtype = 'basketball' | 'soccer' | 'tennis' | 'golf' | 'climbing' | 'boxing' | 'kickboxing' | 'martial_arts' | 'skiing' | 'other';
export type RecoverySubtype = 'sauna' | 'ice_bath' | 'walk' | 'sleep' | 'meditation' | 'general';
export type ActivityIntensity = 'easy' | 'moderate' | 'hard';
export type CardioStyle = 'recovery' | 'steady' | 'intervals' | 'class';
export type ActivitySource = 'manual' | 'peloton' | 'apple_health' | 'garmin';

export interface ManualActivity {
  id: string;
  date: string;
  category: ActivityCategory;
  subtype: string;
  intensity: ActivityIntensity;
  durationMinutes: number;
  notes?: string;
  cardioStyle?: CardioStyle;
  source?: ActivitySource;
  distanceMiles?: number;
  caloriesBurned?: number;
  avgHeartRate?: number;
}

// ─── Weight tracking ─────────────────────────────────────────────────────────

export interface WeightEntry {
  date: string;   // ISO date YYYY-MM-DD
  weightLbs: number;
  source?: 'manual' | 'onboarding' | 'coach' | 'checkin';
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
  targetFocus?: string;         // @deprecated — use priorityRegion on UserProfile instead
}

export interface CustomFoodItem {
  name: string;
  unit: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  // Micronutrients — snake_case to match backend MICRONUTRIENT_FIELDS.
  // Optional; only populated when the enrichment or validation path
  // has data.
  micronutrients?: Record<string, number>;
  /** Verification lifecycle:
   *   ai_estimated     — created from a scan/search, not yet checked
   *   ai_validated     — AI confirmed values are within USDA tolerance
   *   user_corrected   — user manually edited the values
   *   seed_verified    — sourced from the backend seed DB
   *   insufficient_data — AI couldn't verify (brand-specific, etc.)
   */
  verificationStatus?: 'ai_estimated' | 'ai_validated' | 'user_corrected' | 'seed_verified' | 'insufficient_data';
  /** ISO timestamp of the last validation attempt. Lets the background
   *  re-check job skip recently-validated rows. */
  lastValidatedAt?: string;
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
  muscleGroups?: string[];       // mapped muscle groups: ["back", "core", "hamstrings"]
  severity?: 'mild' | 'moderate' | 'severe';
  reportedAt: string;            // ISO date string
  estimatedRecoveryDays?: number; // AI-estimated recovery time
  estimatedRecoveryDate?: string; // ISO date — reportedAt + estimatedRecoveryDays
  status: InjuryStatus;
  statusUpdatedAt?: string;      // ISO date — last status change
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

  // Training emphasis: "balanced" | "lower_body" | "upper_body"
  priorityRegion?: string;

  // ── Legacy (kept for backward compat) ──
  secondaryGoal?: Goal;          // @deprecated
  focusedMuscleGroup?: string;   // @deprecated — replaced by priorityRegion

  themePreference?: AppThemeName;
  physicalStats: PhysicalStats;
  daysPerWeek: number;
  /** Specific days the user can train. 0=Sun, 1=Mon, ..., 6=Sat.
   *  When set, overrides daysPerWeek for scheduling. Length must match daysPerWeek. */
  trainingDays?: number[];
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
  /** Number of meals the user eats per day (1-6). Drives both the
   *  generic meals[] count the assembler produces and the local
   *  `planGenerator` fallback. Default 3. */
  mealsPerDay?: number;
  savedMeals?: SavedMealTemplate[];
  mealRoutine?: string;          // user's fixed meal habits
  injuries?: string;             // legacy: free-text injuries
  injuryEntries?: InjuryEntry[]; // structured injury tracking with statuses
  experienceLevel?: 'beginner' | 'intermediate' | 'advanced';
  /** Training split preference. "auto" or null = planner picks the best
   *  split for the user's goal + days. Otherwise one of:
   *  "full_body" | "upper_lower" | "ppl" | "ppl_upper_lower" | "bro" */
  preferredSplit?: string;
  lastWorkoutContext?: string;   // what user last trained and when (new user onboarding context)
  customMacros?: CustomMacros;   // user-set macro overrides (replace computed TDEE targets)
  weightHistory?: WeightEntry[];
  dislikedExercises?: string[];  // exercise names excluded from plan generation
  /** Subscription tier. `free` = manual tracking only (no AI, no generators).
   *  `pro` = full feature set. Persisted locally for MVP; server-of-record
   *  once billing ships. Default `pro` for existing users so they keep
   *  everything they've had; new signups should be created as `free`. */
  subscriptionTier?: 'free' | 'pro';
}

// ─── Workout plan types ───────────────────────────────────────────────────────

/** Per-set programming role. Emitted by the backend's
 *  set_programming module so the UI can render heavy vs volume set
 *  structure directly on the exercise card. */
export type SetType = 'warmup' | 'heavy_top' | 'backoff' | 'volume' | 'technique';

/** How the next-set / next-session recommender should bias
 *  progression on this set: load first, reps first, or hold. */
export type ProgressionMode = 'load_first' | 'reps_first' | 'fixed_skill';

/** Source tag for a starting-weight recommendation. Matches
 *  RecommendationSource on the backend. */
export type WeightRecommendationSource =
  | 'exact_history'
  | 'substitution_group'
  | 'movement_pattern'
  | 'muscle_bucket'
  | 'default';

export interface PlannedSet {
  setNumber: number;
  setType: SetType;
  targetReps: string;
  targetRir: number;
  targetWeightLbs: number | null;
  progressionMode: ProgressionMode;
}

export interface Exercise {
  name: string;
  sets: number;
  reps: string;
  restSeconds: number;
  equipment: Equipment;
  image_url?: string;
  // ── New progression layer (all optional — backward compatible) ──
  /** Anchor target weight for the FIRST working set. Heavy-top and
   *  backoff loads inside setScheme are derived from this. Null when
   *  the user has no transferable history and the default baseline
   *  is too coarse to emit. */
  targetWeightLbs?: number | null;
  /** Where the recommendation came from — for UI attribution like
   *  "Based on your last 3 bench sessions". */
  weightRecommendationSource?: WeightRecommendationSource | null;
  /** 0..1 confidence in the recommendation. */
  weightRecommendationConfidence?: number | null;
  /** Human-readable reason string safe to show in the UI. */
  weightRecommendationReason?: string | null;
  /** Per-set programming: set number, type, reps, RIR, target weight,
   *  and progression mode. Rendered as heavy/backoff/volume pills in
   *  the active-workout UI. */
  setScheme?: PlannedSet[];
  /** Session-over-session progression verdict when the plan is
   *  regenerated from history ('increase_load' | 'hold_load' | 'reduce_load'). */
  progressionAction?: 'increase_load' | 'hold_load' | 'reduce_load' | 'keep_reps' | 'add_rep' | null;
}

export interface WorkoutDay {
  day: string;
  focus: string;
  /** Training stimulus intent: "strength" | "hypertrophy" | "volume" |
   *  "conditioning" | "mobility" | "recovery" | "mixed". Shipped by the
   *  planner from the archetype's training_type. Drives the stimulus
   *  badge on the workout card. */
  stimulus?: string;
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

/** Per-meal micronutrient panel. Field names mirror the backend's
 *  `MICRONUTRIENT_FIELDS` constant in `meal_assembler.py` so values flow
 *  through unchanged. The backend always emits every key (defaulting to 0
 *  when source data lacks a value) so the frontend can render "—" without
 *  null-check noise.
 *
 *  The legacy camelCase aliases (`vitaminA`, `vitaminC`, ...) are kept
 *  for back-compat with cached client plans that were generated before
 *  the snake_case rename. New code should read the snake_case names. */
export interface MealMicronutrients {
  // Core / always-present
  fiber?: number;       // g
  sugar?: number;       // g
  sodium?: number;      // mg
  cholesterol?: number; // mg
  // Fats panel
  saturated_fat?: number;       // g
  monounsaturated_fat?: number; // g
  polyunsaturated_fat?: number; // g
  omega_3?: number;             // g
  omega_6?: number;             // g
  // Vitamins
  vitamin_a?: number;             // µg RAE
  vitamin_c?: number;             // mg
  vitamin_d?: number;             // µg
  vitamin_e?: number;             // mg
  vitamin_k?: number;             // µg
  thiamin_b1?: number;            // mg
  riboflavin_b2?: number;         // mg
  niacin_b3?: number;             // mg
  vitamin_b6?: number;            // mg
  folate_b9?: number;             // µg
  vitamin_b12?: number;           // µg
  biotin_b7?: number;             // µg
  pantothenic_acid_b5?: number;   // mg
  // Minerals
  calcium?: number;     // mg
  iron?: number;        // mg
  magnesium?: number;   // mg
  phosphorus?: number;  // mg
  potassium?: number;   // mg
  zinc?: number;        // mg
  selenium?: number;    // µg
  copper?: number;      // mg
  manganese?: number;   // mg
  // Legacy camelCase aliases — preserved so cached pre-refactor plans
  // still display. New backend output does NOT populate these.
  vitaminA?: number;
  vitaminC?: number;
  vitaminD?: number;
}

/** Canonical unit system for meal items. Kept as a string union so it
 *  serializes cleanly to AsyncStorage/JSON without enum mapping.
 *  - Weight:  g, kg, oz, lb
 *  - Volume:  ml, l, fl_oz, cup, tbsp, tsp, pint, quart, gallon
 *  - Discrete: piece (eggs, apples), slice (bread), scoop (protein powder),
 *    serving (generic "as the label says") */
export type FoodUnit =
  | 'g' | 'kg' | 'oz' | 'lb'
  | 'ml' | 'l' | 'fl_oz' | 'cup' | 'tbsp' | 'tsp' | 'pint' | 'quart' | 'gallon'
  | 'piece' | 'slice' | 'scoop' | 'serving';

/** Display labels for each unit, used in the MealEditModal unit picker. */
export const FOOD_UNIT_LABELS: Record<FoodUnit, string> = {
  g: 'g', kg: 'kg', oz: 'oz', lb: 'lb',
  ml: 'ml', l: 'L', fl_oz: 'fl oz', cup: 'cup', tbsp: 'tbsp', tsp: 'tsp',
  pint: 'pint', quart: 'quart', gallon: 'gallon',
  piece: 'piece', slice: 'slice', scoop: 'scoop', serving: 'serving',
};

export const FOOD_UNIT_GROUPS: { label: string; units: FoodUnit[] }[] = [
  { label: 'Weight', units: ['g', 'kg', 'oz', 'lb'] },
  { label: 'Volume', units: ['ml', 'l', 'fl_oz', 'cup', 'pint', 'quart', 'gallon', 'tbsp', 'tsp'] },
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
  micronutrients?: Record<string, number>;
  food_quality?: 'whole' | 'processed' | 'unknown';
  protein_source?: 'plant' | 'animal' | 'mixed' | 'none' | 'unknown';
  fermented?: boolean;
  probiotic?: boolean;
  omega3_rich?: boolean;
  plant_count?: number;
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
  // Structured v2 fields — backend now returns these alongside the
  // legacy motivationMessage/recommendations for back-compat.
  headline?: string;
  comparison?: string;
  coachingPoint?: string;
  motivation?: string;
  /** HR stats from Apple Health (if user wore watch). Annotated after finish. */
  hrAvg?: number;
  hrMax?: number;
  /** Minutes in each HR zone Z1..Z5. */
  hrZoneMinutes?: [number, number, number, number, number];
  /** Training score — 0-100 measure of "how productive was this session?".
   *  Computed at finish time from HR zones + duration + sets vs plan.
   *  Stored so Progress charts can compare it against the day's
   *  readiness / sleep score over time. */
  trainingScore?: number;
  trainingRating?: 'Crushed' | 'Solid' | 'Light' | 'Below';
  trainingPillars?: { effort: number; volume: number; duration: number; consistency: number };
}

/** Per-exercise logged detail kept alongside the AI summary so the
 *  Progress screen can render "exactly what you did" — exercise name,
 *  equipment, and every logged set (weight, reps, optional duration). */
export interface StoredWorkoutSummaryExercise {
  name: string;
  equipment?: string | null;
  targetSets?: number;
  targetReps?: string;
  sets: CompletedSet[];
}

/** End-of-workout feedback captured on the summary modal. Optional —
 *  older summaries predating this field still load cleanly. */
export interface StoredWorkoutSummaryFeedback {
  feeling: WorkoutFeeling;
  intensity: WorkoutIntensity;
  sorenessAreas: string[];
  notes?: string;
}

export interface StoredWorkoutSummary extends WorkoutSummary {
  id: string;
  date: string;        // ISO
  focus: string;
  durationSeconds: number;
  totalSets: number;
  totalReps: number;
  startedAt?: string;  // ISO — exact workout start time
  endedAt?: string;    // ISO — exact workout end time
  // Full per-exercise detail — what the user actually did. Populated
  // at finish time; older summaries may omit this.
  exercises?: StoredWorkoutSummaryExercise[];
  // End-of-workout feedback. Populated by handleSubmitFeedback after
  // the user taps submit on the feedback form.
  feedback?: StoredWorkoutSummaryFeedback;
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
  /** Generic flat list of meals for the day. There is no breakfast/lunch/
   *  dinner concept anymore — every meal is equal. The list contains
   *  generated meals, pinned routine meals, and user-added extras
   *  interleaved in display order. Routine meals carry `_routineId`,
   *  user-added one-offs carry `_localId`. */
  meals: MealSuggestion[];
  /** Indices into `meals[]` that the user has hidden for the day. */
  removedMealIds?: string[];
  targets: NutritionTargets;
  nutritionistNote?: string;
  supplementStack?: SupplementItem[];
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
  aiRecommendation?: string;
  image_url?: string;
  /** Anchor target weight emitted by the deterministic planner (already
   *  history-aware). Forwarded to the weight-recommendation endpoint as
   *  `plannedTargetWeightLbs` so recs stay grounded in the session plan. */
  targetWeightLbs?: number | null;
  /** Canonical slug for this exercise (when known). Lets the weight-rec
   *  endpoint skip the name-based lookup and run the performance-profile
   *  pipeline directly. */
  slug?: string | null;
  /** Primary muscle slug from the exercise library. Used to bias weight
   *  recs when the exact exercise has no direct history. */
  primaryMuscle?: string | null;
  /** Where targetWeightLbs came from. 'default' means the planner
   *  fell through to the dumb category-default table — ActiveWorkoutScreen
   *  refreshes those with the AI helper before showing the user. */
  weightRecommendationSource?: string | null;
}

export interface WorkoutSession {
  id: string;
  date: string;           // ISO date string
  focus: string;
  durationSeconds: number;
  startedAt?: string;     // ISO — exact workout start time
  endedAt?: string;       // ISO — exact workout end time
  exercises: SessionExercise[];
  completed: boolean;
  skipped?: boolean;      // true when the user skipped this day
  skipReason?: string;    // reason selected or typed by user
  feedback?: PostWorkoutFeedback;  // collected after finish
  manualActivity?: {      // structured data from the redesigned LogActivityModal
    category: ActivityCategory;
    subtype: string;
    intensity: ActivityIntensity;
    cardioStyle?: CardioStyle;
    notes?: string;
    source?: ActivitySource;
    distanceMiles?: number;
    caloriesBurned?: number;
    avgHeartRate?: number;
  };
  /** PR achievements detected on this session's completion (Feature 2).
   *  Persisted locally so the Progress screen can surface "🏆 PR" badges
   *  in history view without re-querying the backend. */
  prs?: Array<{
    exercise_name: string;
    kind: 'heaviest_weight' | 'estimated_1rm' | 'volume_record';
    new_value: number;
    old_value: number;
    reps?: number | null;
    weight_lbs?: number | null;
  }>;
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

export interface SleepStages {
  core: number;
  deep: number;
  rem: number;
  awake: number;
  total: number;
}

export interface WorkoutDetail {
  activityType: number;
  activityName: string;
  duration: number;
  startDate: string;
  endDate: string;
  calories?: number;
  distanceMiles?: number;
}

export type SleepScoreMode = 'mvp' | 'personalized';

export interface SleepScorePillars {
  duration: number;
  efficiency: number;
  hrv: number;
  regularity?: number;
  stageComposite: number;
  healthFlags: number;
}

export interface SleepScore {
  score: number;
  rating: 'Excellent' | 'Good' | 'Fair' | 'Poor';
  mode: SleepScoreMode;
  duration: number;
  stages: SleepStages;
  hrvAvg: number | null;
  respiratoryRate: number | null;
  oxygenSaturation: number | null;
  efficiency: number | null;
  pillars: SleepScorePillars;
  insights: string[];
}

export interface HealthSummary {
  restingHeartRate: number | null;
  avgSteps7d: number | null;
  workouts7d: number | null;
  avgSleepHours7d: number | null;
  lastNightSleepHours: number | null;
  activeEnergy7d: number | null;
  hrvAvg: number | null;
  vo2Max: number | null;
  respiratoryRate: number | null;
  oxygenSaturation: number | null;
  standingHours7d: number | null;
  mindfulMinutes7d: number | null;
  basalEnergy7d: number | null;
  sleepScore: SleepScore | null;
  workoutDetails: WorkoutDetail[];
  fetchedAt: string;
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
