/**
 * PulseView — wraps children with a subtle repeating scale pulse.
 * Great for CTAs that should draw the eye (Start Workout, etc.).
 */
import React, { useEffect, useRef } from 'react';
import { Animated, ViewStyle } from 'react-native';

interface Props {
  children: React.ReactNode;
  intensity?: number;
  duration?: number;
  style?: ViewStyle;
  active?: boolean;
}

export default function PulseView({
  children,
  intensity = 0.03,
  duration = 1500,
  style,
  active = true,
}: Props) {
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!active) { scale.setValue(1); return; }
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 1 + intensity, duration: duration / 2, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1, duration: duration / 2, useNativeDriver: true }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [active]);

  return (
    <Animated.View style={[style, { transform: [{ scale }] }]}>
      {children}
    </Animated.View>
  );
}
