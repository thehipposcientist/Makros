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
  // ── Expansion to 500 (added 2026-05-01) ───────────────────────────────
  // Identity + self-image
  "You're not building a body. You're building a person.",
  "Become the kind of person who doesn't skip.",
  "The work shapes the mindset. The mindset shapes the life.",
  "Show me your habits, I'll show you your future.",
  "Be unrecognizable in a year.",
  "Habits make the human.",
  "Train the body. Sharpen the mind. Steady the spirit.",
  "You're a builder. Build today.",
  "Identity is built through small reps of who you say you are.",
  "Become someone who follows through.",
  "You earn confidence in the gym before you spend it outside.",
  "Be the person your past self needed.",
  "Carry yourself like the work is paying off.",
  "Strong mind. Strong body. Strong life.",
  "You're an athlete every day you choose to be one.",
  "Lift like the person you want to become already does.",
  "The hardest thing to lift is yourself off the couch — start there.",
  "Be the proof your doubts were wrong.",
  "Discipline is self-respect in motion.",
  "Effort is the only signature that matters.",
  "Don't wait for permission to be great.",
  "You don't rise to your goals — you fall to your habits.",
  "Be relentless about the boring stuff.",
  "Your best self is on the other side of the rep you don't want to do.",
  "Excellence is a habit, not an event.",
  "The body keeps the receipts. Pay them honestly.",
  "Do it again. That's how greatness gets made.",
  "Become the standard you set.",
  "Quiet effort beats loud intentions.",
  "Self-discipline is the highest form of self-love.",
  // Process + progress
  "Compounding only works if you don't quit.",
  "Reps you don't feel like doing are the ones that change you.",
  "Today's set is tomorrow's foundation.",
  "Show up bored. Leave proud.",
  "The slow way is the only way that lasts.",
  "Don't measure progress in days. Measure it in months.",
  "You'll never feel ready. Start anyway.",
  "Stack good days. They become a great year.",
  "Progress lives on the other side of patience.",
  "Boring consistency beats exciting bursts.",
  "Long-term thinking is a competitive advantage.",
  "Aim for 1% better. Trust the math.",
  "Forward, even when slow, is still forward.",
  "The first 5 minutes are the hardest. Get past them.",
  "Inputs are in your control. Stay focused on inputs.",
  "Today's effort buys tomorrow's options.",
  "Stop optimizing. Start training.",
  "Done is better than perfect.",
  "The reps that don't feel productive are still building you.",
  "Trust the boring week.",
  "Stack one good decision on top of another.",
  "What you do today, you become.",
  "The set that earns you the result is rarely the set that feels good.",
  "Stay in the work — the rewards arrive later than you'd like.",
  "Linear progress is rare. Trust the trend, not the day.",
  "Wins compound quietly. Keep stacking them.",
  "Don't sprint the marathon.",
  "There's no finish line. Just the next rep.",
  "Plant the seed. Water it. Repeat.",
  "Time + effort > talent + excuses.",
  // Mental toughness
  "You don't have to feel like it. You just have to do it.",
  "Your brain will tell you to stop long before your body needs to.",
  "Don't negotiate with the part of you that wants to quit.",
  "Pain is information, not a stop sign.",
  "When it gets hard, you find out who you really are.",
  "Hard things are how you grow. Stop avoiding them.",
  "The first 'no' your brain gives you is a lie.",
  "Win the inner argument first.",
  "Doubt shows up — keep moving.",
  "Calm focus beats anxious effort.",
  "Adversity is the curriculum.",
  "Don't run from the heavy stuff. Pick it up.",
  "Discomfort is the price of growth.",
  "Argue with the easier path. Pick the harder one.",
  "Do it tired. Do it scared. Do it anyway.",
  "Mental reps count too. Keep the standard.",
  "The hard set teaches the most.",
  "Tired is just a feeling. Push through it.",
  "Mind first. Body follows.",
  "Discomfort means you're doing it right.",
  "Suffer well. It compounds into strength.",
  "Keep showing up — that's the whole game.",
  "Quiet the noise. Do the work.",
  "Embrace the suck. It's the work in disguise.",
  "Lean in when it hurts.",
  "The voice that says 'enough' usually lies.",
  "Tough seasons build tough people.",
  "Hard now, easier later.",
  "Difficult work is how character is built.",
  "Endurance is a mindset, not a muscle.",
  // Time + consistency
  "An hour you spend training pays interest for years.",
  "Make today count. Yesterday already did.",
  "If you have 20 minutes, you have a workout.",
  "Two days off is recovery. Three is a streak break.",
  "Be the metronome — steady, reliable, on tempo.",
  "Today is a great day to keep your streak.",
  "Time you'd waste anyway — invest it in your body.",
  "Consistency is just discipline that became a habit.",
  "Start before you're ready. Show up before you feel like it.",
  "Make the gym a non-negotiable.",
  "Same time, same effort, every week.",
  "Never miss a Monday. Or a Tuesday. Or any day.",
  "Daily wins compound into a different life.",
  "Routine is the bedrock. Build on it.",
  "The calendar doesn't lie. Earn each day.",
  "Train when motivated. Train when not. Same outcome.",
  "Habits eat goals for breakfast.",
  "If you can be there once, you can be there twice.",
  "Time is the only asset you can't earn back.",
  "Show up at the same time every day. The body will follow.",
  "Streaks are how you out-effort smarter people.",
  "Half an hour a day = a transformed year.",
  "What you do daily matters more than what you do rarely.",
  "Punch the clock. Day after day.",
  "The reps add up faster than you think.",
  "Consistency means doing it on a 5/10 day.",
  "Brick by brick. Day by day.",
  "Make the easy choice the trained one.",
  "Be early. Be ready. Be reliable.",
  "Routine is a love letter to your future self.",
  // Body + physical
  "Your body listens to every signal you send it.",
  "Train the muscle, not the ego.",
  "Heavy is relative. Effort is universal.",
  "Treat your body like the only one you're ever getting.",
  "Mobility is strength too.",
  "Eat to fuel the work, not to numb the day.",
  "Hydration is performance.",
  "Sleep is the most underrated training tool.",
  "Recovery is when you actually grow.",
  "Posture is power.",
  "Strong glutes, strong life.",
  "Carry yourself well. The body remembers.",
  "Big lifts. Big breath. Big focus.",
  "Train both sides equally. Imbalance compounds too.",
  "Master the basics before you chase the fancy stuff.",
  "Form first. Always.",
  "Slow eccentrics. Fast results.",
  "Breathe through the heavy stuff.",
  "Tension creates strength.",
  "The light weight done well beats the heavy one done sloppy.",
  "Warm up like you mean it.",
  "Cool down like a pro.",
  "Eat your vegetables. Your future joints will thank you.",
  "Protein is non-negotiable.",
  "Walk on the off days.",
  "The next rep is the rep that matters.",
  "Your grip strength predicts your future.",
  "Carry heavy things on purpose.",
  "Train balance like you train strength.",
  "Strength is the foundation everything else stands on.",
  // Recovery + patience
  "Rest hard so you can train hard.",
  "Sleep is a performance enhancer.",
  "Recovery isn't quitting. It's strategy.",
  "Listen to the body. Adjust the plan.",
  "A deload week is still part of the build.",
  "Patience is what separates the fit from the very fit.",
  "Slow down to speed up.",
  "An off-day done well is part of the work.",
  "Recovery is the magic. Don't skip it.",
  "Train when fresh. Rest when fried.",
  "Sleep early. Train hard. Repeat.",
  "Active recovery counts. Just keep moving.",
  "Healing is part of training.",
  "Pushing through pain is sometimes pushing through progress.",
  "A walk is a workout when you need it to be.",
  "Quality sleep is unfair advantage.",
  "Stretch the parts that hurt. They needed it.",
  "Mobility days save you from injury days.",
  "An honest deload preserves the long game.",
  "Listen to the small signals before they become loud ones.",
  "Recovery isn't lazy. It's wise.",
  "Eight hours of sleep beats any pre-workout.",
  "The body adapts during rest, not during work.",
  "Skip a workout. Don't skip recovery.",
  "Trust the rhythm: train, rest, train, rest.",
  // Failure + setbacks
  "Setbacks are setups for comebacks.",
  "Fall down seven, get up eight.",
  "Restart isn't failure. Restart is the strategy.",
  "Missed a day? Don't miss two.",
  "Bad workouts still count.",
  "The plan didn't fail — you just hit a hard week.",
  "Reset, don't quit.",
  "Failure is feedback wearing a costume.",
  "If you can't do it perfectly, do it imperfectly.",
  "Bounce back faster than you fell.",
  "A bad week is a chapter, not a story.",
  "Plateaus are a sign you're due for an adjustment.",
  "Some days you survive the workout. Others, the workout survives you.",
  "Comeback story starts with a single rep.",
  "The streak you broke is the streak you can rebuild.",
  "When the plan breaks, the principle stays the same: show up.",
  "Don't romanticize the past streak. Start a new one.",
  "Falling behind is just resistance training for catching up.",
  "Two steps forward, one step back is still progress.",
  "Bad day in the gym beats a missed day every time.",
  // Specific wisdom
  "If it's important, do it daily.",
  "What you tolerate is what you become.",
  "The only person you're competing against is the one in the mirror.",
  "Worth chasing is worth bleeding for.",
  "Don't out-eat your training.",
  "Effort is your fingerprint. Leave it everywhere.",
  "The world rewards specific people. Become specific.",
  "Volume is good. Intensity is better. Both, sustainably, is best.",
  "Plan the work. Then work the plan.",
  "Track your training. What gets measured gets improved.",
  "There's no version of fitness that doesn't require effort.",
  "Ego adds weight. Patience adds strength.",
  "Comparison is theft. Run your own race.",
  "Listen to your body, but don't let it run your life.",
  "If the workout is intimidating, that's exactly why you should do it.",
  "Avoid the easy. Reach for the worth-it.",
  "Your goals don't need motivation. They need execution.",
  "The body keeps score. Train it kindly and consistently.",
  "Half-effort is the loudest excuse.",
  "When in doubt, train.",
  "The path is the work. The work is the path.",
  "If the plan stops working, evolve the plan.",
  "Reps in silence beat speeches at the gym.",
  "Be a student of the work.",
  "Don't let one bad set ruin a good workout.",
  "Don't let a good workout become an excuse to coast.",
  "Sweat heals what overthinking creates.",
  "Make the gym your therapist some days.",
  "Lift heavy. Eat clean. Sleep well. Repeat.",
  "Effort never asks you to be talented.",
  "Strength training is anti-aging in disguise.",
  "Your future self is the result of your present effort.",
  "If it doesn't challenge you, it doesn't change you.",
  "Lazy days are okay. Lazy weeks aren't.",
  "Build endurance for the boring days.",
  "Train the unglamorous lifts. They run the show.",
  "Volume is a long game. Don't binge it.",
  "Aerobic base = athletic ceiling.",
  "Strong cardio = strong everything.",
  "The plan should bend. The principles shouldn't.",
  "Move with intent. Lift with purpose. Rest with discipline.",
  "Find a way to enjoy the suck.",
  "If you can spare 30 minutes, you can change your week.",
  "The body is plastic. Train it that way.",
  "Outwork yesterday. Outsmart tomorrow.",
  "Reverse engineer the result. What does the daily look like?",
  "Stretch, hydrate, sleep, repeat.",
  "Your training is the rent you pay for the body you want.",
  "The athlete inside you is waiting on the schedule, not the mood.",
  "Eat protein. Lift things. Sleep deeply. The rest is detail.",
  "Strength is a quiet kind of confidence.",
  "Most days won't feel epic. Train anyway.",
  "Discipline is freedom in disguise.",
  "Your standards are the floor — never the ceiling.",
  "What looks like obsession to others is just commitment.",
  "Become the calmest person who works the hardest.",
  "If you wouldn't write it on a sign, don't say it to yourself.",
  "Win the rep in front of you.",
  "Earn the right to your goals through daily reps.",
  "The world is full of plans. Be the one who finishes.",
  "Strong people are kinder, calmer, and better neighbors.",
  "Movement is a privilege. Honor it.",
  "Train so your aging body has options.",
  "Your kids learn what you do, not what you say.",
  "Be unmistakably committed.",
  "The reps add up. So do the missed ones.",
  "Smaller, more consistent. That's the answer to almost every fitness question.",
  "Don't trade long-term progress for short-term ego.",
  "Most success looks like staying on the trail nobody talks about.",
  "Become someone whose word matches their work.",
  "The day you don't feel like it is the day it counts the most.",
  "Tomorrow's strength is today's discipline.",
  "Earn a body that serves your life, not the mirror.",
  "Train with the next 30 years in mind.",
  "Hard work outlasts the fad.",
  "Choose effort daily. The compound interest is real.",
  "Strong bodies built strong lives.",
  "Your discipline is the gift you give your future.",
  "Run the play. Trust the system.",
  "The set that almost broke you? That's the one that built you.",
  "Lift like nobody's watching. Show up like everybody is.",
  "Discipline is what's left when motivation logs off.",
  "Build the body. Become the person.",
  "Do the work. The work does the rest.",
  "You against you, every single day.",
  // Final round to round out 500
  "Pace yourself. The hill keeps going.",
  "Be the steady one when everyone else is loud.",
  "If it's worth wanting, it's worth daily effort.",
  "Be the kind of athlete the next generation copies.",
  "Burn calm. Train hot.",
  "Lift today so you can chase grandkids tomorrow.",
  "The set you almost skipped is the one you'll remember.",
  "Reps in the dark, applause in the light.",
  "Show up small. Build big.",
  "Don't quit on a hard week. That's the whole point.",
  "The body you want lives on the other side of the work you avoid.",
  "Train alone if you have to. Just train.",
  "The strongest people are also the most patient.",
  "Effort makes the schedule. Schedule makes the results.",
  "Stay simple. Stay consistent. Stay coachable.",
  "Win quietly. Let the body do the talking.",
  "Show up when no one cares. They'll care later.",
  "The daily standard sets the lifetime ceiling.",
  "You don't need a perfect day — just a present one.",
  "Today is a small piece of a much bigger story. Show up for it.",
];

// 32-bit FNV-1a hash. Pure function, deterministic, and stable across
// app launches so a given user always gets the same daily-rotation
// offset regardless of session. We mix this with the day-of-year so
// two users on the same day see different mottos AND each user sees a
// different motto each day.
function _hashName(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h;
}

function getDailyMotto(name?: string): string {
  const now = new Date();
  const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000);
  // Per-user salt so two users on the same day don't see the same line.
  // Falls back to 0 (the legacy "everyone same" behavior) when the name
  // is missing — better than crashing or showing nothing.
  const salt = name ? _hashName(name.toLowerCase().trim()) : 0;
  const idx = (dayOfYear + salt) % DAILY_MOTTOS.length;
  const motto = DAILY_MOTTOS[idx];
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
      paddingHorizontal: 12, paddingVertical: 10,
      marginBottom: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
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
      <View style={{ flex: 1, borderLeftWidth: 2, borderLeftColor: tc.primary + '66', paddingLeft: 10 }}>
        <Text
          style={{ fontSize: 12, lineHeight: 17, color: tc.textSecondary, fontWeight: '600', fontStyle: 'italic' }}
          numberOfLines={2}
        >
          “{motto}”
        </Text>
      </View>
    </View>
  );
}
