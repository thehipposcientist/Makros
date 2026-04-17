import { useState, useEffect, useMemo } from 'react';
import {
  View, Text, ScrollView, Modal, TouchableOpacity,
  StyleSheet, TextInput, KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
  LayoutAnimation, UIManager,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import * as ImagePicker from 'expo-image-picker';
import {
  MealSuggestion, DailyNutritionPlan, SavedMealTemplate,
  MealItem, FoodUnit, FOOD_UNIT_LABELS, FOOD_UNIT_GROUPS,
} from '../types';
import { FoodItem, FoodCategoryGroup, lookupFood } from '../hooks/useMetaData';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { scanFoodsPhoto, searchFoodNutrition, getMealInstructions } from '../services/api';
import { ensureItems, syncLegacyFieldsFromItems, splitFoodString, convertQuantity, parseAmountString, guessUnitForFood } from '../utils/mealItems';

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
  cookingSkill?: string;
  prepTimeMinutes?: number;
  dietaryPreference?: string;
  allergies?: string[];
  themeName?: AppThemeName;
}

interface Macros { calories: number; protein: number; carbs: number; fat: number; }

const _WEIGHT_UNITS = new Set<FoodUnit>(['g', 'kg', 'oz', 'lb']);
const _VOLUME_UNITS = new Set<FoodUnit>(['ml', 'l', 'fl_oz', 'cup', 'tbsp', 'tsp', 'pint', 'quart', 'gallon']);

function _crossSystemDefault(fromUnit: FoodUnit, toUnit: FoodUnit, fromQty: number): number {
  // Estimate a reasonable default quantity when switching between incompatible
  // unit systems (e.g. serving→grams). The idea: 1 serving ≈ 100-150g for
  // most foods. We pick sensible defaults so the user has a starting point.
  const toWeight = _WEIGHT_UNITS.has(toUnit);
  const toVolume = _VOLUME_UNITS.has(toUnit);
  const fromCount = !_WEIGHT_UNITS.has(fromUnit) && !_VOLUME_UNITS.has(fromUnit);
  const toCount = !toWeight && !toVolume;

  if (fromCount && toWeight) {
    // serving/piece → weight: assume 1 serving ≈ 100g
    const perServing = toUnit === 'g' ? 100 : toUnit === 'oz' ? 3.5 : toUnit === 'kg' ? 0.1 : toUnit === 'lb' ? 0.22 : 100;
    return Math.round(fromQty * perServing * 100) / 100;
  }
  if (fromCount && toVolume) {
    // serving/piece → volume: assume 1 serving ≈ 1 cup
    const perServing = toUnit === 'cup' ? 1 : toUnit === 'ml' ? 240 : toUnit === 'fl_oz' ? 8 : toUnit === 'tbsp' ? 16 : toUnit === 'tsp' ? 48 : toUnit === 'l' ? 0.24 : 1;
    return Math.round(fromQty * perServing * 100) / 100;
  }
  if (toCount) {
    // weight/volume → serving/piece: assume 100g or 1 cup = 1 serving
    return Math.max(1, Math.round(fromQty > 0 ? 1 : 1));
  }
  // weight ↔ volume: can't convert without density, keep quantity as-is
  return fromQty;
}

/** Sum macros directly from the structured item list. Each item carries its
 *  own snapshotted macros so we don't need to look anything up here.
 *
 *  When `items` is empty OR every item is zero-macro (which can happen
 *  with AI-generated meals where only the meal-level totals are real),
 *  fall back to the meal's top-level macros so the totals panel doesn't
 *  show 0 cal for a meal that obviously has nutrition data. */
function calcMacrosFromItems(items: MealItem[], fallback?: MealSuggestion): Macros {
  const totals = items.reduce(
    (acc, it) => ({
      calories: acc.calories + (it.calories ?? 0),
      protein:  acc.protein  + (it.protein  ?? 0),
      carbs:    acc.carbs    + (it.carbs    ?? 0),
      fat:      acc.fat      + (it.fat      ?? 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
  const hasItemMacros = totals.calories > 0 || totals.protein > 0 || totals.carbs > 0 || totals.fat > 0;
  if (!hasItemMacros && fallback) {
    return {
      calories: Math.round(fallback.calories ?? 0),
      protein:  Math.round(fallback.protein  ?? 0),
      carbs:    Math.round(fallback.carbs    ?? 0),
      fat:      Math.round(fallback.fat      ?? 0),
    };
  }
  return totals;
}

function addMacros(a: Macros, b: Macros): Macros {
  return {
    calories: a.calories + b.calories,
    protein:  a.protein  + b.protein,
    carbs:    a.carbs    + b.carbs,
    fat:      a.fat      + b.fat,
  };
}

// Returns macros for all meals EXCEPT the one being edited.
// `editingType` is now `meal_<index>` or `new_meal` (for an unsaved
// brand-new meal), so we just skip the matching index.
function otherMealsMacros(plan: DailyNutritionPlan, editingType: string): Macros {
  const zero: Macros = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const meals = Array.isArray(plan.meals) ? plan.meals : [];
  return meals.reduce<Macros>((acc, meal, idx) => {
    if (`meal_${idx}` === editingType) return acc;
    return addMacros(acc, {
      calories: Math.round(meal.calories ?? 0),
      protein:  Math.round(meal.protein ?? 0),
      carbs:    Math.round(meal.carbs ?? 0),
      fat:      Math.round(meal.fat ?? 0),
    });
  }, zero);
}

export default function MealEditModal({ visible, mealType, meal, nutritionPlan, allFoods, foodCategories, savedMeals = [], authToken, onSave, onClose, onAddCustomFood, onToggleRoutine, cookingSkill, prepTimeMinutes, dietaryPreference, allergies, themeName }: Props) {
  const colors = useMemo(() => getTheme(themeName).colors, [themeName]);
  const s = useMemo(() => createStyles(colors), [colors]);
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
  // On-demand recipe/prep instructions. Populated from `meal.instructions`
  // if already cached, otherwise fetched lazily from the AI endpoint on tap.
  const [instructions, setInstructions] = useState<string | null>(meal.instructions ?? null);
  const [instructionsLoading, setInstructionsLoading] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  // Editable meal name. Every meal can be renamed — there are no fixed
  // slots anymore, so the recipe name IS the meal's identity.
  const [mealName, setMealName] = useState<string>(meal.meal ?? '');
  // `new_meal` (legacy: `new_extra`) is the sentinel for an unsaved meal
  // being created via the "Add Meal" button. Anything else is an existing
  // meal at index N. The flag isn't read directly anymore — naming is
  // controlled by `mealName` either way — but kept here for documentation.
  void (mealType === 'new_meal' || mealType === 'new_extra');

  useEffect(() => {
    if (visible) {
      setItems(seedItemBaselines(ensureItems(meal).items ?? []));
      setSearch('');
      setAiResults([]);
      setUnitPickerIdx(null);
      setInstructions(meal.instructions ?? null);
      setShowInstructions(false);
      setMealName(meal.meal ?? '');
    }
  }, [visible, meal]);

  const fetchInstructions = async () => {
    if (!authToken) return;
    // If we already have cached instructions, just show them.
    if (instructions) {
      setShowInstructions(true);
      return;
    }
    setInstructionsLoading(true);
    try {
      const res = await getMealInstructions(authToken, {
        meal_name: meal.meal,
        items: items.map(it => ({ name: it.name, quantity: it.quantity, unit: it.unit })),
        cooking_skill: cookingSkill,
        prep_time_minutes: prepTimeMinutes,
        dietary_preference: dietaryPreference,
        allergies,
      });
      setInstructions(res.instructions);
      setShowInstructions(true);
    } catch (e: any) {
      Alert.alert('Could not load instructions', e?.message ?? 'Try again in a moment.');
    } finally {
      setInstructionsLoading(false);
    }
  };

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
    // Library photos are often full-resolution (12–48 MP) and their base64
    // payloads trip the backend request size limit. Camera capture is
    // already cropped, so we only aggressively shrink the library path.
    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync({ base64: true, quality: 0.6, mediaTypes: 'images', exif: false })
      : await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.4, mediaTypes: 'images', exif: false });
    if (result.canceled || !result.assets[0]?.base64) return;
    const asset = result.assets[0];
    setScanLoading(true);
    try {
      // Use the asset's actual mime type. `quality < 1` forces
      // expo-image-picker to re-encode HEIC/PNG to JPEG, so `asset.mimeType`
      // is usually `image/jpeg` already — but when the source is already a
      // JPEG or PNG the picker may return the original mime. Hard-coding
      // `image/jpeg` was breaking library picks when the bytes weren't
      // actually JPEG (OpenAI vision then rejected with "wrong format").
      const rawMime = (asset.mimeType || '').toLowerCase();
      const mime =
        rawMime === 'image/jpeg' || rawMime === 'image/jpg' || rawMime === 'image/png' || rawMime === 'image/webp'
          ? (rawMime === 'image/jpg' ? 'image/jpeg' : rawMime)
          : 'image/jpeg';
      const res = await scanFoodsPhoto(authToken, {
        images: [{ image_base64: asset.base64!, mime_type: mime }],
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
          // Prefer the macros the AI scan already returned for this food.
          // Only fall back to the local library when the AI numbers are
          // all zero (e.g. a recognizer that names a food but can't
          // estimate nutrition). Historically this block ignored `p`'s
          // macros entirely and only read `lookupFood`, which meant every
          // scanned food that wasn't already in the user's library came
          // back with 0 cal / 0 protein.
          const aiHasMacros =
            (p.calories ?? 0) > 0 || (p.protein ?? 0) > 0 ||
            (p.carbs ?? 0) > 0 || (p.fat ?? 0) > 0;
          const lib = aiHasMacros ? null : lookupFood(p.name, allFoods);
          const cal  = aiHasMacros ? (p.calories ?? 0) : (lib?.calories ?? 0);
          const prot = aiHasMacros ? (p.protein  ?? 0) : (lib?.protein  ?? 0);
          const carb = aiHasMacros ? (p.carbs    ?? 0) : (lib?.carbs    ?? 0);
          const fat  = aiHasMacros ? (p.fat      ?? 0) : (lib?.fat      ?? 0);
          // The scan returns a human serving label like "1 cup" or
          // "100 g". Parse it so the item displays its true serving
          // instead of the meaningless "1 serving" placeholder.
          const parsed = p.serving ? parseAmountString(p.serving) : null;
          const guess  = guessUnitForFood(p.name);
          const qty  = parsed?.quantity ?? guess.quantity;
          const unit = (parsed?.unit ?? guess.unit) as FoodUnit;
          return {
            name: p.name,
            quantity: qty,
            unit,
            calories: cal, protein: prot, carbs: carb, fat,
            baseQuantity: qty > 0 ? qty : 1,
            baseCalories: cal, baseProtein: prot, baseCarbs: carb, baseFat: fat,
          };
        });
        setItems(prev => [...prev, ...newItems]);
        // Persist the scanned food into the user's custom library so
        // future meals (and the backend's nutrition lookup) can find it
        // without another AI call. Mirrors the flow used by the AI
        // search-result "Save" button.
        if (onAddCustomFood) {
          for (const p of picked) {
            const hasMacros =
              (p.calories ?? 0) > 0 || (p.protein ?? 0) > 0 ||
              (p.carbs ?? 0) > 0 || (p.fat ?? 0) > 0;
            if (!hasMacros) continue;
            if (allFoods.some(f => f.name.toLowerCase() === p.name.toLowerCase())) continue;
            onAddCustomFood({
              name: p.name,
              unit: p.serving || '1 serving',
              calories: p.calories ?? 0,
              protein:  p.protein  ?? 0,
              carbs:    p.carbs    ?? 0,
              fat:      p.fat      ?? 0,
            });
          }
        }
      }
    } catch (e: any) {
      // Surface backend detail (e.g. "image too large", "wrong format")
      // so we can diagnose library-photo failures. The generic "Could
      // not scan" hid the real root cause.
      const detail = e?.message || e?.detail || 'Could not scan the photo.';
      console.warn('[MealEditModal] scan failed:', detail);
      Alert.alert('Scan failed', detail);
    } finally {
      setScanLoading(false);
    }
  };

  const mealMacros = calcMacrosFromItems(items, meal);
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

    // Prefer the library entry's canonical serving over a generic default.
    // `lib.unit` looks like "1 cup (244ml)" or "1 large (118g)". When neither
    // the parsed string nor the library carries a usable unit, fall back to
    // a food-type-aware guess (cup for liquids, oz for meat, etc.) so we
    // never display the meaningless "1 serving" label.
    const libParsed = lib?.unit ? parseAmountString(lib.unit) : null;
    const guess = guessUnitForFood(cleanName);
    let qty = parsed.quantity ?? libParsed?.quantity ?? guess.quantity;
    let unit = parsed.unit ?? libParsed?.unit ?? guess.unit;
    if ((unit as string) === 'serving') {
      qty = guess.quantity;
      unit = guess.unit;
    }

    const newItem: MealItem = {
      name: cleanName,
      quantity: qty,
      unit,
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

      // 1. Unit-only change: convert the quantity to the new unit so
      //    the physical amount is preserved. Macros stay the same
      //    (1 cup of milk == 8 fl oz of milk == same calories). When
      //    the conversion crosses systems (e.g. serving → g), use a
      //    reasonable default weight and reset the baseline so future
      //    quantity edits scale correctly in the new unit.
      if (patch.unit != null && patch.unit !== current.unit && patch.quantity == null) {
        const converted = convertQuantity(current.quantity, current.unit, patch.unit);
        if (converted != null) {
          const baseConverted = current.baseQuantity != null
            ? (convertQuantity(current.baseQuantity, current.unit, patch.unit) ?? current.baseQuantity)
            : current.baseQuantity;
          next[idx] = {
            ...current,
            unit: patch.unit,
            quantity: Math.round(converted * 100) / 100,
            baseQuantity: baseConverted != null ? Math.round(baseConverted * 100) / 100 : current.baseQuantity,
          };
        } else {
          // Cross-system switch (e.g. serving→g, piece→oz). We can't
          // convert the quantity so we estimate a reasonable default in
          // the new unit and reset the baseline. Macros stay frozen at
          // their current values — the user adjusts quantity from here.
          const defaultQty = _crossSystemDefault(current.unit, patch.unit, current.quantity);
          next[idx] = {
            ...current,
            unit: patch.unit,
            quantity: defaultQty,
            baseQuantity: defaultQty,
            baseCalories: current.calories,
            baseProtein:  current.protein,
            baseCarbs:    current.carbs,
            baseFat:      current.fat,
          };
        }
        return next;
      }

      // 2. Quantity changes scale macros off the item's *baseline*
      //    rate (captured at add-time) rather than off the current
      //    macros. This way zero → N edits still work: if the user
      //    clears the input and retypes, macros come back up from
      //    the baseline instead of being permanently stuck at 0.
      if (patch.quantity != null && patch.quantity !== current.quantity) {
        const baseQty = current.baseQuantity && current.baseQuantity > 0 ? current.baseQuantity : 1;
        const ratio = patch.quantity / baseQty;
        const scaledMicros = current.micronutrients
          ? Object.fromEntries(
              Object.entries(current.micronutrients).map(([k, v]) =>
                [k, typeof v === 'number' ? Math.round((v / (current.quantity || 1)) * (patch.quantity ?? current.quantity) * 100) / 100 : v]
              )
            )
          : undefined;
        next[idx] = {
          ...current,
          ...patch,
          calories: Math.round((current.baseCalories ?? current.calories) * ratio),
          protein:  Math.round((current.baseProtein  ?? current.protein)  * ratio),
          carbs:    Math.round((current.baseCarbs    ?? current.carbs)    * ratio),
          fat:      Math.round((current.baseFat      ?? current.fat)      * ratio),
          ...(scaledMicros ? { micronutrients: scaledMicros } : {}),
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
    // Recompute meal-level micronutrients from per-item micros so the
    // nutrition details modal reflects edits immediately.
    const resummedMicros: Record<string, number> = {};
    for (const it of items) {
      if (!it.micronutrients) continue;
      for (const [k, v] of Object.entries(it.micronutrients)) {
        if (typeof v === 'number') resummedMicros[k] = (resummedMicros[k] ?? 0) + v;
      }
    }
    const finalMeal: MealSuggestion = {
      ...meal,
      meal: mealName.trim() || meal.meal || 'Meal',
      items,
      ...(instructions ? { instructions } : {}),
      ...(Object.keys(resummedMicros).length > 0
        ? { micronutrients: { ...(meal.micronutrients ?? {}), ...resummedMicros } }
        : {}),
    };
    const synced = syncLegacyFieldsFromItems(finalMeal);
    onSave(synced);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={s.container}>

        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={s.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <View style={s.headerCenter}>
            {/* Meal name is editable for every meal (Breakfast slot can
                be "Oatmeal Bowl" → "My Power Bowl"). For fixed slots we
                show the slot label as a small subtitle below so the
                user still knows which meal they're editing. */}
            <TextInput
              style={[s.title, { textAlign: 'center', minWidth: 180, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, backgroundColor: colors.surfaceRaised }]}
              value={mealName}
              onChangeText={setMealName}
              placeholder="Meal name"
              placeholderTextColor={colors.textMuted}
              returnKeyType="done"
            />
            {/* No slot subtitle — the meal name above is the only identity. */}
            {onToggleRoutine && (
              <TouchableOpacity onPress={onToggleRoutine} style={s.routineBadge} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                <Text style={[s.routineBadgeText, meal.isRoutine && s.routineBadgeTextActive]}>
                  {meal.isRoutine ? 'Pinned' : 'Pin as Routine'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
          <TouchableOpacity onPress={handleSave} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={s.saveText}>Save</Text>
          </TouchableOpacity>
        </View>

        {/* How to make this — on-demand AI recipe, cached on the meal */}
        <TouchableOpacity
          onPress={fetchInstructions}
          disabled={instructionsLoading}
          style={{
            marginHorizontal: 16,
            marginTop: 8,
            paddingVertical: 10,
            paddingHorizontal: 14,
            borderRadius: 12,
            backgroundColor: colors.surfaceRaised,
            borderWidth: 1,
            borderColor: colors.border,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}>
          {instructionsLoading ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : (
            <>
              <Ionicons name="restaurant-outline" size={16} color={colors.textPrimary} />
              <Text style={{ color: colors.textPrimary, fontWeight: '700', fontSize: 14 }}>
                {instructions ? 'View Recipe' : 'Get Recipe'}
              </Text>
            </>
          )}
        </TouchableOpacity>

        {showInstructions && instructions && (
          <View
            style={{
              marginHorizontal: 16,
              marginTop: 8,
              padding: 14,
              borderRadius: 12,
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.border,
            }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.5 }}>RECIPE</Text>
              <TouchableOpacity onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setShowInstructions(false); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="chevron-up" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <Text style={{ fontSize: 13, color: colors.textPrimary, lineHeight: 19 }}>{instructions}</Text>
          </View>
        )}

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
                  {/* Food name — read-only. Renaming a food breaks its
                      identity link with the food library, so users
                      should remove and re-add to swap a food. */}
                  <Text style={s.foodNameInput} numberOfLines={1}>
                    {it.name}
                  </Text>
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
                      onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setUnitPickerIdx(unitPickerIdx === idx ? null : idx); }}>
                      <Text style={s.unitBtnText}>{FOOD_UNIT_LABELS[it.unit]} <Ionicons name="chevron-down" size={11} /></Text>
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
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                    <Text style={{ fontSize: 11, color: colors.accent, fontWeight: '600' }}>{Math.round(it.calories)} cal</Text>
                    <Text style={{ fontSize: 11, color: colors.primary, fontWeight: '600' }}>{Math.round(it.protein)}g P</Text>
                    <Text style={{ fontSize: 11, color: '#F59E0B', fontWeight: '600' }}>{Math.round(it.carbs)}g C</Text>
                    <Text style={{ fontSize: 11, color: '#A78BFA', fontWeight: '600' }}>{Math.round(it.fat)}g F</Text>
                  </View>
                </View>
                <TouchableOpacity
                  onPress={() => removeItem(idx)}
                  style={s.removeBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="remove-circle-outline" size={20} color={colors.error ?? '#EF4444'} />
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
                    : <><Ionicons name="camera-outline" size={16} color={colors.primary} /><Text style={s.scanBtnText}>Camera</Text></>}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.scanBtn, scanLoading && { opacity: 0.5 }]}
                  onPress={() => pickAndScan('library')}
                  disabled={scanLoading}>
                  <Ionicons name="images-outline" size={16} color={colors.primary} /><Text style={s.scanBtnText}>Photos</Text>
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
                  <Ionicons name="close-circle" size={18} color={colors.textMuted} />
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

function createStyles(colors: ReturnType<typeof getTheme>['colors']) { return StyleSheet.create({
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
}); }
