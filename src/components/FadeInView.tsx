/**
 * FadeInView — wraps children with a fade + slide-up animation on mount.
 * Use `delay` to stagger multiple items.
 *
 * Usage:
 *   <FadeInView delay={index * 50}>
 *     <YourCard />
 *   </FadeInView>
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleProp, ViewStyle } from 'react-native';
import { TIMING_STANDARD, useReducedMotion } from '../utils/motion';

interface Props {
  children: React.ReactNode;
  delay?: number;
  duration?: number;
  slideDistance?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export default function FadeInView({
  children,
  delay = 0,
  duration = 300,
  slideDistance = 12,
  style,
  testID,
}: Props) {
  const reducedMotion = useReducedMotion();
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(slideDistance)).current;
  const scale = useRef(new Animated.Value(0.985)).current;

  useEffect(() => {
    if (reducedMotion) {
      opacity.setValue(1);
      translateY.setValue(0);
      scale.setValue(1);
      return;
    }

    opacity.setValue(0);
    translateY.setValue(slideDistance);
    scale.setValue(0.985);

    const timer = setTimeout(() => {
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration,
          easing: TIMING_STANDARD.easing,
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: 0,
          duration,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 1,
          duration: Math.max(220, duration - 20),
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();
    }, delay);
    return () => clearTimeout(timer);
  }, [delay, duration, opacity, reducedMotion, scale, slideDistance, translateY]);

  return (
    <Animated.View testID={testID} style={[style, { opacity, transform: [{ translateY }, { scale }] }]}>
      {children}
    </Animated.View>
  );
}
