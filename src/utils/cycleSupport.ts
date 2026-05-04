import type { WorkoutDay } from '../types';

export type CycleFlow = 'unspecified' | 'light' | 'moderate' | 'heavy';
export type CycleCramps = 'none' | 'mild' | 'moderate' | 'severe';
export type CycleEnergy = 'low' | 'normal' | 'high';
export type CycleTrainingAction = 'keep' | 'lighter' | 'recovery';

export interface PeriodSymptomLog {
  date: string;
  cycleStartDate: string;
  phase: 'menses' | 'follicular' | 'ovulation' | 'luteal' | 'unknown';
  dayOfCycle: number | null;
  cycleLengthDays: number | null;
  flow: CycleFlow;
  cramps: CycleCramps;
  energy: CycleEnergy;
  action?: CycleTrainingAction | null;
  updatedAt: string;
}

export interface CycleSupportInput {
  phase: PeriodSymptomLog['phase'];
  dayOfCycle?: number | null;
  cycleLengthDays?: number | null;
  flow?: CycleFlow | null;
  cramps?: CycleCramps | null;
  energy?: CycleEnergy | null;
}

export interface NutritionNudge {
  title: string;
  detail: string;
  icon: string;
}

export interface CycleSupportGuidance {
  phaseTitle: string;
  phaseDetail: string;
  trainingAction: CycleTrainingAction;
  trainingTitle: string;
  trainingDetail: string;
  nutrition: NutritionNudge[];
  safety: string[];
}

export function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function dateFromKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1);
}

export function cycleStartDateForLog(dateKey: string, dayOfCycle: number | null | undefined): string {
  const date = dateFromKey(dateKey);
  const offset = Math.max(0, (dayOfCycle ?? 1) - 1);
  date.setDate(date.getDate() - offset);
  return formatLocalDate(date);
}

export function plannedSetTotal(workout: WorkoutDay | null | undefined): number {
  return (workout?.exercises ?? []).reduce((sum, ex) => sum + Math.max(0, Number(ex.sets) || 0), 0);
}

function recommendedTrainingAction(input: CycleSupportInput): CycleTrainingAction {
  const flow = input.flow === 'unspecified' ? 'moderate' : input.flow ?? 'moderate';
  const cramps = input.cramps ?? 'mild';
  const energy = input.energy ?? 'normal';

  if (input.phase === 'menses') {
    if (cramps === 'severe' || (flow === 'heavy' && energy === 'low')) return 'recovery';
    if (flow === 'heavy' || cramps === 'moderate' || energy === 'low') return 'lighter';
    return 'keep';
  }

  if (input.phase === 'luteal' && energy === 'low') return 'lighter';
  return 'keep';
}

export function buildCycleSupportGuidance(input: CycleSupportInput): CycleSupportGuidance {
  const action = recommendedTrainingAction(input);
  const flow = input.flow === 'unspecified' ? 'moderate' : input.flow ?? 'moderate';
  const cramps = input.cramps ?? 'mild';
  const energy = input.energy ?? 'normal';

  const phase = input.phase ?? 'unknown';
  const dayCopy = input.dayOfCycle && input.dayOfCycle > 0 ? `day ${input.dayOfCycle}` : 'today';

  const phaseCopy: Record<CycleSupportInput['phase'], Pick<CycleSupportGuidance, 'phaseTitle' | 'phaseDetail'>> = {
    menses: {
      phaseTitle: 'Period phase',
      phaseDetail: `This is ${dayCopy} of the cycle. Keep the plan flexible and let symptoms decide how hard to push.`,
    },
    follicular: {
      phaseTitle: 'Follicular phase',
      phaseDetail: `This is ${dayCopy} of the cycle. Many people tolerate normal training well here, especially as bleeding has ended.`,
    },
    ovulation: {
      phaseTitle: 'Ovulation window',
      phaseDetail: `This is ${dayCopy} of the cycle. Higher-output work can fit if sleep, soreness, and joints feel good.`,
    },
    luteal: {
      phaseTitle: 'Luteal phase',
      phaseDetail: `This is ${dayCopy} of the cycle. Pacing, sleep, hydration, and steady fueling usually matter more here.`,
    },
    unknown: {
      phaseTitle: 'Cycle phase',
      phaseDetail: 'Apple Health cycle data is not clear enough today, so use general recovery signals.',
    },
  };

  const mensesTrainingCopy: Record<CycleTrainingAction, Pick<CycleSupportGuidance, 'trainingTitle' | 'trainingDetail'>> = {
    keep: {
      trainingTitle: 'Keep the plan, leave room to downshift',
      trainingDetail: 'Start with the planned session, keep warm-ups honest, and stop short of grindy sets if cramps, flow, or energy shift.',
    },
    lighter: {
      trainingTitle: 'Bias lower volume today',
      trainingDetail: 'Trim working sets, keep RPE around 6-7, and choose cleaner reps over load. You still get the movement pattern without forcing intensity.',
    },
    recovery: {
      trainingTitle: 'Choose recovery today',
      trainingDetail: 'A walk, gentle mobility, or full rest makes sense when cramps, heavy flow, or low energy are taking the lead.',
    },
  };

  let trainingTitle = mensesTrainingCopy[action].trainingTitle;
  let trainingDetail = mensesTrainingCopy[action].trainingDetail;

  if (phase === 'follicular') {
    trainingTitle = 'Build normally if readiness is good';
    trainingDetail = 'This is a good place for normal progression, skill practice, and the planned volume as long as recovery markers agree.';
  } else if (phase === 'ovulation') {
    trainingTitle = 'Harder efforts can fit';
    trainingDetail = 'If you feel sharp, the planned intensity is reasonable. Warm up fully and keep form standards high.';
  } else if (phase === 'luteal') {
    trainingTitle = energy === 'low' ? 'Keep intensity in reserve' : 'Pace the session';
    trainingDetail = energy === 'low'
      ? 'Hold back one notch, extend rests, and avoid turning accessories into max-effort work.'
      : 'Run the plan, but protect sleep, hydration, and recovery between sessions.';
  }

  let nutrition: NutritionNudge[] = [
    {
      title: 'Iron plus vitamin C',
      detail: 'Build one meal around iron-rich food, then pair it with citrus, berries, peppers, or another vitamin C source.',
      icon: 'nutrition-outline',
    },
    {
      title: 'Keep protein steady',
      detail: 'Do not cut protein just because training is lighter. It still supports recovery and satiety.',
      icon: 'restaurant-outline',
    },
    {
      title: 'Magnesium-rich foods',
      detail: 'Nuts, seeds, legumes, leafy greens, and whole grains are useful choices when cramps or sleep feel worse.',
      icon: 'leaf-outline',
    },
  ];

  if (phase === 'follicular') {
    nutrition = [
      {
        title: 'Protein at each meal',
        detail: 'Keep protein steady so the week can support harder training and normal progression.',
        icon: 'restaurant-outline',
      },
      {
        title: 'Carbs around training',
        detail: 'Use fruit, grains, potatoes, rice, or similar easy carbs near sessions that need more output.',
        icon: 'flash-outline',
      },
      {
        title: 'Colorful plants',
        detail: 'Aim for a few bright produce choices across the day to cover micronutrients without overthinking it.',
        icon: 'leaf-outline',
      },
    ];
  } else if (phase === 'ovulation') {
    nutrition = [
      {
        title: 'Fuel the harder work',
        detail: 'If the session is intense, do not go in under-fueled. Pair easy carbs with protein beforehand.',
        icon: 'flash-outline',
      },
      {
        title: 'Hydration check',
        detail: 'A normal fluid and electrolyte baseline helps high-output sessions feel less spiky.',
        icon: 'water-outline',
      },
      {
        title: 'Recovery meal',
        detail: 'After training, get protein plus carbs instead of waiting until appetite catches up.',
        icon: 'restaurant-outline',
      },
    ];
  } else if (phase === 'luteal') {
    nutrition = [
      {
        title: 'Steady meals',
        detail: 'Protein, fiber-rich carbs, and fluids help keep energy more even when cravings or fatigue rise.',
        icon: 'restaurant-outline',
      },
      {
        title: 'Magnesium-rich foods',
        detail: 'Nuts, seeds, legumes, leafy greens, and whole grains are useful choices when sleep or cramps feel worse.',
        icon: 'leaf-outline',
      },
      {
        title: 'Carbs before training',
        detail: 'A carb-forward meal or snack can make sessions feel less flat in the late cycle.',
        icon: 'flash-outline',
      },
    ];
  }

  if (phase === 'menses' && flow === 'heavy') {
    nutrition.unshift({
      title: 'Hydration and electrolytes',
      detail: 'Add fluids and a salty meal or electrolyte source, especially if flow is heavy or energy feels flat.',
      icon: 'water-outline',
    });
  }

  if (phase === 'menses' && energy === 'low') {
    nutrition.push({
      title: 'Carb-forward pre-workout',
      detail: 'If you train, bias the previous meal toward easy carbs plus protein instead of going in under-fueled.',
      icon: 'flash-outline',
    });
  }

  const safety: string[] = [];
  if (phase === 'menses' && (input.dayOfCycle ?? 0) > 7) {
    safety.push('Bleeding longer than 7 days is worth checking with a clinician, especially if it is new for you.');
  }
  if ((input.cycleLengthDays ?? 0) >= 36) {
    safety.push('This estimated cycle length is on the longer end. If it is normal for you, no action is needed; if it is new, irregular, or pregnancy is possible, consider checking in with a clinician.');
  } else if ((input.cycleLengthDays ?? 99) < 24) {
    safety.push('This estimated cycle length is shorter than usual adult ranges. If that is new or irregular, consider checking in with a clinician.');
  }
  if (flow === 'heavy') {
    safety.push('If heavy flow means soaking protection about hourly, passing large clots, dizziness, or fainting, seek medical guidance.');
  }
  if (cramps === 'severe') {
    safety.push('Severe, new, one-sided, or worsening pain should be medical guidance territory, not just a training adjustment.');
  }

  return {
    phaseTitle: phaseCopy[phase].phaseTitle,
    phaseDetail: phaseCopy[phase].phaseDetail,
    trainingAction: action,
    trainingTitle,
    trainingDetail,
    nutrition,
    safety,
  };
}

export function upsertPeriodSymptomLog(
  logs: PeriodSymptomLog[],
  nextLog: PeriodSymptomLog,
): PeriodSymptomLog[] {
  const withoutSameDate = logs.filter(log => log.date !== nextLog.date);
  return [...withoutSameDate, nextLog].sort((a, b) => a.date.localeCompare(b.date));
}

export function trimPeriodSymptomLogs(
  logs: PeriodSymptomLog[],
  todayKey: string,
  maxAgeDays = 240,
): PeriodSymptomLog[] {
  const cutoff = dateFromKey(todayKey);
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  return logs
    .filter(log => dateFromKey(log.date).getTime() >= cutoff.getTime())
    .slice(-120);
}

export function summarizeCyclePattern(
  logs: PeriodSymptomLog[],
  currentCycleStartDate: string,
): string | null {
  const prior = logs.filter(log => log.cycleStartDate !== currentCycleStartDate);
  const cycleStarts = Array.from(new Set(prior.map(log => log.cycleStartDate)));
  if (cycleStarts.length < 2) return null;

  const earlyLogs = prior.filter(log => (log.dayOfCycle ?? 99) <= 2);
  if (earlyLogs.length < 2) return null;

  const highSymptomLogs = earlyLogs.filter(log =>
    log.flow === 'heavy' || log.cramps === 'severe' || log.energy === 'low',
  );
  const adjustedLogs = earlyLogs.filter(log => log.action === 'lighter' || log.action === 'recovery');

  if (adjustedLogs.length >= 2) {
    return `Across ${cycleStarts.length} prior cycles, you often chose a lighter or recovery day early in your period. Starting with that option may fit your pattern.`;
  }
  if (highSymptomLogs.length >= Math.ceil(earlyLogs.length / 2)) {
    return `Your first two period days often look higher-symptom across ${cycleStarts.length} prior cycles. Consider lighter volume before symptoms force the issue.`;
  }
  return null;
}

function lighterTargetWeight(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.max(0, Math.round((value * 0.9) / 5) * 5);
}

export function reduceWorkoutForCycleSymptoms(workout: WorkoutDay): WorkoutDay {
  return {
    ...workout,
    _source_context: 'period_lighter_day',
    exercises: workout.exercises.map(ex => {
      const currentSets = Math.max(1, Number(ex.sets) || 3);
      const nextSets = currentSets >= 4 ? currentSets - 2 : currentSets >= 2 ? currentSets - 1 : currentSets;
      const next: typeof ex = {
        ...ex,
        sets: Math.max(1, nextSets),
        restSeconds: Math.max(Number(ex.restSeconds) || 60, 90),
      };

      const lighterWeight = lighterTargetWeight(ex.targetWeightLbs);
      if (lighterWeight != null) next.targetWeightLbs = lighterWeight;

      if (Array.isArray(ex.setScheme)) {
        next.setScheme = ex.setScheme.slice(0, next.sets).map(set => ({
          ...set,
          targetRir: Math.min(5, Math.max(0, Number(set.targetRir) + 1)),
          targetWeightLbs: lighterTargetWeight(set.targetWeightLbs),
        }));
      }

      return next;
    }),
  };
}
