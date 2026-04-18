/**
 * SkeletonLoader — shimmer placeholder for loading states.
 * Renders a pulsing rectangle that matches the shape of content.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, ViewStyle, Easing } from 'react-native';

interface Props {
  width?: number | string;
  height?: number;
  borderRadius?: number;
  style?: ViewStyle;
  color?: string;
}

export default function SkeletonLoader({
  width = '100%',
  height = 16,
  borderRadius = 8,
  style,
  color,
}: Props) {
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, []);

  return (
    <Animated.View
      style={[
        {
          width: width as any,
          height,
          borderRadius,
          backgroundColor: color ?? '#374151',
          opacity,
        },
        style,
      ]}
    />
  );
}

/** Pre-built skeleton for a card with title + 2 lines + badge. */
export function CardSkeleton({ style }: { style?: ViewStyle }) {
  return (
    <Animated.View style={[{ padding: 14, gap: 10 }, style]}>
      <SkeletonLoader width="40%" height={14} />
      <SkeletonLoader width="100%" height={12} />
      <SkeletonLoader width="75%" height={12} />
      <SkeletonLoader width="30%" height={20} borderRadius={10} />
    </Animated.View>
  );
}

/** Pre-built skeleton for a meal row. */
export function MealRowSkeleton() {
  return (
    <Animated.View style={{ flexDirection: 'row', alignItems: 'center', padding: 12, gap: 10 }}>
      <SkeletonLoader width={20} height={20} borderRadius={10} />
      <Animated.View style={{ flex: 1, gap: 6 }}>
        <SkeletonLoader width="60%" height={14} />
        <SkeletonLoader width="80%" height={10} />
      </Animated.View>
      <SkeletonLoader width={50} height={14} />
    </Animated.View>
  );
}

/** Pre-built skeleton for a workout day card. */
export function WorkoutDaySkeleton() {
  return (
    <Animated.View style={{ padding: 14, gap: 8, borderRadius: 12 }}>
      <Animated.View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <SkeletonLoader width="35%" height={16} />
        <SkeletonLoader width={50} height={16} borderRadius={8} />
      </Animated.View>
      <SkeletonLoader width="50%" height={12} />
      <SkeletonLoader width="100%" height={10} />
      <SkeletonLoader width="100%" height={10} />
    </Animated.View>
  );
}
