import type { Glp1SupportSettings } from '../types';
import type { PreparednessResult } from '../services/preparedness';

export type TodayReadinessDecisionKind =
  | 'train'
  | 'cap_intensity'
  | 'fuel_first'
  | 'lighten'
  | 'recovery'
  | 'recover_post_workout'
  | 'needs_signals';

export type TodayReadinessDecisionTone = 'good' | 'caution' | 'warning' | 'danger' | 'neutral';

export interface TodayReadinessDecision {
  kind: TodayReadinessDecisionKind;
  tone: TodayReadinessDecisionTone;
  iconName: string;
  title: string;
  action: string;
  detail: string;
  chips: string[];
  watchSummary: string;
}

export interface TodayReadinessDecisionInput {
  score: number;
  label?: PreparednessResult['label'] | string;
  pillars?: Partial<PreparednessResult['pillars']>;
  missing?: string[];
  signalsPresent?: number;
  signalsTotal?: number;
  todaysFocus?: string | null;
  workoutDone?: boolean;
  hasAppleHealth?: boolean;
  glp1Support?: Glp1SupportSettings | null;
}

function titleCaseFocus(focus?: string | null): string | null {
  if (!focus) return null;
  const clean = focus.replace(/[_-]/g, ' ').trim();
  if (!clean) return null;
  return clean.replace(/\b\w/g, c => c.toUpperCase());
}

function sideEffects(glp1Support?: Glp1SupportSettings | null): string[] {
  return glp1Support?.enabled ? (glp1Support.sideEffects ?? []) : [];
}

function hasNutritionSignal(input: TodayReadinessDecisionInput): boolean {
  return !(input.missing ?? []).includes('nutrition') && input.pillars?.nutrition != null;
}

function nutritionLooksLow(input: TodayReadinessDecisionInput): boolean {
  if (!hasNutritionSignal(input)) return false;
  return Number(input.pillars?.nutrition ?? 0) <= 7;
}

function recoveryLooksLow(input: TodayReadinessDecisionInput): boolean {
  const fatigue = input.pillars?.fatigue;
  return fatigue != null && Number(fatigue) <= 9;
}

function appendGlp1Chips(chips: string[], glp1Support?: Glp1SupportSettings | null): string[] {
  if (!glp1Support?.enabled) return chips;
  const next = [...chips];
  const effects = sideEffects(glp1Support);
  if (glp1Support.appetite === 'very_low' || effects.includes('low_appetite')) {
    next.push('Small portions');
  }
  if (effects.some(e => e === 'nausea' || e === 'reflux' || e === 'constipation')) {
    next.push('GI-friendly');
  }
  if (!next.includes('Hydration')) next.push('Hydration');
  return Array.from(new Set(next)).slice(0, 4);
}

export function buildTodayReadinessDecision(input: TodayReadinessDecisionInput): TodayReadinessDecision {
  const score = Math.max(0, Math.min(100, Math.round(Number(input.score) || 0)));
  const focus = titleCaseFocus(input.todaysFocus);
  const signalText = input.signalsTotal
    ? `${input.signalsPresent ?? 0}/${input.signalsTotal} signals`
    : null;
  const glp1 = input.glp1Support?.enabled === true;
  const glp1LowAppetite = glp1 && (
    input.glp1Support?.appetite === 'very_low'
    || sideEffects(input.glp1Support).includes('low_appetite')
  );
  const giSymptoms = sideEffects(input.glp1Support).some(e =>
    e === 'nausea' || e === 'constipation' || e === 'reflux'
  );

  if ((input.signalsPresent ?? 0) <= 0 || input.label === '—') {
    return {
      kind: 'needs_signals',
      tone: 'neutral',
      iconName: 'pulse-outline',
      title: 'Add recovery signals',
      action: input.hasAppleHealth ? 'Log meals and let health data sync.' : 'Connect health data or log meals.',
      detail: 'The plan still works, but the daily decision gets sharper with sleep, HRV, meal, and workout data.',
      chips: [signalText ?? 'No signals yet'].filter(Boolean),
      watchSummary: 'Add recovery signals for a sharper readiness decision.',
    };
  }

  if (input.workoutDone) {
    const chips = appendGlp1Chips(['Protein', 'Fluids', 'Sleep'], input.glp1Support);
    return {
      kind: 'recover_post_workout',
      tone: 'good',
      iconName: 'checkmark-circle-outline',
      title: 'Recover and refuel',
      action: glp1LowAppetite ? 'Use a small protein-first meal and fluids.' : 'Protein, fluids, and sleep tonight.',
      detail: 'Today\'s training decision is complete. The best move now is preserving tomorrow\'s readiness with recovery basics.',
      chips,
      watchSummary: glp1LowAppetite
        ? 'Workout done. Small protein-first meal, fluids, then sleep.'
        : 'Workout done. Protein, fluids, and sleep support recovery.',
    };
  }

  if (nutritionLooksLow(input) || (glp1LowAppetite && score < 70)) {
    const chips = appendGlp1Chips(['Protein first', 'Easy carbs'], input.glp1Support);
    return {
      kind: 'fuel_first',
      tone: 'caution',
      iconName: 'restaurant-outline',
      title: 'Fuel first',
      action: glp1
        ? 'Small protein-first meal, fluids, then train.'
        : 'Protein and easy carbs before training.',
      detail: glp1
        ? 'Low intake can make a normal workout feel harder. Keep portions tolerable, prioritize protein, and lower volume if food or fluids are not sitting well.'
        : 'Nutrition is the soft spot today. Eat first, then start with a conservative first set and build only if you feel good.',
      chips,
      watchSummary: glp1
        ? 'Fuel first: small protein-first meal, fluids, then train.'
        : 'Fuel first: protein and easy carbs before training.',
    };
  }

  if (score >= 65) {
    const chips = appendGlp1Chips([focus ? `${focus} focus` : 'Planned focus', signalText ?? 'Signals ready'], input.glp1Support);
    return {
      kind: 'train',
      tone: 'good',
      iconName: 'flash-outline',
      title: 'Train as planned',
      action: recoveryLooksLow(input) ? 'Warm up, then watch the first work set.' : 'Run today\'s session normally.',
      detail: recoveryLooksLow(input)
        ? 'Overall readiness is solid, but local muscle recovery is not perfect. Let the first working set decide whether to push.'
        : 'Your available signals support the planned workout. Use normal progression and stop chasing intensity if form degrades.',
      chips,
      watchSummary: 'Train as planned. Readiness supports today\'s session.',
    };
  }

  if (score >= 45) {
    const chips = appendGlp1Chips(['Cap intensity', 'No max efforts', focus ? `${focus} focus` : 'Planned focus'], input.glp1Support);
    return {
      kind: 'cap_intensity',
      tone: 'caution',
      iconName: 'speedometer-outline',
      title: 'Train, cap intensity',
      action: 'Keep hard sets around RPE 7.',
      detail: 'You can train today, but keep the ceiling lower: longer warmup, no grinders, and leave a rep or two more than usual.',
      chips,
      watchSummary: 'Train, but cap intensity around RPE 7 today.',
    };
  }

  if (score >= 30) {
    const chips = appendGlp1Chips(['Reduce sets', 'Technique reps', 'Easy cardio'], input.glp1Support);
    return {
      kind: 'lighten',
      tone: 'warning',
      iconName: 'options-outline',
      title: 'Lighten today',
      action: 'Cut volume or use a recovery swap.',
      detail: 'Readiness is low enough that the goal is consistency, not overload. Keep the habit, reduce the cost.',
      chips,
      watchSummary: 'Lighten today. Reduce volume or use a recovery swap.',
    };
  }

  const chips = appendGlp1Chips(['Recovery', 'Mobility', 'Walk'], input.glp1Support);
  return {
    kind: 'recovery',
    tone: 'danger',
    iconName: 'bed-outline',
    title: 'Recovery fits better',
    action: 'Choose mobility, walking, or rest.',
    detail: giSymptoms
      ? 'Recovery is the better choice today. If severe or persistent GI symptoms, dehydration signs, or unusual pain are present, contact your clinician.'
      : 'Your signals are stacked against hard training. Protect the week by keeping today easy and rebuilding tomorrow.',
    chips,
    watchSummary: 'Recovery fits better today. Keep it easy.',
  };
}
