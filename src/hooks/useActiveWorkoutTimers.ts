import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { clearManagedInterval, restartManagedInterval } from './useManagedInterval';
import { STORAGE_KEYS } from '../utils/storageKeys.ts';

export type ExerciseTimerState = {
  running: boolean;
  baseElapsed: number;
  startedAt: number | null;
};

export type TimerTickSubscriber = (listener: () => void) => () => void;

export const ACTIVE_WORKOUT_TIMERS_KEY = STORAGE_KEYS.workouts.activeTimers;

function timerHasProgress(timer: ExerciseTimerState | undefined): boolean {
  if (!timer) return false;
  return timer.running || Number(timer.baseElapsed) > 0;
}

function persistedTimerEntries(timers: Record<string, ExerciseTimerState>): Record<string, ExerciseTimerState> {
  return Object.fromEntries(
    Object.entries(timers).filter(([, timer]) => timerHasProgress(timer)),
  );
}

export function hasPersistedActiveWorkoutTimers(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return Object.values(parsed).some((timer: any) => timer?.running === true || Number(timer?.baseElapsed) > 0);
  } catch {
    return false;
  }
}

async function persistActiveWorkoutTimers(timers: Record<string, ExerciseTimerState>): Promise<void> {
  const filtered = persistedTimerEntries(timers);
  if (Object.keys(filtered).length === 0) {
    await AsyncStorage.removeItem(ACTIVE_WORKOUT_TIMERS_KEY);
    return;
  }
  await AsyncStorage.setItem(ACTIVE_WORKOUT_TIMERS_KEY, JSON.stringify(filtered));
}

export function parseExerciseTimerKey(key: string): { exIdx: number; slot: number } | null {
  const [exIdxRaw, slotRaw] = key.split('-');
  const exIdx = Number(exIdxRaw);
  const slot = Number(slotRaw);
  if (!Number.isFinite(exIdx) || !Number.isFinite(slot) || exIdx < 0 || slot < 0) return null;
  return { exIdx: Math.floor(exIdx), slot: Math.floor(slot) };
}

export function timerElapsedFromState(timer: ExerciseTimerState | undefined): number {
  if (!timer) return 0;
  if (timer.running && timer.startedAt != null) {
    return timer.baseElapsed + Math.max(0, Math.floor((Date.now() - timer.startedAt) / 1000));
  }
  return timer.baseElapsed;
}

export function useExerciseTimerElapsed(
  timer: ExerciseTimerState | undefined,
  subscribeTimerTick: TimerTickSubscriber,
): number {
  const [elapsed, setElapsed] = useState(() => timerElapsedFromState(timer));

  useEffect(() => {
    const updateElapsed = () => setElapsed(timerElapsedFromState(timer));
    updateElapsed();
    if (!timer?.running) return undefined;
    return subscribeTimerTick(updateElapsed);
  }, [subscribeTimerTick, timer]);

  return elapsed;
}

export function useActiveWorkoutTimers() {
  const [activeTimers, setActiveTimers] = useState<Record<string, ExerciseTimerState>>({});
  const [timerModalKey, setTimerModalKey] = useState<string | null>(null);
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const legacyTimerIntervalsRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const activeTimersRef = useRef(activeTimers);
  const timerModalKeyRef = useRef(timerModalKey);
  const tickListenersRef = useRef<Set<() => void>>(new Set());
  const [activeTimersRestored, setActiveTimersRestored] = useState(false);

  useEffect(() => { activeTimersRef.current = activeTimers; }, [activeTimers]);
  useEffect(() => { timerModalKeyRef.current = timerModalKey; }, [timerModalKey]);

  const bumpTimerTick = useCallback(() => {
    tickListenersRef.current.forEach(listener => listener());
  }, []);

  const subscribeTimerTick = useCallback<TimerTickSubscriber>((listener) => {
    tickListenersRef.current.add(listener);
    return () => {
      tickListenersRef.current.delete(listener);
    };
  }, []);

  const ensureTimerTicker = useCallback(() => {
    if (tickIntervalRef.current) return;
    restartManagedInterval(tickIntervalRef, bumpTimerTick, 1000);
  }, [bumpTimerTick]);

  const clearTickerIfIdle = useCallback((timers: Record<string, ExerciseTimerState>) => {
    if (!Object.values(timers).some(timer => timer?.running)) {
      clearManagedInterval(tickIntervalRef);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(ACTIVE_WORKOUT_TIMERS_KEY).then(raw => {
      if (cancelled) return;
      if (!raw) {
        setActiveTimersRestored(true);
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setActiveTimersRestored(true);
          return;
        }
        const restored: Record<string, ExerciseTimerState> = {};
        Object.entries(parsed).forEach(([key, value]: [string, any]) => {
          if (!parseExerciseTimerKey(key)) return;
          const baseElapsed = Math.max(0, Math.floor(Number(value?.baseElapsed) || 0));
          const startedAtRaw = Number(value?.startedAt);
          const startedAt = Number.isFinite(startedAtRaw) && startedAtRaw > 0 ? startedAtRaw : null;
          const running = value?.running === true && startedAt != null;
          if (!running && baseElapsed <= 0) return;
          restored[key] = { running, baseElapsed, startedAt: running ? startedAt : null };
        });
        if (Object.keys(restored).length > 0) {
          setActiveTimers(restored);
          if (Object.values(restored).some(timer => timer.running)) {
            ensureTimerTicker();
          }
        }
      } catch {
        AsyncStorage.removeItem(ACTIVE_WORKOUT_TIMERS_KEY).catch(() => {});
      } finally {
        setActiveTimersRestored(true);
      }
    }).catch(() => {
      if (!cancelled) setActiveTimersRestored(true);
    });
    return () => { cancelled = true; };
  }, [ensureTimerTicker]);

  useEffect(() => {
    if (!activeTimersRestored) return;
    persistActiveWorkoutTimers(activeTimers).catch(() => {});
  }, [activeTimers, activeTimersRestored]);

  useEffect(() => {
    return () => {
      Object.values(legacyTimerIntervalsRef.current).forEach(clearInterval);
      clearManagedInterval(tickIntervalRef);
    };
  }, []);

  const getTimerElapsed = useCallback((key: string): number => (
    timerElapsedFromState(activeTimers[key])
  ), [activeTimers]);

  const startTimer = useCallback((key: string): ExerciseTimerState => {
    const existing = activeTimersRef.current[key];
    const nextTimer: ExerciseTimerState = {
      running: true,
      baseElapsed: existing?.baseElapsed ?? 0,
      startedAt: Date.now(),
    };
    setActiveTimers(prev => {
      const next = { ...prev, [key]: nextTimer };
      persistActiveWorkoutTimers(next).catch(() => {});
      return next;
    });
    ensureTimerTicker();
    return nextTimer;
  }, [ensureTimerTicker]);

  const stopTimer = useCallback((key: string): ExerciseTimerState | null => {
    const current = activeTimersRef.current[key];
    const stopped = current
      ? { running: false, baseElapsed: timerElapsedFromState(current), startedAt: null }
      : null;
    setActiveTimers(prev => {
      const timer = prev[key];
      if (!timer) return prev;
      const next = {
        ...prev,
        [key]: {
          running: false,
          baseElapsed: timerElapsedFromState(timer),
          startedAt: null,
        },
      };
      persistActiveWorkoutTimers(next).catch(() => {});
      clearTickerIfIdle(next);
      return next;
    });
    return stopped;
  }, [clearTickerIfIdle]);

  const resetTimer = useCallback((key: string): ExerciseTimerState => {
    const nextTimer: ExerciseTimerState = { running: false, baseElapsed: 0, startedAt: null };
    setActiveTimers(prev => {
      const next = { ...prev, [key]: nextTimer };
      persistActiveWorkoutTimers(next).catch(() => {});
      clearTickerIfIdle(next);
      return next;
    });
    return nextTimer;
  }, [clearTickerIfIdle]);

  return {
    activeTimers,
    activeTimersRef,
    activeTimersRestored,
    timerModalKey,
    timerModalKeyRef,
    setTimerModalKey,
    getTimerElapsed,
    timerElapsedFromState,
    parseExerciseTimerKey,
    startTimer,
    stopTimer,
    resetTimer,
    bumpTimerTick,
    ensureTimerTicker,
    subscribeTimerTick,
  };
}
