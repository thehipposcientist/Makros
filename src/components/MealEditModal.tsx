import React, { useState, useEffect, useMemo, useRef, useDeferredValue } from 'react';
import BarcodeScannerModal from './BarcodeScannerModal';
import ScanHudOverlay from './ScanHudOverlay';
import MealTimeSelector, { parseMealDateTime } from './MealTimeSelector';
import MacroDonutRow from './MacroDonutRow';
import MealThumbnail from './MealThumbnail';
import {
  View, Text, ScrollView, Modal, TouchableOpacity,
  StyleSheet, TextInput, KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
  LayoutAnimation, UIManager, Keyboard, Image,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import * as ImagePicker from 'expo-image-picker';
import {
  MealSuggestion, DailyNutritionPlan, SavedMealTemplate,
  MealItem, FoodUnit, FOOD_UNIT_LABELS, FOOD_UNIT_GROUPS,
} from '../types';
import { FoodItem, FoodCategoryGroup, lookupFood } from '../hooks/useMetaData';
import { useLiveFoodSearch } from '../hooks/useLiveFoodSearch';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { scanFoodsPhoto, searchFoodNutrition, getMealInstructions } from '../services/api';
import type { FoodSearchResult, SpokenFoodItem } from '../services/api';
import { buildGapMealSuggestion, positiveMacroGap } from '../utils/mealGapSuggestion';
import { ensureItems, syncLegacyFieldsFromItems, splitFoodString, convertQuantity, parseAmountString, guessUnitForFood, validUnitsForFood, scaleMealItem, macroTotalsFromItems, macroTotalsFromMeal, preferredAmountForFoodServing, gramsFromFoodAmount, gramsFromFoodServing } from '../utils/mealItems';
import { badgeLabelForSource, badgeToneForSource, searchUserFoodCategories } from '../utils/customFoodSearch';
import { foodClassificationFields } from '../utils/foodClassification';
import { getFoodIconSpec } from '../utils/foodIcon';
import { hapticWarning, hapticSuccess } from '../utils/feedback';
import type { ProFeature } from '../utils/subscription';

interface Props {
  visible: boolean;
  mealType: string;           // 'breakfast' | 'lunch' | 'dinner'
  meal: MealSuggestion;
  nutritionPlan: DailyNutritionPlan; // full plan so we can show day total
  allFoods: FoodItem[];
  foodCategories: FoodCategoryGroup[];
  savedMeals?: SavedMealTemplate[];
  favoriteMeals?: FavoriteMealCopy[];
  authToken?: string;
  dateKey?: string;           // e.g. '2026-04-18' — used for DB-backed save context
  /** Save the current draft. May be async; the modal awaits the returned
   *  promise, keeps Save disabled while pending, and only calls `onClose`
   *  after success. A throw keeps the modal open and surfaces an alert. */
  onSave: (updated: MealSuggestion) => void | Promise<void>;
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
  /** Save the current draft as a reusable Saved Meal (distinct from
   *  Routine — Routine = scheduled recurring, Saved = one-tap log from
   *  Add Foods). The MODAL passes the current, edited draft as `draft`
   *  so the favorite reflects whatever the user is looking at, not the
   *  original meal prop. When null/undefined, the chip hides. */
  onSaveAsMeal?: (draft: MealSuggestion) => void | Promise<void>;
  /** Editor mode:
   *  - 'day' (default): editing a single meal on a single day. Save
   *    calls `onSave(updated)` and the parent decides whether to
   *    detach / apply-to-all / etc.
   *  - 'template': editing a Saved Meal library item. The save writes
   *    to the template via the parent's onSave; routine + save-as-meal
   *    chips are hidden because they don't apply. A banner explains
   *    that template edits apply to future logs only.
   */
  mode?: 'day' | 'template';
  /** Optional routine-save scope callback. When the meal being edited
   *  is routine-backed (has `_routineId`), the editor surfaces a
   *  "Just today / Apply to every day" prompt on save and invokes
   *  this. When omitted, save falls through to `onSave` with the raw
   *  meal (legacy behavior). */
  onSaveRoutine?: (updated: MealSuggestion, scope: 'today' | 'all') => void | Promise<void>;
  /** True while a parent-side mutation tied to this meal is in flight
   *  (favorite/unfavorite from elsewhere). When set, the Save flow does
   *  not race the favorite write. Optional — older callers can omit. */
  externalMutationPending?: boolean;
  autoOpenFoodCamera?: boolean;
  autoOpenBarcodeScanner?: boolean;
  cookingSkill?: string;
  prepTimeMinutes?: number;
  dietaryPreference?: string;
  allergies?: string[];
  themeName?: AppThemeName;
}

interface Macros { calories: number; protein: number; carbs: number; fat: number; }

function routineContentSignature(
  mealName: string | null | undefined,
  items: MealItem[] | null | undefined,
  instructions: string | null | undefined,
): string {
  const rounded = (value: unknown) => {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  };
  return JSON.stringify({
    meal: String(mealName ?? '').trim(),
    instructions: String(instructions ?? '').trim(),
    items: (items ?? []).map(item => ({
      name: String(item.name ?? '').trim(),
      quantity: rounded(item.quantity),
      unit: item.unit ?? 'serving',
      calories: Math.round(Number(item.calories ?? 0)),
      protein: Math.round(Number(item.protein ?? 0)),
      carbs: Math.round(Number(item.carbs ?? 0)),
      fat: Math.round(Number(item.fat ?? 0)),
      food_id: item.food_id ?? null,
    })),
  });
}

interface PendingFoodScan {
  imageBase64: string;
  imageUri?: string;
  mimeType: string;
}

interface FavoriteMealCopy {
  id?: string | number;
  name: string;
  items?: any[];
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  total_calories?: number;
  total_protein_g?: number;
  total_carbs_g?: number;
  total_fat_g?: number;
  times_logged?: number;
  source_owner_username?: string | null;
  image_url?: string | null;
  image_source?: string | null;
}

const _WEIGHT_UNITS = new Set<FoodUnit>(['g', 'kg', 'oz', 'lb']);
const _VOLUME_UNITS = new Set<FoodUnit>(['ml', 'l', 'fl_oz', 'cup', 'tbsp', 'tsp', 'pint', 'quart', 'gallon']);
const _COUNT_UNITS = new Set<FoodUnit>(['piece', 'slice', 'scoop', 'serving']);

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

function _roundServingGrams(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 10) / 10;
}

function _positiveAmount(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function _baseServingGramsFromItem(item: Partial<MealItem>): number | null {
  const explicit = _positiveAmount((item as any).baseServingGrams);
  if (explicit != null) return explicit;
  const actualGrams = _positiveAmount(item.serving_grams);
  const qty = _positiveAmount(item.quantity);
  if (actualGrams != null && qty != null && item.unit && _COUNT_UNITS.has(item.unit)) {
    return actualGrams / qty;
  }
  return actualGrams;
}

function _baseGramsForCurrentRate(item: MealItem): number | null {
  const baseQty = _positiveAmount(item.baseQuantity) ?? 1;
  if (_COUNT_UNITS.has(item.unit)) {
    const perUnitGrams = _baseServingGramsFromItem(item);
    return perUnitGrams != null ? perUnitGrams * baseQty : null;
  }
  return gramsFromFoodAmount(baseQty, item.unit);
}

function _actualGramsForItemQuantity(item: MealItem, quantity: number, unit: FoodUnit = item.unit): number | null {
  const direct = gramsFromFoodAmount(quantity, unit);
  if (direct != null) return direct;
  if (_COUNT_UNITS.has(unit)) {
    const perUnitGrams = _baseServingGramsFromItem(item);
    return perUnitGrams != null ? perUnitGrams * quantity : null;
  }
  return null;
}

function _withServingBridge(item: MealItem): MealItem {
  const baseServingGrams = _baseServingGramsFromItem(item);
  return baseServingGrams != null ? { ...item, baseServingGrams } : item;
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
  const editingHistoryId = editingType.startsWith('history_') ? Number(editingType.slice('history_'.length)) : 0;
  return meals.reduce<Macros>((acc, meal, idx) => {
    if (`meal_${idx}` === editingType) return acc;
    if (editingHistoryId > 0 && Number((meal as any)._loggedMealId || 0) === editingHistoryId) return acc;
    return addMacros(acc, macroTotalsFromMeal(meal));
  }, zero);
}

function favoriteMealTotals(favorite: FavoriteMealCopy): Macros {
  const itemTotals = (favorite.items ?? []).reduce<Macros>((acc, raw) => {
    if (typeof raw === 'string') return acc;
    return {
      calories: acc.calories + Number(raw?.calories ?? 0),
      protein: acc.protein + Number(raw?.protein_g ?? raw?.protein ?? 0),
      carbs: acc.carbs + Number(raw?.carbs_g ?? raw?.carbs ?? 0),
      fat: acc.fat + Number(raw?.fat_g ?? raw?.fat ?? 0),
    };
  }, { calories: 0, protein: 0, carbs: 0, fat: 0 });
  return {
    calories: Number(favorite.total_calories ?? favorite.calories ?? itemTotals.calories ?? 0),
    protein: Number(favorite.total_protein_g ?? favorite.protein ?? itemTotals.protein ?? 0),
    carbs: Number(favorite.total_carbs_g ?? favorite.carbs ?? itemTotals.carbs ?? 0),
    fat: Number(favorite.total_fat_g ?? favorite.fat ?? itemTotals.fat ?? 0),
  };
}

function favoriteMealToItems(favorite: FavoriteMealCopy): MealItem[] {
  const rawItems = favorite.items ?? [];
  const totals = favoriteMealTotals(favorite);
  if (rawItems.length === 0) return [];
  return rawItems.map((raw, idx) => {
    if (typeof raw === 'string') {
      const count = Math.max(1, rawItems.length);
      return {
        name: raw,
        quantity: 1,
        unit: 'serving',
        calories: Math.round(totals.calories / count),
        protein: Math.round(totals.protein / count),
        carbs: Math.round(totals.carbs / count),
        fat: Math.round(totals.fat / count),
        baseQuantity: 1,
        baseCalories: Math.round(totals.calories / count),
        baseProtein: Math.round(totals.protein / count),
        baseCarbs: Math.round(totals.carbs / count),
        baseFat: Math.round(totals.fat / count),
      } as MealItem;
    }
    const qty = Number(raw?.quantity || 1);
    const calories = Number(raw?.calories || 0);
    const protein = Number(raw?.protein_g ?? raw?.protein ?? 0);
    const carbs = Number(raw?.carbs_g ?? raw?.carbs ?? 0);
    const fat = Number(raw?.fat_g ?? raw?.fat ?? 0);
    return {
      name: String(raw?.food_name || raw?.name || `Item ${idx + 1}`),
      food_id: raw?.food_id ?? null,
      serving_id: raw?.serving_id ?? null,
      serving_grams: raw?.serving_grams ?? null,
      source: raw?.source ?? null,
      fdc_id: raw?.fdc_id ?? raw?.external_id ?? null,
      external_id: raw?.external_id ?? raw?.fdc_id ?? null,
      barcode: raw?.barcode ?? null,
      brand: raw?.brand ?? null,
      is_verified: raw?.is_verified ?? null,
      quantity: qty,
      unit: String(raw?.unit || 'serving') as FoodUnit,
      calories,
      protein,
      carbs,
      fat,
      baseQuantity: qty > 0 ? qty : 1,
      baseCalories: calories,
      baseProtein: protein,
      baseCarbs: carbs,
      baseFat: fat,
      ...(raw?.micronutrients ? { micronutrients: raw.micronutrients } : {}),
    } as MealItem;
  });
}

export default function MealEditModal({ visible, mealType, meal, nutritionPlan, allFoods, foodCategories, savedMeals = [], favoriteMeals = [], authToken, dateKey, onSave, onClose, onAddCustomFood, onToggleRoutine, onSaveAsMeal, mode = 'day', onSaveRoutine, cookingSkill, prepTimeMinutes, dietaryPreference, allergies, themeName, externalMutationPending = false, autoOpenFoodCamera = false, autoOpenBarcodeScanner = false }: Props) {
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
      it = _withServingBridge(it);
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

  // Save-flow guards. The Save / Save-as-Favorite paths each have their
  // own ref + visible flag so a synchronous double-tap (or a tap that
  // arrives before the first await resolves) collapses to one mutation
  // and the affected button shows pending UI instead of silently no-oping.
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const savingFavoriteRef = useRef(false);
  const [savingFavorite, setSavingFavorite] = useState(false);

  // Speech-to-meal — user taps mic, describes their meal, Whisper
  // transcribes + GPT parses into structured items. Two-tap UX:
  // first tap starts recording, second tap stops + sends.
  const recordingRef = useRef<any>(null);
  // Stop/unload an in-progress recording if the modal unmounts mid-record, so
  // we don't leak the Recording or leave the iOS audio session in record mode.
  useEffect(() => () => {
    const rec = recordingRef.current;
    if (!rec) return;
    recordingRef.current = null;
    rec.stopAndUnloadAsync?.().catch(() => {});
    import('expo-av').then(AV => AV.Audio.setAudioModeAsync({ allowsRecordingIOS: false })).catch(() => {});
  }, []);
  const [isRecording, setIsRecording] = useState(false);
  const [speechLoading, setSpeechLoading] = useState(false);
  const [speechReview, setSpeechReview] = useState<null | {
    transcript: string;
    items: SpokenFoodItem[];
  }>(null);
  const [search,      setSearch]      = useState('');
  const [scanLoading, setScanLoading] = useState(false);
  const [scanContext, setScanContext] = useState('');
  const [pendingFoodScan, setPendingFoodScan] = useState<PendingFoodScan | null>(null);
  const [barcodeScanning, setBarcodeScanning] = useState(false);
  const [barcodeFallback, setBarcodeFallback] = useState<string | null>(null);
  const [aiSearchLoading, setAiSearchLoading] = useState(false);
  const [aiResults, setAiResults] = useState<FoodSearchResult[]>([]);
  const [searchFeedback, setSearchFeedback] = useState<{ name: string; status: 'added' | 'duplicate' } | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [foodSearchFocused, setFoodSearchFocused] = useState(false);
  const [foodSearchDismissed, setFoodSearchDismissed] = useState(false);
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
  // Show the Breakfast/Lunch/Dinner/Snack preset chips only while the user is
  // actively editing the meal name — they're a discovery aid, not a permanent
  // header row.
  const [nameFocused, setNameFocused] = useState(false);
  const [favoritePickerOpen, setFavoritePickerOpen] = useState(false);
  const eatenAtLabel = useMemo(() => eatenAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }), [eatenAt]);
  const eatenAtDateLabel = useMemo(() => eatenAt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }), [eatenAt]);
  const deferredSearch = useDeferredValue(search);
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
      setScanContext('');
      setPendingFoodScan(null);
      setAiResults([]);
      setSearchFeedback(null);
      setFoodSearchFocused(false);
      setFoodSearchDismissed(false);
      setKeyboardHeight(0);
      setUnitPickerIdx(null);
      setInstructions(meal.instructions ?? null);
      setShowInstructions(false);
      setMealName(meal.meal ?? '');
      setEatenAt(parseMealDateTime((meal as any)._consumedAt ?? (meal as any).consumed_at, dateKey));
      setMealTimeExpanded(false);
      setFavoritePickerOpen(false);
    }
  }, [visible, meal, dateKey]);

  const favoriteMealChoices = useMemo<FavoriteMealCopy[]>(() => {
    if (favoriteMeals.length > 0) return favoriteMeals;
    return savedMeals.map(template => ({
      id: template.id,
      name: template.name,
      items: template.items,
      calories: template.calories,
      protein: template.protein,
      carbs: template.carbs,
      fat: template.fat,
    }));
  }, [favoriteMeals, savedMeals]);
  const favoriteMealColumns = useMemo<FavoriteMealCopy[][]>(() => {
    const columns: FavoriteMealCopy[][] = [];
    for (let idx = 0; idx < favoriteMealChoices.length; idx += 2) {
      columns.push(favoriteMealChoices.slice(idx, idx + 2));
    }
    return columns;
  }, [favoriteMealChoices]);

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

  const {
    results: catalogSearchResults,
    loading: catalogSearchLoading,
    error: catalogSearchError,
  } = useLiveFoodSearch(authToken, deferredSearch, {
    enabled: visible,
    minChars: 2,
    allowAiFallback: false,
  });

  const foodSearchActive = !foodSearchDismissed && (
    foodSearchFocused
    || search.trim().length > 0
    || catalogSearchLoading
    || catalogSearchResults.length > 0
    || aiSearchLoading
    || aiResults.length > 0
  );
  const aiSearchQueryReady = !!authToken && search.trim().length > 1;
  const aiSearchButtonColor = aiSearchQueryReady ? getContrastingTextColor(colors.primary) : colors.textMuted;

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
    () => searchUserFoodCategories(foodCategories as any, deferredSearch) as unknown as FoodSearchResult[],
    [foodCategories, deferredSearch],
  );
  const remoteSearchResults = useMemo(() => {
    const mergedResults: FoodSearchResult[] = [];
    const seen = new Set<string>();
    const orderedResults = aiResults.length > 0
      ? [...aiResults, ...catalogSearchResults]
      : [...catalogSearchResults, ...aiResults];
    for (const result of orderedResults) {
      const key = `${result.name.trim().toLowerCase()}|${String(result.serving ?? '').trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mergedResults.push(result);
    }
    if (localSearchResults.length === 0) return mergedResults;
    const localKeys = new Set(localSearchResults.map(r => `${r.name.trim().toLowerCase()}|${r.serving.trim().toLowerCase()}`));
    return mergedResults.filter(r => !localKeys.has(`${r.name.trim().toLowerCase()}|${String(r.serving ?? '').trim().toLowerCase()}`));
  }, [aiResults, catalogSearchResults, localSearchResults]);
  const aiRemoteResults = useMemo(
    () => remoteSearchResults.filter(result => result.source === 'ai'),
    [remoteSearchResults],
  );
  const catalogRemoteResults = useMemo(
    () => remoteSearchResults.filter(result => result.source !== 'ai'),
    [remoteSearchResults],
  );

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
  }, [foodSearchActive, aiResults.length, catalogSearchLoading, catalogSearchResults.length, localSearchResults.length, aiSearchLoading]);

  const exitFoodSearchToEdit = () => {
    setFoodSearchDismissed(true);
    searchInputRef.current?.blur();
    setSearch('');
    setAiResults([]);
    setSearchFeedback(null);
    setFoodSearchFocused(false);
    if (barcodeFallback) setBarcodeFallback(null);
    Keyboard.dismiss();
    setTimeout(() => {
      scrollRef.current?.scrollTo({ y: 0, animated: true });
    }, 80);
  };

  const showFoodSearchFeedback = (name: string, status: 'added' | 'duplicate') => {
    setFoodSearchDismissed(false);
    setSearchFeedback({ name, status });
    setTimeout(() => {
      setSearchFeedback(current => current?.name === name && current.status === status ? null : current);
    }, 1800);
  };

  const scaleEntireMeal = (factor: number) => {
    if (items.length === 0) return;
    userEdited.current = true;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setItems(prev => prev.map(item => scaleMealItem(item, factor)));
    setQtyDrafts({});
    setUnitPickerIdx(null);
  };

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

  const scanPendingFoodPhoto = async (photo: PendingFoodScan) => {
    if (!authToken) return;
    setScanLoading(true);
    try {
      const res = await scanFoodsPhoto(authToken, {
        images: [{ image_base64: photo.imageBase64, mime_type: photo.mimeType }],
        context: scanContext.trim() || undefined,
        meal_slot: mealType && mealType !== 'custom' ? mealType : undefined,
        dietary_preference: dietaryPreference || undefined,
        allergies: allergies && allergies.length ? allergies : undefined,
      });
      const picked = res.foods.filter(f => !items.some(it => it.name.toLowerCase() === f.name.toLowerCase()));
      if (res.foods.length === 0) {
        Alert.alert('No foods found', 'Could not identify any foods in that photo. Add context or try a clearer angle.');
        return;
      }
      if (picked.length === 0) {
        Alert.alert('Already added', 'All identified foods are already in this meal.');
      } else {
        const newItems: MealItem[] = picked.map(p => {
          const aiHasMacros =
            (p.calories ?? 0) > 0 || (p.protein ?? 0) > 0 ||
            (p.carbs ?? 0) > 0 || (p.fat ?? 0) > 0;
          const lib = aiHasMacros ? null : lookupFood(p.name, allFoods);
          const cal  = aiHasMacros ? (p.calories ?? 0) : (lib?.calories ?? 0);
          const prot = aiHasMacros ? (p.protein  ?? 0) : (lib?.protein  ?? 0);
          const carb = aiHasMacros ? (p.carbs    ?? 0) : (lib?.carbs    ?? 0);
          const fat  = aiHasMacros ? (p.fat      ?? 0) : (lib?.fat      ?? 0);
          const scanServingGrams = _roundServingGrams(
            p.serving_grams
            ?? (typeof p.estimated_grams === 'number' && p.estimated_grams > 0 ? p.estimated_grams : null),
          );
          const preferred = preferredAmountForFoodServing(p.name, p.serving, scanServingGrams);
          const qty = preferred.quantity;
          const unit = preferred.unit as FoodUnit;
          const servingGrams = _roundServingGrams(
            scanServingGrams
            ?? gramsFromFoodServing(p.serving, p.serving_grams ?? null)
            ?? gramsFromFoodAmount(qty, unit),
          );
          const baseServingGrams = _roundServingGrams(scanServingGrams ?? gramsFromFoodServing(p.serving, p.serving_grams ?? null) ?? servingGrams);
          return {
            name: p.name,
            quantity: qty,
            unit,
            calories: cal, protein: prot, carbs: carb, fat,
            baseQuantity: qty > 0 ? qty : 1,
            baseCalories: cal, baseProtein: prot, baseCarbs: carb, baseFat: fat,
            ...(baseServingGrams != null ? { baseServingGrams } : {}),
            food_id: p.food_id ?? null,
            serving_id: p.serving_id ?? null,
            serving_grams: servingGrams,
            source: p.source ?? p.nutrition_source,
            fdc_id: p.fdc_id ?? p.external_id ?? null,
            external_id: p.external_id ?? p.fdc_id ?? null,
            barcode: (p as any).barcode ?? null,
            brand: p.brand ?? null,
            is_verified: p.is_verified,
            ...(p.micronutrients ? { micronutrients: p.micronutrients } : {}),
            ...foodClassificationFields(p),
          };
        });
        setItems(prev => {
          const next = [...prev, ...newItems];
          persistNow(next);
          return next;
        });
        exitFoodSearchToEdit();
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
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setPendingFoodScan(null);
      setScanContext('');
    } catch (e: any) {
      const rawDetail = e?.message || e?.detail || '';
      const detail = rawDetail || 'Could not scan the photo.';
      console.warn('[MealEditModal] scan failed:', detail);
      // Always tear down the in-progress scan UI so the user isn't stuck
      // staring at a spinner / preview. Surface an actionable alert that
      // offers a manual fallback rather than just "Try again later".
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setPendingFoodScan(null);
      setScanContext('');
      // Classify the failure to give the user better next-step copy.
      const lowered = String(detail).toLowerCase();
      const networkish = lowered.includes('network') || lowered.includes('reach') || lowered.includes('timed out') || lowered.includes('timeout');
      const visionish = lowered.includes('recognize') || lowered.includes('no items') || lowered.includes('unclear') || lowered.includes('blurry');
      const title = networkish ? "Can't reach scan service" : visionish ? "Didn't catch that" : 'Scan failed';
      const message = networkish
        ? 'Your network looks flaky right now. Add foods manually or try again on Wi-Fi.'
        : visionish
        ? "I couldn't make out the food clearly. Try a closer / brighter photo, or add the items by name."
        : detail;
      Alert.alert(title, message, [
        { text: 'Try another photo', onPress: () => pickAndScan('camera') },
        { text: 'Add manually', onPress: exitFoodSearchToEdit, style: 'default' },
        { text: 'OK', style: 'cancel' },
      ]);
    } finally {
      setScanLoading(false);
    }
  };

  // Ref-based in-flight lock. `scanLoading` state is one render behind,
  // so a quick double-tap can enter pickAndScan twice before the disabled
  // prop rerenders. The ref flips synchronously so the second call bails.
  const scanLock = useRef(false);
  const autoFoodCameraStartedRef = useRef(false);
  const autoBarcodeStartedRef = useRef(false);
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
    // Send a higher-quality source: the high-detail vision model needs the
    // detail to identify mixed plates, and the backend already downscales to
    // <=1024px server-side — so over-compressing here (esp. the old 0.4 library
    // quality) only destroyed information before the model ever saw it.
    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync({ base64: true, quality: 0.72, mediaTypes: 'images', exif: false, allowsEditing: false, maxWidth: 1280, maxHeight: 1280 } as any)
      : await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.7, mediaTypes: 'images', exif: false, allowsEditing: false, maxWidth: 1280, maxHeight: 1280 } as any);
    if (result.canceled || !result.assets?.[0]?.base64) {
      scanLock.current = false;
      return;
    }
    const asset = result.assets[0];
    const rawMime = (asset.mimeType || '').toLowerCase();
    const mime =
      rawMime === 'image/jpeg' || rawMime === 'image/jpg' || rawMime === 'image/png' || rawMime === 'image/webp'
        ? (rawMime === 'image/jpg' ? 'image/jpeg' : rawMime)
        : 'image/jpeg';
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setPendingFoodScan({ imageBase64: asset.base64!, imageUri: asset.uri, mimeType: mime });
    scanLock.current = false;
  };

  useEffect(() => {
    if (!visible || !autoOpenFoodCamera) {
      autoFoodCameraStartedRef.current = false;
      return;
    }
    if (!authToken) return;
    if (autoFoodCameraStartedRef.current) return;
    autoFoodCameraStartedRef.current = true;
    const timer = setTimeout(() => {
      void pickAndScan('camera');
    }, Platform.OS === 'ios' ? 450 : 180);
    return () => clearTimeout(timer);
  }, [visible, autoOpenFoodCamera, authToken, dateKey, mealType]);

  useEffect(() => {
    if (!visible || !autoOpenBarcodeScanner) {
      autoBarcodeStartedRef.current = false;
      return;
    }
    if (!authToken) return;
    if (autoBarcodeStartedRef.current) return;
    autoBarcodeStartedRef.current = true;
    const timer = setTimeout(() => {
      setBarcodeScanning(true);
    }, Platform.OS === 'ios' ? 450 : 180);
    return () => clearTimeout(timer);
  }, [visible, autoOpenBarcodeScanner, authToken, dateKey, mealType]);

  // These ran on every render (incl. every keystroke in the name field and
  // every qtyDraft change). Memoize so macro math only recomputes when its
  // real inputs change. otherMacros/gapPreview don't depend on `items`, so
  // they stay stable while the user is editing a single meal's foods.
  const mealMacros = useMemo(() => macroTotalsFromItems(items, meal), [items, meal]);
  const otherMacros = useMemo(() => otherMealsMacros(nutritionPlan, mealType), [nutritionPlan, mealType]);
  const gapPreview = useMemo(() => positiveMacroGap(nutritionPlan.targets, otherMacros), [nutritionPlan.targets, otherMacros]);
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
      exitFoodSearchToEdit();
    };
    apply();
  };

  const copyFavoriteIntoEditor = (favorite: FavoriteMealCopy) => {
    const copiedItems = favoriteMealToItems(favorite);
    if (copiedItems.length === 0) {
      Alert.alert('Nothing to copy', 'This favorite does not have any saved foods yet.');
      return;
    }
    userEdited.current = true;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setMealName(favorite.name || 'Favorite meal');
    setItems(seedItemBaselines(copiedItems));
    setInstructions(null);
    setShowInstructions(false);
    setUnitPickerIdx(null);
    setQtyDrafts({});
    setFavoritePickerOpen(false);
    exitFoodSearchToEdit();
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
    if (items.some(it => it.name.toLowerCase() === name.toLowerCase())) {
      showFoodSearchFeedback(name, 'duplicate');
      return;
    }
    const lib = lookupFood(name, allFoods);
    const parsed = splitFoodString(name);
    const cleanName = parsed.name || name;

    // Prefer the library entry's canonical serving over a generic default.
    // `lib.unit` looks like "1 cup (244ml)" or "1 large (118g)". When neither
    // the parsed string nor the library carries a usable unit, fall back to
    // a food-type-aware guess (cup for liquids, oz for meat, etc.) so we
    // never display the meaningless "1 serving" label.
    const libPreferred = lib ? preferredAmountForFoodServing(cleanName, lib.unit, lib.serving_grams ?? null) : null;
    const guess = guessUnitForFood(cleanName);
    let qty = parsed.quantity ?? libPreferred?.quantity ?? guess.quantity;
    let unit = parsed.unit ?? libPreferred?.unit ?? guess.unit;
    if ((unit as string) === 'serving') {
      qty = guess.quantity;
      unit = guess.unit;
    }
    const servingGrams = _roundServingGrams(gramsFromFoodServing(lib?.unit, lib?.serving_grams ?? null) ?? gramsFromFoodAmount(qty, unit));
    const baseServingGrams = _roundServingGrams(gramsFromFoodServing(lib?.unit, lib?.serving_grams ?? null) ?? servingGrams);

    const newItem: MealItem = {
      name: cleanName,
      food_id: lib?.id ?? null,
      serving_grams: servingGrams,
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
      ...(baseServingGrams != null ? { baseServingGrams } : {}),
      ...foodClassificationFields(lib as any),
    };
    userEdited.current = true;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setItems(prev => [...prev, newItem]);
    showFoodSearchFeedback(cleanName, 'added');
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
        const measuredConverted = current.serving_grams != null && _WEIGHT_UNITS.has(patch.unit)
          ? convertQuantity(current.serving_grams, 'g', patch.unit)
          : null;
        const countConverted = _COUNT_UNITS.has(patch.unit)
          ? (() => {
              const baseServingGrams = _baseServingGramsFromItem(current);
              const actualGrams = _positiveAmount(current.serving_grams);
              return baseServingGrams != null && actualGrams != null ? actualGrams / baseServingGrams : null;
            })()
          : null;
        if (countConverted != null) {
          const baseServingGrams = _baseServingGramsFromItem(current);
          const baseGrams = _baseGramsForCurrentRate(current);
          const baseQty = _COUNT_UNITS.has(current.unit)
            ? (_positiveAmount(current.baseQuantity) ?? 1)
            : (baseServingGrams != null && baseGrams != null ? baseGrams / baseServingGrams : 1);
          const denominator = countConverted > 0 ? countConverted : 1;
          const baseCalories = current.baseCalories ?? (current.calories / denominator);
          const baseProtein = current.baseProtein ?? (current.protein / denominator);
          const baseCarbs = current.baseCarbs ?? (current.carbs / denominator);
          const baseFat = current.baseFat ?? (current.fat / denominator);
          next[idx] = {
            ...current,
            unit: patch.unit,
            quantity: Math.round(countConverted * 100) / 100,
            baseQuantity: Math.round(baseQty * 100) / 100,
            baseCalories,
            baseProtein,
            baseCarbs,
            baseFat,
          };
        } else if (converted != null || measuredConverted != null) {
          const nextQuantity = converted ?? measuredConverted ?? current.quantity;
          const baseGrams = _baseGramsForCurrentRate(current);
          const baseConverted = current.baseQuantity != null
            ? (
                baseGrams != null && _WEIGHT_UNITS.has(patch.unit)
                  ? convertQuantity(baseGrams, 'g', patch.unit)
                  : convertQuantity(current.baseQuantity, current.unit, patch.unit)
              ) ?? nextQuantity
            : current.baseQuantity;
          const nextServingGrams = _roundServingGrams(
            gramsFromFoodAmount(nextQuantity, patch.unit) ?? current.serving_grams,
          );
          next[idx] = {
            ...current,
            unit: patch.unit,
            quantity: Math.round(nextQuantity * 100) / 100,
            baseQuantity: baseConverted != null ? Math.round(baseConverted * 100) / 100 : current.baseQuantity,
            ...(nextServingGrams != null ? { serving_grams: nextServingGrams } : {}),
          };
        } else {
          // Cross-system switch (e.g. g→cup, piece→oz). Density estimate
          // converts the quantity label while preserving the same physical
          // amount of food — macros don't change. Re-anchor baseQuantity to
          // the new unit so future quantity edits scale correctly.
          const { qty: defaultQty } = _crossSystemDefault(current.unit, patch.unit, current.quantity, current.name);
          const nextServingGrams = _roundServingGrams(
            gramsFromFoodAmount(defaultQty, patch.unit) ?? current.serving_grams,
          );
          next[idx] = {
            ...current,
            unit: patch.unit,
            quantity: defaultQty,
            baseQuantity: defaultQty,
            baseCalories: current.calories,
            baseProtein:  current.protein,
            baseCarbs:    current.carbs,
            baseFat:      current.fat,
            ...(nextServingGrams != null ? { serving_grams: nextServingGrams } : {}),
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
        const servingGramRatio = current.quantity > 0 ? patch.quantity / current.quantity : null;
        const nextServingGrams = _roundServingGrams(
          _actualGramsForItemQuantity(current, patch.quantity)
          ?? (servingGramRatio != null && current.serving_grams != null ? current.serving_grams * servingGramRatio : null),
        );
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
          ...(nextServingGrams != null ? { serving_grams: nextServingGrams } : {}),
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
  const searchInputRef = useRef<TextInput | null>(null);
  const handleBarcodeScan = async (barcode: string) => {
    if (!authToken || !barcode.trim() || barcodeLock.current) return;
    barcodeLock.current = true;
    setScanLoading(true);
    try {
      const { lookupBarcode } = await import('../services/api');
      const result = await lookupBarcode(authToken, barcode.trim());
      if (result && result.name) {
        setBarcodeFallback(null);
        addAiFood(result);
      } else {
        setBarcodeFallback(barcode.trim());
        hapticWarning();
        setTimeout(() => searchInputRef.current?.focus(), 80);
      }
    } catch {
      setBarcodeFallback(barcode.trim());
      hapticWarning();
      setTimeout(() => searchInputRef.current?.focus(), 80);
    } finally {
      setScanLoading(false);
      setBarcodeScanning(false);
      barcodeLock.current = false;
    }
  };

  const handleAiSearch = async (opts?: { append?: boolean }) => {
    if (!search.trim()) return;
    if (!(await requireStoredPro('ai_food_enrichment'))) return;
    if (!authToken) return;
    setAiSearchLoading(true);
    try {
      const res = await searchFoodNutrition(authToken, search.trim(), { forceAi: true });
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
      if (!incoming.length) Alert.alert('No AI results', `AI had nothing to add for "${search}".`);
    } catch (e: any) {
      Alert.alert('Search failed', e.message ?? 'Could not reach the server.');
    } finally {
      setAiSearchLoading(false);
    }
  };

  const addAiFood = (aiItem: FoodSearchResult) => {
    if (items.some(it => it.name.toLowerCase() === aiItem.name.toLowerCase())) {
      showFoodSearchFeedback(aiItem.name, 'duplicate');
      return;
    }
    const amount = preferredAmountForFoodServing(aiItem.name, aiItem.serving, aiItem.serving_grams ?? null);
    const qty = amount.quantity;
    const unit = amount.unit;
    const servingGrams = _roundServingGrams(gramsFromFoodServing(aiItem.serving, aiItem.serving_grams ?? null) ?? gramsFromFoodAmount(qty, unit));
    const baseServingGrams = _roundServingGrams(gramsFromFoodServing(aiItem.serving, aiItem.serving_grams ?? null) ?? servingGrams);
    const cal = Math.round(aiItem.calories);
    const prot = Math.round(aiItem.protein);
    const carb = Math.round(aiItem.carbs);
    const fat = Math.round(aiItem.fat);
    const newItem: MealItem = {
      name: aiItem.name,
      quantity: qty,
      unit,
      calories: cal, protein: prot, carbs: carb, fat,
      baseQuantity: qty > 0 ? qty : 1,
      baseCalories: cal, baseProtein: prot, baseCarbs: carb, baseFat: fat,
      ...(baseServingGrams != null ? { baseServingGrams } : {}),
      food_id: aiItem.food_id ?? null,
      serving_id: aiItem.serving_id ?? null,
      serving_grams: servingGrams,
      source: aiItem.source,
      fdc_id: aiItem.fdc_id ?? aiItem.external_id ?? null,
      external_id: aiItem.external_id ?? aiItem.fdc_id ?? null,
      barcode: (aiItem as any).barcode ?? null,
      brand: aiItem.brand ?? null,
      is_verified: aiItem.is_verified,
      ...(aiItem.micronutrients ? { micronutrients: aiItem.micronutrients } : {}),
      ...foodClassificationFields(aiItem),
    };
    userEdited.current = true;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setItems(prev => {
      if (prev.some(it => it.name.toLowerCase() === aiItem.name.toLowerCase())) return prev;
      const next = [...prev, newItem];
      persistNow(next);
      return next;
    });
    showFoodSearchFeedback(aiItem.name, 'added');
    if (aiItem.source !== 'seed' && aiItem.source !== 'user' && aiItem.source !== 'fatsecret') {
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

  /** Build the current draft MealSuggestion from local state. Used by
   *  both the Save flow and the Save-as-Favorite chip so they always
   *  agree on what "the meal as the user sees it" actually is. */
  const buildDraftFromState = (): MealSuggestion => {
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
    return syncLegacyFieldsFromItems(finalMeal);
  };

  /** Run a save attempt (`onSave` or one branch of `onSaveRoutine`)
   *  under the savingRef lock. Closes only on success; on error keeps
   *  the modal open and surfaces an alert so the user can retry or
   *  discard, instead of silently losing the edit. */
  const runGuardedSave = async (
    save: () => void | Promise<void>,
    failureTitle = 'Could not save meal',
  ): Promise<void> => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await save();
      onClose();
    } catch (err: any) {
      hapticWarning();
      Alert.alert(failureTitle, err?.message ?? String(err ?? 'Try again in a moment.'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const handleSave = async () => {
    // Synchronous double-tap guard — fires before the empty-meal Alert
    // so an empty-meal warning + a real save can't both be in flight.
    if (savingRef.current || externalMutationPending) return;
    // Empty-meal guard. Zero-calorie foods are still real food rows
    // (coffee, water, diet soda), so only block meals with no items.
    // Only runs on SAVE — cancel skips this so the user can always bail
    // out of a mistaken add.
    if (items.length === 0) {
      hapticWarning();
      Alert.alert(
        'Meal is empty',
        'Add at least one food before saving, or cancel to discard.',
      );
      return;
    }
    hapticSuccess();
    const synced = buildDraftFromState();

    if (isRoutineEdit && onSaveRoutine) {
      const originalMealWithItems = ensureItems(meal);
      const originalSignature = routineContentSignature(
        originalMealWithItems.meal,
        originalMealWithItems.items ?? [],
        originalMealWithItems.instructions ?? null,
      );
      const draftSignature = routineContentSignature(mealName, items, instructions);
      if (originalSignature === draftSignature) {
        await runGuardedSave(() => onSaveRoutine(synced, 'today'), 'Could not save routine');
        return;
      }
      // Routine-scope prompt — the whole point of the detach model.
      // "Just today" is the default / destructive-styled option so the
      // user doesn't accidentally change every day with a tap. The Alert
      // callbacks each route through `runGuardedSave` so a second
      // tap-through can't trigger a parallel save.
      Alert.alert(
        'Save changes',
        'This meal is part of a routine that appears on every day. Apply your edit to just today, or update the routine for every day going forward?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Just today',
            onPress: () => { void runGuardedSave(() => onSaveRoutine(synced, 'today'), 'Could not save routine'); },
          },
          {
            text: 'Every day',
            onPress: () => { void runGuardedSave(() => onSaveRoutine(synced, 'all'), 'Could not save routine'); },
          },
        ],
      );
      return;
    }

    await runGuardedSave(() => onSave(synced));
  };

  /** Save-as-Favorite chip. Builds the draft from CURRENT state (not
   *  the original `meal` prop) and routes it to the parent — which
   *  owns the saved-meal write so the favorites library + optimistic
   *  caches stay coherent. Guarded by its own ref so a double-tap
   *  collapses to one write. */
  const handleSaveAsFavorite = async () => {
    if (!onSaveAsMeal) return;
    if (savingFavoriteRef.current || savingRef.current || externalMutationPending) return;
    if (items.length === 0) {
      hapticWarning();
      Alert.alert('Nothing to save', 'Add at least one food before saving as a favorite.');
      return;
    }
    savingFavoriteRef.current = true;
    setSavingFavorite(true);
    try {
      const draft = buildDraftFromState();
      await onSaveAsMeal(draft);
    } catch (err: any) {
      hapticWarning();
      Alert.alert('Could not save favorite', err?.message ?? String(err ?? 'Try again in a moment.'));
    } finally {
      savingFavoriteRef.current = false;
      setSavingFavorite(false);
    }
  };

  // Cancel never goes through the save pipeline — no empty-meal prompt,
  // no onSave. Just dismiss. This is deliberate: if the user opened the
  // modal by accident (or added foods they immediately regret) the X
  // button should always exit without a fight. The one exception:
  // mid-save we ignore Cancel, so a tap can't close the modal while a
  // pending mutation is still racing in the background.
  const handleCancel = () => {
    if (savingRef.current) return;
    onClose();
  };

  // Meals are DB-owned. Draft edits stay in modal state until Save, so we
  // never create a cache-only meal that can drift from backend history.
  const persistNow = (updatedItems: MealItem[]) => {
    void updatedItems;
  };

  // Legacy auto-persist intentionally disabled. Save is the only mutation
  // boundary, and the parent save path writes through backend/day-state.

  const renderSearchResultRow = (item: FoodSearchResult, idx: number, testIDPrefix: string) => {
    const badgeLabel = badgeLabelForSource(item.source);
    const badgeTone = badgeToneForSource(item.source);
    const alreadyInMeal = items.some(it => it.name.toLowerCase() === item.name.toLowerCase());
    const iconSpec = getFoodIconSpec(item.name);
    return (
      <TouchableOpacity
        testID={`${testIDPrefix}-${idx}`}
        key={`${testIDPrefix}-${item.source ?? ''}-${item.name}-${idx}`}
        style={s.aiResultRow}
        onPress={() => addAiFood(item)}>
        <View style={[s.searchFoodIcon, { backgroundColor: iconSpec.color + '18' }]}>
          <MaterialCommunityIcons name={iconSpec.name} size={18} color={iconSpec.color} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Text style={s.aiResultName}>{item.name}</Text>
            {badgeLabel && badgeTone ? (
              <View style={[
                s.sourceBadge,
                badgeTone === 'verified' ? s.sourceBadgeVerified
                  : badgeTone === 'label' ? s.sourceBadgeLabel
                  : badgeTone === 'estimate' ? s.sourceBadgeEstimate
                  : s.sourceBadgeCustom,
              ]}>
                <Text style={[
                  s.sourceBadgeText,
                  badgeTone === 'verified' ? s.sourceBadgeTextVerified
                    : badgeTone === 'label' ? s.sourceBadgeTextLabel
                    : badgeTone === 'estimate' ? s.sourceBadgeTextEstimate
                    : s.sourceBadgeTextCustom,
                ]}>
                  {badgeLabel}
                </Text>
              </View>
            ) : null}
          </View>
          <Text style={s.aiResultServing}>{item.serving}</Text>
          <Text style={s.aiResultMacros}>
            {Math.round(item.calories)} cal · {Math.round(item.protein)}g pro · {Math.round(item.carbs)}g carbs · {Math.round(item.fat)}g fat
          </Text>
        </View>
        <Text style={[s.aiResultAdd, alreadyInMeal && s.aiResultAdded]}>
          {alreadyInMeal ? 'Added' : '+ Add'}
        </Text>
      </TouchableOpacity>
    );
  };

  const renderFavoriteCopyCard = (favorite: FavoriteMealCopy, idx: number, variant: 'carousel' | 'carouselStack' | 'sheet' = 'carousel') => {
    const totals = favoriteMealTotals(favorite);
    const itemCount = favorite.items?.length ?? 0;
    const loggedCount = Number(favorite.times_logged ?? 0);
    const displayName = favorite.name || 'Favorite meal';
    const metaParts = [
      `${itemCount} item${itemCount === 1 ? '' : 's'}`,
      ...(loggedCount > 0 ? [`logged ${Math.round(loggedCount)}x`] : []),
      ...(favorite.source_owner_username ? [`from @${favorite.source_owner_username}`] : []),
    ];

    return (
      <View
        key={`favorite-copy-${favorite.id ?? `${displayName}-${idx}`}`}
        style={[
          s.favoriteCard,
          variant === 'carouselStack' && s.favoriteCarouselStackCard,
          variant === 'sheet' && s.favoriteSheetCard,
        ]}
      >
        <TouchableOpacity
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={`Copy ${displayName} into this meal`}
          onPress={() => copyFavoriteIntoEditor(favorite)}
        >
          <View style={s.favoriteCardTop}>
            <MealThumbnail meal={favorite} size="sm" />
            <View style={s.favoriteCardText}>
              <Text style={s.favoriteCardName} numberOfLines={1}>
                {displayName}
              </Text>
              <Text style={s.favoriteCardMacros} numberOfLines={1}>
                {Math.round(totals.calories)} cal · {Math.round(totals.protein)}g protein
              </Text>
              <Text style={s.favoriteCardMeta} numberOfLines={1}>
                {metaParts.join(' · ')}
              </Text>
            </View>
          </View>
        </TouchableOpacity>
        <View style={s.favoriteCardActions}>
          <TouchableOpacity
            activeOpacity={0.78}
            accessibilityRole="button"
            accessibilityLabel={`Copy ${displayName}`}
            onPress={() => copyFavoriteIntoEditor(favorite)}
            style={s.favoriteCardCopyButton}
          >
            <Ionicons name="add-circle" size={15} color={colors.primary} />
            <Text style={s.favoriteCardCopyText}>Copy</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <>
    <Modal visible={visible} animationType="slide" onRequestClose={() => { handleCancel(); }}>
      <View style={s.container}>

        {/* Header */}
        <View style={s.header}>
          <TextInput
            style={s.headerTitleInput}
            value={mealName}
            onChangeText={setMealName}
            placeholder={isNewMeal ? 'Add Meal' : mode === 'template' ? 'Edit Favorite' : 'Edit Meal'}
            placeholderTextColor={colors.textMuted}
            returnKeyType="done"
            onSubmitEditing={() => { setNameFocused(false); Keyboard.dismiss(); }}
            onFocus={() => setNameFocused(true)}
            onBlur={() => setNameFocused(false)}
            accessibilityLabel="Meal name"
          />
        </View>

        {/* Standard meal-name presets — only while the name input is focused. */}
        {nameFocused && (
        <View style={s.nameChipsRow}>
          {['Breakfast', 'Lunch', 'Dinner', 'Snack'].map(label => {
            const active = mealName.trim().toLowerCase() === label.toLowerCase();
            return (
              <TouchableOpacity
                key={label}
                accessibilityRole="button"
                accessibilityLabel={`Use name ${label}`}
                onPress={() => setMealName(label)}
                style={[s.nameChip, active && s.nameChipActive]}>
                <Text style={[s.nameChipText, active && s.nameChipTextActive]}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        )}

        {foodSearchActive ? (
          <View style={s.searchModeBar}>
            <View style={s.searchModeIcon}>
              <Ionicons name="search-outline" size={17} color={colors.primary} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={s.searchModeTitle}>
                Add foods to {mealName.trim() || 'Meal'}
              </Text>
              <Text style={s.searchModeMeta}>
                {items.length} food{items.length === 1 ? '' : 's'} in this meal
              </Text>
            </View>
          </View>
        ) : (
          <>
        {/* Hero thumbnail removed — no upload path wired yet. Revisit
            once we have a photo-storage strategy (data URI vs object
            store). */}
        {/* Condensed chip row (time / favorite / recipe). */}
        <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6 }}>
          <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
            {mode === 'day' && (
              <TouchableOpacity
                onPress={() => {
                  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                  setMealTimeExpanded(prev => !prev);
                }}
                style={[s.metaChip, mealTimeExpanded && s.metaChipActive]}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                <Ionicons name="time-outline" size={12} color={mealTimeExpanded ? colors.primary : colors.textMuted} />
                <Text style={[s.metaChipText, mealTimeExpanded && { color: colors.primary }]}>{eatenAtLabel}</Text>
              </TouchableOpacity>
            )}
            {mode === 'day' && onSaveAsMeal && (
              <TouchableOpacity
                onPress={handleSaveAsFavorite}
                disabled={savingFavorite || saving || externalMutationPending}
                style={[s.metaChip, (savingFavorite || saving || externalMutationPending) && { opacity: 0.55 }]}
                accessibilityState={{ busy: savingFavorite, disabled: savingFavorite || saving || externalMutationPending }}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                {savingFavorite
                  ? <ActivityIndicator size="small" color={colors.primary} />
                  : <Ionicons name="star-outline" size={12} color={colors.textMuted} />}
                <Text style={s.metaChipText}>{savingFavorite ? 'Saving…' : 'Save Favorite'}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={() => {
                if (showInstructions) {
                  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                  setShowInstructions(false);
                  return;
                }
                fetchInstructions();
              }}
              disabled={instructionsLoading}
              style={[s.metaChip, showInstructions && s.metaChipActive]}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
              {instructionsLoading
                ? <ActivityIndicator size="small" color={colors.primary} />
                : <Ionicons name="restaurant-outline" size={12} color={showInstructions ? colors.primary : colors.textMuted} />}
              <Text style={[s.metaChipText, showInstructions && { color: colors.primary }]}>Recipe</Text>
            </TouchableOpacity>
            {canSuggestGapMeal && (
              <TouchableOpacity
                onPress={applyGapSuggestion}
                style={s.metaChip}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                <Ionicons name="sparkles-outline" size={12} color={colors.textMuted} />
                <Text style={s.metaChipText}>Generate</Text>
              </TouchableOpacity>
            )}
          </View>
          {mode === 'day' && mealTimeExpanded && (
            <View style={{ marginTop: 10 }}>
              <MealTimeSelector
                value={eatenAt}
                mealDate={dateKey}
                colors={colors}
                onChange={setEatenAt}
              />
            </View>
          )}
        </View>

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
              {' '}Changes update this favorite for future logs only. Meals already logged stay unchanged.
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
              {' '}Food edits ask for scope. Time edits save to this day.
            </Text>
          </View>
        )}

        {/* Generate Meal is now an inline chip in the meta row above. */}

        {/* Recipe panel — collapsible. Triggered from the chip row above. */}
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
              <Text style={{ fontSize: 11, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.5 }}>RECIPE</Text>
              <TouchableOpacity onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setShowInstructions(false); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="chevron-up" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <Text style={{ fontSize: 13, color: colors.textPrimary, lineHeight: 19 }}>{instructions}</Text>
          </View>
        )}

        {/* Macros — donuts show this meal against the day's targets. */}
        <View style={{
          backgroundColor: colors.surface,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
          paddingTop: 4,
          paddingBottom: 8,
        }}>
          <MacroDonutRow
            themeName={themeName}
            accent={colors.accent}
            size="compact"
            calories={{ actual: mealMacros.calories, target: nutritionPlan.targets?.calories ?? 0 }}
            protein={{ actual: mealMacros.protein, target: nutritionPlan.targets?.protein ?? 0 }}
            carbs={{ actual: mealMacros.carbs, target: nutritionPlan.targets?.carbs ?? 0 }}
            fat={{ actual: mealMacros.fat, target: nutritionPlan.targets?.fat ?? 0 }}
          />
        </View>
          </>
        )}

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

            {authToken && !foodSearchActive && (
              <>
                <View style={s.captureActionsRow}>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Scan barcode"
                    style={s.captureActionButton}
                    disabled={scanLoading}
                    onPress={() => setBarcodeScanning(true)}>
                    <Ionicons name="barcode-outline" size={16} color={colors.primary} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Take food photo"
                    style={s.captureActionButton}
                    disabled={scanLoading}
                    onPress={() => pickAndScan('camera')}>
                    {scanLoading
                      ? <ActivityIndicator size="small" color={colors.primary} />
                      : <Ionicons name="camera-outline" size={16} color={colors.primary} />}
                  </TouchableOpacity>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Choose food photo from library"
                    style={s.captureActionButton}
                    disabled={scanLoading}
                    onPress={() => pickAndScan('library')}>
                    <Ionicons name="images-outline" size={16} color={colors.primary} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={speechLoading ? 'Transcribing meal' : isRecording ? 'Stop recording meal' : 'Describe meal with voice'}
                    onPress={handleMicToggle}
                    disabled={speechLoading}
                    style={[
                      s.captureActionButton,
                      isRecording
                        ? s.captureActionButtonRecording
                        : speechLoading
                          ? s.captureActionButtonBusy
                          : s.captureActionButtonPrimary,
                    ]}
                  >
                    {speechLoading ? (
                      <ActivityIndicator size="small" color={colors.primary} />
                    ) : (
                      <Ionicons
                        name={isRecording ? 'stop-circle' : 'mic'}
                        size={16}
                        color={isRecording ? colors.error : colors.primary}
                      />
                    )}
                  </TouchableOpacity>
                </View>
                {pendingFoodScan && (
                  <View style={s.photoScanPanel}>
                    <View style={s.photoScanPreview}>
                      {pendingFoodScan.imageUri ? (
                        <Image source={{ uri: pendingFoodScan.imageUri }} style={s.photoScanPreviewImage} resizeMode="cover" />
                      ) : (
                        <View style={s.photoScanPreviewFallback}>
                          <Ionicons name="image-outline" size={28} color="rgba(255,255,255,0.72)" />
                        </View>
                      )}
                      <ScanHudOverlay
                        mode="food"
                        active={scanLoading}
                        status={scanLoading ? undefined : 'Ready for AI scan'}
                        accentColor="#FFFFFF"
                        textColor="#FFFFFF"
                        mutedTextColor="rgba(255,255,255,0.76)"
                        surfaceColor="rgba(3,7,18,0.48)"
                        compact
                        reticleWidth={204}
                        reticleHeight={106}
                        style={s.photoScanHud}
                      />
                    </View>
                    <View style={s.photoScanHeader}>
                      {pendingFoodScan.imageUri ? (
                        <Image source={{ uri: pendingFoodScan.imageUri }} style={s.photoScanThumb} resizeMode="cover" />
                      ) : (
                        <View style={[s.photoScanThumb, s.photoScanThumbFallback]}>
                          <Ionicons name="image-outline" size={20} color={colors.textMuted} />
                        </View>
                      )}
                      <View style={s.photoScanCopy}>
                        <Text style={s.photoScanTitle}>Photo ready</Text>
                        <Text style={s.photoScanHelp} numberOfLines={2}>
                          Add context for this scan if the photo needs it.
                        </Text>
                      </View>
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel="Clear selected food photo"
                        style={s.photoScanClose}
                        disabled={scanLoading}
                        onPress={() => {
                          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                          setPendingFoodScan(null);
                          setScanContext('');
                        }}>
                        <Ionicons name="close" size={18} color={colors.textSecondary} />
                      </TouchableOpacity>
                    </View>
                    <Text style={s.photoScanLabel}>Photo context <Text style={s.photoScanOptional}>optional</Text></Text>
                    <TextInput
                      style={s.photoScanInput}
                      value={scanContext}
                      onChangeText={setScanContext}
                      placeholder="e.g. large portion · cooked in olive oil · restaurant name"
                      placeholderTextColor={colors.textMuted}
                      editable={!scanLoading}
                      returnKeyType="done"
                      onSubmitEditing={() => Keyboard.dismiss()}
                    />
                    <View style={s.photoScanActions}>
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel="Cancel food photo scan"
                        style={s.photoScanSecondaryButton}
                        disabled={scanLoading}
                        onPress={() => {
                          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                          setPendingFoodScan(null);
                          setScanContext('');
                        }}>
                        <Text style={s.photoScanSecondaryText}>Cancel</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel="Scan selected food photo"
                        style={[s.photoScanPrimaryButton, scanLoading && { opacity: 0.65 }]}
                        disabled={scanLoading}
                        onPress={() => scanPendingFoodPhoto(pendingFoodScan)}>
                        {scanLoading ? (
                          <ActivityIndicator size="small" color={getContrastingTextColor(colors.primary)} />
                        ) : (
                          <>
                            <Ionicons name="sparkles-outline" size={16} color={getContrastingTextColor(colors.primary)} />
                            <Text style={s.photoScanPrimaryText}>Scan photo</Text>
                          </>
                        )}
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
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
                ref={searchInputRef}
                testID="meal-edit-food-search"
                style={[s.searchInput, { flex: 1, marginBottom: 0 }]}
                value={search}
                onChangeText={(t) => { setFoodSearchDismissed(false); setSearch(t); setAiResults([]); setSearchFeedback(null); if (barcodeFallback) setBarcodeFallback(null); }}
                placeholder="Search foods..."
                placeholderTextColor={colors.textMuted}
                returnKeyType="search"
                onFocus={() => { setFoodSearchDismissed(false); setFoodSearchFocused(true); }}
                onBlur={() => setFoodSearchFocused(false)}
                onSubmitEditing={() => Keyboard.dismiss()}
              />
              {search.length > 0 && (
                <TouchableOpacity style={s.clearBtn} onPress={() => { setFoodSearchDismissed(false); setSearch(''); setAiResults([]); setSearchFeedback(null); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="close-circle" size={18} color={colors.textMuted} />
                </TouchableOpacity>
              )}
              {catalogSearchLoading && (
                <ActivityIndicator size="small" color={colors.primary} />
              )}
              {authToken && (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Search foods with AI"
                  testID="meal-edit-ai-food-search"
                  activeOpacity={0.78}
                  disabled={!aiSearchQueryReady || aiSearchLoading}
                  onPress={() => handleAiSearch()}
                  style={[
                    s.aiSearchInlineBtn,
                    !aiSearchQueryReady && s.aiSearchInlineBtnDisabled,
                  ]}>
                  {aiSearchLoading ? (
                    <ActivityIndicator size="small" color={aiSearchButtonColor} />
                  ) : (
                    <Ionicons name="sparkles-outline" size={14} color={aiSearchButtonColor} />
                  )}
                  <Text
                    style={[
                      s.aiSearchInlineBtnText,
                      !aiSearchQueryReady && s.aiSearchInlineBtnTextDisabled,
                    ]}>
                    AI Search
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            {foodSearchActive && items.length > 0 && (
              <View style={s.searchCurrentFoodsCard}>
                <View style={s.searchCurrentFoodsHeader}>
                  <Text style={s.searchCurrentFoodsTitle}>Current Foods</Text>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="View and edit current foods in this meal"
                    testID="meal-edit-view-current-foods"
                    onPress={exitFoodSearchToEdit}
                    activeOpacity={0.75}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={s.searchCurrentFoodsActionPill}>
                    <Ionicons name="create-outline" size={13} color={colors.primary} />
                    <Text style={s.searchCurrentFoodsAction}>View / Edit</Text>
                  </TouchableOpacity>
                </View>
                {searchFeedback && (
                  <View
                    style={[
                      s.searchFeedbackPill,
                      searchFeedback.status === 'duplicate' && s.searchFeedbackPillMuted,
                    ]}>
                    <Ionicons
                      name={searchFeedback.status === 'added' ? 'checkmark-circle' : 'information-circle-outline'}
                      size={13}
                      color={searchFeedback.status === 'added' ? colors.primary : colors.textSecondary}
                    />
                    <Text
                      numberOfLines={1}
                      style={[
                        s.searchFeedbackText,
                        searchFeedback.status === 'duplicate' && s.searchFeedbackTextMuted,
                      ]}>
                      {searchFeedback.status === 'added'
                        ? `Added ${searchFeedback.name}`
                        : `${searchFeedback.name} is already in this meal`}
                    </Text>
                  </View>
                )}
                <View style={s.searchCurrentFoodChips}>
                  {items.slice(-4).reverse().map((it, idx) => {
                    const highlighted = searchFeedback?.status === 'added'
                      && it.name.toLowerCase() === searchFeedback.name.toLowerCase();
                    return (
                      <View
                        key={`${it.name}-${items.length - idx}`}
                        style={[s.searchCurrentFoodChip, highlighted && s.searchCurrentFoodChipActive]}>
                        <Text
                          numberOfLines={1}
                          style={[s.searchCurrentFoodChipText, highlighted && s.searchCurrentFoodChipTextActive]}>
                          {it.name}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              </View>
            )}

            {aiRemoteResults.length > 0 && (
              <View style={{ marginBottom: 16 }}>
                <Text style={s.sectionLabel}>AI Results</Text>
                {aiRemoteResults.map((item, idx) => renderSearchResultRow(item, idx, 'meal-edit-ai-search-result'))}
              </View>
            )}

            {localSearchResults.length > 0 && (
              <View style={{ marginBottom: 16 }}>
                <Text style={s.sectionLabel}>From Your Foods</Text>
                {localSearchResults.map((item, idx) => renderSearchResultRow(item, idx, 'meal-edit-local-search-result'))}
                {authToken && search.trim().length > 1 && aiResults.length === 0 && remoteSearchResults.length === 0 && !catalogSearchLoading && !aiSearchLoading && (
                  <TouchableOpacity
                    style={s.alsoAskAiBtn}
                    onPress={() => handleAiSearch({ append: true })}>
                    <Ionicons name="sparkles-outline" size={14} color={colors.primary} />
                    <Text style={s.alsoAskAiText}>Ask AI for more options</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {catalogSearchError ? (
              <Text style={s.emptyText}>{catalogSearchError}</Text>
            ) : null}

            {search.length > 1 && catalogSearchLoading && localSearchResults.length === 0 && remoteSearchResults.length === 0 && (
              <Text style={s.emptyText}>Searching foods...</Text>
            )}

            {search.length > 1 && !catalogSearchLoading && !aiSearchLoading && localSearchResults.length === 0 && remoteSearchResults.length === 0 && (
              <Text style={s.emptyText}>No matching foods.</Text>
            )}

            {catalogRemoteResults.length > 0 && (() => {
              const hasVerified = catalogRemoteResults.some(r => r.source !== 'ai');
              return (
              <View style={{ marginBottom: 16 }}>
                <Text style={s.sectionLabel}>{localSearchResults.length > 0 || aiRemoteResults.length > 0 ? 'More Results' : 'Search Results'}</Text>
                {catalogRemoteResults.map((item, idx) => renderSearchResultRow(item, idx, 'meal-edit-search-result'))}
                {hasVerified && aiResults.length === 0 && !aiSearchLoading && (
                  <TouchableOpacity
                    style={s.alsoAskAiBtn}
                    onPress={() => handleAiSearch({ append: true })}>
                    <Ionicons name="sparkles-outline" size={14} color={colors.primary} />
                    <Text style={s.alsoAskAiText}>Also ask AI for more options</Text>
                  </TouchableOpacity>
                )}
              </View>
              );
            })()}

            {/* Current foods — structured editable rows (header removed). */}
            {!foodSearchActive && items.length === 0 && (
              <Text style={s.emptyText}>No foods added yet</Text>
            )}
            {!foodSearchActive && items.length > 0 && (
              <View style={s.mealScaleRow}>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Scale entire meal to half"
                  onPress={() => scaleEntireMeal(0.5)}
                  style={s.mealScaleButton}>
                  <Ionicons name="remove-circle-outline" size={14} color={colors.primary} />
                  <Text style={s.mealScaleText}>Ate half</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Double entire meal"
                  onPress={() => scaleEntireMeal(2)}
                  style={s.mealScaleButton}>
                  <Ionicons name="add-circle-outline" size={14} color={colors.primary} />
                  <Text style={s.mealScaleText}>Double</Text>
                </TouchableOpacity>
              </View>
            )}
            {!foodSearchActive && items.map((it, idx) => {
              const iconSpec = getFoodIconSpec(it.name);
              return (
              <View key={`${it.name}-${idx}`} style={s.currentFoodRow}>
                <View style={[s.currentFoodIcon, { backgroundColor: iconSpec.color + '18' }]}>
                  <MaterialCommunityIcons name={iconSpec.name} size={18} color={iconSpec.color} />
                </View>
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
                  <View style={s.currentFoodMacroRow}>
                    <View style={[s.currentFoodMacroPill, { backgroundColor: colors.accent + '14', borderColor: colors.accent + '44' }]}>
                      <Text style={[s.currentFoodMacroText, { color: colors.accent }]}>{Math.round(it.calories)} cal</Text>
                    </View>
                    <View style={[s.currentFoodMacroPill, { backgroundColor: colors.primary + '14', borderColor: colors.primary + '44' }]}>
                      <Text style={[s.currentFoodMacroText, { color: colors.primary }]}>{Math.round(it.protein)}g P</Text>
                    </View>
                    <View style={[s.currentFoodMacroPill, { backgroundColor: '#F59E0B14', borderColor: '#F59E0B44' }]}>
                      <Text style={[s.currentFoodMacroText, { color: '#B45309' }]}>{Math.round(it.carbs)}g C</Text>
                    </View>
                    <View style={[s.currentFoodMacroPill, { backgroundColor: '#A78BFA14', borderColor: '#A78BFA44' }]}>
                      <Text style={[s.currentFoodMacroText, { color: '#7C3AED' }]}>{Math.round(it.fat)}g F</Text>
                    </View>
                  </View>
                </View>
                <TouchableOpacity
                  onPress={() => removeItem(idx)}
                  style={s.removeBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="remove-circle-outline" size={20} color={colors.error ?? '#EF4444'} />
                </TouchableOpacity>
              </View>
              );
            })}

            {!foodSearchActive && favoriteMealChoices.length > 0 && (
              <View style={s.favoriteCarouselSection}>
                <View style={s.favoriteSectionHeader}>
                  <Text style={s.favoriteSectionTitle}>FAVORITES</Text>
                  <Text style={s.favoriteSectionCount}>{favoriteMealChoices.length}</Text>
                </View>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  decelerationRate="fast"
                  contentContainerStyle={s.favoriteCarouselContent}
                >
                  {favoriteMealColumns.map((column, columnIdx) => (
                    <View key={`favorite-column-${columnIdx}`} style={s.favoriteCarouselColumn}>
                      {column.map((template, rowIdx) => renderFavoriteCopyCard(template, columnIdx * 2 + rowIdx, 'carouselStack'))}
                    </View>
                  ))}
                </ScrollView>
              </View>
            )}

          </ScrollView>
          <View style={s.bottomActionBar}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Cancel meal edits"
              accessibilityState={{ disabled: saving }}
              onPress={handleCancel}
              disabled={saving}
              activeOpacity={0.78}
              style={[s.bottomCancelButton, saving && { opacity: 0.55 }]}>
              <Text style={s.bottomCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={isNewMeal ? 'Save meal' : 'Save meal changes'}
              accessibilityState={{ busy: saving, disabled: saving || externalMutationPending }}
              onPress={handleSave}
              disabled={saving || externalMutationPending}
              activeOpacity={0.84}
              style={[s.bottomSaveButton, (saving || externalMutationPending) && { opacity: 0.7 }]}>
              {saving
                ? <ActivityIndicator size="small" color={getContrastingTextColor(colors.primary)} />
                : <Text style={s.bottomSaveText}>{isNewMeal ? 'Save Meal' : 'Save Changes'}</Text>}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </View>
      <BarcodeScannerModal
          visible={barcodeScanning}
          onClose={() => setBarcodeScanning(false)}
          onScan={handleBarcodeScan}
          processing={scanLoading && barcodeScanning}
        />
    </Modal>
    <Modal
      visible={favoritePickerOpen && visible}
      transparent
      animationType="slide"
      onRequestClose={() => setFavoritePickerOpen(false)}
    >
      <View style={s.favoriteSheetBackdrop}>
        <View style={s.favoriteSheet}>
          <View style={s.favoriteHeader}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.favoriteTitle}>Copy from Favorites</Text>
              <Text style={s.favoriteSubtitle}>Copies the foods into this meal so you can edit before saving.</Text>
            </View>
            <TouchableOpacity onPress={() => setFavoritePickerOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <ScrollView showsVerticalScrollIndicator={false}>
            {favoriteMealChoices.length === 0 ? (
              <View style={s.favoriteEmpty}>
                <Ionicons name="star-outline" size={28} color={colors.textMuted} />
                <Text style={s.favoriteEmptyTitle}>No favorites yet</Text>
                <Text style={s.favoriteEmptyBody}>Save a meal as a favorite first, then it will show up here.</Text>
              </View>
            ) : (
              <View style={s.favoriteSheetList}>
                {favoriteMealChoices.map((favorite, idx) => renderFavoriteCopyCard(favorite, idx, 'sheet'))}
              </View>
            )}
          </ScrollView>
        </View>
      </View>
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
                    ...foodClassificationFields(it),
                  } as any));
                userEdited.current = true;
                setItems(prev => [...prev, ...mapped]);
                setSpeechReview(null);
                exitFoodSearchToEdit();
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
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 16, paddingTop: Platform.OS === 'ios' ? 72 : 56, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  headerCenter: { alignItems: 'center', flex: 1 },
  title:      { fontSize: 16, fontWeight: '700', color: colors.textPrimary },
  headerTitleInput: {
    flex: 1,
    minWidth: 0,
    textAlign: 'center',
    marginHorizontal: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: colors.surfaceRaised,
    fontSize: 18,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  nameChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 16,
    marginTop: 8,
    marginBottom: 2,
  },
  nameChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  nameChipActive: {
    borderColor: colors.primary + '88',
    backgroundColor: colors.primary + '18',
  },
  nameChipText: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  nameChipTextActive: { color: colors.primary },
  metaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  metaChipActive: {
    backgroundColor: colors.primary + '14',
    borderColor: colors.primary + '66',
  },
  metaChipText: { fontSize: 11, fontWeight: '700', color: colors.textMuted },
  cancelText: { fontSize: 15, color: colors.textSecondary },
  saveText:   { fontSize: 15, fontWeight: '700', color: colors.primary },
  searchModeBar: {
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 6,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  searchModeIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.primary + '16',
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchModeTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  searchModeMeta: {
    marginTop: 1,
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
  },
  gapButton: {
    alignSelf: 'flex-start',
    marginHorizontal: 16,
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: colors.primary + '14',
    borderWidth: 1,
    borderColor: colors.primary + '55',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
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
    fontSize: 12,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  gapButtonMeta: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
  },
  scroll:        { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 48 },
  bottomActionBar: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 28 : 16,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  bottomCancelButton: {
    flex: 1,
    minHeight: 50,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomCancelText: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.textSecondary,
  },
  bottomSaveButton: {
    flex: 2,
    minHeight: 50,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.22,
    shadowRadius: 7,
    elevation: 3,
  },
  bottomSaveText: {
    fontSize: 14,
    fontWeight: '900',
    color: getContrastingTextColor(colors.primary),
  },

  sectionLabel: {
    fontSize: 11, fontWeight: '700', color: colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10,
  },
  emptyText: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: 'center',
    paddingVertical: 28,
    marginBottom: 16,
  },
  captureActionsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  captureActionButton: {
    flex: 1,
    height: 38,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureActionButtonPrimary: {
    backgroundColor: colors.primary + '10',
    borderColor: colors.primary + '55',
  },
  captureActionButtonBusy: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
  },
  captureActionButtonRecording: {
    backgroundColor: colors.error + '14',
    borderColor: colors.error + '88',
  },
  photoScanPanel: {
    marginTop: 2,
    marginBottom: 14,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary + '55',
    backgroundColor: colors.primary + '0D',
  },
  photoScanPreview: {
    height: 168,
    marginBottom: 12,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: '#050A14',
    borderWidth: 1,
    borderColor: colors.primary + '33',
  },
  photoScanPreviewImage: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  photoScanPreviewFallback: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#101827',
  },
  photoScanHud: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: radius.md,
  },
  photoScanHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  photoScanThumb: {
    width: 52,
    height: 52,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  photoScanThumbFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  photoScanCopy: { flex: 1, minWidth: 0 },
  photoScanTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.textPrimary,
    marginBottom: 2,
  },
  photoScanHelp: {
    fontSize: 12,
    lineHeight: 16,
    color: colors.textSecondary,
  },
  photoScanClose: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  photoScanLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.textSecondary,
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0,
  },
  photoScanOptional: {
    fontWeight: '700',
    color: colors.textMuted,
  },
  photoScanInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 14,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
  },
  photoScanActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  photoScanSecondaryButton: {
    flex: 1,
    minHeight: 42,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  photoScanSecondaryText: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.textSecondary,
  },
  photoScanPrimaryButton: {
    flex: 1,
    minHeight: 42,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
    backgroundColor: colors.primary,
  },
  photoScanPrimaryText: {
    fontSize: 13,
    fontWeight: '800',
    color: getContrastingTextColor(colors.primary),
  },
  mealScaleRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  mealScaleButton: {
    flex: 1,
    minHeight: 38,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary + '44',
    backgroundColor: colors.primary + '10',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  mealScaleText: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.primary,
  },

  currentFoodRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    padding: 12, marginBottom: 8,
  },
  currentFoodIcon: {
    width: 34,
    height: 34,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
    marginTop: 2,
  },
  currentFoodInfo:   { flex: 1, minWidth: 0 },
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
  currentFoodMacroRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 6,
  },
  currentFoodMacroPill: {
    minHeight: 26,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  currentFoodMacroText: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '900',
    fontVariant: ['tabular-nums'] as any,
  },
  mealNameBlock: {
    marginTop: 4,
    marginBottom: 2,
  },
  mealNameLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 7,
  },
  mealNameInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
    fontWeight: '700',
    color: colors.textPrimary,
    backgroundColor: colors.surface,
  },
  favoriteCarouselSection: {
    marginTop: 24,
  },
  favoriteSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  favoriteSectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textMuted,
    letterSpacing: 0,
  },
  favoriteSectionCount: {
    fontSize: 10,
    color: colors.textMuted,
  },
  favoriteCarouselContent: {
    paddingRight: 16,
  },
  favoriteCarouselColumn: {
    width: 210,
    gap: 8,
    marginRight: 8,
  },
  favoriteCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 12,
    marginRight: 8,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 180,
    maxWidth: 210,
  },
  favoriteCarouselStackCard: {
    width: '100%',
    minWidth: 0,
    maxWidth: '100%',
    marginRight: 0,
  },
  favoriteSheetCard: {
    marginRight: 0,
    marginBottom: 8,
    minWidth: 0,
    maxWidth: '100%',
    width: '100%',
  },
  favoriteCardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  favoriteCardText: {
    flex: 1,
    minWidth: 0,
  },
  favoriteCardName: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  favoriteCardMacros: {
    fontSize: 10,
    color: colors.textMuted,
    marginTop: 2,
  },
  favoriteCardMeta: {
    fontSize: 10,
    color: colors.textMuted,
    marginTop: 1,
  },
  favoriteCardActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
  },
  favoriteCardCopyButton: {
    flex: 1,
    minHeight: 34,
    borderRadius: 10,
    backgroundColor: colors.primary + '16',
    borderWidth: 1,
    borderColor: colors.primary + '55',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  favoriteCardCopyText: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.primary,
  },
  favoriteSheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  favoriteSheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 16,
    paddingBottom: 30,
    maxHeight: '76%',
  },
  favoriteHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 12,
  },
  favoriteTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  favoriteSubtitle: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 3,
    lineHeight: 15,
  },
  favoriteEmpty: {
    paddingVertical: 28,
    alignItems: 'center',
  },
  favoriteEmptyTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.textPrimary,
    marginTop: 8,
  },
  favoriteEmptyBody: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: 4,
    lineHeight: 17,
  },
  favoriteSheetList: {
    paddingBottom: 4,
  },
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
  searchCurrentFoodsCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
    marginBottom: 14,
    gap: 8,
  },
  searchCurrentFoodsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  searchCurrentFoodsTitle: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  searchCurrentFoodsActionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.full,
    backgroundColor: colors.primary + '18',
    borderWidth: 1,
    borderColor: colors.primary + '55',
  },
  searchCurrentFoodsAction: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.primary,
    letterSpacing: 0.3,
  },
  searchFeedbackPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    maxWidth: '100%',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: radius.full,
    backgroundColor: colors.primary + '16',
    borderWidth: 1,
    borderColor: colors.primary + '55',
  },
  searchFeedbackPillMuted: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
  },
  searchFeedbackText: {
    flexShrink: 1,
    fontSize: 11,
    fontWeight: '800',
    color: colors.primary,
  },
  searchFeedbackTextMuted: {
    color: colors.textSecondary,
  },
  searchCurrentFoodChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  searchCurrentFoodChip: {
    maxWidth: '48%',
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchCurrentFoodChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  searchCurrentFoodChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  searchCurrentFoodChipTextActive: {
    color: getContrastingTextColor(colors.primary),
  },
  clearBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  clearBtnText: { fontSize: 13, color: colors.textSecondary, fontWeight: '700' },

  // AI search — inline button next to search input
  aiSearchInlineBtn: {
    flexDirection: 'row',
    gap: 5,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
    paddingVertical: 10, paddingHorizontal: 14,
    alignItems: 'center', justifyContent: 'center',
    minHeight: 44,
  },
  aiSearchInlineBtnDisabled: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  aiSearchInlineBtnText: { fontSize: 13, fontWeight: '700', color: getContrastingTextColor(colors.primary) },
  aiSearchInlineBtnTextDisabled: { color: colors.textMuted },
  aiResultRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.primary + '44',
    padding: 12, marginBottom: 8,
  },
  searchFoodIcon: {
    width: 34,
    height: 34,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  aiResultName:    { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  aiResultServing: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  aiResultMacros:  { fontSize: 11, color: colors.textSecondary, marginTop: 2 },
  aiResultAdd:     { fontSize: 13, fontWeight: '700', color: colors.primary, marginLeft: 8 },
  aiResultAdded:   { color: colors.textMuted },

  sourceBadge: {
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm ?? 4,
    borderWidth: 1,
  },
  sourceBadgeVerified: { backgroundColor: '#10B98122', borderColor: '#10B98177' },
  sourceBadgeLabel: { backgroundColor: '#0EA5E922', borderColor: '#0EA5E977' },
  sourceBadgeEstimate: { backgroundColor: colors.primary + '22', borderColor: colors.primary + '77' },
  sourceBadgeCustom: { backgroundColor: colors.surfaceRaised, borderColor: colors.border },
  sourceBadgeText: { fontSize: 9, fontWeight: '800', letterSpacing: 0 },
  sourceBadgeTextVerified: { color: '#059669' },
  sourceBadgeTextLabel: { color: '#0284C7' },
  sourceBadgeTextEstimate: { color: colors.primary },
  sourceBadgeTextCustom: { color: colors.textSecondary },

  alsoAskAiBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, marginTop: 4,
    borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.primary + '55',
    backgroundColor: colors.primary + '11',
  },
  alsoAskAiText: { fontSize: 12, fontWeight: '700', color: colors.primary },
}); }
