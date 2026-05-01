import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { goalCategory } from '../constants/goalConfig';

const LOCAL_BACKEND_IP = '192.168.1.246'; // your dev machine's LAN IP

/** Exported for callers that need to hit the API outside the `request`
 *  helper (e.g. direct `fetch` for endpoints that return binary/large
 *  payloads). Same resolution logic — dev override → LAN IP → prod URL. */
export function getApiBaseUrl(): string {
  return getBaseUrl();
}

// Hard-stop list for placeholder values that must never reach a real
// build. If any of these slip through `app.json.extra.apiBaseUrl` we
// throw at first network call so the misconfiguration is obvious in
// device logs instead of producing mysterious "network error" toasts.
const PLACEHOLDER_API_HOSTS = [
  'your-production-api.com',
  'example.com',
  'localhost',  // production builds should never point at localhost
];

function isPlaceholderApiUrl(url: string): boolean {
  return PLACEHOLDER_API_HOSTS.some(p => url.includes(p));
}

function getBaseUrl(): string {
  // Production / TestFlight build: read from app config extras. Set this
  // via `app.json` → `expo.extra.apiBaseUrl` (or via EAS build secrets).
  const configured = (Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined)?.apiBaseUrl;
  if (!__DEV__) {
    if (!configured || isPlaceholderApiUrl(configured)) {
      // Hard fail with a loud, distinctive error. Easier to spot in
      // crash reports than a silent 502 loop.
      throw new Error(
        '[Thallo] Production API URL is missing or set to a placeholder. ' +
        'Set expo.extra.apiBaseUrl in app.json or via EAS build secrets.',
      );
    }
    return configured;
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

function tokenFromHeaders(headers: RequestInit['headers'] | undefined): string | undefined {
  if (!headers || Array.isArray(headers)) return undefined;
  if (headers instanceof Headers) {
    const value = headers.get('Authorization') ?? headers.get('authorization') ?? '';
    return value.startsWith('Bearer ') ? value.slice(7) : undefined;
  }
  const record = headers as Record<string, string>;
  const value = record.Authorization ?? record.authorization ?? '';
  return value.startsWith('Bearer ') ? value.slice(7) : undefined;
}

export async function recordTelemetryEvent(
  eventName: string,
  payload: Record<string, any> = {},
  token?: string,
): Promise<void> {
  try {
    const appVersion = Constants.expoConfig?.version ?? undefined;
    const platform = Platform.OS;
    const anonymousId = await AsyncStorage.getItem('installMarker').catch(() => null);
    await fetch(`${getBaseUrl()}/telemetry/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        event_name: eventName,
        anonymous_id: anonymousId,
        platform,
        app_version: appVersion,
        payload,
      }),
    });
  } catch {
    // Telemetry must never affect product flows.
  }
}

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
        recordTelemetryEvent('api_error', { path, status: res.status, detail }, tokenFromHeaders(options.headers));
        throw new Error(detail);
      }
      return data as T;
    } catch (e: any) {
      clearTimeout(timer);
      if (e.name === 'AbortError') {
        lastError = new Error(`Request timed out. Backend: ${getBaseUrl()} — is it reachable?`);
        recordTelemetryEvent('api_timeout', { path, timeout_ms: timeoutMs }, tokenFromHeaders(options.headers));
        if (attempt < maxRetries) continue;
        throw lastError;
      }
      if (e.message === 'Network request failed') {
        lastError = new Error(`Can't reach backend at ${getBaseUrl()} — is it running?`);
        recordTelemetryEvent('api_network_error', { path }, tokenFromHeaders(options.headers));
        if (attempt < maxRetries) continue;
        throw lastError;
      }
      throw e;
    }
  }
  throw lastError ?? new Error('Request failed');
}

export async function register(
  email: string,
  username: string,
  password: string,
  opts?: {
    firstName?: string;
    lastName?: string;
    legalVersion?: string;
    acceptedTerms?: boolean;
    acceptedPrivacy?: boolean;
    acceptedHealthDisclaimer?: boolean;
    acceptedAiDisclaimer?: boolean;
  },
) {
  const result = await request('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email,
      username,
      password,
      first_name: opts?.firstName,
      last_name: opts?.lastName,
      accepted_terms: opts?.acceptedTerms ?? true,
      accepted_privacy: opts?.acceptedPrivacy ?? true,
      accepted_health_disclaimer: opts?.acceptedHealthDisclaimer ?? true,
      accepted_ai_disclaimer: opts?.acceptedAiDisclaimer ?? true,
      legal_version: opts?.legalVersion,
    }),
  });
  recordTelemetryEvent('signup_completed', { has_legal_acceptance: true });
  return result;
}

export async function login(email: string, password: string): Promise<{ access_token: string }> {
  const result = await request<{ access_token: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  recordTelemetryEvent('login_completed', {}, result.access_token);
  return result;
}

/** Authenticated password change. Backend bumps `token_version` so every
 *  other existing JWT for this account is invalidated. The new token in
 *  the response is the only one that will continue to authenticate. */
export async function changePassword(
  token: string,
  currentPassword: string,
  newPassword: string,
): Promise<{ access_token: string }> {
  return request('/auth/change-password', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
}

/** Server-side logout. Bumps `token_version` so all existing JWTs for
 *  the account stop validating. Idempotent — safe to call even if the
 *  token is already expired. The frontend still clears local token
 *  storage on its own; this just kills any device's sessions. */
export async function logout(token: string): Promise<{ status: string; message: string }> {
  return request('/auth/logout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Stamp fresh acceptance timestamps + versions for all four legal
 *  sections. Used by the LegalDisclosureModal when `LEGAL_VERSION` was
 *  bumped after the user already signed up. */
export async function acceptLegal(
  token: string,
  legalVersion: string,
): Promise<unknown> {
  return request('/auth/accept-legal', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      legal_version: legalVersion,
      accepted_terms: true,
      accepted_privacy: true,
      accepted_health_disclaimer: true,
      accepted_ai_disclaimer: true,
    }),
  });
}

export async function resetPassword(email: string, answer: string, newPassword: string): Promise<{ access_token: string }> {
  return request('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ email, answer, new_password: newPassword }),
  });
}

export async function requestPasswordResetEmail(email: string): Promise<{ status: string; message: string; dev_token?: string }> {
  return request('/auth/password-reset/request', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export async function confirmPasswordResetEmail(email: string, token: string, newPassword: string): Promise<{ access_token: string }> {
  return request('/auth/password-reset/confirm', {
    method: 'POST',
    body: JSON.stringify({ email, token, new_password: newPassword }),
  });
}

export async function requestEmailVerification(email: string): Promise<{ status: string; message: string; dev_token?: string }> {
  return request('/auth/email-verification/request', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export async function confirmEmailVerification(email: string, token: string) {
  return request('/auth/email-verification/confirm', {
    method: 'POST',
    body: JSON.stringify({ email, token }),
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
    const goalTrack = data.goal.goal_track ?? data.goal.goal_type;
    // Map backend snake_case → frontend UserProfile shape
    return {
      firstName:  data.first_name ?? undefined,
      lastName:   data.last_name ?? undefined,
      subscriptionTier: data.subscription_tier === 'pro' ? 'pro' : 'free',
      goal:       goalTrack,
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
      equipmentSettings:      data.preferences.equipment_settings ?? undefined,
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
    equipmentSettings:      profile.equipmentSettings ?? undefined,
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
  recordTelemetryEvent('plan_generated', {
    kind: 'full',
    workout_days: result?.workout_plan?.days?.length ?? 0,
    meal_templates: result?.nutrition_plan?.templates?.length ?? result?.nutrition_plan?.days?.length ?? 0,
  }, token);
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
    equipmentSettings:      profile.equipmentSettings ?? undefined,
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
    allergies:            profile.allergies ?? [],
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
  if (map[g]) return map[g];

  const category = goalCategory(g);
  if (category === 'fat_loss') return 'fat_loss';
  if (category === 'strength') return 'strength';
  if (category === 'cardio_endurance') return 'endurance';
  if (category === 'athletic_performance') return 'athletic_performance';
  if (category === 'muscle_physique') {
    if (g === 'body_recomp') return 'body_recomp';
    if (g === 'maintain_physique') return 'maintain';
    return 'muscle_gain';
  }
  if (category === 'health_longevity') {
    if (['maintain_mobility', 'improve_mobility', 'improve_flexibility'].includes(g)) return 'flexibility';
    if (['stress_exercise', 'low_stress_training'].includes(g)) return 'stress_relief';
    return 'maintain';
  }
  if (category === 'lifestyle_consistency') {
    if (g === 'low_stress_training') return 'stress_relief';
    return 'maintain';
  }
  return 'maintain';
}

export async function syncOnboarding(token: string, profile: import('../types').UserProfile) {
  const mappedGoal = mapGoalToBackendType(profile.goal);
  if (mappedGoal !== profile.goal) {
    console.log('[syncOnboarding] mapped goal', profile.goal, '→', mappedGoal);
  }
  const result = await request('/profile/onboarding', {
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
        goal_track:        profile.goal,
        pace:              profile.goalDetails.pace,
        target_weight_lbs: profile.goalDetails.targetWeightLbs ?? null,
        timeline_weeks:    profile.goalDetails.timelineWeeks ?? null,
      },
      preferences: {
        days_per_week:   profile.daysPerWeek,
        equipment:       profile.equipment,
        equipment_settings: profile.equipmentSettings ?? null,
        foods_available: profile.foodsAvailable,
      },
    }),
  });
  recordTelemetryEvent('onboarding_completed', {
    goal: profile.goal,
    days_per_week: profile.daysPerWeek,
    meals_per_day: profile.mealsPerDay ?? 3,
  }, token);
  return result;
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

export async function updateName(token: string, firstName: string, lastName: string) {
  return request('/profile/name', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ first_name: firstName, last_name: lastName }),
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

export async function exportAccountData(token: string): Promise<any> {
  return request('/profile/export', {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, true);
}

export async function deleteAccount(token: string): Promise<{ status: string }> {
  return request('/profile/account', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, false);
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
let exerciseLibraryMemoryCache: { ts: number; rows: any[] } | null = null;
let exerciseLibraryInflight: Promise<any[]> | null = null;

export async function getExercises(params?: { muscle?: string; equipment?: string; forceRefresh?: boolean }) {
  // Only the "all exercises" path (no filters) is cached — filter queries
  // are rare and would create too many cache keys.
  const unfiltered = !params?.muscle && !params?.equipment;
  if (unfiltered && !params?.forceRefresh) {
    if (
      exerciseLibraryMemoryCache?.ts
      && Date.now() - exerciseLibraryMemoryCache.ts < EXERCISE_LIBRARY_TTL_MS
    ) {
      return exerciseLibraryMemoryCache.rows;
    }
    if (exerciseLibraryInflight) return exerciseLibraryInflight;

    exerciseLibraryInflight = (async () => {
      try {
        const raw = await AsyncStorage.getItem(EXERCISE_LIBRARY_CACHE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed?.ts && Date.now() - parsed.ts < EXERCISE_LIBRARY_TTL_MS && Array.isArray(parsed.rows)) {
            exerciseLibraryMemoryCache = { ts: parsed.ts, rows: parsed.rows };
            return parsed.rows as any[];
          }
        }
      } catch {}

      const rows = await request<any[]>('/meta/exercises');
      const ts = Date.now();
      exerciseLibraryMemoryCache = { ts, rows };
      try { await AsyncStorage.setItem(EXERCISE_LIBRARY_CACHE_KEY, JSON.stringify({ ts, rows })); } catch {}
      return rows;
    })();

    try {
      return await exerciseLibraryInflight;
    } finally {
      exerciseLibraryInflight = null;
    }
  }

  const qp = new URLSearchParams();
  if (params?.muscle) qp.set('muscle', params.muscle);
  if (params?.equipment) qp.set('equipment', params.equipment);
  const suffix = qp.toString() ? `?${qp.toString()}` : '';
  const load = request<any[]>(`/meta/exercises${suffix}`);

  const rows = await load;

  if (unfiltered) {
    const ts = Date.now();
    exerciseLibraryMemoryCache = { ts, rows };
    try { await AsyncStorage.setItem(EXERCISE_LIBRARY_CACHE_KEY, JSON.stringify({ ts, rows })); } catch {}
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
  comfort_rating?: number | null;
  feedback?: string | null;
  rir?: number | null;
  actual_distance?: number | null;
  actual_pace?: string | null;
  heart_rate_avg?: number | null;
  cardio_metrics?: Record<string, string> | null;
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
    change_mode?: 'single' | 'smart' | null;
    day_statuses?: string[] | null;
  },
): Promise<{
  days: any[];
  total_days_in_recipe: number;
  plan_name: string;
  focus_readiness: Record<string, number>;
  change_result?: {
    mode: 'single' | 'smart';
    changed_indices: number[];
    exercises_needed: number[];
    conflicts: Array<{
      kind: string;
      severity: string;
      message: string;
      affected_days: number[];
      suggestion: string | null;
    }>;
  };
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
    distanceMiles?: number;
    caloriesBurned?: number;
    avgHeartRate?: number;
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
  /** Explicit gear-attribution override. When set (even to []), the
   *  backend SKIPS keyword-based auto-accumulation and only credits the
   *  given gear IDs. Used by the per-session disambiguation prompt when
   *  multiple gear items match the same workout (e.g. two pairs of
   *  running shoes both keyworded with 'run'). Passing [] is a deliberate
   *  "no gear used today" signal. */
  gearIds?: number[],
): Promise<WorkoutCompleteResponse> {
  const activityHrSummary = activity?.avgHeartRate
    ? { avgBpm: activity.avgHeartRate, maxBpm: activity.avgHeartRate, zoneMinutes: [] }
    : undefined;
  const hrSummary = healthMetrics?.hrSummary ?? activityHrSummary;
  const caloriesBurned = healthMetrics?.caloriesBurned ?? activity?.caloriesBurned;

  const result = await request<WorkoutCompleteResponse>('/workouts/complete', {
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
      ...(activity?.distanceMiles != null ? { distance_miles: activity.distanceMiles } : {}),
      ...(caloriesBurned ? { calories_burned: caloriesBurned } : {}),
      ...(hrSummary ? { hr_summary: hrSummary } : {}),
      ...(feedback?.feeling ? { feeling: feedback.feeling } : {}),
      ...(feedback?.intensity ? { intensity: feedback.intensity } : {}),
      ...(feedback?.sorenessAreas && feedback.sorenessAreas.length > 0 ? { soreness_areas: feedback.sorenessAreas } : {}),
      ...(feedback?.notes ? { feedback_notes: feedback.notes } : {}),
      // gear_ids: undefined → keyword auto-match (legacy default)
      // gear_ids: []        → explicit "no gear used today"
      // gear_ids: [1,3]     → only credit these IDs, skip keyword match
      ...(Array.isArray(gearIds) ? { gear_ids: gearIds } : {}),
    }),
  });
  recordTelemetryEvent('workout_completed', {
    workout_date,
    focus_label,
    duration_seconds,
    exercise_count: exercises?.length ?? 0,
    source: activity?.source ?? 'phone',
  }, token);
  return result;
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
  cardio_style?: string | null;
  distance_miles?: number | null;
  calories_burned?: number | null;
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
  payload: { skipped_focus?: string | null; skip_reason?: string | null; meal_checks?: Record<string, boolean>; nutrition_plan?: any; macro_overrides?: any },
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
  if (payload.skip_reason === null) {
    body.clear_skip_reason = true;
  } else if (payload.skip_reason !== undefined) {
    body.skip_reason = payload.skip_reason;
  }
  if (payload.meal_checks !== undefined) body.meal_checks = payload.meal_checks;
  if (payload.nutrition_plan !== undefined) body.nutrition_plan = payload.nutrition_plan;
  if (payload.macro_overrides !== undefined) body.macro_overrides = payload.macro_overrides;
  return request('/profile/day-state/' + dayKey, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export async function submitWeeklyCheckin(
  token: string,
  body: {
    checkin_date: string;
    weight_lbs: number;
    waist_in?: number;
    chest_in?: number;
    hips_in?: number;
    bicep_in?: number;
    thigh_in?: number;
    calf_in?: number;
    body_fat_pct?: number;
    energy: number;
    sleep: number;
    adherence: number;
    notes?: string;
  },
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
  // Enrichment fields populated by the backend so freshly imported
  // exercises (wger / AI fallback) line up with the seed catalog:
  // `video_id` drives the form-video card, `is_compound` is consumed
  // by swap scoring + progression logic, `secondary_muscles` feeds
  // the exercise-info modal.
  video_id?: string | null;
  is_compound?: boolean;
  secondary_muscles?: string[];
  movement_pattern?: string | null;
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

// ─── Cardio equipment profiles ───────────────────────────────────────────────

export interface CardioEquipmentProfile {
  id: number;
  category: string;
  equipment_type: string;
  display_name: string;
  brand: string | null;
  model_name: string | null;
  location: string;
  capabilities: string[];
  notes: string | null;
}

export async function getCardioEquipment(token: string): Promise<CardioEquipmentProfile[]> {
  return request<CardioEquipmentProfile[]>('/profile/cardio-equipment', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function addCardioEquipment(
  token: string,
  body: Omit<CardioEquipmentProfile, 'id'>,
): Promise<CardioEquipmentProfile> {
  return request<CardioEquipmentProfile>('/profile/cardio-equipment', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export async function updateCardioEquipment(
  token: string,
  id: number,
  body: Omit<CardioEquipmentProfile, 'id'>,
): Promise<CardioEquipmentProfile> {
  return request<CardioEquipmentProfile>(`/profile/cardio-equipment/${id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export async function deleteCardioEquipment(token: string, id: number): Promise<void> {
  await request<void>(`/profile/cardio-equipment/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getCardioCapabilityTokens(token: string): Promise<{ token: string; label: string; modalities: string[] }[]> {
  return request<any[]>('/profile/cardio-equipment/capabilities', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function suggestExercisesForWorkout(
  token: string,
  body: {
    workout_focus: string;
    current_exercises: string[];
    equipment?: string[];
    injuries?: string[];
  },
): Promise<{ results: AIExerciseResult[] }> {
  const res = await request<{ results: AIExerciseResult[] }>('/ai/exercise-suggest', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { results: res.results ?? [] };
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
): Promise<{ name: string; barcode: string; serving: string; calories: number; protein: number; carbs: number; fat: number; micronutrients?: Record<string, number>; source: string }> {
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
): Promise<{ results: Array<{ name: string; serving: string; calories: number; protein: number; carbs: number; fat: number; fiber?: number; micronutrients?: Record<string, number>; source?: 'usda' | 'ai' }> }> {
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
    /** Optional photo, e.g. a snap of the user's knee position. Triggers
     *  the gpt-4o-mini vision endpoint server-side. */
    image_base64?: string;
    mime_type?: string;
    /** Prior turns of THIS coach session so the AI can answer follow-ups
     *  without restating context. Backend caps to last 6 turns. */
    conversation?: { role: 'user' | 'assistant'; content: string }[];
  },
): Promise<{ answer: string; quick_cues: string[]; adjustment: string; safety_note: string }> {
  console.log('[askWorkoutQuestion] SEND →', {
    question: payload.question.slice(0, 120),
    activeExercise: payload.activeExerciseName,
    currentSet: payload.currentSetNumber,
    loggedSetsCount: payload.loggedSets?.length ?? 0,
    hasImage: !!payload.image_base64,
    convoTurns: payload.conversation?.length ?? 0,
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
    micronutrients?: Record<string, number>;
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
  consumed_at?: string | null;
  created_at?: string | null;
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
  avg_calories_when_logged?: number;
  avg_protein_g_when_logged?: number;
  avg_carbs_g_when_logged?: number;
  avg_fat_g_when_logged?: number;
  tracking_rate_pct?: number;
  avg_meals_per_day: number;
  total_meals_logged: number;
  daily?: Array<{
    date: string;
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    meal_count: number;
  }>;
}

export async function logMealChecked(
  token: string,
  payload: { meal_date: string; meal_type: string; meal: Record<string, any>; source?: string; consumed_at?: string },
): Promise<{ id: number; consumed_at?: string | null }> {
  const result = await request<{ id: number; consumed_at?: string | null }>('/meals/log-checked', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 10000, true);  // noRetry — fire and forget, don't block UI
  recordTelemetryEvent('meal_logged', {
    meal_date: payload.meal_date,
    meal_type: payload.meal_type,
    source: payload.source ?? 'unknown',
  }, token);
  return result;
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
  /** AI-estimated probiotic CFU from today's logged items, in billions. */
  probiotic_cfu_billions?: number;
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
  /** AI-estimated probiotic CFU across the full window, in billions. */
  probiotic_cfu_billions?: number;
  /** AI-estimated average probiotic CFU per logged day, in billions. */
  avg_probiotic_cfu_billions?: number;
  seafood_servings: number;
  fruit_servings: number;
  vegetable_servings: number;
  alcohol_servings: number;
  processed_meat_servings: number;
  refined_grain_servings: number;
  plant_protein_g: number;
  animal_protein_g: number;
  avg_plant_protein_g?: number;
  avg_animal_protein_g?: number;
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

export interface AdjustedDailyTarget {
  base_daily_target: number;
  adjusted_calories: number;
  adjustment_applied: number;
  at_cap: boolean;
  days_remaining: number;
  weekly_budget_remaining: number;
  note: string | null;
  adjusted_macros: { protein_g: number; carbs_g: number; fat_g: number } | null;
}

export async function getAdjustedDailyTarget(token: string, date?: string): Promise<AdjustedDailyTarget> {
  const q = date ? `?target_date=${date}` : '';
  return request(`/meals/adjusted-daily-target${q}`, {
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

// Hydration — daily log + target. The backend computes a target that
// reflects weight + sex (base), planned/actual workout minutes (sweat
// replacement), today's logged protein (kidney filtration), and any
// alcohol logged (diuretic). `breakdown` exposes each contribution in oz
// so the UI can explain the number — e.g. "104 oz = 96 base + 16 workout
// − 8 you didn't drink yet today." All breakdown fields are integers.
export interface HydrationBreakdown {
  base: number;
  activity: number;
  protein: number;
  alcohol: number;
}
export interface HydrationStatus {
  date: string;
  ounces: number;
  target_ounces: number;
  /** Optional — older app builds may not surface this. */
  breakdown?: HydrationBreakdown;
}
export async function getHydration(token: string, logDate?: string): Promise<HydrationStatus> {
  const qs = logDate ? `?log_date=${encodeURIComponent(logDate)}` : '';
  return request(`/meals/hydration${qs}`, { headers: { Authorization: `Bearer ${token}` } });
}

export async function logHydration(token: string, ounces: number, logDate?: string): Promise<{ date: string; ounces: number }> {
  return request('/meals/hydration', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ounces, ...(logDate ? { log_date: logDate } : {}) }),
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


// ─── Weight Entries ──────────────────────────────────────────────────────────

export interface WeightEntryAPI {
  date: string;
  weight_lbs: number;
  source: string;
}

export async function getWeightEntries(token: string): Promise<WeightEntryAPI[]> {
  return request<WeightEntryAPI[]>('/profile/weight-entries', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function saveWeightEntryAPI(token: string, date: string, weightLbs: number, source = 'manual'): Promise<void> {
  await request('/profile/weight-entries', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ date, weight_lbs: weightLbs, source }),
  });
}

export async function syncWeightEntries(token: string, entries: WeightEntryAPI[]): Promise<void> {
  await request('/profile/weight-entries/sync', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(entries),
  });
}

// ─── Body Scan History ──────────────────────────────────────────────────────

export interface BodyScanHistoryItem {
  id: number;
  scan_date: string;
  body_fat_pct: number | null;
  body_fat_range: string | null;
  muscle_mass: string | null;
  category: string | null;
  strengths: string[];
  improvements: string[];
  assessment: string | null;
  disclaimer: string | null;
  weight_lbs: number | null;
  created_at: string;
}

export async function getBodyScanHistory(token: string): Promise<BodyScanHistoryItem[]> {
  return request<BodyScanHistoryItem[]>('/ai/body-scans', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
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
  micronutrients?: Record<string, number> | null;
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
  /** Optional user-defined group ("Stack 1", "Travel pack"). Overrides
   *  the built-in `timing` bucket for grouping + the "take group" tap. */
  group_label?: string | null;
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
  ingredient_slug?: string | null;
  ingredient_name?: string | null;
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

/** Bulk-log every active item in a group with one tap.
 *  Pass `group_label` for user-defined groups, or `timing` for the
 *  built-in buckets ("morning", "pre_workout", etc.). Items already
 *  logged today are skipped server-side so a double-tap is safe. */
export async function logSupplementGroup(
  token: string,
  body: { group_label?: string; timing?: string; skipped?: boolean },
): Promise<{ logged: number; items: number[] }> {
  return request('/supplements/stack/log-group', {
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
  /** EMA-smoothed weight from the 7-day UserRollup. Cleaner trend
   *  display than raw slope alone — slope is noisy week-to-week. */
  weight_ema_lbs?: number | null;
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
  undo_action?: Record<string, any> | null;
}

// ── Weekly Coach Check-In ─────────────────────────────────────────────────────

export interface WeekCheckinCoachFindings {
  wins: string[];
  needs_attention: string[];
  recovery_notes: string[];
  nutrition_notes: string[];
}

export interface WeekSummaryResponse {
  week_id: number;
  plan_status: string;
  planned_workouts: number;
  completed_workouts: number;
  missed_workouts: number;
  adherence_pct: number;
  cardio_minutes: number;
  zone2_minutes: number;
  strength_sessions: number;
  nutrition_adherence_pct: number;
  days_logged: number;
  avg_sleep_hours: number | null;
  avg_resting_hr: number | null;
  goal: string;
  week_start: string;
  week_end: string;
  headline: string;
  coach_findings: WeekCheckinCoachFindings;
}

export type DifficultyRating =
  | 'too_easy' | 'about_right' | 'too_hard'
  | 'too_time_consuming' | 'did_not_like_plan';

export type BlockerType =
  | 'time' | 'fatigue' | 'soreness' | 'equipment'
  | 'motivation' | 'cardio_boring' | 'exercise_discomfort'
  | 'nutrition_hard' | 'none';

export type PainArea =
  | 'none' | 'shoulder' | 'elbow_wrist' | 'low_back'
  | 'knee' | 'hip' | 'foot_ankle' | 'other';

export type CheckinDecision =
  | 'apply_recommendations' | 'customize'
  | 'keep_current_style' | 'make_easier' | 'make_harder';

export interface WeekCheckinAnswers {
  overall_difficulty?: DifficultyRating;
  biggest_blocker?: BlockerType;
  pain_area?: PainArea;
  goal_q4?: string;
  user_decision: CheckinDecision;
  weight_slope_lbs_per_week?: number | null;
  avg_sleep_hours?: number | null;
  avg_resting_hr?: number | null;
  avg_steps?: number | null;
  readiness_score?: number | null;
}

export interface RecommendedAdjustments {
  difficulty_adjustment: 'easier' | 'same' | 'harder';
  volume_adjustment_pct: number;
  intensity_adjustment: 'reduce' | 'maintain' | 'increase';
  session_length_adjustment: 'shorter' | 'same' | 'longer' | null;
  cardio_adjustment: string | null;
  mobility_adjustment: string | null;
  nutrition_adjustment: string | null;
  muscle_priorities: string[];
  avoid_patterns: string[];
  preferred_cardio_modes: string[];
  summary: string;
}

export interface WeekCheckinResponse {
  summary: RecommendedAdjustments;
  applied: Array<{ type: string; summary: string }>;
  coach_message: string;
}

export async function getWeekSummary(token: string): Promise<WeekSummaryResponse> {
  return request<WeekSummaryResponse>('/plans/week-summary', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function postWeekCheckin(
  token: string,
  answers: WeekCheckinAnswers,
): Promise<WeekCheckinResponse> {
  return request<WeekCheckinResponse>('/plans/week-checkin', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(answers),
  });
}

// ── Plan Week (persisted 7-day plan) ──────────────────────────────
//
// One PlanWeek per user with 7 dated PlanDay rows. Replaces the
// legacy cycling-array model: the plan stays stable for 7 days and
// only renews via /plans/week/auto-renew when needs_new_week=true.

export interface PlanDayResponse {
  /** ISO date string (YYYY-MM-DD). */
  day_date: string;
  /** 0..6 — index within the week. */
  day_index: number;
  /** 'pending' | 'in_progress' | 'completed' | 'skipped'. */
  status: string;
  is_rest: boolean;
  locked: boolean;
  lock_reason: string | null;
  skip_reason: string | null;
  /** WorkoutDay-shaped JSON (focus/exercises/...). Null on rest days. */
  workout: any | null;
  /** DailyNutritionPlan-shaped JSON. Null when no template assigned. */
  nutrition: any | null;
  generation_source: string;
}

export interface PlanWeekResponse {
  id: number;
  start_date: string;
  end_date: string;
  status: string;
  needs_new_week: boolean;
  planner_version: string;
  goal: string;
  days_per_week: number;
  preferred_split: string | null;
  /** ISO date the plan resumes. While set + in the future, auto-renew,
   *  auto-skip, and reminders all suspend. */
  paused_until?: string | null;
  pause_reason?: string | null;
  days: PlanDayResponse[];
}

export async function pausePlanWeek(
  token: string,
  body: { paused_until?: string | null; reason?: string | null } = {},
): Promise<PlanWeekResponse> {
  return request<PlanWeekResponse>('/plans/week/pause', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function resumePlanWeek(token: string): Promise<PlanWeekResponse> {
  return request<PlanWeekResponse>('/plans/week/resume', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export interface CyclePlanContext {
  cyclePhase?: 'menses' | 'follicular' | 'ovulation' | 'luteal' | 'unknown' | null;
  dayOfCycle?: number | null;
}

/** Returns the active 7-day plan, or null if none exists yet (caller
 *  should then POST /plans/start-new-week to generate one). */
export async function getActivePlanWeek(token: string): Promise<PlanWeekResponse | null> {
  return request<PlanWeekResponse | null>('/plans/week/active', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Force-create a new 7-day plan starting today. Used on first run
 *  and when needs_new_week is true. */
export async function startNewPlanWeek(
  token: string,
  force: boolean = false,
  cycle?: CyclePlanContext | null,
): Promise<PlanWeekResponse> {
  const result = await request<PlanWeekResponse>('/plans/start-new-week', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      force,
      cycle_phase: cycle?.cyclePhase ?? null,
      day_of_cycle: cycle?.dayOfCycle ?? null,
    }),
  });
  recordTelemetryEvent('plan_week_created', {
    plan_week_id: result.id,
    start_date: result.start_date,
    end_date: result.end_date,
    force,
  }, token);
  return result;
}

export async function patchPlanDayWorkout(
  token: string,
  dayDate: string,
  workoutJson: any,
): Promise<PlanDayResponse> {
  return request<PlanDayResponse>(`/plans/days/${encodeURIComponent(dayDate)}/workout`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workout_json: workoutJson }),
  });
}

export async function skipPlanDay(
  token: string,
  dayDate: string,
  reason?: string | null,
): Promise<PlanDayResponse> {
  return request<PlanDayResponse>(`/plans/days/${encodeURIComponent(dayDate)}/skip`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: reason ?? null }),
  });
}

export async function unskipPlanDay(
  token: string,
  dayDate: string,
): Promise<PlanDayResponse> {
  return request<PlanDayResponse>(`/plans/days/${encodeURIComponent(dayDate)}/unskip`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
}

export interface AutoRenewPlanWeekResponse {
  plan_week: PlanWeekResponse | null;
  review_headline: string;
  review_summary: Record<string, any>;
  auto_applied: Array<Record<string, any>>;
  needs_review: Array<Record<string, any>>;
  explanation: string;
}

/** Returned by auto-renew when a check-in must be completed first. */
export interface CheckinRequiredResponse {
  checkin_required: true;
  plan_week_id: number;
  week_start: string;
  week_end: string;
}

export interface PlanWeekCheckinRecord {
  id: number;
  user_id: number;
  plan_week_id: number;
  week_start_date: string;
  week_end_date: string;
  submitted_at: string | null;
  skipped: boolean;
  energy: number | null;
  hunger: number | null;
  soreness: number | null;
  motivation: number | null;
  schedule_issue: boolean;
  note: string | null;
  review_snapshot_json: Record<string, any> | null;
  ai_decision_id: number | null;
  ai_message: string | null;
  ai_delta: Record<string, any> | null;
  commitments_json: Array<Record<string, any>> | null;
  plan_goal: string | null;
  created_at: string;
  // Extra fields included in submit response
  review_summary?: Record<string, any>;
}

export interface CheckinStatusResponse {
  status: 'pending' | 'completed' | 'skipped' | 'none';
  checkin: PlanWeekCheckinRecord | null;
  week_start: string | null;
  week_end: string | null;
  plan_week_id: number | null;
}

export interface PlanWeekCheckinSubmit {
  energy?: number | null;
  hunger?: number | null;
  soreness?: number | null;
  motivation?: number | null;
  schedule_issue?: boolean;
  note?: string | null;
  overall_difficulty?: DifficultyRating | null;
  biggest_blocker?: BlockerType | null;
  pain_area?: PainArea | null;
  goal_q4?: string | null;
}

/** Auto-generate the next 7-day week when the active PlanWeek has
 *  expired (end_date < today). Returns CheckinRequiredResponse when
 *  a check-in must be completed or skipped first. */
export async function autoRenewPlanWeek(
  token: string,
  cycle?: CyclePlanContext | null,
): Promise<AutoRenewPlanWeekResponse | CheckinRequiredResponse> {
  const params = new URLSearchParams();
  if (cycle?.cyclePhase && cycle.cyclePhase !== 'unknown') params.set('cycle_phase', cycle.cyclePhase);
  if (cycle?.dayOfCycle != null) params.set('day_of_cycle', String(cycle.dayOfCycle));
  const qs = params.toString();
  return request<AutoRenewPlanWeekResponse | CheckinRequiredResponse>(`/plans/week/auto-renew${qs ? '?' + qs : ''}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getCheckinStatus(token: string): Promise<CheckinStatusResponse> {
  return request<CheckinStatusResponse>('/plans/week/checkin-status', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Submit the one-time coaching check-in for a plan week. HTTP 409 if already submitted. */
export async function submitPlanWeekCheckin(
  token: string,
  planWeekId: number,
  body: PlanWeekCheckinSubmit,
): Promise<PlanWeekCheckinRecord> {
  return request<PlanWeekCheckinRecord>(`/plans/week/${planWeekId}/checkin`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Skip the check-in for a plan week and immediately auto-renew. */
export async function skipPlanWeekCheckin(
  token: string,
  planWeekId: number,
): Promise<AutoRenewPlanWeekResponse> {
  return request<AutoRenewPlanWeekResponse>(`/plans/week/${planWeekId}/checkin/skip`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Fetch a saved check-in recap without triggering AI. */
export async function getPlanWeekCheckin(
  token: string,
  planWeekId: number,
): Promise<PlanWeekCheckinRecord> {
  return request<PlanWeekCheckinRecord>(`/plans/week/${planWeekId}/checkin`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ── Readiness (server-side canonical compute) ─────────────────────
//
// The phone calls this and renders the response directly — no
// client-side scoring. The phone ALSO pushes the exact response to
// the watch via WCSession so both surfaces show the same number.
// `computed_at_ms` lets the watch reject stale pushes.

export interface ReadinessFactor {
  label: string;
  value: number;        // 0-100 sub-score
  status: 'good' | 'ok' | 'low';
  detail: string | null;
}

export interface ReadinessTodayResponse {
  score: number;        // 0-100 canonical readiness
  label: string;        // "Primed" | "Ready" | "Moderate" | "Fatigued" | "—"
  summary: string;
  factors: ReadinessFactor[];
  missing: string[];
  signals_present: number;
  signals_total: number;
  /** Server-stamped version. Watch ignores any push older than its
   *  current value. Client should treat as opaque. */
  computed_at_ms: number;
}

export async function getReadinessToday(
  token: string,
  signals?: {
    avgSleepHours?: number | null;
    avgRestingHr?: number | null;
    avgHrvMs?: number | null;
    lastNightSleepScore?: number | null;
    nutritionAdherencePct?: number | null;
    plannedFocus?: string | null;
    /** Optional cycle phase from `getCycleStatus()` — adds a "Cycle"
     *  factor to readiness that validates "luteal week feels harder."
     *  Skipped silently for male users / users without HK grant. */
    cyclePhase?: 'menses' | 'follicular' | 'ovulation' | 'luteal' | 'unknown' | null;
    dayOfCycle?: number | null;
  },
): Promise<ReadinessTodayResponse> {
  return request<ReadinessTodayResponse>('/readiness/today', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      avg_sleep_hours: signals?.avgSleepHours ?? null,
      avg_resting_hr: signals?.avgRestingHr ?? null,
      avg_hrv_ms: signals?.avgHrvMs ?? null,
      last_night_sleep_score: signals?.lastNightSleepScore ?? null,
      nutrition_adherence_pct: signals?.nutritionAdherencePct ?? null,
      planned_focus: signals?.plannedFocus ?? null,
      cycle_phase: signals?.cyclePhase ?? null,
      day_of_cycle: signals?.dayOfCycle ?? null,
    }),
  });
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
export async function deleteWorkoutCompletion(token: string, dateISO: string, focusLabel?: string): Promise<void> {
  let url = `/workouts/completion?workout_date=${dateISO}`;
  if (focusLabel) url += `&focus_label=${encodeURIComponent(focusLabel)}`;
  await request(url, {
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

// ─── Estimated 1RM ─────────────���───────────────────────────────────────────

export interface E1RMEstimate {
  e1rm_lbs: number;
  sample_count: number;
  confidence: 'low' | 'med' | 'high';
}

export interface E1RMHistoryPoint {
  date: string;
  e1rm_lbs: number;
  confidence: string;
  sample_count: number;
}

export async function getE1RM(token: string, exerciseName: string, role = 'primary'): Promise<{ e1rm: E1RMEstimate | null; reason?: string }> {
  return request(`/workouts/e1rm?exercise_name=${encodeURIComponent(exerciseName)}&role=${role}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getE1RMHistory(token: string, exerciseName: string, role = 'primary'): Promise<{ exercise: string; history: E1RMHistoryPoint[] }> {
  return request(`/workouts/e1rm/history?exercise_name=${encodeURIComponent(exerciseName)}&role=${role}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export interface HRZone {
  zone: number;
  label: string;
  low: number;
  high: number;
}

export interface HRZonesResponse {
  max_hr: number;
  resting_hr: number;
  vo2_max: number | null;
  zones: HRZone[];
}

export async function getHRZones(token: string, restingHr?: number, vo2Max?: number): Promise<HRZonesResponse> {
  const params = new URLSearchParams();
  if (restingHr != null) params.set('resting_hr', String(restingHr));
  if (vo2Max != null) params.set('vo2_max', String(vo2Max));
  const qs = params.toString();
  return request(`/workouts/hr-zones${qs ? `?${qs}` : ''}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export interface PaceHistoryPoint {
  exercise: string;
  date: string;
  distance: number | null;
  pace: string | null;
  duration_seconds: number | null;
  metrics: Record<string, string> | null;
}

export async function getPaceHistory(token: string, exercise?: string, days = 90): Promise<{ points: PaceHistoryPoint[] }> {
  const params = new URLSearchParams({ days: String(days) });
  if (exercise) params.set('exercise', exercise);
  return request(`/workouts/pace-history?${params}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─── Social ────────────────────────────────────────────────────────────────

export interface SocialMe {
  user_id: number;
  username: string;
  display_name: string | null;
  share_activity_enabled: boolean;
}

export interface SocialFriend {
  friendship_id: number;
  user_id: number;
  username: string;
  display_name: string | null;
  goal: string | null;
  last_active_within_48h: boolean;
  streak: number;
}

export interface SocialPendingRequest {
  friendship_id: number;
  user_id: number;
  username: string;
  display_name: string | null;
  requested_at: string;
  direction: 'incoming' | 'outgoing';
}

export interface SocialFriendsList {
  friends: SocialFriend[];
  pending: SocialPendingRequest[];
}

export interface SocialDigestFriend {
  user_id: number;
  username: string;
  display_name: string;
  goal: string | null;
  share_enabled: boolean;
  sessions: number;
  streak: number;
  last_active_within_48h: boolean;
}

export interface SocialDigest {
  week_start: string;
  you: { sessions: number; streak: number };
  friends: SocialDigestFriend[];
  summary: {
    friend_count: number;
    friends_trained_this_week: number;
    total_friend_sessions: number;
    top_user_id: number | null;
    top_sessions: number;
    long_streak_count: number;
  };
}

export interface SocialSearchHit {
  user_id: number;
  username: string;
  display_name: string | null;
}

export async function getSocialMe(token: string): Promise<SocialMe> {
  return request<SocialMe>('/social/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function updateSocialMe(
  token: string,
  body: { display_name?: string | null; share_activity_enabled?: boolean },
): Promise<SocialMe> {
  return request<SocialMe>('/social/me', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export async function listFriends(token: string): Promise<SocialFriendsList> {
  return request<SocialFriendsList>('/social/friends', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function requestFriend(token: string, username: string): Promise<SocialPendingRequest> {
  return request<SocialPendingRequest>('/social/friends/request', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ username }),
  });
}

export async function acceptFriend(token: string, friendshipId: number): Promise<void> {
  await request(`/social/friends/${friendshipId}/accept`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function rejectFriend(token: string, friendshipId: number): Promise<void> {
  await request(`/social/friends/${friendshipId}/reject`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function removeFriend(token: string, friendshipId: number): Promise<void> {
  await request(`/social/friends/${friendshipId}/remove`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function blockFriend(token: string, friendshipId: number): Promise<void> {
  await request(`/social/friends/${friendshipId}/block`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export type ReportUserReason = 'spam' | 'harassment' | 'impersonation' | 'inappropriate_content' | 'other';

/** File a safety report on another user. Stored server-side as `open`
 *  for human moderation — no auto-action. The reporter's id is on the
 *  record so the same person can't spam-report. App Review requires a
 *  visible Report affordance on every social surface. */
export async function reportUser(
  token: string,
  userId: number,
  reason: ReportUserReason,
  note?: string,
): Promise<{ ok: boolean; report_id: number }> {
  return request('/social/report-user', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ user_id: userId, reason, note: note ?? null }),
  });
}

export async function searchUsers(token: string, q: string): Promise<SocialSearchHit[]> {
  return request<SocialSearchHit[]>(`/social/search?q=${encodeURIComponent(q)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getSocialDigest(token: string): Promise<SocialDigest> {
  return request<SocialDigest>('/social/digest', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export interface FeedItem {
  id: number;
  user_id: number;
  username: string;
  display_name: string | null;
  event_type: string;
  payload: {
    focus?: string;
    duration_seconds?: number;
    date?: string;
    exercise_count?: number;
    exercises?: Array<{ name: string; sets: Array<{ reps: number; weight: number | null }> }>;
    streak?: number;
    caption?: string;
    photo_base64?: string;
    workout_summary?: WorkoutPostSummary;
    exercise?: string;
    value?: number;
    unit?: string;
    pr_type?: string;
  };
  created_at: string;
  like_count: number;
  liked_by_me: boolean;
}

export async function getSocialFeed(token: string, beforeId?: number): Promise<{ items: FeedItem[] }> {
  const qs = beforeId ? `?before_id=${beforeId}` : '';
  return request<{ items: FeedItem[] }>(`/social/feed${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getUserFeed(token: string, userId: number, beforeId?: number): Promise<{ items: FeedItem[] }> {
  const params = new URLSearchParams();
  if (beforeId) params.set('before_id', String(beforeId));
  const qs = params.toString();
  return request<{ items: FeedItem[] }>(`/social/feed/${userId}${qs ? '?' + qs : ''}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export interface WorkoutPostSummary {
  focus: string;
  duration_seconds: number;
  date: string;
  exercises: Array<{
    name: string;
    equipment?: string | null;
    sets: Array<{ reps: number; weight_lbs: number }>;
  }>;
  total_sets: number;
  total_reps: number;
  training_score?: number | null;
  training_rating?: string | null;
}

export async function createSocialPost(
  token: string,
  body: { caption?: string; photo_base64?: string; workout_summary?: WorkoutPostSummary },
): Promise<{ ok: boolean; id: number }> {
  return request<{ ok: boolean; id: number }>('/social/posts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function deleteSocialPost(token: string, postId: number): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/social/posts/${postId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function toggleFeedLike(token: string, itemId: number): Promise<{ liked: boolean }> {
  return request<{ liked: boolean }>(`/social/feed/${itemId}/like`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function parseMealText(
  token: string,
  text: string,
): Promise<{ items: Array<{ name: string; serving: string; calories: number; protein: number; carbs: number; fat: number }> }> {
  return request('/ai/parse-meal-text', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text }),
  }, 25000, true);
}

// ─── Gear tracking ──────────────────────────────────────────────────────────

export interface GearItem {
  id: number;
  name: string;
  gear_type: string;
  purchase_date: string | null;
  starting_miles: number;
  accumulated_miles: number;
  accumulated_sessions: number;
  is_active: boolean;
  retirement_threshold_miles: number | null;
  retirement_threshold_sessions: number | null;
  last_used_at: string | null;
  auto_track_keywords: string[];
  notes: string | null;
  photos: string[];
  created_at: string;
  // Computed by backend
  total_miles: number;
  pct_used: number | null;
  recommendation: string | null;
}

export interface GearItemCreate {
  name: string;
  gear_type: string;
  purchase_date?: string | null;
  starting_miles?: number;
  retirement_threshold_miles?: number | null;
  retirement_threshold_sessions?: number | null;
  auto_track_keywords?: string[];
  notes?: string | null;
  photos?: string[];
}

export async function listGear(token: string): Promise<GearItem[]> {
  return request<GearItem[]>('/gear', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function addGear(token: string, body: GearItemCreate): Promise<GearItem> {
  return request<GearItem>('/gear', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function updateGear(token: string, id: number, body: GearItemCreate): Promise<GearItem> {
  return request<GearItem>(`/gear/${id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function deleteGear(token: string, id: number): Promise<void> {
  await request<void>(`/gear/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function logGearMiles(
  token: string,
  id: number,
  miles: number,
  sessions?: number,
): Promise<GearItem> {
  return request<GearItem>(`/gear/${id}/log-miles`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ miles, sessions: sessions ?? 1 }),
  });
}

export async function getGearRecommendations(token: string): Promise<GearItem[]> {
  return request<GearItem[]>('/gear/recommendations', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export interface GearIdentifyResult {
  name: string;
  gear_type: string;
  estimated_miles: number | null;
  retirement_threshold_miles: number | null;
  confidence: 'high' | 'medium' | 'low';
  notes: string | null;
}

export async function identifyGear(token: string, images: string[]): Promise<GearIdentifyResult> {
  return request<GearIdentifyResult>('/gear/identify', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ images }),
  });
}
