import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  TextInput, Modal, ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Vibration, Linking, Image, Keyboard,
  LayoutAnimation, UIManager, AppState, Animated,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import FadeInView from '../components/FadeInView';
import PressableScale from '../components/PressableScale';
import AnimatedNumber from '../components/AnimatedNumber';
import PRCelebrationModal from '../components/PRCelebrationModal';
// ShareWorkoutModal hidden — will re-enable with social feed
// import ShareWorkoutModal from '../components/ShareWorkoutModal';
import Svg, { Circle } from 'react-native-svg';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as FileSystem from 'expo-file-system';
import ViewShot from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import { WorkoutDay, WorkoutSession, SessionExercise, CompletedSet, WorkoutSummary, AppThemeName, WorkoutFeeling, WorkoutIntensity } from '../types';
import { saveWorkoutSession, getLastSetsForExercise, dateKey, saveWorkoutSummary, updateWorkoutSummary, saveHealthSummary, saveHealthScore, isAppleHealthEnabled, loadWorkoutHistory, savePreservedCompletedWorkout, getExerciseBests } from '../utils/workoutHistory';
import { isHealthKitAvailable, readHealthSummary, getAppleWorkoutCaloriesForWindow, getWorkoutHrSummary, getLatestHeartRate } from '../services/appleHealth';
import { calculateHealthScore } from '../utils/healthScore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getWeightRecommendation, logWorkoutDone, logWorkoutStarted, askWorkoutQuestion, analyzeWorkoutFormPhoto, getExercises, getWorkoutSummary, askTrainerQuestion, searchExerciseAI, AIExerciseResult, getAiWarmup, getPreSetRecommendation, syncInProgressWorkout, PRAchievement, getHRZones, HRZone, createSocialPost, type WorkoutPostSummary } from '../services/api';
import { cleanAiText } from '../utils/aiText';
import { getExerciseImage } from '../utils/exerciseImages';
import { exerciseThumbSmall } from '../utils/exerciseThumb';
import { getTheme, radius } from '../constants/theme';
import * as Notifications from 'expo-notifications';
import SearchInput from '../components/SearchInput';
import FormVideoModal from '../components/FormVideoModal';
import StartCountdownOverlay from '../components/StartCountdownOverlay';
import WorkoutTimerModal, { TimerResult } from '../components/WorkoutTimerModal';
import { isWatchReachable } from '../utils/watchSync';
import { setActiveWatchSessionId } from '../utils/activeWatchSession';
import { WatchBridge } from '../../modules/thallo-watch-bridge';
import { cancelRestNotifications, scheduleRestNotifications, configureWorkoutNotifications, ensureWorkoutNotificationPermission } from '../utils/restNotifications';
import { humanizeToken } from '../utils/exerciseGuide';
import { shouldHideWeight, shouldHideReps, formatDurationTarget } from '../utils/exerciseDisplay';
import { startRestActivity, updateRestActivity, endRestActivity, endAllActivities, getLastStartDiagnostic } from '../services/liveActivity';

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

type SetFeedback = 'easy' | 'good' | 'grind' | 'hard' | 'failure' | 'pain' | 'form_breakdown';

// Feedback buttons removed — recommendations derive from actual vs target reps.

const COACH_PROMPT_OPTIONS: Array<{ label: string; template: (exerciseName: string) => string }> = [
  { label: 'Form question', template: (name) => `Form check on ${name}: what 2-3 cues should I focus on next set?` },
  { label: 'Injury/pain', template: (name) => `I feel pain/discomfort during ${name}. What should I adjust right now?` },
  { label: 'Not feeling target', template: (name) => `I am not feeling ${name} in the target muscle. How should I fix setup and execution?` },
  { label: 'Lacking intensity', template: (name) => `This ${name} set feels too easy. Should I adjust reps, tempo, rest, or load?` },
];

interface ExerciseLibraryItem {
  id?: number;
  name: string;
  equipment?: string;
  gear?: Array<{ slug: string; name: string; category?: string }>;
  primary_muscle?: string;
  secondary_muscles?: string[];
  is_compound?: boolean;
  movement_pattern?: string | null;
  description?: string;
}

// ─── Swap ranking ────────────────────────────────────────────────────────────
// Groups equipment strings into broad classes so a "barbell row" ranks close
// to a "t-bar row" but far from a "resistance band row".
function _equipmentClass(raw?: string | null): string {
  const s = (raw ?? '').toLowerCase();
  if (!s) return 'other';
  if (s.includes('barbell') || s.includes('smith')) return 'barbell';
  if (s.includes('dumbbell') || s.includes('kettlebell')) return 'dumbbell';
  if (s.includes('machine') || s.includes('cable') || s.includes('leg_press') || s.includes('leg press')) return 'machine';
  if (s.includes('band') || s.includes('resistance')) return 'band';
  if (s.includes('bodyweight') || s === 'none' || s === 'bw') return 'bodyweight';
  return 'other';
}

/** Score how well `cand` substitutes for `base`. Higher = better match.
 *  Scoring weights:
 *    primary == primary: +12
 *    primary matches base.secondary or vice versa: +6
 *    any secondary overlap: +3
 *    same compound-vs-isolation bucket: +5
 *    same movement_pattern: +6
 *    same equipment class: +4 (close class: +2)
 *  Zero or negative means unsuitable; we drop those. */
function _scoreSwapCandidate(base: ExerciseLibraryItem, cand: ExerciseLibraryItem): number {
  let score = 0;
  const bp = (base.primary_muscle ?? '').toLowerCase();
  const cp = (cand.primary_muscle ?? '').toLowerCase();
  const bs = (base.secondary_muscles ?? []).map(m => m.toLowerCase());
  const cs = (cand.secondary_muscles ?? []).map(m => m.toLowerCase());
  if (!bp || !cp) return -1;
  if (bp === cp) score += 12;
  else if (bs.includes(cp) || cs.includes(bp)) score += 6;
  else if (bs.some(m => cs.includes(m))) score += 3;
  else return -1; // no muscle overlap at all — not a swap
  if (base.is_compound === cand.is_compound) score += 5;
  const bpat = (base.movement_pattern ?? '').toLowerCase();
  const cpat = (cand.movement_pattern ?? '').toLowerCase();
  if (bpat && bpat === cpat) score += 6;
  const be = _equipmentClass(base.equipment);
  const ce = _equipmentClass(cand.equipment);
  if (be === ce) score += 4;
  else if (
    (be === 'barbell' && ce === 'dumbbell') ||
    (be === 'dumbbell' && ce === 'barbell') ||
    (be === 'machine' && (ce === 'barbell' || ce === 'dumbbell')) ||
    ((be === 'barbell' || be === 'dumbbell') && ce === 'machine')
  ) {
    score += 2;
  }
  return score;
}

interface ActiveWorkoutScreenProps {
  authToken: string;
  workout: WorkoutDay;
  goal: string;
  themeName?: AppThemeName;
  weightLbs?: number;
  onFinish: (session: WorkoutSession) => void;
  onCancel: () => void;
  onDislikeExercise?: (exerciseName: string) => void;
}

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

const TIMED_EXERCISE_RE = /treadmill|stationary bike|elliptical|rowing machine|stair climber|assault bike|battle ropes|jump rope|sprint|jogging|running|cycling|swimming|hiit|intervals|mountain climber|hill sprint|cardio|plank|dead hang|wall sit|hollow.?hold|l.?sit|farmer.?walk|carry|boxing|kickboxing|sparring|bag.?work|shadow.?box|yoga|vinyasa|hot.?yoga|power.?yoga|yin.?yoga|mobility.?flow|stretching/i;
const TIMED_REPS_RE = /^\d+\s*-?\s*\d*\s*s(ec|econds?)?$/i;
// `isBodyweightOnly` name-regex was replaced by the richer
// `shouldHideWeight(ex)` predicate in `utils/exerciseDisplay.ts`,
// which also checks equipment / archetype / training_type / reps
// string. Old regex removed with the function.

function isTimedExercise(name: string, targetReps?: string | number): boolean {
  if (TIMED_EXERCISE_RE.test(name)) return true;
  // Detect time-based rep schemes like "30s", "30-60s", "45 sec", "60 seconds",
  // "25 min", "20-30 min". Coerce to string — AI plans occasionally return
  // reps as a number ("reps": 12) which crashed .trim() before this guard.
  const reps = targetReps == null ? '' : String(targetReps).trim();
  if (reps && (TIMED_REPS_RE.test(reps) || /\d\s*-?\s*\d*\s*m(in(ute)?s?)?$/i.test(reps))) return true;
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
  if (/treadmill|stationary bike|elliptical|rowing machine|stair climber|assault bike|jogging|running|cycling|swimming|zone ?2|tempo|steady state|long run|boxing|kickboxing|sparring|bag.?work|shadow.?box|yoga|vinyasa|hot.?yoga|power.?yoga|yin.?yoga|mobility.?flow|stretching/.test(lowered)) {
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

function getTimedExerciseTip(name: string, targetReps?: string | number, loggedSets?: any[]): string | null {
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
  // Boxing, kickboxing, yoga, stretching, mobility — no useful metric to recommend
  return null;
}

type MetricField = { key: string; label: string; placeholder: string; keyboard: 'decimal-pad' | 'number-pad' | 'default' };

function getTimedMetricsFields(name: string): MetricField[] | null {
  const n = (name || '').toLowerCase();
  if (/treadmill|running|jogging|run\b/.test(n)) {
    return [
      { key: 'pace', label: 'Avg Pace', placeholder: 'e.g. 8:30 /mi', keyboard: 'default' },
      { key: 'distance', label: 'Distance (mi)', placeholder: 'e.g. 3.1', keyboard: 'decimal-pad' },
      { key: 'incline', label: 'Incline %', placeholder: 'e.g. 2', keyboard: 'decimal-pad' },
    ];
  }
  if (/row|rowing|erg/.test(n)) {
    return [
      { key: 'split', label: 'Avg Split', placeholder: 'e.g. 2:05 /500m', keyboard: 'default' },
      { key: 'distance', label: 'Distance (m)', placeholder: 'e.g. 5000', keyboard: 'number-pad' },
      { key: 'spm', label: 'Strokes/min', placeholder: 'e.g. 24', keyboard: 'number-pad' },
    ];
  }
  if (/bike|cycling|ride|peloton/.test(n)) {
    return [
      { key: 'distance', label: 'Distance (mi)', placeholder: 'e.g. 12.5', keyboard: 'decimal-pad' },
      { key: 'cadence', label: 'Avg Cadence', placeholder: 'e.g. 85 rpm', keyboard: 'number-pad' },
      { key: 'output', label: 'Output (kJ)', placeholder: 'e.g. 350', keyboard: 'number-pad' },
    ];
  }
  if (/swim/.test(n)) {
    return [
      { key: 'distance', label: 'Distance (m)', placeholder: 'e.g. 1500', keyboard: 'number-pad' },
      { key: 'laps', label: 'Laps', placeholder: 'e.g. 30', keyboard: 'number-pad' },
    ];
  }
  if (/stair|elliptical/.test(n)) {
    return [
      { key: 'floors', label: 'Floors / Level', placeholder: 'e.g. 45', keyboard: 'number-pad' },
      { key: 'calories', label: 'Calories', placeholder: 'e.g. 280', keyboard: 'number-pad' },
    ];
  }
  if (/hik/.test(n)) {
    return [
      { key: 'distance', label: 'Distance (mi)', placeholder: 'e.g. 4.2', keyboard: 'decimal-pad' },
      { key: 'elevation', label: 'Elevation (ft)', placeholder: 'e.g. 800', keyboard: 'number-pad' },
    ];
  }
  if (/farmer|carry|suitcase/.test(n)) {
    return [
      { key: 'weight', label: 'Weight (lbs)', placeholder: 'e.g. 70 each', keyboard: 'default' },
      { key: 'distance', label: 'Distance (ft)', placeholder: 'e.g. 120', keyboard: 'number-pad' },
    ];
  }
  // Boxing, kickboxing, yoga, stretching, etc — no metrics to capture
  return null;
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
const SHARE_LOGO_DARK  = require('../../assets/images/thallo-logo-white.png');

export default function ActiveWorkoutScreen({ authToken, workout, goal, themeName, weightLbs = 150, onFinish, onCancel, onDislikeExercise }: ActiveWorkoutScreenProps) {
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
    // Mirror warmupSteps into a ref so the once-mounted watch-sync
    // effect can always send the freshest steps (AI warmup resolves
    // async after the initial push).
    const warmupStepsRef = useRef<string[]>(warmupSteps);
    useEffect(() => { warmupStepsRef.current = warmupSteps; }, [warmupSteps]);
    useEffect(() => {
      let cancelled = false;
      const loadWarmup = async () => {
        if (!authToken) return;
        const today = dateKey(new Date());
        const dayKey = (workout.day || workout.focus || 'session').replace(/\s+/g, '_');
        const cacheKey = `ai-warmup:${today}:${dayKey}`;
        try {
          const cached = await AsyncStorage.getItem(cacheKey);
          if (cached) {
            const parsed = JSON.parse(cached);
            if (Array.isArray(parsed?.steps) && parsed.steps.length > 0 && !cancelled) {
              setWarmupSteps(parsed.steps);
              return;
            }
          }
        } catch {}
        try {
          let injuries: string[] = [];
          try {
            const rawProfile = await AsyncStorage.getItem('userProfile');
            if (rawProfile) {
              const p = JSON.parse(rawProfile);
              injuries = (p.injuriesOrLimitations || p.injuries || [])
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
        }
      };
      loadWarmup();
      return () => { cancelled = true; };
    }, [authToken, workout.day, workout.focus]);
  const theme = getTheme(themeName);
  const themeColors = theme.colors;
  const workoutPalette = theme.sections.workout;
  const styles = createStyles(themeColors);
  const startTime = useRef(Date.now());
  // Show the 3-2-1 countdown only on a true fresh start. If we find a
  // persisted start time on mount, the user is resuming after a
  // background / app restart and the countdown would be jarring.
  const [showStartCountdown, setShowStartCountdown] = useState(false);
  // When the phone starts a workout and the user has a paired but
  // currently-closed Thallo watch app, we can't auto-launch it — iOS
  // blocks that. So we nudge: show a dismissable prompt telling the
  // user to open Thallo on the watch. Auto-hides the moment the watch
  // reports reachable (i.e., the user opened it).
  const [showOpenWatchPrompt, setShowOpenWatchPrompt] = useState(false);
  const watchSessionId = useRef(`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  // Write session ID synchronously to the module-level store so HomeScreen's
  // pull_state / reachability handlers can read it immediately without waiting
  // for AsyncStorage (which is async and loses the race against pull_state).
  setActiveWatchSessionId(watchSessionId.current);
  // Persist start time so elapsed timer survives app restart
  useEffect(() => {
    AsyncStorage.getItem('activeWorkoutStartTime').then(saved => {
      if (saved) {
        const ts = parseInt(saved, 10);
        if (!isNaN(ts) && ts > 0) startTime.current = ts;
        // Rehydrate sessionId from persistence so reopen gets same id.
        AsyncStorage.getItem('activeWatchSessionId').then(sid => {
          if (sid) {
            watchSessionId.current = sid;
            setActiveWatchSessionId(sid);
          }
        }).catch(() => {});
      } else {
        AsyncStorage.setItem('activeWorkoutStartTime', String(startTime.current)).catch(() => {});
        AsyncStorage.setItem('activeWatchSessionId', watchSessionId.current).catch(() => {});
        // Fresh start — play the countdown.
        setShowStartCountdown(true);
      }
    });
    // Pre-load the rest-timer chime so the first set's countdown
    // end fires the audio without a few-hundred-ms decode delay.
    // Idempotent across remounts.
    import('../utils/feedback').then(f => f.preloadRestTimerSound()).catch(() => {});
    return () => { setActiveWatchSessionId(null); };
  }, []);
  // Fetch HR zones for cardio prescription display
  useEffect(() => {
    if (!authToken) return;
    const hasCardio = workout.exercises?.some((e: any) =>
      /treadmill|bike|run|row|elliptical|stair|swim|cardio/i.test(e.name ?? '')
    );
    if (hasCardio) {
      readHealthSummary?.().then?.((hs: any) => {
        getHRZones(authToken, hs?.restingHeartRate, hs?.vo2Max)
          .then(r => setHrZones(r.zones))
          .catch(() => {});
      }).catch(() => {
        getHRZones(authToken).then(r => setHrZones(r.zones)).catch(() => {});
      });
    }
  }, [authToken]);
  // Phone↔watch active-state sync. On mount we push `status: 'active'`
  // AND subscribe to WCSession reachability changes — when the user
  // opens Thallo on their watch, reachability flips to true and we
  // re-push the same payload so the watch wakes up with the current
  // active state instead of whatever stale payload it had cached.
  // Without the re-push, a watch that was closed during the phone
  // workout start would show yesterday's (scheduled) state because
  // iOS only delivers the latest applicationContext once, when the
  // watch app next opens — and even that delivery can race the UI.
  useEffect(() => {
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
        const pushActive = () => pushWorkoutToWatch(workout as any, {
          dateISO: new Date().toISOString().slice(0, 10),
          status: 'active',
          sessionId: watchSessionId.current,
          warmupSteps: warmupStepsRef.current,
        }).catch(() => {});
        // Initial push on mount.
        pushActive();
        // Launch the watch app via HealthKit so it opens directly
        // into workout mode with extended runtime. Falls back to
        // the reachability re-push below if HealthKit launch fails.
        try {
          WatchBridge.startWatchWorkout().catch(() => {});
        } catch { /* bridge optional */ }
        // If the watch is paired but not reachable right now, the
        // Thallo watch app isn't open — show the nudge. Suppress if
        // there's no watch at all (isPaired=false) so users without
        // an Apple Watch never see this modal.
        try {
          if (WatchBridge.isPaired() && !WatchBridge.isReachable()) {
            setShowOpenWatchPrompt(true);
          }
        } catch { /* bridge optional */ }
        // Re-push whenever the watch becomes reachable. Idempotent.
        const unsub = onWatchReachabilityChange((info) => {
          if (info.reachable) {
            console.log('[watch] reachable — re-pushing active workout');
            pushActive();
            // Watch is open now — hide the prompt if it was up.
            setShowOpenWatchPrompt(false);
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
  }, [workout]);

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
  const handleLogSetInlineRef = useRef(handleLogSetInline);
  useEffect(() => { handleLogSetInlineRef.current = handleLogSetInline; }, [handleLogSetInline]);
  const exercisesRef = useRef(exercises);
  useEffect(() => { exercisesRef.current = exercises; }, [exercises]);
  const watchHandlersRef = useRef<{
    finish: () => void;
    cancel: () => void;
  }>({ finish: () => {}, cancel: () => {} });
  // handlersRef is updated further down once handleFinish / onCancel
  // are in scope (see the `watchHandlersRef.current = ...` assignment
  // below the handleFinish definition).

  useEffect(() => {
    // Ref-token cleanup so a teardown that fires before the async
    // import resolves still removes the listener once it attaches.
    const token = { cancelled: false, unsub: null as (() => void) | null };
    (async () => {
      try {
        const { onWatchCommand } = await import('../utils/watchSync');
        const unsub = onWatchCommand((command, payload) => {
          if (command === 'pull_state') {
            // Watch asked for a refresh while we're mid-workout —
            // push `status: 'active'` + current warmup steps so the
            // wrist flips to the active view with fresh content.
            (async () => {
              try {
                const { pushWorkoutToWatch } = await import('../utils/watchSync');
                await pushWorkoutToWatch(workout as any, {
                  dateISO: new Date().toISOString().slice(0, 10),
                  status: 'active',
                  sessionId: watchSessionId.current,
                  warmupSteps: warmupStepsRef.current,
                });
              } catch { /* bridge optional */ }
            })();
            return;
          }
          if (command === 'log_set') {
            const exIdx = Number(payload?.exerciseIndex ?? -1);
            const weight = payload?.weightLbs;
            const reps = payload?.reps;
            if (exIdx < 0 || !Number.isFinite(exIdx)) return;
            const exs = exercisesRef.current;
            if (!exs[exIdx]) return;
            // Slot = next unfilled set slot for this exercise.
            const slot = exs[exIdx].sets.length;
            handleLogSetInlineRef.current(
              exIdx,
              slot,
              true, // silent — no Alerts, watch already confirmed
              undefined,
              weight != null ? String(weight) : undefined,
              reps != null ? String(reps) : undefined,
            );
          } else if (command === 'end_workout') {
            watchHandlersRef.current.finish();
          } else if (command === 'cancel_workout') {
            watchHandlersRef.current.cancel();
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
  }, []);

  const restNotificationIds = useRef<{ startId?: string; warningId?: string; completeId?: string } | null>(null);
  const restDurationSeconds = useRef<number>(0);
  // Ref-based rest timer — avoids interval churn from re-running useEffect every second
  const restTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Active Live Activity ID so we can update/end it from timer callbacks.
  const liveActivityIdRef = useRef<string | null>(null);
  // One-time per-workout diagnostic flag so the alert only fires on first rest.
  const liveActivityDiagShownRef = useRef<boolean>(false);
  const restStartAtRef = useRef<number>(0);
  const restTotalSecondsRef = useRef<number>(0);
  const restExerciseNameRef = useRef<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [liveHR, setLiveHR] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    let interval: ReturnType<typeof setInterval> | null = null;
    (async () => {
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
  }, []);

  const [exercises, setExercisesRaw] = useState<SessionExercise[]>(() => {
    // Try to restore in-progress session from AsyncStorage
    // (synchronous initializer can't be async, so we override in useEffect below)
    return workout.exercises.map(ex => ({
      name: ex.name,
      targetSets: ex.sets,
      targetReps: ex.reps,
      targetRestSeconds: ex.restSeconds,
      equipment: typeof ex.equipment === 'string' ? ex.equipment : String(ex.equipment),
      sets: [],
      aiRecommendation: undefined,
      image_url: (ex as any).image_url,
      // Preserve planner-propagated targets + slug so weight-rec calls can
      // use them as anchors (tier 2 in the backend's layered pipeline).
      targetWeightLbs: (ex as any).targetWeightLbs ?? null,
      slug: (ex as any).slug ?? (ex as any).exerciseSlug ?? null,
      primaryMuscle: (ex as any).primary_muscle ?? (ex as any).primaryMuscle ?? null,
      isCompound: (ex as any).is_compound ?? (ex as any).isCompound ?? null,
      weightRecommendationSource: (ex as any).weightRecommendationSource ?? null,
    }));
  });
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
          order_index: i,
          sets: ex.sets.map(s => ({
            set_number: s.setNumber,
            reps: s.reps,
            weight_lbs: s.weightLbs,
            duration_seconds: s.durationSeconds ?? null,
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
    setExercisesRaw(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      // Auto-save session state so it survives app backgrounding/kill
      AsyncStorage.setItem('activeWorkoutSets', JSON.stringify(
        next.map(ex => ({ name: ex.name, sets: ex.sets }))
      )).catch(() => {});
      // Also debounce-sync to the backend so per-set detail isn't local-only.
      syncPartialToBackend(next);
      return next;
    });
  }, [syncPartialToBackend]);

  useEffect(() => {
    return () => { if (syncDebounceRef.current) clearTimeout(syncDebounceRef.current); };
  }, []);

  // Restore logged sets from a previous interrupted session.
  // Do NOT clear on unmount — the data must survive app kills so
  // the user can resume. It's cleared explicitly on Finish or Cancel.
  useEffect(() => {
    AsyncStorage.getItem('activeWorkoutSets').then(raw => {
      if (!raw) return;
      try {
        const saved: Array<{ name: string; sets: any[] }> = JSON.parse(raw);
        if (!saved?.length) return;
        setExercisesRaw(prev => prev.map(ex => {
          const match = saved.find(s => s.name === ex.name);
          return match && match.sets.length > 0 ? { ...ex, sets: match.sets } : ex;
        }));
        console.log(`[ActiveWorkout] restored ${saved.filter(s => s.sets.length > 0).length} exercises with logged sets`);
      } catch {}
    }).catch(() => {});
  }, []);

  // ── Lazy AI weight refresh on workout start ─────────────────────────
  // The planner's `recommend_starting_weight` falls through to a fixed
  // category-default table (tier 5) when the user has no transferable
  // history. That table ignores bodyweight, age, sex, and recent
  // same-muscle work entirely — a 220-lb advanced user gets the same
  // 95-lb bench rec as a 130-lb beginner.
  //
  // Fix: scan exercises whose `weightRecommendationSource === 'default'`
  // and fire `/ai/recommend-weight` for each in parallel. The endpoint
  // routes through the AI first-time helper which DOES use bodyweight +
  // age + sex + recent same-muscle sessions. Replace `targetWeightLbs`
  // before the user logs their first set.
  //
  // Skipped:
  //  - exercises that already have a real source (exact_history, sub_group, etc)
  //  - exercises with logged sets restored from a prior session (the
  //    AI rec for "next set" path takes over from there)
  //  - exercises where the first set is already logged (race-safe)
  //  - workout has no auth token (offline)
  useEffect(() => {
    if (!authToken) return;
    let cancelled = false;
    (async () => {
      try {
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
              experienceLevel: userProfile?.experienceLevel as any,
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
        setExercisesRaw(prev => prev.map((ex, i) =>
          i in updates
            ? { ...ex, targetWeightLbs: updates[i], weightRecommendationSource: 'ai_first_time' }
            : ex,
        ));
        console.log(`[ActiveWorkout] AI weight refresh: ${Object.keys(updates).length}/${targets.length} exercises updated`);
      } catch (e) {
        console.log('[ActiveWorkout] AI weight refresh failed (non-fatal):', e);
      }
    })();
    return () => { cancelled = true; };
    // Run ONCE on mount — we don't want this firing every state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [activeExIdx, setActiveExIdx] = useState<number>(0);
  const [formVideoExerciseName, setFormVideoExerciseName] = useState<string | null>(null);
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
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('userProfile');
        if (!raw) return;
        const prof = JSON.parse(raw);
        const eq: string[] = Array.isArray(prof?.equipment) ? prof.equipment : [];
        setOwnedEquipment(eq);
      } catch { /* best-effort — fall back to empty list = bodyweight only */ }
    })();
  }, []);

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

  // Fetch a pre-set recommendation the first time a given exercise
  // card is in focus with no sets logged yet. Deterministic endpoint
  // (zero AI cost on the normal path), so we can fire this freely.
  // Skips if already cached. Uses last session data looked up via
  // getLastSetsForExercise to ground the opening weight suggestion.
  useEffect(() => {
    const ex = exercises[activeExIdx];
    if (!ex || !authToken) return;
    if (ex.sets.length > 0) return;
    if (preSetHints[activeExIdx]) return;
    let cancelled = false;
    (async () => {
      try {
        const lastSets = await getLastSetsForExercise(ex.name).catch(() => [] as CompletedSet[]);
        const plannedSets = Array.from({ length: getTargetSetCount(ex.targetSets) }, (_, n) => ({
          setNumber: n + 1,
          setType: 'working',
          targetReps: String(ex.targetReps ?? '8-12'),
          targetRir: 2,
          progressionMode: 'load_first',
          targetWeightLbs: null,
        }));
        const rec = await getPreSetRecommendation(authToken, {
          exerciseName: ex.name,
          exerciseSlug: ex.slug ?? undefined,
          plannedSetNumber: 1,
          plannedSets,
          priorSetsThisSession: [],
          lastSessionSets: (lastSets ?? []).map(s => ({ reps: s.reps, weightLbs: s.weightLbs })),
          goal,
          equipment: typeof ex.equipment === 'string' ? ex.equipment : undefined,
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
      }
    })();
    return () => { cancelled = true; };
  }, [activeExIdx, exercises, authToken, goal, weightLbs]);

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
      // Prune accumulated Animated.Values for this exercise now that it's done.
      for (let slot = 0; slot < 20; slot++) {
        const base = `${idx}-${slot}`;
        delete setBadgeScales[base];
        delete setBadgeWasLogged[base];
        delete setPulseValues[base];
        delete inputFocusValues[`${base}-weight`];
        delete inputFocusValues[`${base}-reps`];
      }
      delete exerciseCompleteScales[idx];
      delete exerciseCompleteWasDone[idx];
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
  // Mirror cue + nextTarget into refs so startRestTimer can read latest values
  // synchronously when persisting the snapshot blob to AsyncStorage.
  const restNextTargetRef = useRef<string | null>(null);
  const restCueRef = useRef<string | null>(null);
  useEffect(() => { restNextTargetRef.current = restNextTarget; }, [restNextTarget]);
  useEffect(() => { restCueRef.current = restCue; }, [restCue]);

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
  const [activeTimers, setActiveTimers] = useState<Record<string, { running: boolean; baseElapsed: number; startedAt: number | null }>>({});
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

  const getTimerElapsed = useCallback((key: string): number => {
    const t = activeTimers[key];
    if (!t) return 0;
    if (t.running && t.startedAt != null) {
      return t.baseElapsed + Math.max(0, Math.floor((Date.now() - t.startedAt) / 1000));
    }
    return t.baseElapsed;
  }, [activeTimers]);

  const startExerciseTimer = useCallback((key: string) => {
    setActiveTimers(prev => {
      const existing = prev[key];
      return {
        ...prev,
        [key]: {
          running: true,
          baseElapsed: existing?.baseElapsed ?? 0,
          startedAt: Date.now(),
        },
      };
    });
    // Single shared ticker — only starts when at least one timer is
    // running, fires every second to trigger re-renders, and stops
    // itself below when all timers are paused.
    if (!tickIntervalRef.current) {
      tickIntervalRef.current = setInterval(() => {
        setTimerTick(t => (t + 1) % 1_000_000);
      }, 1000);
    }
  }, []);

  const stopExerciseTimer = useCallback((key: string) => {
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
      if (!anyRunning && tickIntervalRef.current) {
        clearInterval(tickIntervalRef.current);
        tickIntervalRef.current = null;
      }
      return next;
    });
  }, []);

  const resetExerciseTimer = useCallback((key: string) => {
    setActiveTimers(prev => {
      const next = { ...prev, [key]: { running: false, baseElapsed: 0, startedAt: null } };
      const anyRunning = Object.values(next).some(v => v?.running);
      if (!anyRunning && tickIntervalRef.current) {
        clearInterval(tickIntervalRef.current);
        tickIntervalRef.current = null;
      }
      return next;
    });
  }, []);

  // Cleanup timer intervals on unmount. We only hold the shared
  // ticker now; legacy per-timer intervals in timerIntervalsRef are
  // no longer populated but we keep the ref around so any stale
  // handles can still be cleared if old code slipped one in.
  useEffect(() => {
    return () => {
      Object.values(timerIntervalsRef.current).forEach(clearInterval);
      if (tickIntervalRef.current) {
        clearInterval(tickIntervalRef.current);
        tickIntervalRef.current = null;
      }
    };
  }, []);

  // Per-exercise AI state
  const [aiLoadingIdx, setAiLoadingIdx] = useState<number | null>(null);
  const [aiErrorIdx, setAiErrorIdx]     = useState<number | null>(null);

  // Last-session data for comparison display
  const [lastExerciseSets, setLastExerciseSets] = useState<Record<string, CompletedSet[]>>({});

  // HR zones for cardio exercises
  const [hrZones, setHrZones] = useState<HRZone[]>([]);

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
  const summaryCardRef = useRef<ViewShot>(null);
  const repsInputRef = useRef<TextInput>(null);

  const handleShareSummary = async () => {
    try {
      setShareLoading(true);
      const ref = summaryCardRef.current as any;
      if (!ref?.capture) return;
      const uri = await ref.capture();
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

  const [postingToFeed, setPostingToFeed] = useState(false);
  // Post the just-finished workout to the friends feed. Pulls a
  // workout_summary off the local exercises array (date + focus +
  // total sets/reps) — never includes calories/macros/weight, which
  // is the social privacy boundary documented in CLAUDE.md.
  const handlePostToFriendsFeed = useCallback(async () => {
    if (!authToken) {
      Alert.alert('Sign in', 'You need to be signed in to post to your friends feed.');
      return;
    }
    const submitPost = async (caption: string | undefined) => {
      try {
        setPostingToFeed(true);
        const summary: WorkoutPostSummary = {
          focus: workout.focus ?? 'Workout',
          duration_seconds: Math.round(((Date.now() - (startTime ?? Date.now())) / 1000)),
          date: new Date().toISOString().slice(0, 10),
          exercises: exercises.map(e => ({
            name: e.name,
            equipment: (e as any).equipment ?? null,
            sets: e.sets.map(s => ({
              reps: Number(s.reps) || 0,
              weight_lbs: Number(s.weightLbs) || 0,
            })),
          })),
          total_sets: exercises.reduce((sum, e) => sum + e.sets.length, 0),
          total_reps: exercises.reduce(
            (sum, e) => sum + e.sets.reduce((rs, s) => rs + (Number(s.reps) || 0), 0),
            0,
          ),
          training_score: (summaryData as any)?.trainingScore ?? null,
          training_rating: (summaryData as any)?.trainingRating ?? null,
        };
        await createSocialPost(authToken, {
          caption: (caption ?? '').trim() || undefined,
          workout_summary: summary,
        });
        try {
          const f = await import('../utils/feedback');
          f.hapticSuccess?.();
        } catch {}
        Alert.alert('Shared', 'Your friends will see this in their Activity tab.');
      } catch (e: any) {
        Alert.alert('Could not post', e?.message ?? 'Try again later.');
      } finally {
        setPostingToFeed(false);
      }
    };
    // Alert.prompt is iOS-only. On Android, post without an inline
    // caption — the user can add one from a future compose UI; for v1
    // a captionless workout share is still meaningful (the summary is
    // the headline data).
    if (Platform.OS === 'ios' && (Alert as any).prompt) {
      (Alert as any).prompt(
        'Share with friends',
        'Optional caption — your friends see the workout summary either way. (No calories, macros, or weight are ever shared.)',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Share', onPress: submitPost },
        ],
        'plain-text',
        '',
      );
    } else {
      submitPost(undefined);
    }
  }, [authToken, exercises, summaryData, workout, startTime]);

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
  const [exerciseSearch, setExerciseSearch] = useState('');
  const [exerciseLibraryLoading, setExerciseLibraryLoading] = useState(false);
  const [exerciseLibrary, setExerciseLibrary] = useState<ExerciseLibraryItem[]>([]);
  const [aiExerciseResults, setAiExerciseResults] = useState<AIExerciseResult[]>([]);
  const [aiExerciseLoading, setAiExerciseLoading] = useState(false);

  // Elapsed workout timer
  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Set up notifications immediately so lock screen alerts work from the first rest
  useEffect(() => {
    configureWorkoutNotifications().catch(() => undefined);
    ensureWorkoutNotificationPermission().catch(() => undefined);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (restTimerRef.current) clearInterval(restTimerRef.current);
      cancelRestNotifications(restNotificationIds.current).catch(() => undefined);
      // Swallow any error here — we're unmounting, crashes are unrecoverable.
      try {
        if (liveActivityIdRef.current) {
          endRestActivity(liveActivityIdRef.current).catch(() => undefined);
          liveActivityIdRef.current = null;
        }
      } catch {}
    };
  }, []);

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
  useEffect(() => {
    Promise.all(
      workout.exercises.map(async ex => {
        const sets = await getLastSetsForExercise(ex.name);
        return { name: ex.name, sets: sets ?? [] };
      })
    ).then(results => {
      const map: Record<string, CompletedSet[]> = {};
      results.forEach(r => { if (r.sets.length > 0) map[r.name] = r.sets; });
      setLastExerciseSets(map);

      // Only pre-fill duration inputs for timed exercises (cardio /
      // holds). Weight + reps stay empty so the user always commits to
      // a specific number for today's set.
      const inputs: Record<string, { weight: string; reps: string; duration: string }> = {};
      workout.exercises.forEach((ex, exIdx) => {
        const lastSets = map[ex.name] ?? [];
        if (!isTimedExercise(ex.name, ex.reps)) return;
        for (let slot = 0; slot < ex.sets; slot++) {
          const last = lastSets[slot] ?? lastSets[lastSets.length - 1];
          if (last && last.durationSeconds != null) {
            inputs[`${exIdx}-${slot}`] = { weight: '', reps: '', duration: formatDurationForInput(last.durationSeconds) };
          }
        }
      });
      setSetInputs(inputs);
    });
  }, []);

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
    setEditSetWeight(String(set.weightLbs));
    setEditSetReps(String(set.reps));
    setEditSetVisible(true);
  }, [exercises]);

  const commitInlineEdit = useCallback((exIdx: number, setIdx: number) => {
    if (editCommitTimer.current) clearTimeout(editCommitTimer.current);
    editCommitTimer.current = setTimeout(() => {
      const w = parseFloat(editDraft.weight ?? '');
      const r = parseInt(editDraft.reps ?? '', 10);
      const ex = exercises[exIdx];
      const existingSet = ex?.sets[setIdx];
      if (!existingSet) { setEditingSetKey(null); setEditDraft({}); return; }
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
      setExercises(prev => prev.map((e, idx) =>
        idx === exIdx ? { ...e, sets: updatedSets } : e
      ));
      setEditingSetKey(null);
      setEditDraft({});
      // Retrigger recommendation with a delay so the user can finish editing
      if (authToken && updatedSets.length > 0) {
        const targetSetCount = getTargetSetCount(ex.targetSets);
        const extras = extraSetCounts[exIdx] ?? 0;
        const removed = removedSetCounts[exIdx] ?? 0;
        const effectiveTotal = Math.max(targetSetCount + extras - removed, updatedSets.length);
        if (updatedSets.length < effectiveTotal) {
          setAiLoadingIdx(exIdx);
          getExerciseBests(ex.name).catch(() => null).then(bests => {
            getWeightRecommendation(authToken, ex.name, goal, updatedSets, updatedSets.length + 1, {
              targetSets: ex.targetSets,
              targetReps: ex.targetReps,
              progressionPace: 'moderate',
              experienceLevel: 'intermediate',
              recoveryLevel: 'normal',
              phase: 'accumulation',
              workoutFocus: workout.focus,
              weekNumber: 1,
              incrementLbs: (ex.equipment ?? '').toLowerCase().includes('dumbbell') ? 2.5 : 5,
              allTimeBestWeightLbs: bests?.allTime?.weightLbs,
              allTimeBestReps: bests?.allTime?.reps,
              lastSessionBestWeightLbs: bests?.lastSession?.weightLbs,
              lastSessionBestReps: bests?.lastSession?.reps,
              plannedTargetWeightLbs: ex.targetWeightLbs ?? undefined,
              exerciseSlug: ex.slug ?? undefined,
              equipment: ex.equipment,
              primaryMuscle: ex.primaryMuscle ?? undefined,
            }).then(rec => {
              const tip = `Set ${updatedSets.length + 1}: try ${rec.weightLbs} lbs x ${rec.reps} reps — ${rec.tip}`;
              setExercises(prev => prev.map((e, idx) => idx === exIdx ? { ...e, aiRecommendation: tip } : e));
              setAiLoadingIdx(null);
            }).catch(() => setAiLoadingIdx(null));
          });
        }
      }
    }, 800);
  }, [editDraft, exercises, authToken, goal, workout.focus, extraSetCounts, removedSetCounts]);

  const handleSaveEditedSet = useCallback(() => {
    const w = parseFloat(editSetWeight);
    const r = parseInt(editSetReps, 10);
    if (isNaN(w) || isNaN(r) || r <= 0 || w < 0) {
      Alert.alert('Invalid values', 'Enter a valid weight and reps.');
      return;
    }
    setExercises(prev => prev.map((ex, i) => {
      if (i !== editSetExIdx) return ex;
      const updatedSets = ex.sets.map((s, si) =>
        si === editSetIdx ? { ...s, weightLbs: w, reps: r } : s
      );
      return { ...ex, sets: updatedSets };
    }));
    setEditSetVisible(false);
  }, [editSetExIdx, editSetIdx, editSetWeight, editSetReps]);

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
  ) => {
    const key = `${exIdx}-${setSlot}`;
    const input = setInputs[key];
    const ex = exercises[exIdx];
    const timed = isTimedExercise(ex?.name ?? '', ex?.targetReps);

    // Watch-originated logs pass weight / reps directly as overrides
    // so we don't have to round-trip through React state first. Phone
    // UI continues to flow through setInputs.
    const effectiveWeight = overrideWeight ?? input?.weight;
    const effectiveReps = overrideReps ?? input?.reps;

    let newSet: CompletedSet;

    if (timed) {
      const durText = overrideDuration?.trim() || input?.duration?.trim() || '';
      if (!durText) {
        if (!silent) Alert.alert('Enter duration', 'Fill in the duration before logging this set.');
        return;
      }
      // Plain numbers default to minutes for long cardio (treadmill,
      // bike, etc.) and seconds for short holds (plank, dead hang).
      const preferMinutes = isLongCardioExercise(ex?.name ?? '', ex?.targetReps, { primaryMuscle: ex?.primaryMuscle });
      const durationSeconds = parseDurationInput(durText, preferMinutes);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        if (!silent) Alert.alert('Enter duration', 'Enter a valid duration like "25:00", "25 min", or "45s".');
        return;
      }
      newSet = { setNumber: setSlot + 1, reps: 0, weightLbs: 0, durationSeconds };
    } else {
      // Mirror the UI display predicates: when the exercise is
      // bodyweight-only we don't ask for weight, and when reps are a
      // duration string ("60s hold", "3 min") we don't ask for a rep
      // count. Logging succeeds with whatever the user actually
      // touched — the other axis stays null.
      const exMeta = {
        name: ex?.name, equipment: (ex as any)?.equipment,
        reps: ex?.targetReps,
        primary_muscle: (ex as any)?.primary_muscle,
        _primary_muscle: (ex as any)?._primary_muscle,
        _archetype: (ex as any)?._archetype,
        _training_type: (ex as any)?._training_type,
      };
      const skipWeight = shouldHideWeight(exMeta);
      const skipReps   = shouldHideReps(exMeta);
      const weightNum  = skipWeight ? 0 : parseFloat(effectiveWeight ?? '');
      const repsNum    = skipReps   ? 0 : parseInt(effectiveReps ?? '', 10);
      if (!skipWeight && (!effectiveWeight || isNaN(weightNum))) {
        if (!silent) Alert.alert('Enter values', 'Fill in weight before logging this set.');
        return;
      }
      if (!skipReps && (!effectiveReps || isNaN(repsNum) || repsNum <= 0)) {
        if (!silent) Alert.alert('Enter values', 'Fill in reps before logging this set.');
        return;
      }
      newSet = { setNumber: setSlot + 1, reps: repsNum, weightLbs: weightNum };
    }

    // Haptic feedback on set log
    import('../utils/feedback').then(f => f.hapticMedium()).catch(() => {});

    // Capture current HR from Apple Watch and stamp it on the set (non-blocking)
    getLatestHeartRate().then(hr => {
      if (hr && hr > 0) {
        setExercises(prev => prev.map((e, eIdx) => {
          if (eIdx !== exIdx) return e;
          const updated = [...e.sets];
          const target = updated[setSlot];
          if (target) updated[setSlot] = { ...target, heartRateAvg: hr };
          return { ...e, sets: updated };
        }));
      }
    }).catch(() => {});

    const targetSetCount = getTargetSetCount(ex.targetSets);
    // Effective total includes user-added extras minus removed sets, so
    // rest timers + AI tips still fire for sets added beyond the base target.
    const extras         = extraSetCounts[exIdx] ?? 0;
    const removed        = removedSetCounts[exIdx] ?? 0;
    const effectiveTotal = Math.max(targetSetCount + extras - removed, ex.sets.length + 1);

    // Insert or replace at the correct slot position
    const updatedSets = [...ex.sets];
    updatedSets[setSlot] = newSet;
    // Remove any trailing undefined slots
    const cleanSets = updatedSets.filter(Boolean);

    const updatedExercises = exercises.map((e, i) => i === exIdx ? { ...e, sets: cleanSets } : e);
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
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      const nextIdx = updatedExercises.findIndex((e, i) => i > exIdx && e.sets.length < getTargetSetCount(e.targetSets));
      setActiveExIdx(nextIdx >= 0 ? nextIdx : -1);
      nextExIdx = nextIdx >= 0 ? nextIdx : exIdx;
      import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
    } else {
      setActiveExIdx(exIdx);
    }

    // Mirror the phone's set + rest state to the watch so the wrist
    // stays in sync whether the log came from phone or watch.
    (async () => {
      try {
        const { pushProgressToWatch } = await import('../utils/watchSync');
        await pushProgressToWatch({
          exerciseIndex: nextExIdx,
          setNumber: cleanSets.length + 1,
        });
      } catch { /* watch bridge optional */ }
    })();

    // Start rest timer automatically if more sets remain
    if (cleanSets.length < effectiveTotal) {
      const restSeconds = Math.max(15, ex.targetRestSeconds || 60);
      const nextSetLabel = timed
        ? `Set ${cleanSets.length + 1}: ${ex.targetReps}`
        : `Set ${cleanSets.length + 1}: ${newSet.weightLbs} lbs x ${ex.targetReps}`;
      restDurationSeconds.current = restSeconds;
      setRestForExercise(ex.name);
      setRestRemaining(restSeconds);
      setRestNextTarget(nextSetLabel);
      setRestCue(null);
      startRestTimer(restSeconds, ex.name);
      // Push rest seconds to watch so its rest-timer view reflects the
      // phone's timer without running a second independent clock.
      (async () => {
        try {
          const { pushProgressToWatch } = await import('../utils/watchSync');
          await pushProgressToWatch({ restRemainingSec: restSeconds });
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
      clearRestState();
    }

    // AI tip for next set (skip for timed/cardio exercises)
    const setsLogged = cleanSets.length;
    if (!timed && setsLogged < effectiveTotal) {
      setAiLoadingIdx(exIdx);
      try {
        if (!authToken) throw new Error('Not authenticated');
        // Anchor the recommendation on what this user has hit before —
        // especially important for the first set of the session where
        // `cleanSets` is still empty and the backend would otherwise
        // fall back to a generic category default.
        const bests = await getExerciseBests(ex.name).catch(() => null);
        const rec = await getWeightRecommendation(authToken, ex.name, goal, cleanSets, setsLogged + 1, {
          targetSets: ex.targetSets,
          targetReps: ex.targetReps,
          progressionPace: 'moderate',
          experienceLevel: 'intermediate',
          recoveryLevel: 'normal',
          phase: 'accumulation',
          workoutFocus: workout.focus,
          weekNumber: 1,
          incrementLbs: (ex.equipment ?? '').toLowerCase().includes('dumbbell') ? 2.5 : 5,
          allTimeBestWeightLbs: bests?.allTime?.weightLbs,
          allTimeBestReps: bests?.allTime?.reps,
          lastSessionBestWeightLbs: bests?.lastSession?.weightLbs,
          lastSessionBestReps: bests?.lastSession?.reps,
          plannedTargetWeightLbs: ex.targetWeightLbs ?? undefined,
          exerciseSlug: ex.slug ?? undefined,
          equipment: ex.equipment,
          primaryMuscle: ex.primaryMuscle ?? undefined,
        });
        const tip = `Set ${setsLogged + 1}: try ${rec.weightLbs} lbs x ${rec.reps} reps — ${rec.tip}`;
        setRestNextTarget(`Set ${setsLogged + 1}: ${rec.weightLbs} lbs x ${rec.reps}`);
        setRestCue(rec.tip);
        setExercises(prev => prev.map((e, i) => i === exIdx ? { ...e, aiRecommendation: tip } : e));
        // Push the updated next-set rec to the Live Activity on the lock screen.
        if (liveActivityIdRef.current) {
          updateRestActivity(liveActivityIdRef.current, {
            setNumber: setsLogged,
            totalSets: getTargetSetCount(ex.targetSets),
            nextSetRecommendation: `${rec.weightLbs} lbs × ${rec.reps}`,
            exerciseName: ex.name,
            themeColorHex: theme.colors.primary,
          }).catch(() => undefined);
        }
      } catch {
        setAiErrorIdx(exIdx);
      } finally {
        setAiLoadingIdx(null);
      }
    }
  }, [setInputs, exercises, authToken, goal, workout.focus, startRestTimer, rescheduleRestNotifications, clearRestState, extraSetCounts, removedSetCounts]);

  const openAddExerciseModal = useCallback(async () => {
    setAddExerciseModalVisible(true);
    if (exerciseLibrary.length > 0) return;
    setExerciseLibraryLoading(true);
    try {
      const rows = await getExercises();
      // Merge AI-saved custom exercises from userProfile so they show up in
      // the search alongside the seeded backend library.
      let customs: ExerciseLibraryItem[] = [];
      try {
        const raw = await AsyncStorage.getItem('userProfile');
        if (raw) {
          const prof = JSON.parse(raw);
          customs = ((prof.customExercises ?? []) as any[]).map(ce => ({
            id: ce.id,
            name: ce.name,
            primary_muscle: ce.primary_muscle,
            secondary_muscles: [],
            equipment: ce.equipment,
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
      const existingNames = new Set([...customs, ...rows].map(e => e.name.toLowerCase()));
      const newTimed = timedActivities.filter(t => !existingNames.has(t.name.toLowerCase()));
      setExerciseLibrary([...customs, ...newTimed, ...rows]);
    } catch {
      setExerciseLibrary([]);
    } finally {
      setExerciseLibraryLoading(false);
    }
  }, [exerciseLibrary.length]);

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
      isCompound: item.is_compound ?? null,
      // Carry through enrichment metadata so a freshly-added exercise
      // (wger / AI / custom) renders with the same form-video card and
      // hero thumbnail as a planner-generated one.
      video_id: (item as any).video_id ?? null,
      image_url: (item as any).image_url ?? null,
    };
    setExercises(prev => {
      // Swap mode: replace the exercise at swapTargetIdx instead of appending.
      // Preserves any already-logged sets so a mid-workout swap doesn't wipe
      // work the user did on the old lift.
      if (swapTargetIdx != null && swapTargetIdx >= 0 && swapTargetIdx < prev.length) {
        const updated = prev.slice();
        const carryOverSets = updated[swapTargetIdx].sets ?? [];
        updated[swapTargetIdx] = {
          ...nextExercise,
          sets: carryOverSets,
          targetSets: updated[swapTargetIdx].targetSets,
          targetReps: updated[swapTargetIdx].targetReps,
          targetRestSeconds: updated[swapTargetIdx].targetRestSeconds,
        };
        setActiveExIdx(swapTargetIdx);
        return updated;
      }
      const updated = [...prev, nextExercise];
      setActiveExIdx(updated.length - 1);
      return updated;
    });
    setAddExerciseModalVisible(false);
    setSwapTargetIdx(null);
    setExerciseSearch('');
    setAiExerciseResults([]);
  }, [swapTargetIdx]);

  /** Run an AI exercise search using the currently-typed query. Respects the
   *  user's equipment + active injuries so the results are directly usable. */
  const handleAiExerciseSearch = useCallback(async () => {
    const q = exerciseSearch.trim();
    if (!q || !authToken) return;
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
  }, [exerciseSearch, authToken]);

  /** Add an AI search result directly to the current workout. Converts the
   *  AI shape into the same `ExerciseLibraryItem` shape `handleAddExercise`
   *  expects so the workout code doesn't need to know about AI origin. */
  const handleAddAiExercise = useCallback((ex: AIExerciseResult) => {
    handleAddExercise({
      id: `ai_${Date.now()}` as any,
      name: ex.name,
      primary_muscle: ex.primary_muscle as any,
      secondary_muscles: (ex.secondary_muscles ?? []) as any,
      equipment: ex.equipment as any,
      description: ex.why,
      is_custom: true,
      // Carry the enrichment fields the backend just normalized so the
      // active session sees the same metadata the seed catalog ships
      // with: form-video card via video_id, swap-scoring via
      // is_compound, hero thumbnail via image_url.
      video_id: ex.video_id ?? undefined,
      image_url: ex.image_url ?? undefined,
      is_compound: ex.is_compound ?? undefined,
    } as unknown as ExerciseLibraryItem);
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
  const startRestTimer = useCallback((seconds: number, exerciseName: string) => {
    if (restTimerRef.current) clearInterval(restTimerRef.current);
    restStartAtRef.current = Date.now();
    restTotalSecondsRef.current = seconds;
    restExerciseNameRef.current = exerciseName;

    // Persist the snapshot synchronously so an iOS background-kill or app
    // crash mid-rest can resume the countdown on relaunch. Refs are the
    // source of truth here (state updates are batched), and we capture the
    // current next-set tip + cue from their mirror refs.
    AsyncStorage.setItem('activeWorkoutRest', JSON.stringify({
      startAtMs: restStartAtRef.current,
      totalSeconds: seconds,
      exerciseName,
      nextTarget: restNextTargetRef.current,
      cue: restCueRef.current,
    })).catch(() => {});

    // Kick off a Live Activity on the lock screen. End any prior one first
    // (switching exercises mid-rest shouldn't orphan the old card). Wrapped
    // so any failure in the native bridge can't take down the workout.
    (async () => {
      try {
        if (liveActivityIdRef.current) {
          await endRestActivity(liveActivityIdRef.current);
          liveActivityIdRef.current = null;
        }
        const id = await startRestActivity({
          exerciseName,
          setNumber: 0,
          totalSets: 0,
          endDateMs: Date.now() + seconds * 1000,
          nextSetRecommendation: 'Computing…',
          themeColorHex: theme.colors.primary,
          workoutId: `w_${workout.focus}_${Date.now()}`,
        });
        liveActivityIdRef.current = id;
        // Diagnostic: on FIRST rest of the workout only, show an alert with
        // the result so we can debug "why isn't the lock-screen card
        // appearing". Suppresses itself on subsequent sets.
        if (!liveActivityDiagShownRef.current) {
          liveActivityDiagShownRef.current = true;
          const diag = getLastStartDiagnostic();
          Alert.alert('Live Activity diagnostic', diag ?? 'no diagnostic captured');
        }
      } catch (e) {
        console.warn('[ActiveWorkout] Live Activity start failed (non-fatal):', e);
      }
    })().catch(() => undefined);

    restTimerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - restStartAtRef.current) / 1000);
      const remaining = Math.max(0, restTotalSecondsRef.current - elapsed);
      setRestRemaining(remaining);

      if (remaining === 0) {
        if (restTimerRef.current) clearInterval(restTimerRef.current);
        restTimerRef.current = null;
        AsyncStorage.removeItem('activeWorkoutRest').catch(() => {});
        import('../utils/feedback').then(f => {
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
        // Don't cancel the completeId — it's the one that delivers
        // the background sound. Only cancel the warning notification
        // (which fires 10s before complete and is now in the past).
        if (restNotificationIds.current?.warningId) {
          Notifications.cancelScheduledNotificationAsync(restNotificationIds.current.warningId).catch(() => undefined);
        }
        restNotificationIds.current = null;
        // End the Live Activity on the lock screen.
        if (liveActivityIdRef.current) {
          endRestActivity(liveActivityIdRef.current).catch(() => undefined);
          liveActivityIdRef.current = null;
        }
      }
    }, 500); // 500ms tick for smooth countdown without drift
  }, [theme.colors.primary, workout.focus]);

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
        // Catch up rest timer
        if (restStartAtRef.current > 0 && restTotalSecondsRef.current > 0) {
          const restElapsed = Math.floor((Date.now() - restStartAtRef.current) / 1000);
          const remaining = Math.max(0, restTotalSecondsRef.current - restElapsed);
          setRestRemaining(remaining);
          if (remaining === 0 && restTimerRef.current) {
            clearInterval(restTimerRef.current);
            restTimerRef.current = null;
            AsyncStorage.removeItem('activeWorkoutRest').catch(() => {});
          }
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
        if (typeof data.nextTarget === 'string') setRestNextTarget(data.nextTarget);
        if (typeof data.cue === 'string') setRestCue(data.cue);
        setRestRemaining(remaining);
        startRestTimer(remaining, exName);
        console.log(`[ActiveWorkout] restored rest timer: ${remaining}s remaining for ${exName}`);
      } catch {
        AsyncStorage.removeItem('activeWorkoutRest').catch(() => {});
      }
    }).catch(() => {});
    // Mount-only restoration. startRestTimer is stable per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearRestState = useCallback(() => {
    if (restTimerRef.current) {
      clearInterval(restTimerRef.current);
      restTimerRef.current = null;
    }
    setRestRemaining(0);
    setRestForExercise(null);
    setRestCue(null);
    setRestNextTarget(null);
    restDurationSeconds.current = 0;
    restStartAtRef.current = 0;
    restTotalSecondsRef.current = 0;
    restExerciseNameRef.current = null;
    AsyncStorage.removeItem('activeWorkoutRest').catch(() => {});
    cancelRestNotifications(restNotificationIds.current).catch(() => undefined);
    restNotificationIds.current = null;
    if (liveActivityIdRef.current) {
      endRestActivity(liveActivityIdRef.current).catch(() => undefined);
      liveActivityIdRef.current = null;
    }
  }, []);

  const rescheduleRestNotifications = useCallback(async (params: {
    seconds: number;
    exerciseName: string;
    nextSetLabel: string;
    aiCue?: string | null;
    includeStartAlert?: boolean;
  }) => {
    cancelRestNotifications(restNotificationIds.current).catch(() => undefined);
    restNotificationIds.current = await scheduleRestNotifications(params);
  }, []);

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
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
    setExercises(prev => {
      const next = [...prev];
      [next[fromIdx], next[toIdx]] = [next[toIdx], next[fromIdx]];
      return next;
    });
    setActiveExIdx(toIdx);
  }, [exercises.length]);

  const handleLogSet = async () => {
    console.log('[LOG_SET] handleLogSet called with weight:', logWeight, 'reps:', logReps, 'exercise index:', logExIdx);
    const weightNum = parseFloat(logWeight);
    const repsNum   = parseInt(logReps, 10);
    if (!logWeight || !logReps || isNaN(weightNum) || isNaN(repsNum) || repsNum <= 0) {
      console.warn('[LOG_SET] Invalid input validation failed');
      Alert.alert('Invalid Input', 'Please enter valid weight and reps.');
      return;
    }

    // Capture synchronously before any state updates
    const exIdx = logExIdx;
    const ex    = exercises[exIdx];
    const targetSetCount = getTargetSetCount(ex.targetSets);
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

    // Over-target: prompt for RIR so progression has a real signal for
    // "how hard was that really?" Under-target stays as-is — hitting
    // failure is already a clear signal.
    const targetMax = parseTargetRepMax(ex.targetReps);
    if (targetMax != null && repsNum >= targetMax) {
      setPendingRir({ exIdx, setIdx: updatedSets.length - 1 });
    } else {
      setPendingRir(null);
    }

    // Start rest timer automatically if more sets remain for this exercise.
    if (updatedSets.length < targetSetCount) {
      const restSeconds = Math.max(15, ex.targetRestSeconds || 60);
      const nextSetLabel = `Set ${updatedSets.length + 1}: ${weightNum} lbs x ${ex.targetReps}`;
      restDurationSeconds.current = restSeconds;
      setRestForExercise(ex.name);
      setRestRemaining(restSeconds);
      setRestNextTarget(nextSetLabel);
      setRestCue(null);
      startRestTimer(restSeconds, ex.name);
      await rescheduleRestNotifications({
        seconds: restSeconds,
        exerciseName: ex.name,
        nextSetLabel,
        aiCue: null,
        includeStartAlert: true,
      });
    } else {
      clearRestState();
    }

    // ── Next-set recommendation is gated on feel ──────────────────
    // Previously we fired /recommend-weight immediately after logging
    // a set, which meant the AI card populated before the user had a
    // chance to tell the app how the set felt — and the rec was
    // working off half the signal. Now the fetch fires in
    // `handleSetFeedback` (after the user taps easy/good/hard/etc),
    // so the backend gets the feel field and the AI-reviewer layer
    // can flag feel-vs-reps conflicts properly.
    //
    // Clear any stale AI tip from a prior set so the card stays hidden
    // until the user rates this one.
    setExercises(prev => prev.map((e, i) => i === exIdx ? { ...e, aiRecommendation: undefined } : e));
    setRestNextTarget(null);
    setRestCue(null);
    const setsLogged = updatedSets.length;
    if (setsLogged >= targetSetCount) {
      console.log('[AI] Skipping recommendation - all sets completed for this exercise');
    } else {
      console.log('[AI] Recommendation deferred until user taps a feel chip');
    }
  };

  // A ref that tracks the LIVE rest-remaining value so rapid taps on
  // +/-15s accumulate properly. Without this, two fast clicks both
  // close over the same stale `restRemaining` and only add the delta
  // once. The interval already advances `restRemaining` independently;
  // we keep the ref in sync so the next tap reads the most recent
  // value, not whatever was current when the closure was built.
  const restRemainingRef = useRef(restRemaining);
  useEffect(() => { restRemainingRef.current = restRemaining; }, [restRemaining]);

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
    const targetSetCount = ex ? getTargetSetCount(ex.targetSets) : 3;
    if (!ex || setsForExercise.length >= targetSetCount || !authToken) return;
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
        incrementLbs: (ex.equipment ?? '').toLowerCase().includes('dumbbell') ? 2.5 : 5,
        allTimeBestWeightLbs: bests?.allTime?.weightLbs,
        allTimeBestReps: bests?.allTime?.reps,
        lastSessionBestWeightLbs: bests?.lastSession?.weightLbs,
        lastSessionBestReps: bests?.lastSession?.reps,
        plannedTargetWeightLbs: ex.targetWeightLbs ?? undefined,
        exerciseSlug: ex.slug ?? undefined,
        equipment: ex.equipment,
        primaryMuscle: ex.primaryMuscle ?? undefined,
      });
      const tip = `Set ${setsForExercise.length + 1}: try ${rec.weightLbs} lbs x ${rec.reps} reps — ${rec.tip}`;
      setRestNextTarget(`Set ${setsForExercise.length + 1}: ${rec.weightLbs} lbs x ${rec.reps}`);
      setRestCue(rec.tip);
      setExercises(prev => prev.map((item, i) => i === exIdx ? { ...item, aiRecommendation: tip } : item));

      if (restRemaining > 0 && restForExercise === ex.name) {
        await rescheduleRestNotifications({
          seconds: restRemaining,
          exerciseName: ex.name,
          nextSetLabel: `Set ${setsForExercise.length + 1}: ${rec.weightLbs} lbs x ${rec.reps}`,
          aiCue: rec.tip,
          includeStartAlert: false,
        });
      }
    } catch {
      setAiErrorIdx(exIdx);
    } finally {
      setAiLoadingIdx(null);
    }
  }, [authToken, exercises, goal, rescheduleRestNotifications, restForExercise, restRemaining]);

  const handleSetFeedback = useCallback(async (exIdx: number, feedback: SetFeedback) => {
    let nextSets: CompletedSet[] = [];
    setExercises(prev => prev.map((item, i) => {
      if (i !== exIdx || item.sets.length === 0) return item;
      nextSets = item.sets.map((set, setIdx) => (
        setIdx === item.sets.length - 1 ? { ...set, feedback } : set
      ));
      return { ...item, sets: nextSets };
    }));

    if (feedback === 'pain') {
      setRestCue('Pain flagged. Reduce load, shorten range if needed, and ask coach if it feels sharp or unstable.');
      setCoachModalVisible(true);
      setCoachChat(prev => prev.length > 0 ? prev : [{ role: 'assistant', content: 'Pain flagged on the last set. Tell me where you feel it and what exercise you are doing, and I will help you adjust.' }]);
    }

    if (nextSets.length > 0) {
      await refreshRecommendationForExercise(exIdx, nextSets);
    }
  }, [refreshRecommendationForExercise]);

  const handleSubmitFeedback = async (skip = false) => {
    // Close immediately — the user doesn't need a two-step confirmation
    // screen. Feedback persistence + the AI-driven plan update happen in
    // the background; if the plan changes, HomeScreen will pick it up on
    // next mount / planRefreshKey bump. If skip is true, we just dismiss.
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
              );
            } catch (e) {
              console.log('[handleSubmitFeedback] backend feedback patch failed:', e);
            }
          }
        }
        if (!authToken || (!captured.feeling && !captured.intensity)) return;

        const feelingLabels: Record<string, string> = {
          great: 'great — felt strong and energized',
          good: 'good — solid session',
          okay: 'okay — got through it',
          rough: 'rough — struggled throughout',
        };
        const intensityLabels: Record<number, string> = {
          1: 'way too easy',
          2: 'a bit easy',
          3: 'just right',
          4: 'hard but manageable',
          5: 'too hard / overwhelming',
        };
        const feelingText = captured.feeling ? feelingLabels[captured.feeling] : 'neutral';
        const intensityText = captured.intensity ? intensityLabels[captured.intensity] : 'moderate';
        const sorenessText = captured.soreness.length > 0 ? ` Soreness noted in: ${captured.soreness.join(', ')}.` : '';
        const notesText = captured.notes.trim() ? ` User note: "${captured.notes.trim()}".` : '';
        const question = `I just finished ${workout.focus}. Overall feeling: ${feelingText}. Perceived intensity: ${intensityText}.${sorenessText}${notesText} Based on this feedback, should my upcoming workouts be adjusted? If the intensity was wrong or I had soreness concerns, please update the plan.`;

        const resp = await askTrainerQuestion(authToken, {
          question,
          mode: 'trainer',
          profile: { goal },
          conversation: [],
        });
        if (resp.needs_plan_update && resp.updated_workout_plan) {
          await AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(resp.updated_workout_plan));
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

  // Kept in sync on every render so the watch command listener always
  // dispatches to the current finish / cancel closures.
  watchHandlersRef.current = {
    finish: () => { handleFinish(); },
    cancel: () => { onCancel(); },
  };

  const handleFinish = async () => {
    import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
    AsyncStorage.removeItem('activeWorkoutSets').catch(() => {}); AsyncStorage.removeItem('activeWorkoutStartTime').catch(() => {}); AsyncStorage.removeItem('activeWorkoutRest').catch(() => {}); AsyncStorage.removeItem('activeWatchSessionId').catch(() => {});
    // Reset feedback state for fresh form
    setSummaryStep('summary');
    setFeedbackFeeling(null);
    setFeedbackIntensity(null);
    setFeedbackSoreness([]);
    setFeedbackNotes('');
    setFeedbackResult(null);

    const now = new Date();
    const startedAtIso = new Date(startTime.current).toISOString();
    const endedAtIso = now.toISOString();
    const session: WorkoutSession = {
      id: `${Date.now()}`,
      date: now.toISOString(),
      focus: workout.focus,
      durationSeconds: elapsed,
      startedAt: startedAtIso,
      endedAt: endedAtIso,
      exercises,
      completed: true,
    };
    await saveWorkoutSession(session);
    // Push completed status immediately so the watch exits active state.
    import('../utils/watchSync').then(({ pushWorkoutToWatch }) =>
      pushWorkoutToWatch(workout as any, {
        dateISO: new Date().toISOString().slice(0, 10),
        status: 'completed',
        sessionId: watchSessionId.current,
      }).catch(() => {}),
    ).catch(() => {});
    // Snapshot the exact WorkoutDay the user just finished so plan
    // regeneration can't replace today's card with a different workout.
    await savePreservedCompletedWorkout(dateKey(now), workout);
    clearRestState();
    setFinishedSession(session);
    setFinishModalVisible(false);

    // Also persist completion to backend DB so it survives cache clears.
    // Now includes per-exercise per-set data so the backend can build
    // real WorkoutSession + WorkoutExercise + ExerciseSet rows for
    // downstream systems (plan reviewer, progression engine, analytics).
    // Fetch Apple Health data first so we can send it with the completion.
    let healthMetrics: { caloriesBurned?: number; hrSummary?: { avgBpm: number; maxBpm: number; zoneMinutes: number[] } } | undefined;
    try {
      if (isHealthKitAvailable() && await isAppleHealthEnabled()) {
        let profileAge: number | null = null;
        try {
          const r = await AsyncStorage.getItem('userProfile');
          if (r) profileAge = JSON.parse(r)?.physicalStats?.age ?? null;
        } catch {}
        const [watchCal, hrData] = await Promise.all([
          getAppleWorkoutCaloriesForWindow(startTime.current, now.getTime()),
          getWorkoutHrSummary(startTime.current, now.getTime(), profileAge),
        ]);
        healthMetrics = {};
        if (watchCal != null && watchCal > 0) healthMetrics.caloriesBurned = watchCal;
        if (hrData) healthMetrics.hrSummary = { avgBpm: hrData.avgBpm, maxBpm: hrData.maxBpm, zoneMinutes: [...hrData.zoneMinutes] };
      }
    } catch {}
    // Write the completed session to Apple Health so it shows up in
    // Fitness app + counts toward Activity rings. Best-effort —
    // requires write authorisation; silently skipped if HK isn't
    // available or the user hasn't granted permission.
    try {
      if (isHealthKitAvailable() && await isAppleHealthEnabled()) {
        const { saveWorkoutToHealth } = await import('../services/appleHealth');
        await saveWorkoutToHealth({
          startedAt: new Date(startTime.current),
          endedAt: now,
          activityTag: workout.focus,
          caloriesBurned: healthMetrics?.caloriesBurned ?? null,
        });
      }
    } catch { /* non-fatal */ }
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
          const distVal = exMetrics.distance ? parseFloat(exMetrics.distance) : null;
          const paceVal = exMetrics.pace || exMetrics.split || null;
          const extras = { ...exMetrics };
          delete extras.distance; delete extras.pace; delete extras.split;
          const hasExtras = Object.keys(extras).length > 0;
          return {
            name: ex.name,
            target_sets: typeof ex.targetSets === 'number' ? ex.targetSets : null,
            target_reps: typeof ex.targetReps === 'string' ? ex.targetReps : null,
            equipment: typeof ex.equipment === 'string' ? ex.equipment : null,
            order_index: idx,
            sets: ex.sets.map((s, si) => {
              const isLast = si === ex.sets.length - 1;
              return {
                set_number: s.setNumber ?? si + 1,
                reps: s.reps ?? 0,
                weight_lbs: s.weightLbs ?? 0,
                duration_seconds: s.durationSeconds ?? null,
                feedback: s.feedback ?? null,
                rir: null,
                heart_rate_avg: s.heartRateAvg ?? null,
                ...(isLast && distVal != null ? { actual_distance: distVal } : {}),
                ...(isLast && paceVal ? { actual_pace: paceVal } : {}),
                ...(isLast && hasExtras ? { cardio_metrics: extras } : {}),
              };
            }),
          };
        });
        const completeResp = await logWorkoutDone(authToken, dateKey(now), workout.focus, elapsed, exercisesPayload, {
          category: 'strength',
          subtype: workout.focus.toLowerCase().replace(/\s+/g, '_'),
          intensity: workout.stimulus === 'strength' ? 'hard' : workout.stimulus === 'volume' ? 'easy' : 'moderate',
        }, healthMetrics);
        console.log('[workout] logWorkoutDone OK — fatigue should update on next load');

        // Refresh the daily health snapshot so today's workout minutes
        // + active energy land in the backend's daily_health_snapshots
        // row before the user moves on. Without this, the post-workout
        // numbers wouldn't push until the next app foreground.
        import('../services/healthDataSummary')
          .then(({ refreshHealthDataSummary }) => refreshHealthDataSummary())
          .catch(() => undefined);

        // PR toast + persist on session for Progress history to show "🏆 PR!"
        const prs: PRAchievement[] = completeResp?.prs ?? [];
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
      if (authToken) {
        const s = await getWorkoutSummary(authToken, {
          exercises: session.exercises,
          durationSeconds: session.durationSeconds,
          focus: session.focus,
          goal,
          weightLbs,
        });
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
          const setsPlanned = session.exercises.reduce((sum, ex) => sum + (typeof ex.targetSets === 'number' ? ex.targetSets : 0), 0);
          const exercisesCompleted = session.exercises.filter(ex => (ex.sets?.length ?? 0) > 0).length;
          const exercisesPlanned = session.exercises.length;
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
          const ts = computeTrainingScore({
            archetype,
            goal: userGoal,
            actualDurationSec: session.durationSeconds,
            estimatedDurationSec: estimatedSec,
            setsCompleted, setsPlanned: setsPlanned > 0 ? setsPlanned : null,
            exercisesCompleted, exercisesPlanned,
            hrAvg: healthMetrics?.hrSummary?.avgBpm ?? null,
            hrMax: healthMetrics?.hrSummary?.maxBpm ?? null,
            hrZoneMinutes: healthMetrics?.hrSummary?.zoneMinutes
              ? healthMetrics.hrSummary.zoneMinutes.slice(0, 5) as [number, number, number, number, number]
              : null,
          });
          (s as any).trainingScore = ts.score;
          (s as any).trainingRating = ts.rating;
          (s as any).trainingPillars = ts.pillars;
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
        const totalReps = session.exercises.reduce((sum, ex) => ex.sets.reduce((rs, set) => rs + set.reps, sum), 0);
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
      const healthEnabled = await isAppleHealthEnabled();
      if (healthEnabled && isHealthKitAvailable()) {
        let profileAge: number | null = null;
        try {
          const r = await AsyncStorage.getItem('userProfile');
          if (r) profileAge = JSON.parse(r)?.physicalStats?.age ?? null;
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
      const resp = await askWorkoutQuestion(authToken, {
        question: effectiveQ,
        workout,
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

  // Max raw score from _scoreSwapCandidate: 12 primary + 5 compound +
  // 6 movement_pattern + 4 equipment = 27. Clamping to 100 scale so the
  // overlap meter reads as a natural percentage.
  const MAX_SWAP_SCORE = 27;
  const filteredExerciseLibrary: Array<ExerciseLibraryItem & { _overlap?: number }> = (() => {
    if (swapTargetIdx != null) {
      const targetName = exercises[swapTargetIdx]?.name;
      const base = targetName ? exerciseLibrary.find(li => li.name === targetName) : undefined;
      const q = exerciseSearch.trim().toLowerCase();
      // Equipment filter: check the concrete gear list first (slug or
      // name match), fall back to legacy bucket. Bodyweight is always ok.
      const owned = new Set(ownedEquipment.map(e => e.toLowerCase()));
      owned.add('bodyweight');
      owned.add('none');
      const isUsable = (item: ExerciseLibraryItem): boolean => {
        if (item.gear && item.gear.length > 0) {
          const required = item.gear.filter((g: any) => g.required !== false);
          if (required.length === 0) return true;
          return required.every((g: any) =>
            owned.has(g.slug?.toLowerCase?.() ?? '') || owned.has(g.name?.toLowerCase?.() ?? ''),
          );
        }
        const eq = (item.equipment ?? '').toLowerCase();
        if (!eq) return true;
        if (eq.includes('bodyweight')) return true;
        return owned.has(eq);
      };
      if (!base) {
        return exerciseLibrary
          .filter(isUsable)
          .filter(item => {
            if (!q) return true;
            return [item.name, item.primary_muscle ?? '', item.equipment ?? '']
              .join(' ')
              .toLowerCase()
              .includes(q);
          })
          .slice(0, 10);
      }
      const scored: Array<{ item: ExerciseLibraryItem; score: number }> = [];
      for (const item of exerciseLibrary) {
        if (item.name === targetName) continue;
        if (!isUsable(item)) continue;
        if (q && ![item.name, item.primary_muscle ?? '', item.equipment ?? ''].join(' ').toLowerCase().includes(q)) continue;
        const s = _scoreSwapCandidate(base, item);
        if (s <= 0) continue;
        scored.push({ item, score: s });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, 10).map(s => ({
        ...s.item,
        _overlap: Math.min(100, Math.round((s.score / MAX_SWAP_SCORE) * 100)),
      }));
    }
    // Add-exercise branch (no swap target). Same equipment gate so
    // unreachable exercises stay hidden.
    const owned = new Set(ownedEquipment.map(e => e.toLowerCase()));
    owned.add('bodyweight');
    owned.add('none');
    return exerciseLibrary.filter(item => {
      if (item.gear && item.gear.length > 0) {
        const required = item.gear.filter((g: any) => g.required !== false);
        if (required.length > 0 && !required.every((g: any) =>
          owned.has(g.slug?.toLowerCase?.() ?? '') || owned.has(g.name?.toLowerCase?.() ?? ''),
        )) return false;
      } else {
        const eq = (item.equipment ?? '').toLowerCase();
        if (eq && !eq.includes('bodyweight') && !owned.has(eq)) return false;
      }
      const q = exerciseSearch.trim().toLowerCase();
      if (!q) return true;
      return [item.name, item.primary_muscle ?? '', item.equipment ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  })();

  return (
    <View style={[styles.container, { backgroundColor: themeColors.background }] }>

      {/* Header */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.focusLabel}>{workout.focus}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text style={styles.timer}>{formatTime(elapsed)}</Text>
            {liveHR != null && liveHR > 0 && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: themeColors.error + '18', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 }}>
                <Text style={{ fontSize: 12, color: themeColors.error }}>♥</Text>
                <Text style={{ fontSize: 14, fontWeight: '800', color: themeColors.error }}>{liveHR}</Text>
              </View>
            )}
          </View>
        </View>
        <View style={styles.headerRight}>
          <Text style={styles.progressText}>{completedCount}/{exercises.length}</Text>
          <Text style={styles.progressSub}>done</Text>
        </View>
        <TouchableOpacity style={styles.cancelBtn} onPress={() => Alert.alert(
          'Cancel Workout', 'Your progress will be lost.',
          [{ text: 'Keep Going', style: 'cancel' }, { text: 'Cancel', style: 'destructive', onPress: () => { clearRestState(); AsyncStorage.removeItem('activeWorkoutSets').catch(() => {}); AsyncStorage.removeItem('activeWorkoutStartTime').catch(() => {}); AsyncStorage.removeItem('activeWorkoutRest').catch(() => {}); AsyncStorage.removeItem('activeWatchSessionId').catch(() => {}); import('../utils/watchSync').then(({ pushWorkoutToWatch }) => pushWorkoutToWatch(workout as any, { dateISO: new Date().toISOString().slice(0, 10), status: 'skipped', sessionId: watchSessionId.current }).catch(() => {})).catch(() => {}); onCancel(); } }]
        )}>
          <Text style={styles.cancelBtnText}>X</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.coachBtn} onPress={() => setCoachModalVisible(true)}>
          <Text style={styles.coachBtnText}>Ask Coach</Text>
        </TouchableOpacity>
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
          {warmupSteps.map((step, index) => (
            <Text key={index} style={styles.warmupStep}>{index + 1}. {step}</Text>
          ))}
          <View style={styles.warmupActions}>
            <TouchableOpacity style={[styles.warmupDoneBtn, { backgroundColor: workoutPalette.strong, flex: 1 }]} onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setWarmupDone(true); setWarmupExpanded(false); }}>
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
          onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setWarmupExpanded(v => !v); }}
          style={[
            styles.warmupCollapsed,
            { backgroundColor: workoutPalette.soft, borderColor: workoutPalette.strong },
          ]}>
          <View style={styles.warmupCollapsedHeader}>
            <Text style={[styles.warmupCollapsedTitle, { color: workoutPalette.text }]}>
              Warm-Up <Ionicons name={warmupExpanded ? 'chevron-down' : 'chevron-forward'} size={12} />
            </Text>
            <Text style={[styles.warmupCollapsedHint, { color: workoutPalette.text }]}>
              {warmupExpanded ? 'Tap to hide' : `${warmupSteps.length} steps · tap to view`}
            </Text>
          </View>
          {warmupExpanded && (
            <View style={{ marginTop: 8 }}>
              {warmupSteps.map((step, index) => (
                <Text key={index} style={styles.warmupStep}>{index + 1}. {step}</Text>
              ))}
            </View>
          )}
        </TouchableOpacity>
      )}

      {restRemaining > 0 && (
        <View style={[styles.restBanner, { backgroundColor: workoutPalette.soft, borderColor: workoutPalette.strong }, restRemaining <= 10 && styles.restBannerUrgent]}>
          {/* Left: circular countdown ring with big numeric time inside.
              Ring fills as the timer counts DOWN (progress = elapsed /
              total), so the user sees how much rest they've burned. The
              strokeDashoffset is computed per render off `restRemaining`
              — the state already ticks every second, so no Animated.Value
              is needed here. */}
          <View style={styles.restBannerLeft}>
            {(() => {
              const size = 88;
              const strokeWidth = 6;
              const r = (size - strokeWidth) / 2;
              const circumference = 2 * Math.PI * r;
              const total = Math.max(1, restDurationSeconds.current || restRemaining);
              const progress = Math.max(0, Math.min(1, 1 - (restRemaining / total)));
              const ringColor = restRemaining <= 10 ? themeColors.warning : workoutPalette.strong;
              return (
                <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
                  <Svg width={size} height={size} style={{ position: 'absolute' }}>
                    <Circle
                      cx={size / 2}
                      cy={size / 2}
                      r={r}
                      stroke={workoutPalette.strong + '22'}
                      strokeWidth={strokeWidth}
                      fill="none"
                    />
                    <Circle
                      cx={size / 2}
                      cy={size / 2}
                      r={r}
                      stroke={ringColor}
                      strokeWidth={strokeWidth}
                      strokeLinecap="round"
                      fill="none"
                      strokeDasharray={`${circumference} ${circumference}`}
                      strokeDashoffset={circumference * (1 - progress)}
                      transform={`rotate(-90 ${size / 2} ${size / 2})`}
                    />
                  </Svg>
                  <Text style={[styles.restBannerLabel, { color: workoutPalette.text, marginTop: -4 }]}>REST</Text>
                  <Text style={[
                    styles.restBannerTime,
                    { color: workoutPalette.text, fontSize: 22, lineHeight: 26 },
                    restRemaining <= 10 && styles.restBannerTimeUrgent,
                  ]}>
                    {formatTime(restRemaining)}
                  </Text>
                </View>
              );
            })()}
          </View>
          {/* Center: next set info + AI recommendation */}
          <View style={styles.restBannerCenter}>
            {restForExercise ? <Text style={styles.restExerciseText} numberOfLines={1}>{restForExercise}</Text> : null}
            {restNextTarget ? (
              <View style={{ backgroundColor: workoutPalette.strong + '22', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, marginVertical: 2 }}>
                <Text style={{ fontSize: 14, color: workoutPalette.strong, fontWeight: '900' }} numberOfLines={2}>{restNextTarget}</Text>
              </View>
            ) : null}
            {restCue ? <Text style={{ fontSize: 12, color: workoutPalette.text, fontWeight: '600', lineHeight: 16 }}>{restCue}</Text> : null}
          </View>
          {/* Right: adjust + skip */}
          <View style={styles.restBannerActions}>
            <TouchableOpacity style={styles.restBannerBtn} onPress={() => adjustActiveRestRemaining(15)}>
              <Text style={styles.restBannerBtnText}>+15s</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.restBannerBtn} onPress={() => adjustActiveRestRemaining(-15)}>
              <Text style={styles.restBannerBtnText}>−15s</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.restBannerBtn, styles.restBannerBtnPrimary, { backgroundColor: workoutPalette.strong }]} onPress={clearRestState}>
              <Text style={styles.restBannerBtnPrimaryText}>Skip</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Exercise list */}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" onScrollBeginDrag={Keyboard.dismiss}>
        {/* Warm-up collapsed header — scrolls with exercises */}
        {warmupDone && warmupSteps.length > 0 && (
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setWarmupExpanded(v => !v); }}
            style={[styles.warmupCollapsed, { backgroundColor: workoutPalette.soft, borderColor: workoutPalette.strong }]}>
            <View style={styles.warmupCollapsedHeader}>
              <Text style={[styles.warmupCollapsedTitle, { color: workoutPalette.text }]}>
                Warm-Up <Ionicons name={warmupExpanded ? 'chevron-down' : 'chevron-forward'} size={12} />
              </Text>
              <Text style={[styles.warmupCollapsedHint, { color: workoutPalette.text }]}>
                {warmupExpanded ? 'Tap to hide' : `${warmupSteps.length} steps`}
              </Text>
            </View>
            {warmupExpanded && (
              <View style={{ marginTop: 8 }}>
                {warmupSteps.map((step, index) => (
                  <Text key={index} style={styles.warmupStep}>{index + 1}. {step}</Text>
                ))}
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
          const isDone          = ex.sets.length >= totalSetCount;
          // Fire the big check-stamp once on the false→true transition.
          // Ref flag per-index prevents replays on every re-render.
          if (isDone && !exerciseCompleteWasDone[i]) {
            exerciseCompleteWasDone[i] = true;
            playExerciseCompleteStamp(i);
          } else if (!isDone && exerciseCompleteWasDone[i]) {
            exerciseCompleteWasDone[i] = false;
            getExerciseCompleteScale(i).setValue(0);
          }
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
          const restLabel       = `${Math.max(15, ex.targetRestSeconds || 60)}s rest`;

          return (
            <View key={i} style={[styles.exerciseCard, isDone && styles.exerciseCardDone, isActive && styles.exerciseCardActive]}>

              {/* ── Header row: tap to expand/collapse ── */}
              <TouchableOpacity
                style={styles.exerciseHeader}
                onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {}); setActiveExIdx(isActive ? -1 : i); }}
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
                        setFormVideoExerciseName(ex.name);
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
                  <Text
                    style={[styles.exerciseName, isDone && styles.exerciseNameDone]}
                    numberOfLines={isActive ? 2 : 1}
                    ellipsizeMode="tail"
                  >
                    {ex.name}
                  </Text>
                  <Text
                    style={styles.exerciseMeta}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                  >
                    {targetSetCount} × {ex.targetReps}  ·  {restLabel}
                    {formatEquipmentLabel(ex.equipment) ? `  ·  ${formatEquipmentLabel(ex.equipment)}` : ''}
                  </Text>
                  {timed && hrZones.length > 0 && (() => {
                    const n = (ex.name || '').toLowerCase();
                    const isInterval = /interval|hiit|sprint|tabata/.test(n);
                    const isEasy = /walk|jog|easy|zone.?2|recovery/.test(n);
                    const zone = isEasy ? hrZones[0] : isInterval ? hrZones[3] : hrZones[1];
                    if (!zone) return null;
                    return (
                      <Text style={{ fontSize: 11, color: themeColors.primary, fontWeight: '700', marginTop: 1 }}>
                        Target: Z{zone.zone} {zone.label} ({zone.low}–{zone.high} bpm)
                      </Text>
                    );
                  })()}
                  {bestLastSet && bestLastSet.weightLbs > 0 && !isDone && (
                    <Text style={{ fontSize: 13, color: themeColors.primary, fontWeight: '700', marginTop: 1 }}>
                      Last: {bestLastSet.weightLbs}×{bestLastSet.reps}
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
                {/* Swap — replace with a similar exercise (same muscle) */}
                {!isDone && (
                  <TouchableOpacity
                    style={{ padding: 6, marginLeft: 2 }}
                    onPress={() => {
                      setSwapTargetIdx(i);
                      setExerciseSearch('');
                      setAiExerciseResults([]);
                      openAddExerciseModal();
                    }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel={`Swap ${ex.name} for a similar exercise`}>
                    <Ionicons name="swap-horizontal" size={16} color={themeColors.textMuted} />
                  </TouchableOpacity>
                )}
                {/* Timer — AMRAP/EMOM/Tabata */}
                {(() => {
                  const tMode = detectTimerMode(ex.targetReps, (ex as any).set_type);
                  if (!tMode || isDone) return null;
                  return (
                    <TouchableOpacity
                      style={{ padding: 6, marginLeft: 2 }}
                      onPress={() => {
                        setTimerMode(tMode);
                        setTimerExerciseIdx(i);
                        setTimerModalVisible(true);
                        import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
                      }}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      accessibilityRole="button"
                      accessibilityLabel={`Start ${tMode.toUpperCase()} timer`}>
                      <Ionicons name="timer-outline" size={16} color={themeColors.primary} />
                    </TouchableOpacity>
                  );
                })()}
                {/* Dislike — exclude from future plans */}
                {onDislikeExercise && !isDone && (
                  <TouchableOpacity
                    style={{ padding: 6, marginLeft: 2 }}
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
                    }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="thumbs-down-outline" size={16} color={themeColors.textMuted} />
                  </TouchableOpacity>
                )}
                {/* Reorder — move exercise up/down */}
                {isActive && i > 0 && (
                  <TouchableOpacity
                    style={{ padding: 5, marginLeft: 2 }}
                    onPress={() => handleReorderExercise(i, 'up')}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel="Move exercise up">
                    <Ionicons name="arrow-up" size={14} color={themeColors.textMuted} />
                  </TouchableOpacity>
                )}
                {isActive && i < exercises.length - 1 && (
                  <TouchableOpacity
                    style={{ padding: 5, marginLeft: 0 }}
                    onPress={() => handleReorderExercise(i, 'down')}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel="Move exercise down">
                    <Ionicons name="arrow-down" size={14} color={themeColors.textMuted} />
                  </TouchableOpacity>
                )}
                {/* Small red remove button — only when more than one exercise */}
                {exercises.length > 1 && (
                  <TouchableOpacity
                    style={styles.removeBtn}
                    onPress={() => handleRemoveExercise(i)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Text style={styles.removeBtnText}>−</Text>
                  </TouchableOpacity>
                )}
              </TouchableOpacity>

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
                  {ex.sets.length === 0 && preSetHints[i] && preSetHints[i].recommendedWeight != null && (
                    <View style={{
                      borderLeftWidth: 3,
                      borderLeftColor: workoutPalette.strong,
                      backgroundColor: workoutPalette.strong + '14',
                      paddingHorizontal: 12, paddingVertical: 10,
                      borderRadius: 8, marginTop: 8, marginBottom: 4,
                    }}>
                      <Text style={{ fontSize: 10, fontWeight: '700', color: themeColors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                        Recommended weight
                      </Text>
                      <Text style={{ fontSize: 18, fontWeight: '800', color: themeColors.textPrimary, marginTop: 2 }}>
                        {Math.round(preSetHints[i].recommendedWeight!)} lb
                        {preSetHints[i].recommendedReps ? (
                          <Text style={{ fontSize: 14, fontWeight: '600', color: themeColors.textSecondary }}>
                            {' '}× {preSetHints[i].recommendedReps}
                          </Text>
                        ) : null}
                      </Text>
                    </View>
                  )}

                  {/* ── Form video link ── */}
                  <TouchableOpacity
                    style={styles.formVideoLink}
                    onPress={() => setFormVideoExerciseName(ex.name)}
                    activeOpacity={0.7}>
                    <Text style={styles.formVideoLinkText}>▶ Form Video</Text>
                  </TouchableOpacity>

                  {/* ── RIR prompt — shown after an over-target set ── */}
                  {pendingRir && pendingRir.exIdx === i && (
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
                                setExercises(prev => prev.map((e, ei) => {
                                  if (ei !== i) return e;
                                  const sets = e.sets.slice();
                                  if (sets[setIdx]) sets[setIdx] = { ...sets[setIdx], rir };
                                  return { ...e, sets };
                                }));
                                setPendingRir(null);
                                refreshRecommendationForExercise(i, updatedSets);
                              }}
                              style={{ flex: 1, minWidth: 44, paddingVertical: 8, borderRadius: 8, alignItems: 'center', backgroundColor: workoutPalette.strong }}>
                              <Text style={{ color: '#fff', fontSize: 13, fontWeight: '800' }}>{label}</Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                      <TouchableOpacity onPress={() => {
                        setPendingRir(null);
                        refreshRecommendationForExercise(i, exercises[i].sets);
                      }} style={{ alignSelf: 'flex-end', paddingVertical: 2 }}>
                        <Text style={{ fontSize: 11, color: themeColors.textMuted, fontWeight: '700' }}>Skip</Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  {/* AI tip block removed from the exercise card — the
                      same `ex.aiRecommendation` is now surfaced inside
                      the rest-timer modal so the user only sees it
                      between sets when it's actionable, instead of
                      duplicated here. The state + fetch logic stays
                      intact (aiLoadingIdx / aiErrorIdx / aiRecommendation)
                      so the rest timer can keep reading it. */}

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
                                      <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800' }}>Start</Text>
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
                                        <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>
                                          {isMultiInterval ? 'Log Round' : 'Done'}
                                        </Text>
                                      </TouchableOpacity>
                                    </>
                                  ) : (
                                    <>
                                      <TouchableOpacity
                                        style={{ backgroundColor: themeColors.primary, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12 }}
                                        onPress={() => startExerciseTimer(timerKey)}>
                                        <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>Resume</Text>
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
                                        R{si + 1}: {s.durationSeconds != null ? `${Math.floor(s.durationSeconds / 60)}:${(s.durationSeconds % 60).toString().padStart(2, '0')}` : `${s.reps} reps`}
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
                                  />
                                </View>
                              )}
                              {/* Optional metrics input — shown when done, exercise-type-specific */}
                              {allDone && (() => {
                                const metrics = getTimedMetricsFields(ex.name);
                                if (!metrics) return null;
                                return (
                                  <View style={{ backgroundColor: themeColors.surfaceRaised, borderRadius: 10, padding: 12, marginTop: 10, gap: 8, borderWidth: 1, borderColor: themeColors.border }}>
                                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                                      <Text style={{ fontSize: 12, fontWeight: '700', color: themeColors.textMuted }}>Session Details</Text>
                                      <Text style={{ fontSize: 10, color: themeColors.textMuted, fontStyle: 'italic' }}>Fill in what's relevant</Text>
                                    </View>
                                    {metrics.map(m => (
                                      <View key={m.key} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                                        <Text style={{ fontSize: 13, color: themeColors.textSecondary, fontWeight: '600' }}>{m.label}</Text>
                                        <TextInput
                                          style={[styles.inlineInput, { width: 110, textAlign: 'center' }]}
                                          placeholder={m.placeholder}
                                          placeholderTextColor={themeColors.textMuted}
                                          keyboardType={m.keyboard}
                                          value={timedMetrics[`${i}-${m.key}`] ?? ''}
                                          onChangeText={v => setTimedMetrics(prev => ({ ...prev, [`${i}-${m.key}`]: v }))}
                                        />
                                      </View>
                                    ))}
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
                            primary_muscle: (ex as any).primary_muscle,
                            _primary_muscle: (ex as any)._primary_muscle,
                            _archetype: (ex as any)._archetype,
                            _training_type: (ex as any)._training_type,
                          });
                          const hideReps = shouldHideReps({
                            name: ex.name, equipment: ex.equipment,
                            reps: ex.targetReps,
                            primary_muscle: (ex as any).primary_muscle,
                            _primary_muscle: (ex as any)._primary_muscle,
                            _archetype: (ex as any)._archetype,
                            _training_type: (ex as any)._training_type,
                          });
                          return (
                        <View style={styles.inlineSetsHeader}>
                          <Text style={[styles.inlineSetsLabel, { width: 20, flex: 0 }]}>#</Text>
                              {!hideWeight && <Text style={styles.inlineSetsLabel}>Weight</Text>}
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
                                : `${lastSet.weightLbs}×${lastSet.reps}`)
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
                            <Animated.View
                              key={slot}
                              style={[styles.inlineSetRow, isLogged && styles.inlineSetRowDone, { backgroundColor: pulseBg }]}>
                              <Text style={styles.inlineSetNum}>{slot + 1}</Text>
                              {!hideWeight && <AnimatedTextInput
                                style={[
                                  styles.inlineInput,
                                  isLogged && styles.inlineInputDone,
                                  // Override border props with animated values on unlogged
                                  // rows. Logged rows keep the "done" tint so the user can
                                  // see at a glance which sets are already written.
                                  !isLogged && { borderColor: weightBorderColor, borderWidth: weightBorderWidth },
                                ]}
                                value={isLogged ? (editingSetKey === inputKey ? (editDraft.weight ?? String(logged.weightLbs)) : String(logged.weightLbs)) : input.weight}
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
                                placeholder="lbs"
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
                              <Text style={styles.inlineLastResult} numberOfLines={1}>{lastTimeLabel}</Text>
                              {(() => {
                                // Spring-pop the badge on the first render
                                // after `isLogged` flips true. Flag is
                                // per-set-key so re-renders don't retrigger.
                                const badgeKey = `${i}-${slot}`;
                                const badgeScale = getSetBadgeScale(badgeKey);
                                if (isLogged && !setBadgeWasLogged[badgeKey]) {
                                  setBadgeWasLogged[badgeKey] = true;
                                  popSetBadge(badgeKey);
                                } else if (!isLogged && setBadgeWasLogged[badgeKey]) {
                                  setBadgeWasLogged[badgeKey] = false;
                                  badgeScale.setValue(1);
                                }
                                return (
                                  <TouchableOpacity
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
                          );
                        })}
                      </>
                    );
                  })()}

                  {(() => {
                    const timedInterval = isTimedExercise(ex.name, ex.targetReps) && totalSetCount >= 2;
                    const unitLabel = timedInterval ? 'Interval' : 'Set';
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
          );
        })}

        {/* Add Exercise — outside/below exercise cards */}
        {warmupDone && (
          <>
            <TouchableOpacity style={styles.addExerciseBtn} onPress={openAddExerciseModal}>
              <Text style={styles.addExerciseBtnText}>+ Add Exercise</Text>
            </TouchableOpacity>
            <PressableScale
              style={[styles.finishBtn, completedCount === 0 && styles.finishBtnDisabled]}
              disabled={completedCount === 0}
              accessibilityRole="button"
              accessibilityLabel="Finish workout"
              onPress={() => {
                if (completedCount === 0) {
                  Alert.alert('No sets logged', 'Log at least one set before finishing.');
                  return;
                }
                import('../utils/feedback').then(f => f.hapticMedium()).catch(() => {});
                setFinishModalVisible(true);
              }}>
              <Text style={styles.finishBtnText}><Ionicons name="checkmark-circle" size={16} color="#fff" />  Finish Workout</Text>
            </PressableScale>
          </>
        )}
      </ScrollView>

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
                        setFormVideoExerciseName(mEx.name);
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
                      <Text style={styles.timerModalBigBtnText}>{mElapsed > 0 ? 'Resume' : 'Start'}</Text>
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
                    <Text style={[styles.timerModalSecondaryBtnText, { color: '#fff', fontWeight: '800' }]}>
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
                  <Text style={styles.logInputLabel}>Weight (lbs)</Text>
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
          <View style={styles.finishModal}>
            <Text style={styles.finishModalTitle}>Finish Workout?</Text>
            <Text style={styles.finishModalBody}>
              {formatTime(elapsed)}  |  {completedCount}/{exercises.length} exercises done
            </Text>
            <TouchableOpacity style={styles.finishConfirmBtn} onPress={handleFinish}>
              <Text style={styles.finishConfirmText}>Save and Finish</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setFinishModalVisible(false)}>
              <Text style={styles.finishCancelText}>Keep Going</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Post-Workout Summary Modal — Step 1: Summary / Step 2: Feedback */}
      <Modal visible={summaryVisible} transparent animationType="slide" onRequestClose={() => {
        if (summaryStep === 'confirmation') { dismissSummaryModal(); return; }
        handleSubmitFeedback(true);
      }}>
        <View style={styles.summaryBackdrop}>
          <ScrollView contentContainerStyle={styles.summaryScroll} keyboardShouldPersistTaps="handled">

            {summaryStep === 'summary' ? (
              /* ── Step 1: Shareable Workout Summary Card ────────────────────── */
              <View style={styles.summaryModal}>
                <ViewShot ref={summaryCardRef} options={{ format: 'png', quality: 1 }}>
                  <View style={styles.shareCard}>
                    {/* Gradient-like header band */}
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

                    {/* Focus title */}
                    <Text style={styles.shareCardFocus}>{workout.focus}</Text>

                    {/* Stats grid */}
                    <View style={styles.shareStatsGrid}>
                      <View style={styles.shareStatTile}>
                        <Ionicons name="time-outline" size={16} color={themeColors.textMuted} />
                        <Text style={styles.shareStatValue}>{formatTime(finishedSession?.durationSeconds ?? elapsed)}</Text>
                        <Text style={styles.shareStatLabel}>Duration</Text>
                      </View>
                      <View style={styles.shareStatTile}>
                        <Text style={styles.shareStatIcon}><Ionicons name="barbell" size={14} /></Text>
                        <Text style={styles.shareStatValue}>{finishedSession?.exercises.reduce((t, e) => t + e.sets.length, 0) ?? 0}</Text>
                        <Text style={styles.shareStatLabel}>Sets</Text>
                      </View>
                      <View style={styles.shareStatTile}>
                        <Text style={styles.shareStatIcon}><Ionicons name="fitness" size={14} /></Text>
                        <Text style={styles.shareStatValue}>{completedCount}/{exercises.length}</Text>
                        <Text style={styles.shareStatLabel}>Exercises</Text>
                      </View>
                      {summaryData?.caloriesBurned ? (
                        <View style={styles.shareStatTile}>
                          <Text style={styles.shareStatIcon}><Ionicons name="flame" size={14} /></Text>
                          <Text style={styles.shareStatValue}>~{summaryData.caloriesBurned}</Text>
                          <Text style={styles.shareStatLabel}>Calories</Text>
                        </View>
                      ) : null}
                      {summaryData?.hrAvg ? (
                        <View style={styles.shareStatTile}>
                          <Text style={styles.shareStatIcon}><Ionicons name="pulse" size={14} /></Text>
                          <Text style={styles.shareStatValue}>{summaryData.hrAvg}</Text>
                          <Text style={styles.shareStatLabel}>Avg HR</Text>
                        </View>
                      ) : null}
                      {summaryData?.hrMax ? (
                        <View style={styles.shareStatTile}>
                          <Text style={styles.shareStatIcon}><Ionicons name="heart" size={14} /></Text>
                          <Text style={styles.shareStatValue}>{summaryData.hrMax}</Text>
                          <Text style={styles.shareStatLabel}>Max HR</Text>
                        </View>
                      ) : null}
                    </View>
                    {summaryData?.trainingScore != null && (() => {
                      const score = summaryData.trainingScore!;
                      const scoreColor = score >= 85 ? themeColors.success
                        : score >= 65 ? themeColors.primary
                        : score >= 45 ? themeColors.warning
                        : themeColors.error;
                      const p = summaryData.trainingPillars ?? { effort: 0, volume: 0, duration: 0, consistency: 0 };
                      // Per-pillar maxima from `services/trainingScore.ts`.
                      // Used to compute the "+N to max" delta + actionable
                      // tip shown when the user taps to expand.
                      const PILLAR_MAX = { effort: 40, volume: 25, duration: 20, consistency: 15 };
                      const tipFor = (key: 'effort' | 'volume' | 'duration' | 'consistency'): string => {
                        if (key === 'effort') return 'More time in Z3+ heart rate (or higher self-rated intensity).';
                        if (key === 'volume') return 'Complete all planned sets.';
                        if (key === 'duration') return 'Train 85–120% of the estimated session duration.';
                        return 'Complete every planned exercise.';
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
                              marginTop: 8, marginBottom: 4, gap: 12,
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
                                E {p.effort}/40 · V {p.volume}/25 · T {p.duration}/20 · C {p.consistency}/15
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
                              borderRadius: 10, padding: 12, marginTop: -2, marginBottom: 6, gap: 8,
                              borderWidth: 1, borderColor: themeColors.border,
                            }}>
                              <Text style={{ fontSize: 10, fontWeight: '800', color: themeColors.textMuted, letterSpacing: 0.5 }}>
                                HOW THIS IS SCORED
                              </Text>
                              {(['effort', 'volume', 'duration', 'consistency'] as const).map(key => {
                                const value = p[key];
                                const max = PILLAR_MAX[key];
                                const deficit = Math.max(0, max - value);
                                const pct = Math.round((value / max) * 100);
                                const label = key === 'duration' ? 'Time' : key.charAt(0).toUpperCase() + key.slice(1);
                                const barColor = pct >= 90 ? themeColors.success : pct >= 60 ? themeColors.primary : themeColors.warning;
                                return (
                                  <View key={key} style={{ gap: 3 }}>
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
                                        {tipFor(key)}
                                      </Text>
                                    )}
                                  </View>
                                );
                              })}
                              <Text style={{ fontSize: 9, color: themeColors.textMuted, fontStyle: 'italic', marginTop: 2, lineHeight: 12 }}>
                                Effort favors Z3+ heart rate. Mobility / recovery sessions count as full credit even when easy.
                              </Text>
                            </View>
                          )}
                        </View>
                      );
                    })()}

                    {summaryData?.hrZoneMinutes && summaryData.hrZoneMinutes.some(m => m > 0) ? (
                      <View style={{ marginTop: 4, marginBottom: 6, paddingHorizontal: 2 }}>
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
                          const colors = ['#22C55E', '#EAB308', themeColors.primary, '#F97316', '#EF4444'];
                          return (
                            <View style={{ flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: themeColors.border, marginBottom: 6 }}>
                              {zones.map((m, i) => {
                                if (m <= 0) return null;
                                const flex = m / total;
                                return <View key={i} style={{ flex, backgroundColor: colors[i] }} />;
                              })}
                            </View>
                          );
                        })()}
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                          {(['Z1', 'Z2', 'Z3', 'Z4', 'Z5'] as const).map((label, i) => {
                            const min = summaryData.hrZoneMinutes![i];
                            const zoneColor = ['#22C55E', '#EAB308', themeColors.primary, '#F97316', '#EF4444'][i];
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
                    {(summaryData?.achievements?.length ?? 0) > 0 && (
                      <View style={styles.shareAchievements}>
                        <Text style={styles.shareAchievementsTitle}>Best Sets</Text>
                        {summaryData!.achievements.slice(0, 4).map((a, i) => (
                          <View key={i} style={styles.shareAchievementRow}>
                            <Text style={styles.shareAchievementBullet}><Ionicons name="chevron-forward" size={12} /></Text>
                            <Text style={styles.shareAchievementText}>{a}</Text>
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
                        <Text style={[styles.summarySectionTitle, { marginTop: 10 }]}>💬  Note</Text>
                        <Text style={styles.summaryItem}>{cleanAiText(summaryData.motivation)}</Text>
                      </>
                    ) : null}
                  </View>
                ) : !summaryLoading && (summaryData?.recommendations?.length ?? 0) > 0 ? (
                  <View style={styles.summarySection}>
                    <Text style={styles.summarySectionTitle}>🔄  Recovery Tips</Text>
                    {summaryData!.recommendations.map((r, i) => (
                      <Text key={i} style={styles.summaryItem}>• {cleanAiText(r)}</Text>
                    ))}
                  </View>
                ) : null}

                {/* Share image + Share-to-friends + Feedback buttons.
                    "Share" exports an image; "Friends" sends the
                    structured workout summary to the friends Activity
                    digest (no kcal/macros/weight ever — privacy boundary). */}
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <TouchableOpacity
                    style={[styles.summaryFeedbackBtn, { flex: 1, backgroundColor: themeColors.surfaceRaised, borderWidth: 1, borderColor: themeColors.border }]}
                    onPress={handleShareSummary}
                    disabled={shareLoading || summaryLoading}
                    activeOpacity={0.85}>
                    <Text style={[styles.summaryFeedbackBtnText, { color: themeColors.textPrimary }]}>
                      {shareLoading ? 'Saving…' : '📤 Share'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.summaryFeedbackBtn, { flex: 1, backgroundColor: themeColors.surfaceRaised, borderWidth: 1, borderColor: themeColors.border }]}
                    onPress={handlePostToFriendsFeed}
                    disabled={postingToFeed || summaryLoading}
                    activeOpacity={0.85}>
                    <Text style={[styles.summaryFeedbackBtnText, { color: themeColors.textPrimary }]}>
                      {postingToFeed ? 'Sharing…' : '👥 Friends'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.summaryFeedbackBtn, { flex: 2 }]}
                    onPress={() => setSummaryStep('feedback')}
                    activeOpacity={0.85}>
                    <Text style={styles.summaryFeedbackBtnText}>How Did It Feel?  <Ionicons name="arrow-forward" size={14} /></Text>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity onPress={() => handleSubmitFeedback(true)} style={styles.summarySkipBtn}>
                  <Text style={styles.summarySkipText}>Skip & Close</Text>
                </TouchableOpacity>
              </View>

            ) : (
              /* ── Step 2: Feedback Form ───────────────────────────────────────── */
              <View style={styles.summaryModal}>
                {feedbackSubmitting ? (
                  /* Submitting / result state */
                  <View style={styles.feedbackSubmittingBlock}>
                    {feedbackResult ? (
                      <>
                        <Ionicons name="checkmark-circle" size={24} color={themeColors.success ?? '#22C55E'} />
                        <Text style={styles.feedbackResultTitle}>Plan Updated</Text>
                        <Text style={styles.feedbackResultText}>{feedbackResult}</Text>
                      </>
                    ) : (
                      <>
                        <ActivityIndicator size="large" color={themeColors.primary} />
                        <Text style={styles.feedbackSubmittingText}>Updating your plan based on feedback…</Text>
                      </>
                    )}
                  </View>
                ) : (
                  <>
                    <View style={styles.summaryHeaderBlock}>
                      <Text style={styles.summaryTitle}>How Did It Go?</Text>
                      <Text style={styles.summarySubtitle}>Your answer helps the AI trainer tune upcoming workouts</Text>
                    </View>

                    {/* Overall feeling */}
                    <View style={styles.feedbackGroup}>
                      <Text style={styles.feedbackGroupLabel}>Overall feeling</Text>
                      <View style={styles.fbFormRow}>
                        {([
                          { value: 'rough', label: 'Rough' },
                          { value: 'okay',  label: 'Okay' },
                          { value: 'good',  label: 'Good' },
                          { value: 'great', label: 'Great' },
                        ] as const).map(opt => (
                          <TouchableOpacity
                            key={opt.value}
                            style={[styles.fbFormChip, feedbackFeeling === opt.value && styles.fbFormChipActive]}
                            onPress={() => setFeedbackFeeling(opt.value)}
                            activeOpacity={0.8}>
                            <Text style={[styles.fbFormChipText, feedbackFeeling === opt.value && styles.fbFormChipTextActive]}>
                              {opt.label}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>

                    {/* Perceived intensity */}
                    <View style={styles.feedbackGroup}>
                      <Text style={styles.feedbackGroupLabel}>Intensity</Text>
                      <View style={styles.fbFormRow}>
                        {([
                          { value: 1, label: 'Too Easy' },
                          { value: 2, label: 'Easy' },
                          { value: 3, label: 'Just Right' },
                          { value: 4, label: 'Hard' },
                          { value: 5, label: 'Too Hard' },
                        ] as const).map(opt => (
                          <TouchableOpacity
                            key={opt.value}
                            style={[styles.feedbackIntensityChip, feedbackIntensity === opt.value && styles.fbFormChipActive]}
                            onPress={() => setFeedbackIntensity(opt.value)}
                            activeOpacity={0.8}>
                            <Text style={[styles.fbFormChipText, feedbackIntensity === opt.value && styles.fbFormChipTextActive]}>
                              {opt.label}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>

                    {/* Soreness */}
                    <View style={styles.feedbackGroup}>
                      <Text style={styles.feedbackGroupLabel}>Any soreness? <Text style={styles.feedbackOptional}>(optional)</Text></Text>
                      <View style={styles.feedbackSorenessGrid}>
                        {['Chest', 'Back', 'Shoulders', 'Arms', 'Legs', 'Glutes', 'Core', 'Knees', 'Lower Back'].map(area => {
                          const active = feedbackSoreness.includes(area);
                          return (
                            <TouchableOpacity
                              key={area}
                              style={[styles.feedbackSorenessChip, active && styles.feedbackSorenessChipActive]}
                              onPress={() => setFeedbackSoreness(prev =>
                                active ? prev.filter(a => a !== area) : [...prev, area]
                              )}
                              activeOpacity={0.8}>
                              <Text style={[styles.feedbackSorenessText, active && styles.feedbackSorenessTextActive]}>{area}</Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </View>

                    {/* Notes */}
                    <View style={styles.feedbackGroup}>
                      <Text style={styles.feedbackGroupLabel}>Notes <Text style={styles.feedbackOptional}>(optional)</Text></Text>
                      <TextInput
                        value={feedbackNotes}
                        onChangeText={setFeedbackNotes}
                        placeholder="e.g. left shoulder felt tight, energy was low..."
                        placeholderTextColor={themeColors.textMuted}
                        style={styles.feedbackNotesInput}
                        multiline
                        numberOfLines={3}
                      />
                    </View>

                    {/* Submit */}
                    <TouchableOpacity
                      style={[styles.summaryFeedbackBtn, (!feedbackFeeling && !feedbackIntensity) && { opacity: 0.5 }]}
                      onPress={() => handleSubmitFeedback(false)}
                      disabled={!feedbackFeeling && !feedbackIntensity || feedbackSubmitting}
                      activeOpacity={0.85}>
                      <Text style={styles.summaryFeedbackBtnText}>
                        {feedbackSubmitting ? 'Submitting…' : 'Submit & Let AI Adjust Plan'}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => handleSubmitFeedback(true)} style={styles.summarySkipBtn}>
                      <Text style={styles.summarySkipText}>Skip</Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            )}

            {/* ── Step 3: Confirmation ────────────────────────────────────────
                Stays on screen after the user taps Submit so they can
                actually read the result. Previously the modal auto-
                closed in the `finally` block of handleSubmitFeedback,
                which made the feedback feel like it went nowhere. */}
            {summaryStep === 'confirmation' && (
              <View style={styles.summaryFeedback}>
                <Text style={[styles.summaryFeedbackTitle, { textAlign: 'center' }]}>Feedback received</Text>
                <Text style={{ fontSize: 14, color: themeColors.textSecondary, lineHeight: 21, marginTop: 10, marginBottom: 18, textAlign: 'center' }}>
                  {feedbackResult || 'Your feedback has been saved.'}
                </Text>
                <View style={{ gap: 6, marginBottom: 24 }}>
                  {feedbackFeeling && (
                    <Text style={{ fontSize: 12, color: themeColors.textMuted, textAlign: 'center' }}>
                      Feeling: <Text style={{ color: themeColors.textPrimary, fontWeight: '700' }}>{feedbackFeeling}</Text>
                    </Text>
                  )}
                  {feedbackIntensity && (
                    <Text style={{ fontSize: 12, color: themeColors.textMuted, textAlign: 'center' }}>
                      Intensity: <Text style={{ color: themeColors.textPrimary, fontWeight: '700' }}>{feedbackIntensity}/5</Text>
                    </Text>
                  )}
                  {feedbackSoreness.length > 0 && (
                    <Text style={{ fontSize: 12, color: themeColors.textMuted, textAlign: 'center' }}>
                      Soreness: <Text style={{ color: themeColors.textPrimary, fontWeight: '700' }}>{feedbackSoreness.join(', ')}</Text>
                    </Text>
                  )}
                </View>
                <View style={{ gap: 10 }}>
                  <TouchableOpacity
                    style={styles.summaryFeedbackBtn}
                    onPress={dismissSummaryModal}
                    activeOpacity={0.85}>
                    <Text style={styles.summaryFeedbackBtnText}>Done</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

          </ScrollView>
        </View>
      </Modal>

      {/* ShareWorkoutModal removed — will re-enable with social feed */}

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
                    <Text style={styles.coachBubbleText}>{m.content}</Text>
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
              <Text style={{ color: themeColors.textSecondary, fontSize: 13, fontWeight: '600' }}>Weight (lbs)</Text>
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
                Ranked by overlap. Logged sets carry over.
              </Text>
            )}

            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <SearchInput
                containerStyle={{ flex: 1 }}
                value={exerciseSearch}
                onChangeText={(t) => { setExerciseSearch(t); if (!t) setAiExerciseResults([]); }}
                placeholder="Search by name, muscle, or equipment…"
                placeholderTextColor={themeColors.textMuted}
                style={styles.addExerciseSearch}
                returnKeyType="search"
                onSubmitEditing={handleAiExerciseSearch}
              />
              {exerciseSearch.trim().length > 1 && (
                <TouchableOpacity
                  style={{ backgroundColor: workoutPalette.strong, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, opacity: aiExerciseLoading ? 0.6 : 1 }}
                  onPress={handleAiExerciseSearch}
                  disabled={aiExerciseLoading}>
                  {aiExerciseLoading
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>Find</Text>}
                </TouchableOpacity>
              )}
            </View>

            {exerciseLibraryLoading ? (
              <ActivityIndicator size="small" color={themeColors.primary} style={{ marginTop: 12 }} />
            ) : (
              <ScrollView contentContainerStyle={styles.addExerciseList} keyboardShouldPersistTaps="handled">
                {/* AI results section — structured exercise suggestions from
                    the LLM. Each has Add (→ workout) and Save (→ library). */}
                {aiExerciseResults.length > 0 && (
                  <View style={{ marginBottom: 14 }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Suggestions</Text>
                    {aiExerciseResults.map((ex, i) => (
                      <View key={`ai-${ex.name}-${i}`} style={[styles.addExerciseItem, { flexDirection: 'column', alignItems: 'stretch', borderColor: workoutPalette.strong + '66', borderWidth: 1.5 }]}>
                        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                          {/* AI-suggested exercises come from a live
                              search — we don't render wger static images
                              for them to stay consistent with the rest
                              of the app (YouTube-thumb or placeholder). */}
                          <View style={{ flex: 1 }}>
                            <Text style={styles.addExerciseName}>{ex.name}</Text>
                            <Text style={styles.addExerciseMeta}>
                              {humanizeToken(ex.primary_muscle)} · {formatEquipmentLabel(ex.equipment)} · {ex.sets}×{ex.reps}
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
                            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>Add</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={{ flex: 1, backgroundColor: themeColors.surfaceRaised, borderWidth: 1, borderColor: themeColors.border, paddingVertical: 10, borderRadius: 8, alignItems: 'center' }}
                            onPress={() => handleSaveAiExerciseToLibrary(ex)}>
                            <Text style={{ color: themeColors.textPrimary, fontWeight: '700', fontSize: 13 }}>Save to library</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    ))}
                  </View>
                )}

                {filteredExerciseLibrary.length === 0 ? (
                  <>
                    <Text style={styles.coachEmpty}>Nothing in your library matches.</Text>
                    {exerciseSearch.trim().length > 1 && aiExerciseResults.length === 0 && !aiExerciseLoading && (
                      <TouchableOpacity
                        style={{ marginTop: 10, alignSelf: 'center', paddingVertical: 12, paddingHorizontal: 18, backgroundColor: themeColors.surfaceRaised, borderWidth: 1, borderColor: workoutPalette.strong + '55', borderRadius: 10 }}
                        onPress={handleAiExerciseSearch}>
                        <Text style={{ color: workoutPalette.strong, fontWeight: '700', fontSize: 13 }}>Search beyond your library →</Text>
                      </TouchableOpacity>
                    )}
                  </>
                ) : filteredExerciseLibrary.map((item) => {
                  const overlap = (item as any)._overlap as number | undefined;
                  // Green ≥80, amber 60-79, red <60 — matches the readiness
                  // chip convention on Switch Day picker.
                  const overlapColor = overlap == null ? undefined
                    : overlap >= 80 ? '#22C55E'
                    : overlap >= 60 ? '#F59E0B'
                    : '#EF4444';
                  return (
                    <TouchableOpacity key={String(item.id ?? item.name)} style={styles.addExerciseItem} onPress={() => handleAddExercise(item)}>
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <Text style={styles.addExerciseName}>{item.name}</Text>
                          {overlap != null && overlapColor && (
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: overlapColor + '22', borderWidth: 1, borderColor: overlapColor + '88' }}>
                              <View style={{ width: 28, height: 4, borderRadius: 2, backgroundColor: overlapColor + '33', overflow: 'hidden' }}>
                                <View style={{ width: `${overlap}%`, height: '100%', backgroundColor: overlapColor }} />
                              </View>
                              <Text style={{ fontSize: 10, fontWeight: '800', color: overlapColor }}>{overlap}%</Text>
                            </View>
                          )}
                        </View>
                        <Text style={styles.addExerciseMeta}>
                          {humanizeToken(item.primary_muscle) || 'General'} · {formatEquipmentLabel(item.equipment) || 'Bodyweight'}
                          {item.is_compound != null ? (item.is_compound ? ' · Compound' : ' · Isolation') : ''}
                        </Text>
                      </View>
                      <Text style={styles.addExerciseUse}>{swapTargetIdx != null ? 'Swap' : 'Add'}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <FormVideoModal
        visible={!!formVideoExerciseName}
        exerciseName={formVideoExerciseName ?? ''}
        authToken={authToken}
        themeName={themeName}
        onClose={() => setFormVideoExerciseName(null)}
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

      {showStartCountdown && (
        <StartCountdownOverlay
          themeName={themeName}
          onComplete={() => setShowStartCountdown(false)}
        />
      )}

      <WorkoutTimerModal
        visible={timerModalVisible}
        mode={timerMode}
        themeName={themeName}
        exerciseName={exercises[timerExerciseIdx]?.name}
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

      {/* Open-on-watch nudge. iOS can't auto-launch the watch app from
          the phone, so when a user starts a workout on the phone and
          the watch app is closed, tell them to open Thallo on their
          wrist to mirror the session. Auto-dismisses the moment the
          watch reports reachable (reachability listener flips it). */}
      <Modal
        visible={showOpenWatchPrompt}
        transparent
        animationType="fade"
        onRequestClose={() => setShowOpenWatchPrompt(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <View style={{
            backgroundColor: themeColors.surface,
            borderRadius: 18,
            padding: 20,
            width: '100%',
            maxWidth: 340,
            borderWidth: 1, borderColor: themeColors.border,
            alignItems: 'center',
          }}>
            <View style={{
              width: 54, height: 54, borderRadius: 27,
              backgroundColor: themeColors.primary + '22',
              alignItems: 'center', justifyContent: 'center',
              marginBottom: 12,
            }}>
              <Ionicons name="watch-outline" size={28} color={themeColors.primary} />
            </View>
            <Text style={{ fontSize: 16, fontWeight: '800', color: themeColors.textPrimary, textAlign: 'center' }}>
              Open Thallo on your watch
            </Text>
            <Text style={{ fontSize: 12, color: themeColors.textSecondary, textAlign: 'center', marginTop: 8, lineHeight: 17 }}>
              Launch the Thallo app on your Apple Watch and tap Start — your phone workout and watch will stay in sync from there.
            </Text>
            <TouchableOpacity
              onPress={() => setShowOpenWatchPrompt(false)}
              style={{
                marginTop: 16,
                paddingVertical: 12, paddingHorizontal: 28,
                borderRadius: 12,
                backgroundColor: themeColors.primary,
              }}>
              <Text style={{ fontSize: 14, fontWeight: '800', color: themeColors.background }}>
                Got it
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
  container: { flex: 1, backgroundColor: tc.background },

  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 56, paddingBottom: 12, gap: 12 },
  focusLabel:   { fontSize: 18, fontWeight: '700', color: tc.textPrimary, marginBottom: 2 },
  timer:        { fontSize: 32, fontWeight: '800', color: tc.primary },
  headerRight:  { alignItems: 'center' },
  progressText: { fontSize: 22, fontWeight: '700', color: tc.textPrimary },
  progressSub:  { fontSize: 11, color: tc.textSecondary },
  cancelBtn:    { padding: 8, backgroundColor: tc.surface, borderRadius: radius.full, borderWidth: 1, borderColor: tc.border },
  cancelBtnText:{ fontSize: 14, color: tc.textSecondary, fontWeight: '600' },
  coachBtn: { paddingHorizontal: 10, paddingVertical: 8, backgroundColor: tc.surface, borderRadius: radius.md, borderWidth: 1, borderColor: tc.primary },
  coachBtnText: { fontSize: 12, color: tc.primary, fontWeight: '700' },

  // marginTop adds breathing room from the collapsed warmup pill
  // above so the progress bar doesn't look like a hairline glued to
  // the bottom of the pill ("weird line under the circle" bug).
  progressBarTrack: { height: 3, backgroundColor: tc.border, marginHorizontal: 16, borderRadius: 2, marginTop: 12, marginBottom: 16 },
  progressBarFill:  { height: 3, backgroundColor: tc.primary, borderRadius: 2 },

  restBanner: {
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: tc.primary + '18',
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: tc.primary,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  restBannerUrgent: { borderColor: tc.warning, backgroundColor: tc.warning + '18' },
  restBannerLeft: { alignItems: 'center', justifyContent: 'center', minWidth: 96 },
  restBannerLabel: { fontSize: 9, fontWeight: '800', color: tc.primary, textTransform: 'uppercase', letterSpacing: 1 },
  restBannerTime: { fontSize: 32, fontWeight: '900', color: tc.primary, lineHeight: 36 },
  restBannerTimeUrgent: { color: tc.warning },
  restBannerCenter: { flex: 1, gap: 2, minWidth: 0 },
  restExerciseText: { fontSize: 11, color: tc.primary, fontWeight: '700' },
  restTargetText: { fontSize: 13, color: tc.textPrimary, fontWeight: '700' },
  restCueText: { fontSize: 11, color: tc.textSecondary, lineHeight: 16 },
  restBannerActions: { flexDirection: 'column', gap: 5, alignItems: 'stretch' },
  restBannerBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: tc.border,
    backgroundColor: tc.surface,
    alignItems: 'center',
  },
  restBannerBtnText: { fontSize: 11, color: tc.textPrimary, fontWeight: '700' },
  restBannerBtnPrimary: { borderColor: tc.primary, backgroundColor: tc.primary },
  restBannerBtnPrimaryText: { fontSize: 11, color: tc.background, fontWeight: '700' },

  scroll:        { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40 },

  exerciseCard:       { backgroundColor: tc.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: tc.border, padding: 14, marginBottom: 10 },
  exerciseCardDone:   { borderColor: tc.primary, opacity: 0.85 },
  exerciseCardActive: { borderColor: tc.primary },

  exerciseHeader:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  exerciseName:     { fontSize: 15, fontWeight: '600', color: tc.textPrimary, marginBottom: 2 },
  exerciseNameDone: { color: tc.textSecondary, textDecorationLine: 'line-through' },
  exerciseMeta:     { fontSize: 12, color: tc.textMuted },

  setsBadge:        { backgroundColor: tc.surfaceRaised, borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: tc.border },
  setsBadgeDone:    { backgroundColor: tc.primary, borderColor: tc.primary },
  setsBadgeText:    { fontSize: 12, fontWeight: '700', color: tc.textSecondary },
  setsBadgeTextDone:{ color: tc.background },

  // Small red remove button in the header
  removeBtn: {
    width: 26, height: 26,
    borderRadius: 13,
    backgroundColor: tc.error + '18',
    borderWidth: 1,
    borderColor: tc.error,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeBtnText: { fontSize: 18, color: tc.error, fontWeight: '800', lineHeight: 22 },

  exerciseDetail: { marginTop: 12, gap: 10 },

  // Add Exercise button — below all cards
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
    backgroundColor: tc.primary + '20', alignItems: 'center',
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
  feedbackCard: {
    flexDirection: 'column',
    gap: 6,
  },
  feedbackTitle: { fontSize: 11, fontWeight: '600', color: tc.textMuted },
  feedbackRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  feedbackChip: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: tc.border,
    backgroundColor: tc.surface,
  },
  feedbackChipActive:     { borderColor: tc.primary, backgroundColor: tc.primary + '20' },
  feedbackChipPain:       { borderColor: tc.error + '80' },
  feedbackChipPainActive: { borderColor: tc.error, backgroundColor: tc.error + '20' },
  feedbackChipText:       { fontSize: 12, fontWeight: '600', color: tc.textSecondary },
  feedbackChipTextActive: { color: tc.primary },
  feedbackChipTextPain:   { color: tc.error },

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

  finishBtn:         { backgroundColor: tc.surface, borderRadius: radius.md, paddingVertical: 16, alignItems: 'center', marginTop: 8, borderWidth: 1, borderColor: tc.primary },
  finishBtnDisabled: { borderColor: tc.border, opacity: 0.5 },
  finishBtnText:     { fontSize: 16, fontWeight: '700', color: tc.primary },

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
  finishModal:       { backgroundColor: tc.surface, borderRadius: radius.xl, padding: 28, alignItems: 'center', gap: 12, borderWidth: 1, borderColor: tc.border, width: '85%' },
  finishModalTitle:  { fontSize: 26, fontWeight: '800', color: tc.textPrimary },
  finishModalBody:   { fontSize: 14, color: tc.textSecondary, textAlign: 'center' },
  finishConfirmBtn:  { backgroundColor: tc.primary, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', width: '100%', marginTop: 8 },
  finishConfirmText: { color: tc.background, fontSize: 16, fontWeight: '700' },
  finishCancelText:  { fontSize: 14, color: tc.textMuted, marginTop: 4 },

  summaryScroll: { flexGrow: 1, justifyContent: 'flex-end' },
  summaryModal: {
    backgroundColor: tc.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: 24,
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
  shareCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
    backgroundColor: tc.primary + '12',
    borderBottomWidth: 1,
    borderBottomColor: tc.border,
  },
  shareCardLogo: { width: 220, height: 50 },
  shareCardDateBadge: {
    backgroundColor: tc.surfaceRaised,
    borderRadius: radius.full,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: tc.border,
  },
  shareCardDateText: { fontSize: 11, fontWeight: '600', color: tc.textSecondary },
  shareCardFocus: {
    fontSize: 20,
    fontWeight: '800',
    color: tc.textPrimary,
    textAlign: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 4,
  },
  shareStatsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 6,
  },
  // Tighter stat tile — 3-up packing instead of 2-up so the summary
  // doesn't push the training-score panel below the fold.
  shareStatTile: {
    flex: 1,
    minWidth: '30%' as any,
    backgroundColor: tc.surfaceRaised,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: tc.border,
    paddingVertical: 7,
    paddingHorizontal: 6,
    alignItems: 'center',
    gap: 0,
  },
  shareStatIcon:  { fontSize: 13, marginBottom: 1 },
  shareStatValue: { fontSize: 16, fontWeight: '800', color: tc.textPrimary, lineHeight: 20 },
  shareStatLabel: { fontSize: 9, fontWeight: '700', color: tc.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 },
  shareAchievements: {
    marginHorizontal: 14,
    marginBottom: 6,
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
  addExerciseName: { fontSize: 13, fontWeight: '700', color: tc.textPrimary, marginBottom: 2 },
  addExerciseMeta: { fontSize: 12, color: tc.textSecondary },
  addExerciseUse: { fontSize: 12, color: tc.primary, fontWeight: '700' },
}); }
