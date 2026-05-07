// 3-2-1-go countdown shown on workout start. Full-screen themed
// overlay that counts down 3 → 2 → 1 → motivational phrase, then
// invokes `onComplete` so the parent can unmount it.
//
// Animation rhythm:
//  • Each number lives on an even beat. It enters scaled up, settles,
//    then fades out before the next beat.
//  • Final message is only slightly longer than the counts so the
//    workout opens without a laggy pause.
//  • Every tick fires a haptic — light for the numbers, heavy for the
//    go message — so users who aren't watching still feel the beat.
//
// Theme-matched: background is a near-opaque surface, numerals use
// `primary`, trim accents use `primary + "55"` so every theme preset
// gets the same treatment for free.

import { useEffect, useRef } from 'react';
import { View, Text, Animated, Easing } from 'react-native';
import { getTheme } from '../constants/theme';
import { AppThemeName } from '../types';
import { START_PHRASES } from '../constants/startPhrases';

interface Props {
  themeName?: AppThemeName;
  onComplete: () => void;
  /** Override the final phrase. When unset, one is picked at random
   *  the first time the overlay mounts so successive workouts feel
   *  varied. */
  finalMessage?: string;
}

function pickPhrase(): string {
  return START_PHRASES[Math.floor(Math.random() * START_PHRASES.length)];
}

type Tick = { label: string; duration: number; isFinal: boolean };

const NUMBER_TICK_MS = 640;
const FINAL_TICK_MS = 760;
export const START_COUNTDOWN_TOTAL_MS = NUMBER_TICK_MS * 3 + FINAL_TICK_MS;

export default function StartCountdownOverlay({ themeName, onComplete, finalMessage }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  // Freeze the phrase for the lifetime of the overlay so it doesn't
  // re-roll mid-animation on a re-render.
  const phrase = useRef<string>(finalMessage ?? pickPhrase()).current;

  const ticks: Tick[] = [
    { label: '3', duration: NUMBER_TICK_MS, isFinal: false },
    { label: '2', duration: NUMBER_TICK_MS, isFinal: false },
    { label: '1', duration: NUMBER_TICK_MS, isFinal: false },
    { label: phrase, duration: FINAL_TICK_MS, isFinal: true },
  ];

  const tickStarts = ticks.reduce<number[]>((starts, tick, i) => {
    starts[i] = i === 0 ? 0 : starts[i - 1] + ticks[i - 1].duration;
    return starts;
  }, []);
  const progress = useRef(new Animated.Value(0)).current;
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    let cancelled = false;
    const hapticTimers: ReturnType<typeof setTimeout>[] = [];
    const startedAt = Date.now();

    progress.stopAnimation();
    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: START_COUNTDOWN_TOTAL_MS,
      duration: START_COUNTDOWN_TOTAL_MS,
      easing: Easing.linear,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) onCompleteRef.current();
    });

    (async () => {
      try {
        const [{ loadSettings }, Haptics] = await Promise.all([
          import('../utils/feedback'),
          import('expo-haptics'),
        ]);
        const settings = await loadSettings();
        if (cancelled || !settings.hapticsEnabled) return;
        ticks.forEach((tick, i) => {
          const fire = () => {
            if (tick.isFinal) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
            else Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
          };
          const delayMs = Math.max(0, tickStarts[i] - (Date.now() - startedAt));
          hapticTimers.push(setTimeout(fire, delayMs));
        });
      } catch {}
    })();

    return () => {
      cancelled = true;
      hapticTimers.forEach(clearTimeout);
      animation.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const overlayOpacity = progress.interpolate({
    inputRange: [0, START_COUNTDOWN_TOTAL_MS - 120, START_COUNTDOWN_TOTAL_MS],
    outputRange: [1, 1, 0],
    extrapolate: 'clamp',
  });

  return (
    <Animated.View
      pointerEvents="auto"
      style={{
        position: 'absolute',
        top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: tc.background + 'F2',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10_000,
        opacity: overlayOpacity,
      }}
    >
      {/* Soft coloured halo — a single big translucent ring that sits
          behind the number so the overlay feels active even in the
          moment between beats. Sized so it's visible on small phones
          without dominating larger screens. */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          width: 280, height: 280, borderRadius: 140,
          backgroundColor: tc.primary + '1A',
          borderWidth: 2, borderColor: tc.primary + '55',
        }}
      />
      {ticks.map((tick, i) => {
        const startMs = tickStarts[i];
        const enterMs = tick.isFinal ? 190 : 170;
        const exitMs = 170;
        const holdEndMs = startMs + Math.max(80, tick.duration - exitMs);
        const endMs = startMs + tick.duration;
        const opacity = progress.interpolate({
          inputRange: [startMs, startMs + (i === 0 ? 1 : enterMs), holdEndMs, endMs],
          outputRange: [i === 0 ? 1 : 0, 1, 1, 0],
          extrapolate: 'clamp',
        });
        const scale = progress.interpolate({
          inputRange: [startMs, startMs + enterMs, endMs],
          outputRange: [tick.isFinal ? 1.12 : 1.22, 1, 0.98],
          extrapolate: 'clamp',
        });
        return (
          <Animated.View key={`${tick.label}-${i}`} style={{
            position: 'absolute',
            transform: [{ scale }],
            opacity,
            alignItems: 'center',
            // Clamp to the inner diameter of the halo ring (280 - 2*16
            // padding = 248) so long phrases stay inside the circle.
            maxWidth: 248,
            paddingHorizontal: 4,
          }}>
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.5}
              style={{
                // Final phrase starts smaller so it fits without scaling;
                // adjustsFontSizeToFit handles the outliers.
                fontSize: tick.isFinal ? 40 : 140,
                fontWeight: '900',
                letterSpacing: 0,
                color: tc.primary,
                textAlign: 'center',
                // Hard shadow for readability over whatever content is
                // behind the translucent background.
                textShadowColor: tc.primary + '55',
                textShadowRadius: tick.isFinal ? 14 : 24,
              }}
            >
              {tick.label}
            </Text>
            {!tick.isFinal ? (
              <Text style={{
                fontSize: 11,
                letterSpacing: 0,
                fontWeight: '700',
                color: tc.textMuted,
                marginTop: 8,
              }}>
                STARTING
              </Text>
            ) : null}
          </Animated.View>
        );
      })}
    </Animated.View>
  );
}
