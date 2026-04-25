import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';

const LOCAL_BACKEND_IP = '192.168.1.246'; // your dev machine's LAN IP

/** Exported for callers that need to hit the API outside the `request`
 *  helper (e.g. direct `fetch` for endpoints that return binary/large
 *  payloads). Same resolution logic — dev override → LAN IP → prod URL. */
export function getApiBaseUrl(): string {
  return getBaseUrl();
}

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

export async function resetPassword(email: string, answer: string, newPassword: string): Promise<{ access_token: string }> {
  return request('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ email, answer, new_password: newPassword }),
  });
}

export async function getRecoveryQuestion(email: string): Promise<{ question: string }> {
  return request(`/auth/recovery-question?email=${encodeURIComponent(email)}`, {}, 15000, true);
}

export async function setRecoveryQuestion(token: string, question: string, answer: string) {
  return request('/auth/set-recovery-question', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ question, answer }),
  });
}

export async function getMe(token: string) {
  return request('/auth/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function updateEmail(token: string, email: string) {
  return request<{ email: string }>('/auth/update-email', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ email }),
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
        birthdate:    data.profile.birthdate ?? undefined,
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

/** Shape returned by `GET /ai/plans/active-workout`. `plan_json` is the
 *  same dict that goes into `AsyncStorage['aiWorkoutPlan']`. */
export interface ActiveWorkoutPlan {
  id: number;
  planner_version: string;
  goal: string;
  days_per_week: number;
  preferred_split: string | null;
  created_at: string | null;
  plan_json: any;  // full workout plan dict; see WorkoutPlan.plan_json
}

/** Fetch the user's active workout plan from the backend. Returns null
 *  on 404 (no plan yet / legacy user) so callers can fall back cleanly
 *  to the AsyncStorage path. Any other network/server error bubbles. */
export async function getActiveWorkoutPlan(token: string): Promise<ActiveWorkoutPlan | null> {
  try {
    return await request<ActiveWorkoutPlan>('/ai/plans/active-workout', {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e: any) {
    // 404 → no active plan; treat as "use local cache". Any message
    // containing "no active" matches the backend detail string.
    const msg = String(e?.message ?? '');
    if (msg.includes('no active') || msg.includes('404')) return null;
    throw e;
  }
}

/** Shape returned by `GET /ai/plans/active-nutrition`. `plans_json` is
 *  the parsed list of daily nutrition templates the client rotates
 *  through — the same array that goes into `AsyncStorage['aiNutritionPlans']`. */
export interface ActiveNutritionPlan {
  id: number;
  planner_version: string;
  goal: string;
  days_per_week: number;
  trainer_note: string | null;
  created_at: string | null;
  plans_json: any[];
}

/** Fetch the user's active nutrition plan from the backend. Returns
 *  null on 404 (no plan yet / legacy user / malformed row) so callers
 *  can fall back cleanly to the AsyncStorage path. Other
 *  network/server errors bubble. Mirrors `getActiveWorkoutPlan`. */
export async function getActiveNutritionPlan(token: string): Promise<ActiveNutritionPlan | null> {
  try {
    return await request<ActiveNutritionPlan>('/ai/plans/active-nutrition', {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e: any) {
    const msg = String(e?.message ?? '');
    if (msg.includes('no active') || msg.includes('unreadable') || msg.includes('404')) return null;
    throw e;
  }
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
    customFoodNames:        (profile.customFoods ?? []).map(f => f.name).filter(Boolean),
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
    /** Planner-propagated anchor (already history-aware). Tier 2 in the
     *  backend pipeline — beats all client-side bests when present. */
    plannedTargetWeightLbs?: number;
    /** Canonical slug — lets the backend skip name-based lookup. */
    exerciseSlug?: string;
    /** Equipment the exercise is performed with (e.g. "barbell").
     *  Biases the progression increment (barbell +5 vs dumbbell +2.5). */
    equipment?: string;
    /** Primary muscle slug — used as a transfer target when the exact
     *  exercise has no direct history. */
    primaryMuscle?: string;
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
        birthdate:     profile.physicalStats.birthdate ?? null,
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

export async function updatePhysicalStats(
  token: string,
  stats: { weightLbs: number; heightFeet: number; heightInches: number; age: number; birthdate?: string; gender: string },
) {
  return request('/profile/physical-stats', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      weight_lbs:    stats.weightLbs,
      height_feet:   stats.heightFeet,
      height_inches: stats.heightInches,
      age:           stats.age,
      birthdate:     stats.birthdate ?? null,
      gender:        stats.gender,
    }),
  });
}

/** Backfill endpoint for existing users — stores the birthdate and
 *  re-derives the cached `age` int server-side. Used by the HomeScreen
 *  soft prompt so users who signed up before birthday collection can
 *  add it without re-entering the rest of their stats. */
export async function updateBirthdate(token: string, birthdate: string): Promise<{ status: string; age: number }> {
  return request<{ status: string; age: number }>('/profile/birthdate', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ birthdate }),
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
// v3: bumped when `gear` (concrete equipment list) was added to the
// library schema — old v2 caches didn't include it, so the detail page
// was still falling back to the "Home" bucket label. Bump the suffix
// any time the shape or required fields change.
const EXERCISE_LIBRARY_CACHE_KEY = 'exercise_library_cache_v3';
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
export async function generateWorkoutWeek(
  token: string,
  payload: {
    goal: string;
    days_per_week: number;
    session_minutes?: number;
    experience?: string;
    equipment?: string[];
    preferred_split?: string;
    priority_region?: string;
    injuries?: string[];
    disliked_exercises?: string[];
    /** Pin day + focus. When set, the planner builds a coherent rotation
     *  around that choice. All other days rotate away from the pinned focus. */
    pin_day_index?: number | null;
    pin_focus?: string | null;
    /** User's CURRENT plan in visual order. When provided alongside a
     *  pin, the backend pins against this week (single-day swap)
     *  instead of generating a fresh week. Without this, the pin
     *  lands on a freshly-generated plan whose day indices may not
     *  match the visual schedule the user tapped. */
    current_days?: any[] | null;
  },
): Promise<{
  days: any[];
  total_days_in_recipe: number;
  plan_name: string;
  focus_readiness: Record<string, number>;
}> {
  return request('/workouts/generate-week', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

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
    // Preceding-day focuses the user has already fixed in their
    // current plan but haven't completed yet. Most-recent LAST (natural
    // plan order). Backend normalizes these into the recent-focus
    // rotation so single-day generation respects the split pattern.
    prev_focuses?: string[];
  },
): Promise<{ day: any; total_days_in_recipe: number; day_index: number; plan_name: string; readiness_score?: number; fatigue_notice?: string | null }> {
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

export interface PRAchievement {
  exercise_name: string;
  kind: 'heaviest_weight' | 'estimated_1rm' | 'volume_record';
  new_value: number;
  old_value: number;
  set_id?: number | null;
  reps?: number | null;
  weight_lbs?: number | null;
}

export interface WorkoutCompleteResponse {
  ok: boolean;
  structured_persisted?: boolean;
  prs?: PRAchievement[];
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
  healthMetrics?: {
    caloriesBurned?: number;
    hrSummary?: { avgBpm: number; maxBpm: number; zoneMinutes: number[] };
  },
  feedback?: {
    feeling?: string;       // "great"|"good"|"okay"|"rough"
    intensity?: number;     // 1..5
    sorenessAreas?: string[];
    notes?: string;
  },
): Promise<WorkoutCompleteResponse> {
  return request<WorkoutCompleteResponse>('/workouts/complete', {
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
      ...(healthMetrics?.caloriesBurned ? { calories_burned: healthMetrics.caloriesBurned } : {}),
      ...(healthMetrics?.hrSummary ? { hr_summary: healthMetrics.hrSummary } : {}),
      ...(feedback?.feeling ? { feeling: feedback.feeling } : {}),
      ...(feedback?.intensity ? { intensity: feedback.intensity } : {}),
      ...(feedback?.sorenessAreas && feedback.sorenessAreas.length > 0 ? { soreness_areas: feedback.sorenessAreas } : {}),
      ...(feedback?.notes ? { feedback_notes: feedback.notes } : {}),
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
  focus_readiness: Record<string, number>;  // 0.0-1.0 floats (NOT 0-100)
  top_fatigued: Array<{ muscle: string; value: number }>;
  blocked_focuses: string[];
  days_analyzed: number;
  activities: Array<{
    date: string;
    days_ago: number;
    focus: string;
    intensity: string;
  }>;
  nutrition_context?: {
    protein_avg: number;
    protein_status: 'excellent' | 'good' | 'low' | 'very_low' | 'no_data' | 'unknown';
    message?: string | null;
    recovery_bonus_applied: boolean;
    calories_avg?: number;
  };
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

// Legacy — kept for backward compat with older Progress screen paths.
// New code should call `getNutritionScore` (returns today + weekly unified payload).
export async function getLegacyNutritionScore(token: string): Promise<NutritionScoreResult> {
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
  // Patch semantics — only send fields the caller actually wants to change.
  // Backend treats omitted fields as "leave existing value alone" (since the
  // old behavior of always re-writing meal_checks from React state was
  // propagating stale check state across plan regenerations).
  const body: Record<string, any> = {};
  if (payload.skipped_focus === null) {
    body.clear_skipped_focus = true;
  } else if (payload.skipped_focus !== undefined) {
    body.skipped_focus = payload.skipped_focus;
  }
  if (payload.meal_checks !== undefined) body.meal_checks = payload.meal_checks;
  if (payload.nutrition_plan !== undefined) body.nutrition_plan = payload.nutrition_plan;
  return request('/profile/day-state/' + dayKey, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
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

// ─── Sleep persistence ─────────────────────────────────────────────────
//
// Mirror per-night sleep snapshots to the backend so history survives
// device wipes, sign-in on a new device, and feeds the personalized
// sleep score baseline (needs 14+ nights). Endpoint is upsert-by
// (user, night_date), so calling repeatedly is safe.

export type SleepNightlyPayload = {
  night_date: string;                          // YYYY-MM-DD (waking date)
  total_hours?: number | null;
  in_bed_minutes?: number | null;
  deep_hours?: number | null;
  rem_hours?: number | null;
  core_hours?: number | null;
  awake_minutes?: number | null;
  hrv_ms?: number | null;
  resting_hr?: number | null;
  respiratory_rate?: number | null;
  spo2_percent?: number | null;
  bedtime_minutes_from_midnight?: number | null;
  score?: number | null;
  rating?: string | null;
  mode?: string | null;
  source?: string | null;
};

export async function upsertNightlySleep(token: string, payload: SleepNightlyPayload) {
  return request('/sleep/nightly', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export async function getSleepHistory(token: string, days: number = 30) {
  return request<any[]>(`/sleep/history?days=${days}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─── Daily Apple Health snapshot (per user per day) ──────────────────────────
//
// Phone-side aggregator (`healthDataSummary.ts`) only knows today + a
// 30-min stale window. Persisting per-day means weekly_review,
// recovery_flags, and check-in coach can read real history server-side
// without re-querying HealthKit.

export type DailyHealthSnapshotPayload = {
  snapshot_date: string;                      // YYYY-MM-DD
  steps?: number | null;
  active_energy_kcal?: number | null;
  workout_minutes?: number | null;
  cardio_minutes?: number | null;
  zone2_minutes?: number | null;
  resting_hr?: number | null;
  hrv_ms?: number | null;
  vo2_max?: number | null;
  weight_lbs?: number | null;
  readiness_score?: number | null;
  source?: string | null;
};

export async function upsertDailyHealthSnapshot(token: string, payload: DailyHealthSnapshotPayload) {
  return request('/health/snapshot', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export async function upsertDailyHealthSnapshotBatch(token: string, payloads: DailyHealthSnapshotPayload[]) {
  return request('/health/snapshot/batch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payloads),
  });
}

export async function getDailyHealthHistory(token: string, days: number = 30) {
  return request<any[]>(`/health/history?days=${days}`, {
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
  }, 45000);
}

export async function classifyFoods(
  token: string,
  names: string[],
): Promise<{ classifications: Array<{ name: string; protein_source: string; fermented: boolean; probiotic: boolean; omega3_rich: boolean; plant_count: number; food_quality: string }> }> {
  return request<any>('/ai/classify-foods', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ names }),
  }, 10000);
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
  /** Quick-intent router output — when present, the answer was a
   *  canned response for one of the 12 known intents, and the action
   *  dict can be passed directly to applyRecommendationAction. */
  intent?: string | null;
  action?: Record<string, any> | null;
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
    intent?: string | null;
    action?: Record<string, any> | null;
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
  // 60s timeout — AI vision calls on label photos routinely take
  // 25-45s. Default 30s was timing out mid-flight, leaving the UI
  // stuck on the spinner state and reading as "frozen."
  return request('/ai/supplement-photo', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 60000);
}

export type ScannedSupplement = {
  name: string;
  category: string;
  dose_amount: number | null;
  dose_unit: string;
  evidence_tier: 'strong' | 'moderate' | 'limited' | 'weak';
  risk_tier: 'low' | 'moderate' | 'high';
  timing_notes?: string | null;
  safety_notes?: string | null;
};

/** Multi-supplement photo scan — AI identifies every bottle/container
 *  visible and returns a list for the user to review + confirm. */
export async function scanSupplementsMulti(
  token: string,
  payload: { image_base64: string; mime_type?: string },
): Promise<{ supplements: ScannedSupplement[]; count: number }> {
  return request('/ai/scan-supplements', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 60000);
}


// ─── Speech-to-meal ─────────────────────────────────────────────────────────

export type SpokenFoodItem = {
  name: string;
  quantity: number;
  unit: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  micronutrients?: Record<string, number>;
};

/** Two-stage speech-to-meal: audio → Whisper transcript → structured
 *  food items with estimated macros. User reviews before it lands in
 *  the meal editor. */
export async function speechToMeal(
  token: string,
  payload: { audio_base64: string; mime_type?: string },
): Promise<{ transcript: string; items: SpokenFoodItem[] }> {
  return request('/ai/speech-to-meal', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 60000);
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

export interface GutHealthToday {
  date: string;
  calories_total: number;
  fiber_total_g: number;
  fiber_per_1000_kcal: number;
  added_sugar_g: number;
  sodium_mg: number;
  saturated_fat_g: number;
  distinct_plant_foods: number;
  fermented_servings: number;
  probiotic_servings: number;
  omega3_servings: number;
  /** AI-estimated grams of collagen from today's logged items. */
  collagen_g: number;
  seafood_servings: number;
  fruit_servings: number;
  vegetable_servings: number;
  alcohol_servings: number;
  processed_meat_servings: number;
  refined_grain_servings: number;
  plant_protein_g: number;
  animal_protein_g: number;
  plant_protein_pct: number;
  processing_counts: Record<string, number>;
  max_meal_protein_pct: number;
  classified_item_count: number;
  item_count: number;
}

export interface GutHealthWindow {
  days_with_data: number;
  window_days: number;
  avg_calories: number;
  avg_fiber_g: number;
  avg_fiber_per_1000_kcal: number;
  avg_added_sugar_g: number;
  avg_sodium_mg: number;
  avg_saturated_fat_g: number;
  pct_days_fiber_target: number;
  distinct_plant_foods_week: number;
  fermented_servings: number;
  probiotic_servings: number;
  omega3_servings: number;
  /** AI-estimated collagen grams across the full window. */
  collagen_g: number;
  /** AI-estimated average collagen grams per logged day. */
  avg_collagen_g: number;
  seafood_servings: number;
  fruit_servings: number;
  vegetable_servings: number;
  alcohol_servings: number;
  processed_meat_servings: number;
  refined_grain_servings: number;
  plant_protein_g: number;
  animal_protein_g: number;
  plant_protein_pct: number;
  processing_counts: Record<string, number>;
  calorie_stability_cv: number;
}

export async function getGutHealth(token: string, days = 7): Promise<{ today: GutHealthToday | null; window: GutHealthWindow }> {
  return request(`/meals/gut-health?days=${days}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// Plant vs animal protein breakdown for today — per-food list so the
// NutritionCard tile can drill into a modal showing each contributing
// item. Mixed items split 50/50 between plant + animal.
export interface ProteinBreakdownItem {
  name: string;
  protein_g: number;
}
export interface ProteinBreakdown {
  date: string;
  plant_total_g: number;
  animal_total_g: number;
  plant_pct: number;
  animal_pct: number;
  plant: ProteinBreakdownItem[];
  animal: ProteinBreakdownItem[];
  unclassified: ProteinBreakdownItem[];
}
export async function getProteinBreakdown(token: string): Promise<ProteinBreakdown> {
  return request(`/meals/protein-breakdown`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// Unified Nutrition Score — server-side authority.
export interface NutritionScoreBreakdownItem {
  label: string;
  value_pct: number;     // 0-100 for bar
  raw: number;
  target: number | null;
  unit: string;
  on_track: boolean;
}

export interface NutritionScoreToday {
  date: string;
  score: number;
  adherence: number;
  quality: number;
  micro: number;
  confidence: 'low' | 'medium' | 'high';
  wins: string[];
  improvements: string[];
  tags: string[];
  likely_gaps: string[];
  flags: Record<string, boolean>;
  indicators: Record<string, any>;
  adherence_breakdown: NutritionScoreBreakdownItem[];
  quality_breakdown: NutritionScoreBreakdownItem[];
  micro_breakdown: NutritionScoreBreakdownItem[];
  targets: { calories: number; protein_g: number };
  totals: { calories: number; protein_g: number };
  goal: string;
  score_version: number;
}

export interface NutritionScoreWeeklyDay {
  date: string;
  score: number | null;
  adherence?: number;
  quality?: number;
  micro?: number;
  logged: boolean;
}

export interface NutritionScoreWeekly {
  window_days: number;
  days_with_data: number;
  end_date: string;
  avg_score: number;
  daily: NutritionScoreWeeklyDay[];
  days_hit_protein: number;
  days_hit_fiber: number;
  days_hit_calories: number;
  calorie_stability_cv: number;
  energy_availability: {
    avg_ea_kcal_per_kg_ffm: number;
    ffm_kg: number;
    days_with_data: number;
    daily: Array<{ date: string; ea: number | null; logged: boolean; intake_kcal?: number; exercise_kcal?: number }>;
  } | null;
  rollup: GutHealthWindow;
}

export async function getNutritionScore(token: string, days = 7): Promise<{ today: NutritionScoreToday; weekly: NutritionScoreWeekly }> {
  return request(`/meals/score?days=${days}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// Fueling & Recovery Signals — flag-based, not scored.
export interface RecoveryFlag {
  key: string;
  state: 'green' | 'amber' | 'red' | 'not_enough_data';
  label: string;
  detail: string;
  action: string | null;
  numbers: Record<string, any> | null;
}

export async function getRecoveryFlags(
  token: string,
  opts: { days?: number; thyroid_opt_in?: boolean } = {},
): Promise<{ flags: RecoveryFlag[]; any_actionable: boolean }> {
  const days = opts.days ?? 7;
  const thy = opts.thyroid_opt_in ? '&thyroid_opt_in=true' : '';
  return request(`/meals/recovery-flags?days=${days}${thy}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// Hydration — daily log + target (half bodyweight in oz by default).
export async function getHydration(token: string): Promise<{ date: string; ounces: number; target_ounces: number }> {
  return request('/meals/hydration', { headers: { Authorization: `Bearer ${token}` } });
}

export async function logHydration(token: string, ounces: number): Promise<{ date: string; ounces: number }> {
  return request('/meals/hydration', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ounces }),
  });
}

export async function getCommonMeals(token: string): Promise<{ meals: Array<{ name: string; count: number; avg_calories: number; avg_protein_g: number; avg_carbs_g: number; avg_fat_g: number }> }> {
  return request('/meals/common', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ── Weekly digest (Feature 3) ──────────────────────────────────────────────

export interface WeeklyDigest {
  week_start: string;
  week_end: string;
  sessions: {
    completed: number;
    distinct_days: number;
    planned: number;
    adherence_pct: number;
    focus_distribution: Record<string, number>;
    stimulus_distribution: Record<string, number>;
    duration_seconds: number;
  };
  volume: { total_sets: number; volume_load_lbs: number };
  prs: PRAchievement[] & Array<{ session_date?: string }>;
  pr_count: number;
  nutrition: {
    avg_calories: number;
    avg_protein_g: number;
    days_logged: number;
    target_protein_g: number | null;
    protein_hit_pct: number | null;
  };
  prior_week: {
    completed: number;
    distinct_days: number;
    total_sets: number;
    volume_load_lbs: number;
    avg_calories: number;
    avg_protein_g: number;
  };
  deltas: {
    sessions: number;
    distinct_days: number;
    total_sets: number;
    volume_load_lbs: number;
    avg_calories: number;
    avg_protein_g: number;
  };
}

export async function getWeeklyDigest(token: string): Promise<WeeklyDigest> {
  return request('/ai/weekly-digest', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ── Adherence trend ──────────────────────────────────────────────────────────

export interface AdherenceWeek {
  week_start: string;
  week_end: string;
  planned: number;
  completed: number;
  compliance_pct: number;
  total_volume: number;
}

export async function getAdherenceTrend(token: string, weeks = 8): Promise<{ weeks: AdherenceWeek[] }> {
  return request(`/ai/adherence-trend?weeks=${weeks}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ── Plateau detection (Feature 5) ──────────────────────────────────────────

export interface PlateauEntry {
  exercise_name: string;
  current_1rm: number;
  weeks_stuck: number;
  suggestion: 'deload' | 'swap' | 'add_volume';
  peak_by_week: number[];
}

export async function getPlateaus(token: string, windowWeeks = 4): Promise<{ plateaus: PlateauEntry[] }> {
  return request(`/ai/plateaus?window_weeks=${windowWeeks}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ── Streak + consistency (Feature 8) ───────────────────────────────────────

export interface StreakSummary {
  current_streak: number;
  longest_streak: number;
  compliance_7d: number;
  compliance_30d: number;
  last_active_date: string | null;
}

export async function getStreak(token: string): Promise<StreakSummary> {
  return request('/workouts/streak', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ── Muscle Balance ───────────────────────────────────────────────────────────

export interface MuscleBalanceEntry { sets: number; pct: number }

export interface MuscleBalanceResult {
  muscles: Record<string, MuscleBalanceEntry>;
  period_days: number;
  total_sets: number;
  balance_score: number;
}

export async function getMuscleBalance(token: string, days = 14): Promise<MuscleBalanceResult> {
  return request(`/ai/muscle-balance?days=${days}`, {
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


// ─── Saved Meals ─────────────────────────────────────────────────────────────

export type SavedMealItem = {
  food_name: string;
  food_id?: number | null;
  serving_id?: number | null;
  quantity: number;
  unit: string;
  serving_grams?: number | null;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
};

export type SavedMeal = {
  id: number;
  user_id: number;
  name: string;
  notes?: string | null;
  total_calories: number;
  total_protein_g: number;
  total_carbs_g: number;
  total_fat_g: number;
  items: SavedMealItem[];
  times_logged: number;
  last_logged_at?: string | null;
  created_at: string;
};

export async function listSavedMeals(token: string): Promise<SavedMeal[]> {
  return request('/meals/saved', { headers: { Authorization: `Bearer ${token}` } });
}

export async function createSavedMeal(
  token: string,
  body: { name: string; notes?: string | null; items?: SavedMealItem[]; from_meal_id?: number },
): Promise<SavedMeal> {
  return request('/meals/saved', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export async function deleteSavedMeal(token: string, savedId: number): Promise<void> {
  await request(`/meals/saved/${savedId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Edit the saved-meal template. Past logs (meals already on your
 *  calendar) are snapshots and DO NOT change. Only future logs pull
 *  from the updated template. */
export async function updateSavedMeal(
  token: string,
  savedId: number,
  patch: { name?: string; notes?: string | null; items?: SavedMealItem[] },
): Promise<SavedMeal> {
  return request(`/meals/saved/${savedId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(patch),
  });
}

export async function logSavedMeal(
  token: string,
  savedId: number,
  body: { meal_date?: string; meal_type?: string; consumed_at?: string },
): Promise<{ meal_id: number; saved_meal_id: number; times_logged: number }> {
  return request(`/meals/saved/${savedId}/log`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}


// ─── Meal editing (patch consumed_at / meal_type) ────────────────────────────

export async function updateMeal(
  token: string,
  mealId: number,
  patch: { meal_type?: string; consumed_at?: string | null; notes?: string | null; name?: string },
): Promise<any> {
  return request(`/meals/${mealId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(patch),
  });
}


// ─── Supplements ────────────────────────────────────────────────────────────

export type SupplementIngredient = {
  id: number;
  slug: string;
  name: string;
  category: string;
  default_unit: string;
  evidence_tier: 'strong' | 'moderate' | 'limited' | 'weak';
  risk_tier: 'low' | 'moderate' | 'high';
  description?: string | null;
  timing_notes?: string | null;
  safety_notes?: string | null;
};

export type StackItem = {
  id: number;
  user_id: number;
  supplement_ingredient_id?: number | null;
  supplement_product_id?: number | null;
  custom_name?: string | null;
  category?: string | null;
  goal?: string | null;
  dose_amount: number;
  dose_unit: string;
  frequency: string;
  timing?: string | null;
  taken_with_food: boolean;
  active: boolean;
  notes?: string | null;
  evidence_tier?: string | null;
  risk_tier?: string | null;
  timing_notes?: string | null;
  safety_notes?: string | null;
  created_at: string;
};

export type TodayStackItem = StackItem & {
  logs_today: Array<{ id: number; taken_at: string; skipped: boolean; dose_amount?: number | null }>;
};

export type SupplementRecommendation = {
  slug: string | null;
  title: string;
  reason: string;
  cautious_guidance: string;
  evidence_tier: string;
  risk_tier: string;
  priority: 'high' | 'moderate' | 'low';
};

export async function listSupplementIngredients(): Promise<SupplementIngredient[]> {
  return request('/supplements/ingredients');
}

export async function listStack(token: string, includeInactive = false): Promise<StackItem[]> {
  const qs = includeInactive ? '?include_inactive=true' : '';
  return request(`/supplements/stack${qs}`, { headers: { Authorization: `Bearer ${token}` } });
}

export async function addStackItem(token: string, body: Partial<StackItem> & { supplement_ingredient_id?: number; custom_name?: string; dose_amount: number; dose_unit: string }): Promise<StackItem> {
  return request('/supplements/stack', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export async function updateStackItem(token: string, stackId: number, patch: Partial<StackItem>): Promise<StackItem> {
  return request(`/supplements/stack/${stackId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(patch),
  });
}

export async function deleteStackItem(token: string, stackId: number): Promise<void> {
  await request(`/supplements/stack/${stackId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function logDose(
  token: string,
  stackId: number,
  body: { taken_at?: string; skipped?: boolean; dose_amount?: number; dose_unit?: string } = {},
): Promise<any> {
  return request(`/supplements/stack/${stackId}/log`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export async function getTodaySupplements(token: string): Promise<TodayStackItem[]> {
  return request('/supplements/today', { headers: { Authorization: `Bearer ${token}` } });
}

// AI-layered supplement recommendations — catches supplements the
// deterministic engine doesn't know about (adaptogens, niche stuff
// like CoQ10 for statin users, collagen for joint goals). Cached
// server-side per user, 14-day TTL, auto-invalidates on context change.
export type AISupplementRecommendation = SupplementRecommendation & {
  ai_generated?: boolean;
};
export async function getAISupplementRecommendations(
  token: string,
  force_refresh: boolean = false,
): Promise<{
  recommendations: AISupplementRecommendation[];
  generated_at: string;
  from_cache: boolean;
}> {
  const qs = force_refresh ? '?force_refresh=true' : '';
  return request(`/supplements/ai-recommendations${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 60000);
}

export async function getSupplementRecommendations(token: string): Promise<{
  recommendations: SupplementRecommendation[];
  warnings: { duplicate_ingredient_ids: number[] };
}> {
  return request('/supplements/recommendations', { headers: { Authorization: `Bearer ${token}` } });
}

export async function getSupplementInsights(token: string): Promise<{
  insights: Array<{ key: string; severity: 'info' | 'warning'; title: string; body: string }>;
}> {
  return request('/supplements/insights', { headers: { Authorization: `Bearer ${token}` } });
}


// ─── Adaptive macros ────────────────────────────────────────────────────────

export type AdaptiveMacroResult = {
  status: 'ok' | 'need_more_data';
  estimated_tdee: number | null;
  current_target: number | null;
  suggested_target: number | null;
  delta: number | null;
  avg_daily_calories: number | null;
  weekly_weight_change_lbs: number | null;
  days_logged: number;
  weigh_ins: number;
  confidence: 'low' | 'medium' | 'high';
  reason: string;
  goal_bucket: string | null;
};

export async function getAdaptiveMacros(
  token: string,
  weightEntries: Array<{ date: string; weight_lbs: number }>,
): Promise<AdaptiveMacroResult> {
  return request('/profile/adaptive-macros', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ weight_entries: weightEntries }),
  });
}

// ═════════════════════════════════════════════════════════════════════
// Weekly Review — deterministic plan review + per-muscle volume
// ═════════════════════════════════════════════════════════════════════

export interface MuscleVolumeRow {
  muscle: string;
  primary_sets: number;
  secondary_sets: number;
  total_sets: number;
  status: 'undertrained' | 'in_range' | 'high' | 'excessive' | 'spike' | 'unknown';
  range_min: number | null;
  range_max: number | null;
  avg_sets_prior_weeks: number;
  spike_ratio: number;
}

export interface WeeklyVolumeSnapshot {
  user_id: number;
  window_start: string;
  window_end: string;
  total_hard_sets: number;
  sessions_counted: number;
  by_muscle: Record<string, MuscleVolumeRow>;
}

export interface PlanRecommendation {
  key: string;
  area: 'workout' | 'nutrition' | 'recovery' | 'cardio';
  priority: 'info' | 'suggest' | 'warn';
  title: string;
  detail: string;
  action: Record<string, any>;
}

export interface WeeklyReviewResponse {
  user_id: number;
  week_start: string;
  week_end: string;
  goal: string;
  sessions_completed: number;
  sessions_planned: number;
  adherence_pct: number;
  cardio_minutes: number;
  zone2_minutes: number;
  volume: WeeklyVolumeSnapshot;
  nutrition_adherence_pct: number;
  days_logged: number;
  avg_protein_g: number;
  avg_fiber_g: number;
  weight_trend_lbs_per_week: number | null;
  weight_trend_direction: 'up' | 'down' | 'flat' | 'unknown';
  avg_sleep_hours: number | null;
  avg_resting_hr: number | null;
  headline: string;
  recommendations: PlanRecommendation[];
}

export async function getWeeklyReview(
  token: string,
  opts: {
    days?: number;
    weightSlopeLbsPerWeek?: number | null;
    avgSleepHours?: number | null;
    avgRestingHr?: number | null;
    avgSteps?: number | null;
    readinessScore?: number | null;
  } = {},
): Promise<WeeklyReviewResponse> {
  const params = new URLSearchParams();
  if (opts.days) params.set('days', String(opts.days));
  if (opts.weightSlopeLbsPerWeek != null) params.set('weight_slope_lbs_per_week', String(opts.weightSlopeLbsPerWeek));
  if (opts.avgSleepHours != null) params.set('avg_sleep_hours', String(opts.avgSleepHours));
  if (opts.avgRestingHr != null) params.set('avg_resting_hr', String(opts.avgRestingHr));
  if (opts.avgSteps != null) params.set('avg_steps', String(opts.avgSteps));
  if (opts.readinessScore != null) params.set('readiness_score', String(opts.readinessScore));
  const qs = params.toString();
  return request<WeeklyReviewResponse>(`/workouts/weekly-review${qs ? `?${qs}` : ''}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export interface ApplyActionResult {
  applied: boolean;
  summary: string;
  needs_regen: boolean;
  changed_fields: Record<string, any>;
  descriptive_only: boolean;
  error: string | null;
}

/** Apply a recommendation action to durable user state. The backend
 *  maps action types to existing user-facing settings (days/week,
 *  calorie adjustment, day-state) — same path the user would take
 *  manually through Edit Profile / Switch Day / etc. Caller is
 *  responsible for kicking plan regen when `needs_regen=true`. */
export async function applyRecommendationAction(
  token: string,
  action: Record<string, any>,
  rec_key?: string,
): Promise<ApplyActionResult> {
  return request<ApplyActionResult>('/coach/apply-action', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, rec_key: rec_key ?? null }),
  });
}

/** Wipe every WorkoutCompletion + WorkoutSession row for `dateISO`.
 *  Used by the day-card "Undo done" path when a phantom completion
 *  appears (timezone bug at midnight, partial sync, manual error). */
export async function deleteWorkoutCompletion(token: string, dateISO: string): Promise<void> {
  await request(`/workouts/completion?workout_date=${dateISO}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getWeeklyVolume(token: string, days = 7): Promise<WeeklyVolumeSnapshot> {
  return request<WeeklyVolumeSnapshot>(`/workouts/weekly-volume?days=${days}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

