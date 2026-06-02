import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import { HEALTH_PLATFORM_LABEL, HEALTH_PLATFORM_PRO_COPY } from '../constants/platformHealth';
import type { AppThemeName } from '../types';
import type { HomeTabKey } from '../utils/hiddenSurfaces';

interface Props {
  visible: boolean;
  tabs: HomeTabKey[];
  tier: 'free' | 'pro';
  themeName?: AppThemeName;
  onNavigateTab: (tab: HomeTabKey) => void;
  onClose: (result: { completed: boolean }) => void;
}

interface Step {
  id: string;
  tab: HomeTabKey;
  eyebrow: string;
  title: string;
  body: string;
  actions: ActionItem[];
}

interface ActionItem {
  icon: keyof typeof Ionicons.glyphMap;
  text: string;
}

export default function LiveTutorialOverlay({
  visible,
  tabs,
  tier,
  themeName,
  onNavigateTab,
  onClose,
}: Props) {
  const insets = useSafeAreaInsets();
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const styles = useMemo(() => createStyles(tc), [tc]);
  const [index, setIndex] = useState(0);
  const lastNavigatedTabRef = useRef<HomeTabKey | null>(null);

  const steps = useMemo<Step[]>(() => (
    buildSteps(tabs, tier)
  ), [tabs, tier]);

  useEffect(() => {
    if (!visible) {
      lastNavigatedTabRef.current = null;
      return;
    }
    setIndex(0);
  }, [visible, tabs]);

  const current = steps[Math.min(index, Math.max(steps.length - 1, 0))];

  useEffect(() => {
    if (!visible || !current) return;
    if (lastNavigatedTabRef.current === current.tab) return;
    lastNavigatedTabRef.current = current.tab;
    onNavigateTab(current.tab);
  }, [current, onNavigateTab, visible]);

  if (!visible || !current) return null;

  const navBottom = Math.max(insets.bottom, 10);
  const isLast = index >= steps.length - 1;

  const close = (completed: boolean) => {
    try {
      completed
        ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
        : Haptics.selectionAsync();
    } catch {}
    onClose({ completed });
  };

  const goNext = () => {
    if (isLast) {
      close(true);
      return;
    }
    try { Haptics.selectionAsync(); } catch {}
    setIndex(i => Math.min(i + 1, steps.length - 1));
  };

  const goBack = () => {
    if (index <= 0) return;
    try { Haptics.selectionAsync(); } catch {}
    setIndex(i => Math.max(0, i - 1));
  };

  return (
    <Modal visible={visible} animationType="fade" presentationStyle="overFullScreen" transparent>
      <View style={styles.scrim}>
        <View style={[styles.card, { bottom: navBottom + 82 }]}>
          <View style={styles.cardHeader}>
            <View style={styles.titleWrap}>
              <Text style={styles.kicker}>{current.eyebrow}</Text>
              <Text style={styles.title}>{current.title}</Text>
            </View>
            <TouchableOpacity
              accessibilityLabel="live-tutorial-close"
              hitSlop={10}
              onPress={() => close(false)}
              style={styles.closeBtn}>
              <Ionicons name="close" size={18} color={tc.textSecondary} />
            </TouchableOpacity>
          </View>

          <Text style={styles.body}>{current.body}</Text>

          <View style={styles.actionList}>
            {current.actions.map((action, actionIndex) => (
              <View key={`${current.title}-${actionIndex}`} style={styles.actionRow}>
                <View style={[styles.actionIcon, { backgroundColor: tc.primary + '18' }]}>
                  <Ionicons name={action.icon} size={16} color={tc.primary} />
                </View>
                <Text style={styles.actionText}>{action.text}</Text>
              </View>
            ))}
          </View>

          <View style={styles.progressRow}>
            {steps.map((step, i) => (
              <View
                key={step.id}
                style={[
                  styles.dot,
                  {
                    width: i === index ? 22 : 6,
                    backgroundColor: i === index ? tc.primary : tc.border,
                  },
                ]}
              />
            ))}
          </View>

          <View style={styles.actions}>
            <TouchableOpacity
              accessibilityLabel="live-tutorial-back"
              disabled={index === 0}
              onPress={goBack}
              style={[styles.secondaryBtn, index === 0 && styles.disabledBtn]}>
              <Ionicons name="chevron-back" size={16} color={tc.textSecondary} />
              <Text style={styles.secondaryText}>Back</Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityLabel={isLast ? 'live-tutorial-done' : 'live-tutorial-next'}
              onPress={goNext}
              activeOpacity={0.86}
              style={[styles.primaryBtn, { backgroundColor: tc.primary }]}>
              <Text
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.82}
                style={[styles.primaryText, { color: getContrastingTextColor(tc.primary) }]}>
                {isLast ? 'Done' : `Show ${steps[index + 1]?.title ?? 'Next'}`}
              </Text>
              <Ionicons
                name={isLast ? 'checkmark' : 'chevron-forward'}
                size={16}
                color={getContrastingTextColor(tc.primary)}
              />
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function buildSteps(tabs: HomeTabKey[], tier: 'free' | 'pro'): Step[] {
  const available = new Set(tabs);
  const steps: Step[] = [];

  if (available.has('today')) {
    steps.push({
      id: 'today-overview',
      tab: 'today',
      eyebrow: 'Live tutorial',
      title: 'Today',
      body: tier === 'pro'
        ? 'This is the daily landing page for the whole system: guided workouts, custom sessions, meals, hydration, sleep, goal, nutrition, and readiness all branch from here.'
        : 'This is the daily landing page for manual tracking too: start a custom workout, log meals, add water, and keep macro goals visible.',
      actions: tier === 'pro'
        ? [
          { icon: 'barbell-outline', text: 'The top card starts, resumes, or summarizes the workout for today.' },
          { icon: 'restaurant-outline', text: 'Use Log meal, routines, hydration, and macro cards to keep nutrition current.' },
          { icon: 'options-outline', text: 'Only using workouts or nutrition? Hidden surfaces keep Today focused.' },
        ]
        : [
          { icon: 'add-circle-outline', text: 'Empty or free workout days show a custom workout start point.' },
          { icon: 'restaurant-outline', text: 'Log meals manually and watch the macro snapshot fill in.' },
          { icon: 'water-outline', text: 'Quick-add water without leaving the home page.' },
        ],
    });
  }

  if (available.has('workout')) {
    steps.push({
      id: 'workouts-overview',
      tab: 'workout',
      eyebrow: 'Live tutorial',
      title: 'Workouts',
      body: tier === 'pro'
        ? 'Use this tab as your training cockpit: guided PlanWeeks, custom strength and cardio sessions, templates, exercise search, and practical changes all branch from here.'
        : 'Use this tab to start custom strength or cardio workouts, reuse saved templates, and browse exercises without needing a generated plan.',
      actions: tier === 'pro'
        ? [
          { icon: 'calendar-outline', text: 'Review today in the weekly PlanWeek without regenerating the rest of the week.' },
          { icon: 'play-outline', text: 'Start the guided workout, a custom workout, or a cardio session whenever you train.' },
          { icon: 'bookmark-outline', text: 'Create, assign, import, and share workout templates or bundles.' },
        ]
        : [
          { icon: 'play-outline', text: 'Start a custom workout whenever you train.' },
          { icon: 'bookmark-outline', text: 'Save repeat sessions as templates for faster logging and sharing.' },
          { icon: 'search-outline', text: 'Use the exercise library when you need to build or adjust a session.' },
        ],
    });
    steps.push({
      id: 'workouts-starting',
      tab: 'workout',
      eyebrow: 'Training flow',
      title: 'Starting A Workout',
      body: 'Once a session starts, Thallo switches into the active workout tracker so you can log sets, cardio work, rest, and notes without losing plan context.',
      actions: [
        { icon: 'timer-outline', text: 'Track working sets and rest timers from the active workout screen.' },
        { icon: tier === 'pro' ? 'sparkles-outline' : 'barbell-outline', text: tier === 'pro' ? 'Use the in-workout coach for cues, form questions, and load tweaks.' : 'Free tracking keeps sets, reps, weights, and workout history organized.' },
        { icon: 'swap-horizontal-outline', text: 'Use Switch Day or exercise swaps when the plan needs a practical adjustment.' },
      ],
    });
  }

  if (available.has('meals')) {
    steps.push({
      id: 'meals-overview',
      tab: 'meals',
      eyebrow: 'Nutrition flow',
      title: 'Meals',
      body: 'This tab can be a complete nutrition hub on its own: food, hydration, saved meals, routines, supplements, macros, and weight-aware context stay together.',
      actions: [
        { icon: 'add-circle-outline', text: 'Add foods from the Foods view when you eat something off-plan.' },
        { icon: tier === 'pro' ? 'camera-outline' : 'restaurant-outline', text: tier === 'pro' ? 'Scan a plate with the camera when you want a faster meal log.' : 'Log meals manually and reuse favorites for faster repeat days.' },
        { icon: 'water-outline', text: 'Use quick-add hydration and saved routines for the habits you repeat.' },
      ],
    });
    steps.push({
      id: 'meals-adding',
      tab: 'meals',
      eyebrow: 'Meal logging',
      title: 'Adding Meals',
      body: 'If the plan is missing something, add it directly. Thallo keeps day totals, favorites, routines, and history in sync from the food you actually logged.',
      actions: [
        { icon: 'search-outline', text: 'Search foods, adjust portions, and save the meal once the plate matches reality.' },
        { icon: 'repeat-outline', text: 'Turn frequent breakfasts, snacks, or supplements into routines.' },
        { icon: 'analytics-outline', text: 'Check the macro snapshot to see what is still left for the day.' },
      ],
    });
  }

  if (available.has('progress')) {
    steps.push({
      id: 'progress-overview',
      tab: 'progress',
      eyebrow: 'Review loop',
      title: 'Progress',
      body: 'Progress is the long view for strength, cardio, nutrition, body metrics, readiness, health trends, and the history behind your choices.',
      actions: [
        { icon: 'trending-up-outline', text: 'Watch strength, body, nutrition, and readiness trends over time.' },
        { icon: 'trophy-outline', text: 'Review PRs and workout history after completed sessions.' },
        { icon: tier === 'pro' ? 'heart-outline' : 'lock-closed-outline', text: tier === 'pro' ? `Open Health in Progress to connect ${HEALTH_PLATFORM_LABEL} and review sleep, HRV, weight, and activity signals.` : `Free keeps manual progress history. ${HEALTH_PLATFORM_PRO_COPY}` },
      ],
    });
  }

  if (available.has('friends')) {
    steps.push({
      id: 'social-overview',
      tab: 'friends',
      eyebrow: 'Social boundary',
      title: 'Social',
      body: 'Social is intentionally focused: share workout activity and templates while calories, macros, body stats, and weight stay private.',
      actions: [
        { icon: 'people-outline', text: 'Find friends and keep up with training activity.' },
        { icon: 'bookmark-outline', text: 'Share individual workout templates or bundles when someone wants your routine.' },
        { icon: 'shield-checkmark-outline', text: 'Nutrition, body weight, and macro details never cross this boundary.' },
      ],
    });
  }

  return steps.length > 0 ? steps : [{
    id: 'progress-fallback',
    tab: 'progress',
    eyebrow: 'Live tutorial',
    title: 'Progress',
    body: 'Progress collects the long-term record of what you log in Thallo.',
    actions: [
      { icon: 'trending-up-outline', text: 'Review workouts, body stats, and trends as your history grows.' },
    ],
  }];
}

function createStyles(tc: ReturnType<typeof getTheme>['colors']) {
  return StyleSheet.create({
    scrim: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.46)',
    },
    card: {
      position: 'absolute',
      left: 16,
      right: 16,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: tc.border,
      backgroundColor: tc.surfaceRaised,
      padding: 16,
      shadowColor: '#000',
      shadowOpacity: 0.22,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 10 },
      elevation: 18,
    },
    cardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    titleWrap: {
      flex: 1,
      minWidth: 0,
    },
    kicker: {
      fontSize: 10,
      lineHeight: 13,
      fontWeight: '900',
      textTransform: 'uppercase',
      letterSpacing: 0.8,
      color: tc.textMuted,
    },
    title: {
      fontSize: 20,
      lineHeight: 25,
      fontWeight: '900',
      color: tc.textPrimary,
      marginTop: 1,
    },
    closeBtn: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: tc.surface,
      borderWidth: 1,
      borderColor: tc.border,
    },
    body: {
      marginTop: 14,
      fontSize: 14,
      lineHeight: 20,
      color: tc.textSecondary,
    },
    actionList: {
      gap: 9,
      marginTop: 14,
    },
    actionRow: {
      minHeight: 42,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: radius.md,
      backgroundColor: tc.surface,
      borderWidth: 1,
      borderColor: tc.border,
    },
    actionIcon: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    actionText: {
      flex: 1,
      minWidth: 0,
      fontSize: 12,
      lineHeight: 17,
      fontWeight: '700',
      color: tc.textPrimary,
    },
    progressRow: {
      flexDirection: 'row',
      gap: 6,
      alignItems: 'center',
      marginTop: 16,
    },
    dot: {
      height: 6,
      borderRadius: 3,
    },
    actions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginTop: 16,
    },
    secondaryBtn: {
      minHeight: 44,
      paddingHorizontal: 12,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: tc.border,
      backgroundColor: tc.surface,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
    },
    disabledBtn: {
      opacity: 0.42,
    },
    secondaryText: {
      fontSize: 13,
      fontWeight: '800',
      color: tc.textSecondary,
    },
    primaryBtn: {
      flex: 1,
      minHeight: 44,
      paddingHorizontal: 14,
      borderRadius: radius.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
    },
    primaryText: {
      fontSize: 14,
      fontWeight: '900',
    },
  });
}
