// Daily "Ready to train?" card. Combines sleep + HRV baseline + fatigue +
// nutrition + resting HR + yesterday's strain into a single 0-100 score.
//
// Reads from:
//   - latest saved HealthSummary (sleep score, HRV, RHR)
//   - rolling HRV/RHR history (nightly history file + healthSummary stream)
//   - backend /workouts/fatigue (readiness_score)
//   - backend /meals/averages (protein/calorie rolling)
//   - local workout history (yesterday's training minutes)

import { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, LayoutAnimation, Platform, UIManager } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName, HealthSummary } from '../types';
import { scorePreparedness, PreparednessResult } from '../services/preparedness';
import { loadSleepHistory, getCycleStatus } from '../services/appleHealth';
import { getFatigueScore, getMealAverages } from '../services/api';
import { loadWorkoutHistory, loadHealthSummary } from '../utils/workoutHistory';

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

  // Use theme color tokens so every palette reads correctly (not hardcoded hex).
  const labelColor =
    result.label === 'Primed'    ? tc.success :
    result.label === 'Ready'     ? tc.primary :
    result.label === 'Moderate'  ? tc.warning : tc.error;

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded(e => !e);
  };

  const pillarRows: Array<[string, number, number]> = [
    ['Sleep',            result.pillars.sleep,            30],
    ['HRV',              result.pillars.hrv,              20],
    ['Muscle recovery',  result.pillars.fatigue,          20],
    ['Nutrition',        result.pillars.nutrition,        15],
    ['Resting HR',       result.pillars.restingHr,        10],
    ['Yesterday',        result.pillars.yesterdayStrain,  5],
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
          {pillarRows.map(([label, pts, max]) => {
            const pct = Math.max(0, Math.min(1, pts / max));
            const barColor = pct >= 0.75 ? tc.success : pct >= 0.50 ? tc.primary : pct >= 0.30 ? tc.warning : tc.error;
            return (
              <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ width: 110, fontSize: 11, fontWeight: '600', color: tc.textSecondary }}>
                  {label}
                </Text>
                <View style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: tc.border }}>
                  <View style={{
                    width: `${Math.max(3, pct * 100)}%` as any,
                    height: 5, borderRadius: 3, backgroundColor: barColor,
                  }} />
                </View>
                <Text style={{ width: 42, fontSize: 10, fontWeight: '700', color: tc.textSecondary, textAlign: 'right' }}>
                  {pts}/{max}
                </Text>
              </View>
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
              Missing: {result.missing.join(', ')} — connect Apple Health for a more accurate score.
            </Text>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}
