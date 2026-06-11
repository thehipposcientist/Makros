import { Fragment, memo, useCallback, useState, useEffect, useRef, useMemo, type ComponentProps, type ReactNode } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Pressable, ActivityIndicator,
  TextInput, Alert, Image, ImageBackground, Linking, Modal, Animated, useWindowDimensions,
  InteractionManager,
  type ImageSourcePropType,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
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
import { LinearGradient } from 'expo-linear-gradient';
import { LayoutAnimation, UIManager, Platform } from 'react-native';
import TabDragWrapper from '../components/TabDragWrapper';
import FadeInView from '../components/FadeInView';
import { overPhotoTextShadow } from '../components/PhotoScrim';
import BottomSheetDismissHandle from '../components/BottomSheetDismissHandle';
import AnimatedNumber from '../components/AnimatedNumber';
import { WorkoutDaySkeleton } from '../components/SkeletonLoader';
import MovingGradientBackground from '../components/MovingGradientBackground';
import { configureExpandAnimation } from '../utils/layoutAnim';
import { TIMING_SMOOTH, TIMING_STANDARD, staggerDelay, useReducedMotion } from '../utils/motion';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
const AnimatedTouchableOpacity = Animated.createAnimatedComponent(TouchableOpacity);
import Svg, { Defs, Polyline, Circle, Line, Polygon, Rect, LinearGradient as SvgLinearGradient, Stop, Text as SvgText } from 'react-native-svg';
import ViewShot from 'react-native-view-shot';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WorkoutSession, UserProfile, StoredWorkoutSummary, GoalHistoryEntry, PlanChangeEntry, BodyScanEntry, HealthSummary, HealthScoreResult, HealthPillarKey, SleepScore, SleepStageTimeline, WeightEntry } from '../types';
import { loadWorkoutHistory, derivePersonalRecords, PR, loadWorkoutSummaries, loadGoalHistory, loadPlanChanges, loadHealthSummary, loadHealthScore, deleteWorkoutSession, deleteWorkoutSummary, deletePlanChange, saveWorkoutSession, dateKey, saveHealthSummary, isAppleHealthEnabled } from '../utils/workoutHistory';
import type { StalenessWatch } from '../utils/stalenessReminders';
import {
  APPLE_HEALTH_PERMISSION_COPY,
  readHealthSummary,
  isHealthKitAvailable,
  requestHealthPermissions,
  getLastHealthKitError,
  loadSleepHistory,
  readDailyNutritionSnapshot,
  type DailyNutritionSnapshot,
} from '../services/appleHealth';
import { scoreSleep, bedtimeWindowFromHistory, type BedtimeWindow } from '../services/sleepScore';
import BodyMeasurementsModal from '../components/BodyMeasurementsModal';
import { STOCK_IMAGES } from '../constants/stockImages';
import Zone2TargetCard from '../components/Zone2TargetCard';
import CardioHrZonesCard from '../components/CardioHrZonesCard';
import CardioLoadCard from '../components/CardioLoadCard';
import CardioProgressionCard from '../components/CardioProgressionCard';
import WeeklyCheckinCard from '../components/WeeklyCheckinCard';
import HealthInsightsScreen from './HealthInsightsScreen';
import { GoalTrajectoryChart } from '../components/GoalTrajectoryChart';
import { RecompTrajectoryChart } from '../components/RecompTrajectoryChart';
import DailyStressTimelineCard from '../components/DailyStressTimelineCard';
import { setAppleHealthEnabled as persistAppleHealthEnabled } from '../utils/workoutHistory';
import LogActivityModal from '../components/LogActivityModal';
import SwipeableRow from '../components/SwipeableRow';
import RecoveryCard from '../components/RecoveryCard';
import RouteSummaryMap from '../components/RouteSummaryMap';
import AppleHealthWorkoutAttachModal from '../components/AppleHealthWorkoutAttachModal';
import HealthLabsCard from '../components/HealthLabsCard';
import MetabolicSignalsCard from '../components/MetabolicSignalsCard';
import SunExposureHealthCard from '../components/SunExposureHealthCard';
import TrendsOverviewCard from '../components/TrendsOverviewCard';
import {
  getHealthSummarySignalAvailability,
  hasDisplayableHealthSummaryData,
} from '../utils/healthSignalDisplay';
import type {
  ScoreContext as HealthScoreContext,
  NutritionContext as HealthNutritionContext,
  GutSupportContext as HealthGutContext,
  StrengthContext as HealthStrengthContext,
  CardioContext as HealthCardioContext,
} from '../utils/healthScore';
import { getMealChecks } from '../utils/mealTracker';
import { computePlantDiversity, computeFiberToday, recommendedFiberTarget } from '../utils/gutHealth';
import { proteinTimingInsights } from '../utils/nutritionInsights';
import { getGoalEstimate, getRecompProjection, computeGoalProgressBar, computeRecompTrajectory, computeFatMassProgress, resolveGoalBucket } from '../utils/goalEstimate';
import { buildGoalForecast, type GoalForecastModel } from '../utils/goalForecast';
import { useMetaData } from '../hooks/useMetaData';
import { humanizeToken } from '../utils/exerciseGuide';
import { displayFocusForExercises } from '../utils/workoutFocusDisplay';
import { estimate1RM, categorizeExercise, type LiftCategory } from '../utils/oneRepMax';
import { computeStrengthScore, strengthBandLabel, strengthConfidenceLabel } from '../utils/strengthScore';
import {
  planChangeIsScheduled,
  planScopeMatches,
  restorePlanScope,
} from '../utils/pendingPlanChange';
import {
  classifyActiveEnergy,
  classifyAvgSleepHours,
  classifyAvgSteps,
  classifyHrv,
  classifyRestingHeartRate,
  type VitalTrendResult,
} from '../utils/vitalsTrend';
import { getInsights, getGuardrails, getCoachMemory, getProgressionInsights, scanBody, BodyScanResult, getPaceHistory, PaceHistoryPoint, listWorkoutCompletions, WorkoutCompletionRecord, listWorkoutSessions, WorkoutSessionRecord, getCalorieRanges, CalorieRanges, getGoalScores, type GoalScoreResult } from '../services/api';
import { colors, elevations, getContrastingTextColor, getTheme, radius, typography } from '../constants/theme';
import { AppThemeName } from '../types';
import { dynamicInputProps, dynamicTextProps } from '../utils/dynamicType';
import { HEALTH_DATA_LABEL, HEALTH_PLATFORM_LABEL, HEALTH_PLATFORM_PRO_COPY, HEALTH_PLATFORM_STATUS_COPY, HEALTH_WEARABLE_LABEL } from '../constants/platformHealth';
import {
  aggregateDailyFromHistory,
  buildHrZoneSourceBreakdown,
  buildRelativeStrengthProfiles,
  buildStrengthLoadBalance,
  buildStrengthVolumeTrend,
  isCardioHrZoneSource,
  macrosHeadlineFromAverages,
  macrosHeadlineFromDailyRows,
  selectDailyRows,
  type StrengthLoadBalanceStatus,
  type StrengthLoadBalanceSummary,
  type StrengthLoadMuscleSummary,
  type StrengthVolumeTrendBreakdown,
  type StrengthVolumeWindowSummary,
} from './progressData';
import { tierOf } from '../utils/subscription';
import { appleHealthMetricsFromWorkoutSession, manualActivityFromCompletion, mergeCompletionIntoWorkoutSession } from '../utils/workoutCompletion';
import { completeWorkoutWithOfflineQueue } from '../utils/workoutCompletionQueue';
import { formatDistance, formatWeight, lbsToUnit, resolveDistanceUnit, resolveWeightUnit, unitToLbs, type DistanceUnit, type WeightUnit } from '../utils/units';
import {
  buildExerciseTrendMap,
  buildStrengthTrendSummary,
  buildLocalBestSetHistory,
  buildLocalE1RMHistory,
  inferChartMuscleFromName,
  isNonStrengthExercise,
  type E1RMTrendPoint,
  type StrengthTrendRow,
} from '../utils/workoutProgressFilters';
import {
  filterWorkoutHistory,
  workoutDaysAgoLabel as workoutHistoryDaysAgoLabel,
  type WorkoutHistoryDateFilter,
  type WorkoutHistoryTypeFilter,
} from '../utils/workoutHistorySearch';
import { shouldShowMeals, shouldShowWorkouts } from '../utils/hiddenSurfaces';
import { STORAGE_KEYS } from '../utils/storageKeys.ts';
import type { MealHistoryEntry } from '../services/api';

type ProgressTab = 'today' | 'insights' | 'trends' | 'body' | 'health';
type ProgressFocusTarget = 'sleep' | 'weight';
type HealthBiometricKey = 'rhr' | 'hrv' | 'sleep' | 'steps' | 'active-energy' | 'workouts' | 'vo2';
type BiometricHistoryWindow = 14 | 30 | 90;
type HealthBiometricHistoryPoint = {
  date: string;
  value: number;
};
type HealthBiometricConfig = {
  title: string;
  eyebrow: string;
  icon: ComponentProps<typeof Ionicons>['name'];
  accent: string;
  unit?: string;
  better: 'higher' | 'lower' | 'neutral';
  empty: string;
};

type InProgressWorkoutSummary = {
  focus: string;
  setsLogged: number;
  startedAt: number;
};

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
  isActive?: boolean;
  planWeekWindow?: ProgressPlanWeekWindow | null;
  inProgressWorkout?: InProgressWorkoutSummary | null;
  onResumeInProgressWorkout?: () => void;
  onDiscardInProgressWorkout?: () => void | Promise<void>;
  showWorkoutProgress?: boolean;
  showMealProgress?: boolean;
  webMode?: boolean;
  resetToTodayToken?: number;
  focusTarget?: ProgressFocusTarget | null;
  focusTargetToken?: number;
  onRequestPreviousSurface?: () => void;
  onChromeScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}

type ProgressSurfaceVisibility = {
  showWorkoutProgress: boolean;
  showMealProgress: boolean;
};

const PROGRESS_SERVER_SESSION_LIMIT = 100;
const PROGRESS_SERVER_COMPLETION_LIMIT = 500;
const PROGRESS_SERVER_HYDRATE_TIMEOUT_MS = 12000;

function progressPexelsPhoto(id: string, extension: 'jpeg' | 'png' = 'jpeg') {
  return `https://images.pexels.com/photos/${id}/pexels-photo-${id}.${extension}?auto=compress&cs=tinysrgb&w=900&h=540&fit=crop`;
}

const NUTRITION_GUT_FACTS_IMAGE = progressPexelsPhoto('3851075');

// Fixed identity accents so the Strength and Cardio profiles read as
// distinct at a glance. Quality is still conveyed by the score value +
// label (e.g. "Advanced" / "Building base"), not the accent color.
const STRENGTH_PROFILE_COLOR = '#6366F1'; // indigo
const CARDIO_PROFILE_COLOR = '#06B6D4';   // teal

type EditVisibilitySection = { id: string; label: string; desc: string };

// Toggleable sections on the Trends tab. Visibility is persisted on
// device under `trendsHiddenSections_v1` and edited via EditTrendsSheet.
const TRENDS_SECTIONS: ReadonlyArray<EditVisibilitySection> = [
  { id: 'trends-overview', label: 'Training volume + PRs', desc: 'Lead trend card with weekly load and recent records' },
  { id: 'strength-profile', label: 'Relative Strength Profile', desc: 'Compound-lift strength radar vs bodyweight' },
  { id: 'cardio-profile', label: 'Cardio Fitness Profile', desc: 'Aerobic-quality radar' },
  { id: 'performance-gauges', label: 'Performance gauges', desc: 'Strength index, volume trend, recent records' },
  { id: 'high-value-trends', label: 'High-value trends', desc: 'Recovery, quality, readiness, nutrition, and body signals' },
  { id: 'activity-highlights', label: 'Activity highlights', desc: 'Sauna, swim, cycling, hike, and recovery metrics' },
  { id: 'metric-suggestions', label: 'Suggested signals', desc: 'Recommended data to log next' },
  { id: 'strength-charts', label: 'Strength charts', desc: 'Per-exercise strength, best-set, and 1RM trends' },
  { id: 'cardio-progression', label: 'Cardio progression', desc: 'Distance, pace, duration, and HR-zone trends' },
];

// Toggleable sections on the Health tab. Visibility is persisted on
// device under `healthHiddenSections_v1` and edited via the same sheet.
const HEALTH_SECTIONS: ReadonlyArray<EditVisibilitySection> = [
  { id: 'health-vitals-overview', label: 'Vitals Overview', desc: '7-day rolling snapshot of key signals' },
  { id: 'health-labs', label: 'Health Labs', desc: 'Blood work and clinical markers' },
  { id: 'metabolic-signals', label: 'Metabolic Signals', desc: 'Glucose, lipids, and metabolism' },
  { id: 'nutrition-gut', label: 'Nutrition & Gut Facts', desc: 'Fiber, plant diversity, macros, processing' },
  { id: 'sun-exposure', label: 'Sun Exposure', desc: 'Vitamin D and daylight exposure' },
  { id: 'device-vitals', label: 'Device Vitals', desc: 'HR, HRV, activity, recovery snapshot' },
];

function EditTrendsSheet({ visible, hidden, onSetVisible, onShowAll, onHideAll, onClose, tc, sections = TRENDS_SECTIONS, title = 'Edit Trends', testPrefix = 'edit-trends', countLabel = 'sections' }: {
  visible: boolean;
  hidden: Set<string>;
  onSetVisible: (id: string, visible: boolean) => void;
  onShowAll: () => void;
  onHideAll?: () => void;
  onClose: () => void;
  tc: ReturnType<typeof getTheme>['colors'];
  sections?: ReadonlyArray<EditVisibilitySection>;
  title?: string;
  testPrefix?: string;
  countLabel?: string;
}) {
  const shownCount = sections.filter(s => !hidden.has(s.id)).length;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' }}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={{ backgroundColor: tc.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 18, paddingTop: 16, paddingBottom: 28, maxHeight: '86%' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <Ionicons name="options-outline" size={20} color={tc.primary} />
            <Text style={{ flex: 1, fontSize: 17, fontWeight: '900', color: tc.textPrimary }}>{title}</Text>
            {onHideAll && (
              <TouchableOpacity onPress={onHideAll} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textMuted }}>Hide all</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={onShowAll} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={{ fontSize: 13, fontWeight: '800', color: tc.primary }}>Show all</Text>
            </TouchableOpacity>
          </View>
          <Text style={{ fontSize: 12, color: tc.textMuted, marginBottom: 6 }}>
            {shownCount}/{sections.length} {countLabel} shown
          </Text>
          <ScrollView showsVerticalScrollIndicator={false}>
            {sections.map(s => {
              const shown = !hidden.has(s.id);
              return (
                <TouchableOpacity
                  key={s.id}
                  testID={`${testPrefix}-${s.id}`}
                  activeOpacity={0.8}
                  onPress={() => onSetVisible(s.id, !shown)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderTopWidth: 1, borderTopColor: tc.border }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary }}>{s.label}</Text>
                    <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 1 }}>{s.desc}</Text>
                  </View>
                  <Ionicons name={shown ? 'eye-outline' : 'eye-off-outline'} size={22} color={shown ? tc.primary : tc.textMuted} />
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function parseHiddenIdSet(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const decoded = JSON.parse(raw);
    return new Set(Array.isArray(decoded) ? decoded.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}
const BODY_WEIGHT_IMAGE = progressPexelsPhoto('6550832');
const SLEEP_SCORE_IMAGE: ImageSourcePropType = require('../../assets/images/card-backgrounds/sleep-score-night-sky.jpg');
const HEALTH_DATA_READY_IMAGE = progressPexelsPhoto('4679246');
const HEALTH_DATA_CONNECT_IMAGE = progressPexelsPhoto('8539219');
const HEALTH_DATA_SYNC_IMAGE = progressPexelsPhoto('6622519');
const HEALTH_DATA_EMPTY_IMAGE = progressPexelsPhoto('8539061');

function bodyMeasurementsImageSource(gender: string | null | undefined): ImageSourcePropType {
  if (gender === 'female') return STOCK_IMAGES.progress.bodyMeasureFemale;
  if (gender === 'male') return STOCK_IMAGES.progress.bodyMeasureMale;
  return { uri: progressPexelsPhoto('5629205') };
}

function bodyCheckImageUri(gender: string | null | undefined) {
  if (gender === 'male') return progressPexelsPhoto('13975083', 'png');
  return progressPexelsPhoto('13106587');
}

function goalEstimateImageUri(goal: string | null | undefined, gender: string | null | undefined) {
  const bucket = resolveGoalBucket(goal);
  if (bucket === 'fat_loss') return progressPexelsPhoto('19797435');
  if (bucket === 'muscle_gain' || bucket === 'strength') {
    if (gender === 'female') return progressPexelsPhoto('29825216');
    return progressPexelsPhoto('5327511');
  }
  if (bucket === 'body_recomp' || bucket === 'toning') return progressPexelsPhoto('18204829');
  if (bucket === 'endurance' || bucket === 'hyrox') return progressPexelsPhoto('8454909');
  return progressPexelsPhoto('24809806');
}

function sentenceLabel(value: unknown): string {
  return humanizeToken(String(value ?? '')).toLowerCase();
}

function describeCoachMemoryAction(action: any): string | null {
  if (!action || typeof action !== 'object') return null;
  const type = String(action.type ?? '');
  const muscle = sentenceLabel(action.muscle);
  const musclePrefix = muscle ? `${muscle} ` : '';
  const sets = Number(action.sets);
  const pct = Number(action.pct);
  const minutes = Number(action.minutes);
  const kcal = Number(action.kcal ?? action.delta);
  switch (type) {
    case 'add_muscle_volume':
      return `Accepted recommendation: add ${Number.isFinite(sets) && sets > 0 ? `${sets} ` : ''}${musclePrefix}sets next generated week.`;
    case 'reduce_muscle_volume':
      return `Accepted recommendation: reduce ${musclePrefix}volume${Number.isFinite(pct) && pct > 0 ? ` about ${pct}%` : ''} next generated week.`;
    case 'hold_muscle_volume':
      return `Accepted recommendation: hold ${musclePrefix}volume steady next generated week.`;
    case 'add_cardio_session':
    case 'add_zone2_session':
      return `Accepted recommendation: add ${Number.isFinite(minutes) && minutes > 0 ? `about ${minutes} min ` : ''}${type === 'add_zone2_session' ? 'Zone 2 ' : ''}cardio next generated week.`;
    case 'raise_calories':
      return `Accepted recommendation: raise calories${Number.isFinite(kcal) && kcal > 0 ? ` by ${kcal} kcal/day` : ''}.`;
    case 'lower_calories':
      return `Accepted recommendation: lower calories${Number.isFinite(kcal) && kcal > 0 ? ` by ${kcal} kcal/day` : ''}.`;
    case 'change_days_per_week':
      return action.value ? `Accepted recommendation: move to ${action.value} training days per week.` : null;
    default:
      return null;
  }
}

function humanizeInlineIdentifiers(text: string): string {
  return text.replace(
    /\b([a-z]+(?:_[a-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]*)\b/g,
    token => sentenceLabel(token),
  );
}

function isFullHealthSummary(value: HealthSummary | null | undefined): value is HealthSummary {
  if (!value || typeof value !== 'object') return false;
  return typeof value.fetchedAt === 'string'
    && (
      'restingHeartRate' in value ||
      'avgSteps7d' in value ||
      'avgSleepHours7d' in value ||
      'lastNightSleepHours' in value ||
      'activeEnergy7d' in value ||
      'hrvAvg' in value ||
      'workoutDetails' in value
    );
}

async function readFreshProgressHealthSummary(age: number | null, force = false): Promise<HealthSummary | null> {
  const { getHealthDataSummary } = await import('../services/healthDataSummary');
  const agg = await getHealthDataSummary({ age, force }).catch(() => null);
  return isFullHealthSummary(agg?.raw) ? agg.raw : readHealthSummary({ age });
}

type ProgressSleepHistoryPoint = {
  night: string;
  sleepHours: number | null;
  inBedMinutes: number | null;
  deepHours: number | null;
  remHours: number | null;
  coreHours: number | null;
  awakeMinutes: number | null;
  hrv: number | null;
  restingHr: number | null;
  respiratoryRate: number | null;
  spo2Percent: number | null;
  bedtimeMinutes: number | null;
  score: number | null;
  rating: SleepScore['rating'] | null;
  mode: SleepScore['mode'] | null;
};

function finiteOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sleepRatingOrNull(value: unknown): SleepScore['rating'] | null {
  return value === 'Excellent' || value === 'Good' || value === 'Fair' || value === 'Poor'
    ? value
    : null;
}

function sleepModeOrNull(value: unknown): SleepScore['mode'] | null {
  return value === 'mvp' || value === 'personalized' ? value : null;
}

function sleepHistoryPointFromLocal(row: any): ProgressSleepHistoryPoint | null {
  const night = typeof row?.night === 'string' ? row.night : null;
  if (!night) return null;
  return {
    night,
    sleepHours: finiteOrNull(row.sleepHours),
    inBedMinutes: finiteOrNull(row.inBedMinutes),
    deepHours: finiteOrNull(row.deepHours),
    remHours: finiteOrNull(row.remHours),
    coreHours: finiteOrNull(row.coreHours),
    awakeMinutes: finiteOrNull(row.awakeMinutes),
    hrv: finiteOrNull(row.hrv),
    restingHr: finiteOrNull(row.restingHr),
    respiratoryRate: finiteOrNull(row.respiratoryRate),
    spo2Percent: finiteOrNull(row.spo2Percent),
    bedtimeMinutes: finiteOrNull(row.bedtimeMinutes),
    score: finiteOrNull(row.score),
    rating: sleepRatingOrNull(row.rating),
    mode: sleepModeOrNull(row.mode),
  };
}

function sleepHistoryPointFromRemote(row: any): ProgressSleepHistoryPoint | null {
  const night = typeof row?.night_date === 'string' ? row.night_date : null;
  if (!night) return null;
  return {
    night,
    sleepHours: finiteOrNull(row.total_hours),
    inBedMinutes: finiteOrNull(row.in_bed_minutes),
    deepHours: finiteOrNull(row.deep_hours),
    remHours: finiteOrNull(row.rem_hours),
    coreHours: finiteOrNull(row.core_hours),
    awakeMinutes: finiteOrNull(row.awake_minutes),
    hrv: finiteOrNull(row.hrv_ms),
    restingHr: finiteOrNull(row.resting_hr),
    respiratoryRate: finiteOrNull(row.respiratory_rate),
    spo2Percent: finiteOrNull(row.spo2_percent),
    bedtimeMinutes: finiteOrNull(row.bedtime_minutes_from_midnight),
    score: finiteOrNull(row.score),
    rating: sleepRatingOrNull(row.rating),
    mode: sleepModeOrNull(row.mode),
  };
}

function mergeSleepHistoryPoint(a: ProgressSleepHistoryPoint, b: ProgressSleepHistoryPoint): ProgressSleepHistoryPoint {
  return {
    night: b.night,
    sleepHours: b.sleepHours ?? a.sleepHours,
    inBedMinutes: b.inBedMinutes ?? a.inBedMinutes,
    deepHours: b.deepHours ?? a.deepHours,
    remHours: b.remHours ?? a.remHours,
    coreHours: b.coreHours ?? a.coreHours,
    awakeMinutes: b.awakeMinutes ?? a.awakeMinutes,
    hrv: b.hrv ?? a.hrv,
    restingHr: b.restingHr ?? a.restingHr,
    respiratoryRate: b.respiratoryRate ?? a.respiratoryRate,
    spo2Percent: b.spo2Percent ?? a.spo2Percent,
    bedtimeMinutes: b.bedtimeMinutes ?? a.bedtimeMinutes,
    score: b.score ?? a.score,
    rating: b.rating ?? a.rating,
    mode: b.mode ?? a.mode,
  };
}

function mergeSleepHistoryPoints(points: ProgressSleepHistoryPoint[]): ProgressSleepHistoryPoint[] {
  const byNight = new Map<string, ProgressSleepHistoryPoint>();
  for (const point of points) {
    const existing = byNight.get(point.night);
    byNight.set(point.night, existing ? mergeSleepHistoryPoint(existing, point) : point);
  }
  return Array.from(byNight.values()).sort((a, b) => a.night.localeCompare(b.night)).slice(-30);
}

function overlayCurrentSleepScore(points: ProgressSleepHistoryPoint[], summary: HealthSummary | null | undefined): ProgressSleepHistoryPoint[] {
  const sleepScore = summary?.sleepScore ?? null;
  if (!sleepScore || points.length === 0) return points;
  const todayKeys = new Set([dateKey(new Date()), new Date().toISOString().slice(0, 10)]);
  return points.map((point) => todayKeys.has(point.night) ? {
    ...point,
    sleepHours: sleepScore.duration ?? point.sleepHours,
    deepHours: sleepScore.stages?.deep ?? point.deepHours,
    remHours: sleepScore.stages?.rem ?? point.remHours,
    coreHours: sleepScore.stages?.core ?? point.coreHours,
    awakeMinutes: sleepScore.stages?.awake != null ? Math.round(sleepScore.stages.awake * 60) : point.awakeMinutes,
    inBedMinutes: sleepScore.efficiency && sleepScore.duration
      ? Math.round((sleepScore.duration * 60) / sleepScore.efficiency)
      : point.inBedMinutes,
    hrv: sleepScore.hrvAvg ?? point.hrv,
    restingHr: sleepScore.restingHeartRate ?? point.restingHr,
    respiratoryRate: sleepScore.respiratoryRate ?? point.respiratoryRate,
    spo2Percent: sleepScore.oxygenSaturation ?? point.spo2Percent,
    bedtimeMinutes: sleepScore.bedtimeMinutes ?? point.bedtimeMinutes,
    score: sleepScore.score,
    rating: sleepScore.rating,
    mode: sleepScore.mode,
  } : point);
}

async function loadProgressSleepHistory(authToken: string | null | undefined, summary?: HealthSummary | null): Promise<ProgressSleepHistoryPoint[]> {
  const localRows = (await loadSleepHistory().catch(() => []))
    .map(sleepHistoryPointFromLocal)
    .filter((row): row is ProgressSleepHistoryPoint => row != null);
  let remoteRows: ProgressSleepHistoryPoint[] = [];
  if (authToken) {
    const { getSleepHistory } = await import('../services/api');
    remoteRows = (await getSleepHistory(authToken, 30).catch(() => []))
      .map(sleepHistoryPointFromRemote)
      .filter((row): row is ProgressSleepHistoryPoint => row != null);
  }
  return overlayCurrentSleepScore(mergeSleepHistoryPoints([...localRows, ...remoteRows]), summary);
}

function round1Local(n: number): number {
  return Math.round(n * 10) / 10;
}

const BIOMETRIC_HISTORY_CONFIG: Record<HealthBiometricKey, HealthBiometricConfig> = {
  rhr: {
    title: 'Resting HR',
    eyebrow: 'Heart trend',
    icon: 'pulse-outline',
    accent: '#EF4444',
    unit: 'bpm',
    better: 'lower',
    empty: 'Resting heart-rate history will appear after Apple Health syncs daily snapshots.',
  },
  hrv: {
    title: 'HRV',
    eyebrow: 'Recovery trend',
    icon: 'analytics-outline',
    accent: '#8B5CF6',
    unit: 'ms',
    better: 'higher',
    empty: 'HRV history will appear after Apple Health syncs nightly or daily values.',
  },
  sleep: {
    title: 'Sleep',
    eyebrow: 'Night trend',
    icon: 'moon-outline',
    accent: '#818CF8',
    unit: 'h',
    better: 'neutral',
    empty: 'Sleep history appears after Apple Health returns sleep samples.',
  },
  steps: {
    title: 'Steps',
    eyebrow: 'Activity trend',
    icon: 'walk-outline',
    accent: '#14B8A6',
    unit: 'steps',
    better: 'higher',
    empty: 'Step history will appear after daily health snapshots sync.',
  },
  'active-energy': {
    title: 'Active calories',
    eyebrow: 'Burn trend',
    icon: 'flame-outline',
    accent: '#F97316',
    unit: 'kcal',
    better: 'neutral',
    empty: 'Active calorie history will appear after Apple Health syncs daily energy.',
  },
  workouts: {
    title: 'Workout minutes',
    eyebrow: 'Training trend',
    icon: 'fitness-outline',
    accent: '#22C55E',
    unit: 'min',
    better: 'neutral',
    empty: 'Workout-minute history will appear after workouts sync into daily health snapshots.',
  },
  vo2: {
    title: 'VO2 Max',
    eyebrow: 'Cardio trend',
    icon: 'speedometer-outline',
    accent: '#0EA5E9',
    unit: 'ml/kg/min',
    better: 'higher',
    empty: 'VO2 Max history will appear after Apple Health returns cardio fitness samples.',
  },
};

function dailyHealthSnapshotDate(row: any): string | null {
  const raw = typeof row?.snapshot_date === 'string' ? row.snapshot_date.slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function healthMetricPoint(date: string | null, value: unknown): HealthBiometricHistoryPoint | null {
  const n = finiteOrNull(value);
  if (!date || n == null) return null;
  return { date, value: n };
}

function mergeHealthMetricPoints(points: HealthBiometricHistoryPoint[], limit: number): HealthBiometricHistoryPoint[] {
  const byDate = new Map<string, HealthBiometricHistoryPoint>();
  for (const point of points) {
    byDate.set(point.date, point);
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date)).slice(-limit);
}

function formatBiometricValue(key: HealthBiometricKey, value: number | null | undefined, includeUnit = true): string {
  if (value == null || !Number.isFinite(value)) return '--';
  if (key === 'sleep') {
    const total = Math.max(0, Math.round(value * 60));
    const h = Math.floor(total / 60);
    const m = total % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const rounded = key === 'vo2'
    ? Math.round(value * 10) / 10
    : Math.round(value);
  const formatted = rounded.toLocaleString();
  const unit = BIOMETRIC_HISTORY_CONFIG[key].unit;
  return includeUnit && unit && unit !== 'steps' ? `${formatted} ${unit}` : formatted;
}

function formatBiometricDelta(key: HealthBiometricKey, value: number): string {
  const sign = value > 0 ? '+' : '';
  if (key === 'sleep') {
    const minutes = Math.round(value * 60);
    return `${minutes > 0 ? '+' : ''}${minutes}m`;
  }
  if (key === 'vo2') return `${sign}${Math.round(value * 10) / 10}`;
  return `${sign}${Math.round(value).toLocaleString()}`;
}

function formatGoalScoreHeroTitle(score: GoalScoreResult): string {
  const outcome = score.projectedOutcome;
  const midpoint = Number(outcome?.expectedMidpoint);
  if (!Number.isFinite(midpoint)) return `${score.executionLabel} execution`;
  const sign = midpoint > 0 ? '+' : '';
  const abs = Math.abs(midpoint);
  const value = abs >= 10
    ? `${sign}${Math.round(midpoint).toLocaleString()}`
    : `${sign}${midpoint.toFixed(1).replace(/\.0$/, '')}`;
  const metric = String(outcome?.metric ?? '').toLowerCase();
  const unit = String(outcome?.unit ?? '').toLowerCase();
  if (unit === 'percentage_points') return `On pace: ${value} body-fat pts`;
  if (unit === 'lb' || unit === 'lbs') return `On pace: ${value} lb`;
  if (metric === 'estimated_1rm_pct' || unit === 'percent') return `On pace: ${value}% strength`;
  if (metric === 'cardio_volume_min') return `On pace: ${value} cardio min`;
  return `On pace: ${value} ${unit.replace(/_/g, ' ') || 'change'}`;
}

type BiometricStatusTone = 'good' | 'onTrack' | 'monitor' | 'neutral' | 'waiting';

function biometricStatusFromTrend(
  trend: VitalTrendResult | null | undefined,
  hasValue: boolean,
): { label: string; tone: BiometricStatusTone } {
  if (!hasValue) return { label: 'Waiting', tone: 'waiting' };
  if (trend?.trend === 'improving') return { label: 'Good', tone: 'good' };
  if (trend?.trend === 'onTrack') return { label: 'On track', tone: 'onTrack' };
  if (trend?.trend === 'monitor') return { label: 'Monitor', tone: 'monitor' };
  return { label: 'Logged', tone: 'neutral' };
}

function buildBiometricHistoryPoints(
  key: HealthBiometricKey,
  sleepRows: ProgressSleepHistoryPoint[],
  dailyRows: import('../services/api').DailyHealthHistoryItem[] | null,
  summary: HealthSummary | null | undefined,
  windowDays: number,
): HealthBiometricHistoryPoint[] {
  const points: HealthBiometricHistoryPoint[] = [];
  if (key === 'sleep' || key === 'rhr' || key === 'hrv') {
    for (const row of sleepRows) {
      const value = key === 'sleep' ? row.sleepHours : key === 'rhr' ? row.restingHr : row.hrv;
      const point = healthMetricPoint(row.night, value);
      if (point) points.push(point);
    }
  }
  if (dailyRows) {
    for (const row of dailyRows) {
      const date = dailyHealthSnapshotDate(row);
      const value =
        key === 'rhr' ? row.resting_hr
        : key === 'hrv' ? row.hrv_ms
        : key === 'steps' ? row.steps
        : key === 'active-energy' ? row.active_energy_kcal
        : key === 'workouts' ? row.workout_minutes
        : key === 'vo2' ? row.vo2_max
        : null;
      const point = healthMetricPoint(date, value);
      if (point) points.push(point);
    }
  }
  const today = dateKey(new Date());
  const todayValue =
    key === 'rhr' ? summary?.sleepScore?.restingHeartRate
    : key === 'hrv' ? summary?.sleepScore?.hrvAvg
    : key === 'sleep' ? summary?.lastNightSleepHours
    : key === 'steps' ? summary?.stepsToday
    : key === 'active-energy' ? summary?.activeEnergyToday
    : key === 'workouts' ? null
    : key === 'vo2' ? summary?.vo2Max
    : null;
  const todayPoint = healthMetricPoint(today, todayValue);
  if (todayPoint) points.push(todayPoint);
  return mergeHealthMetricPoints(points, windowDays);
}

function sleepHistoryDotScore(
  point: ProgressSleepHistoryPoint,
  index: number,
  history: ProgressSleepHistoryPoint[],
  age: number | null,
): number | null {
  if (point.score != null) {
    return Math.max(0, Math.min(100, Math.round(point.score)));
  }
  if (point.sleepHours == null || point.sleepHours < 0.5) return null;

  const baselineRows = index + 1 > 14 ? history.slice(0, index) : history.slice(0, index + 1);
  const hrvHistory = baselineRows.map(n => n.hrv).filter((v): v is number => typeof v === 'number' && v > 0);
  const rhrHistory = baselineRows.map(n => n.restingHr).filter((v): v is number => typeof v === 'number' && v > 0);
  const respHistory = baselineRows.map(n => n.respiratoryRate).filter((v): v is number => typeof v === 'number' && v > 0);
  const spo2History = baselineRows.map(n => n.spo2Percent).filter((v): v is number => typeof v === 'number' && v > 0);
  const bedtimeHistory = baselineRows.map(n => n.bedtimeMinutes).filter((v): v is number => typeof v === 'number' && v >= 0);
  const stages = point.awakeMinutes != null ? {
    core: point.coreHours ?? Math.max(0, round1Local(point.sleepHours - (point.deepHours ?? 0) - (point.remHours ?? 0))),
    deep: point.deepHours ?? 0,
    rem: point.remHours ?? 0,
    awake: round1Local(point.awakeMinutes / 60),
    total: point.sleepHours,
  } : null;

  return scoreSleep({
    totalSleepHours: point.sleepHours,
    inBedMinutes: point.inBedMinutes,
    deepSleepHours: point.deepHours,
    remSleepHours: point.remHours,
    hrvMs: point.hrv,
    restingHeartRate: point.restingHr,
    spo2Percent: point.spo2Percent,
    respiratoryRate: point.respiratoryRate,
    age,
    stages,
    bedtimeMinutes: point.bedtimeMinutes,
    hrvHistory,
    rhrHistory,
    respiratoryRateHistory: respHistory,
    spo2History,
    bedtimeHistory,
  })?.score ?? null;
}

function formatCoachMemorySummary(memory: any): string {
  const actionLine = describeCoachMemoryAction(memory?.details?.action);
  if (actionLine) return actionLine;
  const eventType = String(memory?.event_type ?? '');
  const details = memory?.details ?? {};
  if (eventType === 'muscle_priority' && Array.isArray(details.muscles) && details.muscles.length > 0) {
    return `Priority muscle saved: ${details.muscles.map(sentenceLabel).join(', ')}.`;
  }
  if (eventType === 'preferred_cardio_mode' && Array.isArray(details.modes) && details.modes.length > 0) {
    return `Preferred cardio saved: ${details.modes.map(sentenceLabel).join(', ')}.`;
  }
  const raw = String(memory?.summary ?? '');
  return humanizeInlineIdentifiers(raw.replace(/^User accepted recommendation:/i, 'Accepted recommendation:'));
}

type CoachInsightVisual = {
  key: string;
  label: string;
  value: string;
  detail: string;
  icon: any;
  color: string;
};

function cleanCoachInsightText(raw: unknown): string {
  const text = humanizeInlineIdentifiers(String(raw ?? ''))
    .replace(/\bPlanWeek\b/g, 'active week')
    .replace(/\bUserPreferences\b/g, 'preferences')
    .replace(/\bUserDayState\b/g, 'day state')
    .replace(/\bAsyncStorage\b/g, 'local cache')
    .replace(/[{}[\]"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text || 'No extra detail yet.';
}

function buildCoachInsightVisuals(
  insights: any | null,
  guardrails: string[],
  coachMemory: any[],
  progressionHint: string,
  visibility: ProgressSurfaceVisibility = { showWorkoutProgress: true, showMealProgress: true },
): CoachInsightVisual[] {
  const rows: CoachInsightVisual[] = [];
  const workoutPct = Number(insights?.adherence?.workout_7d_pct);
  const mealPct = Number(insights?.adherence?.meal_7d_pct);

  if (visibility.showWorkoutProgress && Number.isFinite(workoutPct)) {
    rows.push({
      key: 'workout-adherence',
      label: 'Workouts',
      value: `${Math.round(workoutPct)}%`,
      detail: '7-day completion signal',
      icon: 'barbell-outline',
      color: workoutPct >= 80 ? '#22C55E' : workoutPct >= 55 ? '#F59E0B' : '#EF4444',
    });
  }

  if (visibility.showMealProgress && Number.isFinite(mealPct)) {
    rows.push({
      key: 'meal-adherence',
      label: 'Meals',
      value: `${Math.round(mealPct)}%`,
      detail: '7-day logging signal',
      icon: 'nutrition-outline',
      color: mealPct >= 80 ? '#22C55E' : mealPct >= 55 ? '#F59E0B' : '#EF4444',
    });
  }

  if (guardrails.length > 0) {
    rows.push({
      key: 'guardrails',
      label: 'Watch',
      value: `${guardrails.length}`,
      detail: cleanCoachInsightText(guardrails[0]),
      icon: 'shield-checkmark-outline',
      color: '#F59E0B',
    });
  }

  if (coachMemory.length > 0) {
    rows.push({
      key: 'coach-memory',
      label: 'Saved',
      value: `${coachMemory.length}`,
      detail: cleanCoachInsightText(formatCoachMemorySummary(coachMemory[0])),
      icon: 'checkmark-done-outline',
      color: '#14B8A6',
    });
  }

  if (visibility.showWorkoutProgress && progressionHint) {
    rows.push({
      key: 'progression',
      label: 'Next',
      value: 'Cue',
      detail: cleanCoachInsightText(progressionHint.replace(/^Progression:\s*/i, '')),
      icon: 'trending-up-outline',
      color: '#6366F1',
    });
  }

  return rows.slice(0, 4);
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HISTORY_DATE_FILTER_OPTIONS: Array<{ key: WorkoutHistoryDateFilter; label: string }> = [
  { key: 'all', label: 'All time' },
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: '90d', label: '90D' },
];
const HISTORY_TYPE_FILTER_OPTIONS: Array<{ key: WorkoutHistoryTypeFilter; label: string; icon: ComponentProps<typeof Ionicons>['name'] }> = [
  { key: 'all', label: 'All', icon: 'albums-outline' },
  { key: 'strength', label: 'Strength', icon: 'barbell-outline' },
  { key: 'cardio', label: 'Cardio', icon: 'pulse-outline' },
  { key: 'mobility', label: 'Mobility', icon: 'body-outline' },
  { key: 'sport', label: 'Sport', icon: 'basketball-outline' },
  { key: 'active', label: 'Active', icon: 'hammer-outline' },
  { key: 'recovery', label: 'Recovery', icon: 'leaf-outline' },
  { key: 'prs', label: 'PRs', icon: 'trophy-outline' },
  { key: 'imported', label: 'Imported', icon: 'cloud-download-outline' },
];

// Shared pending-plan-change helpers live in src/utils/pendingPlanChange.ts
// so the workout-Home banner and this screen agree on what's "pending"
// and how to safely cancel/restore it.
//
// (`restorePlanScope` is also imported below.)

// `restorePlanScope`, `planChangeIsScheduled`, `planScopeMatches`, and
// `planScopeSnapshot` now live in src/utils/pendingPlanChange.ts —
// imported below alongside the other utils.

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

function formatLoggedTime(loggedAt?: string): string {
  if (!loggedAt) return '';
  const d = new Date(loggedAt);
  if (Number.isNaN(d.getTime())) return '';
  return ` · ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function formatStartedAgo(startedAt: number): string {
  const mins = Math.max(0, Math.round((Date.now() - startedAt) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hours}h ${rem}m ago` : `${hours}h ago`;
}

function normalizeRemoteWeightEntry(row: import('../services/api').WeightEntryAPI): import('../types').WeightEntry | null {
  const date = String(row.date ?? '').slice(0, 10);
  const weightLbs = Math.round(Number(row.weight_lbs) * 10) / 10;
  if (!date || !Number.isFinite(weightLbs) || weightLbs <= 0) return null;
  return {
    date,
    weightLbs,
    source: row.source as any,
    loggedAt: row.logged_at,
  };
}

function bodyScanFlag(value: any): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'y'].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function normalizeBodyScanEntry(raw: any): BodyScanEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const date = String(raw.date ?? raw.created_at ?? raw.scan_date ?? '').trim();
  const bodyFatPct = Number(raw.bodyFatPct ?? raw.body_fat_pct);
  if (!date || !Number.isFinite(bodyFatPct) || bodyFatPct <= 0) return null;
  const id = String(raw.id ?? `${date}-${bodyFatPct}`);
  const bodyFatRange = String(raw.bodyFatRange ?? raw.body_fat_range ?? '');
  const muscleMass = String(raw.muscleMass ?? raw.muscle_mass ?? '');
  const photoQuality = raw.photoQuality ?? raw.photo_quality;
  const qualityFlags = raw.qualityFlags ?? raw.quality_flags;
  const sensitivePhoto = bodyScanFlag(raw.sensitivePhoto ?? raw.sensitive_photo);
  const photoHidden = sensitivePhoto || bodyScanFlag(raw.photoHidden ?? raw.photo_hidden);
  return {
    id,
    date,
    photoUri: raw.photoUri ?? raw.photo_uri,
    bodyFatPct: Math.round(bodyFatPct * 10) / 10,
    bodyFatRange,
    muscleMass,
    category: String(raw.category ?? 'Body check'),
    strengths: Array.isArray(raw.strengths) ? raw.strengths.map(String) : [],
    improvements: Array.isArray(raw.improvements) ? raw.improvements.map(String) : [],
    assessment: String(raw.assessment ?? ''),
    confidence: raw.confidence ? String(raw.confidence) : undefined,
    photoQuality: photoQuality ? String(photoQuality) : undefined,
    qualityFlags: Array.isArray(qualityFlags)
      ? qualityFlags.map(String)
      : [],
    needsRetake: Boolean(raw.needsRetake ?? raw.needs_retake),
    sensitivePhoto,
    photoHidden,
    method: raw.method ? String(raw.method) : undefined,
    visualEstimatePct: raw.visualEstimatePct ?? raw.visual_estimate_pct ?? null,
    measurementEstimatePct: raw.measurementEstimatePct ?? raw.measurement_estimate_pct ?? null,
    weightLbs: raw.weightLbs ?? raw.weight_lbs,
  };
}

function bodyScanSortValue(entry: BodyScanEntry): number {
  const ms = new Date(entry.date).getTime();
  if (Number.isFinite(ms)) return ms;
  const scanMs = new Date(`${entry.date.slice(0, 10)}T12:00:00`).getTime();
  return Number.isFinite(scanMs) ? scanMs : 0;
}

function bodyScanMergeKey(entry: BodyScanEntry): string {
  return entry.id ? `id:${entry.id}` : `date:${entry.date}`;
}

function bodyScanHasServerId(entry: BodyScanEntry): boolean {
  return /^[1-9]\d*$/.test(String(entry.id ?? ''));
}

const BODY_SCAN_CACHE_KEY = STORAGE_KEYS.health.bodyScanHistory;
const BODY_SCAN_QUARANTINE_KEY = STORAGE_KEYS.health.bodyScanHistoryQuarantine;

function onlyServerBackedBodyScans(entries: BodyScanEntry[]): BodyScanEntry[] {
  return entries.filter(bodyScanHasServerId);
}

async function quarantineLegacyBodyScans(entries: BodyScanEntry[], reason: string): Promise<void> {
  if (entries.length === 0) return;
  try {
    const raw = await AsyncStorage.getItem(BODY_SCAN_QUARANTINE_KEY);
    const existing = raw ? JSON.parse(raw) : [];
    const next = [
      ...(Array.isArray(existing) ? existing : []),
      {
        reason,
        quarantinedAt: new Date().toISOString(),
        scans: entries,
      },
    ].slice(-20);
    await AsyncStorage.setItem(BODY_SCAN_QUARANTINE_KEY, JSON.stringify(next));
  } catch {
    // Legacy local body scans are never uploaded on hydration.
  }
}

function bodyScanPhotoVisibleInHistory(entry: BodyScanEntry): boolean {
  return !!entry.photoUri && !entry.photoHidden && !entry.sensitivePhoto;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

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

function formatPaceSeconds(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const min = Math.floor(safe / 60);
  const sec = safe % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function cardioPaceTrendScore(deltaSec: number): number {
  if (deltaSec <= -45) return 92;
  if (deltaSec <= -15) return 80;
  if (deltaSec <= 15) return 65;
  if (deltaSec <= 45) return 50;
  return 35;
}

function cardioExerciseDisplayName(raw?: string | null): string {
  const label = humanizeToken(raw) || 'Cardio';
  return label
    .replace(/\bHiit\b/g, 'HIIT')
    .replace(/\bVo2\b/g, 'VO2')
    .replace(/\bRpe\b/g, 'RPE');
}

function cardioExerciseKey(raw?: string | null): string {
  return cardioExerciseDisplayName(raw).toLowerCase();
}

function formatSignedWeightDelta(lbs: number, weightUnit: WeightUnit): string {
  const prefix = lbs > 0 ? '+' : lbs < 0 ? '-' : '';
  return `${prefix}${formatWeight(Math.abs(lbs), weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 })}`;
}

function weightChartValue(lbs: number, weightUnit: WeightUnit): number {
  const value = lbsToUnit(lbs, weightUnit);
  return weightUnit === 'kg' ? Math.round(value * 10) / 10 : Math.round(value);
}

function graphValueLabelIndexes(values: number[], fullLabelLimit = 12): Set<number> {
  const indexes = new Set<number>();
  const finiteValues = values
    .map((value, index) => ({ value, index }))
    .filter(item => Number.isFinite(item.value));
  if (finiteValues.length === 0) return indexes;
  if (values.length <= fullLabelLimit) {
    finiteValues.forEach(item => indexes.add(item.index));
    return indexes;
  }
  indexes.add(finiteValues[0].index);
  indexes.add(finiteValues[finiteValues.length - 1].index);
  const peak = finiteValues.reduce((best, item) => (item.value > best.value ? item : best), finiteValues[0]);
  indexes.add(peak.index);
  return indexes;
}

function graphValueLabelWidth(label: string): number {
  return Math.max(24, label.length * 6.2 + 10);
}

function graphValueLabelX(x: number, labelWidth: number, chartW: number, padL: number, padR: number): number {
  const minX = padL + labelWidth / 2;
  const maxX = chartW - padR - labelWidth / 2;
  return Math.max(minX, Math.min(maxX, x));
}

function graphValueLabelY(y: number): number {
  return Math.max(13, y - 10);
}

function formatLoadVolume(lbs: number, weightUnit: WeightUnit): string {
  const value = lbsToUnit(lbs, weightUnit);
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1000) {
    const precision = abs >= 10000 ? 0 : 1;
    return `${sign}${(abs / 1000).toFixed(precision)}k ${weightUnit}`;
  }
  return `${sign}${Math.round(abs)} ${weightUnit}`;
}

function formatLoadedSetCount(sets: number): string {
  return `${sets} loaded set${sets === 1 ? '' : 's'}`;
}

function formatSignedLoadVolume(lbs: number | null, weightUnit: WeightUnit): string {
  if (lbs == null || !Number.isFinite(lbs)) return '--';
  const prefix = lbs > 0 ? '+' : lbs < 0 ? '-' : '';
  return `${prefix}${formatLoadVolume(Math.abs(lbs), weightUnit)}`;
}

function formatAverageLoadPerSet(window: StrengthVolumeWindowSummary, weightUnit: WeightUnit): string {
  if (window.loadedSets <= 0) return '--';
  return `${formatLoadVolume(window.volumeLbs / window.loadedSets, weightUnit)}/set`;
}

function strengthVolumeTrendDetail(trend: StrengthVolumeTrendBreakdown, weightUnit: WeightUnit): string {
  const setText = formatLoadedSetCount(trend.current.loadedSets);
  const isFixedWeek = trend.bucketMode === 'fixed_week';
  const currentText = isFixedWeek
    ? (trend.elapsedDays >= trend.windowDays ? 'this week' : `this week through day ${trend.elapsedDays}`)
    : `the last ${trend.windowDays}d`;
  const comparisonText = isFixedWeek ? 'last week at this time' : `prior ${trend.windowDays}d`;
  if (!trend.previous) return `${setText} in ${currentText}`;
  if (trend.deltaPct != null) {
    return `${setText} · ${trend.deltaPct >= 0 ? '+' : ''}${trend.deltaPct}% vs ${comparisonText}`;
  }
  if (trend.comparison === 'absolute' && trend.deltaLbs != null) {
    return `${setText} · ${formatSignedLoadVolume(trend.deltaLbs, weightUnit)} vs ${comparisonText}`;
  }
  if (trend.comparison === 'insufficient_previous') {
    return `${setText} · ${comparisonText} too sparse for %`;
  }
  return `${setText} · no prior workload`;
}

function strengthLoadBalanceColor(status: StrengthLoadBalanceStatus, score: number | null): string {
  if (status === 'spike') return '#EF4444';
  if (status === 'low' || status === 'high') return '#F59E0B';
  if (status === 'balanced') return '#22C55E';
  if (score != null && score >= 70) return '#22C55E';
  if (score != null && score >= 50) return '#F59E0B';
  return '#6366F1';
}

function strengthLoadStatusLabel(status: StrengthLoadBalanceStatus): string {
  if (status === 'spike') return 'Spike';
  if (status === 'low') return 'Low';
  if (status === 'high') return 'High';
  if (status === 'balanced') return 'In range';
  return 'Needs data';
}

function formatSetCount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function strengthLoadBalanceValue(summary: StrengthLoadBalanceSummary, _weightUnit: WeightUnit): string {
  return summary.score == null ? 'Needs tags' : String(summary.score);
}

type ZoneMinutes = [number, number, number, number, number];

type CardioTrendSummary = {
  hasData: boolean;
  score: number | null;
  rating: string;
  distance14dMiles: number;
  previousDistance14dMiles: number;
  distanceDeltaPct: number | null;
  duration14dSec: number;
  previousDuration14dSec: number;
  durationDeltaPct: number | null;
  zone2Minutes7d: number;
  zone2MinutesWeek: number;
  previousZone2MinutesWeek: number;
  cardioSessions7d: number;
  easyZoneMinutes14d: number;
  hardZoneMinutes14d: number;
  easySharePct: number | null;
  // 30-day variants — power the Cardio Fitness Profile radar (score card + insights
  // stay on the conventional weekly/14-day fields above).
  distance30dMiles: number;
  zone2Minutes30d: number;
  cardioSessions30d: number;
  easyZoneMinutes30d: number;
  hardZoneMinutes30d: number;
  easySharePct30d: number | null;
  bestPaceDeltaSec: number | null;
  bestPaceExercise: string | null;
  longestDistanceMiles: number;
  longestDistanceExercise: string | null;
  longestDurationSec: number;
  longestDurationExercise: string | null;
  latestPoint: PaceHistoryPoint | null;
  vo2Max: number | null;
};

type CardioChartMode = 'distance' | 'pace' | 'duration';

type CardioExerciseGroup = {
  key: string;
  name: string;
  points: PaceHistoryPoint[];
  distancePoints: PaceHistoryPoint[];
  pacePoints: PaceHistoryPoint[];
  durationPoints: PaceHistoryPoint[];
  maxDistance: number;
  maxDurationSec: number;
};

type TrendActivityMetric = { label: string; value: string; detail: string };
type TrendActivityCard = {
  key: string;
  title: string;
  subtitle: string;
  icon: ComponentProps<typeof Ionicons>['name'];
  color: string;
  metrics: TrendActivityMetric[];
};

function trendActivityCardEditSections(cards: TrendActivityCard[]): EditVisibilitySection[] {
  return cards.map(card => ({
    id: card.key,
    label: card.title,
    desc: card.metrics.length > 0
      ? `${card.subtitle} - ${card.metrics.slice(0, 3).map(metric => metric.label).join(', ')}`
      : card.subtitle,
  }));
}

function cardioDurationSourceNote(rows: PaceHistoryPoint[]): string | null {
  const hasMovingTime = rows.some(point => {
    const source = String(point.duration_source ?? '').toLowerCase();
    return source.includes('moving') || (point.moving_seconds != null && point.moving_seconds > 0);
  });
  if (!hasMovingTime) return null;
  const hasMixedDuration = rows.some(point => {
    const source = String(point.duration_source ?? '').toLowerCase();
    return source && !source.includes('moving');
  });
  return hasMixedDuration ? 'Moving time used where available.' : 'Moving time.';
}

function cardioPointDurationSeconds(point: PaceHistoryPoint): number {
  const seconds = Number(point.moving_seconds ?? point.pace_duration_seconds ?? point.duration_seconds);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function cardioVolumeValue(summary: CardioTrendSummary, distanceUnit: DistanceUnit): string | null {
  if (summary.distance14dMiles > 0) return formatDistance(summary.distance14dMiles, distanceUnit);
  if (summary.duration14dSec > 0) return formatMinutesCompact(summary.duration14dSec / 60);
  return null;
}

function cardioVolumeTrendValue(summary: CardioTrendSummary, distanceUnit: DistanceUnit): string | null {
  if (summary.distanceDeltaPct != null) {
    return `${summary.distanceDeltaPct >= 0 ? '+' : ''}${summary.distanceDeltaPct}%`;
  }
  if (summary.durationDeltaPct != null) {
    return `${summary.durationDeltaPct >= 0 ? '+' : ''}${summary.durationDeltaPct}%`;
  }
  return cardioVolumeValue(summary, distanceUnit);
}

function cardioVolumeDetail(summary: CardioTrendSummary, distanceUnit: DistanceUnit): string {
  const base = summary.distance14dMiles > 0
    ? `${formatDistance(summary.distance14dMiles, distanceUnit)} last 14d`
    : summary.duration14dSec > 0
      ? `${formatMinutesCompact(summary.duration14dSec / 60)} last 14d`
      : 'distance or time logged';
  if (summary.distanceDeltaPct != null) return `${base} vs prior 14d`;
  if (summary.durationDeltaPct != null) return `${base} vs prior 14d`;
  return base;
}

type TrendMetricSuggestion = {
  key: string;
  title: string;
  detail: string;
  icon: ComponentProps<typeof Ionicons>['name'];
  color: string;
};

function emptyZoneMinutes(): ZoneMinutes {
  return [0, 0, 0, 0, 0];
}

function addSummaryZones(acc: ZoneMinutes, summary: StoredWorkoutSummary): ZoneMinutes {
  const zones = summary.hrZoneMinutes ?? [];
  return [
    acc[0] + Math.max(0, Number(zones[0] ?? 0) || 0),
    acc[1] + Math.max(0, Number(zones[1] ?? 0) || 0),
    acc[2] + Math.max(0, Number(zones[2] ?? 0) || 0),
    acc[3] + Math.max(0, Number(zones[3] ?? 0) || 0),
    acc[4] + Math.max(0, Number(zones[4] ?? 0) || 0),
  ];
}

function isCardioFocusText(raw: unknown): boolean {
  const value = String(raw ?? '').toLowerCase();
  return /\b(cardio|conditioning|zone\s*2|interval|hiit|run|running|jog|bike|cycling|cycle|row|rowing|swim|swimming|elliptical|stair|hike|hiking|walk|walking|tempo|sprint|endurance|aerobic)\b/.test(value);
}

function zoneMinutesInWindow(
  summaries: StoredWorkoutSummary[],
  startDate: string,
  endDate: string,
): ZoneMinutes {
  return summaries
    .filter(row => dateInWindow(row.date, startDate, endDate) && isCardioHrZoneSource(row))
    .reduce((acc, row) => addSummaryZones(acc, row), emptyZoneMinutes());
}

function cardioSessionCountInWindow(
  paceHistory: PaceHistoryPoint[],
  summaries: StoredWorkoutSummary[],
  healthSummary: HealthSummary | null,
  startDate: string,
  endDate: string,
): number {
  const keys = new Set<string>();
  for (const point of paceHistory) {
    if (!dateInWindow(point.date, startDate, endDate)) continue;
    const hasCardioMetric = (point.distance != null && point.distance > 0)
      || paceSeconds(point.pace) != null
      || (point.duration_seconds != null && point.duration_seconds > 0);
    if (hasCardioMetric) {
      keys.add(`pace:${String(point.date ?? '').slice(0, 10)}:${String(point.exercise ?? 'cardio').toLowerCase()}`);
    }
  }
  for (const summary of summaries) {
    if (!dateInWindow(summary.date, startDate, endDate)) continue;
    const hasRoute = Array.isArray(summary.routeCoords) && summary.routeCoords.length > 0;
    if (isCardioFocusText(summary.focus) || hasRoute) {
      keys.add(`summary:${summary.date.slice(0, 10)}:${String(summary.focus ?? '').toLowerCase()}`);
    }
  }
  for (const workout of healthSummary?.workoutDetails ?? []) {
    if (!dateInWindow(workout.startDate, startDate, endDate)) continue;
    if (isCardioFocusText(workout.activityName) || (workout.distanceMiles ?? 0) > 0) {
      keys.add(`health:${String(workout.startDate).slice(0, 10)}:${workout.activityName.toLowerCase()}`);
    }
  }
  return keys.size;
}

type CardioActivityMixItem = {
  key: 'running' | 'cycling' | 'walking' | 'other';
  label: string;
  count: number;
};

function cardioActivityMixKey(raw: unknown): CardioActivityMixItem['key'] {
  const text = String(raw ?? '').toLowerCase();
  if (/\b(run|running|jog|jogging|treadmill|trail)\b/.test(text)) return 'running';
  if (/\b(bike|cycling|cycle|ride|riding|stationary bike)\b/.test(text)) return 'cycling';
  if (/\b(walk|walking|hike|hiking)\b/.test(text)) return 'walking';
  return 'other';
}

function buildCardioActivityMix(
  paceHistory: PaceHistoryPoint[],
  summaries: StoredWorkoutSummary[],
  healthSummary: HealthSummary | null,
  startDate: string,
  endDate: string,
): CardioActivityMixItem[] {
  const counts: Record<CardioActivityMixItem['key'], Set<string>> = {
    running: new Set(),
    cycling: new Set(),
    walking: new Set(),
    other: new Set(),
  };
  const add = (source: string, date: unknown, label: unknown) => {
    const day = String(date ?? '').slice(0, 10);
    if (!day || !dateInWindow(day, startDate, endDate)) return;
    const kind = cardioActivityMixKey(label);
    counts[kind].add(`${source}:${day}:${String(label ?? 'cardio').toLowerCase()}`);
  };
  for (const point of paceHistory) {
    const hasCardioMetric = (point.distance != null && point.distance > 0)
      || paceSeconds(point.pace) != null
      || (point.duration_seconds != null && point.duration_seconds > 0);
    if (hasCardioMetric) add('pace', point.date, point.exercise);
  }
  for (const summary of summaries) {
    const hasRoute = Array.isArray(summary.routeCoords) && summary.routeCoords.length > 0;
    if (isCardioFocusText(summary.focus) || hasRoute) add('summary', summary.date, summary.focus);
  }
  for (const workout of healthSummary?.workoutDetails ?? []) {
    if (isCardioFocusText(workout.activityName) || (workout.distanceMiles ?? 0) > 0) {
      add('health', workout.startDate, workout.activityName);
    }
  }
  const items: CardioActivityMixItem[] = [
    { key: 'running', label: 'Running', count: counts.running.size },
    { key: 'cycling', label: 'Cycling', count: counts.cycling.size },
    { key: 'walking', label: 'Walking', count: counts.walking.size },
    { key: 'other', label: 'Other', count: counts.other.size },
  ];
  return items.filter(item => item.count > 0);
}

function buildCardioTrendSummary(
  paceHistory: PaceHistoryPoint[],
  summaries: StoredWorkoutSummary[],
  healthSummary: HealthSummary | null,
  window: ProgressDateWindow,
): CardioTrendSummary {
  const today = dateKey(new Date());
  const current14Start = shiftDateKey(today, -13);
  const previous14Start = shiftDateKey(today, -27);
  const previous14End = shiftDateKey(today, -14);
  const current7Start = shiftDateKey(today, -6);
  const current30Start = shiftDateKey(today, -29);
  const usablePoints = paceHistory
    .filter(point => (point.distance != null && point.distance > 0)
      || paceSeconds(point.pace) != null
      || (point.duration_seconds != null && point.duration_seconds > 0))
    .sort((a, b) => parseDateKeyMs(a.date) - parseDateKeyMs(b.date));
  const current30Points = usablePoints.filter(point => dateInWindow(point.date, current30Start, today));
  const distance14dMiles = paceHistory
    .filter(point => dateInWindow(point.date, current14Start, today))
    .reduce((sum, point) => sum + Math.max(0, Number(point.distance) || 0), 0);
  const previousDistance14dMiles = paceHistory
    .filter(point => dateInWindow(point.date, previous14Start, previous14End))
    .reduce((sum, point) => sum + Math.max(0, Number(point.distance) || 0), 0);
  const distanceDeltaPct = previousDistance14dMiles > 0
    ? Math.round(((distance14dMiles - previousDistance14dMiles) / previousDistance14dMiles) * 100)
    : null;
  const duration14dSec = paceHistory
    .filter(point => dateInWindow(point.date, current14Start, today))
    .reduce((sum, point) => sum + cardioPointDurationSeconds(point), 0);
  const previousDuration14dSec = paceHistory
    .filter(point => dateInWindow(point.date, previous14Start, previous14End))
    .reduce((sum, point) => sum + cardioPointDurationSeconds(point), 0);
  const durationDeltaPct = previousDuration14dSec > 0
    ? Math.round(((duration14dSec - previousDuration14dSec) / previousDuration14dSec) * 100)
    : null;

  const zones14d = zoneMinutesInWindow(summaries, current14Start, today);
  const zones7d = zoneMinutesInWindow(summaries, current7Start, today);
  const zonesWeek = zoneMinutesInWindow(summaries, window.startDate, window.endDate);
  const previousZonesWeek = zoneMinutesInWindow(summaries, window.previousStartDate, window.previousEndDate);
  const easyZoneMinutes14d = zones14d[0] + zones14d[1];
  const hardZoneMinutes14d = zones14d[2] + zones14d[3] + zones14d[4];
  const easyHardTotal = easyZoneMinutes14d + hardZoneMinutes14d;
  const easySharePct = easyHardTotal > 0 ? Math.round((easyZoneMinutes14d / easyHardTotal) * 100) : null;

  // 30-day windows for the Cardio Fitness Profile radar.
  const distance30dMiles = paceHistory
    .filter(point => dateInWindow(point.date, current30Start, today))
    .reduce((sum, point) => sum + Math.max(0, Number(point.distance) || 0), 0);
  const zones30d = zoneMinutesInWindow(summaries, current30Start, today);
  const zone2Minutes30d = zones30d[1];
  const easyZoneMinutes30d = zones30d[0] + zones30d[1];
  const hardZoneMinutes30d = zones30d[2] + zones30d[3] + zones30d[4];
  const easyHardTotal30d = easyZoneMinutes30d + hardZoneMinutes30d;
  const easySharePct30d = easyHardTotal30d > 0 ? Math.round((easyZoneMinutes30d / easyHardTotal30d) * 100) : null;

  const byExercise = new Map<string, { name: string; rows: PaceHistoryPoint[] }>();
  for (const point of current30Points) {
    const key = cardioExerciseKey(point.exercise);
    const current = byExercise.get(key);
    byExercise.set(key, {
      name: current?.name ?? cardioExerciseDisplayName(point.exercise),
      rows: [...(current?.rows ?? []), point],
    });
  }
  let bestPaceTrend: { exercise: string; delta: number } | null = null;
  for (const { name, rows } of byExercise.values()) {
    const paceRows = rows
      .filter(point => paceSeconds(point.pace) != null)
      .sort((a, b) => parseDateKeyMs(a.date) - parseDateKeyMs(b.date));
    if (paceRows.length < 2) continue;
    const delta = paceSeconds(paceRows[paceRows.length - 1].pace)! - paceSeconds(paceRows[0].pace)!;
    if (!bestPaceTrend || delta < bestPaceTrend.delta) bestPaceTrend = { exercise: name, delta };
  }

  let longestDistanceMiles = 0;
  let longestDistanceExercise: string | null = null;
  let longestDurationSec = 0;
  let longestDurationExercise: string | null = null;
  for (const point of current30Points) {
    const distance = Math.max(0, Number(point.distance) || 0);
    const duration = Math.max(0, Number(point.duration_seconds) || 0);
    if (distance > longestDistanceMiles) {
      longestDistanceMiles = distance;
      longestDistanceExercise = cardioExerciseDisplayName(point.exercise);
    }
    if (duration > longestDurationSec) {
      longestDurationSec = duration;
      longestDurationExercise = cardioExerciseDisplayName(point.exercise);
    }
  }

  const cardioSessions7d = cardioSessionCountInWindow(paceHistory, summaries, healthSummary, current7Start, today);
  const cardioSessions30d = cardioSessionCountInWindow(paceHistory, summaries, healthSummary, current30Start, today);
  const vo2Max = healthSummary?.vo2Max ?? null;
  const hasZoneData = easyHardTotal > 0 || zones7d.some(v => v > 0) || zonesWeek.some(v => v > 0);
  const hasDistanceData = distance14dMiles > 0 || previousDistance14dMiles > 0 || longestDistanceMiles > 0;
  const hasData = hasDistanceData || duration14dSec > 0 || hasZoneData || cardioSessions7d > 0 || vo2Max != null || longestDurationSec > 0;

  const scoreParts: Array<{ value: number; weight: number }> = [];
  if (vo2Max != null) {
    const value = vo2Max >= 50 ? 95 : vo2Max >= 42 ? 80 : vo2Max >= 35 ? 65 : vo2Max >= 28 ? 45 : 25;
    scoreParts.push({ value, weight: 0.45 });
  }
  if (hasZoneData) {
    const z2 = zones7d[1];
    const value = z2 >= 150 ? 95 : z2 >= 90 ? 75 : z2 >= 45 ? 55 : z2 >= 15 ? 35 : 20;
    scoreParts.push({ value, weight: 0.30 });
  }
  if (bestPaceTrend != null) {
    scoreParts.push({ value: cardioPaceTrendScore(bestPaceTrend.delta), weight: 0.18 });
  }
  if (cardioSessions7d > 0) {
    const value = cardioSessions7d >= 3 ? 90 : cardioSessions7d >= 2 ? 70 : 50;
    scoreParts.push({ value, weight: 0.12 });
  }
  if (easySharePct != null && easyHardTotal >= 20) {
    const value = easySharePct >= 65 && easySharePct <= 90 ? 85
      : easySharePct >= 50 && easySharePct <= 95 ? 70
        : 45;
    scoreParts.push({ value, weight: 0.10 });
  }
  const hasPrimaryCardioSignal = vo2Max != null || hasZoneData || bestPaceTrend != null;
  const rawScore = scoreParts.length > 0
    ? Math.round(scoreParts.reduce((sum, part) => sum + part.value * part.weight, 0) / scoreParts.reduce((sum, part) => sum + part.weight, 0))
    : null;
  const score = rawScore == null ? null : (!hasPrimaryCardioSignal ? Math.min(rawScore, 55) : rawScore);
  const rating = score == null ? 'Need cardio data'
    : score >= 85 ? 'Strong aerobic base'
      : score >= 70 ? 'Good aerobic work'
        : score >= 50 ? 'Building cardio base'
          : 'Needs consistency';

  return {
    hasData,
    score,
    rating,
    distance14dMiles,
    previousDistance14dMiles,
    distanceDeltaPct,
    duration14dSec,
    previousDuration14dSec,
    durationDeltaPct,
    zone2Minutes7d: zones7d[1],
    zone2MinutesWeek: zonesWeek[1],
    previousZone2MinutesWeek: previousZonesWeek[1],
    cardioSessions7d,
    easyZoneMinutes14d,
    hardZoneMinutes14d,
    easySharePct,
    distance30dMiles,
    zone2Minutes30d,
    cardioSessions30d,
    easyZoneMinutes30d,
    hardZoneMinutes30d,
    easySharePct30d,
    bestPaceDeltaSec: bestPaceTrend?.delta ?? null,
    bestPaceExercise: bestPaceTrend?.exercise ?? null,
    longestDistanceMiles,
    longestDistanceExercise,
    longestDurationSec,
    longestDurationExercise,
    latestPoint: usablePoints[usablePoints.length - 1] ?? null,
    vo2Max,
  };
}

function buildCardioInsights(summary: CardioTrendSummary, distanceUnit: DistanceUnit) {
  if (!summary.hasData) return [];
  const items: Array<{ label: string; value: string; detail: string }> = [];
  if (summary.distance14dMiles > 0 || summary.previousDistance14dMiles > 0) {
    items.push({
      label: '14d distance',
      value: formatDistance(summary.distance14dMiles, distanceUnit),
      detail: summary.distanceDeltaPct == null
        ? 'distance logged in the last 14 days'
        : `${summary.distanceDeltaPct >= 0 ? '+' : ''}${summary.distanceDeltaPct}% vs previous 14 days`,
    });
  } else if (summary.duration14dSec > 0 || summary.previousDuration14dSec > 0) {
    items.push({
      label: '14d time',
      value: formatMinutesCompact(summary.duration14dSec / 60),
      detail: summary.durationDeltaPct == null
        ? 'cardio time logged in the last 14 days'
        : `${summary.durationDeltaPct >= 0 ? '+' : ''}${summary.durationDeltaPct}% vs previous 14 days`,
    });
  }
  if (summary.zone2MinutesWeek > 0 || summary.previousZone2MinutesWeek > 0) {
    const delta = Math.round(summary.zone2MinutesWeek - summary.previousZone2MinutesWeek);
    items.push({
      label: 'Zone 2',
      value: `${Math.round(summary.zone2MinutesWeek)}m`,
      detail: summary.previousZone2MinutesWeek > 0
        ? `${delta >= 0 ? '+' : ''}${delta}m vs prior week`
        : 'easy aerobic minutes this week',
    });
  }
  if (summary.cardioSessions7d > 0) {
    items.push({
      label: 'Sessions',
      value: String(summary.cardioSessions7d),
      detail: `cardio session${summary.cardioSessions7d === 1 ? '' : 's'} in the last 7 days`,
    });
  }
  if (summary.easySharePct != null) {
    items.push({
      label: 'Intensity split',
      value: `${summary.easySharePct}% easy`,
      detail: 'Z1-Z2 vs Z3-Z5 from HR zones',
    });
  }
  if (summary.bestPaceDeltaSec != null && summary.bestPaceExercise) {
    items.push({
      label: 'Pace trend',
      value: formatPaceDelta(summary.bestPaceDeltaSec),
      detail: `${summary.bestPaceExercise} vs first log`,
    });
  }
  if (summary.longestDistanceMiles > 0 && summary.longestDistanceExercise) {
    items.push({
      label: 'Longest session',
      value: formatDistance(summary.longestDistanceMiles, distanceUnit),
      detail: summary.longestDistanceExercise,
    });
  } else if (summary.longestDurationSec > 0 && summary.longestDurationExercise) {
    items.push({
      label: 'Longest session',
      value: formatDuration(summary.longestDurationSec),
      detail: summary.longestDurationExercise,
    });
  }
  if (items.length === 0 && summary.vo2Max != null) {
    items.push({
      label: 'VO₂ max',
      value: summary.vo2Max.toFixed(1),
      detail: `${HEALTH_WEARABLE_LABEL} cardio fitness estimate`,
    });
  }
  return items.slice(0, 6);
}

function positiveNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function average(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((v): v is number => Number.isFinite(v ?? NaN));
  if (finite.length === 0) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function formatMinutesCompact(minutes: number): string {
  const rounded = Math.max(0, Math.round(minutes));
  if (rounded >= 60) {
    const h = Math.floor(rounded / 60);
    const m = rounded % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${rounded}m`;
}

function formatPacePer100m(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  const mins = Math.floor(rounded / 60);
  const secs = rounded % 60;
  return `${mins}:${String(secs).padStart(2, '0')}/100m`;
}

function manualActivityText(session: WorkoutSession): string {
  const activity = session.manualActivity;
  return [
    activity?.category,
    activity?.subtype,
    activity?.cardioStyle,
    session.focus,
  ].map(value => String(value ?? '').toLowerCase()).join(' ');
}

function activityTextIncludesAny(session: WorkoutSession, terms: string[]): boolean {
  const text = manualActivityText(session);
  return terms.some(term => text.includes(term));
}

function recentManualActivitySessions(history: WorkoutSession[]): WorkoutSession[] {
  const today = dateKey(new Date());
  const start = shiftDateKey(today, -89);
  return history
    .filter(session => session.completed && !session.skipped && session.manualActivity && dateInWindow(session.date, start, today))
    .sort((a, b) => parseDateKeyMs(a.date) - parseDateKeyMs(b.date));
}

function sessionDurationMinutes(session: WorkoutSession): number {
  return Math.max(0, Number(session.durationSeconds) || 0) / 60;
}

function swimDistanceMiles(session: WorkoutSession): number | null {
  const activityDistance = positiveNumber(session.manualActivity?.distanceMiles);
  if (activityDistance != null) return activityDistance;
  const details = session.manualActivity?.details;
  const poolLengthMeters = positiveNumber(details?.poolLengthMeters);
  const laps = positiveNumber(details?.laps);
  if (poolLengthMeters != null && laps != null) {
    return (poolLengthMeters * laps) / 1609.344;
  }
  return null;
}

function latestActivitySubtitle(sessions: WorkoutSession[], fallback: string): string {
  const latest = [...sessions].sort((a, b) => parseDateKeyMs(b.date) - parseDateKeyMs(a.date))[0];
  const subtype = latest?.manualActivity?.subtype;
  return subtype ? humanizeToken(subtype) : fallback;
}

function formatSignedNumber(value: number, suffix = '', precision = 0): string {
  const rounded = Math.round(value * Math.pow(10, precision)) / Math.pow(10, precision);
  return `${rounded >= 0 ? '+' : ''}${rounded.toFixed(precision)}${suffix}`;
}

function hardSessionSignal(summary: StoredWorkoutSummary): boolean {
  const hardZones = (summary.hrZoneMinutes ?? []).slice(2).reduce((sum, min) => sum + (Number(min) || 0), 0);
  return (summary.trainingScore ?? 0) >= 75
    || (summary.feedback?.intensity ?? 0) >= 4
    || hardZones >= 20
    || /\b(hiit|interval|sprint|race|tempo|heavy|hard)\b/i.test(String(summary.focus ?? ''));
}

function sessionCategoryLabel(session: WorkoutSession): string {
  const category = session.manualActivity?.category;
  if (category) return humanizeToken(category);
  if (session.exercises?.length > 0) return 'Strength';
  if (isCardioFocusText(session.focus)) return 'Cardio';
  return 'Workout';
}

function buildHighValueTrendCards(input: {
  history: WorkoutSession[];
  summaries: StoredWorkoutSummary[];
  sleepHistory: ProgressSleepHistoryPoint[];
  healthSummary: HealthSummary | null;
  weightEntries: WeightEntry[];
  bodyScanHistory: BodyScanEntry[];
  mealAverages: import('../services/api').MealAverages | null;
  nutritionScoreWeekly: import('../services/api').NutritionScoreWeekly | null;
  cardioSummary: CardioTrendSummary;
  weightUnit: WeightUnit;
  distanceUnit: DistanceUnit;
  showMealProgress: boolean;
}): TrendActivityCard[] {
  const {
    history,
    summaries,
    sleepHistory,
    healthSummary,
    weightEntries,
    bodyScanHistory,
    mealAverages,
    nutritionScoreWeekly,
    cardioSummary,
    weightUnit,
    distanceUnit,
    showMealProgress,
  } = input;
  const today = dateKey(new Date());
  const current14Start = shiftDateKey(today, -13);
  const previous14Start = shiftDateKey(today, -27);
  const previous14End = shiftDateKey(today, -14);
  const current28Start = shiftDateKey(today, -27);
  const previous28Start = shiftDateKey(today, -55);
  const previous28End = shiftDateKey(today, -28);
  const cards: TrendActivityCard[] = [];

  const sleepByNight = new Map(sleepHistory.map(point => [point.night.slice(0, 10), point]));
  const sleepBaseline = sleepHistory.slice(-30);
  const hrvBaseline = average(sleepBaseline.map(point => point.hrv));
  const rhrBaseline = average(sleepBaseline.map(point => point.restingHr));
  const hardSummaries = summaries
    .filter(summary => dateInWindow(summary.date, shiftDateKey(today, -20), today) && hardSessionSignal(summary))
    .sort((a, b) => a.date.localeCompare(b.date));
  const nextSleep = hardSummaries
    .map(summary => sleepByNight.get(shiftDateKey(String(summary.date ?? '').slice(0, 10), 1)))
    .filter((point): point is ProgressSleepHistoryPoint => !!point);
  const hrvDelta = hrvBaseline != null
    ? average(nextSleep.map(point => point.hrv != null ? point.hrv - hrvBaseline : null))
    : null;
  const rhrDelta = rhrBaseline != null
    ? average(nextSleep.map(point => point.restingHr != null ? point.restingHr - rhrBaseline : null))
    : null;
  const nextSleepScore = average(nextSleep.map(point => point.score));
  if (nextSleep.length > 0 || healthSummary?.sleepScore || healthSummary?.hrvAvg != null || healthSummary?.restingHeartRate != null) {
    const recoveryColor = hrvDelta != null
      ? hrvDelta >= 0 ? '#22C55E' : '#F59E0B'
      : rhrDelta != null
        ? rhrDelta <= 0 ? '#22C55E' : '#F59E0B'
        : '#14B8A6';
    cards.push({
      key: 'recovery-response',
      title: 'Recovery response',
      subtitle: nextSleep.length > 0 ? 'After hard sessions' : 'Wearable recovery baseline',
      icon: 'leaf-outline',
      color: recoveryColor,
      metrics: [
        {
          label: 'Samples',
          value: nextSleep.length > 0 ? String(nextSleep.length) : (healthSummary?.sleepScore ? '1' : '--'),
          detail: nextSleep.length > 0 ? 'next-night hard-day reads' : 'latest recovery read',
        },
        ...(hrvDelta != null ? [{ label: 'HRV response', value: formatSignedNumber(hrvDelta, ' ms', 0), detail: 'vs 30-night baseline' }] : []),
        ...(rhrDelta != null ? [{ label: 'RHR response', value: formatSignedNumber(rhrDelta, ' bpm', 0), detail: 'lower is easier recovery' }] : []),
        ...(nextSleepScore != null ? [{ label: 'Sleep score', value: String(Math.round(nextSleepScore)), detail: 'after hard sessions' }] : []),
      ],
    });
  }

  const currentScores = summaries
    .filter(summary => dateInWindow(summary.date, current14Start, today))
    .map(summary => positiveNumber(summary.trainingScore))
    .filter((score): score is number => score != null);
  const previousScores = summaries
    .filter(summary => dateInWindow(summary.date, previous14Start, previous14End))
    .map(summary => positiveNumber(summary.trainingScore))
    .filter((score): score is number => score != null);
  const currentQuality = average(currentScores);
  const previousQuality = average(previousScores);
  const currentFeedback = summaries.filter(summary => dateInWindow(summary.date, current14Start, today) && summary.feedback);
  const avgIntensity = average(currentFeedback.map(summary => summary.feedback?.intensity));
  const sorenessMentions = currentFeedback.reduce((sum, summary) => sum + (summary.feedback?.sorenessAreas?.length ?? 0), 0);
  if (currentQuality != null || currentFeedback.length > 0) {
    const qualityDelta = currentQuality != null && previousQuality != null ? currentQuality - previousQuality : null;
    cards.push({
      key: 'workout-quality',
      title: 'Workout quality',
      subtitle: 'Training score + feedback',
      icon: 'checkmark-done-outline',
      color: qualityDelta == null || qualityDelta >= 0 ? '#14B8A6' : '#F59E0B',
      metrics: [
        ...(currentQuality != null ? [{ label: 'Avg score', value: String(Math.round(currentQuality)), detail: `${currentScores.length} scored session${currentScores.length === 1 ? '' : 's'}` }] : []),
        ...(qualityDelta != null ? [{ label: 'Trend', value: formatSignedNumber(qualityDelta, '', 0), detail: 'vs prior 14 days' }] : []),
        ...(avgIntensity != null ? [{ label: 'Intensity', value: `${avgIntensity.toFixed(1)}/5`, detail: 'post-workout feedback' }] : []),
        { label: 'Soreness', value: String(sorenessMentions), detail: 'areas mentioned in 14d' },
      ],
    });
  }

  const setRows = history
    .filter(session => session.completed && !session.skipped)
    .flatMap(session => (session.exercises ?? []).flatMap(ex => (ex.sets ?? []).map(set => ({ set, date: session.date }))));
  const currentRir = average(setRows
    .filter(row => dateInWindow(row.date, current14Start, today))
    .map(row => row.set.rir));
  const previousRir = average(setRows
    .filter(row => dateInWindow(row.date, previous14Start, previous14End))
    .map(row => row.set.rir));
  const loadedSets14d = setRows.filter(row =>
    dateInWindow(row.date, current14Start, today)
    && positiveNumber(row.set.weightLbs) != null
    && positiveNumber(row.set.reps) != null
  ).length;
  const volumeTrend = buildStrengthVolumeTrend(history, { bucketMode: 'rolling', windowDays: 14, weekCount: 2 });
  if (currentRir != null || loadedSets14d > 0 || volumeTrend.current.loadedSets > 0) {
    const rirDelta = currentRir != null && previousRir != null ? currentRir - previousRir : null;
    const readinessColor = currentRir == null ? '#6366F1' : currentRir >= 1.5 ? '#22C55E' : '#F59E0B';
    cards.push({
      key: 'strength-readiness',
      title: 'Strength readiness',
      subtitle: 'RIR + workload',
      icon: 'barbell-outline',
      color: readinessColor,
      metrics: [
        ...(currentRir != null ? [{ label: 'Avg RIR', value: currentRir.toFixed(1), detail: rirDelta != null ? `${formatSignedNumber(rirDelta, '', 1)} vs prior` : 'last 14 days' }] : []),
        ...(volumeTrend.deltaPct != null ? [{ label: 'Volume trend', value: `${volumeTrend.deltaPct >= 0 ? '+' : ''}${volumeTrend.deltaPct}%`, detail: '14d vs prior 14d' }] : []),
        { label: 'Loaded sets', value: String(loadedSets14d), detail: 'last 14 days' },
      ],
    });
  }

  if (cardioSummary.hasData) {
    const volumeTrend = cardioVolumeTrendValue(cardioSummary, distanceUnit);
    cards.push({
      key: 'cardio-efficiency',
      title: 'Cardio volume',
      subtitle: 'Mileage, time, zones',
      icon: 'pulse-outline',
      color: '#06B6D4',
      metrics: [
        ...(volumeTrend ? [{ label: 'Volume trend', value: volumeTrend, detail: cardioVolumeDetail(cardioSummary, distanceUnit) }] : []),
        ...(cardioSummary.bestPaceDeltaSec != null ? [{ label: 'Pace trend', value: formatPaceDelta(cardioSummary.bestPaceDeltaSec), detail: cardioSummary.bestPaceExercise ?? 'comparable cardio' }] : []),
        ...(cardioSummary.easySharePct != null ? [{ label: 'Easy share', value: `${cardioSummary.easySharePct}%`, detail: 'Z1-Z2 vs Z3-Z5' }] : []),
        ...(cardioSummary.zone2MinutesWeek > 0 ? [{ label: 'Zone 2', value: `${Math.round(cardioSummary.zone2MinutesWeek)}m`, detail: 'this plan week' }] : []),
        ...(cardioSummary.vo2Max != null ? [{ label: 'VO2 max', value: cardioSummary.vo2Max.toFixed(1), detail: HEALTH_WEARABLE_LABEL }] : []),
      ],
    });
  }

  const currentSessions = history.filter(session => session.completed && !session.skipped && dateInWindow(session.date, current28Start, today));
  const previousSessions = history.filter(session => session.completed && !session.skipped && dateInWindow(session.date, previous28Start, previous28End));
  if (currentSessions.length > 0 || previousSessions.length > 0) {
    const currentDays = new Set(currentSessions.map(session => String(session.date ?? '').slice(0, 10))).size;
    const previousDays = new Set(previousSessions.map(session => String(session.date ?? '').slice(0, 10))).size;
    const categoryCounts = new Map<string, number>();
    for (const session of currentSessions) {
      const label = sessionCategoryLabel(session);
      categoryCounts.set(label, (categoryCounts.get(label) ?? 0) + 1);
    }
    const topCategory = Array.from(categoryCounts.entries()).sort((a, b) => b[1] - a[1])[0] ?? null;
    cards.push({
      key: 'consistency-mix',
      title: 'Consistency mix',
      subtitle: 'Activity distribution',
      icon: 'calendar-outline',
      color: currentDays >= previousDays ? '#22C55E' : '#F59E0B',
      metrics: [
        { label: 'Active days', value: String(currentDays), detail: `${formatSignedNumber(currentDays - previousDays)} vs prior 28d` },
        { label: 'Sessions', value: String(currentSessions.length), detail: 'last 28 days' },
        ...(topCategory ? [{ label: 'Top category', value: topCategory[0], detail: `${topCategory[1]} session${topCategory[1] === 1 ? '' : 's'}` }] : []),
      ],
    });
  }

  if (showMealProgress && (nutritionScoreWeekly || mealAverages)) {
    const trackingPct = positiveNumber(mealAverages?.tracking_rate_pct);
    cards.push({
      key: 'nutrition-trend',
      title: 'Nutrition trend',
      subtitle: 'Logging + target hits',
      icon: 'restaurant-outline',
      color: (nutritionScoreWeekly?.avg_score ?? 0) >= 75 ? '#22C55E' : '#F59E0B',
      metrics: [
        ...(nutritionScoreWeekly ? [{ label: 'Avg score', value: String(Math.round(nutritionScoreWeekly.avg_score)), detail: `${nutritionScoreWeekly.days_with_data}/${nutritionScoreWeekly.window_days} days scored` }] : []),
        ...(nutritionScoreWeekly ? [{ label: 'Protein hits', value: String(nutritionScoreWeekly.days_hit_protein), detail: 'days on target' }] : []),
        ...(nutritionScoreWeekly ? [{ label: 'Fiber hits', value: String(nutritionScoreWeekly.days_hit_fiber), detail: 'days on target' }] : []),
        ...(trackingPct != null ? [{ label: 'Tracking', value: `${Math.round(trackingPct)}%`, detail: 'meal logging rate' }] : []),
      ],
    });
  }

  const sortedWeights = [...weightEntries]
    .filter(entry => positiveNumber(entry.weightLbs) != null)
    .sort((a, b) => parseDateKeyMs(a.date) - parseDateKeyMs(b.date));
  const recentWeights = sortedWeights.filter(entry => dateInWindow(entry.date, shiftDateKey(today, -59), today));
  const firstWeight = recentWeights[0];
  const lastWeight = recentWeights[recentWeights.length - 1];
  const sortedScans = [...bodyScanHistory]
    .filter(scan => positiveNumber(scan.bodyFatPct) != null)
    .sort((a, b) => parseDateKeyMs(a.date) - parseDateKeyMs(b.date));
  const firstScan = sortedScans[0];
  const lastScan = sortedScans[sortedScans.length - 1];
  if ((firstWeight && lastWeight && firstWeight.date !== lastWeight.date) || (firstScan && lastScan && firstScan.date !== lastScan.date)) {
    const days = firstWeight && lastWeight ? Math.max(1, Math.round((parseDateKeyMs(lastWeight.date) - parseDateKeyMs(firstWeight.date)) / 86400000)) : 0;
    const weightPerWeek = firstWeight && lastWeight && days > 0
      ? ((lastWeight.weightLbs - firstWeight.weightLbs) / days) * 7
      : null;
    const bfDelta = firstScan && lastScan && firstScan.date !== lastScan.date
      ? lastScan.bodyFatPct - firstScan.bodyFatPct
      : null;
    cards.push({
      key: 'body-goal-trend',
      title: 'Body / goal trend',
      subtitle: 'Scale + scan direction',
      icon: 'body-outline',
      color: weightPerWeek == null || Math.abs(weightPerWeek) <= 1.5 ? '#6366F1' : '#F59E0B',
      metrics: [
        ...(weightPerWeek != null ? [{ label: 'Scale trend', value: `${formatSignedWeightDelta(weightPerWeek, weightUnit)}/wk`, detail: `${recentWeights.length} weigh-in${recentWeights.length === 1 ? '' : 's'}` }] : []),
        ...(lastWeight ? [{ label: 'Latest weight', value: formatWeight(lastWeight.weightLbs, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 }), detail: formatDate(lastWeight.date) }] : []),
        ...(bfDelta != null ? [{ label: 'Body fat', value: formatSignedNumber(bfDelta, '%', 1), detail: `${sortedScans.length} scan${sortedScans.length === 1 ? '' : 's'}` }] : []),
        ...(cardioSummary.longestDistanceMiles > 0 ? [{ label: 'Cardio range', value: formatDistance(cardioSummary.longestDistanceMiles, distanceUnit), detail: 'longest 30d session' }] : []),
      ],
    });
  }

  return cards.filter(card => card.metrics.length > 0).slice(0, 8);
}

function buildActivityTrendCards(history: WorkoutSession[], distanceUnit: DistanceUnit): TrendActivityCard[] {
  const recent = recentManualActivitySessions(history);
  const cards: TrendActivityCard[] = [];

  const sauna = recent.filter(session => activityTextIncludesAny(session, ['sauna']));
  if (sauna.length > 0) {
    const totalMinutes = sauna.reduce((sum, session) => sum + sessionDurationMinutes(session), 0);
    const avgTemp = average(sauna.map(session => positiveNumber(session.manualActivity?.details?.temperatureF)));
    const avgHumidity = average(sauna.map(session => positiveNumber(session.manualActivity?.details?.humidityPct)));
    cards.push({
      key: 'sauna',
      title: 'Sauna exposure',
      subtitle: latestActivitySubtitle(sauna, 'Heat recovery'),
      icon: 'flame-outline',
      color: '#F97316',
      metrics: [
        { label: 'Sessions', value: String(sauna.length), detail: 'last 90d' },
        { label: 'Heat time', value: formatMinutesCompact(totalMinutes), detail: 'logged exposure' },
        ...(avgTemp != null ? [{ label: 'Avg temp', value: `${Math.round(avgTemp)}F`, detail: avgHumidity != null ? `${Math.round(avgHumidity)}% humidity` : 'temperature logs' }] : []),
      ],
    });
  }

  const swims = recent.filter(session => activityTextIncludesAny(session, ['swim', 'pool']));
  if (swims.length > 0) {
    const swimMiles = swims.map(swimDistanceMiles).filter((v): v is number => v != null);
    const totalMiles = swimMiles.reduce((sum, value) => sum + value, 0);
    const totalLaps = swims.reduce((sum, session) => sum + (positiveNumber(session.manualActivity?.details?.laps) ?? 0), 0);
    const totalSeconds = swims.reduce((sum, session) => sum + Math.max(0, Number(session.durationSeconds) || 0), 0);
    const totalMeters = totalMiles * 1609.344;
    const pace100 = totalMeters > 0 && totalSeconds > 0 ? (totalSeconds / totalMeters) * 100 : null;
    cards.push({
      key: 'swim',
      title: 'Swim efficiency',
      subtitle: latestActivitySubtitle(swims, 'Pool or open water'),
      icon: 'water-outline',
      color: '#06B6D4',
      metrics: [
        { label: 'Sessions', value: String(swims.length), detail: 'last 90d' },
        ...(totalMiles > 0 ? [{ label: 'Distance', value: formatDistance(totalMiles, distanceUnit), detail: totalLaps > 0 ? `${Math.round(totalLaps)} laps logged` : 'swim volume' }] : []),
        ...(pace100 != null ? [{ label: 'Avg pace', value: formatPacePer100m(pace100), detail: 'from distance and duration' }] : []),
      ],
    });
  }

  const rides = recent.filter(session => activityTextIncludesAny(session, ['ride', 'cycling', 'cycle', 'bike', 'spin']));
  if (rides.length > 0) {
    const totalMiles = rides.reduce((sum, session) => sum + (positiveNumber(session.manualActivity?.distanceMiles) ?? 0), 0);
    const bestWatts = rides.reduce((best, session) => Math.max(best, positiveNumber(session.manualActivity?.details?.avgWatts) ?? 0), 0);
    const elevationFt = rides.reduce((sum, session) => sum + (positiveNumber(session.manualActivity?.details?.elevationGainFt) ?? 0), 0);
    cards.push({
      key: 'cycling',
      title: 'Cycling output',
      subtitle: latestActivitySubtitle(rides, 'Ride trend'),
      icon: 'bicycle-outline',
      color: '#22C55E',
      metrics: [
        { label: 'Sessions', value: String(rides.length), detail: 'last 90d' },
        ...(totalMiles > 0 ? [{ label: 'Distance', value: formatDistance(totalMiles, distanceUnit), detail: 'total ride volume' }] : []),
        ...(bestWatts > 0 ? [{ label: 'Best power', value: `${Math.round(bestWatts)} W`, detail: 'best avg watts' }] : []),
        ...(elevationFt > 0 ? [{ label: 'Elevation', value: `${Math.round(elevationFt).toLocaleString()} ft`, detail: 'climbing load' }] : []),
      ],
    });
  }

  const runWalkHike = recent.filter(session => activityTextIncludesAny(session, ['run', 'jog', 'walk', 'hike', 'trail', 'treadmill']));
  if (runWalkHike.length > 0) {
    const totalMiles = runWalkHike.reduce((sum, session) => sum + (positiveNumber(session.manualActivity?.distanceMiles) ?? 0), 0);
    const longest = runWalkHike.reduce((best, session) => Math.max(best, positiveNumber(session.manualActivity?.distanceMiles) ?? 0), 0);
    const elevationFt = runWalkHike.reduce((sum, session) => sum + (positiveNumber(session.manualActivity?.details?.elevationGainFt) ?? 0), 0);
    cards.push({
      key: 'run-walk-hike',
      title: 'Run / walk / hike',
      subtitle: latestActivitySubtitle(runWalkHike, 'Foot miles'),
      icon: 'footsteps-outline',
      color: '#84CC16',
      metrics: [
        { label: 'Sessions', value: String(runWalkHike.length), detail: 'last 90d' },
        ...(totalMiles > 0 ? [{ label: 'Distance', value: formatDistance(totalMiles, distanceUnit), detail: longest > 0 ? `${formatDistance(longest, distanceUnit)} longest` : 'total mileage' }] : []),
        ...(elevationFt > 0 ? [{ label: 'Elevation', value: `${Math.round(elevationFt).toLocaleString()} ft`, detail: 'climb logged' }] : []),
      ],
    });
  }

  const cold = recent.filter(session => activityTextIncludesAny(session, ['cold_plunge', 'ice_bath', 'contrast']));
  if (cold.length > 0) {
    const totalMinutes = cold.reduce((sum, session) => sum + sessionDurationMinutes(session), 0);
    const avgTemp = average(cold.map(session => positiveNumber(session.manualActivity?.details?.temperatureF)));
    const rounds = cold.reduce((sum, session) => sum + (positiveNumber(session.manualActivity?.details?.rounds) ?? 0), 0);
    cards.push({
      key: 'cold-exposure',
      title: 'Cold exposure',
      subtitle: latestActivitySubtitle(cold, 'Recovery stimulus'),
      icon: 'snow-outline',
      color: '#38BDF8',
      metrics: [
        { label: 'Sessions', value: String(cold.length), detail: 'last 90d' },
        { label: 'Exposure', value: formatMinutesCompact(totalMinutes), detail: rounds > 0 ? `${Math.round(rounds)} rounds` : 'logged duration' },
        ...(avgTemp != null ? [{ label: 'Avg temp', value: `${Math.round(avgTemp)}F`, detail: 'water temperature' }] : []),
      ],
    });
  }

  const climbing = recent.filter(session => activityTextIncludesAny(session, ['climbing', 'climb', 'boulder', 'top_rope']));
  const skiing = recent.filter(session => activityTextIncludesAny(session, ['skiing', 'ski']));
  if (climbing.length > 0 || skiing.length > 0) {
    const latestGrade = [...climbing].reverse().map(session => session.manualActivity?.details?.climbingGrade).find(Boolean);
    const skiVerticalFt = skiing.reduce((sum, session) => sum + (positiveNumber(session.manualActivity?.details?.skiVerticalFt) ?? 0), 0);
    const skiRuns = skiing.reduce((sum, session) => sum + (positiveNumber(session.manualActivity?.details?.skiRuns) ?? 0), 0);
    cards.push({
      key: 'sport-skills',
      title: 'Sport details',
      subtitle: latestActivitySubtitle(climbing.length > 0 ? climbing : skiing, 'Skill sessions'),
      icon: 'trophy-outline',
      color: '#A855F7',
      metrics: [
        { label: 'Sessions', value: String(climbing.length + skiing.length), detail: 'last 90d' },
        ...(latestGrade ? [{ label: 'Climb grade', value: String(latestGrade), detail: 'latest logged grade' }] : []),
        ...(skiVerticalFt > 0 ? [{ label: 'Ski vertical', value: `${Math.round(skiVerticalFt).toLocaleString()} ft`, detail: skiRuns > 0 ? `${Math.round(skiRuns)} runs` : 'vertical load' }] : []),
      ],
    });
  }

  const indoorCardio = recent.filter(session => activityTextIncludesAny(session, ['row', 'rowing', 'elliptical', 'stair', 'hiit', 'bootcamp', 'conditioning']));
  if (indoorCardio.length > 0) {
    const totalMinutes = indoorCardio.reduce((sum, session) => sum + sessionDurationMinutes(session), 0);
    const calories = indoorCardio.reduce((sum, session) => sum + (positiveNumber(session.manualActivity?.caloriesBurned) ?? 0), 0);
    const avgHr = average(indoorCardio.map(session => positiveNumber(session.manualActivity?.avgHeartRate)));
    cards.push({
      key: 'indoor-cardio',
      title: 'Indoor cardio',
      subtitle: latestActivitySubtitle(indoorCardio, 'Machine and class work'),
      icon: 'sync-outline',
      color: '#EF4444',
      metrics: [
        { label: 'Sessions', value: String(indoorCardio.length), detail: 'last 90d' },
        { label: 'Duration', value: formatMinutesCompact(totalMinutes), detail: 'total cardio time' },
        ...(calories > 0 ? [{ label: 'Energy', value: `${Math.round(calories)} kcal`, detail: 'logged burn' }] : []),
        ...(avgHr != null ? [{ label: 'Avg HR', value: `${Math.round(avgHr)} bpm`, detail: 'where available' }] : []),
      ],
    });
  }

  const mobility = recent.filter(session => session.manualActivity?.category === 'mobility' || activityTextIncludesAny(session, ['yoga', 'stretch', 'pilates', 'foam_roll', 'mobility']));
  if (mobility.length > 0) {
    const totalMinutes = mobility.reduce((sum, session) => sum + sessionDurationMinutes(session), 0);
    const styleCounts = new Map<string, number>();
    for (const session of mobility) {
      const style = session.manualActivity?.details?.yogaStyle ?? session.manualActivity?.subtype ?? 'mobility';
      styleCounts.set(String(style), (styleCounts.get(String(style)) ?? 0) + 1);
    }
    const topStyle = Array.from(styleCounts.entries()).sort((a, b) => b[1] - a[1])[0] ?? null;
    cards.push({
      key: 'mobility',
      title: 'Mobility dose',
      subtitle: latestActivitySubtitle(mobility, 'Tissue and range work'),
      icon: 'body-outline',
      color: '#A3E635',
      metrics: [
        { label: 'Sessions', value: String(mobility.length), detail: 'last 90d' },
        { label: 'Duration', value: formatMinutesCompact(totalMinutes), detail: 'logged mobility time' },
        ...(topStyle ? [{ label: 'Top style', value: humanizeToken(topStyle[0]), detail: `${topStyle[1]} session${topStyle[1] === 1 ? '' : 's'}` }] : []),
      ],
    });
  }

  const activeWork = recent.filter(session => session.manualActivity?.category === 'active'
    || activityTextIncludesAny(session, ['yard_work', 'chopping_wood', 'moving', 'gardening', 'cleaning', 'construction', 'shoveling', 'playing', 'dancing']));
  if (activeWork.length > 0) {
    const totalMinutes = activeWork.reduce((sum, session) => sum + sessionDurationMinutes(session), 0);
    const calories = activeWork.reduce((sum, session) => sum + (positiveNumber(session.manualActivity?.caloriesBurned) ?? 0), 0);
    cards.push({
      key: 'active-work',
      title: 'Active work',
      subtitle: latestActivitySubtitle(activeWork, 'Non-gym activity'),
      icon: 'hammer-outline',
      color: '#EAB308',
      metrics: [
        { label: 'Sessions', value: String(activeWork.length), detail: 'last 90d' },
        { label: 'Duration', value: formatMinutesCompact(totalMinutes), detail: 'yard, home, labor, play' },
        ...(calories > 0 ? [{ label: 'Energy', value: `${Math.round(calories)} kcal`, detail: 'estimated burn' }] : []),
      ],
    });
  }

  const sportPlay = recent.filter(session => session.manualActivity?.category === 'sport'
    && !activityTextIncludesAny(session, ['climbing', 'climb', 'boulder', 'skiing', 'ski']));
  if (sportPlay.length > 0) {
    const totalMinutes = sportPlay.reduce((sum, session) => sum + sessionDurationMinutes(session), 0);
    const sportCounts = new Map<string, number>();
    for (const session of sportPlay) {
      const sport = session.manualActivity?.subtype ?? 'sport';
      sportCounts.set(sport, (sportCounts.get(sport) ?? 0) + 1);
    }
    const topSport = Array.from(sportCounts.entries()).sort((a, b) => b[1] - a[1])[0] ?? null;
    cards.push({
      key: 'sport-play',
      title: 'Sport play',
      subtitle: latestActivitySubtitle(sportPlay, 'Court, field, or water'),
      icon: 'basketball-outline',
      color: '#F59E0B',
      metrics: [
        { label: 'Sessions', value: String(sportPlay.length), detail: 'last 90d' },
        { label: 'Duration', value: formatMinutesCompact(totalMinutes), detail: 'sport exposure' },
        ...(topSport ? [{ label: 'Top sport', value: humanizeToken(topSport[0]), detail: `${topSport[1]} session${topSport[1] === 1 ? '' : 's'}` }] : []),
      ],
    });
  }

  const downshift = recent.filter(session => activityTextIncludesAny(session, ['breathwork', 'meditation', 'sleep', 'general']));
  if (downshift.length > 0) {
    const totalMinutes = downshift.reduce((sum, session) => sum + sessionDurationMinutes(session), 0);
    const rounds = downshift.reduce((sum, session) => sum + (positiveNumber(session.manualActivity?.details?.rounds) ?? 0), 0);
    cards.push({
      key: 'downshift',
      title: 'Downshift work',
      subtitle: latestActivitySubtitle(downshift, 'Parasympathetic recovery'),
      icon: 'flower-outline',
      color: '#2DD4BF',
      metrics: [
        { label: 'Sessions', value: String(downshift.length), detail: 'last 90d' },
        { label: 'Duration', value: formatMinutesCompact(totalMinutes), detail: 'breathwork / meditation' },
        ...(rounds > 0 ? [{ label: 'Rounds', value: String(Math.round(rounds)), detail: 'breathwork or contrast' }] : []),
      ],
    });
  }

  const customStrength = recent.filter(session => session.manualActivity?.category === 'strength');
  if (customStrength.length > 0) {
    const totalMinutes = customStrength.reduce((sum, session) => sum + sessionDurationMinutes(session), 0);
    const avgRpe = average(customStrength.map(session => positiveNumber(session.manualActivity?.details?.sessionRpe)));
    cards.push({
      key: 'custom-strength',
      title: 'Custom strength',
      subtitle: latestActivitySubtitle(customStrength, 'Manual lifting logs'),
      icon: 'barbell-outline',
      color: '#6366F1',
      metrics: [
        { label: 'Sessions', value: String(customStrength.length), detail: 'last 90d' },
        { label: 'Duration', value: formatMinutesCompact(totalMinutes), detail: 'manual strength time' },
        ...(avgRpe != null ? [{ label: 'Avg RPE', value: avgRpe.toFixed(1), detail: 'session-level effort' }] : []),
      ],
    });
  }

  return cards.filter(card => card.metrics.length > 1).slice(0, 12);
}

function buildTrendMetricSuggestions(input: {
  history: WorkoutSession[];
  summaries: StoredWorkoutSummary[];
  cardioSummary: CardioTrendSummary;
  bodyScanHistory: BodyScanEntry[];
  weightEntries: WeightEntry[];
  nutritionScoreWeekly: import('../services/api').NutritionScoreWeekly | null;
  showMealProgress: boolean;
}): TrendMetricSuggestion[] {
  const {
    history,
    summaries,
    cardioSummary,
    bodyScanHistory,
    weightEntries,
    nutritionScoreWeekly,
    showMealProgress,
  } = input;
  const recent = recentManualActivitySessions(history);
  const hasSwimDetails = recent.some(session =>
    activityTextIncludesAny(session, ['swim', 'pool'])
    && (positiveNumber(session.manualActivity?.details?.laps) != null || positiveNumber(session.manualActivity?.details?.poolLengthMeters) != null)
  );
  const hasSaunaTemp = recent.some(session =>
    activityTextIncludesAny(session, ['sauna'])
    && positiveNumber(session.manualActivity?.details?.temperatureF) != null
  );
  const hasCyclingPower = recent.some(session =>
    activityTextIncludesAny(session, ['ride', 'cycling', 'cycle', 'bike', 'spin'])
    && positiveNumber(session.manualActivity?.details?.avgWatts) != null
  );
  const hasElevation = recent.some(session =>
    activityTextIncludesAny(session, ['run', 'walk', 'hike', 'ride', 'cycling', 'bike'])
    && positiveNumber(session.manualActivity?.details?.elevationGainFt) != null
  );
  const suggestions: TrendMetricSuggestion[] = [];

  if (!hasSwimDetails) {
    suggestions.push({
      key: 'swim-details',
      title: 'Swim pace per 100m',
      detail: 'Track pool length, laps, stroke, and duration so swim work can show pace and efficiency instead of only time.',
      icon: 'water-outline',
      color: '#06B6D4',
    });
  }
  if (!hasSaunaTemp) {
    suggestions.push({
      key: 'sauna-heat-dose',
      title: 'Sauna heat dose',
      detail: 'Add temperature and humidity to sauna logs to compare heat exposure, duration, and recovery response.',
      icon: 'thermometer-outline',
      color: '#F97316',
    });
  }
  if (!hasCyclingPower) {
    suggestions.push({
      key: 'cycling-power',
      title: 'Cycling output',
      detail: 'Add average watts for rides or spin classes to show power trend alongside distance and duration.',
      icon: 'bicycle-outline',
      color: '#22C55E',
    });
  }
  if (!hasElevation) {
    suggestions.push({
      key: 'elevation-load',
      title: 'Elevation load',
      detail: 'Capture elevation gain for hikes, runs, and rides so route difficulty is visible in trends.',
      icon: 'trail-sign-outline',
      color: '#84CC16',
    });
  }
  if (cardioSummary.easySharePct == null) {
    suggestions.push({
      key: 'hr-zone-split',
      title: 'HR-zone split',
      detail: 'Attach Apple Health or watch HR data to show easy vs hard minutes for any cardio activity.',
      icon: 'pulse-outline',
      color: '#EF4444',
    });
  }
  const hasWorkoutFeedback = summaries.some(summary => summary.feedback);
  if (!hasWorkoutFeedback) {
    suggestions.push({
      key: 'workout-feedback',
      title: 'Workout quality feedback',
      detail: 'Add post-workout feeling, intensity, and soreness so trend cards can connect load with recovery.',
      icon: 'chatbubble-ellipses-outline',
      color: '#14B8A6',
    });
  }
  const hasRir = history.some(session => (session.exercises ?? []).some(ex => (ex.sets ?? []).some(set => typeof set.rir === 'number')));
  if (!hasRir) {
    suggestions.push({
      key: 'rir-feedback',
      title: 'RIR on hard sets',
      detail: 'Log reps-in-reserve on top sets so strength readiness can tell whether load is productive or too grindy.',
      icon: 'speedometer-outline',
      color: '#6366F1',
    });
  }
  if (bodyScanHistory.length < 2 || weightEntries.length < 3) {
    suggestions.push({
      key: 'body-cadence',
      title: 'Body trend cadence',
      detail: 'A few weigh-ins plus recurring body scans or measurements make recomposition clearer than scale weight alone.',
      icon: 'body-outline',
      color: '#A855F7',
    });
  }
  if (showMealProgress && ((nutritionScoreWeekly?.days_with_data ?? 0) < 4)) {
    suggestions.push({
      key: 'nutrition-days',
      title: 'Nutrition target hits',
      detail: 'Log four or more meal days per week so protein, fiber, calories, and energy availability become trendable.',
      icon: 'restaurant-outline',
      color: '#22C55E',
    });
  }

  if (suggestions.length === 0) {
    suggestions.push({
      key: 'repeatability',
      title: 'Comparable routes',
      detail: 'Repeat the same route, pool set, or bike class periodically so trend deltas are fair.',
      icon: 'git-compare-outline',
      color: '#6366F1',
    });
  }
  return suggestions.slice(0, 8);
}

function ActivityTrendHighlightsCard({ cards, availableCount = cards.length, onEdit, tc, styles }: {
  cards: TrendActivityCard[];
  availableCount?: number;
  onEdit?: () => void;
  tc: ReturnType<typeof getTheme>['colors'];
  styles: ReturnType<typeof createStyles>;
}) {
  if (availableCount === 0) return null;
  return (
    <View style={[styles.graphCard, styles.activityTrendCard]}>
      <ProgressCardWash color={tc.primary} secondaryColor="#14B8A6" intensity="soft" />
      <View style={styles.cardioSectionHeader}>
        <View style={[styles.performanceGaugeIcon, { backgroundColor: tc.primary + '1F', marginBottom: 0 }]}>
          <Ionicons name="sparkles-outline" size={15} color={tc.primary} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.graphTitle} numberOfLines={1}>Activity highlights</Text>
          <Text style={[styles.graphSubtitle, { marginBottom: 0 }]} numberOfLines={2}>
            Extra trend surfaces from manual activities, imports, and recovery logs.
          </Text>
        </View>
        {onEdit && (
          <TouchableOpacity
            testID="progress-edit-activity-highlights"
            accessibilityRole="button"
            accessibilityLabel="Edit Activity Highlights"
            activeOpacity={0.78}
            onPress={onEdit}
            style={[styles.trendCardsEditButton, { borderColor: tc.border, backgroundColor: tc.surfaceRaised }]}>
            <Ionicons name="options-outline" size={14} color={tc.textSecondary} />
            <Text style={[styles.trendCardsEditText, { color: tc.textSecondary }]}>Edit</Text>
          </TouchableOpacity>
        )}
      </View>
      {cards.length === 0 ? (
        <View style={[styles.trendCardsEmptyState, { borderColor: tc.border, backgroundColor: tc.surfaceRaised }]}>
          <Ionicons name="eye-off-outline" size={26} color={tc.textMuted} />
          <Text style={[styles.trendCardsEmptyTitle, { color: tc.textPrimary }]}>All highlights hidden</Text>
          <Text style={[styles.trendCardsEmptyBody, { color: tc.textSecondary }]}>Edit Activity Highlights to choose which cards show here.</Text>
        </View>
      ) : (
        <View style={styles.activityTrendGrid}>
          {cards.map((card, index) => (
            <FadeInView
              key={card.key}
              delay={staggerDelay(index, 35)}
              duration={TIMING_STANDARD.duration}
              slideDistance={5}
              style={[styles.activityTrendTile, { borderColor: card.color + '36' }]}
            >
              <ProgressCardWash color={card.color} intensity="soft" cornerRadius={radius.md} />
              <View style={styles.activityTrendTileHeader}>
                <View style={[styles.activityTrendIcon, { backgroundColor: card.color + '1F' }]}>
                  <Ionicons name={card.icon} size={15} color={card.color} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.activityTrendTitle} numberOfLines={1}>{card.title}</Text>
                  <Text style={styles.activityTrendSubtitle} numberOfLines={1}>{card.subtitle}</Text>
                </View>
              </View>
              <View style={styles.activityTrendMetricGrid}>
                {card.metrics.slice(0, 4).map(metric => (
                  <View key={`${card.key}-${metric.label}`} style={[styles.activityTrendMetric, { borderColor: card.color + '22' }]}>
                    <Text style={[styles.activityTrendMetricValue, { color: card.color }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
                      {metric.value}
                    </Text>
                    <Text style={styles.activityTrendMetricLabel} numberOfLines={1}>{metric.label}</Text>
                    <Text style={styles.activityTrendMetricDetail} numberOfLines={2}>{metric.detail}</Text>
                  </View>
                ))}
              </View>
            </FadeInView>
          ))}
        </View>
      )}
    </View>
  );
}

function HighValueTrendCardsCard({ cards, availableCount = cards.length, onEdit, tc, styles }: {
  cards: TrendActivityCard[];
  availableCount?: number;
  onEdit?: () => void;
  tc: ReturnType<typeof getTheme>['colors'];
  styles: ReturnType<typeof createStyles>;
}) {
  if (availableCount === 0) return null;
  return (
    <View style={[styles.graphCard, styles.activityTrendCard]}>
      <ProgressCardWash color="#14B8A6" secondaryColor={tc.primary} intensity="soft" />
      <View style={styles.cardioSectionHeader}>
        <View style={[styles.performanceGaugeIcon, { backgroundColor: '#14B8A61F', marginBottom: 0 }]}>
          <Ionicons name="analytics-outline" size={15} color="#14B8A6" />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.graphTitle} numberOfLines={1}>High-value trends</Text>
          <Text style={[styles.graphSubtitle, { marginBottom: 0 }]} numberOfLines={2}>
            Recovery, readiness, nutrition, body, and consistency signals that combine multiple logs.
          </Text>
        </View>
        {onEdit && (
          <TouchableOpacity
            testID="progress-edit-high-value-trends"
            accessibilityRole="button"
            accessibilityLabel="Edit High-Value Trends"
            activeOpacity={0.78}
            onPress={onEdit}
            style={[styles.trendCardsEditButton, { borderColor: tc.border, backgroundColor: tc.surfaceRaised }]}>
            <Ionicons name="options-outline" size={14} color={tc.textSecondary} />
            <Text style={[styles.trendCardsEditText, { color: tc.textSecondary }]}>Edit</Text>
          </TouchableOpacity>
        )}
      </View>
      {cards.length === 0 ? (
        <View style={[styles.trendCardsEmptyState, { borderColor: tc.border, backgroundColor: tc.surfaceRaised }]}>
          <Ionicons name="eye-off-outline" size={26} color={tc.textMuted} />
          <Text style={[styles.trendCardsEmptyTitle, { color: tc.textPrimary }]}>All high-value cards hidden</Text>
          <Text style={[styles.trendCardsEmptyBody, { color: tc.textSecondary }]}>Edit High-Value Trends to choose which cards show here.</Text>
        </View>
      ) : (
        <View style={styles.activityTrendGrid}>
          {cards.map((card, index) => (
            <FadeInView
              key={card.key}
              delay={staggerDelay(index, 35)}
              duration={TIMING_STANDARD.duration}
              slideDistance={5}
              style={[styles.activityTrendTile, { borderColor: card.color + '36' }]}
            >
              <ProgressCardWash color={card.color} intensity="soft" cornerRadius={radius.md} />
              <View style={styles.activityTrendTileHeader}>
                <View style={[styles.activityTrendIcon, { backgroundColor: card.color + '1F' }]}>
                  <Ionicons name={card.icon} size={15} color={card.color} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.activityTrendTitle} numberOfLines={1}>{card.title}</Text>
                  <Text style={styles.activityTrendSubtitle} numberOfLines={1}>{card.subtitle}</Text>
                </View>
              </View>
              <View style={styles.activityTrendMetricGrid}>
                {card.metrics.slice(0, 4).map(metric => (
                  <View key={`${card.key}-${metric.label}`} style={[styles.activityTrendMetric, { borderColor: card.color + '22' }]}>
                    <Text style={[styles.activityTrendMetricValue, { color: card.color }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
                      {metric.value}
                    </Text>
                    <Text style={styles.activityTrendMetricLabel} numberOfLines={1}>{metric.label}</Text>
                    <Text style={styles.activityTrendMetricDetail} numberOfLines={2}>{metric.detail}</Text>
                  </View>
                ))}
              </View>
            </FadeInView>
          ))}
        </View>
      )}
    </View>
  );
}

function TrendMetricSuggestionsCard({ suggestions, tc, styles }: {
  suggestions: TrendMetricSuggestion[];
  tc: ReturnType<typeof getTheme>['colors'];
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={[styles.graphCard, styles.trendSuggestionCard]}>
      <ProgressCardWash color="#6366F1" secondaryColor={tc.primary} intensity="soft" />
      <View style={styles.cardioSectionHeader}>
        <View style={[styles.performanceGaugeIcon, { backgroundColor: '#6366F11F', marginBottom: 0 }]}>
          <Ionicons name="bulb-outline" size={15} color="#6366F1" />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.graphTitle} numberOfLines={1}>Suggested signals</Text>
          <Text style={[styles.graphSubtitle, { marginBottom: 0 }]} numberOfLines={2}>
            New data worth showing as activity logging gets more specific.
          </Text>
        </View>
      </View>
      <View style={styles.trendSuggestionList}>
        {suggestions.map(item => (
          <View key={item.key} style={[styles.trendSuggestionRow, { borderColor: item.color + '32' }]}>
            <ProgressCardWash color={item.color} intensity="soft" cornerRadius={radius.md} />
            <View style={[styles.trendSuggestionIcon, { backgroundColor: item.color + '1F' }]}>
              <Ionicons name={item.icon} size={15} color={item.color} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.trendSuggestionTitle} numberOfLines={1}>{item.title}</Text>
              <Text style={styles.trendSuggestionDetail} numberOfLines={2}>{item.detail}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
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

function plateauSuggestionTitle(suggestion: PlateauEntry['suggestion']): string {
  if (suggestion === 'swap') return 'Swap';
  if (suggestion === 'add_volume') return 'Add volume';
  return 'Deload';
}

function plateauSuggestionDetail(entry: PlateauEntry): string {
  if (entry.suggestion === 'swap') {
    return 'Try a close variation next block.';
  }
  if (entry.suggestion === 'add_volume') {
    return 'Recent set volume dipped. Add 2-3 targeted hard sets if recovery is good.';
  }
  return 'Cut volume 30-40% for one week, then rebuild.';
}

type ProgressAnalyticsItem = {
  key: string;
  label: string;
  value: string;
  detail: string;
  icon: any;
  color: string;
};

type VolumeDetailMode = 'balance' | 'workload';

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
  targetTab: ProgressTab;
};

type ProgressGoalBucket = 'fat_loss' | 'muscle_gain' | 'body_recomp' | 'strength' | 'endurance' | 'athletic' | 'general';
type TodaySignalStatus = 'good' | 'watch' | 'off' | 'needs_data';

type TodayTrackSignal = {
  key: string;
  label: string;
  value: string;
  detail: string;
  action: string;
  icon: any;
  color: string;
  targetTab: ProgressTab;
  status: TodaySignalStatus;
  score: number;
  pct?: number;
};

type TodayTrackSummary = {
  bucket: ProgressGoalBucket;
  goalLabel: string;
  title: string;
  subtitle: string;
  action: string;
  color: string;
  icon: any;
  progressPct: number;
  confidence: string;
  signals: TodayTrackSignal[];
};

type GoalOverviewStat = {
  key: string;
  label: string;
  value: string;
  detail: string;
  color?: string;
};

type GoalGraphPoint = {
  key: string;
  label: string;
  executionPct: number | null;
  secondaryPct: number | null;
  secondaryValue: string;
};

type GoalExecutionOverview = {
  blockStartDate: string;
  blockEndDate: string;
  dayLabel: string;
  timeLeftLabel: string;
  graphTitle: string;
  graphSubtitle: string;
  secondaryLabel: string;
  secondaryColor: string;
  points: GoalGraphPoint[];
  stats: GoalOverviewStat[];
};

type ProgressPlanWeekWindow = { startDate: string; endDate: string };

type ProgressDateWindow = {
  startDate: string;
  endDate: string;
  previousStartDate: string;
  previousEndDate: string;
  label: string;
  previousLabel: string;
  days: number;
  source: 'plan_week' | 'calendar_week';
};

const PR_MOMENTUM_WINDOW_DAYS = 30;
const MUSCLE_DISTRIBUTION_WINDOW_DAYS = 30;
const MIN_NUTRITION_DAYS_FOR_HEALTH_SCORE = 4;

const GOAL_LABELS: Record<ProgressGoalBucket, string> = {
  fat_loss: 'Fat loss',
  muscle_gain: 'Muscle gain',
  body_recomp: 'Body recomp',
  strength: 'Strength',
  endurance: 'Cardio',
  athletic: 'Athletic',
  general: 'General fitness',
};

const FAT_LOSS_GOALS = new Set(['lose_fat', 'get_lean', 'cut', 'preserve_muscle_cutting', 'tone', 'get_toned']);
const MUSCLE_GOALS = new Set(['build_muscle', 'lean_bulk', 'gain_weight', 'improve_aesthetics', 'build_glutes', 'build_upper_body', 'build_lower_body', 'build_arms', 'build_shoulders']);
const STRENGTH_GOALS = new Set(['build_strength', 'increase_overall', 'improve_1rm', 'powerlifting', 'improve_squat', 'improve_bench', 'improve_deadlift', 'improve_ohp', 'improve_pullups', 'improve_grip', 'functional_strength', 'explosive_strength', 'relative_strength']);
const ENDURANCE_GOALS = new Set(['improve_cardio', 'improve_conditioning', 'aerobic_base', 'improve_vo2', 'increase_stamina', 'running_fitness', 'train_5k', 'train_10k', 'train_half', 'train_marathon', 'sprint_speed', 'interval_perf', 'hiking_endurance', 'cycling_endurance', 'rowing_endurance', 'swimming_endurance', 'work_capacity']);
const ATHLETIC_GOALS = new Set(['improve_athleticism', 'improve_speed', 'improve_agility', 'improve_power', 'improve_vertical', 'improve_acceleration', 'improve_cod', 'improve_coordination', 'improve_balance', 'sport_performance', 'offseason_training', 'inseason_maintenance', 'return_to_sport', 'hyrox']);

function isActiveWorkoutSummary(summary: StoredWorkoutSummary): boolean {
  const hasSets = (summary.totalSets ?? 0) > 0
    || (summary.exercises ?? []).some(ex => (ex.sets?.length ?? 0) > 0);
  return hasSets || (summary.durationSeconds ?? 0) > 30;
}

function parseDateKeyMs(raw: string | null | undefined): number {
  const key = String(raw ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return 0;
  const ms = new Date(`${key}T12:00:00`).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function formatShortDateKey(key: string): string {
  const ms = parseDateKeyMs(key);
  if (!ms) return key;
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function exerciseNameSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function shiftDateKey(key: string, days: number): string {
  const ms = parseDateKeyMs(key);
  const d = ms ? new Date(ms) : new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildProgressDateWindow(planWeekWindow?: ProgressPlanWeekWindow | null): ProgressDateWindow {
  const start = String(planWeekWindow?.startDate ?? '').slice(0, 10);
  const end = String(planWeekWindow?.endDate ?? '').slice(0, 10);
  const startMs = parseDateKeyMs(start);
  const endMs = parseDateKeyMs(end);
  if (startMs && endMs && endMs >= startMs) {
    const days = Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);
    const previousStartDate = shiftDateKey(start, -days);
    const previousEndDate = shiftDateKey(end, -days);
    return {
      startDate: start,
      endDate: end,
      previousStartDate,
      previousEndDate,
      label: `${formatShortDateKey(start)}-${formatShortDateKey(end)}`,
      previousLabel: `${formatShortDateKey(previousStartDate)}-${formatShortDateKey(previousEndDate)}`,
      days,
      source: 'plan_week',
    };
  }

  const today = new Date();
  const dow = today.getDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(today);
  monday.setDate(today.getDate() + mondayOffset);
  const startDate = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
  const endDate = shiftDateKey(startDate, 6);
  const previousStartDate = shiftDateKey(startDate, -7);
  const previousEndDate = shiftDateKey(endDate, -7);
  return {
    startDate,
    endDate,
    previousStartDate,
    previousEndDate,
    label: `${formatShortDateKey(startDate)}-${formatShortDateKey(endDate)}`,
    previousLabel: `${formatShortDateKey(previousStartDate)}-${formatShortDateKey(previousEndDate)}`,
    days: 7,
    source: 'calendar_week',
  };
}

function dateInWindow(raw: string | null | undefined, startKey: string, endKey: string): boolean {
  const ms = parseDateKeyMs(raw);
  return ms >= parseDateKeyMs(startKey) && ms <= parseDateKeyMs(endKey);
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

type StrengthChangeRow = StrengthTrendRow;

type VolumeTrendRow = StrengthVolumeWindowSummary;
type VolumeTrendBreakdown = {
  loadBalance: StrengthLoadBalanceSummary;
  tonnage: StrengthVolumeTrendBreakdown;
};

function buildVolumeTrendBreakdown(history: WorkoutSession[], weekStartDate?: string | null): VolumeTrendBreakdown {
  return {
    loadBalance: buildStrengthLoadBalance(history),
    tonnage: buildStrengthVolumeTrend(history, { weekStartDate: weekStartDate ?? undefined }),
  };
}

export type RecordBreakdownRow = {
  pr: PR;
  priorBest: { weightLbs: number; reps: number; date: string } | null;
};

/** For each PR within the window, the best loaded set logged before
 *  the PR's date (the thing the PR beat). Returns chronologically
 *  newest-first so the detail sheet shows freshest records on top. */
function buildRecordsBreakdown(history: WorkoutSession[], prs: PR[], sinceMs: number): RecordBreakdownRow[] {
  const recent = establishedRecentPrs(history, prs, sinceMs);
  const completed = history.filter(s => s.completed && !s.skipped);
  return recent
    .map(pr => {
      const key = pr.exerciseName.trim().toLowerCase();
      const prMs = +new Date(pr.date);
      let priorBest: { weightLbs: number; reps: number; date: string } | null = null;
      for (const session of completed) {
        const sMs = +new Date(session.date);
        if (!Number.isFinite(sMs) || sMs >= prMs) continue;
        for (const ex of session.exercises ?? []) {
          if (ex.name?.trim().toLowerCase() !== key) continue;
          for (const set of ex.sets ?? []) {
            const w = Number((set as any).weightLbs ?? (set as any).weight_lbs ?? 0);
            const r = Number((set as any).reps ?? 0);
            if (!(w > 0) || !(r > 0)) continue;
            if (!priorBest
              || w > priorBest.weightLbs
              || (w === priorBest.weightLbs && r > priorBest.reps)) {
              priorBest = { weightLbs: w, reps: r, date: session.date };
            }
          }
        }
      }
      return { pr, priorBest };
    })
    .sort((a, b) => +new Date(b.pr.date) - +new Date(a.pr.date));
}

function buildWorkoutHistoryIndex(history: WorkoutSession[]) {
  const muscleMap: Record<string, string> = {};
  const compoundMap: Record<string, boolean> = {};
  for (const s of history) {
    for (const e of (s.exercises ?? [])) {
      const nm = e.name?.toLowerCase();
      if (!nm) continue;
      const pm = e.primaryMuscle ?? (e as any).primary_muscle;
      if (pm && !muscleMap[nm]) muscleMap[nm] = String(pm).toLowerCase();
      const compound = e.isCompound ?? (e as any).is_compound;
      if (compound != null && !(nm in compoundMap)) compoundMap[nm] = Boolean(compound);
    }
  }
  return {
    muscleMap,
    compoundMap,
    trendMap: buildExerciseTrendMap(history),
  };
}

function OneRepMaxTrendCard({
  title,
  subtitle,
  points,
  weightUnit,
  tc,
  styles,
}: {
  title: string;
  subtitle: string;
  points: import('../services/api').E1RMHistoryPoint[];
  weightUnit: WeightUnit;
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
  const valueLabelIndexes = graphValueLabelIndexes(chartPoints.map(p => p.v));
  const polyPoints = chartPoints.map(p => `${p.x},${p.y}`).join(' ');
  const e1rmBaselineY = padT + plotH;
  const e1rmAreaPoints = chartPoints.length >= 2
    ? `${polyPoints} ${chartPoints[chartPoints.length - 1].x},${e1rmBaselineY} ${chartPoints[0].x},${e1rmBaselineY}`
    : null;
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
        <Text style={styles.graphTitle} numberOfLines={2}>{title}</Text>
        <Text style={{ fontSize: 12, fontWeight: '800', color: deltaColor }}>
          {formatSignedWeightDelta(delta, weightUnit)}
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
                {weightChartValue(gv, weightUnit)}
              </SvgText>
            );
          })}
          {e1rmAreaPoints && (
            <>
              <Defs>
                <SvgLinearGradient id="e1rmAreaGradient" x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0%" stopColor={tc.primary} stopOpacity={0.22} />
                  <Stop offset="100%" stopColor={tc.primary} stopOpacity={0.02} />
                </SvgLinearGradient>
              </Defs>
              <Polygon points={e1rmAreaPoints} fill="url(#e1rmAreaGradient)" stroke="none" />
            </>
          )}
          <Polyline points={polyPoints}
            fill="none" stroke={tc.primary} strokeWidth={2.5}
            strokeLinejoin="round" strokeLinecap="round" />
          {chartPoints.map((p) => (
            <Circle key={p.i} cx={p.x} cy={p.y}
              r={p.i === chartPoints.length - 1 ? 5 : 3.5}
              fill={p.i === chartPoints.length - 1 ? tc.accent : tc.primary}
              stroke={tc.surface} strokeWidth={1.5} />
          ))}
          {chartPoints.map((p) => {
            if (!valueLabelIndexes.has(p.i)) return null;
            const label = String(weightChartValue(p.v, weightUnit));
            const labelW = graphValueLabelWidth(label);
            const labelX = graphValueLabelX(p.x, labelW, chartW, padL, padR);
            const labelY = graphValueLabelY(p.y);
            return (
              <Fragment key={`v${p.i}`}>
                <Rect
                  x={labelX - labelW / 2}
                  y={labelY - 11}
                  width={labelW}
                  height={15}
                  rx={7.5}
                  fill={tc.surfaceRaised}
                  stroke={tc.border}
                  strokeWidth={0.75}
                  opacity={0.96}
                />
                <SvgText
                  x={labelX}
                  y={labelY}
                  fontSize={9}
                  fontWeight="800"
                  fill={p.i === chartPoints.length - 1 ? tc.accent : tc.textPrimary}
                  textAnchor="middle"
                >
                  {label}
                </SvgText>
              </Fragment>
            );
          })}
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
          <Text style={styles.chartStatValue}>{formatWeight(last, weightUnit)}</Text>
          <Text style={styles.chartStatLabel}>Current e1RM</Text>
        </View>
        <View style={styles.chartStat}>
          <Text style={styles.chartStatValue}>{formatWeight(Math.max(...values), weightUnit)}</Text>
          <Text style={styles.chartStatLabel}>Peak e1RM</Text>
        </View>
        <View style={styles.chartStat}>
          <Text style={[styles.chartStatValue, { color: deltaColor }]}>
            {formatSignedWeightDelta(delta, weightUnit)}
          </Text>
          <Text style={styles.chartStatLabel}>vs first estimate</Text>
        </View>
      </View>
    </View>
  );
}

function WeightBodyFatTrendChart({
  weightEntries,
  bodyScanHistory,
  weightUnit,
  tc,
  targetWeightLbs = null,
}: {
  weightEntries: WeightEntry[];
  bodyScanHistory: BodyScanEntry[];
  weightUnit: WeightUnit;
  tc: ReturnType<typeof getTheme>['colors'];
  targetWeightLbs?: number | null;
}) {
  const weights = weightEntries
    .map(entry => ({ date: entry.date.slice(0, 10), value: Number(entry.weightLbs) }))
    .filter(point => point.date && Number.isFinite(point.value) && point.value > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const bodyFat = bodyScanHistory
    .map(entry => ({ date: String(entry.date ?? '').slice(0, 10), value: Number(entry.bodyFatPct) }))
    .filter(point => point.date && Number.isFinite(point.value) && point.value > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!weights.length) return null;
  if (weights.length < 2 && bodyFat.length < 2) return null;

  const dates = Array.from(new Set([...weights.map(p => p.date), ...bodyFat.map(p => p.date)])).sort();
  const dateIndex = new Map(dates.map((d, i) => [d, i]));
  const chartW = 320;
  const chartH = 154;
  const padL = 40;
  const padR = 32;
  const padT = 18;
  const padB = 28;
  const plotW = chartW - padL - padR;
  const plotH = chartH - padT - padB;
  const rangeFor = (values: number[], minSpan: number) => {
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const span = Math.max(minSpan, rawMax - rawMin);
    return {
      min: rawMin - span * 0.25,
      max: rawMax + span * 0.25,
    };
  };
  const weightValues = weights.map(p => p.value);
  const weightRawMin = Math.min(...weightValues);
  const weightRawMax = Math.max(...weightValues);
  // Draw the goal line only when the target sits near the plotted data —
  // a far-away target would flatten the line into noise.
  const goalInView = targetWeightLbs != null
    && Number.isFinite(targetWeightLbs)
    && Math.abs(targetWeightLbs - (weightRawMin + weightRawMax) / 2) <= Math.max(10, (weightRawMax - weightRawMin) * 2);
  const weightRange = rangeFor(goalInView ? [...weightValues, targetWeightLbs as number] : weightValues, 4);
  const bodyFatRange = bodyFat.length >= 2 ? rangeFor(bodyFat.map(p => p.value), 2) : null;
  const toX = (date: string) => {
    const idx = dateIndex.get(date) ?? 0;
    return padL + (dates.length > 1 ? (idx / (dates.length - 1)) * plotW : plotW / 2);
  };
  const toY = (value: number, range: { min: number; max: number }) =>
    padT + plotH - ((value - range.min) / Math.max(1, range.max - range.min)) * plotH;
  const weightPoints = weights.map(point => ({ ...point, x: toX(point.date), y: toY(point.value, weightRange) }));
  const bodyFatPoints = bodyFatRange
    ? bodyFat.map(point => ({ ...point, x: toX(point.date), y: toY(point.value, bodyFatRange) }))
    : [];
  const weightLine = weightPoints.map(p => `${p.x},${p.y}`).join(' ');
  const bodyFatLine = bodyFatPoints.map(p => `${p.x},${p.y}`).join(' ');
  const bodyFatArea = bodyFatPoints.length >= 2
    ? [
        `${bodyFatPoints[0].x},${chartH - padB}`,
        ...bodyFatPoints.map(p => `${p.x},${p.y}`),
        `${bodyFatPoints[bodyFatPoints.length - 1].x},${chartH - padB}`,
      ].join(' ')
    : '';
  const weightArea = weightPoints.length >= 2
    ? [
        `${weightPoints[0].x},${chartH - padB}`,
        ...weightPoints.map(p => `${p.x},${p.y}`),
        `${weightPoints[weightPoints.length - 1].x},${chartH - padB}`,
      ].join(' ')
    : '';
  const bodyFatDelta = bodyFat.length >= 2 ? bodyFat[bodyFat.length - 1].value - bodyFat[0].value : 0;
  const bodyFatColor = tc.warning ?? '#F59E0B';
  const dateLabels = dates.length <= 10 ? dates : [dates[0], dates[dates.length - 1]];
  const goalY = goalInView ? toY(targetWeightLbs as number, weightRange) : null;
  const lastWeightPoint = weightPoints.length >= 2 ? weightPoints[weightPoints.length - 1] : null;

  return (
    <View style={{ marginBottom: 10 }}>
      {bodyFatPoints.length >= 2 && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <View style={{ width: 18, height: 3, borderRadius: 2, backgroundColor: tc.primary }} />
            <Text style={{ fontSize: 11, fontWeight: '600', color: tc.textSecondary }}>Weight</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <View style={{ width: 18, height: 3, borderRadius: 2, backgroundColor: bodyFatColor }} />
            <Text style={{ fontSize: 11, fontWeight: '600', color: tc.textSecondary }}>
              Body fat {bodyFatDelta > 0 ? '+' : ''}{Math.round(bodyFatDelta * 10) / 10}%
            </Text>
          </View>
        </View>
      )}
      <View style={{ alignItems: 'center', marginTop: 6 }}>
        <Svg width={chartW} height={chartH}>
          <Defs>
            <SvgLinearGradient id="weightAreaGradient" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0%" stopColor={tc.primary} stopOpacity="0.18" />
              <Stop offset="62%" stopColor={tc.primary} stopOpacity="0.07" />
              <Stop offset="100%" stopColor={tc.primary} stopOpacity="0.01" />
            </SvgLinearGradient>
            <SvgLinearGradient id="weightBodyFatAreaGradient" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0%" stopColor={bodyFatColor} stopOpacity="0.16" />
              <Stop offset="62%" stopColor={bodyFatColor} stopOpacity="0.07" />
              <Stop offset="100%" stopColor={bodyFatColor} stopOpacity="0.01" />
            </SvgLinearGradient>
          </Defs>
          {[0, 1, 2].map(i => {
            const y = padT + (plotH * i) / 2;
            return <Line key={i} x1={padL} y1={y} x2={chartW - padR} y2={y} stroke={tc.border} strokeWidth={1} strokeDasharray="4,4" />;
          })}
          <SvgText x={padL - 6} y={padT + 4} fontSize={10} fill={tc.textMuted} textAnchor="end">
            {weightChartValue(weightRange.max, weightUnit)}
          </SvgText>
          <SvgText x={padL - 6} y={padT + plotH + 4} fontSize={10} fill={tc.textMuted} textAnchor="end">
            {weightChartValue(weightRange.min, weightUnit)}
          </SvgText>
          {bodyFatRange && (
            <>
              <SvgText x={chartW - padR + 6} y={padT + 4} fontSize={10} fill={bodyFatColor} textAnchor="start">
                {Math.round(bodyFatRange.max)}%
              </SvgText>
              <SvgText x={chartW - padR + 6} y={padT + plotH + 4} fontSize={10} fill={bodyFatColor} textAnchor="start">
                {Math.round(bodyFatRange.min)}%
              </SvgText>
            </>
          )}
          {bodyFatArea && <Polygon points={bodyFatArea} fill="url(#weightBodyFatAreaGradient)" />}
          {weightArea && <Polygon points={weightArea} fill="url(#weightAreaGradient)" />}
          {goalY != null && (
            <>
              <Line x1={padL} y1={goalY} x2={chartW - padR} y2={goalY} stroke={tc.textMuted} strokeWidth={1} strokeDasharray="5,5" opacity={0.85} />
              <SvgText x={chartW - padR} y={goalY - 4} fontSize={9} fill={tc.textMuted} textAnchor="end">
                goal {weightChartValue(targetWeightLbs as number, weightUnit)}
              </SvgText>
            </>
          )}
          {weightPoints.length >= 2 && <Polyline points={weightLine} fill="none" stroke={tc.primary} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />}
          {bodyFatPoints.length >= 2 && <Polyline points={bodyFatLine} fill="none" stroke={bodyFatColor} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />}
          {lastWeightPoint && (
            <Circle cx={lastWeightPoint.x} cy={lastWeightPoint.y} r={9} fill={tc.primary} opacity={0.16} />
          )}
          {weightPoints.map((p, i) => (
            <Circle key={`w${p.date}`} cx={p.x} cy={p.y} r={i === weightPoints.length - 1 ? 4.5 : 3} fill={tc.primary} stroke={tc.surface} strokeWidth={1.25} />
          ))}
          {bodyFatPoints.map((p, i) => (
            <Circle key={`bf${p.date}`} cx={p.x} cy={p.y} r={i === bodyFatPoints.length - 1 ? 4.5 : 3} fill={bodyFatColor} stroke={tc.surface} strokeWidth={1.25} />
          ))}
          {dateLabels.map(d => {
            const parsed = new Date(`${d}T12:00:00`);
            return (
              <SvgText key={d} x={toX(d)} y={chartH - 5} fontSize={9} fill={tc.textMuted} textAnchor="middle">
                {parsed.getMonth() + 1}/{parsed.getDate()}
              </SvgText>
            );
          })}
        </Svg>
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
  weightUnit: WeightUnit,
  distanceUnit: DistanceUnit,
  visibility: ProgressSurfaceVisibility = { showWorkoutProgress: true, showMealProgress: true },
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
  if (visibility.showWorkoutProgress && activeDays30 > 0) {
    cards.push({
      key: 'active-days',
      title: '30-day consistency',
      value: `${activeDays30}`,
      detail: `active training day${activeDays30 === 1 ? '' : 's'} logged`,
      icon: 'calendar-outline',
      color: '#22C55E',
    });
  }
  if (visibility.showWorkoutProgress && recentPrs.length > 0) {
    cards.push({
      key: 'recent-prs',
      title: 'PR momentum',
      value: `${recentPrs.length}`,
      detail: 'records after your baseline in the last 30 days',
      icon: 'trophy-outline',
      color: '#F59E0B',
    });
  }
  if (visibility.showWorkoutProgress && topLift) {
    cards.push({
      key: 'top-lift',
      title: 'Heaviest 1RM',
	      value: formatWeight(topLift.oneRepMaxLbs, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 }),
      detail: `${topLift.name} estimated 1RM`,
      icon: 'barbell-outline',
      color: '#6366F1',
    });
  }
  if (visibility.showMealProgress && mealAverages && mealAverages.days_with_data > 0) {
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
  if (visibility.showWorkoutProgress && cardioMiles > 0) {
    cards.push({
      key: 'cardio-base',
      title: 'Cardio volume',
      value: formatDistance(cardioMiles, distanceUnit),
      detail: `${paceHistory.length} distance-based cardio log${paceHistory.length === 1 ? '' : 's'}`,
      icon: 'pulse-outline',
      color: '#EF4444',
    });
  }
  if (visibility.showWorkoutProgress && cards.length < 4 && completed.length > 0) {
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

function strengthIndexDelta(history: WorkoutSession[]): { value: string; detail: string; color: string } | null {
  const summary = buildStrengthTrendSummary(history, {
    estimateSet: estimate1RM,
    categorizeExercise,
  });
  if (!summary || summary.rows.length === 0) return null;
  const reviewWeeks = Math.round(summary.reviewDays / 7);
  const matchedCount = summary.matchedRows.length;
  const baselineCount = summary.baselineRows.length;

  if (summary.trendPct != null) {
    const trendPct = summary.trendPct;
    const baselineText = baselineCount > 0 ? `, ${baselineCount} new baseline${baselineCount === 1 ? '' : 's'}` : '';
    return {
      value: `${trendPct >= 0 ? '+' : ''}${trendPct}%`,
      detail: `${reviewWeeks}-week repeat-lift trend (${matchedCount} matched lift${matchedCount === 1 ? '' : 's'}${baselineText})`,
      color: trendPct >= 0 ? '#22C55E' : '#EF4444',
    };
  }

  if (matchedCount > 0) {
    const row = summary.matchedRows[0];
    const pct = row.deltaPct ?? 0;
    return {
      value: 'Tracking',
      detail: `${row.name} ${pct >= 0 ? '+' : ''}${pct}% vs its prior session; ${summary.minMatchedLiftsForScore}+ matched lifts needed for overall trend`,
      color: pct > 0 ? '#22C55E' : pct < 0 ? '#EF4444' : '#6366F1',
    };
  }

  return {
    value: 'New',
    detail: `${baselineCount} strength baseline${baselineCount === 1 ? '' : 's'} logged in the last ${reviewWeeks} weeks`,
    color: '#6366F1',
  };
}

function buildProgressAnalytics(
  history: WorkoutSession[],
  prs: PR[],
  plateaus: PlateauEntry[],
  weightUnit: WeightUnit,
  distanceUnit: DistanceUnit,
  cardioSummary: CardioTrendSummary,
  window?: ProgressDateWindow,
): ProgressAnalyticsItem[] {
  const completed = history.filter(s => s.completed && !s.skipped);

  const rows: ProgressAnalyticsItem[] = [];
  const strength = strengthIndexDelta(history);
  if (strength) {
    rows.push({
      key: 'strength-index',
      label: 'Strength',
      value: strength.value,
      detail: strength.detail,
      icon: 'barbell-outline',
      color: strength.color,
    });
  }

  const loadBalance = buildStrengthLoadBalance(history);
  const hasStrengthSets = loadBalance.weeks.some(week => week.loadedSets > 0);
  if (hasStrengthSets) {
    // "Set targets" / load-balance gauge removed — it duplicates the Strength
    // Profile radar, which already shows muscle balance.
    const volumeTrend = buildStrengthVolumeTrend(history, {
      weekStartDate: window?.startDate,
      windowDays: window?.days,
    });
    rows.push({
      key: 'volume-trend',
      label: 'Workload',
      value: formatLoadVolume(volumeTrend.current.volumeLbs, weightUnit),
      detail: strengthVolumeTrendDetail(volumeTrend, weightUnit),
      icon: 'analytics-outline',
      color: '#6366F1',
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

  const cardioVolume = cardioVolumeValue(cardioSummary, distanceUnit);
  if (cardioSummary.hasData && cardioVolume) {
    rows.push({
      key: 'cardio-volume',
      label: 'Cardio volume',
      value: cardioVolume,
      detail: cardioVolumeDetail(cardioSummary, distanceUnit),
      icon: 'pulse-outline',
      color: '#06B6D4',
    });
  }

  // "Plateau watch" gauge removed — plateaus + deload suggestions live on the
  // Insights tab; the count here was redundant.

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
  weightUnit: WeightUnit,
  distanceUnit: DistanceUnit,
  window: ProgressDateWindow,
  visibility: ProgressSurfaceVisibility = { showWorkoutProgress: true, showMealProgress: true },
): ProgressOverviewItem[] {
  const currentWindowText = window.source === 'plan_week' ? 'this plan week' : 'this calendar week';
  const previousWindowText = window.source === 'plan_week' ? 'previous week' : 'previous calendar week';
  const trendText = (current: number, previous: number, noun: string): string => {
    if (previous <= 0) return `${noun} ${currentWindowText}`;
    const delta = current - previous;
    if (delta === 0) return `unchanged vs ${previousWindowText}`;
    return `${delta > 0 ? '+' : ''}${delta} vs ${previousWindowText}`;
  };
  const inCurrent = (raw: string | null | undefined) => dateInWindow(raw, window.startDate, window.endDate);
  const inPrevious = (raw: string | null | undefined) => dateInWindow(raw, window.previousStartDate, window.previousEndDate);

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

  const recentWorkoutDays = new Set(workoutRows.filter(row => inCurrent(row.date)).map(row => row.date.slice(0, 10))).size;
  const previousWorkoutDays = new Set(workoutRows.filter(row => inPrevious(row.date)).map(row => row.date.slice(0, 10))).size;
  const recentLoadBalance = buildStrengthLoadBalance(history, {
    today: window.endDate,
    windowDays: window.days,
  });
  const recentZone2 = summaries
    .filter(row => inCurrent(row.date) && isCardioHrZoneSource(row))
    .reduce((sum, row) => sum + Math.round(Number(row.hrZoneMinutes?.[1] ?? 0)), 0);
  const previousZone2 = summaries
    .filter(row => inPrevious(row.date) && isCardioHrZoneSource(row))
    .reduce((sum, row) => sum + Math.round(Number(row.hrZoneMinutes?.[1] ?? 0)), 0);

  const items: ProgressOverviewItem[] = [];
  if (visibility.showWorkoutProgress && recentWorkoutDays > 0) {
    items.push({
      key: 'week-workouts',
      label: 'Training days',
      value: `${recentWorkoutDays}/${window.days}`,
      detail: trendText(recentWorkoutDays, previousWorkoutDays, 'active days'),
      icon: 'calendar-outline',
      color: '#22C55E',
      targetTab: 'trends',
    });
  }
  if (visibility.showWorkoutProgress && recentLoadBalance.current.loadedSets > 0) {
    items.push({
      key: 'week-volume',
      label: 'Set targets',
      value: strengthLoadBalanceValue(recentLoadBalance, weightUnit),
      detail: recentLoadBalance.detail || `${recentLoadBalance.current.loadedSets} hard set${recentLoadBalance.current.loadedSets === 1 ? '' : 's'} ${currentWindowText}`,
      icon: 'body-outline',
      color: strengthLoadBalanceColor(recentLoadBalance.status, recentLoadBalance.score),
      targetTab: 'trends',
    });
  }

  if (visibility.showWorkoutProgress && (recentZone2 > 0 || previousZone2 > 0)) {
    const delta = recentZone2 - previousZone2;
    items.push({
      key: 'week-zone2',
      label: 'Zone 2',
      value: `${recentZone2}m`,
      detail: previousZone2 > 0
        ? `${delta >= 0 ? '+' : ''}${delta}m vs ${previousWindowText}`
        : `aerobic minutes ${currentWindowText}`,
      icon: 'walk-outline',
      color: '#EF4444',
      targetTab: 'today',
    });
  }

  const recentPrs = prs.filter(pr => inCurrent(pr.date));
  if (visibility.showWorkoutProgress && recentPrs.length > 0) {
    const top = recentPrs[0];
    items.push({
      key: 'week-prs',
      label: 'PRs',
      value: `${recentPrs.length}`,
      detail: top ? `${top.exerciseName}: ${formatWeight(top.weightLbs, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 })} x ${top.reps}` : `records ${currentWindowText}`,
      icon: 'trophy-outline',
      color: '#F59E0B',
      targetTab: 'trends',
    });
  }

  const weights = [...weightEntries]
    .filter(w => Number.isFinite(w.weightLbs))
    .sort((a, b) => parseDateKeyMs(a.date) - parseDateKeyMs(b.date));
  if (weights.length >= 2) {
    const latest = [...weights].reverse().find(w => parseDateKeyMs(w.date) <= parseDateKeyMs(window.endDate)) ?? weights[weights.length - 1];
    const baseline = [...weights].reverse().find(w => parseDateKeyMs(w.date) <= parseDateKeyMs(window.startDate)) ?? weights[0];
    const delta = Math.round((latest.weightLbs - baseline.weightLbs) * 10) / 10;
    items.push({
      key: 'week-weight',
      label: 'Body weight',
      value: formatWeight(latest.weightLbs, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 }),
      detail: `${delta > 0 ? '+' : ''}${formatWeight(Math.abs(delta), weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 })} since ${formatDate(baseline.date)}`,
      icon: delta < 0 ? 'trending-down-outline' : delta > 0 ? 'trending-up-outline' : 'remove-outline',
      color: delta < 0 ? '#22C55E' : delta > 0 ? '#F59E0B' : '#0EA5E9',
      targetTab: 'body',
    });
  }

  const recentCardioMiles = paceHistory
    .filter(p => inCurrent(p.date))
    .reduce((sum, p) => sum + (p.distance ?? 0), 0);
  if (visibility.showWorkoutProgress && recentCardioMiles > 0) {
    items.push({
      key: 'week-cardio',
      label: 'Cardio distance',
      value: formatDistance(recentCardioMiles, distanceUnit),
      detail: `distance logged ${currentWindowText}`,
      icon: 'pulse-outline',
      color: '#EF4444',
      targetTab: 'trends',
    });
  }

  const mealDays = new Set((mealHistory ?? [])
    .filter(row => inCurrent(row.meal_date))
    .map(row => row.meal_date.slice(0, 10)));
  if (visibility.showMealProgress && mealDays.size > 0) {
    items.push({
      key: 'week-meals',
      label: 'Meal signal',
      value: `${mealDays.size}/${window.days}`,
      detail: `days with meal data ${currentWindowText}`,
      icon: 'nutrition-outline',
      color: '#14B8A6',
      targetTab: 'health',
    });
  }

  return items.slice(0, 4);
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function workoutTrainingScore(summary?: StoredWorkoutSummary | null): number | null {
  const raw = summary?.trainingScore ?? (summary as any)?.training_score;
  const score = Number(raw);
  return Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null;
}

function workoutTrainingRating(summary?: StoredWorkoutSummary | null): string | null {
  const raw = summary?.trainingRating ?? (summary as any)?.training_rating;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function workoutTrainingScoreColor(score: number, tc: ReturnType<typeof getTheme>['colors']): string {
  if (score >= 75) return tc.success;
  if (score >= 55) return tc.warning;
  return tc.error;
}

function resolveProgressGoalBucket(profile: UserProfile): ProgressGoalBucket {
  const goal = String(profile.goal ?? '');
  if (goal === 'body_recomp') return 'body_recomp';
  if (FAT_LOSS_GOALS.has(goal)) return 'fat_loss';
  if (MUSCLE_GOALS.has(goal)) return 'muscle_gain';
  if (STRENGTH_GOALS.has(goal)) return 'strength';
  if (ENDURANCE_GOALS.has(goal)) return 'endurance';
  if (ATHLETIC_GOALS.has(goal)) return 'athletic';

  const category = String(profile.goalSelection?.category ?? '');
  if (category === 'fat_loss') return 'fat_loss';
  if (category === 'muscle_physique') return 'muscle_gain';
  if (category === 'strength') return 'strength';
  if (category === 'cardio_endurance') return 'endurance';
  if (category === 'athletic_performance') return 'athletic';
  return 'general';
}

function signalColor(status: TodaySignalStatus, tc: ReturnType<typeof getTheme>['colors']): string {
  if (status === 'good') return tc.success;
  if (status === 'watch') return tc.warning;
  if (status === 'off') return tc.error;
  return tc.textMuted;
}

function loggedWorkoutDayKeys(
  history: WorkoutSession[],
  summaries: StoredWorkoutSummary[],
  startDate: string,
  endDate: string,
  capDate?: string,
): Set<string> {
  const capMs = capDate ? parseDateKeyMs(capDate) : Number.POSITIVE_INFINITY;
  const keys = new Set<string>();
  for (const summary of summaries.filter(isActiveWorkoutSummary)) {
    const day = summary.date.slice(0, 10);
    const ms = parseDateKeyMs(day);
    if (dateInWindow(day, startDate, endDate) && ms <= capMs) keys.add(day);
  }
  for (const session of history) {
    if (!session.completed || session.skipped) continue;
    const day = session.date.slice(0, 10);
    const ms = parseDateKeyMs(day);
    const hasLoggedWork = (session.durationSeconds ?? 0) > 30
      || (session.exercises ?? []).some(ex => (ex.sets?.length ?? 0) > 0);
    if (hasLoggedWork && dateInWindow(day, startDate, endDate) && ms <= capMs) keys.add(day);
  }
  return keys;
}

function buildTrainingPaceSignal(
  history: WorkoutSession[],
  summaries: StoredWorkoutSummary[],
  profile: UserProfile,
  window: ProgressDateWindow,
  tc: ReturnType<typeof getTheme>['colors'],
): TodayTrackSignal {
  const today = dateKey(new Date());
  const startMs = parseDateKeyMs(window.startDate);
  const endMs = parseDateKeyMs(window.endDate);
  const todayMs = parseDateKeyMs(today);
  const elapsedDays = todayMs < startMs
    ? 0
    : todayMs > endMs
      ? window.days
      : Math.max(1, Math.round((todayMs - startMs) / 86400000) + 1);
  const targetWeek = Math.max(1, Math.min(window.days, Math.round(Number(profile.daysPerWeek) || 3)));
  const expectedByToday = elapsedDays <= 0
    ? 0
    : Math.min(targetWeek, Math.max(1, Math.ceil((targetWeek / window.days) * elapsedDays)));
  const completedByToday = loggedWorkoutDayKeys(history, summaries, window.startDate, window.endDate, today).size;
  const completedThisWeek = loggedWorkoutDayKeys(history, summaries, window.startDate, window.endDate).size;
  const pct = expectedByToday > 0 ? clampPct((completedByToday / expectedByToday) * 100) : 0;
  const status: TodaySignalStatus = expectedByToday === 0
    ? 'needs_data'
    : completedByToday >= expectedByToday
      ? 'good'
      : completedByToday >= Math.max(0, expectedByToday - 1)
        ? 'watch'
        : 'off';
  const color = signalColor(status, tc);
  return {
    key: 'week-workouts',
    label: 'Training pace',
    value: expectedByToday > 0 ? `${completedByToday}/${expectedByToday}` : `${completedThisWeek}/${targetWeek}`,
    detail: expectedByToday > 0
      ? `${targetWeek}/week goal · ${completedThisWeek} logged in this ${window.source === 'plan_week' ? 'PlanWeek' : 'week'}`
      : `${targetWeek}/week goal starts ${formatShortDateKey(window.startDate)}`,
    action: status === 'good'
      ? 'Stay with the next scheduled session.'
      : 'Complete the next scheduled workout to get back on pace.',
    icon: 'calendar-outline',
    color,
    targetTab: 'trends',
    status,
    score: status === 'good' ? 1 : status === 'watch' ? 0.55 : status === 'off' ? 0.15 : 0.35,
    pct,
  };
}

function buildStrengthGoalSignal(
  history: WorkoutSession[],
  tc: ReturnType<typeof getTheme>['colors'],
): TodayTrackSignal {
  const strength = strengthIndexDelta(history);
  if (!strength) {
    return {
      key: 'week-strength',
      label: 'Strength trend',
      value: 'Need sets',
      detail: 'Log loaded working sets in two sessions to compare strength.',
      action: 'Log weight and reps on your main lifts today.',
      icon: 'barbell-outline',
      color: tc.textMuted,
      targetTab: 'trends',
      status: 'needs_data',
      score: 0.35,
      pct: 20,
    };
  }

  const deltaPct = Number(String(strength.value).replace(/[^0-9.-]/g, ''));
  const status: TodaySignalStatus = strength.value === 'New'
    ? 'watch'
    : !Number.isFinite(deltaPct)
      ? 'needs_data'
      : deltaPct >= 0
        ? 'good'
        : deltaPct >= -5
          ? 'watch'
          : 'off';
  return {
    key: 'week-prs',
    label: 'Strength trend',
    value: strength.value,
    detail: strength.detail,
    action: status === 'good'
      ? 'Keep progressing the lift that is moving best.'
      : 'Hold form quality and log hard sets before adding load.',
    icon: 'barbell-outline',
    color: signalColor(status, tc),
    targetTab: 'trends',
    status,
    score: status === 'good' ? 1 : status === 'watch' ? 0.6 : status === 'off' ? 0.2 : 0.35,
    pct: status === 'good' ? 85 : status === 'watch' ? 55 : status === 'off' ? 25 : 20,
  };
}

function buildCardioGoalSignal(
  paceHistory: PaceHistoryPoint[],
  summaries: StoredWorkoutSummary[],
  distanceUnit: DistanceUnit,
  window: ProgressDateWindow,
  tc: ReturnType<typeof getTheme>['colors'],
): TodayTrackSignal {
  const today = dateKey(new Date());
  const currentStart = shiftDateKey(today, -13);
  const previousStart = shiftDateKey(today, -27);
  const previousEnd = shiftDateKey(today, -14);
  const currentDistance = paceHistory
    .filter(point => dateInWindow(point.date, currentStart, today))
    .reduce((sum, point) => sum + Math.max(0, Number(point.distance) || 0), 0);
  const previousDistance = paceHistory
    .filter(point => dateInWindow(point.date, previousStart, previousEnd))
    .reduce((sum, point) => sum + Math.max(0, Number(point.distance) || 0), 0);
  const currentZone2 = buildHrZoneSourceBreakdown(summaries, window.startDate, window.endDate).zoneMinutes[1];

  if (currentDistance > 0 || previousDistance > 0) {
    const deltaPct = previousDistance > 0 ? Math.round(((currentDistance - previousDistance) / previousDistance) * 100) : null;
    const status: TodaySignalStatus = deltaPct == null
      ? 'watch'
      : deltaPct >= 0
        ? 'good'
        : deltaPct >= -15
          ? 'watch'
          : 'off';
    return {
      key: 'week-cardio',
      label: 'Cardio trend',
      value: formatDistance(currentDistance, distanceUnit),
      detail: deltaPct == null
        ? 'distance logged in the last 14 days'
        : `${deltaPct >= 0 ? '+' : ''}${deltaPct}% distance vs prior 14 days`,
      action: status === 'good'
        ? 'Keep the aerobic work steady.'
        : 'Add one easy cardio session or Zone 2 block this week.',
      icon: 'pulse-outline',
      color: signalColor(status, tc),
      targetTab: 'trends',
      status,
      score: status === 'good' ? 1 : status === 'watch' ? 0.6 : 0.2,
      pct: deltaPct == null ? 50 : clampPct(60 + deltaPct),
    };
  }

  if (currentZone2 > 0) {
    return {
      key: 'week-zone2',
      label: 'HR zones',
      value: `${Math.round(currentZone2)}m`,
      detail: `Zone 2 minutes from all sources in this ${window.source === 'plan_week' ? 'PlanWeek' : 'week'}`,
      action: 'Keep easy work easy so it supports recovery.',
      icon: 'walk-outline',
      color: tc.success,
      targetTab: 'today',
      status: 'good',
      score: 0.8,
      pct: clampPct(currentZone2),
    };
  }

  return {
    key: 'week-cardio',
    label: 'Cardio trend',
    value: 'Need logs',
    detail: `Log distance, pace, or use a ${HEALTH_WEARABLE_LABEL} for Zone 2.`,
    action: 'Log a short easy cardio session to start the trend.',
    icon: 'pulse-outline',
    color: tc.textMuted,
    targetTab: 'trends',
    status: 'needs_data',
    score: 0.35,
    pct: 20,
  };
}

function buildWeightGoalSignal(
  profile: UserProfile,
  bucket: ProgressGoalBucket,
  weightEntries: Array<{ date: string; weightLbs: number }>,
  weightUnit: WeightUnit,
  tc: ReturnType<typeof getTheme>['colors'],
  showMealProgress = true,
): TodayTrackSignal {
  const sorted = [...weightEntries]
    .filter(entry => Number.isFinite(entry.weightLbs) && entry.weightLbs > 0 && parseDateKeyMs(entry.date) > 0)
    .sort((a, b) => parseDateKeyMs(a.date) - parseDateKeyMs(b.date));
  const latest = sorted[sorted.length - 1] ?? null;
  if (sorted.length < 2 || !latest) {
    return {
      key: 'week-weight',
      label: 'Weight trend',
      value: latest ? formatWeight(latest.weightLbs, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 }) : 'Need logs',
      detail: 'Two weigh-ins at least a week apart make this goal-aware.',
      action: 'Add a weigh-in today or tomorrow morning.',
      icon: 'scale-outline',
      color: tc.textMuted,
      targetTab: 'body',
      status: 'needs_data',
      score: 0.35,
      pct: 20,
    };
  }

  const recentCutoff = shiftDateKey(dateKey(new Date()), -41);
  const recent = sorted.filter(entry => parseDateKeyMs(entry.date) >= parseDateKeyMs(recentCutoff));
  const sample = recent.length >= 2 ? recent : sorted;
  const first = sample[0];
  const spanDays = Math.max(1, Math.round((parseDateKeyMs(latest.date) - parseDateKeyMs(first.date)) / 86400000));
  const slope = ((latest.weightLbs - first.weightLbs) / spanDays) * 7;
  const desired = bucket === 'fat_loss' ? -1 : bucket === 'muscle_gain' ? 1 : bucket === 'body_recomp' ? 0 : null;
  let status: TodaySignalStatus = 'watch';
  if (desired === -1) status = slope < -0.1 ? 'good' : slope <= 0.25 ? 'watch' : 'off';
  else if (desired === 1) status = slope > 0.1 ? 'good' : slope >= -0.1 ? 'watch' : 'off';
  else if (desired === 0) status = Math.abs(slope) <= 0.35 ? 'good' : Math.abs(slope) <= 0.8 ? 'watch' : 'off';
  else status = 'watch';

  const target = profile.goalDetails?.targetWeightLbs;
  const targetDetail = target && (bucket === 'fat_loss' || bucket === 'muscle_gain')
    ? ` · target ${formatWeight(target, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 })}`
    : '';
  return {
    key: 'week-weight',
    label: bucket === 'body_recomp' ? 'Scale control' : 'Weight trend',
    value: `${formatSignedWeightDelta(slope, weightUnit)}/wk`,
    detail: `${sample.length} weigh-ins over ${spanDays} days${targetDetail}`,
    action: status === 'good'
      ? 'Keep calories and weigh-in timing consistent.'
      : bucket === 'fat_loss'
        ? showMealProgress ? 'Tighten meal logging before changing the plan.' : 'Use consistent weigh-ins before changing the plan.'
        : bucket === 'muscle_gain'
          ? showMealProgress ? 'Make sure meals support the surplus before adding training stress.' : 'Use weight trend and recovery before adding training stress.'
          : 'Use weight plus photos or measurements before judging recomp.',
    icon: slope < -0.05 ? 'trending-down-outline' : slope > 0.05 ? 'trending-up-outline' : 'remove-outline',
    color: signalColor(status, tc),
    targetTab: 'body',
    status,
    score: status === 'good' ? 1 : status === 'watch' ? 0.6 : 0.2,
    pct: status === 'good' ? 85 : status === 'watch' ? 55 : 25,
  };
}

function buildMealGoalSignal(
  mealHistory: Array<{ meal_date: string }> | null,
  mealAverages: { window_days: number; days_with_data: number; avg_protein_g?: number | null; avg_protein_g_when_logged?: number | null } | null,
  window: ProgressDateWindow,
  tc: ReturnType<typeof getTheme>['colors'],
): TodayTrackSignal {
  const today = dateKey(new Date());
  const todayMs = parseDateKeyMs(today);
  const startMs = parseDateKeyMs(window.startDate);
  const elapsedDays = todayMs < startMs
    ? 0
    : Math.min(window.days, Math.max(1, Math.round((todayMs - startMs) / 86400000) + 1));
  const mealDays = new Set((mealHistory ?? [])
    .filter(row => dateInWindow(row.meal_date, window.startDate, window.endDate) && parseDateKeyMs(row.meal_date) <= todayMs)
    .map(row => row.meal_date.slice(0, 10)));
  const fallbackDays = Math.round(Number(mealAverages?.days_with_data) || 0);
  const days = Math.max(mealDays.size, Math.min(fallbackDays, elapsedDays || fallbackDays));
  const denominator = Math.max(1, elapsedDays || Math.round(Number(mealAverages?.window_days) || 7));
  const pct = clampPct((days / denominator) * 100);
  const status: TodaySignalStatus = days <= 0
    ? 'needs_data'
    : pct >= 70
      ? 'good'
      : pct >= 40
        ? 'watch'
        : 'off';
  const protein = Number(mealAverages?.avg_protein_g_when_logged ?? mealAverages?.avg_protein_g);
  return {
    key: 'week-meals',
    label: 'Nutrition signal',
    value: days > 0 ? `${days}/${denominator}` : 'Need logs',
    detail: Number.isFinite(protein) && protein > 0
      ? `${Math.round(protein)}g protein on logged days`
      : 'logged meal days by today',
    action: status === 'good'
      ? 'Keep logging the meals that drive the goal.'
      : "Log today's meals so weight and performance trends have context.",
    icon: 'nutrition-outline',
    color: signalColor(status, tc),
    targetTab: 'health',
    status,
    score: status === 'good' ? 1 : status === 'watch' ? 0.6 : status === 'off' ? 0.2 : 0.35,
    pct,
  };
}

function uniqueTodaySignals(signals: TodayTrackSignal[]): TodayTrackSignal[] {
  const seen = new Set<string>();
  return signals.filter(signal => {
    if (seen.has(signal.key)) return false;
    seen.add(signal.key);
    return true;
  }).slice(0, 4);
}

function buildTodayTrackSummary(input: {
  profile: UserProfile;
  history: WorkoutSession[];
  summaries: StoredWorkoutSummary[];
  weightEntries: Array<{ date: string; weightLbs: number }>;
  paceHistory: PaceHistoryPoint[];
  mealHistory: Array<{ meal_date: string }> | null;
  mealAverages: { window_days: number; days_with_data: number; avg_protein_g?: number | null; avg_protein_g_when_logged?: number | null } | null;
  weightUnit: WeightUnit;
  distanceUnit: DistanceUnit;
  window: ProgressDateWindow;
  tc: ReturnType<typeof getTheme>['colors'];
  showWorkoutProgress: boolean;
  showMealProgress: boolean;
}): TodayTrackSummary {
  const bucket = resolveProgressGoalBucket(input.profile);
  const training = buildTrainingPaceSignal(input.history, input.summaries, input.profile, input.window, input.tc);
  const strength = buildStrengthGoalSignal(input.history, input.tc);
  const cardio = buildCardioGoalSignal(input.paceHistory, input.summaries, input.distanceUnit, input.window, input.tc);
  const weight = buildWeightGoalSignal(input.profile, bucket, input.weightEntries, input.weightUnit, input.tc, input.showMealProgress);
  const nutrition = buildMealGoalSignal(input.mealHistory, input.mealAverages, input.window, input.tc);

  const orderedRaw = bucket === 'fat_loss'
    ? [weight, training, nutrition, strength]
    : bucket === 'muscle_gain'
      ? [strength, training, nutrition, weight]
      : bucket === 'body_recomp'
        ? [strength, weight, training, nutrition]
        : bucket === 'strength'
          ? [strength, training, nutrition, cardio]
          : bucket === 'endurance'
            ? [cardio, training, nutrition, strength]
            : bucket === 'athletic'
              ? [training, cardio, strength, nutrition]
              : [training, strength, cardio, nutrition];
  const ordered = orderedRaw.filter(signal => {
    if (signal === training || signal === strength || signal === cardio) return input.showWorkoutProgress;
    if (signal === nutrition) return input.showMealProgress;
    return true;
  });
  const signals = uniqueTodaySignals(ordered);
  const dataSignals = signals.filter(signal => signal.status !== 'needs_data');
  const totalWeight = signals.reduce((sum, signal, index) => sum + (index === 0 ? 1.3 : 1), 0);
  const score = signals.reduce((sum, signal, index) => sum + signal.score * (index === 0 ? 1.3 : 1), 0);
  const progressPct = clampPct((score / Math.max(1, totalWeight)) * 100);
  const primary = signals[0] ?? weight;
  const hasPrimaryProblem = primary.status === 'off';
  const state = dataSignals.length < 2
    ? 'needs_data'
    : progressPct >= 75 && !hasPrimaryProblem
      ? 'on_track'
      : progressPct >= 55
        ? 'close'
        : 'off_track';
  const color = state === 'on_track'
    ? input.tc.success
    : state === 'close'
      ? input.tc.warning
      : state === 'off_track'
        ? input.tc.error
        : input.tc.primary;
  const title = state === 'on_track'
    ? 'On track today'
    : state === 'close'
      ? 'Close to on track'
      : state === 'off_track'
        ? 'Needs attention today'
        : "Build today's baseline";
  const supporting = signals.find(signal => signal.key !== primary.key && signal.status !== 'needs_data') ?? signals.find(signal => signal.key !== primary.key) ?? primary;
  const subtitle = supporting.key === primary.key
    ? `${GOAL_LABELS[bucket]} goal: ${primary.detail}.`
    : `${GOAL_LABELS[bucket]} goal: ${primary.detail}. ${supporting.label}: ${supporting.value}.`;
  const worst = [...signals].sort((a, b) => a.score - b.score)[0] ?? primary;
  return {
    bucket,
    goalLabel: GOAL_LABELS[bucket],
    title,
    subtitle,
    action: worst.action,
    color,
    icon: state === 'on_track' ? 'checkmark-circle-outline' : state === 'off_track' ? 'alert-circle-outline' : 'speedometer-outline',
    progressPct,
    confidence: dataSignals.length >= 3 ? 'strong signal' : dataSignals.length >= 2 ? 'directional' : 'needs logs',
    signals,
  };
}

const GOAL_EXECUTION_BLOCK_DAYS = 42;

function validDateKeyOrToday(raw: string | null | undefined, today: string): string {
  const key = String(raw ?? '').slice(0, 10);
  return parseDateKeyMs(key) > 0 ? key : today;
}

function daysBetweenKeys(startKey: string, endKey: string): number {
  const start = parseDateKeyMs(startKey);
  const end = parseDateKeyMs(endKey);
  if (!start || !end) return 0;
  return Math.round((end - start) / 86400000);
}

function formatGoalTimelineDate(key: string): string {
  const ms = parseDateKeyMs(key);
  if (!ms) return key;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function compactAgoLabel(dateKeyValue: string, todayKeyValue: string): string {
  const days = Math.max(0, daysBetweenKeys(dateKeyValue, todayKeyValue));
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days}d ago`;
  return `${Math.round(days / 7)}w ago`;
}

function stripGoalStartedCopy(text: string): string {
  return text
    .replace(/^(New goal|Started today|Started \d+ days? ago|Started \d+ weeks? ago);\s*/i, '')
    .trim();
}

function latestWeightEntry(entries: WeightEntry[], todayKeyValue: string): WeightEntry | null {
  return [...entries]
    .filter(entry => Number.isFinite(entry.weightLbs) && entry.weightLbs > 0 && parseDateKeyMs(entry.date) > 0 && parseDateKeyMs(entry.date) <= parseDateKeyMs(todayKeyValue))
    .sort((a, b) => parseDateKeyMs(a.date) - parseDateKeyMs(b.date))
    .at(-1) ?? null;
}

type GoalWeekWindow = {
  index: number;
  key: string;
  label: string;
  startDate: string;
  endDate: string;
  capDate: string;
  elapsedDays: number;
};

function buildGoalWeekWindows(blockStartDate: string, todayKeyValue: string): GoalWeekWindow[] {
  return Array.from({ length: 6 }, (_, index) => {
    const startDate = shiftDateKey(blockStartDate, index * 7);
    const endDate = shiftDateKey(startDate, 6);
    const future = parseDateKeyMs(startDate) > parseDateKeyMs(todayKeyValue);
    const capDate = future || parseDateKeyMs(endDate) <= parseDateKeyMs(todayKeyValue) ? endDate : todayKeyValue;
    const elapsedDays = future ? 0 : Math.max(1, Math.min(7, daysBetweenKeys(startDate, capDate) + 1));
    return { index, key: `week-${index + 1}`, label: `W${index + 1}`, startDate, endDate, capDate, elapsedDays };
  });
}

function bodyScanValue(scan: BodyScanEntry | null | undefined): number | null {
  const value = finiteOrNull(scan?.bodyFatPct);
  return value != null && value > 0 ? value : null;
}

function latestBodyScanBefore(scans: BodyScanEntry[], capDate: string): BodyScanEntry | null {
  const capMs = parseDateKeyMs(capDate);
  return [...scans]
    .filter(scan => bodyScanValue(scan) != null && parseDateKeyMs(scan.date) > 0 && parseDateKeyMs(scan.date) <= capMs)
    .sort((a, b) => parseDateKeyMs(a.date) - parseDateKeyMs(b.date))
    .at(-1) ?? null;
}

function bestStrengthE1RMInWindow(history: WorkoutSession[], startDate: string, endDate: string): number | null {
  let best: number | null = null;
  for (const session of history) {
    if (!session.completed || session.skipped || !dateInWindow(session.date, startDate, endDate)) continue;
    for (const exercise of session.exercises ?? []) {
      if (isNonStrengthExercise(exercise)) continue;
      const category = categorizeExercise(exercise);
      for (const set of exercise.sets ?? []) {
        const estimate = estimate1RM((set as any).weightLbs ?? (set as any).weight_lbs, (set as any).reps, {
          rir: (set as any).rir ?? (set as any).repsInReserve ?? (set as any).reps_in_reserve,
          category,
        });
        if (estimate != null && (best == null || estimate > best)) best = estimate;
      }
    }
  }
  return best;
}

function buildGoalExecutionOverview(input: {
  profile: UserProfile;
  todayTrack: TodayTrackSummary;
  goalForecast: GoalForecastModel | null;
  weightEntries: WeightEntry[];
  history: WorkoutSession[];
  summaries: StoredWorkoutSummary[];
  prs: PR[];
  paceHistory: PaceHistoryPoint[];
  mealHistory: Array<{ meal_date: string }> | null;
  vo2Points: HealthBiometricHistoryPoint[];
  bodyScanHistory: BodyScanEntry[];
  weightUnit: WeightUnit;
  distanceUnit: DistanceUnit;
  tc: ThemeColors;
  showWorkoutProgress: boolean;
  showMealProgress: boolean;
  today?: Date;
}): GoalExecutionOverview {
  const today = input.today ?? new Date();
  const todayKeyValue = dateKey(today);
  const originalStart = validDateKeyOrToday(input.profile.goalDetails?.goalStartedAt, todayKeyValue);
  const elapsedSinceGoalStart = Math.max(0, daysBetweenKeys(originalStart, todayKeyValue));
  const blockIndex = Math.floor(elapsedSinceGoalStart / GOAL_EXECUTION_BLOCK_DAYS);
  const blockStartDate = shiftDateKey(originalStart, blockIndex * GOAL_EXECUTION_BLOCK_DAYS);
  const blockEndDate = shiftDateKey(blockStartDate, GOAL_EXECUTION_BLOCK_DAYS - 1);
  const dayInBlock = Math.max(1, Math.min(GOAL_EXECUTION_BLOCK_DAYS, daysBetweenKeys(blockStartDate, todayKeyValue) + 1));
  const elapsedPct = clampPct((dayInBlock / GOAL_EXECUTION_BLOCK_DAYS) * 100);
  const timeLeftPct = clampPct(100 - elapsedPct);
  const remainingDays = Math.max(0, GOAL_EXECUTION_BLOCK_DAYS - dayInBlock);
  const bucket = input.todayTrack.bucket;
  const weightPrecision = input.weightUnit === 'kg' ? 1 : 0;
  const latestWeight = latestWeightEntry(input.weightEntries, todayKeyValue);
  const weightStaleDays = latestWeight ? daysBetweenKeys(latestWeight.date, todayKeyValue) : Number.POSITIVE_INFINITY;
  const weeks = buildGoalWeekWindows(blockStartDate, todayKeyValue);
  const targetDays = Math.max(1, Math.round(Number(input.profile.daysPerWeek) || 3));
  const isBodyGoal = bucket === 'fat_loss' || bucket === 'muscle_gain' || bucket === 'body_recomp';
  const isRecompGoal = bucket === 'body_recomp';
  const isStrengthGoal = bucket === 'strength' || bucket === 'muscle_gain';
  const isCardioGoal = bucket === 'endurance' || bucket === 'athletic';
  const startBodyFatPct = finiteOrNull(input.profile.goalDetails?.startBodyFatPct);
  const hasGoalStartBodyFat = startBodyFatPct != null && startBodyFatPct > 0;
  const bodyScansSinceGoalStart = input.bodyScanHistory.filter(scan => bodyScanValue(scan) != null && dateInWindow(scan.date, originalStart, todayKeyValue));
  const bodyFatInBlockAvailable = isBodyGoal && bodyScansSinceGoalStart.some(scan => dateInWindow(scan.date, blockStartDate, todayKeyValue));
  const useBodyFatSecondary = isBodyGoal && (bodyFatInBlockAvailable || (isRecompGoal && hasGoalStartBodyFat));
  const vo2Available = isCardioGoal && input.vo2Points.some(point => Number.isFinite(point.value) && dateInWindow(point.date, blockStartDate, todayKeyValue));
  const secondaryLabel = isBodyGoal
    ? useBodyFatSecondary ? 'Body fat' : 'Weight'
    : isStrengthGoal
      ? 'Strength'
      : isCardioGoal
        ? vo2Available ? 'VO2 max' : 'Cardio volume'
        : 'Goal signal';
  const secondaryColor = isBodyGoal
    ? useBodyFatSecondary ? '#F59E0B' : '#14B8A6'
    : isStrengthGoal
      ? '#A78BFA'
      : isCardioGoal
        ? '#06B6D4'
        : input.tc.textMuted;

  const rawPoints = weeks.map(week => {
    const elapsedDays = week.elapsedDays;
    let executionPct: number | null = null;
    if (elapsedDays > 0) {
      let weightedScore = 0;
      let totalWeight = 0;
      if (input.showWorkoutProgress) {
        const expectedWorkouts = elapsedDays < 7
          ? Math.max(1, Math.ceil((targetDays / 7) * elapsedDays))
          : targetDays;
        const completed = loggedWorkoutDayKeys(input.history, input.summaries, week.startDate, week.endDate, week.capDate).size;
        const trainingPct = clampPct((completed / Math.max(1, expectedWorkouts)) * 100) / 100;
        const weight = isCardioGoal ? 0.8 : isStrengthGoal ? 0.75 : isBodyGoal ? 0.4 : 0.65;
        weightedScore += Math.min(1.05, trainingPct) * weight;
        totalWeight += weight;
      }
      if (input.showMealProgress) {
        const mealDays = new Set((input.mealHistory ?? [])
          .map(row => String(row.meal_date ?? '').slice(0, 10))
          .filter(key => dateInWindow(key, week.startDate, week.endDate) && parseDateKeyMs(key) <= parseDateKeyMs(week.capDate))).size;
        const nutritionPct = clampPct((mealDays / Math.max(1, elapsedDays)) * 100) / 100;
        const weight = isBodyGoal ? 0.5 : isStrengthGoal ? 0.25 : isCardioGoal ? 0.2 : 0.35;
        weightedScore += Math.min(1.05, nutritionPct) * weight;
        totalWeight += weight;
      }
      if (isBodyGoal) {
        const hasWeightLog = input.weightEntries.some(entry => dateInWindow(entry.date, week.startDate, week.endDate) && parseDateKeyMs(entry.date) <= parseDateKeyMs(week.capDate));
        weightedScore += (hasWeightLog ? 1 : 0.35) * 0.1;
        totalWeight += 0.1;
      }
      executionPct = totalWeight > 0 ? clampPct((weightedScore / totalWeight) * 100) : null;
    }

    let secondaryRaw: number | null = null;
    let secondaryValue = 'Need data';
    if (isBodyGoal) {
      if (useBodyFatSecondary) {
        const scan = latestBodyScanBefore(bodyScansSinceGoalStart, week.capDate);
        const value = bodyScanValue(scan) ?? (isRecompGoal ? startBodyFatPct : null);
        if (value != null && elapsedDays > 0) {
          secondaryRaw = value;
          secondaryValue = `${value.toFixed(1).replace(/\.0$/, '')}%`;
        }
      } else if (elapsedDays > 0) {
        const latestInWeek = latestWeightEntry(input.weightEntries.filter(entry => parseDateKeyMs(entry.date) <= parseDateKeyMs(week.capDate)), week.capDate);
        const fallback = latestInWeek?.weightLbs ?? finiteOrNull(input.profile.goalDetails?.startWeightLbs) ?? finiteOrNull(input.profile.physicalStats?.weightLbs);
        if (fallback != null) {
          secondaryRaw = fallback;
          secondaryValue = formatWeight(fallback, input.weightUnit, { precision: weightPrecision });
        }
      }
    } else if (isStrengthGoal && elapsedDays > 0) {
      const best = bestStrengthE1RMInWindow(input.history, week.startDate, week.capDate);
      if (best != null) {
        secondaryRaw = best;
        secondaryValue = formatWeight(best, input.weightUnit, { precision: weightPrecision });
      }
    } else if (isCardioGoal && elapsedDays > 0) {
      if (vo2Available) {
        const latestVo2 = [...input.vo2Points]
          .filter(point => Number.isFinite(point.value) && parseDateKeyMs(point.date) <= parseDateKeyMs(week.capDate))
          .sort((a, b) => parseDateKeyMs(a.date) - parseDateKeyMs(b.date))
          .at(-1) ?? null;
        if (latestVo2) {
          secondaryRaw = latestVo2.value;
          secondaryValue = latestVo2.value.toFixed(1).replace(/\.0$/, '');
        }
      } else {
        const miles = input.paceHistory
          .filter(point => dateInWindow(point.date, week.startDate, week.endDate) && parseDateKeyMs(point.date) <= parseDateKeyMs(week.capDate))
          .reduce((sum, point) => sum + Math.max(0, Number(point.distance) || 0), 0);
        if (miles > 0) {
          secondaryRaw = miles;
          secondaryValue = formatDistance(miles, input.distanceUnit);
        }
      }
    }

    return {
      key: week.key,
      label: week.label,
      executionPct,
      secondaryRaw,
      secondaryValue,
    };
  });

  const secondaryValues = rawPoints
    .map(point => point.secondaryRaw)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const rawMin = secondaryValues.length > 0 ? Math.min(...secondaryValues) : 0;
  const rawMax = secondaryValues.length > 0 ? Math.max(...secondaryValues) : 0;
  const rawSpan = Math.max(1, rawMax - rawMin);
  const points: GoalGraphPoint[] = rawPoints.map(point => ({
    key: point.key,
    label: point.label,
    executionPct: point.executionPct,
    secondaryValue: point.secondaryValue,
    secondaryPct: point.secondaryRaw == null
      ? null
      : secondaryValues.length < 2
        ? 50
        : clampPct(18 + ((point.secondaryRaw - rawMin) / rawSpan) * 64),
  }));

  const latestExecution = [...points].reverse().find(point => point.executionPct != null)?.executionPct ?? input.goalForecast?.executionPct ?? input.todayTrack.progressPct;
  const latestSecondary = [...points].reverse().find(point => point.secondaryPct != null);
  const latestBodyScan = latestBodyScanBefore(bodyScansSinceGoalStart, todayKeyValue);
  const latestBodyFatPct = bodyScanValue(latestBodyScan) ?? (useBodyFatSecondary ? startBodyFatPct : null);
  const latestEstablishedPr = establishedRecentPrs(input.history, input.prs, parseDateKeyMs(blockStartDate))
    .filter(pr => dateInWindow(pr.date, blockStartDate, todayKeyValue))
    .sort((a, b) => parseDateKeyMs(b.date) - parseDateKeyMs(a.date))[0] ?? null;
  const stats: GoalOverviewStat[] = isBodyGoal
    ? [
        {
          key: 'latest-weight',
          label: 'Latest weight',
          value: latestWeight ? formatWeight(latestWeight.weightLbs, input.weightUnit, { precision: weightPrecision }) : 'Need log',
          detail: latestWeight ? (weightStaleDays > 7 ? 'weight update needed' : compactAgoLabel(latestWeight.date, todayKeyValue)) : 'weight update needed',
          color: latestWeight && weightStaleDays <= 7 ? input.tc.textPrimary : input.tc.warning,
        },
        {
          key: useBodyFatSecondary ? 'body-fat' : 'execution',
          label: useBodyFatSecondary ? 'Body fat' : 'Execution',
          value: useBodyFatSecondary && latestBodyFatPct != null ? `${latestBodyFatPct.toFixed(1).replace(/\.0$/, '')}%` : `${latestExecution}%`,
          detail: useBodyFatSecondary ? (latestBodyScan ? formatGoalTimelineDate(latestBodyScan.date) : 'goal start') : 'latest week',
          color: useBodyFatSecondary ? secondaryColor : input.tc.primary,
        },
      ]
    : isStrengthGoal
      ? [
          {
            key: 'strength-marker',
            label: 'Strength',
            value: latestSecondary?.secondaryValue ?? 'Need sets',
            detail: latestEstablishedPr ? `PR ${compactAgoLabel(latestEstablishedPr.date, todayKeyValue)}` : 'weekly best e1RM',
            color: secondaryColor,
          },
          { key: 'execution', label: 'Execution', value: `${latestExecution}%`, detail: 'latest week', color: input.tc.primary },
        ]
      : isCardioGoal
        ? [
            {
              key: 'cardio-marker',
              label: secondaryLabel,
              value: latestSecondary?.secondaryValue ?? 'Need logs',
              detail: vo2Available ? HEALTH_WEARABLE_LABEL : 'weekly distance',
              color: secondaryColor,
            },
            { key: 'execution', label: 'Execution', value: `${latestExecution}%`, detail: 'latest week', color: input.tc.primary },
          ]
        : [
            { key: 'execution', label: 'Execution', value: `${latestExecution}%`, detail: 'latest week', color: input.tc.primary },
            { key: 'time-left', label: 'Time left', value: `${timeLeftPct}%`, detail: remainingDays === 0 ? 'checkpoint today' : `${remainingDays}d left`, color: input.tc.textPrimary },
          ];

  const graphSubtitle = isBodyGoal
    ? `Execution vs ${secondaryLabel.toLowerCase()} across this 6-week block.`
    : isStrengthGoal
      ? 'Execution vs weekly strength markers.'
      : isCardioGoal
        ? `Execution vs ${secondaryLabel.toLowerCase()} across this 6-week block.`
        : 'Execution across this 6-week block.';

  return {
    blockStartDate,
    blockEndDate,
    dayLabel: `Day ${dayInBlock}/${GOAL_EXECUTION_BLOCK_DAYS}`,
    timeLeftLabel: `${timeLeftPct}% time left`,
    graphTitle: '6-week execution',
    graphSubtitle,
    secondaryLabel,
    secondaryColor,
    points,
    stats,
  };
}

function serverCompletionIdFromLocalId(id?: string | null): number | undefined {
  const match = String(id ?? '').match(/^server(?:-summary)?-(\d+)$/);
  const parsed = match ? Number(match[1]) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function externalSourceIdFromLocalId(id?: string | null): string | undefined {
  const value = String(id ?? '').trim();
  if (!value || /^server(?:-summary|-session)?-\d+$/.test(value)) return undefined;
  return value;
}

function workoutSourceKey(externalSourceId?: string | null): string | null {
  const sourceKey = typeof externalSourceId === 'string' ? externalSourceId.trim() : '';
  return sourceKey ? `source|${sourceKey}` : null;
}

function workoutDateFocusKey(dateISO?: string | null, focus?: string | null): string | null {
  const date = typeof dateISO === 'string' ? dateISO.slice(0, 10) : '';
  const focusKey = typeof focus === 'string' ? focus.trim().toLowerCase() : '';
  return date && focusKey ? `${date}|${focusKey}` : null;
}

function workoutCompletionKey(dateISO?: string | null, focus?: string | null, externalSourceId?: string | null): string | null {
  return workoutSourceKey(externalSourceId) ?? workoutDateFocusKey(dateISO, focus);
}

function workoutIdentitiesMatch(
  aSource: string | null,
  aDateFocus: string | null,
  bSource: string | null,
  bDateFocus: string | null,
): boolean {
  if (aSource && bSource) return aSource === bSource;
  return !!aDateFocus && aDateFocus === bDateFocus;
}

function workoutSessionsMatch(a: WorkoutSession, b: WorkoutSession): boolean {
  return workoutIdentitiesMatch(
    workoutSourceKey(externalSourceIdFromLocalId(a.id)),
    workoutDateFocusKey(a.date, a.focus),
    workoutSourceKey(externalSourceIdFromLocalId(b.id)),
    workoutDateFocusKey(b.date, b.focus),
  );
}

function workoutSessionCompletionKey(session: WorkoutSession): string | null {
  return workoutCompletionKey(session.date, session.focus, externalSourceIdFromLocalId(session.id));
}

function workoutSummaryCompletionKey(summary: StoredWorkoutSummary): string | null {
  return workoutCompletionKey(summary.date, summary.focus, externalSourceIdFromLocalId(summary.id));
}

function serverCompletionKey(completion: WorkoutCompletionRecord): string | null {
  return workoutCompletionKey(completion.workout_date, completion.focus_label, completion.external_source_id);
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
  const completionRoute = completion.route_coords?.map(c => ({ lat: c.lat, lon: c.lon }));
  const trainingScore = completion.training_score;
  const trainingRating = completion.training_rating;
  return {
    ...summary,
    caloriesBurned: summary.caloriesBurned || completion.calories_burned || 0,
    hrAvg: summary.hrAvg ?? (hr?.avgBpm != null ? Math.round(Number(hr.avgBpm)) : undefined),
    hrMax: summary.hrMax ?? (hr?.maxBpm != null ? Math.round(Number(hr.maxBpm)) : undefined),
    hrZoneMinutes: summary.hrZoneMinutes ?? zones,
    stimulus: summary.stimulus ?? completion.stimulus ?? null,
    sourceContext: summary.sourceContext ?? completion.source_context ?? null,
    activityCategory: summary.activityCategory ?? completion.activity_category ?? null,
    activitySubtype: summary.activitySubtype ?? completion.activity_subtype ?? null,
    activitySource: summary.activitySource ?? completion.activity_source ?? null,
    cardioStyle: summary.cardioStyle ?? completion.cardio_style ?? null,
    distanceMiles: summary.distanceMiles ?? completion.distance_miles ?? null,
    importSource: summary.importSource ?? completion.import_source ?? null,
    routeCoords: summary.routeCoords ?? completionRoute ?? null,
    trainingScore: summary.trainingScore ?? (trainingScore != null ? Math.round(Number(trainingScore)) : undefined),
    trainingRating: summary.trainingRating ?? (typeof trainingRating === 'string' ? trainingRating as any : undefined),
    trainingPillars: summary.trainingPillars ?? (completion.training_pillars as any) ?? undefined,
    trainingPillarBreakdown: summary.trainingPillarBreakdown ?? (completion.training_pillar_breakdown as any) ?? undefined,
  };
}

function summaryFromCompletion(completion: WorkoutCompletionRecord): StoredWorkoutSummary | null {
  const hasSummaryMetrics = Boolean(
    completion.calories_burned
    || completion.hr_summary?.avgBpm
    || completion.hr_summary?.maxBpm
    || completion.hr_summary?.zoneMinutes?.some(m => Number(m) > 0)
    || completion.training_score != null
  );
  if (!hasSummaryMetrics) return null;
  return mergeCompletionMetrics({
    id: `server-summary-${completion.id}`,
    date: completion.started_at ?? completion.ended_at ?? completion.completed_at ?? `${completion.workout_date}T12:00:00.000Z`,
    focus: completion.focus_label,
    durationSeconds: completion.duration_seconds,
    startedAt: completion.started_at ?? undefined,
    endedAt: completion.ended_at ?? completion.completed_at ?? undefined,
    totalSets: 0,
    totalReps: 0,
    caloriesBurned: completion.calories_burned ?? 0,
    stimulus: completion.stimulus ?? null,
    sourceContext: completion.source_context ?? null,
    activityCategory: completion.activity_category ?? null,
    activitySubtype: completion.activity_subtype ?? null,
    activitySource: completion.activity_source ?? null,
    cardioStyle: completion.cardio_style ?? null,
    distanceMiles: completion.distance_miles ?? null,
    importSource: completion.import_source ?? null,
    routeCoords: completion.route_coords?.map(c => ({ lat: c.lat, lon: c.lon })) ?? null,
    motivationMessage: 'Workout logged.',
    achievements: [],
    recommendations: [],
    headline: 'Workout logged',
    coachingPoint: '',
    motivation: '',
  }, completion);
}

function mergeCompletionIntoSession(session: WorkoutSession, completion: WorkoutCompletionRecord): WorkoutSession {
  return mergeCompletionIntoWorkoutSession(session, completion);
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

function serverSetType(raw: unknown): string | null {
  const value = String(raw ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (!value) return null;
  return value === 'warm_up' ? 'warmup' : value;
}

function workoutSessionFromServer(row: WorkoutSessionRecord): WorkoutSession {
  const exercises = (row.exercises ?? []).map(exercise => {
    const allSets = (exercise.sets ?? [])
      .filter(set => set.completed !== false)
      .map((set, index) => ({
        setNumber: Number(set.set_number ?? index + 1) > 0 ? Number(set.set_number ?? index + 1) : index + 1,
        reps: Number(set.actual_reps ?? set.target_reps_max ?? set.target_reps_min ?? 0),
        weightLbs: Number(set.actual_weight_lbs ?? set.target_weight_lbs ?? 0),
        durationSeconds: set.duration_seconds ?? undefined,
        comfortRating: set.comfort_rating ?? undefined,
        rir: set.actual_rir ?? undefined,
        actualDistance: set.actual_distance ?? undefined,
        actualPace: set.actual_pace ?? undefined,
        heartRateAvg: set.heart_rate_avg ?? undefined,
        cardioMetrics: set.cardio_metrics ?? undefined,
        setType: serverSetType(set.set_type) as any,
      }));
    const warmupSets = allSets
      .filter(set => set.setType === 'warmup')
      .map((set, index) => ({ ...set, setNumber: index + 1 }));
    const sets = allSets
      .filter(set => set.setType !== 'warmup')
      .map((set, index) => ({ ...set, setNumber: Number(set.setNumber) > 0 ? Number(set.setNumber) : index + 1 }));
    return {
      name: exercise.name,
      targetSets: sets.length,
      targetReps: targetRepsFromServerExercise(exercise),
      targetRestSeconds: exercise.rest_seconds ?? 60,
      equipment: exercise.equipment ?? 'other',
      sets,
      warmupSets,
      slug: exercise.exercise_slug_snapshot ?? undefined,
      primaryMuscle: exercise.primary_muscle_snapshot ?? undefined,
      primary_muscle: exercise.primary_muscle_snapshot ?? undefined,
      secondaryMuscles: exercise.secondary_muscles_snapshot ?? undefined,
      secondary_muscles: exercise.secondary_muscles_snapshot ?? undefined,
      isCompound: exercise.is_compound_snapshot ?? undefined,
    };
  });
  return {
    id: row.external_source_id?.trim() || `server-session-${row.id}`,
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
  const merged: WorkoutSession[] = [];
  const upsert = (incoming: WorkoutSession) => {
    const existingIndex = merged.findIndex(session => workoutSessionsMatch(session, incoming));
    if (existingIndex < 0) {
      merged.push(incoming);
      return;
    }
    const existing = merged[existingIndex];
    const existingSetCount = existing.exercises?.reduce((sum, ex) => sum + (ex.sets?.length ?? 0), 0) ?? 0;
    const incomingSetCount = incoming.exercises?.reduce((sum, ex) => sum + (ex.sets?.length ?? 0), 0) ?? 0;
    const existingHasSource = !!workoutSourceKey(externalSourceIdFromLocalId(existing.id));
    const incomingHasSource = !!workoutSourceKey(externalSourceIdFromLocalId(incoming.id));
    if ((!existingHasSource && incomingHasSource) || (existingSetCount === 0 && incomingSetCount > 0)) {
      merged[existingIndex] = incoming;
    }
  };
  localHistory.forEach(upsert);
  (serverRows ?? []).map(workoutSessionFromServer).forEach(upsert);
  return merged.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

function reconcileWorkoutProgressData(
  history: WorkoutSession[],
  summaries: StoredWorkoutSummary[],
  completions: WorkoutCompletionRecord[] | null,
): { history: WorkoutSession[]; summaries: StoredWorkoutSummary[] } {
  if (!completions) return { history, summaries };
  const completionsByKey = new Map(
    completions
      .map(c => [serverCompletionKey(c), c] as const)
      .filter((entry): entry is [string, WorkoutCompletionRecord] => !!entry[0]),
  );
  const completionKeys = new Set(
    completionsByKey.keys(),
  );
  const serverSessionKeys = new Set(
    history
      .filter(session => /^server-session-\d+$/.test(String(session.id ?? '')) && session.completed && !session.skipped)
      .map(session => workoutSessionCompletionKey(session))
      .filter((key): key is string => !!key),
  );
  const authoritativeKeys = new Set([...completionKeys, ...serverSessionKeys]);
  if (authoritativeKeys.size === 0) return { history: [], summaries: [] };

  const scopedHistory = history
    .map(session => {
      const key = workoutSessionCompletionKey(session);
      const completion = key ? completionsByKey.get(key) : undefined;
      return completion ? mergeCompletionIntoSession(session, completion) : session;
    })
    .filter(session => {
      const key = workoutSessionCompletionKey(session);
      return !!key && authoritativeKeys.has(key);
    });
  const existingKeys = new Set(
    scopedHistory
      .map(session => workoutSessionCompletionKey(session))
      .filter((key): key is string => !!key),
  );
  for (const completion of completions) {
    const key = serverCompletionKey(completion);
    if (!key || existingKeys.has(key)) continue;
    const manualActivity = manualActivityFromCompletion(completion);
    scopedHistory.push({
      id: `server-${completion.id}`,
      date: completion.started_at ?? completion.ended_at ?? completion.completed_at ?? `${completion.workout_date}T12:00:00.000Z`,
      focus: completion.focus_label,
      durationSeconds: completion.duration_seconds,
      startedAt: completion.started_at ?? undefined,
      endedAt: completion.ended_at ?? completion.completed_at ?? undefined,
      exercises: [],
      completed: true,
      ...(manualActivity ? { manualActivity } : {}),
      ...(completion.route_coords && completion.route_coords.length > 0
        ? { routeCoords: completion.route_coords.map(c => ({ lat: c.lat, lon: c.lon })) }
        : {}),
      ...(completion.import_source ? { importSource: completion.import_source } : {}),
    });
    existingKeys.add(key);
  }
  scopedHistory.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

  const scopedSummaries = summaries.filter(summary => {
    const key = workoutSummaryCompletionKey(summary);
    return !!key && authoritativeKeys.has(key);
  });
  const summariesByKey = new Map(
    scopedSummaries
      .map(summary => [workoutSummaryCompletionKey(summary), summary] as const)
      .filter((entry): entry is [string, StoredWorkoutSummary] => !!entry[0]),
  );
  for (const completion of completions) {
    const key = serverCompletionKey(completion);
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
  if (totalHrMinutes > 0) {
    signals.push({
      key: 'hr-zones',
      label: 'Heart-rate zones',
      value: `${Math.round(hrTotals[1])}m Z2`,
      detail: `${Math.round(hrTotals[2] + hrTotals[3] + hrTotals[4])}m Z3+ across recent sessions`,
      icon: 'pulse-outline',
      color: '#EF4444',
    });
  }
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
  const reducedMotion = useReducedMotion();
  const height = useRef(new Animated.Value(0)).current;
  const prevTarget = useRef<number>(0);
  useEffect(() => {
    // Only run the draw-in when height changes — prevents re-triggering
    // on theme/pallette re-renders.
    if (prevTarget.current === targetHeight) return;
    prevTarget.current = targetHeight;
    if (reducedMotion) {
      height.setValue(targetHeight);
      return;
    }
    Animated.timing(height, {
      toValue: targetHeight,
      duration: 800,
      delay,
      useNativeDriver: false,
    }).start();
  }, [targetHeight, delay, height, reducedMotion]);
  return (
    <Animated.View style={[style, { height, overflow: 'hidden' }]}>
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(255,255,255,0.38)', 'rgba(255,255,255,0.08)', 'rgba(0,0,0,0.10)']}
        locations={[0, 0.45, 1]}
        start={{ x: 0.18, y: 0 }}
        end={{ x: 0.82, y: 1 }}
        style={StyleSheet.absoluteFillObject}
      />
    </Animated.View>
  );
}

function AnimatedProgressFill({
  pct,
  color,
  style,
  delay = 0,
  minPct = 0,
  duration = TIMING_SMOOTH.duration,
}: {
  pct: number;
  color: string;
  style?: any;
  delay?: number;
  minPct?: number;
  duration?: number;
}) {
  const reducedMotion = useReducedMotion();
  const numericPct = Number.isFinite(pct) ? pct : 0;
  const targetPct = numericPct <= 0 ? 0 : Math.max(minPct, Math.min(100, numericPct));
  const width = useRef(new Animated.Value(reducedMotion ? targetPct : 0)).current;

  useEffect(() => {
    if (reducedMotion) {
      width.setValue(targetPct);
      return;
    }
    Animated.timing(width, {
      toValue: targetPct,
      duration,
      delay,
      easing: TIMING_SMOOTH.easing,
      useNativeDriver: false,
    }).start();
  }, [delay, duration, reducedMotion, targetPct, width]);

  const animatedWidth = width.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });

  return (
    <Animated.View
      style={[
        style,
        {
          width: animatedWidth,
          backgroundColor: color,
          overflow: 'hidden',
        },
      ]}>
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(255,255,255,0.36)', 'rgba(255,255,255,0.07)', 'rgba(0,0,0,0.08)']}
        locations={[0, 0.48, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={StyleSheet.absoluteFillObject}
      />
    </Animated.View>
  );
}

type ThemeColors = ReturnType<typeof getTheme>['colors'];

function ProgressCardWash({
  color,
  secondaryColor,
  intensity = 'soft',
  cornerRadius = radius.lg,
}: {
  color: string;
  secondaryColor?: string;
  intensity?: 'soft' | 'medium' | 'strong';
  cornerRadius?: number;
}) {
  const primaryAlpha = intensity === 'strong' ? '28' : intensity === 'medium' ? '1E' : '14';
  const secondaryAlpha = intensity === 'strong' ? '1C' : intensity === 'medium' ? '14' : '0C';
  return (
    <LinearGradient
      pointerEvents="none"
      colors={[`${color}${primaryAlpha}`, `${secondaryColor ?? color}${secondaryAlpha}`, 'rgba(255,255,255,0)']}
      locations={[0, 0.52, 1]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[StyleSheet.absoluteFillObject, { borderRadius: cornerRadius }]}
    />
  );
}

function AnimatedHealthSheen({
  delay = 0,
  opacity = 0.34,
  repeat = true,
  style,
}: {
  delay?: number;
  opacity?: number;
  repeat?: boolean;
  style?: any;
}) {
  // Sliding "sheen" sweep removed per design. Kept as a no-op so the existing
  // call sites stay stable; static layers and the pulse glyph remain.
  return null;
}

function HealthPulseGlyph({
  iconName,
  color,
  iconSize = 16,
  delay = 0,
  style,
}: {
  iconName: ComponentProps<typeof Ionicons>['name'];
  color: string;
  iconSize?: number;
  delay?: number;
  style?: any;
}) {
  const reducedMotion = useReducedMotion();
  const pulse = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;

  useEffect(() => {
    if (reducedMotion) {
      pulse.setValue(1);
      return;
    }
    pulse.setValue(0);
    const animation = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1900,
          easing: TIMING_SMOOTH.easing,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [delay, pulse, reducedMotion]);

  const ringOpacity = pulse.interpolate({
    inputRange: [0, 0.72, 1],
    outputRange: [0.3, 0.08, 0],
  });
  const ringScale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.88, 1.55],
  });
  const iconScale = pulse.interpolate({
    inputRange: [0, 0.42, 1],
    outputRange: [1, 1.08, 1],
  });

  return (
    <View style={[style, healthMotionStyles.pulseGlyph]}>
      {!reducedMotion && (
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFillObject,
            healthMotionStyles.pulseRing,
            {
              borderColor: color,
              opacity: ringOpacity,
              transform: [{ scale: ringScale }],
            },
          ]}
        />
      )}
      <Animated.View style={{ transform: [{ scale: iconScale }] }}>
        <Ionicons name={iconName} size={iconSize} color={color} />
      </Animated.View>
    </View>
  );
}

const healthMotionStyles = StyleSheet.create({
  sheen: {
    position: 'absolute',
    top: -34,
    bottom: -34,
    width: 88,
  },
  pulseGlyph: {
    position: 'relative',
    overflow: 'visible',
  },
  pulseRing: {
    borderRadius: 999,
    borderWidth: 1,
  },
});

function HealthDataImageCard({
  title,
  subtitle,
  badge,
  iconName = 'heart-outline',
  imageUri = HEALTH_DATA_READY_IMAGE,
  children,
  tc,
  styles,
}: {
  title: string;
  subtitle: string;
  badge?: string;
  iconName?: ComponentProps<typeof Ionicons>['name'];
  imageUri?: string;
  children: ReactNode;
  tc: ThemeColors;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={[styles.vitalsCard, styles.healthDataImageCard]}>
      <ImageBackground
        source={{ uri: imageUri }}
        resizeMode="cover"
        imageStyle={styles.healthDataHeroImage}
        style={styles.healthDataHero}>
        <LinearGradient
          colors={['rgba(0,0,0,0.04)', 'rgba(0,0,0,0.58)']}
          style={StyleSheet.absoluteFill}
        />
        <LinearGradient
          pointerEvents="none"
          colors={[tc.primary + '54', '#14B8A62E', 'rgba(0,0,0,0)']}
          locations={[0, 0.46, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <AnimatedHealthSheen delay={260} opacity={0.46} style={styles.healthDataHeroSheen} />
        <View style={styles.healthDataHeroMeta}>
          <HealthPulseGlyph iconName={iconName} iconSize={16} color="#FFFFFF" style={styles.healthDataHeroIcon} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.healthDataHeroEyebrow} numberOfLines={1}>Health signals</Text>
            <Text style={styles.healthDataHeroTitle} numberOfLines={1}>{title}</Text>
            <Text style={styles.healthDataHeroSubtitle} numberOfLines={2}>{subtitle}</Text>
          </View>
          {badge ? (
            <View style={styles.healthDataHeroBadge}>
              <Text style={styles.healthDataHeroBadgeText} numberOfLines={1}>{badge}</Text>
            </View>
          ) : null}
        </View>
      </ImageBackground>
      <View style={styles.healthDataContent}>
        <ProgressCardWash color={tc.primary} secondaryColor="#14B8A6" intensity="soft" cornerRadius={0} />
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(255,255,255,0.08)', 'rgba(255,255,255,0)', tc.primary + '10']}
          locations={[0, 0.42, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        {children}
      </View>
    </View>
  );
}

type RadarMetric = {
  key: string;
  label: string;
  shortLabel: string;
  value: number | null;
  detail: string;
  rawValue?: string | number;
  targetLabel?: string;
  status?: 'strong' | 'ok' | 'focus' | 'high' | 'unknown';
  reason?: string;
  isEstimate?: boolean;
};

type RadarAxis = {
  key: string;
  label: string;
  score: number;
  rawValue?: string | number;
  targetLabel?: string;
  status?: 'strong' | 'ok' | 'focus' | 'high' | 'unknown';
  reason?: string;
  isEstimate?: boolean;
};

type RadarInsight = {
  strongest?: RadarAxis;
  focus?: RadarAxis;
  enoughData: boolean;
};

function clampRadarScore(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function averageRadarScore(values: Array<number | null | undefined>): number | null {
  const valid = values
    .map(value => clampRadarScore(value))
    .filter((value): value is number => value != null);
  if (valid.length === 0) return null;
  return Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length);
}

function radarStatusForScore(score: number | null | undefined, strongAt = 80, okAt = 55): RadarMetric['status'] {
  if (score == null) return 'unknown';
  if (score >= strongAt) return 'strong';
  if (score >= okAt) return 'ok';
  return 'focus';
}

function radarAxesFromMetrics(metrics: RadarMetric[]): RadarAxis[] {
  return metrics
    .map((metric): RadarAxis | null => {
      const score = clampRadarScore(metric.value);
      if (score == null) return null;
      return {
        key: metric.key,
        label: metric.label,
        score,
        rawValue: metric.rawValue,
        targetLabel: metric.targetLabel,
        status: metric.status ?? radarStatusForScore(score),
        reason: metric.reason ?? metric.detail,
        isEstimate: metric.isEstimate,
      } satisfies RadarAxis;
    })
    .filter((axis): axis is RadarAxis => axis != null);
}

function meaningfulRadarAxes(metrics: RadarMetric[]): RadarAxis[] {
  return radarAxesFromMetrics(metrics).filter(axis => axis.status !== 'unknown');
}

function averageMeaningfulRadarScore(metrics: RadarMetric[]): number | null {
  return averageRadarScore(meaningfulRadarAxes(metrics).map(axis => axis.score));
}

function deriveRadarInsights(
  axes: RadarAxis[],
  options: { minMeaningfulAxes?: number } = {},
): RadarInsight {
  const minMeaningfulAxes = options.minMeaningfulAxes ?? 3;
  const meaningful = axes.filter(axis => Number.isFinite(axis.score) && axis.status !== 'unknown');
  const enoughData = meaningful.length >= minMeaningfulAxes;
  if (meaningful.length === 0) return { enoughData: false };

  const hasReasonRank = (axis: RadarAxis) => axis.reason && axis.reason.trim().length > 0 ? 1 : 0;
  const focusRank = (axis: RadarAxis) => {
    if (axis.status === 'focus' || axis.status === 'high') return 3;
    if (axis.status === 'ok') return 2;
    if (axis.isEstimate) return 0;
    return 1;
  };

  const strongest = [...meaningful].sort((a, b) =>
    b.score - a.score
      || hasReasonRank(b) - hasReasonRank(a)
      || (a.isEstimate === b.isEstimate ? 0 : a.isEstimate ? 1 : -1)
  )[0];
  const focus = [...meaningful].sort((a, b) => {
    const scoreDelta = a.score - b.score;
    if (Math.abs(scoreDelta) > 8) return scoreDelta;
    return focusRank(b) - focusRank(a)
      || hasReasonRank(b) - hasReasonRank(a)
      || scoreDelta;
  })[0];

  return { strongest, focus, enoughData };
}

function cardioVo2Score(vo2Max: number | null | undefined): number | null {
  const value = Number(vo2Max);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value >= 50 ? 95 : value >= 42 ? 80 : value >= 35 ? 65 : value >= 28 ? 45 : 25;
}

function cardioEasyHardScore(easySharePct: number | null | undefined): number | null {
  const share = Number(easySharePct);
  if (!Number.isFinite(share)) return null;
  return share >= 65 && share <= 90 ? 85
    : share >= 50 && share <= 95 ? 70
      : 45;
}

function radarScoreColor(score: number | null, tc: ThemeColors): string {
  if (score == null) return tc.textMuted;
  if (score >= 85) return tc.success;
  if (score >= 65) return tc.primary;
  if (score >= 45) return tc.warning;
  return tc.error;
}

function radarScoreLabel(score: number | null, fallback = 'Building map'): string {
  if (score == null) return fallback;
  if (score >= 85) return 'Strong coverage';
  if (score >= 65) return 'Good base';
  if (score >= 45) return 'Building';
  return 'Needs attention';
}

function RadarMap({
  metrics,
  size,
  color,
  trackColor,
  axisColor,
  labelColor,
}: {
  metrics: RadarMetric[];
  size: number;
  color: string;
  trackColor: string;
  axisColor: string;
  labelColor: string;
}) {
  const safeMetrics = metrics.length >= 3 ? metrics : [
    ...metrics,
    ...Array.from({ length: 3 - metrics.length }, (_, index) => ({
      key: `empty-${index}`,
      label: '',
      shortLabel: '',
      value: null,
      detail: '',
    })),
  ];
  const center = size / 2;
  const radius = size * 0.31;
  const labelRadius = size * 0.43;
  const angleFor = (index: number) => -Math.PI / 2 + (Math.PI * 2 * index) / safeMetrics.length;
  const pointFor = (index: number, pct: number, baseRadius = radius) => {
    const angle = angleFor(index);
    const distance = baseRadius * Math.max(0, Math.min(1, pct));
    return {
      x: center + Math.cos(angle) * distance,
      y: center + Math.sin(angle) * distance,
    };
  };
  const outerPoints = safeMetrics.map((_, index) => pointFor(index, 1));
  const reducedMotion = useReducedMotion();
  const revealAnim = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;
  const [revealProgress, setRevealProgress] = useState(reducedMotion ? 1 : 0);
  const revealKey = safeMetrics
    .map(metric => `${metric.key}:${clampRadarScore(metric.value) ?? 0}`)
    .join('|');

  useEffect(() => {
    const listener = revealAnim.addListener(({ value }) => {
      setRevealProgress(Math.max(0, Math.min(1, value)));
    });
    if (reducedMotion) {
      revealAnim.setValue(1);
      setRevealProgress(1);
      return () => revealAnim.removeListener(listener);
    }
    revealAnim.stopAnimation();
    revealAnim.setValue(0);
    setRevealProgress(0);
    Animated.timing(revealAnim, {
      toValue: 1,
      duration: 760,
      delay: 80,
      easing: TIMING_SMOOTH.easing,
      useNativeDriver: false,
    }).start();
    return () => revealAnim.removeListener(listener);
  }, [reducedMotion, revealAnim, revealKey]);

  const valuePoints = safeMetrics.map((metric, index) => pointFor(index, ((clampRadarScore(metric.value) ?? 0) / 100) * revealProgress));
  const polygonPoints = valuePoints.map(point => `${point.x},${point.y}`).join(' ');
  const gradientId = `radarFillGradient-${size}-${safeMetrics.length}-${color.replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Defs>
          <SvgLinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0%" stopColor={color} stopOpacity="0.34" />
            <Stop offset="58%" stopColor={color} stopOpacity="0.18" />
            <Stop offset="100%" stopColor={color} stopOpacity="0.06" />
          </SvgLinearGradient>
        </Defs>
        {[0.33, 0.66, 1].map(ring => (
          <Polygon
            key={`ring-${ring}`}
            points={safeMetrics.map((_, index) => {
              const p = pointFor(index, ring);
              return `${p.x},${p.y}`;
            }).join(' ')}
            fill="none"
            stroke={trackColor}
            strokeWidth={1}
            opacity={ring === 1 ? 0.9 : 0.55}
          />
        ))}
        {outerPoints.map((point, index) => (
          <Line
            key={`axis-${safeMetrics[index].key}`}
            x1={center}
            y1={center}
            x2={point.x}
            y2={point.y}
            stroke={axisColor}
            strokeWidth={1}
            opacity={0.5}
          />
        ))}
        <Polygon
          points={polygonPoints}
          fill={`url(#${gradientId})`}
          stroke={color}
          strokeWidth={2}
          strokeLinejoin="round"
          opacity={0.36 + revealProgress * 0.64}
        />
        {valuePoints.map((point, index) => (
          <Circle
            key={`dot-${safeMetrics[index].key}`}
            cx={point.x}
            cy={point.y}
            r={3.2}
            fill={color}
            stroke={trackColor}
            strokeWidth={1}
            opacity={0.22 + revealProgress * 0.78}
          />
        ))}
        {safeMetrics.map((metric, index) => {
          const angle = angleFor(index);
          const x = center + Math.cos(angle) * labelRadius;
          const y = center + Math.sin(angle) * labelRadius + 3;
          return (
            <SvgText
              key={`label-${metric.key}`}
              x={x}
              y={y}
              fill={labelColor}
              fontSize={8.5}
              fontWeight="800"
              textAnchor="middle"
            >
              {metric.shortLabel}
            </SvgText>
          );
        })}
      </Svg>
    </View>
  );
}

function TrendsRadarCard({
  testID,
  title,
  subtitle,
  score,
  metrics,
  icon,
  color,
  detail,
  compact = false,
  onPress,
  styles,
  tc,
}: {
  testID: string;
  title: string;
  subtitle: string;
  score: number | null;
  metrics: RadarMetric[];
  icon: ComponentProps<typeof Ionicons>['name'];
  color: string;
  detail: string;
  compact?: boolean;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
  tc: ThemeColors;
}) {
  const chartSize = compact ? 122 : 188;
  const axes = radarAxesFromMetrics(metrics);
  const insight = deriveRadarInsights(axes);
  // Header pill shows a tier word, not the raw 0-100 — the number still
  // backs the accessibility label and the tap-through detail view. Keeps
  // the Trends tab from stacking competing numerals.
  const scoreTier = score == null ? '—'
    : score >= 80 ? 'Strong'
    : score >= 60 ? 'Solid'
    : score >= 40 ? 'Building'
    : 'Early';
  return (
    <TouchableOpacity
      testID={testID}
      activeOpacity={0.86}
      accessibilityRole="button"
      accessibilityLabel={`${title}: ${score == null ? 'building' : `${score} out of 100`}. ${detail}`}
      onPress={onPress}
      style={[
        styles.trendsRadarCard,
        compact && styles.trendsRadarCardCompact,
        { borderColor: color + '55' },
      ]}
    >
      <ProgressCardWash color={color} secondaryColor={tc.primary} intensity="medium" />
      <View style={[styles.trendsRadarHeader, compact && styles.trendsRadarHeaderCompact]}>
        <View style={[
          styles.trendsRadarIcon,
          compact && styles.trendsRadarIconCompact,
          { backgroundColor: color + '20' },
        ]}>
          <Ionicons name={icon} size={compact ? 14 : 16} color={color} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.trendsRadarEyebrow} numberOfLines={1}>{subtitle}</Text>
          <Text
            style={[styles.trendsRadarTitle, compact && styles.trendsRadarTitleCompact]}
            numberOfLines={2}>
            {title}
          </Text>
        </View>
        <View style={[
          styles.trendsRadarScorePill,
          compact && styles.trendsRadarScorePillCompact,
          { backgroundColor: color + '16', borderColor: color + '45' },
        ]}>
          <Text style={[styles.trendsRadarScoreText, compact && styles.trendsRadarScoreTextCompact, { color }]} numberOfLines={1}>
            {scoreTier}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={15} color={tc.textMuted} />
      </View>
      <View style={styles.trendsRadarBody}>
        <View style={[styles.trendsRadarChartWrap, compact && styles.trendsRadarChartWrapCompact]}>
          <RadarMap
            metrics={metrics}
            size={chartSize}
            color={color}
            trackColor={tc.border}
            axisColor={tc.textMuted}
            labelColor={tc.textSecondary}
          />
        </View>
        {!compact ? (
          <>
            <View style={styles.trendsRadarInsightRow}>
              <View style={[styles.trendsRadarInsightChip, { borderColor: color + '44', backgroundColor: color + '10' }]}>
                <Text style={styles.trendsRadarInsightLabel}>Strongest</Text>
                <Text style={[styles.trendsRadarInsightValue, { color }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78}>
                  {insight.enoughData && insight.strongest ? insight.strongest.label : 'More data'}
                </Text>
              </View>
              <View style={[styles.trendsRadarInsightChip, { borderColor: tc.border, backgroundColor: tc.surfaceRaised }]}>
                <Text style={styles.trendsRadarInsightLabel}>Focus</Text>
                <Text style={[styles.trendsRadarInsightValue, { color: tc.textPrimary }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78}>
                  {insight.enoughData && insight.focus ? insight.focus.label : 'Keep logging'}
                </Text>
              </View>
            </View>
            {/* Inline "Show breakdown" toggle removed — tap the card/graph to
                open the full per-axis breakdown in the detail view. */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, marginTop: 10 }}>
              <Ionicons name="stats-chart-outline" size={12} color={tc.textMuted} />
              <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted }}>Tap for the full breakdown</Text>
            </View>
          </>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

function GoalEstimateMiniVisual({
  pct,
  color,
  mutedColor,
  trackColor,
  surfaceColor,
}: {
  pct: number;
  color: string;
  mutedColor: string;
  trackColor: string;
  surfaceColor: string;
}) {
  const safePct = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const endY = Math.max(13, Math.min(44, 45 - safePct * 0.28));
  const midY = Math.max(16, Math.min(43, endY + (safePct >= 75 ? 8 : safePct >= 55 ? 4 : -2)));
  const earlyY = Math.max(22, Math.min(46, midY + (safePct >= 55 ? 7 : 2)));
  const actualPoints = `8,46 34,${earlyY} 62,${midY} 94,${endY}`;

  return (
    <View style={{
      width: 118,
      height: 62,
      borderRadius: 12,
      backgroundColor: trackColor,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    }}>
      <Svg width={118} height={62} viewBox="0 0 118 62">
        <Line x1={9} y1={50} x2={108} y2={50} stroke={mutedColor} strokeWidth={1} opacity={0.16} />
        <Line
          x1={10}
          y1={44}
          x2={108}
          y2={17}
          stroke={mutedColor}
          strokeWidth={2}
          strokeDasharray="5 5"
          strokeLinecap="round"
          opacity={0.55}
        />
        <Polyline
          points={actualPoints}
          fill="none"
          stroke={color}
          strokeWidth={4}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <Circle cx={94} cy={endY} r={5} fill={color} stroke={surfaceColor} strokeWidth={2} />
      </Svg>
    </View>
  );
}

function GoalExecutionGraph({
  overview,
  width,
  color,
  tc,
  styles,
}: {
  overview: GoalExecutionOverview;
  width: number;
  color: string;
  tc: ThemeColors;
  styles: ReturnType<typeof createStyles>;
}) {
  const chartW = Math.round(width);
  const chartH = 156;
  const padL = 30;
  const padR = 14;
  const padT = 30;
  const padB = 26;
  const plotW = chartW - padL - padR;
  const plotH = chartH - padT - padB;
  const toY = (pct: number) => padT + plotH - (Math.max(0, Math.min(100, pct)) / 100) * plotH;
  const labelAnchor = (x: number): 'start' | 'middle' | 'end' => (
    x <= padL + 10 ? 'start'
    : x >= chartW - padR - 10 ? 'end'
    : 'middle'
  );
  const labelY = (y: number, offset = 9) => Math.max(11, y - offset);
  const renderPointValueLabel = (
    key: string,
    label: string,
    x: number,
    y: number,
    fill: string,
  ) => (
    <Fragment key={key}>
      <SvgText
        x={x}
        y={y}
        fontSize={9}
        fontWeight="800"
        fill={tc.surface}
        stroke={tc.surface}
        strokeWidth={3}
        textAnchor={labelAnchor(x)}>
        {label}
      </SvgText>
      <SvgText
        x={x}
        y={y}
        fontSize={9}
        fontWeight="800"
        fill={fill}
        textAnchor={labelAnchor(x)}>
        {label}
      </SvgText>
    </Fragment>
  );
  const points = overview.points.map((point, index) => {
    const x = padL + (overview.points.length > 1 ? (index / (overview.points.length - 1)) * plotW : plotW / 2);
    return {
      ...point,
      x,
      execY: point.executionPct == null ? null : toY(point.executionPct),
      secondaryY: point.secondaryPct == null ? null : toY(point.secondaryPct),
    };
  });
  const execPoints = points.filter(point => point.execY != null);
  const secondaryPoints = points.filter(point => point.secondaryY != null);
  const execLine = execPoints.map(point => `${point.x},${point.execY}`).join(' ');
  const secondaryLine = secondaryPoints.map(point => `${point.x},${point.secondaryY}`).join(' ');
  const baselineY = padT + plotH;
  const areaPoints = execPoints.length >= 2
    ? `${execLine} ${execPoints[execPoints.length - 1].x},${baselineY} ${execPoints[0].x},${baselineY}`
    : null;

  return (
    <View style={styles.goalExecutionGraph}>
      <View style={styles.goalExecutionGraphHeader}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.goalExecutionGraphTitle} numberOfLines={1}>{overview.graphTitle}</Text>
          <Text style={styles.goalExecutionGraphSubtitle} numberOfLines={2}>{overview.graphSubtitle}</Text>
        </View>
        <View style={styles.goalExecutionGraphMeta}>
          <Text style={[styles.goalExecutionGraphMetaText, { color }]} numberOfLines={1}>{overview.dayLabel}</Text>
          <Text style={styles.goalExecutionGraphMetaSub} numberOfLines={1}>{overview.timeLeftLabel}</Text>
        </View>
      </View>
      <View style={styles.goalExecutionLegend}>
        <View style={styles.goalExecutionLegendItem}>
          <View style={[styles.goalExecutionLegendLine, { backgroundColor: color }]} />
          <Text style={styles.goalExecutionLegendText}>Execution</Text>
        </View>
        <View style={styles.goalExecutionLegendItem}>
          <View style={[styles.goalExecutionLegendLine, { backgroundColor: overview.secondaryColor }]} />
          <Text style={styles.goalExecutionLegendText}>{overview.secondaryLabel}</Text>
        </View>
      </View>
      <View style={{ alignItems: 'center', marginTop: 6 }}>
        <Svg width={chartW} height={chartH}>
          <Defs>
            <SvgLinearGradient id="goalExecGraphArea" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0%" stopColor={color} stopOpacity={0.24} />
              <Stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </SvgLinearGradient>
          </Defs>
          {[0, 50, 100].map(value => {
            const y = toY(value);
            return (
              <Line
                key={`grid-${value}`}
                x1={padL}
                y1={y}
                x2={chartW - padR}
                y2={y}
                stroke={tc.border}
                strokeWidth={1}
                strokeDasharray={value === 0 ? undefined : '4 4'}
                opacity={value === 0 ? 0.8 : 0.55}
              />
            );
          })}
          {[0, 50, 100].map(value => (
            <SvgText key={`axis-${value}`} x={padL - 7} y={toY(value) + 4} fontSize={9} fill={tc.textMuted} textAnchor="end">
              {value}
            </SvgText>
          ))}
          {areaPoints && <Polygon points={areaPoints} fill="url(#goalExecGraphArea)" stroke="none" />}
          {execPoints.length >= 2 && (
            <Polyline
              points={execLine}
              fill="none"
              stroke={color}
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          {secondaryPoints.length >= 2 && (
            <Polyline
              points={secondaryLine}
              fill="none"
              stroke={overview.secondaryColor}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0.92}
            />
          )}
          {points.map(point => (
            <Fragment key={`week-${point.key}`}>
              {(() => {
                let execLabelY = point.execY == null ? null : labelY(point.execY);
                let secondaryLabelY = point.secondaryY == null ? null : labelY(point.secondaryY);
                if (execLabelY != null && secondaryLabelY != null && Math.abs(execLabelY - secondaryLabelY) < 11) {
                  if ((point.execY ?? 0) <= (point.secondaryY ?? 0)) {
                    execLabelY = labelY(point.execY ?? 0, 18);
                    secondaryLabelY = labelY(point.secondaryY ?? 0, 6);
                  } else {
                    secondaryLabelY = labelY(point.secondaryY ?? 0, 18);
                    execLabelY = labelY(point.execY ?? 0, 6);
                  }
                }
                return (
                  <>
                    {point.execY != null && execLabelY != null
                      ? renderPointValueLabel(`exec-label-${point.key}`, `${Math.round(point.executionPct ?? 0)}%`, point.x, execLabelY, color)
                      : null}
                    {point.secondaryY != null && secondaryLabelY != null && point.secondaryValue !== 'Need data'
                      ? renderPointValueLabel(`secondary-label-${point.key}`, point.secondaryValue, point.x, secondaryLabelY, overview.secondaryColor)
                      : null}
                  </>
                );
              })()}
              {point.execY != null && (
                <Circle
                  cx={point.x}
                  cy={point.execY}
                  r={point.key === execPoints[execPoints.length - 1]?.key ? 4.5 : 3.5}
                  fill={color}
                  stroke={tc.surface}
                  strokeWidth={1.5}
                />
              )}
              {point.secondaryY != null && (
                <Circle
                  cx={point.x}
                  cy={point.secondaryY}
                  r={3.5}
                  fill={overview.secondaryColor}
                  stroke={tc.surface}
                  strokeWidth={1.5}
                />
              )}
              <SvgText x={point.x} y={chartH - 6} fontSize={9} fill={tc.textMuted} textAnchor="middle">
                {point.label}
              </SvgText>
            </Fragment>
          ))}
        </Svg>
      </View>
    </View>
  );
}

function PulseOnChange({
  children,
  trigger,
  style,
}: {
  children: ReactNode;
  trigger: string | number | boolean | null | undefined;
  style?: any;
}) {
  const reducedMotion = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (reducedMotion) return;
    scale.setValue(0.98);
    Animated.spring(scale, {
      toValue: 1,
      damping: 14,
      stiffness: 220,
      mass: 0.8,
      useNativeDriver: true,
    }).start();
  }, [reducedMotion, scale, trigger]);

  return (
    <Animated.View style={[style, { transform: [{ scale }] }]}>
      {children}
    </Animated.View>
  );
}

function formatSleepHM(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours) || hours <= 0) return 'n/a';
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function formatBedtimeMinutes(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return 'cal.';
  const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const hour24 = Math.floor(normalized / 60);
  const min = normalized % 60;
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(min).padStart(2, '0')} ${hour24 >= 12 ? 'PM' : 'AM'}`;
}

function bedtimeWithinWindow(minutes: number | null | undefined, window: BedtimeWindow | null): boolean | null {
  if (minutes == null || !Number.isFinite(minutes) || !window) return null;
  const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const start = ((Math.round(window.startMinutes) % 1440) + 1440) % 1440;
  const end = ((Math.round(window.endMinutes) % 1440) + 1440) % 1440;
  return start <= end
    ? normalized >= start && normalized <= end
    : normalized >= start || normalized <= end;
}

function formatSleepTimelineTime(dateIso: string | null | undefined): string {
  if (!dateIso) return '--';
  const date = new Date(dateIso);
  if (!Number.isFinite(date.getTime())) return '--';
  const hour24 = date.getHours();
  const min = date.getMinutes();
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(min).padStart(2, '0')} ${hour24 >= 12 ? 'PM' : 'AM'}`;
}

type SleepConstellationNode = {
  key: string;
  label: string;
  value: string;
  pct: number;
  sentence: string;
  description: string;
  recommendation: string;
  color: string;
  needsAttention: boolean;
  /** Bedtime node only — the user's consistency-derived sleep window. */
  windowHint?: string;
};

type SleepContextInsight = {
  key: string;
  title: string;
  detail: string;
  action: string;
  icon: ComponentProps<typeof Ionicons>['name'];
  color: string;
  priority: number;
};

function sleepFactorPhrase(label: string, pct: number, value: string): string {
  const verb = pct >= 0.85
    ? 'helped your score'
    : pct >= 0.65
      ? 'mostly supported your score, with room to improve'
      : pct >= 0.45
        ? 'needs attention'
        : 'held your score back';
  return `${label} ${verb}. ${value}`;
}

function clampSleepRadarPct(value: number, floor = 0.05): number {
  if (!Number.isFinite(value)) return floor;
  return Math.max(floor, Math.min(1, value));
}

function idealRangePct(
  value: number | null | undefined,
  idealMin: number,
  idealMax: number,
  tolerance: number,
  floor = 0.08,
  missing = 0.45,
): number {
  if (value == null || !Number.isFinite(value) || tolerance <= 0) return missing;
  if (value >= idealMin && value <= idealMax) return 1;
  const distance = value < idealMin ? idealMin - value : value - idealMax;
  const curve = Math.exp(-(distance * distance) / (2 * tolerance * tolerance));
  return clampSleepRadarPct(floor + (1 - floor) * curve, floor);
}

function idealMinimumPct(
  value: number | null | undefined,
  idealMin: number,
  tolerance: number,
  floor = 0.08,
  missing = 0.45,
): number {
  if (value == null || !Number.isFinite(value) || tolerance <= 0) return missing;
  if (value >= idealMin) return 1;
  const distance = idealMin - value;
  const curve = Math.exp(-(distance * distance) / (2 * tolerance * tolerance));
  return clampSleepRadarPct(floor + (1 - floor) * curve, floor);
}

function buildSleepConstellationNodes(ss: SleepScore, bedtimeWindow: BedtimeWindow | null): SleepConstellationNode[] {
  const personalized = ss.mode === 'personalized';
  const max = {
    duration: personalized ? 28 : 32,
    efficiency: personalized ? 17 : 18,
    hrv: personalized ? 18 : 20,
    deepSleep: personalized ? 9 : 10,
    remSleep: personalized ? 4 : 5,
    healthFlags: personalized ? 5 : 10,
    regularity: 15,
  };
  const pillarPct = (value: number | null | undefined, maxValue: number, missing = 0.45) => {
    if (value == null || !Number.isFinite(value) || maxValue <= 0) return missing;
    return clampSleepRadarPct(value / maxValue);
  };
  // Percentage suffix is reserved for sleep-stage components (Deep, REM) and
  // shows that stage's share of total sleep — NOT the calculation weight.
  const stageShareLabel = (label: string, stageHours: number) => {
    if (ss.duration <= 0 || stageHours <= 0) return label;
    return `${label} (${Math.round((stageHours / ss.duration) * 100)}%)`;
  };
  const durationPct = idealRangePct(ss.duration, 7, 9, 0.9);
  const efficiencyPct = idealRangePct(ss.efficiency, 0.92, 1, 0.075);
  const hrvPct = pillarPct(ss.pillars.hrv, max.hrv, ss.hrvAvg != null ? 0.30 : 0.40);
  const deepPct = ss.stages.deep > 0
    ? idealMinimumPct(ss.stages.deep, 1.5, 0.45)
    : pillarPct(ss.pillars.deepSleep ?? null, max.deepSleep, 0.45);
  const remPct = ss.stages.rem > 0
    ? idealRangePct(ss.stages.rem / Math.max(0.1, ss.duration), 0.18, 0.25, 0.06)
    : pillarPct(ss.pillars.remSleep ?? null, max.remSleep, 0.45);
  const hasVitals = ss.restingHeartRate != null || ss.respiratoryRate != null || ss.oxygenSaturation != null;
  const vitalsPct = hasVitals ? pillarPct(ss.pillars.healthFlags, max.healthFlags) : 0.45;
  const hasRegularityScore = ss.pillars.regularity != null;
  const regularityPct = hasRegularityScore ? pillarPct(ss.pillars.regularity, max.regularity) : 0.72;
  const efficiencyValue = ss.efficiency != null ? `${Math.round(ss.efficiency * 100)}%` : 'n/a';
  const bedtimeValue = formatBedtimeMinutes(ss.bedtimeMinutes);
  const bedtimeInWindow = bedtimeWithinWindow(ss.bedtimeMinutes, bedtimeWindow);
  const bedtimeSentence = hasRegularityScore
    ? ss.bedtimeMinutes != null
      ? bedtimeInWindow === true
        ? `Bedtime was around ${bedtimeValue}, inside your target window.`
        : bedtimeInWindow === false
          ? `Bedtime was around ${bedtimeValue}, outside your target window.`
          : `Bedtime was around ${bedtimeValue}.`
      : 'Bedtime consistency was included in this score.'
    : 'Bedtime consistency is still calibrating.';
  // Consistency-derived window — the full-credit bedtime target for this user,
  // surfaced once there are enough nights to be meaningful.
  const bedtimeWindowHint = bedtimeWindow
    ? `Target window: ${formatBedtimeMinutes(bedtimeWindow.startMinutes)} - ${formatBedtimeMinutes(bedtimeWindow.endMinutes)}`
    : undefined;
  const vitalsValue = ss.restingHeartRate != null
    ? `${ss.restingHeartRate} bpm`
    : ss.respiratoryRate != null
      ? `${ss.respiratoryRate}/min`
      : ss.oxygenSaturation != null
        ? `${ss.oxygenSaturation}%`
        : 'n/a';
  // Awake-time node. `ss.stages.awake` is hours awake mid-sleep (after
  // first falling asleep). 30+ minutes meaningfully fragments recovery,
  // so the pct curve rewards <20m and penalizes >45m.
  const awakeMinutes = Math.max(0, Math.round((ss.stages.awake ?? 0) * 60));
  const hasAwakeData = ss.stages.awake > 0 || ss.pillars.awakeFragmentation != null;
  const awakePct = hasAwakeData
    ? awakeMinutes <= 15
      ? 1
      : awakeMinutes <= 30
        ? 0.78
        : awakeMinutes <= 45
          ? 0.55
          : awakeMinutes <= 75
            ? 0.35
            : 0.18
    : 0.45;
  const awakeValue = hasAwakeData ? `${awakeMinutes}m` : 'n/a';
  const awakeSentence = hasAwakeData
    ? `You were awake about ${awakeMinutes} min after first falling asleep.`
    : 'Wake-time data was unavailable.';
  return [
    {
      key: 'duration',
      label: 'Dur.',
      value: formatSleepHM(ss.duration),
      pct: durationPct,
      sentence: sleepFactorPhrase('Duration', durationPct, `You slept ${formatSleepHM(ss.duration)}.`),
      description: 'Total time asleep last night. Most adults recover best in a 7–9 hour window. Too little caps recovery; chronic oversleep can signal under-recovery.',
      recommendation: durationPct < 0.65
        ? 'Protect the sleep window first: move the next alarm or bedtime enough to create 7+ hours in bed, then keep wake time steady tomorrow.'
        : 'Keep this sleep window consistent; duration is the foundation the other recovery markers sit on.',
      color: '#38BDF8',
      needsAttention: durationPct < 0.65,
    },
    {
      key: 'efficiency',
      label: 'Eff.',
      value: efficiencyValue,
      pct: efficiencyPct,
      sentence: sleepFactorPhrase('Efficiency', efficiencyPct, ss.efficiency != null ? `Sleep efficiency was ${efficiencyValue}.` : 'Sleep efficiency was unavailable.'),
      description: 'Share of time in bed that you were actually asleep. High efficiency (90%+) means you fell asleep quickly and stayed asleep — a strong recovery signal.',
      recommendation: efficiencyPct < 0.65
        ? 'Tonight, bias toward a cool, dark room, lighter late fluids, and a slower final hour. If caffeine or alcohol was logged late, move it earlier first.'
        : 'Repeat the same wind-down and room setup; efficiency is supporting the score.',
      color: '#14B8A6',
      needsAttention: efficiencyPct < 0.65,
    },
    {
      key: 'hrv',
      label: 'HRV',
      value: ss.hrvAvg != null ? `${ss.hrvAvg} ms` : 'n/a',
      pct: hrvPct,
      sentence: sleepFactorPhrase('HRV', hrvPct, ss.hrvAvg != null ? `HRV averaged ${ss.hrvAvg} ms.` : 'HRV was unavailable.'),
      description: 'Heart rate variability overnight. Higher HRV reflects a relaxed nervous system and stronger recovery. We compare against your own recent baseline once enough nights are logged.',
      recommendation: hrvPct < 0.65
        ? 'Treat low HRV as a recovery-pressure signal: keep hard training conservative today and look for logged triggers such as late alcohol, large meals, illness, or stress.'
        : 'HRV is supporting recovery; keep the same meal timing, caffeine cutoff, and training rhythm when possible.',
      color: '#A78BFA',
      needsAttention: hrvPct < 0.65,
    },
    {
      key: 'vitals',
      label: 'Vitals',
      value: vitalsValue,
      pct: vitalsPct,
      sentence: sleepFactorPhrase('Vitals', vitalsPct, ss.restingHeartRate != null ? `Resting heart rate was ${ss.restingHeartRate} bpm.` : 'Overnight vitals were unavailable.'),
      description: 'Overnight resting heart rate, respiratory rate, and SpO₂. Elevated values vs. your baseline can flag stress, illness, or under-recovery before they show up elsewhere.',
      recommendation: vitalsPct < 0.65
        ? 'Pair this with how you feel. If RHR or breathing is up, favor hydration, easy movement, and lower intensity rather than forcing max-effort work.'
        : 'Vitals look steady enough to support normal training decisions.',
      color: '#F97316',
      needsAttention: vitalsPct < 0.65,
    },
    {
      key: 'deep',
      label: stageShareLabel('Deep', ss.stages.deep),
      value: formatSleepHM(ss.stages.deep),
      pct: deepPct,
      sentence: sleepFactorPhrase('Deep sleep', deepPct, `Deep sleep was ${formatSleepHM(ss.stages.deep)}.`),
      description: 'Slow-wave sleep — when growth hormone peaks and the body does its heaviest physical repair. Typically 13–23% of total sleep in healthy adults.',
      recommendation: deepPct < 0.65
        ? 'Prioritize the first half of the night: consistent bedtime, cool room, and no large meals or alcohol close to bed.'
        : 'Deep sleep is doing its job; keep the early-night routine stable.',
      color: '#6366F1',
      needsAttention: deepPct < 0.65,
    },
    {
      key: 'rem',
      label: stageShareLabel('REM', ss.stages.rem),
      value: formatSleepHM(ss.stages.rem),
      pct: remPct,
      sentence: sleepFactorPhrase('REM sleep', remPct, `REM sleep was ${formatSleepHM(ss.stages.rem)}.`),
      description: 'Dreaming stage — central to memory consolidation, learning, and emotional regulation. Most REM happens in the last third of the night, so cut-short sleep hits REM hardest.',
      recommendation: remPct < 0.65
        ? 'Give the last third of the night room to happen: avoid cutting sleep short and move alcohol/caffeine earlier.'
        : 'REM is in a useful range; keep protecting the back half of the night.',
      color: '#EC4899',
      needsAttention: remPct < 0.65,
    },
    {
      key: 'awake',
      label: 'Awake',
      value: awakeValue,
      pct: awakePct,
      sentence: sleepFactorPhrase('Awake time', awakePct, awakeSentence),
      description: 'Minutes awake after first falling asleep. Brief wake-ups are normal; sustained fragmentation (30+ min) blocks deep / REM cycles and undercuts recovery.',
      recommendation: awakePct < 0.55
        ? 'For tonight, check the practical disruptors first: room temperature, light, late caffeine/alcohol, big fluids, and heavy food close to bed.'
        : 'Wake time stayed controlled; keep the same environment and late-evening routine.',
      color: '#94A3B8',
      needsAttention: awakePct < 0.55,
    },
    {
      key: 'regularity',
      label: 'Bedtime',
      value: bedtimeValue,
      pct: regularityPct,
      sentence: hasRegularityScore ? sleepFactorPhrase('Bedtime consistency', regularityPct, bedtimeSentence) : bedtimeSentence,
      description: 'How close last night\'s bedtime was to your recent average. A steady schedule keeps your circadian rhythm dialed in, which improves sleep depth and morning alertness.',
      recommendation: hasRegularityScore && regularityPct < 0.65
        ? 'Nudge bedtime back toward the target window tonight rather than making a huge one-night correction.'
        : 'Keep bedtime anchored near this window; regularity makes the score more predictable.',
      color: '#F59E0B',
      needsAttention: hasRegularityScore && regularityPct < 0.65,
      windowHint: bedtimeWindowHint,
    },
  ];
}

type TimedMealContext = {
  meal: MealHistoryEntry;
  consumedAt: Date;
  hoursBeforeSleep: number;
  calories: number;
  fatG: number;
  label: string;
};

const SLEEP_ALCOHOL_RX = /\b(wine|beer|ipa|lager|cocktail|vodka|whisk(?:e)?y|tequila|rum|gin|margarita|martini|seltzer|alcohol)\b/i;
const SLEEP_CAFFEINE_RX = /\b(coffee|espresso|latte|cold brew|cappuccino|americano|energy drink|pre[-\s]?workout|caffeine|matcha|black tea|green tea)\b/i;
const SLEEP_DECAF_RX = /\bdecaf|caffeine[-\s]?free\b/i;

function parseDateOrNull(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

function sleepStartDateForScore(ss: SleepScore, timeline?: SleepStageTimeline | null): Date | null {
  const fromTimeline = parseDateOrNull(timeline?.startDate);
  if (fromTimeline) return fromTimeline;
  if (ss.bedtimeMinutes == null || !Number.isFinite(ss.bedtimeMinutes)) return null;
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  if (ss.bedtimeMinutes >= 12 * 60) d.setDate(d.getDate() - 1);
  d.setMinutes(Math.round(ss.bedtimeMinutes));
  return d;
}

function sleepStartDateForHistoryPoint(point: ProgressSleepHistoryPoint): Date | null {
  if (!point.night || point.bedtimeMinutes == null || !Number.isFinite(point.bedtimeMinutes)) return null;
  const baseMs = parseDateKeyMs(point.night);
  if (!baseMs) return null;
  const d = new Date(baseMs);
  if (point.bedtimeMinutes >= 12 * 60) d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(Math.round(point.bedtimeMinutes));
  return d;
}

function mealConsumedAt(meal: MealHistoryEntry): Date | null {
  return parseDateOrNull(meal.consumed_at ?? meal.created_at ?? null);
}

function mealCalories(meal: MealHistoryEntry): number {
  const total = Number(meal.totals?.calories);
  if (Number.isFinite(total) && total > 0) return total;
  return (meal.items ?? []).reduce((sum, item) => sum + Math.max(0, Number(item.calories) || 0), 0);
}

function mealFat(meal: MealHistoryEntry): number {
  const total = Number(meal.totals?.fat_g);
  if (Number.isFinite(total) && total > 0) return total;
  return (meal.items ?? []).reduce((sum, item) => sum + Math.max(0, Number(item.fat_g) || 0), 0);
}

function mealLabel(meal: MealHistoryEntry): string {
  return String(meal.name || meal.meal_type || 'meal').trim() || 'meal';
}

function mealText(meal: MealHistoryEntry): string {
  return [
    meal.name,
    meal.meal_type,
    ...(meal.items ?? []).map(item => item.food_name),
  ].filter(Boolean).join(' ');
}

function mealHasAlcohol(meal: MealHistoryEntry): boolean {
  if ((meal.items ?? []).some(item => (item as any).alcohol === true)) return true;
  return SLEEP_ALCOHOL_RX.test(mealText(meal));
}

function mealHasCaffeine(meal: MealHistoryEntry): boolean {
  const text = mealText(meal);
  return !SLEEP_DECAF_RX.test(text) && SLEEP_CAFFEINE_RX.test(text);
}

function timedMealsBeforeSleep(meals: MealHistoryEntry[] | null | undefined, sleepStart: Date, maxHours: number): TimedMealContext[] {
  return (meals ?? [])
    .map((meal): TimedMealContext | null => {
      const consumedAt = mealConsumedAt(meal);
      if (!consumedAt) return null;
      const hoursBeforeSleep = (sleepStart.getTime() - consumedAt.getTime()) / 3600000;
      if (hoursBeforeSleep <= 0 || hoursBeforeSleep > maxHours) return null;
      return {
        meal,
        consumedAt,
        hoursBeforeSleep,
        calories: mealCalories(meal),
        fatG: mealFat(meal),
        label: mealLabel(meal),
      };
    })
    .filter((row): row is TimedMealContext => row != null)
    .sort((a, b) => a.hoursBeforeSleep - b.hoursBeforeSleep);
}

function formatBeforeSleep(hours: number): string {
  const totalMin = Math.max(1, Math.round(hours * 60));
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function lateMealPatternText(meals: MealHistoryEntry[] | null | undefined, sleepHistory: ProgressSleepHistoryPoint[] | null | undefined): string | null {
  const points = (sleepHistory ?? []).filter(point => point.score != null && point.score > 0);
  if (points.length < 6) return null;
  const lateScores: number[] = [];
  const otherScores: number[] = [];
  for (const point of points) {
    const sleepStart = sleepStartDateForHistoryPoint(point);
    if (!sleepStart || point.score == null) continue;
    const lateMeals = timedMealsBeforeSleep(meals, sleepStart, 3.5)
      .filter(meal => meal.calories >= 350 || meal.fatG >= 20);
    if (lateMeals.length > 0) lateScores.push(point.score);
    else otherScores.push(point.score);
  }
  if (lateScores.length < 2 || otherScores.length < 2) return null;
  const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const lateAvg = avg(lateScores);
  const otherAvg = avg(otherScores);
  const gap = otherAvg - lateAvg;
  if (gap < 5) return null;
  return `Across logged nights, sleep scores after late/heavy meals are averaging ${Math.round(gap)} pts lower.`;
}

function latestHardWorkoutBeforeSleep(
  sleepStart: Date,
  history: WorkoutSession[] | null | undefined,
  summaries: StoredWorkoutSummary[] | null | undefined,
): { label: string; hoursBeforeSleep: number } | null {
  const candidates: Array<{ label: string; endedAt: Date; hard: boolean }> = [];
  for (const session of history ?? []) {
    const endedAt = parseDateOrNull(session.endedAt ?? session.startedAt ?? session.date);
    if (!endedAt || session.skipped) continue;
    const manual = (session as any).manualActivity;
    const category = String(manual?.category ?? '').toLowerCase();
    const intensity = String(manual?.intensity ?? '').toLowerCase();
    const durationMin = Math.max(0, Number(session.durationSeconds ?? 0) / 60);
    candidates.push({
      label: String(session.focus || manual?.subtype || 'Workout'),
      endedAt,
      hard: intensity === 'hard' || (durationMin >= 20 && category !== 'recovery' && category !== 'mobility'),
    });
  }
  for (const summary of summaries ?? []) {
    const endedAt = parseDateOrNull(summary.endedAt ?? summary.startedAt ?? summary.date);
    if (!endedAt) continue;
    const category = String(summary.activityCategory ?? '').toLowerCase();
    candidates.push({
      label: String(summary.focus || 'Workout'),
      endedAt,
      hard: (summary.trainingScore ?? 0) >= 75 || ((summary.durationSeconds ?? 0) >= 20 * 60 && category !== 'recovery' && category !== 'mobility'),
    });
  }
  return candidates
    .map(candidate => ({
      label: candidate.label,
      hard: candidate.hard,
      hoursBeforeSleep: (sleepStart.getTime() - candidate.endedAt.getTime()) / 3600000,
    }))
    .filter(candidate => candidate.hard && candidate.hoursBeforeSleep > 0 && candidate.hoursBeforeSleep <= 1.5)
    .sort((a, b) => a.hoursBeforeSleep - b.hoursBeforeSleep)[0] ?? null;
}

function buildSleepContextInsights({
  sleepScore,
  sleepTimeline,
  sleepHistory,
  mealHistory,
  workoutHistory,
  workoutSummaries,
  nodes,
}: {
  sleepScore: SleepScore;
  sleepTimeline?: SleepStageTimeline | null;
  sleepHistory?: ProgressSleepHistoryPoint[] | null;
  mealHistory?: MealHistoryEntry[] | null;
  workoutHistory?: WorkoutSession[] | null;
  workoutSummaries?: StoredWorkoutSummary[] | null;
  nodes: SleepConstellationNode[];
}): SleepContextInsight[] {
  const sleepStart = sleepStartDateForScore(sleepScore, sleepTimeline);
  const hrvOff = nodes.find(n => n.key === 'hrv')?.needsAttention ?? false;
  const vitalsOff = nodes.find(n => n.key === 'vitals')?.needsAttention ?? false;
  const awakeOff = nodes.find(n => n.key === 'awake')?.needsAttention ?? false;
  const deepOff = nodes.find(n => n.key === 'deep')?.needsAttention ?? false;
  const remOff = nodes.find(n => n.key === 'rem')?.needsAttention ?? false;
  const stressSignal = hrvOff || vitalsOff || awakeOff;
  const insights: SleepContextInsight[] = [];

  if (sleepStart) {
    const mealsBeforeBed = timedMealsBeforeSleep(mealHistory, sleepStart, 8);
    const alcohol = mealsBeforeBed.find(row => row.hoursBeforeSleep <= 4 && mealHasAlcohol(row.meal));
    if (alcohol && (stressSignal || remOff || deepOff)) {
      insights.push({
        key: 'late-alcohol',
        title: 'Late alcohol is the strongest logged clue',
        detail: `${alcohol.label} was logged ${formatBeforeSleep(alcohol.hoursBeforeSleep)} before sleep. Alcohol can reduce REM, fragment sleep, and keep HR/RHR higher overnight, so it is a plausible contributor to this read.`,
        action: 'When recovery matters, skip alcohol or keep it well away from bedtime and pair it with food and water earlier in the evening.',
        icon: 'wine-outline',
        color: '#F97316',
        priority: 100,
      });
    }

    const caffeine = mealsBeforeBed.find(row => row.hoursBeforeSleep <= 8 && mealHasCaffeine(row.meal));
    if (caffeine && (awakeOff || remOff || sleepScore.duration < 7)) {
      insights.push({
        key: 'late-caffeine',
        title: 'Caffeine timing may explain the lighter night',
        detail: `${caffeine.label} was logged ${formatBeforeSleep(caffeine.hoursBeforeSleep)} before sleep. Caffeine sensitivity varies, but late intake commonly shortens or fragments sleep even when you still fall asleep.`,
        action: 'Try a 6-8 hour caffeine cutoff for a week; use the sleep score and HRV trend to see if your baseline rebounds.',
        icon: 'cafe-outline',
        color: '#A78BFA',
        priority: 92,
      });
    }

    const caloriesWindow = timedMealsBeforeSleep(mealHistory, sleepStart, 16)
      .reduce((sum, row) => sum + row.calories, 0);
    const largeLateMeal = mealsBeforeBed
      .filter(row => row.hoursBeforeSleep <= 3.5)
      .filter(row => row.calories >= 600 || row.fatG >= 25 || (caloriesWindow > 0 && row.calories / caloriesWindow >= 0.35))
      .sort((a, b) => (b.calories + b.fatG * 8) - (a.calories + a.fatG * 8))[0];
    if (largeLateMeal && (stressSignal || deepOff)) {
      const pattern = lateMealPatternText(mealHistory, sleepHistory);
      insights.push({
        key: 'large-late-meal',
        title: hrvOff || vitalsOff ? 'Large late meal likely pressured HRV' : 'Large late meal may have cost deep sleep',
        detail: `${largeLateMeal.label} (${Math.round(largeLateMeal.calories)} kcal) landed ${formatBeforeSleep(largeLateMeal.hoursBeforeSleep)} before bed. Heavy digestion close to sleep can raise overnight heart rate and make HRV look suppressed. ${pattern ?? 'This is a logged clue, not a diagnosis.'}`,
        action: 'Move the largest meal 3+ hours before bedtime. If you are hungry later, keep the snack smaller and easier to digest.',
        icon: 'restaurant-outline',
        color: '#14B8A6',
        priority: hrvOff || vitalsOff ? 95 : 82,
      });
    }

    const hardWorkout = latestHardWorkoutBeforeSleep(sleepStart, workoutHistory, workoutSummaries);
    if (hardWorkout && (awakeOff || hrvOff || vitalsOff)) {
      insights.push({
        key: 'late-hard-workout',
        title: 'Late hard training may have delayed downshift',
        detail: `${hardWorkout.label} ended ${formatBeforeSleep(hardWorkout.hoursBeforeSleep)} before sleep. Most evening exercise is fine, but vigorous work ending close to bed can keep core temperature and sympathetic drive elevated.`,
        action: 'Keep intense sessions at least 90 minutes from bedtime when possible; add an easy cooldown and a lower-light final hour.',
        icon: 'barbell-outline',
        color: '#EF4444',
        priority: 78,
      });
    }
  }

  if ((hrvOff || vitalsOff || awakeOff || deepOff) && (!mealHistory || mealHistory.length === 0)) {
    insights.push({
      key: 'meal-timing-missing',
      title: 'Meal timing is the missing context',
      detail: 'HRV and wake-time changes are easier to explain when dinner, caffeine, alcohol, and snack timing have timestamps.',
      action: 'For the next few nights, note the final meal or drink time so sleep dips have clearer context.',
      icon: 'time-outline',
      color: '#38BDF8',
      priority: 35,
    });
  }

  const unique = new Map<string, SleepContextInsight>();
  for (const insight of insights.sort((a, b) => b.priority - a.priority)) {
    if (!unique.has(insight.key)) unique.set(insight.key, insight);
  }
  return Array.from(unique.values()).slice(0, 3);
}

const sleepConstellationStyles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 0,
    marginBottom: 12,
    overflow: 'hidden',
  },
  hero: {
    height: 124,
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  heroSheen: {
    top: -38,
    bottom: -38,
    width: 72,
  },
  heroImage: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  heroMeta: {
    padding: 13,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  heroEyebrow: { color: '#FFFFFF', fontSize: 9, lineHeight: 12, fontWeight: '900', textTransform: 'uppercase', ...overPhotoTextShadow },
  heroTitle: { color: '#FFFFFF', fontSize: 20, lineHeight: 24, fontWeight: '900', marginTop: 2, ...overPhotoTextShadow },
  heroSubtitle: { color: '#FFFFFF', fontSize: 11, lineHeight: 14, fontWeight: '800', opacity: 0.9, marginTop: 1, ...overPhotoTextShadow },
  heroScorePill: {
    minWidth: 42,
    minHeight: 34,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 9,
  },
  heroScoreValue: { color: '#FFFFFF', fontSize: 17, lineHeight: 20, fontWeight: '900' },
  heroButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.26)',
  },
  content: { padding: 14, paddingTop: 12 },
  center: {
    position: 'absolute',
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 7 },
    shadowOpacity: 0.14,
    shadowRadius: 14,
    elevation: 4,
    overflow: 'hidden',
  },
  scoreHalo: {
    position: 'absolute',
    borderWidth: 1,
    opacity: 0.2,
  },
  centerValue: { fontSize: 30, lineHeight: 33, fontWeight: '900', fontVariant: ['tabular-nums'] as any },
  centerLabel: { fontSize: 9, lineHeight: 11, fontWeight: '900', textTransform: 'uppercase' },
  radarTouch: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  stageCard: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 9,
    marginTop: 0,
    marginBottom: 10,
  },
  stageHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 8 },
  stageTitle: { fontSize: 10, lineHeight: 13, fontWeight: '900', textTransform: 'uppercase' },
  stageRange: { flexShrink: 1, fontSize: 10, lineHeight: 13, fontWeight: '800', textAlign: 'right' },
  stageGraphRow: { flexDirection: 'row', alignItems: 'center' },
  stageAxisLabel: { width: 38, height: 19, fontSize: 9, lineHeight: 19, fontWeight: '800' },
  stageGraph: { flex: 1, height: 76, position: 'relative', overflow: 'hidden' },
  stageGridLine: { position: 'absolute', left: 0, right: 0, height: 1 },
  stageBlock: { position: 'absolute', borderRadius: 4 },
  stageTicks: { marginLeft: 38, marginTop: 5, flexDirection: 'row', justifyContent: 'space-between' },
  stageTick: { fontSize: 9, fontWeight: '700' },
  pressureCard: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 10,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  pressureIcon: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressureEyebrow: { fontSize: 9, lineHeight: 12, fontWeight: '900', textTransform: 'uppercase' },
  pressureTitle: { fontSize: 12, lineHeight: 16, fontWeight: '900', marginTop: 1 },
  pressureDetail: { fontSize: 10.5, lineHeight: 14, fontWeight: '700', marginTop: 2 },
  pressureValue: { fontSize: 16, lineHeight: 20, fontWeight: '900', fontVariant: ['tabular-nums'] as any },
  readout: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  readoutLabel: { fontSize: 10, fontWeight: '900', textTransform: 'uppercase' },
  readoutText: { fontSize: 12, lineHeight: 17, marginTop: 2 },
  readoutWindow: { flexShrink: 1, fontSize: 11.5, lineHeight: 15, fontWeight: '800', marginTop: 5 },
  readoutDescription: { fontSize: 11, lineHeight: 16, marginTop: 6 },
  readoutValue: { fontSize: 18, fontWeight: '900', fontVariant: ['tabular-nums'] as any },
  insightList: { gap: 8, marginTop: 10 },
  insightRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 7 },
  insightText: { flex: 1, fontSize: 11, lineHeight: 15 },
  quickInsightList: { gap: 8, marginTop: 4 },
  quickInsightRow: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
  },
  quickInsightIcon: {
    width: 25,
    height: 25,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  quickInsightTitle: { fontSize: 11, lineHeight: 14, fontWeight: '900' },
  quickInsightText: { fontSize: 11.5, lineHeight: 16, marginTop: 2 },
  quickInsightAction: { fontSize: 10.5, lineHeight: 14, fontWeight: '800', marginTop: 3 },
  quickInsightButton: {
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 10,
    overflow: 'hidden',
  },
  quickInsightSheen: {
    top: -22,
    bottom: -22,
    width: 54,
  },
  quickInsightButtonHint: { fontSize: 10.5, lineHeight: 14, fontWeight: '700', marginTop: 2 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.58)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    maxHeight: '82%',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 20,
  },
  modalHandleTap: {
    minHeight: 18,
    paddingBottom: 14,
    justifyContent: 'flex-start',
  },
  modalHandle: {
    width: 42,
    height: 4,
    borderRadius: 999,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  modalIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalEyebrow: { fontSize: 10, lineHeight: 12, fontWeight: '900', textTransform: 'uppercase' },
  modalTitle: { fontSize: 18, lineHeight: 23, fontWeight: '900' },
  modalScroll: { maxHeight: 520 },
  modalMetricRow: { flexDirection: 'row', gap: 8 },
  modalMetric: {
    flex: 1,
    minHeight: 78,
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
  },
  modalMetricLabel: { fontSize: 9, lineHeight: 12, fontWeight: '900', textTransform: 'uppercase' },
  modalMetricValue: { fontSize: 21, lineHeight: 27, fontWeight: '900', marginTop: 4, fontVariant: ['tabular-nums'] as any },
  modalSection: { marginTop: 14 },
  modalSectionTitle: { fontSize: 10, lineHeight: 13, fontWeight: '900', textTransform: 'uppercase', marginBottom: 6 },
  modalBody: { fontSize: 13, lineHeight: 18 },
  modalWindowHint: { fontSize: 12, lineHeight: 16, fontWeight: '900', marginTop: 7 },
  modalMuted: { fontSize: 11.5, lineHeight: 16, marginTop: 12 },
  unavailableText: { fontSize: 12, lineHeight: 17, marginTop: 8 },
});

const SLEEP_STAGE_ROWS = [
  { stage: 'awake', label: 'Awake', color: '#F97316' },
  { stage: 'rem', label: 'REM', color: '#EC4899' },
  { stage: 'core', label: 'Core', color: '#38BDF8' },
  { stage: 'deep', label: 'Deep', color: '#6366F1' },
] as const;

function SleepStageTimelineChart({
  timeline,
  tc,
}: {
  timeline: SleepStageTimeline | null | undefined;
  tc: ReturnType<typeof getTheme>['colors'];
}) {
  if (!timeline || timeline.durationMinutes <= 0 || !Array.isArray(timeline.segments) || timeline.segments.length === 0) {
    return null;
  }
  const rowHeight = 19;
  const blockHeight = 11;
  const stageIndex = new Map(SLEEP_STAGE_ROWS.map((row, index) => [row.stage, index]));
  const colorFor = new Map(SLEEP_STAGE_ROWS.map(row => [row.stage, row.color]));
  const range = `${formatSleepTimelineTime(timeline.startDate)} - ${formatSleepTimelineTime(timeline.endDate)}`;

  return (
    <View style={[sleepConstellationStyles.stageCard, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}>
      <View style={sleepConstellationStyles.stageHeader}>
        <Text style={[sleepConstellationStyles.stageTitle, { color: tc.textPrimary }]}>Sleep stages</Text>
        <Text style={[sleepConstellationStyles.stageRange, { color: tc.textMuted }]} numberOfLines={1}>
          {range}
        </Text>
      </View>
      <View style={sleepConstellationStyles.stageGraphRow}>
        <View>
          {SLEEP_STAGE_ROWS.map(row => (
            <Text key={row.stage} style={[sleepConstellationStyles.stageAxisLabel, { color: tc.textMuted }]}>
              {row.label}
            </Text>
          ))}
        </View>
        <View style={sleepConstellationStyles.stageGraph}>
          {SLEEP_STAGE_ROWS.map((row, index) => (
            <View
              key={`grid-${row.stage}`}
              style={[
                sleepConstellationStyles.stageGridLine,
                {
                  top: index * rowHeight + rowHeight / 2,
                  backgroundColor: tc.border,
                  opacity: 0.42,
                },
              ]}
            />
          ))}
          {timeline.segments.map((segment, index) => {
            const row = stageIndex.get(segment.stage);
            if (row == null || segment.durationMinutes <= 0) return null;
            const leftPct = Math.max(0, Math.min(100, (segment.startOffsetMinutes / timeline.durationMinutes) * 100));
            const widthPct = Math.max(0.8, Math.min(100 - leftPct, (segment.durationMinutes / timeline.durationMinutes) * 100));
            return (
              <View
                key={`${segment.stage}-${index}-${segment.startOffsetMinutes}`}
                style={[
                  sleepConstellationStyles.stageBlock,
                  {
                    left: `${leftPct}%`,
                    width: `${widthPct}%`,
                    top: row * rowHeight + (rowHeight - blockHeight) / 2,
                    height: blockHeight,
                    backgroundColor: colorFor.get(segment.stage) ?? tc.textMuted,
                  },
                ]}
              />
            );
          })}
        </View>
      </View>
      <View style={sleepConstellationStyles.stageTicks}>
        <Text style={[sleepConstellationStyles.stageTick, { color: tc.textMuted }]}>{formatSleepTimelineTime(timeline.startDate)}</Text>
        <Text style={[sleepConstellationStyles.stageTick, { color: tc.textMuted }]}>{formatSleepTimelineTime(timeline.endDate)}</Text>
      </View>
    </View>
  );
}

function formatSleepPressureDuration(hours: number, capped: boolean): string {
  const total = Math.round(Math.max(0, Number(hours) || 0) * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  const suffix = capped ? '+' : '';
  if (h <= 0) return m > 0 ? `${m}m${suffix}` : 'Clear';
  return m > 0 ? `${h}h ${m}m${suffix}` : `${h}h${suffix}`;
}

function sleepPressureAccent(status: import('../services/api').SleepPressureStatus, tc: ReturnType<typeof getTheme>['colors']): string {
  if (status === 'high') return '#EF4444';
  if (status === 'moderate') return '#F59E0B';
  if (status === 'low') return '#38BDF8';
  if (status === 'clear') return tc.success ?? '#22C55E';
  return tc.textMuted;
}

function SleepPressureCard({
  sleepPressure,
  tc,
}: {
  sleepPressure: import('../services/api').SleepPressureResponse | null | undefined;
  tc: ReturnType<typeof getTheme>['colors'];
}) {
  if (!sleepPressure || sleepPressure.status === 'not_enough_data') return null;
  const color = sleepPressureAccent(sleepPressure.status, tc);
  const value = sleepPressure.status === 'clear'
    ? 'Clear'
    : formatSleepPressureDuration(sleepPressure.display_hours, sleepPressure.is_capped);
  const detail = sleepPressure.status === 'clear'
    ? `${sleepPressure.nights_count} nights · need ${formatSleepPressureDuration(sleepPressure.sleep_need_hours, false)}`
    : sleepPressure.detail;

  return (
    <View style={[sleepConstellationStyles.pressureCard, { borderColor: color + '30' }]}>
      <View style={[sleepConstellationStyles.pressureIcon, { backgroundColor: color + '18' }]}>
        <Ionicons name={sleepPressure.status === 'clear' ? 'battery-full-outline' : 'battery-half-outline'} size={16} color={color} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[sleepConstellationStyles.pressureEyebrow, { color: tc.textMuted }]}>Sleep gap</Text>
        <Text style={[sleepConstellationStyles.pressureTitle, { color }]} numberOfLines={1}>
          {sleepPressure.headline}
        </Text>
        <Text style={[sleepConstellationStyles.pressureDetail, { color: tc.textSecondary }]} numberOfLines={2}>
          {detail}
        </Text>
      </View>
      <Text style={[sleepConstellationStyles.pressureValue, { color }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
        {value}
      </Text>
    </View>
  );
}

function SleepScoreHalo({
  color,
  style,
}: {
  color: string;
  style: any;
}) {
  const reducedMotion = useReducedMotion();
  const pulse = useRef(new Animated.Value(reducedMotion ? 0.5 : 0)).current;

  useEffect(() => {
    if (reducedMotion) {
      pulse.setValue(0.5);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1800,
          easing: TIMING_SMOOTH.easing,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [pulse, reducedMotion]);

  const opacity = pulse.interpolate({
    inputRange: [0, 0.72, 1],
    outputRange: [0.22, 0.08, 0],
  });
  const scale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.94, 1.32],
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        sleepConstellationStyles.scoreHalo,
        style,
        {
          borderColor: color,
          opacity,
          transform: [{ scale }],
        },
      ]}
    />
  );
}

function SleepConstellationCard({
  sleepScore,
  sleepTimeline,
  bedtimeWindow,
  sleepHistory,
  sleepPressure,
  mealHistory,
  workoutHistory,
  workoutSummaries,
  tc,
  width,
  onInfo,
  onHistory,
  wearableLabel,
  platformLabel,
}: {
  sleepScore: SleepScore | null;
  sleepTimeline?: SleepStageTimeline | null;
  bedtimeWindow: BedtimeWindow | null;
  sleepHistory?: ProgressSleepHistoryPoint[] | null;
  sleepPressure?: import('../services/api').SleepPressureResponse | null;
  mealHistory?: MealHistoryEntry[] | null;
  workoutHistory?: WorkoutSession[] | null;
  workoutSummaries?: StoredWorkoutSummary[] | null;
  tc: ReturnType<typeof getTheme>['colors'];
  width: number;
  onInfo: () => void;
  onHistory?: () => void;
  wearableLabel: string;
  platformLabel: string;
}) {
  const nodes = useMemo(() => sleepScore ? buildSleepConstellationNodes(sleepScore, bedtimeWindow) : [], [sleepScore, bedtimeWindow]);
  const defaultNode = useMemo(
    () => nodes.length > 0 ? [...nodes].sort((a, b) => a.pct - b.pct)[0] : null,
    [nodes],
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [sleepInsightsOpen, setSleepInsightsOpen] = useState(false);
  useEffect(() => {
    if (defaultNode && !nodes.some(n => n.key === selectedKey)) setSelectedKey(defaultNode.key);
  }, [defaultNode, nodes, selectedKey]);
  const selected = nodes.find(n => n.key === selectedKey) ?? defaultNode;
  const detailNode = nodes.find(n => n.key === detailKey) ?? null;
  const contextInsights = useMemo(
    () => sleepScore ? buildSleepContextInsights({
      sleepScore,
      sleepTimeline,
      sleepHistory,
      mealHistory,
      workoutHistory,
      workoutSummaries,
      nodes,
    }) : [],
    [sleepScore, sleepTimeline, sleepHistory, mealHistory, workoutHistory, workoutSummaries, nodes],
  );
  const chartSize = Math.min(286, Math.max(220, Math.round(width - 112)));
  const center = { x: chartSize / 2, y: chartSize / 2 };
  const radarRadius = Math.round(chartSize * 0.25);
  const labelBoxWidth = Math.max(58, Math.min(70, Math.round(chartSize * 0.21)));
  const labelBoxHeight = 42; // touch target only — visible text is ~22px
  const labelTextHalfHeight = 12;
  const labelInset = 6;
  // Cap by visible text bounds (not touch-target) so we get real breathing
  // room between the ring and the labels. Floor enforces a minimum gap so
  // labels never sit on top of the outer ring at any chartSize.
  const labelRadius = Math.round(Math.max(
    radarRadius + labelTextHalfHeight + 12,
    Math.min(
      radarRadius + chartSize * 0.22,
      (chartSize - labelBoxWidth - labelInset * 2) / 2,
      (chartSize - labelTextHalfHeight * 2 - labelInset * 2) / 2,
    ),
  ));
  const centerSize = 68;
  const axisStep = nodes.length > 0 ? 360 / nodes.length : 0;
  const angleFor = (index: number) => -90 + index * axisStep;
  const polarPoint = (radius: number, index: number) => {
    const angle = (angleFor(index) * Math.PI) / 180;
    return {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    };
  };
  const pointText = (point: { x: number; y: number }) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
  const reducedMotion = useReducedMotion();
  const radarRevealAnim = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;
  const [radarRevealProgress, setRadarRevealProgress] = useState(reducedMotion ? 1 : 0);
  const radarRevealKey = nodes.map(node => `${node.key}:${node.pct.toFixed(3)}`).join('|');

  useEffect(() => {
    const listener = radarRevealAnim.addListener(({ value }) => {
      setRadarRevealProgress(Math.max(0, Math.min(1, value)));
    });
    if (reducedMotion || nodes.length === 0) {
      radarRevealAnim.setValue(1);
      setRadarRevealProgress(1);
      return () => radarRevealAnim.removeListener(listener);
    }
    radarRevealAnim.stopAnimation();
    radarRevealAnim.setValue(0);
    setRadarRevealProgress(0);
    Animated.timing(radarRevealAnim, {
      toValue: 1,
      duration: 860,
      delay: 120,
      easing: TIMING_SMOOTH.easing,
      useNativeDriver: false,
    }).start();
    return () => radarRevealAnim.removeListener(listener);
  }, [nodes.length, radarRevealAnim, radarRevealKey, reducedMotion]);

  const actualPoints = nodes.map((node, index) => pointText(polarPoint(radarRadius * node.pct * radarRevealProgress, index))).join(' ');
  const labelPoint = (index: number) => polarPoint(labelRadius, index);
  const scoreColor = sleepScore
    ? sleepScore.score >= 80 ? '#22C55E' : sleepScore.score >= 60 ? '#F59E0B' : '#EF4444'
    : tc.textMuted;
  const scoreInsights = Array.isArray(sleepScore?.insights) ? sleepScore.insights : [];
  const fallbackQuickInsight: SleepContextInsight | null = selected ? {
    key: `selected-${selected.key}`,
    title: selected.needsAttention ? `${selected.label} needs attention` : `${selected.label} is the top signal`,
    detail: selected.sentence,
    action: selected.recommendation,
    icon: selected.needsAttention ? 'alert-circle-outline' : 'checkmark-circle-outline',
    color: selected.color,
    priority: selected.needsAttention ? 50 : 10,
  } : scoreInsights[0] ? {
    key: 'score-insight',
    title: 'Sleep score note',
    detail: scoreInsights[0],
    action: 'Use the detailed attributes to decide whether tonight needs schedule, food timing, caffeine, or environment changes.',
    icon: 'moon-outline',
    color: scoreColor,
    priority: 10,
  } : null;
  const quickInsights = contextInsights.length > 0
    ? contextInsights
    : fallbackQuickInsight ? [fallbackQuickInsight] : [];
  const showStageTimelineInDetail = !!detailNode && ['deep', 'rem', 'awake'].includes(detailNode.key);

  return (
    <View testID="progress-today-sleep-constellation-card" style={[sleepConstellationStyles.card, { backgroundColor: tc.surface, borderColor: tc.border }]}>
      <ImageBackground
        source={SLEEP_SCORE_IMAGE}
        resizeMode="cover"
        imageStyle={sleepConstellationStyles.heroImage}
        style={sleepConstellationStyles.hero}>
        <LinearGradient
          colors={['rgba(0,0,0,0.02)', 'rgba(0,0,0,0.62)']}
          style={StyleSheet.absoluteFill}
        />
        <LinearGradient
          pointerEvents="none"
          colors={[scoreColor + '36', 'rgba(99,102,241,0.12)', 'rgba(0,0,0,0.24)']}
          locations={[0, 0.5, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <AnimatedHealthSheen
          delay={180}
          opacity={0.28}
          repeat={false}
          style={sleepConstellationStyles.heroSheen}
        />
        <View style={sleepConstellationStyles.heroMeta}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={sleepConstellationStyles.heroEyebrow}>Recovery signal</Text>
            <Text style={sleepConstellationStyles.heroTitle}>Sleep Score</Text>
            <Text style={sleepConstellationStyles.heroSubtitle} numberOfLines={1}>
              {sleepScore ? `${sleepScore.rating} · ideal-range radar` : 'Waiting for sleep data'}
            </Text>
          </View>
          {sleepScore ? (
            <View style={[sleepConstellationStyles.heroScorePill, { borderColor: scoreColor + 'AA', backgroundColor: scoreColor + '35' }]}>
              <AnimatedNumber
                value={sleepScore.score}
                from={0}
                animateOnMount={!reducedMotion}
                duration={760}
                style={sleepConstellationStyles.heroScoreValue}
              />
            </View>
          ) : null}
          {onHistory && (
            <TouchableOpacity onPress={onHistory} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={sleepConstellationStyles.heroButton}>
              <Ionicons name="time-outline" size={16} color="#FFFFFF" />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={onInfo} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={sleepConstellationStyles.heroButton}>
            <Ionicons name="information-circle-outline" size={18} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
      </ImageBackground>

      <View style={sleepConstellationStyles.content}>
        {sleepScore ? (
        <>
          <View style={{ width: chartSize, height: chartSize, alignSelf: 'center', marginTop: 2 }}>
            <Svg width={chartSize} height={chartSize} style={StyleSheet.absoluteFill}>
              {[0.34, 0.67, 1].map((fraction) => (
                <Circle
                  key={`ring-${fraction}`}
                  cx={center.x}
                  cy={center.y}
                  r={radarRadius * fraction}
                  fill="none"
                  stroke={fraction === 1 ? tc.textMuted : tc.border}
                  strokeWidth={fraction === 1 ? 1.4 : 1}
                  strokeDasharray={fraction === 1 ? undefined : '3 6'}
                  opacity={fraction === 1 ? 0.4 : 0.55}
                />
              ))}
              {nodes.map((node, index) => {
                const edge = polarPoint(radarRadius, index);
                return (
                  <Line
                    key={`line-${node.key}`}
                    x1={center.x}
                    y1={center.y}
                    x2={edge.x}
                    y2={edge.y}
                    stroke={node.color}
                    strokeWidth={1}
                    opacity={0.22}
                  />
                );
              })}
              <Polygon
                points={actualPoints}
                fill={scoreColor + '22'}
                stroke={scoreColor}
                strokeWidth={2.4}
                opacity={0.32 + radarRevealProgress * 0.64}
              />
              {nodes.map((node, index) => {
                const point = polarPoint(radarRadius * node.pct * radarRevealProgress, index);
                const selectedNode = selected?.key === node.key;
                return (
                  <Circle
                    key={`point-${node.key}`}
                    cx={point.x}
                    cy={point.y}
                    r={selectedNode ? 7 : 5.2}
                    fill={node.color}
                    stroke={tc.surface}
                    strokeWidth={selectedNode ? 3 : 2}
                    opacity={selectedNode ? Math.max(0.34, radarRevealProgress) : 0.18 + radarRevealProgress * 0.74}
                  />
                );
              })}
              {nodes.map((node, index) => {
                const label = labelPoint(index);
                const selectedNode = selected?.key === node.key;
                const attentionX = Math.max(8, Math.min(chartSize - 8, label.x + labelBoxWidth / 2 - 6));
                const attentionY = Math.max(8, Math.min(chartSize - 8, label.y - labelBoxHeight / 2 + 9));
                return (
                  <Fragment key={`label-${node.key}`}>
                    <SvgText
                      x={label.x}
                      y={label.y - 2}
                      fill={selectedNode ? node.color : tc.textMuted}
                      fontSize={8}
                      fontWeight="900"
                      textAnchor="middle"
                    >
                      {node.label}
                    </SvgText>
                    <SvgText
                      x={label.x}
                      y={label.y + 11}
                      fill={selectedNode ? node.color : tc.textSecondary}
                      fontSize={10}
                      fontWeight="800"
                      textAnchor="middle"
                    >
                      {node.value}
                    </SvgText>
                    {node.needsAttention ? (
                      <>
                        <Circle cx={attentionX} cy={attentionY} r={5.4} fill="#EF4444" />
                        <SvgText
                          x={attentionX}
                          y={attentionY + 3.5}
                          fill="#FFFFFF"
                          fontSize={8}
                          fontWeight="900"
                          textAnchor="middle"
                        >
                          !
                        </SvgText>
                      </>
                    ) : null}
                  </Fragment>
                );
              })}
            </Svg>
            <SleepScoreHalo
              color={scoreColor}
              style={{
                left: center.x - centerSize / 2 - 7,
                top: center.y - centerSize / 2 - 7,
                width: centerSize + 14,
                height: centerSize + 14,
                borderRadius: (centerSize + 14) / 2,
              }}
            />
            <View style={[sleepConstellationStyles.center, { left: center.x - centerSize / 2, top: center.y - centerSize / 2, width: centerSize, height: centerSize, borderRadius: centerSize / 2, borderColor: scoreColor + '77', backgroundColor: tc.surfaceRaised, shadowColor: scoreColor }]}>
              <ProgressCardWash color={scoreColor} secondaryColor="#6366F1" intensity="medium" cornerRadius={centerSize / 2} />
              <AnimatedNumber
                value={sleepScore.score}
                from={0}
                animateOnMount={!reducedMotion}
                duration={820}
                style={[sleepConstellationStyles.centerValue, { color: scoreColor }]}
              />
              <Text style={[sleepConstellationStyles.centerLabel, { color: tc.textMuted }]}>Sleep</Text>
            </View>
            {nodes.map((node, index) => {
              const label = labelPoint(index);
              return (
                <TouchableOpacity
                  key={node.key}
                  activeOpacity={0.68}
                  accessibilityRole="button"
                  accessibilityLabel={`${node.label}: ${node.value}. ${node.sentence}`}
                  onPress={() => {
                    import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
                    setSelectedKey(node.key);
                    setDetailKey(node.key);
                  }}
                  style={[
                    sleepConstellationStyles.radarTouch,
                    { left: label.x - labelBoxWidth / 2, top: label.y - labelBoxHeight / 2, width: labelBoxWidth, height: labelBoxHeight },
                  ]}
                />
              );
            })}
          </View>
          {/* Sleep stages timeline shown directly under the constellation
              radar (self-guards to null when no stage timeline exists). */}
          <SleepStageTimelineChart timeline={sleepTimeline} tc={tc} />
          <SleepPressureCard sleepPressure={sleepPressure} tc={tc} />
          {quickInsights.length > 0 ? (
            <TouchableOpacity
              testID="sleep-insights-button"
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={`Sleep notes: ${quickInsights[0].title}. Tap for the full explanation.`}
              onPress={() => {
                import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
                setSleepInsightsOpen(true);
              }}
              style={[sleepConstellationStyles.quickInsightButton, { backgroundColor: tc.surfaceRaised, borderColor: quickInsights[0].color + '36' }]}>
              <ProgressCardWash color={quickInsights[0].color} intensity="soft" cornerRadius={12} />
              <AnimatedHealthSheen
                delay={320}
                opacity={0.18}
                repeat={false}
                style={sleepConstellationStyles.quickInsightSheen}
              />
              <View style={[sleepConstellationStyles.quickInsightIcon, { backgroundColor: quickInsights[0].color + '18' }]}>
                <Ionicons name={quickInsights[0].icon} size={14} color={quickInsights[0].color} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[sleepConstellationStyles.quickInsightTitle, { color: quickInsights[0].color }]} numberOfLines={1}>
                  {quickInsights[0].title}
                </Text>
                <Text style={[sleepConstellationStyles.quickInsightButtonHint, { color: tc.textMuted }]} numberOfLines={1}>
                  {quickInsights.length > 1 ? `Tap to read ${quickInsights.length} sleep notes` : 'Tap to read the full note'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={tc.textMuted} />
            </TouchableOpacity>
          ) : null}
        </>
      ) : (
        <Text style={[sleepConstellationStyles.unavailableText, { color: tc.textSecondary }]}>
          No sleep score yet. Use a sleep-capable {wearableLabel} overnight, then open Thallo after {platformLabel} syncs.
        </Text>
        )}
      </View>
      <Modal
        visible={sleepInsightsOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setSleepInsightsOpen(false)}>
        <View style={sleepConstellationStyles.modalBackdrop}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setSleepInsightsOpen(false)}
          />
          <View style={[sleepConstellationStyles.modalSheet, { backgroundColor: tc.surface, borderColor: tc.border }]}>
            <BottomSheetDismissHandle
              onClose={() => setSleepInsightsOpen(false)}
              color={tc.border}
              containerStyle={sleepConstellationStyles.modalHandleTap}
              handleStyle={sleepConstellationStyles.modalHandle}
            />
            <View style={sleepConstellationStyles.modalHeader}>
              <View style={[sleepConstellationStyles.modalIcon, { backgroundColor: scoreColor + '18' }]}>
                <Ionicons name="moon-outline" size={18} color={scoreColor} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[sleepConstellationStyles.modalEyebrow, { color: tc.textMuted }]}>SLEEP NOTES</Text>
                <Text style={[sleepConstellationStyles.modalTitle, { color: tc.textPrimary }]} numberOfLines={2}>What shaped last night</Text>
              </View>
              <TouchableOpacity onPress={() => setSleepInsightsOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={20} color={tc.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={sleepConstellationStyles.modalScroll} contentContainerStyle={{ paddingBottom: 8 }} showsVerticalScrollIndicator={false}>
              {quickInsights.map((insight) => (
                <View key={insight.key} style={sleepConstellationStyles.modalSection}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <View style={[sleepConstellationStyles.quickInsightIcon, { backgroundColor: insight.color + '18' }]}>
                      <Ionicons name={insight.icon} size={14} color={insight.color} />
                    </View>
                    <Text style={[sleepConstellationStyles.modalSectionTitle, { color: insight.color, marginTop: 0, flex: 1 }]} numberOfLines={3}>
                      {insight.title}
                    </Text>
                  </View>
                  <Text style={[sleepConstellationStyles.modalBody, { color: tc.textSecondary, marginTop: 6 }]}>{insight.detail}</Text>
                  <Text style={[sleepConstellationStyles.modalBody, { color: tc.textMuted, marginTop: 4 }]}>{insight.action}</Text>
                </View>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
      <Modal
        visible={detailNode != null}
        transparent
        animationType="fade"
        onRequestClose={() => setDetailKey(null)}>
        <View style={sleepConstellationStyles.modalBackdrop}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setDetailKey(null)}
          />
          <View style={[sleepConstellationStyles.modalSheet, { backgroundColor: tc.surface, borderColor: tc.border }]}>
            <BottomSheetDismissHandle
              onClose={() => setDetailKey(null)}
              color={tc.border}
              containerStyle={sleepConstellationStyles.modalHandleTap}
              handleStyle={sleepConstellationStyles.modalHandle}
            />
            {detailNode ? (
              <>
                <View style={sleepConstellationStyles.modalHeader}>
                  <View style={[sleepConstellationStyles.modalIcon, { backgroundColor: detailNode.color + '18' }]}>
                    <Ionicons
                      name={detailNode.needsAttention ? 'alert-circle-outline' : 'checkmark-circle-outline'}
                      size={18}
                      color={detailNode.color}
                    />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[sleepConstellationStyles.modalEyebrow, { color: tc.textMuted }]}>SLEEP ATTRIBUTE</Text>
                    <Text style={[sleepConstellationStyles.modalTitle, { color: tc.textPrimary }]} numberOfLines={2}>
                      {detailNode.label}
                    </Text>
                  </View>
                  <TouchableOpacity onPress={() => setDetailKey(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                    <Ionicons name="close" size={20} color={tc.textMuted} />
                  </TouchableOpacity>
                </View>
                <ScrollView style={sleepConstellationStyles.modalScroll} contentContainerStyle={{ paddingBottom: 8 }} showsVerticalScrollIndicator={false}>
                  <View style={sleepConstellationStyles.modalMetricRow}>
                    <View style={[sleepConstellationStyles.modalMetric, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}>
                      <Text style={[sleepConstellationStyles.modalMetricLabel, { color: tc.textMuted }]}>Value</Text>
                      <Text style={[sleepConstellationStyles.modalMetricValue, { color: detailNode.color }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
                        {detailNode.value}
                      </Text>
                    </View>
                    <View style={[sleepConstellationStyles.modalMetric, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}>
                      <Text style={[sleepConstellationStyles.modalMetricLabel, { color: tc.textMuted }]}>Support</Text>
                      <Text style={[sleepConstellationStyles.modalMetricValue, { color: detailNode.color }]} numberOfLines={1}>
                        {Math.round(detailNode.pct * 100)}%
                      </Text>
                    </View>
                  </View>
                  <View style={sleepConstellationStyles.modalSection}>
                    <Text style={[sleepConstellationStyles.modalSectionTitle, { color: tc.textMuted }]}>Read</Text>
                    <Text style={[sleepConstellationStyles.modalBody, { color: tc.textSecondary }]}>{detailNode.sentence}</Text>
                  </View>
                  <View style={sleepConstellationStyles.modalSection}>
                    <Text style={[sleepConstellationStyles.modalSectionTitle, { color: tc.textMuted }]}>Why it matters</Text>
                    <Text style={[sleepConstellationStyles.modalBody, { color: tc.textSecondary }]}>{detailNode.description}</Text>
                  </View>
                  <View style={sleepConstellationStyles.modalSection}>
                    <Text style={[sleepConstellationStyles.modalSectionTitle, { color: tc.textMuted }]}>Next move</Text>
                    <Text style={[sleepConstellationStyles.modalBody, { color: tc.textSecondary }]}>{detailNode.recommendation}</Text>
                    {detailNode.windowHint ? (
                      <Text style={[sleepConstellationStyles.modalWindowHint, { color: detailNode.color }]}>{detailNode.windowHint}</Text>
                    ) : null}
                  </View>
                  {showStageTimelineInDetail ? (
                    <SleepStageTimelineChart timeline={sleepTimeline} tc={tc} />
                  ) : null}
                  <Text style={[sleepConstellationStyles.modalMuted, { color: tc.textMuted }]}>
                    Sleep score is fitness guidance, not a medical diagnosis. Wearable stage and vital estimates can be noisy, so repeated patterns matter more than one night.
                  </Text>
                </ScrollView>
              </>
            ) : null}
          </View>
        </View>
      </Modal>
    </View>
  );
}

function AnimatedPressable({
  children,
  onPress,
  style,
  scaleDown = 0.96,
  disabled = false,
  accessibilityLabel,
  accessibilityRole,
  accessibilityState,
  hitSlop,
  testID,
}: {
  children: ReactNode;
  onPress: () => void;
  style?: any;
  scaleDown?: number;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityRole?: any;
  accessibilityState?: any;
  hitSlop?: any;
  testID?: string;
}) {
  const reducedMotion = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const translateY = useRef(new Animated.Value(0)).current;

  const pressIn = () => {
    if (reducedMotion || disabled) return;
    Animated.parallel([
      Animated.spring(scale, { toValue: scaleDown, damping: 18, stiffness: 300, mass: 0.8, useNativeDriver: true }),
      Animated.spring(translateY, { toValue: -1, damping: 18, stiffness: 300, mass: 0.8, useNativeDriver: true }),
    ]).start();
  };
  const pressOut = () => {
    if (reducedMotion || disabled) return;
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, damping: 18, stiffness: 300, mass: 0.8, useNativeDriver: true }),
      Animated.spring(translateY, { toValue: 0, damping: 18, stiffness: 300, mass: 0.8, useNativeDriver: true }),
    ]).start();
  };

  return (
    <AnimatedTouchableOpacity
      testID={testID}
      activeOpacity={1}
      disabled={disabled}
      onPress={onPress}
      onPressIn={pressIn}
      onPressOut={pressOut}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole}
      accessibilityState={accessibilityState}
      hitSlop={hitSlop}
      style={[style, { transform: [{ scale }, { translateY }] }]}>
      {children}
    </AnimatedTouchableOpacity>
  );
}

function ProgressScreen({ onBack, authToken, userProfile, onUpdateWeight, onCancelScheduledPlanChange, themeName, noHeader = false, nutritionPlan, nutritionLogRefreshKey = 0, isActive = true, planWeekWindow, inProgressWorkout = null, onResumeInProgressWorkout, onDiscardInProgressWorkout, showWorkoutProgress: showWorkoutProgressProp, showMealProgress: showMealProgressProp, webMode = false, resetToTodayToken = 0, focusTarget = null, focusTargetToken = 0, onRequestPreviousSurface, onChromeScroll }: ProgressScreenProps) {
  const tc = getTheme(themeName).colors;
  const styles = useMemo(() => createStyles(tc, webMode), [themeName, webMode]);
  const { width: screenWidth } = useWindowDimensions();
  const trajectoryChartWidth = Math.min(360, Math.max(280, Math.round(screenWidth - 64)));
  const primaryButtonTextColor = getContrastingTextColor(tc.primary);
  const meta = useMetaData();
  const isProTier = tierOf(userProfile) === 'pro';
  const hasServerProTier = userProfile.subscriptionTier === 'pro';
  const weightUnit = resolveWeightUnit(userProfile);
  const distanceUnit = resolveDistanceUnit(userProfile);
  const showWorkoutProgress = showWorkoutProgressProp ?? shouldShowWorkouts(userProfile);
  const showMealProgress = showMealProgressProp ?? shouldShowMeals(userProfile);
  const showMixedGoalProgress = showWorkoutProgress && showMealProgress;
  const visibleProgressTabs = useMemo(() => {
    const tabs: Array<readonly [ProgressTab, string, string]> = [['today', 'Today', 'today-outline']];
    if (showWorkoutProgress) tabs.push(['trends', 'Trends', 'trending-up-outline']);
    tabs.push(['body', 'Body', 'body-outline']);
    tabs.push(['health', 'Health', 'pulse-outline']);
    if (isProTier) tabs.push(['insights', 'Insights', 'sparkles-outline']);
    return tabs;
  }, [isProTier, showWorkoutProgress]);
  const [tab, setTab] = useState<ProgressTab>('today');
  const progressTabRef = useRef<ProgressTab>('today');
  const todayScrollRef = useRef<ScrollView | null>(null);
  const todaySleepCardYRef = useRef<number | null>(null);
  const pendingFocusTargetRef = useRef<ProgressFocusTarget | null>(null);
  const handledFocusTokenRef = useRef(0);
  useEffect(() => { progressTabRef.current = tab; }, [tab]);
  const selectProgressTab = useCallback((next: ProgressTab) => {
    progressTabRef.current = next;
    setTab(next);
  }, []);
  const scrollToTodaySleep = useCallback((animated = true) => {
    const y = todaySleepCardYRef.current;
    const scroll = todayScrollRef.current;
    if (y == null || !scroll) return false;
    scroll.scrollTo({ y: Math.max(0, y - 12), animated });
    return true;
  }, []);
  const handleTodaySleepLayout = useCallback((event: LayoutChangeEvent) => {
    todaySleepCardYRef.current = event.nativeEvent.layout.y;
    if (pendingFocusTargetRef.current !== 'sleep') return;
    requestAnimationFrame(() => {
      if (scrollToTodaySleep(true)) pendingFocusTargetRef.current = null;
    });
  }, [scrollToTodaySleep]);
  const handleProgressChromeScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    onChromeScroll?.(event);
  }, [onChromeScroll]);
  useEffect(() => {
    if (!resetToTodayToken) return;
    selectProgressTab('today');
  }, [resetToTodayToken, selectProgressTab]);
  useEffect(() => {
    if (isActive) return;
    pendingFocusTargetRef.current = null;
  }, [isActive]);
  useEffect(() => {
    if (!isActive || !focusTarget || !focusTargetToken) return undefined;
    if (handledFocusTokenRef.current === focusTargetToken) return undefined;
    handledFocusTokenRef.current = focusTargetToken;
    pendingFocusTargetRef.current = focusTarget;
    selectProgressTab(focusTarget === 'weight' ? 'body' : 'today');

    const attemptFocus = () => {
      if (focusTarget === 'sleep' && scrollToTodaySleep(true)) {
        pendingFocusTargetRef.current = null;
      } else if (focusTarget === 'weight') {
        pendingFocusTargetRef.current = null;
      }
    };

    const frame = requestAnimationFrame(() => {
      attemptFocus();
      requestAnimationFrame(attemptFocus);
    });
    const timerOne = setTimeout(attemptFocus, 320);
    const timerTwo = setTimeout(attemptFocus, 760);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timerOne);
      clearTimeout(timerTwo);
      if (pendingFocusTargetRef.current === focusTarget) {
        pendingFocusTargetRef.current = null;
      }
    };
  }, [focusTarget, focusTargetToken, isActive, scrollToTodaySleep, selectProgressTab]);
  const hapticSelection = useCallback(() => {
    import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
  }, []);
  const progressTabIndex = visibleProgressTabs.findIndex(([key]) => key === tab);
  const swipeProgressTab = useCallback((direction: -1 | 1) => {
    const current = progressTabRef.current;
    const idx = visibleProgressTabs.findIndex(([key]) => key === current);
    if (idx < 0) return;
    const next = visibleProgressTabs[idx + direction]?.[0];
    if (next) {
      hapticSelection();
      selectProgressTab(next);
      return;
    }
    if (direction === -1 && idx === 0 && onRequestPreviousSurface) {
      hapticSelection();
      onRequestPreviousSurface();
    }
  }, [hapticSelection, onRequestPreviousSurface, selectProgressTab, visibleProgressTabs]);
  const canSwipeProgressPrev = progressTabIndex > 0 || (progressTabIndex === 0 && !!onRequestPreviousSurface);
  const canSwipeProgressNext = progressTabIndex >= 0 && progressTabIndex < visibleProgressTabs.length - 1;
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [showLogActivity, setShowLogActivity] = useState(false);
  const [appleHealthAttachSession, setAppleHealthAttachSession] = useState<WorkoutSession | null>(null);
  const fitnessScoreRef = useRef<ViewShot>(null);
  const bodyScanShareRef = useRef<ViewShot>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [selectedExercise, setSelectedExercise] = useState<string | null>(null);
  // Default to e1RM when available. It combines load + reps, and falls
  // back to Weight automatically for exercises without enough usable
  // strength data.
  const [chartMode, setChartMode] = useState<'weight' | 'volume' | 'duration' | 'e1rm'>('e1rm');
  const [e1rmHistory, setE1rmHistory] = useState<E1RMTrendPoint[]>([]);
  // Optional muscle filter for the exercise picker. 'all' = no filter.
  const [chartMuscleFilter, setChartMuscleFilter] = useState<string>('all');
  const [prs, setPrs] = useState<PR[]>([]);
  const [prSearch, setPrSearch] = useState('');
  const [prFocusFilter, setPrFocusFilter] = useState<string | null>(null);
  const [visiblePrCount, setVisiblePrCount] = useState(40);
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
  const [visibleWorkoutCount, setVisibleWorkoutCount] = useState(30);
  // Free-text search over the workout history list — matches exercise
  // names, focus labels, and logged activities so the user can find
  // when they last did a thing.
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyDateFilter, setHistoryDateFilter] = useState<WorkoutHistoryDateFilter>('all');
  const [historyTypeFilter, setHistoryTypeFilter] = useState<WorkoutHistoryTypeFilter>('all');
  useEffect(() => {
    setVisibleWorkoutCount(30);
  }, [historyQuery, historyDateFilter, historyTypeFilter]);
  // Activities the user wants a nudge about if they go stale (haven't
  // been logged in a while). Loaded on mount; re-evaluated whenever
  // history changes so the scheduled local notifications track real data.
  const [stalenessWatches, setStalenessWatches] = useState<StalenessWatch[]>([]);
  useEffect(() => {
    if (!isActive) return undefined;
    let cancelled = false;
    import('../utils/stalenessReminders').then(m => {
      if (cancelled) return;
      m.loadStalenessWatches().then(w => { if (!cancelled) setStalenessWatches(w); }).catch(() => {});
      m.evaluateStalenessReminders(history).catch(() => {});
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [history, isActive]);
  const [goalHistory, setGoalHistory] = useState<GoalHistoryEntry[]>([]);
  const [planChanges, setPlanChanges] = useState<PlanChangeEntry[]>([]);
  const [bodyScanLoading, setBodyScanLoading] = useState(false);
  const [bodyScanResult, setBodyScanResult] = useState<BodyScanResult | null>(null);
  const [bodyScanHistory, setBodyScanHistory] = useState<BodyScanEntry[]>([]);
  // Flips true once the body-scan loader resolves (success OR error). Used to
  // gate the goal-execution card so we don't display incorrect numbers built
  // from an empty bodyScanHistory while the load is still in flight.
  const [bodyScanLoaded, setBodyScanLoaded] = useState(false);
  const bodyScanHistoryLoadedRef = useRef(false);
  // User's actual TDEE + calorie adjustments. Used to personalize the
  // goal-forecast weekly rate (the static pace constants overstate
  // fat-loss for small users and understate it for large ones).
  const [calorieRanges, setCalorieRanges] = useState<CalorieRanges | null>(null);
  const [bodyScanPrepSource, setBodyScanPrepSource] = useState<'camera' | 'library' | null>(null);
  const [healthSummary, setHealthSummary] = useState<HealthSummary | null>(null);
  const healthLiveLoadedRef = useRef(false);
  // Last 30 nights, merged from local HealthKit cache + backend
  // SleepLog rows. Stored score wins so dots match the Sleep Score
  // card; recalculation is only a fallback for older rows without a
  // persisted score.
  const [sleepHistory, setSleepHistory] = useState<ProgressSleepHistoryPoint[]>([]);
  const [sleepPressure, setSleepPressure] = useState<import('../services/api').SleepPressureResponse | null>(null);
  const [sleepHistoryOpen, setSleepHistoryOpen] = useState(false);
  const [healthEnabled, setHealthEnabled] = useState<boolean>(false);
  const [healthConnecting, setHealthConnecting] = useState<boolean>(false);
  const [healthReading, setHealthReading] = useState<boolean>(false);
  const [appleNutritionSnapshot, setAppleNutritionSnapshot] = useState<DailyNutritionSnapshot | null>(null);
  const [appleNutritionReading, setAppleNutritionReading] = useState(false);
  const [healthScore, setHealthScore] = useState<HealthScoreResult | null>(null);
  const [oneRepMaxLifts, setOneRepMaxLifts] = useState<import('../services/api').OneRepMaxLift[]>([]);
  // Bulk rolling-e1RM map keyed by lowercased exercise name. Powers
  // the Strength Score card — the showcase tuple only covers 8 named
  // slugs and misses anything we want to opportunistically include
  // (lat pulldown, dumbbell variants etc.). The map gives us
  // everything the user has logged.
  const [bulkE1RMMap, setBulkE1RMMap] = useState<Record<string, number>>({});
  // Detail bottom sheet for the Strength Score — shows per-lift 1RM,
  // bodyweight ratio, and target ratio so the user can see exactly
  // what makes their score.
  const [strengthScoreDetailOpen, setStrengthScoreDetailOpen] = useState(false);
  // Detail sheets for the Trends-tab summary rows.
  const [strengthTrendDetailOpen, setStrengthTrendDetailOpen] = useState(false);
  const [volumeDetailMode, setVolumeDetailMode] = useState<VolumeDetailMode | null>(null);
  const [dailyRecompForecast, setDailyRecompForecast] = useState<{ scopeKey: string; forecast: GoalForecastModel } | null>(null);
  const [goalScore, setGoalScore] = useState<GoalScoreResult | null>(null);
  const [recordsDetailOpen, setRecordsDetailOpen] = useState(false);
  // 1RM history for the top lift — fetched lazily after `oneRepMaxLifts`
  // resolves so the bars render immediately. Used to draw the trend chart
  // below the bar list.
  const [topLiftHistory, setTopLiftHistory] = useState<{ name: string; points: import('../services/api').E1RMHistoryPoint[] } | null>(null);
  const [plateaus, setPlateaus] = useState<import('../services/api').PlateauEntry[]>([]);
  const [plateauModalVisible, setPlateauModalVisible] = useState(false);
  const [plateauDismissed, setPlateauDismissed] = useState(true);
  const [quickDetailSheet, setQuickDetailSheet] = useState<'today' | 'forecast' | null>(null);
  const [strengthRadarDetailOpen, setStrengthRadarDetailOpen] = useState(false);
  const [cardioScoreDetailOpen, setCardioScoreDetailOpen] = useState(false);
  // Edit Trends — which Trends-tab sections are shown (persisted on device).
  const [editTrendsOpen, setEditTrendsOpen] = useState(false);
  const [trendsHidden, setTrendsHidden] = useState<Set<string>>(new Set());
  useEffect(() => {
    AsyncStorage.getItem('trendsHiddenSections_v1').then(raw => {
      if (!raw) return;
      try {
        const decoded = JSON.parse(raw);
        const parsed = Array.isArray(decoded) ? decoded as string[] : [];
        const next = new Set(parsed);
        if (next.has('charts')) {
          next.delete('charts');
          next.add('strength-charts');
          next.add('cardio-progression');
          AsyncStorage.setItem('trendsHiddenSections_v1', JSON.stringify([...next])).catch(() => {});
        }
        setTrendsHidden(next);
      } catch {}
    }).catch(() => {});
  }, []);
  const setTrendsSectionVisible = useCallback((id: string, visible: boolean) => {
    setTrendsHidden(prev => {
      const next = new Set(prev);
      if (visible) next.delete(id); else next.add(id);
      AsyncStorage.setItem('trendsHiddenSections_v1', JSON.stringify([...next])).catch(() => {});
      return next;
    });
  }, []);
  const showAllTrends = useCallback(() => {
    setTrendsHidden(new Set());
    AsyncStorage.removeItem('trendsHiddenSections_v1').catch(() => {});
  }, []);
  const hideAllTrends = useCallback(() => {
    const next = new Set(TRENDS_SECTIONS.map(section => section.id));
    setTrendsHidden(next);
    AsyncStorage.setItem('trendsHiddenSections_v1', JSON.stringify([...next])).catch(() => {});
  }, []);
  const trendsShown = useCallback((id: string) => !trendsHidden.has(id), [trendsHidden]);
  const [editHighValueTrendsOpen, setEditHighValueTrendsOpen] = useState(false);
  const [hiddenHighValueTrendCards, setHiddenHighValueTrendCards] = useState<Set<string>>(new Set());
  const [editActivityHighlightsOpen, setEditActivityHighlightsOpen] = useState(false);
  const [hiddenActivityHighlightCards, setHiddenActivityHighlightCards] = useState<Set<string>>(new Set());
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEYS.ui.highValueTrendHiddenCards)
      .then(raw => setHiddenHighValueTrendCards(parseHiddenIdSet(raw)))
      .catch(() => {});
    AsyncStorage.getItem(STORAGE_KEYS.ui.activityHighlightHiddenCards)
      .then(raw => setHiddenActivityHighlightCards(parseHiddenIdSet(raw)))
      .catch(() => {});
  }, []);
  const setHighValueTrendCardVisible = useCallback((id: string, visible: boolean) => {
    setHiddenHighValueTrendCards(prev => {
      const next = new Set(prev);
      if (visible) next.delete(id); else next.add(id);
      AsyncStorage.setItem(STORAGE_KEYS.ui.highValueTrendHiddenCards, JSON.stringify([...next])).catch(() => {});
      return next;
    });
  }, []);
  const showAllHighValueTrendCards = useCallback(() => {
    setHiddenHighValueTrendCards(new Set());
    AsyncStorage.removeItem(STORAGE_KEYS.ui.highValueTrendHiddenCards).catch(() => {});
  }, []);
  const setActivityHighlightCardVisible = useCallback((id: string, visible: boolean) => {
    setHiddenActivityHighlightCards(prev => {
      const next = new Set(prev);
      if (visible) next.delete(id); else next.add(id);
      AsyncStorage.setItem(STORAGE_KEYS.ui.activityHighlightHiddenCards, JSON.stringify([...next])).catch(() => {});
      return next;
    });
  }, []);
  const showAllActivityHighlightCards = useCallback(() => {
    setHiddenActivityHighlightCards(new Set());
    AsyncStorage.removeItem(STORAGE_KEYS.ui.activityHighlightHiddenCards).catch(() => {});
  }, []);
  // Edit Health — which Health-tab sections are shown (persisted on device).
  const [editHealthOpen, setEditHealthOpen] = useState(false);
  const [healthHidden, setHealthHidden] = useState<Set<string>>(new Set());
  useEffect(() => {
    AsyncStorage.getItem('healthHiddenSections_v1').then(raw => {
      if (!raw) return;
      try { setHealthHidden(new Set(JSON.parse(raw) as string[])); } catch {}
    }).catch(() => {});
  }, []);
  const setHealthSectionVisible = useCallback((id: string, visible: boolean) => {
    setHealthHidden(prev => {
      const next = new Set(prev);
      if (visible) next.delete(id); else next.add(id);
      AsyncStorage.setItem('healthHiddenSections_v1', JSON.stringify([...next])).catch(() => {});
      return next;
    });
  }, []);
  const showAllHealth = useCallback(() => {
    setHealthHidden(new Set());
    AsyncStorage.removeItem('healthHiddenSections_v1').catch(() => {});
  }, []);
  const healthShown = useCallback((id: string) => !healthHidden.has(id), [healthHidden]);
  const [selectedCardioExercise, setSelectedCardioExercise] = useState<string | null>(null);
  const [cardioChartMode, setCardioChartMode] = useState<CardioChartMode>('distance');
  // Bottom-sheet explainer for the Health Score card. Opened by the
  // `info` icon next to the title — testers kept asking what the
  // number meant and where it came from, and the locked-state copy
  // alone wasn't enough.
  const [sleepScoreExplainOpen, setSleepScoreExplainOpen] = useState(false);
  const [selectedBiometric, setSelectedBiometric] = useState<HealthBiometricKey | null>(null);
  const [biometricHistoryOpen, setBiometricHistoryOpen] = useState(false);
  const [healthBiometricsExpanded, setHealthBiometricsExpanded] = useState(false);
  const [biometricHistoryWindow, setBiometricHistoryWindow] = useState<BiometricHistoryWindow>(30);
  const [dailyHealthHistory, setDailyHealthHistory] = useState<import('../services/api').DailyHealthHistoryItem[] | null>(null);
  const [dailyHealthHistoryDays, setDailyHealthHistoryDays] = useState(0);
  const [dailyHealthHistoryLoading, setDailyHealthHistoryLoading] = useState(false);
  const [weightEntries, setWeightEntries] = useState<import('../types').WeightEntry[]>([]);
  // Flips true after loadWeightHistory resolves (success OR error). Empty
  // array on its own can't be distinguished from "not yet loaded".
  const [weightEntriesLoaded, setWeightEntriesLoaded] = useState(false);
  const [weightInputVisible, setWeightInputVisible] = useState(false);
  const [weightInputValue, setWeightInputValue] = useState('');
  const [weightInputError, setWeightInputError] = useState('');
  const [weightCardExpanded, setWeightCardExpanded] = useState(false);
  const [weightChartRange, setWeightChartRange] = useState<'30d' | '90d' | 'all'>('90d');
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
  const [nutritionScoreWeekly, setNutritionScoreWeekly] = useState<import('../services/api').NutritionScoreWeekly | null>(null);
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
  const refreshAppleNutritionSnapshot = useCallback(async (): Promise<DailyNutritionSnapshot | null> => {
    if (!isHealthKitAvailable()) {
      setAppleNutritionSnapshot(null);
      return null;
    }
    setAppleNutritionReading(true);
    try {
      const now = new Date();
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const dayEnd = dayStart + 86400000;
      const snapshot = await readDailyNutritionSnapshot(dayStart, dayEnd);
      setAppleNutritionSnapshot(snapshot);
      return snapshot;
    } finally {
      setAppleNutritionReading(false);
    }
  }, []);

  // ─── Exercise property lookup maps ────────────────────────────────────────
  // Built from workout history — prefers structured fields from the planner
  // (primaryMuscle, isCompound) over regex heuristics.
  const workoutHistoryIndex = useMemo(() => buildWorkoutHistoryIndex(history), [history]);
  const exerciseMuscleMap = workoutHistoryIndex.muscleMap;
  const exerciseTrendMap = workoutHistoryIndex.trendMap;
  const chartExerciseOptions = useMemo(() => {
    if (!showWorkoutProgress) return [];
    const prNameByKey = new Map(prs.map(pr => [pr.exerciseName.toLowerCase(), pr.exerciseName] as const));
    return Object.entries(exerciseTrendMap)
      .filter(([, points]) => points.length >= 2)
      .map(([key]) => ({
        key,
        name: prNameByKey.get(key) ?? key.replace(/\b\w/g, c => c.toUpperCase()),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [exerciseTrendMap, prs, showWorkoutProgress]);
  const activeChartBucket = useMemo(
    () => CHART_MUSCLE_BUCKETS.find(b => b.id === chartMuscleFilter) ?? CHART_MUSCLE_BUCKETS[0],
    [chartMuscleFilter],
  );
  const filteredChartExercises = useMemo(() => chartExerciseOptions.filter(option => {
    if (chartMuscleFilter === 'all') return true;
    const muscle = exerciseMuscleMap[option.key] || inferChartMuscleFromName(option.name);
    return activeChartBucket.matches(muscle);
  }), [activeChartBucket, chartExerciseOptions, chartMuscleFilter, exerciseMuscleMap]);
  const selectedExerciseTrend = useMemo(
    () => selectedExercise ? (exerciseTrendMap[selectedExercise.toLowerCase()] ?? []) : [],
    [exerciseTrendMap, selectedExercise],
  );
  // Resolve the selected exercise's category (main / machine / isolation)
  // off whatever flags the history has stamped. Drives both the
  // chart series choice and the "Estimated 1RM Trend" vs "Best Set
  // Trend" label swap below — Epley is unreliable for isolations so
  // we don't pretend otherwise.
  const selectedExerciseCategory = useMemo<LiftCategory>(() => {
    if (!selectedExercise) return 'main_compound';
    const target = selectedExercise.toLowerCase().trim();
    for (const session of history) {
      for (const exercise of session.exercises ?? []) {
        if (String(exercise.name ?? '').toLowerCase().trim() === target) {
          return categorizeExercise({
            isCompound: (exercise as any).isCompound ?? (exercise as any).is_compound ?? null,
            isMachine: (exercise as any).isMachine ?? (exercise as any).is_machine ?? null,
            name: exercise.name,
          });
        }
      }
    }
    return categorizeExercise({ name: selectedExercise });
  }, [history, selectedExercise]);
  const selectedExerciseIsIsolation = selectedExerciseCategory === 'isolation';
  const progressWeekWindow = useMemo(
    () => buildProgressDateWindow(planWeekWindow),
    [planWeekWindow?.startDate, planWeekWindow?.endDate],
  );
  const cardioTrendSummary = useMemo(
    () => buildCardioTrendSummary(paceHistory, summaries, healthSummary, progressWeekWindow),
    [healthSummary, paceHistory, progressWeekWindow, summaries],
  );
  const localSelectedE1rmHistory = useMemo(
    () => selectedExerciseIsIsolation
      ? buildLocalBestSetHistory(history, selectedExercise)
      : buildLocalE1RMHistory(history, selectedExercise, (w, r, opts) =>
          estimate1RM(w, r, { ...opts, category: selectedExerciseCategory }),
        ),
    [history, selectedExercise, selectedExerciseCategory, selectedExerciseIsIsolation],
  );
  const selectedE1rmHistory = useMemo(
    // Server-side e1RM only applies to compound lifts; for isolation
    // we always use the locally-computed best-set trend.
    () => selectedExerciseIsIsolation
      ? localSelectedE1rmHistory
      : (e1rmHistory.length >= 2 ? e1rmHistory : localSelectedE1rmHistory),
    [e1rmHistory, localSelectedE1rmHistory, selectedExerciseIsIsolation],
  );
  const cardioInsightsMemo = useMemo(
    () => showWorkoutProgress ? buildCardioInsights(cardioTrendSummary, distanceUnit) : [],
    [cardioTrendSummary, distanceUnit, showWorkoutProgress],
  );
  const highValueTrendCards = useMemo(
    () => showWorkoutProgress ? buildHighValueTrendCards({
      history,
      summaries,
      sleepHistory,
      healthSummary,
      weightEntries,
      bodyScanHistory,
      mealAverages,
      nutritionScoreWeekly,
      cardioSummary: cardioTrendSummary,
      weightUnit,
      distanceUnit,
      showMealProgress,
    }) : [],
    [
      bodyScanHistory,
      cardioTrendSummary,
      distanceUnit,
      healthSummary,
      history,
      mealAverages,
      nutritionScoreWeekly,
      showMealProgress,
      showWorkoutProgress,
      sleepHistory,
      summaries,
      weightEntries,
      weightUnit,
    ],
  );
  const activityTrendCards = useMemo(
    () => showWorkoutProgress ? buildActivityTrendCards(history, distanceUnit) : [],
    [distanceUnit, history, showWorkoutProgress],
  );
  const visibleHighValueTrendCards = useMemo(
    () => highValueTrendCards.filter(card => !hiddenHighValueTrendCards.has(card.key)),
    [hiddenHighValueTrendCards, highValueTrendCards],
  );
  const highValueTrendEditSections = useMemo(
    () => trendActivityCardEditSections(highValueTrendCards),
    [highValueTrendCards],
  );
  const visibleActivityTrendCards = useMemo(
    () => activityTrendCards.filter(card => !hiddenActivityHighlightCards.has(card.key)),
    [activityTrendCards, hiddenActivityHighlightCards],
  );
  const activityHighlightEditSections = useMemo(
    () => trendActivityCardEditSections(activityTrendCards),
    [activityTrendCards],
  );
  const trendMetricSuggestions = useMemo(
    () => showWorkoutProgress ? buildTrendMetricSuggestions({
      history,
      summaries,
      cardioSummary: cardioTrendSummary,
      bodyScanHistory,
      weightEntries,
      nutritionScoreWeekly,
      showMealProgress,
    }) : [],
    [
      bodyScanHistory,
      cardioTrendSummary,
      history,
      nutritionScoreWeekly,
      showMealProgress,
      showWorkoutProgress,
      summaries,
      weightEntries,
    ],
  );
  const paceExerciseGroups = useMemo<CardioExerciseGroup[]>(() => {
    const groups = new Map<string, { name: string; points: PaceHistoryPoint[] }>();
    for (const point of paceHistory) {
      const key = cardioExerciseKey(point.exercise);
      const current = groups.get(key);
      groups.set(key, {
        name: current?.name ?? cardioExerciseDisplayName(point.exercise),
        points: [...(current?.points ?? []), point],
      });
    }
    return Array.from(groups.entries()).map(([key, group]) => {
      const points = group.points.slice().sort((a, b) => parseDateKeyMs(a.date) - parseDateKeyMs(b.date));
      const distancePoints = points.filter(p => p.distance != null && p.distance > 0);
      const pacePoints = points.filter(p => paceSeconds(p.pace) != null);
      const durationPoints = points.filter(p => p.duration_seconds != null && p.duration_seconds > 0);
      const distances = distancePoints.map(p => p.distance!);
      const durations = durationPoints.map(p => p.duration_seconds!);
      return {
        key,
        name: group.name,
        points,
        distancePoints,
        pacePoints,
        durationPoints,
        maxDistance: Math.max(...distances, 0.1),
        maxDurationSec: Math.max(...durations, 1),
      };
    }).sort((a, b) => b.points.length - a.points.length || a.name.localeCompare(b.name));
  }, [paceHistory]);
  const cardioBestsMemo = useMemo(() => paceExerciseGroups.map(({ name, points }) => {
    const bestDist = points.reduce((best, p) => p.distance != null && p.distance > (best ?? 0) ? p.distance : best, null as number | null);
    const ptsWithPace = points.filter(p => p.pace);
    const lastPace = ptsWithPace.length > 0 ? ptsWithPace[ptsWithPace.length - 1].pace : null;
    const bestDur = points.reduce((best, p) => p.duration_seconds != null && p.duration_seconds > (best ?? 0) ? p.duration_seconds : best, null as number | null);
    const extraKeys = Array.from(new Set(points.flatMap(p => p.metrics ? Object.keys(p.metrics) : [])));
    const extraBests: Record<string, string> = {};
    extraKeys.forEach(k => {
      const vals = points.map(p => Number(p.metrics?.[k])).filter(v => Number.isFinite(v));
      if (vals.length) extraBests[k] = String(Math.max(...vals));
    });
    return { name, bestDist, lastPace, bestDur, extraBests, sessionCount: points.length };
  }).filter(pr => pr.bestDist != null || pr.lastPace != null || pr.bestDur != null), [paceExerciseGroups]);
  const localOneRepMaxLifts = useMemo<import('../services/api').OneRepMaxLift[]>(() => {
    const stats = exerciseHistoryStats(history);
    return prs
      .map((pr): import('../services/api').OneRepMaxLift | null => {
        const oneRepMaxLbs = Math.round((Number(pr.weightLbs) * (1 + Number(pr.reps) / 30)) * 10) / 10;
        if (!Number.isFinite(oneRepMaxLbs) || oneRepMaxLbs <= 0) return null;
        const stat = stats.get(pr.exerciseName.toLowerCase());
        const sessionCount = Math.max(1, stat?.sessionCount ?? 1);
        return {
          slug: exerciseNameSlug(pr.exerciseName),
          name: pr.exerciseName,
          oneRepMaxLbs,
          topWeightLbs: pr.weightLbs,
          topReps: pr.reps,
          sessionCount,
          confidence: Math.round(Math.min(1, sessionCount / 6) * 100) / 100,
          lastPerformedOn: pr.date ? pr.date.slice(0, 10) : null,
          // Local fallback (no auth / pre-server). It can't know about
          // session position or per-set RIR, so it labels itself as
          // "rough" data quality. The UI uses this to show a
          // "based on raw top sets" caveat.
          trend28dPct: null,
          trend56dPct: null,
          freshSetCount: 0,
          signalConfidence: 'low',
          dataQuality: 'rough',
        };
      })
      .filter((lift): lift is import('../services/api').OneRepMaxLift => lift != null)
      .sort((a, b) => b.oneRepMaxLbs - a.oneRepMaxLbs)
      .slice(0, 5);
  }, [history, prs]);
  const displayedOneRepMaxLifts = oneRepMaxLifts.length > 0 ? oneRepMaxLifts : localOneRepMaxLifts;
  const progressMilestones = useMemo(
    () => buildProgressMilestones(history, prs, summaries, paceHistory, mealAverages, displayedOneRepMaxLifts, weightUnit, distanceUnit, { showWorkoutProgress, showMealProgress }),
    [distanceUnit, displayedOneRepMaxLifts, history, mealAverages, paceHistory, prs, showMealProgress, showWorkoutProgress, summaries, weightUnit],
  );

  const progressAnalytics = useMemo(
    () => showWorkoutProgress ? buildProgressAnalytics(history, prs, plateaus, weightUnit, distanceUnit, cardioTrendSummary, progressWeekWindow) : [],
    [cardioTrendSummary, distanceUnit, history, plateaus, progressWeekWindow, prs, showWorkoutProgress, weightUnit],
  );
  const coachInsightVisuals = useMemo(
    () => buildCoachInsightVisuals(insights, guardrails, coachMemory, progressionHint, { showWorkoutProgress, showMealProgress }),
    [coachMemory, guardrails, insights, progressionHint, showMealProgress, showWorkoutProgress],
  );
  const thisWeekOverview = useMemo(
    () => buildThisWeekOverview(history, summaries, prs, weightEntries, paceHistory, mealHistory, weightUnit, distanceUnit, progressWeekWindow, { showWorkoutProgress, showMealProgress }),
    [distanceUnit, history, mealHistory, paceHistory, progressWeekWindow, prs, showMealProgress, showWorkoutProgress, summaries, weightEntries, weightUnit],
  );
  const liveGoalForecast = useMemo(
    () => showMixedGoalProgress ? buildGoalForecast({
      profile: userProfile,
      weightEntries,
      history,
      summaries,
      mealAverages,
      mealHistory,
      nutritionScoreWeekly,
      paceHistory,
      oneRepMaxLifts: displayedOneRepMaxLifts,
      bodyScanHistory,
      calorieRanges: calorieRanges ? {
        maintenanceCalories: calorieRanges.maintenance_calories,
        cutAdjustmentKcal: calorieRanges.cut_adjustment_kcal ?? null,
        bulkAdjustmentKcal: calorieRanges.bulk_adjustment_kcal ?? null,
      } : null,
      vo2Max: healthSummary?.vo2Max ?? null,
      avgSleepHours: healthSummary?.avgSleepHours7d ?? null,
      weightUnit,
      distanceUnit,
    }) : null,
    [bodyScanHistory, calorieRanges, displayedOneRepMaxLifts, distanceUnit, healthSummary?.avgSleepHours7d, healthSummary?.vo2Max, history, mealAverages, mealHistory, nutritionScoreWeekly, paceHistory, showMixedGoalProgress, summaries, userProfile, weightEntries, weightUnit],
  );
  const recompForecastNutritionSignal = useMemo(() => {
    if (!showMealProgress) return 'disabled';
    if (!authToken) return 'offline';
    if (mealAverages == null && mealHistory == null && nutritionScoreWeekly == null) return 'loading';
    const mealHistoryDays = new Set(
      (mealHistory ?? [])
        .map(row => String(row.meal_date ?? '').slice(0, 10))
        .filter(key => /^\d{4}-\d{2}-\d{2}$/.test(key)),
    ).size;
    const averageDays = Math.round(Number(mealAverages?.days_with_data) || 0);
    const scoreDays = Math.round(Number(nutritionScoreWeekly?.days_with_data) || 0);
    return Math.max(mealHistoryDays, averageDays, scoreDays) > 0 ? 'has-meals' : 'no-meals';
  }, [authToken, mealAverages, mealHistory, nutritionScoreWeekly, showMealProgress]);
  const recompForecastScopeKey = useMemo(() => {
    if (liveGoalForecast?.bucket !== 'body_recomp') return null;
    if (recompForecastNutritionSignal === 'loading') return null;
    const details = userProfile.goalDetails ?? {};
    return JSON.stringify({
      goal: userProfile.goal,
      pace: details.pace ?? null,
      startWeightLbs: details.startWeightLbs ?? null,
      targetWeightLbs: details.targetWeightLbs ?? null,
      startBodyFatPct: details.startBodyFatPct ?? null,
      goalStartedAt: details.goalStartedAt ?? null,
      nutritionSignal: recompForecastNutritionSignal,
      weightUnit,
      distanceUnit,
    });
  }, [
    distanceUnit,
    liveGoalForecast?.bucket,
    recompForecastNutritionSignal,
    userProfile.goal,
    userProfile.goalDetails?.goalStartedAt,
    userProfile.goalDetails?.pace,
    userProfile.goalDetails?.startBodyFatPct,
    userProfile.goalDetails?.startWeightLbs,
    userProfile.goalDetails?.targetWeightLbs,
    weightUnit,
  ]);
  useEffect(() => {
    let cancelled = false;
    if (loading) {
      return () => { cancelled = true; };
    }
    if (liveGoalForecast?.bucket !== 'body_recomp' || !recompForecastScopeKey) {
      setDailyRecompForecast(null);
      return () => { cancelled = true; };
    }
    import('../utils/dailyProgressSnapshots').then(m =>
      m.getStableDailyRecompForecast(liveGoalForecast, recompForecastScopeKey),
    ).then(snapshot => {
      if (!cancelled) setDailyRecompForecast({ scopeKey: snapshot.scopeKey, forecast: snapshot.forecast });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [liveGoalForecast, loading, recompForecastScopeKey]);
  const goalForecast = liveGoalForecast?.bucket === 'body_recomp'
    ? (dailyRecompForecast?.scopeKey === recompForecastScopeKey ? dailyRecompForecast.forecast : liveGoalForecast)
    : liveGoalForecast;
  const todayTrack = useMemo(
    () => buildTodayTrackSummary({
      profile: userProfile,
      history,
      summaries,
      weightEntries,
      paceHistory,
      mealHistory,
      mealAverages,
      weightUnit,
      distanceUnit,
      window: progressWeekWindow,
      tc,
      showWorkoutProgress,
      showMealProgress,
    }),
    [distanceUnit, history, mealAverages, mealHistory, paceHistory, progressWeekWindow, showMealProgress, showWorkoutProgress, summaries, tc, userProfile, weightEntries, weightUnit],
  );
  const goalForecastColor = goalForecast?.tone === 'success'
    ? tc.success
    : goalForecast?.tone === 'warning'
      ? tc.warning
      : tc.primary;
  const goalScoreColor = goalScore
    ? goalScore.executionScore >= 75
      ? tc.success
      : goalScore.executionScore >= 55
        ? tc.warning
        : tc.error
    : goalForecastColor;
  const hasGoalScoreDetail = !!goalScore || !!goalForecast;
  const todayHeroColor = goalScore ? goalScoreColor : goalForecast ? goalForecastColor : todayTrack.color;
  const todayHeroStatus = goalScore
    ? goalScore.executionLabel
    : goalForecast
    ? goalForecast.tone === 'success'
      ? 'On pace'
      : goalForecast.tone === 'warning'
        ? 'Needs signal'
        : 'Close'
    : todayTrack.title;
  const todayHeroTitle = goalScore
    ? formatGoalScoreHeroTitle(goalScore)
    : goalForecast
    ? goalForecast.headline.replace(/^At current pace:\s*/i, '')
    : todayTrack.title;
  const todayHeroSubtitle = goalScore ? null : goalForecast ? stripGoalStartedCopy(goalForecast.subheadline) : todayTrack.subtitle;
  const todayHeroMetricLabel = goalScore || goalForecast ? 'Execution' : 'Goal signal';
  const todayHeroMetricValue = goalScore ? `${goalScore.executionScore}%` : goalForecast ? `${goalForecast.executionPct}%` : `${todayTrack.progressPct}%`;
  const todayHeroImageUri = goalEstimateImageUri(userProfile.goal, userProfile.physicalStats?.gender);
  const goalVo2Points = useMemo(
    () => buildBiometricHistoryPoints('vo2', sleepHistory, dailyHealthHistory, healthSummary, GOAL_EXECUTION_BLOCK_DAYS),
    [dailyHealthHistory, healthSummary, sleepHistory],
  );
  const goalExecutionOverview = useMemo(
    () => buildGoalExecutionOverview({
      profile: userProfile,
      todayTrack,
      goalForecast,
      weightEntries,
      history,
      summaries,
      prs,
      paceHistory,
      mealHistory,
      vo2Points: goalVo2Points,
      bodyScanHistory,
      weightUnit,
      distanceUnit,
      tc,
      showWorkoutProgress,
      showMealProgress,
    }),
    [bodyScanHistory, distanceUnit, goalForecast, goalVo2Points, history, mealHistory, paceHistory, prs, showMealProgress, showWorkoutProgress, summaries, tc, todayTrack, userProfile, weightEntries, weightUnit],
  );
  const bedtimeWindow = useMemo(
    () => bedtimeWindowFromHistory(sleepHistory.map(n => n.bedtimeMinutes ?? -1)),
    [sleepHistory],
  );
  const hasSleepCardData = !!healthSummary && (
    healthSummary.sleepScore != null
    || healthSummary.sleepTimeline != null
    || healthSummary.lastNightSleepHours != null
    || healthSummary.avgSleepHours7d != null
  );
  const todaySleepConstellationCard = isProTier && healthEnabled && isHealthKitAvailable() && hasSleepCardData ? (
    <SleepConstellationCard
      sleepScore={healthSummary!.sleepScore ?? null}
      sleepTimeline={healthSummary!.sleepTimeline ?? null}
      bedtimeWindow={bedtimeWindow}
      sleepHistory={sleepHistory}
      sleepPressure={sleepPressure}
      mealHistory={mealHistory}
      workoutHistory={history}
      workoutSummaries={summaries}
      tc={tc}
      width={screenWidth}
      wearableLabel={HEALTH_WEARABLE_LABEL}
      platformLabel={HEALTH_PLATFORM_LABEL}
      onInfo={() => setSleepScoreExplainOpen(true)}
      onHistory={sleepHistory.length > 0 ? () => {
        import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
        setSleepHistoryOpen(true);
      } : undefined}
    />
  ) : null;
  const plateauAlertCard = showWorkoutProgress && plateaus.length > 0 && !plateauDismissed ? (
    <FadeInView delay={20} duration={TIMING_STANDARD.duration} slideDistance={6}>
      <View
        testID="progress-plateau-alert-card"
        style={{
          marginBottom: 12,
          backgroundColor: tc.surface,
          borderRadius: radius.lg,
          borderWidth: 1.5,
          borderColor: '#F59E0B88',
          padding: 14,
          overflow: 'hidden',
        }}
      >
        <ProgressCardWash color="#F59E0B" intensity="soft" cornerRadius={radius.lg} />
        <TouchableOpacity
          testID="progress-plateau-alert-open"
          accessibilityRole="button"
          accessibilityLabel={`${plateaus.length} plateaued exercise${plateaus.length === 1 ? '' : 's'}. Review plateau recommendations.`}
          onPress={() => {
            import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
            setPlateauModalVisible(true);
          }}
          activeOpacity={0.82}
          style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}
        >
          <View style={{
            width: 34,
            height: 34,
            borderRadius: 17,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#F59E0B22',
          }}>
            <Ionicons name="trending-up-outline" size={18} color="#D97706" />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 10, fontWeight: '900', color: '#D97706', letterSpacing: 0.5 }}>
              PLATEAU WATCH
            </Text>
            <Text style={{ fontSize: 15, fontWeight: '900', color: tc.textPrimary, marginTop: 2 }} numberOfLines={2}>
              {plateaus.length} exercise{plateaus.length === 1 ? '' : 's'} need a progression check
            </Text>
            <View style={{ marginTop: 8, gap: 5 }}>
              {plateaus.slice(0, 3).map((p, index) => (
                <View
                  key={`${p.exercise_name}-${index}`}
                  testID={`progress-plateau-alert-row-${index}`}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}
                >
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#F59E0B' }} />
                  <Text style={{ flex: 1, minWidth: 0, fontSize: 12, color: tc.textSecondary }} numberOfLines={1}>
                    {p.exercise_name} · {plateauSuggestionTitle(p.suggestion)} · {p.weeks_stuck}w flat
                  </Text>
                </View>
              ))}
              {plateaus.length > 3 && (
                <Text style={{ fontSize: 11, color: tc.textMuted, fontWeight: '700' }}>
                  +{plateaus.length - 3} more
                </Text>
              )}
            </View>
          </View>
          <Ionicons name="chevron-forward" size={17} color={tc.textMuted} style={{ marginTop: 7 }} />
        </TouchableOpacity>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <TouchableOpacity
            testID="progress-plateau-review-button"
            accessibilityRole="button"
            accessibilityLabel="Review plateau recommendations"
            onPress={() => {
              import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
              setPlateauModalVisible(true);
            }}
            activeOpacity={0.86}
            style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9, backgroundColor: '#F59E0B' }}
          >
            <Text style={{ fontSize: 12, fontWeight: '900', color: '#111827' }}>Review</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="progress-plateau-dismiss"
            accessibilityRole="button"
            accessibilityLabel="Dismiss plateau watch"
            onPress={() => {
              AsyncStorage.setItem('plateauDismissedAt', String(Date.now())).catch(() => {});
              setPlateauDismissed(true);
            }}
            activeOpacity={0.82}
            style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9, borderWidth: 1, borderColor: tc.border, backgroundColor: tc.surface }}
          >
            <Text style={{ fontSize: 12, fontWeight: '800', color: tc.textSecondary }}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      </View>
    </FadeInView>
  ) : null;
  const openBiometricHistory = useCallback((key: HealthBiometricKey) => {
    import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
    setSelectedBiometric(key);
    setBiometricHistoryOpen(true);
  }, []);
  const healthVitalsOverviewCard = isProTier && isHealthKitAvailable() ? (() => {
    const hs = healthSummary;
    const hasAnyData = hasDisplayableHealthSummaryData(hs);

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
                }
                if (granted) {
                  import('../services/healthDataSummary')
                    .then(({ backfillSnapshotsToBackend, refreshHealthDataSummary }) => {
                      refreshHealthDataSummary({ age }).catch(() => null);
                      backfillSnapshotsToBackend(180).catch(() => null);
                    })
                    .catch(() => null);
                }
                const hasAny = hasDisplayableHealthSummaryData(fresh);
                if (granted && !hasAny) {
                  Alert.alert('Connected - waiting for data', 'Apple Health is connected. If this card stays empty, open iPhone Settings -> Privacy & Security -> Health -> Thallo and turn on the categories you want to share.');
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
        Alert.alert('Unable to open Settings', 'Go to iPhone Settings -> Privacy & Security -> Health -> Thallo manually.');
      });
    };

    if (!healthEnabled) {
      return (
        <HealthDataImageCard
          tc={tc}
          styles={styles}
          title={`${HEALTH_DATA_LABEL} is optional`}
          subtitle="Connect Apple Health or source apps when you want shared signals folded into Thallo."
          badge="Optional"
          iconName="heart-outline"
          imageUri={HEALTH_DATA_CONNECT_IMAGE}>
          <View style={{ alignItems: 'center', paddingVertical: 4 }}>
            <Text {...dynamicTextProps} style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center', lineHeight: 18, marginBottom: 14 }}>
              Optional sync for health categories that actually have data from your iPhone, Apple Watch, or connected apps. Missing categories stay hidden until Apple Health returns samples.{showWorkoutProgress ? ' Thallo can also write completed workout details back to Apple Health.' : ''}
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
        </HealthDataImageCard>
      );
    }

    if (!hasAnyData && (healthReading || healthConnecting)) {
      return (
        <HealthDataImageCard
          tc={tc}
          styles={styles}
          title={`Reading ${HEALTH_DATA_LABEL}`}
          subtitle="Pulling shared health samples that are available on this device."
          badge="Syncing"
          iconName="sync-outline"
          imageUri={HEALTH_DATA_SYNC_IMAGE}>
          <View style={{ alignItems: 'center', paddingVertical: 4 }}>
            <ActivityIndicator color={tc.primary} />
            <Text {...dynamicTextProps} style={{ fontSize: 12, color: tc.textSecondary, textAlign: 'center', lineHeight: 17, marginTop: 4 }}>
              This can take a moment. Rows only appear for categories Apple Health returns.
            </Text>
          </View>
        </HealthDataImageCard>
      );
    }

    if (!hasAnyData) {
      return (
        <HealthDataImageCard
          tc={tc}
          styles={styles}
          title={`No ${HEALTH_DATA_LABEL.toLowerCase()} data yet`}
          subtitle="Connected, but Apple Health has not returned displayable samples."
          badge="Empty"
          iconName="cloud-offline-outline"
          imageUri={HEALTH_DATA_EMPTY_IMAGE}>
          <View style={{ alignItems: 'center', paddingVertical: 4 }}>
            <Text {...dynamicTextProps} style={{ fontSize: 12, color: tc.textSecondary, textAlign: 'center', lineHeight: 17, marginBottom: 12 }}>
              Thallo still works normally. Tap Refresh to retry, or open iOS Settings to share categories that your iPhone, Apple Watch, or connected apps are recording.
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity
                style={{ backgroundColor: tc.primary, borderRadius: radius.md, paddingVertical: 10, paddingHorizontal: 22 }}
                disabled={healthConnecting}
                onPress={async () => {
                  setHealthConnecting(true);
                  healthLiveLoadedRef.current = false;
                  try {
                    const age = userProfile.physicalStats?.age ?? null;
                    const fresh = await readFreshProgressHealthSummary(age, true);
                    if (fresh) {
                      healthLiveLoadedRef.current = true;
                      setHealthSummary(fresh);
                      saveHealthSummary(fresh).catch(() => null);
                      loadProgressSleepHistory(authToken, fresh).then(setSleepHistory).catch(() => null);
                    } else {
                      Alert.alert(
                        'No Apple Health data returned',
                        'Apple Health did not return displayable samples this time. In iOS Settings -> Privacy & Security -> Health -> Thallo, share the categories your iPhone, Apple Watch, or connected apps are recording.',
                      );
                    }
                  } finally {
                    setHealthConnecting(false);
                  }
                }}
              >
                {healthConnecting
                  ? <ActivityIndicator color={getContrastingTextColor(tc.primary)} />
                  : <Text style={{ color: getContrastingTextColor(tc.primary), fontWeight: '700', fontSize: 13 }}>Refresh</Text>}
              </TouchableOpacity>
              <TouchableOpacity
                style={{ borderWidth: 1, borderColor: tc.border, borderRadius: radius.md, paddingVertical: 10, paddingHorizontal: 22 }}
                onPress={handleOpenSettings}
              >
                <Text style={{ color: tc.textPrimary, fontWeight: '600', fontSize: 13 }}>iOS Settings</Text>
              </TouchableOpacity>
            </View>
          </View>
        </HealthDataImageCard>
      );
    }

    const availableSignals = getHealthSummarySignalAvailability(hs);
    const medianOf = (xs: number[]): number | null => {
      const valid = xs.filter(v => Number.isFinite(v) && v > 0).slice().sort((a, b) => a - b);
      if (valid.length === 0) return null;
      const mid = Math.floor(valid.length / 2);
      return valid.length % 2 === 0 ? (valid[mid - 1] + valid[mid]) / 2 : valid[mid];
    };
    const recent30 = sleepHistory.slice(-30);
    const rhrBaseline30 = medianOf(recent30.map(n => Number(n.restingHr ?? 0)));
    const hrvBaseline30 = medianOf(recent30.map(n => Number(n.hrv ?? 0)));
    type HealthMetricTone = 'good' | 'onTrack' | 'below' | 'neutral';
    const metricTone = (trend: VitalTrendResult | null): HealthMetricTone => {
      if (trend?.trend === 'improving') return 'good';
      if (trend?.trend === 'onTrack') return 'onTrack';
      if (trend?.trend === 'monitor') return 'below';
      return 'neutral';
    };
    const toneColor = (tone: HealthMetricTone, fallback: string): string => {
      if (tone === 'good') return tc.success ?? '#22C55E';
      if (tone === 'onTrack') return tc.primary;
      if (tone === 'below') return tc.warning ?? '#F59E0B';
      return fallback;
    };
    const formatSleepDuration = (hours: number | null | undefined) => {
      if (hours == null || !Number.isFinite(hours) || hours <= 0) return null;
      const total = Math.round(hours * 60);
      const h = Math.floor(total / 60), m = total % 60;
      return m > 0 ? `${h}h ${m}m` : `${h}h`;
    };
    type HealthVitalOverviewItem = {
      key: string;
      icon: ComponentProps<typeof Ionicons>['name'];
      label: string;
      value: string | number | null;
      unit?: string;
      trend?: VitalTrendResult;
      historyKey?: HealthBiometricKey;
    };
    const items: HealthVitalOverviewItem[] = [];
    const addItem = (
      key: string,
      icon: ComponentProps<typeof Ionicons>['name'],
      label: string,
      value: string | number | null,
      unit?: string,
      trend?: VitalTrendResult,
      historyKey?: HealthBiometricKey,
    ) => {
      items.push({ key, icon, label, value, unit, trend, historyKey });
    };
    if (availableSignals.restingHeartRate) addItem('rhr', 'pulse-outline', 'Resting HR', hs!.restingHeartRate, 'bpm', classifyRestingHeartRate(hs!.restingHeartRate, rhrBaseline30), 'rhr');
    if (availableSignals.hrvAvg) addItem('hrv', 'analytics-outline', 'HRV', hs!.hrvAvg, 'ms', classifyHrv(hs!.hrvAvg, hrvBaseline30), 'hrv');
    if (availableSignals.avgSleepHours7d) addItem('sleep', 'moon-outline', 'Sleep avg', formatSleepDuration(hs!.avgSleepHours7d), undefined, classifyAvgSleepHours(hs!.avgSleepHours7d), 'sleep');
    if (availableSignals.avgSteps7d) addItem('steps', 'walk-outline', 'Steps avg', hs!.avgSteps7d, undefined, classifyAvgSteps(hs!.avgSteps7d), 'steps');
    if (availableSignals.activeEnergy7d) addItem('active-energy', 'flame-outline', 'Active calories', hs!.activeEnergy7d, 'kcal', classifyActiveEnergy(hs!.activeEnergy7d), 'active-energy');
    if (availableSignals.workouts) {
      const workouts = Array.isArray(hs?.workoutDetails) ? hs.workoutDetails : [];
      const minutes = workouts.reduce((sum, workout) => sum + (Number(workout.duration ?? 0) || 0), 0);
      addItem('workouts', 'fitness-outline', 'Workouts', workouts.length, minutes > 0 ? `${Math.round(minutes)} min` : undefined, undefined, 'workouts');
    }
    if (availableSignals.vo2Max) addItem('vo2', 'speedometer-outline', 'VO2 Max', Math.round(hs!.vo2Max! * 10) / 10, 'ml/kg/min', undefined, 'vo2');
    if (availableSignals.respiratoryRate) addItem('respiratory', 'leaf-outline', 'Respiratory rate', hs!.respiratoryRate, 'brpm');
    if (availableSignals.oxygenSaturation) addItem('oxygen', 'water-outline', 'Blood oxygen', hs!.oxygenSaturation, '%');
    if (availableSignals.standingHours7d) addItem('standing', 'body-outline', 'Standing hours', hs!.standingHours7d, 'hrs');
    if (availableSignals.mindfulMinutes7d) addItem('mindful', 'flower-outline', 'Mindful minutes', hs!.mindfulMinutes7d, 'min');
    if (availableSignals.basalEnergy7d) addItem('basal', 'flash-outline', 'Basal energy', hs!.basalEnergy7d, 'kcal');

    if (items.length === 0) return null;

    const mainBiometricKeys = new Set(['rhr', 'hrv', 'sleep', 'steps']);
    const orderedOverviewItems = [
      ...items.filter(item => mainBiometricKeys.has(item.key)),
      ...items.filter(item => !mainBiometricKeys.has(item.key)),
    ];
    const collapsedItems = orderedOverviewItems.slice(0, 4);
    const visibleItems = healthBiometricsExpanded ? orderedOverviewItems : collapsedItems;
    const hiddenBiometricCount = Math.max(0, orderedOverviewItems.length - collapsedItems.length);
    const signalPctFor = (trend: VitalTrendResult | null, index: number): number => {
      if (trend?.trend === 'improving') return 88;
      if (trend?.trend === 'onTrack') return 72;
      if (trend?.trend === 'monitor') return 46;
      return 58 + ((index % 3) * 7);
    };

    return (
      <HealthDataImageCard
        tc={tc}
        styles={styles}
        title={HEALTH_DATA_LABEL}
        subtitle="Rolling 7-day snapshot from shared signals Apple Health returned."
        badge="7D"
        iconName="heart-outline"
        imageUri={HEALTH_DATA_READY_IMAGE}>
        <View style={styles.healthVitalsOverviewGrid}>
          {visibleItems.map((item, index) => {
            const trend = item.trend?.trend ? item.trend : null;
            const tone = metricTone(trend);
            const neutralColor = item.historyKey ? BIOMETRIC_HISTORY_CONFIG[item.historyKey].accent : tc.textMuted;
            const color = toneColor(tone, neutralColor);
            const canOpenHistory = item.historyKey != null;
            const signalPct = signalPctFor(trend, index);
            const status = biometricStatusFromTrend(item.trend, item.value != null);
            const statusColor =
              status.tone === 'good' ? (tc.success ?? '#22C55E')
              : status.tone === 'onTrack' ? tc.primary
              : status.tone === 'monitor' ? (tc.warning ?? '#F59E0B')
              : status.tone === 'waiting' ? tc.textMuted
              : neutralColor;
            return (
              <AnimatedPressable
                key={item.key}
                disabled={!canOpenHistory}
                onPress={() => {
                  if (item.historyKey) openBiometricHistory(item.historyKey);
                }}
                scaleDown={0.975}
                accessibilityRole={canOpenHistory ? 'button' : undefined}
                accessibilityLabel={canOpenHistory ? `${item.label} history. ${status.label}${item.trend?.label ? `, ${item.trend.label}` : ''}` : undefined}
                style={[styles.healthVitalsOverviewRow, { backgroundColor: tc.surfaceRaised, borderColor: color + (tone === 'neutral' ? '28' : '4A') }]}
              >
                {/* Gradient wash + colored gradient + sliding sheen removed
                    per design — biometric tiles stay flat; only the pulse
                    glyph animates. */}
                <View style={styles.healthVitalsOverviewTopRow}>
                  <HealthPulseGlyph
                    iconName={item.icon}
                    iconSize={15}
                    color={color}
                    delay={staggerDelay(index, 70)}
                    style={[styles.healthVitalsOverviewIcon, { backgroundColor: color + '18' }]}
                  />
                  <View style={styles.healthVitalsOverviewStatusRail}>
                    <View style={[styles.healthVitalsStatusPill, { backgroundColor: statusColor + '16', borderColor: statusColor + '44' }]}>
                      <Text style={[styles.healthVitalsStatusText, { color: statusColor }]} numberOfLines={1}>
                        {status.label}
                      </Text>
                    </View>
                    {canOpenHistory ? <Ionicons name="chevron-forward" size={14} color={tc.textMuted} /> : null}
                  </View>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[styles.healthVitalsOverviewLabel, { color: tc.textMuted }]} numberOfLines={2}>{item.label}</Text>
                  <Text style={[styles.healthVitalsOverviewValue, { color: item.value != null ? tc.textPrimary : tc.textMuted }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78}>
                    {item.value != null ? (typeof item.value === 'number' ? item.value.toLocaleString() : item.value) : '--'}
                  </Text>
                  {item.value != null && item.unit ? (
                    <Text style={[styles.healthVitalsOverviewUnit, { color: tc.textMuted }]} numberOfLines={1}>
                      {item.unit}
                    </Text>
                  ) : null}
                  {trend ? (
                    <View style={styles.healthVitalsTrendRow}>
                      <View style={[styles.healthVitalsTrendDot, { backgroundColor: color }]} />
                      <Text style={[styles.healthVitalsTrendText, { color }]} numberOfLines={1}>{trend.label}</Text>
                    </View>
                  ) : null}
                </View>
                <View style={[styles.healthVitalsSignalLine, { backgroundColor: color + '22' }]}>
                  <AnimatedProgressFill
                    pct={signalPct}
                    color={color}
                    minPct={18}
                    delay={staggerDelay(index, 50)}
                    duration={520}
                    style={styles.healthVitalsSignalFill}
                  />
                </View>
              </AnimatedPressable>
            );
          })}
        </View>
        {hiddenBiometricCount > 0 ? (
          <TouchableOpacity
            activeOpacity={0.78}
            onPress={() => {
              configureExpandAnimation(300);
              setHealthBiometricsExpanded(prev => !prev);
            }}
            style={[styles.healthVitalsOverviewMoreButton, { borderColor: tc.border, backgroundColor: tc.surfaceRaised }]}
          >
            <Text style={[styles.healthVitalsOverviewMoreText, { color: tc.textSecondary }]}>
              {healthBiometricsExpanded ? 'Show main biometrics' : `Show ${hiddenBiometricCount} more biometrics`}
            </Text>
            <Ionicons name={healthBiometricsExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={tc.textMuted} />
          </TouchableOpacity>
        ) : null}
      </HealthDataImageCard>
    );
  })() : null;
  const planWeekZones = useMemo(() => {
    const current = buildHrZoneSourceBreakdown(summaries, progressWeekWindow.startDate, progressWeekWindow.endDate);
    const previous = buildHrZoneSourceBreakdown(summaries, progressWeekWindow.previousStartDate, progressWeekWindow.previousEndDate);
    return {
      current: current.zoneMinutes,
      contributors: current.contributors,
      zone2Current: Math.round(current.zoneMinutes[1]),
      zone2Previous: Math.round(previous.zoneMinutes[1]),
    };
  }, [progressWeekWindow, summaries]);
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
    () => showWorkoutProgress ? buildTrainingSignals(history, summaries, isHealthKitAvailable(), healthEnabled) : [],
    [healthEnabled, history, showWorkoutProgress, summaries],
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
  const visiblePrsForTab = useMemo(
    () => filteredPrsForTab.slice(0, visiblePrCount),
    [filteredPrsForTab, visiblePrCount],
  );

  useEffect(() => {
    setVisiblePrCount(40);
  }, [prFocusFilter, prSearch]);

  useEffect(() => {
    if (!visibleProgressTabs.some(([key]) => key === tab)) {
      selectProgressTab('today');
    }
  }, [selectProgressTab, tab, visibleProgressTabs]);

  useEffect(() => {
    if (!showWorkoutProgress || tab !== 'trends') return;
    if (filteredChartExercises.length === 0) {
      if (selectedExercise) setSelectedExercise(null);
      return;
    }
    const stillVisible = selectedExercise
      ? filteredChartExercises.some(option => option.name === selectedExercise)
      : false;
    if (!stillVisible) setSelectedExercise(filteredChartExercises[0].name);
  }, [filteredChartExercises, selectedExercise, showWorkoutProgress, tab]);

  useEffect(() => {
    if (!showWorkoutProgress || tab !== 'trends') return;
    if (paceExerciseGroups.length === 0) {
      if (selectedCardioExercise) setSelectedCardioExercise(null);
      return;
    }
    const stillVisible = selectedCardioExercise
      ? paceExerciseGroups.some(group => group.key === selectedCardioExercise)
      : false;
    if (!stillVisible) setSelectedCardioExercise(paceExerciseGroups[0].key);
  }, [paceExerciseGroups, selectedCardioExercise, showWorkoutProgress, tab]);

  useEffect(() => {
    if (!isActive) return;
    if (!showWorkoutProgress) return;
    if (tab === 'trends' && authToken && !paceLoadedRef.current) {
      paceLoadedRef.current = true;
      getPaceHistory(authToken).then(r => setPaceHistory(r.points)).catch(() => {});
    }
  }, [tab, authToken, isActive, showWorkoutProgress]);

  const progressHydratedRef = useRef(false);
  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    // Only show the full skeleton on the very first hydration. On
    // re-activation (tab away→back) we already have data rendered, so
    // refresh in the background instead of flashing the skeleton and
    // dropping the list.
    if (!progressHydratedRef.current) setLoading(true);
    (async () => {
      const localProgressPromise = Promise.allSettled([
        loadWorkoutHistory(),
        loadWorkoutSummaries(),
        loadGoalHistory(),
        loadPlanChanges(),
      ]);
      const serverProgressPromise = authToken
        ? Promise.allSettled([
            listWorkoutSessions(authToken, {
              limit: PROGRESS_SERVER_SESSION_LIMIT,
              skip: 0,
              fresh: true,
              timeoutMs: PROGRESS_SERVER_HYDRATE_TIMEOUT_MS,
              noRetry: true,
            }),
            listWorkoutCompletions(authToken, {
              limit: PROGRESS_SERVER_COMPLETION_LIMIT,
              skip: 0,
              fresh: true,
              timeoutMs: PROGRESS_SERVER_HYDRATE_TIMEOUT_MS,
              noRetry: true,
            }),
          ])
        : null;
      const [historyResult, summaryResult, goalResult, planChangeResult] = await localProgressPromise;
      if (cancelled) return;
      progressHydratedRef.current = true;

      const localHistory = historyResult.status === 'fulfilled' ? historyResult.value : [];
      const localSummaries = summaryResult.status === 'fulfilled' ? summaryResult.value : [];
      const localGoals = goalResult.status === 'fulfilled' ? goalResult.value : [];
      const localPlanChanges = planChangeResult.status === 'fulfilled' ? planChangeResult.value : [];

      setGoalHistory(localGoals);
      setPlanChanges(localPlanChanges);

      if (!serverProgressPromise) {
        setPrs(derivePersonalRecords(localHistory));
        setHistory(localHistory);
        setSummaries(localSummaries);
        setLoading(false);
        return;
      }

      const [serverSessionsResult, completionsResult] = await serverProgressPromise;
      if (cancelled) return;
      const serverSessions = serverSessionsResult.status === 'fulfilled' ? serverSessionsResult.value : null;
      const completions = completionsResult.status === 'fulfilled' ? completionsResult.value : null;
      if (!serverSessions && !completions) {
        setPrs(derivePersonalRecords(localHistory));
        setHistory(localHistory);
        setSummaries(localSummaries);
        setLoading(false);
        return;
      }

      const historyWithServerSets = mergeWorkoutSessionSources(localHistory, serverSessions);
      const scoped = reconcileWorkoutProgressData(historyWithServerSets, localSummaries, completions);
      setPrs(derivePersonalRecords(scoped.history));
      setHistory(scoped.history);
      setSummaries(scoped.summaries);
      setLoading(false);
      if (completions) {
        AsyncStorage.setItem('workoutHistory', JSON.stringify(scoped.history.slice(0, 100))).catch(() => {});
        AsyncStorage.setItem('workoutSummaries', JSON.stringify(scoped.summaries.slice(0, 100))).catch(() => {});
      }
    })().catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [authToken, isActive]);

  useEffect(() => {
    let cancelled = false;
    if (!isActive || !authToken || !showMixedGoalProgress) {
      setGoalScore(null);
      return () => { cancelled = true; };
    }
    getGoalScores(authToken, { window: 'rolling_7d' })
      .then(response => {
        if (!cancelled) setGoalScore(response.scores?.[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setGoalScore(null);
      });
    return () => { cancelled = true; };
  }, [
    authToken,
    isActive,
    showMixedGoalProgress,
    userProfile.goal,
    nutritionLogRefreshKey,
    history.length,
    summaries.length,
    bodyScanHistory.length,
    healthSummary?.avgSleepHours7d,
  ]);

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    import('../utils/weightHistory').then(({ loadWeightHistory }) =>
      loadWeightHistory()
        .then((history) => {
          if (cancelled) return;
          setWeightEntries(history);
        })
        .catch(() => null)
        .finally(() => {
          if (!cancelled) setWeightEntriesLoaded(true);
        })
    );
    return () => { cancelled = true; };
  }, [authToken, isActive]);

  useEffect(() => {
    if (!isActive || !authToken) {
      setInsights(null);
      setGuardrails([]);
      setCoachMemory([]);
      return;
    }
    // Coach insights only surface on the Today + Insights tabs — don't
    // pay for these network calls on a cold open of Trends/Body/Health.
    if (tab !== 'today' && tab !== 'insights') return;
    getInsights(authToken).then(setInsights).catch(() => null);
    getGuardrails(authToken).then(r => setGuardrails(r.warnings ?? [])).catch(() => null);
    if (isProTier) {
      getCoachMemory(authToken).then((rows: any[]) => setCoachMemory(rows.slice(0, 5))).catch(() => null);
    } else {
      setCoachMemory([]);
    }
  }, [authToken, isActive, isProTier, tab]);

  useEffect(() => {
    if (!isActive || !authToken || !isProTier || !showWorkoutProgress || prs.length === 0 || tab !== 'trends') {
      setProgressionHint('');
      return;
    }
    getProgressionInsights(authToken, prs[0].exerciseName)
      .then((r: any) => setProgressionHint(r?.suggestion ?? ''))
      .catch(() => null);
  }, [authToken, isActive, isProTier, prs, showWorkoutProgress, tab]);

  useEffect(() => {
    if (!isActive || !authToken || !isProTier || !showWorkoutProgress) {
      setMuscleFatigue(null);
      return;
    }
    import('../services/api').then(({ getFatigueScore }) => {
      getFatigueScore(authToken).then(fs => setMuscleFatigue({
        score: fs.muscle_recovery_score ?? fs.readiness_score,
        label: fs.muscle_recovery_label ?? fs.readiness_label,
        topFatigued: fs.top_fatigued ?? [], muscleFatigue: fs.muscle_fatigue ?? {},
      })).catch(() => null);
    });
  }, [authToken, isActive, isProTier, showWorkoutProgress]);

  useEffect(() => {
    if (!isActive || !authToken || !isProTier || !showWorkoutProgress) {
      setOneRepMaxLifts([]);
      setTopLiftHistory(null);
      setPlateaus([]);
      setPlateauDismissed(true);
      setBulkE1RMMap({});
      setMuscleBalance(null);
      return;
    }
    if (tab !== 'trends' && tab !== 'insights') return;
    import('../services/api').then(({ getOneRepMaxShowcase, getE1RMHistory }) =>
      getOneRepMaxShowcase(authToken)
        .then(async (lifts) => {
          setOneRepMaxLifts(lifts);
          // After the bar list resolves, fetch history for the top lift only.
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
    import('../services/api').then(({ getAllE1RM }) =>
      getAllE1RM(authToken)
        .then(r => setBulkE1RMMap(r?.exercises ?? {}))
        .catch(() => setBulkE1RMMap({}))
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
    import('../services/api').then(({ getMuscleBalance }) =>
      getMuscleBalance(authToken, MUSCLE_DISTRIBUTION_WINDOW_DAYS).then(setMuscleBalance).catch(() => null)
    );
  }, [authToken, isActive, isProTier, showWorkoutProgress, tab]);

  useEffect(() => {
    const shouldLoadMealData =
      isActive && !!authToken && showMealProgress && (tab === 'today' || tab === 'health' || tab === 'insights');
    if (!shouldLoadMealData) {
      if (!showMealProgress || !authToken) {
        setMealAverages(null);
        setMealHistory(null);
        setNutritionScoreWeekly(null);
        setGutHealthWindow(null);
      }
      return;
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
      import('../services/api').then(({ getNutritionScore }) =>
        getNutritionScore(authToken, 14)
          .then(r => setNutritionScoreWeekly(r.weekly ?? null))
          .catch(() => setNutritionScoreWeekly(null))
      );
      import('../services/api').then(({ getGutHealth }) =>
        getGutHealth(authToken, 14).then(r => {
          setGutHealthWindow(r.window);
        }).catch(() => null)
      );
    } else {
      setNutritionScoreWeekly(null);
      setGutHealthWindow(null);
    }
  }, [authToken, isActive, isProTier, showMealProgress, tab]);

  useEffect(() => {
    if (isProTier) return;
    setBodyScanHistory([]);
    bodyScanHistoryLoadedRef.current = false;
    healthLiveLoadedRef.current = false;
    setHealthEnabled(false);
    setHealthSummary(null);
    setHealthScore(null);
    setNutritionScoreWeekly(null);
    setMuscleBalance(null);
    setGutHealthWindow(null);
  }, [isProTier]);

  useEffect(() => {
    if (!isActive || tab !== 'health' || !isProTier || !showMealProgress) {
      setGutInsights(null);
      return;
    }
    let cancelled = false;
    // ── Gut / longevity insights — compute from existing meal data ──
    (async () => {
      try {
        const today = new Date();
        const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const plansByDate: Record<string, import('../types').DailyNutritionPlan> = {};
        const checksByDate: Record<string, Record<string, boolean>> = {};
        const dayKeys: string[] = [];
        for (let i = 0; i < 7; i++) {
          const d = new Date(today.getTime() - i * 86400000);
          dayKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
        }
        // Batch the week's reads instead of 14 serial AsyncStorage /
        // getMealChecks round-trips.
        const [planRaws, checkResults] = await Promise.all([
          AsyncStorage.multiGet(dayKeys.map(k => `mealPlan_${k}`)),
          Promise.all(dayKeys.map(k => getMealChecks(k).catch(() => ({})))),
        ]);
        planRaws.forEach(([, raw], idx) => {
          if (raw) { try { plansByDate[dayKeys[idx]] = JSON.parse(raw); } catch {} }
        });
        dayKeys.forEach((k, idx) => { checksByDate[k] = checkResults[idx]; });
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

        if (cancelled) return;
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
    return () => { cancelled = true; };
  }, [isActive, isProTier, nutritionPlan, showMealProgress, tab, userProfile.goal, userProfile.physicalStats?.age, userProfile.physicalStats?.gender]);

  useEffect(() => {
    if (!isActive || !isProTier || (tab !== 'today' && tab !== 'health')) return;
    // Cheap cached values are okay on mount; live HealthKit refresh kicks
    // off as soon as Progress is active so sleep is ready on Today too.
    loadHealthSummary().then(setHealthSummary);
    loadHealthScore().then(setHealthScore);
  }, [isActive, isProTier, tab]);

  useEffect(() => {
    // Also load body scans on the Today tab — the goal-execution card lives
    // there and depends on bodyScanHistory; without this, the card would
    // render empty body scans first and then "switch" to correct numbers once
    // the user visited the Body tab.
    if (!isActive || (tab !== 'body' && tab !== 'today') || !isProTier || bodyScanHistoryLoadedRef.current) return;
    bodyScanHistoryLoadedRef.current = true;
    let cancelled = false;
    AsyncStorage.getItem(BODY_SCAN_CACHE_KEY).then(async raw => {
      const RECENT_CAP = 20;
      const parsed = raw ? JSON.parse(raw) : [];
      const localRows = Array.isArray(parsed) ? parsed : [];
      const local: BodyScanEntry[] = localRows
        .map(normalizeBodyScanEntry)
        .filter((entry: BodyScanEntry | null): entry is BodyScanEntry => entry != null);
      const localOnly = local.filter(entry => !bodyScanHasServerId(entry));
      if (localOnly.length > 0) {
        await quarantineLegacyBodyScans(localOnly, 'bodyScanHistory local-only row ignored; DB is canonical');
      }
      const localSorted = onlyServerBackedBodyScans(local).sort((a, b) => bodyScanSortValue(b) - bodyScanSortValue(a));
      if (localOnly.length > 0) {
        await AsyncStorage.setItem(BODY_SCAN_CACHE_KEY, JSON.stringify(localSorted));
      }
      if (!cancelled && localSorted.length > 0) setBodyScanHistory(localSorted.slice(0, RECENT_CAP));
      if (authToken) {
        try {
          const { getBodyScanHistory } = await import('../services/api');
          const remote = (await getBodyScanHistory(authToken))
            .map(normalizeBodyScanEntry)
            .filter((entry: BodyScanEntry | null): entry is BodyScanEntry => entry != null);
          if (cancelled) return;
          const sorted = onlyServerBackedBodyScans(remote)
            .sort((a, b) => bodyScanSortValue(b) - bodyScanSortValue(a));
          setBodyScanHistory(sorted.slice(0, RECENT_CAP));
          await AsyncStorage.setItem(BODY_SCAN_CACHE_KEY, JSON.stringify(sorted));
        } catch { /* non-fatal */ }
      }
    })
      .catch(() => {})
      .finally(() => { if (!cancelled) setBodyScanLoaded(true); });
    return () => { cancelled = true; };
  }, [authToken, isActive, isProTier, tab]);

  useEffect(() => {
    if (!authToken || !isActive) return;
    let cancelled = false;
    getCalorieRanges(authToken)
      .then(r => { if (!cancelled) setCalorieRanges(r); })
      .catch(() => { if (!cancelled) setCalorieRanges(null); });
    return () => { cancelled = true; };
  }, [authToken, isActive, userProfile.goal, userProfile.goalDetails?.pace, userProfile.physicalStats?.weightLbs, userProfile.physicalStats?.age, userProfile.physicalStats?.gender, userProfile.daysPerWeek]);

  useEffect(() => {
    if (!isActive || !isProTier) return;
    // Only short-circuit when we've successfully loaded today's data
    // already. Pre-fix this ref flipped to true on every entry to the
    // tab — including when the underlying fetch failed or produced no
    // summary — so a user landing on a stale cache would never see a
    // refresh. Now we re-attempt whenever there's no fresh summary.
    if (healthLiveLoadedRef.current) return;
    let cancelled = false;
    const task = InteractionManager.runAfterInteractions(() => {
      if (cancelled) return;
      setHealthReading(true);
      void (async () => {
        try {
          if (!isHealthKitAvailable()) return;
          const enabled = await isAppleHealthEnabled();
          if (cancelled) return;
          setHealthEnabled(enabled);
          if (!enabled) return;
          const age = userProfile.physicalStats?.age ?? null;
          const fresh = await readFreshProgressHealthSummary(age, true);
          if (cancelled || !fresh) return;
          // Mark the cache hot only after a successful read. A failed or
          // empty read leaves the ref unset so the next active refresh retries
          // — which is what the user expected when iOS Settings shows
          // HealthKit as authorized but the app shows no data.
          healthLiveLoadedRef.current = true;
          setHealthSummary(fresh);
          saveHealthSummary(fresh).catch(() => null);
          try {
            const { pushSleepToWatch, buildWatchSleepPayloadFromSummary } = await import('../utils/watchSync');
            await pushSleepToWatch(buildWatchSleepPayloadFromSummary(fresh as any));
          } catch { /* watch may be unavailable */ }
          try {
            setSleepHistory(await loadProgressSleepHistory(authToken, fresh));
          } catch {}
        } catch {
        } finally {
          if (!cancelled) setHealthReading(false);
        }
      })();
    });
    return () => { cancelled = true; task.cancel?.(); setHealthReading(false); };
  }, [authToken, isActive, isProTier, userProfile.physicalStats?.age]);

  useEffect(() => {
    if (!authToken || !isActive || !isProTier) {
      setSleepPressure(null);
      return;
    }
    let cancelled = false;
    import('../services/api').then(({ getSleepPressure }) => {
      getSleepPressure(authToken, 14)
        .then(result => { if (!cancelled) setSleepPressure(result); })
        .catch(() => { if (!cancelled) setSleepPressure(null); });
    }).catch(() => { if (!cancelled) setSleepPressure(null); });
    return () => { cancelled = true; };
  }, [authToken, healthSummary?.sleepScore?.score, isActive, isProTier, sleepHistory.length]);

  useEffect(() => {
    if (!biometricHistoryOpen || !selectedBiometric || !authToken || !isProTier) return;
    if (selectedBiometric === 'sleep') return;
    if (dailyHealthHistory && dailyHealthHistoryDays >= biometricHistoryWindow) return;
    let cancelled = false;
    setDailyHealthHistoryLoading(true);
    import('../services/api').then(({ getDailyHealthHistory }) => {
      getDailyHealthHistory(authToken, biometricHistoryWindow)
        .then(rows => {
          if (cancelled) return;
          setDailyHealthHistory(Array.isArray(rows) ? rows : []);
          setDailyHealthHistoryDays(biometricHistoryWindow);
        })
        .catch(() => {
          if (!cancelled) {
            setDailyHealthHistory([]);
            setDailyHealthHistoryDays(biometricHistoryWindow);
          }
        })
        .finally(() => {
          if (!cancelled) setDailyHealthHistoryLoading(false);
        });
    }).catch(() => {
      if (!cancelled) {
        setDailyHealthHistory([]);
        setDailyHealthHistoryDays(biometricHistoryWindow);
        setDailyHealthHistoryLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [
    authToken,
    biometricHistoryOpen,
    biometricHistoryWindow,
    dailyHealthHistory,
    dailyHealthHistoryDays,
    isProTier,
    selectedBiometric,
  ]);

  useEffect(() => {
    if (!isActive || tab !== 'today' || !authToken || !isProTier || !showWorkoutProgress) return;
    if (dailyHealthHistory && dailyHealthHistoryDays >= GOAL_EXECUTION_BLOCK_DAYS) return;
    let cancelled = false;
    setDailyHealthHistoryLoading(true);
    import('../services/api').then(({ getDailyHealthHistory }) => {
      getDailyHealthHistory(authToken, GOAL_EXECUTION_BLOCK_DAYS)
        .then(rows => {
          if (cancelled) return;
          setDailyHealthHistory(Array.isArray(rows) ? rows : []);
          setDailyHealthHistoryDays(GOAL_EXECUTION_BLOCK_DAYS);
        })
        .catch(() => {
          if (!cancelled) {
            setDailyHealthHistory([]);
            setDailyHealthHistoryDays(GOAL_EXECUTION_BLOCK_DAYS);
          }
        })
        .finally(() => {
          if (!cancelled) setDailyHealthHistoryLoading(false);
        });
    }).catch(() => {
      if (!cancelled) {
        setDailyHealthHistory([]);
        setDailyHealthHistoryDays(GOAL_EXECUTION_BLOCK_DAYS);
        setDailyHealthHistoryLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [
    authToken,
    dailyHealthHistory,
    dailyHealthHistoryDays,
    isActive,
    isProTier,
    showWorkoutProgress,
    tab,
  ]);

  useEffect(() => {
    if (!isActive || tab !== 'health' || !isProTier || !showMealProgress) return;
    let cancelled = false;
    (async () => {
      try {
        if (!isHealthKitAvailable()) return;
        const enabled = await isAppleHealthEnabled();
        if (cancelled || !enabled) {
          if (!cancelled) setAppleNutritionSnapshot(null);
          return;
        }
        const snapshot = await refreshAppleNutritionSnapshot();
        if (!cancelled) setAppleNutritionSnapshot(snapshot);
      } catch {
        if (!cancelled) setAppleNutritionSnapshot(null);
      }
    })();
    return () => { cancelled = true; };
  }, [isActive, isProTier, refreshAppleNutritionSnapshot, showMealProgress, tab]);

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
    if (!isActive) return;
    if (nutritionRefreshSeenRef.current === nutritionLogRefreshKey) return;
    nutritionRefreshSeenRef.current = nutritionLogRefreshKey;
    if (!showMealProgress) {
      setMealAverages(null);
      setMealHistory(null);
      setNutritionScoreWeekly(null);
      setGutHealthWindow(null);
      return;
    }
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
        setNutritionScoreWeekly(null);
        setGutHealthWindow(null);
        return;
      }

      const [score, gut] = await Promise.all([
        api.getNutritionScore(authToken, 14).catch(() => undefined),
        api.getGutHealth(authToken, 14).catch(() => undefined),
      ]);
      if (cancelled) return;
      if (score) setNutritionScoreWeekly(score.weekly ?? null);
      if (gut) setGutHealthWindow(gut.window);
    })().catch(() => {});

    return () => { cancelled = true; };
  }, [authToken, isActive, isProTier, nutritionLogRefreshKey, showMealProgress]);

  const handleShareBodyScan = async () => {
    try {
      const ref = bodyScanShareRef.current as any;
      if (!ref?.capture) return;
      const uri = await ref.capture();
      const Sharing = await import('expo-sharing');
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

  const handleDeleteBodyScan = (entry: BodyScanEntry) => {
    const targetKey = bodyScanMergeKey(entry);
    Alert.alert(
      'Delete this scan?',
      'Removes this body scan from your history. Your weight, measurements, and workout data stay unchanged.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              if (!bodyScanHasServerId(entry)) {
                await quarantineLegacyBodyScans([entry], 'bodyScanHistory local-only delete ignored by DB');
              } else {
                if (!authToken) throw new Error('Sign in required to delete body scans.');
                const { deleteBodyScan } = await import('../services/api');
                await deleteBodyScan(authToken, entry.id);
              }
              const updated = bodyScanHistory.filter(e =>
                bodyScanMergeKey(e) !== targetKey && String(e.id) !== String(entry.id)
              );
              setBodyScanHistory(updated);
              await AsyncStorage.setItem(BODY_SCAN_CACHE_KEY, JSON.stringify(onlyServerBackedBodyScans(updated)));
              if (String(bodyScanResult?.id ?? '') === String(entry.id)) {
                setBodyScanResult(null);
              }
              import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
            } catch (e: any) {
              Alert.alert('Could not delete scan', String(e?.message ?? e));
            }
          },
        },
      ],
    );
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
      const Sharing = await import('expo-sharing');
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
      // Permission gate — without an explicit request iOS silently
      // returns `{canceled: true}` on a previously-denied prompt
      // (library "does nothing") and the auto-prompt path can crash
      // launchCameraAsync under SDK 54. Mirrors the gear / profile
      // photo flows.
      if (source === 'camera') {
        const cam = await ImagePicker.requestCameraPermissionsAsync();
        if (!cam.granted) {
          Alert.alert(
            'Camera permission needed',
            'Allow camera access in Settings to take a body scan photo.',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Open Settings', onPress: () => Linking.openSettings().catch(() => {}) },
            ],
          );
          return;
        }
      } else {
        const lib = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!lib.granted) {
          Alert.alert(
            'Photo access needed',
            'Allow photo library access in Settings to choose a body scan photo.',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Open Settings', onPress: () => Linking.openSettings().catch(() => {}) },
            ],
          );
          return;
        }
      }
      // Quality choice — the prior 0.7 + the (silently-ignored)
      // maxWidth/maxHeight props produced 4–8 MB base64 strings on
      // recent iPhones. JSON.stringify on those + the RN bridge
      // marshalling crashed the app (OOM) on lower-RAM devices.
      // 0.4 lands the encoded image around 800 KB – 1.5 MB which the
      // bridge handles cleanly. Vision quality stays good enough for
      // body-fat estimation; the model is forgiving on JPEG artifacts.
      const opts = {
        mediaTypes: 'images' as any,
        base64: true,
        quality: 0.4,
      };
      const result = source === 'camera'
        ? await ImagePicker.launchCameraAsync(opts)
        : await ImagePicker.launchImageLibraryAsync(opts);
      if (result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset || !asset.base64) {
        // Library path occasionally returns assets with a URI but no
        // base64 (Photos privacy mode, iCloud-only items not yet
        // downloaded, certain HEIC sources). The picker doesn't error
        // — it just hands back an unusable asset — so we have to
        // surface this ourselves rather than firing a malformed
        // upload that the backend then rejects with a 400.
        Alert.alert(
          'Couldn’t read that photo',
          source === 'library'
            ? 'That photo couldn’t be loaded. It may still be syncing from iCloud, or it’s in a format we can’t read. Try a different photo, or take a new one with the camera.'
            : 'The camera didn’t return a usable photo. Please try again.',
        );
        return;
      }

      // Sanitize the base64 before upload. Two real-world failure modes
      // we've seen on the library path:
      //   • Some sources include a data URL prefix
      //     ("data:image/jpeg;base64,/9j/...") which the backend's
      //     magic-byte sniff in `_fix_image_mime` can't decode.
      //   • Some HEIC re-encodes inject whitespace / newlines into the
      //     base64 stream during the bridge marshalling, which Python
      //     base64 also rejects.
      // Both crash the backend at decode-time and bubble up as a
      // generic 400/500 on the client. Strip them defensively here.
      let base64 = asset.base64;
      const prefixMatch = base64.match(/^data:image\/[a-z+.-]+;base64,/i);
      if (prefixMatch) base64 = base64.slice(prefixMatch[0].length);
      base64 = base64.replace(/\s+/g, '');

      // Defensive guard — if even after quality=0.4 the base64 is over
      // ~3 MB (4 million chars), bail with a friendly message rather
      // than letting JSON.stringify + the native bridge crash. This
      // can happen with very high-resolution source images from photo
      // library (the camera path tops out lower).
      const MAX_BASE64_CHARS = 4_000_000;
      if (base64.length > MAX_BASE64_CHARS) {
        Alert.alert(
          'Photo too large',
          'That image is bigger than we can upload safely. Take a fresh photo with the camera, or pick a different photo from your library.',
        );
        return;
      }
      if (base64.length < 100) {
        // Could happen if the picker returns a corrupt empty asset —
        // catch it before it round-trips to a useless 400.
        Alert.alert(
          'Couldn’t read that photo',
          'The photo data appears to be empty. Try a different photo, or take a new one with the camera.',
        );
        return;
      }

      setBodyScanLoading(true);
      setBodyScanResult(null);
      const stats = userProfile.physicalStats;
      const heightInches = (stats.heightFeet ?? 0) * 12 + (stats.heightInches ?? 0);

      const scanResult = await scanBody(authToken, {
        image_base64: base64,
        mime_type: 'image/jpeg',
        gender: stats.gender,
        weight_lbs: stats.weightLbs,
        height_inches: heightInches > 0 ? heightInches : undefined,
        age: stats.age,
      });
      if (!scanResult.id) {
        throw new Error('The scan was analyzed but was not saved to your account. Please try again.');
      }
      setBodyScanResult(scanResult);

      // Save to history
      const entry: BodyScanEntry = {
        id: String(scanResult.id),
        date: scanResult.date ?? scanResult.scan_date ?? new Date().toISOString(),
        photoUri: asset.uri,
        bodyFatPct: scanResult.bodyFatPct,
        bodyFatRange: scanResult.bodyFatRange,
        muscleMass: scanResult.muscleMass,
        category: scanResult.category,
        strengths: scanResult.strengths,
        improvements: scanResult.improvements,
        assessment: scanResult.assessment,
        confidence: scanResult.confidence,
        photoQuality: scanResult.photoQuality,
        qualityFlags: scanResult.qualityFlags ?? [],
        needsRetake: scanResult.needsRetake,
        sensitivePhoto: Boolean(scanResult.sensitivePhoto),
        photoHidden: Boolean(scanResult.photoHidden || scanResult.sensitivePhoto),
        method: scanResult.method,
        visualEstimatePct: scanResult.visualEstimatePct ?? null,
        measurementEstimatePct: scanResult.measurementEstimatePct ?? null,
        weightLbs: stats.weightLbs,
      };
      const updated = [entry, ...onlyServerBackedBodyScans(bodyScanHistory).filter(existing => String(existing.id) !== String(entry.id))].slice(0, 20);
      setBodyScanHistory(updated);
      await AsyncStorage.setItem(BODY_SCAN_CACHE_KEY, JSON.stringify(updated));
    } catch (e: any) {
      const detail: string = e?.message || 'Could not complete the body scan.';
      // Most common failure mode is a server-side rejection of the
      // image (4xx) — surface the actual detail so the user can act on
      // it, and give a one-tap fallback to the alternative source.
      const altSource: 'camera' | 'library' = source === 'library' ? 'camera' : 'library';
      Alert.alert(
        'Scan failed',
        detail,
        [
          { text: 'OK', style: 'cancel' },
          {
            text: altSource === 'camera' ? 'Try camera' : 'Try library',
            onPress: () => handleBodyScan(altSource),
          },
        ],
      );
    } finally {
      setBodyScanLoading(false);
    }
  };

  const renderBodyScanHistoryTile = (entry: BodyScanEntry, idx: number) => {
    const d = new Date(entry.date);
    const dateLabel = Number.isNaN(d.getTime()) ? 'SCAN' : `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
    const showPhoto = bodyScanPhotoVisibleInHistory(entry);
    return (
      <View key={`${entry.id}-${idx}`} style={{
        width: 76,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: idx === 0 ? tc.primary + '88' : tc.border,
        backgroundColor: idx === 0 ? tc.primary + '0F' : tc.surfaceRaised,
        padding: 5,
      }}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Delete body scan"
          onPress={() => handleDeleteBodyScan(entry)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={{
            position: 'absolute',
            right: 2,
            top: 2,
            zIndex: 2,
            width: 22,
            height: 22,
            borderRadius: 11,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: tc.surface,
            borderWidth: 1,
            borderColor: tc.border,
          }}>
          <Ionicons name="trash-outline" size={12} color={tc.textMuted} />
        </TouchableOpacity>
        <View style={{
          height: 58,
          borderRadius: 7,
          overflow: 'hidden',
          backgroundColor: tc.surface,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 5,
        }}>
          {showPhoto ? (
            <Image source={{ uri: entry.photoUri! }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
          ) : (
            <Ionicons name={entry.photoHidden || entry.sensitivePhoto ? 'eye-off-outline' : 'body-outline'} size={20} color={tc.textMuted} />
          )}
        </View>
        <Text style={{ fontSize: 13, fontWeight: '900', color: tc.textPrimary, textAlign: 'center' }}>{entry.bodyFatPct}%</Text>
        <Text style={{ fontSize: 9, color: idx === 0 ? tc.primary : tc.textMuted, fontWeight: '700', textAlign: 'center', marginTop: 1 }}>
          {idx === 0 ? 'LATEST' : dateLabel}
        </Text>
      </View>
    );
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
    if (!isActive || !authToken || !isProTier || tab !== 'health' || !showWorkoutProgress) {
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
  }, [authToken, isActive, isProTier, tab, userProfile?.daysPerWeek, userProfile?.physicalStats?.weightLbs, healthSummary?.lastNightSleepHours, history.length, showWorkoutProgress]);

  useEffect(() => {
    if (!isActive || !authToken || !selectedExercise || !showWorkoutProgress) { setE1rmHistory([]); return; }
    let cancelled = false;
    setE1rmHistory([]);
    import('../services/api').then(({ getE1RMHistory }) =>
      getE1RMHistory(authToken, selectedExercise)
        .then(res => { if (!cancelled) setE1rmHistory(res.history ?? []); })
        .catch(() => { if (!cancelled) setE1rmHistory([]); })
    );
    return () => { cancelled = true; };
  }, [authToken, isActive, selectedExercise, showWorkoutProgress]);

  const startWeight = userProfile.goalDetails.startWeightLbs ?? userProfile.physicalStats.weightLbs;
  const latestTrackedWeight = weightEntries.length > 0 ? weightEntries[weightEntries.length - 1]?.weightLbs : null;
  const currentWeight = latestTrackedWeight ?? userProfile.physicalStats.weightLbs;
  const targetWeight = userProfile.goalDetails.targetWeightLbs;
  const goalProgressProfile: UserProfile = useMemo(() => ({
    ...userProfile,
    physicalStats: { ...userProfile.physicalStats, weightLbs: currentWeight },
    weightEntries: weightEntries.map(entry => ({
      date: entry.date,
      weight_lbs: entry.weightLbs,
      source: entry.source,
      logged_at: entry.loggedAt,
    })),
  }), [userProfile, currentWeight, weightEntries]);
  const estimate = useMemo(() => getGoalEstimate(goalProgressProfile, meta.goalConfig), [goalProgressProfile, meta.goalConfig]);
  const recompProjection = useMemo(() => getRecompProjection(goalProgressProfile, meta.goalConfig), [goalProgressProfile, meta.goalConfig]);
  const goalProgressBar = useMemo(() => computeGoalProgressBar(goalProgressProfile, meta.goalConfig), [goalProgressProfile, meta.goalConfig]);
  const recompTrajectory = useMemo(() => computeRecompTrajectory(goalProgressProfile, meta.goalConfig, bodyScanHistory), [goalProgressProfile, meta.goalConfig, bodyScanHistory]);
  const latestBodyScanEntry = useMemo(() => bodyScanHistory.length > 0
    ? [...bodyScanHistory].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))[0]
    : null, [bodyScanHistory]);
  const goalBucket = resolveGoalBucket(userProfile.goal);
  const fatMassProgress = useMemo(() => computeFatMassProgress({
    startWeightLbs: userProfile.goalDetails.startWeightLbs,
    startBodyFatPct: userProfile.goalDetails.startBodyFatPct,
    currentWeightLbs: currentWeight,
    currentBodyFatPct: latestBodyScanEntry?.bodyFatPct,
    goalBucket,
  }), [userProfile.goalDetails.startWeightLbs, userProfile.goalDetails.startBodyFatPct, currentWeight, latestBodyScanEntry, goalBucket]);
  const latestLoggedWeightForStrength = weightEntries.length > 0
    ? weightEntries[weightEntries.length - 1]?.weightLbs
    : null;
  const strengthScoreWeightLbs = (Number.isFinite(latestLoggedWeightForStrength) && (latestLoggedWeightForStrength ?? 0) > 0
    ? latestLoggedWeightForStrength
    : null)
    ?? userProfile.physicalStats?.weightLbs
    ?? null;
  const strengthScoreSummary = useMemo(() => computeStrengthScore({
    bulkE1RMMap,
    showcase: oneRepMaxLifts,
    bodyweightLbs: strengthScoreWeightLbs,
  }), [bulkE1RMMap, oneRepMaxLifts, strengthScoreWeightLbs]);
  const strengthScoreEmpty = strengthScoreSummary.band === 'unknown' || strengthScoreSummary.liftsCovered === 0;
  const strengthScoreColor =
    strengthScoreSummary.band === 'elite' ? '#22C55E'
    : strengthScoreSummary.band === 'advanced' ? '#84CC16'
    : strengthScoreSummary.band === 'intermediate' ? tc.primary
    : strengthScoreSummary.band === 'developing' ? '#F59E0B'
    : strengthScoreSummary.band === 'novice' ? tc.textMuted
    : tc.textMuted;
  const strengthScoreDetail = strengthScoreEmpty
    ? (strengthScoreWeightLbs && strengthScoreWeightLbs > 0
      ? 'Strength trends need set-level data — log lifts in-app or import a Strong CSV.'
      : 'Set bodyweight to score strength.')
    : `${strengthScoreSummary.loggedLiftCount}/${strengthScoreSummary.totalLiftCount} lifts · ${strengthConfidenceLabel(strengthScoreSummary.confidence).toLowerCase()}`;
  const cardioScoreColor = cardioTrendSummary.score == null ? tc.textMuted
    : cardioTrendSummary.score >= 85 ? tc.success
      : cardioTrendSummary.score >= 65 ? tc.primary
        : cardioTrendSummary.score >= 45 ? tc.warning
          : tc.error;
  const cardioScoreDrivers = buildCardioInsights(cardioTrendSummary, distanceUnit);
  const strengthRadarProfiles = useMemo(
    () => buildRelativeStrengthProfiles(history, strengthScoreWeightLbs, {
      today: progressWeekWindow.endDate,
      bulkE1RMMap,
      showcase: oneRepMaxLifts,
      sex: userProfile.physicalStats?.gender,
    }),
    [bulkE1RMMap, history, oneRepMaxLifts, progressWeekWindow.endDate, strengthScoreWeightLbs, userProfile.physicalStats?.gender],
  );
  const strengthRadarMetrics = useMemo<RadarMetric[]>(() => {
    const byMuscle = new Map(strengthRadarProfiles.map(row => [row.muscle, row] as const));
    const order: Array<{ key: string; label: string; shortLabel: string }> = [
      { key: 'chest', label: 'Chest', shortLabel: 'Chst' },
      { key: 'back', label: 'Back', shortLabel: 'Back' },
      { key: 'shoulders', label: 'Shoulders', shortLabel: 'Shld' },
      { key: 'biceps', label: 'Biceps', shortLabel: 'Bi' },
      { key: 'triceps', label: 'Triceps', shortLabel: 'Tri' },
      { key: 'quads', label: 'Quads', shortLabel: 'Quad' },
      { key: 'hamstrings', label: 'Hams', shortLabel: 'Ham' },
      { key: 'glutes', label: 'Glutes', shortLabel: 'Glut' },
    ];
    return order.map(item => {
      const profile = byMuscle.get(item.key);
      const axisStatus = profile ? radarStatusForScore(profile.score, 80, 55) : 'unknown';
      const sourceLabel = profile?.source === 'secondary'
        ? 'secondary credit'
        : profile?.source === 'rolling'
          ? 'best-ever (no recent set)'
          : 'best recent set';
      // When the muscle has 2+ qualifying contributors, mention the
      // diversity so the user sees this can reflect multiple compounds.
      const supportCount = Math.max(0, (profile?.contributingExercises ?? 0) - 1);
      const supportSuffix = supportCount > 0
        ? ` (+${supportCount} supporting lift${supportCount === 1 ? '' : 's'})`
        : '';
      const reason = !profile
        ? strengthScoreWeightLbs && strengthScoreWeightLbs > 0
          ? 'No loaded strength estimate for this muscle in the last 30 days.'
          : 'Set bodyweight to compare strength against expected ranges.'
        : profile.score >= 80
          ? `${profile.exercise} is strong relative to bodyweight${supportSuffix}.`
          : profile.score >= 55
            ? `${profile.exercise} is around the expected bodyweight-relative range${supportSuffix}.`
            : `${profile.exercise} is below the expected bodyweight-relative range${supportSuffix}.`;
      return {
        key: item.key,
        label: item.label,
        shortLabel: item.shortLabel,
        value: profile?.score ?? null,
        status: axisStatus,
        reason,
        rawValue: profile
          ? `${profile.ratio}x`
          : '--',
        targetLabel: profile ? `target ${profile.targetRatio}x BW` : undefined,
        isEstimate: profile?.source !== 'primary',
        detail: profile
          ? profile.source === 'secondary'
            // Secondary credit is a fraction of another lift's e1RM, NOT a
            // direct 1RM for this muscle — spell that out so the number is
            // traceable (e.g. "≈150 lb = 60% of Barbell Squat est. 1RM").
            ? `≈${formatWeight(profile.estimatedStrengthLbs, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 })}${profile.contributionPct ? ` = ${profile.contributionPct}% of ${profile.exercise} est. 1RM` : ` secondary credit from ${profile.exercise}`}${profile.date ? ` · ${formatDate(profile.date)}` : ''}`
            : `${formatWeight(profile.estimatedStrengthLbs, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 })} est. 1RM · ${sourceLabel}${profile.date ? ` · ${formatDate(profile.date)}` : ''}`
          : 'needs recent loaded sets',
      };
    });
  }, [strengthRadarProfiles, strengthScoreWeightLbs, weightUnit]);
  const strengthRadarRawScore = averageMeaningfulRadarScore(strengthRadarMetrics);
  const strengthRadarInsight = deriveRadarInsights(radarAxesFromMetrics(strengthRadarMetrics));
  const strengthRadarScore = strengthRadarRawScore ?? (strengthScoreEmpty ? null : strengthScoreSummary.score);
  const strengthRadarColor = STRENGTH_PROFILE_COLOR;
  const strengthRadarDetail = strengthScoreWeightLbs == null || strengthScoreWeightLbs <= 0
    ? 'Set bodyweight to compare muscle strength against expected ranges.'
    : !strengthRadarInsight.enoughData
      ? 'Log loaded sets across muscles to fill this 30-day relative-strength profile.'
      : `${strengthRadarInsight.strongest?.label ?? 'Strength'} leads · focus ${strengthRadarInsight.focus?.label ?? 'coverage'}`;
  const cardioRadarMetrics = useMemo<RadarMetric[]>(() => {
    // Cardio profile runs on a 30-day window. Training inputs still appear
    // in detail rows, but the axes are framed as fitness qualities.
    const hasHrZoneSplit = cardioTrendSummary.easySharePct30d != null
      || cardioTrendSummary.easyZoneMinutes30d > 0
      || cardioTrendSummary.hardZoneMinutes30d > 0;
    const hasAerobicBaseSignal = cardioTrendSummary.zone2Minutes30d > 0 || hasHrZoneSplit;
    const zone2BaseScore = hasAerobicBaseSignal
      ? clampRadarScore(cardioTrendSummary.zone2Minutes30d >= 640 ? 95
        : cardioTrendSummary.zone2Minutes30d >= 385 ? 75
          : cardioTrendSummary.zone2Minutes30d >= 195 ? 55
            : cardioTrendSummary.zone2Minutes30d >= 65 ? 35
              : 20)
      : null;
    const aerobicFromVo2 = cardioVo2Score(cardioTrendSummary.vo2Max);
    const aerobicBaseScore = aerobicFromVo2 ?? zone2BaseScore;
    const intensityScore = cardioTrendSummary.hardZoneMinutes30d > 0
      ? clampRadarScore(Math.min(72, 35 + (cardioTrendSummary.hardZoneMinutes30d / 96) * 37))
      : null;
    const enduranceScore = cardioTrendSummary.longestDurationSec > 0
      ? clampRadarScore((cardioTrendSummary.longestDurationSec / 3600) * 100)
      : cardioTrendSummary.distance30dMiles > 0
        ? clampRadarScore((cardioTrendSummary.distance30dMiles / 21) * 100)
        : null;
    const consistencyScore = cardioTrendSummary.cardioSessions30d > 0
      ? clampRadarScore((cardioTrendSummary.cardioSessions30d / 13) * 100)
      : null;
    const efficiencyScore = cardioEasyHardScore(cardioTrendSummary.easySharePct30d);
    const speedScore = cardioTrendSummary.bestPaceDeltaSec != null
      ? cardioPaceTrendScore(cardioTrendSummary.bestPaceDeltaSec)
      : null;
    return [
      {
        key: 'aerobic-base',
        label: 'Aerobic Base',
        shortLabel: 'Base',
        value: aerobicBaseScore,
        status: radarStatusForScore(aerobicBaseScore, 75, 55),
        rawValue: aerobicFromVo2 != null
          ? cardioTrendSummary.vo2Max?.toFixed(1)
          : hasAerobicBaseSignal ? `${Math.round(cardioTrendSummary.zone2Minutes30d)}m` : '--',
        reason: aerobicBaseScore == null
          ? 'Track VO2 or HR zones to fill aerobic base.'
          : aerobicFromVo2 != null ? 'VO2 max anchors your aerobic base.'
            : cardioTrendSummary.zone2Minutes30d >= 385 ? 'Easy aerobic volume is supporting your base.'
              : 'Add one easy Zone 2 session.',
        targetLabel: aerobicFromVo2 != null ? 'VO2 bands' : '~390-640m / 30d',
        detail: aerobicFromVo2 != null
          ? `${cardioTrendSummary.vo2Max?.toFixed(1)} VO2`
          : hasAerobicBaseSignal ? `${Math.round(cardioTrendSummary.zone2Minutes30d)}m Zone 2` : 'needs VO2 or HR zones',
        isEstimate: aerobicFromVo2 == null && zone2BaseScore != null,
      },
      {
        key: 'endurance',
        label: 'Endurance',
        shortLabel: 'End',
        value: enduranceScore,
        status: radarStatusForScore(enduranceScore, 80, 55),
        rawValue: cardioTrendSummary.longestDurationSec > 0
          ? formatDuration(Math.round(cardioTrendSummary.longestDurationSec))
          : cardioTrendSummary.distance30dMiles > 0
            ? formatDistance(cardioTrendSummary.distance30dMiles, distanceUnit)
            : '--',
        reason: enduranceScore == null
          ? 'Track duration or distance to fill endurance.'
          : cardioTrendSummary.longestDurationSec >= 2700 ? 'Longest session shows a useful endurance base.'
            : 'Extend one easy session gradually.',
        isEstimate: cardioTrendSummary.longestDurationSec <= 0 && cardioTrendSummary.distance30dMiles > 0,
        detail: cardioTrendSummary.longestDurationSec > 0
          ? `${formatDuration(Math.round(cardioTrendSummary.longestDurationSec))} longest`
          : cardioTrendSummary.distance30dMiles > 0
            ? `${formatDistance(cardioTrendSummary.distance30dMiles, distanceUnit)} 30d`
            : 'needs duration',
      },
      {
        key: 'speed-pace',
        label: 'Speed / Pace',
        shortLabel: 'Pace',
        value: speedScore,
        status: speedScore == null ? 'unknown' : radarStatusForScore(speedScore, 80, 55),
        rawValue: cardioTrendSummary.bestPaceDeltaSec != null ? formatPaceDelta(cardioTrendSummary.bestPaceDeltaSec) : '--',
        reason: speedScore == null
          ? 'Repeat the same modality or route to compare pace honestly.'
          : cardioTrendSummary.bestPaceDeltaSec != null && cardioTrendSummary.bestPaceDeltaSec < -15
            ? 'Comparable pace is improving.'
            : cardioTrendSummary.bestPaceDeltaSec != null && cardioTrendSummary.bestPaceDeltaSec > 15
              ? 'Comparable pace has slowed.'
              : 'Comparable pace is holding steady.',
        detail: cardioTrendSummary.bestPaceDeltaSec != null
          ? `${formatPaceDelta(cardioTrendSummary.bestPaceDeltaSec)} ${cardioTrendSummary.bestPaceExercise ?? ''}`.trim()
          : 'needs comparable pace',
      },
      {
        key: 'intensity',
        label: 'Intensity',
        shortLabel: 'Int',
        value: intensityScore,
        status: intensityScore == null ? 'unknown' : radarStatusForScore(intensityScore, 80, 55),
        rawValue: intensityScore != null ? `${Math.round(cardioTrendSummary.hardZoneMinutes30d)}m` : '--',
        reason: intensityScore == null
          ? 'Hard-zone minutes or interval sessions fill this axis.'
          : 'Hard-zone work is present without crowding the easy base.',
        detail: intensityScore != null
          ? `${Math.round(cardioTrendSummary.hardZoneMinutes30d)}m hard zones`
          : 'needs hard-zone data',
      },
      {
        key: 'efficiency',
        label: 'Efficiency',
        shortLabel: 'Eff',
        value: efficiencyScore,
        status: efficiencyScore == null ? 'unknown' : radarStatusForScore(efficiencyScore, 80, 60),
        rawValue: cardioTrendSummary.easySharePct30d == null ? '--' : `${cardioTrendSummary.easySharePct30d}%`,
        reason: efficiencyScore == null
          ? 'HR zones are needed to judge sustainable output.'
          : (cardioTrendSummary.easySharePct30d ?? 0) < 50 ? 'Hard work is crowding the aerobic base.'
            : (cardioTrendSummary.easySharePct30d ?? 0) > 95 ? 'Add controlled intensity when recovery is good.'
              : 'Easy and hard work are reasonably balanced.',
        detail: cardioTrendSummary.easySharePct30d == null ? 'needs HR zones' : `${cardioTrendSummary.easySharePct30d}% easy`,
      },
      {
        key: 'consistency',
        label: 'Consistency',
        shortLabel: 'Cons',
        value: consistencyScore,
        status: radarStatusForScore(consistencyScore, 80, 55),
        rawValue: `${cardioTrendSummary.cardioSessions30d}`,
        reason: consistencyScore == null
          ? 'Log cardio sessions to build consistency.'
          : cardioTrendSummary.cardioSessions30d >= 13 ? 'Cardio frequency is on target.'
            : 'Spread cardio across 10-13 sessions a month.',
        detail: `${cardioTrendSummary.cardioSessions30d} / 13 sessions`,
      },
    ];
  }, [cardioTrendSummary, distanceUnit]);
  const cardioRadarInsight = useMemo(
    () => deriveRadarInsights(radarAxesFromMetrics(cardioRadarMetrics)),
    [cardioRadarMetrics],
  );
  const cardioBalanceRawScore = averageMeaningfulRadarScore(cardioRadarMetrics);
  const cardioMeaningfulAxes = meaningfulRadarAxes(cardioRadarMetrics);
  const cardioHasOnlySessionProxy = cardioMeaningfulAxes.length > 0
    && cardioMeaningfulAxes.every(axis => axis.key === 'consistency');
  const cardioHasPhysiologySignal = cardioMeaningfulAxes.some(axis => axis.key === 'aerobic-base' && !axis.isEstimate);
  const cardioBalanceScore = cardioBalanceRawScore == null
    ? null
    : cardioHasOnlySessionProxy
      ? Math.min(cardioBalanceRawScore, 55)
      : cardioMeaningfulAxes.length < 3
        ? Math.min(cardioBalanceRawScore, cardioHasPhysiologySignal ? 78 : 65)
        : cardioBalanceRawScore;
  const cardioBalanceColor = CARDIO_PROFILE_COLOR;
  const cardioBalanceDetail = !cardioTrendSummary.hasData
    ? 'Log cardio duration, HR zones, pace, or VO2 to build this profile.'
    : !cardioRadarInsight.enoughData
      ? 'More HR, pace, duration, or VO2 data will sharpen this profile.'
      : `${cardioRadarInsight.strongest?.label ?? 'Base'} is strongest · focus ${cardioRadarInsight.focus?.label ?? 'consistency'}`;
  const cardioActivityMix = useMemo(() => {
    const today = dateKey(new Date());
    return buildCardioActivityMix(paceHistory, summaries, healthSummary, shiftDateKey(today, -29), today);
  }, [healthSummary, paceHistory, summaries]);
  const selectedCardioGroup = selectedCardioExercise
    ? paceExerciseGroups.find(group => group.key === selectedCardioExercise) ?? paceExerciseGroups[0] ?? null
    : paceExerciseGroups[0] ?? null;
  const cardioModeAvailable = selectedCardioGroup ? {
    distance: selectedCardioGroup.distancePoints.length >= 1,
    pace: selectedCardioGroup.pacePoints.length >= 1,
    duration: selectedCardioGroup.durationPoints.length >= 1,
  } : { distance: false, pace: false, duration: false };
  const effectiveCardioChartMode: CardioChartMode = selectedCardioGroup && cardioModeAvailable[cardioChartMode]
    ? cardioChartMode
    : cardioModeAvailable.distance ? 'distance'
      : cardioModeAvailable.pace ? 'pace'
        : cardioModeAvailable.duration ? 'duration'
          : 'distance';
  const selectedBiometricConfig = selectedBiometric ? BIOMETRIC_HISTORY_CONFIG[selectedBiometric] : null;
  const biometricHistoryPoints = selectedBiometric
    ? buildBiometricHistoryPoints(selectedBiometric, sleepHistory, dailyHealthHistory, healthSummary, biometricHistoryWindow)
    : [];
  const biometricReadingRows = biometricHistoryPoints.slice().reverse();
  const biometricHistoryValues = biometricHistoryPoints.map(point => point.value);
  const biometricLatestPoint = biometricHistoryPoints[biometricHistoryPoints.length - 1] ?? null;
  const biometricFirstPoint = biometricHistoryPoints[0] ?? null;
  const biometricAverage = biometricHistoryValues.length > 0
    ? biometricHistoryValues.reduce((sum, value) => sum + value, 0) / biometricHistoryValues.length
    : null;
  const biometricChartMin = biometricHistoryValues.length > 0 ? Math.min(...biometricHistoryValues) : 0;
  const biometricChartMax = biometricHistoryValues.length > 0 ? Math.max(...biometricHistoryValues) : 1;
  const biometricChartSpan = Math.max(1, biometricChartMax - biometricChartMin);
  const biometricDelta = biometricLatestPoint && biometricFirstPoint
    ? biometricLatestPoint.value - biometricFirstPoint.value
    : null;
  const biometricTrendGood = selectedBiometricConfig && biometricDelta != null
    ? selectedBiometricConfig.better === 'neutral'
      ? null
      : selectedBiometricConfig.better === 'higher'
        ? biometricDelta >= 0
        : biometricDelta <= 0
    : null;
  const biometricTrendColor = biometricTrendGood == null ? tc.textMuted : biometricTrendGood ? tc.success : tc.warning;
  const biometricWindowOptions: BiometricHistoryWindow[] = [14, 30, 90];
  const lostOrGained = Math.abs(currentWeight - startWeight);
  const direction = currentWeight <= startWeight ? 'down' : 'up';
  const remainingLbs = targetWeight != null ? Math.abs(currentWeight - targetWeight) : null;
  return (
    <View style={[styles.container, noHeader && styles.inlineContainer]}>
      {!noHeader && <MovingGradientBackground colors={tc} intensity="quiet" />}
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

      <View style={styles.tabPillRow}>
        {visibleProgressTabs.map(([key, label]) => {
          const active = tab === key;
          return (
            <Pressable
              key={key}
              testID={`progress-subtab-${key}`}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected: active }}
              onPressIn={() => {
                if (progressTabRef.current !== key) {
                  hapticSelection();
                  selectProgressTab(key);
                }
              }}
              onPress={() => {
                if (progressTabRef.current === key) return;
                hapticSelection();
                selectProgressTab(key);
              }}
              style={[
                styles.tabPillBtn,
                {
                  backgroundColor: active ? tc.primary + '22' : tc.surface,
                  borderColor: active ? tc.primary : tc.border,
                },
              ]}>
              <Text
                style={[
                  styles.tabPillText,
                  { color: active ? tc.primary : tc.textSecondary },
                ]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.82}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <TabDragWrapper
        canGoPrev={canSwipeProgressPrev}
        canGoNext={canSwipeProgressNext}
        resetKey={tab}
        onCommit={swipeProgressTab}>
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : (
        <FadeInView key={tab} duration={260} slideDistance={8} style={{ flex: 1 }}>
        {tab === 'today' ? (
        <ScrollView
          ref={todayScrollRef}
          contentContainerStyle={styles.content}
          onScroll={handleProgressChromeScroll}
          scrollEventThrottle={16}>
          <FadeInView delay={0} duration={TIMING_STANDARD.duration} slideDistance={6}>
            <AnimatedPressable
              testID="progress-today-how-am-i-doing-card"
              style={[styles.todayHeroCard, { borderColor: todayHeroColor + '66' }]}
              accessibilityRole="button"
              accessibilityLabel={`${todayHeroStatus}. ${todayHeroTitle}${todayHeroSubtitle ? `. ${todayHeroSubtitle}` : ''}. View details.`}
              onPress={() => {
                import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
                setQuickDetailSheet(hasGoalScoreDetail ? 'forecast' : 'today');
              }}
            >
              <ImageBackground
                source={{ uri: todayHeroImageUri }}
                resizeMode="cover"
                imageStyle={styles.todayHeroImage}
                style={styles.todayHeroImageWrap}>
                <LinearGradient
                  colors={['rgba(0,0,0,0.05)', 'rgba(0,0,0,0.58)']}
                  style={StyleSheet.absoluteFill}
                />
                <View style={styles.todayHeroImageMeta}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.todayHeroImageEyebrow}>Quick goal estimate</Text>
                    <Text style={styles.todayHeroImageGoal} numberOfLines={1}>
                      {goalScore ? humanizeToken(goalScore.goalType) : goalForecast?.title ?? todayTrack.goalLabel}
                    </Text>
                  </View>
                  <View style={[styles.todayHeroPill, { backgroundColor: '#FFFFFF24', borderColor: '#FFFFFF66' }]}>
                    <Text style={styles.todayHeroImagePillText} numberOfLines={1}>
                      {todayHeroStatus}
                    </Text>
                  </View>
                </View>
              </ImageBackground>

              <View style={styles.todayHeroContent}>
                <View style={styles.todayHeroBody}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.todayHeroHeadline} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.78}>
                      {todayHeroTitle}
                    </Text>
                    {todayHeroSubtitle ? (
                      <Text style={styles.todayHeroSubheadline} numberOfLines={2}>
                        {todayHeroSubtitle}
                      </Text>
                    ) : null}
                  </View>
                  <View style={[styles.todayHeroScoreBubble, { backgroundColor: todayHeroColor + '18', borderColor: todayHeroColor + '55' }]}>
                    <Text style={[styles.todayHeroScoreValue, { color: todayHeroColor }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.68}>
                      {todayHeroMetricValue}
                    </Text>
                    <Text style={styles.todayHeroScoreLabel}>{todayHeroMetricLabel}</Text>
                  </View>
                </View>

                {(
                  // Stay on the spinner until every input the overview
                  // actually consumes has hydrated — `loading` alone covers
                  // only the workout-history batch; the stats and graph also
                  // need weight entries, body scans, and (when meals are
                  // tracked) the meal history. Showing them earlier flashed
                  // incorrect numbers + a partial line first.
                  loading
                  || !weightEntriesLoaded
                  || !bodyScanLoaded
                  || (showMealProgress && mealHistory == null)
                ) ? (
                  <View style={{ alignItems: 'center', justifyContent: 'center', paddingVertical: 28 }}>
                    <ActivityIndicator color={todayHeroColor} />
                    <Text style={{ color: tc.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.4, marginTop: 8 }}>
                      Loading goal execution…
                    </Text>
                  </View>
                ) : (
                  <>
                    <View style={styles.goalOverviewStatsRow}>
                      {goalExecutionOverview.stats.map(stat => (
                        <View key={stat.key} style={styles.goalOverviewStat}>
                          <Text style={styles.goalOverviewStatLabel} numberOfLines={1}>{stat.label}</Text>
                          <Text
                            style={[styles.goalOverviewStatValue, stat.color ? { color: stat.color } : null]}
                            numberOfLines={1}
                            adjustsFontSizeToFit
                            minimumFontScale={0.68}>
                            {stat.value}
                          </Text>
                          <Text style={styles.goalOverviewStatDetail} numberOfLines={1}>{stat.detail}</Text>
                        </View>
                      ))}
                    </View>

                    <GoalExecutionGraph
                      overview={goalExecutionOverview}
                      width={trajectoryChartWidth}
                      color={todayHeroColor}
                      tc={tc}
                      styles={styles}
                    />
                  </>
                )}
              </View>
            </AnimatedPressable>
          </FadeInView>

          {todaySleepConstellationCard && (
            <View
              testID="progress-today-sleep-card-anchor"
              collapsable={false}
              onLayout={handleTodaySleepLayout}>
              <FadeInView delay={20} duration={TIMING_STANDARD.duration} slideDistance={6}>
                {todaySleepConstellationCard}
              </FadeInView>
            </View>
          )}

          <FadeInView delay={30} duration={TIMING_STANDARD.duration} slideDistance={6}>
            <DailyStressTimelineCard
              authToken={authToken}
              themeName={themeName}
              active={isActive && tab === 'today'}
              healthEnabled={isProTier && healthEnabled}
              healthSummary={healthSummary}
              mealHistory={mealHistory}
              nutritionPlan={nutritionPlan}
              workoutHistory={history}
              inProgressWorkout={inProgressWorkout}
              showMealProgress={showMealProgress}
              showWorkoutProgress={showWorkoutProgress}
            />
          </FadeInView>

          {showWorkoutProgress && inProgressWorkout && (
            <FadeInView delay={40} duration={TIMING_STANDARD.duration} slideDistance={6}>
              <View
                testID="progress-today-in-progress-workout-card"
                style={{
                  backgroundColor: tc.surface,
                  borderRadius: radius.lg,
                  padding: 14,
                  marginBottom: 12,
                  borderWidth: 1.5,
                  borderColor: tc.primary + '88',
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{
                    width: 34, height: 34, borderRadius: 17,
                    alignItems: 'center', justifyContent: 'center',
                    backgroundColor: tc.primary + '20',
                  }}>
                    <Ionicons name="play-circle-outline" size={19} color={tc.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 10, fontWeight: '900', color: tc.primary, letterSpacing: 0.8 }}>
                      IN PROGRESS
                    </Text>
                    <Text style={{ fontSize: 15, fontWeight: '900', color: tc.textPrimary, marginTop: 1 }} numberOfLines={1}>
                      Continue {inProgressWorkout.focus || 'workout'}
                    </Text>
                  </View>
                </View>
                <Text style={{ fontSize: 12, color: tc.textSecondary, marginTop: 8, lineHeight: 17 }}>
                  {inProgressWorkout.setsLogged} set{inProgressWorkout.setsLogged === 1 ? '' : 's'} logged · started {formatStartedAgo(inProgressWorkout.startedAt)}
                </Text>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                  {onResumeInProgressWorkout && (
                    <TouchableOpacity
                      style={{ flex: 1, backgroundColor: tc.primary, borderRadius: radius.md, paddingVertical: 10, alignItems: 'center' }}
                      onPress={() => {
                        import('../utils/feedback').then(f => f.hapticMedium()).catch(() => {});
                        onResumeInProgressWorkout();
                      }}>
                      <Text style={{ color: getContrastingTextColor(tc.primary), fontSize: 13, fontWeight: '900' }}>Resume</Text>
                    </TouchableOpacity>
                  )}
                  {onDiscardInProgressWorkout && (
                    <TouchableOpacity
                      style={{ flex: 1, borderRadius: radius.md, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: tc.border }}
                      onPress={() => {
                        Alert.alert(
                          'Discard in-progress workout?',
                          'Your logged sets for this session will be cleared.',
                          [
                            { text: 'Keep', style: 'cancel' },
                            {
                              text: 'Discard',
                              style: 'destructive',
                              onPress: () => { void onDiscardInProgressWorkout(); },
                            },
                          ],
                        );
                      }}>
                      <Text style={{ color: tc.error ?? '#EF4444', fontSize: 13, fontWeight: '800' }}>Discard</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            </FadeInView>
          )}

          {showWorkoutProgress && isProTier && authToken && (
            <FadeInView delay={80} duration={TIMING_STANDARD.duration} slideDistance={6}>
              <WeeklyCheckinCard
                authToken={authToken}
                themeName={userProfile.themePreference}
              />
            </FadeInView>
          )}

          {showWorkoutProgress && isProTier && authToken && (
            <FadeInView delay={120} duration={TIMING_STANDARD.duration} slideDistance={6}>
              <Zone2TargetCard
                authToken={authToken}
                themeName={userProfile.themePreference}
                currentMinutes={planWeekZones.zone2Current}
                previousMinutes={planWeekZones.zone2Previous}
                weeklyZoneMinutes={planWeekZones.current}
                weeklyZoneSources={planWeekZones.contributors}
                weekEndDate={progressWeekWindow.endDate}
                weekLabel={progressWeekWindow.label}
                previousWeekLabel={progressWeekWindow.previousLabel}
              />
            </FadeInView>
          )}
        </ScrollView>
      ) : tab === 'trends' && showWorkoutProgress ? (
        <ScrollView
          contentContainerStyle={styles.content}
          onScroll={handleProgressChromeScroll}
          scrollEventThrottle={16}>
          <View style={{ alignItems: 'flex-end', marginBottom: 8 }}>
            <TouchableOpacity
              testID="progress-edit-trends"
              accessibilityRole="button"
              accessibilityLabel="Edit Trends"
              activeOpacity={0.78}
              onPress={() => { import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {}); setEditTrendsOpen(true); }}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: tc.border, backgroundColor: tc.surface }}>
              <Ionicons name="options-outline" size={15} color={tc.textSecondary} />
              <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textSecondary }}>Edit Trends</Text>
            </TouchableOpacity>
          </View>

          {TRENDS_SECTIONS.every(section => !trendsShown(section.id)) && (
            <View style={[styles.emptyBox, { paddingTop: 36, paddingBottom: 28 }]}>
              <Ionicons name="eye-off-outline" size={38} color={tc.textMuted} />
              <Text style={styles.emptyTitle}>All trend sections hidden</Text>
              <Text style={styles.emptyBody}>Use Edit Trends to bring back any section whenever you want it.</Text>
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={showAllTrends}
                style={{ paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10, backgroundColor: tc.primary }}>
                <Text style={{ color: getContrastingTextColor(tc.primary), fontSize: 13, fontWeight: '800' }}>Show all sections</Text>
              </TouchableOpacity>
            </View>
          )}

          {plateauAlertCard}

          {/* Lead with actual trends: weekly training-volume + recent PRs,
              above the snapshot radars below. */}
          {trendsShown('trends-overview') && (
          <FadeInView delay={0} duration={TIMING_STANDARD.duration} slideDistance={6}>
            <TrendsOverviewCard
              history={history}
              prs={prs}
              weightUnit={weightUnit}
              themeName={themeName}
              weekStartDate={progressWeekWindow.startDate}
              windowDays={progressWeekWindow.days}
            />
          </FadeInView>
          )}

          <View style={styles.trendsRadarStack}>
            {trendsShown('strength-profile') && (
            <FadeInView delay={0} duration={TIMING_STANDARD.duration} slideDistance={6} style={styles.trendsRadarGridItem}>
              <TrendsRadarCard
                testID="progress-strength-radar"
                title="Relative Strength Profile"
                subtitle={strengthRadarScore == null ? 'Needs strength data' : '30D vs bodyweight'}
                score={strengthRadarScore}
                metrics={strengthRadarMetrics}
                icon="barbell-outline"
                color={strengthRadarColor}
                detail={strengthRadarDetail}
                styles={styles}
                tc={tc}
                onPress={() => {
                  import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
                  setStrengthRadarDetailOpen(true);
                }}
              />
            </FadeInView>
            )}
            {trendsShown('cardio-profile') && (
            <FadeInView delay={45} duration={TIMING_STANDARD.duration} slideDistance={6} style={styles.trendsRadarGridItem}>
              <TrendsRadarCard
                testID="progress-cardio-radar"
                title="Cardio Fitness Profile"
                subtitle={cardioBalanceScore == null ? 'Need cardio data' : '30D fitness qualities'}
                score={cardioBalanceScore}
                metrics={cardioRadarMetrics}
                icon="pulse-outline"
                color={cardioBalanceColor}
                detail={cardioBalanceDetail}
                styles={styles}
                tc={tc}
                onPress={() => {
                  import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
                  setCardioScoreDetailOpen(true);
                }}
              />
            </FadeInView>
            )}
          </View>

          {trendsShown('performance-gauges') && progressAnalytics.length > 0 && (
            <View style={styles.performanceGaugeCard}>
              <View style={styles.performanceGaugeHeader}>
                <Ionicons name="speedometer-outline" size={17} color={tc.primary} />
                <Text style={styles.performanceGaugeTitle}>Performance gauges</Text>
              </View>
              <View style={styles.performanceGaugeGrid}>
                {progressAnalytics.map((item, index) => {
                  const numeric = Number(String(item.value).replace(/[^0-9.-]/g, ''));
                  const fill = Number.isFinite(numeric)
                    ? item.key === 'load-balance'
                      ? Math.min(100, Math.max(0, Math.abs(numeric)))
                      : item.value.includes('%') ? Math.min(100, Math.abs(numeric)) : Math.min(100, Math.abs(numeric) * 10)
                    : 30;
                  const onTap = item.key === 'strength-index'
                    ? () => setStrengthTrendDetailOpen(true)
                    : item.key === 'recent-records'
                      ? () => setRecordsDetailOpen(true)
                      : item.key === 'load-balance'
                        ? () => setVolumeDetailMode('balance')
                        : item.key === 'volume-trend'
                          ? () => setVolumeDetailMode('workload')
                        : null;
                  return (
                    <FadeInView
                      key={item.key}
                      delay={staggerDelay(index, 45)}
                      duration={TIMING_STANDARD.duration}
                      slideDistance={6}
                      style={[styles.performanceGaugeTile, { borderColor: item.color + '36' }]}
                    >
                      <ProgressCardWash color={item.color} intensity="soft" cornerRadius={radius.md} />
                      <TouchableOpacity
                        activeOpacity={onTap ? 0.85 : 1}
                        disabled={!onTap}
                        onPress={onTap ? () => {
                          import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
                          onTap();
                        } : undefined}
                      >
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                          <View style={[styles.performanceGaugeIcon, { backgroundColor: item.color + '1F' }]}>
                            <Ionicons name={item.icon} size={15} color={item.color} />
                          </View>
                          {onTap && (
                            <Ionicons name="chevron-forward" size={14} color={tc.textMuted} style={{ marginBottom: 7 }} />
                          )}
                        </View>
                        <Text style={styles.performanceGaugeLabel} numberOfLines={1}>{item.label}</Text>
                        <PulseOnChange trigger={`${item.key}-${item.value}`}>
                          <Text
                            style={[styles.performanceGaugeValue, { color: item.color }]}
                            numberOfLines={1}
                            adjustsFontSizeToFit
                            minimumFontScale={0.72}>
                            {item.value}
                          </Text>
                        </PulseOnChange>
                        <View style={styles.performanceGaugeTrack}>
                          <AnimatedProgressFill
                            pct={fill}
                            minPct={5}
                            color={item.color}
                            delay={120 + index * 40}
                            style={styles.performanceGaugeFill}
                          />
                        </View>
                        <Text style={styles.performanceGaugeDetail} numberOfLines={2}>{item.detail}</Text>
                      </TouchableOpacity>
                    </FadeInView>
                  );
                })}
              </View>
            </View>
          )}

          {trendsShown('high-value-trends') && highValueTrendCards.length > 0 && (
            <HighValueTrendCardsCard
              cards={visibleHighValueTrendCards}
              availableCount={highValueTrendCards.length}
              onEdit={() => {
                import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
                setEditHighValueTrendsOpen(true);
              }}
              tc={tc}
              styles={styles}
            />
          )}

          {trendsShown('activity-highlights') && activityTrendCards.length > 0 && (
            <ActivityTrendHighlightsCard
              cards={visibleActivityTrendCards}
              availableCount={activityTrendCards.length}
              onEdit={() => {
                import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
                setEditActivityHighlightsOpen(true);
              }}
              tc={tc}
              styles={styles}
            />
          )}

          {trendsShown('metric-suggestions') && (
            <TrendMetricSuggestionsCard suggestions={trendMetricSuggestions} tc={tc} styles={styles} />
          )}

          {(trendsShown('strength-charts') || trendsShown('cardio-progression')) && (chartExerciseOptions.length === 0 && paceExerciseGroups.length === 0 && cardioInsightsMemo.length === 0 ? (
            <View style={styles.emptyBox}>
              <Ionicons name="analytics-outline" size={40} color={tc.textMuted} style={{ marginBottom: 8 }} />
              <Text style={styles.emptyTitle}>Complete 2 tracked sessions to see charts</Text>
              <Text style={styles.emptyBody}>Strength charts use loaded sets. Cardio charts use distance and pace logs.</Text>
            </View>
          ) : (
            <>
              {trendsShown('strength-charts') && chartExerciseOptions.length > 0 && (
                <>
                  <Text style={styles.sectionLabel}>Filter by muscle</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast" contentContainerStyle={styles.exerciseChipScroller}>
                    {CHART_MUSCLE_BUCKETS.map(b => {
                      const active = chartMuscleFilter === b.id;
                      return (
                        <AnimatedPressable
                          key={b.id}
                          style={[styles.exerciseChip, active && styles.exerciseChipActive]}
                          onPress={() => setChartMuscleFilter(b.id)}
                          scaleDown={0.95}>
                          <Text style={[styles.exerciseChipText, active && styles.exerciseChipTextActive]} numberOfLines={1}>
                            {b.label}
                          </Text>
                        </AnimatedPressable>
                      );
                    })}
                  </ScrollView>

                  <Text style={styles.sectionLabel}>Select exercise</Text>
                  {filteredChartExercises.length === 0 ? (
                    <Text style={{ color: tc.textMuted, fontSize: 12, marginBottom: 12 }}>
                      No {activeChartBucket.label.toLowerCase()} exercises with enough data yet.
                    </Text>
                  ) : (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast" contentContainerStyle={styles.exerciseChipScroller}>
                      {filteredChartExercises.map(option => (
                        <AnimatedPressable
                          key={option.key}
                          style={[styles.exerciseChip, selectedExercise === option.name && styles.exerciseChipActive]}
                          onPress={() => setSelectedExercise(option.name)}
                          scaleDown={0.95}>
                          <Text
                            style={[styles.exerciseChipText, selectedExercise === option.name && styles.exerciseChipTextActive]}
                            numberOfLines={1}
                            ellipsizeMode="tail"
                          >
                            {option.name}
                          </Text>
                        </AnimatedPressable>
                      ))}
                    </ScrollView>
                  )}
                </>
              )}

              {trendsShown('strength-charts') && topLiftHistory && topLiftHistory.points.length >= 3 && (
                <View style={{ marginTop: 6 }}>
                  <Text style={styles.sectionLabel}>Estimated 1RM Trend</Text>
                  <OneRepMaxTrendCard
                    title={topLiftHistory.name}
                    subtitle="Rolling estimated 1-rep max from logged working sets"
                    points={topLiftHistory.points}
                    weightUnit={weightUnit}
                    tc={tc}
                    styles={styles}
                  />
                </View>
              )}

              {trendsShown('strength-charts') && (selectedExercise ? (() => {
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
                const hasDuration = trend.some(p => p.totalDuration > 0);
                const hasWeight = trend.some(p => p.bestWeight > 0);
                const hasE1rm = selectedE1rmHistory.length >= 2;

                const effectiveMode = chartMode === 'e1rm' && hasE1rm ? 'e1rm'
                  : chartMode === 'e1rm' ? 'weight'
                  : chartMode;

                if (effectiveMode === 'e1rm') {
                  const e1rmValues = selectedE1rmHistory.map(p => Math.round(p.e1rm_lbs));
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
                    label: (() => { const d = new Date(selectedE1rmHistory[i].date); return `${d.getMonth() + 1}/${d.getDate()}`; })(),
                    conf: selectedE1rmHistory[i].confidence,
                  }));
                  const valueLabelIndexes = graphValueLabelIndexes(e1rmValues);
                  const polyPoints = pts.map(p => `${p.x},${p.y}`).join(' ');
                  const e1rmBaselineY = padT + plotH;
                  const e1rmAreaPoints = pts.length >= 2
                    ? `${polyPoints} ${pts[pts.length - 1].x},${e1rmBaselineY} ${pts[0].x},${e1rmBaselineY}`
                    : null;
                  const gridLines = 4;
                  const gridVals = Array.from({ length: gridLines }, (_, i) =>
                    Math.round(rangeMin + (rangeDelta * (i / (gridLines - 1))))
                  );
                  const metricLabel = selectedExerciseIsIsolation ? 'best set' : 'e1RM';
                  return (
                    <View testID="progress-selected-exercise-chart" style={styles.graphCard}>
                      <View style={styles.graphHeader}>
                        <Text style={styles.graphTitle} numberOfLines={2}>{selectedExercise}</Text>
                        <View style={styles.chartModeGroup}>
                          {hasWeight && (
                            <AnimatedPressable style={[styles.chartModeBtn]} onPress={() => setChartMode('weight')} scaleDown={0.94}>
                              <Text style={styles.chartModeBtnText}>Weight</Text>
                            </AnimatedPressable>
                          )}
                          {hasWeight && (
                            <AnimatedPressable style={[styles.chartModeBtn]} onPress={() => setChartMode('volume')} scaleDown={0.94}>
                              <Text style={styles.chartModeBtnText}>Volume</Text>
                            </AnimatedPressable>
                          )}
                          <AnimatedPressable style={[styles.chartModeBtn, styles.chartModeBtnActive]} onPress={() => {}} scaleDown={0.94}>
                            <Text style={[styles.chartModeBtnText, styles.chartModeBtnTextActive]}>
                              {selectedExerciseIsIsolation ? 'Best Set' : 'Est. 1RM'}
                            </Text>
                          </AnimatedPressable>
                        </View>
                      </View>
                      <Text style={styles.graphSubtitle}>
                        {selectedExerciseIsIsolation
                          ? `Heaviest working set (${weightUnit}) over time — Estimated 1RM isn't shown for isolation exercises`
                          : `Estimated 1-rep max (${weightUnit}) over time`}
                      </Text>
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
                                {weightChartValue(gv, weightUnit)}
                              </SvgText>
                            );
                          })}
                          {e1rmAreaPoints && (
                            <>
                              <Defs>
                                <SvgLinearGradient id="strengthTrendAreaGradient" x1="0" y1="0" x2="0" y2="1">
                                  <Stop offset="0%" stopColor={tc.primary} stopOpacity={0.22} />
                                  <Stop offset="100%" stopColor={tc.primary} stopOpacity={0.02} />
                                </SvgLinearGradient>
                              </Defs>
                              <Polygon points={e1rmAreaPoints} fill="url(#strengthTrendAreaGradient)" stroke="none" />
                            </>
                          )}
                          <Polyline points={polyPoints}
                            fill="none" stroke={tc.primary} strokeWidth={2.5}
                            strokeLinejoin="round" strokeLinecap="round" />
                          {pts.map((p, i) => (
                            <Circle key={i} cx={p.x} cy={p.y}
                              r={i === pts.length - 1 ? 5 : 3.5}
                              fill={i === pts.length - 1 ? tc.accent : tc.primary}
                              stroke={tc.surface} strokeWidth={1.5} />
                          ))}
                          {pts.map((p, i) => {
                            if (!valueLabelIndexes.has(i)) return null;
                            const label = String(weightChartValue(p.val, weightUnit));
                            const labelW = graphValueLabelWidth(label);
                            const labelX = graphValueLabelX(p.x, labelW, chartW, padL, padR);
                            const labelY = graphValueLabelY(p.y);
                            return (
                              <Fragment key={`v${i}`}>
                                <Rect
                                  x={labelX - labelW / 2}
                                  y={labelY - 11}
                                  width={labelW}
                                  height={15}
                                  rx={7.5}
                                  fill={tc.surfaceRaised}
                                  stroke={tc.border}
                                  strokeWidth={0.75}
                                  opacity={0.96}
                                />
                                <SvgText
                                  x={labelX}
                                  y={labelY}
                                  fontSize={9}
                                  fontWeight="800"
                                  fill={i === pts.length - 1 ? tc.accent : tc.textPrimary}
                                  textAnchor="middle"
                                >
                                  {label}
                                </SvgText>
                              </Fragment>
                            );
                          })}
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
                          <Text style={styles.chartStatValue}>{formatWeight(e1rmValues[e1rmValues.length - 1], weightUnit)}</Text>
                          <Text style={styles.chartStatLabel}>Current {metricLabel}</Text>
                        </View>
                        <View style={styles.chartStat}>
                          <Text style={styles.chartStatValue}>{formatWeight(Math.max(...e1rmValues), weightUnit)}</Text>
                          <Text style={styles.chartStatLabel}>Peak {metricLabel}</Text>
                        </View>
                        <View style={styles.chartStat}>
                          <Text style={[styles.chartStatValue, { color: e1rmValues[e1rmValues.length - 1] >= e1rmValues[0] ? tc.primary : tc.error }]}>
                            {formatSignedWeightDelta(e1rmValues[e1rmValues.length - 1] - e1rmValues[0], weightUnit)}
                          </Text>
                          <Text style={styles.chartStatLabel}>{selectedExerciseIsIsolation ? 'vs first best set' : 'vs first estimate'}</Text>
                        </View>
                      </View>
                    </View>
                  );
                }

                const values = trend.map(p =>
                  effectiveMode === 'weight' ? weightChartValue(p.bestWeight, weightUnit)
                    : effectiveMode === 'duration' ? Math.round(p.totalDuration / 60)
                    : Math.round(p.volume)
                );
                const maxVal = Math.max(...values, 1);
                const unit = effectiveMode === 'weight' ? ` ${weightUnit}` : effectiveMode === 'duration' ? ' min' : '';
                return (
                  <View testID="progress-selected-exercise-chart" style={styles.graphCard}>
                    <ProgressCardWash color={tc.primary} secondaryColor={tc.accent} intensity="soft" />
                    <View style={styles.graphHeader}>
                      <Text style={styles.graphTitle} numberOfLines={2}>{selectedExercise}</Text>
                      <View style={styles.chartModeGroup}>
                        {hasWeight && (
                          <AnimatedPressable
                            style={[styles.chartModeBtn, effectiveMode === 'weight' && styles.chartModeBtnActive]}
                            onPress={() => setChartMode('weight')}
                            scaleDown={0.94}>
                            <Text style={[styles.chartModeBtnText, effectiveMode === 'weight' && styles.chartModeBtnTextActive]}>Weight</Text>
                          </AnimatedPressable>
                        )}
                        {hasWeight && (
                          <AnimatedPressable
                            style={[styles.chartModeBtn, effectiveMode === 'volume' && styles.chartModeBtnActive]}
                            onPress={() => setChartMode('volume')}
                            scaleDown={0.94}>
                            <Text style={[styles.chartModeBtnText, effectiveMode === 'volume' && styles.chartModeBtnTextActive]}>Volume</Text>
                          </AnimatedPressable>
                        )}
                        {hasDuration && (
                          <AnimatedPressable
                            style={[styles.chartModeBtn, effectiveMode === 'duration' && styles.chartModeBtnActive]}
                            onPress={() => setChartMode('duration')}
                            scaleDown={0.94}>
                            <Text style={[styles.chartModeBtnText, effectiveMode === 'duration' && styles.chartModeBtnTextActive]}>Duration</Text>
                          </AnimatedPressable>
                        )}
                        {hasE1rm && (
                          <AnimatedPressable
                            style={[styles.chartModeBtn]}
                            onPress={() => setChartMode('e1rm')}
                            scaleDown={0.94}>
                            <Text style={styles.chartModeBtnText}>Est. 1RM</Text>
                          </AnimatedPressable>
                        )}
                      </View>
                    </View>
                    <Text style={styles.graphSubtitle}>
                      {effectiveMode === 'weight' ? `Best set weight (${weightUnit}) per session`
                        : effectiveMode === 'duration' ? 'Total duration (min) per session'
                        : 'Total volume (lbs x reps) per session'}
                    </Text>
                    <View style={styles.graphBars}>
                      {trend.map((point, i) => {
                        const val = values[i];
                        const h = Math.max(8, Math.round((val / maxVal) * 100));
                        const isLast = i === trend.length - 1;
                        return (
                          <View
                            key={i}
                            style={styles.graphBarCol}
                            accessible
                            accessibilityLabel={`${point.label}: ${val}${unit}`}>
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
              })() : chartExerciseOptions.length > 0 ? (
                <View style={styles.emptyBox}>
                  <Text style={styles.emptyBody}>Tap an exercise above to see its progress chart.</Text>
                </View>
              ) : null)}

              {trendsShown('strength-charts') && chartExerciseOptions.length === 0 && !topLiftHistory && (
                <View style={[styles.emptyBox, { paddingTop: 36, paddingBottom: 18 }]}>
                  <Ionicons name="barbell-outline" size={34} color={tc.textMuted} />
                  <Text style={styles.emptyTitle}>No strength charts yet</Text>
                  <Text style={styles.emptyBody}>Log loaded sets across two sessions to start strength, best-set, and 1RM charts.</Text>
                </View>
              )}

              {trendsShown('cardio-progression') && (cardioInsightsMemo.length > 0 || paceExerciseGroups.length > 0) && (
                <View style={{ marginTop: 20 }}>
                  <Text style={styles.sectionLabel}>Cardio</Text>
                  <View style={[styles.graphCard, styles.cardioSectionCard]}>
                    <ProgressCardWash color={cardioScoreColor} secondaryColor="#06B6D4" intensity="soft" />
                    <View style={styles.cardioSectionHeader}>
                      <View style={[styles.performanceGaugeIcon, { backgroundColor: cardioScoreColor + '1F', marginBottom: 0 }]}>
                        <Ionicons name="pulse-outline" size={15} color={cardioScoreColor} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.graphTitle} numberOfLines={1}>Cardio progression</Text>
                        <Text style={[styles.graphSubtitle, { marginBottom: 0 }]} numberOfLines={2}>
                          Filter by activity and metric to inspect distance, pace, or duration.
                        </Text>
                      </View>
                    </View>

                    {cardioInsightsMemo.length > 0 && (
                      <View style={styles.cardioInsightGrid}>
                        {cardioInsightsMemo.slice(0, 4).map((item, index) => (
                          <FadeInView
                            key={item.label}
                            delay={staggerDelay(index, 35)}
                            duration={TIMING_STANDARD.duration}
                            slideDistance={5}
                            style={[styles.cardioInsightTile, { borderColor: cardioScoreColor + '30' }]}
                          >
                            <ProgressCardWash color={cardioScoreColor} secondaryColor="#06B6D4" intensity="soft" cornerRadius={radius.md} />
                            <Text style={styles.cardioInsightValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>{item.value}</Text>
                            <Text style={styles.cardioInsightLabel} numberOfLines={1}>{item.label}</Text>
                            <Text style={styles.cardioInsightDetail} numberOfLines={2}>{item.detail}</Text>
                          </FadeInView>
                        ))}
                      </View>
                    )}

                    <CardioHrZonesCard authToken={authToken} themeName={themeName} />
                    {/* Cardio Load (TRIMP) — analogue to weekly strength
                        volume. Auto-hides when the user has no cardio_load
                        signal yet, so it doesn't crowd new accounts. */}
                    <View style={{ marginTop: 12 }}>
                      <CardioLoadCard token={authToken} themeName={themeName} />
                    </View>
                    {/* Cardio progression — PRs + 28d pace trend. Auto-hides
                        when the user has no run/ride history. */}
                    <View style={{ marginTop: 12 }}>
                      <CardioProgressionCard token={authToken} themeName={themeName} />
                    </View>

                    {paceExerciseGroups.length > 0 ? (
                      <>
                        {selectedCardioGroup && (
                          <>
                            <Text style={[styles.sectionLabel, { marginTop: 4 }]}>Metric</Text>
                            <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast" contentContainerStyle={styles.exerciseChipScroller}>
                              {([
                                ['distance', 'Distance'],
                                ['pace', 'Pace'],
                                ['duration', 'Duration'],
                              ] as Array<[CardioChartMode, string]>).map(([mode, label]) => {
                                const active = effectiveCardioChartMode === mode;
                                const available = cardioModeAvailable[mode];
                                return (
                                  <AnimatedPressable
                                    key={mode}
                                    disabled={!available}
                                    style={[styles.exerciseChip, active && styles.exerciseChipActive, !available && styles.disabledChip]}
                                    onPress={() => setCardioChartMode(mode)}
                                    scaleDown={0.95}>
                                    <Text style={[styles.exerciseChipText, active && styles.exerciseChipTextActive, !available && styles.disabledChipText]} numberOfLines={1}>
                                      {label}
                                    </Text>
                                  </AnimatedPressable>
                                );
                              })}
                            </ScrollView>
                          </>
                        )}

                        <Text style={styles.sectionLabel}>Select cardio</Text>
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast" contentContainerStyle={styles.exerciseChipScroller}>
                          {paceExerciseGroups.map(group => (
                            <AnimatedPressable
                              key={group.key}
                              style={[styles.exerciseChip, selectedCardioGroup?.key === group.key && styles.exerciseChipActive]}
                              onPress={() => setSelectedCardioExercise(group.key)}
                              scaleDown={0.95}>
                              <Text
                                style={[styles.exerciseChipText, selectedCardioGroup?.key === group.key && styles.exerciseChipTextActive]}
                                numberOfLines={1}
                                ellipsizeMode="tail">
                                {group.name}
                              </Text>
                            </AnimatedPressable>
                          ))}
                        </ScrollView>

                        {selectedCardioGroup ? (() => {
                          const mode = effectiveCardioChartMode;
                          const rows = mode === 'pace'
                            ? selectedCardioGroup.pacePoints
                            : mode === 'duration'
                              ? selectedCardioGroup.durationPoints
                              : selectedCardioGroup.distancePoints;
                          if (rows.length < 2) {
                            return (
                              <View style={styles.cardioChartEmpty}>
                                <Ionicons name="trending-up-outline" size={30} color={tc.textMuted} />
                                <Text style={styles.emptyTitle}>Need one more {mode} log</Text>
                                <Text style={styles.emptyBody}>
                                  {selectedCardioGroup.name} has {rows.length} usable {mode} log{rows.length === 1 ? '' : 's'}.
                                </Text>
                              </View>
                            );
                          }

                          if (mode === 'pace') {
                            const paceValues = rows.map(p => paceSeconds(p.pace)!).filter(v => v != null);
                            const durationSourceNote = cardioDurationSourceNote(rows);
                            const paceMin = Math.min(...paceValues);
                            const paceMax = Math.max(...paceValues);
                            const chartW = Math.max(320, rows.length * 52);
                            const chartH = 150;
                            const padL = 42;
                            const padR = 16;
                            const padT = 16;
                            const padB = 30;
                            const plotW = chartW - padL - padR;
                            const plotH = chartH - padT - padB;
                            const rangeMin = Math.max(0, paceMin - 20);
                            const rangeMax = paceMax + 20;
                            const rangeDelta = rangeMax - rangeMin || 1;
                            const pts = paceValues.map((v, i) => ({
                              x: padL + (paceValues.length > 1 ? (i / (paceValues.length - 1)) * plotW : plotW / 2),
                              y: padT + ((v - rangeMin) / rangeDelta) * plotH,
                              val: v,
                              label: (() => { const d = new Date(rows[i].date); return `${d.getMonth() + 1}/${d.getDate()}`; })(),
                            }));
                            const paceAreaPoints = [
                              `${pts[0].x},${chartH - padB}`,
                              ...pts.map(p => `${p.x},${p.y}`),
                              `${pts[pts.length - 1].x},${chartH - padB}`,
                            ].join(' ');
                            const latest = paceValues[paceValues.length - 1];
                            const first = paceValues[0];
                            const best = Math.min(...paceValues);
                            const delta = latest - first;
                            return (
                              <View testID="progress-cardio-chart" style={styles.cardioChartPanel}>
                                <View style={styles.graphHeader}>
                                  <Text style={styles.graphTitle} numberOfLines={2}>{selectedCardioGroup.name}</Text>
                                  <Text style={[styles.graphScore, { color: delta <= 0 ? tc.primary : tc.error }]}>
                                    {formatPaceDelta(delta)}
                                  </Text>
                                </View>
                                <Text style={styles.graphSubtitle}>
                                  Pace over time. Lower is faster.{durationSourceNote ? ` ${durationSourceNote}` : ''}
                                </Text>
                                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                                  <Svg width={chartW} height={chartH}>
                                    <Defs>
                                      <SvgLinearGradient id="paceAreaGradient" x1="0" y1="0" x2="0" y2="1">
                                        <Stop offset="0%" stopColor={tc.primary} stopOpacity="0.22" />
                                        <Stop offset="62%" stopColor={tc.primary} stopOpacity="0.10" />
                                        <Stop offset="100%" stopColor={tc.primary} stopOpacity="0.02" />
                                      </SvgLinearGradient>
                                    </Defs>
                                    {[rangeMin, (rangeMin + rangeMax) / 2, rangeMax].map((gv, gi) => {
                                      const gy = padT + ((gv - rangeMin) / rangeDelta) * plotH;
                                      return (
                                        <Fragment key={`pace-grid-${gi}`}>
                                          <Line x1={padL} y1={gy} x2={chartW - padR} y2={gy} stroke={tc.border} strokeWidth={1} strokeDasharray="4,4" />
                                          <SvgText x={padL - 7} y={gy + 4} fontSize={10} fill={tc.textMuted} textAnchor="end">
                                            {formatPaceSeconds(gv)}
                                          </SvgText>
                                        </Fragment>
                                      );
                                    })}
                                    <Polygon points={paceAreaPoints} fill="url(#paceAreaGradient)" />
                                    <Polyline
                                      points={pts.map(p => `${p.x},${p.y}`).join(' ')}
                                      fill="none"
                                      stroke={tc.primary}
                                      strokeWidth={2.5}
                                      strokeLinejoin="round"
                                      strokeLinecap="round"
                                    />
                                    {pts.map((p, i) => (
                                      <Fragment key={`pace-point-${i}`}>
                                        <Circle
                                          cx={p.x}
                                          cy={p.y}
                                          r={i === pts.length - 1 ? 5 : 3.5}
                                          fill={i === pts.length - 1 ? tc.accent : tc.primary}
                                          stroke={tc.surface}
                                          strokeWidth={1.5}
                                        />
                                        {pts.length <= 10 && (
                                          <SvgText x={p.x} y={chartH - 8} fontSize={9} fill={tc.textMuted} textAnchor="middle">
                                            {p.label}
                                          </SvgText>
                                        )}
                                      </Fragment>
                                    ))}
                                  </Svg>
                                </ScrollView>
                                <View style={styles.chartSummaryRow}>
                                  <View style={styles.chartStat}>
                                    <Text style={styles.chartStatValue}>{formatPaceSeconds(latest)}</Text>
                                    <Text style={styles.chartStatLabel}>Latest pace</Text>
                                  </View>
                                  <View style={styles.chartStat}>
                                    <Text style={styles.chartStatValue}>{formatPaceSeconds(best)}</Text>
                                    <Text style={styles.chartStatLabel}>Best pace</Text>
                                  </View>
                                  <View style={styles.chartStat}>
                                    <Text style={[styles.chartStatValue, { color: delta <= 0 ? tc.primary : tc.error }]}>
                                      {formatPaceDelta(delta)}
                                    </Text>
                                    <Text style={styles.chartStatLabel}>vs first</Text>
                                  </View>
                                </View>
                              </View>
                            );
                          }

                          const values = rows.map(p => mode === 'duration' ? Math.round((p.duration_seconds ?? 0) / 60) : (p.distance ?? 0));
                          const durationSourceNote = mode === 'duration' ? cardioDurationSourceNote(rows) : null;
                          const maxVal = Math.max(...values, 1);
                          const latest = values[values.length - 1];
                          const first = values[0];
                          const best = Math.max(...values);
                          const delta = latest - first;
                          const chartMinWidth = Math.max(Math.round(screenWidth - 58), rows.length * 48);
                          const formatMetric = (value: number) => mode === 'duration'
                            ? `${Math.round(value)}m`
                            : formatDistance(value, distanceUnit, { suffix: false });
                          return (
                            <View testID="progress-cardio-chart" style={styles.cardioChartPanel}>
                              <View style={styles.graphHeader}>
                                <Text style={styles.graphTitle} numberOfLines={2}>{selectedCardioGroup.name}</Text>
                                <Text style={[styles.graphScore, { color: delta >= 0 ? tc.primary : tc.error }]}>
                                  {delta >= 0 ? '+' : '-'}{mode === 'duration' ? `${Math.round(Math.abs(delta))}m` : formatDistance(Math.abs(delta), distanceUnit)}
                                </Text>
                              </View>
                              <Text style={styles.graphSubtitle}>
                                {mode === 'duration'
                                  ? `Duration per session${durationSourceNote ? ` - ${durationSourceNote}` : ''}`
                                  : `Distance per session (${distanceUnit})`}
                              </Text>
                              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                                <View style={[styles.cardioGraphBars, { minWidth: chartMinWidth }]}>
                                  {rows.map((point, i) => {
                                    const val = values[i];
                                    const h = Math.max(12, Math.round((val / maxVal) * 106));
                                    const isLast = i === rows.length - 1;
                                    const d = new Date(point.date);
                                    return (
                                      <View
                                        key={`${point.date}-${i}`}
                                        style={styles.cardioGraphBarCol}
                                        accessible
                                        accessibilityLabel={`${selectedCardioGroup.name} ${mode} on ${point.date}: ${formatMetric(val)}`}>
                                        <Text style={[styles.graphBarValue, isLast && { color: tc.primary }]} numberOfLines={1}>
                                          {formatMetric(val)}
                                        </Text>
                                        <AnimatedChartBar
                                          targetHeight={h}
                                          delay={i * 35}
                                          style={[styles.cardioGraphBar, isLast && { backgroundColor: tc.primary }]}
                                        />
                                        <Text style={styles.graphBarLabel}>{d.getMonth() + 1}/{d.getDate()}</Text>
                                      </View>
                                    );
                                  })}
                                </View>
                              </ScrollView>
                              <View style={styles.chartSummaryRow}>
                                <View style={styles.chartStat}>
                                  <Text style={styles.chartStatValue}>{formatMetric(latest)}</Text>
                                  <Text style={styles.chartStatLabel}>Latest</Text>
                                </View>
                                <View style={styles.chartStat}>
                                  <Text style={styles.chartStatValue}>{formatMetric(best)}</Text>
                                  <Text style={styles.chartStatLabel}>{mode === 'duration' ? 'Longest' : 'Best distance'}</Text>
                                </View>
                                <View style={styles.chartStat}>
                                  <Text style={[styles.chartStatValue, { color: delta >= 0 ? tc.primary : tc.error }]}>
                                    {delta >= 0 ? '+' : '-'}{mode === 'duration' ? `${Math.round(Math.abs(delta))}m` : formatDistance(Math.abs(delta), distanceUnit)}
                                  </Text>
                                  <Text style={styles.chartStatLabel}>vs first</Text>
                                </View>
                              </View>
                            </View>
                          );
                        })() : null}
                      </>
                    ) : (
                      <View style={styles.cardioChartEmpty}>
                        <Ionicons name="walk-outline" size={30} color={tc.textMuted} />
                        <Text style={styles.emptyTitle}>No cardio charts yet</Text>
                        <Text style={styles.emptyBody}>Log distance, pace, or duration to start a cardio chart.</Text>
                      </View>
                    )}
                  </View>
                </View>
              )}
              {trendsShown('cardio-progression') && cardioInsightsMemo.length === 0 && paceExerciseGroups.length === 0 && (
                <View style={[styles.emptyBox, { paddingTop: 36, paddingBottom: 18 }]}>
                  <Ionicons name="pulse-outline" size={34} color={tc.textMuted} />
                  <Text style={styles.emptyTitle}>No cardio trends yet</Text>
                  <Text style={styles.emptyBody}>Log distance, pace, duration, or HR zones to build cardio progression.</Text>
                </View>
              )}
            </>
          ))}
        </ScrollView>
      ) : tab === 'insights' ? (
        <HealthInsightsScreen
          authToken={authToken}
          themeName={themeName}
          days={14}
          embedded
          showHeader={false}
          onChromeScroll={handleProgressChromeScroll}
        />
      ) : tab === 'health' ? (
        /* ── Health Tab ─────────────────────────────────────────────── */
        <ScrollView
          contentContainerStyle={styles.content}
          onScroll={handleProgressChromeScroll}
          scrollEventThrottle={16}>
          <View style={{ alignItems: 'flex-end', marginBottom: 8 }}>
            <AnimatedPressable
              testID="progress-edit-health"
              accessibilityRole="button"
              accessibilityLabel="Edit Health"
              onPress={() => { import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {}); setEditHealthOpen(true); }}
              scaleDown={0.97}
              style={[styles.healthEditButton, { borderColor: tc.primary + '28', backgroundColor: tc.surface }]}>
              <LinearGradient
                pointerEvents="none"
                colors={[tc.primary + '16', '#14B8A612', 'rgba(255,255,255,0)']}
                locations={[0, 0.62, 1]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
              <Ionicons name="options-outline" size={15} color={tc.textSecondary} />
              <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textSecondary }}>Edit Health</Text>
            </AnimatedPressable>
          </View>
          {!isProTier && (
            <FadeInView delay={0} duration={TIMING_STANDARD.duration} slideDistance={6} style={styles.vitalsCard}>
              <View style={{ alignItems: 'center', paddingVertical: 12 }}>
                <Ionicons name="lock-closed-outline" size={32} color={tc.textMuted} />
                <Text style={{ fontSize: 16, fontWeight: '800', color: tc.textPrimary, marginTop: 8 }}>Health insights are Pro</Text>
                <Text style={{ fontSize: 12, color: tc.textSecondary, textAlign: 'center', lineHeight: 18, marginTop: 6 }}>
                  Free keeps manual weight, body, workout, and meal history. {HEALTH_PLATFORM_PRO_COPY}
                </Text>
              </View>
            </FadeInView>
          )}
          {isProTier && !isHealthKitAvailable() && (
            <HealthDataImageCard
              tc={tc}
              styles={styles}
              title={`${HEALTH_PLATFORM_LABEL} unavailable`}
              subtitle={HEALTH_PLATFORM_STATUS_COPY}
              badge="Device"
              iconName="heart-outline"
              imageUri={HEALTH_DATA_EMPTY_IMAGE}>
              <View style={{ alignItems: 'center', paddingVertical: 4 }}>
                <Text {...dynamicTextProps} style={{ fontSize: 12, color: tc.textSecondary, textAlign: 'center', lineHeight: 18 }}>
                  Manual logs still work normally. Connect a supported health source when available to unlock sleep, HRV, heart, activity, and recovery signals.
                </Text>
              </View>
            </HealthDataImageCard>
          )}

          {healthShown('health-vitals-overview') && healthVitalsOverviewCard && (
            <FadeInView delay={0} duration={TIMING_STANDARD.duration} slideDistance={6}>
              {healthVitalsOverviewCard}
            </FadeInView>
          )}

          {healthShown('health-labs') && isProTier && (
            <View style={styles.healthLabsSection}>
              <HealthLabsCard
                authToken={authToken}
                userProfile={userProfile}
                themeName={themeName}
                isActive={isActive && tab === 'health'}
              />
            </View>
          )}

          {healthShown('metabolic-signals') && isProTier && (
            <FadeInView delay={35} duration={TIMING_STANDARD.duration} slideDistance={6}>
              <MetabolicSignalsCard
                authToken={authToken}
                themeName={themeName}
                isActive={isActive && tab === 'health'}
              />
            </FadeInView>
          )}


          {/* Nutrition & Gut Facts — 14-day logged-food window (facts only, no scores). */}
          {healthShown('nutrition-gut') && showMealProgress && isProTier && (gutHealthWindow || mealAverages) && (
            <View testID="nutrition-gut-facts-card" style={[styles.vitalsCard, styles.nutritionGutFactsCard, { marginTop: 0 }]}>
              <TouchableOpacity
                testID="nutrition-gut-facts-toggle"
                activeOpacity={0.7}
                onPress={() => { configureExpandAnimation(300); setNutritionGutExpanded(prev => !prev); }}
              >
                <ImageBackground
                  source={{ uri: NUTRITION_GUT_FACTS_IMAGE }}
                  resizeMode="cover"
                  imageStyle={styles.nutritionGutHeroImage}
                  style={styles.nutritionGutHero}>
                  <LinearGradient
                    colors={['rgba(0,0,0,0.02)', 'rgba(0,0,0,0.58)']}
                    style={StyleSheet.absoluteFill}
                  />
                  <View style={styles.nutritionGutHeroMeta}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.nutritionGutEyebrow}>Health facts</Text>
                      <Text style={styles.nutritionGutHeroTitle} numberOfLines={1}>Nutrition & Gut Facts</Text>
                    </View>
                    {gutHealthWindow && (
                      <View style={styles.nutritionGutDataPill}>
                        <Text
                          testID={`nutrition-gut-facts-days-${gutHealthWindow.days_with_data}`}
                          style={styles.nutritionGutDataPillText}>
                          {gutHealthWindow.days_with_data}d data
                        </Text>
                      </View>
                    )}
                    <Ionicons name={nutritionGutExpanded ? 'chevron-up' : 'chevron-down'} size={17} color="#FFFFFF" />
                  </View>
                </ImageBackground>
              </TouchableOpacity>

              <View style={styles.nutritionGutFactsContent}>
              {/* Top-row averages render BEFORE expansion — gives a
                  glanceable snapshot (Fiber, Added sugar, Plants) so the
                  card has visible content even when collapsed. */}
              {gutHealthWindow && gutHealthWindow.days_with_data > 0 && (
                <View style={{ marginBottom: nutritionGutExpanded ? 14 : 0 }}>
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
                        <Text
                          testID={s.label === 'Fiber/day' ? `nutrition-gut-fiber-${s.value}` : undefined}
                          style={{ fontSize: 18, fontWeight: '900', color: tc.textPrimary }}>
                          {s.value}
                        </Text>
                        <Text style={{ fontSize: 9, fontWeight: '600', color: tc.textMuted, marginTop: 2 }}>{s.label}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              )}

              {nutritionGutExpanded && <>
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
                        <Text
                          testID={s.label === 'Calories' ? `nutrition-facts-macro-calories-${s.value}` : undefined}
                          style={{ fontSize: 15, fontWeight: '800', color: s.color }}>
                          {s.value}
                        </Text>
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
                          <AnimatedProgressFill
                            pct={Math.min(100, (gutHealthWindow.avg_fiber_g / 28) * 100)}
                            color={fiberColor}
                            delay={100}
                            style={{ height: 5, borderRadius: 3 }}
                          />
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
                          <AnimatedProgressFill
                            pct={Math.min(100, (count / 30) * 100)}
                            color={color}
                            delay={140}
                            style={{ height: 5, borderRadius: 3 }}
                          />
                        </View>
                        <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 3 }}>
                          30+ distinct plants/week linked to improved microbiome diversity
                        </Text>
                      </View>
                    );
                  })()}

                  {/* Metric rows */}
                  {(() => {
                    const days = Math.max(1, gutHealthWindow.days_with_data || 1);
                    const avgFermented = Number((gutHealthWindow as any).avg_fermented_servings ?? (gutHealthWindow.fermented_servings / days));
                    const avgProbiotic = Number((gutHealthWindow as any).avg_probiotic_servings ?? ((gutHealthWindow.probiotic_servings ?? 0) / days));
                    const avgOmega3 = Number((gutHealthWindow as any).avg_omega3_servings ?? (gutHealthWindow.omega3_servings / days));
                    const omega3Supp = Number((gutHealthWindow as any).omega3_supplement_servings ?? 0);
                    const fmtAvg = (value: number) => `${Number.isFinite(value) ? Math.round(value * 10) / 10 : 0} / day avg`;
                    return [
                      { icon: 'flask-outline', label: 'Fermented foods', value: fmtAvg(avgFermented), detail: `${Math.round(gutHealthWindow.fermented_servings * 10) / 10} total servings logged` },
                      { icon: 'medkit-outline', label: 'Probiotic servings', value: fmtAvg(avgProbiotic), detail: `${Math.round((gutHealthWindow.probiotic_servings ?? 0) * 10) / 10} total live-culture servings logged` },
                      { icon: 'fish-outline', label: 'Omega-3', value: fmtAvg(avgOmega3), detail: omega3Supp > 0 ? `Food + ${Math.round(omega3Supp * 10) / 10} logged supplement serving${omega3Supp === 1 ? '' : 's'}` : 'Food sources logged in meals' },
                      // Collagen — AI-estimated from every logged food, not
                      // a keyword match. Shows daily average for readability.
                      { icon: 'pulse-outline', label: 'Collagen', value: `${Math.round((gutHealthWindow as any).avg_collagen_g ?? 0)}g / day avg`, detail: 'AI-estimated from bone broth, skin-on cuts, gelatin, supplements' },
                    ];
                  })().map(row => (
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
                          {gutHealthWindow.plant_protein_g > 0 && (
                            <AnimatedProgressFill pct={plantPct} color="#22C55E" delay={80} style={{ height: '100%' }} />
                          )}
                          {gutHealthWindow.animal_protein_g > 0 && (
                            <AnimatedProgressFill pct={100 - plantPct} color={tc.primary} delay={120} style={{ height: '100%' }} />
                          )}
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
                      {['minimally_processed', 'processed', 'ultra_processed', 'unknown'].map((b, i) => {
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
                              <AnimatedProgressFill
                                pct={pct}
                                minPct={3}
                                color={color}
                                delay={staggerDelay(i, 30)}
                                style={{ height: 6, borderRadius: 3 }}
                              />
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
                      <AnimatedProgressFill
                        pct={Math.min(100, (gutInsights.plantCount / 30) * 100)}
                        color={gutInsights.plantTier === 'on_track' ? '#22C55E' : gutInsights.plantTier === 'building' ? '#F59E0B' : '#EF4444'}
                        delay={100}
                        style={{ height: 5, borderRadius: 3 }}
                      />
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
                      <AnimatedProgressFill
                        pct={Math.min(100, gutInsights.fiberToday.pct)}
                        color={gutInsights.fiberToday.pct >= 80 ? '#22C55E' : '#F59E0B'}
                        delay={140}
                        style={{ height: 5, borderRadius: 3 }}
                      />
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
                    Log meals to see weekly nutrition and gut facts.
                  </Text>
                </View>
              )}
              </>}
              </View>
            </View>
          )}

          {healthShown('sun-exposure') && isProTier && (
            <FadeInView delay={45} duration={TIMING_STANDARD.duration} slideDistance={6}>
              <View style={styles.healthSunExposureSection}>
                <SunExposureHealthCard
                  authToken={authToken}
                  themeName={themeName}
                  isActive={isActive && tab === 'health'}
                />
              </View>
            </FadeInView>
          )}

          {/* Device health vitals */}
          {healthShown('device-vitals') && isProTier && isHealthKitAvailable() && healthEnabled && !hasDisplayableHealthSummaryData(healthSummary) && !healthVitalsOverviewCard && (() => {
            const hs = healthSummary;
            const hasAnyData = hasDisplayableHealthSummaryData(hs);
            const availableSignals = getHealthSummarySignalAvailability(hs);

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
                        }
                        if (granted) {
                          import('../services/healthDataSummary')
                            .then(({ backfillSnapshotsToBackend, refreshHealthDataSummary }) => {
                              refreshHealthDataSummary({ age }).catch(() => null);
                              // 180-day backfill on first connection — UI
                              // populates as recent chunks land; older
                              // ones fill in over the next few seconds.
                              backfillSnapshotsToBackend(180).catch(() => null);
                            })
                            .catch(() => null);
                        }
                        const hasAny = hasDisplayableHealthSummaryData(fresh);
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
                <HealthDataImageCard
                  tc={tc}
                  styles={styles}
                  title={`${HEALTH_DATA_LABEL} is optional`}
                  subtitle="Connect Apple Health or source apps when you want shared signals folded into Thallo."
                  badge="Optional"
                  iconName="heart-outline"
                  imageUri={HEALTH_DATA_CONNECT_IMAGE}>
                  <View style={{ alignItems: 'center', paddingVertical: 4 }}>
                    <Text {...dynamicTextProps} style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center', lineHeight: 18, marginBottom: 14 }}>
                      Optional sync for health categories that actually have data from your iPhone, Apple Watch, or connected apps. Missing categories stay hidden until Apple Health returns samples.{showWorkoutProgress ? ' Thallo can also write completed workout details back to Apple Health.' : ''}
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
                </HealthDataImageCard>
              );
            }

            if (!hasAnyData && (healthReading || healthConnecting)) {
              return (
                <HealthDataImageCard
                  tc={tc}
                  styles={styles}
                  title={`Reading ${HEALTH_DATA_LABEL}`}
                  subtitle="Pulling shared health samples that are available on this device."
                  badge="Syncing"
                  iconName="sync-outline"
                  imageUri={HEALTH_DATA_SYNC_IMAGE}>
                  <View style={{ alignItems: 'center', paddingVertical: 4 }}>
                    <ActivityIndicator color={tc.primary} />
                    <Text {...dynamicTextProps} style={{ fontSize: 12, color: tc.textSecondary, textAlign: 'center', lineHeight: 17, marginTop: 4 }}>
                      This can take a moment. Rows only appear for categories Apple Health returns.
                    </Text>
                  </View>
                </HealthDataImageCard>
              );
            }

            if (!hasAnyData) {
              return (
                <HealthDataImageCard
                  tc={tc}
                  styles={styles}
                  title={`No ${HEALTH_DATA_LABEL.toLowerCase()} data yet`}
                  subtitle="Connected, but Apple Health has not returned displayable samples."
                  badge="Empty"
                  iconName="cloud-offline-outline"
                  imageUri={HEALTH_DATA_EMPTY_IMAGE}>
                  <View style={{ alignItems: 'center', paddingVertical: 4 }}>
                    <Text {...dynamicTextProps} style={{ fontSize: 12, color: tc.textSecondary, textAlign: 'center', lineHeight: 17, marginBottom: 12 }}>
                      Thallo still works normally. Tap Refresh to retry, or open iOS Settings to share categories that your iPhone, Apple Watch, or connected apps are recording.
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <TouchableOpacity
                        style={{ backgroundColor: tc.primary, borderRadius: radius.md, paddingVertical: 10, paddingHorizontal: 22 }}
                        disabled={healthConnecting}
                        onPress={async () => {
                          // Force a re-read. The live-load effect's
                          // ref-guard would otherwise short-circuit
                          // until the user navigated away and back.
                          setHealthConnecting(true);
                          healthLiveLoadedRef.current = false;
                          try {
                            const age = userProfile.physicalStats?.age ?? null;
                            const fresh = await readFreshProgressHealthSummary(age, true);
                            if (fresh) {
                              healthLiveLoadedRef.current = true;
                              setHealthSummary(fresh);
                              saveHealthSummary(fresh).catch(() => null);
                              loadProgressSleepHistory(authToken, fresh).then(setSleepHistory).catch(() => null);
                            } else {
                              Alert.alert(
                                'No Apple Health data returned',
                                'Apple Health did not return displayable samples this time. In iOS Settings -> Privacy & Security -> Health -> Thallo, share the categories your iPhone, Apple Watch, or connected apps are recording.',
                              );
                            }
                          } finally {
                            setHealthConnecting(false);
                          }
                        }}
                      >
                        {healthConnecting
                          ? <ActivityIndicator color={getContrastingTextColor(tc.primary)} />
                          : <Text style={{ color: getContrastingTextColor(tc.primary), fontWeight: '700', fontSize: 13 }}>Refresh</Text>}
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={{ borderWidth: 1, borderColor: tc.border, borderRadius: radius.md, paddingVertical: 10, paddingHorizontal: 22 }}
                        onPress={handleOpenSettings}
                      >
                        <Text style={{ color: tc.textPrimary, fontWeight: '600', fontSize: 13 }}>iOS Settings</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </HealthDataImageCard>
              );
            }

            // Personal RHR / HRV baselines from the persisted sleep
            // history. Same `median` strategy the Thallo Score uses, so
            // the chip + the recovery pillar agree on what "below
            // baseline" means. Computed inline (not memoized) because
            // the parent useMemo block already sees `sleepHistory` and
            // this IIFE only runs once per render.
            const medianOf = (xs: number[]): number | null => {
              const valid = xs.filter(v => Number.isFinite(v) && v > 0).slice().sort((a, b) => a - b);
              if (valid.length === 0) return null;
              const mid = Math.floor(valid.length / 2);
              return valid.length % 2 === 0 ? (valid[mid - 1] + valid[mid]) / 2 : valid[mid];
            };
            const recent30 = sleepHistory.slice(-30);
            const rhrBaseline30 = medianOf(recent30.map(n => Number(n.restingHr ?? 0)));
            const hrvBaseline30 = medianOf(recent30.map(n => Number(n.hrv ?? 0)));

            // Trend chip — small dot + 1–3 word label after each value.
            // `improving` is green (healthy direction), `monitor` is
            // amber, `onTrack` is muted (not green so it doesn't
            // gamify "everything must be green"), null hides entirely.
            const trendChip = (result: VitalTrendResult) => {
              if (!result.trend) return null;
              const color =
                result.trend === 'improving' ? '#22C55E'
                : result.trend === 'monitor' ? '#F59E0B'
                : tc.textMuted;
              return (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
                  <Text style={{ fontSize: 10, fontWeight: '600', color, letterSpacing: 0.2 }}>
                    {result.label}
                  </Text>
                </View>
              );
            };

            const vitalsRow = (
              icon: string,
              label: string,
              value: string | number | null,
              unit?: string,
              trend?: VitalTrendResult,
            ) => (
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: tc.border + '44' }}>
                <Ionicons name={icon as any} size={18} color={tc.primary} style={{ width: 28 }} />
                <Text style={{ fontSize: 13, color: tc.textSecondary, flex: 1 }}>{label}</Text>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={{ fontSize: 16, fontWeight: '700', color: value != null ? tc.textPrimary : tc.textMuted }}>
                    {value != null ? (typeof value === 'number' ? value.toLocaleString() : value) : '—'}
                    {value != null && unit ? <Text style={{ fontSize: 11, fontWeight: '500', color: tc.textMuted }}> {unit}</Text> : null}
                  </Text>
                  {trend ? trendChip(trend) : null}
                </View>
              </View>
            );
            const workoutCount = Array.isArray(hs?.workoutDetails) ? hs.workoutDetails.length : 0;
            const workoutMinutes = Array.isArray(hs?.workoutDetails)
              ? hs.workoutDetails.reduce((sum, workout) => sum + (Number(workout.duration ?? 0) || 0), 0)
              : 0;
            const workoutValue = workoutCount > 0
              ? `${workoutCount} workout${workoutCount === 1 ? '' : 's'}`
              : null;
            const workoutUnit = workoutMinutes > 0 ? `${Math.round(workoutMinutes)} min` : undefined;

            return (
              <HealthDataImageCard
                tc={tc}
                styles={styles}
                title={HEALTH_DATA_LABEL}
                subtitle="Rolling 7-day snapshot from shared signals Apple Health returned."
                badge="7D"
                iconName="heart-outline"
                imageUri={HEALTH_DATA_READY_IMAGE}>
                {availableSignals.restingHeartRate && vitalsRow('pulse-outline', 'Resting HR', hs!.restingHeartRate, 'bpm',
                  classifyRestingHeartRate(hs!.restingHeartRate, rhrBaseline30))}
                {availableSignals.hrvAvg && vitalsRow('analytics-outline', 'HRV', hs!.hrvAvg, 'ms',
                  classifyHrv(hs!.hrvAvg, hrvBaseline30))}
                {availableSignals.avgSteps7d && vitalsRow('walk-outline', 'Steps (avg)', hs!.avgSteps7d, undefined,
                  classifyAvgSteps(hs!.avgSteps7d))}
                {availableSignals.activeEnergy7d && vitalsRow('flame-outline', 'Active calories', hs!.activeEnergy7d, 'kcal',
                  classifyActiveEnergy(hs!.activeEnergy7d))}
                {availableSignals.avgSleepHours7d && vitalsRow('moon-outline', 'Sleep (avg)', hs!.avgSleepHours7d != null ? (() => {
                  const total = Math.round(hs!.avgSleepHours7d! * 60);
                  const h = Math.floor(total / 60), m = total % 60;
                  return m > 0 ? `${h}h ${m}m` : `${h}h`;
                })() : null, undefined,
                  classifyAvgSleepHours(hs!.avgSleepHours7d))}
                {availableSignals.workouts && vitalsRow('fitness-outline', 'Workouts', workoutValue, workoutUnit)}
                {availableSignals.vo2Max && vitalsRow('speedometer-outline', 'VO2 Max', Math.round(hs!.vo2Max! * 10) / 10, 'ml/kg/min')}
                {availableSignals.respiratoryRate && vitalsRow('leaf-outline', 'Respiratory rate', hs!.respiratoryRate, 'brpm')}
                {availableSignals.oxygenSaturation && vitalsRow('water-outline', 'Blood oxygen', hs!.oxygenSaturation, '%')}
                {availableSignals.standingHours7d && vitalsRow('body-outline', 'Standing hours', hs!.standingHours7d, 'hrs')}
                {availableSignals.mindfulMinutes7d && vitalsRow('flower-outline', 'Mindful minutes', hs!.mindfulMinutes7d, 'min')}
                {availableSignals.basalEnergy7d && vitalsRow('flash-outline', 'Basal energy', hs!.basalEnergy7d, 'kcal')}
              </HealthDataImageCard>
            );
          })()}

          {/* Muscle Distribution moved to Body tab */}
        </ScrollView>
      ) : tab === 'body' ? (
        /* ── Body Tab ───────────────────────────────────────────────── */
        <ScrollView
          contentContainerStyle={styles.content}
          onScroll={handleProgressChromeScroll}
          scrollEventThrottle={16}>
          {/* Per-muscle recovery (moved from Health tab) — shows fatigue across
              all 12 muscle groups with the full expanded bars. */}
          {showWorkoutProgress && isProTier && muscleFatigue && (
            <RecoveryCard data={muscleFatigue as any} themeName={themeName} />
          )}

          {/* Muscle Distribution — volume share across muscle groups */}
          {showWorkoutProgress && isProTier && muscleBalance && muscleBalance.total_sets > 0 && (() => {
            const entries = Object.entries(muscleBalance.muscles);
            const detailEntries = Object.entries(muscleBalance.detail_muscles ?? {});
            const maxSets = entries.length ? Math.max(...entries.map(([, v]) => v.sets)) : 1;
            const maxDetailSets = detailEntries.length ? Math.max(...detailEntries.map(([, v]) => v.sets)) : 1;
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
            // A word reads as a verdict; a third 0-100 numeral on this tab
            // just competes with the others. The exact score still lives in
            // the expanded breakdown context.
            const balanceLabel = score >= 70 ? 'Balanced' : score >= 45 ? 'Uneven' : 'Skewed';

            return (
              <View style={[styles.vitalsCard, { marginTop: 0 }]}>
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={() => { configureExpandAnimation(300); setMuscleBalanceExpanded(prev => !prev); }}
                >
                  <View style={[styles.vitalsHeader, { marginBottom: muscleBalanceExpanded ? 12 : 0 }]}>
                    <Ionicons name="body-outline" size={16} color={tc.primary} />
                    <Text style={[styles.vitalsTitle, { color: tc.textPrimary, flex: 1 }]}>Muscle Distribution</Text>
                    <View style={{ backgroundColor: scoreColor + '1A', borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 }}>
                      <Text style={{ fontSize: 11, fontWeight: '600', color: scoreColor }}>{balanceLabel}</Text>
                    </View>
                    <Ionicons name={muscleBalanceExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={tc.textMuted} style={{ marginLeft: 6 }} />
                  </View>
                </TouchableOpacity>
                {muscleBalanceExpanded && (
                  <View style={{ gap: 6 }}>
                    <Text style={{ fontSize: 10, color: tc.textMuted, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>
                      {muscleBalance.period_days}d / {Math.round(muscleBalance.total_sets)} total sets
                    </Text>
                    {entries.map(([muscle, data], index) => (
                      <View key={muscle} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Text style={{ width: 72, fontSize: 11, fontWeight: '600', color: tc.textSecondary, textTransform: 'capitalize' }}>{muscle.replace(/_/g, ' ')}</Text>
                        <View style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: tc.border }}>
                          <AnimatedProgressFill
                            pct={(data.sets / maxSets) * 100}
                            minPct={3}
                            color={barColor(muscle, data.pct)}
                            delay={staggerDelay(index, 28)}
                            style={{ height: 8, borderRadius: 4 }}
                          />
                        </View>
                        <Text style={{ width: 36, fontSize: 11, fontWeight: '700', color: tc.textPrimary, textAlign: 'right' }}>{Math.round(data.sets)}</Text>
                      </View>
                    ))}
                    {detailEntries.length > 0 && (
                      <View style={{ marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: tc.border, gap: 6 }}>
                        <Text style={{ fontSize: 10, color: tc.textMuted, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>
                          Detailed muscles · {Math.round(muscleBalance.detail_total_sets ?? 0)} regional sets
                        </Text>
                        {detailEntries.map(([muscle, data], index) => (
                          <View key={muscle} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <Text style={{ width: 86, fontSize: 11, fontWeight: '600', color: tc.textSecondary }} numberOfLines={1}>
                              {humanizeToken(muscle)}
                            </Text>
                            <View style={{ flex: 1, height: 7, borderRadius: 4, backgroundColor: tc.border }}>
                              <AnimatedProgressFill
                                pct={(data.sets / maxDetailSets) * 100}
                                minPct={3}
                                color={tc.primary}
                                delay={staggerDelay(index, 24)}
                                style={{ height: 7, borderRadius: 4 }}
                              />
                            </View>
                            <Text style={{ width: 36, fontSize: 11, fontWeight: '700', color: tc.textPrimary, textAlign: 'right' }}>{Math.round(data.sets)}</Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                )}
              </View>
            );
          })()}

          {/* Weight */}
          <FadeInView delay={60} duration={TIMING_STANDARD.duration} slideDistance={6}>
          <View
            testID="progress-weight-card"
            style={styles.bodyImageCard}>
            <ImageBackground
              source={{ uri: BODY_WEIGHT_IMAGE }}
              style={styles.bodyImageHeader}
              imageStyle={styles.bodyImageHeaderImage}
            >
              <LinearGradient
                colors={['rgba(0,0,0,0.02)', 'rgba(0,0,0,0.36)']}
                style={styles.bodyImageHeaderGradient}
              />
            </ImageBackground>
            <View style={styles.bodyImageContent}>
            {(() => {
              const latestWeight = weightEntries[weightEntries.length - 1] ?? null;
              const displayWeight = Number(latestWeight?.weightLbs ?? currentWeight);
              const hasDisplayWeight = Number.isFinite(displayWeight) && displayWeight > 0;
              const displaySubtitle = latestWeight
                ? `${new Date(latestWeight.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}${formatLoggedTime(latestWeight.loggedAt)}`
                : 'Profile weight';
              const openWeightLogger = () => {
                setWeightInputValue(hasDisplayWeight ? formatWeight(displayWeight, weightUnit, { suffix: false }) : '');
                setWeightInputError('');
                setWeightInputVisible(true);
              };

              const GOAL_HAS_TARGET_WEIGHT = new Set([
                'lose_fat', 'get_lean', 'cut', 'preserve_muscle_cutting',
                'build_muscle', 'lean_bulk', 'gain_weight',
                'body_recomp', 'tone', 'get_toned',
              ]);
              const isTargetGoal = GOAL_HAS_TARGET_WEIGHT.has(userProfile.goal);
              const target = isTargetGoal ? userProfile.goalDetails?.targetWeightLbs ?? null : null;
              const curr = weightEntries[weightEntries.length - 1]?.weightLbs ?? currentWeight;
              const remaining = target != null && Number.isFinite(curr) ? Math.abs(target - curr) : null;
              const showEstimate = isTargetGoal && !!estimate;

              // Chart window — segmented 30d/90d/all control. Falls back to
              // the full history when the window holds fewer than 2 points so
              // the chart never blanks out under a narrow range.
              const rangeDays = weightChartRange === '30d' ? 30 : weightChartRange === '90d' ? 90 : null;
              const rangeCutoff = rangeDays != null ? Date.now() - rangeDays * 86400000 : null;
              const entriesInRange = rangeCutoff != null
                ? weightEntries.filter(e => +new Date(`${e.date.slice(0, 10)}T12:00:00`) >= rangeCutoff)
                : weightEntries;
              const chartEntries = entriesInRange.length >= 2 ? entriesInRange : weightEntries;
              const chartScans = rangeCutoff != null && entriesInRange.length >= 2
                ? bodyScanHistory.filter(s => +new Date(`${String(s.date ?? '').slice(0, 10)}T12:00:00`) >= rangeCutoff)
                : bodyScanHistory;

              // Trend over the visible window. Direction color is goal-aware:
              // gaining is the win condition for build/bulk goals, not a warning.
              const trendFirst = chartEntries[0];
              const trendLast = chartEntries[chartEntries.length - 1];
              const trendDelta = chartEntries.length >= 2
                ? Math.round((trendLast.weightLbs - trendFirst.weightLbs) * 10) / 10
                : null;
              const trendSpanDays = chartEntries.length >= 2
                ? Math.max(1, Math.round((+new Date(`${trendLast.date.slice(0, 10)}T12:00:00`) - +new Date(`${trendFirst.date.slice(0, 10)}T12:00:00`)) / 86400000))
                : null;
              const trendPerWeek = trendDelta != null && trendSpanDays != null && trendSpanDays >= 7
                ? Math.round((trendDelta / trendSpanDays) * 7 * 10) / 10
                : null;
              const GAIN_GOALS = new Set(['build_muscle', 'lean_bulk', 'gain_weight']);
              const gainGoal = GAIN_GOALS.has(userProfile.goal);
              const trendColor = trendDelta == null || trendDelta === 0
                ? tc.textMuted
                : (trendDelta < 0 ? !gainGoal : gainGoal)
                  ? (tc.success ?? '#22C55E')
                  : (tc.warning ?? '#F59E0B');
              const trendWeeks = trendSpanDays != null ? Math.max(1, Math.round(trendSpanDays / 7)) : null;
              const statChips = [
                trendPerWeek != null
                  ? { key: 'trend', label: 'Trend', value: `${formatSignedWeightDelta(trendPerWeek, weightUnit)}/wk` }
                  : null,
                remaining != null && remaining > 0.05
                  ? { key: 'togoal', label: 'To goal', value: formatWeight(remaining, weightUnit) }
                  : null,
                showEstimate && estimate
                  ? { key: 'eta', label: 'ETA', value: estimate.label }
                  : null,
              ].filter((chip): chip is { key: string; label: string; value: string } => chip != null);

              return (
                <>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <Ionicons name="scale-outline" size={22} color={tc.primary} />
                    <Text style={{ fontSize: 17, fontWeight: '700', color: tc.textPrimary, flex: 1 }}>Weight</Text>
                    <TouchableOpacity
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: tc.primary, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 6 }}
                      onPress={openWeightLogger}>
                      <Ionicons name="add" size={16} color={getContrastingTextColor(tc.primary)} />
                      <Text style={{ fontSize: 13, fontWeight: '600', color: getContrastingTextColor(tc.primary) }}>Log</Text>
                    </TouchableOpacity>
                  </View>

                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <Text
                      testID="progress-weight-current-value"
                      style={{ fontSize: 34, fontWeight: '800', letterSpacing: -0.5, color: tc.textPrimary, fontVariant: ['tabular-nums'] }}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.72}
                    >
                      {hasDisplayWeight ? formatWeight(displayWeight, weightUnit, { suffix: false }) : '—'} <Text style={{ fontSize: 14, fontWeight: '600', color: tc.textMuted }}>{weightUnit}</Text>
                    </Text>
                    {trendDelta != null && trendWeeks != null && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: trendColor + '1A', borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 }}>
                        <Ionicons name={trendDelta < 0 ? 'trending-down' : trendDelta > 0 ? 'trending-up' : 'remove'} size={13} color={trendColor} />
                        <Text style={{ fontSize: 12, fontWeight: '600', color: trendColor }}>
                          {formatSignedWeightDelta(trendDelta, weightUnit)} in {trendWeeks} wk{trendWeeks === 1 ? '' : 's'}
                        </Text>
                      </View>
                    )}
                  </View>
                  <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }}>
                    {displaySubtitle}{latestWeight ? '' : ' · log to start history'}
                  </Text>

                  {weightEntries.length >= 2 && (
                    <>
                      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 10, marginBottom: 4 }}>
                        <View style={{ flexDirection: 'row', backgroundColor: tc.surfaceRaised, borderRadius: 999, padding: 2 }}>
                          {(['30d', '90d', 'all'] as const).map(r => (
                            <TouchableOpacity
                              key={r}
                              accessibilityRole="button"
                              accessibilityState={{ selected: weightChartRange === r }}
                              onPress={() => setWeightChartRange(r)}
                              style={{ paddingHorizontal: 11, paddingVertical: 4, borderRadius: 999, backgroundColor: weightChartRange === r ? tc.surface : 'transparent' }}
                            >
                              <Text style={{ fontSize: 11, fontWeight: '600', color: weightChartRange === r ? tc.textPrimary : tc.textMuted }}>
                                {r === 'all' ? 'All' : r}
                              </Text>
                            </TouchableOpacity>
                          ))}
                        </View>
                      </View>
                      <WeightBodyFatTrendChart
                        weightEntries={chartEntries}
                        bodyScanHistory={chartScans}
                        weightUnit={weightUnit}
                        tc={tc}
                        targetWeightLbs={target}
                      />
                    </>
                  )}

                  {statChips.length > 0 && (
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 2 }}>
                      {statChips.map(chip => (
                        <View key={chip.key} style={{ flex: 1, backgroundColor: tc.surfaceRaised, borderRadius: radius.md, paddingVertical: 8, paddingHorizontal: 10 }}>
                          <Text style={{ fontSize: 11, color: tc.textMuted }}>{chip.label}</Text>
                          <Text style={{ fontSize: 14, fontWeight: '600', color: tc.textPrimary, marginTop: 1 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
                            {chip.value}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}

                  <TouchableOpacity
                    activeOpacity={0.75}
                    accessibilityRole="button"
                    accessibilityLabel={`${weightCardExpanded ? 'Hide' : 'Show'} weight history`}
                    onPress={() => { configureExpandAnimation(300); setWeightCardExpanded(prev => !prev); }}
                    style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: tc.border }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: '600', color: tc.textSecondary }}>
                      History{weightEntries.length > 0 ? ` · ${weightEntries.length}` : ''}
                    </Text>
                    <Ionicons name={weightCardExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={tc.textMuted} />
                  </TouchableOpacity>

                  {weightCardExpanded && (
                    <View style={{ marginTop: 4 }}>
                      {weightEntries.length === 0 ? (
                        <Text style={{ fontSize: 13, color: tc.textMuted, textAlign: 'center', paddingVertical: 8 }}>
                          Log your first weigh-in to start trend history.
                        </Text>
                      ) : (
                        <>
                          {weightEntries.slice(-10).reverse().map((e, i) => (
                            <View key={e.date} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderTopWidth: i > 0 ? 1 : 0, borderTopColor: tc.border }}>
                              <Text style={{ flex: 1, fontSize: 13, color: tc.textSecondary }}>
                                {new Date(e.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                                {formatLoggedTime(e.loggedAt)}
                              </Text>
                              <Text style={{ fontSize: 13, fontWeight: '600', color: tc.textPrimary }}>
                                {formatWeight(e.weightLbs, weightUnit)}
                              </Text>
                              <TouchableOpacity
                                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                onPress={() => {
                                  Alert.alert(
                                    'Delete entry?',
                                    `Remove ${formatWeight(e.weightLbs, weightUnit)} logged on ${new Date(e.date + 'T12:00:00').toLocaleDateString()}? Derived stats (diff, ETA) will recalculate.`,
                                    [
                                      { text: 'Cancel', style: 'cancel' },
                                      {
                                        text: 'Delete',
                                        style: 'destructive',
                                        onPress: async () => {
                                          try {
                                            const { deleteWeightEntry } = await import('../utils/weightHistory');
                                            const next = await deleteWeightEntry(e.date);
                                            setWeightEntries(next);
                                            import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
                                          } catch (err: any) {
                                            Alert.alert('Could not delete', err?.message ?? 'Try again in a moment.');
                                          }
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

                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: tc.border }}>
                            <TouchableOpacity
                              onPress={async () => {
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
                                        try {
                                          const { clearWeightHistory } = await import('../utils/weightHistory');
                                          await clearWeightHistory();
                                          setWeightEntries([]);
                                          import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
                                        } catch (err: any) {
                                          Alert.alert('Could not reset', err?.message ?? 'Try again in a moment.');
                                        }
                                      },
                                    },
                                  ],
                                );
                              }}
                            >
                              <Text style={{ fontSize: 11, color: tc.error }}>Reset history</Text>
                            </TouchableOpacity>
                          </View>
                        </>
                      )}

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
                  )}
                </>
              );
            })()}
            </View>
          </View>
          </FadeInView>

          {/* Body Measurements */}
          <FadeInView delay={110} duration={TIMING_STANDARD.duration} slideDistance={6}>
          <View style={styles.bodyImageCard}>
            <ImageBackground
              source={bodyMeasurementsImageSource(userProfile.physicalStats?.gender)}
              style={styles.bodyImageHeader}
              imageStyle={styles.bodyImageHeaderImage}
            >
              <LinearGradient
                colors={['rgba(0,0,0,0.02)', 'rgba(0,0,0,0.36)']}
                style={styles.bodyImageHeaderGradient}
              />
            </ImageBackground>
            <View style={styles.bodyImageContent}>
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
          </View>
          </FadeInView>

          {/* Scan buttons */}
          {isProTier && <FadeInView delay={160} duration={TIMING_STANDARD.duration} slideDistance={6} style={styles.bodyScanPrompt}>
            <ImageBackground
              source={{ uri: bodyCheckImageUri(userProfile.physicalStats?.gender) }}
              style={styles.bodyScanPromptImage}
              imageStyle={styles.bodyScanPromptImageStyle}
            >
              <LinearGradient
                colors={['rgba(0,0,0,0.02)', 'rgba(0,0,0,0.42)']}
                style={styles.bodyScanPromptImageGradient}
              />
            </ImageBackground>
            <View style={styles.bodyScanPromptContent}>
              <Text style={styles.bodyScanPromptTitle}>Body Check</Text>
              <Text style={styles.bodyScanPromptText}>
                Take a front-facing photo to estimate body fat percentage, muscle mass, and get personalized feedback.
              </Text>
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
                <AnimatedPressable
                  style={[styles.bodyScanBtn, { flex: 1 }, bodyScanLoading && { opacity: 0.55 }]}
                  onPress={() => setBodyScanPrepSource('camera')}
                  disabled={bodyScanLoading}
                  scaleDown={0.96}>
                  <View style={styles.bodyScanBtnContent}>
                    <Ionicons name="camera-outline" size={16} color={primaryButtonTextColor} />
                    <Text style={[styles.bodyScanBtnText, { color: primaryButtonTextColor }]}>Camera</Text>
                  </View>
                </AnimatedPressable>
                <AnimatedPressable
                  style={[styles.bodyScanBtn, { flex: 1, backgroundColor: tc.surfaceRaised, borderWidth: 1, borderColor: tc.border }, bodyScanLoading && { opacity: 0.55 }]}
                  onPress={() => setBodyScanPrepSource('library')}
                  disabled={bodyScanLoading}
                  scaleDown={0.96}>
                  <View style={styles.bodyScanBtnContent}>
                    <Ionicons name="images-outline" size={16} color={tc.textPrimary} />
                    <Text style={[styles.bodyScanBtnText, { color: tc.textPrimary }]}>Library</Text>
                  </View>
                </AnimatedPressable>
              </View>
              <Text style={{ fontSize: 10, color: tc.textMuted, textAlign: 'center', marginTop: 6, lineHeight: 14 }}>
                For best results: front-facing, good lighting, form-fitting clothing. Do not submit nude photos. Accuracy varies with lighting and angle.
              </Text>
            </View>
          </FadeInView>}

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
                <View style={{ flex: 1, marginRight: 12, minWidth: 0 }}>
                  <Text style={styles.bodyScanResultCategory} numberOfLines={2}>{bodyScanResult.category}</Text>
                  <Text style={styles.bodyScanResultMuscle} numberOfLines={2}>
                    Muscle mass: {bodyScanResult.muscleMass.replace('_', ' ')}
                  </Text>
                </View>
                {/* Show the integer percentage in the circle so a value
                    like 18.5% doesn't wrap or get truncated inside the
                    fixed 84pt diameter. The full-precision range still
                    appears in the "Estimated range" line below. */}
                <View style={styles.bodyScanBfCircle}>
                  <Text
                    style={styles.bodyScanBfValue}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.7}>
                    {Math.round(bodyScanResult.bodyFatPct)}%
                  </Text>
                  <Text style={styles.bodyScanBfLabel}>Body Fat</Text>
                </View>
              </View>
              <Text style={{ fontSize: 11, color: tc.textMuted, marginBottom: 6 }}>
                Estimated range: {bodyScanResult.bodyFatRange}
              </Text>
              {(bodyScanResult.confidence || bodyScanResult.photoQuality) && (
                <Text style={{ fontSize: 11, color: tc.textMuted, marginBottom: 6 }}>
                  {[
                    bodyScanResult.confidence ? `Confidence: ${String(bodyScanResult.confidence).toLowerCase()}` : null,
                    bodyScanResult.photoQuality ? `Photo: ${String(bodyScanResult.photoQuality).toLowerCase()}` : null,
                  ].filter(Boolean).join(' · ')}
                </Text>
              )}
              {bodyScanResult.needsRetake && (
                <Text style={{ fontSize: 11, color: tc.warning ?? tc.primary, marginBottom: 6, fontWeight: '700' }}>
                  Retake recommended{bodyScanResult.qualityFlags?.length ? `: ${bodyScanResult.qualityFlags[0]}` : ''}
                </Text>
              )}

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

          {isProTier && bodyScanHistory.length === 1 && (
            <View style={[styles.bodyScanHistoryCard, { marginTop: 12 }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary }}>Body Scan History</Text>
                <Text style={{ fontSize: 11, color: tc.textMuted }}>1 saved</Text>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 4 }}>
                {bodyScanHistory.map((entry, idx) => renderBodyScanHistoryTile(entry, idx))}
              </ScrollView>
            </View>
          )}

          {/* Standalone Scan Timeline + Before/After cards removed.
              The scan strip is now folded into the Body Fat Trend card
              below so the Body section reads as one consolidated card
              instead of three competing for attention. */}

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
            const areaPoints = [
              `${points[0].x},${chartH - padB}`,
              ...points.map(p => `${p.x},${p.y}`),
              `${points[points.length - 1].x},${chartH - padB}`,
            ].join(' ');

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
                    <Defs>
                      <SvgLinearGradient id="bodyFatTrendAreaGradient" x1="0" y1="0" x2="0" y2="1">
                        <Stop offset="0%" stopColor={tc.primary} stopOpacity="0.22" />
                        <Stop offset="62%" stopColor={tc.primary} stopOpacity="0.10" />
                        <Stop offset="100%" stopColor={tc.primary} stopOpacity="0.02" />
                      </SvgLinearGradient>
                    </Defs>
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
                    <Polygon points={areaPoints} fill="url(#bodyFatTrendAreaGradient)" />
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

                {/* Concise scan strip — replaces the standalone Scan
                    Timeline + Before/After cards. Photo + BF% per scan,
                    horizontally scrollable, latest highlighted. The
                    chart above already shows the trend; the strip just
                    gives users a way to see the actual photos. */}
                {bodyScanHistory.length > 0 && (
                  <View style={{ marginTop: 14 }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 6 }}>
                      SCANS · {bodyScanHistory.length} SAVED
                    </Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 4 }}>
                      {bodyScanHistory.map((entry, idx) => renderBodyScanHistoryTile(entry, idx))}
                    </ScrollView>
                  </View>
                )}

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

        </ScrollView>
        ) : null}
        </FadeInView>
        )}
      </TabDragWrapper>
      <Modal
        visible={quickDetailSheet != null}
        transparent
        animationType="fade"
        onRequestClose={() => setQuickDetailSheet(null)}>
        <View style={styles.quickDetailBackdrop}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setQuickDetailSheet(null)}
          />
          <View style={styles.quickDetailSheet}>
            <BottomSheetDismissHandle
              onClose={() => setQuickDetailSheet(null)}
              color={tc.border}
              containerStyle={styles.quickDetailHandleTap}
              handleStyle={styles.quickDetailHandle}
            />
            <View style={styles.quickDetailHeader}>
              <View style={[styles.quickDetailIcon, { backgroundColor: (quickDetailSheet === 'forecast' ? todayHeroColor : todayTrack.color) + '20' }]}>
                <Ionicons
                  name={quickDetailSheet === 'forecast' ? 'analytics-outline' : todayTrack.icon}
                  size={18}
                  color={quickDetailSheet === 'forecast' ? todayHeroColor : todayTrack.color}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.quickDetailEyebrow}>
                  {quickDetailSheet === 'forecast' ? "HOW YOU'RE DOING" : `TODAY · ${todayTrack.goalLabel.toUpperCase()}`}
                </Text>
                <Text style={styles.quickDetailTitle} numberOfLines={2}>
                  {quickDetailSheet === 'forecast' && goalScore ? 'Goal estimate' : quickDetailSheet === 'forecast' && hasGoalScoreDetail ? todayHeroTitle : todayTrack.title}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setQuickDetailSheet(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={20} color={tc.textMuted} />
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.quickDetailScroll} contentContainerStyle={{ paddingBottom: 6 }} showsVerticalScrollIndicator={false}>
              {quickDetailSheet === 'forecast' && goalScore ? (
                <>
                  <Text style={styles.quickDetailBody}>{goalScore.projectedOutcome.displayText}</Text>
                  <View style={styles.quickDetailMetricRow}>
                    <View style={styles.quickDetailMetric}>
                      <Text style={styles.quickDetailMetricLabel}>Execution</Text>
                      <Text style={[styles.quickDetailMetricValue, { color: goalScoreColor }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>{goalScore.executionScore}%</Text>
                      <Text style={styles.quickDetailMetricDetail}>{goalScore.executionLabel}</Text>
                    </View>
                    <View style={styles.quickDetailMetric}>
                      <Text style={styles.quickDetailMetricLabel}>Confidence</Text>
                      <Text style={[styles.quickDetailMetricValue, { color: goalScoreColor }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>{goalScore.projectionConfidence}%</Text>
                      <Text style={styles.quickDetailMetricDetail}>{goalScore.confidenceLabel}</Text>
                    </View>
                  </View>
                  <View style={styles.quickDetailSection}>
                    <Text style={styles.quickDetailSectionTitle}>Projected outcome</Text>
                    <Text style={styles.quickDetailBody}>
                      Expected range: {goalScore.projectedOutcome.expectedLow} to {goalScore.projectedOutcome.expectedHigh} {goalScore.projectedOutcome.unit.replace(/_/g, ' ')}
                    </Text>
                    <Text style={styles.quickDetailMuted}>Midpoint: {goalScore.projectedOutcome.expectedMidpoint} {goalScore.projectedOutcome.unit.replace(/_/g, ' ')} · response factor {goalScore.responseFactor}</Text>
                  </View>
                  {goalScore.limitingFactors.length > 0 && (
                    <View style={styles.quickDetailSection}>
                      <Text style={styles.quickDetailSectionTitle}>Main limiter</Text>
                      <Text style={styles.quickDetailBody}>{goalScore.limitingFactors[0].reason}</Text>
                      <Text style={styles.quickDetailMuted}>{goalScore.limitingFactors[0].suggestedFix}</Text>
                    </View>
                  )}
                  {goalScore.nextBestActions.length > 0 && (
                    <View style={styles.quickDetailSection}>
                      <Text style={styles.quickDetailSectionTitle}>Best next action</Text>
                      <Text style={styles.quickDetailBody}>{goalScore.nextBestActions[0].title}</Text>
                      <Text style={styles.quickDetailMuted}>{goalScore.nextBestActions[0].description}</Text>
                    </View>
                  )}
                  <View style={styles.quickDetailSection}>
                    <Text style={styles.quickDetailSectionTitle}>Detailed breakdown</Text>
                    {goalScore.executionBreakdown.map(item => (
                      <View key={item.driverId} style={styles.quickDetailRow}>
                        <Text style={styles.quickDetailRowLabel}>{item.driverName}</Text>
                        <Text style={styles.quickDetailRowValue}>{Math.round(item.score)} / 100</Text>
                        <Text style={styles.quickDetailRowDetail}>{item.actualSummary || item.targetSummary}</Text>
                      </View>
                    ))}
                  </View>
                </>
              ) : quickDetailSheet === 'forecast' && goalForecast ? (
                <>
                  <Text style={styles.quickDetailBody}>{stripGoalStartedCopy(goalForecast.subheadline)}</Text>
                  <View style={styles.quickDetailMetricRow}>
                    <View style={styles.quickDetailMetric}>
                      <Text style={styles.quickDetailMetricLabel}>{goalForecast.metricLabel}</Text>
                      <Text style={[styles.quickDetailMetricValue, { color: goalForecastColor }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>{goalForecast.metricValue}</Text>
                      <Text style={styles.quickDetailMetricDetail}>{goalForecast.metricDetail}</Text>
                    </View>
                    <View style={styles.quickDetailMetric}>
                      <Text style={styles.quickDetailMetricLabel}>Execution</Text>
                      <Text style={[styles.quickDetailMetricValue, { color: goalForecastColor }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>{goalForecast.executionPct}%</Text>
                      <Text style={styles.quickDetailMetricDetail}>{goalForecast.confidenceDetail}</Text>
                    </View>
                  </View>
                  {goalProgressBar && userProfile.goalDetails.goalStartedAt && (
                    <GoalTrajectoryChart
                      bar={goalProgressBar}
                      weightEntries={weightEntries}
                      goalStartedAt={userProfile.goalDetails.goalStartedAt}
                      weightUnit={weightUnit}
                      width={trajectoryChartWidth}
                      colors={{
                        primary: tc.primary,
                        success: tc.success ?? '#22C55E',
                        warning: tc.warning ?? '#F59E0B',
                        textPrimary: tc.textPrimary,
                        textSecondary: tc.textSecondary,
                        textMuted: tc.textMuted,
                        surface: tc.surface,
                        surfaceRaised: tc.surfaceRaised,
                        border: tc.border,
                      }}
                    />
                  )}
                  {!goalProgressBar && recompTrajectory && (
                    <RecompTrajectoryChart
                      trajectory={recompTrajectory}
                      width={trajectoryChartWidth}
                      colors={{
                        primary: tc.primary,
                        success: tc.success ?? '#22C55E',
                        warning: tc.warning ?? '#F59E0B',
                        textPrimary: tc.textPrimary,
                        textSecondary: tc.textSecondary,
                        textMuted: tc.textMuted,
                        surface: tc.surface,
                        surfaceRaised: tc.surfaceRaised,
                        border: tc.border,
                      }}
                    />
                  )}
                  {fatMassProgress && fatMassProgress.fatLostLbs != null && fatMassProgress.label && (
                    <View style={styles.quickDetailBullet}>
                      <Ionicons
                        name={fatMassProgress.fatLostLbs >= 0 ? 'trending-down' : 'trending-up'}
                        size={14}
                        color={fatMassProgress.fatLostLbs >= 0 ? (tc.success ?? '#22C55E') : tc.textMuted}
                      />
                      <Text style={styles.quickDetailBulletText}>
                        {fatMassProgress.label}
                        {fatMassProgress.leanMassDeltaLbs != null && Math.abs(fatMassProgress.leanMassDeltaLbs) >= 0.5
                          ? ` · lean ${fatMassProgress.leanMassDeltaLbs > 0 ? '+' : ''}${fatMassProgress.leanMassDeltaLbs.toFixed(1)} lb`
                          : ''}
                      </Text>
                    </View>
                  )}
                  <View style={styles.quickDetailSection}>
                    <Text style={styles.quickDetailSectionTitle}>Read</Text>
                    <Text style={styles.quickDetailBody}>{goalForecast.updateReason}</Text>
                    <Text style={styles.quickDetailMuted}>{goalForecast.assumption}</Text>
                  </View>
                  {goalForecast.horizonProjection && (
                    <View style={styles.quickDetailSection}>
                      <Text style={styles.quickDetailSectionTitle}>Six-week projection</Text>
                      <Text style={styles.quickDetailBody}>{goalForecast.horizonProjection.label}</Text>
                    </View>
                  )}
                  <View style={styles.quickDetailSection}>
                    <Text style={styles.quickDetailSectionTitle}>Signals</Text>
                    {goalForecast.stats.map(stat => (
                      <View key={stat.label} style={styles.quickDetailRow}>
                        <Text style={styles.quickDetailRowLabel}>{stat.label}</Text>
                        <Text style={styles.quickDetailRowValue}>{stat.value}</Text>
                        <Text style={styles.quickDetailRowDetail}>{stat.detail}</Text>
                      </View>
                    ))}
                  </View>
                  {(goalForecast.drivers.length > 0 || goalForecast.limiters.length > 0) && (
                    <View style={styles.quickDetailSection}>
                      <Text style={styles.quickDetailSectionTitle}>Adjustments</Text>
                      {goalForecast.drivers.slice(0, 2).map(item => (
                        <View key={`driver-${item}`} style={styles.quickDetailBullet}>
                          <Ionicons name="arrow-up-circle" size={14} color={tc.success ?? '#22C55E'} />
                          <Text style={styles.quickDetailBulletText}>{item}</Text>
                        </View>
                      ))}
                      {goalForecast.limiters.slice(0, Math.max(0, 4 - Math.min(2, goalForecast.drivers.length))).map(item => (
                        <View key={`limiter-${item}`} style={styles.quickDetailBullet}>
                          <Ionicons name="alert-circle-outline" size={14} color={tc.warning ?? '#F59E0B'} />
                          <Text style={styles.quickDetailBulletText}>{item}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                </>
              ) : (
                <>
                  <Text style={styles.quickDetailBody}>{todayTrack.subtitle}</Text>
                  <View style={styles.quickDetailMetricRow}>
                    <View style={styles.quickDetailMetric}>
                      <Text style={styles.quickDetailMetricLabel}>Goal signal</Text>
                      <Text style={[styles.quickDetailMetricValue, { color: todayTrack.color }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>{todayTrack.progressPct}%</Text>
                      <Text style={styles.quickDetailMetricDetail}>{todayTrack.confidence}</Text>
                    </View>
                    <View style={styles.quickDetailMetric}>
                      <Text style={styles.quickDetailMetricLabel}>Window</Text>
                      <Text style={[styles.quickDetailMetricValue, { color: todayTrack.color }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>{progressWeekWindow.label}</Text>
                      <Text style={styles.quickDetailMetricDetail}>{progressWeekWindow.source === 'plan_week' ? 'PlanWeek' : 'calendar week'}</Text>
                    </View>
                  </View>
                  <View style={styles.quickDetailSection}>
                    <Text style={styles.quickDetailSectionTitle}>Next action</Text>
                    <Text style={styles.quickDetailBody}>{todayTrack.action}</Text>
                  </View>
                  <View style={styles.quickDetailSection}>
                    <Text style={styles.quickDetailSectionTitle}>Signals</Text>
                    {todayTrack.signals.map(signal => (
                      <View key={signal.key} style={styles.quickDetailRow}>
                        <Text style={styles.quickDetailRowLabel}>{signal.label}</Text>
                        <Text style={[styles.quickDetailRowValue, { color: signal.color }]}>{signal.value}</Text>
                        <Text style={styles.quickDetailRowDetail}>{signal.detail}</Text>
                      </View>
                    ))}
                  </View>
                </>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
      {/* Sleep Score explainer — same quickDetailSheet pattern as the
          Thallo Score modal above. Triggered from the info icon in
          the card header. */}
      <Modal
        visible={sleepScoreExplainOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setSleepScoreExplainOpen(false)}>
        <View style={styles.quickDetailBackdrop}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setSleepScoreExplainOpen(false)}
          />
          <View style={styles.quickDetailSheet}>
            <BottomSheetDismissHandle
              onClose={() => setSleepScoreExplainOpen(false)}
              color={tc.border}
              containerStyle={styles.quickDetailHandleTap}
              handleStyle={styles.quickDetailHandle}
            />
            <View style={styles.quickDetailHeader}>
              <View style={[styles.quickDetailIcon, { backgroundColor: '#818CF822' }]}>
                <Ionicons name="moon-outline" size={18} color="#818CF8" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.quickDetailEyebrow}>SLEEP SCORE</Text>
                <Text style={styles.quickDetailTitle} numberOfLines={2}>How it's calculated</Text>
              </View>
              <TouchableOpacity onPress={() => setSleepScoreExplainOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={20} color={tc.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.quickDetailScroll} contentContainerStyle={{ paddingBottom: 6 }} showsVerticalScrollIndicator={false}>
              <Text style={styles.quickDetailBody}>
                A 0-100 read of last night. Duration and efficiency carry
                the most weight; deep / REM, wake time, HRV, RHR, SpO2,
                and respiratory rate refine the read when your wearable
                records them.
              </Text>

              <View style={styles.quickDetailSection}>
                <Text style={styles.quickDetailSectionTitle}>What goes in</Text>
                <View style={styles.quickDetailRow}>
                  <Text style={styles.quickDetailRowLabel}>Duration</Text>
                  <Text style={styles.quickDetailRowValue}>7-9h target window</Text>
                </View>
                <View style={styles.quickDetailRow}>
                  <Text style={styles.quickDetailRowLabel}>Efficiency</Text>
                  <Text style={styles.quickDetailRowValue}>asleep ÷ time in bed</Text>
                </View>
                <View style={styles.quickDetailRow}>
                  <Text style={styles.quickDetailRowLabel}>Stages</Text>
                  <Text style={styles.quickDetailRowValue}>deep and REM, lightly weighted</Text>
                </View>
                <View style={styles.quickDetailRow}>
                  <Text style={styles.quickDetailRowLabel}>Wake-ups</Text>
                  <Text style={styles.quickDetailRowValue}>awake time after sleep onset</Text>
                </View>
                <View style={styles.quickDetailRow}>
                  <Text style={styles.quickDetailRowLabel}>Regularity</Text>
                  <Text style={styles.quickDetailRowValue}>bedtime / wake-time consistency</Text>
                </View>
                <View style={styles.quickDetailRow}>
                  <Text style={styles.quickDetailRowLabel}>Vitals</Text>
                  <Text style={styles.quickDetailRowValue}>HRV · RHR · SpO₂ · respiratory rate</Text>
                </View>
              </View>

              <View style={styles.quickDetailSection}>
                <Text style={styles.quickDetailSectionTitle}>Personalized vs calibrating</Text>
                <Text style={[styles.quickDetailBody, { color: tc.textSecondary }]}>
                  The first 14 nights use a generic baseline. After that,
                  Thallo compares HRV, resting heart rate, and regularity
                  against your own recent sleep pattern.
                </Text>
              </View>

              <View style={styles.quickDetailSection}>
                <Text style={styles.quickDetailSectionTitle}>Rating bands</Text>
                <View style={styles.quickDetailRow}>
                  <Text style={styles.quickDetailRowLabel}>80+</Text>
                  <Text style={[styles.quickDetailRowValue, { color: tc.success }]}>Great recovery night</Text>
                </View>
                <View style={styles.quickDetailRow}>
                  <Text style={styles.quickDetailRowLabel}>60–79</Text>
                  <Text style={[styles.quickDetailRowValue, { color: tc.warning }]}>Decent — room to improve</Text>
                </View>
                <View style={styles.quickDetailRow}>
                  <Text style={styles.quickDetailRowLabel}>Below 60</Text>
                  <Text style={[styles.quickDetailRowValue, { color: tc.error }]}>Short / fragmented</Text>
                </View>
              </View>

              <Text style={[styles.quickDetailMuted, { marginTop: 4 }]}>
                Sleep data comes from your wearable / phone via the
                health platform. Missing nights show as "Unavailable"
                and don't lower future scores.
              </Text>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <EditTrendsSheet
        visible={editTrendsOpen}
        hidden={trendsHidden}
        onSetVisible={setTrendsSectionVisible}
        onShowAll={showAllTrends}
        onHideAll={hideAllTrends}
        onClose={() => setEditTrendsOpen(false)}
        tc={tc}
      />
      <EditTrendsSheet
        visible={editHighValueTrendsOpen}
        hidden={hiddenHighValueTrendCards}
        onSetVisible={setHighValueTrendCardVisible}
        onShowAll={showAllHighValueTrendCards}
        onClose={() => setEditHighValueTrendsOpen(false)}
        tc={tc}
        sections={highValueTrendEditSections}
        title="Edit High-Value Trends"
        testPrefix="edit-high-value-trends"
        countLabel="cards"
      />
      <EditTrendsSheet
        visible={editActivityHighlightsOpen}
        hidden={hiddenActivityHighlightCards}
        onSetVisible={setActivityHighlightCardVisible}
        onShowAll={showAllActivityHighlightCards}
        onClose={() => setEditActivityHighlightsOpen(false)}
        tc={tc}
        sections={activityHighlightEditSections}
        title="Edit Activity Highlights"
        testPrefix="edit-activity-highlights"
        countLabel="cards"
      />
      <EditTrendsSheet
        visible={editHealthOpen}
        hidden={healthHidden}
        onSetVisible={setHealthSectionVisible}
        onShowAll={showAllHealth}
        onClose={() => setEditHealthOpen(false)}
        tc={tc}
        sections={HEALTH_SECTIONS}
        title="Edit Health"
        testPrefix="edit-health"
      />

      {/* Relative Strength Profile detail - per-muscle strength against
          bodyweight-relative target ranges. */}
      <Modal
        visible={strengthRadarDetailOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setStrengthRadarDetailOpen(false)}>
        <View style={styles.quickDetailBackdrop}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setStrengthRadarDetailOpen(false)}
          />
          <View style={styles.quickDetailSheet}>
            <BottomSheetDismissHandle
              onClose={() => setStrengthRadarDetailOpen(false)}
              color={tc.border}
              containerStyle={styles.quickDetailHandleTap}
              handleStyle={styles.quickDetailHandle}
            />
            <View style={styles.quickDetailHeader}>
              <View style={[styles.quickDetailIcon, { backgroundColor: strengthRadarColor + '20' }]}>
                <Ionicons name="barbell-outline" size={18} color={strengthRadarColor} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.quickDetailEyebrow}>RELATIVE STRENGTH</Text>
                <Text style={styles.quickDetailTitle} numberOfLines={2}>
                  {strengthRadarScore == null ? 'Building muscle profile' : `${radarScoreLabel(strengthRadarScore)} · ${strengthRadarScore}/100`}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setStrengthRadarDetailOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={20} color={tc.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.quickDetailScroll} contentContainerStyle={{ paddingBottom: 6 }} showsVerticalScrollIndicator={false}>
              <Text style={styles.quickDetailBody}>
                This uses your best loaded strength estimate from the last 30 days for each muscle, divided by bodyweight, then compares it with a practical target for that muscle. Set-target volume still lives in Performance gauges.
              </Text>
              <View style={styles.quickDetailMetricRow}>
                <View style={styles.quickDetailMetric}>
                  <Text style={styles.quickDetailMetricLabel}>Score</Text>
                  <Text style={[styles.quickDetailMetricValue, { color: strengthRadarColor }]}>{strengthRadarScore == null ? '--' : strengthRadarScore}</Text>
                  <Text style={styles.quickDetailMetricDetail}>average of filled axes</Text>
                </View>
                <View style={styles.quickDetailMetric}>
                  <Text style={styles.quickDetailMetricLabel}>Bodyweight</Text>
                  <Text style={[styles.quickDetailMetricValue, { color: strengthRadarColor }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
                    {strengthScoreWeightLbs ? formatWeight(strengthScoreWeightLbs, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 }) : '--'}
                  </Text>
                  <Text style={styles.quickDetailMetricDetail}>comparison base</Text>
                </View>
              </View>
              <View style={styles.quickDetailSection}>
                <Text style={styles.quickDetailSectionTitle}>Muscle axes</Text>
                {strengthRadarMetrics.map(metric => {
                  const score = clampRadarScore(metric.value);
                  const color = score == null ? tc.textMuted : radarScoreColor(score, tc);
                  return (
                    <View key={metric.key} style={{ marginBottom: 12 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <Text style={{ flex: 1, fontSize: 13, fontWeight: '800', color: tc.textPrimary }} numberOfLines={1}>
                          {metric.label}
                        </Text>
                        <Text style={{ fontSize: 13, fontWeight: '900', color, fontVariant: ['tabular-nums'] as any }}>
                          {score == null ? '--' : score}
                        </Text>
                      </View>
                      <View style={{ height: 6, borderRadius: 3, backgroundColor: tc.border, overflow: 'hidden' }}>
                        <View style={{ width: `${score == null ? 0 : Math.max(4, score)}%` as any, height: 6, backgroundColor: color }} />
                      </View>
                      <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 4 }}>
                        {metric.rawValue ?? '--'} bodyweight · {metric.detail}{metric.targetLabel ? ` · ${metric.targetLabel}` : ''}
                      </Text>
                      <Text style={{ fontSize: 11, color: tc.textSecondary, marginTop: 2 }}>
                        {metric.reason}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Cardio Fitness Profile detail - unpack the Trends card
          into capability axes plus source/context signals. */}
      <Modal
        visible={cardioScoreDetailOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setCardioScoreDetailOpen(false)}>
        <View style={styles.quickDetailBackdrop}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setCardioScoreDetailOpen(false)}
          />
          <View style={styles.quickDetailSheet}>
            <BottomSheetDismissHandle
              onClose={() => setCardioScoreDetailOpen(false)}
              color={tc.border}
              containerStyle={styles.quickDetailHandleTap}
              handleStyle={styles.quickDetailHandle}
            />
            <View style={styles.quickDetailHeader}>
              <View style={[styles.quickDetailIcon, { backgroundColor: cardioBalanceColor + '20' }]}>
                <Ionicons name="pulse-outline" size={18} color={cardioBalanceColor} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.quickDetailEyebrow}>CARDIO FITNESS PROFILE</Text>
                <Text style={styles.quickDetailTitle} numberOfLines={2}>
                  {cardioBalanceScore == null ? 'Building cardio data' : `${radarScoreLabel(cardioBalanceScore)} · ${cardioBalanceScore}/100`}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setCardioScoreDetailOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={20} color={tc.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.quickDetailScroll} contentContainerStyle={{ paddingBottom: 6 }} showsVerticalScrollIndicator={false}>
              <Text style={styles.quickDetailBody}>
                This profile looks at aerobic base, endurance, speed,
                intensity, efficiency, and consistency over the last 30 days.
                Session-count-only data stays conservative until HR, pace,
                duration, or VO2 fills in the picture.
              </Text>
              <View style={styles.quickDetailMetricRow}>
                <View style={styles.quickDetailMetric}>
                  <Text style={styles.quickDetailMetricLabel}>Score</Text>
                  <Text style={[styles.quickDetailMetricValue, { color: cardioBalanceColor }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
                    {cardioBalanceScore == null ? '--' : cardioBalanceScore}
                  </Text>
                  <Text style={styles.quickDetailMetricDetail}>profile average</Text>
                </View>
                <View style={styles.quickDetailMetric}>
                  <Text style={styles.quickDetailMetricLabel}>Sessions</Text>
                  <Text style={[styles.quickDetailMetricValue, { color: cardioBalanceColor }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
                    {cardioTrendSummary.cardioSessions7d}
                  </Text>
                  <Text style={styles.quickDetailMetricDetail}>last 7 days</Text>
                </View>
              </View>
              <View style={styles.quickDetailMetricRow}>
                <View style={styles.quickDetailMetric}>
                  <Text style={styles.quickDetailMetricLabel}>Strongest area</Text>
                  <Text style={[styles.quickDetailMetricValue, { color: cardioBalanceColor }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
                    {cardioRadarInsight.enoughData && cardioRadarInsight.strongest ? cardioRadarInsight.strongest.label : 'More data'}
                  </Text>
                  <Text style={styles.quickDetailMetricDetail}>
                    {cardioRadarInsight.enoughData && cardioRadarInsight.strongest ? cardioRadarInsight.strongest.reason : 'add HR, pace, or duration'}
                  </Text>
                </View>
                <View style={styles.quickDetailMetric}>
                  <Text style={styles.quickDetailMetricLabel}>Focus area</Text>
                  <Text style={[styles.quickDetailMetricValue, { color: cardioBalanceColor }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
                    {cardioRadarInsight.enoughData && cardioRadarInsight.focus ? cardioRadarInsight.focus.label : 'Not enough data'}
                  </Text>
                  <Text style={styles.quickDetailMetricDetail}>
                    {cardioRadarInsight.enoughData && cardioRadarInsight.focus ? cardioRadarInsight.focus.reason : 'session count alone is capped'}
                  </Text>
                </View>
              </View>
              <View style={styles.quickDetailSection}>
                <Text style={styles.quickDetailSectionTitle}>Axes</Text>
                {cardioRadarMetrics.map(metric => {
                  const metricScore = clampRadarScore(metric.value);
                  return (
                    <View key={metric.key} style={styles.quickDetailRow}>
                      <Text style={styles.quickDetailRowLabel}>{metric.label}</Text>
                      <Text style={[styles.quickDetailRowValue, { color: cardioBalanceColor }]}>{metricScore == null ? '--' : metricScore}</Text>
                      <Text style={styles.quickDetailRowDetail}>
                        {metric.rawValue != null && metric.rawValue !== '--' ? `${metric.rawValue} · ` : ''}{metric.reason ?? metric.detail}
                      </Text>
                    </View>
                  );
                })}
              </View>
              <View style={styles.quickDetailSection}>
                <Text style={styles.quickDetailSectionTitle}>Data quality</Text>
                <Text style={styles.quickDetailBody}>{cardioBalanceDetail}</Text>
              </View>
              {cardioActivityMix.length > 0 && (
                <View style={styles.quickDetailSection}>
                  <Text style={styles.quickDetailSectionTitle}>Activity mix</Text>
                  {cardioActivityMix.map(item => (
                    <View key={item.key} style={styles.quickDetailRow}>
                      <Text style={styles.quickDetailRowLabel}>{item.label}</Text>
                      <Text style={[styles.quickDetailRowValue, { color: cardioBalanceColor }]}>{item.count}</Text>
                      <Text style={styles.quickDetailRowDetail}>session{item.count === 1 ? '' : 's'} in the last 30 days</Text>
                    </View>
                  ))}
                </View>
              )}
              <View style={styles.quickDetailSection}>
                <Text style={styles.quickDetailSectionTitle}>Detailed signals</Text>
                {cardioScoreDrivers.length > 0 ? cardioScoreDrivers.map(item => (
                  <View key={item.label} style={styles.quickDetailRow}>
                    <Text style={styles.quickDetailRowLabel}>{item.label}</Text>
                    <Text style={[styles.quickDetailRowValue, { color: cardioBalanceColor }]}>{item.value}</Text>
                    <Text style={styles.quickDetailRowDetail}>{item.detail}</Text>
                  </View>
                )) : (
                  <Text style={styles.quickDetailMuted}>
                    Log cardio distance, pace, duration, or use a wearable during workouts to add drivers here.
                  </Text>
                )}
              </View>
              <View style={styles.quickDetailSection}>
                <Text style={styles.quickDetailSectionTitle}>How to improve</Text>
                <View style={styles.quickDetailBullet}>
                  <Ionicons name="walk-outline" size={14} color={cardioBalanceColor} />
                  <Text style={styles.quickDetailBulletText}>Add one easy Zone 2 session to strengthen aerobic base.</Text>
                </View>
                <View style={styles.quickDetailBullet}>
                  <Ionicons name="calendar-outline" size={14} color={cardioBalanceColor} />
                  <Text style={styles.quickDetailBulletText}>Spread cardio across 2-3 sessions so consistency is visible.</Text>
                </View>
                <View style={styles.quickDetailBullet}>
                  <Ionicons name="speedometer-outline" size={14} color={cardioBalanceColor} />
                  <Text style={styles.quickDetailBulletText}>Keep hard sessions balanced with easy work, then repeat comparable routes to reveal speed and efficiency.</Text>
                </View>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Strength Score detail — bottom sheet showing per-lift 1RM,
          bodyweight ratio, and target ratio so users can see exactly
          what feeds the score. Triggered from the tile on the Trends
          tab. */}
      <Modal
        visible={strengthScoreDetailOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setStrengthScoreDetailOpen(false)}>
        <View style={styles.quickDetailBackdrop}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setStrengthScoreDetailOpen(false)}
          />
          <View style={styles.quickDetailSheet}>
            {(() => {
              // Same bodyweight resolution as the tile — prefer most
              // recent logged entry, fall back to profile snapshot.
              const latestLoggedWeight = weightEntries.length > 0
                ? weightEntries[weightEntries.length - 1]?.weightLbs
                : null;
              const detailWeightLbs = (Number.isFinite(latestLoggedWeight) && (latestLoggedWeight ?? 0) > 0
                ? latestLoggedWeight
                : null)
                ?? userProfile.physicalStats?.weightLbs
                ?? null;
              const detail = computeStrengthScore({
                bulkE1RMMap,
                showcase: oneRepMaxLifts,
                bodyweightLbs: detailWeightLbs,
              });
              const headerColor =
                detail.band === 'elite' ? '#22C55E'
                : detail.band === 'advanced' ? '#84CC16'
                : detail.band === 'intermediate' ? tc.primary
                : detail.band === 'developing' ? '#F59E0B'
                : detail.band === 'novice' ? tc.textMuted
                : tc.textMuted;
              return (
                <>
                  <BottomSheetDismissHandle
                    onClose={() => setStrengthScoreDetailOpen(false)}
                    color={tc.border}
                    containerStyle={styles.quickDetailHandleTap}
                    handleStyle={styles.quickDetailHandle}
                  />
                  <View style={styles.quickDetailHeader}>
                    <View style={[styles.quickDetailIcon, { backgroundColor: headerColor + '20' }]}>
                      <Ionicons name="barbell-outline" size={18} color={headerColor} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.quickDetailEyebrow}>STRENGTH SCORE</Text>
                      <Text style={styles.quickDetailTitle} numberOfLines={2}>
                        {detail.band === 'unknown'
                          ? 'Not enough data yet'
                          : `${strengthBandLabel(detail.band)} · ${detail.score}/100`}
                      </Text>
                      {detail.band !== 'unknown' && (
                        <Text style={[styles.quickDetailEyebrow, { marginTop: 2, color: tc.textMuted }]} numberOfLines={1}>
                          {detail.loggedLiftCount}/{detail.totalLiftCount} lifts · {strengthConfidenceLabel(detail.confidence).toLowerCase()} confidence
                        </Text>
                      )}
                    </View>
                    <TouchableOpacity onPress={() => setStrengthScoreDetailOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                      <Ionicons name="close" size={20} color={tc.textMuted} />
                    </TouchableOpacity>
                  </View>
                  <ScrollView style={styles.quickDetailScroll} contentContainerStyle={{ paddingBottom: 6 }} showsVerticalScrollIndicator={false}>
                    <Text style={styles.quickDetailBody}>
                      {detail.band === 'unknown'
                        ? (detailWeightLbs && detailWeightLbs > 0
                          ? 'Log a few key compound lifts (squat, bench, deadlift, OHP, row) and your score will appear here.'
                          : 'Set your bodyweight in Settings — strength is scored relative to it.')
                        : `Your score averages the best logged lift in each movement pattern: squat, hinge, horizontal push, vertical push, horizontal pull, and vertical pull. Each lift compares estimated 1RM to bodyweight. Missing patterns lower confidence, not the score.`}
                    </Text>
                    {detail.rows.length > 0 && (
                      <View style={styles.quickDetailSection}>
                        <Text style={styles.quickDetailSectionTitle}>Your lifts</Text>
                        {detail.rows.map(row => {
                          const rowColor =
                            row.band === 'elite' ? '#22C55E'
                            : row.band === 'advanced' ? '#84CC16'
                            : row.band === 'intermediate' ? tc.primary
                            : row.band === 'developing' ? '#F59E0B'
                            : tc.textMuted;
                          return (
                            <View key={row.key} style={{ marginBottom: 14 }}>
                              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                                <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary, flex: 1 }} numberOfLines={1}>{row.display}</Text>
                                <Text style={{ fontSize: 16, fontWeight: '900', color: rowColor, fontVariant: ['tabular-nums'] as any }}>{row.score}</Text>
                              </View>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                <View style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: tc.border, overflow: 'hidden' }}>
                                  <View style={{ width: `${Math.min(100, row.score)}%`, height: 5, borderRadius: 3, backgroundColor: rowColor }} />
                                </View>
                              </View>
                              <Text style={{ fontSize: 11, color: tc.textMuted }}>
                                {formatWeight(row.oneRepMaxLbs, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 })} estimated 1RM · {row.ratio}× bodyweight (target {row.targetRatio}×)
                              </Text>
                            </View>
                          );
                        })}
                      </View>
                    )}
                    {detail.missing.length > 0 && (
                      <View style={styles.quickDetailSection}>
                        <Text style={styles.quickDetailSectionTitle}>Lifts not yet logged</Text>
                        <Text style={styles.quickDetailMuted}>
                          Adding these improves coverage and may fill a missing movement pattern:
                        </Text>
                        {detail.missing.map(m => (
                          <View key={m.key} style={[styles.quickDetailRow, { paddingVertical: 4 }]}>
                            <Text style={styles.quickDetailRowLabel}>{m.display}</Text>
                            <Ionicons name="add-circle-outline" size={14} color={tc.textMuted} />
                          </View>
                        ))}
                      </View>
                    )}
                    <View style={styles.quickDetailSection}>
                      <Text style={styles.quickDetailSectionTitle}>Bands</Text>
                      <View style={styles.quickDetailRow}>
                        <Text style={styles.quickDetailRowLabel}>Elite</Text>
                        <Text style={[styles.quickDetailRowValue, { color: '#22C55E' }]}>95-100</Text>
                      </View>
                      <View style={styles.quickDetailRow}>
                        <Text style={styles.quickDetailRowLabel}>Advanced</Text>
                        <Text style={[styles.quickDetailRowValue, { color: '#84CC16' }]}>80-94</Text>
                      </View>
                      <View style={styles.quickDetailRow}>
                        <Text style={styles.quickDetailRowLabel}>Intermediate</Text>
                        <Text style={[styles.quickDetailRowValue, { color: tc.primary }]}>60-79</Text>
                      </View>
                      <View style={styles.quickDetailRow}>
                        <Text style={styles.quickDetailRowLabel}>Developing</Text>
                        <Text style={[styles.quickDetailRowValue, { color: '#F59E0B' }]}>40-59</Text>
                      </View>
                      <View style={styles.quickDetailRow}>
                        <Text style={styles.quickDetailRowLabel}>Novice</Text>
                        <Text style={[styles.quickDetailRowValue, { color: tc.textMuted }]}>Under 40</Text>
                      </View>
                    </View>
                  </ScrollView>
                </>
              );
            })()}
          </View>
        </View>
      </Modal>
      {/* Strength trend detail — per-exercise e1RM deltas over the last
          8 weeks vs each lift's own prior logged session, so sparse
          weekly programming still gets a fair read. Triggered from the
          Strength row on the Trends tab. */}
      <Modal
        visible={strengthTrendDetailOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setStrengthTrendDetailOpen(false)}>
        <View style={styles.quickDetailBackdrop}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setStrengthTrendDetailOpen(false)}
          />
          <View style={styles.quickDetailSheet}>
            {(() => {
              const summary = buildStrengthTrendSummary(history, {
                estimateSet: estimate1RM,
                categorizeExercise,
              });
              const rows = summary?.rows ?? [];
              const gains = rows.filter(r => r.deltaLbs != null && r.deltaLbs > 0.5);
              const drops = rows.filter(r => r.deltaLbs != null && r.deltaLbs < -0.5);
              const flat = rows.filter(r => r.deltaLbs != null && Math.abs(r.deltaLbs) <= 0.5);
              const fresh = rows.filter(r => r.deltaLbs == null);
              const reviewWeeks = Math.round((summary?.reviewDays ?? 56) / 7);
              const muscleSet = new Set(
                rows.map(r => r.primaryMuscle).filter((v): v is string => !!v),
              );
              const expectedMuscles = ['chest', 'back', 'shoulders', 'quads', 'hamstrings', 'glutes'];
              const untouched = expectedMuscles.filter(m => !muscleSet.has(m));
              const renderRow = (r: StrengthChangeRow) => {
                const positive = (r.deltaLbs ?? 0) > 0;
                const color = r.deltaLbs == null
                  ? tc.textMuted
                  : positive ? '#22C55E'
                  : r.deltaLbs < -0.5 ? '#EF4444'
                  : tc.textMuted;
                const sign = (r.deltaLbs ?? 0) > 0 ? '+' : '';
                return (
                  <View key={r.name} style={{ marginBottom: 10 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                      <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary, flex: 1 }} numberOfLines={1}>{r.name}</Text>
                      <Text style={{ fontSize: 14, fontWeight: '800', color, fontVariant: ['tabular-nums'] as any }}>
                        {r.deltaLbs == null ? 'new' : `${sign}${formatWeight(Math.abs(r.deltaLbs), weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 })}`}
                      </Text>
                    </View>
                    <Text style={{ fontSize: 11, color: tc.textMuted }}>
                      {r.primaryMuscle ? `${r.primaryMuscle} · ` : ''}
                      {r.priorE1RM != null
                        ? `${formatWeight(r.priorE1RM, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 })} → ${formatWeight(r.currentE1RM, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 })} est. 1RM${r.deltaPct != null ? ` (${r.deltaPct > 0 ? '+' : ''}${r.deltaPct}%)` : ''}`
                        : `${formatWeight(r.currentE1RM, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 })} est. 1RM · no prior matched session`}
                    </Text>
                  </View>
                );
              };
              return (
                <>
                  <BottomSheetDismissHandle
                    onClose={() => setStrengthTrendDetailOpen(false)}
                    color={tc.border}
                    containerStyle={styles.quickDetailHandleTap}
                    handleStyle={styles.quickDetailHandle}
                  />
                  <View style={styles.quickDetailHeader}>
                    <View style={[styles.quickDetailIcon, { backgroundColor: tc.primary + '20' }]}>
                      <Ionicons name="barbell-outline" size={18} color={tc.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.quickDetailEyebrow}>STRENGTH TREND</Text>
                      <Text style={styles.quickDetailTitle} numberOfLines={2}>
                        Last {reviewWeeks} weeks vs prior sessions
                      </Text>
                    </View>
                    <TouchableOpacity onPress={() => setStrengthTrendDetailOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                      <Ionicons name="close" size={20} color={tc.textMuted} />
                    </TouchableOpacity>
                  </View>
                  <ScrollView style={styles.quickDetailScroll} contentContainerStyle={{ paddingBottom: 6 }} showsVerticalScrollIndicator={false}>
                    <Text style={styles.quickDetailBody}>
                      Estimated 1RM per compound lift, comparing your
                      latest logged session in the last {reviewWeeks} weeks
                      against that lift's previous logged session. The
                      headline needs multiple matched lifts before it calls
                      overall strength up or down.
                    </Text>
                    {rows.length === 0 ? (
                      <View style={styles.quickDetailSection}>
                        <Text style={styles.quickDetailMuted}>
                          No loaded compound sets in the last {reviewWeeks} weeks
                          yet. Log a working set and the breakdown will
                          appear here.
                        </Text>
                      </View>
                    ) : (
                      <>
                        {gains.length > 0 && (
                          <View style={styles.quickDetailSection}>
                            <Text style={styles.quickDetailSectionTitle}>Improved</Text>
                            {gains.map(renderRow)}
                          </View>
                        )}
                        {drops.length > 0 && (
                          <View style={styles.quickDetailSection}>
                            <Text style={styles.quickDetailSectionTitle}>Down vs prior session</Text>
                            {drops.map(renderRow)}
                          </View>
                        )}
                        {flat.length > 0 && (
                          <View style={styles.quickDetailSection}>
                            <Text style={styles.quickDetailSectionTitle}>Held steady</Text>
                            {flat.map(renderRow)}
                          </View>
                        )}
                        {fresh.length > 0 && (
                          <View style={styles.quickDetailSection}>
                            <Text style={styles.quickDetailSectionTitle}>New baselines</Text>
                            <Text style={styles.quickDetailMuted}>
                              No prior session for the same lift inside the
                              lookback, so these set baselines without
                              moving the overall trend.
                            </Text>
                            {fresh.map(renderRow)}
                          </View>
                        )}
                        {untouched.length > 0 && (
                          <View style={styles.quickDetailSection}>
                            <Text style={styles.quickDetailSectionTitle}>No recent compound work</Text>
                            <Text style={styles.quickDetailMuted}>
                              {untouched.map(m => m[0].toUpperCase() + m.slice(1)).join(' · ')}
                            </Text>
                          </View>
                        )}
                      </>
                    )}
                  </ScrollView>
                </>
              );
            })()}
          </View>
        </View>
      </Modal>
      {/* Strength volume details. Set targets answers "which muscles are
          sets land?"; Workload answers "how much loaded lifting was done?" */}
      <Modal
        visible={volumeDetailMode != null}
        transparent
        animationType="fade"
        onRequestClose={() => setVolumeDetailMode(null)}>
        <View style={styles.quickDetailBackdrop}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setVolumeDetailMode(null)}
          />
          <View style={styles.quickDetailSheet}>
            {(() => {
              const vb = buildVolumeTrendBreakdown(history, progressWeekWindow.startDate);
              const loadBalance = vb.loadBalance;
              const tonnage = vb.tonnage;
              const mode = volumeDetailMode ?? 'balance';
              const isWorkload = mode === 'workload';
              const balanceColor = strengthLoadBalanceColor(loadBalance.status, loadBalance.score);
              const workloadColor = '#6366F1';
              const headerColor = isWorkload ? workloadColor : balanceColor;
              const overTargetMuscles = [...loadBalance.spikeMuscles, ...loadBalance.highMuscles];
              const peakVolume = Math.max(1, ...tonnage.weeks.map(row => row.volumeLbs));
              const priorVolume = tonnage.previous?.volumeLbs ?? 0;
              const fixedWeekComparison = tonnage.bucketMode === 'fixed_week';
              const currentWeekCopy = fixedWeekComparison
                ? (tonnage.elapsedDays >= tonnage.windowDays ? 'this week' : `this week through day ${tonnage.elapsedDays}`)
                : `the last ${tonnage.windowDays} days`;
              const priorCopy = fixedWeekComparison ? 'last week at this time' : 'the prior window';
              const vsPrior = tonnage.deltaPct != null
                ? `${tonnage.deltaPct >= 0 ? '+' : ''}${tonnage.deltaPct}%`
                : tonnage.deltaLbs != null
                  ? formatSignedLoadVolume(tonnage.deltaLbs, weightUnit)
                  : '--';
              const workloadRead = (() => {
                if (tonnage.current.loadedSets === 0) return 'No loaded strength sets in this window yet.';
                if (!tonnage.previous || tonnage.previous.loadedSets === 0) return 'This is your current workload baseline.';
                if (tonnage.deltaPct != null) {
                  if (Math.abs(tonnage.deltaPct) <= 10) return `Workload is steady versus ${priorCopy}.`;
                  return tonnage.deltaPct > 0
                    ? `Workload is ahead of ${priorCopy}. Useful if recovery is good; hold steady if joints or soreness are climbing too.`
                    : `Workload is behind ${priorCopy}. That may be recovery, missed sessions, or a lighter training block.`;
                }
                if (tonnage.comparison === 'insufficient_previous') return `${priorCopy[0].toUpperCase()}${priorCopy.slice(1)} was too sparse for a useful percent, so use the raw load and set count.`;
                if (tonnage.comparison === 'absolute' && tonnage.deltaLbs != null) return 'The change was large enough that raw load is clearer than a percent.';
                return 'No prior workload to compare yet.';
              })();
              const renderMetric = (label: string, value: string, detail: string, color = headerColor) => (
                <View style={styles.quickDetailMetric}>
                  <Text style={styles.quickDetailMetricLabel}>{label}</Text>
                  <Text style={[styles.quickDetailMetricValue, { color }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
                    {value}
                  </Text>
                  <Text style={styles.quickDetailMetricDetail}>{detail}</Text>
                </View>
              );
              const renderWorkloadWeekRow = (r: VolumeTrendRow, index: number) => {
                const pct = r.volumeLbs > 0 ? Math.max(4, Math.min(100, (r.volumeLbs / peakVolume) * 100)) : 0;
                const isCurrent = index === 0;
                const currentLabel = r.endDate === shiftDateKey(r.startDate, tonnage.windowDays - 1)
                  ? 'Current'
                  : `Current through ${formatShortDateKey(r.endDate)}`;
                return (
                  <View key={`${r.startDate}-${r.endDate}`} style={{ marginBottom: 12 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <Text style={{ fontSize: 13, fontWeight: isCurrent ? '900' : '700', color: tc.textPrimary, flex: 1 }} numberOfLines={1}>
                        {isCurrent ? currentLabel : `${formatShortDateKey(r.startDate)}-${formatShortDateKey(r.endDate)}`}
                      </Text>
                      <Text style={{ fontSize: 13, fontWeight: '900', color: isCurrent ? workloadColor : tc.textPrimary, fontVariant: ['tabular-nums'] as any }}>
                        {formatLoadVolume(r.volumeLbs, weightUnit)}
                      </Text>
                    </View>
                    <View style={{ height: 7, borderRadius: 4, backgroundColor: tc.border, overflow: 'hidden' }}>
                      <View style={{ width: `${pct}%` as any, height: 7, backgroundColor: isCurrent ? workloadColor : tc.textMuted }} />
                    </View>
                    <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 4 }}>
                      {formatLoadedSetCount(r.loadedSets)} · {r.sessionCount} strength session{r.sessionCount === 1 ? '' : 's'} · {formatAverageLoadPerSet(r, weightUnit)}
                    </Text>
                  </View>
                );
              };
              const renderMuscleRow = (r: StrengthLoadMuscleSummary) => {
                const rowColor = strengthLoadBalanceColor(r.status, r.score);
                const max = Math.max(r.targetMax, r.currentSets, 1);
                const pct = r.currentSets > 0
                  ? Math.max(4, Math.min(100, (r.currentSets / max) * 100))
                  : 0;
                const baselineCopy = r.baselineSets > 0
                  ? ` · ${formatSetCount(r.baselineSets)} baseline`
                  : '';
                return (
                  <View key={r.muscle} style={{ marginBottom: 12 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <Text style={{ flex: 1, fontSize: 13, fontWeight: '800', color: tc.textPrimary, textTransform: 'capitalize' }} numberOfLines={1}>
                        {r.muscle.replace(/_/g, ' ')}
                      </Text>
                      <Text style={{ fontSize: 12, color: tc.textSecondary, fontVariant: ['tabular-nums'] as any }}>
                        {formatSetCount(r.currentSets)} / {r.targetMin}-{r.targetMax}
                      </Text>
                      <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5, backgroundColor: rowColor + '24', borderWidth: 1, borderColor: rowColor + '80' }}>
                        <Text style={{ fontSize: 9, fontWeight: '900', color: rowColor, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                          {strengthLoadStatusLabel(r.status)}
                        </Text>
                      </View>
                    </View>
                    <View style={{ height: 6, borderRadius: 3, backgroundColor: tc.border, overflow: 'hidden' }}>
                      <View style={{ width: `${pct}%` as any, height: 6, backgroundColor: rowColor }} />
                    </View>
                    <Text style={{ marginTop: 4, fontSize: 11, color: tc.textMuted }}>
                      {formatSetCount(r.primarySets)} primary + {formatSetCount(r.secondarySets)} secondary credit{baselineCopy}
                    </Text>
                  </View>
                );
              };
              return (
                <>
                  <BottomSheetDismissHandle
                    onClose={() => setVolumeDetailMode(null)}
                    color={tc.border}
                    containerStyle={styles.quickDetailHandleTap}
                    handleStyle={styles.quickDetailHandle}
                  />
                  <View style={styles.quickDetailHeader}>
                    <View style={[styles.quickDetailIcon, { backgroundColor: headerColor + '20' }]}>
                      <Ionicons name={isWorkload ? 'analytics-outline' : 'body-outline'} size={18} color={headerColor} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.quickDetailEyebrow}>{isWorkload ? 'WORKLOAD' : 'STRENGTH BALANCE'}</Text>
                      <Text style={styles.quickDetailTitle} numberOfLines={2}>
                        {isWorkload
                          ? `${formatLoadVolume(tonnage.current.volumeLbs, weightUnit)} ${currentWeekCopy}`
                          : loadBalance.score == null ? 'Needs volume data' : `${loadBalance.score}/100 · weekly set targets`}
                      </Text>
                    </View>
                    <TouchableOpacity onPress={() => setVolumeDetailMode(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                      <Ionicons name="close" size={20} color={tc.textMuted} />
                    </TouchableOpacity>
                  </View>
                  <ScrollView style={styles.quickDetailScroll} contentContainerStyle={{ paddingBottom: 6 }} showsVerticalScrollIndicator={false}>
                    {tonnage.weeks.every(row => row.loadedSets === 0) ? (
                      <View style={styles.quickDetailSection}>
                        <Text style={styles.quickDetailMuted}>
                          No loaded strength sets in the last {tonnage.weekCount} weeks. Finish a workout
                          and the breakdown will appear here.
                        </Text>
                      </View>
                    ) : isWorkload ? (
                      <>
                        <Text style={styles.quickDetailBody}>
                          Workload is total reps times weight across loaded strength sets. The headline compares this week-to-date with last week at the same point; the chart uses fixed weekly buckets.
                        </Text>
                        <View style={styles.quickDetailMetricRow}>
                          {renderMetric('Total load', formatLoadVolume(tonnage.current.volumeLbs, weightUnit), `${formatLoadedSetCount(tonnage.current.loadedSets)} this window`, workloadColor)}
                          {renderMetric('Vs prior', vsPrior, priorVolume > 0 ? `${formatLoadVolume(priorVolume, weightUnit)} ${priorCopy}` : 'no useful prior baseline', tonnage.deltaPct == null || tonnage.deltaPct >= 0 ? workloadColor : '#EF4444')}
                        </View>
                        <View style={styles.quickDetailMetricRow}>
                          {renderMetric('Sessions', `${tonnage.current.sessionCount}`, 'strength sessions counted', workloadColor)}
                          {renderMetric('Avg / set', formatAverageLoadPerSet(tonnage.current, weightUnit), 'load divided by loaded sets', workloadColor)}
                        </View>
                        <View style={styles.quickDetailSection}>
                          <Text style={styles.quickDetailSectionTitle}>Read</Text>
                          <Text style={styles.quickDetailBody}>{workloadRead}</Text>
                        </View>
                        <View style={styles.quickDetailSection}>
                          <Text style={styles.quickDetailSectionTitle}>Last {tonnage.weekCount} fixed weeks</Text>
                          {tonnage.weeks.map(renderWorkloadWeekRow)}
                        </View>
                      </>
                    ) : (
                      <>
                        <Text style={styles.quickDetailBody}>
                          Strength Balance is weekly training-volume balance, not literal muscle strength. It compares completed hard sets against target ranges; primary muscles get full credit and secondary muscles get half credit.
                        </Text>
                        <View style={styles.quickDetailMetricRow}>
                          {renderMetric('In range', `${loadBalance.inRangeMuscleCount}/${loadBalance.activeMuscleCount}`, 'active muscles in their weekly set range', balanceColor)}
                          {renderMetric('Hard sets', `${loadBalance.current.loadedSets}`, 'working sets counted for balance', balanceColor)}
                        </View>
                        {loadBalance.lowMuscles.length > 0 && (
                          <View style={styles.quickDetailSection}>
                            <Text style={styles.quickDetailSectionTitle}>Needs volume</Text>
                            <Text style={[styles.quickDetailMuted, { marginBottom: 10 }]}>
                              Add hard sets for these muscles before the week closes.
                            </Text>
                            {loadBalance.lowMuscles.map(renderMuscleRow)}
                          </View>
                        )}
                        {overTargetMuscles.length > 0 && (
                          <View style={styles.quickDetailSection}>
                            <Text style={styles.quickDetailSectionTitle}>Above target or spiking</Text>
                            <Text style={[styles.quickDetailMuted, { marginBottom: 10 }]}>
                              These areas are penalized for being above target or jumping sharply versus your recent baseline.
                            </Text>
                            {overTargetMuscles.map(renderMuscleRow)}
                          </View>
                        )}
                        <View style={styles.quickDetailSection}>
                          <Text style={styles.quickDetailSectionTitle}>
                            All target ranges
                          </Text>
                          <Text style={[styles.quickDetailMuted, { marginBottom: 10 }]}>
                            {loadBalance.detail}
                          </Text>
                          {loadBalance.muscles.length === 0 ? (
                            <Text style={styles.quickDetailMuted}>
                              Loaded sets were found, but they do not have enough muscle tags yet.
                            </Text>
                          ) : (
                            loadBalance.muscles.map(renderMuscleRow)
                          )}
                        </View>
                      </>
                    )}
                  </ScrollView>
                </>
              );
            })()}
          </View>
        </View>
      </Modal>
      {/* Records detail — list of recent established PRs with the
          prior best they beat. Triggered from the Records row on the
          Trends tab. */}
      <Modal
        visible={recordsDetailOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setRecordsDetailOpen(false)}>
        <View style={styles.quickDetailBackdrop}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setRecordsDetailOpen(false)}
          />
          <View style={styles.quickDetailSheet}>
            {(() => {
              const sinceMs = Date.now() - PR_MOMENTUM_WINDOW_DAYS * 86400000;
              const records = buildRecordsBreakdown(history, prs, sinceMs);
              return (
                <>
                  <BottomSheetDismissHandle
                    onClose={() => setRecordsDetailOpen(false)}
                    color={tc.border}
                    containerStyle={styles.quickDetailHandleTap}
                    handleStyle={styles.quickDetailHandle}
                  />
                  <View style={styles.quickDetailHeader}>
                    <View style={[styles.quickDetailIcon, { backgroundColor: '#6366F1' + '20' }]}>
                      <Ionicons name="trophy-outline" size={18} color="#6366F1" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.quickDetailEyebrow}>RECORDS</Text>
                      <Text style={styles.quickDetailTitle} numberOfLines={2}>
                        {records.length} PR{records.length === 1 ? '' : 's'} in the last {PR_MOMENTUM_WINDOW_DAYS} days
                      </Text>
                    </View>
                    <TouchableOpacity onPress={() => setRecordsDetailOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                      <Ionicons name="close" size={20} color={tc.textMuted} />
                    </TouchableOpacity>
                  </View>
                  <ScrollView style={styles.quickDetailScroll} contentContainerStyle={{ paddingBottom: 6 }} showsVerticalScrollIndicator={false}>
                    <Text style={styles.quickDetailBody}>
                      Records you've set after your first baseline
                      session on each exercise. The prior best is the
                      heaviest set you'd logged on that exercise before
                      the PR's date.
                    </Text>
                    {records.length === 0 ? (
                      <View style={styles.quickDetailSection}>
                        <Text style={styles.quickDetailMuted}>
                          No new records in this window yet.
                        </Text>
                      </View>
                    ) : (
                      <View style={styles.quickDetailSection}>
                        {records.map(({ pr, priorBest }) => (
                          <View key={`${pr.exerciseName}-${pr.date}`} style={{ marginBottom: 12 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                              <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary, flex: 1 }} numberOfLines={1}>{pr.exerciseName}</Text>
                              <Text style={{ fontSize: 14, fontWeight: '800', color: '#6366F1', fontVariant: ['tabular-nums'] as any }}>
                                {formatWeight(pr.weightLbs, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 })} × {pr.reps}
                              </Text>
                            </View>
                            <Text style={{ fontSize: 11, color: tc.textMuted }}>
                              {formatDate(pr.date)}
                              {priorBest
                                ? ` · prior best ${formatWeight(priorBest.weightLbs, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 })} × ${priorBest.reps}`
                                : ' · first established record'}
                            </Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </ScrollView>
                </>
              );
            })()}
          </View>
        </View>
      </Modal>
      <Modal
        visible={biometricHistoryOpen && selectedBiometricConfig != null && selectedBiometric != null}
        transparent
        animationType="fade"
        onRequestClose={() => setBiometricHistoryOpen(false)}>
        <View style={styles.quickDetailBackdrop}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setBiometricHistoryOpen(false)}
          />
          <View style={styles.quickDetailSheet}>
            <BottomSheetDismissHandle
              onClose={() => setBiometricHistoryOpen(false)}
              color={tc.border}
              containerStyle={styles.quickDetailHandleTap}
              handleStyle={styles.quickDetailHandle}
            />
            {selectedBiometric && selectedBiometricConfig ? (
              <>
                <View style={styles.quickDetailHeader}>
                  <View style={[styles.quickDetailIcon, { backgroundColor: selectedBiometricConfig.accent + '20' }]}>
                    <Ionicons name={selectedBiometricConfig.icon} size={18} color={selectedBiometricConfig.accent} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.quickDetailEyebrow}>{selectedBiometricConfig.eyebrow.toUpperCase()}</Text>
                    <Text style={styles.quickDetailTitle} numberOfLines={2}>
                      {selectedBiometricConfig.title} history
                    </Text>
                  </View>
                  <TouchableOpacity onPress={() => setBiometricHistoryOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                    <Ionicons name="close" size={20} color={tc.textMuted} />
                  </TouchableOpacity>
                </View>
                <View style={styles.biometricWindowRow}>
                  {biometricWindowOptions.map(days => {
                    const active = biometricHistoryWindow === days;
                    return (
                      <TouchableOpacity
                        key={days}
                        activeOpacity={0.78}
                        onPress={() => setBiometricHistoryWindow(days)}
                        style={[
                          styles.biometricWindowButton,
                          {
                            backgroundColor: active ? selectedBiometricConfig.accent + '18' : tc.surfaceRaised,
                            borderColor: active ? selectedBiometricConfig.accent + '66' : tc.border,
                          },
                        ]}
                      >
                        <Text style={[styles.biometricWindowButtonText, { color: active ? selectedBiometricConfig.accent : tc.textSecondary }]}>
                          {days}D
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                {dailyHealthHistoryLoading && biometricHistoryPoints.length === 0 ? (
                  <View style={styles.biometricLoadingRow}>
                    <ActivityIndicator color={selectedBiometricConfig.accent} />
                    <Text style={[styles.quickDetailBody, { flex: 1 }]}>Loading history...</Text>
                  </View>
                ) : biometricHistoryPoints.length > 0 ? (
                  <ScrollView style={styles.quickDetailScroll} contentContainerStyle={{ paddingBottom: 6 }} showsVerticalScrollIndicator={false}>
                    <View style={styles.quickDetailMetricRow}>
                      <View style={styles.quickDetailMetric}>
                        <Text style={styles.quickDetailMetricLabel}>Latest</Text>
                        <Text style={[styles.quickDetailMetricValue, { color: selectedBiometricConfig.accent }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
                          {formatBiometricValue(selectedBiometric, biometricLatestPoint?.value)}
                        </Text>
                        <Text style={styles.quickDetailMetricDetail}>
                          {biometricLatestPoint ? formatDate(`${biometricLatestPoint.date}T12:00:00`) : 'latest sample'}
                        </Text>
                      </View>
                      <View style={styles.quickDetailMetric}>
                        <Text style={styles.quickDetailMetricLabel}>Average</Text>
                        <Text style={[styles.quickDetailMetricValue, { color: selectedBiometricConfig.accent }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
                          {formatBiometricValue(selectedBiometric, biometricAverage)}
                        </Text>
                        <Text style={styles.quickDetailMetricDetail}>
                          {biometricHistoryPoints.length} logged day{biometricHistoryPoints.length === 1 ? '' : 's'}
                        </Text>
                      </View>
                    </View>
                    <View style={styles.quickDetailMetricRow}>
                      <View style={styles.quickDetailMetric}>
                        <Text style={styles.quickDetailMetricLabel}>Change</Text>
                        <Text style={[styles.quickDetailMetricValue, { color: biometricTrendColor }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
                          {biometricDelta == null ? '--' : formatBiometricDelta(selectedBiometric, biometricDelta)}
                        </Text>
                        <Text style={styles.quickDetailMetricDetail}>
                          {selectedBiometricConfig.better === 'lower'
                            ? 'lower is generally better'
                            : selectedBiometricConfig.better === 'higher'
                              ? 'higher is generally better'
                              : 'trend context'}
                        </Text>
                      </View>
                      <View style={styles.quickDetailMetric}>
                        <Text style={styles.quickDetailMetricLabel}>Range</Text>
                        <Text style={[styles.quickDetailMetricValue, { color: selectedBiometricConfig.accent }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
                          {formatBiometricValue(selectedBiometric, biometricChartMin, false)}-{formatBiometricValue(selectedBiometric, biometricChartMax)}
                        </Text>
                        <Text style={styles.quickDetailMetricDetail}>visible window</Text>
                      </View>
                    </View>
                    <View style={[styles.biometricChartCard, { borderColor: tc.border, backgroundColor: tc.surfaceRaised }]}>
                      <View style={styles.biometricChartScaleRow}>
                        <Text style={[styles.biometricChartScaleText, { color: tc.textMuted }]}>
                          {formatBiometricValue(selectedBiometric, biometricChartMax)}
                        </Text>
                        {dailyHealthHistoryLoading ? <ActivityIndicator color={selectedBiometricConfig.accent} size="small" /> : null}
                        <Text style={[styles.biometricChartScaleText, { color: tc.textMuted }]}>
                          {formatBiometricValue(selectedBiometric, biometricChartMin)}
                        </Text>
                      </View>
                      {(() => {
                        const accent = selectedBiometricConfig.accent;
                        const pts = biometricHistoryPoints;
                        const n = pts.length;
                        const spacing = 46;
                        const padL = 24;
                        const padR = 24;
                        const padT = 24;
                        const padB = 26;
                        const chartH = 168;
                        const plotH = chartH - padT - padB;
                        const chartW = Math.max(280, padL + padR + Math.max(1, n - 1) * spacing);
                        const coords = pts.map((point, i) => {
                          const pctY = (point.value - biometricChartMin) / biometricChartSpan;
                          const x = n > 1 ? padL + i * spacing : chartW / 2;
                          const y = padT + plotH - pctY * plotH;
                          return { x, y, point };
                        });
                        const linePts = coords.map(co => `${co.x},${co.y}`).join(' ');
                        const gridYs = [0, 0.5, 1].map(f => padT + plotH - f * plotH);
                        return (
                          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingRight: 4 }}>
                            <Svg width={chartW} height={chartH}>
                              {gridYs.map((gy, gi) => (
                                <Line key={`grid-${gi}`} x1={padL} y1={gy} x2={chartW - padR} y2={gy}
                                  stroke={tc.border} strokeWidth={1} strokeDasharray="4,5" opacity={0.5} />
                              ))}
                              {coords.length >= 2 && (
                                <Polyline points={linePts} fill="none" stroke={accent} strokeWidth={2.5}
                                  strokeLinejoin="round" strokeLinecap="round" />
                              )}
                              {coords.map((co, i) => (
                                <Circle key={`dot-${i}`} cx={co.x} cy={co.y}
                                  r={i === coords.length - 1 ? 4.5 : 3}
                                  fill={accent} stroke={tc.surfaceRaised} strokeWidth={1.5} />
                              ))}
                              {coords.map((co, i) => (
                                <SvgText key={`val-${i}`} x={co.x} y={co.y - 9}
                                  fontSize={9} fontWeight="800" fill={accent} textAnchor="middle">
                                  {formatBiometricValue(selectedBiometric, co.point.value, false)}
                                </SvgText>
                              ))}
                              {coords.map((co, i) => (
                                <SvgText key={`date-${i}`} x={co.x} y={chartH - 8}
                                  fontSize={8} fontWeight="700" fill={tc.textMuted} textAnchor="middle">
                                  {co.point.date.slice(5).replace('-', '/')}
                                </SvgText>
                              ))}
                            </Svg>
                          </ScrollView>
                        );
                      })()}
                    </View>
                    <View style={[styles.biometricReadingList, { borderColor: tc.border, backgroundColor: tc.surfaceRaised }]}>
                      <View style={[styles.biometricReadingHeader, { borderBottomColor: tc.border }]}>
                        <Text style={[styles.biometricReadingHeaderText, { color: tc.textMuted }]}>READINGS</Text>
                        <Text style={[styles.biometricReadingHeaderMeta, { color: tc.textMuted }]}>
                          {biometricHistoryWindow}D
                        </Text>
                      </View>
                      {biometricReadingRows.map((point, index) => (
                        <View
                          key={`${point.date}-${point.value}-${index}`}
                          style={[
                            styles.biometricReadingRow,
                            {
                              borderBottomColor: tc.border + '66',
                              borderBottomWidth: index === biometricReadingRows.length - 1 ? 0 : StyleSheet.hairlineWidth,
                            },
                          ]}>
                          <Text style={[styles.biometricReadingDate, { color: tc.textSecondary }]} numberOfLines={1}>
                            {formatDate(`${point.date}T12:00:00`)}
                          </Text>
                          <Text style={[styles.biometricReadingValue, { color: selectedBiometricConfig.accent }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78}>
                            {formatBiometricValue(selectedBiometric, point.value)}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </ScrollView>
                ) : (
                  <View style={styles.biometricEmptyState}>
                    <Text style={[styles.quickDetailBody, { textAlign: 'center' }]}>{selectedBiometricConfig.empty}</Text>
                  </View>
                )}
              </>
            ) : null}
          </View>
        </View>
      </Modal>
      {/* Sleep history — last 30 nights as colored score circles. */}
      <Modal
        visible={sleepHistoryOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setSleepHistoryOpen(false)}>
        <View style={styles.quickDetailBackdrop}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setSleepHistoryOpen(false)}
          />
          <View style={styles.quickDetailSheet}>
            <BottomSheetDismissHandle
              onClose={() => setSleepHistoryOpen(false)}
              color={tc.border}
              containerStyle={styles.quickDetailHandleTap}
              handleStyle={styles.quickDetailHandle}
            />
            <View style={styles.quickDetailHeader}>
              <View style={[styles.quickDetailIcon, { backgroundColor: '#818CF8' + '20' }]}>
                <Ionicons name="moon-outline" size={18} color="#818CF8" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.quickDetailEyebrow}>SLEEP HISTORY</Text>
                <Text style={styles.quickDetailTitle} numberOfLines={2}>
                  Last {sleepHistory.length} night{sleepHistory.length === 1 ? '' : 's'}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setSleepHistoryOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={20} color={tc.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.quickDetailScroll} contentContainerStyle={{ paddingBottom: 6 }} showsVerticalScrollIndicator={false}>
              <Text style={styles.quickDetailBody}>
                Each circle is a night, oldest on the left. The number is
                the sleep score (same scoring used on the today card).
                Green is 80+ (Excellent / Good), amber is 60–79 (Fair),
                red is under 60 (Poor). Grey "—" means we didn't have
                enough data for that night.
              </Text>
              <View style={styles.quickDetailSection}>
                <Text style={styles.quickDetailSectionTitle}>Nights</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                  {(() => {
                    const ageForScore = userProfile?.physicalStats?.age ?? null;

                    return sleepHistory.map((n, i) => {
                      const score = sleepHistoryDotScore(n, i, sleepHistory, ageForScore);
                      const fill = score == null
                        ? null
                        : score >= 80 ? '#22C55E'
                        : score >= 60 ? '#F59E0B'
                        : '#EF4444';
                      return (
                        <View key={`${n.night}-${i}`} style={{ alignItems: 'center', gap: 3 }}>
                          <View style={{
                            width: 26, height: 26, borderRadius: 13,
                            backgroundColor: fill ?? tc.surfaceRaised,
                            borderWidth: fill ? 0 : 1,
                            borderColor: tc.border,
                            alignItems: 'center', justifyContent: 'center',
                          }}>
                            <Text style={{
                              fontSize: 9, fontWeight: '900',
                              color: fill ? '#FFFFFF' : tc.textMuted,
                            }} numberOfLines={1}>
                              {score ?? '—'}
                            </Text>
                          </View>
                          <Text style={{ fontSize: 8, color: tc.textMuted, fontVariant: ['tabular-nums'] as any }} numberOfLines={1}>
                            {n.night.slice(5).replace('-', '/')}
                          </Text>
                        </View>
                      );
                    });
                  })()}
                </View>
              </View>
              <View style={styles.quickDetailSection}>
                <Text style={styles.quickDetailSectionTitle}>Legend</Text>
                <View style={styles.quickDetailRow}>
                  <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#22C55E', marginRight: 8 }} />
                  <Text style={styles.quickDetailRowLabel}>80+</Text>
                  <Text style={[styles.quickDetailRowValue, { color: '#22C55E' }]}>Excellent / Good</Text>
                </View>
                <View style={styles.quickDetailRow}>
                  <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#F59E0B', marginRight: 8 }} />
                  <Text style={styles.quickDetailRowLabel}>60–79</Text>
                  <Text style={[styles.quickDetailRowValue, { color: '#F59E0B' }]}>Fair</Text>
                </View>
                <View style={styles.quickDetailRow}>
                  <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#EF4444', marginRight: 8 }} />
                  <Text style={styles.quickDetailRowLabel}>Under 60</Text>
                  <Text style={[styles.quickDetailRowValue, { color: '#EF4444' }]}>Poor</Text>
                </View>
                <View style={styles.quickDetailRow}>
                  <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: tc.surfaceRaised, borderWidth: 1, borderColor: tc.border, marginRight: 8 }} />
                  <Text style={styles.quickDetailRowLabel}>—</Text>
                  <Text style={[styles.quickDetailRowValue, { color: tc.textMuted }]}>No data</Text>
                </View>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
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
              placeholder={weightUnit === 'kg' ? 'e.g. 79.4' : 'e.g. 175'}
              placeholderTextColor={tc.textMuted}
              autoFocus
            />
            <Text style={{ fontSize: 12, color: tc.textMuted, textAlign: 'center', marginTop: 6 }}>{weightUnit}</Text>
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
                  const canonicalLbs = unitToLbs(val, weightUnit);
                  if (!val || canonicalLbs < 50 || canonicalLbs > 700) {
                    setWeightInputError(`Please enter a weight between ${formatWeight(50, weightUnit)} and ${formatWeight(700, weightUnit)}.`);
                    return;
                  }
                  const { saveWeightEntry } = await import('../utils/weightHistory');
                  const updated = await saveWeightEntry(canonicalLbs, 'manual');
                  setWeightEntries(updated);
                  setWeightInputVisible(false);
                  if (onUpdateWeight) onUpdateWeight(canonicalLbs);
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
        authToken={hasServerProTier ? authToken : null}
        bodyweightLbs={userProfile.physicalStats?.weightLbs ?? null}
        onSave={async (session) => {
          await saveWorkoutSession(session);
          const sessionDate = dateKey(new Date(session.date));
          if (sessionDate === dateKey(new Date())) {
            import('../utils/workoutReminders')
              .then(({ cancelTodayWorkoutReminder }) => cancelTodayWorkoutReminder())
              .catch(() => undefined);
          }
          if (authToken) {
            try {
              await completeWorkoutWithOfflineQueue(
                authToken,
                {
                  workout_date: sessionDate,
                  focus_label: session.focus,
                  duration_seconds: session.durationSeconds,
                  activity: session.manualActivity ? {
                    category: session.manualActivity.category,
                    subtype: session.manualActivity.subtype,
                    intensity: session.manualActivity.intensity,
                    source: session.manualActivity.source,
                    cardioStyle: session.manualActivity.cardioStyle,
                    distanceMiles: session.manualActivity.distanceMiles,
                    caloriesBurned: session.manualActivity.caloriesBurned,
                    avgHeartRate: session.manualActivity.avgHeartRate,
                    details: session.manualActivity.details,
                    routeCoords: session.manualActivity.routeCoords,
                  } : undefined,
                  healthMetrics: appleHealthMetricsFromWorkoutSession(session),
                  source: {
                    sourceContext: session.manualActivity?.source === 'apple_health' ? 'apple_health' : undefined,
                    startedAt: session.startedAt ?? session.date,
                    endedAt: session.endedAt ?? null,
                    externalSourceId: session.id,
                  },
                },
                session,
              );
            } catch {}
          }
          const [h, s] = await Promise.all([loadWorkoutHistory(), loadWorkoutSummaries()]);
          setHistory(h);
          setSummaries(s);
          import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
        }}
      />
      <AppleHealthWorkoutAttachModal
        visible={appleHealthAttachSession != null}
        session={appleHealthAttachSession}
        authToken={authToken}
        themeName={themeName}
        distanceUnit={distanceUnit}
        age={userProfile.physicalStats?.age ?? null}
        onClose={() => setAppleHealthAttachSession(null)}
        onAssigned={async () => {
          const [h, s] = await Promise.all([loadWorkoutHistory(), loadWorkoutSummaries()]);
          setHistory(h);
          setSummaries(s);
          if (authToken) {
            getPaceHistory(authToken).then(r => setPaceHistory(r.points)).catch(() => {});
          }
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
          <View
            testID="progress-plateau-modal"
            style={{ backgroundColor: tc.surface, borderRadius: 16, padding: 20, maxHeight: '80%' }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: tc.textPrimary }}>Plateau recommendations</Text>
              <TouchableOpacity
                testID="progress-plateau-modal-close"
                accessibilityRole="button"
                accessibilityLabel="Close plateau recommendations"
                onPress={() => setPlateauModalVisible(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={tc.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView testID="progress-plateau-modal-list">
              {plateaus.map((p, i) => {
                return (
                  <View
                    testID={`progress-plateau-modal-row-${i}`}
                    key={`${p.exercise_name}-${i}`}
                    style={{ marginBottom: 14, backgroundColor: tc.background, padding: 12, borderRadius: 10 }}>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }}>
                      {p.exercise_name}
                    </Text>
                    <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 2 }}>
                      {plateauSuggestionTitle(p.suggestion)} · est 1RM {Math.round(p.current_1rm)} lb · flat for {p.weeks_stuck} weeks
                    </Text>
                    <Text style={{ fontSize: 12, color: tc.textPrimary, marginTop: 6, lineHeight: 16 }}>
                      {plateauSuggestionDetail(p)}
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

function createStyles(colors: ReturnType<typeof getTheme>['colors'], webMode = false) { return StyleSheet.create({
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

  // Labeled pill tabs — evenly spaced across the row, centered text.
  // Replaces the segmented bar with a row of equal-width pills so each
  // section has the same hit target.
  tabPillRow: {
    flexDirection: 'row',
    gap: 5,
    paddingHorizontal: webMode ? 16 : 12,
    marginTop: webMode ? 12 : 10,
    marginBottom: webMode ? 10 : 8,
    width: webMode ? '100%' : undefined,
    maxWidth: webMode ? 980 : undefined,
    alignSelf: webMode ? 'center' : undefined,
  },
  tabPillBtn: {
    flex: 1,
    minWidth: 0,
    minHeight: 34,
    paddingHorizontal: 2,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabPillText: {
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0,
    fontWeight: '800',
    textAlign: 'center',
    maxWidth: '100%',
  },

  center:  { flex: 1, justifyContent: 'center', alignItems: 'center' },
  // Bottom padding clears the fixed 5-tab bottom nav bar (~57 px +
  // safe area). Otherwise the bottom of the content (sign-out,
  // delete-last-entry, etc.) sits under the tab bar.
  content: {
    padding: webMode ? 16 : 16,
    paddingBottom: webMode ? 44 : 140,
    paddingTop: webMode ? 12 : 12,
    width: webMode ? '100%' : undefined,
    maxWidth: webMode ? 980 : undefined,
    alignSelf: webMode ? 'center' : undefined,
  },

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
  todayDashboardCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginBottom: 16,
  },
  todayStatusCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: 14,
    marginBottom: 16,
    ...elevations.subtle,
  },
  todayStatusHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 13,
  },
  todayStatusIcon: {
    width: 42,
    height: 42,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  todayStatusEyebrow: {
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.5,
    color: colors.textMuted,
  },
  todayStatusDate: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.textPrimary,
    marginTop: 2,
  },
  todayStatusPill: {
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  todayStatusPillText: {
    fontSize: 10,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  todayStatusTitle: {
    fontSize: 24,
    fontWeight: '900',
    color: colors.textPrimary,
    lineHeight: 29,
  },
  todayStatusSubtitle: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 18,
    marginTop: 6,
  },
  todayStatusMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginTop: 7,
  },
  todayStatusMetaText: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.textMuted,
  },
  todayActionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 7,
    marginTop: 12,
  },
  todayActionText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '800',
    color: colors.textSecondary,
    lineHeight: 17,
  },
  quickDetailHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    alignSelf: 'center',
  },
  quickDetailHintText: {
    fontSize: 11,
    fontWeight: '900',
    color: colors.textMuted,
  },
  goalForecastCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.border,
    padding: 14,
    marginBottom: 12,
    ...elevations.subtle,
  },
  todayHeroCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    overflow: 'hidden',
    marginBottom: 12,
    ...elevations.subtle,
  },
  todayHeroImageWrap: {
    height: 132,
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  todayHeroImage: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  todayHeroImageMeta: {
    padding: 13,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
  },
  todayHeroImageEyebrow: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '900',
    textTransform: 'uppercase',
    color: '#FFFFFF',
  },
  todayHeroImageGoal: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '900',
    color: '#FFFFFF',
    marginTop: 2,
  },
  todayHeroImagePillText: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '900',
    textTransform: 'uppercase',
    color: '#FFFFFF',
  },
  todayHeroContent: {
    padding: 14,
  },
  todayHeroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  todayHeroIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  todayHeroEyebrow: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '900',
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
  todayHeroGoal: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '900',
    color: colors.textPrimary,
    marginTop: 1,
  },
  todayHeroPill: {
    maxWidth: 112,
    minHeight: 28,
    borderRadius: radius.full,
    borderWidth: 1,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  todayHeroPillText: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  todayHeroBody: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  todayHeroHeadline: {
    fontSize: 20,
    lineHeight: 25,
    fontWeight: '900',
    color: colors.textPrimary,
  },
  todayHeroSubheadline: {
    fontSize: 12,
    lineHeight: 17,
    color: colors.textSecondary,
    marginTop: 5,
  },
  todayHeroScoreBubble: {
    width: 88,
    minHeight: 88,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  todayHeroScoreValue: {
    fontSize: 24,
    lineHeight: 29,
    fontWeight: '900',
    fontVariant: ['tabular-nums'] as any,
  },
  todayHeroScoreLabel: {
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '900',
    color: colors.textMuted,
    textTransform: 'uppercase',
    marginTop: 2,
  },
  todayHeroTrack: {
    height: 8,
    borderRadius: radius.full,
    overflow: 'visible',
    position: 'relative',
    backgroundColor: colors.border,
    marginTop: 13,
  },
  todayHeroFill: {
    height: '100%',
    borderRadius: radius.full,
  },
  todayHeroPaceTick: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    marginLeft: -1,
    borderRadius: 1,
    backgroundColor: colors.textPrimary,
    opacity: 0.5,
  },
  goalExecutionGraph: {
    marginTop: 13,
  },
  goalExecutionGraphHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  goalExecutionGraphTitle: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '900',
    color: colors.textPrimary,
  },
  goalExecutionGraphSubtitle: {
    fontSize: 10.5,
    lineHeight: 14,
    fontWeight: '700',
    color: colors.textMuted,
    marginTop: 1,
  },
  goalExecutionGraphMeta: {
    alignItems: 'flex-end',
    maxWidth: 118,
  },
  goalExecutionGraphMetaText: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  goalExecutionGraphMetaSub: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '800',
    color: colors.textMuted,
    marginTop: 1,
  },
  goalExecutionLegend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
    marginTop: 8,
  },
  goalExecutionLegendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  goalExecutionLegendLine: {
    width: 18,
    height: 3,
    borderRadius: 2,
  },
  goalExecutionLegendText: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '900',
    color: colors.textSecondary,
  },
  goalOverviewStatsRow: {
    flexDirection: 'row',
    gap: 9,
    marginTop: 13,
  },
  goalOverviewStat: {
    flex: 1,
    minWidth: 0,
    paddingRight: 3,
  },
  goalOverviewStatLabel: {
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '900',
    color: colors.textMuted,
    textTransform: 'uppercase',
  },
  goalOverviewStatValue: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '900',
    color: colors.textPrimary,
    marginTop: 2,
  },
  goalOverviewStatDetail: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '800',
    color: colors.textMuted,
    marginTop: 1,
  },
  todayHeroStatsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  todayHeroStat: {
    flex: 1,
    minHeight: 68,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    padding: 9,
  },
  todayHeroStatLabel: {
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '900',
    color: colors.textMuted,
    textTransform: 'uppercase',
  },
  todayHeroStatValue: {
    fontSize: 17,
    lineHeight: 21,
    fontWeight: '900',
    color: colors.textPrimary,
    marginTop: 3,
  },
  todayHeroStatDetail: {
    fontSize: 10,
    lineHeight: 13,
    color: colors.textSecondary,
    marginTop: 2,
  },
  todayHeroReadout: {
    minHeight: 42,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 9,
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 7,
  },
  todayHeroReadoutText: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '800',
    color: colors.textSecondary,
  },
  todayHeroReadoutMore: {
    fontSize: 11,
    fontWeight: '900',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  todayMetricGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  todayMetricGridItem: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 164,
    minWidth: 0,
  },
  todayMetricCard: {
    minHeight: 238,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.border,
    padding: 0,
    justifyContent: 'flex-start',
    ...elevations.subtle,
  },
  goalForecastHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 11,
  },
  goalForecastCompactHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  goalForecastIcon: {
    width: 34,
    height: 34,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  goalForecastEyebrow: {
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.6,
    color: colors.textMuted,
  },
  goalForecastTitle: {
    fontSize: 15,
    fontWeight: '900',
    color: colors.textPrimary,
    marginTop: 1,
  },
  goalForecastPill: {
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignItems: 'center',
    minWidth: 70,
  },
  goalForecastPillLabel: {
    fontSize: 7,
    fontWeight: '900',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    lineHeight: 9,
  },
  goalForecastPillText: {
    fontSize: 10,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  goalForecastHeadline: {
    fontSize: 19,
    fontWeight: '900',
    color: colors.textPrimary,
    lineHeight: 24,
  },
  goalForecastSubheadline: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 17,
    marginTop: 5,
  },
  quickForecastFooter: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 10,
  },
  goalForecastStats: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  goalForecastPrimaryStat: {
    flex: 1.25,
    minHeight: 78,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    padding: 9,
  },
  goalForecastStat: {
    flex: 1,
    minHeight: 78,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    padding: 9,
  },
  goalForecastStatLabel: {
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
  goalForecastMetricValue: {
    fontSize: 20,
    fontWeight: '900',
    marginTop: 2,
  },
  goalForecastStatValue: {
    fontSize: 16,
    fontWeight: '900',
    color: colors.textPrimary,
    marginTop: 3,
  },
  goalForecastStatDetail: {
    fontSize: 10,
    color: colors.textSecondary,
    lineHeight: 14,
    marginTop: 2,
  },
  goalEstimateCompactBody: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 12,
  },
  goalEstimateMetricBlock: {
    flex: 1,
    minWidth: 0,
  },
  goalEstimateMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  goalEstimateDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  goalForecastReason: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 7,
    marginTop: 12,
    padding: 10,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  goalForecastReasonText: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.textSecondary,
    lineHeight: 17,
  },
  goalForecastAssumption: {
    fontSize: 11,
    color: colors.textMuted,
    lineHeight: 15,
    marginTop: 2,
  },
  scoreReadoutStrip: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 7,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    padding: 10,
    marginBottom: 10,
  },
  scoreReadoutText: {
    flex: 1,
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary,
    lineHeight: 16,
  },
  performanceGaugeCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginBottom: 16,
  },
  performanceGaugeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  performanceGaugeTitle: {
    fontSize: 15,
    fontWeight: '900',
    color: colors.textPrimary,
  },
  performanceGaugeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  performanceGaugeTile: {
    flexGrow: 1,
    flexBasis: '47%',
    minHeight: 128,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    padding: 10,
    overflow: 'hidden',
  },
  performanceGaugeIcon: {
    width: 27,
    height: 27,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 7,
  },
  performanceGaugeLabel: {
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
  performanceGaugeValue: {
    fontSize: 23,
    fontWeight: '900',
    marginTop: 2,
  },
  performanceGaugeTrack: {
    height: 6,
    borderRadius: radius.full,
    overflow: 'hidden',
    backgroundColor: colors.border,
    marginTop: 7,
  },
  performanceGaugeFill: {
    height: '100%',
    borderRadius: radius.full,
  },
  performanceGaugeDetail: {
    fontSize: 11,
    color: colors.textSecondary,
    lineHeight: 15,
    marginTop: 7,
  },
  trendsRadarStack: {
    gap: 12,
    marginBottom: 16,
  },
  trendsRadarGridItem: {
    width: '100%',
    minWidth: 0,
  },
  trendsRadarCard: {
    flex: 1,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    backgroundColor: colors.surfaceRaised,
    padding: 12,
    ...elevations.subtle,
  },
  trendsRadarCardCompact: {
    minHeight: 204,
    padding: 10,
  },
  trendsRadarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  trendsRadarHeaderCompact: {
    alignItems: 'flex-start',
    gap: 6,
  },
  trendsRadarIcon: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trendsRadarIconCompact: {
    width: 26,
    height: 26,
    borderRadius: 9,
  },
  trendsRadarEyebrow: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '900',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
  trendsRadarTitle: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '900',
    color: colors.textPrimary,
    marginTop: 1,
  },
  trendsRadarTitleCompact: {
    fontSize: 13,
    lineHeight: 16,
  },
  trendsRadarScorePill: {
    minWidth: 44,
    minHeight: 30,
    borderRadius: 9,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  trendsRadarScorePillCompact: {
    minWidth: 36,
    minHeight: 26,
    borderRadius: 8,
    paddingHorizontal: 6,
  },
  trendsRadarScoreText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
  },
  trendsRadarScoreTextCompact: {
    fontSize: 11,
    lineHeight: 14,
  },
  trendsRadarBody: {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  trendsRadarChartWrap: {
    width: '100%',
    minHeight: 196,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trendsRadarChartWrapCompact: {
    width: 112,
    minHeight: 124,
  },
  trendsRadarInsightRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  trendsRadarInsightChip: {
    flex: 1,
    minWidth: 0,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  trendsRadarInsightLabel: {
    fontSize: 9,
    lineHeight: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
  trendsRadarInsightValue: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '900',
    marginTop: 1,
  },
  trendsRadarMetricGrid: {
    width: '100%',
    minWidth: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 2,
  },
  trendsRadarMetric: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '31%',
    minWidth: 92,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 7,
    paddingVertical: 6,
  },
  trendsRadarMetricHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  trendsRadarMetricLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: 9,
    lineHeight: 11,
    fontWeight: '900',
    letterSpacing: 0.2,
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
  trendsRadarMetricValue: {
    fontSize: 12,
    lineHeight: 14,
    fontWeight: '900',
    fontVariant: ['tabular-nums'] as any,
  },
  trendsRadarMetricDetail: {
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '700',
    color: colors.textSecondary,
    marginTop: 2,
  },
  trendsRadarDetail: {
    fontSize: 11,
    lineHeight: 15,
    color: colors.textSecondary,
    marginTop: 9,
  },
  trendsScoreGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  trendsScoreGridItem: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '47%',
    minWidth: 0,
  },
  trendsScoreCard: {
    minHeight: 188,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    backgroundColor: colors.surfaceRaised,
    overflow: 'hidden',
    ...elevations.subtle,
  },
  trendsScoreImage: {
    height: 82,
    overflow: 'hidden',
  },
  trendsScoreImageStyle: {
    resizeMode: 'cover',
  },
  trendsScoreImageGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  trendsScoreContent: {
    padding: 12,
  },
  trendsScoreHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginBottom: 8,
  },
  trendsScoreIcon: {
    width: 28,
    height: 28,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trendsScoreLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '900',
    letterSpacing: 0.2,
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
  trendsScoreValue: {
    fontSize: 34,
    lineHeight: 38,
    fontWeight: '900',
    fontVariant: ['tabular-nums'] as any,
  },
  trendsScoreTitle: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '900',
    color: colors.textPrimary,
    marginTop: 2,
  },
  trendsScoreDetail: {
    minHeight: 34,
    fontSize: 11,
    lineHeight: 16,
    color: colors.textSecondary,
    marginTop: 4,
  },
  trendsScoreMiniRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 9,
  },
  trendsScoreMiniStat: {
    flex: 1,
    minHeight: 42,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 7,
    paddingVertical: 6,
  },
  trendsScoreMiniValue: {
    fontSize: 13,
    lineHeight: 16,
    fontWeight: '900',
    color: colors.textPrimary,
  },
  trendsScoreMiniLabel: {
    fontSize: 9,
    lineHeight: 11,
    fontWeight: '900',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    color: colors.textMuted,
    marginTop: 1,
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
  insightsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  insightsTitle: { fontSize: 14, fontWeight: '800', color: colors.textPrimary },
  insightsLine: { fontSize: 12, color: colors.textSecondary, marginBottom: 4 },
  guardrailText: { fontSize: 12, color: colors.warning, marginBottom: 3 },
  memoryText: { fontSize: 12, color: colors.textSecondary, marginBottom: 3 },
  progressionHint: { fontSize: 12, color: colors.primary, marginTop: 4, fontWeight: '600' },
  coachInsightGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  coachInsightTile: {
    flexGrow: 1,
    flexBasis: '47%',
    minHeight: 116,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    padding: 10,
  },
  coachInsightIcon: {
    width: 27,
    height: 27,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 7,
  },
  coachInsightLabel: {
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
  coachInsightValue: {
    fontSize: 21,
    fontWeight: '900',
    marginTop: 2,
  },
  coachInsightDetail: {
    fontSize: 11,
    color: colors.textSecondary,
    lineHeight: 15,
    marginTop: 5,
  },

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
  cardioSectionCard: {
    gap: 12,
  },
  cardioSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  cardioInsightGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  cardioInsightTile: {
    flexGrow: 1,
    flexBasis: '47%',
    minHeight: 86,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    padding: 10,
    overflow: 'hidden',
  },
  cardioInsightValue: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '900',
    color: colors.textPrimary,
  },
  cardioInsightLabel: {
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '900',
    letterSpacing: 0.35,
    textTransform: 'uppercase',
    color: colors.textMuted,
    marginTop: 2,
  },
  cardioInsightDetail: {
    fontSize: 11,
    lineHeight: 15,
    color: colors.textSecondary,
    marginTop: 4,
  },
  cardioChartPanel: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 12,
  },
  cardioChartEmpty: {
    alignItems: 'center',
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 18,
    paddingBottom: 6,
  },
  activityTrendCard: {
    gap: 12,
  },
  trendCardsEditButton: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  trendCardsEditText: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '800',
  },
  trendCardsEmptyState: {
    minHeight: 132,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 18,
  },
  trendCardsEmptyTitle: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '900',
    textAlign: 'center',
  },
  trendCardsEmptyBody: {
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  activityTrendGrid: {
    gap: 10,
  },
  activityTrendTile: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    padding: 11,
    overflow: 'hidden',
  },
  activityTrendTileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginBottom: 10,
  },
  activityTrendIcon: {
    width: 28,
    height: 28,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activityTrendTitle: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '900',
    color: colors.textPrimary,
  },
  activityTrendSubtitle: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '800',
    color: colors.textMuted,
    marginTop: 1,
  },
  activityTrendMetricGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  activityTrendMetric: {
    flexGrow: 1,
    flexBasis: '47%',
    minHeight: 72,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  activityTrendMetricValue: {
    fontSize: 17,
    lineHeight: 21,
    fontWeight: '900',
    fontVariant: ['tabular-nums'] as any,
  },
  activityTrendMetricLabel: {
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '900',
    textTransform: 'uppercase',
    color: colors.textMuted,
    marginTop: 2,
  },
  activityTrendMetricDetail: {
    fontSize: 10,
    lineHeight: 14,
    color: colors.textSecondary,
    marginTop: 3,
  },
  trendSuggestionCard: {
    gap: 12,
  },
  trendSuggestionList: {
    gap: 10,
  },
  trendSuggestionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    padding: 10,
    overflow: 'hidden',
  },
  trendSuggestionIcon: {
    width: 28,
    height: 28,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  trendSuggestionTitle: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '900',
    color: colors.textPrimary,
  },
  trendSuggestionDetail: {
    fontSize: 11,
    lineHeight: 16,
    color: colors.textSecondary,
    marginTop: 2,
  },
  cardioGraphBars: {
    minHeight: 132,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 2,
  },
  cardioGraphBarCol: {
    width: 40,
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
  },
  cardioGraphBar: {
    width: 22,
    backgroundColor: colors.accent,
    borderRadius: 7,
  },
  graphHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 4 },
  graphTitle: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: '700', color: colors.textPrimary, lineHeight: 19 },
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
  sessionStats:  { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 10, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  sessionStat:   { fontSize: 12, color: colors.textSecondary },
  sessionStatDot:{ fontSize: 12, color: colors.textMuted },
  workoutScorePill: {
    minHeight: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  workoutScorePillText: {
    fontSize: 11,
    fontWeight: '800',
  },
  exRow:    { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  exName:   { fontSize: 13, color: colors.textPrimary },
  exBest:   { fontSize: 13, color: colors.primary, fontWeight: '600' },
  historyFilterGroup: {
    gap: 6,
    marginBottom: 8,
  },
  historyFilterScroller: {
    gap: 6,
    paddingRight: 14,
  },
  historyFilterChip: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  historyFilterChipText: {
    fontSize: 11,
    fontWeight: '800',
  },

  exerciseChipScroller: {
    gap: 8,
    paddingBottom: 12,
    paddingRight: 16,
  },
  exerciseChip: {
    maxWidth: 190,
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  exerciseChipActive: { borderColor: colors.primary, backgroundColor: colors.primary + '20' },
  exerciseChipText: { fontSize: 12, color: colors.textSecondary, fontWeight: '600', flexShrink: 1 },
  exerciseChipTextActive: { color: colors.primary },
  disabledChip: {
    opacity: 0.44,
  },
  disabledChipText: {
    color: colors.textMuted,
  },

  chartModeGroup: {
    flexShrink: 0,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 6,
    flexWrap: 'wrap',
    maxWidth: 190,
  },

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

  // ── Device health vitals card ──
  vitalsCard: {
    backgroundColor: colors.surface,
    borderRadius: 20,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: colors.border,
    ...elevations.card,
  },
  healthDataImageCard: {
    padding: 0,
    overflow: 'hidden',
  },
  healthLabsSection: {
    marginTop: 14,
  },
  healthSunExposureSection: {
    marginTop: 0,
    marginBottom: 14,
  },
  healthEditButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    overflow: 'hidden',
  },
  healthVitalsOverviewGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  healthVitalsOverviewRow: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '47%',
    minWidth: 124,
    minHeight: 96,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 9,
    gap: 5,
    justifyContent: 'space-between',
    position: 'relative',
    overflow: 'hidden',
    ...elevations.subtle,
  },
  healthVitalsOverviewSheen: {
    top: -26,
    bottom: -26,
    width: 58,
  },
  healthVitalsOverviewTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    minWidth: 0,
  },
  healthVitalsOverviewIcon: {
    width: 28,
    height: 28,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  healthVitalsOverviewStatusRail: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexShrink: 1,
  },
  healthVitalsStatusPill: {
    minHeight: 20,
    maxWidth: 68,
    flexShrink: 1,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  healthVitalsStatusText: {
    fontSize: 9,
    lineHeight: 11,
    fontWeight: '900',
  },
  healthVitalsOverviewLabel: {
    fontSize: 8,
    lineHeight: 10,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  healthVitalsOverviewValue: {
    fontSize: 15,
    lineHeight: 18,
    fontWeight: '900',
    marginTop: 1,
  },
  healthVitalsOverviewUnit: {
    fontSize: 9,
    lineHeight: 11,
    fontWeight: '700',
    marginTop: 1,
  },
  healthVitalsTrendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 3,
  },
  healthVitalsTrendDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  healthVitalsTrendText: {
    flex: 1,
    minWidth: 0,
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
  },
  healthVitalsSignalLine: {
    height: 3,
    borderRadius: 999,
    overflow: 'hidden',
  },
  healthVitalsSignalFill: {
    width: '62%',
    height: '100%',
    borderRadius: 999,
  },
  healthVitalsOverviewMoreButton: {
    minHeight: 38,
    borderRadius: radius.md,
    borderWidth: 1,
    marginTop: 10,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  healthVitalsOverviewMoreText: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '800',
  },
  healthDataHero: {
    height: 136,
    justifyContent: 'flex-end',
    position: 'relative',
    overflow: 'hidden',
  },
  healthDataHeroSheen: {
    top: -54,
    bottom: -54,
    width: 112,
  },
  healthDataHeroImage: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  healthDataHeroMeta: {
    padding: 13,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 9,
  },
  healthDataHeroIcon: {
    width: 31,
    height: 31,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.26)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  healthDataHeroEyebrow: {
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '900',
    textTransform: 'uppercase',
    color: '#FFFFFF',
  },
  healthDataHeroTitle: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '900',
    color: '#FFFFFF',
    marginTop: 2,
  },
  healthDataHeroSubtitle: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '800',
    color: '#FFFFFF',
    opacity: 0.9,
    marginTop: 2,
  },
  healthDataHeroBadge: {
    minHeight: 27,
    maxWidth: 86,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: '#FFFFFF66',
    backgroundColor: '#FFFFFF24',
    paddingHorizontal: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  healthDataHeroBadgeText: {
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '900',
    color: '#FFFFFF',
    textTransform: 'uppercase',
  },
  healthDataContent: {
    padding: 16,
    position: 'relative',
    overflow: 'hidden',
  },
  nutritionGutFactsCard: {
    padding: 0,
    overflow: 'hidden',
  },
  nutritionGutHero: {
    height: 132,
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  nutritionGutHeroImage: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  nutritionGutHeroMeta: {
    padding: 13,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 9,
  },
  nutritionGutEyebrow: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '900',
    textTransform: 'uppercase',
    color: '#FFFFFF',
  },
  nutritionGutHeroTitle: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '900',
    color: '#FFFFFF',
    marginTop: 2,
  },
  nutritionGutDataPill: {
    minHeight: 27,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: '#FFFFFF66',
    backgroundColor: '#FFFFFF24',
    paddingHorizontal: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nutritionGutDataPillText: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '900',
    color: '#FFFFFF',
    textTransform: 'uppercase',
  },
  nutritionGutFactsContent: {
    padding: 16,
  },
  vitalsHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  vitalsTitle: { ...typography.cardTitle },
  vitalsSubtitle: { ...typography.micro, marginLeft: 'auto' },
  vitalsGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  vitalsCell: { width: '33.333%', paddingVertical: 8, alignItems: 'center' },
  vitalsValue: { fontSize: 18, fontWeight: '700' },
  vitalsLabel: { fontSize: 10, fontWeight: '600', marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 },

  // ── Recovery / device health ──
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

  bodyImageCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    marginBottom: 14,
  },
  bodyImageHeader: {
    height: 124,
    overflow: 'hidden',
  },
  bodyImageHeaderImage: {
    resizeMode: 'cover',
  },
  bodyImageHeaderGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  bodyImageContent: {
    padding: 16,
  },

  // ── Body Scan ──
  bodyScanPrompt: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    marginBottom: 16,
  },
  bodyScanPromptImage: {
    height: 136,
    overflow: 'hidden',
  },
  bodyScanPromptImageStyle: {
    resizeMode: 'cover',
  },
  bodyScanPromptImageGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  bodyScanPromptContent: {
    padding: 18,
    alignItems: 'center',
    gap: 6,
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
  quickDetailBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.58)',
    justifyContent: 'flex-end',
  },
  quickDetailSheet: {
    maxHeight: '82%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 20,
  },
  quickDetailHandleTap: {
    minHeight: 18,
    paddingBottom: 14,
    justifyContent: 'flex-start',
  },
  quickDetailHandle: {
    width: 42,
    height: 4,
    borderRadius: 999,
  },
  quickDetailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  quickDetailIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickDetailEyebrow: {
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.5,
    color: colors.textMuted,
  },
  quickDetailTitle: {
    fontSize: 17,
    fontWeight: '900',
    color: colors.textPrimary,
    lineHeight: 22,
    marginTop: 1,
  },
  quickDetailScroll: {
    maxHeight: 520,
  },
  quickDetailBody: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  quickDetailMuted: {
    fontSize: 12,
    color: colors.textMuted,
    lineHeight: 17,
    marginTop: 4,
  },
  quickDetailMetricRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  quickDetailMetric: {
    flex: 1,
    minHeight: 92,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    padding: 10,
  },
  quickDetailMetricLabel: {
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
  quickDetailMetricValue: {
    fontSize: 19,
    fontWeight: '900',
    marginTop: 4,
  },
  quickDetailMetricDetail: {
    fontSize: 10,
    color: colors.textSecondary,
    lineHeight: 14,
    marginTop: 4,
  },
  biometricWindowRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 2,
    marginBottom: 4,
  },
  biometricWindowButton: {
    minHeight: 34,
    minWidth: 72,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  biometricWindowButtonText: {
    fontSize: 12,
    fontWeight: '900',
  },
  biometricLoadingRow: {
    minHeight: 74,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingVertical: 12,
  },
  biometricEmptyState: {
    minHeight: 110,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  biometricChartCard: {
    borderRadius: radius.lg,
    borderWidth: 1,
    marginTop: 12,
    paddingVertical: 10,
    paddingHorizontal: 10,
    overflow: 'hidden',
  },
  biometricChartScaleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  biometricChartScaleText: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '800',
  },
  biometricBarScroll: {
    alignItems: 'flex-end',
    gap: 7,
    paddingRight: 2,
  },
  biometricBarColumn: {
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
  },
  biometricBarTrack: {
    width: 12,
    borderRadius: 999,
    justifyContent: 'flex-end',
    alignItems: 'center',
    overflow: 'hidden',
  },
  biometricBarFill: {
    width: 12,
    borderRadius: 999,
  },
  biometricBarValue: {
    fontSize: 9,
    lineHeight: 11,
    fontWeight: '800',
    width: 34,
    textAlign: 'center',
  },
  biometricBarLabel: {
    fontSize: 8,
    lineHeight: 10,
    fontWeight: '800',
    width: 34,
    textAlign: 'center',
  },
  biometricReadingList: {
    borderRadius: radius.lg,
    borderWidth: 1,
    marginTop: 12,
    overflow: 'hidden',
  },
  biometricReadingHeader: {
    minHeight: 34,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  biometricReadingHeaderText: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  biometricReadingHeaderMeta: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '900',
  },
  biometricReadingRow: {
    minHeight: 38,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  biometricReadingDate: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '800',
  },
  biometricReadingValue: {
    maxWidth: 132,
    fontSize: 13,
    lineHeight: 16,
    fontWeight: '900',
    textAlign: 'right',
  },
  quickDetailSection: {
    marginTop: 14,
  },
  quickDetailSectionTitle: {
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.textMuted,
    marginBottom: 7,
  },
  quickDetailRow: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingVertical: 9,
  },
  quickDetailRowLabel: {
    fontSize: 12,
    fontWeight: '900',
    color: colors.textPrimary,
  },
  quickDetailRowValue: {
    fontSize: 15,
    fontWeight: '900',
    color: colors.textPrimary,
    marginTop: 2,
  },
  quickDetailRowDetail: {
    fontSize: 11,
    color: colors.textSecondary,
    lineHeight: 15,
    marginTop: 2,
  },
  quickDetailBullet: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  quickDetailBulletText: {
    flex: 1,
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 17,
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
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: colors.primary + '15',
    borderWidth: 3,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
    flexShrink: 0,
  },
  bodyScanBfValue: {
    fontSize: 22,
    fontWeight: '900',
    color: colors.primary,
    textAlign: 'center',
    includeFontPadding: false as any,
  },
  bodyScanBfLabel: {
    fontSize: 9,
    color: colors.textMuted,
    textTransform: 'uppercase',
    fontWeight: '700',
    letterSpacing: 0.4,
    marginTop: 1,
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

export default memo(ProgressScreen);
