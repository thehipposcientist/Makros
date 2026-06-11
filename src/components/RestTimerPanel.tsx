// Rest-timer panel for the active workout screen.
//
// Why this is its own component: previously the rest countdown
// (`restRemaining` state) ticked 1Hz inside ActiveWorkoutScreen,
// which forced the parent + every exercise card to re-render on
// every tick. With 60–120 second rest periods that's 60–120 full-
// screen re-renders per rest — visible as input lag and timer
// stutter on slow devices and cellular.
//
// This component owns its OWN ticking state. It receives the rest
// `endsAtMs` / `totalSeconds` as stable props from the parent and
// runs an internal 500ms interval to update the visible countdown.
// The parent's `restRemaining` state now only changes at boundaries
// (start = total, end = 0) — two re-renders per rest period instead
// of 60+. Side-effects that need to fire during the rest (watch push,
// AsyncStorage persistence, end-of-rest sounds) stay in the parent's
// own interval, which uses a ref-based cadence so it doesn't trigger
// re-renders.

import React, { useEffect, useState } from 'react';
import { Platform, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle } from 'react-native-svg';

interface Props {
  endsAtMs: number;
  totalSeconds: number;
  restForExercise: string | null;
  restNextTarget: string | null;
  restCue: string | null;
  restRecommendationLoading: boolean;
  watchStatus: { paired: boolean; reachable: boolean } | null;
  themeColors: any;
  workoutPalette: any;
  styles: any;
  onAdjust: (deltaSeconds: number) => void;
  onSkip: () => void;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.max(0, Math.floor(seconds % 60));
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function RestTimerPanel({
  endsAtMs,
  totalSeconds,
  restForExercise,
  restNextTarget,
  restCue,
  restRecommendationLoading,
  watchStatus,
  themeColors,
  workoutPalette,
  styles,
  onAdjust,
  onSkip,
}: Props) {
  // Local, isolated tick state. Only THIS component re-renders on
  // every interval fire — the parent and the 8 exercise cards stay
  // untouched.
  const [seconds, setSeconds] = useState(() => Math.max(0, Math.ceil((endsAtMs - Date.now()) / 1000)));

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const remaining = Math.max(0, Math.ceil((endsAtMs - Date.now()) / 1000));
      setSeconds(remaining);
    };
    tick(); // initial sync in case endsAtMs changed between mount and effect
    const id = setInterval(tick, 500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // endsAtMs changes when the user adds/subtracts time mid-rest;
    // restart the interval against the new boundary.
  }, [endsAtMs]);

  const ringSize = 82;
  const ringStroke = 7;
  const ringRadius = (ringSize - ringStroke) / 2;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringTotal = Math.max(totalSeconds || seconds, seconds, 1);
  const ringProgress = Math.max(0, Math.min(1, seconds / ringTotal));
  const ringOffset = ringCircumference * (1 - ringProgress);
  const isLowTime = seconds <= 10;

  // Local toggle for the cue (the "why" behind the weight × reps target).
  // Default collapsed — the rest panel just shows the target. Tapping the
  // info button reveals the explanation inline.
  const [cueExpanded, setCueExpanded] = useState(false);

  return (
    <View
      testID="rest-timer-panel"
      accessibilityLabel="rest-timer-panel"
      style={[styles.headerRestPanel, { backgroundColor: workoutPalette.soft, borderColor: workoutPalette.strong + '33' }]}>
      <View style={styles.headerRestMainRow}>
        <View style={styles.headerRestCircle}>
          <Svg width={ringSize} height={ringSize} style={{ position: 'absolute' }}>
            <Circle
              cx={ringSize / 2}
              cy={ringSize / 2}
              r={ringRadius}
              stroke={themeColors.background + 'AA'}
              strokeWidth={ringStroke}
              fill="transparent"
            />
            <Circle
              cx={ringSize / 2}
              cy={ringSize / 2}
              r={ringRadius}
              stroke={isLowTime ? themeColors.warning : workoutPalette.strong}
              strokeWidth={ringStroke}
              fill="transparent"
              strokeLinecap="round"
              strokeDasharray={`${ringCircumference} ${ringCircumference}`}
              strokeDashoffset={ringOffset}
              rotation="-90"
              originX={ringSize / 2}
              originY={ringSize / 2}
            />
          </Svg>
          <Text style={[styles.headerRestCircleLabel, { color: workoutPalette.text }]}>Rest</Text>
          <Text
            testID="rest-timer-value"
            style={[styles.headerRestCircleValue, { color: isLowTime ? themeColors.warning : workoutPalette.strong }]}>
            {formatTime(seconds)}
          </Text>
        </View>
        <View style={styles.headerRestCopy}>
          {restForExercise ? (
            <Text testID="rest-timer-exercise" style={styles.headerRestExercise} numberOfLines={1}>
              {restForExercise}
            </Text>
          ) : null}
          {restNextTarget || restRecommendationLoading ? (
            <View style={styles.headerRestRecommendation}>
              <View style={styles.headerRestInfoRow}>
                <Text style={styles.headerRestInfoLabel}>Next set</Text>
                {restRecommendationLoading && (
                  <Ionicons name="reload-outline" size={12} color={workoutPalette.strong} />
                )}
                {restCue ? (
                  <TouchableOpacity
                    onPress={() => setCueExpanded(v => !v)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityLabel="rest-cue-toggle">
                    <Ionicons
                      name={cueExpanded ? 'information-circle' : 'information-circle-outline'}
                      size={14}
                      color={workoutPalette.strong}
                    />
                  </TouchableOpacity>
                ) : null}
              </View>
              {restNextTarget ? (
                <Text testID="rest-timer-next-target" style={[styles.headerRestTarget, { color: workoutPalette.strong }]}>{restNextTarget}</Text>
              ) : (
                <Text style={[styles.headerRestTarget, { color: themeColors.textSecondary }]}>Updating next set...</Text>
              )}
              {cueExpanded && restCue ? (
                <Text style={[styles.headerRestTarget, { color: themeColors.textSecondary, fontWeight: '500', marginTop: 2 }]}>
                  {restCue}
                </Text>
              ) : null}
            </View>
          ) : null}
          {Platform.OS === 'ios' ? (() => {
            const paired = watchStatus?.paired ?? false;
            const reachable = watchStatus?.reachable ?? false;
            const watchText = paired
              ? reachable
                ? 'Watch synced'
                : 'Open Watch to mirror rest'
              : 'Watch not paired';
            const watchColor = paired && reachable ? themeColors.success : themeColors.textMuted;
            return (
              <View style={styles.headerRestWatchRow}>
                <Ionicons name="watch-outline" size={12} color={watchColor} />
                <Text style={[styles.headerRestWatchText, { color: watchColor }]} numberOfLines={1}>
                  {watchText}
                </Text>
              </View>
            );
          })() : null}
        </View>
      </View>
      <View style={styles.headerRestActions}>
        <TouchableOpacity testID="rest-timer-minus-15" style={styles.headerRestBtn} onPress={() => onAdjust(-15)}>
          <Text style={styles.headerRestBtnText}>-15</Text>
        </TouchableOpacity>
        <TouchableOpacity testID="rest-timer-plus-15" style={styles.headerRestBtn} onPress={() => onAdjust(15)}>
          <Text style={styles.headerRestBtnText}>+15</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="rest-timer-skip"
          style={[styles.headerRestBtn, { backgroundColor: workoutPalette.strong, borderColor: workoutPalette.strong }]}
          onPress={onSkip}>
          <Text style={[styles.headerRestBtnText, { color: themeColors.background }]}>Skip</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// Memo with default shallow compare — most props are primitive or
// stable refs from the parent, so the panel only re-renders when one
// of them actually changes (recommendation lands, watch status flips,
// adjust handler captures new state). Importantly the parent's `seconds`
// state is GONE — the tick is fully internal to this component.
export default React.memo(RestTimerPanel);
