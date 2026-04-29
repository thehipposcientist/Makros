import { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Image,
  ActivityIndicator,
  Modal,
  findNodeHandle,
  UIManager,
  LayoutAnimation,
  Keyboard,
  useWindowDimensions,
} from 'react-native';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import { Ionicons } from '@expo/vector-icons';
import Animated, { LinearTransition } from 'react-native-reanimated';
import FadeInView from '../components/FadeInView';
import PressableScale from '../components/PressableScale';
import BirthdateInput from '../components/BirthdateInput';
import { deriveAge, validateBirthdate } from '../utils/age';
import * as ImagePicker from 'expo-image-picker';
import { colors, radius } from '../constants/theme';
import {
  Goal, GoalPace, Gender, UserProfile, PhysicalStats, GoalDetails, GoalSelection, StrengthEquipmentSettings,
} from '../types';
import { useMetaData, pacesForGoal } from '../hooks/useMetaData';
import { scanFoodsPhoto, scanEquipmentPhoto, matchGoal } from '../services/api';
import { APPLE_HEALTH_PERMISSION_COPY, isHealthKitAvailable, requestHealthPermissions } from '../services/appleHealth';
import { setAppleHealthEnabled as persistHealthEnabled } from '../utils/workoutHistory';
import {
  DEFAULT_ADJUSTABLE_DUMBBELLS,
  DEFAULT_PLATE_PAIRS_LBS,
  PLATE_PAIR_OPTIONS_LBS,
  hasAdjustableDumbbells,
  hasPlateLoadedEquipment,
  normalizeStrengthEquipmentSettings,
} from '../utils/strengthEquipmentSettings';
import {
  LAUNCH_GOALS, PRIMARY_GOALS, GOAL_CATEGORIES,
  goalCategory,
} from '../constants/goalConfig';

const logo = require('../../assets/images/thallo-logo-white.png');

// ─── Step logic ───────────────────────────────────────────────────────────────

type StepKey = 'goal' | 'goalRefine' | 'physicalStats' | 'trainingDays' | 'equipment' | 'foods' | 'supplements' | 'mealRoutine' | 'appleHealth' | 'context';

function getSteps(): StepKey[] {
  // Meal routine moved out of onboarding — users can pin meals as routines
  // from the Home screen after the first plan generates, which gives a
  // much better UX than typing prose at signup time.
  // Compressed onboarding: 5 core steps + optional health/context
  const base: StepKey[] = ['goal', 'physicalStats', 'trainingDays', 'equipment', 'foods'];
  if (Platform.OS === 'ios') base.push('appleHealth');
  return base;
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
  items: string[];
}

const FOOD_PRESETS: FoodPreset[] = [
  {
    id: 'high_protein',
    label: 'High Protein',
    description: 'Lean meats, dairy, protein powder',
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

// Muscle groups moved to goalConfig target focuses

// ─── Equipment templates ──────────────────────────────────────────────────────

interface EquipmentTemplate {
  id: string;
  label: string;
  description: string;
  items: string[];
}

const EQUIPMENT_TEMPLATES: EquipmentTemplate[] = [
  {
    id: 'bodyweight',
    label: 'No Equipment',
    description: 'Bodyweight only',
    items: ['Yoga mat', 'Jump rope'],
  },
  {
    id: 'home_basic',
    label: 'Home (Basic)',
    description: 'Adjustable DBs + bands',
    items: ['Adjustable dumbbells', 'Resistance bands', 'Pull-up bar', 'Yoga mat', 'Jump rope', 'Foam roller'],
  },
  {
    id: 'home_full',
    label: 'Home Gym',
    description: 'Full home setup',
    items: [
      'Dumbbells', 'Barbell', 'Kettlebell', 'Weight plates',
      'Flat bench', 'Squat rack', 'Pull-up bar',
      'Resistance bands', 'Yoga mat', 'Foam roller', 'Ab wheel',
    ],
  },
  {
    id: 'planet_fitness',
    label: 'Planet Fitness',
    description: 'Machines + dumbbells',
    items: [
      'Dumbbells', 'EZ curl bar',
      'Cable machine', 'Leg press', 'Leg extension', 'Leg curl machine',
      'Lat pulldown', 'Chest press machine', 'Seated row machine',
      'Shoulder press machine', 'Hip abduction machine', 'Hip adduction machine',
      'Smith machine',
      'Treadmill', 'Stationary bike', 'Elliptical',
    ],
  },
  {
    id: 'commercial_gym',
    label: 'Commercial Gym',
    description: 'Full gym access',
    items: [
      'Dumbbells', 'Barbell', 'Kettlebell', 'EZ curl bar', 'Weight plates', 'Trap bar',
      'Flat bench', 'Adjustable bench', 'Squat rack', 'Power rack',
      'Cable machine', 'Leg press', 'Leg extension', 'Leg curl machine',
      'Lat pulldown', 'Chest press machine', 'Seated row machine',
      'Shoulder press machine', 'Hip abduction machine', 'Hip adduction machine',
      'Smith machine', 'Hack squat machine', 'Assisted pull-up machine',
      'Ab wheel', 'Dip bars', 'Pull-up bar', 'Landmine attachment',
      'Treadmill', 'Stationary bike', 'Elliptical',
      'Rowing machine', 'Stair climber', 'Assault bike', 'Battle ropes', 'Plyo box',
    ],
  },
  {
    id: 'crossfit',
    label: 'CrossFit Box',
    description: 'Barbells + cardio',
    items: [
      'Barbell', 'Dumbbells', 'Kettlebell', 'Weight plates',
      'Pull-up bar', 'Dip bars', 'Plyo box', 'Jump rope',
      'Rowing machine', 'Assault bike', 'Battle ropes', 'Medicine ball', 'Ab wheel',
    ],
  },
];

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
  const [currentStep, setCurrentStep] = useState(0);

  // Step 1 — Goal selection (hierarchical)
  const [selectedGoal, setSelectedGoal] = useState('build_muscle');
  const [goalScrollIdx, setGoalScrollIdx] = useState(0);
  const [goalQuery, setGoalQuery] = useState('');
  const [goalMatchLoading, setGoalMatchLoading] = useState(false);
  const [goalMatchReason, setGoalMatchReason] = useState<string | null>(null);

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
  // Birthdate is the source of truth. `age` is derived for legacy
  // consumers (HRmax, TDEE) via the deriveAge helper so the cached int
  // stays accurate as users age.
  const [birthdate, setBirthdate] = useState<string | null>(null);
  const [gender, setGender] = useState<Gender | ''>('');
  // Step 4 — Training days
  const [daysPerWeek, setDaysPerWeekRaw] = useState('3');
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

  // Search filters & template selection
  const [equipmentSearch, setEquipmentSearch] = useState('');
  const [foodSearch, setFoodSearch] = useState('');
  const [selectedEquipTemplate, setSelectedEquipTemplate] = useState<string | null>(null);
  const [selectedFoodPreset, setSelectedFoodPreset] = useState<string | null>(null);

  // Step 6 — Foods
  const [foodsAvailable, setFoodsAvailable] = useState<string[]>([]);
  const [foodScanLoading, setFoodScanLoading] = useState(false);
  const [scannedFoods, setScannedFoods] = useState<{ name: string; selected: boolean }[]>([]);
  const [customFoodInput, setCustomFoodInput] = useState('');

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

  const steps = getSteps();
  const totalSteps = steps.length;
  const currentStepKey = steps[currentStep];

  // Auto-scroll carousel to the selected goal whenever the goal step becomes active
  // (covers both initial load and navigating back from a later step).
  useEffect(() => {
    if (currentStepKey !== 'goal') return;
    const idx = LAUNCH_GOALS.findIndex(g => g.id === selectedGoal);
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
    const idx = LAUNCH_GOALS.findIndex(g => g.id === goalId);
    if (idx >= 0) {
      goalCarouselRef.current?.scrollTo({ x: idx * (screenWidth * 0.82 + 12), animated: true });
      LayoutAnimation.configureNext({ duration: 220, update: { type: 'spring', springDamping: 0.75 } });
      setGoalScrollIdx(idx);
    }
  };

  // toggleModifier removed — modifiers are gone.
  const toggleEquipment = (eq: string) => {
    setSelectedEquipment(prev =>
      prev.includes(eq) ? prev.filter(e => e !== eq) : [...prev, eq]
    );
  };

  const applyTemplate = (template: EquipmentTemplate) => {
    setSelectedEquipment(template.items);
    setSelectedEquipTemplate(template.id);
  };

  const validate = (): string | null => {
    switch (currentStepKey) {
      case 'goal': {
        // Target weight is required for any weight-change goal so the
        // calorie delta + ETA calc has real inputs.
        const weightChange = new Set([
          'lose_fat', 'get_lean', 'cut', 'preserve_muscle_cutting',
          'build_muscle', 'lean_bulk', 'gain_weight',
        ]);
        if (weightChange.has(selectedGoal)) {
          if (!targetWeight?.trim()) return 'Set a target weight — needed for your calorie target and ETA.';
          const tw = parseFloat(targetWeight);
          if (isNaN(tw) || tw < 50 || tw > 500) return 'Enter a valid target weight (50–500 lbs)';
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
            if (cutGoals.has(selectedGoal) && tw >= cw) return `For fat-loss goals, target weight must be less than current (${cw} lb)`;
            if (bulkGoals.has(selectedGoal) && tw <= cw) return `For weight-gain goals, target weight must be greater than current (${cw} lb)`;
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

  const handleNext = () => {
    const error = validate();
    if (error) { Alert.alert('One more thing', error); return; }

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
      setCurrentStep(s => s - 1);
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: 0, animated: true }));
    }
  };

  const handleComplete = async () => {
    if (weightLbs) {
      const { saveWeightEntry } = await import('../utils/weightHistory');
      await saveWeightEntry(parseFloat(weightLbs), 'onboarding');
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
      weightLbs:    parseFloat(weightLbs),
      heightFeet:   parseInt(heightFeet),
      heightInches: parseInt(heightInches),
      age:          derivedAge,
      birthdate:    birthdate ?? undefined,
      gender:       gender as Gender,
    };

    onComplete({
      goal:               selectedGoal,
      goalSelection:      goalSel,
      priorityRegion:     selectedRegion,
      goalDetails,
      physicalStats,
      daysPerWeek:            parseInt(daysPerWeek),
      trainingDays:           selectedTrainingDays.length === parseInt(daysPerWeek) ? selectedTrainingDays : undefined,
      preferredSplit:         preferredSplit === 'auto' ? undefined : preferredSplit,
      workoutDurationMinutes: workoutDuration,
      equipment:              selectedEquipment,
      equipmentSettings:      normalizeStrengthEquipmentSettings(equipmentSettings, selectedEquipment),
      foodsAvailable,
      allergies: allergies.length > 0 ? allergies : undefined,
      supplementsAvailable: supplementsAvailable.length > 0 ? supplementsAvailable : undefined,
      customFoods: [],
      mealRoutine:         mealRoutine.trim()         || undefined,
      injuries:            injuries.trim()            || undefined,
      experienceLevel:     experienceLevel            || undefined,
      lastWorkoutContext:  lastWorkoutContext.trim()   || undefined,
    });
  };

  // ─── Photo helpers ───────────────────────────────────────────────────────────

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
    const images = await pickImages(source);
    if (!images.length) return;
    setFoodScanLoading(true);
    try {
      const allItems: { name: string; selected: boolean }[] = [];
      for (const base64 of images) {
        const resp = await scanFoodsPhoto(authToken, { images: [{ image_base64: base64 }] });
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

  const renderGoalStep = () => {
    const selectedDef = PRIMARY_GOALS.find(g => g.id === selectedGoal);

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
            Tell Thallo what you want in your own words. The AI picks the best-fit goal for you.
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
            onChangeText={t => { setGoalQuery(t); setGoalMatchReason(null); }}
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
              setGoalMatchLoading(true);
              try {
                const res = await matchGoal(goalQuery.trim());
                selectGoal(res.goal_id);
                setGoalMatchReason(res.reason);
                Keyboard.dismiss();
                setTimeout(scrollCarouselIntoView, 340);
              } catch {}
              setGoalMatchLoading(false);
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

        {/* Launch goals — the 8 most common. Each card shows a short
            description so users can compare without tapping. Selected
            card expands to full width for the full text. */}
        <View ref={carouselSectionRef}>
        <Text style={styles.sectionHeading}>Most popular</Text>
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
          {LAUNCH_GOALS.map((g, gIdx) => {
            const catDef = GOAL_CATEGORIES.find(c => c.id === g.category);
            const active = selectedGoal === g.id;
            return (
              <PressableScale
                key={g.id}
                style={[
                  styles.goalCard,
                  active && styles.goalCardActive,
                  { width: screenWidth * 0.82, alignItems: 'flex-start', padding: 18 },
                ]}
                onPress={() => selectGoal(g.id)}
                scaleDown={0.97}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <View style={{
                    width: 38, height: 38, borderRadius: 10,
                    backgroundColor: active ? colors.primary + '22' : colors.surfaceRaised,
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Ionicons name={(catDef?.icon ?? 'flag-outline') as any} size={20} color={active ? colors.primary : colors.textMuted} />
                  </View>
                  <Text style={[styles.goalLabel, active && styles.goalLabelActive, { flex: 1 }]}>{g.label}</Text>
                  {active && <Ionicons name="checkmark-circle" size={20} color={colors.primary} />}
                </View>
                <Text style={{ fontSize: 13, color: active ? colors.textSecondary : colors.textMuted, lineHeight: 18 }}>
                  {g.description}
                </Text>
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
          return (
            <View style={{ marginTop: 16 }}>
              <Text style={styles.fieldLabel}>
                Target weight <Text style={{ color: colors.warning ?? '#DC2626' }}>*</Text>
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <TextInput
                  style={{
                    flex: 1,
                    backgroundColor: colors.surface, borderRadius: 10,
                    paddingHorizontal: 14, paddingVertical: 12, fontSize: 15,
                    color: colors.textPrimary,
                    borderWidth: 1.5,
                    borderColor: hasValue ? colors.border : (colors.warning ?? '#DC2626') + '88',
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
              {!hasValue && (
                <Text style={{ fontSize: 11, color: colors.warning ?? '#DC2626', marginTop: 4 }}>
                  Required — we need this to build your calorie target and ETA.
                </Text>
              )}
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
          Fine-tune how the AI builds your {goalLabel.toLowerCase()} programme.
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

  const renderPhysicalStatsStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>About You</Text>
      <Text style={styles.stepDescription}>We use this to calculate your daily calorie and macro targets — nothing is shared.</Text>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Current weight</Text>
        <View style={styles.inlineInput}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            placeholder="e.g. 185"
            placeholderTextColor={colors.textMuted}
            keyboardType="decimal-pad"
            value={weightLbs}
            onChangeText={setWeightLbs}
          />
          <Text style={styles.unit}>lbs</Text>
        </View>
      </View>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Height</Text>
        <View style={styles.heightRow}>
          <View style={[styles.inlineInput, { flex: 1 }]}>
            <TextInput
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
          : parseInt(daysPerWeek) >= 1 ? 'Every session counts — the AI maximizes each one.'
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
          return (
            <TouchableOpacity
              key={t.id}
              style={[styles.templateChip, active && styles.templateChipActive]}
              onPress={() => applyTemplate(t)}
              activeOpacity={0.75}>
              <Text style={[styles.templateChipLabel, active && styles.templateChipLabelActive]}>{t.label}</Text>
              <Text style={[styles.templateChipDesc, active && styles.templateChipDescActive]}>{t.description}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Photo scan */}
      <View style={styles.scanSection}>
        <Text style={styles.scanSectionTitle}>Scan your gym or home setup</Text>
        <Text style={styles.scanSectionSub}>AI will identify your equipment automatically — select multiple photos at once from your library</Text>
        <View style={styles.scanRow}>
          <TouchableOpacity
            style={[styles.scanBtnPrimary, equipScanLoading && { opacity: 0.5 }]}
            onPress={() => handleScanEquipment('camera')}
            disabled={equipScanLoading}>
            {equipScanLoading
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={styles.scanBtnPrimaryText}>Take Photo</Text>}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.scanBtnSecondary, equipScanLoading && { opacity: 0.5 }]}
            onPress={() => handleScanEquipment('library')}
            disabled={equipScanLoading}>
            <Text style={styles.scanBtnSecondaryText}>Choose from Library</Text>
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
            ? category.items.filter(item => item.name.toLowerCase().includes(equipmentSearch.toLowerCase()))
            : category.items;
          if (filteredItems.length === 0) return null;
          return (
            <View key={category.label} style={styles.foodCategory}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {category.icon.includes('-') ? <Ionicons name={category.icon as any} size={16} color={colors.textSecondary} /> : <Text style={{ fontSize: 16 }}>{category.icon}</Text>}
                <Text style={styles.foodCategoryLabel}>{category.label}</Text>
              </View>
              <View style={styles.foodChips}>
                {filteredItems.map(item => {
                  const selected = selectedEquipment.includes(item.name);
                  return (
                    <TouchableOpacity
                      key={item.name}
                      style={[styles.foodChip, selected && styles.foodChipActive]}
                      onPress={() => toggleEquipment(item.name)}>
                      <Text style={[styles.foodChipText, selected && styles.foodChipTextActive]}>
                        {item.name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          );
        })
      )}

      {renderStrengthLoadSettings()}

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

  const toggleFood = (food: string) => {
    setFoodsAvailable(prev =>
      prev.includes(food) ? prev.filter(f => f !== food) : [...prev, food]
    );
  };

  const renderFoodsStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>Your Kitchen</Text>
      <Text style={styles.stepDescription}>
        Pick a preset or select individual foods. You can change everything later from settings.
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
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {[
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
          ].map((a) => {
            const active = allergies.includes(a.key);
            return (
              <TouchableOpacity
                key={a.key}
                onPress={() => {
                  setAllergies((prev) =>
                    prev.includes(a.key) ? prev.filter((x) => x !== a.key) : [...prev, a.key],
                  );
                }}
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
      </View>

      {/* Photo scan — top, prominent */}
      <View style={styles.scanSection}>
        <Text style={styles.scanSectionTitle}>Scan your fridge or pantry</Text>
        <Text style={styles.scanSectionSub}>AI will identify your foods automatically — select multiple photos at once from your library</Text>
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
          return (
            <TouchableOpacity
              key={p.id}
              style={[styles.templateChip, active && styles.templateChipActive]}
              onPress={() => {
                if (selectedFoodPreset === p.id) {
                  setSelectedFoodPreset(null);
                  setFoodsAvailable([]);
                } else {
                  setSelectedFoodPreset(p.id);
                  // Match template strings against the canonical food
                  // library so items like "Ground Beef (80/20)" or
                  // "Berries (small amount)" resolve to the real
                  // library entry instead of creating a custom-food chip.
                  const lib = (meta?.allFoods ?? []) as Array<{ name: string }>;
                  const normalize = (s: string) => s.toLowerCase()
                    .replace(/\([^)]*\)/g, '')
                    .replace(/[^a-z0-9\s]+/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                  const libIndex = new Map<string, string>();
                  for (const f of lib) {
                    const k = normalize(f.name);
                    if (k && !libIndex.has(k)) libIndex.set(k, f.name);
                    // Also index first-word prefix so "berries" hits "Berries"
                    const first = k.split(' ', 1)[0];
                    if (first && !libIndex.has(first)) libIndex.set(first, f.name);
                  }
                  const resolved: string[] = [];
                  for (const raw of p.items) {
                    const k = normalize(raw);
                    const hit = libIndex.get(k) ?? libIndex.get(k.split(' ', 1)[0]);
                    resolved.push(hit ?? raw);
                  }
                  setFoodsAvailable(Array.from(new Set(resolved)));
                }
              }}
              activeOpacity={0.75}>
              <Text style={[styles.templateChipLabel, active && styles.templateChipLabelActive]}>{p.label}</Text>
              <Text style={[styles.templateChipDesc, active && styles.templateChipDescActive]}>{p.description}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Manual selection */}
      <Text style={styles.sectionHeading}>Or pick manually</Text>
      <View style={styles.searchRow}>
        <TextInput
          style={[styles.input, styles.searchInput, { flex: 1 }]}
          placeholder="Search foods..."
          placeholderTextColor={colors.textMuted}
          value={foodSearch}
          onChangeText={setFoodSearch}
          autoCapitalize="none"
          returnKeyType="done"
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
        meta.foodCategories.map(category => {
          const filteredFoods = foodSearch.trim()
            ? category.foods.filter(food => food.name.toLowerCase().includes(foodSearch.toLowerCase()))
            : category.foods;
          if (filteredFoods.length === 0) return null;
          return (
            <View key={category.key} style={styles.foodCategory}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {category.icon.includes('-') ? <Ionicons name={category.icon as any} size={16} color={colors.textSecondary} /> : <Text style={{ fontSize: 16 }}>{category.icon}</Text>}
                <Text style={styles.foodCategoryLabel}>{category.label}</Text>
              </View>
              <View style={styles.foodChips}>
                {filteredFoods.map(food => {
                  const selected = foodsAvailable.includes(food.name);
                  return (
                    <TouchableOpacity
                      key={food.name}
                      style={[styles.foodChip, selected && styles.foodChipActive]}
                      onPress={() => toggleFood(food.name)}>
                      <Text style={[styles.foodChipText, selected && styles.foodChipTextActive]}>
                        {food.name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          );
        })
      )}

      {/* Custom food input */}
      <Text style={styles.sectionHeading}>Add a custom food</Text>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
        <TextInput
          style={[styles.textArea, { flex: 1, height: 44, textAlignVertical: 'center', paddingTop: 0 }]}
          placeholder="e.g. dragon fruit, sourdough bread..."
          placeholderTextColor={colors.textMuted}
          value={customFoodInput}
          onChangeText={setCustomFoodInput}
          onFocus={scrollToInput}
          onSubmitEditing={() => {
            const name = customFoodInput.trim();
            if (name && !foodsAvailable.includes(name)) {
              setFoodsAvailable(prev => [...prev, name]);
            }
            setCustomFoodInput('');
          }}
          returnKeyType="done"
        />
        <TouchableOpacity
          style={{ backgroundColor: colors.primary, borderRadius: 10, paddingHorizontal: 16, justifyContent: 'center' }}
          onPress={() => {
            const name = customFoodInput.trim();
            if (name && !foodsAvailable.includes(name)) {
              setFoodsAvailable(prev => [...prev, name]);
            }
            setCustomFoodInput('');
          }}>
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Add</Text>
        </TouchableOpacity>
      </View>
      {foodsAvailable.filter(f => !meta.allFoods.some((mf: any) => mf.name === f)).length > 0 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {foodsAvailable.filter(f => !meta.allFoods.some((mf: any) => mf.name === f)).map(f => (
            <TouchableOpacity
              key={f}
              style={[styles.foodChip, styles.foodChipActive]}
              onPress={() => setFoodsAvailable(prev => prev.filter(x => x !== f))}>
              <Text style={[styles.foodChipText, styles.foodChipTextActive]}>{f} <Ionicons name="close" size={12} /></Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <Text style={styles.hint}>Skip to use default meal suggestions</Text>

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

  const toggleSupplement = (name: string) => {
    setSupplementsAvailable(prev =>
      prev.includes(name) ? prev.filter(s => s !== name) : [...prev, name]
    );
  };

  const renderSupplementsStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>Supplements</Text>
      <Text style={styles.stepDescription}>
        Already taking supplements? Select them so the AI doesn't recommend duplicates.
        {supplementsAvailable.length > 0 ? `  ·  ${supplementsAvailable.length} selected` : ''}
      </Text>
      <Text style={styles.optionalBanner}>Completely optional — most people skip this step.</Text>

      {SUPPLEMENT_CATEGORIES.map(category => (
        <View key={category.key} style={styles.foodCategory}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {category.icon.includes('-') ? <Ionicons name={category.icon as any} size={16} color={colors.textSecondary} /> : <Text style={{ fontSize: 16 }}>{category.icon}</Text>}
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

  const renderContextStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>Almost Done</Text>
      <Text style={styles.stepDescription}>
        Help your AI trainer nail the first workout — safe weights, smart exercise selection, no guesswork.
      </Text>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Experience level</Text>
        {/* Stacked vertically because the three labels + their descriptions
            were too cramped side-by-side — "Intermediate" wrapped under
            itself on narrow screens. One per row fits cleanly. */}
        <View style={{ gap: 8, marginTop: 8 }}>
          {EXPERIENCE_OPTIONS.map(opt => {
            const active = experienceLevel === opt.value;
            return (
              <TouchableOpacity
                key={opt.value}
                style={[
                  styles.paceCard,
                  active && styles.paceCardActive,
                  { alignItems: 'flex-start', paddingVertical: 14, paddingHorizontal: 16 },
                ]}
                onPress={() => setExperienceLevel(opt.value)}>
                <Text style={[styles.paceLabel, active && styles.paceLabelActive, { fontSize: 14, textAlign: 'left', marginBottom: 4 }]}>
                  {opt.label}
                </Text>
                <Text style={[styles.paceDesc, active && styles.paceDescActive, { fontSize: 12, textAlign: 'left', lineHeight: 16 }]}>
                  {opt.desc}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

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

  const renderAppleHealthStep = () => (
    <View>
      <Text style={styles.stepTitle}>Apple Health is optional</Text>
      <Text style={styles.hint}>If you connect it, Thallo reads sleep, resting heart rate, HRV, steps, workouts, weight, and active energy, and writes completed workouts back to Apple Health.</Text>

      <View style={{ gap: 12, marginTop: 16 }}>
        <TouchableOpacity
          style={[styles.chipWide, appleHealthEnabled && styles.chipWideSelected]}
          onPress={async () => {
            if (!isHealthKitAvailable()) {
              Alert.alert('Not Available', 'Apple Health is not available on this device.');
              return;
            }
            Alert.alert(
              APPLE_HEALTH_PERMISSION_COPY.title,
              APPLE_HEALTH_PERMISSION_COPY.body,
              [
                { text: 'Not now', style: 'cancel' },
                {
                  text: 'Continue',
                  onPress: async () => {
                    const granted = await requestHealthPermissions();
                    if (granted) {
                      setAppleHealthEnabled(true);
                      await persistHealthEnabled(true);
                      // Backfill the last 30 days of HK data so weekly_review +
                      // recovery_flags have history to reason about from day one
                      // (otherwise the server's daily_health_snapshots stays
                      // empty until the user opens the app for 30 separate days).
                      import('../services/healthDataSummary')
                        .then(({ backfillSnapshotsToBackend }) => backfillSnapshotsToBackend(30))
                        .catch(() => undefined);
                    } else {
                      Alert.alert('Apple Health not connected', APPLE_HEALTH_PERMISSION_COPY.denied);
                    }
                  },
                },
              ],
            );
          }}>
          <Text style={styles.chipIcon}>⌚</Text>
          <View style={{ flex: 1 }}>
            <Text style={[styles.chipWideLabel, appleHealthEnabled && styles.chipWideLabelSelected]}>Connect Apple Health</Text>
            <Text style={styles.chipWideDesc}>Optional: reads sleep, HRV, steps, workouts, weight, and writes completed workouts</Text>
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
            <Text style={styles.chipWideDesc}>Keep going without it. You can connect later in Account settings.</Text>
          </View>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderStep = () => {
    switch (currentStepKey) {
      case 'goal':          return renderGoalStep();
      case 'goalRefine':    return renderGoalRefineStep();
      case 'physicalStats': return renderPhysicalStatsStep();
      case 'trainingDays':  return renderTrainingDaysStep();
      case 'equipment':     return renderEquipmentStep();
      case 'foods':         return renderFoodsStep();
      case 'supplements':   return renderSupplementsStep();
      case 'mealRoutine':   return renderMealRoutineStep();
      case 'appleHealth':   return renderAppleHealthStep();
      case 'context':       return renderContextStep();
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}>
      <ScrollView
        ref={scrollRef}
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {onExit && (
          <TouchableOpacity
            style={styles.exitButton}
            onPress={() => {
              Alert.alert(
                'Exit sign up?',
                'Your progress will be cleared and you can sign in with an existing account.',
                [
                  { text: 'Keep going', style: 'cancel' },
                  { text: 'Exit', style: 'destructive', onPress: onExit },
                ],
              );
            }}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Ionicons name="close" size={18} color={colors.textPrimary} />
            <Text style={styles.exitButtonLabel}>Exit</Text>
          </TouchableOpacity>
        )}
        <View style={styles.header}>
          <Image source={logo} style={styles.logo} resizeMode="contain" />
          <Text style={styles.stepCounter}>Step {currentStep + 1} of {totalSteps}  ·  {
            ({
              goal: 'Goal',
              goalRefine: 'Refine',
              physicalStats: 'About You',
              trainingDays: 'Schedule',
              equipment: 'Equipment',
              foods: 'Foods',
              supplements: 'Supplements',
              mealRoutine: 'Meals',
              appleHealth: 'Health',
              context: 'Final Details',
            } as Record<StepKey, string>)[currentStepKey]
          }</Text>
        </View>

        <View style={styles.progressBar}>
          {Array.from({ length: totalSteps }).map((_, i) => (
            <View key={i} style={[styles.progressSegment, i <= currentStep && styles.progressSegmentActive]} />
          ))}
        </View>

        {/* Keyed fade on every step change so content transitions feel
            intentional instead of snapping. Short duration (220ms) —
            keeps the onboarding flow brisk. */}
        <FadeInView key={currentStepKey} duration={220} slideDistance={10}>
          {renderStep()}
        </FadeInView>

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
              style={[styles.nextButton, currentStep === totalSteps - 1 && styles.nextButtonFinal]}
              onPress={handleNext}>
              <Text style={[styles.nextButtonText, currentStep === totalSteps - 1 && styles.nextButtonTextFinal]}>
                {currentStep === totalSteps - 1 ? 'Get Started' : 'Next'}
              </Text>
              {currentStep < totalSteps - 1 && <Ionicons name="arrow-forward" size={16} color={colors.background} />}
            </PressableScale>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 24, paddingBottom: 200 },
  header: { marginTop: 20, marginBottom: 20 },
  exitButton: {
    position: 'absolute', top: 14, right: 14, zIndex: 10,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 4, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20,
    backgroundColor: colors.surfaceRaised, borderWidth: 1.5, borderColor: colors.border,
  },
  exitButtonLabel: {
    fontSize: 13, fontWeight: '700', color: colors.textPrimary,
  },
  logo: { width: 360, height: 160 },
  stepCounter: { fontSize: 13, color: colors.textSecondary, marginTop: 8 },

  progressBar: { flexDirection: 'row', gap: 6, marginBottom: 32 },
  progressSegment: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.border },
  progressSegmentActive: { backgroundColor: colors.primary },

  stepContainer: { marginBottom: 24 },
  stepTitle: { fontSize: 26, fontWeight: '700', color: colors.textPrimary, marginBottom: 8 },
  stepDescription: { fontSize: 15, color: colors.textSecondary, lineHeight: 22, marginBottom: 24 },

  goalGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  goalCardWrap: { width: '48%' },
  goalCard: { width: '100%', padding: 12, borderRadius: radius.lg, borderWidth: 2, borderColor: colors.border, backgroundColor: colors.surface, alignItems: 'center' },
  goalCardActive: { borderColor: colors.primary, backgroundColor: colors.surfaceRaised },
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
  heightRow: { flexDirection: 'row', gap: 12 },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 14, fontSize: 16, backgroundColor: colors.surface, color: colors.textPrimary,
  },
  unit: { fontSize: 14, color: colors.textSecondary, fontWeight: '500', minWidth: 40 },
  hint: { fontSize: 13, color: colors.textMuted, marginTop: 8 },
  optionalBanner: { fontSize: 13, color: colors.primary, fontWeight: '500', marginBottom: 16, fontStyle: 'italic' },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  searchInput: { marginBottom: 0, paddingVertical: 11, color: colors.textPrimary },
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

  // Photo scan
  scanSection: { marginBottom: 20, padding: 16, backgroundColor: colors.surfaceRaised, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  scanSectionTitle: { fontSize: 15, fontWeight: '700', color: colors.textPrimary, marginBottom: 4 },
  scanSectionSub: { fontSize: 13, color: colors.textSecondary, marginBottom: 14 },
  scanRow: { flexDirection: 'column', gap: 10 },
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

  // Food / equipment chips
  foodCategory:      { marginBottom: 18 },
  foodCategoryLabel: { fontSize: 13, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10 },
  foodChips:         { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  foodChip:          { paddingVertical: 7, paddingHorizontal: 12, borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface },
  foodChipActive:    { borderColor: colors.primary, backgroundColor: colors.surfaceRaised },
  foodChipText:      { fontSize: 13, color: colors.textSecondary, fontWeight: '500' },
  foodChipTextActive:{ color: colors.primary, fontWeight: '600' },

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
