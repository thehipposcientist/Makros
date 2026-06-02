// ─── Goal types ───────────────────────────────────────────────────────────────

/** @deprecated — use primaryGoal (string) from goalConfig instead */
export type Goal = string;
export type GoalPace = 'conservative' | 'moderate' | 'aggressive';
export type Gender = 'male' | 'female' | 'nonbinary' | 'prefer_not_to_say';
export type Equipment = 'home' | 'gym' | 'dumbbells' | 'bodyweight' | 'other' | (string & {});
export type SubscriptionTier = 'free' | 'pro';
export type SubscriptionStatus =
  | 'free'
  | 'trialing'
  | 'trial_cancelled'
  | 'active'
  | 'grace_period'
  | 'cancelled'
  | 'expired'
  | 'revoked'
  | 'billing_issue'
  | 'beta'
  | 'promotional'
  | 'temporary';
import type { AppThemeName as _AppThemeName } from '../constants/theme';
export type { AppThemeName } from '../constants/theme';
type AppThemeName = _AppThemeName;

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
export type CardioSubtype = 'walk' | 'run' | 'ride' | 'hike' | 'swim' | 'row' | 'stair' | 'elliptical' | 'hiit' | 'bootcamp' | 'other';
export type MobilitySubtype = 'yoga' | 'stretching' | 'foam_roll' | 'pilates';
export type SportSubtype = 'basketball' | 'soccer' | 'tennis' | 'pickleball' | 'volleyball' | 'beach_volleyball' | 'golf' | 'climbing' | 'boxing' | 'kickboxing' | 'martial_arts' | 'skiing' | 'surfing' | 'other';
export type RecoverySubtype =
  | 'finnish_sauna' | 'infrared_sauna' | 'cold_plunge' | 'contrast'
  | 'breathwork' | 'stretching' | 'walk' | 'sleep' | 'meditation' | 'general'
  // Legacy keys preserved so previously-saved sessions still decode. New
  // logs always pick from the explicit options above.
  | 'sauna' | 'ice_bath';
export type ActivityIntensity = 'easy' | 'moderate' | 'hard';
export type CardioStyle = 'recovery' | 'easy' | 'steady' | 'intervals' | 'class';
export type ActivitySource = 'manual' | 'peloton' | 'apple_health' | 'garmin' | 'strava' | 'live_tracker';

/** Per-subtype structured detail captured by LogActivityModal. Every
 *  field is optional and only appears when the user
 *  entered a value. Shape is intentionally a flat union of all known
 *  fields rather than a discriminated map so it round-trips through the
 *  backend's JSONB column without per-subtype schema drift.
 *
 *  Temperature is stored in °F (US default). Convert at the view layer
 *  for °C users — there's no need to persist both. */
export interface ManualActivityDetails {
  // ── Recovery ───────────────────────────────────────────────
  temperatureF?: number;         // sauna or cold plunge water temp
  humidityPct?: number;          // sauna only
  waterImmersion?: 'waist' | 'chest' | 'neck' | 'full';   // cold plunge
  breathworkProtocol?: 'box' | '4-7-8' | 'wim_hof' | 'physiological_sigh' | 'other';
  rounds?: number;               // breathwork / contrast cycles

  // ── Session effort ──────────────────────────────────────────
  sessionRpe?: number;           // 1-10 session-level RPE

  // ── Cardio (swim) ──────────────────────────────────────────
  poolLengthMeters?: number;
  swimStroke?: 'freestyle' | 'backstroke' | 'breaststroke' | 'butterfly' | 'mixed';
  laps?: number;

  // ── Cardio (run / ride / hike) ─────────────────────────────
  terrain?: 'road' | 'trail' | 'treadmill' | 'track' | 'indoor';
  elevationGainFt?: number;
  elevationHighFt?: number;
  elevationLowFt?: number;
  movingSeconds?: number;
  elapsedSeconds?: number;
  stoppedSeconds?: number;
  durationSource?: string;
  avgWatts?: number;             // cycling power
  avgWattsSource?: 'estimated_from_distance_duration_elevation' | 'manual' | string;
  weightedAvgWatts?: number;
  maxWatts?: number;
  kilojoules?: number;
  avgSpeedMph?: number;
  maxSpeedMph?: number;
  avgPaceSecPerMi?: number;
  avgCadence?: number;
  steps?: number;
  caloriesEstimated?: boolean;
  calorieEstimateSource?: 'met_bodyweight_duration_distance' | string;
  calorieEstimateConfidence?: 'low' | 'medium' | string;
  calorieEstimateMet?: number;
  indoorOutdoor?: 'indoor' | 'outdoor';

  // ── Sport ──────────────────────────────────────────────────
  climbingGrade?: string;        // e.g. "5.10b" / "V4"
  climbingStyle?: 'boulder' | 'sport' | 'top_rope' | 'trad' | 'gym';
  skiVerticalFt?: number;
  skiRuns?: number;

  // ── Mobility ───────────────────────────────────────────────
  yogaStyle?: 'vinyasa' | 'hatha' | 'yin' | 'hot' | 'restorative' | 'power' | 'other';
}

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
  source?: 'manual' | 'onboarding' | 'coach' | 'checkin' | 'watch';
  loggedAt?: string;
}

export interface GoalDetails {
  pace: GoalPace;
  targetWeightLbs?: number;  // for fat-loss / muscle-gain goals
  targetEvent?: string;      // for strength, endurance, athletic (e.g. "315lb deadlift", "half marathon")
  timelineWeeks?: number;    // derived from pace for performance/recomp goals
  startWeightLbs?: number;   // weight at goal start — used for progress meter
  startBodyFatPct?: number;  // body-fat % at goal start (from BodyScan within 30d). Null when no scan existed.
  goalStartedAt?: string;    // ISO date when goal was set — used for timeline meter
}

export interface StrengthEquipmentSettings {
  dumbbells?: {
    type?: 'fixed' | 'adjustable';
    minLbs?: number;
    maxLbs?: number;
    incrementLbs?: number;
  };
  barbell?: {
    barWeightLbs?: number;
    platePairsLbs?: number[];
    maxLoadLbs?: number;
  };
}

export type StrengthBaselineLiftKey =
  | 'bench_press'
  | 'squat'
  | 'deadlift'
  | 'overhead_press'
  | 'pull_up';

export interface StrengthBaselineLift {
  key: StrengthBaselineLiftKey;
  exerciseSlug: string;
  name: string;
  weightLbs?: number;
  reps?: number;
}

export interface StrengthBaselines {
  version: 1;
  lifts: StrengthBaselineLift[];
}

export interface CardioBaseline {
  canJog10Min?: boolean;
  comfortableDurationMin?: number;
  recentMileTimeMin?: number;
  recent5kTimeMin?: number;
  preferredModes?: string[];
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

/** User-saved exercise from AI search/photo scan/manual entry. Mirrored in
 *  the backend user_custom_exercises table, with userProfile.customExercises
 *  kept as the hot local cache and legacy fallback. */
export interface CustomExerciseItem {
  id: string;                    // locally generated UUID-ish
  server_id?: number;            // backend user_custom_exercises.id when synced
  name: string;
  primary_muscle: string;        // matches the Exercise library muscle strings
  secondary_muscles?: string[];
  equipment: string;             // free-form to match the library's equipment tokens
  equipment_slugs?: string[];     // backend-normalized planner equipment keys
  equipment_bucket?: string;
  movement_pattern?: string | null;
  exercise_type?: 'strength' | 'cardio' | 'mobility' | string;
  default_tracking_mode?: 'reps' | 'time' | 'distance' | 'calories' | string;
  is_compound?: boolean | null;
  image_url?: string | null;
  video_id?: string | null;
  demo_exercise_db_id?: string | null;
  sets?: number;
  reps?: string;
  rest_seconds?: number;
  description?: string;          // the AI's "why" copy
  form_cues?: string[];
  aliases?: string[];
  programming_tags?: string[];
  source: 'ai' | 'manual';
  plan_eligible?: boolean;
  ai_confidence?: 'high' | 'medium' | 'low' | 'user_confirmed' | string | null;
  validation_status?: 'planner_ready' | 'needs_review' | 'blocked' | string;
  createdAt: string;             // ISO
  updatedAt?: string;             // ISO
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

export type Glp1AppetiteLevel = 'normal' | 'reduced' | 'very_low';
export type Glp1SideEffect =
  | 'nausea'
  | 'constipation'
  | 'reflux'
  | 'low_appetite'
  | (string & {});

export interface Glp1SupportSettings {
  enabled: boolean;
  appetite?: Glp1AppetiteLevel;
  sideEffects?: Glp1SideEffect[];
  updatedAt?: string;
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

// ─── Passive sun exposure estimates ─────────────────────────────────────────

export type SunExposureLocationMode =
  | 'off'
  | 'workout_routes_only'
  | 'coarse_location'
  | 'precise_during_active_workout';

export interface SunExposurePreferences {
  enabled: boolean;
  useWorkoutRoutes: boolean;
  useCoarseLocation: boolean;
  useHealthDaylightData: boolean;
  useAreaCoefficients: boolean;
  allowCorrectionPrompts: boolean;
  highUvRemindersEnabled: boolean;
  locationMode: SunExposureLocationMode;
}

export type AreaSunType =
  | 'indoor'
  | 'vehicle'
  | 'dense_forest'
  | 'wooded_trail'
  | 'park_mixed'
  | 'open_grass'
  | 'beach'
  | 'snow'
  | 'water_edge'
  | 'urban_street'
  | 'sports_field'
  | 'unknown';

export interface AreaSunContext {
  areaType: AreaSunType;
  skyExposureCoefficient: number;
  reflectionCoefficient: number;
  source: 'osm' | 'landcover' | 'tree_canopy' | 'building_polygon' | 'manual' | 'unknown';
  confidence: 'low' | 'medium' | 'high';
  reasonCodes: string[];
}

export interface SunExposureSegment {
  id: number | string;
  userId?: number;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  coarseLocationHash?: string | null;
  activityId?: number | null;
  uvIndexAverage: number;
  uvIndexMax: number;
  lightIntensityLux?: number | null;
  localStartMinute?: number | null;
  localEndMinute?: number | null;
  timezoneOffsetMinutes?: number | null;
  daylight: boolean;
  outdoorConfidence: number;
  areaContext: AreaSunContext;
  effectiveUvMinutes: number;
  openSkyEquivalentMinutes: number;
  confidence: 'low' | 'medium' | 'high';
  source: 'healthkit_daylight' | 'workout_route' | 'activity_recognition' | 'coarse_location' | 'manual';
}

export interface SunExposureDailySummary {
  userId?: number;
  date: string;
  likelyOutdoorDaylightMinutes: number;
  confirmedOutdoorDaylightMinutes: number;
  possibleOutdoorDaylightMinutes: number;
  mostlyShadedMinutes: number;
  mostlyOpenSkyMinutes: number;
  highUvMinutes: number;
  veryHighUvMinutes: number;
  effectiveUvMinutes: number;
  openSkyEquivalentMinutes: number;
  daylightMinutes?: number;
  appleHealthDaylightMinutes?: number;
  lightIntensityLuxAverage?: number | null;
  lightIntensityLuxMax?: number | null;
  uvIndexAverage?: number;
  uvIndexMax?: number;
  morningDaylightMinutes?: number;
  middayDaylightMinutes?: number;
  afternoonDaylightMinutes?: number;
  uvRiskScore?: number;
  uvRiskLabel?: string;
  sunScore?: number;
  sunScoreLabel?: string;
  confidence: 'low' | 'medium' | 'high';
  explanation: string;
  safetyMessage?: string | null;
}

export type SunExposureCorrectionOption =
  | 'mostly_sunny'
  | 'mixed'
  | 'mostly_shaded'
  | 'indoors'
  | 'wrong_activity'
  | 'dismiss';

// ─── User history log ─────────────────────────────────────────────────────────

export interface UserLogEntry {
  id: string;
  date: string;                  // ISO date string
  type: 'injury_added' | 'injury_status_update' | 'plan_generated' | 'weight_updated' | 'goal_updated';
  summary: string;               // human-readable one-liner
}

export interface UserProfile {
  firstName?: string;
  lastName?: string;

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
  /** Single-question signup answer: what is the user here for? Drives
   *  the default `hiddenSurfaces` (fitness → hides meals, nutrition →
   *  hides workouts, both → nothing hidden) and lets onboarding skip
   *  irrelevant steps. Reversible from Settings. Defaults to 'both'
   *  for any profile created before this field existed. */
  appFocus?: 'fitness' | 'nutrition' | 'both';
  /** In-flight import handoffs started from onboarding/settings. The
   *  backend stores this in UserPreferences.pending_imports so the app
   *  can remind the user to finish export/import loops across devices. */
  pendingImports?: PendingImportEntry[];
  /** Optional passive estimate preferences. Derived sun records store
   *  coarse area context and coefficients, not raw passive GPS. */
  sunExposurePreferences?: SunExposurePreferences;
  /** Reversible app-surface visibility. Hidden surfaces keep their data
   *  intact but are removed from primary navigation and related progress UI. */
  hiddenSurfaces?: {
    workouts?: boolean;
    meals?: boolean;
  };
  /** Display preference for body weight + lifting weight inputs. Storage
   *  is always lbs (canonical); formatters convert at the display layer. */
  weightUnit?: 'lbs' | 'kg';
  /** Display preference for distance (cardio mileage, gear mileage).
   *  Storage is always miles; formatters convert at the display layer. */
  distanceUnit?: 'mi' | 'km';
  /** Display preference for body height. Storage stays as heightFeet +
   *  heightInches on physicalStats; metric just converts at render/input. */
  heightUnit?: 'in' | 'cm';
  physicalStats: PhysicalStats;
  daysPerWeek: number;
  /** Specific days the user can train. 0=Sun, 1=Mon, ..., 6=Sat.
   *  When set, overrides daysPerWeek for scheduling. Length must match daysPerWeek. */
  trainingDays?: number[];
  workoutDurationMinutes: number;
  /** Lifestyle activity OUTSIDE planned training. Drives the TDEE
   *  `step_2b_apply_lifestyle_modifier` nudge on top of the training-
   *  schedule-derived multiplier. Optional — when undefined the backend
   *  skips the modifier so the legacy TDEE estimate is preserved (no
   *  change for users who onboarded before this question landed). */
  lifestyleActivity?: 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';
  equipment: string[];           // specific item names e.g. 'Dumbbells', 'Barbell'
  equipmentSettings?: StrengthEquipmentSettings;
  strengthBaselines?: StrengthBaselines;
  cardioBaseline?: CardioBaseline;
  foodsAvailable: string[];
  supplementsAvailable?: string[];  // supplements the user has / takes
  customFoods: CustomFoodItem[]; // user-added foods with AI-fetched macros
  customExercises?: CustomExerciseItem[]; // AI-found exercises the user saved to their library
  cookingSkill?: string;
  prepTimeMinutes?: number;
  dietaryPreference?: string;
  /** How many distinct daily meal templates the AI generates. The client
   *  rotates these across 7 days (e.g. variety=2 → ABABABA, variety=7 → all
   *  unique). Lower = faster plan generation; higher = more variety.
   *  Default 3 matches the old hardcoded A/B/C behaviour. */
  mealVariety?: number;
  savedMeals?: SavedMealTemplate[];
  mealRoutine?: string;          // user's fixed meal habits
  /** Lifestyle support for users prescribed GLP-1 medication. This is
   *  nutrition/training guidance only; no medication or dosing advice. */
  glp1Support?: Glp1SupportSettings;
  injuries?: string;             // legacy: free-text injuries
  injuryEntries?: InjuryEntry[]; // structured injury tracking with statuses
  experienceLevel?: 'beginner' | 'intermediate' | 'advanced';
  /** Training split preference. "auto" or null = planner picks the best
   *  split for the user's goal + days. Otherwise one of:
   *  "full_body" | "upper_lower" | "ppl" | "ppl_upper_lower" | "bro" */
  preferredSplit?: string;
  /** Pro-only manual-mode flags. When true, the planner stops auto-
   *  generating workouts/meals; the user assembles their own week from
   *  saved templates (workout) or just logs freely (meal). */
  workoutManualMode?: boolean;
  mealManualMode?: boolean;
  lastWorkoutContext?: string;   // what user last trained and when (new user onboarding context)
  customMacros?: CustomMacros;   // user-set macro overrides (replace computed TDEE targets)
  weightHistory?: WeightEntry[];
  weightEntries?: Array<{ date: string; weight_lbs: number; source?: string; logged_at?: string }>;
  allergies?: string[];           // allergen categories the user avoids
  dislikedExercises?: string[];  // exercise names excluded from plan generation
  /** Subscription tier. `free` = manual tracking and starter tools;
   *  `pro` = guided PlanWeeks, AI help, and advanced insight surfaces.
   *  Missing/unknown tiers must be treated as `free` by clients so
   *  unlocked features only come from explicit state. */
  subscriptionTier?: SubscriptionTier;
  subscriptionStatus?: SubscriptionStatus;
  subscriptionSource?: string | null;
  subscriptionProductId?: string | null;
  subscriptionEntitlementId?: string | null;
  subscriptionStore?: string | null;
  subscriptionEnvironment?: string | null;
  subscriptionExpiresAt?: string | null;
  trialStartedAt?: string | null;
  trialEndsAt?: string | null;
  revenueCatAppUserId?: string | null;
  /** Social/profile avatar. Usually a compact image data URI persisted
   *  through UserSocialProfile so friends see it anywhere initials render. */
  avatarUrl?: string;
}

export interface PendingImportEntry {
  source: string;
  requested_at: string;
  notified_at?: string | null;
  completed_at?: string | null;
  dismissed_at?: string | null;
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
  | 'strength_anchor'
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
  primary_muscle?: string | null;
  secondary_muscles?: string[];
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
  /** Equipment-specific cardio prescription from the planner — present on
   *  cardio exercises when the planner can infer useful machine targets
   *  (watts/rpm/resistance for bikes, speed+incline for treadmill, etc.). */
  cardioGuidance?: {
    duration_min?: number;
    is_intervals?: boolean;
    watts_range?: string;
    rpm_range?: string;
    resistance_cue?: string;
    speed_range?: string;
    incline_range?: string;
    hr_zone?: number;
    hr_zone_label?: string;
    hr_low_bpm?: number;
    hr_high_bpm?: number;
    hr_range?: string;
    pace_per_500m?: string;
    stroke_rate?: string;
    rpe_range?: string;
    intensity_cue?: string;
    interval_sets?: number;
    work_seconds?: number;
    rest_seconds?: number;
    modality?: string;
  } | null;
  /** Prescription category from the planner. Drives logging UI and
   *  guided-flow detection. "yoga_flow" / "stretch_hold" / "mobility"
   *  imply timed holds; "core_circuit" implies circuit pacing. */
  prescriptionType?: string | null;
  /** Guided-flow ordering tag for stretches / yoga / foam-roll poses.
   *  "warm" | "standing" | "floor" | "cool" | "breath" | "foam_roll".
   *  Present on yoga/recovery/mobility exercises; null for strength. */
  flowCategory?: string | null;
}

export interface WorkoutDay {
  day: string;
  focus: string;
  /** Training stimulus intent: "strength" | "hypertrophy" | "volume" |
   *  "conditioning" | "mobility" | "recovery" | "mixed". Shipped by the
   *  planner from the archetype's training_type. Drives the stimulus
   *  badge on the workout card. */
  stimulus?: string;
  /** Stable planner day archetype id, e.g. "lift_push_heavy" or
   *  "cond_zone2". */
  archetype?: string | null;
  _source_context?: string;
  _custom_activity_category?: ActivityCategory | string;
  _custom_cardio_subtype?: string;
  _custom_cardio_style?: CardioStyle | string;
  _custom_activity_venue?: 'indoor' | 'outdoor' | string;
  _template_id?: string | null;
  planDayId?: number | null;
  plan_day_id?: number | null;
  exercises: Exercise[];
}

export interface WorkoutPlan {
  name: string;
  totalDays: number;
  days: WorkoutDay[];
  trainerNote?: string;  // AI explanation of why this plan was structured this way
}

export interface SavedWorkoutTemplate {
  id: string;
  name: string;
  workout: WorkoutDay;
  notes?: string | null;
  /** Set when the user has generated a share link for this template.
   *  Cleared when revoked. Imported templates start with shareCode null. */
  shareCode?: string | null;
  /** Number of users who have imported this template (only meaningful for
   *  templates the current user owns + has shared). */
  timesImported?: number;
  /** When this template was imported from someone else's share, the
   *  originating code. Drives the "Imported from <code>" attribution. */
  sourceShareCode?: string | null;
  /** Owner username snapshotted at import time. Survives revoke + owner
   *  rename. Drives the "from @owner" pill on imported template cards. */
  sourceOwnerUsername?: string | null;
  createdAt: string;
  updatedAt: string;
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
  added_sugar_g?: number; // g
  added_sugar?: number;   // g — legacy alias
  sodium?: number;      // mg
  cholesterol?: number; // mg
  // Fats panel. `trans_fat_g` sits next to saturated/cholesterol —
  // health insights treat them as a related triad. Unknown = undefined
  // (per project convention); a literal 0 means "source said 0".
  saturated_fat?: number;       // g
  trans_fat_g?: number;         // g
  monounsaturated_fat?: number; // g
  polyunsaturated_fat?: number; // g
  // Omega-3 total (legacy, kept for back-compat) + subtypes in mg.
  // EPA+DHA derivation is computed by the renderer when both subtypes
  // are present and the total is missing.
  omega_3?: number;             // g (legacy total)
  omega_3_ala_mg?: number;      // mg
  omega_3_epa_mg?: number;      // mg
  omega_3_dha_mg?: number;      // mg
  omega_3_epa_dha_mg?: number;  // mg — derived: epa + dha when both known
  // Omega-6 explicit-unit field. `omega_6` (without units) is preserved
  // as a legacy alias; new producers should set `omega_6_mg`.
  omega_6_mg?: number;          // mg
  omega_6?: number;             // legacy: ambiguous units; treat as mg
  // Vitamins
  vitamin_a?: number;             // µg RAE
  vitamin_c?: number;             // mg
  vitamin_d?: number;             // µg
  vitamin_e?: number;             // mg α-tocopherol (legacy, no unit suffix)
  vitamin_e_mg?: number;          // mg α-tocopherol (explicit unit)
  vitamin_k?: number;             // µg (legacy, no unit suffix)
  vitamin_k_mcg?: number;         // µg (explicit unit)
  thiamin_b1?: number;            // mg
  riboflavin_b2?: number;         // mg
  niacin_b3?: number;             // mg
  vitamin_b6?: number;            // mg
  folate_b9?: number;             // µg
  vitamin_b12?: number;           // µg
  biotin_b7?: number;             // µg
  pantothenic_acid_b5?: number;   // mg
  choline_mg?: number;            // mg
  // Minerals
  calcium?: number;     // mg
  iron?: number;        // mg
  magnesium?: number;   // mg
  phosphorus?: number;  // mg (legacy)
  phosphorus_mg?: number; // mg (explicit unit)
  potassium?: number;   // mg
  zinc?: number;        // mg
  selenium?: number;    // µg
  copper?: number;      // mg
  manganese?: number;   // mg
  boron?: number;       // mg
  iodine_mcg?: number;  // µg
  // Stimulants / lifestyle inputs for sleep/recovery insights.
  caffeine_mg?: number; // mg
  alcohol_g?: number;   // g (canonical) — standard-drinks is derived
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
  food_id?: number | null;
  serving_id?: number | null;
  serving_grams?: number | null;
  source?: 'seed' | 'user' | 'usda' | 'fatsecret' | 'barcode' | 'ai' | string;
  fdc_id?: string | null;
  external_id?: string | null;
  barcode?: string | null;
  brand?: string | null;
  is_verified?: boolean;
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
  baseServingGrams?: number | null;
  micronutrients?: Record<string, number>;
  processing_bucket?: 'minimally_processed' | 'processed' | 'ultra_processed' | 'unknown';
  food_quality?: 'whole' | 'processed' | 'unknown';
  protein_source?: 'plant' | 'animal' | 'mixed' | 'none' | 'unknown';
  fermented?: boolean;
  probiotic?: boolean;
  omega3_rich?: boolean;
  plant_count?: number;
  seafood?: boolean;
  fruit?: boolean;
  vegetable?: boolean;
  alcohol?: boolean;
  processed_meat?: boolean;
  refined_grain?: boolean;
}

export interface MealSuggestion {
  meal: string;
  name?: string;
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
  _clientMealKey?: string;
  _localId?: string;
  _routineId?: string;
  // Backend SavedMeal/Favorite provenance. Favorite renames can update
  // linked meal names without changing item/macro snapshots.
  _savedMealId?: number | null;
  // ISO timestamp for the "eaten at" time selected in the meal editor.
  _consumedAt?: string;
  /** Optional meal image. The card UI must render fine without it —
   *  see src/utils/foodImage.ts for the resolver + category fallback. */
  image_url?: string | null;
  image_source?: string | null;
}

export interface SupplementItem {
  name: string;          // e.g. "Creatine Monohydrate"
  dose: string;          // e.g. "5g"
  timing: string;        // e.g. "Post-workout or anytime"
  purpose: string;       // e.g. "Increases muscle power and recovery"
  checked?: boolean;     // user has taken it today
}

export interface WorkoutSummaryTrainingPillar {
  key: string;
  label: string;
  value: number;
  max: number;
  present?: boolean;
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
  trainingPillarBreakdown?: WorkoutSummaryTrainingPillar[];
  /** GPS route trail captured during outdoor cardio. Renders the
   *  post-workout map on the share/summary card. Null for indoor +
   *  lifting sessions. */
  routeCoords?: Array<{ lat: number; lon: number }> | null;
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
  warmupSets?: CompletedSet[];
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
  stimulus?: string | null;
  sourceContext?: string | null;
  activityCategory?: string | null;
  activitySubtype?: string | null;
  activitySource?: string | null;
  cardioStyle?: string | null;
  distanceMiles?: number | null;
  importSource?: string | null;
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
  /** Who/what authored the change. `user` is for direct edits via the
   *  Goal/Workout/Mealplan settings (added 2026-04 so users can review
   *  their own settings tweaks alongside coach-driven changes). */
  changedBy: 'trainer' | 'nutritionist' | 'user';
  /** Optional sub-category for `user` changes — useful for grouping in
   *  the change-history view. */
  scope?: 'goal' | 'workout' | 'mealplan';
  summary: string;            // human-readable description of what changed
  question: string;           // for coach-driven changes — the chat message that triggered it
  /** The local date (YYYY-MM-DD) when the change is scheduled to take
   *  effect on the user's plan. For mid-week edits this is the next
   *  plan-week start; for immediate changes it's the date the change was saved. */
  effectiveDate?: string;
  /** For future-dated user setting changes, keep enough local context to
   *  cancel the request before it takes effect without touching the active
   *  PlanWeek. Older history rows will not have these snapshots. */
  previousProfile?: Partial<UserProfile>;
  nextProfile?: Partial<UserProfile>;
}

export interface MealRoutineFood {
  id: string;
  name: string;
  quantity?: string;          // e.g. "1 cup", "200g"
}

export interface MealRoutineEntry {
  id: string;
  /** Backend MealRoutine.id once this routine has been persisted server-side.
   *  The local string `id` stays the device-side identity used for `_routineId`
   *  matching; `backendId` links it to the durable, cross-device server row so
   *  edits/deletes update the same routine instead of duplicating. */
  backendId?: number;
  /** Account-wide display order for routine-backed meals. Reordering two
   *  routine rows updates this order and is reflected across every day. */
  displayOrder?: number;
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
  /** Routine ids intentionally suppressed for this specific day. Used
   *  when a user edits a routine-backed meal with "Just today" scope. */
  suppressedRoutineIds?: string[];
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
  comfortRating?: number; // 1-5 for stretch/mobility comfort
  rir?: number;
  feedback?: 'easy' | 'good' | 'grind' | 'hard' | 'failure' | 'pain' | 'form_breakdown';
  sessionDate?: string;
  completedAt?: string;
  actualDistance?: number;
  actualPace?: string;
  heartRateAvg?: number;
  cardioMetrics?: Record<string, string>;
  /** Free-form per-set note ("form sloppy on rep 5"). Persisted to
   *  ExerciseSet.notes via the workout sync endpoint. */
  notes?: string;
  /** Warmups are logged but excluded from working-set progression. */
  setType?: SetType | 'working' | 'dropset' | 'amrap';
}

export interface SessionExercise {
  /** Stable watch-local id used to reconcile optimistic watch-added
   *  exercises with the phone-confirmed active snapshot. */
  clientExerciseId?: string | null;
  name: string;
  targetSets: number;
  targetReps: string;
  targetRestSeconds: number;
  equipment: string;
  sets: CompletedSet[];
  warmupSets?: CompletedSet[];
  aiRecommendation?: string;
  image_url?: string;
  video_id?: string | null;
  /** free-exercise-db identifier — drives the form-demo thumbnail in
   *  the active-workout exercise row + the cycling demo card inside
   *  FormVideoModal. Resolved server-side at seed time, also looked
   *  up from the loaded library by name when a stale plan didn't
   *  carry the field. */
  demo_exercise_db_id?: string | null;
  demoExerciseDbId?: string | null;
  /** Anchor target weight emitted by the deterministic planner (already
   *  history-aware). Forwarded to the weight-recommendation endpoint as
   *  `plannedTargetWeightLbs` so recs stay grounded in the session plan. */
  targetWeightLbs?: number | null;
  /** Per-set programming emitted by the planner. Active workout keeps
   *  this so live recommendations can honor top-set/backoff intent. */
  setScheme?: PlannedSet[] | null;
  /** Canonical slug for this exercise (when known). Lets the weight-rec
   *  endpoint skip the name-based lookup and run the performance-profile
   *  pipeline directly. */
  slug?: string | null;
  /** Primary muscle slug from the exercise library. Used to bias weight
   *  recs when the exact exercise has no direct history. */
  primaryMuscle?: string | null;
  primary_muscle?: string | null;
  secondaryMuscles?: string[] | null;
  secondary_muscles?: string[];
  muscles_targeted?: string[];
  movementPattern?: string | null;
  movement_pattern?: string | null;
  /** Whether this is a compound (multi-joint) movement. Propagated from
   *  the planner's exercise library — used for 1RM estimation eligibility. */
  isCompound?: boolean | null;
  /** Planner slot metadata used by active-session UI surfaces such as
   *  core-circuit grouping. */
  slotRole?: string | null;
  slotLabel?: string | null;
  prescriptionType?: string | null;
  /** Guided-flow ordering tag — same field used on Exercise. Present on
   *  poses pulled from the seed library; null for strength/cardio. */
  flowCategory?: string | null;
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
  /** Completion provenance. Planned/planDayId sessions can satisfy the
   *  scheduled PlanDay; custom/manual/template quick-starts stay as extras. */
  sourceContext?: string | null;
  templateId?: string | null;
  planDayId?: number | null;
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
    /** Captured GPS trail. Drives the post-workout map and the
     *  HKWorkoutRouteBuilder write so the run shows on the Apple
     *  Fitness route map. Indoor + lifting omit. */
    routeCoords?: Array<{ lat: number; lon: number; t_ms: number; acc_m?: number | null; alt_m?: number | null; v_acc_m?: number | null }>;
    /** Per-subtype structured detail. Shape is sparse — fields appear
     *  only when the selected subtype exposes them. */
    details?: ManualActivityDetails;
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
  /** GPS trail for outdoor cardio sessions (planned or manual). Hydrated
   *  from WorkoutCompletion.route_coords during reconciliation so the
   *  Progress screen's expanded card can render a route map. Top-level
   *  rather than nested under manualActivity because planned cardio
   *  ships with source_context='planned', which doesn't construct a
   *  manualActivity object. */
  routeCoords?: Array<{ lat: number; lon: number }>;
  /** Provenance for sessions ingested from a third-party export
   *  (Strong, Hevy, Strava). Drives the "IMPORTED" badge on the
   *  workout-history card. Null for native logs + Apple Health
   *  workouts (those carry source via manualActivity instead). */
  importSource?: string;
  /** Apple Health workout explicitly linked onto this existing Thallo
   *  workout. Used when a user imports/logs a workout from another
   *  source, then attaches the HealthKit workout for calories, HR,
   *  distance, and exact timing without creating a duplicate history row. */
  linkedAppleHealthWorkout?: {
    externalId: string;
    activityName: string;
    startDate: string;
    endDate: string;
    durationSeconds: number;
    caloriesBurned?: number | null;
    distanceMiles?: number | null;
    avgHeartRate?: number | null;
    maxHeartRate?: number | null;
  };
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
  photoUri?: string;
  bodyFatPct: number;
  bodyFatRange: string;
  muscleMass: string;
  category: string;
  strengths: string[];
  improvements: string[];
  assessment: string;
  confidence?: string;
  photoQuality?: string;
  qualityFlags?: string[];
  needsRetake?: boolean;
  sensitivePhoto?: boolean;
  photoHidden?: boolean;
  method?: string;
  visualEstimatePct?: number | null;
  measurementEstimatePct?: number | null;
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

export type SleepStageType = 'awake' | 'rem' | 'core' | 'deep';

export interface SleepStageTimelineSegment {
  stage: SleepStageType;
  startDate: string;
  endDate: string;
  startOffsetMinutes: number;
  durationMinutes: number;
}

export interface SleepStageTimeline {
  startDate: string;
  endDate: string;
  durationMinutes: number;
  segments: SleepStageTimelineSegment[];
}

export interface WorkoutDetail {
  activityType: number;
  activityName: string;
  duration: number;
  startDate: string;
  endDate: string;
  calories?: number;
  distanceMiles?: number;
  sourceName?: string;
  sourceBundleIdentifier?: string;
  avgHeartRate?: number;
  maxHeartRate?: number;
  elevationGainFt?: number;
  routeCoords?: Array<{ lat: number; lon: number; t_ms: number; acc_m?: number | null; alt_m?: number | null; v_acc_m?: number | null }>;
}

export type SleepScoreMode = 'mvp' | 'personalized';

export interface SleepScorePillars {
  duration: number;
  efficiency: number;
  hrv: number;
  regularity?: number;
  /** Legacy combined stage pillar — kept on the type so older
   *  consumers don't break, but new code should read `deepSleep` and
   *  `remSleep` separately. Populated as `deepSleep + remSleep` for
   *  back-compat when both new pillars are available. */
  stageComposite: number;
  /** Deep-sleep pillar — the higher-weight half of the old
   *  stage composite, with an absolute-minutes floor for full-length
   *  nights (recovery requires real deep, not just a high deep ratio
   *  on a short sleep). */
  deepSleep?: number;
  /** REM-sleep pillar — half-weight of deepSleep. Soft penalties for
   *  out-of-band REM ratios. */
  remSleep?: number;
  /** Awake/fragmentation pillar — penalizes >30 minutes of awake time
   *  mid-sleep on top of what efficiency already captures. */
  awakeFragmentation?: number;
  healthFlags: number;
}

export interface SleepScore {
  score: number;
  rating: 'Excellent' | 'Good' | 'Fair' | 'Poor';
  mode: SleepScoreMode;
  duration: number;
  stages: SleepStages;
  hrvAvg: number | null;
  /** Optional corroborating recovery marker used by sleep scoring when
   *  Apple Health exposes it. Compared against personal baseline when
   *  enough history exists. */
  restingHeartRate?: number | null;
  respiratoryRate: number | null;
  oxygenSaturation: number | null;
  efficiency: number | null;
  bedtimeMinutes?: number | null;
  pillars: SleepScorePillars;
  insights: string[];
}

export interface HealthSummary {
  restingHeartRate: number | null;
  stepsToday: number | null;
  avgSteps7d: number | null;
  workouts7d: number | null;
  avgSleepHours7d: number | null;
  lastNightSleepHours: number | null;
  activeEnergyToday: number | null;
  activeEnergy7d: number | null;
  hrvAvg: number | null;
  vo2Max: number | null;
  respiratoryRate: number | null;
  oxygenSaturation: number | null;
  standingHours7d: number | null;
  mindfulMinutes7d: number | null;
  basalEnergy7d: number | null;
  sleepScore: SleepScore | null;
  sleepTimeline?: SleepStageTimeline | null;
  workoutDetails: WorkoutDetail[];
  fetchedAt: string;
}

export interface HealthScoreResult {
  // ── Legacy fields — preserved for existing UI consumers ────────────
  /** Backwards-compat alias for `overallScore`. Existing screens read
   *  this field; new UI should prefer `overallScore` + sub-scores. */
  fitnessScore: number;               // 0-100
  recoveryMarker: RecoveryMarker;
  /** Legacy v1 pillar breakdown. Populated for backwards compatibility
   *  but no longer the source of truth — use `subScores` for the new
   *  modular pillars (recovery / training / cardio / etc.). */
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

  // ── v2 — modular sub-scores ────────────────────────────────────────
  /** Weighted blend across available pillars. Null when no pillar has
   *  enough data to score. */
  overallScore: number | null;
  /** "high" when ≥75% of pillar weight has data, "medium" ≥40%,
   *  "low" otherwise. Surfaces alongside the score so users know how
   *  much to trust it. */
  confidence: 'low' | 'medium' | 'high';
  /** 0..1 — fraction of total pillar weight that had data. */
  dataCoverage: number;
  /** Per-pillar 0–100 sub-scores. Pillars with no data are omitted
   *  rather than scored at 0 — UI should treat absence as "not yet
   *  available". */
  subScores: {
    recovery?: number;
    training?: number;
    nutrition?: number;
    cardio?: number;
    strength?: number;
    activity?: number;
    gutSupport?: number;
  };
  /** Human-readable signals that would improve accuracy — used by the
   *  UI to nudge users toward connecting Apple Health, logging meals,
   *  etc. Empty when every pillar is fully scored. Flat list; UI
   *  should prefer `missingByPillar` for grouped display. */
  missingSignals: string[];
  /** Same data as `missingSignals`, grouped by pillar so the explainer
   *  modal can render a "Recovery: …, Cardio: …" layout instead of a
   *  flat dump. Pillars with no missing data are omitted. */
  missingByPillar: Partial<Record<HealthPillarKey, string[]>>;
  /** Per-pillar one-line summary so the score's "why" is visible. */
  explanation: string[];
  /** User-facing display name for the overall score. Centralized here
   *  so the label can be tuned without grepping screens. */
  scoreLabel: string;
  /** Top 2 available pillars driving the score up — formatted strings
   *  like "Training — 12/8 sessions on target". Empty when nothing
   *  scored above the positive threshold. */
  topPositiveFactors: string[];
  /** Top 2 available pillars dragging the score down. Empty when no
   *  pillar scored below the negative threshold. */
  topNegativeFactors: string[];
  /** Per-pillar source/signal metadata — what data backed each
   *  available pillar. Used by the explainer modal so the UI can say
   *  "Recovery: sleep + RHR" or "Nutrition: server score". */
  pillarSources: {
    /** "server" — used the pre-computed weekly score from /meals.
     *  "clientFallback" — used the ratio-based pillar.
     *  "unavailable" — pillar was excluded from the blend. */
    nutritionScoreSource: 'server' | 'clientFallback' | 'unavailable';
    recoverySignalsUsed: Array<'sleep' | 'rhr' | 'hrv' | 'load'>;
    cardioSignalsUsed: Array<'vo2Max' | 'zone2Minutes' | 'cardioSessions' | 'rhrTrend' | 'hrRecovery'>;
    strengthSignalsUsed: Array<'e1rmPRs' | 'volumePRs' | 'repPRs' | 'tonnageTrend'>;
    gutSignalsUsed: Array<'fiber' | 'plantVariety' | 'hydration' | 'fermentedDays' | 'giFlag'>;
    activitySignalsUsed: Array<'steps' | 'activeEnergy'>;
  };
}

/** Pillar identifier — kept in sync with `subScores` keys. */
export type HealthPillarKey =
  | 'recovery'
  | 'training'
  | 'nutrition'
  | 'cardio'
  | 'strength'
  | 'activity'
  | 'gutSupport';

// ─── Navigation types ─────────────────────────────────────────────────────────

export type RootStackParamList = {
  Onboarding: undefined;
  Home: undefined;
};
