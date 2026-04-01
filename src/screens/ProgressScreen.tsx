import { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { WorkoutSession, UserProfile } from '../types';
import { loadWorkoutHistory, getPersonalRecords, PR } from '../utils/workoutHistory';
import { getGoalEstimate } from '../utils/goalEstimate';
import { useMetaData } from '../hooks/useMetaData';
import { getInsights, getGuardrails, getCoachMemory, getProgressionInsights } from '../services/api';
import { colors, radius } from '../constants/theme';

interface ProgressScreenProps {
  onBack: () => void;
  authToken: string;
  userProfile: UserProfile;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

export default function ProgressScreen({ onBack, authToken, userProfile }: ProgressScreenProps) {
  const meta = useMetaData();
  const [tab, setTab] = useState<'prs' | 'history'>('prs');
  const [prs, setPrs] = useState<PR[]>([]);
  const [history, setHistory] = useState<WorkoutSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [insights, setInsights] = useState<any | null>(null);
  const [guardrails, setGuardrails] = useState<string[]>([]);
  const [coachMemory, setCoachMemory] = useState<any[]>([]);
  const [progressionHint, setProgressionHint] = useState<string>('');

  useEffect(() => {
    Promise.all([getPersonalRecords(), loadWorkoutHistory()]).then(([p, h]) => {
      setPrs(p);
      setHistory(h);
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
  }, []);

  const strengthTrend = buildStrengthTrend(history);
  const overallStrength = strengthTrend.length
    ? Math.round(strengthTrend.reduce((sum, p) => sum + p.score, 0) / strengthTrend.length)
    : 0;

  const startWeight = userProfile.goalDetails.startWeightLbs ?? userProfile.physicalStats.weightLbs;
  const currentWeight = userProfile.physicalStats.weightLbs;
  const targetWeight = userProfile.goalDetails.targetWeightLbs;
  const estimate = getGoalEstimate(userProfile, meta.goalConfig);
  const lostOrGained = Math.abs(currentWeight - startWeight);
  const direction = currentWeight <= startWeight ? 'down' : 'up';
  const remainingLbs = targetWeight != null ? Math.abs(currentWeight - targetWeight) : null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={styles.backBtn}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Progress</Text>
        <View style={{ width: 60 }} />
      </View>

      <View style={styles.tabs}>
        <TouchableOpacity
          style={[styles.tab, tab === 'prs' && styles.tabActive]}
          onPress={() => setTab('prs')}>
          <Text style={[styles.tabText, tab === 'prs' && styles.tabTextActive]}>Personal Records</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, tab === 'history' && styles.tabActive]}
          onPress={() => setTab('history')}>
          <Text style={[styles.tabText, tab === 'history' && styles.tabTextActive]}>History</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : tab === 'prs' ? (
        <ScrollView contentContainerStyle={styles.content}>
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
            <Text style={styles.weightTitle}>Weight Progress</Text>
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
            {targetWeight != null && (
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
          ) : (
            <>
              <Text style={styles.sectionLabel}>{prs.length} exercises tracked</Text>
              {prs.map((pr, i) => (
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
          )}
        </ScrollView>
      ) : (
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
                return (
                  <View key={i} style={styles.sessionCard}>
                    <View style={styles.sessionHeader}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.sessionFocus}>{session.focus}</Text>
                        <Text style={styles.sessionDate}>{formatDate(session.date)}</Text>
                      </View>
                      <View style={styles.sessionBadge}>
                        <Text style={styles.sessionBadgeText}>{formatDuration(session.durationSeconds)}</Text>
                      </View>
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
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 56, paddingBottom: 14,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  backBtn: { fontSize: 15, color: colors.primary, fontWeight: '600', width: 60 },
  title:   { fontSize: 18, fontWeight: '700', color: colors.textPrimary },

  tabs: {
    flexDirection: 'row', margin: 16, marginBottom: 0,
    backgroundColor: colors.surface, borderRadius: radius.md,
    padding: 4, borderWidth: 1, borderColor: colors.border,
  },
  tab:           { flex: 1, paddingVertical: 10, borderRadius: radius.sm, alignItems: 'center' },
  tabActive:     { backgroundColor: colors.primary },
  tabText:       { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  tabTextActive: { color: colors.background },

  center:  { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { padding: 16, paddingBottom: 40 },

  sectionLabel: {
    fontSize: 11, fontWeight: '700', color: colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12,
  },

  emptyBox:  { alignItems: 'center', paddingTop: 60, gap: 12 },
  emptyIcon: { fontSize: 48 },
  emptyTitle:{ fontSize: 18, fontWeight: '700', color: colors.textPrimary },
  emptyBody: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 20, paddingHorizontal: 24 },

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
  weightTitle: { fontSize: 15, fontWeight: '700', color: colors.textPrimary, marginBottom: 10 },
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
});
