/**
 * PressableScale — button wrapper with spring press/release animation.
 * Replaces TouchableOpacity for key CTAs where physical feedback matters.
 */
import React, { useRef } from 'react';
import { ViewStyle, TouchableOpacity, Animated } from 'react-native';

interface Props {
  children: React.ReactNode;
  onPress: () => void;
  style?: ViewStyle | ViewStyle[] | any;
  scaleDown?: number;
  disabled?: boolean;
}

export default function PressableScale({
  children,
  onPress,
  style,
  scaleDown = 0.96,
  disabled = false,
}: Props) {
  const scale = useRef(new Animated.Value(1)).current;

  const onPressIn = () => {
    Animated.spring(scale, { toValue: scaleDown, useNativeDriver: true, damping: 18, stiffness: 300 }).start();
  };
  const onPressOut = () => {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, damping: 18, stiffness: 300 }).start();
  };

  return (
    <TouchableOpacity
      activeOpacity={1}
      disabled={disabled}
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}>
      <Animated.View style={[style, { transform: [{ scale }] }]}>
        {children}
      </Animated.View>
    </TouchableOpacity>
  );
}
