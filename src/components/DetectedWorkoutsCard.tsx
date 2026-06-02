// Apple Health → Thallo import surface.
//
// On mount, pulls the last 7 days of HK workouts and runs them through
// `detectUnloggedWorkouts` (which excludes anything overlapping an
// existing Thallo session, plus anything we've already imported). Each
// remaining candidate gets a row with a "Classify" button — tapping
// opens the LogActivityModal pre-filled with HK metadata + a
// best-guess category so the user only has to confirm + save.
//
// The classified session counts toward fatigue / recovery like any
// other logged activity (activity_impact.py on the backend reads from
// `manualActivity.category + subtype + intensity`).

import { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName, WorkoutSession } from '../types';
import { getAppleHealthWorkoutRoute, getWorkoutHrSummary, isHealthKitAvailable } from '../services/appleHealth';
import { detectUnloggedWorkouts, dismissHkImports, ImportCandidate } from '../utils/workoutAutoImport';
import LogActivityModal, { LogActivityPrefill } from './LogActivityModal';
import { dateKey, saveWorkoutSession } from '../utils/workoutHistory';
import { completeWorkoutWithOfflineQueue } from '../utils/workoutCompletionQueue';
import { appleHealthMetricsFromWorkoutSession, isAppleHealthWorkoutSession } from '../utils/workoutCompletion';

interface Props {
  themeName?: AppThemeName;
  variant?: 'card' | 'review-card' | 'inline-list';
  /** Optional — parent can pass in already-fetched HK workouts to avoid
   *  a double fetch when it's already querying `readHealthSummary`. */
  appleWorkouts?: any[] | null;
  authToken?: string | null;
  onAfterImport?: (sessionDate?: string) => void;
  lookbackDays?: number;
  /** Keep the entry point visible even when the current query has no
   *  importable workouts. Useful inside menus where discoverability matters. */
  showEmptyState?: boolean;
  /** When supplied, the parent owns the LogActivityModal. This avoids nesting
   *  a second modal inside an already-open parent sheet. */
  onImportPrefill?: (prefill: LogActivityPrefill) => void;
}

function regexClassify(activityName: string): Pick<LogActivityPrefill, 'category' | 'subtype' | 'cardioStyle'> {
  const n = (activityName || '').toLowerCase();
  if (/run/.test(n)) return { category: 'cardio', subtype: 'run', cardioStyle: 'steady' };
  if (/walk/.test(n)) return { category: 'cardio', subtype: 'walk', cardioStyle: 'easy' };
  if (/hike/.test(n)) return { category: 'cardio', subtype: 'hike', cardioStyle: 'steady' };
  if (/cycl|bike/.test(n)) return { category: 'cardio', subtype: 'ride', cardioStyle: 'steady' };
  if (/spin/.test(n)) return { category: 'cardio', subtype: 'spin', cardioStyle: 'intervals' };
  if (/row/.test(n)) return { category: 'cardio', subtype: 'row', cardioStyle: 'steady' };
  if (/swim/.test(n)) return { category: 'cardio', subtype: 'swim', cardioStyle: 'steady' };
  if (/stair/.test(n)) return { category: 'cardio', subtype: 'stair', cardioStyle: 'steady' };
  if (/ellipt/.test(n)) return { category: 'cardio', subtype: 'elliptical', cardioStyle: 'steady' };
  if (/yoga|pilates|stretch|mobility/.test(n)) {
    return { category: 'mobility', subtype: /pilates/.test(n) ? 'pilates' : (/yoga/.test(n) ? 'yoga' : 'stretching') };
  }
  if (/\b(core|abs?|abdominal|plank|crunch|sit[- ]?up)\b/.test(n)) return { category: 'strength', subtype: 'core' };
  if (/strength|lift|weight|functional/.test(n)) return { category: 'strength', subtype: 'full_body' };
  if (/hiit|crossfit|boot/.test(n)) return { category: 'cardio', subtype: 'hiit', cardioStyle: 'intervals' };
  if (/basketball|soccer|tennis|pickleball|volley|golf|ski|surf|box|martial/.test(n)) {
    if (/basket/.test(n)) return { category: 'sport', subtype: 'basketball' };
    if (/soccer/.test(n)) return { category: 'sport', subtype: 'soccer' };
    if (/tennis/.test(n)) return { category: 'sport', subtype: 'tennis' };
    if (/pickleball/.test(n)) return { category: 'sport', subtype: 'pickleball' };
    if (/volley/.test(n)) return { category: 'sport', subtype: /beach/.test(n) ? 'beach_volleyball' : 'volleyball', cardioStyle: 'intervals' };
    if (/golf/.test(n)) return { category: 'sport', subtype: 'golf' };
    if (/ski/.test(n)) return { category: 'sport', subtype: 'skiing' };
    if (/surf/.test(n)) return { category: 'sport', subtype: 'surfing' };
    if (/box/.test(n)) return { category: 'sport', subtype: 'boxing' };
    if (/martial/.test(n)) return { category: 'sport', subtype: 'martial_arts' };
  }
  return { category: 'cardio', subtype: 'other', cardioStyle: 'steady' };
}

export default function DetectedWorkoutsCard({ themeName, variant = 'card', appleWorkouts, authToken, onAfterImport, lookbackDays = 7, showEmptyState = false, onImportPrefill }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [prefill, setPrefill] = useState<LogActivityPrefill | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!isHealthKitAvailable()) { setCandidates([]); return; }
    setLoading(true);
    try {
      // Pull fresh HK workouts unless the parent pre-supplied some.
      let hkList = appleWorkouts ?? [];
      if (!hkList || hkList.length === 0) {
        const mod: any = await import('../services/appleHealth').catch(() => null);
        if (mod && typeof mod === 'object') {
          const now = Date.now();
          hkList = await mod.getAppleHealthWorkouts?.(
            now - lookbackDays * 86400000,
            now,
          ).catch(() => []);
          // Fallback: older JS bundles may not have getAppleHealthWorkouts,
          // but readHealthSummary still carries the recent workout details.
          if (!Array.isArray(hkList) || hkList.length === 0) {
            const summary = await mod.readHealthSummary?.({}).catch(() => null);
            hkList = summary?.workoutDetails ?? [];
          }
        }
      }
      const detected = await detectUnloggedWorkouts(hkList as any[], lookbackDays);
      setCandidates(detected);
    } finally {
      setLoading(false);
    }
  }, [appleWorkouts, lookbackDays]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleClassify = async (c: ImportCandidate) => {
    const guess = regexClassify(c.activityName);
    const startMs = new Date(c.startDate).getTime();
    const endMs = new Date(c.endDate).getTime();
    const [hr, route] = await Promise.all([
      c.avgHeartRate != null ? Promise.resolve(null) : getWorkoutHrSummary(startMs, endMs).catch(() => null),
      c.routeCoords && c.routeCoords.length > 0 ? Promise.resolve(null) : getAppleHealthWorkoutRoute(startMs, endMs).catch(() => null),
    ]);
    const nextPrefill: LogActivityPrefill = {
      externalId: c.externalId,
      dateISO: c.startDate,
      startedAtISO: c.startDate,
      endedAtISO: c.endDate,
      durationMin: c.durationMin,
      distanceMiles: c.distanceMiles ?? null,
      caloriesBurned: c.calories ?? null,
      avgHeartRate: c.avgHeartRate ?? hr?.avgBpm ?? null,
      elevationGainFt: c.elevationGainFt ?? route?.elevationGainFt ?? null,
      routeCoords: c.routeCoords ?? route?.routeCoords ?? undefined,
      source: 'apple_health' as any,
      ...guess,
    };
    if (onImportPrefill) {
      onImportPrefill(nextPrefill);
      return;
    }
    setPrefill(nextPrefill);
    setModalVisible(true);
  };

  const handleSave = async (session: WorkoutSession) => {
    await saveWorkoutSession(session);
    const sessionDate = dateKey(new Date(session.date));
    if (sessionDate === dateKey(new Date())) {
      import('../utils/workoutReminders')
        .then(({ cancelTodayWorkoutReminder }) => cancelTodayWorkoutReminder())
        .catch(() => undefined);
    }
    if (authToken) {
      const isAppleHealth = isAppleHealthWorkoutSession(session);
      await completeWorkoutWithOfflineQueue(
        authToken,
        {
          workout_date: sessionDate,
          focus_label: session.focus,
          duration_seconds: session.durationSeconds,
          activity: session.manualActivity ? {
            category: session.manualActivity.category,
            subtype: session.manualActivity.subtype,
            intensity: session.manualActivity.intensity,
            source: session.manualActivity.source,
            cardioStyle: session.manualActivity.cardioStyle,
            distanceMiles: session.manualActivity.distanceMiles,
            caloriesBurned: session.manualActivity.caloriesBurned,
            avgHeartRate: session.manualActivity.avgHeartRate,
            details: session.manualActivity.details,
            routeCoords: session.manualActivity.routeCoords,
          } : undefined,
          healthMetrics: appleHealthMetricsFromWorkoutSession(session),
          source: {
            sourceContext: isAppleHealth ? 'apple_health' : undefined,
            startedAt: session.startedAt ?? session.date,
            endedAt: session.endedAt ?? null,
            externalSourceId: session.id,
          },
        },
        session,
      ).catch(() => undefined);
    }
    setCandidates(prev => (prev ?? []).filter(c => c.externalId !== session.id));
    onAfterImport?.(sessionDate);
  };

  // Loading on first query + no candidates normally renders nothing. Some
  // surfaces pass showEmptyState so users still have a discoverable Apple
  // Health entry point in the activity chooser.
  if ((!candidates || candidates.length === 0) && !showEmptyState) return null;
  const visibleCandidates = candidates ?? [];

  if (variant === 'review-card') {
    const count = visibleCandidates.length;
    const hasCandidates = count > 0;
    const healthAvailable = isHealthKitAvailable();
    const subtitle = !candidates
      ? 'Checking recent Health workouts'
      : hasCandidates
        ? `${count} potential workout${count === 1 ? '' : 's'} detected`
        : healthAvailable
          ? 'No unlogged workouts found'
          : 'Apple Health unavailable on this device';
    return (
      <View style={{ gap: 8 }}>
        <TouchableOpacity
          testID="apple-workout-import-card"
          accessibilityLabel="apple-workout-import-card"
          onPress={() => setCompactOpen(v => !v)}
          activeOpacity={0.76}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 10,
            paddingVertical: 10, paddingHorizontal: 12,
            borderRadius: 12,
            backgroundColor: tc.surface,
            borderWidth: 1,
            borderColor: tc.primary + '55',
          }}>
          <View style={{
            width: 30, height: 30, borderRadius: 15,
            alignItems: 'center', justifyContent: 'center',
            backgroundColor: tc.primary + '18',
          }}>
            <Ionicons name="cloud-download-outline" size={16} color={tc.primary} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textPrimary }} numberOfLines={1}>
              Apple Health imports
            </Text>
            <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 1 }} numberOfLines={1}>
              {subtitle}
            </Text>
          </View>
          {loading ? (
            <ActivityIndicator size="small" color={tc.textMuted} />
          ) : (
            <Ionicons name={compactOpen ? 'chevron-up' : 'chevron-down'} size={16} color={tc.textMuted} />
          )}
        </TouchableOpacity>
        {compactOpen && (
          <View style={{
            gap: 8,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: tc.border,
            backgroundColor: tc.surface,
            padding: 10,
          }}>
            <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.4 }}>
              POTENTIAL IMPORTS
            </Text>
            {visibleCandidates.length === 0 ? (
              <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 17 }}>
                {healthAvailable
                  ? 'Recent Apple Health workouts that are not already in Thallo will appear here.'
                  : 'Connect Apple Health on an iPhone to import workout sessions.'}
              </Text>
            ) : visibleCandidates.map((c) => {
              const when = new Date(c.startDate);
              const whenStr = when.toLocaleString(undefined, {
                weekday: 'short', month: 'short', day: 'numeric',
                hour: 'numeric', minute: '2-digit',
              });
              return (
                <View
                  key={c.externalId}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 8,
                    paddingVertical: 9, paddingHorizontal: 10,
                    borderRadius: 10,
                    backgroundColor: tc.surfaceRaised,
                    borderWidth: 1,
                    borderColor: tc.border,
                  }}>
                  <TouchableOpacity
                    onPress={() => handleClassify(c)}
                    activeOpacity={0.76}
                    style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textPrimary }} numberOfLines={1}>
                      {c.activityName}
                    </Text>
                    <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 1 }} numberOfLines={1}>
                      {whenStr} · {c.durationMin}m{c.distanceMiles ? ` · ${c.distanceMiles.toFixed(1)} mi` : ''}{c.calories ? ` · ${Math.round(c.calories)} kcal` : ''}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => handleClassify(c)}
                    style={{
                      paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
                      backgroundColor: tc.primary,
                    }}>
                    <Text style={{ fontSize: 11, fontWeight: '800', color: tc.background }}>Import</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={async () => {
                      await dismissHkImports([c.externalId]);
                      setCandidates(prev => (prev ?? []).filter(x => x.externalId !== c.externalId));
                      import('../utils/feedback').then(f => f.hapticSelection?.()).catch(() => {});
                    }}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    style={{ padding: 4 }}>
                    <Ionicons name="close" size={15} color={tc.textMuted} />
                  </TouchableOpacity>
                </View>
              );
            })}
          </View>
        )}
        <LogActivityModal
          visible={modalVisible}
          onClose={() => { setModalVisible(false); setPrefill(null); }}
          onSave={handleSave}
          themeName={themeName}
          prefill={prefill}
        />
      </View>
    );
  }

  if (variant === 'inline-list') {
    const healthAvailable = isHealthKitAvailable();
    return (
      <View
        testID="apple-workout-import-inline-list"
        style={{
          gap: 8,
        }}>
        {loading && !candidates ? (
          <View style={{ alignItems: 'center', paddingVertical: 8 }}>
            <ActivityIndicator size="small" color={tc.textMuted} />
            <Text style={{ marginTop: 8, fontSize: 12, color: tc.textMuted }}>Checking Apple Health...</Text>
          </View>
        ) : visibleCandidates.length === 0 ? (
          <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 17 }}>
            {healthAvailable
              ? 'Recent Apple Health workouts that are not already in Thallo will appear here.'
              : 'Connect Apple Health on an iPhone to import workout sessions.'}
          </Text>
        ) : visibleCandidates.map((c) => {
          const when = new Date(c.startDate);
          const whenStr = when.toLocaleString(undefined, {
            weekday: 'short', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit',
          });
          return (
            <View
              key={c.externalId}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 8,
                paddingVertical: 9, paddingHorizontal: 10,
                borderRadius: 10,
                backgroundColor: tc.surface,
                borderWidth: 1,
                borderColor: tc.border,
              }}>
              <TouchableOpacity
                onPress={() => handleClassify(c)}
                activeOpacity={0.76}
                style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textPrimary }} numberOfLines={1}>
                  {c.activityName}
                </Text>
                <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 1 }} numberOfLines={1}>
                  {whenStr} · {c.durationMin}m{c.distanceMiles ? ` · ${c.distanceMiles.toFixed(1)} mi` : ''}{c.calories ? ` · ${Math.round(c.calories)} kcal` : ''}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => handleClassify(c)}
                style={{
                  paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
                  backgroundColor: tc.primary,
                }}>
                <Text style={{ fontSize: 11, fontWeight: '800', color: tc.background }}>Import</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={async () => {
                  await dismissHkImports([c.externalId]);
                  setCandidates(prev => (prev ?? []).filter(x => x.externalId !== c.externalId));
                  import('../utils/feedback').then(f => f.hapticSelection?.()).catch(() => {});
                }}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                style={{ padding: 4 }}>
                <Ionicons name="close" size={15} color={tc.textMuted} />
              </TouchableOpacity>
            </View>
          );
        })}
        <LogActivityModal
          visible={modalVisible}
          onClose={() => { setModalVisible(false); setPrefill(null); }}
          onSave={handleSave}
          themeName={themeName}
          prefill={prefill}
        />
      </View>
    );
  }

  return (
    <View
      testID="detected-workouts-card"
      style={{
        backgroundColor: tc.surface,
        borderRadius: radius.lg,
        padding: 14,
        marginBottom: 12,
        borderWidth: 1,
        borderColor: tc.primary + '44',
      }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Ionicons name="download-outline" size={18} color={tc.primary} />
        <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary, flex: 1 }}>
          Detected {visibleCandidates.length} workout{visibleCandidates.length === 1 ? '' : 's'} from Apple Health
        </Text>
        {loading && <ActivityIndicator size="small" color={tc.textMuted} />}
        {visibleCandidates.length > 1 && !loading && (
          <TouchableOpacity
            onPress={() => {
              Alert.alert(
                'Clear all detected workouts?',
                `${visibleCandidates.length} workouts will be hidden. They won't factor into recovery and won't re-appear unless you re-import via Apple Health.`,
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Clear all',
                    style: 'destructive',
                    onPress: async () => {
                      const ids = visibleCandidates.map(c => c.externalId);
                      await dismissHkImports(ids);
                      setCandidates([]);
                      import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
                    },
                  },
                ],
              );
            }}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: tc.surfaceRaised, borderWidth: 1, borderColor: tc.border }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textSecondary }}>Clear all</Text>
          </TouchableOpacity>
        )}
      </View>
      <Text style={{ fontSize: 11, color: tc.textMuted, marginBottom: 10 }}>
        Classify so Thallo can factor these into your recovery + fatigue signal.
      </Text>
      {/* Show every candidate, not just the first 5. The user
          legitimately needed to see all of them — clipping was
          hiding the long tail. ScrollView ancestor handles the
          overflow if the list grows. */}
      {visibleCandidates.length === 0 ? (
        <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 17 }}>
          {isHealthKitAvailable()
            ? 'Recent Apple Health workouts that are not already in Thallo will appear here.'
            : 'Connect Apple Health on an iPhone to import workout sessions.'}
        </Text>
      ) : visibleCandidates.map((c) => {
        const when = new Date(c.startDate);
        const whenStr = when.toLocaleString(undefined, {
          weekday: 'short', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit',
        });
        return (
          <View key={c.externalId} style={{
            flexDirection: 'row', alignItems: 'center', gap: 10,
            paddingVertical: 8,
            borderTopWidth: 1, borderTopColor: tc.border + '55',
          }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }} numberOfLines={1}>
                {c.activityName}
              </Text>
              <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 1 }}>
                {whenStr} · {c.durationMin}m{c.distanceMiles ? ` · ${c.distanceMiles.toFixed(1)} mi` : ''}{c.calories ? ` · ${Math.round(c.calories)} kcal` : ''}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => handleClassify(c)}
              style={{
                paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8,
                backgroundColor: tc.primary,
              }}>
              <Text style={{ fontSize: 12, fontWeight: '800', color: tc.background }}>Classify</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={async () => {
                // Single-tap dismiss — no confirmation. The previous
                // Alert-on-every-X felt like the workouts kept coming
                // back even after the user had said no. Persists the
                // externalId so the same HK workout truly doesn't
                // re-surface on the next poll. Use Clear All for the
                // bulk-destructive flow that keeps its confirmation.
                await dismissHkImports([c.externalId]);
                setCandidates(prev => (prev ?? []).filter(x => x.externalId !== c.externalId));
                import('../utils/feedback').then(f => f.hapticSelection?.()).catch(() => {});
              }}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={{ padding: 6 }}>
              <Ionicons name="close" size={16} color={tc.textMuted} />
            </TouchableOpacity>
          </View>
        );
      })}
      <LogActivityModal
        visible={modalVisible}
        onClose={() => { setModalVisible(false); setPrefill(null); }}
        onSave={handleSave}
        themeName={themeName}
        prefill={prefill}
      />
    </View>
  );
}
