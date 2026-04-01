import { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Modal, ActivityIndicator, Alert, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { UserProfile, WorkoutPlan, DailyNutritionPlan, WorkoutDay } from '../types';
import { generateWorkoutPlan, generateDailyNutritionForDate } from '../utils/planGenerator';
import { getGoalEstimate } from '../utils/goalEstimate';
import { getWorkoutStatus, getDayState, upsertDayState, getGroceryList, getExercises, askTrainerQuestion } from '../services/api';
import { useMetaData } from '../hooks/useMetaData';
import {
  isTodayWorkoutDone, todayKey, dateKey, loadWorkoutHistory,
} from '../utils/workoutHistory';
import { getMealChecks, saveMealChecks, MealChecks, getSavedNutritionPlan, saveNutritionPlan } from '../utils/mealTracker';
import { MealSuggestion } from '../types';
import WorkoutCard from '../components/WorkoutCard';
import NutritionCard from '../components/NutritionCard';
import MealEditModal from '../components/MealEditModal';
import { colors, radius } from '../constants/theme';

interface HomeScreenProps {
  authToken: string;
  userProfile: UserProfile | null;
  onSignOut: () => void;
  onEditProfile: () => void;
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
  };
}

// ── Goal progress banner ───────────────────────────────────────────────────────

function GoalProgressBanner({ userProfile, goalLabel, goalConfig }: {
  userProfile: UserProfile;
  goalLabel: string;
  goalConfig: import('../hooks/useMetaData').GoalConfig;
}) {
  const estimate = getGoalEstimate(userProfile, goalConfig);
  if (!estimate) return null;

  const { goal, goalDetails, physicalStats } = userProfile;
  const isWeightGoal   = new Set(goalConfig.weight_goals).has(goal);
  const isTimelineGoal = new Set(goalConfig.timeline_goals).has(goal);

  let progressPct = 0;
  let leftLabel = '', rightLabel = '', midLabel = '';
  let weightSummary: { start: number; current: number; remaining: number } | null = null;

  if (isWeightGoal && goalDetails.targetWeightLbs) {
    const start   = goalDetails.startWeightLbs ?? physicalStats.weightLbs;
    const current = physicalStats.weightLbs;
    const target  = goalDetails.targetWeightLbs;
    const total   = Math.abs(start - target);
    const done    = Math.abs(start - current);
    progressPct   = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
    leftLabel     = `${start} lbs`;
    rightLabel    = `${target} lbs`;
    midLabel      = `${current} lbs now`;
    weightSummary = {
      start,
      current,
      remaining: Math.abs(current - target),
    };
  } else if (isTimelineGoal && goalDetails.timelineWeeks) {
    const startDate    = goalDetails.goalStartedAt ? new Date(goalDetails.goalStartedAt) : new Date();
    const weeksElapsed = Math.max(0, (Date.now() - startDate.getTime()) / (7 * 24 * 60 * 60 * 1000));
    progressPct = Math.min(1, weeksElapsed / goalDetails.timelineWeeks);
    leftLabel   = 'Week 0';
    rightLabel  = `Week ${goalDetails.timelineWeeks}`;
    midLabel    = `Week ${Math.round(weeksElapsed)}`;
  } else {
    leftLabel  = 'Start';
    rightLabel = estimate.label;
  }

  const pctDisplay = Math.round(progressPct * 100);

  return (
    <View style={bs.banner}>
      <View style={bs.topRow}>
        <Text style={bs.icon}>🎯</Text>
        <View style={{ flex: 1 }}>
          <Text style={bs.goalName}>{goalLabel}</Text>
          <Text style={bs.targetDate}>
            {estimate.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            {'  ·  '}{estimate.label}
          </Text>
        </View>
        <View style={bs.pctBadge}>
          <Text style={bs.pctText}>{pctDisplay}%</Text>
        </View>
      </View>
      <View style={bs.meterWrap}>
        <View style={bs.meterTrack}>
          <View style={[bs.meterFill, { width: `${pctDisplay}%` as any }]} />
          {progressPct > 0 && progressPct < 1 && (
            <View style={[bs.meterDot, { left: `${pctDisplay}%` as any }]} />
          )}
        </View>
        <View style={bs.meterLabels}>
          <Text style={bs.meterLabel}>{leftLabel}</Text>
          {midLabel ? <Text style={bs.meterLabelMid}>{midLabel}</Text> : null}
          <Text style={bs.meterLabel}>{rightLabel}</Text>
        </View>
      </View>

      {weightSummary && (
        <View style={bs.quickRow}>
          <View style={bs.quickStat}>
            <Text style={bs.quickLabel}>Initial</Text>
            <Text style={bs.quickValue}>{weightSummary.start} lbs</Text>
          </View>
          <View style={bs.quickStat}>
            <Text style={bs.quickLabel}>Current</Text>
            <Text style={bs.quickValue}>{weightSummary.current} lbs</Text>
          </View>
          <View style={bs.quickStat}>
            <Text style={bs.quickLabel}>Remaining</Text>
            <Text style={bs.quickValue}>{weightSummary.remaining.toFixed(1)} lbs</Text>
          </View>
        </View>
      )}
    </View>
  );
}

const bs = StyleSheet.create({
  banner:       { marginHorizontal: 16, marginBottom: 12, backgroundColor: colors.surface, borderRadius: radius.md, padding: 14, borderWidth: 1, borderColor: colors.border, borderLeftWidth: 3, borderLeftColor: colors.accent, gap: 12 },
  topRow:       { flexDirection: 'row', alignItems: 'center', gap: 10 },
  icon:         { fontSize: 20 },
  goalName:     { fontSize: 14, fontWeight: '700', color: colors.textPrimary, marginBottom: 1 },
  targetDate:   { fontSize: 11, color: colors.textSecondary },
  pctBadge:     { backgroundColor: colors.accent + '22', borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: colors.accent },
  pctText:      { fontSize: 13, fontWeight: '800', color: colors.accent },
  meterWrap:    { gap: 6 },
  meterTrack:   { height: 8, backgroundColor: colors.border, borderRadius: 4, overflow: 'visible' },
  meterFill:    { height: 8, backgroundColor: colors.accent, borderRadius: 4 },
  meterDot:     { position: 'absolute', top: -4, width: 16, height: 16, borderRadius: 8, backgroundColor: colors.accent, marginLeft: -8, borderWidth: 2, borderColor: colors.background },
  meterLabels:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  meterLabel:   { fontSize: 10, color: colors.textMuted, fontWeight: '500' },
  meterLabelMid:{ fontSize: 10, color: colors.accent, fontWeight: '700' },
  quickRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 2,
  },
  quickStat: {
    flex: 1,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  quickLabel: { fontSize: 10, color: colors.textSecondary, marginBottom: 1 },
  quickValue: { fontSize: 12, fontWeight: '700', color: colors.textPrimary },
});

// ─────────────────────────────────────────────────────────────────────────────

export default function HomeScreen({ authToken, userProfile, onSignOut, onEditProfile, onStartWorkout, onViewProgress, onViewAccount }: HomeScreenProps) {
  const meta = useMetaData();

  const [workoutPlan, setWorkoutPlan]     = useState<WorkoutPlan | null>(null);
  const [nutritionPlansByDate, setNutritionPlansByDate] = useState<Record<string, DailyNutritionPlan>>({});
  const [activeTab, setActiveTab]         = useState<'workout' | 'meals'>('workout');
  const [menuOpen, setMenuOpen]           = useState(false);
  const [expandedDay, setExpandedDay]     = useState<number>(0);
  const [showExerciseLibrary, setShowExerciseLibrary] = useState(false);
  const [exerciseLibraryLoading, setExerciseLibraryLoading] = useState(false);
  const [exerciseLibrary, setExerciseLibrary] = useState<ExerciseLibraryItem[]>([]);
  const [selectedExercise, setSelectedExercise] = useState<ExerciseLibraryItem | null>(null);
  const [showTrainerModal, setShowTrainerModal] = useState(false);
  const [trainerInput, setTrainerInput] = useState('');
  const [trainerLoading, setTrainerLoading] = useState(false);
  const [trainerChat, setTrainerChat] = useState<TrainerChatMessage[]>([]);
  const [trainerUpdateSummary, setTrainerUpdateSummary] = useState<string | null>(null);

  // Completion + skip state
  const [todayDone, setTodayDone]         = useState(false);
  const [skippedDates, setSkippedDates]   = useState<Set<string>>(new Set());

  // Meal tracking
  const [checkedMealsByDate, setCheckedMealsByDate] = useState<Record<string, MealChecks>>({});
  const [editingMeal, setEditingMeal] = useState<{ dateKey: string; type: string; meal: MealSuggestion } | null>(null);
  const [currentDate, setCurrentDate] = useState(todayKey());
  const [expandedMealDays, setExpandedMealDays] = useState<Set<string>>(new Set([todayKey()]));
  const [groceryPreview, setGroceryPreview] = useState<Array<{ food: string; frequency: number }>>([]);

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
  }, [userProfile, authToken, meta.allFoods.length]);

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
    const mealDays = getNextMealDays(3);
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
    // Use local/backend persisted plan by default; AI refresh is user-triggered.
    const baseWorkout = generateWorkoutPlan(profile);
    setWorkoutPlan(baseWorkout);
    const mealDays = getNextMealDays(3);
    const localEntries = await Promise.all(
      mealDays.map(async d => {
        if (authToken) {
          const remote = await getDayState(authToken, d.key).catch(() => null) as any;
          if (remote?.nutrition_plan) return [d.key, remote.nutrition_plan as DailyNutritionPlan] as const;
        }
        const saved = await getSavedNutritionPlan(d.key);
        return [d.key, saved ?? generateDailyNutritionForDate(profile, meta.allFoods, d.key)] as const;
      })
    );
    setNutritionPlansByDate(Object.fromEntries(localEntries));

    if (authToken) {
      try {
        const grocery = await getGroceryList(authToken, 3);
        setGroceryPreview(grocery.items.slice(0, 8));
      } catch {
        setGroceryPreview([]);
      }
    } else {
      setGroceryPreview([]);
    }
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

  const summarizeTrainerUpdate = useCallback((
    prevWorkout: WorkoutPlan,
    nextWorkout: WorkoutPlan | null,
    prevNutrition: DailyNutritionPlan | null,
    nextNutrition: DailyNutritionPlan | null,
  ): string => {
    const notes: string[] = [];

    if (nextWorkout) {
      const prevDays = prevWorkout.days.length;
      const nextDays = nextWorkout.days.length;
      if (prevDays !== nextDays) notes.push(`Workout days: ${prevDays} → ${nextDays}`);

      const prevExercises = prevWorkout.days.reduce((sum, d) => sum + d.exercises.length, 0);
      const nextExercises = nextWorkout.days.reduce((sum, d) => sum + d.exercises.length, 0);
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

    const userMsg: TrainerChatMessage = { role: 'user', content: q };
    const nextChat = [...trainerChat, userMsg];
    setTrainerChat(nextChat);
    setTrainerInput('');
    setTrainerLoading(true);

    try {
      const todayPlan = nutritionPlansByDate[todayKey()] ?? null;
      const workoutHistory = await loadWorkoutHistory();
      const recentHistory = workoutHistory.slice(0, 40).map((s) => ({
        date: s.date,
        focus: s.focus,
        durationSeconds: s.durationSeconds,
        completed: s.completed,
        exercises: s.exercises.map((ex) => ({
          name: ex.name,
          targetSets: ex.targetSets,
          targetReps: ex.targetReps,
          targetRestSeconds: ex.targetRestSeconds,
          setsLogged: ex.sets.length,
          bestSet: ex.sets.reduce<{ weightLbs: number; reps: number } | null>((best, set) => {
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
        (sum, s) => sum + s.exercises.reduce((setSum, ex) => setSum + ex.sets.length, 0),
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

      const resp = await askTrainerQuestion(authToken, {
        question: q,
        profile: userProfile,
        workoutPlan,
        nutritionPlan: todayPlan,
        progress,
        conversation: nextChat.slice(-12),
      });

      const actionLines = (resp.action_items ?? []).slice(0, 4).map((x: string) => `• ${x}`).join('\n');
      const combined = [
        resp.answer,
        actionLines ? `\n${actionLines}` : '',
        resp.safety_note ? `\nSafety: ${resp.safety_note}` : '',
      ].join('');

      setTrainerChat(prev => [...prev, { role: 'assistant', content: combined }]);

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
        setTrainerUpdateSummary(summarizeTrainerUpdate(prevWorkout, nextWorkout, todayPlan, nextNutrition));
        setTrainerChat(prev => [...prev, { role: 'assistant', content: 'I applied those trainer updates to your current plan.' }]);
      }
    } catch (e: any) {
      setTrainerChat(prev => [...prev, { role: 'assistant', content: `Could not answer right now. ${e?.message ?? ''}` }]);
    } finally {
      setTrainerLoading(false);
    }
  }, [trainerInput, authToken, userProfile, workoutPlan, nutritionPlansByDate, todayDone, skippedDates, trainerChat, persistDayState]);

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
      nextPlan = { ...current, [mealType]: updated } as DailyNutritionPlan;
      return { ...prev, [date]: nextPlan as DailyNutritionPlan };
    });
    if (nextPlan) await saveNutritionPlan(date, nextPlan);
    if (nextPlan) await persistDayState(date, { nutrition_plan: nextPlan });
  }, [persistDayState]);

  const handleAddSnack = useCallback(async (date: string) => {
    let nextPlan: DailyNutritionPlan | null = null;
    setNutritionPlansByDate(prev => {
      const current = prev[date];
      if (!current || current.snack) return prev;
      nextPlan = {
        ...current,
        snack: {
          meal: 'Snack',
          foods: ['Greek yogurt', 'Banana'],
          calories: 220,
          protein: 15,
          carbs: 28,
          fat: 4,
        },
      };
      return { ...prev, [date]: nextPlan as DailyNutritionPlan };
    });
    if (nextPlan) await saveNutritionPlan(date, nextPlan);
    if (nextPlan) await persistDayState(date, { nutrition_plan: nextPlan });
  }, [persistDayState]);

  const handleRemoveMeal = useCallback(async (date: string, mealType: string) => {
    let nextPlan: DailyNutritionPlan | null = null;
    setNutritionPlansByDate(prev => {
      const current = prev[date];
      if (!current) return prev;
      const removed = new Set(current.removedMeals ?? []);
      removed.add(mealType);
      nextPlan = { ...current, removedMeals: Array.from(removed) };
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

  if (!userProfile || !workoutPlan) return <View style={styles.container} />;

  const goalLabel = meta.goals.find(g => g.value === userProfile.goal)?.label ?? userProfile.goal;
  const schedule  = get7DaySchedule(workoutPlan, userProfile.daysPerWeek);
  const mealDays = getNextMealDays(3);
  return (
    <View style={styles.container}>

      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>Today's Plan</Text>
          <View style={styles.goalBadge}>
            <Text style={styles.goalBadgeText}>{goalLabel}</Text>
          </View>
        </View>
        <TouchableOpacity style={styles.menuBtn} onPress={() => setMenuOpen(true)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <View style={styles.menuBar} /><View style={styles.menuBar} /><View style={styles.menuBar} />
        </TouchableOpacity>
      </View>

      {/* Goal progress banner */}
      <GoalProgressBanner userProfile={userProfile} goalLabel={goalLabel} goalConfig={meta.goalConfig} />

      {/* Tabs */}
      <View style={styles.tabs}>
        <TouchableOpacity style={[styles.tab, activeTab === 'workout' && styles.tabActive]} onPress={() => setActiveTab('workout')}>
          <Text style={[styles.tabText, activeTab === 'workout' && styles.tabTextActive]}>Workout</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.tab, activeTab === 'meals' && styles.tabActive]} onPress={() => setActiveTab('meals')}>
          <Text style={[styles.tabText, activeTab === 'meals' && styles.tabTextActive]}>Meals</Text>
        </TouchableOpacity>
      </View>

      {/* Tab content */}
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {activeTab === 'workout' ? (
          <>
            <View style={styles.compactNotesRow}>
              <View style={styles.compactNoteChip}>
                <Text style={styles.compactNoteText}>{userProfile.daysPerWeek} days a week</Text>
              </View>
              <View style={styles.compactNoteChip}>
                <Text style={styles.compactNoteText}>{userProfile.workoutDurationMinutes} min sessions</Text>
              </View>
              <View style={styles.compactNoteChip}>
                <Text style={styles.compactNoteText}>
                  Rest {Math.round((schedule[0]?.workout?.exercises?.reduce((sum, ex) => sum + (ex.restSeconds || 0), 0) || 60) /
                    Math.max(1, schedule[0]?.workout?.exercises?.length || 1))}s avg
                </Text>
              </View>
            </View>
            <TouchableOpacity style={styles.askTrainerBtn} onPress={() => setShowTrainerModal(true)}>
              <Text style={styles.askTrainerBtnText}>Ask Trainer</Text>
            </TouchableOpacity>
            {schedule.map((item, i) => {
              const key = dateKey(item.date);
              const isToday     = i === 0;
              const isCompleted = isToday && todayDone;
              const isSkipped   = skippedDates.has(key);
              return (
                <DayCard
                  key={i}
                  item={item}
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
            {groceryPreview.length > 0 && (
              <View style={styles.groceryCard}>
                <Text style={styles.groceryTitle}>3-Day Grocery Preview</Text>
                <View style={styles.groceryChips}>
                  {groceryPreview.map(item => (
                    <View key={item.food} style={styles.groceryChip}>
                      <Text style={styles.groceryChipText}>{item.food} x{item.frequency}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {mealDays.map((d, idx) => {
              const plan = nutritionPlansByDate[d.key];
              if (!plan) return null;
              const isExpanded = expandedMealDays.has(d.key);
              const meals = [plan.breakfast, plan.lunch, plan.dinner, plan.snack].filter(Boolean) as MealSuggestion[];
              const totalCalories = meals.reduce((sum, m) => sum + (m.calories ?? 0), 0);
              return (
                <View key={d.key} style={styles.mealAccordionCard}>
                  <TouchableOpacity
                    style={styles.mealAccordionHeader}
                    onPress={() => setExpandedMealDays(prev => {
                      const next = new Set(prev);
                      if (next.has(d.key)) next.delete(d.key); else next.add(d.key);
                      return next;
                    })}
                    activeOpacity={0.8}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.mealAccordionTitle}>{mealDayLabel(d.date, idx)}</Text>
                      <Text style={styles.mealAccordionMeta}>{Math.round(totalCalories)} cal total</Text>
                    </View>
                    <Text style={styles.mealAccordionChevron}>{isExpanded ? '▲' : '▼'}</Text>
                  </TouchableOpacity>

                  {isExpanded && (
                    <NutritionCard
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
      </ScrollView>

      {/* Meal edit modal */}
      {editingMeal && nutritionPlansByDate[editingMeal.dateKey] && (
        <MealEditModal
          visible={!!editingMeal}
          mealType={editingMeal.type}
          meal={editingMeal.meal}
          nutritionPlan={nutritionPlansByDate[editingMeal.dateKey]}
          allFoods={meta.allFoods}
          foodCategories={meta.foodCategories}
          onSave={(updated) => handleMealSave(editingMeal.dateKey, editingMeal.type, updated)}
          onClose={() => setEditingMeal(null)}
        />
      )}

      {/* Settings modal */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setMenuOpen(false)}>
          <View style={styles.menuDropdown}>
            <Text style={styles.menuHeading}>Settings</Text>
            <TouchableOpacity style={styles.menuItem} onPress={() => { setMenuOpen(false); onViewAccount(); }}>
              <Text style={styles.menuItemText}>Account</Text>
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <TouchableOpacity style={styles.menuItem} onPress={() => { setMenuOpen(false); onViewProgress(); }}>
              <Text style={styles.menuItemText}>View Progress</Text>
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <TouchableOpacity style={styles.menuItem} onPress={() => { setMenuOpen(false); openExerciseLibrary(); }}>
              <Text style={styles.menuItemText}>Exercise Library</Text>
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <TouchableOpacity style={styles.menuItem} onPress={() => { setMenuOpen(false); onEditProfile(); }}>
              <Text style={styles.menuItemText}>Edit Plan</Text>
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <TouchableOpacity style={styles.menuItem} onPress={() => { setMenuOpen(false); onSignOut(); }}>
              <Text style={[styles.menuItemText, { color: colors.error }]}>Sign Out</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal visible={showExerciseLibrary} transparent animationType="slide" onRequestClose={() => setShowExerciseLibrary(false)}>
        <View style={styles.libraryBackdrop}>
          <View style={styles.librarySheet}>
            <View style={styles.libraryHeader}>
              <Text style={styles.libraryTitle}>Exercise Library</Text>
              <TouchableOpacity onPress={() => setShowExerciseLibrary(false)}>
                <Text style={styles.libraryClose}>Close</Text>
              </TouchableOpacity>
            </View>

            {exerciseLibraryLoading ? (
              <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />
            ) : (
              <ScrollView contentContainerStyle={styles.libraryList}>
                {exerciseLibrary.map((ex) => (
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

      <Modal visible={!!selectedExercise} transparent animationType="slide" onRequestClose={() => setSelectedExercise(null)}>
        <View style={styles.libraryBackdrop}>
          <View style={styles.detailSheet}>
            <View style={styles.libraryHeader}>
              <Text style={styles.libraryTitle}>{selectedExercise?.name ?? 'Exercise'}</Text>
              <TouchableOpacity onPress={() => setSelectedExercise(null)}>
                <Text style={styles.libraryClose}>Close</Text>
              </TouchableOpacity>
            </View>

            {selectedExercise && (() => {
              const guide = buildExerciseGuide(selectedExercise);
              return (
                <ScrollView contentContainerStyle={styles.detailContent}>
                  <View style={styles.detailTopCard}>
                    <Text style={styles.detailMeta}>Primary: {humanizeToken(selectedExercise.primary_muscle)}</Text>
                    {selectedExercise.secondary_muscles?.length ? (
                      <Text style={styles.detailMeta}>Also hits: {selectedExercise.secondary_muscles.map(humanizeToken).join(', ')}</Text>
                    ) : null}
                    {selectedExercise.equipment ? <Text style={styles.detailMeta}>Equipment: {humanizeToken(selectedExercise.equipment)}</Text> : null}
                  </View>

                  <View style={styles.detailSection}>
                    <Text style={styles.detailSectionTitle}>How To Perform It</Text>
                    <Text style={styles.detailSectionText}>{guide.howTo}</Text>
                  </View>

                  <View style={styles.detailSection}>
                    <Text style={styles.detailSectionTitle}>What It Hits</Text>
                    <Text style={styles.detailSectionText}>{guide.hits}</Text>
                  </View>

                  <View style={styles.detailSection}>
                    <Text style={styles.detailSectionTitle}>Why It Hits That</Text>
                    <Text style={styles.detailSectionText}>{guide.why}</Text>
                  </View>
                </ScrollView>
              );
            })()}
          </View>
        </View>
      </Modal>

      <Modal visible={showTrainerModal} transparent animationType="slide" onRequestClose={() => setShowTrainerModal(false)}>
        <KeyboardAvoidingView
          style={styles.libraryBackdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 24 : 0}
        >
          <View style={styles.trainerSheet}>
            <View style={styles.libraryHeader}>
              <Text style={styles.libraryTitle}>Ask Trainer</Text>
              <TouchableOpacity onPress={() => setShowTrainerModal(false)}>
                <Text style={styles.libraryClose}>Close</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.trainerHint}>Ask about progress stalls, pain, substitutions, or plan changes.</Text>

            {trainerUpdateSummary && (
              <View style={styles.trainerSummaryCard}>
                <Text style={styles.trainerSummaryTitle}>Latest Applied Changes</Text>
                <Text style={styles.trainerSummaryText}>{trainerUpdateSummary}</Text>
              </View>
            )}

            <ScrollView contentContainerStyle={styles.trainerChatList} keyboardShouldPersistTaps="handled">
              {trainerChat.length === 0 ? (
                <Text style={styles.trainerEmpty}>Example: "My elbow hurts on pressing. Can you modify my upper day?"</Text>
              ) : (
                trainerChat.map((m, idx) => (
                  <View key={idx} style={[styles.trainerBubble, m.role === 'user' ? styles.trainerBubbleUser : styles.trainerBubbleAssistant]}>
                    <Text style={styles.trainerBubbleText}>{m.content}</Text>
                  </View>
                ))
              )}
            </ScrollView>

            <View style={styles.trainerInputRow}>
              <TextInput
                value={trainerInput}
                onChangeText={setTrainerInput}
                placeholder="Ask trainer..."
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
    </View>
  );
}

function DayCard({ item, isToday, isCompleted, isSkipped, expanded, onPress, onStartWorkout, onSkip, onUnskip }: {
  item: ScheduleItem;
  isToday: boolean;
  isCompleted: boolean;
  isSkipped: boolean;
  expanded: boolean;
  onPress: () => void;
  onStartWorkout: (workout: WorkoutDay) => void;
  onSkip: (focus: string) => void;
  onUnskip: () => void;
}) {
  const dow     = isToday ? 'Today' : DAY_NAMES[item.date.getDay()];
  const dateStr = `${MONTH_NAMES[item.date.getMonth()]} ${item.date.getDate()}`;

  // Rest day
  if (item.isRest) {
    return (
      <View style={[styles.dayCard, isToday && styles.dayCardToday]}>
        <View style={styles.dayCardRow}>
          <View style={styles.dayCardLeft}>
            <Text style={[styles.dayCardDow, isToday && styles.dayCardDowToday]}>{dow}</Text>
            <Text style={styles.dayCardDate}>{dateStr}</Text>
          </View>
          <View style={styles.restBadge}>
            <Text style={styles.restBadgeText}>Rest Day</Text>
          </View>
        </View>
        <Text style={styles.restHint}>Recovery & light stretching</Text>
      </View>
    );
  }

  // Skipped day
  if (isSkipped) {
    return (
      <View style={[styles.dayCard, isToday && styles.dayCardToday, styles.dayCardSkipped]}>
        <View style={styles.dayCardRow}>
          <View style={styles.dayCardLeft}>
            <Text style={[styles.dayCardDow, isToday && styles.dayCardDowToday]}>{dow}</Text>
            <Text style={styles.dayCardDate}>{dateStr}</Text>
          </View>
          <View style={styles.dayCardRight}>
            <Text style={styles.focusLabel}>{item.workout!.focus}</Text>
          </View>
          <View style={styles.skippedBadge}>
            <Text style={styles.skippedBadgeText}>Skipped</Text>
          </View>
        </View>
        <Text style={styles.skippedHint}>You can restore this workout if you skipped it by mistake.</Text>
        <View style={styles.actionRow}>
          <TouchableOpacity style={styles.unskipBtn} onPress={onUnskip}>
            <Text style={styles.unskipBtnText}>Unskip Workout</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <TouchableOpacity
      style={[styles.dayCard, isToday && styles.dayCardToday, isCompleted && styles.dayCardComplete]}
      onPress={onPress}
      activeOpacity={0.8}>
      <View style={styles.dayCardRow}>
        <View style={styles.dayCardLeft}>
          <Text style={[styles.dayCardDow, isToday && styles.dayCardDowToday]}>{dow}</Text>
          <Text style={styles.dayCardDate}>{dateStr}</Text>
        </View>
        <View style={styles.dayCardRight}>
          <Text style={styles.focusLabel}>{item.workout!.focus}</Text>
          <Text style={styles.exerciseCount}>{item.workout!.exercises.length} exercises</Text>
        </View>
        {isCompleted ? (
          <View style={styles.completeBadge}>
            <Text style={styles.completeBadgeText}>✓ Done</Text>
          </View>
        ) : (
          <Text style={styles.chevron}>{expanded ? '▲' : '▼'}</Text>
        )}
      </View>

      {expanded && (
        <View style={styles.expandedContent}>
          {isCompleted ? (
            <View style={styles.completedBanner}>
              <Text style={styles.completedBannerText}>Workout completed today!</Text>
            </View>
          ) : (
            <>
              <WorkoutCard workout={item.workout!} />
              <View style={styles.actionRow}>
                {isToday && (
                  <TouchableOpacity
                    style={styles.skipBtn}
                    onPress={() => onSkip(item.workout!.focus)}>
                    <Text style={styles.skipBtnText}>Skip Today</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={[styles.startWorkoutBtn, isToday && { flex: 1 }]}
                  onPress={() => onStartWorkout(item.workout!)}>
                  <Text style={styles.startWorkoutBtnText}>▶  Start Workout</Text>
                </TouchableOpacity>
              </View>
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

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 56, paddingBottom: 12 },
  greeting:      { fontSize: 26, fontWeight: '700', color: colors.textPrimary, marginBottom: 6 },
  goalBadge:     { alignSelf: 'flex-start', backgroundColor: colors.surface, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 4, borderWidth: 1, borderColor: colors.primary },
  goalBadgeText: { fontSize: 12, color: colors.primary, fontWeight: '600' },

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

  askTrainerBtn: {
    alignSelf: 'flex-start',
    marginBottom: 12,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  askTrainerBtnText: { color: colors.background, fontSize: 13, fontWeight: '700' },

  tabs:          { flexDirection: 'row', marginHorizontal: 16, marginBottom: 12, backgroundColor: colors.surface, borderRadius: radius.md, padding: 4, borderWidth: 1, borderColor: colors.border },
  tab:           { flex: 1, paddingVertical: 10, borderRadius: radius.sm, alignItems: 'center' },
  tabActive:     { backgroundColor: colors.primary },
  tabText:       { fontSize: 14, fontWeight: '600', color: colors.textSecondary },
  tabTextActive: { color: colors.background },

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
  skipBtn:         { backgroundColor: colors.surface, borderRadius: radius.md, paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center', borderWidth: 1, borderColor: colors.warning },
  skipBtnText:     { color: colors.warning, fontSize: 13, fontWeight: '700' },
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
  menuDropdown:  { backgroundColor: colors.surface, borderRadius: radius.lg, minWidth: 200, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  menuHeading:   { fontSize: 11, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.8, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10 },
  menuItem:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 },
  menuItemText:  { fontSize: 15, fontWeight: '500', color: colors.textPrimary },
  menuDivider:   { height: 1, backgroundColor: colors.border, marginHorizontal: 16 },

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
  detailSection: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
  },
  detailSectionTitle: { fontSize: 13, fontWeight: '700', color: colors.textPrimary, marginBottom: 6 },
  detailSectionText: { fontSize: 13, lineHeight: 20, color: colors.textSecondary },

  trainerSheet: {
    maxHeight: '86%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 14,
    paddingBottom: 12,
  },
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
