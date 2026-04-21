import { UserProfile } from '../types';
import { GoalConfig } from '../hooks/useMetaData';

const PACE_LBS_PER_WEEK: Record<string, Record<string, number>> = {
  fat_loss:    { conservative: 0.5,  moderate: 1.0,  aggressive: 1.5 },
  toning:      { conservative: 0.5,  moderate: 0.75, aggressive: 1.0 },
  muscle_gain: { conservative: 0.25, moderate: 0.5,  aggressive: 1.0 },
  body_recomp: { conservative: 0.25, moderate: 0.5,  aggressive: 0.75 },
};

// Profiles store primary goal ids (lose_fat, build_muscle, ...). The pace
// table keys off bucket names. Without this map the lookup whiffs and
// no ETA shows on the Progress weight card.
const GOAL_TO_BUCKET: Record<string, string> = {
  build_muscle: 'muscle_gain', lean_bulk: 'muscle_gain', gain_weight: 'muscle_gain',
  improve_aesthetics: 'muscle_gain', build_glutes: 'muscle_gain',
  build_upper_body: 'muscle_gain', build_lower_body: 'muscle_gain',
  build_arms: 'muscle_gain', build_shoulders: 'muscle_gain',
  lose_fat: 'fat_loss', get_lean: 'fat_loss', cut: 'fat_loss',
  preserve_muscle_cutting: 'fat_loss',
  body_recomp: 'body_recomp',
  tone: 'toning', get_toned: 'toning',
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

  // Resolve to bucket so primary goal ids ("lose_fat", "build_muscle")
  // hit the bucket-keyed pace table ("fat_loss", "muscle_gain").
  const bucket = GOAL_TO_BUCKET[goal] ?? goal;

  if ((weightGoals.has(goal) || weightGoals.has(bucket)) && targetWeightLbs != null && targetWeightLbs > 0) {
    const lbsPerWeek = PACE_LBS_PER_WEEK[bucket]?.[pace] ?? PACE_LBS_PER_WEEK[goal]?.[pace];
    if (lbsPerWeek && lbsPerWeek > 0 && physicalStats?.weightLbs) {
      const delta = Math.abs(physicalStats.weightLbs - targetWeightLbs);
      weeks = Math.ceil(delta / lbsPerWeek);
    }
  } else if (timelineGoals.has(goal) || timelineGoals.has(bucket)) {
    weeks = goalConfig.timeline_weeks[bucket]?.[pace] ?? goalConfig.timeline_weeks[goal]?.[pace] ?? null;
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
