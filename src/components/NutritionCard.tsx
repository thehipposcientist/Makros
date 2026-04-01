import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { DailyNutritionPlan, MealSuggestion } from '../types';
import { colors, radius } from '../constants/theme';

interface NutritionCardProps {
  title?: string;
  nutritionPlan: DailyNutritionPlan;
  checkedMeals?: Record<string, boolean>;
  onToggleMeal?: (mealType: string) => void;
  onEditMeal?:   (mealType: string, meal: MealSuggestion) => void;
  onAddSnack?: () => void;
  onRemoveMeal?: (mealType: string) => void;
  onRestoreMeal?: (mealType: string) => void;
}

export default function NutritionCard({
  title,
  nutritionPlan,
  checkedMeals = {},
  onToggleMeal,
  onEditMeal,
  onAddSnack,
  onRemoveMeal,
  onRestoreMeal,
}: NutritionCardProps) {
  const { breakfast, lunch, dinner, snack, targets } = nutritionPlan;
  const removed = new Set(nutritionPlan.removedMeals ?? []);

  const allMeals: Array<{ key: string; emoji: string; meal: MealSuggestion | undefined }> = [
    { key: 'breakfast', emoji: '🌅', meal: breakfast },
    { key: 'lunch', emoji: '🥗', meal: lunch },
    { key: 'dinner', emoji: '🍽️', meal: dinner },
    { key: 'snack', emoji: '🥜', meal: snack },
  ];
  const visibleMeals = allMeals.filter(m => m.meal && !removed.has(m.key)) as Array<{ key: string; emoji: string; meal: MealSuggestion }>;
  const hiddenMeals = allMeals.filter(m => m.meal && removed.has(m.key)) as Array<{ key: string; emoji: string; meal: MealSuggestion }>;

  // Sum actual macros across all meals
  const actual = {
    calories: Math.round(visibleMeals.reduce((sum, m) => sum + m.meal.calories, 0)),
    protein:  Math.round(visibleMeals.reduce((sum, m) => sum + m.meal.protein, 0)),
    carbs:    Math.round(visibleMeals.reduce((sum, m) => sum + (m.meal.carbs ?? 0), 0)),
    fat:      Math.round(visibleMeals.reduce((sum, m) => sum + (m.meal.fat ?? 0), 0)),
  };

  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{title ? `${title} Nutrition` : 'Daily Nutrition'}</Text>
        {!snack && onAddSnack && (
          <TouchableOpacity style={styles.addSnackBtn} onPress={onAddSnack}>
            <Text style={styles.addSnackBtnText}>+ Snack</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Actual vs target for each macro */}
      <View style={styles.macrosGrid}>
        <MacroTracker
          label="Calories"
          actual={actual.calories}
          target={targets.calories}
          unit=""
          color={colors.accent}
        />
        <MacroTracker
          label="Protein"
          actual={actual.protein}
          target={targets.protein}
          unit="g"
          color={colors.primary}
        />
        <MacroTracker
          label="Carbs"
          actual={actual.carbs}
          target={targets.carbs}
          unit="g"
          color="#F59E0B"
        />
        <MacroTracker
          label="Fat"
          actual={actual.fat}
          target={targets.fat}
          unit="g"
          color="#A78BFA"
        />
      </View>

      {/* Meals */}
      <View style={styles.meals}>
        {visibleMeals.map(({ key, emoji, meal }) => (
          <MealRow
            key={key}
            emoji={emoji}
            mealType={key}
            meal={meal}
            checked={!!checkedMeals[key]}
            onToggle={onToggleMeal}
            onEdit={onEditMeal}
            onRemove={onRemoveMeal}
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
        <Text style={styles.footerText}>Stay hydrated throughout the day</Text>
      </View>
    </View>
  );
}

// ── MacroTracker ──────────────────────────────────────────────────────────────

function MacroTracker({
  label, actual, target, unit, color,
}: { label: string; actual: number; target: number; unit: string; color: string }) {
  const pct     = target > 0 ? Math.min(actual / target, 1) : 0;
  const over    = actual > target;
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

      {/* Progress bar */}
      <View style={styles.macroBarTrack}>
        <View
          style={[
            styles.macroBarFill,
            { width: `${Math.round(pct * 100)}%` as any, backgroundColor: barColor },
          ]}
        />
      </View>

      <Text style={[styles.macroRemaining, { color: over ? colors.error : colors.textMuted }]}>
        {over
          ? `${actual - target}${unit} over`
          : `${target - actual}${unit} left`}
      </Text>
    </View>
  );
}

// ── MealRow ───────────────────────────────────────────────────────────────────

function MealRow({ emoji, mealType, meal, checked, onToggle, onEdit, onRemove }: {
  emoji: string;
  mealType: string;
  meal: MealSuggestion;
  checked: boolean;
  onToggle?: (mealType: string) => void;
  onEdit?:   (mealType: string, meal: MealSuggestion) => void;
  onRemove?: (mealType: string) => void;
}) {
  return (
    <View style={[styles.mealItem, checked && styles.mealItemDone]}>
      <View style={styles.mealHeader}>
        <TouchableOpacity
          style={[styles.checkbox, checked && styles.checkboxDone]}
          onPress={() => onToggle?.(mealType)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          {checked && <Text style={styles.checkmark}>✓</Text>}
        </TouchableOpacity>
        <Text style={[styles.mealName, checked && styles.mealNameDone]}>
          {emoji}  {meal.meal}
        </Text>
        {onEdit && (
          <TouchableOpacity
            onPress={() => onEdit(mealType, meal)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.editBtn}>
            <Text style={styles.editBtnText}>Edit  ›</Text>
          </TouchableOpacity>
        )}
        {onRemove && (
          <TouchableOpacity
            onPress={() => onRemove(mealType)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.removeMealBtn}>
            <Text style={styles.removeMealBtnText}>Remove</Text>
          </TouchableOpacity>
        )}
      </View>

      <Text style={[styles.mealFoods, checked && styles.mealFoodsDone]}>
        {meal.foods.join(', ')}
      </Text>

      <View style={styles.mealBadges}>
        <MacroPill label="cal"     value={Math.round(meal.calories)}   color={colors.accent} />
        <MacroPill label="protein" value={Math.round(meal.protein)}    color={colors.primary} />
        <MacroPill label="carbs"   value={Math.round(meal.carbs ?? 0)} color="#F59E0B" />
        <MacroPill label="fat"     value={Math.round(meal.fat   ?? 0)} color="#A78BFA" />
      </View>
    </View>
  );
}

function MacroPill({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={[styles.pill, { borderColor: color + '55' }]}>
      <Text style={[styles.pillValue, { color }]}>{value}</Text>
      <Text style={styles.pillLabel}>{label}</Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: 16,
    marginBottom: 16,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  title: { fontSize: 18, fontWeight: '700', color: colors.textPrimary },
  addSnackBtn: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  addSnackBtnText: { fontSize: 12, color: colors.primary, fontWeight: '700' },

  // Macro grid
  macrosGrid: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    padding: 12, marginBottom: 14,
    gap: 2,
  },
  macroTracker: { flex: 1, alignItems: 'center', gap: 3 },

  macroTrackerLabel: {
    fontSize: 9, fontWeight: '700', color: colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  macroTrackerValues: { flexDirection: 'row', alignItems: 'baseline', gap: 2 },
  macroActual:  { fontSize: 14, fontWeight: '800' },
  macroSep:     { fontSize: 10, color: colors.textMuted },
  macroTarget:  { fontSize: 10, color: colors.textMuted, fontWeight: '500' },

  macroBarTrack: {
    width: '100%', height: 3, backgroundColor: colors.border,
    borderRadius: 2, overflow: 'hidden',
  },
  macroBarFill: { height: 3, borderRadius: 2 },

  macroRemaining: { fontSize: 9, fontWeight: '500' },

  // Meals
  meals: { gap: 10, marginBottom: 14 },

  mealItem: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md, padding: 12,
    borderWidth: 1, borderColor: colors.border,
    gap: 6,
  },
  mealItemDone: { opacity: 0.55, borderColor: colors.success },

  mealHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  checkbox: {
    width: 22, height: 22, borderRadius: 6,
    borderWidth: 2, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxDone: { backgroundColor: colors.success, borderColor: colors.success },
  checkmark:    { fontSize: 13, color: colors.background, fontWeight: '800' },

  mealName:     { flex: 1, fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  mealNameDone: { textDecorationLine: 'line-through', color: colors.textSecondary },

  editBtn:     { paddingHorizontal: 6 },
  editBtnText: { fontSize: 12, color: colors.primary, fontWeight: '600' },
  removeMealBtn: { paddingHorizontal: 6 },
  removeMealBtnText: { fontSize: 12, color: colors.error, fontWeight: '600' },

  mealFoods:     { fontSize: 13, color: colors.textSecondary, lineHeight: 18 },
  mealFoodsDone: { color: colors.textMuted },

  mealBadges: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  hiddenMealRow: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
    gap: 8,
  },
  hiddenMealText: { fontSize: 12, color: colors.textSecondary },
  restoreWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  restoreBtn: {
    backgroundColor: colors.surface,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.primary,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  restoreBtnText: { fontSize: 12, color: colors.primary, fontWeight: '600' },
  pill: {
    backgroundColor: colors.background, borderRadius: radius.sm,
    borderWidth: 1, paddingHorizontal: 8, paddingVertical: 4,
    alignItems: 'center', minWidth: 44,
  },
  pillValue: { fontSize: 13, fontWeight: '700' },
  pillLabel: { fontSize: 9, color: colors.textMuted, fontWeight: '500', marginTop: 1 },

  footer:     { paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border },
  footerText: { fontSize: 12, color: colors.textSecondary },
});
