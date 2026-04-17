/**
 * AnimatedTabIndicator — animated underline/pill that slides between tabs.
 * Wraps existing tab buttons and adds a shared animated indicator.
 */
import React, { useEffect, useRef } from 'react';
import { View, Animated, ViewStyle, LayoutChangeEvent } from 'react-native';

interface Props {
  activeIndex: number;
  tabCount: number;
  indicatorColor?: string;
  indicatorHeight?: number;
  style?: ViewStyle;
  children: React.ReactNode;
}

export default function AnimatedTabIndicator({
  activeIndex,
  tabCount,
  indicatorColor = '#4F46E5',
  indicatorHeight = 3,
  style,
  children,
}: Props) {
  const translateX = useRef(new Animated.Value(0)).current;
  const containerWidth = useRef(0);

  useEffect(() => {
    if (containerWidth.current > 0 && tabCount > 0) {
      const tabWidth = containerWidth.current / tabCount;
      Animated.spring(translateX, {
        toValue: activeIndex * tabWidth,
        damping: 18,
        stiffness: 250,
        mass: 0.8,
        useNativeDriver: true,
      }).start();
    }
  }, [activeIndex, tabCount]);

  const handleLayout = (e: LayoutChangeEvent) => {
    containerWidth.current = e.nativeEvent.layout.width;
    const tabWidth = e.nativeEvent.layout.width / tabCount;
    translateX.setValue(activeIndex * tabWidth);
  };

  return (
    <View style={style} onLayout={handleLayout}>
      {children}
      <Animated.View
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          height: indicatorHeight,
          width: containerWidth.current > 0 ? containerWidth.current / tabCount : 0,
          backgroundColor: indicatorColor,
          borderRadius: indicatorHeight / 2,
          transform: [{ translateX }],
        }}
      />
    </View>
  );
}
