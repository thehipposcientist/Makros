import { View, Text, StyleSheet } from 'react-native';
import { DailyNutritionPlan } from '../types';
import { colors, radius } from '../constants/theme';

interface NutritionCardProps {
  nutritionPlan: DailyNutritionPlan;
}

export default function NutritionCard({ nutritionPlan }: NutritionCardProps) {
  const { breakfast, lunch, dinner, targets } = nutritionPlan;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Nutrition Targets</Text>

      <View style={styles.macrosRow}>
        <MacroBadge label="Calories" value={String(targets.calories)} unit="" highlight />
        <MacroBadge label="Protein"  value={String(targets.protein)}  unit="g" />
        <MacroBadge label="Carbs"    value={String(targets.carbs)}    unit="g" />
        <MacroBadge label="Fat"      value={String(targets.fat)}      unit="g" />
      </View>

      <View style={styles.meals}>
        <MealRow emoji="🌅" meal={breakfast} />
        <MealRow emoji="🥗" meal={lunch} />
        <MealRow emoji="🍽️" meal={dinner} />
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText}>Stay hydrated throughout the day</Text>
      </View>
    </View>
  );
}

function MacroBadge({ label, value, unit, highlight }: {
  label: string; value: string; unit: string; highlight?: boolean;
}) {
  return (
    <View style={styles.macroBadge}>
      <Text style={styles.macroLabel}>{label}</Text>
      <Text style={[styles.macroValue, highlight && styles.macroValueHighlight]}>
        {value}{unit}
      </Text>
    </View>
  );
}

function MealRow({ emoji, meal }: {
  emoji: string;
  meal: { meal: string; foods: string[]; calories: number; protein: number };
}) {
  return (
    <View style={styles.mealItem}>
      <Text style={styles.mealName}>{emoji}  {meal.meal}</Text>
      <Text style={styles.mealFoods}>{meal.foods.join(', ')}</Text>
      <View style={styles.mealBadges}>
        <View style={styles.badge}><Text style={styles.badgeText}>{Math.round(meal.calories)} cal</Text></View>
        <View style={styles.badge}><Text style={styles.badgeText}>{meal.protein}g protein</Text></View>
      </View>
    </View>
  );
}

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

  macrosRow: {
    flexDirection: 'row', backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md, padding: 12, marginBottom: 14,
    borderWidth: 1, borderColor: colors.border,
  },
  macroBadge:          { flex: 1, alignItems: 'center' },
  macroLabel:          { fontSize: 11, color: colors.textSecondary, marginBottom: 4, fontWeight: '500' },
  macroValue:          { fontSize: 16, fontWeight: '700', color: colors.textPrimary },
  macroValueHighlight: { color: colors.accent },

  meals:    { gap: 10, marginBottom: 14 },
  mealItem: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md, padding: 12,
    borderWidth: 1, borderColor: colors.border,
  },
  mealName:   { fontSize: 14, fontWeight: '600', color: colors.textPrimary, marginBottom: 6 },
  mealFoods:  { fontSize: 13, color: colors.textSecondary, lineHeight: 18, marginBottom: 8 },
  mealBadges: { flexDirection: 'row', gap: 8 },
  badge: {
    backgroundColor: colors.background,
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border,
  },
  badgeText: { fontSize: 12, color: colors.primary, fontWeight: '600' },

  footer:     { paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border },
  footerText: { fontSize: 12, color: colors.textSecondary },
});
