import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { ThemeColors } from '../constants/theme';

type GuidedFlowExercise = {
  name: string;
  reps?: string;
  flowCategory?: string | null;
  flow_category?: string | null;
  prescriptionType?: string | null;
  description?: string | null;
} & Record<string, any>;

type Props = {
  exercises: GuidedFlowExercise[];
  themeColors: ThemeColors;
  /** Called when a pose's timer expires AND the user accepts (auto-advance).
   *  Lets the parent commit a logged set via existing handleLogSetInline. */
  onPoseComplete: (exerciseIndex: number, durationSeconds: number) => void;
  /** Called when the user taps Swap on the active pose. Parent opens the
   *  add-exercise modal in swap mode, filtered by flow_category. */
  onRequestSwap: (exerciseIndex: number) => void;
  /** Called when the user taps Add Pose. Parent opens the add-exercise modal
   *  in add mode, filtered to all flow_category != null poses. */
  onRequestAdd: () => void;
  /** Called when the user taps End Session. Parent runs the finish flow. */
  onEndSession: () => void;
  /** Optional haptic hooks the parent already preloaded. */
  hapticTick?: () => void;
  hapticTransition?: () => void;
  hapticComplete?: () => void;
};

const _DEFAULT_HOLD_SECONDS = 45;
const _TRANSITION_SECONDS = 3;

function parseHoldSeconds(reps: string | undefined): number {
  if (!reps) return _DEFAULT_HOLD_SECONDS;
  const text = String(reps).toLowerCase();
  // "45s" / "30-45s" / "30 sec" / "60 seconds"
  const secMatch = text.match(/(\d+)\s*(?:[-–—]\s*(\d+))?\s*(?:s|sec|second)/);
  if (secMatch) {
    const lo = parseInt(secMatch[1], 10);
    const hi = secMatch[2] ? parseInt(secMatch[2], 10) : lo;
    return Math.round((lo + hi) / 2);
  }
  // "1 min" / "2 min" / "3 minutes"
  const minMatch = text.match(/(\d+)\s*(?:m|min|minute)/);
  if (minMatch) {
    return parseInt(minMatch[1], 10) * 60;
  }
  return _DEFAULT_HOLD_SECONDS;
}

function isUnilateral(reps: string | undefined): boolean {
  return !!reps && /each\s+side|per\s+side/i.test(reps);
}

function poseRoundsAndSecondsPerRound(reps: string | undefined): { rounds: number; secondsPerRound: number } {
  const base = parseHoldSeconds(reps);
  const rounds = isUnilateral(reps) ? 2 : 1;
  return { rounds, secondsPerRound: base };
}

function formatMMSS(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

function categoryLabel(category: string | null | undefined): string {
  if (!category) return '';
  return category.charAt(0).toUpperCase() + category.slice(1).replace('_', ' ');
}

export default function GuidedFlowView({
  exercises,
  themeColors,
  onPoseComplete,
  onRequestSwap,
  onRequestAdd,
  onEndSession,
  hapticTick,
  hapticTransition,
  hapticComplete,
}: Props) {
  const [activeIdx, setActiveIdx] = useState(0);
  const [round, setRound] = useState(1);
  const [phase, setPhase] = useState<'transition' | 'holding' | 'paused' | 'done'>('transition');
  const [secondsLeft, setSecondsLeft] = useState<number>(_TRANSITION_SECONDS);

  const total = exercises.length;
  const active = exercises[activeIdx];
  const next = exercises[activeIdx + 1];
  const { rounds, secondsPerRound } = useMemo(
    () => poseRoundsAndSecondsPerRound(active?.reps),
    [active?.reps],
  );

  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // Reset timer whenever the active pose or round changes.
  useEffect(() => {
    if (phase === 'done') return;
    setPhase('transition');
    setSecondsLeft(_TRANSITION_SECONDS);
    hapticTransition?.();
  }, [activeIdx, round]); // eslint-disable-line react-hooks/exhaustive-deps

  // Master tick.
  useEffect(() => {
    if (phase === 'paused' || phase === 'done') return;
    const id = setInterval(() => {
      setSecondsLeft(prev => {
        if (prev > 1) return prev - 1;
        // Phase boundary.
        if (phaseRef.current === 'transition') {
          setPhase('holding');
          hapticTick?.();
          return secondsPerRound;
        }
        // holding → end of round
        const isLastRound = round >= rounds;
        const isLastPose = activeIdx >= total - 1;
        const durationThisPose = secondsPerRound * rounds;
        if (isLastRound) {
          // Commit the set for this pose.
          onPoseComplete(activeIdx, durationThisPose);
          if (isLastPose) {
            hapticComplete?.();
            setPhase('done');
            return 0;
          }
          // Advance to next pose round 1.
          setActiveIdx(i => i + 1);
          setRound(1);
          return _TRANSITION_SECONDS;
        }
        // Same pose, next side / round.
        setRound(r => r + 1);
        return _TRANSITION_SECONDS;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [phase, round, rounds, secondsPerRound, total, activeIdx, onPoseComplete, hapticTick, hapticComplete]);

  const togglePause = useCallback(() => {
    setPhase(p => (p === 'paused' ? (secondsLeft <= 0 ? 'transition' : 'holding') : p === 'done' ? p : 'paused'));
  }, [secondsLeft]);

  const skipForward = useCallback(() => {
    if (activeIdx >= total - 1) {
      hapticComplete?.();
      setPhase('done');
      return;
    }
    setActiveIdx(i => i + 1);
    setRound(1);
  }, [activeIdx, total, hapticComplete]);

  const skipBack = useCallback(() => {
    if (activeIdx === 0) {
      setRound(1);
      setPhase('transition');
      setSecondsLeft(_TRANSITION_SECONDS);
      return;
    }
    setActiveIdx(i => i - 1);
    setRound(1);
  }, [activeIdx]);

  if (!active || phase === 'done') {
    return (
      <View style={[styles.container, { backgroundColor: themeColors.background }]}>
        <View style={styles.summaryWrap}>
          <Ionicons name="checkmark-circle" size={72} color={themeColors.accent} />
          <Text style={[styles.summaryTitle, { color: themeColors.textPrimary }]}>Session complete</Text>
          <Text style={[styles.summarySub, { color: themeColors.textSecondary }]}>
            {total} {total === 1 ? 'pose' : 'poses'} done
          </Text>
          <Pressable
            style={[styles.primaryBtn, { backgroundColor: themeColors.accent }]}
            onPress={onEndSession}
            accessibilityLabel="finish-guided-flow">
            <Text style={[styles.primaryBtnText, { color: themeColors.background }]}>Finish</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const isTransition = phase === 'transition';
  const isPaused = phase === 'paused';
  const sideLabel = isUnilateral(active.reps) ? (round === 1 ? 'Right side' : 'Left side') : null;

  return (
    <View style={[styles.container, { backgroundColor: themeColors.background }]}>
      <View style={styles.topRow}>
        <Text style={[styles.progress, { color: themeColors.textSecondary }]}>
          {activeIdx + 1} / {total}
        </Text>
        {active.flowCategory || active.flow_category ? (
          <Text style={[styles.categoryChip, { color: themeColors.textSecondary, borderColor: themeColors.border }]}>
            {categoryLabel(active.flowCategory ?? active.flow_category)}
          </Text>
        ) : null}
        <Pressable
          style={styles.endBtn}
          onPress={onEndSession}
          accessibilityLabel="end-session">
          <Text style={[styles.endBtnText, { color: themeColors.textSecondary }]}>End</Text>
        </Pressable>
      </View>

      <View style={styles.poseWrap}>
        <Text style={[styles.poseName, { color: themeColors.textPrimary }]} numberOfLines={2}>
          {active.name}
        </Text>
        {sideLabel ? (
          <Text style={[styles.sideLabel, { color: themeColors.accent }]}>{sideLabel}</Text>
        ) : null}
        {active.description ? (
          <Text style={[styles.cue, { color: themeColors.textSecondary }]} numberOfLines={3}>
            {active.description}
          </Text>
        ) : null}

        <View style={styles.timerWrap}>
          {isTransition ? (
            <Text style={[styles.transitionLabel, { color: themeColors.textSecondary }]}>
              Get into pose
            </Text>
          ) : null}
          <Text
            style={[
              styles.timer,
              { color: isTransition ? themeColors.textSecondary : themeColors.textPrimary },
            ]}>
            {formatMMSS(secondsLeft)}
          </Text>
          {rounds > 1 ? (
            <Text style={[styles.roundLabel, { color: themeColors.textSecondary }]}>
              Round {round} of {rounds}
            </Text>
          ) : null}
        </View>

        {next ? (
          <Text style={[styles.nextLabel, { color: themeColors.textSecondary }]} numberOfLines={1}>
            Next: {next.name}
          </Text>
        ) : (
          <Text style={[styles.nextLabel, { color: themeColors.textSecondary }]}>Last pose</Text>
        )}
      </View>

      <View style={styles.controlsRow}>
        <Pressable
          style={[styles.iconBtn, { borderColor: themeColors.border }]}
          onPress={skipBack}
          accessibilityLabel="previous-pose">
          <Ionicons name="play-skip-back" size={20} color={themeColors.textPrimary} />
        </Pressable>
        <Pressable
          style={[styles.iconBtn, { borderColor: themeColors.border }]}
          onPress={() => onRequestSwap(activeIdx)}
          accessibilityLabel="swap-pose">
          <Ionicons name="swap-horizontal" size={20} color={themeColors.textPrimary} />
        </Pressable>
        <Pressable
          style={[styles.playPauseBtn, { backgroundColor: themeColors.accent }]}
          onPress={togglePause}
          accessibilityLabel={isPaused ? 'resume-pose' : 'pause-pose'}>
          <Ionicons
            name={isPaused ? 'play' : 'pause'}
            size={26}
            color={themeColors.background}
          />
        </Pressable>
        <Pressable
          style={[styles.iconBtn, { borderColor: themeColors.border }]}
          onPress={onRequestAdd}
          accessibilityLabel="add-pose">
          <Ionicons name="add" size={22} color={themeColors.textPrimary} />
        </Pressable>
        <Pressable
          style={[styles.iconBtn, { borderColor: themeColors.border }]}
          onPress={skipForward}
          accessibilityLabel="next-pose">
          <Ionicons name="play-skip-forward" size={20} color={themeColors.textPrimary} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 24,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  progress: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  categoryChip: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  endBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  endBtnText: {
    fontSize: 13,
    fontWeight: '600',
  },
  poseWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  poseName: {
    fontSize: 30,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 8,
  },
  sideLabel: {
    fontSize: 14,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 16,
  },
  cue: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
    paddingHorizontal: 12,
  },
  timerWrap: {
    alignItems: 'center',
    marginVertical: 24,
  },
  transitionLabel: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  timer: {
    fontSize: 96,
    fontWeight: '300',
    fontVariant: ['tabular-nums'],
    letterSpacing: -2,
  },
  roundLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 8,
  },
  nextLabel: {
    fontSize: 14,
    fontWeight: '500',
    marginTop: 12,
    textAlign: 'center',
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    marginBottom: 8,
  },
  iconBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  playPauseBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  summaryWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  summaryTitle: {
    fontSize: 28,
    fontWeight: '700',
    marginTop: 12,
  },
  summarySub: {
    fontSize: 15,
  },
  primaryBtn: {
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 999,
    marginTop: 16,
  },
  primaryBtnText: {
    fontSize: 16,
    fontWeight: '700',
  },
});
