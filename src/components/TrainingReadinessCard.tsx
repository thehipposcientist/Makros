// Combined "Today's Training Readiness" card. Replaces the separate
// RecoveryCard (compact) + PreparednessCard on HomeScreen plan tab.
//
// Logic:
//   - Pulls backend readiness (per-muscle fatigue + readiness label).
//   - Pulls local preparedness composite (sleep/HRV/nutrition/RHR) if
//     Apple Health is available; otherwise falls back to backend readiness
//     + logged workouts only. No pillar is shown if its input is missing.
//   - Filters displayed muscle bars to the muscles that TODAY'S planned
//     focus actually trains, so users see signal for what they're about
//     to do — not the whole 12-muscle grid.
//
// Works with no Apple Health: in that case we surface backend readiness
// + nutrition + yesterday strain only, and the Apple-Health pillars disappear.

import { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, LayoutAnimation, Platform, UIManager } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName, HealthSummary } from '../types';
import { scorePreparedness, PreparednessResult } from '../services/preparedness';
import { loadSleepHistory, getCycleStatus, isHealthKitAvailable } from '../services/appleHealth';
import { getFatigueScore, getMealAverages, FatigueScore } from '../services/api';
import { loadWorkoutHistory, loadHealthSummary } from '../utils/workoutHistory';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Map planned focuses to the muscle groups they actually train. Keep it
// coarse but useful — we want the "push day" view to surface chest/
// shoulders/triceps even if the backend reports 12 muscles.
const FOCUS_TO_MUSCLES: Record<string, string[]> = {
  push: ['chest', 'shoulders', 'triceps'],
  pull: ['back', 'biceps'],
  legs: ['quads', 'hamstrings', 'glutes', 'calves'],
  upper: ['chest', 'back', 'shoulders', 'biceps', 'triceps'],
  upper_body: ['chest', 'back', 'shoulders', 'biceps', 'triceps'],
  lower: ['quads', 'hamstrings', 'glutes', 'calves'],
  lower_body: ['quads', 'hamstrings', 'glutes', 'calves'],
  full_body: ['chest', 'back', 'shoulders', 'quads', 'hamstrings', 'glutes', 'core'],
  chest: ['chest', 'shoulders', 'triceps'],
  back: ['back', 'biceps'],
  shoulders: ['shoulders', 'triceps'],
  arms: ['biceps', 'triceps'],
  core: ['core'],
  cardio: ['cardio'],
  conditioning: ['cardio'],
  mobility: [],
  recovery: [],
};

function musclesForFocus(focus: string | null | undefined): string[] {
  if (!focus) return [];
  const norm = focus.toLowerCase().trim().replace(/\s+/g, '_').replace(/-/g, '_');
  // Direct lookup, then tokenized fallback ("push day" -> push).
  if (FOCUS_TO_MUSCLES[norm]) return FOCUS_TO_MUSCLES[norm];
  for (const key of Object.keys(FOCUS_TO_MUSCLES)) {
    if (norm.includes(key)) return FOCUS_TO_MUSCLES[key];
  }
  return [];
}

interface Props {
  authToken: string;
  themeName?: AppThemeName;
  age?: number | null;
  proteinTarget?: number | null;
  calorieTarget?: number | null;
  todaysFocus?: string | null;
  /** Prefer a parent-provided summary so we don't duplicate the fetch. */
  healthSummary?: HealthSummary | null;
}

export default function TrainingReadinessCard({
  authToken, themeName, age, proteinTarget, calorieTarget, todaysFocus, healthSummary: parentSummary,
}: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;

  const [prep, setPrep] = useState<PreparednessResult | null>(null);
  const [fatigue, setFatigue] = useState<FatigueScore | null>(null);
  const [hasAppleHealth, setHasAppleHealth] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const summary = parentSummary ?? (await loadHealthSummary().catch(() => null));
      const ahAvailable = isHealthKitAvailable() && summary != null;
      setHasAppleHealth(ahAvailable);

      const [history, f, meals, cycle] = await Promise.all([
        loadSleepHistory().catch(() => []),
        getFatigueScore(authToken).catch(() => null),
        getMealAverages(authToken, 7).catch(() => null),
        ahAvailable ? getCycleStatus().catch(() => null) : Promise.resolve(null),
      ]);
      setFatigue(f);

      const workouts = await loadWorkoutHistory().catch(() => []);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const yesterdayMin = workouts
        .filter(s => s.date?.slice(0, 10) === yesterday && s.completed)
        .reduce((sum, s) => sum + ((s.durationSeconds ?? 0) / 60), 0);

      // When a specific focus is planned, prefer the backend's per-focus
      // readiness (it weights the relevant muscle groups). When focus changes
      // the card re-computes against the correct readiness number.
      const focusKey = (todaysFocus ?? '').toLowerCase().replace(/\s+/g, '_');
      const focusReadiness =
        focusKey && f?.focus_readiness?.[focusKey] != null
          ? f.focus_readiness[focusKey]
          : f?.readiness_score ?? null;

      const res = scorePreparedness({
        sleepScore: ahAvailable ? summary?.sleepScore ?? null : null,
        hrvMs: ahAvailable ? summary?.hrvAvg ?? null : null,
        hrvHistory: history.map(n => n.hrv).filter((v): v is number => typeof v === 'number' && v > 0),
        restingHeartRate: ahAvailable ? summary?.restingHeartRate ?? null : null,
        rhrHistory: [],
        readinessFromBackend: focusReadiness,
        proteinGrams: meals?.avg_protein_g ?? null,
        proteinTargetGrams: proteinTarget ?? null,
        calorieIntake: meals?.avg_calories ?? null,
        calorieTarget: calorieTarget ?? null,
        yesterdayWorkoutMinutes: yesterdayMin > 0 ? yesterdayMin : null,
        age: age ?? null,
        cyclePhase: cycle && cycle.phase !== 'unknown' ? cycle.phase : null,
      });
      setPrep(res);
    } catch {
      setPrep(null);
    } finally {
      setLoading(false);
    }
  }, [authToken, parentSummary, age, proteinTarget, calorieTarget, todaysFocus]);

  useEffect(() => { load(); }, [load]);

  if (loading && !prep) return null;
  if (!prep) return null;

  const labelColor =
    prep.label === 'Primed'    ? tc.success :
    prep.label === 'Ready'     ? tc.primary :
    prep.label === 'Moderate'  ? tc.warning : tc.error;

  const focusMuscles = musclesForFocus(todaysFocus);
  const muscleFatigue = fatigue?.muscle_fatigue ?? {};
  // Narrow the muscle list to today's planned focus; if unknown, show top-3.
  const relevantMuscles: Array<[string, number]> = (focusMuscles.length > 0
    ? focusMuscles.map((m) => [m, muscleFatigue[m] ?? 0] as [string, number])
    : Object.entries(muscleFatigue)
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
        .slice(0, 3)
  );

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded(e => !e);
  };

  // Only show pillars whose input was actually available. This way users
  // without Apple Health don't see a bunch of grayed-out 60%-neutral rows.
  const pillarRows: Array<[string, number, number]> = [];
  if (hasAppleHealth) {
    pillarRows.push(['Sleep', prep.pillars.sleep, 30]);
    pillarRows.push(['HRV', prep.pillars.hrv, 20]);
  }
  pillarRows.push(['Muscle recovery', prep.pillars.fatigue, 20]);
  pillarRows.push(['Nutrition', prep.pillars.nutrition, 15]);
  if (hasAppleHealth) {
    pillarRows.push(['Resting HR', prep.pillars.restingHr, 10]);
  }
  pillarRows.push(['Yesterday', prep.pillars.yesterdayStrain, 5]);

  const focusLabel = todaysFocus
    ? todaysFocus.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    : null;

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={toggle}
      style={{
        backgroundColor: tc.surface, borderRadius: radius.lg, padding: 14, marginBottom: 12,
        borderWidth: 1, borderColor: tc.border,
      }}
    >
      {/* Header — same shape as RecoveryCard */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Ionicons name="flash-outline" size={16} color={labelColor} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }}>
            {focusLabel ? `${focusLabel}: ` : 'Today: '}
            <Text style={{ color: labelColor }}>{prep.label}</Text>
            <Text style={{ color: tc.textSecondary }}> ({prep.score})</Text>
          </Text>
          {!expanded && (
            <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }} numberOfLines={1}>
              {prep.insights[0] ?? (relevantMuscles.length > 0
                ? `${relevantMuscles.map(([m]) => m.replace('_', ' ')).join(', ')} recovery shown`
                : 'All tracked signals look clean')}
            </Text>
          )}
        </View>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={tc.textMuted} />
      </View>

      {expanded && (
        <View style={{ marginTop: 10, gap: 4 }}>
          {/* Muscle-specific readiness for today's focus */}
          {relevantMuscles.length > 0 && (
            <View style={{ marginBottom: 8 }}>
              <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 4 }}>
                {focusMuscles.length > 0 ? 'TODAY\'S MUSCLES' : 'MOST FATIGUED'}
              </Text>
              {relevantMuscles.map(([muscle, fat]) => {
                const pct = Math.round(fat * 100);
                const recovery = Math.max(0, Math.min(100, 100 - pct));
                const barColor = recovery >= 70 ? tc.success : recovery >= 40 ? tc.warning : tc.error;
                return (
                  <View key={muscle} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <Text style={{ width: 92, fontSize: 11, fontWeight: '600', color: tc.textSecondary, textTransform: 'capitalize' }}>
                      {muscle.replace('_', ' ')}
                    </Text>
                    <View style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: tc.border }}>
                      <View style={{ width: `${Math.max(3, recovery)}%` as any, height: 5, borderRadius: 3, backgroundColor: barColor }} />
                    </View>
                    <Text style={{ width: 44, fontSize: 10, fontWeight: '700', color: tc.textSecondary, textAlign: 'right' }}>
                      {recovery}%
                    </Text>
                  </View>
                );
              })}
            </View>
          )}

          {/* Readiness pillars */}
          <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 4 }}>
            DRIVERS
          </Text>
          {pillarRows.map(([label, pts, max]) => {
            const pct = Math.max(0, Math.min(1, (pts as number) / (max as number)));
            const barColor = pct >= 0.75 ? tc.success : pct >= 0.50 ? tc.primary : pct >= 0.30 ? tc.warning : tc.error;
            return (
              <View key={label as string} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ width: 110, fontSize: 11, fontWeight: '600', color: tc.textSecondary }}>{label as string}</Text>
                <View style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: tc.border }}>
                  <View style={{ width: `${Math.max(3, pct * 100)}%` as any, height: 5, borderRadius: 3, backgroundColor: barColor }} />
                </View>
                <Text style={{ width: 42, fontSize: 10, fontWeight: '700', color: tc.textSecondary, textAlign: 'right' }}>
                  {pts}/{max}
                </Text>
              </View>
            );
          })}

          {!hasAppleHealth && (
            <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 6, fontStyle: 'italic' }}>
              Connect Apple Health for sleep + HRV signals.
            </Text>
          )}
          {prep.insights.length > 1 && (
            <View style={{ marginTop: 6, gap: 3 }}>
              {prep.insights.slice(1).map((line, i) => (
                <Text key={i} style={{ fontSize: 11, color: tc.textSecondary, lineHeight: 15 }}>• {line}</Text>
              ))}
            </View>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}
