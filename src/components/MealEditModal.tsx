import { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, Modal, TouchableOpacity,
  StyleSheet, TextInput, KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { MealSuggestion, DailyNutritionPlan, SavedMealTemplate } from '../types';
import { FoodItem, FoodCategoryGroup, lookupFood } from '../hooks/useMetaData';
import { colors, radius } from '../constants/theme';
import { scanFoodsPhoto, searchFoodNutrition } from '../services/api';

interface Props {
  visible: boolean;
  mealType: string;           // 'breakfast' | 'lunch' | 'dinner'
  meal: MealSuggestion;
  nutritionPlan: DailyNutritionPlan; // full plan so we can show day total
  allFoods: FoodItem[];
  foodCategories: FoodCategoryGroup[];
  savedMeals?: SavedMealTemplate[];
  authToken?: string;
  onSave: (updated: MealSuggestion) => void;
  onClose: () => void;
  onAddCustomFood?: (item: { name: string; unit: string; calories: number; protein: number; carbs: number; fat: number }) => void;
}

interface Macros { calories: number; protein: number; carbs: number; fat: number; }

function calcMacros(foodNames: string[], allFoods: FoodItem[], extraMacros?: Map<string, { calories: number; protein: number; carbs: number; fat: number }>): Macros {
  let cal = 0, prot = 0, carbs = 0, fat = 0;
  for (const n of foodNames) {
    const item = lookupFood(n, allFoods);
    if (item) { cal += item.calories; prot += item.protein; carbs += item.carbs; fat += item.fat; }
    else {
      const ai = extraMacros?.get(n.toLowerCase());
      if (ai) { cal += ai.calories; prot += ai.protein; carbs += ai.carbs; fat += ai.fat; }
    }
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
  const fixed: Array<{ type: string; meal: MealSuggestion | undefined }> = [
    { type: 'breakfast', meal: plan.breakfast },
    { type: 'lunch',     meal: plan.lunch },
    { type: 'dinner',    meal: plan.dinner },
    { type: 'snack',     meal: plan.snack },
  ];
  let total = fixed
    .filter(({ type, meal }) => !!meal && type !== editingType)
    .reduce((acc, { meal }) => addMacros(acc, {
      calories: Math.round(meal!.calories),
      protein:  Math.round(meal!.protein),
      carbs:    Math.round(meal!.carbs ?? 0),
      fat:      Math.round(meal!.fat   ?? 0),
    }), zero);

  (plan.extraMeals ?? []).forEach((meal, idx) => {
    // For 'new_extra', count all existing extra meals. For 'extra_N', skip that index.
    if (`extra_${idx}` !== editingType) {
      total = addMacros(total, {
        calories: Math.round(meal.calories),
        protein:  Math.round(meal.protein),
        carbs:    Math.round(meal.carbs ?? 0),
        fat:      Math.round(meal.fat   ?? 0),
      });
    }
  });

  return total;
}

export default function MealEditModal({ visible, mealType, meal, nutritionPlan, allFoods, foodCategories, savedMeals = [], authToken, onSave, onClose, onAddCustomFood }: Props) {
  const [foods,       setFoods]       = useState<string[]>(meal.foods);
  const [search,      setSearch]      = useState('');
  const [scanLoading, setScanLoading] = useState(false);
  const [aiSearchLoading, setAiSearchLoading] = useState(false);
  const [aiResults, setAiResults] = useState<Array<{ name: string; serving: string; calories: number; protein: number; carbs: number; fat: number }>>([]);
  // Track AI-found foods with macros so calcMacros can use them
  const [aiFoodMacros, setAiFoodMacros] = useState<Map<string, { calories: number; protein: number; carbs: number; fat: number }>>(new Map());

  useEffect(() => {
    if (visible) {
      setFoods(meal.foods);
      setSearch('');
      setAiResults([]);
      setAiFoodMacros(new Map());
    }
  }, [visible, meal]);

  const pickAndScan = async (source: 'camera' | 'library') => {
    if (!authToken) return;
    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync({ base64: true, quality: 0.6, mediaTypes: 'images' })
      : await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.6, mediaTypes: 'images' });
    if (result.canceled || !result.assets[0]?.base64) return;
    const asset = result.assets[0];
    setScanLoading(true);
    try {
      const res = await scanFoodsPhoto(authToken, {
        images: [{ image_base64: asset.base64!, mime_type: asset.mimeType ?? 'image/jpeg' }],
      });
      const names = res.foods.map(f => f.name);
      if (names.length === 0) {
        Alert.alert('No foods found', 'Could not identify any foods in that photo.');
        return;
      }
      const newFoods = names.filter(n => !foods.includes(n));
      setFoods(prev => [...prev, ...newFoods]);
      if (newFoods.length === 0) Alert.alert('Already added', 'All identified foods are already in this meal.');
    } catch (e: any) {
      Alert.alert('Scan failed', e.message ?? 'Could not scan the photo.');
    } finally {
      setScanLoading(false);
    }
  };

  const rawMealMacros = calcMacros(foods, allFoods, aiFoodMacros);
  // If recalc returns all zeros but original meal had macros and foods unchanged, show original values
  const foodsMatchOriginal = foods.length === meal.foods.length && foods.every((f, i) => f === meal.foods[i]);
  const mealMacros = (rawMealMacros.calories === 0 && rawMealMacros.protein === 0 && foodsMatchOriginal && ((meal.calories ?? 0) > 0 || (meal.protein ?? 0) > 0))
    ? { calories: meal.calories, protein: meal.protein, carbs: meal.carbs ?? 0, fat: meal.fat ?? 0 }
    : rawMealMacros;
  const otherMacros = otherMealsMacros(nutritionPlan, mealType);
  const dayTotal    = addMacros(mealMacros, otherMacros);

  const removeFood = (name: string) => setFoods(prev => prev.filter(f => f !== name));
  const addFood    = (name: string) => {
    if (!foods.includes(name)) setFoods(prev => [...prev, name]);
  };

  const handleAiSearch = async () => {
    if (!authToken || !search.trim()) return;
    setAiSearchLoading(true);
    try {
      const res = await searchFoodNutrition(authToken, search.trim());
      setAiResults(res.results ?? []);
      if (!res.results?.length) Alert.alert('No results', `Could not find nutrition info for "${search}".`);
    } catch (e: any) {
      Alert.alert('Search failed', e.message ?? 'Could not reach the AI server.');
    } finally {
      setAiSearchLoading(false);
    }
  };

  const addAiFood = (item: { name: string; serving?: string; calories: number; protein: number; carbs: number; fat: number }) => {
    if (!foods.includes(item.name)) {
      setFoods(prev => [...prev, item.name]);
    }
    // Store macros so calcMacros can use them
    setAiFoodMacros(prev => {
      const next = new Map(prev);
      next.set(item.name.toLowerCase(), { calories: item.calories, protein: item.protein, carbs: item.carbs, fat: item.fat });
      return next;
    });
    // Persist to user's custom food library
    onAddCustomFood?.({
      name: item.name,
      unit: item.serving ?? '1 serving',
      calories: Math.round(item.calories),
      protein: Math.round(item.protein),
      carbs: Math.round(item.carbs),
      fat: Math.round(item.fat),
    });
    setAiResults(prev => prev.filter(r => r.name !== item.name));
  };

  const filteredCategories = foodCategories.map(cat => ({
    ...cat,
    foods: cat.foods.filter(f =>
      f.name.toLowerCase().includes(search.toLowerCase()) && !foods.includes(f.name)
    ),
  })).filter(cat => cat.foods.length > 0);

  const handleSave = () => {
    // mealMacros already falls back to original values when recalc can't resolve foods
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

  const titleMap: Record<string, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack', new_extra: 'Extra Meal' };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={s.container}>

        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={s.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <Text style={s.title}>{titleMap[mealType] ?? (mealType.startsWith('extra_') ? 'Extra Meal' : mealType)}</Text>
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
              const aiMacro = !item ? aiFoodMacros.get(name.toLowerCase()) : undefined;
              return (
                <View key={name} style={s.currentFoodRow}>
                  <View style={s.currentFoodInfo}>
                    <Text style={s.currentFoodName}>{name}</Text>
                    {item ? (
                      <Text style={s.currentFoodMacros}>
                        {item.calories} cal · {item.protein}g pro · {item.carbs}g carbs · {item.fat}g fat
                      </Text>
                    ) : aiMacro ? (
                      <Text style={s.currentFoodMacros}>
                        {aiMacro.calories} cal · {aiMacro.protein}g pro · {aiMacro.carbs}g carbs · {aiMacro.fat}g fat (AI)
                      </Text>
                    ) : (
                      <Text style={s.currentFoodMacros}>Not in library — macros not counted</Text>
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

            {savedMeals.length > 0 && (
              <>
                <Text style={[s.sectionLabel, { marginTop: 24 }]}>Saved Meals</Text>
                {savedMeals.map((template) => (
                  <TouchableOpacity
                    key={template.id}
                    style={s.savedMealRow}
                    onPress={() => {
                      onSave({
                        ...meal,
                        meal: template.name,
                        foods: template.items,
                        calories: template.calories,
                        protein: template.protein,
                        carbs: template.carbs,
                        fat: template.fat,
                      });
                      onClose();
                    }}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.savedMealName}>{template.name}</Text>
                      <Text style={s.savedMealMeta}>{template.items.join(', ')}</Text>
                    </View>
                    <Text style={s.savedMealApply}>Use</Text>
                  </TouchableOpacity>
                ))}
              </>
            )}

            {/* Food picker */}
            <Text style={[s.sectionLabel, { marginTop: 24 }]}>Add Foods</Text>

            {authToken && (
              <View style={s.scanRow}>
                <TouchableOpacity
                  style={[s.scanBtn, scanLoading && { opacity: 0.5 }]}
                  onPress={() => pickAndScan('camera')}
                  disabled={scanLoading}>
                  {scanLoading
                    ? <ActivityIndicator size="small" color={colors.primary} />
                    : <Text style={s.scanBtnText}>Take Photo</Text>}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.scanBtn, scanLoading && { opacity: 0.5 }]}
                  onPress={() => pickAndScan('library')}
                  disabled={scanLoading}>
                  <Text style={s.scanBtnText}>Choose Photo</Text>
                </TouchableOpacity>
              </View>
            )}

            <TextInput
              style={s.searchInput}
              value={search}
              onChangeText={setSearch}
              placeholder="Search foods..."
              placeholderTextColor={colors.textMuted}
              returnKeyType="search"
            />

            {filteredCategories.length === 0 && search.length > 0 && !aiSearchLoading && aiResults.length === 0 && (
              <Text style={s.emptyText}>No local matches for "{search}"</Text>
            )}

            {/* AI Food Search */}
            {authToken && search.length > 1 && (
              <TouchableOpacity
                style={[s.aiSearchBtn, aiSearchLoading && { opacity: 0.5 }]}
                onPress={handleAiSearch}
                disabled={aiSearchLoading}>
                {aiSearchLoading
                  ? <ActivityIndicator size="small" color={colors.primary} />
                  : <Text style={s.aiSearchBtnText}>Search "{search}" with AI</Text>}
              </TouchableOpacity>
            )}

            {aiResults.length > 0 && (
              <View style={{ marginBottom: 16 }}>
                <Text style={s.sectionLabel}>AI Results</Text>
                {aiResults.map((item, idx) => (
                  <TouchableOpacity key={`${item.name}-${idx}`} style={s.aiResultRow} onPress={() => addAiFood(item)}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.aiResultName}>{item.name}</Text>
                      <Text style={s.aiResultServing}>{item.serving}</Text>
                      <Text style={s.aiResultMacros}>
                        {item.calories} cal · {item.protein}g pro · {item.carbs}g carbs · {item.fat}g fat
                      </Text>
                    </View>
                    <Text style={s.aiResultAdd}>+ Add</Text>
                  </TouchableOpacity>
                ))}
              </View>
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
  savedMealRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    padding: 12, marginBottom: 8,
  },
  savedMealName: { fontSize: 14, fontWeight: '600', color: colors.textPrimary, marginBottom: 3 },
  savedMealMeta: { fontSize: 12, color: colors.textMuted },
  savedMealApply: { fontSize: 12, color: colors.primary, fontWeight: '700' },
  removeBtn: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: colors.error + '22', borderWidth: 1, borderColor: colors.error,
    alignItems: 'center', justifyContent: 'center', marginLeft: 10,
  },
  removeText: { fontSize: 18, color: colors.error, fontWeight: '700', lineHeight: 22 },

  scanRow: {
    flexDirection: 'row', gap: 10, marginBottom: 12,
  },
  scanBtn: {
    flex: 1, borderWidth: 1, borderColor: colors.primary,
    borderRadius: radius.md, paddingVertical: 10, alignItems: 'center',
    backgroundColor: colors.primary + '18',
  },
  scanBtnText: { fontSize: 13, fontWeight: '600', color: colors.primary },

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

  // AI search
  aiSearchBtn: {
    backgroundColor: colors.primary + '18',
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.primary + '44',
    paddingVertical: 10, paddingHorizontal: 16, alignItems: 'center', marginBottom: 16,
  },
  aiSearchBtnText: { fontSize: 13, fontWeight: '600', color: colors.primary },
  aiResultRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.primary + '44',
    padding: 12, marginBottom: 8,
  },
  aiResultName:    { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  aiResultServing: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  aiResultMacros:  { fontSize: 11, color: colors.textSecondary, marginTop: 2 },
  aiResultAdd:     { fontSize: 13, fontWeight: '700', color: colors.primary, marginLeft: 8 },
});
