import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import type { ColorValue, StyleProp, ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { useReducedMotion } from '../utils/motion';

type GradientColors = readonly [ColorValue, ColorValue, ...ColorValue[]];
const AnimatedLinearGradient = Animated.createAnimatedComponent(LinearGradient);

interface TodayGradientBorderProps {
  colors: GradientColors;
  borderRadius: number;
  baseColor?: ColorValue;
  borderWidth?: number;
  durationMs?: number;
  height?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export default function TodayGradientBorder({
  colors,
  borderRadius,
  baseColor,
  borderWidth = 3,
  durationMs = 5600,
  height,
  style,
  testID,
}: TodayGradientBorderProps) {
  const progress = useRef(new Animated.Value(0)).current;
  const gradientId = useRef(`todayBorderGradient-${Math.random().toString(36).slice(2)}`).current;
  const reduceMotion = useReducedMotion();
  const [layout, setLayout] = useState({ width: 0, height: 0 });

  useEffect(() => {
    progress.stopAnimation();
    if (reduceMotion) {
      progress.setValue(0.35);
      return;
    }

    progress.setValue(0);
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: durationMs,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [durationMs, progress, reduceMotion]);

  const frame = useMemo(() => {
    const inset = borderWidth / 2;
    const width = Math.max(0, layout.width - inset * 2);
    const frameHeight = Math.max(0, layout.height - inset * 2);
    const r = Math.max(0, Math.min(borderRadius - inset, width / 2, frameHeight / 2));
    return { inset, width, height: frameHeight, radius: r };
  }, [borderRadius, borderWidth, layout.height, layout.width]);

  const gradientX1 = progress.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: ['-120%', '80%', '-120%'],
  });
  const gradientY1 = progress.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: ['0%', '-80%', '0%'],
  });
  const gradientX2 = progress.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: ['20%', '220%', '20%'],
  });
  const gradientY2 = progress.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: ['100%', '20%', '100%'],
  });
  const railColor = baseColor ?? colors[1] ?? colors[0];

  return (
    <View
      pointerEvents="none"
      testID={testID}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={(event) => {
        const next = event.nativeEvent.layout;
        setLayout(prev => (
          Math.round(prev.width) === Math.round(next.width) && Math.round(prev.height) === Math.round(next.height)
            ? prev
            : { width: next.width, height: next.height }
        ));
      }}
      style={[
        styles.root,
        height == null ? styles.fill : { height },
        { borderRadius },
        style,
      ]}
    >
      {frame.width > 0 && frame.height > 0 ? (
        <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
          <Defs>
            <AnimatedLinearGradient
              id={gradientId}
              x1={gradientX1 as any}
              y1={gradientY1 as any}
              x2={gradientX2 as any}
              y2={gradientY2 as any}
            >
              {colors.map((color, index) => (
                <Stop
                  key={`${index}-${String(color)}`}
                  offset={`${(index / Math.max(1, colors.length - 1)) * 100}%`}
                  stopColor={color}
                />
              ))}
            </AnimatedLinearGradient>
          </Defs>
          <Rect
            x={frame.inset}
            y={frame.inset}
            width={frame.width}
            height={frame.height}
            rx={frame.radius}
            ry={frame.radius}
            fill="none"
            stroke={railColor}
            strokeWidth={borderWidth}
            strokeOpacity={0.48}
          />
          <Rect
            x={frame.inset}
            y={frame.inset}
            width={frame.width}
            height={frame.height}
            rx={frame.radius}
            ry={frame.radius}
            fill="none"
            stroke={`url(#${gradientId})`}
            strokeWidth={borderWidth}
            strokeLinecap="round"
          />
        </Svg>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    overflow: 'hidden',
    zIndex: 12,
  },
  fill: {
    bottom: 0,
  },
});
