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
import { HEALTH_PLATFORM_LABEL } from '../constants/platformHealth';
import { AppThemeName, HealthSummary } from '../types';
import { scorePreparedness, PreparednessResult } from '../services/preparedness';
import { getPlatformCycleStatus, loadPlatformSleepHistory } from '../services/platformHealth';
import { getFatigueScore, getMealAverages } from '../services/api';
import { loadWorkoutHistory, loadHealthSummary } from '../utils/workoutHistory';
import FadeInView from './FadeInView';
import { ScoreInfoModal, ScoreInfoSection, ScoreInfoBody, ScoreInfoRow } from './ScoreInfoModal';

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
  const [infoOpen, setInfoOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Pull sleep + HRV/RHR from local health summary.
      const summary = parentSummary ?? (await loadHealthSummary().catch(() => null));
      const sleepScore = summary?.sleepScore ?? null;
      const hrvNow = summary?.hrvAvg ?? null;
      const rhrNow = summary?.restingHeartRate ?? null;

      // HRV baseline from nightly history.
      const history = await loadPlatformSleepHistory().catch(() => []);
      const hrvHistory = history.map(n => n.hrv).filter((v): v is number => typeof v === 'number' && v > 0);

      // Backend fatigue + nutrition averages (7d) + cycle phase.
      const [fatigue, meals, cycle] = await Promise.all([
        getFatigueScore(authToken).catch(() => null),
        getMealAverages(authToken, 7).catch(() => null),
        getPlatformCycleStatus().catch(() => null),
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
        readinessFromBackend: fatigue?.muscle_recovery_score ?? fatigue?.readiness_score ?? null,
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
  if (result.label === '—' || result.signalsPresent === 0) {
    return (
      <View style={{
        backgroundColor: tc.surface, borderRadius: radius.lg, padding: 14, marginBottom: 12,
        borderWidth: 1, borderColor: tc.border, flexDirection: 'row', alignItems: 'center', gap: 8,
      }}>
        <Ionicons name="flash-outline" size={16} color={tc.textMuted} />
        <Text style={{ flex: 1, fontSize: 12, color: tc.textSecondary }}>
          {Platform.OS === 'android'
            ? 'Health Connect support is coming soon. Readiness still uses workouts, nutrition, and recovery check-ins.'
            : `${HEALTH_PLATFORM_LABEL} is optional. Readiness gets better with sleep, HRV, and meal data, but your plan still works without it.`}
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

  // Each pillar row carries an explicit `missingKey`; rows without a
  // source sample are hidden so users without a wearable/source app do
  // not see a wall of dashes for HRV/RHR/sleep.
  const pillarRows: Array<{ label: string; pts: number; max: number; missingKey: string }> = [
    { label: 'Sleep',            pts: result.pillars.sleep,            max: 30, missingKey: 'sleep' },
    { label: 'HRV',              pts: result.pillars.hrv,              max: 20, missingKey: 'hrv' },
    { label: 'Muscle recovery',  pts: result.pillars.fatigue,          max: 20, missingKey: 'fatigue' },
    { label: 'Nutrition',        pts: result.pillars.nutrition,        max: 15, missingKey: 'nutrition' },
    { label: 'Resting HR',       pts: result.pillars.restingHr,        max: 10, missingKey: 'rhr' },
    { label: "Yesterday's load", pts: result.pillars.yesterdayStrain,  max: 5,  missingKey: '__never__' },
  ];
  const displayedPillarRows = pillarRows.filter(row => !result.missing.includes(row.missingKey));
  const hiddenPillarCount = pillarRows.length - displayedPillarRows.length;

  return (
    <>
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
        <TouchableOpacity
          accessibilityLabel="How readiness is calculated"
          onPress={(e) => { e.stopPropagation(); setInfoOpen(true); }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={{ padding: 2 }}>
          <Ionicons name="information-circle-outline" size={16} color={tc.textMuted} />
        </TouchableOpacity>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={tc.textMuted} />
      </View>

      {expanded && (
        <View style={{ marginTop: 10, gap: 4 }}>
          {displayedPillarRows.map(({ label, pts, max }, rowIdx) => {
            const pct = Math.max(0, Math.min(1, pts / max));
            const barColor = pct >= 0.75 ? tc.success : pct >= 0.50 ? tc.primary : pct >= 0.30 ? tc.warning : tc.error;
            return (
              <FadeInView key={label} delay={rowIdx * 35} duration={240} slideDistance={4}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ width: 110, fontSize: 11, fontWeight: '600', color: tc.textSecondary }}>
                  {label}
                </Text>
                <AnimatedPillarBar pct={Math.max(3, pct * 100)} color={barColor} trackColor={tc.border} />
                <Text style={{ width: 42, fontSize: 10, fontWeight: '700', color: tc.textSecondary, textAlign: 'right' }}>
                  {pts}/{max}
                </Text>
              </View>
              </FadeInView>
            );
          })}
          {hiddenPillarCount > 0 && (
            <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 4, fontStyle: 'italic' }}>
              {hiddenPillarCount} driver{hiddenPillarCount === 1 ? '' : 's'} hidden until recent samples arrive.
            </Text>
          )}
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
              {Platform.OS === 'android' ? 'Health Connect can add sleep and heart-rate context once supported.' : `${HEALTH_PLATFORM_LABEL} is optional, but the plan still works without it.`}
            </Text>
          )}
        </View>
      )}
    </TouchableOpacity>
    <ScoreInfoModal
      visible={infoOpen}
      onClose={() => setInfoOpen(false)}
      eyebrow="READY TO TRAIN"
      title="How readiness is scored"
      iconName="flash-outline"
      iconColor={tc.primary}
      themeName={themeName}>
      <ScoreInfoBody themeName={themeName}>
        A 0–100 read of how prepared your body is for a hard session today.
        Pillars without backing data are skipped, so missing signals
        lower confidence (the "X/Y signals" tag) rather than your score.
      </ScoreInfoBody>
      <ScoreInfoSection title="What goes in" themeName={themeName}>
        <ScoreInfoRow label="Sleep (30)" value="last night's sleep score" themeName={themeName} />
        <ScoreInfoRow label="HRV (20)" value="vs your 14d baseline" themeName={themeName} />
        <ScoreInfoRow label="Muscle recovery (20)" value="trailing fatigue across groups" themeName={themeName} />
        <ScoreInfoRow label="Nutrition (15)" value="7d protein + calorie hit-rate" themeName={themeName} />
        <ScoreInfoRow label="Resting HR (10)" value="elevated vs baseline penalizes" themeName={themeName} />
        <ScoreInfoRow label="Yesterday's load (5)" value="long session yesterday dampens today" themeName={themeName} />
      </ScoreInfoSection>
      <ScoreInfoSection title="Rating bands" themeName={themeName}>
        <ScoreInfoRow label="80+" value="Primed" valueColor={tc.success} themeName={themeName} />
        <ScoreInfoRow label="65–79" value="Ready" valueColor={tc.primary} themeName={themeName} />
        <ScoreInfoRow label="45–64" value="Moderate" valueColor={tc.warning} themeName={themeName} />
        <ScoreInfoRow label="Below 45" value="Fatigued" valueColor={tc.error} themeName={themeName} />
      </ScoreInfoSection>
      <ScoreInfoBody themeName={themeName} muted>
        Recommendations from this score never edit your plan directly —
        they only suggest. You can always train through a low day.
      </ScoreInfoBody>
    </ScoreInfoModal>
    </>
  );
}
