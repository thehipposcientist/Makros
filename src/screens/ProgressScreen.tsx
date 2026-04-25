import { useState, useEffect, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator,
  TextInput, Alert, Image, Linking, Modal, Animated,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { LayoutAnimation, UIManager, Platform } from 'react-native';
import FadeInView from '../components/FadeInView';
import StreakCounter from '../components/StreakCounter';
import AnimatedNumber from '../components/AnimatedNumber';
import { WorkoutDaySkeleton } from '../components/SkeletonLoader';
import { configureExpandAnimation } from '../utils/layoutAnim';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import ViewShot from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WorkoutSession, UserProfile, StoredWorkoutSummary, GoalHistoryEntry, PlanChangeEntry, BodyScanEntry, HealthSummary, HealthScoreResult } from '../types';
import { loadWorkoutHistory, getPersonalRecords, PR, loadWorkoutSummaries, loadGoalHistory, loadPlanChanges, loadHealthSummary, loadHealthScore, deleteWorkoutSession, deleteWorkoutSummary, deletePlanChange, saveWorkoutSession, dateKey, saveHealthSummary, isAppleHealthEnabled } from '../utils/workoutHistory';
import { readHealthSummary, isHealthKitAvailable, requestHealthPermissions, getLastHealthKitError, loadSleepHistory } from '../services/appleHealth';
import DetectedWorkoutsCard from '../components/DetectedWorkoutsCard';
import WeeklyCoachingCard from '../components/WeeklyCoachingCard';
import Zone2TargetCard from '../components/Zone2TargetCard';
import { setAppleHealthEnabled as persistAppleHealthEnabled } from '../utils/workoutHistory';
import LogActivityModal from '../components/LogActivityModal';
import RecoveryCard from '../components/RecoveryCard';
import AdherenceTrendCard from '../components/AdherenceTrendCard';
import { RECOVERY_LABELS } from '../utils/healthScore';
import { computeDietConsistency, DietConsistencyScore, getMealChecks } from '../utils/mealTracker';
import { computePlantDiversity, computeFiberToday, recommendedFiberTarget } from '../utils/gutHealth';
import { proteinTimingInsights } from '../utils/nutritionInsights';
import { getGoalEstimate } from '../utils/goalEstimate';
import { useMetaData } from '../hooks/useMetaData';
import { humanizeToken } from '../utils/exerciseGuide';
import { computeFitnessAge } from '../utils/fitnessAge';
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
  const height = useRef(new Animated.Value(0)).current;
  const prevTarget = useRef<number>(0);
  useEffect(() => {
    // Only run the draw-in when height changes — prevents re-triggering
    // on theme/pallette re-renders.
    if (prevTarget.current === targetHeight) return;
    prevTarget.current = targetHeight;
    Animated.timing(height, {
      toValue: targetHeight,
      duration: 800,
      delay,
      useNativeDriver: false,
    }).start();
  }, [targetHeight, delay, height]);
  return <Animated.View style={[style, { height }]} />;
}

export default function ProgressScreen({ onBack, authToken, userProfile, onUpdateWeight, themeName, noHeader = false, nutritionPlan }: ProgressScreenProps) {
  const tc = getTheme(themeName).colors;
  const styles = createStyles(tc);
  const meta = useMetaData();
  const [tab, setTab] = useState<'health' | 'body' | 'prs' | 'charts'>('health');
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [showLogActivity, setShowLogActivity] = useState(false);
  const fitnessScoreRef = useRef<ViewShot>(null);
  const bodyScanShareRef = useRef<ViewShot>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [selectedExercise, setSelectedExercise] = useState<string | null>(null);
  // Default to 'volume' — most users care about total work done per
  // session more than max load on a single set. Toggleable.
  const [chartMode, setChartMode] = useState<'weight' | 'volume'>('volume');
  // Optional muscle filter for the exercise picker. 'all' = no filter.
  const [chartMuscleFilter, setChartMuscleFilter] = useState<string>('all');
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
  const [sleepHistoryCount, setSleepHistoryCount] = useState<number>(0);
  const [healthEnabled, setHealthEnabled] = useState<boolean>(false);
  const [healthConnecting, setHealthConnecting] = useState<boolean>(false);
  const [healthScore, setHealthScore] = useState<HealthScoreResult | null>(null);
  // Diet score now always exists (mealTracker returns a zeroed
  // empty-state object instead of null). The card always renders so
  // fresh users see "log a meal to start tracking" instead of nothing.
  const [dietScore, setDietScore] = useState<DietConsistencyScore | null>(null);
  const [oneRepMaxLifts, setOneRepMaxLifts] = useState<import('../services/api').OneRepMaxLift[]>([]);
  const [plateaus, setPlateaus] = useState<import('../services/api').PlateauEntry[]>([]);
  const [plateauModalVisible, setPlateauModalVisible] = useState(false);
  const [plateauDismissed, setPlateauDismissed] = useState(true);
  const [weightEntries, setWeightEntries] = useState<import('../types').WeightEntry[]>([]);
  const [weightInputVisible, setWeightInputVisible] = useState(false);
  const [weightInputValue, setWeightInputValue] = useState('');
  const [muscleFatigue, setMuscleFatigue] = useState<{ score: number; label: string; topFatigued: Array<{ muscle: string; value: number }>; muscleFatigue: Record<string, number> } | null>(null);
  const [nutritionScore, setNutritionScore] = useState<import('../utils/nutritionScore').NutritionScoreResult | null>(null);
  const [mealAverages, setMealAverages] = useState<import('../services/api').MealAverages | null>(null);
  const [muscleBalance, setMuscleBalance] = useState<import('../services/api').MuscleBalanceResult | null>(null);
  const [muscleBalanceExpanded, setMuscleBalanceExpanded] = useState(false);
  const [gutInsights, setGutInsights] = useState<{
    plantCount: number;
    plantTier: 'on_track' | 'building' | 'low';
    plantMessage: string;
    fiberToday: { grams: number; target: number; pct: number; message: string };
    proteinFlag: { tier: 'good' | 'watch' | 'flag'; detail: string } | null;
  } | null>(null);
  const [gutHealthWindow, setGutHealthWindow] = useState<import('../services/api').GutHealthWindow | null>(null);

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
      }
    });
    if (authToken) {
      getInsights(authToken).then(setInsights).catch(() => null);
      getGuardrails(authToken).then(r => setGuardrails(r.warnings ?? [])).catch(() => null);
      getCoachMemory(authToken).then((rows: any[]) => setCoachMemory(rows.slice(0, 5))).catch(() => null);
      import('../services/api').then(({ getMealAverages }) =>
        getMealAverages(authToken, 14).then(setMealAverages).catch(() => null)
      );
      import('../services/api').then(({ getMuscleBalance }) =>
        getMuscleBalance(authToken, 14).then(setMuscleBalance).catch(() => null)
      );
      import('../services/api').then(({ getGutHealth }) =>
        getGutHealth(authToken, 14).then(r => {
          setGutHealthWindow(r.window);
        }).catch(() => null)
      );
    }
    // Load body scan history
    AsyncStorage.getItem('bodyScanHistory').then(raw => {
      if (raw) try { setBodyScanHistory(JSON.parse(raw)); } catch {}
    });

    // ── Gut / longevity insights — compute from existing meal data ──
    (async () => {
      try {
        const today = new Date();
        const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        // Rebuild a 7-day window of plans + checks by date for the diversity counter.
        const plansByDate: Record<string, import('../types').DailyNutritionPlan> = {};
        const checksByDate: Record<string, Record<string, boolean>> = {};
        for (let i = 0; i < 7; i++) {
          const d = new Date(today.getTime() - i * 86400000);
          const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          const raw = await AsyncStorage.getItem(`mealPlan_${k}`);
          if (raw) { try { plansByDate[k] = JSON.parse(raw); } catch {} }
          checksByDate[k] = await getMealChecks(k).catch(() => ({}));
        }
        // Fall back to today's passed-in nutritionPlan if AsyncStorage didn't have it.
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
        // Route through the aggregator so other cards (Zone 2,
        // weekly coaching, readiness) get the same cached value
        // without re-querying HealthKit. Falls back to direct
        // readHealthSummary if the aggregator returns null.
        const { getHealthDataSummary } = await import('../services/healthDataSummary');
        const agg = await getHealthDataSummary({ age: userProfile.physicalStats?.age ?? null });
        const fresh = agg?.raw ?? await readHealthSummary({ age: userProfile.physicalStats?.age ?? null });
        if (fresh) {
          setHealthSummary(fresh);
          saveHealthSummary(fresh).catch(() => null);
        }
        // Nights of HRV/sleep history drive the "X/14 nights" calibration UI.
        try { setSleepHistoryCount((await loadSleepHistory()).length); } catch {}
      } catch {}
    })();
    computeDietConsistency(userProfile.mealsPerDay ?? 3).then(setDietScore);
  }, [userProfile.mealsPerDay, userProfile.physicalStats?.age]);

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
          ['health', 'Health'],
          ['body', 'Body'],
          ['prs', 'PRs'],
          ['charts', 'Charts'],
        ] as const).map(([key, label]) => (
          <TouchableOpacity
            key={key}
            activeOpacity={0.7}
            style={[styles.tab, tab === key && styles.tabActive]}
            onPress={() => {
              if (tab === key) return;
              import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
              setTab(key as typeof tab);
            }}>
            <Text style={[styles.tabText, tab === key && styles.tabTextActive]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
      <FadeInView key={tab} duration={260} slideDistance={8} style={{ flex: 1 }}>
      {tab === 'charts' ? (
        <ScrollView contentContainerStyle={styles.content}>
          {prs.length === 0 ? (
            <View style={styles.emptyBox}>
              <Ionicons name="analytics-outline" size={40} color={tc.textMuted} style={{ marginBottom: 8 }} />
              <Text style={styles.emptyTitle}>Complete 3 workouts to see charts</Text>
              <Text style={styles.emptyBody}>Charts appear after your first few sessions with logged sets.</Text>
            </View>
          ) : (
            <>
              {/* Build a map of exerciseName → primary_muscle from
                  history so we can filter the PR list by muscle.
                  Falls back to 'unknown' bucket when the exercise
                  has no muscle tag (e.g. AI-generated entries before
                  the muscle plumbing landed). */}
              {(() => {
                // Build muscle lookup from history. This map is SPARSE —
                // older sessions and AI-generated exercises don't carry
                // `primaryMuscle`, so a lot of PRs miss the lookup.
                const _exMuscle: Record<string, string> = {};
                for (const s of history) {
                  for (const e of (s.exercises ?? [])) {
                    const nm = e.name?.toLowerCase();
                    const pm = (e as any).primaryMuscle ?? (e as any).primary_muscle;
                    if (nm && pm && !_exMuscle[nm]) _exMuscle[nm] = String(pm).toLowerCase();
                  }
                }
                // Name-based inference fallback. Order matters: more-
                // specific patterns must come first so e.g. "leg
                // extension" maps to quads instead of triceps, "shoulder
                // press" maps to shoulders instead of chest.
                const inferMuscleFromName = (name: string): string => {
                  const n = name.toLowerCase();
                  if (/calf/.test(n)) return 'calves';
                  if (/leg curl|hamstring|romanian|\brdl\b|good morning/.test(n)) return 'hamstrings';
                  if (/glute|hip thrust|hip bridge/.test(n)) return 'glutes';
                  if (/leg extension|squat|lunge|split squat|step.?up|leg press/.test(n)) return 'quads';
                  if (/deadlift|\brow\b|pulldown|pull.?up|chin.?up|\blat\b|lat pull/.test(n)) return 'back';
                  if (/lateral raise|front raise|rear delt|shoulder|overhead press|military press|arnold|upright row/.test(n)) return 'shoulders';
                  if (/bicep|preacher|hammer curl|\bcurl\b/.test(n)) return 'biceps';
                  if (/tricep|skull crusher|pushdown|kickback|close.?grip bench/.test(n)) return 'triceps';
                  if (/\bdip\b/.test(n)) return 'triceps';
                  if (/bench|chest|\bfly\b|push.?up|\bpec\b/.test(n)) return 'chest';
                  if (/\babs?\b|crunch|plank|\bcore\b|russian twist|leg raise|sit.?up|hollow|knee raise|woodchopper/.test(n)) return 'core';
                  return '';
                };
                const muscleFor = (name: string): string =>
                  _exMuscle[name.toLowerCase()] || inferMuscleFromName(name);

                // Coarse muscle buckets shown as filter chips. Order
                // is the most-likely-tapped muscles first.
                const _MUSCLE_BUCKETS: { id: string; label: string; matches: (m: string) => boolean }[] = [
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
                const activeBucket = _MUSCLE_BUCKETS.find(b => b.id === chartMuscleFilter) ?? _MUSCLE_BUCKETS[0];

                // Only show PRs with enough sessions to draw a real
                // trend (2+). buildExerciseTrend already returns the
                // points used by the chart below — reusing it keeps the
                // selector and the chart in sync.
                const chartablePrs = prs.filter(pr => buildExerciseTrend(history, pr.exerciseName).length >= 2);
                const filteredPrs = chartablePrs.filter(pr => {
                  if (chartMuscleFilter === 'all') return true;
                  return activeBucket.matches(muscleFor(pr.exerciseName));
                });
                return (
                  <>
                    {/* Muscle filter row */}
                    <Text style={styles.sectionLabel}>Filter by muscle</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast" contentContainerStyle={{ gap: 8, paddingBottom: 12 }}>
                      {_MUSCLE_BUCKETS.map(b => {
                        const active = chartMuscleFilter === b.id;
                        return (
                          <TouchableOpacity
                            key={b.id}
                            style={[styles.exerciseChip, active && styles.exerciseChipActive]}
                            onPress={() => setChartMuscleFilter(b.id)}>
                            <Text style={[styles.exerciseChipText, active && styles.exerciseChipTextActive]}>
                              {b.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>

                    {/* Exercise selector — filtered by chosen muscle.
                        Explicit empty state instead of silently falling
                        back to all PRs (which made the filter look
                        broken). */}
                    <Text style={styles.sectionLabel}>Select exercise</Text>
                    {filteredPrs.length === 0 ? (
                      <Text style={{ color: tc.textMuted, fontSize: 12, marginBottom: 12 }}>
                        {chartablePrs.length === 0
                          ? 'Log at least 2 sessions of an exercise to chart its trend.'
                          : `No ${activeBucket.label.toLowerCase()} exercises with enough data yet.`}
                      </Text>
                    ) : (
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast" contentContainerStyle={{ gap: 8, paddingBottom: 12 }}>
                        {filteredPrs.map((pr, i) => (
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
                    )}
                  </>
                );
              })()}

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

          {plateaus.length > 0 && !plateauDismissed && (
            <View style={{
              marginBottom: 16,
              backgroundColor: tc.surfaceRaised,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: '#F59E0B55',
              padding: 14,
            }}>
              <TouchableOpacity
                onPress={() => setPlateauModalVisible(true)}
                activeOpacity={0.7}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Ionicons name="alert-circle-outline" size={20} color="#F59E0B" />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>
                    {plateaus.length} exercise{plateaus.length === 1 ? '' : 's'} plateaued
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={tc.textMuted} />
              </TouchableOpacity>
              <View style={{ marginTop: 10, gap: 4 }}>
                {plateaus.slice(0, 3).map((p, i) => (
                  <Text key={i} style={{ fontSize: 12, color: tc.textSecondary }}>
                    {p.exercise_name} — flat for {p.weeks_stuck} week{p.weeks_stuck === 1 ? '' : 's'}
                  </Text>
                ))}
                {plateaus.length > 3 && (
                  <Text style={{ fontSize: 11, color: tc.textMuted }}>
                    +{plateaus.length - 3} more
                  </Text>
                )}
              </View>
              {plateaus.some(p => p.suggestion === 'deload') && (
                <Text style={{ fontSize: 12, color: '#F59E0B', marginTop: 8, lineHeight: 17 }}>
                  Consider a deload week — reduce weights by 40% for one week to recover.
                </Text>
              )}
              <TouchableOpacity
                onPress={() => {
                  AsyncStorage.setItem('plateauDismissedAt', String(Date.now())).catch(() => {});
                  setPlateauDismissed(true);
                }}
                style={{
                  alignSelf: 'flex-start',
                  marginTop: 10,
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: tc.border,
                  backgroundColor: tc.surface,
                }}>
                <Text style={{ fontSize: 12, fontWeight: '600', color: tc.textSecondary }}>Dismiss</Text>
              </TouchableOpacity>
            </View>
          )}

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
                // Composite key: id + index. HK auto-imports can collide
                // on session.id when the dedup helper sees the same HK
                // workout twice across import attempts; the index makes
                // the key unique even on collision so React stops warning.
                const rowKey = `${session.id ?? 'sess'}-${i}`;
                return (
                  <FadeInView key={rowKey} delay={i * 60}>
                  <TouchableOpacity
                    style={styles.sessionCard}
                    activeOpacity={0.8}
                    onPress={() => { configureExpandAnimation(300); setExpandedSessionId(isExpanded ? null : (session.id ?? `s${i}`)); }}>
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
                            {/* HR annotation from Apple Watch (captured at
                                finish time). Same circle viz as the active
                                summary so users see consistent zone data
                                whether they're looking at the just-finished
                                workout or a past one. */}
                            {(summary.hrAvg || summary.hrMax || (summary.hrZoneMinutes && summary.hrZoneMinutes.some(m => m > 0))) && (
                              <View style={{ marginBottom: 10 }}>
                                <View style={{ flexDirection: 'row', gap: 12, marginBottom: 8 }}>
                                  {summary.hrAvg ? (
                                    <View style={{ flex: 1, alignItems: 'center', padding: 6, borderRadius: 8, backgroundColor: tc.surfaceRaised }}>
                                      <Text style={{ fontSize: 15, fontWeight: '800', color: tc.textPrimary }}>{summary.hrAvg}</Text>
                                      <Text style={{ fontSize: 9, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5 }}>AVG HR</Text>
                                    </View>
                                  ) : null}
                                  {summary.hrMax ? (
                                    <View style={{ flex: 1, alignItems: 'center', padding: 6, borderRadius: 8, backgroundColor: tc.surfaceRaised }}>
                                      <Text style={{ fontSize: 15, fontWeight: '800', color: tc.textPrimary }}>{summary.hrMax}</Text>
                                      <Text style={{ fontSize: 9, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5 }}>MAX HR</Text>
                                    </View>
                                  ) : null}
                                </View>
                                {summary.hrZoneMinutes && summary.hrZoneMinutes.some(m => m > 0) && (
                                  <View style={{ flexDirection: 'row', justifyContent: 'space-around', alignItems: 'flex-end', marginTop: 4 }}>
                                    {(['Z1', 'Z2', 'Z3', 'Z4', 'Z5'] as const).map((label, i) => {
                                      const min = summary.hrZoneMinutes![i];
                                      const peak = Math.max(...summary.hrZoneMinutes!, 1);
                                      const size = 32 + Math.round(18 * (min / peak));
                                      const zoneColor = ['#22C55E', '#EAB308', tc.primary, '#F97316', '#EF4444'][i];
                                      const isEmpty = min < 0.5;
                                      return (
                                        <View key={label} style={{ alignItems: 'center' }}>
                                          <View style={{
                                            width: size, height: size, borderRadius: size / 2,
                                            borderWidth: 2,
                                            borderColor: isEmpty ? tc.border : zoneColor,
                                            backgroundColor: isEmpty ? 'transparent' : zoneColor + '22',
                                            alignItems: 'center', justifyContent: 'center',
                                          }}>
                                            <Text style={{ fontSize: 11, fontWeight: '800', color: isEmpty ? tc.textMuted : zoneColor }}>
                                              {Math.round(min)}
                                            </Text>
                                          </View>
                                          <Text style={{ fontSize: 9, fontWeight: '800', color: isEmpty ? tc.textMuted : zoneColor, marginTop: 3, letterSpacing: 0.5 }}>
                                            {label}
                                          </Text>
                                        </View>
                                      );
                                    })}
                                  </View>
                                )}
                              </View>
                            )}
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
          }).map((entry, i, arr) => {
            const goalKey = `${entry.id ?? 'goal'}-${i}`;
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
              <View key={goalKey} style={[styles.sessionCard, { marginBottom: 8 }]}>
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
            <View key={`${s.id ?? 'sum'}-${i}`} style={[styles.sessionCard, { gap: 8 }]}>
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
                        'Delete this workout?',
                        'Removes this workout from your history (sets + summary + backend record). This affects your fatigue and weekly volume calculations. Cannot be undone.',
                        [
                          { text: 'Cancel', style: 'cancel' },
                          { text: 'Delete', style: 'destructive', onPress: async () => {
                            try {
                              // 1. Local: nuke summary + session.
                              await deleteWorkoutSummary(s.id!);
                              await deleteWorkoutSession(s.id!).catch(() => null);
                              // 2. Backend: nuke the completion row +
                              //    associated session/exercise/set rows.
                              //    Without this the workout would
                              //    re-appear after a sync (server is
                              //    source of truth for fatigue).
                              if (authToken && s.date) {
                                const dateISO = s.date.slice(0, 10);
                                const { deleteWorkoutCompletion } = await import('../services/api');
                                await deleteWorkoutCompletion(authToken, dateISO).catch(() => null);
                              }
                              setSummaries(prev => prev.filter(x => x.id !== s.id));
                              setHistory(prev => prev.filter(x => x.id !== s.id));
                              import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
                            } catch (e: any) {
                              Alert.alert('Could not delete', String(e?.message ?? e));
                            }
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
      ) : tab === 'health' ? (
        /* ── Health Tab ─────────────────────────────────────────────── */
        <ScrollView contentContainerStyle={styles.content}>
          {/* Detected Apple Health workouts — only shows when there's
              at least one HK workout that doesn't already overlap an
              existing Thallo session. Classifying it here lets
              activity_impact.py factor the workout into fatigue. */}
          {/* Zone 2 weekly target — goal-driven, one glance. Hidden
              when goal target is <60 min/week (muscle gain / strength). */}
          {authToken && (
            <Zone2TargetCard
              authToken={authToken}
              themeName={userProfile.themePreference}
            />
          )}

          {/* Weekly coaching — deterministic trainer-style analysis of
              the user's actual week. Uses local weight/sleep/readiness
              signals (all optional) to gate suggestions. */}
          {authToken && (
            <WeeklyCoachingCard
              authToken={authToken}
              themeName={userProfile.themePreference}
              weightSlopeLbsPerWeek={(healthSummary as any)?.weightSlopeLbsPerWeek ?? null}
              avgSleepHours={healthSummary?.lastNightSleepHours ?? null}
              avgRestingHr={healthSummary?.restingHeartRate ?? null}
              avgSteps={healthSummary?.avgSteps7d ?? null}
              readinessScore={null /* wire from TrainingReadinessCard when extracted */}
            />
          )}

          {isHealthKitAvailable() && (
            <DetectedWorkoutsCard
              themeName={userProfile.themePreference}
              appleWorkouts={healthSummary?.workoutDetails ?? null}
              onAfterImport={() => {
                // Reload local history so the just-imported session
                // shows up in the streak / consistency widgets.
                (async () => {
                  try {
                    const { loadWorkoutHistory } = await import('../utils/workoutHistory');
                    const fresh = await loadWorkoutHistory();
                    setHistory(fresh);
                  } catch { /* non-fatal */ }
                })();
              }}
            />
          )}
          {/* Apple Health vitals */}
          {isHealthKitAvailable() && (() => {
            const hs = healthSummary;
            const hasAnyData = hs && (
              hs.restingHeartRate != null || hs.avgSteps7d != null ||
              hs.lastNightSleepHours != null ||
              hs.activeEnergy7d != null || hs.hrvAvg != null
            );

            const handleConnect = async () => {
              setHealthConnecting(true);
              try { await persistAppleHealthEnabled(true); } catch {}
              setHealthEnabled(true);
              try {
                const granted = await requestHealthPermissions();
                const fresh = await readHealthSummary({ age: userProfile.physicalStats?.age ?? null });
                if (fresh) {
                  setHealthSummary(fresh);
                  saveHealthSummary(fresh).catch(() => null);
                }
                const hasAny = fresh && (
                  fresh.restingHeartRate != null || fresh.avgSteps7d != null ||
                  fresh.lastNightSleepHours != null ||
                  fresh.activeEnergy7d != null
                );
                if (granted && !hasAny) {
                  Alert.alert('No data yet', 'Apple Health is connected but no data came back. Open iPhone Settings → Privacy & Security → Health → Thallo and enable the categories you want to share.');
                } else if (!granted) {
                  const err = getLastHealthKitError();
                  Alert.alert('HealthKit not available', `iOS error: ${err ?? 'unknown'}\n\nThis usually means the provisioning profile doesn't include HealthKit.`);
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

            if (!healthEnabled) {
              return (
                <View style={styles.vitalsCard}>
                  <View style={{ alignItems: 'center', paddingVertical: 12 }}>
                    <Ionicons name="heart-outline" size={36} color={tc.primary} />
                    <Text style={{ fontSize: 16, fontWeight: '700', color: tc.textPrimary, marginTop: 8 }}>Apple Health</Text>
                    <Text style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center', lineHeight: 18, marginTop: 6, marginBottom: 14 }}>
                      Connect to see heart rate, sleep stages, HRV, steps, and more.
                    </Text>
                    <TouchableOpacity
                      style={{ backgroundColor: tc.primary, borderRadius: radius.md, paddingVertical: 12, paddingHorizontal: 32 }}
                      onPress={handleConnect}
                      disabled={healthConnecting}
                    >
                      {healthConnecting
                        ? <ActivityIndicator color="#fff" />
                        : <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Connect Apple Health</Text>}
                    </TouchableOpacity>
                  </View>
                </View>
              );
            }

            if (!hasAnyData) {
              return (
                <View style={styles.vitalsCard}>
                  <View style={{ alignItems: 'center', paddingVertical: 12 }}>
                    <Ionicons name="cloud-offline-outline" size={32} color={tc.textMuted} />
                    <Text style={{ fontSize: 14, fontWeight: '600', color: tc.textPrimary, marginTop: 8 }}>Connected — no data yet</Text>
                    <Text style={{ fontSize: 12, color: tc.textSecondary, textAlign: 'center', lineHeight: 17, marginTop: 4, marginBottom: 12 }}>
                      Your Watch may not have synced, or permission categories are off.
                    </Text>
                    <TouchableOpacity
                      style={{ borderWidth: 1, borderColor: tc.border, borderRadius: radius.md, paddingVertical: 10, paddingHorizontal: 24 }}
                      onPress={handleOpenSettings}
                    >
                      <Text style={{ color: tc.textPrimary, fontWeight: '600', fontSize: 13 }}>Open iOS Settings</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            }

            const vitalsRow = (icon: string, label: string, value: string | number | null, unit?: string) => (
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: tc.border + '44' }}>
                <Ionicons name={icon as any} size={18} color={tc.primary} style={{ width: 28 }} />
                <Text style={{ fontSize: 13, color: tc.textSecondary, flex: 1 }}>{label}</Text>
                <Text style={{ fontSize: 16, fontWeight: '700', color: value != null ? tc.textPrimary : tc.textMuted }}>
                  {value != null ? (typeof value === 'number' ? value.toLocaleString() : value) : '—'}
                  {value != null && unit ? <Text style={{ fontSize: 11, fontWeight: '500', color: tc.textMuted }}> {unit}</Text> : null}
                </Text>
              </View>
            );

            return (
              <View style={styles.vitalsCard}>
                <View style={[styles.vitalsHeader, { marginBottom: 4 }]}>
                  <Ionicons name="heart-outline" size={16} color={tc.primary} />
                  <Text style={[styles.vitalsTitle, { color: tc.textPrimary }]}>Apple Health</Text>
                  <Text style={[styles.vitalsSubtitle, { color: tc.textMuted }]}>7-day snapshot</Text>
                </View>
                {vitalsRow('pulse-outline', 'Resting HR', hs!.restingHeartRate, 'bpm')}
                {vitalsRow('analytics-outline', 'HRV', hs!.hrvAvg, 'ms')}
                {vitalsRow('walk-outline', 'Steps (avg)', hs!.avgSteps7d)}
                {vitalsRow('flame-outline', 'Active calories', hs!.activeEnergy7d, 'kcal')}
                {vitalsRow('moon-outline', 'Sleep (avg)', hs!.avgSleepHours7d != null ? (() => {
                  const total = Math.round(hs!.avgSleepHours7d! * 60);
                  const h = Math.floor(total / 60), m = total % 60;
                  return m > 0 ? `${h}h ${m}m` : `${h}h`;
                })() : null)}
                {hs!.vo2Max != null && vitalsRow('fitness-outline', 'VO2 Max', Math.round(hs!.vo2Max * 10) / 10, 'ml/kg/min')}
                {hs!.respiratoryRate != null && vitalsRow('leaf-outline', 'Respiratory rate', hs!.respiratoryRate, 'brpm')}
                {hs!.oxygenSaturation != null && vitalsRow('water-outline', 'Blood oxygen', hs!.oxygenSaturation, '%')}
                {hs!.standingHours7d != null && vitalsRow('body-outline', 'Standing hours', hs!.standingHours7d, 'hrs')}
                {hs!.mindfulMinutes7d != null && vitalsRow('flower-outline', 'Mindful minutes', hs!.mindfulMinutes7d, 'min')}
                {hs!.basalEnergy7d != null && vitalsRow('flash-outline', 'Basal energy', hs!.basalEnergy7d, 'kcal')}
              </View>
            );
          })()}

          {/* Fitness Age */}
          {(() => {
            const vo2 = healthSummary?.vo2Max;
            const age = userProfile.physicalStats?.age;
            const fa = vo2 != null && age != null ? computeFitnessAge(vo2, age) : null;
            if (!fa) return null;
            const deltaColor =
              fa.delta >= 8 ? '#22C55E' :
              fa.delta >= 2 ? tc.primary :
              fa.delta >= -5 ? tc.textSecondary : '#EF4444';
            return (
              <View style={[styles.vitalsCard, { marginTop: 0 }]}>
                <View style={[styles.vitalsHeader, { marginBottom: 10 }]}>
                  <Ionicons name="fitness" size={16} color={tc.primary} />
                  <Text style={[styles.vitalsTitle, { color: tc.textPrimary }]}>Fitness Age</Text>
                  <Text style={[styles.vitalsSubtitle, { color: tc.textMuted }]}>{fa.label}</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <View style={{ alignItems: 'center', paddingVertical: 4, paddingHorizontal: 10, borderRadius: radius.md, backgroundColor: deltaColor + '22' }}>
                    <Text style={{ fontSize: 30, fontWeight: '900', color: deltaColor, lineHeight: 34 }}>{fa.fitnessAge}</Text>
                    <Text style={{ fontSize: 9, fontWeight: '700', color: deltaColor, letterSpacing: 1 }}>YRS</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: tc.textPrimary, lineHeight: 18 }}>
                      {fa.delta === 0
                        ? `Cardio fitness matches your age (${age}).`
                        : fa.delta > 0
                          ? `Cardio fitness of a ${fa.fitnessAge}-year-old — ${fa.delta} yr${fa.delta !== 1 ? 's' : ''} younger than your actual age.`
                          : `Cardio fitness of a ${fa.fitnessAge}-year-old — ${-fa.delta} yr${-fa.delta !== 1 ? 's' : ''} older than your actual age.`}
                    </Text>
                    <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 4 }}>
                      Based on VO₂ Max {Math.round(vo2! * 10) / 10} ml/kg/min
                    </Text>
                  </View>
                </View>
              </View>
            );
          })()}

          {/* Sleep Score */}
          {healthSummary?.sleepScore && (() => {
            const ss = healthSummary.sleepScore;
            const scoreColor = ss.score >= 80 ? tc.success : ss.score >= 60 ? tc.warning : tc.error;
            const formatHM = (hours: number) => {
              const totalMin = Math.round(hours * 60);
              const h = Math.floor(totalMin / 60);
              const m = totalMin % 60;
              if (h > 0 && m > 0) return `${h}h ${m}m`;
              if (h > 0) return `${h}h`;
              return `${m}m`;
            };
            const isPersonalized = (ss as any).mode === 'personalized';
            const pillars = (ss as any).pillars as {
              duration: number; efficiency: number; hrv: number;
              regularity?: number; stageComposite: number; healthFlags: number;
            } | undefined;
            const effRatio = (ss as any).efficiency as number | null | undefined;
            const effPct = effRatio != null ? Math.min(100, Math.round(effRatio * 100)) : null;
            const nightsLogged = sleepHistoryCount;

            // Stage composition (single stacked bar). Awake is visually
            // appended after the asleep stages for a "time in bed" read.
            const totalAsleep = ss.stages.total;
            const totalWithAwake = totalAsleep + ss.stages.awake;
            const deepPct = totalAsleep > 0 ? (ss.stages.deep / totalAsleep) * 100 : 0;
            const corePct = totalAsleep > 0 ? (ss.stages.core / totalAsleep) * 100 : 0;
            const remPct  = totalAsleep > 0 ? (ss.stages.rem  / totalAsleep) * 100 : 0;
            const awakePctOfTotal = totalWithAwake > 0 ? (ss.stages.awake / totalWithAwake) * 100 : 0;
            const STAGE_COLOR = { deep: '#6366F1', core: '#818CF8', rem: '#A78BFA', awake: tc.error };

            return (
              <View style={[styles.vitalsCard, { marginTop: 0 }]}>
                {/* Header: icon + title + score (score is the hero metric). */}
                <View style={[styles.vitalsHeader, { marginBottom: 8 }]}>
                  <Ionicons name="moon-outline" size={16} color="#818CF8" />
                  <Text style={[styles.vitalsTitle, { color: tc.textPrimary, flex: 1 }]}>Sleep Score</Text>
                  <Text style={{ fontSize: 28, fontWeight: '900', color: scoreColor, lineHeight: 32 }}>{ss.score}</Text>
                </View>

                {/* Rating + total + baseline-mode pill on one compact line. */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textSecondary }}>{ss.rating}</Text>
                  <Text style={{ fontSize: 11, color: tc.textMuted }}>· {formatHM(ss.duration)} total</Text>
                  <View style={{ flex: 1 }} />
                  <View style={{
                    paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8,
                    backgroundColor: isPersonalized ? tc.primary + '22' : tc.surfaceRaised,
                  }}>
                    <Text style={{
                      fontSize: 9, fontWeight: '800', letterSpacing: 0.6,
                      color: isPersonalized ? tc.primary : tc.textMuted,
                    }}>
                      {isPersonalized ? 'PERSONALIZED' : 'CALIBRATING'}
                    </Text>
                  </View>
                </View>

                {/* Compact calibration progress (only while building baseline). */}
                {!isPersonalized && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <View style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: tc.border }}>
                      <View style={{
                        width: `${Math.min(100, (nightsLogged / 14) * 100)}%` as any,
                        height: 4, borderRadius: 2, backgroundColor: tc.primary,
                      }} />
                    </View>
                    <Text style={{ fontSize: 10, color: tc.textMuted, fontWeight: '600' }}>
                      {Math.min(14, nightsLogged)}/14 nights
                    </Text>
                  </View>
                )}

                {/* Single stacked stage-composition bar. Fades + slides in on mount. */}
                <FadeInView delay={60} style={{
                  flexDirection: 'row', height: 12, borderRadius: 6, overflow: 'hidden',
                  backgroundColor: tc.border,
                }}>
                  {ss.stages.deep > 0 && (
                    <View style={{ width: `${deepPct}%` as any, backgroundColor: STAGE_COLOR.deep }} />
                  )}
                  {ss.stages.core > 0 && (
                    <View style={{ width: `${corePct}%` as any, backgroundColor: STAGE_COLOR.core }} />
                  )}
                  {ss.stages.rem > 0 && (
                    <View style={{ width: `${remPct}%` as any, backgroundColor: STAGE_COLOR.rem }} />
                  )}
                </FadeInView>
                {/* Stage legend — each row in one line. */}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 8, gap: 4 }}>
                  {[
                    { label: 'Deep', hours: ss.stages.deep, color: STAGE_COLOR.deep, pct: deepPct },
                    { label: 'Core', hours: ss.stages.core, color: STAGE_COLOR.core, pct: corePct },
                    { label: 'REM',  hours: ss.stages.rem,  color: STAGE_COLOR.rem,  pct: remPct },
                  ].map(s => (
                    <View key={s.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingRight: 8 }}>
                      <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: s.color }} />
                      <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textPrimary }}>{s.label}</Text>
                      <Text style={{ fontSize: 11, color: tc.textMuted }}>{formatHM(s.hours)} ({Math.round(s.pct)}%)</Text>
                    </View>
                  ))}
                </View>

                {/* Summary strip: Total · Efficiency · Awake. */}
                <View style={{
                  flexDirection: 'row', marginTop: 10, paddingTop: 10,
                  borderTopWidth: 1, borderTopColor: tc.border + '55',
                }}>
                  <View style={{ flex: 1, alignItems: 'center' }}>
                    <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary }}>{formatHM(ss.duration)}</Text>
                    <Text style={{ fontSize: 9, color: tc.textMuted, letterSpacing: 0.5 }}>TOTAL</Text>
                  </View>
                  {effPct != null && (
                    <View style={{ flex: 1, alignItems: 'center' }}>
                      <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary }}>{effPct}%</Text>
                      <Text style={{ fontSize: 9, color: tc.textMuted, letterSpacing: 0.5 }}>EFFICIENCY</Text>
                    </View>
                  )}
                  <View style={{ flex: 1, alignItems: 'center' }}>
                    <Text style={{ fontSize: 14, fontWeight: '800', color: ss.stages.awake > 0.5 ? tc.warning : tc.textPrimary }}>
                      {formatHM(ss.stages.awake)}
                      {awakePctOfTotal > 0 && <Text style={{ fontSize: 10, color: tc.textMuted }}> ({Math.round(awakePctOfTotal)}%)</Text>}
                    </Text>
                    <Text style={{ fontSize: 9, color: tc.textMuted, letterSpacing: 0.5 }}>AWAKE</Text>
                  </View>
                  {isPersonalized && pillars?.regularity != null && (
                    <View style={{ flex: 1, alignItems: 'center' }}>
                      <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary }}>{pillars.regularity}<Text style={{ fontSize: 10, color: tc.textMuted }}>/15</Text></Text>
                      <Text style={{ fontSize: 9, color: tc.textMuted, letterSpacing: 0.5 }}>REGULARITY</Text>
                    </View>
                  )}
                </View>

                {(ss.hrvAvg != null || ss.respiratoryRate != null || ss.oxygenSaturation != null) && (
                  <View style={{ flexDirection: 'row', gap: 12, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: tc.border + '44' }}>
                    {ss.hrvAvg != null && (
                      <View style={{ flex: 1, alignItems: 'center' }}>
                        <Text style={{ fontSize: 15, fontWeight: '700', color: tc.textPrimary }}>{ss.hrvAvg}</Text>
                        <Text style={{ fontSize: 9, color: tc.textMuted }}>HRV (ms)</Text>
                      </View>
                    )}
                    {ss.respiratoryRate != null && (
                      <View style={{ flex: 1, alignItems: 'center' }}>
                        <Text style={{ fontSize: 15, fontWeight: '700', color: tc.textPrimary }}>{ss.respiratoryRate}</Text>
                        <Text style={{ fontSize: 9, color: tc.textMuted }}>Resp (brpm)</Text>
                      </View>
                    )}
                    {ss.oxygenSaturation != null && (
                      <View style={{ flex: 1, alignItems: 'center' }}>
                        <Text style={{ fontSize: 15, fontWeight: '700', color: tc.textPrimary }}>{ss.oxygenSaturation}%</Text>
                        <Text style={{ fontSize: 9, color: tc.textMuted }}>SpO2</Text>
                      </View>
                    )}
                  </View>
                )}
                {ss.insights.length > 0 && (
                  <View style={{ marginTop: 8, gap: 4 }}>
                    {ss.insights.map((insight, i) => (
                      <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
                        <Ionicons name="information-circle-outline" size={14} color={tc.textMuted} style={{ marginTop: 1 }} />
                        <Text style={{ fontSize: 11, color: tc.textSecondary, flex: 1, lineHeight: 16 }}>{insight}</Text>
                      </View>
                    ))}
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

          {authToken && (
            <AdherenceTrendCard authToken={authToken} themeName={themeName} />
          )}

          {/* Nutrition & Gut Facts — 7-day rolling window (facts only, no scores). */}
          {(gutHealthWindow || mealAverages) && (
            <View style={[styles.vitalsCard, { marginTop: 0 }]}>
              <View style={[styles.vitalsHeader, { marginBottom: 10 }]}>
                <Ionicons name="leaf-outline" size={16} color={tc.primary} />
                <Text style={[styles.vitalsTitle, { color: tc.textPrimary, flex: 1 }]}>Nutrition & Gut Facts</Text>
                {gutHealthWindow && (
                  <Text style={{ fontSize: 10, color: tc.textMuted }}>{gutHealthWindow.days_with_data}d data</Text>
                )}
              </View>

              {/* Averages over actual logged days (adaptive, up to 14). */}
              {gutHealthWindow && gutHealthWindow.days_with_data > 0 && (
                <View style={{ marginBottom: 14 }}>
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
                        <Text style={{ fontSize: 18, fontWeight: '900', color: tc.textPrimary }}>{s.value}</Text>
                        <Text style={{ fontSize: 9, fontWeight: '600', color: tc.textMuted, marginTop: 2 }}>{s.label}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              )}

              {/* Nutrition macros — avg over actual logged days (adaptive). */}
              {mealAverages && mealAverages.days_with_data >= 2 && (
                <View style={{ marginBottom: 14, paddingTop: 10, borderTopWidth: 1, borderTopColor: tc.border + '44' }}>
                  <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textSecondary, letterSpacing: 0.5, marginBottom: 8 }}>
                    MACROS ({mealAverages.days_with_data}-DAY AVG)
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    {[
                      { label: 'Calories', value: Math.round(mealAverages.avg_calories), color: tc.primary },
                      { label: 'Protein', value: `${Math.round(mealAverages.avg_protein_g)}g`, color: '#22C55E' },
                      { label: 'Carbs', value: `${Math.round(mealAverages.avg_carbs_g)}g`, color: '#F59E0B' },
                      { label: 'Fat', value: `${Math.round(mealAverages.avg_fat_g)}g`, color: '#A78BFA' },
                    ].map(s => (
                      <View key={s.label} style={{ flex: 1, alignItems: 'center', backgroundColor: tc.surfaceRaised, borderRadius: 8, paddingVertical: 8 }}>
                        <Text style={{ fontSize: 15, fontWeight: '800', color: s.color }}>{s.value}</Text>
                        <Text style={{ fontSize: 9, fontWeight: '600', color: tc.textMuted, marginTop: 1 }}>{s.label}</Text>
                      </View>
                    ))}
                  </View>
                  <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 6 }}>
                    {Math.round(mealAverages.avg_meals_per_day)} meals/day avg · {mealAverages.total_meals_logged} total logged
                  </Text>
                </View>
              )}

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
                          <View style={{ width: `${Math.min(100, (gutHealthWindow.avg_fiber_g / 28) * 100)}%` as any, height: 5, borderRadius: 3, backgroundColor: fiberColor }} />
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
                          <View style={{ width: `${Math.min(100, (count / 30) * 100)}%` as any, height: 5, borderRadius: 3, backgroundColor: color }} />
                        </View>
                        <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 3 }}>
                          30+ distinct plants/week linked to improved microbiome diversity
                        </Text>
                      </View>
                    );
                  })()}

                  {/* Metric rows */}
                  {[
                    { icon: 'flask-outline', label: 'Fermented foods', value: `${gutHealthWindow.fermented_servings} servings`, detail: 'Kimchi, yogurt, sauerkraut support gut flora' },
                    { icon: 'medkit-outline', label: 'Probiotic servings', value: `${gutHealthWindow.probiotic_servings ?? 0}`, detail: 'Live cultures for microbiome balance' },
                    { icon: 'fish-outline', label: 'Omega-3 foods', value: `${gutHealthWindow.omega3_servings} servings`, detail: 'Anti-inflammatory, heart & brain health' },
                    // Collagen — AI-estimated from every logged food, not
                    // a keyword match. Shows daily average for readability.
                    { icon: 'pulse-outline', label: 'Collagen', value: `${Math.round((gutHealthWindow as any).avg_collagen_g ?? 0)}g / day avg`, detail: 'AI-estimated from bone broth, skin-on cuts, gelatin, supplements' },
                  ].map(row => (
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
                    return (
                      <View style={{ marginBottom: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: tc.border + '33' }}>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textSecondary, letterSpacing: 0.5, marginBottom: 6 }}>
                          PROTEIN SOURCES · {days}-DAY AVG
                        </Text>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                          <Text style={{ fontSize: 11, fontWeight: '600', color: tc.textSecondary }}>
                            Daily avg: {Math.round(avgPlant)}g plant · {Math.round(avgAnimal)}g animal
                          </Text>
                          <Text style={{ fontSize: 11, fontWeight: '700', color: plantColor }}>{plantPct}% plant</Text>
                        </View>
                        <View style={{ flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: tc.border }}>
                          {gutHealthWindow.plant_protein_g > 0 && <View style={{ width: `${plantPct}%` as any, backgroundColor: '#22C55E' }} />}
                          {gutHealthWindow.animal_protein_g > 0 && <View style={{ width: `${100 - plantPct}%` as any, backgroundColor: tc.primary }} />}
                        </View>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 3 }}>
                          <Text style={{ fontSize: 9, color: '#22C55E', fontWeight: '700' }}>Plant</Text>
                          <Text style={{ fontSize: 9, color: tc.primary, fontWeight: '700' }}>Animal</Text>
                        </View>
                        {/* Framed as a dietary-variety signal, not a
                            moral judgement — some users thrive on
                            higher-animal diets. */}
                        <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 4 }}>
                          Mixing in plant proteins adds fiber and plant diversity. Aim for a mix that works for you.
                        </Text>
                      </View>
                    );
                  })()}

                  {/* Processing mix */}
                  {gutHealthWindow.processing_counts && Object.keys(gutHealthWindow.processing_counts).length > 0 && (
                    <View style={{ paddingTop: 10, borderTopWidth: 1, borderTopColor: tc.border + '33' }}>
                      <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textSecondary, letterSpacing: 0.5, marginBottom: 8 }}>FOOD PROCESSING MIX</Text>
                      {['minimally_processed', 'processed', 'ultra_processed', 'unknown'].map(b => {
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
                              <View style={{ width: `${Math.max(3, pct)}%` as any, height: 6, borderRadius: 3, backgroundColor: color }} />
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
                      <View style={{
                        width: `${Math.min(100, (gutInsights.plantCount / 30) * 100)}%` as any,
                        height: 5, borderRadius: 3,
                        backgroundColor: gutInsights.plantTier === 'on_track' ? '#22C55E' : gutInsights.plantTier === 'building' ? '#F59E0B' : '#EF4444',
                      }} />
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
                      <View style={{
                        width: `${Math.min(100, gutInsights.fiberToday.pct)}%` as any,
                        height: 5, borderRadius: 3,
                        backgroundColor: gutInsights.fiberToday.pct >= 80 ? '#22C55E' : '#F59E0B',
                      }} />
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
                    Log meals to see weekly nutrition & gut health trends
                  </Text>
                </View>
              )}
            </View>
          )}

          {/* Muscle Balance — volume distribution across muscle groups (14d).
              Lives under Health because it reads as recovery/balance context,
              paired with Readiness + Fueling flags. */}
          {muscleBalance && muscleBalance.total_sets > 0 && (() => {
            const entries = Object.entries(muscleBalance.muscles);
            const maxSets = entries.length ? Math.max(...entries.map(([, v]) => v.sets)) : 1;
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

            return (
              <View style={[styles.vitalsCard, { marginTop: 0 }]}>
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={() => { configureExpandAnimation(300); setMuscleBalanceExpanded(prev => !prev); }}
                >
                  <View style={[styles.vitalsHeader, { marginBottom: muscleBalanceExpanded ? 12 : 0 }]}>
                    <Ionicons name="body-outline" size={16} color={tc.primary} />
                    <Text style={[styles.vitalsTitle, { color: tc.textPrimary, flex: 1 }]}>Muscle Balance</Text>
                    <Text style={{ fontSize: 20, fontWeight: '800', color: scoreColor }}>{score}</Text>
                    <Text style={{ fontSize: 10, fontWeight: '600', color: tc.textMuted, marginLeft: 2 }}>/100</Text>
                    <Ionicons name={muscleBalanceExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={tc.textMuted} style={{ marginLeft: 6 }} />
                  </View>
                </TouchableOpacity>
                {muscleBalanceExpanded && (
                  <View style={{ gap: 6 }}>
                    <Text style={{ fontSize: 10, color: tc.textMuted, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>
                      {muscleBalance.period_days}d / {Math.round(muscleBalance.total_sets)} total sets
                    </Text>
                    {entries.map(([muscle, data]) => (
                      <View key={muscle} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Text style={{ width: 72, fontSize: 11, fontWeight: '600', color: tc.textSecondary, textTransform: 'capitalize' }}>{muscle.replace(/_/g, ' ')}</Text>
                        <View style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: tc.border }}>
                          <View style={{ width: `${Math.max(3, (data.sets / maxSets) * 100)}%` as any, height: 8, borderRadius: 4, backgroundColor: barColor(muscle, data.pct) }} />
                        </View>
                        <Text style={{ width: 36, fontSize: 11, fontWeight: '700', color: tc.textPrimary, textAlign: 'right' }}>{Math.round(data.sets)}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            );
          })()}
        </ScrollView>
      ) : tab === 'body' ? (
        /* ── Body Tab ───────────────────────────────────────────────── */
        <ScrollView contentContainerStyle={styles.content}>
          {/* Per-muscle recovery (moved from Health tab) — shows fatigue across
              all 12 muscle groups with the full expanded bars. */}
          {muscleFatigue && (
            <RecoveryCard data={muscleFatigue as any} themeName={themeName} defaultExpanded />
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
                {/* Goal progress — only render Target / Remaining / ETA
                    when the user's goal actually has a target-weight axis.
                    Strength / endurance / athletic / mobility goals don't
                    track weight toward a number, so those columns (and the
                    ETA derived from them) are meaningless for them. */}
                {(() => {
                  const GOAL_HAS_TARGET_WEIGHT = new Set([
                    'lose_fat', 'get_lean', 'cut', 'preserve_muscle_cutting',
                    'build_muscle', 'lean_bulk', 'gain_weight',
                    'body_recomp', 'tone', 'get_toned',
                  ]);
                  const isTargetGoal = GOAL_HAS_TARGET_WEIGHT.has(userProfile.goal);
                  const target = isTargetGoal ? userProfile.goalDetails?.targetWeightLbs : null;
                  const start = userProfile.goalDetails?.startWeightLbs ?? weightEntries[0]?.weightLbs;
                  const curr = weightEntries[weightEntries.length - 1]?.weightLbs ?? currentWeight;
                  const remaining = target ? Math.abs(target - curr) : null;
                  const showEstimate = isTargetGoal && !!estimate;
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
                      {showEstimate && estimate && (
                        <View style={{ alignItems: 'center' }}>
                          <Text style={{ fontSize: 11, color: tc.textMuted }}>ETA</Text>
                          <Text style={{ fontSize: 15, fontWeight: '700', color: tc.primary }}>{estimate.label}</Text>
                          <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 1 }}>
                            {estimate.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </Text>
                        </View>
                      )}
                    </View>
                  );
                })()}
                {/* Weight log — tap trash to delete. After deletion we
                    reload history from disk so the derived stats (diff,
                    goal progress, ETA) recompute off the new series. */}
                {weightEntries.slice(-10).reverse().map((e, i) => (
                  <View key={e.date} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderTopWidth: i > 0 ? 1 : 0, borderTopColor: tc.border }}>
                    <Text style={{ flex: 1, fontSize: 13, color: tc.textSecondary }}>
                      {new Date(e.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                    </Text>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: tc.textPrimary }}>
                      {e.weightLbs} lbs
                    </Text>
                    <TouchableOpacity
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      onPress={() => {
                        Alert.alert(
                          'Delete entry?',
                          `Remove ${e.weightLbs} lbs logged on ${new Date(e.date + 'T12:00:00').toLocaleDateString()}? Derived stats (diff, ETA) will recalculate.`,
                          [
                            { text: 'Cancel', style: 'cancel' },
                            {
                              text: 'Delete',
                              style: 'destructive',
                              onPress: async () => {
                                const { deleteWeightEntry } = await import('../utils/weightHistory');
                                const next = await deleteWeightEntry(e.date);
                                setWeightEntries(next);
                                // Sync latest to profile so macros/goal progress update.
                                if (next.length > 0 && onUpdateWeight) {
                                  onUpdateWeight(next[next.length - 1].weightLbs);
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

                {/* Footer actions */}
                {weightEntries.length > 0 && (
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: tc.border }}>
                    <TouchableOpacity
                      onPress={async () => {
                        // Force a re-read of the persisted history and re-derive
                        // downstream stats in case another screen mutated it.
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
                                const { clearWeightHistory } = await import('../utils/weightHistory');
                                await clearWeightHistory();
                                setWeightEntries([]);
                              },
                            },
                          ],
                        );
                      }}
                    >
                      <Text style={{ fontSize: 11, color: tc.error }}>Reset history</Text>
                    </TouchableOpacity>
                  </View>
                )}
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
      </FadeInView>
      )}
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

      {/* Plateau modal — listing each stuck exercise with a suggestion (Feature 5) */}
      <Modal
        visible={plateauModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setPlateauModalVisible(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 24 }}>
          <View style={{ backgroundColor: tc.surface, borderRadius: 16, padding: 20, maxHeight: '80%' }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: tc.textPrimary }}>Plateaus</Text>
              <TouchableOpacity onPress={() => setPlateauModalVisible(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={tc.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView>
              {plateaus.map((p, i) => {
                const suggestionCopy =
                  p.suggestion === 'deload'
                    ? 'Try a deload week: cut volume by 30-40% and come back fresh next week.'
                    : p.suggestion === 'swap'
                    ? 'Swap this exercise for a variation — the current movement has run its course.'
                    : 'Add volume: 1-2 extra sets or an additional day hitting this lift.';
                return (
                  <View
                    key={`${p.exercise_name}-${i}`}
                    style={{ marginBottom: 14, backgroundColor: tc.background, padding: 12, borderRadius: 10 }}>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }}>
                      {p.exercise_name}
                    </Text>
                    <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 2 }}>
                      est 1RM {Math.round(p.current_1rm)} lb · flat for {p.weeks_stuck} weeks
                    </Text>
                    <Text style={{ fontSize: 12, color: tc.textPrimary, marginTop: 6, lineHeight: 16 }}>
                      {suggestionCopy}
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
