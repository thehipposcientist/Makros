import { useState, useEffect, useMemo } from 'react';
import {
  View, Text, ScrollView, Modal, TouchableOpacity,
  StyleSheet, TextInput, KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import {
  MealSuggestion, DailyNutritionPlan, SavedMealTemplate,
  MealItem, FoodUnit, FOOD_UNIT_LABELS, FOOD_UNIT_GROUPS,
} from '../types';
import { FoodItem, FoodCategoryGroup, lookupFood } from '../hooks/useMetaData';
import { colors, radius } from '../constants/theme';
import { scanFoodsPhoto, searchFoodNutrition } from '../services/api';
import { ensureItems, syncLegacyFieldsFromItems, splitFoodString } from '../utils/mealItems';

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
  onToggleRoutine?: () => void;
}

interface Macros { calories: number; protein: number; carbs: number; fat: number; }

/** Sum macros directly from the structured item list. Each item carries its
 *  own snapshotted macros so we don't need to look anything up here. */
function calcMacrosFromItems(items: MealItem[]): Macros {
  return items.reduce(
    (acc, it) => ({
      calories: acc.calories + (it.calories ?? 0),
      protein:  acc.protein  + (it.protein  ?? 0),
      carbs:    acc.carbs    + (it.carbs    ?? 0),
      fat:      acc.fat      + (it.fat      ?? 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
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

export default function MealEditModal({ visible, mealType, meal, nutritionPlan, allFoods, foodCategories, savedMeals = [], authToken, onSave, onClose, onAddCustomFood, onToggleRoutine }: Props) {
  // Structured items are the source of truth. Legacy foods[] / amounts[]
  // shapes are migrated via `ensureItems()` on open so downstream code only
  // has to handle the structured form. Each item gets a baseline rate
  // captured at mount so the scaling math survives going through zero.
  const seedItemBaselines = (arr: MealItem[]): MealItem[] => arr.map(it => ({
    ...it,
    baseQuantity: it.baseQuantity ?? (it.quantity > 0 ? it.quantity : 1),
    baseCalories: it.baseCalories ?? it.calories,
    baseProtein:  it.baseProtein  ?? it.protein,
    baseCarbs:    it.baseCarbs    ?? it.carbs,
    baseFat:      it.baseFat      ?? it.fat,
  }));
  const [items, setItems] = useState<MealItem[]>(() => seedItemBaselines(ensureItems(meal).items ?? []));
  const [search,      setSearch]      = useState('');
  const [scanLoading, setScanLoading] = useState(false);
  const [aiSearchLoading, setAiSearchLoading] = useState(false);
  const [aiResults, setAiResults] = useState<Array<{ name: string; serving: string; calories: number; protein: number; carbs: number; fat: number }>>([]);
  // Track which item is currently showing the unit picker popover.
  const [unitPickerIdx, setUnitPickerIdx] = useState<number | null>(null);
  // In-progress text for each row's quantity input. Lets the user type
  // intermediate states like "0." or "" without the parent state clobbering
  // the field. Committed back to `items` on blur / when parse is valid.
  const [qtyDrafts, setQtyDrafts] = useState<Record<number, string>>({});

  useEffect(() => {
    if (visible) {
      setItems(seedItemBaselines(ensureItems(meal).items ?? []));
      setSearch('');
      setAiResults([]);
      setUnitPickerIdx(null);
    }
  }, [visible, meal]);

  const pickAndScan = async (source: 'camera' | 'library') => {
    if (!authToken) return;
    if (source === 'camera') {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Camera permission needed', 'Enable camera access in Settings to scan food photos.');
        return;
      }
    } else {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Photo library permission needed', 'Enable photo access in Settings to scan food photos.');
        return;
      }
    }
    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync({ base64: true, quality: 0.6, mediaTypes: 'images' })
      : await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.6, mediaTypes: 'images' });
    if (result.canceled || !result.assets[0]?.base64) return;
    const asset = result.assets[0];
    setScanLoading(true);
    try {
      // Force `image/jpeg`. Expo ImagePicker with `base64: true` transcodes
      // HEIC/HEIF to JPEG bytes before returning base64, but `asset.mimeType`
      // still sometimes reports the original HEIC type. OpenAI vision
      // rejects HEIC outright ("wrong format" error), so we send the
      // mime that actually matches the bytes.
      const res = await scanFoodsPhoto(authToken, {
        images: [{ image_base64: asset.base64!, mime_type: 'image/jpeg' }],
      });
      const picked = res.foods.filter(f => !items.some(it => it.name.toLowerCase() === f.name.toLowerCase()));
      if (res.foods.length === 0) {
        Alert.alert('No foods found', 'Could not identify any foods in that photo.');
        return;
      }
      if (picked.length === 0) {
        Alert.alert('Already added', 'All identified foods are already in this meal.');
      } else {
        const newItems: MealItem[] = picked.map(p => {
          const lib = lookupFood(p.name, allFoods);
          const cal = lib?.calories ?? 0;
          const prot = lib?.protein ?? 0;
          const carb = lib?.carbs ?? 0;
          const fat = lib?.fat ?? 0;
          return {
            name: p.name,
            quantity: 1,
            unit: 'serving' as FoodUnit,
            calories: cal, protein: prot, carbs: carb, fat,
            baseQuantity: 1,
            baseCalories: cal, baseProtein: prot, baseCarbs: carb, baseFat: fat,
          };
        });
        setItems(prev => [...prev, ...newItems]);
      }
    } catch (e: any) {
      Alert.alert('Scan failed', e.message ?? 'Could not scan the photo.');
    } finally {
      setScanLoading(false);
    }
  };

  const mealMacros = calcMacrosFromItems(items);
  const otherMacros = otherMealsMacros(nutritionPlan, mealType);
  const dayTotal    = addMacros(mealMacros, otherMacros);

  const removeItem = (idx: number) => {
    setItems(prev => {
      const next = prev.slice();
      next.splice(idx, 1);
      return next;
    });
    setUnitPickerIdx(null);
  };
  const addFood = (name: string) => {
    if (items.some(it => it.name.toLowerCase() === name.toLowerCase())) return;
    const lib = lookupFood(name, allFoods);
    const parsed = splitFoodString(name);
    const cleanName = parsed.name || name;
    const qty = parsed.quantity ?? 1;
    const newItem: MealItem = {
      name: cleanName,
      quantity: qty,
      unit: parsed.unit ?? 'serving',
      calories: lib?.calories ?? 0,
      protein:  lib?.protein  ?? 0,
      carbs:    lib?.carbs    ?? 0,
      fat:      lib?.fat      ?? 0,
      baseQuantity: qty > 0 ? qty : 1,
      baseCalories: lib?.calories ?? 0,
      baseProtein:  lib?.protein  ?? 0,
      baseCarbs:    lib?.carbs    ?? 0,
      baseFat:      lib?.fat      ?? 0,
    };
    setItems(prev => [...prev, newItem]);
  };
  const updateItem = (idx: number, patch: Partial<MealItem>) => {
    setItems(prev => {
      const next = prev.slice();
      const current = next[idx];
      if (!current) return prev;
      // Quantity changes scale macros off the item's *baseline* rate
      // (captured at add-time) rather than off the current macros. This
      // way zero → N edits still work: if the user clears the input and
      // retypes, macros come back up from the baseline instead of being
      // permanently stuck at 0.
      if (patch.quantity != null && patch.quantity !== current.quantity) {
        const baseQty = current.baseQuantity && current.baseQuantity > 0 ? current.baseQuantity : 1;
        const ratio = patch.quantity / baseQty;
        next[idx] = {
          ...current,
          ...patch,
          calories: Math.round((current.baseCalories ?? current.calories) * ratio),
          protein:  Math.round((current.baseProtein  ?? current.protein)  * ratio),
          carbs:    Math.round((current.baseCarbs    ?? current.carbs)    * ratio),
          fat:      Math.round((current.baseFat      ?? current.fat)      * ratio),
        };
      } else {
        next[idx] = { ...current, ...patch };
      }
      return next;
    });
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

  const addAiFood = (aiItem: { name: string; serving?: string; calories: number; protein: number; carbs: number; fat: number }) => {
    if (!items.some(it => it.name.toLowerCase() === aiItem.name.toLowerCase())) {
      const parsed = aiItem.serving
        ? splitFoodString(`${aiItem.serving} ${aiItem.name}`)
        : { quantity: 1, unit: 'serving' as FoodUnit };
      const qty = parsed.quantity ?? 1;
      const cal = Math.round(aiItem.calories);
      const prot = Math.round(aiItem.protein);
      const carb = Math.round(aiItem.carbs);
      const fat = Math.round(aiItem.fat);
      const newItem: MealItem = {
        name: aiItem.name,
        quantity: qty,
        unit: parsed.unit ?? 'serving',
        calories: cal, protein: prot, carbs: carb, fat,
        baseQuantity: qty > 0 ? qty : 1,
        baseCalories: cal, baseProtein: prot, baseCarbs: carb, baseFat: fat,
      };
      setItems(prev => [...prev, newItem]);
    }
    // Persist to user's custom food library
    onAddCustomFood?.({
      name: aiItem.name,
      unit: aiItem.serving ?? '1 serving',
      calories: Math.round(aiItem.calories),
      protein: Math.round(aiItem.protein),
      carbs: Math.round(aiItem.carbs),
      fat: Math.round(aiItem.fat),
    });
    setAiResults(prev => prev.filter(r => r.name !== aiItem.name));
  };

  // Memoized so it doesn't rebuild on every keystroke (the old code was
  // re-scanning the entire food library on every render, which made typing
  // in the search field feel laggy with the seeded ~200-item library).
  const filteredCategories = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const existingNames = new Set(items.map(it => it.name.toLowerCase()));
    return foodCategories
      .map(cat => ({
        ...cat,
        foods: cat.foods.filter(f =>
          (!needle || f.name.toLowerCase().includes(needle))
          && !existingNames.has(f.name.toLowerCase())
        ),
      }))
      .filter(cat => cat.foods.length > 0);
  }, [foodCategories, search, items]);

  const handleSave = () => {
    // Keep legacy foods[]/amounts[] in sync with items[] on save so older
    // readers (backend, other screens) still see correct data until the full
    // schema migration lands.
    const withItems: MealSuggestion = { ...meal, items };
    const synced = syncLegacyFieldsFromItems(withItems);
    onSave(synced);
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
          <View style={s.headerCenter}>
            <Text style={s.title}>{titleMap[mealType] ?? (mealType.startsWith('extra_') ? 'Extra Meal' : mealType)}</Text>
            {onToggleRoutine && (
              <TouchableOpacity onPress={onToggleRoutine} style={s.routineBadge} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                <Text style={[s.routineBadgeText, meal.isRoutine && s.routineBadgeTextActive]}>
                  {meal.isRoutine ? '📌 Routine' : '○ Pin as Routine'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
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

            {/* Current foods — structured editable rows */}
            <Text style={s.sectionLabel}>Current Foods</Text>
            {items.length === 0 && (
              <Text style={s.emptyText}>No foods — add some below</Text>
            )}
            {items.map((it, idx) => (
              <View key={`${it.name}-${idx}`} style={s.currentFoodRow}>
                <View style={s.currentFoodInfo}>
                  {/* Food name — editable so users can rename without deleting */}
                  <TextInput
                    style={s.foodNameInput}
                    value={it.name}
                    onChangeText={(t) => updateItem(idx, { name: t })}
                    placeholder="Food name"
                    placeholderTextColor={colors.textMuted}
                    returnKeyType="done"
                  />
                  {/* Quantity + unit row */}
                  <View style={s.qtyRow}>
                    <TextInput
                      style={s.qtyInput}
                      value={qtyDrafts[idx] ?? String(it.quantity)}
                      onChangeText={(t) => {
                        // Keep the raw text locally so intermediate states
                        // ("0.", ".5", "") render correctly. Only push a
                        // parsed number to the item when the text is a
                        // complete, valid number — otherwise the parent
                        // clobbers the field mid-typing.
                        setQtyDrafts(d => ({ ...d, [idx]: t }));
                        if (t === '' || t === '.' || t.endsWith('.')) return;
                        const parsed = parseFloat(t);
                        if (Number.isFinite(parsed)) {
                          updateItem(idx, { quantity: parsed });
                        }
                      }}
                      onBlur={() => {
                        // Commit on blur: if the draft is empty or invalid,
                        // fall back to 1 so we never leave the item at NaN.
                        const draft = qtyDrafts[idx];
                        if (draft != null) {
                          const parsed = parseFloat(draft);
                          updateItem(idx, { quantity: Number.isFinite(parsed) && parsed >= 0 ? parsed : 1 });
                          setQtyDrafts(d => { const { [idx]: _, ...rest } = d; return rest; });
                        }
                      }}
                      keyboardType="decimal-pad"
                      placeholder="1"
                      placeholderTextColor={colors.textMuted}
                    />
                    <TouchableOpacity
                      style={s.unitBtn}
                      onPress={() => setUnitPickerIdx(unitPickerIdx === idx ? null : idx)}>
                      <Text style={s.unitBtnText}>{FOOD_UNIT_LABELS[it.unit]} ▾</Text>
                    </TouchableOpacity>
                  </View>
                  {unitPickerIdx === idx && (
                    <View style={s.unitPicker}>
                      {FOOD_UNIT_GROUPS.map(group => (
                        <View key={group.label} style={s.unitGroup}>
                          <Text style={s.unitGroupLabel}>{group.label}</Text>
                          <View style={s.unitGroupRow}>
                            {group.units.map(u => (
                              <TouchableOpacity
                                key={u}
                                style={[s.unitChip, it.unit === u && s.unitChipActive]}
                                onPress={() => {
                                  updateItem(idx, { unit: u });
                                  setUnitPickerIdx(null);
                                }}>
                                <Text style={[s.unitChipText, it.unit === u && s.unitChipTextActive]}>
                                  {FOOD_UNIT_LABELS[u]}
                                </Text>
                              </TouchableOpacity>
                            ))}
                          </View>
                        </View>
                      ))}
                    </View>
                  )}
                  <Text style={s.currentFoodMacros}>
                    {Math.round(it.calories)} cal · {Math.round(it.protein)}g pro · {Math.round(it.carbs)}g carbs · {Math.round(it.fat)}g fat
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => removeItem(idx)}
                  style={s.removeBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text style={s.removeText}>−</Text>
                </TouchableOpacity>
              </View>
            ))}

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

            <View style={s.searchRow}>
              <TextInput
                style={[s.searchInput, { flex: 1, marginBottom: 0 }]}
                value={search}
                onChangeText={(t) => { setSearch(t); setAiResults([]); }}
                placeholder="Search foods..."
                placeholderTextColor={colors.textMuted}
                returnKeyType="search"
                onSubmitEditing={authToken && search.length > 1 ? handleAiSearch : undefined}
              />
              {search.length > 0 && (
                <TouchableOpacity style={s.clearBtn} onPress={() => { setSearch(''); setAiResults([]); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text style={s.clearBtnText}>✕</Text>
                </TouchableOpacity>
              )}
              {authToken && search.length > 1 && (
                <TouchableOpacity
                  style={[s.aiSearchInlineBtn, aiSearchLoading && { opacity: 0.5 }]}
                  onPress={handleAiSearch}
                  disabled={aiSearchLoading}>
                  {aiSearchLoading
                    ? <ActivityIndicator size="small" color="#FFFFFF" />
                    : <Text style={s.aiSearchInlineBtnText}>AI Search</Text>}
                </TouchableOpacity>
              )}
            </View>

            {filteredCategories.length === 0 && search.length > 0 && !aiSearchLoading && aiResults.length === 0 && (
              <Text style={s.emptyText}>No local matches — tap AI Search to find it</Text>
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
  headerCenter: { alignItems: 'center', flex: 1 },
  title:      { fontSize: 16, fontWeight: '700', color: colors.textPrimary },
  routineBadge: { marginTop: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  routineBadgeText: { fontSize: 11, fontWeight: '600', color: colors.textMuted },
  routineBadgeTextActive: { color: colors.primary },
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
  foodNameInput: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    paddingVertical: 4,
    marginBottom: 4,
  },
  qtyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  qtyInput: {
    width: 68,
    fontSize: 14,
    color: colors.textPrimary,
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 6,
    textAlign: 'center',
  },
  unitBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  unitBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  unitPicker: {
    backgroundColor: colors.background,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 8,
    marginBottom: 8,
    gap: 6,
  },
  unitGroup: { gap: 4 },
  unitGroupLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  unitGroupRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  unitChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  unitChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  unitChipText: { fontSize: 12, color: colors.textPrimary },
  unitChipTextActive: { color: '#fff', fontWeight: '700' },
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

  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  searchInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 12, fontSize: 14, color: colors.textPrimary,
    backgroundColor: colors.surface, marginBottom: 14,
  },
  clearBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  clearBtnText: { fontSize: 13, color: colors.textSecondary, fontWeight: '700' },

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

  // AI search — inline button next to search input
  aiSearchInlineBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 10, paddingHorizontal: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  aiSearchInlineBtnText: { fontSize: 13, fontWeight: '700', color: '#FFFFFF' },
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
