// Weekly coaching card — user-facing render of /workouts/weekly-review.
//
// Design goals:
//  • Headline at top so the user sees the one-sentence take before any
//    detail. Matches the tone of a trainer: "Solid week, keep the plan"
//    / "Hold the plan — recover first."
//  • Volume bars per muscle with color-coded status chips so the
//    "undertrained / in range / high / excessive / spike" states are
//    readable at a glance.
//  • Recommendations as accept/dismiss pills, each with a structured
//    action the future plan-mutation path can apply without AI.
//  • Dismissed recommendations persist locally so the same nudge
//    doesn't reappear on the next fetch.
//
// No AI calls from this component. The backend review is deterministic
// math; the only place AI could enter is the check-in coach, which
// reads the same review to write a personalised message.

import { useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import {
  getWeeklyReview, applyRecommendationAction,
  WeeklyReviewResponse, PlanRecommendation, MuscleVolumeRow,
} from '../services/api';

interface Props {
  authToken: string;
  themeName?: AppThemeName;
  /** Optional pre-computed signals. When set, the review endpoint
   *  factors them into its rules. These come from the phone's existing
   *  readiness + weight-trend + Apple Health calculations so we're
   *  not double-fetching. */
  weightSlopeLbsPerWeek?: number | null;
  avgSleepHours?: number | null;
  avgRestingHr?: number | null;
  avgSteps?: number | null;
  readinessScore?: number | null;
  /** Called when the user accepts a recommendation. Parent decides
   *  whether to apply it (plan mutation), show a confirmation, or
   *  hand off to the AI trainer for further explanation. */
  onAcceptRecommendation?: (rec: PlanRecommendation) => void;
}

const STATUS_COLORS: Record<string, string> = {
  undertrained: '#9AB0D0',
  in_range: '#59D98E',
  high: '#FFB454',
  excessive: '#FF5D73',
  spike: '#FF5D73',
  unknown: '#687388',
};

const STATUS_LABELS: Record<string, string> = {
  undertrained: 'LOW',
  in_range: 'IN RANGE',
  high: 'HIGH',
  excessive: 'TOO MUCH',
  spike: 'SPIKE',
  unknown: '—',
};

const DISMISSED_KEY_PREFIX = 'weeklyReviewDismissed_v1_';

export default function WeeklyCoachingCard({
  authToken, themeName,
  weightSlopeLbsPerWeek, avgSleepHours, avgRestingHr, avgSteps, readinessScore,
  onAcceptRecommendation,
}: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [review, setReview] = useState<WeeklyReviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  // Hydrate the dismissed set from AsyncStorage so nudges the user
  // already dismissed don't reappear on every mount.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(DISMISSED_KEY_PREFIX + 'recs');
        if (raw) setDismissed(new Set(JSON.parse(raw)));
      } catch { /* non-fatal */ }
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await getWeeklyReview(authToken, {
          days: 7,
          weightSlopeLbsPerWeek,
          avgSleepHours,
          avgRestingHr,
          avgSteps,
          readinessScore,
        });
        if (!cancelled) setReview(r);
      } catch { /* endpoint optional during rollout */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [authToken, weightSlopeLbsPerWeek, avgSleepHours, avgRestingHr, avgSteps, readinessScore]);

  const visibleRecs = useMemo(
    () => (review?.recommendations ?? []).filter(r => !dismissed.has(r.key)),
    [review, dismissed],
  );

  const persistDismissed = (next: Set<string>) => {
    AsyncStorage.setItem(DISMISSED_KEY_PREFIX + 'recs', JSON.stringify([...next])).catch(() => {});
  };

  const dismissRec = (key: string) => {
    const next = new Set(dismissed);
    next.add(key);
    setDismissed(next);
    persistDismissed(next);
  };

  if (loading && !review) {
    return (
      <View style={{
        backgroundColor: tc.surface, borderRadius: radius.lg,
        padding: 14, marginBottom: 12, borderWidth: 1, borderColor: tc.border,
      }}>
        <ActivityIndicator size="small" color={tc.primary} />
      </View>
    );
  }
  if (!review) return null;

  // Show only the major muscle rows sorted by status severity so the
  // bars that matter land at the top. Skip "unknown" rows.
  const STATUS_RANK: Record<string, number> = {
    excessive: 0, spike: 1, high: 2, undertrained: 3, in_range: 4, unknown: 5,
  };
  const majorMuscles = ['chest', 'back', 'shoulders', 'quads', 'hamstrings', 'glutes', 'biceps', 'triceps', 'core', 'calves'];
  const volumeRows: MuscleVolumeRow[] = majorMuscles
    .map(m => review.volume.by_muscle[m])
    .filter(Boolean)
    .sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9));

  const priorityColor = (p: PlanRecommendation['priority']) =>
    p === 'warn' ? tc.error : p === 'suggest' ? tc.warning : tc.primary;

  return (
    <View style={{
      backgroundColor: tc.surface,
      borderRadius: radius.lg,
      padding: 14,
      marginBottom: 12,
      // Slightly heavier accent ring so the card reads as its own surface
      // even on themes where surface ≈ background (void, obsidian).
      borderWidth: 1.5,
      borderColor: tc.primary + '66',
    }}>
      {/* Header: icon + "Weekly Coaching" + sessions chip */}
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={() => setExpanded(v => !v)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{
          width: 36, height: 36, borderRadius: 18,
          backgroundColor: tc.primary + '20',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Ionicons name="sparkles-outline" size={18} color={tc.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 0.8, color: tc.primary }}>
              WEEKLY COACHING
            </Text>
            {review.week_start && review.week_end && (
              <Text style={{ fontSize: 10, color: tc.textMuted, fontWeight: '500' }}>
                {new Date(review.week_start + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                {' – '}
                {new Date(review.week_end + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              </Text>
            )}
          </View>
          <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary, marginTop: 2 }} numberOfLines={expanded ? 0 : 2}>
            {review.headline || `${review.sessions_completed}/${review.sessions_planned} sessions`}
          </Text>
        </View>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={tc.textMuted} />
      </TouchableOpacity>

      {/* Stats strip — compact even when collapsed so there's signal
          density without taking up real estate. */}
      <View style={{ flexDirection: 'row', gap: 14, marginTop: 10 }}>
        <Stat label="Sessions" value={`${review.sessions_completed}/${review.sessions_planned}`} tc={tc} />
        <Stat label="Cardio" value={`${Math.round(review.cardio_minutes)}m`} tc={tc} />
        <Stat label="Zone 2" value={`${Math.round(review.zone2_minutes)}m`} tc={tc} />
        <Stat label="Hard sets" value={`${Math.round(review.volume.total_hard_sets)}`} tc={tc} />
      </View>

      {expanded && (
        <View style={{ marginTop: 14 }}>
          {/* Weight trend — smoothed value alongside slope so the user
              sees a clean number that doesn't whiplash on a single bad
              weigh-in. Hidden when the user lacks weight history (rollup
              not populated). */}
          {(review.weight_ema_lbs != null || review.weight_trend_lbs_per_week != null) && (
            <View style={{ marginBottom: 14, padding: 10, borderRadius: radius.md, backgroundColor: tc.surface }}>
              <Text style={{ fontSize: 10, fontWeight: '800', color: tc.textSecondary, letterSpacing: 0.6, marginBottom: 4 }}>
                WEIGHT TREND
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                {review.weight_ema_lbs != null && (
                  <Text style={{ fontSize: 16, fontWeight: '700', color: tc.textPrimary }}>
                    {review.weight_ema_lbs.toFixed(1)} lbs
                    <Text style={{ fontSize: 11, color: tc.textMuted, fontWeight: '500' }}> smoothed</Text>
                  </Text>
                )}
                {review.weight_trend_lbs_per_week != null && (
                  <Text style={{ fontSize: 13, color: tc.textSecondary, fontWeight: '600' }}>
                    {review.weight_trend_lbs_per_week >= 0 ? '+' : ''}
                    {review.weight_trend_lbs_per_week.toFixed(2)} lbs/wk
                  </Text>
                )}
              </View>
            </View>
          )}
          {/* Volume bars by muscle */}
          {volumeRows.length > 0 && (
            <View style={{ marginBottom: 12 }}>
              <Text style={{ fontSize: 10, fontWeight: '800', color: tc.textSecondary, letterSpacing: 0.6, marginBottom: 6 }}>
                VOLUME BY MUSCLE · THIS WEEK
              </Text>
              {volumeRows.map(row => {
                const color = STATUS_COLORS[row.status] ?? tc.textMuted;
                const max = Math.max(row.range_max ?? 1, row.total_sets, 1);
                const pct = Math.max(4, Math.min(100, (row.total_sets / max) * 100));
                return (
                  <View key={row.muscle} style={{ marginBottom: 10 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <Text style={{ flex: 1, fontSize: 12, fontWeight: '700', color: tc.textPrimary, textTransform: 'capitalize' }}>
                        {row.muscle}
                      </Text>
                      <Text style={{ fontSize: 11, color: tc.textSecondary, marginRight: 6 }}>
                        {row.total_sets.toFixed(0)}
                        {row.range_min != null ? ` / ${row.range_min}–${row.range_max}` : ''}
                      </Text>
                      {/* Status pill — bumped to ~33% bg alpha + 1px outline so
                          the chip stays legible on every dark/light theme. The
                          old `+ '22'` (13% alpha) vanished against deep blacks
                          like void / obsidian. */}
                      <View style={{
                        paddingHorizontal: 7, paddingVertical: 2,
                        backgroundColor: color + '55', borderRadius: 5,
                        borderWidth: 1, borderColor: color + 'AA',
                      }}>
                        <Text style={{ fontSize: 9, fontWeight: '800', color: tc.textPrimary, letterSpacing: 0.5 }}>
                          {STATUS_LABELS[row.status]}
                        </Text>
                      </View>
                    </View>
                    {/* Track tinted with the status color (low alpha) instead
                        of `tc.border` — guarantees the track is visible against
                        every theme's surface, including pure-OLED void. */}
                    <View style={{ height: 6, borderRadius: 3, backgroundColor: color + '33', overflow: 'hidden' }}>
                      <View style={{ height: 6, width: `${pct}%` as any, backgroundColor: color }} />
                    </View>
                  </View>
                );
              })}
            </View>
          )}

          {/* Recommendations */}
          {visibleRecs.length > 0 && (
            <View>
              <Text style={{ fontSize: 10, fontWeight: '800', color: tc.textSecondary, letterSpacing: 0.6, marginBottom: 6 }}>
                RECOMMENDED CHANGES
              </Text>
              {visibleRecs.map(rec => {
                const pc = priorityColor(rec.priority);
                return (
                  <View key={rec.key} style={{
                    marginBottom: 8,
                    padding: 10,
                    borderRadius: 10,
                    backgroundColor: tc.surfaceRaised,
                    // Border on all sides plus a thicker priority bar on the
                    // left. Without the outer border, surfaceRaised sits flush
                    // against the parent surface on themes where the two are
                    // close (void, obsidian, storm) and the rec disappears.
                    borderWidth: 1, borderColor: tc.border,
                    borderLeftWidth: 4, borderLeftColor: pc,
                  }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={{
                        fontSize: 9, fontWeight: '800', letterSpacing: 0.6,
                        color: pc,
                      }}>
                        {rec.priority.toUpperCase()} · {rec.area.toUpperCase()}
                      </Text>
                    </View>
                    <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textPrimary, marginTop: 3 }}>
                      {rec.title}
                    </Text>
                    <Text style={{ fontSize: 11, color: tc.textSecondary, marginTop: 4, lineHeight: 15 }}>
                      {rec.detail}
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                      <TouchableOpacity
                        onPress={async () => {
                          if (rec.action.type === 'noop') {
                            dismissRec(rec.key);
                            return;
                          }
                          // Route every accept through the apply path
                          // — backend maps action.type to durable user
                          // state (days/week, calorie adjustment, day
                          // state). No client-side plan mutation.
                          try {
                            const result = await applyRecommendationAction(
                              authToken, rec.action, rec.key,
                            );
                            // Hand back to the parent so HomeScreen
                            // can kick plan regen when needs_regen=true.
                            onAcceptRecommendation?.(rec);
                            Alert.alert(
                              result.applied ? 'Applied' : 'Acknowledged',
                              result.summary,
                              [{ text: 'OK', onPress: () => dismissRec(rec.key) }],
                            );
                          } catch (e: any) {
                            Alert.alert(
                              'Could not apply',
                              e?.message ?? 'Something went wrong. Try again.',
                            );
                          }
                        }}
                        style={{
                          paddingHorizontal: 12, paddingVertical: 6,
                          borderRadius: 8, backgroundColor: pc,
                        }}>
                        <Text style={{ fontSize: 11, fontWeight: '800', color: '#fff' }}>
                          {rec.action.type === 'noop' ? 'Got it' : 'Apply'}
                        </Text>
                      </TouchableOpacity>
                      {rec.action.type !== 'noop' && (
                        <TouchableOpacity
                          onPress={() => dismissRec(rec.key)}
                          style={{
                            paddingHorizontal: 12, paddingVertical: 6,
                            borderRadius: 8, backgroundColor: tc.surface,
                            borderWidth: 1, borderColor: tc.border,
                          }}>
                          <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textSecondary }}>
                            Dismiss
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          )}

          {visibleRecs.length === 0 && volumeRows.length > 0 && (
            <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 4, fontStyle: 'italic' }}>
              Nothing to change. Stay consistent.
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

function Stat({ label, value, tc }: { label: string; value: string; tc: any }) {
  return (
    <View>
      <Text style={{ fontSize: 9, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.5 }}>
        {label.toUpperCase()}
      </Text>
      <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary, marginTop: 2 }}>
        {value}
      </Text>
    </View>
  );
}
