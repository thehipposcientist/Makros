import { MutableRefObject, useEffect, useRef } from 'react';

export type ManagedIntervalRef = MutableRefObject<ReturnType<typeof setInterval> | null>;

export function clearManagedInterval(ref: ManagedIntervalRef): void {
  if (ref.current) {
    clearInterval(ref.current);
    ref.current = null;
  }
}

export function restartManagedInterval(
  ref: ManagedIntervalRef,
  callback: () => void,
  delayMs: number,
): void {
  clearManagedInterval(ref);
  ref.current = setInterval(callback, delayMs);
}

export function useManagedInterval(
  callback: () => void,
  delayMs: number | null,
  enabled = true,
  externalRef?: ManagedIntervalRef,
): void {
  const savedCallback = useRef(callback);
  const internalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const intervalRef = externalRef ?? internalRef;

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled || delayMs == null) {
      clearManagedInterval(intervalRef);
      return;
    }
    restartManagedInterval(intervalRef, () => savedCallback.current(), delayMs);
    return () => clearManagedInterval(intervalRef);
  }, [delayMs, enabled, intervalRef]);
}
