import React, { useState, useEffect, useMemo, useRef } from 'react';
import BarcodeScannerModal from './BarcodeScannerModal';
import MealTimeSelector, { parseMealDateTime } from './MealTimeSelector';
import {
  View, Text, ScrollView, Modal, TouchableOpacity,
  StyleSheet, TextInput, KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
  LayoutAnimation, UIManager, Keyboard,
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
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { scanFoodsPhoto, searchFoodNutrition, getMealInstructions } from '../services/api';
import type { FoodSearchResult } from '../services/api';
import { buildGapMealSuggestion, positiveMacroGap } from '../utils/mealGapSuggestion';
import { ensureItems, syncLegacyFieldsFromItems, splitFoodString, convertQuantity, parseAmountString, guessUnitForFood, validUnitsForFood } from '../utils/mealItems';
import { badgeLabelForSource, searchUserFoodCategories } from '../utils/customFoodSearch';
import type { ProFeature } from '../utils/subscription';

interface Props {
  visible: boolean;
  mealType: string;           // 'breakfast' | 'lunch' | 'dinner'
  meal: MealSuggestion;
  nutritionPlan: DailyNutritionPlan; // full plan so we can show day total
  allFoods: FoodItem[];
  foodCategories: FoodCategoryGroup[];
  savedMeals?: SavedMealTemplate[];
  authToken?: string;
  dateKey?: string;           // e.g. '2026-04-18' — enables immediate AsyncStorage persist
  onSave: (updated: MealSuggestion) => void;
  onClose: () => void;
  onAddCustomFood?: (item: {
    name: string;
    unit: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    micronutrients?: Record<string, number>;
    verificationStatus?: 'ai_estimated' | 'ai_validated' | 'user_corrected' | 'seed_verified' | 'insufficient_data';
  }) => void;
  onToggleRoutine?: () => void;
  /** Save the current meal's items as a reusable Saved Meal (distinct
   *  from Routine — Routine = scheduled recurring, Saved = one-tap log
   *  from the Add Foods flow). When null/undefined, the button hides. */
  onSaveAsMeal?: () => void;
  /** Editor mode:
   *  - 'day' (default): editing a single meal on a single day. Save
   *    calls `onSave(updated)` and the parent decides whether to
   *    detach / apply-to-all / etc.
   *  - 'template': editing a Saved Meal library item. The save writes
   *    to the template via the parent's onSave; routine + save-as-meal
   *    chips are hidden because they don't apply. A banner explains
   *    the semantics so users aren't surprised past days didn't change.
   */
  mode?: 'day' | 'template';
  /** Optional routine-save scope callback. When the meal being edited
   *  is routine-backed (has `_routineId`), the editor surfaces a
   *  "Just today / Apply to every day" prompt on save and invokes
   *  this. When omitted, save falls through to `onSave` with the raw
   *  meal (legacy behavior). */
  onSaveRoutine?: (updated: MealSuggestion, scope: 'today' | 'all') => void | Promise<void>;
  cookingSkill?: string;
  prepTimeMinutes?: number;
  dietaryPreference?: string;
  allergies?: string[];
  themeName?: AppThemeName;
}

interface Macros { calories: number; protein: number; carbs: number; fat: number; }

const _WEIGHT_UNITS = new Set<FoodUnit>(['g', 'kg', 'oz', 'lb']);
const _VOLUME_UNITS = new Set<FoodUnit>(['ml', 'l', 'fl_oz', 'cup', 'tbsp', 'tsp', 'pint', 'quart', 'gallon']);

// Approximate grams per cup for common food types. Used when
// converting between weight and volume without exact density data.
const _GRAMS_PER_CUP: Record<string, number> = {
  // Grains / dry
  oat: 80, oatmeal: 80, oats: 80, granola: 120, rice: 185,
  flour: 120, quinoa: 170, couscous: 175, cereal: 30, pasta: 100,
  // Dairy / wet
  milk: 244, yogurt: 245, 'greek yogurt': 245, 'cottage cheese': 226,
  cream: 240, 'sour cream': 230,
  // Produce
  broccoli: 91, spinach: 30, kale: 67, lettuce: 36, carrot: 128,
  berries: 150, berry: 150, blueberry: 148, strawberry: 152,
  // Proteins (cooked, chopped)
  chicken: 140, turkey: 140, beef: 135, pork: 135, fish: 140,
  shrimp: 113, prawn: 113, salmon: 155, tuna: 150, tilapia: 140,
  // Nuts / spreads
  'peanut butter': 258, 'almond butter': 258, almonds: 143, nuts: 140,
  // Legumes
  beans: 180, lentils: 200, chickpeas: 164,
  // Default for unknowns — somewhere between grains and produce
  _default: 120,
};

function _estimateGramsPerCup(foodName: string): number {
  const lower = (foodName || '').toLowerCase();
  for (const [key, grams] of Object.entries(_GRAMS_PER_CUP)) {
    if (key !== '_default' && lower.includes(key)) return grams;
  }
  return _GRAMS_PER_CUP._default;
}

function _crossSystemDefault(fromUnit: FoodUnit, toUnit: FoodUnit, fromQty: number, foodName?: string): { qty: number; ratio: number } {
  const toWeight = _WEIGHT_UNITS.has(toUnit);
  const toVolume = _VOLUME_UNITS.has(toUnit);
  const fromWeight = _WEIGHT_UNITS.has(fromUnit);
  const fromVolume = _VOLUME_UNITS.has(fromUnit);
  const fromCount = !fromWeight && !fromVolume;
  const toCount = !toWeight && !toVolume;

  // All cross-system conversions preserve the *physical amount* of food via a
  // density estimate (g-per-cup). The macros describe that physical amount, so
  // they don't scale — only the displayed quantity label changes. Ratio is
  // always 1 here; callers should not re-scale macros on a unit switch.
  const MIN_QTY = 0.01;

  if (fromWeight && toVolume) {
    const gpc = _estimateGramsPerCup(foodName ?? '');
    const fromGrams = fromUnit === 'g' ? fromQty : fromUnit === 'oz' ? fromQty * 28.35 : fromUnit === 'kg' ? fromQty * 1000 : fromUnit === 'lb' ? fromQty * 453.6 : fromQty;
    const cups = fromGrams / gpc;
    const cupToTarget: Record<string, number> = { cup: 1, ml: 240, fl_oz: 8, tbsp: 16, tsp: 48, l: 0.24, pint: 0.5, quart: 0.25, gallon: 0.0625 };
    const targetQty = cups * (cupToTarget[toUnit] ?? 1);
    return { qty: Math.max(MIN_QTY, Math.round(targetQty * 100) / 100), ratio: 1 };
  }
  if (fromVolume && toWeight) {
    const gpc = _estimateGramsPerCup(foodName ?? '');
    const volToMl: Record<string, number> = { ml: 1, l: 1000, fl_oz: 29.57, cup: 240, tbsp: 14.79, tsp: 4.93, pint: 473.18, quart: 946.35, gallon: 3785.41 };
    const fromMl = fromQty * (volToMl[fromUnit] ?? 240);
    const grams = fromMl * gpc / 240;
    const targetQty = toUnit === 'g' ? grams : toUnit === 'oz' ? grams / 28.35 : toUnit === 'kg' ? grams / 1000 : toUnit === 'lb' ? grams / 453.6 : grams;
    return { qty: Math.max(MIN_QTY, Math.round(targetQty * 100) / 100), ratio: 1 };
  }

  // Count ↔ Weight/Volume: no density data for pieces, so we guess quantity
  // and keep macros as-is (they represent the original physical amount).
  if (fromCount && toWeight) {
    const perServing = toUnit === 'g' ? 100 : toUnit === 'oz' ? 3.5 : toUnit === 'kg' ? 0.1 : toUnit === 'lb' ? 0.22 : 100;
    const qty = Math.max(MIN_QTY, Math.round(fromQty * perServing * 100) / 100);
    return { qty, ratio: 1 };
  }
  if (fromCount && toVolume) {
    const perServing = toUnit === 'cup' ? 1 : toUnit === 'ml' ? 240 : toUnit === 'fl_oz' ? 8 : toUnit === 'tbsp' ? 16 : toUnit === 'tsp' ? 48 : 1;
    const qty = Math.max(MIN_QTY, Math.round(fromQty * perServing * 100) / 100);
    return { qty, ratio: 1 };
  }
  if (toCount) {
    return { qty: 1, ratio: 1 };
  }
  return { qty: fromQty, ratio: 1 };
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
  return {
    calories: Math.round(totals.calories),
    protein:  Math.round(totals.protein),
    carbs:    Math.round(totals.carbs),
    fat:      Math.round(totals.fat),
  };
}

function addMacros(a: Macros, b: Macros): Macros {
  return {
    calories: Math.round(a.calories + b.calories),
    protein:  Math.round(a.protein  + b.protein),
    carbs:    Math.round(a.carbs    + b.carbs),
    fat:      Math.round(a.fat      + b.fat),
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

export default function MealEditModal({ visible, mealType, meal, nutritionPlan, allFoods, foodCategories, savedMeals = [], authToken, dateKey, onSave, onClose, onAddCustomFood, onToggleRoutine, onSaveAsMeal, mode = 'day', onSaveRoutine, cookingSkill, prepTimeMinutes, dietaryPreference, allergies, themeName }: Props) {
  const colors = useMemo(() => getTheme(themeName).colors, [themeName]);
  const s = useMemo(() => createStyles(colors), [colors]);
  // Structured items are the source of truth. Legacy foods[] / amounts[]
  // shapes are migrated via `ensureItems()` on open so downstream code only
  // has to handle the structured form. Each item gets a baseline rate
  // captured at mount so the scaling math survives going through zero.
  // When items came from the even-divide path (all items share identical macros),
  // enrich from the food library so quantity edits scale realistically.
  const seedItemBaselines = (arr: MealItem[]): MealItem[] => {
    const allSameCal = arr.length > 1 && arr.every(it => Math.round(it.calories ?? 0) === Math.round(arr[0].calories ?? 0));
    return arr.map(it => {
      if (it.baseCalories != null && it.baseCalories > 0 && !allSameCal) {
        return {
          ...it,
          baseQuantity: it.baseQuantity ?? (it.quantity > 0 ? it.quantity : 1),
          baseCalories: it.baseCalories,
          baseProtein:  it.baseProtein  ?? it.protein,
          baseCarbs:    it.baseCarbs    ?? it.carbs,
          baseFat:      it.baseFat      ?? it.fat,
        };
      }
      // Preserve existing macro values when possible. Two earlier bugs
      // informed this guarded order:
      //   1. Re-running the scale ratio on every modal open caused a 100x
      //      multiplier blowup (sweet potato → 40000 cal) when library
      //      units didn't match item units and convertQuantity returned
      //      null. Fix: never overwrite when baseCalories is already set.
      //   2. Re-seeding from the library for freshly-generated plan items
      //      (which have `calories` populated but no `baseCalories`) made
      //      the values drift slightly on open due to rounding differences.
      //      Fix: if the item already carries macros, trust them — they
      //      came from the plan generator or a prior save. Only compute
      //      from the library when the item literally has no macros.
      const lib = lookupFood(it.name, allFoods);
      const hasMacros = (it.calories ?? 0) > 0
        || (it.protein ?? 0) > 0
        || (it.carbs ?? 0) > 0
        || (it.fat ?? 0) > 0;

      if (hasMacros) {
        // Trust the item's own values — don't re-derive from library.
        return {
          ...it,
          baseQuantity: it.baseQuantity ?? (it.quantity > 0 ? it.quantity : 1),
          baseCalories: it.baseCalories ?? it.calories,
          baseProtein:  it.baseProtein  ?? it.protein,
          baseCarbs:    it.baseCarbs    ?? it.carbs,
          baseFat:      it.baseFat      ?? it.fat,
        };
      }

      if (lib && (lib.calories ?? 0) > 0) {
        const libParsed = lib.unit ? parseAmountString(lib.unit) : null;
        const libQty = libParsed?.quantity ?? 1;
        const libUnit = libParsed?.unit ?? it.unit;
        const conv = libUnit !== it.unit ? convertQuantity(it.quantity, it.unit, libUnit) : it.quantity;
        const effectiveQty = conv ?? it.quantity;
        // Guard against catastrophic ratios. If convertQuantity failed
        // (libUnit is incompatible with it.unit — e.g. grams↔medium) we'd
        // divide raw quantity by 1 and blow up. Require a safe ratio.
        const safeRatio =
          libQty > 0 && conv !== null && Number.isFinite(effectiveQty / libQty)
            ? effectiveQty / libQty
            : 1;
        const cal = Math.round((lib.calories ?? 0) * safeRatio);
        const pro = Math.round((lib.protein  ?? 0) * safeRatio);
        const car = Math.round((lib.carbs    ?? 0) * safeRatio);
        const fat = Math.round((lib.fat      ?? 0) * safeRatio);
        return {
          ...it,
          baseQuantity: it.baseQuantity ?? (it.quantity > 0 ? it.quantity : 1),
          calories:     cal,
          protein:      pro,
          carbs:        car,
          fat:          fat,
          baseCalories: cal,
          baseProtein:  pro,
          baseCarbs:    car,
          baseFat:      fat,
        };
      }
      return {
        ...it,
        baseQuantity: it.baseQuantity ?? (it.quantity > 0 ? it.quantity : 1),
        baseCalories: it.baseCalories ?? it.calories,
        baseProtein:  it.baseProtein  ?? it.protein,
        baseCarbs:    it.baseCarbs    ?? it.carbs,
        baseFat:      it.baseFat      ?? it.fat,
      };
    });
  };
  const [items, setItems] = useState<MealItem[]>(() => seedItemBaselines(ensureItems(meal).items ?? []));

  // Speech-to-meal — user taps mic, describes their meal, Whisper
  // transcribes + GPT parses into structured items. Two-tap UX:
  // first tap starts recording, second tap stops + sends.
  const recordingRef = useRef<any>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [speechLoading, setSpeechLoading] = useState(false);
  const [speechReview, setSpeechReview] = useState<null | {
    transcript: string;
    items: Array<{ name: string; quantity: number; unit: string; calories: number; protein: number; carbs: number; fat: number; micronutrients?: Record<string, number> }>;
  }>(null);
  const [search,      setSearch]      = useState('');
  const [scanLoading, setScanLoading] = useState(false);
  const [barcodeScanning, setBarcodeScanning] = useState(false);
  const [barcodeFallback, setBarcodeFallback] = useState<string | null>(null);
  const [aiSearchLoading, setAiSearchLoading] = useState(false);
  const [aiResults, setAiResults] = useState<FoodSearchResult[]>([]);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [foodSearchFocused, setFoodSearchFocused] = useState(false);
  const scrollRef = useRef<ScrollView | null>(null);
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
  const [eatenAt, setEatenAt] = useState<Date>(() =>
    parseMealDateTime((meal as any)._consumedAt ?? (meal as any).consumed_at, dateKey),
  );
  const [mealTimeExpanded, setMealTimeExpanded] = useState(false);
  const eatenAtLabel = useMemo(() => eatenAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }), [eatenAt]);
  const eatenAtDateLabel = useMemo(() => eatenAt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }), [eatenAt]);
  // `new_meal` (legacy: `new_extra`) is the sentinel for an unsaved meal
  // being created via the "Add Meal" button. Anything else is an existing
  // meal at index N.
  const isNewMeal = mealType === 'new_meal' || mealType === 'new_extra';

  const userEdited = useRef(false);
  useEffect(() => {
    if (visible) {
      setItems(seedItemBaselines(ensureItems(meal).items ?? []));
      userEdited.current = false;
      setSearch('');
      setAiResults([]);
      setFoodSearchFocused(false);
      setKeyboardHeight(0);
      setUnitPickerIdx(null);
      setInstructions(meal.instructions ?? null);
      setShowInstructions(false);
      setMealName(meal.meal ?? '');
      setEatenAt(parseMealDateTime((meal as any)._consumedAt ?? (meal as any).consumed_at, dateKey));
      setMealTimeExpanded(false);
    }
  }, [visible, meal, dateKey]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, event => {
      setKeyboardHeight(event.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const foodSearchActive = foodSearchFocused || search.trim().length > 0 || aiSearchLoading || aiResults.length > 0;

  const gapSuggestionFoods = useMemo(() => {
    const byName = new Map<string, FoodItem>();
    const categoryFoods = foodCategories.flatMap(category => category.foods ?? []);
    const source = categoryFoods.length > 0 ? categoryFoods : allFoods;
    for (const food of source) {
      const key = String(food.name ?? '').trim().toLowerCase();
      if (key && !byName.has(key)) byName.set(key, food);
    }
    return Array.from(byName.values());
  }, [foodCategories, allFoods]);

  const localSearchResults = useMemo<FoodSearchResult[]>(
    () => searchUserFoodCategories(foodCategories as any, search) as unknown as FoodSearchResult[],
    [foodCategories, search],
  );
  const remoteSearchResults = useMemo(() => {
    if (localSearchResults.length === 0) return aiResults;
    const localKeys = new Set(localSearchResults.map(r => `${r.name.trim().toLowerCase()}|${r.serving.trim().toLowerCase()}`));
    return aiResults.filter(r => !localKeys.has(`${r.name.trim().toLowerCase()}|${String(r.serving ?? '').trim().toLowerCase()}`));
  }, [aiResults, localSearchResults]);

  useEffect(() => {
    if (!foodSearchActive) return;
    // When search is active, the Current Foods + Saved Meals + action
    // buttons collapse, so the search input sits at the top of the
    // remaining content. Scroll to y=0 so the input + first results are
    // visible above the keyboard. (Older logic used scrollToEnd, which
    // hid the input behind the keyboard once results arrived.)
    const timer = setTimeout(() => {
      scrollRef.current?.scrollTo({ y: 0, animated: true });
    }, Platform.OS === 'ios' ? 120 : 180);
    return () => clearTimeout(timer);
  }, [foodSearchActive, aiResults.length, localSearchResults.length, aiSearchLoading]);

  const requireStoredPro = async (feature: ProFeature): Promise<boolean> => {
    try {
      const [{ requirePro }, { default: AsyncStorage }] = await Promise.all([
        import('../utils/subscription'),
        import('@react-native-async-storage/async-storage'),
      ]);
      const raw = await AsyncStorage.getItem('userProfile');
      const profile = raw ? JSON.parse(raw) : null;
      return requirePro(profile, feature);
    } catch {
      Alert.alert('Upgrade to Pro', 'This AI feature is available with Thallo Pro.');
      return false;
    }
  };


  const fetchInstructions = async () => {
    if (!authToken) return;
    // If we already have cached instructions, just show them.
    if (instructions) {
      setShowInstructions(true);
      return;
    }
    if (!(await requireStoredPro('ai_meal_plan'))) return;
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

  // Ref-based in-flight lock. `scanLoading` state is one render behind,
  // so a quick double-tap can enter pickAndScan twice before the disabled
  // prop rerenders. The ref flips synchronously so the second call bails.
  const scanLock = useRef(false);
  const pickAndScan = async (source: 'camera' | 'library') => {
    if (!authToken) return;
    if (scanLock.current) return;
    if (!(await requireStoredPro('ai_food_scan'))) return;
    scanLock.current = true;
    if (source === 'camera') {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Camera permission needed', 'Enable camera access in Settings to scan food photos.');
        scanLock.current = false;
        return;
      }
    } else {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Photo library permission needed', 'Enable photo access in Settings to scan food photos.');
        scanLock.current = false;
        return;
      }
    }
    // Library photos are often full-resolution (12–48 MP) and their base64
    // payloads trip the backend request size limit. Camera capture is
    // already cropped, so we only aggressively shrink the library path.
    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync({ base64: true, quality: 0.6, mediaTypes: 'images', exif: false, allowsEditing: false, maxWidth: 1024, maxHeight: 1024 } as any)
      : await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.4, mediaTypes: 'images', exif: false, allowsEditing: false, maxWidth: 1024, maxHeight: 1024 } as any);
    if (result.canceled || !result.assets?.[0]?.base64) {
      scanLock.current = false;
      return;
    }
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
            ...(p.micronutrients ? { micronutrients: p.micronutrients } : {}),
          };
        });
        setItems(prev => {
          const next = [...prev, ...newItems];
          persistNow(next);
          return next;
        });
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
              ...(p.micronutrients ? { micronutrients: p.micronutrients } : {}),
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
      scanLock.current = false;
    }
  };

  const mealMacros = calcMacrosFromItems(items, meal);
  const otherMacros = otherMealsMacros(nutritionPlan, mealType);
  const dayTotal    = addMacros(mealMacros, otherMacros);
  const gapPreview = positiveMacroGap(nutritionPlan.targets, otherMacros);
  const canSuggestGapMeal = mode === 'day' && isNewMeal && items.length === 0 && (
    gapPreview.calories >= 120 || gapPreview.protein >= 12 || gapPreview.carbs >= 20 || gapPreview.fat >= 8
  );

  const applyGapSuggestion = () => {
    const suggestion = buildGapMealSuggestion({
      targets: nutritionPlan.targets,
      consumed: otherMacros,
      pantryFoods: gapSuggestionFoods,
      savedMeals,
      seed: `${dateKey ?? ''}|${mealType}`,
    });
    if (!suggestion) {
      Alert.alert('Targets already covered', 'There is not enough remaining macro room to build a useful meal.');
      return;
    }
    const apply = () => {
      const hydratedItems = seedItemBaselines(ensureItems(suggestion.meal).items ?? []);
      userEdited.current = true;
      setMealName(suggestion.meal.meal || 'Target Meal');
      setItems(hydratedItems);
      setInstructions(null);
      setShowInstructions(false);
      setUnitPickerIdx(null);
    };
    apply();
  };

  const removeItem = (idx: number) => {
    userEdited.current = true;
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
      food_id: lib?.id ?? null,
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
    userEdited.current = true;
    setItems(prev => [...prev, newItem]);
  };
  const updateItem = (idx: number, patch: Partial<MealItem>) => {
    userEdited.current = true;
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
          // Cross-system switch (e.g. g→cup, piece→oz). Density estimate
          // converts the quantity label while preserving the same physical
          // amount of food — macros don't change. Re-anchor baseQuantity to
          // the new unit so future quantity edits scale correctly.
          const { qty: defaultQty } = _crossSystemDefault(current.unit, patch.unit, current.quantity, current.name);
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

  /** Speech-to-meal recording flow. First tap on mic → start recording
   *  (expo-av). Second tap → stop, upload audio, open review sheet. */
  const handleMicToggle = async () => {
    if (!authToken) return;
    try {
      if (!isRecording && !(await requireStoredPro('ai_meal_voice'))) return;
      if (!isRecording) {
        const AV = await import('expo-av');
        const { granted } = await AV.Audio.requestPermissionsAsync();
        if (!granted) {
          Alert.alert('Microphone permission needed', 'Enable mic access in Settings to describe a meal.');
          return;
        }
        await AV.Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
        });
        const rec = new AV.Audio.Recording();
        await rec.prepareToRecordAsync(AV.Audio.RecordingOptionsPresets.HIGH_QUALITY);
        await rec.startAsync();
        recordingRef.current = rec;
        setIsRecording(true);
        return;
      }
      // Second tap: stop + send.
      const rec = recordingRef.current;
      if (!rec) { setIsRecording(false); return; }
      setSpeechLoading(true);
      setIsRecording(false);
      await rec.stopAndUnloadAsync();
      const uri: string = rec.getURI() || '';
      recordingRef.current = null;
      if (!uri) { setSpeechLoading(false); return; }
      // Read the file as base64 and post to /ai/speech-to-meal.
      const FileSystem = await import('expo-file-system/legacy');
      const audio_base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      const mime = uri.toLowerCase().endsWith('.wav') ? 'audio/wav'
        : uri.toLowerCase().endsWith('.mp3') ? 'audio/mp3'
        : uri.toLowerCase().endsWith('.webm') ? 'audio/webm'
        : 'audio/m4a';
      const api = await import('../services/api');
      const res = await api.speechToMeal(authToken, { audio_base64, mime_type: mime });
      if (!res.items?.length) {
        Alert.alert(
          'Nothing parsed',
          res.transcript
            ? `We heard "${res.transcript}" but couldn't identify food items. Try again with specific foods and amounts.`
            : "We didn't catch that — try again with clearer audio.",
        );
        return;
      }
      setSpeechReview({ transcript: res.transcript, items: res.items });
    } catch (e: any) {
      Alert.alert('Mic error', String(e?.message ?? e));
      setIsRecording(false);
    } finally {
      setSpeechLoading(false);
    }
  };

  const barcodeLock = useRef(false);
  const handleBarcodeScan = async (barcode: string) => {
    if (!authToken || !barcode.trim() || barcodeLock.current) return;
    barcodeLock.current = true;
    setBarcodeScanning(false);
    setScanLoading(true);
    try {
      const { lookupBarcode } = await import('../services/api');
      const result = await lookupBarcode(authToken, barcode.trim());
      if (result && result.name) {
        setBarcodeFallback(null);
        addAiFood({
          name: result.name,
          serving: result.serving,
          calories: result.calories,
          protein: result.protein,
          carbs: result.carbs,
          fat: result.fat,
          micronutrients: result.micronutrients,
        });
      } else {
        setBarcodeFallback(barcode.trim());
        Alert.alert('Product not found', `No nutrition data found for barcode ${barcode}. Search by product name, scan the front label, or describe the food out loud.`);
      }
    } catch (e: any) {
      setBarcodeFallback(barcode.trim());
      Alert.alert('Product not found', `No nutrition data found for barcode ${barcode}. Search by product name, scan the front label, or describe the food out loud.`);
    } finally {
      setScanLoading(false);
      barcodeLock.current = false;
    }
  };

  const handleAiSearch = async (opts?: { forceAi?: boolean; append?: boolean }) => {
    if (!search.trim()) return;
    // Pro gate — only the AI-forced search route hits OpenAI. Plain
    // searches against the seed/USDA library stay free; the `forceAi`
    // call below is the one that incurs cost + needs gating. The
    // bound button at line ~1492 is `forceAi: true` which is what
    // this guard catches.
    if (opts?.forceAi) {
      if (!(await requireStoredPro('ai_food_enrichment'))) return;
    }
    if (!authToken) return;
    setAiSearchLoading(true);
    try {
      const res = await searchFoodNutrition(authToken, search.trim(), { forceAi: opts?.forceAi });
      const incoming = res.results ?? [];
      if (opts?.append) {
        setAiResults(prev => {
          const seen = new Set(prev.map(r => `${r.source ?? ''}:${r.name.toLowerCase()}`));
          const merged = [...prev];
          for (const r of incoming) {
            const key = `${r.source ?? ''}:${r.name.toLowerCase()}`;
            if (!seen.has(key)) merged.push(r);
          }
          return merged;
        });
      } else {
        setAiResults(incoming);
      }
      if (!incoming.length && !opts?.append) Alert.alert('No results', `Could not find nutrition info for "${search}".`);
      if (!incoming.length && opts?.append) Alert.alert('No AI results', `AI had nothing to add for "${search}".`);
    } catch (e: any) {
      Alert.alert('Search failed', e.message ?? 'Could not reach the server.');
    } finally {
      setAiSearchLoading(false);
    }
  };

  const addAiFood = (aiItem: FoodSearchResult) => {
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
        food_id: aiItem.food_id ?? null,
        serving_id: aiItem.serving_id ?? null,
        serving_grams: aiItem.serving_grams ?? null,
        source: aiItem.source,
        fdc_id: aiItem.fdc_id ?? aiItem.external_id ?? null,
        external_id: aiItem.external_id ?? aiItem.fdc_id ?? null,
        brand: aiItem.brand ?? null,
        is_verified: aiItem.is_verified,
        ...(aiItem.micronutrients ? { micronutrients: aiItem.micronutrients } : {}),
      };
      setItems(prev => {
        const next = [...prev, newItem];
        persistNow(next);
        return next;
      });
    }
    if (aiItem.source !== 'seed' && aiItem.source !== 'user') {
      onAddCustomFood?.({
        name: aiItem.name,
        unit: aiItem.serving ?? '1 serving',
        calories: Math.round(aiItem.calories),
        protein: Math.round(aiItem.protein),
        carbs: Math.round(aiItem.carbs),
        fat: Math.round(aiItem.fat),
        verificationStatus: aiItem.source === 'ai' ? 'ai_estimated' : aiItem.is_verified ? 'seed_verified' : undefined,
        ...(aiItem.micronutrients ? { micronutrients: aiItem.micronutrients } : {}),
      });
    }
    setAiResults(prev => prev.filter(r => r.name !== aiItem.name));
  };

  // The category-grouped food list was removed in favor of a search-only UX —
  // the always-visible scroll of every seed/custom food was visual noise and
  // pushed the actual actions (search, barcode, photo, voice) below the fold.
  // `foodCategories` is still accepted as a prop for backwards compat but is
  // no longer rendered; food name lookups go through `allFoods` + `lookupFood`.

  // A routine-tagged meal carries a `_routineId`. Editing one from the
  // day card presents a scope prompt on save: "Just today" detaches
  // (next loadPlans won't clobber the edit), "Apply to every day"
  // updates the routine template and keeps the linkage.
  const _routineId = (meal as any)?._routineId as string | undefined;
  const isRoutineEdit = mode === 'day' && !!_routineId && !!onSaveRoutine;

  const handleSave = () => {
    // Empty-meal guard: if every item has 0 calories, saving would create
    // a ghost meal that muddies the nutrition totals. Prompt instead.
    // Only runs on SAVE — cancel skips this so the user can always bail
    // out of a mistaken add.
    if (items.length === 0 || items.every(it => Math.round(it.calories ?? 0) === 0)) {
      Alert.alert(
        'Meal is empty',
        items.length === 0
          ? 'Add at least one food before saving, or cancel to discard.'
          : 'Every food in this meal shows 0 calories. Add macros to at least one food before saving, or cancel to discard.',
      );
      return;
    }
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
      ...(mode === 'day' ? { _consumedAt: eatenAt.toISOString() } : {}),
    };
    const synced = syncLegacyFieldsFromItems(finalMeal);

    if (isRoutineEdit && onSaveRoutine) {
      // Routine-scope prompt — the whole point of the detach model.
      // "Just today" is the default / destructive-styled option so the
      // user doesn't accidentally change every day with a tap.
      Alert.alert(
        'Save changes',
        'This meal is part of a routine that appears on every day. Apply your edit to just today, or update the routine for every day going forward?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Just today',
            onPress: () => { onSaveRoutine(synced, 'today'); onClose(); },
          },
          {
            text: 'Every day',
            onPress: () => { onSaveRoutine(synced, 'all'); onClose(); },
          },
        ],
      );
      return;
    }

    onSave(synced);
    onClose();
  };

  // Cancel never goes through the save pipeline — no empty-meal prompt,
  // no onSave. Just dismiss. This is deliberate: if the user opened the
  // modal by accident (or added foods they immediately regret) the X
  // button should always exit without a fight.
  const handleCancel = () => {
    onClose();
  };

  // Persist current items to AsyncStorage immediately (survives app kill).
  // Called after scan/barcode adds items, without waiting for Save tap.
  // For NEW meals (mealType = 'new_meal' / 'new_extra') we skip persistence
  // entirely — the Save tap is the only way a new meal should land in the
  // plan. Otherwise every debounced auto-persist would push a new duplicate.
  const persistNow = (updatedItems: MealItem[]) => {
    if (!dateKey) return;
    if (!mealType.startsWith('meal_')) return;
    const resummed: Record<string, number> = {};
    for (const it of updatedItems) {
      if (!it.micronutrients) continue;
      for (const [k, v] of Object.entries(it.micronutrients)) {
        if (typeof v === 'number') resummed[k] = (resummed[k] ?? 0) + v;
      }
    }
    const updatedMeal: MealSuggestion = {
      ...meal,
      meal: mealName.trim() || meal.meal || 'Meal',
      items: updatedItems,
      ...(Object.keys(resummed).length > 0
        ? { micronutrients: { ...(meal.micronutrients ?? {}), ...resummed } }
        : {}),
    };
    const synced = syncLegacyFieldsFromItems(updatedMeal);
    // Update the plan in AsyncStorage directly
    const plan = { ...nutritionPlan };
    const meals = [...(plan.meals ?? [])];
    if (mealType.startsWith('meal_')) {
      const idx = parseInt(mealType.slice(5), 10);
      if (idx >= 0 && idx < meals.length) meals[idx] = synced;
      else meals.push(synced);
    } else {
      meals.push(synced);
    }
    plan.meals = meals;
    console.log(`[MealEditModal] persistNow: dateKey=${dateKey} meals=${meals.length} stamp=${(plan as any)._templatesVersion ?? 'NONE'}`);
    import('../utils/mealTracker').then(({ saveNutritionPlan }) => {
      saveNutritionPlan(dateKey, plan).then(() => {
        console.log(`[MealEditModal] persistNow: saved to AsyncStorage OK`);
      }).catch((e) => {
        console.warn(`[MealEditModal] persistNow: FAILED`, e);
      });
    });
  };

  // Auto-persist whenever items change from a user action (debounced).
  // This ensures food additions survive app kill without requiring Save tap.
  useEffect(() => {
    if (!userEdited.current || !dateKey || !visible) return;
    const timer = setTimeout(() => persistNow(items), 600);
    return () => clearTimeout(timer);
  }, [items]);

  return (
    <>
    <Modal visible={visible} animationType="slide" onRequestClose={() => { handleCancel(); }}>
      <View style={s.container}>

        {/* Header — action bar only */}
        <View style={s.header}>
          <TouchableOpacity onPress={handleCancel} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={s.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <Text style={[s.title, { flex: 0 }]}>Edit Meal</Text>
          <TouchableOpacity onPress={handleSave} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={s.saveText}>Save</Text>
          </TouchableOpacity>
        </View>

        {/* Meal name + action chips — below the header for breathing room */}
        <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 }}>
          <TextInput
            style={[s.title, { textAlign: 'center', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: colors.surfaceRaised, fontSize: 16 }]}
            value={mealName}
            onChangeText={setMealName}
            placeholder="Meal name"
            placeholderTextColor={colors.textMuted}
            returnKeyType="done"
          />
          <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'center', marginTop: 8 }}>
            {mode === 'day' && onToggleRoutine && (
              <TouchableOpacity onPress={onToggleRoutine} style={s.routineBadge} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                <Text style={[s.routineBadgeText, meal.isRoutine && s.routineBadgeTextActive]}>
                  {meal.isRoutine ? 'Pinned' : 'Pin as Routine'}
                </Text>
              </TouchableOpacity>
            )}
            {mode === 'day' && onSaveAsMeal && (
              <TouchableOpacity onPress={onSaveAsMeal} style={s.routineBadge} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                <Text style={s.routineBadgeText}>Add to Favorites</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {mode === 'day' && (
          <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
            <TouchableOpacity
              activeOpacity={0.82}
              onPress={() => {
                LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                setMealTimeExpanded(prev => !prev);
              }}
              style={{
                borderRadius: 14,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface,
                paddingHorizontal: 12,
                paddingVertical: 10,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
              }}>
              <View style={{
                width: 34,
                height: 34,
                borderRadius: 17,
                backgroundColor: colors.primary + '18',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <Ionicons name="time-outline" size={18} color={colors.primary} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ fontSize: 10, fontWeight: '800', letterSpacing: 0, color: colors.textMuted }}>
                  EATEN AT
                </Text>
                <Text numberOfLines={1} ellipsizeMode="tail" style={{ fontSize: 15, fontWeight: '900', color: colors.textPrimary, marginTop: 1 }}>
                  {eatenAtLabel} · {eatenAtDateLabel}
                </Text>
              </View>
              <Ionicons name={mealTimeExpanded ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
            </TouchableOpacity>
            {mealTimeExpanded && (
              <View style={{ marginTop: 8 }}>
                <MealTimeSelector
                  value={eatenAt}
                  mealDate={dateKey}
                  colors={colors}
                  onChange={setEatenAt}
                />
              </View>
            )}
          </View>
        )}

        {/* Scope banner — tells the user what their save will affect
            BEFORE they tap save. Keeps the mental model visible so
            routine/template edits don't feel like stealth changes. */}
        {mode === 'template' && (
          <View style={{
            marginHorizontal: 16, marginTop: 8,
            backgroundColor: colors.primary + '14',
            borderWidth: 1, borderColor: colors.primary + '55',
            borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12,
            flexDirection: 'row', alignItems: 'center', gap: 8,
          }}>
            <Ionicons name="albums-outline" size={14} color={colors.primary} />
            <Text style={{ flex: 1, fontSize: 11, color: colors.textSecondary, lineHeight: 15 }}>
              <Text style={{ fontWeight: '800', color: colors.textPrimary }}>Editing template.</Text>
              {' '}Past days that used this saved meal stay unchanged. Future logs will use your updated version.
            </Text>
          </View>
        )}
        {mode === 'day' && isRoutineEdit && (
          <View style={{
            marginHorizontal: 16, marginTop: 8,
            backgroundColor: colors.primary + '14',
            borderWidth: 1, borderColor: colors.primary + '55',
            borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12,
            flexDirection: 'row', alignItems: 'center', gap: 8,
          }}>
            <Ionicons name="repeat-outline" size={14} color={colors.primary} />
            <Text style={{ flex: 1, fontSize: 11, color: colors.textSecondary, lineHeight: 15 }}>
              <Text style={{ fontWeight: '800', color: colors.textPrimary }}>Routine meal.</Text>
              {' '}On save you'll pick: change only today, or update the routine for every day.
            </Text>
          </View>
        )}

        {canSuggestGapMeal && (
          <TouchableOpacity
            onPress={applyGapSuggestion}
            activeOpacity={0.84}
            style={s.gapButton}>
            <View style={s.gapButtonIcon}>
              <Ionicons name="analytics-outline" size={17} color={colors.primary} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.gapButtonTitle}>Hit Today's Targets</Text>
              <Text style={s.gapButtonMeta} numberOfLines={1}>
                {gapPreview.calories} cal · {gapPreview.protein}g P · {gapPreview.carbs}g C · {gapPreview.fat}g F left
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        )}

        {/* How to make this — on-demand AI recipe, cached on the meal.
            The "From Saved Meal" shortcut was removed from the editor:
            the plan card ("From saved" next to "Empty meal") and the
            Foods → Saved Meals carousel are the canonical entry points.
            Keeping it here too was redundant and confused users about
            whether saving and pasting were the same action. */}
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
                {instructions ? 'View Recipe' : 'Generate Cooking Steps'}
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

          {/* Remaining / over-under row */}
          {nutritionPlan.targets && (() => {
            const t = nutritionPlan.targets;
            const diffCal = (t.calories ?? 0) - dayTotal.calories;
            const diffPro = (t.protein ?? 0) - dayTotal.protein;
            const diffCarb = (t.carbs ?? 0) - dayTotal.carbs;
            const diffFat = (t.fat ?? 0) - dayTotal.fat;
            const fmt = (v: number, unit: string) => v > 0 ? `−${v}${unit}` : v < 0 ? `+${Math.abs(v)}${unit}` : `0${unit}`;
            const clr = (v: number) => v > 0 ? colors.textMuted : v < 0 ? (colors.error ?? '#EF4444') : colors.textMuted;
            return (
              <>
                <View style={s.totalsDivider} />
                <View style={s.totalsRow}>
                  <Text style={[s.totalsRowLabel, { fontSize: 10, color: colors.textMuted }]}>Remaining</Text>
                  <Text style={[s.totalsVal, { fontSize: 11, color: clr(diffCal) }]}>{fmt(diffCal, '')}</Text>
                  <Text style={[s.totalsVal, { fontSize: 11, color: clr(diffPro) }]}>{fmt(diffPro, 'g')}</Text>
                  <Text style={[s.totalsVal, { fontSize: 11, color: clr(diffCarb) }]}>{fmt(diffCarb, 'g')}</Text>
                  <Text style={[s.totalsVal, { fontSize: 11, color: clr(diffFat) }]}>{fmt(diffFat, 'g')}</Text>
                </View>
              </>
            );
          })()}
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <ScrollView
            ref={scrollRef}
            style={s.scroll}
            contentContainerStyle={[
              s.scrollContent,
              foodSearchActive && {
                paddingBottom: Math.min(280, Math.max(200, keyboardHeight + 80)),
              },
            ]}
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            keyboardShouldPersistTaps="handled">

            {/* While the user is actively searching for a food we collapse
                Current Foods + Saved Meals so the search input + results
                sit near the top, fully above the keyboard. The "{N} foods
                already added" hint keeps a hint of context without taking
                up the screen. */}
            {foodSearchActive && items.length > 0 && (
              <Text style={[s.emptyText, { marginBottom: 6 }]}>
                {items.length} food{items.length === 1 ? '' : 's'} already added — clear search to view & edit
              </Text>
            )}

            {/* Current foods — structured editable rows */}
            {!foodSearchActive && (<>
            <Text style={s.sectionLabel}>Current Foods</Text>
            {items.length === 0 && (
              <Text style={s.emptyText}>No foods — add some below</Text>
            )}
            </>)}
            {!foodSearchActive && items.map((it, idx) => (
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
                  {unitPickerIdx === idx && (() => {
                    const allowed = new Set(validUnitsForFood(it.name));
                    if (!allowed.has(it.unit)) allowed.add(it.unit);
                    const filtered = FOOD_UNIT_GROUPS
                      .map(g => ({ ...g, units: g.units.filter(u => allowed.has(u)) }))
                      .filter(g => g.units.length > 0);
                    return (
                    <View style={s.unitPicker}>
                      {filtered.map(group => (
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
                    );
                  })()}
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

            {!foodSearchActive && savedMeals.length > 0 && (
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
            {!foodSearchActive && (
              <Text style={[s.sectionLabel, { marginTop: 24 }]}>Add Foods</Text>
            )}

            {authToken && !foodSearchActive && (
              <>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                  <TouchableOpacity
                    style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 10, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}
                    disabled={scanLoading}
                    onPress={() => setBarcodeScanning(true)}>
                    <Ionicons name="barcode-outline" size={18} color={colors.primary} />
                    <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textPrimary }}>Barcode</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 10, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}
                    disabled={scanLoading}
                    onPress={() => pickAndScan('camera')}>
                    {scanLoading
                      ? <ActivityIndicator size="small" color={colors.primary} />
                      : <><Ionicons name="camera-outline" size={18} color={colors.primary} /><Text style={{ fontSize: 13, fontWeight: '600', color: colors.textPrimary }}>Photo</Text></>}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 10, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}
                    disabled={scanLoading}
                    onPress={() => pickAndScan('library')}>
                    <Ionicons name="images-outline" size={18} color={colors.primary} />
                    <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textPrimary }}>Library</Text>
                  </TouchableOpacity>
                </View>
                {/* Speech-to-meal — describe a meal out loud and AI parses
                    quantities + macros. Tap once to start, again to stop.
                    Full-width so the active "Recording…" state reads clearly. */}
                <TouchableOpacity
                  onPress={handleMicToggle}
                  disabled={speechLoading}
                  style={{
                    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
                    paddingVertical: 11, borderRadius: 10, marginBottom: 8,
                    backgroundColor: isRecording ? colors.error + '1A'
                      : speechLoading ? colors.surfaceRaised : colors.primary + '14',
                    borderWidth: 1,
                    borderColor: isRecording ? colors.error + '88' : colors.primary + '55',
                  }}
                >
                  {speechLoading ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <Ionicons
                      name={isRecording ? 'stop-circle' : 'mic'}
                      size={18}
                      color={isRecording ? colors.error : colors.primary}
                    />
                  )}
                  <Text style={{
                    fontSize: 13, fontWeight: '700',
                    color: isRecording ? colors.error : colors.primary,
                  }}>
                    {speechLoading
                      ? 'Transcribing…'
                      : isRecording
                        ? 'Tap to stop — recording'
                        : 'Describe meal out loud'}
                  </Text>
                  {!isRecording && !speechLoading && (
                    <Text style={{ fontSize: 10, fontWeight: '700', color: colors.primary + 'AA', letterSpacing: 0.3 }}>BETA</Text>
                  )}
                </TouchableOpacity>
              </>
            )}

            {barcodeFallback && (
              <View style={{
                backgroundColor: colors.warning + '14',
                borderWidth: 1,
                borderColor: colors.warning + '55',
                borderRadius: 10,
                padding: 10,
                marginBottom: 10,
              }}>
                <Text style={{ fontSize: 12, fontWeight: '800', color: colors.textPrimary }}>
                  Barcode not in the database
                </Text>
                <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 3 }}>
                  {barcodeFallback} was not found. Search the product name, scan the front nutrition label, or use voice and Thallo will estimate it for review.
                </Text>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                  <TouchableOpacity
                    onPress={() => pickAndScan('camera')}
                    style={{ flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 8, backgroundColor: colors.surface }}>
                    <Text style={{ fontSize: 11, fontWeight: '800', color: colors.primary }}>Scan label</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setBarcodeFallback(null)}
                    style={{ flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 8, backgroundColor: colors.surface }}>
                    <Text style={{ fontSize: 11, fontWeight: '800', color: colors.textSecondary }}>Type search</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            <View style={s.searchRow}>
              <TextInput
                testID="meal-edit-food-search"
                style={[s.searchInput, { flex: 1, marginBottom: 0 }]}
                value={search}
                onChangeText={(t) => { setSearch(t); setAiResults([]); if (barcodeFallback) setBarcodeFallback(null); }}
                placeholder="Search foods..."
                placeholderTextColor={colors.textMuted}
                returnKeyType="search"
                onFocus={() => setFoodSearchFocused(true)}
                onBlur={() => setFoodSearchFocused(false)}
                onSubmitEditing={authToken && search.length > 1 ? () => handleAiSearch() : undefined}
              />
              {search.length > 0 && (
                <TouchableOpacity style={s.clearBtn} onPress={() => { setSearch(''); setAiResults([]); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="close-circle" size={18} color={colors.textMuted} />
                </TouchableOpacity>
              )}
              {authToken && search.length > 1 && (
                <TouchableOpacity
                  style={[s.aiSearchInlineBtn, aiSearchLoading && { opacity: 0.5 }]}
                  onPress={() => handleAiSearch()}
                  disabled={aiSearchLoading}>
                  {aiSearchLoading
                    ? <ActivityIndicator size="small" color="#FFFFFF" />
                    : <Text style={s.aiSearchInlineBtnText}>Search</Text>}
                </TouchableOpacity>
              )}
            </View>

            {/* Hint when search has text but the user hasn't tapped Search yet
                (or the AI returned nothing). Replaces the old "No local matches"
                copy from when there was an inline category list to filter. */}
            {localSearchResults.length > 0 && (
              <View style={{ marginBottom: 16 }}>
                <Text style={s.sectionLabel}>From Your Foods</Text>
                {localSearchResults.map((item, idx) => {
                  const badgeLabel = badgeLabelForSource(item.source);
                  return (
                    <TouchableOpacity testID={`meal-edit-local-search-result-${idx}`} key={`${item.source ?? ''}-${item.name}-${idx}`} style={s.aiResultRow} onPress={() => addAiFood(item)}>
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <Text style={s.aiResultName}>{item.name}</Text>
                          {item.source && (
                            <View style={[s.sourceBadge, s.sourceBadgeLocal]}>
                              <Text style={[s.sourceBadgeText, s.sourceBadgeTextLocal]}>{badgeLabel}</Text>
                            </View>
                          )}
                        </View>
                        <Text style={s.aiResultServing}>{item.serving}</Text>
                        <Text style={s.aiResultMacros}>
                          {Math.round(item.calories)} cal · {Math.round(item.protein)}g pro · {Math.round(item.carbs)}g carbs · {Math.round(item.fat)}g fat
                        </Text>
                      </View>
                      <Text style={s.aiResultAdd}>+ Add</Text>
                    </TouchableOpacity>
                  );
                })}
                {authToken && search.trim().length > 1 && remoteSearchResults.length === 0 && !aiSearchLoading && (
                  <TouchableOpacity
                    style={s.alsoAskAiBtn}
                    onPress={() => handleAiSearch()}>
                    <Ionicons name="search-outline" size={14} color={colors.primary} />
                    <Text style={s.alsoAskAiText}>Search USDA and AI</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {search.length > 1 && !aiSearchLoading && localSearchResults.length === 0 && remoteSearchResults.length === 0 && (
              <Text style={s.emptyText}>Tap Search to look up "{search.trim()}"</Text>
            )}

            {remoteSearchResults.length > 0 && (() => {
              const hasVerified = remoteSearchResults.some(r => r.source !== 'ai');
              const hasAi = remoteSearchResults.some(r => r.source === 'ai');
              return (
              <View style={{ marginBottom: 16 }}>
                <Text style={s.sectionLabel}>{localSearchResults.length > 0 ? 'More Results' : 'Search Results'}</Text>
                {remoteSearchResults.map((item, idx) => {
                  const isUsda = item.source === 'usda';
                  const isAi = item.source === 'ai';
                  const badgeLabel = badgeLabelForSource(item.source);
                  return (
                    <TouchableOpacity testID={`meal-edit-search-result-${idx}`} key={`${item.source ?? ''}-${item.name}-${idx}`} style={s.aiResultRow} onPress={() => addAiFood(item)}>
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <Text style={s.aiResultName}>{item.name}</Text>
                          {item.source && (
                            <View style={[s.sourceBadge, isUsda ? s.sourceBadgeUsda : isAi ? s.sourceBadgeAi : s.sourceBadgeLocal]}>
                              <Text style={[s.sourceBadgeText, isUsda ? s.sourceBadgeTextUsda : isAi ? s.sourceBadgeTextAi : s.sourceBadgeTextLocal]}>
                                {badgeLabel}
                              </Text>
                            </View>
                          )}
                        </View>
                        <Text style={s.aiResultServing}>{item.serving}</Text>
                        <Text style={s.aiResultMacros}>
                          {Math.round(item.calories)} cal · {Math.round(item.protein)}g pro · {Math.round(item.carbs)}g carbs · {Math.round(item.fat)}g fat
                        </Text>
                      </View>
                      <Text style={s.aiResultAdd}>+ Add</Text>
                    </TouchableOpacity>
                  );
                })}
                {hasVerified && !hasAi && !aiSearchLoading && (
                  <TouchableOpacity
                    style={s.alsoAskAiBtn}
                    onPress={() => handleAiSearch({ forceAi: true, append: true })}>
                    <Ionicons name="sparkles-outline" size={14} color={colors.primary} />
                    <Text style={s.alsoAskAiText}>Also ask AI for more options</Text>
                  </TouchableOpacity>
                )}
              </View>
              );
            })()}

          </ScrollView>
        </KeyboardAvoidingView>
      </View>
      <BarcodeScannerModal
          visible={barcodeScanning}
          onClose={() => setBarcodeScanning(false)}
          onScan={handleBarcodeScan}
        />
    </Modal>
    {/* Speech-to-meal review — user heard the transcript + what was
        parsed, can edit / remove, then bulk-paste into the meal. */}
    <Modal
      visible={!!speechReview}
      animationType="slide"
      transparent
      onRequestClose={() => setSpeechReview(null)}
    >
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20,
          padding: 16, paddingBottom: 30, maxHeight: '85%',
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <Text style={{ fontSize: 16, fontWeight: '800', color: colors.textPrimary }}>
              Parsed meal
            </Text>
            <TouchableOpacity onPress={() => setSpeechReview(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          {speechReview?.transcript ? (
            <View style={{ backgroundColor: colors.surface, borderRadius: 10, padding: 10, marginBottom: 12, borderWidth: 1, borderColor: colors.border }}>
              <Text style={{ fontSize: 10, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.4, marginBottom: 4 }}>HEARD</Text>
              <Text style={{ fontSize: 12, color: colors.textPrimary, fontStyle: 'italic' }}>"{speechReview.transcript}"</Text>
            </View>
          ) : null}
          <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 10, lineHeight: 15 }}>
            AI estimated quantities and macros — review and tweak before adding to your meal.
          </Text>
          <ScrollView style={{ flexGrow: 0 }}>
            {(speechReview?.items || []).map((it, i) => (
              <View key={`${i}-${it.name}`} style={{
                backgroundColor: colors.surface, borderRadius: 12, padding: 12, marginBottom: 8,
                borderWidth: 1, borderColor: colors.border,
              }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <TextInput
                    value={it.name}
                    onChangeText={(t) => setSpeechReview(s => s ? { ...s, items: s.items.map((x, idx) => idx === i ? { ...x, name: t } : x) } : s)}
                    style={{ flex: 1, backgroundColor: colors.surfaceRaised, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, color: colors.textPrimary, fontSize: 13, fontWeight: '700' }}
                    placeholderTextColor={colors.textMuted}
                  />
                  <TouchableOpacity
                    onPress={() => setSpeechReview(s => s ? { ...s, items: s.items.filter((_, idx) => idx !== i) } : s)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: colors.surfaceRaised, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Ionicons name="close" size={13} color={colors.textSecondary} />
                  </TouchableOpacity>
                </View>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                  <TextInput
                    value={String(it.quantity)}
                    onChangeText={(t) => setSpeechReview(s => s ? { ...s, items: s.items.map((x, idx) => idx === i ? { ...x, quantity: parseFloat(t) || 0 } : x) } : s)}
                    keyboardType="decimal-pad"
                    style={{ flex: 2, backgroundColor: colors.surfaceRaised, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, color: colors.textPrimary, fontSize: 12 }}
                  />
                  <TextInput
                    value={it.unit}
                    onChangeText={(t) => setSpeechReview(s => s ? { ...s, items: s.items.map((x, idx) => idx === i ? { ...x, unit: t } : x) } : s)}
                    style={{ flex: 1, backgroundColor: colors.surfaceRaised, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, color: colors.textPrimary, fontSize: 12 }}
                  />
                </View>
                <Text style={{ fontSize: 10, color: colors.textMuted, marginTop: 6 }}>
                  {Math.round(it.calories)} cal · {Math.round(it.protein)}g P · {Math.round(it.carbs)}g C · {Math.round(it.fat)}g F
                </Text>
              </View>
            ))}
          </ScrollView>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
            <TouchableOpacity
              onPress={() => setSpeechReview(null)}
              style={{ flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}
            >
              <Text style={{ color: colors.textSecondary, fontWeight: '700', fontSize: 13 }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                if (!speechReview) return;
                const mapped = speechReview.items
                  .filter(it => (it.name || '').trim() && it.quantity > 0)
                  .map(it => ({
                    name: it.name,
                    quantity: it.quantity,
                    unit: it.unit || 'serving',
                    calories: it.calories,
                    protein: it.protein,
                    carbs: it.carbs,
                    fat: it.fat,
                    baseQuantity: it.quantity > 0 ? it.quantity : 1,
                    baseCalories: it.calories,
                    baseProtein: it.protein,
                    baseCarbs: it.carbs,
                    baseFat: it.fat,
                    ...(it.micronutrients ? { micronutrients: it.micronutrients } : {}),
                  } as any));
                userEdited.current = true;
                setItems(prev => [...prev, ...mapped]);
                setSpeechReview(null);
              }}
              disabled={(speechReview?.items.length ?? 0) === 0}
              style={{ flex: 2, paddingVertical: 12, borderRadius: 10, alignItems: 'center', backgroundColor: (speechReview?.items.length ?? 0) === 0 ? colors.border : colors.primary }}
            >
              <Text style={{ color: getContrastingTextColor(colors.primary), fontWeight: '800', fontSize: 13 }}>
                Add {(speechReview?.items.length ?? 0)} to meal
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
    </>
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
  gapButton: {
    marginHorizontal: 16,
    marginTop: 8,
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: colors.primary + '12',
    borderWidth: 1,
    borderColor: colors.primary + '55',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  gapButtonIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.primary + '18',
    alignItems: 'center',
    justifyContent: 'center',
  },
  gapButtonTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  gapButtonMeta: {
    marginTop: 2,
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
  },

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
  unitChipTextActive: { color: getContrastingTextColor(colors.primary), fontWeight: '700' },
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

  // AI search — inline button next to search input
  aiSearchInlineBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 10, paddingHorizontal: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  aiSearchInlineBtnText: { fontSize: 13, fontWeight: '700', color: getContrastingTextColor(colors.primary) },
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

  sourceBadge: {
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm ?? 4,
    borderWidth: 1,
  },
  sourceBadgeUsda: { backgroundColor: '#10B98122', borderColor: '#10B98177' },
  sourceBadgeAi:   { backgroundColor: colors.primary + '22', borderColor: colors.primary + '77' },
  sourceBadgeLocal: { backgroundColor: colors.surfaceRaised, borderColor: colors.border },
  sourceBadgeText: { fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  sourceBadgeTextUsda: { color: '#059669' },
  sourceBadgeTextAi:   { color: colors.primary },
  sourceBadgeTextLocal: { color: colors.textSecondary },

  alsoAskAiBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, marginTop: 4,
    borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.primary + '55',
    backgroundColor: colors.primary + '11',
  },
  alsoAskAiText: { fontSize: 12, fontWeight: '700', color: colors.primary },
}); }
