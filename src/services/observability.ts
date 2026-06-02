// Crash + performance observability wrapper.
//
// Sentry is the canonical target — when `@sentry/react-native` is
// installed and `EXPO_PUBLIC_SENTRY_DSN` is set, this module initializes
// it. Without either, every function here is a no-op so the app keeps
// building and shipping without the SDK.
//
// Wiring (once you're ready):
//   1. `npx expo install @sentry/react-native`
//   2. `EXPO_PUBLIC_SENTRY_DSN=https://...@sentry.io/...` in .env
//      (and your EAS secrets for prod builds)
//   3. Sentry's `init` is called automatically on import.
//
// Why try-imports instead of a hard dep?  This file is imported during
// app boot (so init runs once), but adding Sentry to the dependency tree
// requires native module config and IPA size budget — call your shot
// when you're ready, not when an unrelated PR lands. Same shape for
// breadcrumbs and captureException: silent no-ops until wired.

import Constants from 'expo-constants';
import { Platform } from 'react-native';

type LeveledScope = 'fatal' | 'error' | 'warning' | 'info' | 'debug';

interface SentryLike {
  init: (opts: Record<string, any>) => void;
  captureException: (err: unknown, ctx?: Record<string, any>) => void;
  captureMessage: (msg: string, level?: LeveledScope) => void;
  addBreadcrumb: (crumb: { category?: string; message?: string; data?: Record<string, any>; level?: LeveledScope }) => void;
  setUser: (user: { id?: string; email?: string } | null) => void;
  setTag: (key: string, value: string) => void;
}

let _sentry: SentryLike | null = null;
let _initialized = false;

function _loadSentry(): SentryLike | null {
  if (_sentry) return _sentry;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@sentry/react-native');
    if (mod && typeof mod.init === 'function') {
      _sentry = mod as SentryLike;
      return _sentry;
    }
  } catch {
    // Not installed — fall through.
  }
  return null;
}

function _initSentryOnce(): void {
  if (_initialized) return;
  _initialized = true;
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (!dsn) return;
  const sdk = _loadSentry();
  if (!sdk) {
    console.log('[observability] SENTRY_DSN set but @sentry/react-native not installed — install it to enable.');
    return;
  }
  try {
    sdk.init({
      dsn,
      // Lightweight defaults: capture errors, take a small perf sample.
      tracesSampleRate: 0.1,
      // App version + platform automatically tagged so prod / TestFlight
      // crashes are filterable in the Sentry UI.
      release: Constants.expoConfig?.version ?? undefined,
      environment: __DEV__ ? 'development' : 'production',
    });
    sdk.setTag('platform', Platform.OS);
    sdk.setTag('app_variant', __DEV__ ? 'dev' : 'release');
  } catch (e) {
    console.warn('[observability] Sentry init failed:', e);
  }
}

// Kick the lazy init on first import. Cheap — does nothing if the SDK
// isn't installed or the DSN isn't set.
_initSentryOnce();


/** Capture an exception. Safe to call before init — drops silently if
 *  Sentry isn't configured. Caller should still surface a user-facing
 *  error message; this is for the engineering team, not the user. */
export function captureException(err: unknown, ctx?: Record<string, any>): void {
  const sdk = _loadSentry();
  if (!sdk) {
    // Helpful in dev so devs see what would be captured.
    if (__DEV__) console.warn('[observability] would capture:', err, ctx);
    return;
  }
  try { sdk.captureException(err, ctx); } catch { /* noop */ }
}

/** Lightweight log of a non-error event. Useful for "weird but
 *  recoverable" situations you want to know about. */
export function captureMessage(msg: string, level: LeveledScope = 'info'): void {
  const sdk = _loadSentry();
  if (!sdk) return;
  try { sdk.captureMessage(msg, level); } catch { /* noop */ }
}

/** Drop a breadcrumb. Sentry collects breadcrumbs and attaches them to
 *  the next captured exception, so adding them to interesting flow
 *  points (navigation, fetch starts, modal opens) improves debugability
 *  hugely without spamming Issues. */
export function addBreadcrumb(crumb: {
  category?: string; message?: string; data?: Record<string, any>; level?: LeveledScope;
}): void {
  const sdk = _loadSentry();
  if (!sdk) return;
  try { sdk.addBreadcrumb(crumb); } catch { /* noop */ }
}

/** Associate the current Sentry session with a user. Call on sign-in;
 *  call with null on sign-out so we don't cross-contaminate sessions. */
export function setUser(user: { id?: string | number; email?: string } | null): void {
  const sdk = _loadSentry();
  if (!sdk) return;
  try {
    sdk.setUser(user ? { id: String(user.id ?? ''), email: user.email } : null);
  } catch { /* noop */ }
}
