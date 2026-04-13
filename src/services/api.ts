import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';

const LOCAL_BACKEND_IP = '192.168.1.220'; // your dev machine's LAN IP

function getBaseUrl(): string {
  if (__DEV__) {
    const hostUri = Constants.expoConfig?.hostUri ?? '';
    // In tunnel mode (ngrok/exp.direct), hostUri is the ngrok domain — can't use it
    // for the backend. Fall back to the machine's actual LAN IP instead.
    const isTunnel = hostUri.includes('ngrok') || hostUri.includes('exp.direct') || !hostUri;
    const host = isTunnel ? LOCAL_BACKEND_IP : (hostUri.split(':')[0] ?? LOCAL_BACKEND_IP);
    return `http://${host}:8000`;
  }
  return 'https://your-production-api.com';
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
    .map((e: any) => `${e.description} (${e.bodyPart}, status: ${e.status})`);
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
    focusedMuscleGroup:     profile.focusedMuscleGroup,
    goalDetails:            profile.goalDetails,
    physicalStats:          profile.physicalStats,
    daysPerWeek:            profile.daysPerWeek,
    workoutDurationMinutes: profile.workoutDurationMinutes,
    equipment:              profile.equipment,
    foodsAvailable:         profile.foodsAvailable,
    supplementsAvailable:   profile.supplementsAvailable ?? [],
    experienceLevel:        profile.experienceLevel,
    injuriesOrLimitations,
    mealRoutine:            mealRoutineText,
    routineMacros:          routinePayload?.routineMacros,
    routineSlots:           routinePayload?.routineSlots ?? [],
    mealsPerDay:            Math.max(1, Math.min(10, profile.mealsPerDay ?? 3)),
    mealVariety:            Math.max(1, Math.min(7, profile.mealVariety ?? 3)),
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
    focusedMuscleGroup:     profile.focusedMuscleGroup,
    goalDetails:            profile.goalDetails,
    physicalStats:          profile.physicalStats,
    daysPerWeek:            profile.daysPerWeek,
    workoutDurationMinutes: profile.workoutDurationMinutes,
    equipment:              profile.equipment,
    foodsAvailable:         [],
    experienceLevel:        profile.experienceLevel,
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
  });
  await writePendingPlanJob(job.id, 'workout');
  const result = await _pollPlanJobUntilDone(token, job.id);

  console.log('[getAIWorkoutPlan] RECV ←', {
    trainerNote: result?.trainerNote?.slice(0, 80) ?? 'MISSING',
    workoutDays: result?.workout_plan?.days?.length ?? 0,
  });
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
    mealVariety:          Math.max(1, Math.min(7, profile.mealVariety ?? 3)),
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
  });
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
  },
): Promise<{ weightLbs: number; reps: number; tip: string }> {
  return request('/ai/recommend-weight', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ exerciseName, goal, lastSets, nextSetNumber, ...options }),
  });
}

export async function syncOnboarding(token: string, profile: import('../types').UserProfile) {
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
        goal_type:         profile.goal,
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

export async function logWorkoutDone(
  token: string,
  workout_date: string,
  focus_label: string,
  duration_seconds: number,
) {
  return request('/workouts/complete', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ workout_date, focus_label, duration_seconds }),
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
};

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
  });
}

export async function getPlanJob(token: string, jobId: number): Promise<PlanJob> {
  return request(`/ai/plans/job/${jobId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
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
    body: JSON.stringify(state),
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

/** Search food nutrition info by name using AI. */
export async function searchFoodNutrition(
  token: string,
  query: string,
): Promise<{ results: Array<{ name: string; serving: string; calories: number; protein: number; carbs: number; fat: number; fiber?: number }> }> {
  return request<any>('/ai/food-search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query }),
  }, 15000);
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
  });

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

