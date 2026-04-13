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
}: NutritionCardProps) {
  const [showMicroModal, setShowMicroModal] = useState(false);
  const theme = getTheme(themeName);
  const colors = theme.colors;
  const section = theme.sections.meals;
  const styles = createStyles(colors, section);
  const { breakfast, lunch, dinner, snack, extraMeals: extraMealsList, targets: rawTargets } = nutritionPlan;
  const targets = rawTargets ?? { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const removed = new Set(nutritionPlan.removedMeals ?? []);

  const allMeals: Array<{ key: string; emoji: string; meal: MealSuggestion | undefined }> = [
    { key: 'breakfast', emoji: '🌅', meal: breakfast },
    { key: 'lunch',     emoji: '🥗', meal: lunch },
    { key: 'dinner',    emoji: '🍽️', meal: dinner },
    { key: 'snack',     emoji: '🥜', meal: snack },
  ];
  const visibleMeals = allMeals.filter(m => m.meal && !removed.has(m.key)) as Array<{ key: string; emoji: string; meal: MealSuggestion }>;
  const hiddenMeals  = allMeals.filter(m => m.meal && removed.has(m.key))  as Array<{ key: string; emoji: string; meal: MealSuggestion }>;
  const extraMealItems = (extraMealsList ?? []).map((meal, idx) => ({ key: `extra_${idx}`, emoji: '🍴', meal }));

  const routineMeals    = visibleMeals.filter(m => m.meal.isRoutine);
  const nonRoutineMeals = visibleMeals.filter(m => !m.meal.isRoutine);

  const allVisible = [...visibleMeals, ...extraMealItems];
  const actual = {
    calories: Math.round(allVisible.reduce((sum, m) => sum + m.meal.calories, 0)),
    protein:  Math.round(allVisible.reduce((sum, m) => sum + m.meal.protein, 0)),
    carbs:    Math.round(allVisible.reduce((sum, m) => sum + (m.meal.carbs ?? 0), 0)),
    fat:      Math.round(allVisible.reduce((sum, m) => sum + (m.meal.fat ?? 0), 0)),
  };

  // Aggregate micronutrients across all visible meals
  const microKeys: (keyof MealMicronutrients)[] = ['fiber', 'sugar', 'sodium', 'cholesterol', 'vitaminA', 'vitaminC', 'vitaminD', 'calcium', 'iron', 'potassium'];
  const dailyMicros: Record<string, number> = {};
  for (const k of microKeys) {
    dailyMicros[k] = Math.round(allVisible.reduce((sum, m) => {
      const micro = m.meal.micronutrients;
      return sum + (micro?.[k] ?? (k === 'fiber' ? (m.meal.fiber ?? 0) : 0));
    }, 0));
  }
  const hasMicros = microKeys.some(k => dailyMicros[k] > 0);

  return (
    <View style={styles.card}>
      {/* Icon-based green section header */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionIcon}>🥗</Text>
        <Text style={styles.sectionLabel}>NUTRITION</Text>
        {title ? (
          <>
            <View style={styles.sectionDivider} />
            <Text style={styles.sectionMeta}>{title}</Text>
          </>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        {onAddSnack && (
          <TouchableOpacity style={styles.addSnackBtn} onPress={onAddSnack}>
            <Text style={styles.addSnackBtnText}>+ Add Meal</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.body}>
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

        {/* Meal rows */}
        <View style={styles.meals}>
          {/* Pinned routine meals */}
          {routineMeals.length > 0 && (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4, marginTop: 2 }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: section.strong, letterSpacing: 0.5 }}>📌  ROUTINE</Text>
              </View>
              {routineMeals.map(({ key, emoji, meal }) => (
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
                  colors={colors}
                  styles={styles}
                  mealAccent={section}
                />
              ))}
              {nonRoutineMeals.length > 0 && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4, marginTop: 8 }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.5 }}>TODAY'S PLAN</Text>
                </View>
              )}
            </>
          )}
          {/* Non-routine meals */}
          {nonRoutineMeals.map(({ key, emoji, meal }) => (
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
              colors={colors}
              styles={styles}
              mealAccent={section}
            />
          ))}
          {extraMealItems.map(({ key, emoji, meal }) => (
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
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>Stay hydrated · aim for 8 glasses daily</Text>
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
      <Text style={[styles.macroRemaining, { color: over ? colors.error : colors.textMuted }]}>
        {over ? `+${actual - target}${unit}` : `${target - actual}${unit} left`}
      </Text>
    </View>
  );
}

// ── MealRow ───────────────────────────────────────────────────────────────────

function MealRow({ emoji, mealType, meal, checked, onToggle, onEdit, onRemove, onHardDelete, onToggleRoutine, onShowRecipe, colors, styles, mealAccent }: {
  emoji: string;
  mealType: string;
  meal: MealSuggestion;
  checked: boolean;
  onToggle?: (mealType: string) => void;
  onEdit?:   (mealType: string, meal: MealSuggestion) => void;
  onRemove?: (mealType: string) => void;
  onHardDelete?: (mealType: string) => void;
  onToggleRoutine?: (mealType: string) => void;
  onShowRecipe?: (mealType: string, meal: MealSuggestion) => void;
  colors: ReturnType<typeof getTheme>['colors'];
  styles: ReturnType<typeof createStyles>;
  mealAccent: ReturnType<typeof getTheme>['sections']['meals'];
}) {
  return (
    <View style={[styles.mealItem, checked && styles.mealItemDone]}>
      {/* Title row: checkbox + meal name. The action buttons live on their
          own row below so long meal names ("Lean Turkey + Sweet Potato
          Bowl") don't collide with the Routine / Edit / Remove labels. */}
      <View style={styles.mealHeader}>
        <TouchableOpacity
          style={[styles.checkbox, checked && styles.checkboxDone]}
          onPress={() => onToggle?.(mealType)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          {checked && <Text style={styles.checkmark}>✓</Text>}
        </TouchableOpacity>
        <Text
          style={[styles.mealName, checked && styles.mealNameDone]}
          numberOfLines={2}
          ellipsizeMode="tail">
          {emoji}  {meal.meal}
        </Text>
      </View>

      {/* Routine pin gets its own row as a compact pill so the action
          buttons below have predictable widths and don't get pushed off
          screen by long pin labels. */}
      {onToggleRoutine && (
        <View style={styles.mealPinRow}>
          <TouchableOpacity
            onPress={() => onToggleRoutine(mealType)}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            activeOpacity={0.7}
            style={[
              styles.pinPill,
              meal.isRoutine
                ? { backgroundColor: mealAccent.strong + '22', borderColor: mealAccent.strong + '66' }
                : { backgroundColor: 'transparent',             borderColor: colors.border },
            ]}>
            <Text style={[
              styles.pinPillText,
              { color: meal.isRoutine ? mealAccent.strong : colors.textMuted },
            ]}>
              {meal.isRoutine ? '📌 Routine' : '＋ Pin as Routine'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {(onShowRecipe || onEdit || onRemove) && (
        <View style={styles.mealActionRow}>
          {onShowRecipe && (
            <TouchableOpacity
              onPress={() => onShowRecipe(mealType, meal)}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              activeOpacity={0.7}
              style={styles.actionBtn}>
              <Text style={styles.actionBtnText}>🍳 Recipe</Text>
            </TouchableOpacity>
          )}
          {onEdit && (
            <TouchableOpacity
              onPress={() => onEdit(mealType, meal)}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              activeOpacity={0.7}
              style={styles.actionBtn}>
              <Text style={styles.actionBtnText}>✎ Edit</Text>
            </TouchableOpacity>
          )}
          {onRemove && (
            <TouchableOpacity
              onPress={() => onRemove(mealType)}
              onLongPress={() => onHardDelete?.(mealType)}
              delayLongPress={500}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              activeOpacity={0.7}
              style={styles.actionBtn}>
              <Text style={[styles.actionBtnText, { color: colors.error }]}>✕ Remove</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <View style={styles.mealFoodsDetail}>
        {(() => {
          // Prefer structured items — legacy parallel arrays are fallback.
          const withItems = ensureItems(meal);
          const rows = withItems.items && withItems.items.length > 0
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
          return rows.map(r => (
            <View key={r.key} style={styles.mealFoodRow}>
              <Text style={[styles.mealFoodName, checked && styles.mealFoodsDone]}>
                {r.name}
              </Text>
              {r.amount ? (
                <Text style={styles.mealFoodAmount}>{r.amount}</Text>
              ) : null}
            </View>
          ));
        })()}
        {meal.instructions && (
          <View style={styles.recipeBox}>
            <Text style={styles.recipeLabel}>How to make it</Text>
            <Text style={styles.recipeText}>{meal.instructions}</Text>
          </View>
        )}
      </View>

      <View style={styles.mealBadges}>
        <MacroPill label="cal"     value={Math.round(meal.calories)}   color={colors.accent}   styles={styles} />
        <MacroPill label="protein" value={Math.round(meal.protein)}    color={colors.primary}  styles={styles} />
        <MacroPill label="carbs"   value={Math.round(meal.carbs ?? 0)} color="#F59E0B"         styles={styles} />
        <MacroPill label="fat"     value={Math.round(meal.fat   ?? 0)} color="#A78BFA"         styles={styles} />
        {(meal.fiber ?? meal.micronutrients?.fiber ?? 0) > 0 && (
          <MacroPill label="fiber" value={Math.round(meal.fiber ?? meal.micronutrients?.fiber ?? 0)} color="#10B981" styles={styles} />
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

  // ── Section identity header ──────────────────────────────────────────────────
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: section.soft,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: section.strong + '30',
  },
  sectionIcon: { fontSize: 15 },
  sectionLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: section.text,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  sectionDivider: {
    width: 1,
    height: 12,
    backgroundColor: section.strong + '44',
    marginHorizontal: 2,
  },
  sectionMeta: {
    fontSize: 13,
    fontWeight: '600',
    color: section.text,
    flex: 1,
  },
  addSnackBtn: {
    backgroundColor: section.strong + '18',
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: section.strong + '55',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  addSnackBtnText: { fontSize: 12, color: section.strong, fontWeight: '700' },

  // ── Body ─────────────────────────────────────────────────────────────────────
  body: { padding: 14 },

  // ── Macro grid ────────────────────────────────────────────────────────────────
  macrosGrid: {
    flexDirection: 'row',
    backgroundColor: section.soft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: section.strong + '40',
    padding: 12,
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

  mealHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  // Pin as Routine sits on its own row directly under the meal name as a
  // compact pill. Action buttons get their own equally-spaced row below.
  mealPinRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    paddingLeft: 30,
  },
  pinPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  pinPillText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  mealActionRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 6,
    marginTop: 8,
    paddingLeft: 30,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: section.strong,
    letterSpacing: 0.2,
  },
  checkbox: {
    width: 22, height: 22, borderRadius: 6,
    borderWidth: 2, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxDone: { backgroundColor: colors.success, borderColor: colors.success },
  checkmark:    { fontSize: 13, color: colors.background, fontWeight: '800' },

  mealName:     { flex: 1, fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  mealNameDone: { textDecorationLine: 'line-through', color: colors.textSecondary },

  editBtn:           { paddingHorizontal: 6 },
  editBtnText:       { fontSize: 12, color: section.strong, fontWeight: '700' },
  recipeBtn:         { paddingHorizontal: 6 },
  recipeBtnText:     { fontSize: 12, color: section.strong, fontWeight: '700' },
  removeMealBtn:     { paddingHorizontal: 6 },
  removeMealBtnText: { fontSize: 12, color: colors.error, fontWeight: '600' },
  routineBtn:        { paddingHorizontal: 4 },
  routineBtnText:    { fontSize: 11, fontWeight: '700' },

  mealFoodsDetail: { gap: 5, marginTop: 4 },
  mealFoodRow:     { flexDirection: 'row', alignItems: 'center' },
  mealFoodName:    { fontSize: 13, color: colors.textSecondary, lineHeight: 18 },
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

  // ── Micro details button ──────────────────────────────────────────────────────
  microBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: section.soft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: section.strong + '40',
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 14,
    gap: 8,
  },
  microBtnIcon: { fontSize: 14 },
  microBtnText: { flex: 1, fontSize: 13, fontWeight: '700', color: section.strong },
  microBtnArrow: { fontSize: 18, fontWeight: '600', color: section.strong },

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

  // Unused kept for legacy compat
  recipeToggle:     { paddingVertical: 2 },
  recipeToggleText: { fontSize: 11, color: section.text, fontWeight: '700' },
  mealFoodAmount:   { fontSize: 12, fontWeight: '800', color: section.strong, minWidth: 56 },
});
