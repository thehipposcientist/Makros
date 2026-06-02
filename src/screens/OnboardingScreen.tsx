import { useState, useRef, useCallback, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  ScrollView,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ImageBackground,
  ActivityIndicator,
  Modal,
  findNodeHandle,
  UIManager,
  LayoutAnimation,
  Keyboard,
  useWindowDimensions,
} from 'react-native';
import type { ImageSourcePropType } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import { Ionicons } from '@expo/vector-icons';
import Animated, { LinearTransition } from 'react-native-reanimated';
import FadeInView from '../components/FadeInView';
import PressableScale from '../components/PressableScale';
import EquipmentInfoSheet from '../components/EquipmentInfoSheet';
import BirthdateInput from '../components/BirthdateInput';
import { deriveAge, validateBirthdate } from '../utils/age';
import { cmToFeetInches, feetInchesToCm, lbsToUnit, unitToLbs } from '../utils/units';
// Lazy reference — keeps expo-image-picker out of the cold-start parse pass.
const ImagePicker: typeof import('expo-image-picker') = (() => {
  let mod: any = null;
  return new Proxy({} as any, {
    get: (_t, prop) => {
      if (!mod) mod = require('expo-image-picker');
      return mod[prop as string];
    },
  });
})();
import { colors, radius } from '../constants/theme';
import {
  CardioBaseline,
  Goal, GoalPace, Gender, UserProfile, PhysicalStats, GoalDetails, GoalSelection,
  StrengthBaselineLiftKey, StrengthBaselines, StrengthEquipmentSettings,
  InjuryEntry,
} from '../types';
import { useMetaData, pacesForGoal } from '../hooks/useMetaData';
import { useLiveFoodSearch } from '../hooks/useLiveFoodSearch';
import { billingEntitlementToProfilePatch, scanFoodsPhoto, scanEquipmentPhoto, matchGoal, getMe } from '../services/api';
import { FREE_TIER_SUMMARY, PRO_TIER_SUMMARY, requirePro, type ProFeature } from '../utils/subscription';
import {
  APPLE_HEALTH_PERMISSION_COPY,
  APPLE_HEALTH_PERMISSION_ITEMS,
  APPLE_HEALTH_WRITE_ITEMS,
  isHealthKitAvailable,
  requestHealthPermissions,
} from '../services/appleHealth';
import { setAppleHealthEnabled as persistHealthEnabled } from '../utils/workoutHistory';
import { badgeLabelForSource } from '../utils/customFoodSearch';
import {
  DEFAULT_ADJUSTABLE_DUMBBELLS,
  DEFAULT_PLATE_PAIRS_LBS,
  PLATE_PAIR_OPTIONS_LBS,
  hasAdjustableDumbbells,
  hasPlateLoadedEquipment,
  normalizeStrengthEquipmentSettings,
} from '../utils/strengthEquipmentSettings';
import { dynamicTextProps } from '../utils/dynamicType';
import { goalEquipmentWarnings } from '../utils/goalEquipmentGuardrails';
import { getGoalCardImageSource } from '../utils/goalCardImages';
import {
  LAUNCH_GOALS, PRIMARY_GOALS, GOAL_CATEGORIES, ENDURANCE_EVENT_GOALS,
  SIGNUP_GOAL_MATCH_IDS,
  goalCategory,
  isEnduranceEventGoal,
  launchGoalIdFor,
} from '../constants/goalConfig';
import { pexelsPhoto, STOCK_IMAGES } from '../constants/stockImages';
import { HEALTH_PLATFORM_LABEL, HEALTH_PLATFORM_STATUS_COPY } from '../constants/platformHealth';

function OnboardingPhotoBanner({
  uri,
  title,
  subtitle,
  variant = 'hero',
}: {
  uri: string;
  title: string;
  subtitle: string;
  variant?: 'hero' | 'compact';
}) {
  const compact = variant === 'compact';
  return (
    <ImageBackground
      source={{ uri }}
      resizeMode="cover"
      style={[
        styles.onboardingPhoto,
        compact ? styles.onboardingPhotoCompact : styles.onboardingPhotoHero,
      ]}
      imageStyle={[
        styles.onboardingPhotoImage,
        compact ? styles.onboardingPhotoImageCompact : styles.onboardingPhotoImageHero,
      ]}
    >
      <View style={styles.onboardingPhotoScrim} />
      <LinearGradient
        colors={['rgba(21,199,184,0.08)', 'rgba(7,13,15,0.18)', 'rgba(7,13,15,0.76)']}
        locations={[0, 0.42, 1]}
        start={{ x: 0.08, y: 0 }}
        end={{ x: 0.92, y: 1 }}
        style={styles.onboardingPhotoGradient}
      />
      <View style={[styles.onboardingPhotoCopy, compact && styles.onboardingPhotoCopyCompact]}>
        <Text style={[styles.onboardingPhotoTitle, compact && styles.onboardingPhotoTitleCompact]}>{title}</Text>
        <Text style={[styles.onboardingPhotoSubtitle, compact && styles.onboardingPhotoSubtitleCompact]}>{subtitle}</Text>
      </View>
    </ImageBackground>
  );
}

function normalizeEquipmentSearchText(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function equipmentSearchTokenVariants(token: string): string[] {
  const variants = new Set([token]);
  if (token.endsWith('ies') && token.length > 3) variants.add(`${token.slice(0, -3)}y`);
  if (token.endsWith('es') && token.length > 4) variants.add(token.slice(0, -2));
  if (token.endsWith('s') && token.length > 3) variants.add(token.slice(0, -1));
  return [...variants];
}

function equipmentItemMatchesSearch(item: { name: string; aliases?: string[] }, query: string): boolean {
  const tokens = normalizeEquipmentSearchText(query).split(' ').filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = normalizeEquipmentSearchText([item.name, ...(item.aliases ?? [])].join(' '));
  return tokens.every(token => equipmentSearchTokenVariants(token).some(variant => haystack.includes(variant)));
}

function equipmentItemNames(item: { name: string; aliases?: string[] }): Set<string> {
  return new Set([item.name, ...(item.aliases ?? [])].map(name => name.toLowerCase()));
}

function equipmentItemSelected(item: { name: string; aliases?: string[] }, selected: string[]): boolean {
  const names = equipmentItemNames(item);
  return selected.some(name => names.has(name.toLowerCase()));
}

// ─── Step logic ───────────────────────────────────────────────────────────────

type SetupMode = 'quick' | 'custom';
type AppFocus = 'fitness' | 'nutrition' | 'both';
type WorkoutPlanningPreference = 'generated' | 'manual' | 'hybrid';
type StepKey = 'appFocus' | 'workoutStyle' | 'setupPath' | 'goal' | 'quickSetup' | 'goalRefine' | 'physicalStats' | 'trainingDays' | 'equipment' | 'baseline' | 'injuries' | 'foods' | 'supplements' | 'mealRoutine' | 'appleHealth' | 'context';

const STEP_LABELS: Record<StepKey, string> = {
  setupPath: 'Setup',
  appFocus: 'Focus',
  workoutStyle: 'Training',
  goal: 'Goal',
  quickSetup: 'Templates',
  goalRefine: 'Refine',
  physicalStats: 'About You',
  trainingDays: 'Schedule',
  equipment: 'Equipment',
  baseline: 'Baseline',
  foods: 'Foods',
  supplements: 'Supplements',
  mealRoutine: 'Meals',
  appleHealth: 'Health',
  injuries: 'Injuries',
  context: 'Final Details',
};

const STEP_HERO_KEYS = new Set<StepKey>([
  'appFocus',
  'workoutStyle',
  'setupPath',
  'quickSetup',
  'equipment',
  'baseline',
  'foods',
  'supplements',
  'appleHealth',
]);

let onboardingDraftPromptShownForSession = false;

/** Per-step domain tags. Steps tagged 'fitness' are skipped when the
 *  user picks `appFocus: 'nutrition'`; steps tagged 'nutrition' are
 *  skipped when `appFocus: 'fitness'`. 'both' steps always run. */
const STEP_DOMAIN: Record<StepKey, 'fitness' | 'nutrition' | 'both'> = {
  appFocus:      'both',
  workoutStyle:  'fitness',
  setupPath:     'both',
  goal:          'both',
  quickSetup:    'both',     // template picker spans both domains
  goalRefine:    'fitness',
  physicalStats: 'both',
  trainingDays:  'fitness',
  equipment:     'fitness',
  baseline:      'fitness',
  injuries:      'fitness',
  foods:         'nutrition',
  supplements:   'nutrition',
  mealRoutine:   'nutrition',
  appleHealth:   'both',
  context:       'both',
};

const FEATURE_OVERVIEW: Array<{
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  body: string;
}> = [
  {
    key: 'week',
    icon: 'calendar-outline',
    title: 'Stable weekly plans',
    body: 'A 7-day training week stays fixed while you complete, skip, swap, or log custom work.',
  },
  {
    key: 'meals',
    icon: 'restaurant-outline',
    title: 'Meals and macros',
    body: 'Track food, hydration, routines, supplements, scores, and grocery-friendly meal ideas.',
  },
  {
    key: 'scans',
    icon: 'scan-outline',
    title: 'AI scans',
    body: 'Analyze food, supplements, equipment, form clips, and body photos when Pro is active.',
  },
  {
    key: 'signals',
    icon: 'pulse-outline',
    title: 'Recovery and progress',
    body: 'See readiness, muscle recovery, strength trends, cardio work, body changes, and health signals.',
  },
];

function getSteps(setupMode: SetupMode, appFocus: AppFocus = 'both'): StepKey[] {
  // Meal routine moved out of onboarding — users can pin meals as routines
  // from the Home screen, which gives a much better UX than typing prose
  // at signup time.
  // Injuries step is intentionally custom-mode only. Quick mode is a
  // 60-second flow; users on quick can still add structured injuries
  // from EditProfile, and the legacy free-text path stays untouched.
  const base: StepKey[] = setupMode === 'quick'
    ? ['appFocus', 'workoutStyle', 'setupPath', 'goal', 'quickSetup', 'physicalStats']
    : ['appFocus', 'workoutStyle', 'setupPath', 'goal', 'physicalStats', 'trainingDays', 'equipment', 'baseline', 'injuries', 'foods'];
  if (appFocus === 'both') return base;
  return base.filter(step => {
    const domain = STEP_DOMAIN[step];
    return domain === 'both' || domain === appFocus;
  });
}

// ─── Supplement categories ────────────────────────────────────────────────────

const SUPPLEMENT_CATEGORIES = [
  {
    key: 'protein',
    icon: 'nutrition-outline',
    label: 'Protein',
    items: ['Whey Protein', 'Casein Protein', 'Plant Protein', 'Egg White Protein', 'Collagen Peptides'],
  },
  {
    key: 'performance',
    icon: 'flash-outline',
    label: 'Performance',
    items: ['Creatine Monohydrate', 'Beta-Alanine', 'L-Citrulline', 'Pre-Workout', 'Caffeine', 'HMB'],
  },
  {
    key: 'recovery',
    icon: 'fitness-outline',
    label: 'Recovery & Muscle',
    items: ['BCAA', 'EAA', 'L-Glutamine', 'Tart Cherry Extract', 'Electrolytes'],
  },
  {
    key: 'health',
    icon: 'heart-outline',
    label: 'Health & Vitamins',
    items: ['Vitamin D', 'Omega-3 / Fish Oil', 'Zinc', 'Multivitamin', 'Vitamin C', 'Iron', 'B12'],
  },
  {
    key: 'weight',
    icon: 'flame-outline',
    label: 'Weight Management',
    items: ['L-Carnitine', 'CLA', 'Green Tea Extract', 'Psyllium Fiber', 'Thermogenic'],
  },
  {
    key: 'sleep',
    icon: 'moon-outline',
    label: 'Sleep & Stress',
    items: ['Melatonin', 'Ashwagandha', 'ZMA', 'Magnesium Glycinate', 'L-Theanine'],
  },
];

// ─── Food presets ────────────────────────────────────────────────────────────

interface FoodPreset {
  id: string;
  label: string;
  description: string;
  image: ImageSourcePropType;
  items: string[];
}

const BASE_FOODS_PER_CATEGORY = 12;

const FOOD_PRESETS: FoodPreset[] = [
  {
    id: 'high_protein',
    label: 'High Protein',
    description: 'Lean meats, dairy, protein powder',
    image: { uri: pexelsPhoto('3756523') },
    items: [
      'Chicken Breast', 'Chicken Thighs', 'Ground Turkey', 'Turkey Bacon',
      'Lean Ground Beef', 'Sirloin Steak', 'Pork Tenderloin',
      'Salmon', 'Tuna', 'Cod', 'Tilapia', 'Shrimp',
      'Eggs', 'Egg Whites',
      'Greek Yogurt', 'Cottage Cheese', 'Skim Milk',
      'Whey Protein', 'Casein Protein',
      'Rice', 'Sweet Potato', 'Oats',
      'Broccoli', 'Spinach', 'Bell Peppers',
      'Olive Oil', 'Almonds',
    ],
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Mediterranean-style variety',
    image: { uri: pexelsPhoto('1640777') },
    items: [
      'Chicken Breast', 'Salmon', 'Eggs', 'Lean Ground Beef', 'Greek Yogurt',
      'Brown Rice', 'Quinoa', 'Sweet Potato', 'Whole Wheat Pasta', 'Oats', 'Whole Grain Bread',
      'Broccoli', 'Spinach', 'Carrots', 'Bell Peppers', 'Tomatoes', 'Cucumber', 'Lettuce',
      'Banana', 'Apple', 'Berries', 'Orange',
      'Olive Oil', 'Avocado', 'Almonds', 'Walnuts', 'Peanut Butter',
      'Black Beans', 'Chickpeas', 'Lentils',
    ],
  },
  {
    id: 'plant_based',
    label: 'Plant-Based',
    description: 'Vegan / vegetarian high-protein',
    image: { uri: pexelsPhoto('1640770') },
    items: [
      'Tofu', 'Tempeh', 'Seitan', 'Edamame',
      'Lentils', 'Black Beans', 'Chickpeas', 'Kidney Beans', 'Split Peas',
      'Quinoa', 'Brown Rice', 'Oats', 'Whole Grain Bread', 'Whole Wheat Pasta',
      'Peanut Butter', 'Almond Butter', 'Almonds', 'Cashews', 'Walnuts', 'Pumpkin Seeds', 'Chia Seeds', 'Hemp Seeds',
      'Avocado', 'Olive Oil', 'Tahini',
      'Broccoli', 'Spinach', 'Kale', 'Bell Peppers', 'Mushrooms', 'Sweet Potato', 'Carrots',
      'Banana', 'Apple', 'Berries',
      'Plant Protein Powder', 'Soy Milk', 'Nutritional Yeast',
    ],
  },
  {
    id: 'keto',
    label: 'Low Carb / Keto',
    description: 'High fat, very low carb',
    image: { uri: pexelsPhoto('3850888') },
    items: [
      'Chicken Breast', 'Chicken Thighs', 'Ground Beef', 'Ribeye Steak', 'Bacon', 'Pork Sausage',
      'Salmon', 'Sardines', 'Mackerel', 'Shrimp',
      'Eggs',
      'Butter', 'Ghee', 'Olive Oil', 'Coconut Oil', 'Avocado Oil', 'MCT Oil',
      'Avocado', 'Olives',
      'Heavy Cream', 'Cheddar Cheese', 'Mozzarella', 'Cream Cheese', 'Parmesan',
      'Almonds', 'Macadamia Nuts', 'Pecans', 'Peanut Butter (no sugar)',
      'Spinach', 'Kale', 'Broccoli', 'Cauliflower', 'Zucchini', 'Asparagus', 'Green Beans',
      'Berries (small amount)', 'Unsweetened Almond Milk',
    ],
  },
  {
    id: 'bulk',
    label: 'Lean Bulk',
    description: 'Calorie-dense for gaining mass',
    image: { uri: pexelsPhoto('6995259') },
    items: [
      'Chicken Breast', 'Chicken Thighs', 'Ground Beef (80/20)', 'Ribeye Steak',
      'Salmon', 'Tuna', 'Eggs',
      'Whole Milk', 'Greek Yogurt', 'Cottage Cheese', 'Cheddar Cheese',
      'White Rice', 'Brown Rice', 'Sweet Potato', 'Oats', 'Bagels', 'Whole Wheat Pasta', 'Sourdough Bread',
      'Banana', 'Apple', 'Grapes', 'Raisins', 'Dates', 'Honey',
      'Peanut Butter', 'Almond Butter', 'Olive Oil', 'Coconut Oil',
      'Avocado', 'Almonds', 'Cashews', 'Walnuts', 'Trail Mix',
      'Whey Protein', 'Mass Gainer',
      'Broccoli', 'Spinach', 'Carrots',
    ],
  },
  {
    id: 'cut',
    label: 'Cut / Fat Loss',
    description: 'High volume, low calorie density',
    image: { uri: pexelsPhoto('3757376') },
    items: [
      'Chicken Breast', 'Turkey Breast', 'White Fish', 'Shrimp',
      'Egg Whites', 'Eggs',
      'Nonfat Greek Yogurt', 'Cottage Cheese (low fat)', 'Skim Milk',
      'Oats', 'Brown Rice', 'Sweet Potato', 'Rice Cakes', 'Whole Wheat Bread',
      'Broccoli', 'Spinach', 'Kale', 'Cauliflower', 'Zucchini', 'Bell Peppers', 'Cucumber', 'Celery', 'Lettuce', 'Tomatoes', 'Mushrooms', 'Asparagus',
      'Berries', 'Apple', 'Orange', 'Watermelon',
      'Diet Soda', 'Sparkling Water', 'Black Coffee', 'Green Tea',
      'Whey Protein (isolate)', 'Casein Protein',
      'Olive Oil (small amount)', 'Almonds (portioned)',
    ],
  },
  {
    id: 'mediterranean',
    label: 'Mediterranean',
    description: 'Fish, olive oil, veggies, grains',
    image: { uri: pexelsPhoto('15913470') },
    items: [
      'Salmon', 'Sardines', 'Tuna', 'Mackerel', 'Shrimp', 'Cod',
      'Chicken Breast', 'Eggs', 'Feta Cheese', 'Greek Yogurt',
      'Olive Oil', 'Olives', 'Avocado',
      'Whole Grain Bread', 'Whole Wheat Pasta', 'Couscous', 'Farro', 'Quinoa', 'Brown Rice',
      'Tomatoes', 'Cucumber', 'Bell Peppers', 'Onion', 'Garlic', 'Spinach', 'Artichoke', 'Eggplant', 'Zucchini',
      'Lemon', 'Orange', 'Grapes', 'Figs', 'Apple', 'Berries',
      'Almonds', 'Walnuts', 'Pine Nuts', 'Pistachios',
      'Hummus', 'Tahini', 'Chickpeas', 'Lentils', 'White Beans',
    ],
  },
  {
    id: 'carnivore',
    label: 'Carnivore',
    description: 'Meat and animal products only',
    image: { uri: pexelsPhoto('17481109') },
    items: [
      'Ribeye Steak', 'Sirloin Steak', 'Ground Beef (80/20)', 'Ground Beef (grass-fed)',
      'Chicken Thighs', 'Chicken Breast', 'Chicken Wings',
      'Pork Chops', 'Pork Belly', 'Bacon', 'Pork Sausage',
      'Lamb Chops', 'Ground Lamb',
      'Salmon', 'Sardines', 'Mackerel', 'Cod', 'Tuna', 'Shrimp',
      'Eggs', 'Egg Yolks',
      'Butter', 'Ghee', 'Beef Tallow', 'Lard',
      'Heavy Cream', 'Hard Cheese',
      'Bone Broth',
      'Liver', 'Chicken Liver', 'Heart',
    ],
  },
];

const ALLERGY_OPTIONS = [
  { key: 'dairy',     label: 'Dairy' },
  { key: 'gluten',    label: 'Gluten' },
  { key: 'nuts',      label: 'Nuts' },
  { key: 'peanuts',   label: 'Peanuts' },
  { key: 'shellfish', label: 'Shellfish' },
  { key: 'fish',      label: 'Fish' },
  { key: 'eggs',      label: 'Eggs' },
  { key: 'soy',       label: 'Soy' },
  { key: 'sesame',    label: 'Sesame' },
  { key: 'pork',      label: 'Pork' },
  { key: 'beef',      label: 'Beef' },
  { key: 'alcohol',   label: 'Alcohol' },
];

function resolveFoodPresetItems(preset: FoodPreset, allFoods: Array<{ name: string }> | undefined): string[] {
  const lib = allFoods ?? [];
  const normalize = (s: string) => s.toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const libIndex = new Map<string, string>();
  for (const f of lib) {
    const k = normalize(f.name);
    if (k && !libIndex.has(k)) libIndex.set(k, f.name);
    const first = k.split(' ', 1)[0];
    if (first && !libIndex.has(first)) libIndex.set(first, f.name);
  }
  const resolved: string[] = [];
  for (const raw of preset.items) {
    const k = normalize(raw);
    const hit = libIndex.get(k) ?? libIndex.get(k.split(' ', 1)[0]);
    resolved.push(hit ?? raw);
  }
  return Array.from(new Set(resolved));
}

// Muscle groups moved to goalConfig target focuses

// ─── Equipment templates ──────────────────────────────────────────────────────

interface EquipmentTemplate {
  id: string;
  label: string;
  description: string;
  image: ImageSourcePropType;
  items: string[];
}

const EQUIPMENT_TEMPLATES: EquipmentTemplate[] = [
  {
    id: 'bodyweight',
    label: 'No Equipment',
    description: 'Bodyweight only',
    image: require('../../assets/images/card-backgrounds/workout-card-pilates-day.jpg'),
    items: ['Bodyweight / no equipment', 'Yoga mat'],
  },
  {
    id: 'home_basic',
    label: 'Home (Basic)',
    description: 'Adjustable DBs + bands',
    image: require('../../assets/images/card-backgrounds/workout-card-free-weights-day-female.jpg'),
    items: ['Adjustable dumbbells', 'Resistance bands (tube)', 'Mini band (loop)', 'Pull-up bar', 'Yoga mat', 'Jump rope', 'Foam roller'],
  },
  {
    id: 'home_full',
    label: 'Home Gym',
    description: 'Full home setup',
    image: require('../../assets/images/card-backgrounds/workout-card-build-strength-squat-female.jpg'),
    items: [
      'Dumbbells', 'Barbell', 'Kettlebell', 'Weight plates',
      'Flat bench', 'Squat rack', 'Pull-up bar',
      'Resistance bands (tube)', 'Mini band (loop)', 'Swiss / stability ball',
      'Yoga mat', 'Foam roller', 'Ab wheel',
    ],
  },
  {
    id: 'planet_fitness',
    label: 'Planet Fitness',
    description: 'Machines + dumbbells',
    image: require('../../assets/images/card-backgrounds/workout-card-leg-extension-day-female.jpg'),
    items: [
      'Dumbbells', 'EZ curl bar',
      'Dual cable station', 'Leg press', 'Leg extension', 'Leg curl machine',
      'Lat pulldown', 'Chest press machine', 'Seated row machine',
      'Shoulder press machine', 'Hip abduction machine', 'Hip adduction machine',
      'Smith machine', 'Assisted pull-up / dip machine', 'Pectoral fly / pec deck machine',
      'Treadmill', 'Stationary bike', 'Elliptical',
    ],
  },
  {
    id: 'commercial_gym',
    label: 'Commercial Gym',
    description: 'Full gym access',
    image: require('../../assets/images/card-backgrounds/workout-card-generic-gym-day-neutral.jpg'),
    items: [
      'Dumbbells', 'Barbell', 'Kettlebell', 'EZ curl bar', 'Weight plates', 'Trap bar',
      'Flat bench', 'Adjustable bench', 'Incline bench', 'Decline bench', 'Squat rack', 'Power rack',
      'Dual cable station', 'Leg press', 'Leg extension', 'Leg curl machine',
      'Lat pulldown', 'Chest press machine', 'Seated row machine',
      'Shoulder press machine', 'Hip abduction machine', 'Hip adduction machine',
      'Smith machine', 'Hack squat machine', 'Assisted pull-up / dip machine',
      'Pectoral fly / pec deck machine', 'Preacher curl bench', 'Preacher curl machine',
      'Plate-loaded chest press machine', 'High row machine', 'V-squat machine',
      'Rotary torso machine', 'Glute kickback machine', 'Hyperextension bench',
      'Standing calf raise machine', 'Seated calf raise machine',
      'Lateral raise machine', 'Belt squat machine', 'Hip thrust machine',
      'Ab wheel', 'Dip bars', 'Pull-up bar', 'Landmine attachment',
      'Treadmill', 'Stationary bike', 'Elliptical',
      'Rowing machine', 'Stair climber', 'Assault bike', 'Battle ropes',
      'Plyo box (24"+)', 'Step platform (low)', 'Medicine ball', 'Sandbag',
    ],
  },
  {
    id: 'crossfit',
    label: 'CrossFit Box',
    description: 'Barbells + cardio',
    image: require('../../assets/images/card-backgrounds/workout-card-hiit-day-female.jpg'),
    items: [
      'Barbell', 'Dumbbells', 'Kettlebell', 'Weight plates',
      'Pull-up bar', 'Dip bars', 'Plyo box (24"+)', 'Jump rope',
      'Rowing machine', 'Assault bike', 'Battle ropes', 'Medicine ball', 'Sandbag', 'Sled', 'Ab wheel',
    ],
  },
];

interface TrainingTemplate {
  id: string;
  label: string;
  description: string;
  daysPerWeek: string;
  workoutDuration: number;
}

const TRAINING_TEMPLATES: TrainingTemplate[] = [
  {
    id: 'starter',
    label: 'Starter',
    description: '3 days · 45-60 min',
    daysPerWeek: '3',
    workoutDuration: 60,
  },
  {
    id: 'busy',
    label: 'Busy Week',
    description: '3 days · 20-30 min',
    daysPerWeek: '3',
    workoutDuration: 30,
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: '4 days · 45-60 min',
    daysPerWeek: '4',
    workoutDuration: 60,
  },
  {
    id: 'committed',
    label: 'Committed',
    description: '5 days · 45-60 min',
    daysPerWeek: '5',
    workoutDuration: 60,
  },
];

type StrengthBaselineInput = Record<StrengthBaselineLiftKey, { weightLbs: string; reps: string }>;

const STRENGTH_BASELINE_LIFTS: Array<{
  key: StrengthBaselineLiftKey;
  label: string;
  help: string;
  exerciseSlug: string;
  name: string;
  weightPlaceholder: string;
  repsPlaceholder: string;
}> = [
  {
    key: 'bench_press',
    label: 'Barbell Bench Press',
    help: 'Flat bench, barbell only. Use a recent set you could repeat cleanly.',
    exerciseSlug: 'barbell_bench_press',
    name: 'Barbell Bench Press',
    weightPlaceholder: '135',
    repsPlaceholder: '8',
  },
  {
    key: 'squat',
    label: 'Barbell Squat',
    help: 'Back squat with a barbell. Use your normal working-set depth and stance.',
    exerciseSlug: 'barbell_squat',
    name: 'Barbell Squat',
    weightPlaceholder: '185',
    repsPlaceholder: '5',
  },
  {
    key: 'deadlift',
    label: 'Deadlift',
    help: 'Use a recent controlled pull from the floor or your usual deadlift setup.',
    exerciseSlug: 'deadlift',
    name: 'Deadlift',
    weightPlaceholder: '225',
    repsPlaceholder: '5',
  },
  {
    key: 'overhead_press',
    label: 'Military Press',
    help: 'Strict standing barbell press. No push press or leg drive.',
    exerciseSlug: 'overhead_press',
    name: 'Overhead Press',
    weightPlaceholder: '95',
    repsPlaceholder: '6',
  },
  {
    key: 'pull_up',
    label: 'Pull-Ups',
    help: 'Bodyweight reps from a full hang. Leave blank if you do not train these yet.',
    exerciseSlug: 'pullups',
    name: 'Pull-ups',
    weightPlaceholder: '',
    repsPlaceholder: '8',
  },
];

const CARDIO_BASELINE_MODES = ['Run', 'Bike', 'Row', 'Swim', 'Stairs', 'Hike'];

const emptyStrengthBaselineInputs = (): StrengthBaselineInput => ({
  bench_press: { weightLbs: '', reps: '' },
  squat: { weightLbs: '', reps: '' },
  deadlift: { weightLbs: '', reps: '' },
  overhead_press: { weightLbs: '', reps: '' },
  pull_up: { weightLbs: '', reps: '' },
});

const parseOptionalPositiveNumber = (raw: string): number | undefined => {
  const n = parseFloat(String(raw || '').trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const parseOptionalMinutes = (raw: string): number | undefined => {
  const s = String(raw || '').trim();
  if (!s) return undefined;
  if (s.includes(':')) {
    const parts = s.split(':').map(p => parseFloat(p));
    if (parts.length === 2 && parts.every(Number.isFinite)) {
      const [minutes, seconds] = parts;
      if (minutes >= 0 && seconds >= 0 && seconds < 60) return Math.round((minutes + seconds / 60) * 10) / 10;
    }
    return undefined;
  }
  return parseOptionalPositiveNumber(s);
};

// ─── Component ────────────────────────────────────────────────────────────────

interface OnboardingScreenProps {
  authToken: string;
  onComplete: (profile: UserProfile) => void;
  onExit?: () => void;
}

export default function OnboardingScreen({ authToken, onComplete, onExit }: OnboardingScreenProps) {
  const meta = useMetaData();
  const { width: screenWidth } = useWindowDimensions();
  const scrollRef = useRef<ScrollView>(null);
  const goalCarouselRef = useRef<ScrollView>(null);
  const carouselSectionRef = useRef<View>(null);

  const scrollCarouselIntoView = () => {
    if (!carouselSectionRef.current || !scrollRef.current) return;
    const scrollNode = findNodeHandle(scrollRef.current);
    if (!scrollNode) return;
    carouselSectionRef.current.measureLayout(
      scrollNode,
      (_x, y) => { scrollRef.current?.scrollTo({ y: Math.max(0, y - 16), animated: true }); },
      () => {},
    );
  };

  /** Scroll so the focused input is visible above the keyboard.
   *
   * `event.target` here is a React fiber tag (number on the new arch) or a
   * component instance — not a direct host-component ref, so calling
   * `node.measureLayout` on it warns. We resolve both sides to node handles
   * and use `UIManager.measureLayout`, which works for either case. */
  const scrollToInput = useCallback((event: any) => {
    const targetNode = findNodeHandle(event?.target);
    const scrollNode = findNodeHandle(scrollRef.current);
    if (!targetNode || !scrollNode) return;
    setTimeout(() => {
      UIManager.measureLayout(
        targetNode,
        scrollNode,
        () => {
          // Failure — fall back to scrolling to the end so the input is at least visible.
          scrollRef.current?.scrollToEnd({ animated: true });
        },
        (_x: number, y: number, _w: number, _h: number) => {
          scrollRef.current?.scrollTo({ y: Math.max(0, y - 80), animated: true });
        },
      );
    }, 350);
  }, []);

  // meta.goalConfig still available for legacy pace lookups

  // Step tracking
  const [setupMode, setSetupMode] = useState<SetupMode>('quick');
  // First-question signup answer — drives both step filtering during
  // onboarding and the default `hiddenSurfaces` on the saved profile.
  const [appFocus, setAppFocus] = useState<AppFocus>('both');
  // Fitness-workflow answer. `manual` maps to workoutManualMode so Pro
  // users can start with template/manual planning instead of a generated
  // PlanWeek; free users still get the manual-first tracker experience.
  const [workoutPlanningPreference, setWorkoutPlanningPreference] = useState<WorkoutPlanningPreference>('generated');
  const [currentStep, setCurrentStep] = useState(0);
  const [stepError, setStepError] = useState('');

  // Step 1 — Goal selection (hierarchical)
  const [selectedGoal, setSelectedGoal] = useState('build_muscle');
  const [goalScrollIdx, setGoalScrollIdx] = useState(0);
  const [goalQuery, setGoalQuery] = useState('');
  const [goalMatchLoading, setGoalMatchLoading] = useState(false);
  const [goalMatchReason, setGoalMatchReason] = useState<string | null>(null);
  const [goalQueryApplied, setGoalQueryApplied] = useState('');

  // Step 2 — Goal refinement (modifiers + target focus + pace)
  const [selectedModifiers, setSelectedModifiers] = useState<string[]>([]);
  const [selectedRegion, setSelectedRegion] = useState('balanced');
  const [pace, setPace] = useState<GoalPace>('moderate');
  const [targetWeight, setTargetWeight] = useState('');
  const [targetEvent, setTargetEvent] = useState('');

  // Step 3 — Physical stats
  const [weightLbs, setWeightLbs] = useState('');
  const [heightFeet, setHeightFeet] = useState('');
  const [heightInches, setHeightInches] = useState('');
  // Unit-input mode. Canonical storage stays imperial (weightLbs +
  // heightFeet/heightInches); metric inputs convert on toggle and on submit
  // so the backend payload + DB stay one canonical shape.
  const [unitSystem, setUnitSystem] = useState<'imperial' | 'metric'>('imperial');
  const [weightKg, setWeightKg] = useState('');
  const [heightCm, setHeightCm] = useState('');
  // Birthdate is the source of truth. `age` is derived for legacy
  // consumers (HRmax, TDEE) via the deriveAge helper so the cached int
  // stays accurate as users age.
  const [birthdate, setBirthdate] = useState<string | null>(null);
  const [gender, setGender] = useState<Gender | ''>('');
  // Step 4 — Training days
  const [daysPerWeek, setDaysPerWeekRaw] = useState('3');
  const [selectedTrainingTemplate, setSelectedTrainingTemplate] = useState<string>('starter');
  // Lifestyle activity outside of planned training. Drives the
  // calorie_calculator.step_2b nudge on top of the training-schedule
  // multiplier. Optional — when null we don't apply the nudge (preserves
  // legacy TDEE), but the question is visible on the training step so
  // most users fill it in during onboarding.
  type LifestyleLevel = 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';
  const [lifestyleActivity, setLifestyleActivity] = useState<LifestyleLevel | null>(null);
  // Preferred split (auto lets the planner pick based on goal + daysPerWeek).
  // Stored in the profile only when user explicitly overrides.
  const [preferredSplit, setPreferredSplit] = useState<string>('auto');
  const _defaultDaysOnboarding = (n: number): number[] => {
    const defaults: Record<number, number[]> = {
      1: [1], 2: [1, 4], 3: [1, 3, 5], 4: [1, 2, 4, 5],
      5: [1, 2, 3, 4, 5], 6: [1, 2, 3, 4, 5, 6], 7: [0, 1, 2, 3, 4, 5, 6],
    };
    return defaults[Math.min(7, Math.max(1, n))] ?? [1, 3, 5];
  };
  const [selectedTrainingDays, setSelectedTrainingDays] = useState<number[]>(_defaultDaysOnboarding(3));
  const setDaysPerWeek = (val: string) => {
    setDaysPerWeekRaw(val);
    const n = parseInt(val);
    if (!isNaN(n) && n >= 1 && n <= 7) setSelectedTrainingDays(_defaultDaysOnboarding(n));
  };
  const [workoutDuration, setWorkoutDuration] = useState(60);

  // Step 5 — Equipment
  const [selectedEquipment, setSelectedEquipment] = useState<string[]>([]);
  const [equipmentSettings, setEquipmentSettings] = useState<StrengthEquipmentSettings | undefined>(undefined);
  const [equipScanLoading, setEquipScanLoading] = useState(false);
  const [scannedEquipment, setScannedEquipment] = useState<string[]>([]);
  const [showEquipScanModal, setShowEquipScanModal] = useState(false);

  // Step 6 — Optional performance baseline
  const [strengthBaselineInputs, setStrengthBaselineInputs] = useState<StrengthBaselineInput>(emptyStrengthBaselineInputs);
  const [cardioCanJog10, setCardioCanJog10] = useState<boolean | null>(null);
  const [cardioComfortableDuration, setCardioComfortableDuration] = useState('');
  const [cardioMileTime, setCardioMileTime] = useState('');
  const [cardioFiveKTime, setCardioFiveKTime] = useState('');
  const [cardioPreferredModes, setCardioPreferredModes] = useState<string[]>([]);

  // Search filters & template selection
  const [equipmentSearch, setEquipmentSearch] = useState('');
  // "What is this?" info popup for an equipment chip (see EquipmentInfoSheet).
  const [equipmentInfo, setEquipmentInfo] = useState<{ name: string; slug?: string } | null>(null);
  const [foodSearch, setFoodSearch] = useState('');
  const [selectedEquipTemplate, setSelectedEquipTemplate] = useState<string | null>(null);
  const [selectedFoodPreset, setSelectedFoodPreset] = useState<string | null>(null);

  // Step 6 — Foods
  const [foodsAvailable, setFoodsAvailable] = useState<string[]>([]);
  const [foodScanLoading, setFoodScanLoading] = useState(false);
  const [foodScanContext, setFoodScanContext] = useState('');
  const [scannedFoods, setScannedFoods] = useState<{ name: string; selected: boolean }[]>([]);
  const {
    results: foodCatalogResults,
    loading: foodCatalogSearchLoading,
    error: foodCatalogSearchError,
  } = useLiveFoodSearch(authToken, foodSearch, { minChars: 2, allowAiFallback: false });

  // Allergies / dietary restrictions — plumbed through to UserProfile.allergies
  // and read by the meal-planner so suggested meals filter these out. Stored
  // as lowercase canonical category slugs ("dairy", "nuts", etc.).
  const [allergies, setAllergies] = useState<string[]>([]);

  // Step 7 — Supplements
  const [supplementsAvailable, setSupplementsAvailable] = useState<string[]>([]);
  const [showFoodScanModal, setShowFoodScanModal] = useState(false);

  // Step 7 — Meal routine
  const [mealRoutine, setMealRoutine] = useState('');

  // Step — Apple Health (iOS only)
  const [appleHealthEnabled, setAppleHealthEnabled] = useState(false);

  // Step 8 — Background context
  const [injuries, setInjuries] = useState('');
  const [experienceLevel, setExperienceLevel] = useState<'beginner' | 'intermediate' | 'advanced' | ''>('');
  const [lastWorkoutContext, setLastWorkoutContext] = useState('');

  // Structured injury capture (custom-mode 'injuries' step). Stored in
  // the same shape as profile.injuryEntries so onComplete can hand it
  // straight through. Empty list = "No injuries" (the user has either
  // explicitly answered no or skipped the step).
  const [onboardingInjuries, setOnboardingInjuries] = useState<InjuryEntry[]>([]);
  const [noInjuriesAck, setNoInjuriesAck] = useState(false);

  const steps = getSteps(setupMode, appFocus);
  const totalSteps = steps.length;
  const currentStepKey = steps[currentStep];
  const renderStepProgress = () => (
    <View style={styles.stepProgressBlock}>
      <Text style={styles.stepCounter}>
        Step {currentStep + 1} of {totalSteps}  ·  {STEP_LABELS[currentStepKey]}
      </Text>
      <View style={styles.progressBar}>
        {Array.from({ length: totalSteps }).map((_, i) => (
          <View key={i} style={[styles.progressSegment, i <= currentStep && styles.progressSegmentActive]} />
        ))}
      </View>
    </View>
  );
  const renderStepHero = (uri: string, title: string, subtitle: string) => (
    <>
      <OnboardingPhotoBanner key={uri} uri={uri} title={title} subtitle={subtitle} />
      {renderStepProgress()}
    </>
  );
  const renderEquipmentTemplateCard = (template: EquipmentTemplate, active: boolean, testIDPrefix: string) => (
    <TouchableOpacity
      key={template.id}
      testID={`${testIDPrefix}-${template.id}`}
      accessibilityLabel={`${testIDPrefix}-${template.id}`}
      accessibilityRole="button"
      style={[styles.equipmentTemplateCard, active && styles.equipmentTemplateCardActive]}
      onPress={() => applyTemplate(template)}
      activeOpacity={0.8}
    >
      <ImageBackground
        source={template.image}
        resizeMode="cover"
        imageStyle={styles.equipmentTemplatePhoto}
        style={styles.equipmentTemplateImage}
      >
        <View style={styles.equipmentTemplateScrim} />
        <View style={styles.equipmentTemplateTopRow}>
          <View style={styles.equipmentTemplatePill}>
            <Ionicons name="barbell-outline" size={12} color="#FFFFFF" />
            <Text style={styles.equipmentTemplatePillText}>{template.items.length}</Text>
          </View>
          {active ? (
            <View style={styles.equipmentTemplateCheck}>
              <Ionicons name="checkmark" size={14} color="#FFFFFF" />
            </View>
          ) : null}
        </View>
        <View style={styles.equipmentTemplateBody}>
          <Text style={styles.equipmentTemplateLabel} numberOfLines={1}>{template.label}</Text>
          <Text style={styles.equipmentTemplateDesc} numberOfLines={2}>{template.description}</Text>
        </View>
      </ImageBackground>
    </TouchableOpacity>
  );
  const renderFoodPresetCard = (preset: FoodPreset, active: boolean, testIDPrefix: string) => (
    <TouchableOpacity
      key={preset.id}
      testID={`${testIDPrefix}-${preset.id}`}
      accessibilityLabel={`${testIDPrefix}-${preset.id}`}
      accessibilityRole="button"
      style={[styles.foodPresetCard, active && styles.foodPresetCardActive]}
      onPress={() => applyFoodPreset(preset)}
      activeOpacity={0.8}
    >
      <ImageBackground
        source={preset.image}
        resizeMode="cover"
        imageStyle={styles.foodPresetPhoto}
        style={styles.foodPresetImage}
      >
        <View style={styles.foodPresetScrim} />
        <View style={styles.foodPresetTopRow}>
          <View style={styles.foodPresetPill}>
            <Ionicons name="nutrition-outline" size={12} color="#FFFFFF" />
            <Text style={styles.foodPresetPillText}>{preset.items.length}</Text>
          </View>
          {active ? (
            <View style={styles.foodPresetCheck}>
              <Ionicons name="checkmark" size={14} color="#FFFFFF" />
            </View>
          ) : null}
        </View>
        <View style={styles.foodPresetBody}>
          <Text style={styles.foodPresetLabel} numberOfLines={1}>{preset.label}</Text>
          <Text style={styles.foodPresetDesc} numberOfLines={2}>{preset.description}</Text>
        </View>
      </ImageBackground>
    </TouchableOpacity>
  );
  useEffect(() => {
    setCurrentStep(s => Math.min(s, Math.max(0, totalSteps - 1)));
  }, [totalSteps]);
  useEffect(() => { setStepError(''); }, [currentStepKey]);
  const equipmentGoalWarnings = goalEquipmentWarnings(selectedGoal, selectedEquipment);

  // ── Onboarding draft persistence ─────────────────────────────────────
  // Without this, closing the app mid-onboarding loses every step's input
  // and forces a full restart on relaunch — a major drop-off point on
  // first-run funnels. We snapshot every relevant field to AsyncStorage
  // on each state change, restore on mount with a "Continue where you
  // left off?" prompt, and clear the draft on successful completion.
  //
  // Versioned key so a future schema change can ignore stale drafts
  // safely instead of mis-applying old field shapes to new state.
  const ONBOARDING_DRAFT_KEY = 'onboardingDraft_v1';
  const [draftRestored, setDraftRestored] = useState(false);

  // Snapshot writer — runs after every relevant state change. Only saves
  // once the user is past the setup-branching pages OR has entered real
  // profile data, so the Quick/Advanced choice alone doesn't create a
  // noisy "continue setup?" prompt.
  useEffect(() => {
    if (!draftRestored) return; // wait until mount-time restore finishes
    const hasPassedSetupChoice = !!currentStepKey
      && currentStepKey !== 'appFocus'
      && currentStepKey !== 'workoutStyle'
      && currentStepKey !== 'setupPath';
    const hasMeaningfulProgress =
      hasPassedSetupChoice
      || weightLbs !== ''
      || heightFeet !== ''
      || selectedEquipment.length > 0
      || foodsAvailable.length > 0;
    if (!hasMeaningfulProgress) return;
    const snapshot = {
      v: 1,
      savedAt: Date.now(),
      currentStep,
      setupMode,
      appFocus,
      workoutPlanningPreference,
      selectedGoal, selectedModifiers, selectedRegion, pace, targetWeight, targetEvent,
      weightLbs, heightFeet, heightInches, birthdate, gender,
      daysPerWeek, selectedTrainingDays, selectedTrainingTemplate, preferredSplit, workoutDuration,
      lifestyleActivity,
      selectedEquipment, equipmentSettings, selectedEquipTemplate,
      strengthBaselineInputs,
      cardioCanJog10, cardioComfortableDuration, cardioMileTime, cardioFiveKTime, cardioPreferredModes,
      foodsAvailable, allergies, selectedFoodPreset,
      supplementsAvailable, mealRoutine,
      appleHealthEnabled,
      injuries, experienceLevel, lastWorkoutContext,
      onboardingInjuries, noInjuriesAck,
    };
    AsyncStorage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify(snapshot)).catch(() => {});
  }, [
    draftRestored,
    currentStep, currentStepKey, setupMode,
    appFocus, workoutPlanningPreference,
    selectedGoal, selectedModifiers, selectedRegion, pace, targetWeight, targetEvent,
    weightLbs, heightFeet, heightInches, birthdate, gender,
    daysPerWeek, selectedTrainingDays, selectedTrainingTemplate, preferredSplit, workoutDuration,
    lifestyleActivity,
    selectedEquipment, equipmentSettings, selectedEquipTemplate,
    strengthBaselineInputs,
    cardioCanJog10, cardioComfortableDuration, cardioMileTime, cardioFiveKTime, cardioPreferredModes,
    foodsAvailable, allergies, selectedFoodPreset,
    supplementsAvailable, mealRoutine,
    appleHealthEnabled,
    injuries, experienceLevel, lastWorkoutContext,
  ]);

  // Mount-time draft restore. Reads the snapshot once, prompts the user,
  // and either applies the draft or clears it. Setting `draftRestored=true`
  // unblocks the snapshot writer above so we don't immediately overwrite
  // the user's restored values with the empty initial state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(ONBOARDING_DRAFT_KEY);
        if (!raw) { if (!cancelled) setDraftRestored(true); return; }
        const draft = JSON.parse(raw);
        if (!draft || draft.v !== 1) { if (!cancelled) setDraftRestored(true); return; }
        // Stale drafts (>14 days) get cleared automatically — by then the
        // user has likely moved on and "resume?" feels stale + creepy.
        const ageDays = (Date.now() - (draft.savedAt ?? 0)) / 86400000;
        if (ageDays > 14) {
          await AsyncStorage.removeItem(ONBOARDING_DRAFT_KEY).catch(() => {});
          if (!cancelled) setDraftRestored(true);
          return;
        }
        const applyDraft = () => {
          if (cancelled) return;
          // Apply each saved field, defaulting on missing keys so
          // an older draft shape doesn't crash with undefineds.
          const restoredSetupMode: SetupMode = draft.setupMode === 'custom' ? 'custom' : 'quick';
          setSetupMode(restoredSetupMode);
          const restoredAppFocus: AppFocus =
            draft.appFocus === 'fitness' || draft.appFocus === 'nutrition' ? draft.appFocus : 'both';
          setAppFocus(restoredAppFocus);
          const restoredWorkoutPlanningPreference: WorkoutPlanningPreference =
            draft.workoutPlanningPreference === 'manual' || draft.workoutPlanningPreference === 'hybrid'
              ? draft.workoutPlanningPreference
              : 'generated';
          setWorkoutPlanningPreference(restoredWorkoutPlanningPreference);
          if (typeof draft.currentStep === 'number') {
            const maxStep = Math.max(0, getSteps(restoredSetupMode, restoredAppFocus).length - 1);
            setCurrentStep(Math.min(Math.max(0, draft.currentStep), maxStep));
          }
          if (typeof draft.selectedGoal === 'string') setSelectedGoal(draft.selectedGoal);
          if (Array.isArray(draft.selectedModifiers)) setSelectedModifiers(draft.selectedModifiers);
          if (typeof draft.selectedRegion === 'string') setSelectedRegion(draft.selectedRegion);
          if (draft.pace) setPace(draft.pace);
          if (typeof draft.targetWeight === 'string') setTargetWeight(draft.targetWeight);
          if (typeof draft.targetEvent === 'string') setTargetEvent(draft.targetEvent);
          if (typeof draft.weightLbs === 'string') setWeightLbs(draft.weightLbs);
          if (typeof draft.heightFeet === 'string') setHeightFeet(draft.heightFeet);
          if (typeof draft.heightInches === 'string') setHeightInches(draft.heightInches);
          if (draft.birthdate !== undefined) setBirthdate(draft.birthdate);
          if (draft.gender !== undefined) setGender(draft.gender);
          if (typeof draft.daysPerWeek === 'string') setDaysPerWeekRaw(draft.daysPerWeek);
          if (Array.isArray(draft.selectedTrainingDays)) setSelectedTrainingDays(draft.selectedTrainingDays);
          if (typeof draft.selectedTrainingTemplate === 'string') setSelectedTrainingTemplate(draft.selectedTrainingTemplate);
          if (typeof draft.preferredSplit === 'string') setPreferredSplit(draft.preferredSplit);
          if (typeof draft.workoutDuration === 'number') setWorkoutDuration(draft.workoutDuration);
          if (
            draft.lifestyleActivity === 'sedentary'
            || draft.lifestyleActivity === 'light'
            || draft.lifestyleActivity === 'moderate'
            || draft.lifestyleActivity === 'active'
            || draft.lifestyleActivity === 'very_active'
          ) {
            setLifestyleActivity(draft.lifestyleActivity);
          }
          if (Array.isArray(draft.selectedEquipment)) setSelectedEquipment(draft.selectedEquipment);
          if (draft.equipmentSettings !== undefined) setEquipmentSettings(draft.equipmentSettings);
          if (typeof draft.selectedEquipTemplate === 'string' || draft.selectedEquipTemplate === null) setSelectedEquipTemplate(draft.selectedEquipTemplate);
          if (draft.strengthBaselineInputs && typeof draft.strengthBaselineInputs === 'object') {
            setStrengthBaselineInputs({ ...emptyStrengthBaselineInputs(), ...draft.strengthBaselineInputs });
          }
          if (draft.cardioCanJog10 === true || draft.cardioCanJog10 === false || draft.cardioCanJog10 === null) setCardioCanJog10(draft.cardioCanJog10);
          if (typeof draft.cardioComfortableDuration === 'string') setCardioComfortableDuration(draft.cardioComfortableDuration);
          if (typeof draft.cardioMileTime === 'string') setCardioMileTime(draft.cardioMileTime);
          if (typeof draft.cardioFiveKTime === 'string') setCardioFiveKTime(draft.cardioFiveKTime);
          if (Array.isArray(draft.cardioPreferredModes)) setCardioPreferredModes(draft.cardioPreferredModes);
          if (Array.isArray(draft.foodsAvailable)) setFoodsAvailable(draft.foodsAvailable);
          if (Array.isArray(draft.allergies)) setAllergies(draft.allergies);
          if (typeof draft.selectedFoodPreset === 'string' || draft.selectedFoodPreset === null) setSelectedFoodPreset(draft.selectedFoodPreset);
          if (Array.isArray(draft.supplementsAvailable)) setSupplementsAvailable(draft.supplementsAvailable);
          if (typeof draft.mealRoutine === 'string') setMealRoutine(draft.mealRoutine);
          if (typeof draft.appleHealthEnabled === 'boolean') setAppleHealthEnabled(draft.appleHealthEnabled);
          if (typeof draft.injuries === 'string') setInjuries(draft.injuries);
          if (typeof draft.experienceLevel === 'string') setExperienceLevel(draft.experienceLevel);
          if (typeof draft.lastWorkoutContext === 'string') setLastWorkoutContext(draft.lastWorkoutContext);
          if (Array.isArray(draft.onboardingInjuries)) setOnboardingInjuries(draft.onboardingInjuries);
          if (typeof draft.noInjuriesAck === 'boolean') setNoInjuriesAck(draft.noInjuriesAck);
          setDraftRestored(true);
        };
        if (onboardingDraftPromptShownForSession) {
          applyDraft();
          return;
        }
        onboardingDraftPromptShownForSession = true;
        const stepLabel = draft.currentStep != null ? `Step ${draft.currentStep + 1}` : 'where you left off';
        Alert.alert(
          'Continue setup?',
          `You started onboarding earlier. Pick up at ${stepLabel}, or start fresh.`,
          [
            {
              text: 'Start fresh',
              style: 'destructive',
              onPress: async () => {
                await AsyncStorage.removeItem(ONBOARDING_DRAFT_KEY).catch(() => {});
                if (!cancelled) setDraftRestored(true);
              },
            },
            {
              text: 'Continue',
              onPress: applyDraft,
            },
          ],
          { cancelable: false },
        );
      } catch {
        if (!cancelled) setDraftRestored(true);
      }
    })();
    return () => { cancelled = true; };
    // Run once on mount only — restore is a one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll carousel to the selected goal whenever the goal step becomes active
  // (covers both initial load and navigating back from a later step).
  useEffect(() => {
    if (currentStepKey !== 'goal') return;
    const idx = LAUNCH_GOALS.findIndex(g => g.id === launchGoalIdFor(selectedGoal));
    if (idx < 0) return;
    const timer = setTimeout(() => {
      goalCarouselRef.current?.scrollTo({ x: idx * (screenWidth * 0.82 + 12), animated: false });
      setGoalScrollIdx(idx);
    }, 240); // wait for FadeInView to finish before scrolling
    return () => clearTimeout(timer);
  }, [currentStepKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectGoal = (goalId: string) => {
    if (goalId !== selectedGoal) {
      import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
      setSelectedGoal(goalId);
      setSelectedModifiers([]);
      setSelectedRegion('balanced');
    }
    const idx = LAUNCH_GOALS.findIndex(g => g.id === launchGoalIdFor(goalId));
    if (idx >= 0) {
      goalCarouselRef.current?.scrollTo({ x: idx * (screenWidth * 0.82 + 12), animated: true });
      LayoutAnimation.configureNext({ duration: 220, update: { type: 'spring', springDamping: 0.75 } });
      setGoalScrollIdx(idx);
    }
  };

  const applyGoalQueryMatch = async (): Promise<string | null> => {
    const query = goalQuery.trim();
    if (!query || goalQueryApplied === query) return selectedGoal;
    setGoalMatchLoading(true);
    try {
      const res = await matchGoal(query, SIGNUP_GOAL_MATCH_IDS);
      const matchedGoalId = SIGNUP_GOAL_MATCH_IDS.includes(res.goal_id) ? res.goal_id : selectedGoal;
      selectGoal(matchedGoalId);
      setGoalMatchReason(res.reason);
      setGoalQueryApplied(query);
      Keyboard.dismiss();
      setTimeout(scrollCarouselIntoView, 340);
      return matchedGoalId;
    } catch {
      return selectedGoal;
    } finally {
      setGoalMatchLoading(false);
    }
  };

  // toggleModifier removed — modifiers are gone.
  const toggleEquipmentItem = (item: { name: string; aliases?: string[] }) => {
    const names = equipmentItemNames(item);
    setSelectedEquipment(prev =>
      prev.some(name => names.has(name.toLowerCase()))
        ? prev.filter(name => !names.has(name.toLowerCase()))
        : [...prev, item.name]
    );
    setSelectedEquipTemplate(null);
  };

  const applyTemplate = (template: EquipmentTemplate) => {
    setSelectedEquipment(template.items);
    setSelectedEquipTemplate(template.id);
  };

  const applyTrainingTemplate = (template: TrainingTemplate) => {
    setSelectedTrainingTemplate(template.id);
    setDaysPerWeek(template.daysPerWeek);
    setWorkoutDuration(template.workoutDuration);
    setPreferredSplit('auto');
  };

  const applyFoodPreset = (preset: FoodPreset) => {
    if (selectedFoodPreset === preset.id) {
      setSelectedFoodPreset(null);
      setFoodsAvailable([]);
      return;
    }
    setSelectedFoodPreset(preset.id);
    setFoodsAvailable(resolveFoodPresetItems(preset, meta?.allFoods as Array<{ name: string }> | undefined));
  };

  const toggleAllergy = (key: string) => {
    setAllergies(prev => prev.includes(key) ? prev.filter(x => x !== key) : [...prev, key]);
  };

  const validate = (goalOverride?: string | null): string | null => {
    const activeGoal = goalOverride || selectedGoal;
    switch (currentStepKey) {
      case 'goal': {
        // Target weight is required for any weight-change goal so the
        // calorie delta + ETA calc has real inputs.
        const weightChange = new Set([
          'lose_fat', 'get_lean', 'cut', 'preserve_muscle_cutting',
          'build_muscle', 'lean_bulk', 'gain_weight',
        ]);
        if (weightChange.has(activeGoal) && setupMode === 'custom') {
          if (!targetWeight?.trim()) return 'Set a target weight — needed for your calorie target and ETA.';
          const tw = parseFloat(targetWeight);
          if (isNaN(tw) || tw < 50 || tw > 500) return 'Enter a valid target weight (50–500 lbs)';
        }
        if (targetWeight?.trim()) {
          const tw = parseFloat(targetWeight);
          if (isNaN(tw) || tw < 50 || tw > 500) return 'Enter a valid target weight (50–500 lbs)';
        }
        return null;
      }
      case 'quickSetup': {
        // Nutrition-only users don't train through the app — only force
        // training + equipment template selection when fitness is part
        // of the user's focus. Food preset stays optional regardless.
        if (appFocus !== 'nutrition') {
          if (!selectedTrainingTemplate) return 'Pick a training template';
          if (selectedEquipment.length === 0) return 'Pick the equipment preset closest to your setup';
        }
        return null;
      }
      case 'goalRefine': {
        if (targetWeight) {
          const tw = parseFloat(targetWeight);
          if (isNaN(tw) || tw < 50 || tw > 500) return 'Enter a valid target weight (50–500 lbs)';
          // Direction sanity check vs current weight if entered.
          const cw = parseFloat(weightLbs);
          if (!isNaN(cw) && cw > 0) {
            const cutGoals  = new Set(['lose_fat', 'get_lean', 'cut', 'preserve_muscle_cutting']);
            const bulkGoals = new Set(['build_muscle', 'lean_bulk', 'gain_weight']);
            if (cutGoals.has(activeGoal) && tw >= cw) return `For fat-loss goals, target weight must be less than current (${cw} lb)`;
            if (bulkGoals.has(activeGoal) && tw <= cw) return `For weight-gain goals, target weight must be greater than current (${cw} lb)`;
          }
        }
        return null;
      }
      case 'physicalStats': {
        const w = parseFloat(weightLbs);
        const hf = parseInt(heightFeet);
        const hi = parseInt(heightInches);
        if (isNaN(w) || w < 50 || w > 600) return 'Enter a valid weight (50–600 lbs)';
        if (isNaN(hf) || hf < 3 || hf > 8) return 'Enter a valid height';
        if (isNaN(hi) || hi < 0 || hi > 11) return 'Inches must be between 0–11';
        const birthErr = validateBirthdate(birthdate);
        if (birthErr) return birthErr;
        if (!gender) return 'Please select a biological sex option';
        return null;
      }
      case 'trainingDays': {
        const d = parseInt(daysPerWeek);
        if (isNaN(d) || d < 1 || d > 7) return 'Enter a number between 1–7';
        return null;
      }
      case 'equipment':
        if (selectedEquipment.length === 0) return 'Select at least one equipment option';
        return null;
      default:
        return null;
    }
  };

  const handleNext = async () => {
    if (goalMatchLoading) return;
    const goalForValidation = currentStepKey === 'goal'
      ? await applyGoalQueryMatch()
      : selectedGoal;
    const error = validate(goalForValidation);
    if (error) {
      setStepError(error);
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
      return;
    }
    setStepError('');

    if (currentStep < totalSteps - 1) {
      import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
      setCurrentStep(s => s + 1);
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: 0, animated: true }));
    } else {
      import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
      handleComplete();
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
      setStepError('');
      setCurrentStep(s => s - 1);
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: 0, animated: true }));
    }
  };

  const buildStrengthBaselines = (): StrengthBaselines | undefined => {
    const lifts = STRENGTH_BASELINE_LIFTS
      .map(lift => {
        const input = strengthBaselineInputs[lift.key] ?? { weightLbs: '', reps: '' };
        const reps = parseOptionalPositiveNumber(input.reps);
        if (!reps) return null;
        const weightLbs = lift.key === 'pull_up'
          ? undefined
          : parseOptionalPositiveNumber(input.weightLbs);
        if (lift.key !== 'pull_up' && !weightLbs) return null;
        return {
          key: lift.key,
          exerciseSlug: lift.exerciseSlug,
          name: lift.name,
          weightLbs,
          reps: Math.round(reps),
        };
      })
      .filter(Boolean) as StrengthBaselines['lifts'];
    return lifts.length ? { version: 1, lifts } : undefined;
  };

  const buildCardioBaseline = (): CardioBaseline | undefined => {
    const baseline: CardioBaseline = {};
    if (cardioCanJog10 !== null) baseline.canJog10Min = cardioCanJog10;
    const comfortableDurationMin = parseOptionalPositiveNumber(cardioComfortableDuration);
    if (comfortableDurationMin) baseline.comfortableDurationMin = comfortableDurationMin;
    const recentMileTimeMin = parseOptionalMinutes(cardioMileTime);
    if (recentMileTimeMin) baseline.recentMileTimeMin = recentMileTimeMin;
    const recent5kTimeMin = parseOptionalMinutes(cardioFiveKTime);
    if (recent5kTimeMin) baseline.recent5kTimeMin = recent5kTimeMin;
    if (cardioPreferredModes.length > 0) baseline.preferredModes = cardioPreferredModes;
    return Object.keys(baseline).length > 0 ? baseline : undefined;
  };

  const handleComplete = async () => {
    // Clear the resume draft — onboarding has succeeded, future relaunches
    // should NOT prompt "continue setup?" against stale state.
    AsyncStorage.removeItem(ONBOARDING_DRAFT_KEY).catch(() => {});

    // Metric-mode inputs convert to canonical imperial here so the rest of
    // the payload (and the backend) only ever sees lbs / ft+in. The user's
    // chosen units ride along as preferences on the profile so the app
    // renders back in their unit.
    let canonicalWeightLbs = weightLbs;
    let canonicalHeightFeet = heightFeet;
    let canonicalHeightInches = heightInches;
    if (unitSystem === 'metric') {
      if (weightKg) {
        const lbs = unitToLbs(parseFloat(weightKg), 'kg');
        if (Number.isFinite(lbs) && lbs > 0) canonicalWeightLbs = lbs.toFixed(1);
      }
      if (heightCm) {
        const { feet, inches } = cmToFeetInches(parseFloat(heightCm));
        canonicalHeightFeet = String(feet);
        canonicalHeightInches = String(inches);
      }
    }

    if (canonicalWeightLbs) {
      const { saveWeightEntry } = await import('../utils/weightHistory');
      await saveWeightEntry(parseFloat(canonicalWeightLbs), 'onboarding').catch(() => {});
    }
    const cat = goalCategory(selectedGoal) ?? 'lifestyle_consistency';

    const goalSel: GoalSelection = {
      primaryGoal: selectedGoal,
      category: cat,
      modifiers: selectedModifiers,
    };

    const goalDetails: GoalDetails = {
      pace,
      targetWeightLbs: targetWeight ? parseFloat(targetWeight) : undefined,
      targetEvent: targetEvent.trim() || undefined,
    };

    const derivedAge = deriveAge(birthdate) ?? 30;
    const physicalStats: PhysicalStats = {
      weightLbs:    parseFloat(canonicalWeightLbs),
      heightFeet:   parseInt(canonicalHeightFeet),
      heightInches: parseInt(canonicalHeightInches),
      age:          derivedAge,
      birthdate:    birthdate ?? undefined,
      gender:       gender as Gender,
    };
    const strengthBaselines = buildStrengthBaselines();
    const cardioBaseline = buildCardioBaseline();

    // Map the signup answer to default hidden surfaces. Fitness-only
    // hides the Meals tab; nutrition-only hides Workouts; "both" leaves
    // everything visible. Reversible from Settings, where editing the
    // tab toggles directly bypasses this mapping.
    const hiddenSurfaces = appFocus === 'fitness'
      ? { meals: true }
      : appFocus === 'nutrition'
        ? { workouts: true }
        : undefined;

    onComplete({
      goal:               selectedGoal,
      goalSelection:      goalSel,
      priorityRegion:     selectedRegion,
      appFocus,
      ...(hiddenSurfaces ? { hiddenSurfaces } : {}),
      workoutManualMode: appFocus !== 'nutrition' && workoutPlanningPreference === 'manual',
      goalDetails,
      physicalStats,
      // Display-unit prefs ride along on the profile so the rest of the app
      // renders weights/heights in the unit the user picked. Storage stays
      // canonical (lbs / ft+in); these only affect formatting + future input.
      weightUnit: unitSystem === 'metric' ? 'kg' : 'lbs',
      heightUnit: unitSystem === 'metric' ? 'cm' : 'in',
      daysPerWeek:            parseInt(daysPerWeek),
      trainingDays:           selectedTrainingDays.length === parseInt(daysPerWeek) ? selectedTrainingDays : undefined,
      preferredSplit:         preferredSplit === 'auto' ? undefined : preferredSplit,
      workoutDurationMinutes: workoutDuration,
      // Lifestyle-activity nudge for TDEE. Optional — omitting it
      // preserves the legacy training-schedule-only multiplier.
      lifestyleActivity:      lifestyleActivity ?? undefined,
      equipment:              selectedEquipment,
      equipmentSettings:      normalizeStrengthEquipmentSettings(equipmentSettings, selectedEquipment),
      strengthBaselines,
      cardioBaseline,
      foodsAvailable,
      allergies: allergies.length > 0 ? allergies : undefined,
      supplementsAvailable: supplementsAvailable.length > 0 ? supplementsAvailable : undefined,
      customFoods: [],
      mealRoutine:         mealRoutine.trim()         || undefined,
      injuries:            injuries.trim()            || undefined,
      // Structured records captured by the new onboarding 'injuries'
      // step. Persisted alongside the legacy free-text `injuries` field
      // — the planner unions both. Empty list (user picked "No
      // injuries" or skipped) means we send `undefined` to keep the
      // existing "no entries" behavior unchanged.
      injuryEntries:       onboardingInjuries.length ? onboardingInjuries : undefined,
      experienceLevel:     experienceLevel            || undefined,
      lastWorkoutContext:  lastWorkoutContext.trim()   || undefined,
    });
  };

  // ─── Photo helpers ───────────────────────────────────────────────────────────

  const requireServerPro = async (feature: ProFeature): Promise<boolean> => {
    try {
      const me = await getMe(authToken);
      return requirePro(billingEntitlementToProfilePatch(me as any) as any, feature);
    } catch {
      return requirePro(null, feature);
    }
  };

  const pickImages = async (source: 'camera' | 'library'): Promise<string[]> => {
    const { status } = source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', `Please allow ${source === 'camera' ? 'camera' : 'photo library'} access.`);
      return [];
    }
    if (source === 'camera') {
      const result = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.6, mediaTypes: ImagePicker.MediaTypeOptions.Images });
      if (result.canceled || !result.assets?.[0]?.base64) return [];
      return [result.assets[0].base64];
    } else {
      const result = await ImagePicker.launchImageLibraryAsync({
        base64: true, quality: 0.6,
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        selectionLimit: 6,
      });
      if (result.canceled || !result.assets?.length) return [];
      return result.assets.map(a => a.base64).filter(Boolean) as string[];
    }
  };

  const handleScanEquipment = async (source: 'camera' | 'library') => {
    if (!(await requireServerPro('ai_equipment_scan'))) return;
    const images = await pickImages(source);
    if (!images.length) return;
    setEquipScanLoading(true);
    try {
      const allFound: string[] = [];
      for (const base64 of images) {
        const resp = await scanEquipmentPhoto(authToken, { image_base64: base64 });
        const found = (resp.equipment ?? []).filter((name: string) =>
          meta.equipmentCategories.some(cat => cat.items.some(item => item.name === name))
        );
        for (const item of found) {
          if (!allFound.includes(item)) allFound.push(item);
        }
      }
      if (allFound.length === 0) {
        Alert.alert('No equipment found', 'Could not identify any equipment in those photos. Try a clearer shot or select manually.');
        return;
      }
      setScannedEquipment(allFound);
      setShowEquipScanModal(true);
    } catch {
      Alert.alert('Scan failed', 'Could not scan photo. Try again or select manually.');
    } finally {
      setEquipScanLoading(false);
    }
  };

  const confirmScannedEquipment = () => {
    setSelectedEquipment(prev => {
      const next = [...prev];
      for (const item of scannedEquipment) {
        if (!next.includes(item)) next.push(item);
      }
      return next;
    });
    setShowEquipScanModal(false);
    setScannedEquipment([]);
  };

  const handleScanFoods = async (source: 'camera' | 'library') => {
    if (!(await requireServerPro('ai_food_scan'))) return;
    const images = await pickImages(source);
    if (!images.length) return;
    setFoodScanLoading(true);
    try {
      const allItems: { name: string; selected: boolean }[] = [];
      for (const base64 of images) {
        const resp = await scanFoodsPhoto(authToken, {
          images: [{ image_base64: base64 }],
          context: foodScanContext.trim() || undefined,
        });
        const items = (resp.foods ?? []).map((f: any) => ({ name: f.name, selected: true }));
        for (const item of items) {
          if (!allItems.some(existing => existing.name === item.name)) {
            allItems.push(item);
          }
        }
      }
      if (allItems.length === 0) {
        Alert.alert('No foods found', 'Could not identify foods in those photos. Try a clearer shot.');
        return;
      }
      setScannedFoods(allItems);
      setFoodScanContext('');
      setShowFoodScanModal(true);
    } catch {
      Alert.alert('Scan failed', 'Could not scan photo. Try again or select manually.');
    } finally {
      setFoodScanLoading(false);
    }
  };

  const confirmScannedFoods = () => {
    const toAdd = scannedFoods.filter(f => f.selected).map(f => f.name);
    setFoodsAvailable(prev => {
      const next = [...prev];
      for (const name of toAdd) {
        if (!next.includes(name)) next.push(name);
      }
      return next;
    });
    setShowFoodScanModal(false);
    setScannedFoods([]);
  };

  // ─── Step renderers ─────────────────────────────────────────────────────────

  const renderAllergyChips = () => (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {ALLERGY_OPTIONS.map((a) => {
        const active = allergies.includes(a.key);
        return (
          <TouchableOpacity
            key={a.key}
            onPress={() => toggleAllergy(a.key)}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 7,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: active ? (colors.warning ?? '#F59E0B') : colors.border,
              backgroundColor: active ? (colors.warning ?? '#F59E0B') + '22' : colors.surface,
            }}
          >
            <Text
              style={{
                fontSize: 12,
                fontWeight: '700',
                color: active ? (colors.warning ?? '#F59E0B') : colors.textSecondary,
              }}
            >
              {a.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  const renderWorkoutStyleStep = () => (
    <View style={styles.stepContainer}>
      {renderStepHero(STOCK_IMAGES.onboarding.workoutStyle, 'Train your way', 'Generated weeks, manual logs, or both')}
      <Text style={styles.stepTitle}>How do you want to train?</Text>
      <Text style={styles.stepDescription}>
        Choose the workflow you want to open with. You can still change this later from workout settings.
      </Text>

      <View style={{ gap: 12 }}>
        {([
          {
            value: 'generated',
            icon: 'calendar-outline',
            label: 'Build my plan for me',
            badge: 'Recommended',
            desc: 'Get a deterministic weekly plan from your goal, schedule, equipment, and recovery.',
          },
          {
            value: 'manual',
            icon: 'create-outline',
            label: 'Log my own workouts',
            badge: null,
            desc: 'Start custom workouts, log sessions from your own program, and save repeatable templates.',
          },
          {
            value: 'hybrid',
            icon: 'shuffle-outline',
            label: 'Mix both',
            badge: null,
            desc: 'Keep a generated week, but use custom workouts or templates whenever your real routine changes.',
          },
        ] as const).map(opt => {
          const active = workoutPlanningPreference === opt.value;
          return (
            <PressableScale
              key={opt.value}
              accessibilityRole="button"
              style={[
                styles.chipWide,
                active && styles.chipWideSelected,
                { alignItems: 'flex-start' },
              ]}
              onPress={() => {
                import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
                setWorkoutPlanningPreference(opt.value);
              }}
              scaleDown={0.98}
            >
              <View style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                backgroundColor: active ? colors.primary + '22' : colors.surfaceRaised,
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <Ionicons name={opt.icon as any} size={20} color={active ? colors.primary : colors.textMuted} />
              </View>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                  <Text style={[styles.chipWideLabel, active && styles.chipWideLabelSelected, { flexShrink: 1 }]}>
                    {opt.label}
                  </Text>
                  {opt.badge && (
                    <View style={{
                      paddingHorizontal: 7,
                      paddingVertical: 2,
                      borderRadius: 5,
                      backgroundColor: colors.primary + '18',
                    }}>
                      <Text style={{ fontSize: 9, fontWeight: '800', color: colors.primary, letterSpacing: 0.4 }}>
                        {opt.badge.toUpperCase()}
                      </Text>
                    </View>
                  )}
                </View>
                <Text style={styles.chipWideDesc}>{opt.desc}</Text>
              </View>
              {active && <Ionicons name="checkmark-circle" size={20} color={colors.primary} />}
            </PressableScale>
          );
        })}
      </View>

      <View style={[styles.baselineWhyBox, { marginTop: 14 }]}>
        <Ionicons name="information-circle-outline" size={18} color={colors.primary} />
        <Text style={styles.baselineWhyText}>
          {FREE_TIER_SUMMARY} {PRO_TIER_SUMMARY}
        </Text>
      </View>
    </View>
  );

  const renderSetupPathStep = () => (
    <View style={styles.stepContainer}>
      {renderStepHero(STOCK_IMAGES.onboarding.setupPath, 'Start simple', 'Pick templates now, tune details later')}
      <Text style={styles.stepTitle}>Choose Your Setup</Text>
      <Text style={styles.stepDescription}>
        New to fitness apps, or just want the fastest setup? Use Quick Start. If you already know your schedule, equipment, and training preferences, use Advanced Setup.
      </Text>

      <View style={{ gap: 12 }}>
        {([
          {
            value: 'quick',
            icon: 'flash-outline',
            label: 'Quick Start',
            desc: 'Best for most people. Pick simple templates now and adjust anything later.',
          },
          {
            value: 'custom',
            icon: 'options-outline',
            label: 'Advanced Setup',
            desc: 'Best if you have fitness-app experience or already know your exact training days, split, gear, and food preferences.',
          },
        ] as const).map(opt => {
          const active = setupMode === opt.value;
          return (
            <PressableScale
              key={opt.value}
              accessibilityRole="button"
              style={[
                styles.chipWide,
                active && styles.chipWideSelected,
                { alignItems: 'flex-start' },
              ]}
              onPress={() => {
                import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
                setSetupMode(opt.value);
              }}
              scaleDown={0.98}
            >
              <View style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                backgroundColor: active ? colors.primary + '22' : colors.surfaceRaised,
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <Ionicons name={opt.icon as any} size={20} color={active ? colors.primary : colors.textMuted} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.chipWideLabel, active && styles.chipWideLabelSelected]}>{opt.label}</Text>
                <Text style={styles.chipWideDesc}>{opt.desc}</Text>
              </View>
              {active && <Ionicons name="checkmark-circle" size={20} color={colors.primary} />}
            </PressableScale>
          );
        })}
      </View>
    </View>
  );

  const renderQuickSetupStep = () => (
    <View style={styles.stepContainer}>
      {renderStepHero(
        appFocus === 'nutrition' ? STOCK_IMAGES.onboarding.quickNutrition : STOCK_IMAGES.onboarding.quickTraining,
        'Your first week',
        'Training, equipment, and food defaults',
      )}
      <Text style={styles.stepTitle}>Pick Your Templates</Text>
      <Text style={styles.stepDescription}>
        These defaults set up your first week or manual tracker. Every choice can be changed later from your profile.
      </Text>

      {/* Training + Equipment hidden when the user picked nutrition-only —
          they don't train through the app so these picks are noise. */}
      {appFocus !== 'nutrition' && (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Ionicons name="calendar-outline" size={14} color={colors.primary} />
            <Text style={[styles.sectionHeading, { marginBottom: 0, marginTop: 0, color: colors.primary }]}>
              Training
            </Text>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast" style={styles.templateScroll} contentContainerStyle={styles.templateScrollContent}>
            {TRAINING_TEMPLATES.map(t => {
              const active = selectedTrainingTemplate === t.id;
              return (
                <TouchableOpacity
                  key={t.id}
                  style={[styles.templateChip, active && styles.templateChipActive]}
                  onPress={() => applyTrainingTemplate(t)}
                  activeOpacity={0.75}
                >
                  <Text style={[styles.templateChipLabel, active && styles.templateChipLabelActive]}>{t.label}</Text>
                  <Text style={[styles.templateChipDesc, active && styles.templateChipDescActive]}>{t.description}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Ionicons name="barbell-outline" size={14} color={colors.primary} />
            <Text style={[styles.sectionHeading, { marginBottom: 0, marginTop: 0, color: colors.primary }]}>
              Equipment
            </Text>
          </View>
          <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 10 }}>
            Pick the closest setup. You can add or remove individual items later.
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast" style={styles.templateScroll} contentContainerStyle={styles.templateScrollContent}>
            {EQUIPMENT_TEMPLATES.map(t => {
              const active = selectedEquipTemplate === t.id;
              return renderEquipmentTemplateCard(t, active, 'quick-equipment-template');
            })}
          </ScrollView>
        </>
      )}

      {/* Food Style hidden when the user picked fitness-only — they don't
          track meals so picking a meal style is irrelevant. */}
      {appFocus !== 'fitness' && (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Ionicons name="nutrition-outline" size={14} color={colors.primary} />
            <Text style={[styles.sectionHeading, { marginBottom: 0, marginTop: 0, color: colors.primary }]}>
              Food Style
            </Text>
          </View>
          <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 10 }}>
            Optional. These choices only guide generated meal suggestions.
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast" style={styles.templateScroll} contentContainerStyle={styles.templateScrollContent}>
            {FOOD_PRESETS.map(p => {
              const active = selectedFoodPreset === p.id;
              return renderFoodPresetCard(p, active, 'quick-food-preset');
            })}
          </ScrollView>
        </>
      )}

      <View style={{ marginBottom: 18 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Ionicons name="warning-outline" size={14} color={colors.warning ?? '#F59E0B'} />
          <Text style={[styles.sectionHeading, { marginBottom: 0, marginTop: 0 }]}>
            Anything to avoid?
          </Text>
        </View>
        <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 10 }}>
          Optional, but useful for meal suggestions.
        </Text>
        {renderAllergyChips()}
      </View>
    </View>
  );

  const renderGoalStep = () => {
    const visibleSelectedGoal = launchGoalIdFor(selectedGoal);
    const selectedDef = PRIMARY_GOALS.find(g => g.id === selectedGoal)
      ?? PRIMARY_GOALS.find(g => g.id === visibleSelectedGoal);
    const activeGoalCategory = selectedDef?.category ?? goalCategory(selectedGoal);
    const launchGoalCategories = GOAL_CATEGORIES
      .map(cat => ({ ...cat, count: LAUNCH_GOALS.filter(g => g.category === cat.id).length }))
      .filter(cat => cat.count > 0);
    const scrollToGoalCategory = (categoryId: string) => {
      const idx = LAUNCH_GOALS.findIndex(g => g.category === categoryId);
      if (idx < 0) return;
      goalCarouselRef.current?.scrollTo({ x: idx * (screenWidth * 0.82 + 12), animated: true });
      LayoutAnimation.configureNext({ duration: 220, update: { type: 'spring', springDamping: 0.75 } });
      setGoalScrollIdx(idx);
    };

    return (
      <View style={styles.stepContainer}>
        <Text style={styles.stepTitle}>What's Your Goal?</Text>
        <Text style={styles.stepDescription}>This shapes your workout split, nutrition targets, and coaching style. You can change this anytime.</Text>

        {/* AI goal matcher — bigger, multiline so the user can see what they're typing.
            Auto-expands as they write more. */}
        <View style={{
          marginBottom: 20,
          backgroundColor: colors.primary + '10',
          borderRadius: 14,
          borderWidth: 1.5,
          borderColor: colors.primary + '55',
          padding: 14,
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <Ionicons name="sparkles-outline" size={16} color={colors.primary} />
            <Text style={{ fontSize: 12, fontWeight: '800', color: colors.primary, textTransform: 'uppercase', letterSpacing: 0.8 }}>
              Describe your goal
            </Text>
          </View>
          <Text style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 10, lineHeight: 16 }}>
            Describe what you want in your own words. The AI picks the best-fit goal for you.
          </Text>
          <TextInput
            style={{
              backgroundColor: colors.surface, borderRadius: 10,
              paddingHorizontal: 14, paddingVertical: 14, fontSize: 15,
              color: colors.textPrimary, borderWidth: 1.5, borderColor: colors.primary + '88',
              minHeight: 90, textAlignVertical: 'top',
              marginBottom: 10,
            }}
            placeholder="e.g. I want to lose my belly but keep muscle, train 4 days a week, and feel athletic for pickup basketball"
            placeholderTextColor={colors.textMuted}
            value={goalQuery}
            onChangeText={t => { setGoalQuery(t); setGoalMatchReason(null); setGoalQueryApplied(''); }}
            multiline
            scrollEnabled
          />
          <TouchableOpacity
            activeOpacity={0.75}
            style={{
              backgroundColor: colors.primary, borderRadius: 10,
              paddingVertical: 12, alignItems: 'center', justifyContent: 'center',
              flexDirection: 'row', gap: 6,
              opacity: goalMatchLoading || !goalQuery.trim() ? 0.5 : 1,
            }}
            disabled={goalMatchLoading || !goalQuery.trim()}
            onPress={async () => {
              if (!goalQuery.trim()) return;
              await applyGoalQueryMatch();
            }}>
            {goalMatchLoading
              ? <ActivityIndicator size="small" color="#fff" />
              : <>
                  <Ionicons name="sparkles" size={14} color="#fff" />
                  <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Find my goal</Text>
                </>
            }
          </TouchableOpacity>
          {goalMatchReason && (
            <Text style={{ fontSize: 12, color: colors.primary, marginTop: 8, fontStyle: 'italic' }}>
              {goalMatchReason}
            </Text>
          )}
        </View>

        {/* Launch goals. Each card shows a short
            description so users can compare without tapping. Selected
            card expands to full width for the full text. */}
        <View ref={carouselSectionRef}>
        <Text style={styles.sectionHeading}>Most popular</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingRight: 20 }}
          style={{ marginHorizontal: -20, paddingHorizontal: 20, marginBottom: 12 }}
        >
          {launchGoalCategories.map(cat => {
            const active = activeGoalCategory === cat.id;
            return (
              <TouchableOpacity
                key={cat.id}
                testID={`goal-category-${cat.id}`}
                accessibilityLabel={`goal-category-${cat.id}`}
                activeOpacity={0.75}
                onPress={() => scrollToGoalCategory(cat.id)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  borderRadius: radius.full,
                  borderWidth: 1,
                  borderColor: active ? colors.primary : colors.border,
                  backgroundColor: active ? colors.primary + '14' : colors.surface,
                }}>
                <Ionicons name={cat.icon as any} size={14} color={active ? colors.primary : colors.textMuted} />
                <Text style={{ fontSize: 12, fontWeight: '700', color: active ? colors.primary : colors.textSecondary }}>
                  {cat.label}
                </Text>
                <Text style={{ fontSize: 10, fontWeight: '800', color: active ? colors.primary : colors.textMuted }}>
                  {cat.count}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        {/* Horizontal carousel — each card is ~80% screen width so the next
            card peeks in from the right. Snap alignment keeps it crisp. */}
        <ScrollView
          ref={goalCarouselRef}
          horizontal
          pagingEnabled={false}
          snapToInterval={screenWidth * 0.82 + 12}
          snapToAlignment="start"
          decelerationRate="fast"
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingRight: screenWidth * 0.18, gap: 12 }}
          style={{ marginHorizontal: -20, paddingHorizontal: 20, marginBottom: 4 }}
          onMomentumScrollEnd={e => {
            const idx = Math.round(e.nativeEvent.contentOffset.x / (screenWidth * 0.82 + 12));
            const clamped = Math.max(0, Math.min(idx, LAUNCH_GOALS.length - 1));
            LayoutAnimation.configureNext({ duration: 220, update: { type: 'spring', springDamping: 0.75 } });
            setGoalScrollIdx(clamped);
          }}
        >
          {LAUNCH_GOALS.map((g) => {
            const catDef = GOAL_CATEGORIES.find(c => c.id === g.category);
            const active = visibleSelectedGoal === g.id;
            const imageSource = getGoalCardImageSource(g.id, gender || undefined);
            return (
              <PressableScale
                key={g.id}
                testID={`goal-card-${g.id}`}
                accessibilityLabel={`goal-card-${g.id}`}
                accessibilityRole="button"
                style={[
                  styles.goalCard,
                  active && styles.goalCardActive,
                  { width: screenWidth * 0.82, alignItems: 'stretch', padding: 0, overflow: 'hidden' },
                ]}
                onPress={() => selectGoal(g.id)}
                scaleDown={0.97}
              >
                <ImageBackground
                  source={imageSource}
                  resizeMode="cover"
                  style={styles.goalHero}
                  imageStyle={styles.goalHeroImage}
                >
                  <View style={styles.goalHeroScrim} />
                  <View style={[
                    styles.goalHeroIconBubble,
                    active && styles.goalHeroIconBubbleActive,
                  ]}>
                    <Ionicons name={(catDef?.icon ?? 'flag-outline') as any} size={20} color={active ? colors.primary : '#fff'} />
                  </View>
                  {active && (
                    <View style={styles.goalHeroCheckBubble}>
                      <Ionicons name="checkmark" size={16} color="#fff" />
                    </View>
                  )}
                </ImageBackground>
                <View style={styles.goalCardContent}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <Text style={[styles.goalLabel, active && styles.goalLabelActive, { flex: 1 }]}>{g.label}</Text>
                  </View>
                  <Text style={{ fontSize: 13, color: active ? colors.textSecondary : colors.textMuted, lineHeight: 18 }}>
                    {g.description}
                  </Text>
                </View>
              </PressableScale>
            );
          })}
        </ScrollView>
        <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6, marginTop: 10, marginBottom: 4 }}>
          {LAUNCH_GOALS.map((_, i) => (
            <View key={i} style={{
              height: 6,
              width: goalScrollIdx === i ? 16 : 6,
              borderRadius: 3,
              backgroundColor: goalScrollIdx === i ? colors.primary : colors.border,
            }} />
          ))}
        </View>
        </View>

        {visibleSelectedGoal === 'improve_cardio' && (
          <View style={{ marginTop: 16 }}>
            <Text style={styles.fieldLabel}>Race focus</Text>
            <View style={styles.foodChips}>
              {ENDURANCE_EVENT_GOALS.map(opt => {
                const active = selectedGoal === opt.id
                  || (opt.id === 'improve_cardio' && !isEnduranceEventGoal(selectedGoal));
                return (
                  <TouchableOpacity
                    key={opt.id}
                    activeOpacity={0.75}
                    style={[styles.foodChip, active && styles.foodChipActive]}
                    onPress={() => {
                      setSelectedGoal(opt.id);
                      setSelectedModifiers([]);
                      setPace('moderate');
                      setTargetEvent(opt.targetEvent);
                    }}
                  >
                    <Text style={[styles.foodChipText, active && styles.foodChipTextActive]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

        {/* Pace — shown inline on the goal step itself whenever the user
            picks a pace-aware goal (fat loss / bulk / body-recomp / tone).
            Powers the ETA calc on the Progress screen and the backend
            calorie delta. Falls back to a hardcoded 3-rung ladder if
            meta.paces hasn't loaded yet. */}
        {(() => {
          const paceAwareGoals = new Set([
            'lose_fat', 'get_lean', 'cut', 'preserve_muscle_cutting',
            'build_muscle', 'lean_bulk', 'gain_weight',
            'improve_aesthetics', 'build_glutes', 'build_upper_body', 'build_lower_body',
            'build_arms', 'build_shoulders',
            'body_recomp', 'tone', 'get_toned',
          ]);
          if (!paceAwareGoals.has(selectedGoal)) return null;
          const backend = pacesForGoal(selectedGoal, meta.paces);
          const opts = backend.length > 0
            ? backend.map(o => ({ value: o.value as string, label: o.label, rate: o.rate }))
            : [
                { value: 'conservative', label: 'Steady',     rate: 'Slower, sustainable' },
                { value: 'moderate',     label: 'Moderate',   rate: 'Balanced' },
                { value: 'aggressive',   label: 'Aggressive', rate: 'Faster, tighter' },
              ];
          return (
            <View
              style={{ marginTop: 16 }}
              testID="pace-picker-inline"
              accessibilityLabel="pace-picker-inline"
            >
              <Text style={styles.fieldLabel}>How fast?</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {opts.map(opt => {
                  const active = pace === opt.value;
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      testID={`pace-option-${opt.value}`}
                      accessibilityLabel={`pace-option-${opt.value}`}
                      style={{
                        flex: 1, minWidth: '30%',
                        paddingVertical: 12, paddingHorizontal: 10, borderRadius: 10,
                        backgroundColor: active ? colors.primary : colors.surface,
                        borderWidth: 1, borderColor: active ? colors.primary : colors.border,
                        alignItems: 'center',
                      }}
                      onPress={() => setPace(opt.value as GoalPace)}>
                      <Text style={{ fontSize: 13, fontWeight: '800', color: active ? '#fff' : colors.textPrimary }}>{opt.label}</Text>
                      {opt.rate ? (
                        <Text style={{ fontSize: 10, color: active ? '#fff' : colors.textMuted, marginTop: 2, textAlign: 'center' }}>{opt.rate}</Text>
                      ) : null}
                    </TouchableOpacity>
                  );
                })}
              </View>
              <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 6, textAlign: 'center' }}>
                {selectedGoal === 'body_recomp'
                  ? 'Sets your calorie target. Conservative = small deficit; Moderate = maintenance; Aggressive = slight surplus (muscle focus).'
                  : 'Sets your weekly target rate. Used to estimate when you\'ll hit your goal.'}
              </Text>
            </View>
          );
        })()}

        {/* Target weight — required for any weight-change goal so the
            calorie delta + ETA are real numbers, not guesses. */}
        {(() => {
          const weightChange = new Set([
            'lose_fat', 'get_lean', 'cut', 'preserve_muscle_cutting',
            'build_muscle', 'lean_bulk', 'gain_weight',
          ]);
          if (!weightChange.has(selectedGoal)) return null;
          const hasValue = !!targetWeight?.trim();
          const required = setupMode === 'custom';
          return (
            <View style={{ marginTop: 16 }}>
              <Text style={styles.fieldLabel}>
                Target weight {required ? <Text style={{ color: colors.warning ?? '#DC2626' }}>*</Text> : <Text style={styles.optional}>(optional)</Text>}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <TextInput
                  testID="onboarding-target-weight-input"
                  accessibilityLabel="onboarding-target-weight-input"
                  style={{
                    flex: 1,
                    backgroundColor: colors.surface, borderRadius: 10,
                    paddingHorizontal: 14, paddingVertical: 12, fontSize: 15,
                    color: colors.textPrimary,
                    borderWidth: 1.5,
                    borderColor: hasValue || !required ? colors.border : (colors.warning ?? '#DC2626') + '88',
                  }}
                  placeholder="e.g. 175"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="numeric"
                  value={targetWeight}
                  onChangeText={setTargetWeight}
                  returnKeyType="done"
                />
                <Text style={{ color: colors.textMuted, fontSize: 14 }}>lbs</Text>
              </View>
              {!hasValue && required ? (
                <Text style={{ fontSize: 11, color: colors.warning ?? '#DC2626', marginTop: 4 }}>
                  Required — we need this to build your calorie target and ETA.
                </Text>
              ) : !hasValue ? (
                <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 4 }}>
                  Skip for now and add this later from Progress.
                </Text>
              ) : null}
            </View>
          );
        })()}
      </View>
    );
  };

  const renderGoalRefineStep = () => {
    const goalDef = PRIMARY_GOALS.find(g => g.id === selectedGoal);
    const goalLabel = goalDef?.label ?? selectedGoal;
    const cat = goalCategory(selectedGoal);
    const paceOpts = pacesForGoal(selectedGoal, meta.paces);

    // Show target weight for fat loss / muscle gain goals
    const weightGoalIds = new Set(['lose_fat', 'get_lean', 'cut', 'preserve_muscle_cutting', 'build_muscle', 'lean_bulk', 'gain_weight']);
    const showTargetWeight = weightGoalIds.has(selectedGoal);

    // Show target event for strength / endurance / athletic goals
    const eventCategories = new Set<string>(['strength', 'cardio_endurance', 'athletic_performance']);
    const showTargetEvent = cat ? eventCategories.has(cat) : false;
    const eventPlaceholder =
      cat === 'strength'              ? 'e.g. 315lb deadlift, 225lb bench' :
      cat === 'cardio_endurance'      ? 'e.g. half marathon, 5K in 25 min' :
      cat === 'athletic_performance'  ? 'e.g. sub-40s 100m, dunk a basketball' :
      'Describe your target';

    return (
      <View style={styles.stepContainer}>
        <Text style={styles.stepTitle}>Refine Your Plan</Text>
        <Text style={styles.stepDescription}>
          Fine-tune how your {goalLabel.toLowerCase()} plan is built.
        </Text>
        <Text style={styles.optionalBanner}>Everything on this page is optional — tap Next to skip.</Text>

        {/* Modifiers section removed — goals are now defined by the
            primary goal + an optional muscle/target focus only. */}

        {/* Training Emphasis picker removed — splits now control focus distribution.
           selectedRegion stays hard-defaulted to 'balanced' so save paths work. */}

        {showTargetWeight && (
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>
              Target weight <Text style={styles.optional}>(optional)</Text>
            </Text>
            <View style={styles.inlineInput}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                placeholder="e.g. 160"
                placeholderTextColor={colors.textMuted}
                keyboardType="decimal-pad"
                value={targetWeight}
                onChangeText={setTargetWeight}
              />
              <Text style={styles.unit}>lbs</Text>
            </View>
          </View>
        )}

        {showTargetEvent && (
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>
              Target goal <Text style={styles.optional}>(optional)</Text>
            </Text>
            {cat === 'cardio_endurance' && (
              <View style={[styles.foodChips, { marginBottom: 10 }]}>
                {ENDURANCE_EVENT_GOALS.map(opt => {
                  const active = selectedGoal === opt.id
                    || (opt.id === 'improve_cardio' && !isEnduranceEventGoal(selectedGoal));
                  return (
                    <TouchableOpacity
                      key={opt.id}
                      activeOpacity={0.75}
                      style={[styles.foodChip, active && styles.foodChipActive]}
                      onPress={() => {
                        setSelectedGoal(opt.id);
                        setSelectedModifiers([]);
                        setPace('moderate');
                        setTargetEvent(opt.targetEvent);
                      }}
                    >
                      <Text style={[styles.foodChipText, active && styles.foodChipTextActive]}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
            <TextInput
              style={styles.input}
              placeholder={eventPlaceholder}
              placeholderTextColor={colors.textMuted}
              value={targetEvent}
              onChangeText={setTargetEvent}
              autoCapitalize="none"
              returnKeyType="done"
            />
          </View>
        )}

        {/* Pace */}
        <Text style={styles.fieldLabel}>How fast?</Text>
        {paceOpts.length > 0 ? (
          <View style={styles.paceCards}>
            {paceOpts.map(opt => {
              const active = pace === opt.value;
              return (
                <TouchableOpacity
                  key={opt.value}
                  style={[styles.paceCard, active && styles.paceCardActive]}
                  onPress={() => setPace(opt.value as GoalPace)}
                  activeOpacity={0.75}
                >
                  <Text style={styles.paceIcon}>{opt.icon}</Text>
                  <Text style={[styles.paceLabel, active && styles.paceLabelActive]}>{opt.label}</Text>
                  <Text style={[styles.paceRate, active && styles.paceRateActive]}>{opt.rate}</Text>
                  <Text style={[styles.paceDesc, active && styles.paceDescActive]}>{opt.description}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ) : (
          <View style={styles.paceCards}>
            {(['conservative', 'moderate', 'aggressive'] as GoalPace[]).map(p => {
              const active = pace === p;
              const labels: Record<string, string> = { conservative: 'Steady', moderate: 'Moderate', aggressive: 'Aggressive' };
              return (
                <TouchableOpacity
                  key={p}
                  style={[styles.paceCard, active && styles.paceCardActive]}
                  onPress={() => setPace(p)}
                  activeOpacity={0.75}
                >
                  <Text style={[styles.paceLabel, active && styles.paceLabelActive]}>{labels[p]}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </View>
    );
  };

  const switchUnitSystem = (next: 'imperial' | 'metric') => {
    if (next === unitSystem) return;
    // Preserve whatever the user already typed by converting across so the
    // toggle doesn't wipe their entered weight/height.
    if (next === 'metric') {
      if (weightLbs) {
        const kg = lbsToUnit(parseFloat(weightLbs), 'kg');
        if (Number.isFinite(kg) && kg > 0) setWeightKg(kg.toFixed(1));
      }
      const ft = parseInt(heightFeet);
      const inch = parseInt(heightInches);
      if (Number.isFinite(ft) || Number.isFinite(inch)) {
        const cm = Math.round(feetInchesToCm(ft || 0, inch || 0));
        if (cm > 0) setHeightCm(String(cm));
      }
    } else {
      if (weightKg) {
        const lbs = unitToLbs(parseFloat(weightKg), 'kg');
        if (Number.isFinite(lbs) && lbs > 0) setWeightLbs(lbs.toFixed(0));
      }
      if (heightCm) {
        const { feet, inches } = cmToFeetInches(parseFloat(heightCm));
        if (feet > 0 || inches > 0) {
          setHeightFeet(String(feet));
          setHeightInches(String(inches));
        }
      }
    }
    setUnitSystem(next);
  };

  const renderPhysicalStatsStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>About You</Text>
      <Text style={styles.stepDescription}>We use this to calculate your daily calorie and macro targets — nothing is shared.</Text>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Units</Text>
        <View style={styles.genderRow}>
          {([
            { value: 'imperial', label: 'Imperial (lb · ft+in)' },
            { value: 'metric',   label: 'Metric (kg · cm)' },
          ] as { value: 'imperial' | 'metric'; label: string }[]).map(opt => (
            <TouchableOpacity
              key={opt.value}
              testID={`onboarding-unit-${opt.value}`}
              accessibilityLabel={`onboarding-unit-${opt.value}`}
              style={[styles.genderButton, unitSystem === opt.value && styles.genderButtonActive]}
              onPress={() => switchUnitSystem(opt.value)}
            >
              <Text style={[styles.genderText, unitSystem === opt.value && styles.genderTextActive]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Current weight</Text>
        {unitSystem === 'imperial' ? (
          <View style={styles.inlineInput}>
            <TextInput
              testID="onboarding-weight-input"
              accessibilityLabel="onboarding-weight-input"
              style={[styles.input, { flex: 1 }]}
              placeholder="e.g. 185"
              placeholderTextColor={colors.textMuted}
              keyboardType="decimal-pad"
              value={weightLbs}
              onChangeText={setWeightLbs}
            />
            <Text style={styles.unit}>lbs</Text>
          </View>
        ) : (
          <View style={styles.inlineInput}>
            <TextInput
              testID="onboarding-weight-kg-input"
              accessibilityLabel="onboarding-weight-kg-input"
              style={[styles.input, { flex: 1 }]}
              placeholder="e.g. 84"
              placeholderTextColor={colors.textMuted}
              keyboardType="decimal-pad"
              value={weightKg}
              onChangeText={setWeightKg}
            />
            <Text style={styles.unit}>kg</Text>
          </View>
        )}
      </View>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Height</Text>
        {unitSystem === 'imperial' ? (
          <View style={styles.heightRow}>
            <View style={[styles.inlineInput, { flex: 1 }]}>
              <TextInput
                testID="onboarding-height-feet-input"
                accessibilityLabel="onboarding-height-feet-input"
                style={[styles.input, { flex: 1 }]}
                placeholder="5"
                placeholderTextColor={colors.textMuted}
                keyboardType="number-pad"
                value={heightFeet}
                onChangeText={setHeightFeet}
                maxLength={1}
              />
              <Text style={styles.unit}>ft</Text>
            </View>
            <View style={[styles.inlineInput, { flex: 1 }]}>
              <TextInput
                testID="onboarding-height-inches-input"
                accessibilityLabel="onboarding-height-inches-input"
                style={[styles.input, { flex: 1 }]}
                placeholder="10"
                placeholderTextColor={colors.textMuted}
                keyboardType="number-pad"
                value={heightInches}
                onChangeText={setHeightInches}
                maxLength={2}
              />
              <Text style={styles.unit}>in</Text>
            </View>
          </View>
        ) : (
          <View style={styles.inlineInput}>
            <TextInput
              testID="onboarding-height-cm-input"
              accessibilityLabel="onboarding-height-cm-input"
              style={[styles.input, { flex: 1 }]}
              placeholder="e.g. 178"
              placeholderTextColor={colors.textMuted}
              keyboardType="number-pad"
              value={heightCm}
              onChangeText={setHeightCm}
              maxLength={3}
            />
            <Text style={styles.unit}>cm</Text>
          </View>
        )}
      </View>

      <View style={styles.fieldGroup}>
        <BirthdateInput
          value={birthdate}
          onChange={setBirthdate}
          label="Birthday"
          hint="We use this to dial in your HR zones and calorie math — and to keep both accurate as you age."
        />
      </View>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Biological sex</Text>
        <Text style={styles.hint}>Used only to calculate your calorie and macro targets — hormones affect metabolism.</Text>
        <View style={[styles.genderRow, { marginTop: 10 }]}>
          {([
            { value: 'male',              label: 'Male' },
            { value: 'female',            label: 'Female' },
            { value: 'nonbinary',         label: 'Non-binary' },
            { value: 'prefer_not_to_say', label: 'Prefer not to say' },
          ] as { value: Gender; label: string }[]).map(opt => (
            <TouchableOpacity
              key={opt.value}
              testID={`gender-option-${opt.value}`}
              accessibilityLabel={`gender-option-${opt.value}`}
              style={[styles.genderButton, gender === opt.value && styles.genderButtonActive]}
              onPress={() => setGender(opt.value)}
            >
              <Text style={[styles.genderText, gender === opt.value && styles.genderTextActive]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

    </View>
  );

  const DURATION_OPTIONS = [
    { value: 30,  label: '20–30 min', desc: 'Express' },
    { value: 45,  label: '30–45 min', desc: 'Standard' },
    { value: 60,  label: '45–60 min', desc: 'Full' },
    { value: 75,  label: '60–75 min', desc: 'Extended' },
    { value: 90,  label: '75–90 min', desc: 'Deep' },
  ];

  const renderTrainingDaysStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>Training Schedule</Text>
      <Text style={styles.stepDescription}>How many days per week can you realistically train? Easy to adjust later.</Text>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
        {[1, 2, 3, 4, 5, 6, 7].map(d => {
          const active = parseInt(daysPerWeek) === d;
          return (
            <TouchableOpacity
              key={d}
              onPress={() => { import('../utils/feedback').then(f => f.hapticLight()).catch(() => {}); setDaysPerWeek(String(d)); }}
              style={{
                flex: 1, paddingVertical: 14, borderRadius: 10,
                backgroundColor: active ? colors.primary : colors.surface,
                borderWidth: active ? 0 : 1,
                borderColor: colors.border,
                alignItems: 'center',
              }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: active ? '#fff' : colors.textPrimary }}>{d}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={{ fontSize: 12, color: colors.textMuted, textAlign: 'center', marginBottom: 16 }}>
        {parseInt(daysPerWeek) >= 6 ? 'Serious commitment — recovery matters at this volume.'
          : parseInt(daysPerWeek) >= 5 ? '5 days works great with good recovery.'
          : parseInt(daysPerWeek) >= 3 ? '3–4 days is ideal for most people.'
          : parseInt(daysPerWeek) >= 1 ? "Every session counts — we'll maximize each one."
          : 'Tap a number above.'}
      </Text>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>How long per session?</Text>
        <View style={styles.paceCards}>
          {DURATION_OPTIONS.map(opt => (
            <TouchableOpacity
              key={opt.value}
              style={[styles.paceCard, workoutDuration === opt.value && styles.paceCardActive]}
              onPress={() => setWorkoutDuration(opt.value)}>
              <Text style={[styles.paceLabel, workoutDuration === opt.value && styles.paceLabelActive]}>{opt.label}</Text>
              <Text style={[styles.paceDesc, workoutDuration === opt.value && styles.paceDescActive]}>{opt.desc}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Lifestyle activity OUTSIDE of training. Captures the gap between
          training-schedule TDEE and reality — a desk worker who lifts
          4×/wk burns ~400 kcal less per day than a construction worker
          who lifts 4×/wk, even with identical workouts. Without this,
          the maintenance estimate over- or under-shoots by hundreds of
          kcal until the HealthKit rolling signal catches up (~7 days).
          For HealthKit-disconnected users this is the only correction
          they get; for connected users it gives a more accurate day-1
          starting point. */}
      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Outside the gym, how active are you?</Text>
        <Text style={[styles.paceDesc, { marginBottom: 8, marginTop: -2 }]}>
          Job and daily movement, not your workouts. Tunes your maintenance calories.
        </Text>
        <View style={{ flexDirection: 'column', gap: 6 }}>
          {([
            { value: 'sedentary',   label: 'Mostly sitting',     desc: 'Desk job, driver — little walking outside training.' },
            { value: 'light',       label: 'On feet sometimes',  desc: 'Teacher, office with movement, light errands.' },
            { value: 'moderate',    label: 'On feet often',      desc: 'Retail, server, nurse — moving most of the day.' },
            { value: 'active',      label: 'Physical work',      desc: 'Trainer, landscaper, walking/biking commute.' },
            { value: 'very_active', label: 'Heavy labor',        desc: 'Construction, mover, multi-sport athlete.' },
          ] as Array<{ value: LifestyleLevel; label: string; desc: string }>).map(opt => {
            const active = lifestyleActivity === opt.value;
            return (
              <TouchableOpacity
                key={opt.value}
                onPress={() => {
                  import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
                  setLifestyleActivity(opt.value);
                }}
                style={{
                  paddingVertical: 12, paddingHorizontal: 14, borderRadius: 10,
                  backgroundColor: active ? colors.primary + '14' : colors.surface,
                  borderWidth: 1.5, borderColor: active ? colors.primary : colors.border,
                }}>
                <Text style={{ fontSize: 14, fontWeight: '800', color: active ? colors.primary : colors.textPrimary }}>
                  {opt.label}
                </Text>
                <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                  {opt.desc}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Day-of-week selector */}
      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Which days?</Text>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
          {(['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const).map((label, dow) => {
            const dpw = parseInt(daysPerWeek) || 3;
            const selected = selectedTrainingDays.includes(dow);
            const atLimit = selectedTrainingDays.length >= dpw && !selected;
            return (
              <TouchableOpacity
                key={dow}
                style={{
                  width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
                  backgroundColor: selected ? colors.primary : colors.surface,
                  borderWidth: 1.5, borderColor: selected ? colors.primary : colors.border,
                  opacity: atLimit ? 0.35 : 1,
                }}
                disabled={atLimit}
                onPress={() => {
                  import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
                  if (selected) {
                    setSelectedTrainingDays(prev => prev.filter(d => d !== dow));
                  } else if (selectedTrainingDays.length < dpw) {
                    setSelectedTrainingDays(prev => [...prev, dow].sort());
                  }
                }}>
                <Text style={{ fontSize: 13, fontWeight: '800', color: selected ? '#fff' : colors.textSecondary }}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 6, textAlign: 'center' }}>
          Tap to customize your training days
        </Text>
      </View>

      {/* Split preference — only shown for goals where a lifting split
          matters. Cardio-only / longevity / mobility goals skip this
          because the planner builds their week around cardio archetypes,
          not a Push/Pull/Legs rotation. Auto mirrors backend scoring. */}
      {(() => {
        const g = selectedGoal;
        // Skip entirely for cardio / endurance / mobility / stress goals —
        // there's no lifting split to choose. The backend plans these via
        // cardio archetypes directly, so asking the user to pick a split
        // would be confusing + could over-constrain the planner.
        const isCardioOnly = /cardio|vo2|aerobic|stamina|running|train_5k|train_10k|train_half|train_marathon|sprint|conditioning/i.test(g);
        const isMobilityOnly = /mobility|stretch|recovery|stress|sleep|longevity|healthy_aging/i.test(g);
        if (isCardioOnly || isMobilityOnly) return null;

        const dpw = Math.max(1, Math.min(7, parseInt(daysPerWeek) || 3));
        // Mirror the backend's deterministic scoring rules so the user
        // sees WHICH split we'd auto-pick + WHY. Keep this tight.
        const autoPick = (): { split: string; label: string; reason: string } => {
          const bulkFamily = /muscle|glute|aesthetic|bulk|gain|arm|shoulder|upper_body|lower_body/i.test(g);
          const fatFamily  = /fat|lean|cut|tone/i.test(g);
          const strFamily  = /strength|power|squat|bench|deadlift|ohp|pull/i.test(g);
          if (dpw <= 2) return { split: 'full_body', label: 'Full Body', reason: 'At 1-2 days, full-body hits every muscle each session for the best frequency.' };
          if (dpw === 3) return { split: 'full_body', label: 'Full Body', reason: '3 full-body sessions give each muscle 3x/week — higher frequency than a split at this volume.' };
          if (bulkFamily && dpw >= 5) return { split: 'ppl', label: 'PPL', reason: `Push/Pull/Legs at ${dpw} days hits each muscle 2x/week — the hypertrophy sweet spot.` };
          if (fatFamily) return { split: 'upper_lower', label: 'Upper/Lower', reason: `Upper/Lower leaves room for cardio days while still hitting every muscle 2x/week.` };
          if (strFamily) return { split: 'upper_lower', label: 'Upper/Lower', reason: 'Upper/Lower spaces heavy compounds with enough recovery between sessions.' };
          if (dpw === 4) return { split: 'upper_lower', label: 'Upper/Lower', reason: '4 days splits cleanly into 2 Upper + 2 Lower — balanced and recoverable.' };
          return { split: 'upper_lower', label: 'Upper/Lower', reason: 'Upper/Lower is the default balance of frequency and recovery for most goals.' };
        };
        const hint = autoPick();

        // One-line descriptions shown with every option so the user
        // knows what each split actually is without having to google.
        const SPLIT_DESCRIPTIONS: Record<string, string> = {
          auto:        'Let the planner pick based on your goal and days/week.',
          ppl:         'Push / Pull / Legs. Rotate 3-day blocks — best for 5-6 days at muscle growth.',
          upper_lower: 'Alternate upper-body and lower-body days. Great for 4 days + built-in recovery.',
          full_body:   'Every session hits everything. Highest frequency — fits 2-3 day weeks well.',
          bro:         'One muscle group per day (Chest / Back / Shoulders / Arms / Legs). Classic 5-day bodybuilding.',
        };
        return (
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Split preference</Text>
            <View style={{ flexDirection: 'column', gap: 6 }}>
              {([
                { value: 'auto',        label: 'Auto' },
                { value: 'ppl',         label: 'PPL' },
                { value: 'upper_lower', label: 'Upper / Lower' },
                { value: 'full_body',   label: 'Full Body' },
                { value: 'bro',         label: 'Bro Split' },
              ] as const).map(opt => {
                const active = preferredSplit === opt.value;
                return (
                  <TouchableOpacity
                    key={opt.value}
                    style={{
                      paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10,
                      backgroundColor: active ? colors.primary + '14' : colors.surface,
                      borderWidth: 1.5, borderColor: active ? colors.primary : colors.border,
                    }}
                    onPress={() => setPreferredSplit(opt.value)}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 14, fontWeight: '700', color: active ? colors.primary : colors.textPrimary }}>{opt.label}</Text>
                      {active && <Ionicons name="checkmark-circle" size={16} color={colors.primary} />}
                    </View>
                    <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 3, lineHeight: 15 }}>
                      {SPLIT_DESCRIPTIONS[opt.value]}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {preferredSplit === 'auto' && (
              <View style={{ marginTop: 10, padding: 10, borderRadius: 10, backgroundColor: colors.primary + '10', borderWidth: 1, borderColor: colors.primary + '44' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <Ionicons name="sparkles-outline" size={12} color={colors.primary} />
                  <Text style={{ fontSize: 11, fontWeight: '800', color: colors.primary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    Auto → {hint.label}
                  </Text>
                </View>
                <Text style={{ fontSize: 12, color: colors.textSecondary, lineHeight: 16 }}>{hint.reason}</Text>
              </View>
            )}
          </View>
        );
      })()}
    </View>
  );

  const renderStrengthLoadSettings = () => {
    const normalized = normalizeStrengthEquipmentSettings(equipmentSettings, selectedEquipment);
    const dumbbells = normalized?.dumbbells ?? DEFAULT_ADJUSTABLE_DUMBBELLS;
    const barbell = normalized?.barbell ?? { barWeightLbs: 45, platePairsLbs: DEFAULT_PLATE_PAIRS_LBS };
    const showDumbbells = hasAdjustableDumbbells(selectedEquipment);
    const showPlates = hasPlateLoadedEquipment(selectedEquipment);
    if (!showDumbbells && !showPlates) return null;

    const updateDumbbells = (patch: Partial<NonNullable<StrengthEquipmentSettings['dumbbells']>>) => {
      setEquipmentSettings(prev => ({
        ...(prev ?? {}),
        dumbbells: { ...(prev?.dumbbells ?? DEFAULT_ADJUSTABLE_DUMBBELLS), ...patch, type: 'adjustable' },
      }));
    };
    const updateBarbell = (patch: Partial<NonNullable<StrengthEquipmentSettings['barbell']>>) => {
      setEquipmentSettings(prev => ({
        ...(prev ?? {}),
        barbell: { barWeightLbs: 45, platePairsLbs: DEFAULT_PLATE_PAIRS_LBS, ...(prev?.barbell ?? {}), ...patch },
      }));
    };
    const togglePlate = (plate: number) => {
      const current = barbell.platePairsLbs ?? DEFAULT_PLATE_PAIRS_LBS;
      const next = current.includes(plate)
        ? current.filter(p => p !== plate)
        : [...current, plate].sort((a, b) => b - a);
      updateBarbell({ platePairsLbs: next });
    };

    return (
      <View style={{ marginTop: 16 }}>
        <Text style={styles.sectionHeading}>Load setup</Text>
        <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 10 }}>
          We use this so suggested weights match what you can actually load.
        </Text>
        {showDumbbells && (
          <View style={{ marginBottom: 12 }}>
            <Text style={styles.foodCategoryLabel}>Adjustable dumbbells</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {[
                { label: 'Min', value: dumbbells.minLbs, key: 'minLbs' },
                { label: 'Max', value: dumbbells.maxLbs, key: 'maxLbs' },
                { label: 'Step', value: dumbbells.incrementLbs, key: 'incrementLbs' },
              ].map(item => (
                <View key={item.key} style={{ flex: 1 }}>
                  <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 4 }}>{item.label}</Text>
                  <TextInput
                    style={styles.input}
                    keyboardType="decimal-pad"
                    value={String(item.value ?? '')}
                    onChangeText={(text) => updateDumbbells({ [item.key]: parseFloat(text) || undefined } as any)}
                    placeholder={String(item.value ?? '')}
                    placeholderTextColor={colors.textMuted}
                  />
                </View>
              ))}
            </View>
          </View>
        )}
        {showPlates && (
          <View>
            <Text style={styles.foodCategoryLabel}>Plate pairs you can load</Text>
            <View style={styles.foodChips}>
              {PLATE_PAIR_OPTIONS_LBS.map(plate => {
                const selected = (barbell.platePairsLbs ?? DEFAULT_PLATE_PAIRS_LBS).includes(plate);
                return (
                  <TouchableOpacity
                    key={plate}
                    style={[styles.foodChip, selected && styles.foodChipActive]}
                    onPress={() => togglePlate(plate)}>
                    <Text style={[styles.foodChipText, selected && styles.foodChipTextActive]}>{plate} lb</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}
      </View>
    );
  };

  const renderEquipmentStep = () => (
    <View style={styles.stepContainer}>
      {renderStepHero(STOCK_IMAGES.onboarding.equipment, 'Match your setup', 'Gym, home, garage, or bodyweight')}
      <Text style={styles.stepTitle}>Your Equipment</Text>
      <Text style={styles.stepDescription}>
        Select what you have access to. You can update this anytime.
        {selectedEquipment.length > 0 ? `  ·  ${selectedEquipment.length} selected` : ''}
      </Text>

      {/* Quick-start templates */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <Ionicons name="flash" size={14} color={colors.primary} />
        <Text style={[styles.sectionHeading, { marginBottom: 0, marginTop: 0, color: colors.primary }]}>
          Quick start · tap to apply
        </Text>
      </View>
      <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 10 }}>
        Pick a preset — you can still customize the list below.
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast" style={styles.templateScroll} contentContainerStyle={styles.templateScrollContent}>
        {EQUIPMENT_TEMPLATES.map(t => {
          const active = selectedEquipTemplate === t.id;
          return renderEquipmentTemplateCard(t, active, 'equipment-template');
        })}
      </ScrollView>

      {/* Photo scan */}
      <View style={styles.scanSectionCompact}>
        <View style={styles.scanCompactHeader}>
          <View style={styles.scanCompactIcon}>
            <Ionicons name="scan-outline" size={18} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.scanSectionTitle}>Scan setup</Text>
            <Text style={styles.scanSectionSubCompact}>Optional. Best when presets do not match your equipment.</Text>
          </View>
        </View>
        <View style={styles.scanCompactRow}>
          <TouchableOpacity
            style={[styles.scanCompactBtnPrimary, equipScanLoading && { opacity: 0.5 }]}
            onPress={() => handleScanEquipment('camera')}
            disabled={equipScanLoading}>
            {equipScanLoading
              ? <ActivityIndicator size="small" color="#fff" />
              : (
                <>
                  <Ionicons name="camera-outline" size={15} color="#FFFFFF" />
                  <Text style={styles.scanCompactBtnPrimaryText}>Camera</Text>
                </>
              )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.scanCompactBtnSecondary, equipScanLoading && { opacity: 0.5 }]}
            onPress={() => handleScanEquipment('library')}
            disabled={equipScanLoading}>
            <Ionicons name="images-outline" size={15} color={colors.primary} />
            <Text style={styles.scanCompactBtnSecondaryText}>Library</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Manual selection */}
      <Text style={styles.sectionHeading}>Or pick manually</Text>
      <View style={styles.searchRow}>
        <TextInput
          style={[styles.input, styles.searchInput, { flex: 1 }]}
          placeholder="Search equipment..."
          placeholderTextColor={colors.textMuted}
          value={equipmentSearch}
          onChangeText={setEquipmentSearch}
          autoCapitalize="none"
          returnKeyType="done"
        />
        {equipmentSearch.length > 0 && (
          <TouchableOpacity style={styles.clearBtn} onPress={() => setEquipmentSearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.clearBtnText}><Ionicons name="close" size={16} /></Text>
          </TouchableOpacity>
        )}
      </View>
      {meta.loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />
      ) : (
        meta.equipmentCategories.map(category => {
          const filteredItems = equipmentSearch.trim()
            ? category.items.filter(item => equipmentItemMatchesSearch(item, equipmentSearch))
            : category.items;
          if (filteredItems.length === 0) return null;
          return (
            <View key={category.label} style={styles.foodCategory}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {/* Equipment category — `barbell-outline` is the neutral
                    fallback when the seed icon is an emoji. */}
                <Ionicons
                  name={(category.icon.includes('-') ? category.icon : 'barbell-outline') as any}
                  size={16}
                  color={colors.textSecondary}
                />
                <Text style={styles.foodCategoryLabel}>{category.label}</Text>
              </View>
              <View style={styles.foodChips}>
                {filteredItems.map(item => {
                  const selected = equipmentItemSelected(item, selectedEquipment);
                  return (
                    <Pressable
                      key={item.name}
                      onPress={() => toggleEquipmentItem(item)}
                      style={[
                        styles.foodChip,
                        selected && styles.foodChipActive,
                        { flexDirection: 'row', alignItems: 'center', gap: 6 },
                      ]}>
                      <Text style={[styles.foodChipText, selected && styles.foodChipTextActive]}>
                        {item.name}
                      </Text>
                      <Pressable
                        onPress={(e) => { e.stopPropagation(); setEquipmentInfo({ name: item.name, slug: (item as any).slug }); }}
                        hitSlop={{ top: 8, bottom: 8, left: 6, right: 8 }}
                        accessibilityLabel={`What is ${item.name}?`}>
                        <Ionicons
                          name="information-circle-outline"
                          size={14}
                          color={selected ? '#fff' : colors.textMuted}
                        />
                      </Pressable>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          );
        })
      )}

      {renderStrengthLoadSettings()}

      {equipmentGoalWarnings.length > 0 && (
        <View style={styles.guardrailBox}>
          <View style={styles.guardrailHeader}>
            <Ionicons name="warning-outline" size={15} color={colors.warning ?? '#F59E0B'} />
            <Text style={styles.guardrailTitle}>Goal and equipment mismatch</Text>
          </View>
          {equipmentGoalWarnings.map((warning, index) => (
            <Text key={`${warning}-${index}`} {...dynamicTextProps} style={styles.guardrailText}>
              {warning}
            </Text>
          ))}
        </View>
      )}

      {/* Equipment scan confirm modal */}
      <Modal visible={showEquipScanModal} transparent animationType="slide" onRequestClose={() => setShowEquipScanModal(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.scanModal}>
            <Text style={styles.scanModalTitle}>Equipment Found</Text>
            <Text style={styles.scanModalSub}>These were identified in your photo. Tap to deselect any.</Text>
            <ScrollView style={{ maxHeight: 300 }}>
              {scannedEquipment.map(name => (
                <TouchableOpacity
                  key={name}
                  style={styles.scannedRow}
                  onPress={() => setScannedEquipment(prev => prev.filter(e => e !== name))}>
                  <View style={[styles.scannedCheck, { backgroundColor: colors.primary }]}>
                    <Text style={styles.scannedCheckMark}><Ionicons name="checkmark" size={14} color="#fff" /></Text>
                  </View>
                  <Text style={styles.scannedName}>{name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <View style={styles.scanModalBtns}>
              <TouchableOpacity style={styles.scanModalCancel} onPress={() => setShowEquipScanModal(false)}>
                <Text style={styles.scanModalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.scanModalConfirm} onPress={confirmScannedEquipment}>
                <Text style={styles.scanModalConfirmText}>Add {scannedEquipment.length} items</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );

  const updateStrengthBaseline = (
    key: StrengthBaselineLiftKey,
    patch: Partial<{ weightLbs: string; reps: string }>,
  ) => {
    setStrengthBaselineInputs(prev => ({
      ...prev,
      [key]: { ...(prev[key] ?? { weightLbs: '', reps: '' }), ...patch },
    }));
  };

  const toggleCardioMode = (mode: string) => {
    setCardioPreferredModes(prev =>
      prev.includes(mode) ? prev.filter(m => m !== mode) : [...prev, mode]
    );
  };

  const renderBaselineStep = () => (
    <View style={styles.stepContainer}>
      {renderStepHero(STOCK_IMAGES.onboarding.baseline, 'Set the starting line', 'Recent working sets make week one smarter')}
      <Text style={styles.stepTitle}>Starting Point</Text>
      <Text style={styles.stepDescription}>
        Optional recent working sets and cardio markers help set safer first-week targets.
      </Text>
      <View style={styles.baselineWhyBox}>
        <Ionicons name="information-circle-outline" size={18} color={colors.primary} />
        <Text style={styles.baselineWhyText}>
          A recent working set tells us where to start your weights, how fast to progress, and when to stay conservative. Use normal training sets, not maxes.
        </Text>
      </View>
      <Text style={styles.optionalBanner}>Skip any lift you do not know.</Text>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Training experience</Text>
        <View style={{ gap: 8 }}>
          {EXPERIENCE_OPTIONS.map(opt => {
            const active = experienceLevel === opt.value;
            return (
              <TouchableOpacity
                key={opt.value}
                style={[
                  styles.paceCard,
                  active && styles.paceCardActive,
                  { alignItems: 'flex-start', paddingVertical: 12, paddingHorizontal: 14 },
                ]}
                onPress={() => setExperienceLevel(opt.value)}>
                <Text style={[styles.paceLabel, active && styles.paceLabelActive, { textAlign: 'left', fontSize: 13 }]}>
                  {opt.label}
                </Text>
                <Text style={[styles.paceDesc, active && styles.paceDescActive, { textAlign: 'left', fontSize: 11, lineHeight: 15 }]}>
                  {opt.desc}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      <View style={styles.fieldGroup}>
        <Text style={styles.sectionHeading}>Strength starting weights</Text>
        <Text style={[styles.hint, { marginTop: -4, marginBottom: 10 }]}>
          Enter the weight you actually used and the reps you completed with good form.
        </Text>
        <View style={{ gap: 10 }}>
          {STRENGTH_BASELINE_LIFTS.map(lift => {
            const input = strengthBaselineInputs[lift.key] ?? { weightLbs: '', reps: '' };
            const isPullUp = lift.key === 'pull_up';
            return (
              <View
                key={lift.key}
                style={{
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                  borderRadius: radius.md,
                  padding: 12,
                }}>
                <Text style={styles.baselineLiftTitle}>
                  {lift.label}
                </Text>
                <Text style={styles.baselineLiftHelp}>{lift.help}</Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {!isPullUp && (
                    <View style={styles.baselineInputColumn}>
                      <Text style={styles.baselineInputLabel}>Weight used</Text>
                      <View style={styles.inlineInput}>
                        <TextInput
                          style={[styles.input, { flex: 1, paddingVertical: 11 }]}
                          placeholder={lift.weightPlaceholder}
                          placeholderTextColor={colors.textMuted}
                          keyboardType="decimal-pad"
                          value={input.weightLbs}
                          onChangeText={text => updateStrengthBaseline(lift.key, { weightLbs: text })}
                          onFocus={scrollToInput}
                        />
                        <Text style={[styles.unit, { minWidth: 24 }]}>lb</Text>
                      </View>
                    </View>
                  )}
                  <View style={[styles.baselineInputColumn, { flex: isPullUp ? 1 : 0.72 }]}>
                    <Text style={styles.baselineInputLabel}>{isPullUp ? 'Bodyweight reps' : 'Reps completed'}</Text>
                    <View style={styles.inlineInput}>
                      <TextInput
                        style={[styles.input, { flex: 1, paddingVertical: 11 }]}
                        placeholder={lift.repsPlaceholder}
                        placeholderTextColor={colors.textMuted}
                        keyboardType="number-pad"
                        value={input.reps}
                        onChangeText={text => updateStrengthBaseline(lift.key, { reps: text })}
                        onFocus={scrollToInput}
                      />
                      <Text style={[styles.unit, { minWidth: 34 }]}>reps</Text>
                    </View>
                  </View>
                </View>
              </View>
            );
          })}
        </View>
      </View>

      <View style={styles.fieldGroup}>
        <Text style={styles.sectionHeading}>Cardio</Text>
        <Text style={styles.fieldLabel}>Can you jog continuously for 10 minutes?</Text>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
          {[
            { value: true, label: 'Yes' },
            { value: false, label: 'Not yet' },
          ].map(opt => {
            const active = cardioCanJog10 === opt.value;
            return (
              <TouchableOpacity
                key={String(opt.value)}
                style={[styles.paceCard, active && styles.paceCardActive]}
                onPress={() => setCardioCanJog10(opt.value)}>
                <Text style={[styles.paceLabel, active && styles.paceLabelActive]}>{opt.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 4 }}>Comfortable min</Text>
            <TextInput
              style={styles.input}
              placeholder="20"
              placeholderTextColor={colors.textMuted}
              keyboardType="number-pad"
              value={cardioComfortableDuration}
              onChangeText={setCardioComfortableDuration}
              onFocus={scrollToInput}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 4 }}>Mile time</Text>
            <TextInput
              style={styles.input}
              placeholder="9:30"
              placeholderTextColor={colors.textMuted}
              keyboardType="numbers-and-punctuation"
              value={cardioMileTime}
              onChangeText={setCardioMileTime}
              onFocus={scrollToInput}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 4 }}>5K time</Text>
            <TextInput
              style={styles.input}
              placeholder="30:00"
              placeholderTextColor={colors.textMuted}
              keyboardType="numbers-and-punctuation"
              value={cardioFiveKTime}
              onChangeText={setCardioFiveKTime}
              onFocus={scrollToInput}
            />
          </View>
        </View>

        <View style={[styles.foodChips, { marginTop: 12 }]}>
          {CARDIO_BASELINE_MODES.map(mode => {
            const selected = cardioPreferredModes.includes(mode);
            return (
              <TouchableOpacity
                key={mode}
                style={[styles.foodChip, selected && styles.foodChipActive]}
                onPress={() => toggleCardioMode(mode)}>
                <Text style={[styles.foodChipText, selected && styles.foodChipTextActive]}>{mode}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    </View>
  );

  const addFoodToKitchen = (food: string) => {
    const name = food.trim();
    if (!name) return;
    const lowerName = name.toLowerCase();
    setFoodsAvailable(prev => prev.some(existing => existing.toLowerCase() === lowerName) ? prev : [...prev, name]);
  };

  const handleFoodSearchChange = (text: string) => {
    setFoodSearch(text);
  };

  const toggleFood = (food: string) => {
    const name = food.trim();
    if (!name) return;
    const lowerName = name.toLowerCase();
    setFoodsAvailable(prev =>
      prev.some(existing => existing.toLowerCase() === lowerName)
        ? prev.filter(existing => existing.toLowerCase() !== lowerName)
        : [...prev, name]
    );
  };

  const renderFoodsStep = () => {
    const foodSearchTerm = foodSearch.trim();
    const foodSearchLower = foodSearchTerm.toLowerCase();
    const selectedFoodNameSet = new Set(foodsAvailable.map(f => f.toLowerCase()));
    const catalogFoodNameSet = new Set(
      meta.foodCategories.flatMap(category => category.foods.map(food => food.name.toLowerCase()))
    );
    const addedFoodNames = foodsAvailable.filter(food => !catalogFoodNameSet.has(food.toLowerCase()));
    const browseFoodCategories = meta.foodCategories
      .map(category => ({
        ...category,
        foods: category.foods.filter((food, idx) => {
          const foodNameLower = food.name.toLowerCase();
          if (foodSearchLower) return foodNameLower.includes(foodSearchLower);
          return idx < BASE_FOODS_PER_CATEGORY || selectedFoodNameSet.has(foodNameLower);
        }),
      }))
      .filter(category => category.foods.length > 0);
    const exactSearchKnown = meta.allFoods.some(f => f.name.toLowerCase() === foodSearchLower);
    const canAddSearchTerm = !!foodSearchTerm && !selectedFoodNameSet.has(foodSearchLower) && !exactSearchKnown;
    const visibleFoodCatalogResults = foodCatalogResults;

    return (
    <View style={styles.stepContainer}>
      {renderStepHero(STOCK_IMAGES.onboarding.foodScan, 'Scan your kitchen', 'Fridge, pantry, meal prep, or groceries')}
      <Text style={styles.stepTitle}>Your Kitchen</Text>
      <Text style={styles.stepDescription}>
        Optional. Choose foods only if you want generated meals to use what you like or already have.
        {foodsAvailable.length > 0 ? `  ·  ${foodsAvailable.length} selected` : ''}
      </Text>

      {/* Allergies & restrictions — collected before food selection so the
          AI meal planner and barcode/scan flows can filter these out from
          the start. Tap-to-toggle category chips; matches the canonical
          allergen slugs the backend already understands. */}
      <View style={{ marginBottom: 18 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Ionicons name="warning-outline" size={14} color={colors.warning ?? '#F59E0B'} />
          <Text style={[styles.sectionHeading, { marginBottom: 0, marginTop: 0 }]}>
            Allergies & restrictions
          </Text>
        </View>
        <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 10 }}>
          Tap any that apply. Meal suggestions and food scans will avoid these.
        </Text>
        {renderAllergyChips()}
      </View>

      {/* Photo scan — top, prominent */}
      <View style={styles.scanSection}>
        <Text style={styles.scanSectionTitle}>Scan your fridge or pantry</Text>
        <Text style={styles.scanSectionSub}>AI will identify your foods automatically. Add context only when the photos need it.</Text>
        <Text style={styles.scanContextLabel}>Photo context <Text style={styles.scanContextOptional}>optional</Text></Text>
        <TextInput
          style={[styles.input, styles.scanContextInput]}
          value={foodScanContext}
          onChangeText={setFoodScanContext}
          placeholder="Restaurant, shared plate, meal prep batch"
          placeholderTextColor={colors.textMuted}
          returnKeyType="done"
          onSubmitEditing={() => Keyboard.dismiss()}
        />
        <View style={styles.scanRow}>
          <TouchableOpacity
            style={[styles.scanBtnPrimary, foodScanLoading && { opacity: 0.5 }]}
            onPress={() => handleScanFoods('camera')}
            disabled={foodScanLoading}>
            {foodScanLoading
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={styles.scanBtnPrimaryText}>Take Photo</Text>}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.scanBtnSecondary, foodScanLoading && { opacity: 0.5 }]}
            onPress={() => handleScanFoods('library')}
            disabled={foodScanLoading}>
            <Text style={styles.scanBtnSecondaryText}>Choose from Library</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Quick diet presets */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <Ionicons name="flash" size={14} color={colors.primary} />
        <Text style={[styles.sectionHeading, { marginBottom: 0, marginTop: 0, color: colors.primary }]}>
          Quick start · tap to apply
        </Text>
      </View>
      <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 10 }}>
        Pick the eating style closest to yours — you can adjust the food list below.
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast" style={styles.templateScroll} contentContainerStyle={styles.templateScrollContent}>
        {FOOD_PRESETS.map(p => {
          const active = selectedFoodPreset === p.id;
          return renderFoodPresetCard(p, active, 'food-preset');
        })}
      </ScrollView>

      <Text style={styles.sectionHeading}>Pick foods</Text>
      <View style={styles.searchRow}>
        <TextInput
          style={[styles.input, styles.searchInput, { flex: 1 }]}
          placeholder="Search foods..."
          placeholderTextColor={colors.textMuted}
          value={foodSearch}
          onChangeText={handleFoodSearchChange}
          autoCapitalize="none"
          onSubmitEditing={() => {
            if (foodSearchTerm.length < 2 && canAddSearchTerm) {
              addFoodToKitchen(foodSearchTerm);
              setFoodSearch('');
            } else {
              Keyboard.dismiss();
            }
          }}
          returnKeyType="search"
        />
        {foodSearch.length > 0 && (
          <TouchableOpacity style={styles.clearBtn} onPress={() => setFoodSearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.clearBtnText}><Ionicons name="close" size={16} /></Text>
          </TouchableOpacity>
        )}
      </View>
      {meta.loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />
      ) : (
        <>
          {foodCatalogSearchLoading ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.hint, { marginTop: 0, marginBottom: 0 }]}>Searching foods...</Text>
            </View>
          ) : null}
          {foodCatalogSearchError ? (
            <Text style={[styles.hint, { marginTop: 0, marginBottom: 12 }]}>
              {foodCatalogSearchError}
            </Text>
          ) : null}
          {visibleFoodCatalogResults.length > 0 ? (
            <View style={{ marginBottom: 16 }}>
              <Text style={[styles.foodCategoryLabel, { marginBottom: 8 }]}>Catalog Results</Text>
              {visibleFoodCatalogResults.map((item, idx) => {
                const sourceLabel = badgeLabelForSource(item.source);
                const active = selectedFoodNameSet.has(item.name.toLowerCase());
                return (
                  <TouchableOpacity
                    key={`${item.name}-${item.fdc_id ?? item.food_id ?? idx}`}
                    activeOpacity={0.78}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      backgroundColor: active ? colors.surfaceRaised : colors.surface,
                      borderRadius: radius.md,
                      borderWidth: 1,
                      borderColor: active ? colors.primary : colors.primary + '44',
                      padding: 12,
                      marginBottom: 8,
                    }}
                    onPress={() => toggleFood(item.name)}>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                        <Text style={{ flex: 1, fontSize: 14, fontWeight: '700', color: colors.textPrimary }}>
                          {item.name}
                        </Text>
                        {sourceLabel ? (
                          <Text style={{ fontSize: 10, fontWeight: '800', color: colors.primary }}>
                            {sourceLabel}
                          </Text>
                        ) : null}
                      </View>
                      <Text style={{ fontSize: 11, color: colors.textMuted }}>{item.serving}</Text>
                      <Text style={{ fontSize: 11, color: colors.textSecondary, marginTop: 2 }}>
                        {Math.round(item.calories)} cal · {Math.round(item.protein)}g pro · {Math.round(item.carbs)}g carbs · {Math.round(item.fat)}g fat
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 10 }}>
                      {active ? <Ionicons name="checkmark-circle" size={15} color={colors.primary} /> : null}
                      <Text style={{ fontSize: 13, fontWeight: '800', color: colors.primary }}>
                        {active ? 'Selected' : '+ Add'}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : null}
          {canAddSearchTerm && (
            <TouchableOpacity
              style={[styles.foodChip, { alignSelf: 'flex-start', marginBottom: 14, borderColor: colors.primary }]}
              onPress={() => {
                addFoodToKitchen(foodSearchTerm);
                setFoodSearch('');
              }}>
              <Text style={[styles.foodChipText, { color: colors.primary, fontWeight: '700' }]}>Add "{foodSearchTerm}"</Text>
            </TouchableOpacity>
          )}
          {foodSearchLower && browseFoodCategories.length === 0 && !canAddSearchTerm ? (
            <Text style={[styles.hint, { marginTop: 0, marginBottom: 14 }]}>No matching foods.</Text>
          ) : null}
          {browseFoodCategories.length > 0 ? (
            <View style={{ marginBottom: 2 }}>
              <Text style={[styles.foodCategoryLabel, { marginBottom: 12 }]}>
                {foodSearchLower ? 'Matching Foods' : 'Common Foods'}
              </Text>
              {browseFoodCategories.map(category => (
                <View key={category.key} style={styles.foodCategory}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {/* Food category — `restaurant-outline` is the neutral
                        fallback when the seed icon is an emoji. */}
                    <Ionicons
                      name={(category.icon.includes('-') ? category.icon : 'restaurant-outline') as any}
                      size={16}
                      color={colors.textSecondary}
                    />
                    <Text style={styles.foodCategoryLabel}>{category.label}</Text>
                  </View>
                  <View style={styles.foodChips}>
                    {category.foods.map(food => {
                      const active = selectedFoodNameSet.has(food.name.toLowerCase());
                      return (
                        <TouchableOpacity
                          key={food.name}
                          style={[styles.foodChip, active && styles.foodChipActive]}
                          onPress={() => toggleFood(food.name)}>
                          <Text style={[styles.foodChipText, active && styles.foodChipTextActive]}>
                            {food.name}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              ))}
            </View>
          ) : null}
        </>
      )}

      {addedFoodNames.length > 0 ? (
        <>
          <Text style={styles.sectionHeading}>Added foods</Text>
          <View style={[styles.foodChips, { marginBottom: 18 }]}>
            {addedFoodNames.map(name => (
              <TouchableOpacity
                key={name}
                style={[styles.foodChip, styles.foodChipActive]}
                onPress={() => toggleFood(name)}>
                <Text style={[styles.foodChipText, styles.foodChipTextActive]}>
                  {name} <Ionicons name="close" size={12} />
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </>
      ) : null}

      <Text style={styles.hint}>Skip this step to use default meal suggestions.</Text>

      {/* Food scan confirm modal */}
      <Modal visible={showFoodScanModal} transparent animationType="slide" onRequestClose={() => setShowFoodScanModal(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.scanModal}>
            <Text style={styles.scanModalTitle}>Foods Found</Text>
            <Text style={styles.scanModalSub}>Tap any item to deselect it before adding.</Text>
            <ScrollView style={{ maxHeight: 300 }}>
              {scannedFoods.map((f, idx) => (
                <TouchableOpacity
                  key={idx}
                  style={styles.scannedRow}
                  onPress={() => setScannedFoods(prev =>
                    prev.map((item, i) => i === idx ? { ...item, selected: !item.selected } : item)
                  )}>
                  <View style={[styles.scannedCheck, { backgroundColor: f.selected ? colors.primary : colors.border }]}>
                    {f.selected && <Text style={styles.scannedCheckMark}><Ionicons name="checkmark" size={14} color="#fff" /></Text>}
                  </View>
                  <Text style={[styles.scannedName, !f.selected && { color: colors.textMuted }]}>{f.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <View style={styles.scanModalBtns}>
              <TouchableOpacity style={styles.scanModalCancel} onPress={() => setShowFoodScanModal(false)}>
                <Text style={styles.scanModalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.scanModalConfirm}
                onPress={confirmScannedFoods}>
                <Text style={styles.scanModalConfirmText}>
                  Add {scannedFoods.filter(f => f.selected).length} foods
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
  };

  const toggleSupplement = (name: string) => {
    setSupplementsAvailable(prev =>
      prev.includes(name) ? prev.filter(s => s !== name) : [...prev, name]
    );
  };

  const renderSupplementsStep = () => (
    <View style={styles.stepContainer}>
      {renderStepHero(STOCK_IMAGES.onboarding.supplements, 'Keep the stack clean', 'Avoid duplicate recommendations')}
      <Text style={styles.stepTitle}>Supplements</Text>
      <Text style={styles.stepDescription}>
        Already taking supplements? Select them so the AI doesn't recommend duplicates.
        {supplementsAvailable.length > 0 ? `  ·  ${supplementsAvailable.length} selected` : ''}
      </Text>
      <Text style={styles.optionalBanner}>Completely optional — most people skip this step.</Text>

      {SUPPLEMENT_CATEGORIES.map(category => (
        <View key={category.key} style={styles.foodCategory}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {/* Supplement category — `flask-outline` reads as
                    "supplement bottle / formulation" without leaning on
                    an emoji glyph. */}
                <Ionicons
                  name={(category.icon.includes('-') ? category.icon : 'flask-outline') as any}
                  size={16}
                  color={colors.textSecondary}
                />
                <Text style={styles.foodCategoryLabel}>{category.label}</Text>
              </View>
          <View style={styles.foodChips}>
            {category.items.map(item => {
              const selected = supplementsAvailable.includes(item);
              return (
                <TouchableOpacity
                  key={item}
                  style={[styles.foodChip, selected && styles.foodChipActive]}
                  onPress={() => toggleSupplement(item)}>
                  <Text style={[styles.foodChipText, selected && styles.foodChipTextActive]}>
                    {item}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      ))}

      <Text style={styles.hint}>Don't take any? Just tap Next — the AI will suggest what could help your goal later.</Text>
    </View>
  );

  const renderMealRoutineStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>Meal Routine</Text>
      <Text style={styles.stepDescription}>
        Have a go-to eating pattern? The AI nutritionist will build around it instead of replacing it.
      </Text>
      <TextInput
        style={[styles.input, { height: 120, textAlignVertical: 'top', paddingTop: 12 }]}
        placeholder={'Example: I have a protein shake every morning. I meal prep chicken and rice for lunch on weekdays. I do the same dinner routine each night.'}
        placeholderTextColor={colors.textMuted}
        value={mealRoutine}
        onChangeText={setMealRoutine}
        multiline
        numberOfLines={5}
        onFocus={scrollToInput}
      />
      <Text style={styles.hint}>Leave blank and the AI will plan everything from scratch. You can always change this later.</Text>
    </View>
  );

  const EXPERIENCE_OPTIONS: { value: 'beginner' | 'intermediate' | 'advanced'; label: string; desc: string }[] = [
    { value: 'beginner',     label: 'Beginner',     desc: 'New to structured training or returning after a long break' },
    { value: 'intermediate', label: 'Intermediate',  desc: 'Training consistently for 6+ months' },
    { value: 'advanced',     label: 'Advanced',      desc: 'Training seriously for 2+ years with solid technique' },
  ];

  // Body parts for the structured onboarding injury picker. Mirrors the
  // post-signup EditProfile picker (and its muscle-group map) so the
  // planner sees the same `_INJURY_MAP` keys regardless of where the
  // entry was created.
  const ONBOARDING_INJURY_BODY_PARTS: { key: string; muscles: string[] }[] = [
    { key: 'Shoulder',    muscles: ['shoulders', 'chest'] },
    { key: 'Elbow',       muscles: ['biceps', 'triceps'] },
    { key: 'Wrist',       muscles: ['shoulders'] },
    { key: 'Lower Back',  muscles: ['back', 'core', 'hamstrings'] },
    { key: 'Hip',         muscles: ['glutes', 'hamstrings'] },
    { key: 'Knee',        muscles: ['quads', 'hamstrings'] },
    { key: 'Ankle',       muscles: ['calves'] },
    { key: 'Other',       muscles: [] },
  ];

  const addOnboardingInjury = (
    bodyPart: string,
    muscles: string[],
    severity: 'mild' | 'moderate' | 'severe',
  ) => {
    const entry: InjuryEntry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      description: `${bodyPart} (${severity})`,
      bodyPart,
      muscleGroups: muscles,
      severity,
      reportedAt: new Date().toISOString(),
      status: 'active',
    };
    setOnboardingInjuries(prev => [...prev, entry]);
    setNoInjuriesAck(false);
  };

  const removeOnboardingInjury = (id: string) => {
    setOnboardingInjuries(prev => prev.filter(e => e.id !== id));
  };

  // Per-step UI state — which body part is being configured (severity
  // pick is shown inline once a chip is tapped).
  const [pendingInjuryPart, setPendingInjuryPart] = useState<{ key: string; muscles: string[] } | null>(null);

  const renderInjuriesStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>Any injuries or limitations?</Text>
      <Text style={styles.stepDescription}>
        We'll plan around them automatically — exercises that could aggravate an
        injury are filtered out, and severe injuries also block adjacent movements.
      </Text>

      <View style={styles.fieldGroup}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {ONBOARDING_INJURY_BODY_PARTS.map(bp => {
            const alreadyAdded = onboardingInjuries.some(e => e.bodyPart === bp.key);
            const isPending = pendingInjuryPart?.key === bp.key;
            return (
              <TouchableOpacity
                key={bp.key}
                style={{
                  paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10,
                  borderWidth: 1,
                  borderColor: alreadyAdded || isPending ? colors.primary : colors.border,
                  backgroundColor: alreadyAdded || isPending ? (colors.primary as string) + '18' : colors.surface,
                }}
                onPress={() => {
                  setNoInjuriesAck(false);
                  setPendingInjuryPart(isPending ? null : { key: bp.key, muscles: bp.muscles });
                }}>
                <Text style={{ fontSize: 13, fontWeight: alreadyAdded || isPending ? '700' : '500', color: alreadyAdded || isPending ? colors.primary : colors.textPrimary }}>
                  {alreadyAdded ? `✓ ${bp.key}` : bp.key}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Inline severity picker — shown after a body part is tapped.
            Severity drives planner aggressiveness: mild = avoid direct
            aggravators, moderate = block risky patterns, severe = also
            block adjacent family. */}
        {pendingInjuryPart && (
          <View style={{ marginTop: 14 }}>
            <Text style={styles.fieldLabel}>How severe is the {pendingInjuryPart.key.toLowerCase()} issue?</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
              {(['mild', 'moderate', 'severe'] as const).map(sev => (
                <TouchableOpacity
                  key={sev}
                  style={{
                    flex: 1, paddingVertical: 10, borderRadius: 10,
                    borderWidth: 1, borderColor: colors.border,
                    backgroundColor: colors.background, alignItems: 'center',
                  }}
                  onPress={() => {
                    addOnboardingInjury(pendingInjuryPart.key, pendingInjuryPart.muscles, sev);
                    setPendingInjuryPart(null);
                  }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textPrimary, textTransform: 'capitalize' }}>{sev}</Text>
                  <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 2 }}>
                    {sev === 'mild' ? 'avoid aggravators' : sev === 'moderate' ? 'block risky moves' : 'block family'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {/* Captured injuries — tap to remove. */}
        {onboardingInjuries.length > 0 && (
          <View style={{ marginTop: 16, gap: 6 }}>
            <Text style={styles.fieldLabel}>Saved</Text>
            {onboardingInjuries.map(entry => (
              <TouchableOpacity
                key={entry.id}
                onPress={() => removeOnboardingInjury(entry.id)}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 8,
                  paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10,
                  borderWidth: 1, borderColor: colors.border,
                  backgroundColor: colors.surface,
                }}>
                <Text style={{ flex: 1, fontSize: 13, color: colors.textPrimary }}>
                  {entry.bodyPart} <Text style={{ color: colors.textMuted }}>· {entry.severity}</Text>
                </Text>
                <Ionicons name="close-circle" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* "No injuries" pill — clears the list and acknowledges the
            answer so the user isn't pressured to pick a body part. */}
        <TouchableOpacity
          style={{
            marginTop: 18, paddingVertical: 11, borderRadius: 10,
            borderWidth: 1,
            borderColor: noInjuriesAck && onboardingInjuries.length === 0 ? colors.primary : colors.border,
            backgroundColor: noInjuriesAck && onboardingInjuries.length === 0 ? (colors.primary as string) + '18' : colors.background,
            alignItems: 'center',
          }}
          onPress={() => {
            setOnboardingInjuries([]);
            setPendingInjuryPart(null);
            setNoInjuriesAck(true);
          }}>
          <Text style={{ fontSize: 13, fontWeight: '600', color: noInjuriesAck && onboardingInjuries.length === 0 ? colors.primary : colors.textPrimary }}>
            No injuries
          </Text>
        </TouchableOpacity>

        <Text style={styles.hint}>You can always update this from Settings later.</Text>
      </View>
    </View>
  );

  const renderContextStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>Almost Done</Text>
      <Text style={styles.stepDescription}>
        Help your AI trainer nail the first workout — safe weights, smart exercise selection, no guesswork.
      </Text>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>
          Any injuries or physical limitations? <Text style={styles.optional}>(optional)</Text>
        </Text>
        <TextInput
          style={[styles.input, { height: 80, textAlignVertical: 'top', paddingTop: 10 }]}
          placeholder={'e.g. Bad left knee, lower back pain, left shoulder impingement'}
          placeholderTextColor={colors.textMuted}
          value={injuries}
          onChangeText={setInjuries}
          multiline
          onFocus={scrollToInput}
        />
        <Text style={styles.hint}>Your AI trainer will avoid exercises that could aggravate these.</Text>
      </View>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>
          When did you last work out and what did you train? <Text style={styles.optional}>(optional)</Text>
        </Text>
        <TextInput
          style={[styles.input, { height: 80, textAlignVertical: 'top', paddingTop: 10 }]}
          placeholder={'e.g. Yesterday — chest and triceps. Benched 185lb for 3x8.'}
          placeholderTextColor={colors.textMuted}
          value={lastWorkoutContext}
          onChangeText={setLastWorkoutContext}
          multiline
          onFocus={scrollToInput}
        />
        <Text style={styles.hint}>Helps the AI pick the right starting weights and avoid training the same muscles back-to-back.</Text>
      </View>
    </View>
  );

  const renderAppleHealthStep = () => {
    // Pre-permission education. Shown BEFORE the OS-level HealthKit prompt so
    // users see exactly what's read, what's written, and why it matters.
    if (Platform.OS === 'android') {
      return (
        <View>
          {renderStepHero(STOCK_IMAGES.onboarding.health, 'Use your real signals', 'Sleep, steps, workouts, heart rate, and weight')}
          <Text style={styles.stepTitle}>Set Up {HEALTH_PLATFORM_LABEL}</Text>
          <Text style={styles.hint}>
            {HEALTH_PLATFORM_STATUS_COPY} You can continue now and connect a supported health source later from Settings.
          </Text>

          <View style={{
            marginTop: 12, marginBottom: 16,
            padding: 11, borderRadius: 10,
            backgroundColor: (colors.primary as string) + '14',
            borderWidth: 1, borderColor: (colors.primary as string) + '44',
          }}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: colors.primary, marginBottom: 3 }}>
              Health Connect is planned
            </Text>
            <Text style={{ fontSize: 11, color: colors.textSecondary, lineHeight: 16 }}>
              When Android health sync is available, this step will ask for Health Connect permissions.
            </Text>
          </View>

          <TouchableOpacity
            style={[styles.chipWide, styles.chipWideSelected]}
            onPress={async () => {
              setAppleHealthEnabled(false);
              await persistHealthEnabled(false);
            }}>
            <Text style={styles.chipIcon}>📱</Text>
            <View style={{ flex: 1 }}>
              <Text style={[styles.chipWideLabel, styles.chipWideLabelSelected]}>Continue without health sync</Text>
              <Text style={styles.chipWideDesc}>You can connect a supported health source later from Settings.</Text>
            </View>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <View>
        {renderStepHero(STOCK_IMAGES.onboarding.health, 'Use your real signals', 'Sleep, steps, workouts, heart rate, and weight')}
        <Text style={styles.stepTitle}>Connect Apple Health (optional)</Text>
        <Text style={styles.hint}>
          When you connect it, these categories power personalization, recovery insights, weekly check-ins, and training or nutrition recommendations. Skip if you'd rather not — you can connect anytime from Settings.
        </Text>

        {/* What we read — itemized so users see exactly what they're granting. */}
        <View style={{ marginTop: 14, marginBottom: 6 }}>
          <Text style={[styles.sectionHeading, { marginTop: 0, marginBottom: 8 }]}>What we read</Text>
          <View style={{ gap: 8 }}>
            {APPLE_HEALTH_PERMISSION_ITEMS.map((r) => (
              <View key={r.label} style={{
                flexDirection: 'row', alignItems: 'flex-start', gap: 10,
                paddingVertical: 6, paddingHorizontal: 10,
                backgroundColor: colors.surface, borderRadius: 10,
                borderWidth: 1, borderColor: colors.border,
              }}>
                <Ionicons name="checkmark-circle-outline" size={17} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textPrimary }}>{r.label}</Text>
                  <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 1 }}>{r.why}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>

        {/* What we write — single bullet so it's clear we're not silently
            polluting Health with extra data. */}
        <View style={{ marginTop: 12, marginBottom: 6 }}>
          <Text style={[styles.sectionHeading, { marginTop: 0, marginBottom: 8 }]}>What we write</Text>
          <View style={{ gap: 8 }}>
            {APPLE_HEALTH_WRITE_ITEMS.map((item) => (
              <View key={item.label} style={{
                flexDirection: 'row', alignItems: 'flex-start', gap: 10,
                paddingVertical: 8, paddingHorizontal: 10,
                backgroundColor: colors.surface, borderRadius: 10,
                borderWidth: 1, borderColor: colors.border,
              }}>
                <Ionicons name="arrow-up-circle-outline" size={17} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textPrimary }}>{item.label}</Text>
                  <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 1 }}>{item.why}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>

        {/* Privacy note — raw samples stay local; summaries can sync. */}
        <View style={{
          marginTop: 12, marginBottom: 16,
          padding: 11, borderRadius: 10,
          backgroundColor: (colors.primary as string) + '14',
          borderWidth: 1, borderColor: (colors.primary as string) + '44',
        }}>
          <Text style={{ fontSize: 12, fontWeight: '700', color: colors.primary, marginBottom: 3 }}>
            Raw samples stay on your phone
          </Text>
          <Text style={{ fontSize: 11, color: colors.textSecondary, lineHeight: 16 }}>
            Apple Health is read locally. Daily summaries, like sleep totals, heart-rate averages, steps, and weight snapshots, may sync to your account so trends work across devices.
          </Text>
        </View>

        <View style={{ gap: 12 }}>
          <TouchableOpacity
            style={[styles.chipWide, appleHealthEnabled && styles.chipWideSelected]}
            onPress={async () => {
              if (!isHealthKitAvailable()) {
                Alert.alert('Not Available', 'Apple Health is not available on this device.');
                return;
              }
              // Skip the Alert.alert "are you sure?" interstitial — the rich
              // step UI above replaces that. Go straight to the OS prompt
              // so users who tap Connect see Apple's permission sheet
              // immediately while their intent is fresh.
              const granted = await requestHealthPermissions();
              if (granted) {
                setAppleHealthEnabled(true);
                await persistHealthEnabled(true);
                // Backfill 180 days of HK data so weekly_review +
                // recovery_flags + body check + readiness UIs have real
                // history from day one. Especially important for users
                // switching from MFP/WHOOP/Watch — without this they see
                // empty trends for weeks. Chunked into 90-day batches;
                // the recent chunk pushes first so the UI populates
                // before the older chunks finish.
                import('../services/healthDataSummary')
                  .then(({ backfillSnapshotsToBackend }) => backfillSnapshotsToBackend(180))
                  .catch(() => undefined);
              } else {
                Alert.alert('Apple Health not connected', APPLE_HEALTH_PERMISSION_COPY.denied);
              }
            }}>
            <Text style={styles.chipIcon}>⌚</Text>
            <View style={{ flex: 1 }}>
              <Text style={[styles.chipWideLabel, appleHealthEnabled && styles.chipWideLabelSelected]}>Connect Apple Health</Text>
              <Text style={styles.chipWideDesc}>Apple will ask for each permission individually — pick what you're comfortable sharing.</Text>
            </View>
            {appleHealthEnabled && <Ionicons name="checkmark-circle" size={20} />}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.chipWide, !appleHealthEnabled && styles.chipWideSelected]}
            onPress={async () => {
              setAppleHealthEnabled(false);
              await persistHealthEnabled(false);
            }}>
            <Text style={styles.chipIcon}>📱</Text>
            <View style={{ flex: 1 }}>
              <Text style={[styles.chipWideLabel, !appleHealthEnabled && styles.chipWideLabelSelected]}>No, skip for now</Text>
              <Text style={styles.chipWideDesc}>You can still use the app without it. Connect later from Settings.</Text>
            </View>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const renderFeatureOverview = () => (
    <View style={styles.featureOverviewBlock}>
      <View style={styles.featureOverviewHeader}>
        <Text style={styles.featureOverviewEyebrow}>What Thallo can do</Text>
        <Text style={styles.featureOverviewSubhead}>
          Your choices decide which surfaces show up first. Nothing here locks you in.
        </Text>
      </View>
      <View style={styles.featureOverviewGrid}>
        {FEATURE_OVERVIEW.map((feature, idx) => (
          <View key={feature.key} style={styles.featureOverviewCard}>
            <LinearGradient
              colors={[
                idx % 2 === 0 ? colors.primary + '24' : (colors.success ?? '#22C55E') + '20',
                colors.surfaceRaised,
              ]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.featureOverviewGradient}
            />
            <View style={styles.featureOverviewIcon}>
              <Ionicons name={feature.icon} size={16} color={idx % 2 === 0 ? colors.primary : (colors.success ?? '#22C55E')} />
            </View>
            <Text style={styles.featureOverviewTitle}>{feature.title}</Text>
            <Text style={styles.featureOverviewBody}>{feature.body}</Text>
          </View>
        ))}
      </View>
    </View>
  );

  const renderAppFocusStep = () => {
    const focusHero = {
      both: {
        uri: STOCK_IMAGES.onboarding.appFocus,
        title: 'Build the right dashboard',
        subtitle: 'Training and nutrition together',
      },
      fitness: {
        uri: STOCK_IMAGES.onboarding.quickTraining,
        title: 'Train your way',
        subtitle: 'Workouts, recovery, and progress',
      },
      nutrition: {
        uri: STOCK_IMAGES.onboarding.quickNutrition,
        title: 'Fuel your day',
        subtitle: 'Meals, macros, and weight',
      },
    }[appFocus];

    return (
      <View style={styles.stepContainer}>
        {renderStepHero(focusHero.uri, focusHero.title, focusHero.subtitle)}
        <Text style={styles.stepTitle}>What are you here for?</Text>
        <Text style={styles.stepDescription}>
          We'll tailor the app to match. You can change this anytime in Settings.
        </Text>

        {renderFeatureOverview()}

        <View style={{ gap: 12 }}>
          {([
            {
              value: 'both',
              icon: 'sparkles-outline',
              label: 'Both',
              desc: 'Track workouts and nutrition together. Most users start here.',
            },
            {
              value: 'fitness',
              icon: 'barbell-outline',
              label: 'Fitness only',
              desc: 'Workouts, recovery, and progress. We\'ll hide meal tracking.',
            },
            {
              value: 'nutrition',
              icon: 'restaurant-outline',
              label: 'Nutrition only',
              desc: 'Meals, macros, and weight. We\'ll hide workout planning.',
            },
          ] as const).map(opt => {
            const active = appFocus === opt.value;
            return (
              <PressableScale
                key={opt.value}
                accessibilityRole="button"
                style={[
                  styles.chipWide,
                  active && styles.chipWideSelected,
                  { alignItems: 'flex-start' },
                ]}
                onPress={() => {
                  import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
                  setAppFocus(opt.value);
                }}
                scaleDown={0.98}
              >
                <View style={{
                  width: 38,
                  height: 38,
                  borderRadius: 10,
                  backgroundColor: active ? colors.primary + '22' : colors.surfaceRaised,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <Ionicons name={opt.icon as any} size={20} color={active ? colors.primary : colors.textMuted} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.chipWideLabel, active && styles.chipWideLabelSelected]}>{opt.label}</Text>
                  <Text style={styles.chipWideDesc}>{opt.desc}</Text>
                </View>
                {active && <Ionicons name="checkmark-circle" size={20} color={colors.primary} />}
              </PressableScale>
            );
          })}
        </View>
      </View>
    );
  };

  const renderStep = () => {
    switch (currentStepKey) {
      case 'appFocus':      return renderAppFocusStep();
      case 'workoutStyle':  return renderWorkoutStyleStep();
      case 'setupPath':     return renderSetupPathStep();
      case 'goal':          return renderGoalStep();
      case 'quickSetup':    return renderQuickSetupStep();
      case 'goalRefine':    return renderGoalRefineStep();
      case 'physicalStats': return renderPhysicalStatsStep();
      case 'trainingDays':  return renderTrainingDaysStep();
      case 'equipment':     return renderEquipmentStep();
      case 'baseline':      return renderBaselineStep();
      case 'injuries':      return renderInjuriesStep();
      case 'foods':         return renderFoodsStep();
      case 'supplements':   return renderSupplementsStep();
      case 'mealRoutine':   return renderMealRoutineStep();
      case 'appleHealth':   return renderAppleHealthStep();
      case 'context':       return renderContextStep();
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────────
  const confirmCancelSignUp = () => {
    Alert.alert(
      'Cancel sign up?',
      'Your progress will be cleared and you can sign in with an existing account.',
      [
        { text: 'Keep going', style: 'cancel' },
        { text: 'Cancel sign up', style: 'destructive', onPress: onExit },
      ],
    );
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}>
      <ScrollView
        ref={scrollRef}
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {!STEP_HERO_KEYS.has(currentStepKey) && renderStepProgress()}

        {/* Keyed fade on every step change so content transitions feel
            intentional instead of snapping. Short duration (220ms) —
            keeps the onboarding flow brisk. */}
        <FadeInView key={currentStepKey} duration={220} slideDistance={10}>
          {renderStep()}
        </FadeInView>

        {stepError ? (
          <View style={styles.inlineErrorBox} accessibilityRole="alert">
            <Ionicons name="alert-circle-outline" size={17} color={colors.error} />
            <Text {...dynamicTextProps} style={styles.inlineErrorText}>{stepError}</Text>
          </View>
        ) : null}

        <View style={styles.buttons}>
          {currentStep > 0 ? (
            <View style={{ flex: 1 }}>
              <PressableScale
                style={styles.backButton}
                onPress={handleBack}>
                <Ionicons name="arrow-back" size={16} color={colors.textSecondary} />
                <Text style={styles.backButtonText}>Back</Text>
              </PressableScale>
            </View>
          ) : <View style={{ flex: 1 }} />}
          <View style={{ flex: currentStep === totalSteps - 1 ? 2 : 1 }}>
            <PressableScale
              testID={currentStep === totalSteps - 1 ? 'onboarding-submit' : 'onboarding-next'}
              accessibilityLabel={currentStep === totalSteps - 1 ? 'onboarding-submit' : 'onboarding-next'}
              accessibilityRole="button"
              style={[styles.nextButton, currentStep === totalSteps - 1 && styles.nextButtonFinal]}
              onPress={handleNext}>
              <Text style={[styles.nextButtonText, currentStep === totalSteps - 1 && styles.nextButtonTextFinal]}>
                {currentStep === totalSteps - 1 ? 'Get Started' : 'Next'}
              </Text>
              {currentStep < totalSteps - 1 && <Ionicons name="arrow-forward" size={16} color={colors.background} />}
            </PressableScale>
          </View>
        </View>
        {onExit && (
          <TouchableOpacity
            testID="onboarding-cancel-signup"
            accessibilityRole="button"
            accessibilityLabel="Cancel sign up"
            style={styles.cancelSignupButton}
            onPress={confirmCancelSignUp}>
            <Text style={styles.cancelSignupText}>Cancel sign up</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
      <EquipmentInfoSheet
        name={equipmentInfo?.name ?? null}
        slug={equipmentInfo?.slug}
        onClose={() => setEquipmentInfo(null)}
      />
    </KeyboardAvoidingView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 24, paddingBottom: 200 },
  stepProgressBlock: { marginBottom: 18 },
  stepCounter: { fontSize: 12, color: colors.textSecondary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.7 },

  progressBar: { flexDirection: 'row', gap: 6, marginTop: 10 },
  progressSegment: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.border },
  progressSegmentActive: { backgroundColor: colors.primary },

  stepContainer: { marginBottom: 24 },
  stepTitle: { fontSize: 26, fontWeight: '700', color: colors.textPrimary, marginBottom: 8 },
  stepDescription: { fontSize: 15, color: colors.textSecondary, lineHeight: 22, marginBottom: 24 },
  onboardingPhoto: {
    overflow: 'hidden',
    justifyContent: 'flex-end',
    backgroundColor: colors.surface,
  },
  onboardingPhotoHero: {
    height: 206,
    marginHorizontal: -24,
    marginTop: -2,
    marginBottom: 14,
  },
  onboardingPhotoCompact: {
    height: 124,
    borderRadius: radius.md,
    marginBottom: 18,
  },
  onboardingPhotoImage: {},
  onboardingPhotoImageHero: {},
  onboardingPhotoImageCompact: { borderRadius: radius.md },
  onboardingPhotoScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(5, 10, 14, 0.34)' },
  onboardingPhotoGradient: { ...StyleSheet.absoluteFillObject },
  onboardingPhotoCopy: { paddingHorizontal: 24, paddingVertical: 22 },
  onboardingPhotoCopyCompact: { padding: 14 },
  onboardingPhotoTitle: { color: '#fff', fontSize: 28, lineHeight: 32, fontWeight: '900' },
  onboardingPhotoTitleCompact: { fontSize: 19, lineHeight: 23 },
  onboardingPhotoSubtitle: { color: '#fff', fontSize: 13, fontWeight: '800', opacity: 0.9, marginTop: 4 },
  onboardingPhotoSubtitleCompact: { fontSize: 12, marginTop: 3 },
  inlineErrorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.error + '66',
    backgroundColor: colors.error + '14',
    padding: 12,
    marginBottom: 14,
  },
  inlineErrorText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    color: colors.error,
    fontWeight: '700',
  },

  goalGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  goalCardWrap: { width: '48%' },
  goalCard: { width: '100%', padding: 12, borderRadius: radius.lg, borderWidth: 2, borderColor: colors.border, backgroundColor: colors.surface, alignItems: 'center' },
  goalCardActive: { borderColor: colors.primary, backgroundColor: colors.surfaceRaised },
  goalHero: { height: 118, width: '100%', justifyContent: 'space-between', padding: 12 },
  goalHeroImage: { borderTopLeftRadius: radius.lg - 2, borderTopRightRadius: radius.lg - 2 },
  goalHeroScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(7, 13, 15, 0.24)' },
  goalHeroIconBubble: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: 'rgba(7, 13, 15, 0.46)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  goalHeroIconBubbleActive: {
    backgroundColor: '#fff',
    borderColor: colors.primary,
  },
  goalHeroCheckBubble: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  goalCardContent: { padding: 16, paddingTop: 14 },
  goalIcon: { fontSize: 26, marginBottom: 6 },
  goalLabel: { fontSize: 14, fontWeight: '700', color: colors.textPrimary, marginBottom: 2 },
  goalLabelActive: { color: colors.primary },
  goalBadge: { backgroundColor: colors.primary, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  goalBadgeSecondary: { backgroundColor: colors.border },
  goalBadgeText: { fontSize: 9, fontWeight: '700', color: '#fff' },
  goalDesc: { fontSize: 12, color: colors.textSecondary, lineHeight: 16, textAlign: 'center' },
  goalDescActive: { color: colors.primaryLight },

  paceCards: { flexDirection: 'row', gap: 8, marginTop: 8 },
  paceCard: { flex: 1, padding: 12, borderRadius: radius.lg, borderWidth: 2, borderColor: colors.border, backgroundColor: colors.surface, alignItems: 'center' },
  paceCardActive: { borderColor: colors.primary, backgroundColor: colors.surfaceRaised },
  paceIcon: { fontSize: 24, marginBottom: 6 },
  paceLabel: { fontSize: 12, fontWeight: '700', color: colors.textPrimary, textAlign: 'center', marginBottom: 2 },
  paceLabelActive: { color: colors.primary },
  paceRate: { fontSize: 11, fontWeight: '600', color: colors.textSecondary, textAlign: 'center', marginBottom: 4 },
  paceRateActive: { color: colors.primary },
  paceDesc: { fontSize: 10, color: colors.textMuted, textAlign: 'center', lineHeight: 13 },
  paceDescActive: { color: colors.primaryLight },

  fieldGroup: { marginBottom: 20 },
  fieldLabel: { fontSize: 14, fontWeight: '600', color: colors.textPrimary, marginBottom: 8 },
  optional: { fontWeight: '400', color: colors.textMuted },
  inlineInput: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  baselineWhyBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary + '55',
    backgroundColor: colors.primary + '12',
    marginBottom: 12,
  },
  baselineWhyText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  baselineLiftTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.textPrimary,
    marginBottom: 4,
  },
  baselineLiftHelp: {
    fontSize: 12,
    lineHeight: 17,
    color: colors.textMuted,
    marginBottom: 10,
  },
  baselineInputColumn: {
    flex: 1,
    gap: 6,
  },
  baselineInputLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  heightRow: { flexDirection: 'row', gap: 12 },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 14, fontSize: 16, backgroundColor: colors.surface, color: colors.textPrimary,
    letterSpacing: 0, fontWeight: '400',
  },
  unit: { fontSize: 14, color: colors.textSecondary, fontWeight: '500', minWidth: 40 },
  hint: { fontSize: 13, color: colors.textMuted, marginTop: 8 },
  optionalBanner: { fontSize: 13, color: colors.primary, fontWeight: '500', marginBottom: 16, fontStyle: 'italic' },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  searchInput: { marginBottom: 0, paddingVertical: 11, color: colors.textPrimary, letterSpacing: 0, fontWeight: '400' },
  clearBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  clearBtnText: { fontSize: 13, color: colors.textSecondary, fontWeight: '700' },
  textArea: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 14, fontSize: 16, backgroundColor: colors.surface, color: colors.textPrimary,
  },

  genderRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  genderButton: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: radius.full, borderWidth: 2, borderColor: colors.border, backgroundColor: colors.surface },
  genderButtonActive: { borderColor: colors.primary, backgroundColor: colors.surfaceRaised },
  genderText: { fontSize: 14, color: colors.textSecondary, fontWeight: '500' },
  genderTextActive: { color: colors.primary, fontWeight: '600' },

  sectionHeading: {
    fontSize: 12, fontWeight: '700', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 10, marginTop: 4,
  },
  featureOverviewBlock: {
    marginTop: -6,
    marginBottom: 18,
    gap: 12,
  },
  featureOverviewHeader: {
    gap: 3,
  },
  featureOverviewEyebrow: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '900',
    color: colors.primary,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  featureOverviewSubhead: {
    fontSize: 12,
    lineHeight: 17,
    color: colors.textMuted,
    fontWeight: '600',
  },
  featureOverviewGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  featureOverviewCard: {
    width: '48%',
    minHeight: 142,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    padding: 12,
    overflow: 'hidden',
  },
  featureOverviewGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  featureOverviewIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 10,
  },
  featureOverviewTitle: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '900',
    color: colors.textPrimary,
    marginBottom: 5,
  },
  featureOverviewBody: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '600',
    color: colors.textSecondary,
  },

  // Equipment templates
  templateScroll: { marginBottom: 16 },
  templateScrollContent: { gap: 8, paddingBottom: 2 },
  templateChip: {
    backgroundColor: colors.surfaceRaised, borderRadius: radius.md,
    borderWidth: 2, borderColor: colors.primary + '44',
    paddingVertical: 14, paddingHorizontal: 16, minWidth: 150, maxWidth: 200,
    // Subtle shadow so the chip reads as tappable, not static label.
    shadowColor: colors.primary, shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08, shadowRadius: 4, elevation: 2,
  },
  templateChipActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primary + '22',
    borderWidth: 2.5,
  },
  templateChipLabel: { fontSize: 14, fontWeight: '800', color: colors.textPrimary, marginBottom: 3 },
  templateChipLabelActive: { color: colors.primary },
  templateChipDesc: { fontSize: 11, color: colors.textSecondary, lineHeight: 15 },
  templateChipDescActive: { color: colors.primaryLight },
  equipmentTemplateCard: {
    width: 188,
    height: 148,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 3,
  },
  equipmentTemplateCardActive: {
    borderColor: colors.primary,
  },
  equipmentTemplateImage: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  equipmentTemplatePhoto: {
    borderRadius: radius.lg - 2,
  },
  equipmentTemplateScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(5, 10, 14, 0.36)',
  },
  equipmentTemplateTopRow: {
    position: 'absolute',
    top: 10,
    left: 10,
    right: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  equipmentTemplatePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(0, 0, 0, 0.36)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.22)',
  },
  equipmentTemplatePillText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },
  equipmentTemplateCheck: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.7)',
  },
  equipmentTemplateBody: {
    padding: 12,
  },
  equipmentTemplateLabel: {
    color: '#FFFFFF',
    fontSize: 16,
    lineHeight: 19,
    fontWeight: '900',
    marginBottom: 3,
  },
  equipmentTemplateDesc: {
    color: 'rgba(255, 255, 255, 0.88)',
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '700',
  },
  foodPresetCard: {
    width: 174,
    height: 136,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 3,
  },
  foodPresetCardActive: {
    borderColor: colors.primary,
  },
  foodPresetImage: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  foodPresetPhoto: {
    borderRadius: radius.lg - 2,
  },
  foodPresetScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(5, 10, 14, 0.38)',
  },
  foodPresetTopRow: {
    position: 'absolute',
    top: 10,
    left: 10,
    right: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  foodPresetPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(0, 0, 0, 0.36)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.22)',
  },
  foodPresetPillText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },
  foodPresetCheck: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.7)',
  },
  foodPresetBody: {
    padding: 12,
  },
  foodPresetLabel: {
    color: '#FFFFFF',
    fontSize: 16,
    lineHeight: 19,
    fontWeight: '900',
    marginBottom: 3,
  },
  foodPresetDesc: {
    color: 'rgba(255, 255, 255, 0.9)',
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '700',
  },

  // Photo scan
  scanSection: { marginBottom: 20, padding: 16, backgroundColor: colors.surfaceRaised, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  scanSectionCompact: {
    marginBottom: 18,
    padding: 12,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  scanCompactHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  scanCompactIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary + '14',
  },
  scanSectionTitle: { fontSize: 15, fontWeight: '700', color: colors.textPrimary, marginBottom: 4 },
  scanSectionSub: { fontSize: 13, color: colors.textSecondary, marginBottom: 14 },
  scanSectionSubCompact: { fontSize: 12, lineHeight: 16, color: colors.textSecondary },
  scanContextLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.textSecondary,
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0,
  },
  scanContextOptional: {
    fontWeight: '700',
    color: colors.textMuted,
  },
  scanContextInput: {
    marginBottom: 10,
    fontSize: 14,
  },
  scanRow: { flexDirection: 'column', gap: 10 },
  scanCompactRow: { flexDirection: 'row', gap: 8 },
  scanBtn: {
    paddingVertical: 14, borderRadius: radius.md,
    borderWidth: 1.5, borderColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primary + '14',
  },
  scanBtnText: { fontSize: 15, fontWeight: '600', color: colors.primary, textAlign: 'center' },
  scanBtnPrimary: { paddingVertical: 15, borderRadius: radius.md, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  scanBtnPrimaryText: { fontSize: 16, fontWeight: '700', color: '#fff', textAlign: 'center' },
  scanBtnSecondary: { paddingVertical: 14, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.primary, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary + '12' },
  scanBtnSecondaryText: { fontSize: 16, fontWeight: '600', color: colors.primary, textAlign: 'center' },
  scanCompactBtnPrimary: {
    flex: 1,
    minHeight: 38,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  scanCompactBtnPrimaryText: { fontSize: 13, fontWeight: '800', color: '#FFFFFF' },
  scanCompactBtnSecondary: {
    flex: 1,
    minHeight: 38,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.primary,
    backgroundColor: colors.primary + '10',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  scanCompactBtnSecondaryText: { fontSize: 13, fontWeight: '800', color: colors.primary },

  // Food / equipment chips
  foodCategory:      { marginBottom: 18 },
  foodCategoryLabel: { fontSize: 13, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10 },
  foodChips:         { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  foodChip:          { paddingVertical: 7, paddingHorizontal: 12, borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface },
  foodChipActive:    { borderColor: colors.primary, backgroundColor: colors.surfaceRaised },
  foodChipText:      { fontSize: 13, color: colors.textSecondary, fontWeight: '500' },
  foodChipTextActive:{ color: colors.primary, fontWeight: '600' },
  guardrailBox: {
    marginTop: 2,
    marginBottom: 18,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: (colors.warning ?? '#F59E0B') + '66',
    backgroundColor: (colors.warning ?? '#F59E0B') + '12',
  },
  guardrailHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  guardrailTitle: { fontSize: 12, fontWeight: '800', color: colors.warning ?? '#F59E0B', textTransform: 'uppercase', letterSpacing: 0.5 },
  guardrailText: { fontSize: 12, lineHeight: 17, color: colors.textSecondary, marginTop: 4 },

  // Scan result modal
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  scanModal: {
    backgroundColor: colors.surface, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    padding: 24, paddingBottom: 40, gap: 14,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  scanModalTitle: { fontSize: 18, fontWeight: '700', color: colors.textPrimary },
  scanModalSub:   { fontSize: 13, color: colors.textSecondary },
  scannedRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  scannedCheck: { width: 22, height: 22, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  scannedCheckMark: { fontSize: 13, color: '#fff', fontWeight: '800' },
  scannedName: { fontSize: 15, color: colors.textPrimary, fontWeight: '500', flex: 1 },
  scanModalBtns: { flexDirection: 'row', gap: 10, marginTop: 4 },
  scanModalCancel: {
    flex: 1, paddingVertical: 14, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, alignItems: 'center',
  },
  scanModalCancelText: { fontSize: 15, color: colors.textSecondary, fontWeight: '600' },
  scanModalConfirm: {
    flex: 1, paddingVertical: 14, borderRadius: radius.md,
    backgroundColor: colors.primary, alignItems: 'center',
  },
  scanModalConfirmText: { fontSize: 15, color: '#fff', fontWeight: '700' },

  buttons: { flexDirection: 'row', gap: 12, marginTop: 8 },
  cancelSignupButton: {
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginTop: 4,
    marginBottom: 18,
  },
  cancelSignupText: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.textSecondary,
  },
  backButton: { flexDirection: 'row', gap: 6, paddingVertical: 18, borderRadius: radius.md, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  buttonDisabled: { opacity: 0.4 },
  backButtonText: { fontSize: 16, fontWeight: '600', color: colors.textSecondary },
  nextButton: { flexDirection: 'row', gap: 6, paddingVertical: 18, borderRadius: radius.md, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  nextButtonFinal: { paddingVertical: 20, shadowColor: colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 8, elevation: 5 },
  nextButtonText: { fontSize: 16, fontWeight: '600', color: colors.background },
  nextButtonTextFinal: { fontSize: 18, fontWeight: '700', letterSpacing: 0.4 },

  // Apple Health step
  chipWide: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipWideSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primary + '15',
  },
  chipWideLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  chipWideLabelSelected: {
    color: colors.primary,
  },
  chipWideDesc: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
  },
  chipIcon: {
    fontSize: 28,
  },
});
