const CARDIO_MET: Record<string, number> = {
  walk: 3.3,
  walking: 3.3,
  run: 9.0,
  running: 9.0,
  ride: 6.8,
  cycling: 6.8,
  bike: 6.8,
  spin: 7.8,
  hike: 6.0,
  hiking: 6.0,
  swim: 6.0,
  swimming: 6.0,
  row: 7.0,
  rowing: 7.0,
  stair: 8.0,
  elliptical: 5.0,
  bootcamp: 8.0,
  hiit: 8.0,
};

const SPORT_MET: Record<string, number> = {
  basketball: 6.5,
  soccer: 7.0,
  tennis: 5.5,
  pickleball: 4.5,
  volleyball: 4.0,
  beach_volleyball: 6.0,
  golf: 3.5,
  climbing: 6.0,
  boxing: 7.8,
  kickboxing: 7.8,
  martial_arts: 7.0,
  skiing: 6.0,
  surfing: 3.5,
};

const ACTIVE_MET: Record<string, number> = {
  yard_work: 4.0,
  gardening: 3.5,
  cleaning: 3.3,
  moving: 5.5,
  construction: 4.5,
  chopping_wood: 6.0,
  shoveling: 5.5,
  playing: 4.0,
  dancing: 5.0,
};

const MOBILITY_MET: Record<string, number> = {
  yoga: 2.5,
  stretching: 2.0,
  foam_roll: 2.0,
  pilates: 3.0,
};

const LB_TO_KG = 0.45359237;

export interface ActivityCalorieEstimateDetails {
  calories: number;
  confidence: 'low' | 'medium';
  source: 'met_bodyweight_duration_distance';
  met: number;
}

function norm(value?: string | null): string {
  return String(value ?? '').trim().toLowerCase().replace(/[ -]+/g, '_');
}

function intensityFactor(intensity?: string | null): number {
  const value = norm(intensity);
  if (value === 'easy') return 0.85;
  if (value === 'hard') return 1.15;
  return 1.0;
}

function cardioStyleFactor(style?: string | null): number {
  const value = norm(style);
  if (value === 'recovery' || value === 'easy') return 0.8;
  if (value === 'intervals') return 1.12;
  if (value === 'class') return 1.05;
  return 1.0;
}

function baseMet(category?: string | null, subtype?: string | null): number | null {
  const cat = norm(category);
  const sub = norm(subtype);
  if (cat === 'cardio') return CARDIO_MET[sub] ?? 5.5;
  if (cat === 'strength') return 4.0;
  if (cat === 'sport') return SPORT_MET[sub] ?? 5.5;
  if (cat === 'active') return ACTIVE_MET[sub] ?? 3.8;
  if (cat === 'mobility') return MOBILITY_MET[sub] ?? 2.5;
  if (cat === 'recovery') return sub === 'walk' || sub === 'walking' ? 2.5 : null;
  return null;
}

export function estimateActivityCalories({
  durationSeconds,
  weightLbs,
  category,
  subtype,
  intensity,
  cardioStyle,
}: {
  durationSeconds?: number | null;
  weightLbs?: number | null;
  category?: string | null;
  subtype?: string | null;
  intensity?: string | null;
  cardioStyle?: string | null;
}): number | null {
  const minutes = Math.max(0, Number(durationSeconds ?? 0) / 60);
  const weight = Number(weightLbs ?? 0);
  if (minutes < 1 || !Number.isFinite(weight) || weight <= 0) return null;

  let met = baseMet(category, subtype);
  if (met == null) return null;

  const cat = norm(category);
  if (cat === 'cardio' || cat === 'sport') met *= cardioStyleFactor(cardioStyle);
  met *= intensityFactor(intensity);
  met = Math.max(1.5, Math.min(12.0, met));

  const weightKg = weight / 2.2046226218;
  const kcal = met * 3.5 * weightKg / 200.0 * minutes;
  if (kcal < 10) return null;
  return Math.round(kcal);
}

function numeric(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function walkingMet(speedMph: number | null): number {
  if (speedMph == null || speedMph <= 0) return 3.2;
  if (speedMph < 2) return 2.3;
  if (speedMph < 2.8) return 2.9;
  if (speedMph < 3.5) return 3.5;
  if (speedMph < 4.1) return 4.3;
  return 5.0;
}

function runningMet(speedMph: number | null): number {
  if (speedMph == null || speedMph <= 0) return 8.3;
  if (speedMph < 5) return 6.2;
  if (speedMph < 6) return 8.3;
  if (speedMph < 7) return 9.8;
  if (speedMph < 8) return 11.0;
  return 12.5;
}

function detailedMet(category?: string | null, subtype?: string | null, speedMph?: number | null, cardioStyle?: string | null): number | null {
  const cat = norm(category);
  const sub = norm(subtype);
  const style = norm(cardioStyle);
  if (sub === 'walk' || sub === 'walking') return walkingMet(speedMph ?? null);
  if (sub === 'run' || sub === 'running') return runningMet(speedMph ?? null);
  if (sub === 'hike' || sub === 'hiking') return speedMph != null && speedMph < 2.2 ? 5.3 : 6.0;
  if (sub === 'ride' || sub === 'cycling' || sub === 'bike') return speedMph != null && speedMph >= 14 ? 8.0 : 6.0;
  if (sub === 'spin') return style === 'class' ? 7.2 : 6.8;
  if (sub === 'row' || sub === 'rowing') return style === 'intervals' ? 8.5 : 7.0;
  if (sub === 'swim' || sub === 'swimming') return 7.0;
  if (sub === 'stair') return 8.0;
  if (sub === 'elliptical') return 5.5;
  if (sub === 'hiit' || sub === 'bootcamp') return 8.0;
  if (sub === 'other') return 5.0;
  return baseMet(cat, sub);
}

export function estimateActivityCaloriesDetailed({
  category,
  subtype,
  durationMinutes,
  durationSeconds,
  bodyweightLbs,
  weightLbs,
  distanceMiles,
  elevationGainFt,
  intensity,
  cardioStyle,
}: {
  category?: string | null;
  subtype?: string | null;
  durationMinutes?: number | null;
  durationSeconds?: number | null;
  bodyweightLbs?: number | null;
  weightLbs?: number | null;
  distanceMiles?: number | null;
  elevationGainFt?: number | null;
  intensity?: string | null;
  cardioStyle?: string | null;
}): ActivityCalorieEstimateDetails | null {
  const minutes = numeric(durationMinutes) ?? ((numeric(durationSeconds) ?? 0) / 60);
  if (minutes <= 0) return null;
  const cat = norm(category);
  const sub = norm(subtype);
  if (cat !== 'cardio' && !(cat === 'recovery' && (sub === 'walk' || sub === 'walking'))) return null;
  if (!sub) return null;

  const distance = numeric(distanceMiles);
  const speedMph = distance != null && distance > 0
    ? distance / Math.max(minutes / 60, 1 / 60)
    : null;
  let met = detailedMet(cat, sub, speedMph, cardioStyle);
  if (met == null) return null;

  const gainFt = Math.max(0, numeric(elevationGainFt) ?? 0);
  if ((sub === 'walk' || sub === 'walking' || sub === 'hike' || sub === 'hiking' || sub === 'run' || sub === 'running') && distance != null && distance > 0) {
    const gainPerMile = gainFt / distance;
    if (gainPerMile >= 250) met += 0.8;
    else if (gainPerMile >= 100) met += 0.35;
  }
  met *= intensityFactor(intensity);
  const style = norm(cardioStyle);
  if (style === 'recovery') met *= 0.8;
  else if (style === 'easy') met *= 0.9;
  else if (style === 'intervals') met *= 1.12;
  else if (style === 'class') met *= 1.05;
  met = Math.max(1.5, Math.min(12.5, met));

  const profileWeight = numeric(bodyweightLbs) ?? numeric(weightLbs);
  const bodyweightKg = Math.max(45, Math.min(150, (profileWeight ?? 165) * LB_TO_KG));
  const calories = Math.max(5, Math.round(met * bodyweightKg * (minutes / 60)));
  return {
    calories,
    confidence: distance != null && distance > 0 ? 'medium' : 'low',
    source: 'met_bodyweight_duration_distance',
    met: Math.round(met * 10) / 10,
  };
}
