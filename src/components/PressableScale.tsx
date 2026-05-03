/**
 * PressableScale — button wrapper with spring press/release animation.
 * Replaces TouchableOpacity for key CTAs where physical feedback matters.
 */
import React, { useRef } from 'react';
import { ViewStyle, TouchableOpacity, Animated, StyleProp, TouchableOpacityProps } from 'react-native';
import { SPRING_SNAPPY, useReducedMotion } from '../utils/motion';

interface Props {
  children: React.ReactNode;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  scaleDown?: number;
  disabled?: boolean;
}

type PressableScaleProps = Props & Pick<
  TouchableOpacityProps,
  'accessibilityLabel' | 'accessibilityRole' | 'accessibilityState' | 'hitSlop' | 'testID'
>;

export default function PressableScale({
  children,
  onPress,
  style,
  scaleDown = 0.96,
  disabled = false,
  accessibilityLabel,
  accessibilityRole,
  accessibilityState,
  hitSlop,
  testID,
}: PressableScaleProps) {
  const reducedMotion = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const translateY = useRef(new Animated.Value(0)).current;

  const onPressIn = () => {
    if (reducedMotion) return;
    Animated.parallel([
      Animated.spring(scale, { toValue: scaleDown, useNativeDriver: true, ...SPRING_SNAPPY }),
      Animated.spring(translateY, { toValue: -1, useNativeDriver: true, ...SPRING_SNAPPY }),
    ]).start();
  };
  const onPressOut = () => {
    if (reducedMotion) return;
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, ...SPRING_SNAPPY }),
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true, ...SPRING_SNAPPY }),
    ]).start();
  };

  return (
    <TouchableOpacity
      activeOpacity={1}
      disabled={disabled}
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole}
      accessibilityState={accessibilityState}
      testID={testID}
      hitSlop={hitSlop}>
      <Animated.View testID={testID} style={[style, { transform: [{ scale }, { translateY }] }]}>
        {children}
      </Animated.View>
    </TouchableOpacity>
  );
}
