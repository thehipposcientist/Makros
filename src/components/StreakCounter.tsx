/**
 * StreakCounter — animated streak display with counting number
 * and subtle glow effect for active streaks.
 */
import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, ViewStyle, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface Props {
  count: number;
  label?: string;
  color?: string;
  style?: ViewStyle;
}

export default function StreakCounter({
  count,
  label = 'day streak',
  color = '#F59E0B',
  style,
}: Props) {
  const scale     = useRef(new Animated.Value(1)).current;
  const glow      = useRef(new Animated.Value(0)).current;
  const flameLoop = useRef(new Animated.Value(0)).current;
  // Flash transitions 0 → 1 → 0 on every count change so the flame
  // briefly punches up to white before settling back to the streak
  // color. Reads as "you just earned that increment."
  const flash     = useRef(new Animated.Value(0)).current;
  const prevCount = useRef(count);

  useEffect(() => {
    if (count > 0) {
      // Bump animation when count changes
      Animated.sequence([
        Animated.spring(scale, { toValue: 1.15, damping: 8, stiffness: 200, mass: 0.6, useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, damping: 12, stiffness: 180, useNativeDriver: true }),
      ]).start();

      // Subtle pulse glow for active streaks
      Animated.loop(
        Animated.sequence([
          Animated.timing(glow, { toValue: 1, duration: 1500, useNativeDriver: true }),
          Animated.timing(glow, { toValue: 0, duration: 1500, useNativeDriver: true }),
        ]),
      ).start();

      // Continuous flame breathe — small scale loop in parallel with
      // the opacity glow above. Adds energy without distracting from
      // the rest of the UI (max 1.08x).
      Animated.loop(
        Animated.sequence([
          Animated.timing(flameLoop, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(flameLoop, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ]),
      ).start();

      // Color flash on every increment (not the initial mount).
      if (prevCount.current !== count && prevCount.current !== undefined) {
        flash.setValue(0);
        Animated.sequence([
          Animated.timing(flash, { toValue: 1, duration: 180, useNativeDriver: true }),
          Animated.timing(flash, { toValue: 0, duration: 480, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        ]).start();
      }
    }
    prevCount.current = count;
  }, [count]);

  if (count === 0) return null;

  const glowOpacity = glow.interpolate({ inputRange: [0, 1], outputRange: [0.3, 0.7] });
  const flameScale = flameLoop.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });

  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 6 }, style]}>
      <Animated.View style={{ transform: [{ scale: Animated.multiply(scale, flameScale) }] }}>
        <View>
          <Ionicons name="flame" size={20} color={color} />
          {/* White flame layered on top fades in briefly when the count
              increments, giving a "spark" without changing the base hue. */}
          <Animated.View style={{ position: 'absolute', top: 0, left: 0, opacity: flash }}>
            <Ionicons name="flame" size={20} color="#FFFFFF" />
          </Animated.View>
        </View>
      </Animated.View>
      <Animated.View style={{ opacity: glowOpacity }}>
        <Text style={{ fontSize: 16, fontWeight: '800', color }}>
          {count}
        </Text>
      </Animated.View>
      <Text style={{ fontSize: 12, color: color + '99', fontWeight: '600' }}>{label}</Text>
    </View>
  );
}
