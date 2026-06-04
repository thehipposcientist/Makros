import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import {
  Animated,
  Image,
  ImageBackground,
  ImageSourcePropType,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  ScrollView,
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
import DeviceSyncMockup from '../components/DeviceSyncMockup';
import BrandMark from '../components/BrandMark';

const logo = require('../../assets/images/thallo-logo-compact-white.png');

type IconName = ComponentProps<typeof Ionicons>['name'];
type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

type WhyThalloFeature = {
  icon: IconName;
  title: string;
  body: string;
};

type WhyThalloStep = {
  key: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  image: ImageSourcePropType;
  imageLabel: string;
  deviceShowcase?: boolean;
  accent: string;
  features: WhyThalloFeature[];
  proof: string;
};

type WhyThalloScreenProps = {
  onBack: () => void;
  onLogin: () => void;
  onSignup: () => void;
};

const phoneWatchStep: WhyThalloStep = {
  key: 'phone-watch',
  eyebrow: 'iPhone + Apple Watch',
  title: 'Run the day from your phone or wrist.',
  subtitle: 'Thallo is phone-first, with a compatible Apple Watch companion for active workouts, rest timers, quick logs, and at-a-glance health context.',
  image: require('../../assets/images/landing-photos/pexels-training-man-gym.jpg'),
  imageLabel: 'Phone and watch companion scene',
  deviceShowcase: true,
  accent: '#38D8F0',
  features: [
    { icon: 'phone-portrait-outline', title: 'Phone command center', body: 'Plan, edit, review, and customize with the full Today, Workout, Meals, and Progress surfaces.' },
    { icon: 'watch-outline', title: 'Wrist companion', body: 'Mirror workouts, rest timers, meals, hydration, sleep, readiness, and quick actions when paired.' },
  ],
  proof: 'The database and phone dashboard stay authoritative; the Watch is a fast companion, not a separate plan.',
};

const whyThalloSteps: WhyThalloStep[] = [
  {
    key: 'whole-health',
    eyebrow: 'Complete Health App',
    title: 'Strength, cardio, nutrition, and health in one place.',
    subtitle: 'Thallo brings lifting, conditioning, meals, supplements, body metrics, recovery, and progress into one daily system.',
    image: require('../../assets/images/landing-photos/weightlifting-free-weights-male.jpg'),
    imageLabel: 'Strength training scene',
    accent: '#15C7B8',
    features: [
      { icon: 'barbell-outline', title: 'Train everything', body: 'Plan strength work, log cardio, track custom activities, and keep recovery visible.' },
      { icon: 'restaurant-outline', title: 'Fuel the goal', body: 'Use meal guidance, manual logs, favorites, hydration, supplements, and weight trends together.' },
    ],
    proof: 'Use the full system, or keep only the workout or nutrition surfaces you want.',
  },
  {
    key: 'choose-your-system',
    eyebrow: 'Fully Customizable',
    title: 'Follow the guided plan or bring your own.',
    subtitle: 'Start with a guided week, log your own program, or blend both when real life changes the schedule.',
    image: require('../../assets/images/landing-photos/meal-mediterranean.jpg'),
    imageLabel: 'Mediterranean meal scene',
    accent: '#F59E0B',
    features: [
      { icon: 'calendar-outline', title: 'Guided when useful', body: 'Generated PlanWeeks respect your goal, equipment, schedule, injuries, and recovery.' },
      { icon: 'options-outline', title: 'Manual when needed', body: 'Start custom sessions, switch days, swap exercises, or focus on nutrition only.' },
    ],
    proof: 'Setup asks what you want first: workouts, nutrition, or the whole app.',
  },
  ...(Platform.OS === 'ios' ? [phoneWatchStep] : []),
  {
    key: 'templates-sharing',
    eyebrow: 'Templates And Sharing',
    title: 'Build once, reuse it, share it.',
    subtitle: 'Turn repeat workouts into templates, import workouts from photos or codes, and share single templates or bundles with friends.',
    image: require('../../assets/images/landing-photos/pexels-hiking-forest-woman-close.jpg'),
    imageLabel: 'Outdoor recovery scene',
    accent: '#8B5CF6',
    features: [
      { icon: 'bookmark-outline', title: 'Reusable routines', body: 'Save favorite workouts, meals, and routines so repeated days take seconds.' },
      { icon: 'shield-checkmark-outline', title: 'Private by design', body: 'Share training activity and templates while calories, macros, and weight stay private.' },
    ],
    proof: 'The guided plan is a starting point, not a cage.',
  },
];

const clampStepIndex = (index: number) => Math.min(whyThalloSteps.length - 1, Math.max(0, index));

function WhyThalloSlide({
  step,
  index,
  scrollX,
  pageWidth,
  compact,
  narrow,
}: {
  step: WhyThalloStep;
  index: number;
  scrollX: Animated.Value;
  pageWidth: number;
  compact: boolean;
  narrow: boolean;
}) {
  const inputRange = [
    (index - 1) * pageWidth,
    index * pageWidth,
    (index + 1) * pageWidth,
  ];
  const opacity = scrollX.interpolate({
    inputRange,
    outputRange: [0.28, 1, 0.28],
    extrapolate: 'clamp',
  });
  const translateY = scrollX.interpolate({
    inputRange,
    outputRange: [22, 0, 22],
    extrapolate: 'clamp',
  });
  const scale = scrollX.interpolate({
    inputRange,
    outputRange: [0.97, 1, 0.97],
    extrapolate: 'clamp',
  });
  const featureTranslateX = scrollX.interpolate({
    inputRange,
    outputRange: [20, 0, -20],
    extrapolate: 'clamp',
  });

  return (
    <View style={[styles.slide, { width: pageWidth }]}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.slideContent, compact && styles.slideContentCompact]}
      >
        <Animated.View style={[styles.slideHeader, { opacity, transform: [{ translateY }, { scale }] }]}>
          <Text style={[styles.eyebrow, { color: step.accent }]}>{step.eyebrow}</Text>
          <Text
            style={[styles.title, narrow && styles.titleNarrow]}
            numberOfLines={3}
            adjustsFontSizeToFit
            minimumFontScale={0.82}
          >
            {step.title}
          </Text>
          <Text style={styles.subtitle}>{step.subtitle}</Text>
        </Animated.View>

        {step.deviceShowcase && (
          <Animated.View style={{ opacity, transform: [{ translateY }] }}>
            <DeviceSyncMockup
              accent={step.accent}
              style={[styles.deviceShowcase, compact && styles.deviceShowcaseCompact]}
            />
          </Animated.View>
        )}

        <Animated.View style={[styles.featureList, { opacity, transform: [{ translateX: featureTranslateX }] }]}>
          {step.features.map(feature => (
            <View key={feature.title} style={styles.featureRow}>
              <View style={[styles.featureIcon, { borderColor: step.accent, backgroundColor: `${step.accent}20` }]}>
                <Ionicons name={feature.icon} size={18} color={step.accent} />
              </View>
              <View style={styles.featureCopy}>
                <Text style={styles.featureTitle}>{feature.title}</Text>
                <Text style={styles.featureBody}>{feature.body}</Text>
              </View>
            </View>
          ))}
        </Animated.View>

        <Animated.View style={[styles.proofPanel, { opacity, transform: [{ translateY }] }]}>
          <Ionicons name="checkmark-circle-outline" size={19} color={step.accent} />
          <Text style={styles.proofText}>{step.proof}</Text>
        </Animated.View>
      </ScrollView>
    </View>
  );
}

export default function WhyThalloScreen({ onBack, onLogin, onSignup }: WhyThalloScreenProps) {
  const { height, width } = useWindowDimensions();
  const [stepIndex, setStepIndex] = useState(0);
  const pagerRef = useRef<ScrollView | null>(null);
  const stepIndexRef = useRef(0);
  const scrollX = useRef(new Animated.Value(0)).current;
  const pageWidth = Math.max(1, Math.min(560, width - 44));
  const step = whyThalloSteps[stepIndex];
  const compact = height < 720;
  const narrow = pageWidth < 380;
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === whyThalloSteps.length - 1;
  const shellWidthStyle = { width: pageWidth };

  const scrollToStep = useCallback((nextIndex: number) => {
    const nextStepIndex = clampStepIndex(nextIndex);
    stepIndexRef.current = nextStepIndex;
    setStepIndex(nextStepIndex);
    pagerRef.current?.scrollTo({ x: nextStepIndex * pageWidth, animated: true });
  }, [pageWidth]);

  const handleMomentumScrollEnd = useCallback((event: ScrollEvent) => {
    const nextStepIndex = clampStepIndex(Math.round(event.nativeEvent.contentOffset.x / pageWidth));
    stepIndexRef.current = nextStepIndex;
    setStepIndex(nextStepIndex);
  }, [pageWidth]);

  useEffect(() => {
    stepIndexRef.current = stepIndex;
  }, [stepIndex]);

  useEffect(() => {
    pagerRef.current?.scrollTo({ x: stepIndexRef.current * pageWidth, animated: false });
  }, [pageWidth]);

  const goPrevious = () => scrollToStep(stepIndex - 1);
  const goNext = () => scrollToStep(stepIndex + 1);

  return (
    <View style={styles.root}>
      <View pointerEvents="none" style={styles.backgroundStack}>
        {whyThalloSteps.map((item, index) => {
          const backgroundOpacity = scrollX.interpolate({
            inputRange: [
              (index - 1) * pageWidth,
              index * pageWidth,
              (index + 1) * pageWidth,
            ],
            outputRange: [0, 1, 0],
            extrapolate: 'clamp',
          });

          return (
            <Animated.View
              key={item.key}
              style={[styles.backgroundLayer, { opacity: backgroundOpacity }]}
            >
              <ImageBackground
                accessibilityIgnoresInvertColors
                accessibilityLabel={item.imageLabel}
                source={item.image}
                style={styles.backgroundImage}
                resizeMode="cover"
              >
                <LinearGradient
                  colors={[
                    'rgba(13,15,20,0.08)',
                    'rgba(13,15,20,0.52)',
                    'rgba(13,15,20,0.90)',
                    colors.background,
                  ]}
                  locations={[0, 0.28, 0.66, 1]}
                  style={StyleSheet.absoluteFillObject}
                />
              </ImageBackground>
            </Animated.View>
          );
        })}
      </View>

      <SafeAreaView style={styles.safe}>
        <View style={styles.topBar}>
          <TouchableOpacity
            testID="why-thallo-back"
            activeOpacity={0.78}
            style={styles.iconButton}
            onPress={onBack}
            accessibilityLabel="Back to landing"
          >
            <Ionicons name="chevron-back" size={22} color={colors.textPrimary} />
          </TouchableOpacity>
          <View style={styles.topBrand}>
            <BrandMark size={32} variant="tile" animated={false} style={styles.topBrandMark} />
            <Image source={logo} style={styles.logo} resizeMode="contain" />
          </View>
          <TouchableOpacity
            testID="why-thallo-login"
            activeOpacity={0.78}
            style={styles.signInButton}
            onPress={onLogin}
          >
            <Text style={styles.signInText}>Sign in</Text>
          </TouchableOpacity>
        </View>

        <View style={[styles.progressRow, shellWidthStyle]}>
          {whyThalloSteps.map((item, index) => {
            const active = index === stepIndex;
            return (
              <TouchableOpacity
                key={item.key}
                testID={`why-thallo-step-${index + 1}`}
                activeOpacity={0.76}
                hitSlop={hitSlop.chip}
                style={[
                  styles.progressTrack,
                  active && { backgroundColor: item.accent },
                ]}
                onPress={() => scrollToStep(index)}
                accessibilityLabel={`Show ${item.eyebrow}`}
              />
            );
          })}
        </View>

        <Animated.ScrollView
          ref={pagerRef}
          horizontal
          pagingEnabled
          bounces={false}
          decelerationRate="fast"
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          style={[styles.pager, shellWidthStyle]}
          contentContainerStyle={styles.pagerContent}
          onMomentumScrollEnd={handleMomentumScrollEnd}
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { x: scrollX } } }],
            { useNativeDriver: Platform.OS !== 'web' },
          )}
        >
          {whyThalloSteps.map((item, index) => (
            <WhyThalloSlide
              key={item.key}
              step={item}
              index={index}
              scrollX={scrollX}
              pageWidth={pageWidth}
              compact={compact}
              narrow={narrow}
            />
          ))}
        </Animated.ScrollView>

        <View style={[styles.footer, shellWidthStyle]}>
          <View style={styles.stepControls}>
            <TouchableOpacity
              testID="why-thallo-prev"
              activeOpacity={0.76}
              disabled={isFirst}
              style={[styles.stepButton, isFirst && styles.stepButtonDisabled]}
              onPress={goPrevious}
              accessibilityLabel="Previous"
            >
              <Ionicons name="arrow-back" size={18} color={isFirst ? colors.textMuted : colors.textPrimary} />
            </TouchableOpacity>
            <Text style={styles.stepCount}>{stepIndex + 1} / {whyThalloSteps.length}</Text>
            <TouchableOpacity
              testID="why-thallo-next"
              activeOpacity={0.76}
              disabled={isLast}
              style={[styles.stepButton, isLast && styles.stepButtonDisabled]}
              onPress={goNext}
              accessibilityLabel="Next"
            >
              <Ionicons name="arrow-forward" size={18} color={isLast ? colors.textMuted : colors.textPrimary} />
            </TouchableOpacity>
          </View>

          {isLast ? (
            <>
              <TouchableOpacity
                testID="why-thallo-primary"
                activeOpacity={0.82}
                style={[styles.primaryButton, { backgroundColor: step.accent, shadowColor: step.accent }]}
                onPress={onSignup}
              >
                <Text style={styles.primaryButtonText}>Start setup</Text>
                <Ionicons name="arrow-forward" size={18} color={colors.background} />
              </TouchableOpacity>

              <TouchableOpacity
                testID="why-thallo-secondary"
                activeOpacity={0.78}
                style={styles.secondaryButton}
                onPress={onBack}
              >
                <Text style={styles.secondaryButtonText}>Back to landing</Text>
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity
              testID="why-thallo-secondary"
              activeOpacity={0.78}
              style={styles.secondaryButton}
              onPress={onSignup}
            >
              <Text style={styles.secondaryButtonText}>Skip to setup</Text>
            </TouchableOpacity>
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
    overflow: 'hidden',
  },
  backgroundStack: {
    ...StyleSheet.absoluteFillObject,
  },
  backgroundLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  backgroundImage: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '62%',
  },
  safe: {
    flex: 1,
    paddingHorizontal: 22,
    paddingBottom: Platform.OS === 'android' ? 18 : 8,
  },
  topBar: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  iconButton: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.20)',
    backgroundColor: 'rgba(13,15,20,0.42)',
  },
  topBrand: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  topBrandMark: {
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
  },
  logo: {
    width: 128,
    height: 30,
  },
  signInButton: {
    minHeight: 42,
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
    backgroundColor: 'rgba(13,15,20,0.42)',
    paddingHorizontal: 14,
  },
  signInText: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '900',
  },
  progressRow: {
    alignSelf: 'center',
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
    marginBottom: 10,
  },
  progressTrack: {
    flex: 1,
    height: 4,
    minWidth: 34,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  pager: {
    flex: 1,
    alignSelf: 'center',
  },
  pagerContent: {
    alignItems: 'stretch',
  },
  slide: {
    flex: 1,
  },
  slideContent: {
    flexGrow: 1,
    justifyContent: 'flex-end',
    paddingTop: 32,
    paddingBottom: 18,
  },
  slideContentCompact: {
    paddingTop: 22,
    paddingBottom: 12,
  },
  slideHeader: {
    width: '100%',
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 36,
    lineHeight: 41,
    fontWeight: '900',
    letterSpacing: 0,
  },
  titleNarrow: {
    fontSize: 32,
    lineHeight: 37,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '600',
    marginTop: 13,
  },
  deviceShowcase: {
    marginTop: 22,
  },
  deviceShowcaseCompact: {
    marginTop: 16,
  },
  featureList: {
    gap: 14,
    marginTop: 24,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  featureIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
  },
  featureCopy: {
    flex: 1,
    minWidth: 0,
  },
  featureTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '900',
  },
  featureBody: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    marginTop: 3,
  },
  proofPanel: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(13,15,20,0.62)',
    paddingHorizontal: 13,
    paddingVertical: 11,
    marginTop: 22,
  },
  proofText: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '800',
  },
  footer: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 560,
    gap: 10,
    paddingTop: 6,
  },
  stepControls: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  stepButton: {
    width: 46,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  stepButtonDisabled: {
    opacity: 0.45,
  },
  stepCount: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '900',
  },
  primaryButton: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: radius.md,
    paddingHorizontal: 18,
    shadowOffset: { width: 0, height: 7 },
    shadowOpacity: 0.24,
    shadowRadius: 14,
    elevation: 6,
  },
  primaryButtonText: {
    color: colors.background,
    fontSize: 17,
    fontWeight: '900',
  },
  secondaryButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(13,15,20,0.55)',
    paddingHorizontal: 16,
  },
  secondaryButtonText: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '900',
  },
});
