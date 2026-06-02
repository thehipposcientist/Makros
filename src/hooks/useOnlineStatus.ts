// Backend reachability hook. NOT a wifi-status hook — what we really
// care about is "can I reach the API right now?". A user on hotel wifi
// with a portal block is technically "online" but functionally offline
// to us; netinfo would lie.
//
// Mechanics:
//   1. Every request through `request()` in api.ts calls
//      `markRequestOutcome(ok)`. Success → online. Failure → if it looks
//      network-shaped, → offline.
//   2. A lightweight heartbeat (`/health`, no auth) pings every 30 s
//      while the app is foregrounded so a passively-idle user still
//      notices reconnects.
//   3. Subscribers re-render via React state.
//
// Components consume via `useOnlineStatus()`. Imperative code can call
// `getOnlineStatus()` and `subscribeOnline(cb)` directly.

import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { getApiBaseUrl } from '../services/api';

type Listener = (online: boolean) => void;

let _online = true;
const _listeners = new Set<Listener>();
const HEARTBEAT_MS = 30_000;
const PROBE_TIMEOUT_MS = 4_500;
let _heartbeatStarted = false;

function _emit(next: boolean) {
  if (next === _online) return;
  _online = next;
  _listeners.forEach(fn => {
    try { fn(next); } catch { /* swallow listener errors — must not break the bus */ }
  });
}

/** Imperative read — for non-React code (services, hooks under hooks). */
export function getOnlineStatus(): boolean {
  return _online;
}

/** Imperative subscribe — returns an unsubscribe fn. */
export function subscribeOnline(fn: Listener): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

/** Called by the API layer after every fetch. `ok` is "the server
 *  answered, even if 4xx/5xx" — that proves the network worked. */
export function markRequestOutcome(ok: boolean, err?: unknown): void {
  if (ok) {
    _emit(true);
    return;
  }
  // Only network-shaped errors flip us offline. Auth failures, 4xx, etc.
  // should NOT — those are server-reachable errors.
  if (err && _isNetworkError(err)) {
    _emit(false);
  }
}

function _isNetworkError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err ?? '').toLowerCase();
  // RN fetch + axios + node-fetch shapes covered.
  return (
    msg.includes('network') ||
    msg.includes('failed to fetch') ||
    msg.includes('typeerror') ||
    msg.includes('aborted') ||
    msg.includes('timeout') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound')
  );
}

async function _probe(): Promise<void> {
  let base = '';
  try { base = getApiBaseUrl(); } catch { return; }
  if (!base) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    _emit(res.ok || res.status < 500);
  } catch (e) {
    if (_isNetworkError(e)) _emit(false);
  } finally {
    clearTimeout(timer);
  }
}

function _startHeartbeat(): void {
  if (_heartbeatStarted || Platform.OS === 'web') return;
  _heartbeatStarted = true;
  // Don't probe on mount — let the first real request observe the state.
  setInterval(() => { void _probe(); }, HEARTBEAT_MS);
}

/** React hook — returns `online` and re-renders on flip. */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(_online);
  useEffect(() => {
    _startHeartbeat();
    return subscribeOnline(setOnline);
  }, []);
  return online;
}
