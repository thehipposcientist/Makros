import { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Animated } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { getWeeklyDigest, WeeklyDigest } from '../services/api';

interface Props {
  authToken: string;
  themeName?: AppThemeName;
  /** Override "today" for testing / Storybook. */
  todayOverride?: Date;
}

/** Returns e.g. "2026-W16" — a stable key for one calendar week. Isoweek. */
function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/** Should we show this week's digest? Yes if today is Sunday OR it's after
 *  6pm local on a non-Sunday and the user hasn't seen this week's digest. */
export function shouldShowWeeklyDigest(now: Date): boolean {
  const day = now.getDay();  // 0 = Sunday
  const hour = now.getHours();
  return day === 0 || hour >= 18;
}

function formatRange(startIso: string, endIso: string): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const s = new Date(`${startIso}T00:00:00`).toLocaleDateString(undefined, opts);
  const e = new Date(`${endIso}T00:00:00`).toLocaleDateString(undefined, opts);
  return `${s} – ${e}`;
}

function deltaLabel(delta: number, suffix: string = ''): string {
  if (delta === 0) return `same as last week${suffix}`;
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta}${suffix} vs last week`;
}

export default function WeeklyDigestCard({ authToken, themeName, todayOverride }: Props) {
  const tc = getTheme(themeName);
  const now = todayOverride ?? new Date();
  const weekKey = isoWeekKey(now);
  const dismissedKey = `lastDigestDismissedWeek_${weekKey}`;

  const [digest, setDigest] = useState<WeeklyDigest | null>(null);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);

  // One-shot entrance animation: slide up + fade in the first time the
  // card becomes visible. `hasAnimated` flips permanently after the first
  // run so re-renders (e.g. digest refetch, theme change) don't replay it.
  const translateY = useRef(new Animated.Value(40)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const hasAnimated = useRef(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const wasDismissed = await AsyncStorage.getItem(dismissedKey);
        if (wasDismissed === '1') {
          if (alive) { setDismissed(true); setLoading(false); }
          return;
        }
        const d = await getWeeklyDigest(authToken);
        if (alive) setDigest(d);
      } catch {
        // Silent — digest is best-effort.
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [authToken, dismissedKey]);

  const handleDismiss = async () => {
    setDismissed(true);
    try { await AsyncStorage.setItem(dismissedKey, '1'); } catch {}
  };

  if (dismissed) return null;
  if (!shouldShowWeeklyDigest(now)) return null;

  if (loading) {
    return (
      <View style={{ padding: 16, backgroundColor: tc.surface, borderRadius: radius.lg, marginBottom: 12 }}>
        <ActivityIndicator color={tc.primary} />
      </View>
    );
  }
  if (!digest) return null;

  // Kick off the entrance once we have real content to show. Guarded by
  // hasAnimated so subsequent renders leave the final pose alone.
  if (!hasAnimated.current) {
    hasAnimated.current = true;
    Animated.parallel([
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true, friction: 8, tension: 55 }),
      Animated.timing(opacity, { toValue: 1, duration: 350, useNativeDriver: true }),
    ]).start();
  }

  const sessionsDelta = digest.deltas.sessions;
  const setsDelta = digest.deltas.total_sets;
  const copy = sessionsDelta > 0
    ? `You trained ${sessionsDelta} more day${sessionsDelta === 1 ? '' : 's'} than last week — keep it going.`
    : sessionsDelta < 0
    ? `You trained ${Math.abs(sessionsDelta)} fewer day${Math.abs(sessionsDelta) === 1 ? '' : 's'} vs last week — let's reset this week.`
    : `Consistent with last week. ${digest.sessions.completed} session${digest.sessions.completed === 1 ? '' : 's'} locked in.`;

  return (
    <Animated.View style={{
      backgroundColor: tc.surface,
      borderRadius: radius.lg,
      padding: 16,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: tc.border,
      opacity,
      transform: [{ translateY }],
    }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Text style={{ fontSize: 16, fontWeight: '700', color: tc.text }}>
          Week in review — {formatRange(digest.week_start, digest.week_end)}
        </Text>
        <TouchableOpacity onPress={handleDismiss} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="close" size={20} color={tc.textMuted} />
        </TouchableOpacity>
      </View>

      <View style={{ flexDirection: 'row', gap: 12, marginBottom: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: tc.text }}>
            {digest.sessions.completed}
          </Text>
          <Text style={{ fontSize: 11, color: tc.textMuted }}>sessions</Text>
          <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 2 }}>
            {deltaLabel(sessionsDelta)}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: tc.text }}>
            {digest.sessions.adherence_pct}%
          </Text>
          <Text style={{ fontSize: 11, color: tc.textMuted }}>adherence</Text>
          <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 2 }}>
            {digest.sessions.distinct_days}/{digest.sessions.planned} planned days
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: tc.text }}>
            {digest.volume.total_sets}
          </Text>
          <Text style={{ fontSize: 11, color: tc.textMuted }}>sets</Text>
          <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 2 }}>
            {deltaLabel(setsDelta)}
          </Text>
        </View>
      </View>

      <Text style={{ fontSize: 13, color: tc.text, marginBottom: 8, lineHeight: 18 }}>
        {copy}
      </Text>

      {digest.pr_count > 0 && (
        <View style={{ backgroundColor: tc.background, padding: 10, borderRadius: radius.md, marginTop: 4 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: tc.text, marginBottom: 4 }}>
            🏆 PRs this week
          </Text>
          {digest.prs.slice(0, 4).map((pr, i) => (
            <Text key={i} style={{ fontSize: 12, color: tc.textMuted }}>
              {pr.exercise_name} — {pr.kind === 'heaviest_weight'
                ? `${pr.new_value} lb (prev ${pr.old_value})`
                : pr.kind === 'estimated_1rm'
                ? `est 1RM ${pr.new_value} lb`
                : `volume ${pr.new_value}`}
            </Text>
          ))}
        </View>
      )}

      {digest.nutrition.days_logged > 0 && (
        <View style={{ marginTop: 8, flexDirection: 'row', gap: 12 }}>
          <Text style={{ fontSize: 12, color: tc.textMuted }}>
            Avg {Math.round(digest.nutrition.avg_calories)} cal · {Math.round(digest.nutrition.avg_protein_g)}g protein
          </Text>
          {digest.nutrition.protein_hit_pct != null && (
            <Text style={{ fontSize: 12, color: digest.nutrition.protein_hit_pct >= 90 ? tc.primary : tc.textMuted, fontWeight: '600' }}>
              {digest.nutrition.protein_hit_pct}% of target
            </Text>
          )}
        </View>
      )}
    </Animated.View>
  );
}
