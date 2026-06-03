import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useReducedMotion } from '../utils/motion';

type Variant = 'check' | 'trophy';

type Props = {
  variant?: Variant;
  active?: boolean;
  size?: number;
  accentColor: string;
  surfaceColor?: string;
  iconColor?: string;
  style?: StyleProp<ViewStyle>;
};

const RAYS = Array.from({ length: 12 }, (_, i) => i * 30);

export default function CompletionBurst({
  variant = 'check',
  active = true,
  size = 108,
  accentColor,
  surfaceColor,
  iconColor = accentColor,
  style,
}: Props) {
  const reducedMotion = useReducedMotion();
  const draw = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;

  useEffect(() => {
    if (!active || reducedMotion) {
      draw.setValue(active ? 1 : 0);
      return;
    }
    draw.stopAnimation();
    draw.setValue(0);
    Animated.timing(draw, {
      toValue: 1,
      duration: variant === 'trophy' ? 760 : 640,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [active, draw, reducedMotion, variant]);

  const ringScale = draw.interpolate({
    inputRange: [0, 0.7, 1],
    outputRange: [0.64, 1.08, 1],
  });
  const ringOpacity = draw.interpolate({
    inputRange: [0, 0.36, 1],
    outputRange: [0, 0.7, 0],
  });
  const secondRingScale = draw.interpolate({
    inputRange: [0, 0.48, 1],
    outputRange: [0.5, 0.86, 1.18],
  });
  const secondRingOpacity = draw.interpolate({
    inputRange: [0, 0.55, 1],
    outputRange: [0, 0.5, 0],
  });
  const rayScale = draw.interpolate({
    inputRange: [0, 0.34, 0.76, 1],
    outputRange: [0.2, 1.04, 0.78, 0.62],
  });
  const rayOpacity = draw.interpolate({
    inputRange: [0, 0.18, 0.78, 1],
    outputRange: [0, 1, 0.64, 0],
  });
  const centerScale = draw.interpolate({
    inputRange: [0, 0.46, 0.72, 1],
    outputRange: [0.72, 1.12, 0.98, 1],
  });
  const iconScale = draw.interpolate({
    inputRange: [0, 0.5, 0.76, 1],
    outputRange: [0.54, 1.22, 0.94, 1],
  });
  const iconOpacity = draw.interpolate({
    inputRange: [0, 0.34, 1],
    outputRange: [0, 1, 1],
  });

  const iconName = variant === 'trophy' ? 'trophy' : 'checkmark-sharp';
  const centerSize = Math.round(size * 0.58);
  const rayHeight = Math.max(12, Math.round(size * 0.15));
  const rayWidth = Math.max(3, Math.round(size * 0.035));

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.root, { width: size, height: size }, style]}
    >
      <Animated.View
        style={[
          styles.ring,
          {
            width: size * 0.82,
            height: size * 0.82,
            borderRadius: size * 0.41,
            borderColor: accentColor,
            opacity: ringOpacity,
            transform: [{ scale: ringScale }],
          },
        ]}
      />
      <Animated.View
        style={[
          styles.ring,
          {
            width: size * 0.96,
            height: size * 0.96,
            borderRadius: size * 0.48,
            borderColor: accentColor,
            opacity: secondRingOpacity,
            transform: [{ scale: secondRingScale }],
          },
        ]}
      />

      {RAYS.map((angle) => (
        <Animated.View
          key={angle}
          style={[
            styles.rayShell,
            {
              width: size,
              height: size,
              opacity: rayOpacity,
              transform: [{ rotate: `${angle}deg` }, { scale: rayScale }],
            },
          ]}
        >
          <View
            style={[
              styles.ray,
              {
                top: 2,
                left: size / 2 - rayWidth / 2,
                width: rayWidth,
                height: rayHeight,
                borderRadius: rayWidth,
                backgroundColor: accentColor,
              },
            ]}
          />
        </Animated.View>
      ))}

      <Animated.View
        style={[
          styles.center,
          {
            width: centerSize,
            height: centerSize,
            borderRadius: centerSize / 2,
            backgroundColor: surfaceColor ?? `${accentColor}22`,
            borderColor: `${accentColor}66`,
            transform: [{ scale: centerScale }],
          },
        ]}
      >
        <Animated.View style={{ opacity: iconOpacity, transform: [{ scale: iconScale }] }}>
          <Ionicons name={iconName} size={Math.round(size * (variant === 'trophy' ? 0.36 : 0.4))} color={iconColor} />
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  ring: {
    position: 'absolute',
    borderWidth: 2,
  },
  rayShell: {
    position: 'absolute',
  },
  ray: {
    position: 'absolute',
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
});
