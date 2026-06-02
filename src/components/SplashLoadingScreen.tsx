import { useEffect, useRef } from 'react';
import { View, Image, Text, Animated, Easing, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

const PLAN_DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const PLAN_LANES = [
  { width: '76%', color: '#40E8A0' },
  { width: '62%', color: '#60B8F0' },
  { width: '48%', color: '#A070E8' },
] as const;

const LOGO_W = 260;
const LOGO_H = 100;

export function SplashLoadingScreen() {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const planAnim = useRef(new Animated.Value(0)).current;
  const backgroundAnim = useRef(new Animated.Value(0)).current;

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

    const plan = Animated.loop(
      Animated.sequence([
        Animated.timing(planAnim, {
          toValue: 1, duration: 3600, useNativeDriver: true,
          easing: Easing.inOut(Easing.cubic),
        }),
        Animated.delay(450),
        Animated.timing(planAnim, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    plan.start();

    return () => { background.stop(); plan.stop(); };
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
          'rgba(4,8,14,0.96)',
          'rgba(12,20,32,0.88)',
          'rgba(6,11,20,0.98)',
        ]}
        locations={[0, 0.48, 1]}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={['rgba(64,232,160,0.18)', 'rgba(96,184,240,0.10)', 'rgba(160,112,232,0.22)']}
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
        <Image
          source={require('../../assets/images/thallo-logo-white-transparent-New.png')}
          style={styles.logo}
          resizeMode="contain"
        />
      </Animated.View>

      <Animated.View style={[styles.planBuilder, { opacity: fadeAnim }]}>
        <View style={styles.weekRow}>
          {PLAN_DAYS.map((day, index) => {
            const peak = (index + 1) / 8;
            const before = peak - 0.11;
            const after = peak + 0.11;
            const dayOpacity = planAnim.interpolate({
              inputRange: [before, peak, after],
              outputRange: [0.44, 1, 0.44],
              extrapolate: 'clamp',
            });
            const dayScale = planAnim.interpolate({
              inputRange: [before, peak, after],
              outputRange: [0.96, 1.07, 0.96],
              extrapolate: 'clamp',
            });

            return (
              <Animated.View
                key={`${day}-${index}`}
                style={[styles.dayCell, { opacity: dayOpacity, transform: [{ scale: dayScale }] }]}>
                <Animated.View style={[styles.dayActiveLayer, { opacity: dayOpacity }]} />
                <Text style={styles.dayLabel}>{day}</Text>
                <View style={styles.dayLine} />
              </Animated.View>
            );
          })}
        </View>

        <View style={styles.laneStack}>
          {PLAN_LANES.map((lane, index) => {
            const peak = 0.24 + index * 0.22;
            const laneOpacity = planAnim.interpolate({
              inputRange: [peak - 0.12, peak, peak + 0.16],
              outputRange: [0.42, 1, 0.58],
              extrapolate: 'clamp',
            });

            return (
              <View key={index} style={styles.laneRow}>
                <View style={styles.laneTrack}>
                  <Animated.View style={[styles.laneFill, { width: lane.width, opacity: laneOpacity, backgroundColor: lane.color }]} />
                </View>
              </View>
            );
          })}
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#060B14',
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
    height: LOGO_H,
    marginBottom: 12,
  },
  logo: {
    width: LOGO_W,
    height: LOGO_H,
  },
  planBuilder: {
    width: '100%',
    maxWidth: 330,
    padding: 16,
    marginTop: 24,
    marginBottom: 20,
  },
  weekRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 6,
    marginBottom: 16,
  },
  dayCell: {
    flex: 1,
    maxWidth: 34,
    minWidth: 0,
    height: 42,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(128,248,200,0.22)',
    backgroundColor: 'rgba(20,32,46,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  dayActiveLayer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(64,232,160,0.30)',
  },
  dayLabel: {
    color: '#E8F0F8',
    fontSize: 13,
    fontWeight: '800',
    zIndex: 1,
  },
  dayLine: {
    position: 'absolute',
    bottom: 6,
    width: 14,
    height: 2,
    borderRadius: 1,
    backgroundColor: 'rgba(128,248,200,0.88)',
  },
  laneStack: {
    gap: 9,
  },
  laneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  laneTrack: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(144,168,192,0.18)',
    overflow: 'hidden',
  },
  laneFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: '#40E8A0',
  },
});

export default SplashLoadingScreen;
