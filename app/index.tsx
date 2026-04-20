import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, Modal, TouchableOpacity, StyleSheet, ActivityIndicator, Image, Alert, Platform, Switch, AppState, AppStateStatus, Animated, Easing } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import * as KeepAwake from 'expo-keep-awake';

/** Keep the device awake while plan generation is in flight. iOS suspends
 *  JS execution ~30s after the app backgrounds or the screen locks, which
 *  kills long-running `fetch` calls. A dedicated tag so multiple activations
 *  don't stomp each other. */
const PLAN_GEN_AWAKE_TAG = 'thallo-plan-gen';
async function holdPlanGenAwake(): Promise<void> {
  try { await KeepAwake.activateKeepAwakeAsync(PLAN_GEN_AWAKE_TAG); } catch {}
}
function releasePlanGenAwake(): void {
  try { KeepAwake.deactivateKeepAwake(PLAN_GEN_AWAKE_TAG); } catch {}
}

/** Persistent marker describing an in-flight plan generation. When the user
 *  backgrounds the app mid-gen iOS suspends the `fetch` promise, and on the
 *  next foreground event we look for a leftover marker and re-kick the same
 *  generation. Cleared on success OR explicit failure. */
const PLAN_GEN_MARKER_KEY = 'plan_gen_pending';
type PlanGenMarker = {
  kind: 'full' | 'workout' | 'nutrition';
  startedAt: number;  // epoch ms — used to skip stale markers
  attempts: number;
};
async function setPlanGenMarker(kind: PlanGenMarker['kind']): Promise<void> {
  const existing = await AsyncStorage.getItem(PLAN_GEN_MARKER_KEY);
  const prev: PlanGenMarker | null = existing ? (() => { try { return JSON.parse(existing); } catch { return null; } })() : null;
  const marker: PlanGenMarker = {
    kind,
    startedAt: Date.now(),
    attempts: (prev?.attempts ?? 0) + 1,
  };
  try { await AsyncStorage.setItem(PLAN_GEN_MARKER_KEY, JSON.stringify(marker)); } catch {}
}
async function clearPlanGenMarker(): Promise<void> {
  try { await AsyncStorage.removeItem(PLAN_GEN_MARKER_KEY); } catch {}
  try { await AsyncStorage.removeItem('pending_plan_job'); } catch {}
}
async function readPlanGenMarker(): Promise<PlanGenMarker | null> {
  try {
    const raw = await AsyncStorage.getItem(PLAN_GEN_MARKER_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PlanGenMarker;
  } catch {
    return null;
  }
}

/** Don't retry forever — if something is genuinely broken, three attempts is
 *  enough to prove it and clear the marker so the user isn't stuck in a loop. */
const PLAN_GEN_MAX_ATTEMPTS = 3;
/** Ignore markers older than this — probably orphaned from a much earlier
 *  session or a version the user has since abandoned. */
const PLAN_GEN_MARKER_STALE_MS = 15 * 60 * 1000;

/** iOS Keychain / Android KeyStore-backed token storage. Falls back to
 *  AsyncStorage on platforms where SecureStore isn't available (web, some
 *  simulators). Kept here instead of a separate util file because auth is
 *  the only consumer. */
const AUTH_TOKEN_KEY = 'auth_token';
async function saveAuthToken(token: string): Promise<void> {
  try { await SecureStore.setItemAsync(AUTH_TOKEN_KEY, token); return; } catch {}
  try { await AsyncStorage.setItem(AUTH_TOKEN_KEY, token); } catch {}
}
async function loadAuthToken(): Promise<string | null> {
  try { const t = await SecureStore.getItemAsync(AUTH_TOKEN_KEY); if (t) return t; } catch {}
  try { return await AsyncStorage.getItem(AUTH_TOKEN_KEY); } catch { return null; }
}
async function clearAuthToken(): Promise<void> {
  try { await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY); } catch {}
  try { await AsyncStorage.removeItem(AUTH_TOKEN_KEY); } catch {}
  // Legacy key name — clean it up too so upgraded users don't end up with two tokens.
  try { await AsyncStorage.removeItem('authToken'); } catch {}
}

/** Detect auth-failure errors from `request()`. The backend throws
 *  HTTPException(401, "Invalid or expired token"); `request()` surfaces that
 *  as an Error whose .message is the detail string. We also match "401" /
 *  "unauthorized" for robustness in case other endpoints use different
 *  wording. Network errors and 5xx responses DON'T match here — those are
 *  treated as transient and leave the token alone. */
function isAuthFailureError(err: any): boolean {
  const msg = (err?.message ?? '').toLowerCase();
  return (
    msg.includes('401') ||
    msg.includes('unauthorized') ||
    msg.includes('invalid or expired') ||
    msg.includes('invalid token') ||
    msg.includes('expired token') ||
    // Fresh-DB case: JWT decodes but user lookup fails, backend returns
    // the same 401 "Invalid or expired token".
    msg.includes('not found') && msg.includes('user')
  );
}

/** Hard-clear everything tied to a previous session. Used when we detect
 *  a stale token at cold start (fresh DB, deleted user, etc.) so the user
 *  lands on the Auth screen with zero ghost state from the prior session. */
async function hardResetSession(): Promise<void> {
  await clearAuthToken();
  try { await AsyncStorage.removeItem(LAST_USER_ID_KEY); } catch {}
  try { await AsyncStorage.multiRemove(USER_SCOPED_KEYS); } catch {}
}

/** Track the last signed-in user id so we can detect a user switch on the
 *  same device. On a switch we wipe the previous user's cached data so the
 *  new user doesn't inherit it; on the same user returning we leave cache
 *  alone so sign-out → sign-in is non-destructive. */
const LAST_USER_ID_KEY = 'last_user_id';
/** Every AsyncStorage key that holds user-scoped state. When a different
 *  user signs in we remove all of these in one shot. This list also doubles
 *  as the set of keys synced to the backend via `pushUserState` —
 *  transient / device-only keys (pending plan job, metaData cache) are
 *  excluded from sync via SYNCED_STATE_KEYS below. */
const USER_SCOPED_KEYS = [
  'userProfile', 'aiWorkoutPlan',
  'aiNutritionPlan', 'aiNutritionPlanA', 'aiNutritionPlanB', 'aiNutritionPlanC', 'aiNutritionPlans',
  'trainerNote', 'nutritionistNote', 'supplementStack', 'metaData_v1',
  'weekStartDate', 'mealEdits', 'mealChecks',
  'workoutHistory', 'userLog', 'skippedWorkouts',
  'mealRoutines', 'planChangeHistory', 'goalHistory',
  // ── Per-user keys previously missing from sign-out wipe ─────────────
  // Without these, signing out + signing into a different account on
  // the same device left the prior user's workout summaries, checked
  // meals, completed-workout snapshots, and health data visible to the
  // new account. Every user-specific bucket must be in this list.
  'workoutSummaries',
  'preservedCompletedWorkouts',
  'preservedCheckedMeals',
  'healthSummary',
  'healthScoreResult',
  'appleHealthEnabled',
  'pendingProfileChanges',
  'pending_plan_job',
];

/** Keys that get pushed to the backend for cross-device sync. Subset of
 *  USER_SCOPED_KEYS that excludes device-only / transient state (meta
 *  cache, in-flight plan job id, device-specific health toggles). */
const SYNCED_STATE_KEYS = [
  'userProfile',
  // aiWorkoutPlan included — without this, sign-out → sign-in (or cross-device)
  // loses the user's generated plan, and loadPlans silently falls back to a
  // local client-side generator that produces a totally different split.
  'aiWorkoutPlan',
  'aiNutritionPlan', 'aiNutritionPlanA', 'aiNutritionPlanB', 'aiNutritionPlanC', 'aiNutritionPlans',
  'trainerNote', 'nutritionistNote', 'supplementStack',
  'weekStartDate', 'mealEdits', 'mealChecks',
  // workoutHistory synced — individual completions reach the backend via
  // logWorkoutDone, but without the local blob a wipe loses per-set detail.
  'workoutHistory',
  'userLog', 'skippedWorkouts',
  'mealRoutines', 'planChangeHistory', 'goalHistory',
  // workoutSummaries excluded — local-only derivative of workoutHistory
  'preservedCompletedWorkouts', 'preservedCheckedMeals',
  'healthSummary', 'healthScoreResult',
];

/** Push the local AsyncStorage state blob to the backend. Best-effort —
 *  swallows errors so a failed sync never blocks sign-out / app backgrounding. */
async function pushUserStateToBackend(token: string): Promise<void> {
  try {
    const pairs = await AsyncStorage.multiGet(SYNCED_STATE_KEYS);
    const state: Record<string, any> = {};
    for (const [k, v] of pairs) {
      if (v == null) continue;
      try { state[k] = JSON.parse(v); } catch { state[k] = v; }
    }
    await putUserState(token, state);
    console.log(`[user-state] pushed ${Object.keys(state).length} keys`);
  } catch (e: any) {
    console.warn('[user-state] push failed:', e?.message ?? e);
  }
}

/** Pull the backend state blob and write it into AsyncStorage. Called on
 *  sign-in (especially on a new device) so the user's data comes back. */
async function pullUserStateFromBackend(token: string): Promise<void> {
  try {
    const { state } = await getUserState(token);
    if (!state || Object.keys(state).length === 0) {
      console.log('[user-state] pull: empty remote state');
    } else {
      const pairs: [string, string][] = [];
      for (const [k, v] of Object.entries(state)) {
        if (v == null) continue;
        pairs.push([k, typeof v === 'string' ? v : JSON.stringify(v)]);
      }
      if (pairs.length > 0) await AsyncStorage.multiSet(pairs);
      console.log(`[user-state] pulled ${pairs.length} keys`);
    }
  } catch (e: any) {
    console.warn('[user-state] pull failed:', e?.message ?? e);
  }

  // Workout-history fallback: if local is empty (wipe / fresh install on a
  // user whose pre-sync state blob didn't include workoutHistory), rebuild
  // a skeleton from the backend completion markers. No per-set detail, but
  // dates/focuses/durations all come back.
  try {
    const existing = await AsyncStorage.getItem('workoutHistory');
    const localArr: any[] = existing ? JSON.parse(existing) : [];
    // Separate real locally-logged sessions from prior server-hydrated
    // skeletons. Skeletons are always safe to overwrite — the authoritative
    // source for them is the backend. Real local sessions (with ex detail
    // or non-server ids) we preserve.
    const realLocal = localArr.filter(s => typeof s?.id === 'string' && !s.id.startsWith('server-'));
    const completions = await listWorkoutCompletions(token, 100);
    if (completions.length > 0) {
      // Only treat non-strength categories as "manual activity" for display —
      // a real lifting workout (e.g. Legs) may have activity_category="strength"
      // tagged on the completion, but should render with its focus label, not
      // the humanized category.
      const MANUAL_CATEGORIES = new Set(['cardio', 'mobility', 'sport', 'active', 'recovery']);
      const skeleton = completions.map((c) => {
        const isManual = !!c.activity_category && MANUAL_CATEGORIES.has(c.activity_category);
        return {
          id: `server-${c.id}`,
          date: c.completed_at ?? `${c.workout_date}T12:00:00.000Z`,
          focus: c.focus_label,
          durationSeconds: c.duration_seconds,
          exercises: [],
          completed: true,
          ...(isManual ? {
            manualActivity: {
              category: c.activity_category as any,
              subtype: c.activity_subtype ?? '',
              intensity: c.activity_intensity as any,
            },
          } : {}),
        };
      });
      // Merge: skeletons from backend + any real local-logged sessions the
      // server doesn't know about. Dedupe same-date-same-focus (prefer real
      // local over skeleton since it has exercise detail).
      const merged = [...realLocal];
      for (const sk of skeleton) {
        const skDate = sk.date.slice(0, 10);
        const dupe = merged.some(m => m.date?.slice(0, 10) === skDate && m.focus === sk.focus);
        if (!dupe) merged.push(sk);
      }
      // Sort newest-first by date
      merged.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
      await AsyncStorage.setItem('workoutHistory', JSON.stringify(merged));
      console.log(`[user-state] hydrated ${skeleton.length} from backend; ${realLocal.length} real local kept; total=${merged.length}`);
    }
  } catch (e: any) {
    console.warn('[user-state] completion hydration failed:', e?.message ?? e);
  }
}
import { UserProfile, WorkoutDay, WorkoutSession, UserLogEntry, SupplementItem } from '../src/types';
import { getMyProfile, getMe, syncOnboarding, getAIPlans, getAIWorkoutPlan, getAINutritionPlan, upsertDayState, parseRecentWorkouts, logWorkoutDone, resumePendingPlanJob, getPendingPlanMarker, cancelPendingPlanJob, getUserState, putUserState, listWorkoutCompletions } from '../src/services/api';
import { clearAllSavedNutritionPlans } from '../src/utils/mealTracker';
import AuthScreen from '../src/screens/AuthScreen';
import OnboardingScreen from '../src/screens/OnboardingScreen';
import HomeScreen from '../src/screens/HomeScreen';
import EditProfileScreen from '../src/screens/EditProfileScreen';
import ActiveWorkoutScreen from '../src/screens/ActiveWorkoutScreen';
import ProgressScreen from '../src/screens/ProgressScreen';
import SupplementsScreen from '../src/screens/SupplementsScreen';
import { colors, getTheme, radius } from '../src/constants/theme';
import { recordGoalChange, loadWorkoutHistory, saveWorkoutSession, todayKey, isAppleHealthEnabled, setAppleHealthEnabled } from '../src/utils/workoutHistory';
import { isHealthKitAvailable, requestHealthPermissions } from '../src/services/appleHealth';

/** Stamp startWeightLbs + goalStartedAt when a goal is first set or changes. */
function stampGoalStart(profile: UserProfile, previous: UserProfile | null): UserProfile {
  const goalChanged = !previous || previous.goal !== profile.goal;
  if (goalChanged || !profile.goalDetails.goalStartedAt) {
    return {
      ...profile,
      goalDetails: {
        ...profile.goalDetails,
        startWeightLbs: profile.physicalStats.weightLbs,
        goalStartedAt: new Date().toISOString(),
      },
    };
  }
  return profile;
}

/** Guarded JSON.parse for AsyncStorage reads — returns fallback on any
 *  malformed payload. Used by the user-log and profile hydration paths
 *  so a single corrupted row never cascades into "can't sign in". */
function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

async function appendUserLog(entry: Omit<UserLogEntry, 'id' | 'date'>) {
  try {
    const raw = await AsyncStorage.getItem('userLog');
    const log: UserLogEntry[] = raw ? JSON.parse(raw) : [];
    const newEntry: UserLogEntry = {
      id: Date.now().toString(),
      date: new Date().toISOString(),
      ...entry,
    };
    // Keep last 50 entries
    const trimmed = [newEntry, ...log].slice(0, 50);
    await AsyncStorage.setItem('userLog', JSON.stringify(trimmed));
  } catch {}
}

export default function Index() {
  const [isLoading, setIsLoading]         = useState(true);
  const [authToken, setAuthToken]         = useState<string | null>(null);
  const [userProfile, setUserProfile]     = useState<UserProfile | null>(null);
  const [isEditing, setIsEditing]         = useState(false);
  const [editMode, setEditMode]           = useState<'goal' | 'workout' | 'mealplan' | 'theme'>('goal');
  const [pendingSave, setPendingSave]     = useState<{ profile: UserProfile; mode: string } | null>(null);
  // Optional sub-tab to pre-select when opening the EditProfileScreen in
  // 'mealplan' mode. Lets HomeScreen jump straight into Foods/Supplements/Macros.
  const [editInitialMealTab, setEditInitialMealTab] = useState<'foods' | 'supplements' | 'macros' | undefined>(undefined);
  const [planRefreshKey, setPlanRefreshKey] = useState(0);
  const [isWorkoutUpdating, setIsWorkoutUpdating] = useState(false);
  const [isNutritionUpdating, setIsNutritionUpdating] = useState(false);
  const [showProgress, setShowProgress]   = useState(false);
  const [showAccount, setShowAccount]     = useState(false);
  const [showSupplements, setShowSupplements] = useState(false);
  const [activeWorkout, setActiveWorkoutRaw] = useState<WorkoutDay | null>(null);
  const [resumeWorkoutData, setResumeWorkoutData] = useState<{ workout: any; loggedCount: number } | null>(null);
  const setActiveWorkout = useCallback((w: WorkoutDay | null) => {
    setActiveWorkoutRaw(w);
    if (w) {
      AsyncStorage.setItem('activeWorkoutSession', JSON.stringify(w)).catch(() => {});
    } else {
      AsyncStorage.removeItem('activeWorkoutSession').catch(() => {});
    }
  }, []);
  const [trainerNote, setTrainerNote]     = useState<string | null>(null);
  const [nutritionistNote, setNutritionistNote] = useState<string | null>(null);
  const [supplementStack, setSupplementStack] = useState<SupplementItem[]>([]);
  // Ref so AppState listener can call the latest version of the resume
  // handler without restarting the subscription on every render.
  const resumePlanGenRef = useRef<() => Promise<void>>(async () => {});

  /** Cancel the current plan-generation job on the server. The poll loop
   *  picks up the cancelled status and throws, which the existing .catch
   *  handlers turn into a no-op (cancel-specific messages suppressed). */
  const cancelPlanGen = async () => {
    if (authToken) {
      try { await cancelPendingPlanJob(authToken); } catch {}
    }
    await clearPlanGenMarker();
    setIsWorkoutUpdating(false);
    setIsNutritionUpdating(false);
    releasePlanGenAwake();
  };

  /** Merge AI-returned custom foods into the user profile's customFoods list */
  const _mergeCustomFoods = async (foods: Array<{ name: string; unit?: string; calories: number; protein: number; carbs: number; fat: number }>) => {
    try {
      const raw = await AsyncStorage.getItem('userProfile');
      if (!raw) return;
      const prof = JSON.parse(raw);
      const existing: Array<{ name: string }> = prof.customFoods ?? [];
      const existingNames = new Set(existing.map(f => f.name.toLowerCase()));
      const newFoods = foods.filter(f => f.calories > 0 && !existingNames.has(f.name.toLowerCase()));
      if (!newFoods.length) return;
      prof.customFoods = [
        ...existing,
        ...newFoods.map(f => ({
          name: f.name,
          unit: f.unit ?? '1 serving',
          calories: Math.round(f.calories),
          protein: Math.round(f.protein),
          carbs: Math.round(f.carbs),
          fat: Math.round(f.fat),
        })),
      ];
      await AsyncStorage.setItem('userProfile', JSON.stringify(prof));
      console.log(`[_mergeCustomFoods] added ${newFoods.length} custom foods`);
    } catch {}
  };

  useEffect(() => { initApp(); }, []);

  // AppState listener:
  //   - 'active' → check for an orphaned plan job and resume polling
  //   - 'background' / 'inactive' → push local state to the backend as a
  //     safety net so users who never explicitly sign out still get their
  //     latest state synced
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        resumePlanGenRef.current?.().catch(() => null);
      } else if (nextState === 'background' || nextState === 'inactive') {
        if (authToken) pushUserStateToBackend(authToken).catch(() => null);
      }
    });
    return () => sub.remove();
  }, [authToken]);

  const initApp = async () => {
    const CACHE_VERSION = '5';
    const storedVersion = await AsyncStorage.getItem('cacheVersion');
    if (storedVersion !== CACHE_VERSION) {
      await AsyncStorage.multiRemove([
        'userProfile', 'aiWorkoutPlan',
        'aiNutritionPlan', 'aiNutritionPlanA', 'aiNutritionPlanB', 'aiNutritionPlanC',
        'trainerNote', 'nutritionistNote', 'supplementStack',
        'workoutHistory', 'skippedWorkouts',
        'mealChecks', 'mealEdits', 'userLog',
        'weekStartDate', 'metaData_v1',
      ]);
      await AsyncStorage.setItem('cacheVersion', CACHE_VERSION);
    }
    // Load persisted coach notes
    const [tn, nn, ss] = await Promise.all([
      AsyncStorage.getItem('trainerNote'),
      AsyncStorage.getItem('nutritionistNote'),
      AsyncStorage.getItem('supplementStack'),
    ]);
    if (tn) setTrainerNote(tn);
    if (nn) setNutritionistNote(nn);
    if (ss) { try { setSupplementStack(JSON.parse(ss)); } catch {} }

    // Restore active workout if user was mid-session when the app was killed.
    // Show a resume/discard prompt so the user isn't silently thrown back
    // into a workout they may have intended to abandon.
    try {
      const savedWorkout = await AsyncStorage.getItem('activeWorkoutSession');
      if (savedWorkout) {
        const parsed = JSON.parse(savedWorkout);
        if (parsed && parsed.exercises) {
          const savedSets = await AsyncStorage.getItem('activeWorkoutSets');
          const loggedCount = savedSets
            ? (JSON.parse(savedSets) as any[]).filter(e => e.sets?.length > 0).length
            : 0;
          // Only prompt resume if the user actually logged at least one set.
          // Without this, starting a workout then force-killing the app
          // before logging anything shows a confusing resume prompt.
          if (loggedCount > 0) {
            setResumeWorkoutData({ workout: parsed, loggedCount });
          } else {
            AsyncStorage.removeItem('activeWorkoutSession').catch(() => {});
            AsyncStorage.removeItem('activeWorkoutSets').catch(() => {});
            AsyncStorage.removeItem('activeWorkoutStartTime').catch(() => {});
          }
        }
      }
    } catch {}

    // NOTE: we intentionally do NOT clear the plan-gen marker on cold start.
    // Closing the app should not cancel an in-flight plan generation — the
    // backend job queue holds state server-side, and the client picks it up
    // on next open via the polling loop.

    // Restore persisted auth token. If we have one, validate against the
    // backend so an expired/revoked token sends the user to the login screen
    // instead of silently hanging. Network errors are tolerated — we keep the
    // token optimistically and let individual requests surface errors.
    //
    // IMPORTANT: we `await loadProfile` BEFORE `setAuthToken` so the first
    // render after isLoading=false has BOTH the token and the profile in
    // place. Otherwise React renders one frame with authToken set but
    // userProfile still null, which trips the `if (!userProfile) return
    // <OnboardingScreen>` branch and flashes the onboarding screen for a
    // split second.
    const persistedToken = await loadAuthToken();
    if (persistedToken) {
      try {
        const meData = await getMe(persistedToken);
        if ((meData as any)?.username) {
          await AsyncStorage.setItem('user_username', (meData as any).username);
        }
        await loadProfile(persistedToken);
        // Cold-start hydration: if local history / synced state are empty
        // (e.g. user wiped app data), restore from backend. pullUserState
        // handles the blob + has an explicit workoutHistory fallback.
        pullUserStateFromBackend(persistedToken).catch(() => null);
        setAuthToken(persistedToken);
      } catch (err: any) {
        if (isAuthFailureError(err)) {
          console.log('[initApp] stale token detected, hard-resetting session:', err?.message);
          await hardResetSession();
        } else {
          // Transient failure (no network, backend down): keep the token so
          // the next successful request re-establishes the session. We
          // still try to hydrate the profile from cache.
          try { await loadProfile(persistedToken); } catch {}
          setAuthToken(persistedToken);
        }
      }
    }
    setIsLoading(false);

    // After init, if a plan job is still running on the server from a
    // previous session, reconnect and pick up the result. This is what
    // makes "close the app, come back, your plan is ready" work.
    // Deferred to next tick so setAuthToken has committed to state.
    setTimeout(() => {
      resumePlanGenRef.current?.().catch(() => null);
    }, 100);
  };

  /** Save the AI plan result to AsyncStorage + state. Factored out so
   *  every path (sync gen, resumed-from-queue, weekly refresh, chat update)
   *  writes the same keys in the same order. */
  const applyPlanResult = async (aiPlans: any): Promise<void> => {
    if (aiPlans?.workout_plan) {
      await AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(aiPlans.workout_plan));
      const tnNote = aiPlans.trainerNote ?? aiPlans.workout_plan?.trainerNote;
      if (tnNote) { await AsyncStorage.setItem('trainerNote', tnNote); setTrainerNote(tnNote); }
    }
    // Canonical nutrition shape: `nutrition_plans` as a dynamic-length array.
    // Fall back to the legacy A/B/C keys if the server still uses the old
    // shape (either because it's an old server build or a cached payload
    // being re-applied after backgrounding).
    const plansList: any[] = Array.isArray(aiPlans?.nutrition_plans)
      ? aiPlans.nutrition_plans
      : [aiPlans?.nutrition_plan_a, aiPlans?.nutrition_plan_b, aiPlans?.nutrition_plan_c].filter(Boolean);
    if (plansList.length > 0) {
      // Wipe per-day nutrition saves first. Otherwise stale day-specific
      // edits from a previous regen shadow the new templates and the user
      // sees yesterday's plan on every day (variety=1 looked like variety=N).
      await clearAllSavedNutritionPlans();
      // Stamp every template with a fresh version. HomeScreen rejects
      // any per-day save / remote day-state whose stamp doesn't match,
      // so stale data from a previous regen can't shadow these.
      const templatesVersion = `v_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      for (const p of plansList) {
        if (p && typeof p === 'object') (p as any)._templatesVersion = templatesVersion;
      }
      // New canonical key — an array of N templates. HomeScreen's loadPlans
      // rotates across these regardless of length.
      await AsyncStorage.setItem('aiNutritionPlans', JSON.stringify(plansList));
      // Legacy keys preserved so any code path that still reads them
      // (older HomeScreen builds, app-state sync) keeps working.
      await AsyncStorage.setItem('aiNutritionPlanA', JSON.stringify(plansList[0]));
      await AsyncStorage.setItem('aiNutritionPlan', JSON.stringify(plansList[0]));
      if (plansList[1]) await AsyncStorage.setItem('aiNutritionPlanB', JSON.stringify(plansList[1]));
      else await AsyncStorage.removeItem('aiNutritionPlanB');
      if (plansList[2]) await AsyncStorage.setItem('aiNutritionPlanC', JSON.stringify(plansList[2]));
      else await AsyncStorage.removeItem('aiNutritionPlanC');
    }
    if (aiPlans?.nutritionistNote) { await AsyncStorage.setItem('nutritionistNote', aiPlans.nutritionistNote); setNutritionistNote(aiPlans.nutritionistNote); }
    if (aiPlans?.supplementStack?.length) {
      await AsyncStorage.setItem('supplementStack', JSON.stringify(aiPlans.supplementStack));
      setSupplementStack(aiPlans.supplementStack);
    }
    if (aiPlans?.custom_foods?.length) await _mergeCustomFoods(aiPlans.custom_foods);
    setPlanRefreshKey(k => k + 1);
  };

  /** Resume polling an in-flight plan job if one was persisted. Called from
   *  `initApp` (cold start) and the AppState 'active' listener. The server
   *  is holding the job so this survives any amount of app kill / network
   *  interruption — we just need to reconnect to it. */
  const resumePlanGenIfPending = async () => {
    if (!authToken) return;
    const marker = await getPendingPlanMarker();
    if (!marker) return;
    // If the user already has a completed plan in AsyncStorage, the pending
    // marker is stale from a previous generation that already finished.
    // Clear it instead of re-applying the plan on every app restart.
    const existingPlan = await AsyncStorage.getItem('aiWorkoutPlan').catch(() => null);
    if (existingPlan) {
      // Also check the local marker — if it has a startedAt, compare age
      const localMarker = await readPlanGenMarker();
      const age = localMarker?.startedAt ? Date.now() - localMarker.startedAt : Infinity;
      if (age > 5 * 60 * 1000) {
        console.log(`[plan-gen] stale marker (plan exists, marker ${Math.round(age / 60000)}min old) — clearing`);
        await clearPlanGenMarker();
        return;
      }
    }
    // IMPORTANT: we do NOT bail when updating flags are already set.
    // The original polling promise may be stuck in a suspended setTimeout
    // (iOS freezes JS when the app backgrounds) and will never finish on
    // its own. Always kick a fresh poll here — if the old promise is
    // somehow still alive, the first one to see `completed` wins and the
    // loser throws `cancelled` which we swallow.

    console.log(`[plan-gen] resuming pending job id=${marker.id} kind=${marker.kind}`);
    // Only show the loading overlay if the user has no existing plan to display.
    // If they already have a plan, poll silently — the updating overlay causes
    // a jarring white flash on cold start when the existing plan is perfectly usable.
    const hasExistingPlan = !!(await AsyncStorage.getItem('aiWorkoutPlan').catch(() => null));
    if (!hasExistingPlan) {
      if (marker.kind === 'workout' || marker.kind === 'full') setIsWorkoutUpdating(true);
      if (marker.kind === 'nutrition' || marker.kind === 'full') setIsNutritionUpdating(true);
    }
    holdPlanGenAwake();
    try {
      const aiPlans = await resumePendingPlanJob(authToken);
      if (aiPlans) {
        await applyPlanResult(aiPlans);
        await clearPlanGenMarker();
        Alert.alert('Plan ready', 'Your new plan is done — tap anywhere to continue.');
      } else {
        // Job completed with no data or already consumed — clear the stale marker
        await clearPlanGenMarker();
      }
    } catch (err: any) {
      const msg = err?.message ?? '';
      if (msg.toLowerCase().includes('cancelled')) {
        console.log('[plan-gen] resume: job was cancelled');
      } else if (msg.includes('orphaned_on_restart')) {
        // Backend restarted mid-generation — the job is lost. Let the user
        // know gently and give them a one-tap retry rather than a scary
        // "failed" message.
        console.log('[plan-gen] resume: orphaned by backend restart');
        Alert.alert(
          'Plan generation interrupted',
          'Your last plan was interrupted. Tap OK and generate again from the profile menu.',
        );
      } else {
        console.error('[plan-gen] resume failed:', msg);
        Alert.alert('Plan generation failed', msg || 'Try again from the profile menu.');
      }
    } finally {
      await clearPlanGenMarker();
      setIsWorkoutUpdating(false);
      setIsNutritionUpdating(false);
      releasePlanGenAwake();
    }
  };

  // Keep the ref pointed at the latest closure so the AppState listener
  // always has the current auth token + profile available.
  useEffect(() => {
    resumePlanGenRef.current = resumePlanGenIfPending;
  });

  const loadProfile = async (token: string) => {
    let profile: UserProfile | null = null;
    const stored = await AsyncStorage.getItem('userProfile');
    if (stored) {
      // Guard the parse — corrupted AsyncStorage blobs (rare but possible
      // after a force-kill mid-write) must not brick every future sign-in.
      // Fall through to the remote fetch and re-populate from there.
      try { profile = JSON.parse(stored); }
      catch { profile = null; await AsyncStorage.removeItem('userProfile').catch(() => {}); }
    }
    if (!profile) {
      const remote = await getMyProfile(token);
      if (remote) {
        await AsyncStorage.setItem('userProfile', JSON.stringify(remote));
        profile = remote;
      }
    }
    if (!profile) return;
    setUserProfile(profile);

    // Backfill the backend's UserProfile row if it's missing. A test user
    // who signs in on top of a stale local profile, or whose original
    // syncOnboarding fire-and-forget silently failed, will have no
    // UserProfile row in the DB — which makes /profile/calorie-ranges
    // return 404 forever and leaves the macros card stuck on "estimates
    // unavailable". Sync is cheap, idempotent, and only runs at boot.
    const ps = profile.physicalStats;
    const hasRequiredFields = !!(
      ps && ps.weightLbs && ps.heightFeet != null && ps.heightInches != null && ps.age && ps.gender
    );
    if (hasRequiredFields) {
      syncOnboarding(token, profile).catch((e) =>
        console.warn('[loadProfile] backend sync failed (non-fatal)', e?.message ?? e),
      );
    } else {
      console.warn('[loadProfile] local profile missing required fields, skipping sync', {
        weightLbs: ps?.weightLbs, heightFeet: ps?.heightFeet, heightInches: ps?.heightInches,
        age: ps?.age, gender: ps?.gender,
      });
    }

    // Rehydrate in-memory caches that sign-out cleared — these live in
    // AsyncStorage persistently, but the React state got reset when the
    // user signed out, so the coach notes / supplements need re-setting.
    try {
      const [tn, nn, ss] = await Promise.all([
        AsyncStorage.getItem('trainerNote'),
        AsyncStorage.getItem('nutritionistNote'),
        AsyncStorage.getItem('supplementStack'),
      ]);
      if (tn) setTrainerNote(tn);
      if (nn) setNutritionistNote(nn);
      if (ss) { try { setSupplementStack(JSON.parse(ss)); } catch {} }
    } catch {}

    // NOTE: auto-regeneration of missing plans has been removed from this
    // path. It was firing on sign-in (because sign-out used to wipe the
    // plan cache) and on any cold start where the cache hadn't yet been
    // populated. Plan generation is an expensive, minutes-long LLM call
    // and should only happen on explicit user intent — onboarding flow,
    // profile edit save, weekly review, or an explicit "Generate plan"
    // tap. If a user signs in and has no plan yet, they see the empty
    // state; they can kick a generation from the profile menu when ready.
  };

  const handleAuthenticated = async (token: string, isNewUser: boolean) => {
    // For returning users, persist the token immediately so switching apps
    // doesn't force re-login. For NEW signups, we hold off persisting until
    // onboarding completes — if the user quits halfway through, the in-memory
    // token dies with the process and they start over on next launch.
    if (!isNewUser) {
      await saveAuthToken(token);
    }

    // Detect a user switch on the same device. If a different user signs in,
    // we wipe the previous user's cached state so their plans/notes/routines
    // don't leak through. Same user returning? Keep the cache — sign-out
    // should be non-destructive.
    let incomingUserId: string | number | null = null;
    try {
      const me = await getMe(token);
      incomingUserId = (me as any)?.id ?? (me as any)?.user_id ?? null;
      if ((me as any)?.username) {
        await AsyncStorage.setItem('user_username', (me as any).username);
      }
    } catch {
      incomingUserId = null;
    }
    const previousUserId = await AsyncStorage.getItem(LAST_USER_ID_KEY);
    const userSwitched = incomingUserId != null
      && previousUserId != null
      && String(incomingUserId) !== String(previousUserId);
    if (incomingUserId != null) {
      await AsyncStorage.setItem(LAST_USER_ID_KEY, String(incomingUserId));
    }

    // IMPORTANT: we hydrate profile state BEFORE setting authToken. If we
    // set authToken first, React renders one frame where authToken is
    // present but userProfile is still null — the `if (!userProfile)
    // return <OnboardingScreen>` branch fires and we flash the onboarding
    // screen for a split second before loadProfile lands.
    if (isNewUser) {
      // Brand new account — wipe any leftover state, then fall into the
      // onboarding flow (userProfile stays null).
      await AsyncStorage.multiRemove(USER_SCOPED_KEYS);
      setUserProfile(null);
      setTrainerNote(null);
      setNutritionistNote(null);
      setSupplementStack([]);
      setAuthToken(token);
      return;
    }

    if (userSwitched) {
      // Different user on same device — clear the previous user's state
      // before hydrating this one so nothing leaks across accounts.
      await AsyncStorage.multiRemove(USER_SCOPED_KEYS);
      setTrainerNote(null);
      setNutritionistNote(null);
      setSupplementStack([]);
    }

    // Same user (or user-switched) — pull from backend first, then load
    // profile from cache, THEN flip the token so the render lands straight
    // on HomeScreen with all the data in place.
    await pullUserStateFromBackend(token);
    await loadProfile(token);
    setAuthToken(token);
  };

  const handleProfileComplete = async (profile: UserProfile) => {
    const stamped = stampGoalStart(profile, null);
    await AsyncStorage.setItem('userProfile', JSON.stringify(stamped));

    if (!authToken) {
      setUserProfile(stamped);
      return;
    }
    // Onboarding is complete — NOW persist the auth token so the user stays
    // signed in across app restarts. Held off until this point so a
    // half-finished signup doesn't leave a stale token on disk.
    await saveAuthToken(authToken);
    syncOnboarding(authToken, stamped).catch(() => null);

    // Show loading screen while generating the initial plan.
    // DON'T set userProfile yet — that would mount HomeScreen which
    // triggers its own loadPlans, causing a white flash.
    setIsLoading(true);
    setIsWorkoutUpdating(true);
    setIsNutritionUpdating(true);
    holdPlanGenAwake();
    setPlanGenMarker('full').catch(() => null);

    getAIPlans(authToken, stamped, stamped.lastWorkoutContext ? { extraContext: `Recent workout context from user: ${stamped.lastWorkoutContext}` } : undefined)
      .then(async (aiPlans) => {
        // Centralized handler: writes all storage keys, stamps the
        // templates with a fresh version, and wipes per-day nutrition
        // saves so the new rotation actually replaces the old days
        // instead of being shadowed by stale per-day storage.
        await applyPlanResult(aiPlans);
        // Track when this week's plan started
        await AsyncStorage.setItem('weekStartDate', new Date().toISOString());
        await appendUserLog({ type: 'plan_generated', summary: `Initial plan generated for goal: ${stamped.goal.replace(/_/g, ' ')}` });
        setPlanRefreshKey(k => k + 1);

        // Parse onboarding workout context into logged sessions
        if (stamped.lastWorkoutContext && authToken) {
          try {
            const parsed = await parseRecentWorkouts(authToken, stamped.lastWorkoutContext);
            console.log('[onboarding] parseRecentWorkouts response:', JSON.stringify(parsed));
            for (const s of (parsed.sessions ?? [])) {
              const session: WorkoutSession = {
                id: `onboarding-${s.date}-${Date.now()}`,
                date: new Date(s.date + 'T12:00:00').toISOString(),
                focus: s.focus || 'General',
                durationSeconds: s.durationSeconds || 3600,
                exercises: (s.exercises ?? []).map((ex: any) => ({
                  name: ex.name,
                  targetSets: ex.sets?.length ?? 0,
                  targetReps: '',
                  targetRestSeconds: 60,
                  equipment: '',
                  sets: (ex.sets ?? []).map((set: any) => ({
                    weightLbs: set.weightLbs ?? 0,
                    reps: set.reps ?? 0,
                  })),
                })),
                completed: true,
              };
              await saveWorkoutSession(session);
              // Sync to backend so getWorkoutStatus() sees it
              const sessionDate = s.date || new Date(session.date).toISOString().slice(0, 10);
              await logWorkoutDone(authToken, sessionDate, session.focus, session.durationSeconds).catch(e =>
                console.warn('[onboarding] logWorkoutDone failed for', sessionDate, e),
              );
            }
            if (parsed.sessions?.length) {
              console.log(`[onboarding] logged ${parsed.sessions.length} workout sessions from context`);
              setPlanRefreshKey(k => k + 1); // refresh to show today as done
            }
          } catch (e) {
            console.warn('[onboarding] failed to parse workout context:', e);
          }
        }
      })
      .catch((err) => {
        const msg = err?.message ?? '';
        if (msg.toLowerCase().includes('cancelled')) return;  // user cancelled, no alert
        if (msg.includes('orphaned_on_restart')) return;     // handled by resume flow
        Alert.alert('Plan generation failed', msg || 'Could not reach the AI server. Make sure the backend is running and try again.');
      })
      .then(() => clearPlanGenMarker().catch(() => null))
      .finally(() => {
        setUserProfile(stamped);  // NOW mount HomeScreen — plan data is ready
        setIsLoading(false);
        setIsWorkoutUpdating(false);
        setIsNutritionUpdating(false);
        releasePlanGenAwake();
      });
  };

  const handleSignOut = async () => {
    // Push the current state to the backend BEFORE clearing the token so
    // the next sign-in (or a sign-in on another device) restores
    // everything. Best-effort — swallows errors.
    if (authToken) {
      await pushUserStateToBackend(authToken);
    }
    // Clear any in-flight plan-job marker — otherwise the next sign-in sees
    // a stale pending id, tries to resume it, and the user thinks we're
    // triggering a fresh plan generation on sign-in. The marker is
    // session-scoped: the backend job is still in the database if it's
    // actually running, but this device won't try to reconnect to it.
    try { await AsyncStorage.removeItem('pending_plan_job'); } catch {}
    // Sign-out is now non-destructive for disk state — we only clear the
    // auth token and reset in-memory React state so the user lands on the
    // login screen. The cached profile / plans / routines stay on device
    // so the same user signing back in restores everything instantly.
    // A DIFFERENT user signing in is handled in `handleAuthenticated` via
    // the user-switch detection, which wipes before hydrating.
    await clearAuthToken();
    setAuthToken(null);
    setUserProfile(null);
    setIsEditing(false);
    setEditMode('goal');
    setShowProgress(false);
    setShowAccount(false);
    setShowSupplements(false);
    setActiveWorkout(null);
    // Keep trainerNote / nutritionistNote / supplementStack in memory so if
    // the same user signs back in they don't flicker away — they'll be
    // re-populated from AsyncStorage by loadProfile anyway.
  };

  // Optional explicit mode override — used by the inline tab editors in
  // HomeScreen which don't go through the EditProfileScreen modal so
  // `editMode` state would otherwise be stale and the wrong section
  // would regenerate (or nothing would).
  const handleSaveProfile = async (updated: UserProfile, modeOverride?: typeof editMode) => {
    const effectiveMode = modeOverride ?? editMode;

    // For goal and workout changes that trigger regen, show a confirmation first
    if (effectiveMode === 'goal' || effectiveMode === 'workout') {
      const willRegen = effectiveMode === 'goal'
        ? (userProfile?.goal !== updated.goal || userProfile?.goalDetails?.pace !== updated.goalDetails?.pace)
        : true;  // workout settings always regen
      if (willRegen) {
        setPendingSave({ profile: updated, mode: effectiveMode });
        return;
      }
    }
    await _doSaveProfile(updated, modeOverride);
  };

  const _doSaveProfile = async (updated: UserProfile, modeOverride?: typeof editMode) => {
    const effectiveMode = modeOverride ?? editMode;
    const stamped = stampGoalStart(updated, userProfile);
    // Record goal history only when the user actually used the GOAL
    // edit screen AND the goal/pace changed. We used to compute this
    // off a raw profile diff, which meant any unrelated field drift
    // inside a workout-only edit (e.g. `goalDetails` normalization)
    // silently flipped this true and triggered a full-plan regen +
    // full-screen spinner.
    const goalChanged =
      effectiveMode === 'goal' &&
      !!userProfile &&
      (
        userProfile.goal !== updated.goal ||
        userProfile.goalDetails?.pace !== updated.goalDetails?.pace
      );
    if (goalChanged) {
      await recordGoalChange(updated.goal, updated.goalDetails.pace, updated.physicalStats.weightLbs);
    }
    await AsyncStorage.setItem('userProfile', JSON.stringify(stamped));
    setUserProfile(stamped);
    const priorEditMode = effectiveMode;
    setIsEditing(false);
    setEditMode('goal');
    // Sync to backend so the edit is available on other devices.
    if (authToken) pushUserStateToBackend(authToken).catch(() => null);
    if (authToken) {
      syncOnboarding(authToken, stamped).catch(() => null);

      // Regen strictly by edit mode. Workout edits NEVER touch
      // nutrition and vice versa. Goal edits regenerate both only if
      // `goalChanged` is true.
      const regenWorkout  = priorEditMode === 'workout' || (priorEditMode === 'goal' && goalChanged);
      const regenNutrition = priorEditMode === 'mealplan' || (priorEditMode === 'goal' && goalChanged);

      if (regenWorkout || regenNutrition) {
        // Preserve today's logged meals when regenerating nutrition
        if (regenNutrition) {
          const today = todayKey();
          const rawEdits = await AsyncStorage.getItem('mealEdits');
          if (rawEdits) {
            try {
              const allEdits = JSON.parse(rawEdits);
              const todayEdit = allEdits[today];
              if (todayEdit) {
                await AsyncStorage.setItem('mealEdits', JSON.stringify({ [today]: todayEdit }));
              } else {
                await AsyncStorage.removeItem('mealEdits');
              }
            } catch { await AsyncStorage.removeItem('mealEdits'); }
          }
        }

        const userLogRaw = await AsyncStorage.getItem('userLog');
        const userLog: import('../src/types').UserLogEntry[] = safeParse<import('../src/types').UserLogEntry[]>(userLogRaw, []);

        // Build last 3 workout sessions as context
        const recentSessions = (await loadWorkoutHistory())
          .filter(s => !s.skipped && s.completed)
          .slice(0, 3);
        const sessionLines = recentSessions.length
          ? 'Last 3 completed workouts (use to assess muscle recovery and schedule accordingly):\n' +
            recentSessions.map(s => {
              const muscleGroups = (s.exercises ?? [])
                .map(e => e.name)
                .slice(0, 5)
                .join(', ');
              return `  [${s.date.slice(0, 10)}] ${s.focus}${muscleGroups ? `: ${muscleGroups}` : ''}`;
            }).join('\n')
          : '';
        const extraContext = sessionLines || undefined;

        await AsyncStorage.removeItem('pendingProfileChanges').catch(() => null);

        if (regenWorkout) setIsWorkoutUpdating(true);
        if (regenNutrition) setIsNutritionUpdating(true);
        if (regenWorkout || regenNutrition) holdPlanGenAwake();

        const opts = { userLog, extraContext };

        // Goal change → regenerate both via single call
        // Workout-only edit → regenerate just workout plan
        // Mealplan-only edit → regenerate just nutrition plan
        const planCall = (regenWorkout && regenNutrition)
          ? getAIPlans(authToken, stamped, opts)
          : regenWorkout
            ? getAIWorkoutPlan(authToken, stamped, opts)
            : getAINutritionPlan(authToken, stamped, opts);

        planCall
          .then(async (aiPlans: any) => {
            // Centralized handler — see applyPlanResult for what it does
            // (storage writes, templates version stamp, per-day saves wipe).
            await applyPlanResult(aiPlans);
            // Only reset week timer on full regens, not single-side edits.
            if (aiPlans.nutrition_plans?.length && regenWorkout && regenNutrition) {
              await AsyncStorage.setItem('weekStartDate', new Date().toISOString());
            }
            // Push the freshly-rotated plan onto the next 3 days of remote
            // day-state so cross-device reads don't briefly show the old
            // plan before HomeScreen catches up.
            if (aiPlans.nutrition_plans?.length) {
              const todayDate = new Date();
              const tok = authToken;
              for (let i = 0; i < 3; i++) {
                const d = new Date(todayDate);
                d.setDate(todayDate.getDate() + i);
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                upsertDayState(tok, key, { nutrition_plan: null }).catch(() => null);
              }
            }
            const what = (regenWorkout && regenNutrition) ? 'full plan' : regenWorkout ? 'workout plan' : 'nutrition plan';
            await appendUserLog({ type: 'plan_generated', summary: `${what} updated for goal: ${stamped.goal.replace(/_/g, ' ')}` });
            setPlanRefreshKey(k => k + 1);
          })
          .catch((err: any) => {
            const msg = err?.message ?? '';
            if (msg.toLowerCase().includes('cancelled')) return;  // user cancelled
            if (msg.includes('orphaned_on_restart')) return;     // handled by resume flow
            console.error('[planCall] failed:', msg || err);
            Alert.alert('Plan generation failed', msg || 'Could not reach the AI server. Make sure the backend is running and try again.');
          })
          .finally(() => {
            setIsWorkoutUpdating(false);
            setIsNutritionUpdating(false);
            releasePlanGenAwake();
          });
      }
    }
  };

  const handleSaveSupplements = async (updated: UserProfile) => {
    await AsyncStorage.setItem('userProfile', JSON.stringify(updated));
    setUserProfile(updated);
    setShowSupplements(false);
    if (authToken) syncOnboarding(authToken, updated).catch(() => null);
  };

  const handleWorkoutFinish = (_session: WorkoutSession) => {
    setActiveWorkout(null);
    // Bump refresh key so HomeScreen re-checks workout status from
    // the backend DB. Without this, todayDone stays false until the
    // user manually reloads — even though logWorkoutDone already
    // wrote the completion to the server inside ActiveWorkoutScreen.
    setPlanRefreshKey(k => k + 1);
  };

  const handleUpdateWeight = async (weightLbs: number) => {
    if (!userProfile) return;
    const updated: UserProfile = {
      ...userProfile,
      physicalStats: { ...userProfile.physicalStats, weightLbs },
    };
    await AsyncStorage.setItem('userProfile', JSON.stringify(updated));
    setUserProfile(updated);
    if (authToken) syncOnboarding(authToken, updated).catch(() => null);
    // Sync to weight history so Body Check trend stays current
    try {
      const { saveWeightEntry } = await import('../src/utils/weightHistory');
      await saveWeightEntry(weightLbs, 'manual');
    } catch {}
    await appendUserLog({ type: 'weight_updated', summary: `Weight updated to ${weightLbs} lbs` });
  };

  if (isLoading) return <SplashLoadingScreen />;
  if (!authToken) return <AuthScreen onAuthenticated={handleAuthenticated} />;
  if (!userProfile) return (
    <OnboardingScreen
      authToken={authToken ?? ''}
      onComplete={handleProfileComplete}
      onExit={async () => {
        // Abandoning signup — wipe local state, clear in-memory token, and
        // send the user back to the auth screen. The backend account
        // lingers (they can sign in later), but nothing is left on device.
        try { await AsyncStorage.multiRemove(USER_SCOPED_KEYS); } catch {}
        try { await AsyncStorage.removeItem(LAST_USER_ID_KEY); } catch {}
        try { await clearAuthToken(); } catch {}
        setAuthToken(null);
        setUserProfile(null);
        setTrainerNote(null);
        setNutritionistNote(null);
        setSupplementStack([]);
      }}
    />
  );

  // ActiveWorkoutScreen is a long-duration full takeover — unmount HomeScreen
  // while a workout is active so its effects/timers stop.
  if (activeWorkout) {
    return (
      <ActiveWorkoutScreen
        authToken={authToken}
        workout={activeWorkout}
        goal={userProfile.goal}
        themeName={userProfile.themePreference}
        weightLbs={userProfile.physicalStats.weightLbs}
        onFinish={handleWorkoutFinish}
        onCancel={() => setActiveWorkout(null)}
        onDislikeExercise={(name) => {
          const existing = userProfile.dislikedExercises ?? [];
          if (existing.some(d => d.toLowerCase() === name.toLowerCase())) return;
          const updated = [...existing, name];
          handleProfileUpdate({ dislikedExercises: updated } as any, true);
        }}
      />
    );
  }

  // Everything else is an OVERLAY on top of HomeScreen so that plan generation
  // in flight is preserved across menu navigation. Unmounting HomeScreen while
  // a plan is generating caused it to look like the plan restarted on return.
  return (
    <>
      <HomeScreen
        authToken={authToken}
        userProfile={userProfile}
        planRefreshKey={planRefreshKey}
        isWorkoutUpdating={isWorkoutUpdating}
        isNutritionUpdating={isNutritionUpdating}
        onCancelPlanGen={cancelPlanGen}
        trainerNote={trainerNote}
        nutritionistNote={nutritionistNote}
        supplementStack={supplementStack}
        onSignOut={handleSignOut}
        onEditGoal={() => { setEditMode('goal'); setIsEditing(true); }}
        onEditWorkout={() => { setEditMode('workout'); setIsEditing(true); }}
        onEditMealPlan={(initialTab?: 'foods' | 'supplements' | 'macros') => {
          setEditMode('mealplan');
          setEditInitialMealTab(initialTab);
          setIsEditing(true);
        }}
        onEditThemes={() => { setEditMode('theme'); setIsEditing(true); }}
        onStartWorkout={(workout) => setActiveWorkout(workout)}
        onViewProgress={() => setShowProgress(true)}
        onViewAccount={() => setShowAccount(true)}
        onSaveProfile={(updated, mode) => handleSaveProfile(updated, mode)}
        onBackendSync={async () => {
          // Called by the trainer chat Apply flow after a plan is
          // written to AsyncStorage. Pushes the updated state blob so
          // the next device / next login sees the applied change.
          if (authToken) {
            await pushUserStateToBackend(authToken);
          }
        }}
        onProfileUpdate={async (changes, skipRegen) => {
          if (!userProfile || !authToken) return;
          const updated = { ...userProfile, ...changes };
          const stamped = changes.goal ? stampGoalStart(updated, userProfile) : updated;
          if (changes.goal) {
            await recordGoalChange(stamped.goal, stamped.goalDetails.pace, stamped.physicalStats.weightLbs);
          }
          await AsyncStorage.setItem('userProfile', JSON.stringify(stamped));
          setUserProfile(stamped);
          syncOnboarding(authToken, stamped).catch(() => null);
          // If the chat already included an updated plan, just refresh without regen
          if (skipRegen) {
            console.log('[onProfileUpdate] profile saved, skipping regen (plan already applied from chat)');
            setPlanRefreshKey(k => k + 1);
            return;
          }
          // Otherwise trigger plan regeneration
          const needsWorkout = !!changes.daysPerWeek || !!changes.workoutDurationMinutes || !!changes.equipment || !!changes.goal || !!changes.preferredSplit;
          const needsNutrition = !!changes.goal;
          if (needsWorkout || needsNutrition) {
            if (needsWorkout) setIsWorkoutUpdating(true);
            if (needsNutrition) setIsNutritionUpdating(true);
            holdPlanGenAwake();
            setPlanGenMarker(
              (needsWorkout && needsNutrition) ? 'full' : needsWorkout ? 'workout' : 'nutrition'
            ).catch(() => null);
            const recentSessions = (await loadWorkoutHistory()).filter(s => !s.skipped && s.completed).slice(0, 3);
            const sessionLines = recentSessions.length
              ? 'Last 3 completed workouts:\n' + recentSessions.map(s => `  [${s.date.slice(0, 10)}] ${s.focus}`).join('\n')
              : '';
            const userLogRaw = await AsyncStorage.getItem('userLog');
            const userLog: import('../src/types').UserLogEntry[] = safeParse<import('../src/types').UserLogEntry[]>(userLogRaw, []);
            const opts = { userLog, extraContext: sessionLines || undefined };
            const planCall = (needsWorkout && needsNutrition)
              ? getAIPlans(authToken, stamped, opts)
              : needsWorkout
                ? getAIWorkoutPlan(authToken, stamped, opts)
                : getAINutritionPlan(authToken, stamped, opts);
            planCall.then(async (aiPlans: any) => {
              await applyPlanResult(aiPlans);
              setPlanRefreshKey(k => k + 1);
            }).then(() => clearPlanGenMarker().catch(() => null))
            .catch((err: any) => {
              console.error('[onProfileUpdate] plan regen failed:', err?.message ?? err);
            }).finally(() => {
              setIsWorkoutUpdating(false);
              setIsNutritionUpdating(false);
              releasePlanGenAwake();
            });
          } else {
            setPlanRefreshKey(k => k + 1);
          }
        }}
        onWeeklyRefresh={async (review) => {
          if (!authToken || !userProfile) return;
          await appendUserLog({
            type: 'weekly_checkin',
            summary: `Week review: adherence ${review.adherence}/5, energy ${review.energy}/5${review.notes ? `, notes: ${review.notes}` : ''}`,
          });

          // Build workout history context for AI
          const recentSessions = (await loadWorkoutHistory())
            .filter(s => !s.skipped && s.completed)
            .slice(0, 5);
          const sessionLines = recentSessions.length
            ? 'Last 5 completed workouts:\n' +
              recentSessions.map(s => {
                const muscleGroups = (s.exercises ?? []).map(e => e.name).slice(0, 5).join(', ');
                return `  [${s.date.slice(0, 10)}] ${s.focus}${muscleGroups ? `: ${muscleGroups}` : ''}`;
              }).join('\n')
            : '';

          const userLogRaw = await AsyncStorage.getItem('userLog');
          const userLog: UserLogEntry[] = safeParse<UserLogEntry[]>(userLogRaw, []);

          // Clear pending profile changes since they're being sent to AI now
          await AsyncStorage.removeItem('pendingProfileChanges').catch(() => null);

          setIsWorkoutUpdating(true);
          setIsNutritionUpdating(true);
          holdPlanGenAwake();
          setPlanGenMarker('full').catch(() => null);

          getAIPlans(authToken, userProfile, {
            userLog,
            extraContext: sessionLines || undefined,
            weeklyReview: review,
          })
            .then(async (aiPlans) => {
              await applyPlanResult(aiPlans);
              await appendUserLog({ type: 'plan_generated', summary: `Weekly review plan refresh — adherence ${review.adherence}/5, energy ${review.energy}/5` });
              setPlanRefreshKey(k => k + 1);
            })
            .catch((err) => {
              const msg = err?.message ?? '';
              if (msg.toLowerCase().includes('cancelled')) return;
              if (msg.includes('orphaned_on_restart')) return;
              console.error('[weeklyRefresh] failed:', msg || err);
              Alert.alert('Plan refresh failed', 'Could not generate a new plan. Your current plan is unchanged.');
            })
            .then(() => clearPlanGenMarker().catch(() => null))
            .finally(() => {
              setIsWorkoutUpdating(false);
              setIsNutritionUpdating(false);
              releasePlanGenAwake();
            });
        }}
      />
      {showAccount && authToken && (
        <AccountInfoModal
          token={authToken}
          profile={userProfile}
          onClose={() => setShowAccount(false)}
          onSignOut={handleSignOut}
        />
      )}

      {/* Edit-profile overlay (goal, workout, meal plan, theme). Kept as a Modal
          so HomeScreen stays mounted behind it — preserves any in-flight plan
          generation state so nothing appears to "restart" on close. */}
      <Modal
        visible={isEditing}
        animationType="slide"
        onRequestClose={() => { setIsEditing(false); setEditMode('goal'); }}>
        {isEditing && authToken && userProfile && (
          <EditProfileScreen
            authToken={authToken}
            profile={userProfile}
            mode={editMode}
            initialMealTab={editInitialMealTab}
            onSave={handleSaveProfile}
            onCancel={() => { setIsEditing(false); setEditMode('goal'); setEditInitialMealTab(undefined); }}
            onRoutinesChanged={() => setPlanRefreshKey(k => k + 1)}
          />
        )}
      </Modal>

      {/* Supplements overlay */}
      <Modal
        visible={showSupplements}
        animationType="slide"
        onRequestClose={() => setShowSupplements(false)}>
        {showSupplements && userProfile && (
          <SupplementsScreen
            userProfile={userProfile}
            themeName={userProfile.themePreference}
            onSave={handleSaveSupplements}
            onBack={() => setShowSupplements(false)}
          />
        )}
      </Modal>

      {/* Progress overlay */}
      <Modal
        visible={showProgress}
        animationType="slide"
        onRequestClose={() => setShowProgress(false)}>
        {showProgress && authToken && userProfile && (
          <ProgressScreen
            authToken={authToken}
            userProfile={userProfile}
            themeName={userProfile.themePreference}
            onBack={() => setShowProgress(false)}
            onUpdateWeight={handleUpdateWeight}
          />
        )}
      </Modal>

      {/* Resume workout — themed modal */}
      {resumeWorkoutData && (() => {
        const tc = getTheme(userProfile?.themePreference).colors;
        return (
          <Modal visible transparent animationType="fade" onRequestClose={() => {}}>
            <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
              <View style={{ backgroundColor: tc.surface, borderRadius: 20, padding: 24, width: '100%', maxWidth: 340, borderWidth: 1, borderColor: tc.border }}>
                {(() => { try { const { Ionicons: Ic } = require('@expo/vector-icons'); return <Ic name="barbell-outline" size={36} color={tc.primary} style={{ alignSelf: 'center', marginBottom: 12 }} />; } catch { return null; } })()}
                <Text style={{ fontSize: 20, fontWeight: '800', color: tc.textPrimary, textAlign: 'center', marginBottom: 8 }}>
                  Resume Workout?
                </Text>
                <Text style={{ fontSize: 14, color: tc.textSecondary, textAlign: 'center', marginBottom: 20, lineHeight: 20 }}>
                  You have an unfinished {resumeWorkoutData.workout.focus || 'workout'} with{' '}
                  {resumeWorkoutData.loggedCount} exercise{resumeWorkoutData.loggedCount !== 1 ? 's' : ''} logged.
                </Text>
                <TouchableOpacity
                  style={{ backgroundColor: tc.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginBottom: 10 }}
                  onPress={() => {
                    setActiveWorkoutRaw(resumeWorkoutData.workout);
                    setResumeWorkoutData(null);
                  }}>
                  <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>Resume</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={{ borderRadius: 12, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: tc.border }}
                  onPress={() => {
                    AsyncStorage.removeItem('activeWorkoutSession').catch(() => {});
                    AsyncStorage.removeItem('activeWorkoutSets').catch(() => {});
                    AsyncStorage.removeItem('activeWorkoutStartTime').catch(() => {});
                    setResumeWorkoutData(null);
                  }}>
                  <Text style={{ color: tc.error ?? '#EF4444', fontSize: 15, fontWeight: '600' }}>Discard</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Modal>
        );
      })()}

      {/* Save confirmation — themed modal */}
      {pendingSave && (() => {
        const tc = getTheme(userProfile?.themePreference).colors;
        const isGoal = pendingSave.mode === 'goal';
        return (
          <Modal visible transparent animationType="fade" onRequestClose={() => setPendingSave(null)}>
            <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
              <View style={{ backgroundColor: tc.surface, borderRadius: 20, padding: 24, width: '100%', maxWidth: 340, borderWidth: 1, borderColor: tc.border }}>
                <Text style={{ fontSize: 18, fontWeight: '800', color: tc.textPrimary, textAlign: 'center', marginBottom: 8 }}>
                  {isGoal ? 'Update Your Plan?' : 'Regenerate Workout Plan?'}
                </Text>
                <Text style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center', marginBottom: 20, lineHeight: 18 }}>
                  {isGoal
                    ? 'Changing your goal will regenerate both your workout and nutrition plans to match. This may take 30-60 seconds.'
                    : 'Your workout plan will be regenerated with the new settings. Your nutrition plan won\'t change.'}
                </Text>
                <TouchableOpacity
                  style={{ backgroundColor: tc.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginBottom: 10 }}
                  onPress={() => {
                    const saved = pendingSave;
                    setPendingSave(null);
                    _doSaveProfile(saved.profile, saved.mode as any);
                  }}>
                  <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
                    {isGoal ? 'Update Plan' : 'Regenerate'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={{ borderRadius: 12, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: tc.border }}
                  onPress={() => setPendingSave(null)}>
                  <Text style={{ color: tc.textSecondary, fontSize: 15, fontWeight: '600' }}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Modal>
        );
      })()}
    </>
  );
}

// ── Splash Loading Screen ─────────────────────────────────────────────────────

function SplashLoadingScreen() {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const spinAnim = useRef(new Animated.Value(0)).current;
  const shimmerAnim = useRef(new Animated.Value(0)).current;
  const [tipIndex, setTipIndex] = useState(0);
  const tipFade = useRef(new Animated.Value(1)).current;

  const TIPS = [
    'Building your personalized plan...',
    'Calibrating workout intensity...',
    'Preparing your nutrition targets...',
  ];

  // Logo dimensions — kept in one place so the shimmer band stays in sync.
  const LOGO_W = 260;
  const LOGO_H = 100;
  const SHIMMER_W = 120;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }).start();

    // Continuous spinner rotation
    const spin = Animated.loop(
      Animated.timing(spinAnim, { toValue: 1, duration: 1200, useNativeDriver: true })
    );
    spin.start();

    // Shimmer sweep — 2.2s sweep + 0.8s pause. Uses easing so the band
    // glides in and out softly rather than snapping edge-to-edge.
    const shimmer = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmerAnim, {
          toValue: 1, duration: 2200, useNativeDriver: true,
          easing: Easing.inOut(Easing.cubic),
        }),
        Animated.delay(800),
      ])
    );
    shimmer.start();

    const tipTimer = setInterval(() => {
      Animated.timing(tipFade, { toValue: 0, duration: 250, useNativeDriver: true }).start(() => {
        setTipIndex(prev => (prev + 1) % TIPS.length);
        Animated.timing(tipFade, { toValue: 1, duration: 250, useNativeDriver: true }).start();
      });
    }, 2500);

    return () => { spin.stop(); shimmer.stop(); clearInterval(tipTimer); };
  }, []);

  const spinInterpolate = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const shimmerTranslate = shimmerAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [-SHIMMER_W, LOGO_W],
  });

  return (
    <View style={{
      flex: 1, backgroundColor: '#0D0F14',
      alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32,
    }}>
      {/* Logo with shimmer sweep */}
      <Animated.View style={{ opacity: fadeAnim, marginBottom: 12, width: LOGO_W, height: LOGO_H, overflow: 'hidden' }}>
        <Image
          source={require('../assets/images/thallo-logo-white.png')}
          style={{ width: LOGO_W, height: LOGO_H }}
          resizeMode="contain"
        />
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute', top: 0, left: 0, bottom: 0,
            width: SHIMMER_W,
            transform: [{ translateX: shimmerTranslate }, { skewX: '-20deg' }],
          }}>
          <LinearGradient
            colors={['rgba(21,199,184,0)', 'rgba(21,199,184,0.35)', 'rgba(21,199,184,0)']}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={{ flex: 1 }}
          />
        </Animated.View>
      </Animated.View>

      {/* Tagline — matches auth screen */}
      <Animated.Text style={{
        color: '#8A90A0', fontSize: 15, fontWeight: '500', textAlign: 'center',
        letterSpacing: 0.2, marginBottom: 48, opacity: fadeAnim,
      }}>
        Your AI personal trainer and nutritionist.
      </Animated.Text>

      {/* Spinner — clean rotating arc */}
      <Animated.View style={{
        width: 40, height: 40, borderRadius: 20,
        borderWidth: 3, borderColor: '#1E2430',
        borderTopColor: '#15C7B8',
        transform: [{ rotate: spinInterpolate }],
        marginBottom: 20,
      }} />

      {/* Rotating status text */}
      <Animated.Text style={{
        color: '#4A5568', fontSize: 13, fontWeight: '500',
        textAlign: 'center', opacity: tipFade,
      }}>
        {TIPS[tipIndex]}
      </Animated.Text>

    </View>
  );
}


// ── Account Info Modal ────────────────────────────────────────────────────────

function AccountInfoModal({
  token, profile, onClose, onSignOut,
}: {
  token: string;
  profile: UserProfile;
  onClose: () => void;
  onSignOut: () => void;
}) {
  const tc = getTheme(profile.themePreference).colors;
  const am = createAmStyles(tc);
  const [accountData, setAccountData] = useState<{ email: string; username: string } | null>(null);
  const [loading, setLoading]         = useState(true);
  const [healthEnabled, setHealthEnabled] = useState(false);
  const showHealthToggle = Platform.OS === 'ios';

  useEffect(() => {
    getMe(token)
      .then((data: any) => setAccountData({ email: data.email, username: data.username }))
      .catch(() => setAccountData(null))
      .finally(() => setLoading(false));
    isAppleHealthEnabled().then(setHealthEnabled);
  }, [token]);

  const Row = ({ label, value }: { label: string; value: string }) => (
    <View style={am.row}>
      <Text style={am.rowLabel}>{label}</Text>
      <Text style={am.rowValue}>{value}</Text>
    </View>
  );

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <TouchableOpacity style={am.backdrop} activeOpacity={1} onPress={onClose}>
        <View style={am.sheet}>
          <View style={am.handle} />
          <Text style={am.title}>Account</Text>

          {loading ? (
            <ActivityIndicator color={tc.primary} style={{ marginVertical: 24 }} />
          ) : (
            <View style={am.infoSection}>
              {accountData ? (
                <>
                  <Row label="Email"    value={accountData.email} />
                  <Row label="Username" value={accountData.username} />
                </>
              ) : (
                <Text style={am.errorText}>Could not load account info</Text>
              )}
              <Row label="Goal"   value={profile.goal.replace(/_/g, ' ')} />
              <Row label="Weight" value={`${profile.physicalStats.weightLbs} lbs`} />
              <Row label="Age"    value={String(profile.physicalStats.age)} />
            </View>
          )}

          {showHealthToggle && (
            <View style={am.healthToggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={am.healthToggleLabel}>Apple Health</Text>
                <Text style={am.healthToggleDesc}>Sync heart rate, steps, sleep, and workouts to enhance your fitness score and recovery tracking.</Text>
              </View>
              <Switch
                value={healthEnabled}
                onValueChange={async (val) => {
                  if (val) {
                    if (!isHealthKitAvailable()) {
                      // Native module not loaded — need a custom dev build
                      Alert.alert(
                        'Dev Build Required',
                        'Apple Health requires a custom Expo dev build. It is not available in Expo Go. Enable this setting once you have a dev build installed.',
                      );
                      // Still save the preference so it activates once they build
                      setHealthEnabled(true);
                      await setAppleHealthEnabled(true);
                      return;
                    }
                    const granted = await requestHealthPermissions();
                    if (!granted) {
                      Alert.alert('Permission Required', 'Please enable Health access in Settings > Privacy > Health > Thallo.');
                      return;
                    }
                  }
                  setHealthEnabled(val);
                  await setAppleHealthEnabled(val);
                }}
                trackColor={{ false: tc.border, true: tc.primary + '66' }}
                thumbColor={healthEnabled ? tc.primary : tc.textMuted}
              />
            </View>
          )}

          <TouchableOpacity
            style={am.signOutBtn}
            onPress={() => { onClose(); onSignOut(); }}>
            <Text style={am.signOutText}>Sign Out</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={onClose} style={am.closeBtn}>
            <Text style={am.closeText}>Close</Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

function createAmStyles(c: ReturnType<typeof getTheme>['colors']) { return StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: c.surface,
    borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    padding: 24, paddingBottom: 48,
    borderTopWidth: 1, borderTopColor: c.border,
    gap: 16,
  },
  handle:  { width: 36, height: 4, backgroundColor: c.border, borderRadius: 2, alignSelf: 'center' },
  title:   { fontSize: 20, fontWeight: '700', color: c.textPrimary },

  infoSection: {
    backgroundColor: c.surfaceRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: c.border, overflow: 'hidden',
  },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 13,
    borderBottomWidth: 1, borderBottomColor: c.border,
  },
  rowLabel: { fontSize: 14, color: c.textSecondary, fontWeight: '500' },
  rowValue: { fontSize: 14, color: c.textPrimary,   fontWeight: '600', textTransform: 'capitalize' },

  errorText: { fontSize: 13, color: c.error, padding: 16 },

  healthToggleRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: c.surfaceRaised, borderRadius: radius.md,
    padding: 16, borderWidth: 1, borderColor: c.border,
  },
  healthToggleLabel: { fontSize: 14, fontWeight: '700', color: c.textPrimary, marginBottom: 3 },
  healthToggleDesc: { fontSize: 11, color: c.textSecondary, lineHeight: 16 },

  signOutBtn: {
    backgroundColor: c.error + '22', borderRadius: radius.md,
    paddingVertical: 14, alignItems: 'center',
    borderWidth: 1, borderColor: c.error,
  },
  signOutText: { fontSize: 15, fontWeight: '700', color: c.error },

  closeBtn: { alignItems: 'center', paddingVertical: 8 },
  closeText: { fontSize: 15, color: c.textSecondary },
}); }
