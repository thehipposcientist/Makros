import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Modal, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import PressableScale from '../PressableScale';
import { APP_THEMES, colors as baseColors, getTheme, radius } from '../../constants/theme';
import type { AdjustedDailyTarget, HydrationStatus } from '../../services/api';
import { humanizeToken } from '../../utils/exerciseGuide';
import {
  HYDRATION_QUICK_ADD_OUNCES,
  formatHydrationQuickAddLabel,
  formatHydrationTargetRange,
  hydrationTargetRangeOz,
} from '../../utils/hydration';
import { darkPhotoBaseForColors, hexWithAlpha } from '../../utils/photoCardChrome';
import mealStyles from '../../screens/meals/mealScreenStyles';

type HydrationSummary = HydrationStatus;
const DEFAULT_MEALS_ACCENT = APP_THEMES.aurora.sections.meals.strong;

export type DailyTargetAdjustmentBannerInfo = {
  detail: string;
  chips: string[];
};

function roundedAdjustment(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function signedTargetAmount(value: number, unit: 'cal' | 'cal/day' | 'oz'): string {
  const rounded = Math.round(value);
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded} ${unit}`;
}

function activityMetaPhrase(adjusted: AdjustedDailyTarget | null | undefined): string {
  const minutes = roundedAdjustment(adjusted?.activity_duration_minutes);
  const burned = roundedAdjustment(
    adjusted?.activity_calories_burned ?? adjusted?.activity_total_burned_kcal
  );
  const bits: string[] = [];
  if (minutes > 0) bits.push(`${minutes} min`);
  if (burned > 0) bits.push(`~${burned} kcal burn`);
  return bits.length ? ` (${bits.join(', ')})` : '';
}

function buildNutritionAdjustmentText(adjusted: AdjustedDailyTarget | null | undefined): string | null {
  if (!adjusted) return null;
  const basis = adjusted.target_basis ?? {};
  const goal = roundedAdjustment(adjusted.goal_adjustment_kcal ?? basis.goal_adjustment_kcal);
  const coaching = roundedAdjustment(adjusted.coaching_adjustment_kcal ?? basis.coaching_adjustment_kcal);
  const healthBasal = roundedAdjustment(
    adjusted.health_basal_target_adjustment_kcal ?? basis.health_basal_target_adjustment_kcal
  );
  const healthEnergy = roundedAdjustment(
    adjusted.health_energy_adjustment_kcal ?? basis.health_energy_adjustment_kcal
  );
  const rollingHealth = roundedAdjustment(
    adjusted.rolling_health_activity_adjustment_kcal ?? basis.rolling_health_activity_adjustment_kcal
  );
  const dayType = roundedAdjustment(adjusted.day_type_adjustment_kcal ?? basis.day_type_adjustment_kcal);
  const formulaTarget = roundedAdjustment(adjusted.formula_daily_target ?? basis.formula_daily_target);
  const resolvedTarget = roundedAdjustment(adjusted.resolved_daily_target ?? basis.resolved_daily_target);
  const activity = roundedAdjustment(adjusted.activity_adjustment_applied ?? adjusted.activity_adjustment_kcal);
  const workout = roundedAdjustment(adjusted.activity_workout_adjustment_kcal);
  const weekly = roundedAdjustment(
    adjusted.weekly_adjustment_applied
      ?? (roundedAdjustment(adjusted.adjustment_applied) - activity)
  );
  const parts: string[] = [];

  if (goal !== 0) {
    const goalName = basis.goal ? humanizeToken(String(basis.goal)).toLowerCase() : 'your goal';
    const pace = basis.goal_pace ? ` (${humanizeToken(String(basis.goal_pace)).toLowerCase()} pace)` : '';
    parts.push(`Goal target ${signedTargetAmount(goal, 'cal/day')} vs maintenance for ${goalName}${pace}.`);
  }

  if (healthEnergy !== 0) {
    const sourceKind = String(basis.source_tdee_kind ?? '');
    const blend = (basis.maintenance_blend as any) ?? null;
    const blendWeight = blend?.apple_weight != null ? Math.round(Number(blend.apple_weight) * 100) : null;
    parts.push(sourceKind === 'apple_health_blend' && blendWeight
      ? `Apple Health total energy is blended at ${blendWeight}% confidence and moved your maintenance ${signedTargetAmount(healthEnergy, 'cal/day')} versus the formula estimate.`
      : `Apple Health total energy moved your maintenance ${signedTargetAmount(healthEnergy, 'cal/day')} versus the formula estimate.`);
  } else if (healthBasal !== 0) {
    parts.push(`Apple Health basal energy moved your baseline ${signedTargetAmount(healthBasal, 'cal/day')} versus the formula estimate.`);
  }

  if (rollingHealth !== 0) {
    parts.push(`Recent active-energy and step trends moved your baseline ${signedTargetAmount(rollingHealth, 'cal/day')}.`);
  }

  if (coaching !== 0) {
    parts.push(`Coach adjustment ${signedTargetAmount(coaching, 'cal/day')} is applied to future targets.`);
  }

  if (Math.abs(dayType) >= 15) {
    parts.push(`Today's plan profile shifts calories ${signedTargetAmount(dayType, 'cal/day')}.`);
  }

  if (parts.length === 0 && formulaTarget > 0 && resolvedTarget > 0 && Math.abs(resolvedTarget - formulaTarget) >= 15) {
    parts.push(`Baseline target is ${resolvedTarget} cal versus the formula estimate of ${formulaTarget} cal.`);
  }

  if (activity > 0) {
    const reason = String(adjusted.activity_adjustment_reason ?? '').toLowerCase();
    const workoutCount = roundedAdjustment(adjusted.activity_workout_count);
    const workoutLabel = workoutCount > 1 ? `${workoutCount} completed workouts` : 'your completed workout';
    const meta = activityMetaPhrase(adjusted);
    if (reason === 'neat') {
      parts.push(`Calories ${signedTargetAmount(activity, 'cal')} today from movement above your normal baseline.`);
    } else if (reason === 'workout_neat') {
      parts.push(`Calories ${signedTargetAmount(activity, 'cal')} today from ${workoutLabel}${meta} plus extra movement.`);
    } else if (reason === 'workout_heavy') {
      parts.push(`Calories ${signedTargetAmount(activity, 'cal')} today because completed training was heavy${meta}.`);
    } else if (workout > 0 || reason === 'workout') {
      parts.push(`Calories ${signedTargetAmount(activity, 'cal')} today from ${workoutLabel}${meta}.`);
    } else {
      parts.push(`Calories ${signedTargetAmount(activity, 'cal')} today from activity.`);
    }
  }

  if (Math.abs(weekly) >= 15) {
    const remaining = roundedAdjustment(adjusted.days_remaining);
    const dayText = remaining > 1 ? `${remaining} days` : 'today';
    // 2026-05: specific "why" copy. When the backend reports the raw
    // over/under-budget calories, surface them so the user sees
    // exactly what's being smoothed (the original ask: "you went ~400
    // over earlier this week — we're spreading it over remaining
    // days"). Falls back to the generic phrasing when the API doesn't
    // report the breakdown (older backend / cache).
    const over = roundedAdjustment(adjusted.weekly_over_budget_kcal);
    const under = roundedAdjustment(adjusted.weekly_under_budget_kcal);
    if (weekly < 0 && over > 0) {
      const validDays = roundedAdjustment(adjusted.weekly_valid_days);
      const earlierLabel = validDays >= 2
        ? `the past ${validDays} days`
        : 'earlier this week';
      parts.push(
        `You ran about ${over} cal over target across ${earlierLabel}. We're trimming `
        + `${signedTargetAmount(weekly, 'cal/day')} for ${dayText} so the weekly average stays on track — `
        + `protein target is unchanged, the trim comes from carbs and fat.`,
      );
    } else if (weekly > 0 && under > 0) {
      const validDays = roundedAdjustment(adjusted.weekly_valid_days);
      const earlierLabel = validDays >= 2
        ? `the past ${validDays} days`
        : 'earlier this week';
      parts.push(
        `You ran about ${under} cal under target across ${earlierLabel}. We're adding `
        + `${signedTargetAmount(weekly, 'cal/day')} for ${dayText} so under-fueling doesn't compound — `
        + `protein target is unchanged.`,
      );
    } else {
      parts.push(
        `Weekly smoothing ${signedTargetAmount(weekly, 'cal/day')} for ${dayText}, `
        + `based on earlier days this week. It stays fixed while you log meals today.`,
      );
    }
  }

  // 2026-05: even on a "boring" day with no live adjustments, the user
  // should still be able to read WHAT drives their target — Apple Health
  // blend %, lifestyle answer, goal pace. Previously the pill simply
  // disappeared, which read as "the explanation is gone." Now we add a
  // baseline sentence so the pill is always informative on today.
  if (parts.length === 0) {
    const goalName = basis.goal ? humanizeToken(String(basis.goal)).toLowerCase() : null;
    const sourceKind = String(basis.source_tdee_kind ?? '');
    const blend = (basis.maintenance_blend as any) ?? null;
    const blendWeight = blend?.apple_weight != null ? Math.round(Number(blend.apple_weight) * 100) : null;
    const maintenance = roundedAdjustment(basis.maintenance_calories);
    const baselineBits: string[] = [];
    if (maintenance > 0) {
      baselineBits.push(`Your maintenance estimate is about ${maintenance} cal/day`);
    } else {
      baselineBits.push("Today's target reflects your baseline maintenance");
    }
    if (sourceKind === 'apple_health_blend' && blendWeight && blendWeight > 0) {
      baselineBits.push(`blended ${blendWeight}% with Apple Health measured energy`);
    } else if (sourceKind === 'apple_health') {
      baselineBits.push('with Apple Health basal energy applied');
    } else {
      baselineBits.push('from the formula (BMR × activity × lifestyle)');
    }
    if (goalName) {
      baselineBits.push(`and goal target for ${goalName}`);
    }
    parts.push(baselineBits.join(' ') + '. No weekly smoothing or activity bumps are active today.');
  }

  return parts.length ? parts.join(' ') : null;
}

function buildHydrationAdjustmentText(
  hydration: HydrationSummary | null | undefined,
  adjusted: AdjustedDailyTarget | null | undefined,
): string | null {
  const hydrationBreakdown = hydration?.breakdown as any;
  const adjustedBreakdown = adjusted?.hydration_breakdown as any;
  const breakdown = hydrationBreakdown ?? adjustedBreakdown;
  if (!breakdown) return null;

  const training = roundedAdjustment(breakdown.training ?? breakdown.training_addon_oz);
  const activeEnergy = roundedAdjustment(breakdown.active_energy ?? breakdown.active_energy_addon_oz);
  const heat = roundedAdjustment(breakdown.heat ?? breakdown.heat_addon_oz);
  const activity = roundedAdjustment(breakdown.activity ?? (training + activeEnergy + heat));
  const protein = roundedAdjustment(breakdown.protein ?? breakdown.protein_addon_oz);
  const alcohol = roundedAdjustment(breakdown.alcohol ?? breakdown.alcohol_addon_oz);
  if (activity <= 0 && protein <= 0 && alcohol <= 0) return null;

  const completedWorkout = roundedAdjustment(adjusted?.activity_workout_count) > 0
    || roundedAdjustment(hydration?.guidance?.workout_calories_burned) > 0;
  const minutes = roundedAdjustment(
    hydration?.guidance?.workout_minutes ?? adjusted?.activity_duration_minutes
  );
  const rawIntensity = String(
    breakdown.intensity
      ?? breakdown.intensity_bucket
      ?? hydration?.guidance?.activity_intensity
      ?? ''
  ).trim();
  const intensity = rawIntensity ? humanizeToken(rawIntensity).toLowerCase() : '';
  const source = completedWorkout ? 'completed' : 'planned';
  const reasons: string[] = [];

  if (activity > 0) {
    if (training > 0 || minutes > 0) {
      const workoutPhrase = [
        source,
        intensity,
        minutes > 0 ? `${minutes}-min` : '',
        'workout',
      ].filter(Boolean).join(' ');
      const extra = activeEnergy > 0 ? ' plus active-energy burn' : '';
      reasons.push(`${signedTargetAmount(activity, 'oz')} today for ${workoutPhrase}${extra}`);
    } else if (activeEnergy > 0) {
      reasons.push(`${signedTargetAmount(activeEnergy, 'oz')} today for high active energy`);
    } else if (heat > 0) {
      reasons.push(`${signedTargetAmount(heat, 'oz')} today for warm conditions`);
    }
  }
  if (protein > 0) reasons.push(`${signedTargetAmount(protein, 'oz')} today for protein logged`);
  if (alcohol > 0) reasons.push(`${signedTargetAmount(alcohol, 'oz')} today for alcohol logged`);

  return reasons.length ? `Water range ${reasons.join('; ')}.` : null;
}

export function buildDailyTargetAdjustmentBanner(
  adjusted: AdjustedDailyTarget | null | undefined,
  hydration: HydrationSummary | null | undefined,
): DailyTargetAdjustmentBannerInfo | null {
  const nutritionText = buildNutritionAdjustmentText(adjusted);
  const hydrationText = buildHydrationAdjustmentText(hydration, adjusted);
  if (!nutritionText && !hydrationText) return null;

  const chips: string[] = [];
  const basis = adjusted?.target_basis ?? {};
  const goalKcal = roundedAdjustment(adjusted?.goal_adjustment_kcal ?? basis.goal_adjustment_kcal);
  const coachingKcal = roundedAdjustment(adjusted?.coaching_adjustment_kcal ?? basis.coaching_adjustment_kcal);
  const healthBasalKcal = roundedAdjustment(
    adjusted?.health_basal_target_adjustment_kcal ?? basis.health_basal_target_adjustment_kcal
  );
  const healthEnergyKcal = roundedAdjustment(
    adjusted?.health_energy_adjustment_kcal ?? basis.health_energy_adjustment_kcal
  );
  const rollingHealthKcal = roundedAdjustment(
    adjusted?.rolling_health_activity_adjustment_kcal ?? basis.rolling_health_activity_adjustment_kcal
  );
  const activityKcal = roundedAdjustment(adjusted?.activity_adjustment_applied ?? adjusted?.activity_adjustment_kcal);
  const weeklyKcal = roundedAdjustment(
    adjusted?.weekly_adjustment_applied
      ?? (roundedAdjustment(adjusted?.adjustment_applied) - activityKcal)
  );
  const hydrationBreakdown = (hydration?.breakdown ?? adjusted?.hydration_breakdown) as any;
  const hydrationOz = roundedAdjustment(
    hydrationBreakdown?.activity
      ?? (
        roundedAdjustment(hydrationBreakdown?.training ?? hydrationBreakdown?.training_addon_oz)
        + roundedAdjustment(hydrationBreakdown?.active_energy ?? hydrationBreakdown?.active_energy_addon_oz)
        + roundedAdjustment(hydrationBreakdown?.heat ?? hydrationBreakdown?.heat_addon_oz)
      )
  )
    + roundedAdjustment(hydrationBreakdown?.protein ?? hydrationBreakdown?.protein_addon_oz)
    + roundedAdjustment(hydrationBreakdown?.alcohol ?? hydrationBreakdown?.alcohol_addon_oz);

  if (goalKcal !== 0) chips.push(`Goal ${signedTargetAmount(goalKcal, 'cal/day')}`);
  if (healthEnergyKcal !== 0) chips.push(`Health total ${signedTargetAmount(healthEnergyKcal, 'cal/day')}`);
  else if (healthBasalKcal !== 0) chips.push(`Health baseline ${signedTargetAmount(healthBasalKcal, 'cal/day')}`);
  if (rollingHealthKcal !== 0) chips.push(`Activity trend ${signedTargetAmount(rollingHealthKcal, 'cal/day')}`);
  if (coachingKcal !== 0) chips.push(`Coach ${signedTargetAmount(coachingKcal, 'cal/day')}`);
  if (activityKcal > 0) {
    const reason = String(adjusted?.activity_adjustment_reason ?? '').toLowerCase();
    const label = reason === 'neat'
      ? 'Movement'
      : reason === 'workout_neat'
      ? 'Workout + move'
      : 'Workout';
    chips.push(`${label} ${signedTargetAmount(activityKcal, 'cal')}`);
  }
  if (Math.abs(weeklyKcal) >= 15) chips.push(`Week ${signedTargetAmount(weeklyKcal, 'cal/day')}`);
  if (hydrationOz > 0) chips.push(`Water ${signedTargetAmount(hydrationOz, 'oz')}`);

  return {
    detail: [nutritionText, hydrationText].filter(Boolean).join(' '),
    chips,
  };
}

export function DailyTargetAdjustmentBanner({
  info,
  colors,
  accent,
  overPhoto = true,
  photoTone = 'dark',
}: {
  info: DailyTargetAdjustmentBannerInfo;
  colors?: ReturnType<typeof getTheme>['colors'];
  accent?: string;
  overPhoto?: boolean;
  photoTone?: 'dark' | 'light';
}) {
  const [expanded, setExpanded] = useState(false);
  const themedColors = colors ?? getTheme().colors;
  const mealAccent = accent ?? DEFAULT_MEALS_ACCENT;
  const darkPhoto = overPhoto && photoTone !== 'light';
  const lightPhoto = overPhoto && photoTone === 'light';
  const lightPhotoAccent = mealAccent;
  const bannerBackground = darkPhoto ? 'rgba(255,255,255,0.13)' : lightPhoto ? hexWithAlpha(themedColors.surface, 0.88) : themedColors.surfaceRaised;
  const bannerBorder = darkPhoto ? 'rgba(255,255,255,0.28)' : lightPhoto ? hexWithAlpha(mealAccent, 0.26) : themedColors.border;
  const iconColor = darkPhoto ? '#FFFFFF' : lightPhotoAccent;
  const titleColor = darkPhoto ? '#FFFFFF' : themedColors.textPrimary;

  return (
    <>
      <TouchableOpacity
        testID="daily-target-adjustment-banner"
        activeOpacity={0.82}
        onPress={() => setExpanded(true)}
        style={{
          alignSelf: 'flex-start',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderRadius: 999,
          borderWidth: 1,
          backgroundColor: bannerBackground,
          borderColor: bannerBorder,
          marginHorizontal: overPhoto ? 14 : 0,
          marginTop: overPhoto ? 4 : 0,
        }}
        accessibilityRole="button"
        accessibilityLabel="Show target change details">
        <Ionicons name="information-circle-outline" size={12} color={iconColor} />
        <Text style={{ fontSize: 11, fontWeight: '700', color: titleColor }}>
          Target changes
        </Text>
      </TouchableOpacity>
      <Modal
        visible={expanded}
        transparent
        animationType="fade"
        onRequestClose={() => setExpanded(false)}>
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setExpanded(false)}
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          <TouchableOpacity
            activeOpacity={1}
            onPress={() => {}}
            style={{
              width: '100%', maxWidth: 420,
              backgroundColor: themedColors.surface,
              borderRadius: radius.lg,
              borderWidth: 1, borderColor: themedColors.border,
              padding: 18, gap: 12,
            }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: mealAccent + '22' }}>
                <Ionicons name="information-circle-outline" size={18} color={mealAccent} />
              </View>
              <Text style={{ flex: 1, fontSize: 16, fontWeight: '800', color: themedColors.textPrimary }}>
                Target changes
              </Text>
              <TouchableOpacity
                onPress={() => setExpanded(false)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close" size={20} color={themedColors.textMuted} />
              </TouchableOpacity>
            </View>
            {info.chips.length > 0 ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {info.chips.map(chip => (
                  <View key={chip} style={{
                    paddingHorizontal: 8, paddingVertical: 4,
                    borderRadius: 999, borderWidth: 1,
                    backgroundColor: mealAccent + '14',
                    borderColor: mealAccent + '44',
                  }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: mealAccent }}>{chip}</Text>
                  </View>
                ))}
              </View>
            ) : null}
            <Text style={{ fontSize: 13, lineHeight: 19, color: themedColors.textSecondary }}>
              {info.detail}
            </Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

export function HydrationTodayPanel({
  ounces,
  target,
  targetMin,
  targetMax,
  pct,
  breakdown,
  guidance,
  loading,
  colors,
  accent,
  overPhoto = false,
  photoTone = 'dark',
  onDelta,
  onSet,
}: {
  ounces: number;
  target: number;
  targetMin?: number;
  targetMax?: number;
  pct: number;
  breakdown?: HydrationSummary['breakdown'];
  guidance?: HydrationSummary['guidance'];
  loading: boolean;
  colors: ReturnType<typeof getTheme>['colors'];
  accent?: string;
  overPhoto?: boolean;
  photoTone?: 'dark' | 'light';
  onDelta: (deltaOz: number) => void;
  onSet: (ounces: number) => void;
}) {
  const fillAnim = useRef(new Animated.Value(pct / 100)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const rippleAnim = useRef(new Animated.Value(0)).current;
  const burstAnim = useRef(new Animated.Value(0)).current;
  const previousOunces = useRef(ounces);
  const [manualOunces, setManualOunces] = useState(String(ounces || ''));
  const [burstLabel, setBurstLabel] = useState('');

  useEffect(() => {
    setManualOunces(String(ounces || ''));
  }, [ounces]);

  const computedTargetRange = hydrationTargetRangeOz(target);
  const rangeMin = Math.max(1, Math.round(targetMin ?? computedTargetRange?.min ?? target));
  const rangeMax = Math.max(rangeMin, Math.round(targetMax ?? computedTargetRange?.max ?? target));
  const pctToRange = Math.min(100, Math.round((ounces / rangeMin) * 100));
  const fillPct = Math.min(100, Math.round((ounces / rangeMax) * 100));
  const rangeLabel = targetMin && targetMax
    ? `${rangeMin}-${rangeMax}`
    : formatHydrationTargetRange(target) || String(target);
  const hydrationStatusLabel = ounces < rangeMin
    ? `${pctToRange}% to range`
    : ounces <= rangeMax
    ? 'in range'
    : 'above range';

  useEffect(() => {
    Animated.timing(fillAnim, {
      toValue: Math.max(0, Math.min(1, fillPct / 100)),
      duration: 420,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [fillAnim, fillPct]);

  useEffect(() => {
    if (previousOunces.current === ounces) return;
    const delta = ounces - previousOunces.current;
    previousOunces.current = ounces;
    setBurstLabel(delta > 0 ? `+${Math.round(delta)} oz` : 'Updated');
    rippleAnim.setValue(0);
    burstAnim.setValue(0);
    Animated.sequence([
      Animated.parallel([
        Animated.spring(pulseAnim, { toValue: 1.16, friction: 5, tension: 190, useNativeDriver: true }),
        Animated.timing(rippleAnim, {
          toValue: 1,
          duration: 620,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.sequence([
          Animated.timing(burstAnim, {
            toValue: 1,
            duration: 180,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.timing(burstAnim, {
            toValue: 0,
            duration: 520,
            easing: Easing.in(Easing.cubic),
            useNativeDriver: true,
          }),
        ]),
      ]),
      Animated.spring(pulseAnim, { toValue: 1, friction: 6, tension: 140, useNativeDriver: true }),
    ]).start();
  }, [burstAnim, ounces, pulseAnim, rippleAnim]);

  const fillWidth = fillAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });
  const rippleScale = rippleAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.55, 2.6],
  });
  const rippleOpacity = rippleAnim.interpolate({
    inputRange: [0, 0.65, 1],
    outputRange: [0.28, 0.12, 0],
  });
  const burstTranslateY = burstAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [8, -16],
  });

  const submitManual = () => {
    const parsed = Number(manualOunces.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(parsed)) return;
    onSet(parsed);
  };
  const activityOz = Math.round(breakdown?.activity ?? 0);
  const proteinOz = Math.round(breakdown?.protein ?? 0);
  const alcoholOz = Math.round(breakdown?.alcohol ?? 0);
  const workoutMinutes = Math.round(guidance?.workout_minutes ?? 0);
  const targetReason = typeof breakdown?.reason === 'string' ? breakdown.reason : null;
  const targetReasons: string[] = [];
  if (activityOz > 0) {
    targetReasons.push(
      targetReason
        ? `${targetReason} (+${activityOz} oz)`
        : workoutMinutes > 0
        ? `Water range raised ${activityOz} oz for ${workoutMinutes} min of training today.`
        : `Water range raised ${activityOz} oz for today's training.`
    );
  }
  if (proteinOz > 0) {
    targetReasons.push(`Protein logged today added ${proteinOz} oz.`);
  }
  if (alcoholOz > 0) {
    targetReasons.push(`Alcohol logged today added ${alcoholOz} oz.`);
  }
  const targetReasonMessage = targetReasons.length > 0 ? targetReasons.join(' ') : null;
  const guidanceMessage = targetReasonMessage
    ?? guidance?.electrolytes?.message
    ?? guidance?.notes?.find(note => note.key === 'high_sodium')?.message
    ?? null;
  const mealAccent = accent ?? DEFAULT_MEALS_ACCENT;
  const lightPhoto = overPhoto && photoTone === 'light';
  const lightPhotoAccent = mealAccent;
  const baseGuidanceTone = targetReasonMessage
    ? lightPhotoAccent
    : guidance?.electrolytes?.status === 'covered' || guidance?.electrolytes?.status === 'planned'
    ? baseColors.success
    : baseColors.warning;
  const darkPhoto = overPhoto && photoTone !== 'light';
  const darkPhotoBase = darkPhotoBaseForColors(colors);
  const photoHydrationAccent = '#7DD3FC';
  const guidanceTone = darkPhoto
    ? targetReasonMessage
      ? photoHydrationAccent
      : guidance?.electrolytes?.status === 'covered' || guidance?.electrolytes?.status === 'planned'
      ? '#86EFAC'
      : '#FCD34D'
    : baseGuidanceTone;
  const hydrationAccent = darkPhoto ? photoHydrationAccent : lightPhotoAccent;
  const photoControlText = '#FFFFFF';
  const panelTextPrimary = darkPhoto ? '#FFFFFF' : colors.textPrimary;
  const panelTextSecondary = darkPhoto ? 'rgba(255,255,255,0.78)' : lightPhoto ? colors.textPrimary : colors.textSecondary;
  const panelTextMuted = darkPhoto ? 'rgba(255,255,255,0.64)' : lightPhoto ? colors.textSecondary : colors.textMuted;
  const panelBackground = darkPhoto ? hexWithAlpha(darkPhotoBase, 0.54) : overPhoto ? hexWithAlpha(colors.surface, lightPhoto ? 0.88 : 0.9) : lightPhotoAccent + '0F';
  const panelBorder = darkPhoto ? 'rgba(255,255,255,0.22)' : lightPhoto ? hexWithAlpha(mealAccent, 0.26) : lightPhotoAccent + '33';
  const softAccentBackground = darkPhoto ? 'rgba(255,255,255,0.16)' : lightPhotoAccent + '18';
  const controlBackground = darkPhoto ? 'rgba(255,255,255,0.14)' : colors.surface;
  const controlBorder = darkPhoto ? 'rgba(255,255,255,0.20)' : colors.border;
  const progressTrackBackground = darkPhoto ? 'rgba(255,255,255,0.18)' : colors.surface;
  const guidanceBackground = darkPhoto ? hexWithAlpha(darkPhotoBase, 0.48) : guidanceTone + '12';
  const guidanceBorder = darkPhoto ? guidanceTone + '55' : guidanceTone + '2E';
  const quickAddTextColor = darkPhoto ? photoControlText : lightPhotoAccent;
  const primaryControlBackground = darkPhoto ? '#FFFFFF' : lightPhotoAccent;
  const primaryControlText = darkPhoto ? '#0F172A' : '#fff';

  return (
    <View testID="hydration-panel" style={[
      mealStyles.mealHydrationPanel,
      {
        backgroundColor: panelBackground,
        borderColor: panelBorder,
      },
    ]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Animated.View style={{
          width: 32, height: 32, borderRadius: 16,
          backgroundColor: softAccentBackground,
          alignItems: 'center', justifyContent: 'center',
          transform: [{ scale: pulseAnim }],
        }}>
          <Animated.View style={{
            position: 'absolute',
            width: 30,
            height: 30,
            borderRadius: 15,
            backgroundColor: hydrationAccent,
            opacity: rippleOpacity,
            transform: [{ scale: rippleScale }],
          }} />
          <Ionicons name="water-outline" size={18} color={hydrationAccent} />
        </Animated.View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 12, fontWeight: '900', color: panelTextPrimary }}>Hydration</Text>
          <Text style={{ fontSize: 11, color: panelTextMuted, marginTop: 1 }}>
            {ounces} / {rangeLabel} oz · {hydrationStatusLabel}
          </Text>
        </View>
        {loading && <ActivityIndicator size="small" color={hydrationAccent} />}
      </View>
      <View style={{ position: 'relative' }}>
        <Animated.View pointerEvents="none" style={{
          position: 'absolute',
          right: 0,
          top: -12,
          opacity: burstAnim,
          transform: [{ translateY: burstTranslateY }],
        }}>
          <Text style={{ fontSize: 10, fontWeight: '900', color: hydrationAccent }}>{burstLabel}</Text>
        </Animated.View>
        <View style={{
          height: 8,
          borderRadius: 999,
          backgroundColor: progressTrackBackground,
          overflow: 'hidden',
          marginTop: 10,
        }}>
          <Animated.View style={{ width: fillWidth, height: '100%', backgroundColor: hydrationAccent }} />
        </View>
      </View>
      {guidanceMessage ? (
        <View style={{
          marginTop: 10,
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: 6,
          paddingVertical: 7,
          paddingHorizontal: 8,
          borderRadius: 8,
          backgroundColor: guidanceBackground,
          borderWidth: 1,
          borderColor: guidanceBorder,
        }}>
          <Ionicons name="information-circle-outline" size={13} color={guidanceTone} style={{ marginTop: 1 }} />
          <Text testID="hydration-guidance-message" style={{ flex: 1, fontSize: 10.5, lineHeight: 15, color: panelTextSecondary, fontWeight: '600' }}>
            {guidanceMessage}
          </Text>
        </View>
      ) : null}
      <View style={{ gap: 8, marginTop: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{
            flex: 1,
            minHeight: 32,
            borderRadius: 10,
            backgroundColor: controlBackground,
            borderWidth: 1,
            borderColor: controlBorder,
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 8,
          }}>
            <TextInput
              testID="hydration-ounces-input"
              value={manualOunces}
              onChangeText={setManualOunces}
              onSubmitEditing={submitManual}
              keyboardType="decimal-pad"
              returnKeyType="done"
              editable={!loading}
              selectTextOnFocus
              style={{
                flex: 1,
                minWidth: 0,
                paddingVertical: 5,
                fontSize: 12,
                fontWeight: '900',
                color: panelTextPrimary,
              }}
            />
            <Text style={{ fontSize: 9, fontWeight: '800', color: panelTextMuted }}>oz</Text>
          </View>
          <PressableScale
            testID="hydration-set"
            onPress={submitManual}
            disabled={loading}
            scaleDown={0.94}
            style={{
              minHeight: 32,
              paddingHorizontal: 10,
              borderRadius: 10,
              backgroundColor: primaryControlBackground,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: loading ? 0.55 : 1,
            }}>
            <Text style={{ fontSize: 10, fontWeight: '900', color: primaryControlText }}>Set</Text>
          </PressableScale>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {HYDRATION_QUICK_ADD_OUNCES.map(oz => (
            <PressableScale
              key={oz}
              testID={`hydration-quick-add-${oz}`}
              onPress={() => onDelta(oz)}
              disabled={loading}
              scaleDown={0.94}
              style={{
                flex: 1,
                flexBasis: '18%',
                minWidth: 54,
                minHeight: 32,
                paddingVertical: 7,
                paddingHorizontal: 6,
                borderRadius: 10,
                backgroundColor: controlBackground,
                borderWidth: 1,
                borderColor: darkPhoto ? 'rgba(255,255,255,0.22)' : mealAccent + '3D',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: loading ? 0.55 : 1,
              }}>
              <Text
                style={{ fontSize: 10, fontWeight: '900', color: quickAddTextColor }}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.85}
              >
                {formatHydrationQuickAddLabel(oz)}
              </Text>
            </PressableScale>
          ))}
        </View>
      </View>
    </View>
  );
}
