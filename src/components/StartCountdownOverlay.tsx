// 3-2-1-go countdown shown on workout start. Full-screen themed
// overlay that counts down 3 → 2 → 1 → motivational phrase, then
// invokes `onComplete` so the parent can unmount it.
//
// Animation rhythm:
//  • Each tick lives 700ms. The numeral enters scaled 1.3x + fully
//    opaque, then eases down to 1.0x / 0 alpha.
//  • Final message ticks for ~1100ms so it reads as a resolution, not
//    another count.
//  • Every tick fires a haptic — light for the numbers, heavy for the
//    go message — so users who aren't watching still feel the beat.
//
// Theme-matched: background is a near-opaque surface, numerals use
// `primary`, trim accents use `primary + "55"` so every theme preset
// gets the same treatment for free.

import { useEffect, useRef, useState } from 'react';
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

export default function StartCountdownOverlay({ themeName, onComplete, finalMessage }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  // Freeze the phrase for the lifetime of the overlay so it doesn't
  // re-roll mid-animation on a re-render.
  const phrase = useRef<string>(finalMessage ?? pickPhrase()).current;

  const ticks: Tick[] = [
    { label: '3', duration: 700, isFinal: false },
    { label: '2', duration: 700, isFinal: false },
    { label: '1', duration: 700, isFinal: false },
    { label: phrase, duration: 1100, isFinal: true },
  ];

  const [idx, setIdx] = useState(0);
  const scale = useRef(new Animated.Value(1.35)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (idx >= ticks.length) {
      onComplete();
      return;
    }
    const tick = ticks[idx];
    // Haptic on each enter. Heavy on the go-word, light on the counts.
    import('../utils/feedback').then(f => {
      if (tick.isFinal) f.hapticHeavy?.();
      else f.hapticLight?.();
    }).catch(() => {});

    // Reset and animate: pop in (scale 1.35 → 1.0, opacity 0 → 1)
    // then hold briefly then fade out (opacity 1 → 0).
    scale.setValue(1.35);
    opacity.setValue(0);
    Animated.parallel([
      Animated.timing(scale, {
        toValue: 1.0,
        duration: Math.min(260, tick.duration * 0.4),
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start();

    const fadeStart = setTimeout(() => {
      Animated.timing(opacity, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true,
      }).start();
    }, tick.duration - 220);

    const advance = setTimeout(() => {
      setIdx(i => i + 1);
    }, tick.duration);

    return () => {
      clearTimeout(fadeStart);
      clearTimeout(advance);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx]);

  if (idx >= ticks.length) return null;
  const tick = ticks[idx];

  return (
    <View
      pointerEvents="auto"
      style={{
        position: 'absolute',
        top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: tc.background + 'F2',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10_000,
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
      <Animated.View style={{
        transform: [{ scale }],
        opacity,
        alignItems: 'center',
      }}>
        <Text
          numberOfLines={1}
          adjustsFontSizeToFit
          style={{
            fontSize: tick.isFinal ? 56 : 140,
            fontWeight: '900',
            letterSpacing: tick.isFinal ? 1.5 : -4,
            color: tc.primary,
            textAlign: 'center',
            paddingHorizontal: 32,
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
            letterSpacing: 2,
            fontWeight: '700',
            color: tc.textMuted,
            marginTop: 8,
          }}>
            STARTING
          </Text>
        ) : null}
      </Animated.View>
    </View>
  );
}
