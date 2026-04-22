import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, LayoutAnimation, Platform, UIManager } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { getAdherenceTrend, getStreak, AdherenceWeek, StreakSummary } from '../services/api';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface Props {
  authToken: string;
  themeName?: AppThemeName;
}

function formatWeekLabel(isoStart: string): string {
  const d = new Date(isoStart + 'T12:00:00');
  const month = d.getMonth() + 1;
  const day = d.getDate();
  return `${month}/${day}`;
}

function coachingMessage(weeks: AdherenceWeek[]): string {
  if (weeks.length < 2) return 'Keep logging workouts to see your trend.';
  const mid = Math.floor(weeks.length / 2);
  const firstHalf = weeks.slice(0, mid);
  const secondHalf = weeks.slice(mid);
  const avgFirst = firstHalf.reduce((s, w) => s + w.compliance_pct, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((s, w) => s + w.compliance_pct, 0) / secondHalf.length;
  const diff = avgSecond - avgFirst;
  if (diff > 5) return 'Your consistency is improving — keep building the habit.';
  if (diff < -5) return 'Consistency has dipped — focus on showing up.';
  return 'Staying consistent — keep it up.';
}

function barColor(pct: number): string {
  if (pct >= 80) return '#22C55E';
  if (pct >= 50) return '#F59E0B';
  return '#EF4444';
}

export default function AdherenceTrendCard({ authToken, themeName }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [weeks, setWeeks] = useState<AdherenceWeek[] | null>(null);
  const [streak, setStreak] = useState<StreakSummary | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      getAdherenceTrend(authToken, 8).catch(() => null),
      getStreak(authToken).catch(() => null),
    ]).then(([trend, s]) => {
      if (!alive) return;
      if (trend?.weeks) setWeeks(trend.weeks);
      if (s) setStreak(s);
    });
    return () => { alive = false; };
  }, [authToken]);

  if (!weeks || weeks.length === 0) return null;
  const hasAnyActivity = weeks.some(w => w.completed > 0) || (streak && streak.current_streak > 0);
  if (!hasAnyActivity) return null;

  const compliance30 = streak?.compliance_30d ?? 0;
  const currentStreak = streak?.current_streak ?? 0;
  const maxPct = Math.max(...weeks.map(w => w.compliance_pct), 1);

  return (
    <View style={{
      backgroundColor: tc.surface,
      borderRadius: radius.lg,
      padding: 16,
      marginBottom: 14,
      borderWidth: 1,
      borderColor: tc.border,
    }}>
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setExpanded(e => !e);
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Ionicons name="bar-chart-outline" size={18} color={tc.primary} />
          <Text style={{ fontSize: 15, fontWeight: '700', color: tc.textPrimary, flex: 1 }}>
            Plan Adherence
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            {currentStreak > 0 && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                <Ionicons name="flame" size={13} color="#F59E0B" />
                <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>
                  {currentStreak}
                </Text>
              </View>
            )}
            <Text style={{ fontSize: 22, fontWeight: '800', color: tc.primary }}>
              {Math.round(compliance30)}%
            </Text>
          </View>
          <Ionicons
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={16}
            color={tc.textMuted}
          />
        </View>
        <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }}>
          30-day compliance{currentStreak > 0 ? ` · ${currentStreak} day streak` : ''}
        </Text>
      </TouchableOpacity>

      {expanded && (
        <View style={{ marginTop: 16 }}>
          <View style={{
            flexDirection: 'row',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 4,
            height: 120,
          }}>
            {weeks.map((w) => {
              const h = maxPct > 0 ? Math.max(6, (w.compliance_pct / 100) * 100) : 6;
              return (
                <View key={w.week_start} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end', gap: 3 }}>
                  <Text style={{ fontSize: 9, fontWeight: '600', color: tc.textMuted }}>
                    {w.completed}/{w.planned}
                  </Text>
                  <View style={{
                    width: '65%',
                    height: h,
                    borderRadius: 4,
                    backgroundColor: barColor(w.compliance_pct),
                  }} />
                  <Text style={{ fontSize: 8, color: tc.textMuted }}>
                    {formatWeekLabel(w.week_start)}
                  </Text>
                </View>
              );
            })}
          </View>

          <Text style={{
            fontSize: 12,
            color: tc.textSecondary,
            fontStyle: 'italic',
            marginTop: 12,
            textAlign: 'center',
          }}>
            {coachingMessage(weeks)}
          </Text>
        </View>
      )}
    </View>
  );
}
