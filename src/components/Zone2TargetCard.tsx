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
import { View, Text, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { getWeeklyReview } from '../services/api';

interface Props {
  authToken: string;
  themeName?: AppThemeName;
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

export default function Zone2TargetCard({ authToken, themeName }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [minutes, setMinutes] = useState<number>(0);
  const [target, setTarget] = useState<number>(100);
  const [goal, setGoal] = useState<string>('general_health');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await getWeeklyReview(authToken, { days: 7 });
        if (cancelled) return;
        setMinutes(r.zone2_minutes ?? 0);
        setGoal(r.goal);
        setTarget(GOAL_ZONE2_TARGET[r.goal] ?? 100);
      } catch { /* endpoint optional */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [authToken]);

  if (loading) return null;
  // Skip the card for goals where Z2 isn't the primary cardio story.
  if (target < 60) return null;

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
          Zone 2 this week
        </Text>
        <Text style={{ fontSize: 13, fontWeight: '800', color }}>
          {Math.round(minutes)} / {target}m
        </Text>
      </View>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: tc.border, overflow: 'hidden' }}>
        <View style={{ height: 6, width: `${pct}%` as any, backgroundColor: color }} />
      </View>
      <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 6 }}>
        {onTrack
          ? "Aerobic base on target for your goal."
          : `${Math.max(0, target - Math.round(minutes))} min short this week — easy walks or bike rides count.`}
      </Text>
    </View>
  );
}
