import { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, LayoutAnimation, Platform, UIManager, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { getAdherenceTrend, getStreak, AdherenceWeek, StreakSummary } from '../services/api';
import { ScoreInfoModal, ScoreInfoSection, ScoreInfoBody, ScoreInfoRow } from './ScoreInfoModal';

/** A single week's column whose height eases up from 0 → target on mount,
 *  with a per-bar delay so the row sweeps left → right like a stadium wave. */
function AnimatedWeekBar({ height, color, delay }: { height: number; color: string; delay: number }) {
  const h = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(h, {
      toValue: height,
      duration: 600,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [height, delay, h]);
  return (
    <Animated.View style={{
      width: '65%',
      height: h,
      borderRadius: 4,
      backgroundColor: color,
      overflow: 'hidden',
    }}>
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(255,255,255,0.34)', color, 'rgba(0,0,0,0.12)'] as any}
        locations={[0, 0.48, 1]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
      />
    </Animated.View>
  );
}

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
  const [infoOpen, setInfoOpen] = useState(false);

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
      overflow: 'hidden',
    }}>
      <LinearGradient
        pointerEvents="none"
        colors={[tc.primary + '18', 'transparent'] as any}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
      />
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
          <TouchableOpacity
            accessibilityLabel="How adherence is calculated"
            onPress={(e) => { e.stopPropagation(); setInfoOpen(true); }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={{ padding: 2 }}>
            <Ionicons name="information-circle-outline" size={16} color={tc.textMuted} />
          </TouchableOpacity>
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
            {weeks.map((w, wIdx) => {
              const h = maxPct > 0 ? Math.max(6, (w.compliance_pct / 100) * 100) : 6;
              return (
                <View key={w.week_start} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end', gap: 3 }}>
                  <Text style={{ fontSize: 9, fontWeight: '600', color: tc.textMuted }}>
                    {w.completed}/{w.planned}
                  </Text>
                  <AnimatedWeekBar height={h} color={barColor(w.compliance_pct)} delay={wIdx * 60} />
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
      <ScoreInfoModal
        visible={infoOpen}
        onClose={() => setInfoOpen(false)}
        eyebrow="PLAN ADHERENCE"
        title="How adherence is calculated"
        iconName="bar-chart-outline"
        iconColor={tc.primary}
        themeName={themeName}>
        <ScoreInfoBody themeName={themeName}>
          The percent of planned workouts you completed in the last 30
          days. A workout counts as completed when you log at least one
          set against the day's plan. Rest, recovery, and mobility days
          don't count against you.
        </ScoreInfoBody>
        <ScoreInfoSection title="The numbers" themeName={themeName}>
          <ScoreInfoRow label="Big number" value="completed ÷ planned (last 30d)" themeName={themeName} />
          <ScoreInfoRow label="Streak 🔥" value="consecutive days hit (no rest skips)" themeName={themeName} />
          <ScoreInfoRow label="Weekly bars" value="last 8 weeks, color by hit-rate" themeName={themeName} />
        </ScoreInfoSection>
        <ScoreInfoSection title="Bar colors" themeName={themeName}>
          <ScoreInfoRow label="80%+" value="On track" valueColor="#22C55E" themeName={themeName} />
          <ScoreInfoRow label="50–79%" value="Inconsistent" valueColor="#F59E0B" themeName={themeName} />
          <ScoreInfoRow label="Below 50%" value="Falling behind" valueColor="#EF4444" themeName={themeName} />
        </ScoreInfoSection>
        <ScoreInfoBody themeName={themeName} muted>
          Adherence rewards consistency, not intensity. A 30-minute
          session you actually did beats a 90-minute one you planned
          and skipped.
        </ScoreInfoBody>
      </ScoreInfoModal>
    </View>
  );
}
