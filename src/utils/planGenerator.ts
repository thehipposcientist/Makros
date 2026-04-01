import {
  UserProfile,
  WorkoutPlan,
  WorkoutDay,
  Exercise,
  DailyNutritionPlan,
  NutritionTargets,
  MealSuggestion,
} from '../types';
import { FoodItem } from '../hooks/useMetaData';

// ─── Equipment classification sets (kept local — plan-generator logic only) ──

const GYM_MACHINE_ITEMS = new Set([
  'Cable machine', 'Leg press', 'Smith machine', 'Lat pulldown',
  'Chest press machine', 'Seated row machine', 'Leg extension', 'Leg curl',
  'Shoulder press machine', 'Hack squat machine', 'Leg press v-squat', 'Leverage machines',
]);

const BARBELL_ITEMS = new Set(['Barbell', 'Squat rack', 'Power rack', 'Smith machine']);
const DUMBBELL_ITEMS = new Set(['Dumbbells', 'Kettlebell']);

// ─── Equipment helpers ────────────────────────────────────────────────────────

function hasGymEquip(equipment: string[]): boolean {
  return equipment.some(e => GYM_MACHINE_ITEMS.has(e) || BARBELL_ITEMS.has(e))
    || equipment.includes('gym');
}

function hasDumbbellEquip(equipment: string[]): boolean {
  return equipment.some(e => DUMBBELL_ITEMS.has(e))
    || equipment.includes('dumbbells');
}

function hasPullUpBar(equipment: string[]): boolean {
  return equipment.includes('Pull-up bar') || hasGymEquip(equipment);
}

// ─── Duration → exercise count ────────────────────────────────────────────────

function exerciseCount(durationMinutes: number): number {
  // ~8 min per exercise (3 sets × ~90s rest + ~3 min work)
  if (durationMinutes <= 30) return 3;
  if (durationMinutes <= 45) return 5;
  if (durationMinutes <= 60) return 6;
  if (durationMinutes <= 75) return 8;
  return 10;
}

function pick<T>(arr: T[], n: number): T[] {
  return arr.slice(0, Math.min(n, arr.length));
}

// ─── Exercise pools ───────────────────────────────────────────────────────────

function squatPool(gym: boolean, db: boolean): Exercise[] {
  return [
    { name: gym ? 'Barbell Back Squat'   : 'Goblet Squat',         sets: 4, reps: '6-8',   restSeconds: 120, equipment: gym ? 'Barbell' : db ? 'Dumbbell' : 'Bodyweight' },
    { name: gym ? 'Leg Press'            : 'Bulgarian Split Squat', sets: 3, reps: '8-10',  restSeconds: 90,  equipment: gym ? 'Machine' : 'Bodyweight' },
    { name: gym ? 'Hack Squat'           : 'Reverse Lunge',         sets: 3, reps: '10-12', restSeconds: 60,  equipment: gym ? 'Machine' : 'Bodyweight' },
    { name: db  ? 'Dumbbell Step-up'     : 'Jump Squat',            sets: 3, reps: '10-12', restSeconds: 60,  equipment: db  ? 'Dumbbell' : 'Bodyweight' },
    { name: gym ? 'Leg Extension'        : 'Wall Sit',              sets: 3, reps: '12-15', restSeconds: 60,  equipment: gym ? 'Machine' : 'Bodyweight' },
  ];
}

function hingePool(gym: boolean, db: boolean): Exercise[] {
  return [
    { name: gym ? 'Barbell Deadlift'        : db ? 'Dumbbell RDL'        : 'Single-leg Deadlift', sets: 4, reps: '5-6',   restSeconds: 120, equipment: gym ? 'Barbell' : db ? 'Dumbbell' : 'Bodyweight' },
    { name: gym ? 'Romanian Deadlift'       : db ? 'Dumbbell Good Morning': 'Glute Bridge',        sets: 3, reps: '8-10',  restSeconds: 90,  equipment: gym ? 'Barbell' : db ? 'Dumbbell' : 'Bodyweight' },
    { name: gym ? 'Leg Curl'               : 'Nordic Curl',              sets: 3, reps: '10-12', restSeconds: 60,  equipment: gym ? 'Machine' : 'Bodyweight' },
    { name: db  ? 'Kettlebell Swing'        : 'Hip Thrust',               sets: 3, reps: '12-15', restSeconds: 60,  equipment: db  ? 'Dumbbell' : 'Bodyweight' },
  ];
}

function pushPool(gym: boolean, db: boolean): Exercise[] {
  return [
    { name: gym ? 'Barbell Bench Press'     : db ? 'Dumbbell Bench Press'  : 'Push-up',            sets: 4, reps: '6-8',   restSeconds: 90,  equipment: gym ? 'Barbell' : db ? 'Dumbbell' : 'Bodyweight' },
    { name: gym ? 'Incline Barbell Press'   : db ? 'Incline Dumbbell Press': 'Incline Push-up',     sets: 3, reps: '8-10',  restSeconds: 75,  equipment: gym ? 'Barbell' : db ? 'Dumbbell' : 'Bodyweight' },
    { name: gym ? 'Overhead Press'          : db ? 'Dumbbell Shoulder Press': 'Pike Push-up',       sets: 3, reps: '8-10',  restSeconds: 75,  equipment: gym ? 'Barbell' : db ? 'Dumbbell' : 'Bodyweight' },
    { name: gym ? 'Cable Chest Fly'         : db ? 'Dumbbell Fly'          : 'Diamond Push-up',     sets: 3, reps: '12-15', restSeconds: 60,  equipment: gym ? 'Cable' : db ? 'Dumbbell' : 'Bodyweight' },
    { name: gym ? 'Tricep Pushdown'         : db ? 'Dumbbell Skullcrusher' : 'Tricep Dip',         sets: 3, reps: '12-15', restSeconds: 60,  equipment: gym ? 'Cable' : db ? 'Dumbbell' : 'Bodyweight' },
    { name: db  ? 'Lateral Raises'          : 'Wall Push-up',              sets: 3, reps: '15-20', restSeconds: 45,  equipment: db  ? 'Dumbbell' : 'Bodyweight' },
  ];
}

function pullPool(gym: boolean, db: boolean, pullUp: boolean): Exercise[] {
  return [
    { name: pullUp ? 'Pull-up'              : db ? 'Dumbbell Row'          : 'Inverted Row',        sets: 4, reps: '6-8',   restSeconds: 90,  equipment: pullUp ? 'Pull-up bar' : db ? 'Dumbbell' : 'Bodyweight' },
    { name: gym ? 'Barbell Row'             : db ? 'Single-arm DB Row'     : 'Inverted Row',        sets: 3, reps: '8-10',  restSeconds: 75,  equipment: gym ? 'Barbell' : db ? 'Dumbbell' : 'Bodyweight' },
    { name: gym ? 'Lat Pulldown'            : pullUp ? 'Chin-up'           : 'Resistance Band Row', sets: 3, reps: '8-10',  restSeconds: 75,  equipment: gym ? 'Machine' : pullUp ? 'Pull-up bar' : 'Band' },
    { name: gym ? 'Seated Cable Row'        : db ? 'Chest-supported Row'   : 'Superman Hold',       sets: 3, reps: '10-12', restSeconds: 60,  equipment: gym ? 'Cable' : db ? 'Dumbbell' : 'Bodyweight' },
    { name: gym ? 'Face Pull'              : db ? 'Rear Delt Fly'         : 'Band Pull-apart',      sets: 3, reps: '15-20', restSeconds: 45,  equipment: gym ? 'Cable' : db ? 'Dumbbell' : 'Band' },
    { name: db  ? 'Dumbbell Bicep Curl'     : 'Resistance Band Curl',      sets: 3, reps: '12-15', restSeconds: 45,  equipment: db  ? 'Dumbbell' : 'Band' },
  ];
}

function corePool(gym: boolean, db: boolean): Exercise[] {
  return [
    { name: 'Plank',                        sets: 3, reps: '30-60s', restSeconds: 45, equipment: 'Bodyweight' },
    { name: gym ? 'Hanging Leg Raise'       : 'Lying Leg Raise',           sets: 3, reps: '12-15', restSeconds: 45, equipment: gym ? 'Pull-up bar' : 'Bodyweight' },
    { name: db  ? 'Weighted Russian Twist'  : 'Russian Twist',             sets: 3, reps: '20',    restSeconds: 45, equipment: db  ? 'Dumbbell' : 'Bodyweight' },
    { name: 'Dead Bug',                     sets: 3, reps: '10 each side', restSeconds: 45, equipment: 'Bodyweight' },
    { name: gym ? 'Ab Wheel Rollout'        : 'Mountain Climbers',         sets: 3, reps: '10-12', restSeconds: 45, equipment: gym ? 'Ab wheel' : 'Bodyweight' },
  ];
}

function calfPool(gym: boolean, db: boolean): Exercise[] {
  return [
    { name: gym ? 'Standing Calf Raise'     : db ? 'Dumbbell Calf Raise'   : 'Calf Raise',          sets: 4, reps: '15-20', restSeconds: 45, equipment: gym ? 'Machine' : db ? 'Dumbbell' : 'Bodyweight' },
  ];
}

// ─── Workout generation ───────────────────────────────────────────────────────

export function generateWorkoutPlan(profile: UserProfile): WorkoutPlan {
  const { daysPerWeek, equipment, goal, workoutDurationMinutes = 60 } = profile;
  const gym   = hasGymEquip(equipment);
  const db    = hasDumbbellEquip(equipment);
  const pu    = hasPullUpBar(equipment);
  const count = exerciseCount(workoutDurationMinutes);
  const days  = buildDays(daysPerWeek, gym, db, pu, count);

  return { name: `${daysPerWeek}-Day Split`, totalDays: daysPerWeek, days };
}

function buildDays(days: number, gym: boolean, db: boolean, pu: boolean, count: number): WorkoutDay[] {
  if (days <= 3) return fullBodyDays(gym, db, pu, count);
  if (days <= 5) return pplDays(gym, db, pu, count);
  return upperLowerDays(gym, db, pu, count);
}

function fullBodyDays(gym: boolean, db: boolean, pu: boolean, count: number): WorkoutDay[] {
  const squat = squatPool(gym, db);
  const hinge = hingePool(gym, db);
  const push  = pushPool(gym, db);
  const pull  = pullPool(gym, db, pu);
  const core  = corePool(gym, db);

  const makeDay = (label: string, focus: string, pools: Exercise[][]): WorkoutDay => {
    const combined = pools.flat();
    return { day: label, focus, exercises: pick(combined, count) };
  };

  return [
    makeDay('Day 1', 'Full Body — Strength',   [squat, push, pull, core]),
    makeDay('Day 2', 'Full Body — Power',       [hinge, push, pull, core]),
    makeDay('Day 3', 'Full Body — Hypertrophy', [squat, hinge, push, pull, core]),
  ].slice(0, 3);
}

function pplDays(gym: boolean, db: boolean, pu: boolean, count: number): WorkoutDay[] {
  const push  = pushPool(gym, db);
  const pull  = pullPool(gym, db, pu);
  const squat = squatPool(gym, db);
  const hinge = hingePool(gym, db);
  const core  = corePool(gym, db);
  const calf  = calfPool(gym, db);

  return [
    { day: 'Day 1', focus: 'Push — Chest & Shoulders & Triceps', exercises: pick(push, count) },
    { day: 'Day 2', focus: 'Pull — Back & Biceps',               exercises: pick(pull, count) },
    { day: 'Day 3', focus: 'Legs — Quads & Hamstrings & Glutes', exercises: pick([...squat, ...hinge, ...calf], count) },
    { day: 'Day 4', focus: 'Push — Volume',                      exercises: pick(push.slice(1), count) },
    { day: 'Day 5', focus: 'Pull — Volume & Core',               exercises: pick([...pull.slice(1), ...core], count) },
  ];
}

function upperLowerDays(gym: boolean, db: boolean, pu: boolean, count: number): WorkoutDay[] {
  const push  = pushPool(gym, db);
  const pull  = pullPool(gym, db, pu);
  const squat = squatPool(gym, db);
  const hinge = hingePool(gym, db);
  const core  = corePool(gym, db);
  const calf  = calfPool(gym, db);

  return [
    { day: 'Day 1', focus: 'Upper A — Strength',    exercises: pick([...push, ...pull], count) },
    { day: 'Day 2', focus: 'Lower A — Strength',    exercises: pick([...squat, ...hinge, ...calf], count) },
    { day: 'Day 3', focus: 'Upper B — Hypertrophy', exercises: pick([...push.slice(1), ...pull.slice(1)], count) },
    { day: 'Day 4', focus: 'Lower B — Hypertrophy', exercises: pick([...squat.slice(1), ...hinge.slice(1), ...core], count) },
    { day: 'Day 5', focus: 'Upper C — Volume',      exercises: pick([...push.slice(2), ...pull.slice(2), ...core], count) },
    { day: 'Day 6', focus: 'Lower C — Volume',      exercises: pick([...squat.slice(2), ...hinge, ...calf, ...core], count) },
  ];
}

// Nutrition generation logic
export function generateDailyNutrition(
  profile: UserProfile,
  availableFoods: FoodItem[] = [],
  seedKey?: string
): DailyNutritionPlan {
  const targets = calculateNutritionTargets(profile);

  // Build a name→item map from the provided foods + custom foods
  const foodMap: Record<string, FoodItem> = {};
  for (const f of availableFoods) foodMap[f.name.toLowerCase()] = f;
  for (const f of (profile.customFoods ?? [])) foodMap[f.name.toLowerCase()] = f as FoodItem;

  const breakfastCalories = targets.calories * 0.25;
  const lunchCalories     = targets.calories * 0.35;
  const dinnerCalories    = targets.calories * 0.4;
  const baseSeed = seedKey ?? `random-${Date.now()}-${Math.random()}`;

  return {
    breakfast: generateMealSuggestion('Breakfast', breakfastCalories, profile.foodsAvailable, foodMap, `${baseSeed}|Breakfast|${profile.goal}|${profile.goalDetails.pace}`),
    lunch:     generateMealSuggestion('Lunch',     lunchCalories,     profile.foodsAvailable, foodMap, `${baseSeed}|Lunch|${profile.goal}|${profile.goalDetails.pace}`),
    dinner:    generateMealSuggestion('Dinner',    dinnerCalories,    profile.foodsAvailable, foodMap, `${baseSeed}|Dinner|${profile.goal}|${profile.goalDetails.pace}`),
    targets,
  };
}

export function generateDailyNutritionForDate(
  profile: UserProfile,
  availableFoods: FoodItem[] = [],
  dateKey: string
): DailyNutritionPlan {
  return generateDailyNutrition(profile, availableFoods, `date:${dateKey}`);
}

const HIGH_PROTEIN_GOALS = new Set(['muscle_gain', 'body_recomp', 'strength', 'toning']);

// Calorie adjustment per day based on goal + pace
const CALORIE_ADJUSTMENT: Partial<Record<string, Record<string, number>>> = {
  fat_loss:             { conservative: -250, moderate: -500, aggressive: -750 },
  toning:               { conservative: -200, moderate: -350, aggressive: -500 },
  muscle_gain:          { conservative: 150,  moderate: 300,  aggressive: 500  },
  body_recomp:          { conservative: -100, moderate: 0,    aggressive: 100  },
  strength:             { conservative: 200,  moderate: 350,  aggressive: 500  },
  endurance:            { conservative: 100,  moderate: 200,  aggressive: 300  },
  athletic_performance: { conservative: 150,  moderate: 250,  aggressive: 400  },
};

function calculateBMR(profile: UserProfile): number {
  const { weightLbs, heightFeet, heightInches, age, gender } = profile.physicalStats;
  const weightKg = weightLbs / 2.205;
  const heightCm = (heightFeet * 12 + heightInches) * 2.54;
  // Mifflin-St Jeor equation
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  if (gender === 'male') return base + 5;
  if (gender === 'female') return base - 161;
  return base - 78; // average for nonbinary / prefer not to say
}

function getActivityMultiplier(daysPerWeek: number): number {
  if (daysPerWeek <= 1) return 1.2;
  if (daysPerWeek <= 3) return 1.375;
  if (daysPerWeek <= 5) return 1.55;
  return 1.725;
}

function calculateNutritionTargets(profile: UserProfile): NutritionTargets {
  const bmr = calculateBMR(profile);
  const tdee = Math.round(bmr * getActivityMultiplier(profile.daysPerWeek));
  const adjustment = CALORIE_ADJUSTMENT[profile.goal]?.[profile.goalDetails.pace] ?? 0;
  const calories = Math.max(1200, tdee + adjustment);

  const proteinPerLb = HIGH_PROTEIN_GOALS.has(profile.goal) ? 1.0 : 0.75;
  const protein = Math.round(profile.physicalStats.weightLbs * proteinPerLb);

  return {
    calories,
    protein,
    carbs: Math.round((calories * 0.45) / 4),
    fat: Math.round((calories * 0.3) / 9),
  };
}

// Default foods per meal type when user hasn't selected any
const DEFAULT_MEAL_FOODS: Record<string, string[]> = {
  Breakfast: ['Eggs', 'Oats', 'Blueberries', 'Greek yogurt'],
  Lunch:     ['Chicken breast', 'White rice', 'Broccoli', 'Olive oil'],
  Dinner:    ['Salmon', 'Sweet potato', 'Spinach', 'Olive oil'],
};

// Preferred food roles per meal — used to pick a balanced combo
const MEAL_ROLE_PREFERENCES: Record<string, ('protein' | 'carb' | 'fat' | 'veg')[]> = {
  Breakfast: ['protein', 'carb', 'veg'],
  Lunch:     ['protein', 'carb', 'veg', 'fat'],
  Dinner:    ['protein', 'carb', 'veg', 'fat'],
};

function classifyFood(item: FoodItem): 'protein' | 'carb' | 'fat' | 'veg' {
  if (item.protein >= 10) return 'protein';
  if (item.carbs >= 15)   return 'carb';
  if (item.fat >= 8)      return 'fat';
  return 'veg';
}

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededIndex(length: number, seed: string, salt: string): number {
  if (length <= 1) return 0;
  return hashString(`${seed}|${salt}`) % length;
}

function generateMealSuggestion(
  mealType: string,
  calorieTarget: number,
  foodsAvailable: string[],
  foodMap: Record<string, FoodItem> = {},
  seed = ''
): MealSuggestion {
  // Resolve food items — use selected foods if available, otherwise defaults
  const candidates = foodsAvailable.length > 0 ? foodsAvailable : DEFAULT_MEAL_FOODS[mealType] ?? [];

  // Separate candidates into macro roles, keeping only known foods
  const byRole: Record<string, FoodItem[]> = { protein: [], carb: [], fat: [], veg: [] };

  for (const name of candidates) {
    const item = foodMap[name.toLowerCase()];
    if (item) byRole[classifyFood(item)].push(item);
  }

  // Pick one food per preferred role for this meal
  const roles = MEAL_ROLE_PREFERENCES[mealType] ?? ['protein', 'carb', 'veg'];
  const picked: FoodItem[] = [];
  for (let i = 0; i < roles.length; i++) {
    const role = roles[i];
    const pool = byRole[role];
    if (pool.length) {
      const idx = seededIndex(pool.length, seed, `${role}|${i}|${mealType}`);
      picked.push(pool[idx]);
    }
  }

  // If we ended up with no known foods, fall back to defaults
  if (picked.length === 0) {
    const fallbackNames = DEFAULT_MEAL_FOODS[mealType] ?? ['Chicken breast', 'White rice', 'Broccoli'];
    const totalCal = Math.round(calorieTarget);
    return {
      meal: mealType,
      foods: fallbackNames,
      calories: totalCal,
      protein: Math.round(totalCal * 0.30 / 4),
      carbs:   Math.round(totalCal * 0.45 / 4),
      fat:     Math.round(totalCal * 0.30 / 9),
    };
  }

  // Sum raw macros from one serving of each picked food
  let rawCal   = picked.reduce((s, f) => s + f.calories, 0);
  let rawProt  = picked.reduce((s, f) => s + f.protein,  0);
  let rawCarbs = picked.reduce((s, f) => s + (f.carbs ?? 0), 0);
  let rawFat   = picked.reduce((s, f) => s + (f.fat   ?? 0), 0);

  // Scale all items proportionally to hit the calorie target
  const scale = rawCal > 0 ? calorieTarget / rawCal : 1;

  return {
    meal: mealType,
    foods: picked.map(f => f.name),
    calories: Math.round(calorieTarget),
    protein:  Math.round(rawProt  * scale),
    carbs:    Math.round(rawCarbs * scale),
    fat:      Math.round(rawFat   * scale),
  };
}
