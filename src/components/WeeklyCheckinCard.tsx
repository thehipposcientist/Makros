// WeeklyCheckinCard - end-of-week review entry point.
//
// Three states:
//   pending   -> "Weekly review ready" + dates + Review / Hide
//   completed -> read-only recap with AI message + "View recap"
//   skipped   -> saved deterministic summary + "View summary"
//   none      -> renders nothing
//
// Self-contained: fetches its own status on mount. No parent state needed.

import { useEffect, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import {
  getCheckinStatus,
  skipPlanWeekCheckin,
  CheckinStatusResponse,
  PlanWeekCheckinRecord,
} from '../services/api';
import CoachCheckinModal from './CoachCheckinModal';
import WeeklyCheckinModal from './WeeklyCheckinModal';
import { maybeNotifyWeeklyCheckinDue } from '../utils/weeklyCheckinNotifications';
import { humanizeToken } from '../utils/exerciseGuide';

interface Props {
  authToken: string;
  themeName?: AppThemeName;
  /** Allows completed/skipped recaps to be hidden on transient surfaces.
   *  Progress leaves this off so the recap remains available there. */
  dismissibleRecap?: boolean;
  /** Plan surfaces can request only the actionable pending review. */
  hideRecap?: boolean;
  /** Called after a review dismissal, recap completion, or skip
   *  so parent surfaces can reload any day-state overlays. */
  onCheckinCompleted?: () => void;
}

function formatDateRange(start: string | null, end: string | null): string {
  if (!start || !end) return '';
  const fmt = (s: string) =>
    new Date(s + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}`;
}

function isBeforeToday(iso: string | null): boolean {
  if (!iso) return false;
  const target = new Date(`${iso.slice(0, 10)}T00:00:00`).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Number.isFinite(target) && target < today;
}

function recapChangePreview(checkin: PlanWeekCheckinRecord | null): string | null {
  const snap = checkin?.review_snapshot_json;
  if (!snap || typeof snap !== 'object') return null;
  const applied = Array.isArray(snap.structured_applied) ? snap.structured_applied : [];
  if (applied.length > 0) {
    const summaries = applied
      .map((item: any) => String(item?.summary ?? humanizeToken(String(item?.type ?? 'Applied'))))
      .filter(Boolean)
      .slice(0, 2);
    return summaries.length ? `Applied: ${summaries.join(' · ')}` : null;
  }
  const recs = Array.isArray(snap.recommendations) ? snap.recommendations : [];
  const titles = recs
    .map((rec: any) => String(rec?.title ?? humanizeToken(String(rec?.key ?? 'Recommendation'))))
    .filter(Boolean)
    .slice(0, 2);
  return titles.length ? `Recommended: ${titles.join(' · ')}` : null;
}

export default function WeeklyCheckinCard({ authToken, themeName, dismissibleRecap = false, hideRecap = false, onCheckinCompleted }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const primaryTextColor = getContrastingTextColor(tc.primary);

  const [status, setStatus] = useState<CheckinStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [recapMode, setRecapMode] = useState(false);
  const [recapDismissed, setRecapDismissed] = useState(false);
  const [pendingReviewDismissed, setPendingReviewDismissed] = useState(false);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const s = await getCheckinStatus(authToken);
      setStatus(s);
    } catch {
      // Non-fatal — card simply doesn't render if status can't be fetched
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const pendingDismissKey = status?.status === 'pending' && status.plan_week_id
    ? `weeklyReviewInfoDismissed_${status.plan_week_id}`
    : null;

  useEffect(() => {
    let alive = true;
    setPendingReviewDismissed(false);
    if (!pendingDismissKey) return () => { alive = false; };
    AsyncStorage.getItem(pendingDismissKey)
      .then(value => { if (alive) setPendingReviewDismissed(value === '1'); })
      .catch(() => {});
    return () => { alive = false; };
  }, [pendingDismissKey]);

  useEffect(() => {
    if (pendingReviewDismissed || status?.status !== 'pending' || !status.plan_week_id) return;
    maybeNotifyWeeklyCheckinDue({
      planWeekId: status.plan_week_id,
      weekStart: status.week_start,
      weekEnd: status.week_end,
    }).catch(() => {});
  }, [pendingReviewDismissed, status?.status, status?.plan_week_id, status?.week_start, status?.week_end]);

  const recapDismissKey = dismissibleRecap
    && status?.plan_week_id
    && (status.status === 'completed' || status.status === 'skipped')
      ? `weeklyCheckinWorkoutRecapDismissed_${status.plan_week_id}`
      : null;

  useEffect(() => {
    let alive = true;
    setRecapDismissed(false);
    if (!recapDismissKey) return () => { alive = false; };
    AsyncStorage.getItem(recapDismissKey)
      .then(value => { if (alive) setRecapDismissed(value === '1'); })
      .catch(() => {});
    return () => { alive = false; };
  }, [recapDismissKey]);

  if (loading) {
    return (
      <View style={{
        backgroundColor: tc.surface, borderRadius: radius.lg,
        padding: 14, marginBottom: 12, borderWidth: 1, borderColor: tc.border,
        alignItems: 'center',
      }}>
        <ActivityIndicator size="small" color={tc.primary} />
      </View>
    );
  }

  if (!status || status.status === 'none') return null;

  const dateRange = formatDateRange(status.week_start, status.week_end);
  const checkin: PlanWeekCheckinRecord | null = status.checkin ?? null;
  const changePreview = recapChangePreview(checkin);
  const isPending = status.status === 'pending';
  const isCompleted = status.status === 'completed';
  const isSkipped = status.status === 'skipped';
  const pendingIsAfterWeekEnd = isPending && isBeforeToday(status.week_end);
  const pendingHint = pendingIsAfterWeekEnd
    ? 'Your new week is already generated. Review last week, then choose whether setup changes wait for future weeks or rebuild remaining unlocked days.'
    : 'Review this week and optionally adjust the setup for the next generated week.';
  const hasRecap = isCompleted || (isSkipped && !!checkin?.review_snapshot_json);
  const snap = checkin?.review_snapshot_json && typeof checkin.review_snapshot_json === 'object'
    ? checkin.review_snapshot_json as any
    : null;
  const pctColor = (pct: number | null, fallback: string) => (
    pct == null ? fallback
      : pct >= 80 ? (tc.success ?? '#22C55E')
        : pct >= 55 ? (tc.warning ?? '#F59E0B')
          : (tc.error ?? '#EF4444')
  );
  const recapMetrics: Array<{ key: string; label: string; value: string; icon: any; color: string; pct?: number }> = [];
  if (hasRecap && snap) {
    const sessionsCompleted = Number(snap.sessions_completed);
    const sessionsPlanned = Number(snap.sessions_planned);
    if (Number.isFinite(sessionsCompleted) && Number.isFinite(sessionsPlanned) && sessionsPlanned > 0) {
      const pct = Math.max(0, Math.min(100, Math.round((sessionsCompleted / sessionsPlanned) * 100)));
      recapMetrics.push({
        key: 'sessions',
        label: 'Sessions',
        value: `${sessionsCompleted}/${sessionsPlanned}`,
        icon: 'calendar-outline',
        color: pctColor(pct, tc.primary),
        pct,
      });
    }

    const workoutPct = Number(snap.workout_adherence_pct ?? snap.adherence_pct);
    if (Number.isFinite(workoutPct) && !recapMetrics.some(metric => metric.key === 'sessions')) {
      recapMetrics.push({
        key: 'workouts',
        label: 'Workouts',
        value: `${Math.round(workoutPct)}%`,
        icon: 'barbell-outline',
        color: pctColor(workoutPct, tc.primary),
        pct: Math.max(0, Math.min(100, Math.round(workoutPct))),
      });
    }

    const foodPct = Number(snap.nutrition_logging_pct ?? snap.nutrition_adherence_pct);
    if (Number.isFinite(foodPct)) {
      recapMetrics.push({
        key: 'food',
        label: 'Food logs',
        value: `${Math.round(foodPct)}%`,
        icon: 'nutrition-outline',
        color: pctColor(foodPct, '#14B8A6'),
        pct: Math.max(0, Math.min(100, Math.round(foodPct))),
      });
    }

    const protein = Number(snap.avg_protein_g);
    const daysLogged = Number(snap.days_logged);
    if (recapMetrics.length < 3 && Number.isFinite(protein) && Number.isFinite(daysLogged) && daysLogged > 0) {
      recapMetrics.push({
        key: 'protein',
        label: 'Protein',
        value: `${Math.round(protein)}g`,
        icon: 'restaurant-outline',
        color: '#14B8A6',
      });
    }
  }

  if (isSkipped && !hasRecap) return null;
  if (hideRecap && hasRecap) return null;
  if (hasRecap && recapDismissed) return null;
  if (isPending && pendingReviewDismissed) return null;

  const handleDismissRecap = async () => {
    setRecapDismissed(true);
    if (recapDismissKey) {
      try { await AsyncStorage.setItem(recapDismissKey, '1'); } catch {}
    }
  };

  const dismissPendingReview = async () => {
    setPendingReviewDismissed(true);
    if (pendingDismissKey) {
      try { await AsyncStorage.setItem(pendingDismissKey, '1'); } catch {}
    }
  };

  const handleSkip = async () => {
    if (!status.plan_week_id) return;
    Alert.alert(
      'Hide weekly review?',
      'Your generated week will stay as it is. You can still review the summary from Progress.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Hide',
          style: 'destructive',
          onPress: async () => {
            setSkipping(true);
            try {
              await skipPlanWeekCheckin(authToken, status.plan_week_id!);
              setStatus(prev => prev ? { ...prev, status: 'skipped' } : prev);
              onCheckinCompleted?.();
            } catch {
              Alert.alert('Error', 'Could not hide the weekly review. Try again.');
            } finally {
              setSkipping(false);
            }
          },
        },
      ],
    );
  };

  const handleCheckinSubmitted = async () => {
    setModalVisible(false);
    if (isPending) {
      await dismissPendingReview();
    } else {
      fetchStatus();
    }
    onCheckinCompleted?.();
  };

  return (
    <>
      <View style={{
        backgroundColor: tc.surface,
        borderRadius: radius.lg,
        padding: 14,
        marginBottom: 12,
        borderWidth: 1.5,
        borderColor: isPending ? tc.primary + '88' : tc.border,
      }}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <View style={{
            width: 32, height: 32, borderRadius: 16,
            backgroundColor: tc.primary + '20',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <Ionicons
              name={isPending ? 'clipboard-outline' : 'checkmark-circle-outline'}
              size={16}
              color={tc.primary}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 10, fontWeight: '800', letterSpacing: 0.8, color: tc.primary }}>
              {isPending ? 'WEEKLY REVIEW' : 'LAST WEEK SUMMARY'}
            </Text>
            {dateRange ? (
              <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary, marginTop: 1 }}>
                {isPending ? `Review ${dateRange}` : dateRange}
              </Text>
            ) : null}
          </View>
          {dismissibleRecap && hasRecap && (
            <TouchableOpacity
              onPress={handleDismissRecap}
              accessibilityRole="button"
              accessibilityLabel="Dismiss weekly recap from Workout"
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={{ padding: 4 }}
            >
              <Ionicons name="close" size={18} color={tc.textMuted} />
            </TouchableOpacity>
          )}
        </View>

        {isPending ? (
          <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 17, marginBottom: 9 }}>
            {pendingHint}
          </Text>
        ) : null}

        {/* Completed recap preview */}
        {hasRecap && (checkin?.ai_message || checkin?.review_snapshot_json?.headline) ? (
          <Text
            style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 17, marginBottom: 9 }}
            numberOfLines={2}
          >
            {checkin?.ai_message || checkin?.review_snapshot_json?.headline}
          </Text>
        ) : null}

        {hasRecap && recapMetrics.length > 0 ? (
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
            {recapMetrics.slice(0, 3).map(metric => (
              <View
                key={metric.key}
                style={{
                  flex: 1,
                  minHeight: 82,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: tc.border,
                  backgroundColor: tc.surfaceRaised,
                  padding: 9,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                  <Ionicons name={metric.icon} size={14} color={metric.color} />
                  <Text style={{ flex: 1, fontSize: 8, fontWeight: '900', color: tc.textMuted, letterSpacing: 0.3, textTransform: 'uppercase' }} numberOfLines={1}>
                    {metric.label}
                  </Text>
                </View>
                <Text style={{ fontSize: 18, fontWeight: '900', color: tc.textPrimary, marginTop: 6 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
                  {metric.value}
                </Text>
                {metric.pct != null && (
                  <View style={{ height: 5, borderRadius: 3, backgroundColor: tc.border, overflow: 'hidden', marginTop: 7 }}>
                    <View style={{ width: `${metric.pct}%` as any, height: '100%', borderRadius: 3, backgroundColor: metric.color }} />
                  </View>
                )}
              </View>
            ))}
          </View>
        ) : null}

        {hasRecap && changePreview ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 10 }}>
            <Ionicons name="sparkles-outline" size={13} color={tc.primary} />
            <Text style={{ flex: 1, fontSize: 11, color: tc.textSecondary, lineHeight: 15 }} numberOfLines={1}>
              {changePreview}
            </Text>
          </View>
        ) : null}

        {/* CTA buttons */}
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <TouchableOpacity
            onPress={() => {
              setRecapMode(!isPending);
              setModalVisible(true);
            }}
            style={{
              flex: 1, paddingVertical: 10, borderRadius: radius.md,
              backgroundColor: isPending ? tc.primary : tc.surfaceRaised,
              borderWidth: isPending ? 0 : 1,
              borderColor: tc.border,
              alignItems: 'center',
            }}
          >
            <Text style={{
              fontSize: 13, fontWeight: '700',
              color: isPending ? primaryTextColor : tc.textPrimary,
            }}>
              {isPending ? 'Review week' : isSkipped ? 'View summary' : 'View recap'}
            </Text>
          </TouchableOpacity>

          {isPending && (
            <TouchableOpacity
              onPress={handleSkip}
              disabled={skipping}
              style={{ paddingHorizontal: 12, paddingVertical: 10 }}
            >
              {skipping
                ? <ActivityIndicator size="small" color={tc.textMuted} />
                : <Text style={{ fontSize: 13, color: tc.textMuted, fontWeight: '600' }}>Hide</Text>
              }
            </TouchableOpacity>
          )}
        </View>
      </View>

      {status.plan_week_id && isPending && !recapMode && (
        <WeeklyCheckinModal
          visible={modalVisible}
          authToken={authToken}
          planWeekId={status.plan_week_id}
          weekStart={status.week_start}
          weekEnd={status.week_end}
          themeName={themeName}
          onClose={() => setModalVisible(false)}
          onComplete={handleCheckinSubmitted}
          onSkip={handleSkip}
        />
      )}
      {status.plan_week_id && (!isPending || recapMode) && (
        <CoachCheckinModal
          visible={modalVisible}
          authToken={authToken}
          planWeekId={status.plan_week_id}
          readOnly={recapMode}
          existingCheckin={recapMode ? checkin : null}
          weekStart={status.week_start}
          weekEnd={status.week_end}
          onPlanUpdated={onCheckinCompleted}
          themeName={themeName}
          onClose={() => setModalVisible(false)}
          onCompleted={handleCheckinSubmitted}
          onSkip={isPending ? handleSkip : undefined}
        />
      )}
    </>
  );
}
