import { useEffect, useRef } from 'react';
import { View, Image, Animated, Easing, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Defs, G, LinearGradient as SvgLinearGradient, Path, Stop } from 'react-native-svg';

const MARK_SIZE = 96;
const LOGO_W = 276;
const LOGO_H = 92;

export function SplashLoadingScreen() {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const backgroundAnim = useRef(new Animated.Value(0)).current;
  const heartbeatAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }).start();

    const background = Animated.loop(
      Animated.sequence([
        Animated.timing(backgroundAnim, {
          toValue: 1, duration: 6500, useNativeDriver: true,
          easing: Easing.inOut(Easing.quad),
        }),
        Animated.timing(backgroundAnim, {
          toValue: 0, duration: 6500, useNativeDriver: true,
          easing: Easing.inOut(Easing.quad),
        }),
      ]),
    );
    background.start();

    const heartbeat = Animated.loop(
      Animated.sequence([
        Animated.timing(heartbeatAnim, {
          toValue: 1, duration: 1800, useNativeDriver: false,
          easing: Easing.inOut(Easing.cubic),
        }),
        Animated.timing(heartbeatAnim, { toValue: 0, duration: 0, useNativeDriver: false }),
        Animated.delay(520),
      ]),
    );
    heartbeat.start();

    return () => { background.stop(); heartbeat.stop(); };
  }, []);

  const backgroundScale = backgroundAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1.03, 1.08],
  });
  const backgroundOpacity = fadeAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.64],
  });
  const ambientTopOpacity = backgroundAnim.interpolate({
    inputRange: [0, 0.45, 1],
    outputRange: [0.1, 0.26, 0.14],
  });
  const ambientBottomOpacity = backgroundAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.08, 0.16, 0.24],
  });
  const ambientTopTranslateY = backgroundAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [-28, 26],
  });
  const ambientBottomTranslateY = backgroundAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [32, -18],
  });
  const ambientTranslateX = backgroundAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [-18, 22],
  });
  const ambientScale = backgroundAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.06],
  });
  const heartbeatWidth = heartbeatAnim.interpolate({
    inputRange: [0, 0.16, 0.76, 1],
    outputRange: [0, 0, MARK_SIZE, MARK_SIZE],
  });
  const heartbeatOpacity = heartbeatAnim.interpolate({
    inputRange: [0, 0.12, 0.2, 0.78, 1],
    outputRange: [0, 0, 1, 0.9, 0],
  });
  const markScale = heartbeatAnim.interpolate({
    inputRange: [0, 0.18, 0.26, 0.34, 0.48, 1],
    outputRange: [1, 1, 1.035, 0.995, 1.018, 1],
  });

  return (
    <View style={styles.root}>
      <Animated.Image
        source={require('../../assets/images/card-backgrounds/workout-card-generic-gym-day-neutral.jpg')}
        style={[
          StyleSheet.absoluteFillObject,
          styles.backgroundImage,
          { opacity: backgroundOpacity, transform: [{ scale: backgroundScale }] },
        ]}
        resizeMode="cover"
      />
      <LinearGradient
        colors={[
          'rgba(4,10,12,0.96)',
          'rgba(6,16,15,0.90)',
          'rgba(6,16,15,0.98)',
        ]}
        locations={[0, 0.48, 1]}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={['rgba(64,232,160,0.22)', 'rgba(18,207,192,0.13)', 'rgba(160,112,232,0.08)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />

      <Animated.View
        pointerEvents="none"
        style={[
          styles.ambientWashTop,
          {
            opacity: ambientTopOpacity,
            transform: [
              { translateX: ambientTranslateX },
              { translateY: ambientTopTranslateY },
              { rotate: '-10deg' },
              { scale: ambientScale },
            ],
          },
        ]}>
        <LinearGradient
          colors={['rgba(64,232,160,0)', 'rgba(64,232,160,0.44)', 'rgba(96,184,240,0.26)', 'rgba(64,232,160,0)']}
          locations={[0, 0.36, 0.7, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.ambientWashBottom,
          {
            opacity: ambientBottomOpacity,
            transform: [
              { translateX: ambientTranslateX },
              { translateY: ambientBottomTranslateY },
              { rotate: '14deg' },
              { scale: ambientScale },
            ],
          },
        ]}>
        <LinearGradient
          colors={['rgba(96,184,240,0)', 'rgba(96,184,240,0.30)', 'rgba(160,112,232,0.34)', 'rgba(96,184,240,0)']}
          locations={[0, 0.28, 0.64, 1]}
          start={{ x: 1, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>

      <Animated.View style={[styles.logoWrap, { opacity: fadeAnim }]}>
        <Animated.View style={[styles.markStage, { transform: [{ scale: markScale }] }]}>
          <Animated.View pointerEvents="none" style={[styles.heartbeatClip, { width: heartbeatWidth, opacity: heartbeatOpacity }]}>
            <Svg width={MARK_SIZE} height={MARK_SIZE} viewBox="0 0 96 96" style={styles.heartbeatSvg}>
              <Defs>
                <SvgLinearGradient id="heartbeatGlow" x1="0" y1="0" x2="1" y2="0">
                  <Stop offset="0" stopColor="#40E8A0" stopOpacity="0" />
                  <Stop offset="0.18" stopColor="#40E8A0" stopOpacity="0.88" />
                  <Stop offset="0.58" stopColor="#F8FFF8" stopOpacity="1" />
                  <Stop offset="1" stopColor="#60B8F0" stopOpacity="0.78" />
                </SvgLinearGradient>
              </Defs>
              <G>
                <Path
                  d="M7 51 H22 L27 43 L34 64 L43 35 L51 58 L58 46 L64 51 H89"
                  fill="none"
                  stroke="rgba(64,232,160,0.18)"
                  strokeWidth="9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <Path
                  d="M7 51 H22 L27 43 L34 64 L43 35 L51 58 L58 46 L64 51 H89"
                  fill="none"
                  stroke="url(#heartbeatGlow)"
                  strokeWidth="3.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </G>
            </Svg>
          </Animated.View>
        </Animated.View>
        <Image
          source={require('../../assets/images/thallo-logo-white-transparent-New.png')}
          style={styles.logo}
          resizeMode="contain"
        />
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
  backgroundImage: {
    width: '100%',
    height: '100%',
  },
  ambientWashTop: {
    position: 'absolute',
    top: '6%',
    left: -80,
    right: -80,
    height: '46%',
  },
  ambientWashBottom: {
    position: 'absolute',
    left: -90,
    right: -90,
    bottom: '2%',
    height: '44%',
  },
  logoWrap: {
    width: LOGO_W,
    minHeight: MARK_SIZE + LOGO_H + 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  markStage: {
    width: MARK_SIZE,
    height: MARK_SIZE,
    marginBottom: 12,
    position: 'relative',
    overflow: 'hidden',
  },
  heartbeatClip: {
    position: 'absolute',
    left: 0,
    top: 0,
    height: MARK_SIZE,
    overflow: 'hidden',
  },
  heartbeatSvg: {
    width: MARK_SIZE,
    height: MARK_SIZE,
  },
  logo: {
    width: LOGO_W,
    height: LOGO_H,
  },
});

export default SplashLoadingScreen;
