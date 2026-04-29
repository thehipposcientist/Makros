// Daily "Ready to train?" card. Combines sleep + HRV baseline + fatigue +
// nutrition + resting HR + yesterday's strain into a single 0-100 score.
//
// Reads from:
//   - latest saved HealthSummary (sleep score, HRV, RHR)
//   - rolling HRV/RHR history (nightly history file + healthSummary stream)
//   - backend /workouts/fatigue (readiness_score)
//   - backend /meals/averages (protein/calorie rolling)
//   - local workout history (yesterday's training minutes)

import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Platform, UIManager, Animated, Easing } from 'react-native';
import { configureExpandAnimation } from '../utils/layoutAnim';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName, HealthSummary } from '../types';
import { scorePreparedness, PreparednessResult } from '../services/preparedness';
import { loadSleepHistory, getCycleStatus } from '../services/appleHealth';
import { getFatigueScore, getMealAverages } from '../services/api';
import { loadWorkoutHistory, loadHealthSummary } from '../utils/workoutHistory';
import FadeInView from './FadeInView';

/** Pillar bar with animated width AND animated color crossfade between
 *  threshold tiers. The track holds a base layer at the new color and
 *  fades the previous color over it during transitions so the eye sees
 *  one bar shifting hue, not a hard swap on the threshold boundary. */
function AnimatedPillarBar({ pct, color, trackColor }: { pct: number; color: string; trackColor: string }) {
  const widthAnim = useRef(new Animated.Value(0)).current;
  const lastWidth = useRef(0);
  const [prevColor, setPrevColor] = useState<string>(color);
  const [activeColor, setActiveColor] = useState<string>(color);
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(widthAnim, {
      toValue: pct,
      duration: 600,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
    lastWidth.current = pct;
  }, [pct, widthAnim]);

  useEffect(() => {
    if (color === activeColor) return;
    setPrevColor(activeColor);
    setActiveColor(color);
    fade.setValue(1);
    Animated.timing(fade, {
      toValue: 0,
      duration: 380,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [color, activeColor, fade]);

  return (
    <View style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: trackColor, overflow: 'hidden' }}>
      <Animated.View style={{
        width: widthAnim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
        height: 5, borderRadius: 3, backgroundColor: activeColor,
      }}>
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: prevColor, opacity: fade,
          }}
        />
      </Animated.View>
    </View>
  );
}

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface Props {
  authToken: string;
  themeName?: AppThemeName;
  age?: number | null;
  proteinTarget?: number | null;
  calorieTarget?: number | null;
  /** Pass latest summary to skip the file load when parent already has it. */
  healthSummary?: HealthSummary | null;
}

export default function PreparednessCard({
  authToken, themeName, age, proteinTarget, calorieTarget, healthSummary: parentSummary,
}: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;

  const [result, setResult] = useState<PreparednessResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Pull sleep + HRV/RHR from local health summary.
      const summary = parentSummary ?? (await loadHealthSummary().catch(() => null));
      const sleepScore = summary?.sleepScore ?? null;
      const hrvNow = summary?.hrvAvg ?? null;
      const rhrNow = summary?.restingHeartRate ?? null;

      // HRV baseline from nightly history.
      const history = await loadSleepHistory().catch(() => []);
      const hrvHistory = history.map(n => n.hrv).filter((v): v is number => typeof v === 'number' && v > 0);

      // Backend fatigue + nutrition averages (7d) + cycle phase.
      const [fatigue, meals, cycle] = await Promise.all([
        getFatigueScore(authToken).catch(() => null),
        getMealAverages(authToken, 7).catch(() => null),
        getCycleStatus().catch(() => null),
      ]);

      // Yesterday's workout minutes.
      const workouts = await loadWorkoutHistory().catch(() => []);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const yesterdayMin = workouts
        .filter(s => s.date?.slice(0, 10) === yesterday && s.completed)
        .reduce((sum, s) => sum + ((s.durationSeconds ?? 0) / 60), 0);

      const res = scorePreparedness({
        sleepScore,
        hrvMs: hrvNow,
        hrvHistory,
        restingHeartRate: rhrNow,
        rhrHistory: [], // could persist a nightly RHR list later; 0-length is fine (neutral)
        readinessFromBackend: fatigue?.readiness_score ?? null,
        proteinGrams: meals?.avg_protein_g ?? null,
        proteinTargetGrams: proteinTarget ?? null,
        calorieIntake: meals?.avg_calories ?? null,
        calorieTarget: calorieTarget ?? null,
        yesterdayWorkoutMinutes: yesterdayMin > 0 ? yesterdayMin : null,
        age: age ?? null,
        cyclePhase: cycle && cycle.phase !== 'unknown' ? cycle.phase : null,
      });
      setResult(res);
    } catch {
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [authToken, parentSummary, age, proteinTarget, calorieTarget]);

  useEffect(() => { load(); }, [load]);

  if (loading && !result) return null;
  if (!result) return null;
  // Zero real signals → don't pretend we have a score. The reweighted
  // total is 0 only when nothing was readable. Show an empty-state CTA
  // instead of "Fatigued (0)" which would alarm users with no AH data.
  if (result.signalsPresent === 0) {
    return (
      <View style={{
        backgroundColor: tc.surface, borderRadius: radius.lg, padding: 14, marginBottom: 12,
        borderWidth: 1, borderColor: tc.border, flexDirection: 'row', alignItems: 'center', gap: 8,
      }}>
        <Ionicons name="flash-outline" size={16} color={tc.textMuted} />
        <Text style={{ flex: 1, fontSize: 12, color: tc.textSecondary }}>
          Apple Health is optional. Readiness gets better with sleep, HRV, and meal data, but your plan still works without it.
        </Text>
      </View>
    );
  }

  // Use theme color tokens so every palette reads correctly (not hardcoded hex).
  const labelColor =
    result.label === 'Primed'    ? tc.success :
    result.label === 'Ready'     ? tc.primary :
    result.label === 'Moderate'  ? tc.warning : tc.error;

  const toggle = () => {
    configureExpandAnimation(320);
    setExpanded(e => !e);
  };

  // Each pillar row carries an explicit `missingKey` so the UI can
  // render "—" instead of a fake bar at 0 when the input is genuinely
  // unavailable. Without this, missing HRV looked like "low HRV" even
  // though the user just doesn't wear an Apple Watch overnight.
  const pillarRows: Array<{ label: string; pts: number; max: number; missingKey: string }> = [
    { label: 'Sleep',            pts: result.pillars.sleep,            max: 30, missingKey: 'sleep' },
    { label: 'HRV',              pts: result.pillars.hrv,              max: 20, missingKey: 'hrv' },
    { label: 'Muscle recovery',  pts: result.pillars.fatigue,          max: 20, missingKey: 'fatigue' },
    { label: 'Nutrition',        pts: result.pillars.nutrition,        max: 15, missingKey: 'nutrition' },
    { label: 'Resting HR',       pts: result.pillars.restingHr,        max: 10, missingKey: 'rhr' },
    { label: "Yesterday's load", pts: result.pillars.yesterdayStrain,  max: 5,  missingKey: '__never__' },
  ];

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={toggle}
      style={{
        backgroundColor: tc.surface, borderRadius: radius.lg, padding: 14, marginBottom: 12,
        borderWidth: 1, borderColor: tc.border,
      }}
    >
      {/* Header — mirrors RecoveryCard / AdherenceTrendCard: icon + title + chevron. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Ionicons name="flash-outline" size={16} color={labelColor} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }}>
            Ready to train: <Text style={{ color: labelColor }}>{result.label}</Text> ({result.score})
            {result.signalsTotal > 0 && (
              <Text style={{ fontSize: 11, fontWeight: '500', color: tc.textMuted }}>
                {' '}· {result.signalsPresent}/{result.signalsTotal} signals
              </Text>
            )}
          </Text>
          {result.insights.length > 0 && (
            <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }} numberOfLines={expanded ? undefined : 1}>
              {result.insights[0]}
            </Text>
          )}
        </View>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={tc.textMuted} />
      </View>

      {expanded && (
        <View style={{ marginTop: 10, gap: 4 }}>
          {pillarRows.map(({ label, pts, max, missingKey }, rowIdx) => {
            const isMissing = result.missing.includes(missingKey);
            const pct = Math.max(0, Math.min(1, pts / max));
            const barColor = pct >= 0.75 ? tc.success : pct >= 0.50 ? tc.primary : pct >= 0.30 ? tc.warning : tc.error;
            return (
              <FadeInView key={label} delay={rowIdx * 35} duration={240} slideDistance={4}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ width: 110, fontSize: 11, fontWeight: '600', color: tc.textSecondary }}>
                  {label}
                </Text>
                {isMissing ? (
                  <View style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: tc.border, opacity: 0.4 }} />
                ) : (
                  <AnimatedPillarBar pct={Math.max(3, pct * 100)} color={barColor} trackColor={tc.border} />
                )}
                <Text style={{ width: 42, fontSize: 10, fontWeight: '700', color: isMissing ? tc.textMuted : tc.textSecondary, textAlign: 'right' }}>
                  {isMissing ? '—' : `${pts}/${max}`}
                </Text>
              </View>
              </FadeInView>
            );
          })}
          {result.insights.length > 1 && (
            <View style={{ marginTop: 8, gap: 4 }}>
              {result.insights.slice(1).map((line, i) => (
                <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
                  <Ionicons name="alert-circle-outline" size={12} color={tc.textMuted} style={{ marginTop: 2 }} />
                  <Text style={{ fontSize: 11, color: tc.textSecondary, flex: 1, lineHeight: 15 }}>{line}</Text>
                </View>
              ))}
            </View>
          )}
          {result.missing.length > 0 && (
            <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 6, fontStyle: 'italic' }}>
              Missing: {result.missing.join(', ')} — Apple Health is optional, but it adds sleep and heart-rate context here.
            </Text>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}
