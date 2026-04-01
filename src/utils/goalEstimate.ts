import { UserProfile } from '../types';
import { WEIGHT_GOALS, TIMELINE_GOALS, TIMELINE_WEEKS } from '../constants/goals';

const PACE_LBS_PER_WEEK: Record<string, Record<string, number>> = {
  fat_loss:    { conservative: 0.5,  moderate: 1.0,  aggressive: 1.5 },
  toning:      { conservative: 0.5,  moderate: 0.75, aggressive: 1.0 },
  muscle_gain: { conservative: 0.25, moderate: 0.5,  aggressive: 1.0 },
};

export interface GoalEstimate {
  weeks: number;
  date: Date;
  label: string; // e.g. "14 weeks away"
}

export function getGoalEstimate(profile: UserProfile): GoalEstimate | null {
  const { goal, goalDetails, physicalStats } = profile;
  const { pace, targetWeightLbs } = goalDetails;

  let weeks: number | null = null;

  if (WEIGHT_GOALS.has(goal) && targetWeightLbs != null && targetWeightLbs > 0) {
    const lbsPerWeek = PACE_LBS_PER_WEEK[goal]?.[pace];
    if (lbsPerWeek && lbsPerWeek > 0) {
      const delta = Math.abs(physicalStats.weightLbs - targetWeightLbs);
      weeks = Math.ceil(delta / lbsPerWeek);
    }
  } else if (TIMELINE_GOALS.has(goal)) {
    weeks = TIMELINE_WEEKS[goal]?.[pace] ?? null;
  }

  if (!weeks || weeks <= 0) return null;

  const date = new Date();
  date.setDate(date.getDate() + weeks * 7);

  return {
    weeks,
    date,
    label: weeks === 1 ? '1 week away' : `${weeks} weeks away`,
  };
}
