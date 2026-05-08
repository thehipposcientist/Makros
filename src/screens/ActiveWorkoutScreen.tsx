import React, { Fragment, useState, useEffect, useRef, useCallback, useMemo, useDeferredValue } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  TextInput, Modal, ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Vibration, Linking, Image, Keyboard,
  LayoutAnimation, UIManager, AppState, Animated, FlatList, InteractionManager,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import FadeInView from '../components/FadeInView';
import PressableScale from '../components/PressableScale';
import AnimatedNumber from '../components/AnimatedNumber';
import PRCelebrationModal from '../components/PRCelebrationModal';
import ShareWorkoutModal from '../components/ShareWorkoutModal';
import GearPickerModal from '../components/GearPickerModal';
import type { GearItem } from '../services/api';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

function configureLiveLayoutAnimation() {
  try {
    LayoutAnimation.configureNext(
      LayoutAnimation.create(
        120,
        LayoutAnimation.Types.easeInEaseOut,
        LayoutAnimation.Properties.opacity,
      ),
    );
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
const REST_RECOMMENDATION_TUTORIAL_KEY = 'tutorial_live_rest_recommendation_v1_seen';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as FileSystem from 'expo-file-system';
import ViewShot from 'react-native-view-shot';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle } from 'react-native-svg';
import { WorkoutDay, WorkoutSession, SessionExercise, CompletedSet, WorkoutSummary, AppThemeName, WorkoutFeeling, WorkoutIntensity, SavedWorkoutTemplate, UserProfile, PlannedSet } from '../types';
import { saveWorkoutSession, getLastSetsForExercise, dateKey, saveWorkoutSummary, updateWorkoutSummary, saveHealthSummary, saveHealthScore, isAppleHealthEnabled, loadWorkoutHistory, loadHealthSummary, savePreservedCompletedWorkout, getExerciseBests, loadWorkoutTemplates, upsertWorkoutTemplate, exerciseHistoryNamesMatch } from '../utils/workoutHistory';
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
import { getWeightRecommendation, logWorkoutDone, logWorkoutStarted, askWorkoutQuestion, analyzeWorkoutFormPhoto, getExercises, getWorkoutSummary, searchExerciseAI, AIExerciseResult, getAiWarmup, getPreSetRecommendation, syncInProgressWorkout, PRAchievement, getHRZones, HRZone, listWorkoutSessions, getHydration, logHydration, logHydrationDelta, type WorkoutPostSummary, type WorkoutSessionRecord, type WorkoutSessionExerciseRecord, type WorkoutSessionSetRecord } from '../services/api';
import { cleanAiText } from '../utils/aiText';
import { getExerciseImage } from '../utils/exerciseImages';
import { exerciseThumbSmall } from '../utils/exerciseThumb';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import * as Notifications from 'expo-notifications';
import SearchInput from '../components/SearchInput';
import FormVideoModal from '../components/FormVideoModal';
import EquipmentImageCard from '../components/EquipmentImageCard';
import StartCountdownOverlay from '../components/StartCountdownOverlay';
import WorkoutTimerModal, { TimerResult } from '../components/WorkoutTimerModal';
import { isWatchReachable } from '../utils/watchSync';
import { getActiveWatchSessionId, setActiveWatchSessionId } from '../utils/activeWatchSession';
import { drainActiveWatchCommands, setActiveWatchCommandConsumerMounted } from '../utils/watchCommandBacklog';
import { WatchBridge } from '../../modules/thallo-watch-bridge';
import { cancelRestNotifications, scheduleRestNotifications, configureWorkoutNotifications, ensureWorkoutNotificationPermission } from '../utils/restNotifications';
import { humanizeToken } from '../utils/exerciseGuide';
import { matchesExerciseSearch } from '../utils/exerciseSearch';
import { shouldHideWeight, shouldHideReps, formatDurationTarget, isGuideExercise } from '../utils/exerciseDisplay';
import { startRestActivity, updateRestActivity, getRestActivityState, endRestActivity, endAllActivities, getLastStartDiagnostic } from '../services/liveActivity';
import type { RestActivityState } from '../services/liveActivity';
import { exerciseEquipmentLabel, isExerciseUsableWithEquipment, MAX_SWAP_SCORE, rankWorkoutAddCandidates, scoreSwapCandidate, scoreWorkoutAddCandidate, workoutAddAlignmentPercent } from '../utils/swapScoring';
import { FREE_WORKOUT_TEMPLATE_LIMIT, canCreateWorkoutTemplate, tierOf } from '../utils/subscription';
import { buildWorkoutBestSetHighlights } from '../utils/workoutBestSets';
import { hrZoneColorHex, liveActivityHrZoneFields, zoneForHeartRate } from '../utils/hrZones';
import { clearManagedInterval, restartManagedInterval, useManagedInterval } from '../hooks/useManagedInterval';
import {
  distanceSuffix,
  formatWeight,
  lbsToUnit,
  unitToLbs,
  unitToMi,
  weightSuffix,
  type DistanceUnit,
  type WeightUnit,
} from '../utils/units';

/** Parse the top (ceiling) of a target rep string. Handles ranges like
 *  "8-12", AMRAP markers like "12+", singletons like "6", and junk.
 *  Returns null when we can't tell. */
function parseTargetRepMax(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw);
  const m = s.match(/(\d+)\s*[-–—]\s*(\d+)/);
  if (m) return parseInt(m[2], 10);
  const n = s.match(/(\d+)/);
  return n ? parseInt(n[1], 10) : null;
}

function profileAgeFromStoredProfile(profile: any): number | null {
  const age = Number(profile?.physicalStats?.age ?? profile?.age ?? profile?.profile?.age ?? null);
  return Number.isFinite(age) && age > 0 ? age : null;
}

function shouldPromptRir(actualReps: number, targetReps: string | number | null | undefined): boolean {
  const targetMax = parseTargetRepMax(targetReps);
  return targetMax != null && actualReps >= targetMax + 2;
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

function buildRirNextSetSuggestion(
  ex: SessionExercise,
  loggedSet: CompletedSet,
  rir: number,
  nextSetNumber: number,
  weightUnit: WeightUnit = 'lbs',
): { nextTarget: string; cue: string; watchText: string; fullText: string } | null {
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
    nextWeight = weight + increment;
    cue = 'You had room in reserve. Add a small jump if setup feels locked in.';
  } else {
    nextWeight = weight + increment;
    cue = 'That was clearly under target effort. Add load on the next set.';
  }
  const displayWeight = formatWeight(nextWeight, weightUnit, {
    precision: undefined,
  });
  const nextTarget = `Set ${nextSetNumber}: ${displayWeight} x ${targetReps}`;
  return {
    nextTarget,
    cue,
    watchText: `${displayWeight} x ${targetReps} - ${cue}`,
    fullText: `${nextTarget} — ${cue}`,
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
  gear?: Array<{ slug: string; name: string; category?: string; required?: boolean }> | null;
  primary_muscle?: string | null;
  secondary_muscles?: string[] | null;
  is_compound?: boolean | null;
  movement_pattern?: string | null;
  description?: string | null;
  image_url?: string | null;
  video_id?: string | null;
  is_custom?: boolean;
  aliases?: string[] | null;
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
  } as unknown as ExerciseLibraryItem;
}

type SmartSwapItem = ExerciseLibraryItem & { _overlap?: number; _alignment?: number; _fitScore?: number; _swapNotes?: string[] };
type ExerciseHistorySignal = { count: number; lastDate?: string };

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
  return exerciseHistoryNamesMatch(record.name, exercise.name);
}

function backendSetToCompletedSet(set: WorkoutSessionSetRecord, index: number): CompletedSet | null {
  if (set.completed === false) return null;
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
    setNumber: Number.isFinite(setNumber) && setNumber > 0 ? setNumber : index + 1,
    reps: Number.isFinite(reps) ? reps : 0,
    weightLbs: Number.isFinite(weightLbs) ? weightLbs : 0,
  };
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
        .map((set, idx) => backendSetToCompletedSet(set, idx))
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
  const localSets = await getLastSetsForExercise(exercise.name).catch(() => null);
  if (localSets && localSets.length > 0) return localSets;
  const sessions = await backendSessions().catch(() => []);
  return findLastSetsInBackendSessions(exercise, sessions, context) ?? [];
}

function exerciseSlotRole(ex: Partial<SessionExercise> | any): string {
  return String(ex?.slotRole ?? ex?.slot_role ?? ex?._role ?? '').toLowerCase();
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
  const thumbUri = exerciseThumbSmall(item as any);
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
          {thumbUri ? (
            <Image source={{ uri: thumbUri }} style={stylesRef.addExercisePreviewImage} resizeMode="cover" />
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
  weightLbs?: number;
  weightUnit?: WeightUnit;
  distanceUnit?: DistanceUnit;
  playStartCountdown?: boolean;
  onFinish: (session: WorkoutSession) => void;
  onCancel: () => void;
  onDislikeExercise?: (exerciseName: string) => void;
}

type ClearRestStateOptions = {
  pushToWatch?: boolean;
  endAllLiveActivities?: boolean;
};

type ExerciseTimerState = {
  running: boolean;
  baseElapsed: number;
  startedAt: number | null;
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function getTargetSetCount(targetSets: unknown): number {
  const parsed = Number(targetSets);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return 3;
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
  return Array.from({ length: getTargetSetCount(ex.targetSets) }, (_, n): PlannedSet => ({
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

const TIMED_EXERCISE_RE = /treadmill|stationary bike|elliptical|rowing machine|stair climber|assault bike|battle ropes|jump rope|sprint|jogging|running|cycling|swimming|hiit|intervals|mountain climber|hill sprint|cardio|plank|dead hang|wall sit|hollow.?hold|l.?sit|\bwalk\b|walking|boxing|kickboxing|sparring|bag.?work|shadow.?box|yoga|vinyasa|hot.?yoga|power.?yoga|yin.?yoga|mobility.?flow|stretching/i;
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
  if (/treadmill|stationary bike|elliptical|rowing machine|stair climber|assault bike|jogging|running|cycling|swimming|zone ?2|tempo|steady state|long run|\bwalk\b|walking|boxing|kickboxing|sparring|bag.?work|shadow.?box|yoga|vinyasa|hot.?yoga|power.?yoga|yin.?yoga|mobility.?flow|stretching/.test(lowered)) {
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
    equipment: exerciseEquipmentLabel(item) ?? item.equipment ?? 'bodyweight',
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
  if (/boxing|kickboxing|sparring|bag.?work|shadow.?box/.test(n)) {
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

function getExerciseWarmupNote(exerciseName: string, isFirst: boolean, opts?: { isCompound?: boolean }): string | null {
  const name = exerciseName.toLowerCase();
  // Prefer structured is_compound field; fall back to name-based regex for old cached plans
  const isCompound = opts?.isCompound ??
    /squat|deadlift|bench press|overhead press|ohp|barbell press|pull.up|row|lunge|hip thrust|clean|snatch/.test(name);
  if (!isCompound && !isFirst) return null;
  if (/squat/.test(name)) return 'Warm-up: 2–3 ramp-up sets — e.g. bar × 10, 50% × 8, 70% × 5 before working weight';
  if (/deadlift/.test(name)) return 'Warm-up: 2–3 light singles — e.g. 40% × 5, 60% × 3, 80% × 1 before working sets';
  if (/bench/.test(name)) return 'Warm-up: 2–3 ramp-up sets — e.g. bar × 15, 50% × 8, 70% × 5 before working weight';
  if (/overhead press|ohp/.test(name)) return 'Warm-up: 2 ramp-up sets — e.g. bar × 10, 60% × 6 before working weight';
  if (isFirst) return 'Warm-up: 1–2 lighter sets recommended before starting working weight';
  return null;
}

// Focus keyword → warmup step pool mapping for buildWarmupPlan.
// Avoids a regex chain; keys are checked with simple string inclusion.
const WARMUP_POOLS: Record<string, string[]> = {
  lower: ['3 min easy bike or walk', 'Hip circles + ankle rocks (10 each)', 'Bodyweight squats × 10'],
  leg:   ['3 min easy bike or walk', 'Hip circles + ankle rocks (10 each)', 'Bodyweight squats × 10'],
  glute: ['3 min easy bike or walk', 'Hip circles + ankle rocks (10 each)', 'Bodyweight squats × 10'],
  hinge: ['3 min easy bike or walk', 'Hip circles + ankle rocks (10 each)', 'Bodyweight squats × 10'],
  pull:  ['3 min light cardio', 'Band pull-aparts × 15', 'Scap push-ups × 10'],
  back:  ['3 min light cardio', 'Band pull-aparts × 15', 'Scap push-ups × 10'],
  push:  ['3 min light cardio', 'Arm circles + band dislocates × 10', 'Push-ups × 10'],
  chest: ['3 min light cardio', 'Arm circles + band dislocates × 10', 'Push-ups × 10'],
  shoulder: ['3 min light cardio', 'Arm circles + band dislocates × 10', 'Push-ups × 10'],
  upper: ['3 min light cardio', 'Arm circles + band dislocates × 10', 'Push-ups × 10'],
};
const WARMUP_DEFAULT_POOL = ['2 min light cardio', 'Dynamic stretches for major joints'];

function buildWarmupPlan(workout: WorkoutDay): string[] {
  const focus = (workout.focus || '').toLowerCase();
  const stimulus = (workout.stimulus || '').toLowerCase();
  const exCount = workout.exercises.length;
  const firstEx = workout.exercises[0];
  const firstExName = firstEx?.name || '';
  const firstLo = firstExName.toLowerCase();
  // Use the structured is_compound field from the first exercise when available
  const firstIsCompound = (firstEx as any)?.is_compound ?? (firstEx as any)?.isCompound;
  const isHeavyCompound = firstIsCompound === true ||
    (firstIsCompound == null && /squat|deadlift|bench|overhead press|ohp|barbell press|clean|snatch|hip thrust/.test(firstLo));

  // Recovery / mobility days don't need a warmup at all — the session
  // IS the warmup. Show one prep line and move on.
  // Check stimulus field first, then focus keywords.
  if (stimulus === 'recovery' || stimulus === 'mobility' || /recovery|mobility|stretch/.test(focus)) {
    return ['Move slowly through the first round to warm up.'];
  }

  // Step pool per focus — match against the mapping keys.
  // The first matching key wins.
  let pool: string[] | undefined;
  for (const key of Object.keys(WARMUP_POOLS)) {
    if (focus.includes(key)) {
      pool = WARMUP_POOLS[key];
      break;
    }
  }
  if (!pool) pool = WARMUP_DEFAULT_POOL;

  // Session-length scaling: short sessions get a tighter warmup so we
  // don't burn 8 of 30 minutes on prep. Heavy compound first lift
  // always gets the ramp-up appended regardless of length.
  let prepCount: number;
  if (exCount <= 3) prepCount = 1;
  else if (exCount <= 5) prepCount = 2;
  else prepCount = pool.length;

  const steps = pool.slice(0, prepCount);
  if (firstExName) {
    steps.push(isHeavyCompound ? `2-3 ramp-up sets of ${firstExName}` : `1 light set of ${firstExName}`);
  }
  return steps;
}

const SHARE_LOGO_LIGHT = require('../../assets/images/thallo-logo-black.png');
const SHARE_LOGO_DARK  = require('../../assets/images/thallo-logo-white-transparent-New.png');

function workoutExerciseToSessionExercise(ex: any): SessionExercise {
  return {
    name: ex.name,
    targetSets: ex.sets,
    targetReps: ex.reps,
    targetRestSeconds: ex.restSeconds,
    equipment: typeof ex.equipment === 'string' ? ex.equipment : String(ex.equipment),
    sets: [],
    aiRecommendation: undefined,
    image_url: ex.image_url,
    video_id: ex.video_id ?? null,
    targetWeightLbs: ex.targetWeightLbs ?? null,
    setScheme: Array.isArray(ex.setScheme) ? ex.setScheme : Array.isArray(ex.set_scheme) ? ex.set_scheme : null,
    slug: ex.slug ?? ex.exerciseSlug ?? null,
    primaryMuscle: ex.primary_muscle ?? ex.primaryMuscle ?? ex._primary_muscle ?? null,
    secondaryMuscles: ex.secondary_muscles ?? ex.secondaryMuscles ?? ex._secondary_muscles ?? [],
    muscles_targeted: ex.muscles_targeted ?? undefined,
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
    targetWeightLbs: saved?.targetWeightLbs,
    setScheme: saved?.setScheme ?? saved?.set_scheme,
    slug: saved?.slug,
    primaryMuscle: saved?.primaryMuscle ?? saved?.primary_muscle,
    secondaryMuscles: saved?.secondaryMuscles ?? saved?.secondary_muscles,
    muscles_targeted: saved?.muscles_targeted,
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
    sets: Array.isArray(saved?.sets) ? saved.sets.filter(Boolean) : fallback.sets,
    aiRecommendation: typeof saved?.aiRecommendation === 'string' ? saved.aiRecommendation : fallback.aiRecommendation,
    image_url: saved?.image_url ?? fallback.image_url,
    video_id: saved?.video_id ?? fallback.video_id ?? null,
    targetWeightLbs: exerciseNameChanged ? null : saved?.targetWeightLbs ?? fallback.targetWeightLbs ?? null,
    setScheme: exerciseNameChanged ? null : Array.isArray(saved?.setScheme) ? saved.setScheme : Array.isArray(saved?.set_scheme) ? saved.set_scheme : fallback.setScheme ?? null,
    slug: restoredSlug,
    primaryMuscle: saved?.primaryMuscle ?? saved?.primary_muscle ?? fallback.primaryMuscle ?? null,
    secondaryMuscles: saved?.secondaryMuscles ?? saved?.secondary_muscles ?? fallback.secondaryMuscles ?? [],
    muscles_targeted: saved?.muscles_targeted ?? fallback.muscles_targeted,
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
    aiRecommendation: ex.aiRecommendation,
    image_url: ex.image_url,
    video_id: ex.video_id,
    targetWeightLbs: ex.targetWeightLbs,
    setScheme: ex.setScheme ?? null,
    slug: ex.slug,
    primaryMuscle: ex.primaryMuscle ?? ex.primary_muscle ?? null,
    secondaryMuscles: ex.secondaryMuscles ?? ex.secondary_muscles ?? [],
    muscles_targeted: ex.muscles_targeted,
    isCompound: ex.isCompound ?? null,
    slotRole: ex.slotRole,
    slotLabel: ex.slotLabel,
    prescriptionType: ex.prescriptionType,
    weightRecommendationSource: ex.weightRecommendationSource,
  };
}

export default function ActiveWorkoutScreen({ authToken, workout, goal, themeName, weightLbs = 150, weightUnit = 'lbs', distanceUnit = 'mi', playStartCountdown = false, onFinish, onCancel, onDislikeExercise }: ActiveWorkoutScreenProps) {
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
    // Mirror warmupSteps into a ref so the once-mounted watch-sync
    // effect can always send the freshest steps (AI warmup resolves
    // async after the initial push).
    const warmupStepsRef = useRef<string[]>(warmupSteps);
    useEffect(() => { warmupStepsRef.current = warmupSteps; }, [warmupSteps]);
    const authTokenRef = useRef(authToken);
    useEffect(() => { authTokenRef.current = authToken; }, [authToken]);
    const startTime = useRef(Date.now());
    // Show the 3-2-1 countdown only on a true fresh start. If we find a
    // persisted start time on mount, the user is resuming after a
    // background / app restart and the countdown would be jarring.
    const [showStartCountdown, setShowStartCountdown] = useState(
      () => playStartCountdown,
    );
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
    }, [authToken, workout.day, workout.focus, cachedProfileIsPro, loadCachedProfile, showStartCountdown]);
  const theme = getTheme(themeName);
  const themeColors = theme.colors;
  const workoutPalette = theme.sections.workout;
  const styles = useMemo(() => createStyles(themeColors), [themeName]);
  // Track paired/reachable state for the header. The root start handler
  // owns the watchOS launch request and schedules it after the local
  // countdown so a watch-connection prompt cannot interrupt the overlay.
  const [watchStatus, setWatchStatus] = useState<{ paired: boolean; reachable: boolean } | null>(null);
  const watchSessionId = useRef(getActiveWatchSessionId() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const [watchSessionHydrated, setWatchSessionHydrated] = useState(false);
  const [activeWorkoutStateRestored, setActiveWorkoutStateRestored] = useState(false);
  const watchWorkoutEndedRef = useRef(false);
  const lastActiveWatchReachabilityPushAtRef = useRef(0);
  const activeSnapshotAutoKeyRef = useRef<string>('');
  const lastActiveSnapshotAutoKeyPushedRef = useRef<string | null>(null);
  const cancelingWorkoutRef = useRef(false);
  const [cancelingWorkout, setCancelingWorkout] = useState(false);
  const buildWatchWorkoutSnapshotRef = useRef<() => any>(() => workout as any);
  // Persist start time so elapsed timer survives app restart
  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem('activeWorkoutStartTime'),
      AsyncStorage.getItem('activeWorkoutSets'),
      AsyncStorage.getItem('activeWatchSessionId'),
    ]).then(([savedStart, savedSetsRaw, savedSessionIdRaw]) => {
      const savedStartMs = savedStart ? parseInt(savedStart, 10) : NaN;
      const hasValidSavedStart = Number.isFinite(savedStartMs) && savedStartMs > 0;
      let hasLoggedSets = false;
      try {
        const savedSets = savedSetsRaw ? JSON.parse(savedSetsRaw) : [];
        hasLoggedSets = Array.isArray(savedSets)
          && savedSets.some((row: any) => Array.isArray(row?.sets) && row.sets.length > 0);
      } catch {
        hasLoggedSets = false;
      }
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
      if (hasValidSavedStart && (hasLoggedSets || isSameProcessEmptyStart)) {
        setShowStartCountdown(hasLoggedSets || isWatchInitiatedEmptyStart ? false : playStartCountdown);
        startTime.current = savedStartMs;
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
      }
      AsyncStorage.setItem('activeWorkoutStartTime', String(startTime.current)).catch(() => {});
      AsyncStorage.setItem('activeWatchSessionId', watchSessionId.current).catch(() => {});
      setWatchSessionHydrated(true);
      // Brand-new mount without a pre-seeded session — use the local
      // session id and play the countdown for phone starts. Same-process
      // phone/watch starts reuse their pre-seeded session above.
      setShowStartCountdown(playStartCountdown);
    }).catch(() => {
      startTime.current = Date.now();
      setActiveWatchSessionId(watchSessionId.current);
      AsyncStorage.setItem('activeWorkoutStartTime', String(startTime.current)).catch(() => {});
      AsyncStorage.setItem('activeWatchSessionId', watchSessionId.current).catch(() => {});
      setWatchSessionHydrated(true);
      setShowStartCountdown(playStartCountdown);
    });
    // Pre-load the rest-timer chime so the first set's countdown
    // end fires the audio without a few-hundred-ms decode delay.
    // Idempotent across remounts.
    import('../utils/feedback').then(f => f.preloadRestTimerSound()).catch(() => {});
    return () => {
      if (watchWorkoutEndedRef.current) setActiveWatchSessionId(null);
    };
  }, []);
  // Fetch HR zones for cardio prescriptions, live display, and watch sync.
  useEffect(() => {
    if (!authToken || showStartCountdown) return;
    let cancelled = false;
    (async () => {
      if (!(await cachedProfileIsPro()) || cancelled) return;
      readHealthSummary?.().then?.((hs: any) => {
        if (cancelled) return;
        getHRZones(authToken, hs?.restingHeartRate, hs?.vo2Max)
          .then(r => { if (!cancelled) setHrZones(r.zones); })
          .catch(() => {});
      }).catch(() => {
        if (!cancelled) {
          getHRZones(authToken)
            .then(r => { if (!cancelled) setHrZones(r.zones); })
            .catch(() => {});
        }
      });
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
        const pushActive = () => {
          if (!token.cancelled) setWatchSyncing(true);
          const snapshotKey = activeSnapshotAutoKeyRef.current;
          return pushWorkoutToWatch(buildWatchWorkoutSnapshotRef.current(), {
            dateISO: dateKey(new Date()),
            status: 'active',
            sessionId: watchSessionId.current,
            warmupSteps: warmupStepsRef.current,
            reason: 'active_snapshot',
          })
            .then(async (ok) => {
              if (ok && snapshotKey) {
                lastActiveSnapshotAutoKeyPushedRef.current = snapshotKey;
              }
              await pushRestProgressToWatchRef.current();
              reassertRestProgressToWatchRef.current();
            })
            .catch(() => {})
            .finally(() => {
              if (!token.cancelled) setWatchSyncing(false);
            });
        };
        // Initial push on mount, but kicked off via setTimeout so the
        // current JS tick can settle (rendering, timer state init, etc.)
        // before we start the bridge call. This is the difference
        // between "watch syncs eventually" (good) and "first set tap
        // feels sluggish for 600ms" (bad).
        setTimeout(() => {
          if (!token.cancelled) { pushActive(); }
        }, 250);
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
            pushActive();
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
            (async () => {
              try {
                const { pushWorkoutToWatch } = await import('../utils/watchSync');
                await pushWorkoutToWatch(buildWatchWorkoutSnapshotRef.current(), {
                  dateISO: dateKey(new Date()),
                  status: 'active',
                  sessionId: watchSessionId.current,
                  warmupSteps: warmupStepsRef.current,
                  reason: 'pull_state',
                  force: forcePull,
                });
                await pushRestProgressToWatchRef.current();
                reassertRestProgressToWatchRef.current();
              } catch { /* bridge optional */ }
            })();
            return;
          }
          if (command === 'log_hydration') {
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
                const saved = fresh ?? {
                  date: result.date,
                  ounces: result.ounces,
                  target_ounces: 64,
                };
                const { pushHydrationToWatch } = await import('../utils/watchSync');
                await pushHydrationToWatch({
                  dateISO: saved.date,
                  ounces: saved.ounces,
                  targetOunces: saved.target_ounces,
                  force: true,
                });
              } catch { /* hydration sync should not interrupt the workout */ }
            })();
            return;
          }
          if (!commandMatchesCurrentSession(command, payload)) return;
          if (activeWorkoutCommands.has(command) && !rememberWatchCommandId(payload)) return;
          if (command === 'log_set') {
            const exIdx = Number(payload?.exerciseIndex ?? -1);
            const incomingSetNumber = Number(payload?.setNumber ?? NaN);
            const weight = payload?.weightLbs;
            const reps = payload?.reps;
            const rir = Number(payload?.rir ?? NaN);
            const durationSeconds = Number(payload?.durationSeconds ?? NaN);
            const actionAtMs = Number(payload?.tsMs ?? NaN);
            watchLogSetChainRef.current = watchLogSetChainRef.current
              .catch(() => undefined)
              .then(async () => {
                if (exIdx < 0 || !Number.isFinite(exIdx)) return;
                const exs = exercisesRef.current;
                if (!exs[exIdx]) return;
                // Prefer the watch's explicit set number so delayed or
                // transferUserInfo-delivered commands still land in the
                // intended slot instead of whatever is currently next.
                const slot = Number.isFinite(incomingSetNumber) && incomingSetNumber > 0
                  ? Math.max(0, Math.floor(incomingSetNumber) - 1)
                  : exs[exIdx].sets.length;
                Promise.resolve(handleLogSetInlineRef.current(
                  exIdx,
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
          } else if (command === 'end_workout') {
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
  }, [cachedProfileIsPro, rememberWatchCommandId, showStartCountdown]);

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
  const [postRestIdleSecs, setPostRestIdleSecs] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [liveHR, setLiveHR] = useState<number | null>(null);
  const [hrZones, setHrZones] = useState<HRZone[]>([]);
  const currentLiveHRZone = useMemo(() => zoneForHeartRate(liveHR, hrZones), [hrZones, liveHR]);
  const currentLiveActivityHrFields = useMemo(() => liveActivityHrZoneFields(liveHR, hrZones), [hrZones, liveHR]);

  useEffect(() => {
    if (Object.keys(currentLiveActivityHrFields).length === 0) return;
    const activityId = liveActivityIdRef.current;
    if (!activityId) return;
    updateRestActivity(activityId, currentLiveActivityHrFields).catch(() => undefined);
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
  // Debounced backend sync of the in-progress workout. Fires 1.5s after the
  // last set-update to avoid spamming the server mid-rapid-logging. Writes
  // to WorkoutSession + per-exercise tables so per-set detail survives a
  // force-quit or an AsyncStorage wipe.
  const syncDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSyncedSetCountRef = useRef(0);
  const syncPartialToBackend = useCallback((sessionExercises: SessionExercise[]) => {
    if (!authToken) return;
    const hasLoggedSet = sessionExercises.some(ex => ex.sets.length > 0);
    if (!hasLoggedSet) return;
    const totalSets = sessionExercises.reduce((t, ex) => t + ex.sets.length, 0);
    if (totalSets - lastSyncedSetCountRef.current < 3) return;
    if (syncDebounceRef.current) clearTimeout(syncDebounceRef.current);
    syncDebounceRef.current = setTimeout(() => {
      lastSyncedSetCountRef.current = totalSets;
      const payload = sessionExercises
        .filter(ex => ex.sets.length > 0)
        .map((ex, i) => ({
          name: ex.name,
          target_sets: typeof ex.targetSets === 'number' ? ex.targetSets : undefined,
          target_reps: ex.targetReps,
          equipment: ex.equipment,
          primary_muscle: ex.primaryMuscle ?? ex.primary_muscle ?? null,
          secondary_muscles: ex.secondaryMuscles ?? ex.secondary_muscles ?? null,
          is_compound: ex.isCompound ?? null,
          order_index: i,
          sets: ex.sets.map(s => ({
            set_number: s.setNumber,
            reps: s.reps,
            weight_lbs: s.weightLbs,
            duration_seconds: s.durationSeconds ?? null,
            comfort_rating: s.comfortRating ?? null,
            feedback: s.feedback ?? null,
            rir: s.rir ?? null,
            heart_rate_avg: s.heartRateAvg ?? null,
          })),
        }));
      syncInProgressWorkout(authToken, dateKey(new Date()), workout.focus, payload)
        .then(r => console.log(`[workout sync] ${r.exercises} ex / ${r.sets} sets → backend`))
        .catch(e => console.warn('[workout sync] failed (non-fatal):', e?.message ?? e));
    }, 1500);
  }, [authToken, workout.focus]);

  const setExercises = useCallback((updater: SessionExercise[] | ((prev: SessionExercise[]) => SessionExercise[])) => {
    const prev = exercisesRef.current;
    const next = typeof updater === 'function'
      ? (updater as (prev: SessionExercise[]) => SessionExercise[])(prev)
      : updater;
    exercisesRef.current = next;
    // Auto-save session state so it survives app backgrounding/kill.
    AsyncStorage.setItem('activeWorkoutSets', JSON.stringify(
      next.map((ex, exerciseIndex) => serializeActiveWorkoutExercise(ex, exerciseIndex))
    )).catch(() => {});
    // Also debounce-sync to the backend so per-set detail isn't local-only.
    syncPartialToBackend(next);
    setExercisesRaw(next);
  }, [syncPartialToBackend]);

  useEffect(() => {
    return () => { if (syncDebounceRef.current) clearTimeout(syncDebounceRef.current); };
  }, []);

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
        console.log(`[ActiveWorkout] restored ${saved.filter(s => Array.isArray(s.sets) && s.sets.length > 0).length} exercises with logged sets`);
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
    (async () => {
      try {
        if (!(await cachedProfileIsPro())) return;
        const { getWeightRecommendation } = await import('../services/api');
        const targets = exercises
          .map((ex, i) => ({ ex, i }))
          .filter(({ ex }) =>
            (ex.weightRecommendationSource === 'default' || !ex.weightRecommendationSource)
            && (!ex.sets || ex.sets.length === 0)
            && !shouldHideWeight({ name: ex.name, equipment: ex.equipment, reps: ex.targetReps })
          );
        if (!targets.length) return;
        const results = await Promise.allSettled(
          targets.map(({ ex }) => getWeightRecommendation(
            authToken, ex.name, goal,
            [],  // no logged sets — first time
            1,   // setNumber 1
            {
              targetSets: typeof ex.targetSets === 'number' ? ex.targetSets : undefined,
              targetReps: ex.targetReps,
              experienceLevel: 'intermediate',
              exerciseSlug: ex.slug ?? undefined,
              equipment: ex.equipment,
              primaryMuscle: ex.primaryMuscle ?? undefined,
              plannedTargetWeightLbs: ex.targetWeightLbs ?? undefined,
            },
          )),
        );
        if (cancelled) return;
        const updates: Record<number, number> = {};
        results.forEach((r, k) => {
          if (r.status === 'fulfilled' && r.value && typeof r.value.weightLbs === 'number' && r.value.weightLbs > 0) {
            updates[targets[k].i] = r.value.weightLbs;
          }
        });
        if (Object.keys(updates).length === 0) return;
        setExercises(prev => prev.map((ex, i) =>
          i in updates
            ? { ...ex, targetWeightLbs: updates[i], weightRecommendationSource: 'default' }
            : ex,
        ));
        console.log(`[ActiveWorkout] deterministic weight refresh: ${Object.keys(updates).length}/${targets.length} exercises updated`);
      } catch (e) {
        console.log('[ActiveWorkout] deterministic weight refresh failed (non-fatal):', e);
      }
    })();
    return () => { cancelled = true; };
    // Run once after the start countdown — we don't want this firing every state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showStartCountdown]);

  const [activeExIdx, setActiveExIdx] = useState<number>(0);
  const activeExIdxRef = useRef(activeExIdx);
  useEffect(() => { activeExIdxRef.current = activeExIdx; }, [activeExIdx]);
  const [formVideoExerciseName, setFormVideoExerciseName] = useState<string | null>(null);
  const [formVideoContext, setFormVideoContext] = useState<{
    equipment?: string | null;
    primaryMuscle?: string | null;
    movementPattern?: string | null;
  }>({});
  const openFormVideoForExercise = useCallback((exercise: {
    name?: string | null;
    equipment?: string | null;
    primaryMuscle?: string | null;
    primary_muscle?: string | null;
    movementPattern?: string | null;
    movement_pattern?: string | null;
  } | null | undefined) => {
    if (!exercise?.name) return;
    setFormVideoContext({
      equipment: exercise.equipment ?? null,
      primaryMuscle: exercise.primaryMuscle ?? exercise.primary_muscle ?? null,
      movementPattern: exercise.movementPattern ?? exercise.movement_pattern ?? null,
    });
    setFormVideoExerciseName(exercise.name);
  }, []);
  // When the user hits or exceeds the top of the target rep range, prompt
  // them for RIR (reps in reserve) so the progression engine knows how
  // much more intensity to push next session. Only shown on over-target
  // sets — under-target sets already tell us they hit failure.
  const [pendingRir, setPendingRir] = useState<{ exIdx: number; setIdx: number } | null>(null);
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
  // the structured recommendation from /ai/pre-set-recommendation.
  const [preSetHints, setPreSetHints] = useState<Record<number, {
    rationale: string;
    setType: string;
    intensityLabel: string;
    recommendedWeight: number | null;
    recommendedReps: string;
    confidence: 'high' | 'medium' | 'low';
  }>>({});
  const [preSetLoadingIdx, setPreSetLoadingIdx] = useState<number | null>(null);

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
    setPreSetLoadingIdx(activeExIdx);
    (async () => {
      try {
        const lastSets = await loadLastSetsForExerciseAnySource(ex, loadBackendWorkoutHistory, {
          workoutDate: dateKey(new Date()),
          focus: workout.focus,
        });
        const plannedSets = plannedSetsForLiveRecommendation(ex);
        const rec = await getPreSetRecommendation(authToken, {
          exerciseName: ex.name,
          exerciseSlug: ex.slug ?? undefined,
          plannedSetNumber: 1,
          plannedSets,
          priorSetsThisSession: [],
          lastSessionSets: (lastSets ?? []).map(s => ({ reps: s.reps, weightLbs: s.weightLbs })),
          goal,
          equipment: typeof ex.equipment === 'string' ? ex.equipment : undefined,
          primaryMuscle: ex.primaryMuscle ?? undefined,
          weightLbs,
        });
        if (cancelled) return;
        setPreSetHints(prev => ({
          ...prev,
          [activeExIdx]: {
            rationale: rec.rationaleShort,
            setType: rec.setType,
            intensityLabel: rec.intensityLabel,
            recommendedWeight: rec.recommendedWeightLbs,
            recommendedReps: rec.recommendedReps,
            confidence: rec.confidence,
          },
        }));
      } catch {
        // silent — hint is additive, absence is fine
      } finally {
        if (!cancelled) {
          setPreSetLoadingIdx(prev => prev === activeExIdx ? null : prev);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [activeExIdx, exercises, authToken, goal, weightLbs, workout.focus, workout.stimulus, preSetHints, loadBackendWorkoutHistory, showStartCountdown]);

  // Inline set inputs: keyed by "exIdx-setSlot" (0-based slot index)
  const [setInputs, setSetInputs] = useState<Record<string, { weight: string; reps: string; duration: string }>>({});

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

  const getEffectiveTargetSetCount = useCallback((exIdx: number, exercise?: SessionExercise, minCount = 0) => {
    const ex = exercise ?? exercises[exIdx];
    if (!ex) return minCount;
    const base = getTargetSetCount(ex.targetSets);
    const extras = extraSetCounts[exIdx] ?? 0;
    const removed = removedSetCounts[exIdx] ?? 0;
    return Math.max(base + extras - removed, minCount);
  }, [exercises, extraSetCounts, removedSetCounts]);

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

  const clearLiveRecommendationState = useCallback((exIdx: number, opts?: { preserveNextTarget?: boolean }) => {
    setExercises(prev => prev.map((e, i) => i === exIdx ? { ...e, aiRecommendation: undefined } : e));
    if (!opts?.preserveNextTarget) setRestNextTarget(null);
    setRestCue(null);
    setAiErrorIdx(null);
  }, [setExercises]);
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

  // Track whether we've sent the "workout started" signal to the backend
  const workoutStartedRef = useRef(false);

  // Auto rest timer between sets
  const [restRemaining, setRestRemaining] = useState(0);
  const [restForExercise, setRestForExercise] = useState<string | null>(null);
  const [restCue, setRestCue] = useState<string | null>(null);
  const [restNextTarget, setRestNextTarget] = useState<string | null>(null);
  const [showRestRecommendationTutorial, setShowRestRecommendationTutorial] = useState(false);
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
  useEffect(() => {
    if (restRemaining <= 0) {
      setShowRestRecommendationTutorial(false);
      return;
    }
    if (!restNextTarget && !restCue) return;
    let cancelled = false;
    AsyncStorage.getItem(REST_RECOMMENDATION_TUTORIAL_KEY)
      .then(seen => {
        if (!seen && !cancelled) setShowRestRecommendationTutorial(true);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [restCue, restNextTarget, restRemaining]);
  const dismissRestRecommendationTutorial = useCallback(() => {
    setShowRestRecommendationTutorial(false);
    AsyncStorage.setItem(REST_RECOMMENDATION_TUTORIAL_KEY, String(Date.now())).catch(() => undefined);
  }, []);

  const buildWatchPositionProgress = useCallback(() => {
    const exerciseName = restExerciseNameRef.current;
    const exerciseIndex = exerciseName
      ? exercisesRef.current.findIndex(ex => ex.name === exerciseName)
      : activeExIdxRef.current;
    const exercise = exerciseIndex >= 0 ? exercisesRef.current[exerciseIndex] : undefined;
    const targetSetCount = exercise && exerciseIndex >= 0
      ? getEffectiveTargetSetCount(exerciseIndex, exercise, exercise.sets.length + 1)
      : undefined;
    const nextSetNumber = exercise && targetSetCount
      ? Math.min(targetSetCount, exercise.sets.length + 1)
      : undefined;
    return {
      exerciseIndex: exerciseIndex >= 0 ? exerciseIndex : undefined,
      setNumber: nextSetNumber,
    };
  }, [getEffectiveTargetSetCount]);

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

  // Timed exercise timer: keyed by "exIdx-setSlot".
  //
  // Wall-clock based so it survives screen lock / app backgrounding.
  // Previously we incremented `elapsed` by +1 every second via
  // setInterval — but setInterval pauses when the JS runtime suspends
  // (iOS screen lock), which meant a 30-minute treadmill session
  // whose screen went to sleep showed "4:12" when the user came back.
  //
  // New model:
  //   baseElapsed  = seconds accumulated across prior runs (before any pause)
  //   startedAt    = wall-clock ms when the current run started, or null if paused
  //   elapsed     := baseElapsed + (running ? (now - startedAt)/1000 : 0)
  //
  // The setInterval is purely a render-trigger (forces a re-read of
  // wall clock every second). It CAN pause in the background — that's
  // fine, because the next foreground tick recomputes from wall clock
  // and jumps straight to the correct total. `getTimerElapsed()` is
  // the single read path; UI code should never read `elapsed` off
  // state directly.
  const [activeTimers, setActiveTimers] = useState<Record<string, ExerciseTimerState>>({});
  const timerIntervalsRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  // Full-screen timer modal for timed exercises. When set to a
  // "exIdx-setSlot" key, the modal is open for that slot; when null
  // the modal is closed. The modal reads from activeTimers so the
  // wall-clock computation is shared with the inline UI.
  const [timerModalKey, setTimerModalKey] = useState<string | null>(null);
  // Tick counter to force re-renders while a timer is running. We
  // use a single shared ticker instead of one interval per timer so
  // the derived-from-wall-clock computation stays cheap.
  const [, setTimerTick] = useState(0);
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeTimersRef = useRef(activeTimers);
  const timerModalKeyRef = useRef(timerModalKey);
  useEffect(() => { activeTimersRef.current = activeTimers; }, [activeTimers]);
  useEffect(() => { timerModalKeyRef.current = timerModalKey; }, [timerModalKey]);

  const getTimerElapsed = useCallback((key: string): number => {
    const t = activeTimers[key];
    if (!t) return 0;
    if (t.running && t.startedAt != null) {
      return t.baseElapsed + Math.max(0, Math.floor((Date.now() - t.startedAt) / 1000));
    }
    return t.baseElapsed;
  }, [activeTimers]);

  const parseExerciseTimerKey = useCallback((key: string): { exIdx: number; slot: number } | null => {
    const [exIdxRaw, slotRaw] = key.split('-');
    const exIdx = Number(exIdxRaw);
    const slot = Number(slotRaw);
    if (!Number.isFinite(exIdx) || !Number.isFinite(slot) || exIdx < 0 || slot < 0) return null;
    return { exIdx: Math.floor(exIdx), slot: Math.floor(slot) };
  }, []);

  const timerElapsedFromState = useCallback((timer: ExerciseTimerState | undefined): number => {
    if (!timer) return 0;
    if (timer.running && timer.startedAt != null) {
      return timer.baseElapsed + Math.max(0, Math.floor((Date.now() - timer.startedAt) / 1000));
    }
    return timer.baseElapsed;
  }, []);

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
      workoutId: `w_${workout.focus}_${key}`,
      paused: !timer.running,
      elapsedSeconds,
      ...liveActivityHrZoneFields(liveHR, hrZones),
    };
  }, [exercises, getEffectiveTargetSetCount, hrZones, liveHR, parseExerciseTimerKey, theme.colors.primary, timerElapsedFromState, workout.focus]);

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
    const existing = activeTimers[key];
    const nextTimer: ExerciseTimerState = {
      running: true,
      baseElapsed: existing?.baseElapsed ?? 0,
      startedAt: Date.now(),
    };
    setActiveTimers(prev => {
      return {
        ...prev,
        [key]: nextTimer,
      };
    });
    startOrUpdateTimedLiveActivity(key, nextTimer);
    // Single shared ticker — only starts when at least one timer is
    // running, fires every second to trigger re-renders, and stops
    // itself below when all timers are paused.
    if (!tickIntervalRef.current) {
      restartManagedInterval(tickIntervalRef, () => {
        setTimerTick(t => (t + 1) % 1_000_000);
      }, 1000);
    }
  }, [activeTimers, startOrUpdateTimedLiveActivity]);

  const stopExerciseTimer = useCallback((key: string) => {
    const current = activeTimers[key];
    if (current) {
      const runElapsed = current.running && current.startedAt != null
        ? Math.max(0, Math.floor((Date.now() - current.startedAt) / 1000))
        : 0;
      updateTimedLiveActivity(key, {
        running: false,
        baseElapsed: current.baseElapsed + runElapsed,
        startedAt: null,
      });
    }
    setActiveTimers(prev => {
      const t = prev[key];
      if (!t) return prev;
      const runElapsed = t.running && t.startedAt != null
        ? Math.max(0, Math.floor((Date.now() - t.startedAt) / 1000))
        : 0;
      const next = {
        ...prev,
        [key]: {
          running: false,
          baseElapsed: t.baseElapsed + runElapsed,
          startedAt: null,
        },
      };
      // If nothing else is running, release the shared ticker.
      const anyRunning = Object.values(next).some(v => v?.running);
      if (!anyRunning) clearManagedInterval(tickIntervalRef);
      return next;
    });
  }, [activeTimers, updateTimedLiveActivity]);

  const resetExerciseTimer = useCallback((key: string) => {
    endTimedLiveActivity(key);
    setActiveTimers(prev => {
      const next = { ...prev, [key]: { running: false, baseElapsed: 0, startedAt: null } };
      const anyRunning = Object.values(next).some(v => v?.running);
      if (!anyRunning) clearManagedInterval(tickIntervalRef);
      return next;
    });
  }, [endTimedLiveActivity]);

  // Cleanup timer intervals on unmount. We only hold the shared
  // ticker now; legacy per-timer intervals in timerIntervalsRef are
  // no longer populated but we keep the ref around so any stale
  // handles can still be cleared if old code slipped one in.
  useEffect(() => {
    return () => {
      Object.values(timerIntervalsRef.current).forEach(clearInterval);
      clearManagedInterval(tickIntervalRef);
    };
  }, []);

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
  const [summaryVisible, setSummaryVisible] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryData, setSummaryData] = useState<WorkoutSummary | null>(null);
  // Tap the training-score row to reveal the per-pillar breakdown +
  // pillar-specific "what would max this" tips. Collapsed by default
  // so the summary stays compact.
  const [showTrainingDetails, setShowTrainingDetails] = useState(false);
  const [finishedSession, setFinishedSession] = useState<WorkoutSession | null>(null);
  // PR celebration modal — populated after handleFinish when the backend
  // returns one or more PRs. Null = no modal shown.
  const [prModalData, setPrModalData] = useState<PRAchievement[] | null>(null);
  const [sessionPrs, setSessionPrs] = useState<PRAchievement[]>([]);

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

      const baseName = `${workout.focus && workout.focus !== 'Empty' ? workout.focus : 'Custom'} Template`;
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
          sets: Math.max(getTargetSetCount(ex.targetSets), ex.sets?.length || 0),
          reps: ex.targetReps || '8-12',
          restSeconds: Number(ex.targetRestSeconds) || 60,
          equipment: (ex.equipment || 'other') as any,
          image_url: ex.image_url,
          targetWeightLbs: ex.targetWeightLbs ?? null,
          weightRecommendationSource: (ex.weightRecommendationSource as any) ?? null,
          slug: ex.slug ?? undefined,
          primary_muscle: ex.primaryMuscle ?? undefined,
          secondary_muscles: ex.secondaryMuscles ?? undefined,
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
  const deferredExerciseSearch = useDeferredValue(exerciseSearch);
  const [exerciseLibraryLoading, setExerciseLibraryLoading] = useState(false);
  const [exerciseLibrary, setExerciseLibrary] = useState<ExerciseLibraryItem[]>([]);
  const exerciseLibraryRef = useRef<ExerciseLibraryItem[]>([]);
  const [aiExerciseResults, setAiExerciseResults] = useState<AIExerciseResult[]>([]);
  const [aiExerciseLoading, setAiExerciseLoading] = useState(false);

  useEffect(() => {
    exerciseLibraryRef.current = exerciseLibrary;
  }, [exerciseLibrary]);

  const loadExerciseLibraryRows = useCallback(async (): Promise<ExerciseLibraryItem[]> => {
    let customs: ExerciseLibraryItem[] = [];
    try {
      const raw = await AsyncStorage.getItem('userProfile');
      if (raw) {
        const prof = JSON.parse(raw);
        customs = ((prof.customExercises ?? []) as any[]).map(ce => ({
          id: ce.id,
          name: ce.name,
          slug: ce.slug ?? null,
          primary_muscle: ce.primary_muscle,
          secondary_muscles: ce.secondary_muscles ?? [],
          equipment: ce.equipment,
          movement_pattern: ce.movement_pattern ?? null,
          image_url: ce.image_url ?? null,
          video_id: ce.video_id ?? null,
          is_compound: ce.is_compound ?? null,
          description: ce.description ?? '',
          is_custom: true,
        })) as unknown as ExerciseLibraryItem[];
      }
    } catch {}
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
      return [...customs, ...newTimed, ...rows];
    } catch {
      const existingNames = new Set(customs.map(e => e.name.toLowerCase()));
      return [
        ...customs,
        ...timedActivities.filter(t => !existingNames.has(t.name.toLowerCase())),
      ];
    }
  }, []);

  const ensureExerciseLibrary = useCallback(async (): Promise<ExerciseLibraryItem[]> => {
    if (exerciseLibraryRef.current.length > 0) return exerciseLibraryRef.current;
    setExerciseLibraryLoading(true);
    try {
      const rows = await loadExerciseLibraryRows();
      exerciseLibraryRef.current = rows;
      setExerciseLibrary(rows);
      return rows;
    } finally {
      setExerciseLibraryLoading(false);
    }
  }, [loadExerciseLibraryRows]);

  useEffect(() => {
    ensureExerciseLibrary().catch(() => undefined);
  }, [ensureExerciseLibrary]);

  const swapCandidatesForExercise = useCallback((
    ex: SessionExercise,
    library: ExerciseLibraryItem[] = exerciseLibraryRef.current,
    limit = 5,
  ): SmartSwapItem[] => {
    const base = library.find(li => li.name.toLowerCase() === ex.name.toLowerCase()) ?? {
      name: ex.name,
      equipment: ex.equipment,
      primary_muscle: ex.primaryMuscle ?? undefined,
      is_compound: ex.isCompound ?? undefined,
    };
    const scored: Array<{ item: ExerciseLibraryItem; score: number; historySignal?: ExerciseHistorySignal }> = [];
    for (const item of library) {
      if (item.name.toLowerCase() === ex.name.toLowerCase()) continue;
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
    return scored.slice(0, limit).map(({ item, score, historySignal }) => ({
      ...item,
      _overlap: Math.min(100, Math.round((score / SMART_SWAP_MAX_SCORE) * 100)),
      _swapNotes: buildSwapNotes(item, base, historySignal, activeInjuryTokens),
    }));
  }, [activeInjuryTokens, exerciseHistorySignals, ownedEquipment]);

  const buildWatchWorkoutSnapshot = useCallback((
    sourceExercises: SessionExercise[] = exercisesRef.current,
    opts?: { skipHintIndex?: number },
  ): any => ({
    ...workout,
    hrZones,
    exercises: sourceExercises.map((ex, index) => {
      const guide = isGuideExercise(ex, workout);
      const hint = index === opts?.skipHintIndex ? undefined : preSetHints[index];
      const recommendedWeight = guide ? null : hint?.recommendedWeight ?? ex.targetWeightLbs ?? null;
	      const recommendation = guide ? null : hint?.recommendedWeight != null
	        ? `Try ${displayExerciseWeight(hint.recommendedWeight, ex)}${hint.recommendedReps ? ` x ${hint.recommendedReps}` : ''}`
        : ex.aiRecommendation;
      return {
        name: ex.name,
        sets: getTargetSetCount(ex.targetSets),
        reps: ex.targetReps,
        restSeconds: guide ? 0 : ex.targetRestSeconds,
        equipment: ex.equipment,
        primaryMuscle: ex.primaryMuscle ?? ex.primary_muscle ?? null,
        primary_muscle: ex.primaryMuscle ?? ex.primary_muscle ?? null,
        cardioGuidance: (ex as any).cardioGuidance ?? null,
        targetWeightLbs: recommendedWeight,
        recommendedWeightLbs: recommendedWeight,
        recommendation,
        isGuide: guide,
        slot_role: (ex as any).slotRole ?? (ex as any).slot_role ?? null,
        prescriptionType: (ex as any).prescriptionType ?? (ex as any).prescription_type ?? null,
        swapOptions: swapCandidatesForExercise(ex).map(option => ({
          name: option.name,
          equipment: exerciseEquipmentLabel(option) ?? option.equipment ?? null,
          primaryMuscle: option.primary_muscle ?? null,
          overlap: option._overlap ?? null,
        })),
      };
    }),
	  }), [displayExerciseWeight, hrZones, preSetHints, swapCandidatesForExercise, workout]);

  buildWatchWorkoutSnapshotRef.current = buildWatchWorkoutSnapshot;

  const activeSnapshotAutoKey = useMemo(() => {
    const rows = exercises.map((ex) => {
      const guide = isGuideExercise(ex, workout);
      return {
        name: ex.name,
        sets: getTargetSetCount(ex.targetSets),
        reps: ex.targetReps,
        restSeconds: guide ? 0 : ex.targetRestSeconds,
        equipment: ex.equipment,
        primaryMuscle: ex.primaryMuscle ?? ex.primary_muscle ?? null,
        cardioGuidance: (ex as any).cardioGuidance ?? null,
        targetWeightLbs: guide ? null : ex.targetWeightLbs ?? null,
        slotRole: (ex as any).slotRole ?? (ex as any).slot_role ?? null,
        prescriptionType: (ex as any).prescriptionType ?? (ex as any).prescription_type ?? null,
        swapOptions: swapCandidatesForExercise(ex).map(option => ({
          name: option.name,
          equipment: exerciseEquipmentLabel(option) ?? option.equipment ?? null,
          primaryMuscle: option.primary_muscle ?? null,
          overlap: option._overlap ?? null,
        })),
      };
    });
    return JSON.stringify({
      focus: workout.focus,
      day: workout.day,
      stimulus: workout.stimulus ?? null,
      hrZones,
      warmupSteps,
      exercises: rows,
    });
  }, [exerciseLibrary, exercises, hrZones, swapCandidatesForExercise, warmupSteps, workout]);

  activeSnapshotAutoKeyRef.current = activeSnapshotAutoKey;

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
      equipment: exerciseEquipmentLabel(selected) ?? selected.equipment ?? previous.equipment,
      image_url: selected.image_url ?? previous.image_url,
      video_id: selected.video_id ?? previous.video_id ?? null,
      slug: selected.slug ?? null,
      primaryMuscle: selected.primary_muscle ?? previous.primaryMuscle ?? null,
      secondaryMuscles: selected.secondary_muscles ?? previous.secondaryMuscles ?? [],
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
  }, [buildWatchWorkoutSnapshot, ensureExerciseLibrary, setExercises, swapCandidatesForExercise]);

  watchSwapExerciseRef.current = performWatchExerciseSwap;

  useEffect(() => {
    if (!watchSessionHydrated || !activeWorkoutStateRestored || showStartCountdown) return;
    if (!lastActiveSnapshotAutoKeyPushedRef.current) return;
    if (lastActiveSnapshotAutoKeyPushedRef.current === activeSnapshotAutoKey) return;
    const timer = setTimeout(() => {
      if (watchWorkoutEndedRef.current) return;
      const snapshotKey = activeSnapshotAutoKey;
      import('../utils/watchSync')
        .then(({ pushWorkoutToWatch }) => pushWorkoutToWatch(buildWatchWorkoutSnapshot(), {
          dateISO: dateKey(new Date()),
          status: 'active',
          sessionId: watchSessionId.current,
          warmupSteps: warmupStepsRef.current,
          reason: 'active_snapshot',
        })
          .then((ok) => {
            if (ok) lastActiveSnapshotAutoKeyPushedRef.current = snapshotKey;
          })
          .catch(() => {}))
        .catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [activeSnapshotAutoKey, activeWorkoutStateRestored, buildWatchWorkoutSnapshot, showStartCountdown, watchSessionHydrated]);

  // Elapsed workout timer
  useManagedInterval(() => {
    setElapsed(Math.floor((Date.now() - startTime.current) / 1000));
  }, 1000, !showStartCountdown);

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
          "Notifications are off, so your rest timer won't show on the Lock Screen or Dynamic Island, and you won't hear an alert when rest ends. Enable notifications in Settings to turn this on.",
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
        for (let slot = 0; slot < getTargetSetCount(ex.targetSets); slot++) {
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
      if (!guide && setIdx === updatedSets.length - 1 && shouldPromptRir(newReps, ex.targetReps) && updatedSets[setIdx]?.rir == null) {
        setPendingRir({ exIdx, setIdx });
      } else if (pendingRir?.exIdx === exIdx && pendingRir.setIdx === setIdx) {
        setPendingRir(null);
      }
      setExercises(prev => prev.map((e, idx) =>
        idx === exIdx ? { ...e, sets: updatedSets } : e
      ));
      setEditingSetKey(null);
      setEditDraft({});
      clearLiveRecommendationState(exIdx, { preserveNextTarget: true });
      if (!guide && !shouldPromptRir(newReps, ex.targetReps)) {
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
    if (ex && !guide && editSetIdx === updatedSets.length - 1 && shouldPromptRir(r, ex.targetReps) && updatedSets[editSetIdx]?.rir == null) {
      setPendingRir({ exIdx: editSetExIdx, setIdx: editSetIdx });
    } else if (pendingRir?.exIdx === editSetExIdx && pendingRir.setIdx === editSetIdx) {
      setPendingRir(null);
    }
    setExercises(prev => prev.map((e, i) => {
      if (i !== editSetExIdx) return e;
      return { ...e, sets: updatedSets };
    }));
    setEditSetVisible(false);
    clearLiveRecommendationState(editSetExIdx, { preserveNextTarget: true });
    if (!guide && !shouldPromptRir(r, ex?.targetReps)) {
      maybeRefreshRecommendationForExerciseRef.current?.(editSetExIdx, updatedSets);
    }
  }, [clearLiveRecommendationState, editSetExIdx, editSetIdx, editSetWeight, editSetReps, exercises, parseInputWeightLbs, pendingRir, workout.focus, workout.stimulus]);

  // Log a specific set slot inline (no modal).
  // `overrideDuration` bypasses the state read for timed exercises —
  // needed because the timer "Done" button sets duration in state then
  // calls this immediately, but React hasn't flushed the state yet.
  const handleLogSetInline = useCallback(async (
    exIdx: number,
    setSlot: number,
    silent = false,
    overrideDuration?: string,
    overrideWeight?: string,
    overrideReps?: string,
    sourceActionAtMs?: number,
    overrideRir?: number,
  ) => {
    const key = `${exIdx}-${setSlot}`;
    const input = setInputs[key];
    const currentExercises = exercisesRef.current.length > 0 ? exercisesRef.current : exercises;
    const ex = currentExercises[exIdx];
    if (!ex) return;
    const timed = isTimedExercise(ex?.name ?? '', ex?.targetReps);
    const guide = isGuideExercise(ex, workout);

    // Watch-originated logs pass weight / reps directly as overrides
    // so we don't have to round-trip through React state first. Phone
    // UI continues to flow through setInputs.
    const effectiveWeight = overrideWeight ?? input?.weight;
    const effectiveReps = overrideReps ?? input?.reps;

    let newSet: CompletedSet;

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
      endTimedLiveActivity(key);
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

    // Haptic feedback on set log
    import('../utils/feedback').then(f => f.hapticMedium()).catch(() => {});

    // Capture current HR from Apple Watch and stamp it on the set (non-blocking)
    cachedProfileIsPro()
      .then((canUseHealth) => {
        if (!canUseHealth) return undefined;
        return getLatestHeartRate().then(hr => {
          if (hr && hr > 0) {
            setExercises(prev => prev.map((e, eIdx) => {
              if (eIdx !== exIdx) return e;
              const updated = [...e.sets];
              const target = updated[setSlot];
              if (target) updated[setSlot] = { ...target, heartRateAvg: hr };
              return { ...e, sets: updated };
            }));
          }
        });
      })
      .catch(() => {});

    const effectiveTotal = getEffectiveTargetSetCount(exIdx, ex, ex.sets.length + 1);

    // Insert or replace at the correct slot position
    const updatedSets = [...ex.sets];
    updatedSets[setSlot] = newSet;
    // Remove any trailing undefined slots
    const cleanSets = updatedSets.filter(Boolean);

    // Set was logged — clear the post-rest idle tracker.
    restEndedAtRef.current = 0;
    setPostRestIdleSecs(0);

    const updatedExercises = currentExercises.map((e, i) => i === exIdx ? { ...e, sets: cleanSets } : e);
    setExercises(updatedExercises);
    setAiErrorIdx(null);

    // Flash the row green + fade back. Purely visual confirmation — the
    // haptic above already fired. Non-native driver (color prop).
    triggerSetPulse(`${exIdx}-${setSlot}`);

    // Mark workout as started in the backend DB on first logged set.
    // This ensures getWorkoutStatus returns done=true immediately,
    // even if the user never taps Finish (app crash, phone dies).
    if (!workoutStartedRef.current && authToken) {
      workoutStartedRef.current = true;
      logWorkoutStarted(authToken, dateKey(new Date()), workout.focus, workout.stimulus).catch(() => {});
    }

    // Auto-advance to next incomplete exercise when all effective sets are done
    let nextExIdx = exIdx;
    if (cleanSets.length >= effectiveTotal) {
      configureLiveLayoutAnimation();
      const nextIdx = updatedExercises.findIndex((e, i) => i > exIdx && e.sets.length < getTargetSetCount(e.targetSets));
      setActiveExIdx(nextIdx >= 0 ? nextIdx : -1);
      nextExIdx = nextIdx >= 0 ? nextIdx : exIdx;
      import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
    } else {
      setActiveExIdx(exIdx);
    }

    // Mirror the phone's set-only state when no rest is about to start.
    // Rest pushes below carry the same exercise/set fields, so sending both
    // can make WCSession deliver the older timer after a newer set-only packet.
    if (cleanSets.length >= effectiveTotal || guide) {
      const progressSetNumber = nextExIdx === exIdx
        ? guide && cleanSets.length < effectiveTotal
          ? cleanSets.length + 1
          : Math.min(cleanSets.length, effectiveTotal)
        : 1;
      (async () => {
        try {
          const { pushProgressToWatch } = await import('../utils/watchSync');
          await pushProgressToWatch({
            exerciseIndex: nextExIdx,
            setNumber: progressSetNumber,
            restRemainingSec: 0,
            recommendation: null,
          });
        } catch { /* watch bridge optional */ }
      })();
    }

    // Start rest timer automatically if more sets remain
    if (!guide && cleanSets.length < effectiveTotal) {
      const restSeconds = Math.max(15, ex.targetRestSeconds || 60);
      const restStartedAtMs = sourceActionAtMs && Number.isFinite(sourceActionAtMs) && sourceActionAtMs > 0
        ? sourceActionAtMs
        : Date.now();
      const restEndsAtMs = restStartedAtMs + restSeconds * 1000;
      const remainingRestSeconds = Math.max(0, Math.ceil((restEndsAtMs - Date.now()) / 1000));
      const clearedAfterRestStarted = Boolean(sourceActionAtMs && lastRestClearedAtMsRef.current >= restStartedAtMs);
      const nextSetLabel = timed
        ? `Set ${cleanSets.length + 1}: ${ex.targetReps}`
        : `Set ${cleanSets.length + 1}: ${displayExerciseWeight(newSet.weightLbs, ex)} x ${ex.targetReps}`;
      if (!clearedAfterRestStarted && remainingRestSeconds > 0) {
        restDurationSeconds.current = restSeconds;
        setRestForExercise(ex.name);
        setRestRemaining(remainingRestSeconds);
        setRestNextTarget(nextSetLabel);
        setRestCue(null);
        startRestTimerRef.current(restSeconds, ex.name, {
          nextTarget: nextSetLabel,
          cue: undefined,
          startedAtMs: restStartedAtMs,
        });
        // Push rest seconds to watch so its rest-timer view reflects the
        // phone's timer without running a second independent clock.
        (async () => {
          try {
            const { pushProgressToWatch } = await import('../utils/watchSync');
            await pushProgressToWatch({
              exerciseIndex: exIdx,
              setNumber: cleanSets.length + 1,
              restRemainingSec: remainingRestSeconds,
              restStartedAtMs,
              restDurationSec: restSeconds,
              restEndsAtMs,
              recommendation: nextSetLabel,
            });
            reassertRestProgressToWatchRef.current();
          } catch { /* watch bridge optional */ }
        })();
        rescheduleRestNotificationsRef.current({
          seconds: remainingRestSeconds,
          exerciseName: ex.name,
          nextSetLabel,
          aiCue: null,
          includeStartAlert: sourceActionAtMs == null,
        }).catch(() => undefined);
      } else if (!sourceActionAtMs || restStartAtRef.current <= restStartedAtMs) {
        clearRestStateRef.current();
      }
    } else {
      clearRestStateRef.current({ pushToWatch: false });
    }

    const setsLogged = cleanSets.length;
    if (!timed && !guide && setsLogged < effectiveTotal) {
      const needsRirPrompt = shouldPromptRir(newSet.reps, ex.targetReps) && newSet.rir == null;
      if (needsRirPrompt) {
        setPendingRir({ exIdx, setIdx: cleanSets.length - 1 });
      } else if (pendingRir?.exIdx === exIdx) {
        setPendingRir(null);
      }
      clearLiveRecommendationState(exIdx, { preserveNextTarget: true });
      if (needsRirPrompt) {
        console.log('[AI] Recommendation deferred until significant-overage RIR is logged.');
      } else {
        maybeRefreshRecommendationForExerciseRef.current?.(exIdx, cleanSets);
      }
    } else if (pendingRir?.exIdx === exIdx) {
      setPendingRir(null);
    }
  }, [authToken, clearLiveRecommendationState, displayExerciseWeight, endTimedLiveActivity, exercises, getEffectiveTargetSetCount, parseInputWeightLbs, pendingRir, setInputs, workout.focus, workout.stimulus]);
  handleLogSetInlineRef.current = handleLogSetInline;

  const openAddExerciseModal = useCallback(async () => {
    setAddExerciseModalVisible(true);
    setAiExerciseResults([]);
    setAiExerciseLoading(false);
    if (exerciseLibraryRef.current.length > 0) return;
    await ensureExerciseLibrary().catch(() => undefined);
  }, [ensureExerciseLibrary]);

  const previewExerciseFromPicker = useCallback((item: ExerciseLibraryItem) => {
    setReturnToExercisePickerAfterVideo(addExerciseModalVisible);
    setAddExerciseModalVisible(false);
    setTimeout(() => {
      InteractionManager.runAfterInteractions(() => openFormVideoForExercise(item));
    }, 360);
  }, [addExerciseModalVisible, openFormVideoForExercise]);

  const handleAddExercise = useCallback((item: ExerciseLibraryItem) => {
    const timed = isTimedExercise(item.name);
    const nextExercise: SessionExercise = {
      name: item.name,
      targetSets: timed ? 1 : 3,
      targetReps: timed ? '15 min' : '10',
      targetRestSeconds: timed ? 0 : 60,
      equipment: item.equipment ? String(item.equipment) : 'bodyweight',
      sets: [],
      aiRecommendation: undefined,
      primaryMuscle: item.primary_muscle ?? null,
      secondaryMuscles: item.secondary_muscles ?? [],
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
    setAiExerciseResults([]);
  }, [swapTargetIdx]);

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
    import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
  }, [activeInjuryTokens, ensureExerciseLibrary, exercises, ownedEquipment, setExercises, workout.focus]);

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
      const res = await searchExerciseAI(authToken, {
        query: q,
        equipment,
        injuries,
        exclude: exerciseLibrary.map(e => e.name).filter(Boolean),
      });
      setAiExerciseResults(res.results ?? []);
      if ((res.results ?? []).length === 0) {
        Alert.alert('No results', `AI couldn't find a match for "${q}".`);
      }
    } catch (e: any) {
      Alert.alert('Search failed', e?.message ?? 'Could not reach the AI server.');
    } finally {
      setAiExerciseLoading(false);
    }
  }, [exerciseSearch, authToken, swapTargetIdx, exerciseLibrary]);

  /** Add an AI search result directly to the current workout. Converts the
   *  AI shape into the same `ExerciseLibraryItem` shape `handleAddExercise`
   *  expects so the workout code doesn't need to know about AI origin. */
  const handleAddAiExercise = useCallback((ex: AIExerciseResult) => {
    handleAddExercise(exerciseLibraryItemFromAiResult(ex, `ai_${Date.now()}`));
  }, [handleAddExercise]);

  /** Persist an AI search result to the user's custom exercise library so
   *  future local searches find it without another AI call. Mirrors the
   *  custom-food flow — writes to `userProfile.customExercises` in
   *  AsyncStorage. Next profile sync pushes it to the backend. */
  const handleSaveAiExerciseToLibrary = useCallback(async (ex: AIExerciseResult) => {
    try {
      const raw = await AsyncStorage.getItem('userProfile');
      if (!raw) return;
      const prof = JSON.parse(raw);
      const existing: any[] = prof.customExercises ?? [];
      if (existing.some((c: any) => c.name.toLowerCase() === ex.name.toLowerCase())) {
        Alert.alert('Already saved', `${ex.name} is already in your library.`);
        return;
      }
      prof.customExercises = [
        ...existing,
        {
          id: `custom_${Date.now()}`,
          name: ex.name,
          primary_muscle: ex.primary_muscle,
          secondary_muscles: ex.secondary_muscles ?? [],
          equipment: ex.equipment,
          sets: ex.sets,
          reps: ex.reps,
          rest_seconds: ex.rest_seconds,
          description: ex.why,
          form_cues: ex.form_cues,
          // Persist enrichment so re-adding from the local library hits
          // the same form-video / image / compound metadata.
          video_id: ex.video_id ?? null,
          image_url: ex.image_url ?? null,
          is_compound: ex.is_compound ?? null,
          movement_pattern: ex.movement_pattern ?? null,
          source: ex.source ?? 'ai',
          createdAt: new Date().toISOString(),
        },
      ];
      await AsyncStorage.setItem('userProfile', JSON.stringify(prof));
      Alert.alert('Saved', `${ex.name} added to your exercise library.`);
    } catch (e: any) {
      Alert.alert('Save failed', e?.message ?? 'Could not save to library.');
    }
  }, []);

  // Timestamp-based rest timer — avoids drift from re-running setInterval every second
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
      AsyncStorage.removeItem('activeWorkoutRest').catch(() => {});
      return;
    }
    restStartAtRef.current = startedAtMs;
    restTotalSecondsRef.current = seconds;
    restExerciseNameRef.current = exerciseName;
    restEndedAtRef.current = 0;
    setPostRestIdleSecs(0);
    restRemainingRef.current = initialRemaining;
    setRestRemaining(initialRemaining);

    // Keep the iOS background audio session alive so the rest countdown
    // continues ticking even when the user switches to another app.
    import('../utils/feedback').then(f => f.startRestTimerKeepalive()).catch(() => {});

    // Use explicitly passed values when available (refs lag one render behind
    // state batching, so call sites that just called setRestNextTarget must
    // pass the value directly or the lock screen / AsyncStorage snapshot
    // will capture the stale previous value).
    const snapNextTarget = opts?.nextTarget !== undefined ? opts.nextTarget : restNextTargetRef.current;
    const snapCue = opts?.cue !== undefined ? opts.cue : restCueRef.current;

    AsyncStorage.setItem('activeWorkoutRest', JSON.stringify({
      startAtMs: restStartAtRef.current,
      totalSeconds: seconds,
      exerciseName,
      nextTarget: snapNextTarget,
      cue: snapCue,
    })).catch(() => {});

    // Kick off a Live Activity on the lock screen. End any prior one first
    // (switching exercises mid-rest shouldn't orphan the old card). Wrapped
    // so any failure in the native bridge can't take down the workout.
    (async () => {
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
        const startedAtMs = restStartAtRef.current || Date.now();
        const durationSeconds = Math.max(1, seconds);
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
          startedAtMs,
          durationSeconds,
          endDateMs: startedAtMs + durationSeconds * 1000,
          nextSetRecommendation: nextCue ? `${nextTarget} - ${nextCue}` : nextTarget,
          themeColorHex: theme.colors.primary,
          workoutId: `w_${workout.focus}_${Date.now()}`,
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
          || restStartAtRef.current !== startedAtMs
          || restExerciseNameRef.current !== exerciseName
        ) {
          await endRestActivity(id);
          return;
        }
        liveActivityIdRef.current = id;
        // Diagnostic: on the first rest only, log why the native bridge
        // refused to start. Do not alert mid-workout.
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
    })().catch(() => undefined);

    restartManagedInterval(restTimerRef, () => {
      const elapsed = Math.floor((Date.now() - restStartAtRef.current) / 1000);
      const remaining = Math.max(0, restTotalSecondsRef.current - elapsed);
      if (remaining !== restRemainingRef.current) {
        restRemainingRef.current = remaining;
        setRestRemaining(remaining);
      }

      if (remaining === 0) {
        clearManagedInterval(restTimerRef);
        restEndedAtRef.current = Date.now();
        lastRestClearedAtMsRef.current = restEndedAtRef.current;
        setPostRestIdleSecs(0);
        AsyncStorage.removeItem('activeWorkoutRest').catch(() => {});
        import('../utils/watchSync').then(({ pushProgressToWatch }) =>
          pushProgressToWatch({ ...buildWatchPositionProgress(), restRemainingSec: 0 })
        ).catch(() => undefined);
        import('../utils/feedback').then(f => {
          // Stop the silent keepalive loop before playing the chime so
          // both don't compete on the audio output buffer.
          f.stopRestTimerKeepalive();
          // Brief in-app chime (~0.45s) + vibrate + haptic. The
          // pre-scheduled completeId notification (set in
          // rescheduleRestNotifications) ALSO fires at this exact
          // instant — both foregrounded (notification handler plays
          // the system sound) and backgrounded (iOS plays it natively
          // even with screen off). Don't schedule a SECOND immediate
          // notification here: layering 3 sounds back-to-back was the
          // "rest sound takes over too long" complaint.
          f.playRestTimerDone();
          f.vibrateRestDone();
          f.hapticHeavy();
        }).catch(() => Vibration.vibrate([0, 300, 150, 300, 150, 300]));
        // Cancel remaining scheduled notifications — the keepalive
        // audio session kept the JS alive so the interval already
        // delivered the sound. Cancel both warning + complete to avoid
        // a duplicate banner/vibration arriving a moment later.
        // (If the app was killed before rest ended the notification
        // already fired natively and cancellation is a no-op.)
        cancelRestNotifications(restNotificationIds.current).catch(() => undefined);
        restNotificationIds.current = null;
        // End the Live Activity on the lock screen.
        endActiveRestLiveActivity();
      }
    }, 500); // 500ms tick for smooth countdown without drift
  }, [buildWatchPositionProgress, endActiveRestLiveActivity, getEffectiveTargetSetCount, hrZones, liveHR, theme.colors.primary, workout.focus]);
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
        // Catch up elapsed workout time
        setElapsed(Math.floor((Date.now() - startTime.current) / 1000));
        const timers = activeTimersRef.current;
        const runningTimerKey =
          (timerModalKeyRef.current && timers[timerModalKeyRef.current]?.running ? timerModalKeyRef.current : null)
          ?? Object.keys(timers).find(key => timers[key]?.running);
        if (runningTimerKey) {
          setTimerTick(t => (t + 1) % 1_000_000);
          restartManagedInterval(tickIntervalRef, () => {
            setTimerTick(t => (t + 1) % 1_000_000);
          }, 1000);
          updateTimedLiveActivityRef.current(runningTimerKey, timers[runningTimerKey]);
        }
        // Catch up rest timer
        if (restStartAtRef.current > 0 && restTotalSecondsRef.current > 0) {
          const restElapsed = Math.floor((Date.now() - restStartAtRef.current) / 1000);
          const remaining = Math.max(0, restTotalSecondsRef.current - restElapsed);
          setRestRemaining(remaining);
          if (remaining === 0) {
            clearManagedInterval(restTimerRef);
            AsyncStorage.removeItem('activeWorkoutRest').catch(() => {});
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
    import('../utils/feedback').then(f => f.stopRestTimerKeepalive()).catch(() => {});
    setRestRemaining(0);
    setRestForExercise(null);
    setRestCue(null);
    setRestNextTarget(null);
    restDurationSeconds.current = 0;
    restStartAtRef.current = 0;
    restTotalSecondsRef.current = 0;
    restExerciseNameRef.current = null;
    if (opts?.pushToWatch !== false) {
      import('../utils/watchSync').then(({ pushProgressToWatch }) =>
        pushProgressToWatch({ ...watchPosition, restRemainingSec: 0 })
      ).catch(() => undefined);
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
        },
      },
    ]);
  }, [clearRestState, exercises, restForExercise]);

  const handleReorderExercise = useCallback((fromIdx: number, direction: 'up' | 'down') => {
    const toIdx = direction === 'up' ? fromIdx - 1 : fromIdx + 1;
    if (toIdx < 0 || toIdx >= exercises.length) return;
    configureLiveLayoutAnimation();
    import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
    setPreSetHints({});
    setExercises(prev => {
      const next = [...prev];
      [next[fromIdx], next[toIdx]] = [next[toIdx], next[fromIdx]];
      return next;
    });
    setActiveExIdx(toIdx);
  }, [exercises.length]);

  const handleLogSet = async () => {
    console.log('[LOG_SET] handleLogSet called with weight:', logWeight, 'reps:', logReps, 'exercise index:', logExIdx);
    const weightNum = parseInputWeightLbs(logWeight);
    const repsNum   = parseInt(logReps, 10);
    if (!logWeight || !logReps || isNaN(weightNum) || isNaN(repsNum) || repsNum <= 0) {
      console.warn('[LOG_SET] Invalid input validation failed');
      Alert.alert('Invalid Input', 'Please enter valid weight and reps.');
      return;
    }

    // Capture synchronously before any state updates
    const exIdx = logExIdx;
    const ex    = exercises[exIdx];
    const guide = isGuideExercise(ex, workout);
    const targetSetCount = getEffectiveTargetSetCount(exIdx, ex, ex.sets.length + 1);
    console.log('[LOG_SET] Processing set for exercise:', ex.name, 'current sets:', ex.sets.length, 'target sets:', targetSetCount);

    const newSet: CompletedSet = { setNumber: ex.sets.length + 1, reps: repsNum, weightLbs: weightNum };
    const updatedSets = [...ex.sets, newSet];
    console.log('[LOG_SET] Created new set:', newSet, 'updated sets count:', updatedSets.length);

    setExercises(prev => prev.map((e, i) => i === exIdx ? { ...e, sets: updatedSets } : e));
    console.log('[LOG_SET] Updated exercises state with new set');
    setLogModalVisible(false);
    console.log('[LOG_SET] Closed log modal');
    setActiveExIdx(exIdx);  // keep card expanded so tip appears
    console.log('[LOG_SET] Set active exercise index to:', exIdx);
    setAiErrorIdx(null);
    console.log('[LOG_SET] Cleared AI error index');

    // Only ask for RIR when the user clearly overshoots the target range.
    if (!guide && shouldPromptRir(repsNum, ex.targetReps)) {
      setPendingRir({ exIdx, setIdx: updatedSets.length - 1 });
    } else {
      setPendingRir(null);
    }

    // Start rest timer automatically if more sets remain for this exercise.
    if (!guide && updatedSets.length < targetSetCount) {
      const restSeconds = Math.max(15, ex.targetRestSeconds || 60);
      const nextSetLabel = `Set ${updatedSets.length + 1}: ${displayExerciseWeight(weightNum, ex)} x ${ex.targetReps}`;
      restDurationSeconds.current = restSeconds;
      setRestForExercise(ex.name);
      setRestRemaining(restSeconds);
      setRestNextTarget(nextSetLabel);
      setRestCue(null);
      startRestTimer(restSeconds, ex.name, { nextTarget: nextSetLabel, cue: undefined });
      (async () => {
        try {
          const { pushProgressToWatch } = await import('../utils/watchSync');
          const startedAtMs = restStartAtRef.current || Date.now();
          await pushProgressToWatch({
            exerciseIndex: exIdx,
            setNumber: ex.sets.length + 2,
            restRemainingSec: restSeconds,
            restStartedAtMs: startedAtMs,
            restDurationSec: restSeconds,
            restEndsAtMs: startedAtMs + restSeconds * 1000,
            recommendation: nextSetLabel,
          });
          reassertRestProgressToWatchRef.current();
        } catch { /* watch bridge optional */ }
      })();
      await rescheduleRestNotifications({
        seconds: restSeconds,
        exerciseName: ex.name,
        nextSetLabel,
        aiCue: null,
        includeStartAlert: true,
      });
    } else {
      (async () => {
        try {
          const { pushProgressToWatch } = await import('../utils/watchSync');
          await pushProgressToWatch({
            exerciseIndex: exIdx,
            setNumber: guide && updatedSets.length < targetSetCount
              ? updatedSets.length + 1
              : Math.min(updatedSets.length, targetSetCount),
            restRemainingSec: 0,
            recommendation: null,
          });
        } catch { /* watch bridge optional */ }
      })();
      clearRestState({ pushToWatch: false });
    }

    // Clear any stale AI tip from a prior set, but keep the next-set
    // target label visible during the rest timer while we refresh the cue.
    setExercises(prev => prev.map((e, i) => i === exIdx ? { ...e, aiRecommendation: undefined } : e));
    setRestCue(null);
    const setsLogged = updatedSets.length;
    if (guide || setsLogged >= targetSetCount) {
      console.log('[AI] Skipping recommendation - all sets completed for this exercise');
    } else if (shouldPromptRir(repsNum, ex.targetReps)) {
      console.log('[AI] Recommendation deferred until significant-overage RIR is logged.');
    } else {
      await maybeRefreshRecommendationForExerciseRef.current?.(exIdx, updatedSets);
    }
  };

  const adjustActiveRestRemaining = useCallback(async (delta: number) => {
    const current = restRemainingRef.current;
    if (current <= 0 || !restForExercise) return;
    const nextRemaining = Math.max(0, current + delta);
    if (nextRemaining <= 0) {
      clearRestState();
      return;
    }
    // Update the ref synchronously so a follow-up tap fired before
    // React commits the next render still reads the new value.
    restRemainingRef.current = nextRemaining;
    // Restart the timestamp-based timer with the adjusted duration
    startRestTimer(nextRemaining, restForExercise);
    setRestRemaining(nextRemaining);
    pushRestProgressToWatchRef.current().catch(() => {});
    // Also persist the new rest duration on the exercise so the next set uses it
    setExercises(prev => prev.map(ex =>
      ex.name === restForExercise ? { ...ex, targetRestSeconds: nextRemaining } : ex
    ));
    await rescheduleRestNotifications({
      seconds: nextRemaining,
      exerciseName: restForExercise,
      nextSetLabel: restNextTarget ?? 'Next set is coming up',
      aiCue: restCue,
      includeStartAlert: false,
    });
  }, [clearRestState, rescheduleRestNotifications, restCue, restForExercise, restNextTarget, startRestTimer]);

  const refreshRecommendationForExercise = useCallback(async (exIdx: number, setsForExercise: CompletedSet[]) => {
    const ex = exercises[exIdx];
    const targetSetCount = ex ? getEffectiveTargetSetCount(exIdx, ex, setsForExercise.length) : 3;
    if (!ex || setsForExercise.length >= targetSetCount || !authToken) return;
    if (isGuideExercise(ex, workout)) {
      clearLiveRecommendationState(exIdx);
      return;
    }
    if (isTimedExercise(ex.name, ex.targetReps)) {
      const tip = getTimedExerciseTip(ex.name, ex.targetReps, setsForExercise);
      if (tip) {
        setExercises(prev => prev.map((item, idx) => idx === exIdx ? { ...item, aiRecommendation: tip } : item));
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
      setRestNextTarget(`Set ${setN}: ${ex.targetReps} reps`);
      setRestCue(baseTip);
      setExercises(prev => prev.map((item, i) => i === exIdx ? { ...item, aiRecommendation: baseTip } : item));
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
        pushProgressToWatch({ recommendation: baseTip.replace(/^Set \d+:\s*/, '') })
      ).catch(() => undefined);
      return;
    }

    if (!(await cachedProfileIsPro())) {
      const setN = setsForExercise.length + 1;
      const last = setsForExercise[setsForExercise.length - 1];
	      const baseTip = last && Number(last.weightLbs) > 0
	        ? `Set ${setN}: aim to match ${displayExerciseWeight(last.weightLbs, ex)} for ${last.reps || ex.targetReps} reps with clean form.`
        : `Set ${setN}: use a comfortable load for ${ex.targetReps} clean reps.`;
      setRestNextTarget(`Set ${setN}: ${ex.targetReps} reps`);
      setRestCue(baseTip);
      setExercises(prev => prev.map((item, i) => i === exIdx ? { ...item, aiRecommendation: baseTip } : item));
      return;
    }

    setAiLoadingIdx(exIdx);
    try {
      const bests = await getExerciseBests(ex.name).catch(() => null);
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
        lastSessionBestWeightLbs: bests?.lastSession?.weightLbs,
        lastSessionBestReps: bests?.lastSession?.reps,
        plannedTargetWeightLbs: ex.targetWeightLbs ?? undefined,
        setScheme: plannedSetsForLiveRecommendation(ex),
        exerciseSlug: ex.slug ?? undefined,
        equipment: ex.equipment,
        primaryMuscle: ex.primaryMuscle ?? undefined,
      });
	      const recWeightText = displayExerciseWeight(rec.weightLbs, ex);
	      const tip = `Set ${setsForExercise.length + 1}: try ${recWeightText} x ${rec.reps} reps — ${rec.tip}`;
	      setRestNextTarget(`Set ${setsForExercise.length + 1}: ${recWeightText} x ${rec.reps}`);
      setRestCue(rec.tip);
      setExercises(prev => prev.map((item, i) => i === exIdx ? { ...item, aiRecommendation: tip } : item));
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
	        pushProgressToWatch({ recommendation: `${recWeightText} x ${rec.reps} - ${rec.tip}` })
      ).catch(() => undefined);

      if (restRemaining > 0 && restForExercise === ex.name) {
        await rescheduleRestNotifications({
          seconds: restRemaining,
          exerciseName: ex.name,
	          nextSetLabel: `Set ${setsForExercise.length + 1}: ${recWeightText} x ${rec.reps}`,
          aiCue: rec.tip,
          includeStartAlert: false,
        });
      }
    } catch {
      setAiErrorIdx(exIdx);
    } finally {
      setAiLoadingIdx(null);
    }
	  }, [authToken, cachedProfileIsPro, clearLiveRecommendationState, displayExerciseWeight, exercises, getEffectiveTargetSetCount, goal, rescheduleRestNotifications, restForExercise, restRemaining, theme.colors.primary, workout.focus, workout.stimulus]);

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
      && lastSet.rir == null;
    if (rirStillPending) {
      clearLiveRecommendationState(exIdx, { preserveNextTarget: true });
      return;
    }

    await refreshRecommendationForExercise(exIdx, setsForExercise);
  }, [clearLiveRecommendationState, exercises, getEffectiveTargetSetCount, pendingRir, refreshRecommendationForExercise]);
  maybeRefreshRecommendationForExerciseRef.current = maybeRefreshRecommendationForExercise;

  const handleSubmitFeedback = async (skip = false) => {
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
          // Patch the backend WorkoutCompletion row with the feedback
          // so the weekly review's struggle metrics + the trainer can
          // see it. Re-uses the upsert path on /workouts/complete.
          if (authToken) {
            try {
              await logWorkoutDone(
                authToken,
                dateKey(new Date(captured.session.date)),
                captured.session.focus,
                captured.session.durationSeconds,
                undefined, undefined, undefined,
                {
                  feeling: captured.feeling,
                  intensity: captured.intensity,
                  sorenessAreas: captured.soreness,
                  notes: captured.notes.trim() || undefined,
                },
                undefined,
                {
                  startedAt: captured.session.startedAt ?? captured.session.date,
                  endedAt: captured.session.endedAt ?? null,
                  externalSourceId: captured.session.id,
                },
              );
            } catch (e) {
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
    setSummaryVisible(false);
    setSummaryStep('summary');
    if (finishedSession) onFinish(finishedSession);
  };

  const cancelWorkoutSession = useCallback(() => {
    if (cancelingWorkoutRef.current) return;
    cancelingWorkoutRef.current = true;
    setCancelingWorkout(true);
    watchWorkoutEndedRef.current = true;
    clearRestState({ endAllLiveActivities: true });
    setActiveWatchSessionId(null);
    AsyncStorage.removeItem('activeWorkoutSets').catch(() => {});
    AsyncStorage.removeItem('activeWorkoutStartTime').catch(() => {});
    AsyncStorage.removeItem('activeWorkoutRest').catch(() => {});
    AsyncStorage.removeItem('activeWatchSessionId').catch(() => {});
    import('../utils/watchSync')
      .then(({ pushWorkoutToWatch }) => pushWorkoutToWatch(buildWatchWorkoutSnapshotRef.current(), {
        dateISO: dateKey(new Date()),
        status: 'skipped',
        sessionId: watchSessionId.current,
        reason: 'skip',
      }).catch(() => {}))
      .catch(() => {});
    const leaveWorkout = () => onCancel();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(leaveWorkout);
    } else {
      setTimeout(leaveWorkout, 0);
    }
  }, [clearRestState, onCancel]);

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
    watchWorkoutEndedRef.current = true;
    import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
    AsyncStorage.removeItem('activeWorkoutSets').catch(() => {}); AsyncStorage.removeItem('activeWorkoutStartTime').catch(() => {}); AsyncStorage.removeItem('activeWorkoutRest').catch(() => {}); AsyncStorage.removeItem('activeWatchSessionId').catch(() => {});
    setActiveWatchSessionId(null);
    clearRestState({ endAllLiveActivities: true });
    // Reset feedback state for fresh form
    setSummaryStep('summary');
    setFeedbackFeeling(null);
    setFeedbackIntensity(null);
    setFeedbackSoreness([]);
    setFeedbackNotes('');
    setFeedbackResult(null);
    setSessionPrs([]);

    const now = new Date();
    const startedAtIso = new Date(startTime.current).toISOString();
    const endedAtIso = now.toISOString();
    const finalExercises = exercisesRef.current.length > 0 ? exercisesRef.current : exercises;
    const actualDurationSeconds = Math.max(elapsed, Math.floor((now.getTime() - startTime.current) / 1000));
    const session: WorkoutSession = {
      id: `${Date.now()}`,
      date: now.toISOString(),
      focus: workout.focus,
      durationSeconds: actualDurationSeconds,
      startedAt: startedAtIso,
      endedAt: endedAtIso,
      exercises: finalExercises,
      completed: true,
    };
    await saveWorkoutSession(session);
    import('../utils/workoutReminders')
      .then(({ cancelTodayWorkoutReminder }) => cancelTodayWorkoutReminder())
      .catch(() => undefined);
    // Push completed status immediately so the watch exits active state.
    import('../utils/watchSync').then(({ pushWorkoutToWatch }) =>
      pushWorkoutToWatch(buildWatchWorkoutSnapshotRef.current(), {
        dateISO: dateKey(new Date()),
        status: 'completed',
        sessionId: watchSessionId.current,
        reason: 'complete',
      }).catch(() => {}),
    ).catch(() => {});
    // Snapshot the exact WorkoutDay the user just finished so plan
    // regeneration can't replace today's card with a different workout.
    await savePreservedCompletedWorkout(dateKey(now), workout);
    setFinishedSession(session);
    setFinishModalVisible(false);

    // Also persist completion to backend DB so it survives cache clears.
    // Now includes per-exercise per-set data so the backend can build
    // real WorkoutSession + WorkoutExercise + ExerciseSet rows for
    // downstream systems (plan reviewer, progression engine, analytics).
    let healthMetrics: { caloriesBurned?: number; hrSummary?: { avgBpm: number; maxBpm: number; zoneMinutes: number[] } } | undefined;
    let completedPrs: PRAchievement[] = [];
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
        const exercisesPayload = session.exercises
          .filter(ex => ex.sets.length > 0)
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
              order_index: idx,
              sets: ex.sets.map((s, si) => {
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
                  ...(isLast && distVal != null ? { actual_distance: distVal } : {}),
                  ...(isLast && paceVal ? { actual_pace: paceVal } : {}),
                  ...(isLast && hasExtras ? { cardio_metrics: extras } : {}),
                };
              }),
            };
          });
        const focusText = workout.focus.trim();
        const liftPlusCardioFocus = /\+\s*cardio/i.test(focusText);
        const cardioLikeFocus = /cardio|conditioning|zone\s*2|interval|hiit|run|bike|row|swim/i.test(focusText);
        const pureCardioFocus = !liftPlusCardioFocus
          && /^(cardio|conditioning|zone\s*2(?:\s*cardio)?|short intervals|long intervals|tempo)$/i.test(focusText);

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

        const sourceContext = (workout as any)._source_context ?? (workout as any).sourceContext ?? 'planned';
        const templateId = (workout as any)._template_id ?? (workout as any).templateId ?? null;
        const planDayId = (workout as any).plan_day_id ?? (workout as any).planDayId ?? null;
        const activityForCompletion = sourceContext === 'planned' ? undefined : {
          category: pureCardioFocus ? 'cardio' : 'strength',
          subtype: workout.focus.toLowerCase().replace(/\s+/g, '_'),
          intensity: workout.stimulus === 'strength' ? 'hard' : workout.stimulus === 'volume' ? 'easy' : 'moderate',
          cardioStyle: cardioLikeFocus ? (/interval|hiit/i.test(workout.focus) ? 'intervals' : 'steady') : undefined,
        };
        const completeResp = await logWorkoutDone(authToken, dateKey(now), workout.focus, actualDurationSeconds, exercisesPayload, activityForCompletion, healthMetrics, undefined, gearIdsForLog, {
          sourceContext,
          templateId,
          planDayId,
          stimulus: workout.stimulus ?? null,
          startedAt: startedAtIso,
          endedAt: endedAtIso,
          externalSourceId: session.id,
        });
        console.log('[workout] logWorkoutDone OK — fatigue should update on next load');

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
        setSessionPrs(prs);
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
          setPrModalData(prs);
        }
      }
    } catch (e) {
      console.warn('[workout] logWorkoutDone FAILED:', e);
    }

    // Show summary modal and fetch AI content
    setSummaryVisible(true);
    setSummaryLoading(true);
    setSummaryData(null);
    try {
      const canUseAiSummary = !!authToken && await cachedProfileIsPro();
      const establishedPrs = completedPrs.filter(isEstablishedPr);
      const fallbackSummary: WorkoutSummary = {
        caloriesBurned: healthMetrics?.caloriesBurned ?? 0,
        motivationMessage: 'Workout logged.',
        achievements: [],
        recommendations: [],
        headline: 'Workout logged',
        coachingPoint: 'Review your sets and add notes while the session is fresh.',
        motivation: '',
      };
      let s: WorkoutSummary | null = fallbackSummary;
      if (canUseAiSummary && authToken) {
        try {
          s = await getWorkoutSummary(authToken, {
            exercises: session.exercises,
            durationSeconds: session.durationSeconds,
            focus: session.focus,
            goal,
            weightLbs,
            caloriesBurned: healthMetrics?.caloriesBurned,
            hrSummary: healthMetrics?.hrSummary,
            prs: establishedPrs,
          });
        } catch (e) {
          console.log('[workout-summary] AI summary failed; using deterministic fallback:', (e as any)?.message ?? e);
          s = fallbackSummary;
        }
      }
      if (s) {
        // Reuse Apple Health data fetched before logWorkoutDone — no second fetch.
        if (healthMetrics?.caloriesBurned) (s as any).caloriesBurned = healthMetrics.caloriesBurned;
        if (healthMetrics?.hrSummary) {
          (s as any).hrAvg = healthMetrics.hrSummary.avgBpm;
          (s as any).hrMax = healthMetrics.hrSummary.maxBpm;
          (s as any).hrZoneMinutes = healthMetrics.hrSummary.zoneMinutes;
        }
        // Compute training score from what we just gathered. Fed into
        // the summary view + persisted on StoredWorkoutSummary so the
        // Progress chart can plot it against the day's readiness.
        try {
          const { computeTrainingScore, archetypeFromWorkout } = await import('../services/trainingScore');
          const setsCompleted = session.exercises.reduce((sum, ex) => sum + (ex.sets?.length ?? 0), 0);
          const originalPlannedSets = (workout.exercises ?? []).reduce((sum, ex: any) => sum + getTargetSetCount(ex.targetSets ?? ex.sets), 0);
          const currentPlannedSets = session.exercises.reduce((sum, ex) => sum + getTargetSetCount(ex.targetSets), 0);
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
            hrAvg: healthMetrics?.hrSummary?.avgBpm ?? null,
            hrMax: healthMetrics?.hrSummary?.maxBpm ?? null,
            hrZoneMinutes: healthMetrics?.hrSummary?.zoneMinutes
              ? healthMetrics.hrSummary.zoneMinutes.slice(0, 5) as [number, number, number, number, number]
              : null,
            progressionAchieved: establishedPrs.length > 0,
            hitTargetLoad,
          });
          (s as any).trainingScore = ts.score;
          (s as any).trainingRating = ts.rating;
          (s as any).trainingPillars = ts.pillars;
          (s as any).trainingPillarBreakdown = ts.pillarBreakdown;
          console.log(`[training-score] ${ts.score} (${ts.rating}) pillars=${JSON.stringify(ts.pillars)}`);
        } catch (e) {
          console.log('[training-score] compute failed (non-fatal):', e);
        }
        setSummaryData(s);
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
        }));
        await saveWorkoutSummary({
          ...s,
          id: session.id,
          date: session.date,
          focus: session.focus,
          durationSeconds: session.durationSeconds,
          totalSets,
          totalReps,
          startedAt: startedAtIso,
          endedAt: endedAtIso,
          exercises: exercisesForSummary,
        });
      }
    } catch {
      /* show basic summary without AI */
    } finally {
      setSummaryLoading(false);
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

  const completedCount = exercises.filter(e => e.sets.length >= getTargetSetCount(e.targetSets)).length;
  const totalLoggedSets = exercises.reduce((total, ex) => total + ex.sets.length, 0);
  const totalPlannedSets = exercises.reduce((total, ex) => total + getTargetSetCount(ex.targetSets), 0);
  const setCompletionPct = totalPlannedSets > 0
    ? Math.min(100, Math.round((Math.min(totalLoggedSets, totalPlannedSets) / totalPlannedSets) * 100))
    : 0;
  const coreCircuitExists = useMemo(() => hasCoreCircuit(exercises), [exercises]);
  const summaryDurationSeconds = finishedSession?.durationSeconds ?? elapsed;
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
  const workoutPostSummary = useMemo<WorkoutPostSummary | null>(() => {
    const sourceExercises = finishedSession?.exercises ?? exercises;
    if (!sourceExercises.length) return null;
    return {
      focus: workout.focus ?? 'Workout',
      duration_seconds: summaryDurationSeconds,
      date: dateKey(new Date()),
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
  }, [exercises, finishedSession, summaryData, summaryDurationSeconds, summaryRepCount, summarySetCount, workout.focus]);
  const shareBestSetHighlights = useMemo(
    () => buildWorkoutBestSetHighlights(
      finishedSession?.exercises ?? exercises,
      sessionPrs,
      4,
      summaryData?.achievements ?? [],
    ),
    [exercises, finishedSession?.exercises, sessionPrs, summaryData?.achievements],
  );

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
      content: photo ? `${effectiveQ} [photo attached]` : effectiveQ,
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
        movement_pattern: libraryItem?.movement_pattern ?? null,
      };
    });
  }, [exerciseLibraryByName, exercises]);
  const filteredExerciseLibrary: SmartSwapItem[] = useMemo(() => {
    const q = deferredExerciseSearch.trim().toLowerCase();
    if (swapTargetIdx != null) {
      const targetName = swapTargetExerciseName;
      const base = targetName ? exerciseLibrary.find(li => li.name === targetName) : undefined;
      if (!base) {
        return exerciseLibrary
          .filter(item => isExerciseUsableWithEquipment(item, ownedEquipment))
          .filter(item => !candidateConflictsWithActiveInjuries(item, activeInjuryTokens))
          .filter(item => !q || matchesExerciseSearch(item, q))
          .map(item => {
            const historySignal = exerciseHistorySignals[exerciseHistoryKey(item.name)];
            return {
              ...item,
              _swapNotes: buildSwapNotes(item, null, historySignal, activeInjuryTokens),
            };
          })
          .slice(0, 10);
      }
      const scored: Array<{ item: ExerciseLibraryItem; score: number; historySignal?: ExerciseHistorySignal }> = [];
      for (const item of exerciseLibrary) {
        if (item.name === targetName) continue;
        if (!isExerciseUsableWithEquipment(item, ownedEquipment)) continue;
        if (candidateConflictsWithActiveInjuries(item, activeInjuryTokens)) continue;
        if (q && !matchesExerciseSearch(item, q)) continue;
        const s = scoreSwapCandidate(base, item);
        if (s <= 0) continue;
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
      return scored.slice(0, 10).map(s => ({
        ...s.item,
        _overlap: Math.min(100, Math.round((s.score / SMART_SWAP_MAX_SCORE) * 100)),
        _swapNotes: buildSwapNotes(s.item, base, s.historySignal, activeInjuryTokens),
      }));
    }
    const searchableLibrary = exerciseLibrary
      .filter(item => !candidateConflictsWithActiveInjuries(item, activeInjuryTokens))
      .filter(item => !q || matchesExerciseSearch(item, q));
    return rankWorkoutAddCandidates(
      currentWorkoutAddContext,
      searchableLibrary,
      ownedEquipment,
      workout.focus,
      10,
    );
  }, [activeInjuryTokens, currentWorkoutAddContext, deferredExerciseSearch, exerciseHistorySignals, exerciseLibrary, ownedEquipment, swapTargetExerciseName, swapTargetIdx, workout.focus]);
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
            <View style={[styles.headerWorkoutTimer, { backgroundColor: workoutPalette.soft, borderColor: workoutPalette.strong + '44' }]}>
              <Ionicons name="time-outline" size={13} color={workoutPalette.strong} />
              <Text style={[styles.headerWorkoutTimerText, { color: workoutPalette.strong }]}>{formatTime(elapsed)}</Text>
            </View>
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
            <View style={styles.headerTitleBlock}>
              <Text style={styles.focusLabel} numberOfLines={1}>{workout.focus}</Text>
              <Text style={styles.headerMetaText} numberOfLines={1}>
                {totalLoggedSets}/{totalPlannedSets} sets logged
                {liveHR != null && liveHR > 0 && !currentLiveHRZone ? `  ·  ${liveHR} bpm` : ''}
                {watchSyncing ? '  ·  syncing watch…' : ''}
              </Text>
            </View>
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
          {restRemaining > 0 && (() => {
            const ringSize = 82;
            const ringStroke = 7;
            const ringRadius = (ringSize - ringStroke) / 2;
            const ringCircumference = 2 * Math.PI * ringRadius;
            const ringTotal = Math.max(restTotalSecondsRef.current || restDurationSeconds.current || restRemaining, restRemaining, 1);
            const ringProgress = Math.max(0, Math.min(1, restRemaining / ringTotal));
            const ringOffset = ringCircumference * (1 - ringProgress);
            const recommendation = [restNextTarget, restCue].filter(Boolean).join(' · ');
            const restRecommendationLoading = aiLoadingIdx != null
              && restForExercise != null
              && exercises[aiLoadingIdx]?.name === restForExercise;
            return (
              <View style={[styles.headerRestPanel, { backgroundColor: workoutPalette.soft, borderColor: workoutPalette.strong + '33' }]}>
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
                        stroke={restRemaining <= 10 ? themeColors.warning : workoutPalette.strong}
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
                    <Text style={[styles.headerRestCircleValue, { color: restRemaining <= 10 ? themeColors.warning : workoutPalette.strong }]}>
                      {formatTime(restRemaining)}
                    </Text>
                  </View>
                  <View style={styles.headerRestCopy}>
                    {restForExercise ? <Text style={styles.headerRestExercise} numberOfLines={1}>{restForExercise}</Text> : null}
                    {recommendation || restRecommendationLoading ? (
                      <View style={styles.headerRestRecommendation}>
                        <View style={styles.headerRestInfoRow}>
                          <Text style={styles.headerRestInfoLabel}>Recommendation</Text>
                          {restRecommendationLoading && (
                            <ActivityIndicator size="small" color={workoutPalette.strong} />
                          )}
                        </View>
                        {recommendation ? (
                          <Text style={[styles.headerRestTarget, { color: workoutPalette.strong }]}>{recommendation}</Text>
                        ) : (
                          <Text style={[styles.headerRestTarget, { color: themeColors.textSecondary }]}>Updating next set...</Text>
                        )}
                      </View>
                    ) : null}
                    {showRestRecommendationTutorial && recommendation ? (
                      <View style={styles.headerRestTutorial}>
                        <Ionicons name="sparkles-outline" size={13} color={workoutPalette.strong} />
                        <Text style={styles.headerRestTutorialText}>
                          Rest guidance updates after logged sets so the next target stays visible.
                        </Text>
                        <TouchableOpacity style={styles.headerRestTutorialButton} onPress={dismissRestRecommendationTutorial}>
                          <Text style={styles.headerRestTutorialButtonText}>Got it</Text>
                        </TouchableOpacity>
                      </View>
                    ) : null}
                    {(() => {
                      if (Platform.OS !== 'ios') return null;
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
                    })()}
                  </View>
                </View>
                <View style={styles.headerRestActions}>
                  <TouchableOpacity style={styles.headerRestBtn} onPress={() => adjustActiveRestRemaining(-15)}>
                    <Text style={styles.headerRestBtnText}>-15</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.headerRestBtn} onPress={() => adjustActiveRestRemaining(15)}>
                    <Text style={styles.headerRestBtnText}>+15</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.headerRestBtn, { backgroundColor: workoutPalette.strong, borderColor: workoutPalette.strong }]} onPress={() => clearRestState()}>
                    <Text style={[styles.headerRestBtnText, { color: themeColors.background }]}>Skip</Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          })()}
        </LinearGradient>
      </View>

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

      {/* Exercise list */}
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
          const targetSetCount  = getTargetSetCount(ex.targetSets);
          // Effective set count: base target + user-added extras, minus
          // any unlogged sets they've explicitly removed. Clamped so we
          // never go below the number of already-logged sets.
          const rawTotal        = targetSetCount + (extraSetCounts[i] ?? 0) - (removedSetCounts[i] ?? 0);
          const totalSetCount   = Math.max(ex.sets.length, rawTotal);
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
            ? Math.max(...circuitRun.map(idx => getTargetSetCount(exercises[idx]?.targetSets)))
            : targetSetCount;
          const circuitRestSeconds = isCircuitItem
            ? Math.max(...circuitRun.map(idx => Number(exercises[idx]?.targetRestSeconds) || 0))
            : 0;
          const libraryItem = exerciseLibraryByName.get(ex.name.toLowerCase());
          const gear = libraryItem?.gear?.[0] ?? null;
          const fallbackEquipment = formatEquipmentLabel(ex.equipment);
          const exerciseEquipmentVisual = gear ?? (fallbackEquipment ? { name: fallbackEquipment } : null);
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
              <View
                testID={`exercise-card-${i}`}
                style={[
                  styles.exerciseCard,
                  isCircuitItem && styles.liveCircuitExerciseCard,
                  isCircuitItem && { borderLeftColor: workoutPalette.strong },
                  isDone && styles.exerciseCardDone,
                  isActive && styles.exerciseCardActive,
                  isActive && {
                    borderColor: workoutPalette.strong,
                    shadowColor: workoutPalette.strong,
                  },
                ]}>
              {isActive && (
                <View
                  pointerEvents="none"
                  style={[styles.exerciseActiveRail, { backgroundColor: workoutPalette.strong }]}
                />
              )}

              {/* ── Header row: tap to expand/collapse ── */}
              <TouchableOpacity
                style={styles.exerciseHeader}
                onPress={() => { configureLiveLayoutAnimation(); setActiveExIdx(isActive ? -1 : i); import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {}); }}
                activeOpacity={0.7}>
                {(() => {
                  const thumbUri = exerciseThumbSmall(ex as any);
                  return thumbUri ? (
                    <TouchableOpacity
                      activeOpacity={0.85}
                      // Nested Touchable — inner captures the tap so the
                      // outer exerciseHeader doesn't also expand/collapse
                      // when the user wants the form video.
                      onPress={() => {
                        import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
                        openFormVideoForExercise(ex);
                      }}
                      style={{
                        width: 46, height: 46, borderRadius: 10, marginRight: 10,
                        backgroundColor: themeColors.surfaceRaised,
                        borderWidth: 1.5, borderColor: themeColors.primary,
                        position: 'relative',
                        shadowColor: themeColors.primary,
                        shadowOffset: { width: 0, height: 0 },
                        shadowOpacity: 0.75,
                        shadowRadius: 8,
                        elevation: 6,
                      }}>
                      <View style={{ width: '100%', height: '100%', borderRadius: 8, overflow: 'hidden' }}>
                        <Image source={{ uri: thumbUri }} style={{ width: 40, height: 40 }} resizeMode="cover" />
                        <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(255,255,255,0.18)' }} />
                        <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
                          <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' }}>
                            <Ionicons name="play" size={9} color="#fff" style={{ marginLeft: 1 }} />
                          </View>
                        </View>
                      </View>
                    </TouchableOpacity>
                  ) : null;
                })()}
                <View style={{ flex: 1, minWidth: 0 }}>
                  {isCircuitItem && (
                    <Text style={[styles.liveCircuitStationText, { color: workoutPalette.strong }]}>
                      Station A{circuitPosition + 1}
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

              {isActive && exerciseEquipmentVisual ? (
                <View style={styles.exerciseEquipmentPreview}>
                  <EquipmentImageCard
                    equipment={exerciseEquipmentVisual}
                    label={exerciseEquipmentVisual.name}
                    subtitle="Equipment setup"
                    themeColors={themeColors}
                    accentColor={workoutPalette.strong}
                    compact
                  />
                </View>
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

                  {/* ── Exercise-specific warm-up note — hidden once first set is logged ── */}
                  {ex.sets.length === 0 && (() => {
                    const note = getExerciseWarmupNote(ex.name, i === 0, {
                      isCompound: ex.isCompound ?? undefined,
                    });
                    return note ? (
                      <View style={styles.warmupNoteCard}>
                        <Text style={styles.warmupNoteText}>{note}</Text>
                      </View>
                    ) : null;
                  })()}

                  {/* ── Pre-set coach hint (first set only, before
                       anything is logged). Clean label + weight; no
                       rationale text so it can't truncate. */}
                  {!guide && ex.sets.length === 0 && preSetHints[i] && preSetHints[i].recommendedWeight != null && (
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
                  {!guide && ex.sets.length === 0 && preSetLoadingIdx === i && !preSetHints[i] && (
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

                  {/* ── Form video link ── */}
                  <TouchableOpacity
                    style={styles.formVideoLink}
                    onPress={() => openFormVideoForExercise(ex)}
                    activeOpacity={0.7}>
                    <Text style={styles.formVideoLinkText}>▶ Form Video</Text>
                  </TouchableOpacity>

                  {/* ── RIR prompt — shown after an over-target set ── */}
                  {!guide && pendingRir && pendingRir.exIdx === i && (
                    <View style={[styles.aiBubble, { backgroundColor: workoutPalette.strong + '15', borderColor: workoutPalette.strong + '55', borderWidth: 1, flexDirection: 'column', alignItems: 'stretch', gap: 6 }]}>
                      <Text style={{ fontSize: 12, fontWeight: '800', color: workoutPalette.text }}>
                        Nice — how many more reps could you have done?
                      </Text>
                      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                        {[0, 1, 2, 3, 4].map(rir => {
                          const label = rir === 4 ? '4+' : String(rir);
                          return (
                            <TouchableOpacity
                              key={rir}
                              onPress={() => {
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
                                setExercises(prev => prev.map((e, ei) => {
                                  if (ei !== i) return e;
                                  const sets = e.sets.slice();
                                  if (sets[setIdx]) sets[setIdx] = { ...sets[setIdx], rir };
                                  return { ...e, sets, aiRecommendation: suggestion?.fullText ?? e.aiRecommendation };
                                }));
                                if (suggestion) {
                                  setRestNextTarget(suggestion.nextTarget);
                                  setRestCue(suggestion.cue);
                                  import('../utils/watchSync').then(({ pushProgressToWatch }) =>
                                    pushProgressToWatch({ recommendation: suggestion.watchText })
                                  ).catch(() => undefined);
                                  if (liveActivityIdRef.current && liveActivityTimerKeyRef.current == null) {
                                    updateRestActivity(liveActivityIdRef.current, {
                                      setNumber: updatedSets.length,
                                      totalSets: getEffectiveTargetSetCount(i, exercises[i], updatedSets.length),
                                      nextSetRecommendation: suggestion.watchText,
                                      exerciseName: exercises[i].name,
                                      themeColorHex: theme.colors.primary,
                                    }).catch(() => undefined);
                                  }
                                }
                                setPendingRir(null);
                                maybeRefreshRecommendationForExercise(i, updatedSets);
                              }}
                              style={{ flex: 1, minWidth: 44, paddingVertical: 8, borderRadius: 8, alignItems: 'center', backgroundColor: workoutPalette.strong }}>
                              <Text style={{ color: getContrastingTextColor(workoutPalette.strong), fontSize: 13, fontWeight: '800' }}>{label}</Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                      <TouchableOpacity onPress={() => {
                        setPendingRir(null);
                        maybeRefreshRecommendationForExercise(i, exercises[i].sets, { ignorePendingRir: true });
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
                    const timed = isTimedExercise(ex.name, ex.targetReps);
                    const isMultiInterval = timed && totalSetCount >= 2;
                    return (
                      <>
                        {/* ── Prominent timer for timed exercises ── */}
                        {timed && isActive && (() => {
                          const currentSlot = ex.sets.length;
                          const allDone = currentSlot >= totalSetCount;
                          const timerKey = `${i}-${currentSlot < totalSetCount ? currentSlot : totalSetCount - 1}`;
                          const timerRunning = activeTimers[timerKey]?.running ?? false;
                          const timerElapsed = getTimerElapsed(timerKey);
                          const timerMM = Math.floor(timerElapsed / 60).toString().padStart(2, '0');
                          const timerSS = (timerElapsed % 60).toString().padStart(2, '0');
                          return (
                            <View style={{ alignItems: 'center', paddingVertical: 16, gap: 8 }}>
                              {isMultiInterval && (
                                <Text style={{ fontSize: 13, fontWeight: '700', color: themeColors.textMuted }}>
                                  {allDone ? 'All rounds complete' : `Round ${currentSlot + 1} of ${totalSetCount}`}
                                </Text>
                              )}
                              <TouchableOpacity onPress={() => { if (!allDone) setTimerModalKey(timerKey); }} activeOpacity={0.7}>
                                <Text style={{
                                  fontSize: 56, fontWeight: '900', fontVariant: ['tabular-nums'] as any,
                                  letterSpacing: -1,
                                  color: allDone ? themeColors.textMuted : timerRunning ? themeColors.primary : themeColors.textPrimary,
                                }}>
                                  {timerMM}:{timerSS}
                                </Text>
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
                          return (
                            <Fragment key={slot}>
                            <Animated.View
                              style={[styles.inlineSetRow, isLogged && styles.inlineSetRowDone, { backgroundColor: pulseBg }]}>
                              <Text style={styles.inlineSetNum}>{slot + 1}</Text>
                              {!hideWeight && <AnimatedTextInput
                                testID={`set-weight-input-${i}-${slot}`}
                                style={[
                                  styles.inlineInput,
                                  isLogged && styles.inlineInputDone,
                                  // Override border props with animated values on unlogged
                                  // rows. Logged rows keep the "done" tint so the user can
                                  // see at a glance which sets are already written.
                                  !isLogged && { borderColor: weightBorderColor, borderWidth: weightBorderWidth },
                                ]}
	                                value={isLogged ? (editingSetKey === inputKey ? (editDraft.weight ?? displayWeightNumber(logged.weightLbs)) : displayWeightNumber(logged.weightLbs)) : input.weight}
                                onChangeText={v => {
                                  if (isLogged) {
                                    setEditingSetKey(inputKey);
                                    setEditDraft(prev => ({ ...prev, weight: v }));
                                  } else {
                                    setSetInputs(prev => ({ ...prev, [inputKey]: { ...prev[inputKey] ?? { weight: '', reps: '', duration: '' }, weight: v } }));
                                  }
                                }}
                                onFocus={() => setInputFocus(weightFocusKey, true)}
                                onBlur={() => setInputFocus(weightFocusKey, false)}
                                onEndEditing={() => {
                                  if (isLogged && editingSetKey === inputKey) {
                                    commitInlineEdit(i, slot);
                                  } else if (!isLogged) {
                                    handleLogSetInline(i, slot, true);
                                  }
                                }}
                                keyboardType="decimal-pad"
	                                placeholder={exerciseWeightSuffix(ex)}
                                placeholderTextColor={themeColors.textMuted}
                                selectTextOnFocus
                              />}
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
                              ) : (
                                <TextInput
                                  testID={`set-reps-input-${i}-${slot}`}
                                  style={[styles.inlineInput, isLogged && styles.inlineInputDone]}
                                  value={isLogged ? (editingSetKey === inputKey ? (editDraft.reps ?? String(logged.reps)) : String(logged.reps)) : input.reps}
                                  onChangeText={v => {
                                    if (isLogged) {
                                      setEditingSetKey(inputKey);
                                      setEditDraft(prev => ({ ...prev, reps: v }));
                                    } else {
                                      setSetInputs(prev => ({ ...prev, [inputKey]: { ...prev[inputKey] ?? { weight: '', reps: '', duration: '' }, reps: v } }));
                                    }
                                  }}
                                  onEndEditing={() => {
                                    if (isLogged && editingSetKey === inputKey) {
                                      commitInlineEdit(i, slot);
                                    } else if (!isLogged) {
                                      handleLogSetInline(i, slot, true);
                                    }
                                  }}
                                  keyboardType="number-pad"
                                  placeholder="reps"
                                  placeholderTextColor={themeColors.textMuted}
                                  selectTextOnFocus
                                />
                              )}
                              <Text
                                testID={`set-last-time-${i}-${slot}`}
                                accessibilityLabel={`Last time set ${slot + 1}: ${lastTimeLabel}`}
                                style={styles.inlineLastResult}
                                numberOfLines={1}>
                                {lastTimeLabel}
                              </Text>
                              {(() => {
                                const badgeKey = `${i}-${slot}`;
                                const badgeScale = getSetBadgeScale(badgeKey);
                                return (
                                  <TouchableOpacity
                                    testID={`log-set-${i}-${slot}`}
                                    style={[styles.inlineLoggedBadge, !isLogged && styles.inlineLoggedBadgePending]}
                                    onPress={() => {
                                      if (!isLogged) { handleLogSetInline(i, slot, false); }
                                    }}
                                    accessibilityRole="button"
                                    accessibilityLabel={isLogged ? `Set ${slot + 1} logged` : `Log set ${slot + 1}`}
                                  >
                                    <Animated.View style={{ transform: [{ scale: badgeScale }] }}>
                                      <Text style={[styles.inlineLoggedBadgeText, !isLogged && { color: themeColors.textMuted }]}>
                                        {isLogged
                                          ? <Ionicons name="checkmark" size={14} color={themeColors.background} />
                                          : <Ionicons name="radio-button-off" size={14} />}
                                      </Text>
                                    </Animated.View>
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
                            </Fragment>
                          );
                        })}
                      </>
                    );
                  })()}

                  {(() => {
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
            </Fragment>
          );
        })}

        {/* Add Exercise — outside/below exercise cards */}
        {warmupDone && (
          <>
            {!coreCircuitExists && (
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
            <TouchableOpacity style={styles.addExerciseBtn} onPress={openAddExerciseModal}>
              <Text style={styles.addExerciseBtnText}>+ Add Exercise</Text>
            </TouchableOpacity>
            <PressableScale
              testID="finish-workout-button"
              style={[
                styles.finishBtn,
                totalLoggedSets > 0 && {
                  backgroundColor: workoutPalette.strong,
                  borderColor: workoutPalette.strong,
                  shadowColor: workoutPalette.strong,
                },
                totalLoggedSets === 0 && styles.finishBtnDisabled,
              ]}
              disabled={totalLoggedSets === 0}
              accessibilityRole="button"
              accessibilityLabel="Finish workout"
              onPress={() => {
                if (totalLoggedSets === 0) {
                  Alert.alert('No sets logged', 'Log at least one set before finishing.');
                  return;
                }
                import('../utils/feedback').then(f => f.hapticMedium()).catch(() => {});
                setFinishModalVisible(true);
              }}>
              <Text style={[styles.finishBtnText, totalLoggedSets === 0 && styles.finishBtnTextDisabled]}>
                <Ionicons
                  name="checkmark-circle"
                  size={16}
                  color={totalLoggedSets > 0 ? themeColors.background : themeColors.textMuted}
                />{' '}
                Finish Workout
              </Text>
            </PressableScale>
          </>
        )}
      </ScrollView>

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
          const mRunning = activeTimers[timerModalKey]?.running ?? false;
          const mElapsed = getTimerElapsed(timerModalKey);
          const mMM = Math.floor(mElapsed / 60).toString().padStart(2, '0');
          const mSS = (mElapsed % 60).toString().padStart(2, '0');
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
                  const thumbUri = mEx ? exerciseThumbSmall(mEx as any) : null;
                  return thumbUri ? (
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
                        <Image source={{ uri: thumbUri }} style={{ width: 64, height: 64 }} resizeMode="cover" />
                        <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(255,255,255,0.18)' }} />
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
                {getTargetSetCount(mEx?.targetSets) >= 2 ? (
                  <Text style={[styles.timerModalTargetReps, { color: themeColors.textMuted }]}>
                    Round {mSlot + 1} of {getTargetSetCount(mEx?.targetSets)} · Target: {mEx?.targetReps ?? '—'}
                  </Text>
                ) : (
                  <Text style={[styles.timerModalTargetReps, { color: themeColors.textMuted }]}>
                    Target: {mEx?.targetReps ?? '—'}
                  </Text>
                )}
                <Text style={[styles.timerModalDigits, { color: mRunning ? themeColors.primary : themeColors.textPrimary }]}>
                  {mMM}:{mSS}
                </Text>
                <Text style={[styles.timerModalStateHint, { color: themeColors.textMuted }]}>
                  {mRunning ? 'Running — screen can lock, timer keeps counting' : mElapsed > 0 ? 'Paused' : 'Ready'}
                </Text>

                <View style={styles.timerModalControls}>
                  {mRunning ? (
                    <TouchableOpacity
                      style={[styles.timerModalBigBtn, { backgroundColor: '#E53935' }]}
                      onPress={() => stopExerciseTimer(timerModalKey)}
                      accessibilityRole="button"
                      accessibilityLabel="Pause timer">
                      <Text style={styles.timerModalBigBtnText}>Pause</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      style={[styles.timerModalBigBtn, { backgroundColor: themeColors.primary }]}
                      onPress={() => startExerciseTimer(timerModalKey)}
                      accessibilityRole="button"
                      accessibilityLabel={mElapsed > 0 ? 'Resume timer' : 'Start timer'}>
                      <Text style={[styles.timerModalBigBtnText, { color: getContrastingTextColor(themeColors.primary) }]}>
                        {mElapsed > 0 ? 'Resume' : 'Start'}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>

                <View style={styles.timerModalSecondaryRow}>
                  <TouchableOpacity
                    style={[styles.timerModalSecondaryBtn, { borderColor: themeColors.border }]}
                    onPress={() => resetExerciseTimer(timerModalKey)}
                    accessibilityRole="button"
                    accessibilityLabel="Reset timer">
                    <Text style={[styles.timerModalSecondaryBtnText, { color: themeColors.textSecondary }]}>Reset</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.timerModalSecondaryBtn, { backgroundColor: themeColors.primary, borderColor: themeColors.primary }]}
                    onPress={writeDurationAndClose}
                    accessibilityRole="button"
                    accessibilityLabel={mElapsed > 0 ? 'Done with timer' : 'Close timer'}>
                    <Text style={[styles.timerModalSecondaryBtnText, { color: getContrastingTextColor(themeColors.primary), fontWeight: '800' }]}>
                      {mElapsed > 0 ? 'Done' : 'Close'}
                    </Text>
                  </TouchableOpacity>
                </View>
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
      <Modal visible={finishModalVisible} transparent animationType="fade" onRequestClose={() => setFinishModalVisible(false)}>
        <View style={styles.finishBackdrop}>
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
                <Text style={styles.finishModalStatValue}>{formatTime(elapsed)}</Text>
                <Text style={styles.finishModalStatLabel}>Time</Text>
              </View>
              <View style={styles.finishModalDivider} />
              <View style={styles.finishModalStat}>
                <Text style={styles.finishModalStatValue}>{completedCount}/{exercises.length}</Text>
                <Text style={styles.finishModalStatLabel}>Exercises</Text>
              </View>
              <View style={styles.finishModalDivider} />
              <View style={styles.finishModalStat}>
                <Text style={styles.finishModalStatValue}>{totalLoggedSets}</Text>
                <Text style={styles.finishModalStatLabel}>Sets</Text>
              </View>
            </View>
            <TouchableOpacity
              testID="finish-workout-confirm-save"
              accessibilityLabel="finish-workout-confirm-save"
              style={styles.finishConfirmBtn}
              onPress={handleFinish}>
              <Text style={styles.finishConfirmText}>Save and Finish</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="finish-workout-confirm-cancel"
              accessibilityLabel="finish-workout-confirm-cancel"
              onPress={() => setFinishModalVisible(false)}>
              <Text style={styles.finishCancelText}>Keep Going</Text>
            </TouchableOpacity>
          </FadeInView>
        </View>
      </Modal>

      {/* Post-Workout Summary Modal */}
      <Modal visible={summaryVisible} transparent animationType="slide" onRequestClose={dismissSummaryModal}>
        <View style={styles.summaryBackdrop}>
          <ScrollView contentContainerStyle={styles.summaryScroll} keyboardShouldPersistTaps="handled">

            {/* ── Shareable Workout Summary Card ────────────────────── */}
              <FadeInView testID="post-workout-summary" style={styles.summaryModal} duration={360} slideDistance={18}>
                <ViewShot ref={summaryCardRef} options={{ format: 'png', quality: 1 }}>
                  <View style={styles.shareCard}>
                    <LinearGradient
                      colors={[themeColors.primary + '26', themeColors.surface]}
                      style={styles.shareHero}>
                      <View style={styles.shareCardHeader}>
                        <Image
                          source={themeColors.background === '#000000' || themeColors.background < '#444444' ? SHARE_LOGO_DARK : SHARE_LOGO_LIGHT}
                          style={styles.shareCardLogo}
                          resizeMode="contain"
                        />
                        <View style={styles.shareCardDateBadge}>
                          <Text style={styles.shareCardDateText}>
                            {(() => { const d = new Date(); return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`; })()}
                          </Text>
                        </View>
                      </View>
                      <View style={styles.shareHeroBody}>
                        <Text style={styles.shareKicker}>Workout Complete</Text>
                        <Text style={styles.shareCardFocus} numberOfLines={2}>{workout.focus}</Text>
                        <View style={styles.shareCompletionRow}>
                          <Text style={styles.shareCompletionText}>{setCompletionPct}% complete</Text>
                          <Text style={styles.shareCompletionText}>{summarySetCount} sets logged</Text>
                        </View>
                        <View style={styles.shareCompletionTrack}>
                          <View
                            style={[
                              styles.shareCompletionFill,
                              { width: `${setCompletionPct}%`, backgroundColor: workoutPalette.strong },
                            ]}
                          />
                        </View>
                      </View>
                    </LinearGradient>

                    {/* Stats grid */}
                    <View style={styles.shareStatsGrid}>
                      <View style={styles.shareStatTile}>
                        <Ionicons name="time-outline" size={16} color={themeColors.textMuted} />
                        <Text style={styles.shareStatValue}>{formatTime(summaryDurationSeconds)}</Text>
                        <Text style={styles.shareStatLabel}>Duration</Text>
                      </View>
                      <View style={styles.shareStatTile}>
                        <Ionicons name="barbell" size={16} color={themeColors.textMuted} />
                        <Text style={styles.shareStatValue}>{summarySetCount}</Text>
                        <Text style={styles.shareStatLabel}>Sets</Text>
                      </View>
                      <View style={styles.shareStatTile}>
                        <Ionicons name="fitness" size={16} color={themeColors.textMuted} />
                        <Text style={styles.shareStatValue}>{completedCount}/{exercises.length}</Text>
                        <Text style={styles.shareStatLabel}>Exercises</Text>
                      </View>
                      {summaryRepCount > 0 ? (
                        <View style={styles.shareStatTile}>
                          <Ionicons name="repeat-outline" size={16} color={themeColors.textMuted} />
                          <Text style={styles.shareStatValue}>{summaryRepCount}</Text>
                          <Text style={styles.shareStatLabel}>Reps</Text>
                        </View>
                      ) : null}
                    </View>
                    {(summaryData?.caloriesBurned || summaryData?.hrAvg || summaryData?.hrMax) ? (
                      <View style={styles.shareMiniMetrics}>
                        {summaryData?.caloriesBurned ? (
                          <View style={styles.shareMiniChip}>
                            <Ionicons name="flame" size={12} color={themeColors.textMuted} />
                            <Text style={styles.shareMiniChipText}>~{summaryData.caloriesBurned} cal</Text>
                          </View>
                        ) : null}
                        {summaryData?.hrAvg ? (
                          <View style={styles.shareMiniChip}>
                            <Ionicons name="pulse" size={12} color={themeColors.textMuted} />
                            <Text style={styles.shareMiniChipText}>{summaryData.hrAvg} avg HR</Text>
                          </View>
                        ) : null}
                        {summaryData?.hrMax ? (
                          <View style={styles.shareMiniChip}>
                            <Ionicons name="heart" size={12} color={themeColors.textMuted} />
                            <Text style={styles.shareMiniChipText}>{summaryData.hrMax} peak HR</Text>
                          </View>
                        ) : null}
                      </View>
                    ) : null}
                    {summaryData?.trainingScore != null && (() => {
                      const score = summaryData.trainingScore!;
                      const scoreColor = score >= 85 ? themeColors.success
                        : score >= 65 ? themeColors.primary
                        : score >= 45 ? themeColors.warning
                        : themeColors.error;
                      const legacyPillars = summaryData.trainingPillars ?? { effort: 0, volume: 0, duration: 0, consistency: 0 };
                      const dynamicPillars = Array.isArray(summaryData.trainingPillarBreakdown)
                        ? summaryData.trainingPillarBreakdown
                          .map(pillar => ({
                            key: String(pillar.key ?? ''),
                            label: String(pillar.label ?? pillar.key ?? 'Pillar'),
                            value: Math.max(0, Math.round(Number(pillar.value) || 0)),
                            max: Math.max(0, Math.round(Number(pillar.max) || 0)),
                          }))
                          .filter(pillar => pillar.max > 0)
                        : [];
                      const shortPillarLabel = (key: string, label: string): string => {
                        if (key === 'zoneCompliance') return 'Z2';
                        if (key === 'intervalIntensity') return 'Intervals';
                        if (key === 'workRestCompletion') return 'Work/rest';
                        if (key === 'movementCompletion') return 'Moves';
                        if (key === 'lowIntensityCompliance') return 'Low HR';
                        if (key === 'duration') return 'Time';
                        return label;
                      };
                      const displayPillars = dynamicPillars.length > 0
                        ? dynamicPillars
                        : [
                          { key: 'effort', label: 'Effort', value: legacyPillars.effort, max: 40 },
                          { key: 'volume', label: 'Volume', value: legacyPillars.volume, max: 25 },
                          { key: 'duration', label: 'Time', value: legacyPillars.duration, max: 20 },
                          { key: 'consistency', label: 'Consistency', value: legacyPillars.consistency, max: 15 },
                        ];
                      const compactPillars = displayPillars
                        .slice(0, dynamicPillars.length > 0 ? 3 : 4)
                        .map(pillar => `${shortPillarLabel(pillar.key, pillar.label)} ${pillar.value}/${pillar.max}`)
                        .join(' · ');
                      const tipFor = (key: string): string => {
                        if (key === 'zoneCompliance') return 'Hold the recommended Zone 2 range more consistently.';
                        if (key === 'intervalIntensity') return 'Push the hard intervals into the prescribed HR range.';
                        if (key === 'workRestCompletion') return 'Complete the planned intervals and recoveries.';
                        if (key === 'movementCompletion') return 'Complete every planned movement.';
                        if (key === 'lowIntensityCompliance') return 'Keep recovery work easy and controlled.';
                        if (key === 'hr') return 'Spend more of the session in the intended heart-rate range.';
                        if (key === 'stimulus' || key === 'effort') return 'Match the prescribed workout intensity.';
                        if (key === 'volume') return 'Complete all planned sets.';
                        if (key === 'duration') return 'Train 85-120% of the estimated session duration.';
                        if (key === 'progression') return 'Beat a previous mark or hit the prescribed load target.';
                        return 'Complete more of the planned session.';
                      };
                      return (
                        <View>
                          <TouchableOpacity
                            activeOpacity={0.85}
                            onPress={() => setShowTrainingDetails(v => !v)}
                            style={{
                              flexDirection: 'row', alignItems: 'center',
                              backgroundColor: themeColors.surfaceRaised ?? themeColors.surface,
                              borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
                              marginHorizontal: 14, marginTop: 8, marginBottom: 4, gap: 12,
                              borderWidth: 1, borderColor: themeColors.border,
                            }}
                          >
                            <View style={{ alignItems: 'flex-start' }}>
                              <AnimatedNumber
                                value={score}
                                duration={900}
                                style={{ fontSize: 32, fontWeight: '900', lineHeight: 36, color: scoreColor }}
                              />
                              <Text style={{ fontSize: 8, fontWeight: '700', color: themeColors.textMuted, letterSpacing: 0.5, marginTop: 1 }}>
                                TRAINING SCORE
                              </Text>
                            </View>
                            <View style={{ width: 1, height: 32, backgroundColor: themeColors.border }} />
                            <View style={{ flex: 1 }}>
                              <Text style={{ fontSize: 13, fontWeight: '800', color: themeColors.textPrimary, marginBottom: 2 }}>
                                {summaryData.trainingRating ?? '—'}
                              </Text>
                              <Text style={{ fontSize: 10, color: themeColors.textMuted, lineHeight: 13 }}>
                                {compactPillars}
                              </Text>
                            </View>
                            <Ionicons
                              name={showTrainingDetails ? 'chevron-up' : 'chevron-down'}
                              size={14}
                              color={themeColors.textMuted}
                            />
                          </TouchableOpacity>

                          {showTrainingDetails && (
                            <View style={{
                              backgroundColor: themeColors.surfaceRaised ?? themeColors.surface,
                              borderRadius: 10, padding: 12, marginHorizontal: 14, marginTop: -2, marginBottom: 6, gap: 8,
                              borderWidth: 1, borderColor: themeColors.border,
                            }}>
                              <Text style={{ fontSize: 10, fontWeight: '800', color: themeColors.textMuted, letterSpacing: 0.5 }}>
                                HOW THIS IS SCORED
                              </Text>
                              {displayPillars.map(pillar => {
                                const value = pillar.value;
                                const max = pillar.max || 1;
                                const deficit = Math.max(0, max - value);
                                const pct = Math.max(0, Math.min(100, Math.round((value / max) * 100)));
                                const label = shortPillarLabel(pillar.key, pillar.label);
                                const barColor = pct >= 90 ? themeColors.success : pct >= 60 ? themeColors.primary : themeColors.warning;
                                return (
                                  <View key={pillar.key} style={{ gap: 3 }}>
                                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                                      <Text style={{ fontSize: 12, fontWeight: '700', color: themeColors.textPrimary, flex: 1 }}>
                                        {label}
                                      </Text>
                                      <Text style={{ fontSize: 12, fontWeight: '800', color: barColor }}>
                                        {value}/{max}
                                      </Text>
                                      {deficit > 0 && (
                                        <Text style={{ fontSize: 10, fontWeight: '700', color: themeColors.textMuted }}>
                                          (+{deficit} to max)
                                        </Text>
                                      )}
                                    </View>
                                    <View style={{ height: 4, backgroundColor: themeColors.border, borderRadius: 2, overflow: 'hidden' }}>
                                      <View style={{ width: `${pct}%`, height: 4, backgroundColor: barColor, borderRadius: 2 }} />
                                    </View>
                                    {deficit > 0 && (
                                      <Text style={{ fontSize: 10, color: themeColors.textMuted, lineHeight: 13 }}>
                                        {tipFor(pillar.key)}
                                      </Text>
                                    )}
                                  </View>
                                );
                              })}
                              <Text style={{ fontSize: 9, color: themeColors.textMuted, fontStyle: 'italic', marginTop: 2, lineHeight: 12 }}>
                                Score uses the workout archetype, so cardio days prioritize zones and time while lift days prioritize sets and load.
                              </Text>
                            </View>
                          )}
                        </View>
                      );
                    })()}

                    {summaryData?.hrZoneMinutes && summaryData.hrZoneMinutes.some(m => m > 0) ? (
                      <View style={{ marginHorizontal: 14, marginTop: 4, marginBottom: 6, paddingHorizontal: 2 }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                          <Text style={{ fontSize: 9, fontWeight: '800', color: themeColors.textMuted, letterSpacing: 0.5 }}>
                            TIME IN ZONES
                          </Text>
                          <Text style={{ fontSize: 9, color: themeColors.textMuted }}>
                            {Math.round(summaryData.hrZoneMinutes!.reduce((a, b) => a + b, 0))}m total
                          </Text>
                        </View>
                        {/* Single horizontal stack bar — proportional segments
                            per zone. Replaces the 5-row stack to save ~80px
                            of vertical space without losing information. */}
                        {(() => {
                          const zones = summaryData.hrZoneMinutes!;
                          const total = zones.reduce((a, b) => a + b, 0);
                          if (total <= 0) return null;
                          return (
                            <View style={{ flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: themeColors.border, marginBottom: 6 }}>
                              {zones.map((m, i) => {
                                if (m <= 0) return null;
                                const flex = m / total;
                                return <View key={i} style={{ flex, backgroundColor: hrZoneColorHex(i + 1, themeColors.primary) }} />;
                              })}
                            </View>
                          );
                        })()}
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                          {(['Z1', 'Z2', 'Z3', 'Z4', 'Z5'] as const).map((label, i) => {
                            const min = summaryData.hrZoneMinutes![i];
                            const zoneColor = hrZoneColorHex(i + 1, themeColors.primary);
                            const isEmpty = min < 0.5;
                            return (
                              <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: isEmpty ? themeColors.textMuted + '40' : zoneColor }} />
                                <Text style={{ fontSize: 10, fontWeight: '600', color: isEmpty ? themeColors.textMuted : themeColors.textSecondary }}>
                                  {label} {isEmpty ? '—' : `${Math.round(min)}m`}
                                </Text>
                              </View>
                            );
                          })}
                        </View>
                      </View>
                    ) : null}

                    {/* Best sets */}
                    {shareBestSetHighlights.length > 0 && (
                      <View style={styles.shareAchievements}>
                        <Text style={styles.shareAchievementsTitle}>Best Sets</Text>
                        {shareBestSetHighlights.map((highlight) => (
                          <View key={highlight.key} style={styles.shareAchievementRow}>
                            <Text style={styles.shareAchievementBullet}><Ionicons name="chevron-forward" size={12} /></Text>
                            <Text style={styles.shareAchievementText}>{highlight.label}</Text>
                          </View>
                        ))}
                      </View>
                    )}

                    {/* AI recap — prefer structured v2 fields when present */}
                    {summaryData?.headline ? (
                      <View style={styles.shareMotivation}>
                        <Text style={styles.shareMotivationText}>{cleanAiText(summaryData.headline)}</Text>
                      </View>
                    ) : summaryData?.motivationMessage ? (
                      <View style={styles.shareMotivation}>
                        <Text style={styles.shareMotivationText}>"{cleanAiText(summaryData.motivationMessage)}"</Text>
                      </View>
                    ) : null}

                    {/* Watermark */}
                    <Text style={styles.shareWatermark}>Tracked with THALLO</Text>
                  </View>
                </ViewShot>

                {/* Loading state */}
                {summaryLoading && (
                  <View style={styles.summaryLoadingRow}>
                    <ActivityIndicator color={themeColors.primary} />
                    <Text style={styles.summaryLoadingText}>Coach is reviewing your session…</Text>
                  </View>
                )}

                {/* Structured v2 recap — three labeled sections when present */}
                {!summaryLoading && (summaryData?.comparison || summaryData?.coachingPoint || summaryData?.motivation) ? (
                  <View style={styles.summarySection}>
                    {summaryData?.comparison ? (
                      <>
                        <Text style={styles.summarySectionTitle}>vs. Last Time</Text>
                        <Text style={styles.summaryItem}>{cleanAiText(summaryData.comparison)}</Text>
                      </>
                    ) : null}
                    {summaryData?.coachingPoint ? (
                      <>
                        <Text style={[styles.summarySectionTitle, { marginTop: 10 }]}>Next Time</Text>
                        <Text style={styles.summaryItem}>{cleanAiText(summaryData.coachingPoint)}</Text>
                      </>
                    ) : null}
                    {summaryData?.motivation ? (
                      <>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 10 }}>
                          <Ionicons name="chatbubble-ellipses-outline" size={11} color={themeColors.textSecondary} />
                          <Text style={styles.summarySectionTitle}>Note</Text>
                        </View>
                        <Text style={styles.summaryItem}>{cleanAiText(summaryData.motivation)}</Text>
                      </>
                    ) : null}
                  </View>
                ) : !summaryLoading && (summaryData?.recommendations?.length ?? 0) > 0 ? (
                  <View style={styles.summarySection}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                      <Ionicons name="refresh-outline" size={11} color={themeColors.textSecondary} />
                      <Text style={styles.summarySectionTitle}>Recovery Tips</Text>
                    </View>
                    {summaryData!.recommendations.map((r, i) => (
                      <Text key={i} style={styles.summaryItem}>• {cleanAiText(r)}</Text>
                    ))}
                  </View>
                ) : null}

                {SOCIAL_WORKOUT_POSTS_ENABLED ? (
                  <View style={styles.summaryPrivacyNote}>
                    <Ionicons name="lock-closed-outline" size={12} color={themeColors.textMuted} />
                    <Text style={styles.summaryPrivacyNoteText}>
                      Friends posts include workout stats like load, reps, time, and distance. Calories, macros, and body weight stay private.
                    </Text>
                  </View>
                ) : null}

                <TouchableOpacity
                  testID="summary-save-template"
                  accessibilityLabel="summary-save-template"
                  style={[styles.summaryFeedbackBtn, { backgroundColor: templateSaved ? themeColors.success + '22' : themeColors.surfaceRaised, borderWidth: 1, borderColor: templateSaved ? themeColors.success : themeColors.border }]}
                  onPress={handleSaveWorkoutTemplate}
                  disabled={templateSaving || templateSaved}
                  activeOpacity={0.85}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Ionicons name={templateSaved ? 'checkmark-circle-outline' : 'bookmark-outline'} size={15} color={templateSaved ? themeColors.success : themeColors.textPrimary} />
                    <Text style={[styles.summaryFeedbackBtnText, { color: templateSaved ? themeColors.success : themeColors.textPrimary }]}>
                      {templateSaving ? 'Saving…' : templateSaved ? 'Template Saved' : 'Save Template'}
                    </Text>
                  </View>
                </TouchableOpacity>

                {/* Share image + Share-to-friends buttons.
                    "Share" exports an image; "Friends" sends the
                    structured workout summary to the friends Activity
                    digest (no kcal/macros/weight ever — privacy boundary). */}
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  {SOCIAL_WORKOUT_POSTS_ENABLED ? (
                    <TouchableOpacity
                      style={[
                        styles.summaryFeedbackBtn,
                        {
                          flex: 1.15,
                          backgroundColor: themeColors.primary,
                          borderWidth: 1,
                          borderColor: themeColors.primary,
                          opacity: workoutPostSummary ? 1 : 0.55,
                        },
                      ]}
                      onPress={handleOpenFriendsShare}
                      accessibilityRole="button"
                      accessibilityLabel="Open friends share sheet"
                      activeOpacity={0.85}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Ionicons name="people-outline" size={15} color={getContrastingTextColor(themeColors.primary)} />
                        <Text style={[styles.summaryFeedbackBtnText, { color: getContrastingTextColor(themeColors.primary) }]}>
                          Post to Friends
                        </Text>
                      </View>
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity
                    style={[styles.summaryFeedbackBtn, { flex: 1, backgroundColor: themeColors.surfaceRaised, borderWidth: 1, borderColor: themeColors.border }]}
                    onPress={handleShareSummary}
                    disabled={shareLoading || summaryLoading}
                    accessibilityRole="button"
                    accessibilityLabel="Share workout recap image"
                    activeOpacity={0.85}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Ionicons name="share-outline" size={15} color={themeColors.textPrimary} />
                      <Text style={[styles.summaryFeedbackBtnText, { color: themeColors.textPrimary }]}>
                        {shareLoading ? 'Saving…' : 'Share Image'}
                      </Text>
                    </View>
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
                containerStyle={{ flex: 1 }}
                testID={swapTargetIdx != null ? 'active-exercise-swap-search' : 'active-exercise-add-search'}
                value={exerciseSearch}
                onChangeText={(t) => {
                  setExerciseSearch(t);
                  setAiExerciseResults([]);
                  setAiExerciseLoading(false);
                }}
                placeholder="Search by name, muscle, or equipment…"
                placeholderTextColor={themeColors.textMuted}
                style={styles.addExerciseSearch}
                returnKeyType="done"
              />
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
                          {exerciseSearch.trim() ? 'Results' : `Fits Your ${workout.focus} Workout`}
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
                              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                                <TouchableOpacity
                                  style={{ flex: 1, backgroundColor: workoutPalette.strong, paddingVertical: 10, borderRadius: 8, alignItems: 'center' }}
                                  onPress={() => handleAddAiExercise(ex)}>
                                  <Text style={{ color: getContrastingTextColor(workoutPalette.strong), fontWeight: '700', fontSize: 13 }}>Add</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                  style={{ flex: 1, backgroundColor: themeColors.surfaceRaised, borderWidth: 1, borderColor: themeColors.border, paddingVertical: 10, borderRadius: 8, alignItems: 'center' }}
                                  onPress={() => handleSaveAiExerciseToLibrary(ex)}>
                                  <Text style={{ color: themeColors.textPrimary, fontWeight: '700', fontSize: 13 }}>Save to library</Text>
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
                  </>
                )}
              />
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <FormVideoModal
        visible={!!formVideoExerciseName}
        exerciseName={formVideoExerciseName ?? ''}
        authToken={authToken}
        themeName={themeName}
        equipment={formVideoContext.equipment}
        primaryMuscle={formVideoContext.primaryMuscle}
        movementPattern={formVideoContext.movementPattern}
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
            setElapsed(Math.floor((Date.now() - startTime.current) / 1000));
            setShowStartCountdown(false);
          }}
        />
      )}

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
  exerciseActiveRail: {
    position: 'absolute',
    left: 0,
    top: 14,
    bottom: 14,
    width: 4,
    borderTopRightRadius: 4,
    borderBottomRightRadius: 4,
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

  // Warm-up note within exercise card
  warmupNoteCard: {
    backgroundColor: tc.warning + '18',
    borderRadius: radius.md,
    padding: 10,
    borderLeftWidth: 3,
    borderLeftColor: tc.warning,
  },
  warmupNoteText: { fontSize: 12, color: tc.textPrimary, lineHeight: 18 },
  preSetHintCard: {
    borderLeftWidth: 3,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.md,
    marginTop: 8,
    marginBottom: 4,
  },

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
  finishConfirmBtn:  { backgroundColor: tc.primary, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', width: '100%', marginTop: 8 },
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
  summaryTitle:    { fontSize: 22, fontWeight: '800', color: tc.textPrimary, textAlign: 'center' },
  summarySubtitle: { fontSize: 13, color: tc.textSecondary, textAlign: 'center' },
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
  summarySection: { gap: 6 },
  summarySectionTitle: { fontSize: 12, fontWeight: '700', color: tc.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6 },
  summaryItem: { fontSize: 13, color: tc.textPrimary, lineHeight: 18 },

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
  summaryFeedbackBtn: {
    backgroundColor: tc.primary,
    borderRadius: radius.md,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 4,
  },
  summaryFeedbackBtnText: { color: tc.background, fontSize: 15, fontWeight: '700' },
  summaryPrivacyNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 7,
    backgroundColor: tc.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: tc.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  summaryPrivacyNoteText: { flex: 1, fontSize: 11, color: tc.textMuted, lineHeight: 16, fontWeight: '600' },
  summarySkipBtn:    { alignItems: 'center', paddingVertical: 10 },
  summarySkipText:   { fontSize: 13, color: tc.textMuted },

  // ── Shareable summary card ──
  shareCard: {
    backgroundColor: tc.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: tc.border,
    overflow: 'hidden',
  },
  shareHero: {
    paddingBottom: 16,
  },
  shareCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
  },
  shareCardLogo: { width: 150, height: 36 },
  shareCardDateBadge: {
    backgroundColor: tc.surface + 'CC',
    borderRadius: radius.full,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: tc.border,
  },
  shareCardDateText: { fontSize: 11, fontWeight: '600', color: tc.textSecondary },
  shareHeroBody: { paddingHorizontal: 16, paddingTop: 4 },
  shareKicker: {
    fontSize: 10,
    fontWeight: '900',
    color: tc.primary,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    marginBottom: 5,
  },
  shareCardFocus: {
    fontSize: 25,
    fontWeight: '900',
    color: tc.textPrimary,
    letterSpacing: -0.6,
    lineHeight: 30,
  },
  shareCompletionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    marginTop: 14,
    marginBottom: 7,
  },
  shareCompletionText: { fontSize: 11, color: tc.textSecondary, fontWeight: '800' },
  shareCompletionTrack: {
    height: 6,
    borderRadius: radius.full,
    backgroundColor: tc.border + '99',
    overflow: 'hidden',
  },
  shareCompletionFill: {
    height: 6,
    borderRadius: radius.full,
  },
  shareStatsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 8,
  },
  shareStatTile: {
    flex: 1,
    minWidth: '44%' as any,
    backgroundColor: tc.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: tc.border,
    paddingVertical: 10,
    paddingHorizontal: 8,
    alignItems: 'center',
    gap: 3,
  },
  shareStatIcon:  { fontSize: 13, marginBottom: 1 },
  shareStatValue: { fontSize: 18, fontWeight: '900', color: tc.textPrimary, lineHeight: 22 },
  shareStatLabel: { fontSize: 9, fontWeight: '700', color: tc.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 },
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
    fontWeight: '700',
    color: tc.textMuted,
    textAlign: 'center',
    paddingTop: 2,
    paddingBottom: 12,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
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
    marginHorizontal: 16,
    borderWidth: 1,
    borderColor: tc.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: tc.background,
    color: tc.textPrimary,
  },
  addExerciseList: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 16, gap: 8 },
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
