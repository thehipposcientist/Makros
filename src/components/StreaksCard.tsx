// Multi-streak card — workout / meal / readiness streaks side-by-side.
// Drops into HomeScreen's You tab or Progress; auto-hides individual
// rows whose `current` is zero so we don't pressure a brand-new user
// with three "0 days" rows on day one.

import { memo, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius, spacing } from '../constants/theme';
import { AppThemeName } from '../types';
import { getStreaks, type StreakState, type StreakKind } from '../services/api';

interface Props {
  token: string | null | undefined;
  themeName?: AppThemeName;
  onPress?: () => void;
  /** Hide the whole card when no streak is active. Default true so we
   *  don't shame a brand-new user. Set false to always show. */
  hideWhenEmpty?: boolean;
}

const KIND_META: Record<StreakKind, { label: string; icon: 'flame' | 'restaurant' | 'pulse'; emoji: string }> = {
  workout:   { label: 'Workouts',  icon: 'flame',       emoji: '🔥' },
  meal:      { label: 'Meals',     icon: 'restaurant',  emoji: '🍽️' },
  readiness: { label: 'Check-ins', icon: 'pulse',       emoji: '✨' },
};

function StreaksCardInner({ token, themeName, onPress, hideWhenEmpty = true }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [streaks, setStreaks] = useState<StreakState[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!token) { setLoading(false); return () => { cancelled = true; }; }
    (async () => {
      try {
        const res = await getStreaks(token);
        if (!cancelled) {
          setStreaks(res.streaks);
          setErrored(false);
        }
      } catch {
        if (!cancelled) setErrored(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  if (loading) {
    return (
      <View style={[styles.card, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={[styles.title, { color: tc.textPrimary }]}>Streaks</Text>
          <ActivityIndicator size="small" color={tc.textMuted} />
        </View>
      </View>
    );
  }
  if (errored || !streaks) return null;

  const visible = hideWhenEmpty ? streaks.filter(s => s.current > 0) : streaks;
  if (visible.length === 0) return null;

  const Wrapper = onPress ? TouchableOpacity : View;
  const wrapperProps = onPress ? { onPress, activeOpacity: 0.85 } : {};

  return (
    <Wrapper
      {...wrapperProps}
      style={[styles.card, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={`Streaks: ${visible.map(s => `${KIND_META[s.kind].label} ${s.current} days`).join(', ')}`}
    >
      <View style={styles.header}>
        <Text style={[styles.title, { color: tc.textPrimary }]}>Streaks</Text>
        <Text style={[styles.subtle, { color: tc.textMuted }]}>active</Text>
      </View>
      <View style={styles.row}>
        {visible.map(s => {
          const meta = KIND_META[s.kind];
          const tone = s.today_logged ? tc.primary : tc.textSecondary;
          return (
            <View key={s.kind} style={styles.cell}>
              <View style={styles.cellTop}>
                <Ionicons name={meta.icon} size={16} color={tone} />
              </View>
              <Text style={[styles.bigValue, { color: tone }]}>{s.current}</Text>
              <Text style={[styles.unit, { color: tc.textMuted }]}>day{s.current === 1 ? '' : 's'}</Text>
              <Text style={[styles.cellLabel, { color: tc.textSecondary }]}>{meta.label}</Text>
              {s.best > s.current && s.best > 0 ? (
                <Text style={[styles.best, { color: tc.textMuted }]}>best {s.best}</Text>
              ) : null}
            </View>
          );
        })}
      </View>
    </Wrapper>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  title: {
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  subtle: {
    fontSize: 11,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  cell: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    gap: spacing.xxs,
  },
  cellTop: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xxs,
  },
  bigValue: {
    fontSize: 22,
    fontWeight: '900',
    lineHeight: 26,
  },
  unit: {
    fontSize: 10,
    fontWeight: '700',
    marginTop: -2,
  },
  cellLabel: {
    fontSize: 11,
    fontWeight: '600',
    marginTop: spacing.xxs,
  },
  best: {
    fontSize: 10,
    fontWeight: '600',
  },
});

export const StreaksCard = memo(StreaksCardInner);
export default StreaksCard;
