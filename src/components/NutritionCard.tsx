import { useState, useMemo, useEffect, useRef } from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity, Modal, ScrollView, Platform, UIManager, Animated, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import { configureExpandAnimation } from '../utils/layoutAnim';
import { DailyNutritionPlan, MealSuggestion, AppThemeName } from '../types';
import { elevations, getContrastingTextColor, getTheme, radius, typography } from '../constants/theme';
import { ensureItems, formatItemAmount } from '../utils/mealItems';
import { computeDayInsights } from '../utils/nutritionLayers';
import { classifyFood, computeNutritionScore, computePlanGutHealth } from '../utils/nutritionScore';
import NutritionInsightCard from './NutritionInsightCard';
import SwipeableRow, { SwipeAction } from './SwipeableRow';
import AnimatedNumber from './AnimatedNumber';
import FadeInView from './FadeInView';
import { dynamicCompactTextProps } from '../utils/dynamicType';

function e2eId(value: string | number | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

interface NutritionCardProps {
  title?: string;
  themeName?: AppThemeName;
  nutritionPlan: DailyNutritionPlan;
  checkedMeals?: Record<string, boolean>;
  onToggleMeal?: (mealType: string) => void;
  onEditMeal?:   (mealType: string, meal: MealSuggestion) => void;
  onAddSnack?: () => void;
  onRemoveMeal?: (mealType: string) => void;
  onRestoreMeal?: (mealType: string) => void;
  onHardDeleteMeal?: (mealType: string) => void;
  onToggleRoutine?: (mealType: string) => void;
  onShowRecipe?: (mealType: string, meal: MealSuggestion) => void;
  /** Rename a meal inline from the card. Long-press the name to enter
   *  edit mode; the input commits on blur or submit. */
  onRenameMeal?: (mealType: string, newName: string) => void;
  /** Reorder the day's meals[]. `direction` is -1 (move up) or +1 (move down). */
  onMoveMeal?: (mealType: string, direction: -1 | 1) => void;
  /** Regenerate a single meal with a fresh seed, preserving calorie/macro targets.
   *  Shuffles ingredients within the same nutrient envelope. */
  onShuffleMeal?: (mealType: string, meal: MealSuggestion) => void;
  /** When set to a meal key, that meal row shows a loading spinner while
   *  the shuffle async operation is in flight. */
  shufflingMealKey?: string | null;
  goal?: string;
  /** Lowercase names of the user's Favorites. Used to show a
   *  "Saved" state on meal rows whose name already lives in the
   *  favorites library. */
  savedMealNames?: Set<string>;
  /** Toggle save/unsave for a meal directly from the card. */
  onToggleSave?: (mealType: string, meal: MealSuggestion) => void;
  /** Called when the user picks "From Favorites" on the add button. */
  onAddFromSaved?: () => void;
  /** Authoritative daily amounts from /meals/gut-health → today. When
   *  present they override the client-side plan-preview estimate so
   *  the Gut signals strip shows real logged totals (grams of
   *  collagen, billions of CFU, etc). */
  dailyCollagenG?: number | null;
  dailyProbioticCfuBillions?: number | null;
  /** Per-food plant vs animal protein breakdown for today. Drives the
   *  "Plant vs Meat" tile + drill-down modal beneath the macro grid.
   *  Null = not yet loaded; { plant_total_g: 0, animal_total_g: 0 }
   *  = loaded but no protein logged yet (tile hides). */
  proteinBreakdown?: {
    plant_total_g: number;
    animal_total_g: number;
    plant_pct: number;
    animal_pct: number;
    plant: Array<{ name: string; protein_g: number }>;
    animal: Array<{ name: string; protein_g: number }>;
    unclassified: Array<{ name: string; protein_g: number }>;
  } | null;
  /** Today's taken (non-skipped) supplements — used to inject
   *  supplement contributions into the nutrient drill-down so users
   *  see "Vitamin D3 (supplement)" alongside food sources. */
  todaySupplements?: Array<{
    ingredient_slug?: string | null;
    ingredient_name?: string | null;
    custom_name?: string | null;
    dose_amount: number;
    dose_unit: string;
    taken_count: number;
  }> | null;
  /** Server-authoritative projected-day score. When present, this
   *  overrides the local preview so Home, History, and Progress all
   *  show the same number for the planned day. */
  authoritativeScore?: {
    score: number;
    adherence?: number | null;
    quality?: number | null;
    micro?: number | null;
  } | null;
  hidePlanScore?: boolean;
  /** Removes the outer card shell so parent day cards can reveal the
   *  macro panel + individual meal cards as a clean expanding stack. */
  embedded?: boolean;
  testID?: string;
}

export default function NutritionCard({
  title,
  themeName,
  nutritionPlan,
  checkedMeals = {},
  onToggleMeal,
  onEditMeal,
  onAddSnack,
  onRemoveMeal,
  onRestoreMeal,
  onHardDeleteMeal,
  onToggleRoutine,
  onShowRecipe,
  onRenameMeal,
  onMoveMeal,
  onShuffleMeal,
  shufflingMealKey,
  onToggleSave,
  goal,
  savedMealNames,
  onAddFromSaved,
  dailyCollagenG,
  dailyProbioticCfuBillions,
  proteinBreakdown,
  todaySupplements,
  authoritativeScore,
  hidePlanScore = false,
  embedded = false,
  testID,
}: NutritionCardProps) {
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [showProteinModal, setShowProteinModal] = useState(false);
  const planPreviewScore = useMemo(() => computeNutritionScore(nutritionPlan, goal ?? 'body_recomp'), [nutritionPlan, goal]);
  const dayScore = useMemo(() => {
    if (!authoritativeScore || authoritativeScore.score <= 0) return planPreviewScore;
    return {
      ...planPreviewScore,
      score: authoritativeScore.score,
      adherence: authoritativeScore.adherence ?? planPreviewScore.adherence,
      quality: authoritativeScore.quality ?? planPreviewScore.quality,
      micro: authoritativeScore.micro ?? planPreviewScore.micro,
    };
  }, [authoritativeScore, planPreviewScore]);
  const visibleDayScore = hidePlanScore && (!authoritativeScore || authoritativeScore.score <= 0)
    ? { ...dayScore, score: 0 }
    : dayScore;
  const [drillNutrient, setDrillNutrient] = useState<string | null>(null);
  const [swipeHintDismissed, setSwipeHintDismissed] = useState(false);
  const sectionFadeAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (showDetailModal) {
      sectionFadeAnim.setValue(0);
      Animated.timing(sectionFadeAnim, { toValue: 1, duration: 400, delay: 120, useNativeDriver: true }).start();
    } else {
      sectionFadeAnim.setValue(0);
    }
  }, [showDetailModal]);
  const theme = getTheme(themeName);
  const colors = theme.colors;
  const section = theme.sections.meals;
  const styles = createStyles(colors, section);
  const targets = nutritionPlan.targets ?? { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const removed = new Set(nutritionPlan.removedMealIds ?? []);

  // Generic meals[] — no slot identity. Every meal is rendered uniformly
  // and keyed by its index in the array. Routine meals carry _routineId
  // and are surfaced under a "Routine" header; everything else lives
  // under "Today's Plan".
  const mealsArr = Array.isArray(nutritionPlan.meals) ? nutritionPlan.meals : [];
  // No emoji prefix on meal rows — the meal name + routine pin pill below
  // already carries the visual identity. Empty string keeps the prop API
  // stable so MealRow callers don't all have to change.
  const allMeals = mealsArr.map((meal, idx) => ({
    key: `meal_${idx}`,
    emoji: '',
    meal,
  }));
  const visibleMeals = allMeals.filter(m => !removed.has(m.key));
  const hiddenMeals  = allMeals.filter(m =>  removed.has(m.key));
  const allVisible = visibleMeals;
  const actual = {
    calories: Math.round(allVisible.reduce((sum, m) => sum + m.meal.calories, 0)),
    protein:  Math.round(allVisible.reduce((sum, m) => sum + m.meal.protein, 0)),
    carbs:    Math.round(allVisible.reduce((sum, m) => sum + (m.meal.carbs ?? 0), 0)),
    fat:      Math.round(allVisible.reduce((sum, m) => sum + (m.meal.fat ?? 0), 0)),
  };

  // Aggregate micronutrients across all visible meals. Each display
  // field accepts multiple backend key spellings because the backend
  // emits snake_case (`vitamin_a`) but the legacy type + old cached
  // plans used camelCase (`vitaminA`). We sum whichever is present.
  const microFieldSpec: Array<{ out: string; keys: string[] }> = [
    { out: 'fiber',              keys: ['fiber'] },
    { out: 'sugar',              keys: ['sugar'] },
    { out: 'sodium',             keys: ['sodium'] },
    { out: 'cholesterol',        keys: ['cholesterol', 'cholesterol_mg'] },
    { out: 'saturatedFat',       keys: ['saturated_fat', 'saturatedFat'] },
    { out: 'monounsaturatedFat', keys: ['monounsaturated_fat', 'monounsaturatedFat'] },
    { out: 'polyunsaturatedFat', keys: ['polyunsaturated_fat', 'polyunsaturatedFat'] },
    { out: 'omega3',             keys: ['omega_3', 'omega3'] },
    { out: 'omega6',             keys: ['omega_6', 'omega6'] },
    { out: 'potassium',          keys: ['potassium'] },
    { out: 'calcium',            keys: ['calcium'] },
    { out: 'iron',               keys: ['iron'] },
    { out: 'magnesium',          keys: ['magnesium'] },
    { out: 'vitaminD',           keys: ['vitamin_d', 'vitaminD'] },
    { out: 'vitaminC',           keys: ['vitamin_c', 'vitaminC'] },
    { out: 'vitaminB12',         keys: ['vitamin_b12', 'vitaminB12'] },
    { out: 'vitaminA',           keys: ['vitamin_a', 'vitaminA'] },
  ];
  const dailyMicros: Record<string, number> = {};
  for (const spec of microFieldSpec) {
    dailyMicros[spec.out] = Math.round(allVisible.reduce((sum, m) => {
      const micro: any = m.meal.micronutrients;
      if (!micro) return sum + (spec.out === 'fiber' ? (m.meal.fiber ?? 0) : 0);
      for (const k of spec.keys) {
        if (micro[k] != null) return sum + micro[k];
      }
      return sum + (spec.out === 'fiber' ? (m.meal.fiber ?? 0) : 0);
    }, 0));
  }
  const hasMicros = microFieldSpec.some(s => dailyMicros[s.out] > 0);

  // Plan-preview gut facts. Surfaced on the Nutrition Overview modal as a
  // descriptive "Gut signals" tile strip. Gut & Plants card handles the
  // full drill-down (today + 7d rollup).
  const _gutHealth = useMemo(
    () => computePlanGutHealth(allVisible.map(v => v.meal), dailyMicros, actual.calories),
    [allVisible, dailyMicros, actual.calories],
  );

  const effectiveProteinBreakdown = useMemo(() => {
    if (proteinBreakdown) return proteinBreakdown;
    let plantG = 0, animalG = 0;
    const plantItems: Array<{ name: string; protein_g: number }> = [];
    const animalItems: Array<{ name: string; protein_g: number }> = [];
    const uncItems: Array<{ name: string; protein_g: number }> = [];
    for (const { meal: m } of allVisible) {
      const items = m.items ?? [];
      for (const it of items) {
        const prot = (it as any).protein_g ?? (it as any).protein ?? 0;
        if (prot <= 0) continue;
        const src = (it as any).protein_source;
        if (src === 'plant') { plantG += prot; plantItems.push({ name: it.name, protein_g: prot }); }
        else if (src === 'animal') { animalG += prot; animalItems.push({ name: it.name, protein_g: prot }); }
        else if (src === 'mixed') { plantG += prot * 0.5; animalG += prot * 0.5; plantItems.push({ name: it.name, protein_g: prot * 0.5 }); animalItems.push({ name: it.name, protein_g: prot * 0.5 }); }
        else if (prot >= 2) { uncItems.push({ name: it.name, protein_g: prot }); }
      }
    }
    if (plantG + animalG <= 0) return null;
    const total = plantG + animalG;
    return {
      plant_total_g: Math.round(plantG),
      animal_total_g: Math.round(animalG),
      plant_pct: total > 0 ? Math.round((plantG / total) * 100) : 0,
      animal_pct: total > 0 ? Math.round((animalG / total) * 100) : 0,
      plant: plantItems, animal: animalItems, unclassified: uncItems,
    };
  }, [proteinBreakdown, allVisible]);

  return (
    <View testID={testID} style={[styles.card, embedded && styles.cardEmbedded]}>
      {/* Header removed — the macro grid below acts as the hero. The
          "+ Add Meal" affordance moved to the bottom of the meal list
          so the card opens with the user's macros front-and-center,
          matching the WorkoutCard hierarchy (hero → stats → list). */}
      <View style={[styles.body, embedded && styles.bodyEmbedded]}>
        {title ? <Text style={styles.titleSubtle}>{title}</Text> : null}
        {/* Macro tracker grid */}
        <View style={styles.macrosGrid}>
          <MacroTracker label="Calories" actual={actual.calories} target={targets.calories} unit=""  color={section.strong}    colors={colors} styles={styles} />
          <MacroTracker label="Protein"  actual={actual.protein}  target={targets.protein}  unit="g" color={colors.primary}    colors={colors} styles={styles} />
          <MacroTracker label="Carbs"    actual={actual.carbs}    target={targets.carbs}    unit="g" color="#F59E0B"           colors={colors} styles={styles} />
          <MacroTracker label="Fat"      actual={actual.fat}      target={targets.fat}      unit="g" color="#A78BFA"           colors={colors} styles={styles} />
        </View>

        {/* Plant vs Meat protein ratio — computed from plan items when
            server-authoritative breakdown isn't available. */}
        {effectiveProteinBreakdown && (effectiveProteinBreakdown.plant_total_g + effectiveProteinBreakdown.animal_total_g) > 0 && (() => {
          const plantG = effectiveProteinBreakdown.plant_total_g;
          const animalG = effectiveProteinBreakdown.animal_total_g;
          const total = plantG + animalG;
          const plantPct = total > 0 ? (plantG / total) * 100 : 0;
          // Plant green / animal warm-orange split bar — keeps the
          // semantic ("plant"=green / "animal"=warm) consistent across
          // themes without hardcoding theme-specific colors.
          const plantColor = '#22C55E';
          const animalColor = '#E07830';
          return (
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => setShowProteinModal(true)}
              style={{
                marginTop: 10, padding: 12,
                backgroundColor: colors.surface,
                borderRadius: 10,
                borderWidth: 1, borderColor: colors.border,
              }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textSecondary, letterSpacing: 0.4 }}>
                  PROTEIN SOURCE
                </Text>
                <View style={{ flex: 1 }} />
                <Text style={{ fontSize: 11, fontWeight: '700', color: plantColor }}>
                  Plant {Math.round(plantG)}g
                </Text>
                <Text style={{ fontSize: 11, color: colors.textMuted }}>·</Text>
                <Text style={{ fontSize: 11, fontWeight: '700', color: animalColor }}>
                  Meat {Math.round(animalG)}g
                </Text>
                <Ionicons name="chevron-forward" size={12} color={colors.textMuted} />
              </View>
              {/* Proportional split bar */}
              <View style={{ flexDirection: 'row', height: 6, borderRadius: 3, overflow: 'hidden', backgroundColor: colors.border }}>
                <View style={{ width: `${plantPct}%`, backgroundColor: plantColor }} />
                <View style={{ flex: 1, backgroundColor: animalColor }} />
              </View>
              {effectiveProteinBreakdown.unclassified.length > 0 && (
                <Text style={{ fontSize: 10, color: colors.textMuted, marginTop: 6 }}>
                  +{effectiveProteinBreakdown.unclassified.length} unclassified item{effectiveProteinBreakdown.unclassified.length === 1 ? '' : 's'} — tap to see
                </Text>
              )}
            </TouchableOpacity>
          );
        })()}
        {/* Day score — tap to open combined nutrition modal */}
        {visibleDayScore.score > 0 && (() => {
          const sc = visibleDayScore;
          const scoreColor = sc.score >= 70 ? colors.success : sc.score >= 45 ? colors.warning : colors.error;
          return (
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => setShowDetailModal(true)}
              style={{ marginBottom: 4, marginTop: 2, paddingVertical: 6, paddingHorizontal: 2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: scoreColor + '18', alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontSize: 12, fontWeight: '800', color: scoreColor }}>{sc.score}</Text>
                  </View>
                  <View>
                    <Text style={{ fontSize: 11, fontWeight: '600', color: colors.textMuted, letterSpacing: 0.2 }}>Nutrition Score</Text>
                    <Text style={{ fontSize: 11, color: colors.textSecondary }}>
                      {sc.wins.length > 0 ? sc.wins[0] : sc.improvements.length > 0 ? sc.improvements[0] : 'Tap for details'}
                    </Text>
                  </View>
                </View>
                <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
              </View>
              {/* 2–4 chips: biggest wins + biggest gaps. Overview stays
                  tight — full breakdown is in the modal. */}
              {(() => {
                const chips: Array<{ text: string; win: boolean }> = [];
                for (const w of visibleDayScore.wins.slice(0, 2)) chips.push({ text: w, win: true });
                for (const g of visibleDayScore.improvements.slice(0, 4 - chips.length)) chips.push({ text: g, win: false });
                if (chips.length === 0) return null;
                return (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                    {chips.map((c, i) => (
                      <View key={i} style={{
                        paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12,
                        backgroundColor: (c.win ? colors.success : colors.warning) + '18',
                      }}>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: c.win ? colors.success : colors.warning }}>
                          {c.win ? '✓ ' : '⚠ '}{c.text}
                        </Text>
                      </View>
                    ))}
                  </View>
                );
              })()}
            </TouchableOpacity>
          );
        })()}

        {/* Combined Nutrition + Gut Health + Micronutrient Modal */}
        <Modal
          visible={showDetailModal}
          transparent
          animationType="slide"
          onRequestClose={() => { setShowDetailModal(false); setDrillNutrient(null); }}>
          <View style={styles.modalOverlay}>
            <View style={[styles.modalContent, { backgroundColor: colors.surface }]}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Nutrition Overview</Text>
                <TouchableOpacity onPress={() => { setShowDetailModal(false); setDrillNutrient(null); }} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                  <Ionicons name="close" size={22} color={colors.textMuted} />
                </TouchableOpacity>
              </View>

              <ScrollView style={styles.modalScroll} showsVerticalScrollIndicator={false}>
                {/* ── Section 1: Nutrition Score ── */}
                {visibleDayScore.score > 0 && (() => {
                  const sc = visibleDayScore;
                  const scoreColor = sc.score >= 70 ? colors.success : sc.score >= 45 ? colors.warning : colors.error;
                  return (
                    <Animated.View style={[styles.modalCard, { borderColor: colors.border, backgroundColor: colors.surfaceRaised, opacity: sectionFadeAnim }]}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                        <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: scoreColor + '18', alignItems: 'center', justifyContent: 'center' }}>
                          <Text style={{ fontSize: 20, fontWeight: '900', color: scoreColor }}>{sc.score}</Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 14, fontWeight: '700', color: colors.textPrimary }}>Nutrition Score</Text>
                          <Text style={{ fontSize: 11, color: colors.textSecondary }}>
                            {sc.score >= 70 ? 'Great' : sc.score >= 45 ? 'Good progress' : 'Room to improve'}
                          </Text>
                        </View>
                      </View>
                      {[
                        { label: 'Adherence', value: sc.adherence, color: sc.adherence >= 70 ? colors.success : sc.adherence >= 45 ? colors.warning : colors.error },
                        { label: 'Food Quality', value: sc.quality, color: sc.quality >= 70 ? colors.success : sc.quality >= 45 ? colors.warning : colors.error },
                        { label: 'Micronutrients', value: sc.micro, color: sc.micro >= 70 ? colors.success : sc.micro >= 45 ? colors.warning : colors.error },
                      ].map(sub => (
                        <View key={sub.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                          <Text style={{ fontSize: 11, fontWeight: '600', color: colors.textSecondary, width: 85 }}>{sub.label}</Text>
                          <View style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: colors.border }}>
                            <View style={{ width: `${Math.min(100, sub.value)}%` as any, height: 5, borderRadius: 3, backgroundColor: sub.color }} />
                          </View>
                          <Text style={{ fontSize: 11, fontWeight: '700', color: sub.color, width: 26, textAlign: 'right' }}>{sub.value}</Text>
                        </View>
                      ))}
                      {sc.indicators && (
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border + '44' }}>
                          {sc.indicators.total_calories > 0 && (
                            <Text style={{ fontSize: 10, color: colors.textMuted }}>
                              {Math.round(sc.indicators.total_calories)} / {Math.round(sc.indicators.target_calories)} cal
                            </Text>
                          )}
                          {sc.indicators.total_protein > 0 && (
                            <Text style={{ fontSize: 10, color: colors.textMuted }}>
                              {Math.round(sc.indicators.total_protein)} / {Math.round(sc.indicators.target_protein)}g protein
                            </Text>
                          )}
                          {sc.indicators.whole_food_pct > 0 && (
                            <Text style={{ fontSize: 10, color: colors.textMuted }}>
                              {sc.indicators.whole_food_pct}% whole foods
                            </Text>
                          )}
                        </View>
                      )}
                      {(sc.wins.length > 0 || sc.improvements.length > 0) && (
                        <View style={{ marginTop: 6, gap: 3 }}>
                          {sc.wins.map(w => (
                            <View key={w} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                              <Ionicons name="checkmark-circle" size={12} color={colors.success} />
                              <Text style={{ fontSize: 10, color: colors.success, fontWeight: '600' }}>{w}</Text>
                            </View>
                          ))}
                          {sc.improvements.map(imp => (
                            <View key={imp} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                              <Ionicons name="arrow-up-circle" size={12} color={colors.warning} />
                              <Text style={{ fontSize: 10, color: colors.warning, fontWeight: '600' }}>{imp}</Text>
                            </View>
                          ))}
                        </View>
                      )}
                    </Animated.View>
                  );
                })()}

                {/* Macros removed from the modal — the main NutritionCard
                    already shows the macro tracker grid. The modal is for
                    score breakdowns only. */}

                {/* ── Section 3: Food Quality breakdown (unified with backend) ── */}
                {visibleDayScore.quality_breakdown && visibleDayScore.quality_breakdown.length > 0 && (
                  <Animated.View style={[styles.modalCard, { borderColor: colors.border, backgroundColor: colors.surfaceRaised, opacity: sectionFadeAnim }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <Ionicons name="nutrition-outline" size={16} color={colors.primary} />
                      <Text style={{ fontSize: 14, fontWeight: '700', color: colors.textPrimary }}>Food Quality</Text>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textSecondary, marginLeft: 'auto' }}>
                        {visibleDayScore.quality}
                      </Text>
                    </View>
                    {visibleDayScore.quality_breakdown.map(b => {
                      const c = b.on_track ? colors.success : b.value_pct >= 50 ? colors.warning : colors.error;
                      return (
                        <View key={b.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                          <Text style={{ width: 120, fontSize: 11, fontWeight: '600', color: colors.textSecondary }}>{b.label}</Text>
                          <View style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: colors.border }}>
                            <View style={{ width: `${Math.min(100, b.value_pct)}%` as any, height: 5, borderRadius: 3, backgroundColor: c }} />
                          </View>
                          <Text style={{ fontSize: 10, color: colors.textMuted, width: 58, textAlign: 'right' }}>
                            {b.raw}{b.unit === '% cals' ? '%' : b.unit === 'mg' ? ` ${b.unit}` : b.unit ? ` ${b.unit}` : ''}
                          </Text>
                        </View>
                      );
                    })}
                    <Text style={{ fontSize: 10, color: colors.textMuted, marginTop: 8, fontStyle: 'italic' }}>
                      See the Gut & Plants card for plant diversity and processing mix details.
                    </Text>
                  </Animated.View>
                )}

                {/* ── Gut signals strip (facts, not scored). Shows
                    probiotic / fermented / plants so the user has
                    visibility into gut-support inputs without diluting
                    Food Quality's scoring. */}
                {_gutHealth.item_count > 0 && (
                  <Animated.View style={[styles.modalCard, { borderColor: colors.border, backgroundColor: colors.surfaceRaised, opacity: sectionFadeAnim }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <Ionicons name="leaf-outline" size={16} color={colors.primary} />
                      <Text style={{ fontSize: 14, fontWeight: '700', color: colors.textPrimary }}>Gut signals</Text>
                      <Text style={{ fontSize: 10, color: colors.textMuted, marginLeft: 'auto' }}>today</Text>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                      {[
                        // Prefer authoritative server amount (from
                        // /meals/gut-health → today). Falls back to
                        // the client-side plan estimate when no props
                        // are passed (e.g. plan-preview context).
                        {
                          label: 'Probiotic',
                          value: dailyProbioticCfuBillions != null && dailyProbioticCfuBillions > 0
                            ? `${dailyProbioticCfuBillions >= 10 ? Math.round(dailyProbioticCfuBillions) : dailyProbioticCfuBillions.toFixed(1)}B`
                            : `${Math.round(_gutHealth.probiotic_servings)}`,
                          detail: dailyProbioticCfuBillions != null ? 'CFU' : 'svg',
                        },
                        {
                          label: 'Collagen',
                          value: dailyCollagenG != null ? `${Math.round(dailyCollagenG)}g` : '—',
                          detail: 'today',
                        },
                        { label: 'Fermented', value: Math.round(_gutHealth.fermented_servings), detail: 'svg' },
                        { label: 'Plants', value: _gutHealth.distinct_plant_foods, detail: 'types' },
                        { label: 'Omega-3', value: _gutHealth.omega3_mg > 0 ? `${Math.round(_gutHealth.omega3_mg)}mg` : '0', detail: 'today' },
                      ].map(tile => (
                        <View key={tile.label} style={{
                          flex: 1, alignItems: 'center', backgroundColor: colors.background,
                          borderRadius: 8, paddingVertical: 10,
                        }}>
                          <Text style={{ fontSize: 16, fontWeight: '800', color: colors.textPrimary }}>
                            {tile.value}
                          </Text>
                          <Text style={{ fontSize: 9, fontWeight: '600', color: colors.textMuted, marginTop: 2 }}>
                            {tile.label}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </Animated.View>
                )}

                {/* ── Section 4: Key Gaps ── */}
                {(() => {
                  const day: Record<string, number> = {
                    fiber: dailyMicros.fiber || 0, sugar: dailyMicros.sugar || 0,
                    sodium: dailyMicros.sodium || 0, saturatedFat: dailyMicros.saturatedFat || 0,
                    omega3: dailyMicros.omega3 || 0, potassium: dailyMicros.potassium || 0,
                    calcium: dailyMicros.calcium || 0, magnesium: dailyMicros.magnesium || 0,
                    vitaminD: dailyMicros.vitaminD || 0, cholesterol: dailyMicros.cholesterol || 0,
                  };
                  const insights = computeDayInsights(day).slice(0, 3);
                  if (insights.length === 0) return null;
                  return (
                    <View style={[styles.modalCard, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
                      <Text style={[styles.modalSectionTitle, { marginBottom: 8 }]}>Key Gaps</Text>
                      {insights.map(ins => (
                        <NutritionInsightCard
                          key={ins.key}
                          insight={ins}
                          meals={allVisible.map(v => v.meal)}
                          themeColors={{
                            textPrimary: colors.textPrimary, textSecondary: colors.textSecondary,
                            textMuted: colors.textMuted, border: colors.border, surface: colors.surface,
                            primary: colors.primary, surfaceRaised: colors.surfaceRaised,
                          }}
                        />
                      ))}
                    </View>
                  );
                })()}

                {/* Nutrient drill-down */}
                {drillNutrient && (() => {
                  const spec = microFieldSpec.find(s => s.out === drillNutrient);
                  if (!spec) return null;
                  const contributions: Array<{ food: string; meal: string; amount: number }> = [];
                  for (const { meal } of allVisible) {
                    let mealItemContributed = false;
                    for (const it of (meal.items ?? [])) {
                      const mn: any = it.micronutrients ?? {};
                      let val = 0;
                      for (const k of spec.keys) { if (mn[k] != null) { val = Number(mn[k]) || 0; break; } }
                      if (val > 0) { contributions.push({ food: it.name, meal: meal.meal, amount: val }); mealItemContributed = true; }
                    }
                    if (!mealItemContributed) {
                      const mn: any = meal.micronutrients ?? {};
                      let val = 0;
                      for (const k of spec.keys) { if (mn[k] != null) { val = Number(mn[k]) || 0; break; } }
                      if (val > 0) contributions.push({ food: meal.meal, meal: '', amount: val });
                    }
                  }
                  // Inject supplement contributions (vitamin D3, B12, magnesium, iron, omega-3)
                  const _suppMicroMap: Record<string, { key: string; converter: number }> = {
                    vitamin_d3: { key: 'vitaminD', converter: 1 / 40 },
                    vitamin_b12: { key: 'vitaminB12', converter: 1 },
                    magnesium: { key: 'magnesium', converter: 1 },
                    iron: { key: 'iron', converter: 1 },
                    omega_3: { key: 'omega3', converter: 1 },
                  };
                  if (todaySupplements) {
                    for (const sup of todaySupplements) {
                      if (!sup.ingredient_slug || sup.taken_count <= 0) continue;
                      const mapping = _suppMicroMap[sup.ingredient_slug];
                      if (!mapping || mapping.key !== spec.out) continue;
                      const amount = sup.dose_amount * sup.taken_count * mapping.converter;
                      if (amount > 0) contributions.push({ food: `${sup.ingredient_name ?? sup.custom_name ?? sup.ingredient_slug} (supplement)`, meal: '', amount });
                    }
                  }
                  contributions.sort((a, b) => b.amount - a.amount);
                  const total = contributions.reduce((s, c) => s + c.amount, 0);
                  const displayLabel = spec.out.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
                  const unitStr = ['fiber', 'sugar', 'saturatedFat', 'monounsaturatedFat', 'polyunsaturatedFat'].includes(spec.out) ? 'g' : ['vitaminD', 'vitaminB12'].includes(spec.out) ? 'mcg' : 'mg';
                  return (
                    <View style={{ backgroundColor: colors.primary + '15', borderRadius: 14, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: colors.primary + '33' }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                        <Text style={{ fontSize: 15, fontWeight: '700', color: colors.textPrimary }}>{displayLabel} Sources</Text>
                        <TouchableOpacity onPress={() => setDrillNutrient(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                          <Ionicons name="close" size={18} color={colors.textMuted} />
                        </TouchableOpacity>
                      </View>
                      {contributions.length === 0 ? (
                        <Text style={{ fontSize: 13, color: colors.textMuted, lineHeight: 18 }}>Per-food breakdown will appear after your next plan regeneration.</Text>
                      ) : (
                        <>
                          {contributions.slice(0, 12).map((c, i) => {
                            const pctOfTotal = total > 0 ? c.amount / total : 0;
                            return (
                              <View key={`${c.food}-${i}`} style={{ marginBottom: 10 }}>
                                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                                  <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textPrimary, flex: 1 }} numberOfLines={1}>{c.food}</Text>
                                  <Text style={{ fontSize: 13, fontWeight: '700', color: colors.primary, marginLeft: 8 }}>{c.amount < 10 ? (Math.round(c.amount * 10) / 10) : Math.round(c.amount)}{unitStr}</Text>
                                </View>
                                {c.meal ? <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 4 }}>from {c.meal}</Text> : null}
                                <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.border }}>
                                  <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.primary, width: `${Math.round(pctOfTotal * 100)}%` as any }} />
                                </View>
                              </View>
                            );
                          })}
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 2, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border }}>
                            <Text style={{ fontSize: 14, fontWeight: '700', color: colors.textPrimary }}>Total</Text>
                            <Text style={{ fontSize: 14, fontWeight: '700', color: colors.primary }}>{total < 10 ? (Math.round(total * 10) / 10) : Math.round(total)}{unitStr}</Text>
                          </View>
                        </>
                      )}
                    </View>
                  );
                })()}

                {/* ── Plant vs Meat protein breakdown ──
                    Mirrors the tile on the card body so users who
                    open the overview modal also see the comparison
                    + can drill into per-food sources. */}
                {effectiveProteinBreakdown && (effectiveProteinBreakdown.plant_total_g + effectiveProteinBreakdown.animal_total_g) > 0 && (() => {
                  const plantG = effectiveProteinBreakdown.plant_total_g;
                  const animalG = effectiveProteinBreakdown.animal_total_g;
                  const total = plantG + animalG;
                  const plantPct = total > 0 ? (plantG / total) * 100 : 0;
                  return (
                    <View style={[styles.modalCard, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
                      <Text style={[styles.modalSectionTitle, { marginBottom: 8 }]}>Plant vs Meat Protein</Text>
                      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
                        <View style={{ flex: 1, padding: 10, backgroundColor: '#22C55E22', borderRadius: 8 }}>
                          <Text style={{ fontSize: 10, color: '#16803D', fontWeight: '800', letterSpacing: 0.5 }}>PLANT</Text>
                          <Text style={{ fontSize: 20, fontWeight: '900', color: '#16803D', marginTop: 2 }}>
                            {Math.round(plantG)}<Text style={{ fontSize: 11, fontWeight: '700' }}>g</Text>
                          </Text>
                          <Text style={{ fontSize: 10, color: '#16803D' }}>{Math.round(plantPct)}%</Text>
                        </View>
                        <View style={{ flex: 1, padding: 10, backgroundColor: '#E0783022', borderRadius: 8 }}>
                          <Text style={{ fontSize: 10, color: '#9A4810', fontWeight: '800', letterSpacing: 0.5 }}>ANIMAL</Text>
                          <Text style={{ fontSize: 20, fontWeight: '900', color: '#9A4810', marginTop: 2 }}>
                            {Math.round(animalG)}<Text style={{ fontSize: 11, fontWeight: '700' }}>g</Text>
                          </Text>
                          <Text style={{ fontSize: 10, color: '#9A4810' }}>{Math.round(100 - plantPct)}%</Text>
                        </View>
                      </View>
                      <View style={{ flexDirection: 'row', height: 6, borderRadius: 3, overflow: 'hidden', backgroundColor: colors.border, marginBottom: 10 }}>
                        <View style={{ width: `${plantPct}%` as any, backgroundColor: '#22C55E' }} />
                        <View style={{ flex: 1, backgroundColor: '#E07830' }} />
                      </View>
                      <TouchableOpacity
                        onPress={() => { setShowDetailModal(false); setTimeout(() => setShowProteinModal(true), 220); }}
                        style={{ alignSelf: 'flex-start', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, backgroundColor: colors.background }}>
                        <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textSecondary }}>
                          See per-food breakdown ({effectiveProteinBreakdown.plant.length + effectiveProteinBreakdown.animal.length} sources)
                        </Text>
                      </TouchableOpacity>
                    </View>
                  );
                })()}

                {/* ── Section 5: Micronutrients ── */}
                <View style={[styles.modalCard, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
                  <Text style={[styles.modalSectionTitle, { marginBottom: 8 }]}>Essentials</Text>
                  <View style={styles.microGridLg}>
                    <MicroChipLg label="Fiber" value={dailyMicros.fiber > 0 ? `${Math.round(dailyMicros.fiber)}g` : '—'} target="28g" pct={dailyMicros.fiber / 28} colors={colors} styles={styles} low={dailyMicros.fiber > 0 && dailyMicros.fiber < 20} onPress={() => setDrillNutrient(drillNutrient === 'fiber' ? null : 'fiber')} />
                    <MicroChipLg label="Sugar" value={dailyMicros.sugar > 0 ? `${Math.round(dailyMicros.sugar)}g` : '—'} target="<50g" pct={dailyMicros.sugar > 0 ? Math.min(dailyMicros.sugar / 50, 1) : 0} colors={colors} styles={styles} warn={dailyMicros.sugar > 50} onPress={() => setDrillNutrient(drillNutrient === 'sugar' ? null : 'sugar')} />
                    <MicroChipLg label="Sodium" value={dailyMicros.sodium > 0 ? `${Math.round(dailyMicros.sodium)}mg` : '—'} target="<2300mg" pct={dailyMicros.sodium > 0 ? Math.min(dailyMicros.sodium / 2300, 1) : 0} colors={colors} styles={styles} warn={dailyMicros.sodium > 2300} onPress={() => setDrillNutrient(drillNutrient === 'sodium' ? null : 'sodium')} />
                    <MicroChipLg label="Cholesterol" value={dailyMicros.cholesterol > 0 ? `${Math.round(dailyMicros.cholesterol)}mg` : '—'} target="<300mg" pct={dailyMicros.cholesterol > 0 ? Math.min(dailyMicros.cholesterol / 300, 1) : 0} colors={colors} styles={styles} warn={dailyMicros.cholesterol > 300} onPress={() => setDrillNutrient(drillNutrient === 'cholesterol' ? null : 'cholesterol')} />
                  </View>

                  <Text style={[styles.modalSectionTitle, { marginTop: 16, marginBottom: 8 }]}>Fats Panel</Text>
                  <View style={styles.microGridLg}>
                    <MicroChipLg label="Saturated" value={dailyMicros.saturatedFat > 0 ? `${Math.round(dailyMicros.saturatedFat)}g` : '—'} target="<20g" pct={dailyMicros.saturatedFat > 0 ? Math.min(dailyMicros.saturatedFat / 20, 1) : 0} colors={colors} styles={styles} warn={dailyMicros.saturatedFat > 20} onPress={() => setDrillNutrient(drillNutrient === 'saturatedFat' ? null : 'saturatedFat')} />
                    <MicroChipLg label="Mono" value={dailyMicros.monounsaturatedFat > 0 ? `${Math.round(dailyMicros.monounsaturatedFat)}g` : '—'} target="25g" pct={dailyMicros.monounsaturatedFat / 25} colors={colors} styles={styles} onPress={() => setDrillNutrient(drillNutrient === 'monounsaturatedFat' ? null : 'monounsaturatedFat')} />
                    <MicroChipLg label="Poly" value={dailyMicros.polyunsaturatedFat > 0 ? `${Math.round(dailyMicros.polyunsaturatedFat)}g` : '—'} target="15g" pct={dailyMicros.polyunsaturatedFat / 15} colors={colors} styles={styles} onPress={() => setDrillNutrient(drillNutrient === 'polyunsaturatedFat' ? null : 'polyunsaturatedFat')} />
                    <MicroChipLg label="Omega-3" value={dailyMicros.omega3 > 0 ? `${Math.round(dailyMicros.omega3)}mg` : '—'} target="1600mg" pct={dailyMicros.omega3 / 1600} colors={colors} styles={styles} low={dailyMicros.omega3 > 0 && dailyMicros.omega3 < 1000} onPress={() => setDrillNutrient(drillNutrient === 'omega3' ? null : 'omega3')} />
                  </View>

                  <Text style={[styles.modalSectionTitle, { marginTop: 16, marginBottom: 8 }]}>Minerals</Text>
                  <View style={styles.microGridLg}>
                    <MicroChipLg label="Potassium" value={dailyMicros.potassium > 0 ? `${Math.round(dailyMicros.potassium)}mg` : '—'} target="3400mg" pct={dailyMicros.potassium / 3400} colors={colors} styles={styles} low={dailyMicros.potassium > 0 && dailyMicros.potassium < 2300} onPress={() => setDrillNutrient(drillNutrient === 'potassium' ? null : 'potassium')} />
                    <MicroChipLg label="Calcium" value={dailyMicros.calcium > 0 ? `${Math.round(dailyMicros.calcium)}mg` : '—'} target="1000mg" pct={dailyMicros.calcium / 1000} colors={colors} styles={styles} low={dailyMicros.calcium > 0 && dailyMicros.calcium < 700} onPress={() => setDrillNutrient(drillNutrient === 'calcium' ? null : 'calcium')} />
                    <MicroChipLg label="Iron" value={dailyMicros.iron > 0 ? `${(Math.round(dailyMicros.iron * 10) / 10)}mg` : '—'} target="18mg" pct={dailyMicros.iron / 18} colors={colors} styles={styles} low={dailyMicros.iron > 0 && dailyMicros.iron < 12} onPress={() => setDrillNutrient(drillNutrient === 'iron' ? null : 'iron')} />
                    <MicroChipLg label="Magnesium" value={dailyMicros.magnesium > 0 ? `${Math.round(dailyMicros.magnesium)}mg` : '—'} target="400mg" pct={dailyMicros.magnesium / 400} colors={colors} styles={styles} low={dailyMicros.magnesium > 0 && dailyMicros.magnesium < 280} onPress={() => setDrillNutrient(drillNutrient === 'magnesium' ? null : 'magnesium')} />
                  </View>

                  <Text style={[styles.modalSectionTitle, { marginTop: 16, marginBottom: 8 }]}>Vitamins</Text>
                  <View style={styles.microGridLg}>
                    <MicroChipLg label="Vitamin D" value={dailyMicros.vitaminD > 0 ? `${(Math.round(dailyMicros.vitaminD * 10) / 10)}mcg` : '—'} target="15mcg" pct={dailyMicros.vitaminD / 15} colors={colors} styles={styles} low={dailyMicros.vitaminD > 0 && dailyMicros.vitaminD < 10} onPress={() => setDrillNutrient(drillNutrient === 'vitaminD' ? null : 'vitaminD')} />
                    <MicroChipLg label="Vitamin C" value={dailyMicros.vitaminC > 0 ? `${Math.round(dailyMicros.vitaminC)}mg` : '—'} target="90mg" pct={dailyMicros.vitaminC / 90} colors={colors} styles={styles} low={dailyMicros.vitaminC > 0 && dailyMicros.vitaminC < 60} onPress={() => setDrillNutrient(drillNutrient === 'vitaminC' ? null : 'vitaminC')} />
                    <MicroChipLg label="Vitamin B12" value={dailyMicros.vitaminB12 > 0 ? `${(Math.round(dailyMicros.vitaminB12 * 10) / 10)}mcg` : '—'} target="2.4mcg" pct={dailyMicros.vitaminB12 / 2.4} colors={colors} styles={styles} low={dailyMicros.vitaminB12 > 0 && dailyMicros.vitaminB12 < 1.6} onPress={() => setDrillNutrient(drillNutrient === 'vitaminB12' ? null : 'vitaminB12')} />
                    <MicroChipLg label="Vitamin A" value={dailyMicros.vitaminA > 0 ? `${dailyMicros.vitaminA}%` : '—'} target="100% DV" pct={dailyMicros.vitaminA / 100} colors={colors} styles={styles} low={dailyMicros.vitaminA > 0 && dailyMicros.vitaminA < 50} onPress={() => setDrillNutrient(drillNutrient === 'vitaminA' ? null : 'vitaminA')} />
                  </View>

                  {!hasMicros && <Text style={styles.microNoData}>Nutrition details load with your next plan.</Text>}
                </View>

                {/* Legend */}
                <View style={{ flexDirection: 'row', gap: 16, paddingVertical: 12, justifyContent: 'center' }}>
                  {[
                    { label: 'On track', color: colors.primary },
                    { label: 'Below target', color: colors.warning },
                    { label: 'Above target', color: colors.error },
                    { label: 'Whole', color: colors.success },
                    { label: 'Processed', color: colors.error },
                  ].map(l => (
                    <View key={l.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: l.color }} />
                      <Text style={{ fontSize: 9, color: colors.textMuted }}>{l.label}</Text>
                    </View>
                  ))}
                </View>
              </ScrollView>
            </View>
          </View>
        </Modal>

        {/* Plant vs Meat protein drill-down modal */}
        <Modal
          visible={showProteinModal}
          transparent
          animationType="slide"
          onRequestClose={() => setShowProteinModal(false)}>
          <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' }}>
            <View style={{
              backgroundColor: colors.background,
              borderTopLeftRadius: 24, borderTopRightRadius: 24,
              padding: 18, maxHeight: '85%',
            }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
                <Text style={{ fontSize: 18, fontWeight: '800', color: colors.textPrimary, flex: 1 }}>
                  Protein source today
                </Text>
                <TouchableOpacity onPress={() => setShowProteinModal(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="close" size={22} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
              {effectiveProteinBreakdown && (() => {
                const plantG = effectiveProteinBreakdown.plant_total_g;
                const animalG = effectiveProteinBreakdown.animal_total_g;
                const total = plantG + animalG;
                const plantPct = total > 0 ? (plantG / total) * 100 : 0;
                return (
                  <ScrollView showsVerticalScrollIndicator={false}>
                    <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
                      <View style={{ flex: 1, padding: 12, backgroundColor: '#22C55E22', borderRadius: 10 }}>
                        <Text style={{ fontSize: 10, color: '#16803D', fontWeight: '800', letterSpacing: 0.5 }}>PLANT</Text>
                        <Text style={{ fontSize: 22, fontWeight: '900', color: '#16803D', marginTop: 4 }}>
                          {Math.round(plantG)}<Text style={{ fontSize: 12, fontWeight: '700' }}>g</Text>
                        </Text>
                        <Text style={{ fontSize: 10, color: '#16803D' }}>{Math.round(plantPct)}% of protein</Text>
                      </View>
                      <View style={{ flex: 1, padding: 12, backgroundColor: '#E0783022', borderRadius: 10 }}>
                        <Text style={{ fontSize: 10, color: '#9A4810', fontWeight: '800', letterSpacing: 0.5 }}>ANIMAL</Text>
                        <Text style={{ fontSize: 22, fontWeight: '900', color: '#9A4810', marginTop: 4 }}>
                          {Math.round(animalG)}<Text style={{ fontSize: 12, fontWeight: '700' }}>g</Text>
                        </Text>
                        <Text style={{ fontSize: 10, color: '#9A4810' }}>{Math.round(100 - plantPct)}% of protein</Text>
                      </View>
                    </View>

                    {effectiveProteinBreakdown.plant.length > 0 && (
                      <>
                        <Text style={{ fontSize: 12, fontWeight: '800', color: '#16803D', letterSpacing: 0.5, marginTop: 4, marginBottom: 6 }}>
                          PLANT SOURCES
                        </Text>
                        {effectiveProteinBreakdown.plant.map((it, i) => (
                          <View key={`p-${i}`} style={{
                            flexDirection: 'row', alignItems: 'center',
                            paddingVertical: 8, paddingHorizontal: 10, marginBottom: 6,
                            backgroundColor: colors.surface, borderRadius: 8,
                            borderLeftWidth: 3, borderLeftColor: '#22C55E',
                          }}>
                            <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: colors.textPrimary }}>{it.name}</Text>
                            <Text style={{ fontSize: 13, fontWeight: '800', color: '#16803D' }}>{Math.round(it.protein_g)}g</Text>
                          </View>
                        ))}
                      </>
                    )}

                    {effectiveProteinBreakdown.animal.length > 0 && (
                      <>
                        <Text style={{ fontSize: 12, fontWeight: '800', color: '#9A4810', letterSpacing: 0.5, marginTop: 10, marginBottom: 6 }}>
                          ANIMAL SOURCES
                        </Text>
                        {effectiveProteinBreakdown.animal.map((it, i) => (
                          <View key={`a-${i}`} style={{
                            flexDirection: 'row', alignItems: 'center',
                            paddingVertical: 8, paddingHorizontal: 10, marginBottom: 6,
                            backgroundColor: colors.surface, borderRadius: 8,
                            borderLeftWidth: 3, borderLeftColor: '#E07830',
                          }}>
                            <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: colors.textPrimary }}>{it.name}</Text>
                            <Text style={{ fontSize: 13, fontWeight: '800', color: '#9A4810' }}>{Math.round(it.protein_g)}g</Text>
                          </View>
                        ))}
                      </>
                    )}

                    {effectiveProteinBreakdown.unclassified.length > 0 && (
                      <>
                        <Text style={{ fontSize: 12, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.5, marginTop: 10, marginBottom: 6 }}>
                          UNCLASSIFIED
                        </Text>
                        <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 6, fontStyle: 'italic' }}>
                          We don't know if these are plant or animal yet — re-log with a library food to classify.
                        </Text>
                        {effectiveProteinBreakdown.unclassified.map((it, i) => (
                          <View key={`u-${i}`} style={{
                            flexDirection: 'row', alignItems: 'center',
                            paddingVertical: 8, paddingHorizontal: 10, marginBottom: 6,
                            backgroundColor: colors.surface, borderRadius: 8,
                            borderLeftWidth: 3, borderLeftColor: colors.border,
                          }}>
                            <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: colors.textPrimary }}>{it.name}</Text>
                            <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textMuted }}>{Math.round(it.protein_g)}g</Text>
                          </View>
                        ))}
                      </>
                    )}

                    <View style={{ height: 24 }} />
                  </ScrollView>
                );
              })()}
            </View>
          </View>
        </Modal>

        {/* Meal rows — single unified list. Order is whatever the user
            arranged with the up/down arrows. Routines are tagged with a
            📌 emoji but are otherwise rendered identically to other meals. */}
        <View style={[styles.meals, embedded && styles.mealsEmbedded]}>
          {visibleMeals.length > 0 && !swipeHintDismissed && (
            <TouchableOpacity
              onPress={() => setSwipeHintDismissed(true)}
              activeOpacity={0.6}
              hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
              style={{ paddingHorizontal: 2, paddingBottom: 6, marginTop: -2 }}>
              <Text style={{ fontSize: 10, color: colors.textMuted, fontStyle: 'italic' }}>
                swipe a meal to see actions
              </Text>
            </TouchableOpacity>
          )}
          {visibleMeals.map(({ key, emoji, meal }, i) => (
            <FadeInView key={key} delay={i * 40} duration={260} slideDistance={8}>
            <MealRow
              emoji={emoji}
              mealType={key}
              meal={meal}
              checked={!!checkedMeals[key]}
              onToggle={onToggleMeal}
              onEdit={onEditMeal}
              onRemove={onRemoveMeal}
              onHardDelete={onHardDeleteMeal}
              onToggleRoutine={onToggleRoutine}
              onShowRecipe={onShowRecipe}
              onMoveUp={i > 0 && onMoveMeal ? () => onMoveMeal(key, -1) : undefined}
              onMoveDown={i < visibleMeals.length - 1 && onMoveMeal ? () => onMoveMeal(key, 1) : undefined}
              onRenameMeal={onRenameMeal}
              onShuffle={onShuffleMeal ? () => onShuffleMeal(key, meal) : undefined}
              isShuffling={shufflingMealKey === key}
              onToggleSave={onToggleSave}
              colors={colors}
              styles={styles}
              mealAccent={section}
              isSaved={(savedMealNames ?? new Set<string>()).has((meal.meal || '').toLowerCase().trim())}
            />
            </FadeInView>
          ))}
          {hiddenMeals.length > 0 && (
            <View style={styles.hiddenMealRow}>
              <Text style={styles.hiddenMealText}>Removed: {hiddenMeals.map(m => m.meal.meal).join(', ')}</Text>
              <View style={styles.restoreWrap}>
                {hiddenMeals.map(m => (
                  <TouchableOpacity key={m.key} style={styles.restoreBtn} onPress={() => onRestoreMeal?.(m.key)}>
                    <Text style={styles.restoreBtnText}>Restore {m.meal.meal}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}
          {/* Add-meal footer. When the user has any saved meals the
              button splits into two side-by-side paths: "Empty meal"
              (original behavior) and "From saved". Keeps the single-
              button treatment when there are no saved meals yet. */}
          {onAddSnack && onAddFromSaved && (savedMealNames?.size ?? 0) > 0 ? (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <TouchableOpacity
                style={[styles.addMealInline, { flex: 1, marginTop: 0 }]}
                onPress={onAddSnack}
                activeOpacity={0.7}
              >
                <Ionicons name="add-circle-outline" size={16} color={section.strong} style={{ marginRight: 4 }} />
                <Text style={styles.addMealInlineText}>Empty meal</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.addMealInline, { flex: 1, marginTop: 0 }]}
                onPress={onAddFromSaved}
                activeOpacity={0.7}
              >
                <Ionicons name="heart-outline" size={16} color={section.strong} style={{ marginRight: 4 }} />
                <Text style={styles.addMealInlineText}>From Favorites</Text>
              </TouchableOpacity>
            </View>
          ) : onAddSnack ? (
            <TouchableOpacity style={styles.addMealInline} onPress={onAddSnack} activeOpacity={0.7}>
              <Ionicons name="add-circle-outline" size={16} color={section.strong} style={{ marginRight: 4 }} />
              <Text style={styles.addMealInlineText}>Add Meal</Text>
            </TouchableOpacity>
          ) : null}
        </View>

      </View>
    </View>
  );
}

// ── MacroTracker ──────────────────────────────────────────────────────────────

function MacroTracker({
  label, actual, target, unit, color, colors, styles,
}: {
  label: string; actual: number; target: number; unit: string; color: string;
  colors: ReturnType<typeof getTheme>['colors'];
  styles: ReturnType<typeof createStyles>;
}) {
  const pct      = target > 0 ? Math.min(actual / target, 1) : 0;
  const over     = actual > target;
  const barColor = over ? colors.error : color;
  const barAnim  = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(barAnim, {
      toValue: Math.round(pct * 100),
      duration: 500,
      useNativeDriver: false,
    }).start();
  }, [pct]);

  return (
    <View style={styles.macroTracker}>
      <Text style={styles.macroTrackerLabel}>{label}</Text>
      <View style={styles.macroTrackerValues}>
        <AnimatedNumber value={actual} suffix={unit} style={[styles.macroActual, { color: over ? colors.error : color }]} />
        <Text style={styles.macroSep}>/</Text>
        <Text style={styles.macroTarget}>{target}{unit}</Text>
      </View>
      <View style={styles.macroBarTrack}>
        <Animated.View style={[styles.macroBarFill, {
          width: barAnim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
          backgroundColor: barColor,
        }]} />
      </View>
      {over && (
        <Text style={[styles.macroRemaining, { color: colors.error }]}>
          +{actual - target}{unit}
        </Text>
      )}
    </View>
  );
}

// ── MealRow ───────────────────────────────────────────────────────────────────

function MealRow({ mealType, meal, checked, onToggle, onEdit, onRemove, onHardDelete, onToggleRoutine, onShowRecipe, onRenameMeal, onMoveUp, onMoveDown, onShuffle, isShuffling, onToggleSave, colors, styles, mealAccent, isSaved }: {
  emoji?: string;  // unused — kept on the type for back-compat with callers
  mealType: string;
  meal: MealSuggestion;
  checked: boolean;
  onToggle?: (mealType: string) => void;
  onEdit?:   (mealType: string, meal: MealSuggestion) => void;
  onRemove?: (mealType: string) => void;
  onHardDelete?: (mealType: string) => void;
  onToggleRoutine?: (mealType: string) => void;
  onShowRecipe?: (mealType: string, meal: MealSuggestion) => void;
  onRenameMeal?: (mealType: string, newName: string) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onShuffle?: () => void;
  isShuffling?: boolean;
  onToggleSave?: (mealType: string, meal: MealSuggestion) => void;
  colors: ReturnType<typeof getTheme>['colors'];
  styles: ReturnType<typeof createStyles>;
  mealAccent: ReturnType<typeof getTheme>['sections']['meals'];
  /** True when this meal's name matches one of the user's Saved Meals.
   *  Surfaces a star icon in the header so users can save/unsave. */
  isSaved?: boolean;
}) {
  void onHardDelete;
  const [itemsExpanded, setItemsExpanded] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(meal.meal);
  const isRoutineBacked = !!(meal as any)._routineId || !!meal.isRoutine;
  const isProtectedMeal = isRoutineBacked || !!(meal as any)._localId;
  useEffect(() => { if (!editingName) setNameDraft(meal.meal); }, [meal.meal, editingName]);

  // Meal-row animation values:
  //   • checkScale — drives the check icon's spring from 0 → 1.2 → 1.0
  //     so it pops in when the user taps the checkbox.
  //   • rowFlash — drives a brief green background flash on the row,
  //     mirroring the set-complete pulse on the workout side.
  // `lastChecked` tracks the previous `checked` prop so we only fire
  // when the value transitions false → true.
  const checkScale = useRef(new Animated.Value(checked ? 1 : 0)).current;
  const rowFlash = useRef(new Animated.Value(0)).current;
  const lastChecked = useRef<boolean>(checked);
  useEffect(() => {
    if (checked && !lastChecked.current) {
      // Light haptic on check (best-effort — feedback util is async-imported
      // to avoid pulling the module on cold start).
      import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
      checkScale.setValue(0);
      rowFlash.setValue(0);
      Animated.parallel([
        Animated.sequence([
          Animated.spring(checkScale, { toValue: 1.2, friction: 4, tension: 120, useNativeDriver: true }),
          Animated.spring(checkScale, { toValue: 1.0, friction: 5, tension: 120, useNativeDriver: true }),
        ]),
        Animated.sequence([
          // Non-native driver (background color) — only runs 650ms total.
          Animated.timing(rowFlash, { toValue: 1, duration: 250, useNativeDriver: false }),
          Animated.timing(rowFlash, { toValue: 0, duration: 400, useNativeDriver: false }),
        ]),
      ]).start();
    } else if (!checked && lastChecked.current) {
      // Reset silently on uncheck.
      checkScale.setValue(0);
      rowFlash.setValue(0);
    }
    lastChecked.current = checked;
  }, [checked, checkScale, rowFlash]);
  const rowFlashBg = rowFlash.interpolate({
    inputRange: [0, 1],
    outputRange: ['transparent', mealAccent.strong + '33'],
  });
  const commitRename = () => {
    const trimmed = nameDraft.trim();
    setEditingName(false);
    if (trimmed && trimmed !== meal.meal && onRenameMeal) {
      onRenameMeal(mealType, trimmed);
    } else {
      setNameDraft(meal.meal);
    }
  };
  const withItems = ensureItems(meal);
  const itemRows = withItems.items && withItems.items.length > 0
    ? withItems.items.map((it, i) => ({
        key: `${it.name}-${i}`,
        name: it.name,
        amount: formatItemAmount(it),
        quality: classifyFood(it.name, it.food_quality),
      }))
    : meal.foods.map((f, i) => ({
        key: `${f}-${i}`,
        name: f,
        amount: meal.amounts?.[i] ?? '',
        quality: classifyFood(f),
      }));

  const swipeActions: SwipeAction[] = [];
  if (onShowRecipe) swipeActions.push({ icon: 'restaurant-outline', color: getContrastingTextColor(colors.primary), bgColor: colors.primary, onPress: () => onShowRecipe(mealType, meal), label: 'Recipe' });
  if (onShuffle) swipeActions.push({ icon: 'shuffle', color: getContrastingTextColor(mealAccent.strong), bgColor: mealAccent.strong, onPress: onShuffle, label: 'Shuffle' });
  if (onMoveUp) swipeActions.push({ icon: 'arrow-up', color: '#fff', bgColor: '#6B7280', onPress: onMoveUp });
  if (onMoveDown) swipeActions.push({ icon: 'arrow-down', color: '#fff', bgColor: '#6B7280', onPress: onMoveDown });
  if (onRemove) swipeActions.push({ icon: 'trash-outline', color: '#fff', bgColor: colors.error ?? '#EF4444', onPress: () => onRemove(mealType), label: 'Remove' });

  return (
    <SwipeableRow actions={swipeActions}>
    <Animated.View testID={`meal-row-${mealType}`} style={[styles.mealItem, checked && styles.mealItemDone, { backgroundColor: rowFlashBg }]}>
      {/* Title row — checkbox + meal name + inline pin badge + actions. */}
      <View style={styles.mealHeader}>
        <TouchableOpacity
          testID={`meal-check-${mealType}`}
          style={[styles.checkbox, checked && styles.checkboxDone]}
          onPress={() => onToggle?.(mealType)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="checkbox"
          accessibilityLabel={`Mark ${meal.meal} as ${checked ? 'not done' : 'done'}`}
          accessibilityState={{ checked }}>
          {checked && (
            <Animated.View style={{ transform: [{ scale: checkScale }] }}>
              <Ionicons name="checkmark" size={14} color="#fff" />
            </Animated.View>
          )}
        </TouchableOpacity>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {editingName && onRenameMeal ? (
              <TextInput
                value={nameDraft}
                onChangeText={setNameDraft}
                onBlur={commitRename}
                onSubmitEditing={commitRename}
                autoFocus
                returnKeyType="done"
                blurOnSubmit
                maxLength={80}
                style={[
                  styles.mealName,
                  {
                    flexShrink: 1,
                    minWidth: 120,
                    paddingVertical: 2,
                    paddingHorizontal: 4,
                    borderBottomWidth: 1,
                    borderBottomColor: mealAccent.strong,
                    color: colors.textPrimary,
                  },
                ]}
                accessibilityLabel="Rename meal"
              />
            ) : (
              <>
                <TouchableOpacity
                  onPress={() => { if (onRenameMeal) setEditingName(true); }}
                  activeOpacity={0.7}
                  style={{ flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 4 }}
                  accessibilityRole="button"
                  accessibilityLabel={`Meal: ${meal.meal}. Tap to rename.`}>
                  <Text
                    testID={`meal-row-name-${e2eId(meal.meal)}`}
                    style={[styles.mealName, checked && styles.mealNameDone]}
                    numberOfLines={2}
                    ellipsizeMode="tail">
                    {meal.meal}
                  </Text>
                  {onRenameMeal && (
                    <Ionicons
                      name="pencil"
                      size={11}
                      color={colors.textMuted}
                      style={{ opacity: 0.6 }}
                    />
                  )}
                </TouchableOpacity>
              </>
            )}
            {isProtectedMeal && (
              <View style={[
                styles.protectedBadge,
                {
                  backgroundColor: mealAccent.strong + '16',
                  borderColor: mealAccent.strong + '55',
                },
              ]}>
                <Ionicons
                  name={isRoutineBacked ? 'repeat-outline' : 'shield-checkmark-outline'}
                  size={10}
                  color={mealAccent.strong}
                />
                <Text {...dynamicCompactTextProps} style={[styles.protectedBadgeText, { color: mealAccent.strong }]}>
                  {isRoutineBacked ? 'Routine' : 'Protected'}
                </Text>
              </View>
            )}
          </View>
        </View>
        {/* Secondary icon strip — pencil (edit) stays muted + outlined so
            it reads as a secondary action, not the primary CTA. The
            primary action on a meal row is the check box on the left. */}
        <View style={styles.iconStrip}>
          {isShuffling && (
            <ActivityIndicator size="small" color={mealAccent.strong} style={{ marginRight: 4 }} />
          )}
          {onToggleRoutine && (
            <TouchableOpacity
              onPress={() => onToggleRoutine(mealType)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={[styles.iconBtn, isRoutineBacked && { backgroundColor: mealAccent.strong + '18', borderColor: mealAccent.strong + '44' }]}
              accessibilityRole="button"
              accessibilityLabel={isRoutineBacked ? `Unpin ${meal.meal} routine` : `Pin ${meal.meal} as a routine`}>
              <Ionicons name={isRoutineBacked ? 'repeat' : 'repeat-outline'} size={16} color={isRoutineBacked ? mealAccent.strong : colors.textMuted} />
            </TouchableOpacity>
          )}
          {onToggleSave && (
            <TouchableOpacity
              onPress={() => onToggleSave(mealType, meal)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={isSaved ? `Remove ${meal.meal} from favorites` : `Add ${meal.meal} to favorites`}
              style={[styles.iconBtn, isSaved && { backgroundColor: mealAccent.strong + '18', borderColor: mealAccent.strong + '44' }]}>
              <Ionicons name={isSaved ? 'star' : 'star-outline'} size={16} color={isSaved ? mealAccent.strong : colors.textMuted} />
            </TouchableOpacity>
          )}
          {onEdit && (
            <TouchableOpacity onPress={() => onEdit(mealType, meal)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel={`Edit ${meal.meal}`}>
              <Ionicons name="pencil-outline" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Item list — collapsed by default, tap to expand */}
      {itemRows.length > 0 && !itemsExpanded ? (
        <TouchableOpacity onPress={() => { configureExpandAnimation(300); setItemsExpanded(true); }} activeOpacity={0.7} style={{ paddingVertical: 3, paddingLeft: 32 }}>
          <Text style={{ fontSize: 12, color: colors.textSecondary, fontWeight: '500' }}>
            {itemRows.length} item{itemRows.length !== 1 ? 's' : ''} · tap to see details
          </Text>
        </TouchableOpacity>
      ) : itemRows.length > 0 ? (
        <TouchableOpacity onPress={() => { configureExpandAnimation(300); setItemsExpanded(false); }} activeOpacity={0.9}>
          <View style={styles.mealFoodsDetail}>
            {itemRows.map(r => (
              <View key={r.key} style={styles.mealFoodRow}>
                <View style={{ width: 6, height: 6, borderRadius: 3, marginRight: 6, marginTop: 5, backgroundColor: r.quality === 'whole' ? '#22C55E' : r.quality === 'processed' ? '#EF4444' : colors.border }} />
                <Text style={[styles.mealFoodName, checked && styles.mealFoodsDone, { flex: 1 }]}>
                  {r.name}
                </Text>
                {r.quality === 'processed' && (
                  <Text style={{ fontSize: 9, color: '#EF4444', fontWeight: '600', marginRight: 6 }}>Processed</Text>
                )}
                {r.amount ? (
                  <Text style={styles.mealFoodAmount}>{r.amount}</Text>
                ) : null}
              </View>
            ))}
            {meal.instructions && (
              <View style={styles.recipeBox}>
                <Text style={styles.recipeLabel}>Recipe</Text>
                <Text style={styles.recipeText} numberOfLines={3}>{meal.instructions}</Text>
              </View>
            )}
          </View>
        </TouchableOpacity>
      ) : null}

      {/* Macro pills — Layer 1 only. Sugar/sodium show ONLY when
          notably high so the row stays uncluttered. Thresholds are
          ~30% of daily cap, meaning one meal alone is spiking them. */}
      {(() => {
        const fiber = Math.round(meal.fiber ?? meal.micronutrients?.fiber ?? 0);
        const sugar = Math.round(meal.micronutrients?.sugar ?? 0);
        const addedSugar = Math.round((meal.micronutrients as any)?.added_sugar ?? 0);
        const sodium = Math.round((meal.micronutrients as any)?.sodium_mg ?? meal.micronutrients?.sodium ?? 0);
        const highSugar = addedSugar > 0 ? addedSugar >= 10 : sugar >= 15;
        const highSodium = sodium >= 700;
        return (
          <View style={styles.mealBadges}>
            <MacroPill label="cal" value={Math.round(meal.calories)} color={mealAccent.strong} styles={styles} />
            <MacroPill label="p"   value={Math.round(meal.protein)}  color={colors.primary}    styles={styles} />
            <MacroPill label="c"   value={Math.round(meal.carbs ?? 0)} color="#F59E0B"         styles={styles} />
            <MacroPill label="f"   value={Math.round(meal.fat ?? 0)}   color="#A78BFA"         styles={styles} />
            {fiber > 0 && <MacroPill label="fiber" value={fiber} color="#10B981" styles={styles} />}
            {highSugar && <MacroPill label={addedSugar > 0 ? 'added sugar' : 'sugar'} value={addedSugar > 0 ? addedSugar : sugar} color="#EF4444" styles={styles} />}
            {highSodium && <MacroPill label="sodium" value={sodium} color="#EF4444" styles={styles} />}
          </View>
        );
      })()}
    </Animated.View>
    </SwipeableRow>
  );
}

function MicroChipLg({ label, value, target, pct, colors, styles, warn, low, onPress }: {
  label: string; value: string; target: string; pct: number;
  colors: ReturnType<typeof getTheme>['colors'];
  styles: ReturnType<typeof createStyles>;
  warn?: boolean; low?: boolean;
  onPress?: () => void;
}) {
  const barPct = Math.min(pct, 1);
  const noData = value === '—';
  const barColor = noData ? colors.border : warn ? colors.error : low ? '#F59E0B' : colors.primary;
  const Wrapper = onPress ? TouchableOpacity : View;
  const wrapperProps = onPress ? { onPress, activeOpacity: 0.7 } : {};
  return (
    <Wrapper {...wrapperProps} style={styles.microChipLg}>
      <View style={styles.microChipLgTop}>
        <Text style={[styles.microChipLgLabel, (warn || low) && { color: barColor }]}>{label}</Text>
        <Text style={[styles.microChipLgValue, noData ? { color: colors.textMuted } : (warn || low) && { color: barColor }]}>{value}</Text>
      </View>
      <View style={styles.microChipLgBarTrack}>
        <View style={[styles.microChipLgBarFill, { width: `${Math.round(barPct * 100)}%` as any, backgroundColor: barColor }]} />
      </View>
      <Text style={[styles.microChipLgTarget, (warn || low) && { color: barColor }]}>{target}</Text>
    </Wrapper>
  );
}

function MacroPill({ label, value, color, styles }: { label: string; value: number; color: string; styles: ReturnType<typeof createStyles> }) {
  return (
    <View style={[styles.pill, { borderColor: color + '55' }]}>
      <Text style={[styles.pillValue, { color }]}>{value}</Text>
      <Text style={styles.pillLabel}>{label}</Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const createStyles = (
  colors: ReturnType<typeof getTheme>['colors'],
  section: ReturnType<typeof getTheme>['sections']['meals'],
) => StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 22,
    marginBottom: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    ...elevations.card,
  },
  cardEmbedded: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderColor: 'transparent',
    borderRadius: 0,
    marginBottom: 0,
    overflow: 'visible',
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    elevation: 0,
  },

  // ── Body ─────────────────────────────────────────────────────────────────────
  body: { padding: 14 },
  bodyEmbedded: {
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 0,
  },

  // Optional small subtitle when the parent passes a `title` prop
  // (used by the day-card flow to label "Today" / "Tomorrow"). Replaces
  // the old top-of-card header bar.
  titleSubtle: {
    ...typography.label,
    color: colors.textMuted,
    marginBottom: 10,
  },

  // Inline "+ Add Meal" affordance at the bottom of the meal list,
  // replacing the old top-of-card pill button. Dashed border keeps it
  // visually distinct from real meal rows.
  addMealInline: {
    marginTop: 8,
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: section.strong + '55',
    borderStyle: 'dashed',
    alignItems: 'center',
    backgroundColor: section.soft,
  },
  addMealInlineText: {
    fontSize: 13,
    fontWeight: '700',
    color: section.strong,
  },

  // ── Modal card section ────────────────────────────────────────────────────────
  modalCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 16,
    marginBottom: 12,
  },

  // ── Macro grid ────────────────────────────────────────────────────────────────
  macrosGrid: {
    flexDirection: 'row',
    paddingVertical: 10,
    paddingHorizontal: 8,
    marginBottom: 14,
    gap: 2,
    backgroundColor: section.soft,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: section.strong + '20',
  },
  macroTracker: { flex: 1, alignItems: 'center', gap: 3 },
  macroTrackerLabel: {
    ...typography.micro,
    color: colors.textSecondary,
  },
  macroTrackerValues: { flexDirection: 'row', alignItems: 'baseline', gap: 2 },
  macroActual:  { ...typography.cardTitle },
  macroSep:     { ...typography.micro, color: colors.textMuted },
  macroTarget:  { ...typography.micro, color: colors.textMuted },
  macroBarTrack: {
    width: '100%', height: 3,
    backgroundColor: colors.border,
    borderRadius: 2,
    overflow: 'hidden',
  },
  macroBarFill:   { height: 3, borderRadius: 2 },
  macroRemaining: { ...typography.micro },

  // ── Meals ────────────────────────────────────────────────────────────────────
  meals: { gap: 10, marginBottom: 14 },
  mealsEmbedded: { marginBottom: 0, gap: 9 },

  mealItem: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 6,
    ...elevations.subtle,
  },
  // Completed state: no opacity fade — full strength with strikethrough
  // title + muted subtitle so it reads "done", not "dead".
  mealItemDone: { borderColor: section.strong + '55', backgroundColor: section.soft + '66' },

  mealHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },

  // Inline routine badge — small pill that sits next to the meal name
  // instead of taking its own row. Toggles pin/unpin on tap.
  routineBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
  },
  routineBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  protectedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  protectedBadgeText: {
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.25,
  },

  // Trailing icon strip — reorder + actions, all icon-only, single row.
  // Replaces the old separate "pin row" and "action row".
  iconStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  iconBtn: {
    width: 26,
    height: 26,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnText: {
    fontSize: 14,
    color: colors.textSecondary,
    fontWeight: '600',
  },

  checkbox: {
    width: 22, height: 22, borderRadius: 6,
    borderWidth: 2, borderColor: section.strong + '88',
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  checkboxDone: { backgroundColor: section.strong, borderColor: section.strong },
  checkmark:    { fontSize: 12, color: '#fff', fontWeight: '800' },

  mealName:     { ...typography.sectionTitle, color: colors.textPrimary },
  mealNameDone: { textDecorationLine: 'line-through', color: colors.textSecondary },

  mealFoodsDetail: { gap: 3, marginTop: 6, paddingLeft: 32 },
  mealFoodRow:     { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  mealFoodName:    { ...typography.body, color: colors.textSecondary, lineHeight: 17 },
  mealFoodsDone:   { color: colors.textMuted },

  recipeBox: {
    backgroundColor: colors.background,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
    marginTop: 4,
  },
  recipeLabel: { ...typography.micro, color: colors.textSecondary, marginBottom: 4 },
  recipeText:  { ...typography.body, color: colors.textPrimary, lineHeight: 18 },

  mealBadges: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 2 },

  hiddenMealRow: {
    backgroundColor: section.soft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: section.strong + '44',
    padding: 10,
    gap: 8,
  },
  hiddenMealText: { fontSize: 12, color: colors.textSecondary },
  restoreWrap:    { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  restoreBtn: {
    backgroundColor: colors.surface,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: section.strong,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  restoreBtnText: { fontSize: 12, color: section.text, fontWeight: '700' },

  pill: {
    backgroundColor: colors.background,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignItems: 'center',
    minWidth: 44,
  },
  pillValue: { ...typography.bodyStrong },
  pillLabel: { ...typography.micro, color: colors.textMuted, marginTop: 1 },

  // ── Nutrition details inline link (muted, supplementary) ────────────────
  microBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingVertical: 4,
    marginBottom: 10,
    gap: 3,
  },
  microBtnIcon: { fontSize: 11 },
  microBtnText: { fontSize: 12, fontWeight: '500', color: colors.textMuted },
  microBtnArrow: { fontSize: 12, fontWeight: '500', color: colors.textMuted, marginLeft: 1 },

  // ── Micro modal ──────────────────────────────────────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 36,
    maxHeight: '88%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalTitle: { fontSize: 17, fontWeight: '800', color: colors.textPrimary },
  modalClose: { fontSize: 18, fontWeight: '700', color: colors.textMuted, padding: 4 },
  modalScroll: { paddingHorizontal: 18, paddingTop: 14 },
  modalMacroRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 18,
  },
  modalMacroItem: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: section.soft,
    borderRadius: radius.md,
    paddingVertical: 10,
    gap: 2,
  },
  modalMacroVal: { fontSize: 16, fontWeight: '800' },
  modalMacroLabel: { fontSize: 9, fontWeight: '600', color: colors.textMuted },
  modalSectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  modalLegend: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 18,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 11, color: colors.textMuted, fontWeight: '500' },

  // ── Large micro chips (modal) ─────────────────────────────────────────────
  microGridLg: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  microChipLg: {
    width: '47%' as any,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
    gap: 4,
  },
  microChipLgTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  microChipLgLabel: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  microChipLgValue: { fontSize: 15, fontWeight: '800', color: colors.textPrimary },
  microChipLgBarTrack: {
    height: 5,
    backgroundColor: colors.border,
    borderRadius: 3,
    overflow: 'hidden',
  },
  microChipLgBarFill: { height: 5, borderRadius: 3 },
  microChipLgTarget: { fontSize: 10, fontWeight: '500', color: colors.textMuted },
  microNoData: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: 12,
    paddingHorizontal: 20,
    lineHeight: 18,
  },

  // ── Footer ───────────────────────────────────────────────────────────────────
  footer:     { paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border },
  footerText: { fontSize: 12, color: colors.textMuted, textAlign: 'center' },

  mealFoodAmount: {
    fontSize: 11,
    fontWeight: '700',
    color: section.strong,
  },
});
