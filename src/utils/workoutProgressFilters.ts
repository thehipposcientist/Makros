import type { WorkoutSession, SessionExercise, CompletedSet } from '../types';

export type ExerciseTrendPoint = {
  label: string;
  bestWeight: number;
  volume: number;
  totalDuration: number;
};

export type E1RMTrendPoint = {
  date: string;
  e1rm_lbs: number;
  confidence: string;
  sample_count: number;
};

export type StrengthTrendRow = {
  name: string;
  primaryMuscle: string | null;
  currentE1RM: number;
  priorE1RM: number | null;
  deltaLbs: number | null;
  deltaPct: number | null;
  currentDate: string;
  priorDate: string | null;
  currentSampleCount: number;
  priorSampleCount: number | null;
};

export type StrengthTrendSummary = {
  rows: StrengthTrendRow[];
  matchedRows: StrengthTrendRow[];
  baselineRows: StrengthTrendRow[];
  trendPct: number | null;
  reviewDays: number;
  priorLookbackDays: number;
  minMatchedLiftsForScore: number;
};

type StrengthTrendLiftCategory = 'main_compound' | 'machine_compound' | 'isolation';

type StrengthTrendEstimateSet = (
  weightLbs: number | null | undefined,
  reps: number | null | undefined,
  options?: { rir?: number | null; category?: StrengthTrendLiftCategory },
) => number | null;

type StrengthTrendCategorizeExercise = (input: {
  isCompound?: boolean | null;
  isMachine?: boolean | null;
  name?: string | null;
}) => StrengthTrendLiftCategory;

const NON_STRENGTH_PRIMARY_MUSCLES = new Set([
  'cardio',
  'mobility',
  'recovery',
  'stretch',
  'systemic',
]);

const NON_STRENGTH_ACTIVITY_TAGS = new Set([
  'cardio',
  'conditioning',
  'mobility',
  'recovery',
  'stretch',
  'warmup',
]);

const CORE_STRENGTH_NAME_RE = /\b(core|abs?|abdominal|oblique)s?\b|crunch|plank|russian twist|leg raise|sit.?up|hollow|knee raise|woodchop|woodchopper|pallof|dead bug|bird dog|toes?.?to.?bar|v.?up|flutter kick|scissor kick|heel tap|curl.?up/i;
const NON_STRENGTH_NAME_RE = /treadmill|stationary bike|elliptical|rowing machine|stair climber|assault bike|battle rope|jump rope|sprint|jogging|running|cycling|swimming|hiit|intervals|mountain climber|hill sprint|cardio|zone.?2|tempo (run|ride|bike|row|swim)|boxing|kickboxing|martial.?arts|mma|bag.?work|shadow.?box|yoga|vinyasa|pilates|mobility|stretch|foam.?roll|recovery flow|sun.?salutation|downward.?dog|cobra flow|child.?s pose|seated forward fold|spinal twist|couch stretch|deep squat hold|90\/90|cat.?cow|thread.?the.?needle|dead hang|wall sit|burpee/i;

export function normalizedExerciseName(name: unknown): string {
  return String(name ?? '').trim().toLowerCase();
}

function dateKeyFromRaw(raw: unknown): string | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const match = text.match(/\d{4}-\d{2}-\d{2}/);
  if (match) return match[0];
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
}

function parseDateKeyMs(raw: unknown): number {
  const key = dateKeyFromRaw(raw);
  if (!key) return 0;
  const ms = new Date(`${key}T12:00:00`).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function fallbackCategorizeExercise(input: {
  isCompound?: boolean | null;
  isMachine?: boolean | null;
  name?: string | null;
}): StrengthTrendLiftCategory {
  if (input.isCompound === false) return 'isolation';
  if (input.isCompound === true) return input.isMachine ? 'machine_compound' : 'main_compound';
  const n = normalizedExerciseName(input.name);
  if (/(squat|deadlift|bench|press|row|pulldown|pull.?up|chin.?up|leg press|lunge|hip thrust)/.test(n)) {
    return input.isMachine ? 'machine_compound' : 'main_compound';
  }
  return 'isolation';
}

function fallbackEstimate1RM(
  weightLbs: number | null | undefined,
  reps: number | null | undefined,
  options?: { rir?: number | null; category?: StrengthTrendLiftCategory },
): number | null {
  if (options?.category === 'isolation') return null;
  const weight = Number(weightLbs);
  const repCount = Number(reps);
  const rir = Number(options?.rir ?? 0);
  if (!Number.isFinite(weight) || weight <= 0 || !Number.isFinite(repCount) || repCount <= 0) return null;
  const effectiveReps = repCount + (Number.isFinite(rir) ? Math.max(0, rir) : 0);
  return weight * (1 + Math.min(effectiveReps, 12) / 30);
}

export function getExercisePrimaryMuscle(exercise: Partial<SessionExercise> | any): string {
  return String(exercise?.primaryMuscle ?? exercise?.primary_muscle ?? '').trim().toLowerCase();
}

export function isLoadedStrengthSet(set: Partial<CompletedSet> | any): boolean {
  const weight = Number(set?.weightLbs ?? set?.weight_lbs ?? 0);
  const reps = Number(set?.reps ?? 0);
  return Number.isFinite(weight) && weight > 0 && Number.isFinite(reps) && reps > 0;
}

export function isNonStrengthExercise(exercise: Partial<SessionExercise> | any): boolean {
  const primary = getExercisePrimaryMuscle(exercise);
  if (NON_STRENGTH_PRIMARY_MUSCLES.has(primary)) return true;
  const tags = [
    exercise?.slotRole,
    exercise?.slot_role,
    exercise?.prescriptionType,
    exercise?.prescription_type,
    exercise?.exerciseType,
    exercise?.exercise_type,
    exercise?.movementPattern,
    exercise?.movement_pattern,
  ];
  if (tags.some(tag => NON_STRENGTH_ACTIVITY_TAGS.has(String(tag ?? '').trim().toLowerCase()))) return true;
  const name = String(exercise?.name ?? '');
  return NON_STRENGTH_NAME_RE.test(name);
}

export function isTrackableStrengthExercise(exercise: Partial<SessionExercise> | any): boolean {
  const sets = Array.isArray(exercise?.sets) ? exercise.sets : [];
  if (!sets.some(isLoadedStrengthSet)) return false;
  return !isNonStrengthExercise(exercise);
}

export function loadedStrengthSets(exercise: Partial<SessionExercise> | any): CompletedSet[] {
  const sets = Array.isArray(exercise?.sets) ? exercise.sets : [];
  if (isNonStrengthExercise(exercise)) return [];
  return sets.filter(isLoadedStrengthSet);
}

export function inferChartMuscleFromName(name: string): string {
  const n = name.toLowerCase();
  if (CORE_STRENGTH_NAME_RE.test(n)) return 'core';
  if (NON_STRENGTH_NAME_RE.test(n)) return 'cardio';
  // 2026-05 audit: any deadlift / hinge / pull-from-floor variant is a
  // POSTERIOR-CHAIN lift, not a back lift. Match it before the back
  // regex so "Deadlift" / "Trap Bar Deadlift" / "Sumo Deadlift" route
  // to hamstrings (the prime movers) rather than back. The back regex
  // below intentionally no longer mentions deadlift / trap; back gets
  // SECONDARY credit via `inferRelativeStrengthSecondaries`.
  if (/deadlift|romanian|rdl|hamstring|leg curl|good morning|trap.?bar/.test(n)) return 'hamstrings';
  if (/bench|push.?up|chest|pec|fly/.test(n)) return 'chest';
  if (/row|pulldown|pull.?up|chin.?up|lat/.test(n)) return 'back';
  if (/shoulder|overhead|ohp|lateral raise|rear delt|face pull/.test(n)) return 'shoulders';
  if (/curl|bicep/.test(n)) return 'biceps';
  if (/tricep|dip|skull/.test(n)) return 'triceps';
  if (/squat|leg press|lunge|split squat|step.?up|extension/.test(n)) return 'quads';
  if (/hip thrust|glute|kickback|bridge/.test(n)) return 'glutes';
  if (/calf/.test(n)) return 'calves';
  return '';
}

export function isRelativeStrengthFloorPull(name: unknown): boolean {
  const n = String(name ?? '').toLowerCase();
  if (!/(deadlift|trap.?bar)/.test(n)) return false;
  return !/(romanian|rdl|stiff|straight.?leg|single.?leg)/.test(n);
}

export function relativeStrengthPrimaryForName(name: unknown, primary: string | null): string | null {
  if (isRelativeStrengthFloorPull(name)) return 'hamstrings';
  return primary;
}

export function shouldExcludeRelativeStrengthSecondary(name: unknown, muscle: string): boolean {
  return muscle === 'glutes' && isRelativeStrengthFloorPull(name);
}

export function inferRelativeStrengthSecondaries(name: unknown, primary: string | null): string[] {
  const n = String(name ?? '').toLowerCase();
  const out: string[] = [];
  const add = (muscle: string) => {
    if (muscle !== primary && !shouldExcludeRelativeStrengthSecondary(name, muscle) && !out.includes(muscle)) {
      out.push(muscle);
    }
  };
  if (/bench|push.?up|chest|pec|fly/.test(n)) {
    add('triceps');
    add('shoulders');
  }
  if (/row|pulldown|pull.?up|chin.?up|lat/.test(n)) {
    add('biceps');
  }
  if (/shoulder press|overhead|ohp|military press|pike push/.test(n)) {
    add('triceps');
  }
  if (/squat|leg press|lunge|split squat|step.?up/.test(n)) {
    add('glutes');
  }
  if (/deadlift|romanian|rdl|hamstring|leg curl|good morning/.test(n)) {
    add('hamstrings');
    add('glutes');
    add('back');
  }
  return out;
}

export function buildExerciseTrendMap(history: WorkoutSession[]): Record<string, ExerciseTrendPoint[]> {
  const trendMap: Record<string, ExerciseTrendPoint[]> = {};
  const sorted = [...history].sort((a, b) => +new Date(a.date) - +new Date(b.date));

  for (const session of sorted) {
    if (!session.completed || session.skipped) continue;
    for (const exercise of session.exercises ?? []) {
      const key = normalizedExerciseName(exercise.name);
      if (!key || !isTrackableStrengthExercise(exercise)) continue;

      const strengthSets = loadedStrengthSets(exercise);
      if (strengthSets.length === 0) continue;

      const bestWeight = Math.max(...strengthSets.map(set => Number(set.weightLbs ?? 0)));
      const volume = strengthSets.reduce((sum, set) => sum + Number(set.weightLbs ?? 0) * Number(set.reps ?? 0), 0);
      const totalDuration = strengthSets.reduce((sum, set) => sum + Number((set as any).durationSeconds ?? 0), 0);
      const d = new Date(session.date);
      const rows = trendMap[key] ?? [];
      rows.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, bestWeight, volume, totalDuration });
      trendMap[key] = rows.length > 10 ? rows.slice(-10) : rows;
    }
  }

  return trendMap;
}

type StrengthSessionPoint = {
  name: string;
  primaryMuscle: string | null;
  date: string;
  dateMs: number;
  e1rm: number;
  sampleCount: number;
};

function bestCompoundStrengthPointForExercise(
  sessionDate: string,
  exercise: Partial<SessionExercise> | any,
  estimateSet: StrengthTrendEstimateSet,
  categorize: StrengthTrendCategorizeExercise,
): StrengthSessionPoint | null {
  const key = normalizedExerciseName(exercise?.name);
  if (!key || isNonStrengthExercise(exercise)) return null;
  const category = categorize({
    isCompound: exercise?.isCompound ?? exercise?.is_compound ?? null,
    isMachine: exercise?.isMachine ?? exercise?.is_machine ?? null,
    name: exercise?.name,
  });
  if (category === 'isolation') return null;

  let best: number | null = null;
  let sampleCount = 0;
  const sets = Array.isArray(exercise?.sets) ? exercise.sets : [];
  for (const set of sets) {
    const weight = Number(set?.weightLbs ?? set?.weight_lbs ?? set?.actual_weight_lbs);
    const reps = Number(set?.reps ?? set?.actual_reps);
    const rir = Number(set?.rir ?? set?.actual_rir);
    const estimate = estimateSet(weight, reps, {
      rir: Number.isFinite(rir) ? rir : null,
      category,
    });
    if (estimate == null || estimate <= 0) continue;
    sampleCount += 1;
    if (best == null || estimate > best) best = estimate;
  }
  if (best == null) return null;
  const dateMs = parseDateKeyMs(sessionDate);
  if (!dateMs) return null;
  return {
    name: String(exercise?.name ?? key).trim() || key,
    primaryMuscle: String(exercise?.primaryMuscle ?? exercise?.primary_muscle ?? '').trim().toLowerCase() || null,
    date: dateKeyFromRaw(sessionDate) ?? sessionDate,
    dateMs,
    e1rm: best,
    sampleCount,
  };
}

export function buildStrengthTrendSummary(
  history: WorkoutSession[],
  options: {
    today?: string | Date;
    reviewDays?: number;
    priorLookbackDays?: number;
    minMatchedLiftsForScore?: number;
    estimateSet?: StrengthTrendEstimateSet;
    categorizeExercise?: StrengthTrendCategorizeExercise;
  } = {},
): StrengthTrendSummary | null {
  const todayKey = dateKeyFromRaw(options.today ?? new Date());
  const todayMs = todayKey ? parseDateKeyMs(todayKey) : Date.now();
  if (!Number.isFinite(todayMs) || todayMs <= 0) return null;

  const reviewDays = Math.max(14, Math.round(options.reviewDays ?? 56));
  const priorLookbackDays = Math.max(reviewDays, Math.round(options.priorLookbackDays ?? 120));
  const minMatchedLiftsForScore = Math.max(1, Math.round(options.minMatchedLiftsForScore ?? 2));
  const estimateSet = options.estimateSet ?? fallbackEstimate1RM;
  const categorize = options.categorizeExercise ?? fallbackCategorizeExercise;
  const recentStartMs = todayMs - (reviewDays - 1) * 86400000;
  const oldestMs = todayMs - (reviewDays + priorLookbackDays) * 86400000;
  const byExercise = new Map<string, StrengthSessionPoint[]>();

  const sorted = [...history].sort((a, b) => parseDateKeyMs(a.date) - parseDateKeyMs(b.date));
  sorted.forEach(session => {
    if (!session.completed || session.skipped) return;
    const sessionMs = parseDateKeyMs(session.date);
    if (!sessionMs || sessionMs < oldestMs || sessionMs > todayMs) return;
    const perSession = new Map<string, StrengthSessionPoint>();
    for (const exercise of session.exercises ?? []) {
      const key = normalizedExerciseName(exercise.name);
      if (!key) continue;
      const point = bestCompoundStrengthPointForExercise(session.date, exercise, estimateSet, categorize);
      if (!point) continue;
      const current = perSession.get(key);
      if (!current || point.e1rm > current.e1rm) perSession.set(key, point);
    }
    for (const [key, point] of perSession) {
      const list = byExercise.get(key) ?? [];
      list.push(point);
      byExercise.set(key, list);
    }
  });

  const rows: StrengthTrendRow[] = [];
  for (const points of byExercise.values()) {
    points.sort((a, b) => a.dateMs - b.dateMs);
    const currentIndex = (() => {
      for (let i = points.length - 1; i >= 0; i -= 1) {
        if (points[i].dateMs >= recentStartMs && points[i].dateMs <= todayMs + 1) return i;
      }
      return -1;
    })();
    if (currentIndex < 0) continue;
    const current = points[currentIndex];
    const prior = currentIndex > 0 ? points[currentIndex - 1] : null;
    const deltaLbs = prior ? current.e1rm - prior.e1rm : null;
    const deltaPct = prior && prior.e1rm > 0
      ? Math.round((deltaLbs! / prior.e1rm) * 100)
      : null;
    rows.push({
      name: current.name,
      primaryMuscle: current.primaryMuscle,
      currentE1RM: Math.round(current.e1rm * 10) / 10,
      priorE1RM: prior ? Math.round(prior.e1rm * 10) / 10 : null,
      deltaLbs: deltaLbs != null ? Math.round(deltaLbs * 10) / 10 : null,
      deltaPct,
      currentDate: current.date,
      priorDate: prior?.date ?? null,
      currentSampleCount: current.sampleCount,
      priorSampleCount: prior?.sampleCount ?? null,
    });
  }

  rows.sort((a, b) => {
    const ad = a.deltaPct ?? -Infinity;
    const bd = b.deltaPct ?? -Infinity;
    if (bd !== ad) return bd - ad;
    return b.currentE1RM - a.currentE1RM;
  });

  const matchedRows = rows.filter(row => row.priorE1RM != null);
  const baselineRows = rows.filter(row => row.priorE1RM == null);
  const trendPct = matchedRows.length >= minMatchedLiftsForScore
    ? Math.round(
        matchedRows.reduce((sum, row) => {
          const pct = row.deltaPct ?? 0;
          return sum + Math.max(-50, Math.min(50, pct));
        }, 0) / matchedRows.length,
      )
    : null;

  return {
    rows,
    matchedRows,
    baselineRows,
    trendPct,
    reviewDays,
    priorLookbackDays,
    minMatchedLiftsForScore,
  };
}

export function buildLocalE1RMHistory(
  history: WorkoutSession[],
  exerciseName: string | null | undefined,
  estimateSet: (
    weightLbs: number | null | undefined,
    reps: number | null | undefined,
    options?: { rir?: number | null },
  ) => number | null,
): E1RMTrendPoint[] {
  const target = normalizedExerciseName(exerciseName);
  if (!target) return [];

  const points: E1RMTrendPoint[] = [];
  const sorted = [...history].sort((a, b) => +new Date(a.date) - +new Date(b.date));
  for (const session of sorted) {
    if (!session.completed || session.skipped) continue;
    let best: number | null = null;
    let sampleCount = 0;
    for (const exercise of session.exercises ?? []) {
      if (normalizedExerciseName(exercise.name) !== target || !isTrackableStrengthExercise(exercise)) continue;
      for (const set of loadedStrengthSets(exercise)) {
        const estimate = estimateSet(set.weightLbs, set.reps, { rir: set.rir });
        if (estimate == null) continue;
        sampleCount += 1;
        if (best == null || estimate > best) best = estimate;
      }
    }
    if (best != null) {
      points.push({
        date: session.date,
        e1rm_lbs: Math.round(best * 10) / 10,
        confidence: sampleCount >= 3 ? 'med' : 'low',
        sample_count: sampleCount,
      });
    }
  }
  return points.slice(-10);
}

/** Best-set trend for isolation exercises. We don't show estimated
 *  1RM for curls / lateral raises / cable kickbacks because Epley
 *  overshoots wildly on tendon-bound movements. Instead, we plot the
 *  heaviest working set per session as a "are you progressing on
 *  this lift?" surface. The point shape mirrors `E1RMTrendPoint` so
 *  the chart consumer can treat both identically — only the label /
 *  axis text need to flip in the parent. */
export function buildLocalBestSetHistory(
  history: WorkoutSession[],
  exerciseName: string | null | undefined,
): E1RMTrendPoint[] {
  const target = normalizedExerciseName(exerciseName);
  if (!target) return [];

  const points: E1RMTrendPoint[] = [];
  const sorted = [...history].sort((a, b) => +new Date(a.date) - +new Date(b.date));
  for (const session of sorted) {
    if (!session.completed || session.skipped) continue;
    let bestWeight: number | null = null;
    let setCount = 0;
    for (const exercise of session.exercises ?? []) {
      if (normalizedExerciseName(exercise.name) !== target || !isTrackableStrengthExercise(exercise)) continue;
      for (const set of loadedStrengthSets(exercise)) {
        const w = Number(set.weightLbs ?? 0);
        if (!Number.isFinite(w) || w <= 0) continue;
        setCount += 1;
        if (bestWeight == null || w > bestWeight) bestWeight = w;
      }
    }
    if (bestWeight != null) {
      points.push({
        date: session.date,
        e1rm_lbs: Math.round(bestWeight * 10) / 10,
        confidence: setCount >= 3 ? 'med' : 'low',
        sample_count: setCount,
      });
    }
  }
  return points.slice(-10);
}
