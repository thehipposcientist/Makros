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
const CARDIO_MACHINE_ITEMS = new Set([
  'Treadmill', 'Stationary Bike', 'Elliptical', 'Rowing Machine',
  'Stair Climber', 'Assault Bike', 'Battle Ropes',
]);
const SWIMMING_ITEMS = new Set(['Swimming Pool']);
const JUMP_ROPE_ITEMS = new Set(['Jump rope']);

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

function hasCardioMachine(equipment: string[]): boolean {
  return equipment.some(e => CARDIO_MACHINE_ITEMS.has(e));
}

function hasTreadmill(equipment: string[]): boolean {
  return equipment.includes('Treadmill');
}

function hasStatBike(equipment: string[]): boolean {
  return equipment.includes('Stationary Bike');
}

function hasRowingMachine(equipment: string[]): boolean {
  return equipment.includes('Rowing Machine');
}

function hasSwimming(equipment: string[]): boolean {
  return equipment.some(e => SWIMMING_ITEMS.has(e));
}

function hasJumpRope(equipment: string[]): boolean {
  return equipment.some(e => JUMP_ROPE_ITEMS.has(e));
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

// Deterministic shuffle using a simple seed string
function seededShuffle<T>(arr: T[], seed: string): T[] {
  const copy = [...arr];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  for (let i = copy.length - 1; i > 0; i--) {
    h = (Math.imul(h ^ (h >>> 16), 0x45d9f3b)) | 0;
    const j = Math.abs(h) % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Pick n items with variety — uses a stable shuffle so the same profile always
// yields the same plan, but different plans look different from each other
let _pickSeed = '';
function pick<T>(arr: T[], n: number): T[] {
  const shuffled = seededShuffle(arr, _pickSeed || 'default');
  return shuffled.slice(0, Math.min(n, shuffled.length));
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
    { name: gym ? 'Seated Calf Raise'       : 'Single-leg Calf Raise',    sets: 3, reps: '15-20', restSeconds: 45, equipment: gym ? 'Machine' : 'Bodyweight' },
  ];
}

function cardioPool(equipment: string[]): Exercise[] {
  const treadmill  = hasTreadmill(equipment);
  const bike       = hasStatBike(equipment);
  const rowing     = hasRowingMachine(equipment);
  const swim       = hasSwimming(equipment);
  const rope       = hasJumpRope(equipment);
  const anyMachine = hasCardioMachine(equipment);

  const pool: Exercise[] = [];

  if (treadmill) {
    pool.push(
      { name: 'Treadmill Run',       sets: 1, reps: '20-30 min', restSeconds: 0, equipment: 'Treadmill' },
      { name: 'Treadmill Intervals', sets: 8, reps: '30s sprint / 90s walk', restSeconds: 0, equipment: 'Treadmill' },
      { name: 'Incline Walk',        sets: 1, reps: '20 min @ 8-12% incline', restSeconds: 0, equipment: 'Treadmill' },
    );
  }
  if (bike) {
    pool.push(
      { name: 'Stationary Bike',          sets: 1, reps: '20-30 min steady', restSeconds: 0, equipment: 'Stationary Bike' },
      { name: 'Stationary Bike Intervals',sets: 8, reps: '30s all-out / 90s easy', restSeconds: 0, equipment: 'Stationary Bike' },
    );
  }
  if (rowing) {
    pool.push(
      { name: 'Rowing Machine',          sets: 1, reps: '20 min steady',        restSeconds: 0, equipment: 'Rowing Machine' },
      { name: 'Rowing Machine Intervals',sets: 6, reps: '500m hard / 2 min rest', restSeconds: 120, equipment: 'Rowing Machine' },
    );
  }
  if (swim) {
    pool.push(
      { name: 'Swimming Laps', sets: 1, reps: '30 min continuous', restSeconds: 0, equipment: 'Pool' },
    );
  }
  if (equipment.includes('Stair Climber')) {
    pool.push(
      { name: 'Stair Climber', sets: 1, reps: '15-20 min', restSeconds: 0, equipment: 'Stair Climber' },
    );
  }
  if (equipment.includes('Assault Bike')) {
    pool.push(
      { name: 'Assault Bike', sets: 8, reps: '20s all-out / 40s rest', restSeconds: 40, equipment: 'Assault Bike' },
    );
  }
  if (equipment.includes('Battle Ropes')) {
    pool.push(
      { name: 'Battle Ropes', sets: 5, reps: '30s waves / 30s rest', restSeconds: 30, equipment: 'Battle Ropes' },
    );
  }
  if (rope) {
    pool.push(
      { name: 'Jump Rope HIIT', sets: 6, reps: '1 min on / 30s off', restSeconds: 30, equipment: 'Jump Rope' },
    );
  }

  // Always include bodyweight cardio options
  pool.push(
    { name: 'Sprint Intervals',  sets: 6,  reps: '100m sprint / 90s walk', restSeconds: 90,  equipment: 'Bodyweight' },
    { name: 'Jogging',           sets: 1,  reps: '20-30 min easy pace',     restSeconds: 0,   equipment: 'Bodyweight' },
    { name: 'Burpees',           sets: 4,  reps: '10-15',                   restSeconds: 60,  equipment: 'Bodyweight' },
    { name: 'HIIT Circuit',      sets: 4,  reps: '40s work / 20s rest',     restSeconds: 20,  equipment: 'Bodyweight' },
    { name: 'Mountain Climbers', sets: 3,  reps: '30s',                     restSeconds: 30,  equipment: 'Bodyweight' },
    { name: 'Jump Squats',       sets: 3,  reps: '12-15',                   restSeconds: 45,  equipment: 'Bodyweight' },
    { name: 'Running (Outdoor)', sets: 1,  reps: '20-30 min',               restSeconds: 0,   equipment: 'Bodyweight' },
    { name: 'Hill Sprints',      sets: 6,  reps: '20s sprint up / walk down', restSeconds: 60, equipment: 'Bodyweight' },
  );

  return pool;
}

function cardioFinisher(equipment: string[]): Exercise {
  const treadmill = hasTreadmill(equipment);
  const bike = hasStatBike(equipment);
  const rowing = hasRowingMachine(equipment);
  const rope = hasJumpRope(equipment);

  if (treadmill) return { name: 'Treadmill Intervals', sets: 6, reps: '30s sprint / 90s walk', restSeconds: 0, equipment: 'Treadmill' };
  if (bike) return { name: 'Stationary Bike Intervals', sets: 6, reps: '30s all-out / 90s easy', restSeconds: 0, equipment: 'Stationary Bike' };
  if (rowing) return { name: 'Rowing Machine', sets: 1, reps: '10 min steady pace', restSeconds: 0, equipment: 'Rowing Machine' };
  if (rope) return { name: 'Jump Rope HIIT', sets: 5, reps: '1 min on / 30s off', restSeconds: 30, equipment: 'Jump Rope' };
  return { name: 'HIIT Circuit', sets: 4, reps: '40s work / 20s rest', restSeconds: 20, equipment: 'Bodyweight' };
}

// ─── Workout generation ───────────────────────────────────────────────────────

export function generateWorkoutPlan(profile: UserProfile): WorkoutPlan {
  const { daysPerWeek, equipment, goal, workoutDurationMinutes = 60 } = profile;
  const gym   = hasGymEquip(equipment);
  const db    = hasDumbbellEquip(equipment);
  const pu    = hasPullUpBar(equipment);
  const count = exerciseCount(workoutDurationMinutes);

  // Set a stable seed based on the profile so plan is consistent but different per user
  _pickSeed = `${goal}|${daysPerWeek}|${equipment.slice().sort().join(',')}|${workoutDurationMinutes}`;

  const isCardioGoal   = goal === 'endurance' || goal === 'athletic_performance';
  const isStrengthGoal = goal === 'strength';
  const hasCardio      = hasCardioMachine(equipment) || hasSwimming(equipment) || hasJumpRope(equipment);

  const days = buildDays(daysPerWeek, gym, db, pu, count, equipment, goal, isCardioGoal, hasCardio);

  return { name: `${daysPerWeek}-Day Split`, totalDays: daysPerWeek, days };
}

function buildDays(
  days: number, gym: boolean, db: boolean, pu: boolean, count: number,
  equipment: string[], goal: string, isCardioGoal: boolean, hasCardio: boolean
): WorkoutDay[] {
  if (isCardioGoal) return cardioFocusedDays(days, gym, db, pu, count, equipment);
  if (days <= 3)    return fullBodyDays(gym, db, pu, count, equipment, hasCardio, goal);
  if (days <= 5)    return pplDays(gym, db, pu, count, equipment, hasCardio, goal);
  return upperLowerDays(gym, db, pu, count, equipment, hasCardio, goal);
}

function withCardioFinisher(exercises: Exercise[], equipment: string[], goal: string): Exercise[] {
  const addCardio = goal === 'fat_loss' || goal === 'toning' || goal === 'body_recomp';
  if (!addCardio) return exercises;
  return [...exercises, cardioFinisher(equipment)];
}

function fullBodyDays(gym: boolean, db: boolean, pu: boolean, count: number, equipment: string[], hasCardio: boolean, goal: string): WorkoutDay[] {
  const squat = squatPool(gym, db);
  const hinge = hingePool(gym, db);
  const push  = pushPool(gym, db);
  const pull  = pullPool(gym, db, pu);
  const core  = corePool(gym, db);

  const makeDay = (label: string, focus: string, pools: Exercise[][]): WorkoutDay => {
    const combined = pools.flat();
    const base = pick(combined, count);
    return { day: label, focus, exercises: withCardioFinisher(base, equipment, goal) };
  };

  return [
    makeDay('Day 1', 'Full Body — Strength',   [squat, push, pull, core]),
    makeDay('Day 2', 'Full Body — Power',       [hinge, push, pull, core]),
    makeDay('Day 3', 'Full Body — Hypertrophy', [squat, hinge, push, pull, core]),
  ].slice(0, 3);
}

function pplDays(gym: boolean, db: boolean, pu: boolean, count: number, equipment: string[], hasCardio: boolean, goal: string): WorkoutDay[] {
  const push  = pushPool(gym, db);
  const pull  = pullPool(gym, db, pu);
  const squat = squatPool(gym, db);
  const hinge = hingePool(gym, db);
  const core  = corePool(gym, db);
  const calf  = calfPool(gym, db);

  const addFinisher = (exs: Exercise[]) => withCardioFinisher(exs, equipment, goal);

  return [
    { day: 'Day 1', focus: 'Push — Chest, Shoulders & Triceps',   exercises: addFinisher(pick(push, count)) },
    { day: 'Day 2', focus: 'Pull — Back & Biceps',                 exercises: addFinisher(pick(pull, count)) },
    { day: 'Day 3', focus: 'Legs — Quads, Hamstrings & Glutes',    exercises: addFinisher(pick([...squat, ...hinge, ...calf], count)) },
    { day: 'Day 4', focus: 'Push — Volume & Shoulders',            exercises: addFinisher(pick([...push.slice(1), ...push], count)) },
    { day: 'Day 5', focus: 'Pull — Volume & Core',                 exercises: addFinisher(pick([...pull.slice(1), ...core], count)) },
  ];
}

function upperLowerDays(gym: boolean, db: boolean, pu: boolean, count: number, equipment: string[], hasCardio: boolean, goal: string): WorkoutDay[] {
  const push  = pushPool(gym, db);
  const pull  = pullPool(gym, db, pu);
  const squat = squatPool(gym, db);
  const hinge = hingePool(gym, db);
  const core  = corePool(gym, db);
  const calf  = calfPool(gym, db);

  const addFinisher = (exs: Exercise[]) => withCardioFinisher(exs, equipment, goal);

  return [
    { day: 'Day 1', focus: 'Upper A — Strength',    exercises: addFinisher(pick([...push, ...pull], count)) },
    { day: 'Day 2', focus: 'Lower A — Strength',    exercises: addFinisher(pick([...squat, ...hinge, ...calf], count)) },
    { day: 'Day 3', focus: 'Upper B — Hypertrophy', exercises: addFinisher(pick([...push, ...pull], count)) },
    { day: 'Day 4', focus: 'Lower B — Hypertrophy', exercises: addFinisher(pick([...squat, ...hinge, ...core], count)) },
    { day: 'Day 5', focus: 'Upper C — Volume',      exercises: addFinisher(pick([...push, ...pull, ...core], count)) },
    { day: 'Day 6', focus: 'Lower C — Volume',      exercises: addFinisher(pick([...squat, ...hinge, ...calf, ...core], count)) },
  ];
}

function cardioFocusedDays(days: number, gym: boolean, db: boolean, pu: boolean, count: number, equipment: string[]): WorkoutDay[] {
  const cardio = cardioPool(equipment);
  const push   = pushPool(gym, db);
  const pull   = pullPool(gym, db, pu);
  const squat  = squatPool(gym, db);
  const hinge  = hingePool(gym, db);
  const core   = corePool(gym, db);

  const cardioDay = (label: string, focus: string): WorkoutDay => ({
    day: label, focus, exercises: pick(cardio, Math.min(3, count)),
  });
  const strengthDay = (label: string, focus: string, pools: Exercise[][]): WorkoutDay => ({
    day: label, focus, exercises: pick(pools.flat(), count - 1),
  });

  const allDays: WorkoutDay[] = [
    cardioDay('Day 1', 'Cardio — Endurance'),
    strengthDay('Day 2', 'Strength — Upper Body', [push, pull]),
    cardioDay('Day 3', 'Cardio — Intervals & HIIT'),
    strengthDay('Day 4', 'Strength — Lower Body', [squat, hinge]),
    cardioDay('Day 5', 'Cardio — Active Recovery'),
    { day: 'Day 6', focus: 'Full Body & Core', exercises: pick([...push, ...pull, ...squat, ...core], count) },
    cardioDay('Day 7', 'Cardio — Long Distance'),
  ];

  return allDays.slice(0, days);
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

function niceFraction(n: number): string {
  const whole = Math.floor(n);
  const frac  = n - whole;
  const fracStr = frac < 0.15 ? '' : frac < 0.4 ? '¼' : frac < 0.65 ? '½' : frac < 0.9 ? '¾' : '';
  if (!fracStr && whole === 0) return '½';
  if (!fracStr) return String(whole);
  if (whole === 0) return fracStr;
  return `${whole}${fracStr}`;
}

// Infer a real unit from the food name when the database has no useful unit
function inferUnit(food: FoodItem): { unit: string; baseAmount: number } {
  const name = (food.name ?? '').toLowerCase();
  // Liquid/fluid items
  if (/milk|juice|smoothie|shake|protein shake|water|broth|coffee|tea/.test(name)) {
    return { unit: 'fl oz', baseAmount: 8 };
  }
  // Whole eggs
  if (/^egg/.test(name) || name === 'eggs') {
    return { unit: 'egg', baseAmount: 2 };
  }
  // High-protein meats / fish (estimate oz by protein density)
  if (/chicken|beef|steak|pork|turkey|salmon|tuna|shrimp|tilapia|cod|fish|lamb|bison/.test(name)) {
    const baseOz = food.protein >= 20 ? 6 : food.protein >= 12 ? 5 : 4;
    return { unit: 'oz', baseAmount: baseOz };
  }
  // Dairy — yogurt, cottage cheese, etc.
  if (/yogurt|cottage cheese|ricotta/.test(name)) {
    return { unit: 'cup', baseAmount: 1 };
  }
  // Grains / rice / oats / pasta
  if (/rice|oat|pasta|quinoa|bread|tortilla|cereal|granola/.test(name)) {
    if (/slice|bread|tortilla/.test(name)) return { unit: 'slice', baseAmount: 2 };
    return { unit: 'cup', baseAmount: 1 };
  }
  // Nut butters / oils / sauces (high cal, small serving)
  if (/butter|oil|sauce|dressing|mayo/.test(name)) {
    return { unit: 'tbsp', baseAmount: 2 };
  }
  // Nuts / seeds
  if (/nut|almond|cashew|walnut|seed|peanut/.test(name)) {
    return { unit: 'oz', baseAmount: 1 };
  }
  // Fruits
  if (/banana|apple|orange|mango|berry|blueberry|strawberry|grape/.test(name)) {
    if (/berry|blueberry|strawberry|grape/.test(name)) return { unit: 'cup', baseAmount: 1 };
    return { unit: 'piece', baseAmount: 1 };
  }
  // Vegetables
  if (/broccoli|spinach|lettuce|kale|carrot|pepper|zucchini|cucumber|tomato|asparagus/.test(name)) {
    return { unit: 'cup', baseAmount: 2 };
  }
  // Root veg / starchy
  if (/potato|yam|sweet potato/.test(name)) {
    return { unit: 'medium', baseAmount: 1 };
  }
  // Legumes / beans
  if (/bean|lentil|chickpea|edamame/.test(name)) {
    return { unit: 'cup', baseAmount: 0.75 };
  }
  // Cheese
  if (/cheese/.test(name)) {
    return { unit: 'oz', baseAmount: 1.5 };
  }
  // Default: oz for proteins, cup for everything else
  if (food.protein > 10) return { unit: 'oz', baseAmount: 4 };
  return { unit: 'cup', baseAmount: 0.75 };
}

function formatAmount(food: FoodItem, scale: number): string {
  const unit = (food.unit ?? '').toLowerCase().trim();

  if (!unit || unit === 'serving') {
    const inferred = inferUnit(food);
    const amount = Math.max(inferred.baseAmount * 0.5, Math.round(scale * inferred.baseAmount * 2) / 2);
    if (inferred.unit === 'medium' || inferred.unit === 'piece' || inferred.unit === 'slice' || inferred.unit === 'egg') {
      const n = Math.max(1, Math.round(scale * inferred.baseAmount));
      return `${n} ${inferred.unit}${n !== 1 ? 's' : ''}`;
    }
    return `${niceFraction(amount)} ${inferred.unit}`;
  }

  // Unit contains embedded number like "100g", "150ml", "30g" — multiply it by scale
  const embeddedMatch = unit.match(/^(\d+(?:\.\d+)?)\s*(g|ml|oz|fl oz|kcal)$/);
  if (embeddedMatch) {
    const base = parseFloat(embeddedMatch[1]);
    const suffix = embeddedMatch[2];
    const total = Math.max(base, Math.round(scale * base / 5) * 5);
    return `${total}${suffix}`;
  }

  if (unit === 'oz' || unit === 'ounce' || unit === 'ounces') {
    const baseOz = food.protein >= 15 ? 5 : food.protein >= 8 ? 4 : 2;
    const oz = Math.max(0.5, Math.round(scale * baseOz * 2) / 2);
    return `${niceFraction(oz)} oz`;
  }
  if (unit === 'g' || unit === 'gram' || unit === 'grams') {
    const base = food.calories > 0 ? Math.round(100 / (food.calories / 100)) : 100;
    const g = Math.max(25, Math.round(scale * base / 10) * 10);
    return `${g}g`;
  }
  if (unit === 'ml' || unit === 'milliliter' || unit === 'milliliters') {
    const ml = Math.max(50, Math.round(scale * 240 / 50) * 50);
    return `${ml}ml`;
  }
  if (unit === 'fl oz' || unit === 'fluid oz' || unit === 'fluid ounce') {
    const fl = Math.max(1, Math.round(scale * 8));
    return `${fl} fl oz`;
  }
  if (unit === 'cup' || unit === 'cups') {
    const cups = Math.max(0.25, Math.round(scale * 4) / 4);
    return `${niceFraction(cups)} cup`;
  }
  if (unit === 'tbsp' || unit === 'tablespoon' || unit === 'tablespoons') {
    const tbsp = Math.max(1, Math.round(scale * 2));
    return `${tbsp} tbsp`;
  }
  if (unit === 'tsp' || unit === 'teaspoon' || unit === 'teaspoons') {
    const tsp = Math.max(1, Math.round(scale * 2));
    return `${tsp} tsp`;
  }
  // Count-type units: just return a number (e.g. "2 eggs" not "2 large eggs")
  if (/egg|piece|slice|scoop|each|item/.test(unit)) {
    const base = unit.includes('egg') ? 2 : 1;
    const n = Math.max(1, Math.round(scale * base));
    const clean = unit.replace(/large\s*|medium\s*|small\s*/gi, '').replace(/s$/, '').trim();
    return `${n} ${clean}${n !== 1 ? 's' : ''}`;
  }
  // Unknown unit with no number prefix — use as-is with scale
  const s = Math.max(0.5, Math.round(scale * 4) / 4);
  return `${niceFraction(s)} ${unit}`;
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

  // If we ended up with no known foods, fall back to defaults with sensible amounts
  if (picked.length === 0) {
    const fallbackNames = DEFAULT_MEAL_FOODS[mealType] ?? ['Chicken breast', 'White rice', 'Broccoli'];
    const totalCal = Math.round(calorieTarget);
    const fallbackAmounts: Record<string, string> = {
      'Chicken breast': '6 oz', 'Chicken thigh': '5 oz', 'Turkey breast': '6 oz',
      'Salmon': '6 oz', 'Tuna': '5 oz', 'Tilapia': '6 oz', 'Cod': '6 oz', 'Shrimp': '5 oz',
      'Ground beef': '5 oz', 'Lean ground beef': '5 oz', 'Steak': '6 oz', 'Pork tenderloin': '5 oz',
      'Eggs': '3 eggs', 'Egg whites': '4 fl oz',
      'Greek yogurt': '1 cup', 'Cottage cheese': '1 cup', 'Low-fat yogurt': '1 cup',
      'Whole milk': '8 fl oz', 'Skim milk': '8 fl oz', 'Almond milk': '8 fl oz',
      'Protein shake': '12 fl oz', 'Whey protein': '1 scoop',
      'White rice': '1 cup', 'Brown rice': '1 cup', 'Oats': '½ cup',
      'Quinoa': '¾ cup', 'Pasta': '1 cup', 'Whole wheat bread': '2 slices', 'Tortilla': '2 pieces',
      'Sweet potato': '1 medium', 'White potato': '1 medium', 'Banana': '1 medium',
      'Broccoli': '2 cups', 'Spinach': '2 cups', 'Kale': '2 cups', 'Mixed greens': '2 cups',
      'Bell pepper': '1 cup', 'Zucchini': '1 cup', 'Asparagus': '1 cup', 'Green beans': '1 cup',
      'Blueberries': '½ cup', 'Strawberries': '1 cup', 'Apple': '1 medium', 'Orange': '1 medium',
      'Olive oil': '1 tbsp', 'Coconut oil': '1 tbsp', 'Avocado': '½ each',
      'Almond butter': '2 tbsp', 'Peanut butter': '2 tbsp',
      'Almonds': '1 oz', 'Walnuts': '1 oz', 'Cashews': '1 oz',
      'Cheddar cheese': '1½ oz', 'Mozzarella': '1½ oz',
      'Black beans': '¾ cup', 'Chickpeas': '¾ cup', 'Lentils': '¾ cup',
    };
    return {
      meal: mealType,
      foods: fallbackNames,
      amounts: fallbackNames.map(n => fallbackAmounts[n] ?? '1 serving'),
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
    amounts: picked.map(f => formatAmount(f, scale)),
    calories: Math.round(calorieTarget),
    protein:  Math.round(rawProt  * scale),
    carbs:    Math.round(rawCarbs * scale),
    fat:      Math.round(rawFat   * scale),
  };
}
