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

// ── Recomp projection ────────────────────────────────────────────────────────

export interface RecompProjection {
  /** Display range for expected weekly scale weight change, e.g. "±0.25 lb/week" */
  scaleNote: string;
  /** Low end of weekly estimated fat loss in lbs */
  fatLossLow: number;
  /** High end of weekly estimated fat loss in lbs */
  fatLossHigh: number;
  /** Human label for the fat loss range, e.g. "0.2–0.5 lb/week" */
  fatLossRange: string;
  leanMassNote: string;
  bestSignals: string[];
  /** Non-null for aggressive pace; warns that fat loss is slower due to surplus. */
  caveat: string | null;
  timelineWeeks: number;
}

// Calorie context mirrors backend goal_params.py BODY_RECOMP adjustments:
//   conservative: -100 cal/day (slight deficit → better fat loss)
//   moderate:       0 cal/day (maintenance + training effect)
//   aggressive:   +100 cal/day (slight surplus → better muscle, slower fat loss)
const RECOMP_CONFIG: Record<string, {
  fatLow: number; fatHigh: number;
  scaleNote: string; leanNote: string; caveat: string | null;
}> = {
  conservative: {
    fatLow: 0.15, fatHigh: 0.35,
    scaleNote: '±0.25 lb/week',
    leanNote: 'maintain',
    caveat: null,
  },
  moderate: {
    fatLow: 0.2, fatHigh: 0.5,
    scaleNote: '±0.25 lb/week',
    leanNote: 'maintain or slowly increase',
    caveat: null,
  },
  aggressive: {
    fatLow: 0.1, fatHigh: 0.3,
    scaleNote: 'mostly stable or slight gain',
    leanNote: 'slowly building (muscle focus)',
    caveat: 'A slight calorie surplus prioritizes muscle growth. Fat loss will be slower — body composition still improves through strength gains.',
  },
};

export function getRecompProjection(
  profile: UserProfile,
  goalConfig: GoalConfig,
): RecompProjection | null {
  const bucket = GOAL_TO_BUCKET[profile.goal] ?? profile.goal;
  if (bucket !== 'body_recomp') return null;

  const pace = profile.goalDetails?.pace ?? 'moderate';
  const cfg = RECOMP_CONFIG[pace] ?? RECOMP_CONFIG.moderate;
  const timelineWeeks = goalConfig.timeline_weeks?.['body_recomp']?.[pace] ?? 24;

  return {
    scaleNote: cfg.scaleNote,
    fatLossLow: cfg.fatLow,
    fatLossHigh: cfg.fatHigh,
    fatLossRange: `${cfg.fatLow}–${cfg.fatHigh} lb/week`,
    leanMassNote: cfg.leanNote,
    bestSignals: ['Waist trend', 'Weekly average weight', 'Strength trend', 'Progress photos'],
    caveat: cfg.caveat,
    timelineWeeks,
  };
}
