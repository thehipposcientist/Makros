import type { WorkoutDay, WorkoutPlan } from '../types';
import type { PlanWeekResponse } from '../services/api';

export function workoutPlanFromPlanWeek(planWeek: PlanWeekResponse): WorkoutPlan {
  return {
    name: 'Active Week',
    totalDays: planWeek.days.length,
    days: planWeek.days.map(d => (
      d.workout ?? { day: 'Rest', focus: 'Rest', exercises: [] }
    ) as WorkoutDay),
  };
}
