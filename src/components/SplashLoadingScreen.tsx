import { useEffect, useRef } from 'react';
import { Animated, Easing, Image, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import BrandMark from './BrandMark';

const WORDMARK = require('../../assets/images/thallo-logo-white-transparent-New.png');
const HERO_IMAGE = require('../../assets/images/card-backgrounds/workout-card-generic-gym-day-neutral.jpg');
const AnimatedLinearGradient = Animated.createAnimatedComponent(LinearGradient);

export function SplashLoadingScreen() {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const breatheAnim = useRef(new Animated.Value(0)).current;
  const gradientAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 520,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();

    const breathe = Animated.loop(
      Animated.sequence([
        Animated.timing(breatheAnim, {
          toValue: 1,
          duration: 2600,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(breatheAnim, {
          toValue: 0,
          duration: 2600,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
    );
    const gradient = Animated.loop(
      Animated.sequence([
        Animated.timing(gradientAnim, {
          toValue: 1,
          duration: 6200,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(gradientAnim, {
          toValue: 0,
          duration: 6200,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
    );

    breathe.start();
    gradient.start();

    return () => {
      breathe.stop();
      gradient.stop();
    };
  }, [breatheAnim, fadeAnim, gradientAnim]);

  const imageScale = breatheAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1.03, 1.08],
  });
  const haloScale = breatheAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.92, 1.16],
  });
  const haloOpacity = breatheAnim.interpolate({
    inputRange: [0, 0.52, 1],
    outputRange: [0.18, 0.34, 0.16],
  });
  const gradientTranslateX = gradientAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [-34, 34],
  });
  const gradientTranslateY = gradientAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [26, -24],
  });
  const gradientOpacity = gradientAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.2, 0.36, 0.22],
  });
  return (
    <View style={styles.root}>
      <Animated.Image
        source={HERO_IMAGE}
        resizeMode="cover"
        style={[
          StyleSheet.absoluteFillObject,
          styles.heroImage,
          { transform: [{ scale: imageScale }] },
        ]}
      />
      <LinearGradient
        colors={[
          'rgba(4,10,12,0.98)',
          'rgba(6,16,15,0.92)',
          'rgba(4,10,12,0.99)',
        ]}
        locations={[0, 0.48, 1]}
        style={StyleSheet.absoluteFill}
      />
      <AnimatedLinearGradient
        pointerEvents="none"
        colors={[
          'rgba(78,241,210,0.32)',
          'rgba(92,141,120,0.06)',
          'rgba(169,230,136,0.18)',
        ]}
        locations={[0, 0.54, 1]}
        start={{ x: 0.02, y: 0.08 }}
        end={{ x: 0.98, y: 0.92 }}
        style={[
          styles.movingGradient,
          {
            opacity: gradientOpacity,
            transform: [
              { translateX: gradientTranslateX },
              { translateY: gradientTranslateY },
              { scale: 1.16 },
            ],
          },
        ]}
      />
      <View pointerEvents="none" style={styles.gridOverlay}>
        {Array.from({ length: 7 }).map((_, index) => (
          <View key={`h-${index}`} style={[styles.gridLineH, { top: `${14 + index * 11}%` }]} />
        ))}
        {Array.from({ length: 5 }).map((_, index) => (
          <View key={`v-${index}`} style={[styles.gridLineV, { left: `${16 + index * 17}%` }]} />
        ))}
      </View>

      <Animated.View style={[styles.content, { opacity: fadeAnim }]}>
        <View style={styles.markStage}>
          <Animated.View
            pointerEvents="none"
            style={[
              styles.markHalo,
              {
                opacity: haloOpacity,
                transform: [{ scale: haloScale }],
              },
            ]}
          />
          <BrandMark size={116} variant="tile" animated />
        </View>

        <Image source={WORDMARK} resizeMode="contain" style={styles.wordmark} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#06100F',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  heroImage: {
    width: '100%',
    height: '100%',
    opacity: 0.42,
  },
  movingGradient: {
    position: 'absolute',
    top: '-12%',
    right: '-18%',
    bottom: '-12%',
    left: '-18%',
  },
  gridOverlay: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.28,
  },
  gridLineH: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: 'rgba(248,255,248,0.055)',
  },
  gridLineV: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: 'rgba(248,255,248,0.04)',
  },
  content: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  markStage: {
    width: 148,
    height: 148,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  markHalo: {
    position: 'absolute',
    width: 138,
    height: 138,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(78,241,210,0.7)',
    backgroundColor: 'rgba(78,241,210,0.08)',
  },
  wordmark: {
    width: 252,
    height: 84,
    marginTop: 2,
  },
});

export default SplashLoadingScreen;
