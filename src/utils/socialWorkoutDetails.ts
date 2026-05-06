export type SocialWorkoutSet = {
  reps?: number | null;
  weight_lbs?: number | null;
  duration_seconds?: number | null;
  actual_distance?: number | null;
  actual_pace?: string | null;
  heart_rate_avg?: number | null;
  cardio_metrics?: Record<string, string | number | null | undefined> | null;
};

export type SocialWorkoutExercise = {
  name?: string | null;
  equipment?: string | null;
  sets?: SocialWorkoutSet[] | null;
};

const SENSITIVE_METRIC_KEYS = new Set([
  'calorie', 'calories', 'kcal', 'body_weight', 'body_weight_lbs',
  'body_fat', 'bodyfat', 'macros', 'protein', 'carbs', 'fat',
]);

const METRIC_LABELS: Record<string, string> = {
  speed: 'Speed',
  incline: 'Incline',
  pace: 'Pace',
  split: 'Split',
  spm: 'SPM',
  stroke_rate: 'SPM',
  distance: 'Distance',
  watts: 'Watts',
  cadence: 'Cadence',
  output: 'Output',
  laps: 'Laps',
  floors: 'Floors',
  level: 'Level',
  elevation: 'Elevation',
  resistance: 'Resistance',
  weight: 'Load',
  load: 'Load',
};

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function compactNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function formatSocialDuration(seconds: number | null | undefined): string {
  const sec = Math.max(0, Math.round(numeric(seconds) ?? 0));
  if (!sec) return '';
  const minutes = Math.floor(sec / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
}

export function formatSocialSetDuration(seconds: number | null | undefined): string {
  const sec = Math.max(0, Math.round(numeric(seconds) ?? 0));
  if (!sec) return '';
  if (sec < 60) return `${sec}s`;
  const minutes = Math.floor(sec / 60);
  const rem = sec % 60;
  if (minutes < 60) return `${minutes}:${String(rem).padStart(2, '0')}`;
  const hours = Math.floor(minutes / 60);
  const minutePart = minutes % 60;
  return `${hours}:${String(minutePart).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

export function formatSocialWeight(weightLbs: number | null | undefined): string {
  const weight = numeric(weightLbs);
  return weight && weight > 0 ? `${compactNumber(weight)} lb` : '';
}

export function formatSocialDistance(distance: number | null | undefined, unit = 'mi'): string {
  const value = numeric(distance);
  return value && value > 0 ? `${compactNumber(value)} ${unit}` : '';
}

function metricLabel(key: string): string {
  const normalized = key.trim().toLowerCase();
  if (METRIC_LABELS[normalized]) return METRIC_LABELS[normalized];
  return normalized
    .replace(/_/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

export function socialSetMetricParts(set: SocialWorkoutSet): string[] {
  const parts: string[] = [];
  const reps = numeric(set.reps);
  const weight = numeric(set.weight_lbs);
  if (weight && weight > 0 && reps && reps > 0) {
    parts.push(`${formatSocialWeight(weight)} x ${Math.round(reps)}`);
  } else if (reps && reps > 0) {
    parts.push(`${Math.round(reps)} rep${Math.round(reps) === 1 ? '' : 's'}`);
  }

  const duration = formatSocialSetDuration(set.duration_seconds);
  if (duration) parts.push(duration);

  const distance = formatSocialDistance(set.actual_distance);
  if (distance) parts.push(distance);

  const pace = typeof set.actual_pace === 'string' ? set.actual_pace.trim() : '';
  if (pace) parts.push(pace);

  const heartRate = numeric(set.heart_rate_avg);
  if (heartRate && heartRate > 0) parts.push(`${Math.round(heartRate)} bpm`);

  const metrics = set.cardio_metrics && typeof set.cardio_metrics === 'object' ? set.cardio_metrics : null;
  if (metrics) {
    for (const [rawKey, rawValue] of Object.entries(metrics)) {
      const key = rawKey.trim().toLowerCase();
      if (!key || SENSITIVE_METRIC_KEYS.has(key) || key.includes('calorie') || key.includes('body_')) continue;
      const value = String(rawValue ?? '').trim();
      if (!value || value.toLowerCase() === 'null' || value.toLowerCase() === 'undefined') continue;
      parts.push(`${metricLabel(key)} ${value}`);
    }
  }

  return parts;
}

export function formatSocialSetSummary(set: SocialWorkoutSet): string {
  const parts = socialSetMetricParts(set);
  return parts.length ? parts.join(' · ') : 'Logged set';
}

export function compactSocialSetSummaries(sets: SocialWorkoutSet[] | null | undefined): string[] {
  const labels = (sets ?? []).map(formatSocialSetSummary);
  if (!labels.length) return [];
  const groups: Array<{ label: string; count: number }> = [];
  for (const label of labels) {
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.count += 1;
    } else {
      groups.push({ label, count: 1 });
    }
  }
  return groups.map(group => {
    if (group.count === 1) return group.label;
    if (group.label === 'Logged set') return `${group.count} sets`;
    return `${group.count} sets · ${group.label}`;
  });
}

export function hasSocialSetMetrics(set: SocialWorkoutSet): boolean {
  return socialSetMetricParts(set).length > 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function workoutSummaryRecord(payload: unknown): Record<string, any> {
  if (!isRecord(payload)) return {};
  return isRecord(payload.workout_summary) ? payload.workout_summary : payload;
}

export function socialWorkoutExercises(payload: unknown): SocialWorkoutExercise[] {
  const summary = workoutSummaryRecord(payload);
  return Array.isArray(summary.exercises) ? summary.exercises : [];
}

export function socialWorkoutDetailScore(payload: unknown): number {
  const summary = workoutSummaryRecord(payload);
  const exercises = socialWorkoutExercises(payload);
  let score = exercises.length * 100;
  for (const exercise of exercises) {
    const sets = Array.isArray(exercise?.sets) ? exercise.sets : [];
    score += sets.length * 20;
    for (const set of sets) {
      if (!set || typeof set !== 'object') continue;
      score += socialSetMetricParts(set).length * 5;
      score += Object.keys(set).length > 0 ? 1 : 0;
    }
  }
  const totalSets = numeric(summary.total_sets);
  const totalReps = numeric(summary.total_reps);
  if (totalSets && totalSets > 0) score += Math.min(50, Math.round(totalSets));
  if (totalReps && totalReps > 0) score += Math.min(50, Math.round(totalReps / 5));
  return score;
}

function mergeWorkoutSummary(primaryPayload: unknown, detailPayload: unknown): Record<string, any> {
  const primarySummary = workoutSummaryRecord(primaryPayload);
  const detailSummary = workoutSummaryRecord(detailPayload);
  const merged = { ...detailSummary, ...primarySummary };
  const detailExercises = socialWorkoutExercises(detailPayload);
  if (detailExercises.length) merged.exercises = detailExercises;
  for (const key of ['total_sets', 'total_reps', 'duration_seconds', 'distance_miles', 'hr_summary']) {
    const primaryValue = primarySummary[key];
    const detailValue = detailSummary[key];
    if (
      (primaryValue == null || primaryValue === '' || primaryValue === 0)
      && detailValue != null
      && detailValue !== ''
    ) {
      merged[key] = detailValue;
    }
  }
  return merged;
}

export function mergeSocialWorkoutDetails<T extends { payload: any; event_type?: string }>(
  primary: T,
  detailSource: T,
): T {
  if (socialWorkoutDetailScore(primary.payload) >= socialWorkoutDetailScore(detailSource.payload)) {
    return primary;
  }
  const payload = isRecord(primary.payload) ? { ...primary.payload } : {};
  const mergedSummary = mergeWorkoutSummary(primary.payload, detailSource.payload);
  if (primary.event_type === 'workout_post' || isRecord(payload.workout_summary)) {
    payload.workout_summary = mergedSummary;
  } else {
    Object.assign(payload, mergedSummary);
  }
  return { ...primary, payload };
}

export function chooseSocialWorkoutFeedItem<T extends { payload: any; event_type?: string; id?: number }>(
  existing: T,
  candidate: T,
): T {
  const existingIsPost = existing.event_type === 'workout_post';
  const candidateIsPost = candidate.event_type === 'workout_post';

  if (candidateIsPost && !existingIsPost) return mergeSocialWorkoutDetails(candidate, existing);
  if (existingIsPost && !candidateIsPost) return mergeSocialWorkoutDetails(existing, candidate);

  const existingScore = socialWorkoutDetailScore(existing.payload);
  const candidateScore = socialWorkoutDetailScore(candidate.payload);
  if (candidateScore > existingScore) return candidate;
  if (existingScore > candidateScore) return existing;

  return Number(candidate.id ?? 0) > Number(existing.id ?? 0) ? candidate : existing;
}
