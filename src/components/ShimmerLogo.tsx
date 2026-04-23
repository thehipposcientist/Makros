import { useEffect, useRef } from 'react';
import { Animated, Easing, Image, StyleProp, ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

interface Props {
  logoSource: any;
  width?: number;
  height?: number;
  shimmerWidth?: number;
  /** Shimmer color as "R,G,B" string or "#RRGGBB" hex. Defaults to teal brand. */
  shimmerColor?: string;
  style?: StyleProp<ViewStyle>;
}

function toRgbStr(color: string): string {
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `${r},${g},${b}`;
  }
  return color;
}

/**
 * Reusable logo with the teal shimmer sweep used on the splash screen.
 * Extracted so plan-building / regenerate loading screens carry the
 * same motion vocabulary as the app's cold-start loading screen.
 */
export default function ShimmerLogo({
  logoSource,
  width = 240,
  height = 54,
  shimmerWidth = 120,
  shimmerColor = '21,199,184',
  style,
}: Props) {
  const shimmerAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const shimmer = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmerAnim, {
          toValue: 1, duration: 3600, useNativeDriver: true,
          easing: Easing.inOut(Easing.cubic),
        }),
        Animated.delay(1400),
      ]),
    );
    shimmer.start();
    return () => shimmer.stop();
  }, [shimmerAnim]);

  const translate = shimmerAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [-shimmerWidth, width],
  });

  const rgb = toRgbStr(shimmerColor);

  return (
    <Animated.View
      testID="shimmer-logo"
      accessibilityLabel="shimmer-logo"
      style={[{ width, height, overflow: 'hidden' }, style]}
    >
      <Image source={logoSource} style={{ width, height }} resizeMode="contain" />
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          bottom: 0,
          width: shimmerWidth,
          transform: [{ translateX: translate }, { skewX: '-20deg' }],
        }}
      >
        <LinearGradient
          colors={[`rgba(${rgb},0)`, `rgba(${rgb},0.35)`, `rgba(${rgb},0)`]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={{ flex: 1 }}
        />
      </Animated.View>
    </Animated.View>
  );
}
