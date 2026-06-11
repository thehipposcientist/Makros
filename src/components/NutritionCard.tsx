import { memo, useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, ScrollView, Platform, UIManager, Animated, ActivityIndicator, ImageBackground, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { getFoodIconSpec } from '../utils/foodIcon';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import { configureExpandAnimation } from '../utils/layoutAnim';
import { DailyNutritionPlan, MealSuggestion, AppThemeName, UserProfile, type MealItem } from '../types';
import { elevations, getContrastingTextColor, getTheme, radius, typography } from '../constants/theme';
import { ensureItems, formatItemAmount, macroTotalsFromMeal, type MealMacroTotals } from '../utils/mealItems';
import { computeProteinBreakdown } from '../utils/proteinBreakdown';
import { computeDayInsights } from '../utils/nutritionLayers';
import { computeNutritionScore, computePlanGutHealth, type NutritionScoreBreakdownItem } from '../utils/nutritionScore';
import { formatNutritionPrimaryTarget } from '../utils/nutritionTargetRanges';
import { creditedMicrosFromContent } from '../utils/supplementFacts';
import { resolveSupplementSlug } from '../utils/supplementNameMatch';
import { mealCheckKey, mealLegacyKey } from '../utils/mealPlanState';
import NutritionInsightCard from './NutritionInsightCard';
import SwipeableRow, { SwipeAction } from './SwipeableRow';
import FadeInView from './FadeInView';
import MealThumbnail from './MealThumbnail';
import PressableScale from './PressableScale';
import CompletionBurst from './CompletionBurst';
import { ScoreInfoModal, ScoreInfoSection, ScoreInfoBody, ScoreInfoRow } from './ScoreInfoModal';
import { dynamicCompactTextProps } from '../utils/dynamicType';
import { useBottomSheetSwipeDismiss } from './BottomSheetDismissHandle';
import { resolveMealImage } from '../utils/foodImage';

// Suffixed micro keys (from a scanned Supplement Facts panel) → the
// camelCase keys used by `dailyMicros` / the micro modal below. Converters
// normalize to the UI's display unit; omega_3_g is stored in grams server-side
// but shown against a 1600 mg target in the app.
const PANEL_MICRO_TO_CARD: Record<string, { key: string; converter: number }> = {
  calcium_mg: { key: 'calcium', converter: 1 },
  iron_mg: { key: 'iron', converter: 1 },
  potassium_mg: { key: 'potassium', converter: 1 },
  magnesium_mg: { key: 'magnesium', converter: 1 },
  zinc_mg: { key: 'zinc', converter: 1 },
  copper_mg: { key: 'copper', converter: 1 },
  manganese_mg: { key: 'manganese', converter: 1 },
  boron_mg: { key: 'boron', converter: 1 },
  selenium_mcg: { key: 'selenium', converter: 1 },
  vitamin_d_mcg: { key: 'vitaminD', converter: 1 },
  vitamin_b12_mcg: { key: 'vitaminB12', converter: 1 },
  vitamin_c_mg: { key: 'vitaminC', converter: 1 },
  vitamin_a_mcg: { key: 'vitaminA', converter: 1 },
  folate_mcg: { key: 'folate', converter: 1 },
  omega_3_g: { key: 'omega3', converter: 1000 },
};

// Aggregation registry. Each entry maps an output chip-key (camelCase) to
// the snake_case / camelCase keys it can find on an incoming `micronutrients`
// payload. Adding a row here is enough for the chip to start receiving data
// from every meal-item path; rendering still requires a chip line in the
// Nutrition Overview modal below. Keep ordering aligned with the chip
// ordering in the modal so the spec reads top-to-bottom like the UI.
const MICRO_FIELD_SPEC: Array<{ out: string; keys: string[]; converters?: Record<string, number> }> = [
  // ── Default chips ─────────────────────────────────────────────────────
  { out: 'fiber',              keys: ['fiber'] },
  { out: 'sugar',              keys: ['sugar'] },
  { out: 'addedSugar',         keys: ['added_sugar_g', 'added_sugar', 'addedSugar'] },
  { out: 'sodium',             keys: ['sodium_mg', 'sodium'] },
  { out: 'potassium',          keys: ['potassium_mg', 'potassium'] },
  { out: 'calcium',            keys: ['calcium_mg', 'calcium'] },
  { out: 'magnesium',          keys: ['magnesium_mg', 'magnesium'] },
  { out: 'iron',               keys: ['iron_mg', 'iron'] },
  { out: 'zinc',               keys: ['zinc_mg', 'zinc'] },
  { out: 'saturatedFat',       keys: ['saturated_fat_g', 'saturated_fat', 'saturatedFat'] },
  // Trans fat: "keep close to zero" target — sits next to sat fat / cholesterol.
  { out: 'transFat',           keys: ['trans_fat_g', 'trans_fat', 'transFat'] },
  { out: 'cholesterol',        keys: ['cholesterol', 'cholesterol_mg'] },
  { out: 'monounsaturatedFat', keys: ['monounsaturated_fat', 'monounsaturatedFat'] },
  { out: 'polyunsaturatedFat', keys: ['polyunsaturated_fat', 'polyunsaturatedFat'] },
  { out: 'omega3',             keys: ['omega_3_g', 'omega_3', 'omega3'], converters: { omega_3_g: 1000, omega_3: 1000 } },
  { out: 'vitaminD',           keys: ['vitamin_d_mcg', 'vitamin_d', 'vitaminD'] },
  { out: 'vitaminC',           keys: ['vitamin_c_mg', 'vitamin_c', 'vitaminC'] },
  { out: 'vitaminB12',         keys: ['vitamin_b12_mcg', 'vitamin_b12', 'vitaminB12'] },
  { out: 'folate',             keys: ['folate_mcg', 'folate', 'folate_b9'] },
  { out: 'vitaminA',           keys: ['vitamin_a_mcg', 'vitamin_a', 'vitaminA'] },
  // ── Advanced / conditional chips ──────────────────────────────────────
  // Render only when the day's value > 0 OR the user expands "Show advanced".
  // Aggregation runs unconditionally so the insight layer always has data.
  { out: 'choline',            keys: ['choline_mg', 'choline'] },
  { out: 'iodine',             keys: ['iodine_mcg', 'iodine'] },
  { out: 'vitaminK',           keys: ['vitamin_k_mcg', 'vitamin_k', 'vitaminK'] },
  { out: 'vitaminE',           keys: ['vitamin_e_mg', 'vitamin_e', 'vitaminE'] },
  { out: 'phosphorus',         keys: ['phosphorus_mg', 'phosphorus'] },
  { out: 'selenium',           keys: ['selenium_mcg', 'selenium'] },
  { out: 'copper',             keys: ['copper_mg', 'copper'] },
  { out: 'manganese',          keys: ['manganese_mg', 'manganese'] },
  { out: 'boron',              keys: ['boron_mg', 'boron'] },
  // Omega-6: prefer the explicit `_mg` field; `omega_6` (no unit) is a
  // legacy alias and was already treated as mg in the UI.
  { out: 'omega6',             keys: ['omega_6_mg', 'omega_6', 'omega6'] },
  { out: 'caffeine',           keys: ['caffeine_mg', 'caffeine'] },
  { out: 'alcohol',            keys: ['alcohol_g', 'alcohol'] },
  // Omega-3 subtypes (mg). Kept after the user-facing chip list because
  // they're consumed for derivation, not chip rendering directly. The
  // omega3 total chip stays the primary surface; EPA/DHA totals are
  // computed in `dailyMicros` below for downstream insight use.
  { out: 'omega3Ala',          keys: ['omega_3_ala_mg', 'omega_3_ala'] },
  { out: 'omega3Epa',          keys: ['omega_3_epa_mg', 'omega_3_epa'] },
  { out: 'omega3Dha',          keys: ['omega_3_dha_mg', 'omega_3_dha'] },
];

// Chip keys split into default (always visible) vs advanced (collapsed by
// default, shown when value > 0 OR user taps "Show advanced"). Keep these
// in sync with MICRO_FIELD_SPEC — the order here drives the modal layout
// and matches the product spec from 2026-05.
const DEFAULT_MICRO_CHIPS: ReadonlyArray<string> = [
  'fiber', 'sugar', 'addedSugar', 'sodium',
  'potassium', 'calcium', 'magnesium', 'iron', 'zinc',
  'saturatedFat', 'transFat', 'cholesterol',
  'monounsaturatedFat', 'polyunsaturatedFat', 'omega3',
  'vitaminD', 'vitaminC', 'vitaminB12', 'folate', 'vitaminA',
];
const ADVANCED_MICRO_CHIPS: ReadonlyArray<string> = [
  'choline', 'iodine', 'vitaminK', 'vitaminE', 'phosphorus',
  'selenium', 'copper', 'manganese', 'boron',
  'omega6', 'caffeine', 'alcohol',
];

const SUPPLEMENT_MICRO_MAP: Record<string, { key: string; converter: number }> = {
  vitamin_d3:  { key: 'vitaminD',   converter: 1 / 40 },
  vitamin_d:   { key: 'vitaminD',   converter: 1 / 40 },
  vitamin_b12: { key: 'vitaminB12', converter: 1 },
  magnesium:   { key: 'magnesium',  converter: 1 },
  iron:        { key: 'iron',       converter: 1 },
  omega_3:     { key: 'omega3',     converter: 1 },
  vitamin_c:   { key: 'vitaminC',   converter: 1 },
  calcium:     { key: 'calcium',    converter: 1 },
  zinc:        { key: 'zinc',       converter: 1 },
  selenium:    { key: 'selenium',   converter: 1 },
  potassium:   { key: 'potassium',  converter: 1 },
  folate:      { key: 'folate',     converter: 1 },
};

const EMPTY_TARGETS = { calories: 0, protein: 0, carbs: 0, fat: 0 };

type ProcessingBucket = NonNullable<MealItem['processing_bucket']>;

const PROCESSING_TIER_INFO: Record<ProcessingBucket, { label: string; rowLabel: string; color: string }> = {
  minimally_processed: { label: 'Whole food', rowLabel: 'Whole', color: '#22C55E' },
  processed: { label: 'Processed', rowLabel: 'Processed', color: '#F59E0B' },
  ultra_processed: { label: 'Ultra-processed', rowLabel: 'Ultra-processed', color: '#EF4444' },
  unknown: { label: 'Unknown', rowLabel: 'Unknown', color: '#94A3B8' },
};

const NUTRITION_OVERVIEW_HEADER_IMAGE = require('../../assets/images/card-backgrounds/meal-card-plant-based-meal-prep-day.jpg');

type TodaySupplement = {
  ingredient_slug?: string | null;
  ingredient_name?: string | null;
  custom_name?: string | null;
  category?: string | null;
  description?: string | null;
  source_terms?: string[] | null;
  food_sources?: string[] | null;
  log_names?: string[] | null;
  dose_amount: number;
  dose_unit: string;
  taken_count: number;
  nutrient_content?: {
    serving_size?: { count?: number | null; unit?: string | null } | null;
    nutrients?: Array<{ key?: string; nutrient?: string; amount?: number; unit?: string }> | null;
  } | null;
};

type MicroSourceContribution = { food: string; meal: string; amount: number };

type MicroSourceDetail = {
  label: string;
  unit: string;
  total: number;
  contributions: MicroSourceContribution[];
};

function microDisplayLabel(value: string): string {
  // Special-case the few chips whose pretty label diverges from the
  // auto-spaced camelCase form (e.g. "Vitamin B12" not "Vitamin B 1 2").
  switch (value) {
    case 'vitaminA': return 'Vitamin A';
    case 'vitaminC': return 'Vitamin C';
    case 'vitaminD': return 'Vitamin D';
    case 'vitaminE': return 'Vitamin E';
    case 'vitaminK': return 'Vitamin K';
    case 'vitaminB12': return 'Vitamin B12';
    case 'addedSugar': return 'Added Sugar';
    case 'transFat': return 'Trans Fat';
    case 'saturatedFat': return 'Saturated Fat';
    case 'monounsaturatedFat': return 'Mono Fat';
    case 'polyunsaturatedFat': return 'Poly Fat';
    case 'omega3': return 'Omega-3';
    case 'omega6': return 'Omega-6';
    case 'omega3Ala': return 'Omega-3 ALA';
    case 'omega3Epa': return 'Omega-3 EPA';
    case 'omega3Dha': return 'Omega-3 DHA';
    default:
      return value.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
  }
}

function microDisplayUnit(value: string): string {
  // Grams: macros-adjacent fats + carbs subcategories, plus alcohol.
  if (['fiber', 'sugar', 'addedSugar', 'saturatedFat', 'transFat', 'monounsaturatedFat', 'polyunsaturatedFat', 'alcohol'].includes(value)) return 'g';
  // Micrograms: anything where typical daily targets are <1 mg.
  if (['vitaminD', 'vitaminB12', 'selenium', 'folate', 'vitaminK', 'iodine'].includes(value)) return 'mcg';
  return 'mg';
}

function microValueFrom(source: Record<string, any> | null | undefined, spec: { keys: string[]; converters?: Record<string, number> }): number {
  if (!source) return 0;
  for (const key of spec.keys) {
    if (source[key] == null) continue;
    const value = Number(source[key]);
    if (Number.isFinite(value)) return value * (spec.converters?.[key] ?? 1);
  }
  return 0;
}

function panelMicroContribution(panelKey: string, amount: number): { key: string; amount: number } | null {
  const mapped = PANEL_MICRO_TO_CARD[panelKey];
  if (!mapped || amount <= 0) return null;
  return { key: mapped.key, amount: amount * mapped.converter };
}

function supplementFallbackAmount(
  sup: TodaySupplement,
  slug: string,
  mapping: { key: string; converter: number },
): number {
  const unitNorm = (sup.dose_unit || '').trim().toLowerCase();
  let converter = mapping.converter;
  if ((slug === 'vitamin_d3' || slug === 'vitamin_d') && (unitNorm === 'mcg' || unitNorm === 'ug' || unitNorm === 'µg')) {
    converter = 1;
  }
  if (slug === 'omega_3') {
    if (unitNorm === 'g' || unitNorm === 'gram' || unitNorm === 'grams') converter = 1000;
    else if (unitNorm === 'mg' || unitNorm === 'milligram' || unitNorm === 'milligrams') converter = 1;
    else if (unitNorm === 'mcg' || unitNorm === 'ug' || unitNorm === 'µg') converter = 1 / 1000;
  }
  return sup.dose_amount * sup.taken_count * converter;
}

function buildMicroSourceDetail(
  nutrient: string | null,
  meals: MealSuggestion[],
  todaySupplements?: TodaySupplement[] | null,
): MicroSourceDetail | null {
  const spec = MICRO_FIELD_SPEC.find(s => s.out === nutrient);
  if (!spec) return null;

  const contributions: MicroSourceContribution[] = [];
  for (const meal of meals) {
    let mealItemContributed = false;
    for (const it of (meal.items ?? [])) {
      const val = microValueFrom((it as any).micronutrients, spec);
      if (val > 0) {
        contributions.push({ food: it.name, meal: meal.meal, amount: val });
        mealItemContributed = true;
      }
    }
    if (!mealItemContributed) {
      const val = microValueFrom(meal.micronutrients as any, spec);
      if (val > 0) contributions.push({ food: meal.meal, meal: '', amount: val });
    }
  }

  if (todaySupplements) {
    for (const sup of todaySupplements) {
      if (sup.taken_count <= 0) continue;
      if (sup.nutrient_content) {
        const credited = creditedMicrosFromContent(sup.nutrient_content, sup.dose_amount, sup.dose_unit);
        let creditedAny = false;
        for (const [panelKey, amt] of Object.entries(credited)) {
          const contribution = panelMicroContribution(panelKey, amt);
          if (contribution?.key === spec.out && contribution.amount > 0) {
            contributions.push({
              food: `${sup.custom_name ?? sup.ingredient_name ?? 'Supplement'} (supplement)`,
              meal: '',
              amount: contribution.amount * sup.taken_count,
            });
            creditedAny = true;
          }
        }
        if (creditedAny) continue;
      }
      const slug = resolveSupplementSlug(sup);
      if (!slug) continue;
      const mapping = SUPPLEMENT_MICRO_MAP[slug];
      if (!mapping || mapping.key !== spec.out) continue;
      const amount = supplementFallbackAmount(sup, slug, mapping);
      if (amount > 0) {
        contributions.push({
          food: `${sup.custom_name ?? sup.ingredient_name ?? slug} (supplement)`,
          meal: '',
          amount,
        });
      }
    }
  }

  contributions.sort((a, b) => b.amount - a.amount);
  return {
    label: microDisplayLabel(spec.out),
    unit: microDisplayUnit(spec.out),
    total: contributions.reduce((sum, c) => sum + c.amount, 0),
    contributions,
  };
}

function formatMicroSourceAmount(value: number): string {
  return String(value < 10 ? Math.round(value * 10) / 10 : Math.round(value));
}

function processingBucketForItem(item: MealItem): ProcessingBucket {
  if (
    item.processing_bucket === 'minimally_processed'
    || item.processing_bucket === 'processed'
    || item.processing_bucket === 'ultra_processed'
    || item.processing_bucket === 'unknown'
  ) {
    return item.processing_bucket;
  }
  if (item.food_quality === 'whole') return 'minimally_processed';
  if (item.food_quality === 'processed') return 'processed';
  return 'unknown';
}

function e2eId(value: string | number | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function mealRowIdentityKey(meal: MealSuggestion, fallbackKey: string, macros: MealMacroTotals): string {
  const loggedId = Number((meal as any)._loggedMealId ?? 0) || 0;
  if (loggedId) return `logged_${loggedId}`;
  const localId = String((meal as any)._localId ?? '').trim();
  if (localId) return `local_${localId}`;
  const routineId = String((meal as any)._routineId ?? '').trim();
  if (routineId) return `routine_${routineId}`;
  return [
    fallbackKey,
    (meal.meal || meal.name || 'meal').trim().toLowerCase(),
    Math.round(macros.calories),
    (meal.items ?? meal.foods ?? []).length,
  ].join('_');
}

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
  onHardDeleteMeal?: (mealType: string) => void;
  onToggleRoutine?: (mealType: string) => void;
  onShowRecipe?: (mealType: string, meal: MealSuggestion) => void;
  /** Reorder the day's meals[]. `direction` is -1 (move up) or +1 (move down). */
  onMoveMeal?: (mealType: string, direction: -1 | 1) => void;
  onDuplicateMeal?: (mealType: string, meal: MealSuggestion) => void;
  onSplitMeal?: (mealType: string, meal: MealSuggestion) => void;
  goal?: string;
  /** Lowercase names of the user's Favorites. Used to show a
   *  "Saved" state on meal rows whose name already lives in the
   *  favorites library. */
  savedMealNames?: Set<string>;
  /** Toggle save/unsave for a meal directly from the card. */
  onToggleSave?: (mealType: string, meal: MealSuggestion) => void;
  /** Called when the user picks "From Favorites" on the add button. */
  onAddFromSaved?: () => void;
  /** Authoritative daily amounts from /meals/gut-health → today. When
   *  present they override the client-side plan-preview estimate so
   *  the Gut signals strip shows real logged totals (grams of
   *  collagen, billions of CFU, etc). */
  dailyCollagenG?: number | null;
  dailyProbioticCfuBillions?: number | null;
  dailyPrebioticG?: number | null;
  /** Per-food plant vs animal protein breakdown for today. Drives the
   *  "Plant vs Meat" tile + drill-down modal beneath the macro grid.
   *  Null = not yet loaded; { plant_total_g: 0, animal_total_g: 0 }
   *  = loaded but no protein logged yet (tile hides). */
  proteinBreakdown?: {
    plant_total_g: number;
    animal_total_g: number;
    plant_pct: number;
    animal_pct: number;
    plant: Array<{ name: string; protein_g: number }>;
    animal: Array<{ name: string; protein_g: number }>;
    unclassified: Array<{ name: string; protein_g: number }>;
  } | null;
  /** Today's taken (non-skipped) supplements — used to inject
   *  supplement contributions into the nutrient drill-down so users
   *  see "Vitamin D3 (supplement)" alongside food sources. */
  todaySupplements?: TodaySupplement[] | null;
  /** Server-authoritative projected-day score. When present, this
   *  overrides the local preview so Home, History, and Progress all
   *  show the same number for the planned day. */
  authoritativeScore?: {
    score: number;
    adherence?: number | null;
    quality?: number | null;
    micro?: number | null;
    confidence?: string | null;
    wins?: string[] | null;
    improvements?: string[] | null;
    tags?: string[] | null;
    likely_gaps?: string[] | null;
    indicators?: Record<string, any> | null;
    adherence_breakdown?: NutritionScoreBreakdownItem[] | null;
    quality_breakdown?: NutritionScoreBreakdownItem[] | null;
    micro_breakdown?: NutritionScoreBreakdownItem[] | null;
    cap_reasons?: string[] | null;
    totals?: { calories?: number | null; protein_g?: number | null; carbs_g?: number | null; fat_g?: number | null } | null;
    targets?: { calories?: number | null; protein_g?: number | null; carbs_g?: number | null; fat_g?: number | null } | null;
  } | null;
  /** True while a recent meal write is still inside the server's
   *  recompute debounce window, so the displayed score may briefly
   *  reflect pre-write totals. Renders a small "Updating" pill. */
  scoreUpdating?: boolean;
  hidePlanScore?: boolean;
  hideScoreRow?: boolean;
  /** When set, renders a "Supplements" pill below the score row so the
   *  user can open the supplements overlay without leaving the meal
   *  card. Replaces the old Supps sub-tab. */
  onOpenSupplements?: () => void;
  glp1Support?: UserProfile['glp1Support'];
  /** Removes the outer card shell so parent day cards can reveal the
   *  macro panel + individual meal cards as a clean expanding stack. */
  embedded?: boolean;
  testID?: string;
}

function NutritionCardInner({
  title,
  themeName,
  nutritionPlan,
  checkedMeals = {},
  onToggleMeal,
  onEditMeal,
  onAddSnack,
  onRemoveMeal,
  onRestoreMeal,
  onHardDeleteMeal,
  onToggleRoutine,
  onShowRecipe,
  onMoveMeal,
  onDuplicateMeal,
  onSplitMeal,
  onToggleSave,
  goal,
  savedMealNames,
  onAddFromSaved,
  dailyCollagenG,
  dailyProbioticCfuBillions,
  dailyPrebioticG,
  proteinBreakdown,
  todaySupplements,
  authoritativeScore,
  scoreUpdating = false,
  onOpenSupplements,
  hidePlanScore = false,
  hideScoreRow = false,
  glp1Support,
  embedded = false,
  testID,
}: NutritionCardProps) {
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [scoreInfoOpen, setScoreInfoOpen] = useState(false);
  const [showProteinModal, setShowProteinModal] = useState(false);
  const [drillNutrient, setDrillNutrient] = useState<string | null>(null);
  // Advanced micronutrient section starts collapsed: each chip in
  // ADVANCED_MICRO_CHIPS renders only when its value > 0. Expanding shows
  // all of them (including empty / "—" chips) for discoverability.
  const [showAllAdvanced, setShowAllAdvanced] = useState(false);
  const detailScrollOffsetYRef = useRef(0);
  const proteinScrollOffsetYRef = useRef(0);
  const closeDetailModal = useCallback(() => {
    setShowDetailModal(false);
    setDrillNutrient(null);
  }, []);
  const closeProteinModal = useCallback(() => {
    setShowProteinModal(false);
  }, []);
  const canSwipeDismissDetailModal = useCallback(
    () => showDetailModal && !drillNutrient && detailScrollOffsetYRef.current <= 2,
    [drillNutrient, showDetailModal],
  );
  const canSwipeDismissProteinModal = useCallback(
    () => showProteinModal && proteinScrollOffsetYRef.current <= 2,
    [showProteinModal],
  );
  const detailModalSwipeHandlers = useBottomSheetSwipeDismiss(closeDetailModal, {
    enabled: showDetailModal,
    canStart: canSwipeDismissDetailModal,
    capture: true,
    distance: 64,
    velocity: 0.75,
  });
  const proteinModalSwipeHandlers = useBottomSheetSwipeDismiss(closeProteinModal, {
    enabled: showProteinModal,
    canStart: canSwipeDismissProteinModal,
    capture: true,
    distance: 56,
    velocity: 0.75,
  });
  const handleDetailModalScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    detailScrollOffsetYRef.current = event.nativeEvent.contentOffset.y;
  }, []);
  const handleProteinModalScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    proteinScrollOffsetYRef.current = event.nativeEvent.contentOffset.y;
  }, []);
  const planPreviewScore = useMemo(() => computeNutritionScore(nutritionPlan, goal ?? 'body_recomp'), [nutritionPlan, goal]);
  const dayScore = useMemo(() => {
    if (authoritativeScore && authoritativeScore.score <= 0) {
      return { ...planPreviewScore, score: 0 };
    }
    if (!authoritativeScore) return planPreviewScore;
    const indicatorNumber = (...values: unknown[]): number | undefined => {
      for (const value of values) {
        const n = typeof value === 'number' ? value : Number(value);
        if (Number.isFinite(n)) return n;
      }
      return undefined;
    };
    const serverIndicators = authoritativeScore.indicators ?? {};
    const totalCalories = indicatorNumber(authoritativeScore.totals?.calories, serverIndicators.total_calories);
    const targetCalories = indicatorNumber(authoritativeScore.targets?.calories, serverIndicators.target_calories);
    const totalProtein = indicatorNumber(authoritativeScore.totals?.protein_g, serverIndicators.total_protein);
    const targetProtein = indicatorNumber(authoritativeScore.targets?.protein_g, serverIndicators.target_protein);
    const totalCarbs = indicatorNumber(authoritativeScore.totals?.carbs_g, serverIndicators.total_carbs);
    const targetCarbs = indicatorNumber(authoritativeScore.targets?.carbs_g, serverIndicators.target_carbs);
    const totalFat = indicatorNumber(authoritativeScore.totals?.fat_g, serverIndicators.total_fat);
    const targetFat = indicatorNumber(authoritativeScore.targets?.fat_g, serverIndicators.target_fat);
    const minimallyProcessedPct = indicatorNumber(serverIndicators.minimally_processed_pct, serverIndicators.whole_food_pct);
    const indicators = {
      ...planPreviewScore.indicators,
      ...serverIndicators,
      ...(totalCalories !== undefined ? { total_calories: totalCalories } : {}),
      ...(targetCalories !== undefined ? { target_calories: targetCalories } : {}),
      ...(totalProtein !== undefined ? { total_protein: totalProtein } : {}),
      ...(targetProtein !== undefined ? { target_protein: targetProtein } : {}),
      ...(totalCarbs !== undefined ? { total_carbs: totalCarbs } : {}),
      ...(targetCarbs !== undefined ? { target_carbs: targetCarbs } : {}),
      ...(totalFat !== undefined ? { total_fat: totalFat } : {}),
      ...(targetFat !== undefined ? { target_fat: targetFat } : {}),
      ...(minimallyProcessedPct !== undefined ? {
        minimally_processed_pct: minimallyProcessedPct,
        whole_food_pct: minimallyProcessedPct,
      } : {}),
    };
    return {
      ...planPreviewScore,
      score: authoritativeScore.score,
      adherence: authoritativeScore.adherence ?? planPreviewScore.adherence,
      quality: authoritativeScore.quality ?? planPreviewScore.quality,
      micro: authoritativeScore.micro ?? planPreviewScore.micro,
      confidence: authoritativeScore.confidence ?? planPreviewScore.confidence,
      wins: Array.isArray(authoritativeScore.wins) ? authoritativeScore.wins : planPreviewScore.wins,
      improvements: Array.isArray(authoritativeScore.improvements) ? authoritativeScore.improvements : planPreviewScore.improvements,
      tags: Array.isArray(authoritativeScore.tags) ? authoritativeScore.tags : planPreviewScore.tags,
      likely_gaps: Array.isArray(authoritativeScore.likely_gaps) ? authoritativeScore.likely_gaps : planPreviewScore.likely_gaps,
      adherence_breakdown: Array.isArray(authoritativeScore.adherence_breakdown) ? authoritativeScore.adherence_breakdown : planPreviewScore.adherence_breakdown,
      quality_breakdown: Array.isArray(authoritativeScore.quality_breakdown) ? authoritativeScore.quality_breakdown : planPreviewScore.quality_breakdown,
      micro_breakdown: Array.isArray(authoritativeScore.micro_breakdown) ? authoritativeScore.micro_breakdown : planPreviewScore.micro_breakdown,
      cap_reasons: Array.isArray(authoritativeScore.cap_reasons) ? authoritativeScore.cap_reasons : planPreviewScore.cap_reasons,
      indicators,
    };
  }, [authoritativeScore, planPreviewScore]);
  const visibleDayScore = hidePlanScore && (!authoritativeScore || authoritativeScore.score <= 0)
    ? { ...dayScore, score: 0 }
    : dayScore;
  const [swipeHintDismissed, setSwipeHintDismissed] = useState(false);
  const sectionFadeAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    detailScrollOffsetYRef.current = 0;
    proteinScrollOffsetYRef.current = 0;
    if (showDetailModal) {
      sectionFadeAnim.setValue(0);
      Animated.timing(sectionFadeAnim, { toValue: 1, duration: 400, delay: 120, useNativeDriver: true }).start();
    } else {
      sectionFadeAnim.setValue(0);
    }
  }, [showDetailModal]);
  const theme = useMemo(() => getTheme(themeName), [themeName]);
  const colors = theme.colors;
  const section = theme.sections.meals;
  const addMealOnColor = getContrastingTextColor(section.strong);
  const styles = useMemo(() => createStyles(colors, section), [colors, section]);
  const targets = nutritionPlan.targets ?? EMPTY_TARGETS;
  const removed = useMemo(() => new Set(nutritionPlan.removedMealIds ?? []), [nutritionPlan.removedMealIds]);

  // Generic meals[] — rendered in user order, with stable meal keys so
  // checked/logged state can survive reordering.
  const mealsArr = useMemo(
    () => Array.isArray(nutritionPlan.meals) ? nutritionPlan.meals : [],
    [nutritionPlan.meals],
  );
  // No emoji prefix on meal rows — the meal name + routine pin pill below
  // already carries the visual identity. Empty string keeps the prop API
  // stable so MealRow callers don't all have to change.
  const allMeals = useMemo(() => mealsArr.map((meal, idx) => ({
    key: mealCheckKey(nutritionPlan, meal, idx),
    legacyKey: mealLegacyKey(idx),
    reactKey: mealRowIdentityKey(meal, mealCheckKey(nutritionPlan, meal, idx), macroTotalsFromMeal(meal)),
    emoji: '',
    meal,
    macros: macroTotalsFromMeal(meal),
  })), [mealsArr]);
  const visibleMeals = useMemo(() => allMeals.filter(m => !removed.has(m.key) && !removed.has(m.legacyKey)), [allMeals, removed]);
  const hiddenMeals  = useMemo(() => allMeals.filter(m =>  removed.has(m.key) ||  removed.has(m.legacyKey)), [allMeals, removed]);
  const allVisible = visibleMeals;
  const hasSwipeActions = !!(onToggleSave || onToggleRoutine || onShowRecipe || onMoveMeal || onDuplicateMeal || onSplitMeal || onRemoveMeal);
  const actual = useMemo(() => ({
    calories: Math.round(allVisible.reduce((sum, m) => sum + m.macros.calories, 0)),
    protein:  Math.round(allVisible.reduce((sum, m) => sum + m.macros.protein, 0)),
    carbs:    Math.round(allVisible.reduce((sum, m) => sum + m.macros.carbs, 0)),
    fat:      Math.round(allVisible.reduce((sum, m) => sum + m.macros.fat, 0)),
  }), [allVisible]);
  const glp1Enabled = glp1Support?.enabled === true;
  const glp1AppetiteLabel =
    glp1Support?.appetite === 'very_low' ? 'Very low appetite' :
    glp1Support?.appetite === 'reduced' ? 'Reduced appetite' :
    'Appetite support';
  const glp1ProteinGap = Math.max(0, Math.round((targets.protein || 0) - actual.protein));
  const glp1HasGiSignal = (glp1Support?.sideEffects ?? []).some(s =>
    s === 'nausea' || s === 'constipation' || s === 'reflux'
  );
  const glp1SupportChips = [
    glp1ProteinGap > 15 ? `${glp1ProteinGap}g protein gap` : `${Math.round(targets.protein || actual.protein || 0)}g protein target`,
    glp1AppetiteLabel,
    glp1HasGiSignal ? 'GI-friendly' : 'Hydration',
  ].filter(label => !!label && !label.startsWith('0g'));

  // Aggregate micronutrients across all visible meals. Each display
  // field accepts multiple backend key spellings because the backend
  // emits snake_case (`vitamin_a`) but the legacy type + old cached
  // plans used camelCase (`vitaminA`). We sum whichever is present.
  const dailyMicros = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const spec of MICRO_FIELD_SPEC) {
      totals[spec.out] = allVisible.reduce((sum, m) => {
        const itemTotal = (m.meal.items ?? []).reduce(
          (itemSum, item) => itemSum + microValueFrom((item as any).micronutrients, spec),
          0,
        );
        if (itemTotal > 0) return sum + itemTotal;
        const mealTotal = microValueFrom(m.meal.micronutrients as any, spec);
        return sum + mealTotal + (spec.out === 'fiber' ? (m.meal.fiber ?? 0) : 0);
      }, 0);
    }

    // Add supplement contributions to today's micro totals so Key Gaps
    // / drill-downs / score components reflect them. Custom-named
    // supplements resolve via name inference. Mirrors the backend's
    // _add_supplement_micros pipeline.
    if (todaySupplements && todaySupplements.length > 0) {
      for (const sup of todaySupplements) {
        if (sup.taken_count <= 0) continue;
        // Preferred: a scanned Supplement Facts panel credits every nutrient
        // on the label (multivitamins, ZMA, electrolyte + bone blends),
        // including trace minerals like boron. Mirrors the backend.
        if (sup.nutrient_content) {
          const credited = creditedMicrosFromContent(sup.nutrient_content, sup.dose_amount, sup.dose_unit);
          let creditedAny = false;
          for (const [panelKey, amt] of Object.entries(credited)) {
            const contribution = panelMicroContribution(panelKey, amt);
            if (contribution) {
              totals[contribution.key] = (totals[contribution.key] || 0) + contribution.amount * sup.taken_count;
              creditedAny = true;
            }
          }
          if (creditedAny) continue;
        }
        const slug = resolveSupplementSlug(sup);
        if (!slug) continue;
        const mapping = SUPPLEMENT_MICRO_MAP[slug];
        if (!mapping) continue;
        const amount = supplementFallbackAmount(sup, slug, mapping);
        if (amount > 0) {
          totals[mapping.key] = (totals[mapping.key] || 0) + amount;
        }
      }
    }
    // Derived omega-3 EPA+DHA total (mg). Useful for seafood / algae-DHA
    // insights without forcing the AI to also return a sum. Best-effort: if
    // only one of EPA/DHA was reported, we still surface the partial sum
    // so the insight layer can detect "seafood was in this day."
    const epa = totals['omega3Epa'] || 0;
    const dha = totals['omega3Dha'] || 0;
    if (epa > 0 || dha > 0) {
      totals['omega3EpaDha'] = epa + dha;
    }
    // Round at the end so partial values from supplements aren't lost.
    // 2 decimals — sub-mg trace minerals (copper ~0.9mg, boron ~3mg) would
    // be destroyed by integer rounding.
    for (const key of Object.keys(totals)) {
      totals[key] = Math.round(totals[key] * 100) / 100;
    }
    return totals;
  }, [allVisible, todaySupplements]);
  const hasMicros = useMemo(() => MICRO_FIELD_SPEC.some(s => dailyMicros[s.out] > 0), [dailyMicros]);
  const selectedNutrientDetail = useMemo(
    () => buildMicroSourceDetail(drillNutrient, allVisible.map(v => v.meal), todaySupplements),
    [drillNutrient, allVisible, todaySupplements],
  );

  // Plan-preview gut facts. Surfaced on the Nutrition Overview modal as a
  // descriptive "Gut signals" tile strip. Gut & Plants card handles the
  // full drill-down (today + 7d rollup).
  const _gutHealth = useMemo(
    () => computePlanGutHealth(allVisible.map(v => v.meal), dailyMicros, actual.calories),
    [allVisible, dailyMicros, actual.calories],
  );

  const effectiveProteinBreakdown = useMemo(
    () => proteinBreakdown ?? computeProteinBreakdown(allVisible.map(v => v.meal)),
    [proteinBreakdown, allVisible],
  );

  const overviewScoreColor = visibleDayScore.score >= 70 ? colors.success : visibleDayScore.score >= 45 ? colors.warning : colors.error;
  const overviewScoreLabel = visibleDayScore.score >= 70 ? 'Great' : visibleDayScore.score >= 45 ? 'Good progress' : 'Needs attention';
  const wholeFoodPct = Number.isFinite(Number(visibleDayScore.indicators?.whole_food_pct ?? visibleDayScore.indicators?.minimally_processed_pct))
    ? Number(visibleDayScore.indicators?.whole_food_pct ?? visibleDayScore.indicators?.minimally_processed_pct)
    : null;
  const calorieTargetLabel = formatNutritionPrimaryTarget('calories', targets.calories, { includeUnit: false });
  const proteinTargetLabel = formatNutritionPrimaryTarget('protein', targets.protein, { includeUnit: false });
  const overviewStats = [
    {
      label: 'Calories',
      value: calorieTargetLabel ? `${actual.calories}/${calorieTargetLabel}` : `${actual.calories}`,
      unit: 'cal',
      color: section.strong,
    },
    {
      label: 'Protein',
      value: proteinTargetLabel ? `${actual.protein}/${proteinTargetLabel}` : `${actual.protein}`,
      unit: 'g',
      color: colors.primary,
    },
    {
      label: 'Fiber',
      value: dailyMicros.fiber > 0 ? `${Math.round(dailyMicros.fiber)}` : '0',
      unit: 'g',
      color: colors.success,
    },
    {
      label: 'Whole foods',
      value: wholeFoodPct != null ? `${Math.round(wholeFoodPct)}` : '0',
      unit: '%',
      color: '#22C55E',
    },
  ];

  return (
    <View testID={testID} style={[styles.card, embedded && styles.cardEmbedded]}>
      {/* Header removed — the macro grid below acts as the hero. The
          "+ Add Meal" affordance moved to the bottom of the meal list
          so the card opens with the user's macros front-and-center,
          matching the WorkoutCard hierarchy (hero → stats → list). */}
      <View style={[styles.body, embedded && styles.bodyEmbedded]}>
        {title ? <Text style={styles.titleSubtle}>{title}</Text> : null}

        {glp1Enabled && (
          <View style={styles.glp1SupportCard}>
            <View style={styles.glp1SupportTop}>
              <View style={styles.glp1SupportIcon}>
                <Ionicons name="medkit-outline" size={15} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.glp1SupportTitle}>GLP-1 support</Text>
                <Text style={styles.glp1SupportText}>
                  Protein-first meals, smaller portions, hydration, and gentle fiber.
                </Text>
              </View>
            </View>
            <View style={styles.glp1ChipRow}>
              {glp1SupportChips.map(chip => (
                <View key={chip} style={styles.glp1Chip}>
                  <Text style={styles.glp1ChipText}>{chip}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Day score — compact tap target for the full nutrition modal. */}
        {!hideScoreRow && visibleDayScore.score > 0 && (() => {
          const sc = visibleDayScore;
          const scoreColor = sc.score >= 70 ? colors.success : sc.score >= 45 ? colors.warning : colors.error;
          return (
            <View style={styles.scorePillRow}>
              <PressableScale
                testID="nutrition-day-score-row"
                accessibilityRole="button"
                accessibilityLabel={`Nutrition score ${sc.score}. Tap to view full details.`}
                scaleDown={0.965}
                onPress={() => setShowDetailModal(true)}
                style={[styles.scorePill, { backgroundColor: scoreColor + '14', borderColor: scoreColor + '55' }]}>
                <Ionicons name="nutrition-outline" size={14} color={scoreColor} />
                <Text style={[styles.scorePillLabel, { color: colors.textPrimary }]}>Score</Text>
                <Text style={[styles.scorePillValue, { color: scoreColor }]}>{sc.score}</Text>
                <Text style={[styles.scorePillMeta, { color: colors.textMuted }]} numberOfLines={1}>
                  {overviewScoreLabel}
                </Text>
                {scoreUpdating && <ActivityIndicator size="small" color={colors.textMuted} />}
                <Ionicons name="chevron-forward" size={13} color={colors.textMuted} />
              </PressableScale>
              <TouchableOpacity
                accessibilityLabel="How nutrition score is calculated"
                onPress={() => setScoreInfoOpen(true)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={styles.scoreInfoButton}>
                <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          );
        })()}

        {/* Inline "Plant vs Meat" protein-source bar removed — it duplicated
            the Plant vs Meat breakdown in the Nutrition Overview modal and the
            per-food "Protein source today" drill-down. Protein source now also
            surfaces via the tappable protein macro donut on the meals tab. */}

        {/* Combined Nutrition + Gut Health + Micronutrient Modal */}
        <Modal
          visible={showDetailModal}
          transparent
          animationType="slide"
          onRequestClose={closeDetailModal}>
          {showDetailModal && (
          <View style={styles.modalOverlay}>
            <View
              {...detailModalSwipeHandlers}
              style={[styles.modalContent, { backgroundColor: colors.surface }]}>
              <LinearGradient
                pointerEvents="none"
                colors={[section.soft + '66', colors.surface, colors.background + 'AA'] as any}
                locations={[0, 0.42, 1] as any}
                style={StyleSheet.absoluteFillObject}
              />
              <ScrollView
                style={styles.modalScroll}
                contentContainerStyle={styles.modalScrollContent}
                showsVerticalScrollIndicator={false}
                onScroll={handleDetailModalScroll}
                scrollEventThrottle={16}
                bounces>
                <ImageBackground
                  source={NUTRITION_OVERVIEW_HEADER_IMAGE}
                  style={styles.modalHero}
                  imageStyle={styles.modalHeroImage}
                  resizeMode="cover">
                  <LinearGradient
                    pointerEvents="none"
                    colors={['rgba(2,6,23,0.22)', 'rgba(2,6,23,0.72)', 'rgba(2,6,23,0.94)'] as any}
                    locations={[0, 0.56, 1] as any}
                    style={StyleSheet.absoluteFillObject}
                  />
                  <View style={styles.modalHeroTop}>
                    <View style={styles.modalHeroPill}>
                      <Ionicons name="nutrition-outline" size={13} color="#FFFFFF" />
                      <Text style={styles.modalHeroPillText}>Nutrition Overview</Text>
                    </View>
                    <TouchableOpacity
                      onPress={closeDetailModal}
                      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                      style={styles.modalHeroClose}>
                      <Ionicons name="close" size={20} color="#FFFFFF" />
                    </TouchableOpacity>
                  </View>
                  <View style={styles.modalHeroBottom}>
                    <View style={styles.modalHeroScoreRow}>
                      <View style={[styles.modalHeroScoreBadge, { borderColor: overviewScoreColor + '99', backgroundColor: overviewScoreColor + '26' }]}>
                        <Text style={[styles.modalHeroScore, { color: '#FFFFFF' }]}>{visibleDayScore.score > 0 ? visibleDayScore.score : '-'}</Text>
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.modalHeroTitle}>{overviewScoreLabel}</Text>
                        <Text style={styles.modalHeroSubtitle} numberOfLines={1}>
                          {visibleDayScore.wins[0] ?? visibleDayScore.improvements[0] ?? 'Daily fuel snapshot'}
                        </Text>
                      </View>
                    </View>
                    <View style={styles.modalHeroStats}>
                      {overviewStats.map(stat => (
                        <View key={stat.label} style={styles.modalHeroStat}>
                          <View style={[styles.modalHeroStatDot, { backgroundColor: stat.color }]} />
                          <Text style={styles.modalHeroStatValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
                            {stat.value}<Text style={styles.modalHeroStatUnit}> {stat.unit}</Text>
                          </Text>
                          <Text style={styles.modalHeroStatLabel} numberOfLines={1}>{stat.label}</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                </ImageBackground>

                <View style={styles.modalScrollableBody}>
                {/* ── Section 1: Nutrition Score ── */}
                {visibleDayScore.score > 0 && (() => {
                  const sc = visibleDayScore;
                  const scoreParts = [
                    { label: 'Adherence', value: sc.adherence, color: sc.adherence >= 70 ? colors.success : sc.adherence >= 45 ? colors.warning : colors.error },
                    { label: 'Food Quality', value: sc.quality, color: sc.quality >= 70 ? colors.success : sc.quality >= 45 ? colors.warning : colors.error },
                    { label: 'Micronutrients', value: sc.micro, color: sc.micro >= 70 ? colors.success : sc.micro >= 45 ? colors.warning : colors.error },
                  ];
                  return (
                    <Animated.View style={[styles.modalCard, styles.scoreOverviewCard, { borderColor: overviewScoreColor + '44', backgroundColor: colors.surfaceRaised, opacity: sectionFadeAnim }]}>
                      <LinearGradient
                        pointerEvents="none"
                        colors={[overviewScoreColor + '18', section.strong + '0C', 'transparent'] as any}
                        locations={[0, 0.56, 1]}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                        style={styles.modalCardGradient}
                      />
                      <View style={styles.scoreOverviewTop}>
                        <View style={[styles.scoreOverviewBadge, { borderColor: overviewScoreColor + '66', backgroundColor: overviewScoreColor + '18' }]}>
                          <Text style={[styles.scoreOverviewNumber, { color: overviewScoreColor }]}>{sc.score}</Text>
                          <Text style={styles.scoreOverviewBadgeLabel}>score</Text>
                        </View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.scoreOverviewTitle}>Score drivers</Text>
                          <Text style={styles.scoreOverviewSubtitle} numberOfLines={2}>
                            {sc.wins[0] ?? sc.improvements[0] ?? 'Daily fuel snapshot'}
                          </Text>
                        </View>
                      </View>

                      <View style={styles.scoreDriverList}>
                        {scoreParts.map(sub => (
                          <View key={sub.label} style={styles.scoreDriverRow}>
                            <View style={styles.scoreDriverLabelRow}>
                              <Text style={styles.scoreDriverLabel}>{sub.label}</Text>
                              <Text style={[styles.scoreDriverValue, { color: sub.color }]}>{sub.value}</Text>
                            </View>
                            <View style={styles.scoreDriverTrack}>
                              <View style={[styles.scoreDriverFill, { width: `${Math.min(100, Math.max(0, sub.value))}%` as any, backgroundColor: sub.color }]} />
                            </View>
                          </View>
                        ))}
                      </View>

                      {sc.indicators && (
                        <View style={styles.scoreSignalRow}>
                          {sc.indicators.total_calories > 0 && (
                            <View style={styles.scoreSignalChip}>
                              <Text style={styles.scoreSignalValue}>
                                {Math.round(sc.indicators.total_calories)} / {formatNutritionPrimaryTarget('calories', sc.indicators.target_calories, { includeUnit: false }) || Math.round(sc.indicators.target_calories || 0)}
                              </Text>
                              <Text style={styles.scoreSignalLabel}>cal</Text>
                            </View>
                          )}
                          {sc.indicators.total_protein > 0 && (
                            <View style={styles.scoreSignalChip}>
                              <Text style={styles.scoreSignalValue}>
                                {Math.round(sc.indicators.total_protein)} / {formatNutritionPrimaryTarget('protein', sc.indicators.target_protein) || `${Math.round(sc.indicators.target_protein || 0)}g`}
                              </Text>
                              <Text style={styles.scoreSignalLabel}>protein</Text>
                            </View>
                          )}
                          {wholeFoodPct != null && wholeFoodPct > 0 && (
                            <View style={styles.scoreSignalChip}>
                              <Text style={styles.scoreSignalValue}>{Math.round(wholeFoodPct)}%</Text>
                              <Text style={styles.scoreSignalLabel}>whole foods</Text>
                            </View>
                          )}
                        </View>
                      )}
                      {(sc.wins.length > 0 || sc.improvements.length > 0) && (
                        <View style={styles.scoreInsightList}>
                          {sc.wins.map(w => (
                            <View key={w} style={[styles.scoreInsightChip, { backgroundColor: colors.success + '14', borderColor: colors.success + '36' }]}>
                              <Ionicons name="checkmark-circle" size={12} color={colors.success} />
                              <Text style={[styles.scoreInsightText, { color: colors.success }]}>{w}</Text>
                            </View>
                          ))}
                          {sc.improvements.map(imp => (
                            <View key={imp} style={[styles.scoreInsightChip, { backgroundColor: colors.warning + '14', borderColor: colors.warning + '36' }]}>
                              <Ionicons name="arrow-up-circle" size={12} color={colors.warning} />
                              <Text style={[styles.scoreInsightText, { color: colors.warning }]}>{imp}</Text>
                            </View>
                          ))}
                        </View>
                      )}
                    </Animated.View>
                  );
                })()}

                {/* Macros removed from the modal — the main NutritionCard
                    already shows the macro tracker grid. The modal is for
                    score breakdowns only. */}

                {/* ── Section 3: Food Quality breakdown (unified with backend) ── */}
                {visibleDayScore.quality_breakdown && visibleDayScore.quality_breakdown.length > 0 && (
                  <Animated.View style={[styles.modalCard, { borderColor: colors.border, backgroundColor: colors.surfaceRaised, opacity: sectionFadeAnim }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <Ionicons name="nutrition-outline" size={16} color={colors.primary} />
                      <Text style={{ fontSize: 14, fontWeight: '700', color: colors.textPrimary }}>Food Quality</Text>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textSecondary, marginLeft: 'auto' }}>
                        {visibleDayScore.quality}
                      </Text>
                    </View>
                    {visibleDayScore.quality_breakdown.map(b => {
                      const c = b.on_track ? colors.success : b.value_pct >= 50 ? colors.warning : colors.error;
                      return (
                        <View key={b.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                          <Text style={{ width: 120, fontSize: 11, fontWeight: '600', color: colors.textSecondary }}>{b.label}</Text>
                          <View style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: colors.border }}>
                            <View style={{ width: `${Math.min(100, b.value_pct)}%` as any, height: 5, borderRadius: 3, backgroundColor: c }} />
                          </View>
                          <Text style={{ fontSize: 10, color: colors.textMuted, width: 58, textAlign: 'right' }}>
                            {b.raw}{b.unit === '% cals' ? '%' : b.unit === 'mg' ? ` ${b.unit}` : b.unit ? ` ${b.unit}` : ''}
                          </Text>
                        </View>
                      );
                    })}
                    {(() => {
                      const bd = visibleDayScore.quality_breakdown;
                      if (!bd || bd.length < 4) return null;
                      const ANTI_LABELS = ['Fiber density', 'Minimally processed', 'Plant diversity', 'Omega-3'];
                      const PRO_LABELS = ['Added sugar', 'Saturated fat'];
                      const antiCount = ANTI_LABELS.filter(lbl => bd.find(b => b.label === lbl)?.on_track).length;
                      const proCount = PRO_LABELS.filter(lbl => {
                        const item = bd.find(b => b.label === lbl);
                        return item && !item.on_track && (item.value_pct ?? 100) < 50;
                      }).length;
                      const net = antiCount - proCount;
                      const lean = net >= 2
                        ? { label: 'Anti-inflammatory lean', color: '#22C55E' }
                        : net === 1
                        ? { label: 'Balanced lean', color: colors.primary }
                        : net === 0
                        ? { label: 'Mixed signals', color: '#F59E0B' }
                        : { label: 'Pro-inflammatory lean', color: '#EF4444' };
                      return (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 9, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border }}>
                          <Ionicons name="flame-outline" size={13} color={lean.color} />
                          <Text style={{ fontSize: 11, fontWeight: '700', color: lean.color }}>{lean.label}</Text>
                          <Text style={{ fontSize: 10, color: colors.textMuted, marginLeft: 2 }}>based on today's food signals</Text>
                        </View>
                      );
                    })()}
                    <Text style={{ fontSize: 10, color: colors.textMuted, marginTop: 8, fontStyle: 'italic' }}>
                      See the Gut & Plants card for plant diversity and processing mix details.
                    </Text>
                  </Animated.View>
                )}

                {/* ── Gut signals strip (facts, not scored). Shows
                    probiotic / fermented / plants so the user has
                    visibility into gut-support inputs without diluting
                    Food Quality's scoring. */}
                {_gutHealth.item_count > 0 && (
                  <Animated.View style={[styles.modalCard, { borderColor: colors.border, backgroundColor: colors.surfaceRaised, opacity: sectionFadeAnim }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <Ionicons name="leaf-outline" size={16} color={colors.primary} />
                      <Text style={{ fontSize: 14, fontWeight: '700', color: colors.textPrimary }}>Gut signals</Text>
                      <Text style={{ fontSize: 10, color: colors.textMuted, marginLeft: 'auto' }}>today</Text>
                    </View>
                    {/* 3-column grid (2 rows of 3). The earlier
                        `flex:1 + flexWrap` layout produced uneven
                        tile sizes when items wrapped. Six tiles always
                        render — zero values show as "0" rather than
                        "—" so the user can see the metric is populated
                        but no qualifying foods were logged today. */}
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                      {[
                        // Prefer authoritative server amount (from
                        // /meals/gut-health → today). Falls back to
                        // the client-side plan estimate when no props
                        // are passed (e.g. plan-preview context).
                        {
                          label: 'Probiotic',
                          value: dailyProbioticCfuBillions != null && dailyProbioticCfuBillions > 0
                            ? `${dailyProbioticCfuBillions >= 10 ? Math.round(dailyProbioticCfuBillions) : dailyProbioticCfuBillions.toFixed(1)}B`
                            : (dailyProbioticCfuBillions != null
                                ? '0'
                                : `${Math.round(_gutHealth.probiotic_servings)}`),
                          detail: dailyProbioticCfuBillions != null ? 'CFU' : 'svg',
                        },
                        {
                          label: 'Collagen',
                          value: dailyCollagenG == null
                            ? '—'
                            : dailyCollagenG > 0
                              ? `${Math.round(dailyCollagenG)}g`
                              : '0g',
                          detail: 'today',
                        },
                        {
                          label: 'Prebiotic',
                          // null = not yet fetched (plan-preview / unauth);
                          // 0 = fetched but no prebiotic-rich foods logged
                          // today. Distinguishing these stops the user
                          // from thinking the metric is broken when the
                          // backfill is fine and they simply ate no oats /
                          // legumes / alliums today.
                          value: dailyPrebioticG == null
                            ? '—'
                            : dailyPrebioticG > 0
                              ? `${dailyPrebioticG >= 10 ? Math.round(dailyPrebioticG) : dailyPrebioticG.toFixed(1)}g`
                              : '0g',
                          detail: 'fiber',
                        },
                        { label: 'Fermented', value: `${Math.round(_gutHealth.fermented_servings)}`, detail: 'svg' },
                        { label: 'Plants', value: `${_gutHealth.distinct_plant_foods}`, detail: 'types' },
                        { label: 'Omega-3', value: _gutHealth.omega3_mg > 0 ? `${Math.round(_gutHealth.omega3_mg)}mg` : '0mg', detail: 'today' },
                      ].map(tile => (
                        <View key={tile.label} style={styles.gutSignalTile}>
                          <LinearGradient
                            pointerEvents="none"
                            colors={[colors.primary + '12', section.strong + '0A', 'transparent'] as any}
                            start={{ x: 0, y: 0 }}
                            end={{ x: 1, y: 1 }}
                            style={styles.gutSignalTileGradient}
                          />
                          <Text
                            numberOfLines={1}
                            adjustsFontSizeToFit
                            minimumFontScale={0.7}
                            style={{ fontSize: 16, fontWeight: '800', color: colors.textPrimary }}
                          >
                            {tile.value}
                          </Text>
                          <Text style={{ fontSize: 10, fontWeight: '600', color: colors.textMuted, marginTop: 2 }}>
                            {tile.label}
                          </Text>
                          <Text style={{ fontSize: 9, color: colors.textMuted, marginTop: 1 }}>
                            {tile.detail}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </Animated.View>
                )}

                {/* ── Section 4: Key Gaps ── */}
                {(() => {
                  const day: Record<string, number> = {
                    fiber: dailyMicros.fiber || 0, sugar: dailyMicros.sugar || 0, addedSugar: dailyMicros.addedSugar || 0,
                    sodium: dailyMicros.sodium || 0, saturatedFat: dailyMicros.saturatedFat || 0,
                    omega3: dailyMicros.omega3 || 0, potassium: dailyMicros.potassium || 0,
                    calcium: dailyMicros.calcium || 0, magnesium: dailyMicros.magnesium || 0,
                    vitaminD: dailyMicros.vitaminD || 0, cholesterol: dailyMicros.cholesterol || 0,
                  };
                  const insights = computeDayInsights(day).slice(0, 3);
                  if (insights.length === 0) return null;
                  return (
                    <View style={[styles.modalCard, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
                      <Text style={[styles.modalSectionTitle, { marginBottom: 8 }]}>Key Gaps</Text>
                      {insights.map(ins => (
                        <NutritionInsightCard
                          key={ins.key}
                          insight={ins}
                          meals={allVisible.map(v => v.meal)}
                          themeColors={{
                            textPrimary: colors.textPrimary, textSecondary: colors.textSecondary,
                            textMuted: colors.textMuted, border: colors.border, surface: colors.surface,
                            primary: colors.primary, surfaceRaised: colors.surfaceRaised,
                          }}
                        />
                      ))}
                    </View>
                  );
                })()}

                {/* ── Plant vs Meat protein breakdown ──
                    Mirrors the tile on the card body so users who
                    open the overview modal also see the comparison
                    + can drill into per-food sources. */}
                {effectiveProteinBreakdown && (effectiveProteinBreakdown.plant_total_g + effectiveProteinBreakdown.animal_total_g) > 0 && (() => {
                  const plantG = effectiveProteinBreakdown.plant_total_g;
                  const animalG = effectiveProteinBreakdown.animal_total_g;
                  const total = plantG + animalG;
                  const plantPct = total > 0 ? (plantG / total) * 100 : 0;
                  return (
                    <View style={[styles.modalCard, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
                      <Text style={[styles.modalSectionTitle, { marginBottom: 8 }]}>Plant vs Meat Protein</Text>
                      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
                        <View style={{ flex: 1, padding: 10, backgroundColor: '#22C55E22', borderRadius: 8 }}>
                          <Text style={{ fontSize: 10, color: '#16803D', fontWeight: '800', letterSpacing: 0.5 }}>PLANT</Text>
                          <Text style={{ fontSize: 20, fontWeight: '900', color: '#16803D', marginTop: 2 }}>
                            {Math.round(plantG)}<Text style={{ fontSize: 11, fontWeight: '700' }}>g</Text>
                          </Text>
                          <Text style={{ fontSize: 10, color: '#16803D' }}>{Math.round(plantPct)}%</Text>
                        </View>
                        <View style={{ flex: 1, padding: 10, backgroundColor: '#E0783022', borderRadius: 8 }}>
                          <Text style={{ fontSize: 10, color: '#9A4810', fontWeight: '800', letterSpacing: 0.5 }}>ANIMAL</Text>
                          <Text style={{ fontSize: 20, fontWeight: '900', color: '#9A4810', marginTop: 2 }}>
                            {Math.round(animalG)}<Text style={{ fontSize: 11, fontWeight: '700' }}>g</Text>
                          </Text>
                          <Text style={{ fontSize: 10, color: '#9A4810' }}>{Math.round(100 - plantPct)}%</Text>
                        </View>
                      </View>
                      <View style={{ flexDirection: 'row', height: 6, borderRadius: 3, overflow: 'hidden', backgroundColor: colors.border, marginBottom: 10 }}>
                        <View style={{ width: `${plantPct}%` as any, backgroundColor: '#22C55E' }} />
                        <View style={{ flex: 1, backgroundColor: '#E07830' }} />
                      </View>
                      <TouchableOpacity
                        onPress={() => { closeDetailModal(); setTimeout(() => setShowProteinModal(true), 220); }}
                        style={{ alignSelf: 'flex-start', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, backgroundColor: colors.background }}>
                        <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textSecondary }}>
                          See per-food breakdown ({effectiveProteinBreakdown.plant.length + effectiveProteinBreakdown.animal.length} sources)
                        </Text>
                      </TouchableOpacity>
                    </View>
                  );
                })()}

                {/* ── Section 5: Micronutrients ── */}
                {/* Default chips are always visible. Advanced chips render
                    only when value > 0 OR the user expands "Show all advanced".
                    Ordering and groupings match the product spec (2026-05). */}
                <View style={[styles.modalCard, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
                  <Text style={[styles.modalSectionTitle, { marginBottom: 8 }]}>Essentials</Text>
                  <View style={styles.microGridLg}>
                    <MicroChipLg label="Fiber" value={dailyMicros.fiber > 0 ? `${Math.round(dailyMicros.fiber)}g` : '—'} target="28g" pct={dailyMicros.fiber / 28} colors={colors} styles={styles} low={dailyMicros.fiber > 0 && dailyMicros.fiber < 20} onPress={() => setDrillNutrient(drillNutrient === 'fiber' ? null : 'fiber')} />
                    <MicroChipLg label="Sugar" value={dailyMicros.sugar > 0 ? `${Math.round(dailyMicros.sugar)}g` : '—'} target="<50g" pct={dailyMicros.sugar > 0 ? Math.min(dailyMicros.sugar / 50, 1) : 0} colors={colors} styles={styles} warn={dailyMicros.sugar > 50} onPress={() => setDrillNutrient(drillNutrient === 'sugar' ? null : 'sugar')} />
                    <MicroChipLg label="Added Sugar" value={dailyMicros.addedSugar > 0 ? `${Math.round(dailyMicros.addedSugar)}g` : '—'} target="<36g" pct={dailyMicros.addedSugar > 0 ? Math.min(dailyMicros.addedSugar / 36, 1) : 0} colors={colors} styles={styles} warn={dailyMicros.addedSugar > 36} onPress={() => setDrillNutrient(drillNutrient === 'addedSugar' ? null : 'addedSugar')} />
                    <MicroChipLg label="Sodium" value={dailyMicros.sodium > 0 ? `${Math.round(dailyMicros.sodium)}mg` : '—'} target="<2300mg" pct={dailyMicros.sodium > 0 ? Math.min(dailyMicros.sodium / 2300, 1) : 0} colors={colors} styles={styles} warn={dailyMicros.sodium > 2300} onPress={() => setDrillNutrient(drillNutrient === 'sodium' ? null : 'sodium')} />
                  </View>

                  <Text style={[styles.modalSectionTitle, { marginTop: 16, marginBottom: 8 }]}>Minerals</Text>
                  <View style={styles.microGridLg}>
                    <MicroChipLg label="Potassium" value={dailyMicros.potassium > 0 ? `${Math.round(dailyMicros.potassium)}mg` : '—'} target="3400mg" pct={dailyMicros.potassium / 3400} colors={colors} styles={styles} low={dailyMicros.potassium > 0 && dailyMicros.potassium < 2300} onPress={() => setDrillNutrient(drillNutrient === 'potassium' ? null : 'potassium')} />
                    <MicroChipLg label="Calcium" value={dailyMicros.calcium > 0 ? `${Math.round(dailyMicros.calcium)}mg` : '—'} target="1000mg" pct={dailyMicros.calcium / 1000} colors={colors} styles={styles} low={dailyMicros.calcium > 0 && dailyMicros.calcium < 700} onPress={() => setDrillNutrient(drillNutrient === 'calcium' ? null : 'calcium')} />
                    <MicroChipLg label="Magnesium" value={dailyMicros.magnesium > 0 ? `${Math.round(dailyMicros.magnesium)}mg` : '—'} target="400mg" pct={dailyMicros.magnesium / 400} colors={colors} styles={styles} low={dailyMicros.magnesium > 0 && dailyMicros.magnesium < 280} onPress={() => setDrillNutrient(drillNutrient === 'magnesium' ? null : 'magnesium')} />
                    <MicroChipLg label="Iron" value={dailyMicros.iron > 0 ? `${(Math.round(dailyMicros.iron * 10) / 10)}mg` : '—'} target="18mg" pct={dailyMicros.iron / 18} colors={colors} styles={styles} low={dailyMicros.iron > 0 && dailyMicros.iron < 12} onPress={() => setDrillNutrient(drillNutrient === 'iron' ? null : 'iron')} />
                    <MicroChipLg label="Zinc" value={dailyMicros.zinc > 0 ? `${Math.round(dailyMicros.zinc * 10) / 10}mg` : '—'} target="11mg" pct={dailyMicros.zinc / 11} colors={colors} styles={styles} low={dailyMicros.zinc > 0 && dailyMicros.zinc < 8} onPress={() => setDrillNutrient(drillNutrient === 'zinc' ? null : 'zinc')} />
                  </View>

                  <Text style={[styles.modalSectionTitle, { marginTop: 16, marginBottom: 8 }]}>Fats Panel</Text>
                  <View style={styles.microGridLg}>
                    <MicroChipLg label="Saturated" value={dailyMicros.saturatedFat > 0 ? `${Math.round(dailyMicros.saturatedFat)}g` : '—'} target="<20g" pct={dailyMicros.saturatedFat > 0 ? Math.min(dailyMicros.saturatedFat / 20, 1) : 0} colors={colors} styles={styles} warn={dailyMicros.saturatedFat > 20} onPress={() => setDrillNutrient(drillNutrient === 'saturatedFat' ? null : 'saturatedFat')} />
                    {/* Trans fat: target is 0g — any nonzero value warns. The
                        chip stays visible even at 0 because it's a default
                        completeness signal (we WANT to see "0g" confirmed). */}
                    <MicroChipLg label="Trans Fat" value={dailyMicros.transFat > 0 ? `${(Math.round(dailyMicros.transFat * 10) / 10)}g` : (dailyMicros.transFat === 0 ? '0g' : '—')} target="0g" pct={dailyMicros.transFat > 0 ? Math.min(dailyMicros.transFat / 2, 1) : 0} colors={colors} styles={styles} warn={dailyMicros.transFat > 0} onPress={() => setDrillNutrient(drillNutrient === 'transFat' ? null : 'transFat')} />
                    <MicroChipLg label="Cholesterol" value={dailyMicros.cholesterol > 0 ? `${Math.round(dailyMicros.cholesterol)}mg` : '—'} target="<300mg" pct={dailyMicros.cholesterol > 0 ? Math.min(dailyMicros.cholesterol / 300, 1) : 0} colors={colors} styles={styles} warn={dailyMicros.cholesterol > 300} onPress={() => setDrillNutrient(drillNutrient === 'cholesterol' ? null : 'cholesterol')} />
                    <MicroChipLg label="Mono" value={dailyMicros.monounsaturatedFat > 0 ? `${Math.round(dailyMicros.monounsaturatedFat)}g` : '—'} target="25g" pct={dailyMicros.monounsaturatedFat / 25} colors={colors} styles={styles} onPress={() => setDrillNutrient(drillNutrient === 'monounsaturatedFat' ? null : 'monounsaturatedFat')} />
                    <MicroChipLg label="Poly" value={dailyMicros.polyunsaturatedFat > 0 ? `${Math.round(dailyMicros.polyunsaturatedFat)}g` : '—'} target="15g" pct={dailyMicros.polyunsaturatedFat / 15} colors={colors} styles={styles} onPress={() => setDrillNutrient(drillNutrient === 'polyunsaturatedFat' ? null : 'polyunsaturatedFat')} />
                    <MicroChipLg label="Omega-3" value={dailyMicros.omega3 > 0 ? `${Math.round(dailyMicros.omega3)}mg` : '—'} target="1600mg" pct={dailyMicros.omega3 / 1600} colors={colors} styles={styles} low={dailyMicros.omega3 > 0 && dailyMicros.omega3 < 1000} onPress={() => setDrillNutrient(drillNutrient === 'omega3' ? null : 'omega3')} />
                  </View>

                  <Text style={[styles.modalSectionTitle, { marginTop: 16, marginBottom: 8 }]}>Vitamins</Text>
                  <View style={styles.microGridLg}>
                    <MicroChipLg label="Vitamin D" value={dailyMicros.vitaminD > 0 ? `${(Math.round(dailyMicros.vitaminD * 10) / 10)}mcg` : '—'} target="15mcg" pct={dailyMicros.vitaminD / 15} colors={colors} styles={styles} low={dailyMicros.vitaminD > 0 && dailyMicros.vitaminD < 10} onPress={() => setDrillNutrient(drillNutrient === 'vitaminD' ? null : 'vitaminD')} />
                    <MicroChipLg label="Vitamin C" value={dailyMicros.vitaminC > 0 ? `${Math.round(dailyMicros.vitaminC)}mg` : '—'} target="90mg" pct={dailyMicros.vitaminC / 90} colors={colors} styles={styles} low={dailyMicros.vitaminC > 0 && dailyMicros.vitaminC < 60} onPress={() => setDrillNutrient(drillNutrient === 'vitaminC' ? null : 'vitaminC')} />
                    <MicroChipLg label="Vitamin B12" value={dailyMicros.vitaminB12 > 0 ? `${(Math.round(dailyMicros.vitaminB12 * 10) / 10)}mcg` : '—'} target="2.4mcg" pct={dailyMicros.vitaminB12 / 2.4} colors={colors} styles={styles} low={dailyMicros.vitaminB12 > 0 && dailyMicros.vitaminB12 < 1.6} onPress={() => setDrillNutrient(drillNutrient === 'vitaminB12' ? null : 'vitaminB12')} />
                    <MicroChipLg label="Folate" value={dailyMicros.folate > 0 ? `${Math.round(dailyMicros.folate)}mcg` : '—'} target="400mcg" pct={dailyMicros.folate / 400} colors={colors} styles={styles} low={dailyMicros.folate > 0 && dailyMicros.folate < 270} onPress={() => setDrillNutrient(drillNutrient === 'folate' ? null : 'folate')} />
                    <MicroChipLg label="Vitamin A" value={dailyMicros.vitaminA > 0 ? `${dailyMicros.vitaminA}%` : '—'} target="100% DV" pct={dailyMicros.vitaminA / 100} colors={colors} styles={styles} low={dailyMicros.vitaminA > 0 && dailyMicros.vitaminA < 50} onPress={() => setDrillNutrient(drillNutrient === 'vitaminA' ? null : 'vitaminA')} />
                  </View>

                  {/* Advanced section: each chip renders only when present
                      (or when the user expands). Avoids flooding the default
                      view while still surfacing real data when it exists. */}
                  {(() => {
                    // Per-chip render config — target, RDA / cap, decimals.
                    // Mirrors ADVANCED_MICRO_CHIPS ordering exactly.
                    const ADV: Array<{
                      key: string; target: string; rda: number;
                      // 'g' | 'mg' | 'mcg'
                      unit: 'g' | 'mg' | 'mcg';
                      lowAt?: number;
                      // Decimals at display time. Trace minerals (boron,
                      // copper) need 2 decimals; most use 0–1.
                      decimals: 0 | 1 | 2;
                    }> = [
                      { key: 'choline',    target: '550mg',  rda: 550,  unit: 'mg',  lowAt: 350, decimals: 0 },
                      { key: 'iodine',     target: '150mcg', rda: 150,  unit: 'mcg', lowAt: 100, decimals: 0 },
                      { key: 'vitaminK',   target: '120mcg', rda: 120,  unit: 'mcg', lowAt: 80,  decimals: 0 },
                      { key: 'vitaminE',   target: '15mg',   rda: 15,   unit: 'mg',  lowAt: 10,  decimals: 1 },
                      { key: 'phosphorus', target: '700mg',  rda: 700,  unit: 'mg',  lowAt: 500, decimals: 0 },
                      { key: 'selenium',   target: '55mcg',  rda: 55,   unit: 'mcg', lowAt: 35,  decimals: 0 },
                      { key: 'copper',     target: '0.9mg',  rda: 0.9,  unit: 'mg',  lowAt: 0.6, decimals: 2 },
                      { key: 'manganese',  target: '2.3mg',  rda: 2.3,  unit: 'mg',  lowAt: 1.4, decimals: 2 },
                      { key: 'boron',      target: '≤20mg',  rda: 20,   unit: 'mg',  decimals: 2 },
                      { key: 'omega6',     target: '12g',    rda: 12000, unit: 'mg', decimals: 0 },
                      { key: 'caffeine',   target: '<400mg', rda: 400,  unit: 'mg',  decimals: 0 },
                      { key: 'alcohol',    target: '0g',     rda: 0,    unit: 'g',   decimals: 1 },
                    ];
                    const rendered = ADV.filter(c => showAllAdvanced || (dailyMicros[c.key] || 0) > 0);
                    if (rendered.length === 0 && !showAllAdvanced) {
                      // Show a thin entrypoint that expands the section so
                      // users can discover the advanced chips even with no
                      // current values.
                      return (
                        <TouchableOpacity
                          onPress={() => setShowAllAdvanced(true)}
                          accessibilityRole="button"
                          accessibilityLabel="Show advanced micronutrients"
                          style={{ marginTop: 14, paddingVertical: 8, alignItems: 'center' }}>
                          <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textSecondary }}>
                            Show advanced micronutrients ›
                          </Text>
                        </TouchableOpacity>
                      );
                    }
                    return (
                      <>
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 16, marginBottom: 8 }}>
                          <Text style={[styles.modalSectionTitle, { flex: 1, marginBottom: 0 }]}>Advanced</Text>
                          <TouchableOpacity
                            onPress={() => setShowAllAdvanced(v => !v)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            accessibilityRole="button"
                            accessibilityLabel={showAllAdvanced ? 'Hide empty advanced chips' : 'Show all advanced micronutrients'}>
                            <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textSecondary }}>
                              {showAllAdvanced ? 'Show less' : 'Show all'}
                            </Text>
                          </TouchableOpacity>
                        </View>
                        <View style={styles.microGridLg}>
                          {rendered.map(c => {
                            const raw = Number(dailyMicros[c.key] || 0);
                            const fac = c.decimals === 0 ? 1 : c.decimals === 1 ? 10 : 100;
                            const display = raw > 0 ? `${Math.round(raw * fac) / fac}${c.unit}` : '—';
                            const pct = c.rda > 0 ? raw / c.rda : 0;
                            const low = c.lowAt != null && raw > 0 && raw < c.lowAt;
                            // Caps (alcohol = 0g target, boron upper limit,
                            // caffeine cap): warn when exceeded instead of "low".
                            const warn =
                              (c.key === 'alcohol' && raw > 0) ||
                              (c.key === 'boron' && raw > 20) ||
                              (c.key === 'caffeine' && raw > 400);
                            return (
                              <MicroChipLg
                                key={c.key}
                                label={microDisplayLabel(c.key)}
                                value={display}
                                target={c.target}
                                pct={pct}
                                colors={colors}
                                styles={styles}
                                low={low}
                                warn={warn}
                                onPress={() => setDrillNutrient(drillNutrient === c.key ? null : c.key)}
                              />
                            );
                          })}
                        </View>
                        <Text style={{ fontSize: 10, color: colors.textMuted, marginTop: 6, lineHeight: 14 }}>
                          Boron, caffeine, and alcohol are upper-limit chips — the bar fills as the value approaches the cap.
                        </Text>
                      </>
                    );
                  })()}

                  {!hasMicros && <Text style={styles.microNoData}>Nutrition details load with your next plan.</Text>}
                </View>

                {/* Legend */}
                <View style={{ flexDirection: 'row', gap: 16, paddingVertical: 12, justifyContent: 'center' }}>
                  {[
                    { label: 'On track', color: colors.primary },
                    { label: 'Below target', color: colors.warning },
                    { label: 'Above target', color: colors.error },
                    { label: PROCESSING_TIER_INFO.minimally_processed.label, color: PROCESSING_TIER_INFO.minimally_processed.color },
                    { label: PROCESSING_TIER_INFO.processed.label, color: PROCESSING_TIER_INFO.processed.color },
                    { label: PROCESSING_TIER_INFO.ultra_processed.label, color: PROCESSING_TIER_INFO.ultra_processed.color },
                  ].map(l => (
                    <View key={l.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: l.color }} />
                      <Text style={{ fontSize: 9, color: colors.textMuted }}>{l.label}</Text>
                    </View>
                  ))}
                </View>
                </View>
              </ScrollView>
              <NutrientSourcePopup
                visible={!!drillNutrient}
                detail={selectedNutrientDetail}
                colors={colors}
                styles={styles}
                onClose={() => setDrillNutrient(null)}
              />
            </View>
          </View>
          )}
        </Modal>

        {/* Plant vs Meat protein drill-down modal */}
        <Modal
          visible={showProteinModal}
          transparent
          animationType="slide"
          onRequestClose={closeProteinModal}>
          {showProteinModal && (
          <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' }}>
            <View
              {...proteinModalSwipeHandlers}
              style={{
                backgroundColor: colors.background,
                borderTopLeftRadius: 24, borderTopRightRadius: 24,
                padding: 18, maxHeight: '85%',
              }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
                <Text style={{ fontSize: 18, fontWeight: '800', color: colors.textPrimary, flex: 1 }}>
                  Protein source today
                </Text>
                <TouchableOpacity onPress={closeProteinModal} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="close" size={22} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
              {effectiveProteinBreakdown && (() => {
                const plantG = effectiveProteinBreakdown.plant_total_g;
                const animalG = effectiveProteinBreakdown.animal_total_g;
                const total = plantG + animalG;
                const plantPct = total > 0 ? (plantG / total) * 100 : 0;
                return (
                  <ScrollView
                    showsVerticalScrollIndicator={false}
                    onScroll={handleProteinModalScroll}
                    scrollEventThrottle={16}
                    bounces>
                    <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
                      <View style={{ flex: 1, padding: 12, backgroundColor: '#22C55E22', borderRadius: 10 }}>
                        <Text style={{ fontSize: 10, color: '#16803D', fontWeight: '800', letterSpacing: 0.5 }}>PLANT</Text>
                        <Text style={{ fontSize: 22, fontWeight: '900', color: '#16803D', marginTop: 4 }}>
                          {Math.round(plantG)}<Text style={{ fontSize: 12, fontWeight: '700' }}>g</Text>
                        </Text>
                        <Text style={{ fontSize: 10, color: '#16803D' }}>{Math.round(plantPct)}% of protein</Text>
                      </View>
                      <View style={{ flex: 1, padding: 12, backgroundColor: '#E0783022', borderRadius: 10 }}>
                        <Text style={{ fontSize: 10, color: '#9A4810', fontWeight: '800', letterSpacing: 0.5 }}>ANIMAL</Text>
                        <Text style={{ fontSize: 22, fontWeight: '900', color: '#9A4810', marginTop: 4 }}>
                          {Math.round(animalG)}<Text style={{ fontSize: 12, fontWeight: '700' }}>g</Text>
                        </Text>
                        <Text style={{ fontSize: 10, color: '#9A4810' }}>{Math.round(100 - plantPct)}% of protein</Text>
                      </View>
                    </View>

                    {effectiveProteinBreakdown.plant.length > 0 && (
                      <>
                        <Text style={{ fontSize: 12, fontWeight: '800', color: '#16803D', letterSpacing: 0.5, marginTop: 4, marginBottom: 6 }}>
                          PLANT SOURCES
                        </Text>
                        {effectiveProteinBreakdown.plant.map((it, i) => (
                          <View key={`p-${i}`} style={{
                            flexDirection: 'row', alignItems: 'center',
                            paddingVertical: 8, paddingHorizontal: 10, marginBottom: 6,
                            backgroundColor: colors.surface, borderRadius: 8,
                            borderLeftWidth: 3, borderLeftColor: '#22C55E',
                          }}>
                            <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: colors.textPrimary }}>{it.name}</Text>
                            <Text style={{ fontSize: 13, fontWeight: '800', color: '#16803D' }}>{Math.round(it.protein_g)}g</Text>
                          </View>
                        ))}
                      </>
                    )}

                    {effectiveProteinBreakdown.animal.length > 0 && (
                      <>
                        <Text style={{ fontSize: 12, fontWeight: '800', color: '#9A4810', letterSpacing: 0.5, marginTop: 10, marginBottom: 6 }}>
                          ANIMAL SOURCES
                        </Text>
                        {effectiveProteinBreakdown.animal.map((it, i) => (
                          <View key={`a-${i}`} style={{
                            flexDirection: 'row', alignItems: 'center',
                            paddingVertical: 8, paddingHorizontal: 10, marginBottom: 6,
                            backgroundColor: colors.surface, borderRadius: 8,
                            borderLeftWidth: 3, borderLeftColor: '#E07830',
                          }}>
                            <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: colors.textPrimary }}>{it.name}</Text>
                            <Text style={{ fontSize: 13, fontWeight: '800', color: '#9A4810' }}>{Math.round(it.protein_g)}g</Text>
                          </View>
                        ))}
                      </>
                    )}

                    {effectiveProteinBreakdown.unclassified.length > 0 && (
                      <>
                        <Text style={{ fontSize: 12, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.5, marginTop: 10, marginBottom: 6 }}>
                          UNCLASSIFIED
                        </Text>
                        <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 6, fontStyle: 'italic' }}>
                          We don't know if these are plant or animal yet — re-log with a library food to classify.
                        </Text>
                        {effectiveProteinBreakdown.unclassified.map((it, i) => (
                          <View key={`u-${i}`} style={{
                            flexDirection: 'row', alignItems: 'center',
                            paddingVertical: 8, paddingHorizontal: 10, marginBottom: 6,
                            backgroundColor: colors.surface, borderRadius: 8,
                            borderLeftWidth: 3, borderLeftColor: colors.border,
                          }}>
                            <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: colors.textPrimary }}>{it.name}</Text>
                            <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textMuted }}>{Math.round(it.protein_g)}g</Text>
                          </View>
                        ))}
                      </>
                    )}

                    <View style={{ height: 24 }} />
                  </ScrollView>
                );
              })()}
            </View>
          </View>
          )}
        </Modal>

        {/* Meal rows — single unified list. Order is whatever the user
            arranged with the up/down arrows. */}
        <View style={[styles.meals, embedded && styles.mealsEmbedded]}>
          {visibleMeals.length > 0 && hasSwipeActions && !swipeHintDismissed && (
            <TouchableOpacity
              onPress={() => setSwipeHintDismissed(true)}
              activeOpacity={0.6}
              hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
              style={{ paddingHorizontal: 2, paddingBottom: 6, marginTop: -2 }}>
              <Text style={{ fontSize: 10, color: colors.textMuted, fontStyle: 'italic' }}>
                swipe a meal to see actions
              </Text>
            </TouchableOpacity>
          )}
          {visibleMeals.map(({ key, legacyKey, reactKey, emoji, meal, macros }, i) => {
            const savedMarker = (meal as any)._savedMealId;
            const explicitSavedId = savedMarker != null ? Number(savedMarker) || 0 : 0;
            const isSaved = savedMarker === null
              ? false
              : explicitSavedId !== 0
                ? true
                : (savedMealNames ?? new Set<string>()).has(
                  `${(meal.meal || '').toLowerCase().trim()}|${(meal.items ?? meal.foods ?? []).length}|${Math.round(macros.calories)}`,
                );
            return (
              <FadeInView key={reactKey} delay={i * 40} duration={260} slideDistance={8}>
              <MealRow
                emoji={emoji}
                mealType={key}
                meal={meal}
                mealMacros={macros}
                checked={!!checkedMeals[key] || !!checkedMeals[legacyKey] || Number((meal as any)._loggedMealId ?? (meal as any).logged_meal_id ?? 0) > 0}
                onToggle={onToggleMeal}
                onEdit={onEditMeal}
                onRemove={onRemoveMeal}
                onHardDelete={onHardDeleteMeal}
                onToggleRoutine={onToggleRoutine}
                onShowRecipe={onShowRecipe}
                onMoveUp={i > 0 && onMoveMeal ? () => onMoveMeal(key, -1) : undefined}
                onMoveDown={i < visibleMeals.length - 1 && onMoveMeal ? () => onMoveMeal(key, 1) : undefined}
                onDuplicate={onDuplicateMeal ? () => onDuplicateMeal(key, meal) : undefined}
                onSplit={onSplitMeal ? () => onSplitMeal(key, meal) : undefined}
                onToggleSave={onToggleSave}
                colors={colors}
                styles={styles}
                mealAccent={section}
                isSaved={isSaved}
                isLast={i === visibleMeals.length - 1}
                flushEdges={embedded}
              />
              </FadeInView>
            );
          })}
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
          {/* Add-meal footer. If Favorites is wired, always expose it.
              The picker itself owns the empty state, which makes the
              path discoverable before the user has saved their first
              reusable meal. */}
          {onAddSnack && onAddFromSaved ? (
            <View style={styles.addMealActions}>
              <PressableScale
                style={[styles.addMealPrimary, styles.addMealPrimaryWide]}
                onPress={onAddSnack}
                scaleDown={0.96}
                accessibilityRole="button"
                accessibilityLabel="Add meal"
              >
                <Ionicons name="add-circle" size={20} color={addMealOnColor} style={{ marginRight: 7 }} />
                <Text style={styles.addMealPrimaryText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>Add Meal</Text>
              </PressableScale>
              <PressableScale
                style={[styles.addMealInline, styles.addMealSecondary]}
                onPress={onAddFromSaved}
                scaleDown={0.965}
                accessibilityRole="button"
                accessibilityLabel="Add meal from favorites"
              >
                <Ionicons name="heart-outline" size={15} color={section.strong} style={{ marginRight: 5 }} />
                <Text style={styles.addMealInlineText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>Favorites</Text>
              </PressableScale>
            </View>
          ) : onAddSnack ? (
            <PressableScale style={styles.addMealPrimary} onPress={onAddSnack} scaleDown={0.96} accessibilityRole="button" accessibilityLabel="Add meal">
              <Ionicons name="add-circle" size={20} color={addMealOnColor} style={{ marginRight: 7 }} />
              <Text style={styles.addMealPrimaryText}>Add Meal</Text>
            </PressableScale>
          ) : null}
        </View>

      </View>

      <ScoreInfoModal
        visible={scoreInfoOpen}
        onClose={() => setScoreInfoOpen(false)}
        eyebrow="NUTRITION SCORE"
        title="How it's calculated"
        iconName="nutrition-outline"
        iconColor={colors.primary}
        themeName={themeName}>
        <ScoreInfoBody themeName={themeName}>
          A 0-100 read of today's nutrition, computed server-side from
          logged meals. If no logged meal items exist, the server falls
          back to the active day plan. It blends calorie and macro
          alignment with quality measures like fiber, plants, and
          added-sugar restraint.
        </ScoreInfoBody>
        <ScoreInfoSection title="What goes in" themeName={themeName}>
          <ScoreInfoRow label="Adherence" value="calories, protein, carbs, fat" themeName={themeName} />
          <ScoreInfoRow label="Quality" value="fiber, plants, whole foods" themeName={themeName} />
          <ScoreInfoRow label="Micronutrients" value="key vitamins + minerals" themeName={themeName} />
        </ScoreInfoSection>
        <ScoreInfoSection title="Rating bands" themeName={themeName}>
          <ScoreInfoRow label="70+" value="In range" valueColor={colors.success} themeName={themeName} />
          <ScoreInfoRow label="45–69" value="Decent — gaps to close" valueColor={colors.warning} themeName={themeName} />
          <ScoreInfoRow label="Below 45" value="Off track today" valueColor={colors.error} themeName={themeName} />
        </ScoreInfoSection>
        <ScoreInfoBody themeName={themeName} muted>
          Logged days use meal history; unlogged planned days use the
          active plan. Days with no plan or meals stay at 0 and do not
          count against the weekly average.
        </ScoreInfoBody>
      </ScoreInfoModal>
    </View>
  );
}

// ── MealRow ───────────────────────────────────────────────────────────────────

function MealRow({
  mealType,
  meal,
  mealMacros,
  checked,
  onToggle,
  onEdit,
  onRemove,
  onHardDelete,
  onToggleRoutine,
  onShowRecipe,
  onMoveUp,
  onMoveDown,
  onDuplicate,
  onSplit,
  onToggleSave,
  colors,
  styles,
  mealAccent,
  isSaved,
  isLast,
  flushEdges,
}: {
  emoji?: string;  // unused — kept on the type for back-compat with callers
  mealType: string;
  meal: MealSuggestion;
  mealMacros: MealMacroTotals;
  checked: boolean;
  onToggle?: (mealType: string) => void;
  onEdit?:   (mealType: string, meal: MealSuggestion) => void;
  onRemove?: (mealType: string) => void;
  onHardDelete?: (mealType: string) => void;
  onToggleRoutine?: (mealType: string) => void;
  onShowRecipe?: (mealType: string, meal: MealSuggestion) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onDuplicate?: () => void;
  onSplit?: () => void;
  onToggleSave?: (mealType: string, meal: MealSuggestion) => void;
  colors: ReturnType<typeof getTheme>['colors'];
  styles: ReturnType<typeof createStyles>;
  mealAccent: ReturnType<typeof getTheme>['sections']['meals'];
  /** True when this meal's name matches one of the user's Saved Meals. */
  isSaved?: boolean;
  isLast?: boolean;
  flushEdges?: boolean;
}) {
  const [itemsExpanded, setItemsExpanded] = useState(false);
  const [checkBurstKey, setCheckBurstKey] = useState(0);
  const [showCheckBurst, setShowCheckBurst] = useState(false);
  const rowRef = useRef<View | null>(null);
  const checkBurstTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRoutineBacked = !!(meal as any)._routineId || !!meal.isRoutine;
  const loggedTime = formatLoggedMealTime(meal);

  const checkScale = useRef(new Animated.Value(checked ? 1 : 0)).current;
  const rowFlash = useRef(new Animated.Value(0)).current;
  const lastChecked = useRef<boolean>(checked);
  useEffect(() => {
    if (checked && !lastChecked.current) {
      import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
      if (checkBurstTimerRef.current) clearTimeout(checkBurstTimerRef.current);
      setShowCheckBurst(true);
      setCheckBurstKey(k => k + 1);
      checkBurstTimerRef.current = setTimeout(() => {
        setShowCheckBurst(false);
        checkBurstTimerRef.current = null;
      }, 780);
      checkScale.setValue(0);
      rowFlash.setValue(0);
      Animated.parallel([
        Animated.sequence([
          Animated.spring(checkScale, { toValue: 1.2, friction: 4, tension: 120, useNativeDriver: true }),
          Animated.spring(checkScale, { toValue: 1.0, friction: 5, tension: 120, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.timing(rowFlash, { toValue: 1, duration: 250, useNativeDriver: false }),
          Animated.timing(rowFlash, { toValue: 0, duration: 400, useNativeDriver: false }),
        ]),
      ]).start();
    } else if (!checked && lastChecked.current) {
      if (checkBurstTimerRef.current) {
        clearTimeout(checkBurstTimerRef.current);
        checkBurstTimerRef.current = null;
      }
      setShowCheckBurst(false);
      checkScale.setValue(0);
      rowFlash.setValue(0);
    }
    lastChecked.current = checked;
    return () => {
      if (checkBurstTimerRef.current) {
        clearTimeout(checkBurstTimerRef.current);
        checkBurstTimerRef.current = null;
      }
    };
  }, [checked, checkScale, rowFlash]);

  const rowFlashBg = rowFlash.interpolate({
    inputRange: [0, 1],
    outputRange: ['rgba(0,0,0,0)', mealAccent.strong + '20'],
  });
  const withItems = ensureItems(meal);
  const mealImageSpec = useMemo(() => resolveMealImage(meal as any), [meal]);
  const showMealPhoto = mealImageSpec.kind === 'photo';
  const itemRows = withItems.items && withItems.items.length > 0
    ? withItems.items.map((it, i) => ({
        key: `${it.name}-${i}`,
        name: it.name,
        amount: formatItemAmount(it),
        processingBucket: processingBucketForItem(it),
      }))
    : meal.foods.map((f, i) => ({
        key: `${f}-${i}`,
        name: f,
        amount: meal.amounts?.[i] ?? '',
        processingBucket: 'unknown' as ProcessingBucket,
      }));
  const itemCountLabel = itemRows.length > 0 ? `${itemRows.length} item${itemRows.length === 1 ? '' : 's'} · ` : '';
  const macroSummary = `${Math.round(mealMacros.calories)} cal · ${Math.round(mealMacros.protein)}g P · ${Math.round(mealMacros.carbs)}g C · ${Math.round(mealMacros.fat)}g F`;
  const mealSummary = `${loggedTime ? `${loggedTime} · ` : ''}${itemCountLabel}${macroSummary}`;
  const previewItemRows = itemRows.slice(0, 5);
  const hiddenPreviewItemCount = Math.max(0, itemRows.length - previewItemRows.length);

  const swipeActions: SwipeAction[] = [];
  if (onToggleSave) {
    swipeActions.push({
      icon: isSaved ? 'star' : 'star-outline',
      color: isSaved ? getContrastingTextColor(mealAccent.strong) : mealAccent.strong,
      bgColor: isSaved ? mealAccent.strong : mealAccent.strong + '22',
      onPress: () => onToggleSave(mealType, {
        ...meal,
        calories: mealMacros.calories,
        protein: mealMacros.protein,
        carbs: mealMacros.carbs,
        fat: mealMacros.fat,
      }),
      label: isSaved ? 'Saved' : 'Save',
    });
  }
  if (onToggleRoutine) {
    swipeActions.push({
      icon: isRoutineBacked ? 'repeat' : 'repeat-outline',
      color: isRoutineBacked ? getContrastingTextColor(mealAccent.strong) : mealAccent.strong,
      bgColor: isRoutineBacked ? mealAccent.strong : mealAccent.strong + '22',
      onPress: () => onToggleRoutine(mealType),
      label: isRoutineBacked ? 'Pinned' : 'Routine',
    });
  }
  if (onShowRecipe) swipeActions.push({ icon: 'restaurant-outline', color: getContrastingTextColor(colors.primary), bgColor: colors.primary, onPress: () => onShowRecipe(mealType, meal), label: 'Recipe' });
  if (onDuplicate) swipeActions.push({ icon: 'copy-outline', color: '#fff', bgColor: '#0EA5E9', onPress: onDuplicate, label: 'Again' });
  if (onSplit) swipeActions.push({ icon: 'git-branch-outline', color: '#fff', bgColor: '#8B5CF6', onPress: onSplit, label: 'Split' });
  if (onMoveUp) swipeActions.push({ icon: 'arrow-up', color: '#fff', bgColor: '#6B7280', onPress: onMoveUp, label: 'Up' });
  if (onMoveDown) swipeActions.push({ icon: 'arrow-down', color: '#fff', bgColor: '#6B7280', onPress: onMoveDown, label: 'Down' });
  if (onHardDelete || onRemove) {
    swipeActions.push({
      icon: 'trash-outline',
      color: '#fff',
      bgColor: colors.error ?? '#EF4444',
      onPress: () => (onHardDelete ? onHardDelete(mealType) : onRemove?.(mealType)),
      label: 'Remove',
    });
  }

  return (
    <View ref={rowRef} collapsable={false}>
      <SwipeableRow actions={swipeActions}>
        <Animated.View testID={`meal-row-${mealType}`} style={[styles.mealItem, flushEdges && styles.mealItemFlush, isLast && styles.mealItemLast, checked && styles.mealItemDone, { backgroundColor: rowFlashBg }]}>
          <View style={styles.mealTimeline}>
            {showCheckBurst && (
              <CompletionBurst
                key={checkBurstKey}
                variant="check"
                size={54}
                accentColor={mealAccent.strong}
                surfaceColor={mealAccent.strong + '18'}
                iconColor={mealAccent.strong}
                style={styles.mealCheckBurst}
              />
            )}
            <TouchableOpacity
              testID={`meal-check-${mealType}`}
              style={[styles.checkbox, checked && styles.checkboxDone]}
              onPress={() => onToggle?.(mealType)}
              disabled={!onToggle}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="checkbox"
              accessibilityLabel={`Mark ${meal.meal} as ${checked ? 'not done' : 'done'}`}
              accessibilityState={{ checked, disabled: !onToggle }}>
              {checked && (
                <Animated.View style={{ transform: [{ scale: checkScale }] }}>
                  <Ionicons name="checkmark" size={14} color={getContrastingTextColor(mealAccent.strong)} />
                </Animated.View>
              )}
            </TouchableOpacity>
          </View>

          {showMealPhoto ? (
            <View style={[styles.mealPhotoThumb, checked && styles.mealPhotoThumbDone]}>
              <MealThumbnail meal={meal as any} size="md" spec={mealImageSpec} />
            </View>
          ) : null}

          <View style={styles.mealContent}>
            <View style={styles.mealHeader}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text
                  testID={`meal-row-name-${e2eId(meal.meal)}`}
                  style={[styles.mealName, checked && styles.mealNameDone]}
                  numberOfLines={1}
                  ellipsizeMode="tail">
                  {meal.meal}
                </Text>
                <Text style={styles.mealSummary} numberOfLines={1}>{mealSummary}</Text>
              </View>

              <View style={styles.iconStrip}>
                {onEdit && (
                  <TouchableOpacity
                    onPress={() => onEdit(mealType, meal)}
                    hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                    style={styles.iconBtn}
                    accessibilityRole="button"
                    accessibilityLabel={`Edit ${meal.meal}`}>
                    <Ionicons name="pencil-outline" size={18} color={colors.textMuted} />
                  </TouchableOpacity>
                )}
              </View>
            </View>

            {itemRows.length > 0 && (
              <TouchableOpacity
                onPress={() => {
                  configureExpandAnimation(300);
                  setItemsExpanded(v => !v);
                }}
                activeOpacity={0.7}
                style={styles.mealDetailToggle}>
                <Text style={styles.mealDetailToggleText}>{itemsExpanded ? 'Hide ingredients' : 'Show ingredients'}</Text>
                {!itemsExpanded && (
                  <View style={styles.mealIngredientPreview} pointerEvents="none" accessible={false}>
                    {previewItemRows.map(r => {
                      const iconSpec = getFoodIconSpec(r.name);
                      return (
                        <View key={`preview-${r.key}`} style={styles.mealIngredientPreviewIcon}>
                          <MaterialCommunityIcons name={iconSpec.name} size={13} color={iconSpec.color} />
                        </View>
                      );
                    })}
                    {hiddenPreviewItemCount > 0 ? (
                      <View style={styles.mealIngredientPreviewMore}>
                        <Text style={styles.mealIngredientPreviewMoreText}>+{hiddenPreviewItemCount}</Text>
                      </View>
                    ) : null}
                  </View>
                )}
                <Ionicons name={itemsExpanded ? 'chevron-up' : 'chevron-down'} size={13} color={colors.textMuted} />
              </TouchableOpacity>
            )}

            {itemRows.length > 0 && itemsExpanded ? (
              <View style={styles.mealFoodsDetail}>
                {itemRows.map(r => {
                  const iconSpec = getFoodIconSpec(r.name);
                  const processingInfo = PROCESSING_TIER_INFO[r.processingBucket];
                  const showProcessingBadge = r.processingBucket !== 'unknown';
                  return (
                    <View key={r.key} style={styles.mealFoodRow}>
                      <View style={[styles.mealFoodProcessingDot, { backgroundColor: showProcessingBadge ? processingInfo.color : colors.border }]} />
                      <MaterialCommunityIcons
                        name={iconSpec.name}
                        size={14}
                        color={iconSpec.color}
                        style={{ marginRight: 6, marginTop: 1, opacity: checked ? 0.5 : 1 }}
                      />
                      <Text style={[styles.mealFoodName, checked && styles.mealFoodsDone, { flex: 1, minWidth: 0 }]} numberOfLines={2}>
                        {r.name}
                      </Text>
                      {showProcessingBadge && (
                        <Text
                          style={[
                            styles.mealFoodProcessingBadge,
                            {
                              color: processingInfo.color,
                              backgroundColor: processingInfo.color + '14',
                              borderColor: processingInfo.color + '44',
                            },
                          ]}
                          numberOfLines={1}
                          accessibilityLabel={processingInfo.label}>
                          {processingInfo.rowLabel}
                        </Text>
                      )}
                      {r.amount ? (
                        <Text style={styles.mealFoodAmount}>{r.amount}</Text>
                      ) : null}
                    </View>
                  );
                })}
                {meal.instructions && (
                  <View style={styles.recipeBox}>
                    <Text style={styles.recipeLabel}>Recipe</Text>
                    <Text style={styles.recipeText} numberOfLines={3}>{meal.instructions}</Text>
                  </View>
                )}
              </View>
            ) : null}
          </View>
        </Animated.View>
      </SwipeableRow>
    </View>
  );
}

const NutritionCard = memo(NutritionCardInner);
export default NutritionCard;

function formatLoggedMealTime(meal: MealSuggestion): string | null {
  const raw = (meal as any)._consumedAt ?? (meal as any).consumed_at ?? (meal as any).created_at;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function MicroChipLg({ label, value, target, pct, colors, styles, warn, low, onPress }: {
  label: string; value: string; target: string; pct: number;
  colors: ReturnType<typeof getTheme>['colors'];
  styles: ReturnType<typeof createStyles>;
  warn?: boolean; low?: boolean;
  onPress?: () => void;
}) {
  const barPct = Math.min(pct, 1);
  const noData = value === '—';
  const barColor = noData ? colors.border : warn ? colors.error : low ? '#F59E0B' : colors.primary;
  // Accessibility: state must NOT be color-only. A small glyph next to
  // the label communicates the same state for color-blind users and
  // shows up in VoiceOver via accessibilityHint. Glyph map:
  //   warn   → arrow-up   (over target / "too high")
  //   low    → arrow-down (under target / "low")
  //   ontrk  → checkmark  (in band)
  //   no data → no glyph; we show "—" already
  const stateGlyph: 'arrow-up-circle' | 'arrow-down-circle' | 'checkmark-circle' | null =
    noData ? null
    : warn ? 'arrow-up-circle'
    : low ? 'arrow-down-circle'
    : (pct >= 0.7 ? 'checkmark-circle' : null);
  const stateHint =
    noData ? 'No data yet'
    : warn ? `Above target ${target}`
    : low ? `Below target ${target}`
    : `On track toward ${target}`;
  const Wrapper = onPress ? TouchableOpacity : View;
  const wrapperProps = onPress
    ? { onPress, activeOpacity: 0.7, accessibilityRole: 'button' as const }
    : {};
  return (
    <Wrapper
      {...wrapperProps}
      style={styles.microChipLg}
      accessibilityLabel={`${label}, ${value}`}
      accessibilityHint={stateHint}
    >
      <View style={styles.microChipLgTop}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
          {stateGlyph ? (
            <Ionicons
              name={stateGlyph}
              size={11}
              color={barColor}
              // Decorative — the accessibilityHint above already
              // communicates the state to assistive tech.
              accessibilityElementsHidden
              importantForAccessibility="no"
            />
          ) : null}
          <Text
            style={[styles.microChipLgLabel, (warn || low) && { color: barColor }]}
            numberOfLines={1}
          >
            {label}
          </Text>
        </View>
        <Text style={[styles.microChipLgValue, noData ? { color: colors.textMuted } : (warn || low) && { color: barColor }]}>{value}</Text>
      </View>
      <View style={styles.microChipLgBarTrack}>
        <View style={[styles.microChipLgBarFill, { width: `${Math.round(barPct * 100)}%` as any, backgroundColor: barColor }]} />
      </View>
      <Text style={[styles.microChipLgTarget, (warn || low) && { color: barColor }]}>{target}</Text>
    </Wrapper>
  );
}

function NutrientSourcePopup({
  visible,
  detail,
  colors,
  styles,
  onClose,
}: {
  visible: boolean;
  detail: MicroSourceDetail | null;
  colors: ReturnType<typeof getTheme>['colors'];
  styles: ReturnType<typeof createStyles>;
  onClose: () => void;
}) {
  if (!visible || !detail) return null;

  return (
    <View style={styles.nutrientPopupOverlay}>
      <TouchableOpacity
        activeOpacity={1}
        style={StyleSheet.absoluteFillObject}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close nutrient sources"
      />
      <View style={[styles.nutrientPopupCard, { backgroundColor: colors.surfaceRaised, borderColor: colors.border }]}>
        <View style={styles.nutrientPopupHeader}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.nutrientPopupTitle}>{detail.label} Sources</Text>
            <Text style={styles.nutrientPopupSubtitle}>
              {detail.contributions.length > 0
                ? `${formatMicroSourceAmount(detail.total)}${detail.unit} total today`
                : 'No item-level sources yet'}
            </Text>
          </View>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={styles.nutrientPopupClose}>
            <Ionicons name="close" size={20} color={colors.textMuted} />
          </TouchableOpacity>
        </View>

        {detail.contributions.length === 0 ? (
          <Text style={styles.nutrientPopupEmpty}>
            Per-food breakdown will appear after your next plan regeneration.
          </Text>
        ) : (
          <ScrollView style={styles.nutrientPopupScroll} showsVerticalScrollIndicator={false}>
            {detail.contributions.slice(0, 12).map((source, i) => {
              const pctOfTotal = detail.total > 0 ? source.amount / detail.total : 0;
              return (
                <View key={`${source.food}-${i}`} style={styles.nutrientSourceRow}>
                  <View style={styles.nutrientSourceTopRow}>
                    <Text style={styles.nutrientSourceName} numberOfLines={1}>{source.food}</Text>
                    <Text style={styles.nutrientSourceAmount}>
                      {formatMicroSourceAmount(source.amount)}{detail.unit}
                    </Text>
                  </View>
                  {source.meal ? <Text style={styles.nutrientSourceMeal}>from {source.meal}</Text> : null}
                  <View style={styles.nutrientSourceTrack}>
                    <View
                      style={[
                        styles.nutrientSourceFill,
                        {
                          width: `${Math.round(pctOfTotal * 100)}%` as any,
                          backgroundColor: colors.primary,
                        },
                      ]}
                    />
                  </View>
                </View>
              );
            })}
          </ScrollView>
        )}
      </View>
    </View>
  );
}

function MacroPill({ label, value, color, styles }: { label: string; value: number; color: string; styles: ReturnType<typeof createStyles> }) {
  return (
    <View style={[styles.pill, { borderColor: color + '55', backgroundColor: color + '12' }]}>
      <View style={[styles.pillDot, { backgroundColor: color }]} />
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
    borderRadius: 22,
    marginBottom: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    ...elevations.card,
  },
  cardEmbedded: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderColor: 'transparent',
    borderRadius: 0,
    marginBottom: 0,
    overflow: 'visible',
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    elevation: 0,
  },

  // ── Body ─────────────────────────────────────────────────────────────────────
  body: { padding: 14 },
  bodyEmbedded: {
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 0,
  },

  // Optional small subtitle when the parent passes a `title` prop
  // (used by the day-card flow to label "Today" / "Tomorrow"). Replaces
  // the old top-of-card header bar.
  titleSubtle: {
    ...typography.label,
    color: colors.textMuted,
    marginBottom: 10,
  },

  addMealActions: {
    flexDirection: 'row',
    gap: 9,
    marginTop: 14,
    alignItems: 'stretch',
  },
  addMealInline: {
    paddingVertical: 12,
    paddingHorizontal: 11,
    minHeight: 54,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: section.strong + '66',
    backgroundColor: section.soft,
  },
  addMealSecondary: {
    flex: 0.88,
    marginTop: 0,
    minWidth: 0,
  },
  addMealInlineText: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0,
    color: section.strong,
  },
  addMealPrimary: {
    marginTop: 10,
    paddingVertical: 15,
    paddingHorizontal: 16,
    minHeight: 56,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: section.strong,
    backgroundColor: section.strong,
    shadowColor: section.strong,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.30,
    shadowRadius: 12,
    elevation: 5,
  },
  addMealPrimaryWide: {
    flex: 1.42,
    marginTop: 0,
    minWidth: 0,
  },
  addMealPrimaryText: {
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0,
    color: getContrastingTextColor(section.strong),
  },

  glp1SupportCard: {
    marginTop: 10,
    marginBottom: 6,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary + '33',
    backgroundColor: colors.primary + '0F',
    gap: 8,
  },
  glp1SupportTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  glp1SupportIcon: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  glp1SupportTitle: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.primary,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  glp1SupportText: { fontSize: 11, color: colors.textSecondary, lineHeight: 15, marginTop: 2 },
  glp1ChipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  glp1Chip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.full,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.primary + '30',
  },
  glp1ChipText: { fontSize: 10, fontWeight: '700', color: colors.primary },

  scorePillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
    marginBottom: 12,
    flexWrap: 'wrap',
  },
  scorePill: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  scorePillLabel: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0,
  },
  scorePillValue: {
    fontSize: 14,
    fontWeight: '900',
    fontVariant: ['tabular-nums'] as any,
  },
  scorePillMeta: {
    maxWidth: 100,
    fontSize: 11,
    fontWeight: '700',
  },
  scoreInfoButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },

  // ── Modal card section ────────────────────────────────────────────────────────
  modalCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 16,
    marginBottom: 12,
    overflow: 'hidden',
    position: 'relative',
  },

  // ── Meals ────────────────────────────────────────────────────────────────────
  meals: { gap: 0, marginBottom: 14 },
  mealsEmbedded: { marginBottom: 0, gap: 0 },

  mealItem: {
    paddingVertical: 14,
    paddingHorizontal: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 10,
    position: 'relative',
    overflow: 'hidden',
  },
  mealItemFlush: {
    marginHorizontal: -16,
    paddingHorizontal: 16,
  },
  mealItemLast: {
    borderBottomWidth: 0,
  },
  mealItemGradient: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    borderRadius: 16,
    opacity: 0.18,
  },
  mealItemDone: {},

  mealTimeline: {
    width: 26,
    alignItems: 'center',
    position: 'relative',
    flexShrink: 0,
  },
  mealPhotoThumb: {
    width: 46,
    height: 46,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    flexShrink: 0,
  },
  mealPhotoThumbDone: {
    opacity: 0.62,
  },
  mealContent: {
    flex: 1,
    minWidth: 0,
    gap: 5,
  },
  mealHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },

  // Inline routine badge — small pill that sits next to the meal name
  // instead of taking its own row. Toggles pin/unpin on tap.
  routineBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
  },
  routineBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  // Trailing edit action stays large enough to hit cleanly.
  iconStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexShrink: 0,
  },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnText: {
    fontSize: 14,
    color: colors.textSecondary,
    fontWeight: '600',
  },

  checkbox: {
    width: 24, height: 24, borderRadius: 12,
    borderWidth: 2, borderColor: section.strong + '88',
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface,
    zIndex: 1,
  },
  mealCheckBurst: {
    position: 'absolute',
    top: -15,
    left: -13,
    zIndex: 0,
  },
  checkboxDone: { backgroundColor: section.strong, borderColor: section.strong },
  checkmark:    { fontSize: 12, color: '#fff', fontWeight: '800' },

  mealName:     { ...typography.sectionTitle, fontSize: 16, lineHeight: 20, fontWeight: '900', letterSpacing: 0, color: colors.textPrimary },
  mealNameDone: { textDecorationLine: 'line-through', color: colors.textSecondary },
  mealLoggedTime: { ...typography.micro, color: colors.textMuted, marginTop: 2 },
  mealSummary: { ...typography.micro, color: colors.textMuted, marginTop: 3, fontWeight: '700' },

  mealDetailToggle: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingVertical: 2,
  },
  mealDetailToggleText: {
    fontSize: 12,
    lineHeight: 16,
    color: colors.textSecondary,
    fontWeight: '700',
  },
  mealIngredientPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginLeft: 3,
  },
  mealIngredientPreviewIcon: {
    width: 21,
    height: 21,
    borderRadius: 10.5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  mealIngredientPreviewMore: {
    minWidth: 21,
    height: 21,
    paddingHorizontal: 5,
    borderRadius: 10.5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  mealIngredientPreviewMoreText: {
    ...typography.micro,
    fontSize: 9,
    lineHeight: 11,
    color: colors.textMuted,
    fontWeight: '900',
  },
  mealFoodsDetail: { gap: 5, marginTop: 3, paddingLeft: 0 },
  mealFoodRow:     { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mealFoodProcessingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  mealFoodName:    { ...typography.body, fontSize: 14, lineHeight: 19, fontWeight: '600', letterSpacing: 0, color: colors.textSecondary },
  mealFoodProcessingBadge: {
    flexShrink: 0,
    maxWidth: 118,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    fontSize: 9,
    fontWeight: '700',
  },
  mealFoodsDone:   { color: colors.textMuted },

  recipeBox: {
    backgroundColor: colors.background,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
    marginTop: 4,
  },
  recipeLabel: { ...typography.micro, color: colors.textSecondary, marginBottom: 4 },
  recipeText:  { ...typography.body, color: colors.textPrimary, lineHeight: 18 },

  mealBadges: { flexDirection: 'row', gap: 7, flexWrap: 'wrap', marginTop: 4 },

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
    minWidth: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  pillValue: { fontSize: 14, lineHeight: 17, fontWeight: '900', fontVariant: ['tabular-nums'] as any },
  pillLabel: { fontSize: 10, lineHeight: 12, fontWeight: '800', color: colors.textMuted, textTransform: 'lowercase', letterSpacing: 0 },

  // ── Nutrition details inline link (muted, supplementary) ────────────────
  microBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingVertical: 4,
    marginBottom: 10,
    gap: 3,
  },
  microBtnIcon: { fontSize: 11 },
  microBtnText: { fontSize: 12, fontWeight: '500', color: colors.textMuted },
  microBtnArrow: { fontSize: 12, fontWeight: '500', color: colors.textMuted, marginLeft: 1 },

  // ── Micro modal ──────────────────────────────────────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 36,
    maxHeight: '90%',
    overflow: 'hidden',
  },
  modalHero: {
    minHeight: 232,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 14,
    justifyContent: 'space-between',
    backgroundColor: colors.surfaceRaised,
  },
  modalHeroImage: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  modalHeroTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  modalHeroPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.full,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  modalHeroPillText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  modalHeroClose: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(2,6,23,0.38)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  modalHeroBottom: {
    gap: 12,
  },
  modalHeroScoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  modalHeroScoreBadge: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  modalHeroScore: {
    fontSize: 24,
    fontWeight: '900',
  },
  modalHeroTitle: {
    fontSize: 21,
    fontWeight: '900',
    color: '#FFFFFF',
  },
  modalHeroSubtitle: {
    fontSize: 12,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.78)',
    marginTop: 2,
  },
  modalHeroStats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  modalHeroStat: {
    width: '48%' as any,
    minHeight: 54,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  modalHeroStatDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginBottom: 4,
  },
  modalHeroStatValue: {
    fontSize: 14,
    fontWeight: '900',
    color: '#FFFFFF',
  },
  modalHeroStatUnit: {
    fontSize: 10,
    fontWeight: '800',
    color: 'rgba(255,255,255,0.72)',
  },
  modalHeroStatLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.66)',
    marginTop: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalTitle: { fontSize: 17, fontWeight: '800', color: colors.textPrimary },
  modalClose: { fontSize: 18, fontWeight: '700', color: colors.textMuted, padding: 4 },
  modalScroll: {},
  modalScrollContent: { paddingBottom: 18 },
  modalScrollableBody: {
    paddingHorizontal: 18,
    paddingTop: 14,
  },
  modalMacroRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 18,
  },
  modalMacroItem: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: section.soft,
    borderRadius: radius.md,
    paddingVertical: 10,
    gap: 2,
  },
  modalMacroVal: { fontSize: 16, fontWeight: '800' },
  modalMacroLabel: { fontSize: 9, fontWeight: '600', color: colors.textMuted },
  modalSectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  modalCardGradient: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  scoreOverviewCard: {
    padding: 0,
  },
  scoreOverviewTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
  },
  scoreOverviewBadge: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  scoreOverviewNumber: {
    fontSize: 24,
    fontWeight: '900',
  },
  scoreOverviewBadgeLabel: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginTop: -1,
  },
  scoreOverviewTitle: {
    fontSize: 15,
    fontWeight: '900',
    color: colors.textPrimary,
  },
  scoreOverviewSubtitle: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 17,
    marginTop: 3,
  },
  scoreDriverList: {
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
  scoreDriverRow: {
    gap: 5,
  },
  scoreDriverLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  scoreDriverLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.textSecondary,
  },
  scoreDriverValue: {
    fontSize: 11,
    fontWeight: '900',
  },
  scoreDriverTrack: {
    height: 7,
    borderRadius: 999,
    backgroundColor: colors.border + '80',
    overflow: 'hidden',
  },
  scoreDriverFill: {
    height: 7,
    borderRadius: 999,
  },
  scoreSignalRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border + '55',
  },
  scoreSignalChip: {
    flexGrow: 1,
    minWidth: 88,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: colors.surface + 'B8',
    borderWidth: 1,
    borderColor: colors.border + '88',
  },
  scoreSignalValue: {
    fontSize: 12,
    fontWeight: '900',
    color: colors.textPrimary,
  },
  scoreSignalLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textMuted,
    marginTop: 1,
  },
  scoreInsightList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  scoreInsightChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: radius.full,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  scoreInsightText: {
    fontSize: 10,
    fontWeight: '800',
  },
  gutSignalTile: {
    width: '32%' as any,
    alignItems: 'center',
    backgroundColor: colors.surface + 'B8',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderWidth: 1,
    borderColor: colors.border + '88',
    overflow: 'hidden',
  },
  gutSignalTileGradient: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  modalLegend: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 18,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 11, color: colors.textMuted, fontWeight: '500' },

  // ── Large micro chips (modal) ─────────────────────────────────────────────
  microGridLg: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  microChipLg: {
    width: '47%' as any,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
    gap: 4,
  },
  microChipLgTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  microChipLgLabel: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  microChipLgValue: { fontSize: 15, fontWeight: '800', color: colors.textPrimary },
  microChipLgBarTrack: {
    height: 5,
    backgroundColor: colors.border,
    borderRadius: 3,
    overflow: 'hidden',
  },
  microChipLgBarFill: { height: 5, borderRadius: 3 },
  microChipLgTarget: { fontSize: 10, fontWeight: '500', color: colors.textMuted },
  microNoData: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: 12,
    paddingHorizontal: 20,
    lineHeight: 18,
  },

  nutrientPopupOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.46)',
    paddingHorizontal: 14,
    paddingBottom: 18,
  },
  nutrientPopupCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 16,
    maxHeight: '72%',
    ...elevations.card,
  },
  nutrientPopupHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 12,
  },
  nutrientPopupTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  nutrientPopupSubtitle: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
  },
  nutrientPopupClose: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  nutrientPopupEmpty: {
    fontSize: 13,
    color: colors.textMuted,
    lineHeight: 18,
  },
  nutrientPopupScroll: {
    maxHeight: 360,
  },
  nutrientSourceRow: {
    marginBottom: 10,
  },
  nutrientSourceTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    marginBottom: 3,
  },
  nutrientSourceName: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  nutrientSourceAmount: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.primary,
  },
  nutrientSourceMeal: {
    fontSize: 11,
    color: colors.textMuted,
    marginBottom: 4,
  },
  nutrientSourceTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  nutrientSourceFill: {
    height: 4,
    borderRadius: 2,
  },

  // ── Footer ───────────────────────────────────────────────────────────────────
  footer:     { paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border },
  footerText: { fontSize: 12, color: colors.textMuted, textAlign: 'center' },

  mealFoodAmount: {
    fontSize: 11,
    fontWeight: '700',
    color: section.strong,
  },
});
