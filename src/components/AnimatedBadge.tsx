/**
 * AnimatedBadge — reveals with scale + fade for achievements, PRs, milestones.
 * Uses basic Animated API for Expo Go compatibility.
 */
import { useEffect, useRef } from 'react';
import { Text, ViewStyle, TextStyle, Animated } from 'react-native';

interface Props {
  visible: boolean;
  label: string;
  mode?: 'standard' | 'celebration';
  delay?: number;
  color?: string;
  bgColor?: string;
  style?: ViewStyle;
  textStyle?: TextStyle;
}

export default function AnimatedBadge({
  visible,
  label,
  mode = 'standard',
  delay: delayMs = 0,
  color = '#fff',
  bgColor = '#4F46E5',
  style,
  textStyle,
}: Props) {
  const scale = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      const delay = delayMs;
      const config = mode === 'celebration'
        ? { damping: 12, stiffness: 180, useNativeDriver: true }
        : { damping: 18, stiffness: 300, useNativeDriver: true };

      setTimeout(() => {
        Animated.parallel([
          Animated.spring(scale, { toValue: mode === 'celebration' ? 1.15 : 1, ...config }),
          Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
        ]).start(() => {
          if (mode === 'celebration') {
            Animated.spring(scale, { toValue: 1, damping: 18, stiffness: 300, useNativeDriver: true }).start();
          }
        });
      }, delay);
    } else {
      Animated.parallel([
        Animated.timing(scale, { toValue: 0, duration: 150, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0, duration: 150, useNativeDriver: true }),
      ]).start();
    }
  }, [visible]);

  if (!visible) return null;

  return (
    <Animated.View
      style={[
        {
          backgroundColor: bgColor,
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 20,
          alignSelf: 'center',
          transform: [{ scale }],
          opacity,
        },
        style,
      ]}>
      <Text style={[{ color, fontSize: 13, fontWeight: '700', textAlign: 'center' }, textStyle]}>
        {label}
      </Text>
    </Animated.View>
  );
}
