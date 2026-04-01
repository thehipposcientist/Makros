import { useState, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Modal, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { UserProfile, WorkoutPlan, DailyNutritionPlan, WorkoutDay } from '../types';
import { generateWorkoutPlan, generateDailyNutrition } from '../utils/planGenerator';
import { getGoalEstimate } from '../utils/goalEstimate';
import { getAIPlans } from '../services/api';
import WorkoutCard from '../components/WorkoutCard';
import NutritionCard from '../components/NutritionCard';
import { colors, radius } from '../constants/theme';
import { GOAL_LABEL } from '../constants/goals';

interface HomeScreenProps {
  userProfile: UserProfile | null;
  onSignOut: () => void;
  onEditProfile: () => void;
  onStartWorkout: (workout: WorkoutDay) => void;
}

interface ScheduleItem {
  date: Date;
  workout: WorkoutDay | null;
  isRest: boolean;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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

function get5DaySchedule(workoutPlan: WorkoutPlan, daysPerWeek: number): ScheduleItem[] {
  const trainingSet = new Set(TRAINING_DAY_SETS[Math.min(Math.max(daysPerWeek, 1), 7)] ?? [1, 3, 5]);
  const today = new Date();
  const todayDow = today.getDay(); // 0=Sun

  // Count workout days that have already occurred this week (Mon–yesterday) to get index offset
  const daysFromMon = todayDow === 0 ? 6 : todayDow - 1;
  let weekOffset = 0;
  for (let i = 0; i < daysFromMon; i++) {
    const dow = (i + 1) % 7;
    if (trainingSet.has(dow)) weekOffset++;
  }

  const schedule: ScheduleItem[] = [];
  let workoutIdx = weekOffset;

  for (let i = 0; i < 5; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    const dow = date.getDay();

    if (trainingSet.has(dow)) {
      schedule.push({
        date,
        workout: workoutPlan.days[workoutIdx % workoutPlan.days.length],
        isRest: false,
      });
      workoutIdx++;
    } else {
      schedule.push({ date, workout: null, isRest: true });
    }
  }

  return schedule;
}

export default function HomeScreen({ userProfile, onSignOut, onEditProfile, onStartWorkout }: HomeScreenProps) {
  const [workoutPlan, setWorkoutPlan] = useState<WorkoutPlan | null>(null);
  const [nutritionPlan, setNutritionPlan] = useState<DailyNutritionPlan | null>(null);
  const [activeTab, setActiveTab] = useState<'workout' | 'meals'>('workout');
  const [menuOpen, setMenuOpen] = useState(false);
  const [expandedDay, setExpandedDay] = useState<number>(0);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSource, setAiSource] = useState<'ai' | 'local'>('local');

  useEffect(() => {
    if (userProfile) {
      loadPlans(userProfile);
    }
  }, [userProfile]);

  const loadPlans = async (profile: UserProfile) => {
    // Always show local plan immediately so UI isn't empty
    setWorkoutPlan(generateWorkoutPlan(profile));
    setNutritionPlan(generateDailyNutrition(profile));
    setAiSource('local');

    // Then try to fetch AI-generated plans
    const token = await AsyncStorage.getItem('authToken');
    if (!token) return;

    setAiLoading(true);
    try {
      const plans = await getAIPlans(token, profile);
      setWorkoutPlan(plans.workout_plan);
      setNutritionPlan(plans.nutrition_plan);
      setAiSource('ai');
    } catch {
      // AI unavailable — local plan already shown, silently keep it
    } finally {
      setAiLoading(false);
    }
  };

  if (!userProfile || !workoutPlan || !nutritionPlan) {
    return <View style={styles.container} />;
  }

  const goalLabel = GOAL_LABEL[userProfile.goal] ?? userProfile.goal;
  const estimate = getGoalEstimate(userProfile);
  const schedule = get5DaySchedule(workoutPlan, userProfile.daysPerWeek);
  const { targets } = nutritionPlan;

  return (
    <View style={styles.container}>

      {/* ── Header ── */}
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>Today's Plan</Text>
          <View style={styles.goalBadge}>
            <Text style={styles.goalBadgeText}>{goalLabel}</Text>
          </View>
        </View>
        <TouchableOpacity style={styles.menuBtn} onPress={() => setMenuOpen(true)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <View style={styles.menuBar} />
          <View style={styles.menuBar} />
          <View style={styles.menuBar} />
        </TouchableOpacity>
      </View>

      {/* ── AI status ── */}
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

      {/* ── Stats row ── */}
      <View style={styles.statsRow}>
        <StatBox label="Training Days" value={`${userProfile.daysPerWeek}/wk`} />
        <StatBox label="Calories"      value={String(targets.calories)} />
        <StatBox label="Protein"       value={`${targets.protein}g`} />
      </View>

      {/* ── Goal estimate banner ── */}
      {estimate && (
        <View style={styles.estimateBanner}>
          <Text style={styles.estimateIcon}>🎯</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.estimateTitle}>Goal Target</Text>
            <Text style={styles.estimateBody}>
              {estimate.date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
              {'  ·  '}{estimate.label}
            </Text>
          </View>
        </View>
      )}

      {/* ── Tabs ── */}
      <View style={styles.tabs}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'workout' && styles.tabActive]}
          onPress={() => setActiveTab('workout')}>
          <Text style={[styles.tabText, activeTab === 'workout' && styles.tabTextActive]}>Workout</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'meals' && styles.tabActive]}
          onPress={() => setActiveTab('meals')}>
          <Text style={[styles.tabText, activeTab === 'meals' && styles.tabTextActive]}>Meals</Text>
        </TouchableOpacity>
      </View>

      {/* ── Tab content ── */}
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {activeTab === 'workout' ? (
          schedule.map((item, i) => (
            <DayCard
              key={i}
              item={item}
              isToday={i === 0}
              expanded={expandedDay === i}
              onPress={() => setExpandedDay(expandedDay === i ? -1 : i)}
              onStartWorkout={onStartWorkout}
            />
          ))
        ) : (
          <NutritionCard nutritionPlan={nutritionPlan} />
        )}
      </ScrollView>

      {/* ── Settings modal ── */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setMenuOpen(false)}>
          <View style={styles.menuDropdown}>
            <Text style={styles.menuHeading}>Settings</Text>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => { setMenuOpen(false); onEditProfile(); }}>
              <Text style={styles.menuItemIcon}>✏️</Text>
              <Text style={styles.menuItemText}>Edit Profile</Text>
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => { setMenuOpen(false); onSignOut(); }}>
              <Text style={styles.menuItemIcon}>🚪</Text>
              <Text style={[styles.menuItemText, { color: colors.error }]}>Sign Out</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

    </View>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statBox}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function DayCard({ item, isToday, expanded, onPress, onStartWorkout }: {
  item: ScheduleItem;
  isToday: boolean;
  expanded: boolean;
  onPress: () => void;
  onStartWorkout: (workout: WorkoutDay) => void;
}) {
  const dow = isToday ? 'Today' : DAY_NAMES[item.date.getDay()];
  const dateStr = `${MONTH_NAMES[item.date.getMonth()]} ${item.date.getDate()}`;

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

  return (
    <TouchableOpacity style={[styles.dayCard, isToday && styles.dayCardToday]} onPress={onPress} activeOpacity={0.8}>
      <View style={styles.dayCardRow}>
        <View style={styles.dayCardLeft}>
          <Text style={[styles.dayCardDow, isToday && styles.dayCardDowToday]}>{dow}</Text>
          <Text style={styles.dayCardDate}>{dateStr}</Text>
        </View>
        <View style={styles.dayCardRight}>
          <Text style={styles.focusLabel}>{item.workout!.focus}</Text>
          <Text style={styles.exerciseCount}>{item.workout!.exercises.length} exercises</Text>
        </View>
        <Text style={styles.chevron}>{expanded ? '▲' : '▼'}</Text>
      </View>

      {expanded && (
        <View style={styles.expandedContent}>
          {isToday ? (
            <>
              <WorkoutCard workout={item.workout!} />
              <TouchableOpacity
                style={styles.startWorkoutBtn}
                onPress={() => onStartWorkout(item.workout!)}>
                <Text style={styles.startWorkoutBtnText}>▶  Start Workout</Text>
              </TouchableOpacity>
            </>
          ) : (
            <View style={styles.exerciseSummaryList}>
              {item.workout!.exercises.map((ex, i) => (
                <View key={i} style={styles.exerciseSummaryRow}>
                  <Text style={styles.exerciseSummaryName}>{ex.name}</Text>
                  <Text style={styles.exerciseSummaryDetail}>{ex.sets} × {ex.reps}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 56, paddingBottom: 12,
  },
  greeting:      { fontSize: 26, fontWeight: '700', color: colors.textPrimary, marginBottom: 6 },
  goalBadge:     { alignSelf: 'flex-start', backgroundColor: colors.surface, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 4, borderWidth: 1, borderColor: colors.primary },
  goalBadgeText: { fontSize: 12, color: colors.primary, fontWeight: '600' },

  menuBtn: { padding: 4, gap: 5, alignItems: 'center', justifyContent: 'center' },
  menuBar: { width: 22, height: 2, backgroundColor: colors.textPrimary, borderRadius: 2 },

  aiBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginBottom: 10, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  aiText:   { fontSize: 12, color: colors.textSecondary, flex: 1 },

  statsRow: { flexDirection: 'row', gap: 10, marginHorizontal: 16, marginBottom: 12 },
  statBox:  { flex: 1, backgroundColor: colors.surface, borderRadius: radius.md, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: colors.border },
  statValue: { fontSize: 18, fontWeight: '700', color: colors.primary, marginBottom: 2 },
  statLabel: { fontSize: 11, color: colors.textSecondary },

  estimateBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    marginHorizontal: 16, marginBottom: 12,
    backgroundColor: colors.surface, borderRadius: radius.md,
    padding: 12, borderWidth: 1, borderColor: colors.border,
    borderLeftWidth: 3, borderLeftColor: colors.accent,
  },
  estimateIcon:  { fontSize: 22 },
  estimateTitle: { fontSize: 11, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 2 },
  estimateBody:  { fontSize: 13, fontWeight: '600', color: colors.textPrimary },

  tabs: {
    flexDirection: 'row', marginHorizontal: 16, marginBottom: 12,
    backgroundColor: colors.surface, borderRadius: radius.md,
    padding: 4, borderWidth: 1, borderColor: colors.border,
  },
  tab:           { flex: 1, paddingVertical: 10, borderRadius: radius.sm, alignItems: 'center' },
  tabActive:     { backgroundColor: colors.primary },
  tabText:       { fontSize: 14, fontWeight: '600', color: colors.textSecondary },
  tabTextActive: { color: colors.background },

  scrollView:    { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 40 },

  dayCard: {
    backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: 14, marginBottom: 10,
  },
  dayCardToday: { borderColor: colors.primary, borderLeftWidth: 3, borderLeftColor: colors.primary },
  dayCardRow:   { flexDirection: 'row', alignItems: 'center' },
  dayCardLeft:  { width: 64 },
  dayCardRight: { flex: 1 },
  dayCardDow:   { fontSize: 13, fontWeight: '700', color: colors.textSecondary, marginBottom: 2 },
  dayCardDowToday: { color: colors.primary },
  dayCardDate:  { fontSize: 11, color: colors.textMuted },

  focusLabel:    { fontSize: 14, fontWeight: '600', color: colors.textPrimary, marginBottom: 2 },
  exerciseCount: { fontSize: 12, color: colors.textMuted },
  chevron:       { fontSize: 10, color: colors.textMuted, marginLeft: 8 },

  restBadge:     { backgroundColor: colors.surfaceRaised, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 4, borderWidth: 1, borderColor: colors.border },
  restBadgeText: { fontSize: 12, color: colors.textSecondary, fontWeight: '500' },
  restHint:      { fontSize: 12, color: colors.textMuted, marginTop: 8 },

  expandedContent: { marginTop: 12 },
  exerciseSummaryList: { gap: 8 },
  exerciseSummaryRow:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  exerciseSummaryName: { fontSize: 13, color: colors.textPrimary, fontWeight: '500', flex: 1 },
  exerciseSummaryDetail: { fontSize: 12, color: colors.primary, fontWeight: '600' },

  startWorkoutBtn:     { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', marginTop: 12 },
  startWorkoutBtnText: { color: colors.background, fontSize: 15, fontWeight: '700', letterSpacing: 0.3 },

  // Modal / Menu
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-start', alignItems: 'flex-end', paddingTop: 90, paddingRight: 16 },
  menuDropdown:  { backgroundColor: colors.surface, borderRadius: radius.lg, minWidth: 200, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  menuHeading:   { fontSize: 11, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.8, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10 },
  menuItem:      { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  menuItemIcon:  { fontSize: 18 },
  menuItemText:  { fontSize: 15, fontWeight: '500', color: colors.textPrimary },
  menuDivider:   { height: 1, backgroundColor: colors.border, marginHorizontal: 16 },
});
