import { useState, useMemo, useEffect, useRef } from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity, Modal, ScrollView, LayoutAnimation, Platform, UIManager, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import { DailyNutritionPlan, MealSuggestion, MealMicronutrients, AppThemeName } from '../types';
import { getTheme, radius } from '../constants/theme';
import { ensureItems, formatItemAmount } from '../utils/mealItems';
import { computeDayInsights } from '../utils/nutritionLayers';
import { classifyFood, computeNutritionScore } from '../utils/nutritionScore';
import NutritionInsightCard from './NutritionInsightCard';
import SwipeableRow, { SwipeAction } from './SwipeableRow';
import AnimatedNumber from './AnimatedNumber';

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
  goal?: string;
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
  goal,
}: NutritionCardProps) {
  const [showMicroModal, setShowMicroModal] = useState(false);
  const [scoreExpanded, setScoreExpanded] = useState(false);
  const dayScore = useMemo(() => computeNutritionScore(nutritionPlan, goal ?? 'body_recomp'), [nutritionPlan, goal]);
  const [drillNutrient, setDrillNutrient] = useState<string | null>(null);
  const [swipeHintDismissed, setSwipeHintDismissed] = useState(false);
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
    { out: 'cholesterol',        keys: ['cholesterol'] },
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

  return (
    <View style={styles.card}>
      {/* Header removed — the macro grid below acts as the hero. The
          "+ Add Meal" affordance moved to the bottom of the meal list
          so the card opens with the user's macros front-and-center,
          matching the WorkoutCard hierarchy (hero → stats → list). */}
      <View style={styles.body}>
        {title ? <Text style={styles.titleSubtle}>{title}</Text> : null}
        {/* Macro tracker grid */}
        <View style={styles.macrosGrid}>
          <MacroTracker label="Calories" actual={actual.calories} target={targets.calories} unit=""  color={section.strong}    colors={colors} styles={styles} />
          <MacroTracker label="Protein"  actual={actual.protein}  target={targets.protein}  unit="g" color={colors.primary}    colors={colors} styles={styles} />
          <MacroTracker label="Carbs"    actual={actual.carbs}    target={targets.carbs}    unit="g" color="#F59E0B"           colors={colors} styles={styles} />
          <MacroTracker label="Fat"      actual={actual.fat}      target={targets.fat}      unit="g" color="#A78BFA"           colors={colors} styles={styles} />
        </View>
        {/* Day score — tap to expand breakdown */}
        {dayScore.score > 0 && (() => {
          const sc = dayScore;
          const scoreColor = sc.score >= 70 ? '#22C55E' : sc.score >= 45 ? '#F59E0B' : '#EF4444';
          return (
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setScoreExpanded(p => !p); }}
              style={{ marginBottom: 6, marginTop: 2, backgroundColor: colors.surfaceRaised, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: colors.border }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: scoreColor + '18', alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontSize: 14, fontWeight: '900', color: scoreColor }}>{sc.score}</Text>
                  </View>
                  <View>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textPrimary }}>Nutrition Score</Text>
                    <Text style={{ fontSize: 10, color: colors.textMuted }}>
                      {sc.wins.length > 0 ? sc.wins[0] : sc.improvements.length > 0 ? sc.improvements[0] : 'Tap for details'}
                    </Text>
                  </View>
                </View>
                <Ionicons name={scoreExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} />
              </View>
              {scoreExpanded && (
                <View style={{ marginTop: 8, gap: 5 }}>
                  {[
                    { label: 'Adherence', value: sc.adherence, color: sc.adherence >= 70 ? '#22C55E' : sc.adherence >= 45 ? '#F59E0B' : '#EF4444' },
                    { label: 'Food Quality', value: sc.quality, color: sc.quality >= 70 ? '#22C55E' : sc.quality >= 45 ? '#F59E0B' : '#EF4444' },
                    { label: 'Micronutrients', value: sc.micro, color: sc.micro >= 70 ? '#22C55E' : sc.micro >= 45 ? '#F59E0B' : '#EF4444' },
                  ].map(sub => (
                    <View key={sub.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={{ fontSize: 10, fontWeight: '600', color: colors.textSecondary, width: 80 }}>{sub.label}</Text>
                      <View style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.border }}>
                        <View style={{ width: `${Math.min(100, sub.value)}%` as any, height: 4, borderRadius: 2, backgroundColor: sub.color }} />
                      </View>
                      <Text style={{ fontSize: 10, fontWeight: '700', color: sub.color, width: 24, textAlign: 'right' }}>{sub.value}</Text>
                    </View>
                  ))}
                  {sc.indicators && (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
                      {sc.indicators.total_calories > 0 && (
                        <Text style={{ fontSize: 9, color: colors.textMuted }}>
                          {Math.round(sc.indicators.total_calories)} / {Math.round(sc.indicators.target_calories)} cal
                        </Text>
                      )}
                      {sc.indicators.total_protein > 0 && (
                        <Text style={{ fontSize: 9, color: colors.textMuted }}>
                          {Math.round(sc.indicators.total_protein)} / {Math.round(sc.indicators.target_protein)}g protein
                        </Text>
                      )}
                      {sc.indicators.whole_food_pct > 0 && (
                        <Text style={{ fontSize: 9, color: colors.textMuted }}>
                          {sc.indicators.whole_food_pct}% whole foods
                        </Text>
                      )}
                    </View>
                  )}
                  {(sc.wins.length > 0 || sc.improvements.length > 0) && (
                    <View style={{ marginTop: 2, gap: 2 }}>
                      {sc.wins.map(w => (
                        <View key={w} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          <Ionicons name="checkmark-circle" size={11} color="#22C55E" />
                          <Text style={{ fontSize: 9, color: '#22C55E', fontWeight: '600' }}>{w}</Text>
                        </View>
                      ))}
                      {sc.improvements.map(imp => (
                        <View key={imp} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          <Ionicons name="arrow-up-circle" size={11} color="#F59E0B" />
                          <Text style={{ fontSize: 9, color: '#F59E0B', fontWeight: '600' }}>{imp}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4, paddingTop: 4, borderTopWidth: 1, borderTopColor: colors.border }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                      <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: '#22C55E' }} />
                      <Text style={{ fontSize: 9, color: colors.textMuted }}>Whole</Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                      <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: '#EF4444' }} />
                      <Text style={{ fontSize: 9, color: colors.textMuted }}>Processed</Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                      <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: colors.border }} />
                      <Text style={{ fontSize: 9, color: colors.textMuted }}>Other</Text>
                    </View>
                  </View>
                </View>
              )}
            </TouchableOpacity>
          );
        })()}
        {/* Nutrition details button + modal — always visible */}
        <TouchableOpacity
          style={styles.microBtn}
          onPress={() => setShowMicroModal(true)}
          activeOpacity={0.7}>
          <Ionicons name="bar-chart-outline" size={13} color={section.strong} />
          <Text style={styles.microBtnText}>Nutrition Details</Text>
          <Ionicons name="chevron-forward" size={14} color={section.strong} />
        </TouchableOpacity>

        <Modal
          visible={showMicroModal}
          transparent
          animationType="slide"
          onRequestClose={() => { setShowMicroModal(false); setDrillNutrient(null); }}>
          <View style={styles.modalOverlay}>
            <View style={[styles.modalContent, { backgroundColor: colors.surface }]}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Daily Nutrition Breakdown</Text>
                <TouchableOpacity onPress={() => { setShowMicroModal(false); setDrillNutrient(null); }} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                  <Ionicons name="close" size={22} color={colors.textMuted} />
                </TouchableOpacity>
              </View>

              <ScrollView style={styles.modalScroll} showsVerticalScrollIndicator={false}>
                {/* Macro summary at top */}
                <View style={styles.modalMacroRow}>
                  <View style={styles.modalMacroItem}>
                    <Text style={[styles.modalMacroVal, { color: section.strong }]}>{actual.calories}</Text>
                    <Text style={styles.modalMacroLabel}>cal / {targets.calories}</Text>
                  </View>
                  <View style={styles.modalMacroItem}>
                    <Text style={[styles.modalMacroVal, { color: colors.primary }]}>{actual.protein}g</Text>
                    <Text style={styles.modalMacroLabel}>protein / {targets.protein}g</Text>
                  </View>
                  <View style={styles.modalMacroItem}>
                    <Text style={[styles.modalMacroVal, { color: '#F59E0B' }]}>{actual.carbs}g</Text>
                    <Text style={styles.modalMacroLabel}>carbs / {targets.carbs}g</Text>
                  </View>
                  <View style={styles.modalMacroItem}>
                    <Text style={[styles.modalMacroVal, { color: '#A78BFA' }]}>{actual.fat}g</Text>
                    <Text style={styles.modalMacroLabel}>fat / {targets.fat}g</Text>
                  </View>
                </View>

                {/* Actionable insights — ≤3, sorted critical → notable */}
                {(() => {
                  const day: Record<string, number> = {
                    fiber: dailyMicros.fiber || 0,
                    sugar: dailyMicros.sugar || 0,
                    sodium: dailyMicros.sodium || 0,
                    saturatedFat: dailyMicros.saturatedFat || 0,
                    omega3: dailyMicros.omega3 || 0,
                    potassium: dailyMicros.potassium || 0,
                    calcium: dailyMicros.calcium || 0,
                    magnesium: dailyMicros.magnesium || 0,
                    vitaminD: dailyMicros.vitaminD || 0,
                    cholesterol: dailyMicros.cholesterol || 0,
                  };
                  const insights = computeDayInsights(day).slice(0, 3);
                  if (insights.length === 0) return null;
                  return (
                    <View style={{ marginBottom: 8 }}>
                      <Text style={styles.modalSectionTitle}>Key Gaps</Text>
                      {insights.map(ins => (
                        <NutritionInsightCard
                          key={ins.key}
                          insight={ins}
                          meals={allVisible.map(v => v.meal)}
                          themeColors={{
                            textPrimary: colors.textPrimary,
                            textSecondary: colors.textSecondary,
                            textMuted: colors.textMuted,
                            border: colors.border,
                            surface: colors.surface,
                            primary: colors.primary,
                            surfaceRaised: colors.surfaceRaised,
                          }}
                        />
                      ))}
                    </View>
                  );
                })()}

                {/* Nutrient drill-down — full-width panel that replaces the grid when a chip is tapped */}
                {drillNutrient && (() => {
                  const spec = microFieldSpec.find(s => s.out === drillNutrient);
                  if (!spec) return null;
                  const contributions: Array<{ food: string; meal: string; amount: number }> = [];
                  for (const { meal } of allVisible) {
                    let mealItemContributed = false;
                    for (const it of (meal.items ?? [])) {
                      const mn: any = it.micronutrients ?? {};
                      let val = 0;
                      for (const k of spec.keys) {
                        if (mn[k] != null) { val = Number(mn[k]) || 0; break; }
                      }
                      if (val > 0) {
                        contributions.push({ food: it.name, meal: meal.meal, amount: val });
                        mealItemContributed = true;
                      }
                    }
                    if (!mealItemContributed) {
                      const mn: any = meal.micronutrients ?? {};
                      let val = 0;
                      for (const k of spec.keys) {
                        if (mn[k] != null) { val = Number(mn[k]) || 0; break; }
                      }
                      if (val > 0) {
                        contributions.push({ food: meal.meal, meal: '', amount: val });
                      }
                    }
                  }
                  contributions.sort((a, b) => b.amount - a.amount);
                  const total = contributions.reduce((s, c) => s + c.amount, 0);
                  const displayLabel = spec.out.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
                  const unitStr = ['fiber', 'sugar', 'saturatedFat', 'monounsaturatedFat', 'polyunsaturatedFat'].includes(spec.out) ? 'g'
                    : ['vitaminD', 'vitaminB12'].includes(spec.out) ? 'mcg' : 'mg';
                  return (
                    <View style={{ backgroundColor: colors.primary + '15', borderRadius: 12, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: colors.primary + '33' }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                        <Text style={{ fontSize: 15, fontWeight: '700', color: colors.textPrimary }}>
                          {displayLabel} Sources
                        </Text>
                        <TouchableOpacity onPress={() => setDrillNutrient(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                          <Ionicons name="close" size={18} color={colors.textMuted} />
                        </TouchableOpacity>
                      </View>
                      {contributions.length === 0 ? (
                        <Text style={{ fontSize: 13, color: colors.textMuted, lineHeight: 18 }}>
                          Per-food breakdown will appear after your next plan regeneration. Current plans only have meal-level totals.
                        </Text>
                      ) : (
                        <>
                          {contributions.slice(0, 12).map((c, i) => {
                            const pctOfTotal = total > 0 ? c.amount / total : 0;
                            return (
                              <View key={`${c.food}-${i}`} style={{ marginBottom: 10 }}>
                                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                                  <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textPrimary, flex: 1 }} numberOfLines={1}>
                                    {c.food}
                                  </Text>
                                  <Text style={{ fontSize: 13, fontWeight: '700', color: colors.primary, marginLeft: 8 }}>
                                    {c.amount < 10 ? (Math.round(c.amount * 10) / 10) : Math.round(c.amount)}{unitStr}
                                  </Text>
                                </View>
                                {c.meal ? (
                                  <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 4 }}>
                                    from {c.meal}
                                  </Text>
                                ) : null}
                                <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.border }}>
                                  <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.primary, width: `${Math.round(pctOfTotal * 100)}%` as any }} />
                                </View>
                              </View>
                            );
                          })}
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 2, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border }}>
                            <Text style={{ fontSize: 14, fontWeight: '700', color: colors.textPrimary }}>Total</Text>
                            <Text style={{ fontSize: 14, fontWeight: '700', color: colors.primary }}>
                              {total < 10 ? (Math.round(total * 10) / 10) : Math.round(total)}{unitStr}
                            </Text>
                          </View>
                        </>
                      )}
                    </View>
                  );
                })()}

                {/* Layer 1 — fiber, sugar, sodium, cholesterol */}
                <Text style={styles.modalSectionTitle}>Essentials</Text>
                <View style={styles.microGridLg}>
                  <MicroChipLg label="Fiber" value={dailyMicros.fiber > 0 ? `${Math.round(dailyMicros.fiber)}g` : '—'} target="28g" pct={dailyMicros.fiber / 28} colors={colors} styles={styles} low={dailyMicros.fiber > 0 && dailyMicros.fiber < 20} onPress={() => setDrillNutrient(drillNutrient === 'fiber' ? null : 'fiber')} />
                  <MicroChipLg label="Sugar" value={dailyMicros.sugar > 0 ? `${Math.round(dailyMicros.sugar)}g` : '—'} target="<50g" pct={dailyMicros.sugar > 0 ? Math.min(dailyMicros.sugar / 50, 1) : 0} colors={colors} styles={styles} warn={dailyMicros.sugar > 50} onPress={() => setDrillNutrient(drillNutrient === 'sugar' ? null : 'sugar')} />
                  <MicroChipLg label="Sodium" value={dailyMicros.sodium > 0 ? `${Math.round(dailyMicros.sodium)}mg` : '—'} target="<2300mg" pct={dailyMicros.sodium > 0 ? Math.min(dailyMicros.sodium / 2300, 1) : 0} colors={colors} styles={styles} warn={dailyMicros.sodium > 2300} onPress={() => setDrillNutrient(drillNutrient === 'sodium' ? null : 'sodium')} />
                  <MicroChipLg label="Cholesterol" value={dailyMicros.cholesterol > 0 ? `${Math.round(dailyMicros.cholesterol)}mg` : '—'} target="<300mg" pct={dailyMicros.cholesterol > 0 ? Math.min(dailyMicros.cholesterol / 300, 1) : 0} colors={colors} styles={styles} warn={dailyMicros.cholesterol > 300} onPress={() => setDrillNutrient(drillNutrient === 'cholesterol' ? null : 'cholesterol')} />
                </View>

                {/* Layer 2 — fats panel (sat / mono / poly / omega-3) */}
                <Text style={[styles.modalSectionTitle, { marginTop: 18 }]}>Fats panel</Text>
                <View style={styles.microGridLg}>
                  <MicroChipLg label="Saturated" value={dailyMicros.saturatedFat > 0 ? `${Math.round(dailyMicros.saturatedFat)}g` : '—'} target="<20g" pct={dailyMicros.saturatedFat > 0 ? Math.min(dailyMicros.saturatedFat / 20, 1) : 0} colors={colors} styles={styles} warn={dailyMicros.saturatedFat > 20} onPress={() => setDrillNutrient(drillNutrient === 'saturatedFat' ? null : 'saturatedFat')} />
                  <MicroChipLg label="Mono" value={dailyMicros.monounsaturatedFat > 0 ? `${Math.round(dailyMicros.monounsaturatedFat)}g` : '—'} target="25g" pct={dailyMicros.monounsaturatedFat / 25} colors={colors} styles={styles} onPress={() => setDrillNutrient(drillNutrient === 'monounsaturatedFat' ? null : 'monounsaturatedFat')} />
                  <MicroChipLg label="Poly" value={dailyMicros.polyunsaturatedFat > 0 ? `${Math.round(dailyMicros.polyunsaturatedFat)}g` : '—'} target="15g" pct={dailyMicros.polyunsaturatedFat / 15} colors={colors} styles={styles} onPress={() => setDrillNutrient(drillNutrient === 'polyunsaturatedFat' ? null : 'polyunsaturatedFat')} />
                  <MicroChipLg label="Omega-3" value={dailyMicros.omega3 > 0 ? `${Math.round(dailyMicros.omega3)}mg` : '—'} target="1600mg" pct={dailyMicros.omega3 / 1600} colors={colors} styles={styles} low={dailyMicros.omega3 > 0 && dailyMicros.omega3 < 1000} onPress={() => setDrillNutrient(drillNutrient === 'omega3' ? null : 'omega3')} />
                </View>

                {/* Layer 2 — minerals */}
                <Text style={[styles.modalSectionTitle, { marginTop: 18 }]}>Minerals</Text>
                <View style={styles.microGridLg}>
                  <MicroChipLg label="Potassium" value={dailyMicros.potassium > 0 ? `${Math.round(dailyMicros.potassium)}mg` : '—'} target="3400mg" pct={dailyMicros.potassium / 3400} colors={colors} styles={styles} low={dailyMicros.potassium > 0 && dailyMicros.potassium < 2300} onPress={() => setDrillNutrient(drillNutrient === 'potassium' ? null : 'potassium')} />
                  <MicroChipLg label="Calcium" value={dailyMicros.calcium > 0 ? `${Math.round(dailyMicros.calcium)}mg` : '—'} target="1000mg" pct={dailyMicros.calcium / 1000} colors={colors} styles={styles} low={dailyMicros.calcium > 0 && dailyMicros.calcium < 700} onPress={() => setDrillNutrient(drillNutrient === 'calcium' ? null : 'calcium')} />
                  <MicroChipLg label="Iron" value={dailyMicros.iron > 0 ? `${(Math.round(dailyMicros.iron * 10) / 10)}mg` : '—'} target="18mg" pct={dailyMicros.iron / 18} colors={colors} styles={styles} low={dailyMicros.iron > 0 && dailyMicros.iron < 12} onPress={() => setDrillNutrient(drillNutrient === 'iron' ? null : 'iron')} />
                  <MicroChipLg label="Magnesium" value={dailyMicros.magnesium > 0 ? `${Math.round(dailyMicros.magnesium)}mg` : '—'} target="400mg" pct={dailyMicros.magnesium / 400} colors={colors} styles={styles} low={dailyMicros.magnesium > 0 && dailyMicros.magnesium < 280} onPress={() => setDrillNutrient(drillNutrient === 'magnesium' ? null : 'magnesium')} />
                </View>

                {/* Layer 2 — vitamins */}
                <Text style={[styles.modalSectionTitle, { marginTop: 18 }]}>Vitamins</Text>
                <View style={styles.microGridLg}>
                  <MicroChipLg label="Vitamin D" value={dailyMicros.vitaminD > 0 ? `${(Math.round(dailyMicros.vitaminD * 10) / 10)}mcg` : '—'} target="15mcg" pct={dailyMicros.vitaminD / 15} colors={colors} styles={styles} low={dailyMicros.vitaminD > 0 && dailyMicros.vitaminD < 10} onPress={() => setDrillNutrient(drillNutrient === 'vitaminD' ? null : 'vitaminD')} />
                  <MicroChipLg label="Vitamin C" value={dailyMicros.vitaminC > 0 ? `${Math.round(dailyMicros.vitaminC)}mg` : '—'} target="90mg" pct={dailyMicros.vitaminC / 90} colors={colors} styles={styles} low={dailyMicros.vitaminC > 0 && dailyMicros.vitaminC < 60} onPress={() => setDrillNutrient(drillNutrient === 'vitaminC' ? null : 'vitaminC')} />
                  <MicroChipLg label="Vitamin B12" value={dailyMicros.vitaminB12 > 0 ? `${(Math.round(dailyMicros.vitaminB12 * 10) / 10)}mcg` : '—'} target="2.4mcg" pct={dailyMicros.vitaminB12 / 2.4} colors={colors} styles={styles} low={dailyMicros.vitaminB12 > 0 && dailyMicros.vitaminB12 < 1.6} onPress={() => setDrillNutrient(drillNutrient === 'vitaminB12' ? null : 'vitaminB12')} />
                  <MicroChipLg label="Vitamin A" value={dailyMicros.vitaminA > 0 ? `${dailyMicros.vitaminA}%` : '—'} target="100% DV" pct={dailyMicros.vitaminA / 100} colors={colors} styles={styles} low={dailyMicros.vitaminA > 0 && dailyMicros.vitaminA < 50} onPress={() => setDrillNutrient(drillNutrient === 'vitaminA' ? null : 'vitaminA')} />
                </View>

                {!hasMicros && (
                  <Text style={styles.microNoData}>
                    Nutrition details load with your next plan.
                  </Text>
                )}

                {/* Legend */}
                <View style={styles.modalLegend}>
                  <View style={styles.legendItem}>
                    <View style={[styles.legendDot, { backgroundColor: colors.primary }]} />
                    <Text style={styles.legendText}>On track</Text>
                  </View>
                  <View style={styles.legendItem}>
                    <View style={[styles.legendDot, { backgroundColor: '#F59E0B' }]} />
                    <Text style={styles.legendText}>Below target</Text>
                  </View>
                  <View style={styles.legendItem}>
                    <View style={[styles.legendDot, { backgroundColor: colors.error }]} />
                    <Text style={styles.legendText}>Above target</Text>
                  </View>
                </View>
              </ScrollView>
            </View>
          </View>
        </Modal>

        {/* Meal rows — single unified list. Order is whatever the user
            arranged with the up/down arrows. Routines are tagged with a
            📌 emoji but are otherwise rendered identically to other meals. */}
        <View style={styles.meals}>
          {visibleMeals.length > 0 && !swipeHintDismissed && (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 8, paddingBottom: 4, gap: 4 }}>
              <Ionicons name="arrow-back" size={11} color={colors.textMuted} />
              <Text style={{ fontSize: 10, color: colors.textMuted }}>Swipe meal for more options</Text>
              <TouchableOpacity onPress={() => setSwipeHintDismissed(true)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close" size={12} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          )}
          {visibleMeals.map(({ key, emoji, meal }, i) => (
            <MealRow
              key={key}
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
              colors={colors}
              styles={styles}
              mealAccent={section}
            />
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
          {/* Inline "+ Add Meal" affordance at the bottom of the list,
              replacing the old top-of-card header button. */}
          {onAddSnack && (
            <TouchableOpacity style={styles.addMealInline} onPress={onAddSnack} activeOpacity={0.7}>
              <Ionicons name="add-circle-outline" size={16} color={section.strong} style={{ marginRight: 4 }} />
              <Text style={styles.addMealInlineText}>Add Meal</Text>
            </TouchableOpacity>
          )}
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

  return (
    <View style={styles.macroTracker}>
      <Text style={styles.macroTrackerLabel}>{label}</Text>
      <View style={styles.macroTrackerValues}>
        <AnimatedNumber value={actual} suffix={unit} style={[styles.macroActual, { color: over ? colors.error : color }]} />
        <Text style={styles.macroSep}>/</Text>
        <Text style={styles.macroTarget}>{target}{unit}</Text>
      </View>
      <View style={styles.macroBarTrack}>
        <View style={[styles.macroBarFill, { width: `${Math.round(pct * 100)}%` as any, backgroundColor: barColor }]} />
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

function MealRow({ mealType, meal, checked, onToggle, onEdit, onRemove, onHardDelete, onToggleRoutine, onShowRecipe, onRenameMeal, onMoveUp, onMoveDown, onShuffle, colors, styles, mealAccent }: {
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
  colors: ReturnType<typeof getTheme>['colors'];
  styles: ReturnType<typeof createStyles>;
  mealAccent: ReturnType<typeof getTheme>['sections']['meals'];
}) {
  const [itemsExpanded, setItemsExpanded] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(meal.meal);
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
  if (onShowRecipe) swipeActions.push({ icon: 'restaurant-outline', color: '#fff', bgColor: colors.primary, onPress: () => onShowRecipe(mealType, meal), label: 'Recipe' });
  if (onShuffle) swipeActions.push({ icon: 'shuffle', color: '#fff', bgColor: mealAccent.strong, onPress: onShuffle, label: 'Shuffle' });
  if (onMoveUp) swipeActions.push({ icon: 'arrow-up', color: '#fff', bgColor: '#6B7280', onPress: onMoveUp });
  if (onMoveDown) swipeActions.push({ icon: 'arrow-down', color: '#fff', bgColor: '#6B7280', onPress: onMoveDown });
  if (onRemove) swipeActions.push({ icon: 'trash-outline', color: '#fff', bgColor: colors.error ?? '#EF4444', onPress: () => onRemove(mealType), label: 'Remove' });

  return (
    <SwipeableRow actions={swipeActions}>
    <Animated.View style={[styles.mealItem, checked && styles.mealItemDone, { backgroundColor: rowFlashBg }]}>
      {/* Title row — checkbox + meal name + inline pin badge + actions. */}
      <View style={styles.mealHeader}>
        <TouchableOpacity
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
            {/* Inline routine badge — small, beside the title, taps to
                toggle. No more dedicated row. */}
            {onToggleRoutine && (
              <TouchableOpacity
                onPress={() => onToggleRoutine(mealType)}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                activeOpacity={0.7}
                style={[
                  styles.routineBadge,
                  meal.isRoutine
                    ? { backgroundColor: mealAccent.strong + '22', borderColor: mealAccent.strong + '66' }
                    : { backgroundColor: 'transparent', borderColor: colors.border },
                ]}>
                <Text style={[
                  styles.routineBadgeText,
                  { color: meal.isRoutine ? mealAccent.strong : colors.textMuted },
                ]}>
                  {meal.isRoutine ? 'Routine' : '+ Pin'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
        {/* Edit button — primary visible action */}
        <View style={styles.iconStrip}>
          {onEdit && (
            <TouchableOpacity onPress={() => onEdit(mealType, meal)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel={`Edit ${meal.meal}`}>
              <Ionicons name="create-outline" size={17} color={mealAccent.strong} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Item list — collapsed by default, tap to expand */}
      {itemRows.length > 0 && !itemsExpanded ? (
        <TouchableOpacity onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setItemsExpanded(true); }} activeOpacity={0.7} style={{ paddingVertical: 3 }}>
          <Text style={{ fontSize: 12, color: colors.textMuted }}>
            {itemRows.length} item{itemRows.length !== 1 ? 's' : ''} · tap to see details
          </Text>
        </TouchableOpacity>
      ) : itemRows.length > 0 ? (
        <TouchableOpacity onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setItemsExpanded(false); }} activeOpacity={0.9}>
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
        const sugar = Math.round(meal.sugar ?? meal.micronutrients?.sugar ?? 0);
        const sodium = Math.round(meal.sodium ?? meal.micronutrients?.sodium ?? 0);
        const highSugar = sugar >= 15;
        const highSodium = sodium >= 700;
        return (
          <View style={styles.mealBadges}>
            <MacroPill label="cal" value={Math.round(meal.calories)} color={mealAccent.strong} styles={styles} />
            <MacroPill label="p"   value={Math.round(meal.protein)}  color={colors.primary}    styles={styles} />
            <MacroPill label="c"   value={Math.round(meal.carbs ?? 0)} color="#F59E0B"         styles={styles} />
            <MacroPill label="f"   value={Math.round(meal.fat ?? 0)}   color="#A78BFA"         styles={styles} />
            {fiber > 0 && <MacroPill label="fiber" value={fiber} color="#10B981" styles={styles} />}
            {highSugar && <MacroPill label="sugar" value={sugar} color="#EF4444" styles={styles} />}
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
    borderRadius: radius.lg,
    marginBottom: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },

  // ── Body ─────────────────────────────────────────────────────────────────────
  body: { padding: 14 },

  // Optional small subtitle when the parent passes a `title` prop
  // (used by the day-card flow to label "Today" / "Tomorrow"). Replaces
  // the old top-of-card header bar.
  titleSubtle: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 8,
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

  // ── Macro grid ────────────────────────────────────────────────────────────────
  macrosGrid: {
    flexDirection: 'row',
    paddingVertical: 6,
    marginBottom: 14,
    gap: 2,
  },
  macroTracker: { flex: 1, alignItems: 'center', gap: 3 },
  macroTrackerLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  macroTrackerValues: { flexDirection: 'row', alignItems: 'baseline', gap: 2 },
  macroActual:  { fontSize: 14, fontWeight: '800' },
  macroSep:     { fontSize: 10, color: colors.textMuted },
  macroTarget:  { fontSize: 10, color: colors.textMuted, fontWeight: '500' },
  macroBarTrack: {
    width: '100%', height: 3,
    backgroundColor: colors.border,
    borderRadius: 2,
    overflow: 'hidden',
  },
  macroBarFill:   { height: 3, borderRadius: 2 },
  macroRemaining: { fontSize: 9, fontWeight: '500' },

  // ── Meals ────────────────────────────────────────────────────────────────────
  meals: { gap: 10, marginBottom: 14 },

  mealItem: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    padding: 12,
    borderWidth: 1,
    borderColor: section.strong + '2A',
    gap: 6,
  },
  mealItemDone: { opacity: 0.62, borderColor: colors.success },

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
    width: 20, height: 20, borderRadius: 6,
    borderWidth: 2, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxDone: { backgroundColor: colors.success, borderColor: colors.success },
  checkmark:    { fontSize: 12, color: colors.background, fontWeight: '800' },

  mealName:     { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  mealNameDone: { textDecorationLine: 'line-through', color: colors.textSecondary },

  mealFoodsDetail: { gap: 3, marginTop: 6, paddingLeft: 30 },
  mealFoodRow:     { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  mealFoodName:    { fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  mealFoodsDone:   { color: colors.textMuted },

  recipeBox: {
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
    marginTop: 4,
  },
  recipeLabel: { fontSize: 10, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  recipeText:  { fontSize: 12, color: colors.textPrimary, lineHeight: 18 },

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
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignItems: 'center',
    minWidth: 44,
  },
  pillValue: { fontSize: 13, fontWeight: '700' },
  pillLabel: { fontSize: 9, color: colors.textMuted, fontWeight: '500', marginTop: 1 },

  // ── Micro details button (compact secondary action) ──────────────────────
  microBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: 'transparent',
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: section.strong + '55',
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginBottom: 12,
    gap: 5,
  },
  microBtnIcon: { fontSize: 11 },
  microBtnText: { fontSize: 11, fontWeight: '700', color: section.strong },
  microBtnArrow: { fontSize: 13, fontWeight: '600', color: section.strong, marginLeft: 1 },

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
