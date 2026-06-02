// Cardio progression card — PRs + recent-vs-prior pace trends.
//
// Pairs with `CardioLoadCard` on the Progress / Cardio-Progression
// tab. Load tells you "did you do enough"; this tells you "are you
// getting faster". Auto-hides when the user has no run/ride history.

import { memo, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius, spacing } from '../constants/theme';
import { AppThemeName } from '../types';
import {
  getCardioProgression,
  type CardioProgressionSnapshot,
  type PaceBest,
  type PaceTrend,
} from '../services/api';

interface Props {
  token: string | null | undefined;
  themeName?: AppThemeName;
}

const DISTANCE_LABEL: Record<PaceBest['distance_label'], string> = {
  '5k': '5K',
  '10k': '10K',
  '10mi': '10 mi',
  'half_marathon': 'Half',
  'marathon': 'Marathon',
};

const ACTIVITY_ICON: Record<'run' | 'ride', 'walk' | 'bicycle'> = {
  run: 'walk',
  ride: 'bicycle',
};

function fmtPace(secPerMile: number): string {
  const m = Math.floor(secPerMile / 60);
  const s = Math.round(secPerMile - m * 60);
  return `${m}:${String(s).padStart(2, '0')}/mi`;
}

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m - h * 60;
  return `${h}h ${r}m`;
}

function trendCopy(t: PaceTrend): { caption: string; tone: 'good' | 'bad' | 'neutral' } {
  if (t.delta_pct == null) return { caption: 'Building baseline', tone: 'neutral' };
  // Negative delta = faster (lower pace number is better).
  if (t.delta_pct <= -3) return { caption: `${Math.abs(t.delta_pct).toFixed(1)}% faster vs prior 28d`, tone: 'good' };
  if (t.delta_pct >= 3)  return { caption: `${t.delta_pct.toFixed(1)}% slower vs prior 28d`, tone: 'bad' };
  return { caption: 'Holding pace vs prior 28d', tone: 'neutral' };
}

function CardioProgressionCardInner({ token, themeName }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [data, setData] = useState<CardioProgressionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!token) { setLoading(false); return () => { cancelled = true; }; }
    (async () => {
      try {
        const snap = await getCardioProgression(token);
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
  }, [token]);

  if (loading) {
    return (
      <View style={[styles.card, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={[styles.title, { color: tc.textPrimary }]}>Cardio Progression</Text>
          <ActivityIndicator size="small" color={tc.textMuted} />
        </View>
      </View>
    );
  }
  if (errored || !data) return null;
  const hasSignal = data.bests.length > 0 || data.trends.length > 0;
  if (!hasSignal) return null;

  return (
    <View style={[styles.card, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: tc.textPrimary }]}>Cardio Progression</Text>
        <Text style={[styles.subtle, { color: tc.textMuted }]}>last 12 months</Text>
      </View>

      {data.bests.length > 0 ? (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: tc.textSecondary }]}>Personal bests</Text>
          <View style={styles.bestsGrid}>
            {data.bests.map((b, i) => (
              <View
                key={`${b.activity}-${b.distance_label}-${i}`}
                style={[styles.bestTile, { backgroundColor: tc.background, borderColor: tc.border }]}
                accessibilityRole="text"
                accessibilityLabel={`${b.activity} ${DISTANCE_LABEL[b.distance_label]} best ${fmtPace(b.pace_seconds_per_mile)} achieved ${b.achieved_on}`}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Ionicons name={ACTIVITY_ICON[b.activity]} size={12} color={tc.textMuted} />
                  <Text style={[styles.bestLabel, { color: tc.textMuted }]}>
                    {DISTANCE_LABEL[b.distance_label]}
                  </Text>
                </View>
                <Text style={[styles.bestPace, { color: tc.textPrimary }]} numberOfLines={1}>
                  {fmtPace(b.pace_seconds_per_mile)}
                </Text>
                <Text style={[styles.bestTime, { color: tc.textSecondary }]}>
                  {fmtDuration(b.duration_seconds)}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {data.trends.length > 0 ? (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: tc.textSecondary }]}>28-day pace trend</Text>
          {data.trends.map(t => {
            const copy = trendCopy(t);
            const toneColor =
              copy.tone === 'good' ? tc.success
              : copy.tone === 'bad' ? tc.warning
              : tc.textSecondary;
            return (
              <View key={t.activity} style={styles.trendRow}>
                <Ionicons name={ACTIVITY_ICON[t.activity]} size={14} color={tc.textMuted} />
                <Text style={[styles.trendLabel, { color: tc.textPrimary }]}>
                  {t.activity === 'run' ? 'Running' : 'Cycling'}
                </Text>
                {/* State conveyed by color AND a directional glyph */}
                <Ionicons
                  name={copy.tone === 'good' ? 'arrow-down' : copy.tone === 'bad' ? 'arrow-up' : 'remove'}
                  size={11}
                  color={toneColor}
                  accessibilityElementsHidden
                />
                <Text style={[styles.trendCaption, { color: toneColor }]}>
                  {copy.caption}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}

      <View style={[styles.footer, { borderTopColor: tc.border }]}>
        <Text style={[styles.subtle, { color: tc.textMuted }]}>
          Last 28 days · {Math.round(data.recent_cardio_load)} TRIMP · {data.recent_active_days} active day{data.recent_active_days === 1 ? '' : 's'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
  section: {
    gap: spacing.xs,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  bestsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  bestTile: {
    minWidth: 100,
    flexGrow: 1,
    flexBasis: '30%',
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    gap: spacing.xxs,
  },
  bestLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  bestPace: {
    fontSize: 16,
    fontWeight: '900',
  },
  bestTime: {
    fontSize: 10,
    fontWeight: '600',
  },
  trendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xxs,
  },
  trendLabel: {
    fontSize: 12,
    fontWeight: '700',
    minWidth: 64,
  },
  trendCaption: {
    fontSize: 11,
    fontWeight: '600',
    flex: 1,
  },
  footer: {
    borderTopWidth: 1,
    paddingTop: spacing.sm,
  },
});

export const CardioProgressionCard = memo(CardioProgressionCardInner);
export default CardioProgressionCard;
