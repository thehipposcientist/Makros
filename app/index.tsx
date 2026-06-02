import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { View, Text, Modal, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator, Image, Alert, Platform, Switch, AppState, AppStateStatus, Linking, TextInput, InteractionManager } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as KeepAwake from 'expo-keep-awake';
import {
  FREE_TIER_CAPABILITIES,
  FREE_TIER_SUMMARY,
  PRO_TIER_CAPABILITIES,
  PRO_TIER_SUMMARY,
  SIGNUP_TRIAL_DAYS,
  isBetaFullAccessEnabled,
  isTrialing,
  subscriptionStatusLabel,
  tierOf,
  trialDaysRemaining,
} from '../src/utils/subscription';
import { isFeatureEnabled } from '../src/utils/featureFlags';
import { clearAuthToken, loadAuthToken, saveAuthToken } from '../src/utils/authTokenStorage';
import { primeMealHistoryCache, resetMealHistoryCache } from '../src/services/mealHistoryWarmCache';
import { completeWorkoutWithOfflineQueue, flushPendingWorkoutCompletions, loadPendingWorkoutCompletions, PENDING_WORKOUT_COMPLETIONS_KEY } from '../src/utils/workoutCompletionQueue';
import { SUN_EXPOSURE_SYNC_INTERVAL_MS, syncSunExposureForToday } from '../src/services/sunExposureSync';
import { STORAGE_KEYS, USER_STATE_SYNC_KEYS, isDbCanonicalUserStateKey } from '../src/utils/storageKeys.ts';
import {
  cachedProfileOwnerId,
  normalizeAuthUserId,
  shouldResetUserScopedCacheForLogin,
  stampCachedProfileOwner,
} from '../src/utils/authCacheIsolation';

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
const PLAN_GEN_MARKER_KEY = STORAGE_KEYS.plan.pendingGeneration;
type PlanGenMarker = {
  kind: 'full' | 'workout' | 'nutrition' | 'nutrition_remaining';
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
  try { await AsyncStorage.removeItem(STORAGE_KEYS.plan.pendingJob); } catch {}
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
const RETURN_HOME_AFTER_AWAY_MS = 60 * 60 * 1000;

// Sentinel that lives in AsyncStorage. AsyncStorage is wiped on app delete,
// but iOS Keychain (used by SecureStore inside authTokenStorage) is NOT — so a stale JWT can
// auto-log the user in with an empty local profile after reinstall. This
// marker lets us detect a fresh install and purge the Keychain token.
const INSTALL_MARKER_KEY = STORAGE_KEYS.app.installMarker;
async function ensureFreshInstall(): Promise<void> {
  try {
    const marker = await AsyncStorage.getItem(INSTALL_MARKER_KEY);
    if (!marker) {
      await clearAuthToken();
      await AsyncStorage.setItem(INSTALL_MARKER_KEY, '1');
    }
  } catch {}
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
    msg.includes('session_expired') ||
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
  await clearUserScopedStorage();
}

/** Track the last signed-in user id so we can detect a user switch on the
 *  same device. On a switch we wipe the previous user's cached data so the
 *  new user doesn't inherit it; on the same user returning we leave cache
 *  alone so sign-out → sign-in is non-destructive. */
const LAST_USER_ID_KEY = STORAGE_KEYS.app.lastUserId;
const TUTORIAL_COMPLETED_KEY = STORAGE_KEYS.app.tutorialCompleted;
const LIVE_TUTORIAL_COMPLETED_KEY = STORAGE_KEYS.app.liveTutorialCompleted;
/** Local cache of the last legal version this device accepted. Set on
 *  any successful `acceptLegal` (or signup / OAuth login that bundled
 *  legal acceptance). Preserved across sign-out so a same-user
 *  re-sign-in does NOT re-prompt for terms when nothing has actually
 *  changed — even if the backend `/me` returns a stale version due to
 *  caching or a race. The legal-gate check uses this as a short-circuit
 *  before falling back to the backend versions. */
const LEGAL_LOCAL_ACCEPTED_KEY = STORAGE_KEYS.app.legalLocalAcceptedVersion;
/** Every AsyncStorage key that holds user-scoped state. When a different
 *  user signs in we remove all of these in one shot. This list also doubles
 *  as the base set considered for backend sync. Transient, device-only, and
 *  high-sensitivity caches are excluded via SYNCED_STATE_KEYS below. */
const USER_SCOPED_KEYS = [
  'userProfile', 'aiWorkoutPlan',
  'aiNutritionPlan', 'aiNutritionPlanA', 'aiNutritionPlanB', 'aiNutritionPlanC', 'aiNutritionPlans',
  'trainerNote', 'nutritionistNote', 'supplementStack', 'metaData_v1', 'metaData_v4',
  'weekStartDate', 'mealEdits', 'mealChecks',
  'workoutHistory', 'userLog', 'skippedWorkouts',
  'mealRoutines', 'workoutTemplates', 'workoutTemplateDeletedIds', 'planChangeHistory', 'goalHistory',
  'user_username',
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
  // appleHealthEnabled intentionally excluded — it's a device-level OS
  // permission preference, not user data. Wiping it on user-switch or
  // session reset forces unnecessary "reconnect" prompts even when the
  // iOS HealthKit permission is still granted.
  'pendingProfileChanges',
  'pending_plan_job',
  // AccountInfoModal /auth/me cache — must be wiped on user-switch so
  // the new account never briefly sees the prior user's email/username.
  'accountModal.meCache.v1',
  'weightHistory',
  'legacyWeightHistoryQuarantine_v1',
  'bodyScanHistory',
  'legacyBodyScanHistoryQuarantine_v1',
  'healthDataSummary_v2',
  'sleepHistory_v1',
  'activeWorkoutSets',
  'activeWorkoutRest',
  'activeWorkoutStartTime',
  'activeWorkoutTimers',
  'activeWorkoutPausedAtMs',
  'activeWorkoutPausedAccumMs',
  'activeWatchSessionId',
  'activeWorkoutSession',
  PENDING_WORKOUT_COMPLETIONS_KEY,
  'groceryChecked_v2',
  'groceryRemoved_v2',
  'mealCheckTimestamps',
  'periodSymptomLogs_v1',
  'periodSymptomLogsCache_v1',
  'periodSymptomLogsQuarantine_v1',
  'hydrationByDate_v1',
  'injury_checkins_v1',
  'plateauDismissedAt',
  'emailBannerDismissedAt',
  'birthdateBackfill_dismissed_v1',
  'hkImportDismissed_v1',
  'watch_sync_status_v1',
  'watch_active_command_backlog_v1',
  'onboardingDraft_v1',
  'manualWorkoutOverrides',
  TUTORIAL_COMPLETED_KEY,
  LIVE_TUTORIAL_COMPLETED_KEY,
  // Legal-acceptance cache is user-scoped so a user-switch on the same
  // device wipes it (the new user's acceptance state must come from
  // their own /auth/me, not inherited from the previous user). On a
  // same-user sign-out → sign-in it's preserved via handleSignOut's
  // preserveKeys list.
  'legal_locally_accepted_version',
  'meal_reminder_settings',
  'meal_reminder_notification_id',
  'meal_reminder_ids',
  'hydration_reminder_settings',
  'hydration_reminder_ids',
  'workout_reminder_settings',
  'workout_reminder_ids',
  'notification_quiet_hours',
  'weekly_checkin_notification_sent_ids',
  STORAGE_KEYS.reminders.sleepScoreSettings,
  STORAGE_KEYS.reminders.sleepScoreSentNights,
  STORAGE_KEYS.reminders.readinessSettings,
  STORAGE_KEYS.reminders.readinessSentDates,
  STORAGE_KEYS.reminders.coachingSettings,
  STORAGE_KEYS.reminders.coachingPlanIds,
  STORAGE_KEYS.reminders.postWorkoutMealId,
  STORAGE_KEYS.reminders.newPlanWeekSentIds,
  // Index for the SWR read-cache layer (see src/services/api.ts).
  // The actual cache entries match the current `read_cache_v2::` prefix
  // below; this is the registry that lets us enumerate them for wipe.
  STORAGE_KEYS.cache.legacyReadCacheIndex,
  STORAGE_KEYS.cache.readCacheIndex,
];

const USER_SCOPED_KEY_PREFIXES = [
  'mealPlan_',
  'preservedMeal_',
  'mealChecks_',
  'freshDayGenerated_',
  'workoutDayState_',
  'workoutStartTime_',
  'routineOverlayShown_',
  'unloggedMealsPromptShown_',
  'mealReviewPromptShown_',
  'birthday_dismissed_',
  'lastDigestDismissedWeek_',
  'weeklyReviewDismissed_v1_',
  'incompleteDayDismissed_',
  // Persistent SWR read-cache layer in src/services/api.ts. The cache
  // is keyed by `${hash(authToken)}::${path}` so multi-user scenarios stay
  // scoped, but on sign-out / user-switch we still wipe the whole
  // cache so the new user's first paint never sees the prior user's
  // responses. The companion index key is wiped explicitly below.
  STORAGE_KEYS.cache.legacyReadCachePrefix,
  STORAGE_KEYS.cache.readCachePrefix,
];

const USER_SCOPED_KEY_SET = new Set(USER_SCOPED_KEYS);

function isUserScopedStorageKey(key: string): boolean {
  if (USER_SCOPED_KEY_SET.has(key)) return true;
  return USER_SCOPED_KEY_PREFIXES.some(prefix => key.startsWith(prefix));
}

async function clearUserScopedStorage(options: { preserveKeys?: string[] } = {}): Promise<void> {
  const preserveKeys = new Set(options.preserveKeys ?? []);
  try {
    const keys = await AsyncStorage.getAllKeys();
    const scopedKeys = Array.from(new Set([
      ...USER_SCOPED_KEYS,
      ...keys.filter(isUserScopedStorageKey),
    ])).filter(key => !preserveKeys.has(key));
    await AsyncStorage.multiRemove(scopedKeys);
  } catch {
    try { await AsyncStorage.multiRemove(USER_SCOPED_KEYS.filter(key => !preserveKeys.has(key))); } catch {}
  }
  try { await clearAllPersistentReadCache(); } catch {}
}

async function hasUserScopedStorage(): Promise<boolean> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    return keys.some(key => isUserScopedStorageKey(key));
  } catch {
    return false;
  }
}

async function getCachedProfileOwnerId(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem('userProfile');
    return raw ? cachedProfileOwnerId(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

async function clearCacheIfAccountChanged(incomingUserId: unknown): Promise<boolean> {
  const normalizedIncomingUserId = normalizeAuthUserId(incomingUserId);
  if (!normalizedIncomingUserId) return false;

  const [previousUserId, profileOwnerId, hasScopedCache] = await Promise.all([
    AsyncStorage.getItem(LAST_USER_ID_KEY).catch(() => null),
    getCachedProfileOwnerId(),
    hasUserScopedStorage(),
  ]);
  const shouldReset = shouldResetUserScopedCacheForLogin({
    incomingUserId: normalizedIncomingUserId,
    previousUserId,
    cachedProfileOwnerId: profileOwnerId,
    hasUserScopedCache: hasScopedCache,
  });
  if (shouldReset) await clearUserScopedStorage();
  return shouldReset;
}

/** Keys that get pushed to the backend for cross-device sync. Subset of
 *  USER_SCOPED_KEYS that excludes device-only / transient state and local
 *  health caches. Health and hydration restore through server-authoritative
 *  endpoints instead of the opaque state blob. */
const SYNCED_STATE_KEYS = [
  ...USER_STATE_SYNC_KEYS,
];

const DB_SOURCE_OF_TRUTH_STATE = {
  _storage_policy: STORAGE_KEYS.userState.dbSourceOfTruthMarker,
};

function legacyCanonicalEntries(state: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    Object.entries(state).filter(([key]) => isDbCanonicalUserStateKey(key)),
  );
}

function workoutCompletionKey(dateISO?: string | null, focus?: string | null): string | null {
  const date = typeof dateISO === 'string' ? dateISO.slice(0, 10) : '';
  const focusKey = typeof focus === 'string' ? focus.trim().toLowerCase() : '';
  return date && focusKey ? `${date}|${focusKey}` : null;
}

/** Push only the storage-policy marker to the legacy `/profile/state` row.
 *  Real user data now syncs through typed backend tables/endpoints; this
 *  write clears older opaque blobs so they cannot rehydrate stale meals,
 *  workouts, routines, profiles, or goals on another device. */
async function pushUserStateToBackend(token: string): Promise<void> {
  try {
    await putUserState(token, DB_SOURCE_OF_TRUTH_STATE);
    console.log('[user-state] cleared legacy canonical blob');
  } catch (e: any) {
    console.warn('[user-state] push failed:', e?.message ?? e);
  }
}

async function quarantineLegacyCanonicalState(state: Record<string, any>): Promise<number> {
  const entries = legacyCanonicalEntries(state);
  const keys = Object.keys(entries);
  if (keys.length === 0) return 0;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.userState.legacyCanonicalQuarantine);
    const previous = raw ? safeJsonParse<Record<string, any>>(raw, {}) : {};
    await AsyncStorage.setItem(
      STORAGE_KEYS.userState.legacyCanonicalQuarantine,
      JSON.stringify({
        ...previous,
        remoteUserState: {
          quarantinedAt: new Date().toISOString(),
          reason: 'Legacy /profile/state canonical data is no longer hydrated as saved data.',
          entries,
        },
      }),
    );
  } catch {}
  return keys.length;
}

async function pushCustomExercisesToBackend(token: string, profile: UserProfile): Promise<UserProfile> {
  const local = profile.customExercises ?? [];
  if (local.length === 0) return profile;
  try {
    const synced = await syncCustomExercises(token, local);
    if (synced.length === 0) return profile;
    return {
      ...profile,
      customExercises: mergeCustomExercises(synced, local),
    };
  } catch (e: any) {
    console.warn('[custom-exercises] sync failed:', e?.message ?? e);
    return profile;
  }
}

async function hydrateTodayHydrationFromBackend(token: string): Promise<void> {
  try {
    const today = todayKey();
    const pendingLocal = await loadCachedHydration(today).catch(() => null);
    if (pendingLocal?.pending) {
      console.log(`[user-state] hydration restore skipped pending local row ${today}`);
      return;
    }
    const row = await getHydration(token, today);
    await saveCachedHydration(row);
    console.log(`[user-state] hydrated hydration ${row.date}: ${row.ounces}oz`);
  } catch (e: any) {
    console.warn('[user-state] hydration restore failed:', e?.message ?? e);
  }
}

/** Pull legacy `/profile/state` only to quarantine obsolete canonical data.
 *  The app then restores real rows from typed DB endpoints below. */
async function pullUserStateFromBackend(token: string): Promise<void> {
  let hadPendingWorkoutCompletions = false;
  try {
    const pending = await loadPendingWorkoutCompletions();
    hadPendingWorkoutCompletions = pending.length > 0;
    if (pending.length > 0) {
      const result = await flushPendingWorkoutCompletions(token);
      if (result.synced > 0) {
        console.log(`[workout-queue] flushed ${result.synced} pending completion${result.synced === 1 ? '' : 's'}`);
      }
    }
  } catch (e: any) {
    console.warn('[workout-queue] flush before state pull failed:', e?.message ?? e);
  }

  try {
    const { state } = await getUserState(token);
    if (!state || Object.keys(state).length === 0) {
      console.log('[user-state] pull: empty remote state');
    } else {
      const quarantined = await quarantineLegacyCanonicalState(state);
      if (quarantined > 0) {
        await putUserState(token, DB_SOURCE_OF_TRUTH_STATE).catch(() => undefined);
        console.log(`[user-state] quarantined ${quarantined} legacy canonical key${quarantined === 1 ? '' : 's'}; remote blob cleared`);
      } else {
        console.log('[user-state] pull: no legacy canonical keys to hydrate');
      }
    }
  } catch (e: any) {
    console.warn('[user-state] pull failed:', e?.message ?? e);
  }

  // Hydration has its own server-authoritative endpoint. Restore today's row
  // directly so sign-out cache wipes cannot hide water logged in UserDayState
  // when the opaque synced-state blob is stale, missing, or too large to save.
  await hydrateTodayHydrationFromBackend(token);

  // Workout templates: pull authoritative server rows + push any local-only
  // rows that haven't reached the server yet (one-time migration after the
  // table-backed rewrite). See workoutHistory.syncWorkoutTemplatesFromBackend.
  try {
    const { syncWorkoutTemplatesFromBackend } = await import('../src/utils/workoutHistory');
    await syncWorkoutTemplatesFromBackend(token);
  } catch (e: any) {
    console.warn('[user-state] workout-templates sync failed:', e?.message ?? e);
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
    const pending = await loadPendingWorkoutCompletions();
    for (const item of pending) {
      if (!item.session) continue;
      const pendingKey = workoutCompletionKey(item.session.date, item.session.focus);
      const alreadyLocal = pendingKey && realLocal.some(s => workoutCompletionKey(s?.date, s?.focus) === pendingKey);
      if (!alreadyLocal) realLocal.push(item.session);
    }
    const completionKeys = new Set(
      completions
        .map(c => workoutCompletionKey(c.workout_date, c.focus_label))
        .filter((k): k is string => !!k),
    );
    const pendingKeys = new Set(
      pending
        .map(item => workoutCompletionKey(item.request.workout_date, item.request.focus_label))
        .filter((k): k is string => !!k),
    );
    const activeKeys = new Set([...completionKeys, ...pendingKeys]);
    if (activeKeys.size === 0) {
      await AsyncStorage.multiRemove(['workoutHistory', 'workoutSummaries']);
      console.log('[user-state] backend has 0 completions; cleared local workout history/summaries');
      return;
    }
    try {
      const rawSummaries = await AsyncStorage.getItem('workoutSummaries');
      const summaries = rawSummaries ? JSON.parse(rawSummaries) : [];
      if (Array.isArray(summaries)) {
        const scoped = summaries.filter((s: any) => {
          const key = workoutCompletionKey(s?.date, s?.focus);
          return !!key && activeKeys.has(key);
        });
        if (scoped.length !== summaries.length) {
          await AsyncStorage.setItem('workoutSummaries', JSON.stringify(scoped));
        }
      }
    } catch {}
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
      // Merge: backend completions + matching real local sessions with
      // exercise detail. Backend completion rows are authoritative for
      // which days count as active.
      const merged = realLocal.filter((s) => {
        const key = workoutCompletionKey(s?.date, s?.focus);
        return !!key && activeKeys.has(key);
      });
      for (const sk of skeleton) {
        const skDate = sk.date.slice(0, 10);
        const dupe = merged.some(m => m.date?.slice(0, 10) === skDate && m.focus === sk.focus);
        if (!dupe) merged.push(sk);
      }
      // Sort newest-first by date
      merged.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
      await AsyncStorage.setItem('workoutHistory', JSON.stringify(merged));
      console.log(`[user-state] hydrated ${skeleton.length} from backend; ${realLocal.length} real local kept; pending=${pendingKeys.size}; total=${merged.length}`);
    }
  } catch (e: any) {
    console.warn('[user-state] completion hydration failed:', e?.message ?? e);
  }
}
import { UserProfile, WorkoutDay, WorkoutSession, UserLogEntry, SupplementItem } from '../src/types';
import { billingEntitlementToProfilePatch, getMyProfile, getMe, syncOnboarding, getAIPlans, getAIWorkoutPlan, getAINutritionPlan, getAIRemainingWeekNutritionPlan, repairPlanWeekEquipmentConflicts, repairPlanWeekInjuryConflicts, updatePlanWeekSessionDuration, upsertDayState, parseRecentWorkouts, resumePendingPlanJob, getPendingPlanMarker, cancelPendingPlanJob, getUserState, putUserState, listWorkoutCompletions, exportAccountData, deleteAccount, requestEmailVerification, recordTelemetryEvent, updateName, updateUsername, getHydration, setUnauthorizedHandler, syncCustomExercises, syncRevenueCatEntitlement, cancelSignupTrial, clearAllPersistentReadCache } from '../src/services/api';
import { clearAllSavedNutritionPlans, clearAllPreservedMeals, clearAllMealChecksExceptToday, clearSavedNutritionPlansForDates, clearPreservedMealsForDates, clearMealChecksForDates } from '../src/utils/mealTracker';
import { clearAllPlanCache, clearWorkoutCache, clearMealCache } from '../src/utils/planCacheReset';
import { loadCachedHydration, saveCachedHydration } from '../src/utils/hydrationCache';
import { encodePulledStateValueForStorage, mergePulledUserProfileWithCurrentStats, preserveLocalPreferredSplitWhenRemoteMissing } from '../src/utils/profileCache';
import { mergeCustomExercises } from '../src/utils/customExercises';
import AuthScreen from '../src/screens/AuthScreen';
import { useRouter } from 'expo-router';
import AboutPage from './about';
import LandingScreen from '../src/screens/LandingScreen';
import WhyThalloScreen from '../src/screens/WhyThalloScreen';
import OnboardingScreen from '../src/screens/OnboardingScreen';
import HomeScreen from '../src/screens/HomeScreen';
import EditProfileScreen from '../src/screens/EditProfileScreen';
import ActiveWorkoutScreen from '../src/screens/ActiveWorkoutScreen';
import { START_COUNTDOWN_TOTAL_MS } from '../src/components/StartCountdownOverlay';
import SettingsScreen from '../src/screens/SettingsScreen';

function serverTierOf(profile: UserProfile | null | undefined): 'free' | 'pro' {
  return profile?.subscriptionTier === 'pro' ? 'pro' : 'free';
}
function withDefaultTheme(profile: UserProfile): UserProfile {
  return profile.themePreference ? profile : { ...profile, themePreference: DEFAULT_THEME_NAME };
}
import ProgressScreen from '../src/screens/ProgressScreen';
import SupplementsScreen from '../src/screens/SupplementsScreen';
import RecoveryQuestionModal from '../src/components/RecoveryQuestionModal';
import TutorialOverlay from '../src/components/TutorialOverlay';
import DummyPaymentModal from '../src/components/DummyPaymentModal';
import LiveTutorialOverlay from '../src/components/LiveTutorialOverlay';
import LegalDisclosureModal from '../src/components/LegalDisclosureModal';
import { SplashLoadingScreen } from '../src/components/SplashLoadingScreen';
import BottomSheetDismissHandle from '../src/components/BottomSheetDismissHandle';
import { DEFAULT_THEME_NAME, colors, getContrastingTextColor, getTheme, radius } from '../src/constants/theme';
import { LEGAL_VERSION, SUPPORT_EMAIL } from '../src/constants/legal';
import { recordGoalChange, loadWorkoutHistory, saveWorkoutSession, savePlanChange, todayKey } from '../src/utils/workoutHistory';
import { nextPlanWeekStart, formatPlanStartDateShort } from '../src/utils/planEffectiveDate';
import {
  dateKey as planDateKey,
  planScopeIsUnchanged,
  planScopeSnapshot,
  summarizeScopeDiff,
} from '../src/utils/pendingPlanChange';
import { workoutSessionToLoggedPayload } from '../src/utils/workoutLogPayload';
import type { HomeTabKey } from '../src/utils/hiddenSurfaces';

const START_WORKOUT_POST_COUNTDOWN_DELAY_MS = START_COUNTDOWN_TOTAL_MS + 350;
import { APPLE_HEALTH_PERMISSION_COPY, getLastHealthKitError, isHealthKitAvailable, requestHealthPermissions } from '../src/services/appleHealth';
import { HEALTH_PLATFORM_LABEL, HEALTH_PLATFORM_PRO_COPY, HEALTH_PLATFORM_STATUS_COPY } from '../src/constants/platformHealth';
import { effectiveAge } from '../src/utils/age';
import { getActiveWatchSessionId, setActiveWatchSessionId } from '../src/utils/activeWatchSession';

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

function planChangeProfileSnapshot(
  profile: UserProfile,
  scope: 'goal' | 'workout' | 'mealplan',
): Partial<UserProfile> {
  if (scope === 'goal') {
    return {
      goal: profile.goal,
      goalSelection: profile.goalSelection,
      goalDetails: profile.goalDetails,
      secondaryGoal: profile.secondaryGoal,
      focusedMuscleGroup: profile.focusedMuscleGroup,
    };
  }
  if (scope === 'workout') {
    return {
      priorityRegion: profile.priorityRegion,
      daysPerWeek: profile.daysPerWeek,
      trainingDays: profile.trainingDays,
      workoutDurationMinutes: profile.workoutDurationMinutes,
      equipment: profile.equipment,
      equipmentSettings: profile.equipmentSettings,
      strengthBaselines: profile.strengthBaselines,
      cardioBaseline: profile.cardioBaseline,
      injuries: profile.injuries,
      injuryEntries: profile.injuryEntries,
      experienceLevel: profile.experienceLevel,
      preferredSplit: profile.preferredSplit,
      dislikedExercises: profile.dislikedExercises,
    };
  }
  return {
    foodsAvailable: profile.foodsAvailable,
    customFoods: profile.customFoods,
    cookingSkill: profile.cookingSkill,
    prepTimeMinutes: profile.prepTimeMinutes,
    dietaryPreference: profile.dietaryPreference,
    mealVariety: profile.mealVariety,
    savedMeals: profile.savedMeals,
    mealRoutine: profile.mealRoutine,
    customMacros: profile.customMacros,
    glp1Support: profile.glp1Support,
    allergies: profile.allergies,
  };
}

function normalizedInjuryToken(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function activeInjurySignature(profile: UserProfile | null | undefined): string {
  const tokens: string[] = [];
  const legacy = normalizedInjuryToken(profile?.injuries);
  if (legacy) tokens.push(`legacy:${legacy}`);

  for (const entry of profile?.injuryEntries ?? []) {
    const status = normalizedInjuryToken(entry.status || 'active');
    if (status === 'resolved') continue;
    const muscles = [...(entry.muscleGroups ?? [])].map(normalizedInjuryToken).filter(Boolean).sort().join(',');
    const token = [
      normalizedInjuryToken(entry.bodyPart),
      normalizedInjuryToken(entry.description),
      status || 'active',
      normalizedInjuryToken(entry.severity),
      muscles,
    ].filter(Boolean).join(':');
    if (token) tokens.push(`entry:${token}`);
  }

  return JSON.stringify([...new Set(tokens)].sort());
}

function activeInjuriesChanged(
  before: UserProfile | null | undefined,
  after: UserProfile | null | undefined,
): boolean {
  return activeInjurySignature(before) !== activeInjurySignature(after);
}

function normalizedEquipmentItems(profile: UserProfile | null | undefined): string[] {
  return (profile?.equipment ?? [])
    .map(item => String(item ?? '').trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

function equipmentWasRemoved(
  before: UserProfile | null | undefined,
  after: UserProfile | null | undefined,
): boolean {
  const beforeItems = new Set(normalizedEquipmentItems(before));
  const afterItems = new Set(normalizedEquipmentItems(after));
  for (const item of beforeItems) {
    if (!afterItems.has(item)) return true;
  }
  return false;
}

function equipmentWasAdded(
  before: UserProfile | null | undefined,
  after: UserProfile | null | undefined,
): boolean {
  const beforeItems = new Set(normalizedEquipmentItems(before));
  const afterItems = new Set(normalizedEquipmentItems(after));
  for (const item of afterItems) {
    if (!beforeItems.has(item)) return true;
  }
  return false;
}

function workoutDurationChanged(
  before: UserProfile | null | undefined,
  after: UserProfile | null | undefined,
): boolean {
  const beforeMinutes = Number(before?.workoutDurationMinutes ?? 60);
  const afterMinutes = Number(after?.workoutDurationMinutes ?? 60);
  return Number.isFinite(beforeMinutes)
    && Number.isFinite(afterMinutes)
    && beforeMinutes !== afterMinutes;
}

function workoutSettingsUnchangedExcept(
  before: UserProfile | null | undefined,
  after: UserProfile | null | undefined,
  coveredKeys: string[],
): boolean {
  if (!before || !after) return false;
  const beforeSnap = { ...planScopeSnapshot(before, 'workout') } as Record<string, unknown>;
  const afterSnap = { ...planScopeSnapshot(after, 'workout') } as Record<string, unknown>;
  for (const key of coveredKeys) {
    delete beforeSnap[key];
    delete afterSnap[key];
  }
  return JSON.stringify(beforeSnap) === JSON.stringify(afterSnap);
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

function countPersistedWorkoutSets(rawSets: string | null | undefined): number {
  if (!rawSets) return 0;
  try {
    const parsed = JSON.parse(rawSets);
    if (!Array.isArray(parsed)) return 0;
    return parsed.reduce((total: number, entry: any) => {
      const sets = Array.isArray(entry?.sets) ? entry.sets.length : 0;
      const warmupSets = Array.isArray(entry?.warmupSets) ? entry.warmupSets.length : 0;
      return total + sets + warmupSets;
    }, 0);
  } catch {
    return 0;
  }
}

function hasPersistedWorkoutTimers(rawTimers: string | null | undefined): boolean {
  if (!rawTimers) return false;
  try {
    const parsed = JSON.parse(rawTimers);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return Object.values(parsed).some((timer: any) => timer?.running === true || Number(timer?.baseElapsed) > 0);
  } catch {
    return false;
  }
}

async function hasRecentWorkoutActivity(): Promise<boolean> {
  try {
    const pairs = await AsyncStorage.multiGet([
      'activeWorkoutStartTime',
      'activeWorkoutSession',
      'activeWorkoutSets',
      'activeWorkoutTimers',
      'activeWatchSessionId',
    ]);
    const values = Object.fromEntries(pairs);
    const startedAt = Number.parseInt(values.activeWorkoutStartTime ?? '', 10);
    if (!Number.isFinite(startedAt) || startedAt <= 0) return false;
    const ageMs = Date.now() - startedAt;
    if (ageMs > 24 * 60 * 60 * 1000) return false;
    if (
      !!values.activeWorkoutSession?.trim()
      || countPersistedWorkoutSets(values.activeWorkoutSets) > 0
      || hasPersistedWorkoutTimers(values.activeWorkoutTimers)
    ) {
      return true;
    }
    return !!values.activeWatchSessionId?.trim() && ageMs <= 4 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

type WebProgressShellProps = {
  authToken: string;
  userProfile: UserProfile;
  onSignOut: () => void | Promise<void>;
  onUpdateWeight: (weightLbs: number) => void | Promise<void>;
  onCancelScheduledPlanChange: (restoredProfile: UserProfile) => void | Promise<void>;
};

function labelizeToken(value: string | null | undefined): string {
  const cleaned = String(value ?? '').trim();
  if (!cleaned) return 'Progress';
  return cleaned
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

function WebProgressShell({
  authToken,
  userProfile,
  onSignOut,
  onUpdateWeight,
  onCancelScheduledPlanChange,
}: WebProgressShellProps) {
  const themeName = userProfile.themePreference;
  const tc = getTheme(themeName).colors;
  const styles = useMemo(() => createWebProgressStyles(tc), [themeName]);
  const displayName = [userProfile.firstName, userProfile.lastName].filter(Boolean).join(' ').trim() || 'Thallo';
  const goalLabel = labelizeToken(userProfile.goalSelection?.primaryGoal ?? userProfile.goal);
  const tierLabel = tierOf(userProfile) === 'pro' ? 'Pro' : 'Free';
  const statusLabel = subscriptionStatusLabel(userProfile);

  return (
    <View style={styles.root}>
      <View style={styles.topbar}>
        <View style={styles.brandCluster}>
          <View style={styles.brandMark}>
            <Text style={styles.brandMarkText}>T</Text>
          </View>
          <View style={styles.brandTextBlock}>
            <Text style={styles.brandTitle}>Thallo</Text>
            <Text style={styles.brandSubtitle} numberOfLines={1}>{displayName}</Text>
          </View>
        </View>
        <View style={styles.accountCluster}>
          <View style={styles.accountPill}>
            <Text style={styles.accountPillLabel} numberOfLines={1}>{goalLabel}</Text>
          </View>
          <View style={styles.accountPill}>
            <Text style={styles.accountPillLabel}>{tierLabel}</Text>
            <Text style={styles.accountPillMeta} numberOfLines={1}>{statusLabel}</Text>
          </View>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Sign out"
            activeOpacity={0.82}
            onPress={() => { void onSignOut(); }}
            style={styles.signOutButton}>
            <Ionicons name="log-out-outline" size={16} color={tc.textPrimary} />
            <Text style={styles.signOutText}>Sign out</Text>
          </TouchableOpacity>
        </View>
      </View>
      <View style={styles.progressHost}>
        <ProgressScreen
          authToken={authToken}
          userProfile={userProfile}
          themeName={themeName}
          noHeader
          webMode
          onBack={() => undefined}
          onUpdateWeight={onUpdateWeight}
          onCancelScheduledPlanChange={onCancelScheduledPlanChange}
        />
      </View>
    </View>
  );
}

function createWebProgressStyles(c: ReturnType<typeof getTheme>['colors']) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: c.background,
    },
    topbar: {
      width: '100%',
      maxWidth: 980,
      alignSelf: 'center',
      minHeight: 62,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      backgroundColor: c.background,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 18,
    },
    brandCluster: {
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    brandMark: {
      width: 34,
      height: 34,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.primary,
    },
    brandMarkText: {
      color: getContrastingTextColor(c.primary),
      fontSize: 16,
      fontWeight: '900',
    },
    brandTextBlock: {
      minWidth: 0,
    },
    brandTitle: {
      color: c.textPrimary,
      fontSize: 16,
      fontWeight: '900',
      letterSpacing: 0,
    },
    brandSubtitle: {
      color: c.textMuted,
      fontSize: 11,
      fontWeight: '700',
      marginTop: 2,
    },
    accountCluster: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: 10,
      flexWrap: 'wrap',
    },
    accountPill: {
      minHeight: 32,
      maxWidth: 180,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      justifyContent: 'center',
    },
    accountPillLabel: {
      color: c.textPrimary,
      fontSize: 11,
      fontWeight: '900',
      letterSpacing: 0,
    },
    accountPillMeta: {
      color: c.textMuted,
      fontSize: 10,
      fontWeight: '700',
      marginTop: 1,
    },
    signOutButton: {
      minHeight: 32,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      paddingHorizontal: 13,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surfaceRaised,
    },
    signOutText: {
      color: c.textPrimary,
      fontSize: 12,
      fontWeight: '900',
      letterSpacing: 0,
    },
    progressHost: {
      flex: 1,
      minHeight: 0,
      width: '100%',
    },
  });
}

export function NativeIndex() {
  const router = useRouter();
  const [isLoading, setIsLoading]         = useState(true);
  const [authToken, setAuthToken]         = useState<string | null>(null);
  const [authEntryMode, setAuthEntryMode] = useState<'landing' | 'why-thallo' | 'login' | 'signup'>(Platform.OS === 'web' ? 'login' : 'landing');
  const authTokenRef = useRef<string | null>(null);
  const authRestoreRetryNeededRef = useRef(false);
  const authRestoreInFlightRef = useRef(false);
  const [userProfile, setUserProfile]     = useState<UserProfile | null>(null);
  const [isEditing, setIsEditing]         = useState(false);
  const [editMode, setEditMode]           = useState<'goal' | 'workout' | 'mealplan' | 'theme' | 'body'>('goal');
  const [pendingSave, setPendingSave]     = useState<{
    profile: UserProfile;
    mode: string;
    repairInjuryConflicts?: boolean;
    repairEquipmentConflicts?: boolean;
    updateSessionDuration?: boolean;
  } | null>(null);
  // Optional sub-tab to pre-select when opening the EditProfileScreen in
  // 'mealplan' mode. Lets HomeScreen jump straight into Foods/Supplements/Macros.
  const [editInitialMealTab, setEditInitialMealTab] = useState<'foods' | 'supplements' | 'macros' | undefined>(undefined);
  const [planRefreshKey, setPlanRefreshKey] = useState(0);
  const [isWorkoutUpdating, setIsWorkoutUpdating] = useState(false);
  const [isNutritionUpdating, setIsNutritionUpdating] = useState(false);
  // Active PlanWeek's end_date — pushed up from HomeScreen so the
  // pending-save modal can show the user the correct "applies on" date
  // (last day of their current plan-week + 1, on their actual sign-up
  // cadence). Null when no PlanWeek exists yet (free users, brand-new
  // signups). The modal falls back to a 7-day default in that case.
  const [activePlanWeekEnd, setActivePlanWeekEnd] = useState<string | null>(null);
  const [showProgress, setShowProgress]   = useState(false);
  const [showAccount, setShowAccount]     = useState(false);
  const [showSettings, setShowSettings]   = useState(false);
  const [settingsOpenImportOnShow, setSettingsOpenImportOnShow] = useState(false);
  const [showSupplements, setShowSupplements] = useState(false);
  const [usernameRefreshKey, setUsernameRefreshKey] = useState(0);
  // Re-acceptance gate: when the server-side legal versions a user has
  // accepted differ from the current LEGAL_VERSION constant, this flips
  // true and a blocking LegalDisclosureModal renders. Cleared after the
  // user taps "I Agree" and POST /auth/accept-legal succeeds.
  const [legalReAcceptNeeded, setLegalReAcceptNeeded] = useState(false);
  // Post-onboarding tutorial — owned at the app root so the
  // AccountInfoModal "Show tutorial again" button can flip it on
  // directly. Earlier this lived on HomeScreen and replay required
  // navigating back to a "home tab" that doesn't really exist as
  // its own destination, so the replay flow felt broken.
  const [showTutorial, setShowTutorial] = useState(false);
  const [showLiveTutorial, setShowLiveTutorial] = useState(false);
  const [liveTutorialNavigation, setLiveTutorialNavigation] = useState<{ tab: HomeTabKey; requestId: number } | null>(null);
  const [homeResetKey, setHomeResetKey] = useState(0);
  const awayStartedAtRef = useRef<number | null>(null);

  useEffect(() => {
    authTokenRef.current = authToken;
  }, [authToken]);

  const resetOrdinaryAppNavigation = useCallback(() => {
    setIsEditing(false);
    setPendingSave(null);
    setEditInitialMealTab(undefined);
    setShowProgress(false);
    setShowAccount(false);
    setShowSettings(false);
    setSettingsOpenImportOnShow(false);
    setShowSupplements(false);
    setShowTutorial(false);
    setShowLiveTutorial(false);
    setLiveTutorialNavigation(null);
    setHomeResetKey(k => k + 1);
    AsyncStorage.setItem('lastActiveTab', 'today').catch(() => {});
  }, []);

  useEffect(() => {
    const errorUtils = (globalThis as any).ErrorUtils;
    const previousHandler = errorUtils?.getGlobalHandler?.();
    if (errorUtils?.setGlobalHandler) {
      errorUtils.setGlobalHandler((error: any, isFatal?: boolean) => {
        recordTelemetryEvent('app_js_error', {
          message: String(error?.message ?? error),
          stack: String(error?.stack ?? '').slice(0, 4000),
          is_fatal: !!isFatal,
        }, authTokenRef.current ?? undefined);
        if (previousHandler) previousHandler(error, isFatal);
      });
    }
    return () => {
      if (errorUtils?.setGlobalHandler && previousHandler) {
        errorUtils.setGlobalHandler(previousHandler);
      }
    };
  }, []);

  // First-mount auto-show: open the tutorial once after onboarding
  // completes (or whenever the user lands here without the
  // `tutorial_v1_completed` flag). Marked completed on Skip OR Done
  // — once seen, never re-prompted unless the user taps "Show
  // tutorial again" in Account.
  useEffect(() => {
    if (!userProfile) return;
    let cancelled = false;
    (async () => {
      try {
        const seen = await AsyncStorage.getItem(TUTORIAL_COMPLETED_KEY);
        if (cancelled || seen) return;
        // Brief delay so the home view paints first.
        setTimeout(() => { if (!cancelled) setShowTutorial(true); }, 600);
      } catch { /* AsyncStorage flake — user can replay from Account */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!userProfile]);

  const liveTutorialTabs = useMemo<HomeTabKey[]>(() => {
    const tabs: HomeTabKey[] = ['friends'];
    if (userProfile?.hiddenSurfaces?.workouts !== true) tabs.push('workout');
    tabs.push('today');
    if (userProfile?.hiddenSurfaces?.meals !== true) tabs.push('meals');
    tabs.push('progress');
    return tabs;
  }, [userProfile?.hiddenSurfaces?.meals, userProfile?.hiddenSurfaces?.workouts]);

  const startLiveTutorial = useCallback(() => {
    setShowTutorial(false);
    setShowAccount(false);
    setShowSettings(false);
    setShowProgress(false);
    setTimeout(() => setShowLiveTutorial(true), 180);
  }, []);

  const handleTutorialHealthSetup = useCallback(async () => {
    if (!userProfile) return;
    const tier = tierOf(userProfile);
    if (tier === 'free') {
      Alert.alert(
        `${HEALTH_PLATFORM_LABEL} is Pro`,
        `${HEALTH_PLATFORM_PRO_COPY}\n\nFree still supports manual workouts, meal logging, weight updates, and progress history.`,
      );
      return;
    }
    if (Platform.OS === 'android') {
      Alert.alert(HEALTH_PLATFORM_LABEL, HEALTH_PLATFORM_STATUS_COPY);
      return;
    }
    if (!isHealthKitAvailable()) {
      Alert.alert(
        `${HEALTH_PLATFORM_LABEL} unavailable`,
        'Apple Health is iPhone-only and requires HealthKit support. Manual logs and in-app workout tracking still work normally.',
      );
      return;
    }
    Alert.alert(
      APPLE_HEALTH_PERMISSION_COPY.title,
      APPLE_HEALTH_PERMISSION_COPY.body,
      [
        { text: 'Not now', style: 'cancel' },
        {
          text: 'Continue',
          onPress: async () => {
            try {
              const granted = await requestHealthPermissions();
              if (granted) {
                const age = effectiveAge({
                  birthdate: userProfile.physicalStats?.birthdate ?? null,
                  age: userProfile.physicalStats?.age ?? null,
                });
                import('../src/services/healthDataSummary')
                  .then(({ backfillSnapshotsToBackend, refreshHealthDataSummary }) => {
                    refreshHealthDataSummary({ age }).catch(() => null);
                    backfillSnapshotsToBackend(180).catch(() => null);
                  })
                  .catch(() => null);
                Alert.alert('Apple Health connected', 'Thallo will use shared health summaries for readiness, recovery, progress, and weekly check-ins when Apple Health has samples for those categories.');
              } else {
                const err = getLastHealthKitError();
                Alert.alert('Apple Health not connected', `${APPLE_HEALTH_PERMISSION_COPY.denied}\n\n${err ?? ''}`.trim());
              }
            } catch (e: any) {
              Alert.alert('Apple Health error', String(e?.message ?? e));
            }
          },
        },
      ],
    );
  }, [userProfile]);

  const handleLiveTutorialNavigate = useCallback((tab: HomeTabKey) => {
    setShowAccount(false);
    setShowSettings(false);
    setShowProgress(false);
    setLiveTutorialNavigation({ tab, requestId: Date.now() });
  }, []);

  const [activeWorkout, setActiveWorkoutRaw] = useState<WorkoutDay | null>(null);
  const [playStartCountdown, setPlayStartCountdown] = useState(false);
  const startWorkoutInitialUrlHandledRef = useRef(false);
  const activeWorkoutPersistTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeWorkoutRef = useRef<WorkoutDay | null>(null);
  const startWorkoutSequenceRef = useRef(0);
  useEffect(() => {
    activeWorkoutRef.current = activeWorkout;
  }, [activeWorkout]);
  const setActiveWorkout = useCallback((w: WorkoutDay | null, options?: { persistDelayMs?: number }) => {
    if (activeWorkoutPersistTimeoutRef.current) {
      clearTimeout(activeWorkoutPersistTimeoutRef.current);
      activeWorkoutPersistTimeoutRef.current = null;
    }
    setActiveWorkoutRaw(w);
    if (w) {
      const persist = () => {
        activeWorkoutPersistTimeoutRef.current = null;
        AsyncStorage.setItem('activeWorkoutSession', JSON.stringify(w)).catch(() => {});
      };
      const delayMs = Math.max(0, options?.persistDelayMs ?? 0);
      if (delayMs > 0) {
        activeWorkoutPersistTimeoutRef.current = setTimeout(persist, delayMs);
      } else {
        persist();
      }
    } else {
      AsyncStorage.removeItem('activeWorkoutSession').catch(() => {});
    }
  }, []);
  // Stable handler for HomeScreen's onStartWorkout prop. Inline arrow
  // here would mint a new function reference on every render of this
  // root, which thrashed HomeScreen's watch-command useEffect (deps
  // include onStartWorkout) — leaking listeners and opening race
  // windows where a watch tap could land between cleanup and the new
  // async listener registration.
  const handleStartWorkout = useCallback((workout: WorkoutDay, options?: { playCountdown?: boolean }) => {
    const shouldPlayCountdown = options?.playCountdown !== false;
    const sequence = startWorkoutSequenceRef.current + 1;
    startWorkoutSequenceRef.current = sequence;
    setPlayStartCountdown(shouldPlayCountdown);
    const watchSyncDelayMs = shouldPlayCountdown ? START_WORKOUT_POST_COUNTDOWN_DELAY_MS : 0;
    const existingSessionId = getActiveWatchSessionId();
    const existingWatchStartedSession = !shouldPlayCountdown && existingSessionId?.startsWith('watch-') === true;
    const startedAtMs = Date.now();
    const sessionId = shouldPlayCountdown || !existingSessionId
      ? `${startedAtMs}-${Math.random().toString(36).slice(2, 8)}`
      : existingSessionId;
    if (shouldPlayCountdown || !existingSessionId) {
      setActiveWatchSessionId(sessionId);
      AsyncStorage.setItem('activeWatchSessionId', sessionId).catch(() => {});
      AsyncStorage.setItem('activeWorkoutStartTime', String(startedAtMs)).catch(() => {});
    }
    if (!existingWatchStartedSession) {
      const startWatchAfterCountdown = () => {
        if (startWorkoutSequenceRef.current !== sequence) return;
        import('../src/utils/watchSync')
          .then(async ({ pushWorkoutToWatch, WatchBridge }) => {
            if (startWorkoutSequenceRef.current !== sequence) return;
            await pushWorkoutToWatch(workout, {
              dateISO: todayKey(),
              status: 'active',
              sessionId,
              reason: 'active_snapshot',
            }).catch(() => false);
            await WatchBridge.startWatchWorkout().catch(() => false);
          })
          .catch(() => {});
      };
      // Keep the 3-2-1 window free of workout JSON serialization and
      // WatchConnectivity bridge calls; ActiveWorkoutScreen also waits
      // for the overlay before starting its richer active snapshot sync.
      setTimeout(() => {
        InteractionManager.runAfterInteractions(startWatchAfterCountdown);
      }, watchSyncDelayMs);
    }
    setActiveWorkout(workout, {
      persistDelayMs: shouldPlayCountdown ? START_WORKOUT_POST_COUNTDOWN_DELAY_MS : 0,
    });
  }, [setActiveWorkout]);
  const handleCancelActiveWorkout = useCallback(() => {
    startWorkoutSequenceRef.current += 1;
    setPlayStartCountdown(false);
    setActiveWorkout(null);
  }, [setActiveWorkout]);
  const handleStartWorkoutDeepLink = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem('aiWorkoutPlan');
      const plan = raw ? JSON.parse(raw) : null;
      const today = plan?.days?.[0] as WorkoutDay | undefined;
      if (today) {
        handleStartWorkout(today);
      } else {
        Alert.alert('Workout not ready', 'Open the Workout tab once so Thallo can load today’s plan.');
      }
    } catch {
      Alert.alert('Workout not ready', 'Could not load today’s workout from the shortcut.');
    }
  }, [handleStartWorkout]);

  useEffect(() => {
    if (!authToken || !userProfile) return;
    let consumedInitial = false;
    const maybeHandleUrl = (url: string | null | undefined) => {
      if (!url) return;
      if (url.includes('start-workout')) {
        handleStartWorkoutDeepLink().catch(() => {});
      }
    };
    Linking.getInitialURL()
      .then(url => {
        if (consumedInitial || startWorkoutInitialUrlHandledRef.current) return;
        consumedInitial = true;
        startWorkoutInitialUrlHandledRef.current = true;
        maybeHandleUrl(url);
      })
      .catch(() => {});
    const sub = Linking.addEventListener('url', ({ url }) => maybeHandleUrl(url));
    return () => {
      consumedInitial = true;
      sub.remove();
    };
  }, [authToken, userProfile, handleStartWorkoutDeepLink]);
  const [trainerNote, setTrainerNote]     = useState<string | null>(null);
  const [nutritionistNote, setNutritionistNote] = useState<string | null>(null);
  const [supplementStack, setSupplementStack] = useState<SupplementItem[]>([]);
  const [needsRecoveryQuestion, setNeedsRecoveryQuestion] = useState(false);
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

  // Global 401 handler. Any authenticated API call that returns 401
  // (token expired / revoked / token_version bumped) routes here once
  // per session. We can't call the normal sign-out — its server-side
  // /auth/logout call would just 401 again, and wiping user-scoped
  // storage is overkill when the user is going to sign right back into
  // the same account. Just drop the local token and let React re-render
  // onto AuthScreen.
  useEffect(() => {
    setUnauthorizedHandler(async (path: string) => {
      console.log(`[auth] 401 on ${path} — dropping local session`);
      try { await clearAuthToken(); } catch {}
      setAuthEntryMode('login');
      setAuthToken(null);
      Alert.alert(
        'Session expired',
        'Please sign in again to continue.',
      );
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  // Meal-history warm prime. The moment `authToken` is restored from
  // storage (or set on fresh sign-in), kick the /meals/history GET so
  // the response races HomeScreen's mount. HomeScreen's auth-restore
  // effect then `consumeMealHistoryCache` instead of firing its own
  // GET, eliminating the "loading shimmer → swap to data" flash. On
  // sign-out / 401 we drop the cache so a different user can never
  // read the prior session's rows.
  useEffect(() => {
    if (!authToken) {
      resetMealHistoryCache();
      return;
    }
    // Lazy import so this module's runtime cost is paid once, only when
    // we actually have a token to prime under.
    import('../src/services/api').then(api => {
      primeMealHistoryCache(authToken, api.getMealHistory).catch(() => {});
    }).catch(() => {});
  }, [authToken]);

  // AppState listener:
  //   - 'active' → check for an orphaned plan job and resume polling
  //   - 'background' / 'inactive' → push local state to the backend as a
  //     safety net so users who never explicitly sign out still get their
  //     latest state synced
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        const awayStartedAt = awayStartedAtRef.current;
        awayStartedAtRef.current = null;
        if (authToken && awayStartedAt && Date.now() - awayStartedAt >= RETURN_HOME_AFTER_AWAY_MS) {
          hasRecentWorkoutActivity()
            .then((hasWorkoutActivity) => {
              if (activeWorkoutRef.current || hasWorkoutActivity) return;
              resetOrdinaryAppNavigation();
            })
            .catch(() => {});
        }
        if (!authToken && authRestoreRetryNeededRef.current && !authRestoreInFlightRef.current) {
          authRestoreInFlightRef.current = true;
          loadAuthToken()
            .then(async (token) => {
              if (!token) return;
              const meData = await getMe(token);
              const restoredUserId = (meData as any)?.id ?? (meData as any)?.user_id ?? null;
              await clearCacheIfAccountChanged(restoredUserId);
              if ((meData as any)?.username) {
                await AsyncStorage.setItem('user_username', (meData as any).username);
              }
              if (restoredUserId != null) await AsyncStorage.setItem(LAST_USER_ID_KEY, String(restoredUserId));
              await loadProfile(token, restoredUserId);
              pullUserStateFromBackend(token).catch(() => null);
              authRestoreRetryNeededRef.current = false;
              setAuthToken(token);
              resetOrdinaryAppNavigation();
            })
            .catch((e) => {
              if (isAuthFailureError(e)) {
                authRestoreRetryNeededRef.current = false;
              }
              console.warn('[auth] foreground token restore retry failed:', e?.message ?? e);
            })
            .finally(() => {
              authRestoreInFlightRef.current = false;
            });
        }
        resumePlanGenRef.current?.().catch(() => null);
        if (authToken) {
          flushPendingWorkoutCompletions(authToken)
            .then((result) => {
              if (result.synced > 0) {
                setPlanRefreshKey(k => k + 1);
                pushUserStateToBackend(authToken).catch(() => null);
              }
            })
            .catch(() => null);
        }
      } else if (nextState === 'background' || nextState === 'inactive') {
        if (awayStartedAtRef.current == null) {
          awayStartedAtRef.current = Date.now();
        }
        if (authToken) pushUserStateToBackend(authToken).catch(() => null);
      }
    });
    return () => sub.remove();
  }, [authToken, resetOrdinaryAppNavigation]);

  useEffect(() => {
    if (!authToken || !userProfile || tierOf(userProfile) !== 'pro') return undefined;
    let cancelled = false;
    let inFlight = false;
    const syncSunExposure = () => {
      if (cancelled || inFlight || AppState.currentState !== 'active') return;
      inFlight = true;
      syncSunExposureForToday(authToken)
        .catch(() => null)
        .finally(() => { inFlight = false; });
    };
    syncSunExposure();
    const interval = setInterval(syncSunExposure, SUN_EXPOSURE_SYNC_INTERVAL_MS);
    const sub = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (nextState === 'active') syncSunExposure();
    });
    return () => {
      cancelled = true;
      clearInterval(interval);
      sub.remove();
    };
  }, [
    authToken,
    userProfile?.subscriptionTier,
    userProfile?.subscriptionStatus,
    userProfile?.subscriptionExpiresAt,
    userProfile?.trialEndsAt,
  ]);

  const initApp = async () => {
    if (Platform.OS === 'web') {
      try {
        const persistedToken = await loadAuthToken().catch((e: any) => {
          console.warn('[auth] web token read failed:', e?.message ?? e);
          return null;
        });
        if (persistedToken) {
          try {
            const meData = await getMe(persistedToken);
            const persistedUserId = (meData as any)?.id ?? (meData as any)?.user_id ?? null;
            await clearCacheIfAccountChanged(persistedUserId);
            if ((meData as any)?.username) {
              await AsyncStorage.setItem('user_username', (meData as any).username);
            }
            if (persistedUserId != null) {
              await AsyncStorage.setItem(LAST_USER_ID_KEY, String(persistedUserId));
            }
            try {
              const { needsLegalReAcceptance, LEGAL_VERSION: currentLegalVersion } = await import('../src/constants/legal');
              const locallyAccepted = await AsyncStorage.getItem(LEGAL_LOCAL_ACCEPTED_KEY).catch(() => null);
              if (locallyAccepted !== currentLegalVersion) {
                if (needsLegalReAcceptance(meData as any)) {
                  setLegalReAcceptNeeded(true);
                } else {
                  AsyncStorage.setItem(LEGAL_LOCAL_ACCEPTED_KEY, currentLegalVersion).catch(() => {});
                }
              }
            } catch {}
            await loadProfile(persistedToken, persistedUserId);
            pullUserStateFromBackend(persistedToken).catch(() => null);
            setAuthToken(persistedToken);
          } catch (err: any) {
            if (isAuthFailureError(err)) {
              await hardResetSession();
            } else {
              try {
                await loadProfile(persistedToken);
                setAuthToken(persistedToken);
              } catch {}
            }
          }
        }
      } finally {
        setIsLoading(false);
      }
      return;
    }

    const CACHE_VERSION = '5';
    let restoredActiveWorkout: WorkoutDay | null = null;
    let restoredActiveWorkoutApplied = false;
    const applyRestoredActiveWorkout = () => {
      if (!restoredActiveWorkout || restoredActiveWorkoutApplied) return;
      restoredActiveWorkoutApplied = true;
      setPlayStartCountdown(false);
      setActiveWorkout(restoredActiveWorkout);
    };
    const storedVersion = await AsyncStorage.getItem('cacheVersion');
    if (storedVersion !== CACHE_VERSION) {
      await AsyncStorage.multiRemove([
        'userProfile', 'aiWorkoutPlan',
        'aiNutritionPlan', 'aiNutritionPlanA', 'aiNutritionPlanB', 'aiNutritionPlanC',
        'trainerNote', 'nutritionistNote', 'supplementStack',
        'workoutHistory', 'skippedWorkouts',
        'mealChecks', 'mealEdits', 'userLog',
        'weekStartDate', 'metaData_v1', 'metaData_v4',
      ]);
      await AsyncStorage.setItem('cacheVersion', CACHE_VERSION);
    }
    await AsyncStorage.multiRemove(['trainerNote', 'nutritionistNote']);
    setTrainerNote(null);
    setNutritionistNote(null);
    const ss = await AsyncStorage.getItem('supplementStack');
    if (ss) { try { setSupplementStack(JSON.parse(ss)); } catch {} }

    // Restore active workout if user was mid-session when the app was killed.
    // If sets were already logged, the logger should reopen directly from
    // local state; network/profile/watch sync can catch up behind it.
    try {
      const savedWorkout = await AsyncStorage.getItem('activeWorkoutSession');
      if (savedWorkout) {
        const parsed = JSON.parse(savedWorkout);
        if (parsed && parsed.exercises) {
          const savedSets = await AsyncStorage.getItem('activeWorkoutSets');
          const loggedCount = savedSets
            ? (JSON.parse(savedSets) as any[]).filter(e => e.sets?.length > 0 || e.warmupSets?.length > 0).length
            : 0;
          // Only auto-resume if the user actually logged at least one set.
          // Without this, starting a workout then force-killing the app
          // before logging anything would reopen a stale empty session.
          if (loggedCount > 0) {
            restoredActiveWorkout = parsed as WorkoutDay;
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

    // On a fresh install (AsyncStorage empty but Keychain still has a
    // token from a prior install), clear the Keychain token so the user
    // lands on the login screen instead of a ghost-profile auto-login.
    await ensureFreshInstall();

    // Restore persisted auth token. If we have one, validate against the
    // backend so an expired/revoked token sends the user to the login screen
    // instead of silently hanging. Network errors are tolerated — we keep the
    // token optimistically and let individual requests surface errors.
    //
    // IMPORTANT: normal boot still waits for profile before `setAuthToken`.
    // The active-workout fast path below sets token + cached profile together
    // before dropping the loading screen, so it avoids the same onboarding flash
    // while letting set logging reopen ahead of remote sync.
    let persistedToken: string | null = null;
    let tokenReadFailed = false;
    try {
      persistedToken = await loadAuthToken();
      authRestoreRetryNeededRef.current = false;
    } catch (e: any) {
      tokenReadFailed = true;
      authRestoreRetryNeededRef.current = true;
      console.warn('[auth] secure token read failed; preserving local/watch state and retrying on foreground:', e?.message ?? e);
    }
    if (persistedToken && restoredActiveWorkout) {
      try {
        const cachedProfileRaw = await AsyncStorage.getItem('userProfile');
        const cachedProfile = cachedProfileRaw ? JSON.parse(cachedProfileRaw) as UserProfile : null;
        const cachedOwnerId = cachedProfileOwnerId(cachedProfile);
        const storedUserId = await AsyncStorage.getItem(LAST_USER_ID_KEY).catch(() => null);
        const cachedProfileMatchesStoredUser = cachedOwnerId
          ? storedUserId != null && cachedOwnerId === storedUserId
          : storedUserId != null;
        if (cachedProfile && cachedProfileMatchesStoredUser) {
          applyRestoredActiveWorkout();
          setUserProfile(cachedProfile);
          setAuthToken(persistedToken);
          setIsLoading(false);
        }
      } catch { /* fall through to normal boot if the cached profile is corrupt */ }
    }
    if (persistedToken) {
      try {
        const meData = await getMe(persistedToken);
        const persistedUserId = (meData as any)?.id ?? (meData as any)?.user_id ?? null;
        await clearCacheIfAccountChanged(persistedUserId);
        if ((meData as any)?.username) {
          await AsyncStorage.setItem('user_username', (meData as any).username);
        }
        if (persistedUserId != null) {
          await AsyncStorage.setItem(LAST_USER_ID_KEY, String(persistedUserId));
        }
        // Legal re-acceptance gate. `getMe` returns the per-section
        // accepted versions; compare to the current LEGAL_VERSION and
        // raise the modal if any section's accepted version is stale.
        // Runs once at session restore — the post-fresh-login path
        // (handleAuthenticated below) does the same check.
        try {
          const { needsLegalReAcceptance, LEGAL_VERSION: currentLegalVersion } = await import('../src/constants/legal');
          // Short-circuit: if the local cache says this device already
          // accepted the current legal version, suppress the prompt
          // regardless of what `/auth/me` returned. Prevents re-prompts
          // when the backend version field lags or the user just
          // re-signed-in after accepting on this same device.
          const locallyAccepted = await AsyncStorage.getItem(LEGAL_LOCAL_ACCEPTED_KEY).catch(() => null);
          if (locallyAccepted !== currentLegalVersion) {
            if (needsLegalReAcceptance(meData as any)) {
              setLegalReAcceptNeeded(true);
            } else {
              // Backend says we're current — backfill the local cache so
              // subsequent gates short-circuit on every existing-user
              // device, not just devices that accepted post-fix.
              AsyncStorage.setItem(LEGAL_LOCAL_ACCEPTED_KEY, currentLegalVersion).catch(() => {});
            }
          }
        } catch { /* legal module optional in dev */ }
        await loadProfile(persistedToken, persistedUserId);
        // Cold-start hydration: if local history / synced state are empty
        // (e.g. user wiped app data), restore from backend. pullUserState
        // handles the blob + has an explicit workoutHistory fallback.
        pullUserStateFromBackend(persistedToken).catch(() => null);
        applyRestoredActiveWorkout();
        setAuthToken(persistedToken);
        // Stamp userId on watch bridge so applicationContext carries it.
        try {
          const storedUid = await AsyncStorage.getItem(LAST_USER_ID_KEY);
          if (storedUid) {
            const { WatchBridge } = await import('../modules/thallo-watch-bridge');
            WatchBridge.setUserId(storedUid);
          }
        } catch { /* bridge optional */ }
      } catch (err: any) {
        if (isAuthFailureError(err)) {
          // 401 doesn't always mean the user is gone — it can also mean
          // the backend rotated SECRET_KEY between deploys (every JWT
          // signed against the old key now fails signature check). If
          // we have a usable cached profile on disk, keep the user
          // signed in optimistically and let the next successful
          // foreground call re-establish things. Only hard-reset when
          // the cache is empty too — at that point we genuinely have
          // nothing to render and the auth screen is the right
          // destination.
          const cached = await AsyncStorage.getItem('userProfile').catch(() => null);
          if (cached) {
            console.log('[initApp] 401 from /me but cached profile present — keeping session, will retry on next foreground:', err?.message);
            try { await loadProfile(persistedToken); } catch {}
            applyRestoredActiveWorkout();
            setAuthToken(persistedToken);
          } else {
            console.log('[initApp] stale token + no cached profile, hard-resetting session:', err?.message);
            await hardResetSession();
          }
        } else {
          // Transient failure (no network, backend down): keep the token so
          // the next successful request re-establishes the session. We
          // still try to hydrate the profile from cache.
          try { await loadProfile(persistedToken); } catch {}
          applyRestoredActiveWorkout();
          setAuthToken(persistedToken);
        }
      }
    } else if (tokenReadFailed) {
      // A locked iPhone can temporarily deny reads for older Keychain
      // entries. Treat that as "auth unknown", not "signed out": clearing
      // WCSession here strands the watch while the real token may still be
      // present and readable after the next unlock/foreground transition.
      console.log('[auth] secure token unavailable at startup; leaving watch payloads intact');
    } else {
      // No auth token at cold start. The watch's WCSession applicationContext
      // persists across phone re-launches, so a previous user's workout/meals/
      // supplements may still be sitting on the wrist. Push empty payloads
      // and clear the bridge userId so the watch wipes its cache and the
      // next sign-in starts from a clean slate.
      try {
        const { clearWatchData } = await import('../src/utils/watchSync');
        const { WatchBridge } = await import('../modules/thallo-watch-bridge');
        await clearWatchData();
        WatchBridge.setUserId(null);
      } catch { /* bridge optional */ }
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
   *  writes the same keys in the same order.
   *
   *  The new plan result gets a FULL cache wipe first (`clearAllPlanCache`)
   *  so no stale per-day state, fresh-day markers, nutritionist notes, or
   *  legacy A/B/C nutrition keys leak from the previous plan. Safelist
   *  lives in `planCacheReset.ts` — auth/profile/history/theme survive. */
  const applyPlanResult = async (aiPlans: any): Promise<void> => {
    // Scope the wipe to what was actually regenerated:
    //   workout_plan only → clear workout cache
    //   nutrition_plans only → clear meal cache
    //   BOTH (goal change / full regen) → clear both
    // This preserves the un-changed side instead of nuking it.
    const hasWorkout = !!aiPlans?.workout_plan;
    const hasNutrition = Array.isArray(aiPlans?.nutrition_plans)
      ? aiPlans.nutrition_plans.length > 0
      : !!(aiPlans?.nutrition_plan_a || aiPlans?.nutrition_plan);
    try {
      if (hasWorkout && hasNutrition) await clearAllPlanCache();
      else if (hasWorkout) await clearWorkoutCache();
      else if (hasNutrition) await clearMealCache();
    } catch {}
    await AsyncStorage.multiRemove(['trainerNote', 'nutritionistNote']);
    setTrainerNote(null);
    setNutritionistNote(null);
    if (aiPlans?.workout_plan) {
      await AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(aiPlans.workout_plan));
      // A fresh plan replaces today's cached slot too. PlanWeek remains
      // the source of truth; AsyncStorage is only the hot/offline cache.
      try {
        const t = new Date();
        const todayKey = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
        await AsyncStorage.removeItem(`freshDayGenerated_${todayKey}`);
      } catch {}
    }
    // Canonical nutrition shape: `nutrition_plans` as a dynamic-length array.
    // Fall back to the legacy A/B/C keys if the server still uses the old
    // shape (either because it's an old server build or a cached payload
    // being re-applied after backgrounding).
    const plansList: any[] = Array.isArray(aiPlans?.nutrition_plans)
      ? aiPlans.nutrition_plans
      : [aiPlans?.nutrition_plan_a, aiPlans?.nutrition_plan_b, aiPlans?.nutrition_plan_c].filter(Boolean);
    if (plansList.length > 0) {
      // Wipe per-day nutrition saves, preserved check-off snapshots, and
      // future-date meal checks. Without wiping preserved + checks, old
      // plan remnants bleed onto the fresh plan: checked-off meals from
      // last week's plan overlay onto the new week at the same date, AND
      // check-state keyed by `meal_<idx>` marks the NEW meals at the same
      // array position as already-eaten. Today's checks are preserved
      // (user already ate those meals today — regen shouldn't un-check).
      await clearAllSavedNutritionPlans();
      await clearAllPreservedMeals();
      try {
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        await clearAllMealChecksExceptToday(todayStr);
      } catch {}
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
    if (aiPlans?.supplementStack?.length) {
      await AsyncStorage.setItem('supplementStack', JSON.stringify(aiPlans.supplementStack));
      setSupplementStack(aiPlans.supplementStack);
    }
    if (aiPlans?.custom_foods?.length) await _mergeCustomFoods(aiPlans.custom_foods);
    setPlanRefreshKey(k => k + 1);
  };

  const applyRemainingWeekNutritionResult = async (aiPlans: any): Promise<void> => {
    const plansList: any[] = Array.isArray(aiPlans?.nutrition_plans)
      ? aiPlans.nutrition_plans
      : [aiPlans?.nutrition_plan_a, aiPlans?.nutrition_plan_b, aiPlans?.nutrition_plan_c].filter(Boolean);
    const updatedDates: string[] = Array.isArray(aiPlans?.remaining_week_nutrition?.updated_dates)
      ? aiPlans.remaining_week_nutrition.updated_dates
      : [];

    if (plansList.length > 0) {
      for (const p of plansList) {
        if (p && typeof p === 'object') delete (p as any)._templatesVersion;
      }
      await clearSavedNutritionPlansForDates(updatedDates);
      await clearPreservedMealsForDates(updatedDates);
      await clearMealChecksForDates(updatedDates);
      await AsyncStorage.setItem('aiNutritionPlans', JSON.stringify(plansList));
      await AsyncStorage.setItem('aiNutritionPlanA', JSON.stringify(plansList[0]));
      await AsyncStorage.setItem('aiNutritionPlan', JSON.stringify(plansList[0]));
      if (plansList[1]) await AsyncStorage.setItem('aiNutritionPlanB', JSON.stringify(plansList[1]));
      else await AsyncStorage.removeItem('aiNutritionPlanB');
      if (plansList[2]) await AsyncStorage.setItem('aiNutritionPlanC', JSON.stringify(plansList[2]));
      else await AsyncStorage.removeItem('aiNutritionPlanC');
    }
    await AsyncStorage.removeItem('nutritionistNote');
    setNutritionistNote(null);
    if (aiPlans?.supplementStack?.length) {
      await AsyncStorage.setItem('supplementStack', JSON.stringify(aiPlans.supplementStack));
      setSupplementStack(aiPlans.supplementStack);
    }
    if (aiPlans?.custom_foods?.length) await _mergeCustomFoods(aiPlans.custom_foods);
    setPlanRefreshKey(k => k + 1);
  };

  const profileWithWeightHistory = async (
    profile: UserProfile,
    weightLbs: number,
    source: 'manual' | 'onboarding' | 'coach' | 'checkin' | 'watch' = 'manual',
  ): Promise<UserProfile> => {
    const canonicalWeight = Math.round(Number(weightLbs) * 10) / 10;
    const { saveWeightEntry } = await import('../src/utils/weightHistory');
    const history = await saveWeightEntry(canonicalWeight, source);
    const weightEntries = history.map(entry => ({
      date: entry.date,
      weight_lbs: entry.weightLbs,
      source: entry.source,
      logged_at: entry.loggedAt,
    }));
    return {
      ...profile,
      physicalStats: {
        ...profile.physicalStats,
        weightLbs: canonicalWeight,
      },
      weightHistory: history,
      weightEntries,
    };
  };

  const pushWeightSnapshotToWatch = async (profile: UserProfile, force = false): Promise<void> => {
    try {
      const entries = profile.weightEntries ?? [];
      const latest = entries[entries.length - 1];
      const latestLbs = Number(latest?.weight_lbs ?? profile.physicalStats.weightLbs);
      if (!Number.isFinite(latestLbs) || latestLbs <= 0) return;
      const recent = entries.slice(-7);
      const ema = recent.length > 0
        ? recent.reduce((sum, entry) => sum + Number(entry.weight_lbs || 0), 0) / recent.length
        : latestLbs;
      const older = entries.slice(-14, -7);
      const oldEma = older.length > 0
        ? older.reduce((sum, entry) => sum + Number(entry.weight_lbs || 0), 0) / older.length
        : null;
      const { pushWeightToWatch } = await import('../src/utils/watchSync');
      await pushWeightToWatch({
        latestLbs,
        daysSinceLastLog: 0,
        emaLbs: ema,
        slopeLbsPerWeek: oldEma != null ? ema - oldEma : null,
        force,
      });
    } catch {}
  };

  const syncWeightToBackend = async (
    profile: UserProfile,
    weightLbs: number,
    source: 'manual' | 'onboarding' | 'coach' | 'checkin' | 'watch' = 'manual',
  ): Promise<void> => {
    if (!authToken) return;
    await syncOnboarding(authToken, profile).catch((e) =>
      console.warn('[weight] profile sync failed (non-fatal)', e?.message ?? e),
    );
    await pushUserStateToBackend(authToken).catch(() => null);
  };

  const refreshRemainingNutritionForWeight = async (
    profile: UserProfile,
    weightLbs: number,
  ): Promise<void> => {
    if (!authToken || serverTierOf(profile) === 'free') {
      setPlanRefreshKey(k => k + 1);
      return;
    }

    setIsNutritionUpdating(true);
    holdPlanGenAwake();
    await setPlanGenMarker('nutrition_remaining').catch(() => null);
    try {
      const raw = await AsyncStorage.getItem('userLog');
      const userLog = safeParse<UserLogEntry[]>(raw, []);
      const aiPlans = await getAIRemainingWeekNutritionPlan(authToken, profile, {
        userLog,
        extraContext: `User updated current body weight to ${Math.round(weightLbs * 10) / 10} lb. Recalculate nutrition targets from the new weight while preserving current-week workout structure.`,
      });
      await applyRemainingWeekNutritionResult(aiPlans);
      await appendUserLog({
        type: 'plan_generated',
        summary: `Remaining meal targets refreshed for ${Math.round(weightLbs * 10) / 10} lb body weight`,
      });
    } catch (err: any) {
      const msg = err?.message ?? '';
      if (!msg.toLowerCase().includes('cancelled') && !msg.includes('orphaned_on_restart')) {
        console.error('[weight nutrition refresh] failed:', msg || err);
        Alert.alert(
          'Weight saved',
          msg || 'Your weight was updated, but meal targets could not refresh right now.',
        );
      }
    } finally {
      setIsNutritionUpdating(false);
      clearPlanGenMarker().catch(() => null);
      releasePlanGenAwake();
    }
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
      if (localMarker?.kind === 'full' && age > 5 * 60 * 1000) {
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
      if (marker.kind === 'nutrition' || marker.kind === 'nutrition_remaining' || marker.kind === 'full') setIsNutritionUpdating(true);
    }
    holdPlanGenAwake();
    try {
      const aiPlans = await resumePendingPlanJob(authToken);
      if (aiPlans) {
        await applyPlanResult(aiPlans);
        await clearPlanGenMarker();
        console.log('[plan-gen] resumed job completed');
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

  const loadProfile = async (token: string, ownerUserId?: string | number | null): Promise<UserProfile | null> => {
    let profile: UserProfile | null = null;
    const normalizedOwnerUserId = normalizeAuthUserId(ownerUserId);
    const stored = await AsyncStorage.getItem('userProfile');
    if (stored) {
      // Guard the parse — corrupted AsyncStorage blobs (rare but possible
      // after a force-kill mid-write) must not brick every future sign-in.
      // Fall through to the remote fetch and re-populate from there.
      try {
        const parsed = JSON.parse(stored);
        const parsedOwnerId = cachedProfileOwnerId(parsed);
        if (normalizedOwnerUserId && parsedOwnerId && parsedOwnerId !== normalizedOwnerUserId) {
          profile = null;
          await AsyncStorage.removeItem('userProfile').catch(() => {});
        } else {
          profile = parsed;
        }
      }
      catch { profile = null; await AsyncStorage.removeItem('userProfile').catch(() => {}); }
    }
    const remote = await getMyProfile(token);
    if (remote) {
      const localProfile = profile;
      profile = profile ? {
        ...profile,
        ...remote,
        subscriptionTier: remote.subscriptionTier,
        customFoods: remote.customFoods?.length ? remote.customFoods : (profile.customFoods ?? []),
        customExercises: mergeCustomExercises(remote.customExercises, profile.customExercises),
        savedMeals: remote.savedMeals?.length ? remote.savedMeals : (profile.savedMeals ?? []),
      } : remote;
      if (localProfile) {
        profile = mergePulledUserProfileWithCurrentStats(profile, localProfile) as UserProfile;
      }
      profile = preserveLocalPreferredSplitWhenRemoteMissing(profile, localProfile) as UserProfile;
      await AsyncStorage.setItem('userProfile', JSON.stringify(profile));
    }
    if (!profile) return null;
    profile = withDefaultTheme(profile);
    if (normalizedOwnerUserId) {
      profile = stampCachedProfileOwner(profile, normalizedOwnerUserId);
    }
    profile = await pushCustomExercisesToBackend(token, profile);
    await AsyncStorage.setItem('userProfile', JSON.stringify(profile));
    setUserProfile(profile);
    if (tierOf(profile) === 'free') {
      try {
        const { setAppleHealthEnabled: disableAppleHealth } = await import('../src/utils/workoutHistory');
        await disableAppleHealth(false);
      } catch {}
    }

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
    if (remote && hasRequiredFields) {
      syncOnboarding(token, profile).catch((e) =>
        console.warn('[loadProfile] backend sync failed (non-fatal)', e?.message ?? e),
      );
    } else if (!remote) {
      console.warn('[loadProfile] using local cached profile; skipping backend sync so cache cannot overwrite DB profile facts');
    } else {
      console.warn('[loadProfile] local profile missing required fields, skipping sync', {
        weightLbs: ps?.weightLbs, heightFeet: ps?.heightFeet, heightInches: ps?.heightInches,
        age: ps?.age, gender: ps?.gender,
      });
    }
    // Rehydrate in-memory caches that sign-out cleared — these live in
    // AsyncStorage persistently, but the React state got reset when the
    // user signed out, so supplements need re-setting.
    try {
      await AsyncStorage.multiRemove(['trainerNote', 'nutritionistNote']);
      setTrainerNote(null);
      setNutritionistNote(null);
      const ss = await AsyncStorage.getItem('supplementStack');
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
    return profile;
  };

  const handleAuthenticated = async (token: string, isNewUser: boolean) => {
    // For returning users, persist the token immediately so switching apps
    // doesn't force re-login. For NEW signups, we hold off persisting until
    // onboarding completes — if the user quits halfway through, the in-memory
    // token dies with the process and they start over on next launch.
    if (!isNewUser) {
      await saveAuthToken(token);
    }

    // Detect a user switch on the same device. If the prior cache is
    // definitely owned by another user, or it predates owner stamping and
    // has no last-user id, wipe it before hydration so meals/plans/routines
    // cannot bleed across accounts.
    let incomingUserId: string | number | null = null;
    let incomingUsername: string | null = null;
    let meForLegalCheck: any = null;
    try {
      const me = await getMe(token);
      meForLegalCheck = me;
      incomingUserId = (me as any)?.id ?? (me as any)?.user_id ?? null;
      incomingUsername = (me as any)?.username ?? null;
    } catch {
      incomingUserId = null;
    }
    const shouldResetUserCache = !isNewUser && await clearCacheIfAccountChanged(incomingUserId);
    // For NEW users we hold off writing user-scoped storage until
    // onboarding completes — keeps signup ACID. For existing users
    // username/last-user are written after any previous-user wipe below.
    // Stamp userId on the watch bridge so applicationContext carries it.
    try {
      const { WatchBridge } = await import('../modules/thallo-watch-bridge');
      WatchBridge.setUserId(incomingUserId != null ? String(incomingUserId) : null);
    } catch { /* bridge optional */ }

    // IMPORTANT: we hydrate profile state BEFORE setting authToken. If we
    // set authToken first, React renders one frame where authToken is
    // present but userProfile is still null — the `if (!userProfile)
    // return <OnboardingScreen>` branch fires and we flash the onboarding
    // screen for a split second before loadProfile lands.
    if (isNewUser) {
      // Brand new account — wipe any leftover state, then fall into the
      // onboarding flow (userProfile stays null).
      await clearUserScopedStorage();
      // Signup / OAuth-creation paths bundle legal acceptance into the
      // auth request, so stamp the local cache too. Otherwise the very
      // next sign-out → sign-in would surface the re-acceptance modal
      // unnecessarily.
      try { await AsyncStorage.setItem(LEGAL_LOCAL_ACCEPTED_KEY, LEGAL_VERSION); } catch {}
      setUserProfile(null);
      setTrainerNote(null);
      setNutritionistNote(null);
      setSupplementStack([]);
      setAuthToken(token);
      return;
    }

    if (shouldResetUserCache) {
      // Different user on same device — clear the previous user's state
      // before hydrating this one so nothing leaks across accounts.
      // Clear transient active-workout keys so the watch pull_state handler
      // doesn't see a stale isWorkoutInProgress flag for the new account.
      await AsyncStorage.multiRemove([
        'activeWorkoutStartTime', 'activeWatchSessionId', 'activeWorkoutSession',
        'activeWorkoutTimers', 'activeWorkoutPausedAtMs', 'activeWorkoutPausedAccumMs',
      ]).catch(() => {});
      setTrainerNote(null);
      setNutritionistNote(null);
      setSupplementStack([]);
      // Wipe watch data immediately so the old workout/meals don't
      // linger while the new user's plan loads (userId is already
      // updated above so this push carries the correct identity).
      try {
        const { clearWatchData } = await import('../src/utils/watchSync');
        await clearWatchData();
      } catch { /* bridge optional */ }
    }

    if (incomingUsername) await AsyncStorage.setItem('user_username', incomingUsername);
    if (incomingUserId != null) {
      await AsyncStorage.setItem(LAST_USER_ID_KEY, String(incomingUserId));
    }

    // Legal re-acceptance check on fresh login (mirror of the session-
    // restore branch above). Runs AFTER the userSwitched wipe so the
    // local cache reflects THIS user's state, not the previous user's
    // — otherwise a different account on the same device would inherit
    // the prior user's "already accepted" stamp and skip the prompt.
    if (meForLegalCheck) {
      try {
        const { needsLegalReAcceptance, LEGAL_VERSION: currentLegalVersion } = await import('../src/constants/legal');
        const locallyAccepted = await AsyncStorage.getItem(LEGAL_LOCAL_ACCEPTED_KEY).catch(() => null);
        if (locallyAccepted !== currentLegalVersion) {
          if (needsLegalReAcceptance(meForLegalCheck as any)) {
            setLegalReAcceptNeeded(true);
          } else {
            AsyncStorage.setItem(LEGAL_LOCAL_ACCEPTED_KEY, currentLegalVersion).catch(() => {});
          }
        }
      } catch { /* legal module optional in dev */ }
    }

    // Same user (or user-switched) — give backend state hydration a short
    // head start, but never hold the login screen hostage to a slow cold
    // state pull. The pull keeps running and lands caches as it finishes.
    const statePull = pullUserStateFromBackend(token).catch(() => null);
    await Promise.race([
      statePull,
      new Promise(resolve => setTimeout(resolve, 4500)),
    ]);
    const loadedProfile = await loadProfile(token, incomingUserId);
    setAuthToken(token);
    resetOrdinaryAppNavigation();

    // Auto-reconnect Apple Health silently if the user previously enabled it.
    // HealthKit permissions are iOS-level and survive logout — we just need to
    // re-request (no dialog shown if already granted) so the session is warm
    // and ProgressScreen doesn't show the "Connect" prompt on first visit.
    try {
      const { isAppleHealthEnabled: ahEnabled } = await import('../src/utils/workoutHistory');
      const { isHealthKitAvailable, requestHealthPermissions } = await import('../src/services/appleHealth');
      if (tierOf(loadedProfile) === 'pro' && await ahEnabled() && isHealthKitAvailable()) {
        requestHealthPermissions().catch(() => {});
      }
    } catch { /* HealthKit optional, never block sign-in */ }
  };

  const handleProfileComplete = async (profile: UserProfile) => {
    const stamped = stampGoalStart(withDefaultTheme(profile), null);
    // Beta UI can show Pro affordances locally, but plan generation is
    // server-gated. `getMe` below must grant Pro before any Pro-only
    // generation calls run.
    let stampedWithTier: UserProfile = { ...stamped, subscriptionTier: stamped.subscriptionTier ?? 'free' };
    await AsyncStorage.setItem('userProfile', JSON.stringify(stampedWithTier));

    if (!authToken) {
      setUserProfile(stampedWithTier);
      return;
    }
    // Onboarding is complete — NOW persist the auth token so the user stays
    // signed in across app restarts. Held off until this point so a
    // half-finished signup doesn't leave a stale token on disk.
    await saveAuthToken(authToken);
    // Also commit the identity keys we held back during sign-up. These
    // pair with the profile save above so a crash before this line leaves
    // NO user-scoped trace on disk — fresh signup fully re-runs.
    try {
      const me = await getMe(authToken);
      const uid = (me as any)?.id ?? (me as any)?.user_id ?? null;
      const uname = (me as any)?.username ?? null;
      stampedWithTier = {
        ...stamped,
        ...billingEntitlementToProfilePatch(me as any),
      };
      if (uid != null) {
        stampedWithTier = stampCachedProfileOwner(stampedWithTier, uid);
      }
      await AsyncStorage.setItem('userProfile', JSON.stringify(stampedWithTier));
      if (uname) await AsyncStorage.setItem('user_username', uname);
      if (uid != null) await AsyncStorage.setItem(LAST_USER_ID_KEY, String(uid));
    } catch {}
    const onboardingSync = syncOnboarding(authToken, stampedWithTier).catch(() => null);

    if (serverTierOf(stampedWithTier) === 'free') {
      await clearAllPlanCache().catch(() => null);
      await clearPlanGenMarker().catch(() => null);
      try {
        const { setAppleHealthEnabled: disableAppleHealth } = await import('../src/utils/workoutHistory');
        await disableAppleHealth(false);
      } catch {}
      setUserProfile(stampedWithTier);
      setIsLoading(false);
      setIsWorkoutUpdating(false);
      setIsNutritionUpdating(false);
      return;
    }
    await onboardingSync;

    setUserProfile(stampedWithTier);
    setIsLoading(false);
    setIsWorkoutUpdating(false);
    setIsNutritionUpdating(false);

    const onboardingToken = authToken;
    const onboardingProfile = stampedWithTier;
    void (async () => {
      holdPlanGenAwake();
      await setPlanGenMarker('workout').catch(() => null);
      try {
        const aiPlans = await getAIWorkoutPlan(
          onboardingToken,
          onboardingProfile,
          onboardingProfile.lastWorkoutContext
            ? { extraContext: `Recent workout context from user: ${onboardingProfile.lastWorkoutContext}` }
            : undefined,
        );
        await applyPlanResult(aiPlans);
        await AsyncStorage.setItem('weekStartDate', new Date().toISOString());
        await appendUserLog({ type: 'plan_generated', summary: `Initial workout plan generated for goal: ${onboardingProfile.goal.replace(/_/g, ' ')}` });
        setPlanRefreshKey(k => k + 1);

        if (onboardingProfile.lastWorkoutContext) {
          try {
            const parsed = await parseRecentWorkouts(onboardingToken, onboardingProfile.lastWorkoutContext);
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
              const sessionDate = s.date || new Date(session.date).toISOString().slice(0, 10);
              const exercisesPayload = workoutSessionToLoggedPayload(session);
              await completeWorkoutWithOfflineQueue(
                onboardingToken,
                {
                  workout_date: sessionDate,
                  focus_label: session.focus,
                  duration_seconds: session.durationSeconds,
                  exercises: exercisesPayload.length > 0 ? exercisesPayload : undefined,
                  source: {
                    sourceContext: 'coach_log',
                    startedAt: session.startedAt ?? session.date,
                    endedAt: session.endedAt ?? new Date(new Date(session.date).getTime() + session.durationSeconds * 1000).toISOString(),
                    externalSourceId: session.id,
                  },
                },
                session,
              ).catch(e =>
                console.warn('[onboarding] workout completion queue failed for', sessionDate, e),
              );
            }
            if (parsed.sessions?.length) {
              console.log(`[onboarding] logged ${parsed.sessions.length} workout sessions from context`);
              setPlanRefreshKey(k => k + 1);
            }
          } catch (e) {
            console.warn('[onboarding] failed to parse workout context:', e);
          }
        }
      } catch (err: any) {
        const msg = err?.message ?? '';
        if (!msg.toLowerCase().includes('cancelled') && !msg.includes('orphaned_on_restart')) {
          console.warn('[onboarding] background workout plan generation failed:', msg || err);
        }
      } finally {
        await clearPlanGenMarker().catch(() => null);
        releasePlanGenAwake();
      }
    })();
  };

  const handleSignOut = async () => {
    const raceTimeout = <T,>(p: Promise<T>, ms: number): Promise<T | void> =>
      Promise.race([p, new Promise<void>(r => setTimeout(r, ms))]);
    if (authToken) {
      await raceTimeout(pushUserStateToBackend(authToken).catch(() => {}), 2000);
      // Bump server-side token_version so this token (and every other
      // device's token) is invalidated. Best-effort with a short timeout
      // so a flaky network can't strand the user on the auth screen.
      try {
        const { logout } = await import('../src/services/api');
        await raceTimeout(logout(authToken).catch(() => {}), 1500);
      } catch { /* api module optional */ }
    }
    try {
      const { clearWatchData } = await import('../src/utils/watchSync');
      const { WatchBridge } = await import('../modules/thallo-watch-bridge');
      await raceTimeout(clearWatchData(), 500);
      // Clear bridge userId AFTER the clear payloads are queued so they
      // arrive on the watch stamped with the outgoing user's id (triggering
      // a proper wipe) rather than arriving without a userId key at all.
      WatchBridge.setUserId(null);
    } catch { /* watch bridge optional */ }
    try {
      const [{ cancelWorkoutReminders }, { cancelMealReminder }, { cancelHydrationReminders }, { cancelAllCoachingNotifications }, Notifications] = await Promise.all([
        import('../src/utils/workoutReminders'),
        import('../src/utils/mealReminders'),
        import('../src/utils/hydrationReminders'),
        import('../src/utils/coachingNotifications'),
        import('expo-notifications'),
      ]);
      await raceTimeout(Promise.all([
        cancelWorkoutReminders().catch(() => {}),
        cancelMealReminder().catch(() => {}),
        cancelHydrationReminders().catch(() => {}),
        cancelAllCoachingNotifications().catch(() => {}),
        Notifications.cancelAllScheduledNotificationsAsync().catch(() => {}),
      ]), 1500);
    } catch { /* notification cleanup is best-effort */ }
    await clearUserScopedStorage({ preserveKeys: [TUTORIAL_COMPLETED_KEY, LEGAL_LOCAL_ACCEPTED_KEY, LAST_USER_ID_KEY] });
    try { await AsyncStorage.removeItem('pending_plan_job'); } catch {}
    await clearAuthToken();
    setAuthEntryMode(Platform.OS === 'web' ? 'login' : 'landing');
    setAuthToken(null);
    setUserProfile(null);
    setIsEditing(false);
    setEditMode('goal');
    setShowProgress(false);
    setShowAccount(false);
    setShowSupplements(false);
    setPlayStartCountdown(false);
    setActiveWorkout(null);
    // Keep trainerNote / nutritionistNote / supplementStack in memory so if
    // the same user signs back in they don't flicker away — they'll be
    // re-populated from AsyncStorage by loadProfile anyway.
  };

  // Refreshes generated Pro plans after the server reports a Pro tier.
  // Client-side tier changes are intentionally ignored.
  const handleUpgradeToPro = async (updated: UserProfile) => {
    if (!authToken || serverTierOf(updated) !== 'pro') return;
    setIsWorkoutUpdating(true);
    setIsNutritionUpdating(true);
    holdPlanGenAwake();
    try {
      const { getAIPlans } = await import('../src/services/api');
      const aiPlans: any = await getAIPlans(authToken, updated);
      await applyPlanResult(aiPlans);
    } catch (e) {
      console.error('[handleUpgradeToPro] regen failed:', e);
    } finally {
      setIsWorkoutUpdating(false);
      setIsNutritionUpdating(false);
      releasePlanGenAwake();
    }
  };

  // Switch-Day regen. Uses /generate-week which builds one coherent recipe
  // with the pinned focus baked in — the whole split rotates correctly
  // around the user's pick. Also persists to the DB so re-login keeps it.
  // Throws on failure so HomeScreen can fall through to its own fallbacks.
  const handleSwitchDayRegen = async (pinDayIdx: number, pinFocus: string): Promise<any[] | undefined> => {
    if (!authToken || !userProfile) return undefined;
    const injuries = (userProfile.injuryEntries ?? [])
      .filter((i: any) => i.status !== 'resolved')
      .map((i: any) => `${i.bodyPart || i.description} (status: ${i.status})`);

    const { generateWorkoutWeek } = await import('../src/services/api');
    const res = await generateWorkoutWeek(authToken, {
      goal: userProfile.goal,
      days_per_week: userProfile.daysPerWeek,
      session_minutes: userProfile.workoutDurationMinutes ?? 60,
      experience: userProfile.experienceLevel ?? 'intermediate',
      equipment: userProfile.equipment ?? [],
      preferred_split: userProfile.preferredSplit,
      priority_region: userProfile.priorityRegion ?? 'balanced',
      injuries,
      disliked_exercises: userProfile.dislikedExercises ?? [],
      pin_day_index: pinDayIdx,
      pin_focus: pinFocus,
    });

    if (!res?.days?.length) throw new Error('/generate-week returned no days');

    const planRaw = await AsyncStorage.getItem('aiWorkoutPlan');
    const existingPlan = planRaw ? JSON.parse(planRaw) : {};
    const updatedPlan = { ...existingPlan, days: res.days };
    await AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(updatedPlan));
    const t = new Date();
    const tk = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    await AsyncStorage.setItem(`freshDayGenerated_${tk}`, '1');
    return res.days;
  };

  // Optional explicit mode override — used by the inline tab editors in
  // HomeScreen which don't go through the EditProfileScreen modal so
  // `editMode` state would otherwise be stale and the wrong section
  // would regenerate (or nothing would).
  const handleSaveProfile = async (updated: UserProfile, modeOverride?: typeof editMode) => {
    const effectiveMode = modeOverride ?? editMode;

    // Goal/workout/mealplan edits affect the next generated week, so
    // confirm before saving any settings that change the future plan
    // shape. Mealplan was previously skipped — added so users get the
    // same "applies next Monday" heads-up when changing variety,
    // allergens, or foods mid-week.
    //
    // CRITICAL: only show the warning when an existing plan is in
    // flight. First-time setup (right after onboarding) has no prior
    // userProfile — every field comparison evaluates to "changed" and
    // would intercept the very first save, blocking initial plan
    // generation. The warning is only meaningful for users who have an
    // active week being disrupted.
    const hasExistingPlan = !!userProfile && !!userProfile.goal;
    if (hasExistingPlan && (effectiveMode === 'goal' || effectiveMode === 'workout' || effectiveMode === 'mealplan')) {
      // Only open the "save for next week" modal if the user actually
      // changed something in the relevant scope. The previous
      // workout-mode branch hardcoded `true`, so simply opening the
      // workout settings sheet and tapping Save (no fields touched)
      // wrote a phantom "user · workout settings" row to the change
      // history and nudged the user into a "scheduled" state they
      // never asked for.
      const willRegen = !planScopeIsUnchanged(userProfile, updated, effectiveMode as 'goal' | 'workout' | 'mealplan');
      if (willRegen) {
        const repairInjuryConflicts = effectiveMode === 'workout' && activeInjuriesChanged(userProfile, updated);
        const repairEquipmentConflicts = effectiveMode === 'workout' && equipmentWasRemoved(userProfile, updated);
        const updateDurationCoveredKeys = [
          'workoutDurationMinutes',
          repairInjuryConflicts ? 'injuries' : null,
          repairInjuryConflicts ? 'injuryEntries' : null,
          repairEquipmentConflicts ? 'equipment' : null,
        ].filter((key): key is string => !!key);
        const updateSessionDuration =
          effectiveMode === 'workout'
          && workoutDurationChanged(userProfile, updated)
          && !equipmentWasAdded(userProfile, updated)
          && workoutSettingsUnchangedExcept(userProfile, updated, updateDurationCoveredKeys);
        setPendingSave({
          profile: updated,
          mode: effectiveMode,
          repairInjuryConflicts,
          repairEquipmentConflicts,
          updateSessionDuration,
        });
        return;
      }
    }
    await _doSaveProfile(updated, modeOverride);
  };

  const _doSaveProfile = async (
    updated: UserProfile,
    modeOverride?: typeof editMode,
    options?: {
      updateRemainingWeekNutrition?: boolean;
      repairInjuryConflicts?: boolean;
      repairEquipmentConflicts?: boolean;
      updateSessionDuration?: boolean;
    },
  ) => {
    const effectiveMode = modeOverride ?? editMode;
    let stamped = stampGoalStart(updated, userProfile);
    const nextWeight = Number(stamped.physicalStats?.weightLbs);
    const prevWeight = Number(userProfile?.physicalStats?.weightLbs);
    const bodyWeightChanged = Number.isFinite(nextWeight)
      && nextWeight > 0
      && Number.isFinite(prevWeight)
      && Math.round(nextWeight * 10) !== Math.round(prevWeight * 10);
    if (bodyWeightChanged) {
      stamped = await profileWithWeightHistory(stamped, nextWeight, 'manual');
    }
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
    if (authToken && (stamped.customExercises?.length ?? 0) > 0) {
      stamped = await pushCustomExercisesToBackend(authToken, stamped);
    }
    await AsyncStorage.setItem('userProfile', JSON.stringify(stamped));
    setUserProfile(stamped);
    if (bodyWeightChanged) {
      await appendUserLog({ type: 'weight_updated', summary: `Weight updated to ${stamped.physicalStats.weightLbs} lbs` });
      pushWeightSnapshotToWatch(stamped).catch(() => null);
    }
    // Direct watch theme push on save — HomeScreen's useEffect will also
    // fire on the themePreference dep change, but a save can race the
    // re-render. Pushing here guarantees the watch sees the new theme
    // immediately after Save (no need to land back on Home first).
    if (stamped.themePreference !== userProfile?.themePreference) {
      try {
        const { pushThemeToWatch } = await import('../src/utils/watchSync');
        await pushThemeToWatch(stamped.themePreference);
      } catch { /* watch may be unavailable */ }
    }
    const priorEditMode = effectiveMode;
    setIsEditing(false);
    setEditMode('goal');
    // Sync to backend so the edit is available on other devices.
    // Await the sync so the backend has the latest profile before plan generation.
    if (authToken) {
      const immediateWorkoutRepairRequested =
        effectiveMode === 'workout'
        && tierOf(stamped) === 'pro'
        && (
          options?.repairInjuryConflicts === true
          || options?.repairEquipmentConflicts === true
          || options?.updateSessionDuration === true
        );
      if (bodyWeightChanged) {
        await syncWeightToBackend(stamped, stamped.physicalStats.weightLbs, 'manual');
      } else {
        await pushUserStateToBackend(authToken).catch(() => null);
        if (immediateWorkoutRepairRequested) {
          await syncOnboarding(authToken, stamped);
        } else {
          await syncOnboarding(authToken, stamped).catch(() => null);
        }
      }

      // CRITICAL: profile saves do not rebuild the active workout week.
      // Injury and removed-equipment changes are safety/availability
      // exceptions: they run deterministic repairs that preserve the week
      // structure and only rewrite today/future unlocked workouts. Meal plan
      // saves also default to next-week-only, but the confirmation modal can
      // opt into a scoped nutrition refresh for future eligible days.
      // Previously this path eagerly regenerated nutrition on goal/mealplan
      // edits, which:
      //   1. Wiped today's planned meals out from under the user
      //   2. Made goal changes apply to meals but NOT workouts
      //      (regenWorkout was already false), creating a confusing
      //      "half-applied" state
      //   3. Disagreed with the modal copy that promised changes wouldn't
      //      take effect until the next plan week
      // syncOnboarding above already persists the new settings; the next
      // auto-renew at week boundary picks them up on its own unless the user
      // explicitly asks to update remaining meals now.
      const regenWorkout = false;
      const repairInjuryConflicts =
        effectiveMode === 'workout'
        && options?.repairInjuryConflicts === true
        && tierOf(stamped) === 'pro';
      const repairEquipmentConflicts =
        effectiveMode === 'workout'
        && options?.repairEquipmentConflicts === true
        && tierOf(stamped) === 'pro';
      const updateSessionDuration =
        effectiveMode === 'workout'
        && options?.updateSessionDuration === true
        && tierOf(stamped) === 'pro';
      const refreshNutritionForWeight =
        bodyWeightChanged
        && !goalChanged
        && effectiveMode !== 'workout'
        && (
          effectiveMode !== 'mealplan'
          || options?.updateRemainingWeekNutrition !== false
        );
      const refreshRemainingNutrition =
        (effectiveMode === 'mealplan' && options?.updateRemainingWeekNutrition === true)
        || refreshNutritionForWeight;
      const regenNutrition = refreshRemainingNutrition;

      if (goalChanged) {
        await appendUserLog({
          type: 'goal_updated',
          summary: `Goal updated to ${stamped.goal.replace(/_/g, ' ')}; next generated week will use it.`,
        });
      }

      if (repairInjuryConflicts || repairEquipmentConflicts || updateSessionDuration) {
        setIsWorkoutUpdating(true);
        const repairSteps: Promise<unknown>[] = [];
        if (repairInjuryConflicts) repairSteps.push(repairPlanWeekInjuryConflicts(authToken));
        if (repairEquipmentConflicts) repairSteps.push(repairPlanWeekEquipmentConflicts(authToken));
        if (updateSessionDuration) {
          repairSteps.push(updatePlanWeekSessionDuration(authToken, stamped.workoutDurationMinutes ?? 60));
        }
        Promise.all(repairSteps)
          .then(async () => {
            const updatedFor = [
              repairInjuryConflicts ? 'active injuries' : null,
              repairEquipmentConflicts ? 'available equipment' : null,
              updateSessionDuration ? 'session length' : null,
            ].filter(Boolean);
            await appendUserLog({
              type: 'plan_generated',
              summary: `Current week updated for ${updatedFor.join(', ')}.`,
            });
            setPlanRefreshKey(k => k + 1);
          })
          .catch((err: any) => {
            const msg = err?.message ?? '';
            console.error('[repairCurrentPlanWeek] failed:', msg || err);
            Alert.alert('Current week update failed', msg || 'Your workout settings were saved, but the current week could not be repaired. Try again from workout settings.');
          })
          .finally(() => {
            setIsWorkoutUpdating(false);
          });
      } else if (regenWorkout || regenNutrition) {
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
        if (regenWorkout || regenNutrition) {
          const markerKind: PlanGenMarker['kind'] = refreshRemainingNutrition
            ? 'nutrition_remaining'
            : (regenWorkout && regenNutrition)
              ? 'full'
              : regenWorkout
                ? 'workout'
                : 'nutrition';
          setPlanGenMarker(markerKind).catch(() => null);
        }

        const opts = { userLog, extraContext };

        // Goal/meal-plan edits refresh nutrition templates only. Workout
        // edits do not replace the active PlanWeek from this path.
        const planCall = (regenWorkout && regenNutrition)
          ? getAIPlans(authToken, stamped, opts)
          : regenWorkout
            ? getAIWorkoutPlan(authToken, stamped, opts)
            : refreshRemainingNutrition
              ? getAIRemainingWeekNutritionPlan(authToken, stamped, opts)
              : getAINutritionPlan(authToken, stamped, opts);

        planCall
          .then(async (aiPlans: any) => {
            // Centralized handler — see applyPlanResult for what it does
            // (storage writes, templates version stamp, per-day saves wipe).
            if (refreshRemainingNutrition) await applyRemainingWeekNutritionResult(aiPlans);
            else await applyPlanResult(aiPlans);
            // Only reset week timer on full regens, not single-side edits.
            if (aiPlans.nutrition_plans?.length && regenWorkout && regenNutrition) {
              await AsyncStorage.setItem('weekStartDate', new Date().toISOString());
            }
            // Push the freshly-rotated plan onto the next 3 days of remote
            // day-state so cross-device reads don't briefly show the old
            // plan before HomeScreen catches up.
            if (aiPlans.nutrition_plans?.length && !refreshRemainingNutrition) {
              const todayDate = new Date();
              const tok = authToken;
              for (let i = 0; i < 3; i++) {
                const d = new Date(todayDate);
                d.setDate(todayDate.getDate() + i);
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                upsertDayState(tok, key, { nutrition_plan: null }).catch(() => null);
              }
            }
            const what = refreshRemainingNutrition
              ? 'remaining meal plan'
              : (regenWorkout && regenNutrition) ? 'full plan' : regenWorkout ? 'workout plan' : 'nutrition plan';
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
            clearPlanGenMarker().catch(() => null);
            releasePlanGenAwake();
          });
      } else {
        setPlanRefreshKey(k => k + 1);
      }
    }
  };

  const handleSaveSupplements = async (updated: UserProfile) => {
    await AsyncStorage.setItem('userProfile', JSON.stringify(updated));
    setUserProfile(updated);
    setShowSupplements(false);
    if (authToken) syncOnboarding(authToken, updated).catch(() => null);
  };

  // Persist a single dislikedExercises append. Used by the in-workout
  // thumbs-down — must not touch edit mode, weight history, goal /
  // nutrition regen, or any of the side effects in `_doSaveProfile`.
  // Local-first: AsyncStorage + setUserProfile commit synchronously;
  // backend sync is best-effort and never blocks.
  const handleDislikeExercise = useCallback((exerciseName: string) => {
    if (!userProfile) return;
    const trimmed = String(exerciseName ?? '').trim();
    if (!trimmed) return;
    const existing = userProfile.dislikedExercises ?? [];
    if (existing.some(d => d.toLowerCase() === trimmed.toLowerCase())) return;
    const updated: UserProfile = {
      ...userProfile,
      dislikedExercises: [...existing, trimmed],
    };
    setUserProfile(updated);
    AsyncStorage.setItem('userProfile', JSON.stringify(updated)).catch(() => null);
    if (authToken) syncOnboarding(authToken, updated).catch(() => null);
  }, [userProfile, authToken]);

  const handleProfileUpdate = useCallback(async (changes: Partial<UserProfile>, skipRegen?: boolean) => {
    if (!userProfile) return;
    const updated = { ...userProfile, ...changes };
    let stamped = changes.goal ? stampGoalStart(updated, userProfile) : updated;
    if (changes.goal) {
      await recordGoalChange(stamped.goal, stamped.goalDetails.pace, stamped.physicalStats.weightLbs);
    }
    if (authToken && changes.customExercises) {
      stamped = await pushCustomExercisesToBackend(authToken, stamped);
    }
    await AsyncStorage.setItem('userProfile', JSON.stringify(stamped));
    setUserProfile(stamped);
    if (authToken) {
      await Promise.all([
        pushUserStateToBackend(authToken).catch(() => null),
        syncOnboarding(authToken, stamped).catch(() => null),
      ]);
    }
    if (changes.themePreference) {
      import('../src/utils/watchSync')
        .then(({ pushThemeToWatch }) => pushThemeToWatch(stamped.themePreference))
        .catch(() => null);
    }
    if (skipRegen) {
      console.log('[onProfileUpdate] profile saved, skipping regen');
      setPlanRefreshKey(k => k + 1);
      return;
    }
    const needsWorkout = !!changes.daysPerWeek || !!changes.workoutDurationMinutes || !!changes.equipment || !!changes.goal || !!changes.preferredSplit;
    const needsNutrition = !!changes.goal;
    if (needsWorkout || needsNutrition) {
      console.log('[onProfileUpdate] profile saved; active PlanWeek left unchanged', {
        needsWorkout,
        needsNutrition,
      });
    }
    setPlanRefreshKey(k => k + 1);
  }, [authToken, userProfile]);

  const handleWorkoutFinish = (_session: WorkoutSession) => {
    setPlayStartCountdown(false);
    setActiveWorkout(null);
    // Bump refresh key so HomeScreen re-checks workout status from
    // the backend DB. Without this, todayDone stays false until the
    // user manually reloads — even though logWorkoutDone already
    // wrote the completion to the server inside ActiveWorkoutScreen.
    setPlanRefreshKey(k => k + 1);
  };

  const handleUpdateWeight = async (
    weightLbs: number,
    source: 'manual' | 'onboarding' | 'coach' | 'checkin' | 'watch' = 'manual',
  ) => {
    if (!userProfile) return;
    const canonicalWeight = Math.round(Number(weightLbs) * 10) / 10;
    if (!Number.isFinite(canonicalWeight) || canonicalWeight <= 0) return;

    const updated = await profileWithWeightHistory(userProfile, canonicalWeight, source);
    await AsyncStorage.setItem('userProfile', JSON.stringify(updated));
    setUserProfile(updated);
    setPlanRefreshKey(k => k + 1);
    await appendUserLog({ type: 'weight_updated', summary: `Weight updated to ${canonicalWeight} lbs` });
    pushWeightSnapshotToWatch(updated, source === 'watch').catch(() => null);
    if (authToken) {
      await syncWeightToBackend(updated, canonicalWeight, source);
      await refreshRemainingNutritionForWeight(updated, canonicalWeight);
    }
  };

  const handleCancelScheduledPlanChange = async (restoredProfile: UserProfile) => {
    const goalRestored =
      !!userProfile &&
      (
        userProfile.goal !== restoredProfile.goal ||
        userProfile.goalDetails?.pace !== restoredProfile.goalDetails?.pace
      );
    if (goalRestored) {
      await recordGoalChange(
        restoredProfile.goal,
        restoredProfile.goalDetails.pace,
        restoredProfile.physicalStats.weightLbs,
      );
    }
    await AsyncStorage.setItem('userProfile', JSON.stringify(restoredProfile));
    setUserProfile(restoredProfile);
    if (authToken) {
      await syncOnboarding(authToken, restoredProfile).catch((e) =>
        console.warn('[cancelPlanChange] profile sync failed (non-fatal)', e?.message ?? e),
      );
      await pushUserStateToBackend(authToken).catch(() => null);
    }
    setPlanRefreshKey(k => k + 1);
  };

  if (isLoading) return <SplashLoadingScreen />;
  if (!authToken) {
    if (Platform.OS === 'web') {
      return (
        <AuthScreen
          initialMode={authEntryMode === 'signup' ? 'signup' : 'login'}
          onBack={() => router.replace('/')}
          onAuthenticated={handleAuthenticated}
        />
      );
    }
    if (authEntryMode === 'landing') {
      return (
        <LandingScreen
          onLogin={() => setAuthEntryMode('login')}
          onSignup={() => setAuthEntryMode('signup')}
          onWhyThallo={() => setAuthEntryMode('why-thallo')}
        />
      );
    }
    if (authEntryMode === 'why-thallo') {
      return (
        <WhyThalloScreen
          onBack={() => setAuthEntryMode('landing')}
          onLogin={() => setAuthEntryMode('login')}
          onSignup={() => setAuthEntryMode('signup')}
        />
      );
    }
    return (
      <AuthScreen
        initialMode={authEntryMode}
        onBack={() => setAuthEntryMode('landing')}
        onAuthenticated={handleAuthenticated}
      />
    );
  }
  if (!userProfile) return (
    <OnboardingScreen
      authToken={authToken ?? ''}
      onComplete={handleProfileComplete}
      onExit={async () => {
        // Abandoning signup — wipe local state, clear in-memory token, and
        // send the user back to the auth screen. The backend account
        // lingers (they can sign in later), but nothing is left on device.
        await clearUserScopedStorage();
        try { await AsyncStorage.removeItem(LAST_USER_ID_KEY); } catch {}
        try { await clearAuthToken(); } catch {}
        setAuthEntryMode('landing');
        setAuthToken(null);
        setUserProfile(null);
        setTrainerNote(null);
        setNutritionistNote(null);
        setSupplementStack([]);
      }}
    />
  );

  if (Platform.OS === 'web') {
    return (
      <>
        <WebProgressShell
          authToken={authToken}
          userProfile={userProfile}
          onSignOut={handleSignOut}
          onUpdateWeight={handleUpdateWeight}
          onCancelScheduledPlanChange={handleCancelScheduledPlanChange}
        />
        {legalReAcceptNeeded && authToken && (
          <LegalDisclosureModal
            visible
            isReAcceptance
            themeColors={getTheme(userProfile?.themePreference).colors}
            onClose={() => undefined}
            onAccept={async () => {
              try {
                const [{ acceptLegal }, { LEGAL_VERSION }, { getMe: refetchMe }] = await Promise.all([
                  import('../src/services/api'),
                  import('../src/constants/legal'),
                  import('../src/services/api'),
                ]);
                await acceptLegal(authToken, LEGAL_VERSION);
                try { await AsyncStorage.setItem(LEGAL_LOCAL_ACCEPTED_KEY, LEGAL_VERSION); } catch {}
                setLegalReAcceptNeeded(false);
                await refetchMe(authToken).catch(() => null);
              } catch (err: any) {
                Alert.alert(
                  'Could not save acceptance',
                  err?.message ?? 'Please try again. Continued use of Thallo requires acceptance.',
                );
              }
            }}
          />
        )}
      </>
    );
  }

  // ActiveWorkoutScreen is a long-duration full takeover — unmount HomeScreen
  // while a workout is active so its effects/timers stop.
  if (activeWorkout) {
    return (
      <ActiveWorkoutScreen
        authToken={authToken}
        workout={activeWorkout}
        goal={userProfile.goal}
        themeName={userProfile.themePreference}
        profileGender={userProfile.physicalStats.gender}
        weightLbs={userProfile.physicalStats.weightLbs}
        weightUnit={userProfile.weightUnit ?? 'lbs'}
        distanceUnit={userProfile.distanceUnit ?? 'mi'}
        playStartCountdown={playStartCountdown}
        onFinish={handleWorkoutFinish}
        onCancel={handleCancelActiveWorkout}
        onDislikeExercise={handleDislikeExercise}
        onProfileUpdate={handleProfileUpdate}
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
        usernameRefreshKey={usernameRefreshKey}
        homeResetKey={homeResetKey}
        isWorkoutUpdating={isWorkoutUpdating}
        isNutritionUpdating={isNutritionUpdating}
        liveTutorialTargetTab={liveTutorialNavigation?.tab ?? null}
        liveTutorialNavigationKey={liveTutorialNavigation?.requestId ?? 0}
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
        onEditBody={() => { setEditMode('body'); setIsEditing(true); }}
        onStartWorkout={handleStartWorkout}
        onViewProgress={() => setShowProgress(true)}
        onViewAccount={() => setShowAccount(true)}
        onOpenSettings={() => setShowSettings(true)}
        onOpenImportSettings={() => {
          setSettingsOpenImportOnShow(true);
          setShowSettings(true);
        }}
        onHomeTabNavigate={() => {
          setShowSettings(false);
          setSettingsOpenImportOnShow(false);
          setShowAccount(false);
          setShowProgress(false);
        }}
        onUpdateWeight={handleUpdateWeight}
        onSaveProfile={(updated, mode) => handleSaveProfile(updated, mode)}
        onActivePlanWeekEndChange={setActivePlanWeekEnd}
        onCancelScheduledPlanChange={handleCancelScheduledPlanChange}
        onSwitchDayRegen={handleSwitchDayRegen}
        onBackendSync={async () => {
          // Called by the trainer chat Apply flow after a plan is
          // written to AsyncStorage. Pushes the updated state blob so
          // the next device / next login sees the applied change.
          if (authToken) {
            await pushUserStateToBackend(authToken);
          }
        }}
        onProfileUpdate={handleProfileUpdate}
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
      {/* Legal re-acceptance gate — blocking, no-dismiss modal that
          surfaces when the user's accepted legal versions don't match
          the current LEGAL_VERSION. Outranks Account / Settings /
          Tutorial visually because acceptance is a precondition for
          continued use. The hardware back button and OS dismiss are
          gated inside LegalDisclosureModal when `onAccept` is set. */}
      {legalReAcceptNeeded && authToken && (
        <LegalDisclosureModal
          visible
          isReAcceptance
          themeColors={getTheme(userProfile?.themePreference).colors}
          onClose={() => undefined}
          onAccept={async () => {
            try {
              const [{ acceptLegal }, { LEGAL_VERSION }, { getMe: refetchMe }] = await Promise.all([
                import('../src/services/api'),
                import('../src/constants/legal'),
                import('../src/services/api'),
              ]);
              await acceptLegal(authToken, LEGAL_VERSION);
              // Stamp the local cache so subsequent sign-outs / sign-ins
              // don't re-prompt while we wait for `/auth/me` to reflect
              // the new version.
              try { await AsyncStorage.setItem(LEGAL_LOCAL_ACCEPTED_KEY, LEGAL_VERSION); } catch {}
              setLegalReAcceptNeeded(false);
              // Best-effort refresh — keeps the in-memory `me` shape
              // (legal_accepted, *_version) consistent with the server
              // so a subsequent session-restore doesn't re-prompt.
              await refetchMe(authToken).catch(() => null);
            } catch (err: any) {
              Alert.alert(
                'Could not save acceptance',
                err?.message ?? 'Please try again. Continued use of Thallo requires acceptance.',
              );
            }
          }}
        />
      )}

      {showAccount && authToken && (
        <AccountInfoModal
          token={authToken}
          profile={userProfile}
          setUserProfile={setUserProfile}
          onUpgradeToPro={handleUpgradeToPro}
          onClose={() => setShowAccount(false)}
          onSignOut={handleSignOut}
          onUsernameChanged={() => setUsernameRefreshKey(k => k + 1)}
          onShowTutorial={() => {
            setShowTutorial(true);
            setShowAccount(false);
          }}
          onStartLiveTutorial={startLiveTutorial}
          onOpenSettings={() => {
            setShowAccount(false);
            setTimeout(() => setShowSettings(true), 200);
          }}
        />
      )}

      {/* Centralized Settings hub — notifications, units, permissions.
          Lives outside the Account modal so it has room to grow without
          bloating account-info chrome. Opened via Account → Settings. */}
      {showSettings && userProfile && (
        <SettingsScreen
          visible
          profile={userProfile}
          themeName={userProfile.themePreference}
          authToken={authToken}
          openImportOnShow={settingsOpenImportOnShow}
          onClose={() => {
            setShowSettings(false);
            setSettingsOpenImportOnShow(false);
          }}
          onSignOut={handleSignOut}
          onProfileUpdate={handleProfileUpdate}
        />
      )}

      {/* Post-onboarding tutorial. Lives at the app root so the
          Account modal's "Show tutorial again" button can flip it
          on directly — no flag-clear-and-redirect dance. */}
      {userProfile && (
        <TutorialOverlay
          visible={showTutorial}
          tier={tierOf(userProfile)}
          themeName={userProfile.themePreference}
          onThemeChange={async (themePreference) => {
            const updated = { ...userProfile, themePreference };
            setUserProfile(updated);
            await AsyncStorage.setItem('userProfile', JSON.stringify(updated)).catch(() => {});
            if (authToken) {
              syncOnboarding(authToken, updated).catch(() => null);
            }
            try {
              const { pushThemeToWatch } = await import('../src/utils/watchSync');
              await pushThemeToWatch(updated.themePreference);
            } catch {}
          }}
          onHealthSetup={handleTutorialHealthSetup}
          onUpgrade={tierOf(userProfile) === 'free' ? () => setShowAccount(true) : undefined}
          onClose={async ({ completed, startLiveTutorial: shouldStartLiveTutorial }) => {
            setShowTutorial(false);
            if (completed) {
              try { await AsyncStorage.setItem(TUTORIAL_COMPLETED_KEY, String(Date.now())); } catch {}
            }
            if (shouldStartLiveTutorial) startLiveTutorial();
          }}
        />
      )}

      {userProfile && (
        <LiveTutorialOverlay
          visible={showLiveTutorial}
          tabs={liveTutorialTabs}
          tier={tierOf(userProfile)}
          themeName={userProfile.themePreference}
          onNavigateTab={handleLiveTutorialNavigate}
          onClose={async ({ completed }) => {
            setShowLiveTutorial(false);
            setLiveTutorialNavigation(null);
            if (completed) {
              try { await AsyncStorage.setItem(LIVE_TUTORIAL_COMPLETED_KEY, String(Date.now())); } catch {}
            }
          }}
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
            onProfileUpdate={handleProfileUpdate}
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
            onCancelScheduledPlanChange={handleCancelScheduledPlanChange}
          />
        )}
      </Modal>

      {/* Save confirmation — themed modal */}
      {pendingSave && (() => {
        const tc = getTheme(userProfile?.themePreference).colors;
        const isGoal = pendingSave.mode === 'goal';
        const isMealplan = pendingSave.mode === 'mealplan';
        const shouldRepairInjuries = pendingSave.mode === 'workout' && pendingSave.repairInjuryConflicts === true;
        const shouldRepairEquipment = pendingSave.mode === 'workout' && pendingSave.repairEquipmentConflicts === true;
        const shouldUpdateSessionDuration = pendingSave.mode === 'workout' && pendingSave.updateSessionDuration === true;
        const currentWeekUpdateParts = [
          shouldUpdateSessionDuration ? 'new session length' : null,
          shouldRepairInjuries ? 'active injuries' : null,
          shouldRepairEquipment ? 'removed equipment' : null,
        ].filter(Boolean);
        const canUpdateCurrentWeek = currentWeekUpdateParts.length > 0;
        // Plan changes normally apply to the start of the NEXT plan week
        // because mid-week regen would invalidate the user's in-flight
        // schedule. Injury, removed-equipment, and session-duration changes
        // are scoped exceptions: they can update today/future unlocked
        // workouts immediately without changing the week shape. The next-week
        // start is the active PlanWeek's end_date + 1 (sign-up-day cadence) —
        // pulled up from HomeScreen via setActivePlanWeekEnd. Falls back to
        // today + 7 only when no PlanWeek exists (free users, brand-new signup).
        const effectiveDate = nextPlanWeekStart(activePlanWeekEnd);
        const effectiveDateLabel = formatPlanStartDateShort(effectiveDate);
        const titleText = isGoal
          ? 'Save Goal Change?'
          : isMealplan
            ? 'Save Meal Plan Settings?'
            : 'Save Workout Settings?';
        const bodyText = isGoal
          ? `Your active week stays unchanged so your in-flight plan is not disrupted. Your new goal applies starting ${effectiveDateLabel}.`
          : isMealplan
            ? `Today's meals stay as-is. Save for ${effectiveDateLabel}, or update remaining eligible days this week.`
            : canUpdateCurrentWeek
              ? shouldUpdateSessionDuration && !shouldRepairInjuries && !shouldRepairEquipment
                ? `Save for ${effectiveDateLabel}, or rebuild today and remaining unlocked workouts now to fit the new session length. Completed and started days stay unchanged.`
                : `Save for ${effectiveDateLabel}, or update today and remaining unlocked workouts now for ${currentWeekUpdateParts.join(', ')}. Completed and started days stay unchanged.`
              : `Your current week stays unchanged. The next training week starting ${effectiveDateLabel} will use these settings; use Change Focus or Swap for immediate day-level tweaks.`;
        // Field-level diff so the change row reads as e.g. "Pace:
        // aggressive → moderate · Goal: lose weight → maintain"
        // instead of the previous "Goal updated to moderate" which
        // didn't tell the user what actually changed.
        const summaryText = summarizeScopeDiff(
          userProfile,
          pendingSave.profile,
          pendingSave.mode as 'goal' | 'workout' | 'mealplan',
        );
        const commitPendingSave = async (
          updateRemainingWeekNutrition = false,
          repairInjuryConflicts = false,
          repairEquipmentConflicts = false,
          updateSessionDuration = false,
        ) => {
          if (!pendingSave) return;
          const saved = pendingSave;
          const previousProfile = userProfile;
          const nextProfile = previousProfile
            ? stampGoalStart(saved.profile, previousProfile)
            : saved.profile;
          setPendingSave(null);
          try {
            await _doSaveProfile(
              saved.profile,
              saved.mode as any,
              { updateRemainingWeekNutrition, repairInjuryConflicts, repairEquipmentConflicts, updateSessionDuration },
            );
            let nextProfileForChange = nextProfile;
            try {
              const storedProfileRaw = await AsyncStorage.getItem('userProfile');
              if (storedProfileRaw) nextProfileForChange = JSON.parse(storedProfileRaw);
            } catch { /* keep fallback snapshot */ }
            try {
              const scope = saved.mode as 'goal' | 'workout' | 'mealplan';
              // Final-mile guard: even if upstream let us through (e.g.
              // an array reordered without semantic change), don't
              // write a plan-change row if the scope-relevant snapshot
              // is identical. Prevents phantom "user · X Settings"
              // entries from cluttering the change history + banner.
              if (planScopeIsUnchanged(previousProfile, nextProfileForChange, scope)) {
                return;
              }
              const immediateMealRefresh = scope === 'mealplan' && updateRemainingWeekNutrition;
              const immediateInjuryRepair = scope === 'workout' && repairInjuryConflicts;
              const immediateEquipmentRepair = scope === 'workout' && repairEquipmentConflicts;
              const immediateDurationUpdate = scope === 'workout' && updateSessionDuration;
              const coveredWorkoutKeys = [
                immediateInjuryRepair ? 'injuries' : null,
                immediateInjuryRepair ? 'injuryEntries' : null,
                immediateEquipmentRepair ? 'equipment' : null,
                immediateDurationUpdate ? 'workoutDurationMinutes' : null,
              ].filter((key): key is string => !!key);
              const immediateWorkoutUpdateCoversChange =
                (immediateInjuryRepair || immediateEquipmentRepair || immediateDurationUpdate)
                && workoutSettingsUnchangedExcept(previousProfile, nextProfileForChange, coveredWorkoutKeys);
              const immediateWorkoutLabels = [
                immediateInjuryRepair ? 'active injuries' : null,
                immediateEquipmentRepair ? 'equipment' : null,
                immediateDurationUpdate ? 'session length' : null,
              ].filter(Boolean);
              await savePlanChange({
                id: `user-${Date.now()}`,
                changedAt: new Date().toISOString(),
                changedBy: 'user',
                scope,
                summary: immediateMealRefresh
                  ? `${summaryText}; remaining eligible days refreshed`
                  : immediateWorkoutLabels.length > 0
                    ? `${summaryText}; current week updated for ${immediateWorkoutLabels.join(', ')}`
                    : summaryText,
                question: '',
                // effectiveDate must be a YYYY-MM-DD string — the
                // PlanChangeEntry type is `string`, and
                // `planChangeIsScheduled` does a string-comparison
                // against today's dateKey. The previous code passed
                // `new Date()` for the immediate paths, which got
                // JSON-coerced to a full ISO with time and broke
                // the "is this scheduled?" check downstream.
                effectiveDate: (immediateMealRefresh || immediateWorkoutUpdateCoversChange)
                  ? planDateKey(new Date())
                  : effectiveDate,
                previousProfile: previousProfile ? planChangeProfileSnapshot(previousProfile, scope) : undefined,
                nextProfile: planChangeProfileSnapshot(nextProfileForChange, scope),
              });
            } catch { /* non-critical */ }
          } catch (err: any) {
            console.error('[_doSaveProfile] error:', err);
            Alert.alert('Save failed', err?.message ?? 'Something went wrong. Please try again.');
            setIsWorkoutUpdating(false);
            setIsNutritionUpdating(false);
          }
        };
        return (
          <Modal visible transparent animationType="fade" onRequestClose={() => setPendingSave(null)}>
            <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
              <View
                accessibilityViewIsModal
                importantForAccessibility="yes"
                style={{ backgroundColor: tc.surface, borderRadius: 20, padding: 24, width: '100%', maxWidth: 340, borderWidth: 1, borderColor: tc.border }}>
                <Text accessibilityRole="header" style={{ fontSize: 18, fontWeight: '800', color: tc.textPrimary, textAlign: 'center', marginBottom: 8 }}>
                  {titleText}
                </Text>
                <Text style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center', marginBottom: 14, lineHeight: 18 }}>
                  {bodyText}
                </Text>
                <View style={{ backgroundColor: tc.primary + '14', borderRadius: 10, padding: 10, marginBottom: 18, borderWidth: 1, borderColor: tc.primary + '33' }}>
                  <Text style={{ fontSize: 11, fontWeight: '800', color: tc.primary, letterSpacing: 0.5, marginBottom: 2 }}>
                    {canUpdateCurrentWeek ? 'UPDATES CURRENT WEEK' : isMealplan ? 'NEXT WEEK STARTS' : 'APPLIES'} {canUpdateCurrentWeek ? 'NOW' : effectiveDateLabel.toUpperCase()}
                  </Text>
                  <Text style={{ fontSize: 11, color: tc.textSecondary, lineHeight: 15 }}>
                    Tracked in Progress → Change History so you can review when each change took effect.
                  </Text>
                </View>
                {(isMealplan || canUpdateCurrentWeek) && (
                  <TouchableOpacity
                    style={{ backgroundColor: tc.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginBottom: 10 }}
                    testID="pending-save-update-remaining"
                    accessibilityRole="button"
                    accessibilityLabel={isMealplan ? 'Save and update remaining week' : 'Save and update current week'}
                    onPress={() => isMealplan
                      ? commitPendingSave(true, false, false)
                      : commitPendingSave(false, shouldRepairInjuries, shouldRepairEquipment, shouldUpdateSessionDuration)
                    }>
                    <Text style={{ color: getContrastingTextColor(tc.primary), fontSize: 15, fontWeight: '700' }}>
                      {isMealplan ? 'Save + Update Remaining Week' : 'Save + Update Current Week'}
                    </Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={{
                    backgroundColor: (isMealplan || canUpdateCurrentWeek) ? 'transparent' : tc.primary,
                    borderRadius: 12,
                    paddingVertical: 14,
                    alignItems: 'center',
                    marginBottom: 10,
                    borderWidth: (isMealplan || canUpdateCurrentWeek) ? 1 : 0,
                    borderColor: (isMealplan || canUpdateCurrentWeek) ? tc.border : 'transparent',
                  }}
                  testID="pending-save-confirm"
                  accessibilityRole="button"
                  accessibilityLabel={isGoal ? 'Save goal' : (isMealplan || canUpdateCurrentWeek) ? 'Save for next week' : 'Save settings'}
                  onPress={() => commitPendingSave(false)}>
                  <Text style={{ color: (isMealplan || canUpdateCurrentWeek) ? tc.textPrimary : getContrastingTextColor(tc.primary), fontSize: 16, fontWeight: '700' }}>
                    {isGoal ? 'Save Goal' : (isMealplan || canUpdateCurrentWeek) ? 'Save For Next Week' : 'Save Settings'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={{ borderRadius: 12, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: tc.border }}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel"
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

export default function Index() {
  if (Platform.OS === 'web') {
    return <AboutPage />;
  }
  return <NativeIndex />;
}

// ── Account Info Modal ────────────────────────────────────────────────────────

function AccountInfoModal({
  token, profile, setUserProfile, onUpgradeToPro, onClose, onSignOut, onUsernameChanged, onShowTutorial, onStartLiveTutorial, onOpenSettings,
}: {
  token: string;
  profile: UserProfile;
  setUserProfile: (p: UserProfile) => void;
  onUpgradeToPro: (p: UserProfile) => void | Promise<void>;
  onClose: () => void;
  onSignOut: () => void;
  onUsernameChanged?: (username: string) => void;
  /** When set, the "Show tutorial again" button calls this directly
   *  (instead of clearing the AsyncStorage flag and asking the user
   *  to navigate). Owner is the app root, which renders the
   *  TutorialOverlay. */
  onShowTutorial?: () => void;
  onStartLiveTutorial?: () => void;
  onOpenSettings?: () => void;
}) {
  const tc = getTheme(profile.themePreference).colors;
  const c = tc; // alias for the new Developer-logs block below
  const betaFullAccess = isBetaFullAccessEnabled();
  const billingBetaEnabled = isFeatureEnabled('billing.revenueCat');
  // Dummy test billing — flip free↔Pro with no real payment. Enabled in
  // local/dev builds by default; hidden when beta-full-access forces Pro.
  const dummyBillingEnabled = isFeatureEnabled('billing.dummyPayment') && !betaFullAccess;
  const subscriptionTier = tierOf(profile);
  const subscriptionLabel = subscriptionStatusLabel(profile);
  const subscriptionStatusValue = String(profile.subscriptionStatus ?? '').toLowerCase();
  const subscriptionIsRevenueCat = profile.subscriptionSource === 'revenuecat';
  const subscriptionIsSignupTrial = isTrialing(profile) && profile.subscriptionSource !== 'revenuecat';
  const subscriptionIsCancelledSignupTrial =
    subscriptionStatusValue === 'trial_cancelled'
    && profile.subscriptionSource !== 'revenuecat'
    && subscriptionTier === 'pro'
    && trialDaysRemaining(profile) > 0;
  const subscriptionCanCancelSignupTrial = subscriptionIsSignupTrial || subscriptionIsCancelledSignupTrial;
  const subscriptionCanManageStore = billingBetaEnabled && subscriptionIsRevenueCat && subscriptionTier === 'pro';
  const subscriptionActionStartsPurchase = subscriptionTier === 'free' || subscriptionIsSignupTrial || subscriptionIsCancelledSignupTrial;
  const trialEndsAtLabel = (() => {
    const parsed = Date.parse(profile.trialEndsAt ?? '');
    if (!Number.isFinite(parsed)) return null;
    return new Date(parsed).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  })();
  // Memoized — without this, every keystroke / state change in this
  // modal recreates the entire StyleSheet (40+ entries) and triggers
  // a re-mount of every styled child. Open felt sluggish.
  const am = useMemo(() => createAmStyles(tc), [tc]);
  const [accountData, setAccountData] = useState<{
    email: string;
    username: string;
    firstName?: string | null;
    lastName?: string | null;
    emailVerified?: boolean;
    legalAccepted?: boolean;
  } | null>(null);
  const [loading, setLoading]         = useState(true);
  const [hasRecoveryQuestion, setHasRecoveryQuestion] = useState(false);
  const [showRecoveryModal, setShowRecoveryModal] = useState(false);
  const [showTierInfo, setShowTierInfo] = useState(false);
  const [showLegal, setShowLegal] = useState(false);
  const [accountBusy, setAccountBusy] = useState<string | null>(null);
  const [dummyPaymentOpen, setDummyPaymentOpen] = useState(false);
  const [nameFirst, setNameFirst] = useState(profile.firstName ?? '');
  const [nameLast, setNameLast] = useState(profile.lastName ?? '');
  const [nameStatus, setNameStatus] = useState('');
  const [usernameDraft, setUsernameDraft] = useState('');
  const [usernameStatus, setUsernameStatus] = useState('');
  const [watchStatus, setWatchStatus] = useState<string>('No sync recorded yet');
  const cleanProfileText = (value: unknown): string => {
    const text = typeof value === 'string' ? value.trim() : '';
    return text && text.toLowerCase() !== 'undefined' && text.toLowerCase() !== 'null' ? text : '';
  };
  const profileNumberValue = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };
  const formatProfilePounds = (value: number): string =>
    Number.isInteger(value) ? `${value}` : value.toFixed(1);
  const physicalStats = ((profile as Partial<UserProfile>).physicalStats ?? {}) as any;
  const goalText = cleanProfileText(profile.goal);
  const goalValue = goalText
    ? goalText.replace(/_/g, ' ')
    : '—';
  const weightLbs = profileNumberValue(physicalStats.weightLbs ?? physicalStats.weight_lbs);
  const birthdate = cleanProfileText(physicalStats.birthdate ?? physicalStats.birth_date);
  const age = effectiveAge({ birthdate: birthdate || null, age: profileNumberValue(physicalStats.age) });
  const weightValue = weightLbs != null && weightLbs > 0
    ? `${formatProfilePounds(weightLbs)} lbs`
    : '—';
  const ageValue = age != null && age > 0 ? String(Math.round(age)) : '—';
  const ACCOUNT_ME_CACHE_KEY = 'accountModal.meCache.v1';

  useEffect(() => {
    let cancelled = false;
    const applyIfMounted = (fn: () => void) => {
      if (!cancelled) fn();
    };

    // Stale-while-revalidate: read cached /auth/me from AsyncStorage and
    // render it instantly so the modal opens with content already
    // populated. Then revalidate in the background so any server-side
    // change (email verified, legal accepted, name updated) lands on the
    // next render. Cuts perceived load time from ~5s (network) to ~0
    // for every open after the first. Cache is per-user-token so a
    // sign-out + sign-in-as-different-user can't leak data — the cache
    // gets overwritten by the new user's getMe response.
    const hydrateFromCache = async () => {
      try {
        const raw = await AsyncStorage.getItem(ACCOUNT_ME_CACHE_KEY);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (data?.token !== token) return false;  // different user — don't trust
        applyIfMounted(() => {
          setAccountData({
            email: data.email,
            username: data.username,
            firstName: data.firstName ?? null,
            lastName: data.lastName ?? null,
            emailVerified: !!data.emailVerified,
            legalAccepted: !!data.legalAccepted,
          });
          setUsernameDraft(data.username ?? '');
          setNameFirst(data.firstName ?? profile.firstName ?? '');
          setNameLast(data.lastName ?? profile.lastName ?? '');
          setHasRecoveryQuestion(!!data.hasRecoveryQuestion);
          setLoading(false);
        });
        return true;
      } catch {
        return false;
      }
    };

    hydrateFromCache().then(() => {
      getMe(token, { timeoutMs: 8000, noRetry: true })
        .then((data: any) => {
          applyIfMounted(() => {
            setAccountData({
              email: data.email,
              username: data.username,
              firstName: data.first_name ?? null,
              lastName: data.last_name ?? null,
              emailVerified: !!data.email_verified,
              legalAccepted: !!data.legal_accepted,
            });
            setUsernameDraft(data.username ?? '');
            setNameFirst(data.first_name ?? profile.firstName ?? '');
            setNameLast(data.last_name ?? profile.lastName ?? '');
            setHasRecoveryQuestion(!!data.has_recovery_question);
            const entitlementPatch = billingEntitlementToProfilePatch(data);
            const updatedProfile = { ...profile, ...entitlementPatch };
            setUserProfile(updatedProfile);
            AsyncStorage.setItem('userProfile', JSON.stringify(updatedProfile)).catch(() => {});
          });
          // Persist for next open. Token included so a user-switch
          // invalidates the cache automatically.
          AsyncStorage.setItem(ACCOUNT_ME_CACHE_KEY, JSON.stringify({
            token,
            email: data.email,
            username: data.username,
            firstName: data.first_name ?? null,
            lastName: data.last_name ?? null,
            emailVerified: !!data.email_verified,
            legalAccepted: !!data.legal_accepted,
            hasRecoveryQuestion: !!data.has_recovery_question,
            cachedAt: Date.now(),
          })).catch(() => {});
        })
        .catch(() => {
          // Network failed — keep whatever the cache populated. Only
          // wipe accountData on failure if the cache miss left us empty.
          applyIfMounted(() => setAccountData(prev => prev));
        })
        .finally(() => applyIfMounted(() => setLoading(false)));
    });

    const statusTask = InteractionManager.runAfterInteractions(() => {
      // Native Watch bridge checks can hitch the sheet animation on open.
      import('../src/utils/watchSync')
        .then(async ({ getWatchSyncSnapshot, WatchBridge }) => {
          const snap = await getWatchSyncSnapshot();
          const watchAppPresent =
            WatchBridge.isReachable()
            || WatchBridge.isWatchAppInstalled()
            || !!snap?.installed;
          const availability = !WatchBridge.isAvailable()
            ? 'bridge unavailable'
            : WatchBridge.isReachable()
              ? 'reachable'
              : WatchBridge.isPaired()
                ? (watchAppPresent ? 'paired, waiting' : 'paired, open watch app')
                : 'not paired';
          applyIfMounted(() => {
            if (!snap) {
              setWatchStatus(`No sync recorded yet (${availability})`);
              return;
            }
            const ageMin = Math.max(0, Math.round((Date.now() - snap.atMs) / 60000));
            setWatchStatus(`${snap.ok ? 'Last sync ok' : 'Last sync failed'}: ${snap.surface}, ${ageMin}m ago (${availability})`);
          });
        })
        .catch(() => applyIfMounted(() => setWatchStatus('Watch status unavailable')));
    });

    return () => {
      cancelled = true;
      statusTask.cancel();
    };
  }, [token]);

  const Row = ({ label, value, testID }: { label: string; value: string; testID?: string }) => (
    <View
      style={am.row}
      testID={testID}
      accessibilityLabel={`${label}, ${value}`}
      accessible={!!testID}
      collapsable={false}>
      <Text
        style={am.rowLabel}
        testID={testID ? `${testID}-label` : undefined}>
        {label}
      </Text>
      <Text
        style={am.rowValue}
        testID={testID ? `${testID}-value` : undefined}>
        {value}
      </Text>
    </View>
  );

  const handleSaveName = async () => {
    const firstName = nameFirst.trim();
    const lastName = nameLast.trim();
    if (firstName === (profile.firstName ?? '') && lastName === (profile.lastName ?? '')) return;
    setAccountBusy('name');
    setNameStatus('');
    try {
      const res = await updateName(token, firstName, lastName);
      const nextFirst = res.first_name ?? undefined;
      const nextLast = res.last_name ?? undefined;
      const updated = { ...profile, firstName: nextFirst, lastName: nextLast };
      setUserProfile(updated);
      setAccountData(prev => prev ? { ...prev, firstName: nextFirst ?? null, lastName: nextLast ?? null } : prev);
      await AsyncStorage.setItem('userProfile', JSON.stringify(updated));
      setNameStatus('Saved');
      setTimeout(() => setNameStatus(''), 2000);
    } catch (e: any) {
      Alert.alert('Name not saved', e?.message ?? 'Try again.');
    } finally {
      setAccountBusy(null);
    }
  };

  const handleSaveUsername = async () => {
    const nextUsername = usernameDraft.trim().toLowerCase();
    if (!nextUsername) {
      Alert.alert('Username not saved', 'Enter a username.');
      return;
    }
    if (nextUsername === (accountData?.username ?? '').toLowerCase()) {
      setUsernameDraft(accountData?.username ?? nextUsername);
      return;
    }
    setAccountBusy('username');
    setUsernameStatus('');
    try {
      const res = await updateUsername(token, nextUsername);
      const savedUsername = res.username;
      setAccountData(prev => prev ? { ...prev, username: savedUsername } : prev);
      setUsernameDraft(savedUsername);
      await AsyncStorage.setItem('user_username', savedUsername);
      try {
        const raw = await AsyncStorage.getItem(ACCOUNT_ME_CACHE_KEY);
        const cached = raw ? JSON.parse(raw) : null;
        if (cached?.token === token) {
          await AsyncStorage.setItem(ACCOUNT_ME_CACHE_KEY, JSON.stringify({
            ...cached,
            username: savedUsername,
            cachedAt: Date.now(),
          }));
        }
      } catch {}
      onUsernameChanged?.(savedUsername);
      setUsernameStatus('Saved');
      setTimeout(() => setUsernameStatus(''), 2000);
    } catch (e: any) {
      Alert.alert('Username not saved', e?.message ?? 'Try another username.');
    } finally {
      setAccountBusy(null);
    }
  };

  const ActionRow = ({
    label, desc, onPress, tone = 'default', busy = false, testID,
  }: {
    label: string;
    desc: string;
    onPress: () => void;
    tone?: 'default' | 'danger';
    busy?: boolean;
    testID?: string;
  }) => (
    <TouchableOpacity
      style={[am.securityRow, tone === 'danger' && { borderColor: tc.error + '66', backgroundColor: tc.error + '12' }]}
      onPress={onPress}
      disabled={busy}
      activeOpacity={0.8}
      testID={testID}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy, busy }}
    >
      <View style={{ flex: 1 }}>
        <Text style={[am.securityLabel, tone === 'danger' && { color: tc.error }]}>{label}</Text>
        <Text style={am.securityDesc}>{desc}</Text>
      </View>
      {busy ? <ActivityIndicator color={tc.primary} size="small" /> : <Text style={am.chevron}>›</Text>}
    </TouchableOpacity>
  );

  const handleSupport = () => {
    const subject = encodeURIComponent('Thallo support');
    Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=${subject}`).catch(() => {
      Alert.alert('Support', `Email ${SUPPORT_EMAIL} for help with your account, ${Platform.OS === 'ios' ? 'Watch sync, HealthKit,' : 'Health Connect,'} or app data.`);
    });
  };

  const handleExportData = async () => {
    setAccountBusy('export');
    try {
      const data = await exportAccountData(token);
      const { exportAccountDataJson } = await import('../src/utils/dataExport');
      await exportAccountDataJson(data, accountData?.username);
    } catch (e: any) {
      Alert.alert('Export failed', e?.message ?? 'Could not export account data.');
    } finally {
      setAccountBusy(null);
    }
  };

  const handleRequestEmailVerification = async () => {
    if (!accountData?.email) return;
    setAccountBusy('verify');
    try {
      await requestEmailVerification(accountData.email);
      Alert.alert(
        'Verification requested',
        'Check your inbox for the Thallo verification link.',
      );
    } catch (e: any) {
      Alert.alert('Could not request verification', e?.message ?? 'Try again later.');
    } finally {
      setAccountBusy(null);
    }
  };

  const applyBillingEntitlement = async (entitlement: Awaited<ReturnType<typeof syncRevenueCatEntitlement>>): Promise<UserProfile> => {
    const updated = { ...profile, ...billingEntitlementToProfilePatch(entitlement) };
    setUserProfile(updated);
    await AsyncStorage.setItem('userProfile', JSON.stringify(updated));
    return updated;
  };

  const applyServerBillingEntitlement = async (): Promise<UserProfile> => {
    return applyBillingEntitlement(await syncRevenueCatEntitlement(token));
  };

  const handleMockDowngrade = async () => {
    if (!token) return;
    setAccountBusy('billing');
    try {
      const { mockDowngrade } = await import('../src/services/api');
      await applyBillingEntitlement(await mockDowngrade(token));
      await clearAllPlanCache().catch(() => null);
      Alert.alert('Free active (test)', 'Dummy downgrade complete — you are on Free now.');
    } catch (e: any) {
      Alert.alert('Test downgrade failed', e?.message ?? 'Could not complete the dummy downgrade.');
    } finally {
      setAccountBusy(null);
    }
  };

  const resolveRevenueCatAppUserId = async (): Promise<string> => {
    if (profile.revenueCatAppUserId) return profile.revenueCatAppUserId;
    const updated = await applyServerBillingEntitlement();
    if (updated.revenueCatAppUserId) return updated.revenueCatAppUserId;
    throw new Error('Could not prepare your subscription account. Try again.');
  };

  const handleStartProSubscription = async () => {
    setAccountBusy('billing');
    try {
      const appUserId = await resolveRevenueCatAppUserId();
      const { purchaseProSubscription } = await import('../src/services/billing');
      const purchase = await purchaseProSubscription(appUserId);
      const updated = await applyServerBillingEntitlement();
      if (serverTierOf(updated) === 'pro') {
        await onUpgradeToPro(updated);
        Alert.alert('Pro active', 'Your Thallo Pro access is active.');
      } else if (purchase.isActive) {
        Alert.alert('Purchase complete', 'Your purchase succeeded. Thallo is waiting for the subscription webhook to finish syncing.');
      }
    } catch (e: any) {
      const message = String(e?.message ?? '');
      if (!message.toLowerCase().includes('cancel')) {
        Alert.alert('Subscription unavailable', message || 'Could not start the purchase flow.');
      }
    } finally {
      setAccountBusy(null);
    }
  };

  const handleRestorePurchases = async () => {
    setAccountBusy('restore');
    try {
      const appUserId = await resolveRevenueCatAppUserId();
      const { restoreRevenueCatPurchases } = await import('../src/services/billing');
      const restored = await restoreRevenueCatPurchases(appUserId);
      const updated = await applyServerBillingEntitlement();
      if (serverTierOf(updated) === 'pro') {
        await onUpgradeToPro(updated);
        Alert.alert('Purchases restored', 'Your Thallo Pro access is active.');
      } else {
        Alert.alert(
          'No active Pro subscription',
          restored.isActive
            ? 'RevenueCat found access, but the server has not received it yet. Try again in a moment.'
            : 'No active Pro subscription was found for this store account.',
        );
      }
    } catch (e: any) {
      Alert.alert('Restore unavailable', e?.message ?? 'Could not restore purchases.');
    } finally {
      setAccountBusy(null);
    }
  };

  const handleRefreshSubscription = async () => {
    setAccountBusy('billing-sync');
    try {
      const updated = await applyServerBillingEntitlement();
      Alert.alert('Subscription refreshed', subscriptionStatusLabel(updated));
    } catch (e: any) {
      Alert.alert('Refresh unavailable', e?.message ?? 'Could not refresh subscription status.');
    } finally {
      setAccountBusy(null);
    }
  };

  const handleManageStoreSubscription = async () => {
    setAccountBusy('billing-manage');
    try {
      const appUserId = await resolveRevenueCatAppUserId();
      const { openRevenueCatSubscriptionManagement } = await import('../src/services/billing');
      await openRevenueCatSubscriptionManagement(appUserId);
      const updated = await applyServerBillingEntitlement();
      Alert.alert('Subscription refreshed', subscriptionStatusLabel(updated));
    } catch (e: any) {
      Alert.alert('Subscription settings unavailable', e?.message ?? 'Could not open subscription settings.');
    } finally {
      setAccountBusy(null);
    }
  };

  const handleCancelSignupTrial = () => {
    Alert.alert(
      'Switch to Free now?',
      'This ends your signup trial immediately. Your logged workouts, meals, weight, and preferences stay in your account.',
      [
        { text: 'Stay Pro', style: 'cancel' },
        {
          text: 'Switch to Free',
          style: 'destructive',
          onPress: async () => {
            setAccountBusy('cancel-trial');
            try {
              const entitlement = await cancelSignupTrial(token);
              const updated = await applyBillingEntitlement(entitlement);
              await clearAllPlanCache().catch(() => null);
              Alert.alert('Free active', subscriptionStatusLabel(updated));
            } catch (e: any) {
              Alert.alert('Could not switch to Free', e?.message ?? 'Try again.');
            } finally {
              setAccountBusy(null);
            }
          },
        },
      ],
    );
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete account?',
      // Two-step confirmation. The first alert spells out exactly what
      // happens (retention window, irreversibility, data loss) — users
      // shouldn't tap-through a "are you sure" without seeing the cost.
      "This disables your login immediately, deletes app-created profile, workout, meal, weight, health, supplement, social, telemetry, and settings rows, and anonymizes account identifiers.\n\nAn anonymized account shell may remain for up to 30 days before hard deletion. Backups, logs, vendor records, and records needed for security, billing, fraud prevention, or moderation may follow separate retention schedules.\n\nExport your data first if you want a copy.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: () => {
            // Second confirmation — final guard so a thumb-misfire on
            // the first alert can't actually delete the account.
            Alert.alert(
              'Are you sure?',
              'This is permanent after 30 days. There is no undo.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete my account',
                  style: 'destructive',
                  onPress: async () => {
                    setAccountBusy('delete');
                    try {
                      await deleteAccount(token);
                      onClose();
                      onSignOut();
                    } catch (e: any) {
                      Alert.alert('Delete failed', e?.message ?? 'Could not delete account.');
                    } finally {
                      setAccountBusy(null);
                    }
                  },
                },
              ],
            );
          },
        },
      ],
    );
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={am.backdrop}>
        <TouchableOpacity
          style={StyleSheet.absoluteFill}
          activeOpacity={1}
          onPress={onClose}
          accessible={false}
        />
        <View
          testID="account-modal"
          accessibilityViewIsModal
          importantForAccessibility="yes"
          style={[am.sheet, { height: '85%', maxHeight: '85%' }]}>
          <BottomSheetDismissHandle
            onClose={onClose}
            color={tc.border}
            containerStyle={am.handleTap}
            handleStyle={am.handle}
          />
          <Text accessibilityRole="header" style={am.title}>Account</Text>

          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 16 }} showsVerticalScrollIndicator={false} bounces={false}>
          {/* Static profile data renders immediately. Only the rows that
              depend on the /me network call (email, username, verified,
              legal version) show a placeholder until getMe resolves —
              avoids the "blank modal then everything pops in" delay. */}
          <View style={am.infoSection}>
            <View style={am.nameBlock}>
              <Text style={am.rowLabel}>Name</Text>
              <View style={am.nameInputRow}>
                <TextInput
                  testID="account-first-name-input"
                  style={am.nameInput}
                  value={nameFirst}
                  onChangeText={(t) => { setNameFirst(t); setNameStatus(''); }}
                  onBlur={handleSaveName}
                  placeholder="First name"
                  placeholderTextColor={tc.textMuted}
                  autoCapitalize="words"
                  returnKeyType="next"
                />
                <TextInput
                  testID="account-last-name-input"
                  style={am.nameInput}
                  value={nameLast}
                  onChangeText={(t) => { setNameLast(t); setNameStatus(''); }}
                  onBlur={handleSaveName}
                  placeholder="Last name"
                  placeholderTextColor={tc.textMuted}
                  autoCapitalize="words"
                  returnKeyType="done"
                />
              </View>
              <View style={am.nameFooter}>
                <Text style={[am.nameStatus, nameStatus ? { color: tc.success } : null]}>
                  {nameStatus || 'Used for greetings and profile display.'}
                </Text>
                <TouchableOpacity
                  testID="account-name-save"
                  accessibilityRole="button"
                  accessibilityLabel="Save name"
                  accessibilityState={{ disabled: accountBusy === 'name', busy: accountBusy === 'name' }}
                  onPress={handleSaveName}
                  disabled={accountBusy === 'name'}
                  style={[am.nameSaveBtn, { opacity: accountBusy === 'name' ? 0.6 : 1 }]}
                >
                  {accountBusy === 'name'
                    ? <ActivityIndicator size="small" color={tc.background} />
                    : <Text style={am.nameSaveText}>Save</Text>}
                </TouchableOpacity>
              </View>
            </View>
            <Row label="Email"        value={accountData?.email ?? (loading ? 'Loading…' : '—')} testID="account-email-row" />
            <View style={am.nameBlock} testID="account-username-row">
              <Text style={am.rowLabel}>Username</Text>
              <TextInput
                testID="account-username-input"
                style={am.nameInput}
                value={usernameDraft || (loading ? 'Loading…' : '')}
                onChangeText={(t) => {
                  setUsernameDraft(t.replace(/\s/g, '').toLowerCase());
                  setUsernameStatus('');
                }}
                onBlur={handleSaveUsername}
                placeholder="username"
                placeholderTextColor={tc.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!loading}
                returnKeyType="done"
                onSubmitEditing={handleSaveUsername}
              />
              <View style={am.nameFooter}>
                <Text style={[am.nameStatus, usernameStatus ? { color: tc.success } : null]}>
                  {usernameStatus || 'Used as your friend-search handle.'}
                </Text>
                <TouchableOpacity
                  testID="account-username-save"
                  accessibilityRole="button"
                  accessibilityLabel="Save username"
                  accessibilityState={{ disabled: loading || accountBusy === 'username', busy: accountBusy === 'username' }}
                  onPress={handleSaveUsername}
                  disabled={loading || accountBusy === 'username'}
                  style={[am.nameSaveBtn, { opacity: loading || accountBusy === 'username' ? 0.6 : 1 }]}
                >
                  {accountBusy === 'username'
                    ? <ActivityIndicator size="small" color={tc.background} />
                    : <Text style={am.nameSaveText}>Save</Text>}
                </TouchableOpacity>
              </View>
            </View>
            {!betaFullAccess && (
              <Row label="Email Status" value={accountData ? (accountData.emailVerified ? 'Verified' : 'Not verified') : (loading ? 'Loading…' : '—')} testID="account-email-status-row" />
            )}
            <Row label="Legal Version" value={accountData ? (accountData.legalAccepted ? LEGAL_VERSION : 'Needs review') : (loading ? 'Loading…' : '—')} testID="account-legal-version-row" />
            <Row label="Goal"   value={goalValue} testID="account-goal-row" />
            <Row label="Weight" value={weightValue} testID="account-weight-row" />
            <Row label="Age"    value={ageValue} testID="account-age-row" />
            {!loading && !accountData && (
              <Text style={am.errorText}>Could not load full account info — tap retry by reopening.</Text>
            )}
          </View>

          <TouchableOpacity
            style={am.securityRow}
            onPress={() => setShowRecoveryModal(true)}
            testID="account-recovery-question"
            accessibilityRole="button"
            accessibilityLabel="Recovery question"
            accessibilityHint={hasRecoveryQuestion ? 'Set. Tap to change.' : 'Not set. Tap to set up password recovery.'}>
            <View style={{ flex: 1 }}>
              <Text style={am.securityLabel}>Recovery Question</Text>
              <Text style={am.securityDesc}>
                {hasRecoveryQuestion ? 'Set — tap to change' : 'Not set — lets you reset your password without email'}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {hasRecoveryQuestion
                ? <Text style={{ fontSize: 12, color: '#22C55E', fontWeight: '700' }}>✓</Text>
                : <Text style={{ fontSize: 12, color: tc.primary, fontWeight: '700' }}>Set up</Text>
              }
              <Text style={am.chevron}>›</Text>
            </View>
          </TouchableOpacity>

          {showRecoveryModal && (
            <RecoveryQuestionModal
              visible={showRecoveryModal}
              authToken={token}
              onDone={() => { setShowRecoveryModal(false); setHasRecoveryQuestion(true); }}
            />
          )}

          <ActionRow
            label="Legal & Safety"
            desc="Review Terms, Privacy, Health Disclaimer, and AI Disclosure."
            onPress={() => setShowLegal(true)}
            testID="account-legal-safety"
          />

          {!betaFullAccess && accountData && !accountData.emailVerified && (
            <ActionRow
              label="Verify Email"
              desc="Sends a verification link to your account email."
              onPress={handleRequestEmailVerification}
              busy={accountBusy === 'verify'}
              testID="account-verify-email"
            />
          )}

          {billingBetaEnabled && !betaFullAccess && (
            <>
              <ActionRow
                label={subscriptionActionStartsPurchase ? 'Start Pro Subscription' : 'Refresh Subscription'}
                desc={subscriptionActionStartsPurchase
                  ? 'Open the store purchase sheet. Trial pricing appears there when your store account is eligible.'
                  : 'Sync the latest store entitlement with Thallo.'}
                onPress={subscriptionActionStartsPurchase ? handleStartProSubscription : handleRefreshSubscription}
                busy={accountBusy === 'billing' || accountBusy === 'billing-sync'}
                testID={subscriptionActionStartsPurchase ? 'account-start-pro' : 'account-refresh-subscription'}
              />
              <ActionRow
                label="Restore Purchases"
                desc="Reconnect an existing App Store or Play Store subscription."
                onPress={handleRestorePurchases}
                busy={accountBusy === 'restore'}
                testID="account-restore-purchases"
              />
              {subscriptionCanManageStore && (
                <ActionRow
                  label="Cancel Store Subscription"
                  desc="Opens your store subscription settings. Free starts when the store entitlement ends."
                  onPress={handleManageStoreSubscription}
                  busy={accountBusy === 'billing-manage'}
                  testID="account-manage-subscription"
                />
              )}
            </>
          )}

          {dummyBillingEnabled && (
            subscriptionTier === 'pro' ? (
              <ActionRow
                label="Switch to Free Now (test)"
                desc="Immediate dummy downgrade — clears trial Pro for testing. No real billing."
                onPress={handleMockDowngrade}
                busy={accountBusy === 'billing'}
                testID="account-mock-downgrade"
              />
            ) : (
              <ActionRow
                label="Upgrade to Pro (test)"
                desc="Open the placeholder checkout. No real charge — for testing the Pro experience."
                onPress={() => setDummyPaymentOpen(true)}
                testID="account-mock-upgrade"
              />
            )
          )}

          {subscriptionCanCancelSignupTrial && !betaFullAccess && (
            <ActionRow
              label="Switch to Free Now"
              desc="Ends your signup trial immediately and keeps your account data."
              onPress={handleCancelSignupTrial}
              busy={accountBusy === 'cancel-trial'}
              testID="account-cancel-signup-trial"
            />
          )}

          <ActionRow
            label="Help & Support"
            desc={`Email ${SUPPORT_EMAIL} for account, ${Platform.OS === 'ios' ? 'Watch, HealthKit,' : 'Health Connect,'} or data help.`}
            onPress={handleSupport}
            testID="account-help-support"
          />

          {Platform.OS === 'ios' && (
            <ActionRow
              label="Apple Watch Sync"
              desc={watchStatus}
              onPress={() => Alert.alert('Apple Watch Sync', watchStatus)}
              testID="account-watch-sync"
            />
          )}

          <ActionRow
            label="Export Account Data"
            desc="Share a JSON export of your account, workouts, meals, health, and settings."
            onPress={handleExportData}
            busy={accountBusy === 'export'}
            testID="account-export-data"
          />

          <ActionRow
            label="Delete Account"
            desc="Disable login and anonymize account identifiers."
            onPress={handleDeleteAccount}
            tone="danger"
            busy={accountBusy === 'delete'}
            testID="account-delete"
          />

          {showLegal && (
            <LegalDisclosureModal
              visible={showLegal}
              onClose={() => setShowLegal(false)}
              themeColors={tc as any}
            />
          )}

          <DummyPaymentModal
            visible={dummyPaymentOpen}
            token={token}
            themeName={profile.themePreference}
            onClose={() => setDummyPaymentOpen(false)}
            onSuccess={async (entitlement) => {
              const updated = await applyBillingEntitlement(entitlement);
              if (serverTierOf(updated) === 'pro') {
                await onUpgradeToPro(updated);
              }
            }}
          />

          {/* Pro vs Free feature comparison modal — gated on showTierInfo
              so the heavy 100-line subtree doesn't mount eagerly while
              AccountInfoModal is opening. */}
          {showTierInfo && (
          <Modal visible={showTierInfo} transparent animationType="fade" onRequestClose={() => setShowTierInfo(false)}>
            <TouchableOpacity
              style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', padding: 20 }}
              activeOpacity={1}
              onPress={() => setShowTierInfo(false)}
            >
              <TouchableOpacity
                activeOpacity={1}
                onPress={() => {}}
                style={{
                  backgroundColor: tc.surface, borderRadius: 18, padding: 20,
                  width: '100%', maxWidth: 440, maxHeight: '85%',
                  borderWidth: 1, borderColor: tc.border,
                  // Flex constraints so the inner ScrollView can own remaining
                  // space between the header and Got-it button. Without these,
                  // the ScrollView sized itself to its intrinsic content and
                  // overflowed instead of scrolling.
                  flexShrink: 1,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
                  <Text style={{ fontSize: 20, fontWeight: '900', color: tc.textPrimary, flex: 1 }}>
                    What's in each tier
                  </Text>
                <TouchableOpacity
                  onPress={() => setShowTierInfo(false)}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  accessibilityRole="button"
                  accessibilityLabel="Close tier information">
                  <Text style={{ fontSize: 22, color: tc.textMuted }}>×</Text>
                </TouchableOpacity>
                </View>

                <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ paddingBottom: 8 }} showsVerticalScrollIndicator={true} bounces={true}>
                  {/* FREE tier */}
                  <View style={{ marginBottom: 18 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: tc.border, alignItems: 'center', justifyContent: 'center' }}>
                        <Ionicons name="person-outline" size={14} color={tc.textSecondary} />
                      </View>
                      <View>
                        <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary }}>Free</Text>
                        <Text style={{ fontSize: 11, color: tc.textMuted }}>Manual tracking and starter tools</Text>
                      </View>
                    </View>
                    {FREE_TIER_CAPABILITIES.map(({ icon, label }) => (
                      <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 }}>
                        <Ionicons name={icon as any} size={15} color={tc.textMuted} />
                        <Text style={{ fontSize: 13, color: tc.textSecondary }}>{label}</Text>
                      </View>
                    ))}
                  </View>

                  <View style={{ height: 1, backgroundColor: tc.border, marginBottom: 18 }} />

                  {/* PRO tier */}
                  <View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: tc.primary + '22', alignItems: 'center', justifyContent: 'center' }}>
                        <Ionicons name="diamond-outline" size={14} color={tc.primary} />
                      </View>
                      <View>
                        <Text style={{ fontSize: 14, fontWeight: '800', color: tc.primary }}>Pro</Text>
                        <Text style={{ fontSize: 11, color: tc.textMuted }}>Guided planning, AI help, and insights</Text>
                      </View>
                    </View>
                    <Text style={{ fontSize: 12, color: tc.textSecondary, marginBottom: 10, marginLeft: 36, lineHeight: 17 }}>
                      Everything in Free, plus:
                    </Text>
                    {PRO_TIER_CAPABILITIES.map(({ icon, label }) => (
                      <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 }}>
                        <Ionicons name={icon as any} size={15} color={tc.primary} />
                        <Text style={{ fontSize: 13, color: tc.textPrimary, flex: 1 }}>{label}</Text>
                      </View>
                    ))}
                  </View>
                </ScrollView>

                <TouchableOpacity
                  onPress={() => setShowTierInfo(false)}
                  accessibilityRole="button"
                  accessibilityLabel="Close tier information"
                  style={{
                    marginTop: 14, paddingVertical: 12, borderRadius: 10,
                    backgroundColor: tc.primary, alignItems: 'center',
                  }}
                >
                  <Text style={{ fontSize: 14, fontWeight: '800', color: tc.background }}>Got it</Text>
                </TouchableOpacity>
              </TouchableOpacity>
            </TouchableOpacity>
          </Modal>
          )}

          {betaFullAccess ? (
            <View style={{
              padding: 14, borderRadius: 12,
              backgroundColor: tc.primary + '16', borderWidth: 1, borderColor: tc.primary + '55',
            }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="flask-outline" size={16} color={tc.primary} />
                <Text style={{ fontSize: 10, fontWeight: '800', color: tc.primary, letterSpacing: 0.8, flex: 1 }}>
                  FREE BETA ACCESS
                </Text>
                <TouchableOpacity
                  onPress={() => setShowTierInfo(true)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityRole="button"
                  accessibilityLabel="What is included in beta access">
                  <Text style={{ fontSize: 11, fontWeight: '700', color: tc.primary }}>What's included?</Text>
                </TouchableOpacity>
              </View>
              <Text style={{ fontSize: 11, color: tc.textSecondary, marginTop: 8, lineHeight: 15 }}>
                All guided planning, AI, readiness, and {Platform.OS === 'ios' ? 'Watch' : 'Android phone'} features are unlocked during this beta.
              </Text>
            </View>
          ) : (
            <View style={{
              padding: 14, borderRadius: 12,
              backgroundColor: tc.surfaceRaised, borderWidth: 1, borderColor: tc.border,
            }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                <Text style={{ fontSize: 10, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.8, flex: 1 }}>
                  SUBSCRIPTION TIER
                </Text>
                <TouchableOpacity
                  onPress={() => setShowTierInfo(true)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityRole="button"
                  accessibilityLabel="What is included in each subscription tier">
                  <Text style={{ fontSize: 11, fontWeight: '700', color: tc.primary }}>What's included?</Text>
                </TouchableOpacity>
              </View>
              <View style={{
                paddingVertical: 10, borderRadius: 10,
                backgroundColor: subscriptionTier === 'pro' ? tc.primary : tc.surface,
                borderWidth: 1, borderColor: subscriptionTier === 'pro' ? tc.primary : tc.border,
                alignItems: 'center',
              }}>
                <Text style={{
                  fontSize: 13, fontWeight: '800', letterSpacing: 0.6,
                  color: subscriptionTier === 'pro' ? tc.background : tc.textSecondary,
                }}>
                  {subscriptionLabel.toUpperCase()}
                </Text>
              </View>
              <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 8, lineHeight: 15 }}>
                {subscriptionIsCancelledSignupTrial
                  ? trialEndsAtLabel
                    ? `Your signup trial is cancelled. Pro stays active until ${trialEndsAtLabel}, then your account switches to Free.`
                    : 'Your signup trial is cancelled. Pro stays active until the trial ends, then your account switches to Free.'
                  : isTrialing(profile)
                  ? billingBetaEnabled
                    ? `Your signup trial unlocks Pro features for ${SIGNUP_TRIAL_DAYS} days. Start a store subscription to keep Pro after the trial ends.`
                    : `Your signup trial unlocks Pro features for ${SIGNUP_TRIAL_DAYS} days.`
                  : subscriptionTier === 'free'
                  ? FREE_TIER_SUMMARY
                  : PRO_TIER_SUMMARY}
              </Text>
            </View>
          )}

          <TouchableOpacity
            style={am.signOutBtn}
            testID="account-sign-out"
            accessibilityRole="button"
            accessibilityLabel="Sign out"
            onPress={() => { onClose(); onSignOut(); }}>
            <Text style={am.signOutText}>Sign Out</Text>
          </TouchableOpacity>

          {/* Replay the post-onboarding tutorial. Fires the app-root
              TutorialOverlay directly via `onShowTutorial` — no flag
              clear, no navigation step, no "go back to the home tab"
              prompt. The overlay opens right where the user is. */}
          {onShowTutorial && (
            <TouchableOpacity
              testID="account-show-tutorial"
              accessibilityRole="button"
              accessibilityLabel="Show tutorial again"
              onPress={() => onShowTutorial()}
              style={{ marginTop: 8, alignItems: 'center', paddingVertical: 8 }}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: c.textMuted, letterSpacing: 0.5 }}>
                Show tutorial again
              </Text>
            </TouchableOpacity>
          )}

          {onStartLiveTutorial && (
            <TouchableOpacity
              testID="account-start-live-tutorial"
              accessibilityRole="button"
              accessibilityLabel="Start live tutorial"
              onPress={() => onStartLiveTutorial()}
              style={{ marginTop: 2, alignItems: 'center', paddingVertical: 8 }}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: c.textMuted, letterSpacing: 0.5 }}>
                Start live tutorial
              </Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            onPress={onClose}
            testID="account-close"
            accessibilityRole="button"
            accessibilityLabel="Close account"
            style={am.closeBtn}>
            <Text style={am.closeText}>Close</Text>
          </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
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
  handleTap: { minHeight: 24, marginTop: -12, marginBottom: -8 },
  handle:  { width: 36, height: 4, borderRadius: 2 },
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
  nameBlock: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    gap: 10,
  },
  nameInputRow: { flexDirection: 'row', gap: 10 },
  nameInput: {
    flex: 1,
    minHeight: 42,
    paddingHorizontal: 12,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
    color: c.textPrimary,
    fontSize: 14,
    fontWeight: '400',
    letterSpacing: 0,
  },
  nameFooter: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  nameStatus: { flex: 1, fontSize: 11, color: c.textMuted, lineHeight: 15 },
  nameSaveBtn: {
    minWidth: 64,
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.primary,
  },
  nameSaveText: { fontSize: 12, fontWeight: '800', color: c.background },

  errorText: { fontSize: 13, color: c.error, padding: 16 },

  securityRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: c.surfaceRaised, borderRadius: radius.md,
    padding: 16, borderWidth: 1, borderColor: c.border,
  },
  securityLabel: { fontSize: 14, fontWeight: '700', color: c.textPrimary, marginBottom: 3 },
  securityDesc: { fontSize: 11, color: c.textSecondary, lineHeight: 16 },
  chevron: { fontSize: 20, color: c.textMuted },

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
