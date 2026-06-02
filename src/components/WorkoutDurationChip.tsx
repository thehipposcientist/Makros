// Workout duration chip for the active workout screen.
//
// Why this is its own component: previously the duration counter
// (`elapsed` state) ticked 1Hz inside ActiveWorkoutScreen, which
// forced the parent + every exercise card to reconcile every second.
// That couldn't stall the timer itself (the handler just calls
// setState), but ~60 reconciles/min during a 45-min session is pure
// waste, and any code that lands in the parent's render path is a
// latent risk to set-log responsiveness.
//
// This component owns its OWN ticking state. It receives `startMs`
// as a stable prop and runs an internal 1s interval to update the
// visible counter. The parent's `elapsed` state is GONE — duration
// is derived from `Date.now() - startMs` wherever a snapshot is
// needed (finish modal, summary, completion payload).
//
// Mirror of the RestTimerPanel pattern.
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (Math.max(0, Math.floor(seconds % 60))).toString().padStart(2, '0');
  return `${m}:${s}`;
}

interface Props {
  startMs: number;
  enabled: boolean;
  paused?: boolean;
  pausedAtMs?: number | null;
  pausedAccumMs?: number;
  styles: any;
  workoutPalette: any;
}

function elapsedSeconds(startMs: number, paused: boolean, pausedAtMs: number | null | undefined, pausedAccumMs: number | undefined): number {
  const endMs = paused && pausedAtMs ? pausedAtMs : Date.now();
  return Math.max(0, Math.floor((endMs - startMs - Math.max(0, pausedAccumMs ?? 0)) / 1000));
}

function WorkoutDurationChip({ startMs, enabled, paused = false, pausedAtMs = null, pausedAccumMs = 0, styles, workoutPalette }: Props) {
  const [seconds, setSeconds] = useState(() =>
    enabled ? elapsedSeconds(startMs, paused, pausedAtMs, pausedAccumMs) : 0
  );

  useEffect(() => {
    if (!enabled) {
      setSeconds(0);
      return;
    }
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      setSeconds(elapsedSeconds(startMs, paused, pausedAtMs, pausedAccumMs));
    };
    tick(); // sync immediately on mount / enable / startMs change
    if (paused) return () => { cancelled = true; };
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [startMs, enabled, paused, pausedAccumMs, pausedAtMs]);

  return (
    <View style={[styles.headerWorkoutTimer, { backgroundColor: workoutPalette.soft, borderColor: workoutPalette.strong + '44' }]}>
      <Ionicons name={paused ? 'pause' : 'time-outline'} size={13} color={workoutPalette.strong} />
      <Text style={[styles.headerWorkoutTimerText, { color: workoutPalette.strong }]}>{formatTime(seconds)}</Text>
    </View>
  );
}

export default React.memo(WorkoutDurationChip);
