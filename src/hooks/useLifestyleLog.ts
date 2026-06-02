import { useCallback, useEffect, useState } from 'react';
import {
  DailyLifestyleLog,
  DailyLifestyleLogPayload,
  getLifestyleLog,
} from '../services/api';
import {
  findPendingLifestyleLog,
  flushPendingLifestyleLogs,
  upsertLifestyleLogOfflineSafe,
} from '../utils/lifestyleLogQueue';

type LifestyleLogState = {
  log: DailyLifestyleLog | null;
  loading: boolean;
  saving: boolean;
  pending: boolean;
  reload: () => Promise<void>;
  save: (payload: DailyLifestyleLogPayload) => Promise<DailyLifestyleLog | null>;
};

function overlayPending(
  localDate: string,
  serverLog: DailyLifestyleLog | null,
  pending: Awaited<ReturnType<typeof findPendingLifestyleLog>>,
): DailyLifestyleLog | null {
  if (!pending) return serverLog;
  return {
    ...(serverLog ?? { localDate: localDate.slice(0, 10), hasLog: true }),
    ...pending.payload,
    localDate: pending.localDate,
    pending: true,
  };
}

export function useLifestyleLog(authToken: string | null | undefined, localDate: string, enabled = true): LifestyleLogState {
  const dateKey = localDate.slice(0, 10);
  const [log, setLog] = useState<DailyLifestyleLog | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState(false);

  const reload = useCallback(async () => {
    if (!enabled || !authToken) {
      setLog(null);
      setPending(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      await flushPendingLifestyleLogs(authToken).catch(() => 0);
      const serverLog = await getLifestyleLog(authToken, dateKey);
      const pendingDraft = await findPendingLifestyleLog(dateKey);
      const merged = overlayPending(dateKey, serverLog, pendingDraft);
      setLog(merged);
      setPending(Boolean(pendingDraft));
    } finally {
      setLoading(false);
    }
  }, [authToken, dateKey, enabled]);

  useEffect(() => {
    let cancelled = false;
    if (!enabled || !authToken) {
      setLog(null);
      setPending(false);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    (async () => {
      try {
        await flushPendingLifestyleLogs(authToken).catch(() => 0);
        const serverLog = await getLifestyleLog(authToken, dateKey);
        const pendingDraft = await findPendingLifestyleLog(dateKey);
        if (!cancelled) {
          const merged = overlayPending(dateKey, serverLog, pendingDraft);
          setLog(merged);
          setPending(Boolean(pendingDraft));
        }
      } catch {
        const pendingDraft = await findPendingLifestyleLog(dateKey);
        if (!cancelled) {
          const merged = overlayPending(dateKey, null, pendingDraft);
          setLog(merged);
          setPending(Boolean(pendingDraft));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authToken, dateKey, enabled]);

  const save = useCallback(async (payload: DailyLifestyleLogPayload) => {
    if (!enabled || !authToken) return null;
    const optimistic: DailyLifestyleLog = {
      ...(log ?? { localDate: dateKey, hasLog: true }),
      ...payload,
      localDate: dateKey,
    };
    setLog(optimistic);
    setSaving(true);
    try {
      const saved = await upsertLifestyleLogOfflineSafe(authToken, dateKey, payload);
      setLog(saved);
      setPending(Boolean(saved.pending));
      return saved;
    } finally {
      setSaving(false);
    }
  }, [authToken, dateKey, enabled, log]);

  return { log, loading, saving, pending, reload, save };
}
