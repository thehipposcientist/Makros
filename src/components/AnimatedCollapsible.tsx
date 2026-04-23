import React from 'react';
import { ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

interface Props {
  visible: boolean;
  children: React.ReactNode;
  style?: ViewStyle;
  /** Duration in ms. Default 300 */
  duration?: number;
}

export default function AnimatedCollapsible({
  visible,
  children,
  style,
  duration = 300,
}: Props) {
  if (!visible) return null;

  return (
    <Animated.View
      entering={FadeIn.duration(duration)}
      exiting={FadeOut.duration(Math.round(duration * 0.6))}
      style={style}
    >
      {children}
    </Animated.View>
  );
}
