import { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import type { ThemeColors } from '../constants/theme';
import { useReducedMotion } from '../utils/motion';

type Intensity = 'quiet' | 'standard';

type Props = {
  colors: ThemeColors;
  intensity?: Intensity;
  style?: StyleProp<ViewStyle>;
};

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.trim().replace('#', '');
  if (clean.length !== 6) return null;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return null;
  return { r, g, b };
}

function rgba(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
}

function isDark(hex: string): boolean {
  const rgb = hexToRgb(hex);
  if (!rgb) return true;
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance < 0.56;
}

export default function MovingGradientBackground({ colors, intensity = 'standard', style }: Props) {
  const reducedMotion = useReducedMotion();
  const drift = useRef(new Animated.Value(0)).current;
  const darkMode = isDark(colors.background);

  const alpha = useMemo(() => {
    const base = intensity === 'quiet' ? 0.72 : 1;
    const mode = darkMode ? 1 : 0.88;
    return base * mode;
  }, [darkMode, intensity]);
  const gradientStops = useMemo(() => {
    if (darkMode) {
      return {
        topPrimary: 0.52,
        topPrimaryLight: 0.3,
        bottomAccent: 0.36,
        bottomPrimary: 0.28,
        glowPrimaryLight: 0.24,
        glowAccent: 0.18,
      };
    }
    return {
      topPrimary: 0.62,
      topPrimaryLight: 0.42,
      bottomAccent: 0.5,
      bottomPrimary: 0.36,
      glowPrimaryLight: 0.36,
      glowAccent: 0.28,
    };
  }, [darkMode]);

  useEffect(() => {
    if (reducedMotion) {
      drift.setValue(0.48);
      return;
    }

    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(drift, {
          toValue: 1,
          duration: 14000,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(drift, {
          toValue: 0,
          duration: 14000,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [drift, reducedMotion]);

  const topOpacity = drift.interpolate({
    inputRange: [0, 0.45, 1],
    outputRange: [0.1 * alpha, 0.24 * alpha, 0.13 * alpha],
  });
  const bottomOpacity = drift.interpolate({
    inputRange: [0, 0.55, 1],
    outputRange: [0.08 * alpha, 0.14 * alpha, 0.22 * alpha],
  });
  const accentOpacity = drift.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.06 * alpha, 0.13 * alpha, 0.07 * alpha],
  });
  const translateX = drift.interpolate({
    inputRange: [0, 1],
    outputRange: [-26, 30],
  });
  const topTranslateY = drift.interpolate({
    inputRange: [0, 1],
    outputRange: [-34, 28],
  });
  const bottomTranslateY = drift.interpolate({
    inputRange: [0, 1],
    outputRange: [34, -24],
  });
  const accentTranslateY = drift.interpolate({
    inputRange: [0, 1],
    outputRange: [-16, 20],
  });
  const scale = drift.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.07],
  });

  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.root, style]}>
      <Animated.View
        style={[
          styles.washTop,
          {
            opacity: topOpacity,
            transform: [
              { translateX },
              { translateY: topTranslateY },
              { rotate: '-10deg' },
              { scale },
            ],
          },
        ]}>
        <LinearGradient
          colors={[
            rgba(colors.primary, 0),
            rgba(colors.primary, gradientStops.topPrimary),
            rgba(colors.primaryLight, gradientStops.topPrimaryLight),
            rgba(colors.primary, 0),
          ] as const}
          locations={[0, 0.35, 0.7, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>

      <Animated.View
        style={[
          styles.washBottom,
          {
            opacity: bottomOpacity,
            transform: [
              { translateX },
              { translateY: bottomTranslateY },
              { rotate: '13deg' },
              { scale },
            ],
          },
        ]}>
        <LinearGradient
          colors={[
            rgba(colors.accent, 0),
            rgba(colors.accent, gradientStops.bottomAccent),
            rgba(colors.primary, gradientStops.bottomPrimary),
            rgba(colors.accent, 0),
          ] as const}
          locations={[0, 0.28, 0.66, 1]}
          start={{ x: 1, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>

      <Animated.View
        style={[
          styles.accentGlow,
          {
            opacity: accentOpacity,
            transform: [
              { translateY: accentTranslateY },
              { scale },
            ],
          },
        ]}>
        <LinearGradient
          colors={[
            rgba(colors.primaryLight, 0),
            rgba(colors.primaryLight, gradientStops.glowPrimaryLight),
            rgba(colors.accent, gradientStops.glowAccent),
            rgba(colors.primaryLight, 0),
          ] as const}
          locations={[0, 0.34, 0.72, 1]}
          start={{ x: 0.15, y: 0 }}
          end={{ x: 0.85, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    overflow: 'hidden',
  },
  washTop: {
    position: 'absolute',
    top: '2%',
    left: -96,
    right: -96,
    height: '42%',
  },
  washBottom: {
    position: 'absolute',
    left: -110,
    right: -110,
    bottom: '5%',
    height: '46%',
  },
  accentGlow: {
    position: 'absolute',
    top: '28%',
    left: -80,
    right: -80,
    height: '40%',
  },
});
