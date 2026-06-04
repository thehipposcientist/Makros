import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Image,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { colors, hitSlop, radius } from '../constants/theme';
import BrandMark from '../components/BrandMark';

const logo = require('../../assets/images/thallo-logo-compact-white.png');
const landingPhotos = [
  { key: 'pexels-achi-murusidze-strong-woman', label: 'Training', source: require('../../assets/images/landing-photos/pexels-achi-murusidze-2064615248-35649986.jpg') },
  { key: 'pexels-foadshariyati-training', label: 'Training', source: require('../../assets/images/landing-photos/pexels-foadshariyati-31849600.jpg') },
  { key: 'pexels-training-woman-lift', label: 'Training', source: require('../../assets/images/landing-photos/pexels-training-woman-lift.jpg') },
  { key: 'meal-chicken-rice', label: 'Nutrition', source: require('../../assets/images/landing-photos/meal-chicken-rice.jpg') },
  { key: 'pexels-hiking-forest-woman-close', label: 'Hiking', source: require('../../assets/images/landing-photos/pexels-hiking-forest-woman-close.jpg') },
  { key: 'pexels-sauna-couple', label: 'Sauna', source: require('../../assets/images/landing-photos/pexels-sauna-couple.jpg') },
  { key: 'pexels-zeal-creative-studios-training', label: 'Training', source: require('../../assets/images/landing-photos/pexels-zeal-creative-studios-58866141-34043597.jpg') },
  { key: 'meal-salmon', label: 'Nutrition', source: require('../../assets/images/landing-photos/meal-salmon.jpg') },
  { key: 'pexels-mykhailo-petrenko-training', label: 'Training', source: require('../../assets/images/landing-photos/pexels-mykhailo-petrenko-2152927294-32521594.jpg') },
  { key: 'pexels-hiking-forest-man', label: 'Hiking', source: require('../../assets/images/landing-photos/pexels-hiking-forest-man.jpg') },
  { key: 'pexels-aleksey-bystrov-training', label: 'Training', source: require('../../assets/images/landing-photos/pexels-aleksey-bystrov-276309422-14209250.jpg') },
  { key: 'swimming', label: 'Swimming', source: require('../../assets/images/landing-photos/swimming.jpg') },
  { key: 'meal-breakfast', label: 'Nutrition', source: require('../../assets/images/landing-photos/meal-breakfast.jpg') },
  { key: 'pexels-sauna-seated', label: 'Sauna', source: require('../../assets/images/landing-photos/pexels-sauna-seated.jpg') },
  { key: 'weightlifting', label: 'Training', source: require('../../assets/images/landing-photos/weightlifting.jpg') },
  { key: 'cycling', label: 'Cycling', source: require('../../assets/images/landing-photos/cycling.jpg') },
  { key: 'meal-burrito', label: 'Nutrition', source: require('../../assets/images/landing-photos/meal-burrito.jpg') },
  { key: 'pexels-training-man-gym', label: 'Training', source: require('../../assets/images/landing-photos/pexels-training-man-gym.jpg') },
  { key: 'pexels-elkady-training', label: 'Training', source: require('../../assets/images/landing-photos/pexels-elkady-14466951.jpg') },
  { key: 'weightlifting-free-weights-male', label: 'Training', source: require('../../assets/images/landing-photos/weightlifting-free-weights-male.jpg') },
  { key: 'meal-smoothie', label: 'Nutrition', source: require('../../assets/images/landing-photos/meal-smoothie.jpg') },
  { key: 'pexels-nickmayer-training', label: 'Training', source: require('../../assets/images/landing-photos/pexels-nickmayer-11713858.jpg') },
  { key: 'meal-salad', label: 'Nutrition', source: require('../../assets/images/landing-photos/meal-salad.jpg') },
  { key: 'weightlifting-squat-male', label: 'Training', source: require('../../assets/images/landing-photos/weightlifting-squat-male.jpg') },
  { key: 'meal-mediterranean', label: 'Nutrition', source: require('../../assets/images/landing-photos/meal-mediterranean.jpg') },
  { key: 'pexels-sauna-women', label: 'Sauna', source: require('../../assets/images/landing-photos/pexels-sauna-women.jpg') },
  { key: 'meal-steak', label: 'Nutrition', source: require('../../assets/images/landing-photos/meal-steak.jpg') },
  { key: 'meal-prep', label: 'Nutrition', source: require('../../assets/images/landing-photos/meal-prep.jpg') },
  { key: 'meal-plant-based', label: 'Nutrition', source: require('../../assets/images/landing-photos/meal-plant-based.jpg') },
] as const;

type LayerIndex = 0 | 1;
type LandingLayer = {
  photoIndex: number;
  motionSeed: number;
};

type LandingScreenProps = {
  onLogin: () => void;
  onSignup: () => void;
  onWhyThallo: () => void;
};

const valuePills = [
  { icon: 'barbell-outline', label: 'Training' },
  { icon: 'restaurant-outline', label: 'Meals' },
  { icon: 'pulse-outline', label: 'Recovery' },
] as const;

export default function LandingScreen({ onLogin, onSignup, onWhyThallo }: LandingScreenProps) {
  const { height, width } = useWindowDimensions();
  const compact = height < 720;
  const narrow = width < 380;
  const [layers, setLayers] = useState<[LandingLayer, LandingLayer]>([
    { photoIndex: 0, motionSeed: 0 },
    { photoIndex: 1, motionSeed: 1 },
  ]);
  const [activeLayer, setActiveLayer] = useState<LayerIndex>(0);
  const [topLayer, setTopLayer] = useState<LayerIndex>(0);
  const photoIndexRef = useRef(0);
  const activeLayerRef = useRef<LayerIndex>(0);
  const motionSeedRef = useRef(1);
  const transitionInFlightRef = useRef(false);
  const transitionFrameRef = useRef<number | null>(null);
  const layerOpacities = useRef([new Animated.Value(1), new Animated.Value(0)]).current;
  const layerMotions = useRef([new Animated.Value(0), new Animated.Value(0)]).current;
  const panX = Math.min(30, width * 0.052);
  const panY = Math.min(22, height * 0.032);

  useEffect(() => {
    landingPhotos.forEach(({ source }) => {
      const resolved = Image.resolveAssetSource(source);
      if (resolved?.uri) Image.prefetch(resolved.uri).catch(() => {});
    });
  }, []);

  useEffect(() => {
    let mounted = true;

    const animateLayerMotion = (layerIndex: LayerIndex) => {
      layerMotions[layerIndex].stopAnimation();
      layerMotions[layerIndex].setValue(0);
      Animated.timing(layerMotions[layerIndex], {
        toValue: 1,
        duration: 6800,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      }).start();
    };

    animateLayerMotion(activeLayerRef.current);

    const timer = setInterval(() => {
      if (transitionInFlightRef.current) return;
      transitionInFlightRef.current = true;
      const outgoingLayer = activeLayerRef.current;
      const incomingLayer: LayerIndex = outgoingLayer === 0 ? 1 : 0;
      const nextIndex = (photoIndexRef.current + 1) % landingPhotos.length;

      layerOpacities[incomingLayer].stopAnimation();
      layerOpacities[incomingLayer].setValue(0);
      motionSeedRef.current += 1;
      setLayers(prev => {
        const nextLayers: [LandingLayer, LandingLayer] = [...prev];
        nextLayers[incomingLayer] = {
          photoIndex: nextIndex,
          motionSeed: motionSeedRef.current,
        };
        return nextLayers;
      });
      setTopLayer(incomingLayer);

      transitionFrameRef.current = requestAnimationFrame(() => {
        transitionFrameRef.current = null;
        animateLayerMotion(incomingLayer);
        Animated.timing(layerOpacities[incomingLayer], {
          toValue: 1,
          duration: 1900,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }).start(({ finished }) => {
          if (!mounted) return;
          if (!finished) {
            transitionInFlightRef.current = false;
            return;
          }
          layerOpacities[outgoingLayer].stopAnimation();
          layerOpacities[outgoingLayer].setValue(0);
          layerMotions[outgoingLayer].stopAnimation();
          photoIndexRef.current = nextIndex;
          activeLayerRef.current = incomingLayer;
          setActiveLayer(incomingLayer);
          setTopLayer(incomingLayer);
          transitionInFlightRef.current = false;
        });
      });
    }, 5600);

    return () => {
      mounted = false;
      clearInterval(timer);
      if (transitionFrameRef.current != null) {
        cancelAnimationFrame(transitionFrameRef.current);
        transitionFrameRef.current = null;
      }
      layerOpacities.forEach(opacity => opacity.stopAnimation());
      layerMotions.forEach(motion => motion.stopAnimation());
      transitionInFlightRef.current = false;
    };
  }, [layerMotions, layerOpacities]);

  return (
    <View style={styles.root}>
      {layers.map((layer, layerIndex) => {
        const photo = landingPhotos[layer.photoIndex];
        const moveRight = layer.motionSeed % 2 === 0;
        const moveDown = layer.motionSeed % 3 === 0;
        const translateX = layerMotions[layerIndex].interpolate({
          inputRange: [0, 1],
          outputRange: moveRight ? [-panX, panX] : [panX, -panX],
        });
        const translateY = layerMotions[layerIndex].interpolate({
          inputRange: [0, 1],
          outputRange: moveDown ? [-panY, panY] : [panY, -panY],
        });
        const scale = layerMotions[layerIndex].interpolate({
          inputRange: [0, 1],
          outputRange: [1.045, 1.12],
        });

        return (
          <Animated.Image
            key={layerIndex}
            accessibilityIgnoresInvertColors
            accessibilityElementsHidden={layerIndex !== activeLayer}
            accessibilityLabel={`${photo.label} training and nutrition scene`}
            importantForAccessibility={layerIndex === activeLayer ? 'auto' : 'no-hide-descendants'}
            source={photo.source}
            style={[
              styles.heroImage,
              {
                opacity: layerOpacities[layerIndex],
                zIndex: layerIndex === topLayer ? 2 : 1,
                transform: [{ scale }, { translateX }, { translateY }],
              },
            ]}
            resizeMode="cover"
          />
        );
      })}
      <LinearGradient
        colors={[
          'rgba(13,15,20,0.08)',
          'rgba(13,15,20,0.36)',
          'rgba(13,15,20,0.82)',
          colors.background,
        ]}
        locations={[0, 0.36, 0.72, 1]}
        style={styles.overlay}
      >
        <SafeAreaView style={styles.safe}>
          <View style={styles.topBar}>
            <View style={styles.topBrand}>
              <BrandMark size={34} variant="tile" animated={false} style={styles.topBrandMark} />
              <Image source={logo} style={styles.logo} resizeMode="contain" />
            </View>
            <TouchableOpacity
              testID="landing-login-top"
              activeOpacity={0.78}
              style={styles.topLoginButton}
              onPress={onLogin}
            >
              <Text style={styles.topLoginText}>Sign in</Text>
            </TouchableOpacity>
          </View>

          <View style={[styles.heroBlock, compact && styles.heroBlockCompact]}>
            <Text style={styles.kicker}>Total health</Text>
            <Text
              style={[styles.title, narrow && styles.titleNarrow]}
              numberOfLines={3}
              adjustsFontSizeToFit
              minimumFontScale={0.86}
            >
              Training, nutrition, and recovery built around your real week.
            </Text>
            <Text style={styles.subtitle}>
              Get a plan that respects your schedule, equipment, food preferences, health signals, and recovery.
            </Text>
            <View style={styles.pillRow}>
              {valuePills.map(({ icon, label }) => (
                <View key={label} style={styles.valuePill}>
                  <Ionicons name={icon} size={14} color={colors.primaryLight} />
                  <Text style={styles.valuePillText}>{label}</Text>
                </View>
              ))}
            </View>
          </View>

          <View style={styles.actionBlock}>
            <TouchableOpacity
              testID="landing-signup"
              activeOpacity={0.82}
              style={styles.primaryButton}
              onPress={onSignup}
            >
              <Text style={styles.primaryButtonText}>Create account</Text>
              <Ionicons name="arrow-forward" size={18} color={colors.background} />
            </TouchableOpacity>
            <TouchableOpacity
              testID="landing-login"
              activeOpacity={0.78}
              style={styles.secondaryButton}
              onPress={onLogin}
            >
              <Text style={styles.secondaryButtonText}>I already have an account</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="landing-why-thallo"
              activeOpacity={0.78}
              style={styles.whyButton}
              hitSlop={hitSlop.chip}
              onPress={onWhyThallo}
            >
              <Text style={styles.whyButtonText}>Why Thallo?</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.primaryLight} />
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </LinearGradient>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
    overflow: 'hidden',
  },
  heroImage: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  overlay: {
    flex: 1,
    zIndex: 3,
  },
  safe: {
    flex: 1,
    paddingHorizontal: 24,
    paddingBottom: Platform.OS === 'android' ? 18 : 8,
  },
  topBar: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  topBrand: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  topBrandMark: {
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
  },
  logo: {
    width: 142,
    height: 34,
  },
  topLoginButton: {
    minHeight: 40,
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.26)',
    backgroundColor: 'rgba(13,15,20,0.34)',
    paddingHorizontal: 15,
  },
  topLoginText: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '800',
  },
  heroBlock: {
    flex: 1,
    justifyContent: 'flex-end',
    alignSelf: 'center',
    width: '100%',
    maxWidth: 540,
    paddingBottom: 28,
  },
  heroBlockCompact: {
    paddingBottom: 16,
  },
  kicker: {
    color: colors.primaryLight,
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 0,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 42,
    lineHeight: 47,
    fontWeight: '900',
    letterSpacing: 0,
  },
  titleNarrow: {
    fontSize: 38,
    lineHeight: 43,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 16,
    lineHeight: 23,
    fontWeight: '600',
    marginTop: 14,
    maxWidth: 470,
  },
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 18,
  },
  valuePill: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(13,15,20,0.42)',
    paddingHorizontal: 12,
  },
  valuePillText: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '800',
  },
  actionBlock: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 540,
    gap: 10,
    paddingBottom: 14,
  },
  primaryButton: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    paddingHorizontal: 18,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 7 },
    shadowOpacity: 0.28,
    shadowRadius: 14,
    elevation: 6,
  },
  primaryButtonText: {
    color: colors.background,
    fontSize: 17,
    fontWeight: '900',
  },
  secondaryButton: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(13,15,20,0.56)',
    paddingHorizontal: 16,
  },
  secondaryButtonText: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '800',
  },
  whyButton: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 12,
  },
  whyButtonText: {
    color: colors.primaryLight,
    fontSize: 13,
    fontWeight: '900',
  },
});
