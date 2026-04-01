import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { DailyNutritionPlan, MealSuggestion } from '../types';
import { colors, radius } from '../constants/theme';

interface NutritionCardProps {
  nutritionPlan: DailyNutritionPlan;
  checkedMeals?: Record<string, boolean>;
  onToggleMeal?: (mealType: string) => void;
  onEditMeal?:   (mealType: string, meal: MealSuggestion) => void;
}

export default function NutritionCard({
  nutritionPlan,
  checkedMeals = {},
  onToggleMeal,
  onEditMeal,
}: NutritionCardProps) {
  const { breakfast, lunch, dinner, targets } = nutritionPlan;

  // Sum actual macros across all meals
  const actual = {
    calories: Math.round(breakfast.calories + lunch.calories + dinner.calories),
    protein:  Math.round(breakfast.protein  + lunch.protein  + dinner.protein),
    carbs:    Math.round((breakfast.carbs ?? 0) + (lunch.carbs ?? 0) + (dinner.carbs ?? 0)),
    fat:      Math.round((breakfast.fat   ?? 0) + (lunch.fat  ?? 0) + (dinner.fat   ?? 0)),
  };

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Daily Nutrition</Text>

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
        <MealRow
          emoji="🌅" mealType="breakfast" meal={breakfast}
          checked={!!checkedMeals.breakfast}
          onToggle={onToggleMeal}
          onEdit={onEditMeal}
        />
        <MealRow
          emoji="🥗" mealType="lunch" meal={lunch}
          checked={!!checkedMeals.lunch}
          onToggle={onToggleMeal}
          onEdit={onEditMeal}
        />
        <MealRow
          emoji="🍽️" mealType="dinner" meal={dinner}
          checked={!!checkedMeals.dinner}
          onToggle={onToggleMeal}
          onEdit={onEditMeal}
        />
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

function MealRow({ emoji, mealType, meal, checked, onToggle, onEdit }: {
  emoji: string;
  mealType: string;
  meal: MealSuggestion;
  checked: boolean;
  onToggle?: (mealType: string) => void;
  onEdit?:   (mealType: string, meal: MealSuggestion) => void;
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
  title: { fontSize: 18, fontWeight: '700', color: colors.textPrimary, marginBottom: 14 },

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

  mealFoods:     { fontSize: 13, color: colors.textSecondary, lineHeight: 18 },
  mealFoodsDone: { color: colors.textMuted },

  mealBadges: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
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
