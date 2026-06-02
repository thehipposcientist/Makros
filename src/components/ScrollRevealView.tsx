import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  StyleProp,
  View,
  ViewStyle,
} from 'react-native';
import { TIMING_STANDARD, useReducedMotion } from '../utils/motion';

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

export function useScrollReveal(onScrollListener?: (event: ScrollEvent) => void) {
  const scrollY = useRef(new Animated.Value(0)).current;
  const [viewportHeight, setViewportHeight] = useState(0);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = event.nativeEvent.layout.height;
    setViewportHeight(prev => (Math.abs(prev - nextHeight) > 1 ? nextHeight : prev));
  }, []);

  const onScroll = useMemo(
    () => Animated.event(
      [{ nativeEvent: { contentOffset: { y: scrollY } } }],
      { useNativeDriver: true, listener: onScrollListener },
    ),
    [onScrollListener, scrollY],
  );

  return { scrollY, viewportHeight, onLayout, onScroll };
}

interface ScrollRevealViewProps {
  children: React.ReactNode;
  scrollY?: Animated.Value;
  viewportHeight?: number;
  active?: boolean;
  disabled?: boolean;
  index?: number;
  revealDistance?: number;
  minOpacity?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export default function ScrollRevealView({
  children,
  scrollY,
  viewportHeight = 0,
  active,
  disabled = false,
  index = 0,
  revealDistance = 18,
  minOpacity = 0.14,
  style,
  testID,
}: ScrollRevealViewProps) {
  const reducedMotion = useReducedMotion();
  const [layoutY, setLayoutY] = useState<number | null>(null);
  const stagedOpacity = useRef(new Animated.Value(active == null ? 1 : 0)).current;
  const stagedTranslateY = useRef(new Animated.Value(active == null ? 0 : revealDistance)).current;

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const nextY = event.nativeEvent.layout.y;
    setLayoutY(prev => (prev == null || Math.abs(prev - nextY) > 1 ? nextY : prev));
  }, []);

  const canUseScrollLink = !!scrollY && viewportHeight > 0 && layoutY != null && !disabled && !reducedMotion;

  useEffect(() => {
    if (canUseScrollLink || active == null) return;
    const toValue = active && !disabled && !reducedMotion ? 1 : 0;
    if (reducedMotion || disabled) {
      stagedOpacity.setValue(1);
      stagedTranslateY.setValue(0);
      return;
    }
    Animated.parallel([
      Animated.timing(stagedOpacity, {
        toValue,
        duration: active ? TIMING_STANDARD.duration : 120,
        easing: TIMING_STANDARD.easing,
        useNativeDriver: true,
      }),
      Animated.timing(stagedTranslateY, {
        toValue: active ? 0 : revealDistance,
        duration: active ? TIMING_STANDARD.duration : 120,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [active, canUseScrollLink, disabled, reducedMotion, revealDistance, stagedOpacity, stagedTranslateY]);

  if (disabled || reducedMotion) {
    return (
      <View testID={testID} onLayout={onLayout} style={style}>
        {children}
      </View>
    );
  }

  if (canUseScrollLink && scrollY && layoutY != null) {
    const stagger = Math.min(index * 4, 40);
    const start = layoutY - viewportHeight * 0.96 + stagger;
    const end = layoutY - viewportHeight * 0.68 + stagger;
    const safeEnd = end <= start ? start + 1 : end;
    const opacity = scrollY.interpolate({
      inputRange: [start, safeEnd],
      outputRange: [minOpacity, 1],
      extrapolate: 'clamp',
    });
    const translateY = scrollY.interpolate({
      inputRange: [start, safeEnd],
      outputRange: [revealDistance, 0],
      extrapolate: 'clamp',
    });
    const scale = scrollY.interpolate({
      inputRange: [start, safeEnd],
      outputRange: [0.985, 1],
      extrapolate: 'clamp',
    });
    return (
      <Animated.View testID={testID} onLayout={onLayout} style={[style, { opacity, transform: [{ translateY }, { scale }] }]}>
        {children}
      </Animated.View>
    );
  }

  if (active != null) {
    return (
      <Animated.View testID={testID} onLayout={onLayout} style={[style, { opacity: stagedOpacity, transform: [{ translateY: stagedTranslateY }] }]}>
        {children}
      </Animated.View>
    );
  }

  return (
    <View testID={testID} onLayout={onLayout} style={style}>
      {children}
    </View>
  );
}
