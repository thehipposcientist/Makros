import { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Modal, ActivityIndicator, Alert, TextInput, KeyboardAvoidingView, Platform, Linking, Image, Dimensions } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

const { width: SCREEN_W } = Dimensions.get('window');
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import { UserProfile, WorkoutPlan, DailyNutritionPlan, WorkoutDay } from '../types';
import { generateWorkoutPlan, generateDailyNutritionForDate } from '../utils/planGenerator';
import { getWorkoutStatus, getDayState, upsertDayState, getExercises, askTrainerQuestion } from '../services/api';
import { useMetaData } from '../hooks/useMetaData';
import {
  isTodayWorkoutDone, todayKey, dateKey, loadWorkoutHistory,
} from '../utils/workoutHistory';
import { getMealChecks, saveMealChecks, MealChecks, getSavedNutritionPlan, saveNutritionPlan } from '../utils/mealTracker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MealSuggestion } from '../types';
import WorkoutCard from '../components/WorkoutCard';
import NutritionCard from '../components/NutritionCard';
import MealEditModal from '../components/MealEditModal';
import { colors, getTheme, radius } from '../constants/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface HomeScreenProps {
  authToken: string;
  userProfile: UserProfile | null;
  planRefreshKey?: number;
  isPlanUpdating?: boolean;
  onSignOut: () => void;
  onEditProfile: () => void;
  onEditEquipment: () => void;
  onEditFoods: () => void;
  onEditThemes: () => void;
  onStartWorkout: (workout: WorkoutDay) => void;
  onViewProgress: () => void;
  onViewAccount: () => void;
}

interface ScheduleItem {
  date: Date;
  workout: WorkoutDay | null;
  isRest: boolean;
}

interface MealDay {
  key: string;
  date: Date;
}

interface TrainerChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AvailabilityItem {
  label: string;
  pct: number;
}

interface ExerciseLibraryItem {
  id?: number;
  name: string;
  description?: string | null;
  primary_muscle?: string;
  secondary_muscles?: string[];
  equipment?: string;
  is_compound?: boolean;
}

const DAY_NAMES   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const TRAINING_DAY_SETS: Record<number, number[]> = {
  1: [1],
  2: [1, 4],
  3: [1, 3, 5],
  4: [1, 2, 4, 5],
  5: [1, 2, 3, 4, 5],
  6: [1, 2, 3, 4, 5, 6],
  7: [0, 1, 2, 3, 4, 5, 6],
};

function get7DaySchedule(workoutPlan: WorkoutPlan, daysPerWeek: number): ScheduleItem[] {
  if (!workoutPlan?.days?.length) return [];
  const trainingSet = new Set(TRAINING_DAY_SETS[Math.min(Math.max(daysPerWeek, 1), 7)] ?? [1, 3, 5]);
  const today = new Date();
  const todayDow = today.getDay();
  const daysFromMon = todayDow === 0 ? 6 : todayDow - 1;
  let weekOffset = 0;
  for (let i = 0; i < daysFromMon; i++) {
    const dow = (i + 1) % 7;
    if (trainingSet.has(dow)) weekOffset++;
  }
  const schedule: ScheduleItem[] = [];
  let workoutIdx = weekOffset;
  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    const dow = date.getDay();
    if (trainingSet.has(dow)) {
      schedule.push({ date, workout: workoutPlan.days[workoutIdx % workoutPlan.days.length], isRest: false });
      workoutIdx++;
    } else {
      schedule.push({ date, workout: null, isRest: true });
    }
  }
  return schedule;
}

function getNextMealDays(count: number): MealDay[] {
  const out: MealDay[] = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    out.push({ key: dateKey(d), date: d });
  }
  return out;
}

function mealDayLabel(date: Date, index: number): string {
  if (index === 0) return 'Today';
  if (index === 1) return 'Tomorrow';
  return `${DAY_NAMES[date.getDay()]} · ${MONTH_NAMES[date.getMonth()]} ${date.getDate()}`;
}

function humanizeToken(value?: string | null): string {
  if (!value) return '';
  return String(value)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function joinParts(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function buildExerciseGuide(ex: ExerciseLibraryItem) {
  const primary = humanizeToken(ex.primary_muscle) || 'the target muscle';
  const secondary = (ex.secondary_muscles ?? []).map(humanizeToken).filter(Boolean);
  const equipment = humanizeToken(ex.equipment) || 'the available equipment';
  const supportText = secondary.length ? ` with help from ${joinParts(secondary)}` : '';

  return {
    howTo: ex.description
      ? ex.description
      : `Move the weight with control, keep your body stable, and use ${equipment.toLowerCase()} in a smooth range of motion.` ,
    hits: `This exercise mainly trains ${primary.toLowerCase()}${supportText}.`,
    why: ex.is_compound
      ? `It hits ${primary.toLowerCase()} because multiple joints are moving together, which lets ${primary.toLowerCase()} work hard while nearby muscles assist and stabilize.`
      : `It hits ${primary.toLowerCase()} because the movement keeps tension focused there instead of spreading the work across many muscle groups.`,
    setup: `Set yourself up so your body feels balanced, brace your torso, and position the ${equipment.toLowerCase()} so the movement starts under control.`,
    movement: `Move through a controlled full range, avoid rushing, and think about driving the weight with ${primary.toLowerCase()} instead of just swinging it.`,
    feel: `You should mostly feel this in ${primary.toLowerCase()}${secondary.length ? ` with some support from ${joinParts(secondary).toLowerCase()}` : ''}, not in random joints or sharp pain spots.`,
    mistake: `A common mistake is using too much momentum or shortening the range of motion, which takes work away from ${primary.toLowerCase()}.`,
  };
}

function getExerciseVideoUrl(exerciseName: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${exerciseName} proper form`)}`;
}


function compactGoalProgressText(
  userProfile: UserProfile,
  goalConfig: import('../hooks/useMetaData').GoalConfig,
): string | null {
  const { goal, goalDetails, physicalStats } = userProfile;
  const isWeightGoal = new Set(goalConfig.weight_goals).has(goal);
  if (isWeightGoal && goalDetails.targetWeightLbs) {
    const start = goalDetails.startWeightLbs ?? physicalStats.weightLbs;
    const current = physicalStats.weightLbs;
    const target = goalDetails.targetWeightLbs;
    const total = Math.abs(start - target);
    const done = Math.abs(start - current);
    const pct = total > 0 ? Math.round(Math.min(1, Math.max(0, done / total)) * 100) : 0;
    return `${pct}% · ${current} / ${target} lbs`;
  }

  if (goalDetails.timelineWeeks) {
    const startDate = goalDetails.goalStartedAt ? new Date(goalDetails.goalStartedAt) : new Date();
    const weeksElapsed = Math.max(0, (Date.now() - startDate.getTime()) / (7 * 24 * 60 * 60 * 1000));
    const pct = Math.round(Math.min(1, weeksElapsed / goalDetails.timelineWeeks) * 100);
    return `${pct}% · week ${Math.round(weeksElapsed)} / ${goalDetails.timelineWeeks}`;
  }

  return null;
}

function inferGroup(text: string): string {
  const blob = text.toLowerCase();
  if (/(bike|cycle|cycling|spin|run|running|jog|treadmill|cardio|conditioning|hiit)/.test(blob)) return 'Cardio';
  if (/(bench|chest|press|fly|push[- ]?up)/.test(blob)) return 'Chest';
  if (/(row|pull|lat|back|deadlift|pull[- ]?up)/.test(blob)) return 'Back';
  if (/(squat|lunge|leg|quad|hamstring|calf)/.test(blob)) return 'Legs';
  if (/(shoulder|overhead|lateral raise|rear delt)/.test(blob)) return 'Shoulders';
  if (/(bicep|tricep|curl|extension)/.test(blob)) return 'Arms';
  if (/(core|ab|plank|crunch)/.test(blob)) return 'Core';
  if (/(glute|hip thrust)/.test(blob)) return 'Glutes';
  return 'Other';
}

function buildAvailability(
  workoutPlan: WorkoutPlan,
  history: Awaited<ReturnType<typeof loadWorkoutHistory>>,
): { items: AvailabilityItem[]; cardioProfile: string | null } {
  const counts: Record<string, number> = {
    Chest: 0,
    Back: 0,
    Legs: 0,
    Shoulders: 0,
    Arms: 0,
    Core: 0,
    Glutes: 0,
    Cardio: 0,
  };

  for (const day of (workoutPlan.days ?? [])) {
    for (const ex of (day.exercises ?? [])) {
      const group = inferGroup(`${day.focus} ${ex.name}`);
      if (group in counts) counts[group] += 1;
    }
  }

  const maxCount = Math.max(1, ...Object.values(counts));
  const items = Object.entries(counts)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([label, value]) => ({
      label,
      pct: Math.max(10, Math.round((value / maxCount) * 100 / 5) * 5),
    }));

  const cyclingHits = history.filter((s) => /cycle|cycling|bike|spin/i.test(`${s.focus} ${(s.exercises ?? []).map(e => e.name).join(' ')}`)).length;
  const runningHits = history.filter((s) => /run|running|jog|treadmill/i.test(`${s.focus} ${(s.exercises ?? []).map(e => e.name).join(' ')}`)).length;
  const cardioProfile = cyclingHits > 0
    ? `Cyclist profile (${cyclingHits} sessions)`
    : runningHits > 0
      ? `Runner profile (${runningHits} sessions)`
      : null;

  return { items, cardioProfile };
}

// ─────────────────────────────────────────────────────────────────────────────

export default function HomeScreen({ authToken, userProfile, planRefreshKey = 0, isPlanUpdating = false, onSignOut, onEditProfile, onEditEquipment, onEditFoods, onEditThemes, onStartWorkout, onViewProgress, onViewAccount }: HomeScreenProps) {
  const insets = useSafeAreaInsets();
  const meta = useMetaData();
  const theme = getTheme(userProfile?.themePreference);
  const themeColors = theme.colors;
  const workoutPalette = theme.sections.workout;
  const mealPalette = theme.sections.meals;
  const plannerPalette = theme.sections.planner;

  const [workoutPlan, setWorkoutPlan]     = useState<WorkoutPlan | null>(null);
  const [nutritionPlansByDate, setNutritionPlansByDate] = useState<Record<string, DailyNutritionPlan>>({});
  const [activeTab, setActiveTab]         = useState<'workout' | 'meals'>('workout');
  const [menuOpen, setMenuOpen]           = useState(false);
  const [expandedDay, setExpandedDay]     = useState<number>(-1);
  const [showExerciseLibrary, setShowExerciseLibrary] = useState(false);
  const [exerciseLibraryLoading, setExerciseLibraryLoading] = useState(false);
  const [exerciseLibrary, setExerciseLibrary] = useState<ExerciseLibraryItem[]>([]);
  const [selectedExercise, setSelectedExercise] = useState<ExerciseLibraryItem | null>(null);
  const [exerciseSearch, setExerciseSearch] = useState('');
  const [exerciseMuscleFilter, setExerciseMuscleFilter] = useState<string>('all');
  const [exerciseEquipmentFilter, setExerciseEquipmentFilter] = useState<string>('all');
  const [showTrainerModal, setShowTrainerModal] = useState(false);
  const [coachMode, setCoachMode] = useState<'trainer' | 'nutritionist'>('trainer');
  const [trainerInput, setTrainerInput] = useState('');
  const [trainerLoading, setTrainerLoading] = useState(false);
  const [attachedImage, setAttachedImage] = useState<{ base64: string; uri: string } | null>(null);
  const [workoutChat, setWorkoutChat] = useState<TrainerChatMessage[]>([]);
  const [nutritionChat, setNutritionChat] = useState<TrainerChatMessage[]>([]);
  const [workoutUpdateSummary, setWorkoutUpdateSummary] = useState<string | null>(null);
  const [nutritionUpdateSummary, setNutritionUpdateSummary] = useState<string | null>(null);

  // Completion + skip state
  const [todayDone, setTodayDone]         = useState(false);
  const [skippedDates, setSkippedDates]   = useState<Set<string>>(new Set());

  // Meal tracking
  const [checkedMealsByDate, setCheckedMealsByDate] = useState<Record<string, MealChecks>>({});
  const [editingMeal, setEditingMeal] = useState<{ dateKey: string; type: string; meal: MealSuggestion } | null>(null);
  const [currentDate, setCurrentDate] = useState(todayKey());
  const [expandedMealDays, setExpandedMealDays] = useState<Set<string>>(new Set());
  const [availabilityItems, setAvailabilityItems] = useState<AvailabilityItem[]>([]);
  const [cardioProfile, setCardioProfile] = useState<string | null>(null);

  const persistDayState = useCallback(async (dayKey: string, patch: { skipped_focus?: string | null; meal_checks?: Record<string, boolean>; nutrition_plan?: any }) => {
    if (!authToken) return;
    try {
      const currentChecks = checkedMealsByDate[dayKey] ?? {};
      const currentPlan = nutritionPlansByDate[dayKey] ?? null;
      const isSkipped = skippedDates.has(dayKey);
      await upsertDayState(authToken, dayKey, {
        skipped_focus: patch.skipped_focus !== undefined ? patch.skipped_focus : (isSkipped ? 'skipped' : null),
        meal_checks: patch.meal_checks ?? currentChecks,
        nutrition_plan: patch.nutrition_plan ?? currentPlan,
      });
    } catch {
      // Keep app responsive even if backend persistence fails
    }
  }, [authToken, checkedMealsByDate, nutritionPlansByDate, skippedDates]);

  useEffect(() => {
    if (userProfile) loadPlans(userProfile);
    loadDayStatus();
  }, [userProfile, authToken, meta.allFoods.length, planRefreshKey]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!workoutPlan) return;
      const history = await loadWorkoutHistory();
      const insight = buildAvailability(workoutPlan, history);
      if (!mounted) return;
      setAvailabilityItems(insight.items);
      setCardioProfile(insight.cardioProfile);
    })();
    return () => { mounted = false; };
  }, [todayDone, workoutPlan]);

  useEffect(() => {
    const timer = setInterval(() => {
      const nowKey = todayKey();
      if (nowKey !== currentDate) {
        setCurrentDate(nowKey);
        loadDayStatus();
        if (userProfile) loadPlans(userProfile);
      }
    }, 60000);
    return () => clearInterval(timer);
  }, [currentDate, userProfile, authToken, meta.allFoods.length]);

  const loadDayStatus = async () => {
    const today = todayKey();
    const mealDays = getNextMealDays(7);
    const checkMap: Record<string, MealChecks> = {};
    const skipped = new Set<string>();

    if (authToken) {
      const states = await Promise.all(mealDays.map(d => getDayState(authToken, d.key).catch(() => null)));
      mealDays.forEach((d, i) => {
        const s = states[i] as any;
        checkMap[d.key] = s?.meal_checks ?? {};
        if (s?.skipped_focus) skipped.add(d.key);
      });
    } else {
      const checksList = await Promise.all(mealDays.map(d => getMealChecks(d.key)));
      mealDays.forEach((d, i) => { checkMap[d.key] = checksList[i] as MealChecks; });
    }

    setSkippedDates(skipped);
    setCheckedMealsByDate(checkMap);

    // Check workout completion from backend DB (not AsyncStorage)
    try {
      if (authToken) {
        const status = await getWorkoutStatus(authToken, today);
        setTodayDone(status.done);
      } else {
        // Fallback to local if no token
        setTodayDone(await isTodayWorkoutDone());
      }
    } catch {
      setTodayDone(await isTodayWorkoutDone());
    }
  };

  const loadPlans = async (profile: UserProfile) => {
    // Check for an AI-generated plan saved after user saves plan settings
    const aiWorkoutRaw = await AsyncStorage.getItem('aiWorkoutPlan');
    const baseWorkout = aiWorkoutRaw ? JSON.parse(aiWorkoutRaw) : generateWorkoutPlan(profile);
    setWorkoutPlan(baseWorkout);

    // AI nutrition plan is used as the base template (overrides local generation)
    const aiNutritionRaw = await AsyncStorage.getItem('aiNutritionPlan');
    const aiNutritionTemplate: DailyNutritionPlan | null = aiNutritionRaw ? JSON.parse(aiNutritionRaw) : null;

    const mealDays = getNextMealDays(7);

    /** Returns true only if meals carry real per-meal calorie data. */
    const hasMealMacros = (plan: DailyNutritionPlan | null | undefined): boolean => {
      if (!plan) return false;
      const meals = [plan.breakfast, plan.lunch, plan.dinner].filter(Boolean);
      return meals.length > 0 && meals.every(m => (m?.calories ?? 0) > 0);
    };

    const localEntries = await Promise.all(
      mealDays.map(async d => {
        // 1. Try backend day-state — only trust it if macros are present
        if (authToken) {
          const remote = await getDayState(authToken, d.key).catch(() => null) as any;
          if (remote?.nutrition_plan && hasMealMacros(remote.nutrition_plan)) {
            return [d.key, remote.nutrition_plan as DailyNutritionPlan] as const;
          }
        }
        // 2. Try locally saved plan (user's day-specific edits) — only if macros valid
        const saved = await getSavedNutritionPlan(d.key);
        if (saved && hasMealMacros(saved)) return [d.key, saved] as const;

        // 3. Use AI-generated template (has macros after backend fix)
        if (aiNutritionTemplate && hasMealMacros(aiNutritionTemplate)) {
          return [d.key, aiNutritionTemplate] as const;
        }

        // 4. Local generator — always has macros
        return [d.key, generateDailyNutritionForDate(profile, meta.allFoods, d.key)] as const;
      })
    );
    setNutritionPlansByDate(Object.fromEntries(localEntries));
  };

  const openExerciseLibrary = useCallback(async () => {
    setShowExerciseLibrary(true);
    if (exerciseLibrary.length > 0) return;
    setExerciseLibraryLoading(true);
    try {
      const rows = await getExercises();
      setExerciseLibrary(rows);
    } catch {
      setExerciseLibrary([]);
    } finally {
      setExerciseLibraryLoading(false);
    }
  }, [exerciseLibrary.length]);

  const exerciseMuscleOptions = Array.from(
    new Set(exerciseLibrary.map((item) => item.primary_muscle).filter(Boolean) as string[])
  ).sort((a, b) => humanizeToken(a).localeCompare(humanizeToken(b)));

  const exerciseEquipmentOptions = Array.from(
    new Set(exerciseLibrary.map((item) => item.equipment).filter(Boolean) as string[])
  ).sort((a, b) => humanizeToken(a).localeCompare(humanizeToken(b)));

  const filteredExerciseLibrary = exerciseLibrary.filter((item) => {
    const search = exerciseSearch.trim().toLowerCase();
    const matchesSearch = !search || [
      item.name,
      item.description ?? '',
      humanizeToken(item.primary_muscle),
      humanizeToken(item.equipment),
      ...(item.secondary_muscles ?? []).map(humanizeToken),
    ].some((value) => value.toLowerCase().includes(search));
    const matchesMuscle = exerciseMuscleFilter === 'all' || item.primary_muscle === exerciseMuscleFilter;
    const matchesEquipment = exerciseEquipmentFilter === 'all' || item.equipment === exerciseEquipmentFilter;
    return matchesSearch && matchesMuscle && matchesEquipment;
  });

  const summarizeTrainerUpdate = useCallback((
    prevWorkout: WorkoutPlan,
    nextWorkout: WorkoutPlan | null,
    prevNutrition: DailyNutritionPlan | null,
    nextNutrition: DailyNutritionPlan | null,
  ): string => {
    const notes: string[] = [];

    if (nextWorkout) {
      const prevDays = prevWorkout?.days?.length ?? 0;
      const nextDays = nextWorkout?.days?.length ?? 0;
      if (prevDays !== nextDays) notes.push(`Workout days: ${prevDays} → ${nextDays}`);

      const prevExercises = (prevWorkout?.days ?? []).reduce((sum, d) => sum + (d.exercises?.length ?? 0), 0);
      const nextExercises = (nextWorkout?.days ?? []).reduce((sum, d) => sum + (d.exercises?.length ?? 0), 0);
      if (prevExercises !== nextExercises) notes.push(`Weekly exercises: ${prevExercises} → ${nextExercises}`);
    }

    if (prevNutrition && nextNutrition) {
      const prevCal = prevNutrition.targets.calories;
      const nextCal = nextNutrition.targets.calories;
      if (prevCal !== nextCal) notes.push(`Calories: ${prevCal} → ${nextCal}`);

      const prevProtein = prevNutrition.targets.protein;
      const nextProtein = nextNutrition.targets.protein;
      if (prevProtein !== nextProtein) notes.push(`Protein: ${prevProtein}g → ${nextProtein}g`);
    }

    return notes.length ? notes.join(' • ') : 'Trainer updated exercise/nutrition structure.';
  }, []);

  const handleAskTrainer = useCallback(async () => {
    const q = trainerInput.trim();
    if (!q) return;
    if (!authToken || !userProfile || !workoutPlan) {
      Alert.alert('Unavailable', 'Please sign in and load your plan first.');
      return;
    }

    const isTrainer = coachMode === 'trainer';
    const activeChat = isTrainer ? workoutChat : nutritionChat;
    const setActiveChat = isTrainer ? setWorkoutChat : setNutritionChat;
    const setUpdateSummary = isTrainer ? setWorkoutUpdateSummary : setNutritionUpdateSummary;

    const userMsg: TrainerChatMessage = { role: 'user', content: q + (attachedImage ? ' [photo attached]' : '') };
    const nextChat = [...activeChat, userMsg];
    setActiveChat(nextChat);
    setTrainerInput('');
    const imageToSend = attachedImage;
    setAttachedImage(null);
    setTrainerLoading(true);

    try {
      const todayPlan = nutritionPlansByDate[todayKey()] ?? null;
      const workoutHistory = await loadWorkoutHistory();
      const recentHistory = workoutHistory.slice(0, 40).map((s) => ({
        date: s.date,
        focus: s.focus,
        durationSeconds: s.durationSeconds,
        completed: s.completed,
        exercises: (s.exercises ?? []).map((ex) => ({
          name: ex.name,
          targetSets: ex.targetSets,
          targetReps: ex.targetReps,
          targetRestSeconds: ex.targetRestSeconds,
          setsLogged: ex.sets?.length ?? 0,
          bestSet: (ex.sets ?? []).reduce<{ weightLbs: number; reps: number } | null>((best, set) => {
            if (!best) return { weightLbs: set.weightLbs, reps: set.reps };
            const bestScore = best.weightLbs * best.reps;
            const currentScore = set.weightLbs * set.reps;
            return currentScore > bestScore ? { weightLbs: set.weightLbs, reps: set.reps } : best;
          }, null),
        })),
      }));

      const sessionsLast30d = workoutHistory.filter((s) => {
        const ts = new Date(s.date).getTime();
        return Number.isFinite(ts) && (Date.now() - ts) <= 30 * 24 * 60 * 60 * 1000;
      }).length;

      const totalSetsLogged = workoutHistory.reduce(
        (sum, s) => sum + (s.exercises ?? []).reduce((setSum, ex) => setSum + (ex.sets?.length ?? 0), 0),
        0
      );

      const progress = {
        goal: userProfile.goal,
        todayDone,
        skippedDays: Array.from(skippedDates),
        daysPerWeek: userProfile.daysPerWeek,
        durationMinutes: userProfile.workoutDurationMinutes,
        sessionsLast30d,
        totalSessions: workoutHistory.length,
        totalSetsLogged,
        workoutHistory: recentHistory,
      };

      // Build a structured summary of the current plan so the AI always knows what to modify
      const currentPlanContext = {
        workoutDays: (workoutPlan?.days ?? []).map(d => ({
          focus: d.focus,
          exercises: d.exercises.map(e => ({ name: e.name, sets: e.sets, reps: e.reps })),
        })),
        todayMeals: todayPlan
          ? (['breakfast', 'lunch', 'dinner', 'snack'] as const)
              .map(type => {
                const m = todayPlan[type];
                return m ? { type, meal: m.meal, foods: m.foods, calories: m.calories, protein: m.protein } : null;
              })
              .filter(Boolean) as Array<{ type: string; meal: string; foods: string[]; calories: number; protein: number }>
          : [],
        mealRoutine: userProfile.mealRoutine,
      };

      const slimProfile = {
        goal: userProfile.goal,
        goalDetails: userProfile.goalDetails,
        physicalStats: userProfile.physicalStats,
        daysPerWeek: userProfile.daysPerWeek,
        workoutDurationMinutes: userProfile.workoutDurationMinutes,
        equipment: userProfile.equipment,
        mealRoutine: userProfile.mealRoutine,
        injuries: userProfile.injuries,
        experienceLevel: userProfile.experienceLevel,
      };

      const resp = await askTrainerQuestion(authToken, {
        question: q,
        mode: coachMode,
        profile: slimProfile,
        workoutPlan: currentPlanContext,  // backend field name
        nutritionPlan: todayPlan ?? undefined,
        progress: {
          goal: progress.goal,
          todayDone: progress.todayDone,
          sessionsLast30d: progress.sessionsLast30d,
          totalSessions: progress.totalSessions,
        },
        conversation: nextChat.slice(-8),
        image_base64: imageToSend?.base64 ?? undefined,
        mime_type: 'image/jpeg',
      });

      const actionLines = (resp.action_items ?? []).slice(0, 4).map((x: string) => `• ${x}`).join('\n');
      const combined = [
        resp.answer,
        actionLines ? `\n${actionLines}` : '',
        resp.safety_note ? `\nSafety: ${resp.safety_note}` : '',
      ].join('');

      setActiveChat(prev => [...prev, { role: 'assistant', content: combined }]);

      const hasUpdate = !!resp.updated_workout_plan || !!resp.updated_nutrition_plan;
      if (resp.needs_plan_update && hasUpdate) {
        const prevWorkout = workoutPlan;
        const nextWorkout = (resp.updated_workout_plan as WorkoutPlan | undefined) ?? null;
        const nextNutrition = (resp.updated_nutrition_plan as DailyNutritionPlan | undefined) ?? null;

        if (resp.updated_workout_plan) {
          setWorkoutPlan(resp.updated_workout_plan as WorkoutPlan);
        }
        if (resp.updated_nutrition_plan) {
          const today = todayKey();
          setNutritionPlansByDate(prev => ({ ...prev, [today]: resp.updated_nutrition_plan as DailyNutritionPlan }));
          await saveNutritionPlan(today, resp.updated_nutrition_plan as DailyNutritionPlan);
          await persistDayState(today, { nutrition_plan: resp.updated_nutrition_plan });
        }
        setUpdateSummary(summarizeTrainerUpdate(prevWorkout, nextWorkout, todayPlan, nextNutrition));
        setActiveChat(prev => [...prev, { role: 'assistant', content: 'I applied those trainer updates to your current plan.' }]);
      }
    } catch (e: any) {
      setActiveChat(prev => [...prev, { role: 'assistant', content: `Could not answer right now. ${e?.message ?? ''}` }]);
    } finally {
      setTrainerLoading(false);
    }
  }, [trainerInput, attachedImage, authToken, userProfile, workoutPlan, nutritionPlansByDate, todayDone, skippedDates, workoutChat, nutritionChat, coachMode, persistDayState]);

  const handleToggleMeal = useCallback(async (date: string, mealType: string) => {
    const current = checkedMealsByDate[date] ?? {};
    const next = { ...current, [mealType]: !current[mealType] };
    setCheckedMealsByDate(prev => ({ ...prev, [date]: next }));
    await saveMealChecks(date, next);
    await persistDayState(date, { meal_checks: next });
  }, [checkedMealsByDate, persistDayState]);

  const handleMealSave = useCallback(async (date: string, mealType: string, updated: MealSuggestion) => {
    let nextPlan: DailyNutritionPlan | null = null;
    setNutritionPlansByDate(prev => {
      const current = prev[date];
      if (!current) return prev;
      if (mealType === 'new_extra') {
        nextPlan = { ...current, extraMeals: [...(current.extraMeals ?? []), updated] };
      } else if (mealType.startsWith('extra_')) {
        const idx = parseInt(mealType.slice(6), 10);
        const extras = [...(current.extraMeals ?? [])];
        extras[idx] = updated;
        nextPlan = { ...current, extraMeals: extras };
      } else {
        nextPlan = { ...current, [mealType]: updated } as DailyNutritionPlan;
      }
      return { ...prev, [date]: nextPlan as DailyNutritionPlan };
    });
    if (nextPlan) await saveNutritionPlan(date, nextPlan);
    if (nextPlan) await persistDayState(date, { nutrition_plan: nextPlan });
  }, [persistDayState]);

  const handleAddSnack = useCallback((date: string) => {
    const emptyMeal: MealSuggestion = { meal: 'Extra Meal', foods: [], calories: 0, protein: 0, carbs: 0, fat: 0 };
    setEditingMeal({ dateKey: date, type: 'new_extra', meal: emptyMeal });
  }, []);

  const handleRemoveMeal = useCallback(async (date: string, mealType: string) => {
    let nextPlan: DailyNutritionPlan | null = null;
    setNutritionPlansByDate(prev => {
      const current = prev[date];
      if (!current) return prev;
      if (mealType.startsWith('extra_')) {
        const idx = parseInt(mealType.slice(6), 10);
        const extras = (current.extraMeals ?? []).filter((_, i) => i !== idx);
        nextPlan = { ...current, extraMeals: extras };
      } else {
        const removed = new Set(current.removedMeals ?? []);
        removed.add(mealType);
        nextPlan = { ...current, removedMeals: Array.from(removed) };
      }
      return { ...prev, [date]: nextPlan as DailyNutritionPlan };
    });
    if (nextPlan) await saveNutritionPlan(date, nextPlan);
    if (nextPlan) await persistDayState(date, { nutrition_plan: nextPlan });
  }, [persistDayState]);

  const handleRestoreMeal = useCallback(async (date: string, mealType: string) => {
    let nextPlan: DailyNutritionPlan | null = null;
    setNutritionPlansByDate(prev => {
      const current = prev[date];
      if (!current) return prev;
      const removed = (current.removedMeals ?? []).filter(m => m !== mealType);
      nextPlan = { ...current, removedMeals: removed };
      return { ...prev, [date]: nextPlan as DailyNutritionPlan };
    });
    if (nextPlan) await saveNutritionPlan(date, nextPlan);
    if (nextPlan) await persistDayState(date, { nutrition_plan: nextPlan });
  }, [persistDayState]);


  const handleSkipToday = useCallback(async (focus: string) => {
    Alert.alert(
      'Skip Today?',
      'This will mark today as skipped. The workout will be available again tomorrow.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Skip',
          style: 'destructive',
          onPress: async () => {
            const today = todayKey();
            setSkippedDates(prev => new Set([...prev, today]));
            await persistDayState(today, { skipped_focus: focus });
          },
        },
      ]
    );
  }, [persistDayState]);

  const handleUnskipDay = useCallback(async (date: string) => {
    setSkippedDates(prev => {
      const next = new Set(prev);
      next.delete(date);
      return next;
    });
    await persistDayState(date, { skipped_focus: null });
  }, [persistDayState]);

  const openExerciseVideo = useCallback(async (exerciseName: string) => {
    try {
      await Linking.openURL(getExerciseVideoUrl(exerciseName));
    } catch {
      Alert.alert('Could not open video', 'There was a problem opening the exercise video link.');
    }
  }, []);

  if (!userProfile || !workoutPlan) return <View style={styles.container} />;

  const goalLabel = meta.goals.find(g => g.value === userProfile.goal)?.label ?? userProfile.goal;
  const schedule  = workoutPlan?.days?.length ? get7DaySchedule(workoutPlan, userProfile.daysPerWeek) : [];
  const mealDays = getNextMealDays(7);

  const isLightTheme = ['sunrise', 'arctic', 'rose'].includes(userProfile.themePreference ?? 'midnight');
  const statusBarStyle = isLightTheme ? 'dark' : 'light';

  // Subtle gradient: slightly lighter at top, fades to base background
  const gradientColors: [string, string, string] = isLightTheme
    ? [themeColors.surfaceRaised, themeColors.background, themeColors.background]
    : [themeColors.surfaceRaised, themeColors.background, themeColors.background];

  return (
    <LinearGradient colors={gradientColors} style={styles.container} locations={[0, 0.4, 1]}>
      <StatusBar style={statusBarStyle} />

      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 6, backgroundColor: themeColors.surfaceRaised, borderBottomColor: themeColors.border }]}>
        <Image
          source={require('../../assets/images/Apple dumbbell logo with _MAKROS_ text.png')}
          style={styles.headerLogo}
          resizeMode="contain"
        />
        <View style={{ flex: 1 }} />
        <TouchableOpacity style={styles.menuBtn} onPress={() => setMenuOpen(true)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <View style={[styles.menuBar, { backgroundColor: themeColors.textPrimary }]} />
          <View style={[styles.menuBar, { backgroundColor: themeColors.textPrimary }]} />
          <View style={[styles.menuBar, { backgroundColor: themeColors.textPrimary }]} />
        </TouchableOpacity>
      </View>

      {/* AI plan updating — full overlay, hides stale plans */}
      {isPlanUpdating ? (
        <View style={[styles.planLoadingOverlay, { backgroundColor: themeColors.background }]}>
          <ActivityIndicator size="large" color={themeColors.primary} />
          <Text style={[styles.planLoadingTitle, { color: themeColors.textPrimary }]}>Building your new plan</Text>
          <Text style={[styles.planLoadingSubtitle, { color: themeColors.textSecondary }]}>
            AI is generating a personalized workout and meal plan based on your settings…
          </Text>
        </View>
      ) : null}

      {/* Tab toggle — pill style */}
      {!isPlanUpdating && <View style={[styles.tabs, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'workout' && [styles.tabActive, { backgroundColor: workoutPalette.strong }]]}
          onPress={() => setActiveTab('workout')}
          activeOpacity={0.8}>
          <Text style={[styles.tabText, { color: activeTab === 'workout' ? '#FFFFFF' : themeColors.textMuted }]}>
            Workout{workoutUpdateSummary ? '  •' : ''}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'meals' && [styles.tabActive, { backgroundColor: mealPalette.strong }]]}
          onPress={() => setActiveTab('meals')}
          activeOpacity={0.8}>
          <Text style={[styles.tabText, { color: activeTab === 'meals' ? '#FFFFFF' : themeColors.textMuted }]}>
            Meals{nutritionUpdateSummary ? '  •' : ''}
          </Text>
        </TouchableOpacity>
      </View>}

      {/* Tab content */}
      {!isPlanUpdating && <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {activeTab === 'workout' ? (
          <>
            {(availabilityItems.length > 0 || cardioProfile) && (
              <View style={[styles.insightCard, { borderColor: plannerPalette.strong + '55', backgroundColor: plannerPalette.soft }] }>
                <Text style={[styles.insightTitle, { color: themeColors.textPrimary }]}>Available Muscle/Cardio Focus</Text>
                {cardioProfile ? <Text style={[styles.insightSubtitle, { color: themeColors.textSecondary }]}>{cardioProfile}</Text> : null}
                <View style={styles.insightChips}>
                  {availabilityItems.map(item => (
                    <View key={item.label} style={[styles.insightChip, { borderColor: plannerPalette.strong + '55', backgroundColor: themeColors.surfaceRaised }]}>
                      <Text style={[styles.insightChipText, { color: plannerPalette.text }]}>{item.label} {item.pct}%</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}
            {schedule.map((item, i) => {
              const key = dateKey(item.date);
              const isToday     = i === 0;
              const isCompleted = isToday && todayDone;
              const isSkipped   = skippedDates.has(key);
              return (
                <DayCard
                  key={i}
                  item={item}
                  themeName={userProfile.themePreference}
                  isToday={isToday}
                  isCompleted={isCompleted}
                  isSkipped={isSkipped}
                  expanded={expandedDay === i}
                  onPress={() => setExpandedDay(expandedDay === i ? -1 : i)}
                  onStartWorkout={onStartWorkout}
                  onSkip={handleSkipToday}
                  onUnskip={() => handleUnskipDay(key)}
                />
              );
            })}
          </>
        ) : (
          <>
            {mealDays.map((d, idx) => {
              const plan = nutritionPlansByDate[d.key];
              if (!plan) return null;
              const isExpanded = expandedMealDays.has(d.key);
              const meals = [plan.breakfast, plan.lunch, plan.dinner, plan.snack].filter(Boolean) as MealSuggestion[];
              const totalCalories = meals.reduce((sum, m) => sum + (m.calories ?? 0), 0);
              return (
                <View key={d.key} style={[styles.mealAccordionCard, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
                  <TouchableOpacity
                    style={[styles.mealAccordionHeader, { backgroundColor: mealPalette.soft }]}
                    onPress={() => setExpandedMealDays(prev => {
                      const next = new Set(prev);
                      if (next.has(d.key)) next.delete(d.key); else next.add(d.key);
                      return next;
                    })}
                    activeOpacity={0.8}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.mealAccordionTitle, { color: themeColors.textPrimary }]}>{mealDayLabel(d.date, idx)}</Text>
                      <Text style={[styles.mealAccordionMeta, { color: themeColors.textSecondary }]}>{Math.round(totalCalories)} cal total</Text>
                    </View>
                    <Text style={[styles.mealAccordionChevron, { color: themeColors.textMuted }]}>{isExpanded ? '▲' : '▼'}</Text>
                  </TouchableOpacity>

                  {isExpanded && (
                    <NutritionCard
                      themeName={userProfile.themePreference}
                      nutritionPlan={plan}
                      checkedMeals={checkedMealsByDate[d.key] ?? {}}
                      onToggleMeal={(mealType) => handleToggleMeal(d.key, mealType)}
                      onEditMeal={(mealType, meal) => setEditingMeal({ dateKey: d.key, type: mealType, meal })}
                      onAddSnack={() => handleAddSnack(d.key)}
                      onRemoveMeal={(mealType) => handleRemoveMeal(d.key, mealType)}
                      onRestoreMeal={(mealType) => handleRestoreMeal(d.key, mealType)}
                    />
                  )}
                </View>
              );
            })}
          </>
        )}
      </ScrollView>}

      {/* Meal edit modal */}
      {editingMeal && nutritionPlansByDate[editingMeal.dateKey] && (
        <MealEditModal
          visible={!!editingMeal}
          mealType={editingMeal.type}
          meal={editingMeal.meal}
          nutritionPlan={nutritionPlansByDate[editingMeal.dateKey]}
          allFoods={meta.allFoods}
          foodCategories={meta.foodCategories}
          savedMeals={userProfile.savedMeals ?? []}
          authToken={authToken}
          onSave={(updated) => handleMealSave(editingMeal.dateKey, editingMeal.type, updated)}
          onClose={() => setEditingMeal(null)}
        />
      )}

      {/* Settings modal */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setMenuOpen(false)}>
          <View style={[styles.menuDropdown, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
            <View style={[styles.menuHeadingRow, { borderBottomColor: themeColors.border }]}>
              <Text style={[styles.menuHeading, { color: themeColors.textMuted }]}>MENU</Text>
            </View>
            {[
              { label: 'Account',          onPress: onViewAccount },
              { label: 'View Progress',    onPress: onViewProgress },
              { label: 'Exercise Library', onPress: openExerciseLibrary },
              { label: 'Edit Plan',        onPress: onEditProfile },
              { label: 'Equipment',        onPress: onEditEquipment },
              { label: 'Food Options',     onPress: onEditFoods },
              { label: 'Themes',           onPress: onEditThemes },
            ].map((item, idx, arr) => (
              <View key={item.label}>
                <TouchableOpacity style={styles.menuItem} onPress={() => { setMenuOpen(false); item.onPress(); }}>
                  <Text style={[styles.menuItemText, { color: themeColors.textPrimary }]}>{item.label}</Text>
                  <Text style={[styles.menuItemChevron, { color: themeColors.textMuted }]}>›</Text>
                </TouchableOpacity>
                {idx < arr.length - 1 && <View style={[styles.menuDivider, { backgroundColor: themeColors.border }]} />}
              </View>
            ))}
            <View style={[styles.menuDivider, { backgroundColor: themeColors.border }]} />
            <TouchableOpacity style={styles.menuItem} onPress={() => { setMenuOpen(false); onSignOut(); }}>
              <Text style={[styles.menuItemText, { color: themeColors.error }]}>Sign Out</Text>
              <Text style={[styles.menuItemChevron, { color: themeColors.error + '80' }]}>›</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal visible={showExerciseLibrary} transparent animationType="slide" onRequestClose={() => setShowExerciseLibrary(false)}>
        <View style={styles.libraryBackdrop}>
          <View style={styles.librarySheet}>
            <View style={styles.libraryHeader}>
              <Text style={styles.libraryTitle}>{selectedExercise ? selectedExercise.name : 'Exercise Library'}</Text>
              <TouchableOpacity onPress={() => {
                if (selectedExercise) {
                  setSelectedExercise(null);
                  return;
                }
                setShowExerciseLibrary(false);
              }}>
                <Text style={styles.libraryClose}>Close</Text>
              </TouchableOpacity>
            </View>

            {exerciseLibraryLoading ? (
              <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />
            ) : selectedExercise ? (
              <ScrollView contentContainerStyle={styles.detailContent}>
                {(() => {
                  const guide = buildExerciseGuide(selectedExercise);
                  return (
                    <>
                      <View style={styles.detailTopCard}>
                        <Text style={styles.detailMeta}>Primary: {humanizeToken(selectedExercise.primary_muscle)}</Text>
                        {selectedExercise.secondary_muscles?.length ? (
                          <Text style={styles.detailMeta}>Also hits: {selectedExercise.secondary_muscles.map(humanizeToken).join(', ')}</Text>
                        ) : null}
                        {selectedExercise.equipment ? <Text style={styles.detailMeta}>Equipment: {humanizeToken(selectedExercise.equipment)}</Text> : null}
                        <TouchableOpacity style={styles.detailVideoBtn} onPress={() => openExerciseVideo(selectedExercise.name)}>
                          <Text style={styles.detailVideoBtnText}>Watch Form Video</Text>
                        </TouchableOpacity>
                      </View>

                      <View style={styles.detailSection}>
                        <Text style={styles.detailSectionTitle}>How To Perform It</Text>
                        <Text style={styles.detailSectionText}>{guide.howTo}</Text>
                      </View>

                      <View style={styles.detailSection}>
                        <Text style={styles.detailSectionTitle}>Setup</Text>
                        <Text style={styles.detailSectionText}>{guide.setup}</Text>
                      </View>

                      <View style={styles.detailSection}>
                        <Text style={styles.detailSectionTitle}>Movement Cue</Text>
                        <Text style={styles.detailSectionText}>{guide.movement}</Text>
                      </View>

                      <View style={styles.detailSection}>
                        <Text style={styles.detailSectionTitle}>What It Hits</Text>
                        <Text style={styles.detailSectionText}>{guide.hits}</Text>
                      </View>

                      <View style={styles.detailSection}>
                        <Text style={styles.detailSectionTitle}>Why It Hits That</Text>
                        <Text style={styles.detailSectionText}>{guide.why}</Text>
                      </View>

                      <View style={styles.detailSection}>
                        <Text style={styles.detailSectionTitle}>How It Should Feel</Text>
                        <Text style={styles.detailSectionText}>{guide.feel}</Text>
                      </View>

                      <View style={styles.detailSection}>
                        <Text style={styles.detailSectionTitle}>Common Mistake</Text>
                        <Text style={styles.detailSectionText}>{guide.mistake}</Text>
                      </View>
                    </>
                  );
                })()}
              </ScrollView>
            ) : (
              <ScrollView contentContainerStyle={styles.libraryList}>
                <TextInput
                  value={exerciseSearch}
                  onChangeText={setExerciseSearch}
                  placeholder="Search exercises, muscles, or equipment"
                  placeholderTextColor={colors.textMuted}
                  style={styles.librarySearchInput}
                />

                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.libraryFilterRow}>
                  <TouchableOpacity
                    style={[styles.libraryFilterChip, exerciseMuscleFilter === 'all' && styles.libraryFilterChipActive]}
                    onPress={() => setExerciseMuscleFilter('all')}>
                    <Text style={[styles.libraryFilterText, exerciseMuscleFilter === 'all' && styles.libraryFilterTextActive]}>All Muscles</Text>
                  </TouchableOpacity>
                  {exerciseMuscleOptions.map((muscle) => (
                    <TouchableOpacity
                      key={muscle}
                      style={[styles.libraryFilterChip, exerciseMuscleFilter === muscle && styles.libraryFilterChipActive]}
                      onPress={() => setExerciseMuscleFilter(muscle)}>
                      <Text style={[styles.libraryFilterText, exerciseMuscleFilter === muscle && styles.libraryFilterTextActive]}>{humanizeToken(muscle)}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>

                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.libraryFilterRow}>
                  <TouchableOpacity
                    style={[styles.libraryFilterChip, exerciseEquipmentFilter === 'all' && styles.libraryFilterChipActive]}
                    onPress={() => setExerciseEquipmentFilter('all')}>
                    <Text style={[styles.libraryFilterText, exerciseEquipmentFilter === 'all' && styles.libraryFilterTextActive]}>All Equipment</Text>
                  </TouchableOpacity>
                  {exerciseEquipmentOptions.map((equipment) => (
                    <TouchableOpacity
                      key={equipment}
                      style={[styles.libraryFilterChip, exerciseEquipmentFilter === equipment && styles.libraryFilterChipActive]}
                      onPress={() => setExerciseEquipmentFilter(equipment)}>
                      <Text style={[styles.libraryFilterText, exerciseEquipmentFilter === equipment && styles.libraryFilterTextActive]}>{humanizeToken(equipment)}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>

                {filteredExerciseLibrary.length === 0 ? (
                  <Text style={styles.libraryEmptyText}>No exercises match the current search and filters.</Text>
                ) : filteredExerciseLibrary.map((ex) => (
                  <TouchableOpacity key={String(ex.id ?? ex.name)} style={styles.libraryItem} activeOpacity={0.8} onPress={() => setSelectedExercise(ex)}>
                    <Text style={styles.libraryItemName}>{ex.name}</Text>
                    <Text style={styles.libraryItemMeta}>
                      {String(ex.primary_muscle ?? '').replace(/_/g, ' ')}
                      {Array.isArray(ex.secondary_muscles) && ex.secondary_muscles.length ? ` · ${ex.secondary_muscles.join(', ')}` : ''}
                    </Text>
                    {ex.description ? <Text style={styles.libraryItemDesc}>{ex.description}</Text> : null}
                    <Text style={styles.libraryItemLink}>Tap for form guide</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      <Modal visible={showTrainerModal} animationType="slide" transparent onRequestClose={() => setShowTrainerModal(false)}>
        <KeyboardAvoidingView
          style={styles.trainerFullScreen}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
        >
          <View style={styles.trainerSheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.libraryHeader}>
              <Text style={styles.libraryTitle}>AI Coach</Text>
              <TouchableOpacity onPress={() => setShowTrainerModal(false)}>
                <Text style={styles.libraryClose}>Close</Text>
              </TouchableOpacity>
            </View>

            {/* Mode picker */}
            <View style={[styles.coachModePicker, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]}>
              <TouchableOpacity
                style={[styles.coachModeBtn, coachMode === 'trainer' && { backgroundColor: workoutPalette.strong }]}
                onPress={() => setCoachMode('trainer')}
                activeOpacity={0.8}>
                <Text style={[styles.coachModeBtnText, { color: coachMode === 'trainer' ? '#FFFFFF' : themeColors.textSecondary }]}>
                  Workout Plan
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.coachModeBtn, coachMode === 'nutritionist' && { backgroundColor: mealPalette.strong }]}
                onPress={() => setCoachMode('nutritionist')}
                activeOpacity={0.8}>
                <Text style={[styles.coachModeBtnText, { color: coachMode === 'nutritionist' ? '#FFFFFF' : themeColors.textSecondary }]}>
                  Meal Plan
                </Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.trainerHint}>
              {coachMode === 'nutritionist'
                ? 'Your full meal plan is loaded. Say things like "swap my lunch for something lighter" or "I had a shake this morning — update breakfast." Changes apply immediately.'
                : 'Your full workout plan is loaded. Say things like "remove squats, my knee hurts" or "add more back work." Changes apply immediately.'}
            </Text>

            {(coachMode === 'trainer' ? workoutUpdateSummary : nutritionUpdateSummary) && (
              <View style={styles.trainerSummaryCard}>
                <Text style={styles.trainerSummaryTitle}>{coachMode === 'nutritionist' ? 'Meal Plan Updated' : 'Workout Plan Updated'}</Text>
                <Text style={styles.trainerSummaryText}>{coachMode === 'trainer' ? workoutUpdateSummary : nutritionUpdateSummary}</Text>
              </View>
            )}

            <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.trainerChatList} keyboardShouldPersistTaps="handled">
              {(coachMode === 'trainer' ? workoutChat : nutritionChat).length === 0 ? (
                <Text style={styles.trainerEmpty}>
                  {coachMode === 'nutritionist'
                    ? 'Try: "Replace dinner with a high-protein option under 500 calories."'
                    : 'Try: "My shoulder hurts on pressing — can you swap the bench press for something safer?"'}
                </Text>
              ) : (
                (coachMode === 'trainer' ? workoutChat : nutritionChat).map((m, idx) => (
                  <View key={idx} style={[styles.trainerBubble, m.role === 'user' ? styles.trainerBubbleUser : styles.trainerBubbleAssistant]}>
                    <Text style={styles.trainerBubbleText}>{m.content}</Text>
                  </View>
                ))
              )}
              {trainerLoading && (
                <View style={[styles.trainerBubble, styles.trainerBubbleAssistant]}>
                  <ActivityIndicator size="small" color={colors.primary} />
                  <Text style={[styles.trainerBubbleText, { color: colors.textMuted, marginTop: 4, fontSize: 12 }]}>Thinking…</Text>
                </View>
              )}
            </ScrollView>

            {attachedImage && (
              <View style={styles.attachPreviewRow}>
                <Image source={{ uri: attachedImage.uri }} style={styles.attachPreview} />
                <TouchableOpacity onPress={() => setAttachedImage(null)} style={styles.attachRemoveBtn}>
                  <Text style={styles.attachRemoveText}>✕</Text>
                </TouchableOpacity>
                <Text style={styles.attachLabel}>Photo attached</Text>
              </View>
            )}
            <View style={styles.trainerInputRow}>
              <TouchableOpacity
                style={styles.trainerAttachBtn}
                onPress={async () => {
                  Alert.alert('Attach Photo', 'Add a photo to your message', [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Camera', onPress: async () => {
                        const perm = await ImagePicker.requestCameraPermissionsAsync();
                        if (!perm.granted) return;
                        const res = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.6, mediaTypes: ['images'] as any });
                        if (!res.canceled && res.assets?.[0]?.base64) {
                          setAttachedImage({ base64: res.assets[0].base64!, uri: res.assets[0].uri });
                        }
                      },
                    },
                    {
                      text: 'Photo Library', onPress: async () => {
                        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
                        if (!perm.granted) return;
                        const res = await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.6, mediaTypes: ['images'] as any });
                        if (!res.canceled && res.assets?.[0]?.base64) {
                          setAttachedImage({ base64: res.assets[0].base64!, uri: res.assets[0].uri });
                        }
                      },
                    },
                  ]);
                }}>
                <Text style={styles.trainerAttachIcon}>📷</Text>
              </TouchableOpacity>
              <TextInput
                value={trainerInput}
                onChangeText={setTrainerInput}
                placeholder={coachMode === 'nutritionist' ? 'Ask nutritionist...' : 'Ask trainer...'}
                placeholderTextColor={colors.textMuted}
                style={styles.trainerInput}
                multiline
              />
              <TouchableOpacity style={styles.trainerSendBtn} onPress={handleAskTrainer} disabled={trainerLoading}>
                {trainerLoading ? <ActivityIndicator size="small" color={colors.background} /> : <Text style={styles.trainerSendText}>Send</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Floating AI chat button */}

      <TouchableOpacity
        style={[styles.fab, { backgroundColor: themeColors.primary }]}
        onPress={() => setShowTrainerModal(true)}
        activeOpacity={0.85}>
        <Image
          source={require('../../assets/images/Brain and speech bubble icon white.png')}
          style={styles.fabIcon}
          resizeMode="contain"
        />
      </TouchableOpacity>
    </LinearGradient>
  );
}

function DayCard({ item, themeName, isToday, isCompleted, isSkipped, expanded, onPress, onStartWorkout, onSkip, onUnskip }: {
  item: ScheduleItem;
  themeName?: import('../types').AppThemeName;
  isToday: boolean;
  isCompleted: boolean;
  isSkipped: boolean;
  expanded: boolean;
  onPress: () => void;
  onStartWorkout: (workout: WorkoutDay) => void;
  onSkip: (focus: string) => void;
  onUnskip: () => void;
}) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const workoutPalette = theme.sections.workout;
  const dow     = isToday ? 'Today' : DAY_NAMES[item.date.getDay()];
  const dateStr = `${MONTH_NAMES[item.date.getMonth()]} ${item.date.getDate()}`;

  // Rest day
  if (item.isRest) {
    return (
      <View style={[styles.dayCard, { backgroundColor: tc.surface, borderColor: tc.border }, isToday && { borderColor: tc.primary, borderLeftColor: tc.primary }]}>
        <View style={styles.dayCardRow}>
          <View style={styles.dayCardLeft}>
            <Text style={[styles.dayCardDow, { color: isToday ? tc.primary : tc.textSecondary }]}>{dow}</Text>
            <Text style={[styles.dayCardDate, { color: tc.textMuted }]}>{dateStr}</Text>
          </View>
          <View style={[styles.restBadge, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}>
            <Text style={[styles.restBadgeText, { color: tc.textSecondary }]}>Rest Day</Text>
          </View>
        </View>
        <Text style={[styles.restHint, { color: tc.textMuted }]}>Recovery & light stretching</Text>
      </View>
    );
  }

  // Skipped day
  if (isSkipped) {
    return (
      <View style={[styles.dayCard, { backgroundColor: tc.surface, borderColor: tc.border }, isToday && { borderColor: tc.primary, borderLeftColor: tc.primary }, styles.dayCardSkipped]}>
        <View style={styles.dayCardRow}>
          <View style={styles.dayCardLeft}>
            <Text style={[styles.dayCardDow, { color: isToday ? tc.primary : tc.textSecondary }]}>{dow}</Text>
            <Text style={[styles.dayCardDate, { color: tc.textMuted }]}>{dateStr}</Text>
          </View>
          <View style={styles.dayCardRight}>
            <Text style={[styles.focusLabel, { color: tc.textPrimary }]}>{item.workout!.focus}</Text>
          </View>
          <View style={[styles.skippedBadge, { backgroundColor: tc.warning + '22', borderColor: tc.warning }]}>
            <Text style={[styles.skippedBadgeText, { color: tc.warning }]}>Skipped</Text>
          </View>
        </View>
        <Text style={[styles.skippedHint, { color: tc.textMuted }]}>You can restore this workout if you skipped it by mistake.</Text>
        <View style={styles.actionRow}>
          <TouchableOpacity style={[styles.unskipBtn, { backgroundColor: tc.surface, borderColor: tc.primary }]} onPress={onUnskip}>
            <Text style={[styles.unskipBtnText, { color: tc.primary }]}>Unskip Workout</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <TouchableOpacity
      style={[
        styles.dayCard,
        { backgroundColor: tc.surface, borderColor: tc.border },
        isToday && { borderColor: tc.primary, borderLeftColor: tc.primary },
        isCompleted && { borderColor: tc.success, borderLeftColor: tc.success },
      ]}
      onPress={onPress}
      activeOpacity={0.8}>
      <View style={styles.dayCardRow}>
        <View style={styles.dayCardLeft}>
          <Text style={[styles.dayCardDow, { color: isToday ? tc.primary : tc.textSecondary }]}>{dow}</Text>
          <Text style={[styles.dayCardDate, { color: tc.textMuted }]}>{dateStr}</Text>
        </View>
        <View style={styles.dayCardRight}>
          <Text style={[styles.focusLabel, { color: tc.textPrimary }]}>{item.workout!.focus}</Text>
          {(() => {
            const muscles = Array.from(new Set(
              item.workout!.exercises.map(ex => inferGroup(`${item.workout!.focus} ${ex.name}`))
            )).filter(g => g !== 'Other').slice(0, 3);
            const countText = `${item.workout!.exercises.length} exercises`;
            const muscleText = muscles.length ? ` · ${muscles.join(', ')}` : '';
            return (
              <Text style={[styles.exerciseCount, { color: tc.textMuted }]} numberOfLines={1}>
                {countText}{muscleText}
              </Text>
            );
          })()}
        </View>
        {isCompleted ? (
          <View style={[styles.completeBadge, { backgroundColor: tc.success + '22', borderColor: tc.success }]}>
            <Text style={[styles.completeBadgeText, { color: tc.success }]}>✓ Done</Text>
          </View>
        ) : (
          <Text style={[styles.chevron, { color: tc.textMuted }]}>{expanded ? '▲' : '▼'}</Text>
        )}
      </View>

      {expanded && (
        <View style={styles.expandedContent}>
          {isCompleted ? (
            <View style={[styles.completedBanner, { backgroundColor: tc.success + '1A', borderColor: tc.success }]}>
              <Text style={[styles.completedBannerText, { color: tc.success }]}>Workout completed today!</Text>
            </View>
          ) : (
            <>
              <View style={[styles.actionRow, { marginBottom: 14 }]}>
                <TouchableOpacity
                  style={[styles.startWorkoutBtn, { backgroundColor: workoutPalette.strong }]}
                  onPress={() => onStartWorkout(item.workout!)}>
                  <Text style={styles.startWorkoutBtnText}>▶  Start Workout</Text>
                </TouchableOpacity>
              </View>
              <WorkoutCard workout={item.workout!} themeName={themeName} />
              {isToday && (
                <TouchableOpacity style={styles.skipLink} onPress={() => onSkip(item.workout!.focus)}>
                  <Text style={[styles.skipLinkText, { color: tc.textMuted }]}>Skip today's workout</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8, borderBottomWidth: 1 },
  headerLogo: { width: 130, height: 130 * 0.44 },
  greeting:            { fontSize: 26, fontWeight: '700', color: colors.textPrimary, marginBottom: 6 },
  headerBadgeRow:  { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 4 },
  goalBadge:       { backgroundColor: colors.surface, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 4, borderWidth: 1, borderColor: colors.primary },
  goalBadgeText:   { fontSize: 12, color: colors.primary, fontWeight: '600' },
  goalSubText:     { fontSize: 11, color: colors.textSecondary, marginTop: 2 },
  planLoadingOverlay: {
    flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, paddingHorizontal: 40,
  },
  planLoadingTitle:    { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  planLoadingSubtitle: { fontSize: 14, textAlign: 'center', lineHeight: 22, opacity: 0.7 },

  fab: {
    position: 'absolute',
    bottom: 28,
    right: 20,
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 8,
  },
  fabIcon: { width: 38, height: 38 },

  coachModePicker: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginBottom: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: 3,
    gap: 3,
  },
  coachModeBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  coachModeBtnText: { fontSize: 13, fontWeight: '700' },

  menuBtn: { padding: 4, gap: 5, alignItems: 'center', justifyContent: 'center' },
  menuBar: { width: 22, height: 2, backgroundColor: colors.textPrimary, borderRadius: 2 },

  aiBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginBottom: 10, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  aiText:   { fontSize: 12, color: colors.textSecondary, flex: 1 },

  compactNotesRow: { flexDirection: 'row', gap: 8, marginBottom: 12, flexWrap: 'wrap' },
  compactNoteChip: {
    backgroundColor: colors.surface,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  compactNoteText: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },

  insightCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 12,
    marginBottom: 12,
    gap: 8,
  },
  insightTitle: { fontSize: 13, fontWeight: '700', color: colors.textPrimary },
  insightSubtitle: { fontSize: 12, color: colors.textSecondary },
  insightChips: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  insightChip: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.full,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  insightChipText: { fontSize: 12, color: colors.primary, fontWeight: '700' },

  askTrainerBtn: {
    alignSelf: 'flex-start',
    marginBottom: 12,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  askTrainerBtnText: { color: colors.background, fontSize: 13, fontWeight: '700' },

  warmupCard: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 14,
    marginBottom: 12,
    gap: 8,
  },
  warmupTitle: { fontSize: 14, fontWeight: '800' },
  warmupStep: { fontSize: 12, color: colors.textPrimary, lineHeight: 18 },

  tabs:      { flexDirection: 'row', marginHorizontal: 16, marginBottom: 14, borderRadius: radius.full, padding: 3, borderWidth: 1, borderColor: colors.border },
  tab:       { flex: 1, paddingVertical: 11, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center' },
  tabActive: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4, elevation: 3 },
  tabText:   { fontSize: 14, fontWeight: '700', letterSpacing: 0.2 },

  scrollView:    { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 40 },

  dayCard:          { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 14, marginBottom: 10 },
  dayCardToday:     { borderColor: colors.primary, borderLeftWidth: 3, borderLeftColor: colors.primary },
  dayCardComplete:  { borderColor: colors.success, borderLeftWidth: 3, borderLeftColor: colors.success },
  dayCardSkipped:   { opacity: 0.6 },
  dayCardRow:       { flexDirection: 'row', alignItems: 'center' },
  dayCardLeft:      { width: 64 },
  dayCardRight:     { flex: 1 },
  dayCardDow:       { fontSize: 13, fontWeight: '700', color: colors.textSecondary, marginBottom: 2 },
  dayCardDowToday:  { color: colors.primary },
  dayCardDate:      { fontSize: 11, color: colors.textMuted },

  focusLabel:    { fontSize: 14, fontWeight: '600', color: colors.textPrimary, marginBottom: 2 },
  exerciseCount: { fontSize: 12, color: colors.textMuted },
  chevron:       { fontSize: 10, color: colors.textMuted, marginLeft: 8 },

  completeBadge:     { backgroundColor: colors.success + '22', borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: colors.success },
  completeBadgeText: { fontSize: 12, color: colors.success, fontWeight: '700' },

  skippedBadge:     { backgroundColor: colors.warning + '22', borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: colors.warning },
  skippedBadgeText: { fontSize: 12, color: colors.warning, fontWeight: '600' },
  skippedHint:      { fontSize: 12, color: colors.textMuted, marginTop: 10 },

  restBadge:     { backgroundColor: colors.surfaceRaised, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 4, borderWidth: 1, borderColor: colors.border },
  restBadgeText: { fontSize: 12, color: colors.textSecondary, fontWeight: '500' },
  restHint:      { fontSize: 12, color: colors.textMuted, marginTop: 8 },

  expandedContent: { marginTop: 12 },

  completedBanner:     { backgroundColor: colors.success + '1A', borderRadius: radius.md, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: colors.success },
  completedBannerText: { fontSize: 14, fontWeight: '700', color: colors.success },

  actionRow:       { flexDirection: 'row', gap: 10, marginTop: 12 },
  skipLink:        { alignSelf: 'center', paddingVertical: 8, paddingHorizontal: 4 },
  skipLinkText:    { fontSize: 12, fontWeight: '400', textDecorationLine: 'underline' },
  unskipBtn:       { backgroundColor: colors.surface, borderRadius: radius.md, paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center', borderWidth: 1, borderColor: colors.primary, flex: 1 },
  unskipBtnText:   { color: colors.primary, fontSize: 13, fontWeight: '700' },
  startWorkoutBtn: { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', flex: 1 },
  startWorkoutBtnText: { color: colors.background, fontSize: 15, fontWeight: '700', letterSpacing: 0.3 },

  exerciseSummaryList:   { gap: 8 },
  exerciseSummaryRow:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  exerciseSummaryName:   { fontSize: 13, color: colors.textPrimary, fontWeight: '500', flex: 1 },
  exerciseSummaryDetail: { fontSize: 12, color: colors.primary, fontWeight: '600' },

  mealAccordionCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 10,
    overflow: 'hidden',
  },
  mealAccordionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.surface,
  },
  mealAccordionTitle: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  mealAccordionMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  mealAccordionChevron: { fontSize: 11, color: colors.textMuted, marginLeft: 8 },

  groceryCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    marginBottom: 10,
  },
  groceryTitle: { fontSize: 13, fontWeight: '700', color: colors.textPrimary, marginBottom: 8 },
  groceryChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  groceryChip: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  groceryChipText: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-start', alignItems: 'flex-end', paddingTop: 90, paddingRight: 16 },
  menuDropdown:   { backgroundColor: colors.surface, borderRadius: radius.xl, minWidth: 220, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  menuHeadingRow: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  menuHeading:    { fontSize: 10, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1.2 },
  menuItem:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 },
  menuItemText:    { flex: 1, fontSize: 15, fontWeight: '500', color: colors.textPrimary },
  menuItemChevron: { fontSize: 18, fontWeight: '300' },
  menuDivider:    { height: 1, backgroundColor: colors.border, marginHorizontal: 0 },

  libraryBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  librarySheet: {
    maxHeight: '78%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 14,
  },
  libraryHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 10 },
  libraryTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  libraryClose: { fontSize: 14, fontWeight: '700', color: colors.primary },
  libraryList: { paddingHorizontal: 16, paddingBottom: 28 },
  librarySearchInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.background,
    color: colors.textPrimary,
    marginBottom: 10,
  },
  libraryFilterRow: { gap: 8, paddingBottom: 10 },
  libraryFilterChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  libraryFilterChipActive: { borderColor: colors.primary, backgroundColor: colors.primary + '12' },
  libraryFilterText: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },
  libraryFilterTextActive: { color: colors.primary },
  libraryEmptyText: {
    fontSize: 13,
    color: colors.textMuted,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 12,
    marginTop: 4,
  },
  libraryItem: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 12,
    marginBottom: 8,
  },
  libraryItemName: { fontSize: 14, fontWeight: '700', color: colors.textPrimary, marginBottom: 4 },
  libraryItemMeta: { fontSize: 12, color: colors.primary, marginBottom: 4 },
  libraryItemDesc: { fontSize: 12, color: colors.textSecondary },
  libraryItemLink: { fontSize: 12, color: colors.accent, fontWeight: '700', marginTop: 8 },

  detailSheet: {
    maxHeight: '82%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 14,
  },
  detailContent: { paddingHorizontal: 16, paddingBottom: 28, gap: 10 },
  detailTopCard: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    gap: 4,
  },
  detailMeta: { fontSize: 12, color: colors.textSecondary },
  detailVideoBtn: {
    alignSelf: 'flex-start',
    marginTop: 6,
    backgroundColor: colors.primary + '18',
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.full,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  detailVideoBtnText: { fontSize: 12, color: colors.primary, fontWeight: '700' },
  detailSection: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
  },
  detailSectionTitle: { fontSize: 13, fontWeight: '700', color: colors.textPrimary, marginBottom: 6 },
  detailSectionText: { fontSize: 13, lineHeight: 20, color: colors.textSecondary },

  trainerFullScreen: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' },
  trainerSheet: {
    height: '85%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 16,
    paddingBottom: 12,
  },
  sheetHandle: { width: 36, height: 4, backgroundColor: colors.border, borderRadius: 2, alignSelf: 'center', marginBottom: 12 },
  trainerHint: {
    fontSize: 12,
    color: colors.textSecondary,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  trainerSummaryCard: {
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
  },
  trainerSummaryTitle: { fontSize: 11, color: colors.textSecondary, fontWeight: '700', marginBottom: 4, textTransform: 'uppercase' },
  trainerSummaryText: { fontSize: 12, color: colors.textPrimary },
  trainerChatList: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 8,
  },
  trainerEmpty: {
    fontSize: 12,
    color: colors.textMuted,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 10,
  },
  trainerBubble: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: 10,
  },
  trainerBubbleUser: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
    alignSelf: 'flex-end',
    maxWidth: '90%',
  },
  trainerBubbleAssistant: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    alignSelf: 'flex-start',
    maxWidth: '95%',
  },
  trainerBubbleText: { fontSize: 13, color: colors.textPrimary },
  attachPreviewRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  attachPreview: { width: 48, height: 48, borderRadius: 8, backgroundColor: colors.border },
  attachRemoveBtn: { padding: 4 },
  attachRemoveText: { fontSize: 13, color: colors.textMuted, fontWeight: '700' },
  attachLabel: { fontSize: 12, color: colors.textSecondary, fontStyle: 'italic' },
  trainerAttachBtn: { paddingHorizontal: 6, paddingBottom: 10, justifyContent: 'flex-end' },
  trainerAttachIcon: { fontSize: 20 },
  trainerInputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  trainerInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 10,
    paddingVertical: 8,
    maxHeight: 120,
    color: colors.textPrimary,
    backgroundColor: colors.background,
  },
  trainerSendBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    minWidth: 64,
    paddingVertical: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trainerSendText: { color: colors.background, fontSize: 13, fontWeight: '700' },
});
