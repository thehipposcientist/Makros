import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useReducedMotion } from '../utils/motion';

type Props = {
  active?: boolean;
  width?: number;
  height?: number;
  cornerColor: string;
  beamColor?: string;
  gridColor?: string;
  surfaceColor?: string;
  style?: StyleProp<ViewStyle>;
};

function withFallbackAlpha(color: string, alphaHex: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}${alphaHex}` : color;
}

export default function ScanReticle({
  active = true,
  width = 260,
  height = 160,
  cornerColor,
  beamColor = cornerColor,
  gridColor = withFallbackAlpha(cornerColor, '30'),
  surfaceColor = 'transparent',
  style,
}: Props) {
  const reducedMotion = useReducedMotion();
  const sweep = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active || reducedMotion) {
      sweep.setValue(0.52);
      pulse.setValue(0.4);
      return;
    }

    sweep.setValue(0);
    pulse.setValue(0);
    const sweepLoop = Animated.loop(
      Animated.timing(sweep, {
        toValue: 1,
        duration: 1700,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }),
    );
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 900,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
    );

    sweepLoop.start();
    pulseLoop.start();
    return () => {
      sweepLoop.stop();
      pulseLoop.stop();
    };
  }, [active, pulse, reducedMotion, sweep]);

  const translateY = sweep.interpolate({
    inputRange: [0, 1],
    outputRange: [10, Math.max(10, height - 20)],
  });
  const beamOpacity = sweep.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.3, 0.95, 0.36],
  });
  const cornerScale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.035],
  });
  const cornerOpacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.78, 1],
  });
  const softBeam = withFallbackAlpha(beamColor, '00');
  const beamGlow = withFallbackAlpha(beamColor, '66');

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.root, { width, height, backgroundColor: surfaceColor }, style]}
    >
      <View style={[styles.gridLine, styles.gridLineHorizontal, { backgroundColor: gridColor }]} />
      <View style={[styles.gridLine, styles.gridLineVertical, { backgroundColor: gridColor }]} />
      <View style={[styles.gridLine, styles.gridLineHorizontalLow, { backgroundColor: gridColor }]} />
      <View style={[styles.gridLine, styles.gridLineVerticalRight, { backgroundColor: gridColor }]} />

      <Animated.View style={[styles.beam, { opacity: beamOpacity, transform: [{ translateY }] }]}>
        <LinearGradient
          colors={[softBeam, beamGlow, beamColor, beamGlow, softBeam] as const}
          locations={[0, 0.18, 0.5, 0.82, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>

      <Animated.View style={[styles.corner, styles.cornerTopLeft, { borderColor: cornerColor, opacity: cornerOpacity, transform: [{ scale: cornerScale }] }]} />
      <Animated.View style={[styles.corner, styles.cornerTopRight, { borderColor: cornerColor, opacity: cornerOpacity, transform: [{ scale: cornerScale }] }]} />
      <Animated.View style={[styles.corner, styles.cornerBottomLeft, { borderColor: cornerColor, opacity: cornerOpacity, transform: [{ scale: cornerScale }] }]} />
      <Animated.View style={[styles.corner, styles.cornerBottomRight, { borderColor: cornerColor, opacity: cornerOpacity, transform: [{ scale: cornerScale }] }]} />
    </View>
  );
}

const CORNER_SIZE = 28;
const CORNER_WIDTH = 3;

const styles = StyleSheet.create({
  root: {
    position: 'relative',
    borderRadius: 14,
    overflow: 'hidden',
  },
  gridLine: {
    position: 'absolute',
    opacity: 0.55,
  },
  gridLineHorizontal: {
    left: 18,
    right: 18,
    top: '35%',
    height: StyleSheet.hairlineWidth,
  },
  gridLineHorizontalLow: {
    left: 18,
    right: 18,
    top: '66%',
    height: StyleSheet.hairlineWidth,
  },
  gridLineVertical: {
    top: 16,
    bottom: 16,
    left: '35%',
    width: StyleSheet.hairlineWidth,
  },
  gridLineVerticalRight: {
    top: 16,
    bottom: 16,
    left: '66%',
    width: StyleSheet.hairlineWidth,
  },
  beam: {
    position: 'absolute',
    left: 12,
    right: 12,
    height: 18,
    borderRadius: 9,
  },
  corner: {
    position: 'absolute',
    width: CORNER_SIZE,
    height: CORNER_SIZE,
  },
  cornerTopLeft: {
    top: 0,
    left: 0,
    borderTopWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
    borderTopLeftRadius: 14,
  },
  cornerTopRight: {
    top: 0,
    right: 0,
    borderTopWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
    borderTopRightRadius: 14,
  },
  cornerBottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
    borderBottomLeftRadius: 14,
  },
  cornerBottomRight: {
    right: 0,
    bottom: 0,
    borderRightWidth: CORNER_WIDTH,
    borderBottomWidth: CORNER_WIDTH,
    borderBottomRightRadius: 14,
  },
});
