// Post-onboarding tutorial — the first thing a user sees after they
// finish the onboarding form. Tier-aware: free and pro users see
// different step content (free leans on what's available + a soft
// upgrade hint; pro leans on the AI-powered features they unlocked).
//
// Auto-shows once via AsyncStorage flag (`tutorial_v1_completed`).
// Can be replayed manually from Account → "Show tutorial" by clearing
// the flag and reopening.
//
// Pattern: full-screen modal, horizontal swipeable pager, dot
// indicators, Skip on the left + Next/Done on the right. Each step
// renders a hero icon, title, body, and optional list of bullet
// items. Bullets are theme-tinted by category (workout/meals/AI/etc).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  View,
  Text,
  Modal,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  Animated,
  ImageSourcePropType,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { APP_THEMES, THEME_PICKER_ORDER, getContrastingTextColor, getTheme, radius } from '../constants/theme';
import { pexelsPhoto } from '../constants/stockImages';
import {
  HEALTH_PLATFORM_LABEL,
  HEALTH_PLATFORM_PRO_COPY,
  HEALTH_PLATFORM_STATUS_COPY,
} from '../constants/platformHealth';
import type { AppThemeName } from '../types';
import DeviceSyncMockup from './DeviceSyncMockup';

export type TutorialTier = 'free' | 'pro';

interface Props {
  visible: boolean;
  tier: TutorialTier;
  themeName?: AppThemeName;
  /** Fires when the user taps Skip OR Done. Caller should mark the
   *  AsyncStorage flag completed in BOTH cases — once the user has
   *  seen the tutorial we don't want to re-prompt. */
  onClose: (result: { completed: boolean; startLiveTutorial?: boolean }) => void;
  onThemeChange?: (themeName: AppThemeName) => void | Promise<void>;
  onHealthSetup?: () => void | Promise<void>;
  /** Optional — fires when a free user taps the upsell CTA. Caller
   *  routes to the paywall / RevenueCat sheet. Tutorial closes
   *  itself first so the paywall has a clean stage. */
  onUpgrade?: () => void;
}

interface BulletItem {
  icon: keyof typeof Ionicons.glyphMap;
  text: string;
  /** Optional accent color override. Defaults to theme.primary. */
  tint?: string;
}

interface Step {
  /** Hero icon at the top of the step. */
  icon?: keyof typeof Ionicons.glyphMap;
  heroImages?: ImageSourcePropType[];
  deviceShowcase?: boolean;
  iconColor?: string;
  /** Bold one-liner title. */
  title: string;
  /** 1-3 sentence subtitle describing the section. */
  body: string;
  /** Optional bullet list — usually 2-5 items showing what lives in
   *  this part of the app. */
  bullets?: BulletItem[];
  themePicker?: boolean;
  healthSetup?: boolean;
  healthActionLabel?: string;
  upgradeActionLabel?: string;
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const WELCOME_HERO_IMAGES: ImageSourcePropType[] = [
  { uri: pexelsPhoto('5878699', { width: 900, height: 900 }) },
  { uri: pexelsPhoto('30635713', { width: 900, height: 900 }) },
  { uri: pexelsPhoto('32977239', { width: 900, height: 900 }) },
];
const WORKOUT_HERO_IMAGES: ImageSourcePropType[] = [
  { uri: pexelsPhoto('13993018', { width: 900, height: 900 }) },
  { uri: pexelsPhoto('5878699', { width: 900, height: 900 }) },
];
const MEAL_HERO_IMAGES: ImageSourcePropType[] = [
  { uri: pexelsPhoto('30635713', { width: 900, height: 900 }) },
  { uri: pexelsPhoto('30635717', { width: 900, height: 900 }) },
];
const PROGRESS_HERO_IMAGES: ImageSourcePropType[] = [
  { uri: pexelsPhoto('32977239', { width: 900, height: 900 }) },
  { uri: pexelsPhoto('3999644', { width: 900, height: 900 }) },
];

export default function TutorialOverlay({
  visible, tier, themeName, onClose, onThemeChange, onHealthSetup,
  onUpgrade,
}: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const styles = useMemo(() => createStyles(tc), [tc]);

  const steps = useMemo(() => buildSteps(tier, tc), [tier, tc]);

  const [index, setIndex] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const fade = useRef(new Animated.Value(1)).current;

  // Reset to step 0 every time the overlay re-opens. The component
  // stays mounted across opens (Modal hides it instead of unmounting),
  // so without this reset the user lands on whatever step they were
  // on when the modal last closed — which for the "Get started" path
  // means the LAST step. Replaying then shows the final screen and
  // the next tap immediately closes ("first screen then ending"
  // symptom the user reported).
  useEffect(() => {
    if (!visible) return;
    setIndex(0);
    // requestAnimationFrame so the ScrollView has rendered before we
    // tell it to scroll — scrolling before layout silently no-ops.
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ x: 0, animated: false });
    });
  }, [visible]);

  const handleScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const x = e.nativeEvent.contentOffset.x;
    const i = Math.round(x / SCREEN_W);
    if (i !== index) {
      setIndex(i);
      try { Haptics.selectionAsync(); } catch {}
    }
  };

  const goNext = () => {
    if (index >= steps.length - 1) {
      // Last step — Done button completes.
      try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
      onClose({ completed: true, startLiveTutorial: true });
      return;
    }
    const next = index + 1;
    scrollRef.current?.scrollTo({ x: next * SCREEN_W, animated: true });
    setIndex(next);
    try { Haptics.selectionAsync(); } catch {}
  };

  const goSkip = () => {
    try { Haptics.selectionAsync(); } catch {}
    onClose({ completed: true });
  };

  const goUpgrade = () => {
    try { Haptics.selectionAsync(); } catch {}
    onClose({ completed: true });
    onUpgrade?.();
  };

  const isLast = index === steps.length - 1;
  const topBarOnHero = !!steps[index]?.heroImages?.length;
  return (
    <Modal visible={visible} animationType="fade" presentationStyle="overFullScreen" transparent>
      <Animated.View style={[styles.container, { opacity: fade }]}>
        {/* Top bar — Skip + step counter */}
        <View style={styles.topBar}>
          <TouchableOpacity
            testID="tutorial-skip"
            accessibilityLabel="tutorial-skip"
            onPress={goSkip}
            hitSlop={12}>
            <Text style={[styles.skipText, topBarOnHero && styles.topBarTextOnHero]}>Skip</Text>
          </TouchableOpacity>
          <Text style={[styles.counterText, topBarOnHero && styles.topBarTextOnHero]}>
            {index + 1} of {steps.length}
          </Text>
        </View>

        {/* Pager */}
        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={handleScroll}
          style={styles.pager}>
          {steps.map((step, i) => (
            <StepView
              key={i}
              step={step}
              tc={tc}
              currentThemeName={theme.name}
              styles={styles}
              onThemeChange={onThemeChange}
              onHealthSetup={onHealthSetup}
              onUpgrade={onUpgrade ? goUpgrade : undefined}
            />
          ))}
        </ScrollView>

        {/* Dot indicators */}
        <View style={styles.dotsRow}>
          {steps.map((_, i) => (
            <View
              key={i}
              style={[
                styles.dot,
                {
                  backgroundColor: i === index ? tc.primary : tc.border,
                  width: i === index ? 22 : 6,
                },
              ]}
            />
          ))}
        </View>

        {/* Bottom CTA */}
        <View style={styles.ctaRow}>
          <TouchableOpacity
            testID="tutorial-next"
            accessibilityLabel={isLast ? 'tutorial-done' : 'tutorial-next'}
            style={styles.primaryBtn}
            onPress={goNext}
            activeOpacity={0.85}>
            <Text style={styles.primaryBtnText}>
              {isLast ? 'Start live tour' : 'Next'}
            </Text>
            {!isLast && (
              <Ionicons name="chevron-forward" size={16} color="#fff" style={{ marginLeft: 4 }} />
            )}
          </TouchableOpacity>
        </View>
      </Animated.View>
    </Modal>
  );
}


// ── Step view ─────────────────────────────────────────────────────

function StepView({
  step, tc, currentThemeName, styles, onThemeChange, onHealthSetup, onUpgrade,
}: {
  step: Step;
  tc: any;
  currentThemeName: AppThemeName;
  styles: any;
  onThemeChange?: (themeName: AppThemeName) => void | Promise<void>;
  onHealthSetup?: () => void | Promise<void>;
  onUpgrade?: () => void;
}) {
  const hasHeroHeader = !!step.heroImages?.length;
  const [healthBusy, setHealthBusy] = useState(false);
  const handleHealthSetup = async () => {
    if (!onHealthSetup || healthBusy) return;
    setHealthBusy(true);
    try {
      await onHealthSetup();
    } finally {
      setHealthBusy(false);
    }
  };
  return (
    <View style={[styles.stepFrame, hasHeroHeader && styles.heroStepFrame]}>
      <ScrollView
        contentContainerStyle={[styles.stepContent, hasHeroHeader && styles.heroStepContent]}
        showsVerticalScrollIndicator={false}>
        {hasHeroHeader ? (
          <CrossfadeHero images={step.heroImages!} title={step.title} styles={styles} />
        ) : step.deviceShowcase ? (
          <DeviceSyncMockup accent={step.iconColor ?? tc.primary} compact style={styles.deviceShowcase} />
        ) : step.icon ? (
          <View style={[styles.iconBubble, { backgroundColor: (step.iconColor ?? tc.primary) + '22' }]}>
            <Ionicons name={step.icon} size={48} color={step.iconColor ?? tc.primary} />
          </View>
        ) : null}
        <View style={[styles.stepCopyWrap, hasHeroHeader && styles.heroCopyWrap]}>
          {!hasHeroHeader && <Text style={styles.stepTitle}>{step.title}</Text>}
          <Text style={styles.stepBody}>{step.body}</Text>
          {step.bullets && step.bullets.length > 0 && (
            <View style={styles.bulletList}>
              {step.bullets.map((b, i) => (
                <View key={i} style={styles.bulletRow}>
                  <View style={[styles.bulletIcon, { backgroundColor: (b.tint ?? tc.primary) + '22' }]}>
                    <Ionicons name={b.icon} size={16} color={b.tint ?? tc.primary} />
                  </View>
                  <Text style={styles.bulletText}>{b.text}</Text>
                </View>
              ))}
            </View>
          )}
          {step.themePicker && (
            <View style={styles.themeGrid}>
              {THEME_PICKER_ORDER.map((themeName) => {
                const option = APP_THEMES[themeName];
                const selected = option.name === currentThemeName;
                return (
                  <TouchableOpacity
                    key={option.name}
                    activeOpacity={0.82}
                    accessibilityRole="button"
                    accessibilityLabel={`tutorial-theme-${option.name}`}
                    accessibilityState={{ selected }}
                    style={[
                      styles.themeOption,
                      {
                        backgroundColor: option.colors.surface,
                        borderColor: selected ? option.colors.primary : option.colors.border,
                      },
                    ]}
                    onPress={() => {
                      if (selected) return;
                      try { Haptics.selectionAsync(); } catch {}
                      onThemeChange?.(option.name);
                    }}>
                    <View style={styles.themeOptionTop}>
                      <Text
                        numberOfLines={1}
                        adjustsFontSizeToFit
                        minimumFontScale={0.82}
                        style={[styles.themeOptionName, { color: option.colors.textPrimary }]}>
                        {option.label}
                      </Text>
                      {selected && (
                        <View style={[styles.themeCheck, { backgroundColor: option.colors.primary }]}>
                          <Ionicons
                            name="checkmark"
                            size={12}
                            color={getContrastingTextColor(option.colors.primary)}
                          />
                        </View>
                      )}
                    </View>
                    <View style={styles.themeSwatchRow}>
                      <View style={[styles.themeSwatch, { backgroundColor: option.colors.background, borderColor: option.colors.border }]} />
                      <View style={[styles.themeSwatch, { backgroundColor: option.colors.surfaceRaised, borderColor: option.colors.border }]} />
                      <View style={[styles.themeSwatch, { backgroundColor: option.colors.primary, borderColor: option.colors.border }]} />
                      <View style={[styles.themeSwatch, { backgroundColor: option.colors.accent, borderColor: option.colors.border }]} />
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
          {step.healthSetup && onHealthSetup && (
            <TouchableOpacity
              testID="tutorial-health-setup"
              accessibilityRole="button"
              accessibilityLabel="tutorial-health-setup"
              activeOpacity={0.86}
              disabled={healthBusy}
              onPress={handleHealthSetup}
              style={[styles.stepActionButton, { backgroundColor: tc.primary }]}>
              {healthBusy ? (
                <ActivityIndicator color={getContrastingTextColor(tc.primary)} />
              ) : (
                <>
                  <Ionicons
                    name={Platform.OS === 'android' ? 'fitness-outline' : 'heart-outline'}
                    size={17}
                    color={getContrastingTextColor(tc.primary)}
                  />
                  <Text style={[styles.stepActionText, { color: getContrastingTextColor(tc.primary) }]}>
                    {step.healthActionLabel ?? `Set up ${HEALTH_PLATFORM_LABEL}`}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          )}
          {step.upgradeActionLabel && onUpgrade && (
            <TouchableOpacity
              testID="tutorial-upgrade"
              accessibilityRole="button"
              accessibilityLabel="tutorial-upgrade"
              activeOpacity={0.86}
              onPress={onUpgrade}
              style={styles.upgradeActionButton}>
              <Ionicons name="sparkles-outline" size={17} color={tc.primary} />
              <Text style={styles.upgradeActionText}>{step.upgradeActionLabel}</Text>
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function CrossfadeHero({
  images, title, styles,
}: {
  images: ImageSourcePropType[];
  title: string;
  styles: any;
}) {
  const activeIndexRef = useRef(0);
  const animationRef = useRef<Animated.CompositeAnimation | null>(null);
  const opacitiesRef = useRef<Animated.Value[]>([]);

  if (opacitiesRef.current.length !== images.length) {
    opacitiesRef.current = images.map((_, i) => new Animated.Value(i === 0 ? 1 : 0));
  }

  useEffect(() => {
    activeIndexRef.current = 0;
    opacitiesRef.current.forEach((opacity, i) => {
      opacity.setValue(i === 0 ? 1 : 0);
    });
  }, [images.length]);

  useEffect(() => {
    if (images.length < 2) return;
    const timer = setInterval(() => {
      const current = activeIndexRef.current;
      const upcoming = (current + 1) % images.length;
      const opacities = opacitiesRef.current;
      animationRef.current?.stop();
      opacities[upcoming].setValue(0);
      animationRef.current = Animated.parallel([
        Animated.timing(opacities[current], {
          toValue: 0,
          duration: 760,
          useNativeDriver: true,
        }),
        Animated.timing(opacities[upcoming], {
          toValue: 1,
          duration: 760,
          useNativeDriver: true,
        }),
      ]);
      animationRef.current.start(({ finished }) => {
        if (!finished) return;
        activeIndexRef.current = upcoming;
        opacities.forEach((opacity, i) => {
          opacity.setValue(i === upcoming ? 1 : 0);
        });
      });
    }, 3200);
    return () => {
      clearInterval(timer);
      animationRef.current?.stop();
    };
  }, [images.length]);

  return (
    <View style={styles.heroHeader}>
      {images.map((image, i) => (
        <Animated.Image
          key={i}
          source={image}
          resizeMode="cover"
          style={[styles.heroHeaderImage, { opacity: opacitiesRef.current[i] }]}
        />
      ))}
      <LinearGradient
        colors={['rgba(5,10,14,0.12)', 'rgba(5,10,14,0.36)', 'rgba(5,10,14,0.78)']}
        locations={[0, 0.48, 1]}
        start={{ x: 0.12, y: 0 }}
        end={{ x: 0.88, y: 1 }}
        style={styles.heroHeaderShade}
      />
      <View style={styles.heroHeaderCopy}>
        <Text style={styles.heroEyebrow}>Thallo</Text>
        <Text style={styles.heroTitle}>{title}</Text>
      </View>
    </View>
  );
}


// ── Step content ──────────────────────────────────────────────────
//
// Free and pro share the same short structure: welcome, theme, health
// setup. The copy branches so Free users see manual-tracking language
// while Pro users see generated-plan and connected-health language.

function buildSteps(tier: TutorialTier, tc: any): Step[] {
  const planCopy = tier === 'pro'
    ? 'Your full system is ready. Pick your look, connect optional health signals, then we will walk through Today, workouts, meals, progress, and the ways you can customize the app.'
    : 'Free is ready for workouts, nutrition, or both. Pick your look, review optional health setup, then we will walk through Today, workouts, meals, and progress.';
  const welcomeStep: Step = {
    heroImages: WELCOME_HERO_IMAGES,
    title: 'Welcome to Thallo',
    body: `${planCopy} Thallo can be a complete strength, cardio, nutrition, recovery, supplement, and health dashboard, or a focused tracker for the pieces you actually use.`,
    bullets: tier === 'pro'
      ? [
        { icon: 'calendar-outline', text: 'Follow the guided PlanWeek, log your own program, or mix both.', tint: tc.primary },
        { icon: 'restaurant-outline', text: 'Use meal guidance, manual food logs, hydration, routines, and supplements together.', tint: tc.success },
        { icon: 'options-outline', text: 'Prefer only workouts or only nutrition? Your dashboard can hide the rest.', tint: tc.warning },
      ]
      : [
        { icon: 'play-outline', text: 'Start custom strength or cardio workouts and save repeat sessions as templates.', tint: tc.primary },
        { icon: 'restaurant-outline', text: 'Log meals, hydration, supplements, weight, and progress manually.', tint: tc.success },
        { icon: 'options-outline', text: 'Use workouts only, nutrition only, or both from Settings.', tint: tc.warning },
      ],
  };
  const todayStep: Step = {
    icon: 'home-outline',
    iconColor: tc.primary,
    title: 'Today is your home base',
    body: tier === 'pro'
      ? 'The Today page gives you the next workout action, current macro targets, hydration, sleep, goal, nutrition, and readiness without digging through every tab.'
      : 'The Today page still works in manual mode: start a custom workout, log a meal, add water, and see your macro goals from one clean daily view.',
    bullets: tier === 'pro'
      ? [
        { icon: 'barbell-outline', text: 'Start or resume today’s planned workout from the top card.', tint: tc.primary },
        { icon: 'restaurant-outline', text: 'Log meals and see the same adjusted macro goals used by Meals.', tint: tc.success },
        { icon: 'moon-outline', text: 'Tap sleep or readiness when you want the deeper Progress context.', tint: tc.warning },
      ]
      : [
        { icon: 'add-circle-outline', text: 'Free and manual accounts get a custom-workout start point instead of an empty plan card.', tint: tc.primary },
        { icon: 'restaurant-outline', text: 'Use Log meal and quick water from Today before opening the full Meals tab.', tint: tc.success },
        { icon: 'analytics-outline', text: 'Macro targets stay visible even when you are logging everything manually.', tint: tc.warning },
      ],
  };
  const workoutStep: Step = {
    heroImages: WORKOUT_HERO_IMAGES,
    title: tier === 'pro' ? 'Guided plan or your own program' : 'Workouts stay flexible',
    body: tier === 'pro'
      ? 'Thallo builds a structured 7-day PlanWeek from your goal, schedule, equipment, and limits. You can follow it, run custom strength or cardio sessions, assign templates, swap exercises, or keep your own routine.'
      : 'Free gives you the workout tracker first: start custom strength or cardio sessions, save and share templates, import detected workouts, and build useful history before turning on generated planning.',
    bullets: tier === 'pro'
      ? [
        { icon: 'calendar-number-outline', text: 'Past days show done or skipped; future days stay queued until the week renews.', tint: tc.primary },
        { icon: 'bookmark-outline', text: 'Create templates, assign them to the week, or share template codes and bundles.', tint: tc.warning },
        { icon: 'timer-outline', text: 'Rest timers, set logging, warmups, cardio, and workout resume all live in the same flow.', tint: tc.success },
      ]
      : [
        { icon: 'create-outline', text: 'Log your own program with sets, reps, weight, notes, and timers.', tint: tc.primary },
        { icon: 'albums-outline', text: 'Save repeated workouts as templates, then reuse or share them.', tint: tc.success },
        { icon: 'trending-up-outline', text: 'Progress history starts filling in as soon as you log sessions.', tint: tc.warning },
      ],
  };
  const mealStep: Step = {
    heroImages: MEAL_HERO_IMAGES,
    title: tier === 'pro' ? 'Nutrition can stand alone' : 'Meals are easy to log',
    body: tier === 'pro'
      ? 'Use generated meal guidance, photo scans, food search, hydration, supplements, routines, and scoring to understand how today supports your goal. If you only want nutrition, hide workouts and keep the food tools front and center.'
      : 'Manual meal logging, hydration, supplements, favorites, routines, and weight tracking are available right away. Pro adds generated nutrition guidance, photo scans, and meal scoring.',
    bullets: tier === 'pro'
      ? [
        { icon: 'scan-outline', text: 'Scan food photos when typing would slow you down.', tint: tc.primary },
        { icon: 'water-outline', text: 'Hydration, saved meals, grocery lists, supplements, and routines sit beside the daily plan.', tint: tc.success },
        { icon: 'analytics-outline', text: 'Meal scores show how logged food supports your goal for the day.', tint: tc.warning },
      ]
      : [
        { icon: 'restaurant-outline', text: 'Track meals, hydration, supplements, and body weight manually.', tint: tc.success },
        { icon: 'bookmark-outline', text: 'Reuse favorites and common meals to keep logging quick.', tint: tc.primary },
        { icon: 'lock-closed-outline', text: 'Pro unlocks generated nutrition guidance, scans, and meal scores.', tint: tc.warning },
      ],
    upgradeActionLabel: tier === 'free' ? 'See Pro options' : undefined,
  };
  const progressStep: Step = {
    heroImages: PROGRESS_HERO_IMAGES,
    title: 'Progress has context',
    body: tier === 'pro'
      ? 'Recovery, readiness, health signals, body trends, strength, cardio, nutrition, and weekly reviews help explain what changed instead of just showing another chart.'
      : 'Progress starts with the workouts, meals, weight, and body entries you log. Pro layers in readiness, Apple Health signals, scans, and deeper insight cards.',
    bullets: [
      { icon: 'body-outline', text: 'Muscle recovery shows which areas are ready, loaded, or due for lighter work.', tint: tc.primary },
      { icon: 'pulse-outline', text: 'Sleep, HRV, resting heart rate, steps, and activity can support readiness when connected.', tint: tc.success },
      { icon: 'people-outline', text: 'Friends only see workout activity you share, never calories, macros, or weight.', tint: tc.warning },
    ],
    upgradeActionLabel: tier === 'free' ? 'Explore Pro insights' : undefined,
  };
  const watchStep: Step | null = Platform.OS === 'ios'
    ? {
      deviceShowcase: true,
      iconColor: tc.primary,
      title: 'iPhone and Apple Watch stay together',
      body: tier === 'pro'
        ? 'Start on your phone or wrist, then keep workouts, rest timers, meals, hydration, sleep, readiness, and quick actions in sync when a compatible Apple Watch is paired.'
        : 'Manual tracking starts on your phone. When you use Thallo with a compatible Apple Watch, core workout and quick-log surfaces can mirror the day without turning the Watch into the source of truth.',
      bullets: [
        { icon: 'phone-portrait-outline', text: 'The phone remains the main dashboard for planning, editing, history, and review.', tint: tc.primary },
        { icon: 'watch-outline', text: 'The Watch companion keeps active workouts, rest, hydration, meals, and readiness close by.', tint: tc.success },
        { icon: 'sync-outline', text: 'Phone data wins on conflicts, so the weekly plan and logs stay consistent.', tint: tc.warning },
      ],
    }
    : null;
  const themeStep: Step = {
    icon: 'color-palette-outline',
    title: 'Choose your theme',
    body: 'Pick the look you want before you start. You can change this later from Account and Settings.',
    themePicker: true,
  };
  const healthStep: Step = {
    icon: Platform.OS === 'android' ? 'fitness-outline' : 'heart-outline',
    iconColor: tc.success,
    title: Platform.OS === 'android' ? 'Set Up Health Connect' : 'Connect Apple Health',
    body: tier === 'free'
      ? `Free works with manual logs and in-app tracking. ${HEALTH_PLATFORM_PRO_COPY}`
      : Platform.OS === 'android'
        ? HEALTH_PLATFORM_STATUS_COPY
        : 'Apple Health is optional. Connect it now or later when you want available iPhone, Apple Watch, or source-app data to help power recovery and progress.',
    bullets: tier === 'free'
      ? [
        { icon: 'create-outline', text: 'Manual workouts, meals, weight, and body history still work normally.', tint: tc.primary },
        { icon: 'lock-closed-outline', text: HEALTH_PLATFORM_PRO_COPY, tint: tc.warning },
        { icon: 'settings-outline', text: `Find ${HEALTH_PLATFORM_LABEL} from Account and Settings later.`, tint: tc.textMuted },
      ]
      : Platform.OS === 'android'
        ? [
          { icon: 'fitness-outline', text: 'Health Connect is the Android path for sleep, activity, weight, and nutrition signals.', tint: tc.primary },
          { icon: 'construct-outline', text: 'Android health sync is planned; manual logs and in-app workouts still keep Thallo useful today.', tint: tc.warning },
          { icon: 'settings-outline', text: `Check ${HEALTH_PLATFORM_LABEL} status from Account and Settings.`, tint: tc.textMuted },
        ]
        : [
          { icon: 'moon-outline', text: 'Sleep, HRV, resting heart rate, steps, and activity appear only when Apple Health has samples for them.', tint: tc.primary },
          { icon: 'fitness-outline', text: 'Imported workouts and completed Thallo sessions can sync with Apple Health.', tint: tc.success },
          { icon: 'shield-checkmark-outline', text: 'Raw samples stay on device; daily summaries may sync for trends across devices.', tint: tc.warning },
        ],
    healthSetup: true,
    healthActionLabel: tier === 'free'
      ? 'Review health features'
      : Platform.OS === 'android'
        ? 'View Health Connect'
        : 'Connect Apple Health',
  };
  return [
    welcomeStep,
    todayStep,
    workoutStep,
    mealStep,
    progressStep,
    ...(watchStep ? [watchStep] : []),
    themeStep,
    healthStep,
  ];
}


// ── Styles ────────────────────────────────────────────────────────

function createStyles(tc: any) {
  return StyleSheet.create({
    container: {
      flex: 1, backgroundColor: tc.background,
    },
    topBar: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 3,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 22, paddingTop: 60, paddingBottom: 8,
    },
    skipText: {
      fontSize: 14, fontWeight: '600',
      color: tc.textSecondary,
    },
    counterText: {
      fontSize: 11, fontWeight: '700', letterSpacing: 1,
      color: tc.textMuted,
    },
    topBarTextOnHero: {
      color: '#FFFFFF',
      textShadowColor: 'rgba(0,0,0,0.45)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 6,
    },
    pager: { flex: 1 },
    stepFrame: {
      width: SCREEN_W,
      paddingHorizontal: 28,
    },
    heroStepFrame: {
      paddingHorizontal: 0,
    },
    stepContent: {
      paddingTop: 100,
      paddingBottom: 30,
      alignItems: 'center',
    },
    heroStepContent: {
      paddingTop: 0,
    },
    stepCopyWrap: {
      width: '100%',
      alignItems: 'center',
    },
    heroCopyWrap: {
      paddingHorizontal: 28,
    },
    iconBubble: {
      width: 96, height: 96, borderRadius: 48,
      alignItems: 'center', justifyContent: 'center',
      marginBottom: 26,
    },
    deviceShowcase: {
      marginBottom: 22,
    },
    heroHeader: {
      width: '100%',
      height: Math.max(270, SCREEN_H * 0.35),
      marginBottom: 26,
      overflow: 'hidden',
      backgroundColor: '#111827',
    },
    heroHeaderImage: {
      ...StyleSheet.absoluteFillObject,
      width: '100%',
      height: '100%',
    },
    heroHeaderImageOverlay: {
      zIndex: 1,
    },
    heroHeaderShade: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 2,
      backgroundColor: 'rgba(0,0,0,0.34)',
    },
    heroHeaderCopy: {
      position: 'absolute',
      left: 28,
      right: 28,
      bottom: 28,
      zIndex: 3,
    },
    heroEyebrow: {
      fontSize: 11,
      lineHeight: 14,
      fontWeight: '900',
      letterSpacing: 1.1,
      textTransform: 'uppercase',
      color: 'rgba(255,255,255,0.76)',
      marginBottom: 6,
    },
    heroTitle: {
      fontSize: 34,
      lineHeight: 39,
      fontWeight: '900',
      color: '#FFFFFF',
      textShadowColor: 'rgba(0,0,0,0.45)',
      textShadowOffset: { width: 0, height: 2 },
      textShadowRadius: 10,
    },
    stepTitle: {
      fontSize: 26, fontWeight: '900',
      color: tc.textPrimary, textAlign: 'center',
      lineHeight: 32, marginBottom: 14,
    },
    stepBody: {
      fontSize: 15, lineHeight: 22,
      color: tc.textSecondary, textAlign: 'center',
      paddingHorizontal: 4, marginBottom: 22,
    },
    bulletList: {
      width: '100%', gap: 10,
    },
    bulletRow: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      backgroundColor: tc.surface,
      borderRadius: 12, padding: 12,
      borderWidth: 1, borderColor: tc.border,
    },
    bulletIcon: {
      width: 32, height: 32, borderRadius: 16,
      alignItems: 'center', justifyContent: 'center',
    },
    bulletText: {
      flex: 1, fontSize: 13, lineHeight: 18,
      color: tc.textPrimary, fontWeight: '600',
    },
    themeGrid: {
      width: '100%',
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 10,
    },
    themeOption: {
      width: '48%',
      minHeight: 86,
      borderWidth: 1.5,
      borderRadius: radius.sm,
      padding: 10,
      gap: 10,
    },
    themeOptionTop: {
      minHeight: 20,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    themeOptionName: {
      flex: 1,
      fontSize: 12,
      fontWeight: '800',
    },
    themeCheck: {
      width: 20,
      height: 20,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    themeSwatchRow: {
      flexDirection: 'row',
      gap: 5,
    },
    themeSwatch: {
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 1,
    },
    stepActionButton: {
      width: '100%',
      minHeight: 50,
      marginTop: 14,
      borderRadius: radius.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingHorizontal: 16,
    },
    stepActionText: {
      fontSize: 14,
      fontWeight: '900',
    },
    upgradeActionButton: {
      width: '100%',
      minHeight: 48,
      marginTop: 12,
      borderRadius: radius.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingHorizontal: 16,
      backgroundColor: tc.primary + '14',
      borderWidth: 1,
      borderColor: tc.primary + '55',
    },
    upgradeActionText: {
      fontSize: 14,
      fontWeight: '900',
      color: tc.primary,
    },
    dotsRow: {
      flexDirection: 'row', justifyContent: 'center',
      alignItems: 'center', gap: 6,
      paddingTop: 8, paddingBottom: 8,
    },
    dot: {
      height: 6, borderRadius: 3,
    },
    ctaRow: {
      flexDirection: 'row', gap: 10,
      paddingHorizontal: 22, paddingTop: 12, paddingBottom: 36,
    },
    primaryBtn: {
      flex: 1, flexDirection: 'row',
      alignItems: 'center', justifyContent: 'center',
      paddingVertical: 16, borderRadius: 14,
      backgroundColor: tc.primary,
    },
    primaryBtnText: {
      color: getContrastingTextColor(tc.primary), fontSize: 15, fontWeight: '800',
      letterSpacing: 0.3,
    },
    secondaryBtn: {
      paddingHorizontal: 18, paddingVertical: 16,
      borderRadius: 14, backgroundColor: tc.surface,
      borderWidth: 1, borderColor: tc.border,
      alignItems: 'center', justifyContent: 'center',
    },
    secondaryBtnText: {
      color: tc.textSecondary, fontSize: 14, fontWeight: '700',
    },
  });
}
