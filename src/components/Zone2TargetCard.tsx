// Zone 2 weekly target progress.
//
// Reads the weekly review endpoint (goal-specific Z2 target lives
// there) and renders a single progress bar + minute count. Small +
// deliberately low-information — the weekly coaching card already
// does the heavy lift; this is a glanceable "am I on track for the
// aerobic base" chip for users whose goal weights Z2 heavily
// (longevity, fat loss, recomp).
//
// Uses the same /workouts/weekly-review call the coaching card
// already makes, so mounting both doesn't double-fetch (they can be
// refactored to share state via context later — for now, cheap).

import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { getWeeklyReview } from '../services/api';

interface Props {
  authToken: string;
  themeName?: AppThemeName;
  appleHealthZone2?: number | null;
  currentMinutes?: number | null;
  previousMinutes?: number | null;
  weekEndDate?: string | null;
  weekLabel?: string | null;
  previousWeekLabel?: string | null;
}

// Mirror of backend _CARDIO_TARGETS zone2 column so we can show the
// target number even before the server response lands. Stays in sync
// because this is just display — the backend math is authoritative.
const GOAL_ZONE2_TARGET: Record<string, number> = {
  muscle_gain: 40, strength: 40, body_recomp: 80, fat_loss: 120,
  endurance: 150, general_health: 100, longevity: 100,
  athletic_performance: 80, maintain: 80, flexibility: 40,
  stress_relief: 60,
};

// Optional debug list — when provided, lets the user tap "Why?" to see
// exactly which workouts counted (and which didn't). Helps explain
// "I did cardio Monday but Z2 isn't budging" without needing a debugger.
export interface Z2DetectedWorkout {
  name: string;
  durationMin: number;
  counted: boolean;
  reason?: string;
}

export default function Zone2TargetCard({
  authToken,
  themeName,
  appleHealthZone2,
  currentMinutes,
  previousMinutes,
  weekEndDate,
  weekLabel,
  previousWeekLabel,
  detectedWorkouts,
}: Props & { detectedWorkouts?: Z2DetectedWorkout[] }) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [backendMinutes, setBackendMinutes] = useState<number>(0);
  const [target, setTarget] = useState<number>(100);
  const [, setGoal] = useState<string>('general_health');
  const [loading, setLoading] = useState(true);
  const [showWhy, setShowWhy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await getWeeklyReview(authToken, { days: 7, endDate: weekEndDate ?? undefined });
        if (cancelled) return;
        setBackendMinutes(r.zone2_minutes ?? 0);
        setGoal(r.goal);
        setTarget(GOAL_ZONE2_TARGET[r.goal] ?? 100);
      } catch { /* endpoint optional */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [authToken, weekEndDate]);

  if (loading) return null;
  if (target < 60) return null;

  const minutes = currentMinutes != null
    ? Math.max(0, currentMinutes)
    : Math.max(backendMinutes, appleHealthZone2 ?? 0);
  const roundedMinutes = Math.round(minutes);
  const roundedPrevious = previousMinutes != null ? Math.round(previousMinutes) : null;
  const comparisonText = roundedPrevious != null
    ? `${roundedMinutes - roundedPrevious >= 0 ? '+' : ''}${roundedMinutes - roundedPrevious}m vs ${previousWeekLabel ?? 'previous week'}`
    : null;
  const pct = Math.max(0, Math.min(100, (minutes / target) * 100));
  const onTrack = pct >= 80;
  const color = onTrack ? tc.success : pct >= 40 ? tc.warning : tc.error;

  return (
    <View style={{
      backgroundColor: tc.surface,
      borderRadius: radius.lg,
      padding: 14,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: tc.border,
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Ionicons name="walk-outline" size={16} color={color} />
        <Text style={{ fontSize: 12, fontWeight: '800', color: tc.textPrimary, flex: 1, letterSpacing: 0.3 }}>
          Zone 2 plan week
        </Text>
        <Text style={{ fontSize: 13, fontWeight: '800', color }}>
          {roundedMinutes} / {target}m
        </Text>
      </View>
      {weekLabel ? (
        <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: -4, marginBottom: 6 }}>
          {weekLabel}
        </Text>
      ) : null}
      <View style={{ height: 6, borderRadius: 3, backgroundColor: tc.border, overflow: 'hidden' }}>
        <View style={{ height: 6, width: `${pct}%` as any, backgroundColor: color }} />
      </View>
      <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 6 }}>
        {onTrack
          ? `Aerobic base on target for this plan week.${comparisonText ? ` ${comparisonText}.` : ''}`
          : `${Math.max(0, target - roundedMinutes)} min short this plan week${comparisonText ? ` · ${comparisonText}` : ' — easy walks or bike rides count.'}`}
      </Text>

      {/* "Why?" expander — surfaces the per-workout breakdown so users
          can see exactly why a session they did didn't credit toward Z2.
          Most common gotcha: the workout was logged as Strength or
          HealthKit had no HR samples and the activity name wasn't a
          steady-cardio type. */}
      {detectedWorkouts && detectedWorkouts.length > 0 && (
        <TouchableOpacity
          onPress={() => setShowWhy(!showWhy)}
          activeOpacity={0.7}
          style={{ marginTop: 8, alignSelf: 'flex-start' }}
        >
          <Text style={{ fontSize: 10, color: tc.textSecondary, fontWeight: '700' }}>
            {showWhy ? '▾ Hide breakdown' : `▸ Why? · ${detectedWorkouts.length} session${detectedWorkouts.length === 1 ? '' : 's'} in this window`}
          </Text>
        </TouchableOpacity>
      )}
      {showWhy && detectedWorkouts && (
        <View style={{ marginTop: 8, gap: 4 }}>
          {detectedWorkouts.map((w, i) => (
            <View key={`${w.name}-${i}`} style={{
              flexDirection: 'row', alignItems: 'center', gap: 6,
              paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6,
              backgroundColor: w.counted ? (tc.success ?? '#22C55E') + '15' : tc.background,
              borderWidth: 1, borderColor: w.counted ? (tc.success ?? '#22C55E') + '44' : tc.border,
            }}>
              <Ionicons
                name={w.counted ? 'checkmark-circle' : 'remove-circle-outline'}
                size={12}
                color={w.counted ? (tc.success ?? '#22C55E') : tc.textMuted}
              />
              <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textPrimary, flex: 1 }} numberOfLines={1}>
                {w.name}
              </Text>
              <Text style={{ fontSize: 10, color: tc.textMuted }}>
                {Math.round(w.durationMin)}m
              </Text>
              {!w.counted && w.reason && (
                <Text style={{ fontSize: 9, color: tc.textMuted, fontStyle: 'italic' }}>
                  {w.reason}
                </Text>
              )}
            </View>
          ))}
          <Text style={{ fontSize: 9, color: tc.textMuted, marginTop: 2 }}>
            Counts toward Z2: real HR zone minutes when available; otherwise steady cardio ≥ 20 min where the activity isn't intervals/HIIT. If a session you did isn't here, log it under Cardio with a steady or easy style.
          </Text>
        </View>
      )}
    </View>
  );
}
