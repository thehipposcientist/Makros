// Cardio-load trend card — the cardio analogue to the weekly strength
// volume card. Reads `/workouts/weekly-cardio-load`, draws a small bar
// chart of the last N ISO weeks of Edwards' TRIMP, and surfaces a
// one-line trend caption derived server-side.
//
// The component is purely presentational: it fetches once on mount with
// the supplied token, shows a spinner while loading, and silently hides
// the chart area if the user has no cardio_load data yet (zero rows or
// the endpoint returns `no_baseline`). Strength sessions and cardio
// without HR data are correctly excluded by the backend, so the chart
// only reflects real aerobic stimulus.

import { memo, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius, elevations } from '../constants/theme';
import { AppThemeName } from '../types';
import { getWeeklyCardioLoad, type WeeklyCardioLoadSnapshot } from '../services/api';

interface Props {
  token: string | null | undefined;
  themeName?: AppThemeName;
  weeks?: number;
  // Optional press handler — Progress screen can route a tap to a
  // detail view. Unused if undefined.
  onPress?: () => void;
}

function trendCopy(label: WeeklyCardioLoadSnapshot['trend_label']): {
  caption: string; icon: 'arrow-up' | 'arrow-down' | 'remove' | 'analytics-outline';
} {
  switch (label) {
    case 'trending_up':
      return { caption: 'Trending up vs last 4 weeks', icon: 'arrow-up' };
    case 'trending_down':
      return { caption: 'Trending down vs last 4 weeks', icon: 'arrow-down' };
    case 'flat':
      return { caption: 'Steady vs last 4 weeks', icon: 'remove' };
    default:
      return { caption: 'Building baseline — log a few cardio sessions', icon: 'analytics-outline' };
  }
}

function CardioLoadCardInner({ token, themeName, weeks = 8, onPress }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [data, setData] = useState<WeeklyCardioLoadSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!token) { setLoading(false); return () => { cancelled = true; }; }
    (async () => {
      try {
        const snap = await getWeeklyCardioLoad(token, weeks);
        if (!cancelled) {
          setData(snap);
          setErrored(false);
        }
      } catch {
        if (!cancelled) setErrored(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, weeks]);

  // Hide entirely when the user has no cardio load AND no baseline —
  // showing an empty card on Progress would be noise. The endpoint's
  // own `no_baseline` plus zero weeks signals "no signal yet".
  const totalLoad = data?.weeks.reduce((s, w) => s + w.load, 0) ?? 0;
  if (!loading && (!data || totalLoad === 0)) {
    return null;
  }

  if (loading) {
    return (
      <View style={[styles.card, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={[styles.title, { color: tc.textPrimary }]}>Cardio Load</Text>
          <ActivityIndicator size="small" color={tc.textMuted} />
        </View>
        <Text style={[styles.subtle, { color: tc.textMuted, marginTop: 4 }]}>Loading TRIMP trend…</Text>
      </View>
    );
  }

  if (errored || !data) {
    return null;
  }

  const maxLoad = Math.max(1, ...data.weeks.map(w => w.load));
  const trend = trendCopy(data.trend_label);
  const trendColor =
    data.trend_label === 'trending_up' ? tc.success
    : data.trend_label === 'trending_down' ? tc.warning
    : tc.textSecondary;
  const Wrapper = onPress ? TouchableOpacity : View;
  const wrapperProps = onPress ? { onPress, activeOpacity: 0.86 } : {};

  return (
    <Wrapper
      {...wrapperProps}
      style={[styles.card, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <Text style={[styles.title, { color: tc.textPrimary }]}>Cardio Load</Text>
        <Text style={[styles.subtle, { color: tc.textMuted }]}>Edwards' TRIMP</Text>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 2 }}>
        <Text style={[styles.bigValue, { color: tc.textPrimary }]}>
          {Math.round(data.current_week_load)}
        </Text>
        <Text style={[styles.unit, { color: tc.textSecondary }]}>this week</Text>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
        <Ionicons name={trend.icon} size={13} color={trendColor} />
        <Text style={{ fontSize: 11, fontWeight: '600', color: trendColor }}>{trend.caption}</Text>
      </View>

      <View style={styles.barRow}>
        {data.weeks.map((w, i) => {
          const height = Math.max(3, (w.load / maxLoad) * 56);
          const isCurrent = i === data.weeks.length - 1;
          return (
            <View key={w.week_start} style={styles.barCol}>
              <View
                style={[
                  styles.bar,
                  {
                    height,
                    backgroundColor: isCurrent ? tc.primary : tc.border,
                  },
                ]}
              />
            </View>
          );
        })}
      </View>

      <Text style={[styles.subtle, { color: tc.textMuted, marginTop: 8 }]}>
        {data.weeks.length}-week trend · baseline avg {Math.round(data.rolling_baseline_load)}
      </Text>
    </Wrapper>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    ...elevations.subtle,
  },
  title: { fontSize: 13, fontWeight: '800', letterSpacing: 0.3 },
  subtle: { fontSize: 11, fontWeight: '600' },
  bigValue: { fontSize: 26, fontWeight: '900' },
  unit: { fontSize: 12, fontWeight: '700' },
  barRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 4,
    marginTop: 12,
    height: 60,
  },
  barCol: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  bar: {
    width: '90%',
    borderRadius: 3,
  },
});

export const CardioLoadCard = memo(CardioLoadCardInner);
export default CardioLoadCard;
