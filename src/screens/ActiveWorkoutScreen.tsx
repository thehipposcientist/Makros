import React, { Fragment, useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, useDeferredValue } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  TextInput, Modal, ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Vibration, Linking, Image, Keyboard,
  LayoutAnimation, UIManager, AppState, Animated, FlatList, InteractionManager,
  type StyleProp, type TextStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import FadeInView from '../components/FadeInView';
import LiveCardioMap from '../components/LiveCardioMap';
import RouteSummaryMap from '../components/RouteSummaryMap';
import PressableScale from '../components/PressableScale';
import PRCelebrationModal from '../components/PRCelebrationModal';
import ShareWorkoutModal from '../components/ShareWorkoutModal';
import GearPickerModal from '../components/GearPickerModal';
import type { GearItem } from '../services/api';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Live-workout layout animation. The 120ms ease used to be tuned for
// the rest-timer overlay where instant feedback mattered more than
// motion legibility — but on the exercise expand/collapse it was so
// short that on a real device the card just snaps. We now share the
// app's standard spring expand (350ms) so the body unfurls visibly
// and the demo thumbnail's size change reads as motion, not a cut.
import { configureExpandAnimation } from '../utils/layoutAnim';
function configureLiveLayoutAnimation() {
  try {
    configureExpandAnimation(320);
  } catch {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  }
}
// Lazy reference — keeps expo-image-picker out of the cold-start parse pass.
// First ImagePicker.X access triggers require(); cached after. Every callsite
// is already async (camera/library picks always are).
const ImagePicker: typeof import('expo-image-picker') = (() => {
  let mod: any = null;
  return new Proxy({} as any, {
    get: (_t, prop) => {
      if (!mod) mod = require('expo-image-picker');
      return mod[prop as string];
    },
  });
})();
const SOCIAL_WORKOUT_POSTS_ENABLED = true;
const SHARE_WORKOUT_MODAL_OPEN_DELAY_MS = 360;
const WATCH_COMMAND_START_GRACE_MS = 5000;
const WATCH_FULL_SYNC_COOLDOWN_MS = 5_000;
type WorkoutSidecarTask = { run: () => Promise<void> | void; detached?: boolean };
type CompletionSyncState = 'idle' | 'syncing' | 'synced' | 'queued';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as FileSystem from 'expo-file-system';
import ViewShot from 'react-native-view-shot';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle } from 'react-native-svg';
import { WorkoutDay, WorkoutSession, SessionExercise, CompletedSet, WorkoutSummary, AppThemeName, WorkoutFeeling, WorkoutIntensity, SavedWorkoutTemplate, UserProfile, PlannedSet, CustomExerciseItem, ActivityIntensity, ManualActivityDetails } from '../types';
import { saveWorkoutSession, getLastSetsForExercise, dateKey, saveWorkoutSummary, updateWorkoutSummary, saveHealthSummary, saveHealthScore, isAppleHealthEnabled, loadWorkoutHistory, loadHealthSummary, savePreservedCompletedWorkout, getExerciseBests, loadWorkoutTemplates, upsertWorkoutTemplate, exerciseHistoryEntriesMatch } from '../utils/workoutHistory';
import {
  getAppleWorkoutCaloriesForWindow,
  getLatestHeartRate,
  getWorkoutHrSummary,
  isHealthKitAvailable,
  readHealthSummary,
} from '../services/appleHealth';
import { calculateHealthScore } from '../utils/healthScore';
import { findMatchingGearForSession } from '../utils/gearSessionMatching';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getWeightRecommendation, logWorkoutDone, logWorkoutStarted, askWorkoutQuestion, analyzeWorkoutFormPhoto, getExercises, getWorkoutSummary, searchExerciseAI, analyzeExercisePhoto, AIExerciseResult, getAiWarmup, getPreSetRecommendation, getRecommendationAiSafetyStatus, syncInProgressWorkout, PRAchievement, getHRZones, HRZone, listWorkoutSessions, getHydration, logHydration, logHydrationDelta, getE1RM, type E1RMEstimate, type RecommendationAiSafety, type WorkoutPostSummary, type WorkoutSessionRecord, type WorkoutSessionExerciseRecord, type WorkoutSessionSetRecord } from '../services/api';
import { getExerciseImage } from '../utils/exerciseImages';
import { exerciseThumbSmall } from '../utils/exerciseThumb';
import { moveKitDemoVideo } from '../utils/exerciseDemo';
import LiveExerciseDemoThumb from '../components/LiveExerciseDemoThumb';
import ExerciseThumbMedia, { hasExerciseThumbMedia } from '../components/ExerciseThumbMedia';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import { completeWorkoutWithOfflineQueue, enqueueWorkoutCompletion, updatePendingWorkoutCompletionFeedback, type WorkoutCompletionRequest } from '../utils/workoutCompletionQueue';
import { workoutSessionCountsForPlan } from '../utils/workoutCompletion';
import { activityFromFocus, estimateRouteElevationGainFt, type RouteCoord } from '../utils/cardioGpsTracker';
import { cardioContextAllowsOutdoorData, isSetlessCardioExercise } from '../utils/cardioDisplay';
import { hydrationTargetRangeOz } from '../utils/hydration';
import * as Notifications from 'expo-notifications';
import SearchInput from '../components/SearchInput';
import FormVideoModal from '../components/FormVideoModal';
import CustomExerciseModal from '../components/CustomExerciseModal';
import { getEquipmentImageSource, equipmentDisplayName } from '../utils/equipmentImages';
import SwipeableRow, { type SwipeAction } from '../components/SwipeableRow';
import RestTimerPanel from '../components/RestTimerPanel';
import WorkoutDurationChip from '../components/WorkoutDurationChip';
import SetLogBadge from '../components/SetLogBadge';
import PlateCalculatorModal from '../components/PlateCalculatorModal';
import SetEntryModal from '../components/SetEntryModal';
import GuidedFlowView from '../components/GuidedFlowView';
import StartCountdownOverlay from '../components/StartCountdownOverlay';
import CompletionBurst from '../components/CompletionBurst';
import WorkoutTimerModal, { TimerResult } from '../components/WorkoutTimerModal';
import { ScoreInfoModal, ScoreInfoSection, ScoreInfoBody, ScoreInfoRow } from '../components/ScoreInfoModal';
import { isWatchReachable } from '../utils/watchSync';
import { getActiveWatchSessionId, setActiveWatchSessionId } from '../utils/activeWatchSession';
import { drainActiveWatchCommands, setActiveWatchCommandConsumerMounted } from '../utils/watchCommandBacklog';
import { claimWatchCommand } from '../utils/watchCommandDedupe';
import { recordWatchCommandEvent } from '../utils/watchCommandProcessor';
import { WatchBridge } from '../../modules/thallo-watch-bridge';
import { cancelRestNotifications, scheduleRestNotifications, configureWorkoutNotifications, ensureWorkoutNotificationPermission } from '../utils/restNotifications';
import { humanizeToken } from '../utils/exerciseGuide';
import { matchesExerciseSearch } from '../utils/exerciseSearch';
import { preferredExerciseVideoEquipment } from '../utils/exerciseVideoSearch';
import { shouldHideWeight, shouldHideReps, formatDurationTarget, isGuideExercise } from '../utils/exerciseDisplay';
import { startRestActivity, updateRestActivity, getRestActivityState, endRestActivity, endAllActivities, getLastStartDiagnostic } from '../services/liveActivity';
import type { RestActivityState } from '../services/liveActivity';
import { exerciseEquipmentLabel, isExerciseUsableWithEquipment, MAX_SWAP_SCORE, rankWorkoutAddCandidates, scoreSwapCandidate, scoreWorkoutAddCandidate, workoutAddAlignmentPercent } from '../utils/swapScoring';
import { FREE_WORKOUT_TEMPLATE_LIMIT, canCreateWorkoutTemplate, tierOf } from '../utils/subscription';
import { compactSocialSetSummaries } from '../utils/socialWorkoutDetails';
import { estimateActivityCalories } from '../utils/activityEnergy';
import { estimateCyclingPowerWatts } from '../utils/cyclingPower';
import { hrZoneColorHex, liveActivityHrZoneFields, zoneForHeartRate } from '../utils/hrZones';
import { customExerciseToLibraryItem, normalizeExerciseNameKey } from '../utils/customExercises';
import {
  workoutSummaryBackgroundSource,
  workoutSummaryIconName,
  workoutSummaryIsCardioLike,
  workoutSummaryTypeLabel,
} from '../utils/workoutSummaryVisuals';
import { displayFocusForExercises, displayFocusForWorkout } from '../utils/workoutFocusDisplay';
import { buildWarmupPlan } from '../utils/workoutWarmup';
import { clearManagedInterval, restartManagedInterval, useManagedInterval } from '../hooks/useManagedInterval';
import {
  ACTIVE_WORKOUT_TIMERS_KEY,
  hasPersistedActiveWorkoutTimers,
  useActiveWorkoutTimers,
  useExerciseTimerElapsed,
  type ExerciseTimerState,
  type TimerTickSubscriber,
} from '../hooks/useActiveWorkoutTimers';
import {
  distanceSuffix,
  formatDistance,
  formatWeight,
  lbsToUnit,
  miToUnit,
  unitToLbs,
  unitToMi,
  weightSuffix,
  type DistanceUnit,
  type WeightUnit,
} from '../utils/units';
import {
  parseTargetRepMax,
  parseTargetRepMin,
  shouldPromptRir,
  shouldPromptUnderperformance,
} from '../utils/setQualityPrompts';

// Conversion constant local to this file. Lives in units.ts as a
// module-private; we mirror the value so we can convert pace
// (sec/km → sec/preferred-unit) without a dedicated helper.
// 1 km ≈ 0.6214 mi.
const MI_PER_KM_LOCAL = 0.6213711922;
const ACTIVE_EXERCISE_LIVE_ACTIVITY_KEY = '__active_exercise__';
const LIVE_WORKOUT_ACTIVITY_HORIZON_MS = 12 * 60 * 60 * 1000;
const ACTIVE_WORKOUT_PAUSED_AT_KEY = 'activeWorkoutPausedAtMs';
const ACTIVE_WORKOUT_PAUSED_ACCUM_MS_KEY = 'activeWorkoutPausedAccumMs';
const CARDIO_ACTIVITY_RAWS = new Set([
  37, // running
  52, // walking
  16, // hiking
  13, // cycling
  46, // swimming
  35, // rowing
  14, // elliptical
  41, // stairClimbing
  56, // stairs
  57, // stepTraining
  60, // mixedCardio
  63, // highIntensityIntervalTraining
  67, // cardioDance
  12, // crossTraining
  51, // volleyball
]);
const OUTDOOR_CARDIO_ACTIVITY_RAWS = new Set([37, 52, 16, 13]);

type ExerciseTimerElapsedTextProps = {
  timer: ExerciseTimerState | undefined;
  subscribeTimerTick: TimerTickSubscriber;
  style?: StyleProp<TextStyle>;
};

const ExerciseTimerElapsedText = React.memo(function ExerciseTimerElapsedText({
  timer,
  subscribeTimerTick,
  style,
}: ExerciseTimerElapsedTextProps) {
  const elapsed = useExerciseTimerElapsed(timer, subscribeTimerTick);
  const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
  const seconds = (elapsed % 60).toString().padStart(2, '0');
  return <Text style={style}>{minutes}:{seconds}</Text>;
});

type ExerciseTimerModalControlsProps = {
  timerKey: string;
  timer: ExerciseTimerState | undefined;
  subscribeTimerTick: TimerTickSubscriber;
  screenStyles: ReturnType<typeof createStyles>;
  themeColors: import('../constants/theme').ThemeColors;
  onStart: (key: string) => void;
  onStop: (key: string) => void;
  onReset: (key: string) => void;
  onDone: () => void;
};

const ExerciseTimerModalControls = React.memo(function ExerciseTimerModalControls({
  timerKey,
  timer,
  subscribeTimerTick,
  screenStyles,
  themeColors,
  onStart,
  onStop,
  onReset,
  onDone,
}: ExerciseTimerModalControlsProps) {
  const elapsed = useExerciseTimerElapsed(timer, subscribeTimerTick);
  const running = timer?.running ?? false;
  const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
  const seconds = (elapsed % 60).toString().padStart(2, '0');

  return (
    <>
      <Text style={[screenStyles.timerModalDigits, { color: running ? themeColors.primary : themeColors.textPrimary }]}>
        {minutes}:{seconds}
      </Text>
      <Text style={[screenStyles.timerModalStateHint, { color: themeColors.textMuted }]}>
        {running ? 'Running — screen can lock, timer keeps counting' : elapsed > 0 ? 'Paused' : 'Ready'}
      </Text>

      <View style={screenStyles.timerModalControls}>
        {running ? (
          <TouchableOpacity
            style={[screenStyles.timerModalBigBtn, { backgroundColor: '#E53935' }]}
            onPress={() => onStop(timerKey)}
            accessibilityRole="button"
            accessibilityLabel="Pause timer">
            <Text style={screenStyles.timerModalBigBtnText}>Pause</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[screenStyles.timerModalBigBtn, { backgroundColor: themeColors.primary }]}
            onPress={() => onStart(timerKey)}
            accessibilityRole="button"
            accessibilityLabel={elapsed > 0 ? 'Resume timer' : 'Start timer'}>
            <Text style={[screenStyles.timerModalBigBtnText, { color: getContrastingTextColor(themeColors.primary) }]}>
              {elapsed > 0 ? 'Resume' : 'Start'}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={screenStyles.timerModalSecondaryRow}>
        <TouchableOpacity
          style={[screenStyles.timerModalSecondaryBtn, { borderColor: themeColors.border }]}
          onPress={() => onReset(timerKey)}
          accessibilityRole="button"
          accessibilityLabel="Reset timer">
          <Text style={[screenStyles.timerModalSecondaryBtnText, { color: themeColors.textSecondary }]}>Reset</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[screenStyles.timerModalSecondaryBtn, { backgroundColor: themeColors.primary, borderColor: themeColors.primary }]}
          onPress={onDone}
          accessibilityRole="button"
          accessibilityLabel={elapsed > 0 ? 'Done with timer' : 'Close timer'}>
          <Text style={[screenStyles.timerModalSecondaryBtnText, { color: getContrastingTextColor(themeColors.primary), fontWeight: '800' }]}>
            {elapsed > 0 ? 'Done' : 'Close'}
          </Text>
        </TouchableOpacity>
      </View>
    </>
  );
});

function formatStepperNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Math.abs(rounded - Math.round(rounded)) < 0.001
    ? String(Math.round(rounded))
    : String(rounded);
}

function uniquePositiveInts(values: Array<number | null | undefined>): number[] {
  return Array.from(new Set(values.filter((n): n is number => Number.isFinite(Number(n)) && Number(n) > 0)));
}

function parsePositiveNumberInput(raw: string): number | null {
  const n = Number.parseFloat(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parsePositiveIntInput(raw: string): number | null {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function profileAgeFromStoredProfile(profile: any): number | null {
  const age = Number(profile?.physicalStats?.age ?? profile?.age ?? profile?.profile?.age ?? null);
  return Number.isFinite(age) && age > 0 ? age : null;
}

function isEstablishedPr(pr: PRAchievement): boolean {
  return Number(pr.old_value) > 0;
}

function loadIncrementForSessionExercise(ex: SessionExercise): number {
  const equipment = (ex.equipment ?? '').toLowerCase();
  if (/(bodyweight|body weight|\bnone\b|\bbw\b)/.test(equipment)) return 0;
  const primary = String(ex.primaryMuscle ?? ex.primary_muscle ?? '').toLowerCase();
  const pattern = String((ex as any).movementPattern ?? (ex as any).movement_pattern ?? '').toLowerCase();
  const isCompound = Boolean(ex.isCompound);
  const lowerBodyCompound = isCompound && (
    ['squat', 'hinge', 'lunge'].includes(pattern)
    || ['quads', 'hamstrings', 'glutes', 'adductors', 'abductors'].includes(primary)
  );
  if (/(barbell|trap bar|trap_bar|ez curl|ez_curl|landmine)/.test(equipment)) {
    return lowerBodyCompound ? 10 : 5;
  }
  if (/dumbbell/.test(equipment)) return isCompound ? 5 : 2.5;
  if (/(machine|cable|plate|leg press|leg_press|pulldown|smith)/.test(equipment)) {
    return isCompound ? 5 : 2.5;
  }
  return 5;
}

function isDumbbellLoadExercise(ex: { name?: string | null; equipment?: string | null } | null | undefined): boolean {
  const text = `${ex?.equipment ?? ''} ${ex?.name ?? ''}`.toLowerCase();
  return /\bdumbbell(s)?\b|\bdb\b/.test(text);
}

function isBarbellLoadExercise(ex: { name?: string | null; equipment?: string | null } | null | undefined): boolean {
  const text = `${ex?.equipment ?? ''} ${ex?.name ?? ''}`.toLowerCase();
  return /(barbell|trap.?bar|ez.?curl|landmine|olympic)/.test(text) && !/\bdumbbell|\bdb\b/.test(text);
}

function roundWarmupWeight(weightLbs: number, incrementLbs: number): number {
  if (!Number.isFinite(weightLbs) || weightLbs <= 0) return 0;
  const inc = incrementLbs > 0 ? incrementLbs : 5;
  return Math.max(0, Math.round(weightLbs / inc) * inc);
}

function buildWarmupSetSuggestions(ex: SessionExercise, anchorWeightLbs: number | null | undefined): CompletedSet[] {
  const anchor = Number(anchorWeightLbs ?? 0);
  const increment = loadIncrementForSessionExercise(ex);
  if (!Number.isFinite(anchor) || anchor <= 0 || increment <= 0) return [];
  if (shouldHideWeight({ name: ex.name, equipment: ex.equipment, reps: ex.targetReps })) return [];
  if (shouldHideReps({ name: ex.name, equipment: ex.equipment, reps: ex.targetReps })) return [];

  const barbell = isBarbellLoadExercise(ex);
  const rows: Array<{ weight: number; reps: number }> = [];
  if (barbell && anchor >= 95) rows.push({ weight: Math.min(45, anchor), reps: 10 });
  if (anchor >= 80) rows.push({ weight: roundWarmupWeight(anchor * 0.5, increment), reps: 6 });
  if (anchor >= 135) rows.push({ weight: roundWarmupWeight(anchor * 0.7, increment), reps: 3 });
  if (rows.length === 0) rows.push({ weight: roundWarmupWeight(anchor * 0.5, increment), reps: 8 });

  const seen = new Set<string>();
  return rows
    .filter(row => row.weight > 0 && row.weight < anchor * 0.98)
    .filter(row => {
      const key = `${row.weight}:${row.reps}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3)
    .map((row, idx) => ({
      setNumber: idx + 1,
      weightLbs: row.weight,
      reps: row.reps,
      setType: 'warmup',
    }));
}

function warmupSuggestionKey(set: Pick<CompletedSet, 'weightLbs' | 'reps'>): string {
  const weight = Number(set.weightLbs);
  const reps = Number(set.reps);
  return `${Number.isFinite(weight) ? weight : 0}:${Number.isFinite(reps) ? reps : 0}`;
}

function buildRirNextSetSuggestion(
  ex: SessionExercise,
  loggedSet: CompletedSet,
  rir: number,
  nextSetNumber: number,
  weightUnit: WeightUnit = 'lbs',
): { nextTarget: string; cue: string; watchText: string; fullText: string; weightLbs: number; repsText: string } | null {
  const weight = Number(loggedSet.weightLbs);
  if (!Number.isFinite(weight) || weight <= 0) return null;
  const increment = loadIncrementForSessionExercise(ex);
  const targetReps = ex.targetReps || `${loggedSet.reps}`;
  let nextWeight = weight;
  let cue = '';
  if (rir <= 1) {
    cue = 'You were close to failure. Repeat the load and protect form.';
  } else if (rir === 2) {
    cue = 'Strong set. Repeat this load and aim to own the same rep range.';
  } else if (rir === 3) {
    nextWeight = weight + increment * 2;
    cue = 'You had room in reserve. Add a small jump if setup feels locked in.';
  } else {
    nextWeight = weight + increment * 2;
    cue = 'That was clearly under target effort. Add load on the next set.';
  }
  const baseDisplayWeight = formatWeight(nextWeight, weightUnit, {
    precision: undefined,
  });
  const displayWeight = isDumbbellLoadExercise(ex) ? `${baseDisplayWeight} each` : baseDisplayWeight;
  const nextTarget = `Set ${nextSetNumber}: ${displayWeight} x ${targetReps}`;
  return {
    nextTarget,
    cue,
    watchText: `${displayWeight} x ${targetReps} - ${cue}`,
    fullText: `${nextTarget} — ${cue}`,
    weightLbs: nextWeight,
    repsText: String(targetReps),
  };
}

/** Shared display helper for equipment strings. Splits on commas so
 *  multi-equipment values like "barbell, flat_bench" become
 *  "Barbell, Flat Bench" instead of the raw planner output. */
function formatEquipmentLabel(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .split(',')
    .map(part => humanizeToken(part.trim()))
    .filter(Boolean)
    .join(', ');
}

function detectTimerMode(targetReps: string | undefined, setType: string | undefined): 'amrap' | 'emom' | 'tabata' | null {
  const text = `${targetReps ?? ''} ${setType ?? ''}`.toLowerCase();
  if (/tabata/.test(text)) return 'tabata';
  if (/emom/.test(text)) return 'emom';
  if (/amrap/.test(text) || /as\s*many/.test(text)) return 'amrap';
  return null;
}

interface WorkoutCoachMessage {
  role: 'user' | 'assistant';
  content: string;
  imageBase64?: string;
  imageMime?: string;
}

const COACH_PROMPT_OPTIONS: Array<{ label: string; template: (exerciseName: string) => string }> = [
  { label: 'Form question', template: (name) => `Form check on ${name}: what 2-3 cues should I focus on next set?` },
  { label: 'Injury/pain', template: (name) => `I feel pain/discomfort during ${name}. What should I adjust right now?` },
  { label: 'Not feeling target', template: (name) => `I am not feeling ${name} in the target muscle. How should I fix setup and execution?` },
  { label: 'Lacking intensity', template: (name) => `This ${name} set feels too easy. Should I adjust reps, tempo, rest, or load?` },
];

interface ExerciseLibraryItem {
  id?: number | string;
  name: string;
  slug?: string | null;
  equipment?: string | null;
  gear?: Array<{ slug: string; name: string; category?: string; required?: boolean; role?: string | null }> | null;
  primary_muscle?: string | null;
  secondary_muscles?: string[] | null;
  /** See HomeScreen.ExerciseLibraryItem.emphasis — same field, display only. */
  emphasis?: string[] | null;
  is_compound?: boolean | null;
  movement_pattern?: string | null;
  description?: string | null;
  image_url?: string | null;
  video_id?: string | null;
  is_custom?: boolean;
  aliases?: string[] | null;
  flow_category?: string | null;
  demo_exercise_db_id?: string | null;
  sets?: number;
  reps?: string;
  rest_seconds?: number;
  form_cues?: string[] | null;
}

function exerciseLibraryItemFromAiResult(ex: AIExerciseResult, id?: number | string): ExerciseLibraryItem {
  return {
    ...(id != null ? { id } : {}),
    name: ex.name,
    primary_muscle: ex.primary_muscle as any,
    secondary_muscles: (ex.secondary_muscles ?? []) as any,
    equipment: ex.equipment as any,
    description: ex.why,
    is_custom: true,
    video_id: ex.video_id ?? undefined,
    image_url: ex.image_url ?? undefined,
    is_compound: ex.is_compound ?? undefined,
    movement_pattern: ex.movement_pattern ?? undefined,
    sets: ex.sets,
    reps: ex.reps,
    rest_seconds: ex.rest_seconds,
    form_cues: ex.form_cues ?? undefined,
    demo_exercise_db_id: ex.demo_exercise_db_id ?? undefined,
    // Carry aliases through so future text searches against this freshly
    // imported exercise match common abbreviations the AI surfaced
    // (matchesExerciseSearch already reads aliases[] from the haystack).
    aliases: ex.aliases ?? undefined,
  } as unknown as ExerciseLibraryItem;
}

function customExerciseItemFromAiResult(ex: AIExerciseResult, id: string): CustomExerciseItem {
  return {
    id,
    name: ex.name,
    primary_muscle: ex.primary_muscle,
    secondary_muscles: ex.secondary_muscles ?? [],
    equipment: ex.equipment,
    movement_pattern: ex.movement_pattern ?? null,
    image_url: ex.image_url ?? null,
    video_id: ex.video_id ?? null,
    demo_exercise_db_id: ex.demo_exercise_db_id ?? null,
    is_compound: ex.is_compound ?? null,
    sets: ex.sets,
    reps: ex.reps,
    rest_seconds: ex.rest_seconds,
    description: ex.why,
    form_cues: ex.form_cues,
    aliases: ex.aliases ?? [],
    source: 'ai',
    createdAt: new Date().toISOString(),
  };
}

function exerciseLibraryItemFromCustomExercise(ce: CustomExerciseItem): ExerciseLibraryItem {
  return customExerciseToLibraryItem(ce) as ExerciseLibraryItem;
}

async function loadCustomExerciseLibraryItems(): Promise<ExerciseLibraryItem[]> {
  try {
    const raw = await AsyncStorage.getItem('userProfile');
    if (!raw) return [];
    const prof = JSON.parse(raw);
    if (!Array.isArray(prof?.customExercises)) return [];
    return (prof.customExercises as CustomExerciseItem[])
      .map(exerciseLibraryItemFromCustomExercise);
  } catch {
    return [];
  }
}

function mergeCustomExerciseLibraryRows(
  customs: ExerciseLibraryItem[],
  rows: ExerciseLibraryItem[],
): ExerciseLibraryItem[] {
  const out: ExerciseLibraryItem[] = [];
  const seen = new Set<string>();
  for (const item of [...customs, ...rows]) {
    const key = normalizeExerciseNameKey(item.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

type SmartSwapItem = ExerciseLibraryItem & { _overlap?: number; _alignment?: number; _fitScore?: number; _swapNotes?: string[] };
type ExerciseHistorySignal = { count: number; lastDate?: string };
type LiveRecommendationCue = {
  text: string;
  nextTarget?: string | null;
  cue?: string | null;
  recommendedWeightLbs?: number | null;
  recommendedReps?: string | null;
  source?: 'backend' | 'local_fallback' | 'preset' | 'bodyweight' | 'free_fallback' | string;
  trace?: Record<string, any> | null;
};

function shouldHoldAiSafetyRecommendation(aiSafety?: RecommendationAiSafety | null): boolean {
  if (!aiSafety) return false;
  if (aiSafety.shouldHold === true) return true;
  return aiSafety.status === 'review' || aiSafety.verdict === 'review';
}

const waitForRecommendationSafetyPoll = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const SMART_SWAP_HISTORY_BONUS_MAX = 5;
const SMART_SWAP_MAX_SCORE = MAX_SWAP_SCORE + SMART_SWAP_HISTORY_BONUS_MAX;

function normalizeSwapText(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function exerciseHistoryKey(name: string): string {
  return normalizeSwapText(name);
}

function exerciseNameKeySet(names: Array<string | null | undefined>): Set<string> {
  return new Set(names.map(normalizeSwapText).filter(Boolean));
}

function filterBlockedAiExerciseResults(
  results: AIExerciseResult[],
  blockedNames: Set<string>,
): AIExerciseResult[] {
  if (blockedNames.size === 0) return results;
  return results.filter(ex => !blockedNames.has(normalizeSwapText(ex.name)));
}

function exerciseMatchesMuscleFilter(item: ExerciseLibraryItem, muscleFilter: string): boolean {
  if (muscleFilter === 'all') return true;
  const target = normalizeSwapText(muscleFilter);
  if (!target) return true;
  const muscles = [
    item.primary_muscle,
    ...(item.secondary_muscles ?? []),
  ];
  return muscles.some(muscle => normalizeSwapText(muscle) === target);
}

function exercisePickerTestId(item: ExerciseLibraryItem): string {
  const raw = item.slug || item.name;
  const slug = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `active-exercise-option-${slug || 'exercise'}`;
}

function exerciseAlignmentColor(value: number | null | undefined): string | undefined {
  if (value == null) return undefined;
  if (value >= 80) return '#22C55E';
  if (value >= 60) return '#F59E0B';
  return '#EF4444';
}

function ExerciseAlignmentBadge({ value }: { value: number }) {
  const color = exerciseAlignmentColor(value);
  if (!color) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: color + '22', borderWidth: 1, borderColor: color + '88' }}>
      <View style={{ width: 28, height: 4, borderRadius: 2, backgroundColor: color + '33', overflow: 'hidden' }}>
        <View style={{ width: `${value}%`, height: '100%', backgroundColor: color }} />
      </View>
      <Text style={{ fontSize: 10, fontWeight: '800', color }}>{value}%</Text>
    </View>
  );
}

type BackendLastSetsContext = {
  workoutDate: string;
  focus?: string;
};

function workoutSessionHistoryTime(session: WorkoutSessionRecord): number {
  const raw = session.completed_at ?? session.created_at ?? `${session.workout_date}T00:00:00Z`;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isCurrentWorkoutSession(session: WorkoutSessionRecord, context: BackendLastSetsContext): boolean {
  const sessionDate = String(session.workout_date ?? '').slice(0, 10);
  if (!sessionDate || sessionDate !== context.workoutDate) return false;
  if (!context.focus) return true;
  return normalizeSwapText(session.focus) === normalizeSwapText(context.focus);
}

function canUseBackendHistorySession(session: WorkoutSessionRecord, context: BackendLastSetsContext): boolean {
  if (isCurrentWorkoutSession(session, context)) return false;
  const sessionDate = String(session.workout_date ?? '').slice(0, 10);
  if (sessionDate === context.workoutDate && !session.completed_at) return false;
  return true;
}

function backendExerciseMatches(exercise: SessionExercise, record: WorkoutSessionExerciseRecord): boolean {
  const plannedSlug = String(exercise.slug ?? '').trim().toLowerCase();
  const loggedSlug = String(record.exercise_slug_snapshot ?? '').trim().toLowerCase();
  if (plannedSlug && loggedSlug && plannedSlug === loggedSlug) return true;
  return exerciseHistoryEntriesMatch(
    { name: record.name, equipment: record.equipment, slug: loggedSlug || null },
    exercise,
  );
}

function backendSetToCompletedSet(set: WorkoutSessionSetRecord, index: number, session?: WorkoutSessionRecord): CompletedSet | null {
  if (set.completed === false) return null;
  const setType = normalizeCompletedSetType(set.set_type);
  const reps = Number(set.actual_reps ?? 0);
  const weightLbs = Number(set.actual_weight_lbs ?? 0);
  const durationSeconds = set.duration_seconds == null ? undefined : Number(set.duration_seconds);
  const hasWork =
    (Number.isFinite(reps) && reps > 0) ||
    (Number.isFinite(weightLbs) && weightLbs > 0) ||
    (durationSeconds != null && Number.isFinite(durationSeconds) && durationSeconds > 0);
  if (!hasWork) return null;

  const setNumber = Number(set.set_number);
  const completed: CompletedSet = {
    setNumber: setType === 'warmup'
      ? index + 1
      : Number.isFinite(setNumber) && setNumber > 0 ? setNumber : index + 1,
    reps: Number.isFinite(reps) ? reps : 0,
    weightLbs: Number.isFinite(weightLbs) ? weightLbs : 0,
  };
  if (setType) completed.setType = setType as CompletedSet['setType'];
  if (session?.workout_date) completed.sessionDate = session.workout_date;
  if (session?.completed_at) completed.completedAt = session.completed_at;
  if (durationSeconds != null && Number.isFinite(durationSeconds) && durationSeconds > 0) {
    completed.durationSeconds = durationSeconds;
  }
  const rir = Number(set.actual_rir);
  if (Number.isFinite(rir)) completed.rir = rir;
  const comfortRating = Number(set.comfort_rating);
  if (Number.isFinite(comfortRating) && comfortRating > 0) completed.comfortRating = comfortRating;
  const actualDistance = Number(set.actual_distance);
  if (Number.isFinite(actualDistance) && actualDistance > 0) completed.actualDistance = actualDistance;
  if (set.actual_pace) completed.actualPace = set.actual_pace;
  const heartRateAvg = Number(set.heart_rate_avg);
  if (Number.isFinite(heartRateAvg) && heartRateAvg > 0) completed.heartRateAvg = heartRateAvg;
  if (set.cardio_metrics) completed.cardioMetrics = set.cardio_metrics;
  return completed;
}

function findLastSetsInBackendSessions(
  exercise: SessionExercise,
  sessions: WorkoutSessionRecord[],
  context: BackendLastSetsContext,
): CompletedSet[] | null {
  const sorted = [...sessions].sort((a, b) => workoutSessionHistoryTime(b) - workoutSessionHistoryTime(a));
  for (const session of sorted) {
    if (!canUseBackendHistorySession(session, context)) continue;
    for (const record of session.exercises ?? []) {
      if (!backendExerciseMatches(exercise, record)) continue;
      const sets = (record.sets ?? [])
        .map((set, idx) => backendSetToCompletedSet(set, idx, session))
        .filter((set): set is CompletedSet => !!set && set.setType !== 'warmup')
        .filter((set): set is CompletedSet => !!set);
      if (sets.length > 0) return sets;
    }
  }
  return null;
}

async function loadLastSetsForExerciseAnySource(
  exercise: SessionExercise,
  backendSessions: () => Promise<WorkoutSessionRecord[]>,
  context: BackendLastSetsContext,
): Promise<CompletedSet[]> {
  const localSets = await getLastSetsForExercise(exercise).catch(() => null);
  if (localSets && localSets.length > 0) return localSets;
  const sessions = await backendSessions().catch(() => []);
  return findLastSetsInBackendSessions(exercise, sessions, context) ?? [];
}

function exerciseSlotRole(ex: Partial<SessionExercise> | any): string {
  return String(ex?.slotRole ?? ex?.slot_role ?? ex?._role ?? '').toLowerCase();
}

// Guided flow detection — every exercise is a timed pose AND has a
// flow_category tag. Strength days with a single mobility drill in a
// slot will NOT match (the drill won't have a flow_category), keeping
// regular workouts in standard render mode.
const _GUIDED_FLOW_PRESCRIPTIONS = new Set([
  'yoga_flow',
  'stretch_hold',
  'mobility',
]);

function exerciseFlowCategory(ex: Partial<SessionExercise> | any): string | null {
  const fc = ex?.flowCategory ?? ex?.flow_category ?? null;
  return typeof fc === 'string' && fc.length > 0 ? fc : null;
}

function isGuidedFlowSession(workout: { exercises?: SessionExercise[] | any[] } | null | undefined): boolean {
  const exs = workout?.exercises ?? [];
  if (!Array.isArray(exs) || exs.length === 0) return false;
  for (const ex of exs) {
    const ptype = String(ex?.prescriptionType ?? ex?.prescription_type ?? '').toLowerCase();
    if (!_GUIDED_FLOW_PRESCRIPTIONS.has(ptype)) return false;
    if (!exerciseFlowCategory(ex)) return false;
  }
  return true;
}

function isCoreCircuitExercise(ex: Partial<SessionExercise> | any): boolean {
  const role = exerciseSlotRole(ex);
  const prescription = String(ex?.prescriptionType ?? ex?.prescription_type ?? '').toLowerCase();
  const primary = String(ex?.primaryMuscle ?? ex?.primary_muscle ?? ex?._primary_muscle ?? '').toLowerCase();
  if (['warmup', 'mobility', 'recovery', 'stretch', 'cooldown'].includes(role)) return false;
  return role === 'core' || prescription === 'core_circuit' || prescription.includes('core') || primary === 'core';
}

function coreCircuitRunAt(exercises: SessionExercise[], index: number): number[] {
  if (!isCoreCircuitExercise(exercises[index])) return [];
  let start = index;
  while (start > 0 && isCoreCircuitExercise(exercises[start - 1])) start -= 1;
  let end = index;
  while (end + 1 < exercises.length && isCoreCircuitExercise(exercises[end + 1])) end += 1;
  if (end - start + 1 < 2) return [];
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}

function isStretchBlockExercise(ex: Partial<SessionExercise> | any): boolean {
  if (!ex) return false;
  const fc = (ex as any)?.flowCategory ?? (ex as any)?.flow_category;
  if (typeof fc === 'string' && fc.length > 0) return true;
  const ptype = String(ex?.prescriptionType ?? ex?.prescription_type ?? '').toLowerCase();
  return ptype === 'stretch_hold' || ptype === 'yoga_flow';
}

function stretchBlockRunAt(exercises: SessionExercise[], index: number): number[] {
  if (!isStretchBlockExercise(exercises[index])) return [];
  let start = index;
  while (start > 0 && isStretchBlockExercise(exercises[start - 1])) start -= 1;
  let end = index;
  while (end + 1 < exercises.length && isStretchBlockExercise(exercises[end + 1])) end += 1;
  if (end - start + 1 < 2) return [];
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}

function hasCoreCircuit(exercises: SessionExercise[]): boolean {
  return exercises.some(isCoreCircuitExercise);
}

function extractActiveInjuryTokens(profile: any): string[] {
  const tokens = new Set<string>();
  const entries = Array.isArray(profile?.injuryEntries) ? profile.injuryEntries : [];
  for (const entry of entries) {
    if (String(entry?.status ?? '').toLowerCase() === 'resolved') continue;
    [entry?.bodyPart, entry?.description, ...(Array.isArray(entry?.muscleGroups) ? entry.muscleGroups : [])]
      .map(normalizeSwapText)
      .filter(Boolean)
      .forEach(token => tokens.add(token));
  }
  if (typeof profile?.injuries === 'string' && profile.injuries.trim()) {
    normalizeSwapText(profile.injuries)
      .split(' ')
      .filter(Boolean)
      .forEach(token => tokens.add(token));
    tokens.add(normalizeSwapText(profile.injuries));
  }
  return Array.from(tokens);
}

function exerciseRiskText(item: ExerciseLibraryItem): string {
  return normalizeSwapText([
    item.name,
    item.primary_muscle,
    ...(item.secondary_muscles ?? []),
    item.movement_pattern,
    item.equipment,
    item.description,
  ].join(' '));
}

function candidateConflictsWithActiveInjuries(item: ExerciseLibraryItem, injuryTokens: string[]): boolean {
  if (injuryTokens.length === 0) return false;
  const injuries = normalizeSwapText(injuryTokens.join(' '));
  const text = exerciseRiskText(item);
  if (/(shoulder|rotator|neck)/.test(injuries) && /(overhead|shoulder|press|dip|upright row|snatch|jerk|lateral raise)/.test(text)) return true;
  if (/(low back|lower back|lumbar|back)/.test(injuries) && /(deadlift|hinge|good morning|barbell row|back extension|clean|snatch)/.test(text)) return true;
  if (/(knee|patella)/.test(injuries) && /(squat|lunge|split squat|leg press|step up|jump|sprint|running|plyo)/.test(text)) return true;
  if (/(hip|groin)/.test(injuries) && /(deep squat|lunge|split squat|hip thrust|good morning|deadlift|hinge|sprint)/.test(text)) return true;
  if (/(ankle|foot|achilles)/.test(injuries) && /(run|running|sprint|jump|plyo|calf|box jump|skipping|jump rope)/.test(text)) return true;
  if (/(elbow|wrist|forearm)/.test(injuries) && /(curl|skull|extension|pushdown|dip|chin up|pull up|bench|press)/.test(text)) return true;
  return false;
}

function buildSwapNotes(
  item: ExerciseLibraryItem,
  base: ExerciseLibraryItem | null,
  historySignal: ExerciseHistorySignal | undefined,
  injuryTokens: string[],
): string[] {
  const notes: string[] = [];
  if (base?.primary_muscle && item.primary_muscle && normalizeSwapText(base.primary_muscle) === normalizeSwapText(item.primary_muscle)) {
    notes.push('Same primary muscle');
  } else if (base?.movement_pattern && item.movement_pattern && normalizeSwapText(base.movement_pattern) === normalizeSwapText(item.movement_pattern)) {
    notes.push('Same pattern');
  }
  if (historySignal?.count) {
    notes.push(historySignal.count > 1 ? `${historySignal.count}x logged` : 'Logged before');
  }
  if (injuryTokens.length > 0) {
    notes.push('Clears injury flags');
  }
  notes.push('Equipment-ready');
  return notes.slice(0, 3);
}

const ActiveExercisePickerRow = React.memo(function ActiveExercisePickerRow({
  item,
  swapMode,
  stylesRef,
  onPress,
  onPreview,
}: {
  item: SmartSwapItem;
  swapMode: boolean;
  stylesRef: ReturnType<typeof createStyles>;
  onPress: (item: ExerciseLibraryItem) => void;
  onPreview?: (item: ExerciseLibraryItem) => void;
}) {
  const fitPercent = swapMode ? item._overlap : item._alignment;
  const fitLabel = swapMode ? 'overlap' : 'alignment';
  const noteColor = exerciseAlignmentColor(fitPercent) ?? '#22C55E';
  const thumbSrc = exerciseThumbSmall(item as any);
  const demoExerciseDbId = (item as any).demo_exercise_db_id ?? null;
  const hasThumb = hasExerciseThumbMedia({
    exerciseName: item.name,
    demoExerciseDbId,
    fallbackSource: thumbSrc,
  });
  const showPreview = swapMode && !!onPreview;
  return (
    <TouchableOpacity
      style={stylesRef.addExerciseItem}
      testID={exercisePickerTestId(item)}
      accessibilityLabel={`${swapMode ? 'Swap to' : 'Add'} ${item.name}${fitPercent != null ? `, ${fitPercent}% ${fitLabel}` : ''}`}
      onPress={() => onPress(item)}>
      {showPreview && (
        <TouchableOpacity
          activeOpacity={0.85}
          style={stylesRef.addExercisePreview}
          onPress={(e) => {
            e.stopPropagation();
            onPreview?.(item);
          }}
          accessibilityRole="button"
          accessibilityLabel={`Preview ${item.name} form video`}>
          {hasThumb ? (
            <ExerciseThumbMedia
              exerciseName={item.name}
              demoExerciseDbId={demoExerciseDbId}
              fallbackSource={thumbSrc}
              style={stylesRef.addExercisePreviewImage}
              shouldPlayVideo={false}
            />
          ) : (
            <View style={stylesRef.addExercisePreviewFallback}>
              <Ionicons name="videocam-outline" size={16} color="#6B7280" />
            </View>
          )}
          <View pointerEvents="none" style={stylesRef.addExercisePreviewBadge}>
            <Ionicons name="play" size={9} color="#fff" style={{ marginLeft: 1 }} />
          </View>
        </TouchableOpacity>
      )}
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text style={stylesRef.addExerciseName}>{item.name}</Text>
          {fitPercent != null && <ExerciseAlignmentBadge value={fitPercent} />}
        </View>
        <Text style={stylesRef.addExerciseMeta}>
          {humanizeToken(item.primary_muscle) || 'General'} · {formatEquipmentLabel(item.equipment) || 'Bodyweight'}
          {item.is_compound != null ? (item.is_compound ? ' · Compound' : ' · Isolation') : ''}
        </Text>
        {swapMode && item._swapNotes && item._swapNotes.length > 0 && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
            {item._swapNotes.map(note => (
              <Text
                key={note}
                style={{
                  fontSize: 10,
                  fontWeight: '700',
                  color: noteColor,
                  backgroundColor: noteColor + '14',
                  borderRadius: 999,
                  paddingHorizontal: 7,
                  paddingVertical: 3,
                }}>
                {note}
              </Text>
            ))}
          </View>
        )}
      </View>
      <Text style={stylesRef.addExerciseUse}>{swapMode ? 'Swap' : 'Add'}</Text>
    </TouchableOpacity>
  );
});

interface ActiveWorkoutScreenProps {
  authToken: string;
  workout: WorkoutDay;
  goal: string;
  themeName?: AppThemeName;
  profileGender?: UserProfile['physicalStats']['gender'];
  weightLbs?: number;
  weightUnit?: WeightUnit;
  distanceUnit?: DistanceUnit;
  playStartCountdown?: boolean;
  onFinish: (session: WorkoutSession) => void;
  onCancel: () => void;
  onDislikeExercise?: (exerciseName: string) => void;
  onProfileUpdate?: (changes: Partial<UserProfile>, skipRegen?: boolean) => void | Promise<void>;
}

type ClearRestStateOptions = {
  pushToWatch?: boolean;
  endAllLiveActivities?: boolean;
};

type FinishRestTimerOptions = {
  playForegroundAlert?: boolean;
  cancelNotifications?: boolean;
};

type SetInputDraft = { weight: string; reps: string; duration: string };

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function formatSummaryDuration(seconds: number): string {
  const totalMinutes = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${Math.max(1, totalMinutes)}m`;
}

type SummaryMetricTone = 'good' | 'warn' | 'bad' | 'neutral';
type SummaryMetric = {
  key: string;
  icon: string;
  value: string;
  label: string;
  hint: string;
  tone: SummaryMetricTone;
};

function pctTone(pct: number | null | undefined): SummaryMetricTone {
  if (pct == null || !Number.isFinite(pct)) return 'neutral';
  if (pct >= 90) return 'good';
  if (pct >= 65) return 'warn';
  return 'bad';
}

function pctHint(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return 'Logged';
  if (pct >= 90) return 'On plan';
  if (pct >= 65) return 'Short';
  return 'Low';
}

function scoreTone(score: number | null | undefined): SummaryMetricTone {
  if (score == null || !Number.isFinite(score)) return 'neutral';
  if (score >= 75) return 'good';
  if (score >= 55) return 'warn';
  return 'bad';
}

function durationTone(actualSeconds: number, estimatedSeconds: number | null): SummaryMetricTone {
  if (!estimatedSeconds || !Number.isFinite(estimatedSeconds) || estimatedSeconds <= 0) return 'neutral';
  const ratio = actualSeconds / estimatedSeconds;
  if (ratio >= 0.85 && ratio <= 1.35) return 'good';
  if (ratio >= 0.65) return 'warn';
  return 'bad';
}

function durationHint(actualSeconds: number, estimatedSeconds: number | null): string {
  if (!estimatedSeconds || !Number.isFinite(estimatedSeconds) || estimatedSeconds <= 0) return 'Done';
  const ratio = actualSeconds / estimatedSeconds;
  if (ratio >= 0.85 && ratio <= 1.35) return 'On plan';
  if (ratio < 0.85) return 'Short';
  return 'Long';
}

function summaryToneColor(tone: SummaryMetricTone): string {
  if (tone === 'good') return '#34D399';
  if (tone === 'warn') return '#FBBF24';
  if (tone === 'bad') return '#FB7185';
  return 'rgba(255,255,255,0.68)';
}

function summaryToneBorderColor(tone: SummaryMetricTone): string {
  if (tone === 'neutral') return 'rgba(255,255,255,0.2)';
  return `${summaryToneColor(tone)}88`;
}

function formatCompactLoad(lbs: number, unit: WeightUnit): string {
  const value = lbsToUnit(lbs, unit);
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (Math.abs(value) >= 10000) return `${(value / 1000).toFixed(1)}k ${weightSuffix(unit)}`;
  if (Math.abs(value) >= 1000) return `${Math.round(value).toLocaleString('en-US')} ${weightSuffix(unit)}`;
  return formatWeight(lbs, unit, { precision: value >= 100 ? 0 : 1 });
}

type SummaryVolumeStatus = {
  hint: string;
  tone: SummaryMetricTone;
};

function loadedVolumeLbsFromExercises(exercises: Array<{ sets?: Array<Partial<CompletedSet> & Record<string, any>> }>): number {
  return exercises.reduce(
    (total, ex) => total + (ex.sets ?? []).reduce((setTotal, set) => {
      const reps = Number(set.reps ?? 0);
      const weight = Number(set.weightLbs ?? set.weight_lbs ?? 0);
      if (!Number.isFinite(reps) || !Number.isFinite(weight) || reps <= 0 || weight <= 0) return setTotal;
      return setTotal + reps * weight;
    }, 0),
    0,
  );
}

function plannedVolumeLbsFromExercises(
  exercises: Array<{
    targetSets?: number | null;
    targetReps?: string | number | null;
    targetWeightLbs?: number | null;
    setScheme?: PlannedSet[] | null;
  }>,
): number | null {
  let total = 0;
  let hasLoadTarget = false;
  for (const ex of exercises) {
    const fallbackReps = ex.targetReps ?? null;
    const fallbackWeight = Number(ex.targetWeightLbs ?? 0);
    const scheme = Array.isArray(ex.setScheme) ? ex.setScheme : [];
    if (scheme.length > 0) {
      let schemeHadLoadTarget = false;
      for (const set of scheme) {
        const reps = parseTargetRepMax(set.targetReps ?? fallbackReps);
        const weight = Number(set.targetWeightLbs ?? ex.targetWeightLbs ?? 0);
        if (!Number.isFinite(weight) || weight <= 0 || reps == null || reps <= 0) continue;
        total += reps * weight;
        hasLoadTarget = true;
        schemeHadLoadTarget = true;
      }
      if (schemeHadLoadTarget) continue;
    }
    const reps = parseTargetRepMax(fallbackReps);
    if (!Number.isFinite(fallbackWeight) || fallbackWeight <= 0 || reps == null || reps <= 0) continue;
    total += getExerciseTargetSetCount(ex as any) * reps * fallbackWeight;
    hasLoadTarget = true;
  }
  return hasLoadTarget ? total : null;
}

function summaryVolumeStatus(
  actualVolumeLbs: number,
  expectedVolumeLbs: number | null,
  setCompletionPct: number | null,
): SummaryVolumeStatus {
  if (!Number.isFinite(actualVolumeLbs) || actualVolumeLbs <= 0) {
    return { hint: 'No loaded volume', tone: 'bad' };
  }
  if (expectedVolumeLbs != null && Number.isFinite(expectedVolumeLbs) && expectedVolumeLbs > 0) {
    const ratio = actualVolumeLbs / expectedVolumeLbs;
    if (ratio >= 1.08) return { hint: "Above today's plan", tone: 'good' };
    if (ratio >= 0.9) return { hint: "On today's plan", tone: 'good' };
    if (ratio >= 0.72) return { hint: 'A little under plan', tone: 'warn' };
    return { hint: "Under today's plan", tone: 'bad' };
  }
  if (setCompletionPct != null && Number.isFinite(setCompletionPct)) {
    if (setCompletionPct >= 90) return { hint: "On today's plan", tone: 'good' };
    if (setCompletionPct >= 65) return { hint: 'A little under plan', tone: 'warn' };
    return { hint: "Under today's plan", tone: 'bad' };
  }
  return { hint: "Today's volume logged", tone: 'neutral' };
}

function getTargetSetCount(targetSets: unknown): number {
  const parsed = Number(targetSets);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return 3;
}

function getExerciseTargetSetCount(exercise: Pick<SessionExercise, 'targetSets' | 'name' | 'equipment' | 'targetReps'> & Record<string, any> | null | undefined): number {
  if (!exercise) return 0;
  if (isSetlessCardioExercise(exercise)) return 0;
  return getTargetSetCount(exercise.targetSets);
}

function plannedSetsForLiveRecommendation(ex: SessionExercise): PlannedSet[] {
  const fallbackReps = String(ex.targetReps ?? '8-12');
  const fallbackWeight = ex.targetWeightLbs ?? null;
  const scheme = Array.isArray(ex.setScheme) ? ex.setScheme : [];
  if (scheme.length > 0) {
    return scheme.map((set, index): PlannedSet => ({
      setNumber: Number(set.setNumber) > 0 ? Number(set.setNumber) : index + 1,
      setType: set.setType || 'volume',
      targetReps: String(set.targetReps || fallbackReps),
      targetRir: typeof set.targetRir === 'number' ? set.targetRir : 2,
      progressionMode: set.progressionMode || 'reps_first',
      targetWeightLbs: set.targetWeightLbs ?? fallbackWeight,
    }));
  }
  return Array.from({ length: getExerciseTargetSetCount(ex) }, (_, n): PlannedSet => ({
    setNumber: n + 1,
    setType: 'volume',
    targetReps: fallbackReps,
    targetRir: 2,
    progressionMode: 'reps_first',
    targetWeightLbs: fallbackWeight,
  }));
}

function parseDisplaySetIndex(label: string | null | undefined): number {
  const match = String(label ?? '').match(/set\s+(\d+)/i);
  const parsed = match ? Number(match[1]) : 1;
  return Number.isFinite(parsed) && parsed > 0 ? parsed - 1 : 0;
}

function AnimatedBarFill({ pct, color, delay = 0 }: { pct: number; color: string; delay?: number }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const t = setTimeout(() => {
      Animated.timing(anim, { toValue: pct, duration: 500, useNativeDriver: false }).start();
    }, delay);
    return () => clearTimeout(t);
  }, [pct, delay]);
  return (
    <Animated.View style={{
      width: anim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
      height: '100%', backgroundColor: color, borderRadius: 3,
    }} />
  );
}

const TIMED_EXERCISE_RE = /treadmill|stationary bike|elliptical|rowing machine|\brower\b|\browing\b|stair climber|assault bike|battle ropes|jump rope|sprint|jogging|running|cycling|swimming|hiit|intervals|mountain climber|hill sprint|cardio|^(?:brisk |incline |outdoor |treadmill )?walk(?:ing)?\b(?!\s+lunges?\b)|boxing|kickboxing|martial.?arts|mma|sparring|bag.?work|shadow.?box|yoga|vinyasa|hot.?yoga|power.?yoga|yin.?yoga|mobility.?flow|stretching/i;
const TIMED_REPS_RE = /\b\d+(?:\.\d+)?\s*(?:[-–—]\s*\d+(?:\.\d+)?)?\s*(?:s|sec|secs|second|seconds|min|mins|minute|minutes)\b/i;
const DISTANCE_REPS_RE = /\b\d+(?:\.\d+)?\s*(?:[-–—]\s*\d+(?:\.\d+)?)?\s*(?:yd|yds|yard|yards|m|meter|meters|metre|metres|ft|feet|km|mi|mile|miles)\b/i;
// `isBodyweightOnly` name-regex was replaced by the richer
// `shouldHideWeight(ex)` predicate in `utils/exerciseDisplay.ts`,
// which also checks equipment / archetype / training_type / reps
// string. Old regex removed with the function.

function isTimedExercise(name: string, targetReps?: string | number): boolean {
  if (isGuideExercise({ name, reps: targetReps, targetReps })) return true;
  // Detect time-based rep schemes like "30s", "30-60s", "45 sec", "60 seconds",
  // "25 min", "20-30 min". Coerce to string — AI plans occasionally return
  // reps as a number ("reps": 12) which crashed .trim() before this guard.
  const reps = targetReps == null ? '' : String(targetReps).trim();
  if (reps && DISTANCE_REPS_RE.test(reps)) return false;
  if (TIMED_EXERCISE_RE.test(name)) return true;
  if (reps && TIMED_REPS_RE.test(reps)) return true;
  return false;
}

/** True when this timed exercise is "long" — i.e. the user is probably
 *  doing it on equipment with its own clock (treadmill, bike, rower)
 *  and should type the duration rather than run an in-app stopwatch
 *  for the full time. Short holds (plank, dead hang, wall sit, carry)
 *  are better served by the timer. Used to decide which control to
 *  emphasize; both are always shown. */
function isLongCardioExercise(name: string, targetReps?: string | number, opts?: { primaryMuscle?: string | null }): boolean {
  // Structured-field fast path: exercises with primary_muscle "cardio" are
  // always long-duration, and "mobility" exercises (yoga, stretching) are
  // duration-based too.
  const muscle = (opts?.primaryMuscle ?? '').toLowerCase();
  if (muscle === 'cardio' || muscle === 'mobility') return true;

  // Regex fallback for old cached plans without structured fields
  const lowered = (name || '').toLowerCase();
  if (/treadmill|stationary bike|elliptical|rowing machine|stair climber|assault bike|jogging|running|cycling|swimming|zone ?2|tempo|steady state|long run|^(?:brisk |incline |outdoor |treadmill )?walk(?:ing)?\b(?!\s+lunges?\b)|boxing|kickboxing|martial.?arts|mma|sparring|bag.?work|shadow.?box|yoga|vinyasa|hot.?yoga|power.?yoga|yin.?yoga|mobility.?flow|stretching/.test(lowered)) {
    return true;
  }
  // If the target is expressed in minutes and is ≥ 3, treat as long.
  const reps = targetReps == null ? '' : String(targetReps).trim();
  const minMatch = reps.match(/(\d+)\s*-?\s*(\d*)\s*m(in)?/i);
  if (minMatch) {
    const n = parseInt(minMatch[1], 10);
    if (Number.isFinite(n) && n >= 3) return true;
  }
  return false;
}

type CoreCircuitCategory = 'anti_extension' | 'anti_rotation' | 'lateral_stability' | 'flexion';

const CORE_CIRCUIT_FALLBACKS: ExerciseLibraryItem[] = [
  {
    id: 'core_fallback_dead_bug',
    slug: 'dead_bug',
    name: 'Dead Bug',
    equipment: 'bodyweight',
    primary_muscle: 'core',
    secondary_muscles: [],
    movement_pattern: 'anti_extension',
    is_compound: false,
  },
  {
    id: 'core_fallback_side_plank',
    slug: 'side_plank',
    name: 'Side Plank',
    equipment: 'bodyweight',
    primary_muscle: 'core',
    secondary_muscles: [],
    movement_pattern: 'anti_extension',
    is_compound: false,
  },
  {
    id: 'core_fallback_reverse_crunch',
    slug: 'reverse_crunch',
    name: 'Reverse Crunch',
    equipment: 'bodyweight',
    primary_muscle: 'core',
    secondary_muscles: [],
    movement_pattern: 'flexion',
    is_compound: false,
  },
  {
    id: 'core_fallback_bird_dog',
    slug: 'bird_dog',
    name: 'Bird Dog',
    equipment: 'bodyweight',
    primary_muscle: 'core',
    secondary_muscles: ['back'],
    movement_pattern: 'anti_extension',
    is_compound: false,
  },
];

function coreCircuitCategoryForItem(item: ExerciseLibraryItem): CoreCircuitCategory | null {
  const name = normalizeSwapText(item.name);
  const movement = normalizeSwapText(item.movement_pattern);
  const primary = normalizeSwapText(item.primary_muscle);
  if (primary !== 'core') return null;
  if (/mountain climber|burpee|sprint|running|jogging/.test(name)) return null;
  if (/side plank|copenhagen|suitcase/.test(name)) return 'lateral_stability';
  if (/pallof|woodchop|wood chop|russian twist|anti rotation/.test(name) || movement === 'anti rotation') {
    return 'anti_rotation';
  }
  if (/reverse crunch|crunch|leg raise|knee raise|toes to bar|sit up|v up/.test(name) || movement === 'flexion' || movement === 'isolation') {
    return 'flexion';
  }
  if (/plank|dead bug|bird dog|hollow|rollout|body saw/.test(name) || movement === 'anti extension') {
    return 'anti_extension';
  }
  return 'anti_extension';
}

function coreCategoryOrderForWorkout(workoutFocus?: string | null): CoreCircuitCategory[] {
  const focus = normalizeSwapText(workoutFocus);
  if (/legs?|lower|squat|hinge/.test(focus)) {
    return ['anti_rotation', 'lateral_stability', 'anti_extension'];
  }
  if (/pull|back/.test(focus)) {
    return ['anti_rotation', 'lateral_stability', 'anti_extension'];
  }
  if (/push|chest|shoulder/.test(focus)) {
    return ['anti_extension', 'anti_rotation', 'flexion'];
  }
  return ['anti_extension', 'anti_rotation', 'lateral_stability'];
}

function coreCandidateScore(item: ExerciseLibraryItem, category: CoreCircuitCategory): number {
  const name = normalizeSwapText(item.name);
  const movement = normalizeSwapText(item.movement_pattern);
  const equipment = normalizeSwapText(exerciseEquipmentLabel(item) ?? item.equipment);
  let score = 0;
  if (normalizeSwapText(item.primary_muscle) === 'core') score += 20;
  if (
    (category === 'anti_extension' && movement === 'anti extension') ||
    (category === 'anti_rotation' && movement === 'anti rotation') ||
    (category === 'flexion' && (movement === 'flexion' || movement === 'isolation'))
  ) {
    score += 10;
  }
  if (category === 'lateral_stability' && /side plank|copenhagen|suitcase/.test(name)) score += 12;
  if (category === 'anti_extension' && /dead bug|plank|hollow|rollout/.test(name)) score += 8;
  if (category === 'anti_rotation' && /pallof|woodchop|wood chop|russian twist/.test(name)) score += 8;
  if (category === 'flexion' && /reverse crunch|knee raise|leg raise|crunch/.test(name)) score += 8;
  if (/bodyweight|none/.test(equipment)) score += 2;
  if (category === 'anti_rotation' && /cable/.test(equipment)) score += 2;
  if (/weighted|toes to bar|ab wheel/.test(name)) score -= 3;
  return score;
}

function coreCircuitTargetReps(item: ExerciseLibraryItem): string {
  const name = normalizeSwapText(item.name);
  const tracking = normalizeSwapText((item as any).default_tracking_mode);
  if (/side plank|copenhagen/.test(name)) return '30s each side';
  if (tracking === 'distance' || /carry/.test(name)) return '30-40m';
  if (/plank|hollow/.test(name) || tracking === 'time') return '30s';
  if (/dead bug|bird dog|pallof/.test(name)) return '10/side';
  if (/woodchop|wood chop|russian twist/.test(name)) return '12/side';
  return '12';
}

function coreCircuitSlotLabel(category: CoreCircuitCategory): string {
  switch (category) {
    case 'anti_rotation':
      return 'Core Circuit - Anti-Rotation';
    case 'lateral_stability':
      return 'Core Circuit - Lateral Stability';
    case 'flexion':
      return 'Core Circuit - Lower Ab';
    case 'anti_extension':
    default:
      return 'Core Circuit - Anti-Extension';
  }
}

function mergeCoreCircuitCandidates(library: ExerciseLibraryItem[]): ExerciseLibraryItem[] {
  const byName = new Map<string, ExerciseLibraryItem>();
  for (const item of CORE_CIRCUIT_FALLBACKS) {
    byName.set(normalizeSwapText(item.name), item);
  }
  for (const item of library) {
    const key = normalizeSwapText(item.name);
    if (!key) continue;
    byName.set(key, item);
  }
  return Array.from(byName.values());
}

function buildGeneratedCoreCircuit(
  library: ExerciseLibraryItem[],
  currentExercises: SessionExercise[],
  opts: {
    ownedEquipment: string[];
    activeInjuryTokens: string[];
    workoutFocus?: string | null;
  },
): SessionExercise[] {
  const currentNames = new Set(currentExercises.map(ex => normalizeSwapText(ex.name)));
  const categoryOrder = coreCategoryOrderForWorkout(opts.workoutFocus);
  const candidates = mergeCoreCircuitCandidates(library)
    .filter(item => !currentNames.has(normalizeSwapText(item.name)))
    .filter(item => isExerciseUsableWithEquipment(item, opts.ownedEquipment))
    .filter(item => !candidateConflictsWithActiveInjuries(item, opts.activeInjuryTokens))
    .map(item => ({ item, category: coreCircuitCategoryForItem(item) }))
    .filter((row): row is { item: ExerciseLibraryItem; category: CoreCircuitCategory } => row.category != null);

  const selected: Array<{ item: ExerciseLibraryItem; category: CoreCircuitCategory }> = [];
  for (const category of categoryOrder) {
    const best = candidates
      .filter(row => row.category === category)
      .filter(row => !selected.some(sel => normalizeSwapText(sel.item.name) === normalizeSwapText(row.item.name)))
      .sort((a, b) => {
        const scoreDelta = coreCandidateScore(b.item, category) - coreCandidateScore(a.item, category);
        if (scoreDelta !== 0) return scoreDelta;
        return a.item.name.localeCompare(b.item.name);
      })[0];
    if (best) selected.push(best);
    if (selected.length >= 3) break;
  }

  if (selected.length < 3) {
    for (const row of candidates.sort((a, b) => {
      const scoreDelta = coreCandidateScore(b.item, b.category) - coreCandidateScore(a.item, a.category);
      if (scoreDelta !== 0) return scoreDelta;
      return a.item.name.localeCompare(b.item.name);
    })) {
      if (selected.some(sel => normalizeSwapText(sel.item.name) === normalizeSwapText(row.item.name))) continue;
      selected.push(row);
      if (selected.length >= 3) break;
    }
  }

  return selected.slice(0, 3).map(({ item, category }): SessionExercise => ({
    name: item.name,
    targetSets: 3,
    targetReps: coreCircuitTargetReps(item),
    targetRestSeconds: 30,
    equipment: exerciseEquipmentLabel(item, opts.ownedEquipment) ?? item.equipment ?? 'bodyweight',
    sets: [],
    aiRecommendation: undefined,
    image_url: item.image_url ?? undefined,
    video_id: item.video_id ?? null,
    targetWeightLbs: null,
    setScheme: null,
    slug: item.slug ?? null,
    primaryMuscle: item.primary_muscle ?? 'core',
    primary_muscle: item.primary_muscle ?? 'core',
    secondaryMuscles: item.secondary_muscles ?? [],
    secondary_muscles: item.secondary_muscles ?? [],
    muscles_targeted: [
      item.primary_muscle ?? 'core',
      ...(item.secondary_muscles ?? []),
    ].filter(Boolean) as string[],
    isCompound: item.is_compound ?? false,
    slotRole: 'core',
    slotLabel: coreCircuitSlotLabel(category),
    prescriptionType: 'core_circuit',
    weightRecommendationSource: null,
  }));
}

// Stretch-circuit builder. Mirrors buildGeneratedCoreCircuit but pulls
// from poses tagged with flow_category in {warm, floor, cool} — i.e. the
// same pool generate_stretch_session uses on the backend. Picks one from
// each category when possible to produce a balanced 3-4 pose cooldown.
const _STRETCH_FLOW_CATEGORIES: ReadonlyArray<'warm' | 'floor' | 'cool'> = ['warm', 'floor', 'cool'];

function _stretchTargetReps(item: ExerciseLibraryItem): string {
  const unilateral = String(item.movement_pattern ?? '').toLowerCase() === 'mobility'
    && /(unilateral|one[-\s]?side|each\s+side)/i.test(String(item.description ?? ''));
  return unilateral ? '45s each side' : '60s hold';
}

function buildGeneratedStretchCircuit(
  library: ExerciseLibraryItem[],
  currentExercises: SessionExercise[],
  opts: { ownedEquipment: string[]; activeInjuryTokens: string[] },
): SessionExercise[] {
  const currentNames = new Set(currentExercises.map(ex => normalizeSwapText(ex.name)));
  const candidates = library
    .filter(item => {
      const fc = (item as any)?.flow_category as string | null | undefined;
      return fc != null && _STRETCH_FLOW_CATEGORIES.includes(fc as any);
    })
    .filter(item => !currentNames.has(normalizeSwapText(item.name)))
    .filter(item => isExerciseUsableWithEquipment(item, opts.ownedEquipment))
    .filter(item => !candidateConflictsWithActiveInjuries(item, opts.activeInjuryTokens));

  const selected: ExerciseLibraryItem[] = [];
  // Prefer one pose per category in order, then top up to 4 from remaining.
  for (const cat of _STRETCH_FLOW_CATEGORIES) {
    const next = candidates.find(it => (it as any).flow_category === cat
      && !selected.some(s => normalizeSwapText(s.name) === normalizeSwapText(it.name)));
    if (next) selected.push(next);
  }
  for (const it of candidates) {
    if (selected.length >= 4) break;
    if (!selected.some(s => normalizeSwapText(s.name) === normalizeSwapText(it.name))) selected.push(it);
  }

  return selected.slice(0, 4).map((item): SessionExercise => ({
    name: item.name,
    targetSets: 1,
    targetReps: _stretchTargetReps(item),
    targetRestSeconds: 10,
    equipment: exerciseEquipmentLabel(item, opts.ownedEquipment) ?? item.equipment ?? 'bodyweight',
    sets: [],
    aiRecommendation: undefined,
    image_url: item.image_url ?? undefined,
    video_id: item.video_id ?? null,
    targetWeightLbs: null,
    setScheme: null,
    slug: item.slug ?? null,
    primaryMuscle: item.primary_muscle ?? null,
    primary_muscle: item.primary_muscle ?? null,
    secondaryMuscles: item.secondary_muscles ?? [],
    secondary_muscles: item.secondary_muscles ?? [],
    muscles_targeted: [
      item.primary_muscle ?? '',
      ...(item.secondary_muscles ?? []),
    ].filter(Boolean) as string[],
    isCompound: false,
    slotRole: 'mobility',
    slotLabel: 'Cooldown',
    prescriptionType: 'stretch_hold',
    flowCategory: ((item as any).flow_category ?? null),
    weightRecommendationSource: null,
  }));
}

function hasStretchBlock(exercises: SessionExercise[]): boolean {
  for (const ex of exercises) {
    const fc = (ex as any)?.flowCategory ?? (ex as any)?.flow_category;
    if (typeof fc === 'string' && fc.length > 0) return true;
    const ptype = String(ex?.prescriptionType ?? '').toLowerCase();
    if (ptype === 'stretch_hold' || ptype === 'yoga_flow') return true;
  }
  return false;
}

function getTimedExerciseTip(name: string, targetReps?: string | number, loggedSets?: any[]): string | null {
  if (isGuideExercise({ name, reps: targetReps, targetReps })) return null;
  const n = (name || '').toLowerCase();
  const setNum = (loggedSets?.length ?? 0) + 1;

  // Treadmill / Running — recommend pace
  if (/treadmill|running|jogging|run\b/.test(n)) {
    if (setNum === 1) return 'Start easy at 5.0-6.0 mph for 2 min to warm up, then build to your target pace.';
    return 'Steady effort — aim for a pace you can hold a conversation at for zone 2, or push to 7.0+ mph for intervals.';
  }
  // Rowing machine
  if (/row|rowing|erg/.test(n)) {
    if (setNum === 1) return 'Warm up at a 2:15-2:30 /500m split. Focus on the drive from your legs, not your arms.';
    return 'Target a 1:55-2:10 /500m split for steady state. Keep stroke rate at 22-26 spm.';
  }
  // Cycling / Bike
  if (/bike|cycling|ride|peloton/.test(n)) {
    if (setNum === 1) return 'Start with low resistance for 2-3 min to warm up your legs. Cadence 80-90 rpm.';
    return 'For steady state: resistance where you can hold 80-90 rpm. For intervals: push resistance up and hold 60-70 rpm.';
  }
  // Stair climber / Elliptical
  if (/stair|elliptical/.test(n)) {
    return 'Find a level where you can maintain a steady pace. Avoid leaning on the handrails.';
  }
  // Swimming
  if (/swim/.test(n)) {
    return 'Focus on long strokes and steady breathing. Count strokes per length to gauge efficiency.';
  }
  // Plank / Holds
  if (/plank|dead.?hang|wall.?sit|hollow.?hold|l.?sit/.test(n)) {
    const lastDur = loggedSets?.length ? loggedSets[loggedSets.length - 1]?.durationSeconds : null;
    if (lastDur && lastDur > 0) return `Last hold was ${lastDur}s — try to match or beat it by 5 seconds.`;
    return 'Hold with good form. Stop when form breaks down, not when it gets uncomfortable.';
  }
  // Farmer's walk / Carry
  if (/farmer|carry|suitcase/.test(n)) {
    return 'Shoulders back, core braced. Walk with short controlled steps. Grip is usually the limiter.';
  }
  // Battle ropes / Jump rope
  if (/battle.?rope|jump.?rope/.test(n)) {
    return 'Keep a consistent rhythm. Rest when form breaks down, then resume.';
  }
  // HIIT / Intervals / Sprints
  if (/hiit|interval|sprint/.test(n)) {
    return 'Max effort during work intervals. Fully recover during rest — heart rate should drop before the next round.';
  }
  // Yoga / mobility flows
  if (/yoga|vinyasa|yin|mobility.?flow|sun.?salutation|warrior|pigeon|lizard|downward.?dog|stretching/.test(n)) {
    if (setNum === 1) return 'Move with your breath — inhale to lengthen, exhale to deepen. No bouncing.';
    return 'Stay in poses where you feel a productive stretch, not pain. Quality over depth.';
  }
  // Boxing / kickboxing
  if (/boxing|kickboxing|martial.?arts|mma|sparring|bag.?work|shadow.?box/.test(n)) {
    return 'Stay light on your feet. Throw combinations, not single shots.';
  }
  return null;
}

type MetricField = {
  key: string;
  label: string;
  placeholder: string;
  keyboard: 'decimal-pad' | 'number-pad' | 'default';
  helper: string;
};

type TimedMetricsConfig = {
  title: string;
  subtitle: string;
  icon: keyof typeof Ionicons.glyphMap;
  fields: MetricField[];
};

function getTimedMetricsConfig(name: string, cardioGuidance?: any, distanceUnit: DistanceUnit = 'mi'): TimedMetricsConfig | null {
  const n = (name || '').toLowerCase();
  const dist = distanceSuffix(distanceUnit);
  const runPace = distanceUnit === 'km' ? '/km' : '/mi';
  // Incline walk — speed + incline are the primary metrics
  if (/incline.?walk|incline.*tread|\bwalk\b/.test(n)) {
    return {
      title: 'Incline walk details',
      subtitle: 'Speed, incline, and distance make incline sessions comparable in Progress.',
      icon: 'walk-outline',
      fields: [
        { key: 'speed', label: 'Speed', placeholder: cardioGuidance?.speed_range ?? '3.5 mph', keyboard: 'decimal-pad', helper: 'Console average' },
        { key: 'incline', label: 'Incline', placeholder: cardioGuidance?.incline_range ?? '6%', keyboard: 'decimal-pad', helper: 'Average grade' },
        { key: 'distance', label: `Distance (${dist})`, placeholder: distanceUnit === 'km' ? '2.4 km' : '1.5 mi', keyboard: 'decimal-pad', helper: 'Total session' },
      ],
    };
  }
  if (/treadmill|running|jogging|run\b/.test(n)) {
    return {
      title: 'Run details',
      subtitle: 'Distance and pace feed endurance charts and pace history.',
      icon: 'analytics-outline',
      fields: [
        { key: 'pace', label: 'Avg Pace', placeholder: distanceUnit === 'km' ? `5:15 ${runPace}` : `8:30 ${runPace}`, keyboard: 'default', helper: 'Overall pace' },
        { key: 'distance', label: `Distance (${dist})`, placeholder: distanceUnit === 'km' ? '5.0 km' : '3.1 mi', keyboard: 'decimal-pad', helper: 'Total distance' },
        { key: 'incline', label: 'Incline', placeholder: cardioGuidance?.incline_range ?? '2%', keyboard: 'decimal-pad', helper: 'If treadmill' },
      ],
    };
  }
  if (/row|rowing|erg/.test(n)) {
    return {
      title: 'Row details',
      subtitle: 'Split and stroke rate keep erg sessions apples-to-apples.',
      icon: 'boat-outline',
      fields: [
        { key: 'split', label: 'Avg Split', placeholder: cardioGuidance?.pace_per_500m ?? '2:05 /500m', keyboard: 'default', helper: 'Overall split' },
        { key: 'distance', label: 'Distance', placeholder: '5000 m', keyboard: 'number-pad', helper: 'Meters rowed' },
        { key: 'spm', label: 'Stroke Rate', placeholder: cardioGuidance?.stroke_rate ?? '24 spm', keyboard: 'number-pad', helper: 'Average SPM' },
      ],
    };
  }
  if (/bike|cycling|ride|peloton|spin/.test(n)) {
    // Smart bikes expose watts; simpler stationary bikes still get useful
    // cadence/resistance targets from the planner.
    if (cardioGuidance?.watts_range) {
      return {
        title: 'Bike power details',
        subtitle: 'Power and cadence are the cleanest way to compare bike sessions.',
        icon: 'bicycle-outline',
        fields: [
          { key: 'watts', label: 'Avg Watts', placeholder: cardioGuidance?.watts_range ?? '175', keyboard: 'number-pad', helper: 'Console average' },
          { key: 'cadence', label: 'Cadence', placeholder: cardioGuidance?.rpm_range ?? '85 rpm', keyboard: 'number-pad', helper: 'Average RPM' },
          { key: 'output', label: 'Output', placeholder: '350 kJ', keyboard: 'number-pad', helper: 'If shown' },
        ],
      };
    }
    if (cardioGuidance?.rpm_range || cardioGuidance?.resistance_cue) {
      return {
        title: 'Bike details',
        subtitle: 'Cadence and resistance keep easy rides consistent without needing power data.',
        icon: 'bicycle-outline',
        fields: [
          { key: 'cadence', label: 'Cadence', placeholder: cardioGuidance?.rpm_range ?? '85 rpm', keyboard: 'number-pad', helper: 'Average RPM' },
          { key: 'resistance', label: 'Resistance', placeholder: cardioGuidance?.resistance_cue ?? 'medium', keyboard: 'default', helper: 'Average level or feel' },
          { key: 'distance', label: `Distance (${dist})`, placeholder: distanceUnit === 'km' ? '20.0 km' : '12.5 mi', keyboard: 'decimal-pad', helper: 'Total ride' },
        ],
      };
    }
    return {
      title: 'Bike details',
      subtitle: 'Use the bike console values so future rides compare cleanly.',
      icon: 'bicycle-outline',
      fields: [
        { key: 'distance', label: `Distance (${dist})`, placeholder: distanceUnit === 'km' ? '20.0 km' : '12.5 mi', keyboard: 'decimal-pad', helper: 'Total ride' },
        { key: 'cadence', label: 'Cadence', placeholder: '85 rpm', keyboard: 'number-pad', helper: 'Average RPM' },
        { key: 'output', label: 'Output', placeholder: '350 kJ', keyboard: 'number-pad', helper: 'If shown' },
      ],
    };
  }
  if (/swim/.test(n)) {
    return {
      title: 'Swim details',
      subtitle: 'Distance and laps make pool sessions easier to compare over time.',
      icon: 'water-outline',
      fields: [
        { key: 'distance', label: 'Distance', placeholder: '1500 m', keyboard: 'number-pad', helper: 'Total swim' },
        { key: 'laps', label: 'Laps', placeholder: '30', keyboard: 'number-pad', helper: 'Pool lengths' },
      ],
    };
  }
  if (/stair|elliptical/.test(n)) {
    return {
      title: /stair/.test(n) ? 'Stair details' : 'Elliptical details',
      subtitle: 'Levels, floors, and calories help compare machine sessions.',
      icon: 'speedometer-outline',
      fields: [
        { key: 'floors', label: /stair/.test(n) ? 'Floors' : 'Level', placeholder: /stair/.test(n) ? '45' : '8', keyboard: 'number-pad', helper: 'Machine value' },
        { key: 'calories', label: 'Calories', placeholder: '280', keyboard: 'number-pad', helper: 'Optional' },
      ],
    };
  }
  if (/hik/.test(n)) {
    return {
      title: 'Hike details',
      subtitle: 'Distance plus elevation tells a better story than duration alone.',
      icon: 'trail-sign-outline',
      fields: [
        { key: 'distance', label: `Distance (${dist})`, placeholder: distanceUnit === 'km' ? '6.8 km' : '4.2 mi', keyboard: 'decimal-pad', helper: 'Total hike' },
        { key: 'elevation', label: 'Elevation', placeholder: '800 ft', keyboard: 'number-pad', helper: 'Gain' },
      ],
    };
  }
  if (/farmer|carry|suitcase/.test(n)) {
    return {
      title: 'Carry details',
      subtitle: 'Load and distance are the useful progression signals for carries.',
      icon: 'walk-outline',
      fields: [
        { key: 'weight', label: 'Load', placeholder: '70 each', keyboard: 'default', helper: 'Per hand if split' },
        { key: 'distance', label: 'Distance', placeholder: '120 ft', keyboard: 'number-pad', helper: 'Total carry' },
      ],
    };
  }
  // Boxing, kickboxing, yoga, stretching, etc — no metrics to capture
  return null;
}

function shouldStoreDistanceAsMiles(exerciseName: string): boolean {
  return /incline.?walk|treadmill|running|jogging|run\b|bike|cycling|ride|peloton|spin|hik/.test((exerciseName || '').toLowerCase());
}

function plannedCardioGpsFocus(workout: WorkoutDay | null | undefined): string | null {
  if (!workout) return null;
  const customVenue = String((workout as any)._custom_activity_venue ?? '').trim().toLowerCase();
  if (customVenue === 'indoor') return null;

  const focus = String(workout.focus ?? '').trim();
  if (/\b(indoor|treadmill|stationary|spin|trainer)\b/i.test(focus)) return null;

  const customSubtype = String((workout as any)._custom_cardio_subtype ?? '').trim();
  if (customSubtype && activityFromFocus(customSubtype) !== 'unknown') {
    return customVenue === 'outdoor' ? `outdoor ${customSubtype}` : customSubtype;
  }

  if (focus && activityFromFocus(focus) !== 'unknown') return focus;

  for (const ex of workout.exercises ?? []) {
    const name = String((ex as any).name ?? '').trim();
    const guidance = ((ex as any).cardioGuidance ?? (ex as any).cardio_guidance ?? {}) as Record<string, unknown>;
    const modality = String(guidance.modality ?? (ex as any).cardio_modality ?? '').trim().toLowerCase();
    if (modality === 'outdoor_bike') return 'outdoor bike';
    if (modality === 'outdoor_run') return 'outdoor run';
    if ([
      'bike', 'assault_bike', 'treadmill', 'rower', 'elliptical',
      'stair_climber', 'skierg', 'versaclimber',
    ].includes(modality)) {
      continue;
    }
    const lower = name.toLowerCase();
    if (/treadmill|stationary|spin|peloton|assault|fan bike|airbike|rower|rowing|elliptical|stair|skierg|ski erg|versa/.test(lower)) {
      continue;
    }
    const activity = activityFromFocus(name);
    if (activity !== 'unknown') return name;
  }

  return focus || null;
}

function cardioGpsFocusForExercise(exercise: any): string | null {
  const guidance = ((exercise as any)?.cardioGuidance ?? (exercise as any)?.cardio_guidance ?? {}) as Record<string, unknown>;
  const modality = String(guidance.modality ?? (exercise as any)?.cardio_modality ?? '').trim().toLowerCase();
  if (modality === 'outdoor_bike') return 'outdoor bike';
  if (modality === 'outdoor_run') return 'outdoor run';
  if (modality === 'outdoor_walk') return 'outdoor walk';
  if (modality === 'outdoor_hike') return 'outdoor hike';
  return String((exercise as any)?.name ?? '').trim() || null;
}

function isOutdoorGpsTimedExercise(exercise: any): boolean {
  if (!exercise) return false;
  if (!isTimedExercise(String(exercise.name ?? ''), exercise.targetReps ?? exercise.reps)) return false;
  const focus = cardioGpsFocusForExercise(exercise);
  return activityFromFocus(focus) !== 'unknown';
}

function routeCoordFromPayload(value: unknown): RouteCoord | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  const tMs = Number(raw.t_ms ?? raw.timestampMs);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(tMs) || tMs <= 0) return null;
  const acc = Number(raw.acc_m);
  const alt = Number(raw.alt_m);
  const vAcc = Number(raw.v_acc_m);
  return {
    lat,
    lon,
    t_ms: tMs,
    acc_m: Number.isFinite(acc) ? acc : null,
    ...(Number.isFinite(alt) ? { alt_m: alt } : {}),
    ...(Number.isFinite(vAcc) ? { v_acc_m: vAcc } : {}),
  };
}

function normalizeCompletedSetType(raw: unknown): string | null {
  const value = String(raw ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (!value) return null;
  if (value === 'warm_up') return 'warmup';
  return value;
}

function isWarmupCompletedSet(set: CompletedSet | null | undefined): boolean {
  return normalizeCompletedSetType(set?.setType) === 'warmup';
}

function visibleWarmupSets(ex: Pick<SessionExercise, 'warmupSets' | 'sets'>): CompletedSet[] {
  if (Array.isArray(ex.warmupSets)) return ex.warmupSets;
  return (ex.sets ?? []).filter(isWarmupCompletedSet);
}

/** Parse a user-entered duration string into seconds. Accepts:
 *    "mm:ss"      → minutes + seconds
 *    "45s", "45 sec", "45 seconds"   → seconds
 *    "25m", "25 min", "25 minutes"   → minutes
 *    plain number → interpreted as minutes if `preferMinutes`, else seconds
 *  Returns NaN on empty / unparseable input. */
function parseDurationInput(text: string, preferMinutes: boolean): number {
  const t = (text || '').trim().toLowerCase();
  if (!t) return NaN;
  if (t.includes(':')) {
    const [mm, ss] = t.split(':').map(s => parseInt(s, 10));
    if (!Number.isFinite(mm) || !Number.isFinite(ss)) return NaN;
    return mm * 60 + ss;
  }
  const secMatch = t.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds)$/);
  if (secMatch) return Math.round(parseFloat(secMatch[1]));
  const minMatch = t.match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes)$/);
  if (minMatch) return Math.round(parseFloat(minMatch[1]) * 60);
  const numMatch = t.match(/^(\d+(?:\.\d+)?)$/);
  if (numMatch) {
    const n = parseFloat(numMatch[1]);
    return Math.round(preferMinutes ? n * 60 : n);
  }
  return NaN;
}

function parseDurationTargetSeconds(targetReps: unknown, preferMinutes: boolean): number {
  const t = String(targetReps ?? '').trim().toLowerCase();
  if (!t) return NaN;
  const range = t.match(/(\d+(?:\.\d+)?)\s*(?:[-–—]\s*(\d+(?:\.\d+)?))?\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes)?/);
  if (!range) return NaN;
  const first = parseFloat(range[1]);
  const second = range[2] ? parseFloat(range[2]) : first;
  if (!Number.isFinite(first) || !Number.isFinite(second)) return NaN;
  const planned = (first + second) / 2;
  const unit = range[3] ?? '';
  const minutes = /^m/.test(unit) || (!unit && preferMinutes);
  return Math.max(0, Math.round(minutes ? planned * 60 : planned));
}

/** Format a duration in seconds for display in an input field. Short
 *  holds render as "45s"; anything ≥ 60s uses mm:ss. */
function formatDurationForInput(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '';
  if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`;
  const mm = Math.floor(totalSeconds / 60);
  const ss = Math.round(totalSeconds % 60);
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

// Compound-lift name fallback, used when a plan/exercise lacks the structured
// is_compound flag (old cached plans). Shared by the warmup note + the
// compound-only warmup-set auto-population.
const COMPOUND_LIFT_NAME_RE = /squat|deadlift|bench press|overhead press|ohp|barbell press|pull.up|row|lunge|hip thrust|clean|snatch/;

function getExerciseWarmupNote(exerciseName: string, isFirst: boolean, opts?: { isCompound?: boolean }): string | null {
  const name = exerciseName.toLowerCase();
  // Prefer structured is_compound field; fall back to name-based regex for old cached plans
  const isCompound = opts?.isCompound ?? COMPOUND_LIFT_NAME_RE.test(name);
  if (!isCompound && !isFirst) return null;
  if (/squat/.test(name)) return 'Warm-up: 2–3 ramp-up sets — e.g. bar × 10, 50% × 8, 70% × 5 before working weight';
  if (/deadlift/.test(name)) return 'Warm-up: 2–3 light singles — e.g. 40% × 5, 60% × 3, 80% × 1 before working sets';
  if (/bench/.test(name)) return 'Warm-up: 2–3 ramp-up sets — e.g. bar × 15, 50% × 8, 70% × 5 before working weight';
  if (/overhead press|ohp/.test(name)) return 'Warm-up: 2 ramp-up sets — e.g. bar × 10, 60% × 6 before working weight';
  if (isFirst) return 'Warm-up: 1–2 lighter sets recommended before starting working weight';
  return null;
}

const SHARE_LOGO_DARK  = require('../../assets/images/thallo-logo-white-transparent-New.png');

function workoutExerciseToSessionExercise(ex: any): SessionExercise {
  return {
    name: ex.name,
    targetSets: ex.sets,
    targetReps: ex.reps,
    targetRestSeconds: ex.restSeconds,
    equipment: typeof ex.equipment === 'string' ? ex.equipment : String(ex.equipment),
    sets: [],
    warmupSets: [],
    aiRecommendation: undefined,
    image_url: ex.image_url,
    video_id: ex.video_id ?? null,
    demo_exercise_db_id: ex.demo_exercise_db_id ?? ex.demoExerciseDbId ?? null,
    targetWeightLbs: ex.targetWeightLbs ?? null,
    setScheme: Array.isArray(ex.setScheme) ? ex.setScheme : Array.isArray(ex.set_scheme) ? ex.set_scheme : null,
    slug: ex.slug ?? ex.exerciseSlug ?? ex._slug ?? null,
    primaryMuscle: ex.primary_muscle ?? ex.primaryMuscle ?? ex._primary_muscle ?? null,
    secondaryMuscles: ex.secondary_muscles ?? ex.secondaryMuscles ?? ex._secondary_muscles ?? [],
    muscles_targeted: ex.muscles_targeted ?? undefined,
    movementPattern: ex.movement_pattern ?? ex.movementPattern ?? null,
    isCompound: ex.is_compound ?? ex.isCompound ?? null,
    slotRole: ex.slotRole ?? ex.slot_role ?? ex._role ?? null,
    slotLabel: ex.slotLabel ?? ex.slot_label ?? ex._slot ?? null,
    prescriptionType: ex.prescriptionType ?? ex.prescription_type ?? null,
    weightRecommendationSource: ex.weightRecommendationSource ?? null,
  };
}

function savedExerciseFallback(saved: any): SessionExercise {
  return workoutExerciseToSessionExercise({
    name: saved?.name ?? 'Exercise',
    sets: saved?.targetSets ?? Math.max(1, Array.isArray(saved?.sets) ? saved.sets.length : 1),
    reps: saved?.targetReps ?? '',
    restSeconds: saved?.targetRestSeconds ?? 60,
    equipment: saved?.equipment ?? 'bodyweight',
    image_url: saved?.image_url,
    video_id: saved?.video_id,
    demo_exercise_db_id: saved?.demo_exercise_db_id ?? saved?.demoExerciseDbId,
    targetWeightLbs: saved?.targetWeightLbs,
    setScheme: saved?.setScheme ?? saved?.set_scheme,
    slug: saved?.slug,
    primaryMuscle: saved?.primaryMuscle ?? saved?.primary_muscle,
    secondaryMuscles: saved?.secondaryMuscles ?? saved?.secondary_muscles,
    muscles_targeted: saved?.muscles_targeted,
    movementPattern: saved?.movementPattern ?? saved?.movement_pattern,
    isCompound: saved?.isCompound ?? saved?.is_compound,
    slotRole: saved?.slotRole,
    slotLabel: saved?.slotLabel,
    prescriptionType: saved?.prescriptionType,
    weightRecommendationSource: saved?.weightRecommendationSource,
  });
}

function restoreSavedSessionExercise(saved: any, fallback: SessionExercise): SessionExercise {
  const targetSets = Number(saved?.targetSets ?? fallback.targetSets);
  const targetRestSeconds = Number(saved?.targetRestSeconds ?? fallback.targetRestSeconds);
  const savedName = typeof saved?.name === 'string' && saved.name.trim() ? saved.name : fallback.name;
  const exerciseNameChanged = exerciseHistoryKey(savedName) !== exerciseHistoryKey(fallback.name);
  const savedSlug = saved?.slug ?? null;
  const restoredSlug = exerciseNameChanged
    ? (savedSlug && savedSlug !== fallback.slug ? savedSlug : null)
    : savedSlug ?? fallback.slug ?? null;
  return {
    ...fallback,
    name: savedName,
    targetSets: Number.isFinite(targetSets) && targetSets > 0 ? targetSets : fallback.targetSets,
    targetReps: typeof saved?.targetReps === 'string' ? saved.targetReps : fallback.targetReps,
    targetRestSeconds: Number.isFinite(targetRestSeconds) && targetRestSeconds > 0 ? targetRestSeconds : fallback.targetRestSeconds,
    equipment: typeof saved?.equipment === 'string' && saved.equipment.trim() ? saved.equipment : fallback.equipment,
    sets: Array.isArray(saved?.sets) ? saved.sets.filter(Boolean).filter((s: CompletedSet) => !isWarmupCompletedSet(s)) : fallback.sets,
    warmupSets: Array.isArray(saved?.warmupSets)
      ? saved.warmupSets.filter(Boolean).map((s: CompletedSet, idx: number) => ({
        ...s,
        setNumber: Number(s.setNumber) > 0 ? Number(s.setNumber) : idx + 1,
        setType: 'warmup' as const,
      }))
      : Array.isArray(saved?.sets)
        ? saved.sets.filter(Boolean).filter(isWarmupCompletedSet)
        : fallback.warmupSets ?? [],
    aiRecommendation: typeof saved?.aiRecommendation === 'string' ? saved.aiRecommendation : fallback.aiRecommendation,
    image_url: saved?.image_url ?? fallback.image_url,
    video_id: saved?.video_id ?? fallback.video_id ?? null,
    demo_exercise_db_id: saved?.demo_exercise_db_id ?? saved?.demoExerciseDbId ?? fallback.demo_exercise_db_id ?? fallback.demoExerciseDbId ?? null,
    demoExerciseDbId: saved?.demoExerciseDbId ?? saved?.demo_exercise_db_id ?? fallback.demoExerciseDbId ?? fallback.demo_exercise_db_id ?? null,
    targetWeightLbs: exerciseNameChanged ? null : saved?.targetWeightLbs ?? fallback.targetWeightLbs ?? null,
    setScheme: exerciseNameChanged ? null : Array.isArray(saved?.setScheme) ? saved.setScheme : Array.isArray(saved?.set_scheme) ? saved.set_scheme : fallback.setScheme ?? null,
    slug: restoredSlug,
    primaryMuscle: saved?.primaryMuscle ?? saved?.primary_muscle ?? fallback.primaryMuscle ?? null,
    secondaryMuscles: saved?.secondaryMuscles ?? saved?.secondary_muscles ?? fallback.secondaryMuscles ?? [],
    muscles_targeted: saved?.muscles_targeted ?? fallback.muscles_targeted,
    movementPattern: saved?.movementPattern ?? saved?.movement_pattern ?? fallback.movementPattern ?? fallback.movement_pattern ?? null,
    isCompound: saved?.isCompound ?? saved?.is_compound ?? fallback.isCompound ?? null,
    slotRole: saved?.slotRole ?? fallback.slotRole ?? null,
    slotLabel: saved?.slotLabel ?? fallback.slotLabel ?? null,
    prescriptionType: saved?.prescriptionType ?? fallback.prescriptionType ?? null,
    weightRecommendationSource: exerciseNameChanged ? null : saved?.weightRecommendationSource ?? fallback.weightRecommendationSource ?? null,
  };
}

function serializeActiveWorkoutExercise(ex: SessionExercise, exerciseIndex: number): Record<string, any> {
  return {
    exerciseIndex,
    name: ex.name,
    targetSets: ex.targetSets,
    targetReps: ex.targetReps,
    targetRestSeconds: ex.targetRestSeconds,
    equipment: ex.equipment,
    sets: ex.sets,
    warmupSets: ex.warmupSets ?? [],
    aiRecommendation: ex.aiRecommendation,
    image_url: ex.image_url,
    video_id: ex.video_id,
    demo_exercise_db_id: ex.demo_exercise_db_id ?? ex.demoExerciseDbId ?? null,
    targetWeightLbs: ex.targetWeightLbs,
    setScheme: ex.setScheme ?? null,
    slug: ex.slug,
    primaryMuscle: ex.primaryMuscle ?? ex.primary_muscle ?? null,
    secondaryMuscles: ex.secondaryMuscles ?? ex.secondary_muscles ?? [],
    muscles_targeted: ex.muscles_targeted,
    movementPattern: ex.movementPattern ?? ex.movement_pattern ?? null,
    isCompound: ex.isCompound ?? null,
    slotRole: ex.slotRole,
    slotLabel: ex.slotLabel,
    prescriptionType: ex.prescriptionType,
    weightRecommendationSource: ex.weightRecommendationSource,
  };
}

export default function ActiveWorkoutScreen({ authToken, workout, goal, themeName, profileGender, weightLbs = 150, weightUnit = 'lbs', distanceUnit = 'mi', playStartCountdown = false, onFinish, onCancel, onDislikeExercise, onProfileUpdate }: ActiveWorkoutScreenProps) {
    // Warm-up state
    const [warmupDone, setWarmupDone] = useState(true);
    // When the user has started the workout, the warm-up card collapses
    // into a small header at the top of the exercise list that can be
    // tapped to re-expand if they want to re-read the steps mid-session.
    const [warmupExpanded, setWarmupExpanded] = useState(true);
    // AI-generated warm-up steps cached by (day + focus) for the SAME
    // day — visiting the same workout twice in one day reuses the
    // cached steps; the next calendar day regenerates. Falls back to
    // the deterministic template while the AI call is in flight or if
    // it fails. See backend: POST /ai/warmup.
    const [warmupSteps, setWarmupSteps] = useState<string[]>(() => buildWarmupPlan(workout));
    const [warmupLoading, setWarmupLoading] = useState(false);
    const [generatedWarmupSetsEnabled, setGeneratedWarmupSetsEnabled] = useState(false);
    // Mirror warmupSteps into a ref so the once-mounted watch-sync
    // effect can always send the freshest steps (AI warmup resolves
    // async after the initial push).
    const warmupStepsRef = useRef<string[]>(warmupSteps);
    useEffect(() => { warmupStepsRef.current = warmupSteps; }, [warmupSteps]);
    const authTokenRef = useRef(authToken);
    useEffect(() => { authTokenRef.current = authToken; }, [authToken]);
    const startTime = useRef(Date.now());
    const workoutSourceContext = useMemo(
      () => String((workout as any)._source_context ?? (workout as any).sourceContext ?? 'planned').trim() || 'planned',
      [workout],
    );
    const isCustomCardioWorkout = workoutSourceContext === 'custom_cardio';
    const [workoutPaused, setWorkoutPaused] = useState(false);
    const [workoutPausedAtMs, setWorkoutPausedAtMs] = useState<number | null>(null);
    const [workoutPausedAccumMs, setWorkoutPausedAccumMs] = useState(0);
    const workoutPauseRef = useRef({ paused: false, pausedAtMs: null as number | null, pausedAccumMs: 0 });
    useEffect(() => {
      workoutPauseRef.current = {
        paused: workoutPaused,
        pausedAtMs: workoutPausedAtMs,
        pausedAccumMs: workoutPausedAccumMs,
      };
    }, [workoutPaused, workoutPausedAccumMs, workoutPausedAtMs]);
    // Default to an interactive screen while resume storage hydrates. A
    // persisted workout proves the user is mid-session, and no startup
    // overlay should steal the first set-log tap while AsyncStorage catches up.
    //
    // Optimistic initial value: on a fresh start (no in-memory watch
    // session) we paint the countdown immediately so it covers the
    // hydrating workout content instead of appearing after the user
    // has already seen the exercises. The AsyncStorage callback below
    // refines this — if it turns out to be a resumed session with
    // logged sets or active timers, it sets the value back to false
    // before the user can realistically react.
    const [showStartCountdown, setShowStartCountdown] = useState(() => {
      if (!playStartCountdown) return false;
      // Same-process resume from the watch keeps the in-memory session
      // id populated; skip the countdown in that case so we don't steal
      // a set-log tap. Cross-process resumes will be handled by the
      // AsyncStorage hydration that follows.
      return !getActiveWatchSessionId();
    });
    const loadCachedProfile = useCallback(async (): Promise<UserProfile | null> => {
      try {
        const raw = await AsyncStorage.getItem('userProfile');
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    }, []);
    const cachedProfileIsPro = useCallback(async (): Promise<boolean> => {
      const profile = await loadCachedProfile();
      return tierOf(profile) === 'pro';
    }, [loadCachedProfile]);
    const displayWeight = useCallback((lbs: number | null | undefined, opts?: { precision?: number; suffix?: boolean }) =>
      formatWeight(lbs, weightUnit, {
        precision: opts?.precision,
        suffix: opts?.suffix,
      }),
    [weightUnit]);
    const displayExerciseWeight = useCallback((
      lbs: number | null | undefined,
      ex: { name?: string | null; equipment?: string | null } | null | undefined,
      opts?: { precision?: number; suffix?: boolean },
    ) => {
      const base = displayWeight(lbs, opts);
      return opts?.suffix === false || !isDumbbellLoadExercise(ex) ? base : `${base} each`;
    }, [displayWeight]);
    const exerciseWeightSuffix = useCallback((
      ex: { name?: string | null; equipment?: string | null } | null | undefined,
    ) => isDumbbellLoadExercise(ex) ? `${weightSuffix(weightUnit)} each` : weightSuffix(weightUnit), [weightUnit]);
    const displayWeightNumber = useCallback((lbs: number | null | undefined) => {
      if (lbs == null || !Number.isFinite(Number(lbs))) return '';
      const value = lbsToUnit(Number(lbs), weightUnit);
      if (weightUnit === 'kg') return String(Math.round(value * 10) / 10);
      const rounded = Math.round(value);
      return Math.abs(value - rounded) < 0.001
        ? String(rounded)
        : String(Math.round(value * 10) / 10);
    }, [weightUnit]);
    const parseInputWeightLbs = useCallback((raw: string | number | undefined | null): number => {
      const value = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
      return Number.isFinite(value) ? unitToLbs(value, weightUnit) : NaN;
    }, [weightUnit]);
    const backendWorkoutHistoryRef = useRef<WorkoutSessionRecord[] | null>(null);
    const backendWorkoutHistoryPromiseRef = useRef<Promise<WorkoutSessionRecord[]> | null>(null);
    useEffect(() => {
      backendWorkoutHistoryRef.current = null;
      backendWorkoutHistoryPromiseRef.current = null;
    }, [authToken]);
    const loadBackendWorkoutHistory = useCallback(async (): Promise<WorkoutSessionRecord[]> => {
      if (!authToken) return [];
      if (backendWorkoutHistoryRef.current) return backendWorkoutHistoryRef.current;
      if (!backendWorkoutHistoryPromiseRef.current) {
        backendWorkoutHistoryPromiseRef.current = listWorkoutSessions(authToken, 100).catch(() => []);
      }
      backendWorkoutHistoryRef.current = await backendWorkoutHistoryPromiseRef.current;
      return backendWorkoutHistoryRef.current;
    }, [authToken]);
    useEffect(() => {
      if (showStartCountdown) {
        setWarmupLoading(false);
        return;
      }
          let cancelled = false;
          const loadWarmup = async () => {
            if (isCustomCardioWorkout) {
              setWarmupSteps([]);
              setWarmupLoading(false);
              return;
            }
            if (!authToken) {
          setWarmupLoading(false);
          return;
        }
        setWarmupLoading(true);
        if (!(await cachedProfileIsPro())) {
          if (!cancelled) setWarmupLoading(false);
          return;
        }
        const today = dateKey(new Date());
        const dayKey = (workout.day || workout.focus || 'session').replace(/\s+/g, '_');
        const cacheKey = `ai-warmup:${today}:${dayKey}`;
        try {
          const cached = await AsyncStorage.getItem(cacheKey);
          if (cached) {
            const parsed = JSON.parse(cached);
            if (Array.isArray(parsed?.steps) && parsed.steps.length > 0 && !cancelled) {
              setWarmupSteps(parsed.steps);
              setWarmupLoading(false);
              return;
            }
          }
        } catch {}
        try {
          let injuries: string[] = [];
          try {
            const p = await loadCachedProfile();
            if (p) {
              injuries = ((p as any).injuriesOrLimitations || p.injuries || [])
                .map((i: any) => typeof i === 'string' ? i : (i?.label || i?.name || ''))
                .filter(Boolean);
            }
          } catch {}
          const result = await getAiWarmup(authToken, {
            focus: workout.focus,
            exercises: workout.exercises.map(e => ({
              name: e.name,
              equipment: typeof e.equipment === 'string' ? e.equipment : null,
            })),
            injuries,
            durationMinutes: 60,
          });
          if (!cancelled && Array.isArray(result?.steps) && result.steps.length > 0) {
            setWarmupSteps(result.steps);
            try {
              await AsyncStorage.setItem(cacheKey, JSON.stringify({ steps: result.steps, source: result.source }));
            } catch {}
          }
        } catch {
          // keep deterministic fallback already in state
        } finally {
          if (!cancelled) setWarmupLoading(false);
        }
      };
      loadWarmup();
      return () => { cancelled = true; };
        }, [authToken, workout.day, workout.focus, cachedProfileIsPro, isCustomCardioWorkout, loadCachedProfile, showStartCountdown]);
  useEffect(() => {
    let cancelled = false;
    const manualContexts = new Set(['custom_strength', 'custom_cardio', 'manual_activity', 'apple_health', 'watch', 'coach_log']);
    cachedProfileIsPro()
      .then(isPro => {
        if (!cancelled) {
          setGeneratedWarmupSetsEnabled(isPro && !manualContexts.has(workoutSourceContext));
        }
      })
      .catch(() => {
        if (!cancelled) setGeneratedWarmupSetsEnabled(false);
      });
    return () => { cancelled = true; };
  }, [cachedProfileIsPro, workoutSourceContext]);
  const theme = getTheme(themeName);
  const themeColors = theme.colors;
  const workoutPalette = theme.sections.workout;
  const styles = useMemo(() => createStyles(themeColors), [themeName]);
  const planDisplayFocus = useMemo(() => displayFocusForWorkout(workout), [workout]);
  // Track paired/reachable state for the header. The root start handler
  // owns the watchOS launch request and schedules it after the local
  // countdown so a watch-connection prompt cannot interrupt the overlay.
  const [watchStatus, setWatchStatus] = useState<{ paired: boolean; reachable: boolean } | null>(null);
  const watchSessionId = useRef(getActiveWatchSessionId() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const [watchSessionHydrated, setWatchSessionHydrated] = useState(false);
  const [activeWorkoutStateRestored, setActiveWorkoutStateRestored] = useState(false);
  const watchWorkoutEndedRef = useRef(false);
  // Resolved-module caches for two modules touched on every set log.
  // Without these, each interaction pays the dynamic-import microtask
  // cost (cached by the bundler but the .then() still runs on the
  // next tick), which on cellular contributed to the timer freeze.
  const preloadedFeedbackRef = useRef<typeof import('../utils/feedback') | null>(null);
  const preloadedWatchSyncRef = useRef<typeof import('../utils/watchSync') | null>(null);
  const lastActiveWatchReachabilityPushAtRef = useRef(0);
  // Structural revision counter — bumped only on STRUCTURAL workout
  // edits (add/remove/swap/reorder, warmup or HR-zone change, library
  // reload). A normal set log MUST NOT bump it. Logging used to bump
  // a JSON-stringified key derived from `exercises`, which forced
  // `swapCandidatesForExercise` to run for every exercise on every
  // tap (8× O(library) per render). That was the dominant freeze.
  const [watchPlanRevision, setWatchPlanRevision] = useState(0);
  const watchPlanRevisionRef = useRef(0);
  useEffect(() => { watchPlanRevisionRef.current = watchPlanRevision; }, [watchPlanRevision]);
  const lastWatchPlanRevisionPushedRef = useRef<number | null>(null);
  const scheduleActiveWatchSnapshotPushRef = useRef<(opts?: {
    reason?: 'active_snapshot' | 'pull_state';
    force?: boolean;
    afterLogSetChain?: boolean;
  }) => void>(() => {});
  const swapCandidateCacheRef = useRef<Map<string, SmartSwapItem[]>>(new Map());
  const bumpWatchPlanRevision = useCallback(() => {
    swapCandidateCacheRef.current.clear();
    setWatchPlanRevision(r => r + 1);
  }, []);
  const cancelingWorkoutRef = useRef(false);
  const [cancelingWorkout, setCancelingWorkout] = useState(false);
  const buildWatchWorkoutSnapshotRef = useRef<() => any>(() => workout as any);
  // Persist start time so elapsed timer survives app restart
  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem('activeWorkoutStartTime'),
      AsyncStorage.getItem('activeWorkoutSets'),
      AsyncStorage.getItem('activeWatchSessionId'),
      AsyncStorage.getItem(ACTIVE_WORKOUT_TIMERS_KEY),
      AsyncStorage.getItem(ACTIVE_WORKOUT_PAUSED_AT_KEY),
      AsyncStorage.getItem(ACTIVE_WORKOUT_PAUSED_ACCUM_MS_KEY),
    ]).then(([savedStart, savedSetsRaw, savedSessionIdRaw, savedTimersRaw, savedPausedAtRaw, savedPausedAccumRaw]) => {
      const savedStartMs = savedStart ? parseInt(savedStart, 10) : NaN;
      const hasValidSavedStart = Number.isFinite(savedStartMs) && savedStartMs > 0;
      let hasLoggedSets = false;
      try {
        const savedSets = savedSetsRaw ? JSON.parse(savedSetsRaw) : [];
        hasLoggedSets = Array.isArray(savedSets)
          && savedSets.some((row: any) =>
            (Array.isArray(row?.sets) && row.sets.length > 0)
            || (Array.isArray(row?.warmupSets) && row.warmupSets.length > 0)
          );
      } catch {
        hasLoggedSets = false;
      }
      const hasActiveTimers = hasPersistedActiveWorkoutTimers(savedTimersRaw);
      const savedSessionId = typeof savedSessionIdRaw === 'string' && savedSessionIdRaw.trim().length > 0
        ? savedSessionIdRaw.trim()
        : null;
      const liveSessionId = getActiveWatchSessionId();
      const isSameProcessEmptyStart = Boolean(
        hasValidSavedStart
        && !hasLoggedSets
        && savedSessionId
        && liveSessionId
        && savedSessionId === liveSessionId,
      );
      const isWatchInitiatedEmptyStart = Boolean(
        isSameProcessEmptyStart
        && savedSessionId?.startsWith('watch-')
      );
      if (hasValidSavedStart && (hasLoggedSets || hasActiveTimers || isSameProcessEmptyStart)) {
        setShowStartCountdown(hasLoggedSets || hasActiveTimers || isWatchInitiatedEmptyStart ? false : playStartCountdown);
        startTime.current = savedStartMs;
        const savedPausedAccumMs = savedPausedAccumRaw ? parseInt(savedPausedAccumRaw, 10) : 0;
        const savedPausedAtMs = savedPausedAtRaw ? parseInt(savedPausedAtRaw, 10) : NaN;
        setWorkoutPausedAccumMs(Number.isFinite(savedPausedAccumMs) && savedPausedAccumMs > 0 ? savedPausedAccumMs : 0);
        if (Number.isFinite(savedPausedAtMs) && savedPausedAtMs > savedStartMs) {
          setWorkoutPaused(true);
          setWorkoutPausedAtMs(savedPausedAtMs);
        } else {
          setWorkoutPaused(false);
          setWorkoutPausedAtMs(null);
        }
        if (savedSessionId) {
          watchSessionId.current = savedSessionId;
          setActiveWatchSessionId(savedSessionId);
        } else {
          setActiveWatchSessionId(watchSessionId.current);
        }
        setWatchSessionHydrated(true);
        return;
      }

      startTime.current = Date.now();
      setActiveWatchSessionId(watchSessionId.current);
      if (savedStart && !hasLoggedSets) {
        AsyncStorage.removeItem('activeWorkoutSets').catch(() => {});
        AsyncStorage.removeItem('activeWorkoutRest').catch(() => {});
        AsyncStorage.removeItem(ACTIVE_WORKOUT_TIMERS_KEY).catch(() => {});
        AsyncStorage.removeItem(ACTIVE_WORKOUT_PAUSED_AT_KEY).catch(() => {});
        AsyncStorage.removeItem(ACTIVE_WORKOUT_PAUSED_ACCUM_MS_KEY).catch(() => {});
      }
      setWorkoutPaused(false);
      setWorkoutPausedAtMs(null);
      setWorkoutPausedAccumMs(0);
      AsyncStorage.setItem('activeWorkoutStartTime', String(startTime.current)).catch(() => {});
      AsyncStorage.setItem('activeWatchSessionId', watchSessionId.current).catch(() => {});
      setWatchSessionHydrated(true);
      // Brand-new mount without a pre-seeded session — use the local
      // session id and play the countdown for phone starts. Same-process
      // phone/watch starts reuse their pre-seeded session above.
      setShowStartCountdown(playStartCountdown);
    }).catch(() => {
      startTime.current = Date.now();
      setWorkoutPaused(false);
      setWorkoutPausedAtMs(null);
      setWorkoutPausedAccumMs(0);
      setActiveWatchSessionId(watchSessionId.current);
      AsyncStorage.setItem('activeWorkoutStartTime', String(startTime.current)).catch(() => {});
      AsyncStorage.setItem('activeWatchSessionId', watchSessionId.current).catch(() => {});
      setWatchSessionHydrated(true);
      setShowStartCountdown(playStartCountdown);
    });
    // Pre-load the rest-timer chime so the first set's countdown
    // end fires the audio without a few-hundred-ms decode delay.
    // Idempotent across remounts.
    import('../utils/feedback').then(f => {
      // Pre-resolve the feedback module so subsequent set-log calls
      // get the haptic functions without paying the dynamic-import
      // microtask cost. Same trick for watchSync below — both modules
      // are touched on EVERY set log; resolving them once at workout
      // start avoids sub-100ms stalls during interaction.
      preloadedFeedbackRef.current = f;
      f.preloadRestTimerSound();
    }).catch(() => {});
    import('../utils/watchSync').then(w => {
      preloadedWatchSyncRef.current = w;
    }).catch(() => {});
    return () => {
      if (watchWorkoutEndedRef.current) setActiveWatchSessionId(null);
    };
  }, []);
  useEffect(() => {
    if (!watchSessionHydrated) return;
    AsyncStorage.setItem(ACTIVE_WORKOUT_PAUSED_ACCUM_MS_KEY, String(Math.max(0, Math.round(workoutPausedAccumMs)))).catch(() => {});
    if (workoutPaused && workoutPausedAtMs) {
      AsyncStorage.setItem(ACTIVE_WORKOUT_PAUSED_AT_KEY, String(workoutPausedAtMs)).catch(() => {});
    } else {
      AsyncStorage.removeItem(ACTIVE_WORKOUT_PAUSED_AT_KEY).catch(() => {});
    }
  }, [watchSessionHydrated, workoutPaused, workoutPausedAccumMs, workoutPausedAtMs]);
  // Fetch HR zones for cardio prescriptions, live display, and watch
  // sync. Cached to AsyncStorage with a 24-hour TTL keyed on
  // (RHR, VO2max) — both inputs only change when Apple Health
  // surfaces a new value, so re-fetching every workout was pure
  // waste. Cache hit means the live HR chip + zone-attribution math
  // is available before the network round trip even starts; the
  // background revalidation refreshes the cache without blocking
  // the UI.
  useEffect(() => {
    if (!authToken || showStartCountdown) return;
    let cancelled = false;
    const HR_ZONES_CACHE_KEY = 'hrZonesCache_v1';
    const HR_ZONES_TTL_MS = 24 * 60 * 60 * 1000;
    (async () => {
      if (!(await cachedProfileIsPro()) || cancelled) return;
      // Cache hit path — set zones immediately, then revalidate in background.
      try {
        const raw = await AsyncStorage.getItem(HR_ZONES_CACHE_KEY);
        if (raw && !cancelled) {
          const parsed = JSON.parse(raw);
          const fresh = parsed?.savedAt && Date.now() - parsed.savedAt < HR_ZONES_TTL_MS;
          if (fresh && Array.isArray(parsed.zones) && parsed.zones.length > 0) {
            setHrZones(parsed.zones);
          }
        }
      } catch { /* parse / get failures fall through to network */ }

      const hs: any = await readHealthSummary?.().catch(() => null);
      if (cancelled) return;
      const restingHr = hs?.restingHeartRate;
      const vo2Max = hs?.vo2Max;
      getHRZones(authToken, restingHr, vo2Max)
        .then(r => {
          if (cancelled) return;
          setHrZones(r.zones);
          AsyncStorage.setItem(HR_ZONES_CACHE_KEY, JSON.stringify({
            savedAt: Date.now(),
            restingHr,
            vo2Max,
            zones: r.zones,
          })).catch(() => {});
        })
        .catch(() => {});
    })();
    return () => { cancelled = true; };
  }, [authToken, cachedProfileIsPro, showStartCountdown]);
  // Phone↔watch active-state sync. On mount we push `status: 'active'`
  // AND subscribe to WCSession reachability changes — when the user
  // opens Thallo on their watch, reachability flips to true and we
  // re-push the same payload so the watch wakes up with the current
  // active state instead of whatever stale payload it had cached.
  // Without the re-push, a watch that was closed during the phone
  // workout start would show yesterday's (scheduled) state because
  // iOS only delivers the latest applicationContext once, when the
  // watch app next opens — and even that delivery can race the UI.
  // Visible "syncing watch…" indicator while the first push is in
  // flight. Pre-fix this push ran during the 3-2-1 countdown and the
  // JSON.stringify + native bridge call congested the JS thread,
  // making each digit hang for a beat. Now we defer until the
  // countdown finishes, run async, and surface a small indicator so
  // users see that work is happening — they keep moving while the
  // watch catches up.
  const [watchSyncing, setWatchSyncing] = useState(false);
  const [watchInboundSyncing, setWatchInboundSyncing] = useState(false);
  const watchInboundSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showWatchInboundSyncing = useCallback((durationMs = 1200) => {
    setWatchInboundSyncing(true);
    if (watchInboundSyncTimerRef.current) clearTimeout(watchInboundSyncTimerRef.current);
    watchInboundSyncTimerRef.current = setTimeout(() => {
      watchInboundSyncTimerRef.current = null;
      setWatchInboundSyncing(false);
    }, durationMs);
  }, []);
  useEffect(() => () => {
    if (watchInboundSyncTimerRef.current) clearTimeout(watchInboundSyncTimerRef.current);
  }, []);

  useEffect(() => {
    if (!watchSessionHydrated || !activeWorkoutStateRestored) return;
    // CRITICAL: don't push to the watch while the start countdown is
    // animating. iOS WCSession `updateApplicationContext` and the
    // pre-stringify of a 100KB+ envelope contend for the JS thread
    // and the Animated.sequence completion callbacks fire late —
    // resulting in the "3 hangs forever, then 2 hangs forever, then
    // 1" symptom. Defer until the overlay reports complete.
    if (showStartCountdown) return;
    // Ref-token cleanup: the async import below can resolve AFTER
    // React has already torn this effect down (e.g. workout swap mid-
    // mount). A plain `let unsubscribe` was null at cleanup time, so
    // any listener attached afterward leaked.
    const token = { cancelled: false, unsub: null as (() => void) | null };
    (async () => {
      try {
        const { pushWorkoutToWatch, onWatchReachabilityChange } = await import('../utils/watchSync');
        // Capture the current warmup steps (ref'd so the closure
        // always reads the freshest set — warmupSteps may get
        // replaced when the AI warmup resolves a beat after mount).
        const pushActive = (reason: 'active_snapshot' | 'pull_state' = 'active_snapshot', force = false) => {
          if (!token.cancelled) setWatchSyncing(true);
          const revisionAtPush = watchPlanRevisionRef.current;
          InteractionManager.runAfterInteractions(() => {
            if (token.cancelled || watchWorkoutEndedRef.current) {
              if (!token.cancelled) setWatchSyncing(false);
              return;
            }
            Promise.resolve()
              .then(() => buildWatchWorkoutSnapshotRef.current())
              .then(snapshot => pushWorkoutToWatch(snapshot, {
                dateISO: dateKey(new Date()),
                status: 'active',
                sessionId: watchSessionId.current,
                warmupSteps: warmupStepsRef.current,
                reason,
                force,
              }))
              .then(async (ok) => {
                if (ok) {
                  lastWatchPlanRevisionPushedRef.current = revisionAtPush;
                }
                await pushRestProgressToWatchRef.current();
                reassertRestProgressToWatchRef.current();
              })
              .catch(() => {})
              .finally(() => {
                if (!token.cancelled) setWatchSyncing(false);
              });
          });
        };
        const scheduleActivePush = (opts: {
          reason?: 'active_snapshot' | 'pull_state';
          force?: boolean;
          afterLogSetChain?: boolean;
        } = {}) => {
          const run = () => pushActive(opts.reason ?? 'active_snapshot', opts.force ?? false);
          if (opts.afterLogSetChain) {
            watchLogSetChainRef.current.catch(() => undefined).then(run);
          } else {
            run();
          }
        };
        scheduleActiveWatchSnapshotPushRef.current = scheduleActivePush;
        // Initial push on mount, but kicked off via setTimeout so the
        // current JS tick can settle (rendering, timer state init, etc.)
        // before we start the bridge call. This is the difference
        // between "watch syncs eventually" (good) and "first set tap
        // feels sluggish for 600ms" (bad).
        setTimeout(() => {
          if (!token.cancelled) { scheduleActivePush(); }
        }, 800);
        // Snapshot the current watch status for the active header.
        // Watch launch itself is fired from the root start handler before
        // this screen mounts; doing it here caused a second launch attempt
        // and let the open-watch nudge appear over the 3-2-1 overlay.
        try {
          const paired = WatchBridge.isPaired();
          const reachable = isWatchReachable();
          setWatchStatus({ paired, reachable });
        } catch { /* bridge optional */ }
        // Re-push whenever the watch becomes reachable. Idempotent.
        const unsub = onWatchReachabilityChange((info) => {
          setWatchStatus({ paired: info.paired, reachable: info.reachable });
          if (info.reachable) {
            const now = Date.now();
            if (now - lastActiveWatchReachabilityPushAtRef.current < WATCH_FULL_SYNC_COOLDOWN_MS) {
              return;
            }
            lastActiveWatchReachabilityPushAtRef.current = now;
            scheduleActivePush({ reason: 'active_snapshot', force: true });
          }
        });
        if (token.cancelled) { try { unsub(); } catch {} }
        else { token.unsub = unsub; }
      } catch { /* watch bridge optional */ }
    })();
    return () => {
      token.cancelled = true;
      if (token.unsub) { try { token.unsub(); } catch {} }
    };
  // Snapshot builders and warmup state are read through refs so this effect
  // owns the session lifecycle instead of re-running on every set/recommendation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkoutStateRestored, watchSessionHydrated, showStartCountdown]);

  useEffect(() => {
    if (Platform.OS !== 'ios' || showStartCountdown) return;
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      const likelyWatchActive = watchStatus?.paired || isWatchReachable();
      if (likelyWatchActive) showWatchInboundSyncing(1500);
    });
    return () => sub.remove();
  }, [showStartCountdown, showWatchInboundSyncing, watchStatus?.paired]);

  // Watch→phone command handler. The watch is a remote control for the
  // phone's workout state — log_set commits weight/reps into the same
  // handler the phone UI uses (handleLogSetInline with overrides so we
  // don't round-trip through setInputs); end_workout / cancel_workout
  // forward to the phone's finish/cancel paths. Without this, every
  // watch tap landed in HomeScreen which stays mounted but can only
  // handle start/skip/meal commands — set logs were being dropped.
  // Refs so the once-mounted WC listener can always reach the latest
  // handlers without re-subscribing on every render (re-subscribing
  // churns WatchConnectivity and can drop in-flight messages).
  const handleLogSetInlineRef = useRef<(
    exIdx: number,
    setSlot: number,
    silent?: boolean,
    overrideDuration?: string,
    overrideWeight?: string,
    overrideReps?: string,
    sourceActionAtMs?: number,
    overrideRir?: number,
  ) => Promise<void> | void>(() => {});
  const exercisesRef = useRef<SessionExercise[]>([]);
  const startRestTimerRef = useRef<(seconds: number, exerciseName: string, opts?: { nextTarget?: string; cue?: string; startedAtMs?: number }) => void>(() => {});
  const finishRestTimerRef = useRef<(opts?: FinishRestTimerOptions) => void>(() => {});
  const clearRestStateRef = useRef<(opts?: ClearRestStateOptions) => void>(() => {});
  const rescheduleRestNotificationsRef = useRef<(params: {
    seconds: number;
    exerciseName: string;
    nextSetLabel: string;
    aiCue?: string | null;
    includeStartAlert?: boolean;
  }) => Promise<void>>(async () => {});
  const pushRestProgressToWatchRef = useRef<() => Promise<void>>(async () => {});
  const reassertRestProgressToWatchRef = useRef<(delaysMs?: number[]) => void>(() => {});
  const watchHandlersRef = useRef<{
    finish: () => void;
    cancel: () => void;
  }>({ finish: () => {}, cancel: () => {} });
  const watchSwapExerciseRef = useRef<(exerciseIndex: number, toExerciseName?: string | null) => Promise<void> | void>(() => {});
  const watchAddCircuitRef = useRef<(kind: 'core' | 'stretch') => Promise<void> | void>(() => {});
  const watchLogSetChainRef = useRef<Promise<void>>(Promise.resolve());
  const processedWatchCommandIdsRef = useRef<Set<string>>(new Set());
  const processedWatchCommandIdOrderRef = useRef<string[]>([]);
  const rememberWatchCommandId = useCallback((payload: Record<string, any>): boolean => {
    const commandId = typeof payload?.commandId === 'string' ? payload.commandId.trim() : '';
    if (!commandId) return true;
    const seen = processedWatchCommandIdsRef.current;
    if (seen.has(commandId)) {
      return false;
    }
    seen.add(commandId);
    const order = processedWatchCommandIdOrderRef.current;
    order.push(commandId);
    while (order.length > 200) {
      const dropped = order.shift();
      if (dropped) seen.delete(dropped);
    }
    return true;
  }, []);
  // handlersRef is updated further down once handleFinish / onCancel
  // are in scope (see the `watchHandlersRef.current = ...` assignment
  // below the handleFinish definition).

  useEffect(() => {
    if (showStartCountdown) return;
    // Ref-token cleanup so a teardown that fires before the async
    // import resolves still removes the listener once it attaches.
    const token = {
      cancelled: false,
      consumerRegistered: false,
      unsub: null as (() => void) | null,
    };
    (async () => {
      try {
        const { onWatchCommand } = await import('../utils/watchSync');
        const activeWorkoutCommands = new Set([
          'log_set',
          'skip_rest',
          'swap_exercise',
          'add_exercise',
          'add_circuit',
          'end_workout',
          'cancel_workout',
        ]);
        const commandMatchesCurrentSession = (command: string, payload: Record<string, any>): boolean => {
          if (!activeWorkoutCommands.has(command)) return true;
          const incomingSessionId = typeof payload?.sessionId === 'string' && payload.sessionId.trim().length > 0
            ? payload.sessionId.trim()
            : null;
          if (incomingSessionId && incomingSessionId !== watchSessionId.current) {
            return false;
          }
          const tsMs = Number(payload?.tsMs);
          if (Number.isFinite(tsMs) && tsMs + WATCH_COMMAND_START_GRACE_MS < startTime.current) {
            return false;
          }
          return true;
        };
        const handleWatchCommand = (command: string, payload: Record<string, any>) => {
          recordWatchCommandEvent({ phase: 'received', command, surface: 'active' });
          if (command === 'pull_state') {
            const forcePull = payload?.force === true;
            const now = Date.now();
            if (!forcePull && now - lastActiveWatchReachabilityPushAtRef.current < WATCH_FULL_SYNC_COOLDOWN_MS) {
              return;
            }
            lastActiveWatchReachabilityPushAtRef.current = now;
            // Watch asked for a refresh while we're mid-workout —
            // push `status: 'active'` + current warmup steps so the
            // wrist flips to the active view with fresh content.
            scheduleActiveWatchSnapshotPushRef.current({
              reason: 'pull_state',
              force: forcePull,
              afterLogSetChain: true,
            });
            return;
          }
          if (command === 'cardio_metrics') {
            // Periodic broadcast from the watch's CardioActiveTab —
            // mirror the metrics on the phone so a user glancing at
            // their phone mid-run sees the same numbers as their
            // wrist. Stale checks: drop updates with a sentAtMs older
            // than the most recent we've already rendered (out-of-order
            // arrival via WatchConnectivity is rare but possible).
            const incomingSessionId = typeof payload?.sessionId === 'string' && payload.sessionId.trim().length > 0
              ? payload.sessionId.trim()
              : null;
            if (incomingSessionId && incomingSessionId !== watchSessionId.current) return;
            const sentAtMs = Number(payload?.sentAtMs);
            const now = Date.now();
            const stamp = Number.isFinite(sentAtMs) && sentAtMs > 0 ? sentAtMs : now;
            const distanceMeters = Math.max(0, Number(payload?.distanceMeters) || 0);
            const elapsedSeconds = Math.max(0, Math.round(Number(payload?.elapsedSeconds) || 0));
            const activeCalories = Math.max(0, Number(payload?.activeCalories) || 0);
            const pace = Number(payload?.paceSecPerKm);
            const hr = Number(payload?.heartRate);
            const steps = Number(payload?.steps);
            const elevationGainFt = Number(payload?.elevationGainFt);
            const activityTypeRaw = Number(payload?.activityTypeRaw);
            const normalizedActivityTypeRaw = Number.isFinite(activityTypeRaw) ? activityTypeRaw : null;
            const allowsOutdoorData = cardioAllowsOutdoorDataRef.current;
            const normalizedElevationGainFt = allowsOutdoorData && Number.isFinite(elevationGainFt) && elevationGainFt > 0 ? Math.round(elevationGainFt) : null;
            const estimatedPowerWatts = allowsOutdoorData && normalizedActivityTypeRaw === 13
              ? estimateCyclingPowerWatts({
                  distanceMiles: (distanceMeters / 1000) * MI_PER_KM_LOCAL,
                  durationSeconds: elapsedSeconds,
                  riderWeightLbs: weightLbs,
                  elevationGainFt: normalizedElevationGainFt,
                })
              : null;
            const nextMetrics = {
              activityTypeRaw: normalizedActivityTypeRaw,
              elapsedSeconds,
              distanceMeters,
              activeCalories,
              paceSecPerKm: Number.isFinite(pace) && pace > 0 ? pace : null,
              heartRate: Number.isFinite(hr) && hr > 0 ? Math.round(hr) : null,
              steps: Number.isFinite(steps) && steps > 0 ? Math.round(steps) : null,
              elevationGainFt: normalizedElevationGainFt,
              estimatedPowerWatts,
              lastAccuracyM: null,
              paused: payload?.paused === true,
              receivedAtMs: stamp,
            };
            setLiveCardio((prev) => {
              if (prev && prev.receivedAtMs > stamp) return prev;
              liveCardioRef.current = nextMetrics;
              return nextMetrics;
            });
            const routePoint = allowsOutdoorData ? routeCoordFromPayload(payload?.routePoint) : null;
            if (routePoint && routePoint.t_ms > lastWatchRouteTimestampRef.current) {
              lastWatchRouteTimestampRef.current = routePoint.t_ms;
              const nextRoute = watchRouteCoordsRef.current.length >= 12_000
                ? watchRouteCoordsRef.current
                : [...watchRouteCoordsRef.current, routePoint];
              watchRouteCoordsRef.current = nextRoute;
              setCurrentCoord({ lat: routePoint.lat, lon: routePoint.lon });
              setRouteCoords(nextRoute.map(c => ({ lat: c.lat, lon: c.lon })));
            }
            // HR also goes into liveHR so the existing HR chip / zone
            // computation stays in sync without duplicating logic.
            if (Number.isFinite(hr) && hr > 0) setLiveHR(Math.round(hr));
            return;
          }
          if (command === 'log_hydration') {
            setTimeout(() => {
              if (!claimWatchCommand(command, payload)) return;
              (async () => {
                try {
                  const currentAuthToken = authTokenRef.current;
                  if (!currentAuthToken) return;
                  const commandUserId = typeof payload?.userId === 'string' && payload.userId.trim()
                    ? payload.userId.trim()
                    : null;
                  const currentUserId = await AsyncStorage.getItem('last_user_id').catch(() => null);
                  if (commandUserId && currentUserId && commandUserId !== currentUserId) return;
                  const rawDelta = Number(payload?.deltaOz ?? payload?.delta_oz);
                  const rawOunces = Number(payload?.ounces);
                  const hasDelta = Number.isFinite(rawDelta) && rawDelta !== 0;
                  if (hasDelta && (rawDelta < -400 || rawDelta > 400)) return;
                  if (!hasDelta && (!Number.isFinite(rawOunces) || rawOunces < 0 || rawOunces > 400)) return;
                  const dateISO = String(payload?.dateISO || dateKey(new Date())).slice(0, 10);
                  const result = hasDelta
                    ? await logHydrationDelta(currentAuthToken, rawDelta, dateISO)
                    : await logHydration(currentAuthToken, Math.max(0, Math.round(rawOunces * 10) / 10), dateISO);
                  const fresh = await getHydration(currentAuthToken, result.date).catch(() => null);
                  const fallbackRange = hydrationTargetRangeOz(64);
                  const saved = fresh ?? {
                    date: result.date,
                    ounces: result.ounces,
                    target_ounces: 64,
                    target_ounces_min: fallbackRange?.min,
                    target_ounces_max: fallbackRange?.max,
                  };
                  const { pushHydrationToWatch } = await import('../utils/watchSync');
                  await pushHydrationToWatch({
                    dateISO: saved.date,
                    ounces: saved.ounces,
                    targetOunces: saved.target_ounces,
                    targetOuncesMin: saved.target_ounces_min,
                    targetOuncesMax: saved.target_ounces_max,
                    force: true,
                  });
                } catch { /* hydration sync should not interrupt the workout */ }
              })();
            }, 0);
            return;
          }
          if (!commandMatchesCurrentSession(command, payload)) return;
          if (activeWorkoutCommands.has(command) && !rememberWatchCommandId(payload)) return;
          if (command === 'log_set') {
            showWatchInboundSyncing(1600);
            const exIdx = Number(payload?.exerciseIndex ?? -1);
            const clientExerciseId = typeof payload?.clientExerciseId === 'string' && payload.clientExerciseId.trim()
              ? payload.clientExerciseId.trim()
              : null;
            const incomingSetNumber = Number(payload?.setNumber ?? NaN);
            const weight = payload?.weightLbs;
            const reps = payload?.reps;
            const rir = Number(payload?.rir ?? NaN);
            const durationSeconds = Number(payload?.durationSeconds ?? NaN);
            const actionAtMs = Number(payload?.tsMs ?? NaN);
            watchLogSetChainRef.current = watchLogSetChainRef.current
              .catch(() => undefined)
              .then(async () => {
                const exs = exercisesRef.current;
                const clientMatchedIdx = clientExerciseId
                  ? exs.findIndex(ex => (ex as any).clientExerciseId === clientExerciseId)
                  : -1;
                const resolvedExIdx = clientMatchedIdx >= 0 ? clientMatchedIdx : exIdx;
                if (resolvedExIdx < 0 || !Number.isFinite(resolvedExIdx)) return;
                if (!exs[resolvedExIdx]) return;
                // Prefer the watch's explicit set number so delayed or
                // transferUserInfo-delivered commands still land in the
                // intended slot instead of whatever is currently next.
                const slot = Number.isFinite(incomingSetNumber) && incomingSetNumber > 0
                  ? Math.max(0, Math.floor(incomingSetNumber) - 1)
                  : exs[resolvedExIdx].sets.length;
                await Promise.resolve(handleLogSetInlineRef.current(
                  resolvedExIdx,
                  slot,
                  true, // silent — no Alerts, watch already confirmed
                  Number.isFinite(durationSeconds) && durationSeconds > 0
                    ? formatDurationForInput(durationSeconds)
                    : undefined,
                  weight != null ? String(weight) : undefined,
                  reps != null ? String(reps) : undefined,
                  Number.isFinite(actionAtMs) && actionAtMs > 0 ? actionAtMs : undefined,
                  Number.isFinite(rir) ? Math.max(0, Math.min(4, Math.round(rir))) : undefined,
                )).catch(() => undefined);
              });
            watchLogSetChainRef.current.catch(() => undefined);
          } else if (command === 'skip_rest') {
            const actionAtMs = Number(payload?.tsMs ?? Date.now());
            const clearedAtMs = Number.isFinite(actionAtMs) && actionAtMs > 0 ? actionAtMs : Date.now();
            lastRestClearedAtMsRef.current = Math.max(lastRestClearedAtMsRef.current, clearedAtMs);
            const currentRestStart = restStartAtRef.current;
            if (!currentRestStart || clearedAtMs >= currentRestStart) {
              clearRestStateRef.current();
            }
          } else if (command === 'swap_exercise') {
            const exIdx = Number(payload?.exerciseIndex ?? -1);
            const toExerciseName = typeof payload?.toExerciseName === 'string'
              ? payload.toExerciseName
              : null;
            if (Number.isFinite(exIdx) && exIdx >= 0) {
              Promise.resolve(watchSwapExerciseRef.current(exIdx, toExerciseName)).catch(() => undefined);
            }
          } else if (command === 'add_exercise') {
            // Watch Quick-Add now sends the compact template exercise,
            // not just its name, so phone/watch summaries keep the same
            // prescription and metadata the user picked on their wrist.
            const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
            if (!name) return;
            const clientExerciseId = typeof payload?.clientExerciseId === 'string' && payload.clientExerciseId.trim()
              ? payload.clientExerciseId.trim()
              : null;
            const parsePositiveInt = (value: unknown, fallback: number): number => {
              const parsed = Number(value);
              return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : fallback;
            };
            const parseNonNegativeInt = (value: unknown, fallback: number): number => {
              const parsed = Number(value);
              return Number.isFinite(parsed) && parsed >= 0 ? Math.max(0, Math.round(parsed)) : fallback;
            };
            const nonEmptyString = (value: unknown): string | null => {
              if (typeof value !== 'string') return null;
              const trimmed = value.trim();
              return trimmed ? trimmed : null;
            };
            const targetSets = parsePositiveInt(payload?.targetSets ?? payload?.sets, 3);
            const rawTargetReps = payload?.targetReps ?? payload?.reps;
            const targetReps = nonEmptyString(rawTargetReps)
              ?? (rawTargetReps != null && typeof rawTargetReps !== 'object' ? String(rawTargetReps) : '8-12');
            const targetRestSeconds = parseNonNegativeInt(
              payload?.targetRestSeconds ?? payload?.restSeconds ?? payload?.rest_seconds,
              90,
            );
            const equipment = nonEmptyString(payload?.equipment);
            const primaryMuscle = nonEmptyString(payload?.primaryMuscle ?? payload?.primary_muscle);
            const secondaryMuscles = Array.isArray(payload?.secondaryMuscles)
              ? payload.secondaryMuscles.map((m: unknown) => nonEmptyString(m)).filter(Boolean) as string[]
              : Array.isArray(payload?.secondary_muscles)
                ? payload.secondary_muscles.map((m: unknown) => nonEmptyString(m)).filter(Boolean) as string[]
                : [];
            setExercises(prev => {
              if (clientExerciseId && prev.some(ex => (ex as any).clientExerciseId === clientExerciseId)) return prev;
              if (prev.some(ex => ex.name.toLowerCase() === name.toLowerCase())) return prev;
              const next: SessionExercise = {
                ...(clientExerciseId ? { clientExerciseId } : {}),
                name,
                equipment: equipment ?? 'other',
                targetSets,
                targetReps,
                targetRestSeconds,
                sets: [],
                primaryMuscle,
                secondaryMuscles,
                muscles_targeted: [
                  primaryMuscle,
                  ...secondaryMuscles,
                ].filter(Boolean) as string[],
                isCompound: typeof payload?.isCompound === 'boolean'
                  ? payload.isCompound
                  : typeof payload?.is_compound === 'boolean'
                    ? payload.is_compound
                    : null,
                slug: nonEmptyString(payload?.slug),
                image_url: nonEmptyString(payload?.imageUrl ?? payload?.image_url) ?? undefined,
                video_id: nonEmptyString(payload?.videoId ?? payload?.video_id),
                demo_exercise_db_id: nonEmptyString(payload?.demoExerciseDbId ?? payload?.demo_exercise_db_id),
              } as SessionExercise;
              const updated = [...prev, next];
              setActiveExIdx(updated.length - 1);
              return updated;
            });
            bumpWatchPlanRevision();
            return;
          } else if (command === 'add_circuit') {
            const rawKind = typeof payload?.circuitType === 'string'
              ? payload.circuitType.toLowerCase()
              : '';
            if (rawKind === 'core' || rawKind === 'stretch') {
              showWatchInboundSyncing(1600);
              Promise.resolve(watchAddCircuitRef.current(rawKind)).catch(() => undefined);
            }
            return;
          } else if (command === 'end_workout') {
            if (payload?.activityTypeRaw != null || payload?.distanceMeters != null || payload?.elapsedSeconds != null) {
              const stamp = Number(payload?.sentAtMs) || Date.now();
              const activityTypeRaw = Number(payload?.activityTypeRaw);
              const pace = Number(payload?.paceSecPerKm);
              const hr = Number(payload?.heartRate);
              const steps = Number(payload?.steps);
              const elevationGainFt = Number(payload?.elevationGainFt);
              const normalizedActivityTypeRaw = Number.isFinite(activityTypeRaw) ? activityTypeRaw : liveCardioRef.current?.activityTypeRaw ?? null;
              const elapsedSeconds = Math.max(0, Math.round(Number(payload?.elapsedSeconds) || liveCardioRef.current?.elapsedSeconds || 0));
              const distanceMeters = Math.max(0, Number(payload?.distanceMeters) || liveCardioRef.current?.distanceMeters || 0);
              const allowsOutdoorData = cardioAllowsOutdoorDataRef.current;
              const normalizedElevationGainFt = allowsOutdoorData && Number.isFinite(elevationGainFt) && elevationGainFt > 0 ? Math.round(elevationGainFt) : allowsOutdoorData ? liveCardioRef.current?.elevationGainFt ?? null : null;
              const estimatedPowerWatts = allowsOutdoorData && normalizedActivityTypeRaw === 13
                ? estimateCyclingPowerWatts({
                    distanceMiles: (distanceMeters / 1000) * MI_PER_KM_LOCAL,
                    durationSeconds: elapsedSeconds,
                    riderWeightLbs: weightLbs,
                    elevationGainFt: normalizedElevationGainFt,
                  }) ?? liveCardioRef.current?.estimatedPowerWatts ?? null
                : liveCardioRef.current?.estimatedPowerWatts ?? null;
              const finalMetrics = {
                activityTypeRaw: normalizedActivityTypeRaw,
                elapsedSeconds,
                distanceMeters,
                activeCalories: Math.max(0, Number(payload?.activeCalories) || liveCardioRef.current?.activeCalories || 0),
                paceSecPerKm: Number.isFinite(pace) && pace > 0 ? pace : liveCardioRef.current?.paceSecPerKm ?? null,
                heartRate: Number.isFinite(hr) && hr > 0 ? Math.round(hr) : liveCardioRef.current?.heartRate ?? null,
                steps: Number.isFinite(steps) && steps > 0 ? Math.round(steps) : liveCardioRef.current?.steps ?? null,
                elevationGainFt: normalizedElevationGainFt,
                estimatedPowerWatts,
                lastAccuracyM: allowsOutdoorData ? liveCardioRef.current?.lastAccuracyM ?? null : null,
                paused: payload?.paused === true || liveCardioRef.current?.paused === true,
                receivedAtMs: stamp,
              };
              liveCardioRef.current = finalMetrics;
              setLiveCardio(finalMetrics);
              const routePoint = allowsOutdoorData ? routeCoordFromPayload(payload?.routePoint) : null;
              if (routePoint && routePoint.t_ms > lastWatchRouteTimestampRef.current) {
                lastWatchRouteTimestampRef.current = routePoint.t_ms;
                const nextRoute = watchRouteCoordsRef.current.length >= 12_000
                  ? watchRouteCoordsRef.current
                  : [...watchRouteCoordsRef.current, routePoint];
                watchRouteCoordsRef.current = nextRoute;
                setCurrentCoord({ lat: routePoint.lat, lon: routePoint.lon });
                setRouteCoords(nextRoute.map(c => ({ lat: c.lat, lon: c.lon })));
              }
            }
            (async () => {
              await watchLogSetChainRef.current.catch(() => undefined);
              await new Promise(resolve => setTimeout(resolve, 250));
              await watchLogSetChainRef.current.catch(() => undefined);
              watchHandlersRef.current.finish();
            })();
          } else if (command === 'cancel_workout') {
            watchHandlersRef.current.cancel();
          }
        };
        const unsub = onWatchCommand(handleWatchCommand);
        setActiveWatchCommandConsumerMounted(true);
        token.consumerRegistered = true;
        const queued = await drainActiveWatchCommands().catch(() => []);
        if (!token.cancelled) {
          if (queued.length > 0) showWatchInboundSyncing(1800);
          queued.forEach(({ command, payload }) => handleWatchCommand(command, payload));
        }
        if (token.cancelled) {
          try { unsub(); } catch {}
          if (token.consumerRegistered) {
            setActiveWatchCommandConsumerMounted(false);
            token.consumerRegistered = false;
          }
        }
        else { token.unsub = unsub; }
      } catch { /* watch bridge optional */ }
    })();
    return () => {
      token.cancelled = true;
      if (token.consumerRegistered) {
        setActiveWatchCommandConsumerMounted(false);
        token.consumerRegistered = false;
      }
      if (token.unsub) { try { token.unsub(); } catch {} }
    };
  }, [bumpWatchPlanRevision, cachedProfileIsPro, rememberWatchCommandId, showStartCountdown, showWatchInboundSyncing]);

  const restNotificationIds = useRef<{ startId?: string; warningId?: string; completeId?: string } | null>(null);
  const restDurationSeconds = useRef<number>(0);
  // Ref-based rest timer — avoids interval churn from re-running useEffect every second
  const restTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Active Live Activity ID so we can update/end it from timer callbacks.
  const liveActivityIdRef = useRef<string | null>(null);
  const liveActivityTimerKeyRef = useRef<string | null>(null);
  const liveActivityGenerationRef = useRef(0);
  // One-time per-workout diagnostic flag so the alert only fires on first rest.
  const liveActivityDiagShownRef = useRef<boolean>(false);
  const restStartAtRef = useRef<number>(0);
  const restTotalSecondsRef = useRef<number>(0);
  const restExerciseNameRef = useRef<string | null>(null);
  const lastRestClearedAtMsRef = useRef<number>(0);
  // Timestamp (ms) when the rest timer hit 0 — used to detect "still hasn't
  // logged a set" idle state and show a nudge after threshold.
  const restEndedAtRef = useRef<number>(0);
  const restFinishedKeyRef = useRef<string | null>(null);
  const [postRestIdleSecs, setPostRestIdleSecs] = useState(0);
  // Duration is rendered live by <WorkoutDurationChip> (which owns its
  // own 1Hz interval). For snapshot reads (finish modal, completion
  // payload, summary fallback), use `getElapsedSeconds()` below.
  const getElapsedSeconds = useCallback(
    () => {
      const pause = workoutPauseRef.current;
      const endMs = pause.paused && pause.pausedAtMs ? pause.pausedAtMs : Date.now();
      return Math.max(0, Math.floor((endMs - startTime.current - pause.pausedAccumMs) / 1000));
    },
    [],
  );
  const [liveHR, setLiveHR] = useState<number | null>(null);
  const [hrZones, setHrZones] = useState<HRZone[]>([]);
  // ── Live cardio metrics streamed from the watch ────────────────────
  // Populated only when the watch sends `cardio_metrics` commands —
  // i.e., the user started a run/walk/bike/etc. on the watch and the
  // CardioActiveTab is mounted. Phone surfaces them in the cardio
  // metrics row when activityTypeRaw is set to a cardio HK type.
  type LiveCardioMetrics = {
    activityTypeRaw: number | null;
    elapsedSeconds: number;
    distanceMeters: number;
    activeCalories: number;
    paceSecPerKm: number | null;
    heartRate: number | null;
    steps: number | null;
    elevationGainFt: number | null;
    estimatedPowerWatts: number | null;
    lastAccuracyM: number | null;
    paused: boolean;
    receivedAtMs: number;
  };
  const [liveCardio, setLiveCardio] = useState<LiveCardioMetrics | null>(null);
  const liveCardioRef = useRef<LiveCardioMetrics | null>(null);
  const cardioAllowsOutdoorData = cardioContextAllowsOutdoorData(workout);
  const cardioAllowsOutdoorDataRef = useRef(cardioAllowsOutdoorData);
  const cardioGpsWaitsForExerciseTimer = !isCustomCardioWorkout
    && cardioAllowsOutdoorData
    && (workout.exercises ?? []).some(isOutdoorGpsTimedExercise);
  const cardioGpsWaitsForExerciseTimerRef = useRef(cardioGpsWaitsForExerciseTimer);
  const cardioGpsActiveTimerKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    liveCardioRef.current = liveCardio;
  }, [liveCardio]);
  useEffect(() => {
    cardioAllowsOutdoorDataRef.current = cardioAllowsOutdoorData;
  }, [cardioAllowsOutdoorData]);
  useEffect(() => {
    cardioGpsWaitsForExerciseTimerRef.current = cardioGpsWaitsForExerciseTimer;
    if (!cardioGpsWaitsForExerciseTimer) cardioGpsActiveTimerKeysRef.current.clear();
  }, [cardioGpsWaitsForExerciseTimer]);

  // ── Cardio Live Activity (lock-screen + Dynamic Island) ────────────
  // Mirrors `liveCardio` into the existing ActivityKit pipeline with
  // mode="cardio" so the user sees big elapsed time + distance + pace
  // + calories on their lock screen and Dynamic Island. Reuses the
  // already-installed `thallo-live-activity` native module + the
  // RestTimerWidget extension's cardio rendering branch.
  const cardioActivityIdRef = useRef<string | null>(null);
  const cardioActivityGenerationRef = useRef(0);
  const endCardioLiveActivity = useCallback(() => {
    cardioActivityGenerationRef.current += 1;
    const id = cardioActivityIdRef.current;
    cardioActivityIdRef.current = null;
    if (id) endRestActivity(id).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!liveCardio || watchWorkoutEndedRef.current) return;
    let cancelled = false;
    (async () => {
      const themeColorHex = (themeColors.primary ?? '#15C7B8').toString();
      const baseState = {
        mode: 'cardio' as const,
        exerciseName: planDisplayFocus || 'Cardio',
        setNumber: 0,
        totalSets: 0,
        startedAtMs: Date.now() - liveCardio.elapsedSeconds * 1000,
        durationSeconds: 0,
        endDateMs: Date.now() + 60 * 60 * 1000,  // far-future end; cardio has no countdown
        nextSetRecommendation: '',
        themeColorHex,
        elapsedSeconds: liveCardio.elapsedSeconds,
        heartRate: liveCardio.heartRate,
        distanceMeters: liveCardio.distanceMeters,
        paceSecPerKm: liveCardio.paceSecPerKm,
        activeCalories: liveCardio.activeCalories,
        distanceUnit,
        paused: liveCardio.paused || workoutPaused,
      };
      if (!cardioActivityIdRef.current) {
        const generation = cardioActivityGenerationRef.current + 1;
        cardioActivityGenerationRef.current = generation;
        const id = await startRestActivity(baseState).catch(() => null);
        if (!id) return;
        if (cancelled || cardioActivityGenerationRef.current !== generation) {
          await endRestActivity(id).catch(() => undefined);
          return;
        }
        cardioActivityIdRef.current = id;
      } else {
        await updateRestActivity(cardioActivityIdRef.current, baseState).catch(() => undefined);
      }
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [liveCardio, distanceUnit, themeColors.primary, planDisplayFocus, workoutPaused]);
  useEffect(() => {
    return () => { endCardioLiveActivity(); };
  }, [endCardioLiveActivity]);

  // ── iPhone GPS tracker (used when no watch is reachable) ───────────
  // Mounts once per workout. The tracker writes into the same
  // `liveCardio` state shape that watch updates feed, so the metrics
  // row is data-source-agnostic. Indoor cardio is auto-skipped — for
  // those, distance is logged manually post-workout.
  const cardioGpsHandleRef = useRef<import('../utils/cardioGpsTracker').CardioGpsHandle | null>(null);
  const watchRouteCoordsRef = useRef<RouteCoord[]>([]);
  const lastWatchRouteTimestampRef = useRef(0);
  // Route polyline state for the live map. Updated alongside liveCardio
  // — we re-read the tracker's coords only when a new sample landed,
  // not on every render, so the polyline isn't reflattened needlessly.
  const [routeCoords, setRouteCoords] = useState<ReadonlyArray<{ lat: number; lon: number }>>([]);
  const [currentCoord, setCurrentCoord] = useState<{ lat: number; lon: number } | null>(null);
  const lastRouteLenRef = useRef(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { isOutdoorCardio, startCardioGpsTracker } = await import('../utils/cardioGpsTracker');
      const focus = plannedCardioGpsFocus(workout);
      const activity = activityFromFocus(focus);
      // Skip when:
      //   • not an outdoor cardio sport, OR
      //   • a watch is paired AND reachable — let the watch's
      //     CardioActiveTab own the metric stream and avoid double-
      //     counting distance from two GPS sources.
      if (!isOutdoorCardio(activity) || !cardioAllowsOutdoorDataRef.current) return;
      const watchOwnsMetrics = !!watchStatus?.paired && !!watchStatus?.reachable;
      if (watchOwnsMetrics) return;
      // HK activity rawValues — keep in sync with the same set used
      // for the rendering branch below. The GPS tracker only fires for
      // outdoor activity types, so only those rawValues are needed here.
      const ACTIVITY_RAWS: Record<string, number> = {
        running: 37, walking: 52, hiking: 16, cycling: 13,
      };
      const ACTIVITY_SUBTYPES: Record<string, string> = {
        running: 'run', walking: 'walk', hiking: 'hike', cycling: 'ride',
      };
      const customCardioStyle = String((workout as any)._custom_cardio_style ?? '').trim().toLowerCase();
      const handle = await startCardioGpsTracker({
        activity,
        onSample: (s) => {
          if (cancelled) return;
          const subtype = ACTIVITY_SUBTYPES[activity] ?? activity;
          const cardioStyle = customCardioStyle || (activity === 'walking' ? 'easy' : 'steady');
          const estimatedCalories = estimateActivityCalories({
            durationSeconds: s.elapsedSeconds,
            weightLbs,
            category: 'cardio',
            subtype,
            intensity: 'moderate',
            cardioStyle,
          });
          const elevationGainFt = s.elevationGainFt ?? null;
          const estimatedPowerWatts = activity === 'cycling'
            ? estimateCyclingPowerWatts({
                distanceMiles: (s.distanceMeters / 1000) * MI_PER_KM_LOCAL,
                durationSeconds: s.elapsedSeconds,
                riderWeightLbs: weightLbs,
                elevationGainFt,
              })
            : null;
          setLiveCardio({
            activityTypeRaw: ACTIVITY_RAWS[activity] ?? null,
            elapsedSeconds: s.elapsedSeconds,
            distanceMeters: s.distanceMeters,
            activeCalories: estimatedCalories ?? 0,
            paceSecPerKm: s.paceSecPerKm,
            heartRate: null,
            steps: null,
            elevationGainFt,
            estimatedPowerWatts,
            lastAccuracyM: s.lastAccuracyM,
            paused: workoutPauseRef.current.paused,
            receivedAtMs: Date.now(),
          });
          if (s.lastCoord) setCurrentCoord(s.lastCoord);
          // Refresh the polyline only when a new point actually
          // landed — getRouteCoords copies the array, so polling it
          // every emit would create needless garbage.
          const trackerHandle = cardioGpsHandleRef.current;
          if (trackerHandle) {
            const route = trackerHandle.getRouteCoords();
            if (route.length !== lastRouteLenRef.current) {
              lastRouteLenRef.current = route.length;
              setRouteCoords(route.map(c => ({ lat: c.lat, lon: c.lon })));
            }
          }
        },
        onPermissionDenied: () => {
          if (cancelled) return;
          Alert.alert(
            'Location off',
            'Live distance + pace need location access. Enable it in Settings → Thallo to track outdoor cardio. You can still log the workout manually.',
          );
        },
        onError: (msg) => {
          console.warn('[cardioGps] tracker error:', msg);
        },
      });
      if (cancelled) {
        try { await handle?.stop(); } catch {}
        return;
      }
      cardioGpsHandleRef.current = handle;
      if (workoutPauseRef.current.paused || (
        cardioGpsWaitsForExerciseTimerRef.current
        && cardioGpsActiveTimerKeysRef.current.size === 0
      )) {
        handle?.pause();
      }
    })().catch((e) => {
      console.warn('[cardioGps] start failed:', e?.message ?? e);
    });
    return () => {
      cancelled = true;
      const h = cardioGpsHandleRef.current;
      cardioGpsHandleRef.current = null;
      if (h) { void h.stop().catch(() => undefined); }
      watchRouteCoordsRef.current = [];
      lastWatchRouteTimestampRef.current = 0;
      setRouteCoords([]);
      setCurrentCoord(null);
      lastRouteLenRef.current = 0;
    };
    // The tracker decision is made once per session start; flapping
    // reachability, weight/profile edits, or cardio-style edits mid-run
    // should not restart GPS and risk double-counting distance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workout?.focus]);
  const pauseWorkoutSession = useCallback(() => {
    if (workoutPauseRef.current.paused) return;
    const now = Date.now();
    setWorkoutPaused(true);
    setWorkoutPausedAtMs(now);
    cardioGpsHandleRef.current?.pause();
    setLiveCardio(prev => prev ? {
      ...prev,
      elapsedSeconds: cardioGpsWaitsForExerciseTimerRef.current ? prev.elapsedSeconds : getElapsedSeconds(),
      paused: true,
      receivedAtMs: Date.now(),
    } : prev);
    if (cardioActivityIdRef.current) {
      updateRestActivity(cardioActivityIdRef.current, {
        paused: true,
        elapsedSeconds: getElapsedSeconds(),
        nextSetRecommendation: 'Paused',
      }).catch(() => undefined);
    }
    preloadedFeedbackRef.current?.hapticLight?.();
  }, [getElapsedSeconds]);
  const resumeWorkoutSession = useCallback(() => {
    const pause = workoutPauseRef.current;
    if (!pause.paused) return;
    const now = Date.now();
    const pausedMs = pause.pausedAtMs ? Math.max(0, now - pause.pausedAtMs) : 0;
    const currentElapsed = cardioGpsWaitsForExerciseTimerRef.current
      ? liveCardioRef.current?.elapsedSeconds ?? getElapsedSeconds()
      : getElapsedSeconds();
    setWorkoutPausedAccumMs(prev => prev + pausedMs);
    setWorkoutPaused(false);
    setWorkoutPausedAtMs(null);
    if (!cardioGpsWaitsForExerciseTimerRef.current || cardioGpsActiveTimerKeysRef.current.size > 0) {
      cardioGpsHandleRef.current?.resume();
    }
    setLiveCardio(prev => prev ? {
      ...prev,
      elapsedSeconds: currentElapsed,
      paused: false,
      receivedAtMs: Date.now(),
    } : prev);
    if (cardioActivityIdRef.current) {
      updateRestActivity(cardioActivityIdRef.current, {
        paused: false,
        startedAtMs: now - currentElapsed * 1000,
        elapsedSeconds: currentElapsed,
        nextSetRecommendation: 'Timer running',
      }).catch(() => undefined);
    }
    preloadedFeedbackRef.current?.hapticLight?.();
  }, [getElapsedSeconds]);
  const currentLiveHRZone = useMemo(() => zoneForHeartRate(liveHR, hrZones), [hrZones, liveHR]);
  const currentLiveActivityHrFields = useMemo(() => liveActivityHrZoneFields(liveHR, hrZones), [hrZones, liveHR]);

  useEffect(() => {
    if (Object.keys(currentLiveActivityHrFields).length === 0) return;
    const activityIds = [liveActivityIdRef.current, cardioActivityIdRef.current]
      .filter((id): id is string => !!id);
    activityIds.forEach(activityId => {
      updateRestActivity(activityId, currentLiveActivityHrFields).catch(() => undefined);
    });
  }, [currentLiveActivityHrFields]);

  const endActiveRestLiveActivity = useCallback((opts?: { endAll?: boolean }) => {
    liveActivityGenerationRef.current += 1;
    const activityId = liveActivityIdRef.current;
    liveActivityIdRef.current = null;
    liveActivityTimerKeyRef.current = null;
    if (activityId) endRestActivity(activityId).catch(() => undefined);
    if (opts?.endAll) endAllActivities().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (showStartCountdown) return;
    let active = true;
    let interval: ReturnType<typeof setInterval> | null = null;
    (async () => {
      if (!(await cachedProfileIsPro())) return;
      const healthOn = await isAppleHealthEnabled();
      if (!healthOn || !isHealthKitAvailable() || !active) return;
      const poll = async () => {
        if (!active) return;
        const bpm = await getLatestHeartRate();
        if (active) setLiveHR(bpm);
      };
      poll();
      interval = setInterval(poll, 6000);
    })();
    return () => { active = false; if (interval) clearInterval(interval); };
  }, [cachedProfileIsPro, showStartCountdown]);

  // Post-rest idle counter — ticks every 5s while restEndedAtRef is set.
  // Cleared when a new set is logged or a new rest timer starts.
  useManagedInterval(() => {
    if (restEndedAtRef.current > 0) {
      setPostRestIdleSecs(Math.floor((Date.now() - restEndedAtRef.current) / 1000));
    }
  }, 5000);

  const [exercises, setExercisesRaw] = useState<SessionExercise[]>(() => {
    // Try to restore in-progress session from AsyncStorage
    // (synchronous initializer can't be async, so we override in useEffect below)
    return workout.exercises.map(ex => workoutExerciseToSessionExercise(ex));
  });
  exercisesRef.current = exercises;
  const workoutDisplayFocus = useMemo(
    () => displayFocusForExercises(workout.focus, exercises),
    [workout.focus, exercises],
  );
  // Debounced backend sync of the in-progress workout. It is strictly
  // best-effort: the snapshot builds after interactions, uses a short
  // no-retry request, and never blocks local set logging.
  const syncDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSyncedSetCountRef = useRef(0);
  const partialSyncInFlightRef = useRef(false);
  const syncPartialToBackend = useCallback((sessionExercises: SessionExercise[]) => {
    if (!authToken) return;
    const hasLoggedSet = sessionExercises.some(ex => ex.sets.length > 0 || (ex.warmupSets?.length ?? 0) > 0);
    if (!hasLoggedSet) return;
    const totalSets = sessionExercises.reduce((t, ex) => t + ex.sets.length + (ex.warmupSets?.length ?? 0), 0);
    if (totalSets - lastSyncedSetCountRef.current < 3) return;
    if (syncDebounceRef.current) clearTimeout(syncDebounceRef.current);
    syncDebounceRef.current = setTimeout(() => {
      syncDebounceRef.current = null;
      const snapshot = sessionExercises;
      InteractionManager.runAfterInteractions(() => {
        if (partialSyncInFlightRef.current) return;
        partialSyncInFlightRef.current = true;
        lastSyncedSetCountRef.current = totalSets;
        const payload = snapshot
          .filter(ex => ex.sets.length > 0 || (ex.warmupSets?.length ?? 0) > 0)
          .map((ex, i) => ({
            name: ex.name,
            slug: ex.slug ?? (ex as any).exerciseSlug ?? (ex as any)._slug ?? null,
            target_sets: typeof ex.targetSets === 'number' ? ex.targetSets : undefined,
            target_reps: ex.targetReps,
            equipment: ex.equipment,
            primary_muscle: ex.primaryMuscle ?? ex.primary_muscle ?? null,
            secondary_muscles: ex.secondaryMuscles ?? ex.secondary_muscles ?? null,
            is_compound: ex.isCompound ?? null,
            movement_pattern: ex.movementPattern ?? ex.movement_pattern ?? null,
            order_index: i,
            sets: [
              ...(ex.warmupSets ?? []).map((s, wi, warmups) => ({
                set_number: -(warmups.length - wi),
                reps: s.reps,
                weight_lbs: s.weightLbs,
                duration_seconds: s.durationSeconds ?? null,
                comfort_rating: s.comfortRating ?? null,
                feedback: s.feedback ?? null,
                rir: s.rir ?? null,
                heart_rate_avg: s.heartRateAvg ?? null,
                notes: s.notes ?? null,
                set_type: 'warmup',
              })),
              ...ex.sets.map((s, si) => ({
                set_number: s.setNumber ?? si + 1,
                reps: s.reps,
                weight_lbs: s.weightLbs,
                duration_seconds: s.durationSeconds ?? null,
                comfort_rating: s.comfortRating ?? null,
                feedback: s.feedback ?? null,
                rir: s.rir ?? null,
                heart_rate_avg: s.heartRateAvg ?? null,
                notes: s.notes ?? null,
                set_type: s.setType ?? 'working',
              })),
            ],
          }));
        syncInProgressWorkout(authToken, dateKey(new Date()), workout.focus, payload, {
          sourceContext: workoutSourceContext,
        }, {
          timeoutMs: 3500,
          noRetry: true,
        })
          .then(r => console.log(`[workout sync] ${r.exercises} ex / ${r.sets} sets -> backend`))
          .catch(e => console.warn('[workout sync] failed (non-fatal):', e?.message ?? e))
          .finally(() => {
            partialSyncInFlightRef.current = false;
          });
      });
    }, 1500);
  }, [authToken, workout.focus, workoutSourceContext]);

  // Debounce + defer the AsyncStorage autosave. The serialize +
  // JSON.stringify of the full session blob (8 exercises × N sets ×
  // metadata = up to ~100KB) was running INLINE inside setExercises
  // on every state update — including every set log, every RIR pick,
  // every input keystroke. That synchronous serialization was the
  // single biggest contributor to the visible delay between tap and
  // UI commit on slow devices (50–200ms of pure JS work BEFORE React
  // even started rendering).
  //
  // Now we just stash the latest snapshot into a ref and schedule
  // one autosave at idle; rapid set logs collapse into a single
  // write instead of N writes. Crash recovery is unaffected — the
  // autosave still happens in the same JS process within ~50ms,
  // long before any realistic crash window.
  const pendingAutosaveSnapshotRef = useRef<SessionExercise[] | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushAutosave = useCallback(() => {
    const snapshot = pendingAutosaveSnapshotRef.current;
    if (!snapshot) return;
    pendingAutosaveSnapshotRef.current = null;
    autosaveTimerRef.current = null;
    // Snapshot the recommendation map at flush time. Recommendations
    // live off-tree (recommendationByIdxRef) so set logs don't trigger
    // a second list re-render — the autosave overlays them here so the
    // persisted blob still reflects the latest cue.
    const recOverride = { ...recommendationByIdxRef.current };
    // Run inside InteractionManager so the JSON.stringify lands AFTER
    // the React commit has painted, not before.
    InteractionManager.runAfterInteractions(() => {
      try {
        const payload = JSON.stringify(
          snapshot.map((ex, exerciseIndex) => {
            const serialized = serializeActiveWorkoutExercise(ex, exerciseIndex);
            const liveRec = recOverride[exerciseIndex];
            if (liveRec !== undefined) serialized.aiRecommendation = liveRec.text;
            return serialized;
          })
        );
        AsyncStorage.setItem('activeWorkoutSets', payload).catch(() => {});
      } catch { /* serialization is best-effort */ }
    });
  }, []);

  // Dev-only counter: how many setExercisesRaw calls fire in the
  // current set-log "tap window". Reset by the next handleLogSetInline
  // call. Goal: 1 per normal set log. >1 = a regression.
  const setExercisesCallCountRef = useRef(0);
  const setExercises = useCallback((updater: SessionExercise[] | ((prev: SessionExercise[]) => SessionExercise[])) => {
    const prev = exercisesRef.current;
    const next = typeof updater === 'function'
      ? (updater as (prev: SessionExercise[]) => SessionExercise[])(prev)
      : updater;
    exercisesRef.current = next;
    // Stash the latest snapshot for the autosave; coalesce multiple
    // updates into one write. Schedule the flush ASAP without
    // blocking the React commit.
    pendingAutosaveSnapshotRef.current = next;
    if (!autosaveTimerRef.current) {
      autosaveTimerRef.current = setTimeout(flushAutosave, 50);
    }
    // Also debounce-sync to the backend so per-set detail isn't local-only.
    syncPartialToBackend(next);
    if (__DEV__) setExercisesCallCountRef.current += 1;
    setExercisesRaw(next);
  }, [flushAutosave, syncPartialToBackend]);

  useEffect(() => {
    return () => {
      if (syncDebounceRef.current) clearTimeout(syncDebounceRef.current);
      // Flush pending autosave on unmount so a quick cancel/finish
      // doesn't leave the latest set unwritten. Runs synchronously
      // here (no InteractionManager) because the screen is going
      // away and we want the write to land before the next screen
      // mounts — but only the stringify+setItem, no other work.
      const snapshot = pendingAutosaveSnapshotRef.current;
      if (snapshot) {
        pendingAutosaveSnapshotRef.current = null;
        if (autosaveTimerRef.current) {
          clearTimeout(autosaveTimerRef.current);
          autosaveTimerRef.current = null;
        }
        try {
          const recOverride = recommendationByIdxRef.current;
          AsyncStorage.setItem('activeWorkoutSets', JSON.stringify(
            snapshot.map((ex, exerciseIndex) => {
              const serialized = serializeActiveWorkoutExercise(ex, exerciseIndex);
              const liveRec = recOverride[exerciseIndex];
              if (liveRec !== undefined) serialized.aiRecommendation = liveRec.text;
              return serialized;
            })
          )).catch(() => {});
        } catch { /* best-effort on teardown */ }
      }
    };
  }, []);

  const workoutSidecarQueueRef = useRef<Map<string, WorkoutSidecarTask>>(new Map());
  const workoutSidecarTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workoutSidecarRunningRef = useRef(false);
  const workoutSidecarMountedRef = useRef(true);

  const drainWorkoutSidecarQueue = useCallback(() => {
    if (!workoutSidecarMountedRef.current || workoutSidecarRunningRef.current) return;
    const next = workoutSidecarQueueRef.current.entries().next().value as [string, WorkoutSidecarTask] | undefined;
    if (!next) return;
    const [key, task] = next;
    workoutSidecarQueueRef.current.delete(key);
    if (task.detached) {
      InteractionManager.runAfterInteractions(() => {
        Promise.resolve()
          .then(task.run)
          .catch(e => console.log('[ActiveWorkout] background workout task failed (non-fatal):', e?.message ?? e));
      });
      if (workoutSidecarMountedRef.current && workoutSidecarQueueRef.current.size > 0) {
        workoutSidecarTimerRef.current = setTimeout(drainWorkoutSidecarQueue, 0);
      }
      return;
    }
    workoutSidecarRunningRef.current = true;
    InteractionManager.runAfterInteractions(() => {
      Promise.resolve()
        .then(task.run)
        .catch(e => console.log('[ActiveWorkout] background workout task failed (non-fatal):', e?.message ?? e))
        .finally(() => {
          workoutSidecarRunningRef.current = false;
          if (workoutSidecarMountedRef.current && workoutSidecarQueueRef.current.size > 0) {
            workoutSidecarTimerRef.current = setTimeout(drainWorkoutSidecarQueue, 120);
          }
        });
    });
  }, []);

  const scheduleWorkoutSidecar = useCallback((
    key: string,
    run: () => Promise<void> | void,
    opts?: { delayMs?: number; detached?: boolean },
  ) => {
    if (!workoutSidecarMountedRef.current) return;
    if (workoutSidecarQueueRef.current.has(key)) {
      workoutSidecarQueueRef.current.delete(key);
    }
    workoutSidecarQueueRef.current.set(key, { run, detached: opts?.detached });
    if (workoutSidecarTimerRef.current) clearTimeout(workoutSidecarTimerRef.current);
    workoutSidecarTimerRef.current = setTimeout(() => {
      workoutSidecarTimerRef.current = null;
      drainWorkoutSidecarQueue();
    }, opts?.delayMs ?? 250);
  }, [drainWorkoutSidecarQueue]);

  useEffect(() => () => {
    workoutSidecarMountedRef.current = false;
    if (workoutSidecarTimerRef.current) clearTimeout(workoutSidecarTimerRef.current);
    workoutSidecarQueueRef.current.clear();
  }, []);

  const openEndedCustomLiveActivityEnabled = isCustomCardioWorkout
    && (Array.isArray(workout.exercises) ? workout.exercises.length === 0 : true);

  const buildOpenEndedCustomLiveActivityState = useCallback((): RestActivityState => {
    const now = Date.now();
    const startedAtMs = startTime.current || now;
    const elapsedSeconds = getElapsedSeconds();
    const category = String((workout as any)._custom_activity_category ?? '').trim().toLowerCase();
    const subtype = String((workout as any)._custom_cardio_subtype ?? '').trim().toLowerCase();
    const fallbackName = subtype ? humanizeToken(subtype) : category ? humanizeToken(category) : 'Workout';
    const exerciseName = (planDisplayFocus || workout.focus || fallbackName).trim() || fallbackName;
    const focusBlob = `${exerciseName} ${category} ${subtype}`.toLowerCase();
    const statusText = /yoga|pilates|stretch|mobility|recovery/.test(focusBlob)
      ? 'Recovery timer running'
      : 'Timer running';

    return {
      mode: 'elapsed',
      workoutId: `custom_${watchSessionId.current || startedAtMs}`,
      exerciseName,
      setNumber: 0,
      totalSets: 0,
      startedAtMs,
      durationSeconds: 0,
      endDateMs: startedAtMs + 12 * 60 * 60 * 1000,
      nextSetRecommendation: statusText,
      themeColorHex: theme.colors.primary,
      paused: workoutPaused,
      elapsedSeconds,
      ...liveActivityHrZoneFields(liveHR, hrZones),
    };
  }, [getElapsedSeconds, hrZones, liveHR, planDisplayFocus, theme.colors.primary, workout, workoutPaused]);

  useEffect(() => {
    if (!openEndedCustomLiveActivityEnabled || showStartCountdown || !watchSessionHydrated || !activeWorkoutStateRestored || watchWorkoutEndedRef.current) return;
    let cancelled = false;
    scheduleWorkoutSidecar('custom-open-ended-live-activity', async () => {
      if (cancelled || watchWorkoutEndedRef.current || cardioActivityIdRef.current) return;
      const generation = cardioActivityGenerationRef.current + 1;
      cardioActivityGenerationRef.current = generation;
      try {
        const id = await startRestActivity(buildOpenEndedCustomLiveActivityState());
        if (!id) {
          if (!liveActivityDiagShownRef.current) {
            liveActivityDiagShownRef.current = true;
            const diag = getLastStartDiagnostic();
            if (diag && !diag.startsWith('ok')) {
              console.warn('[ActiveWorkout] Custom workout Live Activity diagnostic:', diag);
            }
          }
          return;
        }
        if (cancelled || watchWorkoutEndedRef.current || cardioActivityGenerationRef.current !== generation) {
          await endRestActivity(id).catch(() => undefined);
          return;
        }
        cardioActivityIdRef.current = id;
      } catch (e) {
        console.warn('[ActiveWorkout] Custom workout Live Activity start failed (non-fatal):', e);
      }
    }, { delayMs: 100, detached: true });
    return () => { cancelled = true; };
  }, [
    activeWorkoutStateRestored,
    buildOpenEndedCustomLiveActivityState,
    openEndedCustomLiveActivityEnabled,
    scheduleWorkoutSidecar,
    showStartCountdown,
    watchSessionHydrated,
  ]);

  // Restore logged sets from a previous interrupted session.
  // Do NOT clear on unmount — the data must survive app kills so
  // the user can resume. It's cleared explicitly on Finish or Cancel.
  useEffect(() => {
    AsyncStorage.getItem('activeWorkoutSets').then(raw => {
      if (!raw) {
        setActiveWorkoutStateRestored(true);
        return;
      }
      try {
        const saved: Array<Record<string, any>> = JSON.parse(raw);
        if (!saved?.length) {
          setActiveWorkoutStateRestored(true);
          return;
        }
        setExercisesRaw(prev => {
          const usedSaved = new Set<number>();
          const next = prev.map((ex, idx) => {
            const byIndex = saved.findIndex(s => Number(s.exerciseIndex) === idx);
            const matchIdx = byIndex >= 0
              ? byIndex
              : saved.findIndex((s, savedIdx) => !usedSaved.has(savedIdx) && s.name === ex.name);
            if (matchIdx < 0) return ex;
            usedSaved.add(matchIdx);
            return restoreSavedSessionExercise(saved[matchIdx], ex);
          });
          saved.forEach((row, savedIdx) => {
            if (usedSaved.has(savedIdx)) return;
            const savedIndex = Number(row.exerciseIndex);
            if (Number.isFinite(savedIndex) && savedIndex >= 0 && savedIndex < next.length) return;
            next.push(restoreSavedSessionExercise(row, savedExerciseFallback(row)));
          });
          exercisesRef.current = next;
          return next;
        });
        console.log(`[ActiveWorkout] restored ${saved.filter(s =>
          (Array.isArray(s.sets) && s.sets.length > 0)
          || (Array.isArray(s.warmupSets) && s.warmupSets.length > 0)
        ).length} exercises with logged sets`);
      } catch {}
      setActiveWorkoutStateRestored(true);
    }).catch(() => { setActiveWorkoutStateRestored(true); });
  }, []);

  // ── Lazy deterministic weight refresh on workout start ──────────────
  // Scan exercises whose `weightRecommendationSource === 'default'` and
  // ask the backend's rule engine for a better anchor before the first set.
  //
  // Skipped:
  //  - exercises that already have a real source (exact_history, sub_group, etc)
  //  - exercises with logged sets restored from a prior session (the
  //    live set-recommendation path takes over from there)
  //  - exercises where the first set is already logged (race-safe)
  //  - workout has no auth token (offline)
  useEffect(() => {
    if (!authToken || showStartCountdown) return;
    let cancelled = false;
    scheduleWorkoutSidecar('initial-weight-refresh', async () => {
      try {
        if (cancelled) return;
        if (!(await cachedProfileIsPro())) return;
        const { getWeightRecommendation } = await import('../services/api');
        const sessionExercises = exercisesRef.current.length > 0 ? exercisesRef.current : exercises;
        const targets = sessionExercises
          .map((ex, i) => ({ ex, i }))
          .filter(({ ex }) =>
            (ex.weightRecommendationSource === 'default' || !ex.weightRecommendationSource)
            && (!ex.sets || ex.sets.length === 0)
            && !shouldHideWeight({ name: ex.name, equipment: ex.equipment, reps: ex.targetReps })
          );
        if (!targets.length) return;
        const updates: Record<number, { name: string; weightLbs: number }> = {};
        for (const { ex, i } of targets) {
          if (cancelled) return;
          const current = exercisesRef.current[i];
          if (!current || current.name !== ex.name || (current.sets?.length ?? 0) > 0) continue;
          try {
            const rec = await getWeightRecommendation(
              authToken, current.name, goal,
              [],  // no logged sets — first time
              1,   // setNumber 1
              {
                targetSets: typeof current.targetSets === 'number' ? current.targetSets : undefined,
                targetReps: current.targetReps,
                experienceLevel: 'intermediate',
                exerciseSlug: current.slug ?? undefined,
                equipment: current.equipment,
                primaryMuscle: current.primaryMuscle ?? undefined,
                plannedTargetWeightLbs: current.targetWeightLbs ?? undefined,
              },
            );
            if (rec && typeof rec.weightLbs === 'number' && rec.weightLbs > 0) {
              updates[i] = { name: current.name, weightLbs: rec.weightLbs };
            }
          } catch {
            // individual misses are fine; this is a background enhancement
          }
          await new Promise<void>(resolve => setTimeout(resolve, 75));
        }
        if (Object.keys(updates).length === 0) return;
        setExercises(prev => prev.map((ex, i) =>
          updates[i] && updates[i].name === ex.name && (!ex.sets || ex.sets.length === 0)
            ? { ...ex, targetWeightLbs: updates[i].weightLbs, weightRecommendationSource: 'default' }
            : ex,
        ));
        console.log(`[ActiveWorkout] deterministic weight refresh: ${Object.keys(updates).length}/${targets.length} exercises updated`);
      } catch (e) {
        console.log('[ActiveWorkout] deterministic weight refresh failed (non-fatal):', e);
      }
    }, { delayMs: 1400, detached: true });
    return () => { cancelled = true; };
    // Run once after the start countdown — we don't want this firing every state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showStartCountdown, scheduleWorkoutSidecar]);

  const [activeExIdx, setActiveExIdx] = useState<number>(0);
  const activeExIdxRef = useRef(activeExIdx);
  useEffect(() => { activeExIdxRef.current = activeExIdx; }, [activeExIdx]);
  const [formVideoExerciseName, setFormVideoExerciseName] = useState<string | null>(null);
  // Tap on the inline equipment thumbnail enlarges it in a sheet so
  // the user can actually see the machine they're about to use without
  // bouncing out to the exercise detail page.
  const [enlargedEquipment, setEnlargedEquipment] = useState<{
    name: string;
    equipment: import('../utils/equipmentImages').EquipmentVisualInput;
  } | null>(null);
  const [formVideoContext, setFormVideoContext] = useState<{
    equipment?: string | null;
    primaryMuscle?: string | null;
    movementPattern?: string | null;
    demoExerciseDbId?: string | null;
  }>({});
  const openFormVideoForExercise = useCallback((exercise: {
    name?: string | null;
    equipment?: string | null;
    primaryMuscle?: string | null;
    primary_muscle?: string | null;
    movementPattern?: string | null;
    movement_pattern?: string | null;
    gear?: Array<{ slug?: string | null; name?: string | null; category?: string | null; required?: boolean | null; role?: string | null }> | null;
    demo_exercise_db_id?: string | null;
    demoExerciseDbId?: string | null;
  } | null | undefined) => {
    if (!exercise?.name) return;
    setFormVideoContext({
      equipment: preferredExerciseVideoEquipment(exercise) ?? exercise.equipment ?? null,
      primaryMuscle: exercise.primaryMuscle ?? exercise.primary_muscle ?? null,
      movementPattern: exercise.movementPattern ?? exercise.movement_pattern ?? null,
      demoExerciseDbId: exercise.demoExerciseDbId ?? exercise.demo_exercise_db_id ?? null,
    });
    setFormVideoExerciseName(exercise.name);
  }, []);
  // Lightweight set-quality prompts feed the deterministic progression
  // engine without blocking the workout: RIR at the top of the target
  // range, and a one-tap reason for major first-set misses.
  const [pendingRir, setPendingRir] = useState<{ exIdx: number; setIdx: number; kind?: 'rir' | 'underperformance' } | null>(null);
  const pendingRirRef = useRef(pendingRir);
  useEffect(() => { pendingRirRef.current = pendingRir; }, [pendingRir]);
  // When the user taps "Swap" on an exercise card we reuse the add-exercise
  // modal but have it REPLACE instead of append. Non-null means we're in
  // swap mode for that exercise index.
  const [swapTargetIdx, setSwapTargetIdx] = useState<number | null>(null);
  // Owned-equipment list pulled from the profile on mount. Used to
  // filter swap candidates so users only see exercises they can
  // actually perform with their gear. Bodyweight is always available.
  const [ownedEquipment, setOwnedEquipment] = useState<string[]>([]);
  const [activeInjuryTokens, setActiveInjuryTokens] = useState<string[]>([]);
  const [exerciseHistorySignals, setExerciseHistorySignals] = useState<Record<string, ExerciseHistorySignal>>({});
  useEffect(() => {
    if (showStartCountdown) return;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('userProfile');
        if (!raw) return;
        const prof = JSON.parse(raw);
        const eq: string[] = Array.isArray(prof?.equipment) ? prof.equipment : [];
        setOwnedEquipment(eq);
        setActiveInjuryTokens(extractActiveInjuryTokens(prof));
      } catch { /* best-effort — fall back to empty list = bodyweight only */ }
    })();
  }, [showStartCountdown]);

  useEffect(() => {
    if (showStartCountdown) return;
    let cancelled = false;
    loadWorkoutHistory()
      .then(rows => {
        if (cancelled) return;
        const signals: Record<string, ExerciseHistorySignal> = {};
        for (const session of rows) {
          if (!session.completed || session.skipped) continue;
          for (const ex of session.exercises ?? []) {
            const key = exerciseHistoryKey(ex.name);
            if (!key) continue;
            const current = signals[key] ?? { count: 0, lastDate: undefined };
            current.count += 1;
            if (!current.lastDate || session.date > current.lastDate) current.lastDate = session.date;
            signals[key] = current;
          }
        }
        setExerciseHistorySignals(signals);
      })
      .catch(() => {
        if (!cancelled) setExerciseHistorySignals({});
      });
    return () => { cancelled = true; };
  }, [showStartCountdown]);

  // Pre-set coach hints keyed by exercise index. Populated lazily when
  // an exercise becomes active with no sets logged yet. Each entry is
  // the structured deterministic recommendation from /recommendations/pre-set.
  const [preSetHints, setPreSetHints] = useState<Record<number, {
    rationale: string;
    setType: string;
    intensityLabel: string;
    recommendedWeight: number | null;
    recommendedReps: string;
    confidence: 'high' | 'medium' | 'low';
    weightHeld?: boolean;
    aiSafety?: RecommendationAiSafety | null;
  }>>({});
  const [preSetLoadingIdx, setPreSetLoadingIdx] = useState<number | null>(null);
  // Rolling estimated 1RM per exercise name, fetched lazily when an
  // exercise card becomes active. null = no estimate (isolation lift,
  // too few logged sets, or non-Pro). Cached per name.
  const [e1rmByName, setE1rmByName] = useState<Record<string, E1RMEstimate | null>>({});

  // Fetch a pre-set recommendation the first time a given exercise
  // card is in focus with no sets logged yet. Deterministic endpoint
  // (zero AI cost on the normal path), so we can fire this freely.
  // Skips if already cached. Uses last session data looked up via
  // getLastSetsForExercise to ground the opening weight suggestion.
  useEffect(() => {
    if (showStartCountdown) {
      setPreSetLoadingIdx(null);
      return;
    }
    const ex = exercises[activeExIdx];
    if (!ex || !authToken) {
      setPreSetLoadingIdx(prev => prev === activeExIdx ? null : prev);
      return;
    }
    if (isGuideExercise(ex, workout)) {
      setPreSetLoadingIdx(prev => prev === activeExIdx ? null : prev);
      setPreSetHints(prev => {
        if (!prev[activeExIdx]) return prev;
        const next = { ...prev };
        delete next[activeExIdx];
        return next;
      });
      return;
    }
    if (ex.sets.length > 0 || preSetHints[activeExIdx]) {
      setPreSetLoadingIdx(prev => prev === activeExIdx ? null : prev);
      return;
    }
    let cancelled = false;
    scheduleWorkoutSidecar(`pre-set-hint-${activeExIdx}`, async () => {
      const currentEx = exercisesRef.current[activeExIdx];
      if (
        cancelled
        || activeExIdxRef.current !== activeExIdx
        || !currentEx
        || currentEx.name !== ex.name
        || currentEx.sets.length > 0
      ) {
        return;
      }
      setPreSetLoadingIdx(activeExIdx);
      try {
        const lastSets = await loadLastSetsForExerciseAnySource(currentEx, loadBackendWorkoutHistory, {
          workoutDate: dateKey(new Date()),
          focus: workout.focus,
        });
        const plannedSets = plannedSetsForLiveRecommendation(currentEx);
        const rec = await getPreSetRecommendation(authToken, {
          exerciseName: currentEx.name,
          exerciseSlug: currentEx.slug ?? undefined,
          plannedSetNumber: 1,
          plannedSets,
          priorSetsThisSession: [],
          lastSessionSets: (lastSets ?? []).map(s => ({
            reps: s.reps,
            weightLbs: s.weightLbs,
            sessionDate: s.sessionDate,
            completedAt: s.completedAt,
          })),
          goal,
          equipment: typeof currentEx.equipment === 'string' ? currentEx.equipment : undefined,
          primaryMuscle: currentEx.primaryMuscle ?? undefined,
          weightLbs,
        });
        const latestEx = exercisesRef.current[activeExIdx];
        if (
          cancelled
          || activeExIdxRef.current !== activeExIdx
          || !latestEx
          || latestEx.name !== currentEx.name
          || latestEx.sets.length > 0
        ) {
          return;
        }
        const aiSafetyHeld = shouldHoldAiSafetyRecommendation(rec.aiSafety);
        setPreSetHints(prev => ({
          ...prev,
          [activeExIdx]: {
            rationale: aiSafetyHeld ? 'Use a comfortable load; recommendation is under review.' : rec.rationaleShort,
            setType: rec.setType,
            intensityLabel: rec.intensityLabel,
            recommendedWeight: aiSafetyHeld ? null : rec.recommendedWeightLbs,
            recommendedReps: rec.recommendedReps,
            confidence: rec.confidence,
            weightHeld: aiSafetyHeld,
            aiSafety: rec.aiSafety ?? null,
          },
        }));
        if (rec.aiSafety?.status === 'pending' && rec.aiSafety.cacheKey) {
          const cacheKey = rec.aiSafety.cacheKey;
          scheduleWorkoutSidecar(`pre-set-ai-safety-${activeExIdx}`, async () => {
            let status: RecommendationAiSafety | null = null;
            for (const delayMs of [1200, 2200, 4000]) {
              await waitForRecommendationSafetyPoll(delayMs);
              if (cancelled) return;
              try {
                status = await getRecommendationAiSafetyStatus(authToken, cacheKey);
              } catch {
                return;
              }
              if (status.status !== 'pending') break;
            }
            const latestAfterReview = exercisesRef.current[activeExIdx];
            if (
              cancelled
              || activeExIdxRef.current !== activeExIdx
              || !latestAfterReview
              || latestAfterReview.name !== currentEx.name
              || latestAfterReview.sets.length > 0
              || !status
            ) {
              return;
            }
            const holdAfterReview = shouldHoldAiSafetyRecommendation(status);
            setPreSetHints(prev => {
              const existing = prev[activeExIdx];
              if (!existing) return prev;
              return {
                ...prev,
                [activeExIdx]: {
                  ...existing,
                  rationale: holdAfterReview ? 'Use a comfortable load; recommendation is under review.' : rec.rationaleShort,
                  recommendedWeight: holdAfterReview ? null : rec.recommendedWeightLbs,
                  weightHeld: holdAfterReview,
                  aiSafety: status,
                },
              };
            });
          }, { delayMs: 0, detached: true });
        }
      } catch {
        // silent — hint is additive, absence is fine
      } finally {
        if (!cancelled) {
          setPreSetLoadingIdx(prev => prev === activeExIdx ? null : prev);
        }
      }
    }, { delayMs: 650, detached: true });
    return () => { cancelled = true; };
  }, [activeExIdx, exercises, authToken, goal, weightLbs, workout.focus, workout.stimulus, preSetHints, loadBackendWorkoutHistory, showStartCountdown, scheduleWorkoutSidecar]);

  // Lazily fetch the rolling estimated-1RM for the active exercise.
  // Deterministic + server-cached; cache per name so switching back
  // doesn't refetch. Pro-gated — a 403 just caches null.
  useEffect(() => {
    const ex = exercises[activeExIdx];
    if (!ex || !authToken) return;
    const key = ex.name.trim().toLowerCase();
    if (!key || key in e1rmByName) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await getE1RM(authToken, ex.name);
        if (!cancelled) setE1rmByName(prev => ({ ...prev, [key]: res.e1rm ?? null }));
      } catch {
        if (!cancelled) setE1rmByName(prev => ({ ...prev, [key]: null }));
      }
    })();
    return () => { cancelled = true; };
  }, [activeExIdx, exercises, authToken, e1rmByName]);

  // Inline set inputs: keyed by "exIdx-setSlot" (0-based slot index)
  const [setInputs, setSetInputs] = useState<Record<string, SetInputDraft>>({});
  const setInputsRef = useRef(setInputs);
  useLayoutEffect(() => { setInputsRef.current = setInputs; }, [setInputs]);
  // Track which individual fields the user has touched (typed in, cleared,
  // or stepped with the ± buttons). Untouched fields show the recommended
  // fallback as their value; touched fields are purely user-controlled so
  // clearing the input stays cleared instead of immediately re-filling
  // from the recommendation. Keys are `${inputKey}:weight` / `:reps`.
  const [touchedSetFields, setTouchedSetFields] = useState<Set<string>>(new Set());
  const markSetFieldTouched = useCallback((fieldKey: string) => {
    setTouchedSetFields(prev => {
      if (prev.has(fieldKey)) return prev;
      const next = new Set(prev);
      next.add(fieldKey);
      return next;
    });
  }, []);
  const mergeSetInput = useCallback((key: string, patch: Partial<SetInputDraft>) => {
    setSetInputs(prev => ({
      ...prev,
      [key]: {
        ...(prev[key] ?? { weight: '', reps: '', duration: '' }),
        ...patch,
      },
    }));
  }, []);

  const weightUnitStepForExercise = useCallback((ex: SessionExercise): number => {
    const lbsStep = loadIncrementForSessionExercise(ex);
    if (weightUnit === 'kg') {
      if (lbsStep >= 9.5) return 5;
      if (lbsStep >= 4.5) return 2.5;
      return 1;
    }
    return lbsStep > 0 ? lbsStep : 5;
  }, [weightUnit]);

  const adjustSmartSetWeight = useCallback((key: string, ex: SessionExercise, currentText: string, delta: number) => {
    const current = Number.parseFloat(currentText);
    const base = Number.isFinite(current) ? current : 0;
    const step = weightUnitStepForExercise(ex);
    const next = Math.max(0, base + delta);
    const rounded = step > 0 ? Math.round(next / step) * step : next;
    mergeSetInput(key, { weight: formatStepperNumber(rounded) });
    preloadedFeedbackRef.current?.hapticSelection();
  }, [mergeSetInput, weightUnitStepForExercise]);

  const adjustSmartSetReps = useCallback((key: string, currentText: string, delta: number) => {
    const current = Number.parseInt(currentText, 10);
    const base = Number.isFinite(current) ? current : 0;
    const next = Math.max(1, base + delta);
    mergeSetInput(key, { reps: String(next) });
    preloadedFeedbackRef.current?.hapticSelection();
  }, [mergeSetInput]);

  const smartRepChoicesForExercise = useCallback((ex: SessionExercise): number[] => {
    const min = parseTargetRepMin(ex.targetReps);
    const max = parseTargetRepMax(ex.targetReps);
    if (min != null && max != null && max > min) {
      const mid = Math.round((min + max) / 2);
      return uniquePositiveInts([min, mid, max]);
    }
    const anchor = min ?? max ?? 10;
    return uniquePositiveInts([anchor - 2, anchor, anchor + 2]);
  }, []);

  const applySmartSetPreset = useCallback((
    key: string,
    preset: { weightLbs?: number | null; reps?: number | string | null },
  ) => {
    const patch: Partial<SetInputDraft> = {};
    if (preset.weightLbs != null && Number.isFinite(Number(preset.weightLbs)) && Number(preset.weightLbs) >= 0) {
      patch.weight = displayWeightNumber(Number(preset.weightLbs));
    }
    const parsedReps = typeof preset.reps === 'number'
      ? preset.reps
      : parseTargetRepMin(preset.reps ?? null);
    if (parsedReps != null && parsedReps > 0) {
      patch.reps = String(parsedReps);
    }
    if (Object.keys(patch).length > 0) {
      mergeSetInput(key, patch);
      preloadedFeedbackRef.current?.hapticSelection();
    }
  }, [displayWeightNumber, mergeSetInput]);

  // Animated TextInput so we can lerp borderColor / borderWidth on
  // focus. Memo'd once — React's createAnimatedComponent returns a
  // new class each call, so we don't want to rebuild on every render.
  const AnimatedTextInput = useMemo(() => Animated.createAnimatedComponent(TextInput), []);

  // Stored scale values + ref-tracked "was-logged" flags so the set badge
  // can spring-pop specifically on the false→true transition (not every
  // re-render where `isLogged` happens to be true).
  const setBadgeScales = useRef<Record<string, Animated.Value>>({}).current;
  const setBadgeWasLogged = useRef<Record<string, boolean>>({}).current;
  const getSetBadgeScale = (key: string): Animated.Value => {
    if (!setBadgeScales[key]) setBadgeScales[key] = new Animated.Value(1);
    return setBadgeScales[key];
  };
  const popSetBadge = (key: string) => {
    const v = getSetBadgeScale(key);
    v.stopAnimation();
    v.setValue(0.5);
    Animated.spring(v, {
      toValue: 1,
      friction: 4,
      tension: 140,
      useNativeDriver: true,
    }).start();
  };

  // Exercise-complete animation: fires once when the Nth and final set
  // lands. Drives a big check stamp that bounces in above the exercise
  // name. Keyed by exercise index.
  const exerciseCompleteScales = useRef<Record<number, Animated.Value>>({}).current;
  const exerciseCompleteWasDone = useRef<Record<number, boolean>>({}).current;
  const getExerciseCompleteScale = (idx: number): Animated.Value => {
    if (!exerciseCompleteScales[idx]) exerciseCompleteScales[idx] = new Animated.Value(0);
    return exerciseCompleteScales[idx];
  };
  const playExerciseCompleteStamp = (idx: number) => {
    const v = getExerciseCompleteScale(idx);
    v.stopAnimation();
    v.setValue(0);
    Animated.sequence([
      Animated.spring(v, { toValue: 1.15, friction: 5, tension: 120, useNativeDriver: true }),
      Animated.spring(v, { toValue: 1.0,  friction: 8, tension: 140, useNativeDriver: true }),
    ]).start(() => {
      for (let slot = 0; slot < 20; slot++) {
        const base = `${idx}-${slot}`;
        delete setBadgeScales[base];
        delete setBadgeWasLogged[base];
        delete setPulseValues[base];
        delete inputFocusValues[`${base}-weight`];
        delete inputFocusValues[`${base}-reps`];
      }
    });
  };
  // Pulse animation values keyed by "exIdx-setSlot". Drives the green
  // flash-fade that runs when a set is successfully logged. We lazily
  // allocate an Animated.Value per row and reuse it across re-renders.
  const setPulseValues = useRef<Record<string, Animated.Value>>({}).current;
  const getSetPulse = (key: string): Animated.Value => {
    if (!setPulseValues[key]) setPulseValues[key] = new Animated.Value(0);
    return setPulseValues[key];
  };
  // Focus animation values keyed by "exIdx-setSlot-axis" (weight|reps).
  // Drives the border-color/width lerp on the inline input when it
  // gains/loses focus. 0 = blurred, 1 = focused.
  const inputFocusValues = useRef<Record<string, Animated.Value>>({}).current;
  const getInputFocus = (key: string): Animated.Value => {
    if (!inputFocusValues[key]) inputFocusValues[key] = new Animated.Value(0);
    return inputFocusValues[key];
  };
  const setInputFocus = (key: string, focused: boolean) => {
    const v = getInputFocus(key);
    Animated.timing(v, {
      toValue: focused ? 1 : 0,
      duration: 150,
      useNativeDriver: false, // animating borderColor / borderWidth
    }).start();
  };
  const triggerSetPulse = (key: string) => {
    const v = getSetPulse(key);
    v.stopAnimation();
    v.setValue(0);
    Animated.sequence([
      // Color / background is non-native-driver (layout prop). Short
      // sequence so the flash is legible but doesn't linger.
      Animated.timing(v, { toValue: 1, duration: 250, useNativeDriver: false }),
      Animated.timing(v, { toValue: 0, duration: 400, useNativeDriver: false }),
    ]).start();
  };

  // Extra set rows added by user beyond target set count
  const [extraSetCounts, setExtraSetCounts] = useState<Record<number, number>>({});
  /** Number of unlogged sets the user explicitly removed per exercise.
   *  Decreases the effective target so the row disappears from the UI
   *  without affecting any sets they already logged. */
  const [removedSetCounts, setRemovedSetCounts] = useState<Record<number, number>>({});
  const [dismissedWarmupSuggestionKeys, setDismissedWarmupSuggestionKeys] = useState<Record<number, string[]>>({});

  const getEffectiveTargetSetCount = useCallback((exIdx: number, exercise?: SessionExercise, minCount = 0) => {
    const ex = exercise ?? exercises[exIdx];
    if (!ex) return minCount;
    const base = getExerciseTargetSetCount(ex);
    const extras = extraSetCounts[exIdx] ?? 0;
    const removed = removedSetCounts[exIdx] ?? 0;
    return Math.max(base + extras - removed, minCount);
  }, [exercises, extraSetCounts, removedSetCounts]);
  const getEffectiveTargetSetCountRef = useRef(getEffectiveTargetSetCount);
  useEffect(() => { getEffectiveTargetSetCountRef.current = getEffectiveTargetSetCount; }, [getEffectiveTargetSetCount]);
  useEffect(() => { bumpWatchPlanRevision(); }, [extraSetCounts, removedSetCounts, bumpWatchPlanRevision]);

  const handleDismissWarmupSuggestion = useCallback((exIdx: number, set: CompletedSet) => {
    const key = warmupSuggestionKey(set);
    setDismissedWarmupSuggestionKeys(prev => {
      const current = prev[exIdx] ?? [];
      if (current.includes(key)) return prev;
      return { ...prev, [exIdx]: [...current, key] };
    });
    preloadedFeedbackRef.current?.hapticSelection();
  }, []);

  const buildWatchExerciseCompletionProgress = useCallback((sourceExercises: SessionExercise[] = exercisesRef.current) => {
    const exerciseCompletion = sourceExercises.map((ex, exerciseIndex) => {
      const completedSets = Array.isArray(ex.sets) ? ex.sets.filter(Boolean).length : 0;
      const minTargetSets = Math.max(isSetlessCardioExercise(ex) ? 0 : 1, completedSets);
      const targetSets = getEffectiveTargetSetCountRef.current(exerciseIndex, ex, minTargetSets);
      return {
        exerciseIndex,
        completedSets,
        targetSets,
        isDone: completedSets >= targetSets,
      };
    });
    return {
      completedExerciseIndexes: exerciseCompletion
        .filter(row => row.isDone)
        .map(row => row.exerciseIndex),
      exerciseCompletion,
    };
  }, []);

  useEffect(() => {
    if (!warmupDone) return;
    const activeExerciseIndexes = new Set<number>();
    exercises.forEach((ex, i) => {
      activeExerciseIndexes.add(i);
      const totalSetCount = getEffectiveTargetSetCount(i, ex, ex.sets.length);
      const isDone = ex.sets.length >= totalSetCount;
      if (isDone && !exerciseCompleteWasDone[i]) {
        exerciseCompleteWasDone[i] = true;
        playExerciseCompleteStamp(i);
      } else if (!isDone && exerciseCompleteWasDone[i]) {
        exerciseCompleteWasDone[i] = false;
        getExerciseCompleteScale(i).setValue(0);
      }
    });
    for (const rawIdx of Object.keys(exerciseCompleteWasDone)) {
      const idx = Number(rawIdx);
      if (!activeExerciseIndexes.has(idx)) {
        delete exerciseCompleteWasDone[idx];
        delete exerciseCompleteScales[idx];
      }
    }
  }, [exercises, getEffectiveTargetSetCount, warmupDone]);

  useEffect(() => {
    if (!warmupDone) return;
    const activeBadgeKeys = new Set<string>();
    exercises.forEach((ex, i) => {
      const totalSetCount = getEffectiveTargetSetCount(i, ex, ex.sets.length);
      for (let slot = 0; slot < totalSetCount; slot += 1) {
        const badgeKey = `${i}-${slot}`;
        activeBadgeKeys.add(badgeKey);
        const isLogged = slot < ex.sets.length;
        const badgeScale = getSetBadgeScale(badgeKey);
        if (isLogged && !setBadgeWasLogged[badgeKey]) {
          setBadgeWasLogged[badgeKey] = true;
          popSetBadge(badgeKey);
        } else if (!isLogged && setBadgeWasLogged[badgeKey]) {
          setBadgeWasLogged[badgeKey] = false;
          badgeScale.setValue(1);
        }
      }
    });
    for (const badgeKey of Object.keys(setBadgeWasLogged)) {
      if (!activeBadgeKeys.has(badgeKey)) delete setBadgeWasLogged[badgeKey];
    }
  }, [exercises, getEffectiveTargetSetCount, warmupDone]);

  // Canonical live recommendation cache keyed by exercise index. Mutating this ref
  // must NEVER call setExercises — that was the second list re-render
  // per set log on top of the actual set commit. Watch snapshot
  // builder + autosave serializer both read from this ref, falling
  // back to the value persisted on the exercise object only when the
  // ref is empty (e.g. after a fresh hydrate before any refresh runs).
  const recommendationByIdxRef = useRef<Record<number, LiveRecommendationCue | undefined>>({});
  const writeRecommendation = useCallback((exIdx: number, value: string | LiveRecommendationCue | undefined) => {
    const next = { ...recommendationByIdxRef.current };
    if (value === undefined) {
      delete next[exIdx];
    } else {
      next[exIdx] = typeof value === 'string' ? { text: value } : value;
    }
    recommendationByIdxRef.current = next;
  }, []);

  const clearLiveRecommendationState = useCallback((exIdx: number, opts?: { preserveNextTarget?: boolean }) => {
    writeRecommendation(exIdx, undefined);
    if (!opts?.preserveNextTarget) setRestNextTarget(null);
    setRestCue(null);
    setAiErrorIdx(null);
  }, [writeRecommendation]);
  const maybeRefreshRecommendationForExerciseRef = useRef<((
    exIdx: number,
    setsForExercise: CompletedSet[],
    opts?: { ignorePendingRir?: boolean },
  ) => Promise<void>) | null>(null);

  // Log-set modal (kept for extra sets beyond targetSets)
  const [logModalVisible, setLogModalVisible] = useState(false);
  const [logExIdx, setLogExIdx] = useState<number>(0);
  const [logWeight, setLogWeight] = useState('');
  const [logReps, setLogReps] = useState('');

  // Edit logged set modal (legacy — kept for backward compat)
  const [editSetVisible, setEditSetVisible] = useState(false);
  const [editSetExIdx, setEditSetExIdx] = useState(0);
  const [editSetIdx, setEditSetIdx] = useState(0);
  const [editSetWeight, setEditSetWeight] = useState('');
  const [editSetReps, setEditSetReps] = useState('');

  // Inline edit of logged sets — tap directly on the weight/reps field
  const [editingSetKey, setEditingSetKey] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ weight?: string; reps?: string }>({});
  const editCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Per-set notes — `notesEditingKey` controls which set's note input
  // is currently expanded for editing. Notes are stored on the
  // CompletedSet itself and round-trip through the workout sync payload.
  const [notesEditingKey, setNotesEditingKey] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState<string>('');

  // Plate calculator — shows the per-side plate breakdown for a
  // barbell weight. Caller writes back the chosen total via onApply.
  const [plateCalcTarget, setPlateCalcTarget] = useState<{
    exIdx: number;
    slot: number;
    weightLbs: number;
    kind?: 'working' | 'warmup';
  } | null>(null);

  // Inline set entry modal — replaces the per-row weight/reps
  // TextInputs with a focused popup. Track which row is open.
  const [setEntryTarget, setSetEntryTarget] = useState<{
    exIdx: number;
    slot: number;
    kind?: 'working' | 'warmup';
    fallbackWeight?: string;
    fallbackReps?: string;
  } | null>(null);
  const commitSetNote = useCallback((exIdx: number, slot: number, value: string) => {
    const trimmed = value.trim();
    setExercises(prev => prev.map((e, ei) => {
      if (ei !== exIdx) return e;
      const sets = e.sets.slice();
      if (sets[slot]) {
        const next = { ...sets[slot] };
        if (trimmed) next.notes = trimmed;
        else delete (next as any).notes;
        sets[slot] = next;
      }
      return { ...e, sets };
    }));
  }, []);

  const handleLogWarmupSet = useCallback((
    exIdx: number,
    slot: number,
    weightText: string,
    repsText: string,
  ) => {
    const ex = exercisesRef.current[exIdx];
    if (!ex) return;
    const exMeta = {
      name: ex.name,
      equipment: ex.equipment,
      reps: ex.targetReps,
      primaryMuscle: ex.primaryMuscle,
      primary_muscle: (ex as any).primary_muscle,
      _primary_muscle: (ex as any)._primary_muscle,
      _archetype: (ex as any)._archetype,
      _training_type: (ex as any)._training_type,
    };
    const skipWeight = shouldHideWeight(exMeta);
    const skipReps = shouldHideReps(exMeta);
    const weightLbs = skipWeight ? 0 : parseInputWeightLbs(weightText);
    const reps = skipReps ? 0 : Number.parseInt(repsText || '0', 10);
    if (!skipWeight && (!Number.isFinite(weightLbs) || weightLbs < 0)) {
      Alert.alert('Enter values', 'Fill in weight before logging this warm-up set.');
      return;
    }
    if (!skipReps && (!Number.isFinite(reps) || reps <= 0)) {
      Alert.alert('Enter values', 'Fill in reps before logging this warm-up set.');
      return;
    }
    const warmupSet: CompletedSet = {
      setNumber: slot + 1,
      reps,
      weightLbs,
      setType: 'warmup',
    };
    setExercises(prev => prev.map((e, ei) => {
      if (ei !== exIdx) return e;
      const warmupSets = [...(e.warmupSets ?? [])];
      warmupSets[slot] = warmupSet;
      return {
        ...e,
        warmupSets: warmupSets.filter(Boolean).map((set, idx) => ({
          ...set,
          setNumber: idx + 1,
          setType: 'warmup' as const,
        })),
      };
    }));
    preloadedFeedbackRef.current?.hapticMedium();
    if (!workoutStartedRef.current && authToken) {
      workoutStartedRef.current = true;
      scheduleWorkoutSidecar('workout-started', async () => {
        try {
          await logWorkoutStarted(authToken, dateKey(new Date()), workout.focus, workout.stimulus, {
            timeoutMs: 2500,
            noRetry: true,
          });
        } catch { /* best-effort */ }
      }, { detached: true });
    }
  }, [authToken, parseInputWeightLbs, scheduleWorkoutSidecar, workout.focus, workout.stimulus]);

  const handleDeleteWarmupSet = useCallback((exIdx: number, slot: number) => {
    setExercises(prev => prev.map((e, ei) => {
      if (ei !== exIdx) return e;
      const warmupSets = (e.warmupSets ?? []).filter((_set, idx) => idx !== slot)
        .map((set, idx) => ({ ...set, setNumber: idx + 1, setType: 'warmup' as const }));
      return { ...e, warmupSets };
    }));
  }, []);

  // Track whether we've sent the "workout started" signal to the backend
  const workoutStartedRef = useRef(false);

  // Auto rest timer between sets
  // Boundary state — set when rest starts (=total) and when rest ends
  // (=0). The PARENT no longer ticks this on every interval fire.
  // The actual visible countdown lives in <RestTimerPanel>, which
  // owns its own 500ms interval and re-renders only itself. See the
  // long comment block in RestTimerPanel.tsx for the why.
  const [restRemaining, setRestRemaining] = useState(0);
  // Wall-clock end time. When non-null, rest is active. RestTimerPanel
  // computes its visible countdown from this directly so adjust(+/-15)
  // is reflected without going through parent state.
  const [restEndsAtMs, setRestEndsAtMs] = useState<number | null>(null);
  const [restTotalForPanel, setRestTotalForPanel] = useState(0);
  const [restForExercise, setRestForExercise] = useState<string | null>(null);
  const [restCue, setRestCue] = useState<string | null>(null);
  const [restNextTarget, setRestNextTarget] = useState<string | null>(null);
  // Tracks the live value so rapid +/-15 taps and native Live Activity
  // adjustments reconcile without waiting on a React render.
  const restRemainingRef = useRef(restRemaining);
  useEffect(() => { restRemainingRef.current = restRemaining; }, [restRemaining]);
  const lastRestWatchPushAtRef = useRef(0);
  // Mirror cue + nextTarget into refs so startRestTimer can read latest values
  // synchronously when persisting the snapshot blob to AsyncStorage.
  const restNextTargetRef = useRef<string | null>(null);
  const restCueRef = useRef<string | null>(null);
  useEffect(() => { restNextTargetRef.current = restNextTarget; }, [restNextTarget]);
  useEffect(() => { restCueRef.current = restCue; }, [restCue]);

  const buildWatchPositionProgress = useCallback(() => {
    const exerciseName = restExerciseNameRef.current;
    const exerciseIndex = exerciseName
      ? exercisesRef.current.findIndex(ex => ex.name === exerciseName)
      : activeExIdxRef.current;
    const exercise = exerciseIndex >= 0 ? exercisesRef.current[exerciseIndex] : undefined;
    const targetSetCount = exercise && exerciseIndex >= 0
      ? getEffectiveTargetSetCount(
          exerciseIndex,
          exercise,
          isSetlessCardioExercise(exercise) ? exercise.sets.length : exercise.sets.length + 1,
        )
      : undefined;
    const nextSetNumber = exercise && targetSetCount
      ? Math.min(targetSetCount, exercise.sets.length + 1)
      : undefined;
    return {
      exerciseIndex: exerciseIndex >= 0 ? exerciseIndex : undefined,
      setNumber: nextSetNumber,
      ...buildWatchExerciseCompletionProgress(),
    };
  }, [buildWatchExerciseCompletionProgress, getEffectiveTargetSetCount]);

  pushRestProgressToWatchRef.current = async () => {
    const startedAtMs = restStartAtRef.current;
    const totalSeconds = restTotalSecondsRef.current;
    if (!startedAtMs || !totalSeconds) return;
    const endAtMs = startedAtMs + totalSeconds * 1000;
    const remaining = Math.max(0, Math.ceil((endAtMs - Date.now()) / 1000));
    if (remaining <= 0) return;
    const now = Date.now();
    if (now - lastRestWatchPushAtRef.current < 1000) return;
    lastRestWatchPushAtRef.current = now;
    const { pushProgressToWatch } = await import('../utils/watchSync');
    await pushProgressToWatch({
      ...buildWatchPositionProgress(),
      restRemainingSec: remaining,
      restStartedAtMs: startedAtMs,
      restDurationSec: totalSeconds,
      restEndsAtMs: endAtMs,
      recommendation: restNextTargetRef.current,
    });
  };
  reassertRestProgressToWatchRef.current = (delaysMs = [650, 1400]) => {
    delaysMs.forEach(delay => {
      setTimeout(() => {
        pushRestProgressToWatchRef.current().catch(() => undefined);
      }, delay);
    });
  };

  const lastActiveExerciseWatchSyncSignatureRef = useRef<string | null>(null);
  const pushActiveExerciseProgressToWatch = useCallback((exerciseIndex: number, opts?: { force?: boolean }) => {
    if (exerciseIndex < 0 || watchWorkoutEndedRef.current) return;
    const ex = exercisesRef.current[exerciseIndex];
    if (!ex) return;
    const completedSets = Array.isArray(ex.sets) ? ex.sets.filter(Boolean).length : 0;
    const targetSetCount = getEffectiveTargetSetCountRef.current(exerciseIndex, ex, Math.max(1, completedSets + 1));
    const setNumber = Math.min(Math.max(1, completedSets + 1), Math.max(1, targetSetCount));
    const liveRec = recommendationByIdxRef.current[exerciseIndex];
    const hint = preSetHints[exerciseIndex];
    const recommendationText = liveRec?.text
      ?? (hint?.recommendedWeight != null
        ? `Try ${displayExerciseWeight(hint.recommendedWeight, ex)}${hint.recommendedReps ? ` x ${hint.recommendedReps}` : ''}`
        : hint?.recommendedReps
          ? `Set ${setNumber}: ${hint.recommendedReps} reps`
          : null);
    const activeRest = restEndsAtMs != null && restEndsAtMs > Date.now();
    const signature = [
      watchSessionId.current,
      exerciseIndex,
      ex.name,
      completedSets,
      targetSetCount,
      setNumber,
      activeRest ? 'rest' : 'clear-rest',
      recommendationText ?? 'none',
      liveRec?.recommendedWeightLbs ?? hint?.recommendedWeight ?? 'no-weight',
      liveRec?.recommendedReps ?? hint?.recommendedReps ?? 'no-reps',
    ].join('|');
    if (!opts?.force && lastActiveExerciseWatchSyncSignatureRef.current === signature) return;
    lastActiveExerciseWatchSyncSignatureRef.current = signature;

    scheduleWorkoutSidecar(`watch-active-exercise-${exerciseIndex}`, async () => {
      try {
        const currentExercises = exercisesRef.current;
        const latest = currentExercises[exerciseIndex];
        if (!latest || watchWorkoutEndedRef.current || activeExIdxRef.current !== exerciseIndex) return;
        const latestCompletedSets = Array.isArray(latest.sets) ? latest.sets.filter(Boolean).length : 0;
        const latestTargetSetCount = getEffectiveTargetSetCountRef.current(exerciseIndex, latest, Math.max(1, latestCompletedSets + 1));
        const latestSetNumber = Math.min(Math.max(1, latestCompletedSets + 1), Math.max(1, latestTargetSetCount));
        const latestLiveRec = recommendationByIdxRef.current[exerciseIndex];
        const latestHint = preSetHints[exerciseIndex];
        const latestRecommendationText = latestLiveRec?.text
          ?? (latestHint?.recommendedWeight != null
            ? `Try ${displayExerciseWeight(latestHint.recommendedWeight, latest)}${latestHint.recommendedReps ? ` x ${latestHint.recommendedReps}` : ''}`
            : latestHint?.recommendedReps
              ? `Set ${latestSetNumber}: ${latestHint.recommendedReps} reps`
              : null);
        const watchSync = preloadedWatchSyncRef.current ?? await import('../utils/watchSync');
        await watchSync.pushProgressToWatch({
          ...buildWatchExerciseCompletionProgress(currentExercises),
          progressKind: 'active_exercise',
          allowExerciseBacktrack: true,
          exerciseIndex,
          setNumber: latestSetNumber,
          ...(restEndsAtMs != null && restEndsAtMs > Date.now() ? {} : { restRemainingSec: 0 }),
          recommendation: latestRecommendationText,
          recommendedWeightLbs: latestLiveRec?.recommendedWeightLbs ?? (latestHint?.weightHeld ? null : latestHint?.recommendedWeight) ?? null,
          recommendedReps: latestLiveRec?.recommendedReps ?? latestHint?.recommendedReps ?? null,
        });
      } catch { /* watch bridge optional */ }
    }, { delayMs: 50, detached: true });
  }, [buildWatchExerciseCompletionProgress, displayExerciseWeight, preSetHints, restEndsAtMs, scheduleWorkoutSidecar]);

  useEffect(() => {
    if (!watchSessionHydrated || !activeWorkoutStateRestored || showStartCountdown) return;
    if (activeExIdx < 0 || watchWorkoutEndedRef.current) return;
    pushActiveExerciseProgressToWatch(activeExIdx);
  }, [
    activeExIdx,
    activeWorkoutStateRestored,
    pushActiveExerciseProgressToWatch,
    showStartCountdown,
    watchSessionHydrated,
  ]);

  const {
    activeTimers,
    activeTimersRef,
    activeTimersRestored,
    timerModalKey,
    timerModalKeyRef,
    setTimerModalKey,
    getTimerElapsed,
    timerElapsedFromState,
    parseExerciseTimerKey,
    startTimer,
    stopTimer,
    resetTimer,
    bumpTimerTick,
    ensureTimerTicker,
    subscribeTimerTick,
  } = useActiveWorkoutTimers();

  const isCardioGpsExerciseTimerKey = useCallback((key: string): boolean => {
    const parsed = parseExerciseTimerKey(key);
    if (!parsed) return false;
    const ex = exercisesRef.current[parsed.exIdx];
    return isOutdoorGpsTimedExercise(ex);
  }, [parseExerciseTimerKey]);

  const applyCardioGpsTimerGate = useCallback(() => {
    if (!cardioGpsWaitsForExerciseTimerRef.current) return;
    const handle = cardioGpsHandleRef.current;
    if (!handle) return;
    if (cardioGpsActiveTimerKeysRef.current.size > 0 && !workoutPauseRef.current.paused) {
      handle.resume();
    } else {
      handle.pause();
    }
  }, []);

  const setCardioGpsTimerActive = useCallback((key: string, active: boolean) => {
    if (!cardioGpsWaitsForExerciseTimerRef.current || !isCardioGpsExerciseTimerKey(key)) return;
    const activeKeys = cardioGpsActiveTimerKeysRef.current;
    if (active) {
      activeKeys.add(key);
    } else {
      activeKeys.delete(key);
    }
    applyCardioGpsTimerGate();
  }, [applyCardioGpsTimerGate, isCardioGpsExerciseTimerKey]);

  useEffect(() => {
    if (!cardioGpsWaitsForExerciseTimer || !activeTimersRestored) return;
    const activeKeys = new Set<string>();
    Object.entries(activeTimers).forEach(([key, timer]) => {
      if (timer?.running && isCardioGpsExerciseTimerKey(key)) activeKeys.add(key);
    });
    cardioGpsActiveTimerKeysRef.current = activeKeys;
    applyCardioGpsTimerGate();
  }, [
    activeTimers,
    activeTimersRestored,
    applyCardioGpsTimerGate,
    cardioGpsWaitsForExerciseTimer,
    isCardioGpsExerciseTimerKey,
  ]);

  const buildTimedLiveActivityState = useCallback((
    key: string,
    timer: ExerciseTimerState,
  ): RestActivityState | null => {
    const parsed = parseExerciseTimerKey(key);
    if (!parsed) return null;
    const currentExercises = exercisesRef.current.length > 0 ? exercisesRef.current : exercises;
    const ex = currentExercises[parsed.exIdx];
    if (!ex) return null;
    const totalSets = getEffectiveTargetSetCount(parsed.exIdx, ex, ex.sets.length + 1);
    const setNumber = Math.min(parsed.slot, Math.max(0, totalSets - 1));
    const elapsedSeconds = timerElapsedFromState(timer);
    const startedAtMs = Date.now() - elapsedSeconds * 1000;
    const target = String(ex.targetReps ?? '').trim();
    const targetHasDurationUnit = /\b(s|sec|secs|second|seconds|m|min|mins|minute|minutes)\b/i.test(target);
    const targetLooksLikeMachineMetric = /\b(rpm|watt|watts|bpm|mph|kph|km\/h|pace|resistance)\b/i.test(target);
    const preferMinutes = isLongCardioExercise(ex.name, ex.targetReps, { primaryMuscle: ex.primaryMuscle ?? ex.primary_muscle });
    const plannedSeconds = !targetHasDurationUnit && targetLooksLikeMachineMetric
      ? NaN
      : parseDurationTargetSeconds(ex.targetReps, preferMinutes);
    const durationSeconds = Number.isFinite(plannedSeconds) && plannedSeconds > 0
      ? plannedSeconds
      : Math.max(1, elapsedSeconds || 1);
    return {
      mode: 'elapsed',
      exerciseName: ex.name,
      setNumber,
      totalSets,
      startedAtMs,
      durationSeconds,
      endDateMs: startedAtMs + durationSeconds * 1000,
      nextSetRecommendation: totalSets > 1
        ? `Round ${setNumber + 1}${target ? ` - ${target}` : ''}`
        : target || 'Timed set',
      themeColorHex: theme.colors.primary,
      workoutId: `w_${planDisplayFocus}_${key}`,
      paused: !timer.running,
      elapsedSeconds,
      ...liveActivityHrZoneFields(liveHR, hrZones),
    };
  }, [exercises, getEffectiveTargetSetCount, hrZones, liveHR, parseExerciseTimerKey, planDisplayFocus, theme.colors.primary, timerElapsedFromState, workout]);

  const startOrUpdateTimedLiveActivity = useCallback((key: string, timer: ExerciseTimerState) => {
    const state = buildTimedLiveActivityState(key, timer);
    if (!state) return;
    (async () => {
      try {
        const generation = liveActivityGenerationRef.current + 1;
        liveActivityGenerationRef.current = generation;
        const priorActivityId = liveActivityIdRef.current;
        const priorTimerKey = liveActivityTimerKeyRef.current;
        if (priorActivityId && priorTimerKey === key) {
          await updateRestActivity(priorActivityId, state);
          return;
        }
        liveActivityIdRef.current = null;
        liveActivityTimerKeyRef.current = null;
        if (priorActivityId) {
          await endRestActivity(priorActivityId);
          if (liveActivityGenerationRef.current !== generation) return;
        }
        const id = await startRestActivity(state);
        if (!id) return;
        if (liveActivityGenerationRef.current !== generation) {
          await endRestActivity(id);
          return;
        }
        liveActivityIdRef.current = id;
        liveActivityTimerKeyRef.current = key;
      } catch {
        // Live Activities are a mirror only; the in-app timer remains authoritative.
      }
    })();
  }, [buildTimedLiveActivityState]);

  const updateTimedLiveActivity = useCallback((key: string, timer: ExerciseTimerState) => {
    const activityId = liveActivityIdRef.current;
    if (!activityId || liveActivityTimerKeyRef.current !== key) return;
    const state = buildTimedLiveActivityState(key, timer);
    if (!state) return;
    updateRestActivity(activityId, state).catch(() => undefined);
  }, [buildTimedLiveActivityState]);
  const updateTimedLiveActivityRef = useRef(updateTimedLiveActivity);
  useEffect(() => { updateTimedLiveActivityRef.current = updateTimedLiveActivity; }, [updateTimedLiveActivity]);

  const endTimedLiveActivity = useCallback((key: string) => {
    if (liveActivityTimerKeyRef.current !== key) return;
    endActiveRestLiveActivity();
  }, [endActiveRestLiveActivity]);

  const startExerciseTimer = useCallback((key: string) => {
    const nextTimer = startTimer(key);
    setCardioGpsTimerActive(key, true);
    startOrUpdateTimedLiveActivity(key, nextTimer);
    const parsed = parseExerciseTimerKey(key);
    if (parsed) {
      scheduleWorkoutSidecar(`watch-timed-start-${key}`, async () => {
        try {
          const watchSync = preloadedWatchSyncRef.current ?? await import('../utils/watchSync');
          await watchSync.pushProgressToWatch({
            ...buildWatchExerciseCompletionProgress(),
            progressKind: 'active_exercise',
            allowExerciseBacktrack: true,
            exerciseIndex: parsed.exIdx,
            setNumber: parsed.slot + 1,
            restRemainingSec: 0,
            recommendation: null,
          });
        } catch { /* watch bridge optional */ }
      }, { detached: true });
    }
  }, [buildWatchExerciseCompletionProgress, parseExerciseTimerKey, scheduleWorkoutSidecar, setCardioGpsTimerActive, startOrUpdateTimedLiveActivity, startTimer]);

  const stopExerciseTimer = useCallback((key: string) => {
    const stoppedTimer = stopTimer(key);
    setCardioGpsTimerActive(key, false);
    if (stoppedTimer) updateTimedLiveActivity(key, stoppedTimer);
  }, [setCardioGpsTimerActive, stopTimer, updateTimedLiveActivity]);

  const resetExerciseTimer = useCallback((key: string) => {
    setCardioGpsTimerActive(key, false);
    endTimedLiveActivity(key);
    resetTimer(key);
  }, [endTimedLiveActivity, resetTimer, setCardioGpsTimerActive]);

  const buildActiveExerciseLiveActivityState = useCallback((): RestActivityState | null => {
    const currentExercises = exercisesRef.current.length > 0 ? exercisesRef.current : exercises;
    if (!currentExercises.length) return null;
    let exerciseIndex = activeExIdxRef.current;
    if (!currentExercises[exerciseIndex] || getExerciseTargetSetCount(currentExercises[exerciseIndex]) <= 0) {
      exerciseIndex = currentExercises.findIndex(ex => {
        const targetSets = getExerciseTargetSetCount(ex);
        return targetSets > 0 && ex.sets.length < targetSets;
      });
    }
    const ex = currentExercises[exerciseIndex];
    if (!ex) return null;

    const now = Date.now();
    const startedAtMs = startTime.current || now;
    const elapsedSeconds = Math.max(0, Math.floor((now - startedAtMs) / 1000));
    const totalSets = getEffectiveTargetSetCount(exerciseIndex, ex, ex.sets.length + 1);
    if (totalSets <= 0) return null;
    const displaySet = Math.min(Math.max(1, ex.sets.length + 1), Math.max(1, totalSets));
    return {
      mode: 'elapsed',
      exerciseName: ex.name,
      setNumber: displaySet - 1,
      totalSets,
      startedAtMs,
      durationSeconds: Math.max(1, elapsedSeconds || 1),
      endDateMs: now + LIVE_WORKOUT_ACTIVITY_HORIZON_MS,
      nextSetRecommendation: totalSets > 0
        ? `Set ${displaySet} of ${totalSets}`
        : workout.focus || 'Workout running',
      themeColorHex: theme.colors.primary,
      workoutId: `w_${planDisplayFocus}_${watchSessionId.current || startedAtMs}`,
      paused: false,
      elapsedSeconds,
      ...liveActivityHrZoneFields(liveHR, hrZones),
    };
  }, [exercises, getEffectiveTargetSetCount, hrZones, liveHR, planDisplayFocus, theme.colors.primary, workout.focus]);

  const syncActiveExerciseLiveActivity = useCallback(async () => {
    if (watchWorkoutEndedRef.current || openEndedCustomLiveActivityEnabled || cardioActivityIdRef.current) return;
    if (liveCardioRef.current) {
      const activeId = liveActivityIdRef.current;
      if (activeId && liveActivityTimerKeyRef.current === ACTIVE_EXERCISE_LIVE_ACTIVITY_KEY) {
        liveActivityIdRef.current = null;
        liveActivityTimerKeyRef.current = null;
        await endRestActivity(activeId).catch(() => undefined);
      }
      return;
    }
    if (restEndsAtMs && restEndsAtMs > Date.now()) return;
    const existingId = liveActivityIdRef.current;
    const existingKey = liveActivityTimerKeyRef.current;
    if (existingId && existingKey && existingKey !== ACTIVE_EXERCISE_LIVE_ACTIVITY_KEY) return;

    const state = buildActiveExerciseLiveActivityState();
    if (!state) return;

    if (existingId) {
      const updated = await updateRestActivity(existingId, state).catch(() => false);
      if (updated) {
        liveActivityTimerKeyRef.current = ACTIVE_EXERCISE_LIVE_ACTIVITY_KEY;
      } else if (liveActivityIdRef.current === existingId) {
        liveActivityIdRef.current = null;
        liveActivityTimerKeyRef.current = null;
      }
      return;
    }

    const generation = liveActivityGenerationRef.current + 1;
    liveActivityGenerationRef.current = generation;
    const id = await startRestActivity(state).catch(() => null);
    if (!id) return;
    if (watchWorkoutEndedRef.current || liveActivityGenerationRef.current !== generation) {
      await endRestActivity(id).catch(() => undefined);
      return;
    }
    liveActivityIdRef.current = id;
    liveActivityTimerKeyRef.current = ACTIVE_EXERCISE_LIVE_ACTIVITY_KEY;
  }, [buildActiveExerciseLiveActivityState, openEndedCustomLiveActivityEnabled, restEndsAtMs]);

  useEffect(() => {
    if (!watchSessionHydrated || !activeWorkoutStateRestored || showStartCountdown) return;
    if (watchWorkoutEndedRef.current) return;
    const runningTimer = Object.values(activeTimersRef.current).some(timer => timer.running);
    if (runningTimer && liveActivityTimerKeyRef.current !== ACTIVE_EXERCISE_LIVE_ACTIVITY_KEY) return;
    scheduleWorkoutSidecar('active-exercise-live-activity', () => {
      syncActiveExerciseLiveActivity().catch(() => undefined);
    }, { delayMs: 300, detached: true });
  }, [
    activeExIdx,
    activeWorkoutStateRestored,
    activeTimers,
    exercises,
    liveCardio,
    restEndsAtMs,
    scheduleWorkoutSidecar,
    showStartCountdown,
    syncActiveExerciseLiveActivity,
    watchSessionHydrated,
  ]);

  // Per-exercise AI state
  const [aiLoadingIdx, setAiLoadingIdx] = useState<number | null>(null);
  const [aiErrorIdx, setAiErrorIdx]     = useState<number | null>(null);

  // Last-session data for comparison display
  const [lastExerciseSets, setLastExerciseSets] = useState<Record<string, CompletedSet[]>>({});
  const lastSessionLookupKeysRef = useRef<Set<string>>(new Set());

  // AMRAP / EMOM / Tabata timer modal
  const [timerModalVisible, setTimerModalVisible] = useState(false);
  const [timerMode, setTimerMode] = useState<'amrap' | 'emom' | 'tabata'>('amrap');
  const [timerExerciseIdx, setTimerExerciseIdx] = useState(0);

  // Workout summary after finish
  const [timedMetrics, setTimedMetrics] = useState<Record<string, string>>({});
  const [finishPerceivedIntensity, setFinishPerceivedIntensity] = useState<ActivityIntensity | null>(null);
  const [finishManualDistance, setFinishManualDistance] = useState('');
  const [finishManualCalories, setFinishManualCalories] = useState('');
  const [finishManualAvgHr, setFinishManualAvgHr] = useState('');
  const [summaryVisible, setSummaryVisible] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [completionSyncState, setCompletionSyncState] = useState<CompletionSyncState>('idle');
  const [summaryData, setSummaryData] = useState<WorkoutSummary | null>(null);
  const [trainingScoreInfoOpen, setTrainingScoreInfoOpen] = useState(false);
  const [finishedSession, setFinishedSession] = useState<WorkoutSession | null>(null);
  // PR celebration modal — populated after handleFinish when the backend
  // returns one or more PRs. Null = no modal shown.
  const [prModalData, setPrModalData] = useState<PRAchievement[] | null>(null);

  // Post-workout feedback. The step sequence is:
  //   'summary'      — AI-generated summary (achievements / recommendations)
  //   'feedback'     — user fills in feeling/intensity/soreness/notes
  //   'confirmation' — after submit, user sees a confirmation screen
  //                    and dismisses manually (fixes the old bug where
  //                    the modal auto-closed immediately after submit
  //                    and the user never got to read the result).
  const [summaryStep, setSummaryStep] = useState<'summary' | 'feedback' | 'confirmation'>('summary');
  const [feedbackFeeling, setFeedbackFeeling] = useState<string | null>(null);
  const [feedbackIntensity, setFeedbackIntensity] = useState<number | null>(null);
  const [feedbackSoreness, setFeedbackSoreness] = useState<string[]>([]);
  const [feedbackNotes, setFeedbackNotes] = useState('');
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [feedbackResult, setFeedbackResult] = useState<string | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [templateSaving, setTemplateSaving] = useState(false);
  const [templateSaved, setTemplateSaved] = useState(false);
  const [showShareWorkoutModal, setShowShareWorkoutModal] = useState(false);
  // Per-session gear picker — fires at workout completion when 2+ active
  // gear items keyword-match the workout. The resolver hands back the
  // selected gear IDs (or [] for "none today") so the completion path
  // can pass them through to logWorkoutDone instead of letting the
  // backend keyword-auto-match double-credit two pairs of running shoes.
  const [gearPickerCandidates, setGearPickerCandidates] = useState<GearItem[]>([]);
  const [gearPickerResolver, setGearPickerResolver] = useState<((ids: number[] | null) => void) | null>(null);
  const summaryCardRef = useRef<ViewShot>(null);
  const stickerCardRef = useRef<ViewShot>(null);
  const shareWorkoutOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repsInputRef = useRef<TextInput>(null);

  useEffect(() => {
    return () => {
      if (shareWorkoutOpenTimerRef.current) {
        clearTimeout(shareWorkoutOpenTimerRef.current);
        shareWorkoutOpenTimerRef.current = null;
      }
    };
  }, []);

  const handleShareSummary = async () => {
    try {
      setShareLoading(true);
      const ref = summaryCardRef.current as any;
      if (!ref?.capture) return;
      const uri = await ref.capture();
      const Sharing = await import('expo-sharing');
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'Share Workout Summary' });
      } else {
        Alert.alert('Saved', 'Screenshot saved to your device.');
      }
    } catch {
      Alert.alert('Error', 'Could not share the summary.');
    } finally {
      setShareLoading(false);
    }
  };

  // Detect Instagram presence once per modal open so the Stories
  // button only renders when tapping it will actually do something.
  // Instagram-not-installed users still get the generic Share Image
  // button which falls back to the iOS share sheet.
  const [instagramAvailable, setInstagramAvailable] = useState(false);
  useEffect(() => {
    if (!summaryVisible) return;
    let cancelled = false;
    (async () => {
      try {
        const { isInstagramStoriesAvailable } = await import('../utils/shareToInstagram');
        const ok = await isInstagramStoriesAvailable();
        if (!cancelled) setInstagramAvailable(ok);
      } catch {
        if (!cancelled) setInstagramAvailable(false);
      }
    })();
    return () => { cancelled = true; };
  }, [summaryVisible]);

  // Strava-style sticker share. Prompts the user to pick a photo
  // (or skip), captures the off-screen transparent sticker card,
  // then hands both to Instagram so the photo becomes the Story
  // background and the card sits on top as a draggable sticker.
  // If the user skips the photo, falls back to the gradient canvas.
  const handleShareToStories = async () => {
    try {
      setShareLoading(true);

      const summaryRef = summaryCardRef.current as any;
      const captureSummaryCard = async () => {
        if (!summaryRef?.capture) return undefined;
        return await summaryRef.capture();
      };
      const instagramShare = await import('../utils/shareToInstagram');
      const storiesAvailable = instagramAvailable || await instagramShare.isInstagramStoriesAvailable();

      if (!storiesAvailable) {
        const imageUri = await captureSummaryCard();
        if (!imageUri) {
          Alert.alert('Error', 'Summary card not ready yet — try again in a moment.');
          setShareLoading(false);
          return;
        }
        const res = await instagramShare.shareToInstagramStories({
          imageUri,
          backgroundTopColor: themeColors.background,
          backgroundBottomColor: themeColors.primary,
        });
        if (!res.ok && res.reason !== 'user_cancelled') {
          Alert.alert(
            'Could not share',
            res.message ?? 'Try again, or use the share sheet to post elsewhere.',
          );
        }
        return;
      }

      // 1. Ask whether to add a background photo. Use a Promise wrapper
      //    around Alert.alert because it's the simplest 3-button choice
      //    pattern available without adding a custom sheet UI here.
      const photoChoice = await new Promise<'photo' | 'no_photo' | 'cancel'>(resolve => {
        Alert.alert(
          'Share to Instagram Stories',
          'Add a background photo (Strava-style) or share the summary card on its own?',
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve('cancel') },
            { text: 'No photo', onPress: () => resolve('no_photo') },
            { text: 'Choose photo', onPress: () => resolve('photo') },
          ],
          { cancelable: true, onDismiss: () => resolve('cancel') },
        );
      });
      if (photoChoice === 'cancel') {
        setShareLoading(false);
        return;
      }

      // 2. Optional photo pick. Reuses the global ImagePicker proxy.
      let backgroundImage: string | undefined;
      if (photoChoice === 'photo') {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          Alert.alert(
            'Photo access needed',
            'Allow photo library access in Settings to add a background photo, or share without a photo.',
          );
          setShareLoading(false);
          return;
        }
        const pick = await ImagePicker.launchImageLibraryAsync({
          quality: 0.9,
          mediaTypes: ['images'] as any,
          allowsEditing: false,
        });
        if (pick.canceled || !pick.assets?.[0]?.uri) {
          setShareLoading(false);
          return;
        }
        backgroundImage = pick.assets[0].uri;
      }

      // 3. Capture the off-screen sticker card (transparent PNG).
      const stickerRef = stickerCardRef.current as any;
      if (!stickerRef?.capture) {
        Alert.alert('Error', 'Sticker not ready yet — try again in a moment.');
        setShareLoading(false);
        return;
      }
      const stickerImage = await stickerRef.capture();
      const imageUri = await captureSummaryCard();

      const res = await instagramShare.shareToInstagramStories({
        imageUri,
        stickerImage,
        backgroundImage,
        // Used only when no backgroundImage is picked — Instagram
        // paints this gradient behind the sticker.
        backgroundTopColor: themeColors.background,
        backgroundBottomColor: themeColors.primary,
      });
      if (!res.ok && res.reason !== 'user_cancelled') {
        Alert.alert(
          'Could not share',
          res.message ?? 'Try again, or use the share sheet to post elsewhere.',
        );
      }
    } catch {
      Alert.alert('Error', 'Could not share to Stories.');
    } finally {
      setShareLoading(false);
    }
  };

  const handleSaveWorkoutTemplate = async () => {
    if (templateSaving || templateSaved) return;
    const sourceExercises = exercisesRef.current.length > 0 ? exercisesRef.current : exercises;
    if (!sourceExercises.length) {
      Alert.alert('No exercises', 'Add at least one exercise before saving a template.');
      return;
    }
    setTemplateSaving(true);
    try {
      const existing = await loadWorkoutTemplates();
      let profile: UserProfile | null = null;
      try {
        const raw = await AsyncStorage.getItem('userProfile');
        profile = raw ? JSON.parse(raw) : null;
      } catch {
        profile = null;
      }
      if (!canCreateWorkoutTemplate(profile, existing.length)) {
        Alert.alert(
          'Template limit reached',
          `Free accounts can save up to ${FREE_WORKOUT_TEMPLATE_LIMIT} workout templates. Upgrade to Pro for unlimited templates.`,
        );
        return;
      }

      const baseName = `${workout.focus && workout.focus !== 'Empty' ? workoutDisplayFocus : 'Custom'} Template`;
      const existingNames = new Set(existing.map(t => t.name.trim().toLowerCase()));
      let name = baseName;
      let suffix = 2;
      while (existingNames.has(name.toLowerCase())) {
        name = `${baseName} ${suffix}`;
        suffix += 1;
      }
      const now = new Date().toISOString();
      const templateWorkout: WorkoutDay = {
        ...workout,
        focus: workout.focus && workout.focus !== 'Empty' ? workout.focus : 'Custom',
        exercises: sourceExercises.map((ex) => ({
          name: ex.name,
          sets: Math.max(getExerciseTargetSetCount(ex), ex.sets?.length || 0),
          reps: ex.targetReps || '8-12',
          restSeconds: Number(ex.targetRestSeconds) || 60,
          equipment: (ex.equipment || 'other') as any,
          image_url: ex.image_url,
          targetWeightLbs: ex.targetWeightLbs ?? null,
          weightRecommendationSource: (ex.weightRecommendationSource as any) ?? null,
          slug: ex.slug ?? undefined,
          primary_muscle: ex.primaryMuscle ?? undefined,
          secondary_muscles: ex.secondaryMuscles ?? undefined,
          movement_pattern: ex.movementPattern ?? ex.movement_pattern ?? undefined,
          is_compound: ex.isCompound ?? undefined,
          _role: ex.slotRole ?? undefined,
          _slot_label: ex.slotLabel ?? undefined,
          prescription_type: ex.prescriptionType ?? undefined,
        } as any)),
      };
      const template: SavedWorkoutTemplate = {
        id: `workout_template_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name,
        workout: templateWorkout,
        createdAt: now,
        updatedAt: now,
      };
      await upsertWorkoutTemplate(template);
      setTemplateSaved(true);
      Alert.alert('Saved', `${name} added to your templates.`);
    } catch (e: any) {
      Alert.alert('Save failed', e?.message ?? 'Could not save this workout template.');
    } finally {
      setTemplateSaving(false);
    }
  };

  const [finishModalVisible, setFinishModalVisible] = useState(false);
  const [finishingWorkout, setFinishingWorkout] = useState(false);
  const finishInFlightRef = useRef(false);
  const [coachModalVisible, setCoachModalVisible] = useState(false);
  const [coachInput, setCoachInput] = useState('');
  const [coachLoading, setCoachLoading] = useState(false);
  const [coachPhotoLoading, setCoachPhotoLoading] = useState(false);
  const [coachChat, setCoachChat] = useState<WorkoutCoachMessage[]>([]);
  // Photo staged for attachment to the next coach question. Shown as a
  // thumbnail in the input area; cleared after send. Decoupled from
  // `handleAnalyzeFormPhoto` (the dedicated quick-action flow) so the
  // user can write a custom question + attach a photo in one turn.
  const [coachPendingPhoto, setCoachPendingPhoto] = useState<{ base64: string; mime: string } | null>(null);
  const [addExerciseModalVisible, setAddExerciseModalVisible] = useState(false);
  const [returnToExercisePickerAfterVideo, setReturnToExercisePickerAfterVideo] = useState(false);
  const [exerciseSearch, setExerciseSearch] = useState('');
  const [exerciseMuscleFilter, setExerciseMuscleFilter] = useState('all');
  const deferredExerciseSearch = useDeferredValue(exerciseSearch);
  const [exerciseLibraryLoading, setExerciseLibraryLoading] = useState(false);
  const [exerciseLibrary, setExerciseLibrary] = useState<ExerciseLibraryItem[]>([]);
  const exerciseLibraryRef = useRef<ExerciseLibraryItem[]>([]);
  const [aiExerciseResults, setAiExerciseResults] = useState<AIExerciseResult[]>([]);
  const [aiExerciseLoading, setAiExerciseLoading] = useState(false);
  const [customExerciseModalVisible, setCustomExerciseModalVisible] = useState(false);
  const returnToExercisePickerAfterCustomRef = useRef(false);

  useEffect(() => {
    exerciseLibraryRef.current = exerciseLibrary;
  }, [exerciseLibrary]);

  const customExerciseEquipmentOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (value: unknown) => {
      const text = String(value ?? '').trim();
      if (!text) return;
      const key = text.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
      if (seen.has(key)) return;
      seen.add(key);
      out.push(text);
    };
    ownedEquipment.forEach(add);
    exerciseLibrary.forEach(item => {
      add(item.equipment);
      (item.gear ?? []).forEach(gear => add(gear.name || gear.slug));
    });
    return out.sort((a, b) => humanizeToken(a).localeCompare(humanizeToken(b)));
  }, [exerciseLibrary, ownedEquipment]);

  const exerciseMuscleOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of exerciseLibrary) {
      for (const muscle of [item.primary_muscle, ...(item.secondary_muscles ?? [])]) {
        const text = String(muscle ?? '').trim();
        const key = normalizeSwapText(text);
        if (!text || !key || seen.has(key)) continue;
        seen.add(key);
        out.push(text);
      }
    }
    return out.sort((a, b) => humanizeToken(a).localeCompare(humanizeToken(b)));
  }, [exerciseLibrary]);

  useEffect(() => {
    swapCandidateCacheRef.current.clear();
  }, [activeInjuryTokens, exerciseHistorySignals, exerciseLibrary, ownedEquipment]);

  const loadExerciseLibraryRows = useCallback(async (): Promise<ExerciseLibraryItem[]> => {
    const customs = await loadCustomExerciseLibraryItems();
    const timedActivities: ExerciseLibraryItem[] = [
      { name: 'Boxing', equipment: 'bodyweight', primary_muscle: 'full_body' },
      { name: 'Kickboxing', equipment: 'bodyweight', primary_muscle: 'full_body' },
      { name: 'Shadow Boxing', equipment: 'bodyweight', primary_muscle: 'shoulders' },
      { name: 'Bag Work', equipment: 'bodyweight', primary_muscle: 'full_body' },
      { name: 'Yoga', equipment: 'bodyweight', primary_muscle: 'full_body' },
      { name: 'Vinyasa Yoga', equipment: 'bodyweight', primary_muscle: 'full_body' },
      { name: 'Stretching', equipment: 'bodyweight', primary_muscle: 'full_body' },
      { name: 'Mobility Flow', equipment: 'bodyweight', primary_muscle: 'full_body' },
    ];
    try {
      const rows = await getExercises();
      const existingNames = new Set([...customs, ...rows].map(e => e.name.toLowerCase()));
      const newTimed = timedActivities.filter(t => !existingNames.has(t.name.toLowerCase()));
      return mergeCustomExerciseLibraryRows(customs, [...newTimed, ...rows]);
    } catch {
      const existingNames = new Set(customs.map(e => e.name.toLowerCase()));
      return mergeCustomExerciseLibraryRows(customs, timedActivities.filter(t => !existingNames.has(t.name.toLowerCase())));
    }
  }, []);

  const refreshCustomExercisesInLibrary = useCallback(async (): Promise<ExerciseLibraryItem[]> => {
    const customs = await loadCustomExerciseLibraryItems();
    const current = exerciseLibraryRef.current;
    if (customs.length === 0) return current;
    const next = mergeCustomExerciseLibraryRows(customs, current);
    exerciseLibraryRef.current = next;
    setExerciseLibrary(next);
    return next;
  }, []);

  const ensureExerciseLibrary = useCallback(async (): Promise<ExerciseLibraryItem[]> => {
    if (exerciseLibraryRef.current.length > 0) return exerciseLibraryRef.current;
    // 24-hour AsyncStorage cache. Exercise library is server-seeded
    // metadata; once loaded it doesn't change between workouts. The
    // first hit primes the cache, subsequent workout opens skip the
    // full network fetch entirely.
    const EXERCISE_LIB_CACHE_KEY = 'exerciseLibraryCache_v2';
    const TTL_MS = 24 * 60 * 60 * 1000;
    try {
      const raw = await AsyncStorage.getItem(EXERCISE_LIB_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.savedAt && Date.now() - parsed.savedAt < TTL_MS && Array.isArray(parsed.rows) && parsed.rows.length > 0) {
          const customs = await loadCustomExerciseLibraryItems();
          const rows = mergeCustomExerciseLibraryRows(customs, parsed.rows);
          exerciseLibraryRef.current = rows;
          setExerciseLibrary(rows);
          // Background revalidate so a stale cache doesn't bind the
          // user to old data forever — but the UI is already usable.
          loadExerciseLibraryRows().then(rows => {
            if (rows && rows.length > 0) {
              exerciseLibraryRef.current = rows;
              setExerciseLibrary(rows);
              AsyncStorage.setItem(EXERCISE_LIB_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), rows })).catch(() => {});
            }
          }).catch(() => {});
          return rows;
        }
      }
    } catch { /* cache miss / parse fail → fall through to network */ }

    setExerciseLibraryLoading(true);
    try {
      const rows = await loadExerciseLibraryRows();
      exerciseLibraryRef.current = rows;
      setExerciseLibrary(rows);
      AsyncStorage.setItem(EXERCISE_LIB_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), rows })).catch(() => {});
      return rows;
    } finally {
      setExerciseLibraryLoading(false);
    }
  }, [loadExerciseLibraryRows]);

  useEffect(() => {
    ensureExerciseLibrary().catch(() => undefined);
  }, [ensureExerciseLibrary]);

  // Name → demo_exercise_db_id map built from the loaded library.
  // PlanWeek rows generated before this feature shipped don't carry
  // the field on the embedded exercise dicts, so the only client-side
  // way to resolve a demo for those is by looking up the name against
  // the freshly-loaded library. Normalized lowercase keys to absorb
  // case-difference drift between plan snapshots and the seed catalog.
  const demoIdByExerciseName = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of exerciseLibrary) {
      const id = (item as any).demo_exercise_db_id as string | null | undefined;
      if (!id || !item.name) continue;
      map.set(item.name.toLowerCase().trim(), id);
    }
    return map;
  }, [exerciseLibrary]);

  const resolveDemoIdForExercise = useCallback((ex: { name?: string; demo_exercise_db_id?: string | null; demoExerciseDbId?: string | null } | null | undefined): string | null => {
    if (!ex) return null;
    const direct = ex.demo_exercise_db_id ?? ex.demoExerciseDbId;
    if (direct) return direct;
    const name = ex.name?.toLowerCase().trim();
    if (!name) return null;
    return demoIdByExerciseName.get(name) ?? null;
  }, [demoIdByExerciseName]);

  const swapCandidatesForExercise = useCallback((
    ex: SessionExercise,
    library: ExerciseLibraryItem[] = exerciseLibraryRef.current,
    limit = 5,
  ): SmartSwapItem[] => {
    const blockedNames = exerciseNameKeySet((exercisesRef.current.length > 0 ? exercisesRef.current : exercises).map(row => row.name));
    const blockedKey = Array.from(blockedNames).sort().join(',');
    const cacheKey = [
      limit,
      ex.name.toLowerCase(),
      ex.equipment ?? '',
      ex.primaryMuscle ?? ex.primary_muscle ?? '',
      library.length,
      blockedKey,
    ].join('|');
    const cached = swapCandidateCacheRef.current.get(cacheKey);
    if (cached) return cached;
    const base = library.find(li => li.name.toLowerCase() === ex.name.toLowerCase()) ?? {
      name: ex.name,
      equipment: ex.equipment,
      primary_muscle: ex.primaryMuscle ?? undefined,
      secondary_muscles: ex.secondaryMuscles ?? ex.secondary_muscles ?? undefined,
      movement_pattern: ex.movementPattern ?? ex.movement_pattern ?? undefined,
      is_compound: ex.isCompound ?? undefined,
    };
    const scored: Array<{ item: ExerciseLibraryItem; score: number; historySignal?: ExerciseHistorySignal }> = [];
    for (const item of library) {
      if (blockedNames.has(normalizeSwapText(item.name))) continue;
      if (!isExerciseUsableWithEquipment(item, ownedEquipment)) continue;
      if (candidateConflictsWithActiveInjuries(item, activeInjuryTokens)) continue;
      const score = scoreSwapCandidate(base, item);
      if (score <= 0) continue;
      const historySignal = exerciseHistorySignals[exerciseHistoryKey(item.name)];
      const historyBonus = Math.min(SMART_SWAP_HISTORY_BONUS_MAX, (historySignal?.count ?? 0) * 1.25);
      scored.push({ item, score: score + historyBonus, historySignal });
    }
    scored.sort((a, b) => {
      const scoreDelta = b.score - a.score;
      if (scoreDelta !== 0) return scoreDelta;
      const historyDelta = (b.historySignal?.count ?? 0) - (a.historySignal?.count ?? 0);
      if (historyDelta !== 0) return historyDelta;
      return a.item.name.localeCompare(b.item.name);
    });
    const result = scored.slice(0, limit).map(({ item, score, historySignal }) => ({
      ...item,
      _overlap: Math.min(100, Math.round((score / SMART_SWAP_MAX_SCORE) * 100)),
      _swapNotes: buildSwapNotes(item, base, historySignal, activeInjuryTokens),
    }));
    swapCandidateCacheRef.current.set(cacheKey, result);
    return result;
  }, [activeInjuryTokens, exerciseHistorySignals, exercises, ownedEquipment]);

  const buildWatchWorkoutSnapshot = useCallback((
    sourceExercises: SessionExercise[] = exercisesRef.current,
    opts?: { skipHintIndex?: number },
  ): any => {
    const tBuild = __DEV__ ? Date.now() : 0;
    const result = {
    ...workout,
    hrZones,
    exercises: sourceExercises.map((ex, index) => {
      const guide = isGuideExercise(ex, workout);
      const completedSets = Array.isArray(ex.sets) ? ex.sets.filter(Boolean).length : 0;
      const minTargetSets = Math.max(isSetlessCardioExercise(ex) ? 0 : 1, completedSets);
      const targetSetCount = getEffectiveTargetSetCountRef.current(index, ex, minTargetSets);
      const hint = index === opts?.skipHintIndex ? undefined : preSetHints[index];
      const liveRec = recommendationByIdxRef.current[index];
      const recommendedWeight = guide
        ? null
        : liveRec?.recommendedWeightLbs
          ?? hint?.recommendedWeight
          ?? (hint?.weightHeld ? null : ex.targetWeightLbs)
          ?? null;
      const recommendedReps = guide
        ? null
        : liveRec?.recommendedReps
          ?? hint?.recommendedReps
          ?? null;
      const recommendation = guide ? null : liveRec?.text
        ?? (hint?.recommendedWeight != null
          ? `Try ${displayExerciseWeight(hint.recommendedWeight, ex)}${hint.recommendedReps ? ` x ${hint.recommendedReps}` : ''}`
          : ex.aiRecommendation);
      return {
        clientExerciseId: (ex as any).clientExerciseId ?? (ex as any).client_exercise_id ?? null,
        name: ex.name,
        sets: targetSetCount,
        reps: ex.targetReps,
        restSeconds: guide ? 0 : ex.targetRestSeconds,
        equipment: ex.equipment,
        primaryMuscle: ex.primaryMuscle ?? ex.primary_muscle ?? null,
        primary_muscle: ex.primaryMuscle ?? ex.primary_muscle ?? null,
        cardioGuidance: (ex as any).cardioGuidance ?? null,
        targetWeightLbs: recommendedWeight,
        recommendedWeightLbs: recommendedWeight,
        recommendedReps,
        recommendation,
        completedSets,
        isDone: completedSets >= targetSetCount,
        isGuide: guide,
        slot_role: (ex as any).slotRole ?? (ex as any).slot_role ?? null,
        prescriptionType: (ex as any).prescriptionType ?? (ex as any).prescription_type ?? null,
        swapOptions: swapCandidatesForExercise(ex).map(option => ({
          name: option.name,
          equipment: exerciseEquipmentLabel(option, ownedEquipment) ?? option.equipment ?? null,
          primaryMuscle: option.primary_muscle ?? null,
          overlap: option._overlap ?? null,
        })),
      };
    }),
      };
    if (__DEV__) {
      const dt = Date.now() - tBuild;
      if (dt > 16) console.log(`[ActiveWorkout][perf] buildWatchWorkoutSnapshot ${dt}ms (lazy — ok if not in tap path)`);
    }
    return result;
  }, [displayExerciseWeight, hrZones, ownedEquipment, preSetHints, swapCandidatesForExercise, workout]);

  buildWatchWorkoutSnapshotRef.current = buildWatchWorkoutSnapshot;

  // Bump the structural revision when inputs that change the watch
  // snapshot SHAPE (not the per-set values) change. The auto-push effect
  // below uses this counter as its trigger so a normal set log no longer
  // re-runs the heavy snapshot-key computation on every tap.
  useEffect(() => { bumpWatchPlanRevision(); }, [hrZones, warmupSteps, workout.focus, workout.day, workout.stimulus, exerciseLibrary, bumpWatchPlanRevision]);

  const performWatchExerciseSwap = useCallback(async (
    exerciseIndex: number,
    toExerciseName?: string | null,
  ) => {
    const current = exercisesRef.current[exerciseIndex];
    if (!current) return;
    const library = await ensureExerciseLibrary();
    const candidates = swapCandidatesForExercise(current, library, 8);
    const requestedName = normalizeSwapText(toExerciseName);
    const selected = requestedName
      ? candidates.find(item => normalizeSwapText(item.name) === requestedName)
      : candidates[0];
    if (!selected) return;

    const updated = exercisesRef.current.slice();
    const previous = updated[exerciseIndex];
    if (!previous) return;
    updated[exerciseIndex] = {
      ...previous,
      name: selected.name,
      equipment: exerciseEquipmentLabel(selected, ownedEquipment) ?? selected.equipment ?? previous.equipment,
      image_url: selected.image_url ?? previous.image_url,
      video_id: selected.video_id ?? previous.video_id ?? null,
      slug: selected.slug ?? null,
      primaryMuscle: selected.primary_muscle ?? previous.primaryMuscle ?? null,
      secondaryMuscles: selected.secondary_muscles ?? previous.secondaryMuscles ?? [],
      movementPattern: selected.movement_pattern ?? previous.movementPattern ?? previous.movement_pattern ?? null,
      muscles_targeted: [
        selected.primary_muscle,
        ...(selected.secondary_muscles ?? []),
      ].filter(Boolean) as string[],
      isCompound: selected.is_compound ?? previous.isCompound ?? null,
      aiRecommendation: undefined,
      targetWeightLbs: null,
      setScheme: null,
      weightRecommendationSource: null,
      targetSets: previous.targetSets,
      targetReps: previous.targetReps,
      targetRestSeconds: previous.targetRestSeconds,
      sets: previous.sets ?? [],
    };

    setExercises(updated);
    setActiveExIdx(exerciseIndex);
    setPreSetHints(prev => {
      const next = { ...prev };
      delete next[exerciseIndex];
      return next;
    });
    setSetInputs(prev => {
      const next: typeof prev = {};
      Object.entries(prev).forEach(([key, value]) => {
        if (!key.startsWith(`${exerciseIndex}-`)) next[key] = value;
      });
      return next;
    });
    clearRestStateRef.current?.();
    bumpWatchPlanRevision();

    try {
      const { pushWorkoutToWatch } = await import('../utils/watchSync');
      await pushWorkoutToWatch(buildWatchWorkoutSnapshot(updated, { skipHintIndex: exerciseIndex }), {
        dateISO: dateKey(new Date()),
        status: 'active',
        sessionId: watchSessionId.current,
        warmupSteps: warmupStepsRef.current,
        reason: 'active_snapshot',
      });
    } catch { /* watch bridge optional */ }
  }, [buildWatchWorkoutSnapshot, bumpWatchPlanRevision, ensureExerciseLibrary, ownedEquipment, setExercises, swapCandidatesForExercise]);

  watchSwapExerciseRef.current = performWatchExerciseSwap;

  useEffect(() => {
    if (!watchSessionHydrated || !activeWorkoutStateRestored || showStartCountdown) return;
    if (lastWatchPlanRevisionPushedRef.current == null) return;
    if (lastWatchPlanRevisionPushedRef.current === watchPlanRevision) return;
    const timer = setTimeout(() => {
      if (watchWorkoutEndedRef.current) return;
      scheduleActiveWatchSnapshotPushRef.current({ reason: 'active_snapshot' });
    }, 250);
    return () => clearTimeout(timer);
  }, [watchPlanRevision, activeWorkoutStateRestored, showStartCountdown, watchSessionHydrated]);

  const lastPreSetWatchHintSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!watchSessionHydrated || !activeWorkoutStateRestored || showStartCountdown) return;
    const ex = exercises[activeExIdx];
    const hint = preSetHints[activeExIdx];
    if (!ex || !hint || ex.sets.length > 0 || isGuideExercise(ex, workout)) return;

    const recommendationText = hint.recommendedWeight != null
      ? `Try ${displayExerciseWeight(hint.recommendedWeight, ex)}${hint.recommendedReps ? ` x ${hint.recommendedReps}` : ''}`
      : hint.recommendedReps
        ? `Set 1: ${hint.recommendedReps} reps`
        : null;
    const signature = [
      watchSessionId.current,
      activeExIdx,
      ex.name,
      hint.recommendedWeight ?? 'held',
      hint.recommendedReps,
      recommendationText ?? 'none',
    ].join('|');
    if (lastPreSetWatchHintSignatureRef.current === signature) return;
    lastPreSetWatchHintSignatureRef.current = signature;

    scheduleWorkoutSidecar(`watch-pre-set-hint-${activeExIdx}`, async () => {
      try {
        const watchSync = preloadedWatchSyncRef.current ?? await import('../utils/watchSync');
        await watchSync.pushProgressToWatch({
          exerciseIndex: activeExIdx,
          setNumber: 1,
          recommendation: recommendationText,
          recommendedWeightLbs: hint.recommendedWeight,
          recommendedReps: hint.recommendedReps,
        });
      } catch { /* watch bridge optional */ }
    }, { detached: true });

    scheduleActiveWatchSnapshotPushRef.current({ reason: 'active_snapshot' });
  }, [
    activeExIdx,
    activeWorkoutStateRestored,
    displayExerciseWeight,
    exercises,
    preSetHints,
    scheduleWorkoutSidecar,
    showStartCountdown,
    watchSessionHydrated,
    workout,
  ]);

  // Elapsed workout timer lives inside <WorkoutDurationChip>, which
  // owns its own 1Hz interval so the parent doesn't reconcile every
  // second. No tick handler runs in this component.

  // Set up notifications immediately so lock screen alerts work from the
  // first rest. If the user previously denied notifications, the OS
  // suppresses the system permission prompt — we then show a one-time,
  // dismissable alert explaining what they're missing (rest-timer Live
  // Activity, lock-screen alert when rest ends). The dismissal is
  // remembered in AsyncStorage so the alert never repeats.
  useEffect(() => {
    if (showStartCountdown) return;
    let cancelled = false;
    (async () => {
      try {
        await configureWorkoutNotifications();
        const granted = await ensureWorkoutNotificationPermission();
        if (cancelled || granted) return;
        const dismissedKey = 'liveActivityNotifAlertDismissed_v1';
        const dismissed = await AsyncStorage.getItem(dismissedKey).catch(() => null);
        if (dismissed === '1') return;
        Alert.alert(
          'Lock-screen timer unavailable',
          "Notifications are off, so workout timers may not show on the Lock Screen or Dynamic Island, and you won't hear an alert when rest ends. Enable notifications in Settings to turn this on.",
          [
            { text: 'Not now', style: 'cancel', onPress: () => {
              AsyncStorage.setItem(dismissedKey, '1').catch(() => {});
            }},
            { text: 'Open Settings', onPress: () => {
              AsyncStorage.setItem(dismissedKey, '1').catch(() => {});
              const opener = Platform.OS === 'ios'
                ? Linking.openURL('app-settings:')
                : Linking.openSettings();
              opener.catch(() => {});
            }},
          ],
        );
      } catch { /* notif unavailable — silently degrade */ }
    })();
    return () => { cancelled = true; };
  }, [showStartCountdown]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearManagedInterval(restTimerRef);
      cancelRestNotifications(restNotificationIds.current).catch(() => undefined);
      // Swallow any error here — we're unmounting, crashes are unrecoverable.
      try { endActiveRestLiveActivity(); } catch {}
    };
  }, [endActiveRestLiveActivity]);

  // Preload last-session data so the "last time" label next to each
  // input has something to display. Inputs themselves stay EMPTY — per
  // user feedback, prefilling with last session's numbers led to
  // accidental "log same as last time" taps without thinking. The
  // reference is shown to the right of the input via `lastTimeLabel`
  // (see render block) so the user can SEE what they did before, but
  // they have to actively type today's set.
  //
  // Timed cardio exercises (treadmill, bike) are exceptions — there
  // the last session's duration IS pre-filled because users typically
  // repeat the same time block (25 min Zone 2). Only the
  // weight/reps inputs for strength work are intentionally left blank.
  const lastSessionPreloadStartedRef = useRef(false);
  useEffect(() => {
    if (!activeWorkoutStateRestored) return;
    if (lastSessionPreloadStartedRef.current) return;
    lastSessionPreloadStartedRef.current = true;
    let cancelled = false;
    Promise.all(
      exercises.map(async ex => {
        const key = exerciseHistoryKey(ex.name);
        if (key) lastSessionLookupKeysRef.current.add(key);
        const sets = await loadLastSetsForExerciseAnySource(ex, loadBackendWorkoutHistory, {
          workoutDate: dateKey(new Date()),
          focus: workout.focus,
        });
        return { name: ex.name, sets };
      })
    ).then(results => {
      if (cancelled) return;
      const map: Record<string, CompletedSet[]> = {};
      results.forEach(r => { map[r.name] = r.sets; });
      setLastExerciseSets(map);

      // Only pre-fill duration inputs for timed exercises (cardio /
      // holds). Weight + reps stay empty so the user always commits to
      // a specific number for today's set.
      const inputs: Record<string, { weight: string; reps: string; duration: string }> = {};
      exercises.forEach((ex, exIdx) => {
        const lastSets = map[ex.name] ?? [];
        if (!isTimedExercise(ex.name, ex.targetReps)) return;
        for (let slot = 0; slot < getExerciseTargetSetCount(ex); slot++) {
          const last = lastSets[slot] ?? lastSets[lastSets.length - 1];
          if (last && last.durationSeconds != null) {
            inputs[`${exIdx}-${slot}`] = { weight: '', reps: '', duration: formatDurationForInput(last.durationSeconds) };
          }
        }
      });
      setSetInputs(inputs);
    });
    return () => { cancelled = true; };
  }, [activeWorkoutStateRestored, exercises, loadBackendWorkoutHistory, workout.focus]);

  useEffect(() => {
    if (!activeWorkoutStateRestored) return;
    const toLoad = exercises.filter(ex => {
      const key = exerciseHistoryKey(ex.name);
      if (!key || lastSessionLookupKeysRef.current.has(key)) return false;
      lastSessionLookupKeysRef.current.add(key);
      return true;
    });
    if (toLoad.length === 0) return;
    let cancelled = false;
    Promise.all(
      toLoad.map(async ex => {
        const sets = await loadLastSetsForExerciseAnySource(ex, loadBackendWorkoutHistory, {
          workoutDate: dateKey(new Date()),
          focus: workout.focus,
        });
        return { name: ex.name, sets };
      })
    ).then(results => {
      if (cancelled) return;
      setLastExerciseSets(prev => {
        const next = { ...prev };
        results.forEach(r => { next[r.name] = r.sets; });
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [activeWorkoutStateRestored, exercises, loadBackendWorkoutHistory, workout.focus]);

  // Modal opens with EMPTY inputs — the user explicitly enters
  // today's values. Last session's set is shown via `lastExerciseSets`
  // as a reference label elsewhere in the UI, but the modal inputs
  // start blank to prevent accidental "log same as last time" taps.
  const openLogModal = useCallback((exIdx: number) => {
    setLogExIdx(exIdx);
    setLogWeight('');
    setLogReps('');
    setLogModalVisible(true);
  }, []);

  const openEditSet = useCallback((exIdx: number, setIdx: number) => {
    const set = exercises[exIdx]?.sets[setIdx];
    if (!set) return;
    setEditSetExIdx(exIdx);
    setEditSetIdx(setIdx);
    setEditSetWeight(displayWeightNumber(set.weightLbs));
    setEditSetReps(String(set.reps));
    setEditSetVisible(true);
  }, [displayWeightNumber, exercises]);

  const commitInlineEdit = useCallback((exIdx: number, setIdx: number) => {
    if (editCommitTimer.current) clearTimeout(editCommitTimer.current);
    editCommitTimer.current = setTimeout(() => {
      const w = parseInputWeightLbs(editDraft.weight);
      const r = parseInt(editDraft.reps ?? '', 10);
      const ex = exercises[exIdx];
      const existingSet = ex?.sets[setIdx];
      if (!existingSet) { setEditingSetKey(null); setEditDraft({}); return; }
      const guide = isGuideExercise(ex, workout);
      const newWeight = !isNaN(w) && w >= 0 ? w : existingSet.weightLbs;
      const newReps = !isNaN(r) && r > 0 ? r : existingSet.reps;
      if (newWeight === existingSet.weightLbs && newReps === existingSet.reps) {
        setEditingSetKey(null);
        setEditDraft({});
        return;
      }
      const updatedSets = ex.sets.map((s, si) =>
        si === setIdx ? { ...s, weightLbs: newWeight, reps: newReps } : s
      );
      const shouldAskRir = shouldPromptRir(newReps, ex.targetReps) && updatedSets[setIdx]?.rir == null;
      const shouldAskUnderperformance = !shouldAskRir && setIdx === 0 && shouldPromptUnderperformance(newReps, ex.targetReps) && updatedSets[setIdx]?.feedback == null;
      if (!guide && setIdx === updatedSets.length - 1 && (shouldAskRir || shouldAskUnderperformance)) {
        setPendingRir({ exIdx, setIdx, kind: shouldAskRir ? 'rir' : 'underperformance' });
      } else if (pendingRir?.exIdx === exIdx && pendingRir.setIdx === setIdx) {
        setPendingRir(null);
      }
      setExercises(prev => prev.map((e, idx) =>
        idx === exIdx ? { ...e, sets: updatedSets } : e
      ));
      setEditingSetKey(null);
      setEditDraft({});
      // Don't clear the existing recommendation — see comment in
      // handleLogSetInline. The refresh below will replace it when
      // ready; until then the previous text stays visible.
      if (!guide && !shouldPromptRir(newReps, ex.targetReps) && !(setIdx === 0 && shouldPromptUnderperformance(newReps, ex.targetReps))) {
        maybeRefreshRecommendationForExerciseRef.current?.(exIdx, updatedSets);
      }
    }, 800);
  }, [clearLiveRecommendationState, editDraft, exercises, parseInputWeightLbs, pendingRir, workout.focus, workout.stimulus]);

  const handleSaveEditedSet = useCallback(() => {
    const w = parseInputWeightLbs(editSetWeight);
    const r = parseInt(editSetReps, 10);
    if (isNaN(w) || isNaN(r) || r <= 0 || w < 0) {
      Alert.alert('Invalid values', 'Enter a valid weight and reps.');
      return;
    }
    // Compute updatedSets synchronously so we can pass them to the rec call
    // before setExercises has flushed.
    const ex = exercises[editSetExIdx];
    const updatedSets = ex?.sets.map((s, si) =>
      si === editSetIdx ? { ...s, weightLbs: w, reps: r } : s
    ) ?? [];
    const guide = isGuideExercise(ex, workout);
    const shouldAskRir = ex && shouldPromptRir(r, ex.targetReps) && updatedSets[editSetIdx]?.rir == null;
    const shouldAskUnderperformance = ex && !shouldAskRir && editSetIdx === 0 && shouldPromptUnderperformance(r, ex.targetReps) && updatedSets[editSetIdx]?.feedback == null;
    if (ex && !guide && editSetIdx === updatedSets.length - 1 && (shouldAskRir || shouldAskUnderperformance)) {
      setPendingRir({ exIdx: editSetExIdx, setIdx: editSetIdx, kind: shouldAskRir ? 'rir' : 'underperformance' });
    } else if (pendingRir?.exIdx === editSetExIdx && pendingRir.setIdx === editSetIdx) {
      setPendingRir(null);
    }
    setExercises(prev => prev.map((e, i) => {
      if (i !== editSetExIdx) return e;
      return { ...e, sets: updatedSets };
    }));
    setEditSetVisible(false);
    // Same reason as handleLogSetInline: keep the prior recommendation
    // visible until the refresh below produces a new one.
    if (!guide && !shouldPromptRir(r, ex?.targetReps) && !(editSetIdx === 0 && shouldPromptUnderperformance(r, ex?.targetReps))) {
      maybeRefreshRecommendationForExerciseRef.current?.(editSetExIdx, updatedSets);
    }
  }, [clearLiveRecommendationState, editSetExIdx, editSetIdx, editSetWeight, editSetReps, exercises, parseInputWeightLbs, pendingRir, workout.focus, workout.stimulus]);

  // Log a specific set slot inline (no modal).
  //
  // The function is split into two clearly demarcated phases:
  //
  //   1. SYNC LOCAL COMMIT — validate, build the CompletedSet, update
  //      exercises/refs once, start the in-app rest timer state, fire
  //      pre-resolved haptic + visual pulse. ZERO network or native
  //      bridge calls. Returns control to React on the next frame.
  //
  //   2. DEFERRED SIDE EFFECTS — watch progress / rest push, rest
  //      notifications, HR stamp, "workout started" backend sync,
  //      next-set recommendation refresh. Each scheduled through the
  //      sidecar as a detached task so a stuck WCSession bridge or
  //      slow cellular round trip cannot delay the next tap.
  //
  // `overrideDuration` bypasses the state read for timed exercises —
  // needed because the timer "Done" button sets duration in state then
  // calls this immediately, but React hasn't flushed the state yet.
  const handleLogSetInline = useCallback((
    exIdx: number,
    setSlot: number,
    silent = false,
    overrideDuration?: string,
    overrideWeight?: string,
    overrideReps?: string,
    sourceActionAtMs?: number,
    overrideRir?: number,
  ) => {
    const t0 = __DEV__ ? Date.now() : 0;
    if (__DEV__) setExercisesCallCountRef.current = 0;
    const key = `${exIdx}-${setSlot}`;
    const input = setInputsRef.current[key];
    const currentExercises = exercisesRef.current;
    const ex = currentExercises[exIdx];
    if (!ex) return;
    const timed = isTimedExercise(ex?.name ?? '', ex?.targetReps);
    const guide = isGuideExercise(ex, workout);

    // Watch-originated logs pass weight / reps directly as overrides
    // so we don't have to round-trip through React state first. Phone
    // UI continues to flow through setInputs.
    const effectiveWeight = overrideWeight ?? input?.weight;
    const effectiveReps = overrideReps ?? input?.reps;

    // ──────────────────────────────────────────────────────────────
    // PHASE 1 — SYNC LOCAL COMMIT
    // No awaits, no fetches, no native bridge calls past this line.
    // ──────────────────────────────────────────────────────────────

    let newSet: CompletedSet;
    let timedLiveActivityKeyToEnd: string | null = null;

    if (timed) {
      const durText = overrideDuration?.trim() || input?.duration?.trim() || '';
      const preferMinutes = isLongCardioExercise(ex?.name ?? '', ex?.targetReps, { primaryMuscle: ex?.primaryMuscle });
      const plannedDurationSeconds = parseDurationTargetSeconds(ex?.targetReps, preferMinutes);
      if (!durText && !Number.isFinite(plannedDurationSeconds)) {
        if (!silent) Alert.alert('Enter duration', 'Fill in the duration before logging this set.');
        return;
      }
      // Plain numbers default to minutes for long cardio (treadmill,
      // bike, etc.) and seconds for short holds (plank, dead hang).
      const durationSeconds = durText
        ? parseDurationInput(durText, preferMinutes)
        : Number.isFinite(plannedDurationSeconds)
          ? plannedDurationSeconds
          : 0;
      if (!Number.isFinite(durationSeconds) || (!guide && durationSeconds <= 0)) {
        if (!silent) Alert.alert('Enter duration', 'Enter a valid duration like "25:00", "25 min", or "45s".');
        return;
      }
      newSet = { setNumber: setSlot + 1, reps: 0, weightLbs: 0, durationSeconds };
      timedLiveActivityKeyToEnd = key;
    } else {
      // Mirror the UI display predicates: when the exercise is
      // bodyweight-only we don't ask for weight, and when reps are a
      // duration string ("60s hold", "3 min") we don't ask for a rep
      // count. Logging succeeds with whatever the user actually
      // touched — the other axis stays null.
      const exMeta = {
        name: ex?.name, equipment: (ex as any)?.equipment,
        reps: ex?.targetReps,
        primaryMuscle: ex?.primaryMuscle,
        primary_muscle: (ex as any)?.primary_muscle,
        _primary_muscle: (ex as any)?._primary_muscle,
        _archetype: (ex as any)?._archetype,
        _training_type: (ex as any)?._training_type,
      };
      const skipWeight = shouldHideWeight(exMeta);
      const skipReps   = shouldHideReps(exMeta);
      const weightNum  = skipWeight ? 0 : (typeof overrideWeight === 'number' ? overrideWeight : parseInputWeightLbs(effectiveWeight));
      const repsNum    = skipReps   ? 0 : parseInt(effectiveReps ?? '', 10);
      const rirNum = typeof overrideRir === 'number' && Number.isFinite(overrideRir)
        ? Math.max(0, Math.min(4, Math.round(overrideRir)))
        : undefined;
      if (!skipWeight && (!effectiveWeight || isNaN(weightNum))) {
        if (!silent) Alert.alert('Enter values', 'Fill in weight before logging this set.');
        return;
      }
      if (!skipReps && (!effectiveReps || isNaN(repsNum) || repsNum <= 0)) {
        if (!silent) Alert.alert('Enter values', 'Fill in reps before logging this set.');
        return;
      }
      newSet = { setNumber: setSlot + 1, reps: repsNum, weightLbs: weightNum, ...(rirNum != null ? { rir: rirNum } : {}) };
    }

    // Pre-resolved haptic — no dynamic-import microtask cost.
    preloadedFeedbackRef.current?.hapticMedium();

    const effectiveTotal = getEffectiveTargetSetCountRef.current(exIdx, ex, ex.sets.length + 1);

    // Build the new sets array in place; this is the ONLY exercises
    // mutation in the whole tap path.
    const updatedSets = [...ex.sets];
    updatedSets[setSlot] = newSet;
    const cleanSets = updatedSets.filter(Boolean);

    restEndedAtRef.current = 0;
    setPostRestIdleSecs(0);

    const updatedExercises = currentExercises.map((e, i) => i === exIdx ? { ...e, sets: cleanSets } : e);
    const watchCompletionProgress = buildWatchExerciseCompletionProgress(updatedExercises);
    setExercises(updatedExercises);
    setAiErrorIdx(null);

    // Visual confirmation — Animated.Value, no React commit.
    triggerSetPulse(`${exIdx}-${setSlot}`);

    // Auto-advance to next incomplete exercise when all sets are done.
    // Compute nextExIdx synchronously so the deferred phase below knows
    // which slot to push to the watch.
    let nextExIdx = exIdx;
    if (cleanSets.length >= effectiveTotal) {
      configureLiveLayoutAnimation();
      const nextIdx = updatedExercises.findIndex((e, i) => i > exIdx && e.sets.length < getExerciseTargetSetCount(e));
      setActiveExIdx(nextIdx >= 0 ? nextIdx : -1);
      nextExIdx = nextIdx >= 0 ? nextIdx : exIdx;
      preloadedFeedbackRef.current?.hapticSuccess();
    } else {
      setActiveExIdx(exIdx);
    }

    // Rest panel state lands one frame after the set commit so the
    // exercises re-render is the only work in this tap's React batch.
    let restWatchPayload: any = null;
    let restNotificationPayload: any = null;
    let deferredRestSetup: (() => void) | null = null;
    if (!guide && cleanSets.length < effectiveTotal) {
      const restSeconds = Math.max(15, ex.targetRestSeconds || 60);
      const restStartedAtMs = sourceActionAtMs && Number.isFinite(sourceActionAtMs) && sourceActionAtMs > 0
        ? sourceActionAtMs
        : Date.now();
      const restEndsAtMs = restStartedAtMs + restSeconds * 1000;
      const remainingRestSeconds = Math.max(0, Math.ceil((restEndsAtMs - Date.now()) / 1000));
      const clearedAfterRestStarted = Boolean(sourceActionAtMs && lastRestClearedAtMsRef.current >= restStartedAtMs);
      const nextSetNumber = cleanSets.length + 1;
      const rirSuggestion = !timed && typeof newSet.rir === 'number'
        ? buildRirNextSetSuggestion(ex, newSet, newSet.rir, nextSetNumber, weightUnit)
        : null;
      const nextSetLabel = rirSuggestion?.nextTarget ?? (timed
        ? `Set ${cleanSets.length + 1}: ${ex.targetReps}`
        : `Set ${cleanSets.length + 1}: ${displayExerciseWeight(newSet.weightLbs, ex)} x ${ex.targetReps}`);
      const nextSetCue = rirSuggestion?.cue ?? null;
      if (rirSuggestion) {
        writeRecommendation(exIdx, {
          text: rirSuggestion.fullText,
          nextTarget: rirSuggestion.nextTarget,
          cue: rirSuggestion.cue,
          recommendedWeightLbs: rirSuggestion.weightLbs,
          recommendedReps: rirSuggestion.repsText,
          source: 'local_fallback',
        });
      }
      if (!clearedAfterRestStarted && remainingRestSeconds > 0) {
        restDurationSeconds.current = restSeconds;
        const restExerciseName = ex.name;
        deferredRestSetup = () => {
          setRestForExercise(restExerciseName);
          setRestRemaining(remainingRestSeconds);
          setRestNextTarget(nextSetLabel);
          setRestCue(nextSetCue);
          startRestTimerRef.current(restSeconds, restExerciseName, {
            nextTarget: nextSetLabel,
            cue: nextSetCue ?? undefined,
            startedAtMs: restStartedAtMs,
          });
        };
        restWatchPayload = {
          ...watchCompletionProgress,
          exerciseIndex: exIdx,
          setNumber: cleanSets.length + 1,
          restRemainingSec: remainingRestSeconds,
          restStartedAtMs,
          restDurationSec: restSeconds,
          restEndsAtMs,
          recommendation: rirSuggestion?.watchText ?? nextSetLabel,
          recommendedWeightLbs: timed ? null : (rirSuggestion?.weightLbs ?? newSet.weightLbs),
          recommendedReps: timed ? null : (rirSuggestion?.repsText ?? ex.targetReps),
        };
        restNotificationPayload = {
          seconds: remainingRestSeconds,
          exerciseName: ex.name,
          nextSetLabel,
          aiCue: nextSetCue,
          includeStartAlert: sourceActionAtMs == null,
        };
      } else if (!sourceActionAtMs || restStartAtRef.current <= restStartedAtMs) {
        deferredRestSetup = () => clearRestStateRef.current();
      }
    } else {
      deferredRestSetup = () => clearRestStateRef.current({ pushToWatch: false });
    }

    if (deferredRestSetup) {
      requestAnimationFrame(deferredRestSetup);
    }

    if (__DEV__) {
      const dt = Date.now() - t0;
      const calls = setExercisesCallCountRef.current;
      const callTag = calls > 1 ? ` (⚠ setExercises×${calls})` : '';
      if (dt > 100) {
        console.log(`[ActiveWorkout][perf] handleLogSetInline COMMIT ${dt}ms (target <100ms)${callTag}`);
      } else {
        console.log(`[ActiveWorkout][perf] handleLogSetInline COMMIT ${dt}ms${callTag}`);
      }
    }

    // ──────────────────────────────────────────────────────────────
    // PHASE 2 — DEFERRED SIDE EFFECTS
    // Everything below runs after the UI has committed. Each task
    // is detached so a stuck bridge call never backpressures another.
    // ──────────────────────────────────────────────────────────────

    if (timedLiveActivityKeyToEnd) {
      const activityKey = timedLiveActivityKeyToEnd;
      scheduleWorkoutSidecar(`timed-live-end-${activityKey}`, () => {
        endTimedLiveActivity(activityKey);
      }, { detached: true });
    }

    // HR stamp — runs in the deferred phase, well after the user's
    // tap committed. The setExercises call here is the SECOND list
    // re-render per set log only for pro users whose Apple Watch is
    // actually streaming heart rate (the HR badge needs to refresh
    // on screen). Cheap users / users without HR exit early.
    scheduleWorkoutSidecar(`hr-stamp-${exIdx}-${setSlot}`, async () => {
      const canUseHealth = await cachedProfileIsPro();
      if (!canUseHealth) return;
      const hr = await getLatestHeartRate();
      if (!hr || hr <= 0) return;
      setExercises(prev => prev.map((e, eIdx) => {
        if (eIdx !== exIdx) return e;
        const updated = [...e.sets];
        const target = updated[setSlot];
        if (target) updated[setSlot] = { ...target, heartRateAvg: hr };
        return { ...e, sets: updated };
      }));
    }, { detached: true });

    // Mark workout as started in the backend DB on first logged set.
    if (!workoutStartedRef.current && authToken) {
      workoutStartedRef.current = true;
      scheduleWorkoutSidecar('workout-started', async () => {
        try {
          await logWorkoutStarted(authToken, dateKey(new Date()), workout.focus, workout.stimulus, {
            timeoutMs: 2500,
            noRetry: true,
          });
        } catch { /* best-effort */ }
      }, { detached: true });
    }

    // Mirror the phone's set-only state when no rest is about to
    // start (rest pushes below carry the same exercise/set fields).
    if (cleanSets.length >= effectiveTotal || guide) {
      const progressSetNumber = nextExIdx === exIdx
        ? guide && cleanSets.length < effectiveTotal
          ? cleanSets.length + 1
          : Math.min(cleanSets.length, effectiveTotal)
        : 1;
      scheduleWorkoutSidecar(`watch-progress-${exIdx}-${setSlot}`, async () => {
        try {
          const watchSync = preloadedWatchSyncRef.current ?? await import('../utils/watchSync');
          await watchSync.pushProgressToWatch({
            ...watchCompletionProgress,
            exerciseIndex: nextExIdx,
            setNumber: progressSetNumber,
            restRemainingSec: 0,
            recommendation: null,
          });
        } catch { /* watch bridge optional */ }
      }, { detached: true });
    }

    if (restWatchPayload) {
      scheduleWorkoutSidecar(`rest-watch-${exIdx}-${setSlot}`, async () => {
        try {
          const watchSync = preloadedWatchSyncRef.current ?? await import('../utils/watchSync');
          await watchSync.pushProgressToWatch(restWatchPayload);
          reassertRestProgressToWatchRef.current();
        } catch { /* watch bridge optional */ }
      }, { detached: true });
    }
    if (restNotificationPayload) {
      scheduleWorkoutSidecar(`rest-notify-${exIdx}-${setSlot}`, async () => {
        try { await rescheduleRestNotificationsRef.current(restNotificationPayload); }
        catch { /* notification reschedule is best-effort */ }
      }, { detached: true });
    }

    const setsLogged = cleanSets.length;
    if (!timed && !guide && setsLogged < effectiveTotal) {
      const needsRirPrompt = shouldPromptRir(newSet.reps, ex.targetReps) && newSet.rir == null;
      const needsUnderperformancePrompt = !needsRirPrompt
        && setSlot === 0
        && shouldPromptUnderperformance(newSet.reps, ex.targetReps)
        && newSet.feedback == null;
      if (needsRirPrompt || needsUnderperformancePrompt) {
        const nextPendingRir = { exIdx, setIdx: cleanSets.length - 1 };
        const nextPendingRirWithKind = {
          ...nextPendingRir,
          kind: needsRirPrompt ? 'rir' as const : 'underperformance' as const,
        };
        pendingRirRef.current = nextPendingRirWithKind;
        setPendingRir(nextPendingRirWithKind);
      } else if (pendingRirRef.current?.exIdx === exIdx) {
        pendingRirRef.current = null;
        setPendingRir(null);
      }
      // Do NOT clear the prior recommendation here. Clearing it makes
      // the rest panel flash to "Updating next set..." synchronously
      // during the tap, which on slow cellular reads as a multi-second
      // freeze (the previous useful text disappears, then a spinner
      // sits there until the network round trip finishes). Leave the
      // last known recommendation visible — when the new one lands the
      // panel transitions smoothly without an empty-loading state.
      if (needsRirPrompt || needsUnderperformancePrompt) {
        console.log('[progression] Recommendation deferred until set-quality feedback is logged.');
      } else {
        // Deferred — pulling the next-set recommendation from the
        // backend was the last inline network call in this hot path.
        // On slow cellular it could stall the UI between sets even
        // though the local state had already updated. Sidecar drains
        // it after the user's set log is fully committed.
        const refreshExIdx = exIdx;
        const refreshSets = cleanSets;
        scheduleWorkoutSidecar(`post-log-rec-refresh-${refreshExIdx}-${refreshSets.length}`, async () => {
          maybeRefreshRecommendationForExerciseRef.current?.(refreshExIdx, refreshSets);
        }, { detached: true });
      }
    } else if (pendingRirRef.current?.exIdx === exIdx) {
      pendingRirRef.current = null;
      setPendingRir(null);
    }
  }, [authToken, buildWatchExerciseCompletionProgress, cachedProfileIsPro, displayExerciseWeight, endTimedLiveActivity, parseInputWeightLbs, scheduleWorkoutSidecar, weightUnit, workout.focus, workout.stimulus, writeRecommendation]);
  handleLogSetInlineRef.current = handleLogSetInline;

  const handleSmartLogSet = useCallback((
    exIdx: number,
    setSlot: number,
    fallback: { weight?: string; reps?: string; referenceSet?: CompletedSet | null } = {},
  ) => {
    const key = `${exIdx}-${setSlot}`;
    const input = setInputsRef.current[key] ?? { weight: '', reps: '', duration: '' };
    const currentExercises = exercisesRef.current.length > 0 ? exercisesRef.current : exercises;
    const ex = currentExercises[exIdx];
    if (!ex) return;
    const exMeta = {
      name: ex.name,
      equipment: ex.equipment,
      reps: ex.targetReps,
      primaryMuscle: ex.primaryMuscle,
      primary_muscle: (ex as any).primary_muscle,
      _primary_muscle: (ex as any)._primary_muscle,
      _archetype: (ex as any)._archetype,
      _training_type: (ex as any)._training_type,
    };
    const skipWeight = shouldHideWeight(exMeta);
    const skipReps = shouldHideReps(exMeta);
    const weightText = (input.weight || fallback.weight || '').trim();
    const repsText = (input.reps || fallback.reps || '').trim();
    const weightNum = skipWeight ? 0 : parseInputWeightLbs(weightText);
    const repsNum = skipReps ? 0 : Number.parseInt(repsText, 10);
    const commit = () => {
      Keyboard.dismiss();
      handleLogSetInline(
        exIdx,
        setSlot,
        false,
        undefined,
        skipWeight ? undefined : weightText,
        skipReps ? undefined : repsText,
      );
    };

    if (!skipWeight && (!weightText || !Number.isFinite(weightNum))) {
      commit();
      return;
    }
    if (!skipReps && (!repsText || !Number.isFinite(repsNum) || repsNum <= 0)) {
      commit();
      return;
    }

    const historyForExercise = lastExerciseSets[ex.name] ?? [];
    const historyFallback = historyForExercise[setSlot] ?? historyForExercise[historyForExercise.length - 1] ?? null;
    const referenceSet = ex.sets[setSlot - 1] ?? fallback.referenceSet ?? historyFallback;
    const jumpThresholdLbs = unitToLbs(weightUnit === 'kg' ? 20 : 45, weightUnit);
    const weightLooksOff = !skipWeight
      && referenceSet
      && Number(referenceSet.weightLbs) > 0
      && Number.isFinite(weightNum)
      && Math.abs(weightNum - Number(referenceSet.weightLbs)) >= Math.max(jumpThresholdLbs, Number(referenceSet.weightLbs) * 0.45);
    const targetMax = parseTargetRepMax(ex.targetReps);
    const repsLookOff = !skipReps
      && Number.isFinite(repsNum)
      && (repsNum >= 60 || (targetMax != null && repsNum >= Math.max(targetMax + 10, Math.ceil(targetMax * 1.8))));

    if (weightLooksOff || repsLookOff) {
      const proposed = `${skipWeight ? '' : `${displayExerciseWeight(weightNum, ex)} x `}${skipReps ? '' : repsNum}`.trim();
      const reference = referenceSet && !skipWeight
        ? `${displayExerciseWeight(referenceSet.weightLbs, ex)} x ${referenceSet.reps}`
        : targetMax != null
          ? `target ${ex.targetReps}`
          : 'your target';
      Alert.alert(
        'Double-check set',
        `${proposed || 'This set'} looks far from ${reference}.`,
        [
          { text: 'Edit', style: 'cancel' },
          { text: 'Log anyway', onPress: commit },
        ],
      );
      return;
    }

    commit();
  }, [displayExerciseWeight, exercises, handleLogSetInline, lastExerciseSets, parseInputWeightLbs, weightUnit]);

  const openAddExerciseModal = useCallback(async () => {
    setAddExerciseModalVisible(true);
    setAiExerciseResults([]);
    setAiExerciseLoading(false);
    setExerciseMuscleFilter('all');
    if (exerciseLibraryRef.current.length > 0) {
      await refreshCustomExercisesInLibrary().catch(() => undefined);
      return;
    }
    await ensureExerciseLibrary().catch(() => undefined);
  }, [ensureExerciseLibrary, refreshCustomExercisesInLibrary]);

  const openCustomExerciseModal = useCallback(() => {
    const shouldReturnToPicker = addExerciseModalVisible;
    returnToExercisePickerAfterCustomRef.current = shouldReturnToPicker;
    if (!shouldReturnToPicker) {
      setCustomExerciseModalVisible(true);
      return;
    }
    setAddExerciseModalVisible(false);
    setTimeout(() => {
      InteractionManager.runAfterInteractions(() => setCustomExerciseModalVisible(true));
    }, 360);
  }, [addExerciseModalVisible]);

  const closeCustomExerciseModal = useCallback(() => {
    setCustomExerciseModalVisible(false);
    const shouldReturnToPicker = returnToExercisePickerAfterCustomRef.current;
    returnToExercisePickerAfterCustomRef.current = false;
    if (shouldReturnToPicker) {
      setTimeout(() => {
        InteractionManager.runAfterInteractions(() => setAddExerciseModalVisible(true));
      }, 360);
    }
  }, []);

  const previewExerciseFromPicker = useCallback((item: ExerciseLibraryItem) => {
    setReturnToExercisePickerAfterVideo(addExerciseModalVisible);
    setAddExerciseModalVisible(false);
    setTimeout(() => {
      InteractionManager.runAfterInteractions(() => openFormVideoForExercise(item));
    }, 360);
  }, [addExerciseModalVisible, openFormVideoForExercise]);

  const handleAddExercise = useCallback((item: ExerciseLibraryItem) => {
    const prescribedReps = item.reps != null ? String(item.reps).trim() : '';
    const timed = isTimedExercise(item.name, prescribedReps);
    const prescribedSets = Number(item.sets);
    const prescribedRest = Number(item.rest_seconds);
    const equipmentLabel = exerciseEquipmentLabel(item, ownedEquipment) ?? item.equipment ?? 'bodyweight';
    const nextExercise: SessionExercise = {
      name: item.name,
      targetSets: Number.isFinite(prescribedSets) && prescribedSets > 0
        ? Math.max(1, Math.floor(prescribedSets))
        : timed ? 1 : 3,
      targetReps: prescribedReps || (timed ? '15 min' : '10'),
      targetRestSeconds: Number.isFinite(prescribedRest) && prescribedRest >= 0
        ? Math.max(0, Math.round(prescribedRest))
        : timed ? 0 : 60,
      equipment: String(equipmentLabel),
      sets: [],
      aiRecommendation: undefined,
      primaryMuscle: item.primary_muscle ?? null,
      secondaryMuscles: item.secondary_muscles ?? [],
      movementPattern: item.movement_pattern ?? null,
      muscles_targeted: [
        item.primary_muscle,
        ...(item.secondary_muscles ?? []),
      ].filter(Boolean) as string[],
      isCompound: item.is_compound ?? null,
      // Carry through enrichment metadata so a freshly-added exercise
      // (wger / AI / custom) renders with the same form-video card and
      // hero thumbnail as a planner-generated one.
      video_id: (item as any).video_id ?? null,
      image_url: (item as any).image_url ?? null,
      demo_exercise_db_id: item.demo_exercise_db_id ?? null,
      slug: item.slug ?? null,
    };
    setExercises(prev => {
      // Swap mode: replace the exercise at swapTargetIdx instead of appending.
      // Preserves any already-logged sets so a mid-workout swap doesn't wipe
      // work the user did on the old lift.
      if (swapTargetIdx != null && swapTargetIdx >= 0 && swapTargetIdx < prev.length) {
        const updated = prev.slice();
        const previous = updated[swapTargetIdx];
        const carryOverSets = previous.sets ?? [];
        updated[swapTargetIdx] = {
          ...previous,
          ...nextExercise,
          sets: carryOverSets,
          targetSets: previous.targetSets,
          targetReps: previous.targetReps,
          targetRestSeconds: previous.targetRestSeconds,
          targetWeightLbs: null,
          setScheme: null,
          weightRecommendationSource: null,
        };
        setActiveExIdx(swapTargetIdx);
        return updated;
      }
      const updated = [...prev, nextExercise];
      setActiveExIdx(updated.length - 1);
      return updated;
    });
    setPreSetHints({});
    setAddExerciseModalVisible(false);
    setSwapTargetIdx(null);
    setExerciseSearch('');
    setExerciseMuscleFilter('all');
    setAiExerciseResults([]);
    bumpWatchPlanRevision();
    scheduleActiveWatchSnapshotPushRef.current({ reason: 'active_snapshot' });
  }, [ownedEquipment, swapTargetIdx, bumpWatchPlanRevision]);

  const handleAddStretchBlock = useCallback(async () => {
    const current = exercisesRef.current.length > 0 ? exercisesRef.current : exercises;
    if (hasStretchBlock(current)) {
      Alert.alert('Stretches already added', 'This workout already includes a stretch block.');
      return;
    }
    let library: ExerciseLibraryItem[] = [];
    try {
      library = await ensureExerciseLibrary();
    } catch {
      library = [];
    }
    const block = buildGeneratedStretchCircuit(library, current, {
      ownedEquipment, activeInjuryTokens,
    });
    if (block.length < 2) {
      Alert.alert('No stretches available', 'Could not find enough mobility poses in the library.');
      return;
    }
    setExercises(prev => {
      if (hasStretchBlock(prev)) return prev;
      return [...prev, ...block];
    });
    setPreSetHints({});
    setAiErrorIdx(null);
    preloadedFeedbackRef.current?.hapticSuccess();
    bumpWatchPlanRevision();
  }, [activeInjuryTokens, bumpWatchPlanRevision, ensureExerciseLibrary, exercises, ownedEquipment, setExercises]);

  const handleAddCoreCircuit = useCallback(async () => {
    const current = exercisesRef.current.length > 0 ? exercisesRef.current : exercises;
    if (hasCoreCircuit(current)) {
      Alert.alert('Core already added', 'This workout already has direct core work.');
      return;
    }

    let library: ExerciseLibraryItem[] = [];
    try {
      library = await ensureExerciseLibrary();
    } catch {
      library = [];
    }

    const circuit = buildGeneratedCoreCircuit(library, current, {
      ownedEquipment,
      activeInjuryTokens,
      workoutFocus: workout.focus,
    });

    if (circuit.length < 2) {
      Alert.alert('No core circuit available', 'No equipment-ready core options are available for this workout.');
      return;
    }

    setExercises(prev => {
      if (hasCoreCircuit(prev)) return prev;
      const updated = [...prev, ...circuit];
      setActiveExIdx(prev.length);
      return updated;
    });
    setPreSetHints({});
    setAiErrorIdx(null);
    preloadedFeedbackRef.current?.hapticSuccess();
    bumpWatchPlanRevision();
  }, [activeInjuryTokens, bumpWatchPlanRevision, ensureExerciseLibrary, exercises, ownedEquipment, setExercises, workout.focus]);

  const addCircuitFromWatch = useCallback(async (kind: 'core' | 'stretch') => {
    const current = exercisesRef.current.length > 0 ? exercisesRef.current : exercises;
    if (kind === 'core' && hasCoreCircuit(current)) return;
    if (kind === 'stretch' && hasStretchBlock(current)) return;

    let library: ExerciseLibraryItem[] = [];
    try {
      library = await ensureExerciseLibrary();
    } catch {
      library = [];
    }

    const additions = kind === 'core'
      ? buildGeneratedCoreCircuit(library, current, {
        ownedEquipment,
        activeInjuryTokens,
        workoutFocus: workout.focus,
      })
      : buildGeneratedStretchCircuit(library, current, {
        ownedEquipment,
        activeInjuryTokens,
      });
    if (additions.length < 2) return;

    setExercises(prev => {
      if (kind === 'core' && hasCoreCircuit(prev)) return prev;
      if (kind === 'stretch' && hasStretchBlock(prev)) return prev;
      const updated = [...prev, ...additions];
      if (kind === 'core') setActiveExIdx(prev.length);
      return updated;
    });
    setPreSetHints({});
    setAiErrorIdx(null);
    bumpWatchPlanRevision();
  }, [activeInjuryTokens, bumpWatchPlanRevision, ensureExerciseLibrary, exercises, ownedEquipment, setExercises, workout.focus]);

  watchAddCircuitRef.current = addCircuitFromWatch;

  /** Explicit fallback search for adding exercises that aren't in the local
   *  library. Swap stays local/ranked so it remains instant mid-workout. */
  const handleAiExerciseSearch = useCallback(async () => {
    const q = exerciseSearch.trim();
    if (!q || !authToken || swapTargetIdx != null) return;
    setAiExerciseLoading(true);
    try {
      // Pull minimal context from AsyncStorage — ActiveWorkoutScreen doesn't
      // receive userProfile as a prop so we hydrate just what we need here.
      let equipment: string[] | undefined;
      let injuries: string[] | undefined;
      try {
        const raw = await AsyncStorage.getItem('userProfile');
        if (raw) {
          const prof = JSON.parse(raw);
          equipment = prof.equipment;
          const inj = prof.injuryEntries ?? [];
          injuries = inj
            .filter((i: any) => i.status !== 'resolved')
            .map((i: any) => i.bodyPart || i.description);
        }
      } catch {}
      const blockedNames = exerciseNameKeySet(
        (exercisesRef.current.length > 0 ? exercisesRef.current : exercises).map(ex => ex.name),
      );
      const res = await searchExerciseAI(authToken, {
        query: q,
        equipment,
        injuries,
        exclude: Array.from(new Set([
          ...exerciseLibrary.map(e => e.name).filter(Boolean),
          ...(exercisesRef.current.length > 0 ? exercisesRef.current : exercises).map(ex => ex.name).filter(Boolean),
        ])),
      });
      const results = filterBlockedAiExerciseResults(res.results ?? [], blockedNames);
      setAiExerciseResults(results);
      if (results.length === 0) {
        Alert.alert('No results', `AI couldn't find a match for "${q}".`);
      }
    } catch (e: any) {
      Alert.alert('Search failed', e?.message ?? 'Could not reach the AI server.');
    } finally {
      setAiExerciseLoading(false);
    }
  }, [exerciseSearch, authToken, swapTargetIdx, exerciseLibrary, exercises]);

  const prependExerciseLibraryItem = useCallback((item: ExerciseLibraryItem) => {
    const key = normalizeSwapText(item.name);
    if (!key) return;
    const current = exerciseLibraryRef.current;
    if (current.some(row => normalizeSwapText(row.name) === key)) return;
    const next = [item, ...current];
    exerciseLibraryRef.current = next;
    setExerciseLibrary(next);
  }, []);

  /** Add an AI search result directly to the current workout. Converts the
   *  AI shape into the same `ExerciseLibraryItem` shape `handleAddExercise`
   *  expects so the workout code doesn't need to know about AI origin.
   *
   *  Also persists the exercise through the parent profile-update lane so
   *  local profile state, current search results, and the synced user-state
   *  blob all learn about it immediately. Skipped during swap mode (those
   *  are one-off substitutions, not "I want this in my library"). */
  const handleAddAiExercise = useCallback((ex: AIExerciseResult) => {
    const blockedNames = exerciseNameKeySet((exercisesRef.current.length > 0 ? exercisesRef.current : exercises).map(row => row.name));
    if (blockedNames.has(normalizeSwapText(ex.name))) {
      Alert.alert('Already in workout', `${ex.name} is already done or scheduled in this workout.`);
      return;
    }
    const customId = `custom_${Date.now()}`;
    const libraryItem = exerciseLibraryItemFromAiResult(ex, customId);
    handleAddExercise(libraryItem);
    if (swapTargetIdx != null) return;
    prependExerciseLibraryItem(libraryItem);
    // Fire-and-forget. Failures don't block the add — the exercise is
    // already in the workout; library persistence is just convenience.
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('userProfile');
        if (!raw) return;
        const prof = JSON.parse(raw);
        const existing: CustomExerciseItem[] = Array.isArray(prof.customExercises) ? prof.customExercises : [];
        const lower = ex.name.toLowerCase();
        if (existing.some((c: any) => (c.name ?? '').toLowerCase() === lower)) return;
        const nextCustoms = [...existing, customExerciseItemFromAiResult(ex, customId)];
        if (onProfileUpdate) {
          await onProfileUpdate({ customExercises: nextCustoms } as Partial<UserProfile>, true);
        } else {
          prof.customExercises = nextCustoms;
          await AsyncStorage.setItem('userProfile', JSON.stringify(prof));
        }
      } catch {
        // Silent — auto-save is best effort. The exercise is already in
        // the current session and the in-memory library for this workout.
      }
    })();
  }, [exercises, handleAddExercise, onProfileUpdate, prependExerciseLibraryItem, swapTargetIdx]);

  const handleSaveManualCustomExercise = useCallback(async (custom: CustomExerciseItem) => {
    let prof: any | null = null;
    let existing: CustomExerciseItem[] = [];
    try {
      const raw = await AsyncStorage.getItem('userProfile');
      if (raw) {
        prof = JSON.parse(raw);
        existing = Array.isArray(prof?.customExercises) ? prof.customExercises : [];
      }
    } catch {}

    const key = normalizeExerciseNameKey(custom.name);
    const saved = existing.find(c => normalizeExerciseNameKey(c.name) === key) ?? custom;
    const libraryItem = exerciseLibraryItemFromCustomExercise(saved);
    prependExerciseLibraryItem(libraryItem);
    returnToExercisePickerAfterCustomRef.current = false;
    handleAddExercise(libraryItem);

    if (saved !== custom) return;
    const nextCustoms = [...existing, custom];
    if (onProfileUpdate) {
      await onProfileUpdate({ customExercises: nextCustoms } as Partial<UserProfile>, true);
    } else if (prof) {
      prof.customExercises = nextCustoms;
      await AsyncStorage.setItem('userProfile', JSON.stringify(prof));
    }
  }, [handleAddExercise, onProfileUpdate, prependExerciseLibraryItem]);

  const saveDetectedEquipmentToProfile = useCallback(async (equipmentName: string) => {
    const trimmed = equipmentName.trim();
    if (!trimmed) return;
    let prof: any | null = null;
    let existing = ownedEquipment;
    try {
      const raw = await AsyncStorage.getItem('userProfile');
      if (raw) {
        prof = JSON.parse(raw);
        if (Array.isArray(prof?.equipment)) existing = prof.equipment;
      }
    } catch {}
    const key = normalizeSwapText(trimmed);
    if (existing.some(eq => normalizeSwapText(eq) === key)) return;
    const nextEquipment = [...existing, trimmed];
    setOwnedEquipment(nextEquipment);
    if (onProfileUpdate) {
      await onProfileUpdate({ equipment: nextEquipment } as Partial<UserProfile>, true);
    } else if (prof) {
      prof.equipment = nextEquipment;
      await AsyncStorage.setItem('userProfile', JSON.stringify(prof));
    }
  }, [onProfileUpdate, ownedEquipment]);

  const maybeOfferDetectedEquipmentSave = useCallback((equipmentName: string) => {
    const trimmed = equipmentName.trim();
    if (!trimmed) return;
    const key = normalizeSwapText(trimmed);
    if (ownedEquipment.some(eq => normalizeSwapText(eq) === key)) return;
    const label = formatEquipmentLabel(trimmed) || trimmed;
    Alert.alert(
      'Add equipment?',
      `Add ${label} to your equipment profile for future workout suggestions?`,
      [
        { text: 'Not now', style: 'cancel' },
        {
          text: 'Add',
          onPress: () => {
            saveDetectedEquipmentToProfile(trimmed)
              .catch(() => Alert.alert('Save failed', 'Could not update your equipment profile.'));
          },
        },
      ],
    );
  }, [ownedEquipment, saveDetectedEquipmentToProfile]);

  /** Photo → equipment → exercises. Pick a photo of a machine / piece
   *  of equipment, send to /ai/exercise-photo, get back the identified
   *  equipment name + 3-6 exercises that machine supports. Results
   *  feed into the same aiExerciseResults UI as the text-search path,
   *  so the user can Add any of them to the current workout (which
   *  also auto-saves to library). The backend prefers verbatim names
   *  from the user's library so a familiar cable machine surfaces the
   *  user's existing Cable Row / Lat Pulldown rows. */
  const photoScanLock = useRef(false);
  const [identifiedEquipment, setIdentifiedEquipment] = useState<string | null>(null);
  const handlePhotoExerciseScan = useCallback(async (source: 'camera' | 'library') => {
    if (!authToken || swapTargetIdx != null) return;
    if (photoScanLock.current) return;
    photoScanLock.current = true;
    try {
      if (source === 'camera') {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          Alert.alert('Camera permission needed', 'Enable camera access in Settings to scan equipment from photos.');
          return;
        }
      } else {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          Alert.alert('Photo library permission needed', 'Enable photo access in Settings to scan equipment from photos.');
          return;
        }
      }
      const result = source === 'camera'
        ? await ImagePicker.launchCameraAsync({ base64: true, quality: 0.6, mediaTypes: 'images', exif: false, allowsEditing: false, maxWidth: 1024, maxHeight: 1024 } as any)
        : await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.4, mediaTypes: 'images', exif: false, allowsEditing: false, maxWidth: 1024, maxHeight: 1024 } as any);
      if (result.canceled || !result.assets?.[0]?.base64) return;
      const asset = result.assets[0];
      const rawMime = (asset.mimeType || '').toLowerCase();
      const mime =
        rawMime === 'image/jpeg' || rawMime === 'image/jpg' || rawMime === 'image/png' || rawMime === 'image/webp'
          ? (rawMime === 'image/jpg' ? 'image/jpeg' : rawMime)
          : 'image/jpeg';

      let injuries: string[] | undefined;
      try {
        const raw = await AsyncStorage.getItem('userProfile');
        if (raw) {
          const prof = JSON.parse(raw);
          const inj = prof.injuryEntries ?? [];
          injuries = inj
            .filter((i: any) => i.status !== 'resolved')
            .map((i: any) => i.bodyPart || i.description);
        }
      } catch {}

      setAiExerciseLoading(true);
      setIdentifiedEquipment(null);
      try {
        const res = await analyzeExercisePhoto(authToken, {
          image_base64: asset.base64!,
          mime_type: mime,
          library_names: exerciseLibrary.map(e => e.name).filter(Boolean),
          equipment: ownedEquipment,
          injuries,
        });
        const rawResults = res.results ?? [];
        const blockedNames = exerciseNameKeySet(
          (exercisesRef.current.length > 0 ? exercisesRef.current : exercises).map(ex => ex.name),
        );
        const results = filterBlockedAiExerciseResults(rawResults as AIExerciseResult[], blockedNames);
        const eq = (res.equipment_identified ?? '').trim();
        if (results.length === 0) {
          Alert.alert(
            eq ? 'No exercises returned' : 'No equipment identified',
            rawResults.length > 0
              ? 'All returned exercises are already in this workout.'
              : eq
              ? `Identified ${eq} but couldn't generate exercise suggestions. Try a clearer shot.`
              : 'The photo was unclear. Try a closer shot of the machine or rack.',
          );
        }
        setIdentifiedEquipment(eq || null);
        setAiExerciseResults(results);
        if (eq) maybeOfferDetectedEquipmentSave(eq);
      } catch (e: any) {
        Alert.alert('Photo scan failed', e?.message ?? 'Could not reach the AI server.');
      } finally {
        setAiExerciseLoading(false);
      }
    } finally {
      photoScanLock.current = false;
    }
  }, [authToken, swapTargetIdx, exerciseLibrary, exercises, maybeOfferDetectedEquipmentSave, ownedEquipment]);

  // handleSaveAiExerciseToLibrary removed — its responsibility is now
  // baked into handleAddAiExercise (profile-update persistence to
  // userProfile.customExercises on Add). The dedicated "Save to library"
  // button is gone from the AI results UI; one Add button = one mental
  // model = library grows organically with what the user actually does.

  const finishRestTimer = useCallback((opts: FinishRestTimerOptions = {}) => {
    const startedAtMs = restStartAtRef.current;
    const totalSeconds = restTotalSecondsRef.current;
    if (startedAtMs <= 0 || totalSeconds <= 0) return;
    const finishKey = `${startedAtMs}:${totalSeconds}`;
    if (restFinishedKeyRef.current === finishKey) return;
    restFinishedKeyRef.current = finishKey;

    clearManagedInterval(restTimerRef);
    restRemainingRef.current = 0;
    setRestRemaining(0);
    setRestEndsAtMs(null);
    const finishedAtMs = Date.now();
    restEndedAtRef.current = finishedAtMs;
    lastRestClearedAtMsRef.current = finishedAtMs;
    setPostRestIdleSecs(0);
    AsyncStorage.removeItem('activeWorkoutRest').catch(() => {});

    const watchSync = preloadedWatchSyncRef.current;
    const watchPosition = buildWatchPositionProgress();
    if (watchSync) {
      watchSync.pushProgressToWatch({ ...watchPosition, restRemainingSec: 0 }).catch(() => undefined);
    } else {
      import('../utils/watchSync').then(({ pushProgressToWatch }) =>
        pushProgressToWatch({ ...watchPosition, restRemainingSec: 0 })
      ).catch(() => undefined);
    }

    const shouldPlayForegroundAlert = opts.playForegroundAlert === true && AppState.currentState === 'active';
    const stopKeepalive = (f: typeof import('../utils/feedback')) => {
      f.stopRestTimerKeepalive().catch(() => {});
    };
    const playForegroundAlert = (f: typeof import('../utils/feedback')) => {
      stopKeepalive(f);
      f.playRestTimerDone().catch(() => {});
      f.hapticHeavy().catch(() => {});
    };
    const feedback = preloadedFeedbackRef.current;
    if (feedback) {
      if (shouldPlayForegroundAlert) playForegroundAlert(feedback);
      else stopKeepalive(feedback);
    } else {
      import('../utils/feedback')
        .then(f => {
          if (shouldPlayForegroundAlert) playForegroundAlert(f);
          else stopKeepalive(f);
        })
        .catch(() => {
          if (shouldPlayForegroundAlert) Vibration.vibrate([0, 300, 150, 300, 150, 300]);
        });
    }

    if (opts.cancelNotifications !== false) {
      cancelRestNotifications(restNotificationIds.current).catch(() => undefined);
      restNotificationIds.current = null;
    }
    endActiveRestLiveActivity();
  }, [buildWatchPositionProgress, endActiveRestLiveActivity]);
  finishRestTimerRef.current = finishRestTimer;

  // Timestamp-based rest timer — avoids drift from re-running setInterval every second.
  //
  // SCOPE: This function is the synchronous UI commit for "rest is now
  // active". It must do nothing more than:
  //   1. update refs the in-app countdown reads
  //   2. flip the React state RestTimerPanel keys off (endsAtMs, total,
  //      restRemaining, restForExercise)
  //   3. start the interval that drives ref updates + end-of-rest sound
  //
  // EVERYTHING ELSE — AsyncStorage write, Live Activity start, native
  // audio session keepalive, watch push — is queued through the workout
  // sidecar (detached) so the user-visible timer starts on the next
  // frame instead of waiting on three native bridge round-trips.
  const startRestTimer = useCallback((seconds: number, exerciseName: string, opts?: { nextTarget?: string; cue?: string; startedAtMs?: number }) => {
    clearManagedInterval(restTimerRef);
    const startedAtMs = opts?.startedAtMs && Number.isFinite(opts.startedAtMs) && opts.startedAtMs > 0
      ? opts.startedAtMs
      : Date.now();
    const endAtMs = startedAtMs + seconds * 1000;
    const initialRemaining = Math.max(0, Math.ceil((endAtMs - Date.now()) / 1000));
    if (initialRemaining <= 0) {
      restStartAtRef.current = 0;
      restTotalSecondsRef.current = 0;
      restExerciseNameRef.current = null;
      lastRestClearedAtMsRef.current = Math.max(lastRestClearedAtMsRef.current, endAtMs);
      // Deferred — AsyncStorage.removeItem itself is async but the call
      // still posts a JS task; keep the early-return path zero-work.
      scheduleWorkoutSidecar('rest-storage-clear', async () => {
        try { await AsyncStorage.removeItem('activeWorkoutRest'); } catch { /* best-effort */ }
      }, { detached: true });
      return;
    }
    restStartAtRef.current = startedAtMs;
    restTotalSecondsRef.current = seconds;
    restExerciseNameRef.current = exerciseName;
    restEndedAtRef.current = 0;
    restFinishedKeyRef.current = null;
    setPostRestIdleSecs(0);
    restRemainingRef.current = initialRemaining;
    setRestRemaining(initialRemaining);
    // The visual rest countdown lives inside <RestTimerPanel> and
    // ticks against this `endsAtMs`. Setting it here is the only
    // signal to the panel that rest is active.
    setRestEndsAtMs(endAtMs);
    setRestTotalForPanel(seconds);

    // Snapshot the cue / next-target now (refs lag one render behind
    // state batching). Capture the closure values locally so the
    // sidecar tasks below see the post-tap values rather than racing
    // against a follow-up setRestCue.
    const snapNextTarget = opts?.nextTarget !== undefined ? opts.nextTarget : restNextTargetRef.current;
    const snapCue = opts?.cue !== undefined ? opts.cue : restCueRef.current;

    // ── Deferred side effects ──
    // Keep the iOS background audio session alive so the rest countdown
    // continues ticking when the screen locks / app backgrounds. The
    // session start touches expo-av and triggers a permission/session
    // negotiation; the in-app countdown does NOT need it to be running
    // by the time the next frame paints.
    scheduleWorkoutSidecar('rest-keepalive', async () => {
      try { await preloadedFeedbackRef.current?.startRestTimerKeepalive(); }
      catch { /* keepalive is best-effort */ }
    }, { detached: true });

    // Persist the rest snapshot for crash recovery. AsyncStorage runs
    // off the main JS thread but the JSON.stringify and the call site
    // post a microtask either way — push it past the React commit so
    // it can't show up in a render-phase profile.
    scheduleWorkoutSidecar('rest-storage-write', async () => {
      try {
        await AsyncStorage.setItem('activeWorkoutRest', JSON.stringify({
          startAtMs: startedAtMs,
          totalSeconds: seconds,
          exerciseName,
          nextTarget: snapNextTarget,
          cue: snapCue,
        }));
      } catch { /* best-effort */ }
    }, { detached: true });

    // Kick off a Live Activity on the lock screen. ActivityKit's
    // startActivity is a native bridge call; ending the prior activity
    // first is another bridge call. Run the whole chain in the sidecar
    // so the in-app rest panel renders before any of it.
    scheduleWorkoutSidecar('rest-live-activity', async () => {
      try {
        const generation = liveActivityGenerationRef.current + 1;
        liveActivityGenerationRef.current = generation;
        const priorActivityId = liveActivityIdRef.current;
        liveActivityIdRef.current = null;
        liveActivityTimerKeyRef.current = null;
        if (priorActivityId) {
          await endRestActivity(priorActivityId);
          if (liveActivityGenerationRef.current !== generation) return;
        }
        const liveStartedAtMs = restStartAtRef.current || Date.now();
        const durationSeconds = Math.max(1, restTotalSecondsRef.current || seconds);
        const nextTarget = snapNextTarget ?? 'Next set';
        const nextCue = snapCue;
        const currentExerciseIndex = exercisesRef.current.findIndex(ex => ex.name === exerciseName);
        const currentExercise = currentExerciseIndex >= 0 ? exercisesRef.current[currentExerciseIndex] : undefined;
        const totalSets = currentExercise
          ? getEffectiveTargetSetCount(currentExerciseIndex, currentExercise)
          : 3;
        const displaySetIndex = Math.min(
          parseDisplaySetIndex(nextTarget),
          Math.max(0, totalSets - 1),
        );
        const id = await startRestActivity({
          exerciseName,
          setNumber: displaySetIndex,
          totalSets,
          startedAtMs: liveStartedAtMs,
          durationSeconds,
          endDateMs: liveStartedAtMs + durationSeconds * 1000,
          nextSetRecommendation: nextCue ? `${nextTarget} - ${nextCue}` : nextTarget,
          themeColorHex: theme.colors.primary,
          workoutId: `w_${planDisplayFocus}_${Date.now()}`,
          ...liveActivityHrZoneFields(liveHR, hrZones),
        });
        if (!id) {
          if (!liveActivityDiagShownRef.current) {
            liveActivityDiagShownRef.current = true;
            const diag = getLastStartDiagnostic();
            if (diag && !diag.startsWith('ok')) {
              console.warn('[ActiveWorkout] Live Activity diagnostic:', diag);
            }
          }
          return;
        }
        if (
          liveActivityGenerationRef.current !== generation
          || restStartAtRef.current !== liveStartedAtMs
          || restExerciseNameRef.current !== exerciseName
        ) {
          await endRestActivity(id);
          return;
        }
        liveActivityIdRef.current = id;
        if (!liveActivityDiagShownRef.current) {
          liveActivityDiagShownRef.current = true;
          const diag = getLastStartDiagnostic();
          if (diag && !diag.startsWith('ok')) {
            console.warn('[ActiveWorkout] Live Activity diagnostic:', diag);
          }
        }
      } catch (e) {
        console.warn('[ActiveWorkout] Live Activity start failed (non-fatal):', e);
      }
    }, { detached: true });

    restartManagedInterval(restTimerRef, () => {
      const elapsed = Math.floor((Date.now() - restStartAtRef.current) / 1000);
      const remaining = Math.max(0, restTotalSecondsRef.current - elapsed);
      // Update the ref every tick (cheap, no re-render) so non-display
      // readers (AI rest cue scheduler, adjust handlers) see fresh
      // values. The DISPLAY countdown lives inside RestTimerPanel and
      // ticks independently from `restEndsAtMs`. We only call
      // setRestRemaining at the boundary (when remaining hits 0)
      // so the parent component re-renders TWICE per rest period —
      // start + end — instead of every second.
      restRemainingRef.current = remaining;

      if (remaining === 0) {
        finishRestTimer({
          playForegroundAlert: true,
          cancelNotifications: AppState.currentState === 'active',
        });
      }
    }, 500); // 500ms tick for smooth countdown without drift
  }, [finishRestTimer, getEffectiveTargetSetCount, hrZones, liveHR, planDisplayFocus, scheduleWorkoutSidecar, theme.colors.primary]);
  startRestTimerRef.current = startRestTimer;

  // Force-update timers when app returns from background. Also re-persist
  // the rest snapshot on background transition: if iOS evicts the app from
  // memory while it's in the background, AsyncStorage is the only thing
  // that survives. The blob is already written when startRestTimer runs,
  // but re-writing here ensures we capture any cue / next-target updates
  // that landed after the AI rec resolved.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        // Workout duration self-syncs on the next tick inside
        // <WorkoutDurationChip> (computes from Date.now() - startMs).
        const timers = activeTimersRef.current;
        const runningTimerKey =
          (timerModalKeyRef.current && timers[timerModalKeyRef.current]?.running ? timerModalKeyRef.current : null)
          ?? Object.keys(timers).find(key => timers[key]?.running);
        if (runningTimerKey) {
          bumpTimerTick();
          ensureTimerTicker();
          updateTimedLiveActivityRef.current(runningTimerKey, timers[runningTimerKey]);
        }
        // Catch up rest timer
        if (restStartAtRef.current > 0 && restTotalSecondsRef.current > 0) {
          const restElapsed = Math.floor((Date.now() - restStartAtRef.current) / 1000);
          const remaining = Math.max(0, restTotalSecondsRef.current - restElapsed);
          setRestRemaining(remaining);
          if (remaining === 0) {
            finishRestTimerRef.current({ playForegroundAlert: false, cancelNotifications: false });
          }
        }
        const activityId = liveActivityIdRef.current;
        if (activityId) {
          getRestActivityState(activityId).then(activityState => {
            if (activityState === undefined || liveActivityIdRef.current !== activityId) return;
            if (!activityState) {
              // Live Activity is gone (most commonly: user swiped it off
              // the lock screen). Do NOT clear the in-app rest — the LA
              // is a mirror, not the source of truth. Just forget the
              // dead activity ID so we stop querying it. The in-app
              // rest catch-up above (restStartAtRef block) already
              // restored the timer correctly. Previously this branch
              // called clearRestStateRef which wiped the timer entirely
              // when the user dismissed the LA — exactly the
              // "swiping off skips rest" symptom.
              liveActivityIdRef.current = null;
              liveActivityTimerKeyRef.current = null;
              return;
            }
            if (activityState.mode === 'elapsed') return;
            const remaining = Math.max(0, Math.ceil((activityState.endDateMs - Date.now()) / 1000));
            if (remaining <= 0) {
              clearRestStateRef.current();
              return;
            }
            if (Math.abs(remaining - restRemainingRef.current) <= 1) return;

            restStartAtRef.current = Date.now();
            restTotalSecondsRef.current = remaining;
            restDurationSeconds.current = remaining;
            restExerciseNameRef.current = activityState.exerciseName;
            restRemainingRef.current = remaining;
            setRestRemaining(remaining);
            setRestForExercise(activityState.exerciseName);
            if (!restNextTargetRef.current) setRestNextTarget(activityState.nextSetRecommendation);
            AsyncStorage.setItem('activeWorkoutRest', JSON.stringify({
              startAtMs: restStartAtRef.current,
              totalSeconds: remaining,
              exerciseName: activityState.exerciseName,
              nextTarget: restNextTargetRef.current ?? activityState.nextSetRecommendation,
              cue: restCueRef.current,
            })).catch(() => {});
            rescheduleRestNotificationsRef.current({
              seconds: remaining,
              exerciseName: activityState.exerciseName,
              nextSetLabel: restNextTargetRef.current ?? activityState.nextSetRecommendation,
              aiCue: restCueRef.current,
              includeStartAlert: false,
            }).catch(() => undefined);
          }).catch(() => {});
        }
      } else if (state === 'background' || state === 'inactive') {
        if (restStartAtRef.current > 0 && restTotalSecondsRef.current > 0 && restExerciseNameRef.current) {
          AsyncStorage.setItem('activeWorkoutRest', JSON.stringify({
            startAtMs: restStartAtRef.current,
            totalSeconds: restTotalSecondsRef.current,
            exerciseName: restExerciseNameRef.current,
            nextTarget: restNextTargetRef.current,
            cue: restCueRef.current,
          })).catch(() => {});
        }
      }
    });
    return () => sub.remove();
  }, []);

  // Re-persist whenever the AI-driven cue / next-set target updates while a
  // rest timer is active, so a crash after the tip lands keeps the latest
  // tip on screen at resume.
  useEffect(() => {
    if (restStartAtRef.current === 0 || restTotalSecondsRef.current === 0 || !restExerciseNameRef.current) return;
    AsyncStorage.setItem('activeWorkoutRest', JSON.stringify({
      startAtMs: restStartAtRef.current,
      totalSeconds: restTotalSecondsRef.current,
      exerciseName: restExerciseNameRef.current,
      nextTarget: restNextTarget,
      cue: restCue,
    })).catch(() => {});
  }, [restNextTarget, restCue, restForExercise]);

  // Restore an in-flight rest timer after a background-kill / crash. Reads
  // the AsyncStorage blob written by startRestTimer, computes wall-clock
  // remaining via the original startAtMs, and resumes the countdown if any
  // time is left. Pre-existing iOS-scheduled rest notifications fire at
  // their original absolute times regardless of the app's state, so we
  // intentionally do NOT re-schedule notifications here (would double-fire).
  useEffect(() => {
    AsyncStorage.getItem('activeWorkoutRest').then(raw => {
      if (!raw) return;
      try {
        const data = JSON.parse(raw);
        const startAtMs = Number(data?.startAtMs);
        const totalSeconds = Number(data?.totalSeconds);
        const exName = typeof data?.exerciseName === 'string' ? data.exerciseName : null;
        if (!startAtMs || !totalSeconds || !exName) {
          AsyncStorage.removeItem('activeWorkoutRest').catch(() => {});
          return;
        }
        const elapsedSec = Math.floor((Date.now() - startAtMs) / 1000);
        const remaining = Math.max(0, totalSeconds - elapsedSec);
        if (remaining <= 0) {
          AsyncStorage.removeItem('activeWorkoutRest').catch(() => {});
          return;
        }
        restDurationSeconds.current = totalSeconds;
        setRestForExercise(exName);
        const restoredNextTarget = typeof data.nextTarget === 'string' ? data.nextTarget : undefined;
        const restoredCue = typeof data.cue === 'string' ? data.cue : undefined;
        if (restoredNextTarget) setRestNextTarget(restoredNextTarget);
        if (restoredCue) setRestCue(restoredCue);
        setRestRemaining(remaining);
        startRestTimer(remaining, exName, { nextTarget: restoredNextTarget, cue: restoredCue });
        console.log(`[ActiveWorkout] restored rest timer: ${remaining}s remaining for ${exName}`);
      } catch {
        AsyncStorage.removeItem('activeWorkoutRest').catch(() => {});
      }
    }).catch(() => {});
    // Mount-only restoration. startRestTimer is stable per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearRestState = useCallback((opts?: ClearRestStateOptions) => {
    lastRestClearedAtMsRef.current = Math.max(lastRestClearedAtMsRef.current, Date.now());
    const watchPosition = buildWatchPositionProgress();
    clearManagedInterval(restTimerRef);
    // Pre-resolved feedback module — avoids the dynamic-import
    // microtask that previously fired on every set log / cancel.
    preloadedFeedbackRef.current?.stopRestTimerKeepalive();
    setRestRemaining(0);
    setRestEndsAtMs(null);
    setRestForExercise(null);
    setRestCue(null);
    setRestNextTarget(null);
    restDurationSeconds.current = 0;
    restStartAtRef.current = 0;
    restTotalSecondsRef.current = 0;
    restExerciseNameRef.current = null;
    restFinishedKeyRef.current = null;
    if (opts?.pushToWatch !== false) {
      const watchSync = preloadedWatchSyncRef.current;
      if (watchSync) {
        watchSync.pushProgressToWatch({ ...watchPosition, restRemainingSec: 0 }).catch(() => undefined);
      } else {
        import('../utils/watchSync').then(({ pushProgressToWatch }) =>
          pushProgressToWatch({ ...watchPosition, restRemainingSec: 0 })
        ).catch(() => undefined);
      }
    }
    AsyncStorage.removeItem('activeWorkoutRest').catch(() => {});
    cancelRestNotifications(restNotificationIds.current).catch(() => undefined);
    restNotificationIds.current = null;
    endActiveRestLiveActivity({ endAll: opts?.endAllLiveActivities === true });
  }, [buildWatchPositionProgress, endActiveRestLiveActivity]);
  clearRestStateRef.current = clearRestState;

  const rescheduleRestNotifications = useCallback(async (params: {
    seconds: number;
    exerciseName: string;
    nextSetLabel: string;
    aiCue?: string | null;
    includeStartAlert?: boolean;
  }) => {
    cancelRestNotifications(restNotificationIds.current).catch(() => undefined);
    try {
      restNotificationIds.current = await scheduleRestNotifications(params);
    } catch (e) {
      restNotificationIds.current = null;
      console.warn('[ActiveWorkout] Rest notification scheduling failed (non-fatal):', e);
    }
  }, []);
  rescheduleRestNotificationsRef.current = rescheduleRestNotifications;

  const handleRemoveExercise = useCallback((exIdx: number) => {
    if (exercises.length <= 1) {
      Alert.alert('Cannot remove', 'You need at least one exercise in the workout.');
      return;
    }
    const exName = exercises[exIdx]?.name ?? 'this exercise';
    Alert.alert('Remove exercise', `Remove ${exName} from this workout?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          setPreSetHints({});
          setExercises(prev => prev.filter((_, idx) => idx !== exIdx));
          setActiveExIdx(prev => Math.max(0, prev > exIdx ? prev - 1 : Math.min(prev, exercises.length - 2)));
          if (restForExercise === exName) clearRestState();
          bumpWatchPlanRevision();
        },
      },
    ]);
  }, [bumpWatchPlanRevision, clearRestState, exercises, restForExercise]);

  const handleReorderExercise = useCallback((fromIdx: number, direction: 'up' | 'down') => {
    const toIdx = direction === 'up' ? fromIdx - 1 : fromIdx + 1;
    if (toIdx < 0 || toIdx >= exercises.length) return;
    configureLiveLayoutAnimation();
    preloadedFeedbackRef.current?.hapticSelection();
    setPreSetHints({});
    setExercises(prev => {
      const next = [...prev];
      [next[fromIdx], next[toIdx]] = [next[toIdx], next[fromIdx]];
      return next;
    });
    setActiveExIdx(toIdx);
    bumpWatchPlanRevision();
  }, [bumpWatchPlanRevision, exercises.length]);

  const handleLogSet = useCallback(() => {
    const weightNum = parseInputWeightLbs(logWeight);
    const repsNum   = parseInt(logReps, 10);
    if (!logWeight || !logReps || isNaN(weightNum) || isNaN(repsNum) || repsNum <= 0) {
      Alert.alert('Invalid Input', 'Please enter valid weight and reps.');
      return;
    }
    const currentExercises = exercisesRef.current.length > 0 ? exercisesRef.current : exercises;
    const ex = currentExercises[logExIdx];
    if (!ex) return;
    const slot = ex.sets.length;
    Promise.resolve(handleLogSetInline(logExIdx, slot, false, undefined, logWeight, logReps))
      .catch(() => undefined);
    setLogModalVisible(false);
  }, [exercises, handleLogSetInline, logExIdx, logReps, logWeight, parseInputWeightLbs]);

  const adjustActiveRestRemaining = useCallback(async (delta: number) => {
    const current = restRemainingRef.current;
    if (current <= 0 || !restForExercise) return;
    const nextRemaining = Math.max(0, current + delta);
    if (nextRemaining <= 0) {
      clearRestState();
      return;
    }
    const now = Date.now();
    const startedAtMs = restStartAtRef.current > 0 ? restStartAtRef.current : now;
    const nextEndAtMs = now + nextRemaining * 1000;
    const nextTotalSeconds = Math.max(1, Math.ceil((nextEndAtMs - startedAtMs) / 1000));
    // Update the ref synchronously so a follow-up tap fired before
    // React commits the next render still reads the new value.
    restRemainingRef.current = nextRemaining;
    restTotalSecondsRef.current = nextTotalSeconds;
    restDurationSeconds.current = nextTotalSeconds;
    setRestRemaining(nextRemaining);
    setRestTotalForPanel(nextTotalSeconds);
    setRestEndsAtMs(nextEndAtMs);
    pushRestProgressToWatchRef.current().catch(() => {});
    AsyncStorage.setItem('activeWorkoutRest', JSON.stringify({
      startAtMs: startedAtMs,
      totalSeconds: nextTotalSeconds,
      exerciseName: restForExercise,
      nextTarget: restNextTarget,
      cue: restCue,
    })).catch(() => {});
    if (liveActivityIdRef.current) {
      updateRestActivity(liveActivityIdRef.current, {
        startedAtMs,
        durationSeconds: nextTotalSeconds,
        endDateMs: nextEndAtMs,
      }).catch(() => undefined);
    }
    // Also persist the adjusted full rest duration on the exercise so the next set uses it.
    setExercises(prev => prev.map(ex =>
      ex.name === restForExercise ? { ...ex, targetRestSeconds: nextTotalSeconds } : ex
    ));
    rescheduleRestNotifications({
      seconds: nextRemaining,
      exerciseName: restForExercise,
      nextSetLabel: restNextTarget ?? 'Next set is coming up',
      aiCue: restCue,
      includeStartAlert: false,
    }).catch(() => undefined);
  }, [clearRestState, rescheduleRestNotifications, restCue, restForExercise, restNextTarget, setExercises]);

  const refreshRecommendationForExercise = useCallback(async (exIdx: number, setsForExercise: CompletedSet[]) => {
    const ex = exercises[exIdx];
    const targetSetCount = ex ? getEffectiveTargetSetCount(exIdx, ex, setsForExercise.length) : 3;
    if (!ex || setsForExercise.length >= targetSetCount || !authToken) return;
    const requestLastSet = setsForExercise[setsForExercise.length - 1];
    const isRequestCurrent = () => {
      const latestEx = exercisesRef.current[exIdx];
      const latestLastSet = latestEx?.sets?.[setsForExercise.length - 1];
      return Boolean(
        latestEx
        && latestEx.name === ex.name
        && latestEx.sets.length === setsForExercise.length
        && latestLastSet
        && latestLastSet.reps === requestLastSet?.reps
        && latestLastSet.weightLbs === requestLastSet?.weightLbs
        && latestLastSet.rir === requestLastSet?.rir
      );
    };
    if (isGuideExercise(ex, workout)) {
      clearLiveRecommendationState(exIdx);
      return;
    }
    if (isTimedExercise(ex.name, ex.targetReps)) {
      const tip = getTimedExerciseTip(ex.name, ex.targetReps, setsForExercise);
      if (tip) {
        writeRecommendation(exIdx, tip);
      }
      return;
    }

    // Bodyweight exercises don't have a meaningful weight recommendation
    // (lying leg raise, crunches, planks, push-ups…). Skip the API call
    // and emit a rep-focused tip instead so the UI doesn't display a
    // misleading "try X lbs" line on a bodyweight movement.
    if (shouldHideWeight({
      name: ex.name,
      equipment: ex.equipment,
      reps: ex.targetReps,
      primary_muscle: ex.primaryMuscle ?? undefined,
    })) {
      const setN = setsForExercise.length + 1;
      const lastReps = setsForExercise[setsForExercise.length - 1]?.reps;
      const baseTip = lastReps
        ? `Set ${setN}: aim for ${lastReps}+ reps — match or beat your last set.`
        : `Set ${setN}: hit ${ex.targetReps} clean reps.`;
      if (!isRequestCurrent()) return;
      setRestNextTarget(`Set ${setN}: ${ex.targetReps} reps`);
      setRestCue(baseTip);
      writeRecommendation(exIdx, {
        text: baseTip,
        nextTarget: `Set ${setN}: ${ex.targetReps} reps`,
        cue: baseTip,
        recommendedReps: String(lastReps || ex.targetReps),
        source: 'bodyweight',
      });
      if (liveActivityIdRef.current && liveActivityTimerKeyRef.current == null) {
        updateRestActivity(liveActivityIdRef.current, {
          setNumber: setsForExercise.length,
          totalSets: targetSetCount,
          nextSetRecommendation: baseTip.replace(/^Set \d+:\s*/, ''),
          exerciseName: ex.name,
          themeColorHex: theme.colors.primary,
        }).catch(() => undefined);
      }
      import('../utils/watchSync').then(({ pushProgressToWatch }) =>
        pushProgressToWatch({
          exerciseIndex: exIdx,
          setNumber: setN,
          recommendation: baseTip.replace(/^Set \d+:\s*/, ''),
          recommendedReps: String(lastReps || ex.targetReps),
        })
      ).catch(() => undefined);
      return;
    }

    if (!(await cachedProfileIsPro())) {
      const setN = setsForExercise.length + 1;
      const last = setsForExercise[setsForExercise.length - 1];
      const baseTip = last && Number(last.weightLbs) > 0
        ? `Set ${setN}: aim to match ${displayExerciseWeight(last.weightLbs, ex)} for ${last.reps || ex.targetReps} reps with clean form.`
        : `Set ${setN}: use a comfortable load for ${ex.targetReps} clean reps.`;
      if (!isRequestCurrent()) return;
      setRestNextTarget(`Set ${setN}: ${ex.targetReps} reps`);
      setRestCue(baseTip);
      writeRecommendation(exIdx, {
        text: baseTip,
        nextTarget: `Set ${setN}: ${ex.targetReps} reps`,
        cue: baseTip,
        recommendedWeightLbs: last && Number(last.weightLbs) > 0 ? last.weightLbs : null,
        recommendedReps: String(last?.reps || ex.targetReps),
        source: 'free_fallback',
      });
      import('../utils/watchSync').then(({ pushProgressToWatch }) =>
        pushProgressToWatch({
          exerciseIndex: exIdx,
          setNumber: setN,
          recommendation: baseTip.replace(/^Set \d+:\s*/, ''),
          recommendedWeightLbs: last && Number(last.weightLbs) > 0 ? last.weightLbs : null,
          recommendedReps: String(last?.reps || ex.targetReps),
        })
      ).catch(() => undefined);
      return;
    }

    // Deterministic fallback the user gets if the network is slow,
    // offline, or returns an error. Built up front so the timeout/catch
    // path can apply it without any extra round trips.
    const applyDeterministicFallback = () => {
      if (!isRequestCurrent()) return;
      const setN = setsForExercise.length + 1;
      const lastSet = setsForExercise[setsForExercise.length - 1];
      const lastRir = typeof lastSet?.rir === 'number' ? lastSet.rir : null;
      let nextTarget: string;
      let cueText: string;
      let fullText: string;
      let recommendedWeightLbs: number | null = null;
      let recommendedReps: string | null = null;
      if (lastSet && lastRir != null) {
        const suggestion = buildRirNextSetSuggestion(ex, lastSet, lastRir, setN, weightUnit);
        if (suggestion) {
          nextTarget = suggestion.nextTarget;
          cueText = suggestion.cue;
          fullText = suggestion.fullText;
          recommendedWeightLbs = suggestion.weightLbs;
          recommendedReps = suggestion.repsText;
        } else {
          nextTarget = `Set ${setN}: ${displayExerciseWeight(lastSet.weightLbs, ex)} x ${lastSet.reps}`;
          cueText = 'Match your last set with clean form.';
          fullText = `${nextTarget} — ${cueText}`;
          recommendedWeightLbs = lastSet.weightLbs;
          recommendedReps = String(lastSet.reps || ex.targetReps);
        }
      } else if (lastSet && Number(lastSet.weightLbs) > 0) {
        nextTarget = `Set ${setN}: ${displayExerciseWeight(lastSet.weightLbs, ex)} x ${lastSet.reps || ex.targetReps}`;
        cueText = 'Match your last set with clean form.';
        fullText = `${nextTarget} — ${cueText}`;
        recommendedWeightLbs = lastSet.weightLbs;
        recommendedReps = String(lastSet.reps || ex.targetReps);
      } else {
        nextTarget = `Set ${setN}: ${ex.targetReps} reps`;
        cueText = `Use a comfortable load for ${ex.targetReps} clean reps.`;
        fullText = `${nextTarget} — ${cueText}`;
        recommendedReps = String(ex.targetReps);
      }
      setRestNextTarget(nextTarget);
      setRestCue(cueText);
      writeRecommendation(exIdx, {
        text: fullText,
        nextTarget,
        cue: cueText,
        recommendedWeightLbs,
        recommendedReps,
        source: 'local_fallback',
        trace: { fallbackUsed: true },
      });
      import('../utils/watchSync').then(({ pushProgressToWatch }) =>
        pushProgressToWatch({
          exerciseIndex: exIdx,
          setNumber: setN,
          recommendation: fullText.replace(/^Set \d+:\s*/, ''),
          recommendedWeightLbs,
          recommendedReps,
        })
      ).catch(() => undefined);
    };

    // Do NOT flip aiLoadingIdx here. The previous recommendation is
    // still on screen, and a transient spinner during a slow cellular
    // round trip is what reads as a "freeze" — the user logs a set,
    // their useful next-set text vanishes, and they sit looking at a
    // spinner. Keep the prior text up; replace it silently on success
    // OR fall back to the deterministic suggestion on timeout/error.
    try {
      const bests = await getExerciseBests(ex).catch(() => null);
      if (!isRequestCurrent()) return;
      // 2.5s timeout: long enough for healthy cellular, short enough
      // that the user never feels a "wait" between set logs. The
      // catch block applies the deterministic fallback.
      const rec = await getWeightRecommendation(authToken, ex.name, goal, setsForExercise, setsForExercise.length + 1, {
        targetSets: ex.targetSets,
        targetReps: ex.targetReps,
        progressionPace: 'moderate',
        experienceLevel: 'intermediate',
        recoveryLevel: 'normal',
        phase: 'accumulation',
        workoutFocus: workout.focus,
        weekNumber: 1,
        incrementLbs: loadIncrementForSessionExercise(ex),
        allTimeBestWeightLbs: bests?.allTime?.weightLbs,
        allTimeBestReps: bests?.allTime?.reps,
        allTimeBestDate: bests?.allTime?.date,
        lastSessionBestWeightLbs: bests?.lastSession?.weightLbs,
        lastSessionBestReps: bests?.lastSession?.reps,
        lastSessionBestDate: bests?.lastSession?.date,
        plannedTargetWeightLbs: ex.targetWeightLbs ?? undefined,
        setScheme: plannedSetsForLiveRecommendation(ex),
        exerciseSlug: ex.slug ?? undefined,
        equipment: ex.equipment,
        primaryMuscle: ex.primaryMuscle ?? undefined,
        timeoutMs: 2500,
      });
      if (!isRequestCurrent()) return;
      const setN = setsForExercise.length + 1;
      const applyBackendRecommendation = () => {
        if (!isRequestCurrent()) return;
        const tApply = __DEV__ ? Date.now() : 0;
        const recWeightText = displayExerciseWeight(rec.weightLbs, ex);
        const tip = `Set ${setN}: try ${recWeightText} x ${rec.reps} reps — ${rec.tip}`;
        setRestNextTarget(`Set ${setN}: ${recWeightText} x ${rec.reps}`);
        setRestCue(rec.tip);
        writeRecommendation(exIdx, {
          text: tip,
          nextTarget: `Set ${setN}: ${recWeightText} x ${rec.reps}`,
          cue: rec.tip,
          recommendedWeightLbs: rec.weightLbs,
          recommendedReps: String(rec.reps),
          source: 'backend',
          trace: rec.trace ?? null,
        });
        if (__DEV__) {
          const dt = Date.now() - tApply;
          if (dt > 16) console.log(`[ActiveWorkout][perf] applyRecommendation state-flush ${dt}ms`);
        }
        if (liveActivityIdRef.current && liveActivityTimerKeyRef.current == null) {
          updateRestActivity(liveActivityIdRef.current, {
            setNumber: setsForExercise.length,
            totalSets: targetSetCount,
            nextSetRecommendation: `${recWeightText} x ${rec.reps} - ${rec.tip}`,
            exerciseName: ex.name,
            themeColorHex: theme.colors.primary,
          }).catch(() => undefined);
        }
        import('../utils/watchSync').then(({ pushProgressToWatch }) =>
          pushProgressToWatch({
            exerciseIndex: exIdx,
            setNumber: setN,
            recommendation: `${recWeightText} x ${rec.reps} - ${rec.tip}`,
            recommendedWeightLbs: rec.weightLbs,
            recommendedReps: String(rec.reps),
          })
        ).catch(() => undefined);

        const liveRestRemaining = restRemainingRef.current;
        if (liveRestRemaining > 0 && restForExercise === ex.name) {
          rescheduleRestNotifications({
            seconds: liveRestRemaining,
            exerciseName: ex.name,
            nextSetLabel: `Set ${setN}: ${recWeightText} x ${rec.reps}`,
            aiCue: rec.tip,
            includeStartAlert: false,
          }).catch(() => undefined);
        }
      };
      const applyAiSafetyHold = (status?: RecommendationAiSafety | null) => {
        if (!isRequestCurrent()) return;
        const repsText = String(rec.reps || ex.targetReps);
        const nextTarget = `Set ${setN}: ${repsText} reps`;
        const cue = 'Use a comfortable load for clean reps while this recommendation is under review.';
        const fullText = `${nextTarget} — ${cue}`;
        setRestNextTarget(nextTarget);
        setRestCue(cue);
        writeRecommendation(exIdx, {
          text: fullText,
          nextTarget,
          cue,
          recommendedWeightLbs: null,
          recommendedReps: repsText,
          source: 'ai_safety_review',
          trace: { ...(rec.trace ?? {}), aiSafety: status ?? rec.aiSafety ?? null, recommendationHeld: true },
        });
        if (liveActivityIdRef.current && liveActivityTimerKeyRef.current == null) {
          updateRestActivity(liveActivityIdRef.current, {
            setNumber: setsForExercise.length,
            totalSets: targetSetCount,
            nextSetRecommendation: fullText.replace(/^Set \d+:\s*/, ''),
            exerciseName: ex.name,
            themeColorHex: theme.colors.primary,
          }).catch(() => undefined);
        }
        import('../utils/watchSync').then(({ pushProgressToWatch }) =>
          pushProgressToWatch({
            exerciseIndex: exIdx,
            setNumber: setN,
            recommendation: fullText.replace(/^Set \d+:\s*/, ''),
            recommendedReps: repsText,
          })
        ).catch(() => undefined);
        const liveRestRemaining = restRemainingRef.current;
        if (liveRestRemaining > 0 && restForExercise === ex.name) {
          rescheduleRestNotifications({
            seconds: liveRestRemaining,
            exerciseName: ex.name,
            nextSetLabel: nextTarget,
            aiCue: cue,
            includeStartAlert: false,
          }).catch(() => undefined);
        }
      };

      if (shouldHoldAiSafetyRecommendation(rec.aiSafety)) {
        applyAiSafetyHold(rec.aiSafety);
        if (rec.aiSafety?.status === 'pending' && rec.aiSafety.cacheKey) {
          const cacheKey = rec.aiSafety.cacheKey;
          scheduleWorkoutSidecar(`next-set-ai-safety-${exIdx}-${setsForExercise.length}`, async () => {
            let status: RecommendationAiSafety | null = null;
            for (const delayMs of [1200, 2200, 4000]) {
              await waitForRecommendationSafetyPoll(delayMs);
              if (!isRequestCurrent()) return;
              try {
                status = await getRecommendationAiSafetyStatus(authToken, cacheKey);
              } catch {
                return;
              }
              if (status.status !== 'pending') break;
            }
            if (!status || !isRequestCurrent()) return;
            if (shouldHoldAiSafetyRecommendation(status)) {
              applyAiSafetyHold(status);
            } else if (status.status === 'ok' || status.verdict === 'ok') {
              applyBackendRecommendation();
            }
          }, { delayMs: 0, detached: true });
        }
        return;
      }
      applyBackendRecommendation();
    } catch {
      // Network failed, timed out (2.5s above), or user is offline.
      // Apply the deterministic fallback so the rest panel always
      // shows something useful — never a blocking loading state and
      // never a stale "Updating next set…" placeholder.
      applyDeterministicFallback();
    }
      }, [authToken, cachedProfileIsPro, clearLiveRecommendationState, displayExerciseWeight, exercises, getEffectiveTargetSetCount, goal, rescheduleRestNotifications, restForExercise, scheduleWorkoutSidecar, theme.colors.primary, weightUnit, workout.focus, workout.stimulus, writeRecommendation]);

  const maybeRefreshRecommendationForExercise = useCallback(async (
    exIdx: number,
    setsForExercise: CompletedSet[],
    opts?: { ignorePendingRir?: boolean },
  ) => {
    const ex = exercises[exIdx];
    const targetSetCount = ex ? getEffectiveTargetSetCount(exIdx, ex, setsForExercise.length) : 3;
    if (!ex || setsForExercise.length === 0 || setsForExercise.length >= targetSetCount) return;

    const lastSetIdx = setsForExercise.length - 1;
    const lastSet = setsForExercise[lastSetIdx];
    if (!lastSet) return;

    const rirStillPending = !opts?.ignorePendingRir
      && pendingRir?.exIdx === exIdx
      && pendingRir.setIdx === lastSetIdx
      && (
        (pendingRir.kind ?? 'rir') === 'underperformance'
          ? lastSet.feedback == null
          : lastSet.rir == null
      );
    if (rirStillPending) {
      clearLiveRecommendationState(exIdx, { preserveNextTarget: true });
      return;
    }

    const requestedSetCount = setsForExercise.length;
    const requestedExerciseName = ex.name;
    scheduleWorkoutSidecar(`live-rec-${exIdx}`, async () => {
      const latestEx = exercisesRef.current[exIdx];
      if (
        !latestEx
        || latestEx.name !== requestedExerciseName
        || latestEx.sets.length < requestedSetCount
      ) {
        return;
      }
      await refreshRecommendationForExercise(exIdx, latestEx.sets.slice(0, requestedSetCount));
    }, { delayMs: 500, detached: true });
  }, [clearLiveRecommendationState, exercises, getEffectiveTargetSetCount, pendingRir, refreshRecommendationForExercise, scheduleWorkoutSidecar]);
  maybeRefreshRecommendationForExerciseRef.current = maybeRefreshRecommendationForExercise;

  const requireSyncedCompletionBeforeExit = () => {
    // 'queued' means the workout is already persisted locally and will sync
    // when the backend is reachable — safe to exit, no data will be lost.
    // Only block when a save is actively in-flight ('syncing').
    if (completionSyncState !== 'syncing') return true;
    Alert.alert(
      'Still saving workout',
      'Hold this screen for a moment until the workout is saved to your account.',
    );
    return false;
  };

  const handleSubmitFeedback = async (skip = false) => {
    if (!requireSyncedCompletionBeforeExit()) return;
    // Close immediately — the user doesn't need a two-step confirmation
    // screen. Feedback persistence happens in the background and feeds the
    // deterministic weekly review; it never asks AI to rewrite the plan.
    const captured = {
      feeling: feedbackFeeling,
      intensity: feedbackIntensity,
      soreness: feedbackSoreness.slice(),
      notes: feedbackNotes,
      session: finishedSession,
    };
    setSummaryVisible(false);
    setSummaryStep('summary');
    if (finishedSession) onFinish(finishedSession);
    if (skip) return;

    // Fire-and-forget persistence + plan sync. Errors are logged but
    // never surface — the user has already moved on.
    (async () => {
      try {
        if (captured.session && captured.feeling && captured.intensity) {
          const feedbackPayload = {
            feeling: captured.feeling,
            intensity: captured.intensity,
            sorenessAreas: captured.soreness,
            notes: captured.notes.trim() || undefined,
          };
          await saveWorkoutSession({
            ...captured.session,
            feedback: {
              feeling: captured.feeling as WorkoutFeeling,
              intensity: captured.intensity as WorkoutIntensity,
              sorenessAreas: captured.soreness,
              notes: captured.notes,
            },
          });
          await updateWorkoutSummary(captured.session.id, {
            feedback: {
              feeling: captured.feeling as WorkoutFeeling,
              intensity: captured.intensity as WorkoutIntensity,
              sorenessAreas: captured.soreness,
              notes: captured.notes.trim() || undefined,
            },
          });
          const mergedPendingFeedback = await updatePendingWorkoutCompletionFeedback(captured.session.id, feedbackPayload);
          // Patch the backend WorkoutCompletion row with the feedback
          // so the weekly review's struggle metrics + the trainer can
          // see it. Re-uses the upsert path on /workouts/complete.
          if (authToken) {
            const feedbackRequest: WorkoutCompletionRequest = {
              workout_date: dateKey(new Date(captured.session.date)),
              focus_label: captured.session.focus,
              duration_seconds: captured.session.durationSeconds,
              feedback: feedbackPayload,
              source: {
                startedAt: captured.session.startedAt ?? captured.session.date,
                endedAt: captured.session.endedAt ?? null,
                externalSourceId: captured.session.id,
              },
            };
            try {
              await logWorkoutDone(
                authToken,
                feedbackRequest.workout_date,
                feedbackRequest.focus_label,
                feedbackRequest.duration_seconds,
                undefined,
                undefined,
                undefined,
                feedbackRequest.feedback,
                undefined,
                undefined,
                feedbackRequest.source,
              );
            } catch (e) {
              if (!mergedPendingFeedback) {
                await enqueueWorkoutCompletion(feedbackRequest, captured.session, e);
              }
              console.log('[handleSubmitFeedback] backend feedback patch failed:', e);
            }
          }
        }
      } catch (e) {
        console.log('[handleSubmitFeedback] background sync failed (non-fatal):', (e as any)?.message ?? e);
      }
    })();
  };

  /** Called by the confirmation step's Done button. Closes the modal
   *  and fires the finish callback to the parent navigator. */
  const dismissSummaryModal = () => {
    if (!requireSyncedCompletionBeforeExit()) return;
    setSummaryVisible(false);
    setSummaryStep('summary');
    if (finishedSession) onFinish(finishedSession);
  };

  const cancelWorkoutSession = useCallback(() => {
    if (cancelingWorkoutRef.current) return;
    cancelingWorkoutRef.current = true;
    setCancelingWorkout(true);
    watchWorkoutEndedRef.current = true;
    // Synchronous local-state cleanup only — anything that touches a
    // native bridge (AsyncStorage, WCSession, UNUserNotifications,
    // ActivityKit) is deferred so navigation can happen instantly. The
    // user reported cancel "runs poorly" — that was 4 sequential
    // AsyncStorage round-trips + a WCSession push + the rest-timer
    // teardown all blocking the navigation transition.
    clearRestState({ endAllLiveActivities: true, pushToWatch: false });
    endCardioLiveActivity();
    setActiveWatchSessionId(null);
    // Navigate IMMEDIATELY. Cleanup continues in the background.
    onCancel();
    // Background cleanup — runs after the screen has unmounted. None
    // of these need to complete before the user sees the next screen.
    InteractionManager.runAfterInteractions(() => {
      AsyncStorage.multiRemove([
        'activeWorkoutSets',
        'activeWorkoutStartTime',
        'activeWorkoutRest',
        ACTIVE_WORKOUT_TIMERS_KEY,
        'activeWatchSessionId',
        ACTIVE_WORKOUT_PAUSED_AT_KEY,
        ACTIVE_WORKOUT_PAUSED_ACCUM_MS_KEY,
      ]).catch(() => {});
      const watchSync = preloadedWatchSyncRef.current;
      const pushSkippedToWatch = (mod: typeof import('../utils/watchSync')) =>
        mod.pushWorkoutToWatch(buildWatchWorkoutSnapshotRef.current(), {
          dateISO: dateKey(new Date()),
          status: 'skipped',
          sessionId: watchSessionId.current,
          reason: 'skip',
        }).catch(() => {});
      if (watchSync) {
        pushSkippedToWatch(watchSync);
      } else {
        import('../utils/watchSync').then(pushSkippedToWatch).catch(() => {});
      }
    });
  }, [clearRestState, endCardioLiveActivity, onCancel]);

  const cancelActiveWorkoutFromWatch = useCallback(() => {
    cancelWorkoutSession();
  }, [cancelWorkoutSession]);

  // Kept in sync on every render so the watch command listener always
  // dispatches to the current finish / cancel closures.
  watchHandlersRef.current = {
    finish: () => { handleFinish(); },
    cancel: () => { cancelActiveWorkoutFromWatch(); },
  };

  const handleFinish = async () => {
    if (finishInFlightRef.current) return;
    finishInFlightRef.current = true;
    setFinishingWorkout(true);
    watchWorkoutEndedRef.current = true;
    // Pre-resolved feedback module avoids the dynamic-import microtask
    // cost on this hot path (the haptic was racing against the local
    // session save and slowing the perceived finish action).
    preloadedFeedbackRef.current?.hapticSuccess();
    setActiveWatchSessionId(null);
    clearRestState({ endAllLiveActivities: true });
    endCardioLiveActivity();
    // Reset feedback state for fresh form
    setSummaryStep('summary');
    setFeedbackFeeling(null);
    setFeedbackIntensity(null);
    setFeedbackSoreness([]);
    setFeedbackNotes('');
    setFeedbackResult(null);

    const finishedAt = new Date();
    const pauseAtFinish = workoutPauseRef.current;
    const effectiveEndMs = pauseAtFinish.paused && pauseAtFinish.pausedAtMs
      ? pauseAtFinish.pausedAtMs
      : finishedAt.getTime();
    const now = new Date(effectiveEndMs);
    const startedAtIso = new Date(startTime.current).toISOString();
    const endedAtIso = now.toISOString();
    const finalExercises = exercisesRef.current.length > 0 ? exercisesRef.current : exercises;
    const actualDurationSeconds = getElapsedSeconds();
    const liveCardioAtFinish = liveCardioRef.current ?? liveCardio;
    const liveCardioDurationSeconds = liveCardioAtFinish && liveCardioAtFinish.elapsedSeconds > 0
      ? Math.max(1, Math.round(liveCardioAtFinish.elapsedSeconds))
      : null;
    const liveDistanceMiles = liveCardioAtFinish && liveCardioAtFinish.distanceMeters > 0
      ? Math.round(((liveCardioAtFinish.distanceMeters / 1000) * MI_PER_KM_LOCAL) * 100) / 100
      : undefined;
    const liveActiveCalories = liveCardioAtFinish && liveCardioAtFinish.activeCalories > 0
      ? Math.round(liveCardioAtFinish.activeCalories)
      : undefined;
    const liveAverageHeartRate = liveCardioAtFinish && liveCardioAtFinish.heartRate && liveCardioAtFinish.heartRate > 0
      ? Math.round(liveCardioAtFinish.heartRate)
      : undefined;
    const manualDistanceDisplay = parsePositiveNumberInput(finishManualDistance);
    const manualDistanceMiles = manualDistanceDisplay != null
      ? Math.round(unitToMi(manualDistanceDisplay, distanceUnit) * 100) / 100
      : undefined;
    const manualCaloriesBurned = parsePositiveIntInput(finishManualCalories) ?? undefined;
    const manualAverageHeartRate = parsePositiveIntInput(finishManualAvgHr) ?? undefined;
    const sourceContext = workoutSourceContext;
    const templateId = (workout as any)._template_id ?? (workout as any).templateId ?? null;
    const planDayId = (workout as any).plan_day_id ?? (workout as any).planDayId ?? null;
    const focusText = workout.focus.trim();
    const liftPlusCardioFocus = /\+\s*cardio/i.test(focusText);
    const pureCardioFocus = !liftPlusCardioFocus
      && /^(cardio|conditioning|zone\s*2(?:\s*cardio)?|short intervals|long intervals|tempo|hiit|bootcamp|run|walk|ride|bike|cycling|hike|swim|row)$/i.test(focusText);
    const explicitActivityCategory = String((workout as any)._custom_activity_category ?? '').trim().toLowerCase();
    const explicitCardioStyle = String((workout as any)._custom_cardio_style ?? '').trim().toLowerCase();
    const focusBlob = `${workout.focus ?? ''} ${workout.stimulus ?? ''} ${(workout as any)._custom_cardio_subtype ?? ''}`.toLowerCase();
    const activityCategory =
      explicitActivityCategory || (/mobility|yoga|stretch|foam/.test(focusBlob) ? 'mobility'
      : /recovery/.test(focusBlob) ? 'recovery'
      : pureCardioFocus || sourceContext === 'custom_cardio' ? 'cardio'
      : 'strength');
    const activityIntensity =
      /interval|hiit|sprint/.test(focusBlob) ? 'hard'
      : /mobility|recovery|yoga|stretch|foam/.test(focusBlob) ? 'easy'
      : workout.stimulus === 'strength' || workout.stimulus === 'power' ? 'hard'
      : 'moderate';
    const perceivedActivityIntensity = (
      sourceContext !== 'planned' || activityCategory !== 'strength'
        ? (finishPerceivedIntensity ?? activityIntensity)
        : activityIntensity
    ) as ActivityIntensity;
    const activitySubtype = (workout as any)._custom_cardio_subtype ?? workout.focus.toLowerCase().replace(/\s+/g, '_');
    const activityCardioStyle = activityCategory === 'cardio' || (activityCategory === 'sport' && (explicitCardioStyle || /volley|martial|mma|box/.test(focusBlob)))
      ? (explicitCardioStyle || (/interval|hiit|sprint|volley|martial|mma|box/i.test(workout.focus) ? 'intervals' : 'steady')) as any
      : activityCategory === 'mobility' || activityCategory === 'recovery' ? 'recovery' as any : undefined;
    const cardioMetricDurationSeconds = liveCardioDurationSeconds ?? actualDurationSeconds;
    const completedDistanceMiles = liveDistanceMiles ?? manualDistanceMiles;
    const completedActiveCalories = liveActiveCalories ?? manualCaloriesBurned;
    const completedAverageHeartRate = liveAverageHeartRate ?? manualAverageHeartRate;
    const estimatedActivityCalories = estimateActivityCalories({
      durationSeconds: cardioMetricDurationSeconds,
      weightLbs,
      category: activityCategory,
      subtype: activitySubtype,
      intensity: perceivedActivityIntensity,
      cardioStyle: activityCardioStyle,
    });
    const finishAllowsOutdoorData = cardioContextAllowsOutdoorData(workout);
    const phoneFinishRoute = finishAllowsOutdoorData ? cardioGpsHandleRef.current?.getRouteCoords() ?? [] : [];
    const watchFinishRoute = finishAllowsOutdoorData ? watchRouteCoordsRef.current : [];
    const finishRoute = phoneFinishRoute.length > 0 ? phoneFinishRoute : watchFinishRoute.slice();
    const routeElevationGainFt = estimateRouteElevationGainFt(finishRoute);
    const liveElevationGainFt = finishAllowsOutdoorData ? liveCardioAtFinish?.elevationGainFt ?? null : null;
    const liveStepCount = liveCardioAtFinish?.steps ?? null;
    const completedElevationGainFt = routeElevationGainFt ?? liveElevationGainFt ?? null;
    const isCyclingActivity = /ride|bike|biking|cycl|spin/.test(`${activitySubtype} ${workout.focus}`.toLowerCase());
    const completedAvgSpeedMph = completedDistanceMiles != null && completedDistanceMiles > 0 && cardioMetricDurationSeconds > 0
      ? Math.round((completedDistanceMiles / (cardioMetricDurationSeconds / 3600)) * 10) / 10
      : null;
    const completedPaceSecPerMi = completedDistanceMiles != null && completedDistanceMiles > 0 && cardioMetricDurationSeconds > 0
      ? Math.round(cardioMetricDurationSeconds / completedDistanceMiles)
      : null;
    const explicitActivityVenue = String((workout as any)._custom_activity_venue ?? '').trim().toLowerCase();
    const completedEstimatedPowerWatts = isCyclingActivity && finishAllowsOutdoorData
      ? (liveCardioAtFinish?.estimatedPowerWatts
        ?? estimateCyclingPowerWatts({
          distanceMiles: completedDistanceMiles,
          durationSeconds: cardioMetricDurationSeconds,
          riderWeightLbs: weightLbs,
          elevationGainFt: completedElevationGainFt,
        }))
      : null;
    const activityDetails: ManualActivityDetails = {
      ...(explicitActivityVenue === 'indoor' || explicitActivityVenue === 'outdoor'
        ? { indoorOutdoor: explicitActivityVenue as 'indoor' | 'outdoor' }
        : {}),
      ...(liveCardioDurationSeconds != null ? {
        movingSeconds: liveCardioDurationSeconds,
        elapsedSeconds: actualDurationSeconds,
        durationSource: 'live_cardio_timer',
      } : {}),
      ...(completedElevationGainFt != null ? { elevationGainFt: completedElevationGainFt } : {}),
      ...(liveStepCount != null ? { steps: liveStepCount } : {}),
      ...(completedAvgSpeedMph != null ? { avgSpeedMph: completedAvgSpeedMph } : {}),
      ...(!isCyclingActivity && completedPaceSecPerMi != null ? { avgPaceSecPerMi: completedPaceSecPerMi } : {}),
      ...(completedEstimatedPowerWatts != null
        ? { avgWatts: completedEstimatedPowerWatts, avgWattsSource: 'estimated_from_distance_duration_elevation' }
        : {}),
    };
    const routeActivityDetails = Object.keys(activityDetails).length > 0 ? activityDetails : undefined;
    const sessionDurationSeconds = liveCardioDurationSeconds != null
      && (activityCategory !== 'strength' || completedDistanceMiles != null)
      ? cardioMetricDurationSeconds
      : actualDurationSeconds;
    const sessionStartedAtIso = sessionDurationSeconds !== actualDurationSeconds
      ? new Date(effectiveEndMs - sessionDurationSeconds * 1000).toISOString()
      : startedAtIso;
    const localManualActivity: WorkoutSession['manualActivity'] | undefined =
      sourceContext !== 'planned' || activityCategory !== 'strength' || completedDistanceMiles != null || completedActiveCalories != null || completedAverageHeartRate != null || finishRoute.length > 0
        ? {
            category: activityCategory as any,
            subtype: activitySubtype,
            intensity: perceivedActivityIntensity,
            cardioStyle: activityCardioStyle,
            source: sourceContext === 'custom_strength' || sourceContext === 'custom_cardio' ? 'live_tracker' as any : undefined,
            distanceMiles: completedDistanceMiles,
            caloriesBurned: completedActiveCalories ?? estimatedActivityCalories ?? undefined,
            avgHeartRate: completedAverageHeartRate,
            details: routeActivityDetails,
            routeCoords: finishRoute.length > 0 ? finishRoute : undefined,
          }
        : undefined;
    const session: WorkoutSession = {
      id: `${Date.now()}`,
      date: now.toISOString(),
      focus: workout.focus,
      durationSeconds: sessionDurationSeconds,
      startedAt: sessionStartedAtIso,
      endedAt: endedAtIso,
      exercises: finalExercises,
      completed: true,
      sourceContext,
      templateId,
      planDayId,
      ...(localManualActivity ? { manualActivity: localManualActivity } : {}),
      ...(finishRoute.length > 0 ? { routeCoords: finishRoute.map(c => ({ lat: c.lat, lon: c.lon })) } : {}),
    };
    // Snapshot the GPS route at finish time so the post-workout summary
    // map renders the trail even after the tracker is torn down.
    const fallbackSummary: WorkoutSummary = {
      caloriesBurned: 0,
      motivationMessage: 'Workout logged.',
      achievements: [],
      recommendations: [],
      headline: 'Workout logged',
      coachingPoint: 'Review your sets and add notes while the session is fresh.',
      motivation: '',
      routeCoords: finishRoute.length > 0
        ? finishRoute.map(c => ({ lat: c.lat, lon: c.lon }))
        : null,
    };
    // Keep activeWorkout* storage as a LocalDraftEntity until the DB
    // completion succeeds. A failed/queued completion must remain
    // recoverable instead of becoming a local canonical completed workout.
    setFinishedSession(session);
    setFinishModalVisible(false);
    setCompletionSyncState(authToken ? 'syncing' : 'queued');
    setSummaryData(fallbackSummary);
    setSummaryVisible(true);
    setSummaryLoading(true);
    setFinishingWorkout(false);
    import('../utils/coachingNotifications')
      .then(({ maybeSchedulePostWorkoutMealReminder }) => maybeSchedulePostWorkoutMealReminder({ dateISO: dateKey(now) }))
      .catch(() => undefined);

    // Also persist completion to backend DB so it survives cache clears.
    // Now includes per-exercise per-set data so the backend can build
    // real WorkoutSession + WorkoutExercise + ExerciseSet rows for
    // downstream systems (plan reviewer, progression engine, analytics).
    let healthMetrics: { caloriesBurned?: number; hrSummary?: { avgBpm: number; maxBpm: number; zoneMinutes: number[] } } | undefined;
    let completedPrs: PRAchievement[] = [];
    let completionCaloriesBurned: number | null = null;
    let completionDbSaved = false;
    try {
      const canUseHealth = await cachedProfileIsPro();
      let healthEnabled = canUseHealth && await isAppleHealthEnabled();
      // Self-heal: if Pro + native HK is loaded but the in-app toggle was
      // never flipped on (older users who authorized iOS HK before we
      // started auto-persisting the flag), probe getLatestHeartRate. A
      // sample returning proves native auth is granted, so we flip the
      // flag and proceed — instead of silently saving null hr_summary.
      if (canUseHealth && !healthEnabled && isHealthKitAvailable()) {
        try {
          const probe = await getLatestHeartRate();
          if (probe != null && probe > 0) {
            const { setAppleHealthEnabled } = await import('../utils/workoutHistory');
            await setAppleHealthEnabled(true);
            healthEnabled = true;
            console.log('[handleFinish] self-healed appleHealthEnabled flag (probe HR =', probe, 'bpm)');
          }
        } catch { /* probe failed → user really hasn't authorized */ }
      }
      if (healthEnabled && isHealthKitAvailable()) {
        let profileAge: number | null = null;
        let restingHeartRate: number | null = null;
        try {
          const raw = await AsyncStorage.getItem('userProfile');
          if (raw) profileAge = profileAgeFromStoredProfile(JSON.parse(raw));
        } catch {}
        try {
          const cachedHealth = await loadHealthSummary();
          const rhr = Number(cachedHealth?.restingHeartRate ?? null);
          restingHeartRate = Number.isFinite(rhr) && rhr > 0 ? rhr : null;
        } catch {}

        const [hrSummary, appleCalories] = await Promise.all([
          getWorkoutHrSummary(startTime.current, now.getTime(), profileAge, restingHeartRate, hrZones).catch((err) => {
            console.warn('[handleFinish] workout HR summary read failed:', err);
            return null;
          }),
          getAppleWorkoutCaloriesForWindow(startTime.current, now.getTime()).catch((err) => {
            console.warn('[handleFinish] workout calorie read failed:', err);
            return null;
          }),
        ]);

        if (hrSummary || appleCalories != null) {
          healthMetrics = {};
          if (hrSummary) healthMetrics.hrSummary = hrSummary;
          if (appleCalories != null) healthMetrics.caloriesBurned = appleCalories;
        }
        console.log('[handleFinish] workout HealthKit metrics:', {
          hrSamples: hrSummary?.samples ?? 0,
          avgBpm: hrSummary?.avgBpm ?? null,
          maxBpm: hrSummary?.maxBpm ?? null,
          caloriesBurned: appleCalories ?? null,
        });
      }
    } catch (healthErr) {
      console.warn('[handleFinish] workout HealthKit metric capture failed:', healthErr);
    }
    try {
      if (authToken) {
        let manualCardioDistanceCaptured = false;
        const exercisesPayload = session.exercises
          .filter(ex => ex.sets.length > 0 || (ex.warmupSets?.length ?? 0) > 0)
          .map((ex, idx) => {
            const exMetrics: Record<string, string> = {};
            for (const [k, v] of Object.entries(timedMetrics)) {
              const m = k.match(/^(\d+)-(.+)$/);
              if (m && parseInt(m[1], 10) === idx && v) exMetrics[m[2]] = v;
            }
            const rawDistVal = exMetrics.distance ? parseFloat(exMetrics.distance) : null;
            const distVal = rawDistVal != null && Number.isFinite(rawDistVal) && shouldStoreDistanceAsMiles(ex.name)
              ? unitToMi(rawDistVal, distanceUnit)
              : rawDistVal;
            if (distVal != null && Number.isFinite(distVal) && distVal > 0) manualCardioDistanceCaptured = true;
            const paceVal = exMetrics.pace || exMetrics.split || null;
            const extras = { ...exMetrics };
            delete extras.distance; delete extras.pace; delete extras.split;
            const hasExtras = Object.keys(extras).length > 0;
            return {
              name: ex.name,
              slug: ex.slug ?? (ex as any).exerciseSlug ?? (ex as any)._slug ?? null,
              target_sets: typeof ex.targetSets === 'number' ? ex.targetSets : null,
              target_reps: typeof ex.targetReps === 'string' ? ex.targetReps : null,
              equipment: typeof ex.equipment === 'string' ? ex.equipment : null,
              primary_muscle: ex.primaryMuscle ?? ex.primary_muscle ?? null,
              secondary_muscles: ex.secondaryMuscles ?? ex.secondary_muscles ?? null,
              is_compound: ex.isCompound ?? null,
              movement_pattern: ex.movementPattern ?? ex.movement_pattern ?? null,
              order_index: idx,
              sets: [
                ...(ex.warmupSets ?? []).map((s, wi, warmups) => ({
                  set_number: -(warmups.length - wi),
                  reps: s.reps ?? 0,
                  weight_lbs: s.weightLbs ?? 0,
                  duration_seconds: s.durationSeconds ?? null,
                  comfort_rating: s.comfortRating ?? null,
                  feedback: s.feedback ?? null,
                  rir: s.rir ?? null,
                  heart_rate_avg: s.heartRateAvg ?? null,
                  notes: s.notes ?? null,
                  set_type: 'warmup',
                })),
                ...ex.sets.map((s, si) => {
                  const isLast = si === ex.sets.length - 1;
                  return {
                    set_number: s.setNumber ?? si + 1,
                    reps: s.reps ?? 0,
                    weight_lbs: s.weightLbs ?? 0,
                    duration_seconds: s.durationSeconds ?? null,
                    comfort_rating: s.comfortRating ?? null,
                    feedback: s.feedback ?? null,
                    rir: s.rir ?? null,
                    heart_rate_avg: s.heartRateAvg ?? null,
                    notes: s.notes ?? null,
                    set_type: s.setType ?? 'working',
                    ...(isLast && distVal != null ? { actual_distance: distVal } : {}),
                    ...(isLast && paceVal ? { actual_pace: paceVal } : {}),
                    ...(isLast && hasExtras ? { cardio_metrics: extras } : {}),
                  };
                }),
              ],
            };
          });
        // Per-session gear disambiguation. If two or more gear items keyword-
        // match this workout (common when the user has multiple pairs of
        // running shoes), prompt them to pick which were used. Single match
        // or zero matches → no prompt, backend keyword-auto-match handles it.
        let gearIdsForLog: number[] | undefined = undefined;
        try {
          const { listGear } = await import('../services/api');
          const gear = await listGear(authToken);
          const matches = findMatchingGearForSession(
            gear,
            workout.focus,
            workout.exercises.map(ex => ex.name),
          );
          if (matches.length >= 2) {
            const picked = await new Promise<number[] | null>((resolve) => {
              setGearPickerCandidates(matches);
              setGearPickerResolver(() => resolve);
            });
            // null = user dismissed (treat as default keyword match — pass undefined).
            // [] = explicit "no gear today". [ids] = exact selection.
            gearIdsForLog = picked ?? undefined;
          }
        } catch {
          // Network or auth flake — fall back to legacy keyword auto-match.
        }

        // Pull the captured GPS route (if any) so the post-workout map
        // and Apple Fitness route both have the trail. Empty for
        // lifting + indoor + watch-tracked sessions (the watch path
        // captures via HKWorkoutRouteBuilder directly).
        const routeCoordsForBackend = finishRoute.length > 0 ? finishRoute : undefined;
        const distanceMilesForCompletion = !manualCardioDistanceCaptured ? completedDistanceMiles : undefined;
        const activityForCompletion = {
          category: activityCategory,
          subtype: localManualActivity?.subtype ?? activitySubtype,
          intensity: perceivedActivityIntensity,
          cardioStyle: localManualActivity?.cardioStyle,
          ...(distanceMilesForCompletion != null ? { distanceMiles: distanceMilesForCompletion } : {}),
          ...(completedActiveCalories != null || estimatedActivityCalories != null
            ? { caloriesBurned: completedActiveCalories ?? estimatedActivityCalories ?? undefined }
            : {}),
          ...(completedAverageHeartRate != null ? { avgHeartRate: completedAverageHeartRate } : {}),
          ...(routeActivityDetails ? { details: routeActivityDetails } : {}),
          ...(routeCoordsForBackend ? { routeCoords: routeCoordsForBackend } : {}),
        };
        const completionRequest: WorkoutCompletionRequest = {
          workout_date: dateKey(now),
          focus_label: workout.focus,
          duration_seconds: actualDurationSeconds,
          exercises: exercisesPayload,
          activity: activityForCompletion,
          healthMetrics,
          gearIds: gearIdsForLog,
          source: {
            sourceContext,
            templateId,
            planDayId,
            stimulus: workout.stimulus ?? null,
            startedAt: startedAtIso,
            endedAt: endedAtIso,
            externalSourceId: session.id,
          },
        };
        const completeResp = await completeWorkoutWithOfflineQueue(authToken, completionRequest, session);
        completionCaloriesBurned = completeResp?.calories_burned ?? null;
        if (completeResp) {
          completionDbSaved = true;
          console.log('[workout] logWorkoutDone OK — fatigue should update on next load');
          try {
            await saveWorkoutSession(session);
            if (workoutSessionCountsForPlan(session)) {
              await savePreservedCompletedWorkout(dateKey(now), workout);
            }
          } catch (cacheErr) {
            console.warn('[workout] completion cache write failed after DB save:', cacheErr);
          }
          await AsyncStorage.multiRemove([
            'activeWorkoutSession',
            'activeWorkoutSets',
            'activeWorkoutStartTime',
            'activeWorkoutRest',
            ACTIVE_WORKOUT_TIMERS_KEY,
            'activeWatchSessionId',
            ACTIVE_WORKOUT_PAUSED_AT_KEY,
            ACTIVE_WORKOUT_PAUSED_ACCUM_MS_KEY,
          ]).catch(() => {});
          import('../utils/workoutReminders')
            .then(({ cancelTodayWorkoutReminder }) => cancelTodayWorkoutReminder())
            .catch(() => undefined);
          import('../utils/watchSync').then(({ pushWorkoutToWatch }) =>
            pushWorkoutToWatch(buildWatchWorkoutSnapshotRef.current(), {
              dateISO: dateKey(new Date()),
              status: 'completed',
              sessionId: watchSessionId.current,
              reason: 'complete',
            }).catch(() => {}),
          ).catch(() => {});
          if (workoutSidecarMountedRef.current) setCompletionSyncState('synced');
        } else {
          console.log('[workout] completion queued for retry — local history is safe');
          finishInFlightRef.current = false;
          if (workoutSidecarMountedRef.current) setCompletionSyncState('queued');
        }

        // Refresh the daily health snapshot so today's workout minutes
        // + active energy land in the backend's daily_health_snapshots
        // row before the user moves on. Without this, the post-workout
        // numbers wouldn't push until the next app foreground.
        cachedProfileIsPro()
          .then((canUseHealth) => {
            if (!canUseHealth) return undefined;
            return import('../services/healthDataSummary')
              .then(({ refreshHealthDataSummary }) => refreshHealthDataSummary())
              .catch(() => undefined);
          })
          .catch(() => undefined);

        // PR toast + persist on session for Progress history to show "🏆 PR!"
        const prs: PRAchievement[] = completeResp?.prs ?? [];
        completedPrs = prs;
        if (prs.length > 0) {
          try {
            // Stash on the saved summary so the Progress screen can render later.
            session.prs = prs;
            await saveWorkoutSession(session);
          } catch {}
          // Fire the themed celebration modal — it handles the trophy
          // scale animation, staggered PR row fade-in, and success haptic
          // on mount. Dedupe/priority logic lives inside the component
          // so we can hand it the raw PR list.
          if (workoutSidecarMountedRef.current) setPrModalData(prs);
        }
      }
    } catch (e) {
      console.warn('[workout] logWorkoutDone FAILED:', e);
      finishInFlightRef.current = false;
      if (workoutSidecarMountedRef.current && authToken) setCompletionSyncState('queued');
    }

    // Enrich the already-open local recap. This can wait on cellular/API
    // without holding the user's finish tap hostage.
    if (workoutSidecarMountedRef.current) setSummaryLoading(true);
    try {
      const canUseAiSummary = !!authToken && await cachedProfileIsPro();
      const establishedPrs = completedPrs.filter(isEstablishedPr);
      const summaryCaloriesBurned = healthMetrics?.caloriesBurned
        ?? completionCaloriesBurned
        ?? completedActiveCalories
        ?? estimatedActivityCalories
        ?? fallbackSummary.caloriesBurned;
      const summaryHr = healthMetrics?.hrSummary
        ?? (completedAverageHeartRate
          ? { avgBpm: completedAverageHeartRate, maxBpm: completedAverageHeartRate, zoneMinutes: [] }
          : undefined);
      let s: WorkoutSummary | null = {
        ...fallbackSummary,
        caloriesBurned: summaryCaloriesBurned,
      };
      if (canUseAiSummary && authToken) {
        try {
          s = await getWorkoutSummary(authToken, {
            exercises: session.exercises,
            durationSeconds: session.durationSeconds,
            focus: session.focus,
            goal,
            weightLbs,
            caloriesBurned: summaryCaloriesBurned,
            hrSummary: summaryHr,
            prs: establishedPrs,
          });
        } catch (e) {
          console.log('[workout-summary] AI summary failed; using deterministic fallback:', (e as any)?.message ?? e);
          s = {
            ...fallbackSummary,
            caloriesBurned: summaryCaloriesBurned,
          };
        }
      }
      if (s) {
        // Reuse Apple Health data fetched before logWorkoutDone — no second fetch.
        (s as any).caloriesBurned = summaryCaloriesBurned;
        if (summaryHr) {
          (s as any).hrAvg = summaryHr.avgBpm;
          (s as any).hrMax = summaryHr.maxBpm;
          (s as any).hrZoneMinutes = summaryHr.zoneMinutes;
        }
        if (fallbackSummary.routeCoords && fallbackSummary.routeCoords.length > 1) {
          (s as any).routeCoords = fallbackSummary.routeCoords;
        }
        // Compute training score from what we just gathered. Fed into
        // the summary view + persisted on StoredWorkoutSummary so the
        // Progress chart can plot it against the day's readiness.
        try {
          const { computeTrainingScore, archetypeFromWorkout } = await import('../services/trainingScore');
          const setsCompleted = session.exercises.reduce((sum, ex) => sum + (ex.sets?.length ?? 0), 0);
          const originalPlannedSets = (workout.exercises ?? []).reduce((sum, ex: any) => sum + getExerciseTargetSetCount({ ...ex, targetSets: ex.targetSets ?? ex.sets } as any), 0);
          const currentPlannedSets = session.exercises.reduce((sum, ex) => sum + getExerciseTargetSetCount(ex), 0);
          const setsPlanned = Math.max(originalPlannedSets, currentPlannedSets);
          const exercisesCompleted = session.exercises.filter(ex => (ex.sets?.length ?? 0) > 0).length;
          const exercisesPlanned = Math.max((workout.exercises ?? []).length, session.exercises.length);
          const estimatedSec = (workout as any)?.estimatedDurationMinutes
            ? Number((workout as any).estimatedDurationMinutes) * 60
            : null;
          // Archetype-aware scoring — different formula per workout type
          // (strength vs hypertrophy vs Z2 vs HIIT vs mobility) so a heavy
          // 5x3 squat session isn't penalized for low HR like the old
          // single-formula approach did.
          const archetype = archetypeFromWorkout(workout.focus, (workout as any).stimulus);
          // Profile.goal flows through so the goal modifier (e.g.
          // muscle_gain → +volume, strength → +progression) can lightly
          // tune the score in the user's favor.
          let userGoal: string | null = null;
          try {
            const raw = await AsyncStorage.getItem('userProfile');
            if (raw) userGoal = JSON.parse(raw)?.goal ?? null;
          } catch { /* best-effort */ }
          const hitTargetLoad = session.exercises.some(ex => {
            const targetReps = parseTargetRepMax(ex.targetReps);
            const targetWeight = Number(ex.targetWeightLbs ?? 0);
            return (ex.sets ?? []).some(set => {
              const reps = Number(set.reps ?? 0);
              const weight = Number(set.weightLbs ?? 0);
              if (!Number.isFinite(reps) || reps <= 0 || targetReps == null || reps < targetReps) return false;
              return !Number.isFinite(targetWeight) || targetWeight <= 0 || weight >= targetWeight * 0.98;
            });
          });
          const ts = computeTrainingScore({
            archetype,
            goal: userGoal || goal,
            actualDurationSec: session.durationSeconds,
            estimatedDurationSec: estimatedSec,
            setsCompleted, setsPlanned: setsPlanned > 0 ? setsPlanned : null,
            exercisesCompleted, exercisesPlanned,
            hrAvg: summaryHr?.avgBpm ?? null,
            hrMax: summaryHr?.maxBpm ?? null,
            hrZoneMinutes: summaryHr?.zoneMinutes
              ? summaryHr.zoneMinutes.slice(0, 5) as [number, number, number, number, number]
              : null,
            progressionAchieved: establishedPrs.length > 0,
            hitTargetLoad,
          });
          (s as any).trainingScore = ts.score;
          (s as any).trainingRating = ts.rating;
          (s as any).trainingPillars = ts.pillars;
          (s as any).trainingPillarBreakdown = ts.pillarBreakdown;
          if (authToken && completionDbSaved) {
            const trainingPayload = {
              score: ts.score,
              rating: ts.rating,
              pillars: ts.pillars,
              pillarBreakdown: ts.pillarBreakdown,
            };
            const scoreRequest: WorkoutCompletionRequest = {
              workout_date: dateKey(new Date(session.date)),
              focus_label: session.focus,
              duration_seconds: session.durationSeconds,
              training: trainingPayload,
              source: {
                startedAt: session.startedAt ?? session.date,
                endedAt: session.endedAt ?? null,
                externalSourceId: session.id,
              },
            };
            completeWorkoutWithOfflineQueue(authToken, scoreRequest, session)
              .then(resp => {
                if (!resp) console.log('[training-score] score patch queued for retry');
              })
              .catch(e => console.log('[training-score] score patch failed:', e));
          }
          console.log(`[training-score] ${ts.score} (${ts.rating}) pillars=${JSON.stringify(ts.pillars)}`);
        } catch (e) {
          console.log('[training-score] compute failed (non-fatal):', e);
        }
        if (workoutSidecarMountedRef.current) setSummaryData(s);
        // Persist summary so user can review it later in Progress.
        // Now includes the full per-exercise detail (name, equipment,
        // target sets/reps, and every logged set with weight + reps
        // + duration) so the Progress screen can render "exactly what
        // you did." Feedback is patched on later by handleSubmitFeedback
        // once the user fills in the form.
        const totalSets = session.exercises.reduce((sum, ex) => sum + ex.sets.length, 0);
        const totalReps = session.exercises.reduce(
          (sum, ex) => sum + ex.sets.reduce((rs, set) => rs + (Number(set.reps) || 0), 0),
          0,
        );
        const exercisesForSummary = session.exercises.map(ex => ({
          name: ex.name,
          equipment: typeof ex.equipment === 'string' ? ex.equipment : null,
          targetSets: typeof ex.targetSets === 'number' ? ex.targetSets : undefined,
          targetReps: typeof ex.targetReps === 'string' ? ex.targetReps : undefined,
          sets: ex.sets,
          warmupSets: ex.warmupSets ?? [],
        }));
        if (completionDbSaved) {
          await saveWorkoutSummary({
            ...s,
            id: session.id,
            date: session.date,
            focus: session.focus,
            durationSeconds: session.durationSeconds,
            totalSets,
            totalReps,
            stimulus: workout.stimulus ?? null,
            sourceContext,
            activityCategory,
            activitySubtype,
            cardioStyle: activityCardioStyle ?? null,
            distanceMiles: completedDistanceMiles ?? null,
            startedAt: startedAtIso,
            endedAt: endedAtIso,
            exercises: exercisesForSummary,
          });
        }
      }
    } catch {
      /* show basic summary without AI */
    } finally {
      if (workoutSidecarMountedRef.current) setSummaryLoading(false);
    }

    // ── Apple Health: read metrics after workout (non-blocking) ──────────
    try {
      if (!(await cachedProfileIsPro())) return;
      const healthEnabled = await isAppleHealthEnabled();
      if (healthEnabled && isHealthKitAvailable()) {
        let profileAge: number | null = null;
        try {
          const r = await AsyncStorage.getItem('userProfile');
          if (r) profileAge = profileAgeFromStoredProfile(JSON.parse(r));
        } catch {}
        const healthSummary = await readHealthSummary({ age: profileAge });
        if (healthSummary) {
          await saveHealthSummary(healthSummary);
          // Calculate score using in-app workout history
          const history = await loadWorkoutHistory();
          const twoWeeksAgo = Date.now() - 14 * 86400000;
          const appWorkouts14d = history.filter(s => +new Date(s.date) >= twoWeeksAgo && s.completed).length;
          // Load daysPerWeek from profile
          let daysPerWeek = 4;
          try {
            const profileRaw = await AsyncStorage.getItem('userProfile');
            if (profileRaw) daysPerWeek = JSON.parse(profileRaw).daysPerWeek ?? 4;
          } catch {}
          const scoreResult = calculateHealthScore({
            appWorkouts14d,
            targetDaysPerWeek: daysPerWeek,
            health: healthSummary,
          });
          await saveHealthScore(scoreResult);
          console.log('[handleFinish] health score:', scoreResult.fitnessScore, 'recovery:', scoreResult.recoveryMarker);
        }
      }
    } catch (healthErr) {
      console.warn('[handleFinish] Apple Health read failed (non-critical):', healthErr);
    }
  };

  const completedCount = exercises.filter(e => e.sets.length >= getExerciseTargetSetCount(e)).length;
  const totalLoggedSets = exercises.reduce((total, ex) => total + ex.sets.length, 0);
  const totalPlannedSets = exercises.reduce((total, ex) => total + getExerciseTargetSetCount(ex), 0);
  const canFinishWorkout = totalLoggedSets > 0 || isCustomCardioWorkout || !!liveCardio;
  const watchOwnsCardioMetrics = !!liveCardio && cardioGpsHandleRef.current == null && !!watchStatus?.paired && !!watchStatus?.reachable;
  const canPauseWorkout = (isCustomCardioWorkout && !watchOwnsCardioMetrics) || cardioGpsHandleRef.current != null;
  const liveCardioIsFresh = !!liveCardio
    && liveCardio.activityTypeRaw != null
    && CARDIO_ACTIVITY_RAWS.has(liveCardio.activityTypeRaw)
    && Date.now() - liveCardio.receivedAtMs < 30_000;
  const workoutOnlyHasOutdoorGpsCardioExercises = exercises.length > 0
    && exercises.every(ex => isOutdoorGpsTimedExercise(ex) || isSetlessCardioExercise(ex));
  const showHeaderWorkoutDuration = !(liveCardioIsFresh && (
    isCustomCardioWorkout || workoutOnlyHasOutdoorGpsCardioExercises
  ));
  const hideLiveCardioTimeTile = liveCardioIsFresh
    && cardioGpsWaitsForExerciseTimer
    && workoutOnlyHasOutdoorGpsCardioExercises;
  const setCompletionPct = totalPlannedSets > 0
    ? Math.min(100, Math.round((Math.min(totalLoggedSets, totalPlannedSets) / totalPlannedSets) * 100))
    : 0;
  const coreCircuitExists = useMemo(() => hasCoreCircuit(exercises), [exercises]);
  const stretchBlockExists = useMemo(() => hasStretchBlock(exercises), [exercises]);
  const guidedFlowEnabled = useMemo(() => isGuidedFlowSession({ exercises }), [exercises]);
  const summaryDurationSeconds = finishedSession?.durationSeconds ?? getElapsedSeconds();
  const summaryExercises = finishedSession?.exercises ?? exercises;
  const summarySetCount = finishedSession
    ? finishedSession.exercises.reduce((total, ex) => total + ex.sets.length, 0)
    : totalLoggedSets;
  const summaryRepCount = finishedSession
    ? finishedSession.exercises.reduce(
        (total, ex) => total + ex.sets.reduce((setTotal, set) => setTotal + (Number(set.reps) || 0), 0),
        0,
      )
    : exercises.reduce(
        (total, ex) => total + ex.sets.reduce((setTotal, set) => setTotal + (Number(set.reps) || 0), 0),
        0,
      );
  const summaryLoadVolumeLbs = useMemo(
    () => loadedVolumeLbsFromExercises(summaryExercises),
    [summaryExercises],
  );
  const summaryPlannedRepTotal = useMemo(() => summaryExercises.reduce((total, ex) => {
    const targetRepMax = parseTargetRepMax(ex.targetReps);
    if (targetRepMax == null) return total;
    return total + getExerciseTargetSetCount(ex) * targetRepMax;
  }, 0), [summaryExercises]);
  const summaryEstimatedSeconds = (workout as any)?.estimatedDurationMinutes
    ? Number((workout as any).estimatedDurationMinutes) * 60
    : null;
  const activeCardioDistanceMiles = liveCardio && liveCardio.distanceMeters > 0
    ? Math.round(((liveCardio.distanceMeters / 1000) * MI_PER_KM_LOCAL) * 100) / 100
    : null;
  const activeCardioHeartRate = liveCardio?.heartRate ?? liveHR ?? null;
  const customActivityCategory = String((workout as any)._custom_activity_category ?? '').trim().toLowerCase();
  const customActivitySubtype = String((workout as any)._custom_cardio_subtype ?? '').trim().toLowerCase()
    || workout.focus.toLowerCase().replace(/\s+/g, '_');
  const renderFocusBlob = `${workout.focus ?? ''} ${workout.stimulus ?? ''} ${customActivitySubtype}`.toLowerCase();
  const renderActivityCategory =
    customActivityCategory || (/mobility|yoga|stretch|foam/.test(renderFocusBlob) ? 'mobility'
    : /recovery/.test(renderFocusBlob) ? 'recovery'
    : isCustomCardioWorkout ? 'cardio'
    : '');
  const renderActivityIntensity =
    /interval|hiit|sprint/.test(renderFocusBlob) ? 'hard'
    : /mobility|recovery|yoga|stretch|foam/.test(renderFocusBlob) ? 'easy'
    : workout.stimulus === 'strength' || workout.stimulus === 'power' ? 'hard'
    : 'moderate';
  const finishEffectiveIntensity = (finishPerceivedIntensity ?? renderActivityIntensity) as ActivityIntensity;
  const finishManualDistanceDisplay = parsePositiveNumberInput(finishManualDistance);
  const finishManualDistanceMiles = finishManualDistanceDisplay != null
    ? Math.round(unitToMi(finishManualDistanceDisplay, distanceUnit) * 100) / 100
    : null;
  const finishManualCaloriesBurned = parsePositiveIntInput(finishManualCalories);
  const finishManualAvgHeartRate = parsePositiveIntInput(finishManualAvgHr);
  const renderActivityCardioStyle = String((workout as any)._custom_cardio_style ?? '').trim().toLowerCase()
    || (renderActivityCategory === 'mobility' || renderActivityCategory === 'recovery' ? 'recovery'
      : /interval|hiit|sprint|volley/.test(renderFocusBlob) ? 'intervals'
      : renderActivityCategory === 'cardio' || renderActivityCategory === 'sport' ? 'steady'
      : undefined);
  const summaryCardioDurationSeconds = Number(finishedSession?.manualActivity?.details?.movingSeconds)
    || (liveCardio?.elapsedSeconds && liveCardio.elapsedSeconds > 0 ? liveCardio.elapsedSeconds : null)
    || summaryDurationSeconds;
  const estimatedActiveCalories = isCustomCardioWorkout
    ? estimateActivityCalories({
        durationSeconds: summaryCardioDurationSeconds,
        weightLbs,
        category: renderActivityCategory,
        subtype: customActivitySubtype,
        intensity: finishEffectiveIntensity,
        cardioStyle: renderActivityCardioStyle,
      })
    : null;
  const activeCardioCalories = finishedSession?.manualActivity?.caloriesBurned
    ?? (liveCardio?.activeCalories && liveCardio.activeCalories > 0 ? liveCardio.activeCalories : null)
    ?? finishManualCaloriesBurned
    ?? (summaryData?.caloriesBurned && summaryData.caloriesBurned > 0 ? summaryData.caloriesBurned : null)
    ?? estimatedActiveCalories;
  const finishDistanceMilesForDisplay = activeCardioDistanceMiles ?? finishManualDistanceMiles;
  const finishHeartRateForDisplay = activeCardioHeartRate ?? finishManualAvgHeartRate;
  const finishMiddleShowsDistance = isCustomCardioWorkout && finishDistanceMilesForDisplay != null && finishDistanceMilesForDisplay > 0;
  const summaryDistanceMiles = finishedSession?.manualActivity?.distanceMiles ?? activeCardioDistanceMiles ?? finishManualDistanceMiles;
  const summaryAvgHeartRate = summaryData?.hrAvg ?? finishedSession?.manualActivity?.avgHeartRate ?? activeCardioHeartRate ?? finishManualAvgHeartRate;
  const summaryCaloriesBurned = summaryData?.caloriesBurned ?? finishedSession?.manualActivity?.caloriesBurned ?? activeCardioCalories;
  const summaryActivityDetails = finishedSession?.manualActivity?.details as ManualActivityDetails | undefined;
  const summaryElevationGainFt = Number(summaryActivityDetails?.elevationGainFt);
  const summaryAvgWatts = Number(summaryActivityDetails?.avgWatts);
  const finishMiddleStatValue = isCustomCardioWorkout
    ? finishMiddleShowsDistance
      ? formatDistance(finishDistanceMilesForDisplay ?? 0, distanceUnit, { precision: (finishDistanceMilesForDisplay ?? 0) >= 10 ? 0 : 2 })
      : activeCardioCalories != null && activeCardioCalories > 0 ? `${Math.round(activeCardioCalories)}`
      : '—'
    : `${completedCount}/${exercises.length}`;
  const finishMiddleStatLabel = isCustomCardioWorkout ? (finishMiddleShowsDistance ? 'Distance' : 'Calories') : 'Exercises';
  const finishFinalStatValue = isCustomCardioWorkout
    ? finishHeartRateForDisplay != null && finishHeartRateForDisplay > 0 ? String(Math.round(finishHeartRateForDisplay)) : '—'
    : String(totalLoggedSets);
  const finishFinalStatLabel = isCustomCardioWorkout ? 'HR' : 'Sets';
  const finishHasLiveHeartRate = activeCardioHeartRate != null && activeCardioHeartRate > 0;
  const finishHasLiveDistance = activeCardioDistanceMiles != null && activeCardioDistanceMiles > 0;
  const finishHasLiveCalories = !!(liveCardio?.activeCalories && liveCardio.activeCalories > 0);
  const finishDurationSecondsForDisplay = liveCardio?.elapsedSeconds
    && liveCardio.elapsedSeconds > 0
    && (isCustomCardioWorkout || workoutOnlyHasOutdoorGpsCardioExercises)
    ? liveCardio.elapsedSeconds
    : getElapsedSeconds();
  const showFinishManualData = workoutSourceContext !== 'planned' && (
    !finishHasLiveHeartRate
    || (isCustomCardioWorkout && (!finishHasLiveDistance || !finishHasLiveCalories))
  );
  const openFinishConfirmation = useCallback(() => {
    setFinishPerceivedIntensity((renderActivityIntensity as ActivityIntensity) || 'moderate');
    setFinishManualDistance(activeCardioDistanceMiles != null && activeCardioDistanceMiles > 0
      ? String(Math.round(miToUnit(activeCardioDistanceMiles, distanceUnit) * 100) / 100)
      : '');
    setFinishManualCalories(liveCardio?.activeCalories && liveCardio.activeCalories > 0
      ? String(Math.round(liveCardio.activeCalories))
      : '');
    setFinishManualAvgHr(activeCardioHeartRate != null && activeCardioHeartRate > 0
      ? String(Math.round(activeCardioHeartRate))
      : '');
    setFinishModalVisible(true);
  }, [
    activeCardioDistanceMiles,
    activeCardioHeartRate,
    distanceUnit,
    liveCardio?.activeCalories,
    renderActivityIntensity,
  ]);
  const summaryVisualInput = useMemo(() => ({
    focus: workoutDisplayFocus,
    stimulus: (workout as any).stimulus ?? null,
    exercises: summaryExercises,
    activityCategory: finishedSession?.manualActivity?.category
      ?? renderActivityCategory
      ?? (((workout as any)._source_context ?? (workout as any).sourceContext) === 'custom_cardio' ? 'cardio' : null),
    activitySubtype: finishedSession?.manualActivity?.subtype ?? customActivitySubtype ?? null,
    sourceContext: (workout as any)._source_context ?? (workout as any).sourceContext ?? null,
  }), [customActivitySubtype, finishedSession?.manualActivity?.category, finishedSession?.manualActivity?.subtype, renderActivityCategory, summaryExercises, workout, workoutDisplayFocus]);
  const summaryBackgroundSource = useMemo(
    () => workoutSummaryBackgroundSource(summaryVisualInput, profileGender),
    [profileGender, summaryVisualInput],
  );
  const summaryTypeLabel = useMemo(
    () => workoutSummaryTypeLabel(summaryVisualInput),
    [summaryVisualInput],
  );
  const summaryIconName = useMemo(
    () => workoutSummaryIconName(summaryVisualInput),
    [summaryVisualInput],
  );
  const summaryIsCardioLike = useMemo(() => {
    return workoutSummaryIsCardioLike(summaryVisualInput);
  }, [summaryVisualInput]);
  const summaryExpectedVolumeLbs = useMemo(
    () => plannedVolumeLbsFromExercises(summaryExercises),
    [summaryExercises],
  );
  const summaryVolumeStatusValue = useMemo(
    () => summaryVolumeStatus(
      summaryLoadVolumeLbs,
      summaryExpectedVolumeLbs,
      totalPlannedSets > 0 ? setCompletionPct : null,
    ),
    [setCompletionPct, summaryExpectedVolumeLbs, summaryLoadVolumeLbs, totalPlannedSets],
  );
  const summaryVolumeTone = summaryVolumeStatusValue.tone;
  const summaryVolumeDeltaText = summaryVolumeStatusValue.hint;
  const summaryActivityCategory = String(summaryVisualInput.activityCategory ?? '').toLowerCase();
  const summaryIsActivityLike = summaryIsCardioLike
    || (isCustomCardioWorkout && summarySetCount === 0)
    || summaryActivityCategory === 'sport'
    || summaryActivityCategory === 'active'
    || summaryActivityCategory === 'mobility';
  const summaryMetrics = useMemo(() => {
    const rows: SummaryMetric[] = [];
    const cappedSets = totalPlannedSets > 0 ? Math.min(summarySetCount, totalPlannedSets) : summarySetCount;
    const setsPct = totalPlannedSets > 0 ? Math.round((cappedSets / totalPlannedSets) * 100) : null;
    const cappedReps = summaryPlannedRepTotal > 0 ? Math.min(summaryRepCount, summaryPlannedRepTotal) : summaryRepCount;
    const repsPct = summaryPlannedRepTotal > 0 ? Math.round((cappedReps / summaryPlannedRepTotal) * 100) : null;
    const trainingScore = summaryData?.trainingScore ?? null;
    const addTime = () => {
      rows.push({
        key: 'duration',
        icon: 'time-outline',
        value: formatSummaryDuration(summaryDurationSeconds),
        label: 'Time',
        hint: durationHint(summaryDurationSeconds, summaryEstimatedSeconds),
        tone: durationTone(summaryDurationSeconds, summaryEstimatedSeconds),
      });
    };
    const addDistance = () => {
      if (summaryDistanceMiles == null || summaryDistanceMiles <= 0) return;
      rows.push({
        key: 'distance',
        icon: 'map-outline',
        value: formatDistance(summaryDistanceMiles, distanceUnit, { precision: summaryDistanceMiles >= 10 ? 0 : 2 }),
        label: 'Distance',
        hint: 'Logged',
        tone: 'good',
      });
    };
    const addElevation = () => {
      if (!Number.isFinite(summaryElevationGainFt) || summaryElevationGainFt <= 0) return;
      rows.push({
        key: 'elevation',
        icon: 'trending-up-outline',
        value: `${Math.round(summaryElevationGainFt)}`,
        label: 'Elev ft',
        hint: 'Gain',
        tone: 'good',
      });
    };
    const addPower = () => {
      if (!Number.isFinite(summaryAvgWatts) || summaryAvgWatts <= 0) return;
      rows.push({
        key: 'power',
        icon: 'flash-outline',
        value: `${Math.round(summaryAvgWatts)}`,
        label: 'Watts',
        hint: 'Estimated',
        tone: 'good',
      });
    };
    const addSets = () => {
      rows.push({
        key: 'sets',
        icon: 'barbell-outline',
        value: totalPlannedSets > 0 ? `${cappedSets}/${totalPlannedSets}` : String(summarySetCount),
        label: 'Sets',
        hint: totalPlannedSets > 0 ? pctHint(setsPct) : (summarySetCount > 0 ? 'Logged' : 'Missing'),
        tone: totalPlannedSets > 0 ? pctTone(setsPct) : (summarySetCount > 0 ? 'good' : 'bad'),
      });
    };
    const addReps = () => {
      rows.push({
        key: 'reps',
        icon: 'repeat-outline',
        value: summaryRepCount > 0 ? summaryRepCount.toLocaleString('en-US') : '0',
        label: 'Reps',
        hint: summaryPlannedRepTotal > 0 ? pctHint(repsPct) : (summaryRepCount > 0 ? 'Logged' : 'Missing'),
        tone: summaryPlannedRepTotal > 0 ? pctTone(repsPct) : (summaryRepCount > 0 ? 'good' : 'bad'),
      });
    };
    const addCalories = () => {
      if (summaryCaloriesBurned == null || summaryCaloriesBurned <= 0) return;
      rows.push({
        key: 'calories',
        icon: 'flame-outline',
        value: String(Math.round(summaryCaloriesBurned)),
        label: 'Kcal',
        hint: 'Estimated',
        tone: 'good',
      });
    };
    const addHeart = () => {
      if (summaryAvgHeartRate == null || summaryAvgHeartRate <= 0) {
        return;
      }
      const zones = summaryData?.hrZoneMinutes;
      const zoneTotal = zones?.reduce((sum, minutes) => sum + Math.max(0, Number(minutes) || 0), 0) ?? 0;
      const hardRatio = zoneTotal > 0 && zones ? ((zones[3] ?? 0) + (zones[4] ?? 0)) / zoneTotal : 0;
      const aerobicRatio = zoneTotal > 0 && zones ? ((zones[1] ?? 0) + (zones[2] ?? 0)) / zoneTotal : 0;
      let hint = 'Tracked';
      let tone: SummaryMetricTone = 'good';
      if (/\b(interval|hiit)\b/.test(summaryTypeLabel.toLowerCase()) && zoneTotal > 0) {
        hint = hardRatio >= 0.12 ? 'Hard' : hardRatio >= 0.05 ? 'Light' : 'Easy';
        tone = hardRatio >= 0.12 ? 'good' : hardRatio >= 0.05 ? 'warn' : 'bad';
      } else if (summaryIsCardioLike && zoneTotal > 0) {
        hint = aerobicRatio >= 0.35 ? 'Aerobic' : aerobicRatio >= 0.15 ? 'Light' : 'Easy';
        tone = aerobicRatio >= 0.35 ? 'good' : aerobicRatio >= 0.15 ? 'warn' : 'bad';
      }
      rows.push({
        key: 'hr',
        icon: 'heart-outline',
        value: String(Math.round(summaryAvgHeartRate)),
        label: 'HR',
        hint,
        tone,
      });
    };
    const addScore = () => {
      if (trainingScore == null) return;
      rows.push({
        key: 'score',
        icon: 'trophy-outline',
        value: String(Math.round(trainingScore)),
        label: 'Score',
        hint: summaryData?.trainingRating ?? 'Rated',
        tone: scoreTone(trainingScore),
      });
    };

    if (summaryIsActivityLike) {
      addTime();
      addDistance();
      addPower();
      addElevation();
      addHeart();
      addCalories();
      addScore();
      if (summarySetCount > 0 && rows.length < 4) addSets();
      if (summaryRepCount > 0 && rows.length < 4) addReps();
    } else {
      addSets();
      addReps();
      if (summaryAvgHeartRate != null && summaryAvgHeartRate > 0) addHeart();
      else addScore();
      if (rows.length < 4) addCalories();
      if (rows.length < 4) addTime();
    }
    if (rows.length === 0) addTime();
    return rows.slice(0, summaryIsActivityLike ? 6 : 4);
  }, [
    distanceUnit,
    summaryAvgHeartRate,
    summaryData?.hrZoneMinutes,
    summaryData?.trainingScore,
    summaryData?.trainingRating,
    summaryDistanceMiles,
    summaryDurationSeconds,
    summaryElevationGainFt,
    summaryEstimatedSeconds,
    summaryAvgWatts,
    summaryCaloriesBurned,
    summaryIsActivityLike,
    summaryPlannedRepTotal,
    summaryRepCount,
    summarySetCount,
    summaryTypeLabel,
    totalPlannedSets,
  ]);
  const summaryPlanLabel = totalPlannedSets > 0
    ? `${formatSummaryDuration(summaryDurationSeconds)} · ${Math.min(summarySetCount, totalPlannedSets)}/${totalPlannedSets} sets`
    : summaryDistanceMiles != null && summaryDistanceMiles > 0
      ? formatDistance(summaryDistanceMiles, distanceUnit, { precision: summaryDistanceMiles >= 10 ? 0 : 2 })
      : summarySetCount > 0
        ? `${summarySetCount} set${summarySetCount === 1 ? '' : 's'} logged`
        : summaryCaloriesBurned != null && summaryCaloriesBurned > 0
          ? `~${Math.round(summaryCaloriesBurned)} kcal`
        : 'Session logged';
  const workoutPostSummary = useMemo<WorkoutPostSummary | null>(() => {
    const sourceExercises = finishedSession?.exercises ?? exercises;
    const activity = finishedSession?.manualActivity;
    const hasActivitySummary = !!activity || summaryDistanceMiles != null || summaryAvgHeartRate != null || summaryCaloriesBurned != null;
    if (!sourceExercises.length && !hasActivitySummary) return null;
    return {
      focus: workoutDisplayFocus ?? 'Workout',
      duration_seconds: summaryDurationSeconds,
      date: dateKey(new Date()),
      activity_category: activity?.category ?? summaryVisualInput.activityCategory ?? null,
      activity_subtype: activity?.subtype ?? summaryVisualInput.activitySubtype ?? null,
      cardio_style: activity?.cardioStyle ?? null,
      distance_miles: summaryDistanceMiles,
      hr_summary: summaryAvgHeartRate != null
        ? { avgBpm: Math.round(summaryAvgHeartRate), maxBpm: summaryData?.hrMax ?? null }
        : null,
      exercises: sourceExercises.map(e => ({
        name: e.name,
        equipment: (e as any).equipment ?? null,
        sets: e.sets.map(s => ({
          reps: Number(s.reps) || 0,
          weight_lbs: Number(s.weightLbs) || 0,
          duration_seconds: s.durationSeconds ?? null,
          actual_distance: s.actualDistance ?? null,
          actual_pace: s.actualPace ?? null,
          heart_rate_avg: s.heartRateAvg ?? null,
          cardio_metrics: s.cardioMetrics ?? null,
        })),
      })),
      total_sets: summarySetCount,
      total_reps: summaryRepCount,
      training_score: (summaryData as any)?.trainingScore ?? null,
      training_rating: (summaryData as any)?.trainingRating ?? null,
    };
  }, [
    exercises,
    finishedSession,
    summaryAvgHeartRate,
    summaryCaloriesBurned,
    summaryData,
    summaryDistanceMiles,
    summaryDurationSeconds,
    summaryRepCount,
    summarySetCount,
    summaryVisualInput.activityCategory,
    summaryVisualInput.activitySubtype,
    workoutDisplayFocus,
  ]);
  const handleOpenFriendsShare = useCallback(() => {
    if (!authToken) {
      Alert.alert('Sign in', 'You need to be signed in to post to friends.');
      return;
    }
    if (!workoutPostSummary) {
      Alert.alert('Still saving', 'Your workout summary is still being prepared. Try again in a moment.');
      return;
    }

    if (shareWorkoutOpenTimerRef.current) {
      clearTimeout(shareWorkoutOpenTimerRef.current);
      shareWorkoutOpenTimerRef.current = null;
    }

    // iOS can refuse to present a second native Modal while the summary
    // Modal is still dismissing. Swap sheets instead of stacking them.
    setSummaryVisible(false);
    shareWorkoutOpenTimerRef.current = setTimeout(() => {
      shareWorkoutOpenTimerRef.current = null;
      setShowShareWorkoutModal(true);
    }, summaryVisible ? SHARE_WORKOUT_MODAL_OPEN_DELAY_MS : 0);
  }, [authToken, summaryVisible, workoutPostSummary]);

  const handleCloseFriendsShare = useCallback(() => {
    setShowShareWorkoutModal(false);
    if (finishedSession) setSummaryVisible(true);
  }, [finishedSession]);

  const handleAskWorkoutCoach = useCallback(async () => {
    const q = coachInput.trim();
    const photo = coachPendingPhoto;
    if (!q && !photo) return;
    // Pro-only: in-workout AI coach.
    const { requirePro } = await import('../utils/subscription');
    let profile: any = null;
    try {
      const raw = await AsyncStorage.getItem('userProfile');
      if (raw) profile = JSON.parse(raw);
    } catch {}
    if (!requirePro(profile, 'ai_coach')) return;

    // If user attaches a photo without typing, fall back to a sensible
    // default prompt so the question still passes the 4-char gate.
    const effectiveQ = q || 'Check my form in this photo.';

    const userMsg: WorkoutCoachMessage = {
      role: 'user',
      content: effectiveQ,
      ...(photo ? { imageBase64: photo.base64, imageMime: photo.mime } : {}),
    };
    // Snapshot conversation BEFORE the new turn so we send only prior
    // turns to the backend (the new turn is the question itself).
    const priorConversation = coachChat
      .map(m => ({ role: m.role, content: m.content }));
    setCoachChat(prev => [...prev, userMsg]);
    setCoachInput('');
    setCoachPendingPhoto(null);
    setCoachLoading(true);

    try {
      const active = exercises[activeExIdx];
      // Mirror the live exercises state into the workout context so the
      // coach sees swapped exercises, not the original plan snapshot.
      const liveWorkout = {
        ...workout,
        exercises: exercises.map(ex => ({
          name: ex.name,
          sets: ex.targetSets,
          reps: ex.targetReps,
          equipment: ex.equipment,
          muscles_targeted: ex.muscles_targeted,
        })),
      };
      const resp = await askWorkoutQuestion(authToken, {
        question: effectiveQ,
        workout: liveWorkout,
        activeExerciseName: active?.name,
        currentSetNumber: (active?.sets?.length ?? 0) + 1,
        loggedSets: active?.sets ?? [],
        image_base64: photo?.base64,
        mime_type: photo?.mime,
        conversation: priorConversation,
      });
      const cues = (resp.quick_cues ?? []).slice(0, 3).map((x: string) => `• ${x}`).join('\n');
      const content = [
        resp.answer,
        cues ? `\n${cues}` : '',
        resp.adjustment ? `\nAdjustment: ${resp.adjustment}` : '',
        resp.safety_note ? `\nSafety: ${resp.safety_note}` : '',
      ].join('');
      setCoachChat(prev => [...prev, { role: 'assistant', content }]);
    } catch (e: any) {
      setCoachChat(prev => [...prev, { role: 'assistant', content: `Could not answer right now. ${e?.message ?? ''}` }]);
    } finally {
      setCoachLoading(false);
    }
  }, [coachInput, coachPendingPhoto, coachChat, exercises, activeExIdx, authToken, workout]);

  // Stage a photo for attachment to the next coach question. Doesn't
  // call any AI yet — that happens when the user taps Send.
  const handleAttachCoachPhoto = useCallback(async (source: 'camera' | 'library') => {
    const permission = source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        'Permission needed',
        `Please allow ${source === 'camera' ? 'camera' : 'photo library'} access to attach a photo.`,
      );
      return;
    }
    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync({ quality: 0.7, base64: true, mediaTypes: ['images'] as any })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.7, base64: true, mediaTypes: ['images'] as any });
    if (result.canceled || !result.assets?.[0]?.base64) return;
    setCoachPendingPhoto({
      base64: result.assets[0].base64,
      mime: 'image/jpeg',
    });
  }, []);

  const handleAnalyzeFormPhoto = useCallback(async (source: 'camera' | 'library') => {
    if (!authToken) {
      Alert.alert('Sign in required', 'You need to be signed in to analyze form photos.');
      return;
    }
    // Pro-only: AI form analysis.
    const { requirePro } = await import('../utils/subscription');
    let profile: any = null;
    try {
      const raw = await AsyncStorage.getItem('userProfile');
      if (raw) profile = JSON.parse(raw);
    } catch {}
    if (!requirePro(profile, 'ai_form_analysis')) return;

    const permission = source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', `Please allow ${source === 'camera' ? 'camera' : 'photo library'} access for form analysis.`);
      return;
    }

    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync({ quality: 0.7, base64: true, mediaTypes: ['images'] as any })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.7, base64: true, mediaTypes: ['images'] as any });

    if (result.canceled || !result.assets?.[0]?.base64) return;

    const active = exercises[activeExIdx];
    const prompt = coachInput.trim();
    const lead = prompt || `Check my ${active?.name ?? 'current exercise'} form.`;
    setCoachChat(prev => [...prev, { role: 'user', content: `${lead} [form photo]` }]);
    setCoachInput('');
    setCoachPhotoLoading(true);

    try {
      const asset = result.assets[0];
      const imageBase64 = asset.base64;
      if (!imageBase64) return;
      const response = await analyzeWorkoutFormPhoto(authToken, {
        image_base64: imageBase64,
        mime_type: 'image/jpeg',   // expo transcodes HEIC→JPEG with base64:true
        exercise_name: active?.name,
        question: prompt || undefined,
      });
      const cues = (response.quick_cues ?? []).slice(0, 3).map((x: string) => `• ${x}`).join('\n');
      const redFlags = (response.red_flags ?? []).slice(0, 2).map((x: string) => `• ${x}`).join('\n');
      const content = [
        response.answer,
        response.likely_target ? `\nTarget: ${response.likely_target}` : '',
        cues ? `\n${cues}` : '',
        redFlags ? `\nRed flags:\n${redFlags}` : '',
        response.safety_note ? `\nSafety: ${response.safety_note}` : '',
      ].join('');
      setCoachChat(prev => [...prev, { role: 'assistant', content }]);
    } catch (e: any) {
      setCoachChat(prev => [...prev, { role: 'assistant', content: `Could not analyze the form photo right now. ${e?.message ?? ''}` }]);
    } finally {
      setCoachPhotoLoading(false);
    }
  }, [activeExIdx, authToken, coachInput, exercises]);

  const handleAnalyzeFormVideo = useCallback(async (source: 'camera' | 'library') => {
    if (!authToken) {
      Alert.alert('Sign in required', 'You need to be signed in to analyze form videos.');
      return;
    }

    const permission = source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', `Please allow ${source === 'camera' ? 'camera' : 'photo library'} access for video analysis.`);
      return;
    }

    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync({ quality: 0.7, mediaTypes: ['videos'] as any, videoMaxDuration: 20 })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.7, mediaTypes: ['videos'] as any });

    if (result.canceled || !result.assets?.[0]?.uri) return;

    const active = exercises[activeExIdx];
    const prompt = coachInput.trim();
    const lead = prompt || `Check my ${active?.name ?? 'current exercise'} form from this video.`;
    setCoachChat(prev => [...prev, { role: 'user', content: `${lead} [form video]` }]);
    setCoachInput('');
    setCoachPhotoLoading(true);

    try {
      const asset = result.assets[0];
      const thumbnail = await VideoThumbnails.getThumbnailAsync(asset.uri, { time: 1200 });
      const imageBase64 = await FileSystem.readAsStringAsync(thumbnail.uri, { encoding: 'base64' as any });
      const response = await analyzeWorkoutFormPhoto(authToken, {
        image_base64: imageBase64,
        mime_type: 'image/jpeg',
        exercise_name: active?.name,
        question: prompt ? `Video form check: ${prompt}` : 'Video form check',
      });

      const cues = (response.quick_cues ?? []).slice(0, 3).map((x: string) => `• ${x}`).join('\n');
      const redFlags = (response.red_flags ?? []).slice(0, 2).map((x: string) => `• ${x}`).join('\n');
      const content = [
        response.answer,
        response.likely_target ? `\nTarget: ${response.likely_target}` : '',
        cues ? `\n${cues}` : '',
        redFlags ? `\nRed flags:\n${redFlags}` : '',
        response.safety_note ? `\nSafety: ${response.safety_note}` : '',
        '\nNote: video analysis is currently based on a representative frame from your clip.',
      ].join('');
      setCoachChat(prev => [...prev, { role: 'assistant', content }]);
    } catch (e: any) {
      setCoachChat(prev => [...prev, { role: 'assistant', content: `Could not analyze the form video right now. ${e?.message ?? ''}` }]);
    } finally {
      setCoachPhotoLoading(false);
    }
  }, [activeExIdx, authToken, coachInput, exercises]);

  const swapTargetExerciseName = swapTargetIdx != null ? exercises[swapTargetIdx]?.name : null;
  const exerciseLibraryByName = useMemo(() => {
    const map = new Map<string, ExerciseLibraryItem>();
    for (const item of exerciseLibrary) {
      map.set(item.name.toLowerCase(), item);
    }
    return map;
  }, [exerciseLibrary]);
  const currentWorkoutAddContext = useMemo<ExerciseLibraryItem[]>(() => {
    return exercises.map(ex => {
      const libraryItem = exerciseLibraryByName.get(ex.name.toLowerCase());
      return {
        name: ex.name,
        equipment: ex.equipment ?? libraryItem?.equipment ?? null,
        gear: libraryItem?.gear ?? null,
        primary_muscle: ex.primaryMuscle ?? ex.primary_muscle ?? libraryItem?.primary_muscle ?? null,
        secondary_muscles: ex.secondaryMuscles ?? ex.secondary_muscles ?? libraryItem?.secondary_muscles ?? [],
        is_compound: ex.isCompound ?? libraryItem?.is_compound ?? null,
        movement_pattern: ex.movementPattern ?? ex.movement_pattern ?? libraryItem?.movement_pattern ?? null,
      };
    });
  }, [exerciseLibraryByName, exercises]);
  const filteredExerciseLibrary: SmartSwapItem[] = useMemo(() => {
    const q = deferredExerciseSearch.trim().toLowerCase();
    const blockedNames = exerciseNameKeySet(exercises.map(ex => ex.name));
    // Guided-flow constraints: in swap mode, only show same flow_category
    // poses; in add mode, only show flow-tagged poses (any category).
    const guidedSwapCategory = guidedFlowEnabled && swapTargetIdx != null
      ? (exercises[swapTargetIdx] as any)?.flowCategory ?? (exercises[swapTargetIdx] as any)?.flow_category ?? null
      : null;
    const guidedFlowFilter = (item: ExerciseLibraryItem): boolean => {
      if (!guidedFlowEnabled) return true;
      const fc = (item as any)?.flow_category ?? null;
      if (!fc) return false;
      if (guidedSwapCategory) return fc === guidedSwapCategory;
      return true;
    };
    if (swapTargetIdx != null) {
      const targetName = swapTargetExerciseName;
      const base = targetName ? exerciseLibrary.find(li => li.name === targetName) : undefined;
      if (!base) {
        return exerciseLibrary
          .filter(item => isExerciseUsableWithEquipment(item, ownedEquipment))
          .filter(item => !blockedNames.has(normalizeSwapText(item.name)))
          .filter(item => !candidateConflictsWithActiveInjuries(item, activeInjuryTokens))
          .filter(guidedFlowFilter)
          .filter(item => exerciseMatchesMuscleFilter(item, exerciseMuscleFilter))
          .filter(item => !q || matchesExerciseSearch(item, q))
          .map(item => {
            const historySignal = exerciseHistorySignals[exerciseHistoryKey(item.name)];
            return {
              ...item,
              _swapNotes: buildSwapNotes(item, null, historySignal, activeInjuryTokens),
            };
          })
          // Active search → return every match; empty → just the top 10
          // recommended. Same UX contract the add-exercise picker uses.
          .slice(0, q ? Number.MAX_SAFE_INTEGER : 10);
      }
      const scored: Array<{ item: ExerciseLibraryItem; score: number; historySignal?: ExerciseHistorySignal }> = [];
      for (const item of exerciseLibrary) {
        if (blockedNames.has(normalizeSwapText(item.name))) continue;
        if (!isExerciseUsableWithEquipment(item, ownedEquipment)) continue;
        if (candidateConflictsWithActiveInjuries(item, activeInjuryTokens)) continue;
        if (!guidedFlowFilter(item)) continue;
        if (!exerciseMatchesMuscleFilter(item, exerciseMuscleFilter)) continue;
        if (q && !matchesExerciseSearch(item, q)) continue;
        const s = scoreSwapCandidate(base, item);
        // Search-mode: keep 0-overlap matches so the user can pick any exercise.
        // No-search: only show ranked candidates with positive overlap.
        if (s <= 0 && !q) continue;
        const historySignal = exerciseHistorySignals[exerciseHistoryKey(item.name)];
        const historyBonus = Math.min(SMART_SWAP_HISTORY_BONUS_MAX, (historySignal?.count ?? 0) * 1.25);
        scored.push({ item, score: s + historyBonus, historySignal });
      }
      scored.sort((a, b) => {
        const scoreDelta = b.score - a.score;
        if (scoreDelta !== 0) return scoreDelta;
        const historyDelta = (b.historySignal?.count ?? 0) - (a.historySignal?.count ?? 0);
        if (historyDelta !== 0) return historyDelta;
        return a.item.name.localeCompare(b.item.name);
      });
      // Active search → show every ranked match; empty → just the top 10.
      return scored.slice(0, q ? scored.length : 10).map(s => ({
        ...s.item,
        _overlap: Math.min(100, Math.round((s.score / SMART_SWAP_MAX_SCORE) * 100)),
        _swapNotes: buildSwapNotes(s.item, base, s.historySignal, activeInjuryTokens),
      }));
    }
    // Empty search → top 10 recommended for this workout's focus.
    // Active search → match against the FULL library and don't cap;
    // when the user is hunting a specific exercise they want every
    // candidate, not just the ten the recommender liked best.
    const searchableLibrary = exerciseLibrary
      .filter(item => !blockedNames.has(normalizeSwapText(item.name)))
      .filter(item => !candidateConflictsWithActiveInjuries(item, activeInjuryTokens))
      .filter(guidedFlowFilter)
      .filter(item => exerciseMatchesMuscleFilter(item, exerciseMuscleFilter))
      .filter(item => !q || matchesExerciseSearch(item, q));
    const limit = q ? searchableLibrary.length : 10;
    return rankWorkoutAddCandidates(
      currentWorkoutAddContext,
      searchableLibrary,
      ownedEquipment,
      workout.focus,
      limit,
    );
  }, [activeInjuryTokens, currentWorkoutAddContext, deferredExerciseSearch, exerciseHistorySignals, exerciseLibrary, exerciseMuscleFilter, ownedEquipment, swapTargetExerciseName, swapTargetIdx, workout.focus, guidedFlowEnabled, exercises]);
  const renderExercisePickerItem = useCallback(({ item }: { item: SmartSwapItem }) => (
    <ActiveExercisePickerRow
      item={item}
      swapMode={swapTargetIdx != null}
      stylesRef={styles}
      onPress={handleAddExercise}
      onPreview={previewExerciseFromPicker}
    />
  ), [handleAddExercise, previewExerciseFromPicker, styles, swapTargetIdx]);
  const exercisePickerKeyExtractor = useCallback((item: ExerciseLibraryItem) => String(item.id ?? item.name), []);

  const confirmCancelWorkout = useCallback(() => {
    if (cancelingWorkoutRef.current) return;
    Alert.alert(
      'Cancel Workout',
      'Your progress will be lost.',
      [
        { text: 'Keep Going', style: 'cancel' },
        {
          text: 'Cancel',
          style: 'destructive',
          onPress: cancelWorkoutSession,
        },
      ],
    );
  }, [cancelWorkoutSession]);

  return (
    <View
      style={[styles.container, { backgroundColor: themeColors.background }]}
      testID="active-workout-screen"
      accessibilityLabel="active-workout-screen">

      {/* Header */}
      <View style={styles.header}>
        <LinearGradient
          colors={[themeColors.surfaceRaised, themeColors.surface]}
          style={styles.headerCard}>
          <View style={styles.headerControlRow}>
            {showHeaderWorkoutDuration && (
              <WorkoutDurationChip
                startMs={startTime.current}
                enabled={!showStartCountdown}
                paused={workoutPaused}
                pausedAtMs={workoutPausedAtMs}
                pausedAccumMs={workoutPausedAccumMs}
                styles={styles}
                workoutPalette={workoutPalette}
              />
            )}
            {liveHR != null && liveHR > 0 && currentLiveHRZone ? (
              <View style={[
                styles.headerWorkoutTimer,
                styles.headerHrChip,
                {
                  backgroundColor: hrZoneColorHex(currentLiveHRZone.zone, workoutPalette.strong) + '18',
                  borderColor: hrZoneColorHex(currentLiveHRZone.zone, workoutPalette.strong) + '66',
                },
              ]}>
                <Ionicons name="heart" size={12} color={hrZoneColorHex(currentLiveHRZone.zone, workoutPalette.strong)} />
                <Text style={[
                  styles.headerWorkoutTimerText,
                  styles.headerHrChipText,
                  { color: hrZoneColorHex(currentLiveHRZone.zone, workoutPalette.strong) },
                ]} numberOfLines={1}>
                  Z{currentLiveHRZone.zone} · {liveHR} bpm
                </Text>
              </View>
            ) : null}
            {(watchInboundSyncing || watchSyncing) ? (
              <View style={[
                styles.headerWatchSyncChip,
                {
                  backgroundColor: workoutPalette.soft,
                  borderColor: workoutPalette.strong + '55',
                },
              ]}>
                <ActivityIndicator size="small" color={workoutPalette.strong} />
                <Text style={[styles.headerWatchSyncText, { color: workoutPalette.text }]} numberOfLines={1}>
                  {watchInboundSyncing ? 'Syncing from Watch' : 'Syncing Watch'}
                </Text>
              </View>
            ) : null}
            {/* Removed the focus + sets-logged meta block that used to
                live between the HR zone chip and the Cancel button.
                With timer + HR chip + Cancel + Coach already filling
                the row, the title block was being squeezed below
                legibility. Focus name still shows on the active
                exercise card; per-set progress shows on each
                exercise. A flex spacer keeps Cancel/Coach pinned
                right. */}
            <View style={{ flex: 1 }} />
            <View style={styles.headerActionRow}>
              <TouchableOpacity style={styles.cancelBtn} onPress={confirmCancelWorkout} disabled={cancelingWorkout}>
                {cancelingWorkout ? (
                  <ActivityIndicator size="small" color={themeColors.textSecondary} />
                ) : (
                  <Text style={styles.cancelBtnText}>Cancel</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.coachBtn, { backgroundColor: workoutPalette.soft, borderColor: workoutPalette.strong }]}
                onPress={() => setCoachModalVisible(true)}>
                <Text style={[styles.coachBtnText, { color: workoutPalette.text }]}>Coach</Text>
              </TouchableOpacity>
            </View>
          </View>
          {restEndsAtMs != null && restEndsAtMs > Date.now() && (
            <RestTimerPanel
              endsAtMs={restEndsAtMs}
              totalSeconds={restTotalForPanel}
              restForExercise={restForExercise}
              restNextTarget={restNextTarget}
              restCue={restCue}
              restRecommendationLoading={
                aiLoadingIdx != null
                && restForExercise != null
                && exercises[aiLoadingIdx]?.name === restForExercise
              }
              watchStatus={watchStatus}
              themeColors={themeColors}
              workoutPalette={workoutPalette}
              styles={styles}
              onAdjust={adjustActiveRestRemaining}
              onSkip={() => {
                // Confirm before skipping — accidental taps during a
                // tap-heavy rest screen (RIR / reps sliders next to the
                // skip button) were silently cutting recovery short. Same
                // confirmation pattern is mirrored on the watch.
                const remaining = restRemainingRef.current ?? 0;
                const seconds = Math.max(0, Math.round(remaining));
                const subtitle = seconds > 0
                  ? `${seconds}s left. Skip and go to the next set?`
                  : 'Skip and go to the next set?';
                Alert.alert(
                  'Skip rest?',
                  subtitle,
                  [
                    { text: 'Keep resting', style: 'cancel' },
                    {
                      text: 'Skip',
                      style: 'destructive',
                      onPress: () => clearRestState(),
                    },
                  ],
                );
              }}
            />
          )}
        </LinearGradient>
      </View>

      {/* Live route map — only renders for outdoor cardio (run/walk/
          bike/hike) when we have at least one GPS coord. Hidden for
          indoor sessions and for lifting. */}
      {liveCardio && (currentCoord || routeCoords.length > 0) && (() => {
        // Same cardio-type guard as the metrics row below.
        const isOutdoorCardio = liveCardio.activityTypeRaw != null
          && OUTDOOR_CARDIO_ACTIVITY_RAWS.has(liveCardio.activityTypeRaw)
          && cardioAllowsOutdoorData;
        if (!isOutdoorCardio) return null;
        return (
          <LiveCardioMap
            themeName={themeName}
            coords={routeCoords}
            current={currentCoord}
            height={180}
          />
        );
      })()}

      {/* Live cardio metrics row — populated by `cardio_metrics`
          updates pushed from the watch every 5s while the
          CardioActiveTab is mounted. Only renders when the watch has
          told us the active session is cardio (HK activityTypeRaw is
          one of running/walking/cycling/etc) AND we've received at
          least one update in the last 30s. */}
      {liveCardio && (() => {
        const isCardio = liveCardio.activityTypeRaw != null && CARDIO_ACTIVITY_RAWS.has(liveCardio.activityTypeRaw);
        const fresh = Date.now() - liveCardio.receivedAtMs < 30_000;
        if (!isCardio || !fresh) return null;
        const showOutdoorData = cardioAllowsOutdoorData;
        const noDistanceCardio = liveCardio.activityTypeRaw === 51;
        // Render in the user's preferred unit (mi default; km if set
        // on their UserProfile). Watch ships meters as canonical so we
        // convert here at the display boundary. Path: meters → km →
        // miles (canonical) → user unit via miToUnit.
        const km = liveCardio.distanceMeters / 1000;
        const mi = km * MI_PER_KM_LOCAL;
        const displayValue = miToUnit(mi, distanceUnit);
        const unitSuffix = distanceUnit === 'km' ? 'km' : 'mi';
        const distanceLabel = liveCardio.distanceMeters <= 0
          ? '—'
          : displayValue < 100
            ? `${displayValue.toFixed(2)} ${unitSuffix}`
            : `${displayValue.toFixed(0)} ${unitSuffix}`;
        // Pace ships as sec/km. To convert sec/km → sec/mi: a mile is
        // 1/MI_PER_KM_LOCAL ≈ 1.609 km, so each mile takes that many
        // times the per-km pace (i.e. divide by MI_PER_KM_LOCAL).
        const paceSecForUnit = liveCardio.paceSecPerKm
          ? distanceUnit === 'km'
            ? liveCardio.paceSecPerKm
            : liveCardio.paceSecPerKm / MI_PER_KM_LOCAL
          : null;
        const paceLabel = paceSecForUnit
          ? `${Math.floor(paceSecForUnit / 60)}:${String(Math.floor(paceSecForUnit % 60)).padStart(2, '0')}`
          : '—';
        const calLabel = liveCardio.activeCalories > 0
          ? `${Math.round(liveCardio.activeCalories)}`
          : '—';
        const hrLabel = liveCardio.heartRate && liveCardio.heartRate > 0
          ? `${Math.round(liveCardio.heartRate)}`
          : '—';
        const isCycling = liveCardio.activityTypeRaw === 13;
        const speedValue = liveCardio.elapsedSeconds > 0 && displayValue > 0
          ? displayValue / (liveCardio.elapsedSeconds / 3600)
          : null;
        const speedLabel = speedValue && Number.isFinite(speedValue) && speedValue > 0
          ? speedValue.toFixed(1)
          : '—';
        const elevationLabel = showOutdoorData && liveCardio.elevationGainFt != null && liveCardio.elevationGainFt > 0
          ? `${Math.round(liveCardio.elevationGainFt)} ft`
          : null;
        const powerLabel = showOutdoorData && liveCardio.estimatedPowerWatts != null && liveCardio.estimatedPowerWatts > 0
          ? `${Math.round(liveCardio.estimatedPowerWatts)} W`
          : null;
        const gpsAccuracyLabel = showOutdoorData && liveCardio.lastAccuracyM != null && liveCardio.lastAccuracyM > 35
          ? `${Math.round(liveCardio.lastAccuracyM)} m`
          : null;
        const elapsedLabel = (() => {
          const s = liveCardio.elapsedSeconds;
          const h = Math.floor(s / 3600);
          const m = Math.floor((s % 3600) / 60);
          const sec = s % 60;
          if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
          return `${m}:${String(sec).padStart(2, '0')}`;
        })();
        const timeTile = hideLiveCardioTimeTile
          ? []
          : [{ label: 'TIME', value: elapsedLabel, color: liveCardio.paused || workoutPaused ? themeColors.warning ?? '#F59E0B' : workoutPalette.strong }];
        const tiles = noDistanceCardio ? [
          ...timeTile,
          { label: 'HR', value: hrLabel, color: themeColors.textPrimary },
          { label: 'KCAL', value: calLabel, color: themeColors.warning ?? '#F59E0B' },
        ] : [
          ...timeTile,
          { label: `DIST (${unitSuffix})`, value: distanceLabel, color: themeColors.textPrimary },
          isCycling
            ? { label: `SPEED ${unitSuffix}/h`, value: speedLabel, color: themeColors.textPrimary }
            : { label: `PACE /${unitSuffix}`, value: paceLabel, color: themeColors.textPrimary },
          ...(elevationLabel ? [{ label: 'ELEV', value: elevationLabel, color: themeColors.textPrimary }] : []),
          ...(powerLabel ? [{ label: 'POWER', value: powerLabel, color: workoutPalette.strong }] : []),
          ...(liveCardio.heartRate && liveCardio.heartRate > 0 ? [{ label: 'HR', value: hrLabel, color: themeColors.textPrimary }] : []),
          { label: 'KCAL', value: calLabel, color: themeColors.warning ?? '#F59E0B' },
          ...(gpsAccuracyLabel ? [{ label: 'GPS', value: gpsAccuracyLabel, color: themeColors.warning ?? '#F59E0B' }] : []),
        ];
        return (
          <View style={styles.liveCardioMetricsGrid}>
            {tiles.slice(0, 6).map(tile => (
              <View key={tile.label} style={[styles.liveCardioMetricTile, {
                backgroundColor: themeColors.surface,
                borderColor: themeColors.surfaceRaised,
              }]}>
                <Text style={[styles.liveCardioMetricLabel, { color: themeColors.textMuted }]}>
                  {tile.label}
                </Text>
                <Text style={[styles.liveCardioMetricValue, { color: tile.color }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
                  {tile.value}
                </Text>
              </View>
            ))}
          </View>
        );
      })()}

      {/* Warm-up card.
          - Before the workout starts: full expanded card with the
            "Start Workout" button (the user must read + acknowledge
            before the exercise list unlocks).
          - After the workout starts: collapsed header at the top of
            the screen that expands back to the full step list on tap.
            Keeps the warm-up accessible mid-session so the user can
            re-read the steps without leaving the workout. */}
      {!warmupDone && (
        <View style={[styles.warmupCard, { backgroundColor: workoutPalette.soft, borderColor: workoutPalette.strong }]}>
          <Text style={[styles.warmupTitle, { color: workoutPalette.text }]}>Warm-Up For Today</Text>
          {warmupLoading ? (
            <View style={styles.inlineLoadingRow}>
              <ActivityIndicator size="small" color={workoutPalette.strong} />
              <Text style={[styles.inlineLoadingText, { color: workoutPalette.text }]}>Preparing warm-up...</Text>
            </View>
          ) : (
            warmupSteps.map((step, index) => (
              <Text key={index} style={styles.warmupStep}>{index + 1}. {step}</Text>
            ))
          )}
          <View style={styles.warmupActions}>
            <TouchableOpacity style={[styles.warmupDoneBtn, { backgroundColor: workoutPalette.strong, flex: 1 }]} onPress={() => { configureLiveLayoutAnimation(); setWarmupDone(true); setWarmupExpanded(false); }}>
              <Text style={styles.warmupDoneBtnText}>Start Workout</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.warmupCoachBtn, { borderColor: workoutPalette.strong }]} onPress={() => { setCoachInput('Can you modify my warm-up based on today\'s workout focus?'); setCoachModalVisible(true); }}>
              <Text style={[styles.warmupCoachBtnText, { color: workoutPalette.text }]}>Ask Coach</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {false && warmupDone && (
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => { configureLiveLayoutAnimation(); setWarmupExpanded(v => !v); }}
          style={[
            styles.warmupCollapsed,
            { backgroundColor: workoutPalette.soft, borderColor: workoutPalette.strong },
          ]}>
          <View style={styles.warmupCollapsedHeader}>
            <Text style={[styles.warmupCollapsedTitle, { color: workoutPalette.text }]}>
              Warm-Up <Ionicons name={warmupExpanded ? 'chevron-down' : 'chevron-forward'} size={12} />
            </Text>
            <Text style={[styles.warmupCollapsedHint, { color: workoutPalette.text }]}>
              {warmupLoading ? 'Preparing...' : warmupExpanded ? 'Tap to hide' : `${warmupSteps.length} steps · tap to view`}
            </Text>
          </View>
          {warmupExpanded && (
            <View style={{ marginTop: 8 }}>
              {warmupLoading ? (
                <View style={styles.inlineLoadingRow}>
                  <ActivityIndicator size="small" color={workoutPalette.strong} />
                  <Text style={[styles.inlineLoadingText, { color: workoutPalette.text }]}>Preparing warm-up...</Text>
                </View>
              ) : (
                warmupSteps.map((step, index) => (
                  <Text key={index} style={styles.warmupStep}>{index + 1}. {step}</Text>
                ))
              )}
            </View>
          )}
        </TouchableOpacity>
      )}

      {/* Post-rest idle nudge — shown when rest finished >45s ago without
          a new set logged. HR hint layers on top when HealthKit data is live. */}
      {postRestIdleSecs >= 45 && restRemaining === 0 && restEndedAtRef.current > 0 && (
        <View style={{
          marginHorizontal: 16, marginBottom: 8, borderRadius: 10,
          backgroundColor: workoutPalette.soft, borderWidth: 1, borderColor: workoutPalette.strong + '88',
          paddingHorizontal: 14, paddingVertical: 10,
          flexDirection: 'row', alignItems: 'center', gap: 10,
        }}>
          <Ionicons name="timer-outline" size={18} color={workoutPalette.strong} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: workoutPalette.text }}>
              Ready when you are
            </Text>
            <Text style={{ fontSize: 11, color: workoutPalette.text, opacity: 0.75, marginTop: 1 }}>
              {Math.floor(postRestIdleSecs / 60) > 0
                ? `${Math.floor(postRestIdleSecs / 60)}m ${postRestIdleSecs % 60}s since rest ended`
                : `${postRestIdleSecs}s since rest ended`}
              {liveHR !== null && liveHR < 90
                ? ' · HR looks low — push hard this set'
                : liveHR !== null && liveHR > 130
                  ? ' · HR still elevated — take another 20s'
                  : ''}
            </Text>
          </View>
        </View>
      )}

      {/* Guided flow takeover for yoga / stretch / foam-roll sessions.
          Triggers when every exercise is a flow-tagged timed pose. The
          standard ScrollView and exercise list are bypassed. */}
      {guidedFlowEnabled ? (
        <GuidedFlowView
          exercises={exercises as any}
          themeColors={themeColors}
          onPoseComplete={(idx, durationSeconds) => {
            const slot = exercisesRef.current[idx]?.sets.length ?? 0;
            handleLogSetInline(idx, slot, true, `${durationSeconds}s`);
          }}
          onRequestSwap={(idx) => {
            setSwapTargetIdx(idx);
            openAddExerciseModal();
          }}
          onRequestAdd={() => {
            setSwapTargetIdx(null);
            openAddExerciseModal();
          }}
          onEndSession={() => {
            import('../utils/feedback').then(f => f.hapticMedium()).catch(() => {});
            openFinishConfirmation();
          }}
          hapticTick={() => preloadedFeedbackRef.current?.hapticMedium?.()}
          hapticTransition={() => preloadedFeedbackRef.current?.hapticMedium?.()}
          hapticComplete={() => preloadedFeedbackRef.current?.hapticSuccess?.()}
        />
      ) : null}

      {/* Exercise list (hidden in guided flow mode) */}
      {!guidedFlowEnabled && (
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" onScrollBeginDrag={Keyboard.dismiss}>
        {/* Warm-up collapsed header — scrolls with exercises */}
        {warmupDone && warmupSteps.length > 0 && (
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => { configureLiveLayoutAnimation(); setWarmupExpanded(v => !v); }}
            style={[styles.warmupCollapsed, { backgroundColor: workoutPalette.soft, borderColor: workoutPalette.strong }]}>
            <View style={styles.warmupCollapsedHeader}>
              <Text style={[styles.warmupCollapsedTitle, { color: workoutPalette.text }]}>
                Warm-Up <Ionicons name={warmupExpanded ? 'chevron-down' : 'chevron-forward'} size={12} />
              </Text>
              <Text style={[styles.warmupCollapsedHint, { color: workoutPalette.text }]}>
                {warmupLoading ? 'Preparing...' : warmupExpanded ? 'Tap to hide' : `${warmupSteps.length} steps`}
              </Text>
            </View>
            {warmupExpanded && (
              <View style={{ marginTop: 8 }}>
                {warmupLoading ? (
                  <View style={styles.inlineLoadingRow}>
                    <ActivityIndicator size="small" color={workoutPalette.strong} />
                    <Text style={[styles.inlineLoadingText, { color: workoutPalette.text }]}>Preparing warm-up...</Text>
                  </View>
                ) : (
                  warmupSteps.map((step, index) => (
                    <Text key={index} style={styles.warmupStep}>{index + 1}. {step}</Text>
                  ))
                )}
              </View>
            )}
          </TouchableOpacity>
        )}
        {warmupDone && exercises.map((ex, i) => {
          const targetSetCount  = getExerciseTargetSetCount(ex);
          // Effective set count: base target + user-added extras, minus
          // any unlogged sets they've explicitly removed. Clamped so we
          // never go below the number of already-logged sets.
          const rawTotal        = targetSetCount + (extraSetCounts[i] ?? 0) - (removedSetCounts[i] ?? 0);
          const totalSetCount   = Math.max(ex.sets.length, rawTotal);
          const hasSetRows      = totalSetCount > 0;
          const timed           = isTimedExercise(ex.name, ex.targetReps);
          const guide           = isGuideExercise(ex, workout);
          const isDone          = ex.sets.length >= totalSetCount;
          const isActive        = activeExIdx === i;
          const isAiLoading     = aiLoadingIdx === i;
          const isAiError       = aiErrorIdx === i;
          const hasLastTime     = !!(lastExerciseSets[ex.name]?.length);
          const bestLastSet     = hasLastTime
            ? lastExerciseSets[ex.name].reduce<CompletedSet | null>((best, current) => {
                if (!best) return current;
                const bestScore = best.weightLbs * best.reps;
                const currentScore = current.weightLbs * current.reps;
                return currentScore > bestScore ? current : best;
              }, null)
            : null;
          const restLabel       = guide ? 'guided' : `${Math.max(15, ex.targetRestSeconds || 60)}s rest`;
          const circuitRun = coreCircuitRunAt(exercises, i);
          const isCircuitItem = circuitRun.length >= 2;
          const circuitPosition = isCircuitItem ? circuitRun.indexOf(i) : -1;
          const isFirstCircuitItem = circuitPosition === 0;
          const circuitRounds = isCircuitItem
            ? Math.max(...circuitRun.map(idx => getExerciseTargetSetCount(exercises[idx])))
            : targetSetCount;
          const circuitRestSeconds = isCircuitItem
            ? Math.max(...circuitRun.map(idx => Number(exercises[idx]?.targetRestSeconds) || 0))
            : 0;
          // Stretch block grouping — same visual treatment as core circuit
          // but only kicks in when this exercise is part of a consecutive
          // stretch run AND not already classified as a core circuit. The
          // core check wins so a workout can have both a Core Circuit
          // banner and a Stretch Block banner without overlap.
          const stretchRun = !isCircuitItem ? stretchBlockRunAt(exercises, i) : [];
          const isStretchItem = stretchRun.length >= 2;
          const stretchPosition = isStretchItem ? stretchRun.indexOf(i) : -1;
          const isFirstStretchItem = stretchPosition === 0;
          const isGroupedItem = isCircuitItem || isStretchItem;
          const libraryItem = exerciseLibraryByName.get(ex.name.toLowerCase());
          const gear = libraryItem?.gear?.[0] ?? null;
          const fallbackEquipment = formatEquipmentLabel(ex.equipment);
          const exerciseEquipmentVisual = gear ?? (fallbackEquipment ? { name: fallbackEquipment } : null);
          // Swipe-to-reveal actions on the active card. iOS-Mail order:
          // destructive ends up far left of the revealed row (deepest
          // swipe), the safest action sits closest to the card edge so
          // a quick partial swipe surfaces it first. The toolbar
          // buttons stay in place — swipe is a faster alternative, not
          // a replacement, so users who already learned the toolbar
          // aren't broken.
          const swipeActions: SwipeAction[] = [];
          if (exercises.length > 1) {
            swipeActions.push({
              icon: 'remove-circle-outline',
              color: '#FFFFFF',
              bgColor: themeColors.error ?? '#EF4444',
              label: 'Remove',
              onPress: () => handleRemoveExercise(i),
            });
          }
          if (i < exercises.length - 1) {
            swipeActions.push({
              icon: 'arrow-down',
              color: '#FFFFFF',
              bgColor: themeColors.textMuted,
              label: 'Down',
              onPress: () => handleReorderExercise(i, 'down'),
            });
          }
          if (i > 0) {
            swipeActions.push({
              icon: 'arrow-up',
              color: '#FFFFFF',
              bgColor: themeColors.textMuted,
              label: 'Up',
              onPress: () => handleReorderExercise(i, 'up'),
            });
          }
          if (onDislikeExercise && !isDone) {
            swipeActions.push({
              icon: 'thumbs-down-outline',
              color: '#FFFFFF',
              bgColor: themeColors.warning ?? '#F59E0B',
              label: 'Hide',
              onPress: () => {
                Alert.alert(
                  'Don\'t like this exercise?',
                  `"${ex.name}" will be excluded from future workout plans. You can undo this in Settings.`,
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Exclude', style: 'destructive', onPress: () => {
                      onDislikeExercise(ex.name);
                      handleRemoveExercise(i);
                    }},
                  ],
                );
              },
            });
          }
          return (
            <Fragment key={i}>
              {isFirstCircuitItem && (
                <View style={[styles.liveCircuitBanner, { borderColor: workoutPalette.strong + '55', backgroundColor: workoutPalette.soft }]}>
                  <View style={styles.liveCircuitTitleRow}>
                    <Ionicons name="repeat" size={14} color={workoutPalette.strong} />
                    <Text style={[styles.liveCircuitTitle, { color: workoutPalette.strong }]}>Core Circuit</Text>
                  </View>
                  <Text style={[styles.liveCircuitMeta, { color: themeColors.textMuted }]}>
                    {circuitRun.length} moves · {circuitRounds} rounds · {circuitRestSeconds > 0 ? `${circuitRestSeconds}s between moves` : 'move exercise to exercise'}
                  </Text>
                </View>
              )}
              {isFirstStretchItem && (
                <View style={[styles.liveCircuitBanner, { borderColor: workoutPalette.strong + '55', backgroundColor: workoutPalette.soft }]}>
                  <View style={styles.liveCircuitTitleRow}>
                    <Ionicons name="flower-outline" size={14} color={workoutPalette.strong} />
                    <Text style={[styles.liveCircuitTitle, { color: workoutPalette.strong }]}>Stretch Block</Text>
                  </View>
                  <Text style={[styles.liveCircuitMeta, { color: themeColors.textMuted }]}>
                    {stretchRun.length} poses · cooldown
                  </Text>
                </View>
              )}
              <SwipeableRow
                actions={swipeActions}
                enabled={swipeActions.length > 0}
              >
              <View
                testID={`exercise-card-${i}`}
                style={[
                  styles.exerciseCard,
                  isGroupedItem && styles.liveCircuitExerciseCard,
                  isGroupedItem && { borderLeftColor: workoutPalette.strong },
                  isDone && styles.exerciseCardDone,
                  isActive && styles.exerciseCardActive,
                  isActive && {
                    borderColor: workoutPalette.strong,
                    shadowColor: workoutPalette.strong,
                  },
                ]}>
              {/* ── Header row: tap to expand/collapse ──
                   Layout flips on isActive — when expanded the thumbnail
                   moves to its own centered block below this row so the
                   name/reps/badge get the full width up top. */}
              <TouchableOpacity
                style={styles.exerciseHeader}
                onPress={() => { configureLiveLayoutAnimation(); setActiveExIdx(isActive ? -1 : i); import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {}); }}
                activeOpacity={0.7}>
                {!isActive && (() => {
                  const demoId = resolveDemoIdForExercise(ex);
                  const fallbackThumb = exerciseThumbSmall({ ...(ex as any), demo_exercise_db_id: demoId });
                  if (!demoId && !fallbackThumb) return null;
                  return (
                    <View style={{ marginRight: 10 }}>
                      <LiveExerciseDemoThumb
                        demoExerciseDbId={demoId}
                        exerciseName={ex.name}
                        fallbackThumbSrc={fallbackThumb}
                        isExpanded={false}
                        accentColor={themeColors.primary}
                        surfaceColor={themeColors.surfaceRaised}
                        onPress={() => {
                          import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
                          openFormVideoForExercise({ ...ex, demo_exercise_db_id: demoId } as any);
                        }}
                      />
                    </View>
                  );
                })()}
                <View style={{ flex: 1, minWidth: 0 }}>
                  {isCircuitItem && (
                    <Text style={[styles.liveCircuitStationText, { color: workoutPalette.strong }]}>
                      Station A{circuitPosition + 1}
                    </Text>
                  )}
                  {isStretchItem && (
                    <Text style={[styles.liveCircuitStationText, { color: workoutPalette.strong }]}>
                      Pose {stretchPosition + 1} of {stretchRun.length}
                    </Text>
                  )}
                  <Text
                    testID={`active-exercise-name-${i}`}
                    accessibilityLabel={`active-exercise-name-${i}`}
                    style={[styles.exerciseName, isDone && styles.exerciseNameDone]}
                    numberOfLines={isActive ? 3 : 1}
                    ellipsizeMode="tail"
                  >
                    {ex.name}
                  </Text>
                  <Text
                    style={styles.exerciseMeta}
                    numberOfLines={isActive ? 2 : 1}
                    ellipsizeMode="tail"
                  >
                    {isCircuitItem ? `${targetSetCount} rounds · ${ex.targetReps}` : `${targetSetCount} × ${ex.targetReps}`}  ·  {restLabel}
                    {formatEquipmentLabel(ex.equipment) ? `  ·  ${formatEquipmentLabel(ex.equipment)}` : ''}
                  </Text>
                  {timed && !guide && hrZones.length > 0 && (() => {
                    const n = (ex.name || '').toLowerCase();
                    const isInterval = /interval|hiit|sprint|tabata/.test(n);
                    const isEasy = /walk|jogging|easy|recovery/.test(n) && !/zone.?2/.test(n);
                    const cardioGuidance = (ex as any).cardioGuidance ?? (ex as any).cardio_guidance;
                    const prescribedZoneNumber = Number(cardioGuidance?.hr_zone ?? cardioGuidance?.hrZone);
                    const zone = Number.isFinite(prescribedZoneNumber) && prescribedZoneNumber > 0
                      ? hrZones.find(z => z.zone === prescribedZoneNumber)
                      : isEasy ? hrZones[0] : isInterval ? hrZones[3] : hrZones[1];
                    if (!zone) return null;
                    const zoneColor = hrZoneColorHex(zone.zone, themeColors.primary);
                    return (
                      <View style={styles.targetZoneRow}>
                        <View style={[styles.targetZoneBadge, { backgroundColor: zoneColor + '18', borderColor: zoneColor + '66' }]}>
                          <Text style={[styles.targetZoneBadgeText, { color: zoneColor }]}>Z{zone.zone}</Text>
                        </View>
                        <Text style={[styles.targetZoneText, { color: zoneColor }]} numberOfLines={1}>
                          {zone.label} · {zone.low}-{zone.high} bpm
                        </Text>
                      </View>
                    );
                  })()}
                  {bestLastSet && bestLastSet.weightLbs > 0 && !isDone && (
                    <Text style={{ fontSize: 13, color: themeColors.primary, fontWeight: '700', marginTop: 1 }}>
                      Last: {displayExerciseWeight(bestLastSet.weightLbs, ex)} × {bestLastSet.reps}
                    </Text>
                  )}
                </View>
                {/* Sets progress badge. Switches to an animated check stamp
                    when the last set lands — replaces the "N/N" text so it
                    doesn't collide with the surrounding row controls. */}
                {isDone ? (
                  <Animated.View
                    style={{
                      transform: [{ scale: getExerciseCompleteScale(i) }],
                      width: 30, height: 30, borderRadius: 15,
                      backgroundColor: themeColors.success,
                      alignItems: 'center', justifyContent: 'center',
                      shadowColor: themeColors.success,
                      shadowOpacity: 0.5,
                      shadowRadius: 6,
                      shadowOffset: { width: 0, height: 0 },
                    }}
                  >
                    <Ionicons name="checkmark" size={18} color={themeColors.background} />
                  </Animated.View>
                ) : (
                  <View style={styles.setsBadge}>
                    <Text style={styles.setsBadgeText}>
                      {`${ex.sets.length}/${totalSetCount}`}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>

              {/* Centered form demo — expanded mode only. The header
                   above carries name/reps/badge across the top; this
                   block is the visual anchor. Tapping opens the video
                   modal (which has the cycling demo + curated YouTube
                   videos); the thumbnail itself also cycles. */}
              {isActive && (() => {
                const demoId = resolveDemoIdForExercise(ex);
                const fallbackThumb = exerciseThumbSmall({ ...(ex as any), demo_exercise_db_id: demoId });
                const hasMoveKitDemo = !!moveKitDemoVideo(demoId, ex.name);
                if (!demoId && !fallbackThumb && !hasMoveKitDemo) return null;
                return (
                  <View style={{ alignItems: 'center', marginTop: 12, marginBottom: 4 }}>
                    <LiveExerciseDemoThumb
                      demoExerciseDbId={demoId}
                      exerciseName={ex.name}
                      fallbackThumbSrc={fallbackThumb}
                      isExpanded={true}
                      accentColor={themeColors.primary}
                      surfaceColor={themeColors.surfaceRaised}
                      onPress={() => {
                        import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
                        openFormVideoForExercise({ ...ex, demo_exercise_db_id: demoId } as any);
                      }}
                    />
                  </View>
                );
              })()}

              {isActive && exerciseEquipmentVisual ? (
                <TouchableOpacity
                  onPress={() => {
                    import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
                    setEnlargedEquipment({
                      name: exerciseEquipmentVisual.name ?? 'Equipment',
                      equipment: exerciseEquipmentVisual,
                    });
                  }}
                  activeOpacity={0.7}
                  style={{
                    alignSelf: 'flex-start',
                    flexDirection: 'row', alignItems: 'center', gap: 6,
                    paddingVertical: 6, paddingHorizontal: 10,
                    borderRadius: 999,
                    borderWidth: 1, borderColor: themeColors.border,
                    backgroundColor: themeColors.surfaceRaised,
                    marginTop: 8,
                  }}>
                  <Ionicons name="image-outline" size={13} color={themeColors.textSecondary} />
                  <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.textSecondary }}>
                    Equipment photo
                  </Text>
                </TouchableOpacity>
              ) : null}

              {isActive && (
                <View style={styles.exerciseToolbar}>
                  {!isDone && (
                    <TouchableOpacity
                      style={styles.exerciseToolbarBtn}
                      testID={`swap-exercise-${i}`}
                      onPress={() => {
                        setSwapTargetIdx(i);
                        setExerciseSearch('');
                        setAiExerciseResults([]);
                        openAddExerciseModal();
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`Swap ${ex.name} for a similar exercise`}>
                      <Ionicons name="swap-horizontal" size={14} color={themeColors.textSecondary} />
                      <Text style={styles.exerciseToolbarText}>Swap</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    style={styles.exerciseToolbarBtn}
                    onPress={() => {
                      const resolvedDemoId = resolveDemoIdForExercise(ex);
                      openFormVideoForExercise({ ...ex, demo_exercise_db_id: resolvedDemoId } as any);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Watch form videos for ${ex.name}`}>
                    <Ionicons name="logo-youtube" size={14} color="#FF0000" />
                    <Text style={styles.exerciseToolbarText}>Form Videos</Text>
                  </TouchableOpacity>
                  {(() => {
                    const tMode = detectTimerMode(ex.targetReps, (ex as any).set_type);
                    if (!tMode || isDone) return null;
                    return (
                      <TouchableOpacity
                        style={styles.exerciseToolbarBtn}
                        onPress={() => {
                          setTimerMode(tMode);
                          setTimerExerciseIdx(i);
                          setTimerModalVisible(true);
                          import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={`Start ${tMode.toUpperCase()} timer`}>
                        <Ionicons name="timer-outline" size={14} color={themeColors.primary} />
                        <Text style={[styles.exerciseToolbarText, { color: themeColors.primary }]}>Timer</Text>
                      </TouchableOpacity>
                    );
                  })()}
                  {onDislikeExercise && !isDone && (
                    <TouchableOpacity
                      style={styles.exerciseToolbarBtn}
                      onPress={() => {
                        Alert.alert(
                          'Don\'t like this exercise?',
                          `"${ex.name}" will be excluded from future workout plans. You can undo this in Settings.`,
                          [
                            { text: 'Cancel', style: 'cancel' },
                            { text: 'Exclude', style: 'destructive', onPress: () => {
                              onDislikeExercise(ex.name);
                              handleRemoveExercise(i);
                            }},
                          ],
                        );
                      }}>
                      <Ionicons name="thumbs-down-outline" size={14} color={themeColors.textSecondary} />
                      <Text style={styles.exerciseToolbarText}>Hide</Text>
                    </TouchableOpacity>
                  )}
                  {i > 0 && (
                    <TouchableOpacity style={styles.exerciseToolbarBtn} onPress={() => handleReorderExercise(i, 'up')} accessibilityRole="button" accessibilityLabel="Move exercise up">
                      <Ionicons name="arrow-up" size={14} color={themeColors.textSecondary} />
                      <Text style={styles.exerciseToolbarText}>Up</Text>
                    </TouchableOpacity>
                  )}
                  {i < exercises.length - 1 && (
                    <TouchableOpacity style={styles.exerciseToolbarBtn} onPress={() => handleReorderExercise(i, 'down')} accessibilityRole="button" accessibilityLabel="Move exercise down">
                      <Ionicons name="arrow-down" size={14} color={themeColors.textSecondary} />
                      <Text style={styles.exerciseToolbarText}>Down</Text>
                    </TouchableOpacity>
                  )}
                  {exercises.length > 1 && (
                    <TouchableOpacity
                      style={[styles.exerciseToolbarBtn, styles.exerciseToolbarDanger]}
                      onPress={() => handleRemoveExercise(i)}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${ex.name}`}>
                      <Ionicons name="remove-circle-outline" size={14} color={themeColors.error} />
                      <Text style={[styles.exerciseToolbarText, { color: themeColors.error }]}>Remove</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}

              {isActive && (
                <View style={styles.exerciseDetail}>

                  {/* ── Estimated 1RM — rolling estimate from logged history ── */}
                  {(() => {
                    const est = e1rmByName[ex.name.trim().toLowerCase()];
                    if (!est) return null;
                    return (
                      <View style={[styles.e1rmChip, { backgroundColor: workoutPalette.strong + '14', borderColor: workoutPalette.strong + '33' }]}>
                        <Ionicons name="trending-up" size={13} color={workoutPalette.strong} />
                        <Text style={[styles.e1rmChipText, { color: themeColors.textSecondary }]}>
                          Est. 1RM{' '}
                          <Text style={{ fontWeight: '800', color: themeColors.textPrimary }}>
                            {displayExerciseWeight(est.e1rm_lbs, ex)}
                          </Text>
                          {est.confidence === 'low' ? ' · rough estimate' : ''}
                        </Text>
                      </View>
                    );
                  })()}

                  {!timed && !guide && (() => {
                    const warmupSets = visibleWarmupSets(ex);
                    // Ramp-up guidance now lives behind the (i) on the
                    // Warm-up Sets header instead of an always-on card —
                    // the warmup-set rows below carry the real work.
                    const warmupNote = getExerciseWarmupNote(ex.name, i === 0, {
                      isCompound: ex.isCompound ?? undefined,
                    });
                    const suggestedAnchor = preSetHints[i]?.recommendedWeight
                      ?? ex.targetWeightLbs
                      ?? lastExerciseSets[ex.name]?.[0]?.weightLbs
                      ?? null;
                    const dismissedWarmupKeys = dismissedWarmupSuggestionKeys[i] ?? [];
                    const dismissedWarmupKeySet = dismissedWarmupKeys.length > 0
                      ? new Set(dismissedWarmupKeys)
                      : null;
                    // Auto-populated ramp-up sets only make sense for heavy
                    // compound lifts — isolation/accessory work doesn't need
                    // them. Manual "Add" stays available on every exercise.
                    const isCompoundLift = ex.isCompound ?? COMPOUND_LIFT_NAME_RE.test(ex.name.toLowerCase());
                    const suggestions = generatedWarmupSetsEnabled && isCompoundLift
                      ? buildWarmupSetSuggestions(ex, suggestedAnchor)
                        .slice(warmupSets.length)
                        .filter(set => !dismissedWarmupKeySet?.has(warmupSuggestionKey(set)))
                      : [];
                    const hasRows = warmupSets.length > 0 || suggestions.length > 0;
                    const exMeta = {
                      name: ex.name,
                      equipment: ex.equipment,
                      reps: ex.targetReps,
                      primaryMuscle: ex.primaryMuscle,
                      primary_muscle: (ex as any).primary_muscle,
                      _primary_muscle: (ex as any)._primary_muscle,
                      _archetype: (ex as any)._archetype,
                      _training_type: (ex as any)._training_type,
                    };
                    const hideWeight = shouldHideWeight(exMeta);
                    const hideReps = shouldHideReps(exMeta);
                    const openWarmupEntry = (slot: number, fallback?: CompletedSet) => {
                      setSetEntryTarget({
                        exIdx: i,
                        slot,
                        kind: 'warmup',
                        fallbackWeight: fallback && !hideWeight ? displayWeightNumber(fallback.weightLbs) : undefined,
                        fallbackReps: fallback && !hideReps ? String(fallback.reps) : undefined,
                      });
                    };
                    const warmupLabel = (set: CompletedSet) => {
                      const weightText = hideWeight || set.weightLbs <= 0 ? null : displayExerciseWeight(set.weightLbs, ex);
                      const repsText = hideReps || set.reps <= 0 ? null : `${set.reps} reps`;
                      return [weightText, repsText].filter(Boolean).join(' x ') || 'Logged';
                    };
                    return (
                      <View style={[styles.warmupSetPanel, { borderColor: themeColors.border, backgroundColor: themeColors.surfaceRaised }]}>
                        <View style={styles.warmupSetHeader}>
                          <View style={styles.warmupSetTitleRow}>
                            <Ionicons name="flame-outline" size={13} color={workoutPalette.strong} />
                            <Text style={[styles.warmupSetTitle, { color: themeColors.textPrimary }]}>Warm-up Sets</Text>
                            {warmupSets.length > 0 && (
                              <Text style={[styles.warmupSetCount, { color: themeColors.textMuted }]}>
                                {warmupSets.length}
                              </Text>
                            )}
                            {warmupNote && (
                              <TouchableOpacity
                                onPress={() => Alert.alert('Warm-up', (warmupNote ?? '').replace(/^Warm-up:\s*/, ''))}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                accessibilityRole="button"
                                accessibilityLabel={`Warm-up guidance for ${ex.name}`}>
                                <Ionicons name="information-circle-outline" size={15} color={themeColors.textMuted} />
                              </TouchableOpacity>
                            )}
                          </View>
                          <TouchableOpacity
                            style={[styles.warmupSetAddBtn, { borderColor: workoutPalette.strong + '66', backgroundColor: workoutPalette.strong + '10' }]}
                            onPress={() => openWarmupEntry(warmupSets.length, suggestions[0])}
                            accessibilityRole="button"
                            accessibilityLabel={`Add warm-up set for ${ex.name}`}>
                            <Ionicons name="add" size={14} color={workoutPalette.strong} />
                            <Text style={[styles.warmupSetAddText, { color: workoutPalette.strong }]}>Add</Text>
                          </TouchableOpacity>
                        </View>
                        {warmupSets.map((set, wi) => (
                          <View key={`warmup-${wi}`} style={[styles.warmupSetRow, { borderColor: themeColors.border }]}>
                            <TouchableOpacity
                              style={styles.warmupSetMain}
                              onPress={() => openWarmupEntry(wi, set)}
                              accessibilityRole="button"
                              accessibilityLabel={`Edit warm-up set ${wi + 1}`}>
                              <View style={[styles.warmupSetPill, { backgroundColor: workoutPalette.strong + '18' }]}>
                                <Text style={[styles.warmupSetPillText, { color: workoutPalette.strong }]}>W{wi + 1}</Text>
                              </View>
                              <Text style={[styles.warmupSetValue, { color: themeColors.textPrimary }]} numberOfLines={1}>
                                {warmupLabel(set)}
                              </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={styles.warmupSetDeleteBtn}
                              onPress={() => handleDeleteWarmupSet(i, wi)}
                              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                              accessibilityLabel={`Delete warm-up set ${wi + 1}`}>
                              <Ionicons name="close" size={14} color={themeColors.textMuted} />
                            </TouchableOpacity>
                          </View>
                        ))}
                        {suggestions.map((set, si) => {
                          const slot = warmupSets.length + si;
                          return (
                            <View key={`warmup-suggestion-${slot}`} style={[styles.warmupSetRow, styles.warmupSetGhostRow, { borderColor: workoutPalette.strong + '33' }]}>
                              <TouchableOpacity
                                style={styles.warmupSetMain}
                                onPress={() => openWarmupEntry(slot, set)}
                                accessibilityRole="button"
                                accessibilityLabel={`Open suggested warm-up set ${slot + 1}`}>
                                <View style={[styles.warmupSetPill, { backgroundColor: workoutPalette.strong + '12' }]}>
                                  <Text style={[styles.warmupSetPillText, { color: workoutPalette.strong }]}>W{slot + 1}</Text>
                                </View>
                                <Text style={[styles.warmupSetValue, { color: themeColors.textSecondary }]} numberOfLines={1}>
                                  {warmupLabel(set)}
                                </Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={styles.warmupSetDeleteBtn}
                                onPress={() => handleDismissWarmupSuggestion(i, set)}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                accessibilityRole="button"
                                accessibilityLabel={`Skip suggested warm-up set ${slot + 1}`}>
                                <Ionicons name="close" size={14} color={themeColors.textMuted} />
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={[styles.warmupSetLogBtn, { backgroundColor: workoutPalette.strong }]}
                                onPress={() => handleLogWarmupSet(i, slot, displayWeightNumber(set.weightLbs), String(set.reps))}
                                accessibilityRole="button"
                                accessibilityLabel={`Log suggested warm-up set ${slot + 1}`}>
                                <Text style={[styles.warmupSetLogText, { color: getContrastingTextColor(workoutPalette.strong) }]}>Log</Text>
                              </TouchableOpacity>
                            </View>
                          );
                        })}
                      </View>
                    );
                  })()}

                  {/* ── Pre-set coach hint (first set only, before
                       anything is logged). Clean label + weight; no
                       rationale text so it can't truncate. */}
                  {hasSetRows && !guide && ex.sets.length === 0 && preSetHints[i] && preSetHints[i].recommendedWeight != null && (
                    <View
                      testID={`pre-set-recommended-weight-card-${i}`}
                      accessibilityLabel={`pre-set-recommended-weight-card-${i}`}
                      style={[styles.preSetHintCard, {
                        borderLeftColor: workoutPalette.strong,
                        backgroundColor: workoutPalette.strong + '14',
                      }]}>
                      <Text style={{ fontSize: 10, fontWeight: '700', color: themeColors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                        {isDumbbellLoadExercise(ex) ? 'Recommended weight (each)' : 'Recommended weight'}
                      </Text>
                      <Text
                        testID={`pre-set-recommended-weight-value-${i}`}
                        accessibilityLabel={`Recommended weight ${displayExerciseWeight(preSetHints[i].recommendedWeight!, ex)}${preSetHints[i].recommendedReps ? ` x ${preSetHints[i].recommendedReps}` : ''}`}
                        style={{ fontSize: 18, fontWeight: '800', color: themeColors.textPrimary, marginTop: 2 }}>
                            {displayExerciseWeight(preSetHints[i].recommendedWeight!, ex)}
                        {preSetHints[i].recommendedReps ? (
                          <Text style={{ fontSize: 14, fontWeight: '600', color: themeColors.textSecondary }}>
                            {' '}× {preSetHints[i].recommendedReps}
                          </Text>
                        ) : null}
                      </Text>
                    </View>
                  )}
                  {hasSetRows && !guide && ex.sets.length === 0 && preSetLoadingIdx === i && !preSetHints[i] && (
                    <View
                      testID={`pre-set-recommendation-loading-${i}`}
                      accessibilityLabel={`pre-set-recommendation-loading-${i}`}
                      style={[styles.preSetHintCard, {
                        borderLeftColor: workoutPalette.strong,
                        backgroundColor: workoutPalette.strong + '10',
                      }]}>
                      <View style={styles.inlineLoadingRow}>
                        <ActivityIndicator size="small" color={workoutPalette.strong} />
                        <Text style={[styles.inlineLoadingText, { color: themeColors.textSecondary }]}>
                          Loading recommendation...
                        </Text>
                      </View>
                    </View>
                  )}

                  {/* ── Set-quality prompt — shown only for meaningful outliers ── */}
                  {hasSetRows && !guide && pendingRir && pendingRir.exIdx === i && (
                    <View style={[styles.aiBubble, { backgroundColor: workoutPalette.strong + '15', borderColor: workoutPalette.strong + '55', borderWidth: 1, flexDirection: 'column', alignItems: 'stretch', gap: 6 }]}>
                      <Text style={{ fontSize: 12, fontWeight: '800', color: workoutPalette.text }}>
                        {(pendingRir.kind ?? 'rir') === 'underperformance'
                          ? 'What limited that set?'
                          : 'Nice — how many more reps could you have done?'}
                      </Text>
                      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                        {(pendingRir.kind ?? 'rir') === 'underperformance' ? ([
                          { key: 'failure', label: 'Near failure', patch: { feedback: 'failure' as const, rir: 0 } },
                          { key: 'pain', label: 'Pain-limited', patch: { feedback: 'pain' as const, rir: 0 } },
                          { key: 'early', label: 'Stopped early', patch: { feedback: 'easy' as const, rir: 4 } },
                        ].map(option => (
                          <TouchableOpacity
                            key={option.key}
                            onPress={() => {
                              const tFeedback = __DEV__ ? Date.now() : 0;
                              const setIdx = pendingRir!.setIdx;
                              const updatedSets = exercises[i].sets.map((s, si) =>
                                si === setIdx ? { ...s, ...option.patch } : s
                              );
                              setExercises(prev => prev.map((e, ei) => {
                                if (ei !== i) return e;
                                const sets = e.sets.slice();
                                if (sets[setIdx]) sets[setIdx] = { ...sets[setIdx], ...option.patch };
                                return { ...e, sets };
                              }));
                              setPendingRir(null);
                              if (__DEV__) {
                                const dt = Date.now() - tFeedback;
                                console.log(`[ActiveWorkout][perf] underperformance pick COMMIT ${dt}ms`);
                              }
                              scheduleWorkoutSidecar(`underperformance-rec-refresh-${i}-${setIdx}`, async () => {
                                maybeRefreshRecommendationForExercise(i, updatedSets);
                              }, { detached: true });
                            }}
                            style={{ flex: 1, minWidth: 92, paddingVertical: 8, paddingHorizontal: 8, borderRadius: 8, alignItems: 'center', backgroundColor: workoutPalette.strong }}>
                            <Text style={{ color: getContrastingTextColor(workoutPalette.strong), fontSize: 12, fontWeight: '800' }} numberOfLines={1}>{option.label}</Text>
                          </TouchableOpacity>
                        ))) : ([0, 1, 2, 3, 4].map(rir => {
                          const label = rir === 4 ? '4+' : String(rir);
                          return (
                            <TouchableOpacity
                              key={rir}
                              onPress={() => {
                                // ── Synchronous, local-only ──
                                // Everything in this block runs before the next
                                // frame paints so the RIR sheet dismisses
                                // immediately and the user can keep moving.
                                const tRir = __DEV__ ? Date.now() : 0;
                                const setIdx = pendingRir!.setIdx;
                                const updatedSets = exercises[i].sets.map((s, si) =>
                                  si === setIdx ? { ...s, rir } : s
                                );
                                const loggedSet = updatedSets[setIdx];
                                const suggestion = loggedSet
                                  ? buildRirNextSetSuggestion(
                                    exercises[i],
                                    loggedSet,
                                    rir,
                                    updatedSets.length + 1,
                                    weightUnit,
                                  )
                                  : null;
                                // Write the rir onto the set in a single
                                // setExercises call. The recommendation cue
                                // is updated via the off-tree ref so we
                                // don't pay a second list re-render here.
                                if (suggestion?.fullText) {
                                  writeRecommendation(i, {
                                    text: suggestion.fullText,
                                    nextTarget: suggestion.nextTarget,
                                    cue: suggestion.cue,
                                    recommendedWeightLbs: suggestion.weightLbs,
                                    recommendedReps: suggestion.repsText,
                                    source: 'local_fallback',
                                  });
                                }
                                setExercises(prev => prev.map((e, ei) => {
                                  if (ei !== i) return e;
                                  const sets = e.sets.slice();
                                  if (sets[setIdx]) sets[setIdx] = { ...sets[setIdx], rir };
                                  return { ...e, sets };
                                }));
                                if (suggestion) {
                                  setRestNextTarget(suggestion.nextTarget);
                                  setRestCue(suggestion.cue);
                                }
                                setPendingRir(null);
                                if (__DEV__) {
                                  const dt = Date.now() - tRir;
                                  console.log(`[ActiveWorkout][perf] RIR pick COMMIT ${dt}ms`);
                                }

                                // ── Deferred (non-blocking) ──
                                // Watch push, Live Activity update, and the
                                // backend recommendation fetch all go through
                                // the workout sidecar so the RIR pill no
                                // longer "hangs" on slow cellular while these
                                // native-bridge / network calls finish.
                                if (suggestion) {
                                  scheduleWorkoutSidecar(`rir-watch-${i}-${setIdx}`, async () => {
                                    try {
                                      const watchSync = preloadedWatchSyncRef.current ?? await import('../utils/watchSync');
                                      await watchSync.pushProgressToWatch({
                                        exerciseIndex: i,
                                        setNumber: updatedSets.length + 1,
                                        recommendation: suggestion.watchText,
                                        recommendedWeightLbs: suggestion.weightLbs,
                                        recommendedReps: suggestion.repsText,
                                      });
                                    } catch { /* watch optional */ }
                                  }, { detached: true });
                                  if (liveActivityIdRef.current && liveActivityTimerKeyRef.current == null) {
                                    const liveActivityId = liveActivityIdRef.current;
                                    const totalSets = getEffectiveTargetSetCount(i, exercises[i], updatedSets.length);
                                    const exerciseName = exercises[i].name;
                                    scheduleWorkoutSidecar(`rir-live-${i}-${setIdx}`, async () => {
                                      try {
                                        await updateRestActivity(liveActivityId, {
                                          setNumber: updatedSets.length,
                                          totalSets,
                                          nextSetRecommendation: suggestion.watchText,
                                          exerciseName,
                                          themeColorHex: theme.colors.primary,
                                        });
                                      } catch { /* Live Activity optional */ }
                                    }, { detached: true });
                                  }
                                }
                                scheduleWorkoutSidecar(`rir-rec-refresh-${i}-${setIdx}`, async () => {
                                  maybeRefreshRecommendationForExercise(i, updatedSets);
                                }, { detached: true });
                              }}
                              style={{ flex: 1, minWidth: 44, paddingVertical: 8, borderRadius: 8, alignItems: 'center', backgroundColor: workoutPalette.strong }}>
                              <Text style={{ color: getContrastingTextColor(workoutPalette.strong), fontSize: 13, fontWeight: '800' }}>{label}</Text>
                            </TouchableOpacity>
                          );
                        }))}
                      </View>
                      <TouchableOpacity onPress={() => {
                        // Dismiss the set-quality pill instantly. The
                        // recommendation refresh is deferred so the dismiss
                        // isn't waiting on a network round trip.
                        setPendingRir(null);
                        const targetIdx = i;
                        const currentSets = exercises[i].sets;
                        scheduleWorkoutSidecar(`rir-skip-rec-refresh-${targetIdx}`, async () => {
                          maybeRefreshRecommendationForExercise(targetIdx, currentSets, { ignorePendingRir: true });
                        }, { detached: true });
                      }} style={{ alignSelf: 'flex-end', paddingVertical: 2 }}>
                        <Text style={{ fontSize: 11, color: themeColors.textMuted, fontWeight: '700' }}>Skip</Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  {/* Cardio guidance strip — shows planner targets such as
                      watts, RPM, resistance, speed, and incline. */}
                  {(() => {
                    const cg = (ex as any).cardioGuidance;
                    if (!cg) return null;
                    const chips: { label: string; value: string }[] = [];
                    if (cg.watts_range)      chips.push({ label: 'Watts', value: cg.watts_range });
                    if (cg.rpm_range)        chips.push({ label: 'RPM', value: cg.rpm_range });
                    if (cg.resistance_cue)   chips.push({ label: 'Resistance', value: cg.resistance_cue });
                    if (cg.speed_range)      chips.push({ label: 'Speed', value: cg.speed_range });
                    if (cg.incline_range)    chips.push({ label: 'Incline', value: cg.incline_range });
                    if (cg.pace_per_500m)    chips.push({ label: '/500m', value: cg.pace_per_500m });
                    if (cg.stroke_rate)      chips.push({ label: 'SPM', value: cg.stroke_rate });
                    if (cg.hr_range)         chips.push({ label: 'HR', value: cg.hr_range });
                    if (chips.length === 0 && cg.rpe_range) chips.push({ label: 'RPE', value: cg.rpe_range });
                    if (chips.length === 0) return null;
                    return (
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 2, marginBottom: 10 }}>
                        {chips.map(chip => (
                          <View key={chip.label} style={{ backgroundColor: workoutPalette.soft, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 }}>
                            <Text style={{ fontSize: 10, fontWeight: '700', color: workoutPalette.strong, letterSpacing: 0.3 }}>
                              {chip.label}
                            </Text>
                            <Text style={{ fontSize: 13, fontWeight: '800', color: themeColors.textPrimary }}>
                              {chip.value}
                            </Text>
                          </View>
                        ))}
                        {cg.intensity_cue ? (
                          <Text style={{ fontSize: 11, color: themeColors.textMuted, alignSelf: 'center', flex: 1 }}>
                            {cg.intensity_cue}
                          </Text>
                        ) : null}
                      </View>
                    );
                  })()}

                  {/* ── Inline set rows ── */}
                  {(() => {
                    if (!hasSetRows) return null;
                    const timed = isTimedExercise(ex.name, ex.targetReps);
                    const isMultiInterval = timed && totalSetCount >= 2;
                    return (
                      <>
                        {/* ── Prominent timer for timed exercises ── */}
                        {timed && isActive && (() => {
                          const currentSlot = ex.sets.length;
                          const allDone = currentSlot >= totalSetCount;
                          const timerKey = `${i}-${currentSlot < totalSetCount ? currentSlot : totalSetCount - 1}`;
                          const timer = activeTimers[timerKey];
                          const timerRunning = timer?.running ?? false;
                          const timerElapsed = timerElapsedFromState(timer);
                          return (
                            <View style={{ alignItems: 'center', paddingVertical: 16, gap: 8 }}>
                              {isMultiInterval && (
                                <Text style={{ fontSize: 13, fontWeight: '700', color: themeColors.textMuted }}>
                                  {allDone ? 'All rounds complete' : `Round ${currentSlot + 1} of ${totalSetCount}`}
                                </Text>
                              )}
                              <TouchableOpacity onPress={() => { if (!allDone) setTimerModalKey(timerKey); }} activeOpacity={0.7}>
                                <ExerciseTimerElapsedText
                                  timer={timer}
                                  subscribeTimerTick={subscribeTimerTick}
                                  style={{
                                    fontSize: 56, fontWeight: '900', fontVariant: ['tabular-nums'] as any,
                                    letterSpacing: -1,
                                    color: allDone ? themeColors.textMuted : timerRunning ? themeColors.primary : themeColors.textPrimary,
                                  }}
                                />
                              </TouchableOpacity>
                              <Text style={{ fontSize: 11, color: themeColors.textMuted }}>
                                {allDone ? 'Done' : timerRunning ? 'Running — tap to expand' : timerElapsed > 0 ? 'Paused — tap to resume' : 'Tap to start timer'}
                              </Text>
                              {!allDone && (
                                <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
                                  {!timerRunning && timerElapsed === 0 ? (
                                    <TouchableOpacity
                                      style={{ backgroundColor: themeColors.primary, paddingHorizontal: 28, paddingVertical: 12, borderRadius: 12 }}
                                      onPress={() => { startExerciseTimer(timerKey); setTimerModalKey(timerKey); }}>
                                      <Text style={{ color: getContrastingTextColor(themeColors.primary), fontSize: 16, fontWeight: '800' }}>Start</Text>
                                    </TouchableOpacity>
                                  ) : timerRunning ? (
                                    <>
                                      <TouchableOpacity
                                        style={{ backgroundColor: '#E53935', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12 }}
                                        onPress={() => stopExerciseTimer(timerKey)}>
                                        <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>Pause</Text>
                                      </TouchableOpacity>
                                      <TouchableOpacity
                                        style={{ backgroundColor: themeColors.primary, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12 }}
                                        onPress={() => {
                                          stopExerciseTimer(timerKey);
                                          const secs = getTimerElapsed(timerKey);
                                          const durStr = secs > 0 ? formatDurationForInput(secs) : '';
                                          const inputKey = `${i}-${currentSlot}`;
                                          if (durStr) {
                                            setSetInputs(prev => ({ ...prev, [inputKey]: { ...prev[inputKey] ?? { weight: '', reps: '', duration: '' }, duration: durStr } }));
                                          }
                                          handleLogSetInline(i, currentSlot, true, durStr || undefined);
                                          resetExerciseTimer(timerKey);
                                        }}>
                                        <Text style={{ color: getContrastingTextColor(themeColors.primary), fontSize: 15, fontWeight: '700' }}>
                                          {isMultiInterval ? 'Log Round' : 'Done'}
                                        </Text>
                                      </TouchableOpacity>
                                    </>
                                  ) : (
                                    <>
                                      <TouchableOpacity
                                        style={{ backgroundColor: themeColors.primary, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12 }}
                                        onPress={() => startExerciseTimer(timerKey)}>
                                        <Text style={{ color: getContrastingTextColor(themeColors.primary), fontSize: 15, fontWeight: '700' }}>Resume</Text>
                                      </TouchableOpacity>
                                      <TouchableOpacity
                                        style={{ borderWidth: 1, borderColor: themeColors.border, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12 }}
                                        onPress={() => resetExerciseTimer(timerKey)}>
                                        <Text style={{ color: themeColors.textSecondary, fontSize: 15, fontWeight: '600' }}>Reset</Text>
                                      </TouchableOpacity>
                                      <TouchableOpacity
                                        style={{ backgroundColor: themeColors.primary + '22', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12 }}
                                        onPress={() => {
                                          const secs = getTimerElapsed(timerKey);
                                          const durStr = secs > 0 ? formatDurationForInput(secs) : '';
                                          const inputKey = `${i}-${currentSlot}`;
                                          if (durStr) {
                                            setSetInputs(prev => ({ ...prev, [inputKey]: { ...prev[inputKey] ?? { weight: '', reps: '', duration: '' }, duration: durStr } }));
                                          }
                                          handleLogSetInline(i, currentSlot, true, durStr || undefined);
                                          resetExerciseTimer(timerKey);
                                        }}>
                                        <Text style={{ color: themeColors.primary, fontSize: 15, fontWeight: '700' }}>
                                          {isMultiInterval ? 'Log Round' : 'Done'}
                                        </Text>
                                      </TouchableOpacity>
                                    </>
                                  )}
                                </View>
                              )}
                              {/* Logged rounds summary for intervals */}
                              {isMultiInterval && ex.sets.length > 0 && (
                                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                                  {ex.sets.map((s, si) => (
                                    <View key={si} style={{ backgroundColor: themeColors.primary + '22', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 }}>
                                      <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.primary }}>
                                        R{si + 1}: {guide && (s.durationSeconds ?? 0) <= 0
                                          ? 'Done'
                                          : s.durationSeconds != null
                                            ? `${Math.floor(s.durationSeconds / 60)}:${(s.durationSeconds % 60).toString().padStart(2, '0')}`
                                            : `${s.reps} reps`}
                                      </Text>
                                    </View>
                                  ))}
                                </View>
                              )}
                              {/* Manual duration entry for equipment-based timing */}
                              {!timerRunning && !allDone && (
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
                                  <Text style={{ fontSize: 11, color: themeColors.textMuted }}>Or enter manually:</Text>
                                  <TextInput
                                    style={[styles.inlineInput, { width: 100, textAlign: 'center' }]}
                                    value={(setInputs[`${i}-${currentSlot}`] ?? { duration: '' }).duration}
                                    onChangeText={(v) => {
                                      const inputKey = `${i}-${currentSlot}`;
                                      setSetInputs(prev => ({ ...prev, [inputKey]: { ...prev[inputKey] ?? { weight: '', reps: '', duration: '' }, duration: v } }));
                                    }}
                                    placeholder={isLongCardioExercise(ex.name, ex.targetReps, { primaryMuscle: ex.primaryMuscle }) ? '25 min' : '45s'}
                                    placeholderTextColor={themeColors.textMuted}
                                    keyboardType="default"
                                    returnKeyType="done"
                                    onSubmitEditing={() => {
                                      const inputKey = `${i}-${currentSlot}`;
                                      const durText = (setInputs[inputKey] ?? { duration: '' }).duration?.trim();
                                      handleLogSetInline(i, currentSlot, false, durText || undefined);
                                    }}
                                  />
                                  <TouchableOpacity
                                    style={{ backgroundColor: themeColors.primary, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10 }}
                                    onPress={() => {
                                      const inputKey = `${i}-${currentSlot}`;
                                      const durText = (setInputs[inputKey] ?? { duration: '' }).duration?.trim();
                                      handleLogSetInline(i, currentSlot, false, durText || undefined);
                                    }}
                                    accessibilityRole="button"
                                    accessibilityLabel="Log manual duration">
                                    <Text style={{ color: getContrastingTextColor(themeColors.primary), fontSize: 13, fontWeight: '800' }}>
                                      Log
                                    </Text>
                                  </TouchableOpacity>
                                </View>
                              )}
                              {/* Optional metrics input — shown when done, exercise-type-specific */}
                              {allDone && (() => {
                                const metricConfig = getTimedMetricsConfig(ex.name, (ex as any).cardioGuidance, distanceUnit);
                                if (!metricConfig) return null;
                                return (
                                  <View style={{ backgroundColor: themeColors.surfaceRaised, borderRadius: 10, padding: 12, marginTop: 10, gap: 10, borderWidth: 1, borderColor: themeColors.border }}>
                                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 9 }}>
                                      <View style={{ width: 30, height: 30, borderRadius: 8, backgroundColor: workoutPalette.soft, alignItems: 'center', justifyContent: 'center' }}>
                                        <Ionicons name={metricConfig.icon} size={16} color={workoutPalette.strong} />
                                      </View>
                                      <View style={{ flex: 1 }}>
                                        <Text style={{ fontSize: 13, fontWeight: '800', color: themeColors.textPrimary }}>{metricConfig.title}</Text>
                                        <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2, lineHeight: 15 }}>
                                          {metricConfig.subtitle}
                                        </Text>
                                      </View>
                                    </View>
                                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                                      {metricConfig.fields.map(m => (
                                      <View key={m.key} style={{ flexGrow: 1, flexBasis: '47%', minWidth: 128 }}>
                                        <Text style={{ fontSize: 11, color: themeColors.textMuted, fontWeight: '800', textTransform: 'uppercase', marginBottom: 4 }}>
                                          {m.label}
                                        </Text>
                                        <TextInput
                                          style={[styles.inlineInput, { width: '100%', textAlign: 'center' }]}
                                          placeholder={m.placeholder}
                                          placeholderTextColor={themeColors.textMuted}
                                          keyboardType={m.keyboard}
                                          value={timedMetrics[`${i}-${m.key}`] ?? ''}
                                          onChangeText={v => setTimedMetrics(prev => ({ ...prev, [`${i}-${m.key}`]: v }))}
                                        />
                                        <Text style={{ fontSize: 10, color: themeColors.textMuted, marginTop: 3 }} numberOfLines={1}>
                                          {m.helper}
                                        </Text>
                                      </View>
                                      ))}
                                    </View>
                                  </View>
                                );
                              })()}
                            </View>
                          );
                        })()}

                        {/* ── Standard set header + rows for non-timed exercises ── */}
                        {!timed && (() => {
                          // Shared predicates — also considers archetype /
                          // training type / primary_muscle / reps string,
                          // not just the hard-coded name regex.
                          const hideWeight = shouldHideWeight({
                            name: ex.name, equipment: ex.equipment,
                            reps: ex.targetReps,
                            primaryMuscle: ex.primaryMuscle,
                            primary_muscle: (ex as any).primary_muscle,
                            _primary_muscle: (ex as any)._primary_muscle,
                            _archetype: (ex as any)._archetype,
                            _training_type: (ex as any)._training_type,
                          });
                          const hideReps = shouldHideReps({
                            name: ex.name, equipment: ex.equipment,
                            reps: ex.targetReps,
                            primaryMuscle: ex.primaryMuscle,
                            primary_muscle: (ex as any).primary_muscle,
                            _primary_muscle: (ex as any)._primary_muscle,
                            _archetype: (ex as any)._archetype,
                            _training_type: (ex as any)._training_type,
                          });
                          return (
                        <View style={styles.inlineSetsHeader}>
                          <Text style={[styles.inlineSetsLabel, { width: 20, flex: 0 }]}>#</Text>
                          {!hideWeight && <Text style={styles.inlineSetsLabel}>Weight ({exerciseWeightSuffix(ex)})</Text>}
                          <Text style={styles.inlineSetsLabel}>{hideReps ? 'Duration' : 'Reps'}</Text>
                          <Text style={styles.inlineSetsLabel}>Last time</Text>
                          <View style={{ width: 40 }} />
                        </View>
                          );
                        })()}

                        {!timed && Array.from({ length: totalSetCount }, (_, slot) => {
                          const logged = ex.sets[slot];
                          const inputKey = `${i}-${slot}`;
                          const input = setInputs[inputKey] ?? { weight: '', reps: '', duration: '' };
                          const lastSet = lastExerciseSets[ex.name]?.[slot] ?? lastExerciseSets[ex.name]?.[lastExerciseSets[ex.name]?.length - 1];
                          const isLogged = !!logged;
                          const exMeta = {
                            name: ex.name, equipment: ex.equipment,
                            reps: ex.targetReps,
                            primary_muscle: (ex as any).primary_muscle,
                            _primary_muscle: (ex as any)._primary_muscle,
                            _archetype: (ex as any)._archetype,
                            _training_type: (ex as any)._training_type,
                          };
                          const hideWeight = shouldHideWeight(exMeta);
                          const hideReps = shouldHideReps(exMeta);

                          const lastTimeLabel = lastSet
                            ? (lastSet.durationSeconds != null
                                ? `${(lastSet.durationSeconds / 60).toFixed(1)}min`
                                : `${displayWeight(lastSet.weightLbs, { suffix: false })}×${lastSet.reps}`)
                            : '—';
                          // Only the LAST slot is deletable (logged or
                          // unlogged) so we don't rearrange slot indices
                          // mid-list. Users can tap delete repeatedly to
                          // trim multiple.
                          const isLastSlot = slot === totalSetCount - 1 && totalSetCount > 1;
                          const handleDeleteSlot = () => {
                            const doDelete = () => {
                              // If this slot holds a logged set, drop it
                              // from the exercise's sets array.
                              if (isLogged) {
                                setExercises(prev => prev.map((e, idx) =>
                                  idx === i ? { ...e, sets: e.sets.slice(0, -1) } : e
                                ));
                              }
                              // Prefer removing a user-added "extra" set
                              // first (reverse of + Add Set). If none,
                              // reduce the base target via removedSetCounts.
                              const extras = extraSetCounts[i] ?? 0;
                              if (extras > 0) {
                                setExtraSetCounts(prev => ({ ...prev, [i]: Math.max(0, (prev[i] ?? 0) - 1) }));
                              } else {
                                setRemovedSetCounts(prev => ({ ...prev, [i]: (prev[i] ?? 0) + 1 }));
                              }
                              setSetInputs(prev => {
                                const next = { ...prev };
                                delete next[inputKey];
                                return next;
                              });
                            };
                            if (isLogged) {
                              Alert.alert('Delete set', `Remove set ${slot + 1}?`, [
                                { text: 'Cancel', style: 'cancel' },
                                { text: 'Delete', style: 'destructive', onPress: doDelete },
                              ]);
                            } else {
                              doDelete();
                            }
                          };
                          const pulseValue = getSetPulse(`${i}-${slot}`);
                          const pulseBg = pulseValue.interpolate({
                            inputRange: [0, 1],
                            outputRange: ['transparent', themeColors.success + '33'],
                          });
                          // Focus-driven border highlight for the weight
                          // input. Interpolation runs on JS (color + width
                          // are non-native props) but only for the one
                          // focused input at a time — cheap.
                          const weightFocusKey = `${i}-${slot}-weight`;
                          const weightFocusV = getInputFocus(weightFocusKey);
                          const weightBorderColor = weightFocusV.interpolate({
                            inputRange: [0, 1],
                            outputRange: [themeColors.border, workoutPalette.strong],
                          });
                          const weightBorderWidth = weightFocusV.interpolate({
                            inputRange: [0, 1],
                            outputRange: [1, 2],
                          });
                          const currentInputSlot = !isLogged && isActive && slot === ex.sets.length && !hideReps;
                          if (currentInputSlot) {
                            const previousSet = slot > 0 ? ex.sets[slot - 1] : null;
                            const hint = preSetHints[i];
                            const liveRec = recommendationByIdxRef.current[i];
                            const liveRecTargetText = liveRec?.nextTarget ?? liveRec?.text ?? null;
                            const currentLiveRec = liveRec && parseDisplaySetIndex(liveRecTargetText) === slot
                              ? liveRec
                              : null;
                            const previousRir = typeof previousSet?.rir === 'number' ? previousSet.rir : null;
                            const rirSuggestionForCurrentSet = previousSet && previousRir != null && !hideWeight
                              ? buildRirNextSetSuggestion(ex, previousSet, previousRir, slot + 1, weightUnit)
                              : null;
                            const fallbackWeightLbs = hideWeight
                              ? null
                              : currentLiveRec?.recommendedWeightLbs
                                ?? rirSuggestionForCurrentSet?.weightLbs
                                ?? previousSet?.weightLbs
                                ?? hint?.recommendedWeight
                                ?? (hint?.weightHeld ? null : ex.targetWeightLbs)
                                ?? lastSet?.weightLbs
                                ?? null;
                            const fallbackWeightText = fallbackWeightLbs != null && Number.isFinite(Number(fallbackWeightLbs))
                              ? displayWeightNumber(Number(fallbackWeightLbs))
                              : '';
                            const fallbackReps = parseTargetRepMin(currentLiveRec?.recommendedReps)
                              ?? parseTargetRepMin(rirSuggestionForCurrentSet?.repsText)
                              ?? parseTargetRepMin(hint?.recommendedReps)
                              ?? previousSet?.reps
                              ?? lastSet?.reps
                              ?? parseTargetRepMin(ex.targetReps)
                              ?? 10;
                            const fallbackRepsText = String(fallbackReps);
                            const weightFieldTouched = touchedSetFields.has(`${inputKey}:weight`);
                            const repsFieldTouched = touchedSetFields.has(`${inputKey}:reps`);
                            const currentWeightText = weightFieldTouched ? input.weight : (input.weight || fallbackWeightText);
                            const currentRepsText = repsFieldTouched ? input.reps : (input.reps || fallbackRepsText);
                            const unitStep = weightUnitStepForExercise(ex);
                            const largeUnitStep = unitStep * 2;
                            const repChoices = smartRepChoicesForExercise(ex);
                            const showRecommendationChip = Boolean(
                              currentLiveRec?.recommendedWeightLbs
                              || currentLiveRec?.recommendedReps
                              || hint?.recommendedWeight
                              || hint?.recommendedReps
                            );
                            const showTargetChip = !showRecommendationChip && Boolean(ex.targetWeightLbs || ex.targetReps);
                            const logLabel = hideWeight
                              ? `Log ${currentRepsText || 'set'} reps`
                              : `Log ${currentWeightText || '—'} × ${currentRepsText || '—'}`;
                            return (
                              <Fragment key={slot}>
                                <Animated.View
                                  style={[
                                    styles.smartSetPanel,
                                    {
                                      borderColor: workoutPalette.strong + 'AA',
                                      backgroundColor: workoutPalette.soft,
                                      shadowColor: workoutPalette.strong,
                                    },
                                  ]}>
                                  <View
                                    pointerEvents="none"
                                    style={[styles.smartSetPanelTint, { backgroundColor: workoutPalette.strong + '12' }]}
                                  />
                                  <View style={styles.smartSetHeader}>
                                    <View style={styles.smartSetTitleRow}>
                                      <View style={[styles.smartSetNumberPill, { backgroundColor: workoutPalette.strong }]}>
                                        <Text style={[styles.smartSetNumberText, { color: getContrastingTextColor(workoutPalette.strong) }]}>
                                          {slot + 1}
                                        </Text>
                                      </View>
                                      <View style={{ flex: 1, minWidth: 0 }}>
                                        <View style={styles.smartSetTitleLine}>
                                          <Text style={[styles.smartSetTitle, { color: themeColors.textPrimary }]}>Current Set</Text>
                                          <View
                                            style={[
                                              styles.smartSetNowPill,
                                              {
                                                backgroundColor: workoutPalette.strong + '18',
                                                borderColor: workoutPalette.strong + '66',
                                              },
                                            ]}>
                                            <Text style={[styles.smartSetNowPillText, { color: workoutPalette.strong }]}>Now</Text>
                                          </View>
                                        </View>
                                        <Text style={[styles.smartSetSub, { color: themeColors.textMuted }]} numberOfLines={1}>
                                          Last: {lastTimeLabel}
                                        </Text>
                                      </View>
                                    </View>
                                    {isLastSlot && (
                                      <TouchableOpacity
                                        style={styles.smartSetDeleteBtn}
                                        onPress={handleDeleteSlot}
                                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                        accessibilityLabel="Remove this set">
                                        <Ionicons name="close" size={15} color={themeColors.textMuted} />
                                      </TouchableOpacity>
                                    )}
                                  </View>

                                  {/* ── RIR-driven next-set load hint — deterministic,
                                       derived from the reps-in-reserve logged on the
                                       previous set of this exercise. ── */}
                                  {(() => {
                                    if (previousRir == null || hideWeight) {
                                      return null;
                                    }
                                    const suggestedWeightLbs = currentLiveRec?.recommendedWeightLbs ?? rirSuggestionForCurrentSet?.weightLbs;
                                    const previousWeightLbs = previousSet?.weightLbs;
                                    if (suggestedWeightLbs == null || !Number.isFinite(Number(suggestedWeightLbs)) || previousWeightLbs == null || !Number.isFinite(Number(previousWeightLbs))) {
                                      return null;
                                    }
                                    let icon: keyof typeof Ionicons.glyphMap;
                                    let tone: string;
                                    let text: string;
                                    if (previousRir >= 3) {
                                      icon = 'arrow-up-circle';
                                      tone = themeColors.success;
                                      text = `Last set had ~${previousRir} reps left — try ${displayExerciseWeight(suggestedWeightLbs, ex)} this set`;
                                    } else if (previousRir <= 0) {
                                      icon = 'alert-circle';
                                      tone = themeColors.warning;
                                      text = `Last set was a max effort — hold ${displayExerciseWeight(suggestedWeightLbs, ex)} or drop slightly`;
                                    } else {
                                      icon = 'checkmark-circle';
                                      tone = workoutPalette.strong;
                                      text = `Last set: ${previousRir} in reserve — repeat ${displayExerciseWeight(suggestedWeightLbs, ex)}`;
                                    }
                                    return (
                                      <View
                                        testID={`rir-next-set-hint-${i}-${slot}`}
                                        style={[styles.rirHintRow, { backgroundColor: tone + '14' }]}>
                                        <Ionicons name={icon} size={14} color={tone} />
                                        <Text style={[styles.rirHintText, { color: themeColors.textSecondary }]}>{text}</Text>
                                      </View>
                                    );
                                  })()}

                                  {!hideWeight && (
                                    <View style={styles.smartStepperBlock}>
                                      <View style={styles.smartStepperLabelRow}>
                                        <Text style={[styles.smartStepperLabel, { color: themeColors.textMuted }]}>
                                          Weight ({exerciseWeightSuffix(ex)})
                                        </Text>
                                        <Text style={[styles.smartStepperStepText, { color: themeColors.textMuted }]}>
                                          ±{formatStepperNumber(unitStep)}
                                        </Text>
                                      </View>
                                      <View style={styles.smartStepperControls}>
                                        <TouchableOpacity
                                          style={styles.smartStepBtn}
                                          onPress={() => { markSetFieldTouched(`${inputKey}:weight`); adjustSmartSetWeight(inputKey, ex, currentWeightText, -largeUnitStep); }}
                                          accessibilityRole="button"
                                          accessibilityLabel={`Decrease weight by ${formatStepperNumber(largeUnitStep)}`}>
                                          <Text style={styles.smartStepBtnText}>-{formatStepperNumber(largeUnitStep)}</Text>
                                        </TouchableOpacity>
                                        <TouchableOpacity
                                          style={styles.smartStepBtn}
                                          onPress={() => { markSetFieldTouched(`${inputKey}:weight`); adjustSmartSetWeight(inputKey, ex, currentWeightText, -unitStep); }}
                                          accessibilityRole="button"
                                          accessibilityLabel={`Decrease weight by ${formatStepperNumber(unitStep)}`}>
                                          <Ionicons name="remove" size={18} color={themeColors.textPrimary} />
                                        </TouchableOpacity>
                                        <TextInput
                                          testID={`set-weight-smart-input-${i}-${slot}`}
                                          style={styles.smartValueInput}
                                          value={currentWeightText}
                                          onChangeText={v => { markSetFieldTouched(`${inputKey}:weight`); mergeSetInput(inputKey, { weight: v }); }}
                                          keyboardType="decimal-pad"
                                          placeholder={fallbackWeightText || exerciseWeightSuffix(ex)}
                                          placeholderTextColor={themeColors.textMuted}
                                          selectTextOnFocus
                                        />
                                        <TouchableOpacity
                                          style={styles.smartStepBtn}
                                          onPress={() => { markSetFieldTouched(`${inputKey}:weight`); adjustSmartSetWeight(inputKey, ex, currentWeightText, unitStep); }}
                                          accessibilityRole="button"
                                          accessibilityLabel={`Increase weight by ${formatStepperNumber(unitStep)}`}>
                                          <Ionicons name="add" size={18} color={themeColors.textPrimary} />
                                        </TouchableOpacity>
                                        <TouchableOpacity
                                          style={styles.smartStepBtn}
                                          onPress={() => { markSetFieldTouched(`${inputKey}:weight`); adjustSmartSetWeight(inputKey, ex, currentWeightText, largeUnitStep); }}
                                          accessibilityRole="button"
                                          accessibilityLabel={`Increase weight by ${formatStepperNumber(largeUnitStep)}`}>
                                          <Text style={styles.smartStepBtnText}>+{formatStepperNumber(largeUnitStep)}</Text>
                                        </TouchableOpacity>
                                      </View>
                                    </View>
                                  )}

                                  <View style={styles.smartStepperBlock}>
                                    <View style={styles.smartStepperLabelRow}>
                                      <Text style={[styles.smartStepperLabel, { color: themeColors.textMuted }]}>Reps</Text>
                                      <Text style={[styles.smartStepperStepText, { color: themeColors.textMuted }]}>
                                        Target {ex.targetReps || '—'}
                                      </Text>
                                    </View>
                                    <View style={styles.smartStepperControls}>
                                      <TouchableOpacity
                                        style={styles.smartStepBtn}
                                        onPress={() => { markSetFieldTouched(`${inputKey}:reps`); adjustSmartSetReps(inputKey, currentRepsText, -1); }}
                                        accessibilityRole="button"
                                        accessibilityLabel="Decrease reps">
                                        <Ionicons name="remove" size={18} color={themeColors.textPrimary} />
                                      </TouchableOpacity>
                                      <TextInput
                                        testID={`set-reps-smart-input-${i}-${slot}`}
                                        style={styles.smartValueInput}
                                        value={currentRepsText}
                                        onChangeText={v => { markSetFieldTouched(`${inputKey}:reps`); mergeSetInput(inputKey, { reps: v.replace(/[^0-9]/g, '') }); }}
                                        keyboardType="number-pad"
                                        placeholder={fallbackRepsText || 'reps'}
                                        placeholderTextColor={themeColors.textMuted}
                                        selectTextOnFocus
                                      />
                                      <TouchableOpacity
                                        style={styles.smartStepBtn}
                                        onPress={() => { markSetFieldTouched(`${inputKey}:reps`); adjustSmartSetReps(inputKey, currentRepsText, 1); }}
                                        accessibilityRole="button"
                                        accessibilityLabel="Increase reps">
                                        <Ionicons name="add" size={18} color={themeColors.textPrimary} />
                                      </TouchableOpacity>
                                    </View>
                                  </View>

                                  <View style={styles.smartQuickRow}>
                                    {showRecommendationChip && (
                                      <TouchableOpacity
                                        style={[styles.smartQuickChip, { borderColor: workoutPalette.strong + '66', backgroundColor: workoutPalette.soft }]}
                                        onPress={() => applySmartSetPreset(inputKey, {
                                          weightLbs: currentLiveRec?.recommendedWeightLbs ?? rirSuggestionForCurrentSet?.weightLbs ?? hint?.recommendedWeight,
                                          reps: currentLiveRec?.recommendedReps ?? rirSuggestionForCurrentSet?.repsText ?? hint?.recommendedReps,
                                        })}
                                        accessibilityRole="button"
                                        accessibilityLabel="Use recommended set values">
                                        <Text style={[styles.smartQuickChipText, { color: workoutPalette.strong }]}>Rec</Text>
                                      </TouchableOpacity>
                                    )}
                                    {showTargetChip && (
                                      <TouchableOpacity
                                        style={styles.smartQuickChip}
                                        onPress={() => applySmartSetPreset(inputKey, { weightLbs: ex.targetWeightLbs, reps: ex.targetReps })}
                                        accessibilityRole="button"
                                        accessibilityLabel="Use planned set values">
                                        <Text style={styles.smartQuickChipText}>Plan</Text>
                                      </TouchableOpacity>
                                    )}
                                    {previousSet && (
                                      <TouchableOpacity
                                        style={styles.smartQuickChip}
                                        onPress={() => applySmartSetPreset(inputKey, { weightLbs: previousSet.weightLbs, reps: previousSet.reps })}
                                        accessibilityRole="button"
                                        accessibilityLabel="Copy previous set values">
                                        <Text style={styles.smartQuickChipText}>Prev</Text>
                                      </TouchableOpacity>
                                    )}
                                    {lastSet && (
                                      <TouchableOpacity
                                        style={styles.smartQuickChip}
                                        onPress={() => applySmartSetPreset(inputKey, { weightLbs: lastSet.weightLbs, reps: lastSet.reps })}
                                        accessibilityRole="button"
                                        accessibilityLabel="Use last workout set values">
                                        <Text style={styles.smartQuickChipText}>Last</Text>
                                      </TouchableOpacity>
                                    )}
                                    {(() => {
                                      const equipText = `${ex.equipment ?? ''} ${ex.name ?? ''}`.toLowerCase();
                                      const isBarbell = /(barbell|trap.?bar|ez.?curl|landmine|olympic)/.test(equipText) && !/dumbbell|\bdb\b/.test(equipText);
                                      if (!isBarbell) return null;
                                      const seedLbs = parseInputWeightLbs(currentWeightText)
                                        || fallbackWeightLbs
                                        || lastSet?.weightLbs
                                        || 0;
                                      return (
                                        <TouchableOpacity
                                          style={[styles.smartQuickChip, { flexDirection: 'row', gap: 4 }]}
                                          onPress={() => setPlateCalcTarget({ exIdx: i, slot, weightLbs: seedLbs })}
                                          accessibilityRole="button"
                                          accessibilityLabel={`Open plate calculator${seedLbs > 0 ? ` for ${seedLbs} lb` : ''}`}>
                                          <Ionicons name="calculator-outline" size={13} color={themeColors.textSecondary} />
                                          <Text style={styles.smartQuickChipText}>Plates</Text>
                                        </TouchableOpacity>
                                      );
                                    })()}
                                    {repChoices.map(choice => (
                                      <TouchableOpacity
                                        key={`rep-${choice}`}
                                        style={styles.smartQuickChip}
                                        onPress={() => mergeSetInput(inputKey, { reps: String(choice) })}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Set reps to ${choice}`}>
                                        <Text style={styles.smartQuickChipText}>{choice}</Text>
                                      </TouchableOpacity>
                                    ))}
                                  </View>

                                  <TouchableOpacity
                                    style={[styles.smartLogBtn, { backgroundColor: workoutPalette.strong }]}
                                    onPress={() => handleSmartLogSet(i, slot, {
                                      weight: fallbackWeightText,
                                      reps: fallbackRepsText,
                                      referenceSet: lastSet,
                                    })}
                                    accessibilityRole="button"
                                    accessibilityLabel={logLabel}>
                                    <Ionicons name="checkmark-circle" size={18} color={getContrastingTextColor(workoutPalette.strong)} />
                                    <Text style={[styles.smartLogBtnText, { color: getContrastingTextColor(workoutPalette.strong) }]}>
                                      {logLabel}
                                    </Text>
                                  </TouchableOpacity>
                                </Animated.View>
                              </Fragment>
                            );
                          }
                          return (
                            <Fragment key={slot}>
                            <Animated.View
                              style={[styles.inlineSetRow, isLogged && styles.inlineSetRowDone, { backgroundColor: pulseBg }]}>
                              <Text style={styles.inlineSetNum}>{slot + 1}</Text>
                              {!hideWeight && (() => {
                                const displayValue = isLogged
                                  ? displayWeightNumber(logged.weightLbs)
                                  : input.weight;
                                const showPlaceholder = !displayValue;
                                return (
                                  <TouchableOpacity
                                    testID={`set-weight-cell-${i}-${slot}`}
                                    activeOpacity={0.7}
                                    onPress={() => setSetEntryTarget({ exIdx: i, slot })}
                                    accessibilityLabel={isLogged
                                      ? `Edit weight, currently ${displayValue} ${exerciseWeightSuffix(ex)}`
                                      : `Enter weight for set ${slot + 1}`}
                                    style={[
                                      styles.inlineInput,
                                      styles.inlineCell,
                                      isLogged && styles.inlineInputDone,
                                    ]}>
                                    <Text
                                      style={[
                                        styles.inlineCellText,
                                        { color: showPlaceholder ? themeColors.textMuted : themeColors.textPrimary },
                                      ]}
                                      numberOfLines={1}>
                                      {showPlaceholder ? exerciseWeightSuffix(ex) : displayValue}
                                    </Text>
                                  </TouchableOpacity>
                                );
                              })()}
                              {hideReps ? (
                                // Time-based target (60s hold, 3 min flow) —
                                // render the prescribed duration inline
                                // instead of a numeric reps input. Logging
                                // is done via the row's check button which
                                // records a single "completed" set tagged
                                // with the target string.
                                <Text style={[styles.inlineInput, { textAlignVertical: 'center', textAlign: 'center' }]}>
                                  {formatDurationTarget({ reps: ex.targetReps })}
                                </Text>
                              ) : (() => {
                                const displayValue = isLogged
                                  ? String(logged.reps)
                                  : input.reps;
                                const showPlaceholder = !displayValue;
                                return (
                                  <TouchableOpacity
                                    testID={`set-reps-cell-${i}-${slot}`}
                                    activeOpacity={0.7}
                                    onPress={() => setSetEntryTarget({ exIdx: i, slot })}
                                    accessibilityLabel={isLogged
                                      ? `Edit reps, currently ${displayValue}`
                                      : `Enter reps for set ${slot + 1}`}
                                    style={[
                                      styles.inlineInput,
                                      styles.inlineCell,
                                      isLogged && styles.inlineInputDone,
                                    ]}>
                                    <Text
                                      style={[
                                        styles.inlineCellText,
                                        { color: showPlaceholder ? themeColors.textMuted : themeColors.textPrimary },
                                      ]}
                                      numberOfLines={1}>
                                      {showPlaceholder ? 'reps' : displayValue}
                                    </Text>
                                  </TouchableOpacity>
                                );
                              })()}
                              <TouchableOpacity
                                testID={`set-last-time-${i}-${slot}`}
                                accessibilityLabel={
                                  !isLogged && lastSet
                                    ? `Tap to fill set ${slot + 1} with last time: ${lastTimeLabel}`
                                    : `Last time set ${slot + 1}: ${lastTimeLabel}`
                                }
                                disabled={isLogged || !lastSet}
                                activeOpacity={lastSet && !isLogged ? 0.5 : 1}
                                onPress={() => {
                                  if (isLogged || !lastSet) return;
                                  const weightStr = lastSet.weightLbs > 0
                                    ? displayWeightNumber(lastSet.weightLbs)
                                    : '';
                                  const repsStr = lastSet.reps > 0 ? String(lastSet.reps) : '';
                                  setSetInputs(prev => ({
                                    ...prev,
                                    [inputKey]: {
                                      ...(prev[inputKey] ?? { weight: '', reps: '', duration: '' }),
                                      weight: weightStr || (prev[inputKey]?.weight ?? ''),
                                      reps: repsStr || (prev[inputKey]?.reps ?? ''),
                                    },
                                  }));
                                }}
                                hitSlop={{ top: 4, bottom: 4, left: 2, right: 2 }}>
                                <Text style={styles.inlineLastResult} numberOfLines={1}>
                                  {lastTimeLabel}
                                </Text>
                              </TouchableOpacity>
                              <SetLogBadge
                                exIdx={i}
                                slot={slot}
                                setNumber={slot + 1}
                                isLogged={isLogged}
                                badgeScale={getSetBadgeScale(`${i}-${slot}`)}
                                onLogSet={handleLogSetInline}
                                badgeStyle={styles.inlineLoggedBadge}
                                badgePendingStyle={styles.inlineLoggedBadgePending}
                                badgeTextStyle={styles.inlineLoggedBadgeText}
                                textMutedColor={themeColors.textMuted}
                                backgroundColor={themeColors.background}
                              />
                              {(() => {
                                const equipText = `${ex.equipment ?? ''} ${ex.name ?? ''}`.toLowerCase();
                                const isBarbell = /(barbell|trap.?bar|ez.?curl|landmine|olympic)/.test(equipText) && !/dumbbell|\bdb\b/.test(equipText);
                                if (!isBarbell) return null;
                                // Surface the plate calc on every barbell set row,
                                // including the one the user is currently entering.
                                // Prefill order: logged weight → typed input → last
                                // session's weight at this slot → bar-only (0).
                                const typedLbs = parseInputWeightLbs(input.weight);
                                const seedLbs = isLogged
                                  ? (logged.weightLbs || 0)
                                  : typedLbs > 0
                                    ? typedLbs
                                    : (lastSet?.weightLbs ?? 0);
                                return (
                                  <TouchableOpacity
                                    onPress={() => setPlateCalcTarget({ exIdx: i, slot, weightLbs: seedLbs })}
                                    hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                                    accessibilityLabel={`Open plate calculator${seedLbs > 0 ? ` for ${seedLbs} lb` : ''}`}
                                    style={{ paddingHorizontal: 6, paddingVertical: 4 }}>
                                    <Ionicons name="calculator-outline" size={15} color={themeColors.textMuted} />
                                  </TouchableOpacity>
                                );
                              })()}
                              {isLastSlot && (
                                <TouchableOpacity
                                  style={styles.inlineDeleteBtn}
                                  onPress={handleDeleteSlot}
                                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                  accessibilityLabel="Remove this set">
                                  <Text style={styles.inlineDeleteBtnText}>×</Text>
                                </TouchableOpacity>
                              )}
                            </Animated.View>
                            {isLogged && hideWeight && hideReps && (
                              <View style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                gap: 6,
                                marginTop: -4,
                                marginBottom: 8,
                                paddingLeft: 30,
                              }}>
                                <Text style={{ fontSize: 10, fontWeight: '800', color: themeColors.textMuted, textTransform: 'uppercase' }}>
                                  Comfort
                                </Text>
                                {[
                                  { rating: 1, label: 'Tight' },
                                  { rating: 3, label: 'OK' },
                                  { rating: 5, label: 'Easy' },
                                ].map(opt => {
                                  const activeComfort = logged.comfortRating === opt.rating;
                                  return (
                                    <TouchableOpacity
                                      key={opt.rating}
                                      onPress={() => {
                                        setExercises(prev => prev.map((e, ei) => {
                                          if (ei !== i) return e;
                                          const sets = e.sets.slice();
                                          if (sets[slot]) sets[slot] = { ...sets[slot], comfortRating: opt.rating };
                                          return { ...e, sets };
                                        }));
                                      }}
                                      style={{
                                        paddingHorizontal: 9,
                                        paddingVertical: 5,
                                        borderRadius: 999,
                                        backgroundColor: activeComfort ? workoutPalette.strong : themeColors.surfaceRaised,
                                        borderWidth: 1,
                                        borderColor: activeComfort ? workoutPalette.strong : themeColors.border,
                                      }}>
                                      <Text style={{
                                        fontSize: 10,
                                        fontWeight: '800',
                                        color: activeComfort ? '#fff' : themeColors.textSecondary,
                                      }}>
                                        {opt.label}
                                      </Text>
                                    </TouchableOpacity>
                                  );
                                })}
                              </View>
                            )}
                            {isLogged && (
                              notesEditingKey === inputKey ? (
                                <View style={{ paddingLeft: 30, paddingRight: 4, marginTop: 2, marginBottom: 10 }}>
                                  <TextInput
                                    testID={`set-note-input-${i}-${slot}`}
                                    value={notesDraft}
                                    onChangeText={setNotesDraft}
                                    placeholder="Note (e.g. form felt off on rep 5)"
                                    placeholderTextColor={themeColors.textMuted}
                                    autoFocus
                                    multiline
                                    blurOnSubmit
                                    returnKeyType="done"
                                    onBlur={() => {
                                      commitSetNote(i, slot, notesDraft);
                                      setNotesEditingKey(null);
                                    }}
                                    onSubmitEditing={() => {
                                      commitSetNote(i, slot, notesDraft);
                                      setNotesEditingKey(null);
                                    }}
                                    style={{
                                      fontSize: 13,
                                      color: themeColors.textPrimary,
                                      backgroundColor: themeColors.surfaceRaised,
                                      borderWidth: 1,
                                      borderColor: themeColors.primary + '88',
                                      borderRadius: 10,
                                      paddingHorizontal: 12,
                                      paddingVertical: 8,
                                      minHeight: 40,
                                    }}
                                  />
                                </View>
                              ) : (
                                <View style={{ paddingLeft: 30, paddingRight: 4, marginTop: 2, marginBottom: 10 }}>
                                  <TouchableOpacity
                                    onPress={() => {
                                      setNotesDraft(logged.notes ?? '');
                                      setNotesEditingKey(inputKey);
                                    }}
                                    accessibilityLabel={logged.notes ? 'Edit note for this set' : 'Add note to this set'}
                                    activeOpacity={0.7}
                                    style={{
                                      flexDirection: 'row',
                                      alignItems: 'center',
                                      gap: 6,
                                      paddingHorizontal: 10,
                                      paddingVertical: 7,
                                      borderRadius: 8,
                                      borderWidth: 1,
                                      borderColor: logged.notes ? themeColors.primary + '55' : themeColors.border,
                                      backgroundColor: logged.notes ? themeColors.primary + '12' : themeColors.surfaceRaised,
                                    }}>
                                    <Ionicons
                                      name={logged.notes ? 'chatbubble-ellipses' : 'add-circle-outline'}
                                      size={14}
                                      color={logged.notes ? themeColors.primary : themeColors.textSecondary}
                                    />
                                    <Text
                                      numberOfLines={1}
                                      style={{
                                        flex: 1,
                                        fontSize: 12,
                                        fontWeight: '700',
                                        color: logged.notes ? themeColors.textPrimary : themeColors.textSecondary,
                                      }}>
                                      {logged.notes ?? 'Add note'}
                                    </Text>
                                    {logged.notes && (
                                      <Ionicons name="pencil" size={11} color={themeColors.textMuted} />
                                    )}
                                  </TouchableOpacity>
                                </View>
                              )
                            )}
                            </Fragment>
                          );
                        })}
                      </>
                    );
                  })()}

	                  {(() => {
	                    if (!hasSetRows) return null;
	                    const timedInterval = isTimedExercise(ex.name, ex.targetReps) && totalSetCount >= 2;
                    const unitLabel = guide ? 'Step' : timedInterval ? 'Interval' : 'Set';
                    const extras = extraSetCounts[i] ?? 0;
                    return (
                      <>
                        {isDone && (
                          <Text style={[styles.doneText, { textAlign: 'center', marginTop: 4 }]}>All sets complete!</Text>
                        )}
                        {extras > 2 && (
                          <Text style={{ fontSize: 11, color: themeColors.warning ?? '#F59E0B', textAlign: 'center', marginTop: 4, fontWeight: '600' }}>
                            {extras} extra sets beyond the plan — great effort, consider wrapping up
                          </Text>
                        )}
                        <View style={styles.doneRow}>
                          <TouchableOpacity
                            style={styles.addSetBtn}
                            onPress={() => {
                              const removed = removedSetCounts[i] ?? 0;
                              if (removed > 0) {
                                setRemovedSetCounts(prev => ({ ...prev, [i]: Math.max(0, removed - 1) }));
                              } else {
                                setExtraSetCounts(prev => ({ ...prev, [i]: (prev[i] ?? 0) + 1 }));
                              }
                            }}>
                            <Text style={styles.addSetBtnText}>+ Add {unitLabel}</Text>
                          </TouchableOpacity>
                        </View>
                      </>
                    );
                  })()}
                </View>
              )}
            </View>
              </SwipeableRow>
            </Fragment>
          );
        })}

        {/* Add Exercise — outside/below exercise cards */}
        {warmupDone && (
          <>
            {!isCustomCardioWorkout && !coreCircuitExists && (
              <PressableScale
                style={[
                  styles.addCoreCircuitBtn,
                  {
                    backgroundColor: workoutPalette.soft,
                    borderColor: workoutPalette.strong + '66',
                  },
                ]}
                disabled={exerciseLibraryLoading}
                accessibilityRole="button"
                accessibilityLabel="Add core circuit"
                onPress={handleAddCoreCircuit}>
                <Ionicons name="repeat" size={15} color={workoutPalette.strong} />
                <Text style={[styles.addCoreCircuitBtnText, { color: workoutPalette.strong }]}>
                  Add Core Circuit
                </Text>
                {exerciseLibraryLoading && (
                  <ActivityIndicator size="small" color={workoutPalette.strong} />
                )}
              </PressableScale>
            )}
            {!isCustomCardioWorkout && !stretchBlockExists && (
              <PressableScale
                style={[
                  styles.addCoreCircuitBtn,
                  {
                    backgroundColor: workoutPalette.soft,
                    borderColor: workoutPalette.strong + '66',
                  },
                ]}
                disabled={exerciseLibraryLoading}
                accessibilityRole="button"
                accessibilityLabel="Add stretch block"
                onPress={handleAddStretchBlock}>
                <Ionicons name="flower-outline" size={15} color={workoutPalette.strong} />
                <Text style={[styles.addCoreCircuitBtnText, { color: workoutPalette.strong }]}>
                  Add Stretch Block
                </Text>
                {exerciseLibraryLoading && (
                  <ActivityIndicator size="small" color={workoutPalette.strong} />
                )}
              </PressableScale>
            )}
            {!isCustomCardioWorkout && (
              <TouchableOpacity style={styles.addExerciseBtn} onPress={openAddExerciseModal}>
                <Text style={styles.addExerciseBtnText}>+ Add Exercise</Text>
              </TouchableOpacity>
            )}
            {canPauseWorkout && (
              <PressableScale
                testID={workoutPaused ? 'resume-workout-button' : 'pause-workout-button'}
                style={[
                  styles.pauseWorkoutBtn,
                  {
                    backgroundColor: workoutPaused ? workoutPalette.soft : themeColors.surface,
                    borderColor: workoutPaused ? workoutPalette.strong : themeColors.border,
                  },
                ]}
                accessibilityRole="button"
                accessibilityLabel={workoutPaused ? 'Resume workout' : 'Pause workout'}
                onPress={workoutPaused ? resumeWorkoutSession : pauseWorkoutSession}>
                <Ionicons
                  name={workoutPaused ? 'play' : 'pause'}
                  size={15}
                  color={workoutPaused ? workoutPalette.strong : themeColors.textSecondary}
                />
                <Text style={[
                  styles.pauseWorkoutBtnText,
                  { color: workoutPaused ? workoutPalette.strong : themeColors.textSecondary },
                ]}>
                  {workoutPaused ? 'Resume Workout' : 'Pause Workout'}
                </Text>
              </PressableScale>
            )}
            <PressableScale
              testID="finish-workout-button"
              style={[
                styles.finishBtn,
                canFinishWorkout && {
                  backgroundColor: workoutPalette.strong,
                  borderColor: workoutPalette.strong,
                  shadowColor: workoutPalette.strong,
                },
                !canFinishWorkout && styles.finishBtnDisabled,
              ]}
              disabled={!canFinishWorkout}
              accessibilityRole="button"
              accessibilityLabel="Finish workout"
              onPress={() => {
                if (!canFinishWorkout) {
                  Alert.alert('No sets logged', 'Log at least one set before finishing.');
                  return;
                }
                import('../utils/feedback').then(f => f.hapticMedium()).catch(() => {});
                openFinishConfirmation();
              }}>
              <Text style={[styles.finishBtnText, !canFinishWorkout && styles.finishBtnTextDisabled]}>
                <Ionicons
                  name="checkmark-circle"
                  size={16}
                  color={canFinishWorkout ? themeColors.background : themeColors.textMuted}
                />{' '}
                {isCustomCardioWorkout ? `Finish ${workoutDisplayFocus || 'Workout'}` : 'Finish Workout'}
              </Text>
            </PressableScale>
          </>
        )}
      </ScrollView>
      )}

      {cancelingWorkout && (
        <View style={styles.cancelOverlay} pointerEvents="auto">
          <ActivityIndicator size="small" color={workoutPalette.strong} />
          <Text style={[styles.cancelOverlayText, { color: themeColors.textSecondary }]}>Canceling workout...</Text>
        </View>
      )}

      {/* Full-screen timer modal for timed exercises. Opens when the
          user taps Start on a timed set row. Reads from the same
          activeTimers state so the wall-clock calculation stays in
          sync with the inline display. The user can pause / resume /
          reset / done from the big controls and on Done the elapsed
          is auto-written to the set input and the modal closes. */}
      <Modal
        visible={timerModalKey !== null}
        transparent={false}
        animationType="fade"
        onRequestClose={() => setTimerModalKey(null)}>
        {(() => {
          if (timerModalKey == null) return null;
          const [exIdxStr, slotStr] = timerModalKey.split('-');
          const mExIdx = parseInt(exIdxStr, 10);
          const mSlot = parseInt(slotStr, 10);
          const mEx = exercises[mExIdx];
          const mTimer = activeTimers[timerModalKey];
          const mRunning = mTimer?.running ?? false;
          const mInputKey = `${mExIdx}-${mSlot}`;
          const writeDurationAndClose = () => {
            if (mRunning) stopExerciseTimer(timerModalKey);
            const secs = getTimerElapsed(timerModalKey);
            if (secs > 0) {
              const durStr = formatDurationForInput(secs);
              setSetInputs(prev => ({
                ...prev,
                [mInputKey]: {
                  ...prev[mInputKey] ?? { weight: '', reps: '', duration: '' },
                  duration: durStr,
                },
              }));
            }
            endTimedLiveActivity(timerModalKey);
            setTimerModalKey(null);
          };
          return (
            <View style={[styles.timerModalRoot, { backgroundColor: themeColors.background }]}>
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 }}>
                {(() => {
                  const thumbSrc = mEx ? exerciseThumbSmall(mEx as any) : null;
                  const demoExerciseDbId = (mEx as any)?.demo_exercise_db_id ?? (mEx as any)?.demoExerciseDbId ?? null;
                  const hasThumb = hasExerciseThumbMedia({
                    exerciseName: mEx?.name ?? null,
                    demoExerciseDbId,
                    fallbackSource: thumbSrc,
                  });
                  return hasThumb ? (
                    <TouchableOpacity
                      activeOpacity={0.85}
                      onPress={() => {
                        if (!mEx?.name) return;
                        import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
                        openFormVideoForExercise(mEx);
                      }}
                      style={{
                        width: 70, height: 70, borderRadius: 16, marginBottom: 12,
                        backgroundColor: themeColors.surfaceRaised,
                        borderWidth: 1.5, borderColor: themeColors.primary,
                        position: 'relative',
                        shadowColor: themeColors.primary,
                        shadowOffset: { width: 0, height: 0 },
                        shadowOpacity: 0.75,
                        shadowRadius: 10,
                        elevation: 8,
                      }}>
                      <View style={{ width: '100%', height: '100%', borderRadius: 14, overflow: 'hidden' }}>
                        <ExerciseThumbMedia
                          exerciseName={mEx?.name ?? null}
                          demoExerciseDbId={demoExerciseDbId}
                          fallbackSource={thumbSrc}
                          style={{ width: '100%', height: '100%' }}
                          shouldPlayVideo={false}
                        />
                        <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(255,255,255,0.12)' }} />
                        <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
                          <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' }}>
                            <Ionicons name="play" size={12} color="#fff" style={{ marginLeft: 1 }} />
                          </View>
                        </View>
                      </View>
                    </TouchableOpacity>
                  ) : null;
                })()}
                <Text style={[styles.timerModalExerciseName, { color: themeColors.textSecondary }]} numberOfLines={2}>
                  {mEx?.name || 'Timed Set'}
                </Text>
                    {getExerciseTargetSetCount(mEx) >= 2 ? (
                      <Text style={[styles.timerModalTargetReps, { color: themeColors.textMuted }]}>
                        Round {mSlot + 1} of {getExerciseTargetSetCount(mEx)} · Target: {mEx?.targetReps ?? '—'}
                      </Text>
                    ) : (
                      <Text style={[styles.timerModalTargetReps, { color: themeColors.textMuted }]}>
                        Target: {mEx?.targetReps ?? '—'}
                      </Text>
                    )}
                    <ExerciseTimerModalControls
                      timerKey={timerModalKey}
                      timer={mTimer}
                      subscribeTimerTick={subscribeTimerTick}
                      screenStyles={styles}
                      themeColors={themeColors}
                      onStart={startExerciseTimer}
                      onStop={stopExerciseTimer}
                      onReset={resetExerciseTimer}
                      onDone={writeDurationAndClose}
                    />
                  </View>
                </View>
              );
        })()}
      </Modal>

      {/* Log Set Modal — keyboard-aware */}
      <Modal visible={logModalVisible} transparent animationType="slide" onRequestClose={() => setLogModalVisible(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setLogModalVisible(false)}>
            <View style={styles.logModal}>
              <View style={styles.logHandle} />
              <Text style={styles.logModalTitle}>
                Set {(exercises[logExIdx]?.sets.length ?? 0) + 1} — {exercises[logExIdx]?.name}
              </Text>
              <Text style={styles.logModalSub}>Target: {exercises[logExIdx]?.targetReps} reps</Text>

              <View style={styles.logInputRow}>
                <View style={styles.logInputWrap}>
                  <Text style={styles.logInputLabel}>Weight ({exerciseWeightSuffix(exercises[logExIdx])})</Text>
                  <TextInput
                    style={styles.logInput}
                    value={logWeight}
                    onChangeText={setLogWeight}
                    keyboardType="decimal-pad"
                    returnKeyType="next"
                    placeholder="0"
                    placeholderTextColor={themeColors.textMuted}
                    autoFocus
                    selectTextOnFocus
                    onSubmitEditing={() => repsInputRef.current?.focus()}
                    blurOnSubmit={false}
                  />
                </View>
                <View style={styles.logInputWrap}>
                  <Text style={styles.logInputLabel}>Reps</Text>
                  <TextInput
                    ref={repsInputRef}
                    style={styles.logInput}
                    value={logReps}
                    onChangeText={setLogReps}
                    keyboardType="number-pad"
                    returnKeyType="done"
                    placeholder="0"
                    placeholderTextColor={themeColors.textMuted}
                    selectTextOnFocus
                    onSubmitEditing={handleLogSet}
                  />
                </View>
              </View>

              <TouchableOpacity style={styles.logConfirmBtn} onPress={handleLogSet} accessibilityRole="button" accessibilityLabel="Save set">
                <Text style={styles.logConfirmText}>Save Set</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>

      {/* Confirm Finish Modal */}
      <Modal visible={finishModalVisible} transparent animationType="fade" onRequestClose={() => { if (!finishingWorkout) setFinishModalVisible(false); }}>
        <KeyboardAvoidingView
          style={styles.finishBackdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <FadeInView testID="finish-workout-confirm-modal" style={styles.finishModal} duration={260} slideDistance={10}>
            <View style={[styles.finishIconWrap, { backgroundColor: workoutPalette.soft }]}>
              <Ionicons name="flag" size={26} color={workoutPalette.strong} />
            </View>
            <Text style={styles.finishModalTitle}>Finish Workout?</Text>
            <Text style={styles.finishModalBody}>
              Save this session and open your shareable recap.
            </Text>
              <View style={styles.finishModalStats}>
                <View style={styles.finishModalStat}>
                <Text style={styles.finishModalStatValue}>{formatTime(finishDurationSecondsForDisplay)}</Text>
                <Text style={styles.finishModalStatLabel}>Time</Text>
              </View>
              <View style={styles.finishModalDivider} />
              <View style={styles.finishModalStat}>
                <Text style={styles.finishModalStatValue}>{finishMiddleStatValue}</Text>
                <Text style={styles.finishModalStatLabel}>{finishMiddleStatLabel}</Text>
              </View>
              <View style={styles.finishModalDivider} />
              <View style={styles.finishModalStat}>
                <Text style={styles.finishModalStatValue}>{finishFinalStatValue}</Text>
                <Text style={styles.finishModalStatLabel}>{finishFinalStatLabel}</Text>
              </View>
            </View>
            {showFinishManualData && (
              <View style={styles.finishManualCard}>
                <View style={styles.finishManualHeader}>
                  <View style={[styles.finishManualIcon, { backgroundColor: workoutPalette.soft }]}>
                    <Ionicons name="speedometer-outline" size={15} color={workoutPalette.strong} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.finishManualTitle}>Effort details</Text>
                    <Text style={styles.finishManualHint}>
                      {finishHasLiveHeartRate ? 'Add any missing cardio numbers.' : 'Heart-rate data is optional.'}
                    </Text>
                  </View>
                </View>
                <View style={styles.finishIntensityRow}>
                  {([
                    { key: 'easy', label: 'Easy', icon: 'leaf-outline', color: themeColors.success },
                    { key: 'moderate', label: 'Moderate', icon: 'flash-outline', color: themeColors.warning },
                    { key: 'hard', label: 'Hard', icon: 'flame-outline', color: themeColors.error },
                  ] as Array<{ key: ActivityIntensity; label: string; icon: string; color: string }>).map(opt => {
                    const active = finishEffectiveIntensity === opt.key;
                    return (
                      <TouchableOpacity
                        key={opt.key}
                        disabled={finishingWorkout}
                        activeOpacity={0.8}
                        onPress={() => setFinishPerceivedIntensity(opt.key)}
                        style={[
                          styles.finishIntensityChip,
                          {
                            borderColor: active ? opt.color : themeColors.border,
                            backgroundColor: active ? opt.color + '18' : themeColors.surface,
                          },
                        ]}>
                        <Ionicons name={opt.icon as any} size={14} color={active ? opt.color : themeColors.textMuted} />
                        <Text style={[styles.finishIntensityText, { color: active ? opt.color : themeColors.textSecondary }]}>
                          {opt.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <View style={styles.finishManualInputGrid}>
                  {isCustomCardioWorkout && !finishHasLiveDistance && (
                    <View style={styles.finishManualInputWrap}>
                      <Text style={styles.finishManualInputLabel}>Distance ({distanceSuffix(distanceUnit)})</Text>
                      <TextInput
                        value={finishManualDistance}
                        onChangeText={setFinishManualDistance}
                        keyboardType="decimal-pad"
                        placeholder="--"
                        placeholderTextColor={themeColors.textMuted}
                        style={styles.finishManualInput}
                        editable={!finishingWorkout}
                      />
                    </View>
                  )}
                  {!finishHasLiveCalories && (
                    <View style={styles.finishManualInputWrap}>
                      <Text style={styles.finishManualInputLabel}>Calories</Text>
                      <TextInput
                        value={finishManualCalories}
                        onChangeText={setFinishManualCalories}
                        keyboardType="number-pad"
                        placeholder="--"
                        placeholderTextColor={themeColors.textMuted}
                        style={styles.finishManualInput}
                        editable={!finishingWorkout}
                      />
                    </View>
                  )}
                  {!finishHasLiveHeartRate && (
                    <View style={styles.finishManualInputWrap}>
                      <Text style={styles.finishManualInputLabel}>Avg HR</Text>
                      <TextInput
                        value={finishManualAvgHr}
                        onChangeText={setFinishManualAvgHr}
                        keyboardType="number-pad"
                        placeholder="--"
                        placeholderTextColor={themeColors.textMuted}
                        style={styles.finishManualInput}
                        editable={!finishingWorkout}
                      />
                    </View>
                  )}
                </View>
              </View>
            )}
            <TouchableOpacity
              testID="finish-workout-confirm-save"
              accessibilityLabel="finish-workout-confirm-save"
              style={[styles.finishConfirmBtn, finishingWorkout && { opacity: 0.75 }]}
              disabled={finishingWorkout}
              onPress={handleFinish}>
              {finishingWorkout ? (
                <View style={styles.finishConfirmLoadingRow}>
                  <ActivityIndicator size="small" color={themeColors.background} />
                  <Text style={styles.finishConfirmText}>Saving...</Text>
                </View>
              ) : (
                <Text style={styles.finishConfirmText}>Save and Finish</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              testID="finish-workout-confirm-cancel"
              accessibilityLabel="finish-workout-confirm-cancel"
              disabled={finishingWorkout}
              onPress={() => setFinishModalVisible(false)}>
              <Text style={styles.finishCancelText}>Keep Going</Text>
            </TouchableOpacity>
          </FadeInView>
        </KeyboardAvoidingView>
      </Modal>

      {/* Post-Workout Summary Modal */}
      <Modal visible={summaryVisible} transparent animationType="slide" onRequestClose={dismissSummaryModal}>
        <View style={styles.summaryBackdrop}>
          <ScrollView contentContainerStyle={styles.summaryScroll} keyboardShouldPersistTaps="handled">

            {/* ── Shareable Workout Summary Card ────────────────────── */}
              <FadeInView testID="post-workout-summary" style={styles.summaryModal} duration={360} slideDistance={18}>
                <View style={styles.summaryCompletionHeader}>
                  <CompletionBurst
                    variant="check"
                    active={summaryVisible}
                    size={88}
                    accentColor={workoutPalette.strong}
                    surfaceColor={workoutPalette.soft}
                    iconColor={workoutPalette.strong}
                  />
                  <Text style={styles.summaryCompletionTitle}>Workout complete</Text>
                  <Text style={styles.summaryCompletionSub}>
                    Your session is saved. Recap and sharing are ready.
                  </Text>
                </View>

                <ViewShot ref={summaryCardRef} options={{ format: 'png', quality: 1 }}>
                  <View style={styles.shareCard}>
                    <Image
                      source={summaryBackgroundSource}
                      style={styles.shareCardBackgroundImage}
                      resizeMode="cover"
                      fadeDuration={0}
                    />
                    <LinearGradient
                      colors={['rgba(0,0,0,0.18)', 'rgba(0,0,0,0.58)', 'rgba(0,0,0,0.86)']}
                      locations={[0, 0.52, 1]}
                      style={styles.shareCardScrim}
                    />
                    <View style={styles.shareCardContent}>
                      <View style={styles.shareCardHeader}>
                        <Image
                          source={SHARE_LOGO_DARK}
                          style={styles.shareCardLogo}
                          resizeMode="contain"
                        />
                        <View style={styles.shareCardDateBadge}>
                          <Text style={styles.shareCardDateText}>
                            {(() => { const d = new Date(); return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`; })()}
                          </Text>
                        </View>
                      </View>

                      <View style={styles.shareHeroBody}>
                        <View style={styles.shareKickerPill}>
                          <Ionicons name={summaryIconName as any} size={13} color="#fff" />
                          <Text style={styles.shareKicker}>{summaryTypeLabel}</Text>
                        </View>
                        <Text style={styles.shareCardFocus} numberOfLines={2}>{workoutDisplayFocus || 'Workout'}</Text>
                        <View style={styles.shareCompletionRow}>
                          <Text style={styles.shareCompletionText}>Workout complete</Text>
                          <Text style={styles.shareCompletionText}>{summaryPlanLabel}</Text>
                        </View>
                        {totalPlannedSets > 0 ? (
                          <View style={styles.shareCompletionTrack}>
                            <View
                              style={[
                                styles.shareCompletionFill,
                                { width: `${setCompletionPct}%`, backgroundColor: '#fff' },
                              ]}
                            />
                          </View>
                        ) : null}
                      </View>

                      {summaryLoadVolumeLbs > 0 && !summaryIsCardioLike ? (
                        <View
                          style={[
                            styles.shareVolumeHero,
                            { borderColor: summaryToneBorderColor(summaryVolumeTone) },
                          ]}>
                          <View style={styles.shareVolumeHeader}>
                            <View style={styles.shareVolumeLabelRow}>
                              <Ionicons name="speedometer-outline" size={15} color={summaryToneColor(summaryVolumeTone)} />
                              <Text style={styles.shareVolumeLabel}>Volume</Text>
                            </View>
                            <View style={[styles.shareStatToneDot, { backgroundColor: summaryToneColor(summaryVolumeTone) }]} />
                          </View>
                          <Text
                            style={styles.shareVolumeValue}
                            numberOfLines={1}
                            adjustsFontSizeToFit
                            minimumFontScale={0.7}>
                            {formatCompactLoad(summaryLoadVolumeLbs, weightUnit)}
                          </Text>
                          <Text
                            style={[styles.shareVolumeDelta, { color: summaryToneColor(summaryVolumeTone) }]}
                            numberOfLines={1}>
                            {summaryVolumeDeltaText}
                          </Text>
                        </View>
                      ) : null}

                      <View style={styles.shareStatsGrid}>
                        {summaryMetrics.map(metric => (
                          <View
                            key={metric.key}
                            style={[
                              styles.shareStatTile,
                              { borderColor: summaryToneBorderColor(metric.tone) },
                            ]}>
                            <View style={styles.shareStatTopRow}>
                              <Ionicons name={metric.icon as any} size={14} color={summaryToneColor(metric.tone)} />
                              <View style={[styles.shareStatToneDot, { backgroundColor: summaryToneColor(metric.tone) }]} />
                            </View>
                            <Text style={styles.shareStatValue} numberOfLines={1}>{metric.value}</Text>
                            <Text style={styles.shareStatLabel} numberOfLines={1}>{metric.label}</Text>
                            <Text style={[styles.shareStatHint, { color: summaryToneColor(metric.tone) }]} numberOfLines={1}>{metric.hint}</Text>
                          </View>
                        ))}
                      </View>

                      {summaryIsCardioLike && summaryData?.routeCoords && summaryData.routeCoords.length > 1 ? (
                        <View style={styles.shareRouteMapWrap}>
                          <RouteSummaryMap
                            themeName={themeName}
                            coords={summaryData.routeCoords}
                            height={132}
                          />
                        </View>
                      ) : null}

                      <Text style={styles.shareWatermark}>Tracked with THALLO</Text>
                    </View>
                  </View>
                </ViewShot>

                {summaryData?.trainingScore != null ? (
                  <TouchableOpacity
                    activeOpacity={0.82}
                    onPress={() => setTrainingScoreInfoOpen(true)}
                    style={styles.summaryScoreCompact}
                    accessibilityRole="button"
                    accessibilityLabel="How training score is calculated">
                    <View style={[styles.summaryScoreIcon, { backgroundColor: workoutPalette.soft }]}>
                      <Ionicons name="trophy-outline" size={17} color={workoutPalette.strong} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.summaryScoreTitle} numberOfLines={1}>
                        Training score
                      </Text>
                      <Text style={styles.summaryScoreBody} numberOfLines={1}>
                        {Math.round(summaryData.trainingScore)} / 100 · {summaryData.trainingRating ?? summaryTypeLabel}
                      </Text>
                    </View>
                    <Ionicons name="information-circle-outline" size={16} color={themeColors.textMuted} />
                  </TouchableOpacity>
                ) : null}

                {/* Off-screen Strava-style sticker card. Captured by
                    handleShareToStories and overlaid as a transparent
                    sticker on the user's IG Stories background photo.
                    Kept off-screen so layout still measures it (ViewShot
                    needs a real frame) without flashing it in the UI. */}
                <View
                  pointerEvents="none"
                  style={styles.shareStickerOffscreen}>
                  <ViewShot
                    ref={stickerCardRef}
                    options={{ format: 'png', quality: 1, result: 'tmpfile' }}
                    style={styles.shareStickerHost}>
                    <View style={styles.shareStickerInner}>
                      <View style={styles.shareStickerHeader}>
                        <Image
                          source={SHARE_LOGO_DARK}
                          style={styles.shareStickerLogo}
                          resizeMode="contain"
                        />
                        <Text style={styles.shareStickerDate}>
                          {(() => { const d = new Date(); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); })()}
                        </Text>
                      </View>
                      <Text style={styles.shareStickerKicker}>Workout</Text>
                      <Text style={styles.shareStickerFocus} numberOfLines={2}>{workoutDisplayFocus}</Text>
                      <View style={styles.shareStickerStatRow}>
                        <View style={styles.shareStickerStat}>
                          <Text style={styles.shareStickerStatValue}>{formatTime(summaryDurationSeconds)}</Text>
                          <Text style={styles.shareStickerStatLabel}>Duration</Text>
                        </View>
                        {summaryIsCardioLike && summaryDistanceMiles != null && summaryDistanceMiles > 0 ? (
                          <View style={styles.shareStickerStat}>
                            <Text style={styles.shareStickerStatValue}>
                              {formatDistance(summaryDistanceMiles, distanceUnit, { precision: summaryDistanceMiles >= 10 ? 0 : 2 })}
                            </Text>
                            <Text style={styles.shareStickerStatLabel}>Distance</Text>
                          </View>
                        ) : summarySetCount > 0 ? (
                          <View style={styles.shareStickerStat}>
                            <Text style={styles.shareStickerStatValue}>{summarySetCount}</Text>
                            <Text style={styles.shareStickerStatLabel}>Sets</Text>
                          </View>
                        ) : summaryDistanceMiles != null && summaryDistanceMiles > 0 ? (
                          <View style={styles.shareStickerStat}>
                            <Text style={styles.shareStickerStatValue}>
                              {formatDistance(summaryDistanceMiles, distanceUnit, { precision: summaryDistanceMiles >= 10 ? 0 : 2 })}
                            </Text>
                            <Text style={styles.shareStickerStatLabel}>Distance</Text>
                          </View>
                        ) : summaryCaloriesBurned != null && summaryCaloriesBurned > 0 ? (
                          <View style={styles.shareStickerStat}>
                            <Text style={styles.shareStickerStatValue}>{Math.round(summaryCaloriesBurned)}</Text>
                            <Text style={styles.shareStickerStatLabel}>Kcal</Text>
                          </View>
                        ) : null}
                        {summaryData?.trainingScore != null ? (
                          <View style={styles.shareStickerStat}>
                            <Text style={styles.shareStickerStatValue}>{Math.round(summaryData.trainingScore)}</Text>
                            <Text style={styles.shareStickerStatLabel}>Score</Text>
                          </View>
                        ) : null}
                      </View>
                      {(() => {
                        // Mirror the social-share contract: list each
                        // logged exercise with a compact "what was done"
                        // summary (e.g., "3 sets · 10 × 135 lb"). Cap at
                        // 6 rows so the sticker doesn't overflow the
                        // 360×640 capture frame on long workouts.
                        const MAX_ROWS = 6;
                        const loggedExercises = exercises.filter(ex => ex.sets.length > 0);
                        const visible = loggedExercises.slice(0, MAX_ROWS);
                        const overflow = loggedExercises.length - visible.length;
                        if (visible.length === 0) return null;
                        return (
                          <View style={styles.shareStickerExerciseList}>
                            {visible.map((ex, i) => {
                              const socialSets = ex.sets.map(set => ({
                                reps: set.reps ?? null,
                                weight_lbs: set.weightLbs ?? null,
                                duration_seconds: set.durationSeconds ?? null,
                                actual_distance: set.actualDistance ?? null,
                                actual_pace: set.actualPace ?? null,
                                heart_rate_avg: set.heartRateAvg ?? null,
                                cardio_metrics: set.cardioMetrics ?? null,
                              }));
                              const setSummary = compactSocialSetSummaries(socialSets).slice(0, 2).join('  ·  ')
                                || `${ex.sets.length} sets`;
                              return (
                                <View key={`${ex.name}-${i}`} style={styles.shareStickerExerciseRow}>
                                  <Text style={styles.shareStickerExerciseName} numberOfLines={1}>{ex.name}</Text>
                                  <Text style={styles.shareStickerExerciseSets} numberOfLines={1}>{setSummary}</Text>
                                </View>
                              );
                            })}
                            {overflow > 0 ? (
                              <Text style={styles.shareStickerOverflow}>+{overflow} more</Text>
                            ) : null}
                          </View>
                        );
                      })()}
                      <Text style={styles.shareStickerWatermark}>Tracked with THALLO</Text>
                    </View>
                  </ViewShot>
                </View>

                {/* Backend/AI work happens after the local session is already safe. */}
                {completionSyncState !== 'idle' && (
                  <View style={[
                    styles.summarySyncRow,
                    completionSyncState === 'queued'
                      ? { backgroundColor: themeColors.warning + '12', borderColor: themeColors.warning + '55' }
                      : completionSyncState === 'synced'
                        ? { backgroundColor: themeColors.success + '12', borderColor: themeColors.success + '55' }
                        : { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border },
                  ]}>
                    {completionSyncState === 'syncing' ? (
                      <ActivityIndicator size="small" color={themeColors.primary} />
                    ) : (
                      <Ionicons
                        name={completionSyncState === 'synced' ? 'cloud-done-outline' : 'cloud-offline-outline'}
                        size={16}
                        color={completionSyncState === 'synced' ? themeColors.success : themeColors.warning}
                      />
                    )}
                    <Text style={styles.summarySyncText}>
                      {completionSyncState === 'syncing'
                        ? 'Syncing workout details...'
                        : completionSyncState === 'synced'
                          ? 'Workout synced.'
                          : 'Saved offline. Sync will retry when connection returns.'}
                    </Text>
                  </View>
                )}

                {/* Loading state */}
                {summaryLoading && (
                  <View style={styles.summaryLoadingRow}>
                    <ActivityIndicator color={themeColors.primary} />
                    <Text style={styles.summaryLoadingText}>Coach is reviewing your session…</Text>
                  </View>
                )}

                <View style={styles.summaryShareIconRow}>
                  <TouchableOpacity
                    testID="summary-save-template"
                    accessibilityLabel="summary-save-template"
                    style={[
                      styles.summaryShareIconBtn,
                      {
                        backgroundColor: templateSaved ? themeColors.success + '18' : themeColors.surfaceRaised,
                        borderColor: templateSaved ? themeColors.success : themeColors.border,
                      },
                    ]}
                    onPress={handleSaveWorkoutTemplate}
                    disabled={templateSaving || templateSaved}
                    activeOpacity={0.85}>
                    <Ionicons
                      name={templateSaved ? 'checkmark-circle-outline' : 'bookmark-outline'}
                      size={16}
                      color={templateSaved ? themeColors.success : themeColors.textPrimary}
                    />
                    <Text
                      style={[
                        styles.summaryShareIconBtnText,
                        { color: templateSaved ? themeColors.success : themeColors.textPrimary },
                      ]}>
                      {templateSaving ? 'Saving' : templateSaved ? 'Saved' : 'Save'}
                    </Text>
                  </TouchableOpacity>
                  {SOCIAL_WORKOUT_POSTS_ENABLED ? (
                    <TouchableOpacity
                      style={[
                        styles.summaryShareIconBtn,
                        {
                          backgroundColor: themeColors.primary,
                          borderColor: themeColors.primary,
                          opacity: workoutPostSummary ? 1 : 0.55,
                        },
                      ]}
                      onPress={handleOpenFriendsShare}
                      accessibilityRole="button"
                      accessibilityLabel="Open friends share sheet"
                      activeOpacity={0.85}>
                      <Ionicons name="people-outline" size={16} color={getContrastingTextColor(themeColors.primary)} />
                      <Text style={[styles.summaryShareIconBtnText, { color: getContrastingTextColor(themeColors.primary) }]}>
                        Friends
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity
                    testID="summary-share-stories"
                    style={[
                      styles.summaryShareIconBtn,
                      {
                        backgroundColor: instagramAvailable ? '#E1306C' : themeColors.surfaceRaised,
                        borderColor: instagramAvailable ? '#E1306C' : themeColors.border,
                      },
                    ]}
                    onPress={handleShareToStories}
                    disabled={shareLoading}
                    accessibilityRole="button"
                    accessibilityLabel="Share workout to Instagram Stories"
                    activeOpacity={0.85}>
                    <Ionicons name="logo-instagram" size={16} color={instagramAvailable ? '#fff' : themeColors.textPrimary} />
                    <Text style={[styles.summaryShareIconBtnText, { color: instagramAvailable ? '#fff' : themeColors.textPrimary }]}>
                      Story
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    testID="summary-share-image"
                    style={[
                      styles.summaryShareIconBtn,
                      { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border },
                    ]}
                    onPress={handleShareSummary}
                    disabled={shareLoading}
                    accessibilityRole="button"
                    accessibilityLabel="Share workout recap image"
                    activeOpacity={0.85}>
                    <Ionicons name="share-outline" size={16} color={themeColors.textPrimary} />
                    <Text style={[styles.summaryShareIconBtnText, { color: themeColors.textPrimary }]}>
                      {shareLoading ? 'Saving' : 'Image'}
                    </Text>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity
                  testID="summary-close"
                  accessibilityLabel="summary-close"
                  onPress={dismissSummaryModal}
                  style={styles.summarySkipBtn}>
                  <Text style={styles.summarySkipText}>Close</Text>
                </TouchableOpacity>
              </FadeInView>

          </ScrollView>
        </View>
      </Modal>

      {SOCIAL_WORKOUT_POSTS_ENABLED ? (
        <ShareWorkoutModal
          visible={showShareWorkoutModal}
          authToken={authToken}
          onClose={handleCloseFriendsShare}
          themeName={themeName}
          workoutSummary={workoutPostSummary}
        />
      ) : null}

      <Modal visible={coachModalVisible} transparent animationType="slide" onRequestClose={() => setCoachModalVisible(false)}>
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 24 : 0}
        >
          <View style={styles.coachSheet}>
            <View style={styles.coachHeader}>
              <Text style={styles.coachTitle}>Workout Coach</Text>
              <TouchableOpacity onPress={() => setCoachModalVisible(false)}>
                <Text style={styles.coachClose}>Close</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.coachHint}>This chat is for form, pain flags, and in-session adjustments.</Text>
            {/* AI disclaimer — surfaces the same caveat that lives in
                LEGAL_SECTIONS so users see it next to the input where
                they're about to act on a recommendation. Sharp pain or
                injury → stop the workout and seek a clinician, not the
                chat. */}
            <Text style={[styles.coachHint, { fontStyle: 'italic', fontSize: 11, marginTop: -4 }]}>
              AI replies can be wrong — verify before acting. Stop for sharp pain or injury symptoms and get qualified help when needed.
            </Text>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.coachPromptRow}>
              {COACH_PROMPT_OPTIONS.map((option) => (
                <TouchableOpacity
                  key={option.label}
                  style={styles.coachPromptChip}
                  onPress={() => {
                    const activeExercise = exercises[activeExIdx]?.name ?? 'this exercise';
                    setCoachInput(option.template(activeExercise));
                  }}>
                  <Text style={styles.coachPromptChipText}>{option.label}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <ScrollView contentContainerStyle={styles.coachChatList} keyboardShouldPersistTaps="handled">
              {coachChat.length === 0 ? (
                <Text style={styles.coachEmpty}>Example: "I feel this in my elbow not chest. What cues should I use?"</Text>
              ) : (
                coachChat.map((m, idx) => (
                  <View key={idx} style={[styles.coachBubble, m.role === 'user' ? styles.coachBubbleUser : styles.coachBubbleAssistant]}>
                    {m.imageBase64 && m.imageMime && (
                      <Image
                        source={{ uri: `data:${m.imageMime};base64,${m.imageBase64}` }}
                        style={styles.coachBubbleImage}
                        resizeMode="cover"
                      />
                    )}
                    <Text style={[styles.coachBubbleText, m.role === 'user' && { color: getContrastingTextColor(themeColors.primary) }]}>
                      {m.content}
                    </Text>
                  </View>
                ))
              )}
            </ScrollView>

            {/* Pending-photo strip: shown when the user has attached a
                photo to send with the next question. Tap × to clear. */}
            {coachPendingPhoto && (
              <View style={styles.coachPhotoStrip}>
                <Image
                  source={{ uri: `data:${coachPendingPhoto.mime};base64,${coachPendingPhoto.base64}` }}
                  style={styles.coachPhotoThumb}
                />
                <Text style={styles.coachPhotoStripText}>Photo will be sent with your next question</Text>
                <TouchableOpacity onPress={() => setCoachPendingPhoto(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text style={styles.coachPhotoStripClear}>×</Text>
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.coachInputRow}>
              <TouchableOpacity
                style={styles.coachAttachBtn}
                onPress={() => {
                  Alert.alert(
                    'Attach photo',
                    'Send a photo with your question — e.g., a snap of your knee or bar position.',
                    [
                      { text: 'Take photo', onPress: () => handleAttachCoachPhoto('camera') },
                      { text: 'Choose from library', onPress: () => handleAttachCoachPhoto('library') },
                      { text: 'Cancel', style: 'cancel' },
                    ],
                  );
                }}
                disabled={coachLoading || coachPhotoLoading}
                accessibilityLabel="Attach photo"
              >
                <Ionicons name="camera-outline" size={20} color={themeColors.textSecondary} />
              </TouchableOpacity>
              <TextInput
                value={coachInput}
                onChangeText={setCoachInput}
                placeholder="Ask about form, weight, alternatives, or pain..."
                placeholderTextColor={themeColors.textMuted}
                style={styles.coachInput}
                multiline
              />
              <TouchableOpacity style={styles.coachSendBtn} onPress={handleAskWorkoutCoach} disabled={coachLoading || coachPhotoLoading}>
                {coachLoading ? <ActivityIndicator size="small" color={themeColors.background} /> : <Text style={styles.coachSendText}>Send</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Edit Logged Set Modal */}
      <Modal visible={editSetVisible} transparent animationType="fade" onRequestClose={() => setEditSetVisible(false)}>
        <View style={styles.finishBackdrop}>
          <View style={[styles.finishModal, { padding: 24, gap: 14 }]}>
            <Text style={[styles.summaryTitle, { fontSize: 18 }]}>Edit Set</Text>
            <View style={{ gap: 10 }}>
              <Text style={{ color: themeColors.textSecondary, fontSize: 13, fontWeight: '600' }}>Weight ({exerciseWeightSuffix(exercises[editSetExIdx])})</Text>
              <TextInput
                value={editSetWeight}
                onChangeText={setEditSetWeight}
                keyboardType="decimal-pad"
                style={[styles.addExerciseSearch, { marginTop: 0 }]}
                placeholderTextColor={themeColors.textMuted}
                placeholder="0"
              />
              <Text style={{ color: themeColors.textSecondary, fontSize: 13, fontWeight: '600' }}>Reps</Text>
              <TextInput
                value={editSetReps}
                onChangeText={setEditSetReps}
                keyboardType="number-pad"
                style={[styles.addExerciseSearch, { marginTop: 0 }]}
                placeholderTextColor={themeColors.textMuted}
                placeholder="0"
              />
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity
                style={[styles.warmupCoachBtn, { flex: 1 }]}
                onPress={() => setEditSetVisible(false)}>
                <Text style={[styles.warmupCoachBtnText, { color: themeColors.textSecondary }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.warmupDoneBtn, { flex: 1, backgroundColor: workoutPalette.strong }]}
                onPress={handleSaveEditedSet}>
                <Text style={styles.warmupDoneBtnText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={addExerciseModalVisible} transparent animationType="slide" onRequestClose={() => { setAddExerciseModalVisible(false); setSwapTargetIdx(null); }}>
        <KeyboardAvoidingView style={styles.modalBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.coachSheet}>
            <View style={styles.coachHeader}>
              <Text style={styles.coachTitle}>
                {swapTargetIdx != null
                  ? `Swap ${exercises[swapTargetIdx]?.name ?? 'exercise'}`
                  : 'Add an exercise'}
              </Text>
              <TouchableOpacity onPress={() => { setAddExerciseModalVisible(false); setSwapTargetIdx(null); }}>
                <Text style={styles.coachClose}>Close</Text>
              </TouchableOpacity>
            </View>
            {swapTargetIdx != null && (
              <Text style={{ fontSize: 11, color: themeColors.textMuted, marginBottom: 6 }}>
                Ranked by muscle overlap, available equipment, active injury flags, and logged history. Logged sets carry over.
              </Text>
            )}

            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <SearchInput
                // The 16px horizontal margin lives on the WRAPPER, not
                // the TextInput. Previously it sat on `addExerciseSearch`
                // and the absolute-positioned clear (×) — anchored to
                // the wrapper's right edge — rendered ~16px past the
                // rounded border of the visible search box.
                containerStyle={{ flex: 1, marginHorizontal: 16 }}
                testID={swapTargetIdx != null ? 'active-exercise-swap-search' : 'active-exercise-add-search'}
                value={exerciseSearch}
                onChangeText={(t) => {
                  setExerciseSearch(t);
                  setAiExerciseResults([]);
                  setAiExerciseLoading(false);
                  setIdentifiedEquipment(null);
                }}
                placeholder="Search by name, muscle, or equipment…"
                placeholderTextColor={themeColors.textMuted}
                style={styles.addExerciseSearch}
                returnKeyType="done"
              />
              {/* Photo scan — vision identifies the lift and prefers a
                  match from the user's library. Hidden during swap mode
                  (swap is local/ranked, not AI). */}
              {swapTargetIdx == null && (
                <TouchableOpacity
                  testID="active-exercise-photo-scan"
                  onPress={() => {
                    Alert.alert(
                      'Scan equipment',
                      'Snap a photo of the machine or rack and we’ll list the exercises you can do with it.',
                      [
                        { text: 'Camera', onPress: () => handlePhotoExerciseScan('camera') },
                        { text: 'Photo Library', onPress: () => handlePhotoExerciseScan('library') },
                        { text: 'Cancel', style: 'cancel' },
                      ],
                    );
                  }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={{
                    width: 40, height: 40, borderRadius: 10,
                    alignItems: 'center', justifyContent: 'center',
                    backgroundColor: themeColors.surface,
                    borderWidth: 1, borderColor: themeColors.border,
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Scan equipment from photo">
                  <Ionicons name="camera-outline" size={20} color={themeColors.textSecondary} />
                </TouchableOpacity>
              )}
              <TouchableOpacity
                testID="active-exercise-custom"
                onPress={openCustomExerciseModal}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={{
                  width: 40, height: 40, borderRadius: 10,
                  alignItems: 'center', justifyContent: 'center',
                  backgroundColor: workoutPalette.soft,
                  borderWidth: 1, borderColor: workoutPalette.strong + '66',
                }}
                accessibilityRole="button"
                accessibilityLabel="Add custom exercise">
                <Ionicons name="create-outline" size={20} color={workoutPalette.strong} />
              </TouchableOpacity>
            </View>

            {exerciseLibraryLoading ? (
              <ActivityIndicator size="small" color={themeColors.primary} style={{ marginTop: 12 }} />
            ) : (
              <FlatList
                contentContainerStyle={styles.addExerciseList}
                data={filteredExerciseLibrary}
                keyExtractor={exercisePickerKeyExtractor}
                renderItem={renderExercisePickerItem}
                keyboardShouldPersistTaps="handled"
                initialNumToRender={12}
                maxToRenderPerBatch={8}
                windowSize={7}
                removeClippedSubviews={Platform.OS !== 'web'}
                ListHeaderComponent={(
                  <>
                    {exerciseMuscleOptions.length > 0 && (
                      <>
                        <ScrollView
                          horizontal
                          showsHorizontalScrollIndicator={false}
                          decelerationRate="fast"
                          keyboardShouldPersistTaps="handled"
                          contentContainerStyle={styles.addExerciseFilterRow}>
                          <TouchableOpacity
                            accessibilityRole="button"
                            accessibilityLabel="Show all muscle filters"
                            style={[
                              styles.addExerciseFilterChip,
                              exerciseMuscleFilter === 'all' && styles.addExerciseFilterChipActive,
                            ]}
                            onPress={() => setExerciseMuscleFilter('all')}>
                            <Text style={[
                              styles.addExerciseFilterText,
                              exerciseMuscleFilter === 'all' && styles.addExerciseFilterTextActive,
                            ]}>All Muscles</Text>
                          </TouchableOpacity>
                          {exerciseMuscleOptions.map((muscle) => (
                            <TouchableOpacity
                              key={muscle}
                              accessibilityRole="button"
                              accessibilityLabel={`Filter exercises by ${humanizeToken(muscle)}`}
                              style={[
                                styles.addExerciseFilterChip,
                                exerciseMuscleFilter === muscle && styles.addExerciseFilterChipActive,
                              ]}
                              onPress={() => setExerciseMuscleFilter(muscle)}>
                              <Text style={[
                                styles.addExerciseFilterText,
                                exerciseMuscleFilter === muscle && styles.addExerciseFilterTextActive,
                              ]}>{humanizeToken(muscle)}</Text>
                            </TouchableOpacity>
                          ))}
                        </ScrollView>
                        {exerciseMuscleFilter !== 'all' && (
                          <View style={styles.addExerciseResultRow}>
                            <Text style={[styles.addExerciseResultText, { color: themeColors.textMuted }]}>
                              {filteredExerciseLibrary.length} result{filteredExerciseLibrary.length === 1 ? '' : 's'} · {humanizeToken(exerciseMuscleFilter)}
                            </Text>
                            <TouchableOpacity
                              accessibilityRole="button"
                              accessibilityLabel="Clear exercise muscle filter"
                              onPress={() => setExerciseMuscleFilter('all')}>
                              <Text style={[styles.addExerciseResultClear, { color: workoutPalette.strong }]}>Clear</Text>
                            </TouchableOpacity>
                          </View>
                        )}
                      </>
                    )}
                    {/* Section heading: top-10 recommended in default state,
                         match-count badge once the user types. */}
                    {swapTargetIdx == null && filteredExerciseLibrary.length > 0 && (
                      <View style={{ marginBottom: 8 }}>
                        <Text style={{ fontSize: 11, fontWeight: '800', color: themeColors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                          {exerciseSearch.trim()
                            ? `${filteredExerciseLibrary.length} match${filteredExerciseLibrary.length === 1 ? '' : 'es'}`
                            : `Top 10 for ${workoutDisplayFocus || 'your workout'}`}
                        </Text>
                      </View>
                    )}
                    {swapTargetIdx == null && aiExerciseLoading && aiExerciseResults.length === 0 && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                        <ActivityIndicator size="small" color={workoutPalette.strong} />
                        <Text style={{ fontSize: 12, color: themeColors.textMuted }}>
                          Searching beyond your saved exercise library...
                        </Text>
                      </View>
                    )}
                    {swapTargetIdx == null && aiExerciseResults.length > 0 && (
                      <View style={{ marginBottom: 14 }}>
                        <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                          {identifiedEquipment
                            ? `Exercises for ${identifiedEquipment}`
                            : exerciseSearch.trim() ? 'Results' : `Fits Your ${workoutDisplayFocus} Workout`}
                        </Text>
                        {aiExerciseResults.map((ex, i) => {
                          const aiItem = exerciseLibraryItemFromAiResult(ex);
                          const alignment = workoutAddAlignmentPercent(
                            scoreWorkoutAddCandidate(aiItem, currentWorkoutAddContext, workout.focus),
                          );
                          return (
                            <View key={`ai-${ex.name}-${i}`} style={[styles.addExerciseItem, { flexDirection: 'column', alignItems: 'stretch', borderColor: workoutPalette.strong + '66', borderWidth: 1.5 }]}>
                              <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                                <View style={{ flex: 1 }}>
                                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                    <Text style={styles.addExerciseName}>{ex.name}</Text>
                                    <ExerciseAlignmentBadge value={alignment} />
                                  </View>
                                  <Text style={styles.addExerciseMeta}>
                                    {humanizeToken(ex.primary_muscle)} · {formatEquipmentLabel(ex.equipment)} · {ex.sets}x{ex.reps}
                                  </Text>
                                </View>
                                {ex.source === 'wger' && (
                                  <View style={{ backgroundColor: themeColors.surfaceRaised, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                                    <Text style={{ fontSize: 9, fontWeight: '600', color: themeColors.textMuted }}>DB</Text>
                                  </View>
                                )}
                              </View>
                              <Text style={[styles.addExerciseMeta, { marginTop: 4 }]}>{ex.why}</Text>
                              {ex.form_cues?.length > 0 && (
                                <Text style={[styles.addExerciseMeta, { marginTop: 4, fontSize: 11, opacity: 0.7 }]}>
                                  Cues: {ex.form_cues.join(' · ')}
                                </Text>
                              )}
                              {/* Single Add button — handleAddAiExercise
                                  silently persists to the user's custom
                                  exercise library too, so future workouts
                                  find this lift via local search without
                                  another AI call. The dedicated "Save to
                                  library" button is gone since Add now
                                  covers both responsibilities. */}
                              <View style={{ marginTop: 10 }}>
                                <TouchableOpacity
                                  style={{ backgroundColor: workoutPalette.strong, paddingVertical: 10, borderRadius: 8, alignItems: 'center' }}
                                  onPress={() => handleAddAiExercise(ex)}>
                                  <Text style={{ color: getContrastingTextColor(workoutPalette.strong), fontWeight: '700', fontSize: 13 }}>Add to workout</Text>
                                </TouchableOpacity>
                              </View>
                            </View>
                          );
                        })}
                      </View>
                    )}
                  </>
                )}
                ListEmptyComponent={(
                  <>
                    <Text style={styles.coachEmpty}>
                      {swapTargetIdx != null
                        ? 'No compatible swaps match your search.'
                        : 'Nothing in your library matches.'}
                    </Text>
                    {swapTargetIdx == null && exerciseSearch.trim().length > 1 && aiExerciseResults.length === 0 && !aiExerciseLoading && (
                      <TouchableOpacity
                        style={{ marginTop: 10, alignSelf: 'center', paddingVertical: 12, paddingHorizontal: 18, backgroundColor: themeColors.surfaceRaised, borderWidth: 1, borderColor: workoutPalette.strong + '55', borderRadius: 10 }}
                        onPress={handleAiExerciseSearch}>
                        <Text style={{ color: workoutPalette.strong, fontWeight: '700', fontSize: 13 }}>Search beyond library</Text>
                      </TouchableOpacity>
                    )}
                    {exerciseSearch.trim().length > 1 && (
                      <TouchableOpacity
                        style={{ marginTop: 10, alignSelf: 'center', paddingVertical: 12, paddingHorizontal: 18, backgroundColor: workoutPalette.soft, borderWidth: 1, borderColor: workoutPalette.strong + '66', borderRadius: 10 }}
                        onPress={openCustomExerciseModal}>
                        <Text style={{ color: workoutPalette.strong, fontWeight: '800', fontSize: 13 }}>Add custom exercise</Text>
                      </TouchableOpacity>
                    )}
                  </>
                )}
              />
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <CustomExerciseModal
        visible={customExerciseModalVisible}
        themeName={themeName}
        initialName={exerciseSearch.trim()}
        title={swapTargetIdx != null ? 'Custom Swap' : 'Custom Exercise'}
        saveLabel={swapTargetIdx != null ? 'Save and Swap' : 'Save and Add'}
        authToken={authToken}
        availableEquipment={ownedEquipment}
        equipmentOptions={customExerciseEquipmentOptions}
        injuries={activeInjuryTokens}
        onClose={closeCustomExerciseModal}
        onSave={handleSaveManualCustomExercise}
      />

      <FormVideoModal
        visible={!!formVideoExerciseName}
        exerciseName={formVideoExerciseName ?? ''}
        authToken={authToken}
        themeName={themeName}
        equipment={formVideoContext.equipment}
        primaryMuscle={formVideoContext.primaryMuscle}
        movementPattern={formVideoContext.movementPattern}
        demoExerciseDbId={formVideoContext.demoExerciseDbId}
        onClose={() => {
          const shouldReturnToPicker = returnToExercisePickerAfterVideo;
          setFormVideoExerciseName(null);
          setFormVideoContext({});
          setReturnToExercisePickerAfterVideo(false);
          if (shouldReturnToPicker) {
            setTimeout(() => {
              InteractionManager.runAfterInteractions(() => setAddExerciseModalVisible(true));
            }, 360);
          }
        }}
      />

      {/* Enlarged equipment image — fired from the inline equipment
          card on the active exercise. Tap-out to dismiss. */}
      <Modal
        visible={!!enlargedEquipment}
        transparent
        animationType="fade"
        onRequestClose={() => setEnlargedEquipment(null)}
      >
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setEnlargedEquipment(null)}
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.85)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          {enlargedEquipment ? (() => {
            const source = getEquipmentImageSource(enlargedEquipment.equipment);
            const title = enlargedEquipment.name || equipmentDisplayName(enlargedEquipment.equipment) || 'Equipment';
            return (
              <View
                // Stop propagation: tapping the image itself shouldn't dismiss,
                // only the dim background or the close button.
                onStartShouldSetResponder={() => true}
                style={{
                  width: '100%',
                  maxWidth: 460,
                  backgroundColor: themeColors.surface,
                  borderRadius: 16,
                  overflow: 'hidden',
                  borderWidth: 1,
                  borderColor: themeColors.border,
                }}
              >
                <View
                  style={{
                    height: 320,
                    backgroundColor: themeColors.surfaceRaised,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {source ? (
                    <Image source={source} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
                  ) : (
                    <Ionicons name="barbell-outline" size={96} color={workoutPalette.strong} />
                  )}
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', padding: 14, gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 16, fontWeight: '800', color: themeColors.textPrimary }} numberOfLines={2}>
                      {title}
                    </Text>
                    <Text style={{ fontSize: 12, color: themeColors.textMuted, marginTop: 3 }}>
                      Tap anywhere to close
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => setEnlargedEquipment(null)}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    style={{
                      width: 36, height: 36, borderRadius: 18,
                      backgroundColor: themeColors.surfaceRaised,
                      alignItems: 'center', justifyContent: 'center',
                      borderWidth: 1, borderColor: themeColors.border,
                    }}
                  >
                    <Ionicons name="close" size={18} color={themeColors.textPrimary} />
                  </TouchableOpacity>
                </View>
              </View>
            );
          })() : null}
        </TouchableOpacity>
      </Modal>

      {/* PR celebration — fires after handleFinish when the backend returns
          PRs. Replaces the old Alert.alert() with an animated themed modal. */}
      {prModalData && prModalData.length > 0 && (
        <PRCelebrationModal
          prs={prModalData}
          themeName={themeName}
          onDismiss={() => setPrModalData(null)}
        />
      )}

      {/* Per-session gear disambiguation — only shown when 2+ active gear
          items keyword-match this workout. Resolves the promise that
          gates logWorkoutDone, so the completion path waits on the user. */}
      <GearPickerModal
        visible={gearPickerCandidates.length > 0 && gearPickerResolver !== null}
        candidates={gearPickerCandidates}
        themeName={themeName}
        onPick={(ids) => {
          gearPickerResolver?.(ids);
          setGearPickerResolver(null);
          setGearPickerCandidates([]);
        }}
        onSkip={() => {
          gearPickerResolver?.(null);
          setGearPickerResolver(null);
          setGearPickerCandidates([]);
        }}
      />

      {showStartCountdown && (
        <StartCountdownOverlay
          themeName={themeName}
          onComplete={() => {
            setShowStartCountdown(false);
          }}
        />
      )}

      <ScoreInfoModal
        visible={trainingScoreInfoOpen}
        onClose={() => setTrainingScoreInfoOpen(false)}
        eyebrow="TRAINING SCORE"
        title="How this session scored"
        iconName="trophy-outline"
        iconColor={themeColors.primary}
        themeName={themeName}>
        <ScoreInfoBody themeName={themeName}>
          A 0–100 read of how well today's session matched its plan.
          Each pillar contributes a share of the total — the pillar bars
          below the score show how much of each was earned vs available.
        </ScoreInfoBody>
        <ScoreInfoSection title="Pillars (strength sessions)" themeName={themeName}>
          <ScoreInfoRow label="Effort (40)" value="hitting prescribed intensity / RPE" themeName={themeName} />
          <ScoreInfoRow label="Volume (25)" value="completing planned sets" themeName={themeName} />
          <ScoreInfoRow label="Time (20)" value="training within session duration window" themeName={themeName} />
          <ScoreInfoRow label="Consistency (15)" value="bonus for showing up this week" themeName={themeName} />
        </ScoreInfoSection>
        <ScoreInfoSection title="Pillars (cardio sessions)" themeName={themeName}>
          <ScoreInfoRow label="Zone target" value="time in prescribed HR zone" themeName={themeName} />
          <ScoreInfoRow label="Intervals" value="hitting hard-interval intensity" themeName={themeName} />
          <ScoreInfoRow label="Work/rest" value="completing planned intervals" themeName={themeName} />
        </ScoreInfoSection>
        <ScoreInfoSection title="Rating bands" themeName={themeName}>
          <ScoreInfoRow label="85+" value="Outstanding" valueColor={themeColors.success} themeName={themeName} />
          <ScoreInfoRow label="65–84" value="Solid" valueColor={themeColors.primary} themeName={themeName} />
          <ScoreInfoRow label="45–64" value="Mixed" valueColor={themeColors.warning} themeName={themeName} />
          <ScoreInfoRow label="Below 45" value="Tough day" valueColor={themeColors.error} themeName={themeName} />
        </ScoreInfoSection>
      </ScoreInfoModal>

      <WorkoutTimerModal
        visible={timerModalVisible}
        mode={timerMode}
        themeName={themeName}
        exerciseName={exercises[timerExerciseIdx]?.name}
        hrZones={hrZones}
        onClose={() => setTimerModalVisible(false)}
        onComplete={(result: TimerResult) => {
          setTimerModalVisible(false);
          const ex = exercises[timerExerciseIdx];
          if (!ex) return;
          const newSet: CompletedSet = {
            setNumber: ex.sets.length + 1,
            reps: result.reps ?? result.roundsCompleted,
            weightLbs: 0,
            durationSeconds: result.totalSeconds,
          };
          setExercises(prev => prev.map((e, idx) =>
            idx === timerExerciseIdx ? { ...e, sets: [...e.sets, newSet] } : e
          ));
        }}
      />

      <PlateCalculatorModal
        visible={plateCalcTarget !== null}
        weightLbs={plateCalcTarget?.weightLbs ?? 0}
        unit={weightUnit}
        themeName={themeName}
        onClose={() => setPlateCalcTarget(null)}
        onApply={(newLbs) => {
          if (!plateCalcTarget) return;
          const { exIdx, slot, kind = 'working' } = plateCalcTarget;
          const key = `${exIdx}-${slot}`;
          if (kind === 'warmup') {
            const existingWarmup = exercises[exIdx]?.warmupSets?.[slot];
            if (existingWarmup) {
              setExercises(prev => prev.map((e, ei) => {
                if (ei !== exIdx) return e;
                const warmupSets = [...(e.warmupSets ?? [])];
                if (warmupSets[slot]) warmupSets[slot] = { ...warmupSets[slot], weightLbs: newLbs };
                return { ...e, warmupSets };
              }));
            } else {
              setSetEntryTarget(prev => prev && prev.exIdx === exIdx && prev.slot === slot && prev.kind === 'warmup'
                ? { ...prev, fallbackWeight: displayWeightNumber(newLbs) }
                : prev
              );
            }
            return;
          }
          const existing = exercises[exIdx]?.sets[slot];
          if (existing) {
            // Logged set — patch directly so the saved value reflects
            // the plate-loaded total.
            setExercises(prev => prev.map((e, ei) => {
              if (ei !== exIdx) return e;
              const sets = e.sets.slice();
              if (sets[slot]) sets[slot] = { ...sets[slot], weightLbs: newLbs };
              return { ...e, sets };
            }));
          } else {
            // Unlogged set — fill the input draft so the user can tap log.
            setSetInputs(prev => ({
              ...prev,
              [key]: {
                ...(prev[key] ?? { weight: '', reps: '', duration: '' }),
                weight: displayWeightNumber(newLbs),
              },
            }));
          }
        }}
      />

      {(() => {
        if (!setEntryTarget) return null;
        const { exIdx, slot, kind = 'working' } = setEntryTarget;
        const ex = exercises[exIdx];
        if (!ex) return null;
        const inputKey = `${exIdx}-${slot}`;
        const input = setInputs[inputKey] ?? { weight: '', reps: '', duration: '' };
        const logged = kind === 'warmup' ? ex.warmupSets?.[slot] : ex.sets[slot];
        const isLogged = !!logged;
        const exMeta = {
          name: ex.name, equipment: ex.equipment,
          reps: ex.targetReps,
          primary_muscle: (ex as any).primary_muscle,
          _primary_muscle: (ex as any)._primary_muscle,
          _archetype: (ex as any)._archetype,
          _training_type: (ex as any)._training_type,
        };
        const hideWeightForModal = shouldHideWeight(exMeta);
        const hideRepsForModal = shouldHideReps(exMeta);
        const lastSet = kind === 'warmup'
          ? null
          : lastExerciseSets[ex.name]?.[slot] ?? lastExerciseSets[ex.name]?.[lastExerciseSets[ex.name]?.length - 1];
        const fallbackWeightLbs = setEntryTarget.fallbackWeight
          ? parseInputWeightLbs(setEntryTarget.fallbackWeight)
          : lastSet?.weightLbs ?? ex.targetWeightLbs ?? null;
        const fallbackWeightText = fallbackWeightLbs != null && fallbackWeightLbs > 0
          ? displayWeightNumber(Number(fallbackWeightLbs))
          : '';
        const fallbackReps = setEntryTarget.fallbackReps
          ? Number.parseInt(setEntryTarget.fallbackReps, 10)
          : lastSet?.reps ?? parseTargetRepMin(ex.targetReps) ?? null;
        const fallbackRepsText = fallbackReps ? String(fallbackReps) : '';
        const initialWeight = isLogged
          ? displayWeightNumber(logged.weightLbs)
          : input.weight;
        const initialReps = isLogged
          ? String(logged.reps)
          : input.reps;
        const equipText = `${ex.equipment ?? ''} ${ex.name ?? ''}`.toLowerCase();
        const isBarbell = /(barbell|trap.?bar|ez.?curl|landmine|olympic)/.test(equipText) && !/dumbbell|\bdb\b/.test(equipText);
        const unitStep = weightUnitStepForExercise(ex);
        return (
          <SetEntryModal
            visible
            themeName={themeName}
            exerciseName={kind === 'warmup' ? `${ex.name} · warm-up` : ex.name}
            setNumber={slot + 1}
            weightSuffix={exerciseWeightSuffix(ex)}
            showWeight={!hideWeightForModal}
            showReps={!hideRepsForModal}
            initialWeight={initialWeight}
            initialReps={initialReps}
            fallbackWeight={fallbackWeightText}
            fallbackReps={fallbackRepsText}
            weightStep={unitStep}
            largeWeightStep={unitStep * 2}
            onOpenPlateCalc={isBarbell ? (currentWeight) => {
              const seedLbs = parseInputWeightLbs(currentWeight)
                || parseInputWeightLbs(fallbackWeightText)
                || 0;
              setPlateCalcTarget({ exIdx, slot, weightLbs: seedLbs, kind });
            } : undefined}
            onClose={() => setSetEntryTarget(null)}
            onLog={(weight, reps) => {
              const effectiveWeight = weight || fallbackWeightText;
              const effectiveReps = reps || fallbackRepsText;
              if (kind === 'warmup') {
                handleLogWarmupSet(exIdx, slot, effectiveWeight, effectiveReps);
                return;
              }
              if (isLogged) {
                // Editing an already-logged set — patch directly.
                const w = parseInputWeightLbs(effectiveWeight);
                const r = parseInt(effectiveReps || '0', 10);
                setExercises(prev => prev.map((e, ei) => {
                  if (ei !== exIdx) return e;
                  const sets = e.sets.slice();
                  if (sets[slot]) {
                    sets[slot] = {
                      ...sets[slot],
                      weightLbs: !isNaN(w) && w >= 0 ? w : sets[slot].weightLbs,
                      reps: !isNaN(r) && r > 0 ? r : sets[slot].reps,
                    };
                  }
                  return { ...e, sets };
                }));
              } else {
                // First-time log — seed the input draft then trigger
                // the canonical log path so all the side effects
                // (rest timer, watch push, PR detection) still fire.
                setSetInputs(prev => ({
                  ...prev,
                  [inputKey]: {
                    ...(prev[inputKey] ?? { weight: '', reps: '', duration: '' }),
                    weight: effectiveWeight,
                    reps: effectiveReps,
                  },
                }));
                handleLogSetInline(exIdx, slot, false, undefined, effectiveWeight, effectiveReps);
              }
            }}
          />
        );
      })()}

    </View>
  );
}

function createStyles(tc: ReturnType<typeof getTheme>['colors']) { return StyleSheet.create({
  warmupCard: {
    borderWidth: 1.5,
    borderRadius: radius.lg,
    padding: 18,
    margin: 18,
    marginBottom: 10,
    gap: 10,
    alignItems: 'flex-start',
  },
  // Collapsed mid-session header — smaller padding, full-width row
  // layout, expands inline when tapped.
  warmupCollapsed: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginHorizontal: 18,
    marginTop: 10,
    marginBottom: 10,
  },
  warmupCollapsedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  warmupCollapsedTitle: { fontSize: 13, fontWeight: '700' },
  warmupCollapsedHint: { fontSize: 11, fontWeight: '500', opacity: 0.75 },
  warmupTitle: { fontSize: 16, fontWeight: '800', marginBottom: 2 },
  warmupStep: { fontSize: 13, color: tc.textPrimary, lineHeight: 20 },
  warmupActions: { flexDirection: 'row', gap: 10, marginTop: 12, alignSelf: 'stretch' },
  warmupDoneBtn: {
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
  },
  warmupDoneBtnText: { color: tc.background, fontWeight: '700', fontSize: 15 },
  warmupCoachBtn: { borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: 16, paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
  warmupCoachBtnText: { fontSize: 13, fontWeight: '700' },
  inlineLoadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 22 },
  inlineLoadingText: { fontSize: 12, fontWeight: '700' },
  container: { flex: 1, backgroundColor: tc.background },

  header: { paddingHorizontal: 16, paddingTop: 48, paddingBottom: 6 },
  headerCard: {
    borderRadius: radius.lg,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: tc.border,
    shadowColor: tc.primary,
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
  headerControlRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerWorkoutTimer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: radius.full,
    borderWidth: 1,
    flexShrink: 0,
  },
  headerWorkoutTimerText: { fontSize: 12, fontWeight: '900', fontVariant: ['tabular-nums'] as any },
  headerHrChip: { maxWidth: 96 },
  headerHrChipText: { flexShrink: 1 },
  headerWatchSyncChip: {
    minHeight: 28,
    maxWidth: 154,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.full,
    borderWidth: 1,
    flexShrink: 1,
  },
  headerWatchSyncText: { flexShrink: 1, fontSize: 11, fontWeight: '900' },
  liveCardioMetricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginHorizontal: 12,
    marginBottom: 8,
  },
  liveCardioMetricTile: {
    flexGrow: 1,
    flexBasis: '31%',
    minWidth: 96,
    minHeight: 50,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveCardioMetricLabel: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  liveCardioMetricValue: {
    fontSize: 15,
    fontWeight: '800',
  },
  headerTitleBlock: { flex: 1, minWidth: 0 },
  focusLabel:   { fontSize: 13, fontWeight: '800', color: tc.textPrimary, marginBottom: 0 },
  headerMetaText: { fontSize: 10, color: tc.textMuted, fontWeight: '700' },
  headerActionRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  cancelBtn:    { paddingHorizontal: 10, paddingVertical: 5, backgroundColor: tc.surface, borderRadius: radius.full, borderWidth: 1, borderColor: tc.border },
  cancelBtnText:{ fontSize: 11, color: tc.textSecondary, fontWeight: '800' },
  coachBtn: { paddingHorizontal: 10, paddingVertical: 5, backgroundColor: tc.surface, borderRadius: radius.full, borderWidth: 1, borderColor: tc.primary },
  coachBtnText: { fontSize: 11, color: tc.primary, fontWeight: '800' },
  headerRestPanel: {
    marginTop: 8,
    padding: 10,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  headerRestMainRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  headerRestCircle: {
    width: 82,
    height: 82,
    borderRadius: 41,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  headerRestCircleLabel: { fontSize: 8, fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.75 },
  headerRestCircleValue: { fontSize: 19, fontWeight: '900', fontVariant: ['tabular-nums'] as any, lineHeight: 22 },
  headerRestCopy: { flex: 1, minWidth: 0, gap: 5, alignSelf: 'stretch' },
  headerRestExercise: { fontSize: 10, color: tc.textMuted, fontWeight: '900' },
  headerRestRecommendation: {
    flexShrink: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: radius.sm,
    backgroundColor: tc.background + '80',
    borderWidth: 1,
    borderColor: tc.border + '66',
  },
  headerRestInfoRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 1 },
  headerRestInfoLabel: { fontSize: 8, color: tc.textMuted, fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 1 },
  headerRestTarget: { fontSize: 12, fontWeight: '900', lineHeight: 16 },
  headerRestTutorial: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: tc.background + '66',
  },
  headerRestTutorialText: { flex: 1, minWidth: 0, fontSize: 10, color: tc.textSecondary, fontWeight: '700', lineHeight: 13 },
  headerRestTutorialButton: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.full, backgroundColor: tc.surface },
  headerRestTutorialButtonText: { fontSize: 10, color: tc.textPrimary, fontWeight: '900' },
  headerRestWatchRow: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full, backgroundColor: tc.background + '66' },
  headerRestWatchText: { fontSize: 10, fontWeight: '800' },
  headerRestActions: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 7, paddingLeft: 94 },
  headerRestBtn: {
    minWidth: 44,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: tc.border,
    backgroundColor: tc.surface,
    alignItems: 'center',
  },
  headerRestBtnText: { fontSize: 10, color: tc.textPrimary, fontWeight: '900' },

  scroll:        { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40 },
  liveCircuitBanner: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 6,
  },
  liveCircuitTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  liveCircuitTitle: { fontSize: 13, fontWeight: '900' },
  liveCircuitMeta: { fontSize: 11, lineHeight: 15, marginTop: 3, fontWeight: '700' },
  liveCircuitExerciseCard: {
    borderLeftWidth: 3,
    marginBottom: 6,
  },
  liveCircuitStationText: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },

  exerciseCard: {
    backgroundColor: tc.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: tc.border,
    padding: 14,
    marginBottom: 10,
    position: 'relative',
  },
  exerciseCardDone:   { borderColor: tc.primary, backgroundColor: tc.primary + '08', opacity: 0.9 },
  exerciseCardActive: {
    borderColor: tc.primary,
    backgroundColor: tc.surfaceRaised,
    shadowOpacity: 0.12,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3,
  },
  exerciseHeader:   { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  exerciseName:     { fontSize: 16, lineHeight: 20, fontWeight: '800', color: tc.textPrimary, marginBottom: 3 },
  exerciseNameDone: { color: tc.textSecondary, textDecorationLine: 'line-through' },
  exerciseMeta:     { fontSize: 12, lineHeight: 16, color: tc.textMuted },
  targetZoneRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, minWidth: 0 },
  targetZoneBadge: { borderWidth: 1, borderRadius: radius.full, paddingHorizontal: 7, paddingVertical: 2 },
  targetZoneBadgeText: { fontSize: 10, fontWeight: '900' },
  targetZoneText: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 16, fontWeight: '800' },

  setsBadge:        { backgroundColor: tc.surfaceRaised, borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: tc.border, marginTop: 3 },
  setsBadgeDone:    { backgroundColor: tc.primary, borderColor: tc.primary },
  setsBadgeText:    { fontSize: 12, fontWeight: '700', color: tc.textSecondary },
  setsBadgeTextDone:{ color: tc.background },

  exerciseEquipmentPreview: {
    marginTop: 12,
  },
  exerciseToolbar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: tc.border + '88',
  },
  exerciseToolbarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: radius.full,
    backgroundColor: tc.surface,
    borderWidth: 1,
    borderColor: tc.border,
  },
  exerciseToolbarDanger: {
    backgroundColor: tc.error + '10',
    borderColor: tc.error + '35',
  },
  exerciseToolbarText: { fontSize: 11, color: tc.textSecondary, fontWeight: '800' },

  exerciseDetail: { marginTop: 12, gap: 10 },

  // Add Exercise button — below all cards
  addCoreCircuitBtn: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: 12,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  addCoreCircuitBtnText: { fontSize: 13, fontWeight: '800' },
  addExerciseBtn: {
    borderWidth: 1,
    borderColor: tc.border,
    borderRadius: radius.md,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 10,
    backgroundColor: tc.surfaceRaised,
  },
  addExerciseBtnText: { fontSize: 13, color: tc.textSecondary, fontWeight: '600' },
  pauseWorkoutBtn: {
    minHeight: 46,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: 12,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  pauseWorkoutBtnText: { fontSize: 13, fontWeight: '800' },

  warmupSetPanel: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 10,
    marginTop: 8,
    marginBottom: 4,
    gap: 8,
  },
  warmupSetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  warmupSetTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  warmupSetTitle: { fontSize: 12, fontWeight: '800' },
  warmupSetCount: { fontSize: 11, fontWeight: '700' },
  warmupSetAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  warmupSetAddText: { fontSize: 11, fontWeight: '800' },
  warmupSetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  warmupSetGhostRow: { borderStyle: 'dashed' },
  warmupSetMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  warmupSetPill: { minWidth: 28, alignItems: 'center', borderRadius: 6, paddingHorizontal: 5, paddingVertical: 3 },
  warmupSetPillText: { fontSize: 10, fontWeight: '900' },
  warmupSetValue: { flex: 1, minWidth: 0, fontSize: 12, fontWeight: '700' },
  warmupSetDeleteBtn: { padding: 4 },
  warmupSetLogBtn: { borderRadius: 7, paddingHorizontal: 10, paddingVertical: 6 },
  warmupSetLogText: { fontSize: 11, fontWeight: '900' },
  preSetHintCard: {
    borderLeftWidth: 3,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.md,
    marginTop: 8,
    marginBottom: 4,
  },
  e1rmChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  e1rmChipText: { fontSize: 12, fontWeight: '600' },
  rirHintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: radius.md,
    marginBottom: 8,
  },
  rirHintText: { flex: 1, fontSize: 12, fontWeight: '600', lineHeight: 16 },

  // Form video link within exercise card
  formVideoLink: {
    alignSelf: 'flex-start',
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: tc.primary,
    backgroundColor: tc.primary + '14',
  },
  formVideoLinkText: { fontSize: 12, color: tc.primary, fontWeight: '700' },

  // Inline set logging
  inlineSetsHeader: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: tc.border },
  inlineSetsLabel: { flex: 1, fontSize: 10, fontWeight: '700', color: tc.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, textAlign: 'center' },
  inlineSetRow: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: tc.border + '66',
  },
  inlineSetRowDone: { opacity: 0.75 },
  inlineSetNum: { width: 20, fontSize: 13, fontWeight: '700', color: tc.textSecondary, textAlign: 'center' },
  inlineInput: {
    flex: 1, borderWidth: 1, borderColor: tc.border, borderRadius: radius.sm,
    paddingVertical: 8, paddingHorizontal: 6, fontSize: 16, fontWeight: '700',
    color: tc.textPrimary, backgroundColor: tc.surfaceRaised, textAlign: 'center',
  },
  inlineCell: { justifyContent: 'center', alignItems: 'center', minHeight: 36 },
  inlineCellText: { fontSize: 16, fontWeight: '700', textAlign: 'center' },
  inlineInputDone: { borderColor: tc.primary + '60', backgroundColor: tc.primary + '14', color: tc.primary },
  inlineLastResult: { flex: 1, fontSize: 13, color: tc.textMuted, textAlign: 'center', fontWeight: '600' },
  inlineLogBtn: {
    width: 40, paddingVertical: 8, borderRadius: radius.sm,
    backgroundColor: tc.primary, alignItems: 'center',
  },
  inlineLogBtnText: { fontSize: 12, fontWeight: '700', color: tc.background },
  inlineLoggedBadgePending: { backgroundColor: 'transparent' },
  inlineLoggedBadge: {
    width: 40, paddingVertical: 8, borderRadius: radius.sm,
    backgroundColor: tc.primary, alignItems: 'center',
  },
  inlineLoggedBadgeText: { fontSize: 14, color: tc.primary, fontWeight: '800' },
  inlineDeleteBtn: {
    width: 26, height: 26, borderRadius: 13,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: tc.surface,
    borderWidth: 1, borderColor: tc.border,
    marginLeft: 6,
  },
  inlineDeleteBtnText: {
    fontSize: 16, lineHeight: 18, fontWeight: '700', color: tc.textMuted,
  },
  smartSetPanel: {
    borderWidth: 1.5,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginTop: 8,
    marginBottom: 10,
    gap: 12,
    backgroundColor: tc.surfaceRaised,
    shadowOpacity: 0.16,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 7 },
    elevation: 4,
    overflow: 'hidden',
  },
  smartSetPanelTint: {
    ...StyleSheet.absoluteFillObject,
  },
  smartSetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  smartSetTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 },
  smartSetNumberPill: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  smartSetNumberText: { fontSize: 15, fontWeight: '900' },
  smartSetTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 7, minWidth: 0 },
  smartSetTitle: { fontSize: 15, fontWeight: '900' },
  smartSetNowPill: {
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: 7,
    paddingVertical: 2,
    flexShrink: 0,
  },
  smartSetNowPillText: { fontSize: 9, fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0.4 },
  smartSetSub: { fontSize: 11, fontWeight: '700', marginTop: 1 },
  smartSetDeleteBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tc.surface,
    borderWidth: 1,
    borderColor: tc.border,
  },
  smartStepperBlock: { gap: 6 },
  smartStepperLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  smartStepperLabel: { fontSize: 10, fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0.5 },
  smartStepperStepText: { fontSize: 10, fontWeight: '800' },
  smartStepperControls: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  smartStepBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tc.surface,
    borderWidth: 1,
    borderColor: tc.border,
  },
  smartStepBtnText: { fontSize: 12, fontWeight: '900', color: tc.textPrimary },
  smartValueInput: {
    flex: 1,
    minWidth: 0,
    height: 48,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: tc.primary + '66',
    backgroundColor: tc.surfaceRaised,
    color: tc.textPrimary,
    fontSize: 22,
    fontWeight: '900',
    textAlign: 'center',
    paddingHorizontal: 6,
  },
  smartQuickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  smartQuickChip: {
    minHeight: 32,
    paddingHorizontal: 10,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: tc.border,
    backgroundColor: tc.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smartQuickChipText: { fontSize: 11, color: tc.textSecondary, fontWeight: '900' },
  smartLogBtn: {
    minHeight: 48,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 12,
  },
  smartLogBtnText: { fontSize: 15, fontWeight: '900' },

  timerDisplay: { fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] as any, color: tc.textPrimary, minWidth: 52 },
  timerBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, alignItems: 'center' as const, justifyContent: 'center' as const },
  timerBtnText: { fontSize: 12, fontWeight: '700', color: '#FFFFFF' },

  // Full-screen timer modal — big digits, big buttons, minimal chrome
  timerModalRoot: { flex: 1 },
  timerModalExerciseName: {
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    letterSpacing: 0.3,
  },
  timerModalTargetReps: {
    fontSize: 14,
    fontWeight: '500',
    marginTop: 6,
    marginBottom: 32,
  },
  timerModalDigits: {
    fontSize: 96,
    fontWeight: '900',
    fontVariant: ['tabular-nums'] as any,
    letterSpacing: -2,
    marginBottom: 8,
  },
  timerModalStateHint: {
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 48,
    textAlign: 'center',
  },
  timerModalControls: {
    width: '100%',
    alignItems: 'center',
    marginBottom: 24,
  },
  timerModalBigBtn: {
    width: '100%',
    maxWidth: 320,
    paddingVertical: 22,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timerModalBigBtnText: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  timerModalSecondaryRow: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
    maxWidth: 320,
  },
  timerModalSecondaryBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
  },
  timerModalSecondaryBtnText: {
    fontSize: 15,
    fontWeight: '700',
  },

  setsLog: { gap: 6 },
  setRow:  { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: tc.border },
  setNum:  { fontSize: 12, color: tc.textMuted, width: 44 },
  setData: { flex: 1, fontSize: 13, fontWeight: '600', color: tc.textPrimary },
  setCheck:{ fontSize: 12, color: tc.primary, fontWeight: '700' },
  // `aiBubble` is reused by the RIR prompt — keep it. The other AI-tip
  // style entries (label/text/loading/error variant) were dropped along
  // with the in-card AI tip block; the rest-timer surface now owns the
  // recommendation display.
  aiBubble:      { flexDirection: 'row', alignItems: 'center', backgroundColor: tc.surfaceRaised, borderRadius: radius.md, padding: 12, borderLeftWidth: 3, borderLeftColor: tc.accent },
  aiErrorText:   { fontSize: 12, color: tc.error, flex: 1 },

  logSetBtn:     { backgroundColor: tc.primary, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' },
  logSetBtnText: { color: tc.background, fontSize: 15, fontWeight: '700' },

  doneRow:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 8, gap: 12 },
  doneText:     { fontSize: 13, color: tc.primary, fontWeight: '600' },
  addSetBtn:    { borderWidth: 1, borderColor: tc.primary, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 6 },
  addSetBtnText:{ fontSize: 13, color: tc.primary, fontWeight: '600' },

  finishBtn: {
    backgroundColor: tc.surface,
    borderRadius: radius.lg,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
    borderWidth: 1,
    borderColor: tc.primary,
    shadowOpacity: 0.22,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  finishBtnDisabled: { borderColor: tc.border, backgroundColor: tc.surfaceRaised, opacity: 0.55, shadowOpacity: 0, elevation: 0 },
  finishBtnText:     { fontSize: 16, fontWeight: '900', color: tc.background },
  finishBtnTextDisabled: { color: tc.textMuted },
  cancelOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: tc.background + 'CC',
    zIndex: 20,
  },
  cancelOverlayText: { fontSize: 12, fontWeight: '800' },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  logModal: {
    backgroundColor: tc.surface, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    padding: 24, paddingBottom: 40, gap: 16, borderTopWidth: 1, borderTopColor: tc.border,
  },
  logHandle:     { width: 36, height: 4, backgroundColor: tc.border, borderRadius: 2, alignSelf: 'center', marginBottom: 4 },
  logModalTitle: { fontSize: 18, fontWeight: '700', color: tc.textPrimary },
  logModalSub:   { fontSize: 13, color: tc.textSecondary, marginTop: -8 },
  logInputRow:   { flexDirection: 'row', gap: 12 },
  logInputWrap:  { flex: 1, gap: 6 },
  logInputLabel: { fontSize: 12, fontWeight: '600', color: tc.textSecondary },
  logInput: {
    borderWidth: 1, borderColor: tc.border, borderRadius: radius.md,
    padding: 14, fontSize: 28, fontWeight: '700', color: tc.textPrimary,
    backgroundColor: tc.background, textAlign: 'center',
  },
  logConfirmBtn:  { backgroundColor: tc.primary, borderRadius: radius.md, paddingVertical: 16, alignItems: 'center' },
  logConfirmText: { color: tc.background, fontSize: 16, fontWeight: '700' },

  lastTimeCard: {
    backgroundColor: tc.accent + '16',
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: tc.accent + '88',
    padding: 10,
    gap: 6,
  },
  lastTimeHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  lastTimeTitle: { fontSize: 12, fontWeight: '800', color: tc.accent, textTransform: 'uppercase', letterSpacing: 0.7 },
  lastTimeBest: { fontSize: 13, color: tc.textPrimary, fontWeight: '700' },
  lastTimeRow:      { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 3 },
  lastTimeSetNum:   { fontSize: 12, color: tc.textMuted, width: 40, fontWeight: '600' },
  lastTimeData:     { flex: 1, fontSize: 14, color: tc.textPrimary, fontWeight: '700' },
  lastTimeFeedback: { fontSize: 12, color: tc.accent, fontWeight: '700' },

  finishBackdrop:    { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center' },
  finishModal:       { backgroundColor: tc.surface, borderRadius: radius.xl, padding: 24, alignItems: 'center', gap: 12, borderWidth: 1, borderColor: tc.border, width: '88%', shadowColor: tc.primary, shadowOpacity: 0.18, shadowRadius: 20, shadowOffset: { width: 0, height: 12 }, elevation: 6 },
  finishIconWrap: { width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  finishModalTitle:  { fontSize: 26, fontWeight: '800', color: tc.textPrimary },
  finishModalBody:   { fontSize: 14, color: tc.textSecondary, textAlign: 'center', lineHeight: 20 },
  finishModalStats: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    backgroundColor: tc.surfaceRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: tc.border,
    paddingVertical: 12,
    marginTop: 2,
  },
  finishModalStat: { flex: 1, alignItems: 'center', gap: 2 },
  finishModalDivider: { width: 1, height: 30, backgroundColor: tc.border },
  finishModalStatValue: { fontSize: 17, fontWeight: '900', color: tc.textPrimary },
  finishModalStatLabel: { fontSize: 10, color: tc.textMuted, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  finishManualCard: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderColor: tc.border,
    borderRadius: radius.md,
    backgroundColor: tc.surfaceRaised,
    padding: 12,
    gap: 10,
  },
  finishManualHeader: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  finishManualIcon: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  finishManualTitle: { fontSize: 13, fontWeight: '900', color: tc.textPrimary },
  finishManualHint: { marginTop: 1, fontSize: 11, fontWeight: '700', color: tc.textMuted },
  finishIntensityRow: { flexDirection: 'row', gap: 6 },
  finishIntensityChip: {
    flex: 1,
    minHeight: 38,
    borderWidth: 1,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 6,
  },
  finishIntensityText: { fontSize: 11, fontWeight: '900' },
  finishManualInputGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  finishManualInputWrap: { flex: 1, minWidth: 82, gap: 5 },
  finishManualInputLabel: { fontSize: 10, fontWeight: '900', color: tc.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 },
  finishManualInput: {
    borderWidth: 1,
    borderColor: tc.border,
    borderRadius: radius.sm,
    backgroundColor: tc.background,
    color: tc.textPrimary,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    fontWeight: '800',
    textAlign: 'center',
  },
  finishConfirmBtn:  { backgroundColor: tc.primary, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', width: '100%', marginTop: 8 },
  finishConfirmLoadingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  finishConfirmText: { color: tc.background, fontSize: 16, fontWeight: '700' },
  finishCancelText:  { fontSize: 14, color: tc.textMuted, marginTop: 4 },

  summaryScroll: { flexGrow: 1, justifyContent: 'flex-end' },
  summaryModal: {
    backgroundColor: tc.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: 20,
    paddingBottom: 40,
    gap: 16,
    borderTopWidth: 1,
    borderTopColor: tc.border,
  },
  summaryCompletionHeader: {
    alignItems: 'center',
    gap: 4,
    marginTop: -2,
    marginBottom: -4,
  },
  summaryCompletionTitle: {
    fontSize: 19,
    fontWeight: '900',
    color: tc.textPrimary,
    textAlign: 'center',
  },
  summaryCompletionSub: {
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '700',
    color: tc.textMuted,
    textAlign: 'center',
    maxWidth: 280,
  },
  summaryTitle:    { fontSize: 22, fontWeight: '800', color: tc.textPrimary, textAlign: 'center' },
  summarySubtitle: { fontSize: 13, color: tc.textSecondary, textAlign: 'center' },
  summarySyncRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  summarySyncText: { flex: 1, fontSize: 12, color: tc.textSecondary, fontWeight: '700' },
  summaryLoadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, justifyContent: 'center', paddingVertical: 16 },
  summaryLoadingText: { fontSize: 13, color: tc.textSecondary },
  summaryCaloriesRow: {
    alignItems: 'center', paddingVertical: 10,
    backgroundColor: tc.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1, borderColor: tc.border,
  },
  summaryCaloriesValue: { fontSize: 38, fontWeight: '800', color: tc.primary },
  summaryCaloriesLabel: { fontSize: 12, color: tc.textSecondary, marginTop: -2 },
  summaryMotivation: {
    backgroundColor: tc.surfaceRaised,
    borderRadius: radius.md,
    padding: 14,
    gap: 4,
    borderWidth: 1,
    borderColor: tc.border,
    alignItems: 'center',
  },
  summaryMotivationText: { fontSize: 14, color: tc.textPrimary, lineHeight: 20, textAlign: 'center' },
  // Summary redesign
  summaryBackdrop:  { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'flex-end' },
  summaryHeaderBlock: { alignItems: 'center', gap: 4, paddingBottom: 4 },
  summaryEmoji:     { fontSize: 40, marginBottom: 4 },
  summaryStatsRow:  { flexDirection: 'row', alignItems: 'center', backgroundColor: tc.surfaceRaised, borderRadius: radius.md, borderWidth: 1, borderColor: tc.border, paddingVertical: 14 },
  summaryStat:      { flex: 1, alignItems: 'center', gap: 3 },
  summaryStatDivider: { width: 1, height: 32, backgroundColor: tc.border },
  summaryStatValue: { fontSize: 22, fontWeight: '800', color: tc.textPrimary },
  summaryStatLabel: { fontSize: 11, color: tc.textSecondary, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.4 },
  summaryMotivationIcon: { fontSize: 16, marginBottom: 4 },
  summaryShareIconRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 4,
  },
  summaryShareIconBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingVertical: 8,
  },
  summaryShareIconBtnText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.2 },
  summarySkipBtn:    { alignItems: 'center', paddingVertical: 10 },
  summarySkipText:   { fontSize: 13, color: tc.textMuted },
  summaryScoreCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: tc.surfaceRaised,
    borderWidth: 1,
    borderColor: tc.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  summaryScoreIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  summaryScoreTitle: { fontSize: 13, fontWeight: '900', color: tc.textPrimary },
  summaryScoreBody: { marginTop: 2, fontSize: 11, fontWeight: '700', color: tc.textMuted },

  // ── Shareable summary card ──
  shareCard: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    overflow: 'hidden',
    backgroundColor: '#050505',
  },
  shareCardBackgroundImage: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  shareCardScrim: {
    ...StyleSheet.absoluteFillObject,
  },
  shareCardContent: {
    minHeight: 390,
    padding: 14,
  },
  shareCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  shareCardLogo: { width: 130, height: 32 },
  shareCardDateBadge: {
    backgroundColor: 'rgba(0,0,0,0.42)',
    borderRadius: radius.full,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  shareCardDateText: { fontSize: 11, fontWeight: '800', color: '#fff' },
  shareHeroBody: { marginTop: 'auto', paddingTop: 96 },
  shareKickerPill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginBottom: 9,
  },
  shareKicker: {
    fontSize: 10,
    fontWeight: '900',
    color: '#fff',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  shareCardFocus: {
    fontSize: 31,
    fontWeight: '900',
    color: '#fff',
    lineHeight: 35,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  shareCompletionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    marginTop: 12,
    marginBottom: 8,
  },
  shareCompletionText: { fontSize: 11, color: 'rgba(255,255,255,0.78)', fontWeight: '800' },
  shareCompletionTrack: {
    height: 5,
    borderRadius: radius.full,
    backgroundColor: 'rgba(255,255,255,0.18)',
    overflow: 'hidden',
  },
  shareCompletionFill: {
    height: 5,
    borderRadius: radius.full,
  },
  shareVolumeHero: {
    marginTop: 12,
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  shareVolumeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  shareVolumeLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  shareVolumeLabel: {
    fontSize: 10,
    fontWeight: '900',
    color: 'rgba(255,255,255,0.7)',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
  shareVolumeValue: {
    fontSize: 30,
    fontWeight: '900',
    color: '#fff',
    lineHeight: 34,
  },
  shareVolumeDelta: {
    marginTop: 2,
    fontSize: 11,
    fontWeight: '900',
  },
  shareStatsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    marginTop: 10,
  },
  shareStatTile: {
    flex: 1,
    flexBasis: '31%',
    minWidth: 0,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    paddingVertical: 9,
    paddingHorizontal: 9,
    alignItems: 'flex-start',
    gap: 2,
  },
  shareStatTopRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 1,
  },
  shareStatToneDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  shareStatIcon:  { fontSize: 13, marginBottom: 1 },
  shareStatValue: { fontSize: 17, fontWeight: '900', color: '#fff', lineHeight: 21 },
  shareStatLabel: { fontSize: 9, fontWeight: '800', color: 'rgba(255,255,255,0.62)', textTransform: 'uppercase', letterSpacing: 0.4 },
  shareStatHint: { fontSize: 9, fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0.4 },
  shareRouteMapWrap: {
    marginTop: 12,
    borderRadius: radius.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  shareMiniMetrics: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 14,
    paddingBottom: 8,
  },
  shareMiniChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: tc.background + '80',
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: tc.border,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  shareMiniChipText: { fontSize: 10, color: tc.textMuted, fontWeight: '800' },
  shareMuscleLoad: {
    marginHorizontal: 14,
    marginTop: 4,
    marginBottom: 8,
    paddingTop: 10,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: tc.border,
  },
  shareMuscleLoadHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  shareMuscleLoadTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  shareMuscleLoadTitle: {
    fontSize: 10,
    fontWeight: '900',
    color: tc.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
  shareMuscleLoadSubtitle: { fontSize: 10, color: tc.textMuted, fontWeight: '700' },
  shareMuscleLoadRow: { gap: 4 },
  shareMuscleLoadRowTop: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
  },
  shareMuscleLoadName: { fontSize: 12, fontWeight: '800', color: tc.textPrimary },
  shareMuscleLoadMeta: {
    flex: 1,
    fontSize: 10,
    color: tc.textMuted,
    fontWeight: '700',
    textAlign: 'right',
  },
  shareMuscleLoadTrack: {
    height: 5,
    borderRadius: radius.full,
    backgroundColor: tc.border + '88',
    overflow: 'hidden',
  },
  shareMuscleLoadFill: {
    height: 5,
    borderRadius: radius.full,
  },
  shareAchievements: {
    marginHorizontal: 14,
    marginTop: 6,
    marginBottom: 8,
    backgroundColor: tc.primary + '10',
    borderRadius: radius.md,
    padding: 12,
    gap: 6,
    borderWidth: 1,
    borderColor: tc.primary + '30',
  },
  shareAchievementsTitle: {
    fontSize: 11,
    fontWeight: '800',
    color: tc.primary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  shareAchievementRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  shareAchievementBullet: { fontSize: 12, color: tc.primary, fontWeight: '700', lineHeight: 18 },
  shareAchievementText: { fontSize: 13, color: tc.textPrimary, fontWeight: '600', flex: 1, lineHeight: 18 },
  shareMotivation: {
    marginHorizontal: 14,
    marginBottom: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: tc.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: tc.border,
  },
  shareMotivationText: {
    fontSize: 13,
    fontStyle: 'italic',
    color: tc.textSecondary,
    textAlign: 'center',
    lineHeight: 19,
  },
  shareWatermark: {
    fontSize: 10,
    fontWeight: '800',
    color: 'rgba(255,255,255,0.68)',
    textAlign: 'center',
    paddingTop: 12,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },

  // ── Strava-style IG sticker (transparent, overlaid on user photo) ──
  // No background panel — bare text + a thin completion bar. White
  // text with a soft text-shadow so it stays legible on any photo.
  // Off-screen wrapper: positioned outside the visible viewport so
  // ViewShot can still measure + capture the card. left/top: -10000
  // is safer than display:'none' (which skips layout entirely).
  shareStickerOffscreen: {
    position: 'absolute',
    left: -10000,
    top: -10000,
    width: 360,
    height: 640,
  },
  // ViewShot host MUST be transparent so the captured PNG carries an
  // alpha channel — Instagram composites the sticker on top of the
  // user's photo, and any opaque fill would show as a rectangle.
  shareStickerHost: {
    width: 360,
    height: 640,
    backgroundColor: 'transparent',
  },
  shareStickerInner: {
    flex: 1,
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 16,
  },
  shareStickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  shareStickerLogo: { width: 130, height: 32 },
  shareStickerDate: {
    fontSize: 11,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: 0.4,
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  shareStickerKicker: {
    fontSize: 11,
    fontWeight: '900',
    color: tc.primary,
    textTransform: 'uppercase',
    letterSpacing: 1.4,
    marginBottom: 4,
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  shareStickerFocus: {
    fontSize: 30,
    fontWeight: '900',
    color: '#fff',
    letterSpacing: -0.6,
    lineHeight: 34,
    marginBottom: 18,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  shareStickerStatRow: {
    flexDirection: 'row',
    gap: 18,
    marginBottom: 18,
  },
  shareStickerStat: {
    alignItems: 'flex-start',
    gap: 1,
  },
  shareStickerStatValue: {
    fontSize: 26,
    fontWeight: '900',
    color: '#fff',
    lineHeight: 30,
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  shareStickerStatLabel: {
    fontSize: 10,
    fontWeight: '900',
    // Pure white — sticker text overlays the user's chosen photo, so
    // any alpha < 1 reads as "washed out" on bright backgrounds. The
    // text shadow + bold weight carry contrast on dark photos.
    color: '#fff',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  shareStickerExerciseList: {
    gap: 8,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.25)',
    marginTop: 2,
  },
  shareStickerExerciseRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 10,
    paddingTop: 6,
  },
  shareStickerExerciseName: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    fontSize: 14,
    fontWeight: '800',
    color: '#fff',
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  shareStickerExerciseSets: {
    flexShrink: 0,
    maxWidth: '55%',
    textAlign: 'right',
    fontSize: 12,
    fontWeight: '800',
    color: '#fff',
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  shareStickerOverflow: {
    fontSize: 11,
    fontWeight: '800',
    color: '#fff',
    fontStyle: 'italic',
    paddingTop: 2,
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  shareStickerWatermark: {
    fontSize: 11,
    fontWeight: '900',
    color: '#fff',
    textAlign: 'center',
    letterSpacing: 1.6,
    marginTop: 'auto',
    paddingTop: 12,
    textTransform: 'uppercase',
    textShadowColor: 'rgba(0,0,0,0.65)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },

  // Feedback form (post-workout)
  feedbackGroup:     { gap: 10 },
  feedbackGroupLabel: { fontSize: 13, fontWeight: '700', color: tc.textPrimary },
  feedbackOptional:  { fontSize: 12, color: tc.textMuted, fontWeight: '400' },
  fbFormRow:       { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  fbFormChip: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: tc.border,
    backgroundColor: tc.surfaceRaised,
    alignItems: 'center',
    minWidth: 72,
  },
  fbFormChipActive: {
    borderColor: tc.primary,
    backgroundColor: tc.primary + '20',
  },
  fbFormChipText:       { fontSize: 13, color: tc.textSecondary, fontWeight: '600', textAlign: 'center' },
  fbFormChipTextActive: { color: tc.primary },

  feedbackIntensityChip: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: tc.border,
    backgroundColor: tc.surfaceRaised,
    alignItems: 'center',
    minWidth: 56,
  },

  feedbackSorenessGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  feedbackSorenessChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderColor: tc.border,
    backgroundColor: tc.surfaceRaised,
  },
  feedbackSorenessChipActive: { borderColor: tc.warning, backgroundColor: tc.warning + '1A' },
  feedbackSorenessText:       { fontSize: 13, color: tc.textSecondary, fontWeight: '600' },
  feedbackSorenessTextActive: { color: tc.warning },

  feedbackNotesInput: {
    borderWidth: 1,
    borderColor: tc.border,
    borderRadius: radius.md,
    padding: 12,
    color: tc.textPrimary,
    backgroundColor: tc.background,
    fontSize: 13,
    lineHeight: 20,
    minHeight: 72,
    textAlignVertical: 'top',
  },

  feedbackSubmittingBlock: { alignItems: 'center', gap: 14, paddingVertical: 32 },
  feedbackSubmittingText:  { fontSize: 14, color: tc.textSecondary, textAlign: 'center', lineHeight: 20 },
  feedbackResultIcon:      { fontSize: 44 },
  feedbackResultTitle:     { fontSize: 20, fontWeight: '800', color: tc.success },
  feedbackResultText:      { fontSize: 13, color: tc.textSecondary, textAlign: 'center', lineHeight: 20 },

  coachSheet: {
    maxHeight: '82%',
    backgroundColor: tc.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderTopColor: tc.border,
    paddingTop: 14,
    paddingBottom: 12,
  },
  coachHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8 },
  coachTitle: { fontSize: 17, fontWeight: '700', color: tc.textPrimary },
  coachClose: { fontSize: 14, fontWeight: '700', color: tc.primary },
  coachHint: { fontSize: 12, color: tc.textSecondary, paddingHorizontal: 16, marginBottom: 8 },
  coachPromptRow: { gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  coachPromptChip: {
    borderWidth: 1,
    borderColor: tc.border,
    borderRadius: radius.full,
    backgroundColor: tc.surfaceRaised,
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  coachPromptChipText: { fontSize: 12, color: tc.textPrimary, fontWeight: '600' },
  coachActionRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, marginBottom: 8 },
  coachActionBtn: {
    flex: 1,
    backgroundColor: tc.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: tc.border,
    paddingVertical: 10,
    alignItems: 'center',
  },
  coachActionText: { fontSize: 12, fontWeight: '700', color: tc.primary },
  coachSubHint: { fontSize: 11, color: tc.textMuted, paddingHorizontal: 16, marginBottom: 6 },
  coachChatList: { paddingHorizontal: 16, paddingBottom: 10, gap: 8 },
  coachEmpty: {
    fontSize: 12,
    color: tc.textMuted,
    backgroundColor: tc.surfaceRaised,
    borderWidth: 1,
    borderColor: tc.border,
    borderRadius: radius.md,
    padding: 10,
  },
  coachBubble: { borderRadius: radius.md, borderWidth: 1, padding: 10 },
  coachBubbleUser: { backgroundColor: tc.primary, borderColor: tc.primary, alignSelf: 'flex-end', maxWidth: '90%' },
  coachBubbleAssistant: { backgroundColor: tc.surfaceRaised, borderColor: tc.border, alignSelf: 'flex-start', maxWidth: '95%' },
  coachBubbleImage: { width: 180, height: 180, borderRadius: radius.sm, marginBottom: 8, backgroundColor: tc.surfaceRaised },
  coachBubbleText: { fontSize: 13, color: tc.textPrimary },
  coachInputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 16, paddingTop: 8 },
  coachInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: tc.border,
    borderRadius: radius.md,
    paddingHorizontal: 10,
    paddingVertical: 8,
    maxHeight: 110,
    backgroundColor: tc.background,
    color: tc.textPrimary,
  },
  coachSendBtn: { backgroundColor: tc.primary, borderRadius: radius.md, minWidth: 64, paddingVertical: 11, alignItems: 'center', justifyContent: 'center' },
  coachSendText: { color: tc.background, fontSize: 13, fontWeight: '700' },
  coachAttachBtn: {
    width: 44, height: 44, borderRadius: radius.md, borderWidth: 1,
    borderColor: tc.border, backgroundColor: tc.background,
    alignItems: 'center', justifyContent: 'center',
  },
  coachPhotoStrip: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingTop: 8,
  },
  coachPhotoThumb: {
    width: 44, height: 44, borderRadius: radius.sm,
    backgroundColor: tc.surfaceRaised,
  },
  coachPhotoStripText: { flex: 1, fontSize: 12, color: tc.textSecondary },
  coachPhotoStripClear: { fontSize: 22, color: tc.textSecondary, paddingHorizontal: 8, fontWeight: '300' },
  addExerciseSearch: {
    // marginHorizontal moved to the SearchInput wrapper's containerStyle
    // so the clear (×) button — absolutely positioned against the
    // wrapper — sits inside the rounded border of the visible input.
    borderWidth: 1,
    borderColor: tc.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: tc.background,
    color: tc.textPrimary,
  },
  addExerciseList: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 16, gap: 8 },
  addExerciseFilterRow: { gap: 8, paddingBottom: 10 },
  addExerciseFilterChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: tc.border,
    backgroundColor: tc.surfaceRaised,
  },
  addExerciseFilterChipActive: { borderColor: tc.primary, backgroundColor: tc.primary + '12' },
  addExerciseFilterText: { fontSize: 12, color: tc.textSecondary, fontWeight: '600' },
  addExerciseFilterTextActive: { color: tc.primary },
  addExerciseResultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: -2,
    marginBottom: 10,
  },
  addExerciseResultText: { fontSize: 11, fontWeight: '700' },
  addExerciseResultClear: { fontSize: 12, fontWeight: '800' },
  addExerciseItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: tc.border,
    borderRadius: radius.md,
    backgroundColor: tc.surfaceRaised,
    padding: 12,
  },
  addExercisePreview: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tc.surface,
    borderWidth: 1,
    borderColor: tc.border,
  },
  addExercisePreviewImage: { width: '100%', height: '100%' },
  addExercisePreviewFallback: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tc.background,
  },
  addExercisePreviewBadge: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.62)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addExerciseName: { fontSize: 13, fontWeight: '700', color: tc.textPrimary, marginBottom: 2 },
  addExerciseMeta: { fontSize: 12, color: tc.textSecondary },
  addExerciseUse: { fontSize: 12, color: tc.primary, fontWeight: '700' },
}); }
