import { useState, useEffect, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator,
  TextInput, Alert, Image,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import ViewShot from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WorkoutSession, UserProfile, StoredWorkoutSummary, GoalHistoryEntry, PlanChangeEntry, BodyScanEntry, HealthSummary, HealthScoreResult } from '../types';
import { loadWorkoutHistory, getPersonalRecords, PR, loadWorkoutSummaries, loadGoalHistory, loadPlanChanges, loadHealthSummary, loadHealthScore, deleteWorkoutSession, deleteWorkoutSummary, deletePlanChange } from '../utils/workoutHistory';
import { RECOVERY_LABELS } from '../utils/healthScore';
import { computeDietConsistency, DietConsistencyScore } from '../utils/mealTracker';
import { getGoalEstimate } from '../utils/goalEstimate';
import { useMetaData } from '../hooks/useMetaData';
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
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const SHARE_LOGO_LIGHT = require('../../assets/images/main_logo_header-removebg-preview.png');
const SHARE_LOGO_DARK  = require('../../assets/images/Fitness brand logo with apple symbol darkmode.png');

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

function strengthForSession(session: WorkoutSession): number {
  return session.exercises.reduce((total, ex) => {
    if (ex.sets.length === 0) return total;
    const bestSet = ex.sets.reduce((best, set) => {
      const bestScore = best.weightLbs * best.reps;
      const setScore = set.weightLbs * set.reps;
      return setScore > bestScore ? set : best;
    }, ex.sets[0]);
    return total + bestSet.weightLbs * bestSet.reps;
  }, 0);
}

function buildStrengthTrend(history: WorkoutSession[]): StrengthPoint[] {
  const sorted = [...history].sort((a, b) => +new Date(a.date) - +new Date(b.date));
  const recent = sorted.slice(-8);
  return recent.map(s => {
    const d = new Date(s.date);
    return {
      key: s.id,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      score: Math.round(strengthForSession(s)),
    };
  });
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

export default function ProgressScreen({ onBack, authToken, userProfile, onUpdateWeight, themeName, noHeader = false }: ProgressScreenProps) {
  const tc = getTheme(themeName).colors;
  const styles = createStyles(tc);
  const meta = useMetaData();
  const [tab, setTab] = useState<'prs' | 'history' | 'charts' | 'summaries' | 'body'>('prs');
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
  const [healthScore, setHealthScore] = useState<HealthScoreResult | null>(null);
  const [dietScore, setDietScore] = useState<DietConsistencyScore | null>(null);

  useEffect(() => {
    Promise.all([getPersonalRecords(), loadWorkoutHistory(), loadWorkoutSummaries(), loadGoalHistory(), loadPlanChanges()]).then(([p, h, s, g, c]) => {
      setPrs(p);
      setHistory(h);
      setSummaries(s);
      setGoalHistory(g);
      setPlanChanges(c);
      setLoading(false);
      if (authToken && p.length > 0) {
        getProgressionInsights(authToken, p[0].exerciseName)
          .then((r: any) => setProgressionHint(r?.suggestion ?? ''))
          .catch(() => null);
      }
    });
    if (authToken) {
      getInsights(authToken).then(setInsights).catch(() => null);
      getGuardrails(authToken).then(r => setGuardrails(r.warnings ?? [])).catch(() => null);
      getCoachMemory(authToken).then((rows: any[]) => setCoachMemory(rows.slice(0, 5))).catch(() => null);
    }
    // Load body scan history
    AsyncStorage.getItem('bodyScanHistory').then(raw => {
      if (raw) try { setBodyScanHistory(JSON.parse(raw)); } catch {}
    });
    // Load Apple Health data
    loadHealthSummary().then(setHealthSummary);
    loadHealthScore().then(setHealthScore);
    computeDietConsistency(userProfile.mealsPerDay ?? 3).then(setDietScore);
  }, [userProfile.mealsPerDay]);

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

  const handleShareFitnessScore = async () => {
    try {
      setShareLoading(true);
      const ref = fitnessScoreRef.current as any;
      if (!ref?.capture) return;
      const uri = await ref.capture();
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

  const strengthTrend = buildStrengthTrend(history);
  const overallStrength = strengthTrend.length
    ? Math.round(strengthTrend.reduce((sum, p) => sum + p.score, 0) / strengthTrend.length)
    : 0;

  // ── Fitness Score (0–100) ──────────────────────────────────────────────────
  const fitnessScore = (() => {
    if (history.length === 0) return null;

    // 1. Consistency (0–30): workouts in last 14 days vs target
    const twoWeeksAgo = Date.now() - 14 * 86400000;
    const recentCount = history.filter(s => +new Date(s.date) >= twoWeeksAgo && s.completed).length;
    const target14 = (userProfile.daysPerWeek ?? 4) * 2;
    const consistencyScore = Math.min(30, Math.round((recentCount / Math.max(1, target14)) * 30));

    // 2. Strength Trend (0–25): are lifts going up?
    let trendScore = 12; // neutral
    if (strengthTrend.length >= 3) {
      const firstHalf = strengthTrend.slice(0, Math.floor(strengthTrend.length / 2));
      const secondHalf = strengthTrend.slice(Math.floor(strengthTrend.length / 2));
      const avgFirst = firstHalf.reduce((s, p) => s + p.score, 0) / firstHalf.length;
      const avgSecond = secondHalf.reduce((s, p) => s + p.score, 0) / secondHalf.length;
      const pctChange = avgFirst > 0 ? ((avgSecond - avgFirst) / avgFirst) * 100 : 0;
      trendScore = Math.min(25, Math.max(0, Math.round(12 + pctChange * 2)));
    }

    // 3. Volume (0–20): total sets in recent sessions
    const recentSessions = history.filter(s => +new Date(s.date) >= twoWeeksAgo && s.completed);
    const totalSets = recentSessions.reduce((sum, s) => sum + s.exercises.reduce((es, e) => es + e.sets.length, 0), 0);
    const volumeScore = Math.min(20, Math.round((totalSets / Math.max(1, target14 * 16)) * 20));

    // 4. Variety (0–15): unique exercises in last 14 days
    const uniqueExercises = new Set(recentSessions.flatMap(s => s.exercises.map(e => e.name.toLowerCase())));
    const varietyScore = Math.min(15, Math.round((uniqueExercises.size / 12) * 15));

    // 5. Duration adherence (0–10): avg session near target
    const targetMins = userProfile.workoutDurationMinutes ?? 60;
    const avgDuration = recentSessions.length > 0
      ? recentSessions.reduce((s, sess) => s + sess.durationSeconds, 0) / recentSessions.length / 60
      : 0;
    const durationRatio = targetMins > 0 ? avgDuration / targetMins : 0;
    const durationScore = Math.min(10, Math.round(Math.max(0, 10 - Math.abs(1 - durationRatio) * 15)));

    const total = consistencyScore + trendScore + volumeScore + varietyScore + durationScore;
    return {
      total: Math.min(100, total),
      consistency: consistencyScore,
      trend: trendScore,
      volume: volumeScore,
      variety: varietyScore,
      duration: durationScore,
      recentCount,
      uniqueExercises: uniqueExercises.size,
    };
  })();

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
          ['prs', 'Records'],
          ['charts', 'Charts'],
          ['history', 'History'],
          ['summaries', 'Summaries'],
          ['body', 'Body'],
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
              <Text style={styles.emptyIcon}>📊</Text>
              <Text style={styles.emptyTitle}>No data yet</Text>
              <Text style={styles.emptyBody}>Complete workouts and log sets to see your progress charts.</Text>
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
        <ScrollView contentContainerStyle={styles.content}>
          {/* ── Fitness Score Card ── */}
          {fitnessScore && (
            <ViewShot ref={fitnessScoreRef} options={{ format: 'png', quality: 1 }}>
            <View style={styles.fitnessScoreCard}>
              {/* Logo for share/export */}
              <Image
                source={tc.background < '#444444' ? SHARE_LOGO_DARK : SHARE_LOGO_LIGHT}
                style={styles.shareCardLogo}
                resizeMode="contain"
              />
              <View style={styles.fitnessScoreHeader}>
                <View>
                  <Text style={styles.fitnessScoreLabel}>FITNESS SCORE</Text>
                  <Text style={styles.fitnessScoreSubtext}>Based on your last 14 days</Text>
                </View>
                <View style={styles.fitnessScoreCircle}>
                  <Text style={styles.fitnessScoreValue}>{fitnessScore.total}</Text>
                </View>
              </View>

              {/* Score rating */}
              <Text style={styles.fitnessScoreRating}>
                {fitnessScore.total >= 80 ? '🔥 Elite' : fitnessScore.total >= 60 ? '💪 Strong' : fitnessScore.total >= 40 ? '📈 Building' : fitnessScore.total >= 20 ? '🌱 Starting' : '🏁 Get Moving'}
              </Text>

              {/* Breakdown bars */}
              <View style={styles.fitnessBreakdown}>
                {([
                  { label: 'Consistency', value: fitnessScore.consistency, max: 30, detail: `${fitnessScore.recentCount} workouts` },
                  { label: 'Strength Trend', value: fitnessScore.trend, max: 25, detail: fitnessScore.trend >= 15 ? 'Improving' : fitnessScore.trend >= 10 ? 'Stable' : 'Declining' },
                  { label: 'Volume', value: fitnessScore.volume, max: 20, detail: `Total sets logged` },
                  { label: 'Variety', value: fitnessScore.variety, max: 15, detail: `${fitnessScore.uniqueExercises} exercises` },
                  { label: 'Session Length', value: fitnessScore.duration, max: 10, detail: 'vs target' },
                ] as const).map(item => (
                  <View key={item.label} style={styles.fitnessBarRow}>
                    <View style={styles.fitnessBarLabel}>
                      <Text style={styles.fitnessBarLabelText}>{item.label}</Text>
                      <Text style={styles.fitnessBarDetail}>{item.detail}</Text>
                    </View>
                    <View style={styles.fitnessBarTrack}>
                      <View style={[styles.fitnessBarFill, { width: `${Math.round((item.value / item.max) * 100)}%` as any }]} />
                    </View>
                    <Text style={styles.fitnessBarScore}>{item.value}/{item.max}</Text>
                  </View>
                ))}
              </View>

              {/* Recovery Marker (Apple Health) */}
              {healthScore && (
                <View style={styles.recoverySection}>
                  <View style={styles.recoveryHeader}>
                    <Text style={styles.recoverySectionTitle}>Recovery Status</Text>
                    <Text style={styles.recoveryBadge}>
                      {RECOVERY_LABELS[healthScore.recoveryMarker].emoji} {RECOVERY_LABELS[healthScore.recoveryMarker].label}
                    </Text>
                  </View>
                  <Text style={styles.recoveryAdvice}>{RECOVERY_LABELS[healthScore.recoveryMarker].advice}</Text>

                  {/* Health-enhanced score */}
                  <View style={styles.healthMetricsRow}>
                    <Text style={styles.healthScoreLabel}>Health Score</Text>
                    <Text style={styles.healthScoreValue}>{healthScore.fitnessScore}/100</Text>
                  </View>

                  {/* Quick metrics from Apple Health */}
                  {healthSummary && (
                    <View style={styles.healthMetricsGrid}>
                      {healthSummary.restingHeartRate != null && (
                        <View style={styles.healthMetric}>
                          <Text style={styles.healthMetricValue}>{healthSummary.restingHeartRate}</Text>
                          <Text style={styles.healthMetricLabel}>Resting HR</Text>
                        </View>
                      )}
                      {healthSummary.avgSteps7d != null && (
                        <View style={styles.healthMetric}>
                          <Text style={styles.healthMetricValue}>{Math.round(healthSummary.avgSteps7d / 1000)}k</Text>
                          <Text style={styles.healthMetricLabel}>Avg Steps</Text>
                        </View>
                      )}
                      {healthSummary.avgSleepHours7d != null && (
                        <View style={styles.healthMetric}>
                          <Text style={styles.healthMetricValue}>{healthSummary.avgSleepHours7d}h</Text>
                          <Text style={styles.healthMetricLabel}>Avg Sleep</Text>
                        </View>
                      )}
                      {healthSummary.workouts7d != null && (
                        <View style={styles.healthMetric}>
                          <Text style={styles.healthMetricValue}>{healthSummary.workouts7d}</Text>
                          <Text style={styles.healthMetricLabel}>Workouts 7d</Text>
                        </View>
                      )}
                    </View>
                  )}
                  {healthSummary && (
                    <Text style={styles.healthFetchedAt}>
                      Updated {new Date(healthSummary.fetchedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </Text>
                  )}
                </View>
              )}

              {/* Share button */}
              <TouchableOpacity
                style={styles.fitnessShareBtn}
                onPress={handleShareFitnessScore}
                disabled={shareLoading}>
                {shareLoading
                  ? <ActivityIndicator size="small" color={tc.primary} />
                  : <Text style={styles.fitnessShareBtnText}>Share Score</Text>
                }
              </TouchableOpacity>
            </View>
            </ViewShot>
          )}

          {/* Diet Consistency Score — mirrors the fitness score card so
              users treat diet adherence with the same weight as workouts. */}
          {dietScore && (
            <View style={styles.fitnessScoreCard}>
              <View style={styles.fitnessScoreHeader}>
                <View>
                  <Text style={styles.fitnessScoreLabel}>DIET CONSISTENCY</Text>
                  <Text style={styles.fitnessScoreSubtext}>Based on your last 14 days</Text>
                </View>
                <View style={styles.fitnessScoreCircle}>
                  <Text style={styles.fitnessScoreValue}>{dietScore.total}</Text>
                </View>
              </View>
              <Text style={styles.fitnessScoreRating}>
                {dietScore.total >= 80 ? '🥗 Dialed In'
                  : dietScore.total >= 60 ? '🍽️ On Track'
                  : dietScore.total >= 40 ? '📊 Building'
                  : dietScore.total >= 20 ? '🌱 Starting'
                  : '🏁 Log a Meal'}
              </Text>
              <View style={styles.fitnessBreakdown}>
                {([
                  { label: 'Adherence',   value: dietScore.adherence, max: 60, detail: `${dietScore.mealsChecked}/${dietScore.mealsExpected} meals` },
                  { label: 'Active Days', value: dietScore.streak,    max: 25, detail: `${dietScore.daysTracked}/14 days` },
                  { label: 'Evenness',    value: dietScore.spread,    max: 15, detail: dietScore.spread >= 10 ? 'Consistent' : dietScore.spread >= 5 ? 'Clustered' : 'Spotty' },
                ] as const).map(item => (
                  <View key={item.label} style={styles.fitnessBarRow}>
                    <View style={styles.fitnessBarLabel}>
                      <Text style={styles.fitnessBarLabelText}>{item.label}</Text>
                      <Text style={styles.fitnessBarDetail}>{item.detail}</Text>
                    </View>
                    <View style={styles.fitnessBarTrack}>
                      <View style={[styles.fitnessBarFill, { width: `${Math.round((item.value / item.max) * 100)}%` as any }]} />
                    </View>
                    <Text style={styles.fitnessBarScore}>{item.value}/{item.max}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}

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

          <View style={styles.weightCard}>
            <View style={styles.weightCardHeader}>
              <Text style={styles.weightTitle}>Weight Progress</Text>
              {onUpdateWeight && !editingWeight && (
                <TouchableOpacity
                  onPress={() => { setWeightInput(String(currentWeight)); setEditingWeight(true); }}
                  style={styles.updateWeightBtn}>
                  <Text style={styles.updateWeightBtnText}>Update</Text>
                </TouchableOpacity>
              )}
            </View>

            {editingWeight ? (
              <View style={styles.weightInputRow}>
                <TextInput
                  style={styles.weightInput}
                  value={weightInput}
                  onChangeText={setWeightInput}
                  keyboardType="decimal-pad"
                  placeholder="Enter weight (lbs)"
                  placeholderTextColor={colors.textMuted}
                  autoFocus
                />
                <TouchableOpacity
                  style={styles.weightConfirmBtn}
                  onPress={() => {
                    const val = parseFloat(weightInput);
                    if (isNaN(val) || val < 50 || val > 700) {
                      Alert.alert('Invalid weight', 'Please enter a weight between 50 and 700 lbs.');
                      return;
                    }
                    onUpdateWeight!(val);
                    setEditingWeight(false);
                  }}>
                  <Text style={styles.weightConfirmText}>Save</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.weightCancelBtn}
                  onPress={() => setEditingWeight(false)}>
                  <Text style={styles.weightCancelText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.weightRow}>
                <View style={styles.weightMetric}>
                  <Text style={styles.weightMetricLabel}>Initial</Text>
                  <Text style={styles.weightMetricValue}>{startWeight} lbs</Text>
                </View>
                <View style={styles.weightMetric}>
                  <Text style={styles.weightMetricLabel}>Current</Text>
                  <Text style={styles.weightMetricValue}>{currentWeight} lbs</Text>
                </View>
                <View style={styles.weightMetric}>
                  <Text style={styles.weightMetricLabel}>Change</Text>
                  <Text style={styles.weightMetricValue}>{lostOrGained.toFixed(1)} lbs {direction}</Text>
                </View>
              </View>
            )}

            {targetWeight != null && !editingWeight && (
              <Text style={styles.weightEta}>
                Target: {targetWeight} lbs
                {remainingLbs != null ? `  ·  ${remainingLbs.toFixed(1)} lbs remaining` : ''}
                {estimate ? `  ·  ${estimate.label}` : ''}
              </Text>
            )}
          </View>

          {prs.length === 0 ? (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyIcon}>🏋️</Text>
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
                ) : filteredPrs.map((pr, i) => (
                  <View key={i} style={styles.prCard}>
                    <View style={styles.prLeft}>
                      <Text style={styles.prName}>{pr.exerciseName}</Text>
                      <Text style={styles.prMeta}>{pr.sessionFocus}  ·  {formatDate(pr.date)}</Text>
                    </View>
                    <View style={styles.prRight}>
                      <Text style={styles.prWeight}>{pr.weightLbs}</Text>
                      <Text style={styles.prUnit}>lbs</Text>
                      <Text style={styles.prReps}>{pr.reps} reps</Text>
                    </View>
                  </View>
                ))}
              </>
            );
          })()}
        </ScrollView>
      ) : tab === 'history' ? (
        <ScrollView contentContainerStyle={styles.content}>
          {history.length === 0 ? (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyIcon}>📋</Text>
              <Text style={styles.emptyTitle}>No workouts yet</Text>
              <Text style={styles.emptyBody}>Start a workout from the home screen to build your history.</Text>
            </View>
          ) : (
            <>
              <View style={styles.graphCard}>
                <View style={styles.graphHeader}>
                  <Text style={styles.graphTitle}>Overall Strength</Text>
                  <Text style={styles.graphScore}>{overallStrength}</Text>
                </View>
                <Text style={styles.graphSubtitle}>Combined top-set score per session (weight × reps)</Text>
                <View style={styles.graphBars}>
                  {strengthTrend.map(point => {
                    const maxScore = Math.max(...strengthTrend.map(p => p.score), 1);
                    const h = Math.max(8, Math.round((point.score / maxScore) * 88));
                    return (
                      <View key={point.key} style={styles.graphBarCol}>
                        <Text style={styles.graphBarValue}>{point.score}</Text>
                        <View style={[styles.graphBar, { height: h }]} />
                        <Text style={styles.graphBarLabel}>{point.label}</Text>
                      </View>
                    );
                  })}
                </View>
              </View>

              <Text style={styles.sectionLabel}>{history.length} sessions logged</Text>
              {history.map((session, i) => {
                const totalSets = session.exercises.reduce((sum, ex) => sum + ex.sets.length, 0);
                const handleDeleteSession = () => {
                  Alert.alert(
                    'Delete this workout?',
                    `${session.focus} — ${formatDate(session.date)}\n\nThis removes the session from your history. Usually you only need this if the AI logged it wrong.`,
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: async () => {
                          await deleteWorkoutSession(session.id);
                          setHistory(prev => prev.filter(s => s.id !== session.id));
                        },
                      },
                    ],
                  );
                };
                return (
                  <View key={session.id ?? i} style={styles.sessionCard}>
                    <View style={styles.sessionHeader}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.sessionFocus}>{session.focus}</Text>
                        <Text style={styles.sessionDate}>{formatDate(session.date)}</Text>
                      </View>
                      <View style={styles.sessionBadge}>
                        <Text style={styles.sessionBadgeText}>{formatDuration(session.durationSeconds)}</Text>
                      </View>
                      <TouchableOpacity
                        onPress={handleDeleteSession}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        style={{ marginLeft: 8, paddingHorizontal: 6, paddingVertical: 2 }}>
                        <Text style={{ fontSize: 16, color: tc.error ?? '#EF4444' }}>✕</Text>
                      </TouchableOpacity>
                    </View>
                    <View style={styles.sessionStats}>
                      <Text style={styles.sessionStat}>{session.exercises.length} exercises</Text>
                      <Text style={styles.sessionStatDot}>·</Text>
                      <Text style={styles.sessionStat}>{totalSets} sets logged</Text>
                    </View>
                    {session.exercises.filter(ex => ex.sets.length > 0).map((ex, ei) => {
                      const best = ex.sets.reduce((b, s) => s.weightLbs > b.weightLbs ? s : b, ex.sets[0]);
                      return (
                        <View key={ei} style={styles.exRow}>
                          <Text style={styles.exName}>{ex.name}</Text>
                          <Text style={styles.exBest}>{best.weightLbs} lbs × {best.reps}</Text>
                        </View>
                      );
                    })}
                  </View>
                );
              })}
            </>
          )}
        </ScrollView>
      ) : tab === 'summaries' ? (
        /* ── Summaries + Goal History tab ─────────────────────────── */
        <ScrollView contentContainerStyle={styles.content}>

          {/* Goal History */}
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
            const goalLabel = meta.goals.find(g => g.value === entry.goal)?.label ?? entry.goal;
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
                  <Text style={styles.sessionStat}>Pace: {entry.pace}</Text>
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

          {/* Workout Summaries */}
          <Text style={[styles.sectionLabel, { marginTop: 16 }]}>Workout Summaries</Text>
          {summaries.length === 0 ? (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyIcon}>🏆</Text>
              <Text style={styles.emptyTitle}>No summaries yet</Text>
              <Text style={styles.emptyBody}>Complete a workout to see your AI-generated summary here.</Text>
            </View>
          ) : summaries.map((s, i) => (
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
            </View>
          ))}

          {/* Plan Change History */}
          <Text style={[styles.sectionLabel, { marginTop: 16 }]}>Plan Change History</Text>
          {planChanges.length === 0 ? (
            <View style={[styles.emptyBox, { marginBottom: 24 }]}>
              <Text style={styles.emptyIcon}>📋</Text>
              <Text style={styles.emptyTitle}>No plan changes yet</Text>
              <Text style={styles.emptyBody}>When your trainer or nutritionist updates your plan via chat, the changes will be logged here.</Text>
            </View>
          ) : planChanges.map((c, i) => {
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
          {/* Scan buttons */}
          <View style={styles.bodyScanPrompt}>
            <Text style={{ fontSize: 36, textAlign: 'center' }}>📸</Text>
            <Text style={styles.bodyScanPromptTitle}>AI Body Scan</Text>
            <Text style={styles.bodyScanPromptText}>
              Take a front-facing photo to estimate body fat percentage, muscle mass, and get personalized feedback.
            </Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
              <TouchableOpacity
                style={[styles.bodyScanBtn, { flex: 1 }]}
                onPress={() => handleBodyScan('camera')}
                disabled={bodyScanLoading}>
                <Text style={styles.bodyScanBtnText}>📷 Camera</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.bodyScanBtn, { flex: 1, backgroundColor: tc.surfaceRaised, borderWidth: 1, borderColor: tc.border }]}
                onPress={() => handleBodyScan('library')}
                disabled={bodyScanLoading}>
                <Text style={[styles.bodyScanBtnText, { color: tc.textPrimary }]}>🖼 Library</Text>
              </TouchableOpacity>
            </View>
            <Text style={{ fontSize: 10, color: tc.textMuted, textAlign: 'center', marginTop: 6, lineHeight: 14 }}>
              For best results: front-facing, good lighting, minimal clothing. This is an AI estimate only.
            </Text>
          </View>

          {/* Loading */}
          {bodyScanLoading && (
            <View style={{ alignItems: 'center', paddingVertical: 30, gap: 10 }}>
              <ActivityIndicator size="large" color={tc.primary} />
              <Text style={{ fontSize: 13, color: tc.textSecondary }}>Analyzing your physique…</Text>
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
    width: 100,
    height: 28,
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
