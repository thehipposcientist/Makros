import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleProp, ViewStyle } from 'react-native';
import { TIMING_STANDARD, useReducedMotion } from '../utils/motion';

interface Props {
  visible: boolean;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Duration in ms. Default 300 */
  duration?: number;
  /** How far content tucks upward while collapsing. Default 10 */
  slideDistance?: number;
}

export default function AnimatedCollapsible({
  visible,
  children,
  style,
  duration = 300,
  slideDistance = 10,
}: Props) {
  const reducedMotion = useReducedMotion();
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const translateY = useRef(new Animated.Value(visible ? 0 : -slideDistance)).current;

  useEffect(() => {
    if (!visible || reducedMotion) {
      return;
    }

    opacity.setValue(0);
    translateY.setValue(-slideDistance);

    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: Math.max(180, Math.round(duration * 0.75)),
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [duration, opacity, reducedMotion, slideDistance, translateY, visible]);

  if (!visible) return null;

  if (reducedMotion) return <>{children}</>;

  return (
    <Animated.View
      style={[
        style,
        {
          opacity,
          transform: [{ translateY }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}
