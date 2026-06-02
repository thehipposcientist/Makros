import { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import type { AppThemeName, WorkoutSession } from '../types';
import type { PR } from '../utils/workoutHistory';
import type { WeightUnit } from '../utils/units';
import { getTheme } from '../constants/theme';
import { buildStrengthVolumeTrend } from '../screens/progressData';

interface Props {
  history: WorkoutSession[];
  prs: PR[];
  weightUnit: WeightUnit;
  themeName?: AppThemeName;
  weekStartDate?: string | null;
  windowDays?: number;
}

const VOLUME_COLOR = '#6366F1';
const PR_COLOR = '#F59E0B';

function fmtVolume(lbs: number, unit: WeightUnit): string {
  const v = unit === 'kg' ? lbs * 0.453592 : lbs;
  const u = unit === 'kg' ? 'kg' : 'lb';
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k ${u}`;
  return `${Math.round(v)} ${u}`;
}
function fmtWeight(lbs: number, unit: WeightUnit): string {
  const v = unit === 'kg' ? Math.round(lbs * 0.453592) : Math.round(lbs);
  return `${v} ${unit === 'kg' ? 'kg' : 'lb'}`;
}
// Compact per-bar value label — no unit (the title/footer carry it), so it
// fits above a narrow bar: "12k", "9.8k", "850".
function fmtVolCompact(lbs: number, unit: WeightUnit): string {
  const v = unit === 'kg' ? lbs * 0.453592 : lbs;
  if (v <= 0) return '';
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
  return `${Math.round(v)}`;
}
function shortDate(iso: string): string {
  const d = new Date(iso.length <= 10 ? `${iso}T12:00:00` : iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function tinyDate(iso: string): string {
  const d = new Date(iso.length <= 10 ? `${iso}T12:00:00` : iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()}`;
}

// Trends "lead" card: a weekly training-volume trend (last 8 weeks) plus a
// recent-PRs strip — both from data the Progress screen already has.
export default function TrendsOverviewCard({ history, prs, weightUnit, themeName, weekStartDate, windowDays }: Props) {
  const tc = getTheme(themeName).colors;

  const volumeTrend = useMemo(
    () => buildStrengthVolumeTrend(history, {
      weekStartDate: weekStartDate ?? undefined,
      windowDays,
      weekCount: 8,
    }),
    [history, weekStartDate, windowDays],
  );

  const weeks = useMemo(
    () => [...volumeTrend.weeks].reverse(), // oldest → newest for left-to-right bars
    [volumeTrend],
  );

  const recentPrs = useMemo(
    () => [...prs].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5),
    [prs],
  );

  const maxVol = Math.max(1, ...weeks.map(w => w.volumeLbs));
  const hasVolume = weeks.some(w => w.volumeLbs > 0);
  if (!hasVolume && recentPrs.length === 0) return null;

  const latest = volumeTrend.current;
  const deltaPct = volumeTrend.deltaPct;

  return (
    <View style={[styles.card, { backgroundColor: tc.surface, borderColor: tc.border }]}>
      <LinearGradient
        pointerEvents="none"
        colors={[VOLUME_COLOR + '18', PR_COLOR + '0E', 'rgba(255,255,255,0)']}
        locations={[0, 0.55, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFillObject}
      />
      {hasVolume && (
        <>
          <View style={styles.header}>
            <View style={styles.titleRow}>
              <Ionicons name="analytics-outline" size={15} color={VOLUME_COLOR} />
              <Text style={[styles.title, { color: tc.textPrimary }]}>Training volume</Text>
            </View>
            <Text style={[styles.sub, { color: tc.textMuted }]}>last 8 weeks</Text>
          </View>
          <View style={styles.barRow}>
            {weeks.map((w, i) => {
              const h = w.volumeLbs > 0 ? Math.max(4, Math.round((w.volumeLbs / maxVol) * 60)) : 2;
              const isLast = i === weeks.length - 1;
              return (
                <View key={w.startDate} style={styles.barCol}>
                  <Text style={[styles.barValue, { color: isLast ? VOLUME_COLOR : tc.textMuted }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                    {fmtVolCompact(w.volumeLbs, weightUnit)}
                  </Text>
                  <View style={styles.barTrack}>
                    <View style={[styles.barFill, { height: h, backgroundColor: isLast ? VOLUME_COLOR : VOLUME_COLOR + '59' }]}>
                      <LinearGradient
                        pointerEvents="none"
                        colors={['rgba(255,255,255,0.38)', 'rgba(255,255,255,0.08)', 'rgba(0,0,0,0.08)']}
                        locations={[0, 0.52, 1]}
                        start={{ x: 0.15, y: 0 }}
                        end={{ x: 0.85, y: 1 }}
                        style={StyleSheet.absoluteFillObject}
                      />
                    </View>
                  </View>
                  <Text style={[styles.barDate, { color: tc.textMuted }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                    {tinyDate(w.startDate)}
                  </Text>
                </View>
              );
            })}
          </View>
          <View style={styles.footRow}>
            <Text style={[styles.footValue, { color: tc.textPrimary }]} numberOfLines={1}>
              This week {fmtVolume(latest.volumeLbs, weightUnit)}
            </Text>
            {deltaPct != null && (
              <Text style={[styles.footDelta, { color: deltaPct >= 0 ? (tc.success ?? '#22C55E') : (tc.warning ?? '#F59E0B') }]} numberOfLines={1}>
                {deltaPct >= 0 ? '+' : ''}{deltaPct}% vs last wk
              </Text>
            )}
          </View>
        </>
      )}

      {recentPrs.length > 0 && (
        <View style={hasVolume ? styles.prSection : undefined}>
          <View style={styles.titleRow}>
            <Ionicons name="trophy-outline" size={14} color={PR_COLOR} />
            <Text style={[styles.title, { color: tc.textPrimary }]}>Recent PRs</Text>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.prRow}>
            {recentPrs.map((pr, i) => (
              <View key={`${pr.exerciseName}-${pr.date}-${i}`} style={[styles.prChip, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}>
                <LinearGradient
                  pointerEvents="none"
                  colors={[PR_COLOR + '18', 'rgba(255,255,255,0)']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFillObject}
                />
                <Text style={[styles.prName, { color: tc.textPrimary }]} numberOfLines={1}>{pr.exerciseName}</Text>
                <Text style={[styles.prValue, { color: PR_COLOR }]} numberOfLines={1}>
                  {fmtWeight(pr.weightLbs, weightUnit)} × {pr.reps}
                </Text>
                <Text style={[styles.prDate, { color: tc.textMuted }]} numberOfLines={1}>{shortDate(pr.date)}</Text>
              </View>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 16, padding: 14, marginBottom: 12, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { fontSize: 13, fontWeight: '900' },
  sub: { fontSize: 10.5, fontWeight: '700' },
  barRow: { flexDirection: 'row', alignItems: 'flex-end', height: 92, gap: 4 },
  barCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', height: '100%' },
  barTrack: { width: '100%', height: 62, alignItems: 'center', justifyContent: 'flex-end' },
  barFill: { width: '66%', borderRadius: 4, overflow: 'hidden' },
  barValue: { fontSize: 8.5, fontWeight: '800', marginBottom: 3 },
  barDate: { fontSize: 8.5, fontWeight: '700', marginTop: 4 },
  footRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 8 },
  footValue: { fontSize: 12, fontWeight: '800', flexShrink: 1 },
  footDelta: { fontSize: 11, fontWeight: '800', flexShrink: 0 },
  prSection: { marginTop: 16 },
  prRow: { gap: 8, paddingTop: 8, paddingRight: 2 },
  prChip: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, minWidth: 96, overflow: 'hidden' },
  prName: { fontSize: 11, fontWeight: '800' },
  prValue: { fontSize: 13, fontWeight: '900', marginTop: 2 },
  prDate: { fontSize: 9.5, fontWeight: '700', marginTop: 1 },
});
