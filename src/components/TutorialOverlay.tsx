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
  View,
  Text,
  Modal,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  Animated,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import type { AppThemeName } from '../types';

export type TutorialTier = 'free' | 'pro';

interface Props {
  visible: boolean;
  tier: TutorialTier;
  themeName?: AppThemeName;
  /** Fires when the user taps Skip OR Done. Caller should mark the
   *  AsyncStorage flag completed in BOTH cases — once the user has
   *  seen the tutorial we don't want to re-prompt. */
  onClose: (result: { completed: boolean }) => void;
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
  icon: keyof typeof Ionicons.glyphMap;
  iconColor?: string;
  /** Bold one-liner title. */
  title: string;
  /** 1-3 sentence subtitle describing the section. */
  body: string;
  /** Optional bullet list — usually 2-5 items showing what lives in
   *  this part of the app. */
  bullets?: BulletItem[];
  /** When true, the Next button shows the upgrade copy on the LAST
   *  step for free users. Caller wires onUpgrade. */
  upsell?: boolean;
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

export default function TutorialOverlay({
  visible, tier, themeName, onClose, onUpgrade,
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
      onClose({ completed: true });
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

  const handleUpgrade = () => {
    onClose({ completed: true });
    // Defer onUpgrade to next tick so the modal close animation
    // doesn't fight the paywall presentation.
    setTimeout(() => { onUpgrade?.(); }, 250);
  };

  const isLast = index === steps.length - 1;
  const showUpgradeCTA = isLast && tier === 'free' && steps[index].upsell && !!onUpgrade;

  return (
    <Modal visible={visible} animationType="fade" presentationStyle="overFullScreen" transparent>
      <Animated.View style={[styles.container, { opacity: fade }]}>
        {/* Top bar — Skip + step counter */}
        <View style={styles.topBar}>
          <TouchableOpacity onPress={goSkip} hitSlop={12}>
            <Text style={styles.skipText}>Skip</Text>
          </TouchableOpacity>
          <Text style={styles.counterText}>
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
            <StepView key={i} step={step} tc={tc} styles={styles} />
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
          {showUpgradeCTA ? (
            <>
              <TouchableOpacity style={styles.secondaryBtn} onPress={() => onClose({ completed: true })}>
                <Text style={styles.secondaryBtnText}>Maybe later</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.primaryBtn} onPress={handleUpgrade} activeOpacity={0.85}>
                <Text style={styles.primaryBtnText}>See Pro</Text>
                <Ionicons name="sparkles" size={14} color="#fff" style={{ marginLeft: 6 }} />
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity style={styles.primaryBtn} onPress={goNext} activeOpacity={0.85}>
              <Text style={styles.primaryBtnText}>
                {isLast ? 'Get started' : 'Next'}
              </Text>
              {!isLast && (
                <Ionicons name="chevron-forward" size={16} color="#fff" style={{ marginLeft: 4 }} />
              )}
            </TouchableOpacity>
          )}
        </View>
      </Animated.View>
    </Modal>
  );
}


// ── Step view ─────────────────────────────────────────────────────

function StepView({ step, tc, styles }: { step: Step; tc: any; styles: any }) {
  return (
    <View style={styles.stepFrame}>
      <ScrollView
        contentContainerStyle={styles.stepContent}
        showsVerticalScrollIndicator={false}>
        <View style={[styles.iconBubble, { backgroundColor: (step.iconColor ?? tc.primary) + '22' }]}>
          <Ionicons name={step.icon} size={48} color={step.iconColor ?? tc.primary} />
        </View>
        <Text style={styles.stepTitle}>{step.title}</Text>
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
      </ScrollView>
    </View>
  );
}


// ── Step content ──────────────────────────────────────────────────
//
// Free and pro share the structural intro (welcome, tabs, Apple
// Health). Free ends with a comparison upsell; pro ends with an
// AI-features grid + watch integration.

function buildSteps(tier: TutorialTier, tc: any): Step[] {
  const tabsStep: Step = {
    icon: 'apps-outline',
    title: 'Three tabs, all you need',
    body: 'The whole app fits in three tabs at the bottom. Swipe between them — each one has its own sub-tabs for deeper detail.',
    bullets: [
      { icon: 'barbell-outline', text: 'Workout — your weekly plan, exercise library, training settings', tint: tc.primary },
      { icon: 'restaurant-outline', text: 'Meals — daily plan, food search, supplement stack', tint: tc.success },
      { icon: 'pulse-outline', text: 'Progress — Apple Health vitals, body, PRs, charts', tint: tc.warning },
    ],
  };

  const healthStep: Step = {
    icon: 'heart-outline',
    title: 'Connect Apple Health',
    body: 'Apple Health is optional. Connect it from Account when you want sleep, HRV, weight, and workout context inside Thallo.',
    bullets: [
      { icon: 'moon-outline', text: 'Sleep tracking feeds your readiness score', tint: tc.primary },
      { icon: 'fitness-outline', text: 'Workout calories from your Watch land in Progress', tint: tc.success },
      { icon: 'scale-outline', text: 'Weight trend updates without manual logging', tint: tc.warning },
    ],
  };

  if (tier === 'free') {
    return [
      {
        icon: 'sparkles-outline',
        title: 'Your plan is ready',
        body: 'Thallo built your first weekly workout and meal targets from what you told us. Open the Workout tab to see today\'s session — no AI calls used, every day is yours to keep.',
      },
      tabsStep,
      healthStep,
      {
        icon: 'lock-closed-outline',
        iconColor: tc.warning,
        title: 'On Free, you have',
        body: 'Everything you need to train and eat better. A few coaching superpowers live behind Pro — here\'s the split so you know what\'s where.',
        bullets: [
          { icon: 'checkmark-circle', text: 'Full deterministic workout plan, every week', tint: tc.success },
          { icon: 'checkmark-circle', text: 'Meal plan, food search, hydration, supplements', tint: tc.success },
          { icon: 'checkmark-circle', text: 'Workout tracking, PRs, weight log, Apple Health', tint: tc.success },
          { icon: 'sparkles-outline', text: 'AI Trainer chat — Pro', tint: tc.warning },
          { icon: 'sparkles-outline', text: 'Photo food scan + AI meal plans — Pro', tint: tc.warning },
          { icon: 'sparkles-outline', text: 'In-workout AI coach + form check — Pro', tint: tc.warning },
        ],
        upsell: true,
      },
    ];
  }

  // PRO tier
  return [
    {
      icon: 'sparkles-outline',
      title: 'Welcome to Thallo Pro',
      body: 'Your plan is ready and every AI coaching feature is unlocked. Here\'s a quick tour of what you have access to so nothing stays hidden.',
    },
    tabsStep,
    {
      icon: 'rocket-outline',
      iconColor: tc.primary,
      title: 'Your AI coach is on call',
      body: 'Three places where AI works for you — tap into them whenever you have a question or need a quick adjustment.',
      bullets: [
        { icon: 'chatbubble-ellipses-outline', text: 'Ask Trainer / Ask Coach — chat from the home screen', tint: tc.primary },
        { icon: 'flash-outline', text: 'In-workout coach — questions during a session, form cues, load tweaks', tint: tc.warning },
        { icon: 'camera-outline', text: 'Photo food scan — snap a meal and we\'ll log it', tint: tc.success },
        { icon: 'body-outline', text: 'Body scan — track composition over time', tint: tc.error },
      ],
    },
    {
      icon: 'analytics-outline',
      iconColor: tc.success,
      title: 'Smart adjustments, automatic',
      body: 'Thallo watches your training and eating, then nudges the plan when something needs to change. You\'re always in the driver\'s seat.',
      bullets: [
        { icon: 'shield-checkmark-outline', text: 'Weekly check-in summarizes what worked + what to change', tint: tc.primary },
        { icon: 'pulse-outline', text: 'Recovery tracking adapts loads to fatigue', tint: tc.success },
        { icon: 'leaf-outline', text: 'Gut + longevity nutrition insights', tint: tc.warning },
      ],
    },
    {
      icon: 'watch-outline',
      title: 'Apple Health + Watch',
      body: 'Apple Health and Watch sync are optional enhancements. Connect them when you want more sleep, heart-rate, and workout context in the app.',
      bullets: [
        { icon: 'heart-outline', text: 'Sleep, HRV, RHR feed readiness daily', tint: tc.primary },
        { icon: 'fitness-outline', text: 'Watch tracks heart rate during sessions', tint: tc.warning },
        { icon: 'phone-portrait-outline', text: 'Start workouts from your wrist', tint: tc.success },
      ],
    },
  ];
}


// ── Styles ────────────────────────────────────────────────────────

function createStyles(tc: any) {
  return StyleSheet.create({
    container: {
      flex: 1, backgroundColor: tc.background,
    },
    topBar: {
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
    pager: { flex: 1 },
    stepFrame: {
      width: SCREEN_W,
      paddingHorizontal: 28,
    },
    stepContent: {
      paddingTop: SCREEN_H * 0.04,
      paddingBottom: 30,
      alignItems: 'center',
    },
    iconBubble: {
      width: 96, height: 96, borderRadius: 48,
      alignItems: 'center', justifyContent: 'center',
      marginBottom: 26,
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
