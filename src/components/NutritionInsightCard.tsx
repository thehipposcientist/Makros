import { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform, UIManager } from 'react-native';
import { configureExpandAnimation } from '../utils/layoutAnim';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import { FIX_SUGGESTIONS, NutrientInsight, NutrientKey } from '../utils/nutritionLayers';
import { MealSuggestion } from '../types';

interface Props {
  insight: NutrientInsight;
  themeColors: { textPrimary: string; textSecondary: string; textMuted: string; border: string; surface: string; primary: string; surfaceRaised: string };
  meals?: MealSuggestion[];
}

const BACKEND_KEYS: Record<string, string[]> = {
  fiber: ['fiber'],
  sugar: ['sugar'],
  sodium: ['sodium'],
  cholesterol: ['cholesterol'],
  saturatedFat: ['saturated_fat', 'saturatedFat'],
  monounsaturatedFat: ['monounsaturated_fat', 'monounsaturatedFat'],
  polyunsaturatedFat: ['polyunsaturated_fat', 'polyunsaturatedFat'],
  omega3: ['omega_3', 'omega3'],
  omega6: ['omega_6', 'omega6'],
  potassium: ['potassium'],
  calcium: ['calcium'],
  iron: ['iron'],
  magnesium: ['magnesium'],
  vitaminD: ['vitamin_d', 'vitaminD'],
  vitaminC: ['vitamin_c', 'vitaminC'],
  vitaminB12: ['vitamin_b12', 'vitaminB12'],
};

const RICH_FOODS: Partial<Record<NutrientKey, string[]>> = {
  fiber: ['black beans', 'lentils', 'oats', 'raspberries', 'avocado', 'chia seeds', 'broccoli', 'sweet potato'],
  omega3: ['salmon', 'sardines', 'mackerel', 'flaxseed', 'walnuts', 'chia seeds', 'cod'],
  potassium: ['banana', 'sweet potato', 'spinach', 'avocado', 'white beans', 'coconut water', 'potato'],
  calcium: ['greek yogurt', 'cottage cheese', 'milk', 'cheese', 'tofu', 'kale', 'sardines', 'almonds'],
  iron: ['red meat', 'spinach', 'lentils', 'chickpeas', 'dark chocolate', 'quinoa', 'turkey'],
  magnesium: ['pumpkin seeds', 'almonds', 'spinach', 'dark chocolate', 'black beans', 'avocado', 'cashews'],
  vitaminD: ['salmon', 'sardines', 'egg yolks', 'mushrooms', 'fortified milk', 'cod liver oil'],
  vitaminC: ['bell pepper', 'oranges', 'strawberries', 'broccoli', 'kiwi', 'tomatoes', 'lemon'],
  vitaminB12: ['beef', 'salmon', 'eggs', 'milk', 'greek yogurt', 'clams', 'nutritional yeast'],
};

const LOW_IN_FOODS: Partial<Record<NutrientKey, string[]>> = {
  sugar: ['eggs', 'chicken breast', 'fish', 'nuts', 'cheese', 'leafy greens', 'avocado'],
  sodium: ['fresh fruit', 'rice', 'fresh vegetables', 'unsalted nuts', 'eggs', 'oats'],
  saturatedFat: ['chicken breast', 'fish', 'olive oil', 'avocado', 'egg whites', 'turkey'],
  cholesterol: ['oats', 'beans', 'nuts', 'olive oil', 'avocado', 'tofu', 'fruit'],
};

function getItemValue(micros: Record<string, any> | undefined, key: string): number {
  if (!micros) return 0;
  const keys = BACKEND_KEYS[key] ?? [key];
  for (const k of keys) {
    if (micros[k] != null) return Number(micros[k]) || 0;
  }
  return 0;
}

export default function NutritionInsightCard({ insight, themeColors, meals }: Props) {
  const [expanded, setExpanded] = useState(false);
  const accent =
    insight.severity === 'critical' ? '#F59E0B' :
    insight.severity === 'notable'  ? '#9CA3AF' :
    '#6B7280';
  const fix = FIX_SUGGESTIONS[insight.key];
  const directionWord = insight.direction === 'min' ? 'low' : 'high';
  const actual = Math.round(insight.actual);
  const target = insight.target;
  const isOver = insight.direction === 'max';

  const culprits: Array<{ food: string; meal: string; amount: number }> = [];
  if (expanded && meals) {
    for (const meal of meals) {
      for (const it of (meal.items ?? [])) {
        const val = getItemValue(it.micronutrients, insight.key);
        if (val > 0) {
          culprits.push({ food: it.name, meal: meal.meal, amount: val });
        }
      }
      if (!meal.items?.length) {
        const val = getItemValue(meal.micronutrients as any, insight.key);
        if (val > 0) {
          culprits.push({ food: meal.meal, meal: '', amount: val });
        }
      }
    }
    if (isOver) {
      culprits.sort((a, b) => b.amount - a.amount);
    } else {
      culprits.sort((a, b) => b.amount - a.amount);
    }
  }

  const suggestions = isOver
    ? LOW_IN_FOODS[insight.key] ?? []
    : RICH_FOODS[insight.key] ?? [];

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={() => { configureExpandAnimation(320); setExpanded(!expanded); }}
      style={[styles.card, { backgroundColor: themeColors.surface, borderLeftColor: accent, borderColor: themeColors.border }]}>
      <View style={styles.header}>
        <Text style={[styles.label, { color: themeColors.textPrimary }]}>
          {insight.label} is {directionWord}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={[styles.severity, { color: accent }]}>
            {insight.severity === 'critical' ? 'LOW' : 'WATCH'}
          </Text>
          <Text style={{ fontSize: 10, color: themeColors.textMuted }}>{expanded ? '▲' : '▼'}</Text>
        </View>
      </View>
      <Text style={[styles.numbers, { color: themeColors.textSecondary }]}>
        {actual}{insight.unit} vs {insight.direction === 'min' ? 'target' : 'limit'} {target}{insight.unit}
        {'  '}({Math.round(insight.ratio * 100)}%)
      </Text>
      {!expanded && fix ? (
        <Text style={[styles.fix, { color: themeColors.textMuted }]}>{fix}</Text>
      ) : null}
      {!expanded && <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }}>Tap for details</Text>}

      {expanded && (
        <View style={{ marginTop: 10 }}>
          {culprits.length > 0 && (
            <View style={{ marginBottom: 12 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: themeColors.textPrimary, marginBottom: 6 }}>
                {isOver ? 'Biggest contributors' : 'Current sources'}
              </Text>
              {culprits.slice(0, 5).map((c, i) => (
                <View key={`${c.food}-${i}`} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4, borderBottomWidth: i < Math.min(culprits.length, 5) - 1 ? 1 : 0, borderBottomColor: themeColors.border }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, color: themeColors.textPrimary, fontWeight: '500' }} numberOfLines={1}>{c.food}</Text>
                    {c.meal ? <Text style={{ fontSize: 11, color: themeColors.textMuted }}>{c.meal}</Text> : null}
                  </View>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: isOver ? accent : themeColors.primary, marginLeft: 8 }}>
                    {c.amount < 10 ? (Math.round(c.amount * 10) / 10) : Math.round(c.amount)}{insight.unit}
                  </Text>
                </View>
              ))}
            </View>
          )}
          {culprits.length === 0 && meals && meals.length > 0 && (
            <Text style={{ fontSize: 12, color: themeColors.textMuted, marginBottom: 10 }}>
              Per-food breakdown available after your next plan regen.
            </Text>
          )}

          {suggestions.length > 0 && (
            <View style={{ backgroundColor: themeColors.surfaceRaised, borderRadius: 8, padding: 10, marginBottom: 4 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: themeColors.textPrimary, marginBottom: 6 }}>
                {isOver ? 'Lower-' + insight.label.toLowerCase() + ' swaps' : 'Foods rich in ' + insight.label.toLowerCase()}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {suggestions.slice(0, 6).map(f => (
                  <View key={f} style={{ backgroundColor: (isOver ? accent : themeColors.primary) + '20', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12 }}>
                    <Text style={{ fontSize: 12, color: isOver ? accent : themeColors.primary, fontWeight: '600' }}>{f}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          {fix && (
            <Text style={[styles.fix, { color: themeColors.textMuted, marginTop: 6 }]}>{fix}</Text>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    borderLeftWidth: 3,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  label: { fontSize: 14, fontWeight: '700' },
  severity: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  numbers: { fontSize: 12, marginBottom: 4 },
  fix: { fontSize: 12, fontStyle: 'italic' },
});
