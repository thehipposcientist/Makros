import React, { memo, useEffect, useMemo, useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  ImageBackground,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import type { ImageSourcePropType, StyleProp, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle } from 'react-native-svg';

import type { AppThemeName, DailyNutritionPlan, WorkoutDay } from '../types';
import type { HealthDataSummary } from '../services/healthDataSummary';
import type { GoalScoreResult } from '../services/api';
import { getContrastingTextColor, radius } from '../constants/theme';
import { TIMING_SMOOTH, useReducedMotion } from '../utils/motion';
import FadeInView from './FadeInView';
import LifestyleFactorsCard from './LifestyleFactorsCard';
import MacroDonutRow from './MacroDonutRow';
import PressableScale from './PressableScale';
import SunExposureHealthCard from './SunExposureHealthCard';

type ResumeInfo = {
  focus: string;
  setsLogged: number;
  hasActiveTimer: boolean;
  startedAt: number;
} | null;

type IconName = React.ComponentProps<typeof Ionicons>['name'];

export type HomeReminderPrompt = {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  icon: IconName;
  accent: string;
  primaryLabel: string;
  secondaryLabel?: string;
  queueCount?: number;
  onPrimary: () => void;
  onSecondary?: () => void;
};

export type HomeReadinessAlert = {
  title: string;
  detail: string;
  score?: number | null;
  label?: string | null;
  tone: 'warning' | 'danger';
  icon?: IconName;
  chips?: string[];
};

type TodayHomeTabProps = {
  themeName?: AppThemeName;
  /** Required for the Life Events pill — auth + the day to log against.
   *  Optional so older callers keep compiling; the pill is skipped when
   *  either is missing. */
  authToken?: string;
  todayDateKey?: string;
  themeColors: any;
  workoutAccent: string;
  mealsAccent: string;
  userDisplayName?: string | null;
  goalLabel: string;
  todayWorkout: WorkoutDay | null;
  workoutImageSource: ImageSourcePropType | null;
  workoutFocusLabel: string | null;
  workoutTypeLabel: string | null;
  workoutTypeAccent: string | null;
  todayWorkoutMinutes: number | null;
  todayIsRest: boolean;
  todayDone: boolean;
  todaySkipped: boolean;
  resumeInfo: ResumeInfo;
  readinessScore: {
    score: number;
    label: string;
    topFatigued?: Array<{ muscle: string; value: number }>;
    nutritionContext?: { message?: string | null; protein_status?: string | null; protein_avg?: number | null } | null;
  } | null;
  healthSummary: HealthDataSummary | null;
  healthLoading: boolean;
  readinessAlert?: HomeReadinessAlert | null;
  homePrompt?: HomeReminderPrompt | null;
  nutritionPlan: DailyNutritionPlan | null;
  nutritionScore: number | null;
  loggedNutrition: { calories: number; protein_g: number; carbs_g: number; fat_g: number } | null;
  hydration: {
    ounces: number;
    target_ounces: number;
    target_ounces_min?: number | null;
    target_ounces_max?: number | null;
  } | null;
  hydrationQuickAddLabel: string;
  hydrationQuickRemoveLabel: string;
  hydrationLoading: boolean;
  stepsToday: number | null;
  goalLoading: boolean;
  goalProgressPct: number | null;
  /** "Day X/42" anchored to the user's goalStartedAt — mirrors the
   *  GoalExecutionGraph on the Progress screen. */
  goalDayLabel?: string | null;
  trackingScorePct?: number | null;
  goalScore?: GoalScoreResult | null;
  showWorkoutsSurface: boolean;
  showMealsSurface: boolean;
  showSunExposureSurface?: boolean;
  onChromeScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onStartWorkout: () => void;
  onStartActivity?: () => void;
  onLogActivity?: () => void;
  onResumeWorkout: () => void;
  onOpenWorkouts: () => void;
  onOpenMeals: () => void;
  onOpenProgress: () => void;
  onOpenSleepProgress: () => void;
  onOpenReadiness: () => void;
  onLogMeal: () => void;
  /** Optional camera quick-log entry: opens the new-meal editor where the AI
   *  photo scan is the primary action. Hidden when not provided. */
  onScanMeal?: () => void;
  /** Optional packaged-food quick-log entry: opens the new-meal editor and
   *  immediately starts the barcode scanner. Hidden when not provided. */
  onScanBarcodeMeal?: () => void;
  onQuickAddWater: () => void;
  onQuickRemoveWater: () => void;
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function clampPct(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function scoreTone(score: number | null | undefined, tc: any) {
  if (score == null) return tc.textMuted;
  if (score >= 75) return tc.success;
  if (score >= 55) return tc.warning;
  return tc.error;
}

function formatTodayDate() {
  const now = new Date();
  return `${DAY_NAMES[now.getDay()]}, ${MONTH_NAMES[now.getMonth()]} ${now.getDate()}`;
}

function formatGreeting(name?: string | null) {
  const hour = new Date().getHours();
  const prefix = hour < 12
    ? 'Good morning'
    : hour < 17
      ? 'Good afternoon'
      : 'Good evening';
  const cleanName = String(name ?? '').trim().replace(/^@+/, '').split(/\s+/)[0];
  return cleanName ? `${prefix}, ${cleanName}` : prefix;
}

function formatStartedAgo(startedAt: number) {
  const mins = Math.max(0, Math.round((Date.now() - startedAt) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest > 0 ? `${hours}h ${rest}m ago` : `${hours}h ago`;
}

function TodayHomeTab({
  themeName,
  authToken,
  todayDateKey,
  themeColors,
  workoutAccent,
  mealsAccent,
  userDisplayName,
  goalLabel,
  todayWorkout,
  workoutImageSource,
  workoutFocusLabel,
  workoutTypeLabel,
  workoutTypeAccent,
  todayWorkoutMinutes,
  todayIsRest,
  todayDone,
  todaySkipped,
  resumeInfo,
  readinessScore,
  healthSummary,
  healthLoading,
  readinessAlert,
  homePrompt,
  nutritionPlan,
  nutritionScore,
  loggedNutrition,
  hydration,
  hydrationQuickAddLabel,
  hydrationQuickRemoveLabel,
  hydrationLoading,
  stepsToday,
  goalLoading,
  goalProgressPct,
  goalDayLabel,
  trackingScorePct,
  goalScore,
  showWorkoutsSurface,
  showMealsSurface,
  showSunExposureSurface = false,
  onChromeScroll,
  onStartWorkout,
  onStartActivity,
  onLogActivity,
  onResumeWorkout,
  onOpenWorkouts,
  onOpenMeals,
  onOpenProgress,
  onOpenSleepProgress,
  onOpenReadiness,
  onLogMeal,
  onScanMeal,
  onScanBarcodeMeal,
  onQuickAddWater,
  onQuickRemoveWater,
}: TodayHomeTabProps) {
  const todayDate = useMemo(formatTodayDate, []);
  const greeting = useMemo(() => formatGreeting(userDisplayName), [userDisplayName]);
  const rawSleepScore = (healthSummary?.raw as any)?.sleepScore ?? null;
  const sleepScore = rawSleepScore?.score ?? null;
  const sleepRating = rawSleepScore?.rating ?? null;
  const sleepHours = rawSleepScore?.duration != null
    ? Math.round(Number(rawSleepScore.duration) * 10) / 10
    : healthSummary?.sleepMinutes != null
    ? Math.round((healthSummary.sleepMinutes / 60) * 10) / 10
    : null;
  const readinessColor = scoreTone(readinessScore?.score ?? null, themeColors);
  const nutritionScoreColor = scoreTone(nutritionScore, themeColors);
  const targetCalories = nutritionPlan?.targets?.calories ?? null;
  const loggedCalories = loggedNutrition?.calories ?? null;
  const loggedProtein = loggedNutrition?.protein_g ?? null;
  const loggedCarbs = loggedNutrition?.carbs_g ?? null;
  const loggedFat = loggedNutrition?.fat_g ?? null;
  const hydrationTarget = hydration?.target_ounces ?? null;
  const hydrationRemoveDisabled = hydrationLoading || (hydration?.ounces ?? 0) <= 0;
  const hydrationLabel = hydration
    ? `${Math.round(hydration.ounces)} / ${Math.round(hydration.target_ounces)} oz`
    : 'No water logged';
  const heroTextPrimary = workoutImageSource ? '#FFFFFF' : themeColors.textPrimary;
  const heroTextSecondary = workoutImageSource ? 'rgba(255,255,255,0.80)' : themeColors.textSecondary;
  const stepsLabel = stepsToday != null ? `${Math.round(stepsToday).toLocaleString()} steps` : healthLoading ? 'Steps loading' : null;

  const workoutTitle = workoutFocusLabel ?? todayWorkout?.focus ?? 'Today';
  const completedWorkoutTitle = workoutFocusLabel ?? todayWorkout?.focus ?? 'Workout';
  const exerciseCount = todayWorkout?.exercises?.length ?? 0;
  const workoutDetail = todayWorkoutMinutes
    ? `${todayWorkoutMinutes} min${exerciseCount > 0 ? ` - ${exerciseCount} exercises` : ''}`
    : exerciseCount > 0 ? `${exerciseCount} exercises` : null;
  const workoutTypeColor = workoutTypeAccent ?? workoutAccent;
  const isEmptyCustomWorkout = !!todayWorkout && exerciseCount === 0;
  const showDoneWorkoutState = todayDone && showWorkoutsSurface;

  const primary = (() => {
    if (resumeInfo) {
      return {
        icon: 'play-circle' as IconName,
        title: `Resume ${resumeInfo.focus}`,
        subtitle: `${resumeInfo.setsLogged > 0 ? `${resumeInfo.setsLogged} set${resumeInfo.setsLogged === 1 ? '' : 's'} logged` : 'Timer in progress'} - started ${formatStartedAgo(resumeInfo.startedAt)}`,
        actionLabel: 'Resume',
        accent: workoutAccent,
        onPress: onResumeWorkout,
      };
    }
    if (!showWorkoutsSurface && showMealsSurface) {
      return {
        icon: 'restaurant' as IconName,
        title: 'Log the next meal',
        subtitle: targetCalories ? `${Math.round(loggedCalories ?? 0)} of ${Math.round(targetCalories)} calories logged` : 'Keep today simple and accurate.',
        actionLabel: 'Open Meals',
        accent: mealsAccent,
        onPress: onOpenMeals,
      };
    }
    if (todayDone) {
      return {
        icon: 'checkmark-circle' as IconName,
        title: completedWorkoutTitle,
        subtitle: workoutTypeLabel ?? workoutDetail ?? 'Completed today',
        actionLabel: showWorkoutsSurface ? 'View Week' : 'View Progress',
        accent: themeColors.success,
        onPress: showWorkoutsSurface ? onOpenWorkouts : onOpenProgress,
      };
    }
    if (todaySkipped) {
      return {
        icon: 'pause-circle' as IconName,
        title: 'Workout skipped',
        subtitle: 'Keep the rest of the day steady.',
        actionLabel: 'View Week',
        accent: themeColors.warning,
        onPress: onOpenWorkouts,
      };
    }
    if (todayIsRest) {
      return {
        icon: 'leaf' as IconName,
        title: 'Recovery day',
        subtitle: 'No lift is scheduled today.',
        actionLabel: showWorkoutsSurface ? 'View Week' : 'View Progress',
        accent: themeColors.primary,
        onPress: showWorkoutsSurface ? onOpenWorkouts : onOpenProgress,
      };
    }
    if (!todayWorkout && showWorkoutsSurface) {
      return {
        icon: 'add-circle' as IconName,
        title: 'Start custom workout',
        subtitle: 'No workout is assigned today.',
        actionLabel: 'Start Activity',
        accent: workoutAccent,
        onPress: onStartWorkout,
      };
    }
    if (!todayWorkout) {
      return {
        icon: 'pulse-outline' as IconName,
        title: 'Today is open',
        subtitle: 'No workout is assigned today.',
        actionLabel: 'Progress',
        accent: themeColors.primary,
        onPress: onOpenProgress,
      };
    }
    if (isEmptyCustomWorkout) {
      return {
        icon: 'add-circle' as IconName,
        title: 'Start custom workout',
        subtitle: 'Track your own session from today.',
        actionLabel: 'Start Activity',
        accent: workoutAccent,
        onPress: onStartWorkout,
      };
    }
    return {
      icon: 'barbell' as IconName,
      title: workoutTitle,
      subtitle: workoutDetail ? `Today's workout - ${workoutDetail}` : "Today's workout",
      actionLabel: 'Start Workout',
      accent: workoutAccent,
      onPress: onStartWorkout,
    };
  })();
  const showWorkoutHeroIdentity = showWorkoutsSurface && !showDoneWorkoutState;
  const workoutIdentityPillLabel = workoutTypeLabel
    ?? (todayIsRest ? 'Recovery'
      : todaySkipped ? 'Skipped'
      : !todayWorkout || isEmptyCustomWorkout ? 'Custom'
      : null);
  const workoutIdentityPillColor = workoutTypeLabel ? workoutTypeColor : primary.accent;
  const showHeroActionButton = primary.actionLabel !== 'View Week';
  const showActivityActionPair = showWorkoutsSurface && !resumeInfo && (
    showDoneWorkoutState || todayIsRest || todaySkipped || !todayWorkout || isEmptyCustomWorkout
  );
  const heroActions = showActivityActionPair
    ? [
        ...(onLogActivity ? [{ key: 'log', label: 'Log Activity', icon: 'add' as IconName, onPress: onLogActivity, accent: workoutAccent, filled: false }] : []),
        { key: 'start', label: 'Start Activity', icon: 'play' as IconName, onPress: onStartActivity ?? onStartWorkout, accent: workoutAccent, filled: true },
      ]
    : showHeroActionButton
      ? [{ key: 'primary', label: primary.actionLabel, icon: null, onPress: primary.onPress, accent: primary.accent, filled: true }]
      : [];
  const heroCardPress = showWorkoutsSurface ? onOpenWorkouts : primary.onPress;

  const macroTargets = nutritionPlan?.targets ?? { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const trackingScore = trackingScorePct ?? goalProgressPct;
  const trackingValuePct = trackingScore != null && Number.isFinite(trackingScore)
    ? Math.max(0, Math.round(trackingScore))
    : null;
  // Hide the prior progress bar while the new execution score is computing —
  // showing the stale bar next to "Loading" was the "old info first" symptom.
  const trackingProgressPct = goalLoading ? null : clampPct(trackingScore);
  const trackingValue = goalLoading
    ? 'Loading'
    : trackingValuePct != null
      ? `${trackingValuePct}%`
      : 'Tracking';
  const topGoalLimiter = goalScore?.limitingFactors?.[0] ?? null;
  const baseTrackingDetail = goalLoading
    ? 'Syncing progress'
    : goalScore
      ? topGoalLimiter
        ? `Top limiter: ${topGoalLimiter.driverName}`
        : `Execution score - ${goalLabel}`
      : `Execution score - ${goalLabel}`;
  // Prefix the day count ("Day 17/42") so users see how far into the current
  // 42-day execution block they are — mirrors the Progress-screen graph.
  const trackingDetail = !goalLoading && goalDayLabel
    ? `${goalDayLabel} · ${baseTrackingDetail}`
    : baseTrackingDetail;

  return (
    <>
    <ScrollView
      testID="today-tab-screen"
      style={[styles.root, { backgroundColor: 'transparent' }]}
      contentContainerStyle={styles.content}
      onScroll={onChromeScroll}
      scrollEventThrottle={16}
      showsVerticalScrollIndicator={false}>
      <FadeInView delay={0} duration={320} slideDistance={8} style={styles.headerBlock}>
        <Text style={[styles.eyebrow, { color: themeColors.textPrimary }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.82}>
          {greeting}
        </Text>
        <Text style={[styles.dateText, { color: themeColors.textSecondary }]}>{todayDate}</Text>
      </FadeInView>

      {readinessAlert ? (
        <FadeInView delay={25} duration={340} slideDistance={8}>
          <ReadinessAlertCard
            alert={readinessAlert}
            themeColors={themeColors}
            onPress={onOpenReadiness}
          />
        </FadeInView>
      ) : null}

      {homePrompt ? (
        <FadeInView delay={readinessAlert ? 65 : 35} duration={340} slideDistance={8}>
          <HomeReminderCard prompt={homePrompt} themeColors={themeColors} />
        </FadeInView>
      ) : null}

      <FadeInView delay={readinessAlert ? 95 : 55} duration={360} slideDistance={10}>
        <PressableScale
          scaleDown={0.985}
          onPress={heroCardPress}
          style={[styles.heroCard, { backgroundColor: workoutImageSource ? '#0D0F14' : themeColors.surface, borderColor: primary.accent + '70' }]}>
          {workoutImageSource ? (
            <ImageBackground
              source={workoutImageSource}
              resizeMode="cover"
              imageStyle={styles.heroImage}
              style={StyleSheet.absoluteFill}>
              <LinearGradient
                pointerEvents="none"
                colors={['rgba(13,15,20,0.08)', 'rgba(13,15,20,0.38)', 'rgba(13,15,20,0.88)'] as any}
                locations={[0, 0.44, 1] as any}
                style={StyleSheet.absoluteFill}
              />
            </ImageBackground>
          ) : (
            <LinearGradient
              pointerEvents="none"
              colors={[primary.accent + '24', primary.accent + '08', themeColors.surface + '00'] as any}
              locations={[0, 0.52, 1] as any}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
          )}
          {showDoneWorkoutState ? (
            <View style={[styles.heroDoneBadge, {
              backgroundColor: workoutImageSource ? 'rgba(22,163,74,0.86)' : themeColors.success + '18',
              borderColor: workoutImageSource ? 'rgba(255,255,255,0.34)' : themeColors.success + '55',
            }]}>
              <Ionicons name="checkmark-circle" size={16} color={workoutImageSource ? '#FFFFFF' : themeColors.success} />
              <Text style={[styles.heroDoneText, { color: workoutImageSource ? '#FFFFFF' : themeColors.success }]} numberOfLines={1}>
                Workout Done!
              </Text>
            </View>
          ) : showWorkoutHeroIdentity ? (
            <View style={styles.heroIdentityBlock}>
              <Text style={[styles.heroIdentityTitle, { color: heroTextPrimary }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78}>
                {primary.title}
              </Text>
              {workoutIdentityPillLabel ? (
                <View style={[styles.heroIdentityPill, {
                  backgroundColor: workoutImageSource ? workoutIdentityPillColor + 'E6' : workoutIdentityPillColor + '18',
                  borderColor: workoutImageSource ? workoutIdentityPillColor + 'FF' : workoutIdentityPillColor + '66',
                }]}>
                  <Text style={[styles.heroIdentityPillText, { color: workoutImageSource ? getContrastingTextColor(workoutIdentityPillColor) : workoutIdentityPillColor }]} numberOfLines={1}>
                    {workoutIdentityPillLabel}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : (
            <View style={[styles.heroIcon, { backgroundColor: primary.accent + '18' }]}>
              <Ionicons name={primary.icon} size={24} color={primary.accent} />
            </View>
          )}
          {workoutTypeLabel && !showDoneWorkoutState && !showWorkoutHeroIdentity ? (
            <View style={styles.workoutBadgeRow}>
              <View style={[styles.workoutTypePill, {
                backgroundColor: workoutImageSource ? workoutTypeColor + 'E6' : workoutTypeColor + '18',
                borderColor: workoutImageSource ? workoutTypeColor + 'FF' : workoutTypeColor + '66',
                shadowColor: workoutTypeColor,
              }]}>
                <Text style={[styles.workoutTypeText, { color: workoutImageSource ? getContrastingTextColor(workoutTypeColor) : workoutTypeColor }]} numberOfLines={1}>
                  {workoutTypeLabel}
                </Text>
              </View>
            </View>
          ) : null}
          <View style={[
            styles.heroCopy,
            showDoneWorkoutState && styles.heroCopyDone,
            showWorkoutHeroIdentity && styles.heroCopyWithIdentity,
            heroActions.length === 0 && styles.heroCopyNoButton,
          ]}>
            {!showWorkoutHeroIdentity ? (
              <Text style={[styles.heroTitle, { color: heroTextPrimary }]} numberOfLines={2}>
                {primary.title}
              </Text>
            ) : null}
            <Text style={[styles.heroSubtitle, showWorkoutHeroIdentity && styles.heroSubtitleIdentity, { color: heroTextSecondary }]} numberOfLines={2}>
              {primary.subtitle}
            </Text>
            {stepsLabel ? (
              <View style={styles.heroMetaRow}>
                <View style={[styles.heroMetaPill, { backgroundColor: workoutImageSource ? 'rgba(255,255,255,0.16)' : themeColors.surfaceRaised, borderColor: workoutImageSource ? 'rgba(255,255,255,0.28)' : themeColors.border }]}>
                  <Ionicons name="footsteps-outline" size={13} color={workoutImageSource ? '#FFFFFF' : themeColors.textSecondary} />
                  <Text style={[styles.heroMetaText, { color: workoutImageSource ? '#FFFFFF' : themeColors.textSecondary }]} numberOfLines={1}>
                    {stepsLabel}
                  </Text>
                </View>
              </View>
            ) : null}
          </View>
          {heroActions.length > 0 ? (
            <View style={styles.heroActionRow}>
              {heroActions.map(action => (
                <PressableScale
                  key={action.key}
                  scaleDown={0.96}
                  onPress={action.onPress}
                  style={[
                    styles.heroButton,
                    action.filled
                      ? { backgroundColor: action.accent, borderColor: action.accent }
                      : { backgroundColor: workoutImageSource ? 'rgba(255,255,255,0.15)' : themeColors.surfaceRaised, borderColor: workoutImageSource ? 'rgba(255,255,255,0.34)' : themeColors.border },
                  ]}>
                  {action.icon ? (
                    <Ionicons
                      name={action.icon}
                      size={13}
                      color={action.filled ? getContrastingTextColor(action.accent) : workoutImageSource ? '#FFFFFF' : action.accent}
                    />
                  ) : null}
                  <Text style={[
                    styles.heroButtonText,
                    { color: action.filled ? getContrastingTextColor(action.accent) : workoutImageSource ? '#FFFFFF' : action.accent },
                  ]} numberOfLines={1}>
                    {action.label}
                  </Text>
                </PressableScale>
              ))}
            </View>
          ) : null}
        </PressableScale>
      </FadeInView>

      <FadeInView delay={115} duration={360} slideDistance={10}>
        <PressableScale
          scaleDown={0.99}
          onPress={showMealsSurface ? onOpenMeals : onOpenProgress}
          style={[styles.macroCard, { backgroundColor: themeColors.surface, borderColor: mealsAccent + '70' }]}>
          <View style={styles.macroHeader}>
            <View style={styles.macroHeaderCopy}>
              <Text style={[styles.sectionTitle, { color: themeColors.textPrimary }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.82}>
                {loggedCalories != null ? `${Math.round(loggedCalories)} calories logged` : 'No meals logged'}
              </Text>
            </View>
            <View style={styles.macroHeaderActions}>
              <PressableScale
                scaleDown={0.965}
                onPress={showMealsSurface ? onOpenMeals : onOpenProgress}
                style={[styles.macroScorePill, { backgroundColor: nutritionScoreColor + '14', borderColor: nutritionScoreColor + '55' }]}>
                <Ionicons name="analytics-outline" size={13} color={nutritionScoreColor} />
                <Text style={[styles.macroScoreLabel, { color: themeColors.textMuted }]} numberOfLines={1}>
                  Score
                </Text>
                <Text style={[styles.macroScoreValue, { color: nutritionScoreColor }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78}>
                  {nutritionScore != null ? Math.round(nutritionScore) : '-'}
                </Text>
              </PressableScale>
            </View>
          </View>
          <View style={styles.macroQuickActions}>
            <PressableScale
              scaleDown={0.95}
              onPress={onLogMeal}
              style={[styles.logMealButton, { backgroundColor: mealsAccent, shadowColor: mealsAccent }]}>
              <Ionicons name="add" size={15} color={getContrastingTextColor(mealsAccent)} />
              <Text style={[styles.logMealButtonText, { color: getContrastingTextColor(mealsAccent) }]} numberOfLines={1}>
                Log meal
              </Text>
            </PressableScale>
            {onScanMeal && (
              <PressableScale
                scaleDown={0.95}
                onPress={onScanMeal}
                accessibilityRole="button"
                accessibilityLabel="Scan a meal with the camera"
                style={[styles.logMealButton, styles.scanMealButton, { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: mealsAccent }]}>
                <Ionicons name="camera" size={16} color={mealsAccent} />
              </PressableScale>
            )}
            {onScanBarcodeMeal && (
              <PressableScale
                scaleDown={0.95}
                onPress={onScanBarcodeMeal}
                accessibilityRole="button"
                accessibilityLabel="Scan a food barcode"
                style={[styles.logMealButton, styles.scanMealButton, { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: mealsAccent }]}>
                <Ionicons name="barcode-outline" size={17} color={mealsAccent} />
              </PressableScale>
            )}
          </View>
          <MacroDonutRow
            themeName={themeName}
            accent={mealsAccent}
            calories={{ actual: loggedCalories ?? 0, target: macroTargets.calories }}
            protein={{ actual: loggedProtein ?? 0, target: macroTargets.protein }}
            carbs={{ actual: loggedCarbs ?? 0, target: macroTargets.carbs }}
            fat={{ actual: loggedFat ?? 0, target: macroTargets.fat }}
            tileBackground={themeColors.background}
            tileBorder={mealsAccent + '38'}
            trackColor={themeColors.border}
            onPressMacro={showMealsSurface ? () => onOpenMeals() : undefined}
          />
          <View style={[styles.waterRow, { borderTopColor: themeColors.border }]}>
            <View style={styles.waterCopy}>
              <View style={[styles.waterIcon, { backgroundColor: themeColors.primary + '16' }]}>
                <Ionicons name="water-outline" size={16} color={themeColors.primary} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[styles.waterTitle, { color: themeColors.textPrimary }]}>Water</Text>
                <Text style={[styles.waterDetail, { color: themeColors.textSecondary }]} numberOfLines={1}>
                  {hydrationLabel}{hydrationTarget ? '' : ' - tap to log'}
                </Text>
              </View>
            </View>
            <View style={styles.waterActions}>
              <PressableScale
                scaleDown={0.955}
                disabled={hydrationRemoveDisabled}
                onPress={onQuickRemoveWater}
                accessibilityRole="button"
                accessibilityLabel="Remove 8 ounces of water"
                style={[
                  styles.waterButton,
                  styles.waterRemoveButton,
                  {
                    borderColor: themeColors.border,
                    opacity: hydrationRemoveDisabled ? 0.45 : 1,
                  },
                ]}>
                <Text style={[styles.waterButtonText, { color: themeColors.textSecondary }]}>
                  {hydrationQuickRemoveLabel}
                </Text>
              </PressableScale>
              <PressableScale
                scaleDown={0.955}
                disabled={hydrationLoading}
                onPress={onQuickAddWater}
                accessibilityRole="button"
                accessibilityLabel="Add water"
                style={[styles.waterButton, { backgroundColor: themeColors.primary, opacity: hydrationLoading ? 0.62 : 1 }]}>
                {hydrationLoading ? (
                  <ActivityIndicator size="small" color={getContrastingTextColor(themeColors.primary)} />
                ) : (
                  <Text style={[styles.waterButtonText, { color: getContrastingTextColor(themeColors.primary) }]}>
                    {hydrationQuickAddLabel}
                  </Text>
                )}
              </PressableScale>
            </View>
          </View>
        </PressableScale>
      </FadeInView>

      <View style={styles.metricGrid}>
        <FadeInView delay={175} duration={340} slideDistance={8} style={styles.metricGridItem}>
          <SleepMetricTile
            score={sleepScore}
            loading={healthLoading && sleepScore == null}
            rating={sleepRating}
            sleepHours={sleepHours}
            onPress={onOpenSleepProgress}
          />
        </FadeInView>
        <FadeInView delay={210} duration={340} slideDistance={8} style={styles.metricGridItem}>
          <MetricTile
            icon="pulse-outline"
            label="Readiness"
            value={readinessScore?.score != null ? String(Math.round(readinessScore.score)) : 'Loading'}
            detail={readinessScore?.label ?? 'Recovery signal'}
            color={readinessColor}
            progressPct={clampPct(readinessScore?.score)}
            themeColors={themeColors}
            onPress={onOpenReadiness}
          />
        </FadeInView>
        <FadeInView delay={245} duration={340} slideDistance={8} style={styles.metricGridFullItem}>
          <MetricTile
            icon="speedometer-outline"
            label="Tracking"
            value={trackingValue}
            detail={trackingDetail}
            color={themeColors.primary}
            progressPct={trackingProgressPct}
            themeColors={themeColors}
            onPress={onOpenProgress}
          />
        </FadeInView>
      </View>

      {authToken && showSunExposureSurface ? (
        <FadeInView delay={270} duration={340} slideDistance={8} style={styles.sunExposureHomeCard}>
          <SunExposureHealthCard
            authToken={authToken}
            themeName={themeName}
            isActive
            compact
          />
        </FadeInView>
      ) : null}

      {/* Life Events — moved here under the Tracking tile (was previously
          rendered just below the day header). */}
      {authToken && todayDateKey ? (
        <FadeInView delay={showSunExposureSurface ? 305 : 280} duration={320} slideDistance={8} style={{ marginHorizontal: 16, marginTop: 12 }}>
          <LifestyleFactorsCard
            authToken={authToken}
            dateISO={todayDateKey}
            themeName={themeName}
            title="Life events"
            variant="inline"
            compact
          />
        </FadeInView>
      ) : null}
    </ScrollView>
    </>
  );
}

function ReadinessAlertCard({
  alert,
  themeColors,
  onPress,
}: {
  alert: HomeReadinessAlert;
  themeColors: any;
  onPress: () => void;
}) {
  const accent = alert.tone === 'danger'
    ? (themeColors.error ?? '#EF4444')
    : (themeColors.warning ?? '#F59E0B');
  const scoreText = alert.score != null && Number.isFinite(alert.score)
    ? String(Math.round(alert.score))
    : null;

  return (
    <TouchableOpacity
      testID="home-readiness-alert"
      activeOpacity={0.86}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${alert.title}. Open readiness details`}
      style={[
        styles.readinessAlertCard,
        {
          backgroundColor: themeColors.surface,
          borderColor: accent + '66',
          shadowColor: accent,
        },
      ]}>
      <LinearGradient
        pointerEvents="none"
        colors={[accent + '18', accent + '08', 'transparent'] as any}
        locations={[0, 0.56, 1] as any}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View style={[styles.readinessAlertIcon, { backgroundColor: accent + '18' }]}>
        <Ionicons name={alert.icon ?? 'warning-outline'} size={18} color={accent} />
      </View>
      <View style={styles.readinessAlertCopy}>
        <View style={styles.readinessAlertMetaRow}>
          <Text style={[styles.readinessAlertEyebrow, { color: accent }]} numberOfLines={1}>
            Readiness alert
          </Text>
          {scoreText ? (
            <View style={[styles.readinessAlertScorePill, { backgroundColor: accent + '18', borderColor: accent + '55' }]}>
              <Text style={[styles.readinessAlertScore, { color: accent }]} numberOfLines={1}>
                {scoreText}{alert.label ? ` ${alert.label}` : ''}
              </Text>
            </View>
          ) : null}
        </View>
        <Text style={[styles.readinessAlertTitle, { color: themeColors.textPrimary }]} numberOfLines={2}>
          {alert.title}
        </Text>
        <Text style={[styles.readinessAlertDetail, { color: themeColors.textSecondary }]} numberOfLines={2}>
          {alert.detail}
        </Text>
        {alert.chips && alert.chips.length > 0 ? (
          <View style={styles.readinessAlertChipRow}>
            {alert.chips.slice(0, 3).map(chip => (
              <View key={chip} style={[styles.readinessAlertChip, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]}>
                <Text style={[styles.readinessAlertChipText, { color: themeColors.textSecondary }]} numberOfLines={1}>
                  {chip}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={16} color={themeColors.textMuted} />
    </TouchableOpacity>
  );
}

function HomeReminderCard({
  prompt,
  themeColors,
}: {
  prompt: HomeReminderPrompt;
  themeColors: any;
}) {
  const onAccent = getContrastingTextColor(prompt.accent);
  return (
    <View
      testID="home-action-prompt"
      style={[
        styles.promptCard,
        {
          backgroundColor: themeColors.surface,
          borderColor: prompt.accent + '66',
          shadowColor: prompt.accent,
        },
      ]}>
      <View style={styles.promptTopRow}>
        <View style={[styles.promptIcon, { backgroundColor: prompt.accent + '18' }]}>
          <Ionicons name={prompt.icon} size={18} color={prompt.accent} />
        </View>
        <View style={styles.promptCopy}>
          <View style={styles.promptMetaRow}>
            <Text style={[styles.promptEyebrow, { color: themeColors.textMuted }]} numberOfLines={1}>
              {prompt.eyebrow}
            </Text>
            {prompt.queueCount && prompt.queueCount > 0 ? (
              <View style={[styles.promptQueuePill, { borderColor: themeColors.border, backgroundColor: themeColors.surfaceRaised }]}>
                <Text style={[styles.promptQueueText, { color: themeColors.textSecondary }]}>
                  +{prompt.queueCount}
                </Text>
              </View>
            ) : null}
          </View>
          <Text style={[styles.promptTitle, { color: themeColors.textPrimary }]} numberOfLines={2}>
            {prompt.title}
          </Text>
          <Text style={[styles.promptBody, { color: themeColors.textSecondary }]} numberOfLines={3}>
            {prompt.body}
          </Text>
        </View>
      </View>
      <View style={styles.promptButtonRow}>
        {prompt.secondaryLabel && prompt.onSecondary ? (
          <TouchableOpacity
            activeOpacity={0.78}
            onPress={prompt.onSecondary}
            style={[styles.promptSecondaryButton, { borderColor: themeColors.border, backgroundColor: themeColors.surfaceRaised }]}>
            <Text style={[styles.promptSecondaryText, { color: themeColors.textSecondary }]} numberOfLines={1}>
              {prompt.secondaryLabel}
            </Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          activeOpacity={0.82}
          onPress={prompt.onPrimary}
          style={[styles.promptPrimaryButton, { backgroundColor: prompt.accent }]}>
          <Text style={[styles.promptPrimaryText, { color: onAccent }]} numberOfLines={1}>
            {prompt.primaryLabel}
          </Text>
          <Ionicons name="chevron-forward" size={14} color={onAccent} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

function SleepMetricTile({
  score,
  loading,
  rating,
  sleepHours,
  onPress,
}: {
  score: number | null;
  loading: boolean;
  rating: string | null;
  sleepHours: number | null;
  onPress: () => void;
}) {
  const pct = clampPct(score) ?? 0;
  const size = 52;
  const stroke = 5;
  const radiusValue = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radiusValue;
  const dash = circumference * (pct / 100);
  return (
    <TouchableOpacity
      activeOpacity={0.84}
      onPress={onPress}
      style={[styles.metricTile, styles.sleepTile, { borderColor: '#A78BFA66' }]}>
      <LinearGradient
        pointerEvents="none"
        colors={['#050816', '#141031', '#2E1065'] as any}
        locations={[0, 0.62, 1] as any}
        style={StyleSheet.absoluteFill}
      />
      <View style={styles.sleepStarField} pointerEvents="none">
        <TwinkleStar delay={0} minOpacity={0.48} maxOpacity={0.82} style={{ top: 12, left: 18 }} />
        <TwinkleStar delay={360} minOpacity={0.28} maxOpacity={0.58} style={{ top: 18, right: 34, width: 2, height: 2, borderRadius: 1 }} />
        <TwinkleStar delay={720} minOpacity={0.34} maxOpacity={0.66} style={{ top: 24, right: 20 }} />
        <TwinkleStar delay={1080} minOpacity={0.22} maxOpacity={0.48} style={{ top: 40, right: 58, width: 2, height: 2, borderRadius: 1 }} />
        <TwinkleStar delay={520} minOpacity={0.36} maxOpacity={0.68} style={{ top: 46, left: 58 }} />
        <TwinkleStar delay={900} minOpacity={0.2} maxOpacity={0.48} style={{ bottom: 24, left: 28, width: 2, height: 2, borderRadius: 1 }} />
        <TwinkleStar delay={1240} minOpacity={0.3} maxOpacity={0.62} style={{ bottom: 18, right: 24 }} />
      </View>
      <View style={styles.metricTopRow}>
        <View style={[styles.metricIcon, { backgroundColor: 'rgba(255,255,255,0.14)' }]}>
          <Ionicons name="moon-outline" size={16} color="#DDD6FE" />
        </View>
        <Text style={[styles.metricLabel, { color: 'rgba(255,255,255,0.70)' }]} numberOfLines={1}>
          Sleep
        </Text>
      </View>
      <View style={styles.sleepBodyRow}>
        <View style={styles.sleepDonutGlow}>
          <Svg width={size} height={size}>
            <Circle
              cx={size / 2}
              cy={size / 2}
              r={radiusValue}
              stroke="rgba(255,255,255,0.18)"
              strokeWidth={stroke}
              fill="transparent"
            />
            <Circle
              cx={size / 2}
              cy={size / 2}
              r={radiusValue}
              stroke="#C084FC"
              strokeWidth={stroke}
              fill="transparent"
              strokeLinecap="round"
              strokeDasharray={`${dash} ${circumference - dash}`}
              rotation="-90"
              originX={size / 2}
              originY={size / 2}
            />
          </Svg>
          <Text style={styles.sleepDonutText}>
            {score != null ? Math.round(score) : loading ? '...' : '-'}
          </Text>
        </View>
      </View>
      <Text style={styles.sleepDetail} numberOfLines={2}>
        {loading ? 'Loading sleep score' : rating ?? (sleepHours != null ? `${sleepHours}h last night` : 'Connect health data')}
      </Text>
    </TouchableOpacity>
  );
}

function TwinkleStar({
  style,
  delay,
  minOpacity,
  maxOpacity,
}: {
  style: StyleProp<ViewStyle>;
  delay: number;
  minOpacity: number;
  maxOpacity: number;
}) {
  const reducedMotion = useReducedMotion();
  const pulse = useRef(new Animated.Value(reducedMotion ? maxOpacity : minOpacity)).current;

  useEffect(() => {
    if (reducedMotion) {
      pulse.setValue(maxOpacity);
      return;
    }

    pulse.setValue(minOpacity);
    let animation: Animated.CompositeAnimation | null = null;
    const timer = setTimeout(() => {
      animation = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, {
            toValue: maxOpacity,
            duration: 1400,
            easing: TIMING_SMOOTH.easing,
            useNativeDriver: true,
          }),
          Animated.timing(pulse, {
            toValue: minOpacity,
            duration: 1600,
            easing: TIMING_SMOOTH.easing,
            useNativeDriver: true,
          }),
        ]),
      );
      animation.start();
    }, delay);

    return () => {
      clearTimeout(timer);
      animation?.stop();
    };
  }, [delay, maxOpacity, minOpacity, pulse, reducedMotion]);

  const scale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.78, 1.18],
  });

  return (
    <Animated.View style={[styles.sleepStar, style, { opacity: pulse, transform: [{ scale }] }]} />
  );
}

function MetricTile({
  icon,
  label,
  value,
  detail,
  color,
  progressPct,
  themeColors,
  onPress,
}: {
  icon: IconName;
  label: string;
  value: string;
  detail: string;
  color: string;
  progressPct: number | null;
  themeColors: any;
  onPress?: () => void;
}) {
  return (
    <TouchableOpacity
      activeOpacity={0.84}
      onPress={onPress}
      style={[styles.metricTile, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
      <View style={styles.metricTopRow}>
        <View style={[styles.metricIcon, { backgroundColor: color + '16' }]}>
          <Ionicons name={icon} size={16} color={color} />
        </View>
        <Text style={[styles.metricLabel, { color: themeColors.textMuted }]} numberOfLines={1}>
          {label}
        </Text>
      </View>
      {value === 'Loading' ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <ActivityIndicator size="small" color={color} />
          <Text style={[styles.metricValue, { color: themeColors.textSecondary }]} numberOfLines={1}>
            Loading…
          </Text>
        </View>
      ) : (
        <Text style={[styles.metricValue, { color: themeColors.textPrimary }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.74}>
          {value}
        </Text>
      )}
      <Text style={[styles.metricDetail, { color: themeColors.textSecondary }]} numberOfLines={2}>
        {detail}
      </Text>
      {progressPct != null ? (
        <View style={[styles.progressTrack, { backgroundColor: themeColors.border }]}>
          <View style={[styles.progressFill, { width: `${progressPct}%`, backgroundColor: color }]} />
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 166,
  },
  headerBlock: {
    marginBottom: 12,
  },
  eyebrow: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '900',
  },
  dateText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
    marginTop: 2,
  },
  heroCard: {
    minHeight: 204,
    borderRadius: radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
    padding: 16,
  },
  promptCard: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: 13,
    marginBottom: 12,
    shadowOpacity: 0.14,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
    elevation: 3,
  },
  promptTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  promptIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  promptCopy: {
    flex: 1,
    minWidth: 0,
  },
  promptMetaRow: {
    minHeight: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 3,
  },
  promptEyebrow: {
    flex: 1,
    minWidth: 0,
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 0,
  },
  promptQueuePill: {
    minWidth: 26,
    minHeight: 18,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  promptQueueText: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '900',
  },
  promptTitle: {
    fontSize: 17,
    lineHeight: 21,
    fontWeight: '900',
  },
  promptBody: {
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '600',
    marginTop: 4,
  },
  promptButtonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 12,
  },
  promptSecondaryButton: {
    minHeight: 34,
    borderRadius: 17,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  promptSecondaryText: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '900',
  },
  promptPrimaryButton: {
    minHeight: 34,
    borderRadius: 17,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: 13,
  },
  promptPrimaryText: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '900',
  },
  readinessAlertCard: {
    minHeight: 96,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: 12,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    overflow: 'hidden',
    shadowOpacity: 0.16,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
    elevation: 3,
  },
  readinessAlertIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  readinessAlertCopy: {
    flex: 1,
    minWidth: 0,
  },
  readinessAlertMetaRow: {
    minHeight: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginBottom: 3,
  },
  readinessAlertEyebrow: {
    flex: 1,
    minWidth: 0,
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 0,
  },
  readinessAlertScorePill: {
    minHeight: 20,
    maxWidth: 104,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 7,
  },
  readinessAlertScore: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '900',
    fontVariant: ['tabular-nums'] as any,
  },
  readinessAlertTitle: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '900',
  },
  readinessAlertDetail: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
    marginTop: 3,
  },
  readinessAlertChipRow: {
    minHeight: 24,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8,
  },
  readinessAlertChip: {
    maxWidth: 126,
    minHeight: 22,
    borderRadius: 11,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  readinessAlertChipText: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '800',
  },
  heroImage: {
    borderRadius: radius.lg,
  },
  heroIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroDoneBadge: {
    alignSelf: 'flex-start',
    minHeight: 30,
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
  },
  heroDoneText: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  heroCopy: {
    marginTop: 54,
    paddingRight: 72,
    paddingBottom: 36,
  },
  heroCopyDone: {
    marginTop: 18,
    paddingRight: 0,
    paddingBottom: 52,
  },
  heroCopyWithIdentity: {
    marginTop: 88,
    paddingRight: 96,
  },
  heroCopyNoButton: {
    paddingRight: 0,
    paddingBottom: 0,
  },
  heroTitle: {
    fontSize: 24,
    lineHeight: 30,
    fontWeight: '900',
  },
  heroSubtitle: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    marginTop: 5,
  },
  heroSubtitleIdentity: {
    marginTop: 0,
    fontWeight: '800',
  },
  heroMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  heroMetaPill: {
    minHeight: 28,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
  },
  heroMetaText: {
    minWidth: 0,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '800',
  },
  heroActionRow: {
    position: 'absolute',
    right: 14,
    bottom: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 7,
  },
  heroButton: {
    minWidth: 116,
    minHeight: 38,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 11,
  },
  heroButtonText: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '900',
  },
  heroIdentityBlock: {
    position: 'absolute',
    top: 16,
    left: 16,
    right: 16,
    alignItems: 'flex-start',
    gap: 7,
  },
  heroIdentityTitle: {
    fontSize: 25,
    lineHeight: 30,
    fontWeight: '900',
  },
  heroIdentityPill: {
    minHeight: 24,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 9,
  },
  heroIdentityPillText: {
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  workoutBadgeRow: {
    position: 'absolute',
    top: 16,
    right: 16,
    left: 66,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 6,
  },
  workoutTypePill: {
    minHeight: 28,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    shadowOpacity: 0.24,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  workoutTypeText: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  macroCard: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: 13,
    marginTop: 12,
  },
  macroHeader: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  macroHeaderCopy: {
    flex: 1,
    minWidth: 0,
  },
  macroHeaderActions: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  macroQuickActions: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 10,
  },
  macroScorePill: {
    minWidth: 74,
    minHeight: 34,
    borderRadius: 17,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 9,
  },
  macroScoreLabel: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  macroScoreValue: {
    minWidth: 18,
    fontSize: 13,
    lineHeight: 16,
    fontWeight: '900',
    textAlign: 'right',
    fontVariant: ['tabular-nums'] as any,
  },
  logMealButton: {
    minWidth: 88,
    minHeight: 34,
    borderRadius: 17,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: 12,
    shadowOpacity: 0.22,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  scanMealButton: {
    width: 38,
    minWidth: 38,
    paddingHorizontal: 0,
    shadowOpacity: 0,
  },
  logMealButtonText: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '900',
  },
  sectionTitle: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '900',
    marginTop: 2,
  },
  waterRow: {
    minHeight: 54,
    borderTopWidth: 1,
    marginTop: 12,
    paddingTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  waterCopy: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  waterIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  waterTitle: {
    fontSize: 13,
    lineHeight: 16,
    fontWeight: '900',
  },
  waterDetail: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '600',
    marginTop: 1,
  },
  waterButton: {
    minWidth: 62,
    minHeight: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  waterActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  waterRemoveButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
  },
  waterButtonText: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '900',
  },
  metricGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'stretch',
    gap: 10,
    marginTop: 12,
  },
  metricGridItem: {
    width: '48%',
    alignSelf: 'stretch',
  },
  metricGridFullItem: {
    width: '100%',
    alignSelf: 'stretch',
  },
  sunExposureHomeCard: {
    marginTop: 12,
  },
  metricTile: {
    width: '100%',
    minHeight: 156,
    flex: 1,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: 12,
  },
  sleepTile: {
    overflow: 'hidden',
    backgroundColor: '#111827',
  },
  sleepStarField: {
    ...StyleSheet.absoluteFillObject,
  },
  sleepStar: {
    position: 'absolute',
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: '#FFFFFF',
  },
  sleepBodyRow: {
    marginTop: 10,
    alignItems: 'center',
  },
  sleepDonutGlow: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#C084FC',
    shadowOpacity: 0.72,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
  },
  sleepDonutText: {
    position: 'absolute',
    fontSize: 17,
    lineHeight: 21,
    fontWeight: '900',
    color: '#FFFFFF',
    fontVariant: ['tabular-nums'] as any,
  },
  sleepDetail: {
    minHeight: 32,
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.78)',
    marginTop: 3,
  },
  metricTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  metricIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  metricLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  metricValue: {
    fontSize: 25,
    lineHeight: 30,
    fontWeight: '900',
    marginTop: 14,
  },
  metricDetail: {
    minHeight: 32,
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '600',
    marginTop: 3,
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    marginTop: 9,
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
});

export default memo(TodayHomeTab);
