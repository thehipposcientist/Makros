import { UserProfile } from '../types';
import { GoalConfig } from '../hooks/useMetaData';

const PACE_LBS_PER_WEEK: Record<string, Record<string, number>> = {
  fat_loss:    { conservative: 0.5,  moderate: 1.0,  aggressive: 1.5 },
  toning:      { conservative: 0.5,  moderate: 0.75, aggressive: 1.0 },
  muscle_gain: { conservative: 0.25, moderate: 0.5,  aggressive: 1.0 },
};

export interface GoalEstimate {
  weeks: number;
  days: number;
  date: Date;
  label: string;
}

export function getGoalEstimate(profile: UserProfile, goalConfig: GoalConfig): GoalEstimate | null {
  const { goal, goalDetails, physicalStats } = profile;
  const { pace, targetWeightLbs } = goalDetails;

  const weightGoals   = new Set(goalConfig.weight_goals);
  const timelineGoals = new Set(goalConfig.timeline_goals);

  let weeks: number | null = null;

  if (weightGoals.has(goal) && targetWeightLbs != null && targetWeightLbs > 0) {
    const lbsPerWeek = PACE_LBS_PER_WEEK[goal]?.[pace];
    if (lbsPerWeek && lbsPerWeek > 0) {
      const delta = Math.abs(physicalStats.weightLbs - targetWeightLbs);
      weeks = Math.ceil(delta / lbsPerWeek);
    }
  } else if (timelineGoals.has(goal)) {
    weeks = goalConfig.timeline_weeks[goal]?.[pace] ?? null;
  }

  if (!weeks || weeks <= 0) return null;

  const days = Math.max(1, Math.ceil(weeks * 7));
  const date = new Date();
  date.setDate(date.getDate() + days);

  let label = '';
  if (days < 14) {
    label = days === 1 ? '1 day away' : `${days} days away`;
  } else {
    label = weeks === 1 ? '1 week away' : `${weeks} weeks away`;
  }

  return {
    weeks,
    days,
    date,
    label,
  };
}
