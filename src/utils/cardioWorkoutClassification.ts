export type CardioWorkoutKind = 'cardio' | 'mixed_cardio' | 'non_cardio';
export type CardioZoneSummarySource = 'heart_rate' | 'heuristic' | 'none';

export interface CardioWorkoutClassification {
  kind: CardioWorkoutKind;
  reason: string;
}

export interface CardioWorkoutZoneSummary {
  name: string;
  durationMin: number;
  cardioMinutes: number;
  zone2Minutes: number;
  counted: boolean;
  reason?: string;
  source: CardioZoneSummarySource;
}

const CARDIO_ACTIVITY_RX = /\b(?:run(?:ning)?|jog(?:ging)?|walk(?:ing)?|hike|hiking|bike|biking|cycl(?:e|ing)?|ride|riding|rower|rowing|swim(?:ming)?|elliptical|spin|stair(?:\s*(?:climber|climbing))?|cross\s*train(?:ing)?|cross-train(?:ing)?|cardio|aerobic|treadmill|dance|tennis|pickleball|volley(?:ball)?|paddle|soccer|basketball|box(?:ing)?|kickbox(?:ing)?|martial|hiit|boot\s*camp|boot-camp|intervals?|tabata|sprints?)\b/i;
const STRENGTH_ACTIVITY_RX = /\b(?:strength|weight(?:\s*training)?|lift(?:ing)?|barbell|dumbbell|kettlebell|resistance|powerlift(?:ing)?|bodybuild(?:ing)?|hypertrophy|push|pull|legs|upper|lower|full\s*body|full_body)\b/i;
const NON_CARDIO_ACTIVITY_RX = /\b(?:yoga|pilates|stretch|stretching|flexibility|mobility|core|recovery|mindful|breathwork|sauna|cold\s*plunge)\b/i;
const MIXED_STRENGTH_CARDIO_RX = /(?:\+\s*cardio|cardio\s*\+|cardio\s*finisher|conditioning\s*finisher|(?:strength|weight|lift|lifting|push|pull|legs|upper|lower|full\s*body|full_body).*cardio|cardio.*(?:strength|weight|lift|lifting|push|pull|legs|upper|lower|full\s*body|full_body))/i;
const NON_STEADY_CARDIO_RX = /\b(?:hiit|boot\s*camp|boot-camp|intervals?|tabata|sprints?)\b/i;
const STEADY_ZONE2_RX = /\b(?:zone\s*2|zone2|z2|steady|easy|recovery|aerobic\s*base|incline\s*walk)\b/i;

function workoutText(raw: unknown): string {
  return String(raw ?? '').trim();
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function positiveZoneMinutes(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const zones = raw.map(value => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  return zones.some(value => value > 0) ? zones : null;
}

export function classifyWorkoutCardioKind(rawName: unknown): CardioWorkoutClassification {
  const name = workoutText(rawName);
  if (!name) return { kind: 'non_cardio', reason: 'missing activity name' };

  const hasMixedCardio = MIXED_STRENGTH_CARDIO_RX.test(name);
  if (hasMixedCardio) return { kind: 'mixed_cardio', reason: 'mixed strength + cardio label' };

  const hasCardio = CARDIO_ACTIVITY_RX.test(name);
  const hasStrength = STRENGTH_ACTIVITY_RX.test(name);
  const hasNonCardio = NON_CARDIO_ACTIVITY_RX.test(name);

  if (hasCardio && !hasStrength && !hasNonCardio) {
    return { kind: 'cardio', reason: 'cardio activity label' };
  }
  if (hasCardio && hasStrength && !hasNonCardio) {
    return { kind: 'mixed_cardio', reason: 'mixed cardio + strength label' };
  }
  return { kind: 'non_cardio', reason: hasNonCardio || hasStrength ? 'not steady cardio' : 'not cardio' };
}

export function estimatedMixedCardioMinutes(durationMin: number): number {
  const duration = Math.max(0, Number(durationMin) || 0);
  if (duration <= 0) return 0;
  return Math.min(20, Math.max(10, duration * 0.25));
}

export function isHighIntensityCardioText(rawName: unknown): boolean {
  return NON_STEADY_CARDIO_RX.test(workoutText(rawName));
}

export function isSteadyZone2CardioText(rawName: unknown): boolean {
  const name = workoutText(rawName);
  return STEADY_ZONE2_RX.test(name) && !NON_STEADY_CARDIO_RX.test(name);
}

export function summarizeCardioWorkoutZones(input: {
  name: unknown;
  durationMin: number;
  zoneMinutes?: unknown;
}): CardioWorkoutZoneSummary | null {
  const durationMin = Math.max(0, Number(input.durationMin) || 0);
  if (durationMin <= 0) return null;

  const name = workoutText(input.name) || 'Workout';
  const classification = classifyWorkoutCardioKind(name);
  if (classification.kind === 'non_cardio') {
    return {
      name,
      durationMin,
      cardioMinutes: 0,
      zone2Minutes: 0,
      counted: false,
      reason: classification.reason,
      source: 'none',
    };
  }

  const cardioMinutes = classification.kind === 'mixed_cardio'
    ? estimatedMixedCardioMinutes(durationMin)
    : durationMin;
  const zones = positiveZoneMinutes(input.zoneMinutes);
  if (zones) {
    const actualZ2 = Math.max(0, Math.min(cardioMinutes, Number(zones[1] ?? 0) || 0));
    return {
      name,
      durationMin,
      cardioMinutes: roundTenth(cardioMinutes),
      zone2Minutes: roundTenth(actualZ2),
      counted: actualZ2 > 0,
      reason: actualZ2 > 0 ? 'HR zone data from cardio workout' : 'no Z2 HR time',
      source: 'heart_rate',
    };
  }

  if (isHighIntensityCardioText(name)) {
    return {
      name,
      durationMin,
      cardioMinutes: roundTenth(cardioMinutes),
      zone2Minutes: 0,
      counted: false,
      reason: 'high-intensity / excluded',
      source: 'heuristic',
    };
  }

  if (classification.kind === 'mixed_cardio') {
    const zone2Minutes = isSteadyZone2CardioText(name) ? cardioMinutes : 0;
    return {
      name,
      durationMin,
      cardioMinutes: roundTenth(cardioMinutes),
      zone2Minutes: roundTenth(zone2Minutes),
      counted: zone2Minutes > 0,
      reason: zone2Minutes > 0 ? 'mixed steady cardio estimate' : 'mixed cardio estimate',
      source: 'heuristic',
    };
  }

  if (durationMin < 20) {
    return {
      name,
      durationMin,
      cardioMinutes: roundTenth(cardioMinutes),
      zone2Minutes: 0,
      counted: false,
      reason: 'under 20 min',
      source: 'heuristic',
    };
  }

  return {
    name,
    durationMin,
    cardioMinutes: roundTenth(cardioMinutes),
    zone2Minutes: roundTenth(cardioMinutes),
    counted: true,
    reason: 'steady cardio >= 20 min',
    source: 'heuristic',
  };
}
