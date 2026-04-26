import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Pressable, Modal, ActivityIndicator, Alert, TextInput, KeyboardAvoidingView, Platform, Linking, Image, Dimensions, Keyboard, Animated, Switch, LayoutAnimation, UIManager } from 'react-native';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import FadeInView from '../components/FadeInView';
import PulseView from '../components/PulseView';
import PressableScale from '../components/PressableScale';
import ShimmerLogo from '../components/ShimmerLogo';
import LogActivityModal from '../components/LogActivityModal';
import FriendsModal from '../components/FriendsModal';
import ShareWorkoutModal from '../components/ShareWorkoutModal';
import LiveActivityTracker from '../components/LiveActivityTracker';
import StreakCounter from '../components/StreakCounter';
import { WorkoutDaySkeleton } from '../components/SkeletonLoader';

const { width: SCREEN_W } = Dimensions.get('window');
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import { UserProfile, WorkoutPlan, DailyNutritionPlan, WorkoutDay, WorkoutSession, SupplementItem, InjuryEntry, MealRoutineEntry, MealRoutineFood } from '../types';
import { generateWorkoutPlan, generateDailyNutritionForDate } from '../utils/planGenerator';
import { getWorkoutStatus, getDayState, upsertDayState, getExercises, askTrainerQuestion, lookupSupplement, lookupSupplementFromPhoto, logWorkoutDone, enrichFoodItems, logMealChecked, getMe, updateEmail, classifyFoods, getSocialFeed, type FeedItem } from '../services/api';
import { useMetaData } from '../hooks/useMetaData';
import {
  isTodayWorkoutDone, todayKey, dateKey, loadWorkoutHistory, saveWorkoutSession, saveSkipToHistory, loadWorkoutSummaries, loadHealthScore,
  savePlanChange, loadMealRoutines, saveMealRoutines, applyRoutines, applyRoutinesToAll,
  loadPreservedCompletedWorkouts,
  savePreservedCompletedWorkout,
  deleteWorkoutSession,
} from '../utils/workoutHistory';
import { PRIMARY_GOALS } from '../constants/goalConfig';
import { getMealChecks, saveMealChecks, MealChecks, getSavedNutritionPlan, saveNutritionPlan, getPreservedMeals, savePreservedMeal, clearPreservedMeal, clearPreservedMealBySignature, getAllSavedNutritionPlans, getAllMealChecks } from '../utils/mealTracker';
import { ensureItems, migrateNutritionPlanShape, normalizeServingUnitsInPlan } from '../utils/mealItems';
import { cleanAiText } from '../utils/aiText';
import { formatWaterTarget } from '../utils/hydration';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MealSuggestion } from '../types';
import WorkoutCard from '../components/WorkoutCard';
import NutritionCard from '../components/NutritionCard';
import FuelingRecoveryCard from '../components/FuelingRecoveryCard';
import IncompleteDayBanner from '../components/IncompleteDayBanner';
import AdaptiveMacroCard from '../components/AdaptiveMacroCard';
import SavedMealsSection from '../components/SavedMealsSection';
import PlanSwapExerciseModal from '../components/PlanSwapExerciseModal';
import ExerciseVideoCard from '../components/ExerciseVideoCard';
import { exerciseThumbSmall, primeThumbnailIndex } from '../utils/exerciseThumb';
import { configureExpandAnimation } from '../utils/layoutAnim';
import AnimatedCollapsible from '../components/AnimatedCollapsible';
import MealEditModal from '../components/MealEditModal';
import FormVideoModal from '../components/FormVideoModal';
import SupplementStackScreen from '../components/SupplementStackScreen';
import RecoveryCard from '../components/RecoveryCard';
import WeeklyDigestCard from '../components/WeeklyDigestCard';
import TrainingReadinessCard from '../components/TrainingReadinessCard';
import BirthdateBackfillCard from '../components/BirthdateBackfillCard';
import CyclePhaseCard from '../components/CyclePhaseCard';
import GroceryListModal from '../components/GroceryListModal';
import StreakConsistencyWidget from '../components/StreakConsistencyWidget';
import RecipeModal from '../components/RecipeModal';
import SearchInput from '../components/SearchInput';
// CoachCheckinModal removed — coach chat handles check-ins now
import { colors, getTheme, radius } from '../constants/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MUSCLE_LIBRARY, MuscleEntry } from '../constants/muscleLibrary';
// Inline-rendered tab content. Goals and Progress used to be modal
// overlays via parent callbacks; they now mount inside the tab body
// so the bottom nav stays pinned and feels like a single-page app.
import ProgressScreen from './ProgressScreen';
import EditProfileScreen from './EditProfileScreen';
import { computeNutritionScore } from '../utils/nutritionScore';
import ErrorBoundary from '../components/ErrorBoundary';

interface HomeScreenProps {
  authToken: string;
  userProfile: UserProfile | null;
  planRefreshKey?: number;
  isWorkoutUpdating?: boolean;
  isNutritionUpdating?: boolean;
  trainerNote?: string | null;
  nutritionistNote?: string | null;
  supplementStack?: SupplementItem[];
  onSignOut: () => void;
  onEditGoal: () => void;
  onEditWorkout: () => void;
  onEditMealPlan: (initialTab?: 'foods' | 'supplements' | 'macros') => void;
  onEditThemes: () => void;
  onEditBody: () => void;
  onStartWorkout: (workout: WorkoutDay) => void;
  onViewProgress: () => void;
  onViewAccount: () => void;
  onProfileUpdate?: (changes: Partial<UserProfile>, skipRegen?: boolean) => void;
  /** Optional: push local AsyncStorage state to the backend. Called by
   *  the trainer-chat Apply flow so plan changes persist cross-device
   *  (the old flow only wrote to local storage and silently drifted
   *  on the next login). */
  onBackendSync?: () => Promise<void>;
  onWeeklyRefresh?: (review: { adherence: number; energy: number; notes?: string; pendingChanges?: any[] }) => void;
  onCancelPlanGen?: () => void;
  // Wraps the parent's full profile-save handler so the inline tab
  // editors can save without going through the modal flow. The optional
  // `mode` argument tells the parent which section to regenerate so the
  // right loading state fires (workout vs nutrition).
  onSaveProfile?: (updated: UserProfile, mode?: 'goal' | 'workout' | 'mealplan' | 'theme') => void;
  /** Switch-Day full regen — takes the pinned day index + focus, runs the
   *  AI workout-plan job with the big "Building your new plan" splash,
   *  then overrides the pinned day to the chosen focus post-hoc. Lets
   *  users see a proper whole-plan rebuild when they change a day. */
  onSwitchDayRegen?: (pinDayIdx: number, pinFocus: string) => Promise<any[] | undefined>;
}

interface ScheduleItem {
  date: Date;
  workout: WorkoutDay | null;
  isRest: boolean;
}

interface MealDay {
  key: string;
  date: Date;
}

interface TrainerChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Set when the assistant message came from a quick-intent handler.
   *  Lets the chat UI render an "Apply" button that routes through
   *  applyRecommendationAction → durable settings change. */
  intent?: string | null;
  action?: Record<string, any> | null;
  /** Becomes true after the user accepts so we can hide the button. */
  applied?: boolean;
}

interface PendingPlanUpdate {
  resp: any;
  question: string;
  coachMode: 'trainer' | 'nutritionist';
  profileChanges: Partial<UserProfile>;  // detected from plan diff
  summary: string;                       // human-readable description
}

interface AvailabilityItem {
  label: string;
  pct: number;
}

interface ExerciseLibraryItem {
  id?: number;
  name: string;
  slug?: string;
  description?: string | null;
  primary_muscle?: string;
  secondary_muscles?: string[];
  equipment?: string;
  is_compound?: boolean;
  image_url?: string | null;
  video_id?: string | null;
  movement_pattern?: string | null;
}

const DAY_NAMES   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
const EMAIL_BANNER_DISMISS_KEY = 'emailBannerDismissedAt';

// Meal-side today accent. Hardcoded (not theme-derived) so the meal
// accordion's today highlight is guaranteed visually distinct from the
// workout tab regardless of which theme the user picks. The workout
// side stays palette-driven (`workoutPalette.strong`) so its highlight
// matches the rest of the workout tab in whatever theme is active.
const MEALS_ACCENT = '#35C46A';

// ── Supplement Library Data ───────────────────────────────────────────────────
interface SupplementEntry {
  name: string;
  category: string;
  icon: string;
  tagline: string;
  whatItDoes: string;
  evidence: 'strong' | 'moderate' | 'limited';
  dose: string;
  timing: string;
  goodFor: string[];
  cautions: string;
}

const SUPPLEMENT_LIBRARY: SupplementEntry[] = [
  {
    name: 'Creatine Monohydrate',
    category: 'Performance',
    icon: '⚡',
    tagline: 'The most studied strength and muscle supplement',
    whatItDoes: 'Replenishes ATP (cellular energy) faster during high-intensity efforts, letting you squeeze out extra reps before fatigue. Over time it drives more muscle growth by enabling greater training volume. Safe and effective for virtually everyone.',
    evidence: 'strong',
    dose: '3–5g daily',
    timing: 'Any time — consistency matters more than timing',
    goodFor: ['Strength', 'Muscle gain', 'Athletic performance'],
    cautions: 'Drink plenty of water. May cause mild water retention in the first week.',
  },
  {
    name: 'Whey Protein',
    category: 'Protein',
    icon: '🥛',
    tagline: 'Fast-digesting complete protein for muscle repair',
    whatItDoes: 'Delivers all essential amino acids rapidly after a workout to kick-start muscle protein synthesis. Ideal when you struggle to hit protein targets through whole foods. Casein is the slow-digesting sister — great before bed.',
    evidence: 'strong',
    dose: '25–40g per serving',
    timing: 'Post-workout or between meals',
    goodFor: ['Muscle gain', 'Fat loss', 'Recovery'],
    cautions: 'May cause bloating in lactose-sensitive individuals — try whey isolate or plant protein instead.',
  },
  {
    name: 'Casein Protein',
    category: 'Protein',
    icon: '🌙',
    tagline: 'Slow-release protein that feeds muscles overnight',
    whatItDoes: 'Forms a gel in the stomach and digests slowly over 5–7 hours, providing a sustained stream of amino acids. Best used before sleep to prevent muscle breakdown during the overnight fast.',
    evidence: 'strong',
    dose: '25–40g',
    timing: '30 min before bed',
    goodFor: ['Muscle gain', 'Recovery'],
    cautions: 'Contains dairy — not suitable for those with milk allergies.',
  },
  {
    name: 'Plant Protein',
    category: 'Protein',
    icon: '🌱',
    tagline: 'Complete protein for plant-based athletes',
    whatItDoes: 'Blends of pea, rice, hemp, or soy protein that together deliver a full essential amino acid profile. Studies show muscle-building effects comparable to whey when protein intake is equated.',
    evidence: 'moderate',
    dose: '25–35g per serving',
    timing: 'Post-workout or between meals',
    goodFor: ['Muscle gain', 'Fat loss', 'Plant-based diets'],
    cautions: 'May contain heavy metals if quality is poor — choose third-party tested brands.',
  },
  {
    name: 'BCAA',
    category: 'Recovery',
    icon: '💊',
    tagline: 'Branched-chain amino acids for intra-workout fuel',
    whatItDoes: 'Leucine, isoleucine, and valine — the trio that directly trigger muscle protein synthesis. Most useful when training fasted or when total protein intake is low. Largely redundant if you already hit daily protein targets.',
    evidence: 'moderate',
    dose: '5–10g',
    timing: 'During or around workouts',
    goodFor: ['Muscle gain', 'Endurance', 'Fasted training'],
    cautions: 'Low value if you are already eating enough protein (1.6g+ per kg body weight).',
  },
  {
    name: 'EAA',
    category: 'Recovery',
    icon: '🔗',
    tagline: 'All 9 essential amino acids for superior muscle signalling',
    whatItDoes: 'Contains all essential amino acids (not just the 3 BCAAs), providing a more complete stimulus for muscle protein synthesis. Better than BCAAs alone for fasted training or low protein days.',
    evidence: 'moderate',
    dose: '10–15g',
    timing: 'Intra-workout or post-workout',
    goodFor: ['Muscle gain', 'Recovery', 'Endurance'],
    cautions: 'Can be expensive relative to just eating more protein-rich food.',
  },
  {
    name: 'Beta-Alanine',
    category: 'Performance',
    icon: '🔥',
    tagline: 'Delays muscle burn during high-rep or cardio efforts',
    whatItDoes: 'Boosts muscle carnosine levels, which buffer the acid that builds up during intense exercise. This delays the "burn" feeling and lets you push harder in the 1–4 minute effort zone — sprints, high-rep sets, circuits.',
    evidence: 'strong',
    dose: '3.2–6.4g daily',
    timing: 'Pre-workout or split through the day',
    goodFor: ['Endurance', 'Athletic performance', 'Fat loss'],
    cautions: 'Causes harmless tingling (paresthesia) — split doses reduce this effect.',
  },
  {
    name: 'L-Citrulline',
    category: 'Performance',
    icon: '🩸',
    tagline: 'Boosts nitric oxide for better pumps and endurance',
    whatItDoes: 'Converted in the kidneys to arginine, raising nitric oxide levels and widening blood vessels. This improves blood flow to working muscles, reduces fatigue, and enhances the "pump" feeling during training.',
    evidence: 'moderate',
    dose: '6–8g (as citrulline) or 8–12g (as citrulline malate)',
    timing: '30–60 min pre-workout',
    goodFor: ['Strength', 'Endurance', 'Athletic performance'],
    cautions: 'Generally very safe. May cause mild GI discomfort at high doses.',
  },
  {
    name: 'Caffeine',
    category: 'Performance',
    icon: '☕',
    tagline: 'Proven ergogenic that boosts strength, power, and focus',
    whatItDoes: 'Blocks adenosine receptors to reduce perceived effort and fatigue, while increasing dopamine and adrenaline. One of the most consistent performance enhancers in sports science. Works for strength, endurance, and cognitive tasks.',
    evidence: 'strong',
    dose: '3–6mg per kg body weight',
    timing: '30–60 min pre-workout',
    goodFor: ['Strength', 'Endurance', 'Fat loss', 'Athletic performance'],
    cautions: 'Can disrupt sleep if taken within 6 hours of bed. Tolerance builds quickly — cycling off helps.',
  },
  {
    name: 'Pre-Workout',
    category: 'Performance',
    icon: '💥',
    tagline: 'Stacked formula for energy, focus, and performance',
    whatItDoes: 'Typically contains caffeine, beta-alanine, citrulline, and various focus ingredients. Convenient but redundant if you already take the individual components. Quality and dosing vary hugely between brands.',
    evidence: 'moderate',
    dose: '1 serving (follow label)',
    timing: '20–30 min pre-workout',
    goodFor: ['Strength', 'Endurance', 'Athletic performance'],
    cautions: 'Check for proprietary blends that hide underdosed ingredients. Avoid high-stim versions if sensitive to caffeine.',
  },
  {
    name: 'L-Glutamine',
    category: 'Recovery',
    icon: '🛡️',
    tagline: 'Supports gut health and immune function under heavy training',
    whatItDoes: 'Glutamine is the most abundant amino acid in muscle tissue and a primary fuel for gut cells. Heavy training depletes levels. Supplementing can reduce soreness and support immune function during high training loads.',
    evidence: 'limited',
    dose: '5–10g',
    timing: 'Post-workout or before bed',
    goodFor: ['Recovery', 'Endurance'],
    cautions: 'Limited direct muscle-building evidence if protein intake is adequate.',
  },
  {
    name: 'Vitamin D',
    category: 'Health',
    icon: '☀️',
    tagline: 'Critical for muscle function, immunity, and hormones',
    whatItDoes: 'Acts more like a hormone than a vitamin — involved in over 1,000 body processes including testosterone production, muscle strength, immune defence, and mood regulation. Deficiency is extremely common and directly impairs performance.',
    evidence: 'strong',
    dose: '1,000–4,000 IU daily (or per blood test)',
    timing: 'With a meal containing fat',
    goodFor: ['Strength', 'Endurance', 'General health'],
    cautions: 'Get blood levels tested first — dosing depends on your baseline. D3 is more effective than D2.',
  },
  {
    name: 'Omega-3 / Fish Oil',
    category: 'Health',
    icon: '🐟',
    tagline: 'Anti-inflammatory support for joints and heart health',
    whatItDoes: 'EPA and DHA reduce systemic inflammation, support joint lubrication, and may moderately enhance muscle protein synthesis. Important for long-term health and recovery, especially for athletes training at high volumes.',
    evidence: 'strong',
    dose: '2–4g EPA+DHA combined daily',
    timing: 'With meals to reduce fishy burps',
    goodFor: ['Recovery', 'General health', 'Endurance'],
    cautions: 'High doses can thin blood — consult a doctor if on blood thinners.',
  },
  {
    name: 'Magnesium Glycinate',
    category: 'Sleep & Stress',
    icon: '🧘',
    tagline: 'Relaxation mineral for sleep quality and muscle function',
    whatItDoes: 'Magnesium is involved in 300+ enzyme reactions including muscle relaxation, sleep onset, and stress regulation. Glycinate is the most bioavailable and gentle form. Deficiency is common and worsens sleep, cramps, and recovery.',
    evidence: 'moderate',
    dose: '200–400mg elemental magnesium',
    timing: '30–60 min before bed',
    goodFor: ['Recovery', 'General health', 'Sleep'],
    cautions: 'Oxide form (cheapest) is poorly absorbed — always choose glycinate or malate.',
  },
  {
    name: 'Zinc',
    category: 'Health',
    icon: '🔬',
    tagline: 'Essential for testosterone production and immune defence',
    whatItDoes: 'Zinc is critical for testosterone synthesis, immune function, and wound healing. Athletes lose significant zinc through sweat. Even mild deficiency reduces testosterone and impairs recovery.',
    evidence: 'moderate',
    dose: '15–30mg',
    timing: 'With food (reduces nausea)',
    goodFor: ['Strength', 'Muscle gain', 'General health'],
    cautions: 'High long-term doses (>40mg) can deplete copper — cycle or pair with a trace mineral supplement.',
  },
  {
    name: 'Ashwagandha',
    category: 'Sleep & Stress',
    icon: '🌿',
    tagline: 'Adaptogen that lowers cortisol and supports recovery',
    whatItDoes: 'An adaptogenic herb that reduces cortisol (the stress hormone), which when chronically elevated suppresses testosterone and slows recovery. Studies show meaningful improvements in strength, VO2 max, and sleep quality.',
    evidence: 'moderate',
    dose: '300–600mg (KSM-66 or Sensoril extract)',
    timing: 'Daily — morning or evening',
    goodFor: ['Strength', 'Recovery', 'Endurance'],
    cautions: 'May interact with thyroid medications. Avoid during pregnancy.',
  },
  {
    name: 'Melatonin',
    category: 'Sleep & Stress',
    icon: '😴',
    tagline: 'Regulates the sleep-wake cycle for faster sleep onset',
    whatItDoes: 'A hormone naturally produced at night that signals the body to sleep. Supplementing with small doses helps shift the circadian rhythm — ideal for jet lag, shift workers, or those training late at night.',
    evidence: 'strong',
    dose: '0.5–3mg (lower is often more effective)',
    timing: '30–60 min before target sleep time',
    goodFor: ['Recovery', 'General health'],
    cautions: 'Avoid high doses (10mg+) — they are not more effective and may cause next-day grogginess.',
  },
  {
    name: 'L-Theanine',
    category: 'Sleep & Stress',
    icon: '🍵',
    tagline: 'Promotes calm focus without drowsiness',
    whatItDoes: 'An amino acid found in green tea that increases alpha brain waves, producing relaxed alertness. Paired with caffeine it smooths out jitteriness and extends the focus window without adding stimulation.',
    evidence: 'moderate',
    dose: '100–200mg',
    timing: 'With caffeine (1:2 ratio caffeine:theanine) or before bed',
    goodFor: ['Athletic performance', 'General health'],
    cautions: 'Very well tolerated. May enhance sedative effects of sleep medications.',
  },
  {
    name: 'L-Carnitine',
    category: 'Weight Management',
    icon: '🔥',
    tagline: 'Shuttles fat into cells to be burned for energy',
    whatItDoes: 'Transports long-chain fatty acids into mitochondria where they are oxidised for fuel. Evidence for fat loss is modest but consistent in individuals who are deficient (vegans, elderly). Also supports exercise recovery and cognition.',
    evidence: 'moderate',
    dose: '1–3g',
    timing: 'With a carb-containing meal for best absorption',
    goodFor: ['Fat loss', 'Endurance', 'General health'],
    cautions: 'Not a magic fat burner — works best alongside a caloric deficit and regular training.',
  },
  {
    name: 'Collagen Peptides',
    category: 'Protein',
    icon: '🦴',
    tagline: 'Supports joints, tendons, and connective tissue repair',
    whatItDoes: 'Provides glycine, proline, and hydroxyproline — amino acids that rebuild cartilage and tendon collagen. When taken with vitamin C around training, studies show improvements in joint pain and connective tissue thickness.',
    evidence: 'moderate',
    dose: '10–20g',
    timing: '30–60 min before training (with vitamin C)',
    goodFor: ['Recovery', 'General health', 'Endurance'],
    cautions: 'Not a replacement for complete protein — lacks tryptophan and is low in leucine.',
  },
  {
    name: 'ZMA',
    category: 'Sleep & Stress',
    icon: '💤',
    tagline: 'Zinc + magnesium + B6 stack for sleep and recovery',
    whatItDoes: 'Combines zinc, magnesium aspartate, and vitamin B6 to support hormone production, sleep quality, and muscle recovery. Popular with athletes training at high volumes who sweat heavily and may deplete these minerals.',
    evidence: 'limited',
    dose: '1 serving (follow label)',
    timing: '30–60 min before bed on an empty stomach',
    goodFor: ['Strength', 'Recovery', 'Sleep'],
    cautions: 'Evidence for benefit is stronger in people who are actually deficient in zinc or magnesium.',
  },
  {
    name: 'Electrolytes',
    category: 'Recovery',
    icon: '💧',
    tagline: 'Sodium, potassium, and magnesium for hydration and cramps',
    whatItDoes: 'Sweat contains significant sodium, potassium, and magnesium. Replacing them prevents dehydration-related performance drops, muscle cramps, and cognitive fog — especially during long or hot training sessions.',
    evidence: 'strong',
    dose: 'Varies by product and sweat rate',
    timing: 'During and after exercise; also useful fasting or on low-carb diets',
    goodFor: ['Endurance', 'Athletic performance', 'General health'],
    cautions: 'High-sodium varieties may not be suitable if you have hypertension.',
  },
  {
    name: 'Multivitamin',
    category: 'Health',
    icon: '🧴',
    tagline: 'Nutritional insurance for gaps in your diet',
    whatItDoes: 'Covers common micronutrient gaps, especially important for athletes with high metabolic demands or those eating in a caloric deficit. Not a substitute for a balanced diet, but provides a meaningful safety net.',
    evidence: 'moderate',
    dose: '1 serving daily (follow label)',
    timing: 'With food',
    goodFor: ['General health', 'Fat loss', 'Endurance'],
    cautions: 'Avoid mega-dose formulas — fat-soluble vitamins (A, D, E, K) accumulate and can reach toxic levels.',
  },
  {
    name: 'Tart Cherry Extract',
    category: 'Recovery',
    icon: '🍒',
    tagline: 'Natural anti-inflammatory for post-workout soreness',
    whatItDoes: 'Rich in anthocyanins that reduce inflammation and oxidative stress. Studies in strength and endurance athletes show meaningfully less muscle soreness and faster force recovery when taken around training.',
    evidence: 'moderate',
    dose: '480mg extract or 30ml concentrate twice daily',
    timing: 'Morning and night around intense training days',
    goodFor: ['Recovery', 'Endurance', 'Strength'],
    cautions: 'Juice form is high in sugar — extract capsules are preferable when cutting.',
  },
  {
    name: 'Green Tea Extract',
    category: 'Weight Management',
    icon: '🍵',
    tagline: 'Modest metabolism boost and antioxidant support',
    whatItDoes: 'EGCG (the active catechin) mildly inhibits an enzyme that breaks down norepinephrine, gently elevating fat oxidation. Best evidence is for modest calorie burn (50–100 kcal/day) and strong antioxidant protection.',
    evidence: 'moderate',
    dose: '400–600mg EGCG',
    timing: 'With meals to reduce stomach upset',
    goodFor: ['Fat loss', 'General health'],
    cautions: 'High doses on an empty stomach can cause nausea and liver stress. Stick to recommended amounts.',
  },
];

// ── Logo assets ───────────────────────────────────────────────────────────────
const LOGO_DARK   = require('../../assets/images/thallo-logo-white.png');
const LOGO_LIGHT_HEADER = require('../../assets/images/thallo-logo-black.png');

const _MICRO_CHECK_KEYS = ['saturated_fat', 'omega_3', 'potassium', 'calcium', 'iron', 'vitamin_d'];

async function _enrichRoutineMealsMicros(
  plansByDate: Record<string, DailyNutritionPlan>,
  token: string,
  routines: MealRoutineEntry[],
  setPlansByDate: (plans: Record<string, DailyNutritionPlan>) => void,
) {
  try {
    const thinItems: Array<{ name: string; quantity?: number; unit?: string }> = [];
    const seen = new Set<string>();
    for (const plan of Object.values(plansByDate)) {
      for (const meal of plan.meals ?? []) {
        if (!(meal as any)._routineId && !meal.isRoutine) continue;
        const mn = meal.micronutrients ?? {};
        const hasEnough = _MICRO_CHECK_KEYS.filter(k => typeof (mn as any)[k] === 'number' && (mn as any)[k] > 0).length >= 3;
        if (hasEnough) continue;
        for (const it of meal.items ?? []) {
          const key = it.name.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          const itMn = it.micronutrients ?? {};
          const itHas = _MICRO_CHECK_KEYS.filter(k => typeof (itMn as any)[k] === 'number' && (itMn as any)[k] > 0).length;
          if (itHas < 2) {
            thinItems.push({ name: it.name, quantity: it.quantity, unit: it.unit });
          }
        }
      }
    }
    if (thinItems.length === 0) return;
    console.log(`[enrichRoutineMicros] ${thinItems.length} routine items need micros — calling server`);
    const resp = await enrichFoodItems(token, thinItems);
    if (!resp?.items?.length) return;
    const microsByName: Record<string, Record<string, number>> = {};
    for (const e of resp.items) {
      if (e.micronutrients && Object.keys(e.micronutrients).length > 0) {
        microsByName[e.name.toLowerCase()] = e.micronutrients;
      }
    }
    if (Object.keys(microsByName).length === 0) return;
    const patched = { ...plansByDate };
    let patchCount = 0;
    for (const [dk, plan] of Object.entries(patched)) {
      let changed = false;
      const meals = (plan.meals ?? []).map(meal => {
        if (!(meal as any)._routineId && !meal.isRoutine) return meal;
        const items = (meal.items ?? []).map(it => {
          const micros = microsByName[it.name.toLowerCase()];
          if (!micros) return it;
          patchCount++;
          return { ...it, micronutrients: { ...(it.micronutrients ?? {}), ...micros } };
        });
        const resummed: Record<string, number> = {};
        for (const it of items) {
          for (const [k, v] of Object.entries(it.micronutrients ?? {})) {
            resummed[k] = (resummed[k] ?? 0) + (typeof v === 'number' ? v : 0);
          }
        }
        changed = true;
        return { ...meal, items, micronutrients: { ...(meal.micronutrients ?? {}), ...resummed } };
      });
      if (changed) patched[dk] = { ...plan, meals };
    }
    if (patchCount > 0) {
      console.log(`[enrichRoutineMicros] patched ${patchCount} items across ${Object.keys(patched).length} days`);
      setPlansByDate(patched);
      // Persist micros back onto routine entries so future loads skip enrichment
      let routinesDirty = false;
      for (const r of routines) {
        if (!r.items?.length) continue;
        for (const it of r.items) {
          const micros = microsByName[it.name.toLowerCase()];
          if (micros) {
            it.micronutrients = { ...(it.micronutrients ?? {}), ...micros };
            routinesDirty = true;
          }
        }
      }
      if (routinesDirty) {
        saveMealRoutines(routines).catch(() => {});
      }
    }
  } catch (e) {
    console.log(`[enrichRoutineMicros] failed (non-fatal):`, e);
  }
}

async function _backfillFoodClassifications(
  plansByDate: Record<string, DailyNutritionPlan>,
  token: string,
  setPlansByDate: React.Dispatch<React.SetStateAction<Record<string, DailyNutritionPlan>>>,
) {
  try {
    const unclassified = new Set<string>();
    for (const plan of Object.values(plansByDate)) {
      for (const meal of plan.meals ?? []) {
        for (const it of meal.items ?? []) {
          if (!it.protein_source && it.name) {
            unclassified.add(it.name);
          }
        }
      }
    }
    if (unclassified.size === 0) return;
    console.log(`[backfillClassify] ${unclassified.size} items need classification`);
    const resp = await classifyFoods(token, Array.from(unclassified));
    if (!resp?.classifications?.length) return;
    const byName: Record<string, typeof resp.classifications[number]> = {};
    for (const c of resp.classifications) {
      byName[c.name.toLowerCase()] = c;
    }
    setPlansByDate(prev => {
      const patched = { ...prev };
      let count = 0;
      for (const [dk, plan] of Object.entries(patched)) {
        let touched = false;
        const meals = (plan.meals ?? []).map(meal => {
          const items = (meal.items ?? []).map(it => {
            if (it.protein_source) return it;
            const cls = byName[it.name?.toLowerCase()];
            if (!cls) return it;
            count++;
            touched = true;
            return {
              ...it,
              protein_source: cls.protein_source as any,
              fermented: cls.fermented,
              probiotic: cls.probiotic,
              omega3_rich: cls.omega3_rich,
              plant_count: cls.plant_count,
              food_quality: cls.food_quality as any,
            };
          });
          return { ...meal, items };
        });
        if (touched) patched[dk] = { ...plan, meals };
      }
      if (count > 0) {
        console.log(`[backfillClassify] patched ${count} items`);
        for (const [dk, plan] of Object.entries(patched)) {
          saveNutritionPlan(dk, plan).catch(() => {});
        }
      }
      return patched;
    });
  } catch (e) {
    console.log(`[backfillClassify] failed (non-fatal):`, e);
  }
}

function bgIsDark(hex: string): boolean {
  const h = hex.replace('#', '');
  if (h.length < 6) return true;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) < 0.5;
}

/**
 * Amber fatigue notice that slides down from above + fades in on mount.
 * Lives in this file (not a shared component) because it's only used by
 * HomeScreen. Uses native driver — both transform and opacity qualify.
 */
/** Apple Health connect/disconnect row — lives in the FEEDBACK &
 *  DEVICE settings group on the profile menu. Toggling ON triggers
 *  the HealthKit auth prompt and persists the enabled flag; OFF
 *  flips the persisted flag so polling stops on next open.
 *
 *  Disconnect is soft — iOS doesn't let an app revoke its own
 *  permissions. We just stop reading. Users who actually want to
 *  pull permission go through iPhone Settings → Health → Thallo,
 *  the alert nudges them there. */
function AppleHealthToggleRow({
  themeColors,
}: { themeColors: any; userAge?: number | null }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const { isAppleHealthEnabled } = await import('../utils/workoutHistory');
        setEnabled(await isAppleHealthEnabled());
      } catch { setEnabled(false); }
    })();
  }, []);
  const onToggle = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const ah = await import('../services/appleHealth');
      if (!ah.isHealthKitAvailable()) {
        Alert.alert('Not available', 'Apple Health is iPhone-only and requires HealthKit support.');
        setBusy(false);
        return;
      }
      const { setAppleHealthEnabled } = await import('../utils/workoutHistory');
      if (next) {
        await setAppleHealthEnabled(true);
        const granted = await ah.requestHealthPermissions();
        setEnabled(true);
        if (!granted) {
          const err = ah.getLastHealthKitError();
          Alert.alert(
            'Permission needed',
            `Open iPhone Settings → Privacy & Security → Health → Thallo to enable categories.\n\n${err ?? ''}`.trim(),
          );
        }
      } else {
        await setAppleHealthEnabled(false);
        setEnabled(false);
      }
    } catch (e: any) {
      Alert.alert('Apple Health error', String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  // Show a neutral disabled placeholder while we read the persisted
  // flag so the row doesn't flash the wrong state on mount.
  return (
    <View style={[styles.profileMenuItem, { justifyContent: 'space-between' }]}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.profileMenuLabel, { color: themeColors.textPrimary }]}>Apple Health</Text>
        <Text style={{ fontSize: 11, color: themeColors.textMuted }}>
          {enabled === null
            ? 'Checking…'
            : enabled
              ? 'Sleep, RHR, HRV, weight, and workouts feed your plan'
              : 'Connect to enrich readiness, recovery, and macros'}
        </Text>
      </View>
      <Switch
        value={enabled === true}
        disabled={busy || enabled === null}
        onValueChange={onToggle}
        trackColor={{ false: themeColors.border, true: themeColors.primary + '55' }}
        thumbColor={enabled ? themeColors.primary : themeColors.textMuted}
      />
    </View>
  );
}

function FatigueNoticeBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const translateY = useRef(new Animated.Value(-20)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.parallel([
      // 250ms spring damping ~0.7 — friction/tension approximations land
      // close to that damping visually without bouncing past the target.
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true, friction: 8, tension: 90 }),
      Animated.timing(opacity, { toValue: 1, duration: 250, useNativeDriver: true }),
    ]).start();
  }, [translateY, opacity]);
  return (
    <Animated.View style={{
      flexDirection: 'row', alignItems: 'flex-start', gap: 8,
      padding: 12, borderRadius: 12,
      backgroundColor: '#F59E0B22', borderWidth: 1, borderColor: '#F59E0B88',
      marginBottom: 10,
      opacity, transform: [{ translateY }],
    }}>
      <Ionicons name="information-circle-outline" size={18} color="#B45309" style={{ marginTop: 1 }} />
      <Text style={{ flex: 1, fontSize: 12, color: '#B45309', lineHeight: 16 }}>{message}</Text>
      <TouchableOpacity onPress={onDismiss} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Ionicons name="close" size={16} color="#B45309" />
      </TouchableOpacity>
    </Animated.View>
  );
}

const SKIP_REASONS = [
  { icon: 'moon-outline' as const, label: 'Too tired' },
  { icon: 'bandage-outline' as const, label: 'Injury / Pain' },
  { icon: 'thermometer-outline' as const, label: 'Feeling sick' },
  { icon: 'time-outline' as const, label: 'No time today' },
  { icon: 'airplane-outline' as const, label: 'Travelling' },
  { icon: 'bed-outline' as const, label: 'Need more rest' },
  { icon: 'briefcase-outline' as const, label: 'Work conflict' },
  { icon: 'sunny-outline' as const, label: 'Did something else' },
];

// Training day patterns. For 1-4 days we space them across the week.
// For 5+ days, training starts from today and rest days are placed
// at the end — so a user signing up on Saturday doesn't see 2 rest
// days before their first workout.
const TRAINING_DAY_SETS: Record<number, number[]> = {
  1: [1],
  2: [1, 4],
  3: [1, 3, 5],
  4: [1, 2, 4, 5],
  5: [1, 2, 3, 4, 5],
  6: [1, 2, 3, 4, 5, 6],
  7: [0, 1, 2, 3, 4, 5, 6],
};

function get7DaySchedule(
  workoutPlan: WorkoutPlan,
  daysPerWeek: number,
  skippedDates?: Set<string>,
  droppedSkipDates?: Set<string>,
  completedDates?: Set<string>,
  userTrainingDays?: number[],
): ScheduleItem[] {
  if (!workoutPlan?.days?.length) return [];
  // Use user-selected training days if available, else fall back to defaults
  const trainingSet = new Set(
    userTrainingDays && userTrainingDays.length === daysPerWeek
      ? userTrainingDays
      : TRAINING_DAY_SETS[Math.min(Math.max(daysPerWeek, 1), 7)] ?? [1, 3, 5]
  );
  const today = new Date();
  const totalDays = workoutPlan.days.length;
  const todayDow = today.getDay();
  const daysFromMon = todayDow === 0 ? 6 : todayDow - 1;

  // Count how many workouts were ACTUALLY completed or consumed
  // (done + dropped skips) earlier this week. This determines where
  // we are in the recipe rotation. Using actual completions instead
  // of calendar training-day counting ensures PPL stays in order:
  // if the user did Push on Thursday, Friday shows Pull (not Legs).
  let weekOffset = 0;
  for (let i = 0; i < daysFromMon; i++) {
    const pastDate = new Date(today);
    pastDate.setDate(today.getDate() - (daysFromMon - i));
    const key = dateKey(pastDate);
    const wasCompleted = completedDates?.has(key);
    const wasDropped = droppedSkipDates?.has(key);
    const wasSkipped = skippedDates?.has(key);
    // Advance rotation index for: completed workouts, dropped skips,
    // and training days that passed without being skipped (assumed done
    // or the user just didn't log).
    if (wasCompleted || wasDropped) {
      weekOffset++;
    } else if (!wasSkipped && trainingSet.has(((i + 1) % 7))) {
      // Training day that wasn't skipped or completed — still advance
      // so the rotation doesn't stall on missed days
      weekOffset++;
    }
  }

  // Build a 7-day schedule. For 5+ training days, ensure today is
  // always a training day so new users don't see rest first.
  // For fewer days, use the fixed day-of-week pattern.
  const schedule: ScheduleItem[] = [];
  let workoutIdx = weekOffset;

  // When user picked specific training days, use day-of-week matching.
  // Otherwise for 5+ days/week, use today-relative placement so
  // new users don't start with rest days.
  const hasCustomDays = !!(userTrainingDays && userTrainingDays.length === daysPerWeek);
  const dynamicRest = new Set<number>();
  if (!hasCustomDays && daysPerWeek >= 5) {
    const restCount = 7 - daysPerWeek;
    for (let r = 0; r < restCount; r++) {
      dynamicRest.add(7 - 1 - r);
    }
  }

  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    const dow = date.getDay();

    const isTrainingDay = hasCustomDays
      ? trainingSet.has(dow)
      : daysPerWeek >= 5
        ? !dynamicRest.has(i)
        : trainingSet.has(dow);

    if (isTrainingDay) {
      schedule.push({ date, workout: workoutPlan.days[workoutIdx % totalDays], isRest: false });
      const key = dateKey(date);
      if (!skippedDates?.has(key) || droppedSkipDates?.has(key)) {
        workoutIdx++;
      }
    } else {
      schedule.push({ date, workout: null, isRest: true });
    }
  }
  return schedule;
}

function getNextMealDays(count: number): MealDay[] {
  const out: MealDay[] = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    out.push({ key: dateKey(d), date: d });
  }
  return out;
}

function mealDayLabel(date: Date, index: number): string {
  if (index === 0) return 'Today';
  if (index === 1) return 'Tomorrow';
  return `${DAY_NAMES[date.getDay()]} · ${MONTH_NAMES[date.getMonth()]} ${date.getDate()}`;
}

function humanizeToken(value?: string | null): string {
  if (!value) return '';
  return String(value)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function joinParts(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

type MovementPattern =
  | 'curl' | 'extension_elbow' | 'press_horizontal' | 'press_vertical'
  | 'fly' | 'row' | 'pulldown' | 'raise' | 'squat' | 'hinge'
  | 'lunge' | 'hip_thrust' | 'calf_raise' | 'plank' | 'crunch' | 'generic';

function detectMovementPattern(name: string, primary: string): MovementPattern {
  const n = name.toLowerCase();
  const p = (primary ?? '').toLowerCase();
  if (/(curl|bicep curl|hammer curl|preacher)/.test(n)) return 'curl';
  if (/(tricep|skull crusher|pushdown|kickback|overhead extension)/.test(n) && /(extend|press)/.test(n)) return 'extension_elbow';
  if (/pushdown|tricep extension|skull crusher|kickback/.test(n)) return 'extension_elbow';
  if (/(bench press|chest press|push.?up|dip|pec dec)/.test(n) && !/(overhead|shoulder)/.test(n)) return 'press_horizontal';
  if (/(fly|pec|cable cross)/.test(n)) return 'fly';
  if (/(overhead press|shoulder press|military|arnold|lateral raise|front raise|upright row)/.test(n)) {
    if (/raise/.test(n)) return 'raise';
    return 'press_vertical';
  }
  if (/(lateral raise|front raise|rear delt|face pull)/.test(n)) return 'raise';
  if (/(row|pull.?up|chin.?up|lat pull)/.test(n)) {
    if (/pulldown|lat pull/.test(n)) return 'pulldown';
    return 'row';
  }
  if (/(squat|goblet|hack squat|leg press)/.test(n)) return 'squat';
  if (/(deadlift|rdl|romanian|good morning|hip hinge)/.test(n)) return 'hinge';
  if (/lunge/.test(n)) return 'lunge';
  if (/(hip thrust|glute bridge)/.test(n)) return 'hip_thrust';
  if (/(calf raise|standing calf|seated calf)/.test(n)) return 'calf_raise';
  if (/(plank|hollow|l.sit)/.test(n)) return 'plank';
  if (/(crunch|sit.?up|ab|cable crunch)/.test(n)) return 'crunch';
  return 'generic';
}

function buildExerciseGuide(ex: ExerciseLibraryItem) {
  const primary = humanizeToken(ex.primary_muscle) || 'the target muscle';
  const secondary = (ex.secondary_muscles ?? []).map(humanizeToken).filter(Boolean);
  const equipment = humanizeToken(ex.equipment) || 'the equipment';
  const supportText = secondary.length ? ` with help from ${joinParts(secondary)}` : '';
  const pattern = detectMovementPattern(ex.name, ex.primary_muscle ?? '');
  const p = primary.toLowerCase();
  const sec = secondary.map(s => s.toLowerCase());

  // Pattern-specific phase descriptions
  const phaseDescriptions: Record<MovementPattern, { concentric: string; eccentric: string; why: string; setup: string; movement: string; feel: string; mistake: string }> = {
    curl: {
      concentric: `As you curl the weight up, the ${p} contracts and shortens — pulling your forearm toward your upper arm. Peak contraction happens at the top: squeeze hard and hold for a beat to maximize tension.`,
      eccentric: `Lowering is where real growth happens. Control the descent over 2–3 seconds as the ${p} lengthens under load. Rushing the lowering phase throws away half the stimulus.`,
      why: `The elbow flexion arc puts the ${p} under tension through its full range. With a supinated (underhand) grip, the forearm rotation adds a secondary function the ${p} is designed for, making curls uniquely effective.`,
      setup: `Stand tall, pin your elbows to your sides. Grab the ${equipment.toLowerCase()} with a shoulder-width underhand grip. Brace your core so only your forearms move.`,
      movement: `Initiate from the ${p} — not from your wrists or shoulders. The upper arm stays fixed. Drive the weight up, squeeze at the top, then lower with control.`,
      feel: `You should feel a deep burn in the front of your upper arm. If your shoulder or forearm is dominating, you're probably swinging or using too much weight.`,
      mistake: `Swinging the torso to heave the weight up. This shifts load to your lower back and delts. Keep your upper arms pinned — only your forearms move.`,
    },
    extension_elbow: {
      concentric: `As you straighten your arm (or push the weight away), the ${p} fires and shortens, driving your elbow toward full extension. The lockout at the end is pure tricep output.`,
      eccentric: `As you bend the elbow (lowering toward your skull on a skull crusher, or descending in a dip), the ${p} lengthens under load. Overhead variations create the biggest eccentric stretch because the long head spans both joints.`,
      why: `All pushing and straightening movements require elbow extension — the ${p}'s primary job. The ${p} makes up roughly two-thirds of your upper arm, so developing it adds more arm size than bicep work alone.`,
      setup: `Position yourself so the ${p} starts in a stretched position. For overhead work, keep elbows pointing forward and close together.`,
      movement: `Drive from elbow extension — push the weight away by straightening your arm. Think "push my elbow straight" rather than "move the weight." Lock out fully at the top.`,
      feel: `You should feel the back of your upper arm working — the horseshoe shape should harden and contract. Avoid letting elbows flare wide, which shifts load to the chest.`,
      mistake: `Letting elbows flare out or cut the range short. Flaring shifts work to shoulders/chest. Partial reps skip the deepest stretch where the long head grows most.`,
    },
    press_horizontal: {
      concentric: `As you press the weight away from your chest, the ${p} shortens and contracts — driving the arms from a bent, lowered position to full extension. The ${p} works hardest in the mid-range to lockout.`,
      eccentric: `Lowering the bar (or dumbbells) to your chest stretches the ${p} under load. This bottom-range stretch is a key growth stimulus — don't bounce the bar off your chest; control the descent.`,
      why: `The horizontal pushing motion is perfectly aligned with the ${p}'s fiber direction — from the sternum and clavicle outward. Both shoulder flexion and horizontal adduction (bringing arms together) happen simultaneously, which is exactly what the ${p} does.`,
      setup: `Lie flat (or at the target angle), retract and depress your shoulder blades into the bench, plant your feet. Grip the ${equipment.toLowerCase()} at roughly 1.5× shoulder width.`,
      movement: `Lower with control to your chest or chin level, then press explosively. Think "push the bar away from you" or "push yourself away from the bar." Keep wrists stacked over elbows.`,
      feel: `You should feel a stretch across your chest at the bottom and a squeeze when your arms come together at the top. If your shoulder is the limiting factor, check grip width and elbow angle.`,
      mistake: `Flaring elbows to 90° (too wide) puts massive stress on the shoulder joint and reduces ${p} involvement. Aim for elbows ~45–75° from your torso.`,
    },
    fly: {
      concentric: `As your arms come together in front of you, the ${p} performs horizontal adduction — bringing the upper arms toward the midline of the body. The muscle fibers slide closer together.`,
      eccentric: `Opening your arms wide stretches the ${p} fibers across a longer range than any pressing movement. This deep stretch under load is the fly's biggest advantage for hypertrophy.`,
      why: `The ${p}'s primary action is horizontal adduction (bringing arms together). Flies isolate this motion without triceps helping to lock out, which keeps tension on the ${p} through the full arc.`,
      setup: `Set up with a slight bend in the elbows (maintain this angle throughout — it reduces elbow stress). Use a light enough weight that you can fully control the arc.`,
      movement: `Think "hugging a barrel" — arc the arms in a wide circle rather than bending them. Lead with your elbows on the way down, and squeeze the ${p} at the peak.`,
      feel: `A deep stretch across your chest at the bottom. If you feel it in your biceps or shoulder instead, reduce the weight and focus on form.`,
      mistake: `Turning a fly into a press by bending the elbows more as the weight gets heavy. The moment you do that you've lost the isolation — go lighter.`,
    },
    row: {
      concentric: `Pulling the weight toward your torso involves the ${p} retracting the scapula and extending the shoulder. The ${p} shortens as your elbow drives back past your torso.`,
      eccentric: `Letting the weight back out with control stretches the ${p} fibers and allows the scapula to protract. This controlled lowering builds thickness in the back.`,
      why: `Rows align the pulling motion with the ${p}'s fiber direction — running diagonally across the back from the lumbar/pelvis up to the upper arm. The more horizontal the pull, the more the ${p} works.`,
      setup: `Hinge at the hips with a neutral spine (not rounded). Keep the ${equipment.toLowerCase()} below your shoulders at the start. Engage your lats before pulling.`,
      movement: `Drive your elbows back (not up). Think "elbow to pocket" for lower-back engagement or "elbow to ear" for upper-back. Squeeze the muscle at the top of the pull.`,
      feel: `A tight squeeze between your shoulder blades at the peak and a stretch across your back at full arm extension. If you feel it mainly in your biceps, you're pulling with your arms too much.`,
      mistake: `Rounding the lower back and using momentum to heave the weight. A rounded spine under load is a spinal injury risk. Brace the core and move only your arms and shoulders.`,
    },
    pulldown: {
      concentric: `As you pull the bar (or cable) down toward your collarbone, the ${p} adducts and extends the shoulder — pulling your upper arms down and back. The lats and ${p} shorten together.`,
      eccentric: `Allowing the bar to rise back to full arm extension stretches the entire back musculature under tension. Control this phase and feel the full stretch in your sides.`,
      why: `The pulldown angle closely mimics the ${p}'s line of pull — the fibers run from the outer edges of the back to the upper arm and are maximally loaded when the arms are overhead or angled away from the torso.`,
      setup: `Sit with thighs under the pads, lean back very slightly (~10–15°). Grab the bar just wider than shoulder-width with an overhand grip.`,
      movement: `Initiate by depressing your shoulders (push them down, away from your ears) before bending your elbows. Think "elbows to your back pockets."`,
      feel: `You should feel the sides of your back engaging — the "wings" under your armpits. If you feel it mainly in your biceps or forearms, try a false grip or focus on leading with your elbows.`,
      mistake: `Pulling with your arms instead of your back. If your biceps fatigue first, you're arm-pulling. Initiate with shoulder depression and think of your hands as hooks.`,
    },
    press_vertical: {
      concentric: `Pressing overhead contracts the ${p} as you drive your arms upward and outward, extending the shoulder joint. The deltoids are the prime mover through the full arc.`,
      eccentric: `Lowering the weight back to shoulder height stretches the deltoids and engages the rotator cuff as stabilizers. Control the descent.`,
      why: `Vertical pressing loads the deltoid in its primary function — shoulder abduction and flexion. The overhead position removes chest involvement and forces the delts to handle the full load.`,
      setup: `Stand tall or sit upright with core braced. Hold the ${equipment.toLowerCase()} at shoulder height with elbows at ~90°. Keep your lower back from arching.`,
      movement: `Press straight up (or slightly forward for natural shoulder mechanics). At the top, shrug slightly to elevate the scapula — this full overhead position is important for shoulder health.`,
      feel: `The outer and front of your shoulders should burn. If your traps dominate, you're shrugging too early. If lower back aches, reduce weight or improve core bracing.`,
      mistake: `Letting the lower back hyperextend to compensate for poor shoulder mobility. Brace the core and keep the ribcage down throughout the press.`,
    },
    raise: {
      concentric: `Raising the weight — whether to the side (lateral), front, or rear — abducts or flexes the shoulder, contracting the target portion of the deltoid.`,
      eccentric: `Slowly lowering back down under control keeps the deltoid under tension through the full range. This controlled eccentric is key for shoulder cap development.`,
      why: `Raises isolate specific heads of the deltoid by changing the plane of movement. Lateral raises hit the medial (middle) head; front raises target the anterior head; rear raises target the posterior head.`,
      setup: `Use a lighter weight than you think. The deltoid is a relatively small muscle and raises are pure isolation — going heavy causes the traps and momentum to take over.`,
      movement: `Lead with the elbow, not the hand. Keep a slight bend in the arm. Raise to parallel (not above shoulder height for lateral raises) in a smooth arc.`,
      feel: `A burning sensation at the top and outer part of your shoulder. If your traps are cramping, you're shrugging. If your bicep works more than your delt, you're using too much elbow bend.`,
      mistake: `Shrugging the traps to assist the raise. This shifts work away from the target delt head. Think "keep shoulders away from ears" throughout the movement.`,
    },
    squat: {
      concentric: `Driving up from the bottom of the squat, the ${p} extend the knee and hip simultaneously, generating force against the floor. The quads are maximally active through knee extension.`,
      eccentric: `Descending into the squat puts the ${p} and glutes under the highest load — the muscles lengthen under bodyweight and external load. A slow, controlled descent builds strength at the bottom.`,
      why: `The squat's knee flexion and hip flexion angles load the ${p} exactly at the range they're designed to work — the knee extensors are under maximum stretch at the bottom position.`,
      setup: `Feet shoulder-width or slightly wider, toes turned out 15–30°. Bar across the traps or front deltoids (depending on variation). Brace the core before descending.`,
      movement: `Send hips back and down, not just down. Keep your chest up and knees tracking over your toes. Drive through your full foot — heels and toes — on the way up.`,
      feel: `A deep burn in the front of the thighs (quads) and the glutes at the bottom. If your lower back is the main fatigue point, your hips may be rising too fast on the way up.`,
      mistake: `Knees caving inward (valgus collapse) on the way up. Push your knees out to match your toe angle throughout the entire movement.`,
    },
    hinge: {
      concentric: `Driving the hips forward to extend them, the ${p} (hamstrings and glutes) contract and shorten, pulling the torso back to upright. The spine maintains its neutral position throughout.`,
      eccentric: `Hinging the hips back stretches the ${p} and hamstrings under load. This is the most important phase for posterior chain development — control it and feel the hamstrings pull.`,
      why: `Hip hinges load the ${p} and hamstrings in hip extension — their primary function. The forward lean places the spine under a lever load, making the posterior chain work against significant resistance.`,
      setup: `Stand with feet hip-width. With a barbell, grip just outside your legs. Keep the bar close to your body (it should drag up your shins for conventional deadlifts). Brace hard before lifting.`,
      movement: `"Push the floor away" on the concentric rather than "pull the weight up." Maintain a neutral spine — don't round your lower back. Drive hips through at the top.`,
      feel: `You should feel a deep stretch in the back of your thighs on the way down, and glute contraction at lockout. Rounding lower back means your erectors are compensating — reduce weight.`,
      mistake: `Rounding the lumbar spine. This shifts load from the ${p} and glutes to the spinal erectors in a compromised position — a frequent injury mechanism. Brace the core and maintain a neutral spine.`,
    },
    lunge: {
      concentric: `Pushing through the front heel to stand back up extends the hip and knee, contracting the ${p} and glutes together. The split position forces unilateral (single-leg) loading.`,
      eccentric: `Stepping forward and lowering the back knee toward the ground stretches the ${p} and hip flexors under the body's full load. This controlled descent builds single-leg strength.`,
      why: `Lunges expose and correct bilateral asymmetry — they train each leg independently, so a stronger side cannot compensate for a weaker one. They also train balance and hip stability alongside the ${p}.`,
      setup: `Step far enough forward that your front shin stays roughly vertical at the bottom. Keep your torso upright and core braced.`,
      movement: `Lower the back knee toward the floor with control. Drive through the front heel to return — don't push off your back foot or you'll shorten the range.`,
      feel: `A deep stretch in the back hip (hip flexor) and a squeeze in the front quad and glute. If your front knee falls inward, focus on pressing it out over the second toe.`,
      mistake: `Step too short, causing the front knee to shoot far past the toes. A small step also reduces hip and glute involvement and puts excess force on the knee.`,
    },
    hip_thrust: {
      concentric: `Driving the hips upward from the bench creates maximal hip extension, squeezing the ${p} at the very top. The thrust pattern loads the glutes at a long muscle length through a full range.`,
      eccentric: `Lowering the hips back toward the floor stretches the ${p} fibers under load. Full range hip thrusts (going all the way down) produce more hypertrophy than partial reps.`,
      why: `Hip thrusts are uniquely effective for the ${p} because the resistance is highest at full hip extension (the top), where the ${p} are fully contracted — unlike squats where load drops off at lockout.`,
      setup: `Upper back against a bench, bar over the hips with a pad. Feet planted flat, about hip-width, feet far enough forward that shins are vertical at the top.`,
      movement: `Drive hips straight up, not forward. Squeeze the ${p} hard at the top and hold for a beat. Keep your chin tucked — don't hyperextend the neck.`,
      feel: `An intense contraction in the ${p} at the top. If your lower back is working harder than your glutes, tuck your pelvis slightly at the top.`,
      mistake: `Hyperextending the lower back at the top. This is actually lumbar extension, not hip extension — you've gone past the glute's peak contraction. Stop when your body forms a straight line from shoulders to knees.`,
    },
    calf_raise: {
      concentric: `Rising onto your toes (plantarflexion) contracts the ${p} — pushing the heel away from the ground. The peak squeeze at the very top is where the ${p} is fully shortened.`,
      eccentric: `Lowering the heel as far below the step as possible stretches the ${p} fibers under tension. The calf is notoriously stubborn and responds best to deep full-range eccentric work.`,
      why: `The calf (gastrocnemius + soleus) is a postural muscle that fires constantly during walking — making it highly fatigue-resistant. Overloading with heavy weight and slow eccentrics are the main growth stimuli.`,
      setup: `Stand on a step or platform so your heels can drop below it. Use the ${equipment.toLowerCase()} for load. Keep a slight bend in the knee for soleus work, or straight leg for gastrocnemius.`,
      movement: `Full range every rep: heels drop all the way down, then rise all the way up. Partial calf raises are one of the most common wasted reps in the gym.`,
      feel: `A burning stretch in the lower leg at the bottom and a tight squeeze at the top. Calves can tolerate very high rep ranges — 15–25 reps per set is often appropriate.`,
      mistake: `Partial reps (never dropping the heel) or bouncing at the bottom. The calf needs to be fully stretched to get a strong reflex contraction — short-range reps don't provide this stimulus.`,
    },
    plank: {
      concentric: `There is no movement — the ${p} contract isometrically (without changing length) to resist spinal extension, flexion, and rotation.`,
      eccentric: `The challenge is sustaining tension throughout — as fatigue sets in, the core wants to collapse. Maintaining position is active work, not passive holding.`,
      why: `The ${p} stabilizes the spine during virtually every compound lift. A strong plank position directly transfers to better form in deadlifts, squats, overhead press, and rows.`,
      setup: `Forearms on the floor (elbows under shoulders), body in a straight line from head to heels. Squeeze your glutes and engage your core — don't let your hips rise or sag.`,
      movement: `This is a static hold. Push your elbows into the floor, think about "pulling your elbows toward your feet" to activate the lats. Breathe steadily.`,
      feel: `Tension throughout your entire mid-section — not just the front. If you only feel your lower back or shoulders, re-check alignment.`,
      mistake: `Letting the hips rise or sag. A sagging hips plank loads the lower back instead of the core. A high-hipped plank is resting, not working.`,
    },
    crunch: {
      concentric: `Shortening the distance between your ribcage and pelvis by curling the spine — the ${p} contract and shorten to flex the lumbar spine.`,
      eccentric: `Lowering back down with control as the ${p} lengthen — don't let your head fall to the floor. Controlled eccentric keeps the abs under tension.`,
      why: `The ${p} run vertically from the pelvis to the ribcage. Their primary function is spinal flexion — the exact motion in a crunch. Planks build stabilization endurance; crunches build flexion strength.`,
      setup: `Lie flat, knees bent. Hands behind your head or crossed on your chest — don't pull on your neck. Press your lower back into the floor.`,
      movement: `Curl your ribcage toward your pelvis, not your head toward your knees. The movement is short — your shoulder blades should only clear the floor by a few inches.`,
      feel: `The burn should be directly in your abs — the center of your stomach. Neck or lower back pain means you're pulling with your neck or hyperextending.`,
      mistake: `Pulling on your neck or using momentum to sit all the way up. True crunch range of motion is small — quality contraction beats large range here.`,
    },
    generic: {
      concentric: `During the lifting/working phase of this movement, the ${p} shortens and contracts to produce force against the resistance.`,
      eccentric: `During the lowering/returning phase, the ${p} lengthens under load — this phase is often undertrained but is critical for muscle growth. Control it for 2–3 seconds.`,
      why: ex.is_compound
        ? `This compound movement loads the ${p} while multiple joints move together, allowing heavier loads and greater total muscle recruitment${sec.length ? ` with support from ${joinParts(sec)}` : ''}.`
        : `The single-joint isolation nature of this exercise keeps tension focused on the ${p} throughout the range, without other muscle groups sharing the load.`,
      setup: `Set yourself up so your body feels balanced, brace your torso, and position the ${equipment.toLowerCase()} so the movement starts under control.`,
      movement: `Move through a full, controlled range of motion. Think about driving the weight with ${p} rather than just swinging it. Avoid cutting the range short.`,
      feel: `You should mostly feel this in the ${p}${sec.length ? `, with some support from ${joinParts(sec).toLowerCase()}` : ''}. Sharp or joint pain means stop — that's not the muscle working.`,
      mistake: `Using too much momentum or shortening the range of motion. Both rob the ${p} of the stimulus you're there to provide.`,
    },
  };

  const pd = phaseDescriptions[pattern];

  return {
    howTo: ex.description
      ? ex.description
      : `Use ${equipment.toLowerCase()} with full control through the entire range of motion. Move deliberately — the goal is to load the ${p}, not just move the weight.`,
    hits: `Primarily targets the ${p}${supportText}. ${ex.is_compound ? `As a compound movement, multiple muscle groups contribute — but ${p} is the prime mover.` : `As an isolation movement, it keeps tension concentrated on the ${p}.`}`,
    why: pd.why,
    setup: pd.setup,
    movement: pd.movement,
    feel: pd.feel,
    mistake: pd.mistake,
    concentric: pd.concentric,
    eccentric: pd.eccentric,
  };
}

function getExerciseVideoUrl(exerciseName: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${exerciseName} proper form`)}`;
}


function compactGoalProgressText(
  userProfile: UserProfile,
  goalConfig: import('../hooks/useMetaData').GoalConfig,
): string | null {
  const { goal, goalDetails, physicalStats } = userProfile;
  const isWeightGoal = new Set(goalConfig.weight_goals).has(goal);
  if (isWeightGoal && goalDetails.targetWeightLbs) {
    const start = goalDetails.startWeightLbs ?? physicalStats.weightLbs;
    const current = physicalStats.weightLbs;
    const target = goalDetails.targetWeightLbs;
    const total = Math.abs(start - target);
    const done = Math.abs(start - current);
    const pct = total > 0 ? Math.round(Math.min(1, Math.max(0, done / total)) * 100) : 0;
    return `${pct}% · ${current} / ${target} lbs`;
  }

  if (goalDetails.timelineWeeks) {
    const startDate = goalDetails.goalStartedAt ? new Date(goalDetails.goalStartedAt) : new Date();
    const weeksElapsed = Math.max(0, (Date.now() - startDate.getTime()) / (7 * 24 * 60 * 60 * 1000));
    const pct = Math.round(Math.min(1, weeksElapsed / goalDetails.timelineWeeks) * 100);
    return `${pct}% · week ${Math.round(weeksElapsed)} / ${goalDetails.timelineWeeks}`;
  }

  return null;
}

function inferGroup(text: string): string {
  const blob = text.toLowerCase();
  if (/(bike|cycle|cycling|spin|run|running|jog|treadmill|cardio|conditioning|hiit)/.test(blob)) return 'Cardio';
  if (/(bench|chest|press|fly|push[- ]?up)/.test(blob)) return 'Chest';
  if (/(row|pull|lat|back|deadlift|pull[- ]?up)/.test(blob)) return 'Back';
  if (/(squat|lunge|leg|quad|hamstring|calf)/.test(blob)) return 'Legs';
  if (/(shoulder|overhead|lateral raise|rear delt)/.test(blob)) return 'Shoulders';
  if (/(bicep|tricep|curl|extension)/.test(blob)) return 'Arms';
  if (/(core|ab|plank|crunch)/.test(blob)) return 'Core';
  if (/(glute|hip thrust)/.test(blob)) return 'Glutes';
  return 'Other';
}

function buildAvailability(
  workoutPlan: WorkoutPlan,
  history: Awaited<ReturnType<typeof loadWorkoutHistory>>,
): { items: AvailabilityItem[] } {
  const counts: Record<string, number> = {
    Chest: 0,
    Back: 0,
    Legs: 0,
    Shoulders: 0,
    Arms: 0,
    Core: 0,
    Glutes: 0,
    Cardio: 0,
  };

  for (const day of (workoutPlan.days ?? [])) {
    for (const ex of (day.exercises ?? [])) {
      const group = inferGroup(`${day.focus} ${ex.name}`);
      if (group in counts) counts[group] += 1;
    }
  }

  const maxCount = Math.max(1, ...Object.values(counts));
  const items = Object.entries(counts)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([label, value]) => ({
      label,
      pct: Math.max(10, Math.round((value / maxCount) * 100 / 5) * 5),
    }));

  return { items };
}

// ─────────────────────────────────────────────────────────────────────────────

export default function HomeScreen({ authToken, userProfile, planRefreshKey = 0, isWorkoutUpdating = false, isNutritionUpdating = false, trainerNote: trainerNoteProp = null, nutritionistNote: nutritionistNoteProp = null, supplementStack: supplementStackProp = [], onSignOut, onEditGoal: _onEditGoal, onEditWorkout: _onEditWorkout, onEditMealPlan: _onEditMealPlan, onEditThemes, onEditBody, onStartWorkout, onViewProgress: _onViewProgress, onViewAccount, onProfileUpdate, onBackendSync, onSaveProfile, onWeeklyRefresh, onCancelPlanGen, onSwitchDayRegen: _onSwitchDayRegen }: HomeScreenProps) {
  const insets = useSafeAreaInsets();
  const meta = useMetaData();
  // Merge user's custom foods into allFoods so lookups work everywhere
  const allFoodsWithCustom = useMemo(() => {
    const custom = (userProfile?.customFoods ?? []).filter(
      cf => !meta.allFoods.some(f => f.name.toLowerCase() === cf.name.toLowerCase()),
    );
    return custom.length ? [...meta.allFoods, ...custom] : meta.allFoods;
  }, [meta.allFoods, userProfile?.customFoods]);

  /** The food picker in MealEditModal should only show foods the user
   *  actually has — their selected pantry (`foodsAvailable`) plus any
   *  custom foods they've added. We rebuild the meta food categories
   *  restricted to that set so the picker can't offer items the user
   *  doesn't own. Custom foods land in a synthetic "My Custom Foods"
   *  category so they're visible and easy to find. */
  const userFoodCategories = useMemo(() => {
    const available = new Set((userProfile?.foodsAvailable ?? []).map(n => n.toLowerCase()));
    // Filter every seeded category down to only selected foods.
    const filteredSeed = meta.foodCategories
      .map(cat => ({
        ...cat,
        foods: cat.foods.filter(f => available.has(f.name.toLowerCase())),
      }))
      .filter(cat => cat.foods.length > 0);

    // Synthetic custom-foods category so user-added items are visible
    // even if they aren't in the pantry list yet.
    const customs = userProfile?.customFoods ?? [];
    if (customs.length === 0) return filteredSeed;
    const customCat = {
      key: 'custom',
      label: 'My Custom Foods',
      icon: 'star-outline',
      foods: customs.map(cf => ({
        name: cf.name,
        category: 'custom',
        unit: cf.unit ?? '1 serving',
        calories: cf.calories ?? 0,
        protein: cf.protein ?? 0,
        carbs: cf.carbs ?? 0,
        fat: cf.fat ?? 0,
      })),
    } as (typeof filteredSeed)[number];
    return [customCat, ...filteredSeed];
  }, [meta.foodCategories, userProfile?.foodsAvailable, userProfile?.customFoods]);
  const theme = getTheme(userProfile?.themePreference);
  const themeColors = theme.colors;
  const workoutPalette = theme.sections.workout;
  const mealPalette = theme.sections.meals;
  const plannerPalette = theme.sections.planner;
  const aiPalette = theme.sections.ai;

  const [workoutPlan, setWorkoutPlan]     = useState<WorkoutPlan | null>(null);
  const [nutritionPlansByDate, setNutritionPlansByDate] = useState<Record<string, DailyNutritionPlan>>({});
  // Bottom-tab navigation. All five tabs render inline content within
  // HomeScreen's body — true SPA behavior. The bottom nav stays pinned
  // and never disappears no matter which tab is active.
  const [activeTab, setActiveTabRaw]      = useState<'friends' | 'workout' | 'meals' | 'progress' | 'profile'>('workout');
  const progressFade = useRef(new Animated.Value(0)).current;
  const setActiveTab = useCallback((tab: typeof activeTab) => {
    setActiveTabRaw(tab);
    if (tab === 'progress') {
      progressFade.setValue(0);
      Animated.timing(progressFade, { toValue: 1, duration: 300, useNativeDriver: true }).start();
    }
    AsyncStorage.setItem('lastActiveTab', tab).catch(() => {});
  }, []);
  useEffect(() => {
    AsyncStorage.getItem('lastActiveTab').then(saved => {
      const tab = saved === 'goals' ? 'friends' : saved;
      if (tab && ['friends', 'workout', 'meals', 'progress', 'profile'].includes(tab)) {
        setActiveTabRaw(tab as typeof activeTab);
        if (tab === 'progress') progressFade.setValue(1);
      }
    }).catch(() => {});
  }, []);
  // Sub-tab inside each main tab.
  // Workouts: plan | exercises | muscles | equipment
  // Meals:    plan | foods     | supplements | macros
  const [workoutSubTab, setWorkoutSubTab] = useState<'plan' | 'library' | 'exercises' | 'muscles' | 'equipment' | 'history'>('plan');
  const [workoutHistoryList, setWorkoutHistoryList] = useState<WorkoutSession[]>([]);
  const [workoutHistorySummaries, setWorkoutHistorySummaries] = useState<any[]>([]);
  const [expandedWorkoutHistoryId, setExpandedWorkoutHistoryId] = useState<string | null>(null);
  const [mealsSubTab,   setMealsSubTab]   = useState<'plan' | 'foods' | 'supplements' | 'macros' | 'history'>('plan');
  const [socialSubTab, setSocialSubTab] = useState<'feed' | 'friends' | 'challenges'>('feed');
  const [feedItems, setFeedItems] = useState<FeedItem[]>([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const [shareWorkoutData, setShareWorkoutData] = useState<import('../services/api').WorkoutPostSummary | null>(null);
  const [expandedHistoryDate, setExpandedHistoryDate] = useState<string | null>(null);
  const [commonMeals, setCommonMeals] = useState<any[]>([]);
  // gutHealthToday removed — NutritionCard now computes gut health from plan data
  const [showGroceryList, setShowGroceryList] = useState(false);
  const [feedbackSettings, setFeedbackSettings] = useState({ hapticsEnabled: true, soundsEnabled: true, vibrationEnabled: true });
  const [reminderEnabled, setReminderEnabled] = useState(false);
  const [showEmailBanner, setShowEmailBanner] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailError, setEmailError] = useState('');
  useEffect(() => {
    if (!authToken) return;
    let cancelled = false;
    (async () => {
      try {
        const dismissed = await AsyncStorage.getItem(EMAIL_BANNER_DISMISS_KEY);
        if (dismissed) {
          const ts = parseInt(dismissed, 10);
          if (Date.now() - ts < 7 * 24 * 60 * 60 * 1000) return;
        }
        const me: any = await getMe(authToken);
        if (cancelled) return;
        if (me?.email && EMAIL_RE.test(me.email)) return;
        setShowEmailBanner(true);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [authToken]);
  const dismissEmailBanner = useCallback(async () => {
    setShowEmailBanner(false);
    try { await AsyncStorage.setItem(EMAIL_BANNER_DISMISS_KEY, String(Date.now())); } catch {}
  }, []);

  // First-mount tutorial gate. Runs once when the user lands on
  // Tutorial auto-show was lifted to app/index.tsx so the Account
  // modal's "Show tutorial again" button can flip it directly. This
  // screen is no longer responsible for the tutorial — see the app
  // root for the state + render.
  const handleSaveEmail = useCallback(async () => {
    const trimmed = newEmail.trim();
    if (!EMAIL_RE.test(trimmed)) { setEmailError('Enter a valid email address'); return; }
    setEmailSaving(true);
    setEmailError('');
    try {
      await updateEmail(authToken, trimmed);
      setShowEmailModal(false);
      setShowEmailBanner(false);
      setNewEmail('');
      try { await AsyncStorage.removeItem(EMAIL_BANNER_DISMISS_KEY); } catch {}
    } catch (e: any) {
      setEmailError(e?.message || 'Failed to update email');
    } finally {
      setEmailSaving(false);
    }
  }, [authToken, newEmail]);

  useEffect(() => { import('../utils/feedback').then(f => f.loadSettings()).then(setFeedbackSettings).catch(() => {}); }, []);
  useEffect(() => {
    if (mealsSubTab === 'foods' && authToken) {
      import('../services/api').then(({ getCommonMeals }) =>
        getCommonMeals(authToken).then(r => setCommonMeals(r.meals || [])).catch(() => {})
      );
    }
  }, [mealsSubTab, authToken]);
  // gutHealthToday fetch removed — NutritionCard computes from plan data
  // menuOpen state removed — the side menu modal is gone. Profile tab handles it.
  // Cached health score for the Profile tab. Loaded once on mount;
  // re-loaded when the user changes tabs to profile so a fresh scan
  // shows up without a full reload.
  const [profileHealthScore, setProfileHealthScore] = useState<import('../types').HealthScoreResult | null>(null);
  useEffect(() => {
    if (activeTab === 'profile') {
      loadHealthScore().then(setProfileHealthScore).catch(() => setProfileHealthScore(null));
      // Lightweight friend-count poll for the Profile entry row.
      if (authToken) {
        (async () => {
          try {
            const { listFriends } = await import('../services/api');
            const list = await listFriends(authToken);
            setFriendCount(list.friends.length);
            setPendingFriendCount(list.pending.filter(p => p.direction === 'incoming').length);
          } catch {
            // silent — entry row falls back to "Friends"
          }
        })();
      }
    }
    if (activeTab === 'friends' && authToken) {
      setFeedLoading(true);
      getSocialFeed(authToken).then(r => setFeedItems(r.items)).catch(() => {}).finally(() => setFeedLoading(false));
    }
    // Auto-close the inline exercise library when leaving the workout tab.
    if (activeTab !== 'workout') {
      setShowExerciseLibrary(false);
    }
  }, [activeTab, authToken]);
  const [showCheckin, setShowCheckin]     = useState(false);
  /** True while `loadPlans` is mid-flight. Prevents concurrent plan reads
      from clobbering each other if an effect re-fires rapidly. */
  const loadPlansInFlightRef = useRef(false);
  /** Set when a trigger arrives while `loadPlans` is already running.
      On finish we check this flag and fire once more so the final state
      reflects the MOST RECENT trigger, not the one that happened to be
      mid-flight when the regen wrote new data. Without this, a
      goal-change regen (which bumps `planRefreshKey` after the first
      load has already started with stale cache) gets swallowed by the
      early-return guard and the UI sticks on the old plan. */
  const loadPlansRerunPendingRef = useRef(false);
  /** Latest profile seen by the effect. The post-finish rerun uses
      this so it always operates on the newest profile snapshot, even
      if several triggers queued up. */
  const loadPlansLatestProfileRef = useRef<UserProfile | null>(null);
  /** When true, the next `loadPlans` run skips backend hydration and trusts
      AsyncStorage. Set by handleSwitchDayRegen (via applyPlanResult) because
      the client-side pin-patch writes a plan to AsyncStorage that the backend
      DB doesn't have yet — fetching from the backend would overwrite the pin. */
  const skipBackendHydrationOnceRef = useRef(false);
  const [expandedDay, setExpandedDay]     = useState<number>(-1);
  const [switchDayIdx, setSwitchDayIdx]   = useState<number>(-1);
  // Which plan-day indices are currently regenerating after a Switch-Day tap.
  // Surfaced to the DayCard so it can render a shimmer overlay while the
  // deterministic planner call is in flight. Stored as a Set so future multi-
  // day flows (e.g. "regen all") work without a refactor.
  const [regeneratingDayIdxs, setRegeneratingDayIdxs] = useState<Set<number>>(new Set());
  // Focus the user just picked in Switch Day. Surfaced in the full-screen
  // regen overlay so they see "Rebuilding week around Push" while waiting.
  const [regenSelectedFocus, setRegenSelectedFocus] = useState<string | null>(null);
  // Shown as a full-screen overlay while the "Switch Day" flow regenerates
  // the whole week (chosen day + ripple-sweep on conflicting neighbors).
  // Kept separate from isWorkoutUpdating so the big plan-gen overlay
  // doesn't trigger just because of a single day swap.
  const [showAllThemes, setShowAllThemes] = useState(false);
  const [showExerciseLibrary, setShowExerciseLibrary] = useState(false);
  // Plan-view exercise swap — when a user taps "Swap" on a WorkoutCard row
  // in the plan, this captures the target so the picker modal can open
  // and mutate the plan_json on selection.
  const [swapExerciseState, setSwapExerciseState] = useState<{
    workout: WorkoutDay;
    exerciseIndex: number;
    exerciseName: string;
  } | null>(null);
  const [libraryActiveTab, setLibraryActiveTab] = useState<'exercises' | 'muscles'>('exercises');
  const [showSupplementLibrary, setShowSupplementLibrary] = useState(false);
  const [selectedSupplement, setSelectedSupplement] = useState<SupplementEntry | null>(null);
  const [suppLibSearch, setSuppLibSearch] = useState('');
  const [suppLibCategory, setSuppLibCategory] = useState<string>('all');
  const [suppAiQuery, setSuppAiQuery] = useState('');
  const [suppAiLoading, setSuppAiLoading] = useState(false);
  const [suppAiResult, setSuppAiResult] = useState<SupplementEntry | null>(null);
  const [suppAiNotFound, setSuppAiNotFound] = useState(false);
  const [exerciseLibraryLoading, setExerciseLibraryLoading] = useState(false);
  const [exerciseLibrary, setExerciseLibrary] = useState<ExerciseLibraryItem[]>([]);
  const [selectedExercise, setSelectedExercise] = useState<ExerciseLibraryItem | null>(null);
  const [selectedMuscle, setSelectedMuscle] = useState<MuscleEntry | null>(null);
  const [muscleRegionFilter, setMuscleRegionFilter] = useState<string>('all');
  const [exerciseSearch, setExerciseSearch] = useState('');
  // AI exercise search state — mirrors the food search flow. Results live
  // next to the local library list so users can fall through to AI when
  // the local library doesn't have what they want.
  const [aiExerciseResults, setAiExerciseResults] = useState<import('../services/api').AIExerciseResult[]>([]);
  const [aiExerciseLoading, setAiExerciseLoading] = useState(false);
  const handleAiExerciseSearch = useCallback(async () => {
    const q = exerciseSearch.trim();
    if (!q || !authToken) return;
    setAiExerciseLoading(true);
    try {
      const { searchExerciseAI } = await import('../services/api');
      // Build the exclude list from the user's current library so AI
      // doesn't waste a slot returning something they already have.
      const exclude = exerciseLibrary.map(e => e.name).filter(Boolean);
      const res = await searchExerciseAI(authToken, {
        query: q,
        equipment: userProfile?.equipment,
        injuries: (userProfile?.injuryEntries ?? []).filter(i => i.status !== 'resolved').map(i => i.bodyPart || i.description),
        exclude,
      });
      setAiExerciseResults(res.results ?? []);
      if ((res.results ?? []).length === 0) {
        Alert.alert('No results', `AI couldn't find a good match for "${q}".`);
      }
    } catch (e: any) {
      Alert.alert('Search failed', e?.message ?? 'Could not reach the AI server.');
    } finally {
      setAiExerciseLoading(false);
    }
  }, [exerciseSearch, authToken, userProfile, exerciseLibrary]);
  const [exerciseMuscleFilter, setExerciseMuscleFilter] = useState<string>('all');
  const [exerciseEquipmentFilter, setExerciseEquipmentFilter] = useState<string>('all');
  const [showTrainerModal, setShowTrainerModal] = useState(false);
  const [coachMode, setCoachMode] = useState<'trainer' | 'nutritionist'>('trainer');
  const [chatTopic, setChatTopic] = useState<string | null>('general');
  const [trainerInput, setTrainerInput] = useState('');
  const [trainerLoading, setTrainerLoading] = useState(false);
  const trainerAbortRef = useRef<AbortController | null>(null);
  const [isChatPlanUpdating, setIsChatPlanUpdating] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<PendingPlanUpdate | null>(null);
  const [pendingInjuries, setPendingInjuries] = useState<InjuryEntry[] | null>(null);
  const chatProgressAnim = useRef(new Animated.Value(0)).current;
  const [attachedImage, setAttachedImage] = useState<{ base64: string; uri: string } | null>(null);
  const [workoutChat, setWorkoutChat] = useState<TrainerChatMessage[]>([]);
  const [workoutUpdateSummary, setWorkoutUpdateSummary] = useState<string | null>(null);
  const [nutritionUpdateSummary, setNutritionUpdateSummary] = useState<string | null>(null);

  // Plan generation progress.
  // This is a client-side time-based animation — we don't get real progress
  // from the backend LLM call. To avoid the "stuck at 95%" UX where the bar
  // visually implies completion while we're still waiting, we:
  //   1. Cap at 88% so the user never sees a near-full bar that isn't
  //      actually near-full.
  //   2. Jump to 100% only when the real updating flag goes false.
  //   3. Use a longer time constant so the bar progresses steadily through
  //      its plausible range instead of racing to the cap early.
  const [planProgress, setPlanProgress] = useState(0);
  const [planStep, setPlanStep] = useState('');
  // Splash → home cross-fade: the plan-regen overlay has historically
  // hard-cut when `isWorkoutUpdating && isNutritionUpdating` flips false.
  // We keep the overlay mounted for a 400ms fade-out by tracking our own
  // `splashMounted` state that lags behind the prop. Opacity is driven
  // by `splashOpacity` and interpolated on the Animated.View below.
  const splashOpacity = useRef(new Animated.Value(0)).current;
  const [splashMounted, setSplashMounted] = useState(false);
  const bothUpdating = !!(isWorkoutUpdating && isNutritionUpdating);
  useEffect(() => {
    if (bothUpdating) {
      setSplashMounted(true);
      Animated.timing(splashOpacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
      return;
    }
    // Flag flipped off — fade out, then unmount.
    Animated.timing(splashOpacity, { toValue: 0, duration: 400, useNativeDriver: true }).start(({ finished }) => {
      if (finished) setSplashMounted(false);
    });
  }, [bothUpdating, splashOpacity]);
  useEffect(() => {
    if (!(isWorkoutUpdating || isNutritionUpdating)) {
      // When flags flip off, briefly snap to 100% so the bar fills before
      // the overlay dismisses — feels like a real completion.
      setPlanProgress(100);
      setPlanStep('Done!');
      const t = setTimeout(() => { setPlanProgress(0); setPlanStep(''); }, 400);
      return () => clearTimeout(t);
    }
    setPlanProgress(0);
    const steps = [
      { at: 0,  label: 'Analyzing your foods and macros…' },
      { at: 5,  label: 'Building your workout plan…' },
      { at: 15, label: 'Building your meal templates…' },
      { at: 40, label: 'Optimizing nutrition targets…' },
      { at: 70, label: 'Finalizing your plan — the AI is writing details…' },
      { at: 110, label: 'Almost there — this plan is a long one, hang tight…' },
    ];
    let elapsed = 0;
    const interval = setInterval(() => {
      elapsed += 1;
      // Asymptotic progress: reaches ~88% around 120s, never 95%+.
      const progress = Math.min(88, 100 * (1 - Math.exp(-elapsed / 50)));
      setPlanProgress(progress);
      const currentStep = [...steps].reverse().find(s => elapsed >= s.at);
      if (currentStep) setPlanStep(currentStep.label);
    }, 1000);
    return () => clearInterval(interval);
  }, [isWorkoutUpdating, isNutritionUpdating]);

  // Chat loading progress animation
  useEffect(() => {
    if (trainerLoading) {
      chatProgressAnim.setValue(0);
      Animated.timing(chatProgressAnim, {
        toValue: 0.85,
        duration: 15000, // approaches 85% over 15s
        useNativeDriver: false,
      }).start();
    } else {
      // Snap to 100% briefly then reset
      Animated.timing(chatProgressAnim, {
        toValue: 1,
        duration: 200,
        useNativeDriver: false,
      }).start(() => {
        chatProgressAnim.setValue(0);
      });
    }
  }, [trainerLoading]);

  // Completion + skip state
  const [todayDone, setTodayDone]         = useState(false);
  const [completedDates, setCompletedDates] = useState<Set<string>>(new Set());
  const [fatigueNotice, setFatigueNotice] = useState<string | null>(null);
  // In-progress workout detection — the ActiveWorkoutScreen persists
  // `activeWorkoutSets` and `activeWorkoutStartTime` on every set log.
  // If the user force-quits mid-workout, those keys survive. The resume
  // banner below offers a direct path back into the workout instead of
  // making them find today's day card and tap Start again.
  const [resumeInfo, setResumeInfo] = useState<{
    focus: string;
    setsLogged: number;
    startedAt: number;  // ms epoch
  } | null>(null);
  const [skippedDates, setSkippedDates]   = useState<Set<string>>(new Set());
  // Dropped skips = user chose "skip entirely" (don't push to tomorrow).
  // get7DaySchedule advances the workout index for these dates.
  const [droppedSkipDates, setDroppedSkipDates] = useState<Set<string>>(new Set());
  const [todaySummary, setTodaySummary]   = useState<import('../types').StoredWorkoutSummary | null>(null);
  const [preservedWorkouts, setPreservedWorkouts] = useState<Record<string, WorkoutDay>>({});
  const [readinessScore, setReadinessScore] = useState<{
    score: number;
    label: string;
    topFatigued?: Array<{ muscle: string; value: number }>;
    muscleFatigue?: Record<string, number>;
    activities?: Array<{
      date: string;
      days_ago?: number;
      focus: string;
      category?: string;
      subtype?: string;
      intensity?: string;
      duration_minutes?: number;
      kind?: 'training' | 'recovery';
      muscles: Record<string, number>;
    }>;
    nutritionContext?: { protein_avg: number; protein_status: string; message: string | null; recovery_bonus_applied: boolean } | null;
  } | null>(null);
  const [recoveryExpanded, setRecoveryExpanded] = useState(false);
  const [nutritionScoreData, setNutritionScoreData] = useState<import('../utils/nutritionScore').NutritionScoreResult | null>(null);
  const [plateauedExercises, setPlateauedExercises] = useState<Set<string>>(new Set());
  const [username, setUsername] = useState('');

  // Skip reason modal
  const [skipReasonFocus, setSkipReasonFocus]         = useState<string | null>(null);
  const [selectedSkipReason, setSelectedSkipReason]   = useState('');
  const [customSkipReason, setCustomSkipReason]       = useState('');
  // 'push' = push today's workout to tomorrow (current default)
  // 'drop' = skip entirely, don't reschedule
  const [skipType, setSkipType]                       = useState<'push' | 'drop'>('push');
  const [skipReasonsByDate, setSkipReasonsByDate]     = useState<Record<string, string>>({});

  // Meal tracking
  const [checkedMealsByDate, setCheckedMealsByDate] = useState<Record<string, MealChecks>>({});
  const [editingMeal, setEditingMeal] = useState<{ dateKey: string; type: string; meal: MealSuggestion } | null>(null);
  // Recipe modal target. Opened from the meal card's "🍳 Recipe" button.
  const [recipeTarget, setRecipeTarget] = useState<{ dateKey: string; type: string; meal: MealSuggestion } | null>(null);
  const [currentDate, setCurrentDate] = useState(todayKey());
  const [expandedMealDays, setExpandedMealDays] = useState<Set<string>>(new Set());
  const [availabilityItems, setAvailabilityItems] = useState<AvailabilityItem[]>([]);

  // Supplement stack (from props — managed by Index so it survives remounts)
  const supplementStack = supplementStackProp;
  const [checkedSupplements, setCheckedSupplements] = useState<Set<string>>(new Set());

  // Coach notes (from props — managed by Index so they survive remounts)
  const trainerNote = trainerNoteProp;
  const nutritionistNote = nutritionistNoteProp;
  const [showNutritionistNote, setShowNutritionistNote] = useState(false);
  const [nutritionScoreExpanded, setNutritionScoreExpanded] = useState(false);
  const [showTrainerNote, setShowTrainerNote] = useState(false);
  const [showLogActivity, setShowLogActivity] = useState(false);
  const [showLiveTracker, setShowLiveTracker] = useState(false);
  const [showWeeklyCheckin, setShowWeeklyCheckin] = useState(false);
  const [showFriends, setShowFriends] = useState(false);
  const [showGoalEditor, setShowGoalEditor] = useState(false);
  const [pendingFriendCount, setPendingFriendCount] = useState(0);
  const [friendCount, setFriendCount] = useState(0);

  // Next-day unlogged-meals prompt. Populated once per day when yesterday
  // had a plan with unchecked meals and the dismissal flag isn't set.
  const [unloggedPrompt, setUnloggedPrompt] = useState<{
    date: string;
    items: Array<{ mealType: string; meal: MealSuggestion }>;
    chosen: Record<string, boolean>;
  } | null>(null);
  const unloggedPromptCheckedRef = useRef(false);
  // Days until the next weekly AI check-in. Computed from `weekStartDate`
  // on mount + whenever the plan refreshes. Negative means overdue. Null
  // means the user hasn't generated a plan yet (nothing to check in on).
  const [daysUntilCheckin, setDaysUntilCheckin] = useState<number | null>(null);
  const [nextCheckinDate, setNextCheckinDate] = useState<Date | null>(null);
  const [checkinAdherence, setCheckinAdherence] = useState(3); // 1-5
  const [checkinEnergy, setCheckinEnergy] = useState(3);       // 1-5
  const [checkinNotes, setCheckinNotes] = useState('');
  const [checkinInjuryStatuses, setCheckinInjuryStatuses] = useState<Record<string, InjuryEntry['status']>>({});

  // Recompute nutrition score client-side whenever the plan changes
  useEffect(() => {
    const plan = nutritionPlansByDate[todayKey()] ?? null;
    if (!plan) { setNutritionScoreData(null); return; }
    setNutritionScoreData(computeNutritionScore(plan, userProfile?.goal ?? 'body_recomp'));
  }, [nutritionPlansByDate, userProfile?.goal]);

  // Authoritative daily amounts from the server — collagen + probiotic
  // CFUs. Fetched alongside the score so NutritionCard can show real
  // numbers instead of the client-side plan estimate. Refresh piggy-
  // backs on checkedMealsByDate so toggling a meal immediately
  // re-queries.
  const [todayCollagenG, setTodayCollagenG] = useState<number | null>(null);
  const [todayProbioticCfu, setTodayProbioticCfu] = useState<number | null>(null);
  const [proteinBreakdown, setProteinBreakdown] = useState<any | null>(null);
  const [todaySupplementMicros, setTodaySupplementMicros] = useState<Array<{ ingredient_slug?: string | null; ingredient_name?: string | null; custom_name?: string | null; dose_amount: number; dose_unit: string; taken_count: number }> | null>(null);
  useEffect(() => {
    if (!authToken) return;
    let cancelled = false;
    (async () => {
      try {
        const { getGutHealth, getProteinBreakdown, getTodaySupplements } = await import('../services/api');
        const [gut, breakdown, supps] = await Promise.all([
          getGutHealth(authToken, 7).catch(() => null),
          getProteinBreakdown(authToken).catch(() => null),
          getTodaySupplements(authToken).catch(() => null),
        ]);
        if (cancelled) return;
        const t: any = gut?.today;
        setTodayCollagenG(typeof t?.collagen_g === 'number' ? t.collagen_g : 0);
        setTodayProbioticCfu(typeof t?.probiotic_cfu_billions === 'number' ? t.probiotic_cfu_billions : 0);
        setProteinBreakdown(breakdown);
        if (supps) {
          setTodaySupplementMicros(supps.map(s => ({
            ingredient_slug: s.ingredient_slug ?? null,
            ingredient_name: s.ingredient_name ?? null,
            custom_name: s.custom_name ?? null,
            dose_amount: s.dose_amount,
            dose_unit: s.dose_unit,
            taken_count: (s.logs_today ?? []).filter(l => !l.skipped).length,
          })));
        }
      } catch { /* network / bridge optional */ }
    })();
    return () => { cancelled = true; };
  }, [authToken, checkedMealsByDate, nutritionPlansByDate]);

  const persistDayState = useCallback(async (dayKey: string, patch: { skipped_focus?: string | null; meal_checks?: Record<string, boolean>; nutrition_plan?: any }) => {
    if (!authToken) return;
    try {
      // Strict patch: only send fields the caller passed. Don't fall back to
      // React state for the un-patched fields — that's how stale meal_checks
      // got re-propagated to the DB on every plan-only save (and ended up
      // marking future-day meals as "complete" on cold open).
      await upsertDayState(authToken, dayKey, patch);
    } catch {
      // Keep app responsive even if backend persistence fails
    }
  }, [authToken]);

  useEffect(() => {
    AsyncStorage.getItem('user_username').then(v => { if (v) setUsername(v); }).catch(() => {});
    import('../utils/workoutReminders').then(({ loadReminderSettings }) =>
      loadReminderSettings().then(s => setReminderEnabled(s.enabled)).catch(() => {})
    );
    if (userProfile) loadPlans(userProfile);
    loadDayStatus();
    // Warm the exercise library in the background so plan-view + active-
    // workout thumbnails have the name→video_id index populated even
    // for users who never visit the Library sub-tab.
    ensureExerciseLibrary().catch(() => {});
    // Weekly check-in — auto-popup every 7 days
    AsyncStorage.getItem('weekStartDate').then(async raw => {
      if (!raw) {
        setDaysUntilCheckin(null);
        setNextCheckinDate(null);
        return;
      }
      const startMs = new Date(raw).getTime();
      const daysSince = (Date.now() - startMs) / (1000 * 60 * 60 * 24);
      setDaysUntilCheckin(Math.max(0, Math.ceil(7 - daysSince)));
      setNextCheckinDate(new Date(startMs + 7 * 24 * 60 * 60 * 1000));
      if (daysSince >= 7) {
        const profileRaw = await AsyncStorage.getItem('userProfile');
        if (profileRaw) {
          const p: UserProfile = JSON.parse(profileRaw);
          const initial: Record<string, InjuryEntry['status']> = {};
          for (const inj of (p.injuryEntries ?? [])) {
            initial[inj.id] = inj.status;
          }
          setCheckinInjuryStatuses(initial);
        }
        setShowWeeklyCheckin(true);
      }
    });
    // NOTE: `meta.allFoods.length` was previously in this dep array but caused
    // `loadPlans` to re-fire whenever the parent re-rendered (e.g. when a menu
    // opened), which made in-progress plan generation look like it was
    // restarting. `loadPlans` reads from AsyncStorage, not from `meta`, so
    // there's no functional need to depend on it here.
    //
    // Dep list is narrowed to plan-relevant userProfile fields ONLY —
    // NOT the whole userProfile object. Using the full object caused
    // theme/UI-only changes (themePreference) to retrigger loadPlans
    // and clobber `nutritionPlansByDate`, making theme selection
    // flash the meals section like a plan was regenerating.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    userProfile?.goal,
    userProfile?.daysPerWeek,
    userProfile?.mealsPerDay,
    userProfile?.mealVariety,
    userProfile?.foodsAvailable?.length,
    userProfile?.customFoods?.length,
    userProfile?.mealRoutine,
    authToken,
    planRefreshKey,
  ]);

  // Keep the Workout > History sub-tab in sync with workoutHistory writes.
  // Loads on mount and on each planRefreshKey bump (which fires after
  // finish + save). Also pulls workout summaries so session cards can
  // show motivation / achievements / feedback like the old Progress tab.
  useEffect(() => {
    Promise.all([loadWorkoutHistory(), loadWorkoutSummaries()])
      .then(([h, s]) => { setWorkoutHistoryList(h); setWorkoutHistorySummaries(s); })
      .catch(() => {});
  }, [planRefreshKey]);

  // Library sub-tab state sync. When the user leaves the Workout tab
  // (bottom tab change) while parked on Library and later returns,
  // `workoutSubTab` is still 'library' but `showExerciseLibrary` may be
  // stale. Re-trigger the library load so content renders without a
  // manual Plan → Library bounce.
  useEffect(() => {
    if (activeTab !== 'workout') return;
    if (workoutSubTab !== 'library') return;
    if (!showExerciseLibrary) setShowExerciseLibrary(true);
    ensureExerciseLibrary().catch(() => {});
  }, [activeTab, workoutSubTab, showExerciseLibrary, ensureExerciseLibrary]);

  // Next-day unlogged-meals prompt. Fires once per calendar day when
  // yesterday had a plan with unchecked meals and the user hasn't dismissed
  // the prompt. Captures otherwise-lost data for rolling nutrition averages.
  // Detect in-progress workout on mount so the resume banner can fire.
  // `activeWorkoutSets` + `activeWorkoutStartTime` are written by
  // ActiveWorkoutScreen on every set log and survive app force-close.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [rawSets, rawStart] = await Promise.all([
          AsyncStorage.getItem('activeWorkoutSets'),
          AsyncStorage.getItem('activeWorkoutStartTime'),
        ]);
        if (cancelled) return;
        if (!rawSets || !rawStart) { setResumeInfo(null); return; }
        const parsed: Array<{ name: string; sets: any[] }> = JSON.parse(rawSets);
        const setsLogged = parsed.reduce((n, ex) => n + (ex.sets?.length ?? 0), 0);
        if (setsLogged <= 0) { setResumeInfo(null); return; }
        const startedAt = parseInt(rawStart, 10);
        if (!Number.isFinite(startedAt)) { setResumeInfo(null); return; }
        // Expire after 24h — beyond that it's almost certainly stale.
        if (Date.now() - startedAt > 24 * 3600 * 1000) {
          await AsyncStorage.removeItem('activeWorkoutSets').catch(() => {});
          await AsyncStorage.removeItem('activeWorkoutStartTime').catch(() => {});
          setResumeInfo(null);
          return;
        }
        // Infer focus from today's plan — `schedule[0].workout.focus`.
        const todayFocus = workoutPlan?.days?.[0]?.focus ?? 'workout';
        setResumeInfo({ focus: todayFocus, setsLogged, startedAt });
      } catch {
        setResumeInfo(null);
      }
    })();
    return () => { cancelled = true; };
  }, [workoutPlan, planRefreshKey]);

  // Defensive re-schedule of the 9pm meal-log reminder. Cheap: if the
  // settings say disabled, the helper no-ops. If already scheduled,
  // the helper cancels + re-schedules so we don't stack duplicates.
  // Also re-establishes the repeating schedule after a
  // `maybeCancelTodayReminder` path swapped it for a one-shot tomorrow.
  useEffect(() => {
    (async () => {
      try {
        const { loadMealReminderSettings, scheduleMealReminder } = await import('../utils/mealReminders');
        const settings = await loadMealReminderSettings();
        if (settings.enabled) await scheduleMealReminder(settings);
      } catch {}
    })();
  }, []);

  useEffect(() => {
    if (unloggedPromptCheckedRef.current) return;
    if (!userProfile || !authToken) return;
    const yesterdayDate = new Date(Date.now() - 86400000);
    const yesterdayStr = `${yesterdayDate.getFullYear()}-${String(yesterdayDate.getMonth() + 1).padStart(2, '0')}-${String(yesterdayDate.getDate()).padStart(2, '0')}`;
    const plan = nutritionPlansByDate[yesterdayStr];
    const checks = checkedMealsByDate[yesterdayStr] ?? {};

    // Pro path — compare yesterday's plan meals to checks.
    if (plan?.meals?.length) {
      const unchecked = plan.meals
        .map((meal, idx) => ({ mealType: `meal_${idx}`, meal }))
        .filter(it => !checks[it.mealType]);
      if (unchecked.length === 0) {
        unloggedPromptCheckedRef.current = true;
        return;
      }
      unloggedPromptCheckedRef.current = true;
      (async () => {
        const flagKey = `unloggedMealsPromptShown_${yesterdayStr}`;
        const seen = await AsyncStorage.getItem(flagKey).catch(() => null);
        if (seen) return;
        const chosen: Record<string, boolean> = {};
        for (const it of unchecked) chosen[it.mealType] = true;
        setUnloggedPrompt({ date: yesterdayStr, items: unchecked, chosen });
      })();
      return;
    }

    // Free-tier path — no generated plan, but we can still compare the
    // user's daily meal target (`mealsPerDay`) against the number of
    // meals they actually checked off yesterday. If they're below target,
    // nudge them to add more via the simpler "catch-up" prompt.
    const isFree = (userProfile.subscriptionTier ?? 'pro') === 'free';
    if (isFree) {
      const target = Math.max(1, userProfile.mealsPerDay ?? 3);
      const loggedCount = Object.values(checks).filter(Boolean).length;
      if (loggedCount >= target) {
        unloggedPromptCheckedRef.current = true;
        return;
      }
      unloggedPromptCheckedRef.current = true;
      (async () => {
        const flagKey = `unloggedMealsPromptShown_${yesterdayStr}`;
        const seen = await AsyncStorage.getItem(flagKey).catch(() => null);
        if (seen) return;
        // Free branch: no item list, just a CTA. Items stays empty so the
        // render path shows the simplified free-tier copy.
        setUnloggedPrompt({ date: yesterdayStr, items: [], chosen: {} });
      })();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userProfile, authToken, nutritionPlansByDate, checkedMealsByDate]);

  // Clear fresh-day flag only when workout-specific settings actually change
  // (not on initial mount). Uses a ref to track previous values.
  const prevWorkoutSettings = useRef<string | null>(null);
  useEffect(() => {
    const current = `${userProfile?.goal}|${userProfile?.daysPerWeek}|${userProfile?.workoutDurationMinutes}|${userProfile?.preferredSplit}`;
    if (prevWorkoutSettings.current === null) {
      // First mount — store but don't clear
      prevWorkoutSettings.current = current;
      return;
    }
    if (prevWorkoutSettings.current !== current) {
      prevWorkoutSettings.current = current;
      AsyncStorage.removeItem(`freshDayGenerated_${todayKey()}`).catch(() => {});
      console.log('[loadPlans] workout settings changed — fresh day flag cleared');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userProfile?.goal, userProfile?.daysPerWeek, userProfile?.workoutDurationMinutes, userProfile?.preferredSplit]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!workoutPlan) return;
      const history = await loadWorkoutHistory();
      const insight = buildAvailability(workoutPlan, history);
      if (!mounted) return;
      setAvailabilityItems(insight.items);
    })();
    return () => { mounted = false; };
  }, [todayDone, workoutPlan]);

  // Apple Watch sync — pushes today's workout + theme + meals to the
  // paired watch whenever anything changes. Uses `schedule[0]` rather
  // than `workoutPlan.days[0]` so skipped/completed/rest states reflect
  // the actual phone UI (the earlier version showed the original
  // scheduled workout even after the user skipped). No-ops when the
  // bridge isn't available (Android / no paired watch).
  useEffect(() => {
    (async () => {
      try {
        const {
          pushWorkoutToWatch, pushThemeToWatch, pushMealsToWatch,
        } = await import('../utils/watchSync');
        const todayISO = new Date().toISOString().slice(0, 10);
        const todayItem = (schedule as any[])?.[0] ?? null;
        const todayWorkout = todayItem?.workout ?? null;
        // Detect in-progress workout — ActiveWorkoutScreen writes
        // `activeWorkoutStartTime` on mount and clears it on
        // end/cancel. While that key is present (and recent), the
        // user is mid-workout. The watch must see status='active'
        // not 'scheduled', otherwise the regular HomeScreen sync
        // re-push will keep overriding the watch's active state and
        // closing the watch app. Was the root cause of "tap Start →
        // app closes on watch even after a fresh build."
        let isWorkoutInProgress = false;
        try {
          const startTimeRaw = await AsyncStorage.getItem('activeWorkoutStartTime');
          if (startTimeRaw) {
            const t = parseInt(startTimeRaw, 10);
            // Only trust the flag if it's within the last 4 hours —
            // beyond that it's stale (app force-close, etc).
            if (Number.isFinite(t) && (Date.now() - t) < 4 * 3600_000) {
              isWorkoutInProgress = true;
            }
          }
        } catch { /* AsyncStorage flake — assume not in workout */ }
        const status: 'scheduled' | 'active' | 'completed' | 'skipped' | 'rest' =
          isWorkoutInProgress ? 'active'
          : todayDone ? 'completed'
          : skippedDates.has(todayKey()) ? 'skipped'
          : todayItem?.isRest ? 'rest'
          : 'scheduled';
        // ── Readiness: trust what the phone is currently displaying ──
        // The canonical ref is set by TrainingReadinessCard whenever it
        // renders. Always prefer that over recomputing — guarantees the
        // watch ALWAYS shows the same number the phone last displayed.
        // No freshness window: the card writes a fresh value every
        // time it loads, and stale values are still better than drift.
        let unifiedPrepScore: number | null = readinessScore?.score ?? null;
        let unifiedPrepLabel: string | null = readinessScore?.label ?? null;
        const canonical = canonicalPrepRef.current;
        if (canonical) {
          unifiedPrepScore = canonical.score;
          unifiedPrepLabel = canonical.label;
        } else {
          try {
            if (authToken) {
              const { scorePreparedness } = await import('../services/preparedness');
              const { loadPreparednessInputs } = await import('../services/preparednessLoader');
              const inputs = await loadPreparednessInputs({
                authToken,
                age: userProfile?.age ?? null,
                proteinTarget: userProfile?.proteinGoal ?? null,
                calorieTarget: userProfile?.calorieGoal ?? null,
                todaysFocus: todayItem?.workout?.focus ?? null,
              });
              const prep = scorePreparedness(inputs);
              unifiedPrepScore = prep.score;
              unifiedPrepLabel = prep.label;
              // Update the ref so subsequent syncs reuse this value.
              canonicalPrepRef.current = { score: prep.score, label: prep.label, computedAt: Date.now() };
            }
          } catch { /* fall back to backend score */ }
        }
        await pushWorkoutToWatch(todayWorkout, {
          dateISO: todayISO,
          status,
          readiness: unifiedPrepScore,
          readinessLabel: unifiedPrepLabel,
        });
        await pushThemeToWatch(userProfile?.themePreference);
        const todayPlan = nutritionPlansByDate[todayISO]
          ?? (Object.values(nutritionPlansByDate)[0] as any);
        await pushMealsToWatch(
          todayPlan,
          checkedMealsByDate[todayISO],
          todayISO,
          nutritionScoreData?.score ?? null,
        );
        // Today's supplement stack — mirrored so the Supps tab on the
        // watch renders instantly. Commands from the watch round-trip
        // to api.logDose via the command listener above.
        try {
          const { getTodaySupplements } = await import('../services/api');
          const { pushSupplementsToWatch } = await import('../utils/watchSync');
          if (authToken) {
            const stack = await getTodaySupplements(authToken).catch(() => null);
            if (stack) {
              await pushSupplementsToWatch(
                stack.map(s => ({
                  id: s.id,
                  name: s.custom_name || 'Supplement',
                  dose: `${s.dose_amount}${s.dose_unit}`,
                  timing: s.timing ?? null,
                  taken: !!(s.logs_today || []).find(l => !l.skipped),
                  skipped: !!(s.logs_today || []).find(l => l.skipped),
                })),
              );
            }
          }
        } catch { /* non-fatal */ }
        // Sleep snapshot for the watch's Sleep tab. Use the REAL
        // phone-computed sleep score (pillars-based) instead of the
        // old simplified hours-based proxy. Sources from the same
        // healthDataSummary the phone Progress tab reads, so watch
        // and phone always show the same number.
        try {
          const { pushSleepToWatch } = await import('../utils/watchSync');
          const { getCachedHealthDataSummary } = await import('../services/healthDataSummary');
          const cached = await getCachedHealthDataSummary();
          const ss = (cached?.raw as any)?.sleepScore ?? null;
          const hours = cached?.sleepMinutes != null ? cached.sleepMinutes / 60 : null;
          // Prefer the full sleep score when available; fall back to
          // hours-band when sleepScore is null (no Apple Health data).
          let score: number | null = ss?.score ?? null;
          let label: string | null = ss?.rating ?? null;
          let summary: string | null = null;
          if (score != null && hours != null) {
            summary = `${hours.toFixed(1)}h slept · ${label}`;
          } else if (hours != null) {
            if (hours >= 8) { score = 90; label = 'Excellent'; summary = `${hours.toFixed(1)}h — fully recovered.`; }
            else if (hours >= 7) { score = 75; label = 'Good'; summary = `${hours.toFixed(1)}h — solid night.`; }
            else if (hours >= 6) { score = 55; label = 'Fair'; summary = `${hours.toFixed(1)}h — a touch short.`; }
            else if (hours > 0) { score = 30; label = 'Poor'; summary = `${hours.toFixed(1)}h — dial intensity back today.`; }
          }
          await pushSleepToWatch({
            score,
            hoursLastNight: hours,
            asleepMin: cached?.sleepMinutes ?? null,
            remMin: ss?.stages?.rem != null ? Math.round(ss.stages.rem * 60) : null,
            deepMin: ss?.stages?.deep != null ? Math.round(ss.stages.deep * 60) : null,
            restingHr: cached?.restingHeartRate ?? null,
            hrvMs: cached?.hrv ?? null,
            label,
            summary,
          });
        } catch { /* non-fatal */ }
        // Readiness payload is owned by `TrainingReadinessCard`'s
        // `pushReadinessToWatch` call. Routing all readiness writes
        // through one site eliminates the score race we used to see
        // (HomeScreen + the card pushing seconds apart, sometimes with
        // empty factors clobbering full ones). The watch's Today chip
        // now reads `conn.readiness?.score` first, so it shares the
        // exact same value as the Readiness tab — both surfaces always
        // show one number. The reachability re-push below still seeds
        // readiness on cold-wake, when the card hasn't mounted yet.
        // Weight summary for the quick-log tab. Reads the weight
        // history utility so the EMA + slope match the phone's
        // weight chart.
        try {
          const { pushWeightToWatch } = await import('../utils/watchSync');
          const { loadWeightEntries } = await import('../utils/weightHistory');
          const entries: Array<{ date: string; weight_lbs: number }> = await loadWeightEntries().catch(() => []);
          let latest: number | null = null;
          let daysSince: number | null = null;
          if (entries.length > 0) {
            const last = entries[entries.length - 1];
            latest = Number(last.weight_lbs) || null;
            try {
              const lastMs = new Date(last.date).getTime();
              daysSince = Math.max(0, Math.floor((Date.now() - lastMs) / 86400000));
            } catch {}
          }
          // Lightweight slope: last entry vs 7-day-old entry.
          let slope: number | null = null;
          let ema: number | null = null;
          if (entries.length >= 3) {
            const recent = entries.slice(-7);
            ema = recent.reduce((acc, e) => acc + Number(e.weight_lbs), 0) / recent.length;
            const old = entries.slice(-14, -7);
            if (old.length > 0) {
              const oldEma = old.reduce((acc, e) => acc + Number(e.weight_lbs), 0) / old.length;
              slope = (ema - oldEma);
            }
          }
          await pushWeightToWatch({
            latestLbs: latest,
            daysSinceLastLog: daysSince,
            emaLbs: ema,
            slopeLbsPerWeek: slope,
          });
        } catch { /* non-fatal */ }
      } catch { /* watch bridge optional — silent failure is fine */ }
    })();
  // `schedule` is derived every render so we key on its first-item
  // workout reference to avoid sync spam. todayDone / skippedDates
  // flip the status between lifecycle buckets.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workoutPlan, userProfile?.themePreference, todayDone, skippedDates,
    nutritionPlansByDate, checkedMealsByDate,
    readinessScore, nutritionScoreData,
  ]);

  // Re-push the full snapshot (workout + meals + theme) whenever the
  // watch app becomes reachable. Without this, a watch that was
  // closed when the phone last pushed would only see the stale
  // applicationContext queued by iOS — opening the watch app after
  // the phone already started a workout wouldn't reflect the active
  // state. With this, the moment reachability flips true we send a
  // fresh snapshot so the UI on the wrist matches the phone within
  // a second or two.
  //
  // Refs keep the listener idempotent — we register once but always
  // read the latest state when re-pushing.
  const rePushStateRef = useRef({
    schedule: [] as any[],
    themePreference: undefined as any,
    todayDone: false,
    skippedDates: new Set<string>(),
    nutritionPlansByDate: {} as any,
    checkedMealsByDate: {} as any,
    readinessScore: null as any,
    nutritionScoreData: null as any,
    workoutPlan: null as any,
  });
  useEffect(() => {
    rePushStateRef.current = {
      schedule: schedule as any[],
      themePreference: userProfile?.themePreference,
      todayDone,
      skippedDates,
      nutritionPlansByDate,
      checkedMealsByDate,
      readinessScore,
      nutritionScoreData,
      workoutPlan,
    };
  });

  // WCSession diagnostic firehose. Mirrors every delegate callback
  // from the phone bridge into console.log with a `[wc-diag]` prefix
  // — activation completion, reachability flips, every didReceiveMessage
  // / didReceiveUserInfo arrival. Visible via Console.app (Mac) with
  // the iPhone tethered, filter by "ThalloWatch" or "wc-diag".
  // Tells us whether (a) phone bridge never activates, (b) reachability
  // never flips true, (c) messages arrive but malformed, or (d)
  // nothing arrives at all (= watch isn't sending or iOS isn't routing).
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log('[wc-diag] effect mounted — about to import watchSync');
    const token = { cancelled: false, unsub: null as (() => void) | null };
    (async () => {
      try {
        const watchSyncMod = await import('../utils/watchSync');
        const { onWatchSessionDiag, WatchBridge } = watchSyncMod as any;
        // eslint-disable-next-line no-console
        console.log('[wc-diag] watchSync imported — bridge available?',
          !!WatchBridge?.isAvailable?.(),
          'paired=', !!WatchBridge?.isPaired?.(),
          'reachable=', !!WatchBridge?.isReachable?.(),
        );
        const unsub = onWatchSessionDiag((entry: Record<string, any>) => {
          // Map activationState int → human label so logs are scannable.
          // 0=notActivated, 1=inactive, 2=activated.
          const stateLabel =
            entry.activationState === 2 ? 'activated' :
            entry.activationState === 1 ? 'inactive' :
            entry.activationState === 0 ? 'notActivated' :
            String(entry.activationState ?? '?');
          // eslint-disable-next-line no-console
          console.log(
            `[wc-diag] ${entry.event} state=${stateLabel} reachable=${!!entry.reachable} paired=${!!entry.paired} installed=${!!entry.installed}`,
            entry,
          );
        });
        // eslint-disable-next-line no-console
        console.log('[wc-diag] listener subscribed — waiting for events');
        if (token.cancelled) { try { unsub(); } catch {} }
        else { token.unsub = unsub; }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log('[wc-diag] subscribe failed:', String(err));
      }
    })();
    return () => {
      token.cancelled = true;
      if (token.unsub) { try { token.unsub(); } catch {} }
    };
  }, []);

  useEffect(() => {
    // Ref-based teardown: cleanup may run BEFORE the async import below
    // resolves. Using a plain `let unsubscribe` left it null at cleanup
    // time, so the listener attached after cleanup leaked. The token
    // pattern guarantees that whoever resolves first (cleanup or
    // attach) wins — late-attach sees `cancelled` and immediately
    // unsubscribes.
    const token = { cancelled: false, unsub: null as (() => void) | null };
    (async () => {
      try {
        const watchSync = await import('../utils/watchSync');
        const {
          onWatchReachabilityChange, pushWorkoutToWatch, pushThemeToWatch, pushMealsToWatch,
          pushSleepToWatch, pushSupplementsToWatch, pushWeightToWatch,
        } = watchSync;
        const unsub = onWatchReachabilityChange((info) => {
          if (!info.reachable) return;
          const s = rePushStateRef.current;
          const todayISO = new Date().toISOString().slice(0, 10);
          const todayItem = (s.schedule as any[])?.[0] ?? null;
          const todayWorkout = todayItem?.workout ?? null;

          // Workout payload waits on the AsyncStorage in-progress check
          // so `status` reflects the correct lifecycle bucket — earlier
          // this read was kicked off inside a `.then()` and `status`
          // was computed synchronously above it, so the first push went
          // out as 'scheduled' (or 'completed' if todayDone) and only a
          // corrective second push arrived later. The race force-ended
          // the watch's active view when the watch fired pull_state
          // right after tapping Start.
          //
          // Readiness embedded here uses the LAST known phone-displayed
          // value (set by TrainingReadinessCard's onScoreComputed). The
          // dedicated readiness payload below carries the authoritative
          // server score with the server's syncedAtMs.
          (async () => {
            let isWorkoutInProgress = false;
            try {
              const startTimeRaw = await AsyncStorage.getItem('activeWorkoutStartTime');
              if (startTimeRaw) {
                const t = parseInt(startTimeRaw, 10);
                if (Number.isFinite(t) && (Date.now() - t) < 4 * 3600_000) {
                  isWorkoutInProgress = true;
                }
              }
            } catch { /* AsyncStorage flake — assume not in workout */ }
            const status: 'scheduled' | 'active' | 'completed' | 'skipped' | 'rest' =
              isWorkoutInProgress ? 'active'
              : s.todayDone ? 'completed'
              : s.skippedDates.has(todayKey()) ? 'skipped'
              : todayItem?.isRest ? 'rest'
              : 'scheduled';
            console.log('[watch] reachable — re-pushing full home snapshot', { status });
            pushWorkoutToWatch(todayWorkout, {
              dateISO: todayISO,
              status,
              readiness: s.readinessScore?.score ?? null,
              readinessLabel: s.readinessScore?.label ?? null,
            }).catch(() => {});
          })();
          pushThemeToWatch(s.themePreference).catch(() => {});
          const todayPlan = s.nutritionPlansByDate[todayISO]
            ?? (Object.values(s.nutritionPlansByDate)[0] as any);
          pushMealsToWatch(
            todayPlan,
            s.checkedMealsByDate[todayISO],
            todayISO,
            s.nutritionScoreData?.score ?? null,
          ).catch(() => {});

          // Sleep / readiness / weight pulled from cached health summary so
          // we don't re-query Apple Health on every reachability flip.
          // Supplements pull from the API when authToken is present.
          (async () => {
            try {
              const { getCachedHealthDataSummary } = await import('../services/healthDataSummary');
              const cached = await getCachedHealthDataSummary();
              const hours = cached?.sleepMinutes != null ? cached.sleepMinutes / 60 : null;
              let score: number | null = null;
              let label: string | null = null;
              let summary: string | null = null;
              if (hours != null) {
                if (hours >= 8) { score = 90; label = 'Excellent'; summary = `${hours.toFixed(1)}h — fully recovered.`; }
                else if (hours >= 7) { score = 75; label = 'Good'; summary = `${hours.toFixed(1)}h — solid night.`; }
                else if (hours >= 6) { score = 55; label = 'OK'; summary = `${hours.toFixed(1)}h — a touch short.`; }
                else if (hours > 0) { score = 30; label = 'Low'; summary = `${hours.toFixed(1)}h — dial intensity back today.`; }
              }
              await pushSleepToWatch({
                score, hoursLastNight: hours,
                restingHr: cached?.restingHeartRate ?? null,
                hrvMs: cached?.hrv ?? null,
                label, summary,
              });
            } catch { /* non-fatal */ }
          })();
          // Readiness push: always go through the server's
          // /readiness/today endpoint and stamp the watch payload with
          // the server's `computed_at_ms`. A locally-computed score
          // pushed with `Date.now()` would beat the server's older
          // timestamp in the watch's ordering check, silently rejecting
          // the authoritative value (the phone↔watch drift bug).
          // TrainingReadinessCard pushes the same way — both surfaces
          // share one source of truth. No fallback: when the server
          // call fails, leave the watch's last-known reading in place
          // rather than overwriting it with a drifting local value.
          (async () => {
            try {
              if (!authToken) return;
              const { pushReadinessToWatch } = watchSync;
              const { getReadinessToday } = await import('../services/api');
              const { getCachedHealthDataSummary } = await import('../services/healthDataSummary');
              const cached = await getCachedHealthDataSummary().catch(() => null);
              const sleepHours = cached?.sleepMinutes != null ? cached.sleepMinutes / 60 : null;
              const serverResp = await getReadinessToday(authToken, {
                avgSleepHours: sleepHours,
                avgRestingHr: cached?.restingHeartRate ?? null,
                avgHrvMs: cached?.hrv ?? null,
              }).catch(() => null);
              if (!serverResp) return;
              await pushReadinessToWatch({
                score: serverResp.score,
                label: serverResp.label,
                summary: serverResp.summary,
                factors: serverResp.factors as any,
                syncedAtMs: serverResp.computed_at_ms,
              } as any);
            } catch { /* non-fatal */ }
          })();
          (async () => {
            try {
              if (!authToken) return;
              const { getTodaySupplements } = await import('../services/api');
              const stack = await getTodaySupplements(authToken).catch(() => null);
              if (stack) {
                await pushSupplementsToWatch(
                  stack.map(sup => ({
                    id: sup.id,
                    name: sup.custom_name || 'Supplement',
                    dose: `${sup.dose_amount}${sup.dose_unit}`,
                    timing: sup.timing ?? null,
                    taken: !!(sup.logs_today || []).find(l => !l.skipped),
                    skipped: !!(sup.logs_today || []).find(l => l.skipped),
                  })),
                );
              }
            } catch { /* non-fatal */ }
          })();
          (async () => {
            try {
              const { loadWeightEntries } = await import('../utils/weightHistory');
              const entries: Array<{ date: string; weight_lbs: number }> = await loadWeightEntries().catch(() => []);
              let latest: number | null = null;
              let daysSince: number | null = null;
              if (entries.length > 0) {
                const last = entries[entries.length - 1];
                latest = Number(last.weight_lbs) || null;
                try {
                  const lastMs = new Date(last.date).getTime();
                  daysSince = Math.max(0, Math.floor((Date.now() - lastMs) / 86400000));
                } catch {}
              }
              let slope: number | null = null;
              let ema: number | null = null;
              if (entries.length >= 3) {
                const recent = entries.slice(-7);
                ema = recent.reduce((acc, e) => acc + Number(e.weight_lbs), 0) / recent.length;
                const old = entries.slice(-14, -7);
                if (old.length > 0) {
                  const oldEma = old.reduce((acc, e) => acc + Number(e.weight_lbs), 0) / old.length;
                  slope = (ema - oldEma);
                }
              }
              await pushWeightToWatch({ latestLbs: latest, daysSinceLastLog: daysSince, emaLbs: ema, slopeLbsPerWeek: slope });
            } catch { /* non-fatal */ }
          })();
        });
        // Hand the unsub to the token. If cleanup already ran while
        // we were awaiting the import, drop the listener immediately.
        if (token.cancelled) { try { unsub(); } catch {} }
        else { token.unsub = unsub; }
      } catch { /* bridge optional */ }
    })();
    return () => {
      token.cancelled = true;
      if (token.unsub) { try { token.unsub(); } catch {} }
    };
  }, [authToken]);

  // Listen for commands the user taps on the watch. Routes each to
  // the existing phone-side action — watch is purely a remote control
  // for state that already lives on the phone.
  //
  // handleToggleMeal / handleSkipToday / onStartWorkout are captured
  // via refs so the WC listener (registered once) always dispatches to
  // the latest handler closure. Without this, `handleToggleMeal` froze
  // at initial-mount checkedMealsByDate, so every watch toggle after
  // the first one was operating on stale check state.
  const watchCmdHandlersRef = useRef({
    start: (today: any) => { onStartWorkout?.(today); },
    skip: (_focus: string) => {},
    toggleMeal: (_date: string, _mealType: string) => {},
  });
  useEffect(() => {
    watchCmdHandlersRef.current = {
      start: (today: any) => { onStartWorkout?.(today); },
      skip: (focus: string) => handleSkipToday(focus),
      toggleMeal: (date: string, mealType: string) => handleToggleMeal(date, mealType),
    };
  });
  useEffect(() => {
    // Same ref-token pattern as the reachability listener: cleanup
    // can fire before the async import resolves, so we have to be
    // able to drop a listener that hasn't been attached yet.
    const token = { cancelled: false, unsub: null as (() => void) | null };
    (async () => {
      try {
        const { onWatchCommand } = await import('../utils/watchSync');
        const unsub = onWatchCommand((command, payload) => {
          if (command === 'log_weight') {
            // Watch sent a Digital-Crown-picked weight value. Save
            // to the phone's weight history → triggers the same
            // chart updates a manual phone log would, and the next
            // sync push refreshes the watch's Weight tab with the
            // updated EMA + slope.
            (async () => {
              try {
                const lbs = Number(payload?.lbs);
                if (!isFinite(lbs) || lbs < 50 || lbs > 600) return;
                const { saveWeightEntry } = await import('../utils/weightHistory');
                await saveWeightEntry(lbs, 'watch');
                // Re-push to refresh the Weight tab on the watch.
                const { pushWeightToWatch } = await import('../utils/watchSync');
                await pushWeightToWatch({
                  latestLbs: lbs,
                  daysSinceLastLog: 0,
                  emaLbs: lbs,
                  slopeLbsPerWeek: null,
                });
              } catch { /* non-fatal */ }
            })();
            return;
          }
          if (command === 'start_custom_workout') {
            // Watch picked an activity from its Quick-Start tab — mount
            // the phone's LiveActivityTracker. Watch HR session is
            // already started locally on the watch side; the phone
            // covers timer + log + HK write on finish.
            const subtype = String(payload?.subtype || 'run');
            console.log('[watch] start_custom_workout subtype=', subtype);
            setShowLiveTracker(true);
            // Note: the LiveActivityTracker doesn't currently accept
            // a pre-selected activity prop — user still picks on phone.
            // TODO: pass watch-selected activity through to skip the
            // pick step. For now, opening the tracker is the win.
            return;
          }
          if (command === 'pull_state') {
            // Watch explicitly asked for a fresh snapshot — push
            // workout + meals + theme via the same path the
            // reachability listener uses. Bypasses stale
            // applicationContext so the watch UI is always current
            // the moment the user opens Thallo on their wrist.
            console.log('[watch] pull_state requested — pushing snapshot');
            (async () => {
              try {
                const { pushWorkoutToWatch, pushThemeToWatch, pushMealsToWatch } =
                  await import('../utils/watchSync');
                const s = rePushStateRef.current;
                const todayISO = new Date().toISOString().slice(0, 10);
                const todayItem = (s.schedule as any[])?.[0] ?? null;
                const todayWorkout = todayItem?.workout ?? null;
                // Detect in-progress workout BEFORE computing status —
                // ActiveWorkoutScreen writes activeWorkoutStartTime on
                // mount and clears it on end/cancel. Without this check
                // a watch-initiated start that races with a pull_state
                // got status:'completed' (when todayDone was true from
                // an earlier session) which force-ended the watch's
                // active view — exactly the "tap Start → app closes on
                // watch" symptom. The regular sync useEffect already
                // does this check; the pull_state handler was missing it.
                let isWorkoutInProgress = false;
                try {
                  const startTimeRaw = await AsyncStorage.getItem('activeWorkoutStartTime');
                  if (startTimeRaw) {
                    const t = parseInt(startTimeRaw, 10);
                    if (Number.isFinite(t) && (Date.now() - t) < 4 * 3600_000) {
                      isWorkoutInProgress = true;
                    }
                  }
                } catch { /* AsyncStorage flake — assume not in workout */ }
                const status: 'scheduled' | 'active' | 'completed' | 'skipped' | 'rest' =
                  isWorkoutInProgress ? 'active'
                  : s.todayDone ? 'completed'
                  : s.skippedDates.has(todayKey()) ? 'skipped'
                  : todayItem?.isRest ? 'rest'
                  : 'scheduled';
                pushWorkoutToWatch(todayWorkout, {
                  dateISO: todayISO,
                  status,
                  readiness: s.readinessScore?.score ?? null,
                  readinessLabel: s.readinessScore?.label ?? null,
                }).catch(() => {});
                pushThemeToWatch(s.themePreference).catch(() => {});
                const todayPlan = s.nutritionPlansByDate[todayISO]
                  ?? (Object.values(s.nutritionPlansByDate)[0] as any);
                pushMealsToWatch(
                  todayPlan,
                  s.checkedMealsByDate[todayISO],
                  todayISO,
                  s.nutritionScoreData?.score ?? null,
                ).catch(() => {});
              } catch { /* bridge optional */ }
            })();
            return;
          }
          if (command === 'start_workout') {
            // Read from rePushStateRef (always current) instead of any
            // closure-captured value — the listener is registered once
            // and the ref carries the freshest schedule + plan.
            const refState = rePushStateRef.current;
            const liveSchedule = refState.schedule as any[];
            const today = liveSchedule?.[0]?.workout ?? refState.workoutPlan?.days?.[0];
            console.log('[watch cmd] start_workout — todayFocus=', today?.focus);
            if (today) watchCmdHandlersRef.current.start(today);
            else console.warn('[watch cmd] start_workout: no today workout available');
          } else if (command === 'skip_workout') {
            const refState = rePushStateRef.current;
            const liveSchedule = refState.schedule as any[];
            const today = liveSchedule?.[0]?.workout ?? refState.workoutPlan?.days?.[0];
            if (today) watchCmdHandlersRef.current.skip(today.focus);
          } else if (command === 'watch_log') {
            // Watch-side `wlog(...)` forwards Swift print lines so they
            // land in the phone's console output, visible via Console.app
            // on Mac (filter by ThalloWatch). Watch-side `print()` also
            // hits Console directly when the watch is tethered, so this
            // is mostly useful when the watch isn't physically reachable.
            const msg = String(payload?.msg ?? '');
            if (msg) console.log(msg);
          } else if (command === 'toggle_meal') {
            const mealType = String(payload?.mealType || '');
            const todayISO = new Date().toISOString().slice(0, 10);
            if (mealType) watchCmdHandlersRef.current.toggleMeal(todayISO, mealType);
          } else if (command === 'toggle_supplement') {
            // Watch tapped a supplement row — log the dose on the
            // phone, then re-push the stack so the watch picks up
            // the authoritative state (overrides the optimistic flip).
            (async () => {
              try {
                const id = Number(payload?.id ?? 0);
                if (!id) return;
                const taken = !!payload?.taken;
                const { logDose, getTodaySupplements } = await import('../services/api');
                if (!authToken) return;
                await logDose(authToken, id, { skipped: !taken }).catch(() => null);
                const fresh = await getTodaySupplements(authToken).catch(() => null);
                if (fresh) {
                  const { pushSupplementsToWatch } = await import('../utils/watchSync');
                  await pushSupplementsToWatch(
                    fresh.map(s => ({
                      id: s.id,
                      name: s.custom_name || 'Supplement',
                      dose: `${s.dose_amount}${s.dose_unit}`,
                      timing: s.timing ?? null,
                      taken: !!(s.logs_today || []).find(l => !l.skipped),
                      skipped: !!(s.logs_today || []).find(l => l.skipped),
                    })),
                  );
                }
              } catch { /* non-fatal */ }
            })();
          } else if (command === 'take_all_supplements') {
            // Bulk-log every pending stack item. Mirrors the phone's
            // "Take all (N)" button. Serial calls so backend timestamps
            // don't collide + round-trip order is predictable.
            (async () => {
              try {
                if (!authToken) return;
                const { logDose, getTodaySupplements } = await import('../services/api');
                const current = await getTodaySupplements(authToken).catch(() => null);
                if (!current) return;
                for (const s of current) {
                  const logs = s.logs_today || [];
                  if (logs.find(l => !l.skipped)) continue; // already taken
                  if (logs.find(l => l.skipped))  continue; // explicitly skipped
                  await logDose(authToken, s.id, { skipped: false }).catch(() => null);
                }
                const fresh = await getTodaySupplements(authToken).catch(() => null);
                if (fresh) {
                  const { pushSupplementsToWatch } = await import('../utils/watchSync');
                  await pushSupplementsToWatch(
                    fresh.map(s => ({
                      id: s.id,
                      name: s.custom_name || 'Supplement',
                      dose: `${s.dose_amount}${s.dose_unit}`,
                      timing: s.timing ?? null,
                      taken: !!(s.logs_today || []).find(l => !l.skipped),
                      skipped: !!(s.logs_today || []).find(l => l.skipped),
                    })),
                  );
                }
              } catch { /* non-fatal */ }
            })();
          } else if (command === 'cancel_workout') {
            // Watch-originated cancel — drop any in-progress phone-side
            // workout state AND mark today as skipped so the next watch
            // sync push goes out as status:'skipped' instead of
            // re-displaying the workout that was just cancelled.
            (async () => {
              try {
                const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
                const keys = await AsyncStorage.getAllKeys();
                const sessionKeys = keys.filter(k => k.startsWith('workoutSessionState_') || k.startsWith('activeWorkoutLogs_'));
                if (sessionKeys.length > 0) await AsyncStorage.multiRemove(sessionKeys);
              } catch { /* non-fatal */ }
              // Mark today's planned focus as skipped via the same handler
              // the phone Skip button uses. Without this, cancel-on-watch
              // would silently leave the workout "scheduled" and the next
              // reachability re-push would re-show it on the wrist.
              try {
                const todayItem = (rePushStateRef.current.schedule as any[])?.[0] ?? null;
                const focus = String(todayItem?.workout?.focus || todayItem?.focus || 'workout');
                watchCmdHandlersRef.current.skip(focus);
              } catch { /* non-fatal */ }
            })();
          }
          // Rest / set / end commands only fire inside an active
          // workout; ActiveWorkoutScreen owns those handlers.
        });
        if (token.cancelled) { try { unsub(); } catch {} }
        else { token.unsub = unsub; }
      } catch { /* optional */ }
    })();
    return () => {
      token.cancelled = true;
      if (token.unsub) { try { token.unsub(); } catch {} }
    };
  // Register the listener ONCE on mount and rely on
  // `watchCmdHandlersRef` + `rePushStateRef` for fresh state.
  // workoutPlan / onStartWorkout used to be deps but that thrashed the
  // listener on every parent re-render and leaked native listeners
  // through the async-import gap — both reads now go through the
  // refs (live schedule + start handler), which always carry the
  // latest values without re-registering.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload the preserved-completed-workouts overlay whenever the plan
  // changes or today's completion flag flips. Without this, trainer-chat
  // plan updates that call `setWorkoutPlan` directly (without bumping
  // `planRefreshKey`) leave the overlay stale — the new plan's today
  // rotation is displayed even though the user already completed a
  // different workout this morning.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const fresh = await loadPreservedCompletedWorkouts();
      if (mounted) setPreservedWorkouts(fresh);
    })();
    return () => { mounted = false; };
  }, [workoutPlan, todayDone]);

  useEffect(() => {
    const timer = setInterval(() => {
      const nowKey = todayKey();
      if (nowKey !== currentDate) {
        // Skip the rollover refresh while a plan is actively being
        // generated — reading/writing `aiWorkoutPlan` mid-gen can race
        // with the apply path and surface a half-merged plan.
        if (isWorkoutUpdating || isNutritionUpdating) return;
        setCurrentDate(nowKey);
        loadDayStatus();
        if (userProfile) loadPlans(userProfile);
      }
    }, 60000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDate, userProfile, authToken, isWorkoutUpdating, isNutritionUpdating]);

  const loadDayStatus = async () => {
    const today = todayKey();
    const mealDays = getNextMealDays(7);
    const checkMap: Record<string, MealChecks> = {};
    const skipped = new Set<string>();

    // Forward dates (strictly after today) should NEVER have meal checks —
    // you can't have eaten a meal that's still in the future. Drop any
    // checks the backend returns for those dates as a self-healing
    // measure against historical pollution. Today + past keep their
    // checks (those are the user's actual log).
    const dropForwardChecks = (dayKey: string, checks: MealChecks): MealChecks => {
      return dayKey > today ? {} : checks;
    };

    if (authToken) {
      const states = await Promise.all(mealDays.map(d => getDayState(authToken, d.key).catch(() => null)));
      mealDays.forEach((d, i) => {
        const s = states[i] as any;
        checkMap[d.key] = dropForwardChecks(d.key, s?.meal_checks ?? {});
        if (s?.skipped_focus) skipped.add(d.key);
      });
      // If we dropped any forward-date checks, mirror the cleanup back to
      // the DB so the next device sign-in doesn't re-pull the polluted data.
      const polluted = mealDays.filter((d, i) => {
        const s = states[i] as any;
        return d.key > today && s?.meal_checks && Object.keys(s.meal_checks).length > 0;
      });
      if (polluted.length > 0) {
        polluted.forEach(d => {
          upsertDayState(authToken, d.key, { meal_checks: {} }).catch(() => {});
        });
      }
    } else {
      const checksList = await Promise.all(mealDays.map(d => getMealChecks(d.key)));
      mealDays.forEach((d, i) => { checkMap[d.key] = dropForwardChecks(d.key, checksList[i] as MealChecks); });
    }

    // Merge historical meal checks (past days) so the calendar strip and
    // history tab show data beyond the forward 7-day window.
    try {
      const allHistoricalChecks = await getAllMealChecks();
      for (const [date, checks] of Object.entries(allHistoricalChecks)) {
        if (!checkMap[date]) checkMap[date] = checks;
      }
    } catch {}

    setSkippedDates(skipped);
    setCheckedMealsByDate(checkMap);

    // Load skip reasons + completed dates from local history
    const history = await loadWorkoutHistory();
    const reasonMap: Record<string, string> = {};
    const completed = new Set<string>();
    for (const s of history) {
      if (s.skipped && s.skipReason) reasonMap[s.date] = s.skipReason;
      if (s.completed && s.date) {
        const dKey = s.date.slice(0, 10);
        completed.add(dKey);
      }
    }
    setSkipReasonsByDate(reasonMap);
    setCompletedDates(completed);

    // Check workout completion from BOTH backend DB and local history.
    // Either source being true means the workout is done — this handles
    // the race where logWorkoutDone hasn't finished writing to the DB
    // yet but saveWorkoutSession already persisted locally.
    let done = false;
    try {
      if (authToken) {
        const status = await getWorkoutStatus(authToken, today);
        done = status.done;
      }
    } catch {}
    if (!done) {
      done = await isTodayWorkoutDone();
    }
    setTodayDone(done);
    if (done) {
      setCompletedDates(prev => { const next = new Set(prev); next.add(today); return next; });
    }

    // Load today's stored workout summary
    const summaries = await loadWorkoutSummaries();
    const todaySummaryEntry = summaries.find(s => s.date.startsWith(today)) ?? null;
    setTodaySummary(todaySummaryEntry);

    setPreservedWorkouts(await loadPreservedCompletedWorkouts());

    if (authToken) {
      try {
        const { getFatigueScore } = await import('../services/api');
        const fs = await getFatigueScore(authToken);
        setReadinessScore({ score: fs.readiness_score, label: fs.readiness_label, topFatigued: fs.top_fatigued ?? [], muscleFatigue: fs.muscle_fatigue ?? {}, activities: fs.activities ?? [], nutritionContext: fs.nutrition_context ?? null });
        console.log(`[fatigue] readiness=${fs.readiness_score}% top=${(fs.top_fatigued ?? []).map((t: any) => t.muscle).join(',')}`);
      } catch (e) {
        console.log('[fatigue] fetch failed:', e);
        // Show fresh state so the badge always appears
        setReadinessScore({ score: 100, label: 'Fresh', topFatigued: [] });
      }
      // Nutrition score is computed client-side from plan data (see updateNutritionScore)
      import('../services/api').then(({ getPlateaus }) =>
        getPlateaus(authToken, 4)
          .then(r => {
            const names = new Set((r.plateaus || []).map(p => p.exercise_name.toLowerCase()));
            setPlateauedExercises(names);
          })
          .catch(() => setPlateauedExercises(new Set()))
      );
    } else {
      setReadinessScore({ score: 100, label: 'Fresh', topFatigued: [] });
    }
  };

  const loadPlans = async (profile: UserProfile) => {
    // Track the latest profile so a post-finish rerun (triggered when an
    // effect fired during our in-flight run) always sees the newest snapshot.
    loadPlansLatestProfileRef.current = profile;
    // Drop concurrent / duplicate calls, but remember that one arrived so
    // we re-fire after the current run finishes. Without this, a
    // goal-change regen that bumps `planRefreshKey` mid-load gets
    // swallowed by the early-return guard and the UI stays on the
    // stale plan.
    if (loadPlansInFlightRef.current) {
      loadPlansRerunPendingRef.current = true;
      console.log('[loadPlans] already in flight — queuing rerun');
      return;
    }
    loadPlansInFlightRef.current = true;
    try {
    // Check for an AI-generated plan saved after user saves plan settings.
    // Falls back to a local client-side generator if nothing is cached — not
    // ideal (different-looking split names) but better than a blank screen.
    // The "plan swaps to a different split on re-login" bug is addressed via
    // (a) syncing aiWorkoutPlan across sign-out/sign-in, and (b) passing
    // focus_override to the fresh-day generator below so a PPL plan can't
    // get a foreign day spliced in.
    let aiWorkoutRaw = await AsyncStorage.getItem('aiWorkoutPlan');

    // Backend is the source of truth — ask it for the active WorkoutPlan
    // row and compare its `planner_version` to what we have cached. When
    // they match AND a cache exists, we keep the cache for zero-flicker
    // render. When they differ (or cache is missing), we overwrite from
    // the backend. On 404 or any network hiccup we silently fall back to
    // the AsyncStorage-only path — legacy users with no persisted plan
    // row still get served their cached plan.
    // Backend is ALWAYS the source of truth. On every load we fetch the
    // active plan and overwrite the cache if the backend has one. The
    // cache is a zero-flicker write-through only — we never prefer it
    // over a live backend read, even on version match. The only time
    // cache is used is when the backend is unreachable (network hiccup
    // / offline / 404 legacy user with no DB row).
    if (authToken && !skipBackendHydrationOnceRef.current) {
      try {
        const { getActiveWorkoutPlan } = await import('../services/api');
        const active = await getActiveWorkoutPlan(authToken);
        if (active?.plan_json) {
          const backendVersion = active.plan_json?._plannerVersion ?? active.planner_version ?? 'unknown';
          const serialized = JSON.stringify(active.plan_json);
          await AsyncStorage.setItem('aiWorkoutPlan', serialized).catch(() => {});
          aiWorkoutRaw = serialized;
          console.log(`[loadPlans] hydrated from backend (version=${backendVersion}) — cache overwritten`);
        } else {
          console.log('[loadPlans] backend returned no active plan — using AsyncStorage cache fallback');
        }
      } catch (e) {
        console.log('[loadPlans] active-plan fetch failed (using cache):', e);
      }
    } else if (skipBackendHydrationOnceRef.current) {
      skipBackendHydrationOnceRef.current = false;
      console.log('[loadPlans] skipping backend hydration (switch-day pin in AsyncStorage)');
    }

    if (!aiWorkoutRaw) {
      console.warn('[loadPlans] no saved aiWorkoutPlan — using local fallback');
    }
    let baseWorkout = aiWorkoutRaw ? JSON.parse(aiWorkoutRaw) : generateWorkoutPlan(profile);

    // Enrich all exercises with image URLs from the backend library.
    // This covers cached plans that were generated before image enrichment.
    if (baseWorkout?.days?.length) {
      try {
        const { getExercises } = await import('../services/api');
        const { refreshExerciseImageMap } = await import('../utils/exerciseImages');
        const library = await getExercises({});
        const imgMap = await refreshExerciseImageMap(library);
        console.log(`[loadPlans] exercise image map: ${imgMap.size} images`);
        if (imgMap.size > 0) {
          baseWorkout = {
            ...baseWorkout,
            days: baseWorkout.days.map((d: any) => ({
              ...d,
              exercises: (d.exercises ?? []).map((ex: any) => ({
                ...ex,
                image_url: ex.image_url || imgMap.get((ex.name || '').toLowerCase()) || undefined,
              })),
            })),
          };
        }
      } catch (e) {
        console.log(`[loadPlans] exercise image enrichment failed:`, e);
      }
    }
    setWorkoutPlan(baseWorkout);
    if (aiWorkoutRaw) {
      AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(baseWorkout)).catch(() => {});
    }

    // Generate a fresh workout for today — but only once per day.
    // Without this guard, every app open regenerates today's workout
    // with different exercise variation, which is confusing.
    if (authToken && baseWorkout?.days?.length) {
      const freshDayKey = `freshDayGenerated_${todayKey()}`;
      const alreadyGenerated = await AsyncStorage.getItem(freshDayKey).catch(() => null);
      // Also write the key immediately to prevent concurrent calls
      if (!alreadyGenerated) {
        await AsyncStorage.setItem(freshDayKey, 'pending').catch(() => {});
        try {
          const { generateWorkoutDay } = await import('../services/api');
          const todayIdx = completedDates.size % baseWorkout.days.length;
          // Pass focus_override = today's cached focus to STABILIZE
          // the daily auto-refresh against recipe drift (the day-7
          // PPL bug: forced-multiple-of-3 rule rebuilt the recipe and
          // changed day 7 from Lift to Cardio on every regen).
          //
          // BUT skip the pin when the cached focus would repeat what
          // the user just completed in the last 2 days. Pinning Pull
          // for today after a Pull yesterday would override the
          // planner's history-aware rotation and silently re-suggest
          // a recently-done focus. Without override → planner rotates
          // away naturally.
          const cachedFocus = baseWorkout.days[todayIdx]?.focus
            ? String(baseWorkout.days[todayIdx].focus)
            : undefined;
          // Family-key comparison so 'Pull' / 'Back & Biceps' / 'Pull
          // Day' all collapse to the same bucket.
          const _normFam = (f?: string | null): string => {
            const s = String(f ?? '').toLowerCase();
            if (/legs?|quad|glute|hamstring|lower|squat|hinge|calves/.test(s)) return 'lower';
            if (/push|chest|tricep|press/.test(s)) return 'push';
            if (/pull|back|bicep|lat/.test(s)) return 'pull';
            if (/upper|shoulder|arm/.test(s)) return 'upper';
            if (/full.?body|total/.test(s)) return 'full';
            if (/cardio|zone.?2|interval/.test(s)) return 'cardio';
            return s || 'unknown';
          };
          const recentDoneFams: string[] = [];
          try {
            const { loadWorkoutHistory } = await import('../utils/workoutHistory');
            const recent = (await loadWorkoutHistory()).slice(0, 3);
            for (const r of recent) {
              if (r?.focus && !r.skipped) recentDoneFams.push(_normFam(r.focus));
            }
          } catch { /* history read flake — fall through to normal pin */ }
          const cachedConflictsRecent = !!cachedFocus
            && recentDoneFams.includes(_normFam(cachedFocus));
          const safePin = cachedConflictsRecent ? undefined : cachedFocus;
          // Pass preceding plan-day focuses so the backend's split
          // rotation respects what the user has already queued up
          // (Switch Day picks, manual edits) even before those days
          // are completed in history. Newest-last (natural order).
          const prevFocuses: string[] = [];
          for (let k = 0; k < todayIdx; k += 1) {
            const f = baseWorkout.days[k]?.focus;
            if (f) prevFocuses.push(String(f));
          }
          const freshDay = await generateWorkoutDay(authToken, {
            goal: profile.goal,
            day_index: todayIdx,
            days_per_week: profile.daysPerWeek,
            session_minutes: profile.workoutDurationMinutes ?? 60,
            experience: profile.experienceLevel ?? 'intermediate',
            equipment: profile.equipment ?? [],
            preferred_split: profile.preferredSplit,
            priority_region: profile.priorityRegion ?? 'balanced',
            injuries: (profile.injuryEntries ?? []).filter(i => i.status !== 'resolved').map(i => `${i.bodyPart || i.description} (status: ${i.status})`),
            disliked_exercises: profile.dislikedExercises ?? [],
            prev_focuses: prevFocuses,
            focus_override: safePin,
          });
          if (freshDay?.day) {
            const updatedDays = [...baseWorkout.days];
            updatedDays[todayIdx % updatedDays.length] = freshDay.day;
            const updatedPlan = { ...baseWorkout, days: updatedDays };
            setWorkoutPlan(updatedPlan);
            await AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(updatedPlan)).catch(() => {});
            await AsyncStorage.setItem(freshDayKey, '1').catch(() => {});
            console.log(`[loadPlans] fresh day generated & saved: ${freshDay.day.focus} (idx ${todayIdx})`);
            // Surface backend's fatigue notice so the user knows WHY
            // sets shrunk today instead of it happening silently. The
            // notice only fires when fatigue >0.6 on a planned muscle
            // and no explicit focus override is in play.
            if (freshDay.fatigue_notice) {
              setFatigueNotice(freshDay.fatigue_notice);
            }
          }
        } catch (e) {
          console.log('[loadPlans] fresh day generation failed (using cached):', e);
        }
      } else {
        console.log('[loadPlans] fresh day already generated today, using cached plan');
      }
    }

    // Load nutrition templates. The canonical storage is now a JSON
    // array under `aiNutritionPlans` (dynamic length, matches the user's
    // chosen meal variety). Legacy A/B/C keys are read as a fallback so
    // users who haven't regenerated since the migration still see their
    // plan.
    //
    // Backend is the source of truth — ask it for the active
    // `NutritionPlan` row and compare its `planner_version` to what we
    // have cached. Mismatch or missing cache ⇒ overwrite from backend.
    // Version match AND cache exists ⇒ keep cache for zero-flicker
    // render. 404 / network hiccup ⇒ silently fall back to the
    // AsyncStorage path (legacy user with no persisted row). Mirrors the
    // workout-plan hydration block above.
    // Same policy as workout: backend is source of truth. Always overwrite
    // cache when backend returns a plan. Cache is a fallback ONLY for
    // network failure / 404 legacy users.
    if (authToken) {
      try {
        const { getActiveNutritionPlan } = await import('../services/api');
        const active = await getActiveNutritionPlan(authToken);
        if (active?.plans_json?.length) {
          const backendVersion =
            active.plans_json[0]?._plannerVersion ?? active.planner_version ?? 'unknown';
          await AsyncStorage.setItem('aiNutritionPlans', JSON.stringify(active.plans_json)).catch(() => {});
          // Keep legacy A/B/C mirrors in sync.
          await AsyncStorage.setItem('aiNutritionPlanA', JSON.stringify(active.plans_json[0] ?? null)).catch(() => {});
          if (active.plans_json[1]) {
            await AsyncStorage.setItem('aiNutritionPlanB', JSON.stringify(active.plans_json[1])).catch(() => {});
          } else {
            await AsyncStorage.removeItem('aiNutritionPlanB').catch(() => {});
          }
          if (active.plans_json[2]) {
            await AsyncStorage.setItem('aiNutritionPlanC', JSON.stringify(active.plans_json[2])).catch(() => {});
          } else {
            await AsyncStorage.removeItem('aiNutritionPlanC').catch(() => {});
          }
          if (active.trainer_note) {
            await AsyncStorage.setItem('nutritionistNote', active.trainer_note).catch(() => {});
          }
          console.log(`[loadPlans] nutrition hydrated from backend (version=${backendVersion}) — cache overwritten`);
        } else {
          console.log('[loadPlans] backend returned no active nutrition plan — using AsyncStorage fallback');
        }
      } catch (e) {
        console.log('[loadPlans] active-nutrition fetch failed (using cache):', e);
      }
    }

    const rawPlans = await AsyncStorage.getItem('aiNutritionPlans');
    let rotatingTemplates: DailyNutritionPlan[] = [];
    if (rawPlans) {
      try {
        const parsed = JSON.parse(rawPlans);
        if (Array.isArray(parsed)) {
          rotatingTemplates = parsed.filter(Boolean) as DailyNutritionPlan[];
        }
      } catch {}
    }
    if (rotatingTemplates.length === 0) {
      const [rawA, rawB, rawC] = await Promise.all([
        AsyncStorage.getItem('aiNutritionPlanA'),
        AsyncStorage.getItem('aiNutritionPlanB'),
        AsyncStorage.getItem('aiNutritionPlanC'),
      ]);
      rotatingTemplates = [
        rawA ? JSON.parse(rawA) : null,
        rawB ? JSON.parse(rawB) : null,
        rawC ? JSON.parse(rawC) : null,
      ].filter(Boolean) as DailyNutritionPlan[];
    }

    const mealDays = getNextMealDays(7);

    /** Returns true if the plan has at least one meal with real calorie data. */
    const hasMealMacros = (plan: DailyNutritionPlan | null | undefined): boolean => {
      if (!plan) return false;
      const migrated = migrateNutritionPlanShape(plan) as DailyNutritionPlan;
      const meals = migrated.meals ?? [];
      return meals.length > 0 && meals.some(m => (m?.calories ?? 0) > 0);
    };

    /** Returns true if the plan has Layer 2 micronutrient data on at
     *  least one meal. Used to reject stale saved plans from before
     *  the micronutrient expansion so the fresh rotating templates win. */
    const hasLayer2Micros = (plan: DailyNutritionPlan | null | undefined): boolean => {
      if (!plan) return false;
      const meals = plan.meals ?? [];
      const LAYER2 = ['saturated_fat', 'omega_3', 'potassium', 'calcium', 'iron', 'magnesium', 'vitamin_d', 'vitamin_b12'];
      return meals.some(m => {
        const micro: any = (m as any)?.micronutrients;
        if (!micro) return false;
        return LAYER2.some(k => typeof micro[k] === 'number' && micro[k] > 0);
      });
    };

    // Load routine meals once for the whole day loop. Any meal the user has
    // pinned as a routine gets overlaid on every day's plan so it appears
    // verbatim across the rotation.
    const routines = await loadMealRoutines();
    let _routineWarningShown = false;

    const localEntries = await Promise.all(
      mealDays.map(async (d, i) => {
        let picked: DailyNutritionPlan | null = null;
        // Precedence: locally saved per-day plan > remote day state >
        // rotating template > local fallback. Per-day saves win so user
        // edits (renames, added meals) persist across reloads. The
        // saves are explicitly wiped on regen via `clearAllSavedNutritionPlans`
        // so a fresh regen still rotates the new templates.
        // Templates carry a `_templatesVersion` stamp set on regen. Per-day
        // saves and remote day-state copy that stamp at write time so we can
        // detect stale data after a fresh regen and reject it. Without this,
        // the remote `day_state.nutrition_plan` from yesterday's plan keeps
        // overriding today's freshly-rotated template and variety=1 looks
        // like 7 different days.
        const currentVersion = (rotatingTemplates[0] as any)?._templatesVersion ?? null;
        const stampOk = (p: any) =>
          currentVersion == null || p?._templatesVersion === currentVersion;

        const normalize = (p: any): DailyNutritionPlan =>
          normalizeServingUnitsInPlan(migrateNutritionPlanShape(p)) as DailyNutritionPlan;

        // Precedence override: if the rotating template has Layer 2
        // micros, prefer it over saved/remote plans that don't. Stale
        // per-day saves from before the micronutrient expansion have
        // macros but no micros, and would otherwise shadow the fresh
        // data forever.
        const freshTemplate = rotatingTemplates.length > 0 ? rotatingTemplates[i % rotatingTemplates.length] : null;
        const templateHasMicros = hasLayer2Micros(freshTemplate);
        const pickedPathRef: { name: string } = { name: 'none' };

        const saved = await getSavedNutritionPlan(d.key);
        // User edits always win — only require macros + version stamp.
        // The old micros check was rejecting user edits that added foods
        // without micronutrient data (e.g. local library foods).
        const savedIsUsable = saved && hasMealMacros(saved) && stampOk(saved);
        console.log(`[loadPlans] ${d.key}: saved=${!!saved} meals=${saved?.meals?.length ?? 0} usable=${savedIsUsable} savedStamp=${(saved as any)?._templatesVersion ?? 'NONE'} currentStamp=${currentVersion ?? 'NONE'}`);
        if (savedIsUsable) {
          picked = normalize(saved);
          pickedPathRef.name = 'saved';
        }
        if (!picked && authToken) {
          const remote = await getDayState(authToken, d.key).catch(() => null) as any;
          const remoteOk = remote?.nutrition_plan && hasMealMacros(remote.nutrition_plan) && stampOk(remote.nutrition_plan);
          if (remoteOk) {
            picked = normalize(remote.nutrition_plan);
            pickedPathRef.name = 'remote';
          }
        }
        if (!picked && freshTemplate && hasMealMacros(freshTemplate)) {
          picked = normalize(freshTemplate);
          pickedPathRef.name = 'template';
        }
        if (!picked) {
          picked = normalize(generateDailyNutritionForDate(profile, allFoodsWithCustom, d.key));
          pickedPathRef.name = 'fallback';
        }
        // Diagnostic — first meal's micronutrient key count so we can
        // see whether data actually reached the UI layer.
        const firstMeal: any = picked?.meals?.[0];
        const firstMicros: any = firstMeal?.micronutrients ?? {};
        const microKeyCount = typeof firstMicros === 'object' ? Object.keys(firstMicros).length : 0;
        console.log(`[loadPlans] ${d.key}: path=${pickedPathRef.name} meals=${picked?.meals?.length ?? 0} micros_on_first_meal=${microKeyCount}`);
        // Stamp picked with the current templates version so subsequent
        // edits (rename, reorder, add meal) carry it forward into the
        // per-day save and remote day-state. Without the stamp, the
        // version check above would reject the user's own edits next load.
        if (picked && currentVersion != null) {
          (picked as any)._templatesVersion = currentVersion;
        }
        // ── Diagnostic: count meals coming out of the template picker ──
        const countBeforeOverlay = (picked.meals ?? []).length;

        // Order of layering:
        //   1. Routines first — they're the "every day" template and set
        //      up routine-backed extras with _routineId.
        //   2. Preserved checked meals — represent what the user logged.
        //      For fixed slots they overwrite; for extras we APPEND only
        //      the ones not already represented by a routine (matched by
        //      _routineId, _localId, or content signature). Then we run
        //      applyRoutines a SECOND time so the dedup logic there can
        //      reconcile anything the overlay brought in.
        if (routines.length > 0) {
          const mpd = profile?.mealsPerDay ?? 3;
          if (routines.length > mpd && !_routineWarningShown) {
            _routineWarningShown = true;
            setTimeout(() => {
              Alert.alert(
                'Too many routine meals',
                `You have ${routines.length} pinned routine meals but only ${mpd} meals per day. ` +
                `No new meals can be generated.\n\nYou can either:\n` +
                `• Increase meals per day in settings\n` +
                `• Unpin some routine meals`,
              );
            }, 500);
          }
          // Only trim + re-apply routines for template-sourced plans.
          // Saved/remote plans already have the user's edits (including
          // custom meals and routine meals) baked in — trimming them
          // would delete user-added meals.
          const isSavedOrRemote = pickedPathRef.name === 'saved' || pickedPathRef.name === 'remote';
          if (!isSavedOrRemote) {
            const genSlots = Math.max(0, mpd - routines.length);
            const currentMeals = picked.meals ?? [];
            if (currentMeals.length > genSlots) {
              picked = { ...picked, meals: currentMeals.slice(0, genSlots) };
            }
            picked = applyRoutines(picked, routines);
          }
        }
        const countAfterRoutines = (picked.meals ?? []).length;

        const preserved = await getPreservedMeals(d.key);
        const skipPreservedOverlay = pickedPathRef.name === 'saved' || pickedPathRef.name === 'remote';
        if (preserved.length > 0 && !skipPreservedOverlay) {
          // Merge preserved checked meals into the unified meals[] list,
          // deduping by _localId, _routineId, or content signature.
          const currentMeals = picked.meals ?? [];
          const currentSigs = new Set(
            currentMeals.map(m => `${m.meal}__${Math.round(m.calories ?? 0)}`),
          );
          const currentRoutineIds = new Set(
            currentMeals.map(m => (m as any)._routineId).filter(Boolean),
          );
          const currentLocalIds = new Set(
            currentMeals.map(m => (m as any)._localId).filter(Boolean),
          );
          const toAdd = preserved.filter(p => {
            const pLocal = (p as any)._localId;
            const pRoutine = (p as any)._routineId;
            const pSig = `${p.meal}__${Math.round(p.calories ?? 0)}`;
            // Dedupe on true identity first — same localId / routineId
            // means "this is the same meal being re-added in the overlay".
            if (pLocal && currentLocalIds.has(pLocal)) return false;
            if (pRoutine && currentRoutineIds.has(pRoutine)) return false;
            // Content-sig guard only applies when the preserved meal
            // has NO stable id. User-created meals (with _localId) are
            // explicit choices — logging the same saved meal twice
            // should not be silently filtered just because the macros
            // match. Without this refinement the second "Protein Shake"
            // of the day vanished on reload. Template meals without
            // ids still dedupe by sig so the auto-generated breakfast
            // doesn't duplicate a preserved breakfast.
            if (!pLocal && !pRoutine && currentSigs.has(pSig)) return false;
            return true;
          });
          if (toAdd.length > 0) {
            picked = { ...picked, meals: [...currentMeals, ...toAdd] };
            if (routines.length > 0) picked = applyRoutines(picked, routines);
          }
        }
        const countAfterPreserved = (picked.meals ?? []).length;

        // ── Hard guard: enforce meals-per-day budget ──
        // Only trim template/fallback plans — saved/remote plans already
        // reflect the user's explicit edits (added meals, routines, etc.)
        // and should never be capped.
        const preservedAdded = skipPreservedOverlay ? 0 : (preserved?.length ?? 0);
        const expectedCount = (profile?.mealsPerDay ?? 3) + preservedAdded;
        const currentCount = (picked.meals ?? []).length;
        const userSavedPlan = pickedPathRef.name === 'saved' || pickedPathRef.name === 'remote';
        if (currentCount > expectedCount && !userSavedPlan) {
          console.warn(
            `[loadPlans] ${d.key}: meal count overage — template=${countBeforeOverlay}, ` +
            `afterRoutines=${countAfterRoutines}, afterPreserved=${countAfterPreserved}, ` +
            `expected<=${expectedCount} (mealsPerDay=${profile?.mealsPerDay ?? 3}, ` +
            `routines=${routines.length}, preserved=${preserved.length}). Trimming tail.`,
          );
          // Trim strategy: keep all routine-tagged and preserved (local-id)
          // meals first; then fill up to `expectedCount` with non-routine
          // meals from the head of the list. This preserves user-visible
          // intent (routines + logged meals win) while dropping the
          // overflow generated meals.
          const meals = picked.meals ?? [];
          const routineMeals = meals.filter(m => !!(m as any)._routineId);
          const preservedMeals = meals.filter(m => !(m as any)._routineId && !!(m as any)._localId);
          const regularMeals = meals.filter(m => !(m as any)._routineId && !(m as any)._localId);
          const slotsLeft = Math.max(0, expectedCount - routineMeals.length - preservedMeals.length);
          const trimmed = [...regularMeals.slice(0, slotsLeft), ...preservedMeals, ...routineMeals];
          picked = { ...picked, meals: trimmed };
        } else if (countBeforeOverlay !== undefined) {
          console.log(
            `[loadPlans] ${d.key}: ok — template=${countBeforeOverlay}, ` +
            `afterRoutines=${countAfterRoutines}, afterPreserved=${countAfterPreserved}, ` +
            `mealsPerDay=${profile?.mealsPerDay ?? 3}, routines=${routines.length}, preserved=${preserved.length}`,
          );
        }
        return [d.key, picked] as const;
      })
    );
    const raw: Record<string, DailyNutritionPlan> = Object.fromEntries(localEntries);

    // Merge historical per-day plans so the calendar strip and history tab
    // have past data. Forward days from template rotation take precedence.
    try {
      const historicalPlans = await getAllSavedNutritionPlans();
      for (const [date, plan] of Object.entries(historicalPlans)) {
        if (!raw[date] && plan) {
          raw[date] = migrateNutritionPlanShape(plan) as DailyNutritionPlan;
        }
      }
    } catch {}

    setNutritionPlansByDate(raw);

    // ── Background enrichment for routine/custom meals missing micros ──
    // Routine meals are overlaid client-side and never go through the
    // server's post-assembly enrichment. Fire a background call to fill
    // in micros for any items that lack them.
    if (authToken) {
      _enrichRoutineMealsMicros(raw, authToken, routines, setNutritionPlansByDate);
      _backfillFoodClassifications(raw, authToken, setNutritionPlansByDate);
    }
    } finally {
      loadPlansInFlightRef.current = false;
    }
    // If a trigger arrived while we were running (e.g. goal-change
    // regen bumped `planRefreshKey` mid-load), run once more against the
    // latest profile so the UI reflects the most recent plan write.
    if (loadPlansRerunPendingRef.current) {
      loadPlansRerunPendingRef.current = false;
      const latest = loadPlansLatestProfileRef.current;
      if (latest) {
        console.log('[loadPlans] rerunning with latest profile (queued during previous run)');
        // Fire and forget — exceptions surface via internal try/catch.
        loadPlans(latest).catch(() => {});
      }
    }
  };

  const applySuppResult = (res: Awaited<ReturnType<typeof lookupSupplement>>, fallbackName: string) => {
    if (!res.found) {
      setSuppAiNotFound(true);
    } else {
      setSuppAiResult({
        name:       res.name ?? fallbackName,
        category:   res.category ?? 'Other',
        icon:       '💊',
        tagline:    res.tagline ?? '',
        whatItDoes: res.whatItDoes ?? '',
        evidence:   (res.evidence as any) ?? 'limited',
        dose:       res.dose ?? '',
        timing:     res.timing ?? '',
        goodFor:    res.goodFor ?? [],
        cautions:   res.cautions ?? '',
      });
    }
  };

  // Add supplement to user's profile locally (since supplements now managed via Edit Meal Plan)
  const handleAddSupplement = async (name: string) => {
    try {
      const raw = await AsyncStorage.getItem('userProfile');
      if (!raw) return;
      const p: UserProfile = JSON.parse(raw);
      if ((p.supplementsAvailable ?? []).includes(name)) return;
      const updated = { ...p, supplementsAvailable: [...(p.supplementsAvailable ?? []), name] };
      await AsyncStorage.setItem('userProfile', JSON.stringify(updated));
    } catch {}
  };

  const handleSuppAiSearch = async () => {
    const q = suppAiQuery.trim();
    if (!q || !authToken) return;
    setSuppAiLoading(true);
    setSuppAiResult(null);
    setSuppAiNotFound(false);
    try {
      const res = await lookupSupplement(authToken, q);
      applySuppResult(res, q);
    } catch (e: any) {
      Alert.alert('Lookup failed', e?.message ?? 'Could not look up this supplement.');
    } finally {
      setSuppAiLoading(false);
    }
  };

  const handleSuppPhotoSearch = async () => {
    if (!authToken) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      const cam = await ImagePicker.requestCameraPermissionsAsync();
      if (!cam.granted) { Alert.alert('Permission needed', 'Allow camera or photo library access.'); return; }
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.7, base64: true, mediaTypes: ['images'] as any, maxWidth: 1024, maxHeight: 1024 } as any);
    if (result.canceled || !result.assets?.[0]?.base64) return;
    const asset = result.assets[0];
    setSuppAiLoading(true);
    setSuppAiResult(null);
    setSuppAiNotFound(false);
    setSuppAiQuery('');
    try {
      const res = await lookupSupplementFromPhoto(authToken, { image_base64: asset.base64!, mime_type: 'image/jpeg' });
      applySuppResult(res, 'Unknown supplement');
    } catch (e: any) {
      Alert.alert('Photo lookup failed', e?.message ?? 'Could not identify supplement from photo.');
    } finally {
      setSuppAiLoading(false);
    }
  };

  // Pure library-fetch, no side effects on modal visibility. Shared
  // between openExerciseLibrary (Library sub-tab) and the plan-view
  // swap flow (warmed lazily when the user taps Swap). Returns the
  // loaded list so callers that need it synchronously (e.g. Info
  // button looking up the tapped exercise) don't have to wait for
  // state to propagate through React.
  const ensureExerciseLibrary = useCallback(async (): Promise<ExerciseLibraryItem[]> => {
    if (exerciseLibrary.length > 0) return exerciseLibrary;
    setExerciseLibraryLoading(true);
    try {
      const rows = await getExercises();
      const customs = (userProfile?.customExercises ?? []).map(ce => ({
        id: ce.id as any,
        name: ce.name,
        primary_muscle: ce.primary_muscle,
        secondary_muscles: [] as string[],
        equipment: ce.equipment,
        description: ce.description ?? '',
        is_custom: true,
      })) as unknown as ExerciseLibraryItem[];
      const combined = [...customs, ...rows];
      setExerciseLibrary(combined);
      // Prime the shared name/slug → video_id index so stale
      // WorkoutPlan snapshots (generated before video_id existed on
      // build_planner_exercise) can still render thumbnails via
      // name/slug lookup. Means users don't need a forced plan regen
      // to see previews.
      primeThumbnailIndex(combined as any);
      return combined;
    } catch {
      const customs = (userProfile?.customExercises ?? []).map(ce => ({
        id: ce.id as any,
        name: ce.name,
        primary_muscle: ce.primary_muscle,
        secondary_muscles: [] as string[],
        equipment: ce.equipment,
        description: ce.description ?? '',
        is_custom: true,
      })) as unknown as ExerciseLibraryItem[];
      setExerciseLibrary(customs);
      return customs;
    } finally {
      setExerciseLibraryLoading(false);
    }
  }, [exerciseLibrary, userProfile?.customExercises]);

  const openExerciseLibrary = useCallback(async () => {
    setShowExerciseLibrary(true);
    await ensureExerciseLibrary();
  }, [ensureExerciseLibrary]);

  /** Save an AI-search result into the user's custom exercise library so
   *  future local searches find it without another AI call. Persists via
   *  `onProfileUpdate` so AsyncStorage + backend sync pick it up. */
  const handleSaveAiExerciseToLibrary = useCallback(async (ex: import('../services/api').AIExerciseResult) => {
    if (!userProfile) return;
    const existing = userProfile.customExercises ?? [];
    if (existing.some(e => e.name.toLowerCase() === ex.name.toLowerCase())) {
      Alert.alert('Already in library', `${ex.name} is already saved.`);
      return;
    }
    const newItem: import('../types').CustomExerciseItem = {
      id: `custom_${Date.now()}`,
      name: ex.name,
      primary_muscle: ex.primary_muscle,
      equipment: ex.equipment,
      sets: ex.sets,
      reps: ex.reps,
      rest_seconds: ex.rest_seconds,
      description: ex.why,
      form_cues: ex.form_cues,
      source: 'ai',
      createdAt: new Date().toISOString(),
    };
    const nextCustoms = [...existing, newItem];
    // Optimistically add to the in-memory library so it shows up immediately.
    setExerciseLibrary(prev => [
      ({
        id: newItem.id as any,
        name: newItem.name,
        primary_muscle: newItem.primary_muscle,
        secondary_muscles: [] as string[],
        equipment: newItem.equipment,
        description: newItem.description ?? '',
        is_custom: true,
      }) as unknown as ExerciseLibraryItem,
      ...prev,
    ]);
    // Persist via the parent's profile-update callback. `skipRegen: true`
    // so we don't trigger a plan regeneration just from saving an exercise.
    onProfileUpdate?.({ customExercises: nextCustoms } as any, true);
    Alert.alert('Saved', `${ex.name} added to your exercise library.`);
  }, [userProfile, onProfileUpdate]);

  const exerciseMuscleOptions = Array.from(
    new Set(exerciseLibrary.map((item) => item.primary_muscle).filter(Boolean) as string[])
  ).sort((a, b) => humanizeToken(a).localeCompare(humanizeToken(b)));

  const exerciseEquipmentOptions = Array.from(
    new Set(exerciseLibrary.map((item) => item.equipment).filter(Boolean) as string[])
  ).sort((a, b) => humanizeToken(a).localeCompare(humanizeToken(b)));

  const filteredExerciseLibrary = exerciseLibrary.filter((item) => {
    const search = exerciseSearch.trim().toLowerCase();
    const matchesSearch = !search || [
      item.name,
      item.description ?? '',
      humanizeToken(item.primary_muscle),
      humanizeToken(item.equipment),
      ...(item.secondary_muscles ?? []).map(humanizeToken),
    ].some((value) => value.toLowerCase().includes(search));
    const matchesMuscle = exerciseMuscleFilter === 'all' || item.primary_muscle === exerciseMuscleFilter;
    const matchesEquipment = exerciseEquipmentFilter === 'all' || item.equipment === exerciseEquipmentFilter;
    return matchesSearch && matchesMuscle && matchesEquipment;
  });

  const summarizeTrainerUpdate = useCallback((
    prevWorkout: WorkoutPlan | null,
    nextWorkout: WorkoutPlan | null,
    prevNutrition: DailyNutritionPlan | null,
    nextNutrition: DailyNutritionPlan | null,
  ): string => {
    const notes: string[] = [];

    if (nextWorkout) {
      const prevDays = prevWorkout?.days?.length ?? 0;
      const nextDays = nextWorkout?.days?.length ?? 0;
      if (prevDays !== nextDays) notes.push(`Workout days: ${prevDays} → ${nextDays}`);

      const prevExercises = (prevWorkout?.days ?? []).reduce((sum, d) => sum + (d.exercises?.length ?? 0), 0);
      const nextExercises = (nextWorkout?.days ?? []).reduce((sum, d) => sum + (d.exercises?.length ?? 0), 0);
      if (prevExercises !== nextExercises) notes.push(`Weekly exercises: ${prevExercises} → ${nextExercises}`);
    }

    if (prevNutrition && nextNutrition && prevNutrition.targets && nextNutrition.targets) {
      const prevCal = prevNutrition.targets.calories;
      const nextCal = nextNutrition.targets.calories;
      if (prevCal !== nextCal) notes.push(`Calories: ${prevCal} → ${nextCal}`);

      const prevProtein = prevNutrition.targets.protein;
      const nextProtein = nextNutrition.targets.protein;
      if (prevProtein !== nextProtein) notes.push(`Protein: ${prevProtein}g → ${nextProtein}g`);
    }

    return notes.length ? notes.join(' • ') : 'Trainer updated exercise/nutrition structure.';
  }, []);

  const handleAskTrainer = useCallback(async () => {
    const q = trainerInput.trim();
    if (!q) return;
    if (!authToken || !userProfile) {
      Alert.alert('Unavailable', 'Please sign in first.');
      return;
    }
    // Pro-only: AI coach chat. Free users see an upgrade alert.
    const { requirePro } = await import('../utils/subscription');
    if (!requirePro(userProfile, 'ai_coach')) return;
    if (coachMode === 'trainer' && !workoutPlan) {
      Alert.alert('Unavailable', 'Your workout plan is still loading. Please try again in a moment.');
      return;
    }

    const isTrainer = coachMode === 'trainer';
    const activeChat = isTrainer ? workoutChat : workoutChat;
    const setActiveChat = setWorkoutChat;  // unified single chat
    const setUpdateSummary = setWorkoutUpdateSummary;  // unified

    const userMsg: TrainerChatMessage = { role: 'user', content: q + (attachedImage ? ' [photo attached]' : '') };
    const nextChat = [...activeChat, userMsg];
    setActiveChat(nextChat);
    setTrainerInput('');
    const imageToSend = attachedImage;
    setAttachedImage(null);
    setTrainerLoading(true);
    const abortCtrl = new AbortController();
    trainerAbortRef.current = abortCtrl;

    try {
      const todayPlan = nutritionPlansByDate[todayKey()] ?? null;

      // Load userLog for AI context (same as plan generation)
      const userLogRaw = await AsyncStorage.getItem('userLog');
      const userLog: Array<{ date: string; summary: string }> = userLogRaw ? JSON.parse(userLogRaw) : [];
      const userContext = userLog
        .slice(0, 10)
        .map(e => `[${e.date.slice(0, 10)}] ${e.summary}`)
        .join('\n') || undefined;

      const workoutHistory = await loadWorkoutHistory();
      // Only send last 5 sessions (not 40) — keeps payload small enough for model context
      const recentHistory = workoutHistory.slice(0, 6).map((s) => ({
        date: s.date,
        focus: s.focus,
        durationMinutes: Math.round((s.durationSeconds || 0) / 60),
        completed: s.completed,
        skipped: s.skipped ?? false,
        manuallyLogged: (s.exercises ?? []).length === 0 && s.completed,
        exercises: (s.exercises ?? []).slice(0, 6).map((ex) => ({
          name: ex.name,
          setsLogged: ex.sets?.length ?? 0,
        })),
      }));

      const sessionsLast30d = workoutHistory.filter((s) => {
        const ts = new Date(s.date).getTime();
        return Number.isFinite(ts) && (Date.now() - ts) <= 30 * 24 * 60 * 60 * 1000;
      }).length;

      const totalSetsLogged = workoutHistory.reduce(
        (sum, s) => sum + (s.exercises ?? []).reduce((setSum, ex) => setSum + (ex.sets?.length ?? 0), 0),
        0
      );

      // Last 3 calendar days — includes skips so the trainer knows recent context
      const last3Days = [0, 1, 2].map(offset => {
        const d = new Date();
        d.setDate(d.getDate() - offset);
        const dKey = dateKey(d);
        const session = workoutHistory.find(s => s.date.startsWith(dKey));
        if (session) {
          if (session.skipped) {
            return {
              date: dKey,
              status: `skipped${session.skipReason ? ` — ${session.skipReason}` : ''}`,
              focus: session.focus,
              durationMinutes: null as number | null,
              setsLogged: 0,
            };
          }
          return {
            date: dKey,
            status: session.completed ? 'completed' : 'incomplete',
            focus: session.focus,
            durationMinutes: Math.round(session.durationSeconds / 60),
            setsLogged: (session.exercises ?? []).reduce((sum, ex) => sum + (ex.sets ?? []).length, 0),
          };
        }
        // Fall back to in-memory skippedDates for today
        if (skippedDates.has(dKey)) {
          return { date: dKey, status: 'skipped', focus: null, durationMinutes: null, setsLogged: 0 };
        }
        return { date: dKey, status: 'no record', focus: null, durationMinutes: null, setsLogged: 0 };
      });

      const progress = {
        goal: userProfile.goal,
        todayDone,
        skippedDays: Array.from(skippedDates),
        daysPerWeek: userProfile.daysPerWeek,
        durationMinutes: userProfile.workoutDurationMinutes,
        sessionsLast30d,
        totalSessions: workoutHistory.length,
        totalSetsLogged,
        workoutHistory: recentHistory,
        recentDays: last3Days,
      };

      // Build a structured summary of the current plan so the AI always knows what to modify
      // Include calendar mapping so AI knows which plan day = which real date
      const today = new Date();
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const scheduleMapping = schedule.filter(s => !s.isRest && s.workout).map(s => {
        const calDate = dateKey(s.date);
        const isToday = calDate === todayKey();
        const isTomorrow = (() => { const t = new Date(); t.setDate(t.getDate() + 1); return calDate === dateKey(t); })();
        const dayLabel = isToday ? 'today' : isTomorrow ? 'tomorrow' : dayNames[s.date.getDay()];
        return { calendarDate: calDate, dayLabel, planDay: s.workout!.day, focus: s.workout!.focus };
      });

      const currentPlanContext = {
        scheduleMapping,  // e.g. [{calendarDate: "2026-04-11", dayLabel: "today", planDay: "Day 1", focus: "Upper Body"}, ...]
        workoutDays: (workoutPlan?.days ?? []).map(d => ({
          focus: d.focus,
          exercises: (d.exercises ?? []).map(e => ({ name: e.name, sets: e.sets, reps: e.reps })),
        })),
        todayMeals: todayPlan
          ? (todayPlan.meals ?? []).map((m, idx) => ({
              type: `meal_${idx}`,
              meal: m.meal,
              foods: m.foods ?? [],
              calories: m.calories ?? 0,
              protein: m.protein ?? 0,
            }))
          : [],
        mealRoutine: userProfile.mealRoutine,
      };

      const slimProfile = {
        goal: userProfile.goal,
        goalSelection: userProfile.goalSelection,
        goalDetails: userProfile.goalDetails,
        physicalStats: userProfile.physicalStats,
        daysPerWeek: userProfile.daysPerWeek,
        workoutDurationMinutes: userProfile.workoutDurationMinutes,
        preferredSplit: userProfile.preferredSplit,
        priorityRegion: userProfile.priorityRegion ?? 'balanced',
        equipment: userProfile.equipment,
        mealRoutine: userProfile.mealRoutine,
        injuries: userProfile.injuries,
        injuryEntries: userProfile.injuryEntries ?? [],
        experienceLevel: userProfile.experienceLevel,
      };

      const resp = await askTrainerQuestion(authToken, {
        question: q,
        mode: 'trainer',  // unified coach — handles both workout and nutrition
        topic: chatTopic,
        profile: slimProfile,
        workoutPlan: workoutPlan ?? undefined,
        nutritionPlan: todayPlan ?? undefined,
        currentPlanContext,
        progress: {
          goal: progress.goal,
          todayDone: progress.todayDone,
          sessionsLast30d: progress.sessionsLast30d,
          totalSessions: progress.totalSessions,
          recentDays: progress.recentDays,
          recentHistory: progress.workoutHistory,
        },
        conversation: nextChat.slice(-6),
        image_base64: imageToSend?.base64 ?? undefined,
        mime_type: 'image/jpeg',
        userContext,
      });

      const actionLines = (resp.action_items ?? []).slice(0, 4).map((x: string) => `• ${x}`).join('\n');
      const combined = [
        resp.answer,
        actionLines ? `\n${actionLines}` : '',
        resp.safety_note ? `\nSafety: ${resp.safety_note}` : '',
      ].join('');

      // Show the answer immediately — don't wait for plan application.
      // Quick-intent responses carry an `action` dict; we surface it
      // so the chat row gets an "Apply" button that hits the same
      // durable-state apply path as the weekly review card.
      setActiveChat(prev => [...prev, {
        role: 'assistant',
        content: combined,
        intent: (resp as any).intent ?? null,
        action: (resp as any).action ?? null,
      }]);
      setTrainerLoading(false);

      // Unified coach can update both workout and nutrition
      const canUpdateWorkout   = true;
      const canUpdateNutrition = true;
      const hasUpdate = (canUpdateWorkout && !!resp.updated_workout_plan) || (canUpdateNutrition && !!resp.updated_nutrition_plan);
      console.log('[handleAskTrainer] plan update check:', { needs: resp.needs_plan_update, hasUpdate, canW: canUpdateWorkout, canN: canUpdateNutrition, hasWP: !!resp.updated_workout_plan, hasNP: !!resp.updated_nutrition_plan });

      const hasStructuredGoal = typeof (resp as any).updated_goal === 'string' && (resp as any).updated_goal.trim().length > 0;
      const hasMacroUpdate = !!(resp as any).updated_macros && typeof (resp as any).updated_macros === 'object' && Object.keys((resp as any).updated_macros).length > 0;
      if ((resp.needs_plan_update && hasUpdate) || hasStructuredGoal || hasMacroUpdate) {
        // Detect profile changes from the plan diff + user question
        const profileChanges: Partial<UserProfile> = {};
        const summaryParts: string[] = [];
        if (canUpdateWorkout && resp.updated_workout_plan) {
          const newPlan = resp.updated_workout_plan as WorkoutPlan;
          const newDays = Array.isArray(newPlan.days) ? newPlan.days.length : (newPlan.totalDays ?? 0);
          if (newDays > 0 && newDays !== (userProfile?.daysPerWeek ?? 0)) {
            profileChanges.daysPerWeek = newDays;
            summaryParts.push(`Training days: ${userProfile?.daysPerWeek ?? '?'} → ${newDays}`);
          }
          // Detect exercise changes
          const prevExCount = (workoutPlan?.days ?? []).reduce((s, d) => s + (d.exercises?.length ?? 0), 0);
          const nextExCount = (newPlan.days ?? []).reduce((s: number, d: any) => s + (d.exercises?.length ?? 0), 0);
          if (prevExCount !== nextExCount) summaryParts.push(`Exercises: ${prevExCount} → ${nextExCount}`);
          // Detect focus changes
          const prevFocuses = (workoutPlan?.days ?? []).map(d => d.focus).join(', ');
          const nextFocuses = (newPlan.days ?? []).map((d: any) => d.focus).join(', ');
          if (prevFocuses !== nextFocuses) summaryParts.push('Day focuses changed');
        }
        if (canUpdateNutrition && resp.updated_nutrition_plan) {
          const np = resp.updated_nutrition_plan as any;
          const todayPlanLocal = nutritionPlansByDate[todayKey()];
          if (np.targets && todayPlanLocal?.targets) {
            if (np.targets.calories !== todayPlanLocal.targets.calories) summaryParts.push(`Calories: ${todayPlanLocal.targets.calories} → ${np.targets.calories}`);
            if (np.targets.protein !== todayPlanLocal.targets.protein) summaryParts.push(`Protein: ${todayPlanLocal.targets.protein}g → ${np.targets.protein}g`);
          }
          summaryParts.push('Meal plan updated');
        }
        // Goal changes: prefer the structured `updated_goal` field from the AI response.
        // Fall back to string matching for backwards compatibility with older backend versions.
        const structuredGoalRaw = typeof (resp as any).updated_goal === 'string' ? (resp as any).updated_goal.trim() : '';
        const structuredGoal = structuredGoalRaw || null;
        let matchedGoal: typeof PRIMARY_GOALS[number] | null = null;
        if (structuredGoal) {
          matchedGoal = PRIMARY_GOALS.find(g => g.id === structuredGoal) ?? null;
        }
        if (!matchedGoal) {
          const combinedText = `${q} ${resp.answer ?? ''}`.toLowerCase();
          const sortedGoals = [...PRIMARY_GOALS].sort((a, b) => b.label.length - a.label.length);
          for (const g of sortedGoals) {
            const labelLower = g.label.toLowerCase();
            const idAsWords = g.id.replace(/_/g, ' ');
            if (combinedText.includes(labelLower) || combinedText.includes(idAsWords)) {
              matchedGoal = g;
              break;
            }
          }
        }
        if (matchedGoal && matchedGoal.id !== userProfile?.goal) {
          profileChanges.goal = matchedGoal.id as any;
          summaryParts.push(`Goal: ${userProfile?.goal?.replace(/_/g, ' ') ?? '?'} → ${matchedGoal.label}`);
        }

        // Macro target adjustments — AI returns partial {calories?, protein?, carbs?, fat?}
        const updatedMacros = (resp as any).updated_macros;
        if (updatedMacros && typeof updatedMacros === 'object') {
          const current = userProfile?.customMacros ?? {};
          const merged = { ...current };
          if (updatedMacros.calories != null) merged.calories = updatedMacros.calories;
          if (updatedMacros.protein != null) merged.protein = updatedMacros.protein;
          if (updatedMacros.carbs != null) merged.carbs = updatedMacros.carbs;
          if (updatedMacros.fat != null) merged.fat = updatedMacros.fat;
          profileChanges.customMacros = merged as any;
          const parts: string[] = [];
          if (updatedMacros.calories != null) parts.push(`${updatedMacros.calories} cal`);
          if (updatedMacros.protein != null) parts.push(`${updatedMacros.protein}g protein`);
          if (updatedMacros.carbs != null) parts.push(`${updatedMacros.carbs}g carbs`);
          if (updatedMacros.fat != null) parts.push(`${updatedMacros.fat}g fat`);
          if (parts.length > 0) summaryParts.push(`Macros → ${parts.join(', ')}`);
        }

        const summary = summaryParts.length > 0 ? summaryParts.join(' · ') : (coachMode === 'trainer' ? 'Workout plan updated' : 'Meal plan updated');
        // Store as pending — wait for user approval
        setPendingUpdate({ resp, question: q, coachMode, profileChanges, summary });
        console.log('[handleAskTrainer] pending update stored for approval:', summary);
      }

      // Handle injury updates — store as pending, show Apply button in chat
      if (coachMode === 'trainer' && resp.updated_injuries && Array.isArray(resp.updated_injuries) && resp.updated_injuries.length > 0) {
        const incoming: InjuryEntry[] = resp.updated_injuries.map((inj: any) => {
          const now = new Date().toISOString();
          const recoveryDays = inj.estimatedRecoveryDays ? Number(inj.estimatedRecoveryDays) : undefined;
          const recoveryDate = recoveryDays
            ? new Date(Date.now() + recoveryDays * 86400000).toISOString().slice(0, 10)
            : undefined;
          return {
            id: inj.id || Date.now().toString() + Math.random().toString(36).slice(2),
            description: inj.description ?? '',
            bodyPart: inj.bodyPart ?? '',
            muscleGroups: Array.isArray(inj.muscleGroups) ? inj.muscleGroups : undefined,
            severity: ['mild', 'moderate', 'severe'].includes(inj.severity) ? inj.severity : undefined,
            reportedAt: now,
            estimatedRecoveryDays: recoveryDays,
            estimatedRecoveryDate: recoveryDate,
            status: inj.status ?? 'active',
            statusUpdatedAt: now,
            notes: inj.notes,
          };
        });
        setPendingInjuries(incoming);
        console.log('[handleAskTrainer] injury pending approval:', incoming.length, 'entries');
      }

      // Handle workout logging immediately (no approval needed)
      if (coachMode === 'trainer' && resp.logged_workouts && Array.isArray(resp.logged_workouts) && resp.logged_workouts.length > 0) {
        try {
          const today = todayKey();
          for (const w of resp.logged_workouts) {
            const session: WorkoutSession = {
              id: `chat-${w.date}-${Date.now()}`,
              date: new Date(w.date + 'T12:00:00').toISOString(),
              focus: w.focus || 'General',
              durationSeconds: w.durationSeconds || 3600,
              exercises: (w.exercises ?? []).map((ex: any) => ({
                name: ex.name,
                targetSets: ex.sets?.length ?? 0,
                targetReps: '',
                targetRestSeconds: 60,
                equipment: '',
                sets: (ex.sets ?? []).map((s: any) => ({
                  weightLbs: s.weightLbs ?? 0,
                  reps: s.reps ?? 0,
                })),
              })),
              completed: true,
            };
            await saveWorkoutSession(session);
            if (authToken) {
              logWorkoutDone(authToken, w.date, session.focus, session.durationSeconds).catch(() => null);
            }
            if (w.date === today) {
              setTodayDone(true);
            }
          }
          console.log(`[handleAskTrainer] logged ${resp.logged_workouts.length} workout session(s) from chat`);
        } catch (logErr) {
          console.error('[handleAskTrainer] failed to save workout log:', logErr);
        }
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      console.error('[handleAskTrainer] FULL ERROR:', msg, e?.stack ?? '');
      const isTimeout = msg.includes('timed out') || msg.includes('timeout') || msg.includes('aborted');
      const isNetwork = msg.includes('Network request failed') || msg.includes("Can't reach");
      const userMsg = isTimeout
        ? 'The request took too long. The server may be busy — please try again in a moment.'
        : isNetwork
        ? 'Could not reach the server. Check that the backend is running and you are on the same network.'
        : `Could not answer right now: ${msg.slice(0, 200)}`;
      setActiveChat(prev => [...prev, { role: 'assistant', content: userMsg }]);
    } finally {
      setTrainerLoading(false);
    }
  }, [trainerInput, attachedImage, authToken, userProfile, workoutPlan, nutritionPlansByDate, todayDone, skippedDates, workoutChat, workoutChat, coachMode, chatTopic, persistDayState]);

  // ── Approval flow for plan changes ───────────────────────────────────────
  const applyPendingUpdate = useCallback(async () => {
    if (!pendingUpdate) return;
    const { resp, question: q, coachMode: mode, profileChanges } = pendingUpdate;
    const setActiveChat = mode === 'trainer' ? setWorkoutChat : setWorkoutChat;
    setIsChatPlanUpdating(true);
    setPendingUpdate(null);
    try {
      const canUpdateWorkout   = true;
      const canUpdateNutrition = true;
      const prevWorkout = workoutPlan;
      const nextWorkout = (canUpdateWorkout && resp.updated_workout_plan) ? resp.updated_workout_plan as WorkoutPlan : null;
      let appliedNutrition: DailyNutritionPlan | null = null;

      if (canUpdateWorkout && resp.updated_workout_plan) {
        let updatedPlan = resp.updated_workout_plan as WorkoutPlan;
        if (!updatedPlan.days && (updatedPlan as any).workoutDays) {
          updatedPlan = { ...updatedPlan, days: (updatedPlan as any).workoutDays };
        }
        const isValid = Array.isArray(updatedPlan.days) && updatedPlan.days.length > 0
          && updatedPlan.days.every((d: any) => Array.isArray(d.exercises) && d.exercises.length > 0);
        if (isValid) {
          if (prevWorkout?.name && !updatedPlan.name) updatedPlan.name = prevWorkout.name;
          if (!updatedPlan.totalDays) updatedPlan.totalDays = updatedPlan.days.length;
          // Merge deterministic metadata from original plan that the AI
          // doesn't know about: stimulus, setScheme, targetWeightLbs,
          // progressionAction, weightRecommendationSource. Without this,
          // AI plan updates strip all training-type tags and progression data.
          if (prevWorkout?.days) {
            updatedPlan = {
              ...updatedPlan,
              days: updatedPlan.days.map((day: any, di: number) => {
                const origDay = prevWorkout.days[di];
                const merged = { ...day };
                if (!merged.stimulus && origDay?.stimulus) merged.stimulus = origDay.stimulus;
                if (Array.isArray(merged.exercises)) {
                  merged.exercises = merged.exercises.map((ex: any) => {
                    const origEx = origDay?.exercises?.find(
                      (o: any) => o.name?.toLowerCase() === ex.name?.toLowerCase()
                    );
                    if (!origEx) return ex;
                    return {
                      ...ex,
                      setScheme: ex.setScheme ?? origEx.setScheme,
                      targetWeightLbs: ex.targetWeightLbs ?? origEx.targetWeightLbs,
                      weightRecommendationSource: ex.weightRecommendationSource ?? origEx.weightRecommendationSource,
                      progressionAction: ex.progressionAction ?? origEx.progressionAction,
                    };
                  });
                }
                return merged;
              }),
            };
          }
          setWorkoutPlan(updatedPlan);
          await AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(updatedPlan));
        } else {
          // Invalid plan structure — surface a clear error instead of
          // silently closing the banner. The user needs to know the
          // assistant promised a change it couldn't deliver.
          console.warn('[applyPendingUpdate] plan failed isValid check:', updatedPlan);
          setActiveChat(prev => [...prev, {
            role: 'assistant',
            content: 'I said I\'d update the plan but the response came back malformed. Please try rephrasing the request — something like "make tomorrow a push day" or "swap legs on day 3 for pull".',
          }]);
          return;
        }
      } else if (canUpdateWorkout && !resp.updated_workout_plan && resp.needs_plan_update) {
        // needs_plan_update=true but no plan dict present — this is
        // the exact failure mode the intent-detection safety net on
        // the backend was added to prevent. If it still slips through,
        // tell the user rather than silently no-op.
        console.warn('[applyPendingUpdate] needs_plan_update=true but no updated_workout_plan in response');
        setActiveChat(prev => [...prev, {
          role: 'assistant',
          content: 'I described a change but didn\'t return the actual updated plan. Could you ask again with more specific detail about the change you want?',
        }]);
        return;
      }
      if (canUpdateNutrition && resp.updated_nutrition_plan) {
        const today = todayKey();
        const existingPlan = nutritionPlansByDate[today] ?? null;
        const partial = resp.updated_nutrition_plan as Partial<DailyNutritionPlan>;
        const baseMerge: DailyNutritionPlan = existingPlan
          ? { ...existingPlan, ...partial, targets: partial.targets ?? existingPlan.targets }
          : resp.updated_nutrition_plan as DailyNutritionPlan;
        // Re-apply routines on top of the AI-merged plan so pinned meals win.
        const currentRoutines = await loadMealRoutines();
        const mergedPlan = applyRoutines(baseMerge, currentRoutines);
        appliedNutrition = mergedPlan;
        setNutritionPlansByDate(prev => ({ ...prev, [today]: mergedPlan }));
        await saveNutritionPlan(today, mergedPlan);
        await persistDayState(today, { nutrition_plan: mergedPlan });
        setActiveTab('meals');
        setExpandedMealDays(prev => { const next = new Set(prev); next.add(today); return next; });
      }
      if (resp.updated_workout_plan && !resp.updated_nutrition_plan) {
        setActiveTab('workout');
      }

      // Apply detected profile changes (e.g., daysPerWeek changed)
      if (Object.keys(profileChanges).length > 0 && onProfileUpdate) {
        onProfileUpdate(profileChanges, true); // skipRegen — plan already applied
      }

      // Push the applied plan to the backend so it persists
      // cross-device. Without this, the trainer-chat apply flow only
      // wrote to local AsyncStorage and the next device login
      // silently reverted to the pre-apply state. Fire-and-forget —
      // a failed sync is logged but doesn't block the apply.
      if (onBackendSync) {
        try {
          await onBackendSync();
        } catch (e) {
          console.warn('[applyPendingUpdate] backend sync failed (non-fatal):', e);
        }
      }

      const todayPlan = nutritionPlansByDate[todayKey()] ?? null;
      const changeSummary = summarizeTrainerUpdate(prevWorkout, nextWorkout, todayPlan, appliedNutrition);
      const setUpdateSummary = mode === 'trainer' ? setWorkoutUpdateSummary : setNutritionUpdateSummary;
      setUpdateSummary(changeSummary);
      setActiveChat(prev => [...prev, { role: 'assistant', content: `Changes applied!` }]);
      // Auto-close chat after a short delay so user sees the confirmation
      setTimeout(() => {
        setShowTrainerModal(false);
        setWorkoutChat([]); setWorkoutChat([]);
        setPendingUpdate(null); setPendingInjuries(null);
        setWorkoutUpdateSummary(null); setNutritionUpdateSummary(null);
      }, 1500);
      await savePlanChange({
        id: Date.now().toString(),
        changedAt: new Date().toISOString(),
        changedBy: mode === 'trainer' ? 'trainer' : 'nutritionist',
        summary: changeSummary,
        question: q,
      });
    } catch (err: any) {
      console.error('[applyPendingUpdate] error:', err);
      setActiveChat(prev => [...prev, { role: 'assistant', content: 'Had trouble applying the changes. Try asking again.' }]);
    } finally {
      setIsChatPlanUpdating(false);
    }
  }, [pendingUpdate, workoutPlan, nutritionPlansByDate, persistDayState, onProfileUpdate, onBackendSync, summarizeTrainerUpdate]);

  const dismissPendingUpdate = useCallback(() => {
    const setActiveChat = setWorkoutChat;  // unified
    setPendingUpdate(null);
    setActiveChat(prev => [...prev, { role: 'assistant', content: 'Changes dismissed. Let me know if you\'d like something different.' }]);
  }, [pendingUpdate]);

  const handleToggleMeal = useCallback(async (date: string, mealType: string) => {
    import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
    const current = checkedMealsByDate[date] ?? {};
    const wasChecked = !!current[mealType];
    const next = { ...current, [mealType]: !wasChecked };
    setCheckedMealsByDate(prev => ({ ...prev, [date]: next }));
    await saveMealChecks(date, next);
    await persistDayState(date, { meal_checks: next });

    // If this check completes today's plan, suppress the 9pm reminder
    // for today — no point nudging the user when they've already logged
    // everything. `maybeCancelTodayReminder` no-ops if reminder is off.
    try {
      if (date === todayKey()) {
        const todayPlan = nutritionPlansByDate[date];
        const allMealsChecked = !!todayPlan?.meals?.length
          && todayPlan.meals.every((_, idx) => !!next[`meal_${idx}`]);
        if (allMealsChecked) {
          const { maybeCancelTodayReminder } = await import('../utils/mealReminders');
          maybeCancelTodayReminder(true).catch(() => {});
        }
      }
    } catch {}
    // Snapshot the meal on check, clear on uncheck. Preserved meals survive
    // plan regeneration — loadPlans overlays them after picking a template.
    const plan = nutritionPlansByDate[date];
    if (!plan) return;

    // Every meal lives in plan.meals[idx]. mealType is "meal_<idx>".
    const idx = mealType.startsWith('meal_') ? parseInt(mealType.slice(5), 10) : -1;
    const meal = idx >= 0 ? (plan.meals ?? [])[idx] : undefined;
    if (!meal) return;

    if (!wasChecked) {
      // Routine-backed extras are already persistent via the routines
      // file — preserving them separately would create a second source
      // of truth for the same meal and cause duplication on overlay.
      const isRoutineBacked = !!(meal as any)._routineId;
      if (!isRoutineBacked) {
        await savePreservedMeal(date, mealType, meal);
      }
      // Fire-and-forget: persist the checked meal to backend meal history.
      if (authToken && meal) {
        logMealChecked(authToken, {
          meal_date: date,
          meal_type: mealType,
          meal: meal as Record<string, any>,
          source: 'plan_check',
        }).catch(err => console.log('[logMealChecked] background save failed:', err.message));
      }
    } else {
      const localId = (meal as any)._localId;
      await clearPreservedMeal(date, mealType, localId);
    }
  }, [checkedMealsByDate, persistDayState, nutritionPlansByDate, authToken]);

  const handleMealSave = useCallback(async (date: string, mealType: string, updated: MealSuggestion, opts?: { routineScope?: 'today' | 'all'; userInitiated?: boolean }) => {
    // userInitiated defaults to true — every existing call site is a
    // user-tap (Edit modal Save, Add Snack, recipe Save). Hydration paths
    // that loop saves across forward dates must explicitly pass false.
    const userInitiated = opts?.userInitiated !== false;
    console.log(`[handleMealSave] date=${date} mealType=${mealType} updatedMeal=${updated.meal} items=${updated.items?.length ?? 0} routineScope=${opts?.routineScope ?? '—'} userInitiated=${userInitiated}`);
    // Routine detach: when the editor opts into "Just today" scope on a
    // routine-backed meal, strip the _routineId + tag a fresh _localId
    // so applyRoutines on the next plan load leaves our edit alone.
    const willDetach = opts?.routineScope === 'today' && !!(updated as any)._routineId;
    if (willDetach) {
      const { [`_routineId`]: _dropped, ...rest } = updated as any;
      updated = {
        ...rest,
        _localId: (updated as any)._localId || `saved_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      } as MealSuggestion;
      console.log('[handleMealSave] detached routine instance — _localId stamped');
    }
    let nextPlan: DailyNutritionPlan | null = null;
    let savedMealType: string = mealType;
    let savedIdx = -1;
    setNutritionPlansByDate(prev => {
      const current = prev[date];
      if (!current) { console.log(`[handleMealSave] no current plan for ${date}`); return prev; }
      const meals = [...(current.meals ?? [])];
      if (mealType === 'new_meal' || mealType === 'new_extra') {
        meals.push(updated);
        savedIdx = meals.length - 1;
        savedMealType = `meal_${savedIdx}`;
      } else if (mealType.startsWith('meal_')) {
        const idx = parseInt(mealType.slice(5), 10);
        if (idx >= 0 && idx < meals.length) {
          meals[idx] = updated;
          savedIdx = idx;
        } else {
          meals.push(updated);
          savedIdx = meals.length - 1;
          savedMealType = `meal_${savedIdx}`;
        }
      }
      nextPlan = { ...current, meals };
      console.log(`[handleMealSave] built nextPlan with ${meals.length} meals, stamp=${(nextPlan as any)?._templatesVersion ?? 'NONE'}`);
      return { ...prev, [date]: nextPlan as DailyNutritionPlan };
    });
    if (nextPlan) {
      await saveNutritionPlan(date, nextPlan);
      console.log(`[handleMealSave] saved to AsyncStorage`);
    } else {
      console.log(`[handleMealSave] nextPlan was null — NOT saved`);
    }
    if (nextPlan) await persistDayState(date, { nutrition_plan: nextPlan });

    // Newly-added meals reflect real intent ("I'm adding this meal because
    // I ate / am eating it"). Auto-check them and log to backend meal
    // history so they show in /meals/history and trigger DailyNutrition-
    // Metrics recompute (which feeds the Health Score daily average).
    // Editing an already-checked meal re-logs so the updated totals
    // replace the old history row on the next sync.
    const isNewMeal = mealType === 'new_meal' || mealType === 'new_extra';
    const wasAlreadyChecked = !!(checkedMealsByDate[date] ?? {})[savedMealType];
    // Auto-check + auto-log are reserved for user-initiated saves only.
    // Hydration paths (routine application, plan migration) call this
    // with `userInitiated=false` and must NOT silently mark meals
    // complete on the user's behalf.
    const shouldLog = userInitiated && (isNewMeal || wasAlreadyChecked);
    if (shouldLog && authToken && savedIdx >= 0) {
      if (isNewMeal) {
        // Auto-check: persist the check state + snapshot the preserved meal.
        const currentChecks = checkedMealsByDate[date] ?? {};
        const nextChecks = { ...currentChecks, [savedMealType]: true };
        setCheckedMealsByDate(prev => ({ ...prev, [date]: nextChecks }));
        await saveMealChecks(date, nextChecks);
        await persistDayState(date, { meal_checks: nextChecks });
        try { await savePreservedMeal(date, savedMealType, updated); } catch {}
      }
      // Fire-and-forget to backend; failures don't block save.
      logMealChecked(authToken, {
        meal_date: date,
        meal_type: savedMealType,
        meal: updated as Record<string, any>,
        source: isNewMeal ? 'manual_add' : 'plan_check',
      }).catch(err => console.log('[handleMealSave] meal-log background save failed:', err?.message));
    }

    // Persist detached meals locally so they survive plan reload —
    // applyRoutines would otherwise drop any meal without a linked
    // routine. `_localId` is the escape hatch.
    if (willDetach && savedIdx >= 0) {
      try { await savePreservedMeal(date, `meal_${savedIdx}`, updated); } catch {}
    }

    // Routine-backed meal edits must propagate to `mealRoutines` storage
    // ONLY when the user chose "Apply to every day". When scope is
    // "today" we've already detached above so the routine template
    // stays pristine. Legacy callers that don't pass a scope fall back
    // to the old template-update behavior.
    const routineId = (updated as any)._routineId;
    const shouldPropagateToRoutine = routineId && opts?.routineScope !== 'today';
    if (shouldPropagateToRoutine) {
      const routines = await loadMealRoutines();
      const existing = routines.find(r => r.id === routineId);
      if (existing) {
        const withItems = ensureItems(updated);
        const snapItems = withItems.items ?? [];
        const foods: MealRoutineFood[] = snapItems.length > 0
          ? snapItems.map((it, i) => ({
              id: `${Date.now()}_${i}`,
              name: it.name,
              quantity: it.unit === 'piece' ? String(it.quantity) : `${it.quantity} ${it.unit}`,
            }))
          : (updated.foods ?? []).map((f, i) => ({
              id: `${Date.now()}_${i}`,
              name: f,
              quantity: updated.amounts?.[i],
            }));
        const refreshed: MealRoutineEntry = {
          ...existing,
          name: updated.meal,
          foods,
          items: snapItems.length > 0 ? snapItems : undefined,
          calories: updated.calories,
          protein:  updated.protein,
          carbs:    updated.carbs,
          fat:      updated.fat,
        };
        const nextRoutines = routines.map(r => r.id === routineId ? refreshed : r);
        await saveMealRoutines(nextRoutines);
        // Propagate the edit to every loaded day's plan so other dates'
        // cards refresh without waiting for the next loadPlans cycle.
        setNutritionPlansByDate(prev => applyRoutinesToAll(prev, nextRoutines));
      }
    }
  }, [persistDayState, authToken, checkedMealsByDate]);

  const handleAddSnack = useCallback((date: string) => {
    const emptyMeal: MealSuggestion = { meal: 'New Meal', foods: [], calories: 0, protein: 0, carbs: 0, fat: 0 };
    setEditingMeal({ dateKey: date, type: 'new_meal', meal: emptyMeal });
  }, []);

  const handleRemoveMeal = useCallback(async (date: string, mealType: string) => {
    // Soft-remove a meal from a single day. If the meal was pinned as a
    // routine, also unpin it and re-apply across every day so it doesn't
    // pop back on the next load.
    const currentPlan = nutritionPlansByDate[date];
    const idx = mealType.startsWith('meal_') ? parseInt(mealType.slice(5), 10) : -1;
    const target = idx >= 0 ? (currentPlan?.meals ?? [])[idx] : undefined;
    const routineIdToClear: string | null = (target as any)?._routineId ?? null;
    const preservedLocalIdToClear: string | null = (target as any)?._localId ?? null;

    let nextPlan: DailyNutritionPlan | null = null;
    setNutritionPlansByDate(prev => {
      const current = prev[date];
      if (!current || idx < 0) return prev;
      // Remove by index from the meals[] list. We don't soft-hide via
      // removedMealIds when the user explicitly removes a meal from
      // today's plan — that would leave a "Removed: X" row floating
      // around forever. Soft-hide is only used by `removedMealIds`
      // (e.g. a future "hide template meal" action).
      const meals = (current.meals ?? []).filter((_, i) => i !== idx);
      nextPlan = { ...current, meals };
      return { ...prev, [date]: nextPlan as DailyNutritionPlan };
    });
    if (nextPlan) await saveNutritionPlan(date, nextPlan);
    if (nextPlan) await persistDayState(date, { nutrition_plan: nextPlan });

    if (routineIdToClear) {
      const currentRoutines = await loadMealRoutines();
      const filtered = currentRoutines.filter(r => r.id !== routineIdToClear);
      if (filtered.length !== currentRoutines.length) {
        await saveMealRoutines(filtered);
        // Routines are derive-on-read — update in-memory state so the
        // unpinned routine vanishes immediately, but do NOT persist the
        // re-applied plans. A later loadPlans re-derives fresh.
        const appliedMap = applyRoutinesToAll(nutritionPlansByDate, filtered);
        setNutritionPlansByDate(appliedMap);
      }
    }
    if (preservedLocalIdToClear) {
      await clearPreservedMeal(date, mealType, preservedLocalIdToClear);
    } else if (target) {
      await clearPreservedMealBySignature(date, target.meal, target.calories ?? 0);
    }
  }, [persistDayState, nutritionPlansByDate]);

  // Hard delete: now that there's no soft-hide branch (every "remove"
  // splices the meal out of meals[]), this is just an alias for
  // `handleRemoveMeal`. Kept as a separate symbol so the NutritionCard
  // long-press path can stay distinct from the row-level remove.
  const handleHardDeleteMeal = useCallback(async (date: string, mealType: string) => {
    return handleRemoveMeal(date, mealType);
  }, [handleRemoveMeal]);

  const handleRestoreMeal = useCallback(async (date: string, mealType: string) => {
    // Soft-hide is no longer used (handleRemoveMeal splices the meal out
    // entirely), so there's nothing to restore. Kept as a no-op so the
    // NutritionCard prop signature stays stable.
    void date; void mealType;
  }, []);

  /** Reorder a meal within plan.meals[]. `direction` is -1 (up) / +1 (down). */
  const handleMoveMeal = useCallback(async (date: string, mealType: string, direction: -1 | 1) => {
    const idx = mealType.startsWith('meal_') ? parseInt(mealType.slice(5), 10) : -1;
    if (idx < 0) return;
    let nextPlan: DailyNutritionPlan | null = null;
    setNutritionPlansByDate(prev => {
      const current = prev[date];
      if (!current) return prev;
      const meals = (current.meals ?? []).slice();
      const target = idx + direction;
      if (target < 0 || target >= meals.length) return prev;
      [meals[idx], meals[target]] = [meals[target], meals[idx]];
      nextPlan = { ...current, meals };
      return { ...prev, [date]: nextPlan as DailyNutritionPlan };
    });
    if (nextPlan) {
      await saveNutritionPlan(date, nextPlan);
      await persistDayState(date, { nutrition_plan: nextPlan });
    }
  }, [persistDayState]);

  const handleShuffleMeal = useCallback(async (date: string, mealType: string, meal: MealSuggestion) => {
    // Regenerate a single meal, TARGETING the day's macro envelope (not
    // just calories). Computes how much cal/protein this meal should hit
    // based on the day's total target minus what's already claimed by
    // the OTHER meals. Then generates N candidates with different seeds
    // and picks the one closest to (cal, protein) target.
    const idx = mealType.startsWith('meal_') ? parseInt(mealType.slice(5), 10) : -1;
    console.log(`[shuffle] START date=${date} mealType=${mealType} idx=${idx} mealName=${meal.meal}`);
    if (idx < 0 || !userProfile) {
      console.log(`[shuffle] ABORT idx=${idx} hasProfile=${!!userProfile}`);
      return;
    }

    const { generateMealSuggestion } = await import('../utils/planGenerator');
    const foodList = meta.foods ?? [];
    const foodMap: Record<string, any> = {};
    for (const f of foodList) foodMap[f.name.toLowerCase()] = f;
    for (const f of (userProfile.customFoods ?? [])) foodMap[f.name.toLowerCase()] = f as any;

    // Build a WIDE candidate list. `userProfile.foodsAvailable` is the
    // user's narrow onboarding preference set (often <15 items) — if we
    // only use that, per-role pools shrink to 2–3 items and the shuffle
    // keeps picking the same foods. We layer in the full catalog so the
    // generator has variety. User preferences + custom foods appear
    // FIRST in the list, so the seededIndex biases toward them when
    // pool sizes differ.
    const prefNames = userProfile.foodsAvailable ?? [];
    const customNames = (userProfile.customFoods ?? []).map(f => f.name);
    const catalogNames = Object.keys(foodMap)
      .filter(n => foodMap[n]) // skip any nulls
      .map(n => foodMap[n].name);
    // Dedup (case-insensitive) while preserving preference-first order.
    const seen = new Set<string>();
    const wideCandidates: string[] = [];
    for (const n of [...prefNames, ...customNames, ...catalogNames]) {
      const key = n.toLowerCase();
      if (!seen.has(key) && foodMap[key]) {
        seen.add(key);
        wideCandidates.push(n);
      }
    }
    console.log(`[shuffle] foodMap=${Object.keys(foodMap).length} prefs=${prefNames.length} custom=${customNames.length} wideCandidates=${wideCandidates.length}`);

    // Compute this meal's share of the day's macro envelope. Start from
    // the day's targets, subtract every OTHER meal's contribution. What's
    // left is how much this meal should carry. If day targets are missing
    // (unusual but possible), fall back to using this meal's existing
    // macros as the envelope so we at least preserve its current shape.
    const currentDayPlan = nutritionPlansByDate[date];
    const hasValidTargets = !!(currentDayPlan?.targets?.calories && currentDayPlan.targets.calories > 0);
    const dayTargets = hasValidTargets
      ? currentDayPlan!.targets!
      : { calories: 0, protein: 0, carbs: 0, fat: 0 };
    const otherMeals = (currentDayPlan?.meals ?? []).filter((_, i) => i !== idx);
    const otherCal  = otherMeals.reduce((s, m) => s + (m.calories || 0), 0);
    const otherPro  = otherMeals.reduce((s, m) => s + (m.protein  || 0), 0);
    const otherCarb = otherMeals.reduce((s, m) => s + (m.carbs    || 0), 0);
    const otherFat  = otherMeals.reduce((s, m) => s + (m.fat      || 0), 0);

    // Target for this meal = day_target - others. If no valid day targets,
    // fall back to the current meal's own macros so the shuffle at least
    // preserves the meal's existing shape.
    const mealCalTarget = hasValidTargets
      ? Math.max(200, Math.round((dayTargets.calories || 0) - otherCal))
      : Math.max(200, Math.round(meal.calories || 500));
    const mealProTarget = hasValidTargets
      ? Math.max(10, Math.round((dayTargets.protein || 0) - otherPro))
      : Math.max(10, Math.round(meal.protein || 30));
    const mealCarbTarget = hasValidTargets
      ? Math.max(10, Math.round((dayTargets.carbs || 0) - otherCarb))
      : Math.max(10, Math.round(meal.carbs || 40));
    const mealFatTarget = hasValidTargets
      ? Math.max(5, Math.round((dayTargets.fat || 0) - otherFat))
      : Math.max(5, Math.round(meal.fat || 15));
    console.log(`[shuffle] targets cal=${mealCalTarget} pro=${mealProTarget} carb=${mealCarbTarget} fat=${mealFatTarget} (day_has_targets=${hasValidTargets})`);

    // Generate N candidates with different seeds; score each by how well
    // it hits (cal, protein, carbs, fat) with protein shortfall treated
    // as a hard penalty and whole-food candidates favored.
    const { classifyFood: classifyFoodQuality } = await import('../utils/nutritionScore');
    const CANDIDATES = 12;
    let best: { meal: MealSuggestion; score: number } | null = null;
    for (let i = 0; i < CANDIDATES; i++) {
      const seed = `shuffle:${date}:${idx}:${Date.now()}:${i}:${Math.random()}`;
      const candidate = generateMealSuggestion(
        meal.meal || 'Meal',
        mealCalTarget,
        wideCandidates,
        foodMap,
        seed,
      );
      if (i === 0) {
        console.log(`[shuffle] first candidate: foods=${candidate.foods.join(',')} cal=${candidate.calories} pro=${candidate.protein}`);
      }

      const dCal  = Math.abs(candidate.calories - mealCalTarget) / Math.max(1, mealCalTarget);
      const dCarb = Math.abs((candidate.carbs || 0) - mealCarbTarget) / Math.max(1, mealCarbTarget);
      const dFat  = Math.abs((candidate.fat || 0) - mealFatTarget) / Math.max(1, mealFatTarget);

      // Protein: asymmetric penalty. Going UNDER target is a real problem
      // (users undereat protein all the time); going OVER is fine — it
      // just displaces carbs/fat which are less precious. Shortfall is
      // heavily penalized; overage gets a small nudge so we don't chase
      // 500g protein meals either.
      const proShortfall = Math.max(0, mealProTarget - (candidate.protein || 0)) / Math.max(1, mealProTarget);
      const proOverage   = Math.max(0, (candidate.protein || 0) - mealProTarget) / Math.max(1, mealProTarget);
      const dPro = proShortfall * 3.5 + proOverage * 0.3;

      // Whole-food bonus: count whole vs processed items in the picked
      // foods. Each whole food subtracts from the score (bonus); each
      // processed food adds (penalty). "unknown" is neutral.
      let wholeBonus = 0;
      for (const name of candidate.foods) {
        const q = classifyFoodQuality(name);
        if (q === 'whole') wholeBonus -= 0.20;
        else if (q === 'processed') wholeBonus += 0.35;
      }

      // All four macros matter; protein-shortfall leads. Whole-food
      // preference layered on as a score modifier.
      const score = dPro + dCal * 1.5 + dCarb * 1.0 + dFat * 1.0 + wholeBonus;
      if (!best || score < best.score) best = { meal: candidate, score };
    }
    const shuffled = best?.meal;
    if (!shuffled) return;

    let nextPlan: DailyNutritionPlan | null = null;
    setNutritionPlansByDate(prev => {
      const current = prev[date];
      if (!current) return prev;
      const meals = (current.meals ?? []).slice();
      if (idx < 0 || idx >= meals.length) return prev;
      // Preserve the meal's identity (name, routine pin) while swapping
      // in the new ingredient list. Keep name if it's been user-renamed.
      const existing = meals[idx];
      meals[idx] = {
        ...shuffled,
        meal: existing.meal,
        isRoutine: existing.isRoutine,
        ...(existing as any)._routineId ? { _routineId: (existing as any)._routineId } : {},
      };
      nextPlan = { ...current, meals };
      return { ...prev, [date]: nextPlan as DailyNutritionPlan };
    });
    if (nextPlan) {
      await saveNutritionPlan(date, nextPlan);
      await persistDayState(date, { nutrition_plan: nextPlan });
    }
  }, [userProfile, persistDayState, meta.foods, nutritionPlansByDate]);

  const handleRenameMeal = useCallback(async (date: string, mealType: string, newName: string) => {
    const idx = mealType.startsWith('meal_') ? parseInt(mealType.slice(5), 10) : -1;
    if (idx < 0) return;
    const trimmed = newName.trim();
    if (!trimmed) return;
    let nextPlan: DailyNutritionPlan | null = null;
    let routineId: string | null = null;
    setNutritionPlansByDate(prev => {
      const current = prev[date];
      if (!current) return prev;
      const meals = (current.meals ?? []).slice();
      const target = meals[idx];
      if (!target || target.meal === trimmed) return prev;
      routineId = (target as any)._routineId ?? null;
      meals[idx] = { ...target, meal: trimmed };
      nextPlan = { ...current, meals };
      return { ...prev, [date]: nextPlan as DailyNutritionPlan };
    });
    if (nextPlan) {
      await saveNutritionPlan(date, nextPlan);
      await persistDayState(date, { nutrition_plan: nextPlan });
    }
    // Routine-backed rename: update the routine name and re-apply to every
    // loaded day so all instances of this routine show the new name.
    if (routineId) {
      const routines = await loadMealRoutines();
      const existing = routines.find(r => r.id === routineId);
      if (existing && existing.name !== trimmed) {
        const nextRoutines = routines.map(r => r.id === routineId ? { ...r, name: trimmed } : r);
        await saveMealRoutines(nextRoutines);
        setNutritionPlansByDate(prev => applyRoutinesToAll(prev, nextRoutines));
      }
    }
  }, [persistDayState]);


  const handleToggleRoutine = useCallback(async (date: string, mealType: string) => {
    // Derive-don't-persist: mutate the routines storage, then re-apply to
    // every plan in state. The plan itself never stores `isRoutine: true`
    // directly — it's always derived from storage via `applyRoutines()`.
    const current = nutritionPlansByDate[date];
    if (!current) return;

    // Every meal lives in plan.meals[idx]. Resolve it.
    const idx = mealType.startsWith('meal_') ? parseInt(mealType.slice(5), 10) : -1;
    const meal: MealSuggestion | undefined = idx >= 0 ? (current.meals ?? [])[idx] : undefined;
    if (!meal) return;
    const existingRoutineId: string | null = (meal as any)?._routineId ?? null;

    const routines = await loadMealRoutines();
    const alreadyActive = !!existingRoutineId && routines.some(r => r.id === existingRoutineId);
    const turningOn = !alreadyActive;

    if (turningOn) {
      const mealsPerDay = userProfile?.mealsPerDay ?? 3;
      if (routines.length >= mealsPerDay) {
        Alert.alert(
          'Routine limit reached',
          `You have ${routines.length} routine${routines.length === 1 ? '' : 's'} but only ${mealsPerDay} meal${mealsPerDay === 1 ? '' : 's'} per day. ` +
          'Adding another routine will push out a generated meal. Consider increasing your meals per day in settings.',
        );
      }
    }

    let nextRoutines: MealRoutineEntry[];
    if (turningOn) {
      // Snapshot the current meal into a routine entry. Prefer structured
      // items (they carry per-item macros + unit), but also populate legacy
      // `foods` for older code paths that still read it.
      const withItems = ensureItems(meal);
      const snapItems = withItems.items ?? [];
      const foods: MealRoutineFood[] = snapItems.length > 0
        ? snapItems.map((it, i) => ({
            id: `${Date.now()}_${i}`,
            name: it.name,
            quantity: it.unit === 'piece' ? String(it.quantity) : `${it.quantity} ${it.unit}`,
          }))
        : (meal.foods ?? []).map((f, i) => ({
            id: `${Date.now()}_${i}`,
            name: f,
            quantity: meal.amounts?.[i],
          }));
      // Every routine is now keyed by id. mealType on the routine entry
      // is kept for legacy storage (set to 'custom') but isn't read by
      // applyRoutines anymore.
      const routineId = existingRoutineId ?? `routine_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const entry: MealRoutineEntry = {
        id: routineId,
        name: meal.meal,
        mealType: 'custom',
        foods,
        items: snapItems.length > 0 ? snapItems : undefined,
        createdAt: new Date().toISOString(),
        calories: meal.calories,
        protein:  meal.protein,
        carbs:    meal.carbs,
        fat:      meal.fat,
      };
      nextRoutines = [...routines.filter(r => r.id !== routineId), entry];

      // Clear any preserved-meal entry for this meal so the next loadPlans
      // overlay doesn't re-inject the old checked copy alongside the new
      // routine-backed one.
      const localId = (meal as any)._localId;
      if (localId) {
        await clearPreservedMeal(date, mealType, localId);
      }
    } else {
      nextRoutines = existingRoutineId
        ? routines.filter(r => r.id !== existingRoutineId)
        : routines;
    }
    await saveMealRoutines(nextRoutines);

    // Re-apply routines to every plan in state so every day reflects the
    // pin/unpin immediately. CRITICAL: do NOT persist the result. Routines
    // are derive-on-read — they're stored once in `mealRoutines` and
    // re-applied by every loadPlans call. Writing the routine-overlaid
    // plan to per-day storage would freeze that day's meals[] in place,
    // so a later regen wouldn't refresh it (the version-check survives
    // because the persisted plan inherits the current templatesVersion).
    const appliedMap = applyRoutinesToAll(nutritionPlansByDate, nextRoutines);
    setNutritionPlansByDate(appliedMap);
  }, [nutritionPlansByDate]);

  const handleSkipToday = useCallback((focus: string) => {
    import('../utils/feedback').then(f => f.hapticWarning()).catch(() => {});
    setSelectedSkipReason('');
    setCustomSkipReason('');
    setSkipReasonFocus(focus);
  }, []);

  const confirmSkip = useCallback(async () => {
    const focus = skipReasonFocus;
    if (!focus) return;
    const reason = customSkipReason.trim() || selectedSkipReason || undefined;
    const type = skipType;
    setSkipReasonFocus(null);
    setSelectedSkipReason('');
    setCustomSkipReason('');
    setSkipType('push');
    const today = todayKey();
    setSkippedDates(prev => new Set([...prev, today]));
    if (reason) setSkipReasonsByDate(prev => ({ ...prev, [today]: reason }));
    if (type === 'drop') {
      setDroppedSkipDates(prev => new Set([...prev, today]));
    }
    // Freeze today's workout so a plan regen doesn't replace the
    // content of the skipped day. Same mechanism as completed days
    // — preservedWorkouts survives plan regeneration.
    const todayScheduleItem = scheduleRaw.find(
      item => dateKey(item.date) === today && item.workout,
    );
    if (todayScheduleItem?.workout) {
      await savePreservedCompletedWorkout(today, todayScheduleItem.workout);
      setPreservedWorkouts(prev => ({ ...prev, [today]: todayScheduleItem.workout! }));
    }
    await persistDayState(today, { skipped_focus: focus });
    await saveSkipToHistory(today, focus, reason);
  }, [skipReasonFocus, selectedSkipReason, customSkipReason, skipType, persistDayState, scheduleRaw]);

  const handleUnskipDay = useCallback(async (date: string) => {
    setSkippedDates(prev => {
      const next = new Set(prev);
      next.delete(date);
      return next;
    });
    setDroppedSkipDates(prev => {
      const next = new Set(prev);
      next.delete(date);
      return next;
    });
    // Remove the frozen workout snapshot so the schedule picks up
    // whatever the current plan assigns to this date slot.
    setPreservedWorkouts(prev => {
      const next = { ...prev };
      delete next[date];
      return next;
    });
    await persistDayState(date, { skipped_focus: null });
  }, [persistDayState]);

  // Wipe a phantom "done" state — backend WorkoutCompletion +
  // WorkoutSession + every related local artifact for the date.
  // Triggered from the day card's "Mark as not done" link.
  const handleUndoComplete = useCallback(async (date: string) => {
    try {
      if (authToken) {
        const { deleteWorkoutCompletion } = await import('../services/api');
        await deleteWorkoutCompletion(authToken, date).catch(() => {});
      }
      // Strip local history entries for that date so isTodayWorkoutDone
      // can't fall back to a stale local row.
      const history = await loadWorkoutHistory();
      const next = history.filter(s => !s.date.startsWith(date));
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      await AsyncStorage.setItem('workoutHistory', JSON.stringify(next.slice(0, 100)));
      // Drop preserved-completed snapshot for that date.
      const { loadPreservedCompletedWorkouts } = await import('../utils/workoutHistory');
      const preserved = await loadPreservedCompletedWorkouts();
      delete preserved[date];
      await AsyncStorage.setItem('preservedCompletedWorkouts', JSON.stringify(preserved));
      // Drop today's stored summary.
      const summaries = await loadWorkoutSummaries();
      const remaining = summaries.filter(s => !s.date.startsWith(date));
      await AsyncStorage.setItem('workoutSummaries', JSON.stringify(remaining));
      // Refresh local state so the UI flips immediately.
      if (date === todayKey()) {
        setTodayDone(false);
        setTodaySummary(null);
        setCompletedDates(prev => {
          const nset = new Set(prev);
          nset.delete(date);
          return nset;
        });
      }
      setPreservedWorkouts(prev => {
        const np = { ...prev };
        delete np[date];
        return np;
      });
      console.log('[undo-complete] cleared completion for', date);
    } catch (e) {
      console.warn('[undo-complete] failed:', e);
    }
  }, [authToken]);

  // Video modal target — carries the exercise name PLUS optional
  // metadata so the backend can rank results to the exact variant
  // (e.g. "Band Chest Press" excludes "Machine Chest Press" hits).
  // Saved meal library — name set lets NutritionCard tag rows as
  // "✓ Saved". List itself backs the add-from-saved picker on the
  // day card. Reloaded whenever the user creates / deletes one so the
  // chip stays in sync.
  const [savedMealLibrary, setSavedMealLibrary] = useState<Array<{ id: number; name: string; items: any[]; total_calories: number; total_protein_g: number; total_carbs_g: number; total_fat_g: number }>>([]);
  const savedMealNames = useMemo(
    () => new Set(savedMealLibrary.map(m => (m.name || '').toLowerCase().trim())),
    [savedMealLibrary],
  );
  const reloadSavedMeals = useCallback(async () => {
    if (!authToken) return;
    try {
      const { listSavedMeals } = await import('../services/api');
      const rows = await listSavedMeals(authToken);
      setSavedMealLibrary(rows.map(r => ({
        id: r.id, name: r.name, items: r.items || [],
        total_calories: r.total_calories,
        total_protein_g: r.total_protein_g,
        total_carbs_g: r.total_carbs_g,
        total_fat_g: r.total_fat_g,
      })));
    } catch {
      // Network hiccup — leave existing library state alone.
    }
  }, [authToken]);
  useEffect(() => { reloadSavedMeals(); }, [reloadSavedMeals]);

  // When the add-from-saved picker fires on a day card we stash the
  // target date so the quick-log modal knows where to paste.
  const [addFromSavedFor, setAddFromSavedFor] = useState<string | null>(null);

  // Template-mode meal editor target. When set, we render a
  // MealEditModal hydrated from the saved meal's items and route save
  // to `updateSavedMeal` (not to a day's plan). Past logs stay frozen
  // — this only changes the template for future logs.
  const [editingSavedMeal, setEditingSavedMeal] = useState<{
    id: number; name: string; items: any[];
  } | null>(null);

  const [videoModalTarget, setVideoModalTarget] = useState<{
    name: string;
    equipment?: string | null;
    primary_muscle?: string | null;
    movement_pattern?: string | null;
  } | null>(null);
  const openExerciseVideo = useCallback(
    (exerciseName: string, ctx?: { equipment?: string | null; primary_muscle?: string | null; movement_pattern?: string | null }) => {
      setVideoModalTarget({ name: exerciseName, ...ctx });
    },
    [],
  );

  // MUST be called BEFORE any conditional return — hooks have to fire
  // in the same order every render. The previous version sat below
  // the `if (!userProfile || !workoutPlan)` early-return and blew up
  // ("Rendered more hooks than during the previous render") on the
  // first render when userProfile was still loading.
  const adaptiveMacroWeightEntries = useMemo(
    () => (userProfile?.weightEntries ?? []).map(e => ({ date: e.date, weight_lbs: e.weight_lbs })),
    [userProfile?.weightEntries],
  );

  // Canonical preparedness — set by TrainingReadinessCard when it renders
  // its score on Progress tab. The watch sync useEffect prefers this
  // value (when fresh) so phone display and watch display SHARE one
  // computation. Without this, two independent computes drifted.
  const canonicalPrepRef = useRef<{ score: number; label: string; computedAt: number } | null>(null);

  if (!userProfile || !workoutPlan) return <View style={styles.container} />;

  const goalLabel = meta.goals.find(g => g.value === userProfile.goal)?.label
    ?? PRIMARY_GOALS.find(g => g.id === userProfile.goal)?.label
    ?? userProfile.goal;
  const scheduleRaw = workoutPlan?.days?.length ? get7DaySchedule(workoutPlan, userProfile.daysPerWeek, skippedDates, droppedSkipDates, completedDates, userProfile.trainingDays) : [];
  // Overlay preserved completed workouts: any date the user has already
  // finished keeps its original WorkoutDay snapshot, so a plan regen can't
  // swap a done day's exercises out from under them.
  //
  // The preserved check MUST run before the isRest short-circuit. Previously
  // we bailed on isRest first, which broke this scenario: user finishes a
  // workout on Tuesday on a 6-day plan, then reduces to a 4-day plan that
  // doesn't have Tuesday as a training day. The new schedule marks Tuesday
  // as rest, the overlay saw isRest and returned without restoring the
  // preserved card, and the user saw "Rest day" where they'd just trained.
  // Now: if a date has a preserved completed workout, it ALWAYS shows as
  // a (non-rest) completed training day regardless of what the new schedule
  // thinks the day should be.
  const schedule = scheduleRaw.map(item => {
    const k = dateKey(item.date);
    const preserved = preservedWorkouts[k];
    if (preserved) {
      return { ...item, workout: preserved, isRest: false };
    }
    return item;
  });
  // Free tier — strip all generated exercises and replace each scheduled day
  // with an "Empty" shell the user can start + populate manually. Past
  // preserved/completed workouts are left untouched so the user's history
  // remains intact. When they upgrade to pro, the parent triggers a regen
  // that repopulates these days.
  const isFreeTier = (userProfile.subscriptionTier ?? 'pro') === 'free';

  // (adaptiveMacroWeightEntries is declared above the early-return
  // because hooks must fire in the same order every render.)
  const scheduleForRender = isFreeTier
    ? schedule.map(item => {
        // Keep completed/historical cards; only reset forward-looking days.
        if (item.isCompleted || item.isRest) return item;
        return {
          ...item,
          workout: {
            day: item.workout?.day ?? DAY_NAMES[item.date.getDay()],
            focus: 'Empty',
            exercises: [],
            stimulus: null,
          } as any,
        };
      })
    : schedule;
  const mealDays = getNextMealDays(7);

  const isLightTheme = ['sunrise', 'arctic', 'rose', 'parchment', 'meadow', 'steel', 'sand', 'linen', 'mint', 'butter', 'seaglass', 'lilac', 'cloud'].includes(userProfile.themePreference ?? 'midnight');
  const statusBarStyle = isLightTheme ? 'dark' : 'light';

  // Subtle gradient: slightly lighter at top, fades to base background
  const gradientColors: [string, string, string] = isLightTheme
    ? [themeColors.surfaceRaised, themeColors.background, themeColors.background]
    : [themeColors.surfaceRaised, themeColors.background, themeColors.background];

  return (
    <LinearGradient colors={gradientColors} style={styles.container} locations={[0, 0.4, 1]}>
      <StatusBar style={statusBarStyle} />

      {/* Header — very subtle top-to-bottom primary wash */}
      <LinearGradient
        colors={[themeColors.primary + '18', themeColors.surfaceRaised]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={[styles.header, { paddingTop: insets.top + 10, borderBottomColor: themeColors.border }]}>
        <Image
          source={bgIsDark(themeColors.background) ? LOGO_DARK : LOGO_LIGHT_HEADER}
          style={{ height: 50, width: 160 }}
          resizeMode="contain"
        />
        <TouchableOpacity
          style={[styles.askAiBtn, { backgroundColor: themeColors.surface, borderWidth: 1, borderColor: themeColors.border }]}
          onPress={() => {
            import('../utils/feedback').then(f => f.hapticMedium()).catch(() => {});
            setShowTrainerModal(true);
          }}
          activeOpacity={0.85}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Open AI Coach">
          <Ionicons name="chatbubble-ellipses-outline" size={15} color={themeColors.textSecondary} />
          <Text style={[styles.askAiText, { color: themeColors.textSecondary }]}>Coach</Text>
        </TouchableOpacity>
      </LinearGradient>

      {/* Full-screen plan-generation overlay. Hides the old plan so users
          don't confuse stale content with what's being rebuilt. Stays up
          regardless of tab; the user is explicitly in a "wait for new plan"
          state. Plan generation keeps running via expo-keep-awake while the
          screen is on; if the user backgrounds the app, the foreground
          AppState listener in app/index.tsx will auto-retry on return. */}
      {/* Full-screen overlay is reserved for the simultaneous full-plan
          regen case — both workout AND nutrition are rebuilding at once.
          When only one section is rebuilding we show a section-scoped
          placeholder inside that tab (see below) so the other tab stays
          fully usable. */}
      {splashMounted ? (
        <Animated.View style={[styles.planLoadingOverlay, { backgroundColor: themeColors.background, opacity: splashOpacity }]}>
          <FadeInView delay={0}>
            <ShimmerLogo
              logoSource={bgIsDark(themeColors.background) ? LOGO_DARK : LOGO_LIGHT_HEADER}
              width={320}
              height={72}
              shimmerWidth={160}
              shimmerColor={themeColors.primary}
              style={{ alignSelf: 'center', marginBottom: 28 }}
            />
          </FadeInView>
          <FadeInView delay={200}>
            <Text style={[styles.planLoadingTitle, { color: themeColors.textPrimary }]}>Building your new plan</Text>
          </FadeInView>
          <Text style={[styles.planLoadingSubtitle, { color: themeColors.textSecondary }]}>
            {planStep || 'This usually takes 30–60 seconds.'}
          </Text>
          <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 8 }}>
            You can leave the app — your plan will be ready when you return.
          </Text>
          <View style={{ width: '80%', height: 6, borderRadius: 3, backgroundColor: themeColors.border, marginTop: 16, overflow: 'hidden' }}>
            <View style={{ width: `${planProgress}%`, height: '100%', borderRadius: 3, backgroundColor: themeColors.primary }} />
          </View>
          <Text style={{ color: themeColors.textMuted, fontSize: 12, marginTop: 12, textAlign: 'center', paddingHorizontal: 40 }}>
            Safe to switch apps, lock your screen, or close the app entirely — your plan keeps building on our servers.
          </Text>
          {onCancelPlanGen && (
            <TouchableOpacity
              style={{ marginTop: 20, paddingVertical: 10, paddingHorizontal: 24, borderRadius: 10, borderWidth: 1, borderColor: themeColors.border }}
              onPress={() => {
                Alert.alert(
                  'Cancel plan generation?',
                  'You can start a new plan anytime from the profile menu.',
                  [
                    { text: 'Keep waiting', style: 'cancel' },
                    { text: 'Cancel', style: 'destructive', onPress: onCancelPlanGen },
                  ],
                );
              }}>
              <Text style={{ color: themeColors.textSecondary, fontSize: 13, fontWeight: '600' }}>Cancel</Text>
            </TouchableOpacity>
          )}
        </Animated.View>
      ) : null}

      {/* Switch Day full-week regen overlay — centered, prominent spinner
          with the user's chosen focus displayed. Keeps the plan visible
          underneath so there's visual continuity while each day rebuilds. */}
      {regeneratingDayIdxs.size > 0 && !isWorkoutUpdating && !isNutritionUpdating ? (
        <View style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: themeColors.background + 'E6',
          alignItems: 'center', justifyContent: 'center',
          zIndex: 50,
        }}>
          <View style={{
            padding: 28, borderRadius: 20, alignItems: 'center',
            backgroundColor: themeColors.surface,
            borderWidth: 1, borderColor: themeColors.border,
            shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 20, shadowOffset: { width: 0, height: 8 },
            minWidth: 240,
          }}>
            <ActivityIndicator size="large" color={themeColors.primary} />
            <Text style={{ fontSize: 16, fontWeight: '800', color: themeColors.textPrimary, marginTop: 14 }}>
              Rebuilding your week
            </Text>
            {regenSelectedFocus && (
              <Text style={{ fontSize: 12, color: themeColors.textSecondary, marginTop: 4 }}>
                around <Text style={{ color: themeColors.primary, fontWeight: '700' }}>{regenSelectedFocus}</Text>
              </Text>
            )}
            <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 10 }}>
              {regeneratingDayIdxs.size} day{regeneratingDayIdxs.size === 1 ? '' : 's'} left
            </Text>
          </View>
        </View>
      ) : null}

      {/* Chat-triggered plan update — slim inline banner. */}
      {isChatPlanUpdating && !isWorkoutUpdating && !isNutritionUpdating ? (
        <View style={[styles.chatPlanUpdateBanner, { backgroundColor: themeColors.primary + '18', borderBottomColor: themeColors.primary + '33' }]}>
          <ActivityIndicator size="small" color={themeColors.primary} />
          <Text style={[styles.chatPlanUpdateText, { color: themeColors.primary }]}>
            Applying plan updates…
          </Text>
        </View>
      ) : null}

      {/* Top pill switcher removed — the bottom tab bar now owns
          workout/meals navigation. */}

      {/* Fixed workout sub-tab bar — pinned below the header so it stays
          visible regardless of what content (day cards, library, editor)
          is rendered underneath. Uses safe-area insets so it sits cleanly
          below the gradient header on any device. */}
      {activeTab === 'workout' && !(isWorkoutUpdating && !isNutritionUpdating) && (
        <View style={[styles.fixedSubTabBar, { top: insets.top + 70, backgroundColor: themeColors.background, borderBottomColor: themeColors.border }]}>
          <View style={[styles.segmentedWrap, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
            <SubTabBtn label="Plan"     active={workoutSubTab === 'plan'}      tint={workoutPalette.strong} mutedColor={themeColors.textSecondary} onPress={() => { setWorkoutSubTab('plan'); setShowExerciseLibrary(false); setSelectedExercise(null); setSelectedMuscle(null); }} />
            <SubTabBtn label="Library"  active={workoutSubTab === 'library'}   tint={workoutPalette.strong} mutedColor={themeColors.textSecondary} onPress={() => { setWorkoutSubTab('library'); setLibraryActiveTab('exercises'); setSelectedExercise(null); setSelectedMuscle(null); openExerciseLibrary(); }} />
            <SubTabBtn label="Settings" active={workoutSubTab === 'equipment'} tint={workoutPalette.strong} mutedColor={themeColors.textSecondary} onPress={() => { setWorkoutSubTab('equipment'); setShowExerciseLibrary(false); setSelectedExercise(null); setSelectedMuscle(null); }} />
            <SubTabBtn label="History"  active={workoutSubTab === 'history'}   tint={workoutPalette.strong} mutedColor={themeColors.textSecondary} onPress={() => { setWorkoutSubTab('history'); setShowExerciseLibrary(false); setSelectedExercise(null); setSelectedMuscle(null); loadWorkoutHistory().then(setWorkoutHistoryList).catch(() => {}); }} />
          </View>
        </View>
      )}

      {/* Fixed meals sub-tab bar — same pattern. */}
      {activeTab === 'meals' && !(isNutritionUpdating && !isWorkoutUpdating) && (
        <View style={[styles.fixedSubTabBar, { top: insets.top + 70, backgroundColor: themeColors.background, borderBottomColor: themeColors.border }]}>
          <View style={[styles.segmentedWrap, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
            <SubTabBtn label="Plan"    active={mealsSubTab === 'plan'}        tint={mealPalette.strong} mutedColor={themeColors.textSecondary} onPress={() => setMealsSubTab('plan')} />
            <SubTabBtn label="Foods"   active={mealsSubTab === 'foods'}       tint={mealPalette.strong} mutedColor={themeColors.textSecondary} onPress={() => setMealsSubTab('foods')} />
            {/* "Supplements" is full-width; "Supps" read as cheap/
                truncated. If this overflows on very small screens we
                can fall back to "Stack" — checked iPhone SE and it
                fits at 4 equal-width segments. */}
            <SubTabBtn label="Supplements" active={mealsSubTab === 'supplements'} tint={mealPalette.strong} mutedColor={themeColors.textSecondary} onPress={() => setMealsSubTab('supplements')} />
            <SubTabBtn label="History" active={mealsSubTab === 'history'}     tint={mealPalette.strong} mutedColor={themeColors.textSecondary} onPress={() => setMealsSubTab('history')} />
          </View>
        </View>
      )}

      {/* Tab content. Each tab gets its own loading placeholder so
          section-specific regens don't block the other tab.
          Only the workout/meals tabs render the existing ScrollView body;
          goals/progress/profile render their own inline pages below. */}
      {(activeTab === 'workout' || activeTab === 'meals') && (
      <ErrorBoundary>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContentBelowSubTab}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        onScrollBeginDrag={Keyboard.dismiss}
        showsVerticalScrollIndicator={false}
        overScrollMode="never"
      >
        {activeTab === 'workout' ? (
          (isWorkoutUpdating && !isNutritionUpdating) ? (
            <View style={[styles.tabPlanLoadingFull, { backgroundColor: themeColors.background }]}>
              <ShimmerLogo
                logoSource={bgIsDark(themeColors.background) ? LOGO_DARK : LOGO_LIGHT_HEADER}
                width={260}
                height={58}
                shimmerWidth={130}
                shimmerColor={themeColors.primary}
                style={{ alignSelf: 'center', marginBottom: 16 }}
              />
              <Text style={[styles.planLoadingTitle, { color: themeColors.textPrimary }]}>Rebuilding your workout plan</Text>
              <Text style={[styles.planLoadingSubtitle, { color: themeColors.textSecondary }]}>
                {planStep || 'This usually takes 30–60 seconds.'}
              </Text>
              <View style={{ width: '70%', height: 4, borderRadius: 2, backgroundColor: themeColors.border, marginTop: 12, overflow: 'hidden' }}>
                <View style={{ width: `${planProgress}%`, height: '100%', borderRadius: 2, backgroundColor: workoutPalette.strong }} />
              </View>
              <Text style={{ color: themeColors.textMuted, fontSize: 11, marginTop: 12, textAlign: 'center', paddingHorizontal: 30 }}>
                Safe to switch apps or lock your screen. Tap the Meals tab to keep using the app.
              </Text>
              {onCancelPlanGen && (
                <TouchableOpacity
                  style={{ marginTop: 16, paddingVertical: 8, paddingHorizontal: 20, borderRadius: 8, borderWidth: 1, borderColor: themeColors.border }}
                  onPress={() => Alert.alert('Cancel plan generation?', 'You can start a new plan anytime from the profile menu.', [
                    { text: 'Keep waiting', style: 'cancel' },
                    { text: 'Cancel', style: 'destructive', onPress: onCancelPlanGen },
                  ])}>
                  <Text style={{ color: themeColors.textSecondary, fontSize: 12, fontWeight: '600' }}>Cancel</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
          <>
            {/* Sub-tab bar moved to a fixed position above — see top of
                file. The fixed bar stays visible regardless of scroll. */}

            {/* Equipment sub-tab renders the workout editor inline.
                The wrapper sets a solid background so the remount
                frame doesn't flash-through to the previous tab's
                content or the edit screen's unstyled chrome. */}
            {workoutSubTab === 'equipment' && (
              <View style={{ flex: 1, marginHorizontal: -16, marginBottom: 70, backgroundColor: themeColors.background }}>
                <EditProfileScreen
                  authToken={authToken}
                  profile={userProfile}
                  mode="workout"
                  noHeader
                  onSave={(updated) => { onSaveProfile?.(updated, 'workout'); setWorkoutSubTab('plan'); }}
                  onCancel={() => setWorkoutSubTab('plan')}
                  onRoutinesChanged={() => { /* no-op */ }}
                />
              </View>
            )}

            {/* Workout history — ports the full Progress view (month
                calendar, weekly strip + streak, Share/Log Activity,
                session cards with per-set detail + summary card). */}
            {workoutSubTab === 'history' && (() => {
              const history = workoutHistoryList;
              const summaries = workoutHistorySummaries;
              const todayDate = new Date();
              const year = todayDate.getFullYear();
              const month = todayDate.getMonth();
              const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
              const daysInMonth = new Date(year, month + 1, 0).getDate();
              const firstDow = new Date(year, month, 1).getDay();
              const toDateKey = (d: string) => {
                if (!d) return '';
                const p = new Date(d);
                if (isNaN(p.getTime())) return d.slice(0, 10);
                return `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, '0')}-${String(p.getDate()).padStart(2, '0')}`;
              };
              const completedDates = new Set([
                ...history.filter(s => s.date && !s.skipped).map(s => toDateKey(s.date)),
                ...summaries.filter(s => s.date).map(s => toDateKey(s.date)),
              ]);
              const skippedDates = new Set(history.filter(s => s.skipped && s.date).map(s => toDateKey(s.date)));
              const cells: Array<{ day: number; key: string; status: 'done' | 'skipped' | 'rest' | 'future' | 'empty' }> = [];
              for (let i = 0; i < firstDow; i++) cells.push({ day: 0, key: `pad-${i}`, status: 'empty' });
              for (let d = 1; d <= daysInMonth; d++) {
                const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                const isFuture = d > todayDate.getDate();
                const status = isFuture ? 'future' : completedDates.has(key) ? 'done' : skippedDates.has(key) ? 'skipped' : 'rest';
                cells.push({ day: d, key, status });
              }
              while (cells.length % 7 !== 0) cells.push({ day: 0, key: `pad-end-${cells.length}`, status: 'empty' });
              const rows: typeof cells[] = [];
              for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
              const doneCount = [...completedDates].filter(k => k.startsWith(`${year}-${String(month + 1).padStart(2, '0')}`)).length;
              const skippedCount = [...skippedDates].filter(k => k.startsWith(`${year}-${String(month + 1).padStart(2, '0')}`)).length;

              // Weekly summary + streak
              const now = new Date();
              const dow = now.getDay();
              const mondayOffset = dow === 0 ? -6 : 1 - dow;
              const monday = new Date(now);
              monday.setDate(now.getDate() + mondayOffset);
              monday.setHours(0, 0, 0, 0);
              const thisWeek = history.filter(s => {
                if (!s.date || s.skipped) return false;
                return new Date(s.date) >= monday;
              });
              const totalMin = Math.round(thisWeek.reduce((a, w) => a + (w.durationSeconds || 0), 0) / 60);
              const avgMin = thisWeek.length > 0 ? Math.round(totalMin / thisWeek.length) : 0;
              const allDoneSet = new Set(history.filter(s => s.date && !s.skipped).map(s => toDateKey(s.date)));
              let streak = 0;
              const checkDate = new Date();
              const todayStr = toDateKey(checkDate.toISOString());
              if (!allDoneSet.has(todayStr)) checkDate.setDate(checkDate.getDate() - 1);
              for (let j = 0; j < 90; j++) {
                const ck = toDateKey(checkDate.toISOString());
                if (allDoneSet.has(ck)) { streak++; checkDate.setDate(checkDate.getDate() - 1); }
                else break;
              }

              return (
                <View style={{ gap: 10, marginBottom: 80 }}>
                  {/* Month calendar */}
                  <View style={{ backgroundColor: themeColors.surface, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: themeColors.border }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                      <Text style={{ fontSize: 16, fontWeight: '700', color: themeColors.textPrimary }}>{monthNames[month]} {year}</Text>
                      <View style={{ flexDirection: 'row', gap: 10 }}>
                        {doneCount > 0 && <Text style={{ fontSize: 12, color: themeColors.primary, fontWeight: '600' }}>{doneCount} done</Text>}
                        {skippedCount > 0 && <Text style={{ fontSize: 12, color: '#F59E0B', fontWeight: '600' }}>{skippedCount} skipped</Text>}
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', marginBottom: 6 }}>
                      {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
                        <Text key={d} style={{ flex: 1, textAlign: 'center', fontSize: 11, fontWeight: '600', color: themeColors.textMuted }}>{d}</Text>
                      ))}
                    </View>
                    {rows.map((row, ri) => (
                      <View key={ri} style={{ flexDirection: 'row', marginBottom: 4 }}>
                        {row.map(cell => {
                          const isToday = cell.day === todayDate.getDate() && cell.status !== 'empty';
                          return (
                            <View key={cell.key} style={{ flex: 1, alignItems: 'center', paddingVertical: 4 }}>
                              {cell.status === 'empty' ? (
                                <View style={{ width: 32, height: 32 }} />
                              ) : (
                                <View style={{
                                  width: 32, height: 32, borderRadius: 16,
                                  alignItems: 'center', justifyContent: 'center',
                                  backgroundColor:
                                    cell.status === 'done' ? themeColors.primary :
                                    cell.status === 'skipped' ? '#F59E0B33' :
                                    'transparent',
                                  borderWidth: isToday ? 2 : 0,
                                  borderColor: isToday ? themeColors.primary : 'transparent',
                                }}>
                                  <Text style={{
                                    fontSize: 13, fontWeight: isToday ? '800' : cell.status === 'done' ? '700' : '400',
                                    color: cell.status === 'done' ? '#fff'
                                      : cell.status === 'skipped' ? '#F59E0B'
                                      : cell.status === 'future' ? themeColors.textMuted + '55'
                                      : themeColors.textSecondary,
                                  }}>{cell.day}</Text>
                                </View>
                              )}
                            </View>
                          );
                        })}
                      </View>
                    ))}
                  </View>

                  {history.length === 0 ? (
                    <View style={{ padding: 24, alignItems: 'center', backgroundColor: themeColors.surface, borderRadius: 12, borderWidth: 1, borderColor: themeColors.border }}>
                      <Ionicons name="barbell-outline" size={36} color={themeColors.textMuted} />
                      <Text style={{ fontSize: 14, fontWeight: '600', color: themeColors.textSecondary, marginTop: 8 }}>No workouts yet</Text>
                      <Text style={{ fontSize: 12, color: themeColors.textMuted, marginTop: 4, textAlign: 'center' }}>
                        Finish a workout and it'll show up here.
                      </Text>
                    </View>
                  ) : (
                    <>
                      {/* Weekly strip */}
                      <View style={{ backgroundColor: themeColors.primary + '12', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: themeColors.primary + '22' }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                          <Text style={{ fontSize: 13, fontWeight: '700', color: themeColors.primary, flexShrink: 1 }}>
                            This week: {thisWeek.length} workout{thisWeek.length !== 1 ? 's' : ''} · avg {avgMin} min
                          </Text>
                          {streak > 0 && <StreakCounter count={streak} color={themeColors.primary} />}
                        </View>
                      </View>

                      {/* Actions row */}
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.textMuted, letterSpacing: 0.5 }}>
                          {history.length} WORKOUT{history.length !== 1 ? 'S' : ''}{history.length > 30 ? ' · MOST RECENT 30' : ''}
                        </Text>
                        <View style={{ flexDirection: 'row', gap: 6 }}>
                          <TouchableOpacity
                            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: themeColors.surface, borderWidth: 1, borderColor: themeColors.border }}
                            onPress={async () => {
                              try {
                                const { exportWorkoutHistory } = await import('../utils/dataExport');
                                const uname = await AsyncStorage.getItem('user_username').catch(() => null);
                                await exportWorkoutHistory(uname || undefined);
                              } catch (e: any) { Alert.alert('Export failed', e?.message ?? 'Could not export'); }
                            }}>
                            <Ionicons name="share-outline" size={14} color={themeColors.textSecondary} />
                            <Text style={{ fontSize: 11, fontWeight: '600', color: themeColors.textSecondary }}>Share</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: themeColors.primary + '15' }}
                            onPress={() => setShowLogActivity(true)}>
                            <Ionicons name="add-circle-outline" size={16} color={themeColors.primary} />
                            <Text style={{ fontSize: 12, fontWeight: '700', color: themeColors.primary }}>Log Activity</Text>
                          </TouchableOpacity>
                        </View>
                      </View>

                      {/* Session cards */}
                      {history.slice(0, 30).map((session, i) => {
                        const totalSets = (session.exercises ?? []).reduce((n, ex) => n + (ex.sets?.length ?? 0), 0);
                        const isExpanded = expandedWorkoutHistoryId === (session.id ?? `s${i}`);
                        const summary = summaries.find(s => s.date && session.date && s.date.slice(0, 10) === session.date.slice(0, 10) && s.focus === session.focus);
                        const dateObj = new Date(session.date);
                        const dateLabel = dateObj.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
                        const duration = session.durationSeconds ? `${Math.round(session.durationSeconds / 60)}m` : '–';
                        const focusLabel = session.manualActivity
                          ? `${humanizeToken(session.manualActivity.category)}${session.manualActivity.subtype ? ' · ' + humanizeToken(session.manualActivity.subtype) : ''}${session.manualActivity.intensity ? ` (${session.manualActivity.intensity})` : ''}`
                          : session.focus;
                        return (
                          <TouchableOpacity
                            key={session.id ?? i}
                            activeOpacity={0.85}
                            onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setExpandedWorkoutHistoryId(isExpanded ? null : (session.id ?? `s${i}`)); }}
                            onLongPress={() => {
                              const sid = session.id;
                              if (!sid) return;
                              Alert.alert('Delete workout', `Remove this ${focusLabel} session from history?`, [
                                { text: 'Cancel', style: 'cancel' },
                                { text: 'Delete', style: 'destructive', onPress: async () => {
                                  try {
                                    await deleteWorkoutSession(sid);
                                    const dateStr = session.date?.split('T')[0];
                                    if (authToken && dateStr) {
                                      import('../services/api').then(api => api.deleteWorkoutCompletion(authToken, dateStr, session.focus)).catch(() => {});
                                    }
                                    const fresh = await loadWorkoutHistory();
                                    setWorkoutHistoryList(fresh);
                                  } catch (e: any) { Alert.alert('Delete failed', e?.message ?? 'Could not delete'); }
                                }},
                              ]);
                            }}
                            style={{ backgroundColor: themeColors.surface, borderRadius: 12, borderWidth: 1, borderColor: themeColors.border, padding: 14 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                              <View style={{ flex: 1 }}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                  <Text style={{ fontSize: 15, fontWeight: '700', color: themeColors.textPrimary }}>{focusLabel}</Text>
                                  {summary?.totalSets != null && summary.totalSets > 0 && (
                                    <View style={{ backgroundColor: themeColors.primary + '18', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 }}>
                                      <Text style={{ fontSize: 9, fontWeight: '700', color: themeColors.primary }}>
                                        {summary.totalSets > 25 ? 'VOLUME' : summary.totalSets < 15 ? 'STRENGTH' : 'HYPERTROPHY'}
                                      </Text>
                                    </View>
                                  )}
                                </View>
                                <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }}>{dateLabel}</Text>
                              </View>
                              <View style={{ backgroundColor: themeColors.surfaceRaised, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
                                <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.textSecondary }}>{duration}</Text>
                              </View>
                              <Ionicons name={isExpanded ? 'chevron-down' : 'chevron-forward'} size={14} color={themeColors.textMuted} style={{ marginLeft: 6 }} />
                            </View>
                            <View style={{ flexDirection: 'row', gap: 6, marginTop: 4 }}>
                              <Text style={{ fontSize: 11, color: themeColors.textSecondary }}>{(session.exercises ?? []).length} exercises</Text>
                              <Text style={{ fontSize: 11, color: themeColors.textMuted }}>·</Text>
                              <Text style={{ fontSize: 11, color: themeColors.textSecondary }}>{totalSets} sets</Text>
                              {summary && summary.caloriesBurned > 0 && (
                                <>
                                  <Text style={{ fontSize: 11, color: themeColors.textMuted }}>·</Text>
                                  <Text style={{ fontSize: 11, color: themeColors.textSecondary }}>~{summary.caloriesBurned} kcal</Text>
                                </>
                              )}
                              {summary && summary.hrAvg && summary.hrAvg > 0 && (
                                <>
                                  <Text style={{ fontSize: 11, color: themeColors.textMuted }}>·</Text>
                                  <Text style={{ fontSize: 11, color: themeColors.textSecondary }}>{summary.hrAvg} avg bpm</Text>
                                </>
                              )}
                            </View>

                            {isExpanded && (
                              <View style={{ marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: themeColors.border }}>
                                {(session.exercises ?? []).filter(ex => (ex.sets?.length ?? 0) > 0).map((ex, ei) => {
                                  const best = ex.sets.reduce((b, ss) => ss.weightLbs > b.weightLbs ? ss : b, ex.sets[0]);
                                  return (
                                    <View key={ei} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
                                      <Text style={{ fontSize: 12, color: themeColors.textPrimary, flex: 1 }} numberOfLines={1}>{ex.name}</Text>
                                      <Text style={{ fontSize: 11, color: themeColors.textSecondary }}>{best.weightLbs} lbs × {best.reps}</Text>
                                    </View>
                                  );
                                })}
                                {(session.exercises ?? []).every(ex => (ex.sets?.length ?? 0) === 0) && (
                                  <Text style={{ fontSize: 11, color: themeColors.textMuted, fontStyle: 'italic' }}>No per-set detail logged.</Text>
                                )}
                                {summary && (
                                  <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: themeColors.border }}>
                                    {summary.motivationMessage ? (
                                      <Text style={{ fontSize: 13, color: themeColors.textSecondary, lineHeight: 19, marginBottom: 6 }}>{summary.motivationMessage}</Text>
                                    ) : null}
                                    {summary.achievements?.length > 0 && (
                                      <View style={{ gap: 2, marginBottom: 6 }}>
                                        {summary.achievements.map((a: string, ai: number) => (
                                          <Text key={ai} style={{ fontSize: 12, color: themeColors.primary }}>★ {a}</Text>
                                        ))}
                                      </View>
                                    )}
                                    {summary.feedback && (
                                      <Text style={{ fontSize: 12, color: themeColors.textMuted }}>
                                        Felt {summary.feedback.feeling} · intensity {summary.feedback.intensity}/5
                                        {summary.feedback.sorenessAreas?.length ? ` · sore: ${summary.feedback.sorenessAreas.join(', ')}` : ''}
                                      </Text>
                                    )}
                                  </View>
                                )}
                                <TouchableOpacity
                                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 10, paddingVertical: 8, backgroundColor: themeColors.primary + '12', borderRadius: 8 }}
                                  activeOpacity={0.85}
                                  onPress={() => {
                                    setShareWorkoutData({
                                      focus: session.focus,
                                      duration_seconds: session.durationSeconds,
                                      date: session.date,
                                      exercises: (session.exercises ?? []).map(ex => ({
                                        name: ex.name,
                                        equipment: typeof ex.equipment === 'string' ? ex.equipment : null,
                                        sets: (ex.sets ?? []).map(ss => ({ reps: ss.reps, weight_lbs: ss.weightLbs })),
                                      })),
                                      total_sets: totalSets,
                                      total_reps: (session.exercises ?? []).reduce((sum, ex) => (ex.sets ?? []).reduce((rs, ss) => rs + ss.reps, sum), 0),
                                      training_score: (summary as any)?.trainingScore ?? null,
                                      training_rating: (summary as any)?.trainingRating ?? null,
                                    });
                                  }}
                                >
                                  <Ionicons name="share-outline" size={14} color={themeColors.primary} />
                                  <Text style={{ fontSize: 12, fontWeight: '700', color: themeColors.primary }}>Share to Feed</Text>
                                </TouchableOpacity>
                              </View>
                            )}
                          </TouchableOpacity>
                        );
                      })}
                    </>
                  )}
                </View>
              );
            })()}

            {/* Birthday backfill nudge (existing users only — hides once
                profile.birthdate is set or after user dismisses). Keeps
                HR zones / calorie math accurate as users age. */}
            {workoutSubTab === 'plan' && authToken && (
              <BirthdateBackfillCard
                authToken={authToken}
                existingBirthdate={userProfile.physicalStats?.birthdate ?? null}
                themeName={userProfile.themePreference}
                onSaved={(bd, age) => {
                  // Mutate via onProfileUpdate so AsyncStorage cache
                  // and backend mirror stay consistent — same channel
                  // every other profile-mutating UI uses.
                  onProfileUpdate?.({
                    physicalStats: {
                      ...userProfile.physicalStats,
                      birthdate: bd,
                      age,
                    },
                  } as any, true);
                }}
              />
            )}

            {/* Streak + consistency widget (Feature 8) */}
            {workoutSubTab === 'plan' && authToken && (
              <StreakConsistencyWidget authToken={authToken} themeName={userProfile.themePreference} />
            )}

            {/* Combined "Today's training readiness" — fuses Recovery (per-muscle
                for today's focus) + Preparedness (sleep/HRV/nutrition/RHR).
                Re-runs when today's focus changes (Switch Day picker). */}
            {workoutSubTab === 'plan' && !isFreeTier && authToken && (() => {
              const todayPlan = nutritionPlansByDate[todayKey()] ?? null;
              const todayScheduleItem = schedule?.[0];
              const todaysFocus = todayScheduleItem?.workout?.focus ?? workoutPlan?.days?.[0]?.focus ?? null;
              return (
                <TrainingReadinessCard
                  authToken={authToken}
                  themeName={userProfile.themePreference}
                  age={userProfile.physicalStats?.age ?? null}
                  proteinTarget={todayPlan?.targets?.protein ?? null}
                  calorieTarget={todayPlan?.targets?.calories ?? null}
                  todaysFocus={todaysFocus}
                  onScoreComputed={(score, label) => {
                    // Cache the canonical phone-displayed value so the
                    // watch sync useEffect can use it instead of
                    // re-computing (eliminates phone-vs-watch drift).
                    canonicalPrepRef.current = { score, label, computedAt: Date.now() };
                  }}
                />
              );
            })()}

            {/* Menstrual cycle phase (auto-hides if no Apple Health data) */}
            {workoutSubTab === 'plan' && authToken && (
              <CyclePhaseCard themeName={userProfile.themePreference} />
            )}

            {/* Weekly digest card — only renders Sunday / post-6pm (Feature 3) */}
            {workoutSubTab === 'plan' && !isFreeTier && authToken && (
              <WeeklyDigestCard authToken={authToken} themeName={userProfile.themePreference} />
            )}

            {/* Weekly check-in countdown */}
            {workoutSubTab === 'plan' && daysUntilCheckin != null && (
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, backgroundColor: themeColors.surfaceRaised, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: themeColors.primary + '44' }}
                onPress={() => setShowWeeklyCheckin(true)}
                activeOpacity={0.7}>
                <Ionicons name="calendar-outline" size={16} color={themeColors.primary} />
                <Text style={{ fontSize: 12, fontWeight: '600', color: themeColors.textPrimary, flex: 1 }}>
                  {daysUntilCheckin === 0 ? 'Weekly review ready' : `Review in ${daysUntilCheckin}d`}
                </Text>
                <Ionicons name="chevron-forward" size={14} color={themeColors.textMuted} />
              </TouchableOpacity>
            )}

            {/* Active injuries banner */}
            {workoutSubTab === 'plan' && (() => {
              const active = (userProfile.injuryEntries ?? []).filter(i => i.status === 'active' || i.status === 'recovering');
              if (active.length === 0) return null;
              return (
                <View style={{ marginBottom: 8, backgroundColor: themeColors.surfaceRaised, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: '#F59E0B44' }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <Ionicons name="bandage-outline" size={16} color="#F59E0B" />
                    <Text style={{ fontSize: 12, fontWeight: '700', color: '#F59E0B' }}>
                      {active.length} Active Injur{active.length === 1 ? 'y' : 'ies'}
                    </Text>
                  </View>
                  {active.map(inj => (
                    <View key={inj.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
                      <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: inj.status === 'active' ? '#EF4444' : '#F59E0B' }} />
                      <Text style={{ fontSize: 11, color: themeColors.textSecondary, flex: 1 }} numberOfLines={1}>
                        {inj.bodyPart || inj.description}
                        {inj.severity ? ` · ${inj.severity}` : ''}
                        {inj.estimatedRecoveryDate ? ` · est. ${inj.estimatedRecoveryDate}` : ''}
                      </Text>
                      <Text style={{ fontSize: 9, color: inj.status === 'active' ? '#EF4444' : '#F59E0B', fontWeight: '600', textTransform: 'capitalize' }}>{inj.status}</Text>
                    </View>
                  ))}
                  <Text style={{ fontSize: 9, color: themeColors.textMuted, marginTop: 4 }}>
                    Your plan automatically avoids movements that stress injured areas
                  </Text>
                </View>
              );
            })()}

            {workoutSubTab === 'plan' && showEmailBanner && (
              <View style={{ marginBottom: 8, backgroundColor: themeColors.surfaceRaised, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: themeColors.warning + '44' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Ionicons name="mail-outline" size={16} color={themeColors.warning} />
                  <Text style={{ fontSize: 12, fontWeight: '600', color: themeColors.textPrimary, flex: 1 }}>
                    Add a valid email to secure your account
                  </Text>
                  <TouchableOpacity onPress={dismissEmailBanner} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                    <Ionicons name="close" size={16} color={themeColors.textMuted} />
                  </TouchableOpacity>
                </View>
                <TouchableOpacity
                  style={{ alignSelf: 'flex-start', marginTop: 8, paddingVertical: 6, paddingHorizontal: 14, borderRadius: 8, backgroundColor: themeColors.warning }}
                  onPress={() => { setEmailError(''); setNewEmail(''); setShowEmailModal(true); }}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: '#fff' }}>Update Email</Text>
                </TouchableOpacity>
              </View>
            )}


            {/* (Previous Readiness/RecoveryCard was replaced by TrainingReadinessCard above.) */}

            {/* Resume workout banner — shown when the user force-quit
                mid-workout. Jumps straight back into ActiveWorkoutScreen
                with all logged sets intact. */}
            {workoutSubTab === 'plan' && resumeInfo && workoutPlan?.days?.[0] && (
              <TouchableOpacity
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 10,
                  padding: 14, borderRadius: 12, marginBottom: 10,
                  backgroundColor: workoutPalette.strong + '18',
                  borderWidth: 1.5, borderColor: workoutPalette.strong + 'AA',
                }}
                onPress={() => {
                  import('../utils/feedback').then(f => f.hapticMedium()).catch(() => {});
                  if (workoutPlan?.days?.[0]) onStartWorkout(workoutPlan.days[0]);
                }}
                activeOpacity={0.8}
              >
                <Ionicons name="play-circle" size={28} color={workoutPalette.strong} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, fontWeight: '800', color: workoutPalette.strong }}>
                    Resume {resumeInfo.focus}
                  </Text>
                  <Text style={{ fontSize: 11, color: themeColors.textSecondary, marginTop: 2 }}>
                    {resumeInfo.setsLogged} set{resumeInfo.setsLogged === 1 ? '' : 's'} logged
                    {' · '}
                    started {(() => {
                      const mins = Math.max(0, Math.round((Date.now() - resumeInfo.startedAt) / 60000));
                      if (mins < 60) return `${mins} min ago`;
                      const hours = Math.floor(mins / 60);
                      return `${hours}h ${mins % 60}m ago`;
                    })()}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={async () => {
                    Alert.alert(
                      'Discard in-progress workout?',
                      'Your logged sets for this session will be cleared.',
                      [
                        { text: 'Keep', style: 'cancel' },
                        {
                          text: 'Discard',
                          style: 'destructive',
                          onPress: async () => {
                            await AsyncStorage.removeItem('activeWorkoutSets').catch(() => {});
                            await AsyncStorage.removeItem('activeWorkoutStartTime').catch(() => {});
                            setResumeInfo(null);
                          },
                        },
                      ],
                    );
                  }}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Ionicons name="close" size={18} color={themeColors.textMuted} />
                </TouchableOpacity>
              </TouchableOpacity>
            )}

            {/* Fatigue notice — shown when the backend auto-reduced
                sets on today's workout for recovering muscles. Dismissable.
                Only visible on the Plan sub-tab. Slides down from above +
                fades in on mount so the context shift feels deliberate. */}
            {workoutSubTab === 'plan' && fatigueNotice && (
              <FatigueNoticeBanner
                message={fatigueNotice}
                onDismiss={() => setFatigueNotice(null)}
              />
            )}

            {/* Plan actions row — Start / Log / Edit, with optional
                "Why this plan" pinned above when a trainer note exists.
                Four chips in a single 360-ish pt row ran out of space;
                flexWrap lets them reflow without clipping text. */}
            {workoutSubTab === 'plan' && (
              <View style={{ gap: 6, marginBottom: 8 }}>
                {trainerNote ? (
                  <TouchableOpacity
                    style={[styles.planNoteLink, { borderColor: workoutPalette.strong + '55' }]}
                    onPress={() => setShowTrainerNote(true)}
                    activeOpacity={0.7}>
                    <Ionicons name="information-circle-outline" size={14} color={workoutPalette.strong} />
                    <Text style={[styles.planNoteLinkText, { color: workoutPalette.strong }]}>
                      Why this plan
                    </Text>
                  </TouchableOpacity>
                ) : null}
                {/* Action row — icon-forward compact tiles. Labels are
                    short verbs ("Custom" / "Log" / "Edit") so nothing
                    truncates at typical iPhone widths. Long-press is
                    NOT used (doesn't carry semantic affordance for
                    fitness apps); the icon + caption pattern is the
                    primary read. */}
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity
                    style={{
                      flex: 1, alignItems: 'center', paddingVertical: 10,
                      borderRadius: 12, borderWidth: 1, gap: 4,
                      borderColor: themeColors.primary + '55',
                      backgroundColor: themeColors.primary + '0E',
                    }}
                    onPress={() => setShowLiveTracker(true)}
                    activeOpacity={0.7}>
                    <Ionicons name="flash" size={20} color={themeColors.primary} />
                    <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.primary, letterSpacing: 0.3 }}>
                      Custom
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={{
                      flex: 1, alignItems: 'center', paddingVertical: 10,
                      borderRadius: 12, borderWidth: 1, gap: 4,
                      borderColor: themeColors.primary + '33',
                    }}
                    onPress={() => setShowLogActivity(true)}
                    activeOpacity={0.7}>
                    <Ionicons name="add-circle" size={20} color={themeColors.primary} />
                    <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.primary, letterSpacing: 0.3 }}>
                      Log
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={{
                      flex: 1, alignItems: 'center', paddingVertical: 10,
                      borderRadius: 12, borderWidth: 1, gap: 4,
                      borderColor: themeColors.border,
                    }}
                    onPress={() => setWorkoutSubTab('equipment')}
                    activeOpacity={0.7}>
                    <Ionicons name="settings-sharp" size={20} color={themeColors.textMuted} />
                    <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.textMuted, letterSpacing: 0.3 }}>
                      Edit
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {workoutSubTab === 'plan' && availabilityItems.length > 0 && (
              <View style={{
                flexDirection: 'row', alignItems: 'center', gap: 6,
                paddingHorizontal: 2, marginBottom: 8,
                flexWrap: 'wrap',
              }}>
                <Text style={{ fontSize: 10, fontWeight: '700', color: themeColors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginRight: 4 }}>
                  This week
                </Text>
                {availabilityItems.slice(0, 3).map(item => (
                  <View key={item.label} style={{
                    paddingHorizontal: 8, paddingVertical: 3,
                    borderRadius: 10,
                    borderWidth: 1, borderColor: themeColors.border,
                    backgroundColor: themeColors.surface,
                  }}>
                    <Text style={{ fontSize: 11, color: themeColors.textSecondary, fontWeight: '600' }}>
                      {item.label}
                    </Text>
                  </View>
                ))}
              </View>
            )}
            {workoutSubTab === 'plan' && (() => {
              const splitRaw = (userProfile.preferredSplit || '').toLowerCase();
              const collapseUpper = /upper.?lower|full.?body/.test(splitRaw)
                || (!splitRaw && (workoutPlan?.days ?? []).some(d => /upper|lower/i.test(d?.focus || '')));
              // Focus-family normalizer. For U/L and full-body splits we
              // collapse push/pull/arms/shoulders into a single "upper"
              // bucket so the adjacency filter doesn't show every card
              // wrapped in an unusable option set. For PPL we keep
              // push/pull distinct since those are the split's whole point.
              const normFamily = (f?: string): string => {
                const s = (f ?? '').toLowerCase();
                if (/legs?|quad|glute|hamstring|lower|squat|hinge|calves/.test(s)) return 'lower';
                if (collapseUpper) {
                  if (/upper|push|chest|tricep|press|pull|back|bicep|lat|shoulder|arm/.test(s)) return 'upper';
                } else {
                  if (/push|chest|tricep|press/.test(s)) return 'push';
                  if (/pull|back|bicep|lat/.test(s)) return 'pull';
                  if (/upper|shoulder|arm/.test(s)) return 'upper';
                }
                if (/full.?body|total/.test(s)) return 'full';
                if (/cardio|zone.?2|interval|run|bike|swim|row/.test(s)) return 'cardio';
                if (/recover|rest|mobil|stretch|yoga|flow/.test(s)) return 'easy';
                return s || 'unknown';
              };

              const inferSplitFromPlan = (): string => {
                const focuses = (workoutPlan?.days ?? []).map(d => (d?.focus || '').toLowerCase()).filter(Boolean);
                if (focuses.some(f => /chest|back|shoulders|arms/.test(f))) return 'bro';
                if (focuses.some(f => /upper/.test(f)) && focuses.some(f => /lower/.test(f))
                    && focuses.some(f => /push|pull/.test(f))) return 'ppl_upper_lower';
                if (focuses.some(f => /upper/.test(f)) && focuses.some(f => /lower/.test(f))) return 'upper_lower';
                if (focuses.some(f => /full.?body/.test(f))) return 'full_body';
                return 'ppl';
              };
              const knownSplits = new Set(['ppl', 'upper_lower', 'full_body', 'ppl_upper_lower', 'bro']);
              const rawSplit = userProfile.preferredSplit ?? '';
              const split = knownSplits.has(rawSplit) ? rawSplit : inferSplitFromPlan();
              const splitFocusOptions: Record<string, string[]> = {
                ppl: ['Push', 'Pull', 'Legs'],
                upper_lower: ['Upper', 'Lower'],
                full_body: ['Full Body'],
                ppl_upper_lower: ['Push', 'Pull', 'Legs', 'Upper', 'Lower'],
                bro: ['Chest', 'Back', 'Shoulders', 'Arms', 'Legs'],
              };
              // Lift + same-day cardio finisher variants. Only offered for
              // splits where the backend can produce the matching
              // PLUS_CARDIO archetype (PPL, Upper/Lower, Full Body). Bro
              // split maps chest/back/shoulders/arms → upper+cardio already
              // on the backend, so we surface Upper+Cardio only.
              const splitPlusCardioOptions: Record<string, string[]> = {
                ppl: ['Push + Cardio', 'Pull + Cardio'],
                upper_lower: ['Upper + Cardio', 'Lower + Cardio'],
                full_body: ['Full Body + Cardio'],
                ppl_upper_lower: ['Push + Cardio', 'Pull + Cardio', 'Upper + Cardio'],
                bro: ['Upper + Cardio'],
              };
              const focusOptions = splitFocusOptions[split] ?? splitFocusOptions.ppl;
              const plusCardioOptions = splitPlusCardioOptions[split] ?? splitPlusCardioOptions.ppl;
              const extraOptions = ['Cardio', 'Mobility', 'Recovery'];
              // "Empty" lets the user start from a blank day and add their
              // own exercises — no generator is run. Always last so it reads
              // as an escape hatch, not a primary choice.
              const allOptions = [...focusOptions, ...plusCardioOptions, ...extraOptions, 'Empty'];

              // Map dateKey → focus the user EITHER did or planned-then-skipped.
              // Skipped days now contribute to adjacency checks because a
              // user who skipped Pull yesterday still doesn't want Pull
              // today (the muscle group hasn't been "done" but the slot is
              // claimed for that pattern in the rotation). Was previously
              // excluding skipped, which made the picker recommend Pull
              // again right after a skip.
              const focusByDate = new Map<string, string>();
              for (const s of workoutHistoryList) {
                if (!s?.date) continue;
                const k = (s.date || '').slice(0, 10);
                // Completion takes precedence over skip; skip fills in
                // the gap where no completion exists for that day.
                if (!s.skipped && k && !focusByDate.has(k)) {
                  focusByDate.set(k, s.focus || '');
                }
              }
              for (const s of workoutHistoryList) {
                if (!s?.date || !s.skipped) continue;
                const k = (s.date || '').slice(0, 10);
                if (k && !focusByDate.has(k) && s.focus) {
                  focusByDate.set(k, s.focus);
                }
              }
              // Also pull skipped focus from the in-memory skippedDates
              // set + skipReasonsByDate, in case workoutHistoryList hasn't
              // hydrated the skip yet (skip persists locally before history
              // refreshes).
              for (const dk of skippedDates) {
                if (!focusByDate.has(dk)) {
                  // Skip rows in workoutHistory carry the focus, but the
                  // local skippedDates set doesn't — best effort: use the
                  // schedule's planned focus for that date if available.
                  const planned = scheduleForRender.find(it => dateKey(it.date) === dk)?.workout?.focus;
                  if (planned) focusByDate.set(dk, planned);
                }
              }

              // Helpers closed over schedule so the filter can read
              // neighbors directly (workoutPlan.days indices are not
              // always 1:1 with schedule indices — rest days cause drift).
              const scheduleFocusAt = (j: number): string | undefined => {
                if (j < 0) {
                  const d = new Date(); d.setDate(d.getDate() + j);
                  const dk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                  return focusByDate.get(dk);
                }
                if (j >= schedule.length) return undefined;
                return schedule[j]?.workout?.focus;
              };
              const isFixedNeighbor = (j: number): boolean => {
                if (j < 0) {
                  const d = new Date(); d.setDate(d.getDate() + j);
                  const dk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                  return focusByDate.has(dk);
                }
                if (j >= schedule.length) return false;
                if (j === 0) return true; // today is always pinned for adjacency
                const it = schedule[j];
                const dk = it?.date ? dateKey(it.date) : '';
                return completedDates.has(dk) || skippedDates.has(dk);
              };

              return scheduleForRender.map((item, i) => {
              const key = dateKey(item.date);
              const isToday     = i === 0;
              const isCompleted = isToday && todayDone;
              const isSkipped   = skippedDates.has(key);

              // Compute per-option warnings (don't filter — let user pick
              // anything, but flag conflicts and low readiness so they
              // see the trade-off before confirming).
              //
              // Conflict window EXTENDED:
              //  - i-1 / i+1 (immediate neighbors) — full conflict
              //  - i-2 (2 days back) — counts ONLY if the day between is
              //    "easy" (mobility/recovery/skipped/cardio). For 7-day
              //    users this prevents [Pull, Mobility, Pull] looking
              //    fine just because mobility broke the strict adjacency.
              const conflictFamilies = new Set<string>();
              if (isFixedNeighbor(i - 1)) conflictFamilies.add(normFamily(scheduleFocusAt(i - 1)));
              if (isFixedNeighbor(i + 1)) conflictFamilies.add(normFamily(scheduleFocusAt(i + 1)));
              const isEasyFocus = (f?: string) => {
                const x = (f || '').toLowerCase();
                return /recover|rest|mobil|stretch|yoga|flow|cardio|zone.?2|easy/.test(x);
              };
              const between = scheduleFocusAt(i - 1);
              if (isFixedNeighbor(i - 2) && (between == null || isEasyFocus(between))) {
                conflictFamilies.add(normFamily(scheduleFocusAt(i - 2)));
              }
              const betweenAfter = scheduleFocusAt(i + 1);
              if (isFixedNeighbor(i + 2) && (betweenAfter == null || isEasyFocus(betweenAfter))) {
                conflictFamilies.add(normFamily(scheduleFocusAt(i + 2)));
              }
              conflictFamilies.delete('unknown'); conflictFamilies.delete('');
              // Easy focuses don't compete for hard-family adjacency —
              // mobility/recovery/cardio shouldn't be blocked just
              // because they share a "neutral" slot with another easy day.
              for (const fam of Array.from(conflictFamilies)) {
                if (['easy', 'cardio'].includes(fam)) conflictFamilies.delete(fam);
              }

              const mf = readinessScore?.muscleFatigue ?? {};
              const readinessFor = (focus: string): number | null => {
                const lower = (focus || '').toLowerCase();
                const avg = (keys: string[]) => {
                  const vals = keys.map(k => mf[k] ?? 0);
                  if (vals.length === 0) return 0;
                  return vals.reduce((a, b) => a + b, 0) / vals.length;
                };
                // PLUS_CARDIO variants: blend the lift-group fatigue with
                // cardio fatigue so a user who's already stacked a lot of
                // cardio recently sees a lower readiness on "Push + Cardio"
                // than on plain "Push".
                const isPlusCardio = /\+\s*cardio/.test(lower);
                let fatigue = 0;
                if (/push|chest|pressing/.test(lower)) fatigue = avg(['chest', 'shoulders', 'triceps']);
                else if (/pull|back|bicep|lat/.test(lower)) fatigue = avg(['back', 'biceps']);
                else if (/legs|quad|hamstring|glute|lower/.test(lower)) fatigue = avg(['quads', 'hamstrings', 'glutes', 'calves']);
                else if (/upper/.test(lower)) fatigue = avg(['chest', 'back', 'shoulders', 'biceps', 'triceps']);
                else if (/full/.test(lower)) fatigue = avg(['chest', 'back', 'shoulders', 'quads', 'glutes', 'hamstrings']);
                else if (/shoulders?/.test(lower)) fatigue = avg(['shoulders']);
                else if (/arms?/.test(lower)) fatigue = avg(['biceps', 'triceps']);
                else if (/cardio|zone|interval/.test(lower)) fatigue = mf['cardio'] ?? 0;
                else return null; // no fatigue concept (mobility/recovery)
                if (isPlusCardio) {
                  // 70% lift + 30% cardio — the lift is the primary stress,
                  // the cardio finisher is lighter but still meaningful.
                  fatigue = fatigue * 0.7 + (mf['cardio'] ?? 0) * 0.3;
                }
                return Math.max(0, Math.min(100, Math.round((1 - fatigue) * 100)));
              };

              const optionWarnings: Record<string, { conflict: boolean; readiness: number | null }> = {};
              for (const opt of allOptions) {
                const conflict = conflictFamilies.has(normFamily(opt));
                const readiness = readinessFor(opt);
                optionWarnings[opt] = { conflict, readiness };
              }
              // Sort options so the BEST (no conflict + high readiness)
              // ones appear first in the picker. Empty stays last.
              // Without this, picker presented Push/Pull/Legs in a fixed
              // order — a user who did Pull yesterday saw Pull as a
              // first-row option even though it was the wrong choice.
              // Recently-completed focuses (last 3 days) get a heavier
              // penalty than the immediate-neighbor adjacency check —
              // the user explicitly told us "do less of this muscle
              // group" by training it. Without this, a Pull yesterday
              // could still surface as a top option if today's
              // adjacency check happened to miss it (e.g., date-key
              // mismatch, sync race, off-by-one).
              const recentFams: string[] = [];
              for (const s of workoutHistoryList.slice(0, 5)) {
                if (!s?.date || s.skipped) continue;
                const k = (s.date || '').slice(0, 10);
                const ageDays = (Date.now() - new Date(k).getTime()) / 86400000;
                if (ageDays >= 0 && ageDays <= 3) {
                  const fam = normFamily(s.focus);
                  if (fam && fam !== 'unknown') recentFams.push(fam);
                }
              }
              const recentSet = new Set(recentFams);
              const optionRank = (opt: string): number => {
                if (opt === 'Empty') return 1000;
                const w = optionWarnings[opt];
                const conflictPenalty = w?.conflict ? 200 : 0;
                const readinessPenalty = 100 - (w?.readiness ?? 50);
                // History penalty — heavy. A focus the user just did
                // shouldn't appear above one they haven't, even if the
                // muscle fatigue is similar. Stacks with adjacency, so
                // "did Pull yesterday" gets +200 (adjacency) + +250
                // (recent) = +450, way beyond a fresh focus's ~50.
                const recentPenalty = recentSet.has(normFamily(opt)) ? 250 : 0;
                // Mobility/Recovery sit slightly below pure lifts when
                // readiness is similar so users don't accidentally pick
                // them as a first-instinct.
                const easyTie = /recover|mobil/i.test(opt) ? 5 : 0;
                return conflictPenalty + readinessPenalty + recentPenalty + easyTie;
              };
              const sortedOptions = [...allOptions].sort((a, b) => optionRank(a) - optionRank(b));

              return (
                <FadeInView key={i} delay={i * 80}>
                <DayCard
                  item={item}
                  themeName={userProfile.themePreference}
                  isToday={isToday}
                  isCompleted={isCompleted}
                  isSkipped={isSkipped}
                  skipReason={skipReasonsByDate[key]}
                  completedSummary={isCompleted ? todaySummary : null}
                  expanded={expandedDay === i}
                  onPress={() => {
                    import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
                    const collapsing = expandedDay === i;
                    setExpandedDay(collapsing ? -1 : i);
                    // Collapse the Switch Day picker when the parent
                    // card collapses — otherwise re-expanding the card
                    // shows the picker already open, which reads as a
                    // bug even though state was technically preserved.
                    if (collapsing && switchDayIdx === i) setSwitchDayIdx(-1);
                  }}
                  onStartWorkout={onStartWorkout}
                  onSkip={handleSkipToday}
                  onUnskip={() => handleUnskipDay(key)}
                  onUndoComplete={isToday ? () => handleUndoComplete(key) : undefined}
                  splitOptions={sortedOptions}
                  optionWarnings={optionWarnings}
                  showSwitchOptions={switchDayIdx === i}
                  onToggleSwitch={() => { import('../utils/feedback').then(f => f.hapticLight()).catch(() => {}); setSwitchDayIdx(switchDayIdx === i ? -1 : i); }}
                  hasPlateauedExercises={plateauedExercises.size > 0 && (item.workout?.exercises ?? []).some(ex => plateauedExercises.has(ex.name.toLowerCase()))}
                  isRegenerating={(() => {
                    const idx = workoutPlan ? workoutPlan.days.indexOf(item.workout as any) : -1;
                    return idx >= 0 && regeneratingDayIdxs.has(idx);
                  })()}
                  onSwapExercise={async (workout, exIdx, exName) => {
                    // The picker reads from `exerciseLibrary` state.
                    // If we open the modal BEFORE the library is
                    // fetched, the user sees an empty list and thinks
                    // Swap is broken (the actual bug a pilot user hit).
                    // Await the fetch first — `ensureExerciseLibrary`
                    // is no-op-fast when the library is already loaded.
                    try {
                      const lib = await ensureExerciseLibrary();
                      if (!lib || lib.length === 0) {
                        Alert.alert(
                          'Exercise library not loaded',
                          'Try again in a moment — we\'re still fetching the library.',
                        );
                        return;
                      }
                    } catch {
                      Alert.alert(
                        'Could not load library',
                        'Check your connection and try again.',
                      );
                      return;
                    }
                    setSwapExerciseState({ workout, exerciseIndex: exIdx, exerciseName: exName });
                  }}
                  onOpenExerciseVideo={(exName) => {
                    // Launched from the small thumbnail on an exercise
                    // row. Pull context from the workout exercise so
                    // the video-search filter is tight.
                    const ex = (item.workout?.exercises || []).find(
                      (e: any) => (e.name || '').toLowerCase() === exName.toLowerCase(),
                    );
                    openExerciseVideo(exName, {
                      equipment: (ex as any)?.equipment ?? null,
                      primary_muscle: (ex as any)?.primary_muscle ?? null,
                      movement_pattern: (ex as any)?.movement_pattern ?? null,
                    });
                  }}
                  onViewExercise={async (exName) => {
                    // Navigate to Library sub-tab with the exercise
                    // pre-selected. ensureExerciseLibrary returns the
                    // loaded list directly so we don't race React state
                    // (previous closure captured stale exerciseLibrary).
                    const lib = await ensureExerciseLibrary().catch(() => [] as ExerciseLibraryItem[]);
                    const norm = exName.toLowerCase().trim();
                    const hit = lib.find(e => (e.name || '').toLowerCase() === norm)
                      ?? lib.find(e => (e.name || '').toLowerCase().includes(norm));
                    if (hit) {
                      setSelectedExercise(hit);
                      setShowExerciseLibrary(true);
                      setWorkoutSubTab('library');
                      setLibraryActiveTab('exercises');
                    } else {
                      // No match — still route the user to Library so
                      // they can search manually rather than silently
                      // doing nothing.
                      setWorkoutSubTab('library');
                      setShowExerciseLibrary(true);
                      setLibraryActiveTab('exercises');
                      setExerciseSearch(exName);
                    }
                  }}
                  onChangeFocus={async (newFocus) => {
                    setSwitchDayIdx(-1);
                    if (!workoutPlan || !item.workout) return;
                    // Map the tapped VISUAL schedule item back to its
                    // RECIPE index so the backend pins the right entry
                    // in `current_days` (which we send in recipe order).
                    //
                    // The visual schedule is `workoutPlan.days` rotated
                    // by `weekOffset` and interleaved with rest days
                    // (see `get7DaySchedule`). Using the visual index
                    // `i` directly would target the wrong recipe entry
                    // — the user's "tap day 4, day 1 changes" bug.
                    //
                    // `indexOf` works because each schedule item carries
                    // a reference to the exact same `workoutPlan.days[k]`
                    // object that was assigned in `get7DaySchedule`.
                    const recipeIdx = workoutPlan.days.indexOf(item.workout as any);
                    const dayIdx = recipeIdx >= 0 ? recipeIdx : i;

                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                    import('../utils/feedback').then(f => f.hapticMedium()).catch(() => {});

                    if (newFocus !== 'Empty') {
                      const { requirePro } = await import('../utils/subscription');
                      if (!requirePro(userProfile, 'ai_day_regenerate')) return;
                    }

                    if (newFocus === 'Empty') {
                      const updatedDays = [...workoutPlan.days];
                      updatedDays[dayIdx] = { ...updatedDays[dayIdx], focus: 'Empty', exercises: [] };
                      const updatedPlan = { ...workoutPlan, days: updatedDays };
                      setWorkoutPlan(updatedPlan);
                      AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(updatedPlan)).catch(() => {});
                      AsyncStorage.setItem(`freshDayGenerated_${todayKey()}`, '1').catch(() => {});
                      return;
                    }

                    // Show overlay
                    setRegeneratingDayIdxs(new Set(Array.from({ length: workoutPlan.days.length }, (_, k) => k)));
                    setRegenSelectedFocus(newFocus);

                    try {
                      if (!authToken) throw new Error('no auth');
                      const injuries = (userProfile.injuryEntries ?? [])
                        .filter(i => i.status !== 'resolved')
                        .map(i => `${i.bodyPart || i.description} (status: ${i.status})`);

                      // 1. Pin day in current week — backend swaps target with
                      //    closest matching lift. We send `current_days` so the
                      //    pin operates on the user's existing plan instead of
                      //    a freshly regenerated week (which would replace
                      //    every day and the pin would land at the wrong
                      //    visual index).
                      const { generateWorkoutWeek, getActiveWorkoutPlan } = await import('../services/api');
                      await generateWorkoutWeek(authToken, {
                        goal: userProfile.goal,
                        days_per_week: userProfile.daysPerWeek,
                        session_minutes: userProfile.workoutDurationMinutes ?? 60,
                        experience: userProfile.experienceLevel ?? 'intermediate',
                        equipment: userProfile.equipment ?? [],
                        preferred_split: userProfile.preferredSplit,
                        priority_region: userProfile.priorityRegion ?? 'balanced',
                        injuries,
                        disliked_exercises: userProfile.dislikedExercises ?? [],
                        pin_day_index: dayIdx,
                        pin_focus: newFocus,
                        current_days: workoutPlan.days,
                      });

                      // 2. Read back from DB — single source of truth
                      const active = await getActiveWorkoutPlan(authToken);
                      if (active?.plan_json?.days?.length) {
                        const plan = active.plan_json;
                        setWorkoutPlan(plan);
                        await AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(plan));
                        await AsyncStorage.setItem(`freshDayGenerated_${todayKey()}`, '1');
                        console.log('[switchDay] done — focuses:', plan.days.map((d: any) => d.focus));
                      }
                      loadDayStatus();
                    } catch (e) {
                      console.log('[switchDay] failed:', e);
                    } finally {
                      setRegeneratingDayIdxs(new Set());
                      setRegenSelectedFocus(null);
                    }
                  }}
                />
                </FadeInView>
              );
            });
            })()}
          </>
          )
        ) : (
          // Meals tab — section-scoped loading placeholder when only the
          // nutrition plan is rebuilding. Workout tab stays usable.
          (isNutritionUpdating && !isWorkoutUpdating) ? (
            <View style={[styles.tabPlanLoadingFull, { backgroundColor: themeColors.background }]}>
              <ShimmerLogo
                logoSource={bgIsDark(themeColors.background) ? LOGO_DARK : LOGO_LIGHT_HEADER}
                width={260}
                height={58}
                shimmerWidth={130}
                shimmerColor={themeColors.primary}
                style={{ alignSelf: 'center', marginBottom: 16 }}
              />
              <Text style={[styles.planLoadingTitle, { color: themeColors.textPrimary }]}>Rebuilding your meal plan</Text>
              <Text style={[styles.planLoadingSubtitle, { color: themeColors.textSecondary }]}>
                {planStep || 'This usually takes 30–60 seconds.'}
              </Text>
              <View style={{ width: '70%', height: 4, borderRadius: 2, backgroundColor: themeColors.border, marginTop: 12, overflow: 'hidden' }}>
                <View style={{ width: `${planProgress}%`, height: '100%', borderRadius: 2, backgroundColor: mealPalette.strong }} />
              </View>
              <Text style={{ color: themeColors.textMuted, fontSize: 11, marginTop: 12, textAlign: 'center', paddingHorizontal: 30 }}>
                Safe to switch apps or lock your screen. Tap the Workout tab to keep using the app.
              </Text>
              {onCancelPlanGen && (
                <TouchableOpacity
                  style={{ marginTop: 16, paddingVertical: 8, paddingHorizontal: 20, borderRadius: 8, borderWidth: 1, borderColor: themeColors.border }}
                  onPress={() => Alert.alert('Cancel plan generation?', 'You can start a new plan anytime from the profile menu.', [
                    { text: 'Keep waiting', style: 'cancel' },
                    { text: 'Cancel', style: 'destructive', onPress: onCancelPlanGen },
                  ])}>
                  <Text style={{ color: themeColors.textSecondary, fontSize: 12, fontWeight: '600' }}>Cancel</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
          <>
            {/* Sub-tab bar moved to a fixed position above — see top of file. */}

            {/* Non-Plan sub-tabs (Foods / Supps / Macros) render
                EditProfileScreen inline. History has its own dedicated view
                below. The wrapper sets a solid background so the remount
                frame (triggered by the `key` prop below) doesn't
                flash-through to the previous tab's content. */}
            {/* Supplements sub-tab now has its own V1 screen — stack
                CRUD, Today check-offs, Recommendations driven by food
                gaps. Replaces the old EditProfileScreen-based view. */}
            {mealsSubTab === 'supplements' && (
              <View style={{ flex: 1, marginHorizontal: -16, marginBottom: 70, backgroundColor: themeColors.background }}>
                <SupplementStackScreen
                  authToken={authToken!}
                  themeName={userProfile.themePreference}
                />
              </View>
            )}

            {(mealsSubTab !== 'plan' && mealsSubTab !== 'history' && mealsSubTab !== 'supplements') && (
              <View style={{ flex: 1, marginHorizontal: -16, marginBottom: 70, backgroundColor: themeColors.background }}>
                {mealsSubTab === 'foods' && (
                  <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
                    <TouchableOpacity
                      onPress={() => setShowGroceryList(true)}
                      activeOpacity={0.8}
                      style={{
                        flexDirection: 'row', alignItems: 'center', gap: 10,
                        backgroundColor: themeColors.surface,
                        borderRadius: 12, padding: 12, marginBottom: 10,
                        borderWidth: 1, borderColor: themeColors.border,
                      }}
                    >
                      <View style={{
                        width: 34, height: 34, borderRadius: 17,
                        backgroundColor: themeColors.surfaceRaised,
                        alignItems: 'center', justifyContent: 'center',
                      }}>
                        <Ionicons name="cart-outline" size={18} color={themeColors.primary} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontWeight: '700', color: themeColors.textPrimary }}>Grocery list</Text>
                        <Text style={{ fontSize: 11, color: themeColors.textMuted }}>Auto-built from this week's meals</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={16} color={themeColors.textMuted} />
                    </TouchableOpacity>
                    {/* Saved Meals — user-curated reusable bundles.
                        Separate from Favorites (auto-detected from
                        repeat eating) and Routines (scheduled). This
                        is where a "Save as Meal" from the editor
                        shows up for one-tap logging. */}
                    {authToken && (
                      <SavedMealsSection
                        authToken={authToken}
                        themeName={userProfile.themePreference}
                        onLogged={() => {
                          // Reload today's plan so the newly-logged
                          // meal appears on the plan tab. `onWeeklyRefresh`
                          // is the wrong callback here — it expects a
                          // `{adherence, energy, notes}` review object
                          // from the weekly check-in flow and crashes
                          // when called empty.
                          loadDayStatus();
                          if (userProfile) loadPlans(userProfile);
                        }}
                        onEditTemplate={(sm) => {
                          setEditingSavedMeal({
                            id: sm.id,
                            name: sm.name,
                            items: sm.items || [],
                          });
                        }}
                      />
                    )}
                    {commonMeals.length > 0 && (
                      <>
                        <Text style={{ fontSize: 12, fontWeight: '700', color: themeColors.textMuted, marginBottom: 6 }}>YOUR FAVORITES</Text>
                        <Text style={{ fontSize: 10, color: themeColors.textMuted, marginBottom: 6 }}>
                          Meals you've eaten 2+ times. Auto-detected — no need to save them.
                        </Text>
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast">
                          {commonMeals.map(m => (
                            <View key={m.name} style={{ backgroundColor: themeColors.surface, borderRadius: 10, padding: 10, marginRight: 8, borderWidth: 1, borderColor: themeColors.border, minWidth: 120 }}>
                              <Text style={{ fontSize: 12, fontWeight: '700', color: themeColors.textPrimary }} numberOfLines={1}>{m.name}</Text>
                              <Text style={{ fontSize: 10, color: themeColors.textMuted }}>{m.count}x · {Math.round(m.avg_calories)} cal · {Math.round(m.avg_protein_g)}g protein</Text>
                            </View>
                          ))}
                        </ScrollView>
                      </>
                    )}
                  </View>
                )}
                <EditProfileScreen
                  key={`meal-${mealsSubTab}`}
                  authToken={authToken}
                  profile={userProfile}
                  mode="mealplan"
                  initialMealTab={mealsSubTab as 'foods' | 'supplements' | 'macros'}
                  noHeader
                  onSave={(updated) => { onSaveProfile?.(updated, 'mealplan'); setMealsSubTab('plan'); }}
                  onCancel={() => setMealsSubTab('plan')}
                  onRoutinesChanged={() => { /* no-op */ }}
                />
              </View>
            )}

            {/* History — past 14 days of meal plans. Each day card expands
                to show its meals; tapping a meal opens MealEditModal
                pointed at that historical date. Edits persist via the same
                handleMealSave path as the Plan tab. */}
            {mealsSubTab === 'history' && (() => {
              // Build a date-ordered list of days that have either plan data
              // or meal-check data. Limited to the last 14 days.
              const days: string[] = [];
              const seen = new Set<string>();
              for (const k of Object.keys(nutritionPlansByDate).concat(Object.keys(checkedMealsByDate))) {
                if (!seen.has(k)) { seen.add(k); days.push(k); }
              }
              const todayStr = todayKey();
              // Past dates only. `nutritionPlansByDate` intentionally
              // carries forward 7 days of plans for the Plan tab —
              // those must NOT leak into history, or future days would
              // appear with the "fully logged" treatment just because
              // the plan exists (and maybe has auto-checks). History
              // is PAST days only.
              const sorted = days
                .filter(d => d < todayStr)
                .sort((a, b) => b.localeCompare(a))
                .slice(0, 14);
              if (sorted.length === 0) {
                return (
                  <View style={{ padding: 24, alignItems: 'center' }}>
                    <Ionicons name="time-outline" size={36} color={themeColors.textMuted} />
                    <Text style={{ fontSize: 14, fontWeight: '600', color: themeColors.textSecondary, marginTop: 8 }}>No meal history yet</Text>
                    <Text style={{ fontSize: 12, color: themeColors.textMuted, marginTop: 4, textAlign: 'center' }}>
                      Your past days will show up here once you've logged meals.
                    </Text>
                  </View>
                );
              }
              // Build a 14-day calendar strip (7 per row, oldest → newest).
              // Each cell is colored by that day's nutrition score.
              const calendarDays: Array<{ date: string; score: number | null }> = [];
              for (let i = 13; i >= 0; i--) {
                const dt = new Date(Date.now() - i * 86400000);
                const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
                const p = nutritionPlansByDate[key];
                const checks = checkedMealsByDate[key] ?? {};
                const anyChecked = Object.values(checks).some(Boolean);
                const isPast = key < todayStr;
                let sc: number | null = null;
                // Past days: only show a score when at least one meal was logged.
                // Today: show the planned score regardless.
                if (p && p.meals && p.meals.length > 0 && (!isPast || anyChecked)) {
                  try {
                    const ds = computeNutritionScore(p, userProfile?.goal ?? 'body_recomp');
                    sc = ds && ds.score > 0 ? ds.score : null;
                  } catch { sc = null; }
                }
                calendarDays.push({ date: key, score: sc });
              }
              const scoreColor = (s: number | null): string => {
                // Pull from theme so the score tier colors match the
                // active palette. All themes define success/warning/
                // error semantics, so this is safe across every one.
                if (s == null) return themeColors.border;
                if (s >= 70) return themeColors.success;
                if (s >= 45) return themeColors.warning;
                return themeColors.error;
              };
              return (
                <View style={{ gap: 10, marginBottom: 80 }}>
                  {/* Score calendar — 14 days, 7 per row */}
                  <View style={{ backgroundColor: themeColors.surface, borderRadius: 14, borderWidth: 1, borderColor: themeColors.border, padding: 12 }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.textMuted, letterSpacing: 0.5, marginBottom: 8 }}>
                      NUTRITION SCORE · LAST 14 DAYS
                    </Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                      {calendarDays.map(c => {
                        const dt = new Date(c.date + 'T12:00:00');
                        const dateLabel = `${dt.getMonth() + 1}/${dt.getDate()}`;
                        const isToday = c.date === todayStr;
                        const isSelected = expandedHistoryDate === c.date;
                        const color = scoreColor(c.score);
                        const hasScore = c.score != null;
                        // "Fully logged" — day counts as complete when
                        // EITHER (a) every non-removed plan meal is
                        // checked, OR (b) at least 3 meals are checked
                        // (catches users who manually log without the
                        // plan matching exactly). Removed meals are
                        // always excluded from the all-checked criterion.
                        const planDay = nutritionPlansByDate[c.date];
                        const checks = checkedMealsByDate[c.date] ?? {};
                        const removedSetHist = new Set((planDay?.removedMealIds ?? []) as string[]);
                        const activeKeys = (planDay?.meals ?? [])
                          .map((_, i) => `meal_${i}`)
                          .filter(k => !removedSetHist.has(k));
                        const checkedCount = Object.values(checks).filter(Boolean).length;
                        const allPlanChecked = activeKeys.length > 0 && activeKeys.every(k => !!checks[k]);
                        const fullyLogged = allPlanChecked || checkedCount >= 3;
                        return (
                          <TouchableOpacity
                            key={c.date}
                            activeOpacity={0.7}
                            onPress={() => {
                              if (isToday) return;
                              configureExpandAnimation(300);
                              setExpandedHistoryDate(isSelected ? null : c.date);
                            }}
                            style={{
                              width: `${100 / 7 - 2}%`,
                              paddingVertical: 8,
                              paddingHorizontal: 2,
                              borderRadius: 10,
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: 4,
                              // Strip the "fully logged" outline + tinted
                              // background — the card below already shows
                              // the day's state with much more detail. The
                              // calendar's only job is "let me pick a day +
                              // see the score color." Border + bg now only
                              // change when SELECTED.
                              backgroundColor: themeColors.surfaceRaised,
                              borderWidth: isSelected ? 2 : 1,
                              borderColor: isSelected ? themeColors.primary : themeColors.border,
                            }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                              <Text style={{ fontSize: 10, fontWeight: '700', color: isToday ? themeColors.primary : themeColors.textSecondary }}>
                                {dateLabel}
                              </Text>
                              {/* Calendar checkmark removed — the
                                  card below already shows the daily
                                  state clearly. The little check next
                                  to the date label was redundant +
                                  visually noisy. */}
                            </View>
                            <View style={{
                              width: 28, height: 28, borderRadius: 14,
                              alignItems: 'center', justifyContent: 'center',
                              backgroundColor: hasScore ? color : 'transparent',
                              borderWidth: hasScore ? 0 : 1,
                              borderColor: hasScore ? 'transparent' : themeColors.border,
                            }}>
                              <Text style={{ fontSize: 11, fontWeight: '900', color: hasScore ? '#fff' : themeColors.textMuted }}>
                                {hasScore ? c.score : '—'}
                              </Text>
                            </View>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                    <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 14, marginTop: 10 }}>
                      {[{ c: '#22C55E', l: '70+' }, { c: '#F59E0B', l: '45-69' }, { c: '#EF4444', l: '<45' }, { c: themeColors.border, l: 'No data' }].map(item => (
                        <View key={item.l} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: item.c }} />
                          <Text style={{ fontSize: 10, color: themeColors.textMuted }}>{item.l}</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                  {sorted.map(d => {
                    const plan = nutritionPlansByDate[d];
                    const meals = plan?.meals ?? [];
                    const checks = checkedMealsByDate[d] ?? {};
                    const checkedCount = meals.reduce((n, _m, i) => n + (checks[`meal_${i}`] ? 1 : 0), 0);
                    const totals = meals.reduce((acc, m, i) => {
                      if (!checks[`meal_${i}`]) return acc;
                      return {
                        cal: acc.cal + (m.calories ?? 0),
                        pro: acc.pro + (m.protein ?? 0),
                        carb: acc.carb + (m.carbs ?? 0),
                        fat: acc.fat + (m.fat ?? 0),
                      };
                    }, { cal: 0, pro: 0, carb: 0, fat: 0 });
                    const targets = plan?.targets;
                    const isExpanded = expandedHistoryDate === d;
                    const dateObj = new Date(d + 'T12:00:00');
                    const label = dateObj.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
                    // Mirror the Meals-tab "fully logged" rule so the
                    // card gets the same green ring + badge treatment
                    // as the calendar strip above. Either every planned
                    // meal is checked OR at least 3 meals are checked
                    // (covers manual loggers whose day didn't match the
                    // plan meal-count exactly).
                    const _historyActiveKeys = meals.map((_, i) => `meal_${i}`);
                    const _historyAllChecked = _historyActiveKeys.length > 0 && _historyActiveKeys.every(k => !!checks[k]);
                    const cardFullyLogged = _historyAllChecked || checkedCount >= 3;
                    return (
                      <View key={d} style={{
                        backgroundColor: cardFullyLogged ? themeColors.success + '12' : themeColors.surface,
                        borderRadius: 14, borderWidth: 1,
                        borderColor: cardFullyLogged ? themeColors.success + '55' : themeColors.border,
                      }}>
                        <TouchableOpacity
                          activeOpacity={0.85}
                          onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setExpandedHistoryDate(isExpanded ? null : d); }}
                          style={{ padding: 14 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                              <Text style={{ fontSize: 15, fontWeight: '700', color: themeColors.textPrimary }}>{label}</Text>
                              {cardFullyLogged && (
                                <View style={{
                                  flexDirection: 'row', alignItems: 'center', gap: 3,
                                  backgroundColor: themeColors.success + '22',
                                  paddingHorizontal: 6, paddingVertical: 2,
                                  borderRadius: 10,
                                }}>
                                  <Ionicons name="checkmark-circle" size={11} color={themeColors.success} />
                                  <Text style={{ fontSize: 10, fontWeight: '700', color: themeColors.success, letterSpacing: 0.3 }}>
                                    FULLY LOGGED
                                  </Text>
                                </View>
                              )}
                            </View>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                              <Text style={{ fontSize: 11, color: themeColors.textMuted }}>
                                {checkedCount}/{meals.length || '–'} logged
                              </Text>
                              <Ionicons name={isExpanded ? 'chevron-down' : 'chevron-forward'} size={14} color={themeColors.textMuted} />
                            </View>
                          </View>
                          {meals.length > 0 && (
                            <Text style={{ fontSize: 12, color: themeColors.textSecondary, marginTop: 4 }}>
                              {Math.round(totals.cal)} cal · {Math.round(totals.pro)}g P · {Math.round(totals.carb)}g C · {Math.round(totals.fat)}g F
                              {targets?.calories ? ` · target ${Math.round(targets.calories)} cal` : ''}
                            </Text>
                          )}
                        </TouchableOpacity>
                        {isExpanded && meals.length > 0 && (
                          <View style={{ borderTopWidth: 1, borderTopColor: themeColors.border, padding: 12, gap: 8 }}>
                            {meals.map((m, i) => {
                              const mealType = `meal_${i}`;
                              const ate = !!checks[mealType];
                              return (
                                <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                                  <TouchableOpacity
                                    onPress={() => handleToggleMeal(d, mealType)}
                                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                    style={{
                                      width: 22, height: 22, borderRadius: 11,
                                      alignItems: 'center', justifyContent: 'center',
                                      borderWidth: 2,
                                      borderColor: ate ? themeColors.primary : themeColors.border,
                                      backgroundColor: ate ? themeColors.primary : 'transparent',
                                    }}>
                                    {ate && <Ionicons name="checkmark" size={12} color="#fff" />}
                                  </TouchableOpacity>
                                  <TouchableOpacity
                                    style={{ flex: 1 }}
                                    onPress={() => setEditingMeal({ dateKey: d, type: mealType, meal: m })}>
                                    <Text style={{ fontSize: 13, fontWeight: '600', color: themeColors.textPrimary }} numberOfLines={1}>{m.meal}</Text>
                                    <Text style={{ fontSize: 10, color: themeColors.textMuted, marginTop: 1 }}>
                                      {Math.round(m.calories ?? 0)} cal · {Math.round(m.protein ?? 0)}g P
                                    </Text>
                                  </TouchableOpacity>
                                  <TouchableOpacity
                                    onPress={() => setEditingMeal({ dateKey: d, type: mealType, meal: m })}
                                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                    <Ionicons name="create-outline" size={18} color={mealPalette.strong} />
                                  </TouchableOpacity>
                                </View>
                              );
                            })}
                          </View>
                        )}
                      </View>
                    );
                  })}
                </View>
              );
            })()}

            {/* Daily target banner — shows the user's computed calorie +
                macro targets at the top of the Plan view so they can see
                their goal without opening the daily modal. Pulls from
                today's plan targets. */}
            {mealsSubTab === 'plan' && (() => {
              const todayPlan = nutritionPlansByDate[mealDays[0]?.key];
              const t = todayPlan?.targets ?? { calories: 0, protein: 0, carbs: 0, fat: 0 };
              if (!t.calories) return null;
              const protPct = t.calories > 0 ? Math.round(((t.protein ?? 0) * 4 / t.calories) * 100) : 0;
              const carbPct = t.calories > 0 ? Math.round(((t.carbs ?? 0) * 4 / t.calories) * 100) : 0;
              const fatPct  = t.calories > 0 ? Math.round(((t.fat ?? 0) * 9 / t.calories) * 100) : 0;
              const goalLabel = userProfile.goalSelection?.primaryGoal
                ? userProfile.goalSelection.primaryGoal.replace(/_/g, ' ')
                : userProfile.goal?.replace(/_/g, ' ') ?? '';
              return (
                <View style={[styles.dailyTargetBanner, { backgroundColor: themeColors.surface }]}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <Text style={{ fontSize: 22, fontWeight: '800', color: themeColors.textPrimary }}>
                      Daily Target
                    </Text>
                    {/* Edit Plan — small outlined pill, meta-action for the
                        current plan. Reads as secondary, doesn't compete
                        with meal cards below. */}
                    <TouchableOpacity
                      onPress={() => setMealsSubTab('foods')}
                      activeOpacity={0.7}
                      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 4,
                        paddingHorizontal: 10,
                        paddingVertical: 5,
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor: themeColors.border,
                      }}>
                      <Ionicons name="settings-outline" size={12} color={themeColors.textSecondary} />
                      <Text style={{ fontSize: 11, fontWeight: '600', color: themeColors.textSecondary }}>
                        Edit Plan
                      </Text>
                    </TouchableOpacity>
                  </View>
                  {goalLabel ? (
                    <Text style={{ fontSize: 11, color: themeColors.textMuted, marginBottom: 10, textTransform: 'capitalize' }}>
                      {goalLabel}
                    </Text>
                  ) : null}
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <View style={{ alignItems: 'center' }}>
                      <Text style={{ fontSize: 20, fontWeight: '800', color: mealPalette.strong }}>{t.calories}</Text>
                      <Text style={{ fontSize: 11, color: themeColors.textSecondary, fontWeight: '500' }}>cal</Text>
                    </View>
                    <View style={{ alignItems: 'center' }}>
                      <Text style={{ fontSize: 20, fontWeight: '800', color: themeColors.primary }}>{t.protein ?? 0}g</Text>
                      <Text style={{ fontSize: 11, color: themeColors.textSecondary, fontWeight: '500' }}>protein · {protPct}%</Text>
                    </View>
                    <View style={{ alignItems: 'center' }}>
                      <Text style={{ fontSize: 20, fontWeight: '800', color: '#F59E0B' }}>{t.carbs ?? 0}g</Text>
                      <Text style={{ fontSize: 11, color: themeColors.textSecondary, fontWeight: '500' }}>carbs · {carbPct}%</Text>
                    </View>
                    <View style={{ alignItems: 'center' }}>
                      <Text style={{ fontSize: 20, fontWeight: '800', color: '#A78BFA' }}>{t.fat ?? 0}g</Text>
                      <Text style={{ fontSize: 11, color: themeColors.textSecondary, fontWeight: '500' }}>fat · {fatPct}%</Text>
                    </View>
                  </View>
                  {/* Workout-aware nutrition tip */}
                  {(() => {
                    const todaySchedule = schedule[0];
                    let tip = 'Training day — keep protein high for muscle recovery';
                    if (!todaySchedule || todaySchedule.isRest) tip = 'Rest day — prioritize protein and recovery nutrition';
                    else {
                      const stim = todaySchedule.workout?.stimulus;
                      if (stim === 'strength' || stim === 'power') tip = 'Heavy training day — extra carbs around your workout for fuel';
                      else if (stim === 'conditioning') tip = 'Cardio day — stay hydrated and replenish electrolytes';
                    }
                    return <Text style={{ fontSize: 12, color: themeColors.textSecondary, marginTop: 8, fontWeight: '500' }}>{tip}</Text>;
                  })()}
                  {userProfile?.physicalStats?.weightLbs ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}>
                      <Ionicons name="water-outline" size={14} color="#38BDF8" />
                      <Text style={{ fontSize: 12, fontWeight: '500', color: themeColors.textSecondary }}>
                        {formatWaterTarget(userProfile.physicalStats.weightLbs, userProfile.workoutDurationMinutes ?? 0)}
                      </Text>
                      <Text style={{ fontSize: 11, color: themeColors.textMuted }}>daily target</Text>
                    </View>
                  ) : null}
                  {/* "Why this plan" — inline muted text link, reads as a
                      meta-explanation for today's plan rather than a CTA. */}
                  {nutritionistNote ? (
                    <TouchableOpacity
                      onPress={() => setShowNutritionistNote(true)}
                      activeOpacity={0.6}
                      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 10, alignSelf: 'flex-start' }}>
                      <Text style={{ fontSize: 12, fontWeight: '500', color: themeColors.textMuted }}>
                        Why this plan
                      </Text>
                      <Ionicons name="chevron-forward" size={12} color={themeColors.textMuted} />
                    </TouchableOpacity>
                  ) : null}
                </View>
              );
            })()}

            {/* Free tier — replace the AI-generated meal list with a compact
                manual-logging prompt. Logged meals still surface via the
                existing meal-history + checked-meal paths; they just don't
                come from an AI-built plan. */}
            {/* Free tier banner — one-line reminder that AI plans are Pro.
                Day cards below render empty meal frames the user fills
                manually (routines auto-fill; everything else stays blank
                until they add). */}
            {mealsSubTab === 'plan' && isFreeTier && (
              <FadeInView delay={0}>
                <View style={{
                  flexDirection: 'row', alignItems: 'center', gap: 10,
                  backgroundColor: themeColors.surface,
                  borderRadius: 12, padding: 12, marginBottom: 10,
                  borderWidth: 1, borderColor: themeColors.border,
                }}>
                  <Ionicons name="restaurant-outline" size={18} color={themeColors.primary} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: themeColors.textPrimary }}>
                      Manual meal logging
                    </Text>
                    <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }}>
                      Add meals yourself — or pin routines to auto-fill. Upgrade to Pro for AI plans.
                    </Text>
                  </View>
                </View>
              </FadeInView>
            )}

            {/* Incomplete-yesterday nudge — soft, dismissable, persists
                dismissal per date so it doesn't re-prompt. Only shows when
                yesterday has <50% of target calories logged. */}
            {mealsSubTab === 'plan' && !isFreeTier && authToken && (() => {
              const todayPlanForTarget = nutritionPlansByDate[mealDays[0]?.key];
              const target = todayPlanForTarget?.targets?.calories ?? 0;
              if (target <= 0) return null;
              return (
                <IncompleteDayBanner
                  authToken={authToken}
                  themeName={userProfile.themePreference}
                  targetCalories={target}
                  // Land on the History sub-tab (which lets the user
                  // add meals to past days) — NOT Foods (the search /
                  // library) which is what the user complained looked
                  // like "settings." Foods is the wrong destination
                  // for "fill in yesterday's missed meals."
                  onFillIn={() => setMealsSubTab('history')}
                />
              );
            })()}
            {/* Fueling & Recovery Signals — hidden when all green. Mounted
                above the day cards so amber/red flags catch attention before
                the user scrolls into individual meals. */}
            {mealsSubTab === 'plan' && !isFreeTier && authToken && (
              <FuelingRecoveryCard authToken={authToken} themeName={userProfile.themePreference} />
            )}
            {/* Weekly adaptive-TDEE check-in — surfaces when enough
                nutrition + weight data exists to recompute maintenance
                and suggest a target adjustment. Deterministic. */}
            {mealsSubTab === 'plan' && !isFreeTier && authToken && (
              <AdaptiveMacroCard
                authToken={authToken}
                themeName={userProfile.themePreference}
                weightEntries={adaptiveMacroWeightEntries}
                onAccept={(newTarget) => {
                  // Persist via onProfileUpdate — the profile store
                  // holds customMacros which the plan generator reads
                  // on next regen. Keeps the mutation lightweight; a
                  // full plan regen happens on next natural trigger.
                  onProfileUpdate?.({
                    customMacros: {
                      ...(userProfile.customMacros ?? {}),
                      calories: newTarget,
                    },
                  } as any, true);
                  Alert.alert(
                    'Target updated',
                    `Your new calorie target is ${newTarget} kcal/day. The plan will pick this up on your next regeneration.`,
                  );
                }}
              />
            )}
            {mealsSubTab === 'plan' && mealDays.map((d, idx) => {
              let plan = nutritionPlansByDate[d.key];
              // Free tier: synthesize an empty plan frame so the user
              // sees a day card they can add meals to manually. Pro
              // users get a proper plan here; free users get an empty
              // scaffold that the "+ Add meal" flow fills.
              if (!plan && isFreeTier) {
                plan = {
                  meals: [],
                  removedMealIds: [],
                  targets: { calories: 0, protein: 0, carbs: 0, fat: 0 },
                } as any;
              }
              if (!plan) return (
                <FadeInView key={d.key} delay={idx * 60}>
                  <View style={{ height: 60, justifyContent: 'center', alignItems: 'center' }}>
                    <ActivityIndicator size="small" color={themeColors.textMuted} />
                  </View>
                </FadeInView>
              );
              const isExpanded = expandedMealDays.has(d.key);
              const isToday = idx === 0;
              const removedSet = new Set(plan.removedMealIds ?? []);
              const meals = (plan.meals ?? []).filter((_, i) => !removedSet.has(`meal_${i}`));
              const totalCalories = meals.reduce((sum, m) => sum + (m.calories ?? 0), 0);
              const totalProtein  = meals.reduce((sum, m) => sum + (m.protein ?? 0), 0);
              const totalCarbs    = meals.reduce((sum, m) => sum + (m.carbs ?? 0), 0);
              const totalFat      = meals.reduce((sum, m) => sum + (m.fat ?? 0), 0);
              const t = plan.targets ?? { calories: 0, protein: 0, carbs: 0, fat: 0 };
              // Today highlight uses the hardcoded MEALS_ACCENT (green)
              // so it's guaranteed distinct from the workout side's
              // hardcoded WORKOUT_ACCENT (blue) regardless of which
              // theme the user has selected. Some themes had nearly
              // identical palettes for the two sections which made the
              // two cards look like siblings of the same color.
              const cardBg = isToday ? themeColors.surfaceRaised : themeColors.surface;
              const cardBorder = isToday ? MEALS_ACCENT + '88' : themeColors.border;
              return (
                <FadeInView key={d.key} delay={idx * 70}>
                <View style={[styles.mealAccordionCard, { backgroundColor: cardBg, borderColor: cardBorder }]}>
                  {isToday && <View style={[styles.dayCardTopAccent, { backgroundColor: MEALS_ACCENT, marginBottom: 0 }]} />}
                  <TouchableOpacity
                    style={[styles.mealAccordionHeader, { backgroundColor: 'transparent', borderBottomColor: themeColors.border }]}
                    onPress={() => {
                      import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
                      setExpandedMealDays(prev => {
                        const next = new Set(prev);
                        if (next.has(d.key)) next.delete(d.key); else next.add(d.key);
                        return next;
                      });
                    }}
                    activeOpacity={0.8}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.mealAccordionTitle, { color: isToday ? MEALS_ACCENT : themeColors.textPrimary }]}>
                        {mealDayLabel(d.date, idx)}
                      </Text>
                      {/* Compact macro readout under the day label. */}
                      <Text style={[styles.mealAccordionMeta, { color: themeColors.textSecondary }]}>
                        <Text style={{ fontWeight: '700', color: mealPalette.strong }}>{Math.round(totalCalories)}</Text>
                        <Text> / {t.calories} cal  ·  </Text>
                        <Text style={{ fontWeight: '700' }}>{Math.round(totalProtein)}</Text>
                        <Text>p  ·  </Text>
                        <Text style={{ fontWeight: '700' }}>{Math.round(totalCarbs)}</Text>
                        <Text>c  ·  </Text>
                        <Text style={{ fontWeight: '700' }}>{Math.round(totalFat)}</Text>
                        <Text>f</Text>
                      </Text>
                    </View>
                    {/* Per-day nutrition score badge */}
                    {(() => {
                      const ds = computeNutritionScore(plan, userProfile.goal ?? 'body_recomp');
                      if (!ds || ds.score <= 0) return null;
                      const c = ds.score >= 70 ? themeColors.success : ds.score >= 45 ? themeColors.warning : themeColors.error;
                      return (
                        <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: c + '18', alignItems: 'center', justifyContent: 'center', marginRight: 4 }}>
                          <Text style={{ fontSize: 11, fontWeight: '900', color: c }}>{ds.score}</Text>
                        </View>
                      );
                    })()}
                    <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={themeColors.textMuted} />
                  </TouchableOpacity>

                  <AnimatedCollapsible visible={isExpanded}>
                    <NutritionCard
                      themeName={userProfile.themePreference}
                      nutritionPlan={plan}
                      checkedMeals={checkedMealsByDate[d.key] ?? {}}
                      onToggleMeal={(mealType) => handleToggleMeal(d.key, mealType)}
                      onEditMeal={(mealType, meal) => setEditingMeal({ dateKey: d.key, type: mealType, meal })}
                      onAddSnack={() => handleAddSnack(d.key)}
                      onRemoveMeal={(mealType) => handleRemoveMeal(d.key, mealType)}
                      onRestoreMeal={(mealType) => handleRestoreMeal(d.key, mealType)}
                      onHardDeleteMeal={(mealType) => {
                        Alert.alert(
                          'Delete meal?',
                          'This removes the meal entirely. You won\'t be able to restore it.',
                          [
                            { text: 'Cancel', style: 'cancel' },
                            { text: 'Delete', style: 'destructive', onPress: () => handleHardDeleteMeal(d.key, mealType) },
                          ],
                        );
                      }}
                      onToggleRoutine={(mealType) => handleToggleRoutine(d.key, mealType)}
                      onShowRecipe={(mealType, meal) => setRecipeTarget({ dateKey: d.key, type: mealType, meal })}
                      onMoveMeal={(mealType, direction) => handleMoveMeal(d.key, mealType, direction)}
                      onShuffleMeal={(mealType, meal) => handleShuffleMeal(d.key, mealType, meal)}
                      onRenameMeal={(mealType, newName) => handleRenameMeal(d.key, mealType, newName)}
                      goal={userProfile.goal}
                      savedMealNames={savedMealNames}
                      onAddFromSaved={() => setAddFromSavedFor(d.key)}
                      dailyCollagenG={d.key === todayKey() ? todayCollagenG : null}
                      dailyProbioticCfuBillions={d.key === todayKey() ? todayProbioticCfu : null}
                      proteinBreakdown={d.key === todayKey() ? proteinBreakdown : null}
                      todaySupplements={d.key === todayKey() ? todaySupplementMicros : null}
                    />
                  </AnimatedCollapsible>
                </View>
                </FadeInView>
              );
            })}
          </>
          )
        )}
      </ScrollView>
      </ErrorBoundary>
      )}

      {/* ── Social tab — Feed / Friends / Challenges ──────── */}
      {activeTab === 'friends' && (
        <ErrorBoundary>
        <View style={{ flex: 1, marginBottom: 70, backgroundColor: themeColors.background }}>
          {/* Sub-tab bar */}
          <View style={{ flexDirection: 'row', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4, gap: 8 }}>
            <SubTabBtn label="Feed"       active={socialSubTab === 'feed'}       tint={themeColors.primary} mutedColor={themeColors.textSecondary} onPress={() => setSocialSubTab('feed')} />
            <SubTabBtn label="Friends"    active={socialSubTab === 'friends'}    tint={themeColors.primary} mutedColor={themeColors.textSecondary} onPress={() => setSocialSubTab('friends')} />
            <SubTabBtn label="Challenges" active={socialSubTab === 'challenges'} tint={themeColors.primary} mutedColor={themeColors.textSecondary} onPress={() => setSocialSubTab('challenges')} />
          </View>

          {socialSubTab === 'feed' && (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 24 }}>
              {feedLoading && feedItems.length === 0 ? (
                <View style={{ padding: 24, alignItems: 'center' }}><ActivityIndicator color={themeColors.primary} /></View>
              ) : feedItems.length === 0 ? (
                <View style={{ padding: 32, alignItems: 'center' }}>
                  <Ionicons name="newspaper-outline" size={40} color={themeColors.textMuted} />
                  <Text style={{ color: themeColors.textSecondary, marginTop: 12, fontSize: 14, textAlign: 'center' }}>
                    No activity yet. Complete a workout or add friends to see updates here.
                  </Text>
                </View>
              ) : (
                feedItems.map(item => {
                  const isMe = item.username === userProfile.username;
                  const who = isMe ? 'You' : (item.display_name || item.username);
                  const isPost = item.event_type === 'workout_post';
                  const ws = isPost ? item.payload?.workout_summary : null;
                  const focus = ws?.focus || item.payload?.focus || 'Workout';
                  const dur = ws?.duration_seconds || item.payload?.duration_seconds;
                  const durStr = dur ? `${Math.round(dur / 60)} min` : '';
                  const exCount = ws?.exercises?.length || item.payload?.exercise_count || 0;
                  const dateStr = (() => {
                    try {
                      const d = new Date(item.created_at);
                      const now = new Date();
                      const diffMs = now.getTime() - d.getTime();
                      const diffH = Math.floor(diffMs / 3600000);
                      if (diffH < 1) return 'Just now';
                      if (diffH < 24) return `${diffH}h ago`;
                      const diffD = Math.floor(diffH / 24);
                      if (diffD === 1) return 'Yesterday';
                      if (diffD < 7) return `${diffD}d ago`;
                      return d.toLocaleDateString();
                    } catch { return ''; }
                  })();
                  return (
                    <View
                      key={item.id}
                      style={{
                        backgroundColor: themeColors.surface,
                        borderColor: themeColors.border,
                        borderWidth: 1,
                        borderRadius: 12,
                        overflow: 'hidden',
                        marginBottom: 10,
                      }}
                    >
                      {/* Header row */}
                      <View style={{ flexDirection: 'row', alignItems: 'center', padding: 14, paddingBottom: isPost ? 10 : 14, gap: 8 }}>
                        <View style={{
                          width: 32, height: 32, borderRadius: 16,
                          backgroundColor: themeColors.primary + '22',
                          borderColor: themeColors.primary + '55', borderWidth: 1,
                          alignItems: 'center', justifyContent: 'center',
                        }}>
                          <Text style={{ fontSize: 13, fontWeight: '800', color: themeColors.primary }}>
                            {(item.display_name?.[0] ?? item.username[0] ?? '?').toUpperCase()}
                          </Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 13, fontWeight: '700', color: themeColors.textPrimary }}>{who}</Text>
                          <Text style={{ fontSize: 11, color: themeColors.textMuted }}>{dateStr}</Text>
                        </View>
                        <Ionicons name="barbell-outline" size={16} color={themeColors.textMuted} />
                      </View>

                      {/* Caption */}
                      {isPost && item.payload?.caption ? (
                        <Text style={{ fontSize: 14, color: themeColors.textPrimary, paddingHorizontal: 14, marginBottom: 10, lineHeight: 20 }}>
                          {item.payload.caption}
                        </Text>
                      ) : null}

                      {/* Photo */}
                      {isPost && item.payload?.photo_base64 ? (
                        <Image
                          source={{ uri: `data:image/jpeg;base64,${item.payload.photo_base64}` }}
                          style={{ width: '100%', height: 240 }}
                          resizeMode="cover"
                        />
                      ) : null}

                      {/* Workout summary card */}
                      <View style={{ padding: 14, paddingTop: isPost ? 12 : 0 }}>
                        <Text style={{ fontSize: 15, color: themeColors.textPrimary, fontWeight: '700' }}>
                          {focus} Day
                        </Text>
                        <View style={{ flexDirection: 'row', gap: 12, marginTop: 6 }}>
                          {durStr ? <Text style={{ fontSize: 12, color: themeColors.textSecondary }}>{durStr}</Text> : null}
                          {exCount > 0 ? <Text style={{ fontSize: 12, color: themeColors.textSecondary }}>{exCount} exercises</Text> : null}
                          {ws?.total_sets ? <Text style={{ fontSize: 12, color: themeColors.textSecondary }}>{ws.total_sets} sets</Text> : null}
                          {ws?.training_rating ? (
                            <View style={{ backgroundColor: themeColors.primary + '18', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 }}>
                              <Text style={{ fontSize: 10, fontWeight: '800', color: themeColors.primary }}>{ws.training_rating}</Text>
                            </View>
                          ) : null}
                        </View>

                        {/* Exercise breakdown for posts */}
                        {ws?.exercises && ws.exercises.length > 0 ? (
                          <View style={{ marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: themeColors.border }}>
                            {ws.exercises.slice(0, 6).map((ex, ei) => {
                              const best = ex.sets.reduce((b, ss) => (ss.weight_lbs > b.weight_lbs ? ss : b), ex.sets[0] ?? { reps: 0, weight_lbs: 0 });
                              return (
                                <View key={ei} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
                                  <Text style={{ fontSize: 12, color: themeColors.textPrimary, flex: 1 }} numberOfLines={1}>{ex.name}</Text>
                                  <Text style={{ fontSize: 11, color: themeColors.textSecondary }}>
                                    {ex.sets.length}x{best.reps}{best.weight_lbs > 0 ? ` @ ${best.weight_lbs}` : ''}
                                  </Text>
                                </View>
                              );
                            })}
                            {ws.exercises.length > 6 ? (
                              <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }}>+{ws.exercises.length - 6} more</Text>
                            ) : null}
                          </View>
                        ) : null}
                      </View>
                    </View>
                  );
                })
              )}
            </ScrollView>
          )}

          {socialSubTab === 'friends' && (
            <FriendsModal
              visible={false}
              authToken={authToken}
              onClose={() => {}}
              themeName={userProfile.themePreference}
              inline
            />
          )}

          {socialSubTab === 'challenges' && (
            <View style={{ flex: 1, padding: 32, alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="trophy-outline" size={48} color={themeColors.textMuted} />
              <Text style={{ color: themeColors.textPrimary, fontSize: 18, fontWeight: '700', marginTop: 16 }}>
                Challenges
              </Text>
              <Text style={{ color: themeColors.textSecondary, fontSize: 14, textAlign: 'center', marginTop: 8, lineHeight: 20 }}>
                Challenge your friends to weekly goals — sessions, streaks, and more. Coming soon.
              </Text>
            </View>
          )}
        </View>
        </ErrorBoundary>
      )}

      {/* ── Progress tab — kept mounted to avoid white flash on tab switch */}
      <Animated.View style={{ flex: 1, paddingBottom: 88, display: activeTab === 'progress' ? 'flex' : 'none', opacity: progressFade }}>
        <ErrorBoundary>
          <ProgressScreen
            authToken={authToken}
            userProfile={userProfile}
            themeName={userProfile.themePreference}
            noHeader
            nutritionPlan={nutritionPlansByDate[todayKey()] ?? null}
            onBack={() => setActiveTab('workout')}
            onUpdateWeight={(weightLbs) => {
              onProfileUpdate?.({ physicalStats: { ...userProfile.physicalStats, weightLbs } } as any, true);
              import('../utils/weightHistory').then(({ saveWeightEntry }) => saveWeightEntry(weightLbs, 'manual')).catch(() => {});
            }}
          />
        </ErrorBoundary>
      </Animated.View>

      {/* ── Profile tab ─────────────────────────────────────────────── */}
      {activeTab === 'profile' && (<ErrorBoundary>{(() => {
        const ps = userProfile.physicalStats;
        const heightStr = ps ? `${ps.heightFeet}'${ps.heightInches}"` : '—';
        type ThemeEntry = { key: import('../types').AppThemeName; label: string; swatch: string; mode: 'dark' | 'light' };
        const allThemes: ThemeEntry[] = [
          // Dark themes (bg is dark, most ink is light)
          { key: 'midnight', label: 'Midnight', swatch: '#15C7B8', mode: 'dark' },
          { key: 'ocean',    label: 'Ocean',    swatch: '#00CCE8', mode: 'dark' },
          { key: 'amethyst', label: 'Amethyst', swatch: '#A060FF', mode: 'dark' },
          { key: 'ember',    label: 'Ember',    swatch: '#FF6018', mode: 'dark' },
          { key: 'forest',   label: 'Forest',   swatch: '#3AA860', mode: 'dark' },
          { key: 'wine',     label: 'Wine',     swatch: '#C82848', mode: 'dark' },
          { key: 'obsidian', label: 'Obsidian', swatch: '#888888', mode: 'dark' },
          { key: 'neon',     label: 'Neon',     swatch: '#00FF88', mode: 'dark' },
          { key: 'citrus',   label: 'Citrus',   swatch: '#FFD700', mode: 'dark' },
          { key: 'scarlet',  label: 'Scarlet',  swatch: '#DC143C', mode: 'dark' },
          { key: 'cocoa',    label: 'Cocoa',    swatch: '#8B4513', mode: 'dark' },
          { key: 'slate',    label: 'Slate',    swatch: '#F07848', mode: 'dark' },
          { key: 'blossom',  label: 'Blossom',  swatch: '#FF1890', mode: 'dark' },
          { key: 'void',     label: 'Void',     swatch: '#6A0DAD', mode: 'dark' },
          { key: 'dusk',     label: 'Dusk',     swatch: '#FF6F61', mode: 'dark' },
          { key: 'lavender', label: 'Lavender', swatch: '#B57EDC', mode: 'dark' },
          { key: 'aurora',   label: 'Aurora',   swatch: '#00CED1', mode: 'dark' },
          { key: 'copper',   label: 'Copper',   swatch: '#B87333', mode: 'dark' },
          { key: 'storm',    label: 'Storm',    swatch: '#4F5D75', mode: 'dark' },
          // Light themes (bg is light, most ink is dark)
          { key: 'arctic',    label: 'Arctic',    swatch: '#2474C8', mode: 'light' },
          { key: 'sunrise',   label: 'Sunrise',   swatch: '#F28C28', mode: 'light' },
          { key: 'parchment', label: 'Parchment', swatch: '#7C4F2A', mode: 'light' },
          { key: 'meadow',    label: 'Meadow',    swatch: '#2A8048', mode: 'light' },
          { key: 'rose',      label: 'Rose',      swatch: '#A83860', mode: 'light' },
          { key: 'steel',     label: 'Steel',     swatch: '#3A5BC8', mode: 'light' },
          { key: 'sand',      label: 'Sand',      swatch: '#C06030', mode: 'light' },
          { key: 'linen',     label: 'Linen',     swatch: '#6A8030', mode: 'light' },
          { key: 'mint',      label: 'Mint',      swatch: '#0E8078', mode: 'light' },
          { key: 'butter',    label: 'Butter',    swatch: '#C07608', mode: 'light' },
          { key: 'seaglass',  label: 'Seaglass',  swatch: '#137A78', mode: 'light' },
          { key: 'lilac',     label: 'Lilac',     swatch: '#6B3AA8', mode: 'light' },
          { key: 'cloud',     label: 'Cloud',     swatch: '#3068A8', mode: 'light' },
        ];
        const visibleThemes = showAllThemes ? allThemes : allThemes.slice(0, 8);
        const darkThemes = visibleThemes.filter(t => t.mode === 'dark');
        const lightThemes = visibleThemes.filter(t => t.mode === 'light');
        const currentTheme = userProfile.themePreference ?? 'midnight';
        return (
        <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
          {/* User info header */}
          <View style={[styles.profileHero, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
            <View style={[styles.profileAvatar, { backgroundColor: themeColors.primary + '22', borderColor: themeColors.primary + '55' }]}>
              <Text style={[styles.profileAvatarText, { color: themeColors.primary }]}>
                {(username?.[0] ?? userProfile.goal?.[0] ?? 'U').toUpperCase()}
              </Text>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[styles.profileHeroName, { color: themeColors.textPrimary }]}>
                {username || 'Your Profile'}
              </Text>
              <Text style={[styles.profileHeroMeta, { color: themeColors.textSecondary }]}>
                {ps?.weightLbs ? `${ps.weightLbs} lb` : '—'}  ·  {heightStr}  ·  age {ps?.age ?? '—'}
              </Text>
            </View>
          </View>

          {/* Quick data references — fitness score, body scan, weight */}
          <View style={styles.profileStatRow}>
            <View style={[styles.profileStatTile, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
              <Text style={[styles.profileStatLabel, { color: themeColors.textMuted }]}>FITNESS SCORE</Text>
              <Text style={[styles.profileStatValue, { color: themeColors.textPrimary }]}>
                {profileHealthScore?.fitnessScore != null ? `${profileHealthScore.fitnessScore}` : '—'}
              </Text>
              <Text style={[styles.profileStatSub, { color: themeColors.textMuted }]}>
                {profileHealthScore?.fitnessScore != null ? '/ 100' : 'Run a scan'}
              </Text>
            </View>
            <View style={[styles.profileStatTile, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
              <Text style={[styles.profileStatLabel, { color: themeColors.textMuted }]}>WEIGHT</Text>
              <Text style={[styles.profileStatValue, { color: themeColors.textPrimary }]}>
                {ps?.weightLbs ?? '—'}
              </Text>
              <Text style={[styles.profileStatSub, { color: themeColors.textMuted }]}>lb</Text>
            </View>
            <View style={[styles.profileStatTile, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
              <Text style={[styles.profileStatLabel, { color: themeColors.textMuted }]}>GOAL PACE</Text>
              <Text style={[styles.profileStatValue, { color: themeColors.textPrimary, fontSize: 14 }]}>
                {userProfile.goalDetails?.pace ?? '—'}
              </Text>
              <Text style={[styles.profileStatSub, { color: themeColors.textMuted }]}>
                {userProfile.goalDetails?.targetWeightLbs ? `→ ${userProfile.goalDetails.targetWeightLbs} lb` : ''}
              </Text>
            </View>
          </View>

          {/* Goal entry — opens inline EditProfileScreen in goal mode */}
          <TouchableOpacity
            style={[styles.profileRow, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}
            onPress={() => setShowGoalEditor(true)}
            activeOpacity={0.85}
          >
            <View style={[styles.profileRowIcon, { backgroundColor: themeColors.primary + '22' }]}>
              <Ionicons name="flag-outline" size={18} color={themeColors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.profileRowTitle, { color: themeColors.textPrimary }]}>Goal</Text>
              <Text style={[styles.profileRowSub, { color: themeColors.textSecondary }]}>
                {goalLabel || 'Set your training goal'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={themeColors.textMuted} />
          </TouchableOpacity>

          {/* Theme picker — 2-column grid of swatches. Showing the most
              popular 8; the rest live in the full themes screen via
              the "More themes" link below. */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <Text style={[styles.profileSectionLabel, { color: themeColors.textMuted, marginBottom: 0 }]}>THEME</Text>
            <TouchableOpacity onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setShowAllThemes(!showAllThemes); }} activeOpacity={0.7}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.primary }}>{showAllThemes ? 'Show less' : 'Show more'}</Text>
            </TouchableOpacity>
          </View>
          {([
            { label: 'Dark', items: darkThemes, icon: 'moon-outline' as const },
            ...(lightThemes.length > 0 ? [{ label: 'Light', items: lightThemes, icon: 'sunny-outline' as const }] : []),
          ] as const).map(group => (
            <View key={group.label}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 6, marginTop: group.label === 'Light' ? 10 : 0 }}>
                <Ionicons name={group.icon} size={12} color={themeColors.textMuted} />
                <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.textMuted, letterSpacing: 0.5 }}>{group.label.toUpperCase()}</Text>
              </View>
              <View style={styles.profileThemeGrid}>
                {group.items.map(t => {
                  const isActive = currentTheme === t.key;
                  return (
                    <TouchableOpacity
                      key={t.key}
                      style={[
                        styles.profileThemeTile,
                        { backgroundColor: themeColors.surface, borderColor: isActive ? t.swatch : themeColors.border, borderWidth: isActive ? 2 : 1 },
                      ]}
                      onPress={() => onProfileUpdate?.({ themePreference: t.key } as any, true)}
                      activeOpacity={0.8}>
                      <View style={[styles.profileThemeSwatch, { backgroundColor: t.swatch }]} />
                      <Text style={[styles.profileThemeLabel, { color: themeColors.textPrimary }]}>{t.label}</Text>
                      {isActive && <Ionicons name="checkmark-circle" size={14} color={t.swatch} style={{ position: 'absolute', top: 4, right: 4 }} />}
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          ))}

          {/* Body & Stats */}
          <Text style={[styles.profileSectionLabel, { color: themeColors.textMuted, marginTop: 18 }]}>BODY & STATS</Text>
          <View style={[styles.profileMenuList, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
            <TouchableOpacity style={styles.profileMenuItem} onPress={onEditBody}>
              <Ionicons name="person-outline" size={18} color={themeColors.textSecondary} style={{ marginRight: 8 }} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.profileMenuLabel, { color: themeColors.textPrimary }]}>Edit Physical Stats</Text>
                <Text style={{ fontSize: 11, color: themeColors.textMuted }}>Weight, height, age, biological sex</Text>
              </View>
              <Text style={[styles.profileMenuChevron, { color: themeColors.textMuted }]}>›</Text>
            </TouchableOpacity>
          </View>

          {/* Workout Reminders */}
          <Text style={[styles.profileSectionLabel, { color: themeColors.textMuted, marginTop: 18 }]}>REMINDERS</Text>
          <View style={[styles.profileMenuList, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
            <View style={[styles.profileMenuItem, { justifyContent: 'space-between' }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.profileMenuLabel, { color: themeColors.textPrimary }]}>Workout Reminders</Text>
                <Text style={{ fontSize: 11, color: themeColors.textMuted }}>Daily notification on training days</Text>
              </View>
              <Switch
                value={reminderEnabled}
                onValueChange={async (v) => {
                  setReminderEnabled(v);
                  const { saveReminderSettings } = await import('../utils/workoutReminders');
                  await saveReminderSettings({ enabled: v, hour: 8, minute: 0 });
                }}
                trackColor={{ false: themeColors.border, true: themeColors.primary + '55' }}
                thumbColor={reminderEnabled ? themeColors.primary : themeColors.textMuted}
              />
            </View>
          </View>

          {/* Feedback Settings — haptics + sounds + vibration + the
              Apple Health connect toggle. Apple Health is in this
              group (not a separate Progress-tab card) so users find
              it alongside the other device-level toggles. Toggling
              ON triggers the HealthKit auth prompt; OFF persists the
              disabled flag and stops polling. */}
          <Text style={[styles.profileSectionLabel, { color: themeColors.textMuted, marginTop: 18 }]}>FEEDBACK & DEVICE</Text>
          <View style={[styles.profileMenuList, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
            {([
              { key: 'hapticsEnabled' as const, label: 'Haptic Feedback', desc: 'Vibrate on taps and actions' },
              { key: 'soundsEnabled' as const, label: 'Sounds', desc: 'Play tone when rest timer ends' },
              { key: 'vibrationEnabled' as const, label: 'Vibration', desc: 'Vibrate on rest timer and alerts' },
            ]).map(opt => (
              <View key={opt.key} style={[styles.profileMenuItem, { justifyContent: 'space-between' }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.profileMenuLabel, { color: themeColors.textPrimary }]}>{opt.label}</Text>
                  <Text style={{ fontSize: 11, color: themeColors.textMuted }}>{opt.desc}</Text>
                </View>
                <Switch
                  value={feedbackSettings[opt.key]}
                  onValueChange={async (v) => {
                    const { saveSettings } = await import('../utils/feedback');
                    const updated = await saveSettings({ [opt.key]: v });
                    setFeedbackSettings(updated);
                  }}
                  trackColor={{ false: themeColors.border, true: themeColors.primary + '55' }}
                  thumbColor={feedbackSettings[opt.key] ? themeColors.primary : themeColors.textMuted}
                />
              </View>
            ))}
            <AppleHealthToggleRow themeColors={themeColors} userAge={userProfile.physicalStats?.age ?? null} />
          </View>

          {/* Account + Sign out */}
          <Text style={[styles.profileSectionLabel, { color: themeColors.textMuted, marginTop: 18 }]}>ACCOUNT</Text>
          <View style={[styles.profileMenuList, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
            <TouchableOpacity style={styles.profileMenuItem} onPress={onViewAccount}>
              <Text style={[styles.profileMenuLabel, { color: themeColors.textPrimary }]}>Account Details</Text>
              <Text style={[styles.profileMenuChevron, { color: themeColors.textMuted }]}>›</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.profileSignOutBtn, { backgroundColor: themeColors.surface, borderColor: themeColors.error + '55' }]}
            onPress={() => {
              Alert.alert(
                'Sign out?',
                'You\'ll need to sign back in to see your plan and progress.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Sign out', style: 'destructive', onPress: onSignOut },
                ],
              );
            }}>
            <Text style={[styles.profileSignOutText, { color: themeColors.error }]}>Sign Out</Text>
          </TouchableOpacity>
        </ScrollView>
        );
      })()}</ErrorBoundary>)}

      {/* Plan-view exercise swap picker. Reuses the same overlap scoring
          as the live Switch Exercise feature so rankings are consistent. */}
      <PlanSwapExerciseModal
        visible={!!swapExerciseState}
        baseExerciseName={swapExerciseState?.exerciseName ?? null}
        library={exerciseLibrary}
        ownedEquipment={(userProfile as any)?.equipmentOwned ?? (userProfile as any)?.equipment ?? []}
        themeName={userProfile.themePreference}
        onClose={() => setSwapExerciseState(null)}
        onSelect={async (next) => {
          const target = swapExerciseState;
          if (!target) return;
          // Mutate the in-memory plan: match by focus, swap the exercise
          // at the given index for the picked candidate. Persist the
          // updated plan back to AsyncStorage so edits survive reload.
          try {
            const raw = await AsyncStorage.getItem('aiWorkoutPlan');
            if (raw) {
              const plan = JSON.parse(raw);
              if (plan && Array.isArray(plan.days)) {
                const dayIdx = plan.days.findIndex(
                  (d: any) => d?.focus === target.workout.focus,
                );
                if (dayIdx >= 0 && Array.isArray(plan.days[dayIdx]?.exercises)) {
                  const exs = plan.days[dayIdx].exercises;
                  if (target.exerciseIndex >= 0 && target.exerciseIndex < exs.length) {
                    const prev = exs[target.exerciseIndex];
                    exs[target.exerciseIndex] = {
                      ...prev,
                      name: next.name,
                      equipment: next.equipment ?? prev.equipment,
                      muscles_targeted: [
                        next.primary_muscle,
                        ...(next.secondary_muscles ?? []),
                      ].filter(Boolean),
                      primary_muscle: next.primary_muscle,
                      image_url: next.image_url ?? prev.image_url,
                    };
                    await AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(plan));
                    setWorkoutPlan(plan);
                  }
                }
              }
            }
          } catch (e) {
            console.warn('[plan-swap] persist failed:', e);
          }
          setSwapExerciseState(null);
        }}
      />

      {/* Tutorial moved to app/index.tsx so the Account modal can
          fire it directly. See the app root for the render. */}

      {/* Log Activity modal */}
      <LogActivityModal
        visible={showLogActivity}
        onClose={() => setShowLogActivity(false)}
        themeName={userProfile.themePreference}
        onSave={async (session) => {
          const { saveWorkoutSession, dateKey: dk } = await import('../utils/workoutHistory');
          await saveWorkoutSession(session);
          if (authToken) {
            try {
              const { logWorkoutDone } = await import('../services/api');
              await logWorkoutDone(
                authToken,
                dk(new Date(session.date)),
                session.focus,
                session.durationSeconds,
                undefined,
                session.manualActivity ? {
                  category: session.manualActivity.category,
                  subtype: session.manualActivity.subtype,
                  intensity: session.manualActivity.intensity,
                  source: session.manualActivity.source,
                  cardioStyle: session.manualActivity.cardioStyle,
                } : undefined,
              );
            } catch {}
          }
          import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
        }}
      />

      {/* Live tracker — open-ended run/ride/hike/yoga timer with HR
          polling. Saves via LogActivityModal on Finish so the session
          flows through the same fatigue + history path as any other
          manual activity. */}
      <LiveActivityTracker
        visible={showLiveTracker}
        onClose={() => setShowLiveTracker(false)}
        themeName={userProfile.themePreference}
        onSaved={() => {
          // Bump history so the streak / recent-sessions widgets pick
          // up the new row without needing a tab switch.
          (async () => {
            try {
              const { loadWorkoutHistory } = await import('../utils/workoutHistory');
              const fresh = await loadWorkoutHistory();
              setWorkoutHistoryList(fresh);
            } catch { /* non-fatal */ }
          })();
        }}
        onStartStrengthWorkout={(focus) => {
          // Strength pick from the Custom Workout sheet — mount the
          // existing ActiveWorkoutScreen on an empty workout shell with
          // the chosen focus. User adds their exercises inside, logs
          // sets normally, finishes through the standard summary path.
          // Same flow as plan-day Start but with no preloaded
          // exercises so the user is in full manual mode.
          const emptyDay: any = {
            day: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
            focus,
            exercises: [],
            stimulus: 'mixed',
          };
          onStartWorkout?.(emptyDay);
        }}
      />

      {/* Add-from-saved picker — surfaces from the day-card "From
          saved" button. Logs the picked saved meal as a fresh Meal
          row for the target date, then refreshes the plan so the new
          row renders without requiring the user to re-open the day. */}
      {addFromSavedFor && authToken && (
        <Modal
          visible={!!addFromSavedFor}
          animationType="slide"
          transparent
          onRequestClose={() => setAddFromSavedFor(null)}
        >
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
            <View style={{
              backgroundColor: themeColors.background,
              borderTopLeftRadius: 20, borderTopRightRadius: 20,
              padding: 16, paddingBottom: 30, maxHeight: '75%',
            }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <Text style={{ fontSize: 16, fontWeight: '800', color: themeColors.textPrimary }}>Add from Saved Meal</Text>
                <TouchableOpacity onPress={() => setAddFromSavedFor(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Ionicons name="close" size={22} color={themeColors.textSecondary} />
                </TouchableOpacity>
              </View>
              <Text style={{ fontSize: 11, color: themeColors.textMuted, marginBottom: 12, lineHeight: 15 }}>
                Logs a full copy of the saved meal to {addFromSavedFor}. Tweak any details afterward by tapping the meal row.
              </Text>
              <ScrollView>
                {savedMealLibrary.length === 0 ? (
                  <View style={{ padding: 16, alignItems: 'center' }}>
                    <Ionicons name="albums-outline" size={28} color={themeColors.textMuted} style={{ marginBottom: 8 }} />
                    <Text style={{ fontSize: 12, color: themeColors.textSecondary, textAlign: 'center' }}>No saved meals yet.</Text>
                    <Text style={{ fontSize: 11, color: themeColors.textMuted, textAlign: 'center', marginTop: 4, lineHeight: 16 }}>
                      Edit any meal and tap "Save as Meal" to add it to your library.
                    </Text>
                  </View>
                ) : savedMealLibrary.map(sm => (
                  <TouchableOpacity
                    key={sm.id}
                    onPress={async () => {
                      const dateKey = addFromSavedFor;
                      setAddFromSavedFor(null);
                      try {
                        const { logSavedMeal } = await import('../services/api');
                        // Default meal_type by time of day on the
                        // server-side would need the current hour; we
                        // just send "snack" so the user can re-type
                        // via inline edit if needed.
                        const h = new Date().getHours();
                        const mt = h < 10 ? 'breakfast' : h < 14 ? 'lunch' : h < 17 ? 'snack' : h < 21 ? 'dinner' : 'snack';
                        await logSavedMeal(authToken, sm.id, {
                          meal_date: dateKey,
                          meal_type: mt,
                        });
                        loadDayStatus();
                        if (userProfile) loadPlans(userProfile);
                      } catch (e: any) {
                        Alert.alert('Could not log', String(e?.message ?? e));
                      }
                    }}
                    style={{
                      backgroundColor: themeColors.surface, borderRadius: 12, padding: 12, marginBottom: 8,
                      borderWidth: 1, borderColor: themeColors.border,
                    }}
                  >
                    <Text style={{ fontSize: 14, fontWeight: '700', color: themeColors.textPrimary }} numberOfLines={1}>
                      {sm.name}
                    </Text>
                    <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }}>
                      {sm.items.length} item{sm.items.length === 1 ? '' : 's'} · {Math.round(sm.total_calories)} cal · {Math.round(sm.total_protein_g)}g P
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          </View>
        </Modal>
      )}

      {/* Meal edit modal */}
      {editingMeal && nutritionPlansByDate[editingMeal.dateKey] && (
        <MealEditModal
          visible={!!editingMeal}
          mealType={editingMeal.type}
          meal={editingMeal.meal}
          dateKey={editingMeal.dateKey}
          themeName={userProfile.themePreference}
          nutritionPlan={nutritionPlansByDate[editingMeal.dateKey]}
          allFoods={allFoodsWithCustom}
          foodCategories={userFoodCategories}
          savedMeals={userProfile.savedMeals ?? []}
          authToken={authToken}
          cookingSkill={userProfile.cookingSkill}
          prepTimeMinutes={userProfile.prepTimeMinutes}
          dietaryPreference={userProfile.dietaryPreference}
          allergies={userProfile.allergies}
          onSave={(updated) => handleMealSave(editingMeal.dateKey, editingMeal.type, updated)}
          onSaveRoutine={(updated, scope) =>
            handleMealSave(editingMeal.dateKey, editingMeal.type, updated, { routineScope: scope })
          }
          onClose={() => setEditingMeal(null)}
          onToggleRoutine={() => handleToggleRoutine(editingMeal.dateKey, editingMeal.type)}
          onSaveAsMeal={async () => {
            if (!authToken || !editingMeal) return;
            const m = editingMeal.meal;
            // Resolve food_id by matching item names to the library so
            // the saved meal's items carry food_id / serving_id when
            // we can. Without this, logged items land with NULL
            // food_id → fiber / sodium / sat-fat (which require the
            // FoodNutrition row) all land as zero. This was the bug
            // where "today shows 0 fiber" even though a veggie shake
            // with beans + oats was logged.
            const byName = new Map<string, any>();
            for (const f of allFoodsWithCustom ?? []) {
              const k = (f.name || '').toLowerCase().trim();
              if (k) byName.set(k, f);
            }
            const items = (m.items ?? []).map((it: any) => {
              const name = String(it.name || it.food_name || 'Item');
              const libMatch = byName.get(name.toLowerCase().trim());
              return {
                food_name: name,
                food_id: libMatch?.id ?? libMatch?.food_id ?? null,
                quantity: Number(it.quantity || it.qty || 1),
                unit: String(it.unit || 'serving'),
                calories: Number(it.calories || 0),
                protein_g: Number(it.protein_g ?? it.protein ?? 0),
                carbs_g: Number(it.carbs_g ?? it.carbs ?? 0),
                fat_g: Number(it.fat_g ?? it.fat ?? 0),
              };
            });
            if (items.length === 0) {
              Alert.alert('Nothing to save', 'Add some foods first, then save as a meal.');
              return;
            }
            try {
              const { createSavedMeal } = await import('../services/api');
              await createSavedMeal(authToken, {
                name: m.meal || m.name || 'My saved meal',
                items: items as any,
              });
              // Refresh the library so the "✓ Saved" chip lights up
              // on this row immediately (no cache miss, no stale set).
              reloadSavedMeals();
              Alert.alert('Saved', 'You can log this meal again from Foods → Saved Meals, or the "From saved" button on any day card.');
            } catch (e: any) {
              Alert.alert('Could not save', String(e?.message ?? e));
            }
          }}
          onAddCustomFood={(item) => {
            // Route through `onProfileUpdate` so the new food:
            //  1. Lands in React state (so `allFoodsWithCustom` picks it up
            //     on the next render and the food becomes visible in the
            //     meal-edit picker immediately),
            //  2. Gets persisted to AsyncStorage, and
            //  3. Syncs to the backend via `pushUserStateToBackend` so it
            //     survives sign-out / cross-device.
            const existing = userProfile?.customFoods ?? [];
            if (existing.some(f => f.name.toLowerCase() === item.name.toLowerCase())) return;
            const next = [...existing, item];
            onProfileUpdate?.({ customFoods: next } as any, true); // skipRegen
          }}
        />
      )}

      {/* Saved-meal template editor — opens from Foods → Saved Meals ⋯
          menu. Reuses MealEditModal in template mode so the editing
          experience is identical (foods picker, scan, macros). Save
          writes to the saved-meal template; past logs stay frozen. */}
      {editingSavedMeal && (() => {
        // Hydrate a MealSuggestion from the saved meal's items.
        const mappedItems = (editingSavedMeal.items || []).map((it: any) => {
          const qty = Number(it.quantity || 1);
          const cal = Number(it.calories || 0);
          const pro = Number(it.protein_g || it.protein || 0);
          const carbs = Number(it.carbs_g || it.carbs || 0);
          const fat = Number(it.fat_g || it.fat || 0);
          return {
            name: String(it.food_name || it.name || 'Item'),
            quantity: qty,
            unit: String(it.unit || 'serving'),
            calories: cal,
            protein: pro,
            carbs,
            fat,
            baseQuantity: qty > 0 ? qty : 1,
            baseCalories: cal, baseProtein: pro, baseCarbs: carbs, baseFat: fat,
          };
        });
        const totals = mappedItems.reduce(
          (acc: any, it: any) => ({
            calories: acc.calories + (it.calories || 0),
            protein:  acc.protein  + (it.protein  || 0),
            carbs:    acc.carbs    + (it.carbs    || 0),
            fat:      acc.fat      + (it.fat      || 0),
          }),
          { calories: 0, protein: 0, carbs: 0, fat: 0 },
        );
        const scaffoldMeal = {
          meal: editingSavedMeal.name,
          items: mappedItems as any,
          foods: mappedItems.map((i: any) => i.name),
          amounts: mappedItems.map((i: any) => `${i.quantity} ${i.unit}`),
          ...totals,
        };
        const scaffoldPlan = {
          targets: { calories: 0, protein: 0, carbs: 0, fat: 0 },
          meals: [scaffoldMeal],
        } as any;
        return (
          <MealEditModal
            visible
            mealType="meal_0"
            meal={scaffoldMeal as any}
            dateKey={undefined}
            themeName={userProfile.themePreference}
            nutritionPlan={scaffoldPlan}
            allFoods={allFoodsWithCustom}
            foodCategories={userFoodCategories}
            savedMeals={[]}
            authToken={authToken}
            mode="template"
            cookingSkill={userProfile.cookingSkill}
            prepTimeMinutes={userProfile.prepTimeMinutes}
            dietaryPreference={userProfile.dietaryPreference}
            allergies={userProfile.allergies}
            onClose={() => setEditingSavedMeal(null)}
            onSave={async (updated) => {
              // Map MealEditModal items (name/quantity/unit/calories/protein/carbs/fat)
              // back into the SavedMealItem shape.
              const items = (updated.items ?? []).map((it: any) => ({
                food_name: it.name || 'Item',
                quantity: Number(it.quantity || 1),
                unit: String(it.unit || 'serving'),
                calories: Number(it.calories || 0),
                protein_g: Number(it.protein || 0),
                carbs_g: Number(it.carbs || 0),
                fat_g: Number(it.fat || 0),
              }));
              try {
                const { updateSavedMeal } = await import('../services/api');
                await updateSavedMeal(authToken!, editingSavedMeal.id, {
                  name: updated.meal || editingSavedMeal.name,
                  items: items as any,
                });
                reloadSavedMeals();
                setEditingSavedMeal(null);
                Alert.alert('Updated', 'Template updated. Future logs will use your new version.');
              } catch (e: any) {
                Alert.alert('Could not update', String(e?.message ?? e));
              }
            }}
          />
        );
      })()}

      {/* Embedded form-video modal */}
      <FormVideoModal
        visible={!!videoModalTarget}
        exerciseName={videoModalTarget?.name ?? ''}
        equipment={videoModalTarget?.equipment ?? null}
        primaryMuscle={videoModalTarget?.primary_muscle ?? null}
        movementPattern={videoModalTarget?.movement_pattern ?? null}
        authToken={authToken}
        themeName={userProfile.themePreference}
        onClose={() => setVideoModalTarget(null)}
      />

      {/* Recipe modal — on-demand prep instructions + variations */}
      <RecipeModal
        visible={!!recipeTarget}
        meal={recipeTarget?.meal ?? null}
        authToken={authToken}
        themeName={userProfile.themePreference}
        cookingSkill={userProfile.cookingSkill}
        prepTimeMinutes={userProfile.prepTimeMinutes}
        dietaryPreference={userProfile.dietaryPreference}
        allergies={userProfile.allergies}
        onClose={() => setRecipeTarget(null)}
        onPersist={(updated) => {
          if (!recipeTarget) return;
          // Persist the fetched recipe variants back onto the meal via the
          // same handler the edit modal uses — keeps plan state + storage
          // + backend day-state in lockstep.
          handleMealSave(recipeTarget.dateKey, recipeTarget.type, updated);
        }}
      />

      {/* Side menu modal removed — the bottom Profile tab now hosts the
          same destinations as an inline list. */}

      {/* Exercise library — inline View inside HomeScreen's render tree.
          No more Modal portal, no more internal header/tab bar — the
          outer workout sub-tab bar drives which content (exercises vs
          muscles) shows via `libraryActiveTab`, which my sub-tab buttons
          already set. Only a thin back header appears when the user
          drills into a specific exercise or muscle detail. */}
      {showExerciseLibrary && (
        <View style={[styles.libraryInlineWrap, { top: insets.top + 70 + 52, backgroundColor: themeColors.background }]}>
          <View style={[styles.librarySheet, { backgroundColor: themeColors.surface }]}>

            {/* Library sub-toggle: Exercises / Muscles */}
            {!selectedExercise && !selectedMuscle && (
              <View style={{ flexDirection: 'row', gap: 0, borderRadius: 8, overflow: 'hidden', marginBottom: 10, borderWidth: 1, borderColor: themeColors.border }}>
                <TouchableOpacity
                  style={{ flex: 1, paddingVertical: 8, alignItems: 'center', backgroundColor: libraryActiveTab === 'exercises' ? themeColors.primary + '18' : 'transparent' }}
                  onPress={() => setLibraryActiveTab('exercises')}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: libraryActiveTab === 'exercises' ? themeColors.primary : themeColors.textMuted }}>Exercises</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={{ flex: 1, paddingVertical: 8, alignItems: 'center', backgroundColor: libraryActiveTab === 'muscles' ? themeColors.primary + '18' : 'transparent' }}
                  onPress={() => setLibraryActiveTab('muscles')}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: libraryActiveTab === 'muscles' ? themeColors.primary : themeColors.textMuted }}>Muscles</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Back header — only when drilled into a detail view. */}
            {(selectedExercise || selectedMuscle) && (
              <View style={styles.libraryHeader}>
                <TouchableOpacity onPress={() => {
                  if (selectedExercise) { setSelectedExercise(null); return; }
                  if (selectedMuscle) { setSelectedMuscle(null); return; }
                }}>
                  <Text style={[styles.libraryClose, { color: themeColors.primary }]}>← Back</Text>
                </TouchableOpacity>
                <Text style={[styles.libraryTitle, { color: themeColors.textPrimary, marginLeft: 12, flex: 1 }]}>
                  {selectedExercise ? selectedExercise.name : selectedMuscle!.name}
                </Text>
              </View>
            )}

            {/* ── EXERCISE DETAIL ──────────────────────────────────────────────── */}
            {selectedExercise ? (
              <ScrollView contentContainerStyle={styles.detailContent}>
                {(() => {
                  const guide = buildExerciseGuide(selectedExercise);
                  const _vid = (selectedExercise as any).video_id as string | null | undefined;
                  return (
                    <>
                      <ExerciseVideoCard
                        exerciseName={selectedExercise.name}
                        videoId={_vid}
                        themeName={userProfile.themePreference}
                        onPress={() => openExerciseVideo(selectedExercise.name, {
                          // Pass the concrete gear (first entry) when
                          // available so "Band Chest Press" queries
                          // include "resistance band" and filter out
                          // machine/cable/dumbbell variants.
                          equipment: (() => {
                            const gear = (selectedExercise as any).gear as Array<{ name: string }> | undefined;
                            return gear?.[0]?.name ?? selectedExercise.equipment ?? null;
                          })(),
                          primary_muscle: selectedExercise.primary_muscle ?? null,
                          movement_pattern: (selectedExercise as any).movement_pattern ?? null,
                        })}
                      />
                      <View style={[styles.detailTopCard, { backgroundColor: workoutPalette.soft, borderColor: workoutPalette.strong + '40' }]}>
                        <Text style={[styles.detailMeta, { color: workoutPalette.text }]}>Primary: {humanizeToken(selectedExercise.primary_muscle)}</Text>
                        {selectedExercise.secondary_muscles?.length ? (
                          <Text style={[styles.detailMeta, { color: workoutPalette.text + 'BB' }]}>Also hits: {selectedExercise.secondary_muscles.map(humanizeToken).join(', ')}</Text>
                        ) : null}
                        {/* Prefer the concrete gear list (from
                            ExerciseEquipment) over the broad
                            home/gym/minimal bucket — "Equipment: Home"
                            was confusing users into thinking "Home" was
                            a piece of gear. Bucket becomes a separate
                            "Setting" hint when useful. */}
                        {(() => {
                          const gear = (selectedExercise as any).gear as Array<{ name: string; slug: string }> | undefined;
                          const bucket = String(selectedExercise.equipment ?? '').toLowerCase();
                          const gearLabel = gear && gear.length
                            ? gear.map(g => g.name).join(', ')
                            : (bucket === 'bodyweight' || bucket === 'none' ? 'Bodyweight' : null);
                          const settingLabel =
                            bucket === 'home' ? 'Home-friendly'
                            : bucket === 'minimal' ? 'Minimal equipment'
                            : bucket === 'gym' ? 'Gym'
                            : bucket === 'full' ? 'Full gym'
                            : null;
                          return (
                            <>
                              {gearLabel && (
                                <Text style={[styles.detailMeta, { color: workoutPalette.text + 'BB' }]}>Equipment: {gearLabel}</Text>
                              )}
                              {settingLabel && gearLabel !== settingLabel && (
                                <Text style={[styles.detailMeta, { color: workoutPalette.text + '99' }]}>Setting: {settingLabel}</Text>
                              )}
                            </>
                          );
                        })()}
                        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, alignItems: 'center' }}>
                          {/* "Watch Form Video" button removed — the
                              ExerciseVideoCard above handles the same
                              YouTube deep-link with a real thumbnail
                              preview, so the button was a duplicate CTA. */}
                          {/* Avoid-this-exercise toggle (labelled — this
                              is an EXERCISE preference, NOT feedback on
                              the form video). Excludes the exercise
                              from future AI-generated plans unless the
                              user manually adds it back. */}
                          {(() => {
                            const disliked = (userProfile.dislikedExercises ?? []).some(
                              d => d.toLowerCase() === selectedExercise.name.toLowerCase(),
                            );
                            const applyToggle = () => {
                              const existing = userProfile.dislikedExercises ?? [];
                              const next = disliked
                                ? existing.filter(d => d.toLowerCase() !== selectedExercise.name.toLowerCase())
                                : [...existing, selectedExercise.name];
                              onProfileUpdate?.({ dislikedExercises: next } as any, true);
                            };
                            const onPress = () => {
                              if (disliked) {
                                // Un-avoiding doesn't need confirmation —
                                // it's a "let it back in" action, not a
                                // destructive one.
                                applyToggle();
                                return;
                              }
                              Alert.alert(
                                'Avoid this exercise?',
                                `We'll try not to include ${selectedExercise.name} in future plans unless you manually add it. Great for movements that aggravate an injury or you just don't enjoy.`,
                                [
                                  { text: 'Cancel', style: 'cancel' },
                                  { text: 'Avoid Exercise', style: 'destructive', onPress: applyToggle },
                                ],
                              );
                            };
                            return (
                              <TouchableOpacity
                                onPress={onPress}
                                activeOpacity={0.8}
                                style={{
                                  flexDirection: 'row', alignItems: 'center', gap: 8,
                                  paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10,
                                  backgroundColor: disliked ? themeColors.error + '1A' : themeColors.surfaceRaised,
                                  borderWidth: 1,
                                  borderColor: disliked ? themeColors.error + '88' : themeColors.border,
                                }}
                                accessibilityRole="button"
                                accessibilityLabel={disliked ? 'Currently avoiding — tap to allow this exercise again' : 'Avoid this exercise in future plans'}
                              >
                                <Ionicons
                                  name={disliked ? 'thumbs-down' : 'thumbs-down-outline'}
                                  size={16}
                                  color={disliked ? themeColors.error : themeColors.textSecondary}
                                />
                                <Text style={{
                                  fontSize: 12, fontWeight: '700',
                                  color: disliked ? themeColors.error : themeColors.textSecondary,
                                }}>
                                  {disliked ? 'Avoiding this exercise' : "Don't recommend"}
                                </Text>
                              </TouchableOpacity>
                            );
                          })()}
                        </View>
                      </View>

                      <View style={styles.detailSection}>
                        <Text style={[styles.detailSectionTitle, { color: themeColors.textPrimary }]}>How To Perform It</Text>
                        <Text style={[styles.detailSectionText, { color: themeColors.textSecondary }]}>{guide.howTo}</Text>
                      </View>

                      <View style={styles.detailSection}>
                        <Text style={[styles.detailSectionTitle, { color: themeColors.textPrimary }]}>Setup</Text>
                        <Text style={[styles.detailSectionText, { color: themeColors.textSecondary }]}>{guide.setup}</Text>
                      </View>

                      <View style={styles.detailSection}>
                        <Text style={[styles.detailSectionTitle, { color: themeColors.textPrimary }]}>Movement Cue</Text>
                        <Text style={[styles.detailSectionText, { color: themeColors.textSecondary }]}>{guide.movement}</Text>
                      </View>

                      {/* Muscle phase breakdown */}
                      <View style={[styles.detailPhaseBlock, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]}>
                        <Text style={[styles.detailPhaseTitle, { color: themeColors.textPrimary }]}>Muscle Phase Breakdown</Text>
                        <View style={styles.detailPhaseRow}>
                          <View style={[styles.detailPhaseBadge, { backgroundColor: workoutPalette.strong + '22' }]}>
                            <Text style={[styles.detailPhaseBadgeLabel, { color: workoutPalette.strong }]}>↑ LIFTING</Text>
                          </View>
                          <Text style={[styles.detailPhaseText, { color: themeColors.textSecondary }]}>{guide.concentric}</Text>
                        </View>
                        <View style={[styles.detailPhaseDivider, { backgroundColor: themeColors.border }]} />
                        <View style={styles.detailPhaseRow}>
                          <View style={[styles.detailPhaseBadge, { backgroundColor: mealPalette.strong + '22' }]}>
                            <Text style={[styles.detailPhaseBadgeLabel, { color: mealPalette.strong }]}>↓ LOWERING</Text>
                          </View>
                          <Text style={[styles.detailPhaseText, { color: themeColors.textSecondary }]}>{guide.eccentric}</Text>
                        </View>
                      </View>

                      <View style={styles.detailSection}>
                        <Text style={[styles.detailSectionTitle, { color: themeColors.textPrimary }]}>What It Hits & Why</Text>
                        <Text style={[styles.detailSectionText, { color: themeColors.textSecondary }]}>{guide.hits}</Text>
                        <Text style={[styles.detailSectionText, { color: themeColors.textSecondary, marginTop: 6 }]}>{guide.why}</Text>
                      </View>

                      <View style={styles.detailSection}>
                        <Text style={[styles.detailSectionTitle, { color: themeColors.textPrimary }]}>How It Should Feel</Text>
                        <Text style={[styles.detailSectionText, { color: themeColors.textSecondary }]}>{guide.feel}</Text>
                      </View>

                      <View style={styles.detailSection}>
                        <Text style={[styles.detailSectionTitle, { color: themeColors.error ?? '#FF4444' }]}>Common Mistake</Text>
                        <Text style={[styles.detailSectionText, { color: themeColors.textSecondary }]}>{guide.mistake}</Text>
                      </View>
                    </>
                  );
                })()}
              </ScrollView>

            /* ── MUSCLE DETAIL ──────────────────────────────────────────────── */
            ) : selectedMuscle ? (
              <ScrollView contentContainerStyle={styles.detailContent}>
                <View style={[styles.detailTopCard, { backgroundColor: selectedMuscle.tagColor + '22', borderColor: selectedMuscle.tagColor + '55', alignItems: 'center' }]}>
                  <View style={{ width: 64, height: 64, borderRadius: 16, backgroundColor: selectedMuscle.tagColor + '22', alignItems: 'center', justifyContent: 'center', marginBottom: 8 }}>
                    <Ionicons name={(selectedMuscle.icon || 'body-outline') as any} size={32} color={selectedMuscle.tagColor} />
                  </View>
                  <Text style={[styles.detailMeta, { color: selectedMuscle.tagColor, fontWeight: '700', fontSize: 13 }]}>{selectedMuscle.commonName.toUpperCase()} · {selectedMuscle.bodyRegion}</Text>
                  <Text style={[styles.detailSectionText, { color: themeColors.textSecondary, marginTop: 6 }]}>{selectedMuscle.shortDescription}</Text>
                </View>

                <View style={styles.detailSection}>
                  <Text style={[styles.detailSectionTitle, { color: themeColors.textPrimary }]}>Location</Text>
                  <Text style={[styles.detailSectionText, { color: themeColors.textSecondary }]}>{selectedMuscle.location}</Text>
                </View>

                <View style={styles.detailSection}>
                  <Text style={[styles.detailSectionTitle, { color: themeColors.textPrimary }]}>Structure</Text>
                  <Text style={[styles.detailSectionText, { color: themeColors.textSecondary }]}>{selectedMuscle.structure}</Text>
                </View>

                <View style={styles.detailSection}>
                  <Text style={[styles.detailSectionTitle, { color: themeColors.textPrimary }]}>Primary Function</Text>
                  <Text style={[styles.detailSectionText, { color: themeColors.textSecondary }]}>{selectedMuscle.primaryFunction}</Text>
                </View>

                {/* Phase breakdown */}
                <View style={[styles.detailPhaseBlock, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]}>
                  <Text style={[styles.detailPhaseTitle, { color: themeColors.textPrimary }]}>Contraction Phases</Text>
                  <View style={styles.detailPhaseRow}>
                    <View style={[styles.detailPhaseBadge, { backgroundColor: workoutPalette.strong + '22' }]}>
                      <Text style={[styles.detailPhaseBadgeLabel, { color: workoutPalette.strong }]}>↑ CONCENTRIC</Text>
                    </View>
                    <Text style={[styles.detailPhaseText, { color: themeColors.textSecondary }]}>{selectedMuscle.phases.concentric}</Text>
                  </View>
                  <View style={[styles.detailPhaseDivider, { backgroundColor: themeColors.border }]} />
                  <View style={styles.detailPhaseRow}>
                    <View style={[styles.detailPhaseBadge, { backgroundColor: mealPalette.strong + '22' }]}>
                      <Text style={[styles.detailPhaseBadgeLabel, { color: mealPalette.strong }]}>↓ ECCENTRIC</Text>
                    </View>
                    <Text style={[styles.detailPhaseText, { color: themeColors.textSecondary }]}>{selectedMuscle.phases.eccentric}</Text>
                  </View>
                  {selectedMuscle.phases.isometric && (
                    <>
                      <View style={[styles.detailPhaseDivider, { backgroundColor: themeColors.border }]} />
                      <View style={styles.detailPhaseRow}>
                        <View style={[styles.detailPhaseBadge, { backgroundColor: aiPalette.strong + '22' }]}>
                          <Text style={[styles.detailPhaseBadgeLabel, { color: aiPalette.strong }]}>■ ISOMETRIC</Text>
                        </View>
                        <Text style={[styles.detailPhaseText, { color: themeColors.textSecondary }]}>{selectedMuscle.phases.isometric}</Text>
                      </View>
                    </>
                  )}
                </View>

                <View style={styles.detailSection}>
                  <Text style={[styles.detailSectionTitle, { color: themeColors.textPrimary }]}>How To Feel It</Text>
                  <Text style={[styles.detailSectionText, { color: themeColors.textSecondary }]}>{selectedMuscle.howToFeel}</Text>
                </View>

                <View style={styles.detailSection}>
                  <Text style={[styles.detailSectionTitle, { color: themeColors.textPrimary }]}>Mind-Muscle Connection</Text>
                  <Text style={[styles.detailSectionText, { color: themeColors.textSecondary }]}>{selectedMuscle.mindMuscleConnection}</Text>
                </View>

                <View style={styles.detailSection}>
                  <Text style={[styles.detailSectionTitle, { color: themeColors.textPrimary }]}>Best Exercises</Text>
                  {selectedMuscle.bestExercises.map((ex, i) => (
                    <Text key={i} style={[styles.detailSectionText, { color: themeColors.textSecondary, marginBottom: 3 }]}>• {ex}</Text>
                  ))}
                </View>

                <View style={styles.detailSection}>
                  <Text style={[styles.detailSectionTitle, { color: themeColors.error ?? '#FF4444' }]}>Common Mistakes</Text>
                  <Text style={[styles.detailSectionText, { color: themeColors.textSecondary }]}>{selectedMuscle.commonMistakes}</Text>
                </View>

                <View style={styles.detailSection}>
                  <Text style={[styles.detailSectionTitle, { color: themeColors.textPrimary }]}>Growth Tip</Text>
                  <Text style={[styles.detailSectionText, { color: themeColors.textSecondary }]}>{selectedMuscle.growthTip}</Text>
                </View>

                <View style={styles.detailSection}>
                  <Text style={[styles.detailSectionTitle, { color: themeColors.textPrimary }]}>Recovery</Text>
                  <Text style={[styles.detailSectionText, { color: themeColors.textSecondary }]}>{selectedMuscle.recoveryNote}</Text>
                </View>
              </ScrollView>

            /* ── EXERCISES LIST ──────────────────────────────────────────────── */
            ) : libraryActiveTab === 'exercises' ? (
              exerciseLibraryLoading ? (
                <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />
              ) : (
                <ScrollView contentContainerStyle={styles.libraryList}>
                  <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginBottom: 18 }}>
                    <SearchInput
                      containerStyle={{ flex: 1 }}
                      value={exerciseSearch}
                      onChangeText={(t) => { setExerciseSearch(t); if (!t) setAiExerciseResults([]); }}
                      placeholder="Search exercises, muscles, or equipment"
                      placeholderTextColor={themeColors.textMuted}
                      style={[styles.librarySearchInput, { marginBottom: 0, backgroundColor: themeColors.background, borderColor: themeColors.border, color: themeColors.textPrimary }]}
                      returnKeyType="search"
                      onSubmitEditing={handleAiExerciseSearch}
                    />
                    {exerciseSearch.trim().length > 1 && authToken && (
                      <TouchableOpacity
                        style={{ backgroundColor: workoutPalette.strong, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, opacity: aiExerciseLoading ? 0.6 : 1 }}
                        onPress={handleAiExerciseSearch}
                        disabled={aiExerciseLoading}>
                        {aiExerciseLoading
                          ? <ActivityIndicator size="small" color="#fff" />
                          : <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>AI Search</Text>}
                      </TouchableOpacity>
                    )}
                  </View>

                  {/* If the local library has nothing, nudge the user toward
                      AI search — same pattern as the food search in
                      MealEditModal. */}
                  {exerciseSearch.trim().length > 1
                    && filteredExerciseLibrary.length === 0
                    && aiExerciseResults.length === 0
                    && !aiExerciseLoading
                    && authToken && (
                    <TouchableOpacity
                      style={{ backgroundColor: themeColors.surfaceRaised, borderWidth: 1, borderColor: workoutPalette.strong + '55', borderRadius: 10, padding: 14, marginBottom: 12, alignItems: 'center' }}
                      onPress={handleAiExerciseSearch}>
                      <Text style={{ color: themeColors.textPrimary, fontSize: 14, fontWeight: '600' }}>
                        No local matches for "{exerciseSearch.trim()}"
                      </Text>
                      <Text style={{ color: workoutPalette.strong, fontSize: 13, fontWeight: '700', marginTop: 4 }}>
                        Tap AI Search to find it →
                      </Text>
                    </TouchableOpacity>
                  )}

                  {aiExerciseResults.length > 0 && (
                    <View style={{ marginBottom: 16 }}>
                      <Text style={[styles.libraryItemName, { color: themeColors.textMuted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }]}>AI Results</Text>
                      {aiExerciseResults.map((ex, i) => {
                        const alreadySaved = (userProfile?.customExercises ?? []).some(c => c.name.toLowerCase() === ex.name.toLowerCase());
                        return (
                          <View key={`${ex.name}-${i}`} style={[styles.libraryItem, { backgroundColor: themeColors.surfaceRaised, borderColor: workoutPalette.strong + '55', borderWidth: 1.5 }]}>
                            <Text style={[styles.libraryItemName, { color: themeColors.textPrimary }]}>{ex.name}</Text>
                            <Text style={[styles.libraryItemMeta, { color: workoutPalette.strong }]}>
                              {ex.primary_muscle} · {ex.equipment} · {ex.sets}×{ex.reps}
                            </Text>
                            <Text style={[styles.libraryItemDesc, { color: themeColors.textSecondary }]}>{ex.why}</Text>
                            {ex.form_cues?.length > 0 && (
                              <Text style={[styles.libraryItemDesc, { color: themeColors.textMuted, marginTop: 4, fontSize: 12 }]}>
                                Cues: {ex.form_cues.join(' · ')}
                              </Text>
                            )}
                            <TouchableOpacity
                              style={{ marginTop: 10, alignSelf: 'flex-start', backgroundColor: alreadySaved ? themeColors.border : workoutPalette.strong, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8 }}
                              onPress={() => handleSaveAiExerciseToLibrary(ex)}
                              disabled={alreadySaved}>
                              <Text style={{ color: alreadySaved ? themeColors.textMuted : '#fff', fontWeight: '700', fontSize: 13 }}>
                                {alreadySaved ? '✓ In Library' : '+ Save to Library'}
                              </Text>
                            </TouchableOpacity>
                          </View>
                        );
                      })}
                    </View>
                  )}

                  <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast" contentContainerStyle={styles.libraryFilterRow}>
                    <TouchableOpacity
                      style={[styles.libraryFilterChip, exerciseMuscleFilter === 'all' && styles.libraryFilterChipActive]}
                      onPress={() => setExerciseMuscleFilter('all')}>
                      <Text style={[styles.libraryFilterText, exerciseMuscleFilter === 'all' && styles.libraryFilterTextActive]}>All Muscles</Text>
                    </TouchableOpacity>
                    {exerciseMuscleOptions.map((muscle) => (
                      <TouchableOpacity
                        key={muscle}
                        style={[styles.libraryFilterChip, exerciseMuscleFilter === muscle && styles.libraryFilterChipActive]}
                        onPress={() => setExerciseMuscleFilter(muscle)}>
                        <Text style={[styles.libraryFilterText, exerciseMuscleFilter === muscle && styles.libraryFilterTextActive]}>{humanizeToken(muscle)}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>

                  <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast" contentContainerStyle={styles.libraryFilterRow}>
                    <TouchableOpacity
                      style={[styles.libraryFilterChip, exerciseEquipmentFilter === 'all' && styles.libraryFilterChipActive]}
                      onPress={() => setExerciseEquipmentFilter('all')}>
                      <Text style={[styles.libraryFilterText, exerciseEquipmentFilter === 'all' && styles.libraryFilterTextActive]}>All Equipment</Text>
                    </TouchableOpacity>
                    {exerciseEquipmentOptions.map((equipment) => (
                      <TouchableOpacity
                        key={equipment}
                        style={[styles.libraryFilterChip, exerciseEquipmentFilter === equipment && styles.libraryFilterChipActive]}
                        onPress={() => setExerciseEquipmentFilter(equipment)}>
                        <Text style={[styles.libraryFilterText, exerciseEquipmentFilter === equipment && styles.libraryFilterTextActive]}>{humanizeToken(equipment)}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>

                  {filteredExerciseLibrary.length === 0 ? (
                    <Text style={[styles.libraryEmptyText, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border, color: themeColors.textMuted }]}>No exercises match the current search and filters.</Text>
                  ) : filteredExerciseLibrary.map((ex) => {
                    // YouTube thumbnail when the exercise has a curated
                    // video_id; otherwise placeholder icon. wger static
                    // images are no longer used — consistent video-tile
                    // look across every surface that shows an exercise.
                    const _thumb = exerciseThumbSmall(ex as any);
                    return (
                    <TouchableOpacity key={String(ex.id ?? ex.name)} style={[styles.libraryItem, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border, flexDirection: 'row', gap: 12, alignItems: 'center' }]} activeOpacity={0.8} onPress={() => setSelectedExercise(ex)}>
                      {_thumb ? (
                        /* Thumbnail is a separate tap target — tapping
                           it launches the form-video modal directly so
                           users can preview without first opening the
                           detail page. */
                        <TouchableOpacity
                          activeOpacity={0.7}
                          onPress={(e) => {
                            e.stopPropagation();
                            openExerciseVideo(ex.name, {
                              equipment: (ex as any).gear?.[0]?.name ?? (ex as any).equipment ?? null,
                              primary_muscle: (ex as any).primary_muscle ?? null,
                              movement_pattern: (ex as any).movement_pattern ?? null,
                            });
                          }}
                          accessibilityRole="button"
                          accessibilityLabel={`Play form video for ${ex.name}`}
                        >
                          <View style={{ width: 48, height: 48, borderRadius: 10, backgroundColor: themeColors.surface, overflow: 'hidden', borderWidth: 2, borderColor: themeColors.border, position: 'relative' }}>
                            <Image source={{ uri: _thumb }} style={{ width: 48, height: 48 }} resizeMode="cover" />
                            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
                              <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons name="play" size={10} color="#fff" style={{ marginLeft: 1 }} />
                              </View>
                            </View>
                          </View>
                        </TouchableOpacity>
                      ) : (
                        <View style={{ width: 48, height: 48, borderRadius: 10, backgroundColor: workoutPalette.soft, alignItems: 'center', justifyContent: 'center' }}>
                          <Ionicons name="barbell-outline" size={20} color={workoutPalette.strong} />
                        </View>
                      )}
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.libraryItemName, { color: themeColors.textPrimary }]}>{ex.name}</Text>
                        <Text style={[styles.libraryItemMeta, { color: workoutPalette.strong }]}>
                          {humanizeToken(ex.primary_muscle)}
                          {Array.isArray(ex.secondary_muscles) && ex.secondary_muscles.length
                            ? ` · also hits ${ex.secondary_muscles.map(humanizeToken).join(', ')}`
                            : ''}
                        </Text>
                        {/* Equipment (concrete gear only, no "home"
                            bucket). Kept small and only shown when the
                            row has space — library feels like a library,
                            not a YouTube results page. */}
                        {(() => {
                          const gear = (ex as any).gear as Array<{ name: string }> | undefined;
                          if (!gear || gear.length === 0) return null;
                          return (
                            <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }} numberOfLines={1}>
                              {gear.map(g => g.name).slice(0, 2).join(', ')}
                            </Text>
                          );
                        })()}
                      </View>
                      <Ionicons name="chevron-forward" size={16} color={themeColors.textMuted} />
                    </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              )

            /* ── MUSCLE LIST ──────────────────────────────────────────────────── */
            ) : (
              <ScrollView contentContainerStyle={styles.libraryList}>
                {/* Region filter */}
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.libraryFilterRow}>
                  {['all', 'Arms', 'Chest', 'Back', 'Shoulders', 'Legs', 'Glutes', 'Core'].map((region) => {
                    const active = muscleRegionFilter === region;
                    return (
                      <TouchableOpacity
                        key={region}
                        style={[styles.libraryFilterChip, active && { backgroundColor: aiPalette.strong, borderColor: aiPalette.strong }]}
                        onPress={() => setMuscleRegionFilter(region)}>
                        <Text style={[styles.libraryFilterText, active && { color: '#FFFFFF' }]}>
                          {region === 'all' ? 'All Muscles' : region}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>

                {MUSCLE_LIBRARY
                  .filter(m => muscleRegionFilter === 'all' || m.bodyRegion.toLowerCase().includes(muscleRegionFilter.toLowerCase()))
                  .map((muscle) => (
                    <TouchableOpacity
                      key={muscle.id}
                      style={[styles.libraryItem, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]}
                      activeOpacity={0.8}
                      onPress={() => setSelectedMuscle(muscle)}>
                      <View style={styles.muscleItemRow}>
                        <View style={[styles.muscleItemEmoji, { backgroundColor: muscle.tagColor + '18', borderRadius: 12 }]}>
                          <Ionicons name={(muscle.icon || 'body-outline') as any} size={24} color={muscle.tagColor} />
                        </View>
                        <View style={styles.muscleItemBody}>
                          <Text style={[styles.libraryItemName, { color: themeColors.textPrimary }]}>{muscle.name}</Text>
                          <Text style={[styles.libraryItemMeta, { color: muscle.tagColor }]}>{muscle.commonName} · {muscle.bodyRegion}</Text>
                          <Text style={[styles.libraryItemDesc, { color: themeColors.textSecondary }]} numberOfLines={2}>{muscle.shortDescription}</Text>
                        </View>
                      </View>
                      <Text style={[styles.libraryItemLink, { color: themeColors.accent }]}>Tap to learn →</Text>
                    </TouchableOpacity>
                  ))}
              </ScrollView>
            )}
          </View>
        </View>
      )}

      <Modal visible={showTrainerModal} animationType="slide" transparent onRequestClose={() => setShowTrainerModal(false)}>
        <KeyboardAvoidingView
          style={styles.trainerFullScreen}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
        >
          <View style={[styles.trainerSheet, { backgroundColor: themeColors.surface, borderTopColor: themeColors.border }]}>
            <View style={[styles.sheetHandle, { backgroundColor: themeColors.border }]} />
            <FadeInView delay={100}>
            <View style={styles.libraryHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="chatbubble-ellipses" size={20} color={themeColors.primary} />
                <Text style={[styles.libraryTitle, { color: themeColors.textPrimary }]}>AI Coach</Text>
              </View>
              <TouchableOpacity onPress={() => { setShowTrainerModal(false); setWorkoutChat([]); setWorkoutChat([]); setPendingUpdate(null); setPendingInjuries(null); setWorkoutUpdateSummary(null); setNutritionUpdateSummary(null); }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={themeColors.textMuted} />
              </TouchableOpacity>
            </View>
            </FadeInView>

            {/* Single unified chat */}

            {workoutUpdateSummary && (
              <View style={[styles.trainerSummaryCard, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]}>
                <Text style={[styles.trainerSummaryTitle, { color: themeColors.primary }]}>Plan Updated</Text>
                <Text style={[styles.trainerSummaryText, { color: themeColors.textSecondary }]}>{workoutUpdateSummary}</Text>
              </View>
            )}

            <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.trainerChatList} keyboardShouldPersistTaps="handled" onScrollBeginDrag={Keyboard.dismiss}>
              {(workoutChat).length === 0 ? (
                <View style={{ padding: 16, gap: 8 }}>
                  {(() => {
                    return (<>
                      <Text style={{ fontSize: 16, fontWeight: '700', color: themeColors.textPrimary }}>Your AI Coach</Text>
                      <Text style={{ fontSize: 12, color: themeColors.textSecondary, lineHeight: 18 }}>
                        Ask me anything about your workouts, nutrition, injuries, or goals. I can also make changes to your plans.
                      </Text>
                      <View style={{ gap: 4, marginTop: 4 }}>
                        {[
                          { icon: 'swap-horizontal-outline', text: '"Swap bench press for dumbbell press"' },
                          { icon: 'nutrition-outline', text: '"Suggest lower sugar breakfast options"' },
                          { icon: 'bandage-outline', text: '"My knee hurts when squatting"' },
                          { icon: 'flag-outline', text: '"Switch me to fat loss"' },
                          { icon: 'help-circle-outline', text: '"How much protein do I need?"' },
                        ].map(item => (
                          <View key={item.text} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <Ionicons name={item.icon as any} size={14} color={themeColors.textMuted} />
                            <Text style={{ fontSize: 12, color: themeColors.textSecondary }}>{item.text}</Text>
                          </View>
                        ))}
                      </View>
                    </>
                    );
                  })()}
                </View>
              ) : (() => {
                // Display cap: show the 50 most recent messages.
                // Older turns remain in state so `conversation`
                // context sent to /ai/trainer-question still carries
                // the full history, just trimmed to the last 6 there.
                // This cap is purely visual — prevents the scroll
                // view from growing unbounded over a long session.
                const fullChat = workoutChat;
                const visibleChat = fullChat.length > 50 ? fullChat.slice(-50) : fullChat;
                const hiddenCount = fullChat.length - visibleChat.length;
                return (
                  <>
                    {hiddenCount > 0 && (
                      <Text style={[styles.trainerEmpty, { color: themeColors.textMuted, fontSize: 11, paddingVertical: 8 }]}>
                        {hiddenCount} earlier message{hiddenCount !== 1 ? 's' : ''} hidden
                      </Text>
                    )}
                    {visibleChat.map((m, idx) => (
                      <View key={idx} style={[styles.trainerBubble, m.role === 'user' ? [styles.trainerBubbleUser, { backgroundColor: themeColors.primary, borderColor: themeColors.primary }] : [styles.trainerBubbleAssistant, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]]}>
                        <Text style={[styles.trainerBubbleText, { color: m.role === 'user' ? '#FFFFFF' : themeColors.textPrimary }]}>{m.content}</Text>
                        {/* Quick-intent action — when the assistant
                            response carries a structured action, show
                            an "Apply" pill that routes through the
                            same durable-state path the weekly review
                            card uses. Hidden after accept. */}
                        {m.role === 'assistant' && m.action && !m.applied && m.action.type !== 'noop' && authToken && (
                          <View style={{ flexDirection: 'row', gap: 6, marginTop: 8 }}>
                            <TouchableOpacity
                              onPress={async () => {
                                try {
                                  const { applyRecommendationAction } = await import('../services/api');
                                  const r = await applyRecommendationAction(authToken, m.action!, m.intent ?? undefined);
                                  setWorkoutChat(prev => prev.map((x, i) => i === idx ? { ...x, applied: true } : x));
                                  setWorkoutChat(prev => [...prev, {
                                    role: 'assistant',
                                    content: r.summary,
                                  }]);
                                } catch { /* swallow */ }
                              }}
                              style={{
                                paddingHorizontal: 10, paddingVertical: 5,
                                borderRadius: 8,
                                backgroundColor: themeColors.primary,
                              }}>
                              <Text style={{ fontSize: 11, fontWeight: '800', color: themeColors.background }}>
                                Apply
                              </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              onPress={() => {
                                setWorkoutChat(prev => prev.map((x, i) => i === idx ? { ...x, applied: true } : x));
                              }}
                              style={{
                                paddingHorizontal: 10, paddingVertical: 5,
                                borderRadius: 8,
                                backgroundColor: themeColors.surface,
                                borderWidth: 1, borderColor: themeColors.border,
                              }}>
                              <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.textSecondary }}>
                                Dismiss
                              </Text>
                            </TouchableOpacity>
                          </View>
                        )}
                      </View>
                    ))}
                  </>
                );
              })()}
              {trainerLoading && (
                <View style={[styles.trainerBubble, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border, alignSelf: 'flex-start', maxWidth: '95%', paddingVertical: 14, paddingHorizontal: 16 }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <ActivityIndicator size="small" color={themeColors.primary} />
                    <Text style={[styles.trainerBubbleText, { color: themeColors.textMuted }]}>
                      {coachMode === 'nutritionist' ? 'Nutritionist is thinking…' : 'Trainer is thinking…'}
                    </Text>
                  </View>
                  <View style={{ height: 4, borderRadius: 2, backgroundColor: themeColors.border, overflow: 'hidden' }}>
                    <Animated.View style={{
                      height: '100%',
                      borderRadius: 2,
                      backgroundColor: themeColors.primary,
                      width: chatProgressAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: ['0%', '100%'],
                      }),
                    }} />
                  </View>
                </View>
              )}
              {pendingUpdate && (
                <View style={[styles.trainerBubble, { backgroundColor: themeColors.primary + '15', borderColor: themeColors.primary + '44', alignSelf: 'flex-start', maxWidth: '95%', padding: 14 }]}>
                  <Text style={{ fontSize: 13, fontWeight: '800', color: themeColors.textPrimary, marginBottom: 6 }}>Proposed Changes</Text>
                  <Text style={{ fontSize: 12, color: themeColors.textSecondary, lineHeight: 18, marginBottom: 4 }}>{pendingUpdate.summary}</Text>
                  {Object.keys(pendingUpdate.profileChanges).length > 0 && (
                    <Text style={{ fontSize: 11, color: themeColors.textMuted, marginBottom: 8 }}>
                      Settings update: {Object.entries(pendingUpdate.profileChanges).map(([k, v]) => `${k}: ${v}`).join(', ')}
                    </Text>
                  )}
                  <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
                    <TouchableOpacity
                      onPress={applyPendingUpdate}
                      style={{ flex: 1, backgroundColor: themeColors.primary, borderRadius: radius.md, paddingVertical: 10, alignItems: 'center' }}
                      activeOpacity={0.8}>
                      <Text style={{ fontSize: 13, fontWeight: '800', color: '#FFFFFF' }}>Apply</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={dismissPendingUpdate}
                      style={{ flex: 1, backgroundColor: themeColors.surfaceRaised, borderRadius: radius.md, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: themeColors.border }}
                      activeOpacity={0.8}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: themeColors.textSecondary }}>Dismiss</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
              {/* Injury approval buttons */}
              {pendingInjuries && pendingInjuries.length > 0 && (
                <View style={[styles.trainerBubble, { backgroundColor: themeColors.surfaceRaised, borderColor: '#F59E0B44', alignSelf: 'flex-start', maxWidth: '95%', paddingVertical: 12, paddingHorizontal: 16, gap: 8 }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Ionicons name="bandage-outline" size={16} color="#F59E0B" />
                    <Text style={{ fontSize: 13, fontWeight: '700', color: themeColors.textPrimary }}>
                      Add {pendingInjuries.length === 1 ? 'injury' : `${pendingInjuries.length} injuries`} to your profile?
                    </Text>
                  </View>
                  {pendingInjuries.map(inj => (
                    <Text key={inj.id} style={{ fontSize: 11, color: themeColors.textSecondary }}>
                      {inj.bodyPart} — {inj.severity ?? 'unknown'} · est. {inj.estimatedRecoveryDays ?? '?'} days
                    </Text>
                  ))}
                  <Text style={{ fontSize: 10, color: themeColors.textMuted }}>
                    Your workout plan will automatically update to avoid the injured area.
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                    <TouchableOpacity
                      onPress={async () => {
                        try {
                          const profileRaw = await AsyncStorage.getItem('userProfile');
                          if (profileRaw) {
                            const storedProfile: UserProfile = JSON.parse(profileRaw);
                            const existing = storedProfile.injuryEntries ?? [];
                            const merged = [...existing];
                            for (const entry of pendingInjuries) {
                              const idx = merged.findIndex(e => e.id === entry.id);
                              if (idx >= 0) merged[idx] = entry;
                              else merged.push(entry);
                            }
                            const updatedProfile = { ...storedProfile, injuryEntries: merged };
                            await AsyncStorage.setItem('userProfile', JSON.stringify(updatedProfile));
                            onProfileUpdate?.(updatedProfile, false);
                          }
                        } catch (e) { console.error('[injury apply] failed:', e); }
                        setPendingInjuries(null);
                        setWorkoutChat(prev => [...prev, { role: 'assistant', content: 'Injury logged — plan updating...' }]);
                        setTimeout(() => {
                          setShowTrainerModal(false);
                          setWorkoutChat([]); setWorkoutChat([]);
                          setPendingUpdate(null); setPendingInjuries(null);
                          setWorkoutUpdateSummary(null); setNutritionUpdateSummary(null);
                        }, 1500);
                      }}
                      style={{ flex: 1, backgroundColor: themeColors.primary, borderRadius: 8, paddingVertical: 10, alignItems: 'center' }}>
                      <Text style={{ fontSize: 13, fontWeight: '800', color: '#fff' }}>Add & Update Plan</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => {
                        setPendingInjuries(null);
                        setWorkoutChat(prev => [...prev, { role: 'assistant', content: 'No injury added.' }]);
                      }}
                      style={{ flex: 1, backgroundColor: themeColors.surfaceRaised, borderRadius: 8, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: themeColors.border }}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: themeColors.textSecondary }}>Skip</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
              {isChatPlanUpdating && (
                <View style={[styles.trainerBubble, { backgroundColor: themeColors.primary + '22', borderColor: themeColors.primary + '55', alignSelf: 'flex-start', maxWidth: '95%', paddingVertical: 12, paddingHorizontal: 16 }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <ActivityIndicator size="small" color={themeColors.primary} />
                    <Text style={[styles.trainerBubbleText, { color: themeColors.primary }]}>
                      Applying changes…
                    </Text>
                  </View>
                </View>
              )}
            </ScrollView>

            {attachedImage && (
              <View style={styles.attachPreviewRow}>
                <Image source={{ uri: attachedImage.uri }} style={styles.attachPreview} />
                <TouchableOpacity onPress={() => setAttachedImage(null)} style={styles.attachRemoveBtn}>
                  <Ionicons name="close-circle" size={18} color={themeColors.error} />
                </TouchableOpacity>
                <Text style={styles.attachLabel}>Photo attached</Text>
              </View>
            )}
            <View style={styles.trainerInputRow}>
              <TouchableOpacity
                style={styles.trainerAttachBtn}
                onPress={async () => {
                  Alert.alert('Attach Photo', 'Add a photo to your message', [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Camera', onPress: async () => {
                        const perm = await ImagePicker.requestCameraPermissionsAsync();
                        if (!perm.granted) return;
                        const res = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.6, mediaTypes: ['images'] as any, maxWidth: 1024, maxHeight: 1024 } as any);
                        if (!res.canceled && res.assets?.[0]?.base64) {
                          setAttachedImage({ base64: res.assets[0].base64!, uri: res.assets[0].uri });
                        }
                      },
                    },
                    {
                      text: 'Photo Library', onPress: async () => {
                        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
                        if (!perm.granted) return;
                        const res = await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.6, mediaTypes: ['images'] as any, maxWidth: 1024, maxHeight: 1024 } as any);
                        if (!res.canceled && res.assets?.[0]?.base64) {
                          setAttachedImage({ base64: res.assets[0].base64!, uri: res.assets[0].uri });
                        }
                      },
                    },
                  ]);
                }}>
                <Ionicons name="camera-outline" size={20} color={themeColors.textSecondary} />
              </TouchableOpacity>
              <TextInput
                value={trainerInput}
                onChangeText={setTrainerInput}
                placeholder={coachMode === 'nutritionist' ? 'Ask nutritionist...' : 'Ask trainer...'}
                placeholderTextColor={themeColors.textMuted}
                style={[styles.trainerInput, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border, color: themeColors.textPrimary }]}
                multiline
              />
              <TouchableOpacity
                style={[styles.trainerSendBtn, { backgroundColor: trainerLoading ? themeColors.error : themeColors.primary }]}
                onPress={trainerLoading ? () => {
                  trainerAbortRef.current?.abort();
                  setTrainerLoading(false);
                  setWorkoutChat(prev => [...prev, { role: 'assistant', content: 'Request cancelled.' }]);
                } : handleAskTrainer}>
                {trainerLoading ? <Text style={styles.trainerSendText}>Cancel</Text> : <Text style={styles.trainerSendText}>Send</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Skip reason modal */}
      <Modal visible={!!skipReasonFocus} transparent animationType="slide" onRequestClose={() => setSkipReasonFocus(null)}>
        <View style={styles.skipReasonBackdrop}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
            <View style={[styles.skipReasonSheet, { backgroundColor: themeColors.surface, borderTopColor: themeColors.border }]}>
              <View style={[styles.sheetHandle, { backgroundColor: themeColors.border }]} />

              <Text style={[styles.skipReasonTitle, { color: themeColors.textPrimary }]}>Skip Today's Workout?</Text>
              <Text style={[styles.skipReasonFocusLabel, { color: themeColors.textSecondary }]}>
                {skipReasonFocus} · Let your trainer know why
              </Text>

              <View style={styles.skipReasonChips}>
                {SKIP_REASONS.map(r => {
                  const active = selectedSkipReason === r.label;
                  return (
                    <TouchableOpacity
                      key={r.label}
                      style={[styles.skipReasonChip, {
                        borderColor: active ? themeColors.warning : themeColors.border,
                        backgroundColor: active ? themeColors.warning + '22' : themeColors.surfaceRaised,
                      }]}
                      onPress={() => { setSelectedSkipReason(r.label); setCustomSkipReason(''); }}
                      activeOpacity={0.8}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Ionicons name={r.icon} size={16} color={active ? themeColors.warning : themeColors.textSecondary} />
                        <Text style={[styles.skipReasonChipText, { color: active ? themeColors.warning : themeColors.textSecondary }]}>
                          {r.label}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <TextInput
                value={customSkipReason}
                onChangeText={text => { setCustomSkipReason(text); setSelectedSkipReason(''); }}
                placeholder="Other reason…"
                placeholderTextColor={themeColors.textMuted}
                style={[styles.skipReasonInput, {
                  borderColor: customSkipReason ? themeColors.warning : themeColors.border,
                  backgroundColor: themeColors.surfaceRaised,
                  color: themeColors.textPrimary,
                }]}
              />

              {/* Skip type selector */}
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
                <TouchableOpacity
                  style={{
                    flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center',
                    borderWidth: 1.5,
                    borderColor: skipType === 'push' ? workoutPalette.strong : themeColors.border,
                    backgroundColor: skipType === 'push' ? workoutPalette.strong + '15' : themeColors.surfaceRaised,
                  }}
                  onPress={() => setSkipType('push')}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <Ionicons name="calendar-outline" size={15} color={skipType === 'push' ? workoutPalette.strong : themeColors.textSecondary} />
                    <Text style={{ fontSize: 13, fontWeight: '700', color: skipType === 'push' ? workoutPalette.strong : themeColors.textSecondary }}>
                      Do it tomorrow
                    </Text>
                  </View>
                  <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2, textAlign: 'center', paddingHorizontal: 4 }}>
                    This workout shifts to your next training day
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={{
                    flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center',
                    borderWidth: 1.5,
                    borderColor: skipType === 'drop' ? themeColors.warning : themeColors.border,
                    backgroundColor: skipType === 'drop' ? themeColors.warning + '15' : themeColors.surfaceRaised,
                  }}
                  onPress={() => setSkipType('drop')}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: skipType === 'drop' ? themeColors.warning : themeColors.textSecondary }}>
                    ✕ Skip it
                  </Text>
                  <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2, textAlign: 'center', paddingHorizontal: 4 }}>
                    Move on — tomorrow picks up with the next workout
                  </Text>
                </TouchableOpacity>
              </View>

              <View style={styles.skipReasonBtns}>
                <TouchableOpacity
                  style={[styles.skipReasonCancel, { borderColor: themeColors.border, backgroundColor: themeColors.surfaceRaised }]}
                  onPress={() => { setSkipReasonFocus(null); setSelectedSkipReason(''); setCustomSkipReason(''); setSkipType('push'); }}>
                  <Text style={[styles.skipReasonCancelText, { color: themeColors.textSecondary }]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.skipReasonConfirm, { backgroundColor: skipType === 'drop' ? themeColors.warning : workoutPalette.strong }]}
                  onPress={confirmSkip}>
                  <Text style={styles.skipReasonConfirmText}>
                    {skipType === 'push' ? 'Reschedule' : 'Skip'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>

      {/* Next-day unlogged-meals prompt — full-height modal with hero header.
          Shown once on first app-open of the day when yesterday had meals that
          weren't checked off. Dedupe key includes the yesterday date so the
          prompt re-appears the next morning for new gaps. */}
      <Modal
        visible={!!unloggedPrompt}
        transparent
        animationType="slide"
        onRequestClose={async () => {
          if (unloggedPrompt) {
            await AsyncStorage.setItem(`unloggedMealsPromptShown_${unloggedPrompt.date}`, '1').catch(() => {});
          }
          setUnloggedPrompt(null);
        }}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' }}>
          {unloggedPrompt && (
            <View style={{
              backgroundColor: themeColors.surface,
              borderTopLeftRadius: 24, borderTopRightRadius: 24,
              borderTopWidth: 1, borderTopColor: themeColors.border,
              height: '92%',
            }}>
              {/* Handle */}
              <View style={{ alignItems: 'center', paddingTop: 10 }}>
                <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: themeColors.border }} />
              </View>
              {/* Hero header */}
              <View style={{ alignItems: 'center', paddingTop: 16, paddingHorizontal: 22, paddingBottom: 8 }}>
                <View style={{
                  width: 54, height: 54, borderRadius: 27,
                  backgroundColor: themeColors.primary + '22',
                  alignItems: 'center', justifyContent: 'center',
                  marginBottom: 10,
                }}>
                  <Ionicons name="restaurant" size={24} color={themeColors.primary} />
                </View>
                <Text style={{ fontSize: 22, fontWeight: '900', color: themeColors.textPrimary, textAlign: 'center' }}>
                  Catch up on yesterday
                </Text>
                <Text style={{ fontSize: 13, color: themeColors.textSecondary, textAlign: 'center', marginTop: 6, lineHeight: 18 }}>
                  {unloggedPrompt.items.length === 0
                    ? 'You logged fewer meals than your daily target yesterday. Add anything you ate that didn\'t get tracked.'
                    : `${unloggedPrompt.items.length} meal${unloggedPrompt.items.length === 1 ? ' wasn\'t' : 's weren\'t'} logged. Mark what you ate, edit anything that changed, or skip the rest.`}
                </Text>
              </View>
              <ScrollView contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 24, paddingTop: 14 }} showsVerticalScrollIndicator={false}>
                {/* Free-tier branch — no item list (there's no plan to list).
                    Offer a direct CTA to the Foods tab for manual logging. */}
                {unloggedPrompt.items.length === 0 && (
                  <View>
                    <TouchableOpacity
                      activeOpacity={0.85}
                      onPress={async () => {
                        if (unloggedPrompt) {
                          await AsyncStorage.setItem(`unloggedMealsPromptShown_${unloggedPrompt.date}`, '1').catch(() => {});
                        }
                        setUnloggedPrompt(null);
                        setActiveTab('meals');
                        setMealsSubTab('foods' as any);
                      }}
                      style={{
                        padding: 18, borderRadius: 14,
                        backgroundColor: themeColors.surfaceRaised,
                        borderWidth: 1, borderColor: themeColors.primary + '66',
                        alignItems: 'center', marginBottom: 10,
                      }}
                    >
                      <Ionicons name="add-circle-outline" size={32} color={themeColors.primary} />
                      <Text style={{ fontSize: 15, fontWeight: '800', color: themeColors.textPrimary, marginTop: 8 }}>
                        Add a meal
                      </Text>
                      <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 4, textAlign: 'center' }}>
                        Opens the Foods tab so you can log what you actually ate.
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={async () => {
                        if (unloggedPrompt) {
                          await AsyncStorage.setItem(`unloggedMealsPromptShown_${unloggedPrompt.date}`, '1').catch(() => {});
                        }
                        setUnloggedPrompt(null);
                      }}
                      style={{ alignSelf: 'center', padding: 12 }}
                    >
                      <Text style={{ fontSize: 12, color: themeColors.textMuted }}>Skip for now</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {unloggedPrompt.items.length > 0 && (<>


                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
                  <TouchableOpacity
                    style={{ flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', backgroundColor: themeColors.surfaceRaised, borderWidth: 1, borderColor: themeColors.border }}
                    onPress={() => {
                      if (!unloggedPrompt) return;
                      const chosen: Record<string, boolean> = {};
                      for (const it of unloggedPrompt.items) chosen[it.mealType] = true;
                      setUnloggedPrompt({ ...unloggedPrompt, chosen });
                    }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: themeColors.textSecondary }}>Mark all eaten</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={{ flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', backgroundColor: themeColors.surfaceRaised, borderWidth: 1, borderColor: themeColors.border }}
                    onPress={() => {
                      if (!unloggedPrompt) return;
                      const chosen: Record<string, boolean> = {};
                      for (const it of unloggedPrompt.items) chosen[it.mealType] = false;
                      setUnloggedPrompt({ ...unloggedPrompt, chosen });
                    }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: themeColors.textSecondary }}>Skip all</Text>
                  </TouchableOpacity>
                </View>

                {unloggedPrompt.items.map(it => {
                  const ate = !!unloggedPrompt.chosen[it.mealType];
                  return (
                    <View
                      key={it.mealType}
                      style={{
                        padding: 12, marginBottom: 10,
                        backgroundColor: themeColors.surfaceRaised, borderRadius: 12,
                        borderWidth: 1, borderColor: ate ? themeColors.primary + '77' : themeColors.border,
                      }}>
                      <TouchableOpacity
                        activeOpacity={0.8}
                        onPress={() => {
                          setUnloggedPrompt(prev => prev ? {
                            ...prev,
                            chosen: { ...prev.chosen, [it.mealType]: !ate },
                          } : prev);
                        }}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <View style={{
                          width: 24, height: 24, borderRadius: 12,
                          alignItems: 'center', justifyContent: 'center',
                          borderWidth: 2,
                          borderColor: ate ? themeColors.primary : themeColors.border,
                          backgroundColor: ate ? themeColors.primary : 'transparent',
                        }}>
                          {ate && <Ionicons name="checkmark" size={14} color={themeColors.background} />}
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 14, fontWeight: '600', color: themeColors.textPrimary }}>{it.meal.meal}</Text>
                          <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }}>
                            {Math.round(it.meal.calories ?? 0)} cal · {Math.round(it.meal.protein ?? 0)}g P
                          </Text>
                        </View>
                        <Text style={{ fontSize: 11, fontWeight: '700', color: ate ? themeColors.primary : themeColors.textMuted }}>
                          {ate ? 'ATE' : 'SKIP'}
                        </Text>
                      </TouchableOpacity>
                      {/* Per-item Edit — opens MealEditModal on yesterday's
                          meal so the user can tweak macros/items if they
                          actually ate something different. Dismisses this
                          prompt while editing so the edit modal isn't
                          stacked on top of a darkened backdrop. */}
                      <TouchableOpacity
                        activeOpacity={0.7}
                        onPress={async () => {
                          // Persist dismissal so we don't re-prompt on the
                          // next app-open after the user finishes editing.
                          await AsyncStorage.setItem(`unloggedMealsPromptShown_${unloggedPrompt.date}`, '1').catch(() => {});
                          setUnloggedPrompt(null);
                          setEditingMeal({ dateKey: unloggedPrompt.date, type: it.mealType, meal: it.meal });
                          setActiveTab('meals');
                        }}
                        style={{
                          marginTop: 10, alignSelf: 'flex-start',
                          paddingHorizontal: 10, paddingVertical: 5,
                          borderRadius: 6,
                          backgroundColor: themeColors.surface,
                          borderWidth: 1, borderColor: themeColors.border,
                        }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          <Ionicons name="pencil-outline" size={11} color={themeColors.textSecondary} />
                          <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.textSecondary }}>
                            Edit this meal
                          </Text>
                        </View>
                      </TouchableOpacity>
                    </View>
                  );
                })}

                <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                  <TouchableOpacity
                    style={{ flex: 1, paddingVertical: 13, borderRadius: 12, alignItems: 'center', backgroundColor: themeColors.surfaceRaised, borderWidth: 1, borderColor: themeColors.border }}
                    onPress={async () => {
                      if (unloggedPrompt) {
                        await AsyncStorage.setItem(`unloggedMealsPromptShown_${unloggedPrompt.date}`, '1').catch(() => {});
                      }
                      setUnloggedPrompt(null);
                    }}>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: themeColors.textSecondary }}>Not now</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={{ flex: 2, paddingVertical: 13, borderRadius: 12, alignItems: 'center', backgroundColor: themeColors.primary }}
                    onPress={async () => {
                      const snapshot = unloggedPrompt;
                      if (!snapshot) return;
                      // Mark chosen meals as eaten — reuses handleToggleMeal
                      // which also auto-logs to backend history + snapshots
                      // the meal for survival across plan regen.
                      for (const it of snapshot.items) {
                        if (snapshot.chosen[it.mealType]) {
                          await handleToggleMeal(snapshot.date, it.mealType);
                        }
                      }
                      await AsyncStorage.setItem(`unloggedMealsPromptShown_${snapshot.date}`, '1').catch(() => {});
                      setUnloggedPrompt(null);
                    }}>
                    <Text style={{ fontSize: 14, fontWeight: '800', color: themeColors.background }}>Save</Text>
                  </TouchableOpacity>
                </View>
                </>)}
              </ScrollView>
            </View>
          )}
        </View>
      </Modal>

      {/* Grocery list modal */}
      <GroceryListModal
        visible={showGroceryList}
        onClose={() => setShowGroceryList(false)}
        plansByDate={nutritionPlansByDate}
        themeName={userProfile.themePreference}
      />

      {/* Friends — friend list, requests, weekly digest. */}
      <FriendsModal
        visible={showFriends}
        authToken={authToken}
        onClose={() => {
          setShowFriends(false);
          if (authToken) {
            (async () => {
              try {
                const { listFriends } = await import('../services/api');
                const list = await listFriends(authToken);
                setFriendCount(list.friends.length);
                setPendingFriendCount(list.pending.filter(p => p.direction === 'incoming').length);
              } catch { /* silent */ }
            })();
          }
        }}
        themeName={userProfile.themePreference}
      />

      {/* Goal editor — opened from Profile tab row */}
      <Modal visible={showGoalEditor} animationType="slide" onRequestClose={() => setShowGoalEditor(false)}>
        <View style={{ flex: 1, backgroundColor: themeColors.background, paddingTop: insets.top }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12 }}>
            <TouchableOpacity onPress={() => setShowGoalEditor(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={24} color={themeColors.textPrimary} />
            </TouchableOpacity>
            <Text style={{ fontSize: 18, fontWeight: '700', color: themeColors.textPrimary }}>Edit Goal</Text>
          </View>
          <EditProfileScreen
            authToken={authToken}
            profile={userProfile}
            mode="goal"
            noHeader
            onSave={(updated) => {
              onSaveProfile?.(updated, 'goal');
              setShowGoalEditor(false);
            }}
            onCancel={() => setShowGoalEditor(false)}
            onRoutinesChanged={() => {}}
          />
        </View>
      </Modal>

      {/* Share workout to social feed */}
      <ShareWorkoutModal
        visible={!!shareWorkoutData}
        authToken={authToken}
        onClose={() => { setShareWorkoutData(null); if (activeTab === 'friends') getSocialFeed(authToken).then(r => setFeedItems(r.items)).catch(() => {}); }}
        themeName={userProfile.themePreference}
        workoutSummary={shareWorkoutData}
      />

      {/* Weekly check-in — auto-popup every 7 days */}
      <Modal visible={showWeeklyCheckin} transparent animationType="slide" onRequestClose={() => setShowWeeklyCheckin(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: themeColors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderTopWidth: 1, borderTopColor: themeColors.border, maxHeight: '90%' }}>
          <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
            <Text style={{ fontSize: 20, fontWeight: '700', color: themeColors.textPrimary, marginBottom: 4 }}>Weekly Review</Text>
            <Text style={{ fontSize: 13, color: themeColors.textSecondary, marginBottom: 20 }}>
              Rate how this week went. The AI will use your feedback to generate next week's plan.
            </Text>

            <Text style={{ fontSize: 14, fontWeight: '600', color: themeColors.textPrimary, marginBottom: 8 }}>Workout adherence</Text>
            <Text style={{ fontSize: 12, color: themeColors.textSecondary, marginBottom: 8 }}>How many planned workouts did you complete?</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 20 }}>
              {[1,2,3,4,5].map(v => (
                <TouchableOpacity key={v} onPress={() => setCheckinAdherence(v)}
                  style={{ flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', backgroundColor: checkinAdherence === v ? themeColors.primary : themeColors.surfaceRaised, borderWidth: 1, borderColor: checkinAdherence === v ? themeColors.primary : themeColors.border }}>
                  <Text style={{ fontWeight: '700', color: checkinAdherence === v ? '#fff' : themeColors.textSecondary }}>{v}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: -16, marginBottom: 20 }}>
              <Text style={{ fontSize: 11, color: themeColors.textMuted }}>None</Text>
              <Text style={{ fontSize: 11, color: themeColors.textMuted }}>All of them</Text>
            </View>

            <Text style={{ fontSize: 14, fontWeight: '600', color: themeColors.textPrimary, marginBottom: 8 }}>Energy & recovery</Text>
            <Text style={{ fontSize: 12, color: themeColors.textSecondary, marginBottom: 8 }}>How did your body feel this week overall?</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 20 }}>
              {['Burned out','Tired','OK','Good','Great'].map((label, i) => (
                <TouchableOpacity key={i} onPress={() => setCheckinEnergy(i + 1)}
                  style={{ flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', backgroundColor: checkinEnergy === i + 1 ? themeColors.primary : themeColors.surfaceRaised, borderWidth: 1, borderColor: checkinEnergy === i + 1 ? themeColors.primary : themeColors.border }}>
                  <Text style={{ fontSize: 10, fontWeight: '700', color: checkinEnergy === i + 1 ? '#fff' : themeColors.textSecondary, textAlign: 'center' }}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Injury log review */}
            {(userProfile?.injuryEntries ?? []).filter(i => i.status !== 'resolved').length > 0 && (
              <View style={{ marginBottom: 20 }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: themeColors.textPrimary, marginBottom: 4 }}>Injury log</Text>
                <Text style={{ fontSize: 12, color: themeColors.textSecondary, marginBottom: 10 }}>Update the status of any injuries flagged this week.</Text>
                {(userProfile?.injuryEntries ?? []).filter(i => i.status !== 'resolved').map(inj => {
                  const currentStatus = checkinInjuryStatuses[inj.id] ?? inj.status;
                  const statusColors: Record<string, string> = { active: '#ef4444', recovering: '#f59e0b', resolved: '#22c55e' };
                  return (
                    <View key={inj.id} style={{ backgroundColor: themeColors.surfaceRaised, borderRadius: 10, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: themeColors.border }}>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: themeColors.textPrimary, marginBottom: 2 }}>{inj.bodyPart}</Text>
                      <Text style={{ fontSize: 12, color: themeColors.textSecondary, marginBottom: 8 }} numberOfLines={2}>{inj.description}</Text>
                      <Text style={{ fontSize: 11, color: themeColors.textMuted, marginBottom: 6 }}>Logged {new Date(inj.reportedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</Text>
                      <View style={{ flexDirection: 'row', gap: 6 }}>
                        {(['active', 'recovering', 'resolved'] as InjuryEntry['status'][]).map(s => (
                          <TouchableOpacity key={s} onPress={() => setCheckinInjuryStatuses(prev => ({ ...prev, [inj.id]: s }))}
                            style={{ flex: 1, paddingVertical: 6, borderRadius: 8, alignItems: 'center',
                              backgroundColor: currentStatus === s ? statusColors[s] : themeColors.surface,
                              borderWidth: 1, borderColor: currentStatus === s ? statusColors[s] : themeColors.border }}>
                            <Text style={{ fontSize: 11, fontWeight: '600', color: currentStatus === s ? '#fff' : themeColors.textMuted, textTransform: 'capitalize' }}>{s}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}

            <Text style={{ fontSize: 14, fontWeight: '600', color: themeColors.textPrimary, marginBottom: 8 }}>Anything to flag? (optional)</Text>
            <TextInput
              value={checkinNotes}
              onChangeText={setCheckinNotes}
              placeholder="Injuries, schedule changes, too easy/hard..."
              placeholderTextColor={themeColors.textMuted}
              multiline
              style={{ borderWidth: 1, borderColor: themeColors.border, borderRadius: 10, padding: 12, color: themeColors.textPrimary, backgroundColor: themeColors.surfaceRaised, minHeight: 64, marginBottom: 20, fontSize: 13 }}
            />

            <TouchableOpacity
              style={{ backgroundColor: themeColors.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginBottom: 10 }}
              onPress={async () => {
                setShowWeeklyCheckin(false);
                await AsyncStorage.setItem('weekStartDate', new Date().toISOString());
                // Save any injury status changes made during check-in
                if (Object.keys(checkinInjuryStatuses).length > 0) {
                  try {
                    const profileRaw = await AsyncStorage.getItem('userProfile');
                    if (profileRaw) {
                      const p: UserProfile = JSON.parse(profileRaw);
                      const updated = (p.injuryEntries ?? []).map(inj =>
                        checkinInjuryStatuses[inj.id] !== undefined
                          ? { ...inj, status: checkinInjuryStatuses[inj.id], statusUpdatedAt: new Date().toISOString() }
                          : inj
                      );
                      await AsyncStorage.setItem('userProfile', JSON.stringify({ ...p, injuryEntries: updated }));
                    }
                  } catch {}
                }
                // Gather pending profile changes
                let pendingChanges: any[] = [];
                try {
                  const pendingRaw = await AsyncStorage.getItem('pendingProfileChanges');
                  pendingChanges = pendingRaw ? JSON.parse(pendingRaw) : [];
                } catch {}

                // Send the weekly review to AI for next week's plan
                if (onWeeklyRefresh) {
                  onWeeklyRefresh({
                    adherence: checkinAdherence,
                    energy: checkinEnergy,
                    notes: checkinNotes || undefined,
                    pendingChanges: pendingChanges.length > 0 ? pendingChanges : undefined,
                  });
                }

                setCheckinAdherence(3);
                setCheckinEnergy(3);
                setCheckinNotes('');
                setCheckinInjuryStatuses({});
              }}>
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>Generate next week's plan</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => { setShowWeeklyCheckin(false); setCheckinAdherence(3); setCheckinEnergy(3); setCheckinNotes(''); setCheckinInjuryStatuses({}); }}
              style={{ alignItems: 'center', paddingVertical: 10 }}>
              <Text style={{ color: themeColors.textMuted, fontWeight: '600', fontSize: 14 }}>Skip — keep current plan</Text>
            </TouchableOpacity>
          </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Supplement Library Modal */}
      <Modal visible={showSupplementLibrary} transparent animationType="slide" onRequestClose={() => {
        if (selectedSupplement) { setSelectedSupplement(null); return; }
        setShowSupplementLibrary(false);
      }}>
        <View style={styles.libraryBackdrop}>
          <View style={[styles.librarySheet, { backgroundColor: themeColors.surface, borderTopColor: themeColors.border }]}>
            <View style={styles.libraryHeader}>
              <Text style={[styles.libraryTitle, { color: themeColors.textPrimary }]}>
                {selectedSupplement ? selectedSupplement.name : 'Supplement Library'}
              </Text>
              <TouchableOpacity onPress={() => {
                if (selectedSupplement) { setSelectedSupplement(null); return; }
                setShowSupplementLibrary(false);
              }}>
                <Text style={[styles.libraryClose, { color: themeColors.primary }]}>
                  {selectedSupplement ? '← Back' : 'Close'}
                </Text>
              </TouchableOpacity>
            </View>

            {selectedSupplement ? (
              <ScrollView contentContainerStyle={styles.detailContent}>
                {/* Top card */}
                <View style={[styles.detailTopCard, { backgroundColor: mealPalette.soft, borderColor: mealPalette.strong + '40' }]}>
                  <Text style={{ fontSize: 36, textAlign: 'center', marginBottom: 8 }}>{selectedSupplement.icon}</Text>
                  <Text style={[styles.detailMeta, { color: mealPalette.text, fontWeight: '700' }]}>{selectedSupplement.category.toUpperCase()}</Text>
                  <Text style={[{ fontSize: 14, color: mealPalette.text, textAlign: 'center', marginTop: 4, lineHeight: 20 }]}>{selectedSupplement.tagline}</Text>
                  <View style={{ flexDirection: 'row', justifyContent: 'center', marginTop: 10, gap: 8, alignItems: 'center' }}>
                    <View style={{
                      paddingHorizontal: 12, paddingVertical: 5, borderRadius: radius.full,
                      backgroundColor: selectedSupplement.evidence === 'strong' ? '#00C48820' : selectedSupplement.evidence === 'moderate' ? '#FFB30020' : '#FF555520',
                      borderWidth: 1,
                      borderColor: selectedSupplement.evidence === 'strong' ? '#00C488' : selectedSupplement.evidence === 'moderate' ? '#FFB300' : '#FF5555',
                    }}>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: selectedSupplement.evidence === 'strong' ? '#00C488' : selectedSupplement.evidence === 'moderate' ? '#FFB300' : '#FF5555' }}>
                        {selectedSupplement.evidence === 'strong' ? '✓ Well-studied' : selectedSupplement.evidence === 'moderate' ? '◑ Some evidence' : '⚠ Early research'}
                      </Text>
                    </View>
                    <Text style={{ fontSize: 11, color: mealPalette.text + '99' }}>
                      {selectedSupplement.evidence === 'strong' ? 'Multiple strong clinical trials' : selectedSupplement.evidence === 'moderate' ? 'Promising, more research needed' : 'Limited or mixed results'}
                    </Text>
                  </View>
                </View>

                <View style={styles.detailSection}>
                  <Text style={[styles.detailSectionTitle, { color: themeColors.textPrimary }]}>What It Does</Text>
                  <Text style={[styles.detailSectionText, { color: themeColors.textSecondary }]}>{selectedSupplement.whatItDoes}</Text>
                </View>

                <View style={[styles.detailPhaseBlock, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]}>
                  <View style={styles.detailPhaseRow}>
                    <Text style={[styles.detailPhaseBadgeLabel, { color: themeColors.textSecondary, width: 70 }]}>DOSE</Text>
                    <Text style={[styles.detailPhaseText, { color: themeColors.textPrimary, fontWeight: '600' }]}>{selectedSupplement.dose}</Text>
                  </View>
                  <View style={[styles.detailPhaseDivider, { backgroundColor: themeColors.border }]} />
                  <View style={styles.detailPhaseRow}>
                    <Text style={[styles.detailPhaseBadgeLabel, { color: themeColors.textSecondary, width: 70 }]}>TIMING</Text>
                    <Text style={[styles.detailPhaseText, { color: themeColors.textPrimary }]}>{selectedSupplement.timing}</Text>
                  </View>
                </View>

                <View style={styles.detailSection}>
                  <Text style={[styles.detailSectionTitle, { color: themeColors.textPrimary }]}>Best For</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                    {selectedSupplement.goodFor.map(g => (
                      <View key={g} style={[{ backgroundColor: mealPalette.strong + '22', borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 4 }]}>
                        <Text style={{ fontSize: 12, color: mealPalette.strong, fontWeight: '600' }}>{g}</Text>
                      </View>
                    ))}
                  </View>
                </View>

                <View style={styles.detailSection}>
                  <Text style={[styles.detailSectionTitle, { color: themeColors.error ?? '#FF4444' }]}>Cautions</Text>
                  <Text style={[styles.detailSectionText, { color: themeColors.textSecondary }]}>{selectedSupplement.cautions}</Text>
                </View>

                {/* Add to My Supplements */}
                {(() => {
                  const alreadyAdded = (userProfile?.supplementsAvailable ?? []).includes(selectedSupplement.name);
                  return (
                    <TouchableOpacity
                      style={{
                        backgroundColor: alreadyAdded ? themeColors.surfaceRaised : themeColors.primary,
                        borderRadius: radius.md, paddingVertical: 14, alignItems: 'center',
                        borderWidth: alreadyAdded ? 1 : 0, borderColor: themeColors.border,
                      }}
                      disabled={alreadyAdded}
                      onPress={() => {
                        handleAddSupplement(selectedSupplement.name);
                        Alert.alert('Added', `${selectedSupplement.name} added to My Supplements.`);
                      }}>
                      <Text style={{ color: alreadyAdded ? themeColors.textMuted : '#fff', fontWeight: '700', fontSize: 15 }}>
                        {alreadyAdded ? '✓ In My Supplements' : '+ Add to My Supplements'}
                      </Text>
                    </TouchableOpacity>
                  );
                })()}
              </ScrollView>
            ) : (
              <>
                {/* AI search — text + photo */}
                <View style={{ paddingHorizontal: 16, marginBottom: 6, gap: 6 }}>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <SearchInput
                      containerStyle={{ flex: 1 }}
                      style={[styles.libSearch, { marginHorizontal: 0, marginBottom: 0, backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border, color: themeColors.textPrimary }]}
                      value={suppAiQuery}
                      onChangeText={(t) => { setSuppAiQuery(t); setSuppAiResult(null); setSuppAiNotFound(false); }}
                      placeholder="Search any supplement with AI…"
                      placeholderTextColor={themeColors.textMuted}
                      returnKeyType="search"
                      onSubmitEditing={handleSuppAiSearch}
                    />
                    <TouchableOpacity
                      style={{ backgroundColor: themeColors.primary, borderRadius: radius.md, paddingHorizontal: 13, justifyContent: 'center' }}
                      onPress={handleSuppAiSearch}
                      disabled={suppAiLoading}>
                      <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>
                        {suppAiLoading ? '…' : '→'}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={{ backgroundColor: themeColors.surfaceRaised, borderRadius: radius.md, paddingHorizontal: 13, justifyContent: 'center', borderWidth: 1, borderColor: themeColors.border }}
                      onPress={handleSuppPhotoSearch}
                      disabled={suppAiLoading}>
                      <Ionicons name="camera-outline" size={20} color={themeColors.textSecondary} />
                    </TouchableOpacity>
                  </View>
                  <Text style={{ fontSize: 11, color: themeColors.textMuted }}>Type a name or take a photo of any supplement label</Text>
                </View>

                {/* AI result */}
                {suppAiNotFound && (
                  <View style={{ marginHorizontal: 16, marginBottom: 10, padding: 12, backgroundColor: themeColors.surfaceRaised, borderRadius: radius.md, borderWidth: 1, borderColor: themeColors.border }}>
                    <Text style={{ fontSize: 13, color: themeColors.textMuted, textAlign: 'center' }}>
                      Could not identify "{suppAiQuery}" as a supplement. Try a different name or photo.
                    </Text>
                  </View>
                )}
                {suppAiResult && (
                  <View style={{ marginHorizontal: 16, marginBottom: 12, backgroundColor: themeColors.surfaceRaised, borderRadius: radius.md, borderWidth: 1, borderColor: themeColors.border, padding: 14, gap: 10 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                      <Ionicons name="medkit-outline" size={28} color={themeColors.primary} />
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 16, fontWeight: '700', color: themeColors.textPrimary }}>{suppAiResult.name}</Text>
                        <Text style={{ fontSize: 12, color: themeColors.textSecondary, marginTop: 2, lineHeight: 17 }}>{suppAiResult.tagline}</Text>
                      </View>
                    </View>
                    {/* Evidence badge */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <View style={{
                        paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.full,
                        backgroundColor: suppAiResult.evidence === 'strong' ? '#00C48820' : suppAiResult.evidence === 'moderate' ? '#FFB30020' : '#FF555520',
                        borderWidth: 1,
                        borderColor: suppAiResult.evidence === 'strong' ? '#00C488' : suppAiResult.evidence === 'moderate' ? '#FFB300' : '#FF5555',
                      }}>
                        <Text style={{ fontSize: 11, fontWeight: '700', color: suppAiResult.evidence === 'strong' ? '#00C488' : suppAiResult.evidence === 'moderate' ? '#FFB300' : '#FF5555' }}>
                          {suppAiResult.evidence === 'strong' ? '✓ Well-studied' : suppAiResult.evidence === 'moderate' ? '◑ Some evidence' : '⚠ Early research'}
                        </Text>
                      </View>
                      <Text style={{ fontSize: 11, color: themeColors.textMuted }}>
                        {suppAiResult.evidence === 'strong' ? 'Multiple strong clinical trials' : suppAiResult.evidence === 'moderate' ? 'Promising but more research needed' : 'Limited or mixed study results'}
                      </Text>
                    </View>
                    <Text style={{ fontSize: 13, color: themeColors.textSecondary, lineHeight: 19 }}>{suppAiResult.whatItDoes}</Text>
                    <View style={{ flexDirection: 'row', gap: 12 }}>
                      <Text style={{ fontSize: 12, color: themeColors.textMuted }}>📏 <Text style={{ color: themeColors.textPrimary, fontWeight: '600' }}>{suppAiResult.dose}</Text></Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <Ionicons name="time-outline" size={12} color={themeColors.textMuted} />
                        <Text style={{ fontSize: 12, color: themeColors.textPrimary, fontWeight: '600' }}>{suppAiResult.timing}</Text>
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <TouchableOpacity
                        style={{ flex: 1, backgroundColor: themeColors.primary, borderRadius: radius.md, paddingVertical: 11, alignItems: 'center' }}
                        onPress={() => {
                          handleAddSupplement(suppAiResult.name);
                          setSuppAiResult(null);
                          setSuppAiQuery('');
                          Alert.alert('Added', `${suppAiResult.name} added to My Supplements.`);
                        }}>
                        <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>+ Add to My Supplements</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={{ backgroundColor: themeColors.surfaceRaised, borderRadius: radius.md, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: themeColors.border }}
                        onPress={() => setSelectedSupplement(suppAiResult)}>
                        <Text style={{ fontSize: 12, color: themeColors.textSecondary, fontWeight: '600' }}>Full Info</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}

                {/* Divider + built-in library */}
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, marginBottom: 10, gap: 10 }}>
                  <View style={{ flex: 1, height: 1, backgroundColor: themeColors.border }} />
                  <Text style={{ fontSize: 11, color: themeColors.textMuted, fontWeight: '600' }}>BUILT-IN LIBRARY</Text>
                  <View style={{ flex: 1, height: 1, backgroundColor: themeColors.border }} />
                </View>
                <TextInput
                  style={[styles.libSearch, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border, color: themeColors.textPrimary }]}
                  value={suppLibSearch}
                  onChangeText={setSuppLibSearch}
                  placeholder="Filter library…"
                  placeholderTextColor={themeColors.textMuted}
                />
                {/* Category filter chips */}
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={{ marginBottom: 6 }}
                  contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 4, gap: 6 }}>
                  {[
                    { key: 'all', label: 'All', icon: 'apps-outline' as const },
                    { key: 'Protein', label: 'Protein', icon: 'nutrition-outline' as const },
                    { key: 'Performance', label: 'Performance', icon: 'flash-outline' as const },
                    { key: 'Recovery', label: 'Recovery', icon: 'fitness-outline' as const },
                    { key: 'Health', label: 'Health', icon: 'heart-outline' as const },
                    { key: 'Weight Management', label: 'Weight', icon: 'flame-outline' as const },
                    { key: 'Sleep & Stress', label: 'Sleep', icon: 'moon-outline' as const },
                  ].map(({ key, label, icon }) => (
                    <TouchableOpacity
                      key={key}
                      style={{
                        paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.full,
                        borderWidth: 1,
                        borderColor: suppLibCategory === key ? themeColors.primary : themeColors.border,
                        backgroundColor: suppLibCategory === key ? themeColors.primary + '22' : themeColors.surfaceRaised,
                      }}
                      onPress={() => setSuppLibCategory(key)}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <Ionicons name={icon} size={13} color={suppLibCategory === key ? themeColors.primary : themeColors.textMuted} />
                        <Text style={{ fontSize: 12, fontWeight: '600', color: suppLibCategory === key ? themeColors.primary : themeColors.textMuted }}>
                          {label}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
                {/* Evidence legend */}
                <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 16, marginBottom: 8 }}>
                  {[['#00C488', '✓ Well-studied'], ['#FFB300', '◑ Some evidence'], ['#FF5555', '⚠ Early research']].map(([color, label]) => (
                    <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Text style={{ fontSize: 11, color, fontWeight: '700' }}>{label.split(' ')[0]}</Text>
                      <Text style={{ fontSize: 10, color: themeColors.textMuted }}>{label.split(' ').slice(1).join(' ')}</Text>
                    </View>
                  ))}
                </View>
                <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
                  {SUPPLEMENT_LIBRARY
                    .filter(s => {
                      const q = suppLibSearch.toLowerCase();
                      const matchSearch = !q || s.name.toLowerCase().includes(q) || s.tagline.toLowerCase().includes(q) || s.category.toLowerCase().includes(q);
                      const matchCat = suppLibCategory === 'all' || s.category === suppLibCategory;
                      return matchSearch && matchCat;
                    })
                    .map(s => (
                      <TouchableOpacity
                        key={s.name}
                        style={[styles.libRow, { borderBottomColor: themeColors.border }]}
                        onPress={() => setSelectedSupplement(s)}>
                        <Text style={{ fontSize: 22, marginRight: 12, width: 32, textAlign: 'center' }}>{s.icon}</Text>
                        <View style={{ flex: 1, gap: 2 }}>
                          <Text style={[styles.libRowName, { color: themeColors.textPrimary }]}>{s.name}</Text>
                          <Text style={[styles.libRowSub, { color: themeColors.textMuted }]} numberOfLines={1}>{s.tagline}</Text>
                        </View>
                        <View style={{ alignItems: 'flex-end', gap: 6 }}>
                          <View style={{
                            paddingHorizontal: 7, paddingVertical: 3, borderRadius: radius.full,
                            backgroundColor: s.evidence === 'strong' ? '#00C48818' : s.evidence === 'moderate' ? '#FFB30018' : '#FF555518',
                          }}>
                            <Text style={{ fontSize: 10, fontWeight: '700', color: s.evidence === 'strong' ? '#00C488' : s.evidence === 'moderate' ? '#FFB300' : '#FF5555' }}>
                              {s.evidence === 'strong' ? '✓ Strong' : s.evidence === 'moderate' ? '◑ Moderate' : '⚠ Limited'}
                            </Text>
                          </View>
                          <Text style={[styles.libRowChevron, { color: themeColors.textMuted }]}>›</Text>
                        </View>
                      </TouchableOpacity>
                    ))}
                </ScrollView>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* Nutritionist note modal */}
      <Modal visible={showNutritionistNote} transparent animationType="slide" onRequestClose={() => setShowNutritionistNote(false)}>
        <View style={styles.noteModalBackdrop}>
          <View style={[styles.noteModalSheet, { backgroundColor: themeColors.surface, borderTopColor: mealPalette.strong + '60' }]}>
            <View style={[styles.sheetHandle, { backgroundColor: themeColors.border }]} />
            <View style={styles.noteModalHeader}>
              <Ionicons name="nutrition" size={28} color={themeColors.primary} style={{ marginRight: 4 }} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.noteModalTitle, { color: themeColors.textPrimary }]}>Nutritionist note</Text>
                <Text style={[styles.noteModalSubtitle, { color: themeColors.textMuted }]}>Why this plan</Text>
              </View>
              <TouchableOpacity onPress={() => setShowNutritionistNote(false)}>
                <Text style={[styles.noteModalClose, { color: mealPalette.strong }]}>Done</Text>
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.noteModalBody}>
              {nutritionistNote ? (
                <Text style={[styles.noteModalText, { color: themeColors.textSecondary }]}>{cleanAiText(nutritionistNote)}</Text>
              ) : (
                <View style={[styles.noteModalEmpty, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]}>
                  <Ionicons name="leaf-outline" size={36} color={themeColors.textMuted} />
                  <Text style={[styles.noteModalEmptyTitle, { color: themeColors.textPrimary }]}>Generate a plan to unlock</Text>
                  <Text style={[styles.noteModalEmptyText, { color: themeColors.textSecondary }]}>
                    Your nutritionist's rationale for your calories + macros lands here.
                  </Text>
                </View>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Trainer note modal */}
      <Modal visible={showTrainerNote} transparent animationType="slide" onRequestClose={() => setShowTrainerNote(false)}>
        <View style={styles.noteModalBackdrop}>
          <View style={[styles.noteModalSheet, { backgroundColor: themeColors.surface, borderTopColor: workoutPalette.strong + '60' }]}>
            <View style={[styles.sheetHandle, { backgroundColor: themeColors.border }]} />
            <View style={styles.noteModalHeader}>
              <Ionicons name="barbell-outline" size={28} color={themeColors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.noteModalTitle, { color: themeColors.textPrimary }]}>Trainer note</Text>
                <Text style={[styles.noteModalSubtitle, { color: themeColors.textMuted }]}>Why this week</Text>
              </View>
              <TouchableOpacity onPress={() => setShowTrainerNote(false)}>
                <Text style={[styles.noteModalClose, { color: workoutPalette.strong }]}>Done</Text>
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.noteModalBody}>
              {trainerNote ? (
                <Text style={[styles.noteModalText, { color: themeColors.textSecondary }]}>{cleanAiText(trainerNote)}</Text>
              ) : (
                <View style={[styles.noteModalEmpty, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]}>
                  <Ionicons name="construct-outline" size={32} color={themeColors.textMuted} />
                  <Text style={[styles.noteModalEmptyTitle, { color: themeColors.textPrimary }]}>Generate a plan to unlock</Text>
                  <Text style={[styles.noteModalEmptyText, { color: themeColors.textSecondary }]}>
                    Your trainer's rationale for the split + exercise picks lands here.
                  </Text>
                </View>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* AI Coach button moved to the header (top right) — see the
          header block above where the hamburger used to live. */}


      <Modal visible={showEmailModal} transparent animationType="slide" onRequestClose={() => setShowEmailModal(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <View style={{ width: '85%', maxWidth: 380, backgroundColor: themeColors.surface, borderRadius: 16, padding: 20 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: themeColors.textPrimary }}>Update Email</Text>
              <TouchableOpacity onPress={() => setShowEmailModal(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={20} color={themeColors.textMuted} />
              </TouchableOpacity>
            </View>
            <Text style={{ fontSize: 12, color: themeColors.textSecondary, marginBottom: 14 }}>
              A valid email keeps your account secure and recoverable.
            </Text>
            <TextInput
              style={{ backgroundColor: themeColors.background, borderRadius: 10, padding: 12, fontSize: 14, color: themeColors.textPrimary, borderWidth: 1, borderColor: themeColors.border, marginBottom: 14 }}
              placeholder="your@email.com"
              placeholderTextColor={themeColors.textMuted}
              value={newEmail}
              onChangeText={setNewEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={handleSaveEmail}
            />
            {emailError ? (
              <Text style={{ fontSize: 12, color: '#EF4444', marginBottom: 10 }}>{emailError}</Text>
            ) : null}
            <TouchableOpacity
              style={{ backgroundColor: themeColors.primary, borderRadius: 10, paddingVertical: 12, alignItems: 'center', opacity: emailSaving ? 0.6 : 1 }}
              onPress={handleSaveEmail}
              disabled={emailSaving}>
              {emailSaving ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff' }}>Save</Text>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Bottom tab bar ────────────────────────────────────────────────
          Five top-level destinations. Each tab simply sets `activeTab`
          and the screen body re-renders the matching content block. */}
      <View style={[styles.bottomBar, { backgroundColor: themeColors.surface, borderTopColor: themeColors.border }]}>
        <BottomTabButton
          label="Social"
          iconName="people-outline"
          active={activeTab === 'friends'}
          tint={themeColors.primary}
          mutedColor={themeColors.textMuted}
          onPress={() => setActiveTab('friends')}
          badge={pendingFriendCount > 0 ? pendingFriendCount : undefined}
        />
        <BottomTabButton
          label="Workouts"
          iconName="barbell-outline"
          active={activeTab === 'workout'}
          tint={workoutPalette.strong}
          mutedColor={themeColors.textMuted}
          onPress={() => setActiveTab('workout')}
        />
        <BottomTabButton
          label="Meals"
          iconName="nutrition-outline"
          active={activeTab === 'meals'}
          tint={mealPalette.strong}
          mutedColor={themeColors.textMuted}
          onPress={() => setActiveTab('meals')}
        />
        <BottomTabButton
          label="Progress"
          iconName="trending-up-outline"
          active={activeTab === 'progress'}
          tint={themeColors.primary}
          mutedColor={themeColors.textMuted}
          onPress={() => setActiveTab('progress')}
        />
        <BottomTabButton
          label="Profile"
          iconName="person-outline"
          active={activeTab === 'profile'}
          tint={themeColors.primary}
          mutedColor={themeColors.textMuted}
          onPress={() => setActiveTab('profile')}
        />
      </View>
    </LinearGradient>
  );
}

// ── SubTabBtn ─────────────────────────────────────────────────────────────────
function SubTabBtn({ label, active, tint, mutedColor, onPress }: {
  label: string;
  active: boolean;
  tint: string;
  mutedColor: string;
  onPress: () => void;
}) {
  // Segmented-control-style tab: rounded pill segment that fills with
  // the accent color when active. Reads as a filter/mode toggle, not
  // a second navigation level stacked on the bottom tab bar.
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
      style={{
        flex: 1,
        paddingVertical: 5,
        paddingHorizontal: 10,
        borderRadius: 7,
        backgroundColor: active ? tint : 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      <Text style={{
        fontSize: 12,
        fontWeight: '600',
        color: active ? '#fff' : mutedColor,
        letterSpacing: 0.1,
      }} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// ── BottomTabButton ───────────────────────────────────────────────────────────
function BottomTabButton({
  label, iconName, active, tint, mutedColor, onPress, badge,
}: {
  label: string;
  iconName: string;
  active: boolean;
  tint: string;
  mutedColor: string;
  onPress: () => void;
  badge?: number;
}) {
  return (
    <TouchableOpacity
      style={btStyles.btn}
      onPress={() => { import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {}); onPress(); }}
      activeOpacity={0.7}
      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
      accessibilityRole="tab"
      accessibilityLabel={`${label} tab`}
      accessibilityState={{ selected: active }}>
      <View style={{ position: 'relative' }}>
        <Ionicons
          name={(active ? iconName.replace('-outline', '') : iconName) as any}
          size={20}
          color={active ? tint : mutedColor}
          style={{ marginBottom: 2, opacity: active ? 1 : 0.7 }}
        />
        {badge != null && badge > 0 && (
          <View style={{ position: 'absolute', top: -4, right: -8, backgroundColor: tint, borderRadius: 999, minWidth: 14, height: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 }}>
            <Text style={{ fontSize: 9, fontWeight: '800', color: '#000' }}>{badge}</Text>
          </View>
        )}
      </View>
      <Text style={[btStyles.label, { color: active ? tint : mutedColor }]} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const btStyles = StyleSheet.create({
  btn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    gap: 2,
  },
  icon:  { fontSize: 18 },
  label: { fontSize: 10, fontWeight: '700', letterSpacing: 0.2 },
});

// ── FocusLabelCrossfade ─────────────────────────────────────────────────────
// Small helper that fades the focus label out, swaps the text mid-fade,
// then fades back in — so changing a day's focus via the Switch Day
// picker doesn't snap to the new label. Pure animation; no logic change.
function FocusLabelCrossfade({ focus, style }: { focus: string; style?: any }) {
  const [displayed, setDisplayed] = useState<string>(focus);
  const opacity = useRef(new Animated.Value(1)).current;
  const prevFocus = useRef<string>(focus);
  useEffect(() => {
    if (prevFocus.current === focus) return;
    prevFocus.current = focus;
    Animated.sequence([
      Animated.timing(opacity, { toValue: 0, duration: 150, useNativeDriver: true }),
      // Swap the label while the text is invisible.
      Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }),
    ]).start();
    const t = setTimeout(() => setDisplayed(focus), 150);
    return () => clearTimeout(t);
  }, [focus, opacity]);
  return (
    <Animated.Text style={[style, { opacity }]}>{displayed}</Animated.Text>
  );
}

// ── DayCard ───────────────────────────────────────────────────────────────────

function DayCard({ item, themeName, isToday, isCompleted, isSkipped, skipReason, completedSummary, expanded, onPress, onStartWorkout, onSkip, onUnskip, onUndoComplete, onChangeFocus, splitOptions, optionWarnings, showSwitchOptions, onToggleSwitch, hasPlateauedExercises, isRegenerating, onSwapExercise, onViewExercise, onOpenExerciseVideo }: {
  item: ScheduleItem;
  themeName?: import('../types').AppThemeName;
  isToday: boolean;
  isCompleted: boolean;
  isSkipped: boolean;
  skipReason?: string;
  completedSummary?: import('../types').StoredWorkoutSummary | null;
  expanded: boolean;
  onPress: () => void;
  onStartWorkout: (workout: WorkoutDay) => void;
  onSkip: (focus: string) => void;
  onUnskip: () => void;
  /** Wipes today's WorkoutCompletion + WorkoutSession + local
   *  history entries so a phantom-done state can be reverted. */
  onUndoComplete?: () => void;
  onChangeFocus?: (newFocus: string) => void;
  splitOptions?: string[];
  optionWarnings?: Record<string, { conflict: boolean; readiness: number | null }>;
  showSwitchOptions?: boolean;
  onToggleSwitch?: () => void;
  hasPlateauedExercises?: boolean;
  /** Local "this card is regenerating" flag set by the parent when a
   *  Switch-Day tap fires generateWorkoutDay. Drives a shimmer overlay. */
  isRegenerating?: boolean;
  /** Opens the plan-view swap modal. Parent manages the modal state +
   *  plan persistence. Passes the target workout so the parent can
   *  match-and-mutate by focus + date without a dayIndex lookup. */
  onSwapExercise?: (workout: WorkoutDay, exerciseIndex: number, exerciseName: string) => void;
  /** Navigates to the exercise info page (library sub-tab with
   *  exercise pre-selected). */
  onViewExercise?: (exerciseName: string) => void;
  /** Opens the form-video modal for the given exercise. Wired from
   *  the WorkoutCard thumbnail tap — users can play the YouTube
   *  demo without leaving the plan. */
  onOpenExerciseVideo?: (exerciseName: string) => void;
}) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const workoutPalette = theme.sections.workout;
  const dow     = isToday ? 'Today' : DAY_NAMES[item.date.getDay()];
  const dateStr = `${MONTH_NAMES[item.date.getMonth()]} ${item.date.getDate()}`;

  // Rest day — uses `workoutPalette.strong` so the today highlight
  // matches the rest of the workout tab in whatever theme the user picked.
  // (The meal side uses a hardcoded green instead so the two day cards
  // stay distinct even when a theme's workout/meal palettes are similar.)
  if (item.isRest) {
    return (
      <View style={[styles.dayCard, { backgroundColor: isToday ? tc.surfaceRaised : tc.surface, borderColor: isToday ? workoutPalette.strong + '88' : tc.border }]}>
        {isToday && <View style={[styles.dayCardTopAccent, { backgroundColor: workoutPalette.strong }]} />}
        <View style={[styles.dayCardRow, { paddingTop: isToday ? 0 : 14 }]}>
          <View style={styles.dayCardLeft}>
            <Text style={[styles.dayCardDow, { color: isToday ? workoutPalette.strong : tc.textSecondary }]}>{dow}</Text>
            <Text style={[styles.dayCardDate, { color: tc.textMuted }]}>{dateStr}</Text>
          </View>
          <View style={[styles.restBadge, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}>
            <Text style={[styles.restBadgeText, { color: tc.textSecondary }]}>Rest Day</Text>
          </View>
        </View>
        <Text style={[styles.restHint, { color: tc.textMuted }]}>Recovery & light stretching</Text>
      </View>
    );
  }

  // Skipped day
  if (isSkipped) {
    return (
      <View style={[styles.dayCard, styles.dayCardSkipped, { backgroundColor: tc.surface, borderColor: tc.border }]}>
        <View style={[styles.dayCardRow, { paddingTop: 14 }]}>
          <View style={styles.dayCardLeft}>
            <Text style={[styles.dayCardDow, { color: tc.textSecondary }]}>{dow}</Text>
            <Text style={[styles.dayCardDate, { color: tc.textMuted }]}>{dateStr}</Text>
          </View>
          <View style={styles.dayCardRight}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={[styles.focusLabel, { color: tc.textPrimary }]}>{item.workout!.focus}</Text>
              {(() => {
                const stim = item.workout?.stimulus || (() => {
                  // Infer stimulus from focus name for old cached plans
                  // that don't have the stimulus field yet.
                  const f = (item.workout?.focus ?? '').toLowerCase();
                  if (f.includes('heavy') || f.includes('strength')) return 'strength';
                  if (f.includes('volume')) return 'volume';
                  if (f.includes('power')) return 'power';
                  if (f.includes('cardio') || f.includes('zone') || f.includes('interval')) return 'conditioning';
                  if (f.includes('mobility') || f.includes('stretch') || f.includes('yoga')) return 'mobility';
                  if (f.includes('recovery') || f.includes('easy')) return 'recovery';
                  // Default lifting days to hypertrophy
                  if (f.includes('push') || f.includes('pull') || f.includes('upper') || f.includes('lower') || f.includes('legs') || f.includes('full body') || f.includes('chest') || f.includes('back') || f.includes('arms') || f.includes('shoulders')) return 'hypertrophy';
                  return null;
                })();
                if (!stim || stim === 'conditioning' || stim === 'mobility' || stim === 'recovery') return null;
                const stimLabel = stim === 'strength' ? 'HEAVY' : stim === 'hypertrophy' ? 'HYPERTROPHY' : stim === 'volume' ? 'VOLUME' : stim.toUpperCase();
                const stimColor = stim === 'strength' ? '#EF4444' : stim === 'volume' ? '#8B5CF6' : tc.primary;
                return (
                  <View style={{ backgroundColor: stimColor + '18', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5 }}>
                    <Text style={{ fontSize: 9, fontWeight: '800', color: stimColor, letterSpacing: 0.5 }}>{stimLabel}</Text>
                  </View>
                );
              })()}
            </View>
            {skipReason ? (
              <Text style={[styles.exerciseCount, { color: tc.warning }]} numberOfLines={1}>
                {skipReason}
              </Text>
            ) : null}
          </View>
          <View style={[styles.skippedBadge, { backgroundColor: tc.warning + '22', borderColor: tc.warning }]}>
            <Text style={[styles.skippedBadgeText, { color: tc.warning }]}>Skipped</Text>
          </View>
        </View>
        <View style={styles.actionRow}>
          <TouchableOpacity style={[styles.unskipBtn, { backgroundColor: tc.surface, borderColor: tc.primary }]} onPress={onUnskip}>
            <Text style={[styles.unskipBtnText, { color: tc.primary }]}>Unskip Workout</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Today AND completed both highlight in the workout palette so the
  // entire workout tab uses one consistent accent color. The "Done" state
  // is communicated by the green ✓ Done badge inside the card, not by
  // the card border itself — that way users in any theme see their
  // workout color light up regardless of whether the day is finished.
  const accentColor = workoutPalette.strong;
  const borderColor = (isToday || isCompleted) ? workoutPalette.strong + '88' : tc.border;

  return (
    <TouchableOpacity
      style={[
        styles.dayCard,
        { backgroundColor: isToday ? tc.surfaceRaised : tc.surface, borderColor },
      ]}
      onPress={onPress}
      activeOpacity={0.8}
      disabled={isRegenerating}>
      {(isToday || isCompleted) && (
        <View style={[styles.dayCardTopAccent, { backgroundColor: accentColor }]} />
      )}
      {/* Regen overlay while the deterministic planner swaps this day's
          exercises. Translucent so the card structure stays visible. */}
      {isRegenerating && (
        <View style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: tc.surface + 'CC',
          borderRadius: 14,
          alignItems: 'center', justifyContent: 'center',
          zIndex: 10,
        }}>
          <ActivityIndicator size="small" color={accentColor} />
          <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, marginTop: 8, letterSpacing: 0.8 }}>
            REGENERATING
          </Text>
        </View>
      )}
      <View style={[styles.dayCardRow, { paddingTop: (isToday || isCompleted) ? 0 : 14 }]}>
        <View style={styles.dayCardLeft}>
          <Text style={[styles.dayCardDow, { color: isToday ? accentColor : tc.textSecondary }]}>{dow}</Text>
          <Text style={[styles.dayCardDate, { color: tc.textMuted }]}>{dateStr}</Text>
        </View>
        <View style={styles.dayCardRight}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <FocusLabelCrossfade focus={item.workout!.focus} style={[styles.focusLabel, { color: tc.textPrimary }]} />
            {(() => {
              const stim = item.workout?.stimulus;
              if (!stim || stim === 'conditioning' || stim === 'mobility' || stim === 'recovery') return null;
              const stimLabel = stim === 'strength' ? 'HEAVY' : stim === 'hypertrophy' ? 'HYPERTROPHY' : stim === 'volume' ? 'VOLUME' : stim.toUpperCase();
              const stimColor = stim === 'strength' ? '#EF4444' : stim === 'volume' ? '#8B5CF6' : accentColor;
              return (
                <View style={{ backgroundColor: stimColor + '18', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5 }}>
                  <Text style={{ fontSize: 9, fontWeight: '800', color: stimColor, letterSpacing: 0.5 }}>{stimLabel}</Text>
                </View>
              );
            })()}
            {hasPlateauedExercises && !isCompleted && (
              <View style={{ backgroundColor: '#F59E0B18', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5 }}>
                <Text style={{ fontSize: 9, fontWeight: '800', color: '#F59E0B', letterSpacing: 0.3 }}>DELOAD SUGGESTED</Text>
              </View>
            )}
          </View>
          {(() => {
            const focusLower = (item.workout!.focus || '').toLowerCase();
            const countText = `${item.workout!.exercises.length} exercises`;
            // Mobility / recovery / stretch / flow days get a single
            // collapsed label instead of a list of stretched muscles.
            // The stretches target hip/hamstring/chest muscles but the
            // user-facing summary is just "Mobility" or "Recovery".
            if (/mobility|stretch|yoga|flow/.test(focusLower)) {
              return (
                <Text style={[styles.exerciseCount, { color: tc.textMuted }]} numberOfLines={1}>
                  {countText} · Mobility
                </Text>
              );
            }
            if (/recover|rest/.test(focusLower)) {
              return (
                <Text style={[styles.exerciseCount, { color: tc.textMuted }]} numberOfLines={1}>
                  {countText} · Recovery
                </Text>
              );
            }
            if (/cardio|zone.?2|interval/.test(focusLower)) {
              return (
                <Text style={[styles.exerciseCount, { color: tc.textMuted }]} numberOfLines={1}>
                  {countText} · Cardio
                </Text>
              );
            }
            // Lift days: group by `primary_muscle`. Hard-filter muscles
            // that don't match the day's focus family — so a warm-up row
            // (primary_muscle='back') inside a Push day can't show up
            // as "Back" in the summary. Push day = chest/shoulders/
            // triceps only. Pull = back/biceps. Legs = quads/hams/
            // glutes/calves. Upper = upper family. Full = anything.
            const PRIMARY_TO_LABEL: Record<string, string> = {
              chest: 'Chest', back: 'Back', shoulders: 'Shoulders',
              biceps: 'Arms', triceps: 'Arms',
              quads: 'Legs', hamstrings: 'Legs', calves: 'Legs',
              glutes: 'Glutes', core: 'Core', cardio: 'Cardio',
              full_body: 'Full Body',
            };
            const pushFamily  = new Set(['chest', 'shoulders', 'triceps']);
            const pullFamily  = new Set(['back', 'biceps']);
            const legsFamily  = new Set(['quads', 'hamstrings', 'glutes', 'calves']);
            const upperFamily = new Set([...pushFamily, ...pullFamily]);
            const allowedForFocus: Set<string> | null =
              /push/.test(focusLower) ? pushFamily :
              /pull/.test(focusLower) ? pullFamily :
              /legs|lower/.test(focusLower) ? legsFamily :
              /upper/.test(focusLower) ? upperFamily :
              /chest/.test(focusLower) ? new Set(['chest', 'triceps']) :
              /back/.test(focusLower) ? new Set(['back', 'biceps']) :
              /shoulder/.test(focusLower) ? new Set(['shoulders']) :
              /arms?/.test(focusLower) ? new Set(['biceps', 'triceps']) :
              null; // full body, unknown — allow everything
            const labels: string[] = [];
            for (const ex of item.workout!.exercises) {
              const key = (ex.primary_muscle ?? '').toLowerCase().replace(/\s+/g, '_');
              if (key === 'mobility' || key === 'systemic') continue;
              // Skip warm-ups + accessories whose primary_muscle can be
              // anything (a hip-flexor stretch on a Pull day still has
              // primary_muscle='hamstrings'). Without this, day-card
              // chips drift across families. _slot/_role come from the
              // planner; fall back to slot_role for legacy plans.
              const role = ((ex as any)._role ?? (ex as any).slot_role ?? '').toLowerCase();
              const slot = ((ex as any)._slot ?? '').toLowerCase();
              if (role === 'warmup' || slot.includes('warm')) continue;
              if (allowedForFocus && !allowedForFocus.has(key)) continue;
              const label = PRIMARY_TO_LABEL[key] ?? (ex.primary_muscle ? humanizeToken(ex.primary_muscle) : null);
              if (label && label !== 'Other' && !labels.includes(label)) labels.push(label);
            }
            if (labels.length === 0) {
              for (const ex of item.workout!.exercises) {
                const g = inferGroup(`${item.workout!.focus} ${ex.name}`);
                if (g !== 'Other' && !labels.includes(g)) labels.push(g);
              }
            }
            const muscles = labels.slice(0, 3);
            const muscleText = muscles.length ? ` · ${muscles.join(', ')}` : '';
            return (
              <Text style={[styles.exerciseCount, { color: tc.textMuted }]} numberOfLines={1}>
                {countText}{muscleText}
              </Text>
            );
          })()}
        </View>
        {isCompleted ? (
          <View style={[styles.completeBadge, { backgroundColor: tc.success + '22', borderColor: tc.success }]}>
            <Text style={[styles.completeBadgeText, { color: tc.success }]}>✓ Done</Text>
          </View>
        ) : (
          <Text style={[styles.chevron, { color: tc.textMuted }]}>{expanded ? '▲' : '▼'}</Text>
        )}
      </View>

      <AnimatedCollapsible visible={expanded}>
        <View style={styles.expandedContent}>
          {isCompleted ? (
            <View style={{ gap: 10 }}>
              <View style={[styles.completedBanner, { backgroundColor: tc.success + '1A', borderColor: tc.success }]}>
                <Text style={[styles.completedBannerText, { color: tc.success }]}>Workout completed today!</Text>
              </View>
              {/* Undo affordance for phantom completions — no real
                  history entry, but the day still shows as done. Tap
                  to wipe the WorkoutCompletion + Session rows + local
                  history for today. */}
              {isToday && onUndoComplete && (
                <TouchableOpacity
                  onPress={() => {
                    Alert.alert(
                      'Mark as not done?',
                      'This wipes today\'s completion record. Use this if today shows as done but you didn\'t actually finish a workout.',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Mark not done',
                          style: 'destructive',
                          onPress: () => onUndoComplete(),
                        },
                      ],
                    );
                  }}
                  style={{
                    alignSelf: 'flex-start',
                    paddingHorizontal: 12, paddingVertical: 6,
                    borderRadius: 8,
                    backgroundColor: tc.surfaceRaised,
                    borderWidth: 1, borderColor: tc.border,
                  }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textSecondary }}>
                    Mark as not done
                  </Text>
                </TouchableOpacity>
              )}
              {completedSummary ? (
                <View style={[styles.completedBanner, { backgroundColor: tc.surfaceRaised, borderColor: tc.border, gap: 8, alignItems: 'flex-start' }]}>
                  <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>
                      {completedSummary.totalSets} sets
                    </Text>
                    <Text style={{ fontSize: 13, color: tc.textMuted }}>·</Text>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>
                      {completedSummary.totalReps} reps
                    </Text>
                    {completedSummary.caloriesBurned > 0 && (
                      <>
                        <Text style={{ fontSize: 13, color: tc.textMuted }}>·</Text>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>
                          ~{completedSummary.caloriesBurned} kcal
                        </Text>
                      </>
                    )}
                    {completedSummary.hrAvg && completedSummary.hrAvg > 0 && (
                      <>
                        <Text style={{ fontSize: 13, color: tc.textMuted }}>·</Text>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>
                          {completedSummary.hrAvg} avg bpm
                        </Text>
                      </>
                    )}
                  </View>
                  <Text style={{ fontSize: 13, color: tc.textSecondary, lineHeight: 19 }}>
                    {completedSummary.motivationMessage}
                  </Text>
                  {completedSummary.achievements?.length > 0 && (
                    <View style={{ gap: 3 }}>
                      {completedSummary.achievements.map((a, i) => (
                        <Text key={i} style={{ fontSize: 12, color: tc.success }}>✓ {a}</Text>
                      ))}
                    </View>
                  )}
                </View>
              ) : null}
            </View>
          ) : (
            <>
              {/* Switch Day */}
              {onChangeFocus && splitOptions && splitOptions.length > 1 && !isCompleted && (
                <View style={{ marginBottom: 12 }}>
                  {!showSwitchOptions ? (
                    <TouchableOpacity
                      style={{
                        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                        paddingVertical: 10, borderRadius: 10, borderWidth: 1.5,
                        borderColor: workoutPalette.strong + '55', backgroundColor: tc.surface,
                      }}
                      onPress={onToggleSwitch}>
                      <Ionicons name="swap-horizontal-outline" size={16} color={workoutPalette.strong} />
                      <Text style={{ fontSize: 13, fontWeight: '700', color: workoutPalette.strong }}>Switch Day</Text>
                    </TouchableOpacity>
                  ) : (
                    <View style={{ backgroundColor: tc.surfaceRaised, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: tc.border }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>Switch to:</Text>
                        <TouchableOpacity onPress={onToggleSwitch} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                          <Ionicons name="close-circle" size={20} color={tc.textMuted} />
                        </TouchableOpacity>
                      </View>
                      {/* Readiness dial grid — the circle + score is the
                          hero; the focus label is a small muted caption
                          underneath. Uses a dashed inner ring and
                          transparent background so the tiles don't
                          visually repeat the day card below. */}
                      <Text style={{ fontSize: 10, color: tc.textMuted, marginBottom: 8, fontStyle: 'italic' }}>
                        Numbers show today's readiness for that focus. Higher = fresher.
                      </Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                        {splitOptions.filter(f => f !== item.workout?.focus).map(focus => {
                          const w = optionWarnings?.[focus];
                          const hasConflict = !!w?.conflict;
                          const lowReady = w?.readiness != null && w.readiness < 40;
                          const warned = hasConflict || lowReady;
                          const tier = w?.readiness == null ? tc.textMuted
                            : w.readiness >= 70 ? tc.success
                            : w.readiness >= 40 ? tc.warning
                            : tc.error;
                          const tierLabel = w?.readiness == null ? 'Unknown'
                            : w.readiness >= 70 ? 'Fresh'
                            : w.readiness >= 40 ? 'Moderate'
                            : 'Tired';
                          const warnMsg = hasConflict && lowReady
                            ? 'Back-to-back same family + low readiness'
                            : hasConflict
                              ? 'Same family as a fixed neighbor day'
                              : lowReady
                                ? `Low readiness (${w.readiness}%) — muscles still recovering`
                                : null;
                          const handlePick = () => {
                            const apply = () => { onChangeFocus(focus); };
                            if (warned && warnMsg) {
                              Alert.alert(
                                `Switch to ${focus}?`,
                                warnMsg + '. You can still proceed if you want.',
                                [
                                  { text: 'Cancel', style: 'cancel' },
                                  { text: 'Switch anyway', style: 'destructive', onPress: apply },
                                ],
                              );
                            } else {
                              apply();
                            }
                          };
                          const hasScore = w?.readiness != null;
                          return (
                            <TouchableOpacity
                              key={focus}
                              activeOpacity={0.75}
                              style={{
                                width: '31%',
                                paddingVertical: 12, paddingHorizontal: 4,
                                alignItems: 'center', justifyContent: 'center',
                                // Intentionally NO solid background or
                                // heavy border — the tile reads as a
                                // dial, not a card. This is the key
                                // visual separation from the workout
                                // card that sits directly below.
                                borderRadius: 8,
                                backgroundColor: warned ? tc.warning + '10' : 'transparent',
                              }}
                              onPress={handlePick}>
                              {/* Outer score dial — large, color-coded,
                                  the dominant visual. */}
                              <View style={{
                                width: 56, height: 56, borderRadius: 28,
                                borderWidth: 4, borderColor: tier,
                                alignItems: 'center', justifyContent: 'center',
                                backgroundColor: tc.surface,
                                marginBottom: 8,
                              }}>
                                {hasScore ? (
                                  <>
                                    <Text style={{ fontSize: 18, fontWeight: '900', color: tier, lineHeight: 20 }}>
                                      {w!.readiness}
                                    </Text>
                                    <Text style={{ fontSize: 7, fontWeight: '700', color: tier + 'BB', letterSpacing: 0.4, marginTop: -1 }}>
                                      READY
                                    </Text>
                                  </>
                                ) : (
                                  <Ionicons name="ellipsis-horizontal" size={16} color={tier} />
                                )}
                              </View>
                              {/* Focus label — this is the CHOICE the
                                  user is picking, so it needs to be
                                  legible. Bumped up (14 / 700 / primary)
                                  and placed directly under the dial so
                                  the tile reads "Push — 85 Ready" at a
                                  glance. */}
                              <Text style={{
                                fontSize: 14, fontWeight: '800',
                                color: tc.textPrimary, textAlign: 'center',
                                marginBottom: 2,
                              }} numberOfLines={2}>
                                {focus}
                              </Text>
                              {/* State caption under the focus, in the
                                  tier color — visually subordinate to
                                  the focus name but still color-coded. */}
                              <Text style={{
                                fontSize: 9, fontWeight: '700',
                                color: tier, letterSpacing: 0.5, textTransform: 'uppercase',
                              }}>
                                {tierLabel}
                              </Text>
                              {warned && (
                                <View style={{ position: 'absolute', top: 2, right: 2 }}>
                                  <Ionicons name="warning" size={12} color={tc.warning} />
                                </View>
                              )}
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </View>
                  )}
                </View>
              )}
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
                <PulseView active={isToday && !isCompleted} intensity={0.02} duration={2000} style={{ flex: 2 }}>
                  <PressableScale
                    onPress={() => { import('../utils/feedback').then(f => f.hapticHeavy()).catch(() => {}); onStartWorkout(item.workout!); }}
                    accessibilityRole="button"
                    accessibilityLabel="Start workout">
                    <View style={[styles.startWorkoutBtn, { backgroundColor: workoutPalette.strong }]}>
                      <Ionicons name="play-circle" size={22} color="#fff" />
                      <Text style={styles.startWorkoutBtnText}>Start Workout</Text>
                    </View>
                  </PressableScale>
                </PulseView>
                {isToday && (
                  // Pressable instead of TouchableOpacity so taps are
                  // captured eagerly via onPressIn — fixes the case
                  // where the parent DayCard's expand/collapse
                  // TouchableOpacity stole the responder before this
                  // child could fire. Haptic also fires immediately
                  // so the user gets tactile confirmation even before
                  // the modal opens.
                  <Pressable
                    style={[styles.skipSecondaryBtn, { borderColor: tc.border, backgroundColor: tc.surface }]}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                    onPress={() => {
                      import('../utils/feedback').then(f => f.hapticWarning()).catch(() => {});
                      console.log('[skip] tapped — focus=', item.workout!.focus);
                      onSkip(item.workout!.focus);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Skip today's workout">
                    <Ionicons name="close-circle-outline" size={18} color={tc.textSecondary} />
                    <Text style={[styles.skipSecondaryBtnText, { color: tc.textSecondary }]}>Skip</Text>
                  </Pressable>
                )}
              </View>
              <WorkoutCard
                workout={item.workout!}
                themeName={themeName}
                onSwapExercise={
                  onSwapExercise
                    ? (exIdx, exName) => onSwapExercise(item.workout!, exIdx, exName)
                    : undefined
                }
                onViewExercise={onViewExercise}
                onOpenExerciseVideo={onOpenExerciseVideo}
              />
            </>
          )}
        </View>
      </AnimatedCollapsible>
    </TouchableOpacity>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  checkinCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: radius.lg,
    borderWidth: 1,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
  },
  checkinCardIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primary + '22',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  checkinCardIcon: { fontSize: 22 },
  checkinCardTitle: { fontSize: 15, fontWeight: '700', marginBottom: 2 },
  checkinCardSub: { fontSize: 12 },
  checkinCardChevron: { fontSize: 22, marginLeft: 8, fontWeight: '300' },

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 12, paddingRight: 16, paddingBottom: 10, borderBottomWidth: 1 },
  headerLogoWrap: { height: 70, justifyContent: 'center', alignItems: 'flex-start' },
  headerLogo: { width: 280, height: 70 },
  headerLogoDark: { width: 280, height: 70 },
  greeting:            { fontSize: 26, fontWeight: '700', color: colors.textPrimary, marginBottom: 6 },
  headerBadgeRow:  { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 4 },
  goalBadge:       { backgroundColor: colors.surface, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 4, borderWidth: 1, borderColor: colors.primary },
  goalBadgeText:   { fontSize: 12, color: colors.primary, fontWeight: '600' },
  goalSubText:     { fontSize: 11, color: colors.textSecondary, marginTop: 2 },
  planLoadingOverlay: {
    // Absolute + high zIndex so it covers the header, tabs, and everything
    // else. Previously this was `flex: 1` which made it a regular flex child
    // competing with the ScrollView — old meal/workout content could leak
    // through underneath.
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 1000,
    elevation: 10,
    alignItems: 'center', justifyContent: 'center',
    gap: 16, paddingHorizontal: 40,
  },
  planLoadingTitle:    { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  planLoadingSubtitle: { fontSize: 14, textAlign: 'center', lineHeight: 22, opacity: 0.7 },

  tabPlanLoadingFull: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    gap: 16, paddingHorizontal: 40, paddingTop: 80,
  },

  chatPlanUpdateBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: 1,
  },
  chatPlanUpdateText: { fontSize: 13, fontWeight: '600' },

  // Bottom tab bar — pinned to the screen bottom, sits above safe area.
  // Add ~88px of padding to scrollContent so the last card isn't hidden
  // behind it. Has a solid surface background so the gradient screen
  // body doesn't bleed through.
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    paddingTop: 8,
    paddingBottom: 24,
    paddingHorizontal: 4,
    borderTopWidth: 1,
  },

  // Placeholder content for the goals/progress/profile tabs until they
  // get dedicated dashboards. Simple card with a title, a one-line body,
  // and a single primary action button.
  tabPlaceholderCard: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: 18,
    marginBottom: 12,
    gap: 10,
  },
  tabPlaceholderTitle: { fontSize: 17, fontWeight: '800' },
  tabPlaceholderBody:  { fontSize: 13, lineHeight: 19 },
  tabActionBtn: {
    marginTop: 4,
    paddingVertical: 12,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  tabActionBtnText: { fontSize: 13, fontWeight: '700', color: '#fff' },

  // Fixed sub-tab bar that sits below the app header. `top` is set
  // inline via `insets.top + 72` so it lands cleanly below the gradient
  // header on any device. Same zIndex as bottom nav so sibling overlays
  // stay beneath it.
  fixedSubTabBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    paddingHorizontal: 12,
    zIndex: 6,
  },
  // iOS-style segmented control wrap. Contains the SubTabBtn segments
  // as equal-width flex children and gives them a rounded-pill
  // container. Visually distinct from the bottom nav tabs so users
  // read it as a mode filter, not a second nav level.
  segmentedWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'stretch',
    padding: 3,
    borderRadius: 10,
    borderWidth: 1,
    gap: 2,
  },

  // Next-checkin indicator on the workout Plan sub-tab.
  checkinIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radius.full,
    borderWidth: 1,
    marginBottom: 12,
  },
  checkinDot: { width: 6, height: 6, borderRadius: 3 },
  checkinLabel: { flex: 1, fontSize: 11, fontWeight: '700', letterSpacing: 0.2 },
  checkinDots: { flexDirection: 'row', gap: 3 },
  checkinTick: { width: 4, height: 4, borderRadius: 2 },

  // Inline wrapper for the exercise library — replaces the old Modal
  // portal so the library content lives inside HomeScreen's render tree.
  // `top` is set inline via `insets.top + 72 + 44` so it sits just
  // below the fixed sub-tab bar on any device.
  libraryInlineWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 88,      // above the bottom tab bar
    zIndex: 4,
  },

  // Extra top padding for the workout/meals ScrollView so its content
  // doesn't hide under the fixed sub-tab bar. The bar sits at top:120
  // and is 44px tall, so content starts at 120+44+(~10 gap) - the
  // scrollView's own top edge is at 0 but the ScrollView starts
  // rendering right below the gradient header, so we just need the
  // padding from where the ScrollView begins.
  scrollContentBelowSubTab: {
    paddingHorizontal: 16,
    paddingTop: 78,  // clears the fixed sub-tab bar + a small gap
    paddingBottom: 110,
  },

  // ── Sub-tab bar (Plan / Exercises / Muscles, etc.) ──────────────────────
  subTabBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    marginBottom: 14,
  },

  // ── Ask AI button (header top-right) ────────────────────────────────────
  // Solid filled pill so it stands out against the gradient header.
  askAiBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.full,
  },
  askAiIcon: { width: 16, height: 16 },
  askAiText: { fontSize: 12, fontWeight: '800', letterSpacing: 0.3, color: '#FFFFFF' },

  // ── Compact "Why this plan?" link (replaces full-card explanation) ──────
  planNoteLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.full,
    borderWidth: 1,
    justifyContent: 'center',
  },
  planNoteLinkText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.2 },

  // ── Profile tab ─────────────────────────────────────────────────────────
  profileHero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: 16,
    marginBottom: 14,
  },
  profileAvatar: {
    width: 56, height: 56, borderRadius: 28,
    borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  profileAvatarText: { fontSize: 22, fontWeight: '800' },
  profileHeroName:   { fontSize: 17, fontWeight: '800', textTransform: 'capitalize' },
  profileHeroMeta:   { fontSize: 13, fontWeight: '500' },

  profileStatRow: { flexDirection: 'row', gap: 10, marginBottom: 18 },
  profileStatTile: {
    flex: 1,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingVertical: 14,
    paddingHorizontal: 10,
    alignItems: 'center',
    gap: 4,
  },
  profileStatLabel: { fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  profileStatValue: { fontSize: 22, fontWeight: '800', textTransform: 'capitalize' },
  profileStatSub:   { fontSize: 10, fontWeight: '600' },

  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginBottom: 18,
  },
  profileRowIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileRowTitle: { fontSize: 14, fontWeight: '700' },
  profileRowSub:   { fontSize: 11, marginTop: 2 },

  profileSectionLabel: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  profileThemeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  profileThemeTile: {
    width: '47%',
    borderRadius: radius.md,
    paddingVertical: 14,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  profileThemeSwatch: {
    width: 22,
    height: 22,
    borderRadius: 11,
  },
  profileThemeLabel: { flex: 1, fontSize: 13, fontWeight: '700' },
  profileThemeCheck: { fontSize: 14, fontWeight: '800' },

  // Profile tab — list of menu rows with section dividers.
  profileMenuList: {
    borderRadius: radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
    marginBottom: 14,
  },
  profileMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  profileMenuLabel:   { flex: 1, fontSize: 15, fontWeight: '600' },
  profileMenuChevron: { fontSize: 20, fontWeight: '300' },
  profileMenuDivider: { height: 1, marginLeft: 16 },
  profileSignOutBtn: {
    borderRadius: radius.md,
    borderWidth: 1,
    paddingVertical: 12,
    alignItems: 'center',
  },
  profileSignOutText: { fontSize: 14, fontWeight: '700' },

  fab: {
    position: 'absolute',
    bottom: 96,  // raised above the bottom tab bar
    right: 20,
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 10,
  },
  fabIcon: { width: 62, height: 62 },

  coachModePicker: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginBottom: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: 3,
    gap: 3,
  },
  coachModeBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  coachModeBtnText: { fontSize: 13, fontWeight: '700' },

  menuBtn: { padding: 4, gap: 5, alignItems: 'center', justifyContent: 'center' },
  menuBar: { width: 22, height: 2, backgroundColor: colors.textPrimary, borderRadius: 2 },

  aiBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginBottom: 10, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  aiText:   { fontSize: 12, color: colors.textSecondary, flex: 1 },

  compactNotesRow: { flexDirection: 'row', gap: 8, marginBottom: 12, flexWrap: 'wrap' },
  compactNoteChip: {
    backgroundColor: colors.surface,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  compactNoteText: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },

  insightCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 12,
    marginBottom: 12,
    gap: 8,
  },
  insightTitle: { fontSize: 13, fontWeight: '700', color: colors.textPrimary },
  insightSubtitle: { fontSize: 12, color: colors.textSecondary },
  insightChips: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  insightChip: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.full,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  insightChipText: { fontSize: 12, color: colors.primary, fontWeight: '700' },

  askTrainerBtn: {
    alignSelf: 'flex-start',
    marginBottom: 12,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  askTrainerBtnText: { color: colors.background, fontSize: 13, fontWeight: '700' },

  warmupCard: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 14,
    marginBottom: 12,
    gap: 8,
  },
  warmupTitle: { fontSize: 14, fontWeight: '800' },
  warmupStep: { fontSize: 12, color: colors.textPrimary, lineHeight: 18 },

  tabs:      { flexDirection: 'row', marginHorizontal: 16, marginTop: 14, marginBottom: 14, borderRadius: radius.full, padding: 4, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  tab:       { flex: 1, paddingVertical: 10, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center' },
  tabActive: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.18, shadowRadius: 4, elevation: 3 },
  tabText:   { fontSize: 14, fontWeight: '700', letterSpacing: 0.2 },

  scrollView:    { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 110 },

  dayCard:         { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingBottom: 14, paddingTop: 0, marginBottom: 10, overflow: 'hidden' },
  dayCardTopAccent: { height: 3, marginBottom: 12, borderRadius: 0 },
  dayCardToday:    { borderColor: colors.primary },
  dayCardComplete: { borderColor: colors.success },
  dayCardSkipped:  { opacity: 0.6 },
  dayCardRow:      { flexDirection: 'row', alignItems: 'center' },
  dayCardLeft:     { width: 64 },
  dayCardRight:    { flex: 1 },
  dayCardDow:      { fontSize: 13, fontWeight: '700', color: colors.textSecondary, marginBottom: 2 },
  dayCardDowToday: { color: colors.primary },
  dayCardDate:     { fontSize: 11, color: colors.textMuted },

  focusLabel:    { fontSize: 14, fontWeight: '600', color: colors.textPrimary, marginBottom: 2 },
  exerciseCount: { fontSize: 12, color: colors.textMuted },
  chevron:       { fontSize: 10, color: colors.textMuted, marginLeft: 8 },

  completeBadge:     { backgroundColor: colors.success + '22', borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: colors.success },
  completeBadgeText: { fontSize: 12, color: colors.success, fontWeight: '700' },

  skippedBadge:     { backgroundColor: colors.warning + '22', borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: colors.warning },
  skippedBadgeText: { fontSize: 12, color: colors.warning, fontWeight: '600' },
  skippedHint:      { fontSize: 12, color: colors.textMuted, marginTop: 10 },

  restBadge:     { backgroundColor: colors.surfaceRaised, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 4, borderWidth: 1, borderColor: colors.border },
  restBadgeText: { fontSize: 12, color: colors.textSecondary, fontWeight: '500' },
  restHint:      { fontSize: 12, color: colors.textMuted, marginTop: 8 },

  expandedContent: { marginTop: 12 },

  completedBanner:     { backgroundColor: colors.success + '1A', borderRadius: radius.md, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: colors.success },
  completedBannerText: { fontSize: 14, fontWeight: '700', color: colors.success },

  actionRow:       { flexDirection: 'row', gap: 10, marginTop: 12 },
  skipLink:        { alignSelf: 'center', paddingVertical: 8, paddingHorizontal: 4 },
  skipLinkText:    { fontSize: 12, fontWeight: '400', textDecorationLine: 'underline' },
  skipSecondaryBtn: {
    flex: 1,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderRadius: radius.lg, paddingVertical: 18, borderWidth: 1,
  },
  skipSecondaryBtnText: { fontSize: 14, fontWeight: '700', letterSpacing: 0.2 },
  unskipBtn:       { backgroundColor: colors.surface, borderRadius: radius.md, paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center', borderWidth: 1, borderColor: colors.primary, flex: 1 },
  unskipBtnText:   { color: colors.primary, fontSize: 13, fontWeight: '700' },
  startWorkoutBtn: { backgroundColor: colors.primary, borderRadius: radius.lg, paddingVertical: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, shadowColor: colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4 },
  startWorkoutBtnText: { color: '#FFFFFF', fontSize: 17, fontWeight: '800', letterSpacing: 0.3 },

  exerciseSummaryList:   { gap: 8 },
  exerciseSummaryRow:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  exerciseSummaryName:   { fontSize: 13, color: colors.textPrimary, fontWeight: '500', flex: 1 },
  exerciseSummaryDetail: { fontSize: 12, color: colors.primary, fontWeight: '600' },

  dailyTargetBanner: {
    borderRadius: radius.lg,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 10,
  },
  mealAccordionCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 10,
    overflow: 'hidden',
  },
  mealAccordionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'transparent',
  },
  mealAccordionTitle: { fontSize: 16, fontWeight: '700', color: colors.textPrimary },
  mealAccordionMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 3, fontWeight: '500' },
  mealAccordionChevron: { fontSize: 11, color: colors.textMuted, marginLeft: 8 },

  groceryCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    marginBottom: 10,
  },
  groceryTitle: { fontSize: 13, fontWeight: '700', color: colors.textPrimary, marginBottom: 8 },
  groceryChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  groceryChip: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  groceryChipText: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-start', alignItems: 'flex-end', paddingTop: 90, paddingRight: 16 },
  menuDropdown:   { backgroundColor: colors.surface, borderRadius: radius.xl, minWidth: 220, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  menuHeadingRow: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  menuHeading:    { fontSize: 10, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1.2 },
  menuItem:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 },
  menuItemText:    { flex: 1, fontSize: 15, fontWeight: '500', color: colors.textPrimary },
  menuItemChevron: { fontSize: 18, fontWeight: '300' },
  menuDivider:    { height: 1, backgroundColor: colors.border, marginHorizontal: 0 },

  libraryBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  librarySheet: {
    flex: 1,
    backgroundColor: colors.surface,
    borderTopWidth: 0,
    borderTopColor: colors.border,
    paddingTop: 8,
  },
  libraryHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 10 },
  libraryTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  libraryClose: { fontSize: 14, fontWeight: '700', color: colors.primary },
  libraryList: { paddingHorizontal: 16, paddingBottom: 28 },
  librarySearchInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.background,
    color: colors.textPrimary,
    fontSize: 16,
    marginBottom: 10,
  },
  libraryFilterRow: { gap: 8, paddingTop: 6, paddingBottom: 12 },
  libraryFilterChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  libraryFilterChipActive: { borderColor: colors.primary, backgroundColor: colors.primary + '12' },
  libraryFilterText: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },
  libraryFilterTextActive: { color: colors.primary },
  libraryEmptyText: {
    fontSize: 13,
    color: colors.textMuted,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 12,
    marginTop: 4,
  },
  libraryItem: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 12,
    marginBottom: 8,
  },
  libraryItemName: { fontSize: 14, fontWeight: '700', color: colors.textPrimary, marginBottom: 4 },
  libraryItemMeta: { fontSize: 12, color: colors.primary, marginBottom: 4 },
  libraryItemDesc: { fontSize: 12, color: colors.textSecondary },
  libraryItemLink: { fontSize: 12, color: colors.accent, fontWeight: '700', marginTop: 8 },

  detailSheet: {
    maxHeight: '82%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 14,
  },
  detailContent: { paddingHorizontal: 16, paddingBottom: 28, gap: 10 },
  detailTopCard: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    gap: 4,
  },
  detailMeta: { fontSize: 12, color: colors.textSecondary },
  detailVideoBtn: {
    alignSelf: 'flex-start',
    marginTop: 6,
    backgroundColor: colors.primary + '18',
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.full,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  detailVideoBtnText: { fontSize: 12, color: '#FFFFFF', fontWeight: '700' },
  detailSection: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
  },
  detailSectionTitle: { fontSize: 13, fontWeight: '700', color: colors.textPrimary, marginBottom: 6 },
  detailSectionText: { fontSize: 13, lineHeight: 20, color: colors.textSecondary },
  // Phase breakdown block
  detailPhaseBlock: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: 12,
    gap: 10,
  },
  detailPhaseTitle: { fontSize: 13, fontWeight: '700', marginBottom: 4 },
  detailPhaseRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  detailPhaseBadge: {
    borderRadius: radius.sm,
    paddingHorizontal: 7,
    paddingVertical: 3,
    alignSelf: 'flex-start',
    minWidth: 84,
    alignItems: 'center',
  },
  detailPhaseBadgeLabel: { fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  detailPhaseText: { flex: 1, fontSize: 12, lineHeight: 18 },
  detailPhaseDivider: { height: 1, marginVertical: 2 },
  // Library tabs
  libTabBar: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginBottom: 4,
    borderRadius: radius.md,
    borderWidth: 1,
    overflow: 'hidden',
  },
  libTab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  libTabText: { fontSize: 13, fontWeight: '700' },
  // Muscle list item
  muscleItemRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginBottom: 6 },
  muscleItemEmoji: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  muscleItemBody: { flex: 1, gap: 2 },
  // Shared supplement library styles
  libSearch: {
    marginHorizontal: 16, marginBottom: 8,
    borderWidth: 1, borderRadius: radius.md,
    paddingHorizontal: 12, paddingVertical: 9,
    fontSize: 14,
  },
  libFilterChip: {
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: radius.full, borderWidth: 1,
  },
  libFilterChipText: { fontSize: 12, fontWeight: '600' },
  libRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1,
  },
  libRowName: { fontSize: 14, fontWeight: '700', marginBottom: 2 },
  libRowSub: { fontSize: 12, lineHeight: 17 },
  libRowChevron: { fontSize: 18, fontWeight: '600' },

  trainerFullScreen: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' },
  trainerSheet: {
    height: '85%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 16,
    paddingBottom: 12,
  },
  sheetHandle: { width: 36, height: 4, backgroundColor: colors.border, borderRadius: 2, alignSelf: 'center', marginBottom: 12 },
  trainerHint: {
    fontSize: 12,
    color: colors.textSecondary,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  trainerSummaryCard: {
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
  },
  trainerSummaryTitle: { fontSize: 11, color: colors.textSecondary, fontWeight: '700', marginBottom: 4, textTransform: 'uppercase' },
  trainerSummaryText: { fontSize: 12, color: colors.textPrimary },
  trainerChatList: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 8,
  },
  trainerEmpty: {
    fontSize: 15,
    color: colors.textMuted,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 14,
    lineHeight: 22,
  },
  trainerBubble: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: 14,
  },
  trainerBubbleUser: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
    alignSelf: 'flex-end',
    maxWidth: '90%',
  },
  trainerBubbleAssistant: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    alignSelf: 'flex-start',
    maxWidth: '95%',
  },
  trainerBubbleText: { fontSize: 16, color: colors.textPrimary, lineHeight: 24 },
  attachPreviewRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  attachPreview: { width: 48, height: 48, borderRadius: 8, backgroundColor: colors.border },
  attachRemoveBtn: { padding: 4 },
  attachRemoveText: { fontSize: 13, color: colors.textMuted, fontWeight: '700' },
  attachLabel: { fontSize: 12, color: colors.textSecondary, fontStyle: 'italic' },
  trainerAttachBtn: { paddingHorizontal: 6, paddingBottom: 10, justifyContent: 'flex-end' },
  trainerAttachIcon: { fontSize: 20 },
  trainerInputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 20,
  },
  trainerInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    maxHeight: 140,
    fontSize: 16,
    color: colors.textPrimary,
    backgroundColor: colors.background,
  },
  trainerSendBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    minWidth: 68,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trainerSendText: { color: colors.background, fontSize: 15, fontWeight: '700' },

  // ── Plan note row (trainer / nutritionist explanation) ────────────────────────
  planNoteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
  },
  planNoteIconWrap: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  planNoteIcon: { fontSize: 20 },
  planNoteBody: { flex: 1, gap: 2 },
  planNoteTitle: { fontSize: 13, fontWeight: '800' },
  planNoteSub: { fontSize: 11, lineHeight: 16 },
  planNoteChevron: { fontSize: 22, fontWeight: '300' },

  // ── Supplement stack panel ────────────────────────────────────────────────────
  supplementPanel: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: 14,
    marginBottom: 12,
  },
  supplementPanelHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 },
  supplementPanelChevron: { fontSize: 20, fontWeight: '300' },
  supplementPanelTitle: { fontSize: 14, fontWeight: '800' },
  supplementPanelSubtitle: { fontSize: 11, marginBottom: 10 },
  supplementList: { gap: 8 },
  supplementItem: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: 10,
    gap: 4,
  },
  supplementItemTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  supplementCheck: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  supplementCheckMark: { fontSize: 12, color: '#FFFFFF', fontWeight: '800' },
  supplementName: { flex: 1, fontSize: 13, fontWeight: '700' },
  supplementDose: { fontSize: 12, fontWeight: '600' },
  supplementTiming: { fontSize: 11, marginLeft: 28 },
  supplementPurpose: { fontSize: 11, marginLeft: 28 },

  // ── Coach note modal ──────────────────────────────────────────────────────────
  // ── Skip reason modal ─────────────────────────────────────────────────────────
  skipReasonBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  skipReasonSheet: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    paddingTop: 14,
    paddingHorizontal: 16,
    paddingBottom: 32,
    gap: 14,
  },
  skipReasonTitle: { fontSize: 18, fontWeight: '800', textAlign: 'center' },
  skipReasonFocusLabel: { fontSize: 13, textAlign: 'center', marginTop: -8 },
  skipReasonChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  skipReasonChip: {
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  skipReasonChipText: { fontSize: 13, fontWeight: '600' },
  skipReasonInput: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  skipReasonBtns: { flexDirection: 'row', gap: 10, marginTop: 4 },
  skipReasonCancel: {
    flex: 1,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
  },
  skipReasonCancelText: { fontSize: 14, fontWeight: '600' },
  skipReasonConfirm: {
    flex: 2,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
  },
  skipReasonConfirmText: { fontSize: 14, fontWeight: '800', color: '#FFFFFF' },

  noteModalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  noteModalSheet: {
    maxHeight: '65%',
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 2,
    paddingTop: 14,
    paddingBottom: 28,
  },
  noteModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  noteModalIcon: { fontSize: 26 },
  noteModalTitle: { fontSize: 15, fontWeight: '800' },
  noteModalSubtitle: { fontSize: 11, marginTop: 1 },
  noteModalClose: { fontSize: 14, fontWeight: '700' },
  noteModalBody: { paddingHorizontal: 16, paddingBottom: 16 },
  noteModalText: { fontSize: 14, lineHeight: 22 },
  noteModalEmpty: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: 20,
    alignItems: 'center',
    gap: 8,
  },
  noteModalEmptyIcon: { fontSize: 36 },
  noteModalEmptyTitle: { fontSize: 15, fontWeight: '700' },
  noteModalEmptyText: { fontSize: 13, lineHeight: 20, textAlign: 'center', opacity: 0.8 },
});
