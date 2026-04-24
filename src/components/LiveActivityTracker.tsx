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
  Modal, View, Text, TouchableOpacity, ScrollView, Alert, StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import {
  AppThemeName, WorkoutSession,
  ActivityCategory, ActivityIntensity, CardioStyle,
} from '../types';
import { isHealthKitAvailable, getLatestHeartRate, getWorkoutHrSummary, getAppleWorkoutCaloriesForWindow } from '../services/appleHealth';
import LogActivityModal, { LogActivityPrefill } from './LogActivityModal';
import { saveWorkoutSession } from '../utils/workoutHistory';

interface Props {
  visible: boolean;
  onClose: () => void;
  themeName?: AppThemeName;
  /** Optional — called after the save completes so the parent can
   *  refresh history / fatigue. */
  onSaved?: () => void;
}

// Minimal category + subtype picker — mirrors LogActivityModal's
// taxonomy but trimmed to live-trackable activities. Sport + strength
// could be supported later; start with the obvious ones.
const QUICK_START: {
  category: ActivityCategory;
  subtype: string;
  label: string;
  icon: string;
  cardioStyle?: CardioStyle;
}[] = [
  { category: 'cardio', subtype: 'run',    label: 'Run',    icon: 'walk-outline', cardioStyle: 'steady' },
  { category: 'cardio', subtype: 'walk',   label: 'Walk',   icon: 'footsteps-outline', cardioStyle: 'easy' },
  { category: 'cardio', subtype: 'hike',   label: 'Hike',   icon: 'trail-sign-outline', cardioStyle: 'steady' },
  { category: 'cardio', subtype: 'ride',   label: 'Ride',   icon: 'bicycle-outline', cardioStyle: 'steady' },
  { category: 'cardio', subtype: 'swim',   label: 'Swim',   icon: 'water-outline', cardioStyle: 'steady' },
  { category: 'cardio', subtype: 'row',    label: 'Row',    icon: 'boat-outline', cardioStyle: 'steady' },
  { category: 'cardio', subtype: 'spin',   label: 'Spin',   icon: 'fitness-outline', cardioStyle: 'intervals' },
  { category: 'cardio', subtype: 'stair',  label: 'Stair',  icon: 'trending-up-outline', cardioStyle: 'steady' },
  { category: 'cardio', subtype: 'bootcamp', label: 'HIIT', icon: 'flame-outline', cardioStyle: 'intervals' },
  { category: 'sport',  subtype: 'basketball', label: 'Basketball', icon: 'basketball-outline' },
  { category: 'sport',  subtype: 'tennis', label: 'Tennis', icon: 'tennisball-outline' },
  { category: 'sport',  subtype: 'pickleball', label: 'Pickleball', icon: 'tennisball-outline' },
  { category: 'sport',  subtype: 'golf',  label: 'Golf',   icon: 'golf-outline' },
  { category: 'mobility', subtype: 'yoga', label: 'Yoga',  icon: 'body-outline' },
  { category: 'mobility', subtype: 'stretching', label: 'Stretch', icon: 'resize-outline' },
];

type Phase = 'pick' | 'running' | 'paused' | 'finishing';

function fmtElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export default function LiveActivityTracker({ visible, onClose, themeName, onSaved }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [phase, setPhase] = useState<Phase>('pick');
  const [choice, setChoice] = useState<typeof QUICK_START[number] | null>(null);
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [pausedAccum, setPausedAccum] = useState<number>(0); // seconds
  const [pauseStartMs, setPauseStartMs] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const [hr, setHr] = useState<number | null>(null);
  // Simple running HR average — sum + count, not per-sample history.
  const [hrSum, setHrSum] = useState<number>(0);
  const [hrN, setHrN] = useState<number>(0);
  const [prefill, setPrefill] = useState<LogActivityPrefill | null>(null);
  const [logModalVisible, setLogModalVisible] = useState(false);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hrIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const reset = useCallback(() => {
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
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (hrIntervalRef.current) { clearInterval(hrIntervalRef.current); hrIntervalRef.current = null; }
  }, []);

  // On close from outside (e.g. swipe down without saving) clean up
  // the timers so they don't leak into the next open.
  useEffect(() => {
    if (!visible) reset();
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (hrIntervalRef.current) clearInterval(hrIntervalRef.current);
    };
  }, [visible, reset]);

  // Timer tick — runs while phase=running; pauses accumulate a static
  // offset that's subtracted from elapsed so the paused period doesn't
  // count toward workout time.
  useEffect(() => {
    if (phase !== 'running' || !startedAtMs) return;
    timerRef.current = setInterval(() => {
      const now = Date.now();
      const raw = Math.floor((now - startedAtMs) / 1000);
      setElapsedSec(Math.max(0, raw - pausedAccum));
    }, 1000);
    return () => {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    };
  }, [phase, startedAtMs, pausedAccum]);

  // HR polling — only while running. Uses getLatestHeartRate which
  // hits HealthKit's latest sample. Sampling every 10s is plenty for
  // a display + a running-average calculation.
  useEffect(() => {
    if (phase !== 'running') return;
    if (!isHealthKitAvailable()) return;
    const tick = async () => {
      try {
        const bpm = await getLatestHeartRate();
        if (bpm && bpm > 30 && bpm < 230) {
          setHr(bpm);
          setHrSum(prev => prev + bpm);
          setHrN(prev => prev + 1);
        }
      } catch { /* swallow — HR isn't required */ }
    };
    tick();
    hrIntervalRef.current = setInterval(tick, 10_000);
    return () => {
      if (hrIntervalRef.current) { clearInterval(hrIntervalRef.current); hrIntervalRef.current = null; }
    };
  }, [phase]);

  const handleStart = (c: typeof QUICK_START[number]) => {
    import('../utils/feedback').then(f => f.hapticMedium()).catch(() => {});
    setChoice(c);
    setStartedAtMs(Date.now());
    setPhase('running');
  };

  const handlePause = () => {
    import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
    setPauseStartMs(Date.now());
    setPhase('paused');
  };

  const handleResume = () => {
    import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
    if (pauseStartMs) {
      const paused = Math.floor((Date.now() - pauseStartMs) / 1000);
      setPausedAccum(prev => prev + paused);
      setPauseStartMs(null);
    }
    setPhase('running');
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
    try {
      const hr = await getWorkoutHrSummary(startedAtMs, endedMs).catch(() => null);
      if (hr?.avgBpm) avgHr = Math.round(hr.avgBpm);
    } catch { /* swallow — HK optional */ }
    try {
      const c = await getAppleWorkoutCaloriesForWindow(startedAtMs, endedMs).catch(() => null);
      if (c && typeof c === 'number') kcal = Math.round(c);
    } catch { /* swallow */ }

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
    await saveWorkoutSession(session);
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
              <View style={[styles.header, { borderBottomColor: tc.border }]}>
                <TouchableOpacity onPress={onClose} style={styles.headerBtn}>
                  <Ionicons name="close" size={22} color={tc.textPrimary} />
                </TouchableOpacity>
                <Text style={[styles.headerTitle, { color: tc.textPrimary }]}>Start Workout</Text>
                <View style={styles.headerBtn} />
              </View>
              <Text style={{ fontSize: 12, color: tc.textMuted, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }}>
                Pick a type. We'll time it and sync HR from Apple Health.
              </Text>
              <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
                {QUICK_START.map((c) => (
                  <TouchableOpacity
                    key={`${c.category}-${c.subtype}`}
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
            <View style={{ flex: 1, padding: 20, justifyContent: 'space-between' }}>
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
                    <Text style={{ fontSize: 28, fontWeight: '900', color: tc.error, marginTop: 4 }}>
                      {hr != null ? `${hr}` : '—'}
                    </Text>
                    <Text style={{ fontSize: 10, color: tc.textMuted }}>
                      {hrN > 0 ? `avg ${Math.round(hrSum / hrN)} bpm` : 'bpm'}
                    </Text>
                  </View>
                </View>
              </View>
              <View style={{ gap: 10 }}>
                {phase === 'running' ? (
                  <TouchableOpacity
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
                  onPress={handleFinish}
                  style={{
                    paddingVertical: 16, borderRadius: 14,
                    backgroundColor: tc.success,
                    alignItems: 'center',
                  }}>
                  <Text style={{ fontSize: 15, fontWeight: '800', color: '#fff' }}>Finish</Text>
                </TouchableOpacity>
                <TouchableOpacity
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
