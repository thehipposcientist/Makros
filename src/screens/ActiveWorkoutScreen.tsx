import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  TextInput, Modal, ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Vibration, Linking, Image, Keyboard,
  LayoutAnimation, UIManager,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import FadeInView from '../components/FadeInView';
import PressableScale from '../components/PressableScale';
import AnimatedNumber from '../components/AnimatedNumber';

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
import { isHealthKitAvailable, readHealthSummary } from '../services/appleHealth';
import { calculateHealthScore } from '../utils/healthScore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getWeightRecommendation, logWorkoutDone, logWorkoutStarted, askWorkoutQuestion, analyzeWorkoutFormPhoto, getExercises, getWorkoutSummary, askTrainerQuestion, searchExerciseAI, AIExerciseResult, getAiWarmup, getPreSetRecommendation } from '../services/api';
import { cleanAiText } from '../utils/aiText';
import { getTheme, radius } from '../constants/theme';
import * as Notifications from 'expo-notifications';
import SearchInput from '../components/SearchInput';
import { cancelRestNotifications, scheduleRestNotifications, configureWorkoutNotifications, ensureWorkoutNotificationPermission } from '../utils/restNotifications';
import { humanizeToken } from '../utils/exerciseGuide';

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
  primary_muscle?: string;
}

interface ActiveWorkoutScreenProps {
  authToken: string;
  workout: WorkoutDay;
  goal: string;
  themeName?: AppThemeName;
  weightLbs?: number;
  onFinish: (session: WorkoutSession) => void;
  onCancel: () => void;
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

const TIMED_EXERCISE_RE = /treadmill|stationary bike|elliptical|rowing machine|stair climber|assault bike|battle ropes|jump rope|sprint|jogging|running|cycling|swimming|hiit|intervals|mountain climber|hill sprint|cardio|plank|dead hang|wall sit|hollow.?hold|l.?sit|farmer.?walk|carry/i;
const TIMED_REPS_RE = /^\d+\s*-?\s*\d*\s*s(ec|econds?)?$/i;

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
function isLongCardioExercise(name: string, targetReps?: string | number): boolean {
  const lowered = (name || '').toLowerCase();
  if (/treadmill|stationary bike|elliptical|rowing machine|stair climber|assault bike|jogging|running|cycling|swimming|zone ?2|tempo|steady state|long run/.test(lowered)) {
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

function getExerciseWarmupNote(exerciseName: string, isFirst: boolean): string | null {
  const name = exerciseName.toLowerCase();
  const isCompound = /squat|deadlift|bench press|overhead press|ohp|barbell press|pull.up|row|lunge|hip thrust|clean|snatch/.test(name);
  if (!isCompound && !isFirst) return null;
  if (/squat/.test(name)) return 'Warm-up: 2–3 ramp-up sets — e.g. bar × 10, 50% × 8, 70% × 5 before working weight';
  if (/deadlift/.test(name)) return 'Warm-up: 2–3 light singles — e.g. 40% × 5, 60% × 3, 80% × 1 before working sets';
  if (/bench/.test(name)) return 'Warm-up: 2–3 ramp-up sets — e.g. bar × 15, 50% × 8, 70% × 5 before working weight';
  if (/overhead press|ohp/.test(name)) return 'Warm-up: 2 ramp-up sets — e.g. bar × 10, 60% × 6 before working weight';
  if (isFirst) return 'Warm-up: 1–2 lighter sets recommended before starting working weight';
  return null;
}

function buildWarmupPlan(workout: WorkoutDay): string[] {
  const focus = (workout.focus || '').toLowerCase();
  const firstEx = workout.exercises[0]?.name;

  if (/leg|lower|glute|hinge/.test(focus)) {
    return [
      '3 min easy bike or walk',
      'Hip circles + ankle rocks (10 each)',
      'Bodyweight squats × 10',
      firstEx ? `2 light sets of ${firstEx}` : '2 ramp-up sets at 50%',
    ];
  }
  if (/pull|back/.test(focus)) {
    return [
      '3 min light cardio',
      'Band pull-aparts × 15',
      'Scap push-ups × 10',
      firstEx ? `2 light sets of ${firstEx}` : '2 ramp-up sets at 50%',
    ];
  }
  if (/push|chest|shoulder|upper/.test(focus)) {
    return [
      '3 min light cardio',
      'Arm circles + band dislocates × 10',
      'Push-ups × 10',
      firstEx ? `2 light sets of ${firstEx}` : '2 ramp-up sets at 50%',
    ];
  }
  return [
    '3 min light cardio',
    'Dynamic stretches for major joints',
    firstEx ? `2 light sets of ${firstEx}` : '2 ramp-up sets at 50%',
  ];
}

const SHARE_LOGO_LIGHT = require('../../assets/images/thallo-logo-black.png');
const SHARE_LOGO_DARK  = require('../../assets/images/thallo-logo-white.png');

export default function ActiveWorkoutScreen({ authToken, workout, goal, themeName, weightLbs = 150, onFinish, onCancel }: ActiveWorkoutScreenProps) {
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
  const restNotificationIds = useRef<{ startId?: string; warningId?: string; completeId?: string } | null>(null);
  const restDurationSeconds = useRef<number>(0);
  // Ref-based rest timer — avoids interval churn from re-running useEffect every second
  const restTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const restStartAtRef = useRef<number>(0);
  const restTotalSecondsRef = useRef<number>(0);
  const restExerciseNameRef = useRef<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

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
    }));
  });
  const setExercises = useCallback((updater: SessionExercise[] | ((prev: SessionExercise[]) => SessionExercise[])) => {
    setExercisesRaw(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      // Auto-save session state so it survives app backgrounding/kill
      AsyncStorage.setItem('activeWorkoutSets', JSON.stringify(
        next.map(ex => ({ name: ex.name, sets: ex.sets }))
      )).catch(() => {});
      return next;
    });
  }, []);

  // Restore logged sets from a previous interrupted session
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
      } catch {}
    }).catch(() => {});
    return () => { AsyncStorage.removeItem('activeWorkoutSets').catch(() => {}); };
  }, []);

  const [activeExIdx, setActiveExIdx] = useState<number>(0);

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

  // Workout summary after finish
  const [summaryVisible, setSummaryVisible] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryData, setSummaryData] = useState<WorkoutSummary | null>(null);
  const [finishedSession, setFinishedSession] = useState<WorkoutSession | null>(null);

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

  const [finishModalVisible, setFinishModalVisible] = useState(false);
  const [coachModalVisible, setCoachModalVisible] = useState(false);
  const [coachInput, setCoachInput] = useState('');
  const [coachLoading, setCoachLoading] = useState(false);
  const [coachPhotoLoading, setCoachPhotoLoading] = useState(false);
  const [coachChat, setCoachChat] = useState<WorkoutCoachMessage[]>([]);
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
    };
  }, []);

  // Preload last-session data and pre-populate inline set inputs from history
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

      // Pre-populate inputs from last session for each exercise slot
      const inputs: Record<string, { weight: string; reps: string; duration: string }> = {};
      workout.exercises.forEach((ex, exIdx) => {
        const lastSets = map[ex.name] ?? [];
        for (let slot = 0; slot < ex.sets; slot++) {
          const last = lastSets[slot] ?? lastSets[lastSets.length - 1];
          if (last) {
            if (isTimedExercise(ex.name, ex.reps) && last.durationSeconds != null) {
              inputs[`${exIdx}-${slot}`] = { weight: '', reps: '', duration: formatDurationForInput(last.durationSeconds) };
            } else {
              inputs[`${exIdx}-${slot}`] = { weight: String(last.weightLbs), reps: String(last.reps), duration: '' };
            }
          }
        }
      });
      setSetInputs(inputs);
    });
  }, []);

  // Pre-fill from history when modal opens
  const openLogModal = useCallback(async (exIdx: number) => {
    setLogExIdx(exIdx);
    setLogWeight('');
    setLogReps('');
    setLogModalVisible(true);

    const lastSets = await getLastSetsForExercise(exercises[exIdx].name);
    if (lastSets && lastSets.length > 0) {
      const last = lastSets[lastSets.length - 1];
      setLogWeight(String(last.weightLbs));
      setLogReps(String(last.reps));
    }
  }, [exercises]);

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
              incrementLbs: 5,
              allTimeBestWeightLbs: bests?.allTime?.weightLbs,
              allTimeBestReps: bests?.allTime?.reps,
              lastSessionBestWeightLbs: bests?.lastSession?.weightLbs,
              lastSessionBestReps: bests?.lastSession?.reps,
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

  // Log a specific set slot inline (no modal)
  const handleLogSetInline = useCallback(async (exIdx: number, setSlot: number, silent = false) => {
    const key = `${exIdx}-${setSlot}`;
    const input = setInputs[key];
    const ex = exercises[exIdx];
    const timed = isTimedExercise(ex?.name ?? '', ex?.targetReps);

    let newSet: CompletedSet;

    if (timed) {
      const durText = input?.duration?.trim() ?? '';
      if (!durText) {
        if (!silent) Alert.alert('Enter duration', 'Fill in the duration before logging this set.');
        return;
      }
      // Plain numbers default to minutes for long cardio (treadmill,
      // bike, etc.) and seconds for short holds (plank, dead hang).
      const preferMinutes = isLongCardioExercise(ex?.name ?? '', ex?.targetReps);
      const durationSeconds = parseDurationInput(durText, preferMinutes);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        if (!silent) Alert.alert('Enter duration', 'Enter a valid duration like "25:00", "25 min", or "45s".');
        return;
      }
      newSet = { setNumber: setSlot + 1, reps: 0, weightLbs: 0, durationSeconds };
    } else {
      const weightNum = parseFloat(input?.weight ?? '');
      const repsNum   = parseInt(input?.reps ?? '', 10);
      if (!input?.weight || !input?.reps || isNaN(weightNum) || isNaN(repsNum) || repsNum <= 0) {
        if (!silent) Alert.alert('Enter values', 'Fill in weight and reps before logging this set.');
        return;
      }
      newSet = { setNumber: setSlot + 1, reps: repsNum, weightLbs: weightNum };
    }

    // Haptic feedback on set log
    import('../utils/feedback').then(f => f.hapticMedium()).catch(() => {});

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

    // Mark workout as started in the backend DB on first logged set.
    // This ensures getWorkoutStatus returns done=true immediately,
    // even if the user never taps Finish (app crash, phone dies).
    if (!workoutStartedRef.current && authToken) {
      workoutStartedRef.current = true;
      logWorkoutStarted(authToken, dateKey(new Date()), workout.focus, workout.stimulus).catch(() => {});
    }

    // Auto-advance to next incomplete exercise when all effective sets are done
    if (cleanSets.length >= effectiveTotal) {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      const nextIdx = updatedExercises.findIndex((e, i) => i > exIdx && e.sets.length < getTargetSetCount(e.targetSets));
      setActiveExIdx(nextIdx >= 0 ? nextIdx : -1);
      import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
    } else {
      setActiveExIdx(exIdx);
    }

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
          incrementLbs: 5,
          allTimeBestWeightLbs: bests?.allTime?.weightLbs,
          allTimeBestReps: bests?.allTime?.reps,
          lastSessionBestWeightLbs: bests?.lastSession?.weightLbs,
          lastSessionBestReps: bests?.lastSession?.reps,
        });
        const tip = `Set ${setsLogged + 1}: try ${rec.weightLbs} lbs x ${rec.reps} reps — ${rec.tip}`;
        setRestNextTarget(`Set ${setsLogged + 1}: ${rec.weightLbs} lbs x ${rec.reps}`);
        setRestCue(rec.tip);
        setExercises(prev => prev.map((e, i) => i === exIdx ? { ...e, aiRecommendation: tip } : e));
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
      setExerciseLibrary([...customs, ...rows]);
    } catch {
      setExerciseLibrary([]);
    } finally {
      setExerciseLibraryLoading(false);
    }
  }, [exerciseLibrary.length]);

  const handleAddExercise = useCallback((item: ExerciseLibraryItem) => {
    const nextExercise: SessionExercise = {
      name: item.name,
      targetSets: 3,
      targetReps: '10',
      targetRestSeconds: 60,
      equipment: item.equipment ? String(item.equipment) : 'bodyweight',
      sets: [],
      aiRecommendation: undefined,
    };
    setExercises(prev => {
      const updated = [...prev, nextExercise];
      setActiveExIdx(updated.length - 1);
      return updated;
    });
    setAddExerciseModalVisible(false);
    setExerciseSearch('');
    setAiExerciseResults([]);
  }, []);

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
      secondary_muscles: [] as any,
      equipment: ex.equipment as any,
      description: ex.why,
      is_custom: true,
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
          equipment: ex.equipment,
          sets: ex.sets,
          reps: ex.reps,
          rest_seconds: ex.rest_seconds,
          description: ex.why,
          form_cues: ex.form_cues,
          source: 'ai',
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

    restTimerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - restStartAtRef.current) / 1000);
      const remaining = Math.max(0, restTotalSecondsRef.current - elapsed);
      setRestRemaining(remaining);

      if (remaining === 0) {
        if (restTimerRef.current) clearInterval(restTimerRef.current);
        restTimerRef.current = null;
        import('../utils/feedback').then(f => {
          f.vibrateRestDone();
          f.hapticHeavy();
        }).catch(() => Vibration.vibrate([0, 300, 150, 300, 150, 300]));
        cancelRestNotifications(restNotificationIds.current).catch(() => undefined);
        restNotificationIds.current = null;
        // Fire an immediate notification so the system plays its alert sound
        Notifications.scheduleNotificationAsync({
          content: {
            title: 'Rest Complete — Go!',
            body: `${restExerciseNameRef.current ?? 'Next exercise'} — start your next set`,
            sound: 'default',
          },
          trigger: null,
        }).catch(() => undefined);
      }
    }, 500); // 500ms tick for smooth countdown without drift
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
    cancelRestNotifications(restNotificationIds.current).catch(() => undefined);
    restNotificationIds.current = null;
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

  const adjustActiveRestRemaining = useCallback(async (delta: number) => {
    if (restRemaining <= 0 || !restForExercise) return;
    const nextRemaining = Math.max(0, restRemaining + delta);
    if (nextRemaining <= 0) {
      clearRestState();
      return;
    }
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
  }, [clearRestState, rescheduleRestNotifications, restCue, restForExercise, restNextTarget, restRemaining, startRestTimer]);

  const refreshRecommendationForExercise = useCallback(async (exIdx: number, setsForExercise: CompletedSet[]) => {
    const ex = exercises[exIdx];
    const targetSetCount = ex ? getTargetSetCount(ex.targetSets) : 3;
    if (!ex || setsForExercise.length >= targetSetCount || !authToken) return;
    if (isTimedExercise(ex.name, ex.targetReps)) return; // No AI weight tip for cardio/timed exercises

    setAiLoadingIdx(exIdx);
    try {
      const rec = await getWeightRecommendation(authToken, ex.name, goal, setsForExercise, setsForExercise.length + 1, {
        targetSets: ex.targetSets,
        targetReps: ex.targetReps,
        progressionPace: 'moderate',
        experienceLevel: 'intermediate',
        recoveryLevel: 'normal',
        phase: 'accumulation',
        workoutFocus: workout.focus,
        weekNumber: 1,
        incrementLbs: 5,
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
    setFeedbackSubmitting(true);
    try {
      // If the user is skipping outright, close immediately — no
      // confirmation step needed.
      if (skip) {
        setSummaryVisible(false);
        setSummaryStep('summary');
        if (finishedSession) onFinish(finishedSession);
        return;
      }

      if (authToken && (feedbackFeeling || feedbackIntensity)) {
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
        const feelingText = feedbackFeeling ? feelingLabels[feedbackFeeling] : 'neutral';
        const intensityText = feedbackIntensity ? intensityLabels[feedbackIntensity] : 'moderate';
        const sorenessText = feedbackSoreness.length > 0 ? ` Soreness noted in: ${feedbackSoreness.join(', ')}.` : '';
        const notesText = feedbackNotes.trim() ? ` User note: "${feedbackNotes.trim()}".` : '';

        const question = `I just finished ${workout.focus}. Overall feeling: ${feelingText}. Perceived intensity: ${intensityText}.${sorenessText}${notesText} Based on this feedback, should my upcoming workouts be adjusted? If the intensity was wrong or I had soreness concerns, please update the plan.`;

        try {
          const resp = await askTrainerQuestion(authToken, {
            question,
            mode: 'trainer',
            profile: { goal },
            conversation: [],
          });

          if (resp.needs_plan_update && resp.updated_workout_plan) {
            await AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(resp.updated_workout_plan));
            setFeedbackResult(resp.answer || 'Your upcoming workouts have been adjusted based on your feedback.');
          } else if (resp.answer) {
            setFeedbackResult(resp.answer);
          } else {
            setFeedbackResult('Feedback saved — your upcoming workouts will factor this in.');
          }
        } catch {
          setFeedbackResult('Feedback saved locally. (Coach sync will retry next time you open the app.)');
        }
      } else {
        setFeedbackResult('Feedback saved.');
      }

      // Persist feedback onto the saved session (raw history)
      if (finishedSession && feedbackFeeling && feedbackIntensity) {
        await saveWorkoutSession({
          ...finishedSession,
          feedback: {
            feeling: feedbackFeeling as WorkoutFeeling,
            intensity: feedbackIntensity as WorkoutIntensity,
            sorenessAreas: feedbackSoreness,
            notes: feedbackNotes,
          },
        });
      }

      // Also patch the StoredWorkoutSummary so the feedback shows up
      // on the Progress screen next to the AI summary + exercise
      // detail. Idempotent via upsert-by-id.
      if (finishedSession && feedbackFeeling && feedbackIntensity) {
        await updateWorkoutSummary(finishedSession.id, {
          feedback: {
            feeling: feedbackFeeling as WorkoutFeeling,
            intensity: feedbackIntensity as WorkoutIntensity,
            sorenessAreas: feedbackSoreness,
            notes: feedbackNotes.trim() || undefined,
          },
        });
      }

      // Move to confirmation step — modal stays open so the user can
      // actually read what happened. They dismiss manually via the
      // "Done" button on the confirmation view.
      setSummaryStep('confirmation');
    } catch {
      // Non-fatal — still show a confirmation so the modal doesn't
      // vanish out from under the user.
      setFeedbackResult('Feedback saved.');
      setSummaryStep('confirmation');
    } finally {
      setFeedbackSubmitting(false);
    }
  };

  /** Called by the confirmation step's Done button. Closes the modal
   *  and fires the finish callback to the parent navigator. */
  const dismissSummaryModal = () => {
    setSummaryVisible(false);
    setSummaryStep('summary');
    if (finishedSession) onFinish(finishedSession);
  };

  const handleFinish = async () => {
    import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
    AsyncStorage.removeItem('activeWorkoutSets').catch(() => {});
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
    try {
      if (authToken) {
        const exercisesPayload = session.exercises.map((ex, idx) => ({
          name: ex.name,
          target_sets: typeof ex.targetSets === 'number' ? ex.targetSets : null,
          target_reps: typeof ex.targetReps === 'string' ? ex.targetReps : null,
          equipment: typeof ex.equipment === 'string' ? ex.equipment : null,
          order_index: idx,
          sets: ex.sets.map((s, si) => ({
            set_number: s.setNumber ?? si + 1,
            reps: s.reps ?? 0,
            weight_lbs: s.weightLbs ?? 0,
            duration_seconds: s.durationSeconds ?? null,
            feedback: s.feedback ?? null,
            rir: null,
          })),
        }));
        await logWorkoutDone(authToken, dateKey(now), workout.focus, elapsed, exercisesPayload);
      }
    } catch {}

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
        const healthSummary = await readHealthSummary();
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
    if (!q) return;

    const userMsg: WorkoutCoachMessage = { role: 'user', content: q };
    setCoachChat(prev => [...prev, userMsg]);
    setCoachInput('');
    setCoachLoading(true);

    try {
      const active = exercises[activeExIdx];
      const resp = await askWorkoutQuestion(authToken, {
        question: q,
        workout,
        activeExerciseName: active?.name,
        currentSetNumber: (active?.sets?.length ?? 0) + 1,
        loggedSets: active?.sets ?? [],
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
  }, [coachInput, exercises, activeExIdx, authToken, workout]);

  const handleAnalyzeFormPhoto = useCallback(async (source: 'camera' | 'library') => {
    if (!authToken) {
      Alert.alert('Sign in required', 'You need to be signed in to analyze form photos.');
      return;
    }

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

  const filteredExerciseLibrary = exerciseLibrary.filter(item => {
    const q = exerciseSearch.trim().toLowerCase();
    if (!q) return true;
    return [item.name, item.primary_muscle ?? '', item.equipment ?? '']
      .join(' ')
      .toLowerCase()
      .includes(q);
  });

  return (
    <View style={[styles.container, { backgroundColor: themeColors.background }] }>

      {/* Header */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.focusLabel}>{workout.focus}</Text>
          <Text style={styles.timer}>{formatTime(elapsed)}</Text>
        </View>
        <View style={styles.headerRight}>
          <Text style={styles.progressText}>{completedCount}/{exercises.length}</Text>
          <Text style={styles.progressSub}>done</Text>
        </View>
        <TouchableOpacity style={styles.cancelBtn} onPress={() => Alert.alert(
          'Cancel Workout', 'Your progress will be lost.',
          [{ text: 'Keep Going', style: 'cancel' }, { text: 'Cancel', style: 'destructive', onPress: () => { clearRestState(); onCancel(); } }]
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

      {warmupDone && (
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
          {/* Left: big countdown */}
          <View style={styles.restBannerLeft}>
            <Text style={[styles.restBannerLabel, { color: workoutPalette.text }]}>REST</Text>
            <Text style={[styles.restBannerTime, { color: workoutPalette.text }, restRemaining <= 10 && styles.restBannerTimeUrgent]}>
              {formatTime(restRemaining)}
            </Text>
          </View>
          {/* Center: next set info + cue */}
          <View style={styles.restBannerCenter}>
            {restForExercise ? <Text style={styles.restExerciseText} numberOfLines={1}>{restForExercise}</Text> : null}
            {restNextTarget ? <Text style={styles.restTargetText} numberOfLines={1}>{restNextTarget}</Text> : null}
            {restCue ? <Text style={styles.restCueText} numberOfLines={2}>{restCue}</Text> : null}
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
        {warmupDone && exercises.map((ex, i) => {
          const targetSetCount  = getTargetSetCount(ex.targetSets);
          // Effective set count: base target + user-added extras, minus
          // any unlogged sets they've explicitly removed. Clamped so we
          // never go below the number of already-logged sets.
          const rawTotal        = targetSetCount + (extraSetCounts[i] ?? 0) - (removedSetCounts[i] ?? 0);
          const totalSetCount   = Math.max(ex.sets.length, rawTotal);
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
          const restLabel       = `${Math.max(15, ex.targetRestSeconds || 60)}s rest`;

          return (
            <View key={i} style={[styles.exerciseCard, isDone && styles.exerciseCardDone, isActive && styles.exerciseCardActive]}>

              {/* ── Header row: tap to expand/collapse ── */}
              <TouchableOpacity
                style={styles.exerciseHeader}
                onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {}); setActiveExIdx(isActive ? -1 : i); }}
                activeOpacity={0.7}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.exerciseName, isDone && styles.exerciseNameDone]}>{ex.name}</Text>
                  <Text style={styles.exerciseMeta}>{targetSetCount} × {ex.targetReps}  ·  {restLabel}</Text>
                </View>
                <View style={[styles.setsBadge, isDone && styles.setsBadgeDone]}>
                  <Text style={[styles.setsBadgeText, isDone && styles.setsBadgeTextDone]}>
                    {`${ex.sets.length}/${totalSetCount}`}
                  </Text>
                </View>
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
                    const note = getExerciseWarmupNote(ex.name, i === 0);
                    return note ? (
                      <View style={styles.warmupNoteCard}>
                        <Text style={styles.warmupNoteText}>💡 {note}</Text>
                      </View>
                    ) : null;
                  })()}

                  {/* ── Pre-set coach hint (first set only, before anything is logged) ── */}
                  {ex.sets.length === 0 && preSetHints[i] && (
                    <View style={[styles.warmupNoteCard, { borderLeftWidth: 3, borderLeftColor: workoutPalette.strong }]}>
                      <Text style={[styles.warmupNoteText, { fontWeight: '700' }]}>
                        {preSetHints[i].intensityLabel.replace('_', ' ').toUpperCase()}
                        {preSetHints[i].recommendedWeight ? ` · ~${Math.round(preSetHints[i].recommendedWeight!)} lb` : ''}
                        {preSetHints[i].recommendedReps ? ` × ${preSetHints[i].recommendedReps}` : ''}
                      </Text>
                      <Text style={styles.warmupNoteText}>{preSetHints[i].rationale}</Text>
                    </View>
                  )}

                  {/* ── Form video link ── */}
                  <TouchableOpacity
                    style={styles.formVideoLink}
                    onPress={() => Linking.openURL(`https://www.youtube.com/results?search_query=${encodeURIComponent(`${ex.name} proper form`)}`)}
                    activeOpacity={0.7}>
                    <Text style={styles.formVideoLinkText}>▶ Form Video</Text>
                  </TouchableOpacity>

                  {/* ── AI tip — shown prominently above set rows ── */}
                  {isAiLoading && (
                    <View style={styles.aiBubble}>
                      <ActivityIndicator size="small" color={themeColors.accent} />
                      <Text style={styles.aiLoadingText}>  Getting AI tip...</Text>
                    </View>
                  )}
                  {/* Render gate: only show the AI tip card once the user
                      has rated the last logged set. The fetch itself is
                      already gated in handleSetFeedback, but this second
                      check belt-and-braces any state-ordering races. */}
                  {!isAiLoading && ex.aiRecommendation && (
                    ex.sets.length === 0 || !!ex.sets[ex.sets.length - 1]?.feedback
                  ) && (
                    <View style={styles.aiBubble}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.aiLabel}>AI TIP</Text>
                        <Text style={styles.aiText}>{ex.aiRecommendation}</Text>
                      </View>
                    </View>
                  )}

                  {/* ── Inline set rows ── */}
                  {(() => {
                    const timed = isTimedExercise(ex.name, ex.targetReps);
                    return (
                      <>
                        <View style={styles.inlineSetsHeader}>
                          <Text style={[styles.inlineSetsLabel, { width: 20, flex: 0 }]}>#</Text>
                          {timed ? (
                            <Text style={[styles.inlineSetsLabel, { flex: 2 }]}>Duration (min)</Text>
                          ) : (
                            <>
                              <Text style={styles.inlineSetsLabel}>Weight</Text>
                              <Text style={styles.inlineSetsLabel}>Reps</Text>
                            </>
                          )}
                          <Text style={styles.inlineSetsLabel}>Last time</Text>
                          <View style={{ width: 40 }} />
                        </View>

                        {Array.from({ length: totalSetCount }, (_, slot) => {
                          const logged = ex.sets[slot];
                          const inputKey = `${i}-${slot}`;
                          const input = setInputs[inputKey] ?? { weight: '', reps: '', duration: '' };
                          const lastSet = lastExerciseSets[ex.name]?.[slot] ?? lastExerciseSets[ex.name]?.[lastExerciseSets[ex.name]?.length - 1];
                          const isLogged = !!logged;

                          const lastTimeLabel = lastSet
                            ? (lastSet.durationSeconds != null
                                ? `${(lastSet.durationSeconds / 60).toFixed(1)}min`
                                : `${lastSet.weightLbs}×${lastSet.reps}`)
                            : '—';

                          if (timed) {
                            const timerKey = `${i}-${slot}`;
                            const timer = activeTimers[timerKey];
                            const timerRunning = timer?.running ?? false;
                            // Wall-clock derived: survives screen lock and
                            // app backgrounding. Ticked once per second by
                            // the shared render ticker.
                            const timerElapsed = getTimerElapsed(timerKey);
                            const timerMM = Math.floor(timerElapsed / 60).toString().padStart(2, '0');
                            const timerSS = (timerElapsed % 60).toString().padStart(2, '0');
                            const loggedLabel = logged?.durationSeconds != null
                              ? `${Math.floor(logged.durationSeconds / 60)}:${(logged.durationSeconds % 60).toString().padStart(2, '0')}`
                              : '';
                            return (
                              <View key={slot} style={[styles.inlineSetRow, isLogged && styles.inlineSetRowDone, { minHeight: 44, paddingVertical: 6 }]}>
                                <Text style={styles.inlineSetNum}>{slot + 1}</Text>
                                {isLogged ? (
                                  <View style={{ flex: 2, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                    <Text style={[styles.timerDisplay, { color: themeColors.textPrimary }]}>{loggedLabel}</Text>
                                    <Text style={{ fontSize: 11, color: themeColors.textMuted }}>logged</Text>
                                  </View>
                                ) : (
                                  <View style={{ flex: 2, gap: 4 }}>
                                    {/* Always-available manual entry. Long cardio
                                        users (treadmill/bike/rower) type here
                                        directly using the equipment's own clock. */}
                                    <TextInput
                                      style={[styles.inlineInput, { width: '100%' }]}
                                      value={input.duration}
                                      onChangeText={(v) => {
                                        if (timerRunning) stopExerciseTimer(timerKey);
                                        setSetInputs(prev => ({ ...prev, [inputKey]: { ...prev[inputKey] ?? { weight: '', reps: '', duration: '' }, duration: v } }));
                                      }}
                                      placeholder={isLongCardioExercise(ex.name, ex.targetReps) ? '25:00 or 25 min' : '45s or 1:00'}
                                      placeholderTextColor={themeColors.textMuted}
                                      keyboardType="default"
                                    />
                                    {/* Compact timer row — useful for short
                                        holds (plank, dead hang, carries). */}
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                      <Text style={[styles.timerDisplay, timerRunning && { color: themeColors.primary }, { fontSize: 12 }]}>
                                        {timerMM}:{timerSS}
                                      </Text>
                                      {!timerRunning && timerElapsed === 0 ? (
                                        <TouchableOpacity
                                          style={[styles.timerBtn, { backgroundColor: themeColors.primary }]}
                                          onPress={() => {
                                            // Open the full-screen timer modal and start
                                            // the timer so the user sees big digits from
                                            // the first tick. The modal reads from the
                                            // same activeTimers state, so stopping inside
                                            // the modal also updates the inline display.
                                            startExerciseTimer(timerKey);
                                            setTimerModalKey(timerKey);
                                          }}>
                                          <Text style={styles.timerBtnText}>Start</Text>
                                        </TouchableOpacity>
                                      ) : timerRunning ? (
                                        <TouchableOpacity
                                          style={[styles.timerBtn, { backgroundColor: '#E53935' }]}
                                          onPress={() => {
                                            stopExerciseTimer(timerKey);
                                            const secs = getTimerElapsed(timerKey);
                                            if (secs > 0) {
                                              const durStr = formatDurationForInput(secs);
                                              setSetInputs(prev => ({ ...prev, [inputKey]: { ...prev[inputKey] ?? { weight: '', reps: '', duration: '' }, duration: durStr } }));
                                            }
                                          }}>
                                          <Text style={styles.timerBtnText}>Stop</Text>
                                        </TouchableOpacity>
                                      ) : (
                                        <>
                                          <TouchableOpacity
                                            style={[styles.timerBtn, { backgroundColor: themeColors.primary }]}
                                            onPress={() => startExerciseTimer(timerKey)}>
                                            <Text style={styles.timerBtnText}>Resume</Text>
                                          </TouchableOpacity>
                                          <TouchableOpacity
                                            style={[styles.timerBtn, { backgroundColor: themeColors.textMuted }]}
                                            onPress={() => resetExerciseTimer(timerKey)}>
                                            <Text style={styles.timerBtnText}>Reset</Text>
                                          </TouchableOpacity>
                                        </>
                                      )}
                                    </View>
                                  </View>
                                )}
                                <Text style={styles.inlineLastResult} numberOfLines={1}>{lastTimeLabel}</Text>
                                <TouchableOpacity
                                  style={[styles.inlineLoggedBadge, !isLogged && styles.inlineLoggedBadgePending]}
                                  onPress={() => {
                                    if (!isLogged) {
                                      // If the user typed a duration, log that.
                                      // Otherwise pull the elapsed off the timer.
                                      const typed = (input.duration || '').trim();
                                      if (typed) {
                                        handleLogSetInline(i, slot, false);
                                        return;
                                      }
                                      if (timerRunning) stopExerciseTimer(timerKey);
                                      const secs = getTimerElapsed(timerKey);
                                      if (secs > 0) {
                                        const durStr = formatDurationForInput(secs);
                                        setSetInputs(prev => ({ ...prev, [inputKey]: { ...prev[inputKey] ?? { weight: '', reps: '', duration: '' }, duration: durStr } }));
                                        setTimeout(() => handleLogSetInline(i, slot, false), 50);
                                      } else {
                                        handleLogSetInline(i, slot, false);
                                      }
                                    }
                                  }}>
                                  <Text style={[styles.inlineLoggedBadgeText, !isLogged && { color: themeColors.textMuted }]}>
                                    {isLogged ? <Ionicons name="checkmark" size={14} color="#fff" /> : <Ionicons name="radio-button-off" size={14} />}
                                  </Text>
                                </TouchableOpacity>
                              </View>
                            );
                          }

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
                          return (
                            <View key={slot} style={[styles.inlineSetRow, isLogged && styles.inlineSetRowDone]}>
                              <Text style={styles.inlineSetNum}>{slot + 1}</Text>
                              <TextInput
                                style={[styles.inlineInput, isLogged && styles.inlineInputDone]}
                                value={isLogged ? (editingSetKey === inputKey ? (editDraft.weight ?? String(logged.weightLbs)) : String(logged.weightLbs)) : input.weight}
                                onChangeText={v => {
                                  if (isLogged) {
                                    setEditingSetKey(inputKey);
                                    setEditDraft(prev => ({ ...prev, weight: v }));
                                  } else {
                                    setSetInputs(prev => ({ ...prev, [inputKey]: { ...prev[inputKey] ?? { weight: '', reps: '', duration: '' }, weight: v } }));
                                  }
                                }}
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
                              />
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
                              <Text style={styles.inlineLastResult} numberOfLines={1}>{lastTimeLabel}</Text>
                              <TouchableOpacity
                                style={[styles.inlineLoggedBadge, !isLogged && styles.inlineLoggedBadgePending]}
                                onPress={() => {
                                  if (!isLogged) { handleLogSetInline(i, slot, false); }
                                }}>
                                <Text style={[styles.inlineLoggedBadgeText, !isLogged && { color: themeColors.textMuted }]}>
                                  {isLogged ? <Ionicons name="checkmark" size={14} color="#fff" /> : <Ionicons name="radio-button-off" size={14} />}
                                </Text>
                              </TouchableOpacity>
                              {isLastSlot && (
                                <TouchableOpacity
                                  style={styles.inlineDeleteBtn}
                                  onPress={handleDeleteSlot}
                                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                  accessibilityLabel="Remove this set">
                                  <Text style={styles.inlineDeleteBtnText}>×</Text>
                                </TouchableOpacity>
                              )}
                            </View>
                          );
                        })}
                      </>
                    );
                  })()}

                  {/* Feedback buttons removed — recommendations now derive
                      from actual reps vs target reps automatically. */}

                  {(() => {
                    const timedInterval = isTimedExercise(ex.name, ex.targetReps) && totalSetCount >= 2;
                    const unitLabel = timedInterval ? 'Interval' : 'Set';
                    return (
                      <>
                        {isDone && (
                          <Text style={[styles.doneText, { textAlign: 'center', marginTop: 4 }]}>All sets complete!</Text>
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
                <Text style={[styles.timerModalExerciseName, { color: themeColors.textSecondary }]} numberOfLines={2}>
                  {mEx?.name || 'Timed Set'}
                </Text>
                <Text style={[styles.timerModalTargetReps, { color: themeColors.textMuted }]}>
                  Target: {mEx?.targetReps ?? '—'}
                </Text>
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
                      onPress={() => stopExerciseTimer(timerModalKey)}>
                      <Text style={styles.timerModalBigBtnText}>Pause</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      style={[styles.timerModalBigBtn, { backgroundColor: themeColors.primary }]}
                      onPress={() => startExerciseTimer(timerModalKey)}>
                      <Text style={styles.timerModalBigBtnText}>{mElapsed > 0 ? 'Resume' : 'Start'}</Text>
                    </TouchableOpacity>
                  )}
                </View>

                <View style={styles.timerModalSecondaryRow}>
                  <TouchableOpacity
                    style={[styles.timerModalSecondaryBtn, { borderColor: themeColors.border }]}
                    onPress={() => resetExerciseTimer(timerModalKey)}>
                    <Text style={[styles.timerModalSecondaryBtnText, { color: themeColors.textSecondary }]}>Reset</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.timerModalSecondaryBtn, { backgroundColor: themeColors.primary, borderColor: themeColors.primary }]}
                    onPress={writeDurationAndClose}>
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

              <TouchableOpacity style={styles.logConfirmBtn} onPress={handleLogSet}>
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
                        <Text style={styles.shareStatIcon}>⏱</Text>
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
                    </View>

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

                {/* Share + Feedback buttons */}
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
                        <Text style={styles.feedbackResultIcon}>✅</Text>
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
                          { value: 'rough', label: '😓 Rough' },
                          { value: 'okay',  label: '😐 Okay' },
                          { value: 'good',  label: '💪 Good' },
                          { value: 'great', label: '🔥 Great' },
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
                <TouchableOpacity
                  style={styles.summaryFeedbackBtn}
                  onPress={dismissSummaryModal}
                  activeOpacity={0.85}>
                  <Text style={styles.summaryFeedbackBtnText}>Done</Text>
                </TouchableOpacity>
              </View>
            )}

          </ScrollView>
        </View>
      </Modal>

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

            <View style={styles.coachActionRow}>
              <TouchableOpacity style={styles.coachActionBtn} onPress={() => handleAnalyzeFormPhoto('camera')} disabled={coachPhotoLoading}>
                <Text style={styles.coachActionText}>{coachPhotoLoading ? 'Analyzing...' : 'Snap Form Photo'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.coachActionBtn} onPress={() => handleAnalyzeFormPhoto('library')} disabled={coachPhotoLoading}>
                <Text style={styles.coachActionText}>Use Existing Photo</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.coachActionRow}>
              <TouchableOpacity style={styles.coachActionBtn} onPress={() => handleAnalyzeFormVideo('camera')} disabled={coachPhotoLoading}>
                <Text style={styles.coachActionText}>Record Form Video</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.coachActionBtn} onPress={() => handleAnalyzeFormVideo('library')} disabled={coachPhotoLoading}>
                <Text style={styles.coachActionText}>Analyze Saved Video</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.coachSubHint}>Video checks use a representative frame from your clip for now.</Text>

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

            <View style={styles.coachInputRow}>
              <TextInput
                value={coachInput}
                onChangeText={setCoachInput}
                placeholder="Ask about form or pain..."
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

      <Modal visible={addExerciseModalVisible} transparent animationType="slide" onRequestClose={() => setAddExerciseModalVisible(false)}>
        <KeyboardAvoidingView style={styles.modalBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.coachSheet}>
            <View style={styles.coachHeader}>
              <Text style={styles.coachTitle}>Add an exercise</Text>
              <TouchableOpacity onPress={() => setAddExerciseModalVisible(false)}>
                <Text style={styles.coachClose}>Close</Text>
              </TouchableOpacity>
            </View>

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
                        <Text style={styles.addExerciseName}>{ex.name}</Text>
                        <Text style={styles.addExerciseMeta}>
                          {humanizeToken(ex.primary_muscle)} · {formatEquipmentLabel(ex.equipment)} · {ex.sets}×{ex.reps}
                        </Text>
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
                ) : filteredExerciseLibrary.map((item) => (
                  <TouchableOpacity key={String(item.id ?? item.name)} style={styles.addExerciseItem} onPress={() => handleAddExercise(item)}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.addExerciseName}>{item.name}</Text>
                      <Text style={styles.addExerciseMeta}>{humanizeToken(item.primary_muscle) || 'General'} · {formatEquipmentLabel(item.equipment) || 'Bodyweight'}</Text>
                    </View>
                    <Text style={styles.addExerciseUse}>Add</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </View>
        </KeyboardAvoidingView>
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
    marginBottom: 0,
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
    marginBottom: 0,
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
  restBannerLeft: { alignItems: 'center', minWidth: 64 },
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
  inlineLastResult: { flex: 1, fontSize: 11, color: tc.textMuted, textAlign: 'center' },
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

  aiBubble:      { flexDirection: 'row', alignItems: 'center', backgroundColor: tc.surfaceRaised, borderRadius: radius.md, padding: 12, borderLeftWidth: 3, borderLeftColor: tc.accent },
  aiBubbleError: { borderLeftColor: tc.error },
  aiLabel:       { fontSize: 10, fontWeight: '700', color: tc.accent, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 3 },
  aiText:        { fontSize: 13, color: tc.textPrimary },
  aiLoadingText: { fontSize: 13, color: tc.textSecondary },
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
  lastTimeBest: { fontSize: 11, color: tc.textPrimary, fontWeight: '700' },
  lastTimeRow:      { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 },
  lastTimeSetNum:   { fontSize: 11, color: tc.textMuted, width: 36 },
  lastTimeData:     { flex: 1, fontSize: 12, color: tc.textPrimary, fontWeight: '700' },
  lastTimeFeedback: { fontSize: 11, color: tc.accent, fontWeight: '700' },

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
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  shareStatTile: {
    flex: 1,
    minWidth: '42%' as any,
    backgroundColor: tc.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: tc.border,
    paddingVertical: 12,
    alignItems: 'center',
    gap: 2,
  },
  shareStatIcon: { fontSize: 18, marginBottom: 2 },
  shareStatValue: { fontSize: 22, fontWeight: '800', color: tc.textPrimary },
  shareStatLabel: { fontSize: 10, fontWeight: '600', color: tc.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
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
