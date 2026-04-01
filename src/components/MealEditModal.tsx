import { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, Modal, TouchableOpacity,
  StyleSheet, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { MealSuggestion, DailyNutritionPlan } from '../types';
import { FoodItem, FoodCategoryGroup, lookupFood } from '../hooks/useMetaData';
import { colors, radius } from '../constants/theme';

interface Props {
  visible: boolean;
  mealType: string;           // 'breakfast' | 'lunch' | 'dinner'
  meal: MealSuggestion;
  nutritionPlan: DailyNutritionPlan; // full plan so we can show day total
  allFoods: FoodItem[];
  foodCategories: FoodCategoryGroup[];
  onSave: (updated: MealSuggestion) => void;
  onClose: () => void;
}

interface Macros { calories: number; protein: number; carbs: number; fat: number; }

function calcMacros(foodNames: string[], allFoods: FoodItem[]): Macros {
  let cal = 0, prot = 0, carbs = 0, fat = 0;
  for (const n of foodNames) {
    const item = lookupFood(n, allFoods);
    if (item) { cal += item.calories; prot += item.protein; carbs += item.carbs; fat += item.fat; }
  }
  return { calories: Math.round(cal), protein: Math.round(prot), carbs: Math.round(carbs), fat: Math.round(fat) };
}

function addMacros(a: Macros, b: Macros): Macros {
  return {
    calories: a.calories + b.calories,
    protein:  a.protein  + b.protein,
    carbs:    a.carbs    + b.carbs,
    fat:      a.fat      + b.fat,
  };
}

// Returns macros for all meals EXCEPT the one being edited
function otherMealsMacros(plan: DailyNutritionPlan, editingType: string): Macros {
  const zero: Macros = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const meals = [
    { type: 'breakfast', meal: plan.breakfast },
    { type: 'lunch',     meal: plan.lunch },
    { type: 'dinner',    meal: plan.dinner },
  ];
  return meals.reduce((acc, { type, meal }) => {
    if (type === editingType) return acc;
    return addMacros(acc, {
      calories: Math.round(meal.calories),
      protein:  Math.round(meal.protein),
      carbs:    Math.round(meal.carbs ?? 0),
      fat:      Math.round(meal.fat   ?? 0),
    });
  }, zero);
}

export default function MealEditModal({ visible, mealType, meal, nutritionPlan, allFoods, foodCategories, onSave, onClose }: Props) {
  const [foods,  setFoods]  = useState<string[]>(meal.foods);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (visible) {
      setFoods(meal.foods);
      setSearch('');
    }
  }, [visible, meal]);

  const mealMacros  = calcMacros(foods, allFoods);
  const otherMacros = otherMealsMacros(nutritionPlan, mealType);
  const dayTotal    = addMacros(mealMacros, otherMacros);

  const removeFood = (name: string) => setFoods(prev => prev.filter(f => f !== name));
  const addFood    = (name: string) => {
    if (!foods.includes(name)) setFoods(prev => [...prev, name]);
  };

  const filteredCategories = foodCategories.map(cat => ({
    ...cat,
    foods: cat.foods.filter(f =>
      f.name.toLowerCase().includes(search.toLowerCase()) && !foods.includes(f.name)
    ),
  })).filter(cat => cat.foods.length > 0);

  const handleSave = () => {
    onSave({
      ...meal,
      foods,
      calories: mealMacros.calories,
      protein:  mealMacros.protein,
      carbs:    mealMacros.carbs,
      fat:      mealMacros.fat,
    });
    onClose();
  };

  const titleMap: Record<string, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={s.container}>

        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={s.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <Text style={s.title}>{titleMap[mealType] ?? mealType}</Text>
          <TouchableOpacity onPress={handleSave} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={s.saveText}>Save</Text>
          </TouchableOpacity>
        </View>

        {/* Live macro totals panel */}
        <View style={s.totalsPanel}>

          {/* Column headers */}
          <View style={s.totalsHeader}>
            <View style={s.totalsRowLabel} />
            <Text style={s.totalsColHeader}>Cal</Text>
            <Text style={s.totalsColHeader}>Protein</Text>
            <Text style={s.totalsColHeader}>Carbs</Text>
            <Text style={s.totalsColHeader}>Fat</Text>
          </View>

          {/* This meal row */}
          <View style={s.totalsRow}>
            <Text style={s.totalsRowLabel}>This meal</Text>
            <Text style={[s.totalsVal, { color: colors.accent }]}>{mealMacros.calories}</Text>
            <Text style={[s.totalsVal, { color: colors.primary }]}>{mealMacros.protein}g</Text>
            <Text style={[s.totalsVal, { color: '#F59E0B' }]}>{mealMacros.carbs}g</Text>
            <Text style={[s.totalsVal, { color: '#A78BFA' }]}>{mealMacros.fat}g</Text>
          </View>

          <View style={s.totalsDivider} />

          {/* Day total row */}
          <View style={s.totalsRow}>
            <Text style={[s.totalsRowLabel, s.dayTotalLabel]}>Day total</Text>
            <Text style={[s.totalsVal, s.dayTotalVal, { color: colors.accent }]}>{dayTotal.calories}</Text>
            <Text style={[s.totalsVal, s.dayTotalVal, { color: colors.primary }]}>{dayTotal.protein}g</Text>
            <Text style={[s.totalsVal, s.dayTotalVal, { color: '#F59E0B' }]}>{dayTotal.carbs}g</Text>
            <Text style={[s.totalsVal, s.dayTotalVal, { color: '#A78BFA' }]}>{dayTotal.fat}g</Text>
          </View>
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <ScrollView
            style={s.scroll}
            contentContainerStyle={s.scrollContent}
            keyboardShouldPersistTaps="handled">

            {/* Current foods */}
            <Text style={s.sectionLabel}>Current Foods</Text>
            {foods.length === 0 && (
              <Text style={s.emptyText}>No foods — add some below</Text>
            )}
            {foods.map(name => {
              const item = lookupFood(name, allFoods);
              return (
                <View key={name} style={s.currentFoodRow}>
                  <View style={s.currentFoodInfo}>
                    <Text style={s.currentFoodName}>{name}</Text>
                    {item ? (
                      <Text style={s.currentFoodMacros}>
                        {item.calories} cal · {item.protein}g pro · {item.carbs}g carbs · {item.fat}g fat
                      </Text>
                    ) : (
                      <Text style={s.currentFoodMacros}>Not in local library — macros not counted</Text>
                    )}
                  </View>
                  <TouchableOpacity
                    onPress={() => removeFood(name)}
                    style={s.removeBtn}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Text style={s.removeText}>−</Text>
                  </TouchableOpacity>
                </View>
              );
            })}

            {/* Food picker */}
            <Text style={[s.sectionLabel, { marginTop: 24 }]}>Add Foods</Text>
            <TextInput
              style={s.searchInput}
              value={search}
              onChangeText={setSearch}
              placeholder="Search foods..."
              placeholderTextColor={colors.textMuted}
              returnKeyType="search"
            />

            {filteredCategories.length === 0 && search.length > 0 && (
              <Text style={s.emptyText}>No matches for "{search}"</Text>
            )}

            {filteredCategories.map(cat => (
              <View key={cat.key} style={s.catSection}>
                <Text style={s.catLabel}>{cat.icon}  {cat.label}</Text>
                <View style={s.foodChips}>
                  {cat.foods.map(food => (
                    <TouchableOpacity
                      key={food.name}
                      style={s.foodChip}
                      onPress={() => addFood(food.name)}>
                      <Text style={s.foodChipName}>{food.name}</Text>
                      <Text style={s.foodChipCal}>{food.calories} cal</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            ))}
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 56, paddingBottom: 14,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  title:      { fontSize: 16, fontWeight: '700', color: colors.textPrimary },
  cancelText: { fontSize: 15, color: colors.textSecondary },
  saveText:   { fontSize: 15, fontWeight: '700', color: colors.primary },

  // Totals panel
  totalsPanel: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1, borderBottomColor: colors.border,
    paddingHorizontal: 16, paddingVertical: 12,
    gap: 6,
  },
  totalsHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 2 },
  totalsColHeader: {
    flex: 1, textAlign: 'center',
    fontSize: 10, fontWeight: '700', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  totalsRow:      { flexDirection: 'row', alignItems: 'center' },
  totalsRowLabel: { width: 70, fontSize: 11, color: colors.textSecondary, fontWeight: '600' },
  totalsVal:      { flex: 1, textAlign: 'center', fontSize: 14, fontWeight: '700' },
  totalsDivider:  { height: 1, backgroundColor: colors.border, marginVertical: 4 },
  dayTotalLabel:  { color: colors.textPrimary, fontWeight: '700' },
  dayTotalVal:    { fontSize: 16 },

  scroll:        { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 48 },

  sectionLabel: {
    fontSize: 11, fontWeight: '700', color: colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10,
  },
  emptyText: { fontSize: 13, color: colors.textMuted, marginBottom: 16 },

  currentFoodRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    padding: 12, marginBottom: 8,
  },
  currentFoodInfo:   { flex: 1 },
  currentFoodName:   { fontSize: 14, fontWeight: '600', color: colors.textPrimary, marginBottom: 3 },
  currentFoodMacros: { fontSize: 12, color: colors.textMuted },
  removeBtn: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: colors.error + '22', borderWidth: 1, borderColor: colors.error,
    alignItems: 'center', justifyContent: 'center', marginLeft: 10,
  },
  removeText: { fontSize: 18, color: colors.error, fontWeight: '700', lineHeight: 22 },

  searchInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 12, fontSize: 14, color: colors.textPrimary,
    backgroundColor: colors.surface, marginBottom: 14,
  },

  catSection: { marginBottom: 16 },
  catLabel:   { fontSize: 11, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 },
  foodChips:  { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  foodChip: {
    backgroundColor: colors.surface, borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.border,
    paddingVertical: 6, paddingHorizontal: 12,
    flexDirection: 'row', alignItems: 'center', gap: 6,
  },
  foodChipName: { fontSize: 13, color: colors.textPrimary, fontWeight: '500' },
  foodChipCal:  { fontSize: 11, color: colors.textMuted },
});
