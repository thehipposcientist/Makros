import { useState, useEffect, useRef, useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator,
  TextInput, Alert, Image, Linking, Modal, Animated,
} from 'react-native';
// Lazy reference — keeps expo-image-picker out of the cold-start parse pass.
const ImagePicker: typeof import('expo-image-picker') = (() => {
  let mod: any = null;
  return new Proxy({} as any, {
    get: (_t, prop) => {
      if (!mod) mod = require('expo-image-picker');
      return mod[prop as string];
    },
  });
})();
import { Ionicons } from '@expo/vector-icons';
import { LayoutAnimation, UIManager, Platform } from 'react-native';
import FadeInView from '../components/FadeInView';
import StreakCounter from '../components/StreakCounter';
import AnimatedNumber from '../components/AnimatedNumber';
import { WorkoutDaySkeleton } from '../components/SkeletonLoader';
import { configureExpandAnimation } from '../utils/layoutAnim';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import Svg, { Polyline, Circle, Line, Text as SvgText } from 'react-native-svg';
import ViewShot from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WorkoutSession, UserProfile, StoredWorkoutSummary, GoalHistoryEntry, PlanChangeEntry, BodyScanEntry, HealthSummary, HealthScoreResult } from '../types';
import { loadWorkoutHistory, derivePersonalRecords, PR, loadWorkoutSummaries, loadGoalHistory, loadPlanChanges, loadHealthSummary, loadHealthScore, deleteWorkoutSession, deleteWorkoutSummary, deletePlanChange, saveWorkoutSession, dateKey, saveHealthSummary, isAppleHealthEnabled } from '../utils/workoutHistory';
import { APPLE_HEALTH_PERMISSION_COPY, readHealthSummary, isHealthKitAvailable, requestHealthPermissions, getLastHealthKitError, loadSleepHistory, summarizeWorkoutZone2 } from '../services/appleHealth';
import DetectedWorkoutsCard from '../components/DetectedWorkoutsCard';
import BodyMeasurementsModal from '../components/BodyMeasurementsModal';
import Zone2TargetCard from '../components/Zone2TargetCard';
import WeeklyCheckinCard from '../components/WeeklyCheckinCard';
import { setAppleHealthEnabled as persistAppleHealthEnabled } from '../utils/workoutHistory';
import LogActivityModal from '../components/LogActivityModal';
import RecoveryCard from '../components/RecoveryCard';
import AdherenceTrendCard from '../components/AdherenceTrendCard';
import { RECOVERY_LABELS } from '../utils/healthScore';
import { getMealChecks } from '../utils/mealTracker';
import { computePlantDiversity, computeFiberToday, recommendedFiberTarget } from '../utils/gutHealth';
import { proteinTimingInsights } from '../utils/nutritionInsights';
import { getGoalEstimate, getRecompProjection } from '../utils/goalEstimate';
import { useMetaData } from '../hooks/useMetaData';
import { humanizeToken } from '../utils/exerciseGuide';
import { computeFitnessAge } from '../utils/fitnessAge';
import { getInsights, getGuardrails, getCoachMemory, getProgressionInsights, scanBody, BodyScanResult, getPaceHistory, PaceHistoryPoint, listWorkoutCompletions, WorkoutCompletionRecord, listWorkoutSessions, WorkoutSessionRecord, getWeightEntries } from '../services/api';
import { colors, elevations, getContrastingTextColor, getTheme, radius, typography } from '../constants/theme';
import { AppThemeName } from '../types';
import { dynamicInputProps, dynamicTextProps } from '../utils/dynamicType';
import { aggregateDailyFromHistory, dailyBarDenominator, headlineLoggedCalories, macrosHeadlineFromAverages, macrosHeadlineFromDailyRows, selectDailyRows } from './progressData';
import { tierOf } from '../utils/subscription';

interface ProgressScreenProps {
  onBack: () => void;
  authToken: string;
  userProfile: UserProfile;
  onUpdateWeight?: (weightLbs: number) => void;
  onCancelScheduledPlanChange?: (restoredProfile: UserProfile) => Promise<void> | void;
  themeName?: AppThemeName;
  // When true, hide the top "← Back / Progress" header bar. Used when
  // this screen is rendered inline as bottom-tab content — the bottom
  // nav already provides navigation, so the inner header is redundant.
  noHeader?: boolean;
  nutritionPlan?: import('../types').DailyNutritionPlan | null;
  nutritionLogRefreshKey?: number;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function planChangeIsScheduled(change: PlanChangeEntry): boolean {
  return change.changedBy === 'user'
    && !!change.effectiveDate
    && change.effectiveDate > dateKey(new Date());
}

function planScopeSnapshot(profile: Partial<UserProfile>, scope?: PlanChangeEntry['scope']): Record<string, unknown> {
  if (scope === 'goal') {
    return {
      goal: profile.goal ?? null,
      goalSelection: profile.goalSelection ?? null,
      goalDetails: profile.goalDetails ?? null,
      secondaryGoal: profile.secondaryGoal ?? null,
      focusedMuscleGroup: profile.focusedMuscleGroup ?? null,
    };
  }
  if (scope === 'workout') {
    return {
      priorityRegion: profile.priorityRegion ?? null,
      daysPerWeek: profile.daysPerWeek ?? null,
      trainingDays: profile.trainingDays ?? null,
      workoutDurationMinutes: profile.workoutDurationMinutes ?? null,
      equipment: profile.equipment ?? [],
      equipmentSettings: profile.equipmentSettings ?? null,
      injuries: profile.injuries ?? null,
      injuryEntries: profile.injuryEntries ?? [],
      experienceLevel: profile.experienceLevel ?? null,
      preferredSplit: profile.preferredSplit ?? null,
      dislikedExercises: profile.dislikedExercises ?? [],
    };
  }
  if (scope === 'mealplan') {
    return {
      foodsAvailable: profile.foodsAvailable ?? [],
      customFoods: profile.customFoods ?? [],
      cookingSkill: profile.cookingSkill ?? null,
      prepTimeMinutes: profile.prepTimeMinutes ?? null,
      dietaryPreference: profile.dietaryPreference ?? null,
      mealVariety: profile.mealVariety ?? null,
      mealsPerDay: profile.mealsPerDay ?? null,
      savedMeals: profile.savedMeals ?? [],
      mealRoutine: profile.mealRoutine ?? null,
      customMacros: profile.customMacros ?? null,
      allergies: profile.allergies ?? [],
    };
  }
  return profile as unknown as Record<string, unknown>;
}

function planScopeMatches(current: UserProfile, scheduled: Partial<UserProfile>, scope?: PlanChangeEntry['scope']): boolean {
  return JSON.stringify(planScopeSnapshot(current, scope)) === JSON.stringify(planScopeSnapshot(scheduled, scope));
}

function restorePlanScope(current: UserProfile, previous: Partial<UserProfile>, scope?: PlanChangeEntry['scope']): UserProfile {
  if (scope === 'goal') {
    return {
      ...current,
      goal: previous.goal ?? current.goal,
      goalSelection: previous.goalSelection,
      goalDetails: previous.goalDetails ?? current.goalDetails,
      secondaryGoal: previous.secondaryGoal,
      focusedMuscleGroup: previous.focusedMuscleGroup,
    };
  }
  if (scope === 'workout') {
    return {
      ...current,
      priorityRegion: previous.priorityRegion,
      daysPerWeek: previous.daysPerWeek ?? current.daysPerWeek,
      trainingDays: previous.trainingDays,
      workoutDurationMinutes: previous.workoutDurationMinutes ?? current.workoutDurationMinutes,
      equipment: previous.equipment ?? current.equipment,
      equipmentSettings: previous.equipmentSettings,
      injuries: previous.injuries,
      injuryEntries: previous.injuryEntries,
      experienceLevel: previous.experienceLevel,
      preferredSplit: previous.preferredSplit,
      dislikedExercises: previous.dislikedExercises,
    };
  }
  if (scope === 'mealplan') {
    return {
      ...current,
      foodsAvailable: previous.foodsAvailable ?? current.foodsAvailable,
      customFoods: previous.customFoods ?? current.customFoods,
      cookingSkill: previous.cookingSkill,
      prepTimeMinutes: previous.prepTimeMinutes,
      dietaryPreference: previous.dietaryPreference,
      mealVariety: previous.mealVariety,
      mealsPerDay: previous.mealsPerDay,
      savedMeals: previous.savedMeals,
      mealRoutine: previous.mealRoutine,
      customMacros: previous.customMacros,
      allergies: previous.allergies,
    };
  }
  return { ...current, ...previous };
}

const SHARE_LOGO_LIGHT = require('../../assets/images/thallo-logo-black.png');
const SHARE_LOGO_DARK  = require('../../assets/images/thallo-logo-white-transparent-New.png');

interface StrengthPoint {
  key: string;
  label: string;
  score: number;
}

function formatDate(isoString: string): string {
  const d = new Date(isoString);
  return `${DAY_NAMES[d.getDay()]} ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

type ExerciseTrendPoint = {
  label: string;
  bestWeight: number;
  volume: number;
  totalDuration: number;
};

function buildExerciseTrendMap(history: WorkoutSession[]): Record<string, ExerciseTrendPoint[]> {
  const trendMap: Record<string, ExerciseTrendPoint[]> = {};
  const sorted = [...history].sort((a, b) => +new Date(a.date) - +new Date(b.date));
  for (const session of sorted) {
    for (const exercise of session.exercises ?? []) {
      const key = exercise.name?.toLowerCase();
      if (!key) continue;
      const bestWeight = exercise.sets.length ? Math.max(...exercise.sets.map(set => set.weightLbs)) : 0;
      const volume = exercise.sets.reduce((sum, set) => sum + set.weightLbs * set.reps, 0);
      const totalDuration = exercise.sets.reduce((sum, set) => sum + ((set as any).durationSeconds ?? 0), 0);
      const d = new Date(session.date);
      const rows = trendMap[key] ?? [];
      rows.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, bestWeight, volume, totalDuration });
      trendMap[key] = rows.length > 10 ? rows.slice(-10) : rows;
    }
  }
  return trendMap;
}

const _CARDIO_EXERCISE_RE = /treadmill|stationary bike|elliptical|rowing machine|stair climber|assault bike|battle rope|jump rope|sprint|jogging|running|cycling|swimming|hiit|intervals|mountain climber|hill sprint|cardio|zone.?2|tempo|boxing|kickboxing|bag.?work|shadow.?box|burpee|plank|dead hang|wall sit|hollow.?hold|farmer.?carry|suitcase carry/i;

const CHART_MUSCLE_BUCKETS: { id: string; label: string; matches: (m: string) => boolean }[] = [
  { id: 'all',       label: 'All',       matches: () => true },
  { id: 'chest',     label: 'Chest',     matches: m => m === 'chest' },
  { id: 'back',      label: 'Back',      matches: m => m === 'back' || m === 'lats' },
  { id: 'shoulders', label: 'Shoulders', matches: m => m === 'shoulders' || m === 'delts' || m === 'rear_delts' },
  { id: 'arms',      label: 'Arms',      matches: m => m === 'biceps' || m === 'triceps' },
  { id: 'quads',     label: 'Quads',     matches: m => m === 'quads' },
  { id: 'hamstrings',label: 'Hamstrings',matches: m => m === 'hamstrings' },
  { id: 'glutes',    label: 'Glutes',    matches: m => m === 'glutes' },
  { id: 'calves',    label: 'Calves',    matches: m => m === 'calves' },
  { id: 'core',      label: 'Core',      matches: m => m === 'core' || m === 'abs' || m === 'obliques' },
];

function inferChartMuscleFromName(name: string): string {
  const n = name.toLowerCase();
  if (_CARDIO_EXERCISE_RE.test(n)) return 'cardio';
  if (/bench|push.?up|chest|pec|fly/.test(n)) return 'chest';
  if (/row|pulldown|pull.?up|chin.?up|lat|deadlift|trap/.test(n)) return 'back';
  if (/shoulder|overhead|ohp|lateral raise|rear delt|face pull/.test(n)) return 'shoulders';
  if (/curl|bicep/.test(n)) return 'biceps';
  if (/tricep|dip|skull/.test(n)) return 'triceps';
  if (/squat|leg press|lunge|split squat|step.?up|extension/.test(n)) return 'quads';
  if (/romanian|rdl|hamstring|leg curl|good morning/.test(n)) return 'hamstrings';
  if (/hip thrust|glute|kickback|bridge/.test(n)) return 'glutes';
  if (/calf/.test(n)) return 'calves';
  if (/\babs?\b|crunch|plank|\bcore\b|russian twist|leg raise|sit.?up|hollow|knee raise|woodchopper/.test(n)) return 'core';
  return '';
}

function paceSeconds(raw: string | null): number | null {
  if (!raw) return null;
  const match = raw.match(/(\d+):(\d{1,2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatPaceDelta(seconds: number): string {
  const abs = Math.abs(seconds);
  const min = Math.floor(abs / 60);
  const sec = abs % 60;
  return `${seconds < 0 ? '-' : '+'}${min}:${String(sec).padStart(2, '0')}`;
}

function buildCardioInsights(points: PaceHistoryPoint[]) {
  const withDistance = points.filter(p => p.distance != null && p.distance > 0);
  if (withDistance.length === 0) return [];
  const totalDistance = withDistance.reduce((sum, p) => sum + (p.distance ?? 0), 0);
  const bestDistance = withDistance.reduce((best, p) => (p.distance ?? 0) > (best.distance ?? 0) ? p : best, withDistance[0]);
  const latest = [...withDistance].sort((a, b) => +new Date(a.date) - +new Date(b.date)).slice(-1)[0];
  const byExercise = new Map<string, PaceHistoryPoint[]>();
  for (const p of points) byExercise.set(p.exercise, [...(byExercise.get(p.exercise) ?? []), p]);
  let bestPaceTrend: { exercise: string; delta: number } | null = null;
  for (const [exercise, rows] of byExercise) {
    const paceRows = rows
      .filter(p => paceSeconds(p.pace) != null)
      .sort((a, b) => +new Date(a.date) - +new Date(b.date));
    if (paceRows.length < 2) continue;
    const delta = paceSeconds(paceRows[paceRows.length - 1].pace)! - paceSeconds(paceRows[0].pace)!;
    if (!bestPaceTrend || delta < bestPaceTrend.delta) bestPaceTrend = { exercise, delta };
  }
  const recent = withDistance.slice(-3);
  const previous = withDistance.slice(-6, -3);
  const recentAvg = recent.reduce((sum, p) => sum + (p.distance ?? 0), 0) / Math.max(1, recent.length);
  const previousAvg = previous.reduce((sum, p) => sum + (p.distance ?? 0), 0) / Math.max(1, previous.length);
  const avgDelta = previous.length ? recentAvg - previousAvg : null;
  return [
    { label: '90d distance', value: `${totalDistance.toFixed(1)} mi`, detail: `${withDistance.length} cardio logs with distance` },
    { label: 'Best session', value: `${(bestDistance.distance ?? 0).toFixed(1)} mi`, detail: bestDistance.exercise },
    { label: 'Latest', value: `${(latest.distance ?? 0).toFixed(1)} mi`, detail: latest.pace ? `${latest.exercise} · ${latest.pace}` : latest.exercise },
    bestPaceTrend
      ? { label: 'Pace trend', value: formatPaceDelta(bestPaceTrend.delta), detail: `${bestPaceTrend.exercise} vs first log` }
      : avgDelta != null
        ? { label: 'Distance trend', value: `${avgDelta >= 0 ? '+' : ''}${avgDelta.toFixed(1)} mi`, detail: 'Recent 3 vs previous 3 avg' }
        : null,
  ].filter((x): x is { label: string; value: string; detail: string } => Boolean(x));
}

type ProgressMilestone = {
  key: string;
  title: string;
  value: string;
  detail: string;
  icon: any;
  color: string;
};

type PlateauEntry = import('../services/api').PlateauEntry;

type ProgressAnalyticsItem = {
  key: string;
  label: string;
  value: string;
  detail: string;
  icon: any;
  color: string;
};

type TrainingSignalItem = {
  key: string;
  label: string;
  value: string;
  detail: string;
  icon: any;
  color: string;
};

type ProgressOverviewItem = {
  key: string;
  label: string;
  value: string;
  detail: string;
  icon: any;
  color: string;
  targetTab: 'health' | 'body' | 'prs' | 'charts';
};

const PR_MOMENTUM_WINDOW_DAYS = 30;
const MIN_NUTRITION_DAYS_FOR_HEALTH_SCORE = 4;

function isActiveWorkoutSummary(summary: StoredWorkoutSummary): boolean {
  const hasSets = (summary.totalSets ?? 0) > 0
    || (summary.exercises ?? []).some(ex => (ex.sets?.length ?? 0) > 0);
  return hasSets || (summary.durationSeconds ?? 0) > 30;
}

function exerciseHistoryStats(history: WorkoutSession[]): Map<string, { firstDate: string; sessionCount: number }> {
  const byExercise = new Map<string, Set<string>>();
  for (const session of history.filter(s => s.completed && !s.skipped)) {
    for (const exercise of session.exercises ?? []) {
      const key = exercise.name?.trim().toLowerCase();
      if (!key) continue;
      const hasLoadedSet = (exercise.sets ?? []).some(set => (set.weightLbs ?? 0) > 0 && (set.reps ?? 0) > 0);
      if (!hasLoadedSet) continue;
      const sessionKey = session.id || session.date;
      if (!sessionKey) continue;
      const bucket = byExercise.get(key) ?? new Set<string>();
      bucket.add(`${session.date}::${sessionKey}`);
      byExercise.set(key, bucket);
    }
  }

  const out = new Map<string, { firstDate: string; sessionCount: number }>();
  for (const [key, sessions] of byExercise) {
    const dates = Array.from(sessions)
      .map(v => v.split('::')[0])
      .filter(Boolean)
      .sort((a, b) => +new Date(a) - +new Date(b));
    if (dates.length > 0) {
      out.set(key, { firstDate: dates[0], sessionCount: dates.length });
    }
  }
  return out;
}

function establishedRecentPrs(history: WorkoutSession[], prs: PR[], sinceMs: number): PR[] {
  const stats = exerciseHistoryStats(history);
  return prs.filter(pr => {
    if (+new Date(pr.date) < sinceMs) return false;
    const stat = stats.get(pr.exerciseName.toLowerCase());
    if (!stat || stat.sessionCount < 2) return false;
    return +new Date(pr.date) > +new Date(stat.firstDate);
  });
}

function OneRepMaxTrendCard({
  title,
  subtitle,
  points,
  tc,
  styles,
}: {
  title: string;
  subtitle: string;
  points: import('../services/api').E1RMHistoryPoint[];
  tc: ReturnType<typeof getTheme>['colors'];
  styles: ReturnType<typeof createStyles>;
}) {
  if (points.length < 2) return null;

  const values = points.map(p => Number(p.e1rm_lbs)).filter(v => Number.isFinite(v) && v > 0);
  if (values.length < 2) return null;

  const chartW = 320;
  const chartH = 140;
  const padL = 40;
  const padR = 16;
  const padT = 16;
  const padB = 28;
  const plotW = chartW - padL - padR;
  const plotH = chartH - padT - padB;
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const span = Math.max(5, rawMax - rawMin);
  const rangeMin = Math.max(0, Math.floor(rawMin - span * 0.25));
  const rangeMax = Math.ceil(rawMax + span * 0.25);
  const rangeDelta = Math.max(1, rangeMax - rangeMin);
  const chartPoints = points.map((point, i) => {
    const v = Number(point.e1rm_lbs);
    const x = padL + (points.length > 1 ? (i / (points.length - 1)) * plotW : plotW / 2);
    const y = padT + plotH - ((v - rangeMin) / rangeDelta) * plotH;
    const d = new Date(point.date);
    return { x, y, v, label: `${d.getMonth() + 1}/${d.getDate()}`, i };
  });
  const polyPoints = chartPoints.map(p => `${p.x},${p.y}`).join(' ');
  const gridLines = 4;
  const gridVals = Array.from({ length: gridLines }, (_, i) =>
    Math.round(rangeMin + (rangeDelta * (i / (gridLines - 1))))
  );
  const first = values[0];
  const last = values[values.length - 1];
  const delta = Math.round(last - first);
  const deltaColor = delta > 0 ? '#22C55E' : delta < 0 ? '#EF4444' : tc.textMuted;

  return (
    <View style={styles.graphCard}>
      <View style={styles.graphHeader}>
        <Text style={styles.graphTitle}>{title}</Text>
        <Text style={{ fontSize: 12, fontWeight: '800', color: deltaColor }}>
          {delta > 0 ? '+' : ''}{delta} lb
        </Text>
      </View>
      <Text style={styles.graphSubtitle}>{subtitle}</Text>
      <View style={{ alignItems: 'center', marginVertical: 8 }}>
        <Svg width={chartW} height={chartH}>
          {gridVals.map((gv, gi) => {
            const gy = padT + plotH - ((gv - rangeMin) / rangeDelta) * plotH;
            return (
              <Line key={gi} x1={padL} y1={gy} x2={chartW - padR} y2={gy}
                stroke={tc.border} strokeWidth={1} strokeDasharray="4,4" />
            );
          })}
          {gridVals.map((gv, gi) => {
            const gy = padT + plotH - ((gv - rangeMin) / rangeDelta) * plotH;
            return (
              <SvgText key={`lbl${gi}`} x={padL - 6} y={gy + 4}
                fontSize={10} fill={tc.textMuted} textAnchor="end">
                {gv}
              </SvgText>
            );
          })}
          <Polyline points={polyPoints}
            fill="none" stroke={tc.primary} strokeWidth={2.5}
            strokeLinejoin="round" strokeLinecap="round" />
          {chartPoints.map((p) => (
            <Circle key={p.i} cx={p.x} cy={p.y}
              r={p.i === chartPoints.length - 1 ? 5 : 3.5}
              fill={p.i === chartPoints.length - 1 ? tc.accent : tc.primary}
              stroke={tc.surface} strokeWidth={1.5} />
          ))}
          {chartPoints.length <= 12 && chartPoints.map((p) => (
            <SvgText key={`d${p.i}`} x={p.x} y={chartH - 4}
              fontSize={9} fill={tc.textMuted} textAnchor="middle">
              {p.label}
            </SvgText>
          ))}
        </Svg>
      </View>
      <View style={styles.chartSummaryRow}>
        <View style={styles.chartStat}>
          <Text style={styles.chartStatValue}>{Math.round(last)} lbs</Text>
          <Text style={styles.chartStatLabel}>Current e1RM</Text>
        </View>
        <View style={styles.chartStat}>
          <Text style={styles.chartStatValue}>{Math.round(Math.max(...values))} lbs</Text>
          <Text style={styles.chartStatLabel}>Peak e1RM</Text>
        </View>
        <View style={styles.chartStat}>
          <Text style={[styles.chartStatValue, { color: deltaColor }]}>
            {delta > 0 ? '+' : ''}{delta} lbs
          </Text>
          <Text style={styles.chartStatLabel}>vs first estimate</Text>
        </View>
      </View>
    </View>
  );
}

function buildProgressMilestones(
  history: WorkoutSession[],
  prs: PR[],
  summaries: StoredWorkoutSummary[],
  paceHistory: PaceHistoryPoint[],
  mealAverages: { window_days: number; days_with_data: number; avg_protein_g: number; avg_protein_g_when_logged?: number } | null,
  oneRepMaxLifts: Array<{ name: string; oneRepMaxLbs: number }>,
): ProgressMilestone[] {
  const now = Date.now();
  const thirtyDaysAgo = now - PR_MOMENTUM_WINDOW_DAYS * 86400000;
  const completed = history.filter(s => s.completed && !s.skipped);
  const completedDayKeys = new Set<string>();
  for (const session of completed) {
    completedDayKeys.add(session.date.slice(0, 10));
  }
  const activeSummaries = summaries.filter(isActiveWorkoutSummary);
  for (const summary of activeSummaries) {
    completedDayKeys.add(summary.date.slice(0, 10));
  }
  const activeDays30 = Array.from(completedDayKeys).filter(k => +new Date(`${k}T00:00:00`) >= thirtyDaysAgo).length;
  const recentPrs = establishedRecentPrs(history, prs, thirtyDaysAgo);
  const durationSource = activeSummaries.length > 0 ? activeSummaries : completed;
  const totalMinutes = Math.round(durationSource.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0) / 60);
  const cardioMiles = paceHistory.reduce((sum, p) => sum + (p.distance ?? 0), 0);
  const topLift = oneRepMaxLifts.reduce(
    (best, lift) => lift.oneRepMaxLbs > (best?.oneRepMaxLbs ?? 0) ? lift : best,
    null as { name: string; oneRepMaxLbs: number } | null,
  );

  const cards: ProgressMilestone[] = [];
  if (activeDays30 > 0) {
    cards.push({
      key: 'active-days',
      title: '30-day consistency',
      value: `${activeDays30}`,
      detail: `active training day${activeDays30 === 1 ? '' : 's'} logged`,
      icon: 'calendar-outline',
      color: '#22C55E',
    });
  }
  if (recentPrs.length > 0) {
    cards.push({
      key: 'recent-prs',
      title: 'PR momentum',
      value: `${recentPrs.length}`,
      detail: 'records after your baseline in the last 30 days',
      icon: 'trophy-outline',
      color: '#F59E0B',
    });
  }
  if (topLift) {
    cards.push({
      key: 'top-lift',
      title: 'Top strength marker',
      value: `${Math.round(topLift.oneRepMaxLbs)} lb`,
      detail: `${topLift.name} estimated 1RM`,
      icon: 'barbell-outline',
      color: '#6366F1',
    });
  }
  if (mealAverages && mealAverages.days_with_data > 0) {
    const loggedDayProtein = mealAverages.avg_protein_g_when_logged ?? mealAverages.avg_protein_g;
    cards.push({
      key: 'nutrition-data',
      title: 'Nutrition signal',
      value: `${mealAverages.days_with_data}/${mealAverages.window_days}`,
      detail: mealAverages.days_with_data >= 2
        ? `${Math.round(loggedDayProtein)}g protein/logged day`
        : 'first meal-logging day captured',
      icon: 'nutrition-outline',
      color: '#14B8A6',
    });
  }
  if (cardioMiles > 0) {
    cards.push({
      key: 'cardio-base',
      title: 'Cardio base',
      value: `${cardioMiles.toFixed(1)} mi`,
      detail: `${paceHistory.length} distance-based cardio log${paceHistory.length === 1 ? '' : 's'}`,
      icon: 'pulse-outline',
      color: '#EF4444',
    });
  }
  if (cards.length < 4 && completed.length > 0) {
    cards.push({
      key: 'total-workouts',
      title: 'Workout bank',
      value: `${completed.length}`,
      detail: totalMinutes > 0 ? `${Math.round(totalMinutes / 60)} total hours trained` : 'completed sessions',
      icon: 'checkmark-done-outline',
      color: '#0EA5E9',
    });
  }
  return cards.slice(0, 4);
}

function buildProgressAnalytics(
  history: WorkoutSession[],
  summaries: StoredWorkoutSummary[],
  prs: PR[],
  plateaus: PlateauEntry[],
): ProgressAnalyticsItem[] {
  const completed = history.filter(s => s.completed && !s.skipped);
  const activeDayKeys = new Set<string>();
  for (const session of completed) activeDayKeys.add(session.date.slice(0, 10));
  for (const summary of summaries) {
    if (isActiveWorkoutSummary(summary)) activeDayKeys.add(summary.date.slice(0, 10));
  }

  const dayKeys = Array.from(activeDayKeys).sort();
  let bestStreak = 0;
  let runningStreak = 0;
  let prevTime: number | null = null;
  for (const key of dayKeys) {
    const t = +new Date(`${key}T00:00:00`);
    runningStreak = prevTime != null && Math.round((t - prevTime) / 86400000) === 1 ? runningStreak + 1 : 1;
    bestStreak = Math.max(bestStreak, runningStreak);
    prevTime = t;
  }

  let latestStreak = 0;
  if (dayKeys.length > 0) {
    const localDayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let expected = new Date(`${dayKeys[dayKeys.length - 1]}T00:00:00`);
    for (let i = dayKeys.length - 1; i >= 0; i--) {
      if (dayKeys[i] !== localDayKey(expected)) break;
      latestStreak += 1;
      expected = new Date(+expected - 86400000);
    }
  }

  const workRows = (summaries.length > 0
    ? summaries.map(s => ({
        date: s.date,
        sets: s.totalSets ?? 0,
        minutes: Math.round((s.durationSeconds ?? 0) / 60),
      }))
    : completed.map(s => ({
        date: s.date,
        sets: s.exercises.reduce((sum, ex) => sum + (ex.sets?.length ?? 0), 0),
        minutes: Math.round((s.durationSeconds ?? 0) / 60),
      })))
    .filter(row => row.sets > 0 || row.minutes > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const rows: ProgressAnalyticsItem[] = [];
  if (bestStreak > 0) {
    rows.push({
      key: 'streaks',
      label: 'Training streaks',
      value: `${bestStreak}d`,
      detail: latestStreak > 1 ? `latest streak ${latestStreak} days` : `${dayKeys.length} total active days`,
      icon: 'flame-outline',
      color: '#F59E0B',
    });
  }

  if (workRows.length >= 2) {
    const recent = workRows.slice(-4);
    const previous = workRows.slice(Math.max(0, workRows.length - 8), Math.max(0, workRows.length - 4));
    const recentAvg = recent.reduce((sum, row) => sum + row.sets, 0) / Math.max(1, recent.length);
    const previousAvg = previous.reduce((sum, row) => sum + row.sets, 0) / Math.max(1, previous.length);
    const deltaPct = previous.length > 0 && previousAvg > 0 ? Math.round(((recentAvg - previousAvg) / previousAvg) * 100) : null;
    rows.push({
      key: 'volume-trend',
      label: 'Volume trend',
      value: deltaPct == null ? `${Math.round(recentAvg)} sets` : `${deltaPct >= 0 ? '+' : ''}${deltaPct}%`,
      detail: previous.length > 0 ? 'last 4 sessions vs previous 4' : 'average sets in recent sessions',
      icon: 'analytics-outline',
      color: deltaPct != null && deltaPct < 0 ? '#EF4444' : '#22C55E',
    });
  }

  const now = Date.now();
  const thirtyDaysAgo = now - PR_MOMENTUM_WINDOW_DAYS * 86400000;
  const recentPrs = establishedRecentPrs(history, prs, thirtyDaysAgo);
  if (recentPrs.length > 0) {
    rows.push({
      key: 'recent-records',
      label: 'Records',
      value: `${recentPrs.length}`,
      detail: 'PRs after your first baseline session',
      icon: 'trophy-outline',
      color: '#6366F1',
    });
  }

  if (plateaus.length > 0) {
    const deloadCount = plateaus.filter(p => p.suggestion === 'deload').length;
    rows.push({
      key: 'plateau-watch',
      label: 'Plateau watch',
      value: `${plateaus.length}`,
      detail: deloadCount > 0 ? `${deloadCount} may need a deload` : 'exercises flat over the review window',
      icon: 'alert-circle-outline',
      color: '#F59E0B',
    });
  }

  if (rows.length < 4 && completed.length > 0) {
    const sessions30 = completed.filter(s => +new Date(s.date) >= thirtyDaysAgo).length;
    rows.push({
      key: 'sessions-30',
      label: 'Sessions',
      value: `${sessions30}`,
      detail: 'completed in the last 30 days',
      icon: 'checkmark-done-outline',
      color: '#0EA5E9',
    });
  }

  return rows.slice(0, 4);
}

function buildThisWeekOverview(
  history: WorkoutSession[],
  summaries: StoredWorkoutSummary[],
  prs: PR[],
  weightEntries: Array<{ date: string; weightLbs: number }>,
  paceHistory: PaceHistoryPoint[],
  mealHistory: Array<{ meal_date: string }> | null,
): ProgressOverviewItem[] {
  const now = Date.now();
  const dayMs = 86400000;
  const sevenAgo = now - 7 * dayMs;
  const fourteenAgo = now - 14 * dayMs;
  const timeOf = (raw: string): number => {
    const key = String(raw ?? '').slice(0, 10);
    return key ? +new Date(`${key}T12:00:00`) : 0;
  };
  const trendText = (current: number, previous: number, noun: string): string => {
    if (previous <= 0) return `${noun} in the last 7 days`;
    const delta = current - previous;
    if (delta === 0) return `unchanged vs previous 7 days`;
    return `${delta > 0 ? '+' : ''}${delta} vs previous 7 days`;
  };

  const workoutRows = (summaries.length > 0
    ? summaries.map(s => ({
        date: s.date,
        sets: s.totalSets ?? 0,
        minutes: Math.round((s.durationSeconds ?? 0) / 60),
      }))
    : history
        .filter(s => s.completed && !s.skipped)
        .map(s => ({
          date: s.date,
          sets: (s.exercises ?? []).reduce((sum, ex) => sum + (ex.sets?.length ?? 0), 0),
          minutes: Math.round((s.durationSeconds ?? 0) / 60),
        })))
    .filter(row => row.sets > 0 || row.minutes > 0);

  const recentWorkoutDays = new Set(workoutRows.filter(row => timeOf(row.date) >= sevenAgo).map(row => row.date.slice(0, 10))).size;
  const previousWorkoutDays = new Set(workoutRows.filter(row => {
    const t = timeOf(row.date);
    return t >= fourteenAgo && t < sevenAgo;
  }).map(row => row.date.slice(0, 10))).size;
  const recentSets = workoutRows.filter(row => timeOf(row.date) >= sevenAgo).reduce((sum, row) => sum + row.sets, 0);
  const previousSets = workoutRows.filter(row => {
    const t = timeOf(row.date);
    return t >= fourteenAgo && t < sevenAgo;
  }).reduce((sum, row) => sum + row.sets, 0);

  const items: ProgressOverviewItem[] = [];
  if (recentWorkoutDays > 0) {
    items.push({
      key: 'week-workouts',
      label: 'Training days',
      value: `${recentWorkoutDays}`,
      detail: trendText(recentWorkoutDays, previousWorkoutDays, 'active days'),
      icon: 'calendar-outline',
      color: '#22C55E',
      targetTab: 'health',
    });
  }
  if (recentSets > 0) {
    items.push({
      key: 'week-volume',
      label: 'Lift volume',
      value: `${recentSets}`,
      detail: trendText(recentSets, previousSets, 'sets logged'),
      icon: 'barbell-outline',
      color: '#6366F1',
      targetTab: 'charts',
    });
  }

  const recentPrs = prs.filter(pr => timeOf(pr.date) >= sevenAgo);
  if (recentPrs.length > 0) {
    const top = recentPrs[0];
    items.push({
      key: 'week-prs',
      label: 'New PRs',
      value: `${recentPrs.length}`,
      detail: top ? `${top.exerciseName}: ${Math.round(top.weightLbs)} lb x ${top.reps}` : 'records this week',
      icon: 'trophy-outline',
      color: '#F59E0B',
      targetTab: 'prs',
    });
  }

  const weights = [...weightEntries]
    .filter(w => Number.isFinite(w.weightLbs))
    .sort((a, b) => timeOf(a.date) - timeOf(b.date));
  if (weights.length >= 2) {
    const latest = weights[weights.length - 1];
    const baseline = [...weights].reverse().find(w => timeOf(w.date) <= sevenAgo) ?? weights[0];
    const delta = Math.round((latest.weightLbs - baseline.weightLbs) * 10) / 10;
    items.push({
      key: 'week-weight',
      label: 'Body weight',
      value: `${latest.weightLbs} lb`,
      detail: `${delta > 0 ? '+' : ''}${delta} lb since ${formatDate(baseline.date)}`,
      icon: delta < 0 ? 'trending-down-outline' : delta > 0 ? 'trending-up-outline' : 'remove-outline',
      color: delta < 0 ? '#22C55E' : delta > 0 ? '#F59E0B' : '#0EA5E9',
      targetTab: 'body',
    });
  }

  const recentCardioMiles = paceHistory
    .filter(p => timeOf(p.date) >= sevenAgo)
    .reduce((sum, p) => sum + (p.distance ?? 0), 0);
  if (recentCardioMiles > 0) {
    items.push({
      key: 'week-cardio',
      label: 'Cardio distance',
      value: `${recentCardioMiles.toFixed(1)} mi`,
      detail: 'distance logged in the last 7 days',
      icon: 'pulse-outline',
      color: '#EF4444',
      targetTab: 'charts',
    });
  }

  const mealDays = new Set((mealHistory ?? [])
    .filter(row => timeOf(row.meal_date) >= sevenAgo)
    .map(row => row.meal_date.slice(0, 10)));
  if (mealDays.size > 0) {
    items.push({
      key: 'week-meals',
      label: 'Meal signal',
      value: `${mealDays.size}/7`,
      detail: 'days with meal data this week',
      icon: 'nutrition-outline',
      color: '#14B8A6',
      targetTab: 'health',
    });
  }

  return items.slice(0, 4);
}

function workoutCompletionKey(dateISO?: string | null, focus?: string | null): string | null {
  const date = typeof dateISO === 'string' ? dateISO.slice(0, 10) : '';
  const focusKey = typeof focus === 'string' ? focus.trim().toLowerCase() : '';
  return date && focusKey ? `${date}|${focusKey}` : null;
}

function normalizeHrZoneMinutes(raw?: number[] | null): [number, number, number, number, number] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const zones = raw.slice(0, 5).map(v => Number.isFinite(Number(v)) ? Number(v) : 0);
  while (zones.length < 5) zones.push(0);
  return zones as [number, number, number, number, number];
}

function mergeCompletionMetrics(summary: StoredWorkoutSummary, completion: WorkoutCompletionRecord): StoredWorkoutSummary {
  const hr = completion.hr_summary;
  const zones = normalizeHrZoneMinutes(hr?.zoneMinutes);
  return {
    ...summary,
    caloriesBurned: summary.caloriesBurned || completion.calories_burned || 0,
    hrAvg: summary.hrAvg ?? (hr?.avgBpm != null ? Math.round(Number(hr.avgBpm)) : undefined),
    hrMax: summary.hrMax ?? (hr?.maxBpm != null ? Math.round(Number(hr.maxBpm)) : undefined),
    hrZoneMinutes: summary.hrZoneMinutes ?? zones,
  };
}

function summaryFromCompletion(completion: WorkoutCompletionRecord): StoredWorkoutSummary | null {
  const hasHealthMetrics = Boolean(
    completion.calories_burned
    || completion.hr_summary?.avgBpm
    || completion.hr_summary?.maxBpm
    || completion.hr_summary?.zoneMinutes?.some(m => Number(m) > 0),
  );
  if (!hasHealthMetrics) return null;
  return mergeCompletionMetrics({
    id: `server-summary-${completion.id}`,
    date: completion.completed_at ?? `${completion.workout_date}T12:00:00.000Z`,
    focus: completion.focus_label,
    durationSeconds: completion.duration_seconds,
    totalSets: 0,
    totalReps: 0,
    caloriesBurned: completion.calories_burned ?? 0,
    motivationMessage: 'Workout logged.',
    achievements: [],
    recommendations: [],
    headline: 'Workout logged',
    coachingPoint: '',
    motivation: '',
  }, completion);
}

function manualActivityFromCompletion(completion: WorkoutCompletionRecord): WorkoutSession['manualActivity'] | undefined {
  if (!completion.activity_category) return undefined;
  return {
    category: completion.activity_category as any,
    subtype: completion.activity_subtype ?? '',
    intensity: (completion.activity_intensity ?? 'moderate') as any,
    cardioStyle: completion.cardio_style as any,
    distanceMiles: completion.distance_miles ?? undefined,
    caloriesBurned: completion.calories_burned ?? undefined,
    avgHeartRate: completion.hr_summary?.avgBpm != null ? Math.round(Number(completion.hr_summary.avgBpm)) : undefined,
  };
}

function mergeCompletionIntoSession(session: WorkoutSession, completion: WorkoutCompletionRecord): WorkoutSession {
  return {
    ...session,
    date: session.date || completion.completed_at || `${completion.workout_date}T12:00:00.000Z`,
    durationSeconds: session.durationSeconds || completion.duration_seconds || 0,
    completed: true,
    manualActivity: session.manualActivity ?? manualActivityFromCompletion(completion),
  };
}

function targetRepsFromServerExercise(exercise: NonNullable<WorkoutSessionRecord['exercises']>[number]): string {
  if (exercise.target_reps_text) return exercise.target_reps_text;
  const first = exercise.sets?.[0];
  const min = first?.target_reps_min;
  const max = first?.target_reps_max;
  if (min != null && max != null && min !== max) return `${min}-${max}`;
  if (max != null) return String(max);
  if (min != null) return String(min);
  return '';
}

function workoutSessionFromServer(row: WorkoutSessionRecord): WorkoutSession {
  const exercises = (row.exercises ?? []).map(exercise => {
    const sets = (exercise.sets ?? [])
      .filter(set => set.completed !== false)
      .map((set, index) => ({
        setNumber: Number(set.set_number ?? index + 1),
        reps: Number(set.actual_reps ?? set.target_reps_max ?? set.target_reps_min ?? 0),
        weightLbs: Number(set.actual_weight_lbs ?? set.target_weight_lbs ?? 0),
        durationSeconds: set.duration_seconds ?? undefined,
        comfortRating: set.comfort_rating ?? undefined,
        rir: set.actual_rir ?? undefined,
        actualDistance: set.actual_distance ?? undefined,
        actualPace: set.actual_pace ?? undefined,
        heartRateAvg: set.heart_rate_avg ?? undefined,
        cardioMetrics: set.cardio_metrics ?? undefined,
      }));
    return {
      name: exercise.name,
      targetSets: sets.length,
      targetReps: targetRepsFromServerExercise(exercise),
      targetRestSeconds: exercise.rest_seconds ?? 60,
      equipment: exercise.equipment ?? 'other',
      sets,
      slug: exercise.exercise_slug_snapshot ?? undefined,
      primaryMuscle: exercise.primary_muscle_snapshot ?? undefined,
      primary_muscle: exercise.primary_muscle_snapshot ?? undefined,
      secondaryMuscles: exercise.secondary_muscles_snapshot ?? undefined,
      secondary_muscles: exercise.secondary_muscles_snapshot ?? undefined,
      isCompound: exercise.is_compound_snapshot ?? undefined,
    };
  });
  return {
    id: `server-session-${row.id}`,
    date: row.completed_at ?? `${row.workout_date}T12:00:00.000Z`,
    focus: row.focus,
    durationSeconds: 0,
    startedAt: row.created_at ?? undefined,
    endedAt: row.completed_at ?? undefined,
    exercises,
    completed: Boolean(row.completed_at),
  };
}

function mergeWorkoutSessionSources(localHistory: WorkoutSession[], serverRows: WorkoutSessionRecord[] | null): WorkoutSession[] {
  if (!serverRows) return localHistory;
  const byKey = new Map<string, WorkoutSession>();
  for (const session of localHistory) {
    const key = workoutCompletionKey(session.date, session.focus);
    if (key) byKey.set(key, session);
  }
  for (const row of serverRows) {
    const session = workoutSessionFromServer(row);
    const key = workoutCompletionKey(session.date, session.focus);
    if (!key) continue;
    const existing = byKey.get(key);
    const existingSetCount = existing?.exercises?.reduce((sum, ex) => sum + (ex.sets?.length ?? 0), 0) ?? 0;
    const serverSetCount = session.exercises.reduce((sum, ex) => sum + (ex.sets?.length ?? 0), 0);
    if (!existing || (existingSetCount === 0 && serverSetCount > 0)) {
      byKey.set(key, session);
    }
  }
  return Array.from(byKey.values()).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

function reconcileWorkoutProgressData(
  history: WorkoutSession[],
  summaries: StoredWorkoutSummary[],
  completions: WorkoutCompletionRecord[] | null,
): { history: WorkoutSession[]; summaries: StoredWorkoutSummary[] } {
  if (!completions) return { history, summaries };
  const completionsByKey = new Map(
    completions
      .map(c => [workoutCompletionKey(c.workout_date, c.focus_label), c] as const)
      .filter((entry): entry is [string, WorkoutCompletionRecord] => !!entry[0]),
  );
  const completionKeys = new Set(
    completionsByKey.keys(),
  );
  if (completionKeys.size === 0) return { history: [], summaries: [] };

  const scopedHistory = history
    .map(session => {
      const key = workoutCompletionKey(session.date, session.focus);
      const completion = key ? completionsByKey.get(key) : undefined;
      return completion ? mergeCompletionIntoSession(session, completion) : session;
    })
    .filter(session => {
      const key = workoutCompletionKey(session.date, session.focus);
      return !!key && completionKeys.has(key);
    });
  const existingKeys = new Set(
    scopedHistory
      .map(session => workoutCompletionKey(session.date, session.focus))
      .filter((key): key is string => !!key),
  );
  for (const completion of completions) {
    const key = workoutCompletionKey(completion.workout_date, completion.focus_label);
    if (!key || existingKeys.has(key)) continue;
    scopedHistory.push({
      id: `server-${completion.id}`,
      date: completion.completed_at ?? `${completion.workout_date}T12:00:00.000Z`,
      focus: completion.focus_label,
      durationSeconds: completion.duration_seconds,
      exercises: [],
      completed: true,
      ...(manualActivityFromCompletion(completion) ? { manualActivity: manualActivityFromCompletion(completion) } : {}),
    });
    existingKeys.add(key);
  }
  scopedHistory.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

  const scopedSummaries = summaries.filter(summary => {
    const key = workoutCompletionKey(summary.date, summary.focus);
    return !!key && completionKeys.has(key);
  });
  const summariesByKey = new Map(
    scopedSummaries
      .map(summary => [workoutCompletionKey(summary.date, summary.focus), summary] as const)
      .filter((entry): entry is [string, StoredWorkoutSummary] => !!entry[0]),
  );
  for (const completion of completions) {
    const key = workoutCompletionKey(completion.workout_date, completion.focus_label);
    if (!key) continue;
    const existing = summariesByKey.get(key);
    if (existing) {
      summariesByKey.set(key, mergeCompletionMetrics(existing, completion));
      continue;
    }
    const serverSummary = summaryFromCompletion(completion);
    if (serverSummary) summariesByKey.set(key, serverSummary);
  }
  const reconciledSummaries = Array.from(summariesByKey.values())
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return { history: scopedHistory, summaries: reconciledSummaries };
}

function buildTrainingSignals(
  history: WorkoutSession[],
  summaries: StoredWorkoutSummary[],
  healthKitAvailable: boolean,
  healthEnabled: boolean,
): TrainingSignalItem[] {
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 86400000;
  const fourteenDaysAgo = now - 14 * 86400000;

  const recentSets = history
    .filter(s => +new Date(s.date) >= thirtyDaysAgo && s.completed && !s.skipped)
    .flatMap(s => (s.exercises ?? []).flatMap(ex => ex.sets ?? []));
  const rirValues = recentSets
    .map(set => set.rir)
    .filter((rir): rir is number => typeof rir === 'number' && Number.isFinite(rir));

  const recentSummaries = summaries
    .filter(s => +new Date(s.date) >= fourteenDaysAgo)
    .sort((a, b) => a.date.localeCompare(b.date));
  const hrTotals = recentSummaries.reduce(
    (acc, s) => {
      const zones = s.hrZoneMinutes;
      if (!zones?.some(m => m > 0)) return acc;
      zones.forEach((min, idx) => { acc[idx] += min; });
      return acc;
    },
    [0, 0, 0, 0, 0],
  );
  const totalHrMinutes = hrTotals.reduce((sum, min) => sum + min, 0);
  const sorenessCounts = new Map<string, number>();
  for (const summary of recentSummaries) {
    for (const area of summary.feedback?.sorenessAreas ?? []) {
      sorenessCounts.set(area, (sorenessCounts.get(area) ?? 0) + 1);
    }
  }
  const topSoreness = Array.from(sorenessCounts.entries()).sort((a, b) => b[1] - a[1])[0] ?? null;
  const scored = recentSummaries
    .map(s => s.trainingScore)
    .filter((score): score is number => typeof score === 'number' && Number.isFinite(score));

  const signals: TrainingSignalItem[] = [];
  signals.push({
    key: 'rir',
    label: 'Effort reserve',
    value: rirValues.length > 0
      ? `${(rirValues.reduce((sum, rir) => sum + rir, 0) / rirValues.length).toFixed(1)} RIR`
      : 'No RIR yet',
    detail: rirValues.length > 0
      ? `${rirValues.length} logged set${rirValues.length === 1 ? '' : 's'} in the last 30 days`
      : 'Log reps-in-reserve on hard sets to tune progression.',
    icon: 'speedometer-outline',
    color: '#6366F1',
  });
  signals.push({
    key: 'hr-zones',
    label: 'Heart-rate zones',
    value: totalHrMinutes > 0
      ? `${Math.round(hrTotals[1])}m Z2`
      : healthKitAvailable && healthEnabled
        ? 'No HR yet'
        : 'Manual mode',
    detail: totalHrMinutes > 0
      ? `${Math.round(hrTotals[2] + hrTotals[3] + hrTotals[4])}m Z3+ across recent sessions`
      : healthKitAvailable
        ? 'Connect Apple Health or wear Watch during workouts for zone trends.'
        : 'Apple Health is unavailable here; workout scoring falls back to sets, duration, and completion.',
    icon: 'pulse-outline',
    color: '#EF4444',
  });
  signals.push({
    key: 'soreness',
    label: 'Soreness trend',
    value: topSoreness ? topSoreness[0] : 'Clear',
    detail: topSoreness
      ? `${topSoreness[1]} recent mention${topSoreness[1] === 1 ? '' : 's'} in post-workout feedback`
      : 'No soreness areas reported in the last 14 days.',
    icon: 'body-outline',
    color: topSoreness ? '#F59E0B' : '#22C55E',
  });
  signals.push({
    key: 'training-score',
    label: 'Session quality',
    value: scored.length > 0
      ? `${Math.round(scored.reduce((sum, score) => sum + score, 0) / scored.length)}`
      : 'Pending',
    detail: scored.length > 0
      ? `Average training score across ${scored.length} recent session${scored.length === 1 ? '' : 's'}`
      : 'Finish a scored workout to see trendable quality data.',
    icon: 'analytics-outline',
    color: '#14B8A6',
  });

  return signals;
}

/**
 * AnimatedChartBar — "draw-in" a chart bar from height 0 → target over
 * ~800ms on mount / when the target changes significantly. Staggered by
 * `delay` so the full chart paints left-to-right.
 *
 * Replaces the old static `<View style={[styles.graphBar, { height }]} />`
 * render. Height is a layout prop → non-native-driver (JS animation).
 */
function AnimatedChartBar({
  targetHeight,
  delay = 0,
  style,
}: {
  targetHeight: number;
  delay?: number;
  style?: any;
}) {
  const height = useRef(new Animated.Value(0)).current;
  const prevTarget = useRef<number>(0);
  useEffect(() => {
    // Only run the draw-in when height changes — prevents re-triggering
    // on theme/pallette re-renders.
    if (prevTarget.current === targetHeight) return;
    prevTarget.current = targetHeight;
    Animated.timing(height, {
      toValue: targetHeight,
      duration: 800,
      delay,
      useNativeDriver: false,
    }).start();
  }, [targetHeight, delay, height]);
  return <Animated.View style={[style, { height }]} />;
}

export default function ProgressScreen({ onBack, authToken, userProfile, onUpdateWeight, onCancelScheduledPlanChange, themeName, noHeader = false, nutritionPlan, nutritionLogRefreshKey = 0 }: ProgressScreenProps) {
  const tc = getTheme(themeName).colors;
  const styles = useMemo(() => createStyles(tc), [themeName]);
  const primaryButtonTextColor = getContrastingTextColor(tc.primary);
  const meta = useMetaData();
  const isProTier = tierOf(userProfile) === 'pro';
  const [tab, setTab] = useState<'health' | 'body' | 'prs' | 'charts'>('health');
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [showLogActivity, setShowLogActivity] = useState(false);
  const fitnessScoreRef = useRef<ViewShot>(null);
  const bodyScanShareRef = useRef<ViewShot>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [selectedExercise, setSelectedExercise] = useState<string | null>(null);
  // Default to 'volume' — most users care about total work done per
  // session more than max load on a single set. Toggleable.
  // PR chart was removed — running max-weight is essentially the Weight
  // chart with a different highlight, and Estimated 1RM is the better
  // progress signal (factors in reps + RIR, not just heaviest set).
  const [chartMode, setChartMode] = useState<'weight' | 'volume' | 'duration' | 'e1rm'>('volume');
  const [e1rmHistory, setE1rmHistory] = useState<Array<{ date: string; e1rm_lbs: number; confidence: string }>>([]);
  // Optional muscle filter for the exercise picker. 'all' = no filter.
  const [chartMuscleFilter, setChartMuscleFilter] = useState<string>('all');
  const [prs, setPrs] = useState<PR[]>([]);
  const [prSearch, setPrSearch] = useState('');
  const [prFocusFilter, setPrFocusFilter] = useState<string | null>(null);
  const [history, setHistory] = useState<WorkoutSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [insights, setInsights] = useState<any | null>(null);
  const [guardrails, setGuardrails] = useState<string[]>([]);
  const [coachMemory, setCoachMemory] = useState<any[]>([]);
  const [progressionHint, setProgressionHint] = useState<string>('');
  const [editingWeight, setEditingWeight] = useState(false);
  const [weightInput, setWeightInput] = useState('');
  const [summaries, setSummaries] = useState<StoredWorkoutSummary[]>([]);
  // Render cap for the workout summaries list. Starts at 30 (the
  // historical cap) and grows by 30 when the user taps "Load more".
  // Local state — the data is already in memory, so pagination is
  // pure render-time slicing.
  const [visibleSummaryCount, setVisibleSummaryCount] = useState(30);
  const [goalHistory, setGoalHistory] = useState<GoalHistoryEntry[]>([]);
  const [planChanges, setPlanChanges] = useState<PlanChangeEntry[]>([]);
  const [bodyScanLoading, setBodyScanLoading] = useState(false);
  const [bodyScanResult, setBodyScanResult] = useState<BodyScanResult | null>(null);
  const [bodyScanHistory, setBodyScanHistory] = useState<BodyScanEntry[]>([]);
  const [bodyScanPrepSource, setBodyScanPrepSource] = useState<'camera' | 'library' | null>(null);
  const [healthSummary, setHealthSummary] = useState<HealthSummary | null>(null);
  const [sleepHistoryCount, setSleepHistoryCount] = useState<number>(0);
  const [healthEnabled, setHealthEnabled] = useState<boolean>(false);
  const [healthConnecting, setHealthConnecting] = useState<boolean>(false);
  const [healthScore, setHealthScore] = useState<HealthScoreResult | null>(null);
  const [oneRepMaxLifts, setOneRepMaxLifts] = useState<import('../services/api').OneRepMaxLift[]>([]);
  // 1RM history for the top lift — fetched lazily after `oneRepMaxLifts`
  // resolves so the bars render immediately. Used to draw the trend chart
  // below the bar list.
  const [topLiftHistory, setTopLiftHistory] = useState<{ name: string; points: import('../services/api').E1RMHistoryPoint[] } | null>(null);
  const [plateaus, setPlateaus] = useState<import('../services/api').PlateauEntry[]>([]);
  const [plateauModalVisible, setPlateauModalVisible] = useState(false);
  const [plateauDismissed, setPlateauDismissed] = useState(true);
  const [weightEntries, setWeightEntries] = useState<import('../types').WeightEntry[]>([]);
  const [weightInputVisible, setWeightInputVisible] = useState(false);
  const [weightInputValue, setWeightInputValue] = useState('');
  const [weightInputError, setWeightInputError] = useState('');
  const [measurementsModalVisible, setMeasurementsModalVisible] = useState(false);
  const [muscleFatigue, setMuscleFatigue] = useState<{ score: number; label: string; topFatigued: Array<{ muscle: string; value: number }>; muscleFatigue: Record<string, number> } | null>(null);
  const [mealAverages, setMealAverages] = useState<import('../services/api').MealAverages | null>(null);
  // Raw meal history — same payload the meal tab renders. We re-derive
  // the per-day rows in the Facts card from this so the user sees
  // identical numbers across both surfaces (no drift from the backend's
  // separate aggregation path).
  const [mealHistory, setMealHistory] = useState<import('../services/api').MealHistoryEntry[] | null>(null);
  const [muscleBalance, setMuscleBalance] = useState<import('../services/api').MuscleBalanceResult | null>(null);
  const [muscleBalanceExpanded, setMuscleBalanceExpanded] = useState(false);
  const [nutritionGutExpanded, setNutritionGutExpanded] = useState(false);
  const [mealInsightPatterns, setMealInsightPatterns] = useState<Record<string, any> | null>(null);
  const [nutritionScoreWeekly, setNutritionScoreWeekly] = useState<import('../services/api').NutritionScoreWeekly | null>(null);
  const [weekSummaryExpanded, setWeekSummaryExpanded] = useState(false);
  const [proteinBreakdown, setProteinBreakdown] = useState<import('../services/api').ProteinBreakdown | null>(null);
  const [proteinBreakdownExpanded, setProteinBreakdownExpanded] = useState(false);
  const [proteinBreakdownLoading, setProteinBreakdownLoading] = useState(false);
  const [gutInsights, setGutInsights] = useState<{
    plantCount: number;
    plantTier: 'on_track' | 'building' | 'low';
    plantMessage: string;
    fiberToday: { grams: number; target: number; pct: number; message: string };
    proteinFlag: { tier: 'good' | 'watch' | 'flag'; detail: string } | null;
  } | null>(null);
  const [gutHealthWindow, setGutHealthWindow] = useState<import('../services/api').GutHealthWindow | null>(null);
  const [paceHistory, setPaceHistory] = useState<PaceHistoryPoint[]>([]);
  const paceLoadedRef = useRef(false);
  const nutritionRefreshSeenRef = useRef(nutritionLogRefreshKey);
  const [appleHealthZone2Minutes, setAppleHealthZone2Minutes] = useState<number | null>(null);
  const [zone2DetectedWorkouts, setZone2DetectedWorkouts] = useState<Array<{ name: string; durationMin: number; counted: boolean; reason?: string }>>([]);

  // ─── Exercise property lookup maps ────────────────────────────────────────
  // Built from workout history — prefers structured fields from the planner
  // (primaryMuscle, isCompound) over regex heuristics.
  const exerciseMuscleMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of history) {
      for (const e of (s.exercises ?? [])) {
        const nm = e.name?.toLowerCase();
        const pm = e.primaryMuscle ?? (e as any).primary_muscle;
        if (nm && pm && !map[nm]) map[nm] = String(pm).toLowerCase();
      }
    }
    return map;
  }, [history]);

  const exerciseCompoundMap = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const s of history) {
      for (const e of (s.exercises ?? [])) {
        const nm = e.name?.toLowerCase();
        const compound = e.isCompound ?? (e as any).is_compound;
        if (nm && compound != null && !(nm in map)) map[nm] = Boolean(compound);
      }
    }
    return map;
  }, [history]);

  const exerciseTrendMap = useMemo(() => buildExerciseTrendMap(history), [history]);
  const chartablePrsMemo = useMemo(
    () => prs.filter(pr => (exerciseTrendMap[pr.exerciseName.toLowerCase()] ?? []).length >= 2),
    [exerciseTrendMap, prs],
  );
  const activeChartBucket = useMemo(
    () => CHART_MUSCLE_BUCKETS.find(b => b.id === chartMuscleFilter) ?? CHART_MUSCLE_BUCKETS[0],
    [chartMuscleFilter],
  );
  const filteredChartPrs = useMemo(() => chartablePrsMemo.filter(pr => {
    if (chartMuscleFilter === 'all') return true;
    const muscle = exerciseMuscleMap[pr.exerciseName.toLowerCase()] || inferChartMuscleFromName(pr.exerciseName);
    return activeChartBucket.matches(muscle);
  }), [activeChartBucket, chartMuscleFilter, chartablePrsMemo, exerciseMuscleMap]);
  const selectedExerciseTrend = useMemo(
    () => selectedExercise ? (exerciseTrendMap[selectedExercise.toLowerCase()] ?? []) : [],
    [exerciseTrendMap, selectedExercise],
  );
  const cardioInsightsMemo = useMemo(() => buildCardioInsights(paceHistory), [paceHistory]);
  const paceExerciseGroups = useMemo(() => {
    const groups = new Map<string, PaceHistoryPoint[]>();
    for (const point of paceHistory) {
      groups.set(point.exercise, [...(groups.get(point.exercise) ?? []), point]);
    }
    return Array.from(groups.entries()).map(([name, points]) => {
      const distancePoints = points.filter(p => p.distance != null);
      const distances = distancePoints.map(p => p.distance!);
      return {
        name,
        points,
        distancePoints,
        maxDistance: Math.max(...distances, 0.1),
      };
    });
  }, [paceHistory]);
  const cardioBestsMemo = useMemo(() => paceExerciseGroups.map(({ name, points }) => {
    const bestDist = points.reduce((best, p) => p.distance != null && p.distance > (best ?? 0) ? p.distance : best, null as number | null);
    const ptsWithPace = points.filter(p => p.pace);
    const lastPace = ptsWithPace.length > 0 ? ptsWithPace[ptsWithPace.length - 1].pace : null;
    const bestDur = points.reduce((best, p) => p.duration_seconds != null && p.duration_seconds > (best ?? 0) ? p.duration_seconds : best, null as number | null);
    const extraKeys = Array.from(new Set(points.flatMap(p => p.metrics ? Object.keys(p.metrics) : [])));
    const extraBests: Record<string, string> = {};
    extraKeys.forEach(k => {
      const vals = points.filter(p => p.metrics?.[k]).map(p => parseFloat(p.metrics![k])).filter(v => !isNaN(v));
      if (vals.length) extraBests[k] = String(Math.max(...vals));
    });
    return { name, bestDist, lastPace, bestDur, extraBests, sessionCount: points.length };
  }).filter(pr => pr.bestDist != null || pr.lastPace != null || pr.bestDur != null), [paceExerciseGroups]);
  const progressMilestones = useMemo(
    () => buildProgressMilestones(history, prs, summaries, paceHistory, mealAverages, oneRepMaxLifts),
    [history, mealAverages, oneRepMaxLifts, paceHistory, prs, summaries],
  );
  const progressAnalytics = useMemo(
    () => buildProgressAnalytics(history, summaries, prs, plateaus),
    [history, plateaus, prs, summaries],
  );
  const thisWeekOverview = useMemo(
    () => buildThisWeekOverview(history, summaries, prs, weightEntries, paceHistory, mealHistory),
    [history, mealHistory, paceHistory, prs, summaries, weightEntries],
  );
  const mealHistoryDailyRows = useMemo(
    () => (mealHistory == null ? null : aggregateDailyFromHistory(mealHistory as any)),
    [mealHistory],
  );
  const mealMacroHeadline = useMemo(() => {
    if (mealHistoryDailyRows != null) {
      return macrosHeadlineFromDailyRows(mealHistoryDailyRows as any);
    }
    return mealAverages ? macrosHeadlineFromAverages(mealAverages as any) : null;
  }, [mealAverages, mealHistoryDailyRows]);
  const trainingSignals = useMemo(
    () => buildTrainingSignals(history, summaries, isHealthKitAvailable(), healthEnabled),
    [healthEnabled, history, summaries],
  );
  const prFocusOptions = useMemo(
    () => Array.from(new Set(prs.map(p => p.sessionFocus).filter(Boolean))).sort(),
    [prs],
  );
  const filteredPrsForTab = useMemo(() => {
    const q = prSearch.trim().toLowerCase();
    return prs.filter(pr => {
      if (q && !pr.exerciseName.toLowerCase().includes(q)) return false;
      if (prFocusFilter && pr.sessionFocus !== prFocusFilter) return false;
      return true;
    });
  }, [prFocusFilter, prSearch, prs]);

  useEffect(() => {
    if ((tab === 'charts' || tab === 'prs') && authToken && !paceLoadedRef.current) {
      paceLoadedRef.current = true;
      getPaceHistory(authToken).then(r => setPaceHistory(r.points)).catch(() => {});
    }
  }, [tab, authToken]);

  useEffect(() => {
    Promise.all([
      loadWorkoutHistory(),
      loadWorkoutSummaries(),
      loadGoalHistory(),
      loadPlanChanges(),
      authToken ? listWorkoutSessions(authToken, 100).catch(() => null) : Promise.resolve(null),
      authToken ? listWorkoutCompletions(authToken, 100).catch(() => null) : Promise.resolve(null),
    ]).then(([h, s, g, c, serverSessions, completions]) => {
      const historyWithServerSets = mergeWorkoutSessionSources(h, serverSessions);
      const scoped = reconcileWorkoutProgressData(historyWithServerSets, s, completions);
      const p = derivePersonalRecords(scoped.history);
      setPrs(p);
      setHistory(scoped.history);
      setSummaries(scoped.summaries);
      if (completions) {
        AsyncStorage.setItem('workoutHistory', JSON.stringify(scoped.history.slice(0, 100))).catch(() => {});
        AsyncStorage.setItem('workoutSummaries', JSON.stringify(scoped.summaries.slice(0, 100))).catch(() => {});
      }
      console.log(`[Progress] history=${scoped.history.length} completed=${scoped.history.filter((x: any) => x.completed).length} summaries=${scoped.summaries.length} sample_date=${scoped.history[0]?.date ?? 'none'} completions=${completions?.length ?? 'cache'}`);
      setGoalHistory(g);
      setPlanChanges(c);
      setLoading(false);
      if (authToken && isProTier && p.length > 0) {
        getProgressionInsights(authToken, p[0].exerciseName)
          .then((r: any) => setProgressionHint(r?.suggestion ?? ''))
          .catch(() => null);
      }
      import('../utils/weightHistory').then(({ loadWeightHistory }) =>
        Promise.all([
          loadWeightHistory(),
          authToken ? getWeightEntries(authToken).catch(() => null) : Promise.resolve(null),
        ]).then(([local, server]) => {
          const byDate = new Map(local.map(entry => [entry.date, entry] as const));
          for (const row of server ?? []) {
            byDate.set(row.date, {
              date: row.date,
              weightLbs: Math.round(Number(row.weight_lbs) * 10) / 10,
              source: row.source as any,
            });
          }
          const merged = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
          setWeightEntries(merged);
          if (server?.length) {
            AsyncStorage.setItem('weightHistory', JSON.stringify(merged)).catch(() => {});
          }
        }).catch(() => null)
      );
      if (authToken && isProTier) {
        import('../services/api').then(({ getFatigueScore }) => {
          getFatigueScore(authToken).then(fs => setMuscleFatigue({
            score: fs.readiness_score, label: fs.readiness_label,
            topFatigued: fs.top_fatigued ?? [], muscleFatigue: fs.muscle_fatigue ?? {},
          })).catch(() => null);
        });
      }
      if (authToken && isProTier) {
        import('../services/api').then(({ getOneRepMaxShowcase, getE1RMHistory }) =>
          getOneRepMaxShowcase(authToken)
            .then(async (lifts) => {
              setOneRepMaxLifts(lifts);
              // After the bar list resolves, fetch history for the top
              // lift only. Five history calls would saturate the user's
              // network on Progress-tab open; one is invisible. Skipped
              // when the user has < 3 sessions of the top lift since a
              // 1- or 2-point chart isn't a trend.
              const top = lifts.length > 0
                ? lifts.reduce((best, lift) => (lift.oneRepMaxLbs > best.oneRepMaxLbs ? lift : best), lifts[0])
                : null;
              if (top && top.sessionCount >= 3) {
                try {
                  const resp = await getE1RMHistory(authToken, top.name);
                  if (resp?.history && resp.history.length >= 3) {
                    setTopLiftHistory({ name: top.name, points: resp.history });
                  } else {
                    setTopLiftHistory(null);
                  }
                } catch { setTopLiftHistory(null); }
              } else {
                setTopLiftHistory(null);
              }
            })
            .catch(() => setOneRepMaxLifts([]))
        );
        import('../services/api').then(({ getPlateaus }) =>
          getPlateaus(authToken, 4)
            .then(r => {
              setPlateaus(r.plateaus || []);
              AsyncStorage.getItem('plateauDismissedAt').then(raw => {
                if (raw) {
                  const dismissed = Date.now() - parseInt(raw, 10) < 7 * 24 * 60 * 60 * 1000;
                  setPlateauDismissed(dismissed);
                } else {
                  setPlateauDismissed(false);
                }
              }).catch(() => setPlateauDismissed(false));
            })
            .catch(() => setPlateaus([]))
        );
      }
    });
    if (authToken) {
      getInsights(authToken).then(setInsights).catch(() => null);
      getGuardrails(authToken).then(r => setGuardrails(r.warnings ?? [])).catch(() => null);
      if (isProTier) {
        getCoachMemory(authToken).then((rows: any[]) => setCoachMemory(rows.slice(0, 5))).catch(() => null);
      } else {
        setCoachMemory([]);
      }
      import('../services/api').then(({ getMealAverages }) =>
        getMealAverages(authToken, 14).then(setMealAverages).catch(() => null)
      );
      // Pull the same meal history the meal tab uses; the Facts card's
      // dailyRows will re-aggregate from this so both surfaces agree.
      import('../services/api').then(({ getMealHistory }) =>
        getMealHistory(authToken, 14)
          .then(r => setMealHistory(r.meals ?? []))
          .catch(() => setMealHistory(null))
      );
      if (isProTier) {
        import('../services/api').then(({ getMealInsights }) =>
          getMealInsights(authToken)
            .then(r => setMealInsightPatterns(r.patterns ?? null))
            .catch(() => setMealInsightPatterns(null))
        );
        import('../services/api').then(({ getNutritionScore }) =>
          getNutritionScore(authToken, 14)
            .then(r => setNutritionScoreWeekly(r.weekly ?? null))
            .catch(() => setNutritionScoreWeekly(null))
        );
        import('../services/api').then(({ getMuscleBalance }) =>
          getMuscleBalance(authToken, 14).then(setMuscleBalance).catch(() => null)
        );
        import('../services/api').then(({ getGutHealth }) =>
          getGutHealth(authToken, 14).then(r => {
            setGutHealthWindow(r.window);
          }).catch(() => null)
        );
      } else {
        setMealInsightPatterns(null);
        setNutritionScoreWeekly(null);
        setMuscleBalance(null);
        setGutHealthWindow(null);
      }
    }
    if (!isProTier) {
      setBodyScanHistory([]);
    } else {
      AsyncStorage.getItem('bodyScanHistory').then(async raw => {
        const local: BodyScanEntry[] = raw ? (JSON.parse(raw) ?? []) : [];
        // Cap in-memory history at the most recent 20 scans. Older entries
        // stay in storage but aren't loaded into render state — body-scan
        // entries carry full base64 image strings and a long-running user
        // could otherwise keep hundreds of MBs of decoded images in JS heap.
        // The history list UI only ever shows the recent slice anyway.
        const RECENT_CAP = 20;
        const localSorted = [...local].sort((a, b) => b.date.localeCompare(a.date));
        if (localSorted.length > 0) setBodyScanHistory(localSorted.slice(0, RECENT_CAP));
        if (authToken) {
          try {
            const { getBodyScanHistory } = await import('../services/api');
            const remote = await getBodyScanHistory(authToken);
            if (remote.length > 0) {
              const merged = new Map<string, BodyScanEntry>();
              for (const e of local) merged.set(e.date, e);
              for (const e of remote) {
                const key = (e as any).scan_date ?? (e as any).date ?? '';
                if (!merged.has(key)) merged.set(key, { date: key, ...(e as any) });
              }
              const sorted = Array.from(merged.values()).sort((a, b) => b.date.localeCompare(a.date));
              setBodyScanHistory(sorted.slice(0, RECENT_CAP));
              await AsyncStorage.setItem('bodyScanHistory', JSON.stringify(sorted));
            }
          } catch { /* non-fatal */ }
        }
      }).catch(() => {});
    }

    // ── Gut / longevity insights — compute from existing meal data ──
    if (isProTier) (async () => {
      try {
        const today = new Date();
        const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        // Rebuild a 7-day window of plans + checks by date for the diversity counter.
        const plansByDate: Record<string, import('../types').DailyNutritionPlan> = {};
        const checksByDate: Record<string, Record<string, boolean>> = {};
        for (let i = 0; i < 7; i++) {
          const d = new Date(today.getTime() - i * 86400000);
          const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          const raw = await AsyncStorage.getItem(`mealPlan_${k}`);
          if (raw) { try { plansByDate[k] = JSON.parse(raw); } catch {} }
          checksByDate[k] = await getMealChecks(k).catch(() => ({}));
        }
        // Fall back to today's passed-in nutritionPlan if AsyncStorage didn't have it.
        if (!plansByDate[todayKey] && nutritionPlan) plansByDate[todayKey] = nutritionPlan;

        const diversity = computePlantDiversity(plansByDate, checksByDate, 7);
        const fiberTarget = recommendedFiberTarget(
          userProfile.physicalStats?.gender,
          userProfile.physicalStats?.age,
          userProfile.goal,
        );
        const fiber = computeFiberToday(plansByDate[todayKey] ?? null, checksByDate[todayKey] ?? null, fiberTarget);

        const proteinInsights = proteinTimingInsights(plansByDate[todayKey] ?? null);
        const proteinFlag = proteinInsights[0] ? { tier: proteinInsights[0].tier, detail: proteinInsights[0].detail } : null;

        setGutInsights({
          plantCount: diversity.distinctCount,
          plantTier: diversity.tier,
          plantMessage: diversity.message,
          fiberToday: { grams: fiber.grams, target: fiber.target, pct: fiber.pct, message: fiber.message },
          proteinFlag,
        });
      } catch (e) {
        console.warn('[Progress] gut insights failed:', e);
      }
    })();
    else setGutInsights(null);
    // Load Apple Health data — cached value first, then refresh from HealthKit
    // so the vitals row reflects live data without requiring a workout finish.
    if (isProTier) loadHealthSummary().then(setHealthSummary);
    else setHealthSummary(null);
    if (isProTier) loadHealthScore().then(setHealthScore);
    else setHealthScore(null);
    if (isProTier) (async () => {
      try {
        if (!isHealthKitAvailable()) return;
        const enabled = await isAppleHealthEnabled();
        setHealthEnabled(enabled);
        if (!enabled) return;
        // Route through the aggregator so other cards (Zone 2,
        // weekly coaching, readiness) get the same cached value
        // without re-querying HealthKit. Falls back to direct
        // readHealthSummary if the aggregator returns null.
        const age = userProfile.physicalStats?.age ?? null;
        const { getHealthDataSummary } = await import('../services/healthDataSummary');
        const agg = await getHealthDataSummary({ age });
        setAppleHealthZone2Minutes(agg?.weekly?.totalZone2Minutes ?? agg?.zone2Minutes ?? null);
        const fresh = agg?.raw ?? await readHealthSummary({ age: userProfile.physicalStats?.age ?? null });
        if (fresh) {
          setHealthSummary(fresh);
          saveHealthSummary(fresh).catch(() => null);
          // Re-push the fresh sleep score to the watch. Without this,
          // the watch reads only the cached HealthSummary at HomeScreen
          // mount time and never sees the refreshed score Progress just
          // pulled from HealthKit — phone shows a new score, watch stays
          // stuck on the older one.
          try {
            const { pushSleepToWatch, buildWatchSleepPayloadFromSummary } = await import('../utils/watchSync');
            await pushSleepToWatch(buildWatchSleepPayloadFromSummary(fresh as any));
          } catch { /* watch may be unavailable */ }
          const rows = await Promise.all(
            (fresh.workoutDetails ?? []).map((w) => summarizeWorkoutZone2(w, age).catch(() => null)),
          );
          setZone2DetectedWorkouts(rows
            .filter((w): w is NonNullable<typeof w> => !!w)
            .map((w) => ({
              name: w.name,
              durationMin: w.durationMin,
              counted: w.counted,
              reason: w.reason,
            })));
        }
        // Nights of HRV/sleep history drive the "X/14 nights" calibration UI.
        try { setSleepHistoryCount((await loadSleepHistory()).length); } catch {}
      } catch {}
    })();
    else {
      setHealthEnabled(false);
      setAppleHealthZone2Minutes(null);
      setZone2DetectedWorkouts([]);
    }
  }, [authToken, isProTier, nutritionPlan, userProfile.goal, userProfile.mealsPerDay, userProfile.physicalStats?.age, userProfile.physicalStats?.gender]);

  const handleDeletePlanChange = (change: PlanChangeEntry) => {
    if (!change.id) return;
    const scheduled = planChangeIsScheduled(change);
    const canCancel = scheduled
      && !!change.previousProfile
      && !!change.nextProfile
      && !!onCancelScheduledPlanChange
      && planScopeMatches(userProfile, change.nextProfile, change.scope);

    const removeEntry = async () => {
      await deletePlanChange(change.id);
      setPlanChanges(prev => prev.filter(x => x.id !== change.id));
    };

    if (canCancel) {
      Alert.alert(
        'Cancel this request?',
        'This restores your previous settings for the upcoming plan and removes the scheduled request. Your current week stays unchanged.',
        [
          { text: 'Keep', style: 'cancel' },
          {
            text: 'Cancel Request',
            style: 'destructive',
            onPress: async () => {
              try {
                const restored = restorePlanScope(userProfile, change.previousProfile!, change.scope);
                await onCancelScheduledPlanChange!(restored);
                await removeEntry();
              } catch (e: any) {
                Alert.alert('Could not cancel', e?.message ?? 'Try again in a moment.');
              }
            },
          },
        ],
      );
      return;
    }

    Alert.alert(
      scheduled ? 'Remove this request?' : 'Delete this entry?',
      scheduled
        ? 'This removes the row from your history. It cannot safely restore settings because newer profile edits may have superseded it.'
        : 'Removes this plan change from your history. The plan itself stays unchanged.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: removeEntry },
      ],
    );
  };

  useEffect(() => {
    if (nutritionRefreshSeenRef.current === nutritionLogRefreshKey) return;
    nutritionRefreshSeenRef.current = nutritionLogRefreshKey;
    if (!authToken) return;

    let cancelled = false;
    (async () => {
      const api = await import('../services/api');
      const [averages, historyResp] = await Promise.all([
        api.getMealAverages(authToken, 14).catch(() => undefined),
        api.getMealHistory(authToken, 14).catch(() => undefined),
      ]);
      if (cancelled) return;
      if (averages) setMealAverages(averages);
      if (historyResp) setMealHistory(historyResp.meals ?? []);

      if (!isProTier) {
        setMealInsightPatterns(null);
        setNutritionScoreWeekly(null);
        setGutHealthWindow(null);
        return;
      }

      const [insights, score, gut] = await Promise.all([
        api.getMealInsights(authToken).catch(() => undefined),
        api.getNutritionScore(authToken, 14).catch(() => undefined),
        api.getGutHealth(authToken, 14).catch(() => undefined),
      ]);
      if (cancelled) return;
      if (insights) setMealInsightPatterns(insights.patterns ?? null);
      if (score) setNutritionScoreWeekly(score.weekly ?? null);
      if (gut) setGutHealthWindow(gut.window);
    })().catch(() => {});

    return () => { cancelled = true; };
  }, [authToken, isProTier, nutritionLogRefreshKey]);

  const handleShareBodyScan = async () => {
    try {
      const ref = bodyScanShareRef.current as any;
      if (!ref?.capture) return;
      const uri = await ref.capture();
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'Share Body Scan' });
      } else {
        Alert.alert('Saved', 'Screenshot saved to your device.');
      }
    } catch {
      Alert.alert('Error', 'Could not share the body scan.');
    }
  };

  const [sharingScore, setSharingScore] = useState(false);
  const handleShareFitnessScore = async () => {
    try {
      setShareLoading(true);
      setSharingScore(true);
      await new Promise(r => setTimeout(r, 100)); // let logo render
      const ref = fitnessScoreRef.current as any;
      if (!ref?.capture) return;
      const uri = await ref.capture();
      setSharingScore(false);
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'Share Fitness Score' });
      } else {
        Alert.alert('Saved', 'Screenshot saved to your device.');
      }
    } catch {
      Alert.alert('Error', 'Could not share the fitness score.');
    } finally {
      setShareLoading(false);
    }
  };

  const handleBodyScan = async (source: 'camera' | 'library') => {
    // Pro gate — body-fat estimation runs through OpenAI vision and is
    // a paid feature. Surface the upgrade prompt before opening the
    // camera/library so free users don't even take a throwaway photo.
    const { requirePro } = await import('../utils/subscription');
    if (!requirePro(userProfile, 'ai_body_scan')) return;
    try {
      const opts = {
        mediaTypes: 'images' as any,
        base64: true,
        quality: 0.7,
        maxWidth: 1200,
        maxHeight: 1200,
      };
      const result = source === 'camera'
        ? await ImagePicker.launchCameraAsync(opts)
        : await ImagePicker.launchImageLibraryAsync(opts);
      if (result.canceled || !result.assets?.[0]?.base64) return;

      setBodyScanLoading(true);
      setBodyScanResult(null);
      const asset = result.assets[0];
      const stats = userProfile.physicalStats;
      const heightInches = (stats.heightFeet ?? 0) * 12 + (stats.heightInches ?? 0);

      const scanResult = await scanBody(authToken, {
        image_base64: asset.base64!,
        mime_type: 'image/jpeg',
        gender: stats.gender,
        weight_lbs: stats.weightLbs,
        height_inches: heightInches > 0 ? heightInches : undefined,
        age: stats.age,
      });
      setBodyScanResult(scanResult);

      // Save to history
      const entry: BodyScanEntry = {
        id: Date.now().toString(),
        date: new Date().toISOString(),
        photoUri: asset.uri,
        bodyFatPct: scanResult.bodyFatPct,
        bodyFatRange: scanResult.bodyFatRange,
        muscleMass: scanResult.muscleMass,
        category: scanResult.category,
        strengths: scanResult.strengths,
        improvements: scanResult.improvements,
        assessment: scanResult.assessment,
        weightLbs: stats.weightLbs,
      };
      const updated = [entry, ...bodyScanHistory].slice(0, 20);
      setBodyScanHistory(updated);
      await AsyncStorage.setItem('bodyScanHistory', JSON.stringify(updated));
    } catch (e: any) {
      Alert.alert('Scan Failed', e?.message || 'Could not complete the body scan.');
    } finally {
      setBodyScanLoading(false);
    }
  };

  // Legacy per-session top-set aggregation left behind for any
  // remaining references. New strength tracking is the pillar on the
  // main fitness score card (backed by `build_performance_profile`
  // Epley 1RMs and relative-to-bodyweight thresholds).
  const strengthTrend: StrengthPoint[] = [];
  const overallStrength = strengthTrend.length
    ? Math.round(strengthTrend.reduce((sum, p) => sum + p.score, 0) / strengthTrend.length)
    : 0;

  // ── 4-pillar composite fitness score ─────────────────────────────────────
  // Deterministic score computed server-side from the user's
  // performance profile + recent completions + bodyweight + sleep/RPE.
  // See `backend/app/services/workout/fitness_score.py`. The old
  // ad-hoc 5-component score (consistency/trend/volume/variety/duration)
  // was removed because its pillars weren't grounded in anything — a
  // user could hit "100" by logging 20 random exercises without ever
  // getting stronger or doing cardio.
  const [compositeFitness, setCompositeFitness] = useState<import('../services/api').FitnessCompositeScore | null>(null);
  // Track the composite-fitness fetch state so the Records tab can
  // show a skeleton while it's in flight instead of an empty flash.
  const [compositeFitnessLoading, setCompositeFitnessLoading] = useState(true);
  useEffect(() => {
    if (!authToken || !isProTier) {
      setCompositeFitness(null);
      setCompositeFitnessLoading(false);
      return;
    }
    setCompositeFitnessLoading(true);
    import('../services/api').then(({ getFitnessCompositeScore }) =>
      getFitnessCompositeScore(authToken, {
        daysPerWeek: userProfile.daysPerWeek,
        bodyweightLbs: userProfile.physicalStats?.weightLbs,
        recentSleepHours: healthSummary?.lastNightSleepHours ?? undefined,
        avgSessionRpe: undefined,  // TODO wire DayState.session_rpe_avg once plumbed
      })
        .then(setCompositeFitness)
        .catch(() => setCompositeFitness(null))
        .finally(() => setCompositeFitnessLoading(false))
    );
  }, [authToken, isProTier, userProfile?.daysPerWeek, userProfile?.physicalStats?.weightLbs, healthSummary?.lastNightSleepHours, history.length]);

  useEffect(() => {
    if (!authToken || !selectedExercise) { setE1rmHistory([]); return; }
    // Prefer structured primaryMuscle field; fall back to regex heuristic
    const _selMuscle = exerciseMuscleMap[selectedExercise.toLowerCase()];
    if (_selMuscle === 'cardio' || (!_selMuscle && _CARDIO_EXERCISE_RE.test(selectedExercise))) { setE1rmHistory([]); return; }
    import('../services/api').then(({ getE1RMHistory }) =>
      getE1RMHistory(authToken, selectedExercise)
        .then(res => setE1rmHistory(res.history ?? []))
        .catch(() => setE1rmHistory([]))
    );
  }, [authToken, selectedExercise, exerciseMuscleMap]);

  const startWeight = userProfile.goalDetails.startWeightLbs ?? userProfile.physicalStats.weightLbs;
  const currentWeight = userProfile.physicalStats.weightLbs;
  const targetWeight = userProfile.goalDetails.targetWeightLbs;
  const estimate = getGoalEstimate(userProfile, meta.goalConfig);
  const recompProjection = getRecompProjection(userProfile, meta.goalConfig);
  const lostOrGained = Math.abs(currentWeight - startWeight);
  const direction = currentWeight <= startWeight ? 'down' : 'up';
  const remainingLbs = targetWeight != null ? Math.abs(currentWeight - targetWeight) : null;
  return (
    <View style={[styles.container, noHeader && styles.inlineContainer]}>
      {/* Top "← Back / Progress" header is hidden when rendered inline
          as a bottom-tab — the bottom nav handles navigation. */}
      {!noHeader && (
        <View style={styles.header}>
          <TouchableOpacity onPress={onBack} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.backBtn}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Progress</Text>
          <View style={{ width: 60 }} />
        </View>
      )}

      <View style={styles.tabs}>
        {([
          ['health', 'Health'],
          ['body', 'Body'],
          ['prs', 'PRs'],
          ['charts', 'Charts'],
        ] as const).map(([key, label]) => (
          <TouchableOpacity
            key={key}
            activeOpacity={0.7}
            style={[styles.tab, tab === key && styles.tabActive]}
            onPress={() => {
              if (tab === key) return;
              import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
              setTab(key as typeof tab);
            }}>
            <Text style={[styles.tabText, tab === key && styles.tabTextActive]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
      <FadeInView key={tab} duration={260} slideDistance={8} style={{ flex: 1 }}>
      {tab === 'charts' ? (
        <ScrollView contentContainerStyle={styles.content}>
          {prs.length === 0 ? (
            <View style={styles.emptyBox}>
              <Ionicons name="analytics-outline" size={40} color={tc.textMuted} style={{ marginBottom: 8 }} />
              <Text style={styles.emptyTitle}>Complete 3 workouts to see charts</Text>
              <Text style={styles.emptyBody}>Charts appear after your first few sessions with logged sets.</Text>
            </View>
          ) : (
            <>
              <Text style={styles.sectionLabel}>Filter by muscle</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast" contentContainerStyle={{ gap: 8, paddingBottom: 12 }}>
                {CHART_MUSCLE_BUCKETS.map(b => {
                  const active = chartMuscleFilter === b.id;
                  return (
                    <TouchableOpacity
                      key={b.id}
                      style={[styles.exerciseChip, active && styles.exerciseChipActive]}
                      onPress={() => setChartMuscleFilter(b.id)}
                      activeOpacity={0.75}>
                      <Text style={[styles.exerciseChipText, active && styles.exerciseChipTextActive]}>
                        {b.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>

              <Text style={styles.sectionLabel}>Select exercise</Text>
              {filteredChartPrs.length === 0 ? (
                <Text style={{ color: tc.textMuted, fontSize: 12, marginBottom: 12 }}>
                  {chartablePrsMemo.length === 0
                    ? 'Log at least 2 sessions of an exercise to chart its trend.'
                    : `No ${activeChartBucket.label.toLowerCase()} exercises with enough data yet.`}
                </Text>
              ) : (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast" contentContainerStyle={{ gap: 8, paddingBottom: 12 }}>
                  {filteredChartPrs.map((pr, i) => (
                    <TouchableOpacity
                      key={`${pr.exerciseName}-${i}`}
                      style={[styles.exerciseChip, selectedExercise === pr.exerciseName && styles.exerciseChipActive]}
                      onPress={() => setSelectedExercise(pr.exerciseName)}>
                      <Text style={[styles.exerciseChipText, selectedExercise === pr.exerciseName && styles.exerciseChipTextActive]}>
                        {pr.exerciseName}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}

              {topLiftHistory && topLiftHistory.points.length >= 3 && (
                <View style={{ marginTop: 6 }}>
                  <Text style={styles.sectionLabel}>Estimated 1RM Trend</Text>
                  <OneRepMaxTrendCard
                    title={topLiftHistory.name}
                    subtitle="Rolling estimated 1-rep max from logged working sets"
                    points={topLiftHistory.points}
                    tc={tc}
                    styles={styles}
                  />
                </View>
              )}

              {selectedExercise ? (() => {
                const trend = selectedExerciseTrend;
                if (trend.length < 2) {
                  return (
                    <View style={styles.emptyBox}>
                      <Ionicons name="trending-up-outline" size={40} color={tc.textMuted} style={{ marginBottom: 8 }} />
                      <Text style={styles.emptyTitle}>Not enough data</Text>
                      <Text style={styles.emptyBody}>Complete at least 2 sessions with {selectedExercise} to see a trend.</Text>
                    </View>
                  );
                }
                const _selMuscleChart = exerciseMuscleMap[selectedExercise.toLowerCase()];
                const isCardioExercise = _selMuscleChart === 'cardio' || (!_selMuscleChart && _CARDIO_EXERCISE_RE.test(selectedExercise));
                const hasDuration = trend.some(p => p.totalDuration > 0);
                const hasWeight = trend.some(p => p.bestWeight > 0);
                const hasE1rm = e1rmHistory.length >= 2;

                const effectiveMode = chartMode === 'e1rm' && hasE1rm ? 'e1rm'
                  : isCardioExercise && !hasWeight && hasDuration ? 'duration'
                  : chartMode === 'e1rm' ? 'weight'
                  : chartMode;

                if (effectiveMode === 'e1rm') {
                  const e1rmValues = e1rmHistory.map(p => Math.round(p.e1rm_lbs));
                  const e1rmMin = Math.min(...e1rmValues);
                  const e1rmMax = Math.max(...e1rmValues, 1);
                  const chartW = 320;
                  const chartH = 140;
                  const padL = 40;
                  const padR = 16;
                  const padT = 16;
                  const padB = 28;
                  const plotW = chartW - padL - padR;
                  const plotH = chartH - padT - padB;
                  const rangeMin = Math.max(0, e1rmMin - 10);
                  const rangeMax = e1rmMax + 10;
                  const rangeDelta = rangeMax - rangeMin || 1;
                  const pts = e1rmValues.map((v, i) => ({
                    x: padL + (e1rmValues.length > 1 ? (i / (e1rmValues.length - 1)) * plotW : plotW / 2),
                    y: padT + plotH - ((v - rangeMin) / rangeDelta) * plotH,
                    val: v,
                    label: (() => { const d = new Date(e1rmHistory[i].date); return `${d.getMonth() + 1}/${d.getDate()}`; })(),
                    conf: e1rmHistory[i].confidence,
                  }));
                  const polyPoints = pts.map(p => `${p.x},${p.y}`).join(' ');
                  const gridLines = 4;
                  const gridVals = Array.from({ length: gridLines }, (_, i) =>
                    Math.round(rangeMin + (rangeDelta * (i / (gridLines - 1))))
                  );
                  return (
                    <View style={styles.graphCard}>
                      <View style={styles.graphHeader}>
                        <Text style={styles.graphTitle}>{selectedExercise}</Text>
                        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                          {hasWeight && (
                            <TouchableOpacity style={[styles.chartModeBtn]} onPress={() => setChartMode('weight')} activeOpacity={0.75}>
                              <Text style={styles.chartModeBtnText}>Weight</Text>
                            </TouchableOpacity>
                          )}
                          {hasWeight && (
                            <TouchableOpacity style={[styles.chartModeBtn]} onPress={() => setChartMode('volume')} activeOpacity={0.75}>
                              <Text style={styles.chartModeBtnText}>Volume</Text>
                            </TouchableOpacity>
                          )}
                          <TouchableOpacity style={[styles.chartModeBtn, styles.chartModeBtnActive]} onPress={() => {}}>
                            <Text style={[styles.chartModeBtnText, styles.chartModeBtnTextActive]}>Est. 1RM</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                      <Text style={styles.graphSubtitle}>Estimated 1-rep max (lbs) over time</Text>
                      <View style={{ alignItems: 'center', marginVertical: 8 }}>
                        <Svg width={chartW} height={chartH}>
                          {gridVals.map((gv, gi) => {
                            const gy = padT + plotH - ((gv - rangeMin) / rangeDelta) * plotH;
                            return (
                              <Line key={gi} x1={padL} y1={gy} x2={chartW - padR} y2={gy}
                                stroke={tc.border} strokeWidth={1} strokeDasharray="4,4" />
                            );
                          })}
                          {gridVals.map((gv, gi) => {
                            const gy = padT + plotH - ((gv - rangeMin) / rangeDelta) * plotH;
                            return (
                              <SvgText key={`lbl${gi}`} x={padL - 6} y={gy + 4}
                                fontSize={10} fill={tc.textMuted} textAnchor="end">
                                {gv}
                              </SvgText>
                            );
                          })}
                          <Polyline points={polyPoints}
                            fill="none" stroke={tc.primary} strokeWidth={2.5}
                            strokeLinejoin="round" strokeLinecap="round" />
                          {pts.map((p, i) => (
                            <Circle key={i} cx={p.x} cy={p.y}
                              r={i === pts.length - 1 ? 5 : 3.5}
                              fill={i === pts.length - 1 ? tc.accent : tc.primary}
                              stroke={tc.surface} strokeWidth={1.5} />
                          ))}
                          {pts.length <= 12 && pts.map((p, i) => (
                            <SvgText key={`d${i}`} x={p.x} y={chartH - 4}
                              fontSize={9} fill={tc.textMuted} textAnchor="middle">
                              {p.label}
                            </SvgText>
                          ))}
                        </Svg>
                      </View>
                      <View style={styles.chartSummaryRow}>
                        <View style={styles.chartStat}>
                          <Text style={styles.chartStatValue}>{e1rmValues[e1rmValues.length - 1]} lbs</Text>
                          <Text style={styles.chartStatLabel}>Current e1RM</Text>
                        </View>
                        <View style={styles.chartStat}>
                          <Text style={styles.chartStatValue}>{Math.max(...e1rmValues)} lbs</Text>
                          <Text style={styles.chartStatLabel}>Peak e1RM</Text>
                        </View>
                        <View style={styles.chartStat}>
                          <Text style={[styles.chartStatValue, { color: e1rmValues[e1rmValues.length - 1] >= e1rmValues[0] ? tc.primary : tc.error }]}>
                            {e1rmValues[e1rmValues.length - 1] >= e1rmValues[0] ? '+' : ''}{e1rmValues[e1rmValues.length - 1] - e1rmValues[0]} lbs
                          </Text>
                          <Text style={styles.chartStatLabel}>vs first estimate</Text>
                        </View>
                      </View>
                    </View>
                  );
                }

                const values = trend.map(p =>
                  effectiveMode === 'weight' ? p.bestWeight
                    : effectiveMode === 'duration' ? Math.round(p.totalDuration / 60)
                    : Math.round(p.volume)
                );
                const maxVal = Math.max(...values, 1);
                const unit = effectiveMode === 'weight' ? ' lbs' : effectiveMode === 'duration' ? ' min' : '';
                return (
                  <View style={styles.graphCard}>
                    <View style={styles.graphHeader}>
                      <Text style={styles.graphTitle}>{selectedExercise}</Text>
                      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                        {hasWeight && (
                          <TouchableOpacity
                            style={[styles.chartModeBtn, effectiveMode === 'weight' && styles.chartModeBtnActive]}
                            onPress={() => setChartMode('weight')}>
                            <Text style={[styles.chartModeBtnText, effectiveMode === 'weight' && styles.chartModeBtnTextActive]}>Weight</Text>
                          </TouchableOpacity>
                        )}
                        {hasWeight && (
                          <TouchableOpacity
                            style={[styles.chartModeBtn, effectiveMode === 'volume' && styles.chartModeBtnActive]}
                            onPress={() => setChartMode('volume')}>
                            <Text style={[styles.chartModeBtnText, effectiveMode === 'volume' && styles.chartModeBtnTextActive]}>Volume</Text>
                          </TouchableOpacity>
                        )}
                        {hasDuration && (
                          <TouchableOpacity
                            style={[styles.chartModeBtn, effectiveMode === 'duration' && styles.chartModeBtnActive]}
                            onPress={() => setChartMode('duration')}>
                            <Text style={[styles.chartModeBtnText, effectiveMode === 'duration' && styles.chartModeBtnTextActive]}>Duration</Text>
                          </TouchableOpacity>
                        )}
                        {hasE1rm && (
                          <TouchableOpacity
                            style={[styles.chartModeBtn]}
                            onPress={() => setChartMode('e1rm')}>
                            <Text style={styles.chartModeBtnText}>Est. 1RM</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                    <Text style={styles.graphSubtitle}>
                      {effectiveMode === 'weight' ? 'Best set weight (lbs) per session'
                        : effectiveMode === 'duration' ? 'Total duration (min) per session'
                        : 'Total volume (lbs x reps) per session'}
                    </Text>
                    <View style={styles.graphBars}>
                      {trend.map((point, i) => {
                        const val = values[i];
                        const h = Math.max(8, Math.round((val / maxVal) * 100));
                        const isLast = i === trend.length - 1;
                        return (
                          <View key={i} style={styles.graphBarCol}>
                            <Text style={[styles.graphBarValue, isLast && { color: colors.primary }]}>{val}</Text>
                            <AnimatedChartBar
                              targetHeight={h}
                              delay={i * 40}
                              style={[styles.graphBar, isLast && { backgroundColor: colors.accent }]}
                            />
                            <Text style={styles.graphBarLabel}>{point.label}</Text>
                          </View>
                        );
                      })}
                    </View>
                    <View style={styles.chartSummaryRow}>
                      <View style={styles.chartStat}>
                        <Text style={styles.chartStatValue}>{values[values.length - 1]}{unit}</Text>
                        <Text style={styles.chartStatLabel}>Latest</Text>
                      </View>
                      <View style={styles.chartStat}>
                        <Text style={styles.chartStatValue}>{Math.max(...values)}{unit}</Text>
                        <Text style={styles.chartStatLabel}>All-time best</Text>
                      </View>
                      <View style={styles.chartStat}>
                        <Text style={[styles.chartStatValue, { color: values[values.length - 1] >= values[0] ? colors.primary : colors.error }]}>
                          {values[values.length - 1] >= values[0] ? '+' : ''}{values[values.length - 1] - values[0]}{unit}
                        </Text>
                        <Text style={styles.chartStatLabel}>vs first session</Text>
                      </View>
                    </View>
                  </View>
                );
              })() : (
                <View style={styles.emptyBox}>
                  <Text style={styles.emptyBody}>Tap an exercise above to see its progress chart.</Text>
                </View>
              )}

              {cardioInsightsMemo.length > 0 && (
                <View style={{ marginTop: 20 }}>
                  <Text style={styles.sectionLabel}>Cardio Insights</Text>
                  <View style={[styles.graphCard, { gap: 10 }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Ionicons name="pulse-outline" size={17} color={tc.primary} />
                      <Text style={[styles.graphTitle, { flex: 1 }]}>Endurance trend</Text>
                    </View>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                      {cardioInsightsMemo.map(item => (
                        <View key={item.label} style={{ flexGrow: 1, flexBasis: '47%', backgroundColor: tc.surface, borderRadius: 10, borderWidth: 1, borderColor: tc.border, padding: 10 }}>
                          <Text style={{ fontSize: 18, fontWeight: '900', color: tc.textPrimary }}>{item.value}</Text>
                          <Text style={{ fontSize: 10, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.4, textTransform: 'uppercase', marginTop: 2 }}>{item.label}</Text>
                          <Text style={{ fontSize: 11, color: tc.textSecondary, marginTop: 4 }} numberOfLines={2}>{item.detail}</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                </View>
              )}

              {/* ── Cardio Pace Progression ── */}
              {paceHistory.length >= 2 && (
                  <View style={{ marginTop: 20 }}>
                    <Text style={styles.sectionLabel}>Cardio Pace Progression</Text>
                    {paceExerciseGroups.map(({ name: exName, distancePoints: pts, maxDistance: maxDist }) => {
                      if (pts.length < 2) return null;
                      return (
                        <View key={exName} style={[styles.graphCard, { marginBottom: 10 }]}>
                          <Text style={[styles.graphTitle, { marginBottom: 8 }]}>{exName}</Text>
                          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: 80 }}>
                            {pts.map((p, pi) => {
                              const h = Math.max(8, Math.round((p.distance! / maxDist) * 70));
                              const isLast = pi === pts.length - 1;
                              const d = new Date(p.date);
                              return (
                                <View key={pi} style={{ flex: 1, alignItems: 'center' }}>
                                  <Text style={{ fontSize: 9, color: isLast ? tc.primary : tc.textSecondary, fontWeight: '600' }}>
                                    {p.distance!.toFixed(1)}
                                  </Text>
                                  <View style={{ width: '80%', height: h, backgroundColor: isLast ? tc.primary : tc.accent, borderRadius: 4, marginVertical: 2 }} />
                                  <Text style={{ fontSize: 8, color: tc.textMuted }}>{d.getMonth() + 1}/{d.getDate()}</Text>
                                </View>
                              );
                            })}
                          </View>
                          {pts[pts.length - 1]?.pace && (
                            <Text style={{ fontSize: 11, color: tc.textSecondary, marginTop: 6 }}>
                              Latest pace: {pts[pts.length - 1].pace}
                            </Text>
                          )}
                        </View>
                      );
                    })}
                  </View>
              )}
            </>
          )}
        </ScrollView>
      ) : tab === 'prs' ? (
        <ScrollView contentContainerStyle={styles.content} style={!noHeader ? { backgroundColor: tc.background } : undefined}>
          {(insights || guardrails.length > 0 || coachMemory.length > 0) && (
            <View style={styles.insightsCard}>
              <Text style={styles.insightsTitle}>Coach Insights</Text>
              {insights?.adherence && (
                <Text style={styles.insightsLine}>
                  7-day adherence: workouts {insights.adherence.workout_7d_pct}%
                  {insights.adherence.meal_7d_pct != null ? ` · meals ${insights.adherence.meal_7d_pct}%` : ''}
                </Text>
              )}
              {guardrails.map((w, i) => (
                <Text key={i} style={styles.guardrailText}>• {w}</Text>
              ))}
              {coachMemory.map((m, i) => (
                <Text key={i} style={styles.memoryText}>{m.summary}</Text>
              ))}
              {progressionHint ? <Text style={styles.progressionHint}>Progression: {progressionHint}</Text> : null}
            </View>
          )}

          {/* Weight tracking moved to Body Check tab */}

          {plateaus.length > 0 && !plateauDismissed && (
            <View style={{
              marginBottom: 16,
              backgroundColor: tc.surfaceRaised,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: '#F59E0B55',
              padding: 14,
            }}>
              <TouchableOpacity
                onPress={() => setPlateauModalVisible(true)}
                activeOpacity={0.7}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Ionicons name="alert-circle-outline" size={20} color="#F59E0B" />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>
                    {plateaus.length} exercise{plateaus.length === 1 ? '' : 's'} plateaued
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={tc.textMuted} />
              </TouchableOpacity>
              <View style={{ marginTop: 10, gap: 4 }}>
                {plateaus.slice(0, 3).map((p, i) => (
                  <Text key={i} style={{ fontSize: 12, color: tc.textSecondary }}>
                    {p.exercise_name} — flat for {p.weeks_stuck} week{p.weeks_stuck === 1 ? '' : 's'}
                  </Text>
                ))}
                {plateaus.length > 3 && (
                  <Text style={{ fontSize: 11, color: tc.textMuted }}>
                    +{plateaus.length - 3} more
                  </Text>
                )}
              </View>
              {plateaus.some(p => p.suggestion === 'deload') && (
                <Text style={{ fontSize: 12, color: '#F59E0B', marginTop: 8, lineHeight: 17 }}>
                  Consider a deload week — reduce weights by 40% for one week to recover.
                </Text>
              )}
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <TouchableOpacity
                  onPress={() => {
                    AsyncStorage.setItem('plateauDismissedAt', String(Date.now())).catch(() => {});
                    setPlateauDismissed(true);
                  }}
                  style={{
                    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8,
                    borderWidth: 1, borderColor: tc.border, backgroundColor: tc.surface,
                  }}>
                  <Text style={{ fontSize: 12, fontWeight: '600', color: tc.textSecondary }}>Dismiss</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {progressMilestones.length > 0 && (
            <View style={{ marginBottom: 16 }}>
              <Text style={styles.sectionLabel}>Progress Milestones</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {progressMilestones.map(item => (
                  <View
                    key={item.key}
                    testID={`progress-milestone-${item.key}`}
                    accessibilityLabel={`${item.title}: ${item.value}. ${item.detail}`}
                    style={{
                      flexGrow: 1,
                      flexBasis: '47%',
                      minHeight: 112,
                      backgroundColor: tc.surfaceRaised,
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor: tc.border,
                      padding: 12,
                    }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <View style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: item.color + '20' }}>
                        <Ionicons name={item.icon} size={16} color={item.color} />
                      </View>
                      <Text style={{ flex: 1, fontSize: 11, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.3, textTransform: 'uppercase' }} numberOfLines={2}>
                        {item.title}
                      </Text>
                    </View>
                    <Text style={{ fontSize: 22, fontWeight: '900', color: tc.textPrimary }}>{item.value}</Text>
                    <Text style={{ fontSize: 11, color: tc.textSecondary, marginTop: 4, lineHeight: 15 }} numberOfLines={2}>
                      {item.detail}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          {progressAnalytics.length > 0 && (
            <View style={{ marginBottom: 16 }}>
              <Text style={styles.sectionLabel}>Trend Summary</Text>
              <View style={{ backgroundColor: tc.surfaceRaised, borderRadius: 12, borderWidth: 1, borderColor: tc.border, padding: 14, gap: 12 }}>
                {progressAnalytics.map(item => (
                  <View key={item.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <View style={{ width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: item.color + '1F' }}>
                      <Ionicons name={item.icon} size={16} color={item.color} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 12, fontWeight: '800', color: tc.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                        {item.label}
                      </Text>
                      <Text style={{ fontSize: 12, color: tc.textSecondary, marginTop: 2, lineHeight: 16 }}>
                        {item.detail}
                      </Text>
                    </View>
                    <Text style={{ fontSize: 19, fontWeight: '900', color: item.color }}>{item.value}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          <View style={{ marginBottom: 16 }}>
            <Text style={styles.sectionLabel}>Training Signals</Text>
            <View style={{ backgroundColor: tc.surfaceRaised, borderRadius: 12, borderWidth: 1, borderColor: tc.border, padding: 14, gap: 12 }}>
              {trainingSignals.map(item => (
                <View key={item.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: item.color + '1F' }}>
                    <Ionicons name={item.icon} size={16} color={item.color} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 12, fontWeight: '800', color: tc.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                      {item.label}
                    </Text>
                    <Text style={{ fontSize: 12, color: tc.textSecondary, marginTop: 2, lineHeight: 16 }}>
                      {item.detail}
                    </Text>
                  </View>
                  <Text style={{ fontSize: 16, fontWeight: '900', color: item.color, textAlign: 'right', maxWidth: 92 }} numberOfLines={2}>
                    {item.value}
                  </Text>
                </View>
              ))}
            </View>
          </View>

          {/* Cardio PRs — best distance, pace, and output per exercise type */}
          {cardioBestsMemo.length > 0 && (
              <View style={{ marginBottom: 16 }}>
                <Text style={styles.sectionLabel}>Cardio Bests</Text>
                <View style={{ backgroundColor: tc.surfaceRaised, borderRadius: 12, borderWidth: 1, borderColor: tc.border, padding: 14, gap: 12 }}>
                  {cardioBestsMemo.map(pr => (
                    <View key={pr.name}>
                      <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary, marginBottom: 4 }}>{pr.name}</Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                        {pr.bestDist != null && (
                          <View style={{ backgroundColor: tc.surface, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }}>
                            <Text style={{ fontSize: 16, fontWeight: '800', color: tc.textPrimary }}>{pr.bestDist.toFixed(1)}</Text>
                            <Text style={{ fontSize: 9, color: tc.textMuted, fontWeight: '700', letterSpacing: 0.3 }}>BEST DIST</Text>
                          </View>
                        )}
                        {pr.lastPace && (
                          <View style={{ backgroundColor: tc.surface, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }}>
                            <Text style={{ fontSize: 16, fontWeight: '800', color: tc.textPrimary }}>{pr.lastPace}</Text>
                            <Text style={{ fontSize: 9, color: tc.textMuted, fontWeight: '700', letterSpacing: 0.3 }}>LAST PACE</Text>
                          </View>
                        )}
                        {pr.bestDur != null && (
                          <View style={{ backgroundColor: tc.surface, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }}>
                            <Text style={{ fontSize: 16, fontWeight: '800', color: tc.textPrimary }}>
                              {pr.bestDur >= 3600
                                ? `${Math.floor(pr.bestDur / 3600)}h ${Math.floor((pr.bestDur % 3600) / 60)}m`
                                : `${Math.floor(pr.bestDur / 60)}m`}
                            </Text>
                            <Text style={{ fontSize: 9, color: tc.textMuted, fontWeight: '700', letterSpacing: 0.3 }}>BEST DUR</Text>
                          </View>
                        )}
                        {Object.entries(pr.extraBests).slice(0, 2).map(([k, v]) => (
                          <View key={k} style={{ backgroundColor: tc.surface, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }}>
                            <Text style={{ fontSize: 16, fontWeight: '800', color: tc.textPrimary }}>{v}</Text>
                            <Text style={{ fontSize: 9, color: tc.textMuted, fontWeight: '700', letterSpacing: 0.3 }}>{k.toUpperCase()}</Text>
                          </View>
                        ))}
                      </View>
                      <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 4 }}>{pr.sessionCount} session{pr.sessionCount !== 1 ? 's' : ''} logged</Text>
                    </View>
                  ))}
                </View>
              </View>
          )}

          {/* Estimated 1RM showcase — deterministic Epley estimates
              from recent logged sessions for the main compound lifts.
              Hidden when the user has no recent compound-lift data. */}
          {oneRepMaxLifts.length > 0 && (
            <View style={{ marginBottom: 16 }}>
              <Text style={styles.sectionLabel}>Estimated 1 Rep Max</Text>
              {(() => {
                const maxOneRepMax = Math.max(...oneRepMaxLifts.map(lift => lift.oneRepMaxLbs), 1);
                return (
                  <View style={{
                    backgroundColor: tc.surfaceRaised,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: tc.border,
                    padding: 14,
                    gap: 10,
                  }}>
                    {oneRepMaxLifts.map(lift => {
                      const fillPct = Math.max(0.18, lift.oneRepMaxLbs / maxOneRepMax);
                      return (
                        <View key={lift.slug} style={{ gap: 6 }}>
                          <View style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 12,
                          }}>
                            <View style={{ flex: 1 }}>
                              <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }}>
                                {lift.name}
                              </Text>
                              <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }}>
                                Top set: {lift.topWeightLbs} lb × {lift.topReps}
                                {' · '}{lift.sessionCount} session{lift.sessionCount !== 1 ? 's' : ''}
                              </Text>
                            </View>
                            <View style={{ alignItems: 'flex-end' }}>
                              <Text style={{ fontSize: 20, fontWeight: '900', color: tc.textPrimary, fontVariant: ['tabular-nums'] as any }}>
                                {Math.round(lift.oneRepMaxLbs)}
                              </Text>
                              <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: -2 }}>lb 1RM</Text>
                            </View>
                          </View>
                          <View style={{
                            height: 10,
                            borderRadius: 999,
                            backgroundColor: tc.surface,
                            overflow: 'hidden',
                          }}>
                            <View style={{
                              width: `${Math.round(fillPct * 100)}%`,
                              height: '100%',
                              borderRadius: 999,
                              backgroundColor: tc.primary,
                            }} />
                          </View>
                        </View>
                      );
                    })}
                    <Text style={{ fontSize: 10, color: tc.textMuted, fontStyle: 'italic', marginTop: 2 }}>
                      Epley estimates from your recent logged sets. Gets sharper as you log more sessions.
                    </Text>
                  </View>
                );
              })()}

              {/* 1RM trend chart for the top lift — only renders when there
                  are 3+ data points. Pure SVG sparkline, matches the body-
                  fat timeline pattern below for visual consistency. */}
              {topLiftHistory && topLiftHistory.points.length >= 3 && (
                <View style={{ marginTop: 14 }}>
                  <OneRepMaxTrendCard
                    title={`${topLiftHistory.name} · 1RM trend`}
                    subtitle="Rolling estimated 1-rep max from logged working sets"
                    points={topLiftHistory.points}
                    tc={tc}
                    styles={styles}
                  />
                </View>
              )}
            </View>
          )}

          {prs.length === 0 ? (
            <View style={styles.emptyBox}>
              <Ionicons name="trophy-outline" size={40} color={tc.textMuted} style={{ marginBottom: 8 }} />
              <Text style={styles.emptyTitle}>No PRs yet</Text>
              <Text style={styles.emptyBody}>Complete a workout and log your sets to start tracking personal records.</Text>
            </View>
          ) : (() => {
            return (
              <>
                <TextInput
                  style={styles.prSearchInput}
                  value={prSearch}
                  onChangeText={setPrSearch}
                  placeholder="Search exercises..."
                  placeholderTextColor={tc.textMuted}
                  autoCorrect={false}
                  autoCapitalize="none"
                />
                {prFocusOptions.length > 1 && (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.prFilterRow}>
                    <TouchableOpacity
                      style={[styles.prFilterChip, prFocusFilter === null && styles.prFilterChipActive]}
                      onPress={() => setPrFocusFilter(null)}>
                      <Text style={[styles.prFilterChipText, prFocusFilter === null && styles.prFilterChipTextActive]}>
                        All
                      </Text>
                    </TouchableOpacity>
                    {prFocusOptions.map(focus => {
                      const active = prFocusFilter === focus;
                      return (
                        <TouchableOpacity
                          key={focus}
                          style={[styles.prFilterChip, active && styles.prFilterChipActive]}
                          onPress={() => setPrFocusFilter(active ? null : focus)}>
                          <Text style={[styles.prFilterChipText, active && styles.prFilterChipTextActive]}>
                            {focus}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                )}
                <Text style={styles.sectionLabel}>
                  {filteredPrsForTab.length} of {prs.length} exercises tracked
                </Text>
                {filteredPrsForTab.length === 0 ? (
                  <View style={styles.emptyBox}>
                    <Text style={styles.emptyBody}>No exercises match your search.</Text>
                  </View>
                ) : filteredPrsForTab.map((pr, i) => {
                  // Inline Epley 1RM only for compound lifts. Showing
                  // an estimated 1RM on a 25 lb lateral raise or a
                  // 12 lb cable curl is misleading — Epley breaks
                  // down badly above 10 reps and isolation work
                  // doesn't really map to a "1RM" in any meaningful
                  // way. Prefer the structured isCompound field from
                  // history; fall back to regex heuristic for older
                  // sessions that predate the field.
                  const lower = pr.exerciseName.toLowerCase();
                  const _compoundField = exerciseCompoundMap[lower];
                  const isCompound = _compoundField != null
                    ? _compoundField
                    : (
                      /\b(squat|deadlift|bench|press|row|pull[-\s]?up|chin[-\s]?up|dip|clean|snatch|hip\s*thrust|lunge|good\s*morning)\b/.test(lower)
                      && !/\b(curl|fly|raise|extension|kickback|pulldown|crunch|skullcrusher|crossover|pec\s*deck|leg\s*curl|leg\s*extension)\b/.test(lower)
                    );
                  const est1rm = isCompound && pr.weightLbs > 0 && pr.reps > 0 && pr.reps <= 12
                    ? Math.round(pr.weightLbs * (1 + pr.reps / 30))
                    : null;
                  return (
                    <FadeInView key={i} delay={Math.min(i * 35, 350)} duration={260} slideDistance={6}>
                    <View style={styles.prCard}>
                      <View style={styles.prLeft}>
                        <Text style={styles.prName}>{pr.exerciseName}</Text>
                        <Text style={styles.prMeta}>{pr.sessionFocus}  ·  {formatDate(pr.date)}</Text>
                        {est1rm != null && (
                          <Text style={[styles.prMeta, { marginTop: 2, fontWeight: '600', color: tc.textPrimary }]}>
                            ~{est1rm} lb est 1RM
                          </Text>
                        )}
                      </View>
                      <View style={styles.prRight}>
                        <Text style={styles.prWeight}>{pr.weightLbs}</Text>
                        <Text style={styles.prUnit}>lbs</Text>
                        <Text style={styles.prReps}>{pr.reps} reps</Text>
                      </View>
                    </View>
                    </FadeInView>
                  );
                })}
              </>
            );
          })()}
        </ScrollView>
      ) : (tab as string) === 'history' ? (
        <ScrollView contentContainerStyle={styles.content}>
          {/* Month calendar — standard Sun-Sat grid for current month */}
          {(() => {
            const today = new Date();
            const year = today.getFullYear();
            const month = today.getMonth();
            const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
            const daysInMonth = new Date(year, month + 1, 0).getDate();
            const firstDow = new Date(year, month, 1).getDay(); // 0=Sun

            const toDateKey = (d: string) => {
              if (!d) return '';
              const p = new Date(d);
              if (isNaN(p.getTime())) return d.slice(0, 10);
              return `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, '0')}-${String(p.getDate()).padStart(2, '0')}`;
            };
            const completedDates = new Set([
              ...history.filter(s => s.date && !s.skipped).map(s => toDateKey(s.date)),
              ...summaries.filter(s => s.date).map(s => toDateKey(s.date)),
            ]);
            const skippedDates = new Set(
              history.filter(s => s.skipped && s.date).map(s => toDateKey(s.date))
            );

            // Build grid: 6 rows × 7 cols, empty cells for padding
            const cells: Array<{ day: number; key: string; status: 'done' | 'skipped' | 'rest' | 'future' | 'empty' }> = [];
            for (let i = 0; i < firstDow; i++) cells.push({ day: 0, key: `pad-${i}`, status: 'empty' });
            for (let d = 1; d <= daysInMonth; d++) {
              const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
              const isFuture = d > today.getDate();
              const status = isFuture ? 'future' : completedDates.has(key) ? 'done' : skippedDates.has(key) ? 'skipped' : 'rest';
              cells.push({ day: d, key, status });
            }
            while (cells.length % 7 !== 0) cells.push({ day: 0, key: `pad-end-${cells.length}`, status: 'empty' });

            const rows: typeof cells[] = [];
            for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));

            const doneCount = [...completedDates].filter(k => k.startsWith(`${year}-${String(month + 1).padStart(2, '0')}`)).length;
            const skippedCount = [...skippedDates].filter(k => k.startsWith(`${year}-${String(month + 1).padStart(2, '0')}`)).length;

            return (
              <View style={{ marginBottom: 16, backgroundColor: tc.surface, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: tc.border }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <Text style={{ fontSize: 16, fontWeight: '700', color: tc.textPrimary }}>{monthNames[month]} {year}</Text>
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    {doneCount > 0 && <Text style={{ fontSize: 12, color: tc.primary, fontWeight: '600' }}>{doneCount} done</Text>}
                    {skippedCount > 0 && <Text style={{ fontSize: 12, color: '#F59E0B', fontWeight: '600' }}>{skippedCount} skipped</Text>}
                  </View>
                </View>
                {/* Day headers */}
                <View style={{ flexDirection: 'row', marginBottom: 6 }}>
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                    <Text key={d} style={{ flex: 1, textAlign: 'center', fontSize: 11, fontWeight: '600', color: tc.textMuted }}>{d}</Text>
                  ))}
                </View>
                {/* Calendar grid — rows stagger in */}
                {rows.map((row, ri) => (
                  <FadeInView key={ri} delay={ri * 40} style={{ flexDirection: 'row', marginBottom: 4 }}>
                    {row.map(cell => {
                      const isToday = cell.day === today.getDate() && cell.status !== 'empty';
                      return (
                        <View key={cell.key} style={{ flex: 1, alignItems: 'center', paddingVertical: 4 }}>
                          {cell.status === 'empty' ? (
                            <View style={{ width: 32, height: 32 }} />
                          ) : (
                            <View style={{
                              width: 32, height: 32, borderRadius: 16,
                              alignItems: 'center', justifyContent: 'center',
                              backgroundColor:
                                cell.status === 'done' ? tc.primary :
                                cell.status === 'skipped' ? '#F59E0B' + '33' :
                                cell.status === 'future' ? 'transparent' :
                                'transparent',
                              borderWidth: isToday ? 2 : 0,
                              borderColor: isToday ? tc.primary : 'transparent',
                            }}>
                              <Text style={{
                                fontSize: 13, fontWeight: isToday ? '800' : cell.status === 'done' ? '700' : '400',
                                color: cell.status === 'done' ? getContrastingTextColor(tc.primary)
                                  : cell.status === 'skipped' ? '#F59E0B'
                                  : cell.status === 'future' ? tc.textMuted + '55'
                                  : tc.textSecondary,
                              }}>{cell.day}</Text>
                            </View>
                          )}
                        </View>
                      );
                    })}
                  </FadeInView>
                ))}
              </View>
            );
          })()}

          {history.length === 0 ? (
            <View style={styles.emptyBox}>
              <Ionicons name="calendar-outline" size={40} color={tc.textMuted} style={{ marginBottom: 8 }} />
              <Text style={styles.emptyTitle}>No workouts yet</Text>
              <Text style={styles.emptyBody}>Start from Workouts {'->'} Plan or log a custom activity. Your calendar, streak, and session details will appear here.</Text>
            </View>
          ) : (
            <>
              {/* Weekly summary strip */}
              {(() => {
                const now = new Date();
                const dow = now.getDay();
                const mondayOffset = dow === 0 ? -6 : 1 - dow;
                const monday = new Date(now);
                monday.setDate(now.getDate() + mondayOffset);
                monday.setHours(0, 0, 0, 0);
                const thisWeek = history.filter(s => {
                  if (!s.date || s.skipped) return false;
                  const d = new Date(s.date);
                  return d >= monday;
                });
                const totalMin = Math.round(thisWeek.reduce((s, w) => s + (w.durationSeconds || 0), 0) / 60);
                const avgMin = thisWeek.length > 0 ? Math.round(totalMin / thisWeek.length) : 0;
                // Compute streak from consecutive days with workouts (history + summaries, matching HomeScreen)
                const toStreakKey = (d: string) => {
                  const p = new Date(d);
                  if (isNaN(p.getTime())) return d.slice(0, 10);
                  return `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, '0')}-${String(p.getDate()).padStart(2, '0')}`;
                };
                const allDoneDates = new Set([
                  ...history.filter(s => s.date && !s.skipped).map(s => toStreakKey(s.date)),
                  ...summaries.filter(s => s.date).map(s => toStreakKey(s.date)),
                ]);
                let streak = 0;
                const checkDate = new Date();
                const todayStr = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, '0')}-${String(checkDate.getDate()).padStart(2, '0')}`;
                if (!allDoneDates.has(todayStr)) checkDate.setDate(checkDate.getDate() - 1);
                for (let j = 0; j < 90; j++) {
                  const ck = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, '0')}-${String(checkDate.getDate()).padStart(2, '0')}`;
                  if (allDoneDates.has(ck)) { streak++; checkDate.setDate(checkDate.getDate() - 1); }
                  else break;
                }

                const focuses = thisWeek.map(s => s.focus || '').filter(Boolean);
                const focusCounts: Record<string, number> = {};
                focuses.forEach(f => { focusCounts[f] = (focusCounts[f] || 0) + 1; });
                const focusSummary = Object.entries(focusCounts).sort((a, b) => b[1] - a[1]).map(([f, c]) => `${f} ×${c}`).join(', ');

                return (
                  <FadeInView delay={0}>
                  <TouchableOpacity
                    activeOpacity={0.7}
                    onPress={() => { configureExpandAnimation(300); setWeekSummaryExpanded(prev => !prev); }}
                  >
                  <View style={{ backgroundColor: tc.primary + '12', borderRadius: 10, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: tc.primary + '22' }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: tc.primary, flexShrink: 1 }}>
                        This week: {thisWeek.length} workout{thisWeek.length !== 1 ? 's' : ''} · avg {avgMin} min
                      </Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        {streak > 0 && <StreakCounter count={streak} color={tc.primary} />}
                        <Ionicons name={weekSummaryExpanded ? 'chevron-up' : 'chevron-down'} size={14} color={tc.primary} />
                      </View>
                    </View>
                    {weekSummaryExpanded && (
                      <View style={{ marginTop: 10, gap: 6 }}>
                        <View style={{ flexDirection: 'row', gap: 12 }}>
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 10, fontWeight: '600', color: tc.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Total time</Text>
                            <Text style={{ fontSize: 15, fontWeight: '700', color: tc.textPrimary }}>{totalMin} min</Text>
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 10, fontWeight: '600', color: tc.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Sessions</Text>
                            <Text style={{ fontSize: 15, fontWeight: '700', color: tc.textPrimary }}>{thisWeek.length}</Text>
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 10, fontWeight: '600', color: tc.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Streak</Text>
                            <Text style={{ fontSize: 15, fontWeight: '700', color: tc.textPrimary }}>{streak} day{streak !== 1 ? 's' : ''}</Text>
                          </View>
                        </View>
                        {focusSummary.length > 0 && (
                          <Text style={{ fontSize: 11, color: tc.textSecondary, marginTop: 2 }}>
                            {focusSummary}
                          </Text>
                        )}
                      </View>
                    )}
                  </View>
                  </TouchableOpacity>
                  </FadeInView>
                );
              })()}

              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <Text style={styles.sectionLabel}>
                  {history.length} workout{history.length !== 1 ? 's' : ''}
                  {history.length > 30 ? ' · most recent 30' : ''}
                </Text>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <TouchableOpacity
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border }}
                    onPress={async () => {
                      try {
                        const { exportWorkoutHistory } = await import('../utils/dataExport');
                        const uname = await AsyncStorage.getItem('user_username').catch(() => null);
                        await exportWorkoutHistory(uname || undefined);
                      } catch (e: any) { Alert.alert('Export failed', e.message ?? 'Could not export'); }
                    }}>
                    <Ionicons name="share-outline" size={14} color={tc.textSecondary} />
                    <Text style={{ fontSize: 11, fontWeight: '600', color: tc.textSecondary }}>Share</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: tc.primary + '15' }}
                    onPress={() => setShowLogActivity(true)}>
                    <Ionicons name="add-circle-outline" size={16} color={tc.primary} />
                    <Text style={{ fontSize: 12, fontWeight: '700', color: tc.primary }}>Log Activity</Text>
                  </TouchableOpacity>
                </View>
              </View>
              {history.slice(0, 30).map((session, i) => {
                const totalSets = session.exercises.reduce((sum, ex) => sum + ex.sets.length, 0);
                const isExpanded = expandedSessionId === session.id;
                const summary = summaries.find(s => s.date && session.date && s.date.slice(0, 10) === session.date.slice(0, 10) && s.focus === session.focus);
                // Composite key: id + index. HK auto-imports can collide
                // on session.id when the dedup helper sees the same HK
                // workout twice across import attempts; the index makes
                // the key unique even on collision so React stops warning.
                const rowKey = `${session.id ?? 'sess'}-${i}`;
                return (
                  <FadeInView key={rowKey} delay={i * 60}>
                  <TouchableOpacity
                    style={styles.sessionCard}
                    activeOpacity={0.8}
                    onPress={() => { configureExpandAnimation(300); setExpandedSessionId(isExpanded ? null : (session.id ?? `s${i}`)); }}>
                    <View style={styles.sessionHeader}>
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <Text style={styles.sessionFocus}>
                            {session.manualActivity
                              ? `${humanizeToken(session.manualActivity.category)}${session.manualActivity.subtype ? ' · ' + humanizeToken(session.manualActivity.subtype) : ''}${session.manualActivity.intensity ? ' (' + session.manualActivity.intensity + ')' : ''}`
                              : session.focus}
                          </Text>
                          {summary?.totalSets != null && summary.totalSets > 0 && (
                            <View style={{ backgroundColor: tc.primary + '18', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 }}>
                              <Text style={{ fontSize: 9, fontWeight: '700', color: tc.primary }}>
                                {summary.totalSets > 25 ? 'VOLUME' : summary.totalSets < 15 ? 'STRENGTH' : 'HYPERTROPHY'}
                              </Text>
                            </View>
                          )}
                        </View>
                        <Text style={styles.sessionDate}>{formatDate(session.date)}</Text>
                      </View>
                      <View style={styles.sessionBadge}>
                        <Text style={styles.sessionBadgeText}>{formatDuration(session.durationSeconds)}</Text>
                      </View>
                      {session.id && (
                        <TouchableOpacity
                          onPress={(e) => {
                            // Stop the row's expand toggle from firing
                            // when the user taps the delete glyph.
                            e.stopPropagation?.();
                            Alert.alert(
                              'Delete this workout?',
                              'Removes this workout from your history (sets + summary + backend record). This affects your fatigue and weekly volume calculations. Cannot be undone.',
                              [
                                { text: 'Cancel', style: 'cancel' },
                                { text: 'Delete', style: 'destructive', onPress: async () => {
                                  try {
                                    await deleteWorkoutSession(session.id!);
                                    await deleteWorkoutSummary(session.id!).catch(() => null);
                                    if (authToken && session.date) {
                                      const dateISO = session.date.slice(0, 10);
                                      const { deleteWorkoutCompletion } = await import('../services/api');
                                      await deleteWorkoutCompletion(authToken, dateISO).catch(() => null);
                                    }
                                    setHistory(prev => prev.filter(x => x.id !== session.id));
                                    setSummaries(prev => prev.filter(x => x.id !== session.id));
                                    import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
                                  } catch (err: any) {
                                    Alert.alert('Could not delete', String(err?.message ?? err));
                                  }
                                }},
                              ],
                            );
                          }}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          style={{ paddingHorizontal: 8, paddingVertical: 4, marginLeft: 6 }}>
                          <Text style={{ fontSize: 16, color: tc.textMuted, fontWeight: '600' }}>✕</Text>
                        </TouchableOpacity>
                      )}
                      <Ionicons name={isExpanded ? 'chevron-down' : 'chevron-forward'} size={14} color={tc.textMuted} style={{ marginLeft: 6 }} />
                    </View>
                    <View style={styles.sessionStats}>
                      <Text style={styles.sessionStat}>{session.exercises.length} exercises</Text>
                      <Text style={styles.sessionStatDot}>·</Text>
                      <Text style={styles.sessionStat}>{totalSets} sets</Text>
                      {summary && (
                        <>
                          <Text style={styles.sessionStatDot}>·</Text>
                          <Text style={styles.sessionStat}>~{summary.caloriesBurned} kcal</Text>
                        </>
                      )}
                    </View>

                    {isExpanded && (
                      <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: tc.border }}>
                        {session.exercises.filter(ex => ex.sets.length > 0).map((ex, ei) => {
                          const best = ex.sets.reduce((b, s) => s.weightLbs > b.weightLbs ? s : b, ex.sets[0]);
                          return (
                            <View key={ei} style={styles.exRow}>
                              <Text style={styles.exName}>{ex.name}</Text>
                              <Text style={styles.exBest}>{best.weightLbs} lbs × {best.reps}</Text>
                            </View>
                          );
                        })}
                        {summary && (
                          <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: tc.border }}>
                            {/* HR annotation from Apple Watch (captured at
                                finish time). Same circle viz as the active
                                summary so users see consistent zone data
                                whether they're looking at the just-finished
                                workout or a past one. */}
                            {(summary.hrAvg || summary.hrMax || (summary.hrZoneMinutes && summary.hrZoneMinutes.some(m => m > 0))) && (
                              <View style={{ marginBottom: 10 }}>
                                <View style={{ flexDirection: 'row', gap: 12, marginBottom: 8 }}>
                                  {summary.hrAvg ? (
                                    <View style={{ flex: 1, alignItems: 'center', padding: 6, borderRadius: 8, backgroundColor: tc.surfaceRaised }}>
                                      <Text style={{ fontSize: 15, fontWeight: '800', color: tc.textPrimary }}>{summary.hrAvg}</Text>
                                      <Text style={{ fontSize: 9, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5 }}>AVG HR</Text>
                                    </View>
                                  ) : null}
                                  {summary.hrMax ? (
                                    <View style={{ flex: 1, alignItems: 'center', padding: 6, borderRadius: 8, backgroundColor: tc.surfaceRaised }}>
                                      <Text style={{ fontSize: 15, fontWeight: '800', color: tc.textPrimary }}>{summary.hrMax}</Text>
                                      <Text style={{ fontSize: 9, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5 }}>MAX HR</Text>
                                    </View>
                                  ) : null}
                                </View>
                                {summary.hrZoneMinutes && summary.hrZoneMinutes.some(m => m > 0) && (
                                  <View style={{ flexDirection: 'row', justifyContent: 'space-around', alignItems: 'flex-end', marginTop: 4 }}>
                                    {(['Z1', 'Z2', 'Z3', 'Z4', 'Z5'] as const).map((label, i) => {
                                      const min = summary.hrZoneMinutes![i];
                                      const peak = Math.max(...summary.hrZoneMinutes!, 1);
                                      const size = 32 + Math.round(18 * (min / peak));
                                      const zoneColor = ['#22C55E', '#EAB308', tc.primary, '#F97316', '#EF4444'][i];
                                      const isEmpty = min < 0.5;
                                      return (
                                        <View key={label} style={{ alignItems: 'center' }}>
                                          <View style={{
                                            width: size, height: size, borderRadius: size / 2,
                                            borderWidth: 2,
                                            borderColor: isEmpty ? tc.border : zoneColor,
                                            backgroundColor: isEmpty ? 'transparent' : zoneColor + '22',
                                            alignItems: 'center', justifyContent: 'center',
                                          }}>
                                            <Text style={{ fontSize: 11, fontWeight: '800', color: isEmpty ? tc.textMuted : zoneColor }}>
                                              {Math.round(min)}
                                            </Text>
                                          </View>
                                          <Text style={{ fontSize: 9, fontWeight: '800', color: isEmpty ? tc.textMuted : zoneColor, marginTop: 3, letterSpacing: 0.5 }}>
                                            {label}
                                          </Text>
                                        </View>
                                      );
                                    })}
                                  </View>
                                )}
                              </View>
                            )}
                            {summary.motivationMessage ? (
                              <Text style={{ fontSize: 13, color: tc.textSecondary, lineHeight: 19, marginBottom: 6 }}>{summary.motivationMessage}</Text>
                            ) : null}
                            {summary.achievements?.length > 0 && (
                              <View style={{ gap: 2, marginBottom: 6 }}>
                                {summary.achievements.map((a: string, ai: number) => (
                                  <Text key={ai} style={{ fontSize: 12, color: tc.primary }}>★ {a}</Text>
                                ))}
                              </View>
                            )}
                            {summary.feedback && (
                              <Text style={{ fontSize: 12, color: tc.textMuted }}>
                                Felt {summary.feedback.feeling} · intensity {summary.feedback.intensity}/5
                                {summary.feedback.sorenessAreas?.length ? ` · sore: ${summary.feedback.sorenessAreas.join(', ')}` : ''}
                              </Text>
                            )}
                          </View>
                        )}
                      </View>
                    )}
                  </TouchableOpacity>
                  </FadeInView>
                );
              })}
            </>
          )}
        </ScrollView>
      ) : false ? (
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.sectionLabel}>Goal History</Text>
          {goalHistory.filter(entry => {
            if (!entry.endedAt) return true; // still active
            const s = new Date(entry.startedAt);
            const e = new Date(entry.endedAt);
            return s.getFullYear() !== e.getFullYear() || s.getMonth() !== e.getMonth() || s.getDate() !== e.getDate();
          }).length === 0 ? (
            <View style={[styles.emptyBox, { marginBottom: 16 }]}>
              <Text style={styles.emptyBody}>No goal changes recorded yet. Switch goals to start tracking.</Text>
            </View>
          ) : goalHistory.filter(entry => {
            if (!entry.endedAt) return true;
            const s = new Date(entry.startedAt);
            const e = new Date(entry.endedAt);
            return s.getFullYear() !== e.getFullYear() || s.getMonth() !== e.getMonth() || s.getDate() !== e.getDate();
          }).map((entry, i, arr) => {
            const goalKey = `${entry.id ?? 'goal'}-${i}`;
            // Goal label preference: registered meta label → humanized
            // fallback (e.g. "body_recomp" → "Body Recomp"). Previously
            // the fallback was the raw enum value, so any goal not in
            // the meta registry rendered as snake_case in the history list.
            const goalLabel = meta.goals.find(g => g.value === entry.goal)?.label ?? humanizeToken(entry.goal);
            const start = new Date(entry.startedAt);
            const end = entry.endedAt ? new Date(entry.endedAt) : null;
            const days = end
              ? Math.round((end.getTime() - start.getTime()) / 86400000)
              : Math.round((Date.now() - start.getTime()) / 86400000);
            return (
              <View key={goalKey} style={[styles.sessionCard, { marginBottom: 8 }]}>
                <View style={styles.sessionHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.sessionFocus}>{goalLabel}</Text>
                    <Text style={styles.sessionDate}>
                      {`${MONTH_NAMES[start.getMonth()]} ${start.getDate()}, ${start.getFullYear()}`}
                      {end ? ` → ${MONTH_NAMES[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}` : ' → now'}
                    </Text>
                  </View>
                  <View style={styles.sessionBadge}>
                    <Text style={styles.sessionBadgeText}>{days}d</Text>
                  </View>
                </View>
                <View style={styles.sessionStats}>
                  <Text style={styles.sessionStat}>Pace: {humanizeToken(entry.pace)}</Text>
                  {entry.startWeightLbs ? (
                    <>
                      <Text style={styles.sessionStatDot}>·</Text>
                      <Text style={styles.sessionStat}>Started at {entry.startWeightLbs} lbs</Text>
                    </>
                  ) : null}
                </View>
              </View>
            );
          })}

          {/* Workout Summaries — paginated. We dedupe by (date,
              focus) at render time because `saveWorkoutSummary` only
              dedupes by id, so re-saves with new IDs (timing race on
              finish, two-device sync) used to surface as visible
              duplicates. The most-recent entry (first in the array
              since unshift) wins.

              `visibleSummaryCount` drives a "Load more" button so
              users with long histories can dig back without paying
              the render cost on the initial mount. */}
          {(() => {
            const seen = new Set<string>();
            const dedupedSummaries = summaries.filter(s => {
              const dateKey = (s.date || '').slice(0, 10);
              const focusKey = (s.focus || '').toLowerCase().trim();
              const key = `${dateKey}::${focusKey}`;
              if (!dateKey || !focusKey) return true;  // can't dedupe → keep
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            const dropped = summaries.length - dedupedSummaries.length;
            const visible = dedupedSummaries.slice(0, visibleSummaryCount);
            const remaining = dedupedSummaries.length - visible.length;
            return (
              <>
                <Text style={[styles.sectionLabel, { marginTop: 16 }]}>
                  Workout Summaries
                  {dedupedSummaries.length > 0
                    ? ` · ${visible.length} of ${dedupedSummaries.length}`
                    : ''}
                  {dropped > 0 ? ` (${dropped} duplicate${dropped === 1 ? '' : 's'} hidden)` : ''}
                </Text>
                {dedupedSummaries.length === 0 ? (
                  <View style={styles.emptyBox}>
                    <Ionicons name="trophy-outline" size={40} color={tc.textMuted} />
                    <Text style={styles.emptyTitle}>No summaries yet</Text>
                    <Text style={styles.emptyBody}>Complete a workout to see your AI-generated summary here.</Text>
                  </View>
                ) : (<>
                {visible.map((s, i) => (
            <View key={`${s.id ?? 'sum'}-${i}`} style={[styles.sessionCard, { gap: 8 }]}>
              <View style={styles.sessionHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.sessionFocus}>{s.focus}</Text>
                  <Text style={styles.sessionDate}>
                    {formatDate(s.date)}
                    {s.startedAt && s.endedAt
                      ? ` · ${new Date(s.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} – ${new Date(s.endedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                      : ''}
                  </Text>
                </View>
                <View style={styles.sessionBadge}>
                  <Text style={styles.sessionBadgeText}>{formatDuration(s.durationSeconds)}</Text>
                </View>
                {s.id && (
                  <TouchableOpacity
                    onPress={() => {
                      Alert.alert(
                        'Delete this workout?',
                        'Removes this workout from your history (sets + summary + backend record). This affects your fatigue and weekly volume calculations. Cannot be undone.',
                        [
                          { text: 'Cancel', style: 'cancel' },
                          { text: 'Delete', style: 'destructive', onPress: async () => {
                            try {
                              // 1. Local: nuke summary + session.
                              await deleteWorkoutSummary(s.id!);
                              await deleteWorkoutSession(s.id!).catch(() => null);
                              // 2. Backend: nuke the completion row +
                              //    associated session/exercise/set rows.
                              //    Without this the workout would
                              //    re-appear after a sync (server is
                              //    source of truth for fatigue).
                              if (authToken && s.date) {
                                const dateISO = s.date.slice(0, 10);
                                const { deleteWorkoutCompletion } = await import('../services/api');
                                await deleteWorkoutCompletion(authToken, dateISO).catch(() => null);
                              }
                              setSummaries(prev => prev.filter(x => x.id !== s.id));
                              setHistory(prev => prev.filter(x => x.id !== s.id));
                              import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
                            } catch (e: any) {
                              Alert.alert('Could not delete', String(e?.message ?? e));
                            }
                          }},
                        ],
                      );
                    }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={{ paddingHorizontal: 8, paddingVertical: 4, marginLeft: 6 }}>
                    <Text style={{ fontSize: 18, color: tc.textMuted, fontWeight: '600' }}>✕</Text>
                  </TouchableOpacity>
                )}
              </View>
              <View style={styles.sessionStats}>
                <Text style={styles.sessionStat}>{s.totalSets} sets</Text>
                <Text style={styles.sessionStatDot}>·</Text>
                <Text style={styles.sessionStat}>{s.totalReps} reps</Text>
                <Text style={styles.sessionStatDot}>·</Text>
                <Text style={styles.sessionStat}>~{s.caloriesBurned} kcal</Text>
              </View>
              <Text style={{ fontSize: 13, color: tc.textSecondary, lineHeight: 19 }}>{s.motivationMessage}</Text>
              {s.achievements?.length > 0 && (
                <View style={{ gap: 3 }}>
                  {s.achievements.map((a, ai) => (
                    <Text key={ai} style={{ fontSize: 12, color: tc.textMuted }}>• {a}</Text>
                  ))}
                </View>
              )}
              {/* End-of-workout feedback the user filled in on the
                  summary modal. Optional — older summaries predate
                  this field and just don't render the block. */}
              {s.feedback && (
                <View style={{
                  marginTop: 8,
                  paddingTop: 10,
                  borderTopWidth: 1,
                  borderTopColor: tc.border,
                  gap: 4,
                }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                    How it felt
                  </Text>
                  <Text style={{ fontSize: 13, color: tc.textPrimary }}>
                    {s.feedback.feeling} · intensity {s.feedback.intensity}/5
                    {s.feedback.sorenessAreas?.length ? ` · sore: ${s.feedback.sorenessAreas.join(', ')}` : ''}
                  </Text>
                  {s.feedback.notes ? (
                    <Text style={{ fontSize: 12, color: tc.textSecondary, fontStyle: 'italic' }}>
                      "{s.feedback.notes}"
                    </Text>
                  ) : null}
                </View>
              )}
              {/* Full per-exercise detail — exactly what the user
                  did. Only shown for summaries that include the
                  exercises array (all new summaries going forward). */}
              {s.exercises && s.exercises.length > 0 && (
                <View style={{
                  marginTop: 8,
                  paddingTop: 10,
                  borderTopWidth: 1,
                  borderTopColor: tc.border,
                  gap: 8,
                }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                    What you did
                  </Text>
                  {s.exercises.map((sx, xi) => (
                    <View key={xi} style={{ gap: 2 }}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>
                        {sx.name}
                      </Text>
                      {sx.sets.length === 0 ? (
                        <Text style={{ fontSize: 12, color: tc.textMuted }}>no sets logged</Text>
                      ) : (
                        sx.sets.map((set, si) => {
                          const hasDuration = (set as any).durationSeconds != null;
                          const durMin = hasDuration ? Math.floor((set as any).durationSeconds / 60) : 0;
                          const durSec = hasDuration ? (set as any).durationSeconds % 60 : 0;
                          const line = hasDuration
                            ? `Set ${set.setNumber}: ${durMin}:${String(durSec).padStart(2, '0')}`
                            : `Set ${set.setNumber}: ${set.weightLbs} lb × ${set.reps}${set.feedback ? ` · ${set.feedback}` : ''}`;
                          return (
                            <Text key={si} style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 17 }}>
                              {line}
                            </Text>
                          );
                        })
                      )}
                    </View>
                  ))}
                </View>
              )}
            </View>
          ))}
                {remaining > 0 && (
                  <TouchableOpacity
                    onPress={() => setVisibleSummaryCount(c => c + 30)}
                    activeOpacity={0.85}
                    style={{
                      backgroundColor: tc.surface,
                      borderRadius: 12, paddingVertical: 12,
                      borderWidth: 1, borderColor: tc.border,
                      alignItems: 'center', marginTop: 4,
                    }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>
                      Load {Math.min(30, remaining)} more
                    </Text>
                  </TouchableOpacity>
                )}
                </>)}
              </>
            );
          })()}

          {/* Plan Change Requests & History — display cap 20. The full log
              still lives in storage for audit / debug purposes. */}
          <Text style={[styles.sectionLabel, { marginTop: 16 }]}>
            Plan Change Requests & History
            {planChanges.length > 20 ? ` · showing most recent 20 of ${planChanges.length}` : ''}
          </Text>
          {planChanges.length === 0 ? (
            <View style={[styles.emptyBox, { marginBottom: 24 }]}>
              <Ionicons name="clipboard-outline" size={40} color={tc.textMuted} />
              <Text style={styles.emptyTitle}>No plan changes yet</Text>
              <Text style={styles.emptyBody}>Future-dated setting requests and trainer / nutritionist updates will appear here.</Text>
            </View>
          ) : planChanges.slice(0, 20).map((c, i) => {
            const d = new Date(c.changedAt);
            const label = `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
            const isScheduled = planChangeIsScheduled(c);
            const canCancel = isScheduled
              && !!c.previousProfile
              && !!c.nextProfile
              && !!onCancelScheduledPlanChange
              && planScopeMatches(userProfile, c.nextProfile, c.scope);
            // Title varies by author. User-driven entries get a scope
            // tag (Goal / Workout / Meal Plan) so the user can scan
            // their own settings tweaks at a glance.
            const baseSourceLabel = c.changedBy === 'trainer'
              ? 'Trainer Update'
              : c.changedBy === 'nutritionist'
                ? 'Nutritionist Update'
                : c.scope === 'goal'
                  ? 'You · Goal Change'
                  : c.scope === 'workout'
                    ? 'You · Workout Settings'
                    : c.scope === 'mealplan'
                      ? 'You · Meal Plan Settings'
                      : 'You · Settings';
            const sourceLabel = isScheduled
              ? baseSourceLabel.replace('You ·', 'Scheduled ·')
              : baseSourceLabel;
            return (
              <View key={c.id ?? i} style={[styles.sessionCard, { gap: 6, marginBottom: 8 }]}>
                <View style={styles.sessionHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.sessionFocus}>{sourceLabel}</Text>
                    <Text style={styles.sessionDate}>{label}</Text>
                  </View>
                  {c.id && (
                    <TouchableOpacity
                      onPress={() => handleDeletePlanChange(c)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={{
                        paddingHorizontal: isScheduled ? 10 : 8,
                        paddingVertical: 5,
                        marginLeft: 6,
                        borderRadius: 999,
                        borderWidth: isScheduled ? 1 : 0,
                        borderColor: canCancel ? tc.primary + '66' : tc.border,
                        backgroundColor: isScheduled ? tc.surfaceRaised : 'transparent',
                      }}>
                      {isScheduled ? (
                        <Text style={{ fontSize: 12, color: canCancel ? tc.primary : tc.textMuted, fontWeight: '800' }}>
                          {canCancel ? 'Cancel' : 'Remove'}
                        </Text>
                      ) : (
                        <Ionicons name="trash-outline" size={17} color={tc.textMuted} />
                      )}
                    </TouchableOpacity>
                  )}
                </View>
                {/* Coach-driven changes carry the chat that triggered
                    them; user-driven changes don't (they came from a
                    settings save). */}
                {c.changedBy !== 'user' && c.question && (
                  <Text style={{ fontSize: 12, color: tc.textMuted, fontStyle: 'italic', marginBottom: 2 }}>
                    You asked: "{c.question.length > 80 ? c.question.slice(0, 80) + '…' : c.question}"
                  </Text>
                )}
                <Text style={{ fontSize: 13, color: tc.textSecondary, lineHeight: 19 }}>{c.summary}</Text>
                {c.effectiveDate && (
                  <Text style={{ fontSize: 11, color: tc.primary, fontWeight: '700', marginTop: 2 }}>
                    {isScheduled ? 'Scheduled for ' : 'Took effect '}{(() => {
                      const ed = new Date(`${c.effectiveDate}T12:00:00`);
                      return `${MONTH_NAMES[ed.getMonth()]} ${ed.getDate()}, ${ed.getFullYear()}`;
                    })()}
                  </Text>
                )}
              </View>
            );
          })}
        </ScrollView>
      ) : tab === 'health' ? (
        /* ── Health Tab ─────────────────────────────────────────────── */
        <ScrollView contentContainerStyle={styles.content}>
          {thisWeekOverview.length > 0 && (
            <View style={styles.weekOverviewCard}>
              <View style={styles.weekOverviewHeader}>
                <View>
                  <Text style={styles.weekOverviewEyebrow}>THIS WEEK</Text>
                  <Text style={styles.weekOverviewTitle}>What changed</Text>
                </View>
                <Text style={styles.weekOverviewHint}>Tap a tile for detail</Text>
              </View>
              <View style={styles.weekOverviewGrid}>
                {thisWeekOverview.map(item => (
                  <TouchableOpacity
                    key={item.key}
                    testID={`progress-overview-${item.key}`}
                    accessibilityLabel={`${item.label}: ${item.value}. ${item.detail}`}
                    activeOpacity={0.82}
                    style={styles.weekOverviewTile}
                    onPress={() => {
                      import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
                      setTab(item.targetTab);
                    }}>
                    <View style={[styles.weekOverviewIcon, { backgroundColor: item.color + '20' }]}>
                      <Ionicons name={item.icon} size={15} color={item.color} />
                    </View>
                    <Text style={styles.weekOverviewLabel} numberOfLines={1}>{item.label}</Text>
                    <Text style={styles.weekOverviewValue} numberOfLines={1}>{item.value}</Text>
                    <Text style={styles.weekOverviewDetail} numberOfLines={2}>{item.detail}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}
          {!isProTier && (
            <View style={styles.vitalsCard}>
              <View style={{ alignItems: 'center', paddingVertical: 12 }}>
                <Ionicons name="lock-closed-outline" size={32} color={tc.textMuted} />
                <Text style={{ fontSize: 16, fontWeight: '800', color: tc.textPrimary, marginTop: 8 }}>Health insights are Pro</Text>
                <Text style={{ fontSize: 12, color: tc.textSecondary, textAlign: 'center', lineHeight: 18, marginTop: 6 }}>
                  Free keeps manual weight, body, workout, and meal history. Pro adds Apple Health, readiness, sleep, and nutrition scoring.
                </Text>
              </View>
            </View>
          )}
          {isProTier && authToken && (
            <WeeklyCheckinCard
              authToken={authToken}
              themeName={userProfile.themePreference}
            />
          )}
          {isProTier && authToken && (() => {
            return (
              <Zone2TargetCard
                authToken={authToken}
                themeName={userProfile.themePreference}
                appleHealthZone2={appleHealthZone2Minutes}
                detectedWorkouts={zone2DetectedWorkouts}
              />
            );
          })()}

          {isProTier && !isHealthKitAvailable() && (
            <View style={styles.vitalsCard}>
              <View style={{ alignItems: 'center', paddingVertical: 12 }}>
                <Ionicons name="heart-outline" size={34} color={tc.textMuted} />
                <Text {...dynamicTextProps} style={{ fontSize: 16, fontWeight: '800', color: tc.textPrimary, marginTop: 8 }}>
                  Apple Health unavailable
                </Text>
                <Text {...dynamicTextProps} style={{ fontSize: 12, color: tc.textSecondary, textAlign: 'center', lineHeight: 18, marginTop: 6 }}>
                  {Platform.OS === 'ios'
                    ? 'This build does not have HealthKit available. Thallo will keep using manual logs, in-app workouts, meal data, and recovery check-ins.'
                    : 'Apple Health is iPhone-only. Thallo will keep using manual logs, in-app workouts, meal data, and recovery check-ins.'}
                </Text>
              </View>
            </View>
          )}

          {isProTier && isHealthKitAvailable() && (
            <DetectedWorkoutsCard
              themeName={userProfile.themePreference}
              appleWorkouts={healthSummary?.workoutDetails ?? null}
              authToken={authToken}
              onAfterImport={() => {
                // Reload local history so the just-imported session
                // shows up in the streak / consistency widgets.
                (async () => {
                  try {
                    const { loadWorkoutHistory } = await import('../utils/workoutHistory');
                    const fresh = await loadWorkoutHistory();
                    setHistory(fresh);
                  } catch { /* non-fatal */ }
                })();
              }}
            />
          )}
          {/* Apple Health vitals */}
          {isProTier && isHealthKitAvailable() && (() => {
            const hs = healthSummary;
            const hasAnyData = hs && (
              hs.restingHeartRate != null || hs.avgSteps7d != null ||
              hs.lastNightSleepHours != null ||
              hs.activeEnergy7d != null || hs.hrvAvg != null
            );

            const handleConnect = async () => {
              Alert.alert(
                APPLE_HEALTH_PERMISSION_COPY.title,
                APPLE_HEALTH_PERMISSION_COPY.body,
                [
                  { text: 'Not now', style: 'cancel' },
                  {
                    text: 'Continue',
                    onPress: async () => {
                      setHealthConnecting(true);
                      try {
                        const granted = await requestHealthPermissions();
                        try { await persistAppleHealthEnabled(granted); } catch {}
                        setHealthEnabled(granted);
                        const age = userProfile.physicalStats?.age ?? null;
                        const fresh = await readHealthSummary({ age });
                        if (fresh) {
                          setHealthSummary(fresh);
                          saveHealthSummary(fresh).catch(() => null);
                          const rows = await Promise.all(
                            (fresh.workoutDetails ?? []).map((w) => summarizeWorkoutZone2(w, age).catch(() => null)),
                          );
                          const cleanRows = rows.filter((w): w is NonNullable<typeof w> => !!w);
                          setAppleHealthZone2Minutes(cleanRows.reduce((sum, w) => sum + w.zone2Minutes, 0) || null);
                          setZone2DetectedWorkouts(cleanRows.map((w) => ({
                            name: w.name,
                            durationMin: w.durationMin,
                            counted: w.counted,
                            reason: w.reason,
                          })));
                        }
                        if (granted) {
                          import('../services/healthDataSummary')
                            .then(({ backfillSnapshotsToBackend, refreshHealthDataSummary }) => {
                              refreshHealthDataSummary({ age }).catch(() => null);
                              backfillSnapshotsToBackend(30).catch(() => null);
                            })
                            .catch(() => null);
                        }
                        const hasAny = fresh && (
                          fresh.restingHeartRate != null || fresh.avgSteps7d != null ||
                          fresh.lastNightSleepHours != null ||
                          fresh.activeEnergy7d != null
                        );
                        if (granted && !hasAny) {
                          Alert.alert('Connected — waiting for data', 'Apple Health is connected. If this card stays empty, open iPhone Settings -> Privacy & Security -> Health -> Thallo and turn on the categories you want to share.');
                        } else if (!granted) {
                          const err = getLastHealthKitError();
                          Alert.alert('Apple Health not connected', `${APPLE_HEALTH_PERMISSION_COPY.denied}\n\n${err ?? ''}`.trim());
                        }
                      } catch (e: any) {
                        Alert.alert('Apple Health error', String(e?.message ?? e));
                      } finally {
                        setHealthConnecting(false);
                      }
                    },
                  },
                ],
              );
            };

            const handleOpenSettings = () => {
              Linking.openURL('app-settings:').catch(() => {
                Alert.alert('Unable to open Settings', 'Go to iPhone Settings → Privacy & Security → Health → Thallo manually.');
              });
            };

            if (!healthEnabled) {
              return (
                <View style={styles.vitalsCard}>
                  <View style={{ alignItems: 'center', paddingVertical: 12 }}>
                    <Ionicons name="heart-outline" size={36} color={tc.primary} />
                    <Text {...dynamicTextProps} style={{ fontSize: 16, fontWeight: '700', color: tc.textPrimary, marginTop: 8 }}>Apple Health is optional</Text>
                    <Text {...dynamicTextProps} style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center', lineHeight: 18, marginTop: 6, marginBottom: 14 }}>
                      Optional sync for sleep, HRV, resting heart rate, steps, workouts, weight, and active energy. Thallo also writes completed workouts back to Apple Health.
                    </Text>
                    <TouchableOpacity
                      style={{ backgroundColor: tc.primary, borderRadius: radius.md, paddingVertical: 12, paddingHorizontal: 32 }}
                      onPress={handleConnect}
                      disabled={healthConnecting}
                    >
                      {healthConnecting
                        ? <ActivityIndicator color={getContrastingTextColor(tc.primary)} />
                        : <Text style={{ color: getContrastingTextColor(tc.primary), fontWeight: '700', fontSize: 14 }}>Connect Apple Health</Text>}
                    </TouchableOpacity>
                  </View>
                </View>
              );
            }

            if (!hasAnyData) {
              return (
                <View style={styles.vitalsCard}>
                  <View style={{ alignItems: 'center', paddingVertical: 12 }}>
                    <Ionicons name="cloud-offline-outline" size={32} color={tc.textMuted} />
                    <Text {...dynamicTextProps} style={{ fontSize: 15, fontWeight: '800', color: tc.textPrimary, marginTop: 8 }}>Connected, but no Health data yet</Text>
                    <Text {...dynamicTextProps} style={{ fontSize: 12, color: tc.textSecondary, textAlign: 'center', lineHeight: 17, marginTop: 4, marginBottom: 12 }}>
                      Thallo still works normally. If this stays empty, open iOS Settings and make sure Sleep, Heart, Activity, Workouts, and Weight are enabled for Thallo.
                    </Text>
                    <TouchableOpacity
                      style={{ borderWidth: 1, borderColor: tc.border, borderRadius: radius.md, paddingVertical: 10, paddingHorizontal: 24 }}
                      onPress={handleOpenSettings}
                    >
                      <Text style={{ color: tc.textPrimary, fontWeight: '600', fontSize: 13 }}>Open iOS Settings</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            }

            const vitalsRow = (icon: string, label: string, value: string | number | null, unit?: string) => (
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: tc.border + '44' }}>
                <Ionicons name={icon as any} size={18} color={tc.primary} style={{ width: 28 }} />
                <Text style={{ fontSize: 13, color: tc.textSecondary, flex: 1 }}>{label}</Text>
                <Text style={{ fontSize: 16, fontWeight: '700', color: value != null ? tc.textPrimary : tc.textMuted }}>
                  {value != null ? (typeof value === 'number' ? value.toLocaleString() : value) : '—'}
                  {value != null && unit ? <Text style={{ fontSize: 11, fontWeight: '500', color: tc.textMuted }}> {unit}</Text> : null}
                </Text>
              </View>
            );

            return (
              <View style={styles.vitalsCard}>
                <View style={[styles.vitalsHeader, { marginBottom: 4 }]}>
                  <Ionicons name="heart-outline" size={16} color={tc.primary} />
                  <Text style={[styles.vitalsTitle, { color: tc.textPrimary }]}>Apple Health</Text>
                  <Text style={[styles.vitalsSubtitle, { color: tc.textMuted }]}>Optional 7-day snapshot</Text>
                </View>
                {vitalsRow('pulse-outline', 'Resting HR', hs!.restingHeartRate, 'bpm')}
                {vitalsRow('analytics-outline', 'HRV', hs!.hrvAvg, 'ms')}
                {vitalsRow('walk-outline', 'Steps (avg)', hs!.avgSteps7d)}
                {vitalsRow('flame-outline', 'Active calories', hs!.activeEnergy7d, 'kcal')}
                {vitalsRow('moon-outline', 'Sleep (avg)', hs!.avgSleepHours7d != null ? (() => {
                  const total = Math.round(hs!.avgSleepHours7d! * 60);
                  const h = Math.floor(total / 60), m = total % 60;
                  return m > 0 ? `${h}h ${m}m` : `${h}h`;
                })() : null)}
                {hs!.vo2Max != null && vitalsRow('fitness-outline', 'VO2 Max', Math.round(hs!.vo2Max * 10) / 10, 'ml/kg/min')}
                {hs!.respiratoryRate != null && vitalsRow('leaf-outline', 'Respiratory rate', hs!.respiratoryRate, 'brpm')}
                {hs!.oxygenSaturation != null && vitalsRow('water-outline', 'Blood oxygen', hs!.oxygenSaturation, '%')}
                {hs!.standingHours7d != null && vitalsRow('body-outline', 'Standing hours', hs!.standingHours7d, 'hrs')}
                {hs!.mindfulMinutes7d != null && vitalsRow('flower-outline', 'Mindful minutes', hs!.mindfulMinutes7d, 'min')}
                {hs!.basalEnergy7d != null && vitalsRow('flash-outline', 'Basal energy', hs!.basalEnergy7d, 'kcal')}
              </View>
            );
          })()}

          {/* Fitness Age */}
          {isProTier && (() => {
            const vo2 = healthSummary?.vo2Max;
            const age = userProfile.physicalStats?.age;
            const fa = vo2 != null && age != null ? computeFitnessAge(vo2, age) : null;
            if (!fa) return null;
            const deltaColor =
              fa.delta >= 8 ? '#22C55E' :
              fa.delta >= 2 ? tc.primary :
              fa.delta >= -5 ? tc.textSecondary : '#EF4444';
            return (
              <View style={[styles.vitalsCard, { marginTop: 0 }]}>
                <View style={[styles.vitalsHeader, { marginBottom: 10 }]}>
                  <Ionicons name="fitness" size={16} color={tc.primary} />
                  <Text style={[styles.vitalsTitle, { color: tc.textPrimary }]}>Fitness Age</Text>
                  <Text style={[styles.vitalsSubtitle, { color: tc.textMuted }]}>{fa.label}</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <View style={{ alignItems: 'center', paddingVertical: 4, paddingHorizontal: 10, borderRadius: radius.md, backgroundColor: deltaColor + '22' }}>
                    <Text style={{ fontSize: 30, fontWeight: '900', color: deltaColor, lineHeight: 34 }}>{fa.fitnessAge}</Text>
                    <Text style={{ fontSize: 9, fontWeight: '700', color: deltaColor, letterSpacing: 1 }}>YRS</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: tc.textPrimary, lineHeight: 18 }}>
                      {fa.delta === 0
                        ? `Cardio fitness matches your age (${age}).`
                        : fa.delta > 0
                          ? `Cardio fitness of a ${fa.fitnessAge}-year-old — ${fa.delta} yr${fa.delta !== 1 ? 's' : ''} younger than your actual age.`
                          : `Cardio fitness of a ${fa.fitnessAge}-year-old — ${-fa.delta} yr${-fa.delta !== 1 ? 's' : ''} older than your actual age.`}
                    </Text>
                    <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 4 }}>
                      Based on VO₂ Max {Math.round(vo2! * 10) / 10} ml/kg/min
                    </Text>
                  </View>
                </View>
              </View>
            );
          })()}

          {/* Sleep Score */}
          {isProTier && healthSummary?.sleepScore && (() => {
            const ss = healthSummary.sleepScore;
            const scoreColor = ss.score >= 80 ? tc.success : ss.score >= 60 ? tc.warning : tc.error;
            const formatHM = (hours: number) => {
              const totalMin = Math.round(hours * 60);
              const h = Math.floor(totalMin / 60);
              const m = totalMin % 60;
              if (h > 0 && m > 0) return `${h}h ${m}m`;
              if (h > 0) return `${h}h`;
              return `${m}m`;
            };
            const isPersonalized = (ss as any).mode === 'personalized';
            const pillars = (ss as any).pillars as {
              duration: number; efficiency: number; hrv: number;
              regularity?: number; stageComposite: number; healthFlags: number;
            } | undefined;
            const effRatio = (ss as any).efficiency as number | null | undefined;
            const effPct = effRatio != null ? Math.min(100, Math.round(effRatio * 100)) : null;
            const nightsLogged = sleepHistoryCount;

            // Stage composition (single stacked bar). Awake is visually
            // appended after the asleep stages for a "time in bed" read.
            const totalAsleep = ss.stages.total;
            const totalWithAwake = totalAsleep + ss.stages.awake;
            const deepPct = totalAsleep > 0 ? (ss.stages.deep / totalAsleep) * 100 : 0;
            const corePct = totalAsleep > 0 ? (ss.stages.core / totalAsleep) * 100 : 0;
            const remPct  = totalAsleep > 0 ? (ss.stages.rem  / totalAsleep) * 100 : 0;
            const awakePctOfTotal = totalWithAwake > 0 ? (ss.stages.awake / totalWithAwake) * 100 : 0;
            const STAGE_COLOR = { deep: '#6366F1', core: '#818CF8', rem: '#A78BFA', awake: tc.error };

            return (
              <View style={[styles.vitalsCard, { marginTop: 0 }]}>
                {/* Header: icon + title + score (score is the hero metric). */}
                <View style={[styles.vitalsHeader, { marginBottom: 8 }]}>
                  <Ionicons name="moon-outline" size={16} color="#818CF8" />
                  <Text style={[styles.vitalsTitle, { color: tc.textPrimary, flex: 1 }]}>Sleep Score</Text>
                  <Text style={{ fontSize: 28, fontWeight: '900', color: scoreColor, lineHeight: 32 }}>{ss.score}</Text>
                </View>

                {/* Rating + total + baseline-mode pill on one compact line. */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textSecondary }}>{ss.rating}</Text>
                  <Text style={{ fontSize: 11, color: tc.textMuted }}>· {formatHM(ss.duration)} total</Text>
                  <View style={{ flex: 1 }} />
                  <View style={{
                    paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8,
                    backgroundColor: isPersonalized ? tc.primary + '22' : tc.surfaceRaised,
                  }}>
                    <Text style={{
                      fontSize: 9, fontWeight: '800', letterSpacing: 0.6,
                      color: isPersonalized ? tc.primary : tc.textMuted,
                    }}>
                      {isPersonalized ? 'PERSONALIZED' : 'CALIBRATING'}
                    </Text>
                  </View>
                </View>
                <Text style={{ fontSize: 10, color: tc.textMuted, lineHeight: 13, marginBottom: 10 }}>
                  Biggest drivers: total sleep, deep and REM sleep, overnight wake-ups, and HRV when it's available.
                </Text>

                {/* Compact calibration progress (only while building baseline). */}
                {!isPersonalized && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <View style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: tc.border }}>
                      <View style={{
                        width: `${Math.min(100, (nightsLogged / 14) * 100)}%` as any,
                        height: 4, borderRadius: 2, backgroundColor: tc.primary,
                      }} />
                    </View>
                    <Text style={{ fontSize: 10, color: tc.textMuted, fontWeight: '600' }}>
                      {Math.min(14, nightsLogged)}/14 nights
                    </Text>
                  </View>
                )}

                {/* Single stacked stage-composition bar. Fades + slides in on mount. */}
                <FadeInView delay={60} style={{
                  flexDirection: 'row', height: 12, borderRadius: 6, overflow: 'hidden',
                  backgroundColor: tc.border,
                }}>
                  {ss.stages.deep > 0 && (
                    <View style={{ width: `${deepPct}%` as any, backgroundColor: STAGE_COLOR.deep }} />
                  )}
                  {ss.stages.core > 0 && (
                    <View style={{ width: `${corePct}%` as any, backgroundColor: STAGE_COLOR.core }} />
                  )}
                  {ss.stages.rem > 0 && (
                    <View style={{ width: `${remPct}%` as any, backgroundColor: STAGE_COLOR.rem }} />
                  )}
                </FadeInView>
                {/* Stage legend — each row in one line. */}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 8, gap: 4 }}>
                  {[
                    { label: 'Deep', hours: ss.stages.deep, color: STAGE_COLOR.deep, pct: deepPct },
                    { label: 'Core', hours: ss.stages.core, color: STAGE_COLOR.core, pct: corePct },
                    { label: 'REM',  hours: ss.stages.rem,  color: STAGE_COLOR.rem,  pct: remPct },
                  ].map(s => (
                    <View key={s.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingRight: 8 }}>
                      <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: s.color }} />
                      <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textPrimary }}>{s.label}</Text>
                      <Text style={{ fontSize: 11, color: tc.textMuted }}>{formatHM(s.hours)} ({Math.round(s.pct)}%)</Text>
                    </View>
                  ))}
                </View>

                {/* Summary strip: Total · Efficiency · Awake. */}
                <View style={{
                  flexDirection: 'row', marginTop: 10, paddingTop: 10,
                  borderTopWidth: 1, borderTopColor: tc.border + '55',
                }}>
                  <View style={{ flex: 1, alignItems: 'center' }}>
                    <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary }}>{formatHM(ss.duration)}</Text>
                    <Text style={{ fontSize: 9, color: tc.textMuted, letterSpacing: 0.5 }}>TOTAL</Text>
                  </View>
                  {effPct != null && (
                    <View style={{ flex: 1, alignItems: 'center' }}>
                      <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary }}>{effPct}%</Text>
                      <Text style={{ fontSize: 9, color: tc.textMuted, letterSpacing: 0.5 }}>EFFICIENCY</Text>
                    </View>
                  )}
                  <View style={{ flex: 1, alignItems: 'center' }}>
                    <Text style={{ fontSize: 14, fontWeight: '800', color: ss.stages.awake > 0.5 ? tc.warning : tc.textPrimary }}>
                      {formatHM(ss.stages.awake)}
                      {awakePctOfTotal > 0 && <Text style={{ fontSize: 10, color: tc.textMuted }}> ({Math.round(awakePctOfTotal)}%)</Text>}
                    </Text>
                    <Text style={{ fontSize: 9, color: tc.textMuted, letterSpacing: 0.5 }}>AWAKE</Text>
                  </View>
                  {isPersonalized && pillars?.regularity != null && (
                    <View style={{ flex: 1, alignItems: 'center' }}>
                      <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary }}>{pillars.regularity}<Text style={{ fontSize: 10, color: tc.textMuted }}>/15</Text></Text>
                      <Text style={{ fontSize: 9, color: tc.textMuted, letterSpacing: 0.5 }}>REGULARITY</Text>
                    </View>
                  )}
                </View>

                {(ss.hrvAvg != null || ss.restingHeartRate != null || ss.respiratoryRate != null || ss.oxygenSaturation != null) && (
                  <View style={{ flexDirection: 'row', gap: 12, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: tc.border + '44' }}>
                    {ss.hrvAvg != null && (
                      <View style={{ flex: 1, alignItems: 'center' }}>
                        <Text style={{ fontSize: 15, fontWeight: '700', color: tc.textPrimary }}>{ss.hrvAvg}</Text>
                        <Text style={{ fontSize: 9, color: tc.textMuted }}>HRV (ms)</Text>
                      </View>
                    )}
                    {ss.restingHeartRate != null && (
                      <View style={{ flex: 1, alignItems: 'center' }}>
                        <Text style={{ fontSize: 15, fontWeight: '700', color: tc.textPrimary }}>{ss.restingHeartRate}</Text>
                        <Text style={{ fontSize: 9, color: tc.textMuted }}>RHR</Text>
                      </View>
                    )}
                    {ss.respiratoryRate != null && (
                      <View style={{ flex: 1, alignItems: 'center' }}>
                        <Text style={{ fontSize: 15, fontWeight: '700', color: tc.textPrimary }}>{ss.respiratoryRate}</Text>
                        <Text style={{ fontSize: 9, color: tc.textMuted }}>Resp (brpm)</Text>
                      </View>
                    )}
                    {ss.oxygenSaturation != null && (
                      <View style={{ flex: 1, alignItems: 'center' }}>
                        <Text style={{ fontSize: 15, fontWeight: '700', color: tc.textPrimary }}>{ss.oxygenSaturation}%</Text>
                        <Text style={{ fontSize: 9, color: tc.textMuted }}>SpO2</Text>
                      </View>
                    )}
                  </View>
                )}
                {ss.insights.length > 0 && (
                  <View style={{ marginTop: 8, gap: 4 }}>
                    {ss.insights.map((insight, i) => (
                      <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
                        <Ionicons name="information-circle-outline" size={14} color={tc.textMuted} style={{ marginTop: 1 }} />
                        <Text style={{ fontSize: 11, color: tc.textSecondary, flex: 1, lineHeight: 16 }}>{insight}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            );
          })()}

          {/* Combined Health Score — backward-looking, requires 14 days */}
          {isProTier && (() => {
            const completedWorkouts = history.filter(s => s.completed);
            const allDates = new Set(completedWorkouts.map(s => s.date?.slice(0, 10)).filter(Boolean));
            const daysOfData = allDates.size;
            const DAYS_REQUIRED = 14;
            const nutritionDays = nutritionScoreWeekly?.days_with_data ?? mealAverages?.days_with_data ?? 0;
            const nutritionReady = !!nutritionScoreWeekly && nutritionScoreWeekly.days_with_data >= MIN_NUTRITION_DAYS_FOR_HEALTH_SCORE;
            const missingWorkoutDays = Math.max(0, DAYS_REQUIRED - daysOfData);
            const missingNutritionDays = Math.max(0, MIN_NUTRITION_DAYS_FOR_HEALTH_SCORE - nutritionDays);

            if (daysOfData < DAYS_REQUIRED || !nutritionReady) {
              return (
                <View style={{ backgroundColor: tc.surface, borderRadius: radius.lg, padding: 20, marginBottom: 14, borderWidth: 1, borderColor: tc.border, alignItems: 'center' }}>
                  <Ionicons name="heart-circle-outline" size={32} color={tc.textMuted} />
                  <Text style={{ fontSize: 16, fontWeight: '700', color: tc.textPrimary, marginTop: 8 }}>Health Score</Text>
                  <Text style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center', marginTop: 4, lineHeight: 18 }}>
                    {missingWorkoutDays > 0 && missingNutritionDays > 0
                      ? `${missingWorkoutDays} more training day${missingWorkoutDays === 1 ? '' : 's'} and ${missingNutritionDays} more meal day${missingNutritionDays === 1 ? '' : 's'} to unlock your score`
                      : missingWorkoutDays > 0
                        ? `${missingWorkoutDays} more training day${missingWorkoutDays === 1 ? '' : 's'} to unlock your score`
                        : missingNutritionDays > 0
                          ? `${missingNutritionDays} more meal day${missingNutritionDays === 1 ? '' : 's'} to unlock your score`
                          : 'Waiting on the server nutrition score before unlocking this card'}
                  </Text>
                  <View style={{ width: '100%', height: 4, borderRadius: 2, backgroundColor: tc.border, marginTop: 12 }}>
                    <View style={{ width: `${Math.min(100, (daysOfData / DAYS_REQUIRED) * 100)}%` as any, height: 4, borderRadius: 2, backgroundColor: tc.primary }} />
                  </View>
                  <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 4 }}>
                    Training {Math.min(daysOfData, DAYS_REQUIRED)} / {DAYS_REQUIRED} days · Nutrition {Math.min(nutritionDays, MIN_NUTRITION_DAYS_FOR_HEALTH_SCORE)} / {MIN_NUTRITION_DAYS_FOR_HEALTH_SCORE} days
                  </Text>
                </View>
              );
            }

            // Compute backward-looking scores
            const targetPerWeek = userProfile.daysPerWeek || 4;
            const expectedWorkouts = Math.round(targetPerWeek * (daysOfData / 7));
            const workoutAdherence = expectedWorkouts > 0 ? Math.min(1, completedWorkouts.length / expectedWorkouts) : 0;
            const activityScore = Math.round(workoutAdherence * 100);

            const nutScore = nutritionScoreWeekly!.avg_score;
            const nutDetail = `${nutritionScoreWeekly!.days_with_data}/${nutritionScoreWeekly!.window_days} meal days · server nutrition score`;
            const combined = Math.round(activityScore * 0.5 + nutScore * 0.5);
            const scoreColor = combined >= 70 ? '#22C55E' : combined >= 45 ? '#F59E0B' : '#EF4444';
            const rating = combined >= 80 ? 'Excellent' : combined >= 65 ? 'Good' : combined >= 45 ? 'Fair' : 'Needs work';

            return (
              <View style={{ backgroundColor: tc.surface, borderRadius: radius.lg, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: tc.border }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <Ionicons name="heart-circle-outline" size={22} color={tc.primary} />
                  <Text style={{ fontSize: 17, fontWeight: '700', color: tc.textPrimary, flex: 1 }}>Health Score</Text>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ fontSize: 28, fontWeight: '900', color: scoreColor }}>{combined}</Text>
                    <Text style={{ fontSize: 10, color: tc.textMuted }}>{rating} · {daysOfData}d data</Text>
                  </View>
                </View>
                {[
                  { label: 'Activity', value: activityScore, color: tc.primary, detail: `${completedWorkouts.length}/${expectedWorkouts} workouts` },
                  { label: 'Nutrition', value: nutScore, color: '#22C55E', detail: nutDetail },
                ].map(s => (
                  <View key={s.label} style={{ marginBottom: 8 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Text style={{ fontSize: 12, fontWeight: '600', color: tc.textSecondary, width: 70 }}>{s.label}</Text>
                      <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: tc.border }}>
                        <View style={{ width: `${Math.min(100, s.value)}%` as any, height: 6, borderRadius: 3, backgroundColor: s.color }} />
                      </View>
                      <Text style={{ fontSize: 11, fontWeight: '700', color: s.color, width: 28, textAlign: 'right' }}>{s.value}</Text>
                    </View>
                    {s.detail ? <Text style={{ fontSize: 10, color: tc.textMuted, marginLeft: 78, marginTop: 2 }}>{s.detail}</Text> : null}
                  </View>
                ))}
              </View>
            );
          })()}

          {isProTier && authToken && (
            <AdherenceTrendCard authToken={authToken} themeName={themeName} />
          )}

          {(() => {
            const trends = mealInsightPatterns?.adherence_trends;
            const recent = trends?.recent;
            if (!trends || !recent) return null;
            const direction = String(trends.direction ?? 'steady');
            const trendColor = direction === 'improving'
              ? '#22C55E'
              : direction === 'slipping'
                ? '#F59E0B'
                : tc.primary;
            const directionLabel = direction === 'improving' ? 'Improving' : direction === 'slipping' ? 'Slipping' : 'Steady';
            const trackingDelta = Number(trends.tracking_delta_pct ?? 0);
            const proteinDelta = trends.protein_hit_delta_pct == null ? null : Number(trends.protein_hit_delta_pct);
            // Sourced from the same helper as the Nutrition & Gut Facts
            // card so the two surfaces can't drift. See progressData.ts /
            // progressData.test.ts (the trendFactsCalorieDiff invariant).
            // Direction + delta still come from the half-window comparison
            // (that's what makes "improving" / "slipping" meaningful).
            const calendarCalorieAvg = Number(mealAverages?.avg_calories ?? recent.avg_calories ?? 0);
            const calorieAvg = mealMacroHeadline?.calories ?? headlineLoggedCalories(mealAverages as any, trends as any);
            const calorieDelta = Number(trends.calorie_delta_when_logged ?? trends.calorie_delta ?? 0);
            return (
              <View style={[styles.vitalsCard, { marginTop: 0 }]}>
                <View style={[styles.vitalsHeader, { marginBottom: 12 }]}>
                  <Ionicons name="trending-up-outline" size={16} color={trendColor} />
                  <Text style={[styles.vitalsTitle, { color: tc.textPrimary, flex: 1 }]}>Nutrition Trend</Text>
                  <Text style={{ fontSize: 11, fontWeight: '800', color: trendColor }}>{directionLabel}</Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
                  {[
                    { label: 'Tracked', value: `${recent.tracking_rate_pct ?? 0}%`, delta: `${trackingDelta >= 0 ? '+' : ''}${trackingDelta}%` },
                    { label: 'Protein', value: recent.protein_hit_pct == null ? 'n/a' : `${recent.protein_hit_pct}%`, delta: proteinDelta == null ? null : `${proteinDelta >= 0 ? '+' : ''}${proteinDelta}%` },
                    { label: 'Logged cal', value: `${Math.round(calorieAvg)}`, delta: `${calorieDelta >= 0 ? '+' : ''}${Math.round(calorieDelta)}` },
                  ].map(item => (
                    <View key={item.label} style={{ flex: 1, backgroundColor: tc.surfaceRaised, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 8 }}>
                      <Text style={{ fontSize: 17, fontWeight: '900', color: tc.textPrimary }}>{item.value}</Text>
                      <Text style={{ fontSize: 9, fontWeight: '700', color: tc.textMuted, textTransform: 'uppercase', marginTop: 2 }}>
                        {item.label}
                      </Text>
                      {item.delta != null && (
                        <Text style={{ fontSize: 10, fontWeight: '800', color: trendColor, marginTop: 3 }}>
                          {item.delta} vs prior
                        </Text>
                      )}
                    </View>
                  ))}
                </View>
                <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 17 }}>
                  Logging streak {trends.current_logging_streak_days ?? 0} day{trends.current_logging_streak_days === 1 ? '' : 's'}
                  {trends.current_protein_streak_days != null ? ` · Protein streak ${trends.current_protein_streak_days} day${trends.current_protein_streak_days === 1 ? '' : 's'}` : ''}
                  {calendarCalorieAvg > 0 && Math.abs(calendarCalorieAvg - calorieAvg) >= 25
                    ? ` · Calendar avg ${Math.round(calendarCalorieAvg)} cal`
                    : ''}
                </Text>
              </View>
            );
          })()}

          {/* Nutrition & Gut Facts — 7-day rolling window (facts only, no scores). */}
          {isProTier && (gutHealthWindow || mealAverages) && (
            <View style={[styles.vitalsCard, { marginTop: 0 }]}>
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => { configureExpandAnimation(300); setNutritionGutExpanded(prev => !prev); }}
              >
                <View style={[styles.vitalsHeader, { marginBottom: nutritionGutExpanded ? 10 : 0 }]}>
                  <Ionicons name="leaf-outline" size={16} color={tc.primary} />
                  <Text style={[styles.vitalsTitle, { color: tc.textPrimary, flex: 1 }]}>Nutrition & Gut Facts</Text>
                  {gutHealthWindow && (
                    <Text style={{ fontSize: 10, color: tc.textMuted, marginRight: 6 }}>{gutHealthWindow.days_with_data}d data</Text>
                  )}
                  <Ionicons name={nutritionGutExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={tc.textMuted} />
                </View>
              </TouchableOpacity>

              {nutritionGutExpanded && <>
              {/* Averages over actual logged days (adaptive, up to 14). */}
              {gutHealthWindow && gutHealthWindow.days_with_data > 0 && (
                <View style={{ marginBottom: 14 }}>
                  <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textSecondary, letterSpacing: 0.5, marginBottom: 8 }}>
                    {gutHealthWindow.days_with_data}-DAY AVERAGES
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    {[
                      { label: 'Fiber/day', value: `${gutHealthWindow.avg_fiber_g}g` },
                      { label: 'Added sugar/day', value: `${Math.round(gutHealthWindow.avg_added_sugar_g ?? 0)}g` },
                      { label: 'Plants total', value: `${gutHealthWindow.distinct_plant_foods_week}` },
                    ].map(s => (
                      <View key={s.label} style={{ flex: 1, alignItems: 'center', backgroundColor: tc.surfaceRaised, borderRadius: 10, paddingVertical: 8 }}>
                        <Text style={{ fontSize: 18, fontWeight: '900', color: tc.textPrimary }}>{s.value}</Text>
                        <Text style={{ fontSize: 9, fontWeight: '600', color: tc.textMuted, marginTop: 2 }}>{s.label}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              )}

              {/* Nutrition macros — logged-day average first, with the
                  calendar-window average called out separately when it differs. */}
              {mealAverages && (() => {
                const allDailyRows = mealHistoryDailyRows ?? selectDailyRows(null, mealAverages.daily as any, Number.MAX_SAFE_INTEGER);
                if (mealHistoryDailyRows != null && allDailyRows.length === 0) return null;
                const loggedDayCount = allDailyRows.length || mealAverages.days_with_data;
                if (loggedDayCount < 2) return null;
                const macrosHead = mealMacroHeadline ?? macrosHeadlineFromDailyRows(allDailyRows as any) ?? macrosHeadlineFromAverages(mealAverages as any);
                const loggedCal = macrosHead.calories;
                const loggedProtein = macrosHead.protein;
                const loggedCarbs = macrosHead.carbs;
                const loggedFat = macrosHead.fat;
                const dailyRows = allDailyRows.slice(0, 5);
                const totalMealsLogged = allDailyRows.length > 0
                  ? allDailyRows.reduce((sum, row) => sum + Number(row.meal_count ?? 0), 0)
                  : mealAverages.total_meals_logged;
                const avgMealsLoggedDay = totalMealsLogged / Math.max(loggedDayCount, 1);
                return (
                <View style={{ marginBottom: 14, paddingTop: 10, borderTopWidth: 1, borderTopColor: tc.border + '44' }}>
                  <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textSecondary, letterSpacing: 0.5, marginBottom: 8 }}>
                    MACROS (LOGGED-DAY AVG)
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    {[
                      { label: 'Calories', value: Math.round(loggedCal), color: tc.primary },
                      { label: 'Protein', value: `${Math.round(loggedProtein)}g`, color: '#22C55E' },
                      { label: 'Carbs', value: `${Math.round(loggedCarbs)}g`, color: '#F59E0B' },
                      { label: 'Fat', value: `${Math.round(loggedFat)}g`, color: '#A78BFA' },
                    ].map(s => (
                      <View key={s.label} style={{ flex: 1, alignItems: 'center', backgroundColor: tc.surfaceRaised, borderRadius: 8, paddingVertical: 8 }}>
                        <Text style={{ fontSize: 15, fontWeight: '800', color: s.color }}>{s.value}</Text>
                        <Text style={{ fontSize: 9, fontWeight: '600', color: tc.textMuted, marginTop: 1 }}>{s.label}</Text>
                      </View>
                    ))}
                  </View>
                  <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 6 }}>
                    {loggedDayCount} logged day{loggedDayCount === 1 ? '' : 's'} in last {mealAverages.window_days} · {Math.round(avgMealsLoggedDay)} meals/logged day · {totalMealsLogged} total
                    {Math.abs(loggedCal - mealAverages.avg_calories) >= 25
                      ? ` · calendar avg ${Math.round(mealAverages.avg_calories)} cal`
                      : ''}
                  </Text>
                  {dailyRows.length > 0 && (() => {
                    // Use the max of the visible rows (or the avg, whichever
                    // is larger) as the bar denominator. The previous version
                    // used `loggedCal` (the avg), which clamped every
                    // above-average day to 100% — making them all look
                    // identical even when one day was far higher than another.
                    const barMax = dailyBarDenominator(loggedCal, dailyRows);
                    return (
                    <View style={{ marginTop: 8, gap: 4 }}>
                      <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textSecondary, letterSpacing: 0.5, marginBottom: 2 }}>
                        RECENT LOGGED DAYS
                      </Text>
                      {dailyRows.map(row => {
                        const d = new Date(`${row.date}T12:00:00`);
                        const label = `${d.getMonth() + 1}/${d.getDate()}`;
                        return (
                          <View key={row.date} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <Text style={{ width: 36, fontSize: 10, fontWeight: '700', color: tc.textMuted }}>{label}</Text>
                            <View style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: tc.border }}>
                              <View style={{ width: `${Math.min(100, (row.calories / barMax) * 100)}%` as any, height: 5, borderRadius: 3, backgroundColor: tc.primary }} />
                            </View>
                            <Text style={{ width: 92, fontSize: 10, color: tc.textSecondary, textAlign: 'right' }}>
                              {Math.round(row.calories)} cal · {Math.round(row.protein_g)}g P
                            </Text>
                          </View>
                        );
                      })}
                    </View>
                    );
                  })()}
                </View>
                );
              })()}

              {/* Gut health metrics — weekly rolling */}
              {gutHealthWindow && gutHealthWindow.days_with_data > 0 && (
                <View style={{ paddingTop: 10, borderTopWidth: 1, borderTopColor: tc.border + '44' }}>
                  <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textSecondary, letterSpacing: 0.5, marginBottom: 10 }}>
                    GUT HEALTH ({gutHealthWindow.days_with_data}-DAY)
                  </Text>

                  {/* Fiber */}
                  {(() => {
                    const fiberOk = gutHealthWindow.avg_fiber_g >= 25;
                    const fiberColor = fiberOk ? '#22C55E' : gutHealthWindow.avg_fiber_g >= 18 ? '#F59E0B' : '#EF4444';
                    return (
                      <View style={{ marginBottom: 12 }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                          <Text style={{ fontSize: 11, fontWeight: '600', color: tc.textSecondary }}>Avg fiber</Text>
                          <Text style={{ fontSize: 11, fontWeight: '700', color: fiberColor }}>{gutHealthWindow.avg_fiber_g}g / day</Text>
                        </View>
                        <View style={{ height: 5, borderRadius: 3, backgroundColor: tc.border }}>
                          <View style={{ width: `${Math.min(100, (gutHealthWindow.avg_fiber_g / 28) * 100)}%` as any, height: 5, borderRadius: 3, backgroundColor: fiberColor }} />
                        </View>
                        <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 3 }}>
                          {gutHealthWindow.avg_fiber_per_1000_kcal}g per 1k cal · Hit target {gutHealthWindow.pct_days_fiber_target}% of days
                        </Text>
                      </View>
                    );
                  })()}

                  {/* Plant diversity */}
                  {(() => {
                    const count = gutHealthWindow.distinct_plant_foods_week;
                    const color = count >= 20 ? '#22C55E' : count >= 10 ? '#F59E0B' : '#EF4444';
                    return (
                      <View style={{ marginBottom: 12 }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                          <Text style={{ fontSize: 11, fontWeight: '600', color: tc.textSecondary }}>Plant diversity</Text>
                          <Text style={{ fontSize: 11, fontWeight: '700', color: color }}>{count} / 30 plants</Text>
                        </View>
                        <View style={{ height: 5, borderRadius: 3, backgroundColor: tc.border }}>
                          <View style={{ width: `${Math.min(100, (count / 30) * 100)}%` as any, height: 5, borderRadius: 3, backgroundColor: color }} />
                        </View>
                        <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 3 }}>
                          30+ distinct plants/week linked to improved microbiome diversity
                        </Text>
                      </View>
                    );
                  })()}

                  {/* Metric rows */}
                  {[
                    { icon: 'flask-outline', label: 'Fermented foods', value: `${gutHealthWindow.fermented_servings} servings`, detail: 'Kimchi, yogurt, sauerkraut support gut flora' },
                    { icon: 'medkit-outline', label: 'Probiotic servings', value: `${gutHealthWindow.probiotic_servings ?? 0}`, detail: 'Live cultures for microbiome balance' },
                    { icon: 'fish-outline', label: 'Omega-3 foods', value: `${gutHealthWindow.omega3_servings} servings`, detail: 'Anti-inflammatory, heart & brain health' },
                    // Collagen — AI-estimated from every logged food, not
                    // a keyword match. Shows daily average for readability.
                    { icon: 'pulse-outline', label: 'Collagen', value: `${Math.round((gutHealthWindow as any).avg_collagen_g ?? 0)}g / day avg`, detail: 'AI-estimated from bone broth, skin-on cuts, gelatin, supplements' },
                  ].map(row => (
                    <View key={row.label} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
                      <Ionicons name={row.icon as any} size={16} color={tc.primary} style={{ marginTop: 1 }} />
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Text style={{ fontSize: 12, fontWeight: '600', color: tc.textPrimary }}>{row.label}</Text>
                          <Text style={{ fontSize: 12, fontWeight: '700', color: tc.primary }}>{row.value}</Text>
                        </View>
                        <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 2 }}>{row.detail}</Text>
                      </View>
                    </View>
                  ))}

                  {/* Protein source breakdown — daily averages, NOT
                      raw window totals. The old label said "WEEKLY AVG"
                      but showed sums ("72g plant · 581g animal") which
                      made no sense. Now reads as a daily average that
                      matches how users think about protein intake. */}
                  {(gutHealthWindow.plant_protein_g + gutHealthWindow.animal_protein_g) > 0 && (() => {
                    const days = gutHealthWindow.days_with_data || 1;
                    const avgPlant = (gutHealthWindow as any).avg_plant_protein_g
                      ?? Math.round((gutHealthWindow.plant_protein_g / days) * 10) / 10;
                    const avgAnimal = (gutHealthWindow as any).avg_animal_protein_g
                      ?? Math.round((gutHealthWindow.animal_protein_g / days) * 10) / 10;
                    const total = gutHealthWindow.plant_protein_g + gutHealthWindow.animal_protein_g;
                    const plantPct = Math.round((gutHealthWindow.plant_protein_g / total) * 100);
                    const plantColor = plantPct >= 30 ? '#22C55E' : plantPct >= 15 ? '#F59E0B' : '#EF4444';
                    const handleProteinTap = async () => {
                      configureExpandAnimation(300);
                      if (proteinBreakdownExpanded) {
                        setProteinBreakdownExpanded(false);
                        return;
                      }
                      if (!proteinBreakdown && authToken) {
                        setProteinBreakdownLoading(true);
                        try {
                          const { getProteinBreakdown } = await import('../services/api');
                          const bd = await getProteinBreakdown(authToken);
                          setProteinBreakdown(bd);
                        } catch { /* non-fatal */ }
                        finally { setProteinBreakdownLoading(false); }
                      }
                      setProteinBreakdownExpanded(true);
                    };
                    return (
                      <TouchableOpacity activeOpacity={0.7} onPress={handleProteinTap} style={{ marginBottom: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: tc.border + '33' }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                          <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textSecondary, letterSpacing: 0.5, flex: 1 }}>
                            PROTEIN SOURCES · {days}-DAY AVG
                          </Text>
                          <Ionicons name={proteinBreakdownExpanded ? 'chevron-up' : 'chevron-down'} size={14} color={tc.textMuted} />
                        </View>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                          <Text style={{ fontSize: 11, fontWeight: '600', color: tc.textSecondary }}>
                            Daily avg: {Math.round(avgPlant)}g plant · {Math.round(avgAnimal)}g animal
                          </Text>
                          <Text style={{ fontSize: 11, fontWeight: '700', color: plantColor }}>{plantPct}% plant</Text>
                        </View>
                        <View style={{ flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: tc.border }}>
                          {gutHealthWindow.plant_protein_g > 0 && <View style={{ width: `${plantPct}%` as any, backgroundColor: '#22C55E' }} />}
                          {gutHealthWindow.animal_protein_g > 0 && <View style={{ width: `${100 - plantPct}%` as any, backgroundColor: tc.primary }} />}
                        </View>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 3 }}>
                          <Text style={{ fontSize: 9, color: '#22C55E', fontWeight: '700' }}>Plant</Text>
                          <Text style={{ fontSize: 9, color: tc.primary, fontWeight: '700' }}>Animal</Text>
                        </View>
                        {proteinBreakdownExpanded && (
                          <View style={{ marginTop: 8 }}>
                            {proteinBreakdownLoading ? (
                              <ActivityIndicator size="small" color={tc.primary} style={{ marginVertical: 8 }} />
                            ) : proteinBreakdown ? (
                              <>
                                {proteinBreakdown.plant.length > 0 && (
                                  <View style={{ marginBottom: 6 }}>
                                    <Text style={{ fontSize: 10, fontWeight: '700', color: '#22C55E', marginBottom: 3 }}>Plant sources (today)</Text>
                                    {proteinBreakdown.plant.map((f, i) => (
                                      <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 }}>
                                        <Text style={{ fontSize: 11, color: tc.textPrimary }}>{f.name}</Text>
                                        <Text style={{ fontSize: 11, fontWeight: '600', color: tc.textSecondary }}>{f.protein_g}g</Text>
                                      </View>
                                    ))}
                                  </View>
                                )}
                                {proteinBreakdown.animal.length > 0 && (
                                  <View style={{ marginBottom: 6 }}>
                                    <Text style={{ fontSize: 10, fontWeight: '700', color: tc.primary, marginBottom: 3 }}>Animal sources (today)</Text>
                                    {proteinBreakdown.animal.map((f, i) => (
                                      <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 }}>
                                        <Text style={{ fontSize: 11, color: tc.textPrimary }}>{f.name}</Text>
                                        <Text style={{ fontSize: 11, fontWeight: '600', color: tc.textSecondary }}>{f.protein_g}g</Text>
                                      </View>
                                    ))}
                                  </View>
                                )}
                                {proteinBreakdown.unclassified.length > 0 && (
                                  <View style={{ marginBottom: 6 }}>
                                    <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textMuted, marginBottom: 3 }}>Unclassified</Text>
                                    {proteinBreakdown.unclassified.map((f, i) => (
                                      <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 }}>
                                        <Text style={{ fontSize: 11, color: tc.textPrimary }}>{f.name}</Text>
                                        <Text style={{ fontSize: 11, fontWeight: '600', color: tc.textSecondary }}>{f.protein_g}g</Text>
                                      </View>
                                    ))}
                                  </View>
                                )}
                                {proteinBreakdown.plant.length === 0 && proteinBreakdown.animal.length === 0 && (
                                  <View style={{ marginTop: 4, padding: 10, borderRadius: radius.md, backgroundColor: tc.surfaceRaised, borderWidth: 1, borderColor: tc.border }}>
                                    <Text {...dynamicTextProps} style={{ fontSize: 12, fontWeight: '700', color: tc.textPrimary }}>No meals logged today yet</Text>
                                    <Text {...dynamicTextProps} style={{ fontSize: 11, color: tc.textMuted, lineHeight: 15, marginTop: 2 }}>
                                      Check off a meal or log from Favorites to unlock protein-source and gut-health signals.
                                    </Text>
                                  </View>
                                )}
                              </>
                            ) : (
                              <Text style={{ fontSize: 11, color: tc.textMuted, fontStyle: 'italic' }}>Could not load breakdown.</Text>
                            )}
                          </View>
                        )}
                        {!proteinBreakdownExpanded && (
                          <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 4 }}>
                            Tap to see contributing foods.
                          </Text>
                        )}
                      </TouchableOpacity>
                    );
                  })()}

                  {/* Processing mix */}
                  {gutHealthWindow.processing_counts && Object.keys(gutHealthWindow.processing_counts).length > 0 && (
                    <View style={{ paddingTop: 10, borderTopWidth: 1, borderTopColor: tc.border + '33' }}>
                      <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textSecondary, letterSpacing: 0.5, marginBottom: 8 }}>FOOD PROCESSING MIX</Text>
                      {['minimally_processed', 'processed', 'ultra_processed', 'unknown'].map(b => {
                        const count = gutHealthWindow.processing_counts[b] ?? 0;
                        if (count === 0) return null;
                        const total = Object.values(gutHealthWindow.processing_counts).reduce((s, v) => s + v, 0) || 1;
                        const pct = Math.round(100 * count / total);
                        const color = b === 'minimally_processed' ? '#22C55E' : b === 'processed' ? '#F59E0B' : b === 'ultra_processed' ? '#EF4444' : tc.textMuted;
                        return (
                          <View key={b} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
                            <Text style={{ width: 120, fontSize: 11, color: tc.textSecondary }}>{b.replace(/_/g, ' ')}</Text>
                            <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: tc.border }}>
                              <View style={{ width: `${Math.max(3, pct)}%` as any, height: 6, borderRadius: 3, backgroundColor: color }} />
                            </View>
                            <Text style={{ width: 45, fontSize: 11, fontWeight: '600', color: tc.textSecondary, textAlign: 'right' }}>{pct}%</Text>
                          </View>
                        );
                      })}
                      <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 4 }}>
                        Minimizing ultra-processed intake linked to lower inflammation and disease risk
                      </Text>
                    </View>
                  )}
                </View>
              )}

              {/* Fallback: client-side gut insights when no API data */}
              {!gutHealthWindow && gutInsights && (
                <View>
                  <View style={{ marginBottom: 10 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                      <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>Plant diversity (7d)</Text>
                      <Text style={{ fontSize: 11, fontWeight: '700', color: gutInsights.plantTier === 'on_track' ? '#22C55E' : gutInsights.plantTier === 'building' ? '#F59E0B' : '#EF4444' }}>
                        {gutInsights.plantCount} / 30
                      </Text>
                    </View>
                    <View style={{ height: 5, borderRadius: 3, backgroundColor: tc.border }}>
                      <View style={{
                        width: `${Math.min(100, (gutInsights.plantCount / 30) * 100)}%` as any,
                        height: 5, borderRadius: 3,
                        backgroundColor: gutInsights.plantTier === 'on_track' ? '#22C55E' : gutInsights.plantTier === 'building' ? '#F59E0B' : '#EF4444',
                      }} />
                    </View>
                    <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 4 }}>{gutInsights.plantMessage}</Text>
                  </View>
                  <View style={{ marginBottom: 10 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                      <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>Fiber today</Text>
                      <Text style={{ fontSize: 11, fontWeight: '700', color: gutInsights.fiberToday.pct >= 80 ? '#22C55E' : '#F59E0B' }}>
                        {gutInsights.fiberToday.grams}g / {gutInsights.fiberToday.target}g
                      </Text>
                    </View>
                    <View style={{ height: 5, borderRadius: 3, backgroundColor: tc.border }}>
                      <View style={{
                        width: `${Math.min(100, gutInsights.fiberToday.pct)}%` as any,
                        height: 5, borderRadius: 3,
                        backgroundColor: gutInsights.fiberToday.pct >= 80 ? '#22C55E' : '#F59E0B',
                      }} />
                    </View>
                  </View>
                  {gutInsights.proteinFlag && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
                      <Ionicons
                        name={gutInsights.proteinFlag.tier === 'good' ? 'checkmark-circle' : 'alert-circle-outline'}
                        size={14}
                        color={gutInsights.proteinFlag.tier === 'good' ? '#22C55E' : '#F59E0B'}
                      />
                      <Text style={{ fontSize: 11, color: tc.textSecondary, flex: 1 }}>{gutInsights.proteinFlag.detail}</Text>
                    </View>
                  )}
                </View>
              )}

              {/* No data placeholder */}
              {!gutHealthWindow && !gutInsights && (
                <View style={{ alignItems: 'center', paddingVertical: 8 }}>
                  <Text style={{ fontSize: 12, color: tc.textMuted, textAlign: 'center', lineHeight: 17 }}>
                    Log meals to see weekly nutrition & gut health trends
                  </Text>
                </View>
              )}
              </>}
            </View>
          )}

          {/* Muscle Balance moved to Body tab */}
        </ScrollView>
      ) : tab === 'body' ? (
        /* ── Body Tab ───────────────────────────────────────────────── */
        <ScrollView contentContainerStyle={styles.content}>
          {/* Per-muscle recovery (moved from Health tab) — shows fatigue across
              all 12 muscle groups with the full expanded bars. */}
          {isProTier && muscleFatigue && (
            <RecoveryCard data={muscleFatigue as any} themeName={themeName} defaultExpanded />
          )}

          {/* Muscle Balance — volume distribution across muscle groups (14d) */}
          {isProTier && muscleBalance && muscleBalance.total_sets > 0 && (() => {
            const entries = Object.entries(muscleBalance.muscles);
            const maxSets = entries.length ? Math.max(...entries.map(([, v]) => v.sets)) : 1;
            const BALANCE_MUSCLES = new Set(['chest', 'back', 'shoulders', 'biceps', 'triceps', 'quads', 'hamstrings', 'glutes']);
            const balEntries = entries.filter(([m]) => BALANCE_MUSCLES.has(m));
            const avgPct = balEntries.length ? balEntries.reduce((s, [, v]) => s + v.pct, 0) / balEntries.length : 0;
            const barColor = (muscle: string, pct: number) => {
              if (!BALANCE_MUSCLES.has(muscle)) return tc.textMuted;
              if (avgPct === 0) return tc.primary;
              const ratio = pct / avgPct;
              if (ratio >= 0.7) return '#22C55E';
              if (ratio >= 0.4) return '#F59E0B';
              return '#EF4444';
            };
            const score = muscleBalance.balance_score;
            const scoreColor = score >= 70 ? '#22C55E' : score >= 45 ? '#F59E0B' : '#EF4444';

            return (
              <View style={[styles.vitalsCard, { marginTop: 0 }]}>
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={() => { configureExpandAnimation(300); setMuscleBalanceExpanded(prev => !prev); }}
                >
                  <View style={[styles.vitalsHeader, { marginBottom: muscleBalanceExpanded ? 12 : 0 }]}>
                    <Ionicons name="body-outline" size={16} color={tc.primary} />
                    <Text style={[styles.vitalsTitle, { color: tc.textPrimary, flex: 1 }]}>Muscle Balance</Text>
                    <Text style={{ fontSize: 20, fontWeight: '800', color: scoreColor }}>{score}</Text>
                    <Text style={{ fontSize: 10, fontWeight: '600', color: tc.textMuted, marginLeft: 2 }}>/100</Text>
                    <Ionicons name={muscleBalanceExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={tc.textMuted} style={{ marginLeft: 6 }} />
                  </View>
                </TouchableOpacity>
                {muscleBalanceExpanded && (
                  <View style={{ gap: 6 }}>
                    <Text style={{ fontSize: 10, color: tc.textMuted, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>
                      {muscleBalance.period_days}d / {Math.round(muscleBalance.total_sets)} total sets
                    </Text>
                    {entries.map(([muscle, data]) => (
                      <View key={muscle} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Text style={{ width: 72, fontSize: 11, fontWeight: '600', color: tc.textSecondary, textTransform: 'capitalize' }}>{muscle.replace(/_/g, ' ')}</Text>
                        <View style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: tc.border }}>
                          <View style={{ width: `${Math.max(3, (data.sets / maxSets) * 100)}%` as any, height: 8, borderRadius: 4, backgroundColor: barColor(muscle, data.pct) }} />
                        </View>
                        <Text style={{ width: 36, fontSize: 11, fontWeight: '700', color: tc.textPrimary, textAlign: 'right' }}>{Math.round(data.sets)}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            );
          })()}

          {/* Weight Trend */}
          <View
            testID="progress-weight-card"
            style={{ backgroundColor: tc.surface, borderRadius: radius.lg, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: tc.border }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Ionicons name="scale-outline" size={22} color={tc.primary} />
              <Text style={{ fontSize: 17, fontWeight: '700', color: tc.textPrimary, flex: 1 }}>Weight</Text>
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: tc.primary, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 6 }}
                onPress={() => {
                  setWeightInputValue(weightEntries.length > 0 ? String(weightEntries[weightEntries.length - 1].weightLbs) : '');
                  setWeightInputError('');
                  setWeightInputVisible(true);
                }}>
                <Ionicons name="add" size={16} color={getContrastingTextColor(tc.primary)} />
                <Text style={{ fontSize: 13, fontWeight: '600', color: getContrastingTextColor(tc.primary) }}>Log</Text>
              </TouchableOpacity>
            </View>
            {weightEntries.length === 0 ? (
              <Text style={{ fontSize: 13, color: tc.textMuted, textAlign: 'center', paddingVertical: 8 }}>
                Update your weight in profile settings to start tracking.
              </Text>
            ) : (
              <>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 }}>
                  <View>
                    <Text
                      testID="progress-weight-current-value"
                      style={{ fontSize: 28, fontWeight: '800', color: tc.textPrimary }}>
                      {weightEntries[weightEntries.length - 1].weightLbs} <Text style={{ fontSize: 14, fontWeight: '500', color: tc.textMuted }}>lbs</Text>
                    </Text>
                    <Text style={{ fontSize: 11, color: tc.textMuted }}>
                      {new Date(weightEntries[weightEntries.length - 1].date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </Text>
                  </View>
                  {weightEntries.length >= 2 && (() => {
                    const first = weightEntries[0];
                    const last = weightEntries[weightEntries.length - 1];
                    const diff = Math.round((last.weightLbs - first.weightLbs) * 10) / 10;
                    const color = diff < 0 ? (tc.success ?? '#22C55E') : diff > 0 ? (tc.warning ?? '#F59E0B') : tc.textMuted;
                    return (
                      <View style={{ alignItems: 'flex-end' }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          <Ionicons name={diff < 0 ? 'trending-down' : diff > 0 ? 'trending-up' : 'remove'} size={18} color={color} />
                          <Text style={{ fontSize: 16, fontWeight: '700', color }}>
                            {diff > 0 ? '+' : ''}{diff} lbs
                          </Text>
                        </View>
                        <Text style={{ fontSize: 11, color: tc.textMuted }}>
                          since {new Date(first.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </Text>
                      </View>
                    );
                  })()}
                </View>
                {/* Goal progress — only render Target / Remaining / ETA
                    when the user's goal actually has a target-weight axis.
                    Strength / endurance / athletic / mobility goals don't
                    track weight toward a number, so those columns (and the
                    ETA derived from them) are meaningless for them. */}
                {(() => {
                  const GOAL_HAS_TARGET_WEIGHT = new Set([
                    'lose_fat', 'get_lean', 'cut', 'preserve_muscle_cutting',
                    'build_muscle', 'lean_bulk', 'gain_weight',
                    'body_recomp', 'tone', 'get_toned',
                  ]);
                  const isTargetGoal = GOAL_HAS_TARGET_WEIGHT.has(userProfile.goal);
                  const target = isTargetGoal ? userProfile.goalDetails?.targetWeightLbs : null;
                  const start = userProfile.goalDetails?.startWeightLbs ?? weightEntries[0]?.weightLbs;
                  const curr = weightEntries[weightEntries.length - 1]?.weightLbs ?? currentWeight;
                  const remaining = target ? Math.abs(target - curr) : null;
                  const showEstimate = isTargetGoal && !!estimate;
                  return (
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: tc.border }}>
                      {start != null && (
                        <View style={{ alignItems: 'center' }}>
                          <Text style={{ fontSize: 11, color: tc.textMuted }}>Start</Text>
                          <Text style={{ fontSize: 15, fontWeight: '700', color: tc.textSecondary }}>{start}</Text>
                        </View>
                      )}
                      <View style={{ alignItems: 'center' }}>
                        <Text style={{ fontSize: 11, color: tc.textMuted }}>Current</Text>
                        <Text style={{ fontSize: 15, fontWeight: '700', color: tc.textPrimary }}>{curr}</Text>
                      </View>
                      {target != null && (
                        <View style={{ alignItems: 'center' }}>
                          <Text style={{ fontSize: 11, color: tc.textMuted }}>Target</Text>
                          <Text style={{ fontSize: 15, fontWeight: '700', color: tc.primary }}>{target}</Text>
                        </View>
                      )}
                      {remaining != null && (
                        <View style={{ alignItems: 'center' }}>
                          <Text style={{ fontSize: 11, color: tc.textMuted }}>Remaining</Text>
                          <Text style={{ fontSize: 15, fontWeight: '700', color: tc.textSecondary }}>{remaining.toFixed(1)}</Text>
                        </View>
                      )}
                      {showEstimate && estimate && (
                        <View style={{ alignItems: 'center' }}>
                          <Text style={{ fontSize: 11, color: tc.textMuted }}>ETA</Text>
                          <Text style={{ fontSize: 15, fontWeight: '700', color: tc.primary }}>{estimate.label}</Text>
                          <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 1 }}>
                            {estimate.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </Text>
                        </View>
                      )}
                    </View>
                  );
                })()}
                {/* Weight log — tap trash to delete. After deletion we
                    reload history from disk so the derived stats (diff,
                    goal progress, ETA) recompute off the new series. */}
                {weightEntries.slice(-10).reverse().map((e, i) => (
                  <View key={e.date} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderTopWidth: i > 0 ? 1 : 0, borderTopColor: tc.border }}>
                    <Text style={{ flex: 1, fontSize: 13, color: tc.textSecondary }}>
                      {new Date(e.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                    </Text>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: tc.textPrimary }}>
                      {e.weightLbs} lbs
                    </Text>
                    <TouchableOpacity
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      onPress={() => {
                        Alert.alert(
                          'Delete entry?',
                          `Remove ${e.weightLbs} lbs logged on ${new Date(e.date + 'T12:00:00').toLocaleDateString()}? Derived stats (diff, ETA) will recalculate.`,
                          [
                            { text: 'Cancel', style: 'cancel' },
                            {
                              text: 'Delete',
                              style: 'destructive',
                              onPress: async () => {
                                const { deleteWeightEntry } = await import('../utils/weightHistory');
                                const next = await deleteWeightEntry(e.date);
                                setWeightEntries(next);
                              },
                            },
                          ],
                        );
                      }}
                    >
                      <Ionicons name="trash-outline" size={14} color={tc.textMuted} />
                    </TouchableOpacity>
                  </View>
                ))}

                {/* Footer actions */}
                {weightEntries.length > 0 && (
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: tc.border }}>
                    <TouchableOpacity
                      onPress={async () => {
                        // Force a re-read of the persisted history and re-derive
                        // downstream stats in case another screen mutated it.
                        const { loadWeightHistory } = await import('../utils/weightHistory');
                        setWeightEntries(await loadWeightHistory());
                      }}
                    >
                      <Text style={{ fontSize: 11, color: tc.textMuted }}>Recalculate</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => {
                        Alert.alert(
                          'Reset weight history?',
                          'This deletes every logged weight. The current weight on your profile stays unchanged.',
                          [
                            { text: 'Cancel', style: 'cancel' },
                            {
                              text: 'Reset',
                              style: 'destructive',
                              onPress: async () => {
                                const { clearWeightHistory } = await import('../utils/weightHistory');
                                await clearWeightHistory();
                                setWeightEntries([]);
                              },
                            },
                          ],
                        );
                      }}
                    >
                      <Text style={{ fontSize: 11, color: tc.error }}>Reset history</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </>
            )}
            {/* Recomp projection — outside the weight-entries gate so it
                shows even before the user has logged a weight entry. */}
            {recompProjection && (
              <View style={{ marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: tc.border }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <Ionicons name="body-outline" size={15} color={tc.primary} />
                  <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textPrimary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    Recomp Target
                  </Text>
                  <Text style={{ fontSize: 11, color: tc.textMuted, marginLeft: 2 }}>
                    — estimated ranges, not exact
                  </Text>
                </View>
                <View style={{ gap: 5 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 12, color: tc.textMuted }}>Scale trend</Text>
                    <Text style={{ fontSize: 12, fontWeight: '600', color: tc.textSecondary }}>{recompProjection.scaleNote}</Text>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 12, color: tc.textMuted }}>Estimated fat loss</Text>
                    <Text style={{ fontSize: 12, fontWeight: '600', color: tc.textSecondary }}>{recompProjection.fatLossRange}</Text>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 12, color: tc.textMuted }}>Lean mass</Text>
                    <Text style={{ fontSize: 12, fontWeight: '600', color: tc.textSecondary }}>{recompProjection.leanMassNote}</Text>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                    <Text style={{ fontSize: 12, color: tc.textMuted }}>Best signals</Text>
                    <Text style={{ fontSize: 12, fontWeight: '600', color: tc.textSecondary, textAlign: 'right', flex: 1 }}>
                      {recompProjection.bestSignals.join(' · ')}
                    </Text>
                  </View>
                </View>
                {recompProjection.caveat && (
                  <View style={{ marginTop: 8, padding: 8, borderRadius: 8, backgroundColor: (tc.warning ?? '#F59E0B') + '18' }}>
                    <Text style={{ fontSize: 11, color: tc.textSecondary, lineHeight: 15 }}>{recompProjection.caveat}</Text>
                  </View>
                )}
              </View>
            )}
          </View>

          {/* Body Measurements */}
          <View style={{ backgroundColor: tc.surface, borderRadius: radius.lg, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: tc.border }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name="body-outline" size={22} color={tc.primary} />
              <Text {...dynamicTextProps} style={{ fontSize: 17, fontWeight: '700', color: tc.textPrimary, flex: 1 }}>Measurements</Text>
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: tc.primary, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 6 }}
                onPress={() => setMeasurementsModalVisible(true)}>
                <Ionicons name="add" size={16} color={getContrastingTextColor(tc.primary)} />
                <Text style={{ fontSize: 13, fontWeight: '600', color: getContrastingTextColor(tc.primary) }}>Log</Text>
              </TouchableOpacity>
            </View>
            <View style={{ marginTop: 10, padding: 12, borderRadius: radius.md, backgroundColor: tc.surfaceRaised, borderWidth: 1, borderColor: tc.border }}>
              <Text {...dynamicTextProps} style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>
                No measurement trend yet
              </Text>
              <Text {...dynamicTextProps} style={{ fontSize: 12, color: tc.textMuted, marginTop: 3, lineHeight: 17 }}>
                Log a baseline waist, chest, hips, arms, or body-fat estimate. Future logs will make body changes easier to see than scale weight alone.
              </Text>
            </View>
          </View>

          {/* Scan buttons */}
          {isProTier && <View style={styles.bodyScanPrompt}>
            <Ionicons name="body-outline" size={40} color={tc.primary} style={{ alignSelf: 'center' }} />
            <Text style={styles.bodyScanPromptTitle}>Body Check</Text>
            <Text style={styles.bodyScanPromptText}>
              Take a front-facing photo to estimate body fat percentage, muscle mass, and get personalized feedback.
            </Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
              <TouchableOpacity
                style={[styles.bodyScanBtn, { flex: 1 }, bodyScanLoading && { opacity: 0.55 }]}
                onPress={() => setBodyScanPrepSource('camera')}
                disabled={bodyScanLoading}>
                <View style={styles.bodyScanBtnContent}>
                  <Ionicons name="camera-outline" size={16} color={primaryButtonTextColor} />
                  <Text style={[styles.bodyScanBtnText, { color: primaryButtonTextColor }]}>Camera</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.bodyScanBtn, { flex: 1, backgroundColor: tc.surfaceRaised, borderWidth: 1, borderColor: tc.border }, bodyScanLoading && { opacity: 0.55 }]}
                onPress={() => setBodyScanPrepSource('library')}
                disabled={bodyScanLoading}>
                <View style={styles.bodyScanBtnContent}>
                  <Ionicons name="images-outline" size={16} color={tc.textPrimary} />
                  <Text style={[styles.bodyScanBtnText, { color: tc.textPrimary }]}>Library</Text>
                </View>
              </TouchableOpacity>
            </View>
            <Text style={{ fontSize: 10, color: tc.textMuted, textAlign: 'center', marginTop: 6, lineHeight: 14 }}>
              For best results: front-facing, good lighting, form-fitting clothing. Do not submit nude photos. Accuracy varies with lighting and angle.
            </Text>
          </View>}

          {/* Loading */}
          {isProTier && bodyScanLoading && (
            <View style={{ alignItems: 'center', paddingVertical: 30, gap: 10 }}>
              <ActivityIndicator size="large" color={tc.primary} />
              <Text style={{ fontSize: 13, color: tc.textSecondary }}>Analyzing...</Text>
            </View>
          )}

          {/* Latest result */}
          {isProTier && bodyScanResult && !bodyScanLoading && (
            <>
            <ViewShot ref={bodyScanShareRef} options={{ format: 'png', quality: 1 }}>
            <View style={styles.bodyScanResultCard}>
              <View style={styles.bodyScanResultHeader}>
                <View>
                  <Text style={styles.bodyScanResultCategory}>{bodyScanResult.category}</Text>
                  <Text style={styles.bodyScanResultMuscle}>
                    Muscle mass: {bodyScanResult.muscleMass.replace('_', ' ')}
                  </Text>
                </View>
                <View style={styles.bodyScanBfCircle}>
                  <Text style={styles.bodyScanBfValue}>{bodyScanResult.bodyFatPct}%</Text>
                  <Text style={styles.bodyScanBfLabel}>Body Fat</Text>
                </View>
              </View>
              <Text style={{ fontSize: 11, color: tc.textMuted, marginBottom: 6 }}>
                Estimated range: {bodyScanResult.bodyFatRange}
              </Text>

              <Text style={styles.bodyScanAssessment}>{bodyScanResult.assessment}</Text>

              {bodyScanResult.strengths.length > 0 && (
                <View style={styles.bodyScanSection}>
                  <Text style={styles.bodyScanSectionTitle}>Strengths</Text>
                  {bodyScanResult.strengths.map((s, i) => (
                    <Text key={i} style={styles.bodyScanItem}>✓ {s}</Text>
                  ))}
                </View>
              )}

              {bodyScanResult.improvements.length > 0 && (
                <View style={styles.bodyScanSection}>
                  <Text style={[styles.bodyScanSectionTitle, { color: tc.warning ?? tc.primary }]}>Areas to Improve</Text>
                  {bodyScanResult.improvements.map((s, i) => (
                    <Text key={i} style={styles.bodyScanItem}>→ {s}</Text>
                  ))}
                </View>
              )}

              <Text style={{ fontSize: 10, color: tc.textMuted, fontStyle: 'italic', marginTop: 8 }}>
                {bodyScanResult.disclaimer}
              </Text>
            </View>
            </ViewShot>
            <TouchableOpacity
              onPress={handleShareBodyScan}
              style={{
                marginTop: 10, alignSelf: 'center', paddingHorizontal: 18, paddingVertical: 10,
                borderRadius: 999, backgroundColor: tc.primary,
              }}>
              <Text style={{ color: getContrastingTextColor(tc.primary), fontWeight: '700', fontSize: 13 }}>Share Result</Text>
            </TouchableOpacity>
            </>
          )}

          {isProTier && bodyScanHistory.length > 0 && (() => {
            const fmt = (d: Date) => `${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
            return (
              <View style={[styles.bodyScanHistoryCard, { marginTop: 12 }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary }}>Scan Timeline</Text>
                  <Text style={{ fontSize: 11, color: tc.textMuted }}>{bodyScanHistory.length} saved</Text>
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingRight: 4 }}>
                  {bodyScanHistory.slice(0, 8).map((entry, idx) => {
                    const d = new Date(entry.date);
                    const prior = idx < bodyScanHistory.length - 1 ? bodyScanHistory[idx + 1] : null;
                    const delta = prior ? (Number(entry.bodyFatPct) || 0) - (Number(prior.bodyFatPct) || 0) : null;
                    const deltaColor = delta == null
                      ? tc.textMuted
                      : delta < 0 ? tc.primary : delta > 0 ? (tc.warning ?? tc.textSecondary) : tc.textMuted;
                    return (
                      <View
                        key={entry.id}
                        style={{
                          width: 116,
                          borderRadius: 12,
                          borderWidth: 1,
                          borderColor: idx === 0 ? tc.primary + '88' : tc.border,
                          backgroundColor: idx === 0 ? tc.primary + '0F' : tc.surfaceRaised,
                          padding: 8,
                        }}>
                        <View style={{
                          height: 78,
                          borderRadius: 9,
                          overflow: 'hidden',
                          backgroundColor: tc.surface,
                          alignItems: 'center',
                          justifyContent: 'center',
                          marginBottom: 8,
                        }}>
                          {entry.photoUri ? (
                            <Image source={{ uri: entry.photoUri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                          ) : (
                            <Ionicons name="body-outline" size={24} color={tc.textMuted} />
                          )}
                        </View>
                        <Text style={{ fontSize: 10, fontWeight: '800', color: idx === 0 ? tc.primary : tc.textMuted, textTransform: 'uppercase' }}>
                          {idx === 0 ? 'Latest' : fmt(d)}
                        </Text>
                        <Text style={{ fontSize: 18, fontWeight: '900', color: tc.textPrimary, marginTop: 2 }}>{entry.bodyFatPct}%</Text>
                        <Text style={{ fontSize: 10, color: deltaColor, fontWeight: '800', marginTop: 2 }}>
                          {delta == null ? 'First scan' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}% BF`}
                        </Text>
                      </View>
                    );
                  })}
                </ScrollView>
              </View>
            );
          })()}

          {isProTier && bodyScanHistory.length >= 2 && (() => {
            const latest = bodyScanHistory[0];
            const prior = bodyScanHistory[1];
            if (!latest || !prior) return null;
            const latestDate = new Date(latest.date);
            const priorDate = new Date(prior.date);
            const bfDelta = (Number(latest.bodyFatPct) || 0) - (Number(prior.bodyFatPct) || 0);
            const deltaColor = bfDelta < 0 ? tc.primary : bfDelta > 0 ? (tc.warning ?? tc.textSecondary) : tc.textMuted;
            const fmt = (d: Date) => `${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
            const compareTile = (entry: BodyScanEntry, label: string, date: Date) => (
              <View style={{ flex: 1 }}>
                <View style={{
                  height: 150,
                  borderRadius: 14,
                  overflow: 'hidden',
                  backgroundColor: tc.surfaceRaised,
                  borderWidth: 1,
                  borderColor: tc.border,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  {entry.photoUri ? (
                    <Image source={{ uri: entry.photoUri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                  ) : (
                    <View style={{ alignItems: 'center', padding: 12 }}>
                      <Ionicons name="body-outline" size={28} color={tc.textMuted} />
                      <Text style={{ fontSize: 11, color: tc.textMuted, textAlign: 'center', marginTop: 6 }}>Photo not stored</Text>
                    </View>
                  )}
                </View>
                <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, marginTop: 6, textTransform: 'uppercase' }}>
                  {label} · {fmt(date)}
                </Text>
                <Text style={{ fontSize: 16, fontWeight: '900', color: tc.textPrimary, marginTop: 2 }}>
                  {entry.bodyFatPct}%
                </Text>
              </View>
            );
            return (
              <View style={[styles.bodyScanHistoryCard, { marginTop: 12 }]}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary }}>Before / After</Text>
                  <Text style={{ fontSize: 11, fontWeight: '800', color: deltaColor }}>
                    {bfDelta > 0 ? '+' : ''}{bfDelta.toFixed(1)}% BF
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  {compareTile(prior, 'Before', priorDate)}
                  {compareTile(latest, 'After', latestDate)}
                </View>
              </View>
            );
          })()}

          {/* Timeline — body fat % chart over time. Renders only when 2+
              scans exist (a single point isn't a trend). Pure SVG, matches
              the e1RM chart pattern above so the visual language stays
              consistent across Progress. Muscle-mass tier is rendered as
              a colored chip strip below the chart since the value is
              categorical (low/below_average/average/above_average/high). */}
          {isProTier && bodyScanHistory.length >= 2 && (() => {
            // History is stored newest-first; reverse for chronological plot.
            const sorted = [...bodyScanHistory].slice().reverse();
            const bfValues = sorted.map(e => Number(e.bodyFatPct) || 0).filter(v => v > 0);
            if (bfValues.length < 2) return null;

            const chartW = 320;
            const chartH = 150;
            const padL = 36;
            const padR = 12;
            const padT = 14;
            const padB = 24;
            const plotW = chartW - padL - padR;
            const plotH = chartH - padT - padB;

            // Snap Y range to nice integer bounds, with at least 4% headroom
            // so a flat trend line doesn't render as a dot in the middle.
            const rawMin = Math.min(...bfValues);
            const rawMax = Math.max(...bfValues);
            const span = Math.max(2, rawMax - rawMin);
            const rangeMin = Math.max(0, Math.floor(rawMin - span * 0.25));
            const rangeMax = Math.ceil(rawMax + span * 0.25);
            const rangeDelta = Math.max(1, rangeMax - rangeMin);

            const points = sorted.map((entry, i) => {
              const v = Number(entry.bodyFatPct) || 0;
              const x = padL + (sorted.length === 1 ? plotW / 2 : (i / (sorted.length - 1)) * plotW);
              const y = padT + plotH - ((v - rangeMin) / rangeDelta) * plotH;
              return { x, y, v, entry, i };
            });
            const polyPoints = points.map(p => `${p.x},${p.y}`).join(' ');

            const gridLines = 4;
            const gridVals = Array.from({ length: gridLines }, (_, i) =>
              Math.round(rangeMin + (rangeDelta * (i / (gridLines - 1))))
            );

            // First/current/peak summary stats. Peak = lowest BF observed
            // (improvement direction depends on goal, but lower BF is
            // typically the milestone users want surfaced).
            const firstPct = bfValues[0];
            const currentPct = bfValues[bfValues.length - 1];
            const peakPct = Math.min(...bfValues);
            const delta = currentPct - firstPct;
            const deltaIsImprovement = delta < 0;
            const deltaColor = deltaIsImprovement ? tc.primary : delta > 0 ? (tc.warning ?? tc.textSecondary) : tc.textSecondary;

            // Date labels — only show first/last on dense charts to avoid
            // overlap. Up to 6 labels for sparse charts.
            const showAllLabels = points.length <= 6;
            const firstD = new Date(sorted[0].date);
            const lastD = new Date(sorted[sorted.length - 1].date);
            const fmtDate = (d: Date) => `${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getDate()}`;

            // Muscle-mass tier → ordinal + color for the chip strip.
            const tierMap: Record<string, { ord: number; label: string; color: string }> = {
              low:             { ord: 1, label: 'Low',          color: tc.error ?? '#EF4444' },
              below_average:   { ord: 2, label: 'Below avg',    color: tc.warning ?? '#F59E0B' },
              average:         { ord: 3, label: 'Average',      color: tc.textSecondary },
              above_average:   { ord: 4, label: 'Above avg',    color: tc.primary },
              high:            { ord: 5, label: 'High',         color: tc.primary },
            };

            return (
              <View style={[styles.bodyScanHistoryCard, { marginTop: 12 }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary }}>Body Fat Trend</Text>
                  <Text style={{ fontSize: 11, color: tc.textMuted }}>
                    {points.length} scans · {fmtDate(firstD)} – {fmtDate(lastD)}
                  </Text>
                </View>
                <View style={{ alignItems: 'center', marginVertical: 4 }}>
                  <Svg width={chartW} height={chartH}>
                    {gridVals.map((gv, gi) => {
                      const gy = padT + plotH - ((gv - rangeMin) / rangeDelta) * plotH;
                      return (
                        <Line key={gi} x1={padL} y1={gy} x2={chartW - padR} y2={gy}
                          stroke={tc.border} strokeWidth={1} strokeDasharray="4,4" />
                      );
                    })}
                    {gridVals.map((gv, gi) => {
                      const gy = padT + plotH - ((gv - rangeMin) / rangeDelta) * plotH;
                      return (
                        <SvgText key={`lbl${gi}`} x={padL - 6} y={gy + 4}
                          fontSize={10} fill={tc.textMuted} textAnchor="end">
                          {gv}%
                        </SvgText>
                      );
                    })}
                    <Polyline points={polyPoints}
                      fill="none" stroke={tc.primary} strokeWidth={2.5}
                      strokeLinejoin="round" strokeLinecap="round" />
                    {points.map((p) => (
                      <Circle key={p.i} cx={p.x} cy={p.y}
                        r={p.i === points.length - 1 ? 5 : 3.5}
                        fill={p.i === points.length - 1 ? (tc.accent ?? tc.primary) : tc.primary}
                        stroke={tc.surface} strokeWidth={1.5} />
                    ))}
                    {showAllLabels
                      ? points.map((p) => (
                          <SvgText key={`d${p.i}`} x={p.x} y={chartH - 6}
                            fontSize={9} fill={tc.textMuted} textAnchor="middle">
                            {fmtDate(new Date(p.entry.date))}
                          </SvgText>
                        ))
                      : (
                        <>
                          <SvgText x={points[0].x} y={chartH - 6}
                            fontSize={9} fill={tc.textMuted} textAnchor="start">
                            {fmtDate(firstD)}
                          </SvgText>
                          <SvgText x={points[points.length - 1].x} y={chartH - 6}
                            fontSize={9} fill={tc.textMuted} textAnchor="end">
                            {fmtDate(lastD)}
                          </SvgText>
                        </>
                      )}
                  </Svg>
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-around', marginTop: 6, paddingHorizontal: 6 }}>
                  <View style={{ alignItems: 'center' }}>
                    <Text style={{ fontSize: 16, fontWeight: '800', color: tc.textPrimary }}>{currentPct.toFixed(1)}%</Text>
                    <Text style={{ fontSize: 9, color: tc.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 }}>Current</Text>
                  </View>
                  <View style={{ alignItems: 'center' }}>
                    <Text style={{ fontSize: 16, fontWeight: '800', color: tc.textPrimary }}>{peakPct.toFixed(1)}%</Text>
                    <Text style={{ fontSize: 9, color: tc.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 }}>Best</Text>
                  </View>
                  <View style={{ alignItems: 'center' }}>
                    <Text style={{ fontSize: 16, fontWeight: '800', color: deltaColor }}>
                      {delta > 0 ? '+' : ''}{delta.toFixed(1)}%
                    </Text>
                    <Text style={{ fontSize: 9, color: tc.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 }}>vs first</Text>
                  </View>
                </View>

                {/* Muscle-mass timeline — categorical, so we render as a
                    horizontal strip of pill chips colored by tier. Lets the
                    user see "I went from average → above average" without
                    needing a numeric chart for an ordinal value. */}
                {(() => {
                  const tieredScans = sorted
                    .map(e => ({ entry: e, t: tierMap[(e.muscleMass || '').toLowerCase()] }))
                    .filter(x => x.t);
                  if (tieredScans.length < 2) return null;
                  return (
                    <View style={{ marginTop: 14 }}>
                      <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 6 }}>
                        MUSCLE MASS BY SCAN
                      </Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        {tieredScans.map(({ entry, t }, i) => (
                          <View key={`mm-${i}`} style={{
                            paddingHorizontal: 10, paddingVertical: 6,
                            borderRadius: 999, marginRight: 6,
                            backgroundColor: t.color + '22',
                            borderWidth: 1, borderColor: t.color + '88',
                          }}>
                            <Text style={{ fontSize: 10, fontWeight: '800', color: t.color }}>{t.label}</Text>
                            <Text style={{ fontSize: 9, color: tc.textMuted, marginTop: 1 }}>
                              {fmtDate(new Date(entry.date))}
                            </Text>
                          </View>
                        ))}
                      </ScrollView>
                    </View>
                  );
                })()}
              </View>
            );
          })()}

          {/* History */}
          {isProTier && bodyScanHistory.length > 0 && (
            <>
              <Text style={[styles.sectionLabel, { marginTop: 16 }]}>Scan History</Text>
              {bodyScanHistory.map((entry, idx) => {
                const d = new Date(entry.date);
                // Show per-scan delta vs the previous (older) scan so users
                // can see whether each individual scan was an improvement.
                // bodyScanHistory is newest-first, so the "previous" scan is
                // the next index. Skip the oldest scan (no prior to compare).
                const prior = idx < bodyScanHistory.length - 1 ? bodyScanHistory[idx + 1] : null;
                const priorBf = prior ? Number(prior.bodyFatPct) || 0 : null;
                const currBf = Number(entry.bodyFatPct) || 0;
                const scanDelta = priorBf != null && currBf > 0 ? currBf - priorBf : null;
                const scanDeltaColor = scanDelta == null
                  ? tc.textMuted
                  : scanDelta < 0 ? tc.primary : scanDelta > 0 ? (tc.warning ?? tc.textSecondary) : tc.textMuted;
                return (
                  <View key={entry.id} style={styles.bodyScanHistoryCard}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <View>
                        <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }}>{entry.category}</Text>
                        <Text style={{ fontSize: 11, color: tc.textMuted }}>
                          {MONTH_NAMES[d.getMonth()]} {d.getDate()}, {d.getFullYear()}
                          {entry.weightLbs ? `  ·  ${entry.weightLbs} lbs` : ''}
                        </Text>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text style={{ fontSize: 20, fontWeight: '800', color: tc.primary }}>{entry.bodyFatPct}%</Text>
                        <Text style={{ fontSize: 9, color: tc.textMuted, textTransform: 'uppercase' }}>Body Fat</Text>
                        {scanDelta != null && (
                          <Text style={{ fontSize: 10, fontWeight: '700', color: scanDeltaColor, marginTop: 2 }}>
                            {scanDelta > 0 ? '+' : ''}{scanDelta.toFixed(1)}% vs prior
                          </Text>
                        )}
                      </View>
                    </View>
                    <Text style={{ fontSize: 12, color: tc.textSecondary, marginTop: 6, lineHeight: 17 }}>{entry.assessment}</Text>
                  </View>
                );
              })}
            </>
          )}
        </ScrollView>
      ) : null}
      </FadeInView>
      )}
      {/* Weight Log Modal */}
      {weightInputVisible && (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', zIndex: 999 }}>
          <View style={{ backgroundColor: tc.surface, borderRadius: radius.lg, padding: 24, width: '80%', maxWidth: 320, borderWidth: 1, borderColor: tc.border }}>
            <Text style={{ fontSize: 17, fontWeight: '700', color: tc.textPrimary, marginBottom: 16, textAlign: 'center' }}>Log Weight</Text>
            <TextInput
              {...dynamicInputProps}
              style={{ borderWidth: 1, borderColor: tc.border, borderRadius: radius.md, padding: 14, fontSize: 18, color: tc.textPrimary, backgroundColor: tc.background, textAlign: 'center', fontWeight: '700' }}
              value={weightInputValue}
              onChangeText={(v) => {
                setWeightInputValue(v);
                if (weightInputError) setWeightInputError('');
              }}
              keyboardType="decimal-pad"
              placeholder="e.g. 175"
              placeholderTextColor={tc.textMuted}
              autoFocus
            />
            <Text style={{ fontSize: 12, color: tc.textMuted, textAlign: 'center', marginTop: 6 }}>lbs</Text>
            {weightInputError ? (
              <Text {...dynamicTextProps} style={{ fontSize: 12, color: tc.error, textAlign: 'center', marginTop: 8 }}>
                {weightInputError}
              </Text>
            ) : null}
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <TouchableOpacity
                style={{ flex: 1, paddingVertical: 12, borderRadius: radius.md, backgroundColor: tc.surfaceRaised, alignItems: 'center', borderWidth: 1, borderColor: tc.border }}
                onPress={() => {
                  setWeightInputError('');
                  setWeightInputVisible(false);
                }}>
                <Text style={{ fontSize: 15, fontWeight: '600', color: tc.textSecondary }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{ flex: 1, paddingVertical: 12, borderRadius: radius.md, backgroundColor: tc.primary, alignItems: 'center' }}
                onPress={async () => {
                  const val = parseFloat(weightInputValue);
                  if (!val || val < 50 || val > 700) {
                    setWeightInputError('Please enter a weight between 50 and 700 lbs.');
                    return;
                  }
                  const { saveWeightEntry } = await import('../utils/weightHistory');
                  const updated = await saveWeightEntry(val, 'manual');
                  setWeightEntries(updated);
                  setWeightInputVisible(false);
                  if (onUpdateWeight) onUpdateWeight(val);
                  import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
                }}>
                <Text style={{ fontSize: 15, fontWeight: '700', color: getContrastingTextColor(tc.primary) }}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}
      <Modal
        visible={!!bodyScanPrepSource}
        transparent
        animationType="fade"
        onRequestClose={() => setBodyScanPrepSource(null)}>
        <View style={styles.bodyScanPrepBackdrop}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setBodyScanPrepSource(null)}
          />
          <View style={styles.bodyScanPrepSheet}>
            <View style={styles.bodyScanPrepHandle} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <View style={styles.bodyScanPrepIcon}>
                <Ionicons name="body-outline" size={18} color={tc.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.bodyScanPrepTitle}>Before body check</Text>
                <Text style={styles.bodyScanPrepSub}>
                  {bodyScanPrepSource === 'camera' ? 'Camera works best with a quick setup check.' : 'Choose a clear, recent front-facing photo.'}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setBodyScanPrepSource(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={20} color={tc.textMuted} />
              </TouchableOpacity>
            </View>
            <View style={styles.bodyScanPrepChecklist}>
              {[
                { icon: 'sunny-outline', text: 'Use bright, even lighting with the full body in frame.' },
                { icon: 'resize-outline', text: 'Stand straight, arms relaxed slightly away from your torso.' },
                { icon: 'shirt-outline', text: 'Wear form-fitting clothing, not nude; shorts and a fitted top work well.' },
                { icon: 'shield-checkmark-outline', text: 'Only the selected photo is sent for this analysis; keep faces out if you prefer.' },
              ].map(item => (
                <View key={item.text} style={styles.bodyScanPrepRow}>
                  <Ionicons name={item.icon as any} size={16} color={tc.primary} />
                  <Text style={styles.bodyScanPrepText}>{item.text}</Text>
                </View>
              ))}
            </View>
            <Text style={styles.bodyScanPrepFootnote}>
              The result is an estimate, so compare scans taken under similar conditions instead of treating one scan as exact.
            </Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <TouchableOpacity
                style={styles.bodyScanPrepSecondary}
                onPress={() => setBodyScanPrepSource(null)}>
                <Text style={styles.bodyScanPrepSecondaryText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.bodyScanPrepPrimary}
                onPress={() => {
                  const source = bodyScanPrepSource;
                  setBodyScanPrepSource(null);
                  if (source) handleBodyScan(source);
                }}>
                <Text style={styles.bodyScanPrepPrimaryText}>
                  {bodyScanPrepSource === 'camera' ? 'Open Camera' : 'Choose Photo'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      <BodyMeasurementsModal
        visible={measurementsModalVisible}
        authToken={authToken}
        currentWeight={userProfile.physicalStats?.weightLbs}
        themeName={userProfile.themePreference}
        onClose={() => setMeasurementsModalVisible(false)}
        onSaved={() => import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {})}
      />
      <LogActivityModal
        visible={showLogActivity}
        onClose={() => setShowLogActivity(false)}
        themeName={themeName}
        onSave={async (session) => {
          await saveWorkoutSession(session);
          if (authToken) {
            try {
              const { logWorkoutDone } = await import('../services/api');
              const dk = dateKey(new Date(session.date));
              await logWorkoutDone(
                authToken, dk, session.focus, session.durationSeconds,
                undefined,
                session.manualActivity ? {
                  category: session.manualActivity.category,
                  subtype: session.manualActivity.subtype,
                  intensity: session.manualActivity.intensity,
                  source: session.manualActivity.source,
                  cardioStyle: session.manualActivity.cardioStyle,
                  distanceMiles: session.manualActivity.distanceMiles,
                  caloriesBurned: session.manualActivity.caloriesBurned,
                  avgHeartRate: session.manualActivity.avgHeartRate,
                } : undefined,
              );
            } catch {}
          }
          const [h, s] = await Promise.all([loadWorkoutHistory(), loadWorkoutSummaries()]);
          setHistory(h);
          setSummaries(s);
          import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
        }}
      />

      {/* Plateau modal — listing each stuck exercise with a suggestion (Feature 5) */}
      <Modal
        visible={plateauModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setPlateauModalVisible(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 24 }}>
          <View style={{ backgroundColor: tc.surface, borderRadius: 16, padding: 20, maxHeight: '80%' }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: tc.textPrimary }}>Plateaus</Text>
              <TouchableOpacity onPress={() => setPlateauModalVisible(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={tc.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView>
              {plateaus.map((p, i) => {
                const suggestionCopy =
                  p.suggestion === 'deload'
                    ? 'Try a deload week: cut volume by 30-40% and come back fresh next week.'
                    : p.suggestion === 'swap'
                    ? 'Swap this exercise for a variation — the current movement has run its course.'
                    : 'Add volume: 1-2 extra sets or an additional day hitting this lift.';
                return (
                  <View
                    key={`${p.exercise_name}-${i}`}
                    style={{ marginBottom: 14, backgroundColor: tc.background, padding: 12, borderRadius: 10 }}>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }}>
                      {p.exercise_name}
                    </Text>
                    <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 2 }}>
                      est 1RM {Math.round(p.current_1rm)} lb · flat for {p.weeks_stuck} weeks
                    </Text>
                    <Text style={{ fontSize: 12, color: tc.textPrimary, marginTop: 6, lineHeight: 16 }}>
                      {suggestionCopy}
                    </Text>
                  </View>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function createStyles(colors: ReturnType<typeof getTheme>['colors']) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  inlineContainer: { backgroundColor: 'transparent' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 56, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  backBtn: { ...typography.bodyStrong, color: colors.primary, width: 60 },
  title:   { ...typography.screenTitle, color: colors.textPrimary },

  tabs: {
    flexDirection: 'row', gap: 2,
    backgroundColor: colors.surface, borderRadius: 999,
    padding: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    marginHorizontal: 16, marginTop: 10, marginBottom: 8,
    ...elevations.subtle,
  },
  tab:           { flex: 1, paddingVertical: 9, borderRadius: 999, alignItems: 'center' },
  tabActive:     { backgroundColor: colors.primary + '1C' },
  tabText:       { ...typography.label, color: colors.textSecondary, opacity: 0.6 },
  tabTextActive: { color: colors.primary, fontWeight: '700', opacity: 1 },

  center:  { flex: 1, justifyContent: 'center', alignItems: 'center' },
  // Bottom padding clears the fixed 5-tab bottom nav bar (~57 px +
  // safe area). Otherwise the bottom of the content (sign-out,
  // delete-last-entry, etc.) sits under the tab bar.
  content: { padding: 16, paddingBottom: 140, paddingTop: 12 },

  sectionLabel: {
    ...typography.label,
    color: colors.textSecondary,
    marginBottom: 12,
  },

  weekOverviewCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginBottom: 16,
  },
  weekOverviewHeader: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 12,
  },
  weekOverviewEyebrow: {
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.6,
    color: colors.textMuted,
  },
  weekOverviewTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: colors.textPrimary,
    marginTop: 2,
  },
  weekOverviewHint: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
  },
  weekOverviewGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  weekOverviewTile: {
    flexGrow: 1,
    flexBasis: '47%',
    minHeight: 122,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    padding: 11,
  },
  weekOverviewIcon: {
    width: 28,
    height: 28,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  weekOverviewLabel: {
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
  weekOverviewValue: {
    fontSize: 22,
    fontWeight: '900',
    color: colors.textPrimary,
    marginTop: 2,
  },
  weekOverviewDetail: {
    fontSize: 11,
    color: colors.textSecondary,
    lineHeight: 15,
    marginTop: 3,
  },

  emptyBox:  { alignItems: 'center', paddingTop: 60, gap: 12 },
  emptyIcon: { fontSize: 48 },
  emptyTitle:{ fontSize: 18, fontWeight: '700', color: colors.textPrimary },
  emptyBody: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 20, paddingHorizontal: 24 },

  prSearchInput: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.textPrimary,
    marginBottom: 10,
  },
  prFilterRow: { flexDirection: 'row', gap: 8, paddingBottom: 10 },
  prFilterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  prFilterChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  prFilterChipText: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },
  prFilterChipTextActive: { color: colors.background },

  prCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: radius.lg,
    padding: 14, marginBottom: 8,
    borderWidth: 1, borderColor: colors.border,
    borderLeftWidth: 3, borderLeftColor: colors.primary,
    ...elevations.subtle,
  },
  prLeft:   { flex: 1 },
  prName:   { ...typography.cardTitle, color: colors.textPrimary, marginBottom: 3 },
  prMeta:   { ...typography.micro, color: colors.textMuted },
  prRight:  { alignItems: 'flex-end' },
  prWeight: { fontSize: 22, fontWeight: '800', color: colors.primary },
  prUnit:   { ...typography.micro, color: colors.textSecondary, marginTop: -4 },
  prReps:   { ...typography.micro, color: colors.textMuted, marginTop: 2 },

  insightsCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginBottom: 12,
  },
  insightsTitle: { fontSize: 14, fontWeight: '700', color: colors.textPrimary, marginBottom: 8 },
  insightsLine: { fontSize: 12, color: colors.textSecondary, marginBottom: 4 },
  guardrailText: { fontSize: 12, color: colors.warning, marginBottom: 3 },
  memoryText: { fontSize: 12, color: colors.textSecondary, marginBottom: 3 },
  progressionHint: { fontSize: 12, color: colors.primary, marginTop: 4, fontWeight: '600' },

  weightCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginBottom: 12,
    ...elevations.card,
  },
  weightCardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  weightTitle: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  updateWeightBtn: {
    borderWidth: 1, borderColor: colors.primary,
    borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 5,
  },
  updateWeightBtnText: { fontSize: 12, fontWeight: '700', color: colors.primary },
  weightInputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  weightInput: {
    flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 10, fontSize: 15, color: colors.textPrimary, backgroundColor: colors.surfaceRaised,
  },
  weightConfirmBtn: { backgroundColor: colors.primary, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 10 },
  weightConfirmText: { fontSize: 13, fontWeight: '700', color: getContrastingTextColor(colors.primary) },
  weightCancelBtn: { paddingHorizontal: 8, paddingVertical: 10 },
  weightCancelText: { fontSize: 13, color: colors.textSecondary },
  weightRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  weightMetric: {
    flex: 1,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  weightMetricLabel: { fontSize: 11, color: colors.textSecondary, marginBottom: 2 },
  weightMetricValue: { fontSize: 13, fontWeight: '700', color: colors.textPrimary },
  weightEta: { fontSize: 12, color: colors.textSecondary },

  graphCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginBottom: 12,
    ...elevations.card,
  },
  graphHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 },
  graphTitle: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  graphScore: { fontSize: 20, fontWeight: '800', color: colors.primary },
  graphSubtitle: { fontSize: 12, color: colors.textSecondary, marginBottom: 10 },
  graphBars: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 6, minHeight: 120 },
  graphBarCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', gap: 4 },
  graphBarValue: { fontSize: 10, color: colors.textMuted },
  graphBar: { width: '75%', backgroundColor: colors.primary, borderRadius: 6 },
  graphBarLabel: { fontSize: 10, color: colors.textSecondary },

  sessionCard: {
    backgroundColor: colors.surface, borderRadius: radius.lg,
    padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: colors.border,
    ...elevations.subtle,
  },
  sessionHeader: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 },
  sessionFocus:  { fontSize: 15, fontWeight: '700', color: colors.textPrimary, marginBottom: 2 },
  sessionDate:   { fontSize: 12, color: colors.textMuted },
  sessionBadge:  { backgroundColor: colors.surfaceRaised, borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: colors.border },
  sessionBadgeText: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },
  sessionStats:  { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  sessionStat:   { fontSize: 12, color: colors.textSecondary },
  sessionStatDot:{ fontSize: 12, color: colors.textMuted },
  exRow:    { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  exName:   { fontSize: 13, color: colors.textPrimary },
  exBest:   { fontSize: 13, color: colors.primary, fontWeight: '600' },

  exerciseChip: {
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  exerciseChipActive: { borderColor: colors.primary, backgroundColor: colors.primary + '20' },
  exerciseChipText: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },
  exerciseChipTextActive: { color: colors.primary },

  chartModeBtn: {
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.border,
  },
  chartModeBtnActive: { borderColor: colors.primary, backgroundColor: colors.primary },
  chartModeBtnText: { fontSize: 11, color: colors.textSecondary, fontWeight: '700' },
  chartModeBtnTextActive: { color: colors.background },

  chartSummaryRow: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border },
  chartStat: { alignItems: 'center', gap: 2 },
  chartStatValue: { fontSize: 15, fontWeight: '800', color: colors.textPrimary },
  chartStatLabel: { fontSize: 10, color: colors.textMuted, fontWeight: '500' },

  // ── Fitness Score Card ──
  fitnessScoreCard: {
    backgroundColor: colors.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    marginBottom: 16,
    gap: 12,
    ...elevations.card,
  },
  shareCardLogo: {
    width: 180,
    height: 40,
    alignSelf: 'center',
    marginBottom: 4,
    opacity: 0.85,
  },
  fitnessScoreHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  fitnessScoreLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  fitnessVerdict: {
    fontSize: 17,
    fontWeight: '800',
    color: colors.textPrimary,
    marginBottom: 10,
    lineHeight: 22,
  },
  fitnessScoreSubtext: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 2,
  },
  fitnessScoreCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.primary + '18',
    borderWidth: 3,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fitnessScoreValue: {
    fontSize: 24,
    fontWeight: '900',
    color: colors.primary,
  },
  fitnessScoreRating: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.textPrimary,
    textAlign: 'center',
  },
  fitnessBreakdown: { gap: 10 },
  fitnessBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  fitnessBarLabel: { width: 100 },
  fitnessBarLabelText: { fontSize: 12, fontWeight: '600', color: colors.textPrimary },
  fitnessBarDetail: { fontSize: 10, color: colors.textMuted },
  fitnessBarTrack: {
    flex: 1,
    height: 8,
    backgroundColor: colors.surfaceRaised,
    borderRadius: 4,
    overflow: 'hidden',
  },
  fitnessBarFill: {
    height: '100%',
    backgroundColor: colors.primary,
    borderRadius: 4,
  },
  fitnessBarScore: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary,
    width: 32,
    textAlign: 'right',
  },

  fitnessShareBtn: {
    marginTop: 12,
    alignSelf: 'center',
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.primary + '12',
  },
  fitnessShareBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.primary,
  },

  // ── Apple Health vitals card (Body Check tab) ──
  vitalsCard: {
    backgroundColor: colors.surface,
    borderRadius: 20,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: colors.border,
    ...elevations.card,
  },
  vitalsHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  vitalsTitle: { ...typography.cardTitle },
  vitalsSubtitle: { ...typography.micro, marginLeft: 'auto' },
  vitalsGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  vitalsCell: { width: '33.333%', paddingVertical: 8, alignItems: 'center' },
  vitalsValue: { fontSize: 18, fontWeight: '700' },
  vitalsLabel: { fontSize: 10, fontWeight: '600', marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 },

  // ── Recovery / Apple Health ──
  recoverySection: {
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 8,
  },
  recoveryHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  recoverySectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  recoveryBadge: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  recoveryAdvice: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  healthMetricsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
  },
  healthScoreLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  healthScoreValue: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.primary,
  },
  healthMetricsGrid: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: 8,
    paddingVertical: 8,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
  },
  healthMetric: {
    alignItems: 'center',
    gap: 2,
  },
  healthMetricValue: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  healthMetricLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
  },
  healthFetchedAt: {
    fontSize: 10,
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: 2,
  },

  // ── Body Scan ──
  bodyScanPrompt: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 20,
    alignItems: 'center',
    gap: 6,
    marginBottom: 16,
  },
  bodyScanPromptTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  bodyScanPromptText: {
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 19,
  },
  bodyScanBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 12,
    alignItems: 'center',
  },
  bodyScanBtnContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  bodyScanBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: getContrastingTextColor(colors.primary),
  },
  bodyScanPrepBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.58)',
    justifyContent: 'flex-end',
  },
  bodyScanPrepSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 22,
  },
  bodyScanPrepHandle: {
    width: 42,
    height: 4,
    borderRadius: 999,
    backgroundColor: colors.border,
    alignSelf: 'center',
    marginBottom: 14,
  },
  bodyScanPrepIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.primary + '18',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bodyScanPrepTitle: {
    fontSize: 17,
    fontWeight: '900',
    color: colors.textPrimary,
  },
  bodyScanPrepSub: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
  },
  bodyScanPrepChecklist: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    gap: 10,
  },
  bodyScanPrepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
  },
  bodyScanPrepText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textSecondary,
  },
  bodyScanPrepFootnote: {
    fontSize: 11,
    lineHeight: 16,
    color: colors.textMuted,
    marginTop: 10,
  },
  bodyScanPrepSecondary: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    backgroundColor: colors.surfaceRaised,
  },
  bodyScanPrepSecondaryText: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.textSecondary,
  },
  bodyScanPrepPrimary: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radius.md,
    alignItems: 'center',
    backgroundColor: colors.primary,
  },
  bodyScanPrepPrimaryText: {
    fontSize: 14,
    fontWeight: '900',
    color: getContrastingTextColor(colors.primary),
  },
  bodyScanResultCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    gap: 8,
  },
  bodyScanResultHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  bodyScanResultCategory: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  bodyScanResultMuscle: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
    textTransform: 'capitalize',
  },
  bodyScanBfCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.primary + '15',
    borderWidth: 3,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bodyScanBfValue: {
    fontSize: 20,
    fontWeight: '900',
    color: colors.primary,
  },
  bodyScanBfLabel: {
    fontSize: 9,
    color: colors.textMuted,
    textTransform: 'uppercase',
    fontWeight: '600',
    marginTop: -2,
  },
  bodyScanAssessment: {
    fontSize: 14,
    color: colors.textPrimary,
    lineHeight: 20,
  },
  bodyScanSection: {
    gap: 4,
  },
  bodyScanSectionTitle: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.primary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  bodyScanItem: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 18,
    paddingLeft: 4,
  },
  bodyScanHistoryCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginBottom: 8,
  },
}); }
