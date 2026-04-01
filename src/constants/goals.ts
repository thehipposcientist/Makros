import { GoalOption, PaceOption, GoalPace, Goal } from '../types';

export const GOAL_OPTIONS: GoalOption[] = [
  { value: 'fat_loss',             icon: '🔥', label: 'Lose Weight',           description: 'Burn fat through a calorie deficit' },
  { value: 'muscle_gain',          icon: '💪', label: 'Build Muscle',           description: 'Gain size and mass with a calorie surplus' },
  { value: 'body_recomp',          icon: '⚖️', label: 'Body Recomposition',     description: 'Lose fat and build muscle simultaneously' },
  { value: 'strength',             icon: '🏋️', label: 'Build Strength',         description: 'Increase your 1-rep maxes and raw power' },
  { value: 'toning',               icon: '✨', label: 'Tone & Define',           description: 'Lean out and sculpt visible definition' },
  { value: 'endurance',            icon: '🏃', label: 'Improve Endurance',      description: 'Run longer, recover faster, build stamina' },
  { value: 'athletic_performance', icon: '⚡', label: 'Athletic Performance',   description: 'Speed, power, and sport-specific fitness' },
  { value: 'maintain',             icon: '🎯', label: 'Maintain & Stay Active', description: 'Keep your fitness level and stay healthy' },
  { value: 'flexibility',          icon: '🧘', label: 'Flexibility & Mobility', description: 'Improve range of motion, reduce injury risk' },
  { value: 'stress_relief',        icon: '🌿', label: 'Mental Wellness',        description: 'Use movement to manage stress and mood' },
];

// Goals that show target weight + pace
export const WEIGHT_GOALS = new Set<Goal>(['fat_loss', 'toning', 'muscle_gain']);
// Goals that show timeline cards only
export const TIMELINE_GOALS = new Set<Goal>(['body_recomp', 'strength', 'endurance', 'athletic_performance']);
// Goals with no details step
export const LIFESTYLE_GOALS = new Set<Goal>(['maintain', 'flexibility', 'stress_relief']);

export const PACE_OPTIONS: Record<string, PaceOption[]> = {
  fat_loss: [
    { value: 'conservative', icon: '🐢', label: 'Slow & Steady', rate: '~0.5 lbs/week',  description: 'Sustainable, preserves muscle mass' },
    { value: 'moderate',     icon: '🚶', label: 'Balanced',      rate: '~1 lb/week',    description: 'Recommended for most people' },
    { value: 'aggressive',   icon: '🚀', label: 'Aggressive',    rate: '~1.5 lbs/week', description: 'Fastest results, more discipline needed' },
  ],
  toning: [
    { value: 'conservative', icon: '🐢', label: 'Gentle Cut',    rate: '~0.5 lbs/week',  description: 'Slow lean-out, very sustainable' },
    { value: 'moderate',     icon: '🚶', label: 'Steady Cut',    rate: '~0.75 lbs/week', description: 'Good balance of speed and comfort' },
    { value: 'aggressive',   icon: '🚀', label: 'Fast Cut',      rate: '~1 lb/week',     description: 'Quicker definition, stricter diet' },
  ],
  muscle_gain: [
    { value: 'conservative', icon: '🌱', label: 'Lean Bulk',       rate: '~0.25 lbs/week', description: 'Minimal fat gain, slow and clean' },
    { value: 'moderate',     icon: '💪', label: 'Standard Bulk',   rate: '~0.5 lbs/week',  description: 'Best balance of muscle vs fat' },
    { value: 'aggressive',   icon: '🦣', label: 'Aggressive Bulk', rate: '~1 lb/week',     description: 'Maximum muscle, expect some fat' },
  ],
  body_recomp: [
    { value: 'conservative', icon: '📅', label: '3 Months', rate: '12 weeks', description: 'Short commitment, build the habit' },
    { value: 'moderate',     icon: '🗓️', label: '6 Months', rate: '24 weeks', description: 'See significant visual changes' },
    { value: 'aggressive',   icon: '🏆', label: '1 Year',   rate: '52 weeks', description: 'Full body transformation' },
  ],
  strength: [
    { value: 'conservative', icon: '📅', label: '4 Weeks',  rate: '1 cycle',   description: 'Intro program to build base strength' },
    { value: 'moderate',     icon: '🗓️', label: '12 Weeks', rate: '1 program', description: 'Standard powerlifting block' },
    { value: 'aggressive',   icon: '🏆', label: '6 Months', rate: '2 blocks',  description: 'Long-term strength development' },
  ],
  endurance: [
    { value: 'conservative', icon: '📅', label: '4 Weeks',  rate: 'Intro',      description: 'Build aerobic base and consistency' },
    { value: 'moderate',     icon: '🗓️', label: '8 Weeks',  rate: 'Develop',    description: 'Noticeable improvement in stamina' },
    { value: 'aggressive',   icon: '🏆', label: '16 Weeks', rate: 'Race-ready', description: 'Train for a 10K or half marathon' },
  ],
  athletic_performance: [
    { value: 'conservative', icon: '📅', label: '4 Weeks',  rate: 'Foundation',  description: 'Movement quality and injury prevention' },
    { value: 'moderate',     icon: '🗓️', label: '12 Weeks', rate: 'Performance', description: 'Measurable sport-specific gains' },
    { value: 'aggressive',   icon: '🏆', label: '6 Months', rate: 'Elite',       description: 'Peak athletic conditioning' },
  ],
};

export const TIMELINE_WEEKS: Record<Goal, Record<GoalPace, number>> = {
  body_recomp:          { conservative: 12, moderate: 24, aggressive: 52 },
  strength:             { conservative: 4,  moderate: 12, aggressive: 26 },
  endurance:            { conservative: 4,  moderate: 8,  aggressive: 16 },
  athletic_performance: { conservative: 4,  moderate: 12, aggressive: 26 },
  fat_loss:             { conservative: 0,  moderate: 0,  aggressive: 0  },
  toning:               { conservative: 0,  moderate: 0,  aggressive: 0  },
  muscle_gain:          { conservative: 0,  moderate: 0,  aggressive: 0  },
  maintain:             { conservative: 0,  moderate: 0,  aggressive: 0  },
  flexibility:          { conservative: 0,  moderate: 0,  aggressive: 0  },
  stress_relief:        { conservative: 0,  moderate: 0,  aggressive: 0  },
};

export const GOAL_LABEL: Record<Goal, string> = Object.fromEntries(
  GOAL_OPTIONS.map(g => [g.value, g.label])
) as Record<Goal, string>;
