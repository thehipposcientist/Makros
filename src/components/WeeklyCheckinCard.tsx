// WeeklyCheckinCard — end-of-week coaching entry point.
//
// Three states:
//   pending   → "Weekly check-in ready" + dates + Start / Skip; next week already exists
//   completed → read-only recap with AI message + "View recap"
//   skipped   → saved deterministic summary + "View summary"
//   none      → renders nothing
//
// Self-contained: fetches its own status on mount. No parent state needed.

import { useEffect, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
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
  /** Called after a successful check-in submission or skip so parent can
   *  reload check-in status and any day-state overlays. */
  onCheckinCompleted?: () => void;
}

function formatDateRange(start: string | null, end: string | null): string {
  if (!start || !end) return '';
  const fmt = (s: string) =>
    new Date(s + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}`;
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

export default function WeeklyCheckinCard({ authToken, themeName, dismissibleRecap = false, onCheckinCompleted }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;

  const [status, setStatus] = useState<CheckinStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [recapMode, setRecapMode] = useState(false);
  const [recapDismissed, setRecapDismissed] = useState(false);

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

  useEffect(() => {
    if (status?.status !== 'pending' || !status.plan_week_id) return;
    maybeNotifyWeeklyCheckinDue({
      planWeekId: status.plan_week_id,
      weekStart: status.week_start,
      weekEnd: status.week_end,
    }).catch(() => {});
  }, [status?.status, status?.plan_week_id, status?.week_start, status?.week_end]);

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
  const hasRecap = isCompleted || (isSkipped && !!checkin?.review_snapshot_json);

  if (isSkipped && !hasRecap) return null;
  if (hasRecap && recapDismissed) return null;

  const handleDismissRecap = async () => {
    setRecapDismissed(true);
    if (recapDismissKey) {
      try { await AsyncStorage.setItem(recapDismissKey, '1'); } catch {}
    }
  };

  const handleSkip = async () => {
    if (!status.plan_week_id) return;
    Alert.alert(
      'Skip check-in?',
      'Your current generated week will stay as it is. The summary remains available in Progress.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Skip',
          style: 'destructive',
          onPress: async () => {
            setSkipping(true);
            try {
              await skipPlanWeekCheckin(authToken, status.plan_week_id!);
              setStatus(prev => prev ? { ...prev, status: 'skipped' } : prev);
              onCheckinCompleted?.();
            } catch {
              Alert.alert('Error', 'Could not skip check-in. Try again.');
            } finally {
              setSkipping(false);
            }
          },
        },
      ],
    );
  };

  const handleCheckinSubmitted = () => {
    setModalVisible(false);
    fetchStatus();
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
              {isPending ? 'WEEKLY CHECK-IN READY' : isSkipped ? 'LAST WEEK SUMMARY' : 'LAST WEEKLY REVIEW'}
            </Text>
            {dateRange ? (
              <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary, marginTop: 1 }}>
                {isPending ? `Review ${dateRange} and save guidance for future weeks.` : dateRange}
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

        {/* Completed recap preview */}
        {hasRecap && (checkin?.ai_message || checkin?.review_snapshot_json?.headline) ? (
          <Text
            style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 17, marginBottom: 10 }}
            numberOfLines={3}
          >
            {checkin?.ai_message || checkin?.review_snapshot_json?.headline}
          </Text>
        ) : null}

        {/* Completed: stats row */}
        {hasRecap && checkin?.review_snapshot_json ? (
          <View style={{ flexDirection: 'row', gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
            {checkin.review_snapshot_json.sessions_completed != null && (
              <View>
                <Text style={{ fontSize: 9, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.5 }}>SESSIONS</Text>
                <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textPrimary, marginTop: 1 }}>
                  {checkin.review_snapshot_json.sessions_completed}/{checkin.review_snapshot_json.sessions_planned}
                </Text>
              </View>
            )}
            {checkin.review_snapshot_json.adherence_pct != null && (
              <View>
                <Text style={{ fontSize: 9, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.5 }}>WORKOUT ADH.</Text>
                <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textPrimary, marginTop: 1 }}>
                  {Math.round(checkin.review_snapshot_json.workout_adherence_pct ?? checkin.review_snapshot_json.adherence_pct)}%
                </Text>
              </View>
            )}
            {(checkin.review_snapshot_json.nutrition_logging_pct ?? checkin.review_snapshot_json.nutrition_adherence_pct) != null && (
              <View>
                <Text style={{ fontSize: 9, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.5 }}>FOOD LOGS</Text>
                <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textPrimary, marginTop: 1 }}>
                  {Math.round(checkin.review_snapshot_json.nutrition_logging_pct ?? checkin.review_snapshot_json.nutrition_adherence_pct)}%
                </Text>
              </View>
            )}
            {checkin.review_snapshot_json.avg_protein_g != null && checkin.review_snapshot_json.days_logged > 0 && (
              <View>
                <Text style={{ fontSize: 9, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.5 }}>PROTEIN</Text>
                <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textPrimary, marginTop: 1 }}>
                  {Math.round(checkin.review_snapshot_json.avg_protein_g)}g
                </Text>
              </View>
            )}
          </View>
        ) : null}

        {hasRecap && changePreview ? (
          <Text style={{ fontSize: 11, color: tc.textSecondary, lineHeight: 16, marginBottom: 10 }}>
            {changePreview}
          </Text>
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
              color: isPending ? '#fff' : tc.textPrimary,
            }}>
              {isPending ? 'Start check-in' : isSkipped ? 'View summary' : 'View recap'}
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
                : <Text style={{ fontSize: 13, color: tc.textMuted, fontWeight: '600' }}>Skip</Text>
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
