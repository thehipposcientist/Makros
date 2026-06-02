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

/** Pre-built skeleton for a charted card on Progress (weight chart,
 *  body scan, recompTrajectory, cardio load). Roughly matches the
 *  layout of those cards so the page doesn't jump on first paint. */
export function ChartCardSkeleton({ height = 160 }: { height?: number } = {}) {
  return (
    <Animated.View style={{ padding: 14, gap: 10, borderRadius: 12 }}>
      <Animated.View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <SkeletonLoader width="45%" height={14} />
        <SkeletonLoader width={60} height={14} borderRadius={7} />
      </Animated.View>
      <SkeletonLoader width="32%" height={26} borderRadius={6} />
      <SkeletonLoader width="60%" height={11} />
      <SkeletonLoader width="100%" height={height} borderRadius={10} style={{ marginTop: 6 }} />
    </Animated.View>
  );
}

/** Pre-built skeleton for a single-stat tile (Tracking row on Home,
 *  daily macro circles, "Day X/42" tile). */
export function StatTileSkeleton({ height = 84 }: { height?: number } = {}) {
  return (
    <Animated.View style={{ padding: 12, gap: 6, borderRadius: 12, height, justifyContent: 'center' }}>
      <SkeletonLoader width="50%" height={10} />
      <SkeletonLoader width="35%" height={22} borderRadius={6} />
      <SkeletonLoader width="65%" height={10} />
    </Animated.View>
  );
}

/** Pre-built skeleton for a horizontal row of chips (nutrition Essentials,
 *  fats panel, etc). Render INSIDE the modal that owns the section title. */
export function MicroChipRowSkeleton({ count = 4 }: { count?: number } = {}) {
  return (
    <Animated.View style={{ flexDirection: 'row', gap: 8, paddingVertical: 4 }}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonLoader
          key={i}
          width={86}
          height={64}
          borderRadius={10}
          style={{ flex: 1, minWidth: 0 }}
        />
      ))}
    </Animated.View>
  );
}
