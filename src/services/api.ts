import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { goalCategory } from '../constants/goalConfig';
import { effectiveAge } from '../utils/age';
import { resolveApiBaseUrl } from '../utils/apiBaseUrl';
import { normalizeSunExposurePreferences } from '../utils/sunExposure';
import { STORAGE_KEYS } from '../utils/storageKeys.ts';
import type {
  AreaSunContext,
  CustomExerciseItem,
  ManualActivityDetails,
  SunExposureCorrectionOption,
  SunExposureDailySummary,
  SunExposurePreferences,
  SunExposureSegment,
  SubscriptionStatus,
  SubscriptionTier,
  WorkoutDay,
} from '../types';
import type {
  ContextAwareInsight,
  ContextInsightsResponse,
  DailyInsightAction,
  HealthInsightsResponse,
  UserInsightPreferences,
} from '../types/insights';
import { customExerciseFromApi, customExerciseToApiPayload } from '../utils/customExercises';

/** Exported for callers that need to hit the API outside the `request`
 *  helper (e.g. direct `fetch` for endpoints that return binary/large
 *  payloads). Same resolution logic — dev override → Expo host → prod URL. */
export function getApiBaseUrl(): string {
  return getBaseUrl();
}

function getBaseUrl(): string {
  return resolveApiBaseUrl({
    configured: (Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined)?.apiBaseUrl,
    devOverride: process.env.EXPO_PUBLIC_API_URL,
    hostUri: Constants.expoConfig?.hostUri,
    isDev: __DEV__,
    isDevice: (Constants as { isDevice?: boolean }).isDevice === true,
    platform: Platform.OS,
  });
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export type BillingEntitlement = {
  subscription_tier: SubscriptionTier | string;
  subscription_status?: string | null;
  subscription_source?: string | null;
  subscription_product_id?: string | null;
  subscription_entitlement_id?: string | null;
  subscription_store?: string | null;
  subscription_environment?: string | null;
  subscription_expires_at?: string | null;
  trial_started_at?: string | null;
  trial_ends_at?: string | null;
  revenuecat_app_user_id?: string | null;
};

const SUBSCRIPTION_STATUSES = new Set<SubscriptionStatus>([
  'free',
  'trialing',
  'trial_cancelled',
  'active',
  'grace_period',
  'cancelled',
  'expired',
  'revoked',
  'billing_issue',
  'beta',
  'promotional',
  'temporary',
]);

function normalizeSubscriptionTier(value: unknown): SubscriptionTier {
  return String(value ?? '').toLowerCase() === 'pro' ? 'pro' : 'free';
}

function normalizeSubscriptionStatus(value: unknown): SubscriptionStatus | undefined {
  if (value == null || value === '') return undefined;
  const status = String(value).trim().toLowerCase();
  return SUBSCRIPTION_STATUSES.has(status as SubscriptionStatus) ? (status as SubscriptionStatus) : 'free';
}

let unauthorizedHandler: ((path: string) => void) | null = null;
let unauthorizedFired = false;

/** Register a global handler invoked once when an authenticated request
 *  returns 401. Used by `app/index.tsx` to drop local auth state and
 *  bounce the user to the sign-in screen. Without it, every screen's
 *  `.catch` swallows the 401 into an empty state, which is
 *  indistinguishable from "you have no data". */
export function setUnauthorizedHandler(fn: ((path: string) => void) | null): void {
  unauthorizedHandler = fn;
  unauthorizedFired = false;
}

function requestMethod(options: RequestInit = {}): string {
  return String(options.method ?? 'GET').toUpperCase();
}

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

async function request<T>(path: string, options: RequestInit = {}, timeoutMs = 30000, noRetry = false, retrySafe = false): Promise<T> {
  const method = requestMethod(options);
  // Never auto-retry a write that lacks an idempotency key. If the server
  // already applied it but the response was slow/dropped, retrying would
  // insert a DUPLICATE — the root cause of duplicated meal logs and routines.
  // GET/HEAD are always retry-safe; writes retry only when the body carries a
  // non-null idempotency_key the backend can dedupe on.
  const isWrite = method !== 'GET' && method !== 'HEAD';
  const bodyStr = typeof options.body === 'string' ? options.body : '';
  const hasIdempotencyKey = /"idempotency_key"\s*:\s*"[^"]/.test(bodyStr);
  // `retrySafe` lets read-only POSTs (AI scans, lookups) keep retries: they
  // mutate no user data, so a retry on a slow/dropped response is safe and
  // important for reliability over flaky networks. Without it, the
  // idempotency guard above would disable retries for these long vision calls.
  const maxRetries = (noRetry || (isWrite && !hasIdempotencyKey && !retrySafe)) ? 0 : 2;
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

      // Backend answered — even if 4xx — so we're reachable. The
      // online-status bus uses this to flip back from offline → online
      // the moment a real fetch lands, in addition to the heartbeat.
      try {
        const { markRequestOutcome } = require('../hooks/useOnlineStatus');
        markRequestOutcome(true);
      } catch { /* hook lookup is best-effort; never break the request */ }

      // 401 on an authenticated call = token expired / revoked. Notify
      // the registered handler ONCE per session so the app can drop
      // local auth state and bounce to sign-in. Fire-and-throw — don't
      // retry, a bad token won't fix itself. Anonymous calls (no
      // Authorization header) shouldn't trigger sign-out: a 401 there
      // means the endpoint requires auth and the caller forgot it.
      if (res.status === 401 && tokenFromHeaders(options.headers)) {
        if (!unauthorizedFired && unauthorizedHandler) {
          unauthorizedFired = true;
          try { unauthorizedHandler(path); } catch {}
        }
        recordTelemetryEvent('api_unauthorized', { path }, tokenFromHeaders(options.headers));
        throw new Error('session_expired');
      }

      // Empty-body responses (204 No Content, or anything sent without a
      // Content-Length / explicit empty body) can't be JSON-parsed —
      // calling `res.json()` on them throws `SyntaxError: Unexpected end
      // of JSON input`. The original implementation called .json()
      // unconditionally, which silently broke every DELETE endpoint
      // returning 204 (delete_meal, delete_gear, etc.). Detect those
      // cases first and resolve with `undefined` cast to T — callers
      // typing the result as `void` get a clean no-op.
      const contentLength = res.headers.get('Content-Length');
      const isEmptyBody = res.status === 204
        || res.status === 205
        || contentLength === '0';
      if (isEmptyBody) {
        if (!res.ok) {
          recordTelemetryEvent('api_error', { path, status: res.status, detail: `HTTP ${res.status}` }, tokenFromHeaders(options.headers));
          throw new Error(`HTTP ${res.status}`);
        }
        invalidateReadCacheAfterMutation(method, path, tokenFromHeaders(options.headers));
        return undefined as unknown as T;
      }

      // Some servers reply with an empty 200 body too (rare but possible).
      // Try to parse, fall back to undefined on parse error so a void
      // helper doesn't crash on a payload-less success.
      const text = await res.text();
      let data: any = null;
      if (text.length > 0) {
        try { data = JSON.parse(text); }
        catch {
          if (res.ok) return undefined as unknown as T;
          recordTelemetryEvent('api_error', { path, status: res.status, detail: 'invalid_json' }, tokenFromHeaders(options.headers));
          throw new Error(`HTTP ${res.status}`);
        }
      }
      if (!res.ok) {
        const detail = Array.isArray(data?.detail)
          ? data.detail.map((e: any) => `${e.loc?.join('.')}: ${e.msg}`).join(', ')
          : (typeof data?.detail === 'string' ? data.detail : `HTTP ${res.status}`);
        recordTelemetryEvent('api_error', { path, status: res.status, detail }, tokenFromHeaders(options.headers));
        throw new Error(detail);
      }
      invalidateReadCacheAfterMutation(method, path, tokenFromHeaders(options.headers));
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
        try {
          const { markRequestOutcome } = require('../hooks/useOnlineStatus');
          markRequestOutcome(false, e);
        } catch { /* best-effort */ }
        if (attempt < maxRetries) continue;
        throw lastError;
      }
      throw e;
    }
  }
  throw lastError ?? new Error('Request failed');
}

const readInflight = new Map<string, Promise<any>>();
const readCache = new Map<string, { expiresAt: number; value: any }>();
let readCacheEpoch = 0;
let legacyPersistentReadCacheCleanup: Promise<void> | null = null;

function cacheScopeFromToken(token?: string): string {
  if (!token) return 'anon';
  // Non-cryptographic namespace hash: good enough to partition cache keys
  // without writing bearer tokens into AsyncStorage key names.
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `u_${(hash >>> 0).toString(36)}`;
}

// Read-cache domains a given mutation should bust. Meal writes invalidate meal
// reads plus readiness, whose nutrition pillar depends on logged intake.
// Heavier AI/profile/lifestyle surfaces can refresh on their own cadence; tying
// them to every checkbox tap made meal logging feel frozen.
function invalidationPrefixesForPath(path: string): string[] {
  const seg = '/' + (path.replace(/^\/+/, '').split(/[/?#]/)[0] || '');
  switch (seg) {
    case '/meals':
      return ['/meals', '/readiness'];
    case '/workouts':
      return ['/workouts', '/profile', '/readiness', '/ai'];
    case '/lifestyle':
      return ['/lifestyle', '/readiness', '/profile', '/meals'];
    default:
      return [seg];
  }
}

function invalidateReadCacheAfterMutation(method: string, path: string, token?: string): void {
  if (method === 'GET' || method === 'HEAD') return;
  readCacheEpoch += 1;
  const scope = token != null ? `${cacheScopeFromToken(token)}::` : null;
  const prefixes = invalidationPrefixesForPath(path);
  const affected = (key: string): boolean => {
    if (scope && !key.startsWith(scope)) return false;
    const pathPart = scope ? key.slice(scope.length) : key.replace(/^[^:]*::/, '');
    return prefixes.some(p => pathPart.startsWith(p));
  };
  for (const key of Array.from(readCache.keys())) {
    if (affected(key)) readCache.delete(key);
  }
  for (const key of Array.from(readInflight.keys())) {
    if (affected(key)) readInflight.delete(key);
  }
  // Persistent layer clear stays broad but is non-blocking/background, so it
  // never contributes to the foreground refetch storm.
  void clearPersistentReadCache(scope);
}

function readRequestKey(path: string, options: RequestInit = {}): string | null {
  const method = requestMethod(options);
  if (method !== 'GET') return null;
  return `${cacheScopeFromToken(tokenFromHeaders(options.headers))}::${path}`;
}

// ── Persistent SWR cache layer ────────────────────────────────────────────
//
// Survives app kill so cold-start screens render from cache instead of
// stalling on a 30s network call. When a `requestRead` consumer's
// in-memory cache misses but persistent cache has a fresh-enough entry,
// we race the network fetch against a soft timeout (~4s); if the
// network is slow, we return the cached value immediately and let the
// fetch keep running in the background to refresh the cache for the
// NEXT call. Result: every GET endpoint gets stale-while-revalidate
// behavior automatically.
//
// Keyed by `${hash(token)}::${path}` so multi-user scenarios stay scoped
// without storing auth/session tokens in AsyncStorage key names.
// Wiped on sign-out via the persistent-key prefix list in
// app/index.tsx (USER_SCOPED_KEYS).
const PERSISTENT_READ_CACHE_PREFIX = STORAGE_KEYS.cache.readCachePrefix;
const PERSISTENT_READ_CACHE_INDEX_KEY = STORAGE_KEYS.cache.readCacheIndex;
const LEGACY_PERSISTENT_READ_CACHE_PREFIX = STORAGE_KEYS.cache.legacyReadCachePrefix;
const LEGACY_PERSISTENT_READ_CACHE_INDEX_KEY = STORAGE_KEYS.cache.legacyReadCacheIndex;
const PERSISTENT_TTL_MS = 24 * 60 * 60 * 1000;       // 24h
const SOFT_TIMEOUT_MS = 4000;                          // race-fallback to cache

interface PersistedReadEntry {
  value: any;
  storedAt: number;
}

function cleanupLegacyPersistentReadCache(): Promise<void> {
  if (!legacyPersistentReadCacheCleanup) {
    legacyPersistentReadCacheCleanup = (async () => {
      try {
        const keys = await AsyncStorage.getAllKeys();
        const legacyKeys = keys.filter(key => key.startsWith(LEGACY_PERSISTENT_READ_CACHE_PREFIX));
        if (legacyKeys.length > 0) await AsyncStorage.multiRemove(legacyKeys);
        await AsyncStorage.removeItem(LEGACY_PERSISTENT_READ_CACHE_INDEX_KEY);
      } catch {
        /* non-fatal — old cache entries expire by prefix wipe on sign-out */
      }
    })();
  }
  return legacyPersistentReadCacheCleanup;
}

async function loadPersistentRead<T>(key: string): Promise<PersistedReadEntry | null> {
  try {
    void cleanupLegacyPersistentReadCache();
    const raw = await AsyncStorage.getItem(PERSISTENT_READ_CACHE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedReadEntry;
    if (!parsed || typeof parsed.storedAt !== 'number') return null;
    if (Date.now() - parsed.storedAt > PERSISTENT_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function savePersistentRead(key: string, value: any): Promise<void> {
  try {
    void cleanupLegacyPersistentReadCache();
    await AsyncStorage.setItem(
      PERSISTENT_READ_CACHE_PREFIX + key,
      JSON.stringify({ value, storedAt: Date.now() } satisfies PersistedReadEntry),
    );
    // Track the keys we've written so the wipe path can find them
    // without scanning the whole AsyncStorage keyspace.
    const indexRaw = await AsyncStorage.getItem(PERSISTENT_READ_CACHE_INDEX_KEY);
    const idx: string[] = indexRaw ? JSON.parse(indexRaw) : [];
    if (!idx.includes(key)) {
      idx.push(key);
      await AsyncStorage.setItem(PERSISTENT_READ_CACHE_INDEX_KEY, JSON.stringify(idx));
    }
  } catch {
    /* non-fatal — caching is opportunistic */
  }
}

async function clearPersistentReadCache(tokenPrefix: string | null): Promise<void> {
  try {
    const indexRaw = await AsyncStorage.getItem(PERSISTENT_READ_CACHE_INDEX_KEY);
    if (!indexRaw) return;
    const idx: string[] = JSON.parse(indexRaw);
    const toRemove = tokenPrefix
      ? idx.filter(k => k.startsWith(tokenPrefix))
      : idx;
    if (toRemove.length === 0) return;
    await AsyncStorage.multiRemove(toRemove.map(k => PERSISTENT_READ_CACHE_PREFIX + k));
    if (tokenPrefix) {
      const remaining = idx.filter(k => !k.startsWith(tokenPrefix));
      await AsyncStorage.setItem(PERSISTENT_READ_CACHE_INDEX_KEY, JSON.stringify(remaining));
    } else {
      await AsyncStorage.removeItem(PERSISTENT_READ_CACHE_INDEX_KEY);
    }
  } catch {
    /* non-fatal */
  }
}

/** Wipe the persistent read cache. Called from the app-level
 *  sign-out + user-switch paths so a different user signing in on
 *  the same device never sees the prior user's responses. */
export async function clearAllPersistentReadCache(): Promise<void> {
  readCacheEpoch += 1;
  readCache.clear();
  readInflight.clear();
  await clearPersistentReadCache(null);
}

async function requestRead<T>(
  path: string,
  options: RequestInit = {},
  timeoutMs = 30000,
  ttlMs = 15000,
  softTimeoutMs: number | null = SOFT_TIMEOUT_MS,
): Promise<T> {
  const key = readRequestKey(path, options);
  if (!key) return request<T>(path, options, timeoutMs);

  // Layer 1 — in-memory cache (fastest, session-lifetime).
  const cached = readCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value as T;

  // Layer 2 — in-flight dedupe.
  const existing = readInflight.get(key);
  if (existing) return existing as Promise<T>;

  // Kick off the network fetch + cache write.
  const startedEpoch = readCacheEpoch;
  const networkPromise = request<T>(path, options, timeoutMs)
    .then(value => {
      if (readCacheEpoch === startedEpoch) {
        readCache.set(key, { value, expiresAt: Date.now() + ttlMs });
        // Persist for next cold start. Fire-and-forget.
        void savePersistentRead(key, value);
      }
      return value;
    })
    .finally(() => {
      readInflight.delete(key);
    });
  readInflight.set(key, networkPromise);

  if (softTimeoutMs == null) {
    return await networkPromise;
  }

  // Layer 3 — race(network, soft timeout). If the network hasn't
  // resolved within the configured soft timeout AND we have a persistent cache
  // entry, return the cached value immediately. The network fetch
  // keeps running and will refresh the cache for the next call.
  // No persistent cache → wait the full timeout for the network.
  const softTimeoutSentinel = Symbol('soft-timeout');
  let softTimer: ReturnType<typeof setTimeout> | null = null;
  const softRace = new Promise<symbol>(resolve => {
    softTimer = setTimeout(() => resolve(softTimeoutSentinel), Math.max(0, softTimeoutMs));
  });
  try {
    const winner = await Promise.race([networkPromise, softRace]);
    if (softTimer) clearTimeout(softTimer);
    if (winner === softTimeoutSentinel) {
      const persisted = await loadPersistentRead<T>(key);
      if (persisted) {
        // Promote to in-memory so subsequent calls within the TTL
        // window skip the persistent read.
        readCache.set(key, { value: persisted.value, expiresAt: Date.now() + ttlMs });
        return persisted.value as T;
      }
      // No persistent cache — fall through and keep waiting on the
      // network up to its hard timeout.
      return await networkPromise;
    }
    return winner as T;
  } catch (e) {
    if (softTimer) clearTimeout(softTimer);
    // Network errored — if we have a persistent cache, prefer it
    // over throwing. Better to render stale data than break the UI.
    const persisted = await loadPersistentRead<T>(key);
    if (persisted) {
      readCache.set(key, { value: persisted.value, expiresAt: Date.now() + ttlMs });
      return persisted.value as T;
    }
    throw e;
  }
}

type ListWindowOptions = {
  limit?: number;
  skip?: number;
  since?: string | null;
  before?: string | null;
  fresh?: boolean;
  timeoutMs?: number;
  noRetry?: boolean;
};

function normalizeWindowOptions(input: number | ListWindowOptions | undefined, defaultLimit: number): Required<Pick<ListWindowOptions, 'limit' | 'skip'>> & Pick<ListWindowOptions, 'since' | 'before'> {
  if (typeof input === 'number') return { limit: input, skip: 0, since: null, before: null };
  return {
    limit: input?.limit ?? defaultLimit,
    skip: input?.skip ?? 0,
    since: input?.since ?? null,
    before: input?.before ?? null,
  };
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
      accepted_terms: opts?.acceptedTerms === true,
      accepted_privacy: opts?.acceptedPrivacy === true,
      accepted_health_disclaimer: opts?.acceptedHealthDisclaimer === true,
      accepted_ai_disclaimer: opts?.acceptedAiDisclaimer === true,
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

export async function loginWithApple(
  identityToken: string,
  opts?: {
    firstName?: string | null;
    lastName?: string | null;
    legalVersion?: string;
    acceptedTerms?: boolean;
    acceptedPrivacy?: boolean;
    acceptedHealthDisclaimer?: boolean;
    acceptedAiDisclaimer?: boolean;
  },
): Promise<{ access_token: string; is_new_user: boolean }> {
  const result = await request<{ access_token: string; is_new_user: boolean }>('/auth/apple', {
    method: 'POST',
    body: JSON.stringify({
      identity_token: identityToken,
      first_name: opts?.firstName ?? undefined,
      last_name: opts?.lastName ?? undefined,
      legal_version: opts?.legalVersion,
      accepted_terms: opts?.acceptedTerms === true,
      accepted_privacy: opts?.acceptedPrivacy === true,
      accepted_health_disclaimer: opts?.acceptedHealthDisclaimer === true,
      accepted_ai_disclaimer: opts?.acceptedAiDisclaimer === true,
    }),
  });
  recordTelemetryEvent('apple_login_completed', { is_new_user: result.is_new_user }, result.access_token);
  return result;
}

export async function loginWithGoogle(
  identityToken: string,
  opts?: {
    firstName?: string | null;
    lastName?: string | null;
    legalVersion?: string;
    acceptedTerms?: boolean;
    acceptedPrivacy?: boolean;
    acceptedHealthDisclaimer?: boolean;
    acceptedAiDisclaimer?: boolean;
  },
): Promise<{ access_token: string; is_new_user: boolean }> {
  const result = await request<{ access_token: string; is_new_user: boolean }>('/auth/google', {
    method: 'POST',
    body: JSON.stringify({
      identity_token: identityToken,
      first_name: opts?.firstName ?? undefined,
      last_name: opts?.lastName ?? undefined,
      legal_version: opts?.legalVersion,
      accepted_terms: opts?.acceptedTerms === true,
      accepted_privacy: opts?.acceptedPrivacy === true,
      accepted_health_disclaimer: opts?.acceptedHealthDisclaimer === true,
      accepted_ai_disclaimer: opts?.acceptedAiDisclaimer === true,
    }),
  });
  recordTelemetryEvent('google_login_completed', { is_new_user: result.is_new_user }, result.access_token);
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

export async function getMe(
  token: string,
  opts: { timeoutMs?: number; noRetry?: boolean } = {},
) {
  return request('/auth/me', {
    headers: { Authorization: `Bearer ${token}` },
  }, opts.timeoutMs ?? 30000, opts.noRetry ?? false);
}

export type WatchTokenResponse = {
  access_token: string;
  token_type: 'bearer' | string;
  expires_at: string;
  api_base_url: string;
  user_id: number;
};

export async function issueWatchToken(
  token: string,
  body: { device_id?: string; app_version?: string } = {},
): Promise<WatchTokenResponse> {
  return request<WatchTokenResponse>('/auth/watch-token', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export async function getBillingEntitlement(token: string): Promise<BillingEntitlement> {
  return request<BillingEntitlement>('/billing/entitlement', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function syncRevenueCatEntitlement(token: string): Promise<BillingEntitlement> {
  return request<BillingEntitlement>('/billing/revenuecat/sync', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function cancelSignupTrial(token: string): Promise<BillingEntitlement> {
  return request<BillingEntitlement>('/billing/signup-trial/cancel', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** DUMMY test billing — grants Pro with no real payment. Backend is gated by
 *  DUMMY_BILLING_ENABLED so this 403s in any environment where it's off. */
export async function mockCheckout(token: string): Promise<BillingEntitlement> {
  return request<BillingEntitlement>('/billing/mock-checkout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** DUMMY test billing — drops the user back to Free. */
export async function mockDowngrade(token: string): Promise<BillingEntitlement> {
  return request<BillingEntitlement>('/billing/mock-downgrade', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function billingEntitlementToProfilePatch(entitlement: BillingEntitlement): Partial<import('../types').UserProfile> {
  return {
    subscriptionTier: normalizeSubscriptionTier(entitlement.subscription_tier),
    subscriptionStatus: normalizeSubscriptionStatus(entitlement.subscription_status),
    subscriptionSource: entitlement.subscription_source ?? undefined,
    subscriptionProductId: entitlement.subscription_product_id ?? undefined,
    subscriptionEntitlementId: entitlement.subscription_entitlement_id ?? undefined,
    subscriptionStore: entitlement.subscription_store ?? undefined,
    subscriptionEnvironment: entitlement.subscription_environment ?? undefined,
    subscriptionExpiresAt: entitlement.subscription_expires_at ?? undefined,
    trialStartedAt: entitlement.trial_started_at ?? undefined,
    trialEndsAt: entitlement.trial_ends_at ?? undefined,
    revenueCatAppUserId: entitlement.revenuecat_app_user_id ?? undefined,
  };
}

export async function updateEmail(token: string, email: string) {
  return request<{ email: string }>('/auth/update-email', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ email }),
  });
}

export async function updateUsername(token: string, username: string): Promise<{ username: string }> {
  return request<{ username: string }>('/auth/update-username', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ username }),
  });
}

export async function getMyProfile(token: string): Promise<import('../types').UserProfile | null> {
  try {
    const data = await request<any>('/profile/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const goalTrack = data.goal.goal_track ?? data.goal.goal_type;
    const birthdate = data.profile.birthdate ?? undefined;
    const age = effectiveAge({ birthdate, age: data.profile.age });
    const weightEntries = Array.isArray(data.weight_entries)
      ? data.weight_entries
        .map((entry: any) => ({
          date: String(entry.date ?? '').slice(0, 10),
          weight_lbs: Math.round(Number(entry.weight_lbs) * 10) / 10,
          source: entry.source ?? 'manual',
          logged_at: entry.logged_at ?? undefined,
        }))
        .filter((entry: any) => entry.date && Number.isFinite(entry.weight_lbs) && entry.weight_lbs > 0)
      : undefined;
    const latestWeightEntry = weightEntries?.length
      ? [...weightEntries].sort((a: any, b: any) =>
          String(a.logged_at ?? a.date).localeCompare(String(b.logged_at ?? b.date)),
        )[weightEntries.length - 1]
      : null;
    const currentWeightLbs = latestWeightEntry?.weight_lbs ?? data.profile.weight_lbs;
    const trainingDays = Array.isArray(data.preferences.training_day_pattern)
      ? [...new Set(data.preferences.training_day_pattern)]
          .map(d => Number(d))
          .filter(d => Number.isInteger(d) && d >= 0 && d <= 6)
          .map(d => (d + 1) % 7)
          .sort((a, b) => a - b)
      : undefined;
    // Map backend snake_case → frontend UserProfile shape
    return {
      firstName:  data.first_name ?? undefined,
      lastName:   data.last_name ?? undefined,
      avatarUrl:  data.social_profile?.avatar_url ?? undefined,
      subscriptionTier: normalizeSubscriptionTier(data.subscription_tier),
      subscriptionStatus: normalizeSubscriptionStatus(data.subscription_status),
      subscriptionSource: data.subscription_source ?? undefined,
      subscriptionProductId: data.subscription_product_id ?? undefined,
      subscriptionEntitlementId: data.subscription_entitlement_id ?? undefined,
      subscriptionStore: data.subscription_store ?? undefined,
      subscriptionEnvironment: data.subscription_environment ?? undefined,
      subscriptionExpiresAt: data.subscription_expires_at ?? undefined,
      trialStartedAt: data.trial_started_at ?? undefined,
      trialEndsAt: data.trial_ends_at ?? undefined,
      revenueCatAppUserId: data.revenuecat_app_user_id ?? undefined,
      goal:       goalTrack,
      goalDetails: {
        pace:             data.goal.pace,
        targetWeightLbs:  data.goal.target_weight_lbs ?? undefined,
        timelineWeeks:    data.goal.timeline_weeks ?? undefined,
        startWeightLbs:   data.goal.start_weight_lbs ?? undefined,
        startBodyFatPct:  data.goal.start_body_fat_pct ?? undefined,
        goalStartedAt:    data.goal.created_at ?? undefined,
      },
      physicalStats: {
        weightLbs:    currentWeightLbs,
        heightFeet:   data.profile.height_feet,
        heightInches: data.profile.height_inches,
        age:          age ?? data.profile.age,
        birthdate:    birthdate,
        gender:       data.profile.gender,
      },
      daysPerWeek:            data.preferences.days_per_week,
      trainingDays:           trainingDays?.length === data.preferences.days_per_week ? trainingDays : undefined,
      workoutDurationMinutes: data.preferences.workout_duration_minutes ?? 60,
      preferredSplit:         data.preferences.preferred_split ?? undefined,
      equipment:              data.preferences.equipment ?? [],
      equipmentSettings:      data.preferences.equipment_settings ?? undefined,
      experienceLevel:        data.preferences.experience_level ?? undefined,
      strengthBaselines:      data.preferences.strength_baselines ?? undefined,
      cardioBaseline:         data.preferences.cardio_baseline ?? undefined,
      foodsAvailable:         data.preferences.foods_available ?? [],
      pendingImports:         Array.isArray(data.preferences.pending_imports) ? data.preferences.pending_imports : [],
      sunExposurePreferences:  normalizeSunExposurePreferences(data.preferences.sun_exposure_preferences),
      glp1Support:            data.preferences.glp1_support ?? undefined,
      workoutManualMode:      Boolean(data.preferences.workout_manual_mode),
      mealManualMode:         Boolean(data.preferences.meal_manual_mode),
      customMacros:           data.preferences.custom_macros ?? undefined,
      customFoods:            [],
      customExercises:        (Array.isArray(data.custom_exercises) ? data.custom_exercises : [])
        .map(customExerciseFromApi)
        .filter(Boolean) as CustomExerciseItem[],
      savedMeals:             [],
      weightEntries,
      weightHistory: weightEntries?.map((entry: any) => ({
        date: entry.date,
        weightLbs: entry.weight_lbs,
        source: entry.source,
        loggedAt: entry.logged_at,
      })),
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
 *    2. Avoid recreating routine-owned slots in generated meal concepts.
 *
 *  `routineSlots` preserves the routine meal type labels when available
 *  so generation can avoid duplicating those concepts.
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
    const slots = routines.map((r, i) => {
      const slot = String(r.mealType ?? '').trim().toLowerCase();
      return ['breakfast', 'lunch', 'dinner', 'snack'].includes(slot) ? slot : `routine_${i}`;
    });
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
  options?: { includeNutritionSupports?: boolean },
): string | undefined {
  const parts: string[] = [];
  // Onboarding context — what the user said they last trained at signup
  if (profile.lastWorkoutContext) {
    parts.push(`User's recent activity (from sign-up): ${profile.lastWorkoutContext}`);
  }
  if (options?.includeNutritionSupports && profile.glp1Support?.enabled) {
    const appetite = profile.glp1Support.appetite?.replace(/_/g, ' ') ?? 'normal';
    const sideEffects = (profile.glp1Support.sideEffects ?? []).map(s => s.replace(/_/g, ' '));
    parts.push([
      `GLP-1 support mode is enabled. User reports ${appetite} appetite${sideEffects.length ? ` and wants support for ${sideEffects.join(', ')}` : ''}.`,
      'Nutrition guidance should prioritize smaller protein-forward meals, hydration, gentle fiber, and lean-mass preservation through adequate protein and strength training.',
      'Do not provide medication, dose, or prescribing advice; suggest contacting their clinician for severe or persistent symptoms.',
    ].join(' '));
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

/**
 * Severity-aware structured payload for the planner. Sent alongside the
 * legacy `buildInjuries()` flat strings so the backend can preserve
 * backwards compatibility (older builds and the substring fallback in
 * `_INJURY_MAP` still work). Only active/recovering entries are sent.
 */
function buildInjuriesStructured(
  profile: import('../types').UserProfile,
): Array<{
  bodyPart: string;
  status: string;
  severity?: string;
  muscleGroups?: string[];
  estimatedRecoveryDate?: string;
}> {
  return (profile.injuryEntries ?? [])
    .filter((e: any) => e.status !== 'resolved' && e.bodyPart)
    .map((e: any) => ({
      bodyPart: String(e.bodyPart),
      status: String(e.status || 'active'),
      severity: e.severity ? String(e.severity) : 'moderate',
      muscleGroups: Array.isArray(e.muscleGroups) ? e.muscleGroups : [],
      estimatedRecoveryDate: e.estimatedRecoveryDate ?? undefined,
    }));
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
const PENDING_PLAN_JOB_KEY = STORAGE_KEYS.plan.pendingJob;

export type PendingPlanKind = 'full' | 'workout' | 'nutrition' | 'nutrition_remaining';
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
  const injuriesStructured = buildInjuriesStructured(profile);
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
    strengthBaselines:      profile.strengthBaselines ?? undefined,
    cardioBaseline:         profile.cardioBaseline ?? undefined,
    foodsAvailable:         profile.foodsAvailable,
    customFoodNames:        (profile.customFoods ?? []).map(f => f.name).filter(Boolean),
    supplementsAvailable:   profile.supplementsAvailable ?? [],
    experienceLevel:        profile.experienceLevel,
    preferredSplit:         profile.preferredSplit || undefined,
    injuriesOrLimitations,
    injuriesStructured,
    mealRoutine:            mealRoutineText,
    routineMacros:          routinePayload?.routineMacros,
    routineSlots:           routinePayload?.routineSlots ?? [],
    mealVariety:            Math.max(1, Math.min(7, profile.mealVariety ?? 5)),
    customMacros:           profile.customMacros ?? undefined,
    glp1Support:            profile.glp1Support?.enabled ? profile.glp1Support : undefined,
    userContext:            buildLogContext(profile, options?.userLog, options?.extraContext, { includeNutritionSupports: true }),
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
    strengthBaselines:      profile.strengthBaselines ?? undefined,
    cardioBaseline:         profile.cardioBaseline ?? undefined,
    foodsAvailable:         [],
    experienceLevel:        profile.experienceLevel,
    preferredSplit:         profile.preferredSplit || undefined,
    injuriesOrLimitations:  buildInjuries(profile),
    injuriesStructured:     buildInjuriesStructured(profile),
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

async function buildNutritionOnlyPayload(
  profile: import('../types').UserProfile,
  options?: { userLog?: import('../types').UserLogEntry[]; extraContext?: string },
): Promise<Record<string, any>> {
  const mealRoutineText = await buildMealRoutineText(profile);
  const routinePayload = await buildRoutinePayload();
  return {
    goal:                 profile.goal,
    goalDetails:          profile.goalDetails,
    physicalStats:        profile.physicalStats,
    daysPerWeek:          profile.daysPerWeek,
    equipment:            [],
    foodsAvailable:       profile.foodsAvailable,
    customFoodNames:      (profile.customFoods ?? []).map(f => f.name).filter(Boolean),
    supplementsAvailable: profile.supplementsAvailable ?? [],
    dietaryPreference:    (profile as any).dietaryPreference ?? undefined,
    allergies:            profile.allergies ?? [],
    mealRoutine:          mealRoutineText,
    routineMacros:        routinePayload?.routineMacros,
    routineSlots:         routinePayload?.routineSlots ?? [],
    mealVariety:          Math.max(1, Math.min(7, profile.mealVariety ?? 5)),
    customMacros:         profile.customMacros ?? undefined,
    glp1Support:          profile.glp1Support?.enabled ? profile.glp1Support : undefined,
    userContext:          buildLogContext(profile, options?.userLog, options?.extraContext, { includeNutritionSupports: true }),
  };
}

/** Nutrition-only plan — called when foods change. Uses the job queue so it
 *  survives app backgrounding / force-close just like full plan gen. */
export async function getAINutritionPlan(
  token: string,
  profile: import('../types').UserProfile,
  options?: { userLog?: import('../types').UserLogEntry[]; extraContext?: string },
) {
  const payload = await buildNutritionOnlyPayload(profile, options);

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

/** Nutrition-only refresh that applies the generated templates to eligible
 *  future days in the active PlanWeek. Today, locked days, checked meals,
 *  and day-level nutrition overrides are preserved server-side. */
export async function getAIRemainingWeekNutritionPlan(
  token: string,
  profile: import('../types').UserProfile,
  options?: { userLog?: import('../types').UserLogEntry[]; extraContext?: string },
) {
  const payload = await buildNutritionOnlyPayload(profile, options);

  console.log('[getAIRemainingWeekNutritionPlan] ENQUEUE → /ai/plans/enqueue?kind=nutrition_remaining', {
    goal: payload.goal, daysPerWeek: payload.daysPerWeek, foods: payload.foodsAvailable.length,
  });

  const job = await request<PlanJob>('/ai/plans/enqueue?kind=nutrition_remaining', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 60000);
  await writePendingPlanJob(job.id, 'nutrition_remaining');
  const result = await _pollPlanJobUntilDone(token, job.id);

  console.log('[getAIRemainingWeekNutritionPlan] RECV ←', {
    nutritionistNote: result?.nutritionistNote?.slice(0, 80) ?? 'MISSING',
    updatedDates: result?.remaining_week_nutrition?.updated_dates?.length ?? 0,
    skippedDates: result?.remaining_week_nutrition?.skipped?.length ?? 0,
  });
  return result;
}

export type RecommendationAiSafety = {
  status: 'not_required' | 'pending' | 'ok' | 'review' | 'unavailable' | 'disabled' | 'error' | 'missing' | string;
  verdict?: 'ok' | 'review' | null;
  reasonCode?: string | null;
  cacheKey?: string | null;
  flags?: string[];
  shouldHold?: boolean;
  updatedAt?: number;
};

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
    allTimeBestDate?: string;
    lastSessionBestWeightLbs?: number;
    lastSessionBestReps?: number;
    lastSessionBestDate?: string;
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
    /** Planner-emitted per-set scheme. Lets live recs honor top-set →
     *  backoff transitions instead of treating every set as straight work. */
    setScheme?: import('../types').PlannedSet[] | null;
    /** Override the default 8s timeout. Live in-workout callers should
     *  pass a low value (~2500ms) so a stalled cellular round trip
     *  never blocks the next-set UI; the fallback in
     *  refreshRecommendationForExercise covers the timeout case. */
    timeoutMs?: number;
  },
): Promise<{
  weightLbs: number;
  reps: number;
  tip: string;
  algorithmSource?: 'deterministic_progression' | string;
  dataSource?: string;
  confidence?: number | string | null;
  reasonTags?: string[];
  trace?: Record<string, any> | null;
  aiSafety?: RecommendationAiSafety | null;
}> {
  const { timeoutMs, ...payload } = options ?? {};
  return request('/recommendations/next-set', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ exerciseName, goal, lastSets, nextSetNumber, ...payload }),
  }, typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 8000, true);
}

/** Estimated one-rep-max for the user's showcase compound lifts.
 *  Powered by the fatigue-aware Fresh Strength Signal: weights each
 *  contributing set by its position in the session (slot × set
 *  number) and folds RIR into a confidence weight rather than
 *  rejecting noisy sets. Falls back to the rolling-overlay Epley
 *  number when the freshness window is too sparse. */
export type OneRepMaxLift = {
  slug: string;
  name: string;
  oneRepMaxLbs: number;
  topWeightLbs: number;
  topReps: number;
  sessionCount: number;
  /** Legacy 0..1 confidence from the raw performance profile. Kept
   *  for back-compat — new UI should read `signalConfidence`. */
  confidence: number;
  lastPerformedOn: string | null;
  /** % change of the fresh-signal eRM in the last 28 days vs the
   *  prior 28 days. Null when there's no prior-window data. */
  trend28dPct: number | null;
  /** Same trend but over a 56-day window. Useful for once-a-week
   *  lifters where 28d is too thin. Null if not enough data. */
  trend56dPct: number | null;
  /** Count of fresh sets that fed the signal. Surface as a small
   *  caption ("based on n fresh sets") in the UI. */
  freshSetCount: number;
  /** Confidence bucket for the fresh-signal estimate. */
  signalConfidence: 'high' | 'med' | 'low';
  /**
   *  - `full`    — solid freshness data, the signal is trustworthy.
   *  - `partial` — some data but sparse or mostly late-session.
   *  - `rough`   — fell back to the legacy rolling/raw top-set
   *                computation. Show a "based on raw top sets"
   *                caveat in the UI.
   *  - `missing` — no usable data; the lift won't appear.
   */
  dataQuality: 'full' | 'partial' | 'rough' | 'missing';
};

export async function getOneRepMaxShowcase(token: string): Promise<OneRepMaxLift[]> {
  try {
    const res = await requestRead<{ lifts: OneRepMaxLift[] }>('/ai/strength/one-rep-max', {
      headers: { Authorization: `Bearer ${token}` },
    }, 30000, 30000);
    return res.lifts ?? [];
  } catch {
    return [];
  }
}

/** 4-pillar composite fitness score. Each pillar is a 0-100 subscore
 *  with a human-readable reason and a data quality tag. The headline
 *  `total` is a 28-day moving average of the daily weighted-pillar
 *  score; `rawTotal` is today's instant value before smoothing. */
export type FitnessPillar = {
  name: 'Strength' | 'Cardio' | 'Consistency' | 'Recovery';
  score: number;
  reason: string;
  dataQuality: 'full' | 'partial' | 'missing';
};
export type FitnessCompositeScore = {
  /** 28-day moving average of the daily score — the smoothed headline. */
  total: number;
  /** Today's instant score, before moving-average smoothing. */
  rawTotal?: number;
  rating: 'Elite' | 'Strong' | 'Solid' | 'Building' | 'Starting';
  /** Pillar subscores reflect today's instant state, not the average. */
  pillars: FitnessPillar[];
  /** Moving-average window length in days (28). */
  windowDays?: number;
  /** Daily snapshots inside the window — 1 for a brand-new user. */
  sampleCount?: number;
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
    return await requestRead<FitnessCompositeScore>(path, {
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
 *  cascades into calorie-target 404 errors elsewhere in the app. */
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
  const trainingDayPattern = Array.isArray(profile.trainingDays)
    && profile.trainingDays.length === profile.daysPerWeek
    ? [...new Set(profile.trainingDays)]
        .map(d => Number(d))
        .filter(d => Number.isInteger(d) && d >= 0 && d <= 6)
        .map(d => (d + 6) % 7)
        .sort((a, b) => a - b)
    : null;
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
        weight_unit:   profile.weightUnit ?? null,
        distance_unit: profile.distanceUnit ?? null,
        height_unit:   profile.heightUnit ?? null,
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
        workout_duration_minutes: profile.workoutDurationMinutes ?? null,
        preferred_split: profile.preferredSplit ?? null,
        // Lifestyle activity outside training — drives the TDEE step_2b
        // nudge. Omitted when undefined so older backends ignore it and
        // the existing prefs row stays untouched (server-side keeps the
        // previous value when the field is absent from the payload).
        ...(profile.lifestyleActivity ? { lifestyle_activity: profile.lifestyleActivity } : {}),
        equipment:       profile.equipment,
        equipment_settings: profile.equipmentSettings ?? null,
        training_day_pattern: trainingDayPattern && trainingDayPattern.length === profile.daysPerWeek ? trainingDayPattern : null,
        experience_level: profile.experienceLevel ?? null,
        strength_baselines: profile.strengthBaselines ?? null,
        cardio_baseline: profile.cardioBaseline ?? null,
        foods_available: profile.foodsAvailable,
        pending_imports: Array.isArray(profile.pendingImports) ? profile.pendingImports : [],
        sun_exposure_preferences: profile.sunExposurePreferences
          ? normalizeSunExposurePreferences(profile.sunExposurePreferences)
          : undefined,
        glp1_support: profile.glp1Support ?? { enabled: false },
        custom_macros: profile.customMacros ?? null,
        ...(profile.workoutManualMode !== undefined ? { workout_manual_mode: !!profile.workoutManualMode } : {}),
        ...(profile.mealManualMode !== undefined ? { meal_manual_mode: !!profile.mealManualMode } : {}),
        injuries:        buildInjuries(profile),
        // Severity-aware structured records — written into the JSONB
        // column added by the injuries_structured migration. Older
        // backends ignore this key.
        injuries_structured: buildInjuriesStructured(profile),
      },
    }),
  });
  recordTelemetryEvent('onboarding_completed', {
    goal: profile.goal,
    days_per_week: profile.daysPerWeek,
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

export async function updateName(token: string, firstName: string, lastName: string): Promise<{ first_name: string | null; last_name: string | null }> {
  return request<{ first_name: string | null; last_name: string | null }>('/profile/name', {
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
// v4: bumped when `aliases` joined exercise rows for picker search.
// v3: bumped when `gear` (concrete equipment list) was added to the
// library schema — old v2 caches didn't include it, so the detail page
// was still falling back to the "Home" bucket label. Bump the suffix
// any time the shape or required fields change.
const EXERCISE_LIBRARY_CACHE_KEY = STORAGE_KEYS.cache.exerciseLibraryV5;
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
  /** Free-form per-set note (e.g. "form sloppy on rep 5"). */
  notes?: string | null;
  /** Distinguishes warmups from working sets for analytics/progression. */
  set_type?: 'working' | 'warmup' | 'dropset' | 'amrap' | string | null;
};

export type LoggedExercisePayload = {
  name: string;
  slug?: string | null;
  target_sets?: number | null;
  target_reps?: string | null;
  equipment?: string | null;
  primary_muscle?: string | null;
  secondary_muscles?: string[] | null;
  is_compound?: boolean | null;
  movement_pattern?: string | null;
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
    injuries_structured?: Record<string, any>[];
    disliked_exercises?: string[];
    focus_override?: string;
    stimulus_override?: 'strength' | 'hypertrophy' | 'volume' | string;
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

export async function generateStandaloneSession(
  token: string,
  params: { kind: 'stretch' | 'yoga' | 'foam_roll'; duration_minutes: number },
): Promise<{ day: WorkoutDay & { _standalone?: boolean; _standalone_kind?: string } }> {
  return request('/workouts/standalone/generate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(params),
  }, 10000);
}

export async function logWorkoutStarted(
  token: string,
  workout_date: string,
  focus_label: string,
  stimulus?: string,
  opts?: { timeoutMs?: number; noRetry?: boolean },
) {
  return request('/workouts/start', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ workout_date, focus_label, stimulus }),
  }, opts?.timeoutMs ?? 10000, opts?.noRetry ?? false);
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
  calories_burned?: number | null;
  hr_summary?: {
    avgBpm?: number | null;
    maxBpm?: number | null;
    zoneMinutes?: number[] | null;
  } | null;
  training_score?: number | null;
  training_rating?: 'Crushed' | 'Solid' | 'Light' | 'Below' | null;
}

export interface WorkoutTrainingScorePayload {
  score?: number;
  rating?: 'Crushed' | 'Solid' | 'Light' | 'Below';
  pillars?: { effort: number; volume: number; duration: number; consistency: number };
  pillarBreakdown?: Array<{
    key: string;
    label: string;
    value: number;
    max: number;
    present: boolean;
  }>;
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
    /** GPS route coords captured during the session. Persisted on the
     *  WorkoutCompletion row so post-workout map + Apple Fitness route
     *  view can render the trail. Lifting + indoor cardio omit. */
    routeCoords?: Array<{ lat: number; lon: number; t_ms: number; acc_m?: number | null; alt_m?: number | null; v_acc_m?: number | null }>;
    /** Per-subtype structured detail (sauna temp, cold plunge depth,
     *  swim stroke, climbing grade, etc). */
    details?: ManualActivityDetails;
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
  training?: WorkoutTrainingScorePayload,
  /** Explicit gear-attribution override. When set (even to []), the
   *  backend SKIPS keyword-based auto-accumulation and only credits the
   *  given gear IDs. Used by the per-session disambiguation prompt when
   *  multiple gear items match the same workout (e.g. two pairs of
   *  running shoes both keyworded with 'run'). Passing [] is a deliberate
   *  "no gear used today" signal. */
  gearIds?: number[],
  source?: {
    sourceContext?: 'planned' | 'saved_template' | 'custom_strength' | 'custom_cardio' | 'manual_activity' | 'apple_health' | 'watch' | 'coach_log' | string;
    templateId?: string | null;
    planDayId?: number | null;
    stimulus?: string | null;
    startedAt?: string | null;
    endedAt?: string | null;
    externalSourceId?: string | null;
    idempotencyKey?: string | null;
  },
  opts?: { timeoutMs?: number; noRetry?: boolean },
): Promise<WorkoutCompleteResponse> {
  const activityHrSummary = activity?.avgHeartRate
    ? { avgBpm: activity.avgHeartRate, maxBpm: activity.avgHeartRate, zoneMinutes: [] }
    : undefined;
  const hrSummary = healthMetrics?.hrSummary ?? activityHrSummary;
  const caloriesBurned = healthMetrics?.caloriesBurned ?? activity?.caloriesBurned;
  const sourceContext = source?.sourceContext
    ?? (activity?.source === 'apple_health' ? 'apple_health'
      : activity?.source === 'watch' ? 'watch'
        : activity?.category ? 'manual_activity'
          : undefined);

  const result = await request<WorkoutCompleteResponse>('/workouts/complete', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      workout_date,
      focus_label,
      duration_seconds,
      ...(sourceContext ? { source_context: sourceContext } : {}),
      ...(source?.templateId ? { template_id: source.templateId } : {}),
      ...(source?.planDayId != null ? { plan_day_id: source.planDayId } : {}),
      ...(source?.stimulus ? { stimulus: source.stimulus } : {}),
      ...(source?.startedAt ? { started_at: source.startedAt } : {}),
      ...(source?.endedAt ? { ended_at: source.endedAt } : {}),
      ...(source?.externalSourceId ? { external_source_id: source.externalSourceId } : {}),
      ...(source?.idempotencyKey ? { idempotency_key: source.idempotencyKey } : {}),
      ...(exercises && exercises.length > 0 ? { exercises } : {}),
      ...(activity?.category ? {
        activity_category: activity.category,
        activity_subtype: activity.subtype,
        activity_intensity: activity.intensity,
        activity_source: activity.source,
        cardio_style: activity.cardioStyle,
      } : {}),
      ...(activity?.distanceMiles != null ? { distance_miles: activity.distanceMiles } : {}),
      ...(activity?.details && Object.keys(activity.details).length > 0
        ? { activity_details: activity.details } : {}),
      ...(activity?.routeCoords && activity.routeCoords.length > 0
        ? { route_coords: activity.routeCoords } : {}),
      ...(caloriesBurned ? { calories_burned: caloriesBurned } : {}),
      ...(hrSummary ? { hr_summary: hrSummary } : {}),
      ...(feedback?.feeling ? { feeling: feedback.feeling } : {}),
      ...(feedback?.intensity ? { intensity: feedback.intensity } : {}),
      ...(feedback?.sorenessAreas && feedback.sorenessAreas.length > 0 ? { soreness_areas: feedback.sorenessAreas } : {}),
      ...(feedback?.notes ? { feedback_notes: feedback.notes } : {}),
      ...(training?.score != null ? { training_score: training.score } : {}),
      ...(training?.rating ? { training_rating: training.rating } : {}),
      ...(training?.pillars ? { training_pillars: training.pillars } : {}),
      ...(training?.pillarBreakdown ? { training_pillar_breakdown: training.pillarBreakdown } : {}),
      // gear_ids: undefined → keyword auto-match (legacy default)
      // gear_ids: []        → explicit "no gear used today"
      // gear_ids: [1,3]     → only credit these IDs, skip keyword match
      ...(Array.isArray(gearIds) ? { gear_ids: gearIds } : {}),
    }),
  }, opts?.timeoutMs ?? 30000, opts?.noRetry ?? false);
  recordTelemetryEvent('workout_completed', {
    workout_date,
    focus_label,
    duration_seconds,
    exercise_count: exercises?.length ?? 0,
    source: sourceContext ?? activity?.source ?? 'phone',
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
  source?: {
    sourceContext?: 'planned' | 'saved_template' | 'custom_strength' | 'custom_cardio' | 'manual_activity' | 'apple_health' | 'watch' | 'coach_log' | string;
  },
  opts?: { timeoutMs?: number; noRetry?: boolean },
): Promise<{ ok: boolean; session_id: number | null; exercises: number; sets: number }> {
  return request('/workouts/sync', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      workout_date,
      focus_label,
      exercises,
      ...(source?.sourceContext ? { source_context: source.sourceContext } : {}),
    }),
  }, opts?.timeoutMs ?? 10000, opts?.noRetry ?? false);
}

export interface WorkoutCompletionRecord {
  id: number;
  workout_date: string;
  focus_label: string;
  duration_seconds: number;
  stimulus?: string | null;
  source_context?: string | null;
  template_id?: string | null;
  plan_day_id?: number | null;
  completed_at?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  external_source_id?: string | null;
  idempotency_key?: string | null;
  activity_category?: string | null;
  activity_subtype?: string | null;
  activity_intensity?: string | null;
  activity_source?: string | null;
  cardio_style?: string | null;
  distance_miles?: number | null;
  calories_burned?: number | null;
  /** Per-subtype structured detail JSONB (sauna temp, cold plunge depth,
   *  swim stroke, climbing grade, etc). */
  activity_details?: Record<string, unknown> | null;
  /** GPS route trail captured during the session. Drives post-workout
   *  map summary + sharing surfaces. Null for indoor cardio + lifting. */
  route_coords?: Array<{ lat: number; lon: number; t_ms?: number; acc_m?: number | null; alt_m?: number | null; v_acc_m?: number | null }> | null;
  hr_summary?: {
    avgBpm?: number | null;
    maxBpm?: number | null;
    zoneMinutes?: number[] | null;
  } | null;
  training_score?: number | null;
  training_rating?: 'Crushed' | 'Solid' | 'Light' | 'Below' | string | null;
  training_pillars?: { effort: number; volume: number; duration: number; consistency: number } | null;
  training_pillar_breakdown?: WorkoutTrainingScorePayload['pillarBreakdown'] | null;
  /** Provenance tag set by the import pipelines (Strong/Hevy/Strava).
   *  Drives the "IMPORTED" badge on the workout-history card. */
  import_source?: string | null;
}

export interface WorkoutSessionSetRecord {
  set_number: number;
  target_reps_min?: number | null;
  target_reps_max?: number | null;
  target_weight_lbs?: number | null;
  set_type?: string | null;
  actual_reps?: number | null;
  actual_weight_lbs?: number | null;
  actual_rir?: number | null;
  completed?: boolean | null;
  duration_seconds?: number | null;
  comfort_rating?: number | null;
  actual_distance?: number | null;
  actual_pace?: string | null;
  heart_rate_avg?: number | null;
  cardio_metrics?: Record<string, string> | null;
  /** Free-form note for this set (e.g. "form felt sloppy on rep 5"). */
  notes?: string | null;
}

export interface WorkoutSessionExerciseRecord {
  name: string;
  equipment?: string | null;
  target_reps_text?: string | null;
  rest_seconds?: number | null;
  exercise_slug_snapshot?: string | null;
  primary_muscle_snapshot?: string | null;
  secondary_muscles_snapshot?: string[] | null;
  is_compound_snapshot?: boolean | null;
  sets?: WorkoutSessionSetRecord[];
}

export interface WorkoutSessionRecord {
  id: number;
  workout_date: string;
  focus: string;
  source?: string | null;
  completed_at?: string | null;
  created_at?: string | null;
  exercises?: WorkoutSessionExerciseRecord[];
}

export async function listWorkoutSessions(
  token: string,
  opts: number | ListWindowOptions = 100,
): Promise<WorkoutSessionRecord[]> {
  const { limit, skip, since, before } = normalizeWindowOptions(opts, 100);
  const params = new URLSearchParams({ limit: String(limit), skip: String(skip) });
  if (since) params.set('since', since);
  if (before) params.set('before', before);
  const path = `/workouts?${params}`;
  const requestOptions = {
    headers: { Authorization: `Bearer ${token}` },
  };
  const fresh = typeof opts === 'object' && opts?.fresh;
  if (fresh) {
    const timeoutMs = typeof opts === 'object' ? opts.timeoutMs : undefined;
    const noRetry = typeof opts === 'object' ? opts.noRetry : undefined;
    return request<WorkoutSessionRecord[]>(path, requestOptions, timeoutMs ?? 15000, noRetry ?? true);
  }
  return requestRead(path, requestOptions, 30000, 10000);
}

/** Fetch the user's recent completion markers. No per-set detail. Used to
 *  rehydrate local workoutHistory after a wipe. */
export async function listWorkoutCompletions(
  token: string,
  opts: number | ListWindowOptions = 100,
): Promise<WorkoutCompletionRecord[]> {
  const { limit, skip, since, before } = normalizeWindowOptions(opts, 100);
  const params = new URLSearchParams({ limit: String(limit), skip: String(skip) });
  if (since) params.set('since', since);
  if (before) params.set('before', before);
  const path = `/workouts/completions?${params}`;
  const requestOptions = {
    headers: { Authorization: `Bearer ${token}` },
  };
  const fresh = typeof opts === 'object' && opts?.fresh;
  if (fresh) {
    const timeoutMs = typeof opts === 'object' ? opts.timeoutMs : undefined;
    const noRetry = typeof opts === 'object' ? opts.noRetry : undefined;
    return request<WorkoutCompletionRecord[]>(path, requestOptions, timeoutMs ?? 15000, noRetry ?? true);
  }
  return requestRead(path, requestOptions, 30000, 10000);
}

export interface SunExposureSegmentCreateRequest {
  startTime: string;
  endTime: string;
  durationMinutes?: number;
  coarseLocationHash?: string | null;
  activityId?: number | null;
  routeCoords?: Array<{ lat: number; lon: number; t_ms?: number; acc_m?: number | null; alt_m?: number | null; v_acc_m?: number | null }>;
  uvIndexAverage: number;
  uvIndexMax?: number;
  lightIntensityLux?: number | null;
  localStartMinute?: number | null;
  localEndMinute?: number | null;
  timezoneOffsetMinutes?: number | null;
  daylight?: boolean;
  outdoorConfidence?: number;
  areaContext?: AreaSunContext;
  areaHints?: Record<string, unknown>;
  activityCategory?: string | null;
  activitySubtype?: string | null;
  activitySource?: string | null;
  source?: SunExposureSegment['source'];
  userCorrection?: SunExposureCorrectionOption;
}

export async function getSunExposurePreferences(token: string): Promise<SunExposurePreferences> {
  const result = await requestRead<SunExposurePreferences>('/sun-exposure/preferences', {
    headers: { Authorization: `Bearer ${token}` },
  }, 10000, 10000);
  return normalizeSunExposurePreferences(result);
}

export async function updateSunExposurePreferences(
  token: string,
  preferences: Partial<SunExposurePreferences>,
): Promise<SunExposurePreferences> {
  const result = await request<SunExposurePreferences>('/sun-exposure/preferences', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(preferences),
  }, 10000);
  return normalizeSunExposurePreferences(result);
}

export async function createSunExposureSegment(
  token: string,
  payload: SunExposureSegmentCreateRequest,
): Promise<SunExposureSegment> {
  return request<SunExposureSegment>('/sun-exposure/segments', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 10000);
}

export async function listSunExposureSegments(token: string, dayISO: string): Promise<SunExposureSegment[]> {
  const params = new URLSearchParams({ day: dayISO.slice(0, 10) });
  return requestRead<SunExposureSegment[]>(`/sun-exposure/segments?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 10000, 10000);
}

export async function getSunExposureSummary(token: string, dayISO: string): Promise<SunExposureDailySummary> {
  const params = new URLSearchParams({ day: dayISO.slice(0, 10) });
  return requestRead<SunExposureDailySummary>(`/sun-exposure/summary?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 10000, 10000);
}

export async function getSunExposureHistory(token: string, days = 30): Promise<SunExposureDailySummary[]> {
  const params = new URLSearchParams({ days: String(Math.max(1, Math.min(365, Math.round(days)))) });
  return requestRead<SunExposureDailySummary[]>(`/sun-exposure/history?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 10000, 10000);
}

export async function correctSunExposureSegment(
  token: string,
  payload: { segmentId?: number | null; correctionType: SunExposureCorrectionOption; contextKey?: string | null; notes?: string | null },
): Promise<{ correction: Record<string, unknown>; segment: SunExposureSegment | null }> {
  return request('/sun-exposure/corrections', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 10000);
}

export async function deleteSunExposureDerivedData(token: string): Promise<void> {
  await request('/sun-exposure/derived-data', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  }, 10000);
}

export type LifestyleDoseLevel = 'none' | 'light' | 'moderate' | 'heavy';
export type LifestyleTiming = 'morning' | 'afternoon' | 'evening' | 'late' | 'unknown';
export type BowelConsistency = 'normal' | 'loose' | 'hard' | 'mixed' | 'not_sure';
export type LifestyleStressLevel = 'low' | 'moderate' | 'high';
export type IllnessState = 'healthy' | 'rundown' | 'sick';
export type AppetiteLevel = 'low' | 'normal' | 'high';

export interface DailyLifestyleLog {
  id?: number | null;
  userId?: number;
  localDate: string;
  hasLog?: boolean;
  alcoholLevel?: LifestyleDoseLevel | null;
  alcoholDrinks?: number | null;
  alcoholTiming?: LifestyleTiming | null;
  cannabisLevel?: LifestyleDoseLevel | null;
  cannabisTiming?: LifestyleTiming | null;
  bowelMovementCount?: number | null;
  bowelConsistency?: BowelConsistency | null;
  stressLevel?: LifestyleStressLevel | null;
  illnessState?: IllnessState | null;
  caffeineMg?: number | null;
  caffeineTiming?: LifestyleTiming | null;
  lateCaffeine?: boolean | null;
  appetite?: AppetiteLevel | null;
  notes?: string | null;
  source?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  pending?: boolean;
}

export type DailyLifestyleLogPayload = Partial<Omit<
  DailyLifestyleLog,
  'id' | 'userId' | 'localDate' | 'hasLog' | 'createdAt' | 'updatedAt' | 'pending'
>>;

export async function getLifestyleLogs(
  token: string,
  startDate: string,
  endDate: string,
): Promise<{ userId: number; startDate: string; endDate: string; logs: DailyLifestyleLog[] }> {
  const params = new URLSearchParams({
    startDate: startDate.slice(0, 10),
    endDate: endDate.slice(0, 10),
  });
  return requestRead(`/lifestyle/daily?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 10000, 10000);
}

export async function getLifestyleLog(token: string, localDate: string): Promise<DailyLifestyleLog> {
  return requestRead<DailyLifestyleLog>(`/lifestyle/daily/${encodeURIComponent(localDate.slice(0, 10))}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 10000, 5000);
}

export async function upsertLifestyleLog(
  token: string,
  localDate: string,
  payload: DailyLifestyleLogPayload,
): Promise<DailyLifestyleLog> {
  return request<DailyLifestyleLog>(`/lifestyle/daily/${encodeURIComponent(localDate.slice(0, 10))}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 10000);
}

export interface FatigueScore {
  muscle_recovery_score: number;
  muscle_recovery_label: string;
  // Deprecated compatibility aliases. Prefer muscle_recovery_* for UI; true
  // training readiness comes from /readiness/today.
  readiness_score: number;
  readiness_label: string;
  muscle_fatigue: Record<string, number>;
  raw_muscle_fatigue?: Record<string, number>;
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
  explanations?: Array<{ type: string; severity: string; message: string }>;
  recommendations?: Array<{
    type: string;
    severity: string;
    message: string;
    lower_body_readiness?: number;
    alternatives?: string[];
  }>;
}

export async function getFatigueScore(token: string): Promise<FatigueScore> {
  return requestRead<FatigueScore>('/workouts/fatigue', {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, 30000);
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

/** Conflict detection — call after a new injury is saved to find
 *  upcoming exercises in the active PlanWeek that the new injury
 *  would now block. Backend reads the plan; caller only sends the
 *  injury list. Completed days are excluded server-side. */
export interface InjuryConflict {
  day_index: number;
  focus: string;
  exercise_name: string;
  slug?: string | null;
  movement_pattern: string;
  reason: string;
}
export async function detectInjuryConflicts(
  token: string,
  injuries: import('../types').InjuryEntry[],
): Promise<{ conflicts: InjuryConflict[]; summary: string; today_index: number }> {
  const structured = injuries
    .filter(e => e.status !== 'resolved' && e.bodyPart)
    .map(e => ({
      bodyPart: e.bodyPart,
      status: e.status || 'active',
      severity: e.severity || 'moderate',
      muscleGroups: e.muscleGroups ?? [],
      estimatedRecoveryDate: e.estimatedRecoveryDate,
    }));
  return request('/workouts/injury-conflicts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ structured_injuries: structured, legacy_injuries: [] }),
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
  payload: {
    skipped_focus?: string | null;
    skip_reason?: string | null;
    meal_checks?: Record<string, boolean>;
    nutrition_plan?: any;
    nutrition_log_status?: 'unknown' | 'partial' | 'rough_estimate' | 'complete' | null;
    nutrition_log_status_source?: string | null;
    macro_overrides?: any;
  },
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
  if (payload.nutrition_log_status === null) {
    body.clear_nutrition_log_status = true;
  } else if (payload.nutrition_log_status !== undefined) {
    body.nutrition_log_status = payload.nutrition_log_status;
    if (payload.nutrition_log_status_source !== undefined) {
      body.nutrition_log_status_source = payload.nutrition_log_status_source;
    }
  }
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
    update_profile_weight?: boolean;
    waist_in?: number;
    chest_in?: number;
    hips_in?: number;
    bicep_in?: number;
    thigh_in?: number;
    calf_in?: number;
    body_fat_pct?: number;
    bp_systolic?: number;
    bp_diastolic?: number;
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
  return requestRead('/profile/insights', {
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

export async function upsertNightlySleepBatch(token: string, payloads: SleepNightlyPayload[]) {
  return request('/sleep/nightly/batch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payloads),
  });
}

export type SleepHistoryItem = SleepNightlyPayload;

export async function getSleepHistory(token: string, days: number = 30) {
  return requestRead<SleepHistoryItem[]>(`/sleep/history?days=${days}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export type SleepPressureStatus = 'not_enough_data' | 'clear' | 'low' | 'moderate' | 'high';

export interface SleepPressureResponse {
  status: SleepPressureStatus;
  pressure_hours: number;
  display_hours: number;
  is_capped: boolean;
  sleep_need_hours: number;
  recent_average_hours: number | null;
  nights_count: number;
  window_days: number;
  confidence: 'low' | 'medium' | 'high';
  sleep_score_penalty: number;
  headline: string;
  detail: string;
}

export async function getSleepPressure(token: string, days: number = 14) {
  return requestRead<SleepPressureResponse>(`/sleep/pressure?days=${days}`, {
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
  basal_energy_kcal?: number | null;
  workout_minutes?: number | null;
  cardio_minutes?: number | null;
  zone2_minutes?: number | null;
  resting_hr?: number | null;
  hrv_ms?: number | null;
  vo2_max?: number | null;
  respiratory_rate?: number | null;
  oxygen_saturation?: number | null;
  wrist_temperature_c?: number | null;
  sleep_breathing_disturbances?: number | null;
  sleep_breathing_disturbances_elevated?: boolean | null;
  weight_lbs?: number | null;
  readiness_score?: number | null;
  source?: string | null;
  source_details?: {
    providers?: string[];
    fields?: Record<string, string>;
    [key: string]: unknown;
  } | null;
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

export type DailyHealthHistoryItem = DailyHealthSnapshotPayload;

export async function getDailyHealthHistory(token: string, days: number = 30) {
  return requestRead<DailyHealthHistoryItem[]>(`/health/history?days=${days}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─── Daily Stress summary (per user per day) ────────────────────────────────
//
// The Progress Today stress timeline computes a modeled daily average from
// meals, workouts/activity, and optional HR samples. Persisting that summary
// lets the app compare today against the user's own baseline.

export type DailyStressSummaryPayload = {
  summary_date: string;
  avg_stress: number;
  max_stress?: number | null;
  latest_stress?: number | null;
  sample_count?: number | null;
  source_count?: number | null;
  source?: 'thallo_estimate' | 'logs_estimate' | 'hr_logs_estimate' | 'manual' | 'imported' | 'unknown' | string | null;
  source_details?: Record<string, unknown> | null;
  computed_at?: string | null;
};

export type DailyStressComparison = {
  delta: number;
  label: 'about_usual' | 'higher_than_usual' | 'much_higher_than_usual' | 'lower_than_usual' | 'much_lower_than_usual' | string;
  copy: string;
  severity: 'neutral' | 'watch' | 'high' | 'low' | string;
};

export type DailyStressSummaryItem = DailyStressSummaryPayload & {
  avg_stress: number;
  max_stress?: number | null;
  latest_stress?: number | null;
  sample_count: number;
  source_count: number;
  source: string;
  updated_at?: string | null;
  comparison?: DailyStressComparison | null;
};

export type DailyStressBaseline = {
  window_days: number;
  avg_stress: number;
  days_with_data: number;
  min_stress: number;
  max_stress: number;
};

export type DailyStressHistoryResponse = {
  as_of: string;
  days: number;
  baseline_days: number;
  baseline: DailyStressBaseline | null;
  today: DailyStressSummaryItem | null;
  rows: DailyStressSummaryItem[];
};

export async function upsertDailyStressSummary(token: string, payload: DailyStressSummaryPayload) {
  return request<{ status: string; summary: DailyStressSummaryItem }>('/health/stress-summary', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export async function getDailyStressHistory(token: string, days: number = 30, baselineDays: number = 14, asOf?: string | null) {
  const d = Math.max(1, Math.min(365, Math.round(days || 30)));
  const b = Math.max(3, Math.min(90, Math.round(baselineDays || 14)));
  const asOfParam = asOf ? `&as_of=${encodeURIComponent(asOf)}` : '';
  return requestRead<DailyStressHistoryResponse>(`/health/stress-history?days=${d}&baseline_days=${b}${asOfParam}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, 60 * 1000, SOFT_TIMEOUT_MS);
}

export type MetabolicSignalConfidence = 'low' | 'medium' | 'high';
export type MetabolicSignalStatus = 'low' | 'watch' | 'moderate' | 'elevated' | 'high' | 'unknown';
export type MetabolicSignalRiskDirection = 'higher_is_better' | 'higher_is_worse';

export type MetabolicSignalEstimate = {
  key: string;
  title: string;
  score: number;
  label: string;
  status: MetabolicSignalStatus;
  risk_direction: MetabolicSignalRiskDirection;
  confidence: MetabolicSignalConfidence;
  summary: string;
  drivers: string[];
  positive_factors: string[];
  limiting_factors: string[];
  recommendations: string[];
  data_used: string[];
  missing_data: string[];
  window_days: number;
  disclaimer: string;
};

export type MetabolicStressRhythmSegment = {
  key: string;
  title: string;
  window_label: string;
  expected_pattern: string;
  score: number;
  label: string;
  status: MetabolicSignalStatus;
  risk_direction: MetabolicSignalRiskDirection;
  confidence: MetabolicSignalConfidence;
  summary: string;
  drivers: string[];
  data_used: string[];
  missing_data: string[];
};

export type MetabolicStressRhythm = {
  key: string;
  title: string;
  confidence: MetabolicSignalConfidence;
  summary: string;
  segments: MetabolicStressRhythmSegment[];
  data_used: string[];
  missing_data: string[];
  disclaimer: string;
};

export type MetabolicSignalsResponse = {
  user_id: string;
  window_days: number;
  generated_at: string;
  confidence: MetabolicSignalConfidence;
  disclaimer: string;
  data_coverage: Record<string, {
    label: string;
    window_days?: number;
    days_with_data?: number;
    records?: number;
    quality: MetabolicSignalConfidence | 'missing';
  }>;
  data_used: string[];
  missing_data: string[];
  hormone_support: {
    score: number;
    label: string;
    confidence: MetabolicSignalConfidence;
    summary: string;
    estimates: MetabolicSignalEstimate[];
  };
  stress_rhythm?: MetabolicStressRhythm;
  autophagy: MetabolicSignalEstimate;
  source_metrics: Record<string, number | string | null>;
};

export async function getMetabolicSignals(token: string, days: number = 30): Promise<MetabolicSignalsResponse> {
  const clamped = Math.max(14, Math.min(30, Math.round(days || 30)));
  return requestRead<MetabolicSignalsResponse>(`/health/metabolic-signals?days=${clamped}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, 5 * 60 * 1000, SOFT_TIMEOUT_MS);
}

export type LabMarker = {
  key: string;
  label: string;
  default_unit: string;
  aliases?: string[];
};

export type HealthLabResultPayload = {
  lab_type: string;
  value: number;
  unit?: string | null;
  collected_at?: string | null;
  source?: 'manual' | 'scan' | 'imported' | 'clinician' | 'unknown' | string | null;
  reference_range_low?: number | null;
  reference_range_high?: number | null;
};

export type HealthLabResultItem = HealthLabResultPayload & {
  id: number;
  lab_label: string;
  unit: string;
  collected_at: string;
  source: string;
  created_at?: string | null;
};

export async function getLabMarkers(token: string): Promise<{ markers: LabMarker[] }> {
  return request('/health/labs/markers', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getHealthLabResults(token: string, days: number = 365): Promise<HealthLabResultItem[]> {
  return request(`/health/labs?days=${days}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function saveHealthLabResult(
  token: string,
  payload: HealthLabResultPayload,
): Promise<HealthLabResultItem> {
  return request('/health/labs', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export async function saveHealthLabResultsBatch(
  token: string,
  payloads: HealthLabResultPayload[],
): Promise<{ status: string; count: number; labs: HealthLabResultItem[] }> {
  return request('/health/labs/batch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payloads),
  });
}

export async function deleteHealthLabResult(token: string, labId: number): Promise<{ status: string; deleted: number }> {
  return request(`/health/labs/${labId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

type HealthInsightsOptions = {
  includeUnknown?: boolean;
  categories?: string[];
  riskSignals?: boolean;
  preferFresh?: boolean;
};

function healthInsightsPath(
  days: number = 14,
  options?: Pick<HealthInsightsOptions, 'includeUnknown' | 'categories' | 'riskSignals'>,
): string {
  const params = new URLSearchParams();
  params.set('days', String(days));
  if (options?.includeUnknown) params.set('include_unknown', 'true');
  if (options?.riskSignals === false) params.set('risk_signals', 'false');
  if (options?.categories?.length) params.set('categories', options.categories.join(','));
  return `/insights/health?${params.toString()}`;
}

export async function getCachedHealthInsights(
  token: string,
  days: number = 14,
  options?: Pick<HealthInsightsOptions, 'includeUnknown' | 'categories' | 'riskSignals'>,
): Promise<HealthInsightsResponse | null> {
  const path = healthInsightsPath(days, options);
  const key = readRequestKey(path, { headers: { Authorization: `Bearer ${token}` } });
  if (!key) return null;
  const now = Date.now();
  const cached = readCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value as HealthInsightsResponse;
  const persisted = await loadPersistentRead<HealthInsightsResponse>(key);
  return persisted?.value ?? null;
}

export async function getHealthInsights(
  token: string,
  days: number = 14,
  options?: HealthInsightsOptions,
): Promise<HealthInsightsResponse> {
  return requestRead<HealthInsightsResponse>(healthInsightsPath(days, options), {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, 5 * 60 * 1000, options?.preferFresh ? null : SOFT_TIMEOUT_MS);
}

export async function getContextInsightPreferences(token: string): Promise<UserInsightPreferences> {
  return request<UserInsightPreferences>('/context-insights/preferences', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function updateContextInsightPreferences(
  token: string,
  payload: Partial<UserInsightPreferences>,
): Promise<UserInsightPreferences> {
  return request<UserInsightPreferences>('/context-insights/preferences', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export async function getContextInsights(
  token: string,
  days: number = 14,
  includeDismissed = false,
): Promise<ContextInsightsResponse> {
  const params = new URLSearchParams();
  params.set('days', String(days));
  if (includeDismissed) params.set('include_dismissed', 'true');
  return request<ContextInsightsResponse>(`/context-insights?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getNextBestContextAction(token: string, days: number = 14): Promise<DailyInsightAction> {
  return request<DailyInsightAction>(`/context-insights/next-action?days=${days}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function dismissContextInsight(token: string, insightId: string): Promise<ContextAwareInsight> {
  return request<ContextAwareInsight>(`/context-insights/${encodeURIComponent(insightId)}/dismiss`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function deleteContextInsightDerivedData(token: string): Promise<void> {
  return request<void>('/context-insights/derived-data', {
    method: 'DELETE',
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
  /** Short common abbreviations / synonyms (1-3 entries) returned by the
   *  AI prompt so freshly-imported exercises match later text searches
   *  for those names. e.g. "BP" / "Bench" for Bench Press. Wger results
   *  don't carry aliases, so this is AI-source-only. */
  aliases?: string[];
  /** free-exercise-db identifier — when present, the client renders a
   *  static photo demo (or 2-frame cycling preview inside FormVideoModal)
   *  in addition to the YouTube fallback. Populated server-side from
   *  Exercise.demo_exercise_db_id at seed time. */
  demo_exercise_db_id?: string | null;
};

/** Resolve an exercise name to a YouTube video ID for the top form
 *  tutorial. Cached server-side. Returns the primary `video_id` plus a
 *  `candidates` list so the client can fall back to the next video when
 *  a player-level error fires (152/153/etc) inside the iframe. */
export async function getExerciseVideo(
  token: string,
  exerciseName: string,
  context?: {
    equipment?: string | null;
    primaryMuscle?: string | null;
    movementPattern?: string | null;
  },
): Promise<{ video_id: string; candidates?: string[]; search_url: string; cached?: boolean }> {
  return request('/ai/exercise-video', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      exercise_name: exerciseName,
      equipment: context?.equipment ?? undefined,
      primary_muscle: context?.primaryMuscle ?? undefined,
      movement_pattern: context?.movementPattern ?? undefined,
    }),
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
  const key = (value: unknown) => String(value ?? '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const excluded = new Set((body.exclude ?? []).map(key).filter(Boolean));
  const filtered = (res.results ?? []).filter(r => !excluded.has(key(r.name)));
  return { results: filtered };
}

/** Identify gym equipment / a machine from a single photo and return
 *  3-6 exercises that machine supports, each with primary + secondary
 *  muscles and standard sets/reps. Backend prefers verbatim names from
 *  `library_names` when one of the supported exercises is already in
 *  the user's library — so scanning a familiar cable machine returns
 *  the user's existing Cable Row / Lat Pulldown rows instead of fresh
 *  duplicates.
 *
 *  Response also includes `equipment_identified` (the detected machine
 *  name, e.g. "Cable Machine") so the UI can show "Found: ___ — here
 *  are exercises you can do with it." Empty string + empty results
 *  when the photo is too ambiguous to identify equipment. */
export async function analyzeExercisePhoto(
  token: string,
  body: {
    image_base64: string;
    mime_type?: string;
    library_names?: string[];
    equipment?: string[];
    injuries?: string[];
  },
): Promise<{
  equipment_identified?: string;
  results: Array<AIExerciseResult & { match_source?: 'library' | 'ai' }>;
}> {
  return request('/ai/exercise-photo', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }, 30000);
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
    completed_exercises?: string[];
    scheduled_exercises?: string[];
    exclude?: string[];
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
  return requestRead<{ warnings: string[] }>('/profile/guardrails', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getCoachMemory(token: string) {
  return requestRead<any[]>('/profile/coach-memory', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─── Calorie reference targets ───────────────────────────────────────────────

export interface CalorieRanges {
  bmr: number;
  activity_multiplier: number;
  maintenance_calories: number;
  formula_maintenance_calories?: number;
  cut_calories: number;
  bulk_calories: number;
  cut_protein_g: number;
  maintain_protein_g: number;
  bulk_protein_g: number;
  source_weight_lbs?: number;
  source_weight_kind?: string;
  height_feet?: number;
  height_inches?: number;
  age?: number;
  gender?: string;
  training_days_per_week?: number;
  session_minutes?: number;
  session_duration_label?: string;
  formula?: string;
  activity_level?: string;
  cut_adjustment_kcal?: number;
  maintenance_adjustment_kcal?: number;
  bulk_adjustment_kcal?: number;
  source_tdee_kind?: string;
  source_tdee_kcal?: number | null;
  health_energy_adjustment_kcal?: number;
  health_basal_adjustment_kcal?: number;
}

/** Cut / maintain / bulk calorie reference targets for the signed-in user.
 *  Computed server-side by the same calorie_calculator module that drives
 *  the meal plan targets — read-only preview, doesn't change the user's
 *  actual goal. */
export async function getCalorieRanges(token: string): Promise<CalorieRanges> {
  return requestRead('/profile/calorie-ranges', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─── User custom exercises ───────────────────────────────────────────────────

export async function getCustomExercises(token: string): Promise<CustomExerciseItem[]> {
  const rows = await request<any[]>('/profile/custom-exercises', {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (rows ?? []).map(customExerciseFromApi).filter(Boolean) as CustomExerciseItem[];
}

export async function saveCustomExercise(
  token: string,
  exercise: CustomExerciseItem,
): Promise<CustomExerciseItem> {
  const row = await request<any>('/profile/custom-exercises', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(customExerciseToApiPayload(exercise)),
  });
  return customExerciseFromApi(row) ?? exercise;
}

export async function updateCustomExercise(
  token: string,
  exercise: CustomExerciseItem,
): Promise<CustomExerciseItem> {
  if (!exercise.server_id) return saveCustomExercise(token, exercise);
  const row = await request<any>(`/profile/custom-exercises/${exercise.server_id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(customExerciseToApiPayload(exercise)),
  });
  return customExerciseFromApi(row) ?? exercise;
}

export async function syncCustomExercises(
  token: string,
  exercises: CustomExerciseItem[],
): Promise<CustomExerciseItem[]> {
  const rows = await request<any[]>('/profile/custom-exercises/sync', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ exercises: exercises.map(customExerciseToApiPayload) }),
  });
  return (rows ?? []).map(customExerciseFromApi).filter(Boolean) as CustomExerciseItem[];
}

export async function deleteCustomExercise(token: string, exercise: CustomExerciseItem): Promise<void> {
  if (!exercise.server_id) return;
  await request(`/profile/custom-exercises/${exercise.server_id}`, {
    method: 'DELETE',
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
  return requestRead<any>(`/workouts/progression/${encodeURIComponent(exerciseName)}`, {
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
  availableGoalIds?: string[],
): Promise<{ goal_id: string; reason: string }> {
  return request<any>('/ai/match-goal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description, available_goal_ids: availableGoalIds }),
  }, 12000);
}

/** Look up a packaged food by barcode via local catalog, USDA, then fallback sources. */
export async function lookupBarcode(
  token: string,
  barcode: string,
): Promise<FoodSearchResult & { barcode?: string | null }> {
  return request<any>('/ai/barcode-lookup', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ barcode }),
  }, 10000);
}

export type FoodSearchResult = {
  name: string;
  serving: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber?: number;
  micronutrients?: Record<string, number>;
  source?: 'seed' | 'user' | 'usda' | 'fatsecret' | 'barcode' | 'ai' | 'vision_estimate' | string;
  fdc_id?: string | null;
  external_id?: string | null;
  barcode?: string | null;
  food_id?: number | null;
  serving_id?: number | null;
  serving_grams?: number | null;
  brand?: string | null;
  is_verified?: boolean;
  is_preferred?: boolean;
  trust_badge?: 'verified' | 'label' | 'user' | 'estimate' | 'catalog' | string;
  processing_bucket?: 'minimally_processed' | 'processed' | 'ultra_processed' | 'unknown' | string;
  food_quality?: 'whole' | 'processed' | 'unknown' | string;
  protein_source?: 'plant' | 'animal' | 'mixed' | 'none' | 'unknown' | string;
  fermented?: boolean;
  probiotic?: boolean;
  omega3_rich?: boolean;
  plant_count?: number;
  seafood?: boolean;
  fruit?: boolean;
  vegetable?: boolean;
  alcohol?: boolean;
  processed_meat?: boolean;
  refined_grain?: boolean;
};

export type FoodSubmissionPayload = {
  name: string;
  brand?: string | null;
  barcode?: string | null;
  serving?: string | null;
  serving_grams?: number | null;
  calories: number;
  protein?: number;
  protein_g?: number;
  carbs?: number;
  carbs_g?: number;
  fat?: number;
  fat_g?: number;
  fiber?: number | null;
  fiber_g?: number | null;
  sugar?: number | null;
  sugar_g?: number | null;
  added_sugar_g?: number | null;
  sodium_mg?: number | null;
  micronutrients?: Record<string, number>;
  aliases?: string[];
  front_image_url?: string | null;
  nutrition_label_image_url?: string | null;
  source_context?: 'manual' | 'barcode' | 'label_photo' | 'search_gap' | string;
  raw_payload?: Record<string, any>;
};

export type FoodSubmission = FoodSearchResult & {
  id: number;
  status: 'pending' | 'approved' | 'rejected' | string;
  source_context: string;
  linked_food_id?: number | null;
  aliases?: string[];
  front_image_url?: string | null;
  nutrition_label_image_url?: string | null;
  review_note?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  reviewed_at?: string | null;
};

export type ScannedFoodResult = FoodSearchResult & {
  preparation?: string;
  estimated_grams?: number;
  gram_range_low?: number;
  gram_range_high?: number;
  portion_confidence?: 'high' | 'medium' | 'low' | string;
  nutrition_source?: string;
  nutrition_confidence?: 'high' | 'medium' | 'low' | string;
  calorie_range?: { low: number; high: number };
  review_hint?: string;
  source_context?: string;
  context_inferred?: boolean;
};

/** Search food nutrition info by name. Local/recent foods rank first,
 *  USDA fills broad results, and forceAi asks the AI fallback directly. */
export async function searchFoodNutrition(
  token: string,
  query: string,
  opts?: { forceAi?: boolean; allowAiFallback?: boolean },
): Promise<{ results: FoodSearchResult[]; sources?: { local: number; usda: number; ai: number; fatsecret?: number }; preferred_foods?: string[] }> {
  const params = new URLSearchParams({
    q: query,
    include_remote: 'true',
    force_ai: String(opts?.forceAi ?? false),
    allow_ai: String(opts?.allowAiFallback ?? true),
  });
  return request<any>(`/foods/search?${params.toString()}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  }, 45000);
}

export async function submitFoodToCatalog(
  token: string,
  payload: FoodSubmissionPayload,
): Promise<FoodSubmission> {
  return request<any>('/foods/submissions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 12000);
}

export async function listFoodSubmissions(
  token: string,
  status?: string,
): Promise<{ submissions: FoodSubmission[] }> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  const query = params.toString();
  return request<any>(`/foods/submissions${query ? `?${query}` : ''}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  }, 10000);
}

export async function addPreferredFood(
  token: string,
  name: string,
): Promise<{ foods_available: string[] }> {
  return request<any>('/foods/preferred', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  }, 10000);
}

export type FoodClassificationResult = {
  name: string;
  protein_source: string;
  fermented: boolean;
  probiotic: boolean;
  omega3_rich: boolean;
  plant_count: number;
  food_quality: string;
  processing_bucket?: string;
  seafood?: boolean;
  fruit?: boolean;
  vegetable?: boolean;
  alcohol?: boolean;
  processed_meat?: boolean;
  refined_grain?: boolean;
};

export async function classifyFoods(
  token: string,
  names: string[],
  opts?: { allowAi?: boolean },
): Promise<{ classifications: FoodClassificationResult[] }> {
  return request<any>('/ai/classify-foods', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ names, allow_ai: opts?.allowAi ?? true }),
  }, 45000);
}

/** Enrich food items with micronutrients. Used for routine/custom foods
 *  that bypass normal plan gen enrichment. */
export async function enrichFoodItems(
  token: string,
  items: Array<{ name: string; quantity?: number; unit?: string; calories?: number }>,
): Promise<{ items: Array<{ name: string; micronutrients: Record<string, number> }> }> {
  return request<any>('/ai/plans/enrich-items', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ items }),
  }, 15000, true);
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

/** Parse a workout screenshot/photo into review-first session candidates. */
export async function parseWorkoutPhoto(
  token: string,
  photoBase64: string,
  mimeType = 'image/jpeg',
  options: { userContext?: string; templateMode?: boolean } = {},
): Promise<{ sessions: Array<{ date: string; focus: string; completed: boolean; durationSeconds: number; exercises: any[]; distanceMiles?: number; caloriesBurned?: number; avgHeartRate?: number; source?: string }> }> {
  return parseWorkoutPhotos(
    token,
    [{ base64: photoBase64, mimeType }],
    options,
  );
}

/** Parse one or more workout screenshots/photos in a single AI pass. */
export async function parseWorkoutPhotos(
  token: string,
  photos: Array<{ base64: string; mimeType?: string | null }>,
  options: { userContext?: string; templateMode?: boolean } = {},
): Promise<{ sessions: Array<{ date: string; focus: string; completed: boolean; durationSeconds: number; exercises: any[]; distanceMiles?: number; caloriesBurned?: number; avgHeartRate?: number; source?: string }> }> {
  const clean = photos
    .map(p => ({ base64: String(p.base64 || '').trim(), mimeType: p.mimeType || 'image/jpeg' }))
    .filter(p => p.base64)
    .slice(0, 6);
  return request<any>('/ai/parse-workouts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      text: options.templateMode ? 'Workout template screenshot import' : 'Workout screenshot import',
      currentDate: new Date().toISOString().slice(0, 10),
      photo_base64_list: clean.map(p => p.base64),
      photo_mime_types: clean.map(p => p.mimeType),
      user_context: options.userContext || undefined,
      template_mode: !!options.templateMode,
    }),
  }, clean.length > 1 ? 60000 : 45000);
}

/** Parse a workout PDF or image file into review-first session/template candidates. */
export async function parseWorkoutFile(
  token: string,
  payload: {
    fileBase64: string;
    mimeType?: string | null;
    filename?: string | null;
    userContext?: string;
    templateMode?: boolean;
  },
): Promise<{ sessions: Array<{ date: string; focus: string; completed: boolean; durationSeconds: number; exercises: any[]; distanceMiles?: number; caloriesBurned?: number; avgHeartRate?: number; source?: string }> }> {
  return request<any>('/ai/parse-workouts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      text: payload.templateMode ? 'Workout template file import' : 'Workout file import',
      currentDate: new Date().toISOString().slice(0, 10),
      file_base64: payload.fileBase64,
      file_mime_type: payload.mimeType || undefined,
      filename: payload.filename || undefined,
      user_context: payload.userContext || undefined,
      template_mode: !!payload.templateMode,
    }),
  }, 60000);
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

  const resp = await request<{ answer: string; quick_cues: string[]; adjustment: string; safety_note: string }>('/coach/workout-question', {
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
  payload: { image_base64: string; mime_type?: string; context?: string },
): Promise<{
  meal_name: string;
  items: string[];
  item_details?: ScannedFoodResult[];
  foods?: ScannedFoodResult[];
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  calorie_range?: { low: number; high: number };
  estimation_method?: string;
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
    // Trusted server-side context — improves identification/disambiguation
    // without letting it override clearly visible foods.
    meal_slot?: string;
    dietary_preference?: string;
    allergies?: string[];
  },
): Promise<{
  foods: ScannedFoodResult[];
  calorie_range?: { low: number; high: number };
  estimation_method?: string;
}> {
  return request('/ai/scan-foods', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 60000, false, true);
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
  effectivenessConfidence?: 'high' | 'medium' | 'low';
  dose?: string;
  timing?: string;
  goodFor?: string[];
  cautions?: string;
  commonUses?: string[] | null;
  deficiencyRisks?: string[] | null;
  excessRisks?: string[] | null;
  foodSources?: string[] | null;
  nutrient_content?: NutrientContent | null;
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

/** One row of a parsed Supplement Facts panel. */
export type NutrientFact = {
  key?: string;
  nutrient: string;
  amount: number;
  unit: string;
  percent_dv?: number | null;
};

/** Structured Supplement Facts panel extracted from a label scan.
 *  Credited toward micronutrient coverage server-side. */
export type NutrientContent = {
  serving_size?: { count?: number | null; unit?: string | null } | null;
  nutrients: NutrientFact[];
  parse_source?: string;
};

export type ScannedSupplement = {
  name: string;
  category: string;
  dose_amount: number | null;
  dose_unit: string;
  evidence_tier: 'strong' | 'moderate' | 'limited' | 'weak';
  risk_tier: 'low' | 'moderate' | 'high';
  description?: string | null;
  effectiveness_confidence?: 'high' | 'medium' | 'low' | null;
  timing_notes?: string | null;
  safety_notes?: string | null;
  common_uses?: string[] | null;
  deficiency_risks?: string[] | null;
  excess_risks?: string[] | null;
  food_sources?: string[] | null;
  source_terms?: string[] | null;
  nutrient_content?: NutrientContent | null;
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

export type LabScanCandidate = HealthLabResultPayload & {
  lab_label: string;
  unit: string;
  value: number;
  collected_at?: string | null;
  source: 'scan';
  confidence?: 'high' | 'medium' | 'low' | string;
};

export async function scanLabReport(
  token: string,
  payload: {
    image_base64?: string;
    file_base64?: string;
    mime_type?: string;
    filename?: string;
  },
): Promise<{
  report_collected_at?: string | null;
  labs: LabScanCandidate[];
  count: number;
  warnings?: string[];
  disclaimer?: string;
}> {
  return request('/ai/scan-labs', {
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
  processing_bucket?: 'minimally_processed' | 'processed' | 'ultra_processed' | 'unknown' | string;
  food_quality?: 'whole' | 'processed' | 'unknown' | string;
  protein_source?: 'plant' | 'animal' | 'mixed' | 'none' | 'unknown' | string;
  fermented?: boolean;
  probiotic?: boolean;
  omega3_rich?: boolean;
  plant_count?: number;
  seafood?: boolean;
  fruit?: boolean;
  vegetable?: boolean;
  alcohol?: boolean;
  processed_meat?: boolean;
  refined_grain?: boolean;
};

/** Two-stage speech-to-meal: audio → transcript → structured
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
  }, 60000, true);
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
  effectivenessConfidence?: 'high' | 'medium' | 'low';
  dose?: string;
  timing?: string;
  goodFor?: string[];
  cautions?: string;
  commonUses?: string[] | null;
  deficiencyRisks?: string[] | null;
  excessRisks?: string[] | null;
  foodSources?: string[] | null;
}> {
  return request('/ai/supplement-info', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
}

/** Pass `images: [b64, b64, ...]` for a multi-photo gym walkthrough (much
 *  higher recall than a single shot — AI sees multiple corners of the gym
 *  and deduplicates). The legacy `image_base64` shape still works for
 *  older callers / older app builds. */
export async function scanEquipmentPhoto(
  token: string,
  payload: { images?: string[]; image_base64?: string; mime_type?: string },
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
    caloriesBurned?: number;
    hrSummary?: { avgBpm: number; maxBpm: number; zoneMinutes: number[] };
    prs?: PRAchievement[];
  },
): Promise<import('../types').WorkoutSummary> {
  return request('/ai/workout-summary', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 10000, true);
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
    primaryMuscle?: string | null;
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
  algorithmSource?: 'deterministic_progression' | string;
  dataSource?: string;
  trace?: Record<string, any> | null;
  aiSafety?: RecommendationAiSafety | null;
}> {
  return request('/recommendations/pre-set', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 8000, true);
}

export async function getRecommendationAiSafetyStatus(
  token: string,
  cacheKey: string,
): Promise<RecommendationAiSafety> {
  return request(`/recommendations/ai-safety/${encodeURIComponent(cacheKey)}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 2500, true);
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
  id?: string | number;
  scan_date?: string;
  date?: string;
  bodyFatPct: number;
  bodyFatRange: string;
  muscleMass: string;
  category: string;
  strengths: string[];
  improvements: string[];
  assessment: string;
  disclaimer: string;
  confidence?: 'high' | 'medium' | 'low' | string;
  photoQuality?: 'good' | 'usable' | 'poor' | string;
  qualityFlags?: string[];
  needsRetake?: boolean;
  sensitivePhoto?: boolean;
  photoHidden?: boolean;
  method?: string;
  visualEstimatePct?: number | null;
  measurementEstimatePct?: number | null;
}

// ─── Meal history ────────────────────────────────────────────────────────────

export interface MealHistoryItem {
  food_name: string;
  food_id?: number | null;
  serving_id?: number | null;
  serving_grams?: number | null;
  source?: string | null;
  fdc_id?: string | null;
  external_id?: string | null;
  barcode?: string | null;
  brand?: string | null;
  is_verified?: boolean | null;
  quantity: number;
  unit: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  saturated_fat_g?: number | null;
  cholesterol_mg?: number | null;
  sodium_mg?: number | null;
  fiber_g?: number | null;
  sugar_g?: number | null;
  added_sugar_g?: number | null;
  caffeine_mg?: number | null;
  potassium_mg?: number | null;
  calcium_mg?: number | null;
  magnesium_mg?: number | null;
  iron_mg?: number | null;
  vitamin_d_mcg?: number | null;
  vitamin_b12_mcg?: number | null;
  folate_mcg?: number | null;
  zinc_mg?: number | null;
  omega_3_g?: number | null;
  micronutrients?: Record<string, number> | null;
  processing_bucket?: 'minimally_processed' | 'processed' | 'ultra_processed' | 'unknown' | string | null;
  food_quality?: 'whole' | 'processed' | 'unknown' | string | null;
  protein_source?: 'plant' | 'animal' | 'mixed' | 'none' | 'unknown' | string | null;
  fermented?: boolean | null;
  probiotic?: boolean | null;
  omega3_rich?: boolean | null;
  plant_count?: number | null;
  processed_meat?: boolean | null;
}

export interface MealHistoryEntry {
  id: number;
  meal_date: string;
  meal_type: string | null;
  name: string;
  source: string | null;
  saved_meal_id?: number | null;
  client_meal_key?: string | null;
  consumed_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  version?: number | null;
  // Template/routine provenance (refactor: templates vs instances). The
  // logged row is always its own snapshot; these are for traceability only.
  source_type?: string | null;            // "manual" | "favorite" | "routine" | "plan"
  source_routine_id?: number | null;
  routine_occurrence_key?: string | null;
  idempotency_key?: string | null;
  items: MealHistoryItem[];
  totals: { calories: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g?: number | null };
  /** Optional meal-level image. NULL = no image; client falls back to
   *  category icon via src/utils/foodImage.ts. `image_source` is one of
   *  "user_photo" | "recipe" | "pexels" | "product" | "asset" | "category". */
  image_url?: string | null;
  image_source?: string | null;
}

export interface MealPageResponse {
  meal: MealHistoryEntry & { version?: number | null; updated_at?: string | null };
  viewer: {
    is_favorite: boolean;
    can_edit: boolean;
    saved_meal_id?: number | null;
    last_logged_at?: string | null;
    user_specific_notes?: string | null;
  };
  logs: MealHistoryEntry[];
  permissions: {
    can_edit: boolean;
    can_delete: boolean;
    can_favorite: boolean;
    can_log: boolean;
  };
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
  payload: { meal_date: string; meal_type: string; client_meal_key?: string; meal: Record<string, any>; source?: string; consumed_at?: string; idempotency_key?: string },
): Promise<{ id: number; client_meal_key?: string | null; consumed_at?: string | null }> {
  const result = await request<{ id: number; client_meal_key?: string | null; consumed_at?: string | null }>('/meals/log-checked', {
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

export async function unlogMealChecked(
  token: string,
  payload: { meal_date: string; meal_type: string; client_meal_key?: string; meal: Record<string, any>; source?: string },
): Promise<{ deleted: number; meal_date: string }> {
  return request('/meals/unlog-checked', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }, 10000, true);
}

export async function getMealHistory(token: string, days = 30, limit = 100): Promise<{ meals: MealHistoryEntry[] }> {
  return requestRead(`/meals/history?days=${days}&limit=${limit}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, 0, null);
}

/** Hard-delete a logged meal by its backend Meal id. The matching MealItem
 *  rows are cascaded; daily nutrition metrics are recomputed for that
 *  date so the score / averages reflect the deletion immediately. Used
 *  by the History tab's per-meal trash button. */
export async function deleteLoggedMeal(token: string, mealId: number): Promise<void> {
  try {
    await request(`/meals/${mealId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err: any) {
    const message = String(err?.message ?? err ?? '').toLowerCase();
    if (message.includes('meal not found')) {
      invalidateReadCacheAfterMutation('DELETE', `/meals/${mealId}`, token);
      return;
    }
    throw err;
  }
}

export async function getMealPage(token: string, mealId: number): Promise<MealPageResponse> {
  return requestRead(`/meals/${mealId}/page`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, 0, null);
}

export async function favoriteMeal(token: string, mealId: number): Promise<MealPageResponse> {
  return request(`/meals/${mealId}/favorite`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function unfavoriteMeal(token: string, mealId: number): Promise<MealPageResponse> {
  return request(`/meals/${mealId}/favorite`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getMealAverages(token: string, window = 7): Promise<MealAverages> {
  return requestRead(`/meals/averages?window=${window}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, 10000);
}

export async function getMealInsights(token: string): Promise<{ insights: string[]; patterns: Record<string, any> }> {
  return requestRead('/meals/insights', {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, 30000);
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
  /** Prebiotic (fermentable) fiber grams from today's logged items. */
  prebiotic_g?: number;
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
  avg_fermented_servings?: number;
  probiotic_servings: number;
  avg_probiotic_servings?: number;
  omega3_servings: number;
  avg_omega3_servings?: number;
  omega3_food_servings?: number;
  omega3_supplement_servings?: number;
  /** AI-estimated collagen grams across the full window. */
  collagen_g: number;
  /** AI-estimated average collagen grams per logged day. */
  avg_collagen_g: number;
  /** AI-estimated probiotic CFU across the full window, in billions. */
  probiotic_cfu_billions?: number;
  /** AI-estimated average probiotic CFU per logged day, in billions. */
  avg_probiotic_cfu_billions?: number;
  /** Prebiotic fiber grams across the full window. */
  prebiotic_g?: number;
  /** Average prebiotic fiber grams per logged day. */
  avg_prebiotic_g?: number;
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
  return requestRead(`/meals/gut-health?days=${days}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, 10000);
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

// Unified Nutrition Score — server-side authority for the projected day plan.
export interface NutritionScoreBreakdownItem {
  label: string;
  value_pct: number;     // 0-100 for bar
  raw: number;
  target: number | null;
  target_min?: number | null;
  target_max?: number | null;
  unit: string;
  on_track: boolean;
}

export type NutritionLogStatus = 'unknown' | 'partial' | 'rough_estimate' | 'complete';

export interface NutritionLogCompleteness {
  status: NutritionLogStatus;
  confidence: number;
  source: string;
  reason: string;
  meals_logged: number;
  expected_meals: number;
  logged_calories: number;
  calorie_target: number | null;
  usable_for_recovery: boolean;
}

export interface NutritionScoreToday {
  date: string;
  score: number;
  source?: 'projected' | 'logged' | 'empty';
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
  completeness?: NutritionLogCompleteness;
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
  source?: 'projected' | 'logged' | 'empty';
  adherence?: number;
  quality?: number;
  micro?: number;
  logged: boolean;
  completeness?: NutritionLogCompleteness;
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
  return requestRead(`/meals/score?days=${days}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, 10000);
}

export interface AdjustedDailyTarget {
  base_daily_target: number;
  adjusted_calories: number;
  adjustment_applied: number;
  weekly_adjustment_applied?: number;
  // Raw over/under-budget calorie totals from the prior days in this
  // ISO week. Used by DailyTargetAdjustmentBanner to write specific
  // "you went ~N over Mon-Wed" copy instead of vague "based on earlier
  // days" text. `weekly_valid_days` reports how many of the past days
  // had enough data to count toward the smoothing (a partial-log day
  // is ignored).
  weekly_over_budget_kcal?: number;
  weekly_under_budget_kcal?: number;
  weekly_valid_days?: number;
  activity_adjustment_applied?: number;
  // Newer aliases — same values as activity_adjustment_applied / activity_calories_burned
  // but matching the explicit naming used in the heavy-day breakdown.
  activity_adjustment_kcal?: number;
  activity_workout_adjustment_kcal?: number;
  activity_neat_adjustment_kcal?: number;
  activity_total_burned_kcal?: number;
  activity_calories_burned?: number;
  activity_duration_minutes?: number;
  activity_workout_count?: number;
  activity_at_cap?: boolean;
  is_heavy_training_day?: boolean;
  // 'none' | 'workout' | 'workout_heavy' | 'workout_neat' | 'neat'
  activity_adjustment_reason?: string;
  at_cap: boolean;
  days_remaining: number;
  weekly_budget_remaining: number;
  calories_logged_so_far?: number;
  calories_logged_before_date?: number;
  weekly_smoothing_basis?: 'prior_days' | string;
  weekly_smoothing_locked_for_date?: boolean;
  weekly_smoothing_cutoff_date?: string | null;
  target_day_type?: 'heavy' | 'leg' | 'hard' | 'standard' | 'easy' | 'rest' | string | null;
  note: string | null;
  activity_note?: string | null;
  nutrition_target_explanation?: string | null;
  formula_daily_target?: number;
  resolved_daily_target?: number;
  maintenance_calories?: number;
  goal_adjustment_kcal?: number;
  goal_adjustment_pct?: number | null;
  goal_pace_label?: string | null;
  coaching_adjustment_kcal?: number;
  health_basal_adjustment_kcal?: number;
  health_basal_target_adjustment_kcal?: number;
  health_energy_adjustment_kcal?: number;
  rolling_health_activity_adjustment_kcal?: number;
  day_type_adjustment_kcal?: number;
  same_day_activity_refuel?: number;
  workout_day_type?: string | null;
  protein_basis_lbs?: number | null;
  protein_factor?: number | null;
  fat_percent?: number | null;
  fat_floor_g?: number | null;
  warnings?: string[];
  target_basis?: {
    goal?: string | null;
    goal_type?: string | null;
    goal_pace?: string | null;
    rate_summary?: string | null;
    formula_daily_target?: number | null;
    formula_tdee?: number | null;
    formula_tdee_kcal?: number | null;
    apple_tdee_kcal?: number | null;
    apple_valid_days?: number | null;
    maintenance_source?: string | null;
    maintenance_blend?: Record<string, any> | null;
    resolved_daily_target?: number | null;
    base_daily_target?: number | null;
    maintenance_calories?: number | null;
    goal_adjustment_kcal?: number | null;
    goal_adjustment_pct?: number | null;
    goal_pace_label?: string | null;
    coaching_adjustment_kcal?: number | null;
    health_basal_adjustment_kcal?: number | null;
    health_basal_target_adjustment_kcal?: number | null;
    health_energy_adjustment_kcal?: number | null;
    rolling_health_activity_adjustment_kcal?: number | null;
    day_type_adjustment_kcal?: number | null;
    source_bmr_kind?: string | null;
    source_bmr_kcal?: number | null;
    source_tdee_kind?: string | null;
    source_tdee_kcal?: number | null;
    bmr?: number | null;
    activity_multiplier?: number | null;
    source_weight_lbs?: number | null;
    source_weight_kind?: string | null;
    protein_basis_lbs?: number | null;
    protein_basis_kind?: string | null;
    protein_factor?: number | null;
    fat_percent?: number | null;
    fat_floor_g?: number | null;
    min_carbs_g?: number | null;
    warnings?: string[];
    health_signal?: Record<string, any> | null;
    health_energy_signal?: Record<string, any> | null;
  } | null;
  adjusted_macros: { calories?: number; protein_g: number; carbs_g: number; fat_g: number } | null;
  hydration_target_oz?: number;
  hydration_breakdown?: {
    target_oz: number;
    target_min_oz?: number;
    target_max_oz?: number;
    baseline_oz: number;
    training_addon_oz: number;
    active_energy_addon_oz: number;
    heat_addon_oz: number;
    protein_addon_oz?: number;
    alcohol_addon_oz?: number;
    intensity_bucket?: string;
    reason?: string | null;
  };
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

// Hydration — daily log + target range. The backend computes a midpoint that
// reflects weight + sex (base), planned/actual workout minutes (sweat
// replacement), today's logged protein (kidney filtration), and any
// alcohol logged (diuretic), then wraps that adapted midpoint in a soft
// daily range. `breakdown` exposes each contribution in oz so the UI can
// explain the number. All breakdown fields are integers.
export interface HydrationBreakdown {
  base: number;
  activity: number;
  protein: number;
  alcohol: number;
  target_min_oz?: number;
  target_max_oz?: number;
  training?: number;
  active_energy?: number;
  heat?: number;
  intensity?: string;
  reason?: string | null;
}
export type HydrationElectrolyteStatus = 'not_needed' | 'consider' | 'planned' | 'covered';
export interface HydrationElectrolyteGuidance {
  status: HydrationElectrolyteStatus;
  message: string | null;
  sodium_mg: number;
  has_electrolytes_in_stack: boolean;
  electrolytes_logged: boolean;
}
export interface HydrationSupplementSignals {
  electrolytes_in_stack: boolean;
  electrolytes_logged: boolean;
  creatine_in_stack: boolean;
  creatine_logged: boolean;
  caffeine_in_stack: boolean;
  caffeine_logged: boolean;
}
export interface HydrationGuidanceNote {
  key: 'high_sodium' | 'creatine' | 'caffeine' | string;
  message: string;
}
export interface HydrationGuidance {
  workout_minutes: number;
  sodium_mg: number;
  electrolytes: HydrationElectrolyteGuidance;
  supplements: HydrationSupplementSignals;
  notes: HydrationGuidanceNote[];
  active_energy_kcal?: number | null;
  workout_calories_burned?: number | null;
  activity_category?: string | null;
  activity_intensity?: string | null;
  cardio_style?: string | null;
  target_reason?: string | null;
}
export interface HydrationStatus {
  date: string;
  ounces: number;
  target_ounces: number;
  target_ounces_min?: number;
  target_ounces_max?: number;
  /** Optional — older app builds may not surface this. */
  breakdown?: HydrationBreakdown;
  /** Sodium/supplement advice. Does not change the ounce target by itself. */
  guidance?: HydrationGuidance;
}
export async function getHydration(token: string, logDate?: string): Promise<HydrationStatus> {
  const qs = logDate ? `?log_date=${encodeURIComponent(logDate)}` : '';
  return request(`/meals/hydration${qs}`, { headers: { Authorization: `Bearer ${token}` } });
}

type HydrationLogOptions = {
  commandId?: string;
};

export async function logHydration(
  token: string,
  ounces: number,
  logDate?: string,
  opts: HydrationLogOptions = {},
): Promise<{ date: string; ounces: number }> {
  return request('/meals/hydration', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ounces, ...(logDate ? { log_date: logDate } : {}), ...(opts.commandId ? { command_id: opts.commandId } : {}) }),
  });
}

// Atomic delta for quick-add buttons. Backend reads the row, adds the
// delta, and writes back in one transaction so rapid taps compose
// correctly (three +8oz taps = +24oz, not +8oz from the last write).
export async function logHydrationDelta(
  token: string,
  deltaOz: number,
  logDate?: string,
  opts: HydrationLogOptions = {},
): Promise<{ date: string; ounces: number }> {
  return request('/meals/hydration', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ delta_oz: deltaOz, ...(logDate ? { log_date: logDate } : {}), ...(opts.commandId ? { command_id: opts.commandId } : {}) }),
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
    avg_calories_when_logged?: number;
    avg_protein_g_when_logged?: number;
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
  return requestRead(`/ai/plateaus?window_weeks=${windowWeeks}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, 30000);
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
  detail_muscles?: Record<string, MuscleBalanceEntry>;
  period_days: number;
  total_sets: number;
  detail_total_sets?: number;
  balance_score: number;
}

export async function getMuscleBalance(token: string, days = 30): Promise<MuscleBalanceResult> {
  return requestRead(`/ai/muscle-balance?days=${days}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, 30000);
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
  logged_at?: string;
}

export async function getWeightEntries(token: string, opts: ListWindowOptions = { limit: 730 }): Promise<WeightEntryAPI[]> {
  const params = new URLSearchParams({ limit: String(opts.limit ?? 730) });
  if (opts.since) params.set('since', opts.since);
  if (opts.before) params.set('before', opts.before);
  return requestRead<WeightEntryAPI[]>(`/profile/weight-entries?${params}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, 30000);
}

export async function saveWeightEntryAPI(token: string, date: string, weightLbs: number, source = 'manual', loggedAt = new Date().toISOString()): Promise<void> {
  await request('/profile/weight-entries', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ date, weight_lbs: weightLbs, source, logged_at: loggedAt }),
  });
}

export async function deleteWeightEntryAPI(token: string, date: string): Promise<{ deleted: number; date: string }> {
  return request(`/profile/weight-entries/${encodeURIComponent(date)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function clearWeightEntriesAPI(token: string): Promise<{ deleted: number }> {
  return request('/profile/weight-entries', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─── Cycle Symptom Logs ─────────────────────────────────────────────────────

export type CycleSymptomLogAPI = {
  id?: string;
  date: string;
  cycleStartDate: string;
  phase: 'menses' | 'follicular' | 'ovulation' | 'luteal' | 'unknown';
  dayOfCycle: number | null;
  cycleLengthDays: number | null;
  flow: 'unspecified' | 'light' | 'moderate' | 'heavy';
  cramps: 'none' | 'mild' | 'moderate' | 'severe';
  energy: 'low' | 'normal' | 'high';
  action?: 'keep' | 'lighter' | 'recovery' | null;
  updatedAt: string;
};

export async function listCycleSymptomLogs(
  token: string,
  opts: ListWindowOptions = { limit: 120 },
): Promise<CycleSymptomLogAPI[]> {
  const params = new URLSearchParams({ limit: String(opts.limit ?? 120) });
  if (opts.since) params.set('since', opts.since);
  if (opts.before) params.set('before', opts.before);
  return requestRead<CycleSymptomLogAPI[]>(`/profile/cycle-logs?${params}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, 30000);
}

export async function saveCycleSymptomLog(
  token: string,
  log: CycleSymptomLogAPI,
): Promise<CycleSymptomLogAPI> {
  return request<CycleSymptomLogAPI>('/profile/cycle-logs', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(log),
  });
}

// ─── Body Scan History ──────────────────────────────────────────────────────

export interface BodyScanHistoryItem {
  id: string;
  date: string | null;
  scan_date: string | null;
  bodyFatPct: number | null;
  bodyFatRange: string | null;
  muscleMass: string | null;
  category: string | null;
  strengths: string[];
  improvements: string[];
  assessment: string | null;
  disclaimer: string | null;
  confidence?: string | null;
  photoQuality?: string | null;
  qualityFlags?: string[];
  needsRetake?: boolean;
  sensitivePhoto?: boolean;
  photoHidden?: boolean;
  method?: string | null;
  visualEstimatePct?: number | null;
  measurementEstimatePct?: number | null;
  weightLbs: number | null;
}

export async function getBodyScanHistory(token: string): Promise<BodyScanHistoryItem[]> {
  const result = await request<BodyScanHistoryItem[] | { scans?: BodyScanHistoryItem[] }>('/ai/body-scans', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  return Array.isArray(result) ? result : (result.scans ?? []);
}

export async function deleteBodyScan(token: string, scanId: string | number): Promise<{ deleted: number; id: string }> {
  return request(`/ai/body-scans/${encodeURIComponent(String(scanId))}`, {
    method: 'DELETE',
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
  saturated_fat_g?: number | null;
  cholesterol_mg?: number | null;
  sodium_mg?: number | null;
  fiber_g?: number | null;
  sugar_g?: number | null;
  added_sugar_g?: number | null;
  caffeine_mg?: number | null;
  potassium_mg?: number | null;
  calcium_mg?: number | null;
  magnesium_mg?: number | null;
  iron_mg?: number | null;
  vitamin_d_mcg?: number | null;
  vitamin_b12_mcg?: number | null;
  folate_mcg?: number | null;
  zinc_mg?: number | null;
  omega_3_g?: number | null;
  micronutrients?: Record<string, number> | null;
};

export type SavedMeal = {
  id: number;
  user_id: number;
  source_meal_id?: number | null;
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
  image_url?: string | null;
  image_source?: string | null;
  share_code?: string | null;
  times_imported?: number;
  source_share_code?: string | null;
  source_owner_username?: string | null;
};

export type SharedSavedMealPreview = SavedMeal & {
  owner_username?: string | null;
  owned_by_viewer?: boolean;
};

export async function listSavedMeals(token: string): Promise<SavedMeal[]> {
  return request('/meals/saved', { headers: { Authorization: `Bearer ${token}` } });
}

export async function createSavedMeal(
  token: string,
  body: { name: string; notes?: string | null; items?: SavedMealItem[]; from_meal_id?: number; image_url?: string | null; image_source?: string | null; resolve_image?: boolean; idempotency_key?: string },
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

/** Edit the saved-meal template. Logged meals keep their original name
 *  and item/macro snapshots; the saved template changes for future logs. */
export async function updateSavedMeal(
  token: string,
  savedId: number,
  patch: { name?: string; notes?: string | null; items?: SavedMealItem[]; image_url?: string | null; image_source?: string | null },
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
  body: { meal_date?: string; meal_type?: string; consumed_at?: string; idempotency_key?: string },
): Promise<{ meal_id: number; saved_meal_id: number; times_logged: number }> {
  return request(`/meals/saved/${savedId}/log`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export async function shareSavedMeal(
  token: string,
  savedId: number,
): Promise<{ shareCode: string; savedMeal: SavedMeal }> {
  return request(`/meals/saved/${savedId}/share`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function revokeSavedMealShare(token: string, savedId: number): Promise<void> {
  await request(`/meals/saved/${savedId}/share`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function previewSharedSavedMeal(
  token: string,
  code: string,
): Promise<SharedSavedMealPreview> {
  return request(`/meals/saved/shared/${encodeURIComponent(code)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function importSharedSavedMeal(
  token: string,
  code: string,
): Promise<SavedMeal> {
  return request(`/meals/saved/shared/${encodeURIComponent(code)}/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}


// ─── Meal Routines (backend-owned recurring templates) ────────────────────────
//
// Server successor to the old AsyncStorage-only `mealRoutines` list. A
// routine is a TEMPLATE; logging an occurrence creates one Meal row, deduped
// by (user, routine, occurrence_key). See backend routers/meal_routines.py.

export type MealRoutineItem = {
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

export type MealRoutine = {
  id: number;
  user_id: number;
  name: string;
  notes?: string | null;
  meal_type?: string | null;
  days_of_week: number[];
  default_time?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  active: boolean;
  source_template_id?: number | null;
  display_order: number;
  total_calories: number;
  total_protein_g: number;
  total_carbs_g: number;
  total_fat_g: number;
  items: MealRoutineItem[];
  created_at: string;
  updated_at: string;
};

export type MealRoutineInput = {
  name: string;
  notes?: string | null;
  meal_type?: string | null;
  days_of_week?: number[];
  default_time?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  active?: boolean;
  source_template_id?: number | null;
  display_order?: number;
  items?: MealRoutineItem[];
  idempotency_key?: string | null;
};

export async function listMealRoutines(token: string, includeInactive = false): Promise<MealRoutine[]> {
  return request(`/meals/routines?include_inactive=${includeInactive ? 'true' : 'false'}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function createMealRoutineApi(token: string, body: MealRoutineInput): Promise<MealRoutine> {
  return request('/meals/routines', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

/** PATCH the routine template in place — never duplicates the routine, never
 *  rewrites already-logged meals. */
export async function updateMealRoutineApi(token: string, routineId: number, patch: Partial<MealRoutineInput>): Promise<MealRoutine> {
  return request(`/meals/routines/${routineId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(patch),
  });
}

/** Archive (soft-delete) the routine. Historical logs are kept. */
export async function deleteMealRoutineApi(token: string, routineId: number): Promise<{ archived: number }> {
  return request(`/meals/routines/${routineId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Log one routine occurrence as a single Meal. Idempotent on
 *  (routine, occurrence_key) so a double tap never duplicates. */
export async function logMealRoutineOccurrence(
  token: string,
  routineId: number,
  body: { occurrence_date?: string; occurrence_key?: string; meal_type?: string; consumed_at?: string; idempotency_key?: string },
): Promise<{ meal_id: number; source_routine_id: number; routine_occurrence_key: string; deduped: boolean }> {
  return request(`/meals/routines/${routineId}/log`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

/** Edit a single day of a routine. If that day is already logged it updates
 *  the Meal; otherwise it writes a one-day exception. Never edits the base
 *  routine. */
export async function updateMealRoutineOccurrence(
  token: string,
  routineId: number,
  body: { occurrence_date: string; occurrence_key?: string; name?: string; items?: MealRoutineItem[]; override_time?: string; skipped?: boolean },
): Promise<Record<string, any>> {
  return request(`/meals/routines/${routineId}/occurrence`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}


// ─── Workout Templates ──────────────────────────────────────────────────────
//
// User-authored single-day workouts that live on the backend (table
// `workout_templates`). The mobile cache (AsyncStorage key
// `workoutTemplates`) is a hot mirror of this — see src/utils/workoutTemplates.ts.

export type WorkoutTemplateRecord = {
  id: string;                       // client_id (uuid)
  name: string;
  workout: WorkoutDay;
  notes?: string | null;
  shareCode: string | null;
  timesImported: number;
  sourceShareCode: string | null;
  sourceOwnerUsername: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SharedWorkoutTemplatePreview = WorkoutTemplateRecord & {
  ownerUsername: string | null;
};

export async function listWorkoutTemplates(token: string): Promise<WorkoutTemplateRecord[]> {
  return request('/workouts/templates', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Idempotent on (user, id) — create OR update; the server matches by
 *  client_id and merges. Use this for the optimistic-write path. */
export async function upsertWorkoutTemplate(
  token: string,
  body: { id: string; name: string; workout: WorkoutDay; notes?: string | null },
): Promise<WorkoutTemplateRecord> {
  return request('/workouts/templates', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export async function updateWorkoutTemplate(
  token: string,
  id: string,
  body: { id: string; name: string; workout: WorkoutDay; notes?: string | null },
): Promise<WorkoutTemplateRecord> {
  return request(`/workouts/templates/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export async function deleteWorkoutTemplate(token: string, id: string): Promise<void> {
  await request(`/workouts/templates/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function shareWorkoutTemplate(
  token: string,
  id: string,
): Promise<{ shareCode: string; template: WorkoutTemplateRecord }> {
  return request(`/workouts/templates/${encodeURIComponent(id)}/share`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function revokeWorkoutTemplateShare(token: string, id: string): Promise<void> {
  await request(`/workouts/templates/${encodeURIComponent(id)}/share`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function previewSharedWorkoutTemplate(
  token: string,
  code: string,
): Promise<SharedWorkoutTemplatePreview> {
  return request(`/workouts/templates/shared/${encodeURIComponent(code)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function importSharedWorkoutTemplate(
  token: string,
  code: string,
  clientId: string,
): Promise<WorkoutTemplateRecord> {
  return request(`/workouts/templates/shared/${encodeURIComponent(code)}/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ clientId }),
  });
}


// ─── Workout Template Bundles (multi-template share) ────────────────────────
//
// A bundle is a named collection of share codes. Bundle codes are 8 chars
// (vs the 6-char per-template code) so the import sheet can disambiguate
// by length. See backend/app/routers/workout_templates.py for the full
// model + endpoints.

/** One template's preview slot inside a bundle. `available:false` rows
 *  are tombstones — the underlying template was deleted or its share
 *  code was revoked, but the bundle still references it. UI should grey
 *  these out and exclude them from the import selection. */
export type SharedWorkoutTemplateBundleItem =
  | {
      shareCode: string;
      available: true;
      name: string;
      notes?: string | null;
      workout: WorkoutDay;
      ownerUsername: string | null;
    }
  | {
      shareCode: string;
      available: false;
      name: null;
      workout: null;
      ownerUsername: null;
    };

export type SharedWorkoutTemplateBundle = {
  bundleCode: string;
  name: string;
  ownerUsername: string | null;
  ownedByViewer: boolean;
  timesImported: number;
  items: SharedWorkoutTemplateBundleItem[];
  createdAt: string;
  updatedAt: string;
};

/** Each `skipped` row carries a machine-readable `reason` so the UI can
 *  surface why a particular item didn't import (already owned, server
 *  couldn't find the share code, etc.) without parsing English. */
export type ImportSharedWorkoutTemplateBundleResult = {
  bundleCode: string;
  imported: WorkoutTemplateRecord[];
  skipped: Array<{ shareCode: string; reason: 'already_owner' | 'not_found' | string }>;
};

export async function createWorkoutTemplateBundle(
  token: string,
  body: { name: string; templateIds: string[] },
): Promise<SharedWorkoutTemplateBundle> {
  return request('/workouts/templates/bundles', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export async function previewSharedWorkoutTemplateBundle(
  token: string,
  code: string,
): Promise<SharedWorkoutTemplateBundle> {
  return request(`/workouts/templates/bundles/shared/${encodeURIComponent(code)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function importSharedWorkoutTemplateBundle(
  token: string,
  code: string,
  items: Array<{ shareCode: string; clientId: string }>,
): Promise<ImportSharedWorkoutTemplateBundleResult> {
  return request(`/workouts/templates/bundles/shared/${encodeURIComponent(code)}/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ items }),
  });
}


// ─── Manual mode (Pro-only) ─────────────────────────────────────────────────

export type ManualModeState = {
  workout_manual_mode: boolean;
  meal_manual_mode: boolean;
  future_days_cleared?: number;
};

export async function setManualMode(
  token: string,
  body: { workout_manual_mode?: boolean; meal_manual_mode?: boolean },
): Promise<ManualModeState> {
  return request('/profile/preferences/manual-mode', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export type ManualPlanDayResponse = {
  plan_week_id: number;
  day_index: number;
  day_date: string;
  status: string;
  is_rest: boolean;
  workout_json: WorkoutDay | null;
  locked: boolean;
  lock_reason: string | null;
  generation_source: string;
  source_template_id?: string | null;
  source_template_name?: string | null;
};

export async function useTemplateForPlanDay(
  token: string,
  planWeekId: number,
  dayIndex: number,
  templateId: string,
): Promise<ManualPlanDayResponse> {
  return request(`/plan-weeks/${planWeekId}/days/${dayIndex}/use-template`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ template_id: templateId }),
  });
}

export async function clearPlanDay(
  token: string,
  planWeekId: number,
  dayIndex: number,
): Promise<ManualPlanDayResponse> {
  return request(`/plan-weeks/${planWeekId}/days/${dayIndex}/clear`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function markPlanDayRest(
  token: string,
  planWeekId: number,
  dayIndex: number,
  isRest: boolean = true,
): Promise<ManualPlanDayResponse> {
  return request(`/plan-weeks/${planWeekId}/days/${dayIndex}/mark-rest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ is_rest: isRest }),
  });
}

export type ManualGeneratedWorkoutFocus =
  | 'push' | 'pull' | 'legs'
  | 'upper' | 'lower' | 'full_body'
  | 'cardio' | 'mobility' | 'recovery';

export type ManualGeneratedWorkoutStimulus = 'balanced' | 'heavy' | 'pump';

export async function generateWorkoutForPlanDay(
  token: string,
  planWeekId: number,
  dayIndex: number,
  body: {
    focus: ManualGeneratedWorkoutFocus;
    stimulus?: ManualGeneratedWorkoutStimulus;
    session_minutes?: number | null;
  },
): Promise<ManualPlanDayResponse> {
  return request(`/plan-weeks/${planWeekId}/days/${dayIndex}/generate-workout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }, 15000);
}


// ─── AI evaluate-week (Pro) ─────────────────────────────────────────────────

export type WeekEvaluation = {
  headline: string;
  summary: string;
  observations: Array<{ kind: 'win' | 'gap' | 'note'; text: string }>;
  suggestions: string[];
  _payload?: {
    goal: string;
    mode: 'auto' | 'manual';
    review: {
      week_start?: string;
      week_end?: string;
      sessions_completed?: number;
      sessions_planned?: number;
      adherence_pct?: number;
      cardio_minutes?: number;
      headline?: string;
    };
    manual_meta?: {
      assigned_days: number;
      completed_days: number;
      unassigned_days: number;
      rest_days: number;
    };
  };
  _model?: string;
};

export async function evaluateWeek(
  token: string,
  body: { end_date?: string; days?: number } = {},
): Promise<WeekEvaluation> {
  return request('/coach/evaluate-week', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}


// ─── AI evaluate-meal-day (Pro) ─────────────────────────────────────────────

export type MealDayEvaluation = {
  headline: string;
  summary: string;
  observations: Array<{ kind: 'win' | 'gap' | 'note'; text: string }>;
  suggestions: string[];
  /** Echoed structured payload the AI saw — handy for debugging the
   *  result + understanding why it said what it said. */
  _payload?: {
    date: string;
    goal: string;
    targets: { calories: number; protein_g: number; carbs_g: number; fat_g: number };
    actuals: { calories: number; protein_g: number; carbs_g: number; fat_g: number };
    meal_count: number;
  };
  _model?: string;
};

export async function evaluateMealDay(
  token: string,
  body: {
    target_date: string;
    targets?: { calories: number; protein_g: number; carbs_g: number; fat_g: number };
  },
): Promise<MealDayEvaluation> {
  return request('/coach/evaluate-meal-day', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}


// ─── Meal editing (patch consumed_at / meal_type) ────────────────────────────

export async function updateMeal(
  token: string,
  mealId: number,
  patch: { meal_type?: string; consumed_at?: string | null; notes?: string | null; name?: string; items?: MealHistoryItem[]; version?: number | null; expected_version?: number | null },
): Promise<MealPageResponse> {
  return request(`/meals/${mealId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(patch),
  });
}

export async function copyLoggedMeal(
  token: string,
  mealId: number,
  body: {
    meal_date?: string;
    meal_type?: string;
    consumed_at?: string | null;
    name?: string;
    notes?: string | null;
    quantity_scale?: number;
    idempotency_key?: string;
  } = {},
): Promise<any> {
  return request(`/meals/${mealId}/copy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export async function splitLoggedMeal(
  token: string,
  mealId: number,
  body: {
    keep_fraction?: number;
    remaining_meal_date?: string;
    remaining_meal_type?: string;
    remaining_consumed_at?: string | null;
    remaining_name?: string;
  } = {},
): Promise<any> {
  return request(`/meals/${mealId}/split`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}


// ─── Supplements ────────────────────────────────────────────────────────────

export type SupplementUsageGuidance = {
  key: string;
  slug: string;
  title: string;
  body: string;
  cadence?: string | null;
  cycle_candidate: boolean;
  severity: 'info' | 'warning';
};

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
  common_uses?: string[] | null;
  deficiency_risks?: string[] | null;
  excess_risks?: string[] | null;
  food_sources?: string[] | null;
  usage_guidance?: SupplementUsageGuidance | null;
};

export type StackItem = {
  id: number;
  user_id: number;
  supplement_ingredient_id?: number | null;
  supplement_product_id?: number | null;
  ingredient_slug?: string | null;
  ingredient_name?: string | null;
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
  description?: string | null;
  effectiveness_confidence?: 'high' | 'medium' | 'low' | null;
  evidence_tier?: string | null;
  risk_tier?: string | null;
  timing_notes?: string | null;
  safety_notes?: string | null;
  common_uses?: string[] | null;
  deficiency_risks?: string[] | null;
  excess_risks?: string[] | null;
  food_sources?: string[] | null;
  source_terms?: string[] | null;
  nutrient_content?: NutrientContent | null;
  usage_guidance?: SupplementUsageGuidance | null;
  created_at: string;
};

export type TodayStackItem = StackItem & {
  logs_today: Array<{ id: number; taken_at: string; skipped: boolean; name?: string | null; dose_amount?: number | null; dose_unit?: string | null }>;
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

export type SupplementHistoryItem = {
  id: number;
  user_id: number;
  stack_item_id: number;
  taken_at: string;
  name?: string | null;
  display_name: string;
  normalized_name?: string | null;
  dose_amount?: number | null;
  dose_unit?: string | null;
  timing_context: string;
  source: string;
  confidence?: number | null;
  skipped: boolean;
  category?: string | null;
  timing?: string | null;
  group_label?: string | null;
  active?: boolean | null;
  supplement_ingredient_id?: number | null;
  ingredient_slug?: string | null;
  ingredient_name?: string | null;
  usage_guidance?: SupplementUsageGuidance | null;
};

export type SupplementHistoryResponse = {
  days: number;
  limit: number;
  summary: {
    taken: number;
    skipped: number;
    taken_days: number;
  };
  items: SupplementHistoryItem[];
};

export type SupplementHistoryFilters = {
  stackItemId?: number;
  ingredientSlug?: string | null;
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

/** Undo today's most recent dose log for a stack item — for a supplement
 *  accidentally marked taken (or skipped). No-op (deleted: 0) if nothing
 *  was logged today. */
export async function unlogDose(
  token: string,
  stackId: number,
): Promise<{ deleted: number; log_id?: number }> {
  return request(`/supplements/stack/${stackId}/log`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
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

export async function getSupplementHistory(
  token: string,
  days = 30,
  limit = 200,
  filters: SupplementHistoryFilters = {},
): Promise<SupplementHistoryResponse> {
  const params = new URLSearchParams({
    days: String(days),
    limit: String(limit),
  });
  if (typeof filters.stackItemId === 'number') {
    params.set('stack_item_id', String(filters.stackItemId));
  }
  if (filters.ingredientSlug) {
    params.set('ingredient_slug', filters.ingredientSlug);
  }
  return request(`/supplements/history?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
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
  action?: Record<string, any> | null;
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

export interface EmphasisVolumeRow {
  emphasis: string;
  total_sets: number;
  exercise_count: number;
}

export interface WeeklyVolumeSnapshot {
  user_id: number;
  window_start: string;
  window_end: string;
  total_hard_sets: number;
  sessions_counted: number;
  by_muscle: Record<string, MuscleVolumeRow>;
  by_emphasis?: Record<string, EmphasisVolumeRow>;
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
  workout_adherence_pct?: number;
  cardio_minutes: number;
  zone2_minutes: number;
  volume: WeeklyVolumeSnapshot;
  /** Legacy alias. Prefer nutrition_logging_pct for the label unless target
   *  adherence fields are populated. */
  nutrition_adherence_pct: number;
  nutrition_logging_pct?: number;
  days_logged: number;
  avg_calories?: number;
  avg_protein_g: number;
  avg_fiber_g: number;
  calorie_target_adherence_pct?: number | null;
  protein_target_adherence_pct?: number | null;
  nutrition_summary?: string;
  nutrition_notes?: string[];
  weight_trend_lbs_per_week: number | null;
  weight_trend_direction: 'up' | 'down' | 'flat' | 'unknown';
  /** EMA-smoothed weight from the 7-day UserRollup. Cleaner trend
   *  display than raw slope alone — slope is noisy week-to-week. */
  weight_ema_lbs?: number | null;
  avg_sleep_hours: number | null;
  avg_resting_hr: number | null;
  headline: string;
  goal_forecast?: GoalForecastSummary | null;
  recommendations: PlanRecommendation[];
}

export interface GoalForecastSummary {
  bucket: string;
  window_weeks: number;
  headline: string;
  subheadline: string;
  metric_label: string;
  metric_value: string;
  metric_detail: string;
  raw_execution?: number;
  execution_score?: number;
  execution_pct: number;
  forecast_multiplier?: number;
  execution_breakdown?: {
    training: number;
    nutrition: number;
    recovery: number;
    recovery_assumed_neutral?: boolean;
    weights?: { training: number; nutrition: number; recovery: number };
  };
  confidence: 'low' | 'medium' | 'high';
  tone: 'success' | 'warning' | 'neutral';
  assumption: string;
  update_reason: string;
  drivers: string[];
  limiters: string[];
  stats: Array<{ label: string; value: string; detail: string }>;
}

export type GoalScoreWindow = 'current_week' | 'rolling_7d' | 'rolling_14d' | 'rolling_28d' | 'goal_to_date';

export interface GoalExecutionBreakdownItem {
  driverId: string;
  driverName: string;
  category: 'training' | 'nutrition' | 'sleep' | 'recovery' | 'cardio' | 'measurement' | string;
  weight: number;
  score: number;
  weightedContribution: number;
  targetSummary: string;
  actualSummary: string;
  evidence: string[];
  missingData: string[];
  limiterSeverity: 'none' | 'low' | 'moderate' | 'high' | string;
}

export interface GoalConfidenceBreakdownItem {
  component: string;
  weight: number;
  score: number;
  reason: string;
}

export interface GoalProjectedOutcome {
  metric: string;
  unit: string;
  targetChange: number;
  expectedMidpoint: number;
  expectedLow: number;
  expectedHigh: number;
  timeframeDays: number;
  displayText: string;
}

export interface GoalLimitingFactor {
  driverName: string;
  reason: string;
  impact: 'low' | 'moderate' | 'high' | string;
  suggestedFix: string;
}

export interface GoalNextBestAction {
  title: string;
  description: string;
  expectedImpact: string;
}

export interface GoalScoreResult {
  goalId: string | number | null;
  goalType: string;
  periodStart: string;
  periodEnd: string;
  executionScore: number;
  executionLabel: string;
  executionBreakdown: GoalExecutionBreakdownItem[];
  projectionConfidence: number;
  confidenceLabel: string;
  confidenceBreakdown: GoalConfidenceBreakdownItem[];
  responseFactor: number;
  projectedOutcome: GoalProjectedOutcome;
  limitingFactors: GoalLimitingFactor[];
  nextBestActions: GoalNextBestAction[];
}

export interface GoalScoresResponse {
  scores: GoalScoreResult[];
  window: GoalScoreWindow | string;
  asOfDate: string;
}

export async function getGoalScores(
  token: string,
  opts: { window?: GoalScoreWindow; asOfDate?: string | null } = {},
): Promise<GoalScoresResponse> {
  const params = new URLSearchParams();
  if (opts.window) params.set('window', opts.window);
  if (opts.asOfDate) params.set('as_of', opts.asOfDate);
  const qs = params.toString();
  return requestRead<GoalScoresResponse>(`/goals/score${qs ? `?${qs}` : ''}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, 30000);
}

export async function getWeeklyReview(
  token: string,
  opts: {
    days?: number;
    endDate?: string | null;
    weightSlopeLbsPerWeek?: number | null;
    avgSleepHours?: number | null;
    avgRestingHr?: number | null;
    avgSteps?: number | null;
    readinessScore?: number | null;
  } = {},
): Promise<WeeklyReviewResponse> {
  const params = new URLSearchParams();
  if (opts.days) params.set('days', String(opts.days));
  if (opts.endDate) params.set('end_date', opts.endDate);
  if (opts.weightSlopeLbsPerWeek != null) params.set('weight_slope_lbs_per_week', String(opts.weightSlopeLbsPerWeek));
  if (opts.avgSleepHours != null) params.set('avg_sleep_hours', String(opts.avgSleepHours));
  if (opts.avgRestingHr != null) params.set('avg_resting_hr', String(opts.avgRestingHr));
  if (opts.avgSteps != null) params.set('avg_steps', String(opts.avgSteps));
  if (opts.readinessScore != null) params.set('readiness_score', String(opts.readinessScore));
  const qs = params.toString();
  return requestRead<WeeklyReviewResponse>(`/workouts/weekly-review${qs ? `?${qs}` : ''}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, 30000);
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
  workout_adherence_pct?: number;
  cardio_minutes: number;
  zone2_minutes: number;
  strength_sessions: number;
  nutrition_adherence_pct: number;
  nutrition_logging_pct?: number;
  days_logged: number;
  avg_calories?: number;
  avg_protein_g?: number;
  avg_fiber_g?: number;
  nutrition_summary?: string;
  avg_sleep_hours: number | null;
  avg_resting_hr: number | null;
  goal: string;
  week_start: string;
  week_end: string;
  headline: string;
  goal_forecast?: GoalForecastSummary | null;
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
  applied: Array<{ type: string; summary: string; changed_fields?: Record<string, any>; verified?: boolean }>;
  coach_message: string;
}

export async function getWeekSummary(
  token: string,
  opts: { planWeekId?: number | null; endDate?: string | null } = {},
): Promise<WeekSummaryResponse> {
  const params = new URLSearchParams();
  if (opts.planWeekId != null) params.set('plan_week_id', String(opts.planWeekId));
  if (opts.endDate) params.set('end_date', opts.endDate);
  const qs = params.toString();
  return request<WeekSummaryResponse>(`/plans/week-summary${qs ? `?${qs}` : ''}`, {
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
  /** 'pending' | 'in_progress' | 'completed' | 'skipped' | 'unassigned' | 'edited'.
   *  'unassigned' appears in workout-manual-mode weeks where the user
   *  hasn't yet picked a template. */
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
  session_minutes: number | null;
  preferred_split: string | null;
  program_enrollment_id?: number | null;
  program_id?: string | null;
  program_version?: number | null;
  program_week_index?: number | null;
  program_phase?: string | null;
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

export async function repairPlanWeekInjuryConflicts(token: string): Promise<PlanWeekResponse> {
  return request<PlanWeekResponse>('/plans/week/repair-injury-conflicts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function repairPlanWeekEquipmentConflicts(token: string): Promise<PlanWeekResponse> {
  return request<PlanWeekResponse>('/plans/week/repair-equipment-conflicts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function updatePlanWeekSessionDuration(
  token: string,
  sessionMinutes: number,
): Promise<PlanWeekResponse> {
  return request<PlanWeekResponse>('/plans/week/update-session-duration', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ new_session_minutes: sessionMinutes }),
  });
}

export interface CheckinPlanSettingsResponse {
  plan_week: PlanWeekResponse;
  changed_fields: Record<string, { from?: any; to?: any }>;
  applied_to_current_week: boolean;
  explanation: string;
}

export async function applyPlanWeekCheckinSettings(
  token: string,
  body: {
    goal?: string | null;
    daysPerWeek?: number | null;
    preferredSplit?: string | null;
    sessionMinutes?: number | null;
    applyToCurrentWeek?: boolean;
    reason?: string | null;
  },
): Promise<CheckinPlanSettingsResponse> {
  return request<CheckinPlanSettingsResponse>('/plans/week/checkin-settings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      goal: body.goal ?? null,
      days_per_week: body.daysPerWeek ?? null,
      preferred_split: body.preferredSplit ?? null,
      session_minutes: body.sessionMinutes ?? null,
      apply_to_current_week: !!body.applyToCurrentWeek,
      reason: body.reason ?? 'weekly_checkin',
    }),
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

/** Legacy shape from the old hold-renewal flow. Kept for defensive clients. */
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
  user_decision?: CheckinDecision | null;
}

/** Auto-generate the next 7-day week when the active PlanWeek has
 *  expired (end_date < today). The previous week's check-in/recap remains
 *  available separately through getCheckinStatus. */
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

export async function reviewAndApplyPlanWeek(
  token: string,
  actions: Array<Record<string, any>> = [],
): Promise<PlanWeekResponse> {
  // Applies selected recommendations to durable settings/state only.
  // The backend returns the unchanged active PlanWeek.
  return request<PlanWeekResponse>('/plans/week/review-and-apply', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ actions }),
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

export interface ReadinessReasonItem {
  type: string;         // e.g. "delayed_damage_window", "soreness_reported", "avoid_heavy_lower"
  severity?: 'low' | 'moderate' | 'high';
  message: string;
  /** avoid_heavy_lower carries the lower-body readiness + suggested swaps. */
  lower_body_readiness?: number;
  alternatives?: string[];
}

export interface ReadinessTopFatigued {
  muscle: string;       // "quads" | "glutes" | ...
  readiness: number;    // 0-100 (100 = fresh)
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
  /** Per-focus readiness 0-100 ("lower", "push", "pull", ...). A user can be
   *  generally ready (high `score`) while a focus like "lower" is much lower.
   *  Additive — may be {} on cold start or older servers. */
  focus_readiness?: Record<string, number>;
  /** Per-muscle readiness 0-100 ("quads", "chest", ...). 100 = fresh. */
  muscle_readiness?: Record<string, number>;
  /** Most-fatigued muscles, lowest readiness first. */
  top_fatigued?: ReadinessTopFatigued[];
  /** Actionable training guidance (e.g. avoid heavy lower-body today). */
  recommendations?: ReadinessReasonItem[];
  /** Plain-language reasons behind the score (soreness, delayed damage, etc). */
  explanations?: ReadinessReasonItem[];
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
 *  manually through app controls. The active PlanWeek remains fixed;
 *  `needs_regen` means future generated weeks should read the updated
 *  settings. */
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

/** Delete WorkoutCompletion rows for `dateISO`. Passing only a date keeps
 *  the legacy "wipe the whole day" behavior; passing an id/source/focus
 *  targets a single row or focus. */
export async function deleteWorkoutCompletion(
  token: string,
  dateISO: string,
  focusOrOptions?: string | {
    focusLabel?: string | null;
    completionId?: number | null;
    externalSourceId?: string | null;
  },
): Promise<void> {
  const params = new URLSearchParams({ workout_date: dateISO });
  if (typeof focusOrOptions === 'string') {
    if (focusOrOptions) params.set('focus_label', focusOrOptions);
  } else if (focusOrOptions) {
    if (focusOrOptions.focusLabel) params.set('focus_label', focusOrOptions.focusLabel);
    if (focusOrOptions.completionId != null) params.set('completion_id', String(focusOrOptions.completionId));
    if (focusOrOptions.externalSourceId) params.set('external_source_id', focusOrOptions.externalSourceId);
  }
  const url = `/workouts/completion?${params.toString()}`;
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

// ─── Weekly Cardio Load (Edwards' TRIMP) ───────────────────────────────────
//
// Parallel surface to weekly volume — one rolled-up TRIMP per ISO week.
// Backend computes the rows from `WorkoutCompletion.cardio_load` at write
// time, so this call stays cheap. `trend_label` is the ratio bucket
// comparing the current week to the prior 4-week mean — handy for a
// one-line "Trending up" / "Steady" / "Trending down" caption.
export interface CardioLoadWeek {
  week_start: string;   // YYYY-MM-DD (Monday)
  week_end: string;     // YYYY-MM-DD (Sunday)
  load: number;         // sum of Edwards' TRIMP across the week
  session_count: number;
}

export interface WeeklyCardioLoadSnapshot {
  weeks: CardioLoadWeek[];
  rolling_baseline_load: number;
  current_week_load: number;
  trend_ratio: number | null;
  // "trending_up" | "flat" | "trending_down" | "no_baseline"
  trend_label: 'trending_up' | 'flat' | 'trending_down' | 'no_baseline';
}

export async function getWeeklyCardioLoad(token: string, weeks = 8): Promise<WeeklyCardioLoadSnapshot> {
  return request<WeeklyCardioLoadSnapshot>(`/workouts/weekly-cardio-load?weeks=${weeks}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─── Streaks ───────────────────────────────────────────────────────────────
//
// Three streaks: workout, meal, readiness. Server-authoritative — computed
// from existing tables on read so they survive reinstalls. `current` is the
// active streak; `best` is the longest in the last 365 days. One-day grace
// rule applied (see backend/app/services/streaks.py).
export type StreakKind = 'workout' | 'meal' | 'readiness';
export interface StreakState {
  kind: StreakKind;
  current: number;
  best: number;
  last_logged: string | null;
  today_logged: boolean;
}
export interface StreaksResponse {
  streaks: StreakState[];
}

export async function getStreaks(token: string): Promise<StreaksResponse> {
  return request<StreaksResponse>('/streaks', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─── Cardio progression ────────────────────────────────────────────────────
//
// PR bests + recent-vs-prior trends per activity. Powers the Cardio
// Progression tab on Progress (sits alongside CardioLoadCard). Empty arrays
// mean "no signal" — the UI should hide the corresponding tile, not show 0.
export interface PaceBest {
  distance_label: '5k' | '10k' | '10mi' | 'half_marathon' | 'marathon';
  activity: 'run' | 'ride';
  pace_seconds_per_mile: number;
  duration_seconds: number;
  distance_miles: number;
  achieved_on: string;
}
export interface PaceTrend {
  activity: 'run' | 'ride';
  recent_avg_pace_sec_per_mile: number | null;
  prior_avg_pace_sec_per_mile: number | null;
  delta_pct: number | null;       // negative = faster
  recent_sessions: number;
  prior_sessions: number;
}
export interface CardioProgressionSnapshot {
  bests: PaceBest[];
  trends: PaceTrend[];
  recent_cardio_load: number;
  recent_active_days: number;
}
export async function getCardioProgression(token: string): Promise<CardioProgressionSnapshot> {
  return request<CardioProgressionSnapshot>('/workouts/cardio-progression', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─── Wearable integrations ─────────────────────────────────────────────────
//
// Generic provider abstraction — one set of endpoints handles Strava,
// Garmin, Oura, WHOOP, Fitbit. Whether a provider is `connected` vs
// `configured` vs `available` drives the Settings → Integrations tile
// state. See docs/engineering/wearables.md.
export type WearableProviderSlug = 'strava' | 'garmin' | 'oura' | 'whoop' | 'fitbit' | 'google_health';
export type HealthSourcePreferenceValue =
  | 'auto'
  | 'apple_health'
  | 'health_connect'
  | 'oura'
  | 'whoop'
  | 'google_health'
  | 'fitbit'
  | 'strava'
  | 'manual'
  | 'watch';

export interface WearableProviderInfo {
  slug: WearableProviderSlug;
  name: string;
  /** Operator has set the OAuth client creds. False → tile is "Coming soon". */
  configured: boolean;
  /** User has connected this provider. */
  connected: boolean;
  capabilities: string[];
  last_synced_at: string | null;
}

export interface HealthSourcePreferences {
  sleep_source: HealthSourcePreferenceValue;
  readiness_source: HealthSourcePreferenceValue;
  hrv_source: HealthSourcePreferenceValue;
  resting_hr_source: HealthSourcePreferenceValue;
  activity_source: HealthSourcePreferenceValue;
  workout_source: HealthSourcePreferenceValue;
  body_weight_source: HealthSourcePreferenceValue;
}

export async function listIntegrations(token: string): Promise<{ providers: WearableProviderInfo[] }> {
  return request<{ providers: WearableProviderInfo[] }>('/integrations', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getIntegrationPreferences(token: string): Promise<{
  preferences: HealthSourcePreferences;
  allowed_sources: HealthSourcePreferenceValue[];
}> {
  return request('/integrations/preferences', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function updateIntegrationPreferences(
  token: string,
  preferences: Partial<HealthSourcePreferences>,
): Promise<{
  preferences: HealthSourcePreferences;
  allowed_sources: HealthSourcePreferenceValue[];
}> {
  return request('/integrations/preferences', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(preferences),
  });
}

export async function getIntegrationAuthorizeUrl(token: string, provider: string): Promise<{ authorize_url: string; state: string }> {
  return request<{ authorize_url: string; state: string }>(`/integrations/${provider}/authorize`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function syncIntegration(token: string, provider: string, days = 30): Promise<{
  activities_imported: number;
  health_snapshots_imported: number;
  sleep_logs_imported: number;
  errors: number;
  error_messages: string[];
}> {
  return request(`/integrations/${provider}/sync?days=${days}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function disconnectIntegration(token: string, provider: string): Promise<{ status: 'disconnected' | 'not_connected' }> {
  return request(`/integrations/${provider}`, {
    method: 'DELETE',
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
  return requestRead(`/workouts/e1rm/history?exercise_name=${encodeURIComponent(exerciseName)}&role=${role}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, 30000);
}

export async function getAllE1RM(token: string, days = 365): Promise<{ exercises: Record<string, number>; days?: number }> {
  return requestRead(`/workouts/e1rm/all?days=${encodeURIComponent(String(days))}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, 30000);
}

export interface HRZone {
  /** 1..5 — five %MHR bands (Apple / Garmin / Whoop convention). */
  zone: number;
  label: string;
  low: number;
  high: number;
}

export type HRMaxSource = 'user_entered' | 'observed' | 'estimated_tanaka';
export type HRRestingSource = 'apple_health_7d' | 'apple_health_30d' | 'user_profile' | 'fallback';

export interface HRZonesResponse {
  /** Always 'pct_max_hr' for now. Surfaced explicitly so future
   *  alternatives (e.g. %HRR Karvonen, lactate-threshold zones) can be
   *  distinguished by callers without a release-coordinated migration. */
  method: 'pct_max_hr';
  max_hr: number;
  resting_hr: number;
  max_hr_source: HRMaxSource;
  resting_hr_source: HRRestingSource;
  vo2_max: number | null;
  zones: HRZone[];
}

export interface HRZonesQuery {
  /** Lowest-priority RHR — treated as `user_profile` source. */
  restingHr?: number;
  vo2Max?: number;
  /** User-measured max HR. Highest priority. */
  userMaxHR?: number;
  /** High-confidence observed max HR (e.g. peak from a recent
   *  interval session). Wins over the Tanaka age estimate. */
  observedMaxHR?: number;
  /** 7-day rolling RHR average from Apple Health. */
  rhr7d?: number;
  /** 30-day rolling RHR average from Apple Health. */
  rhr30d?: number;
}

export async function getHRZones(token: string, query?: HRZonesQuery | number, vo2Max?: number): Promise<HRZonesResponse> {
  // Backwards compat: legacy callers passed `(token, restingHr?, vo2Max?)`.
  const opts: HRZonesQuery = typeof query === 'number'
    ? { restingHr: query, vo2Max }
    : (query ?? {});
  const params = new URLSearchParams();
  if (opts.restingHr != null) params.set('resting_hr', String(opts.restingHr));
  if (opts.vo2Max != null) params.set('vo2_max', String(opts.vo2Max));
  if (opts.userMaxHR != null) params.set('user_max_hr', String(opts.userMaxHR));
  if (opts.observedMaxHR != null) params.set('observed_max_hr', String(opts.observedMaxHR));
  if (opts.rhr7d != null) params.set('rhr_7d', String(opts.rhr7d));
  if (opts.rhr30d != null) params.set('rhr_30d', String(opts.rhr30d));
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
  pace_duration_seconds?: number | null;
  moving_seconds?: number | null;
  elapsed_seconds?: number | null;
  stopped_seconds?: number | null;
  duration_source?: string | null;
  metrics: Record<string, string | number | boolean | null> | null;
}

export async function getPaceHistory(token: string, exercise?: string, days = 90): Promise<{ points: PaceHistoryPoint[] }> {
  const params = new URLSearchParams({ days: String(days) });
  if (exercise) params.set('exercise', exercise);
  return requestRead(`/workouts/pace-history?${params}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, 30000);
}

// ─── Social ────────────────────────────────────────────────────────────────

const SOCIAL_READ_TTL_MS = 15_000;
const SOCIAL_SOFT_TIMEOUT_MS = 1_000;

export interface SocialMe {
  user_id: number;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  share_activity_enabled: boolean;
}

export interface SocialFriend {
  friendship_id: number;
  user_id: number;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  goal: string | null;
  last_active_within_48h: boolean;
  streak: number;
}

export interface SocialPendingRequest {
  friendship_id: number;
  user_id: number;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
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
  avatar_url?: string | null;
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
  avatar_url: string | null;
}

export interface SocialNotification {
  id: number;
  notification_type: 'friend_request' | 'friend_accept' | 'feed_like' | 'feed_comment' | string;
  subject_type: 'friendship' | 'feed_item' | string;
  subject_id: number;
  actor_user_id: number;
  actor_username: string;
  actor_display_name: string | null;
  actor_avatar_url: string | null;
  payload: {
    friendship_id?: number;
    feed_item_id?: number;
    event_type?: string;
    focus?: string;
    date?: string;
    caption?: string;
    comment?: string;
  };
  read_at: string | null;
  created_at: string;
}

export interface SocialNotificationsResponse {
  items: SocialNotification[];
  unread_count: number;
}

export async function getSocialMe(token: string): Promise<SocialMe> {
  return requestRead<SocialMe>('/social/me', {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, SOCIAL_READ_TTL_MS, SOCIAL_SOFT_TIMEOUT_MS);
}

export async function updateSocialMe(
  token: string,
  body: { display_name?: string | null; avatar_url?: string | null; share_activity_enabled?: boolean },
): Promise<SocialMe> {
  return request<SocialMe>('/social/me', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export async function listFriends(token: string): Promise<SocialFriendsList> {
  return requestRead<SocialFriendsList>('/social/friends', {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, SOCIAL_READ_TTL_MS, SOCIAL_SOFT_TIMEOUT_MS);
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
  return requestRead<SocialSearchHit[]>(`/social/search?q=${encodeURIComponent(q)}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, SOCIAL_READ_TTL_MS, SOCIAL_SOFT_TIMEOUT_MS);
}

export async function getSocialDigest(token: string): Promise<SocialDigest> {
  return requestRead<SocialDigest>('/social/digest', {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, SOCIAL_READ_TTL_MS, SOCIAL_SOFT_TIMEOUT_MS);
}

export async function listSocialNotifications(token: string): Promise<SocialNotificationsResponse> {
  return requestRead<SocialNotificationsResponse>('/social/notifications', {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, SOCIAL_READ_TTL_MS, SOCIAL_SOFT_TIMEOUT_MS);
}

export async function markSocialNotificationRead(token: string, notificationId: number): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/social/notifications/${notificationId}/read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function markAllSocialNotificationsRead(token: string): Promise<{ ok: boolean; updated: number }> {
  return request<{ ok: boolean; updated: number }>('/social/notifications/read-all', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─── Trainers ──────────────────────────────────────────────────────────────

const TRAINER_READ_TTL_MS = 10_000;

export interface TrainerProfile {
  user_id: number;
  display_name: string | null;
  business_name: string | null;
  bio: string | null;
  website_url: string | null;
  contact_email: string | null;
  is_accepting_clients: boolean;
  created_at: string;
  updated_at: string;
}

export interface TrainerUser {
  user_id: number;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  trainer_business_name?: string | null;
}

export interface TrainerPermissionFlags {
  share_workouts: boolean;
  share_nutrition: boolean;
  share_body_metrics: boolean;
  share_recovery: boolean;
}

export interface TrainerRelationship {
  id: number;
  status: 'pending' | 'active' | 'declined' | 'revoked' | string;
  role: 'trainer' | 'client' | string;
  direction: 'incoming' | 'outgoing' | 'active' | string;
  trainer: TrainerUser;
  client: TrainerUser;
  share_workouts: boolean;
  share_nutrition: boolean;
  share_body_metrics: boolean;
  share_recovery: boolean;
  invite_message: string | null;
  requested_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

export interface TrainerRelationshipsResponse {
  as_trainer: TrainerRelationship[];
  as_client: TrainerRelationship[];
}

export interface TrainerClientSummary {
  relationship_id: number;
  client: TrainerUser;
  permissions: TrainerPermissionFlags;
  workouts: {
    planned: number;
    completed: number;
    missed: number;
    adherence_pct: number;
    last_workout_date: string | null;
    focus_counts: Record<string, number>;
  };
  nutrition: {
    shared: boolean;
    days_logged?: number | null;
    avg_calories?: number | null;
    avg_protein_g?: number | null;
    protein_hit_days?: number | null;
  };
  body: {
    shared: boolean;
    latest_weight_lbs?: number | null;
    latest_weight_date?: string | null;
  };
  recovery: {
    shared: boolean;
    pain_present?: boolean | null;
    pain_body_part?: string | null;
    soreness_body_part?: string | null;
    soreness_severity_0_10?: number | null;
    latest_sleep_hours?: number | null;
  };
  flags: string[];
  notes_count: number;
}

export interface TrainerDashboard {
  window_start: string;
  window_end: string;
  clients: TrainerClientSummary[];
}

export interface TrainerNote {
  id: number;
  relationship_id: number;
  trainer_user_id: number;
  client_user_id: number;
  author_user_id: number;
  body: string;
  visible_to_client: boolean;
  created_at: string;
  updated_at: string;
}

export async function getTrainerProfile(token: string): Promise<TrainerProfile | null> {
  return requestRead<TrainerProfile | null>('/trainers/profile', {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, TRAINER_READ_TTL_MS, SOCIAL_SOFT_TIMEOUT_MS);
}

export async function updateTrainerProfile(
  token: string,
  body: Partial<Pick<TrainerProfile, 'display_name' | 'business_name' | 'bio' | 'website_url' | 'contact_email' | 'is_accepting_clients'>>,
): Promise<TrainerProfile> {
  return request<TrainerProfile>('/trainers/profile', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export async function listTrainerRelationships(token: string): Promise<TrainerRelationshipsResponse> {
  return requestRead<TrainerRelationshipsResponse>('/trainers/relationships', {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, TRAINER_READ_TTL_MS, SOCIAL_SOFT_TIMEOUT_MS);
}

export type TrainerRelationshipRequestBody = Partial<TrainerPermissionFlags> & {
  username: string;
  message?: string | null;
};

export async function requestTrainerClient(
  token: string,
  body: TrainerRelationshipRequestBody,
): Promise<TrainerRelationship> {
  return request<TrainerRelationship>('/trainers/clients/request', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export async function requestMyTrainer(
  token: string,
  body: TrainerRelationshipRequestBody,
): Promise<TrainerRelationship> {
  return request<TrainerRelationship>('/trainers/my-trainer/request', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export async function acceptTrainerRelationship(
  token: string,
  relationshipId: number,
  body: Partial<TrainerPermissionFlags> = {},
): Promise<TrainerRelationship> {
  return request<TrainerRelationship>(`/trainers/relationships/${relationshipId}/accept`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export async function rejectTrainerRelationship(token: string, relationshipId: number): Promise<void> {
  await request(`/trainers/relationships/${relationshipId}/reject`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function revokeTrainerRelationship(token: string, relationshipId: number): Promise<void> {
  await request(`/trainers/relationships/${relationshipId}/revoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getTrainerDashboard(token: string, days = 7): Promise<TrainerDashboard> {
  return requestRead<TrainerDashboard>(`/trainers/dashboard?days=${days}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, TRAINER_READ_TTL_MS, SOCIAL_SOFT_TIMEOUT_MS);
}

export async function createTrainerClientNote(
  token: string,
  clientUserId: number,
  body: { body: string; visible_to_client?: boolean },
): Promise<TrainerNote> {
  return request<TrainerNote>(`/trainers/clients/${clientUserId}/notes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export interface FeedItem {
  id: number;
  user_id: number;
  username: string;
  display_name: string | null;
  avatar_url?: string | null;
  event_type: string;
  payload: {
    focus?: string;
    duration_seconds?: number;
    date?: string;
    exercise_count?: number;
    activity_category?: string;
    activity_subtype?: string;
    cardio_style?: string;
    distance_miles?: number;
    hr_summary?: { avgBpm?: number; maxBpm?: number };
    exercises?: Array<{
      name: string;
      equipment?: string | null;
      sets: Array<WorkoutPostSetSummary>;
    }>;
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
  comment_count: number;
  recent_comments: FeedComment[];
}

export interface FeedComment {
  id: number;
  feed_item_id: number;
  user_id: number;
  username: string;
  display_name: string | null;
  avatar_url?: string | null;
  body: string;
  created_at: string;
  can_delete: boolean;
}

type FeedWindowOptions = {
  beforeId?: number;
  limit?: number;
};

function feedWindowQuery(input?: number | FeedWindowOptions): string {
  const opts = typeof input === 'number' ? { beforeId: input } : (input ?? {});
  const params = new URLSearchParams();
  if (opts.beforeId) params.set('before_id', String(opts.beforeId));
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export async function getSocialFeed(token: string, options?: number | FeedWindowOptions): Promise<{ items: FeedItem[] }> {
  const qs = feedWindowQuery(options);
  return requestRead<{ items: FeedItem[] }>(`/social/feed${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, SOCIAL_READ_TTL_MS, SOCIAL_SOFT_TIMEOUT_MS);
}

export async function getUserFeed(token: string, userId: number, options?: number | FeedWindowOptions): Promise<{ items: FeedItem[] }> {
  const qs = feedWindowQuery(options);
  return requestRead<{ items: FeedItem[] }>(`/social/feed/${userId}${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, SOCIAL_READ_TTL_MS, SOCIAL_SOFT_TIMEOUT_MS);
}

export interface WorkoutPostSummary {
  focus: string;
  duration_seconds: number;
  date: string;
  activity_category?: string | null;
  activity_subtype?: string | null;
  cardio_style?: string | null;
  distance_miles?: number | null;
  hr_summary?: { avgBpm?: number | null; maxBpm?: number | null } | null;
  exercises: Array<{
    name: string;
    equipment?: string | null;
    sets: Array<WorkoutPostSetSummary>;
  }>;
  total_sets: number;
  total_reps: number;
  training_score?: number | null;
  training_rating?: string | null;
}

export interface WorkoutPostSetSummary {
  reps?: number | null;
  weight_lbs?: number | null;
  duration_seconds?: number | null;
  actual_distance?: number | null;
  actual_pace?: string | null;
  heart_rate_avg?: number | null;
  cardio_metrics?: Record<string, string> | null;
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

export async function toggleFeedLike(token: string, itemId: number): Promise<{ liked: boolean; like_count: number }> {
  return request<{ liked: boolean; like_count: number }>(`/social/feed/${itemId}/like`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function listFeedComments(
  token: string,
  itemId: number,
): Promise<{ items: FeedComment[]; comment_count: number }> {
  return requestRead<{ items: FeedComment[]; comment_count: number }>(`/social/feed/${itemId}/comments`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 30000, SOCIAL_READ_TTL_MS, SOCIAL_SOFT_TIMEOUT_MS);
}

export async function createFeedComment(
  token: string,
  itemId: number,
  body: string,
): Promise<{ comment: FeedComment; comment_count: number }> {
  return request<{ comment: FeedComment; comment_count: number }>(`/social/feed/${itemId}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ body }),
  });
}

export async function deleteFeedComment(
  token: string,
  itemId: number,
  commentId: number,
): Promise<{ ok: boolean; comment_count: number }> {
  return request<{ ok: boolean; comment_count: number }>(`/social/feed/${itemId}/comments/${commentId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function parseMealText(
  token: string,
  text: string,
): Promise<{ items: Array<{ name: string; serving: string; calories: number; protein: number; carbs: number; fat: number; processing_bucket?: string; food_quality?: string; protein_source?: string; fermented?: boolean; probiotic?: boolean; omega3_rich?: boolean; plant_count?: number }> }> {
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
