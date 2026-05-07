// Open-ended live workout tracker. The user picks a category +
// subtype, hits Start, and Thallo runs a timer + HR polling while
// they're moving. On Finish, the session is handed to
// LogActivityModal pre-filled with the actual duration, HR average,
// and timestamps — the user just confirms intensity and saves.
//
// Why not write directly to history on Finish?
//   Users often want to bump intensity or add distance / notes once
//   the workout is over. Routing through LogActivityModal keeps the
//   single canonical save path (same manualActivity shape, same
//   fatigue routing) instead of forking a second save function.
//
// Why is this separate from ActiveWorkoutScreen?
//   ActiveWorkoutScreen is a structured lift flow — exercise list,
//   set logging, rest timers, PR modal. This tracker is for the
//   "just going for a run" case where none of that matters.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState, Modal, View, Text, TouchableOpacity, ScrollView, Alert, StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import {
  AppThemeName, WorkoutSession,
} from '../types';
import { isHealthKitAvailable, getLatestHeartRate, getWorkoutHrSummary, getAppleWorkoutCaloriesForWindow, readHealthSummary } from '../services/appleHealth';
import { getHRZones, type HRZone } from '../services/api';
import LogActivityModal, { LogActivityPrefill } from './LogActivityModal';
import { saveWorkoutSession } from '../utils/workoutHistory';
import { startRestActivity, updateRestActivity, endRestActivity } from '../services/liveActivity';
import { clearManagedInterval, useManagedInterval } from '../hooks/useManagedInterval';
import { hrZoneColorHex, hrZoneRangeText, liveActivityHrZoneFields, zoneForHeartRate } from '../utils/hrZones';
import {
  LIVE_ACTIVITY_QUICK_START,
  liveActivityQuickStartKey,
  resolveLiveActivityQuickStart,
  type LiveActivityInitialActivity,
  type LiveActivityQuickStartOption,
} from '../utils/liveActivityQuickStart';

interface Props {
  visible: boolean;
  onClose: () => void;
  themeName?: AppThemeName;
  /** Optional — called after the save completes so the parent can
   *  refresh history / fatigue. */
  onSaved?: () => void;
  /** Optional canonical persistence path. When provided by the parent,
   *  it should save locally and sync the completion to the backend. */
  onSave?: (session: WorkoutSession) => Promise<void>;
  /** Strength picks (Push / Pull / Legs / Strength / etc) don't fit
   *  the cardio stopwatch model — they need an exercise picker + per-
   *  set logging. When this callback is provided, the strength rows
   *  in QUICK_START close this modal and call back with the focus so
   *  the parent can mount ActiveWorkoutScreen on an empty workout
   *  the user populates manually. Falls back to the stopwatch path
   *  when omitted. */
  onStartStrengthWorkout?: (focus: string) => void;
  enableHealthKit?: boolean;
  initialActivity?: LiveActivityInitialActivity | null;
  authToken?: string | null;
}

type Phase = 'pick' | 'running' | 'paused' | 'finishing';

function fmtElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export default function LiveActivityTracker({ visible, onClose, themeName, onSaved, onSave, onStartStrengthWorkout, enableHealthKit = true, initialActivity = null, authToken = null }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>('pick');
  const [choice, setChoice] = useState<LiveActivityQuickStartOption | null>(null);
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [pausedAccum, setPausedAccum] = useState<number>(0); // seconds
  const [pauseStartMs, setPauseStartMs] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const [hr, setHr] = useState<number | null>(null);
  // Simple running HR average — sum + count, not per-sample history.
  const [hrSum, setHrSum] = useState<number>(0);
  const [hrN, setHrN] = useState<number>(0);
  const [hrZones, setHrZones] = useState<HRZone[]>([]);
  const [prefill, setPrefill] = useState<LogActivityPrefill | null>(null);
  const [logModalVisible, setLogModalVisible] = useState(false);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hrIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const liveActivityIdRef = useRef<string | null>(null);
  const liveActivityGenerationRef = useRef(0);
  const autoStartKeyRef = useRef<string | null>(null);
  const canUseHealthKit = enableHealthKit && isHealthKitAvailable();
  const liveZone = zoneForHeartRate(hr, hrZones);
  const liveZoneColor = hrZoneColorHex(liveZone?.zone, tc.primary);

  const endWorkoutLiveActivity = useCallback(() => {
    liveActivityGenerationRef.current += 1;
    const id = liveActivityIdRef.current;
    liveActivityIdRef.current = null;
    if (id) endRestActivity(id).catch(() => undefined);
  }, []);

  const reset = useCallback(() => {
    endWorkoutLiveActivity();
    setPhase('pick');
    setChoice(null);
    setStartedAtMs(null);
    setPausedAccum(0);
    setPauseStartMs(null);
    setElapsedSec(0);
    setHr(null);
    setHrSum(0);
    setHrN(0);
    setPrefill(null);
    setLogModalVisible(false);
    clearManagedInterval(timerRef);
    clearManagedInterval(hrIntervalRef);
  }, [endWorkoutLiveActivity]);

  useEffect(() => {
    if (!visible || !authToken || !enableHealthKit) {
      setHrZones([]);
      return;
    }
    let cancelled = false;
    readHealthSummary()
      .then((hs: any) => getHRZones(authToken, hs?.restingHeartRate, hs?.vo2Max))
      .catch(() => getHRZones(authToken))
      .then(r => { if (!cancelled) setHrZones(r.zones ?? []); })
      .catch(() => { if (!cancelled) setHrZones([]); });
    return () => { cancelled = true; };
  }, [authToken, enableHealthKit, visible]);

  // On close from outside (e.g. swipe down without saving) clean up
  // the timers so they don't leak into the next open.
  useEffect(() => {
    if (!visible) {
      autoStartKeyRef.current = null;
      reset();
    }
    return () => {
      clearManagedInterval(timerRef);
      clearManagedInterval(hrIntervalRef);
      endWorkoutLiveActivity();
    };
  }, [visible, reset, endWorkoutLiveActivity]);

  // Timer tick — runs while phase=running; pauses accumulate a static
  // offset that's subtracted from elapsed so the paused period doesn't
  // count toward workout time.
  const tickElapsed = useCallback(() => {
    if (!startedAtMs) return;
    const now = Date.now();
    const raw = Math.floor((now - startedAtMs) / 1000);
    setElapsedSec(Math.max(0, raw - pausedAccum));
  }, [pausedAccum, startedAtMs]);
  useManagedInterval(tickElapsed, 1000, phase === 'running' && !!startedAtMs, timerRef);

  // HR polling — only while running. Uses getLatestHeartRate which
  // hits HealthKit's latest sample. Sampling every 10s is plenty for
  // a display + a running-average calculation.
  const tickHeartRate = useCallback(async () => {
    try {
      const bpm = await getLatestHeartRate();
      if (bpm && bpm > 30 && bpm < 230) {
        setHr(bpm);
        setHrSum(prev => prev + bpm);
        setHrN(prev => prev + 1);
        if (liveActivityIdRef.current) {
          updateRestActivity(liveActivityIdRef.current, liveActivityHrZoneFields(bpm, hrZones)).catch(() => undefined);
        }
      }
    } catch { /* swallow — HR isn't required */ }
  }, [hrZones]);
  const shouldPollHr = phase === 'running' && canUseHealthKit;
  useEffect(() => {
    if (!shouldPollHr) return;
    tickHeartRate();
  }, [shouldPollHr, tickHeartRate]);
  useManagedInterval(tickHeartRate, 10_000, shouldPollHr, hrIntervalRef);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (phase === 'running' && startedAtMs) tickElapsed();
      if (shouldPollHr) tickHeartRate();
    });
    return () => sub.remove();
  }, [phase, shouldPollHr, startedAtMs, tickElapsed, tickHeartRate]);

  const handleStart = (c: LiveActivityQuickStartOption) => {
    import('../utils/feedback').then(f => f.hapticMedium()).catch(() => {});
    // Strength picks don't belong in the stopwatch path — they need
    // an exercise picker + per-set logging. Hand off to the parent's
    // active-workout flow with an empty shell labeled by the focus.
    if (c.category === 'strength' && onStartStrengthWorkout) {
      const focusLabel =
        c.subtype === 'lift'         ? 'Strength'
        : c.subtype === 'push'        ? 'Push'
        : c.subtype === 'pull'        ? 'Pull'
        : c.subtype === 'legs'        ? 'Legs'
        : c.subtype === 'upper'       ? 'Upper'
        : c.subtype === 'lower'       ? 'Lower'
        : c.subtype === 'full_body'   ? 'Full Body'
        : c.subtype === 'powerlifting' ? 'Powerlifting'
        : c.subtype === 'crossfit'    ? 'CrossFit'
        : c.label;
      onStartStrengthWorkout(focusLabel);
      reset();
      onClose();
      return;
    }
    const now = Date.now();
    setChoice(c);
    setStartedAtMs(now);
    setPhase('running');
    const generation = liveActivityGenerationRef.current + 1;
    liveActivityGenerationRef.current = generation;
    const workoutId = `live_${now}`;
    startRestActivity({
      mode: 'elapsed',
      workoutId,
      exerciseName: c.label,
      setNumber: 0,
      totalSets: 0,
      startedAtMs: now,
      durationSeconds: 0,
      endDateMs: now + 12 * 60 * 60 * 1000,
      nextSetRecommendation: 'Timer running',
      themeColorHex: tc.primary,
      paused: false,
      elapsedSeconds: 0,
      ...liveActivityHrZoneFields(hr, hrZones),
    }).then((id) => {
      if (!id) return;
      if (liveActivityGenerationRef.current !== generation) {
        endRestActivity(id).catch(() => undefined);
        return;
      }
      liveActivityIdRef.current = id;
    }).catch(() => undefined);
  };

  useEffect(() => {
    if (!visible || phase !== 'pick') return;
    const option = resolveLiveActivityQuickStart(initialActivity);
    if (!option) return;
    const key = liveActivityQuickStartKey(option);
    if (autoStartKeyRef.current === key) return;
    autoStartKeyRef.current = key;
    handleStart(option);
  }, [visible, phase, initialActivity?.category, initialActivity?.subtype]);

  const handlePause = () => {
    import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
    const now = Date.now();
    const currentElapsed = startedAtMs
      ? Math.max(0, Math.floor((now - startedAtMs) / 1000) - pausedAccum)
      : elapsedSec;
    setElapsedSec(currentElapsed);
    setPauseStartMs(now);
    setPhase('paused');
    if (liveActivityIdRef.current) {
      updateRestActivity(liveActivityIdRef.current, {
        mode: 'elapsed',
        paused: true,
        elapsedSeconds: currentElapsed,
        nextSetRecommendation: 'Paused',
        ...liveActivityHrZoneFields(hr, hrZones),
      }).catch(() => undefined);
    }
  };

  const handleResume = () => {
    import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
    const resumedAt = Date.now();
    const currentElapsed = elapsedSec;
    if (pauseStartMs) {
      const paused = Math.floor((resumedAt - pauseStartMs) / 1000);
      setPausedAccum(prev => prev + paused);
      setPauseStartMs(null);
    }
    setPhase('running');
    if (liveActivityIdRef.current) {
      updateRestActivity(liveActivityIdRef.current, {
        mode: 'elapsed',
        paused: false,
        startedAtMs: resumedAt - currentElapsed * 1000,
        elapsedSeconds: currentElapsed,
        nextSetRecommendation: 'Timer running',
        ...liveActivityHrZoneFields(hr, hrZones),
      }).catch(() => undefined);
    }
  };

  const handleFinish = async () => {
    if (!choice || !startedAtMs) { reset(); onClose(); return; }
    import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
    // Snap a final elapsed before opening the log modal.
    const endedMs = phase === 'paused' && pauseStartMs
      ? pauseStartMs
      : Date.now();
    const finalSeconds = Math.max(1, Math.floor((endedMs - startedAtMs) / 1000) - pausedAccum);
    const fallbackAvgHr = hrN > 0 ? Math.round(hrSum / hrN) : null;
    endWorkoutLiveActivity();

    // Parity with AH imports: pull the authoritative HR + kcal
    // summary from HealthKit for the tracked window. HK records at
    // a higher sample rate than our 10s poll, and it also catches
    // any Apple Workout the user may have started in parallel (e.g.
    // Outdoor Run logged via the Watch's Workout app), whose calorie
    // model is better calibrated than anything we'd compute client-
    // side. Both calls are best-effort — null on failure, we still
    // save the session.
    let avgHr: number | null = fallbackAvgHr;
    let kcal: number | null = null;
    if (canUseHealthKit) {
      try {
        const hr = await getWorkoutHrSummary(startedAtMs, endedMs, null, null, hrZones).catch(() => null);
        if (hr?.avgBpm) avgHr = Math.round(hr.avgBpm);
      } catch { /* swallow — HK optional */ }
      try {
        const c = await getAppleWorkoutCaloriesForWindow(startedAtMs, endedMs).catch(() => null);
        if (c && typeof c === 'number') kcal = Math.round(c);
      } catch { /* swallow */ }
    }

    setPrefill({
      // Namespacing the id with `live_` lets the save path tag the
      // session as `source: 'live_tracker'` for analytics, and keeps
      // it distinct from manual-retro and HK-import sessions.
      externalId: `live_${startedAtMs}`,
      dateISO: new Date(startedAtMs).toISOString(),
      startedAtISO: new Date(startedAtMs).toISOString(),
      endedAtISO: new Date(endedMs).toISOString(),
      durationMin: Math.max(1, Math.round(finalSeconds / 60)),
      category: choice.category,
      subtype: choice.subtype,
      cardioStyle: choice.cardioStyle,
      avgHeartRate: avgHr,
      caloriesBurned: kcal,
    });
    setPhase('finishing');
    setLogModalVisible(true);
  };

  const handleDiscard = () => {
    Alert.alert(
      'Discard workout?',
      'The timer + HR you recorded will be thrown away. This can\'t be undone.',
      [
        { text: 'Keep going', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => { reset(); onClose(); },
        },
      ],
    );
  };

  const handleSaveConfirmed = async (session: WorkoutSession) => {
    if (onSave) {
      await onSave(session);
    } else {
      await saveWorkoutSession(session);
    }
    reset();
    onClose();
    onSaved?.();
  };

  return (
    <>
      <Modal visible={visible && phase !== 'finishing'} animationType="slide" onRequestClose={onClose}>
        <View style={[styles.root, { backgroundColor: tc.background }]}>
          {phase === 'pick' ? (
            <>
              <View style={[styles.header, { borderBottomColor: tc.border, paddingTop: insets.top + 6 }]}>
                <TouchableOpacity
                  testID="live-tracker-close"
                  accessibilityLabel="live-tracker-close"
                  onPress={onClose}
                  style={styles.headerBtn}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                  <Ionicons name="close" size={26} color={tc.textPrimary} />
                </TouchableOpacity>
                <Text style={[styles.headerTitle, { color: tc.textPrimary }]}>Custom Workout</Text>
                <View style={styles.headerBtn} />
              </View>
              <Text style={{ fontSize: 12, color: tc.textMuted, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }}>
                {canUseHealthKit
                  ? "Pick a type. We'll time it and sync HR from Apple Health."
                  : "Pick a type. We'll time it and save the activity to your log."}
              </Text>
              <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
                {LIVE_ACTIVITY_QUICK_START.map((c) => (
                  <TouchableOpacity
                    key={`${c.category}-${c.subtype}`}
                    testID={`live-quickstart-${c.category}-${c.subtype}`}
                    accessibilityLabel={`live-quickstart-${c.category}-${c.subtype}`}
                    onPress={() => handleStart(c)}
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: 12,
                      padding: 14, borderRadius: radius.lg,
                      borderWidth: 1, borderColor: tc.border,
                      backgroundColor: tc.surface,
                    }}>
                    <View style={{
                      width: 40, height: 40, borderRadius: 20,
                      alignItems: 'center', justifyContent: 'center',
                      backgroundColor: tc.primary + '20',
                    }}>
                      <Ionicons name={c.icon as any} size={20} color={tc.primary} />
                    </View>
                    <Text style={{ flex: 1, fontSize: 15, fontWeight: '700', color: tc.textPrimary }}>
                      {c.label}
                    </Text>
                    <Ionicons name="play-circle" size={22} color={tc.primary} />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </>
          ) : (
            <View style={{ flex: 1, padding: 20, paddingTop: insets.top + 12, justifyContent: 'space-between' }}>
              <View>
                <Text style={{ fontSize: 12, color: tc.textMuted, letterSpacing: 1.4, fontWeight: '700' }}>
                  {choice?.label.toUpperCase()}
                </Text>
                <Text style={{
                  fontSize: 84, fontWeight: '900', color: tc.textPrimary,
                  marginTop: 6, letterSpacing: -3, fontVariant: ['tabular-nums'],
                }}>
                  {fmtElapsed(elapsedSec)}
                </Text>
                {phase === 'paused' && (
                  <Text style={{ fontSize: 12, fontWeight: '800', color: tc.warning, letterSpacing: 1.2 }}>
                    PAUSED
                  </Text>
                )}
                <View style={{ flexDirection: 'row', gap: 20, marginTop: 28 }}>
                  <View>
                    <Text style={{ fontSize: 10, color: tc.textMuted, fontWeight: '700', letterSpacing: 1 }}>
                      HEART RATE
                    </Text>
                    <Text style={{ fontSize: 28, fontWeight: '900', color: hr != null && hr > 0 ? liveZoneColor : tc.error, marginTop: 4 }}>
                      {hr != null ? `${hr}` : '—'}
                    </Text>
                    <Text style={{ fontSize: 10, color: tc.textMuted }}>
                      {hrN > 0 ? `avg ${Math.round(hrSum / hrN)} bpm` : 'bpm'}
                    </Text>
                    {hr != null && hr > 0 ? (
                      <View style={{
                        flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8,
                        alignSelf: 'flex-start', borderRadius: 999, borderWidth: 1,
                        borderColor: liveZoneColor + '66', backgroundColor: liveZoneColor + '18',
                        paddingHorizontal: 9, paddingVertical: 5,
                      }}>
                        <Text style={{ fontSize: 11, fontWeight: '900', color: liveZoneColor }}>
                          {liveZone ? `Z${liveZone.zone}` : 'HR'}
                        </Text>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textMuted }}>
                          {liveZone ? hrZoneRangeText(liveZone) : 'live'}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </View>
              </View>
              <View style={{ gap: 10 }}>
                {phase === 'running' ? (
                  <TouchableOpacity
                    testID="live-pause"
                    accessibilityLabel="live-pause"
                    onPress={handlePause}
                    style={{
                      paddingVertical: 16, borderRadius: 14,
                      backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                      alignItems: 'center',
                    }}>
                    <Text style={{ fontSize: 15, fontWeight: '800', color: tc.textSecondary }}>Pause</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    testID="live-resume"
                    accessibilityLabel="live-resume"
                    onPress={handleResume}
                    style={{
                      paddingVertical: 16, borderRadius: 14,
                      backgroundColor: tc.primary,
                      alignItems: 'center',
                    }}>
                    <Text style={{ fontSize: 15, fontWeight: '800', color: tc.background }}>Resume</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  testID="live-finish"
                  accessibilityLabel="live-finish"
                  onPress={handleFinish}
                  style={{
                    paddingVertical: 16, borderRadius: 14,
                    backgroundColor: tc.success,
                    alignItems: 'center',
                  }}>
                  <Text style={{ fontSize: 15, fontWeight: '800', color: '#fff' }}>Finish</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  testID="live-discard"
                  accessibilityLabel="live-discard"
                  onPress={handleDiscard}
                  style={{
                    paddingVertical: 12, alignItems: 'center',
                  }}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textMuted }}>Discard</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      </Modal>

      <LogActivityModal
        visible={logModalVisible}
        onClose={() => {
          // User bailed on saving the finished workout. Reset so the
          // tracker starts clean next open. We deliberately don't
          // persist a silent save here — if the user dismisses the
          // confirm step we trust that they didn't want the workout.
          setLogModalVisible(false);
          reset();
          onClose();
        }}
        onSave={handleSaveConfirmed}
        themeName={themeName}
        prefill={prefill}
      />
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 10, paddingVertical: 10,
    borderBottomWidth: 1,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 16, fontWeight: '800' },
});
