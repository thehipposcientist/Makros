import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { DailyNutritionPlan, MealSuggestion, AppThemeName } from '../types';
import { getTheme, radius } from '../constants/theme';

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
  onToggleRoutine?: (mealType: string) => void;
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
  onToggleRoutine,
}: NutritionCardProps) {
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

  const allVisible = [...visibleMeals, ...extraMealItems];
  const actual = {
    calories: Math.round(allVisible.reduce((sum, m) => sum + m.meal.calories, 0)),
    protein:  Math.round(allVisible.reduce((sum, m) => sum + m.meal.protein, 0)),
    carbs:    Math.round(allVisible.reduce((sum, m) => sum + (m.meal.carbs ?? 0), 0)),
    fat:      Math.round(allVisible.reduce((sum, m) => sum + (m.meal.fat ?? 0), 0)),
  };

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

        {/* Meal rows */}
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
              onToggleRoutine={onToggleRoutine}
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
              onToggleRoutine={onToggleRoutine}
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

function MealRow({ emoji, mealType, meal, checked, onToggle, onEdit, onRemove, onToggleRoutine, colors, styles, mealAccent }: {
  emoji: string;
  mealType: string;
  meal: MealSuggestion;
  checked: boolean;
  onToggle?: (mealType: string) => void;
  onEdit?:   (mealType: string, meal: MealSuggestion) => void;
  onRemove?: (mealType: string) => void;
  onToggleRoutine?: (mealType: string) => void;
  colors: ReturnType<typeof getTheme>['colors'];
  styles: ReturnType<typeof createStyles>;
  mealAccent: ReturnType<typeof getTheme>['sections']['meals'];
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
        {onToggleRoutine && !mealType.startsWith('extra_') && (
          <TouchableOpacity
            onPress={() => onToggleRoutine(mealType)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.routineBtn}>
            <Text style={[styles.routineBtnText, meal.isRoutine ? { color: mealAccent.strong } : { color: colors.textMuted }]}>
              {meal.isRoutine ? '📌' : '○'} Everyday
            </Text>
          </TouchableOpacity>
        )}
        {onEdit && (
          <TouchableOpacity
            onPress={() => onEdit(mealType, meal)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.editBtn}>
            <Text style={styles.editBtnText}>Edit ›</Text>
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

      <View style={styles.mealFoodsDetail}>
        {meal.foods.map((food, i) => (
          <View key={i} style={styles.mealFoodRow}>
            <Text style={[styles.mealFoodName, checked && styles.mealFoodsDone]}>
              {food}
            </Text>
          </View>
        ))}
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
      </View>
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
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  addSnackBtnText: { fontSize: 12, color: section.text, fontWeight: '700' },

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

  editBtn:           { paddingHorizontal: 6 },
  editBtnText:       { fontSize: 12, color: section.strong, fontWeight: '700' },
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

  // ── Footer ───────────────────────────────────────────────────────────────────
  footer:     { paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border },
  footerText: { fontSize: 12, color: colors.textMuted, textAlign: 'center' },

  // Unused kept for legacy compat
  recipeToggle:     { paddingVertical: 2 },
  recipeToggleText: { fontSize: 11, color: section.text, fontWeight: '700' },
  mealFoodAmount:   { fontSize: 12, fontWeight: '800', color: section.strong, minWidth: 56 },
});
