/**
 * AnimatedProgressRing — circular progress indicator.
 * Uses basic Animated API for Expo Go compatibility.
 * Falls back to a simple View if react-native-svg isn't available.
 */
import { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';

interface Props {
  progress: number;
  size?: number;
  strokeWidth?: number;
  color?: string;
  bgColor?: string;
  children?: React.ReactNode;
}

export default function AnimatedProgressRing({
  progress,
  size = 80,
  color = '#4F46E5',
  bgColor = '#1F2937',
  children,
}: Props) {
  const animWidth = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(animWidth, {
      toValue: Math.max(0, Math.min(1, progress)),
      duration: 400,
      useNativeDriver: false,
    }).start();
  }, [progress]);

  const barWidth = animWidth.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      <View style={[styles.track, { borderColor: bgColor, width: size, height: size, borderRadius: size / 2 }]}>
        <Animated.View style={[styles.fill, { backgroundColor: color, width: barWidth, height: '100%', borderRadius: size / 2 }]} />
      </View>
      {children && <View style={styles.center}>{children}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { position: 'relative', alignItems: 'center', justifyContent: 'center' },
  track: { position: 'absolute', borderWidth: 3, overflow: 'hidden' },
  fill: { position: 'absolute', left: 0, top: 0 },
  center: { alignItems: 'center', justifyContent: 'center' },
});
