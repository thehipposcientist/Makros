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
      borderRadius: radius.md,
      paddingHorizontal: 10, paddingVertical: 6,
      marginBottom: 8,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    }}>
      {/* Primary streak chip — small, tinted by theme border so it
          doesn't dominate the screen. */}
      <View style={{
        flexDirection: 'row', alignItems: 'center', gap: 4,
        paddingHorizontal: 8, paddingVertical: 4,
        borderRadius: 12,
        backgroundColor: tc.surface,
        borderWidth: 1, borderColor: tc.border,
      }}>
        <Ionicons name="flame" size={12} color="#F59E0B" />
        <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textPrimary, fontVariant: ['tabular-nums'] as any }}>
          {data.current_streak}
        </Text>
        <Text style={{ fontSize: 10, color: tc.textSecondary }}>
          day{data.current_streak === 1 ? '' : 's'}
        </Text>
      </View>
      {/* Secondary compliance chip — muted. */}
      <View style={{
        paddingHorizontal: 8, paddingVertical: 4,
        borderRadius: 12,
        backgroundColor: tc.surface,
        borderWidth: 1, borderColor: tc.border,
      }}>
        <Text style={{ fontSize: 11, color: tc.textSecondary }}>
          {data.compliance_7d}% wk
        </Text>
      </View>
      {/* Coaching copy — plain text, wraps if needed. */}
      <Text
        style={{ flex: 1, fontSize: 11, color: tc.textMuted, fontStyle: 'italic' }}
        numberOfLines={2}
      >
        {copy}
      </Text>
    </View>
  );
}
