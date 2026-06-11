import React, { useEffect } from 'react';
import type { ComponentProps } from 'react';
import {
  Animated,
  Image,
  ImageBackground,
  Linking,
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
import { useRouter } from 'expo-router';
import DeviceSyncMockup from '../src/components/DeviceSyncMockup';
import ScrollRevealView, { useScrollReveal } from '../src/components/ScrollRevealView';
import {
  THEME_PICKER_ORDER,
  colors,
  getContrastingTextColor,
  getTheme,
  hitSlop,
  radius,
  typography,
  type AppThemeName,
} from '../src/constants/theme';
import { SUPPORT_EMAIL } from '../src/constants/legal';
import {
  FREE_MEAL_ROUTINE_LIMIT,
  FREE_TIER_SUMMARY,
  FREE_WORKOUT_TEMPLATE_LIMIT,
  PRO_TIER_SUMMARY,
  SIGNUP_TRIAL_DAYS,
} from '../src/utils/subscriptionCore';

const logo = require('../assets/images/thallo-logo-compact-white.png');
const heroLogo = require('../assets/images/thallo-logo-white-transparent-New.png');
const auroraScreen = require('../assets/images/product-screenshots/thallo-today-home-aurora.png');
const roseScreen = require('../assets/images/product-screenshots/thallo-today-home-rose.png');
const paperScreen = require('../assets/images/product-screenshots/thallo-today-home-paper.png');
const emberScreen = require('../assets/images/product-screenshots/thallo-today-home-ember.png');
const heroPhoto = require('../assets/images/landing-photos/pexels-men-lifting-weights-18187615.jpg');
const workoutPhoto = require('../assets/images/landing-photos/pexels-crossfit-group-27433192.jpg');
const mealPhoto = require('../assets/images/card-backgrounds/meal-card-plant-based-day.jpg');
const recoveryPhoto = require('../assets/images/landing-photos/pexels-sauna-seated.jpg');
const watchPhoto = require('../assets/images/landing-photos/pexels-smartwatch-couple-5038816.jpg');
const watchPhotoCompact = require('../assets/images/landing-photos/pexels-smartwatch-couple-5038816-mobile.jpg');
const HERO_LOGO_ASPECT_RATIO = 1420 / 474;

type IconName = ComponentProps<typeof Ionicons>['name'];
type AboutSystemSection = {
  eyebrow: string;
  title: string;
  body: string;
  image: any;
  imagePosition: string;
  icon: IconName;
  accent: string;
  points: string[];
};

type ThemeShowcaseItem = {
  themeName: AppThemeName;
  label: string;
  context: string;
  icon: IconName;
  screen: any;
};

type TierStoryItem = {
  eyebrow: string;
  title: string;
  body: string;
  icon: IconName;
  accent: string;
  points: string[];
};

type FeatureStoryItem = {
  title: string;
  body: string;
  icon: IconName;
  accent: string;
};

const trustItems: { icon: IconName; title: string; body: string; accent: string }[] = [
  {
    icon: 'calendar-outline',
    title: 'A real 7-day plan',
    body: 'Your week stays stable while progress, skipped days, and recovery signals stay visible.',
    accent: colors.primary,
  },
  {
    icon: 'sparkles-outline',
    title: 'AI where it helps',
    body: 'Food, scans, and coaching get richer context while workout selection stays deterministic.',
    accent: '#A78BFA',
  },
  {
    icon: 'watch-outline',
    title: 'Phone and Watch',
    body: 'Start, track, hydrate, and finish sessions without losing the flow of the workout.',
    accent: '#F59E0B',
  },
  {
    icon: 'lock-closed-outline',
    title: 'Private by design',
    body: 'Workout sharing never leaks calories, macros, weight, routes, or body metrics.',
    accent: '#59D98E',
  },
];

const themeShowcaseItems: ThemeShowcaseItem[] = [
  {
    themeName: 'aurora',
    label: 'Aurora',
    context: 'Default dark',
    icon: 'sparkles-outline',
    screen: auroraScreen,
  },
  {
    themeName: 'rose',
    label: 'Rose',
    context: 'Soft blush',
    icon: 'rose-outline',
    screen: roseScreen,
  },
  {
    themeName: 'paper',
    label: 'Paper',
    context: 'Ink light',
    icon: 'document-text-outline',
    screen: paperScreen,
  },
  {
    themeName: 'ember',
    label: 'Ember',
    context: 'Flame dark',
    icon: 'flame-outline',
    screen: emberScreen,
  },
];

const tierStoryItems: TierStoryItem[] = [
  {
    eyebrow: 'Free',
    title: 'A complete tracker without a paywall.',
    body: FREE_TIER_SUMMARY,
    icon: 'barbell-outline',
    accent: '#59D98E',
    points: [
      'Manual strength, cardio, meal, hydration, supplement, and body tracking',
      `${FREE_WORKOUT_TEMPLATE_LIMIT} workout templates, unlimited saved meals, and ${FREE_MEAL_ROUTINE_LIMIT} meal routines`,
      'Basic progress history and workout-only social setup',
    ],
  },
  {
    eyebrow: 'Pro',
    title: 'The guided system for planning and deeper signals.',
    body: PRO_TIER_SUMMARY,
    icon: 'sparkles-outline',
    accent: colors.primary,
    points: [
      'Generated 7-day PlanWeeks, AI meal planning, scans, and coach chat',
      'Set feedback, weight recommendations, readiness, scoring, and health context',
      `${SIGNUP_TRIAL_DAYS}-day Pro trial for new accounts`,
    ],
  },
];

const featureStoryItems: FeatureStoryItem[] = [
  {
    title: 'Live workout guidance',
    body: 'Active sessions keep rest timers, set logging, and completion synced while weight-based lifts can surface next-load guidance from training history.',
    icon: 'timer-outline',
    accent: '#F59E0B',
  },
  {
    title: 'Cardio is handled directly',
    body: 'Strength plans can include conditioning work, cardio goals get cardio-led weeks, and outdoor sessions can capture time, distance, pace, and route context.',
    icon: 'bicycle-outline',
    accent: '#60B8F0',
  },
  {
    title: 'Social sharing stays bounded',
    body: 'Friends can see workout activity, streaks, exercises, set load, time, and distance; calories, macros, weight, route maps, and body metrics stay private.',
    icon: 'people-outline',
    accent: '#A78BFA',
  },
];

const systemSections: AboutSystemSection[] = [
  {
    eyebrow: 'Training',
    title: 'Plans that respect the week you actually live.',
    body: 'Thallo builds around schedule, equipment, injuries, goals, and fatigue. Today is highlighted, past days keep their history, and future days stay queued instead of reshuffling every time you open the app.',
    image: workoutPhoto,
    imagePosition: '50% 62%',
    icon: 'barbell-outline',
    accent: colors.primary,
    points: ['Deterministic exercise selection', 'Short dynamic warmups', 'Recovery-aware focus'],
  },
  {
    eyebrow: 'Nutrition',
    title: 'Meals, macros, hydration, and supplements in one signal.',
    body: 'Plan-preview scoring helps you understand the day before you log it. Actual meal scoring runs on the server, so logged nutrition stays consistent across devices.',
    image: mealPhoto,
    imagePosition: '54% 52%',
    icon: 'restaurant-outline',
    accent: '#35C46A',
    points: ['Server-authoritative meal score', 'Favorites and routines', 'Food photo and barcode flows'],
  },
  {
    eyebrow: 'Recovery',
    title: 'Readiness without turning wellness into noise.',
    body: 'Training load, sleep, hydration, nutrition, body trends, and optional Apple Health context come together as practical daily guidance.',
    image: recoveryPhoto,
    imagePosition: '50% 50%',
    icon: 'pulse-outline',
    accent: '#60B8F0',
    points: ['12 muscle fatigue groups', 'Sleep and readiness context', 'Workout-only social boundary'],
  },
];

function imageFocus(position: string) {
  return Platform.OS === 'web' ? ({ objectPosition: position } as any) : null;
}

function openMail() {
  const subject = encodeURIComponent('Thallo beta access request');
  const body = encodeURIComponent([
    'I would like beta access to Thallo.',
    '',
    'I am most interested in:',
    '- Training plans',
    '- Meal / macro tracking',
    '- Recovery and health signals',
    '- Apple Watch workout flow',
    '- Web review dashboard',
    '',
    'My current fitness or nutrition setup:',
  ].join('\n'));
  Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`).catch(() => undefined);
}

function openApp(router: ReturnType<typeof useRouter>) {
  if (Platform.OS === 'web') {
    router.push('/signin');
    return;
  }
  Linking.openURL('thallo://').catch(() => undefined);
}

function PageButton({
  label,
  icon,
  variant,
  onPress,
}: {
  label: string;
  icon: IconName;
  variant: 'primary' | 'secondary' | 'ghost';
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      activeOpacity={0.82}
      style={[
        styles.button,
        variant === 'primary' && styles.primaryButton,
        variant === 'secondary' && styles.secondaryButton,
        variant === 'ghost' && styles.ghostButton,
      ]}
      onPress={onPress}
    >
      <Ionicons
        name={icon}
        size={18}
        color={variant === 'primary' ? colors.background : colors.textPrimary}
      />
      <Text style={[
        styles.buttonText,
        variant === 'primary' && styles.primaryButtonText,
      ]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function TrustCard({ item }: { item: typeof trustItems[number] }) {
  return (
    <View style={styles.trustCard}>
      <View style={[styles.trustIcon, { backgroundColor: `${item.accent}20`, borderColor: `${item.accent}55` }]}>
        <Ionicons name={item.icon} size={19} color={item.accent} />
      </View>
      <Text style={styles.trustTitle}>{item.title}</Text>
      <Text style={styles.trustBody}>{item.body}</Text>
    </View>
  );
}

function TierStoryCard({ item }: { item: TierStoryItem }) {
  return (
    <View style={styles.tierCard}>
      <View style={styles.tierCardTop}>
        <View style={[styles.tierIcon, { backgroundColor: `${item.accent}18`, borderColor: `${item.accent}55` }]}>
          <Ionicons name={item.icon} size={19} color={item.accent} />
        </View>
        <View style={styles.tierTitleWrap}>
          <Text style={[styles.tierEyebrow, { color: item.accent }]}>{item.eyebrow}</Text>
          <Text style={styles.tierTitle}>{item.title}</Text>
        </View>
      </View>
      <Text style={styles.tierBody}>{item.body}</Text>
      <View style={styles.tierPointList}>
        {item.points.map(point => (
          <View key={point} style={styles.tierPointRow}>
            <Ionicons name="checkmark-circle-outline" size={16} color={item.accent} />
            <Text style={styles.tierPointText}>{point}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function FeatureStoryCard({ item }: { item: FeatureStoryItem }) {
  return (
    <View style={styles.featureStoryCard}>
      <View style={[styles.featureStoryIcon, { backgroundColor: `${item.accent}18`, borderColor: `${item.accent}55` }]}>
        <Ionicons name={item.icon} size={18} color={item.accent} />
      </View>
      <Text style={styles.featureStoryTitle}>{item.title}</Text>
      <Text style={styles.featureStoryBody}>{item.body}</Text>
    </View>
  );
}

function SystemSection({
  section,
  flipped,
  stacked,
  isLast,
}: {
  section: AboutSystemSection;
  flipped: boolean;
  stacked: boolean;
  isLast: boolean;
}) {
  return (
    <View style={[
      styles.systemRow,
      flipped && !stacked && styles.systemRowFlipped,
      stacked && styles.systemRowStacked,
      isLast && styles.systemRowLast,
    ]}>
      <ImageBackground
        source={section.image}
        resizeMode="cover"
        imageStyle={[styles.systemImage, imageFocus(section.imagePosition)]}
        style={[styles.systemVisual, stacked && styles.systemVisualStacked]}
      >
        <LinearGradient
          colors={['rgba(6,8,12,0.08)', 'rgba(6,8,12,0.82)']}
          style={StyleSheet.absoluteFillObject}
        />
        <View style={[styles.systemVisualChip, { backgroundColor: section.accent }]}>
          <Ionicons name={section.icon} size={16} color={colors.background} />
          <Text style={styles.systemVisualChipText}>{section.eyebrow}</Text>
        </View>
      </ImageBackground>

      <View style={[styles.systemCopy, stacked && styles.systemCopyStacked]}>
        <Text style={[styles.sectionEyebrow, { color: section.accent }]}>{section.eyebrow}</Text>
        <Text style={styles.sectionTitle}>{section.title}</Text>
        <Text style={styles.sectionBody}>{section.body}</Text>
        <View style={styles.pointList}>
          {section.points.map(point => (
            <View key={point} style={styles.pointRow}>
              <Ionicons name="checkmark-circle-outline" size={17} color={section.accent} />
              <Text style={styles.pointText}>{point}</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

function ThemePreviewCard({ item, compact }: { item: ThemeShowcaseItem; compact: boolean }) {
  const theme = getTheme(item.themeName);
  const c = theme.colors;
  const palette = theme.sections;
  const primaryText = getContrastingTextColor(c.primary);
  const swatches = [
    c.primary,
    palette.workout.strong,
    palette.meals.strong,
    palette.ai.strong,
    palette.account.strong,
  ];
  const phoneWidth = compact ? 112 : 132;
  const isPaper = item.themeName === 'paper';
  const isEmber = item.themeName === 'ember';
  const frameColor = isPaper ? c.textPrimary : c.background;
  const frameBackground = isPaper ? c.surface : c.background;

  return (
    <View style={[styles.themeCard, { backgroundColor: c.surface, borderColor: c.border }]}>
      <LinearGradient
        colors={(isEmber
          ? [c.background, c.surface, `${c.primary}33`]
          : [c.background, c.surface, c.surfaceRaised]) as any}
        locations={[0, 0.58, 1] as any}
        style={StyleSheet.absoluteFillObject}
      />
      <View style={styles.themeCardHeader}>
        <View style={[styles.themeIcon, { backgroundColor: `${c.primary}20`, borderColor: `${c.primary}66` }]}>
          <Ionicons name={item.icon} size={17} color={c.primary} />
        </View>
        <View style={styles.themeCardTitleWrap}>
          <Text style={[styles.themeName, { color: c.textPrimary }]} numberOfLines={1}>{item.label}</Text>
          <Text style={[styles.themeContext, { color: c.textMuted }]} numberOfLines={1}>{item.context}</Text>
        </View>
      </View>

      <View style={styles.themePreviewBody}>
        <View style={[
          styles.themePhoneFrame,
          {
            width: phoneWidth,
            height: Math.round(phoneWidth * 1.9667),
            borderColor: frameColor,
            backgroundColor: frameBackground,
            shadowColor: c.primary,
          },
        ]}>
          <View style={[
            styles.themePhoneNotch,
            {
              width: phoneWidth * 0.27,
              height: Math.max(5, phoneWidth * 0.025),
              top: phoneWidth * 0.034,
              borderRadius: phoneWidth * 0.018,
              backgroundColor: frameColor,
            },
          ]} />
          <Image
            source={item.screen}
            resizeMode="cover"
            style={styles.themeScreenshot}
          />
        </View>

        <View style={styles.themeCardMeta}>
          <View style={[styles.themePrimaryPill, { backgroundColor: c.primary, borderColor: isPaper ? c.textPrimary : 'transparent' }]}>
            <Text style={[styles.themePrimaryPillText, { color: primaryText }]} numberOfLines={1}>
              {theme.label}
            </Text>
          </View>
          <View style={styles.themeSwatchRow}>
            {swatches.map((swatch, index) => (
              <View
                key={`${item.themeName}-${swatch}-${index}`}
                style={[styles.themeSwatch, { backgroundColor: swatch, borderColor: c.border }]}
              />
            ))}
          </View>
          <View style={[styles.themeMiniPanel, { backgroundColor: c.surfaceRaised, borderColor: isEmber ? c.accent : c.border }]}>
            <View style={[styles.themeMiniLineStrong, { backgroundColor: isEmber ? c.accent : c.textPrimary }]} />
            <View style={[styles.themeMiniLine, { backgroundColor: c.textMuted }]} />
            <View style={styles.themeMetricRow}>
              <View style={[styles.themeMetric, { backgroundColor: palette.workout.soft, borderColor: palette.workout.strong }]} />
              <View style={[styles.themeMetric, { backgroundColor: palette.meals.soft, borderColor: palette.meals.strong }]} />
              <View style={[styles.themeMetric, { backgroundColor: palette.ai.soft, borderColor: palette.ai.strong }]} />
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

export default function AboutPage() {
  const router = useRouter();
  const reveal = useScrollReveal();
  const { height, width } = useWindowDimensions();
  const compact = width < 760;
  const heroMinHeight = compact ? Math.max(660, height * 0.86) : Math.max(640, height * 0.88);
  const contentWidth = Math.max(280, Math.min(1180, width - 44));
  const heroLogoWidth = compact ? Math.min(360, Math.max(260, contentWidth - 16)) : 520;
  const heroLogoHeight = Math.round(heroLogoWidth / HERO_LOGO_ASPECT_RATIO);

  useEffect(() => {
    if (Platform.OS === 'web') {
      document.title = 'Thallo - Total health, training, nutrition, and recovery';
    }
  }, []);

  return (
    <View style={styles.root}>
      <Animated.ScrollView
        onLayout={reveal.onLayout}
        onScroll={reveal.onScroll}
        scrollEventThrottle={16}
        bounces={false}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.page}
      >
        <ImageBackground
          source={heroPhoto}
          resizeMode="cover"
          style={[styles.hero, { minHeight: heroMinHeight }]}
          imageStyle={[styles.heroImage, imageFocus(compact ? '50% 50%' : '50% 50%')]}
        >
          <LinearGradient
            colors={[
              'rgba(6,8,12,0.28)',
              'rgba(6,8,12,0.48)',
              'rgba(13,15,20,0.84)',
              colors.background,
            ]}
            locations={[0, 0.42, 0.78, 1]}
            style={StyleSheet.absoluteFillObject}
          />

          <SafeAreaView style={styles.heroSafe}>
            <View style={styles.navBar}>
              <View style={styles.navActions}>
                <TouchableOpacity
                  activeOpacity={0.78}
                  hitSlop={hitSlop.chip}
                  style={styles.navLink}
                  onPress={openMail}
                >
                  <Ionicons name="mail-outline" size={15} color={colors.textPrimary} />
                  <Text style={styles.navLinkText}>Contact</Text>
                </TouchableOpacity>
                {!compact ? (
                  <TouchableOpacity
                    activeOpacity={0.78}
                    style={styles.navButton}
                    onPress={() => router.push('/signin')}
                  >
                    <Ionicons name="log-in-outline" size={15} color={colors.background} />
                    <Text style={styles.navButtonText}>Sign in</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>

            <View style={[styles.heroContent, compact && styles.heroContentCompact]}>
              <View style={[styles.heroCopy, compact && styles.heroCopyCompact, compact && { maxWidth: contentWidth }]}>
                <Image
                  source={heroLogo}
                  resizeMode="contain"
                  accessibilityLabel="Thallo"
                  style={[styles.heroLogo, { width: heroLogoWidth, height: heroLogoHeight }]}
                />
                <Text style={[
                  styles.heroSubtitle,
                  compact && styles.heroSubtitleCompact,
                  compact && { maxWidth: Math.max(260, contentWidth - 28) },
                ]}>
                  {compact
                    ? 'Premium training, nutrition,\nrecovery, and health signals\nbuilt around a weekly plan you can trust.'
                    : 'Premium training, nutrition, recovery, and health signals built around a weekly plan you can trust.'}
                </Text>
                <View style={styles.heroButtonRow}>
                  <PageButton label="Join beta" icon="mail-outline" variant="primary" onPress={openMail} />
                  <PageButton label="Sign in" icon="log-in-outline" variant="secondary" onPress={() => openApp(router)} />
                </View>
              </View>

              <DeviceSyncMockup
                compact={compact}
                style={[
                  styles.productShowcase,
                  compact && styles.productShowcaseCompact,
                  compact && { width: contentWidth },
                ]}
              />
            </View>
          </SafeAreaView>
        </ImageBackground>

        <ScrollRevealView
          scrollY={reveal.scrollY}
          viewportHeight={reveal.viewportHeight}
          index={0}
          revealDistance={22}
          style={styles.trustBand}
        >
          <View style={styles.sectionInner}>
            <View style={styles.trustGrid}>
              {trustItems.map(item => (
                <TrustCard key={item.title} item={item} />
              ))}
            </View>
          </View>
        </ScrollRevealView>

        <ScrollRevealView
          scrollY={reveal.scrollY}
          viewportHeight={reveal.viewportHeight}
          index={1}
          revealDistance={24}
          style={styles.introBand}
        >
          <View style={styles.sectionInner}>
            <View style={styles.introHeader}>
              <Text style={styles.sectionEyebrow}>About Thallo</Text>
              <Text style={styles.largeTitle}>A calmer operating system for training days, meal days, and recovery days.</Text>
              <Text style={styles.largeBody}>
                Thallo is for people who want structure without surrendering common sense. The app keeps workouts deterministic, lets AI enrich the surrounding guidance, and treats health data as private context rather than content.
              </Text>
            </View>
          </View>
        </ScrollRevealView>

        <ScrollRevealView
          scrollY={reveal.scrollY}
          viewportHeight={reveal.viewportHeight}
          index={2}
          revealDistance={24}
          style={styles.accessBand}
        >
          <View style={styles.sectionInner}>
            <View style={[styles.accessHeader, compact && styles.accessHeaderCompact]}>
              <View style={styles.accessHeaderCopy}>
                <Text style={styles.sectionEyebrow}>Why Thallo</Text>
                <Text style={styles.largeTitle}>Free tracking stays useful. Pro adds the guided engine.</Text>
                <Text style={styles.largeBody}>
                  Thallo is clear about the split: everyday logging and workout history are available for free, while Pro unlocks generated weeks, richer AI help, readiness, scoring, and deeper trend context.
                </Text>
              </View>
              <View style={styles.accessBadge}>
                <Ionicons name="shield-checkmark-outline" size={17} color={colors.primaryLight} />
                <Text style={styles.accessBadgeText}>Private by default</Text>
              </View>
            </View>

            <View style={[styles.tierGrid, compact && styles.tierGridCompact]}>
              {tierStoryItems.map(item => (
                <TierStoryCard key={item.eyebrow} item={item} />
              ))}
            </View>

            <View style={[styles.featureStoryGrid, compact && styles.featureStoryGridCompact]}>
              {featureStoryItems.map(item => (
                <FeatureStoryCard key={item.title} item={item} />
              ))}
            </View>
          </View>
        </ScrollRevealView>

        <ScrollRevealView
          scrollY={reveal.scrollY}
          viewportHeight={reveal.viewportHeight}
          index={3}
          revealDistance={24}
          style={styles.themeBand}
        >
          <View style={styles.sectionInner}>
            <View style={[styles.themeHeader, compact && styles.themeHeaderCompact]}>
              <View style={styles.themeHeaderCopy}>
                <Text style={styles.sectionEyebrow}>Personal themes</Text>
                <Text style={styles.largeTitle}>The plan stays consistent. The app can feel like yours.</Text>
                <Text style={styles.largeBody}>
                  Thallo includes dark, light, monochrome, high-energy, and calmer palettes that carry through Today, workouts, meals, settings, and Watch sync.
                </Text>
              </View>
              <View style={styles.themeCountPill}>
                <Ionicons name="color-palette-outline" size={17} color={colors.primaryLight} />
                <Text style={styles.themeCountText}>{THEME_PICKER_ORDER.length} themes</Text>
              </View>
            </View>
            <View style={[styles.themePreviewGrid, compact && styles.themePreviewGridCompact]}>
              {themeShowcaseItems.map(item => (
                <ThemePreviewCard key={item.themeName} item={item} compact={compact} />
              ))}
            </View>
          </View>
        </ScrollRevealView>

        {systemSections.map((section, index) => (
          <ScrollRevealView
            key={section.title}
            scrollY={reveal.scrollY}
            viewportHeight={reveal.viewportHeight}
            index={index + 4}
            revealDistance={28}
            style={[
              styles.systemBandSegment,
              index === 0 && styles.systemBandSegmentFirst,
              index === systemSections.length - 1 && styles.systemBandSegmentLast,
            ]}
          >
            <View style={styles.sectionInner}>
              <SystemSection
                section={section}
                flipped={index % 2 === 1}
                stacked={compact}
                isLast={index === systemSections.length - 1}
              />
            </View>
          </ScrollRevealView>
        ))}

        <ScrollRevealView
          scrollY={reveal.scrollY}
          viewportHeight={reveal.viewportHeight}
          index={7}
          revealDistance={26}
          style={styles.watchBand}
        >
          <View style={[styles.sectionInner, styles.watchInner, compact && styles.watchInnerCompact]}>
            <View style={[styles.watchPhotoWrap, compact && styles.watchPhotoWrapCompact]}>
              <ImageBackground
                source={compact ? watchPhotoCompact : watchPhoto}
                resizeMode="cover"
                imageStyle={[styles.watchPhoto, imageFocus(compact ? '50% 52%' : '52% 58%')]}
                style={styles.watchPhotoFill}
              >
                <LinearGradient
                  colors={['rgba(6,8,12,0.1)', 'rgba(6,8,12,0.82)']}
                  style={StyleSheet.absoluteFillObject}
                />
                <View style={styles.watchPhotoCopy}>
                  <Text style={styles.watchPhotoTitle}>Built for the live workout loop.</Text>
                  <Text style={styles.watchPhotoBody}>
                    iPhone gives the full plan and context. Apple Watch keeps timers, set flow, hydration, and quick workout actions close while you train.
                  </Text>
                </View>
              </ImageBackground>
            </View>

            <View style={[styles.watchDetails, compact && styles.watchDetailsCompact]}>
              <View style={styles.detailRow}>
                <Ionicons name="timer-outline" size={20} color={colors.primaryLight} />
                <View style={styles.detailCopy}>
                  <Text style={styles.detailTitle}>Live sessions</Text>
                  <Text style={styles.detailBody}>Rest timers, set logging, and workout completion stay synced.</Text>
                </View>
              </View>
              <View style={styles.detailRow}>
                <Ionicons name="water-outline" size={20} color="#60B8F0" />
                <View style={styles.detailCopy}>
                  <Text style={styles.detailTitle}>Hydration nudges</Text>
                  <Text style={styles.detailBody}>Quick logging works from the daily surface or Watch controls.</Text>
                </View>
              </View>
              <View style={styles.detailRow}>
                <Ionicons name="shield-checkmark-outline" size={20} color="#59D98E" />
                <View style={styles.detailCopy}>
                  <Text style={styles.detailTitle}>Private boundaries</Text>
                  <Text style={styles.detailBody}>Social activity is workout-only unless the user chooses what to post.</Text>
                </View>
              </View>
            </View>
          </View>
        </ScrollRevealView>

        <ScrollRevealView
          scrollY={reveal.scrollY}
          viewportHeight={reveal.viewportHeight}
          index={8}
          revealDistance={22}
          style={styles.ctaBand}
        >
          <View style={styles.sectionInner}>
            <View style={[styles.ctaPanel, compact && styles.ctaPanelCompact]}>
              <View style={styles.ctaCopy}>
                <Text style={styles.sectionEyebrow}>Beta access</Text>
                <Text style={styles.ctaTitle}>Build the week in the app, then train from phone or Watch.</Text>
                <Text style={styles.ctaBody}>
                  Request access to try the weekly planner, nutrition tracking, recovery signals, themes, and live workout flow.
                </Text>
              </View>
              <View style={[styles.ctaActions, compact && styles.ctaActionsCompact]}>
                <PageButton label="Request access" icon="mail-outline" variant="primary" onPress={openMail} />
                <PageButton label="Sign in" icon="arrow-forward-outline" variant="ghost" onPress={() => router.push('/signin')} />
              </View>
            </View>
          </View>
        </ScrollRevealView>

        <View style={styles.footer}>
          <View style={styles.sectionInner}>
            <View style={[styles.footerRow, compact && styles.footerRowCompact]}>
              <Image source={logo} style={styles.footerLogo} resizeMode="contain" />
              <Text style={styles.footerText}>Training, nutrition, recovery, and privacy-conscious coaching for total health.</Text>
              <TouchableOpacity activeOpacity={0.78} onPress={openMail} hitSlop={hitSlop.chip}>
                <Text style={styles.footerLink}>{SUPPORT_EMAIL}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Animated.ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  page: {
    backgroundColor: colors.background,
  },
  hero: {
    width: '100%',
    overflow: 'hidden',
  },
  heroImage: {
    opacity: 0.9,
  },
  heroSafe: {
    flex: 1,
    paddingHorizontal: 22,
    paddingBottom: 36,
  },
  navBar: {
    width: '100%',
    maxWidth: 1180,
    alignSelf: 'center',
    minHeight: 70,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 16,
  },
  navActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  navLink: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
  },
  navLinkText: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '800',
  },
  navButton: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
    paddingHorizontal: 14,
  },
  navButtonText: {
    ...typography.brandButton,
    color: colors.background,
    fontSize: 13,
  },
  heroContent: {
    flex: 1,
    width: '100%',
    maxWidth: 1180,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 42,
    paddingTop: 12,
  },
  heroContentCompact: {
    flexDirection: 'column',
    alignItems: 'stretch',
    justifyContent: 'center',
    gap: 22,
  },
  heroCopy: {
    flex: 1,
    minWidth: 0,
    maxWidth: 610,
  },
  heroCopyCompact: {
    width: '100%',
    alignSelf: 'center',
  },
  heroLogo: {
    maxWidth: '100%',
  },
  heroSubtitle: {
    color: colors.textSecondary,
    fontSize: 22,
    lineHeight: 31,
    fontWeight: '700',
    maxWidth: 570,
    marginTop: 14,
  },
  heroSubtitleCompact: {
    fontSize: 17,
    lineHeight: 25,
    width: '100%',
    maxWidth: '100%',
  },
  heroButtonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 28,
  },
  button: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: radius.sm,
    paddingHorizontal: 18,
    borderWidth: 1,
  },
  primaryButton: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.24,
    shadowRadius: 18,
    elevation: 6,
  },
  secondaryButton: {
    backgroundColor: 'rgba(13,15,20,0.58)',
    borderColor: 'rgba(255,255,255,0.22)',
  },
  ghostButton: {
    backgroundColor: 'transparent',
    borderColor: 'rgba(255,255,255,0.2)',
  },
  buttonText: {
    ...typography.brandButton,
    color: colors.textPrimary,
    fontSize: 15,
  },
  primaryButtonText: {
    color: colors.background,
  },
  productShowcase: {
    flexShrink: 0,
    width: 430,
    maxWidth: '100%',
  },
  productShowcaseCompact: {
    alignSelf: 'center',
    width: '100%',
  },
  trustBand: {
    backgroundColor: colors.background,
    paddingVertical: 34,
  },
  sectionInner: {
    width: '100%',
    maxWidth: 1180,
    alignSelf: 'center',
    paddingHorizontal: 22,
  },
  trustGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  trustCard: {
    flexGrow: 1,
    flexBasis: 250,
    minHeight: 178,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 18,
  },
  trustIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  trustTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    lineHeight: 23,
    fontWeight: '900',
    marginBottom: 8,
  },
  trustBody: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
  },
  introBand: {
    backgroundColor: '#10141B',
    paddingVertical: 72,
  },
  introHeader: {
    maxWidth: 790,
  },
  sectionEyebrow: {
    color: colors.primaryLight,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 0,
    marginBottom: 10,
  },
  largeTitle: {
    color: colors.textPrimary,
    fontSize: 42,
    lineHeight: 49,
    fontWeight: '900',
    letterSpacing: 0,
  },
  largeBody: {
    color: colors.textSecondary,
    fontSize: 18,
    lineHeight: 28,
    fontWeight: '600',
    marginTop: 18,
  },
  accessBand: {
    backgroundColor: '#0B1017',
    paddingVertical: 72,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.04)',
  },
  accessHeader: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 24,
    marginBottom: 28,
  },
  accessHeaderCompact: {
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  accessHeaderCopy: {
    flex: 1,
    maxWidth: 820,
  },
  accessBadge: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(110,231,220,0.24)',
    backgroundColor: 'rgba(21,199,184,0.08)',
    paddingHorizontal: 14,
  },
  accessBadgeText: {
    color: colors.textPrimary,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '900',
  },
  tierGrid: {
    flexDirection: 'row',
    gap: 14,
  },
  tierGridCompact: {
    flexDirection: 'column',
  },
  tierCard: {
    flex: 1,
    minWidth: 0,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 20,
  },
  tierCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  tierIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tierTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  tierEyebrow: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 0,
    marginBottom: 3,
  },
  tierTitle: {
    color: colors.textPrimary,
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '900',
  },
  tierBody: {
    color: colors.textSecondary,
    fontSize: 15,
    lineHeight: 23,
    fontWeight: '600',
  },
  tierPointList: {
    gap: 10,
    marginTop: 18,
  },
  tierPointRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
  },
  tierPointText: {
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '800',
  },
  featureStoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
    marginTop: 14,
  },
  featureStoryGridCompact: {
    flexDirection: 'column',
  },
  featureStoryCard: {
    flexGrow: 1,
    flexBasis: 300,
    minHeight: 206,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#10141B',
    padding: 18,
  },
  featureStoryIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  featureStoryTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    lineHeight: 23,
    fontWeight: '900',
    marginBottom: 8,
  },
  featureStoryBody: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 21,
    fontWeight: '600',
  },
  themeBand: {
    backgroundColor: colors.background,
    paddingVertical: 72,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.04)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  themeHeader: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 24,
    marginBottom: 28,
  },
  themeHeaderCompact: {
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  themeHeaderCopy: {
    flex: 1,
    maxWidth: 780,
  },
  themeCountPill: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(110,231,220,0.24)',
    backgroundColor: 'rgba(21,199,184,0.08)',
    paddingHorizontal: 14,
  },
  themeCountText: {
    color: colors.textPrimary,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '900',
  },
  themePreviewGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
  },
  themePreviewGridCompact: {
    flexDirection: 'column',
  },
  themeCard: {
    flexGrow: 1,
    flexBasis: 258,
    minHeight: 314,
    overflow: 'hidden',
    borderRadius: radius.sm,
    borderWidth: 1,
    padding: 16,
  },
  themeCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 14,
  },
  themeIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  themeCardTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  themeName: {
    fontSize: 18,
    lineHeight: 23,
    fontWeight: '900',
  },
  themeContext: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0,
    marginTop: 1,
  },
  themePreviewBody: {
    flex: 1,
    minHeight: 230,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
  },
  themePhoneFrame: {
    flexShrink: 0,
    overflow: 'hidden',
    borderRadius: 20,
    borderWidth: 6,
    shadowOpacity: 0.22,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 7,
  },
  themePhoneNotch: {
    position: 'absolute',
    alignSelf: 'center',
    zIndex: 3,
  },
  themeScreenshot: {
    width: '100%',
    height: '100%',
  },
  themeCardMeta: {
    flex: 1,
    minWidth: 106,
    gap: 10,
  },
  themePrimaryPill: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    minHeight: 32,
    justifyContent: 'center',
    borderRadius: radius.pill,
    paddingHorizontal: 11,
  },
  themePrimaryPillText: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '900',
  },
  themeSwatchRow: {
    flexDirection: 'row',
    gap: 5,
  },
  themeSwatch: {
    width: 21,
    height: 21,
    borderRadius: 7,
    borderWidth: 1,
  },
  themeMiniPanel: {
    borderRadius: radius.sm,
    borderWidth: 1,
    padding: 10,
    gap: 8,
  },
  themeMiniLineStrong: {
    width: '72%',
    height: 6,
    borderRadius: radius.pill,
    opacity: 0.88,
  },
  themeMiniLine: {
    width: '50%',
    height: 5,
    borderRadius: radius.pill,
    opacity: 0.72,
  },
  themeMetricRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 2,
  },
  themeMetric: {
    flex: 1,
    height: 32,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  systemBandSegment: {
    backgroundColor: colors.background,
  },
  systemBandSegmentFirst: {
    paddingTop: 72,
  },
  systemBandSegmentLast: {
    paddingBottom: 72,
  },
  systemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 46,
    marginBottom: 64,
  },
  systemRowLast: {
    marginBottom: 0,
  },
  systemRowFlipped: {
    flexDirection: 'row-reverse',
  },
  systemRowStacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 24,
    marginBottom: 58,
  },
  systemVisual: {
    flex: 1,
    minHeight: 360,
    overflow: 'hidden',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'flex-end',
    padding: 18,
  },
  systemImage: {
    borderRadius: radius.sm,
    width: '100%',
    height: '100%',
  },
  systemVisualStacked: {
    width: '100%',
    minHeight: 300,
  },
  systemVisualChip: {
    alignSelf: 'flex-start',
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
  },
  systemVisualChipText: {
    color: colors.background,
    fontSize: 12,
    fontWeight: '900',
  },
  systemCopy: {
    flex: 1,
    minWidth: 0,
  },
  systemCopyStacked: {
    width: '100%',
  },
  sectionTitle: {
    ...typography.brandSectionTitle,
    color: colors.textPrimary,
    fontSize: 34,
    lineHeight: 40,
    letterSpacing: 0,
  },
  sectionBody: {
    color: colors.textSecondary,
    fontSize: 16,
    lineHeight: 25,
    fontWeight: '600',
    marginTop: 15,
  },
  pointList: {
    gap: 10,
    marginTop: 22,
  },
  pointRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  pointText: {
    color: colors.textPrimary,
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '800',
  },
  watchBand: {
    backgroundColor: '#10141B',
    paddingVertical: 72,
  },
  watchInner: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 18,
  },
  watchInnerCompact: {
    flexDirection: 'column',
  },
  watchPhotoWrap: {
    flex: 1.35,
    minHeight: 430,
    overflow: 'hidden',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'flex-end',
  },
  watchPhoto: {
    borderRadius: radius.sm,
    width: '100%',
    height: '100%',
  },
  watchPhotoFill: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: 'flex-end',
  },
  watchPhotoWrapCompact: {
    flex: 0,
    minHeight: 580,
  },
  watchPhotoCopy: {
    maxWidth: 620,
    padding: 24,
  },
  watchPhotoTitle: {
    color: colors.textPrimary,
    fontSize: 34,
    lineHeight: 40,
    fontWeight: '900',
    letterSpacing: 0,
  },
  watchPhotoBody: {
    color: colors.textSecondary,
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
    marginTop: 12,
  },
  watchDetails: {
    flex: 0.85,
    gap: 12,
  },
  watchDetailsCompact: {
    flex: 0,
  },
  detailRow: {
    flex: 1,
    minHeight: 120,
    flexDirection: 'row',
    gap: 13,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 18,
  },
  detailCopy: {
    flex: 1,
    minWidth: 0,
  },
  detailTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: '900',
    marginBottom: 6,
  },
  detailBody: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
  },
  ctaBand: {
    backgroundColor: colors.background,
    paddingVertical: 72,
  },
  ctaPanel: {
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(21,199,184,0.34)',
    backgroundColor: '#0E1A1D',
    padding: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 24,
  },
  ctaPanelCompact: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  ctaCopy: {
    flex: 1,
    minWidth: 0,
    maxWidth: 720,
  },
  ctaTitle: {
    color: colors.textPrimary,
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '900',
    letterSpacing: 0,
  },
  ctaBody: {
    color: colors.textSecondary,
    fontSize: 15,
    lineHeight: 23,
    fontWeight: '600',
    marginTop: 12,
  },
  ctaActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  ctaActionsCompact: {
    alignItems: 'stretch',
  },
  footer: {
    backgroundColor: '#080A0E',
    paddingVertical: 28,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  footerRowCompact: {
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  footerLogo: {
    width: 126,
    height: 30,
  },
  footerText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  footerLink: {
    color: colors.primaryLight,
    fontSize: 13,
    fontWeight: '900',
  },
});
