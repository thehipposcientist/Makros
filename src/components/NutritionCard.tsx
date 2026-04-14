import { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, ScrollView } from 'react-native';
import { DailyNutritionPlan, MealSuggestion, MealMicronutrients, AppThemeName } from '../types';
import { getTheme, radius } from '../constants/theme';
import { ensureItems, formatItemAmount } from '../utils/mealItems';

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
  /** Reorder the day's meals[]. `direction` is -1 (move up) or +1 (move down). */
  onMoveMeal?: (mealType: string, direction: -1 | 1) => void;
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
  onMoveMeal,
}: NutritionCardProps) {
  const [showMicroModal, setShowMicroModal] = useState(false);
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
    { out: 'fiber',       keys: ['fiber'] },
    { out: 'sugar',       keys: ['sugar'] },
    { out: 'sodium',      keys: ['sodium'] },
    { out: 'cholesterol', keys: ['cholesterol'] },
    { out: 'vitaminA',    keys: ['vitamin_a', 'vitaminA'] },
    { out: 'vitaminC',    keys: ['vitamin_c', 'vitaminC'] },
    { out: 'vitaminD',    keys: ['vitamin_d', 'vitaminD'] },
    { out: 'calcium',     keys: ['calcium'] },
    { out: 'iron',        keys: ['iron'] },
    { out: 'potassium',   keys: ['potassium'] },
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
        {/* Nutrition details button + modal — always visible */}
        <TouchableOpacity
          style={styles.microBtn}
          onPress={() => setShowMicroModal(true)}
          activeOpacity={0.7}>
          <Text style={styles.microBtnIcon}>📊</Text>
          <Text style={styles.microBtnText}>Nutrition Details</Text>
          <Text style={styles.microBtnArrow}>›</Text>
        </TouchableOpacity>

        <Modal
          visible={showMicroModal}
          transparent
          animationType="slide"
          onRequestClose={() => setShowMicroModal(false)}>
          <View style={styles.modalOverlay}>
            <View style={[styles.modalContent, { backgroundColor: colors.surface }]}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Daily Nutrition Breakdown</Text>
                <TouchableOpacity onPress={() => setShowMicroModal(false)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                  <Text style={styles.modalClose}>✕</Text>
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

                {/* Micronutrient grid */}
                <Text style={styles.modalSectionTitle}>Micronutrients</Text>
                <View style={styles.microGridLg}>
                  <MicroChipLg label="Fiber" value={dailyMicros.fiber > 0 ? `${dailyMicros.fiber}g` : '—'} target="25g" pct={dailyMicros.fiber / 25} colors={colors} styles={styles} />
                  <MicroChipLg label="Sugar" value={dailyMicros.sugar > 0 ? `${dailyMicros.sugar}g` : '—'} target="<50g" pct={dailyMicros.sugar > 0 ? Math.min(dailyMicros.sugar / 50, 1) : 0} colors={colors} styles={styles} warn={dailyMicros.sugar > 50} />
                  <MicroChipLg label="Sodium" value={dailyMicros.sodium > 0 ? `${dailyMicros.sodium}mg` : '—'} target="<2300mg" pct={dailyMicros.sodium > 0 ? Math.min(dailyMicros.sodium / 2300, 1) : 0} colors={colors} styles={styles} warn={dailyMicros.sodium > 2300} />
                  <MicroChipLg label="Cholesterol" value={dailyMicros.cholesterol > 0 ? `${dailyMicros.cholesterol}mg` : '—'} target="<300mg" pct={dailyMicros.cholesterol > 0 ? Math.min(dailyMicros.cholesterol / 300, 1) : 0} colors={colors} styles={styles} warn={dailyMicros.cholesterol > 300} />
                </View>

                <Text style={[styles.modalSectionTitle, { marginTop: 18 }]}>Vitamins & Minerals</Text>
                <View style={styles.microGridLg}>
                  <MicroChipLg label="Vitamin A" value={dailyMicros.vitaminA > 0 ? `${dailyMicros.vitaminA}%` : '—'} target="100% DV" pct={dailyMicros.vitaminA / 100} colors={colors} styles={styles} low={dailyMicros.vitaminA > 0 && dailyMicros.vitaminA < 50} />
                  <MicroChipLg label="Vitamin C" value={dailyMicros.vitaminC > 0 ? `${dailyMicros.vitaminC}%` : '—'} target="100% DV" pct={dailyMicros.vitaminC / 100} colors={colors} styles={styles} low={dailyMicros.vitaminC > 0 && dailyMicros.vitaminC < 50} />
                  <MicroChipLg label="Vitamin D" value={dailyMicros.vitaminD > 0 ? `${dailyMicros.vitaminD}%` : '—'} target="100% DV" pct={dailyMicros.vitaminD / 100} colors={colors} styles={styles} low={dailyMicros.vitaminD > 0 && dailyMicros.vitaminD < 50} />
                  <MicroChipLg label="Iron" value={dailyMicros.iron > 0 ? `${dailyMicros.iron}%` : '—'} target="100% DV" pct={dailyMicros.iron / 100} colors={colors} styles={styles} low={dailyMicros.iron > 0 && dailyMicros.iron < 50} />
                  <MicroChipLg label="Calcium" value={dailyMicros.calcium > 0 ? `${dailyMicros.calcium}%` : '—'} target="100% DV" pct={dailyMicros.calcium / 100} colors={colors} styles={styles} low={dailyMicros.calcium > 0 && dailyMicros.calcium < 50} />
                  <MicroChipLg label="Potassium" value={dailyMicros.potassium > 0 ? `${dailyMicros.potassium}mg` : '—'} target="2600mg" pct={dailyMicros.potassium / 2600} colors={colors} styles={styles} low={dailyMicros.potassium > 0 && dailyMicros.potassium < 1300} />
                </View>

                {!hasMicros && (
                  <Text style={styles.microNoData}>Micronutrient data will appear once the AI generates a plan with detailed nutrition info.</Text>
                )}

                {/* Legend */}
                <View style={styles.modalLegend}>
                  <View style={styles.legendItem}>
                    <View style={[styles.legendDot, { backgroundColor: colors.primary }]} />
                    <Text style={styles.legendText}>On track</Text>
                  </View>
                  <View style={styles.legendItem}>
                    <View style={[styles.legendDot, { backgroundColor: '#F59E0B' }]} />
                    <Text style={styles.legendText}>Low — eat more</Text>
                  </View>
                  <View style={styles.legendItem}>
                    <View style={[styles.legendDot, { backgroundColor: colors.error }]} />
                    <Text style={styles.legendText}>Over limit</Text>
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
              <Text style={styles.addMealInlineText}>+ Add Meal</Text>
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
        <Text style={[styles.macroActual, { color: over ? colors.error : color }]}>
          {actual}{unit}
        </Text>
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

function MealRow({ mealType, meal, checked, onToggle, onEdit, onRemove, onHardDelete, onToggleRoutine, onShowRecipe, onMoveUp, onMoveDown, colors, styles, mealAccent }: {
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
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  colors: ReturnType<typeof getTheme>['colors'];
  styles: ReturnType<typeof createStyles>;
  mealAccent: ReturnType<typeof getTheme>['sections']['meals'];
}) {
  // Build the structured item list once — used both for display and
  // implicit "is there detail to show".
  const withItems = ensureItems(meal);
  const itemRows = withItems.items && withItems.items.length > 0
    ? withItems.items.map((it, i) => ({
        key: `${it.name}-${i}`,
        name: it.name,
        amount: formatItemAmount(it),
      }))
    : meal.foods.map((f, i) => ({
        key: `${f}-${i}`,
        name: f,
        amount: meal.amounts?.[i] ?? '',
      }));

  return (
    <View style={[styles.mealItem, checked && styles.mealItemDone]}>
      {/* Title row — checkbox + meal name + inline pin badge + actions.
          Everything in one line, no wrapping action bar. */}
      <View style={styles.mealHeader}>
        <TouchableOpacity
          style={[styles.checkbox, checked && styles.checkboxDone]}
          onPress={() => onToggle?.(mealType)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          {checked && <Text style={styles.checkmark}>✓</Text>}
        </TouchableOpacity>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Text
              style={[styles.mealName, checked && styles.mealNameDone, { flexShrink: 1 }]}
              numberOfLines={2}
              ellipsizeMode="tail">
              {meal.meal}
            </Text>
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
        {/* Trailing icon strip — reorder + actions, all icon-only. */}
        <View style={styles.iconStrip}>
          {onMoveUp && (
            <TouchableOpacity onPress={onMoveUp} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }} style={styles.iconBtn}>
              <Text style={styles.iconBtnText}>↑</Text>
            </TouchableOpacity>
          )}
          {onMoveDown && (
            <TouchableOpacity onPress={onMoveDown} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }} style={styles.iconBtn}>
              <Text style={styles.iconBtnText}>↓</Text>
            </TouchableOpacity>
          )}
          {onShowRecipe && (
            <TouchableOpacity onPress={() => onShowRecipe(mealType, meal)} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }} style={styles.iconBtn}>
              <Text style={styles.iconBtnText}>🍳</Text>
            </TouchableOpacity>
          )}
          {onEdit && (
            <TouchableOpacity onPress={() => onEdit(mealType, meal)} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }} style={styles.iconBtn}>
              <Text style={[styles.iconBtnText, { color: mealAccent.strong }]}>✎</Text>
            </TouchableOpacity>
          )}
          {onRemove && (
            <TouchableOpacity
              onPress={() => onRemove(mealType)}
              onLongPress={() => onHardDelete?.(mealType)}
              delayLongPress={500}
              hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
              style={styles.iconBtn}>
              <Text style={[styles.iconBtnText, { color: colors.error }]}>✕</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Item list — indented under the title, more compact than before. */}
      {itemRows.length > 0 && (
        <View style={styles.mealFoodsDetail}>
          {itemRows.map(r => (
            <View key={r.key} style={styles.mealFoodRow}>
              <Text style={[styles.mealFoodName, checked && styles.mealFoodsDone, { flex: 1 }]}>
                {r.name}
              </Text>
              {r.amount ? (
                <Text style={styles.mealFoodAmount}>{r.amount}</Text>
              ) : null}
            </View>
          ))}
          {meal.instructions && (
            <View style={styles.recipeBox}>
              <Text style={styles.recipeLabel}>How to make it</Text>
              <Text style={styles.recipeText}>{meal.instructions}</Text>
            </View>
          )}
        </View>
      )}

      {/* Macro pills — compact strip at the bottom of the row. */}
      <View style={styles.mealBadges}>
        <MacroPill label="cal"     value={Math.round(meal.calories)}   color={mealAccent.strong} styles={styles} />
        <MacroPill label="p"       value={Math.round(meal.protein)}    color={colors.primary}    styles={styles} />
        <MacroPill label="c"       value={Math.round(meal.carbs ?? 0)} color="#F59E0B"           styles={styles} />
        <MacroPill label="f"       value={Math.round(meal.fat ?? 0)}   color="#A78BFA"           styles={styles} />
        {(meal.fiber ?? meal.micronutrients?.fiber ?? 0) > 0 && (
          <MacroPill label="fib" value={Math.round(meal.fiber ?? meal.micronutrients?.fiber ?? 0)} color="#10B981" styles={styles} />
        )}
      </View>
    </View>
  );
}

function MicroChipLg({ label, value, target, pct, colors, styles, warn, low }: {
  label: string; value: string; target: string; pct: number;
  colors: ReturnType<typeof getTheme>['colors'];
  styles: ReturnType<typeof createStyles>;
  warn?: boolean; low?: boolean;
}) {
  const barPct = Math.min(pct, 1);
  const noData = value === '—';
  const barColor = noData ? colors.border : warn ? colors.error : low ? '#F59E0B' : colors.primary;
  return (
    <View style={styles.microChipLg}>
      <View style={styles.microChipLgTop}>
        <Text style={[styles.microChipLgLabel, (warn || low) && { color: barColor }]}>{label}</Text>
        <Text style={[styles.microChipLgValue, noData ? { color: colors.textMuted } : (warn || low) && { color: barColor }]}>{value}</Text>
      </View>
      <View style={styles.microChipLgBarTrack}>
        <View style={[styles.microChipLgBarFill, { width: `${Math.round(barPct * 100)}%` as any, backgroundColor: barColor }]} />
      </View>
      <Text style={[styles.microChipLgTarget, (warn || low) && { color: barColor }]}>{target}</Text>
    </View>
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
