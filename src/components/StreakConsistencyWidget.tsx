import { useEffect, useRef, useState } from 'react';
import { View, Text, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { getStreak, StreakSummary } from '../services/api';

interface Props {
  authToken: string;
  themeName?: AppThemeName;
  displayName?: string;
}

const DAILY_MOTTOS = [
  "Every rep is a vote for who you're becoming.",
  "The only workout you regret is the one you skipped.",
  "Show up. That's 80% of it.",
  "Discipline is just doing it on the days you don't feel like it.",
  "Strong is built, not born.",
  "One more set. One more day. One more week.",
  "The body achieves what the mind believes.",
  "Consistency beats intensity. Every time.",
  "You don't have to be great to start, but you have to start to be great.",
  "Progress is progress, no matter how small.",
  "Earned, not given.",
  "Champions train. Everyone else just exercises.",
  "The pain you feel today is the strength you feel tomorrow.",
  "Make yourself proud.",
  "Small steps still move you forward.",
  "Be the hardest worker in the room.",
  "It always seems impossible until it's done.",
  "Your future self is watching.",
  "Push harder than yesterday.",
  "The grind doesn't stop.",
  "Results come to those who show up.",
  "Train like there's no off-season.",
  "You are stronger than your excuses.",
  "The only bad workout is the one that didn't happen.",
  "Outwork your doubt.",
  "Fall in love with the process.",
  "Built different.",
  "Sweat now. Shine later.",
  "Earn your rest.",
  "Keep going — you're closer than you think.",
  "Fuel the fire.",
  "Hard work compounds.",
  "Every session leaves a mark.",
  "Today's effort is tomorrow's edge.",
  "The standard is the standard.",
  "No shortcuts. No excuses.",
  "Your best competition is yesterday's you.",
  "Commit to the process, trust the results.",
  "Do it for the version of you that doubted it.",
  "Train hard. Recover smart. Repeat.",
  "One decision at a time.",
  "You've got this.",
  "Make it count.",
];

function getDailyMotto(name?: string): string {
  const now = new Date();
  const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000);
  const motto = DAILY_MOTTOS[dayOfYear % DAILY_MOTTOS.length];
  if (name) {
    const first = name.split(/[\s_]/)[0];
    const cap = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
    return `${cap} — ${motto}`;
  }
  return motto;
}

export { getDailyMotto };

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

export default function StreakConsistencyWidget({ authToken, themeName, displayName }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [data, setData] = useState<StreakSummary | null>(null);

  const lastAnimatedStreak = useRef<number | null>(null);
  const streakScale = useRef(new Animated.Value(1)).current;
  const flamePulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await getStreak(authToken);
        if (alive) setData(r);
      } catch { /* silent */ }
    })();
    return () => { alive = false; };
  }, [authToken]);

  useEffect(() => {
    if (!data) return;
    const cur = data.current_streak;
    const prev = lastAnimatedStreak.current;
    if (prev !== null && cur > prev) {
      streakScale.setValue(1);
      Animated.sequence([
        Animated.timing(streakScale, { toValue: 1.3, duration: 180, useNativeDriver: true }),
        Animated.timing(streakScale, { toValue: 1.0, duration: 220, useNativeDriver: true }),
      ]).start();
    }
    lastAnimatedStreak.current = cur;
  }, [data?.current_streak, streakScale]);

  const onFire = (data?.compliance_7d ?? 0) >= 80;
  useEffect(() => {
    if (!onFire) {
      flamePulse.stopAnimation(() => flamePulse.setValue(1));
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(flamePulse, { toValue: 1.025, duration: 700, useNativeDriver: true }),
        Animated.timing(flamePulse, { toValue: 1.0, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => { loop.stop(); };
  }, [onFire, flamePulse]);

  const motto = getDailyMotto(displayName);

  return (
    <View style={{
      borderRadius: radius.md,
      paddingHorizontal: 10, paddingVertical: 8,
      marginBottom: 8,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    }}>
      {/* Flame + streak days — only when streak > 0 */}
      {data && data.current_streak > 0 && (
        <View style={{
          flexDirection: 'row', alignItems: 'center', gap: 4,
          paddingHorizontal: 8, paddingVertical: 4,
          borderRadius: 12,
          backgroundColor: tc.surface,
          borderWidth: 1, borderColor: tc.border,
        }}>
          <Animated.View style={{ transform: [{ scale: streakScale }, { scale: flamePulse }] }}>
            <Ionicons name="flame" size={12} color={tc.warning} />
          </Animated.View>
          <Animated.Text style={{ fontSize: 12, fontWeight: '700', color: tc.textPrimary, fontVariant: ['tabular-nums'] as any, transform: [{ scale: streakScale }] }}>
            {data.current_streak}
          </Animated.Text>
          <Text style={{ fontSize: 10, color: tc.textSecondary }}>
            day{data.current_streak === 1 ? '' : 's'}
          </Text>
        </View>
      )}
      {/* Daily personalized motto */}
      <Text
        style={{ flex: 1, fontSize: 11, color: tc.textMuted, fontStyle: 'italic' }}
        numberOfLines={2}
      >
        {motto}
      </Text>
    </View>
  );
}
