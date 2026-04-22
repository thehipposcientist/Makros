import { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { getStreak, StreakSummary } from '../services/api';

interface Props {
  authToken: string;
  themeName?: AppThemeName;
}

export function coachingCopy(compliance_7d: number, current_streak: number): string {
  if (current_streak === 0 && compliance_7d < 30) {
    return "Let's get back on track — one easy session to reset.";
  }
  if (compliance_7d < 50) {
    return "Let's get back on track — one easy session to reset.";
  }
  if (compliance_7d < 80) {
    return "You're close to consistent. One more this week.";
  }
  return "On fire. Don't break the chain.";
}

/**
 * Small dashboard widget showing current streak + 7-day compliance with
 * coaching copy. Always visible once we have a streak or any 7d activity.
 */
export default function StreakConsistencyWidget({ authToken, themeName }: Props) {
  // getTheme returns { colors, sections, ... } — pull `.colors` so dark
  // themes actually render with themed contrast. Prior code destructured
  // `tc.text` / `tc.textMuted` which are undefined → RN fell back to
  // black text on a dark background.
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const workoutPalette = theme.sections.workout;
  const [data, setData] = useState<StreakSummary | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await getStreak(authToken);
        if (alive) setData(r);
      } catch {
        /* silent — widget just won't render */
      }
    })();
    return () => { alive = false; };
  }, [authToken]);

  if (!data) return null;
  // Render only when there's something to celebrate (non-zero) or the
  // user has been training (compliance > 0). Pure zero → hide.
  if (data.current_streak === 0 && data.compliance_7d === 0) return null;

  const copy = coachingCopy(data.compliance_7d, data.current_streak);

  return (
    <View style={{
      backgroundColor: tc.surface,
      borderRadius: radius.lg,
      padding: 12,
      marginBottom: 10,
      borderWidth: 1,
      borderColor: workoutPalette.strong + '55',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Ionicons name="flame" size={20} color="#F59E0B" />
        <Text style={{ fontSize: 18, fontWeight: '800', color: tc.textPrimary, fontVariant: ['tabular-nums'] as any }}>
          {data.current_streak}
        </Text>
        <Text style={{ fontSize: 12, color: tc.textSecondary, fontWeight: '600' }}>
          day streak
        </Text>
      </View>
      <Text style={{ fontSize: 12, color: tc.textMuted }}>·</Text>
      <Text style={{ fontSize: 12, color: tc.textPrimary, fontWeight: '600' }}>
        {data.compliance_7d}% this week
      </Text>
      <View style={{ flex: 1 }} />
      <Text style={{ fontSize: 11, color: tc.textSecondary, flexShrink: 1, textAlign: 'right', maxWidth: '55%' }} numberOfLines={2}>
        {copy}
      </Text>
    </View>
  );
}
