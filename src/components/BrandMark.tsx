import { useEffect, useRef } from 'react';
import { Animated, Easing, Image, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useReducedMotion } from '../utils/motion';

type BrandMarkVariant = 'plain' | 'tile';

type Props = {
  size?: number;
  variant?: BrandMarkVariant;
  animated?: boolean;
  style?: StyleProp<ViewStyle>;
};

const thalloIcon = require('../../assets/images/thallo-icon-mark.png');

export default function BrandMark({
  size = 64,
  variant = 'plain',
  animated = true,
  style,
}: Props) {
  const reducedMotion = useReducedMotion();
  const pulse = useRef(new Animated.Value(0)).current;
  const isTile = variant === 'tile';
  const tileRadius = size * 0.18;

  useEffect(() => {
    if (!animated || reducedMotion) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 2200,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
        Animated.delay(700),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [animated, pulse, reducedMotion]);

  const pulseScale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.92, 1.14],
  });
  const pulseOpacity = pulse.interpolate({
    inputRange: [0, 0.52, 1],
    outputRange: [0.24, 0.11, 0],
  });
  const iconScale = pulse.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [1, 1.018, 1],
  });

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="Thallo pulse mark"
      style={[{ width: size, height: size }, style]}
    >
      {animated ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.pulseRing,
            {
              borderRadius: isTile ? tileRadius : size * 0.16,
              opacity: pulseOpacity,
              transform: [{ scale: pulseScale }],
            },
          ]}
        />
      ) : null}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          isTile && { borderRadius: tileRadius, overflow: 'hidden' },
          { transform: [{ scale: animated ? iconScale : 1 }] },
        ]}
      >
        <Image source={thalloIcon} resizeMode="cover" style={styles.icon} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  icon: {
    width: '100%',
    height: '100%',
  },
  pulseRing: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 1,
    borderColor: 'rgba(78,241,210,0.72)',
  },
});
