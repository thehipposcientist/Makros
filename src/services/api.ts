import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';

const LOCAL_BACKEND_IP = '192.168.1.220'; // your dev machine's LAN IP

function getBaseUrl(): string {
  // Production / TestFlight build: read from app config extras. Set this
  // via `app.json` → `expo.extra.apiBaseUrl` (or via EAS build secrets).
  // Fall back to the legacy placeholder so a misconfigured build is obvious
  // rather than silently hitting a dev machine.
  const configured = (Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined)?.apiBaseUrl;
  if (!__DEV__) {
    return configured || 'https://your-production-api.com';
  }
  // Dev: ignore the prod URL baked into app.json — that's for release builds.
  // To point the dev client at a remote backend, set EXPO_PUBLIC_API_URL.
  const devOverride = process.env.EXPO_PUBLIC_API_URL;
  if (devOverride && devOverride.startsWith('http')) return devOverride;
  const hostUri = Constants.expoConfig?.hostUri ?? '';
  const isTunnel = hostUri.includes('ngrok') || hostUri.includes('exp.direct') || !hostUri;
  const host = isTunnel ? LOCAL_BACKEND_IP : (hostUri.split(':')[0] ?? LOCAL_BACKEND_IP);
  return `http://${host}:8000`;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

async function request<T>(path: string, options: RequestInit = {}, timeoutMs = 30000, noRetry = false): Promise<T> {
  const maxRetries = noRetry ? 0 : 2;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 1s, 2s
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }

    const url = `${getBaseUrl()}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...options.headers },
      });
      clearTimeout(timer);

      // Retry on transient server errors
      if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
        console.log(`[api] ${path} returned ${res.status}, retrying (${attempt + 1}/${maxRetries})`);
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      if (!res.ok) {
        const detail = Array.isArray(data.detail)
          ? data.detail.map((e: any) => `${e.loc?.join('.')}: ${e.msg}`).join(', ')
          : (typeof data.detail === 'string' ? data.detail : `HTTP ${res.status}`);
        throw new Error(detail);
      }
      return data as T;
    } catch (e: any) {
      clearTimeout(timer);
      if (e.name === 'AbortError') {
        lastError = new Error(`Request timed out. Backend: ${getBaseUrl()} — is it reachable?`);
        if (attempt < maxRetries) continue;
        throw lastError;
      }
      if (e.message === 'Network request failed') {
        lastError = new Error(`Can't reach backend at ${getBaseUrl()} — is it running?`);
        if (attempt < maxRetries) continue;
        throw lastError;
      }
      throw e;
    }
  }
  throw lastError ?? new Error('Request failed');
}

export async function register(email: string, username: string, password: string) {
  return request('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, username, password }),
  });
}

export async function login(email: string, password: string): Promise<{ access_token: string }> {
  return request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function resetPassword(email: string, newPassword: string): Promise<{ access_token: string }> {
  return request('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ email, new_password: newPassword }),
  });
}

export async function getMe(token: string) {
  return request('/auth/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getMyProfile(token: string): Promise<import('../types').UserProfile | null> {
  try {
    const data = await request<any>('/profile/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    // Map backend snake_case → frontend UserProfile shape
    return {
      goal:       data.goal.goal_type,
      goalDetails: {
        pace:             data.goal.pace,
        targetWeightLbs:  data.goal.target_weight_lbs ?? undefined,
        timelineWeeks:    data.goal.timeline_weeks ?? undefined,
      },
      physicalStats: {
        weightLbs:    data.profile.weight_lbs,
        heightFeet:   data.profile.height_feet,
        heightInches: data.profile.height_inches,
        age:          data.profile.age,
        gender:       data.profile.gender,
      },
      daysPerWeek:            data.preferences.days_per_week,
      workoutDurationMinutes: 60,
      equipment:              data.preferences.equipment ?? [],
      foodsAvailable:         data.preferences.foods_available ?? [],
      customFoods:            [],
      savedMeals:             [],
    };
  } catch {
    return null;
  }
}


/**
 * Build a combined meal routine string from free-text + structured MealRoutineEntry[].
 * This gives the AI a clear, parseable description of what the user eats regularly.
 */
async function buildMealRoutineText(profile: import('../types').UserProfile): Promise<string | undefined> {
  const parts: string[] = [];

  // Free-text routine from onboarding
  if (profile.mealRoutine?.trim()) {
    parts.push(profile.mealRoutine.trim());
  }

  // Structured routines from the meal routine builder
  try {
    const { loadMealRoutines } = await import('../utils/workoutHistory');
    const routines = await loadMealRoutines();
    if (routines.length > 0) {
      const lines = routines.map(r => {
        const foodList = r.foods.map(f => f.quantity ? `${f.quantity} ${f.name}` : f.name).join(', ');
        const type = r.mealType ? ` (${r.mealType})` : '';
        return `- ${r.name}${type}: ${foodList}${r.notes ? ` — ${r.notes}` : ''}`;
      });
      parts.push('Structured routine meals (keep these EXACTLY as specified):\n' + lines.join('\n'));
    }
  } catch { /* no routines stored */ }

  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/** Compute the total macros + count for every pinned routine meal.
 *  Sent to the backend so the assembler can:
 *    1. Subtract routine macros from the daily target.
 *    2. Subtract routine count from mealsPerDay so the generated meals
 *       plus pinned routines fit the user's meal budget.
 *
 *  `routineSlots` is sent as a synthetic list of length N (one entry
 *  per pinned routine) — the backend only reads its length now, the
 *  string contents are ignored. We keep the field name + shape for
 *  back-compat with the existing PlanRequest schema.
 *
 *  Returns null when the user has no routines pinned. */
async function buildRoutinePayload(): Promise<{
  routineMacros: { calories: number; protein: number; carbs: number; fat: number };
  routineSlots: string[];
} | null> {
  try {
    const { loadMealRoutines } = await import('../utils/workoutHistory');
    const routines = await loadMealRoutines();
    if (!routines.length) return null;
    // Some routines (older entries, or routines created before per-meal
    // macros were captured) carry calories=0 at the top level. When that
    // happens, fall back to summing the structured items[] so the backend
    // sees the real load and can size the rest of the day correctly.
    // Without this, a 1500-cal pinned routine looks like 0 cal and the
    // backend builds a full-target plan that overlays to 4500 cal.
    const macrosOf = (r: any): { calories: number; protein: number; carbs: number; fat: number } => {
      const top = {
        calories: r.calories ?? 0,
        protein:  r.protein  ?? 0,
        carbs:    r.carbs    ?? 0,
        fat:      r.fat      ?? 0,
      };
      if (top.calories > 0) return top;
      const items = Array.isArray(r.items) ? r.items : [];
      return items.reduce(
        (acc: any, it: any) => ({
          calories: acc.calories + (it.calories ?? 0),
          protein:  acc.protein  + (it.protein  ?? 0),
          carbs:    acc.carbs    + (it.carbs    ?? 0),
          fat:      acc.fat      + (it.fat      ?? 0),
        }),
        { calories: 0, protein: 0, carbs: 0, fat: 0 },
      );
    };
    const totals = routines.reduce(
      (acc, r) => {
        const m = macrosOf(r);
        return {
          calories: acc.calories + m.calories,
          protein:  acc.protein  + m.protein,
          carbs:    acc.carbs    + m.carbs,
          fat:      acc.fat      + m.fat,
        };
      },
      { calories: 0, protein: 0, carbs: 0, fat: 0 },
    );
    console.log('[buildRoutinePayload]', routines.length, 'routines →', totals);
    // One synthetic slot per pinned routine — the backend just reads
    // the count.
    const slots = routines.map((_, i) => `routine_${i}`);
    return {
      routineMacros: {
        calories: Math.round(totals.calories),
        protein:  Math.round(totals.protein),
        carbs:    Math.round(totals.carbs),
        fat:      Math.round(totals.fat),
      },
      routineSlots: slots,
    };
  } catch {
    return null;
  }
}

function buildLogContext(
  profile: import('../types').UserProfile,
  userLog?: import('../types').UserLogEntry[],
  extraContext?: string,
): string | undefined {
  const parts: string[] = [];
  // Onboarding context — what the user said they last trained at signup
  if (profile.lastWorkoutContext) {
    parts.push(`User's recent activity (from sign-up): ${profile.lastWorkoutContext}`);
  }
  // Any extra context built by the caller (e.g. recent workout sessions)
  if (extraContext) parts.push(extraContext);
  // User activity log
  const logLines = (userLog ?? [])
    .slice(0, 10)
    .map(e => `[${e.date.slice(0, 10)}] ${e.summary}`)
    .join('\n');
  if (logLines) parts.push(logLines);
  return parts.length ? parts.join('\n\n') : undefined;
}

function buildInjuries(profile: import('../types').UserProfile): string[] {
  const list: string[] = (profile.injuryEntries ?? [])
    .filter((e: any) => e.status !== 'resolved')
    .map((e: any) => {
      const parts = [e.description, `(${e.bodyPart}, status: ${e.status})`];
      if (e.muscleGroups?.length) parts.push(`muscles: ${e.muscleGroups.join(',')}`);
      if (e.severity) parts.push(`severity: ${e.severity}`);
      if (e.estimatedRecoveryDate) parts.push(`est. recovery: ${e.estimatedRecoveryDate}`);
      return parts.join(' ');
    });
  if (profile.injuries && list.length === 0) list.push(profile.injuries);
  return list;
}

export interface WeeklyReview {
  adherence: number;       // 1-5: how many planned workouts completed
  energy: number;          // 1-5: overall energy/recovery rating
  notes?: string;          // free-text user feedback
  pendingChanges?: Array<{ date: string; editMode: string; summary: string }>;
}

/** Full plan — called on first sign-up or when goal/pace changes (updates both sides). */
/** AsyncStorage key where we persist the in-flight plan job id so we can
 *  resume polling across app launches / backgrounding events. */
const PENDING_PLAN_JOB_KEY = 'pending_plan_job';

export type PendingPlanKind = 'full' | 'workout' | 'nutrition';
export interface PendingPlanMarker {
  id: number;
  kind: PendingPlanKind;
}

async function readPendingPlanJob(): Promise<PendingPlanMarker | null> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_PLAN_JOB_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Back-compat — older markers were just {id}.
    if (parsed && typeof parsed.id === 'number') {
      return { id: parsed.id, kind: (parsed.kind as PendingPlanKind) ?? 'full' };
    }
    return null;
  } catch {
    return null;
  }
}
async function writePendingPlanJob(id: number, kind: PendingPlanKind = 'full'): Promise<void> {
  try { await AsyncStorage.setItem(PENDING_PLAN_JOB_KEY, JSON.stringify({ id, kind })); } catch {}
}
async function clearPendingPlanJob(): Promise<void> {
  try { await AsyncStorage.removeItem(PENDING_PLAN_JOB_KEY); } catch {}
}

export async function getPendingPlanMarker(): Promise<PendingPlanMarker | null> {
  return readPendingPlanJob();
}
/** @deprecated use getPendingPlanMarker — kept for API compatibility. */
export async function getPendingPlanJobId(): Promise<number | null> {
  const p = await readPendingPlanJob();
  return p?.id ?? null;
}

/** Cancel the in-flight plan job (if any). Clears the persisted marker
 *  regardless of whether the server-side delete succeeded. */
export async function cancelPendingPlanJob(token: string): Promise<void> {
  const p = await readPendingPlanJob();
  await clearPendingPlanJob();
  if (p?.id) {
    try { await cancelPlanJob(token, p.id); } catch { /* server already done or unreachable — not fatal */ }
  }
}

async function _pollPlanJobUntilDone(
  token: string,
  jobId: number,
  opts?: { pollIntervalMs?: number; maxMs?: number },
): Promise<any> {
  const interval = opts?.pollIntervalMs ?? 2500;
  const maxMs = opts?.maxMs ?? 10 * 60 * 1000; // 10 minutes — plenty for worst-case LLM latency
  const deadline = Date.now() + maxMs;
  let consecutive404 = 0;
  let pollCount = 0;

  while (Date.now() < deadline) {
    pollCount++;
    // Check if someone cleared the pending marker (e.g. user cancelled or
    // a different job took over). Exit the poll loop if so.
    const pending = await readPendingPlanJob();
    if (!pending || pending.id !== jobId) {
      throw new Error('Plan generation was cancelled');
    }

    let status: PlanJob | null = null;
    try {
      status = await getPlanJob(token, jobId);
      consecutive404 = 0;
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      // 404 means the backend dropped the row — could be a `reset-db` or
      // similar. Tolerate one transient miss but bail after two in a row.
      if (msg.toLowerCase().includes('not found')) {
        consecutive404++;
        if (consecutive404 >= 2) {
          await clearPendingPlanJob();
          throw new Error('Plan generation job no longer exists on the server');
        }
      }
      // Network error or one-off 404 — wait and retry once before surfacing.
      await new Promise(r => setTimeout(r, interval));
      try {
        status = await getPlanJob(token, jobId);
        consecutive404 = 0;
      } catch (e2: any) {
        // Still failing after one retry. If the poll has been alive for a
        // while, the backend may have just restarted — surface as a
        // dedicated error the UI can handle gracefully.
        if (pollCount > 4) {
          throw new Error(`Lost connection to plan job: ${e2?.message ?? e2}`);
        }
        // Early poll failure → real network error.
        throw e2;
      }
    }

    if (!status) {
      await new Promise(r => setTimeout(r, interval));
      continue;
    }
    if (status.status === 'completed') {
      if (!status.result) {
        // Backend says done but gave us nothing — treat as failure so the
        // user isn't stuck on a spinner forever. This was the "sits at the
        // end" bug from the user's report.
        await clearPendingPlanJob();
        throw new Error('Plan generation completed but returned no data');
      }
      await clearPendingPlanJob();
      return status.result;
    }
    if (status.status === 'failed') {
      await clearPendingPlanJob();
      throw new Error(status.error ?? 'Plan generation failed');
    }
    if (status.status === 'cancelled') {
      await clearPendingPlanJob();
      throw new Error('Plan generation was cancelled');
    }
    await new Promise(r => setTimeout(r, interval));
  }
  // Timeout fallback — also clear the marker so the user doesn't get stuck
  // trying to resume a job that the poll gave up on.
  await clearPendingPlanJob();
  throw new Error('Plan generation timed out');
}

/** Resume polling the persisted job id, if one exists. Returns the result
 *  payload when the job completes, `null` if nothing was pending. Throws on
 *  failure / cancellation so callers can show an error. */
export async function resumePendingPlanJob(token: string): Promise<any | null> {
  const pending = await readPendingPlanJob();
  if (!pending?.id) return null;
  return _pollPlanJobUntilDone(token, pending.id);
}

export interface SplitOption {
  id: string;
  name: string;
  short_name: string;
  description: string;
  days_per_week_range: string;
  day_labels: string[];
  rationale: string;
  fit_score: number;
  is_recommended: boolean;
  stimulus_note: string;
  pros: string[];
  cons: string[];
  region_warning: string | null;
}

export async function getSplitOptions(
  token: string,
  params: { goal: string; daysPerWeek: number; experienceLevel?: string; priorityRegion?: string },
): Promise<{ options: SplitOption[]; recommended: string | null }> {
  const qs = new URLSearchParams({
    goal: params.goal,
    daysPerWeek: String(params.daysPerWeek),
    experienceLevel: params.experienceLevel || 'intermediate',
  });
  if (params.priorityRegion) qs.set('targetFocus', params.priorityRegion);
  return request(`/ai/plans/split-options?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getAIPlans(
  token: string,
  profile: import('../types').UserProfile,
  options?: { userLog?: import('../types').UserLogEntry[]; extraContext?: string; weeklyReview?: WeeklyReview },
) {
  const injuriesOrLimitations = buildInjuries(profile);
  const mealRoutineText = await buildMealRoutineText(profile);
  const routinePayload = await buildRoutinePayload();
  const payload: Record<string, any> = {
    goal:                   profile.goal,
    goalSelection:          profile.goalSelection ?? undefined,
    secondaryGoal:          profile.secondaryGoal,
    priorityRegion:         profile.priorityRegion || 'balanced',
    goalDetails:            profile.goalDetails,
    physicalStats:          profile.physicalStats,
    daysPerWeek:            profile.daysPerWeek,
    workoutDurationMinutes: profile.workoutDurationMinutes,
    equipment:              profile.equipment,
    foodsAvailable:         profile.foodsAvailable,
    supplementsAvailable:   profile.supplementsAvailable ?? [],
    experienceLevel:        profile.experienceLevel,
    preferredSplit:         profile.preferredSplit || undefined,
    injuriesOrLimitations,
    mealRoutine:            mealRoutineText,
    routineMacros:          routinePayload?.routineMacros,
    routineSlots:           routinePayload?.routineSlots ?? [],
    mealsPerDay:            Math.max(1, Math.min(10, profile.mealsPerDay ?? 3)),
    mealVariety:            Math.max(1, Math.min(7, profile.mealVariety ?? 5)),
    customMacros:           profile.customMacros ?? undefined,
    userContext:            buildLogContext(profile, options?.userLog, options?.extraContext),
  };
  if (options?.weeklyReview) {
    payload.weeklyReview = options.weeklyReview;
  }

  console.log('[getAIPlans] ENQUEUE → /ai/plans/enqueue', {
    goal: payload.goal, daysPerWeek: payload.daysPerWeek,
    equipment: payload.equipment?.length ?? 0, foods: payload.foodsAvailable?.length ?? 0,
  });

  // Enqueue the job server-side and persist its id so we can pick up where
  // we left off after any app kill / backgrounding / network hiccup.
  const job = await enqueuePlanJob(token, payload);
  await writePendingPlanJob(job.id, 'full');
  console.log(`[getAIPlans] job ${job.id} enqueued — polling`);

  const result = await _pollPlanJobUntilDone(token, job.id);

  console.log('[getAIPlans] RECV ←', {
    trainerNote: (result?.trainerNote ?? result?.workout_plan?.trainerNote)?.slice(0, 80) ?? 'MISSING',
    nutritionistNote: (result?.nutritionistNote ?? result?.nutrition_plan?.nutritionistNote)?.slice(0, 80) ?? 'MISSING',
    workoutDays: result?.workout_plan?.days?.length ?? 0,
  });
  return result;
}

/** Workout-only plan — called when equipment changes. Uses the job queue
 *  so it survives app backgrounding / force-close just like full plan gen. */
export async function getAIWorkoutPlan(
  token: string,
  profile: import('../types').UserProfile,
  options?: { userLog?: import('../types').UserLogEntry[]; extraContext?: string },
) {
  // Backend's `run_workout_only_generation` expects a PlanRequest with the
  // workout-relevant fields populated — same shape as the full path, just
  // with foods/supplements empty.
  const payload: Record<string, any> = {
    goal:                   profile.goal,
    secondaryGoal:          profile.secondaryGoal,
    priorityRegion:         profile.priorityRegion || 'balanced',
    goalDetails:            profile.goalDetails,
    physicalStats:          profile.physicalStats,
    daysPerWeek:            profile.daysPerWeek,
    workoutDurationMinutes: profile.workoutDurationMinutes,
    equipment:              profile.equipment,
    foodsAvailable:         [],
    experienceLevel:        profile.experienceLevel,
    preferredSplit:         profile.preferredSplit || undefined,
    injuriesOrLimitations:  buildInjuries(profile),
    userContext:            buildLogContext(profile, options?.userLog, options?.extraContext),
  };

  console.log('[getAIWorkoutPlan] ENQUEUE → /ai/plans/enqueue?kind=workout', {
    goal: payload.goal, daysPerWeek: payload.daysPerWeek, equipment: payload.equipment.length,
  });

  const job = await request<PlanJob>('/ai/plans/enqueue?kind=workout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 60000);
  await writePendingPlanJob(job.id, 'workout');
  const result = await _pollPlanJobUntilDone(token, job.id);

  console.log('[getAIWorkoutPlan] RECV ←', {
    trainerNote: result?.trainerNote?.slice(0, 80) ?? 'MISSING',
    workoutDays: result?.workout_plan?.days?.length ?? 0,
  });

  // Debug the AI plan-review layer so we can iterate on what the
  // reviewer saw vs what it decided. Backend attaches `_debug.review`
  // to every plan response containing the full brief, verdict,
  // notes, and any patches it applied.
  const reviewDebug = (result as any)?._debug?.review;
  if (reviewDebug) {
    try {
      console.log('[plan-review] BRIEF sent to AI:\n' + JSON.stringify(reviewDebug.brief, null, 2));
      console.log('[plan-review] VERDICT:', {
        status: reviewDebug.verdict?.status,
        notes: reviewDebug.verdict?.notes,
        patchCount: reviewDebug.verdict?.patches?.length ?? 0,
        error: reviewDebug.verdict?.error,
      });
      if (reviewDebug.verdict?.patches?.length > 0) {
        console.log('[plan-review] PATCHES applied:\n' + JSON.stringify(reviewDebug.verdict.patches, null, 2));
      }
    } catch (e) {
      console.log('[plan-review] failed to log debug payload:', e);
    }
  } else {
    console.log('[plan-review] no _debug.review attached — backend may not have run the reviewer');
  }

  return result;
}

/** Nutrition-only plan — called when foods change. Uses the job queue so it
 *  survives app backgrounding / force-close just like full plan gen. */
export async function getAINutritionPlan(
  token: string,
  profile: import('../types').UserProfile,
  options?: { userLog?: import('../types').UserLogEntry[]; extraContext?: string },
) {
  const mealRoutineText = await buildMealRoutineText(profile);
  const routinePayload = await buildRoutinePayload();
  const payload: Record<string, any> = {
    goal:                 profile.goal,
    goalDetails:          profile.goalDetails,
    physicalStats:        profile.physicalStats,
    daysPerWeek:          profile.daysPerWeek,
    equipment:            [],
    foodsAvailable:       profile.foodsAvailable,
    supplementsAvailable: profile.supplementsAvailable ?? [],
    dietaryPreference:    (profile as any).dietaryPreference ?? undefined,
    allergies:            (profile as any).allergies ?? [],
    mealRoutine:          mealRoutineText,
    routineMacros:        routinePayload?.routineMacros,
    routineSlots:         routinePayload?.routineSlots ?? [],
    mealsPerDay:          Math.max(1, Math.min(10, profile.mealsPerDay ?? 3)),
    mealVariety:          Math.max(1, Math.min(7, profile.mealVariety ?? 5)),
    customMacros:         profile.customMacros ?? undefined,
    userContext:          buildLogContext(profile, options?.userLog, options?.extraContext),
  };

  console.log('[getAINutritionPlan] ENQUEUE → /ai/plans/enqueue?kind=nutrition', {
    goal: payload.goal, daysPerWeek: payload.daysPerWeek, foods: payload.foodsAvailable.length,
  });

  const job = await request<PlanJob>('/ai/plans/enqueue?kind=nutrition', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 60000);
  await writePendingPlanJob(job.id, 'nutrition');
  const result = await _pollPlanJobUntilDone(token, job.id);

  console.log('[getAINutritionPlan] RECV ←', {
    nutritionistNote: result?.nutritionistNote?.slice(0, 80) ?? 'MISSING',
  });
  return result;
}

export async function getWeightRecommendation(
  token: string,
  exerciseName: string,
  goal: string,
  lastSets: import('../types').CompletedSet[],
  nextSetNumber: number,
  options?: {
    targetSets?: number;
    targetReps?: string;
    progressionPace?: 'conservative' | 'moderate' | 'aggressive';
    experienceLevel?: 'beginner' | 'intermediate' | 'advanced';
    recoveryLevel?: 'low' | 'normal' | 'high';
    phase?: 'accumulation' | 'intensification' | 'deload';
    workoutFocus?: string;
    weekNumber?: number;
    incrementLbs?: number;
    allTimeBestWeightLbs?: number;
    allTimeBestReps?: number;
    lastSessionBestWeightLbs?: number;
    lastSessionBestReps?: number;
  },
): Promise<{ weightLbs: number; reps: number; tip: string }> {
  return request('/ai/recommend-weight', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ exerciseName, goal, lastSets, nextSetNumber, ...options }),
  });
}

/** Estimated one-rep-max for the user's showcase compound lifts.
 *  Powered by the deterministic performance profile (Epley 1RM from
 *  recent logged sessions). Returns only lifts the user has actually
 *  trained in the ~28-day window. */
export type OneRepMaxLift = {
  slug: string;
  name: string;
  oneRepMaxLbs: number;
  topWeightLbs: number;
  topReps: number;
  sessionCount: number;
  confidence: number;
  lastPerformedOn: string | null;
};

export async function getOneRepMaxShowcase(token: string): Promise<OneRepMaxLift[]> {
  try {
    const res = await request<{ lifts: OneRepMaxLift[] }>('/ai/strength/one-rep-max', {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.lifts ?? [];
  } catch {
    return [];
  }
}

/** 4-pillar composite fitness score. Each pillar is a 0-100 subscore
 *  with a human-readable reason and a data quality tag. The headline
 *  `total` is a weighted average. */
export type FitnessPillar = {
  name: 'Strength' | 'Cardio' | 'Consistency' | 'Recovery';
  score: number;
  reason: string;
  dataQuality: 'full' | 'partial' | 'missing';
};
export type FitnessCompositeScore = {
  total: number;
  rating: 'Elite' | 'Strong' | 'Solid' | 'Building' | 'Starting';
  pillars: FitnessPillar[];
};

export async function getFitnessCompositeScore(
  token: string,
  params: {
    daysPerWeek?: number;
    bodyweightLbs?: number;
    recentSleepHours?: number;
    avgSessionRpe?: number;
  } = {},
): Promise<FitnessCompositeScore | null> {
  try {
    const qs = new URLSearchParams();
    if (params.daysPerWeek != null) qs.set('days_per_week', String(params.daysPerWeek));
    if (params.bodyweightLbs != null) qs.set('bodyweight_lbs', String(params.bodyweightLbs));
    if (params.recentSleepHours != null) qs.set('recent_sleep_hours', String(params.recentSleepHours));
    if (params.avgSessionRpe != null) qs.set('avg_session_rpe', String(params.avgSessionRpe));
    const path = `/ai/fitness/composite-score${qs.toString() ? `?${qs.toString()}` : ''}`;
    return await request<FitnessCompositeScore>(path, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return null;
  }
}

/** Map the frontend's rich goal vocabulary (lose_fat, build_muscle, etc.)
 *  to the backend's legacy GoalType enum. The backend only accepts a
 *  fixed set of values; passing anything else makes /profile/onboarding
 *  return 422 and the user's profile silently fails to sync, which then
 *  cascades into "calorie ranges 404" errors elsewhere in the app. */
function mapGoalToBackendType(frontendGoal: string | undefined | null): string {
  if (!frontendGoal) return 'maintain';
  const g = frontendGoal.toLowerCase();
  // Direct passthroughs (the values the backend already accepts).
  const passthrough = new Set([
    'fat_loss', 'muscle_gain', 'body_recomp', 'strength',
    'endurance', 'athletic_performance', 'toning', 'maintain',
    'flexibility', 'stress_relief',
  ]);
  if (passthrough.has(g)) return g;
  // Frontend → backend mapping. Goals from goalConfig.ts on the left,
  // backend GoalType on the right.
  const map: Record<string, string> = {
    lose_fat:                'fat_loss',
    get_lean:                'fat_loss',
    cut:                     'fat_loss',
    preserve_muscle_cutting: 'fat_loss',
    build_muscle:            'muscle_gain',
    lean_bulk:               'muscle_gain',
    gain_weight:             'muscle_gain',
    bulk:                    'muscle_gain',
    recomp:                  'body_recomp',
    body_recomposition:      'body_recomp',
    powerlifting:            'strength',
    strength_training:       'strength',
    get_stronger:            'strength',
    cardio_endurance:        'endurance',
    run_faster:              'endurance',
    marathon:                'endurance',
    sport_performance:       'athletic_performance',
    athletic:                'athletic_performance',
    tone_up:                 'toning',
    tone:                    'toning',
    maintain_weight:         'maintain',
    maintenance:             'maintain',
    mobility:                'flexibility',
    yoga:                    'flexibility',
    stress_management:       'stress_relief',
    metabolic_health:        'maintain',
    longevity:               'maintain',
    healthy_lifestyle:       'maintain',
  };
  return map[g] ?? 'maintain';
}

export async function syncOnboarding(token: string, profile: import('../types').UserProfile) {
  const mappedGoal = mapGoalToBackendType(profile.goal);
  if (mappedGoal !== profile.goal) {
    console.log('[syncOnboarding] mapped goal', profile.goal, '→', mappedGoal);
  }
  return request('/profile/onboarding', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      profile: {
        weight_lbs:    profile.physicalStats.weightLbs,
        height_feet:   profile.physicalStats.heightFeet,
        height_inches: profile.physicalStats.heightInches,
        age:           profile.physicalStats.age,
        gender:        profile.physicalStats.gender,
      },
      goal: {
        goal_type:         mappedGoal,
        pace:              profile.goalDetails.pace,
        target_weight_lbs: profile.goalDetails.targetWeightLbs ?? null,
        timeline_weeks:    profile.goalDetails.timelineWeeks ?? null,
      },
      preferences: {
        days_per_week:   profile.daysPerWeek,
        equipment:       profile.equipment,
        foods_available: profile.foodsAvailable,
      },
    }),
  });
}

// ============================================================================
// Meta API Endpoints — Reference Data (Foods, Equipment, Goals, Paces)
// ============================================================================

export async function getFoods(category?: string) {
  const params = category ? `?category=${category}` : '';
  return request<any[]>(`/meta/foods${params}`);
}

export async function getFoodCategories() {
  return request<Record<string, { label: string; icon: string }>>('/meta/food-categories');
}

export async function getEquipment(category?: string) {
  const params = category ? `?category=${category}` : '';
  return request<any[]>(`/meta/equipment${params}`);
}

export async function getGoals() {
  return request<any[]>('/meta/goals');
}

// Exercise library cache — the seed library is ~300+ items, so we cache
// it in AsyncStorage and return instantly on subsequent opens. TTL is
// long (24h) because the seed rarely changes. Pass { forceRefresh: true }
// to bypass the cache.
const EXERCISE_LIBRARY_CACHE_KEY = 'exercise_library_cache_v1';
const EXERCISE_LIBRARY_TTL_MS = 24 * 60 * 60 * 1000;

export async function getExercises(params?: { muscle?: string; equipment?: string; forceRefresh?: boolean }) {
  // Only the "all exercises" path (no filters) is cached — filter queries
  // are rare and would create too many cache keys.
  const unfiltered = !params?.muscle && !params?.equipment;
  if (unfiltered && !params?.forceRefresh) {
    try {
      const raw = await AsyncStorage.getItem(EXERCISE_LIBRARY_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.ts && Date.now() - parsed.ts < EXERCISE_LIBRARY_TTL_MS && Array.isArray(parsed.rows)) {
          return parsed.rows as any[];
        }
      }
    } catch {}
  }

  const qp = new URLSearchParams();
  if (params?.muscle) qp.set('muscle', params.muscle);
  if (params?.equipment) qp.set('equipment', params.equipment);
  const suffix = qp.toString() ? `?${qp.toString()}` : '';
  const rows = await request<any[]>(`/meta/exercises${suffix}`);

  if (unfiltered) {
    try { await AsyncStorage.setItem(EXERCISE_LIBRARY_CACHE_KEY, JSON.stringify({ ts: Date.now(), rows })); } catch {}
  }
  return rows;
}

export async function getPaces(goal?: string) {
  const params = goal ? `?goal=${goal}` : '';
  return request<any[]>(`/meta/paces${params}`);
}

export type LoggedSetPayload = {
  set_number: number;
  reps?: number;
  weight_lbs?: number;
  duration_seconds?: number | null;
  feedback?: string | null;
  rir?: number | null;
};

export type LoggedExercisePayload = {
  name: string;
  target_sets?: number | null;
  target_reps?: string | null;
  equipment?: string | null;
  order_index?: number;
  sets: LoggedSetPayload[];
};

/** Generate one day's workout using the deterministic planner with history.
 *  Returns fresh exercises that vary from recent sessions. */
export async function generateWorkoutDay(
  token: string,
  params: {
    goal: string;
    day_index: number;
    days_per_week: number;
    session_minutes?: number;
    experience?: string;
    equipment: string[];
    preferred_split?: string;
    priority_region?: string;
    injuries?: string[];
    disliked_exercises?: string[];
    focus_override?: string;
  },
): Promise<{ day: any; total_days_in_recipe: number; day_index: number; plan_name: string; readiness_score?: number }> {
  return request('/workouts/generate-day', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(params),
  }, 15000);
}

export async function logWorkoutStarted(
  token: string,
  workout_date: string,
  focus_label: string,
  stimulus?: string,
) {
  return request('/workouts/start', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ workout_date, focus_label, stimulus }),
  }, 10000);
}

export async function logWorkoutDone(
  token: string,
  workout_date: string,
  focus_label: string,
  duration_seconds: number,
  exercises?: LoggedExercisePayload[],
  activity?: {
    category?: string;
    subtype?: string;
    intensity?: string;
    source?: string;
    cardioStyle?: string;
  },
) {
  return request('/workouts/complete', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      workout_date,
      focus_label,
      duration_seconds,
      ...(exercises && exercises.length > 0 ? { exercises } : {}),
      ...(activity?.category ? {
        activity_category: activity.category,
        activity_subtype: activity.subtype,
        activity_intensity: activity.intensity,
        activity_source: activity.source,
        cardio_style: activity.cardioStyle,
      } : {}),
    }),
  });
}

/** Mid-workout sync: saves per-set detail to the backend WITHOUT flipping
 *  the "completed" marker. Used to back up logged sets as they happen so a
 *  force-quit or wiped AsyncStorage doesn't lose them. */
export async function syncInProgressWorkout(
  token: string,
  workout_date: string,
  focus_label: string,
  exercises: LoggedExercisePayload[],
): Promise<{ ok: boolean; session_id: number | null; exercises: number; sets: number }> {
  return request('/workouts/sync', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ workout_date, focus_label, exercises }),
  }, 10000);
}

export interface WorkoutCompletionRecord {
  id: number;
  workout_date: string;
  focus_label: string;
  duration_seconds: number;
  stimulus?: string | null;
  completed_at?: string | null;
  activity_category?: string | null;
  activity_subtype?: string | null;
  activity_intensity?: string | null;
}

/** Fetch the user's recent completion markers. Skeleton data only — no set
 *  detail. Used to rehydrate local workoutHistory after a wipe. */
export async function listWorkoutCompletions(
  token: string,
  limit: number = 100,
): Promise<WorkoutCompletionRecord[]> {
  return request(`/workouts/completions?limit=${limit}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export interface FatigueScore {
  readiness_score: number;
  readiness_label: string;
  muscle_fatigue: Record<string, number>;
  focus_readiness: Record<string, number>;
  top_fatigued: Array<{ muscle: string; value: number }>;
  blocked_focuses: string[];
  days_analyzed: number;
  activities: Array<{
    date: string;
    days_ago: number;
    focus: string;
    intensity: string;
  }>;
}

export async function getFatigueScore(token: string): Promise<FatigueScore> {
  return request<FatigueScore>('/workouts/fatigue', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export interface NutritionScoreResult {
  score: number;
  adherence: number;
  quality: number;
  micro: number;
  confidence: string;
  tags: string[];
  wins: string[];
  improvements: string[];
  likely_gaps: string[];
  indicators: Record<string, any>;
}

export async function getNutritionScore(token: string): Promise<NutritionScoreResult> {
  return request<NutritionScoreResult>('/profile/nutrition-score', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getWorkoutStatus(
  token: string,
  workout_date: string,
): Promise<{ done: boolean }> {
  return request(`/workouts/status?workout_date=${workout_date}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getGoalConfig() {
  return request<{
    weight_goals: string[];
    timeline_goals: string[];
    lifestyle_goals: string[];
    timeline_weeks: Record<string, Record<string, number>>;
  }>('/meta/goal-config');
}

export async function getDayState(token: string, dayKey: string) {
  return request<any>(`/profile/day-state/${dayKey}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function upsertDayState(
  token: string,
  dayKey: string,
  payload: { skipped_focus?: string | null; meal_checks?: Record<string, boolean>; nutrition_plan?: any },
) {
  return request('/profile/day-state/' + dayKey, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export async function submitWeeklyCheckin(
  token: string,
  body: { checkin_date: string; weight_lbs: number; waist_in?: number; energy: number; sleep: number; adherence: number; notes?: string },
) {
  return request('/profile/checkin', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export async function getInsights(token: string) {
  return request('/profile/insights', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─── AI Coach check-ins (phase 2 system) ─────────────────────────────────────

export type CoachCheckinFeedback = {
  energy?: number;           // 1–5
  hunger?: number;           // 1–5
  soreness?: number;         // 1–5
  motivation?: number;       // 1–5
  stress?: number;           // 1–5
  sleep_self?: number;       // 1–5
  schedule_issue?: boolean;
  adherence_self?: 'on' | 'mostly' | 'off';
  note?: string;
};

export type CoachFlag = {
  key: string;
  severity: 'low' | 'med' | 'high';
  value?: string | null;
};

export type CoachCheckinResponse = {
  decision_id: number | null;
  response_type: 'coach_only' | 'small_adjust' | 'deep_review' | 'leave_alone' | 'ask_more';
  message: string;
  delta: Record<string, number> | null;
  rationale_key: string | null;
  overrides: string[];
  applied_kcal_adjustment_total: number | null;
  flags: CoachFlag[];
  schema: string;
};

export async function submitCoachCheckin(
  token: string,
  body: { checkin_type?: 'micro' | 'weekly' | 'manual' | 'event'; feedback: CoachCheckinFeedback; dry_run?: boolean },
): Promise<CoachCheckinResponse> {
  return request('/coach/checkin', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ checkin_type: 'manual', ...body }),
  });
}

export async function getCoachFlags(token: string): Promise<{ flags: Array<CoachFlag & { active_since: string; last_evaluated: string; details?: any }> }> {
  return request('/coach/flags', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getCoachHistory(token: string, limit = 10): Promise<{ decisions: Array<{ id: number; created_at: string; checkin_type: string; response_type: string; rationale_key: string | null; delta: any; message: string | null; flags_snapshot: any; model: string | null }> }> {
  return request(`/coach/history?limit=${limit}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─── AI exercise search ──────────────────────────────────────────────────────

export type AIExerciseResult = {
  name: string;
  primary_muscle: string;
  equipment: string;
  sets: number;
  reps: string;
  rest_seconds: number;
  why: string;
  form_cues: string[];
  image_url?: string;
  source?: string;
};

/** Resolve an exercise name to a YouTube video ID for the top form
 *  tutorial. Cached server-side. Returns the primary `video_id` plus a
 *  `candidates` list so the client can fall back to the next video when
 *  a player-level error fires (152/153/etc) inside the iframe. */
export async function getExerciseVideo(
  token: string,
  exerciseName: string,
): Promise<{ video_id: string; candidates?: string[]; search_url: string; cached?: boolean }> {
  return request('/ai/exercise-video', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ exercise_name: exerciseName }),
  }, 12000);
}

export async function searchExerciseAI(
  token: string,
  body: {
    query: string;
    equipment?: string[];
    muscle_group?: string;
    injuries?: string[];
    /** Names the user already has in their library — AI should NOT return
     *  these. We also filter client-side in case the model slips up. */
    exclude?: string[];
  },
): Promise<{ results: AIExerciseResult[] }> {
  const res = await request<{ results: AIExerciseResult[] }>('/ai/exercise-search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  // Client-side dedupe belt-and-suspenders in case the backend prompt
  // still returns a known exercise.
  const excludeLower = new Set((body.exclude ?? []).map(n => n.toLowerCase()));
  const filtered = (res.results ?? []).filter(r => !excludeLower.has(r.name.toLowerCase()));
  return { results: filtered };
}

// ─── Async plan-job queue ────────────────────────────────────────────────────
//
// The client enqueues a plan-gen job, then polls for the result. This
// replaces the long synchronous fetch pattern so plan generation survives
// app backgrounding, screen lock, and force-close — the work runs entirely
// server-side and the client just picks up the result when it reconnects.

export type PlanJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface PlanJob {
  id: number;
  kind: string;
  status: PlanJobStatus;
  error: string | null;
  created_at: string | null;
  updated_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  has_result: boolean;
  /** Present only on `status === 'completed'`. */
  result?: any;
}

export async function enqueuePlanJob(token: string, planReq: any): Promise<PlanJob> {
  return request('/ai/plans/enqueue', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(planReq),
  }, 60000);
}

export async function getPlanJob(token: string, jobId: number): Promise<PlanJob> {
  // Longer timeout (60s) than the default 30s: the poll endpoint
  // itself is fast, but when the backend is running AI plan-review +
  // regenerate in a worker thread, the event loop can still briefly
  // stall on DB commits between stages. 60s swallows those without
  // aborting the poll.
  return request(`/ai/plans/job/${jobId}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 60000);
}

export async function cancelPlanJob(token: string, jobId: number): Promise<PlanJob> {
  return request(`/ai/plans/job/${jobId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getLatestPlanJob(token: string): Promise<{ job: PlanJob | null }> {
  return request('/ai/plans/jobs/latest', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getGuardrails(token: string) {
  return request<{ warnings: string[] }>('/profile/guardrails', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getCoachMemory(token: string) {
  return request<any[]>('/profile/coach-memory', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─── Calorie reference ranges ────────────────────────────────────────────────

export interface CalorieRanges {
  bmr: number;
  activity_multiplier: number;
  maintenance_calories: number;
  cut_calories: number;
  bulk_calories: number;
  cut_protein_g: number;
  maintain_protein_g: number;
  bulk_protein_g: number;
}

/** Cut / maintain / bulk calorie reference card for the signed-in user.
 *  Computed server-side by the same calorie_calculator module that drives
 *  the meal plan targets — read-only preview, doesn't change the user's
 *  actual goal. */
export async function getCalorieRanges(token: string): Promise<CalorieRanges> {
  return request('/profile/calorie-ranges', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─── Client-state cross-device sync ──────────────────────────────────────────

export async function getUserState(token: string): Promise<{ state: Record<string, any>; updated_at: string | null }> {
  return request('/profile/state', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function putUserState(token: string, state: Record<string, any>): Promise<void> {
  await request('/profile/state', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ state }),
  });
}

export async function getProgressionInsights(token: string, exerciseName: string) {
  return request<any>(`/workouts/progression/${encodeURIComponent(exerciseName)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getGroceryList(token: string, days = 3) {
  return request<{ days: number; items: Array<{ food: string; frequency: number }> }>(`/meals/grocery-list?days=${days}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getMealSwap(token: string, meal_type: string, foods: string[]) {
  const foodsQuery = foods.map(f => `foods=${encodeURIComponent(f)}`).join('&');
  return request<{ meal_type: string; original: string[]; suggested: string[] }>(`/meals/swap?meal_type=${encodeURIComponent(meal_type)}&${foodsQuery}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Match a natural language fitness description to the best goal. No auth needed. */
export async function matchGoal(
  description: string,
): Promise<{ goal_id: string; reason: string }> {
  return request<any>('/ai/match-goal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  }, 12000);
}

/** Look up a packaged food by barcode via OpenFoodFacts. */
export async function lookupBarcode(
  token: string,
  barcode: string,
): Promise<{ name: string; barcode: string; serving: string; calories: number; protein: number; carbs: number; fat: number; source: string }> {
  return request<any>('/ai/barcode-lookup', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ barcode }),
  }, 10000);
}

/** Search food nutrition info by name using AI. */
export async function searchFoodNutrition(
  token: string,
  query: string,
  opts?: { forceAi?: boolean },
): Promise<{ results: Array<{ name: string; serving: string; calories: number; protein: number; carbs: number; fat: number; fiber?: number; source?: 'usda' | 'ai' }> }> {
  return request<any>('/ai/food-search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, force_ai: opts?.forceAi ?? false }),
  }, 15000);
}

/** Enrich food items with micronutrients. Used for routine/custom foods
 *  that bypass normal plan gen enrichment. */
export async function enrichFoodItems(
  token: string,
  items: Array<{ name: string; quantity?: number; unit?: string }>,
): Promise<{ items: Array<{ name: string; micronutrients: Record<string, number> }> }> {
  return request<any>('/ai/plans/enrich-items', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ items }),
  }, 25000);
}

/** Parse natural language workout descriptions into structured sessions. */
export async function parseRecentWorkouts(
  token: string,
  text: string,
): Promise<{ sessions: Array<{ date: string; focus: string; completed: boolean; durationSeconds: number; exercises: any[] }> }> {
  return request<any>('/ai/parse-workouts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text, currentDate: new Date().toISOString().slice(0, 10) }),
  }, 30000);
}

export async function askTrainerQuestion(
  token: string,
  payload: {
    question: string;
    mode: 'trainer' | 'nutritionist';
    topic?: string | null;
    profile: any;
    workoutPlan?: any;
    nutritionPlan?: any;
    currentPlanContext?: {
      scheduleMapping?: Array<{ calendarDate: string; dayLabel: string; planDay: string; focus: string }>;
      workoutDays: Array<{ focus: string; exercises: Array<{ name: string; sets: number; reps: string }> }>;
      todayMeals: Array<{ type: string; meal: string; foods: string[]; calories: number; protein: number }>;
      mealRoutine?: string;
    };
    progress?: any;
    conversation?: Array<{ role: 'user' | 'assistant'; content: string }>;
    image_base64?: string;
    mime_type?: string;
    userContext?: string;
  },
): Promise<{
  answer: string;
  action_items: string[];
  needs_plan_update: boolean;
  safety_note: string;
  updated_workout_plan?: any | null;
  updated_nutrition_plan?: any | null;
  updated_injuries?: any[] | null;
  injury_clarification_needed?: boolean;
  logged_workouts?: Array<{ date: string; focus: string; durationSeconds: number; exercises: any[] }> | null;
}> {
  console.log('[askTrainerQuestion] SEND →', {
    mode: payload.mode,
    question: payload.question.slice(0, 120),
    hasImage: !!payload.image_base64,
    conversationLength: payload.conversation?.length ?? 0,
    hasUserContext: !!payload.userContext,
    profileKeys: Object.keys(payload.profile ?? {}),
    workoutDayCount: payload.workoutPlan?.days?.length ?? 0,
  });

  const resp = await request<{
    answer: string;
    action_items: string[];
    needs_plan_update: boolean;
    safety_note: string;
    updated_workout_plan?: any | null;
    updated_nutrition_plan?: any | null;
    updated_injuries?: any[] | null;
    injury_clarification_needed?: boolean;
  }>('/ai/trainer-question', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 90000, true);

  console.log('[askTrainerQuestion] RECV ←', {
    answerPreview: resp.answer?.slice(0, 150),
    needs_plan_update: resp.needs_plan_update,
    hasUpdatedWorkout: !!resp.updated_workout_plan,
    hasUpdatedNutrition: !!resp.updated_nutrition_plan,
    updatedWorkoutKeys: resp.updated_workout_plan ? Object.keys(resp.updated_workout_plan) : null,
    hasInjuries: !!(resp.updated_injuries?.length),
    injuryCount: resp.updated_injuries?.length ?? 0,
  });

  return resp;
}

export async function askWorkoutQuestion(
  token: string,
  payload: {
    question: string;
    workout: any;
    activeExerciseName?: string;
    currentSetNumber?: number;
    loggedSets?: any[];
  },
): Promise<{ answer: string; quick_cues: string[]; adjustment: string; safety_note: string }> {
  console.log('[askWorkoutQuestion] SEND →', {
    question: payload.question.slice(0, 120),
    activeExercise: payload.activeExerciseName,
    currentSet: payload.currentSetNumber,
    loggedSetsCount: payload.loggedSets?.length ?? 0,
  });

  const resp = await request<{ answer: string; quick_cues: string[]; adjustment: string; safety_note: string }>('/ai/workout-question', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 60000);

  console.log('[askWorkoutQuestion] RECV ←', {
    answerPreview: resp.answer?.slice(0, 150),
    quickCuesCount: resp.quick_cues?.length ?? 0,
    adjustment: resp.adjustment?.slice(0, 80),
  });

  return resp;
}

export async function analyzeFoodPhoto(
  token: string,
  payload: { image_base64: string; mime_type?: string },
): Promise<{
  meal_name: string;
  items: string[];
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}> {
  return request('/ai/food-photo', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export async function getMealInstructions(
  token: string,
  payload: {
    meal_name: string;
    items?: Array<{ name: string; quantity?: number; unit?: string }>;
    cooking_skill?: string;
    prep_time_minutes?: number;
    dietary_preference?: string;
    allergies?: string[];
    previous_variants?: string[];
  },
): Promise<{ instructions: string }> {
  return request('/ai/meal-instructions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 30000);
}

export async function scanFoodsPhoto(
  token: string,
  payload: {
    images: Array<{ image_base64: string; mime_type?: string }>;
    context?: string;
  },
): Promise<{
  foods: Array<{
    name: string;
    serving: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
  }>;
}> {
  return request('/ai/scan-foods', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 60000);
}

export async function lookupSupplementFromPhoto(
  token: string,
  payload: { image_base64: string; mime_type?: string },
): Promise<{
  found: boolean;
  name: string;
  category?: string;
  tagline?: string;
  whatItDoes?: string;
  evidence?: 'strong' | 'moderate' | 'limited';
  dose?: string;
  timing?: string;
  goodFor?: string[];
  cautions?: string;
}> {
  return request('/ai/supplement-photo', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export async function lookupSupplement(
  token: string,
  name: string,
): Promise<{
  found: boolean;
  name: string;
  category?: string;
  tagline?: string;
  whatItDoes?: string;
  evidence?: 'strong' | 'moderate' | 'limited';
  dose?: string;
  timing?: string;
  goodFor?: string[];
  cautions?: string;
}> {
  return request('/ai/supplement-info', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
}

export async function scanEquipmentPhoto(
  token: string,
  payload: { image_base64: string; mime_type?: string },
): Promise<{ equipment: string[] }> {
  return request('/ai/scan-equipment', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export async function getWorkoutSummary(
  token: string,
  payload: {
    exercises: import('../types').SessionExercise[];
    durationSeconds: number;
    focus: string;
    goal: string;
    weightLbs?: number;
  },
): Promise<import('../types').WorkoutSummary> {
  return request('/ai/workout-summary', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export type FoodVerificationVerdict = 'ok' | 'corrected' | 'insufficient_data';

export async function validateFoodMacros(
  token: string,
  payload: {
    name: string;
    servingLabel: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    micronutrients?: Record<string, number> | null;
  },
): Promise<{
  verdict: FoodVerificationVerdict;
  notes: string;
  corrected: {
    calories?: number | null;
    protein?: number | null;
    carbs?: number | null;
    fat?: number | null;
    micros?: Record<string, number> | null;
  } | null;
}> {
  return request('/ai/validate-food-macros', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export async function getPreSetRecommendation(
  token: string,
  payload: {
    exerciseName: string;
    exerciseSlug?: string | null;
    plannedSetNumber: number;
    plannedSets: any[];
    priorSetsThisSession?: any[];
    lastSessionSets?: any[];
    goal?: string;
    experienceLevel?: string;
    feelFromLastSet?: string;
    equipment?: string;
    weightLbs?: number;
  },
): Promise<{
  recommendedWeightLbs: number | null;
  recommendedReps: string;
  setType: string;
  intensityLabel: string;
  changeDirection: 'increase' | 'hold' | 'decrease';
  confidence: 'high' | 'medium' | 'low';
  rationaleShort: string;
  reasonTags: string[];
  askForFeelAfterSet: boolean;
  source: 'deterministic' | 'ai_review' | 'fallback';
}> {
  return request('/ai/pre-set-recommendation', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export async function getAiWarmup(
  token: string,
  payload: {
    focus: string;
    exercises: { name: string; equipment?: string | null }[];
    injuries?: string[];
    experience?: string;
    durationMinutes?: number;
  },
): Promise<{ steps: string[]; source: 'ai' | 'fallback' }> {
  return request('/ai/warmup', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export async function analyzeWorkoutFormPhoto(
  token: string,
  payload: { image_base64: string; mime_type?: string; exercise_name?: string; question?: string },
): Promise<{
  answer: string;
  quick_cues: string[];
  likely_target: string;
  red_flags: string[];
  safety_note: string;
}> {
  return request('/ai/form-photo', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export interface BodyScanResult {
  bodyFatPct: number;
  bodyFatRange: string;
  muscleMass: string;
  category: string;
  strengths: string[];
  improvements: string[];
  assessment: string;
  disclaimer: string;
}

// ─── Meal history ────────────────────────────────────────────────────────────

export interface MealHistoryItem {
  food_name: string;
  quantity: number;
  unit: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

export interface MealHistoryEntry {
  id: number;
  meal_date: string;
  meal_type: string | null;
  name: string;
  source: string | null;
  items: MealHistoryItem[];
  totals: { calories: number; protein_g: number; carbs_g: number; fat_g: number };
}

export interface MealAverages {
  window_days: number;
  days_with_data: number;
  avg_calories: number;
  avg_protein_g: number;
  avg_carbs_g: number;
  avg_fat_g: number;
  avg_meals_per_day: number;
  total_meals_logged: number;
}

export async function logMealChecked(
  token: string,
  payload: { meal_date: string; meal_type: string; meal: Record<string, any>; source?: string },
): Promise<{ id: number }> {
  return request('/meals/log-checked', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 10000, true);  // noRetry — fire and forget, don't block UI
}

export async function getMealHistory(token: string, days = 30): Promise<{ meals: MealHistoryEntry[] }> {
  return request(`/meals/history?days=${days}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getMealAverages(token: string, window = 7): Promise<MealAverages> {
  return request(`/meals/averages?window=${window}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getMealInsights(token: string): Promise<{ insights: string[]; patterns: Record<string, any> }> {
  return request('/meals/insights', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getCommonMeals(token: string): Promise<{ meals: Array<{ name: string; count: number; avg_calories: number; avg_protein_g: number; avg_carbs_g: number; avg_fat_g: number }> }> {
  return request('/meals/common', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function scanBody(
  token: string,
  payload: {
    image_base64: string;
    mime_type?: string;
    gender?: string;
    weight_lbs?: number;
    height_inches?: number;
    age?: number;
  },
): Promise<BodyScanResult> {
  return request('/ai/body-scan', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 45000);
}

