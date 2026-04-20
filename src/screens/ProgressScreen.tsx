import { useState, useEffect, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator,
  TextInput, Alert, Image, Linking,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { LayoutAnimation, UIManager, Platform } from 'react-native';
import FadeInView from '../components/FadeInView';
import StreakCounter from '../components/StreakCounter';
import AnimatedNumber from '../components/AnimatedNumber';
import { WorkoutDaySkeleton } from '../components/SkeletonLoader';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import ViewShot from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WorkoutSession, UserProfile, StoredWorkoutSummary, GoalHistoryEntry, PlanChangeEntry, BodyScanEntry, HealthSummary, HealthScoreResult } from '../types';
import { loadWorkoutHistory, getPersonalRecords, PR, loadWorkoutSummaries, loadGoalHistory, loadPlanChanges, loadHealthSummary, loadHealthScore, deleteWorkoutSession, deleteWorkoutSummary, deletePlanChange, saveWorkoutSession, dateKey, saveHealthSummary, isAppleHealthEnabled } from '../utils/workoutHistory';
import { readHealthSummary, isHealthKitAvailable, requestHealthPermissions } from '../services/appleHealth';
import { setAppleHealthEnabled as persistAppleHealthEnabled } from '../utils/workoutHistory';
import LogActivityModal from '../components/LogActivityModal';
import RecoveryCard from '../components/RecoveryCard';
import { RECOVERY_LABELS } from '../utils/healthScore';
import { computeDietConsistency, DietConsistencyScore } from '../utils/mealTracker';
import { getGoalEstimate } from '../utils/goalEstimate';
import { useMetaData } from '../hooks/useMetaData';
import { humanizeToken } from '../utils/exerciseGuide';
import { getInsights, getGuardrails, getCoachMemory, getProgressionInsights, scanBody, BodyScanResult } from '../services/api';
import { colors, getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';

interface ProgressScreenProps {
  onBack: () => void;
  authToken: string;
  userProfile: UserProfile;
  onUpdateWeight?: (weightLbs: number) => void;
  themeName?: AppThemeName;
  // When true, hide the top "← Back / Progress" header bar. Used when
  // this screen is rendered inline as bottom-tab content — the bottom
  // nav already provides navigation, so the inner header is redundant.
  noHeader?: boolean;
  nutritionPlan?: import('../types').DailyNutritionPlan | null;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const SHARE_LOGO_LIGHT = require('../../assets/images/thallo-logo-black.png');
const SHARE_LOGO_DARK  = require('../../assets/images/thallo-logo-white.png');

interface StrengthPoint {
  key: string;
  label: string;
  score: number;
}

function formatDate(isoString: string): string {
  const d = new Date(isoString);
  return `${DAY_NAMES[d.getDay()]} ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Returns all data points for a specific exercise across history: {date, bestWeightLbs, totalVolume} */
function buildExerciseTrend(history: WorkoutSession[], exerciseName: string) {
  const sorted = [...history].sort((a, b) => +new Date(a.date) - +new Date(b.date));
  return sorted
    .filter(s => s.exercises.some(e => e.name.toLowerCase() === exerciseName.toLowerCase()))
    .slice(-10)
    .map(s => {
      const ex = s.exercises.find(e => e.name.toLowerCase() === exerciseName.toLowerCase())!;
      const bestWeight = ex.sets.length ? Math.max(...ex.sets.map(set => set.weightLbs)) : 0;
      const volume = ex.sets.reduce((sum, set) => sum + set.weightLbs * set.reps, 0);
      const d = new Date(s.date);
      return { label: `${d.getMonth() + 1}/${d.getDate()}`, bestWeight, volume };
    });
}

export default function ProgressScreen({ onBack, authToken, userProfile, onUpdateWeight, themeName, noHeader = false, nutritionPlan }: ProgressScreenProps) {
  const tc = getTheme(themeName).colors;
  const styles = createStyles(tc);
  const meta = useMetaData();
  const [tab, setTab] = useState<'prs' | 'charts' | 'body'>('body');
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [showLogActivity, setShowLogActivity] = useState(false);
  const fitnessScoreRef = useRef<ViewShot>(null);
  const bodyScanShareRef = useRef<ViewShot>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [selectedExercise, setSelectedExercise] = useState<string | null>(null);
  const [chartMode, setChartMode] = useState<'weight' | 'volume'>('weight');
  const [prs, setPrs] = useState<PR[]>([]);
  const [prSearch, setPrSearch] = useState('');
  const [prFocusFilter, setPrFocusFilter] = useState<string | null>(null);
  const [history, setHistory] = useState<WorkoutSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [insights, setInsights] = useState<any | null>(null);
  const [guardrails, setGuardrails] = useState<string[]>([]);
  const [coachMemory, setCoachMemory] = useState<any[]>([]);
  const [progressionHint, setProgressionHint] = useState<string>('');
  const [editingWeight, setEditingWeight] = useState(false);
  const [weightInput, setWeightInput] = useState('');
  const [summaries, setSummaries] = useState<StoredWorkoutSummary[]>([]);
  const [goalHistory, setGoalHistory] = useState<GoalHistoryEntry[]>([]);
  const [planChanges, setPlanChanges] = useState<PlanChangeEntry[]>([]);
  const [bodyScanLoading, setBodyScanLoading] = useState(false);
  const [bodyScanResult, setBodyScanResult] = useState<BodyScanResult | null>(null);
  const [bodyScanHistory, setBodyScanHistory] = useState<BodyScanEntry[]>([]);
  const [healthSummary, setHealthSummary] = useState<HealthSummary | null>(null);
  const [healthEnabled, setHealthEnabled] = useState<boolean>(false);
  const [healthConnecting, setHealthConnecting] = useState<boolean>(false);
  const [healthScore, setHealthScore] = useState<HealthScoreResult | null>(null);
  // Diet score now always exists (mealTracker returns a zeroed
  // empty-state object instead of null). The card always renders so
  // fresh users see "log a meal to start tracking" instead of nothing.
  const [dietScore, setDietScore] = useState<DietConsistencyScore | null>(null);
  const [oneRepMaxLifts, setOneRepMaxLifts] = useState<import('../services/api').OneRepMaxLift[]>([]);
  const [weightEntries, setWeightEntries] = useState<import('../types').WeightEntry[]>([]);
  const [weightInputVisible, setWeightInputVisible] = useState(false);
  const [weightInputValue, setWeightInputValue] = useState('');
  const [muscleFatigue, setMuscleFatigue] = useState<{ score: number; label: string; topFatigued: Array<{ muscle: string; value: number }>; muscleFatigue: Record<string, number> } | null>(null);
  const [nutritionScore, setNutritionScore] = useState<import('../utils/nutritionScore').NutritionScoreResult | null>(null);
  const [mealAverages, setMealAverages] = useState<import('../services/api').MealAverages | null>(null);

  useEffect(() => {
    Promise.all([getPersonalRecords(), loadWorkoutHistory(), loadWorkoutSummaries(), loadGoalHistory(), loadPlanChanges()]).then(([p, h, s, g, c]) => {
      setPrs(p);
      setHistory(h);
      setSummaries(s);
      console.log(`[Progress] history=${h.length} completed=${h.filter((x: any) => x.completed).length} summaries=${s.length} sample_date=${h[0]?.date ?? 'none'}`);
      setGoalHistory(g);
      setPlanChanges(c);
      setLoading(false);
      if (authToken && p.length > 0) {
        getProgressionInsights(authToken, p[0].exerciseName)
          .then((r: any) => setProgressionHint(r?.suggestion ?? ''))
          .catch(() => null);
      }
      import('../utils/weightHistory').then(({ loadWeightHistory }) =>
        loadWeightHistory().then(setWeightEntries).catch(() => null)
      );
      if (authToken) {
        import('../services/api').then(({ getFatigueScore }) => {
          getFatigueScore(authToken).then(fs => setMuscleFatigue({
            score: fs.readiness_score, label: fs.readiness_label,
            topFatigued: fs.top_fatigued ?? [], muscleFatigue: fs.muscle_fatigue ?? {},
          })).catch(() => null);
        });
      }
      if (authToken) {
        import('../services/api').then(({ getOneRepMaxShowcase }) =>
          getOneRepMaxShowcase(authToken)
            .then(setOneRepMaxLifts)
            .catch(() => setOneRepMaxLifts([]))
        );
      }
    });
    if (authToken) {
      getInsights(authToken).then(setInsights).catch(() => null);
      getGuardrails(authToken).then(r => setGuardrails(r.warnings ?? [])).catch(() => null);
      getCoachMemory(authToken).then((rows: any[]) => setCoachMemory(rows.slice(0, 5))).catch(() => null);
      import('../services/api').then(({ getMealAverages }) =>
        getMealAverages(authToken, 14).then(setMealAverages).catch(() => null)
      );
    }
    // Load body scan history
    AsyncStorage.getItem('bodyScanHistory').then(raw => {
      if (raw) try { setBodyScanHistory(JSON.parse(raw)); } catch {}
    });
    // Load Apple Health data — cached value first, then refresh from HealthKit
    // so the vitals row reflects live data without requiring a workout finish.
    loadHealthSummary().then(setHealthSummary);
    loadHealthScore().then(setHealthScore);
    (async () => {
      try {
        if (!isHealthKitAvailable()) return;
        const enabled = await isAppleHealthEnabled();
        setHealthEnabled(enabled);
        if (!enabled) return;
        const fresh = await readHealthSummary();
        if (fresh) {
          setHealthSummary(fresh);
          saveHealthSummary(fresh).catch(() => null);
        }
      } catch {}
    })();
    computeDietConsistency(userProfile.mealsPerDay ?? 3).then(setDietScore);
  }, [userProfile.mealsPerDay]);

  // Compute nutrition score from plan data
  useEffect(() => {
    if (!nutritionPlan) { setNutritionScore(null); return; }
    import('../utils/nutritionScore').then(({ computeNutritionScore }) => {
      const goal = userProfile?.goal ?? 'body_recomp';
      setNutritionScore(computeNutritionScore(nutritionPlan, goal));
    });
  }, [nutritionPlan, userProfile?.goal]);

  const handleShareBodyScan = async () => {
    try {
      const ref = bodyScanShareRef.current as any;
      if (!ref?.capture) return;
      const uri = await ref.capture();
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
    try {
      const opts = {
        mediaTypes: 'images' as any,
        base64: true,
        quality: 0.7,
      };
      const result = source === 'camera'
        ? await ImagePicker.launchCameraAsync(opts)
        : await ImagePicker.launchImageLibraryAsync(opts);
      if (result.canceled || !result.assets?.[0]?.base64) return;

      setBodyScanLoading(true);
      setBodyScanResult(null);
      const asset = result.assets[0];
      const stats = userProfile.physicalStats;
      const heightInches = (stats.heightFeet ?? 0) * 12 + (stats.heightInches ?? 0);

      const scanResult = await scanBody(authToken, {
        image_base64: asset.base64!,
        mime_type: 'image/jpeg',
        gender: stats.gender,
        weight_lbs: stats.weightLbs,
        height_inches: heightInches > 0 ? heightInches : undefined,
        age: stats.age,
      });
      setBodyScanResult(scanResult);

      // Save to history
      const entry: BodyScanEntry = {
        id: Date.now().toString(),
        date: new Date().toISOString(),
        bodyFatPct: scanResult.bodyFatPct,
        bodyFatRange: scanResult.bodyFatRange,
        muscleMass: scanResult.muscleMass,
        category: scanResult.category,
        strengths: scanResult.strengths,
        improvements: scanResult.improvements,
        assessment: scanResult.assessment,
        weightLbs: stats.weightLbs,
      };
      const updated = [entry, ...bodyScanHistory].slice(0, 20);
      setBodyScanHistory(updated);
      await AsyncStorage.setItem('bodyScanHistory', JSON.stringify(updated));
    } catch (e: any) {
      Alert.alert('Scan Failed', e?.message || 'Could not complete the body scan.');
    } finally {
      setBodyScanLoading(false);
    }
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
    if (!authToken) { setCompositeFitnessLoading(false); return; }
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
  }, [authToken, userProfile?.daysPerWeek, userProfile?.physicalStats?.weightLbs, healthSummary?.lastNightSleepHours, history.length]);

  const startWeight = userProfile.goalDetails.startWeightLbs ?? userProfile.physicalStats.weightLbs;
  const currentWeight = userProfile.physicalStats.weightLbs;
  const targetWeight = userProfile.goalDetails.targetWeightLbs;
  const estimate = getGoalEstimate(userProfile, meta.goalConfig);
  const lostOrGained = Math.abs(currentWeight - startWeight);
  const direction = currentWeight <= startWeight ? 'down' : 'up';
  const remainingLbs = targetWeight != null ? Math.abs(currentWeight - targetWeight) : null;

  return (
    <View style={styles.container}>
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

      <View style={styles.tabs}>
        {([
          ['body', 'Body Check'],
          ['prs', 'PRs'],
          ['charts', 'Charts'],
        ] as const).map(([key, label]) => (
          <TouchableOpacity
            key={key}
            style={[styles.tab, tab === key && styles.tabActive]}
            onPress={() => setTab(key as typeof tab)}>
            <Text style={[styles.tabText, tab === key && styles.tabTextActive]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : tab === 'charts' ? (
        <ScrollView contentContainerStyle={styles.content}>
          {prs.length === 0 ? (
            <View style={styles.emptyBox}>
              <Ionicons name="analytics-outline" size={40} color={tc.textMuted} style={{ marginBottom: 8 }} />
              <Text style={styles.emptyTitle}>Complete 3 workouts to see charts</Text>
              <Text style={styles.emptyBody}>Charts appear after your first few sessions with logged sets.</Text>
            </View>
          ) : (
            <>
              {/* Exercise selector */}
              <Text style={styles.sectionLabel}>Select exercise</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 12 }}>
                {prs.map((pr, i) => (
                  <TouchableOpacity
                    key={i}
                    style={[styles.exerciseChip, selectedExercise === pr.exerciseName && styles.exerciseChipActive]}
                    onPress={() => setSelectedExercise(pr.exerciseName)}>
                    <Text style={[styles.exerciseChipText, selectedExercise === pr.exerciseName && styles.exerciseChipTextActive]}>
                      {pr.exerciseName}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              {selectedExercise ? (() => {
                const trend = buildExerciseTrend(history, selectedExercise);
                if (trend.length < 2) {
                  return (
                    <View style={styles.emptyBox}>
                      <Text style={styles.emptyTitle}>Not enough data</Text>
                      <Text style={styles.emptyBody}>Complete at least 2 sessions with {selectedExercise} to see a trend.</Text>
                    </View>
                  );
                }
                const values = trend.map(p => chartMode === 'weight' ? p.bestWeight : Math.round(p.volume));
                const maxVal = Math.max(...values, 1);
                return (
                  <View style={styles.graphCard}>
                    <View style={styles.graphHeader}>
                      <Text style={styles.graphTitle}>{selectedExercise}</Text>
                      <View style={{ flexDirection: 'row', gap: 6 }}>
                        <TouchableOpacity
                          style={[styles.chartModeBtn, chartMode === 'weight' && styles.chartModeBtnActive]}
                          onPress={() => setChartMode('weight')}>
                          <Text style={[styles.chartModeBtnText, chartMode === 'weight' && styles.chartModeBtnTextActive]}>Weight</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.chartModeBtn, chartMode === 'volume' && styles.chartModeBtnActive]}
                          onPress={() => setChartMode('volume')}>
                          <Text style={[styles.chartModeBtnText, chartMode === 'volume' && styles.chartModeBtnTextActive]}>Volume</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                    <Text style={styles.graphSubtitle}>
                      {chartMode === 'weight' ? 'Best set weight (lbs) per session' : 'Total volume (lbs × reps) per session'}
                    </Text>
                    <View style={styles.graphBars}>
                      {trend.map((point, i) => {
                        const val = chartMode === 'weight' ? point.bestWeight : Math.round(point.volume);
                        const h = Math.max(8, Math.round((val / maxVal) * 100));
                        const isLast = i === trend.length - 1;
                        return (
                          <View key={i} style={styles.graphBarCol}>
                            <Text style={[styles.graphBarValue, isLast && { color: colors.primary }]}>{val}</Text>
                            <View style={[styles.graphBar, { height: h }, isLast && { backgroundColor: colors.accent }]} />
                            <Text style={styles.graphBarLabel}>{point.label}</Text>
                          </View>
                        );
                      })}
                    </View>
                    <View style={styles.chartSummaryRow}>
                      <View style={styles.chartStat}>
                        <Text style={styles.chartStatValue}>{values[values.length - 1]}{chartMode === 'weight' ? ' lbs' : ''}</Text>
                        <Text style={styles.chartStatLabel}>Latest</Text>
                      </View>
                      <View style={styles.chartStat}>
                        <Text style={styles.chartStatValue}>{Math.max(...values)}{chartMode === 'weight' ? ' lbs' : ''}</Text>
                        <Text style={styles.chartStatLabel}>All-time best</Text>
                      </View>
                      <View style={styles.chartStat}>
                        <Text style={[styles.chartStatValue, { color: values[values.length - 1] >= values[0] ? colors.primary : colors.error }]}>
                          {values[values.length - 1] >= values[0] ? '+' : ''}{values[values.length - 1] - values[0]}{chartMode === 'weight' ? ' lbs' : ''}
                        </Text>
                        <Text style={styles.chartStatLabel}>vs first session</Text>
                      </View>
                    </View>
                  </View>
                );
              })() : (
                <View style={styles.emptyBox}>
                  <Text style={styles.emptyBody}>Tap an exercise above to see its progress chart.</Text>
                </View>
              )}
            </>
          )}
        </ScrollView>
      ) : tab === 'prs' ? (
        <ScrollView contentContainerStyle={styles.content} style={{ backgroundColor: tc.background }}>
          {(insights || guardrails.length > 0 || coachMemory.length > 0) && (
            <View style={styles.insightsCard}>
              <Text style={styles.insightsTitle}>Coach Insights</Text>
              {insights?.adherence && (
                <Text style={styles.insightsLine}>
                  7-day adherence: workouts {insights.adherence.workout_7d_pct}%
                  {insights.adherence.meal_7d_pct != null ? ` · meals ${insights.adherence.meal_7d_pct}%` : ''}
                </Text>
              )}
              {guardrails.map((w, i) => (
                <Text key={i} style={styles.guardrailText}>• {w}</Text>
              ))}
              {coachMemory.map((m, i) => (
                <Text key={i} style={styles.memoryText}>{m.summary}</Text>
              ))}
              {progressionHint ? <Text style={styles.progressionHint}>Progression: {progressionHint}</Text> : null}
            </View>
          )}

          {/* Weight tracking moved to Body Check tab */}

          {/* Estimated 1RM showcase — deterministic Epley estimates
              from recent logged sessions for the main compound lifts.
              Hidden when the user has no recent compound-lift data. */}
          {oneRepMaxLifts.length > 0 && (
            <View style={{ marginBottom: 16 }}>
              <Text style={styles.sectionLabel}>Estimated 1 Rep Max</Text>
              <View style={{
                backgroundColor: tc.surfaceRaised,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: tc.border,
                padding: 14,
                gap: 10,
              }}>
                {oneRepMaxLifts.map(lift => (
                  <View key={lift.slug} style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }}>
                        {lift.name}
                      </Text>
                      <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }}>
                        Top set: {lift.topWeightLbs} lb × {lift.topReps}
                        {' · '}{lift.sessionCount} session{lift.sessionCount !== 1 ? 's' : ''}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={{ fontSize: 20, fontWeight: '900', color: tc.textPrimary, fontVariant: ['tabular-nums'] as any }}>
                        {Math.round(lift.oneRepMaxLbs)}
                      </Text>
                      <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: -2 }}>lb 1RM</Text>
                    </View>
                  </View>
                ))}
                <Text style={{ fontSize: 10, color: tc.textMuted, fontStyle: 'italic', marginTop: 2 }}>
                  Epley estimates from your recent logged sets. Gets sharper as you log more sessions.
                </Text>
              </View>
            </View>
          )}

          {prs.length === 0 ? (
            <View style={styles.emptyBox}>
              <Ionicons name="trophy-outline" size={40} color={tc.textMuted} style={{ marginBottom: 8 }} />
              <Text style={styles.emptyTitle}>No PRs yet</Text>
              <Text style={styles.emptyBody}>Complete a workout and log your sets to start tracking personal records.</Text>
            </View>
          ) : (() => {
            const focusOptions = Array.from(new Set(prs.map(p => p.sessionFocus).filter(Boolean))).sort();
            const q = prSearch.trim().toLowerCase();
            const filteredPrs = prs.filter(pr => {
              if (q && !pr.exerciseName.toLowerCase().includes(q)) return false;
              if (prFocusFilter && pr.sessionFocus !== prFocusFilter) return false;
              return true;
            });
            return (
              <>
                <TextInput
                  style={styles.prSearchInput}
                  value={prSearch}
                  onChangeText={setPrSearch}
                  placeholder="Search exercises..."
                  placeholderTextColor={tc.textMuted}
                  autoCorrect={false}
                  autoCapitalize="none"
                />
                {focusOptions.length > 1 && (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.prFilterRow}>
                    <TouchableOpacity
                      style={[styles.prFilterChip, prFocusFilter === null && styles.prFilterChipActive]}
                      onPress={() => setPrFocusFilter(null)}>
                      <Text style={[styles.prFilterChipText, prFocusFilter === null && styles.prFilterChipTextActive]}>
                        All
                      </Text>
                    </TouchableOpacity>
                    {focusOptions.map(focus => {
                      const active = prFocusFilter === focus;
                      return (
                        <TouchableOpacity
                          key={focus}
                          style={[styles.prFilterChip, active && styles.prFilterChipActive]}
                          onPress={() => setPrFocusFilter(active ? null : focus)}>
                          <Text style={[styles.prFilterChipText, active && styles.prFilterChipTextActive]}>
                            {focus}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                )}
                <Text style={styles.sectionLabel}>
                  {filteredPrs.length} of {prs.length} exercises tracked
                </Text>
                {filteredPrs.length === 0 ? (
                  <View style={styles.emptyBox}>
                    <Text style={styles.emptyBody}>No exercises match your search.</Text>
                  </View>
                ) : filteredPrs.map((pr, i) => {
                  // Inline Epley 1RM only for compound lifts. Showing
                  // an estimated 1RM on a 25 lb lateral raise or a
                  // 12 lb cable curl is misleading — Epley breaks
                  // down badly above 10 reps and isolation work
                  // doesn't really map to a "1RM" in any meaningful
                  // way. Pattern-match the exercise name against a
                  // compound vocabulary and skip everything else.
                  const lower = pr.exerciseName.toLowerCase();
                  const isCompound = (
                    /\b(squat|deadlift|bench|press|row|pull[-\s]?up|chin[-\s]?up|dip|clean|snatch|hip\s*thrust|lunge|good\s*morning)\b/.test(lower)
                    && !/\b(curl|fly|raise|extension|kickback|pulldown|crunch|skullcrusher|crossover|pec\s*deck|leg\s*curl|leg\s*extension)\b/.test(lower)
                  );
                  const est1rm = isCompound && pr.weightLbs > 0 && pr.reps > 0 && pr.reps <= 12
                    ? Math.round(pr.weightLbs * (1 + pr.reps / 30))
                    : null;
                  return (
                    <View key={i} style={styles.prCard}>
                      <View style={styles.prLeft}>
                        <Text style={styles.prName}>{pr.exerciseName}</Text>
                        <Text style={styles.prMeta}>{pr.sessionFocus}  ·  {formatDate(pr.date)}</Text>
                        {est1rm != null && (
                          <Text style={[styles.prMeta, { marginTop: 2, fontWeight: '600', color: tc.textPrimary }]}>
                            ~{est1rm} lb est 1RM
                          </Text>
                        )}
                      </View>
                      <View style={styles.prRight}>
                        <Text style={styles.prWeight}>{pr.weightLbs}</Text>
                        <Text style={styles.prUnit}>lbs</Text>
                        <Text style={styles.prReps}>{pr.reps} reps</Text>
                      </View>
                    </View>
                  );
                })}
              </>
            );
          })()}
        </ScrollView>
      ) : (tab as string) === 'history' ? (
        <ScrollView contentContainerStyle={styles.content}>
          {/* Month calendar — standard Sun-Sat grid for current month */}
          {(() => {
            const today = new Date();
            const year = today.getFullYear();
            const month = today.getMonth();
            const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
            const daysInMonth = new Date(year, month + 1, 0).getDate();
            const firstDow = new Date(year, month, 1).getDay(); // 0=Sun

            const toDateKey = (d: string) => {
              if (!d) return '';
              const p = new Date(d);
              if (isNaN(p.getTime())) return d.slice(0, 10);
              return `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, '0')}-${String(p.getDate()).padStart(2, '0')}`;
            };
            const completedDates = new Set([
              ...history.filter(s => s.date && !s.skipped).map(s => toDateKey(s.date)),
              ...summaries.filter(s => s.date).map(s => toDateKey(s.date)),
            ]);
            const skippedDates = new Set(
              history.filter(s => s.skipped && s.date).map(s => toDateKey(s.date))
            );

            // Build grid: 6 rows × 7 cols, empty cells for padding
            const cells: Array<{ day: number; key: string; status: 'done' | 'skipped' | 'rest' | 'future' | 'empty' }> = [];
            for (let i = 0; i < firstDow; i++) cells.push({ day: 0, key: `pad-${i}`, status: 'empty' });
            for (let d = 1; d <= daysInMonth; d++) {
              const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
              const isFuture = d > today.getDate();
              const status = isFuture ? 'future' : completedDates.has(key) ? 'done' : skippedDates.has(key) ? 'skipped' : 'rest';
              cells.push({ day: d, key, status });
            }
            while (cells.length % 7 !== 0) cells.push({ day: 0, key: `pad-end-${cells.length}`, status: 'empty' });

            const rows: typeof cells[] = [];
            for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));

            const doneCount = [...completedDates].filter(k => k.startsWith(`${year}-${String(month + 1).padStart(2, '0')}`)).length;
            const skippedCount = [...skippedDates].filter(k => k.startsWith(`${year}-${String(month + 1).padStart(2, '0')}`)).length;

            return (
              <View style={{ marginBottom: 16, backgroundColor: tc.surface, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: tc.border }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <Text style={{ fontSize: 16, fontWeight: '700', color: tc.textPrimary }}>{monthNames[month]} {year}</Text>
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    {doneCount > 0 && <Text style={{ fontSize: 12, color: tc.primary, fontWeight: '600' }}>{doneCount} done</Text>}
                    {skippedCount > 0 && <Text style={{ fontSize: 12, color: '#F59E0B', fontWeight: '600' }}>{skippedCount} skipped</Text>}
                  </View>
                </View>
                {/* Day headers */}
                <View style={{ flexDirection: 'row', marginBottom: 6 }}>
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                    <Text key={d} style={{ flex: 1, textAlign: 'center', fontSize: 11, fontWeight: '600', color: tc.textMuted }}>{d}</Text>
                  ))}
                </View>
                {/* Calendar grid — rows stagger in */}
                {rows.map((row, ri) => (
                  <FadeInView key={ri} delay={ri * 40} style={{ flexDirection: 'row', marginBottom: 4 }}>
                    {row.map(cell => {
                      const isToday = cell.day === today.getDate() && cell.status !== 'empty';
                      return (
                        <View key={cell.key} style={{ flex: 1, alignItems: 'center', paddingVertical: 4 }}>
                          {cell.status === 'empty' ? (
                            <View style={{ width: 32, height: 32 }} />
                          ) : (
                            <View style={{
                              width: 32, height: 32, borderRadius: 16,
                              alignItems: 'center', justifyContent: 'center',
                              backgroundColor:
                                cell.status === 'done' ? tc.primary :
                                cell.status === 'skipped' ? '#F59E0B' + '33' :
                                cell.status === 'future' ? 'transparent' :
                                'transparent',
                              borderWidth: isToday ? 2 : 0,
                              borderColor: isToday ? tc.primary : 'transparent',
                            }}>
                              <Text style={{
                                fontSize: 13, fontWeight: isToday ? '800' : cell.status === 'done' ? '700' : '400',
                                color: cell.status === 'done' ? '#fff'
                                  : cell.status === 'skipped' ? '#F59E0B'
                                  : cell.status === 'future' ? tc.textMuted + '55'
                                  : tc.textSecondary,
                              }}>{cell.day}</Text>
                            </View>
                          )}
                        </View>
                      );
                    })}
                  </FadeInView>
                ))}
              </View>
            );
          })()}

          {history.length === 0 ? (
            <View style={styles.emptyBox}>
              <Ionicons name="calendar-outline" size={40} color={tc.textMuted} style={{ marginBottom: 8 }} />
              <Text style={styles.emptyTitle}>No workouts yet</Text>
              <Text style={styles.emptyBody}>Start a workout from the home screen to build your history.</Text>
            </View>
          ) : (
            <>
              {/* Weekly summary strip */}
              {(() => {
                const now = new Date();
                const dow = now.getDay();
                const mondayOffset = dow === 0 ? -6 : 1 - dow;
                const monday = new Date(now);
                monday.setDate(now.getDate() + mondayOffset);
                monday.setHours(0, 0, 0, 0);
                const thisWeek = history.filter(s => {
                  if (!s.date || s.skipped) return false;
                  const d = new Date(s.date);
                  return d >= monday;
                });
                const totalMin = Math.round(thisWeek.reduce((s, w) => s + (w.durationSeconds || 0), 0) / 60);
                const avgMin = thisWeek.length > 0 ? Math.round(totalMin / thisWeek.length) : 0;
                // Compute streak from consecutive days with workouts
                const allDoneDates = new Set(history.filter(s => s.date && !s.skipped).map(s => {
                  const p = new Date(s.date);
                  return `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, '0')}-${String(p.getDate()).padStart(2, '0')}`;
                }));
                let streak = 0;
                const checkDate = new Date();
                const todayStr = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, '0')}-${String(checkDate.getDate()).padStart(2, '0')}`;
                if (!allDoneDates.has(todayStr)) checkDate.setDate(checkDate.getDate() - 1);
                for (let j = 0; j < 90; j++) {
                  const ck = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, '0')}-${String(checkDate.getDate()).padStart(2, '0')}`;
                  if (allDoneDates.has(ck)) { streak++; checkDate.setDate(checkDate.getDate() - 1); }
                  else break;
                }

                return (
                  <FadeInView delay={0}>
                  <View style={{ backgroundColor: tc.primary + '12', borderRadius: 10, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: tc.primary + '22' }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: tc.primary, flexShrink: 1 }}>
                        This week: {thisWeek.length} workout{thisWeek.length !== 1 ? 's' : ''} · avg {avgMin} min
                      </Text>
                      {streak > 0 && <StreakCounter count={streak} color={tc.primary} />}
                    </View>
                  </View>
                  </FadeInView>
                );
              })()}

              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <Text style={styles.sectionLabel}>
                  {history.length} workout{history.length !== 1 ? 's' : ''}
                  {history.length > 30 ? ' · most recent 30' : ''}
                </Text>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <TouchableOpacity
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border }}
                    onPress={async () => {
                      try {
                        const { exportWorkoutHistory } = await import('../utils/dataExport');
                        const uname = await AsyncStorage.getItem('user_username').catch(() => null);
                        await exportWorkoutHistory(uname || undefined);
                      } catch (e: any) { Alert.alert('Export failed', e.message ?? 'Could not export'); }
                    }}>
                    <Ionicons name="share-outline" size={14} color={tc.textSecondary} />
                    <Text style={{ fontSize: 11, fontWeight: '600', color: tc.textSecondary }}>Share</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: tc.primary + '15' }}
                    onPress={() => setShowLogActivity(true)}>
                    <Ionicons name="add-circle-outline" size={16} color={tc.primary} />
                    <Text style={{ fontSize: 12, fontWeight: '700', color: tc.primary }}>Log Activity</Text>
                  </TouchableOpacity>
                </View>
              </View>
              {history.slice(0, 30).map((session, i) => {
                const totalSets = session.exercises.reduce((sum, ex) => sum + ex.sets.length, 0);
                const isExpanded = expandedSessionId === session.id;
                const summary = summaries.find(s => s.date && session.date && s.date.slice(0, 10) === session.date.slice(0, 10) && s.focus === session.focus);
                return (
                  <FadeInView key={session.id ?? i} delay={i * 60}>
                  <TouchableOpacity
                    key={session.id ?? i}
                    style={styles.sessionCard}
                    activeOpacity={0.8}
                    onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setExpandedSessionId(isExpanded ? null : (session.id ?? `s${i}`)); }}>
                    <View style={styles.sessionHeader}>
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <Text style={styles.sessionFocus}>
                            {session.manualActivity
                              ? `${humanizeToken(session.manualActivity.category)}${session.manualActivity.subtype ? ' · ' + humanizeToken(session.manualActivity.subtype) : ''}${session.manualActivity.intensity ? ' (' + session.manualActivity.intensity + ')' : ''}`
                              : session.focus}
                          </Text>
                          {summary?.totalSets != null && summary.totalSets > 0 && (
                            <View style={{ backgroundColor: tc.primary + '18', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 }}>
                              <Text style={{ fontSize: 9, fontWeight: '700', color: tc.primary }}>
                                {summary.totalSets > 25 ? 'VOLUME' : summary.totalSets < 15 ? 'STRENGTH' : 'HYPERTROPHY'}
                              </Text>
                            </View>
                          )}
                        </View>
                        <Text style={styles.sessionDate}>{formatDate(session.date)}</Text>
                      </View>
                      <View style={styles.sessionBadge}>
                        <Text style={styles.sessionBadgeText}>{formatDuration(session.durationSeconds)}</Text>
                      </View>
                      <Ionicons name={isExpanded ? 'chevron-down' : 'chevron-forward'} size={14} color={tc.textMuted} style={{ marginLeft: 6 }} />
                    </View>
                    <View style={styles.sessionStats}>
                      <Text style={styles.sessionStat}>{session.exercises.length} exercises</Text>
                      <Text style={styles.sessionStatDot}>·</Text>
                      <Text style={styles.sessionStat}>{totalSets} sets</Text>
                      {summary && (
                        <>
                          <Text style={styles.sessionStatDot}>·</Text>
                          <Text style={styles.sessionStat}>~{summary.caloriesBurned} kcal</Text>
                        </>
                      )}
                    </View>

                    {isExpanded && (
                      <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: tc.border }}>
                        {session.exercises.filter(ex => ex.sets.length > 0).map((ex, ei) => {
                          const best = ex.sets.reduce((b, s) => s.weightLbs > b.weightLbs ? s : b, ex.sets[0]);
                          return (
                            <View key={ei} style={styles.exRow}>
                              <Text style={styles.exName}>{ex.name}</Text>
                              <Text style={styles.exBest}>{best.weightLbs} lbs × {best.reps}</Text>
                            </View>
                          );
                        })}
                        {summary && (
                          <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: tc.border }}>
                            {summary.motivationMessage ? (
                              <Text style={{ fontSize: 13, color: tc.textSecondary, lineHeight: 19, marginBottom: 6 }}>{summary.motivationMessage}</Text>
                            ) : null}
                            {summary.achievements?.length > 0 && (
                              <View style={{ gap: 2, marginBottom: 6 }}>
                                {summary.achievements.map((a: string, ai: number) => (
                                  <Text key={ai} style={{ fontSize: 12, color: tc.primary }}>★ {a}</Text>
                                ))}
                              </View>
                            )}
                            {summary.feedback && (
                              <Text style={{ fontSize: 12, color: tc.textMuted }}>
                                Felt {summary.feedback.feeling} · intensity {summary.feedback.intensity}/5
                                {summary.feedback.sorenessAreas?.length ? ` · sore: ${summary.feedback.sorenessAreas.join(', ')}` : ''}
                              </Text>
                            )}
                          </View>
                        )}
                      </View>
                    )}
                  </TouchableOpacity>
                  </FadeInView>
                );
              })}
            </>
          )}
        </ScrollView>
      ) : false ? (
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.sectionLabel}>Goal History</Text>
          {goalHistory.filter(entry => {
            if (!entry.endedAt) return true; // still active
            const s = new Date(entry.startedAt);
            const e = new Date(entry.endedAt);
            return s.getFullYear() !== e.getFullYear() || s.getMonth() !== e.getMonth() || s.getDate() !== e.getDate();
          }).length === 0 ? (
            <View style={[styles.emptyBox, { marginBottom: 16 }]}>
              <Text style={styles.emptyBody}>No goal changes recorded yet. Switch goals to start tracking.</Text>
            </View>
          ) : goalHistory.filter(entry => {
            if (!entry.endedAt) return true;
            const s = new Date(entry.startedAt);
            const e = new Date(entry.endedAt);
            return s.getFullYear() !== e.getFullYear() || s.getMonth() !== e.getMonth() || s.getDate() !== e.getDate();
          }).map((entry, i) => {
            // Goal label preference: registered meta label → humanized
            // fallback (e.g. "body_recomp" → "Body Recomp"). Previously
            // the fallback was the raw enum value, so any goal not in
            // the meta registry rendered as snake_case in the history list.
            const goalLabel = meta.goals.find(g => g.value === entry.goal)?.label ?? humanizeToken(entry.goal);
            const start = new Date(entry.startedAt);
            const end = entry.endedAt ? new Date(entry.endedAt) : null;
            const days = end
              ? Math.round((end.getTime() - start.getTime()) / 86400000)
              : Math.round((Date.now() - start.getTime()) / 86400000);
            return (
              <View key={entry.id} style={[styles.sessionCard, { marginBottom: 8 }]}>
                <View style={styles.sessionHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.sessionFocus}>{goalLabel}</Text>
                    <Text style={styles.sessionDate}>
                      {`${MONTH_NAMES[start.getMonth()]} ${start.getDate()}, ${start.getFullYear()}`}
                      {end ? ` → ${MONTH_NAMES[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}` : ' → now'}
                    </Text>
                  </View>
                  <View style={styles.sessionBadge}>
                    <Text style={styles.sessionBadgeText}>{days}d</Text>
                  </View>
                </View>
                <View style={styles.sessionStats}>
                  <Text style={styles.sessionStat}>Pace: {humanizeToken(entry.pace)}</Text>
                  {entry.startWeightLbs ? (
                    <>
                      <Text style={styles.sessionStatDot}>·</Text>
                      <Text style={styles.sessionStat}>Started at {entry.startWeightLbs} lbs</Text>
                    </>
                  ) : null}
                </View>
              </View>
            );
          })}

          {/* Workout Summaries — display cap 30 so the list stays
              scannable. Older summaries remain in storage, they just
              aren't rendered. */}
          <Text style={[styles.sectionLabel, { marginTop: 16 }]}>
            Workout Summaries
            {summaries.length > 30 ? ` · showing most recent 30 of ${summaries.length}` : ''}
          </Text>
          {summaries.length === 0 ? (
            <View style={styles.emptyBox}>
              <Ionicons name="trophy-outline" size={40} color={tc.textMuted} />
              <Text style={styles.emptyTitle}>No summaries yet</Text>
              <Text style={styles.emptyBody}>Complete a workout to see your AI-generated summary here.</Text>
            </View>
          ) : summaries.slice(0, 30).map((s, i) => (
            <View key={s.id ?? i} style={[styles.sessionCard, { gap: 8 }]}>
              <View style={styles.sessionHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.sessionFocus}>{s.focus}</Text>
                  <Text style={styles.sessionDate}>
                    {formatDate(s.date)}
                    {s.startedAt && s.endedAt
                      ? ` · ${new Date(s.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} – ${new Date(s.endedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                      : ''}
                  </Text>
                </View>
                <View style={styles.sessionBadge}>
                  <Text style={styles.sessionBadgeText}>{formatDuration(s.durationSeconds)}</Text>
                </View>
                {s.id && (
                  <TouchableOpacity
                    onPress={() => {
                      Alert.alert(
                        'Delete this summary?',
                        'Removes the AI-generated workout summary. The workout itself stays in your history.',
                        [
                          { text: 'Cancel', style: 'cancel' },
                          { text: 'Delete', style: 'destructive', onPress: async () => {
                            await deleteWorkoutSummary(s.id!);
                            setSummaries(prev => prev.filter(x => x.id !== s.id));
                          }},
                        ],
                      );
                    }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={{ paddingHorizontal: 8, paddingVertical: 4, marginLeft: 6 }}>
                    <Text style={{ fontSize: 18, color: tc.textMuted, fontWeight: '600' }}>✕</Text>
                  </TouchableOpacity>
                )}
              </View>
              <View style={styles.sessionStats}>
                <Text style={styles.sessionStat}>{s.totalSets} sets</Text>
                <Text style={styles.sessionStatDot}>·</Text>
                <Text style={styles.sessionStat}>{s.totalReps} reps</Text>
                <Text style={styles.sessionStatDot}>·</Text>
                <Text style={styles.sessionStat}>~{s.caloriesBurned} kcal</Text>
              </View>
              <Text style={{ fontSize: 13, color: tc.textSecondary, lineHeight: 19 }}>{s.motivationMessage}</Text>
              {s.achievements?.length > 0 && (
                <View style={{ gap: 3 }}>
                  {s.achievements.map((a, ai) => (
                    <Text key={ai} style={{ fontSize: 12, color: tc.textMuted }}>• {a}</Text>
                  ))}
                </View>
              )}
              {/* End-of-workout feedback the user filled in on the
                  summary modal. Optional — older summaries predate
                  this field and just don't render the block. */}
              {s.feedback && (
                <View style={{
                  marginTop: 8,
                  paddingTop: 10,
                  borderTopWidth: 1,
                  borderTopColor: tc.border,
                  gap: 4,
                }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                    How it felt
                  </Text>
                  <Text style={{ fontSize: 13, color: tc.textPrimary }}>
                    {s.feedback.feeling} · intensity {s.feedback.intensity}/5
                    {s.feedback.sorenessAreas?.length ? ` · sore: ${s.feedback.sorenessAreas.join(', ')}` : ''}
                  </Text>
                  {s.feedback.notes ? (
                    <Text style={{ fontSize: 12, color: tc.textSecondary, fontStyle: 'italic' }}>
                      "{s.feedback.notes}"
                    </Text>
                  ) : null}
                </View>
              )}
              {/* Full per-exercise detail — exactly what the user
                  did. Only shown for summaries that include the
                  exercises array (all new summaries going forward). */}
              {s.exercises && s.exercises.length > 0 && (
                <View style={{
                  marginTop: 8,
                  paddingTop: 10,
                  borderTopWidth: 1,
                  borderTopColor: tc.border,
                  gap: 8,
                }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                    What you did
                  </Text>
                  {s.exercises.map((sx, xi) => (
                    <View key={xi} style={{ gap: 2 }}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>
                        {sx.name}
                      </Text>
                      {sx.sets.length === 0 ? (
                        <Text style={{ fontSize: 12, color: tc.textMuted }}>no sets logged</Text>
                      ) : (
                        sx.sets.map((set, si) => {
                          const hasDuration = (set as any).durationSeconds != null;
                          const durMin = hasDuration ? Math.floor((set as any).durationSeconds / 60) : 0;
                          const durSec = hasDuration ? (set as any).durationSeconds % 60 : 0;
                          const line = hasDuration
                            ? `Set ${set.setNumber}: ${durMin}:${String(durSec).padStart(2, '0')}`
                            : `Set ${set.setNumber}: ${set.weightLbs} lb × ${set.reps}${set.feedback ? ` · ${set.feedback}` : ''}`;
                          return (
                            <Text key={si} style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 17 }}>
                              {line}
                            </Text>
                          );
                        })
                      )}
                    </View>
                  ))}
                </View>
              )}
            </View>
          ))}

          {/* Plan Change History — display cap 20. The full log still
              lives in storage for audit / debug purposes. */}
          <Text style={[styles.sectionLabel, { marginTop: 16 }]}>
            Plan Change History
            {planChanges.length > 20 ? ` · showing most recent 20 of ${planChanges.length}` : ''}
          </Text>
          {planChanges.length === 0 ? (
            <View style={[styles.emptyBox, { marginBottom: 24 }]}>
              <Ionicons name="clipboard-outline" size={40} color={tc.textMuted} />
              <Text style={styles.emptyTitle}>No plan changes yet</Text>
              <Text style={styles.emptyBody}>When your trainer or nutritionist updates your plan via chat, the changes will be logged here.</Text>
            </View>
          ) : planChanges.slice(0, 20).map((c, i) => {
            const d = new Date(c.changedAt);
            const label = `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
            return (
              <View key={c.id ?? i} style={[styles.sessionCard, { gap: 6, marginBottom: 8 }]}>
                <View style={styles.sessionHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.sessionFocus}>{c.changedBy === 'trainer' ? 'Trainer Update' : 'Nutritionist Update'}</Text>
                    <Text style={styles.sessionDate}>{label}</Text>
                  </View>
                  {c.id && (
                    <TouchableOpacity
                      onPress={() => {
                        Alert.alert(
                          'Delete this entry?',
                          'Removes this plan change from your history. The plan itself stays unchanged.',
                          [
                            { text: 'Cancel', style: 'cancel' },
                            { text: 'Delete', style: 'destructive', onPress: async () => {
                              await deletePlanChange(c.id!);
                              setPlanChanges(prev => prev.filter(x => x.id !== c.id));
                            }},
                          ],
                        );
                      }}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={{ paddingHorizontal: 8, paddingVertical: 4, marginLeft: 6 }}>
                      <Text style={{ fontSize: 18, color: tc.textMuted, fontWeight: '600' }}>✕</Text>
                    </TouchableOpacity>
                  )}
                </View>
                <Text style={{ fontSize: 12, color: tc.textMuted, fontStyle: 'italic', marginBottom: 2 }}>You asked: "{c.question.length > 80 ? c.question.slice(0, 80) + '…' : c.question}"</Text>
                <Text style={{ fontSize: 13, color: tc.textSecondary, lineHeight: 19 }}>{c.summary}</Text>
              </View>
            );
          })}
        </ScrollView>
      ) : tab === 'body' ? (
        /* ── Body Scan Tab ─────────────────────────────────────────── */
        <ScrollView contentContainerStyle={styles.content}>
          {/* Apple Health — three render states:
               1. Not enabled → show Connect button
               2. Enabled but HealthKit returned all null → show "Open iOS Settings"
               3. Has data → show vitals grid */}
          {isHealthKitAvailable() && (() => {
            const hasAnyData =
              healthSummary && (
                healthSummary.restingHeartRate != null ||
                healthSummary.avgSteps7d != null ||
                healthSummary.lastNightSleepHours != null ||
                healthSummary.avgSleepHours7d != null ||
                healthSummary.workouts7d != null ||
                healthSummary.activeEnergy7d != null
              );

            const handleConnect = async () => {
              setHealthConnecting(true);
              try { await persistAppleHealthEnabled(true); } catch {}
              setHealthEnabled(true);
              try {
                const granted = await requestHealthPermissions();
                const fresh = await readHealthSummary();
                if (fresh) {
                  setHealthSummary(fresh);
                  saveHealthSummary(fresh).catch(() => null);
                }
                const hasAny = fresh && (
                  fresh.restingHeartRate != null || fresh.avgSteps7d != null ||
                  fresh.lastNightSleepHours != null || fresh.avgSleepHours7d != null ||
                  fresh.workouts7d != null || fresh.activeEnergy7d != null
                );
                // If init succeeded but no data came back, prompt user to
                // check Settings (iOS's permission sheet may have been
                // bypassed because they already answered it once).
                if (granted && !hasAny) {
                  Alert.alert(
                    'No data yet',
                    'Apple Health is connected but no data came back. Open iPhone Settings → Privacy & Security → Health → Thallo and enable the categories you want to share.',
                  );
                } else if (!granted) {
                  Alert.alert(
                    'HealthKit not available',
                    'iOS rejected the HealthKit request. This usually means the provisioning profile doesn\'t include HealthKit — regenerate it via `eas credentials` and rebuild.',
                  );
                }
              } catch (e: any) {
                Alert.alert('Apple Health error', String(e?.message ?? e));
              } finally {
                setHealthConnecting(false);
              }
            };

            const handleOpenSettings = () => {
              Linking.openURL('app-settings:').catch(() => {
                Alert.alert('Unable to open Settings', 'Go to iPhone Settings → Privacy & Security → Health → Thallo manually.');
              });
            };

            return (
              <View style={styles.vitalsCard}>
                <View style={styles.vitalsHeader}>
                  <Ionicons name="heart-outline" size={16} color={tc.primary} />
                  <Text style={[styles.vitalsTitle, { color: tc.textPrimary }]}>Apple Health</Text>
                  {healthEnabled && hasAnyData ? (
                    <Text style={[styles.vitalsSubtitle, { color: tc.textMuted }]}>Today's vitals</Text>
                  ) : null}
                </View>

                {!healthEnabled ? (
                  <>
                    <Text style={{ fontSize: 13, color: tc.textSecondary, lineHeight: 18, marginBottom: 12 }}>
                      Connect Apple Health to see your resting heart rate, sleep, steps, and workouts — and get a more accurate fitness score.
                    </Text>
                    <TouchableOpacity
                      style={{ backgroundColor: tc.primary, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' }}
                      onPress={handleConnect}
                      disabled={healthConnecting}
                    >
                      {healthConnecting
                        ? <ActivityIndicator color="#fff" />
                        : <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Connect Apple Health</Text>}
                    </TouchableOpacity>
                  </>
                ) : !hasAnyData ? (
                  <>
                    <Text style={{ fontSize: 13, color: tc.textSecondary, lineHeight: 18, marginBottom: 12 }}>
                      Connected, but no data is coming through yet. Either your Watch hasn't synced, or permission categories are off in iOS Settings.
                    </Text>
                    <TouchableOpacity
                      style={{ borderWidth: 1, borderColor: tc.border, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' }}
                      onPress={handleOpenSettings}
                    >
                      <Text style={{ color: tc.textPrimary, fontWeight: '700', fontSize: 14 }}>Open iOS Settings</Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <View style={styles.vitalsGrid}>
                    <View style={styles.vitalsCell}>
                      <Text style={[styles.vitalsValue, { color: tc.textPrimary }]}>{healthSummary!.restingHeartRate ?? '—'}</Text>
                      <Text style={[styles.vitalsLabel, { color: tc.textMuted }]}>Resting HR</Text>
                    </View>
                    <View style={styles.vitalsCell}>
                      <Text style={[styles.vitalsValue, { color: tc.textPrimary }]}>
                        {healthSummary!.lastNightSleepHours != null ? `${healthSummary!.lastNightSleepHours}h` : '—'}
                      </Text>
                      <Text style={[styles.vitalsLabel, { color: tc.textMuted }]}>Last night</Text>
                    </View>
                    <View style={styles.vitalsCell}>
                      <Text style={[styles.vitalsValue, { color: tc.textPrimary }]}>
                        {healthSummary!.avgSteps7d != null ? healthSummary!.avgSteps7d.toLocaleString() : '—'}
                      </Text>
                      <Text style={[styles.vitalsLabel, { color: tc.textMuted }]}>Steps (7d avg)</Text>
                    </View>
                    <View style={styles.vitalsCell}>
                      <Text style={[styles.vitalsValue, { color: tc.textPrimary }]}>{healthSummary!.workouts7d ?? '—'}</Text>
                      <Text style={[styles.vitalsLabel, { color: tc.textMuted }]}>Workouts (7d)</Text>
                    </View>
                    <View style={styles.vitalsCell}>
                      <Text style={[styles.vitalsValue, { color: tc.textPrimary }]}>
                        {healthSummary!.activeEnergy7d != null ? healthSummary!.activeEnergy7d.toLocaleString() : '—'}
                      </Text>
                      <Text style={[styles.vitalsLabel, { color: tc.textMuted }]}>Active cal (7d)</Text>
                    </View>
                    <View style={styles.vitalsCell}>
                      <Text style={[styles.vitalsValue, { color: tc.textPrimary }]}>
                        {healthSummary!.avgSleepHours7d != null ? `${healthSummary!.avgSleepHours7d}h` : '—'}
                      </Text>
                      <Text style={[styles.vitalsLabel, { color: tc.textMuted }]}>Sleep (7d avg)</Text>
                    </View>
                  </View>
                )}
              </View>
            );
          })()}

          {/* Combined Health Score — backward-looking, requires 14 days */}
          {(() => {
            const completedWorkouts = history.filter(s => s.completed);
            const allDates = new Set(completedWorkouts.map(s => s.date?.slice(0, 10)).filter(Boolean));
            const daysOfData = allDates.size;
            const DAYS_REQUIRED = 14;

            if (daysOfData < DAYS_REQUIRED) {
              return (
                <View style={{ backgroundColor: tc.surface, borderRadius: radius.lg, padding: 20, marginBottom: 14, borderWidth: 1, borderColor: tc.border, alignItems: 'center' }}>
                  <Ionicons name="heart-circle-outline" size={32} color={tc.textMuted} />
                  <Text style={{ fontSize: 16, fontWeight: '700', color: tc.textPrimary, marginTop: 8 }}>Health Score</Text>
                  <Text style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center', marginTop: 4, lineHeight: 18 }}>
                    {DAYS_REQUIRED - daysOfData} more day{DAYS_REQUIRED - daysOfData !== 1 ? 's' : ''} of logging to unlock your score
                  </Text>
                  <View style={{ width: '100%', height: 4, borderRadius: 2, backgroundColor: tc.border, marginTop: 12 }}>
                    <View style={{ width: `${Math.min(100, (daysOfData / DAYS_REQUIRED) * 100)}%` as any, height: 4, borderRadius: 2, backgroundColor: tc.primary }} />
                  </View>
                  <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 4 }}>{daysOfData} / {DAYS_REQUIRED} days</Text>
                </View>
              );
            }

            // Compute backward-looking scores
            const targetPerWeek = userProfile.daysPerWeek || 4;
            const expectedWorkouts = Math.round(targetPerWeek * (daysOfData / 7));
            const workoutAdherence = expectedWorkouts > 0 ? Math.min(1, completedWorkouts.length / expectedWorkouts) : 0;
            const activityScore = Math.round(workoutAdherence * 100);

            // Nutrition: use real meal averages when available, fall back to diet consistency
            let nutScore = dietScore ? dietScore.total : 50;
            let nutDetail = dietScore ? `${dietScore.mealsChecked}/${dietScore.mealsExpected} meals logged` : '';
            if (mealAverages && mealAverages.days_with_data >= 2) {
              const targetCal = nutritionPlan?.targets?.calories || 2200;
              const targetPro = nutritionPlan?.targets?.protein || 150;
              // Calorie adherence: 40 points — how close avg calories are to target
              const calRatio = targetCal > 0 ? mealAverages.avg_calories / targetCal : 0;
              const calAdherence = Math.round(Math.max(0, (1 - Math.abs(1 - calRatio)) * 40));
              // Protein adherence: 35 points — avg protein vs target
              const proRatio = targetPro > 0 ? Math.min(1, mealAverages.avg_protein_g / targetPro) : 0;
              const proAdherence = Math.round(proRatio * 35);
              // Logging consistency: 25 points — days_with_data / window_days
              const logConsistency = Math.round((mealAverages.days_with_data / mealAverages.window_days) * 25);
              nutScore = Math.min(100, calAdherence + proAdherence + logConsistency);
              nutDetail = `${Math.round(mealAverages.avg_calories)} / ${targetCal} cal avg`;
            }
            const combined = Math.round(activityScore * 0.5 + nutScore * 0.5);
            const scoreColor = combined >= 70 ? '#22C55E' : combined >= 45 ? '#F59E0B' : '#EF4444';
            const rating = combined >= 80 ? 'Excellent' : combined >= 65 ? 'Good' : combined >= 45 ? 'Fair' : 'Needs work';

            return (
              <View style={{ backgroundColor: tc.surface, borderRadius: radius.lg, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: tc.border }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <Ionicons name="heart-circle-outline" size={22} color={tc.primary} />
                  <Text style={{ fontSize: 17, fontWeight: '700', color: tc.textPrimary, flex: 1 }}>Health Score</Text>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ fontSize: 28, fontWeight: '900', color: scoreColor }}>{combined}</Text>
                    <Text style={{ fontSize: 10, color: tc.textMuted }}>{rating} · {daysOfData}d data</Text>
                  </View>
                </View>
                {[
                  { label: 'Activity', value: activityScore, color: tc.primary, detail: `${completedWorkouts.length}/${expectedWorkouts} workouts` },
                  { label: 'Nutrition', value: nutScore, color: '#22C55E', detail: nutDetail },
                ].map(s => (
                  <View key={s.label} style={{ marginBottom: 8 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Text style={{ fontSize: 12, fontWeight: '600', color: tc.textSecondary, width: 70 }}>{s.label}</Text>
                      <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: tc.border }}>
                        <View style={{ width: `${Math.min(100, s.value)}%` as any, height: 6, borderRadius: 3, backgroundColor: s.color }} />
                      </View>
                      <Text style={{ fontSize: 11, fontWeight: '700', color: s.color, width: 28, textAlign: 'right' }}>{s.value}</Text>
                    </View>
                    {s.detail ? <Text style={{ fontSize: 10, color: tc.textMuted, marginLeft: 78, marginTop: 2 }}>{s.detail}</Text> : null}
                  </View>
                ))}
              </View>
            );
          })()}

          {/* Muscle Recovery — shared component matches the Workout tab header */}
          {muscleFatigue && (
            <RecoveryCard data={muscleFatigue as any} themeName={themeName} defaultExpanded />
          )}
          {/* Legacy block kept as unreachable fallback while we verify the
              shared component covers every placement. Gated off. */}
          {false && muscleFatigue && (
            <View style={{ backgroundColor: tc.surface, borderRadius: radius.lg, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: tc.border }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <Ionicons
                  name={muscleFatigue.score >= 65 ? 'battery-full' : muscleFatigue.score >= 40 ? 'battery-half' : 'battery-dead'}
                  size={22}
                  color={muscleFatigue.score >= 65 ? '#22C55E' : muscleFatigue.score >= 40 ? '#F59E0B' : '#EF4444'}
                />
                <Text style={{ fontSize: 17, fontWeight: '700', color: tc.textPrimary, flex: 1 }}>
                  Recovery: {muscleFatigue.label} ({muscleFatigue.score}%)
                </Text>
              </View>
              {(() => {
                const muscles = Object.entries(muscleFatigue.muscleFatigue || {})
                  .filter(([k]) => k !== 'cardio' && k !== 'systemic')
                  .sort((a, b) => b[1] - a[1]);
                if (muscles.length === 0 || muscles.every(([, v]) => v < 0.05)) {
                  return <Text style={{ fontSize: 13, color: tc.textMuted }}>All muscle groups are fresh and recovered.</Text>;
                }
                return (
                  <View style={{ gap: 6 }}>
                    {muscles.filter(([, v]) => v >= 0.05).map(([muscle, value]) => {
                      const pct = Math.min(100, Math.round(value * 100));
                      const color = pct >= 70 ? '#EF4444' : pct >= 40 ? '#F59E0B' : '#22C55E';
                      return (
                        <View key={muscle} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <Text style={{ fontSize: 11, fontWeight: '600', color: tc.textSecondary, width: 70 }}>{muscle.replace('_', ' ')}</Text>
                          <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: tc.border }}>
                            <View style={{ width: `${pct}%` as any, height: 6, borderRadius: 3, backgroundColor: color }} />
                          </View>
                          <Text style={{ fontSize: 10, fontWeight: '700', color, width: 30, textAlign: 'right' }}>{pct}%</Text>
                        </View>
                      );
                    })}
                    {(muscleFatigue.muscleFatigue?.cardio ?? 0) >= 0.05 && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
                        <Text style={{ fontSize: 11, fontWeight: '600', color: tc.textSecondary, width: 70 }}>cardio</Text>
                        <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: tc.border }}>
                          <View style={{ width: `${Math.min(100, Math.round((muscleFatigue.muscleFatigue?.cardio ?? 0) * 100))}%` as any, height: 6, borderRadius: 3, backgroundColor: '#3B82F6' }} />
                        </View>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: '#3B82F6', width: 30, textAlign: 'right' }}>{Math.round((muscleFatigue.muscleFatigue?.cardio ?? 0) * 100)}%</Text>
                      </View>
                    )}
                  </View>
                );
              })()}
            </View>
          )}

          {/* Weight Trend */}
          <View style={{ backgroundColor: tc.surface, borderRadius: radius.lg, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: tc.border }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Ionicons name="scale-outline" size={22} color={tc.primary} />
              <Text style={{ fontSize: 17, fontWeight: '700', color: tc.textPrimary, flex: 1 }}>Weight</Text>
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: tc.primary, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 6 }}
                onPress={() => {
                  setWeightInputValue(weightEntries.length > 0 ? String(weightEntries[weightEntries.length - 1].weightLbs) : '');
                  setWeightInputVisible(true);
                }}>
                <Ionicons name="add" size={16} color="#fff" />
                <Text style={{ fontSize: 13, fontWeight: '600', color: '#fff' }}>Log</Text>
              </TouchableOpacity>
            </View>
            {weightEntries.length === 0 ? (
              <Text style={{ fontSize: 13, color: tc.textMuted, textAlign: 'center', paddingVertical: 8 }}>
                Update your weight in profile settings to start tracking.
              </Text>
            ) : (
              <>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 }}>
                  <View>
                    <Text style={{ fontSize: 28, fontWeight: '800', color: tc.textPrimary }}>
                      {weightEntries[weightEntries.length - 1].weightLbs} <Text style={{ fontSize: 14, fontWeight: '500', color: tc.textMuted }}>lbs</Text>
                    </Text>
                    <Text style={{ fontSize: 11, color: tc.textMuted }}>
                      {new Date(weightEntries[weightEntries.length - 1].date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </Text>
                  </View>
                  {weightEntries.length >= 2 && (() => {
                    const first = weightEntries[0];
                    const last = weightEntries[weightEntries.length - 1];
                    const diff = Math.round((last.weightLbs - first.weightLbs) * 10) / 10;
                    const color = diff < 0 ? (tc.success ?? '#22C55E') : diff > 0 ? (tc.warning ?? '#F59E0B') : tc.textMuted;
                    return (
                      <View style={{ alignItems: 'flex-end' }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          <Ionicons name={diff < 0 ? 'trending-down' : diff > 0 ? 'trending-up' : 'remove'} size={18} color={color} />
                          <Text style={{ fontSize: 16, fontWeight: '700', color }}>
                            {diff > 0 ? '+' : ''}{diff} lbs
                          </Text>
                        </View>
                        <Text style={{ fontSize: 11, color: tc.textMuted }}>
                          since {new Date(first.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </Text>
                      </View>
                    );
                  })()}
                </View>
                {/* Goal progress */}
                {(() => {
                  const target = userProfile.goalDetails?.targetWeightLbs;
                  const start = userProfile.goalDetails?.startWeightLbs ?? weightEntries[0]?.weightLbs;
                  const curr = weightEntries[weightEntries.length - 1]?.weightLbs ?? currentWeight;
                  const remaining = target ? Math.abs(target - curr) : null;
                  return (
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: tc.border }}>
                      {start != null && (
                        <View style={{ alignItems: 'center' }}>
                          <Text style={{ fontSize: 11, color: tc.textMuted }}>Start</Text>
                          <Text style={{ fontSize: 15, fontWeight: '700', color: tc.textSecondary }}>{start}</Text>
                        </View>
                      )}
                      <View style={{ alignItems: 'center' }}>
                        <Text style={{ fontSize: 11, color: tc.textMuted }}>Current</Text>
                        <Text style={{ fontSize: 15, fontWeight: '700', color: tc.textPrimary }}>{curr}</Text>
                      </View>
                      {target != null && (
                        <View style={{ alignItems: 'center' }}>
                          <Text style={{ fontSize: 11, color: tc.textMuted }}>Target</Text>
                          <Text style={{ fontSize: 15, fontWeight: '700', color: tc.primary }}>{target}</Text>
                        </View>
                      )}
                      {remaining != null && (
                        <View style={{ alignItems: 'center' }}>
                          <Text style={{ fontSize: 11, color: tc.textMuted }}>Remaining</Text>
                          <Text style={{ fontSize: 15, fontWeight: '700', color: tc.textSecondary }}>{remaining.toFixed(1)}</Text>
                        </View>
                      )}
                    </View>
                  );
                })()}
                {/* Weight log */}
                {weightEntries.slice(-10).reverse().map((e, i) => (
                  <View key={e.date} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderTopWidth: i > 0 ? 1 : 0, borderTopColor: tc.border }}>
                    <Text style={{ fontSize: 13, color: tc.textSecondary }}>
                      {new Date(e.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                    </Text>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: tc.textPrimary }}>
                      {e.weightLbs} lbs
                    </Text>
                  </View>
                ))}
              </>
            )}
          </View>

          {/* Scan buttons */}
          <View style={styles.bodyScanPrompt}>
            <Ionicons name="body-outline" size={40} color={tc.primary} style={{ alignSelf: 'center' }} />
            <Text style={styles.bodyScanPromptTitle}>Body Check</Text>
            <Text style={styles.bodyScanPromptText}>
              Take a front-facing photo to estimate body fat percentage, muscle mass, and get personalized feedback.
            </Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
              <TouchableOpacity
                style={[styles.bodyScanBtn, { flex: 1 }]}
                onPress={() => handleBodyScan('camera')}
                disabled={bodyScanLoading}>
                <Text style={styles.bodyScanBtnText}><Ionicons name="camera-outline" size={16} /> Camera</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.bodyScanBtn, { flex: 1, backgroundColor: tc.surfaceRaised, borderWidth: 1, borderColor: tc.border }]}
                onPress={() => handleBodyScan('library')}
                disabled={bodyScanLoading}>
                <Text style={[styles.bodyScanBtnText, { color: tc.textPrimary }]}><Ionicons name="images-outline" size={16} /> Library</Text>
              </TouchableOpacity>
            </View>
            <Text style={{ fontSize: 10, color: tc.textMuted, textAlign: 'center', marginTop: 6, lineHeight: 14 }}>
              For best results: front-facing, good lighting, minimal clothing. Accuracy varies with lighting and angle.
            </Text>
          </View>

          {/* Loading */}
          {bodyScanLoading && (
            <View style={{ alignItems: 'center', paddingVertical: 30, gap: 10 }}>
              <ActivityIndicator size="large" color={tc.primary} />
              <Text style={{ fontSize: 13, color: tc.textSecondary }}>Analyzing...</Text>
            </View>
          )}

          {/* Latest result */}
          {bodyScanResult && !bodyScanLoading && (
            <>
            <ViewShot ref={bodyScanShareRef} options={{ format: 'png', quality: 1 }}>
            <View style={styles.bodyScanResultCard}>
              <View style={styles.bodyScanResultHeader}>
                <View>
                  <Text style={styles.bodyScanResultCategory}>{bodyScanResult.category}</Text>
                  <Text style={styles.bodyScanResultMuscle}>
                    Muscle mass: {bodyScanResult.muscleMass.replace('_', ' ')}
                  </Text>
                </View>
                <View style={styles.bodyScanBfCircle}>
                  <Text style={styles.bodyScanBfValue}>{bodyScanResult.bodyFatPct}%</Text>
                  <Text style={styles.bodyScanBfLabel}>Body Fat</Text>
                </View>
              </View>
              <Text style={{ fontSize: 11, color: tc.textMuted, marginBottom: 6 }}>
                Estimated range: {bodyScanResult.bodyFatRange}
              </Text>

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
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>Share Result</Text>
            </TouchableOpacity>
            </>
          )}

          {/* History */}
          {bodyScanHistory.length > 0 && (
            <>
              <Text style={[styles.sectionLabel, { marginTop: 16 }]}>Scan History</Text>
              {bodyScanHistory.map((entry) => {
                const d = new Date(entry.date);
                return (
                  <View key={entry.id} style={styles.bodyScanHistoryCard}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <View>
                        <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }}>{entry.category}</Text>
                        <Text style={{ fontSize: 11, color: tc.textMuted }}>
                          {MONTH_NAMES[d.getMonth()]} {d.getDate()}, {d.getFullYear()}
                          {entry.weightLbs ? `  ·  ${entry.weightLbs} lbs` : ''}
                        </Text>
                      </View>
                      <View style={{ alignItems: 'center' }}>
                        <Text style={{ fontSize: 20, fontWeight: '800', color: tc.primary }}>{entry.bodyFatPct}%</Text>
                        <Text style={{ fontSize: 9, color: tc.textMuted, textTransform: 'uppercase' }}>Body Fat</Text>
                      </View>
                    </View>
                    <Text style={{ fontSize: 12, color: tc.textSecondary, marginTop: 6, lineHeight: 17 }}>{entry.assessment}</Text>
                  </View>
                );
              })}
            </>
          )}
        </ScrollView>
      ) : null}
      {/* Weight Log Modal */}
      {weightInputVisible && (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', zIndex: 999 }}>
          <View style={{ backgroundColor: tc.surface, borderRadius: radius.lg, padding: 24, width: '80%', maxWidth: 320, borderWidth: 1, borderColor: tc.border }}>
            <Text style={{ fontSize: 17, fontWeight: '700', color: tc.textPrimary, marginBottom: 16, textAlign: 'center' }}>Log Weight</Text>
            <TextInput
              style={{ borderWidth: 1, borderColor: tc.border, borderRadius: radius.md, padding: 14, fontSize: 18, color: tc.textPrimary, backgroundColor: tc.background, textAlign: 'center', fontWeight: '700' }}
              value={weightInputValue}
              onChangeText={setWeightInputValue}
              keyboardType="decimal-pad"
              placeholder="e.g. 175"
              placeholderTextColor={tc.textMuted}
              autoFocus
            />
            <Text style={{ fontSize: 12, color: tc.textMuted, textAlign: 'center', marginTop: 6 }}>lbs</Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <TouchableOpacity
                style={{ flex: 1, paddingVertical: 12, borderRadius: radius.md, backgroundColor: tc.surfaceRaised, alignItems: 'center', borderWidth: 1, borderColor: tc.border }}
                onPress={() => setWeightInputVisible(false)}>
                <Text style={{ fontSize: 15, fontWeight: '600', color: tc.textSecondary }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{ flex: 1, paddingVertical: 12, borderRadius: radius.md, backgroundColor: tc.primary, alignItems: 'center' }}
                onPress={async () => {
                  const val = parseFloat(weightInputValue);
                  if (!val || val < 50 || val > 700) {
                    Alert.alert('Invalid weight', 'Please enter a weight between 50 and 700 lbs.');
                    return;
                  }
                  const { saveWeightEntry } = await import('../utils/weightHistory');
                  const updated = await saveWeightEntry(val, 'manual');
                  setWeightEntries(updated);
                  setWeightInputVisible(false);
                  // Sync to profile so macros/goal progress update too
                  if (onUpdateWeight) onUpdateWeight(val);
                  import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
                }}>
                <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}
      <LogActivityModal
        visible={showLogActivity}
        onClose={() => setShowLogActivity(false)}
        themeName={themeName}
        onSave={async (session) => {
          await saveWorkoutSession(session);
          if (authToken) {
            try {
              const { logWorkoutDone } = await import('../services/api');
              const dk = dateKey(new Date(session.date));
              await logWorkoutDone(
                authToken, dk, session.focus, session.durationSeconds,
                undefined,
                session.manualActivity ? {
                  category: session.manualActivity.category,
                  subtype: session.manualActivity.subtype,
                  intensity: session.manualActivity.intensity,
                  source: session.manualActivity.source,
                  cardioStyle: session.manualActivity.cardioStyle,
                } : undefined,
              );
            } catch {}
          }
          const [h, s] = await Promise.all([loadWorkoutHistory(), loadWorkoutSummaries()]);
          setHistory(h);
          setSummaries(s);
          import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
        }}
      />
    </View>
  );
}

function createStyles(colors: ReturnType<typeof getTheme>['colors']) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 56, paddingBottom: 14,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  backBtn: { fontSize: 15, color: colors.primary, fontWeight: '600', width: 60 },
  title:   { fontSize: 18, fontWeight: '700', color: colors.textPrimary },

  tabs: {
    flexDirection: 'row', gap: 3,
    backgroundColor: colors.surface, borderRadius: radius.md,
    padding: 3, borderWidth: 1, borderColor: colors.border,
    marginHorizontal: 16, marginTop: 8, marginBottom: 4,
  },
  tab:           { flex: 1, paddingVertical: 9, borderRadius: radius.sm, alignItems: 'center' },
  tabActive:     { backgroundColor: colors.primary },
  tabText:       { fontSize: 11, fontWeight: '600', color: colors.textSecondary },
  tabTextActive: { color: colors.background },

  center:  { flex: 1, justifyContent: 'center', alignItems: 'center' },
  // Bottom padding clears the fixed 5-tab bottom nav bar (~57 px +
  // safe area). Otherwise the bottom of the content (sign-out,
  // delete-last-entry, etc.) sits under the tab bar.
  content: { padding: 16, paddingBottom: 140 },

  sectionLabel: {
    fontSize: 11, fontWeight: '700', color: colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12,
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
    backgroundColor: colors.surface, borderRadius: radius.md,
    padding: 14, marginBottom: 8,
    borderWidth: 1, borderColor: colors.border,
    borderLeftWidth: 3, borderLeftColor: colors.primary,
  },
  prLeft:   { flex: 1 },
  prName:   { fontSize: 14, fontWeight: '600', color: colors.textPrimary, marginBottom: 3 },
  prMeta:   { fontSize: 11, color: colors.textMuted },
  prRight:  { alignItems: 'flex-end' },
  prWeight: { fontSize: 22, fontWeight: '800', color: colors.primary },
  prUnit:   { fontSize: 11, color: colors.textSecondary, marginTop: -4 },
  prReps:   { fontSize: 12, color: colors.textMuted, marginTop: 2 },

  insightsCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginBottom: 12,
  },
  insightsTitle: { fontSize: 14, fontWeight: '700', color: colors.textPrimary, marginBottom: 8 },
  insightsLine: { fontSize: 12, color: colors.textSecondary, marginBottom: 4 },
  guardrailText: { fontSize: 12, color: colors.warning, marginBottom: 3 },
  memoryText: { fontSize: 12, color: colors.textSecondary, marginBottom: 3 },
  progressionHint: { fontSize: 12, color: colors.primary, marginTop: 4, fontWeight: '600' },

  weightCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginBottom: 12,
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
  weightConfirmText: { fontSize: 13, fontWeight: '700', color: '#fff' },
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
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginBottom: 12,
  },
  graphHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 },
  graphTitle: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  graphScore: { fontSize: 20, fontWeight: '800', color: colors.primary },
  graphSubtitle: { fontSize: 12, color: colors.textSecondary, marginBottom: 10 },
  graphBars: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 6, minHeight: 120 },
  graphBarCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', gap: 4 },
  graphBarValue: { fontSize: 10, color: colors.textMuted },
  graphBar: { width: '75%', backgroundColor: colors.primary, borderRadius: 6 },
  graphBarLabel: { fontSize: 10, color: colors.textSecondary },

  sessionCard: {
    backgroundColor: colors.surface, borderRadius: radius.md,
    padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: colors.border,
  },
  sessionHeader: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 },
  sessionFocus:  { fontSize: 15, fontWeight: '700', color: colors.textPrimary, marginBottom: 2 },
  sessionDate:   { fontSize: 12, color: colors.textMuted },
  sessionBadge:  { backgroundColor: colors.surfaceRaised, borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: colors.border },
  sessionBadgeText: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },
  sessionStats:  { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  sessionStat:   { fontSize: 12, color: colors.textSecondary },
  sessionStatDot:{ fontSize: 12, color: colors.textMuted },
  exRow:    { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  exName:   { fontSize: 13, color: colors.textPrimary },
  exBest:   { fontSize: 13, color: colors.primary, fontWeight: '600' },

  exerciseChip: {
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  exerciseChipActive: { borderColor: colors.primary, backgroundColor: colors.primary + '20' },
  exerciseChipText: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },
  exerciseChipTextActive: { color: colors.primary },

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
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    marginBottom: 16,
    gap: 12,
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

  // ── Apple Health vitals card (Body Check tab) ──
  vitalsCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  vitalsHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  vitalsTitle: { fontSize: 14, fontWeight: '700' },
  vitalsSubtitle: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginLeft: 'auto' },
  vitalsGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  vitalsCell: { width: '33.333%', paddingVertical: 8, alignItems: 'center' },
  vitalsValue: { fontSize: 18, fontWeight: '700' },
  vitalsLabel: { fontSize: 10, fontWeight: '600', marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 },

  // ── Recovery / Apple Health ──
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

  // ── Body Scan ──
  bodyScanPrompt: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 20,
    alignItems: 'center',
    gap: 6,
    marginBottom: 16,
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
  bodyScanBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#fff',
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
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.primary + '15',
    borderWidth: 3,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bodyScanBfValue: {
    fontSize: 20,
    fontWeight: '900',
    color: colors.primary,
  },
  bodyScanBfLabel: {
    fontSize: 9,
    color: colors.textMuted,
    textTransform: 'uppercase',
    fontWeight: '600',
    marginTop: -2,
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
