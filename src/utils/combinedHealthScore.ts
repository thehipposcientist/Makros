/**
 * Combined Health Score — single backward-looking score from workout + nutrition data.
 *
 * Requires 14 days of data before showing. Based on what the user actually
 * DID (logged workouts + checked meals), not what's planned.
 *
 * Scoring (0-100):
 *   Activity (50%):  workout adherence, consistency, volume
 *   Nutrition (50%): meal logging adherence, macro alignment, food quality
 *
 * The score intentionally doesn't show until 14 days have passed since
 * the user's first logged workout or meal check. New users see a
 * "keep logging" placeholder instead of a misleading number.
 */

export interface HealthScoreData {
  score: number;           // 0-100 combined
  activityScore: number;   // 0-100 sub-score
  nutritionScore: number;  // 0-100 sub-score
  confidence: 'low' | 'medium' | 'high';
  daysOfData: number;      // how many days of logged data
  daysRequired: number;    // 14
  ready: boolean;          // daysOfData >= daysRequired
  activityDetail: {
    workoutsLogged: number;
    workoutsExpected: number;
    adherencePct: number;
  };
  nutritionDetail: {
    mealsLogged: number;
    mealsExpected: number;
    adherencePct: number;
    avgCalorieAlignment: number;
    avgProteinAlignment: number;
  };
  summary: string;
}

const DAYS_REQUIRED = 14;

interface WorkoutHistoryEntry {
  date: string;
  completed: boolean;
}

interface MealCheckEntry {
  date: string;
  mealsChecked: number;
  mealsTotal: number;
  totalCalories?: number;
  targetCalories?: number;
  totalProtein?: number;
  targetProtein?: number;
}

export function computeHealthScore(
  workoutHistory: WorkoutHistoryEntry[],
  mealHistory: MealCheckEntry[],
  targetDaysPerWeek: number,
  mealsPerDay: number,
  firstLogDate?: string,
): HealthScoreData {
  const empty: HealthScoreData = {
    score: 0, activityScore: 0, nutritionScore: 0,
    confidence: 'low', daysOfData: 0, daysRequired: DAYS_REQUIRED, ready: false,
    activityDetail: { workoutsLogged: 0, workoutsExpected: 0, adherencePct: 0 },
    nutritionDetail: { mealsLogged: 0, mealsExpected: 0, adherencePct: 0, avgCalorieAlignment: 0, avgProteinAlignment: 0 },
    summary: `Log workouts and meals for ${DAYS_REQUIRED} days to see your Health Score`,
  };

  // Determine how many days of data we have
  const allDates = new Set([
    ...workoutHistory.map(w => w.date.slice(0, 10)),
    ...mealHistory.map(m => m.date.slice(0, 10)),
  ]);
  const daysOfData = allDates.size;

  if (daysOfData < DAYS_REQUIRED) {
    return {
      ...empty,
      daysOfData,
      summary: `${DAYS_REQUIRED - daysOfData} more day${DAYS_REQUIRED - daysOfData !== 1 ? 's' : ''} of logging to unlock your Health Score`,
    };
  }

  // ── Activity score (0-100) ──
  const completedWorkouts = workoutHistory.filter(w => w.completed).length;
  const expectedWorkouts = Math.round(targetDaysPerWeek * (daysOfData / 7));
  const workoutAdherence = expectedWorkouts > 0 ? Math.min(1, completedWorkouts / expectedWorkouts) : 0;
  const activityScore = Math.round(workoutAdherence * 100);

  // ── Nutrition score (0-100) ──
  const totalMealsLogged = mealHistory.reduce((s, m) => s + m.mealsChecked, 0);
  const totalMealsExpected = mealHistory.reduce((s, m) => s + m.mealsTotal, 0);
  const mealAdherence = totalMealsExpected > 0 ? Math.min(1, totalMealsLogged / totalMealsExpected) : 0;

  let calAlignmentSum = 0, calAlignmentCount = 0;
  let proAlignmentSum = 0, proAlignmentCount = 0;
  for (const m of mealHistory) {
    if (m.totalCalories && m.targetCalories && m.targetCalories > 0) {
      const dev = Math.abs(1 - m.totalCalories / m.targetCalories);
      calAlignmentSum += dev <= 0.10 ? 1.0 : Math.max(0, 1 - (dev - 0.10) / 0.30);
      calAlignmentCount++;
    }
    if (m.totalProtein && m.targetProtein && m.targetProtein > 0) {
      const ratio = m.totalProtein / m.targetProtein;
      proAlignmentSum += ratio >= 1.0 ? 1.0 : Math.max(0, ratio);
      proAlignmentCount++;
    }
  }
  const avgCalAlignment = calAlignmentCount > 0 ? calAlignmentSum / calAlignmentCount : 0.5;
  const avgProAlignment = proAlignmentCount > 0 ? proAlignmentSum / proAlignmentCount : 0.5;

  // Nutrition: 40% meal adherence + 35% calorie alignment + 25% protein alignment
  const nutritionScore = Math.round(
    mealAdherence * 40 + avgCalAlignment * 35 + avgProAlignment * 25,
  );

  // ── Combined (50/50) ──
  const score = Math.round(activityScore * 0.5 + nutritionScore * 0.5);
  const confidence = daysOfData >= 28 ? 'high' : daysOfData >= 14 ? 'medium' : 'low';

  const rating = score >= 80 ? 'Excellent' : score >= 65 ? 'Good' : score >= 45 ? 'Fair' : 'Needs work';
  return {
    score,
    activityScore,
    nutritionScore,
    confidence,
    daysOfData,
    daysRequired: DAYS_REQUIRED,
    ready: true,
    activityDetail: {
      workoutsLogged: completedWorkouts,
      workoutsExpected: expectedWorkouts,
      adherencePct: Math.round(workoutAdherence * 100),
    },
    nutritionDetail: {
      mealsLogged: totalMealsLogged,
      mealsExpected: totalMealsExpected,
      adherencePct: Math.round(mealAdherence * 100),
      avgCalorieAlignment: Math.round(avgCalAlignment * 100),
      avgProteinAlignment: Math.round(avgProAlignment * 100),
    },
    summary: rating,
  };
}
