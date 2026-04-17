/**
 * StreakCounter — animated streak display with counting number
 * and subtle glow effect for active streaks.
 */
import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, ViewStyle } from 'react-native';
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
  const scale = useRef(new Animated.Value(1)).current;
  const glow = useRef(new Animated.Value(0)).current;

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
    }
  }, [count]);

  if (count === 0) return null;

  const glowOpacity = glow.interpolate({ inputRange: [0, 1], outputRange: [0.3, 0.7] });

  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 6 }, style]}>
      <Animated.View style={{ transform: [{ scale }] }}>
        <Ionicons name="flame" size={20} color={color} />
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
