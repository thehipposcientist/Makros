import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { DailyNutritionPlan } from '../types';

interface NutritionCardProps {
  nutritionPlan: DailyNutritionPlan;
}

export default function NutritionCard({ nutritionPlan }: NutritionCardProps) {
  const { breakfast, lunch, dinner, targets } = nutritionPlan;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>🍎 Nutrition Targets</Text>
      </View>

      {/* Daily Targets */}
      <View style={styles.targetsContainer}>
        <View style={styles.targetItem}>
          <Text style={styles.targetLabel}>Calories</Text>
          <Text style={styles.targetValue}>{targets.calories}</Text>
        </View>
        <View style={styles.targetItem}>
          <Text style={styles.targetLabel}>Protein</Text>
          <Text style={styles.targetValue}>{targets.protein}g</Text>
        </View>
        <View style={styles.targetItem}>
          <Text style={styles.targetLabel}>Carbs</Text>
          <Text style={styles.targetValue}>{targets.carbs}g</Text>
        </View>
        <View style={styles.targetItem}>
          <Text style={styles.targetLabel}>Fat</Text>
          <Text style={styles.targetValue}>{targets.fat}g</Text>
        </View>
      </View>

      {/* Meals */}
      <View style={styles.mealsContainer}>
        <MealItem meal={breakfast} emoji="🌅" />
        <MealItem meal={lunch} emoji="🥗" />
        <MealItem meal={dinner} emoji="🍽️" />
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText}>
          💧 Remember to stay hydrated throughout the day!
        </Text>
      </View>
    </View>
  );
}

interface MealItemProps {
  meal: {
    meal: string;
    foods: string[];
    calories: number;
    protein: number;
  };
  emoji: string;
}

function MealItem({ meal, emoji }: MealItemProps) {
  return (
    <View style={styles.mealItem}>
      <Text style={styles.mealName}>{emoji} {meal.meal}</Text>
      <View style={styles.foodsContainer}>
        <Text style={styles.foodsText}>{meal.foods.join(', ')}</Text>
      </View>
      <View style={styles.mealStats}>
        <View style={styles.mealStatBadge}>
          <Text style={styles.mealStatText}>{Math.round(meal.calories)} cal</Text>
        </View>
        <View style={styles.mealStatBadge}>
          <Text style={styles.mealStatText}>{meal.protein}g protein</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff0f5',
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderLeftWidth: 4,
    borderLeftColor: '#ff6b6b',
  },
  header: {
    marginBottom: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: '#000',
  },
  targetsContainer: {
    flexDirection: 'row',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    gap: 8,
  },
  targetItem: {
    flex: 1,
    alignItems: 'center',
  },
  targetLabel: {
    fontSize: 11,
    color: '#999',
    marginBottom: 4,
    fontWeight: '500',
  },
  targetValue: {
    fontSize: 16,
    fontWeight: '700',
    color: '#ff6b6b',
  },
  mealsContainer: {
    gap: 12,
    marginBottom: 12,
  },
  mealItem: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  mealName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#000',
    marginBottom: 8,
  },
  foodsContainer: {
    marginBottom: 8,
  },
  foodsText: {
    fontSize: 13,
    color: '#666',
    lineHeight: 18,
  },
  mealStats: {
    flexDirection: 'row',
    gap: 8,
  },
  mealStatBadge: {
    backgroundColor: '#f0f0f0',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  mealStatText: {
    fontSize: 12,
    color: '#666',
    fontWeight: '500',
  },
  footer: {
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
  },
  footerText: {
    fontSize: 12,
    color: '#ff6b6b',
    fontWeight: '500',
  },
});
