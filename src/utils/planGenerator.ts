import {
  UserProfile,
  WorkoutPlan,
  WorkoutDay,
  Exercise,
  DailyNutritionPlan,
  NutritionTargets,
  MealSuggestion,
} from '../types';

// Workout generation logic
export function generateWorkoutPlan(profile: UserProfile): WorkoutPlan {
  const { daysPerWeek, equipment, goal } = profile;
  const days = generateWorkoutDays(daysPerWeek, equipment, goal);
  
  return {
    name: `${daysPerWeek}-Day Split`,
    totalDays: daysPerWeek,
    days,
  };
}

function generateWorkoutDays(
  daysPerWeek: number,
  equipment: Equipment[],
  goal: string
): WorkoutDay[] {
  const hasGym = equipment.includes('gym');
  const hasDumbbells = equipment.includes('dumbbells');
  const hasBodyweight = equipment.length === 0 || equipment.includes('home');

  // Simple splits based on days available
  if (daysPerWeek <= 3) {
    return generateFullBodySplit(hasGym, hasDumbbells, hasBodyweight);
  } else if (daysPerWeek <= 5) {
    return generatePPLSplit(hasGym, hasDumbbells, hasBodyweight);
  } else {
    return generateUpperLowerSplit(hasGym, hasDumbbells, hasBodyweight);
  }
}

function generateFullBodySplit(
  hasGym: boolean,
  hasDumbbells: boolean,
  hasBodyweight: boolean
): WorkoutDay[] {
  return [
    {
      day: 'Day 1',
      focus: 'Full Body A',
      exercises: [
        {
          name: hasGym ? 'Barbell Squats' : 'Bodyweight Squats',
          sets: 3,
          reps: '8-10',
          restSeconds: 90,
          equipment: hasGym ? 'gym' : 'bodyweight',
        },
        {
          name: hasGym ? 'Barbell Bench Press' : 'Push-ups',
          sets: 3,
          reps: '8-10',
          restSeconds: 90,
          equipment: hasGym ? 'gym' : 'bodyweight',
        },
        {
          name: hasDumbbells ? 'Dumbbell Rows' : 'Push-ups',
          sets: 3,
          reps: '8-10',
          restSeconds: 60,
          equipment: hasDumbbells ? 'dumbbells' : 'bodyweight',
        },
      ],
    },
    {
      day: 'Day 2',
      focus: 'Full Body B',
      exercises: [
        {
          name: hasGym ? 'Deadlifts' : 'Single-leg Squats',
          sets: 3,
          reps: '5-8',
          restSeconds: 120,
          equipment: hasGym ? 'gym' : 'bodyweight',
        },
        {
          name: hasDumbbells ? 'Dumbbell Press' : 'Push-ups',
          sets: 3,
          reps: '8-10',
          restSeconds: 60,
          equipment: hasDumbbells ? 'dumbbells' : 'bodyweight',
        },
        {
          name: 'Pull-ups',
          sets: 3,
          reps: '5-8',
          restSeconds: 90,
          equipment: 'gym',
        },
      ],
    },
    {
      day: 'Day 3',
      focus: 'Full Body C',
      exercises: [
        {
          name: hasGym ? 'Leg Press' : 'Lunges',
          sets: 3,
          reps: '10-12',
          restSeconds: 60,
          equipment: hasGym ? 'gym' : 'bodyweight',
        },
        {
          name: hasGym ? 'Cable Fly' : 'Incline Push-ups',
          sets: 3,
          reps: '12-15',
          restSeconds: 60,
          equipment: hasGym ? 'gym' : 'bodyweight',
        },
        {
          name: hasDumbbells ? 'Dumbbell Curls' : 'Pike Push-ups',
          sets: 3,
          reps: '10-12',
          restSeconds: 60,
          equipment: hasDumbbells ? 'dumbbells' : 'bodyweight',
        },
      ],
    },
  ];
}

function generatePPLSplit(
  hasGym: boolean,
  hasDumbbells: boolean,
  hasBodyweight: boolean
): WorkoutDay[] {
  return [
    {
      day: 'Day 1',
      focus: 'Push Day',
      exercises: [
        {
          name: hasGym ? 'Barbell Bench Press' : 'Push-ups',
          sets: 4,
          reps: '6-8',
          restSeconds: 90,
          equipment: hasGym ? 'gym' : 'bodyweight',
        },
        {
          name: hasGym ? 'Incline Dumbbell Press' : 'Incline Push-ups',
          sets: 3,
          reps: '8-10',
          restSeconds: 60,
          equipment: hasDumbbells ? 'dumbbells' : 'bodyweight',
        },
      ],
    },
    {
      day: 'Day 2',
      focus: 'Pull Day',
      exercises: [
        {
          name: 'Pull-ups',
          sets: 4,
          reps: '6-8',
          restSeconds: 90,
          equipment: 'gym',
        },
        {
          name: hasGym ? 'Barbell Rows' : 'Inverted Rows',
          sets: 3,
          reps: '8-10',
          restSeconds: 60,
          equipment: hasGym ? 'gym' : 'bodyweight',
        },
      ],
    },
    {
      day: 'Day 3',
      focus: 'Leg Day',
      exercises: [
        {
          name: hasGym ? 'Barbell Squats' : 'Bodyweight Squats',
          sets: 4,
          reps: '6-8',
          restSeconds: 120,
          equipment: hasGym ? 'gym' : 'bodyweight',
        },
        {
          name: hasGym ? 'Leg Press' : 'Lunges',
          sets: 3,
          reps: '8-10',
          restSeconds: 60,
          equipment: hasGym ? 'gym' : 'bodyweight',
        },
      ],
    },
  ];
}

function generateUpperLowerSplit(
  hasGym: boolean,
  hasDumbbells: boolean,
  hasBodyweight: boolean
): WorkoutDay[] {
  return [
    {
      day: 'Day 1',
      focus: 'Upper A',
      exercises: [
        {
          name: hasGym ? 'Barbell Bench Press' : 'Push-ups',
          sets: 4,
          reps: '6-8',
          restSeconds: 90,
          equipment: hasGym ? 'gym' : 'bodyweight',
        },
      ],
    },
    {
      day: 'Day 2',
      focus: 'Lower A',
      exercises: [
        {
          name: hasGym ? 'Barbell Squats' : 'Bodyweight Squats',
          sets: 4,
          reps: '6-8',
          restSeconds: 120,
          equipment: hasGym ? 'gym' : 'bodyweight',
        },
      ],
    },
    {
      day: 'Day 3',
      focus: 'Upper B',
      exercises: [
        {
          name: 'Pull-ups',
          sets: 4,
          reps: '6-8',
          restSeconds: 90,
          equipment: 'gym',
        },
      ],
    },
    {
      day: 'Day 4',
      focus: 'Lower B',
      exercises: [
        {
          name: hasGym ? 'Deadlifts' : 'Single-leg Squats',
          sets: 4,
          reps: '5-8',
          restSeconds: 120,
          equipment: hasGym ? 'gym' : 'bodyweight',
        },
      ],
    },
  ];
}

type Equipment = 'home' | 'gym' | 'dumbbells' | 'bodyweight' | 'other';

// Nutrition generation logic
export function generateDailyNutrition(profile: UserProfile): DailyNutritionPlan {
  const targets = calculateNutritionTargets(profile);
  
  // Divide daily targets into meals
  const breakfastCalories = targets.calories * 0.25;
  const lunchCalories = targets.calories * 0.35;
  const dinnerCalories = targets.calories * 0.4;

  return {
    breakfast: generateMealSuggestion('Breakfast', breakfastCalories, profile.foodsAvailable),
    lunch: generateMealSuggestion('Lunch', lunchCalories, profile.foodsAvailable),
    dinner: generateMealSuggestion('Dinner', dinnerCalories, profile.foodsAvailable),
    targets,
  };
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

function generateMealSuggestion(
  mealType: string,
  calorieTarget: number,
  foodsAvailable: string[]
): MealSuggestion {
  const defaultFoods: Record<string, string[]> = {
    Breakfast: ['Eggs', 'Oatmeal', 'Berries', 'Greek Yogurt', 'Toast'],
    Lunch: ['Chicken', 'Rice', 'Broccoli', 'Sweet Potato'],
    Dinner: ['Salmon', 'Quinoa', 'Asparagus', 'Olive Oil'],
  };

  const foods = foodsAvailable.length > 0 
    ? foodsAvailable.slice(0, 3)
    : defaultFoods[mealType] || ['Protein', 'Carbs', 'Vegetables'];

  // Simple estimation
  const protein = Math.round(calorieTarget * 0.3 / 4);

  return {
    meal: mealType,
    foods,
    calories: Math.round(calorieTarget),
    protein,
  };
}
