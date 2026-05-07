import { useState, useEffect, useRef, useCallback } from 'react';
import { AppState, View, Text, TouchableOpacity, Modal, StyleSheet, Vibration } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme } from '../constants/theme';
import { AppThemeName } from '../types';
import Svg, { Circle } from 'react-native-svg';
import { clearManagedInterval, useManagedInterval } from '../hooks/useManagedInterval';
import { getLatestHeartRate, isHealthKitAvailable } from '../services/appleHealth';
import type { HRZone } from '../services/api';
import { hrZoneColorHex, hrZoneRangeText, zoneForHeartRate } from '../utils/hrZones';

export type TimerMode = 'amrap' | 'emom' | 'tabata';

interface Props {
  visible: boolean;
  mode: TimerMode;
  onClose: () => void;
  onComplete: (result: TimerResult) => void;
  themeName?: AppThemeName;
  amrapCapSeconds?: number;
  emomIntervalSeconds?: number;
  emomRounds?: number;
  tabataWorkSeconds?: number;
  tabataRestSeconds?: number;
  tabataRounds?: number;
  exerciseName?: string;
  hrZones?: HRZone[];
}

export interface TimerResult {
  mode: TimerMode;
  totalSeconds: number;
  roundsCompleted: number;
  reps?: number;
}

type Phase = 'work' | 'rest' | 'countdown';

export default function WorkoutTimerModal({
  visible, mode, onClose, onComplete, themeName,
  amrapCapSeconds = 600,
  emomIntervalSeconds = 60,
  emomRounds = 10,
  tabataWorkSeconds = 20,
  tabataRestSeconds = 10,
  tabataRounds = 8,
  exerciseName,
  hrZones = [],
}: Props) {
  const theme = getTheme(themeName ?? 'dark');
  const colors = theme.colors;

  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [currentRound, setCurrentRound] = useState(1);
  const [phase, setPhase] = useState<Phase>('work');
  const [phaseRemaining, setPhaseRemaining] = useState(0);
  const [amrapReps, setAmrapReps] = useState(0);
  const [hr, setHr] = useState<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hrIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);
  const phaseStartRef = useRef(0);

  const totalRounds = mode === 'tabata' ? tabataRounds : mode === 'emom' ? emomRounds : 1;
  const totalDuration = mode === 'amrap' ? amrapCapSeconds
    : mode === 'emom' ? emomRounds * emomIntervalSeconds
    : tabataRounds * (tabataWorkSeconds + tabataRestSeconds);

  const reset = useCallback(() => {
    clearManagedInterval(intervalRef);
    clearManagedInterval(hrIntervalRef);
    setRunning(false);
    setFinished(false);
    setElapsed(0);
    setCurrentRound(1);
    setPhase('work');
    setPhaseRemaining(mode === 'amrap' ? amrapCapSeconds : mode === 'emom' ? emomIntervalSeconds : tabataWorkSeconds);
    setAmrapReps(0);
    setHr(null);
  }, [mode, amrapCapSeconds, emomIntervalSeconds, tabataWorkSeconds]);

  useEffect(() => {
    if (visible) reset();
  }, [visible, reset]);

  const tick = useCallback(() => {
    const now = Date.now();
    const totalElapsed = Math.floor((now - startTimeRef.current) / 1000);
    setElapsed(totalElapsed);

    if (mode === 'amrap') {
      const rem = Math.max(0, amrapCapSeconds - totalElapsed);
      setPhaseRemaining(rem);
      if (rem <= 0) {
        clearManagedInterval(intervalRef);
        setRunning(false);
        setFinished(true);
        Vibration.vibrate([0, 500, 200, 500]);
      } else if (rem <= 3) {
        Vibration.vibrate(100);
      }
      return;
    }

    if (mode === 'emom') {
      const phaseElapsed = Math.floor((now - phaseStartRef.current) / 1000);
      const rem = Math.max(0, emomIntervalSeconds - phaseElapsed);
      setPhaseRemaining(rem);
      if (rem <= 0) {
        if (currentRound >= emomRounds) {
          clearManagedInterval(intervalRef);
          setRunning(false);
          setFinished(true);
          Vibration.vibrate([0, 500, 200, 500]);
        } else {
          phaseStartRef.current = now;
          setCurrentRound(r => r + 1);
          setPhaseRemaining(emomIntervalSeconds);
          Vibration.vibrate([0, 200, 100, 200]);
        }
      } else if (rem <= 3) {
        Vibration.vibrate(100);
      }
      return;
    }

    // Tabata
    const phaseElapsed = Math.floor((now - phaseStartRef.current) / 1000);
    const currentPhaseDuration = phase === 'work' ? tabataWorkSeconds : tabataRestSeconds;
    const rem = Math.max(0, currentPhaseDuration - phaseElapsed);
    setPhaseRemaining(rem);

    if (rem <= 0) {
      if (phase === 'work') {
        if (currentRound >= tabataRounds) {
          clearManagedInterval(intervalRef);
          setRunning(false);
          setFinished(true);
          Vibration.vibrate([0, 500, 200, 500]);
        } else {
          phaseStartRef.current = now;
          setPhase('rest');
          setPhaseRemaining(tabataRestSeconds);
          Vibration.vibrate([0, 300]);
        }
      } else {
        phaseStartRef.current = now;
        setPhase('work');
        setCurrentRound(r => r + 1);
        setPhaseRemaining(tabataWorkSeconds);
        Vibration.vibrate([0, 200, 100, 200]);
      }
    } else if (rem <= 3) {
      Vibration.vibrate(100);
    }
  }, [mode, amrapCapSeconds, emomIntervalSeconds, emomRounds, tabataWorkSeconds, tabataRestSeconds, tabataRounds, currentRound, phase]);

  useManagedInterval(tick, 500, running, intervalRef);

  const tickHeartRate = useCallback(async () => {
    try {
      const bpm = await getLatestHeartRate();
      if (bpm && bpm > 30 && bpm < 230) setHr(bpm);
    } catch {}
  }, []);
  const shouldPollHr = visible && running && isHealthKitAvailable();
  useEffect(() => {
    if (!shouldPollHr) return;
    tickHeartRate();
  }, [shouldPollHr, tickHeartRate]);
  useManagedInterval(tickHeartRate, 6000, shouldPollHr, hrIntervalRef);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !visible || !running) return;
      tick();
      if (shouldPollHr) tickHeartRate();
    });
    return () => sub.remove();
  }, [running, shouldPollHr, tick, tickHeartRate, visible]);

  const handleStart = () => {
    const now = Date.now();
    startTimeRef.current = now;
    phaseStartRef.current = now;
    setRunning(true);
    setFinished(false);
    setPhase('work');
    setCurrentRound(1);
    setPhaseRemaining(mode === 'amrap' ? amrapCapSeconds : mode === 'emom' ? emomIntervalSeconds : tabataWorkSeconds);
    Vibration.vibrate(200);
  };

  const handleStop = () => {
    clearManagedInterval(intervalRef);
    setRunning(false);
    setFinished(true);
  };

  const handleDone = () => {
    onComplete({
      mode,
      totalSeconds: elapsed,
      roundsCompleted: mode === 'amrap' ? 1 : currentRound,
      reps: mode === 'amrap' ? amrapReps : undefined,
    });
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const progress = totalDuration > 0 ? Math.min(1, elapsed / totalDuration) : 0;
  const ringSize = 200;
  const strokeWidth = 10;
  const r = (ringSize - strokeWidth) / 2;
  const circumference = 2 * Math.PI * r;
  const strokeDashoffset = circumference * (1 - progress);

  const modeLabel = mode === 'amrap' ? 'AMRAP' : mode === 'emom' ? 'EMOM' : 'TABATA';
  const phaseColor = phase === 'rest' ? colors.success : colors.primary;
  const liveZone = zoneForHeartRate(hr, hrZones);
  const liveZoneColor = hrZoneColorHex(liveZone?.zone, colors.primary);

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={[s.overlay, { backgroundColor: colors.background + 'F5' }]}>
        <View style={s.header}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Ionicons name="close" size={26} color={colors.textPrimary} />
          </TouchableOpacity>
          <Text style={[s.modeLabel, { color: colors.primary }]}>{modeLabel}</Text>
          <View style={{ width: 26 }} />
        </View>

        {exerciseName ? (
          <Text style={[s.exerciseName, { color: colors.textSecondary }]}>{exerciseName}</Text>
        ) : null}

        {/* Ring + time */}
        <View style={s.ringWrap}>
          <Svg width={ringSize} height={ringSize}>
            <Circle cx={ringSize / 2} cy={ringSize / 2} r={r} stroke={colors.border} strokeWidth={strokeWidth} fill="none" />
            <Circle cx={ringSize / 2} cy={ringSize / 2} r={r} stroke={phaseColor} strokeWidth={strokeWidth} fill="none"
              strokeDasharray={`${circumference}`} strokeDashoffset={strokeDashoffset}
              strokeLinecap="round" rotation="-90" origin={`${ringSize / 2}, ${ringSize / 2}`} />
          </Svg>
          <View style={s.ringCenter}>
            <Text style={[s.bigTime, { color: colors.textPrimary }]}>{formatTime(phaseRemaining)}</Text>
            {mode !== 'amrap' && (
              <Text style={[s.phaseText, { color: phaseColor }]}>
                {phase === 'rest' ? 'REST' : 'WORK'}
              </Text>
            )}
          </View>
        </View>

        {hr != null && hr > 0 ? (
          <View style={[
            s.hrZonePill,
            { backgroundColor: liveZoneColor + '18', borderColor: liveZoneColor + '66' },
          ]}>
            <Ionicons name="heart" size={14} color={liveZoneColor} />
            <Text style={[s.hrZoneText, { color: liveZoneColor }]}>
              {liveZone ? `Z${liveZone.zone} ${hr}` : `${hr}`} bpm
            </Text>
            {liveZone ? (
              <Text style={[s.hrZoneRange, { color: colors.textMuted }]}>
                {hrZoneRangeText(liveZone)}
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* Stats row */}
        <View style={s.statsRow}>
          <View style={s.stat}>
            <Text style={[s.statValue, { color: colors.textPrimary }]}>{formatTime(elapsed)}</Text>
            <Text style={[s.statLabel, { color: colors.textMuted }]}>Total</Text>
          </View>
          {mode !== 'amrap' && (
            <View style={s.stat}>
              <Text style={[s.statValue, { color: colors.textPrimary }]}>{currentRound}/{totalRounds}</Text>
              <Text style={[s.statLabel, { color: colors.textMuted }]}>Round</Text>
            </View>
          )}
          {mode === 'amrap' && (
            <View style={s.stat}>
              <Text style={[s.statValue, { color: colors.textPrimary }]}>{amrapReps}</Text>
              <Text style={[s.statLabel, { color: colors.textMuted }]}>Reps</Text>
            </View>
          )}
        </View>

        {/* AMRAP rep counter */}
        {mode === 'amrap' && running && (
          <View style={s.repRow}>
            <TouchableOpacity style={[s.repBtn, { backgroundColor: colors.surfaceRaised, borderColor: colors.border }]}
              onPress={() => setAmrapReps(r => Math.max(0, r - 1))}>
              <Ionicons name="remove" size={24} color={colors.textPrimary} />
            </TouchableOpacity>
            <TouchableOpacity style={[s.repBtnBig, { backgroundColor: colors.primary }]}
              onPress={() => { setAmrapReps(r => r + 1); Vibration.vibrate(50); }}>
              <Ionicons name="add" size={28} color={colors.background} />
            </TouchableOpacity>
          </View>
        )}

        {/* Controls */}
        <View style={s.controls}>
          {!running && !finished && (
            <TouchableOpacity style={[s.mainBtn, { backgroundColor: colors.primary }]} onPress={handleStart}>
              <Ionicons name="play" size={24} color={colors.background} />
              <Text style={[s.mainBtnText, { color: colors.background }]}>Start</Text>
            </TouchableOpacity>
          )}
          {running && (
            <TouchableOpacity style={[s.mainBtn, { backgroundColor: colors.error ?? '#EF4444' }]} onPress={handleStop}>
              <Ionicons name="stop" size={24} color="#fff" />
              <Text style={[s.mainBtnText, { color: '#fff' }]}>Stop</Text>
            </TouchableOpacity>
          )}
          {finished && (
            <View style={{ gap: 10 }}>
              <TouchableOpacity style={[s.mainBtn, { backgroundColor: colors.primary }]} onPress={handleDone}>
                <Ionicons name="checkmark" size={24} color={colors.background} />
                <Text style={[s.mainBtnText, { color: colors.background }]}>Done</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.mainBtn, { backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.border }]} onPress={reset}>
                <Ionicons name="refresh" size={20} color={colors.textPrimary} />
                <Text style={[s.mainBtnText, { color: colors.textPrimary }]}>Restart</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, paddingTop: 60, paddingHorizontal: 24, alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginBottom: 12 },
  modeLabel: { fontSize: 18, fontWeight: '800', letterSpacing: 2 },
  exerciseName: { fontSize: 14, fontWeight: '600', marginBottom: 20 },
  ringWrap: { position: 'relative', width: 200, height: 200, alignItems: 'center', justifyContent: 'center', marginVertical: 20 },
  ringCenter: { position: 'absolute', alignItems: 'center' },
  bigTime: { fontSize: 48, fontWeight: '700', fontVariant: ['tabular-nums'] },
  phaseText: { fontSize: 16, fontWeight: '700', marginTop: 2 },
  hrZonePill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, minHeight: 34 },
  hrZoneText: { fontSize: 13, fontWeight: '900', fontVariant: ['tabular-nums'] },
  hrZoneRange: { fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
  statsRow: { flexDirection: 'row', gap: 32, marginVertical: 16 },
  stat: { alignItems: 'center' },
  statValue: { fontSize: 22, fontWeight: '700', fontVariant: ['tabular-nums'] },
  statLabel: { fontSize: 12, fontWeight: '600', marginTop: 2 },
  repRow: { flexDirection: 'row', alignItems: 'center', gap: 20, marginVertical: 12 },
  repBtn: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  repBtnBig: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  controls: { marginTop: 24, width: '100%', alignItems: 'center' },
  mainBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, paddingHorizontal: 32, borderRadius: 14, minWidth: 180 },
  mainBtnText: { fontSize: 17, fontWeight: '700' },
});
