import { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Modal, ActivityIndicator, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { UserProfile, WorkoutPlan, DailyNutritionPlan, WorkoutDay } from '../types';
import { generateWorkoutPlan, generateDailyNutrition } from '../utils/planGenerator';
import { getGoalEstimate } from '../utils/goalEstimate';
import { getAIPlans, getWorkoutStatus } from '../services/api';
import { useMetaData } from '../hooks/useMetaData';
import {
  isTodayWorkoutDone, getSkippedDays, addSkippedDay,
  todayKey, dateKey, SkippedDay,
} from '../utils/workoutHistory';
import { getMealChecks, saveMealChecks, MealChecks } from '../utils/mealTracker';
import { MealSuggestion } from '../types';
import WorkoutCard from '../components/WorkoutCard';
import NutritionCard from '../components/NutritionCard';
import MealEditModal from '../components/MealEditModal';
import { colors, radius } from '../constants/theme';

interface HomeScreenProps {
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
});

// ─────────────────────────────────────────────────────────────────────────────

export default function HomeScreen({ userProfile, onSignOut, onEditProfile, onStartWorkout, onViewProgress, onViewAccount }: HomeScreenProps) {
  const meta = useMetaData();

  const [workoutPlan, setWorkoutPlan]     = useState<WorkoutPlan | null>(null);
  const [nutritionPlan, setNutritionPlan] = useState<DailyNutritionPlan | null>(null);
  const [activeTab, setActiveTab]         = useState<'workout' | 'meals'>('workout');
  const [menuOpen, setMenuOpen]           = useState(false);
  const [expandedDay, setExpandedDay]     = useState<number>(0);
  const [aiLoading, setAiLoading]         = useState(false);
  const [aiSource, setAiSource]           = useState<'ai' | 'local'>('local');

  // Completion + skip state
  const [todayDone, setTodayDone]         = useState(false);
  const [skippedDates, setSkippedDates]   = useState<Set<string>>(new Set());

  // Meal tracking
  const [checkedMeals, setCheckedMeals]   = useState<MealChecks>({});
  const [editingMeal, setEditingMeal]     = useState<{ type: string; meal: MealSuggestion } | null>(null);

  useEffect(() => {
    if (userProfile) loadPlans(userProfile);
    loadDayStatus();
  }, [userProfile]);

  const loadDayStatus = async () => {
    const today = todayKey();
    const [skipped, checks] = await Promise.all([
      getSkippedDays(),
      getMealChecks(today),
    ]);
    setSkippedDates(new Set(skipped.map(s => s.date)));
    setCheckedMeals(checks);

    // Check workout completion from backend DB (not AsyncStorage)
    try {
      const token = await AsyncStorage.getItem('authToken');
      if (token) {
        const status = await getWorkoutStatus(token, today);
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
    // Show local plan immediately while AI loads
    setWorkoutPlan(generateWorkoutPlan(profile));
    setNutritionPlan(generateDailyNutrition(profile, meta.allFoods));
    setAiSource('local');

    const token = await AsyncStorage.getItem('authToken');
    if (!token) return;
    setAiLoading(true);
    try {
      const plans = await getAIPlans(token, profile);
      setWorkoutPlan(plans.workout_plan);
      setNutritionPlan(plans.nutrition_plan);
      setAiSource('ai');
    } catch { /* keep local fallback */ } finally {
      setAiLoading(false);
    }
  };

  const handleToggleMeal = useCallback(async (mealType: string) => {
    const today = todayKey();
    const next = { ...checkedMeals, [mealType]: !checkedMeals[mealType] };
    setCheckedMeals(next);
    await saveMealChecks(today, next);
  }, [checkedMeals]);

  const handleMealSave = useCallback((mealType: string, updated: MealSuggestion) => {
    if (!nutritionPlan) return;
    const next: DailyNutritionPlan = { ...nutritionPlan, [mealType]: updated };
    setNutritionPlan(next);
  }, [nutritionPlan]);

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
            await addSkippedDay(today, focus);
            setSkippedDates(prev => new Set([...prev, today]));
          },
        },
      ]
    );
  }, []);

  if (!userProfile || !workoutPlan || !nutritionPlan) return <View style={styles.container} />;

  const goalLabel = meta.goals.find(g => g.value === userProfile.goal)?.label ?? userProfile.goal;
  const schedule  = get7DaySchedule(workoutPlan, userProfile.daysPerWeek);
  const { targets } = nutritionPlan;
  const todaySkipped = skippedDates.has(todayKey());

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

      {/* AI status */}
      {aiLoading && (
        <View style={styles.aiBanner}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={styles.aiText}>Generating your personalised plan with AI…</Text>
        </View>
      )}
      {!aiLoading && aiSource === 'ai' && (
        <View style={styles.aiBanner}>
          <Text style={styles.aiText}>✨  Plan generated by AI</Text>
        </View>
      )}

      {/* Stats row */}
      <View style={styles.statsRow}>
        <StatBox label="Training Days" value={`${userProfile.daysPerWeek}/wk`} />
        <StatBox label="Calories"      value={String(targets.calories)} />
        <StatBox label="Protein"       value={`${targets.protein}g`} />
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
          schedule.map((item, i) => {
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
              />
            );
          })
        ) : (
          <NutritionCard
            nutritionPlan={nutritionPlan}
            checkedMeals={checkedMeals}
            onToggleMeal={handleToggleMeal}
            onEditMeal={(mealType, meal) => setEditingMeal({ type: mealType, meal })}
          />
        )}
      </ScrollView>

      {/* Meal edit modal */}
      {editingMeal && nutritionPlan && (
        <MealEditModal
          visible={!!editingMeal}
          mealType={editingMeal.type}
          meal={editingMeal.meal}
          nutritionPlan={nutritionPlan}
          allFoods={meta.allFoods}
          foodCategories={meta.foodCategories}
          onSave={(updated) => handleMealSave(editingMeal.type, updated)}
          onClose={() => setEditingMeal(null)}
        />
      )}

      {/* Settings modal */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setMenuOpen(false)}>
          <View style={styles.menuDropdown}>
            <Text style={styles.menuHeading}>Settings</Text>
            <TouchableOpacity style={styles.menuItem} onPress={() => { setMenuOpen(false); onViewAccount(); }}>
              <Text style={styles.menuItemIcon}>👤</Text>
              <Text style={styles.menuItemText}>Account</Text>
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <TouchableOpacity style={styles.menuItem} onPress={() => { setMenuOpen(false); onViewProgress(); }}>
              <Text style={styles.menuItemIcon}>📊</Text>
              <Text style={styles.menuItemText}>View Progress</Text>
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <TouchableOpacity style={styles.menuItem} onPress={() => { setMenuOpen(false); onEditProfile(); }}>
              <Text style={styles.menuItemIcon}>✏️</Text>
              <Text style={styles.menuItemText}>Edit Profile</Text>
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <TouchableOpacity style={styles.menuItem} onPress={() => { setMenuOpen(false); onSignOut(); }}>
              <Text style={styles.menuItemIcon}>🚪</Text>
              <Text style={[styles.menuItemText, { color: colors.error }]}>Sign Out</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statBox}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function DayCard({ item, isToday, isCompleted, isSkipped, expanded, onPress, onStartWorkout, onSkip }: {
  item: ScheduleItem;
  isToday: boolean;
  isCompleted: boolean;
  isSkipped: boolean;
  expanded: boolean;
  onPress: () => void;
  onStartWorkout: (workout: WorkoutDay) => void;
  onSkip: (focus: string) => void;
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

  statsRow:  { flexDirection: 'row', gap: 10, marginHorizontal: 16, marginBottom: 12 },
  statBox:   { flex: 1, backgroundColor: colors.surface, borderRadius: radius.md, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: colors.border },
  statValue: { fontSize: 18, fontWeight: '700', color: colors.primary, marginBottom: 2 },
  statLabel: { fontSize: 11, color: colors.textSecondary },

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

  restBadge:     { backgroundColor: colors.surfaceRaised, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 4, borderWidth: 1, borderColor: colors.border },
  restBadgeText: { fontSize: 12, color: colors.textSecondary, fontWeight: '500' },
  restHint:      { fontSize: 12, color: colors.textMuted, marginTop: 8 },

  expandedContent: { marginTop: 12 },

  completedBanner:     { backgroundColor: colors.success + '1A', borderRadius: radius.md, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: colors.success },
  completedBannerText: { fontSize: 14, fontWeight: '700', color: colors.success },

  actionRow:       { flexDirection: 'row', gap: 10, marginTop: 12 },
  skipBtn:         { backgroundColor: colors.surface, borderRadius: radius.md, paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center', borderWidth: 1, borderColor: colors.warning },
  skipBtnText:     { color: colors.warning, fontSize: 13, fontWeight: '700' },
  startWorkoutBtn: { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', flex: 1 },
  startWorkoutBtnText: { color: colors.background, fontSize: 15, fontWeight: '700', letterSpacing: 0.3 },

  exerciseSummaryList:   { gap: 8 },
  exerciseSummaryRow:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  exerciseSummaryName:   { fontSize: 13, color: colors.textPrimary, fontWeight: '500', flex: 1 },
  exerciseSummaryDetail: { fontSize: 12, color: colors.primary, fontWeight: '600' },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-start', alignItems: 'flex-end', paddingTop: 90, paddingRight: 16 },
  menuDropdown:  { backgroundColor: colors.surface, borderRadius: radius.lg, minWidth: 200, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  menuHeading:   { fontSize: 11, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.8, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10 },
  menuItem:      { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  menuItemIcon:  { fontSize: 18 },
  menuItemText:  { fontSize: 15, fontWeight: '500', color: colors.textPrimary },
  menuDivider:   { height: 1, backgroundColor: colors.border, marginHorizontal: 16 },
});
