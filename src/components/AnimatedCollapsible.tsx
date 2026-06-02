import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleProp, ViewStyle } from 'react-native';
import { TIMING_STANDARD, useReducedMotion } from '../utils/motion';

interface Props {
  visible: boolean;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Duration in ms. Default 320 */
  duration?: number;
  /** How far content tucks upward while collapsing. Default 16 */
  slideDistance?: number;
}

export default function AnimatedCollapsible({
  visible,
  children,
  style,
  duration = 320,
  slideDistance = 16,
}: Props) {
  const reducedMotion = useReducedMotion();
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const translateY = useRef(new Animated.Value(visible ? 0 : -slideDistance)).current;
  const scale = useRef(new Animated.Value(visible ? 1 : 0.94)).current;

  useEffect(() => {
    if (!visible || reducedMotion) {
      return;
    }

    opacity.setValue(0);
    translateY.setValue(-slideDistance);
    scale.setValue(0.94);

    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: Math.max(200, Math.round(duration * 0.78)),
        easing: TIMING_STANDARD.easing,
        useNativeDriver: true,
      }),
      Animated.spring(translateY, {
        toValue: 0,
        friction: 7,
        tension: 90,
        useNativeDriver: true,
      }),
      Animated.spring(scale, {
        toValue: 1,
        friction: 6.5,
        tension: 130,
        useNativeDriver: true,
      }),
    ]).start();
  }, [duration, opacity, reducedMotion, scale, slideDistance, translateY, visible]);

  if (!visible) return null;

  if (reducedMotion) return <>{children}</>;

  return (
    <Animated.View
      style={[
        style,
        {
          opacity,
          transform: [{ translateY }, { scale }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}
