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
  "Progress over perfection.",
  "Your limits are self-imposed.",
  "The work doesn't care how you feel.",
  "Show up. Level up.",
  "Stronger every session.",
  "The only easy day was yesterday.",
  "Earn it.",
  "Do the work.",
  "Discipline creates freedom.",
  "Champions are made when no one is watching.",
  "Every workout is a deposit in your health account.",
  "Sore today, strong tomorrow.",
  "Your body is your machine — maintain it.",
  "Rest is part of the work.",
  "Trust the process.",
  "Five more minutes. Five more reps.",
  "The version of you who showed up wins.",
  "Make the time. No one else will.",
  "Movement is medicine.",
  "Consistency is the competitive edge.",
  "Don't wait for motivation. Build discipline.",
  "You regret the workouts you skip, not the ones you do.",
  "Push through. The other side is worth it.",
  "Every rep writes your story.",
  "Work hard. Recover harder.",
  "Good things take time. Keep going.",
  "You already know what to do.",
  "No days off from being great.",
  "The bar doesn't care about your excuses.",
  "Fitness is a practice, not a destination.",
  "Pressure makes diamonds.",
  "Your future self will thank you.",
  "Build the version of yourself you're proud of.",
  "Hard things first.",
  "The process is the point.",
  "One workout at a time.",
  "Fueled by discipline, not mood.",
  "Be relentless.",
  "Results are earned, not wished for.",
  "Iron doesn't lie.",
  "Push the pace.",
  "You don't need to be perfect. You need to be consistent.",
  "Strength is built in the repetitions.",
  "Believe in the work.",
  "Nothing worth having comes easy.",
  "Get comfortable being uncomfortable.",
  "The harder you work, the luckier you get.",
  "Failure is feedback. Keep adjusting.",
  "Win the morning, win the day.",
  "You're one workout away from a better mood.",
  "Patience + persistence = transformation.",
  "Leave it all in the gym.",
  "Strength is not just physical.",
  "Show up for yourself — every single day.",
  "Do it scared. Do it tired. Just do it.",
  "Momentum is built one session at a time.",
  "Breathe. Focus. Execute.",
  "You're capable of more than you think.",
  "Grow through what you go through.",
  "Better than yesterday — that's the only bar.",
  "Hard work beats talent when talent doesn't work hard.",
  "Train your weaknesses.",
  "There's no substitute for showing up.",
  "Stay in the process.",
  "Forward is a pace.",
  "Get after it.",
  "Every day is a new opportunity.",
  "Commit fully. Half-effort, half-results.",
  "On the days you least want to, it matters most.",
  "Stop wishing. Start working.",
  "You've done harder things than this.",
  "Small consistent actions compound.",
  "No ceiling. Keep climbing.",
  "The journey builds the character.",
  "You are what you repeatedly do.",
  "Move with intention.",
  "Today's choices are tomorrow's body.",
  "Embrace the grind.",
  "Success is rented. The rent is due every day.",
  "Turn setbacks into fuel.",
  "Stay hungry.",
  "Never miss twice.",
  "You came here to work — now work.",
  "Burn. Build. Repeat.",
  "Make every session matter.",
  "Effort is free. Deploy it fully.",
  "You are the project.",
  "Pain is temporary. Gains are real.",
  "Start strong. Finish stronger.",
  "Never settle for yesterday's performance.",
  "Prove it to yourself.",
  "The body follows where the mind leads.",
  "Outwork everyone.",
  "Own the day.",
  "You're stronger than your last set.",
  "Another day, another chance to build.",
  "Greatness requires repetition.",
  "You don't find time — you make it.",
  "Grind in silence. Let results make noise.",
  "This is where the work gets done.",
  "Forged through effort.",
  "Intensity breeds intensity.",
  "Make the uncomfortable comfortable.",
  "Lift, learn, adapt, repeat.",
  "Every session is a test of character.",
  "Earned with sweat. Kept with consistency.",
  "Don't count the days — make the days count.",
  "Be the athlete you want to be.",
  "Your habits are your destiny.",
  "What you do today compounds tomorrow.",
  "Built one set at a time.",
  "Hard work pays off — eventually.",
  "Fitness is lifestyle. Commit to it.",
  "Never let a bad day become a bad week.",
  "Attack the day.",
  "Today's session is tomorrow's baseline.",
  "The effort always matters.",
  "Work so hard your problems can't keep up.",
  "You choose your hard.",
  "Dedication is the price of results.",
  "Train like you mean it.",
  "Your discipline is your superpower.",
  "Set. Rep. Progress. Repeat.",
  "Earn the finish line.",
  "Nothing good comes from the couch.",
  "Conquer today.",
  "Mind over muscle. Both matter.",
  "One good session can change your momentum.",
  "Don't talk about it — be about it.",
  "Champions show up especially on hard days.",
  "The grind is the goal.",
  "Progress is peace.",
  "Make hard work your identity.",
  "Own your potential.",
  "Be the reason your future self is grateful.",
  "The best is yet to come — keep training.",
  "Outperform who you were last week.",
  "Discipline today. Freedom tomorrow.",
  "You're not tired. You're just getting started.",
  "The only competition is in the mirror.",
  "Run your race. Run it well.",
  "Champions are forged in the off days.",
  "Stop surviving. Start thriving.",
  "Every drop of sweat is an investment.",
  "You rise by lifting others — and yourself.",
  "Chase the version of you that hasn't given up.",
  "Deliberate practice beats casual effort every time.",
  "The clock is ticking. Use it.",
  "Hard sessions build easy lives.",
  "Success is a series of small wins.",
  "Grit is a skill. Practice it.",
  "Stay locked in.",
  "Repetition is the mother of mastery.",
  "Strong body. Clear mind. Sharp focus.",
  "You can do hard things.",
  "Put in the time. The time pays back.",
  "Show the work. The work shows.",
];

function getDailyMotto(name?: string): string {
  const now = new Date();
  const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000);
  const motto = DAILY_MOTTOS[dayOfYear % DAILY_MOTTOS.length];
  if (name) {
    // name is a real first name from profile; fall back to splitting on
    // spaces/underscores when it's still a legacy username
    const first = name.split(/[\s_]/)[0];
    const cap = first.charAt(0).toUpperCase() + first.slice(1);
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
