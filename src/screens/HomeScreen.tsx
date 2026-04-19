import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Modal, ActivityIndicator, Alert, TextInput, KeyboardAvoidingView, Platform, Linking, Image, Dimensions, Keyboard, Animated, Switch, LayoutAnimation, UIManager } from 'react-native';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import FadeInView from '../components/FadeInView';
import PulseView from '../components/PulseView';
import PressableScale from '../components/PressableScale';
import LogActivityModal from '../components/LogActivityModal';
import StreakCounter from '../components/StreakCounter';
import { WorkoutDaySkeleton } from '../components/SkeletonLoader';

const { width: SCREEN_W } = Dimensions.get('window');
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import { UserProfile, WorkoutPlan, DailyNutritionPlan, WorkoutDay, WorkoutSession, SupplementItem, InjuryEntry, MealRoutineEntry, MealRoutineFood } from '../types';
import { generateWorkoutPlan, generateDailyNutritionForDate } from '../utils/planGenerator';
import { getWorkoutStatus, getDayState, upsertDayState, getExercises, askTrainerQuestion, lookupSupplement, lookupSupplementFromPhoto, logWorkoutDone, enrichFoodItems, logMealChecked } from '../services/api';
import { useMetaData } from '../hooks/useMetaData';
import {
  isTodayWorkoutDone, todayKey, dateKey, loadWorkoutHistory, saveWorkoutSession, saveSkipToHistory, loadWorkoutSummaries, loadHealthScore,
  savePlanChange, loadMealRoutines, saveMealRoutines, applyRoutines, applyRoutinesToAll,
  loadPreservedCompletedWorkouts,
  savePreservedCompletedWorkout,
} from '../utils/workoutHistory';
import { PRIMARY_GOALS } from '../constants/goalConfig';
import { getMealChecks, saveMealChecks, MealChecks, getSavedNutritionPlan, saveNutritionPlan, getPreservedMeals, savePreservedMeal, clearPreservedMeal, clearPreservedMealBySignature } from '../utils/mealTracker';
import { ensureItems, migrateNutritionPlanShape, normalizeServingUnitsInPlan } from '../utils/mealItems';
import { cleanAiText } from '../utils/aiText';
import { formatWaterTarget } from '../utils/hydration';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MealSuggestion } from '../types';
import WorkoutCard from '../components/WorkoutCard';
import NutritionCard from '../components/NutritionCard';
import MealEditModal from '../components/MealEditModal';
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
  description?: string | null;
  primary_muscle?: string;
  secondary_muscles?: string[];
  equipment?: string;
  is_compound?: boolean;
}

const DAY_NAMES   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

function bgIsDark(hex: string): boolean {
  const h = hex.replace('#', '');
  if (h.length < 6) return true;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) < 0.5;
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
): { items: AvailabilityItem[]; cardioProfile: string | null } {
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

  const cyclingHits = history.filter((s) => /cycle|cycling|bike|spin/i.test(`${s.focus} ${(s.exercises ?? []).map(e => e.name).join(' ')}`)).length;
  const runningHits = history.filter((s) => /run|running|jog|treadmill/i.test(`${s.focus} ${(s.exercises ?? []).map(e => e.name).join(' ')}`)).length;
  const cardioProfile = cyclingHits > 0
    ? `Cyclist profile (${cyclingHits} sessions)`
    : runningHits > 0
      ? `Runner profile (${runningHits} sessions)`
      : null;

  return { items, cardioProfile };
}

// ─────────────────────────────────────────────────────────────────────────────

export default function HomeScreen({ authToken, userProfile, planRefreshKey = 0, isWorkoutUpdating = false, isNutritionUpdating = false, trainerNote: trainerNoteProp = null, nutritionistNote: nutritionistNoteProp = null, supplementStack: supplementStackProp = [], onSignOut, onEditGoal: _onEditGoal, onEditWorkout: _onEditWorkout, onEditMealPlan: _onEditMealPlan, onEditThemes, onStartWorkout, onViewProgress: _onViewProgress, onViewAccount, onProfileUpdate, onBackendSync, onSaveProfile, onWeeklyRefresh, onCancelPlanGen }: HomeScreenProps) {
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
  const [activeTab, setActiveTabRaw]      = useState<'goals' | 'workout' | 'meals' | 'progress' | 'profile'>('workout');
  const setActiveTab = useCallback((tab: typeof activeTab) => {
    setActiveTabRaw(tab);
    AsyncStorage.setItem('lastActiveTab', tab).catch(() => {});
  }, []);
  useEffect(() => {
    AsyncStorage.getItem('lastActiveTab').then(saved => {
      if (saved && ['goals', 'workout', 'meals', 'progress', 'profile'].includes(saved)) {
        setActiveTabRaw(saved as typeof activeTab);
      }
    }).catch(() => {});
  }, []);
  // Sub-tab inside each main tab.
  // Workouts: plan | exercises | muscles | equipment
  // Meals:    plan | foods     | supplements | macros
  const [workoutSubTab, setWorkoutSubTab] = useState<'plan' | 'library' | 'exercises' | 'muscles' | 'equipment'>('plan');
  const [mealsSubTab,   setMealsSubTab]   = useState<'plan' | 'foods' | 'supplements' | 'macros'>('plan');
  const [commonMeals, setCommonMeals] = useState<any[]>([]);
  const [feedbackSettings, setFeedbackSettings] = useState({ hapticsEnabled: true, soundsEnabled: true, vibrationEnabled: true });
  const [reminderEnabled, setReminderEnabled] = useState(false);
  useEffect(() => { import('../utils/feedback').then(f => f.loadSettings()).then(setFeedbackSettings).catch(() => {}); }, []);
  useEffect(() => {
    if (mealsSubTab === 'foods' && authToken) {
      import('../services/api').then(({ getCommonMeals }) =>
        getCommonMeals(authToken).then(r => setCommonMeals(r.meals || [])).catch(() => {})
      );
    }
  }, [mealsSubTab, authToken]);
  // menuOpen state removed — the side menu modal is gone. Profile tab handles it.
  // Cached health score for the Profile tab. Loaded once on mount;
  // re-loaded when the user changes tabs to profile so a fresh scan
  // shows up without a full reload.
  const [profileHealthScore, setProfileHealthScore] = useState<import('../types').HealthScoreResult | null>(null);
  useEffect(() => {
    if (activeTab === 'profile') {
      loadHealthScore().then(setProfileHealthScore).catch(() => setProfileHealthScore(null));
    }
    // Auto-close the inline exercise library when leaving the workout tab.
    if (activeTab !== 'workout') {
      setShowExerciseLibrary(false);
    }
  }, [activeTab]);
  const [showCheckin, setShowCheckin]     = useState(false);
  /** True while `loadPlans` is mid-flight. Prevents concurrent plan reads
      from clobbering each other if an effect re-fires rapidly. */
  const loadPlansInFlightRef = useRef(false);
  const [expandedDay, setExpandedDay]     = useState<number>(-1);
  const [switchDayIdx, setSwitchDayIdx]   = useState<number>(-1);
  const [showAllThemes, setShowAllThemes] = useState(false);
  const [showExerciseLibrary, setShowExerciseLibrary] = useState(false);
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
  const [chatTopic, setChatTopic] = useState<string | null>(null);
  const [trainerInput, setTrainerInput] = useState('');
  const [trainerLoading, setTrainerLoading] = useState(false);
  const trainerAbortRef = useRef<AbortController | null>(null);
  const [isChatPlanUpdating, setIsChatPlanUpdating] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<PendingPlanUpdate | null>(null);
  const chatProgressAnim = useRef(new Animated.Value(0)).current;
  const [attachedImage, setAttachedImage] = useState<{ base64: string; uri: string } | null>(null);
  const [workoutChat, setWorkoutChat] = useState<TrainerChatMessage[]>([]);
  const nutritionChat = workoutChat;
  const setNutritionChat = setWorkoutChat;
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
  const [skippedDates, setSkippedDates]   = useState<Set<string>>(new Set());
  // Dropped skips = user chose "skip entirely" (don't push to tomorrow).
  // get7DaySchedule advances the workout index for these dates.
  const [droppedSkipDates, setDroppedSkipDates] = useState<Set<string>>(new Set());
  const [todaySummary, setTodaySummary]   = useState<import('../types').StoredWorkoutSummary | null>(null);
  const [preservedWorkouts, setPreservedWorkouts] = useState<Record<string, WorkoutDay>>({});
  const [readinessScore, setReadinessScore] = useState<{ score: number; label: string; topFatigued?: Array<{ muscle: string; value: number }>; muscleFatigue?: Record<string, number>; activities?: Array<{ date: string; focus: string; muscles: Record<string, number> }>; nutritionContext?: { protein_avg: number; protein_status: string; message: string | null; recovery_bonus_applied: boolean } | null } | null>(null);
  const [recoveryExpanded, setRecoveryExpanded] = useState(false);
  const [nutritionScoreData, setNutritionScoreData] = useState<import('../utils/nutritionScore').NutritionScoreResult | null>(null);
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
  const [cardioProfile, setCardioProfile] = useState<string | null>(null);

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
  const [showWeeklyCheckin, setShowWeeklyCheckin] = useState(false);
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

  const persistDayState = useCallback(async (dayKey: string, patch: { skipped_focus?: string | null; meal_checks?: Record<string, boolean>; nutrition_plan?: any }) => {
    if (!authToken) return;
    try {
      const currentChecks = checkedMealsByDate[dayKey] ?? {};
      const currentPlan = nutritionPlansByDate[dayKey] ?? null;
      const isSkipped = skippedDates.has(dayKey);
      await upsertDayState(authToken, dayKey, {
        skipped_focus: patch.skipped_focus !== undefined ? patch.skipped_focus : (isSkipped ? 'skipped' : null),
        meal_checks: patch.meal_checks ?? currentChecks,
        nutrition_plan: patch.nutrition_plan ?? currentPlan,
      });
    } catch {
      // Keep app responsive even if backend persistence fails
    }
  }, [authToken, checkedMealsByDate, nutritionPlansByDate, skippedDates]);

  useEffect(() => {
    AsyncStorage.getItem('user_username').then(v => { if (v) setUsername(v); }).catch(() => {});
    import('../utils/workoutReminders').then(({ loadReminderSettings }) =>
      loadReminderSettings().then(s => setReminderEnabled(s.enabled)).catch(() => {})
    );
    if (userProfile) loadPlans(userProfile);
    loadDayStatus();
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
      setCardioProfile(insight.cardioProfile);
    })();
    return () => { mounted = false; };
  }, [todayDone, workoutPlan]);

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
        setCurrentDate(nowKey);
        loadDayStatus();
        if (userProfile) loadPlans(userProfile);
      }
    }, 60000);
    return () => clearInterval(timer);
  }, [currentDate, userProfile, authToken]);

  const loadDayStatus = async () => {
    const today = todayKey();
    const mealDays = getNextMealDays(7);
    const checkMap: Record<string, MealChecks> = {};
    const skipped = new Set<string>();

    if (authToken) {
      const states = await Promise.all(mealDays.map(d => getDayState(authToken, d.key).catch(() => null)));
      mealDays.forEach((d, i) => {
        const s = states[i] as any;
        checkMap[d.key] = s?.meal_checks ?? {};
        if (s?.skipped_focus) skipped.add(d.key);
      });
    } else {
      const checksList = await Promise.all(mealDays.map(d => getMealChecks(d.key)));
      mealDays.forEach((d, i) => { checkMap[d.key] = checksList[i] as MealChecks; });
    }

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
    } else {
      setReadinessScore({ score: 100, label: 'Fresh', topFatigued: [] });
    }
  };

  const loadPlans = async (profile: UserProfile) => {
    // Drop concurrent / duplicate calls. Without this guard, rapid effect
    // re-fires (e.g. during hot-reload or prop churn) can race against each
    // other and leave state in an inconsistent half-loaded shape.
    if (loadPlansInFlightRef.current) {
      console.log('[loadPlans] already in flight — skipping duplicate call');
      return;
    }
    loadPlansInFlightRef.current = true;
    try {
    // Check for an AI-generated plan saved after user saves plan settings
    const aiWorkoutRaw = await AsyncStorage.getItem('aiWorkoutPlan');
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
    // Persist enriched plan so images survive next load without re-fetching
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
          });
          if (freshDay?.day) {
            const updatedDays = [...baseWorkout.days];
            updatedDays[todayIdx % updatedDays.length] = freshDay.day;
            const updatedPlan = { ...baseWorkout, days: updatedDays };
            setWorkoutPlan(updatedPlan);
            // Persist to AsyncStorage so the fresh day survives app restart
            await AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(updatedPlan)).catch(() => {});
            await AsyncStorage.setItem(freshDayKey, '1').catch(() => {});
            console.log(`[loadPlans] fresh day generated & saved: ${freshDay.day.focus} (idx ${todayIdx})`);
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
            if (pLocal && currentLocalIds.has(pLocal)) return false;
            if (pRoutine && currentRoutineIds.has(pRoutine)) return false;
            if (currentSigs.has(pSig)) return false;
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
    setNutritionPlansByDate(raw);

    // ── Background enrichment for routine/custom meals missing micros ──
    // Routine meals are overlaid client-side and never go through the
    // server's post-assembly enrichment. Fire a background call to fill
    // in micros for any items that lack them.
    if (authToken) {
      _enrichRoutineMealsMicros(raw, authToken, routines, setNutritionPlansByDate);
    }
    } finally {
      loadPlansInFlightRef.current = false;
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

  const openExerciseLibrary = useCallback(async () => {
    setShowExerciseLibrary(true);
    if (exerciseLibrary.length > 0) return;
    setExerciseLibraryLoading(true);
    try {
      const rows = await getExercises();
      // Merge the user's AI-saved custom exercises on top of the server
      // library so both show up in the same filters and searches.
      const customs = (userProfile?.customExercises ?? []).map(ce => ({
        id: ce.id as any,
        name: ce.name,
        primary_muscle: ce.primary_muscle,
        secondary_muscles: [] as string[],
        equipment: ce.equipment,
        description: ce.description ?? '',
        is_custom: true,
      })) as unknown as ExerciseLibraryItem[];
      setExerciseLibrary([...customs, ...rows]);
    } catch {
      // On network error, still show the user's custom exercises.
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
    } finally {
      setExerciseLibraryLoading(false);
    }
  }, [exerciseLibrary.length, userProfile?.customExercises]);

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
    if (coachMode === 'trainer' && !workoutPlan) {
      Alert.alert('Unavailable', 'Your workout plan is still loading. Please try again in a moment.');
      return;
    }

    const isTrainer = coachMode === 'trainer';
    const activeChat = isTrainer ? workoutChat : nutritionChat;
    const setActiveChat = isTrainer ? setWorkoutChat : setNutritionChat;
    const setUpdateSummary = isTrainer ? setWorkoutUpdateSummary : setNutritionUpdateSummary;

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
        mode: coachMode,
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

      // Show the answer immediately — don't wait for plan application
      setActiveChat(prev => [...prev, { role: 'assistant', content: combined }]);
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

      // Handle injury updates immediately (no approval needed)
      if (coachMode === 'trainer' && resp.updated_injuries && Array.isArray(resp.updated_injuries) && resp.updated_injuries.length > 0) {
        try {
          const profileRaw = await AsyncStorage.getItem('userProfile');
          if (profileRaw) {
            const storedProfile: UserProfile = JSON.parse(profileRaw);
            const existingEntries: InjuryEntry[] = storedProfile.injuryEntries ?? [];
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
            const merged = [...existingEntries];
            for (const entry of incoming) {
              const idx = merged.findIndex(e => e.id === entry.id);
              if (idx >= 0) merged[idx] = entry;
              else merged.push(entry);
            }
            const updatedProfile = { ...storedProfile, injuryEntries: merged };
            await AsyncStorage.setItem('userProfile', JSON.stringify(updatedProfile));
            console.log('[handleAskTrainer] updated injuryEntries saved:', merged.length, 'entries');
            // Trigger plan regeneration — the deterministic planner will
            // block dangerous patterns and adjust readiness for the injury.
            onProfileUpdate?.(updatedProfile, false);
            console.log('[handleAskTrainer] plan regeneration triggered for injury');
          }
        } catch (injErr) {
          console.error('[handleAskTrainer] failed to save injury update:', injErr);
        }
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
  }, [trainerInput, attachedImage, authToken, userProfile, workoutPlan, nutritionPlansByDate, todayDone, skippedDates, workoutChat, nutritionChat, coachMode, chatTopic, persistDayState]);

  // ── Approval flow for plan changes ───────────────────────────────────────
  const applyPendingUpdate = useCallback(async () => {
    if (!pendingUpdate) return;
    const { resp, question: q, coachMode: mode, profileChanges } = pendingUpdate;
    const setActiveChat = mode === 'trainer' ? setWorkoutChat : setNutritionChat;
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
      setActiveChat(prev => [...prev, { role: 'assistant', content: `Changes applied! Close this chat to see them on your home screen.` }]);
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
    const setActiveChat = pendingUpdate?.coachMode === 'trainer' ? setWorkoutChat : setNutritionChat;
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

  const handleMealSave = useCallback(async (date: string, mealType: string, updated: MealSuggestion) => {
    console.log(`[handleMealSave] date=${date} mealType=${mealType} updatedMeal=${updated.meal} items=${updated.items?.length ?? 0}`);
    let nextPlan: DailyNutritionPlan | null = null;
    setNutritionPlansByDate(prev => {
      const current = prev[date];
      if (!current) { console.log(`[handleMealSave] no current plan for ${date}`); return prev; }
      const meals = [...(current.meals ?? [])];
      if (mealType === 'new_meal' || mealType === 'new_extra') {
        meals.push(updated);
      } else if (mealType.startsWith('meal_')) {
        const idx = parseInt(mealType.slice(5), 10);
        if (idx >= 0 && idx < meals.length) meals[idx] = updated;
        else meals.push(updated);
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

    // Routine-backed meal edits must propagate to `mealRoutines` storage.
    // Identified by `_routineId` on the saved meal — the user just edited
    // a meal that was pinned, so we update the routine snapshot in place.
    const routineId = (updated as any)._routineId;
    if (routineId) {
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
      }
    }
  }, [persistDayState]);

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

  const openExerciseVideo = useCallback(async (exerciseName: string) => {
    try {
      await Linking.openURL(getExerciseVideoUrl(exerciseName));
    } catch {
      Alert.alert('Could not open video', 'There was a problem opening the exercise video link.');
    }
  }, []);

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
  const mealDays = getNextMealDays(7);

  const isLightTheme = ['sunrise', 'arctic', 'rose', 'parchment', 'meadow'].includes(userProfile.themePreference ?? 'midnight');  // blossom is now dark
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
      {(isWorkoutUpdating && isNutritionUpdating) ? (
        <View style={[styles.planLoadingOverlay, { backgroundColor: themeColors.background }]}>
          <FadeInView delay={0}>
            <Image
              source={bgIsDark(themeColors.background) ? LOGO_DARK : LOGO_LIGHT_HEADER}
              style={{ width: 240, height: 54, alignSelf: 'center', marginBottom: 24 }}
              resizeMode="contain"
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
        </View>
      ) : null}

      {/* Chat-triggered plan update — slim inline banner */}
      {isChatPlanUpdating && !isWorkoutUpdating && !isNutritionUpdating ? (
        <View style={[styles.chatPlanUpdateBanner, { backgroundColor: themeColors.primary + '18', borderBottomColor: themeColors.primary + '33' }]}>
          <ActivityIndicator size="small" color={themeColors.primary} />
          <Text style={[styles.chatPlanUpdateText, { color: themeColors.primary }]}>Applying plan updates…</Text>
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
          </View>
        </View>
      )}

      {/* Fixed meals sub-tab bar — same pattern. */}
      {activeTab === 'meals' && !(isNutritionUpdating && !isWorkoutUpdating) && (
        <View style={[styles.fixedSubTabBar, { top: insets.top + 70, backgroundColor: themeColors.background, borderBottomColor: themeColors.border }]}>
          <View style={[styles.segmentedWrap, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
            <SubTabBtn label="Plan"   active={mealsSubTab === 'plan'}        tint={mealPalette.strong} mutedColor={themeColors.textSecondary} onPress={() => setMealsSubTab('plan')} />
            <SubTabBtn label="Foods"  active={mealsSubTab === 'foods'}       tint={mealPalette.strong} mutedColor={themeColors.textSecondary} onPress={() => setMealsSubTab('foods')} />
            <SubTabBtn label="Supps"  active={mealsSubTab === 'supplements'} tint={mealPalette.strong} mutedColor={themeColors.textSecondary} onPress={() => setMealsSubTab('supplements')} />
          </View>
        </View>
      )}

      {/* Tab content. Each tab gets its own loading placeholder so
          section-specific regens don't block the other tab.
          Only the workout/meals tabs render the existing ScrollView body;
          goals/progress/profile render their own inline pages below. */}
      {(activeTab === 'workout' || activeTab === 'meals') && (
      <ErrorBoundary>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContentBelowSubTab} keyboardShouldPersistTaps="handled" onScrollBeginDrag={Keyboard.dismiss}>
        {activeTab === 'workout' ? (
          (isWorkoutUpdating && !isNutritionUpdating) ? (
            <View style={[styles.tabPlanLoadingFull, { backgroundColor: themeColors.background }]}>
              <ActivityIndicator size="large" color={workoutPalette.strong} />
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

            {/* Weekly check-in countdown */}
            {workoutSubTab === 'plan' && daysUntilCheckin != null && daysUntilCheckin <= 2 && (
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

            {/* Readiness badge — tap to expand full muscle breakdown */}
            {workoutSubTab === 'plan' && readinessScore && (
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setRecoveryExpanded(p => !p); }}
                style={{
                  marginBottom: 8, backgroundColor: themeColors.surfaceRaised, borderRadius: 10, padding: 10,
                  borderWidth: 1, borderColor: themeColors.border,
                }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Ionicons
                    name={readinessScore.score >= 65 ? 'battery-full' : readinessScore.score >= 40 ? 'battery-half' : 'battery-dead'}
                    size={20}
                    color={readinessScore.score >= 65 ? '#22C55E' : readinessScore.score >= 40 ? '#F59E0B' : '#EF4444'}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: themeColors.textPrimary }}>
                      Recovery: {readinessScore.label} ({readinessScore.score}%)
                    </Text>
                    {!recoveryExpanded && readinessScore.topFatigued && readinessScore.topFatigued.length > 0 && (
                      <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }} numberOfLines={1}>
                        Most fatigued: {readinessScore.topFatigued.slice(0, 3).map(t => t.muscle.replace('_', ' ')).join(', ')}
                      </Text>
                    )}
                    {!recoveryExpanded && (!readinessScore.topFatigued || readinessScore.topFatigued.length === 0) && (
                      <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }}>All muscle groups fresh</Text>
                    )}
                  </View>
                  <Ionicons name={recoveryExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={themeColors.textMuted} />
                </View>
                {recoveryExpanded && readinessScore.muscleFatigue && (
                  <View style={{ marginTop: 10, gap: 4 }}>
                    {Object.entries(readinessScore.muscleFatigue)
                      .filter(([k]) => k !== 'cardio' && k !== 'systemic')
                      .sort((a, b) => b[1] - a[1])
                      .map(([muscle, fatigue]) => {
                        const pct = Math.round(fatigue * 100);
                        const recovery = Math.max(0, 100 - pct);
                        const color = recovery >= 70 ? '#22C55E' : recovery >= 40 ? '#F59E0B' : '#EF4444';
                        return (
                          <View key={muscle} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <Text style={{ fontSize: 11, fontWeight: '600', color: themeColors.textSecondary, width: 75, textTransform: 'capitalize' }}>
                              {muscle.replace('_', ' ')}
                            </Text>
                            <View style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: themeColors.border }}>
                              <View style={{ width: `${Math.min(100, recovery)}%` as any, height: 5, borderRadius: 3, backgroundColor: color }} />
                            </View>
                            <Text style={{ fontSize: 10, fontWeight: '700', color, width: 32, textAlign: 'right' }}>{recovery}%</Text>
                          </View>
                        );
                      })}
                    {readinessScore.muscleFatigue.systemic > 0 && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4, paddingTop: 4, borderTopWidth: 1, borderTopColor: themeColors.border }}>
                        <Text style={{ fontSize: 11, fontWeight: '600', color: themeColors.textSecondary, width: 75 }}>Overall Load</Text>
                        <View style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: themeColors.border }}>
                          <View style={{ width: `${Math.min(100, Math.max(0, 100 - Math.round(readinessScore.muscleFatigue.systemic * 100)))}%` as any, height: 5, borderRadius: 3, backgroundColor: readinessScore.muscleFatigue.systemic > 0.5 ? '#EF4444' : '#F59E0B' }} />
                        </View>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: readinessScore.muscleFatigue.systemic > 0.5 ? '#EF4444' : '#F59E0B', width: 32, textAlign: 'right' }}>{Math.max(0, 100 - Math.round(readinessScore.muscleFatigue.systemic * 100))}%</Text>
                      </View>
                    )}
                    {readinessScore.activities && readinessScore.activities.length > 0 && (
                      <View style={{ marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: themeColors.border }}>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: themeColors.textMuted, marginBottom: 4 }}>RECENT ACTIVITY</Text>
                        {readinessScore.activities.map((a, i) => (
                          <Text key={i} style={{ fontSize: 10, color: themeColors.textSecondary }}>
                            {a.date} · {a.focus} · {Object.keys(a.muscles).length} muscles
                          </Text>
                        ))}
                      </View>
                    )}
                    {readinessScore.nutritionContext?.message && (
                      <View style={{ marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: themeColors.border, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Ionicons
                          name={readinessScore.nutritionContext.protein_status === 'excellent' ? 'nutrition' : readinessScore.nutritionContext.protein_status === 'good' ? 'nutrition-outline' : 'alert-circle-outline'}
                          size={14}
                          color={readinessScore.nutritionContext.protein_status === 'excellent' || readinessScore.nutritionContext.protein_status === 'good' ? '#22C55E' : readinessScore.nutritionContext.protein_status === 'low' ? '#F59E0B' : readinessScore.nutritionContext.protein_status === 'very_low' ? '#EF4444' : themeColors.textMuted}
                        />
                        <Text style={{
                          fontSize: 10, fontWeight: '600', flex: 1,
                          color: readinessScore.nutritionContext.protein_status === 'excellent' || readinessScore.nutritionContext.protein_status === 'good' ? '#22C55E' : readinessScore.nutritionContext.protein_status === 'low' ? '#F59E0B' : readinessScore.nutritionContext.protein_status === 'very_low' ? '#EF4444' : themeColors.textMuted,
                        }}>
                          {readinessScore.nutritionContext.message}
                        </Text>
                      </View>
                    )}
                  </View>
                )}
              </TouchableOpacity>
            )}

            {/* Plan actions row — Why + Log + Edit */}
            {workoutSubTab === 'plan' && (
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                {trainerNote ? (
                  <TouchableOpacity
                    style={[styles.planNoteLink, { borderColor: workoutPalette.strong + '55', flex: 1 }]}
                    onPress={() => setShowTrainerNote(true)}
                    activeOpacity={0.7}>
                    <Ionicons name="information-circle-outline" size={14} color={workoutPalette.strong} />
                    <Text style={[styles.planNoteLinkText, { color: workoutPalette.strong }]}>
                      Why this plan
                    </Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity
                  style={[styles.planNoteLink, { borderColor: themeColors.primary + '44' }]}
                  onPress={() => setShowLogActivity(true)}
                  activeOpacity={0.7}>
                  <Ionicons name="add-circle-outline" size={14} color={themeColors.primary} />
                  <Text style={[styles.planNoteLinkText, { color: themeColors.primary }]}>
                    Log Activity
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.planNoteLink, { borderColor: themeColors.textMuted + '44' }]}
                  onPress={() => setWorkoutSubTab('equipment')}
                  activeOpacity={0.7}>
                  <Ionicons name="settings-outline" size={14} color={themeColors.textMuted} />
                  <Text style={[styles.planNoteLinkText, { color: themeColors.textMuted }]}>
                    Edit Plan
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {workoutSubTab === 'plan' && (availabilityItems.length > 0 || cardioProfile) && (
              <View style={[styles.insightCard, { borderColor: plannerPalette.strong + '55', backgroundColor: plannerPalette.soft }] }>
                <Text style={[styles.insightTitle, { color: themeColors.textPrimary }]}>Muscle Focus</Text>
                {cardioProfile ? <Text style={[styles.insightSubtitle, { color: themeColors.textSecondary }]}>{cardioProfile}</Text> : null}
                <View style={styles.insightChips}>
                  {availabilityItems.map(item => (
                    <View key={item.label} style={[styles.insightChip, { borderColor: plannerPalette.strong + '55', backgroundColor: themeColors.surfaceRaised }]}>
                      <Text style={[styles.insightChipText, { color: plannerPalette.text }]}>{item.label} {item.pct}%</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}
            {workoutSubTab === 'plan' && (() => {
              const split = userProfile.preferredSplit ?? 'ppl';
              const splitFocusOptions: Record<string, string[]> = {
                ppl: ['Push', 'Pull', 'Legs'],
                upper_lower: ['Upper', 'Lower'],
                full_body: ['Full Body'],
                ppl_upper_lower: ['Push', 'Pull', 'Legs', 'Upper', 'Lower'],
                bro: ['Chest', 'Back', 'Shoulders', 'Arms', 'Legs'],
              };
              const focusOptions = splitFocusOptions[split] ?? splitFocusOptions.ppl;
              const extraOptions = ['Cardio', 'Mobility', 'Recovery'];
              const allOptions = [...focusOptions, ...extraOptions];

              return schedule.map((item, i) => {
              const key = dateKey(item.date);
              const isToday     = i === 0;
              const isCompleted = isToday && todayDone;
              const isSkipped   = skippedDates.has(key);
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
                  onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setExpandedDay(expandedDay === i ? -1 : i); }}
                  onStartWorkout={onStartWorkout}
                  onSkip={handleSkipToday}
                  onUnskip={() => handleUnskipDay(key)}
                  splitOptions={allOptions}
                  showSwitchOptions={switchDayIdx === i}
                  onToggleSwitch={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setSwitchDayIdx(switchDayIdx === i ? -1 : i); }}
                  onChangeFocus={async (newFocus) => {
                    setSwitchDayIdx(-1);
                    if (!workoutPlan || !item.workout) return;
                    const dayIdx = workoutPlan.days.indexOf(item.workout);
                    if (dayIdx < 0) return;
                    const days = workoutPlan.days;

                    // Warn if adjacent day has the same focus
                    const prevFocus = dayIdx > 0 ? days[dayIdx - 1]?.focus : null;
                    const nextFocus = dayIdx < days.length - 1 ? days[dayIdx + 1]?.focus : null;
                    if (prevFocus === newFocus || nextFocus === newFocus) {
                      const adjDay = prevFocus === newFocus ? 'yesterday' : 'the next day';
                      const proceed = await new Promise<boolean>(resolve => {
                        Alert.alert(
                          'Same focus back-to-back',
                          `${adjDay === 'yesterday' ? 'The previous day' : 'The next day'} is already ${newFocus}. ` +
                          `Training the same muscles two days in a row limits recovery. Continue anyway?`,
                          [
                            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
                            { text: 'Do it anyway', onPress: () => resolve(true) },
                          ],
                        );
                      });
                      if (!proceed) return;
                    }

                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                    import('../utils/feedback').then(f => f.hapticMedium()).catch(() => {});

                    if (authToken) {
                      try {
                        const { generateWorkoutDay } = await import('../services/api');

                        // Regenerate the changed day
                        const freshDay = await generateWorkoutDay(authToken, {
                          goal: userProfile.goal,
                          day_index: dayIdx,
                          days_per_week: userProfile.daysPerWeek,
                          session_minutes: userProfile.workoutDurationMinutes ?? 60,
                          experience: userProfile.experienceLevel ?? 'intermediate',
                          equipment: userProfile.equipment ?? [],
                          preferred_split: userProfile.preferredSplit,
                          priority_region: userProfile.priorityRegion ?? 'balanced',
                          injuries: (userProfile.injuryEntries ?? []).filter(i => i.status !== 'resolved').map(i => `${i.bodyPart || i.description} (status: ${i.status})`),
                          disliked_exercises: userProfile.dislikedExercises ?? [],
                          focus_override: newFocus,
                        });
                        if (freshDay?.day) {
                          const newDay = { ...freshDay.day, focus: newFocus };
                          const updatedDays = [...workoutPlan.days];
                          updatedDays[dayIdx] = newDay;

                          // Rebalance: if the swap created a duplicate adjacent
                          // focus, swap the conflicting neighbor with the old focus
                          const oldFocus = item.workout.focus;
                          if (nextFocus === newFocus && dayIdx + 1 < updatedDays.length) {
                            updatedDays[dayIdx + 1] = { ...updatedDays[dayIdx + 1], focus: oldFocus };
                            // Regenerate that day too
                            try {
                              const rebalanced = await generateWorkoutDay(authToken, {
                                goal: userProfile.goal,
                                day_index: dayIdx + 1,
                                days_per_week: userProfile.daysPerWeek,
                                session_minutes: userProfile.workoutDurationMinutes ?? 60,
                                experience: userProfile.experienceLevel ?? 'intermediate',
                                equipment: userProfile.equipment ?? [],
                                preferred_split: userProfile.preferredSplit,
                                priority_region: userProfile.priorityRegion ?? 'balanced',
                                injuries: (userProfile.injuryEntries ?? []).filter(i => i.status !== 'resolved').map(i => `${i.bodyPart || i.description} (status: ${i.status})`),
                                disliked_exercises: userProfile.dislikedExercises ?? [],
                                focus_override: oldFocus,
                              });
                              if (rebalanced?.day) {
                                updatedDays[dayIdx + 1] = { ...rebalanced.day, focus: oldFocus };
                              }
                            } catch {}
                          }

                          const updatedPlan = { ...workoutPlan, days: updatedDays };
                          setWorkoutPlan(updatedPlan);
                          await AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(updatedPlan));
                          // Mark fresh day as generated so loadPlans doesn't overwrite the switch
                          await AsyncStorage.setItem(`freshDayGenerated_${todayKey()}`, '1');
                          return;
                        }
                      } catch (e) {
                        console.log('[onChangeFocus] regeneration failed, using focus-only swap:', e);
                      }
                    }
                    // Fallback: just change the focus label
                    const updatedDays = [...workoutPlan.days];
                    updatedDays[dayIdx] = { ...updatedDays[dayIdx], focus: newFocus };
                    const updatedPlan = { ...workoutPlan, days: updatedDays };
                    setWorkoutPlan(updatedPlan);
                    AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(updatedPlan)).catch(() => {});
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
              <ActivityIndicator size="large" color={mealPalette.strong} />
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

            {/* Non-Plan sub-tabs render EditProfileScreen mealplan inline.
                The wrapper sets a solid background so the remount
                frame (triggered by the `key` prop below) doesn't
                flash-through to the previous tab's content. */}
            {mealsSubTab !== 'plan' && (
              <View style={{ flex: 1, marginHorizontal: -16, marginBottom: 70, backgroundColor: themeColors.background }}>
                {mealsSubTab === 'foods' && commonMeals.length > 0 && (
                  <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: themeColors.textMuted, marginBottom: 6 }}>YOUR FAVORITES</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                      {commonMeals.map(m => (
                        <View key={m.name} style={{ backgroundColor: themeColors.surface, borderRadius: 10, padding: 10, marginRight: 8, borderWidth: 1, borderColor: themeColors.border, minWidth: 120 }}>
                          <Text style={{ fontSize: 12, fontWeight: '700', color: themeColors.textPrimary }} numberOfLines={1}>{m.name}</Text>
                          <Text style={{ fontSize: 10, color: themeColors.textMuted }}>{m.count}x · {Math.round(m.avg_calories)} cal · {Math.round(m.avg_protein_g)}g protein</Text>
                        </View>
                      ))}
                    </ScrollView>
                  </View>
                )}
                <EditProfileScreen
                  key={`meal-${mealsSubTab}`}
                  authToken={authToken}
                  profile={userProfile}
                  mode="mealplan"
                  initialMealTab={mealsSubTab}
                  noHeader
                  onSave={(updated) => { onSaveProfile?.(updated, 'mealplan'); setMealsSubTab('plan'); }}
                  onCancel={() => setMealsSubTab('plan')}
                  onRoutinesChanged={() => { /* no-op */ }}
                />
              </View>
            )}

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
                <View style={[styles.dailyTargetBanner, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: themeColors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      Daily target
                    </Text>
                    <Text style={{ fontSize: 11, color: themeColors.textMuted }}>
                      {goalLabel}
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <View style={{ alignItems: 'center' }}>
                      <Text style={{ fontSize: 20, fontWeight: '800', color: mealPalette.strong }}>{t.calories}</Text>
                      <Text style={{ fontSize: 10, color: themeColors.textMuted }}>cal</Text>
                    </View>
                    <View style={{ alignItems: 'center' }}>
                      <Text style={{ fontSize: 20, fontWeight: '800', color: themeColors.primary }}>{t.protein ?? 0}g</Text>
                      <Text style={{ fontSize: 10, color: themeColors.textMuted }}>protein · {protPct}%</Text>
                    </View>
                    <View style={{ alignItems: 'center' }}>
                      <Text style={{ fontSize: 20, fontWeight: '800', color: '#F59E0B' }}>{t.carbs ?? 0}g</Text>
                      <Text style={{ fontSize: 10, color: themeColors.textMuted }}>carbs · {carbPct}%</Text>
                    </View>
                    <View style={{ alignItems: 'center' }}>
                      <Text style={{ fontSize: 20, fontWeight: '800', color: '#A78BFA' }}>{t.fat ?? 0}g</Text>
                      <Text style={{ fontSize: 10, color: themeColors.textMuted }}>fat · {fatPct}%</Text>
                    </View>
                  </View>
                  {/* Workout-aware nutrition tip */}
                  {(() => {
                    const todaySchedule = schedule[0];
                    if (!todaySchedule || todaySchedule.isRest) {
                      return <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 6 }}>Rest day — prioritize protein and recovery nutrition</Text>;
                    }
                    const stim = todaySchedule.workout?.stimulus;
                    if (stim === 'strength' || stim === 'power') {
                      return <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 6 }}>Heavy training day — extra carbs around your workout for fuel</Text>;
                    }
                    if (stim === 'conditioning') {
                      return <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 6 }}>Cardio day — stay hydrated and replenish electrolytes</Text>;
                    }
                    return <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 6 }}>Training day — keep protein high for muscle recovery</Text>;
                  })()}
                  {userProfile?.physicalStats?.weightLbs ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6, backgroundColor: themeColors.surface, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: themeColors.border }}>
                      <Ionicons name="water-outline" size={16} color="#38BDF8" />
                      <Text style={{ fontSize: 12, fontWeight: '600', color: themeColors.textPrimary }}>
                        {formatWaterTarget(userProfile.physicalStats.weightLbs, userProfile.workoutDurationMinutes ?? 0)}
                      </Text>
                      <Text style={{ fontSize: 10, color: themeColors.textMuted }}>daily target</Text>
                    </View>
                  ) : null}
                </View>
              );
            })()}

            {/* Plan actions row — Why + Edit */}
            {mealsSubTab === 'plan' && (
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                {nutritionistNote ? (
                  <TouchableOpacity
                    style={[styles.planNoteLink, { borderColor: mealPalette.strong + '55', flex: 1 }]}
                    onPress={() => setShowNutritionistNote(true)}
                    activeOpacity={0.7}>
                    <Ionicons name="information-circle-outline" size={14} color={mealPalette.strong} />
                    <Text style={[styles.planNoteLinkText, { color: mealPalette.strong }]}>
                      Why this plan
                    </Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity
                  style={[styles.planNoteLink, { borderColor: themeColors.textMuted + '44', flex: nutritionistNote ? 0 : 1 }]}
                  onPress={() => setMealsSubTab('foods')}
                  activeOpacity={0.7}>
                  <Ionicons name="settings-outline" size={14} color={themeColors.textMuted} />
                  <Text style={[styles.planNoteLinkText, { color: themeColors.textMuted }]}>
                    Edit Plan
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {mealsSubTab === 'plan' && mealDays.map((d, idx) => {
              const plan = nutritionPlansByDate[d.key];
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
                      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
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
                      const c = ds.score >= 70 ? '#22C55E' : ds.score >= 45 ? '#F59E0B' : '#EF4444';
                      return (
                        <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: c + '18', alignItems: 'center', justifyContent: 'center', marginRight: 4 }}>
                          <Text style={{ fontSize: 11, fontWeight: '900', color: c }}>{ds.score}</Text>
                        </View>
                      );
                    })()}
                    <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={themeColors.textMuted} />
                  </TouchableOpacity>

                  {isExpanded && (
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
                      goal={userProfile.goal}
                    />
                  )}
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

      {/* ── Goals tab — inline EditProfileScreen in goal mode ──────── */}
      {activeTab === 'goals' && (
        <ErrorBoundary>
        <View style={{ flex: 1, marginBottom: 70, backgroundColor: themeColors.background }}>
          <EditProfileScreen
            authToken={authToken}
            profile={userProfile}
            mode="goal"
            noHeader
            onSave={(updated) => {
              onSaveProfile?.(updated, 'goal');
              setActiveTab('workout');
            }}
            onCancel={() => setActiveTab('workout')}
            onRoutinesChanged={() => { /* no-op in inline mode */ }}
          />
        </View>
        </ErrorBoundary>
      )}

      {/* ── Progress tab — kept mounted to avoid white flash on tab switch */}
      <View style={{ flex: 1, paddingBottom: 88, display: activeTab === 'progress' ? 'flex' : 'none' }}>
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
      </View>

      {/* ── Profile tab ─────────────────────────────────────────────── */}
      {activeTab === 'profile' && (<ErrorBoundary>{(() => {
        const ps = userProfile.physicalStats;
        const heightStr = ps ? `${ps.heightFeet}'${ps.heightInches}"` : '—';
        type ThemeEntry = { key: import('../types').AppThemeName; label: string; swatch: string; mode: 'dark' | 'light' };
        const allThemes: ThemeEntry[] = [
          // Dark themes
          { key: 'midnight', label: 'Midnight', swatch: '#15C7B8', mode: 'dark' },
          { key: 'ocean',    label: 'Ocean',    swatch: '#00CCE8', mode: 'dark' },
          { key: 'amethyst', label: 'Amethyst', swatch: '#A060FF', mode: 'dark' },
          { key: 'ember',    label: 'Ember',    swatch: '#FF6018', mode: 'dark' },
          { key: 'forest',   label: 'Forest',   swatch: '#3AA860', mode: 'dark' },
          { key: 'wine',     label: 'Wine',     swatch: '#C82848', mode: 'dark' },
          { key: 'arctic',   label: 'Arctic',   swatch: '#5BA3D9', mode: 'dark' },
          { key: 'sunrise',  label: 'Sunrise',  swatch: '#F08020', mode: 'dark' },
          { key: 'obsidian', label: 'Obsidian', swatch: '#888888', mode: 'dark' },
          { key: 'neon',     label: 'Neon',     swatch: '#00FF88', mode: 'dark' },
          { key: 'flamingo', label: 'Flamingo', swatch: '#FF69B4', mode: 'dark' },
          { key: 'citrus',   label: 'Citrus',   swatch: '#FFD700', mode: 'dark' },
          { key: 'scarlet',  label: 'Scarlet',  swatch: '#DC143C', mode: 'dark' },
          { key: 'cocoa',    label: 'Cocoa',    swatch: '#8B4513', mode: 'dark' },
          { key: 'void',     label: 'Void',     swatch: '#6A0DAD', mode: 'dark' },
          { key: 'dusk',     label: 'Dusk',     swatch: '#FF6F61', mode: 'dark' },
          { key: 'lavender', label: 'Lavender', swatch: '#B57EDC', mode: 'dark' },
          { key: 'aurora',   label: 'Aurora',   swatch: '#00CED1', mode: 'dark' },
          { key: 'copper',   label: 'Copper',   swatch: '#B87333', mode: 'dark' },
          { key: 'storm',    label: 'Storm',    swatch: '#4F5D75', mode: 'dark' },
          // Light themes
          { key: 'parchment', label: 'Parchment', swatch: '#D4A76A', mode: 'light' },
          { key: 'blossom',  label: 'Blossom',  swatch: '#FFB7C5', mode: 'light' },
          { key: 'meadow',   label: 'Meadow',   swatch: '#4CAF50', mode: 'light' },
          { key: 'rose',     label: 'Rose',     swatch: '#FF8FAB', mode: 'light' },
          { key: 'steel',    label: 'Steel',    swatch: '#4682B4', mode: 'light' },
          { key: 'sand',     label: 'Sand',     swatch: '#C2B280', mode: 'light' },
          { key: 'slate',    label: 'Slate',    swatch: '#708090', mode: 'light' },
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

          {/* Feedback Settings */}
          <Text style={[styles.profileSectionLabel, { color: themeColors.textMuted, marginTop: 18 }]}>FEEDBACK</Text>
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
            onPress={onSignOut}>
            <Text style={[styles.profileSignOutText, { color: themeColors.error }]}>Sign Out</Text>
          </TouchableOpacity>
        </ScrollView>
        );
      })()}</ErrorBoundary>)}

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
          onClose={() => setEditingMeal(null)}
          onToggleRoutine={() => handleToggleRoutine(editingMeal.dateKey, editingMeal.type)}
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
                  const { getExerciseImage: _getImg } = require('../utils/exerciseImages');
                  const _imgUrl = (selectedExercise as any).image_url || _getImg(selectedExercise.name);
                  return (
                    <>
                      {_imgUrl ? (
                        <View style={{ width: '100%', height: 200, borderRadius: 14, marginBottom: 14, backgroundColor: themeColors.surface, overflow: 'hidden', borderWidth: 1, borderColor: themeColors.border }}>
                          <Image
                            source={{ uri: _imgUrl }}
                            style={{ width: '100%', height: '100%' }}
                            resizeMode="contain"
                          />
                        </View>
                      ) : null}
                      <View style={[styles.detailTopCard, { backgroundColor: workoutPalette.soft, borderColor: workoutPalette.strong + '40' }]}>
                        <Text style={[styles.detailMeta, { color: workoutPalette.text }]}>Primary: {humanizeToken(selectedExercise.primary_muscle)}</Text>
                        {selectedExercise.secondary_muscles?.length ? (
                          <Text style={[styles.detailMeta, { color: workoutPalette.text + 'BB' }]}>Also hits: {selectedExercise.secondary_muscles.map(humanizeToken).join(', ')}</Text>
                        ) : null}
                        <Text style={[styles.detailMeta, { color: workoutPalette.text + 'BB' }]}>Equipment: {humanizeToken(selectedExercise.equipment) || 'Bodyweight'}</Text>
                        <TouchableOpacity style={[styles.detailVideoBtn, { backgroundColor: workoutPalette.strong }]} onPress={() => openExerciseVideo(selectedExercise.name)}>
                          <Text style={styles.detailVideoBtnText}>▶  Watch Form Video</Text>
                        </TouchableOpacity>
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

                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.libraryFilterRow}>
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

                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.libraryFilterRow}>
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
                    const _exImg = ex.image_url || (require('../utils/exerciseImages').getExerciseImage(ex.name));
                    return (
                    <TouchableOpacity key={String(ex.id ?? ex.name)} style={[styles.libraryItem, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border, flexDirection: 'row', gap: 12, alignItems: 'center' }]} activeOpacity={0.8} onPress={() => setSelectedExercise(ex)}>
                      {_exImg ? (
                        <View style={{ width: 48, height: 48, borderRadius: 10, backgroundColor: themeColors.surface, overflow: 'hidden', borderWidth: 1, borderColor: themeColors.border }}>
                          <Image source={{ uri: _exImg }} style={{ width: 48, height: 48 }} resizeMode="cover" />
                        </View>
                      ) : (
                        <View style={{ width: 48, height: 48, borderRadius: 10, backgroundColor: workoutPalette.soft, alignItems: 'center', justifyContent: 'center' }}>
                          <Ionicons name="barbell-outline" size={20} color={workoutPalette.strong} />
                        </View>
                      )}
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.libraryItemName, { color: themeColors.textPrimary }]}>{ex.name}</Text>
                        <Text style={[styles.libraryItemMeta, { color: workoutPalette.strong }]}>
                          {String(ex.primary_muscle ?? '').replace(/_/g, ' ')}
                          {Array.isArray(ex.secondary_muscles) && ex.secondary_muscles.length ? ` · ${ex.secondary_muscles.join(', ')}` : ''}
                        </Text>
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
              <TouchableOpacity onPress={() => setShowTrainerModal(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={themeColors.textMuted} />
              </TouchableOpacity>
            </View>
            </FadeInView>

            {chatTopic === null ? (
              /* ── Topic Picker — unified coach, no mode toggle ── */
              <View style={{ flex: 1, paddingHorizontal: 16, paddingTop: 16 }}>
                <Text style={[styles.trainerHint, { color: themeColors.textSecondary, marginBottom: 16 }]}>
                  What can I help with?
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
                  {([
                    { key: 'change_plan', label: 'Swap Exercise', icon: 'swap-horizontal-outline' as const, mode: 'trainer' as const },
                    { key: 'change_goal', label: 'Change Goal', icon: 'flag-outline' as const, mode: 'trainer' as const },
                    { key: 'change_meals', label: 'Modify Meals', icon: 'nutrition-outline' as const, mode: 'nutritionist' as const },
                    { key: 'log_activity', label: 'Log Activity', icon: 'create-outline' as const, mode: 'trainer' as const },
                    { key: 'log_food', label: 'Log Food', icon: 'cafe-outline' as const, mode: 'nutritionist' as const },
                    { key: 'report_injury', label: 'Report Injury', icon: 'bandage-outline' as const, mode: 'trainer' as const },
                    { key: 'general', label: 'General Questions', icon: 'help-circle-outline' as const, mode: 'trainer' as const },
                  ]).map(t => (
                    <TouchableOpacity
                      key={t.key}
                      style={{
                        width: '47%',
                        paddingVertical: 16,
                        paddingHorizontal: 12,
                        borderRadius: 12,
                        backgroundColor: themeColors.surfaceRaised,
                        borderWidth: 1,
                        borderColor: themeColors.border,
                        alignItems: 'center',
                        gap: 6,
                      }}
                      activeOpacity={0.7}
                      onPress={() => { setCoachMode(t.mode); setChatTopic(t.key); }}
                    >
                      <Ionicons name={t.icon} size={24} color={themeColors.primary} />
                      <Text style={{ color: themeColors.textPrimary, fontSize: 13, fontWeight: '600', textAlign: 'center' }}>{t.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {/* Coach check-in — lives under the topic grid so users have
                    one clear entry point to rate how they're doing. Opens the
                    CoachCheckinModal (doesn't start a chat thread). */}
                <TouchableOpacity
                  style={[styles.checkinCard, { backgroundColor: themeColors.surface, borderColor: themeColors.border, marginHorizontal: 0, marginTop: 24 }]}
                  onPress={() => {
                    // React Native can't reliably stack a second <Modal>
                    // on top of an already-open one (iOS silently drops
                    // the new modal). Close the trainer sheet first,
                    // then open the check-in on the next tick.
                    setShowTrainerModal(false);
                    setTimeout(() => setShowCheckin(true), 350);
                  }}
                  activeOpacity={0.8}>
                  <View style={styles.checkinCardIconWrap}>
                    <Text style={styles.checkinCardIcon}>🩺</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.checkinCardTitle, { color: themeColors.textPrimary }]}>Check in with coach</Text>
                    <Text style={[styles.checkinCardSub, { color: themeColors.textSecondary }]}>15-second rate — no typing needed.</Text>
                  </View>
                  <Text style={[styles.checkinCardChevron, { color: themeColors.textMuted }]}>›</Text>
                </TouchableOpacity>
              </View>
            ) : (
              /* ── Chat UI (topic selected) ──────────────────────── */
              <>
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, marginBottom: 4 }}>
                <TouchableOpacity onPress={() => setChatTopic(null)} style={{ paddingRight: 8 }}>
                  <Text style={{ color: themeColors.primary, fontSize: 15, fontWeight: '600' }}>{'\u2190'} Topics</Text>
                </TouchableOpacity>
                <Text style={[styles.trainerHint, { color: themeColors.textSecondary, flex: 1 }]}>
                  {chatTopic === 'change_plan' ? 'Change My Plan' : chatTopic === 'log_activity' ? 'Log Activity' : chatTopic === 'report_injury' ? 'Report Injury' : chatTopic === 'change_meals' ? 'Change My Meals' : chatTopic === 'log_food' ? 'Log Food' : 'General Question'}
                </Text>
              </View>

            {(coachMode === 'trainer' ? workoutUpdateSummary : nutritionUpdateSummary) && (
              <View style={[styles.trainerSummaryCard, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]}>
                <Text style={[styles.trainerSummaryTitle, { color: themeColors.primary }]}>{coachMode === 'nutritionist' ? 'Meal Plan Updated' : 'Workout Plan Updated'}</Text>
                <Text style={[styles.trainerSummaryText, { color: themeColors.textSecondary }]}>{coachMode === 'trainer' ? workoutUpdateSummary : nutritionUpdateSummary}</Text>
              </View>
            )}

            <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.trainerChatList} keyboardShouldPersistTaps="handled" onScrollBeginDrag={Keyboard.dismiss}>
              {(coachMode === 'trainer' ? workoutChat : nutritionChat).length === 0 ? (
                <View style={{ padding: 16, gap: 6 }}>
                  {(() => {
                    const topicHints: Record<string, { title: string; items: Array<{ icon: string; text: string }>; note: string }> = {
                      change_plan: {
                        title: 'Workout Modifications',
                        items: [
                          { icon: 'swap-horizontal-outline', text: '"Swap bench press for dumbbell press"' },
                          { icon: 'add-circle-outline', text: '"Add a core exercise to leg day"' },
                          { icon: 'remove-circle-outline', text: '"Remove the overhead press"' },
                          { icon: 'calendar-outline', text: '"Make it 5 days instead of 6"' },
                        ],
                        note: 'For day swaps (e.g. make tomorrow legs), use the Switch Day button on the workout card instead.',
                      },
                      change_goal: {
                        title: 'Change Your Goal',
                        items: [
                          { icon: 'flag-outline', text: '"Switch me to fat loss"' },
                          { icon: 'barbell-outline', text: '"I want to focus on strength"' },
                          { icon: 'trending-up-outline', text: '"Change to body recomp"' },
                        ],
                        note: 'This will regenerate your workout and nutrition plans to match the new goal.',
                      },
                      change_meals: {
                        title: 'Meal Plan Changes',
                        items: [
                          { icon: 'swap-horizontal-outline', text: '"Replace chicken with salmon for dinner"' },
                          { icon: 'nutrition-outline', text: '"Make breakfast higher protein"' },
                          { icon: 'leaf-outline', text: '"Suggest lower sugar alternatives"' },
                          { icon: 'restaurant-outline', text: '"I need a quick lunch idea"' },
                        ],
                        note: 'For macro targets (e.g. set protein to 200g), update in Foods > Targets section.',
                      },
                      log_food: {
                        title: 'Log What You Ate',
                        items: [
                          { icon: 'cafe-outline', text: '"I had a chicken salad for lunch"' },
                          { icon: 'fast-food-outline', text: '"Logged a burger and fries"' },
                        ],
                        note: 'For faster logging, check off meals on your plan or use the barcode scanner.',
                      },
                      report_injury: {
                        title: 'Report Pain or Injury',
                        items: [
                          { icon: 'bandage-outline', text: '"My lower back hurts when deadlifting"' },
                          { icon: 'alert-circle-outline', text: '"Sharp pain in my left shoulder"' },
                          { icon: 'medical-outline', text: '"My knee feels unstable on squats"' },
                        ],
                        note: 'I\'ll assess the injury and your plan will automatically update to avoid the affected area.',
                      },
                      log_activity: {
                        title: 'Log a Workout',
                        items: [
                          { icon: 'barbell-outline', text: '"I did legs today for 45 min"' },
                          { icon: 'bicycle-outline', text: '"30 min cycling this morning"' },
                        ],
                        note: 'For structured logging with sets/reps, use the Log Activity button on the Progress tab.',
                      },
                      general: {
                        title: 'General Questions',
                        items: [
                          { icon: 'help-circle-outline', text: '"How much protein do I need?"' },
                          { icon: 'leaf-outline', text: '"What are good sources of fiber?"' },
                          { icon: 'fitness-outline', text: '"Should I do cardio on rest days?"' },
                          { icon: 'water-outline', text: '"How much water should I drink?"' },
                        ],
                        note: 'Informational only — your plan won\'t be modified. For changes, use the specific topics above.',
                      },
                    };
                    const hint = topicHints[chatTopic ?? 'general'] ?? topicHints.general;
                    return (
                      <>
                        <Text style={{ fontSize: 14, fontWeight: '700', color: themeColors.textPrimary }}>{hint.title}</Text>
                        <View style={{ gap: 4 }}>
                          {hint.items.map(item => (
                            <View key={item.text} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                              <Ionicons name={item.icon as any} size={14} color={themeColors.textMuted} />
                              <Text style={{ fontSize: 12, color: themeColors.textSecondary }}>{item.text}</Text>
                            </View>
                          ))}
                        </View>
                        <Text style={{ fontSize: 10, color: themeColors.textMuted, marginTop: 4 }}>
                          {hint.note}
                        </Text>
                      </>
                    );
                  })()}
                  <Text style={[styles.trainerEmpty, { color: themeColors.textMuted, marginTop: 8 }]}>
                    {coachMode === 'nutritionist'
                      ? 'Try: "Replace dinner with a high-protein option under 500 calories."'
                      : 'Try: "My shoulder hurts on pressing — can you swap the bench press for something safer?"'}
                  </Text>
                </View>
              ) : (() => {
                // Display cap: show the 50 most recent messages.
                // Older turns remain in state so `conversation`
                // context sent to /ai/trainer-question still carries
                // the full history, just trimmed to the last 6 there.
                // This cap is purely visual — prevents the scroll
                // view from growing unbounded over a long session.
                const fullChat = coachMode === 'trainer' ? workoutChat : nutritionChat;
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
              </>
            )}
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

      {/* ── Bottom tab bar ────────────────────────────────────────────────
          Five top-level destinations. Each tab simply sets `activeTab`
          and the screen body re-renders the matching content block. */}
      <View style={[styles.bottomBar, { backgroundColor: themeColors.surface, borderTopColor: themeColors.border }]}>
        <BottomTabButton
          label="Goals"
          iconName="flag-outline"
          active={activeTab === 'goals'}
          tint={themeColors.primary}
          mutedColor={themeColors.textMuted}
          onPress={() => setActiveTab('goals')}
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
        paddingVertical: 7,
        paddingHorizontal: 10,
        borderRadius: 7,
        backgroundColor: active ? tint : 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      <Text style={{
        fontSize: 12,
        fontWeight: '700',
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
  label, iconName, active, tint, mutedColor, onPress,
}: {
  label: string;
  iconName: string;
  active: boolean;
  tint: string;
  mutedColor: string;
  onPress: () => void;
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
      <Ionicons
        name={(active ? iconName.replace('-outline', '') : iconName) as any}
        size={20}
        color={active ? tint : mutedColor}
        style={{ marginBottom: 2, opacity: active ? 1 : 0.7 }}
      />
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

// ── DayCard ───────────────────────────────────────────────────────────────────

function DayCard({ item, themeName, isToday, isCompleted, isSkipped, skipReason, completedSummary, expanded, onPress, onStartWorkout, onSkip, onUnskip, onChangeFocus, splitOptions, showSwitchOptions, onToggleSwitch }: {
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
  onChangeFocus?: (newFocus: string) => void;
  splitOptions?: string[];
  showSwitchOptions?: boolean;
  onToggleSwitch?: () => void;
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
      activeOpacity={0.8}>
      {(isToday || isCompleted) && (
        <View style={[styles.dayCardTopAccent, { backgroundColor: accentColor }]} />
      )}
      <View style={[styles.dayCardRow, { paddingTop: (isToday || isCompleted) ? 0 : 14 }]}>
        <View style={styles.dayCardLeft}>
          <Text style={[styles.dayCardDow, { color: isToday ? accentColor : tc.textSecondary }]}>{dow}</Text>
          <Text style={[styles.dayCardDate, { color: tc.textMuted }]}>{dateStr}</Text>
        </View>
        <View style={styles.dayCardRight}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={[styles.focusLabel, { color: tc.textPrimary }]}>{item.workout!.focus}</Text>
            {/* Stimulus badge — shows the training intent (strength/hypertrophy/volume/etc.)
                so the user knows what kind of session this is at a glance. */}
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
          </View>
          {(() => {
            const muscles = Array.from(new Set(
              item.workout!.exercises.map(ex => inferGroup(`${item.workout!.focus} ${ex.name}`))
            )).filter(g => g !== 'Other').slice(0, 3);
            const countText = `${item.workout!.exercises.length} exercises`;
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

      {expanded && (
        <View style={styles.expandedContent}>
          {isCompleted ? (
            <View style={{ gap: 10 }}>
              <View style={[styles.completedBanner, { backgroundColor: tc.success + '1A', borderColor: tc.success }]}>
                <Text style={[styles.completedBannerText, { color: tc.success }]}>Workout completed today!</Text>
              </View>
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
                    <Text style={{ fontSize: 13, color: tc.textMuted }}>·</Text>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>
                      ~{completedSummary.caloriesBurned} kcal
                    </Text>
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
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                        {splitOptions.filter(f => f !== item.workout?.focus).map(focus => (
                          <TouchableOpacity
                            key={focus}
                            style={{
                              paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10,
                              borderWidth: 1.5, borderColor: workoutPalette.strong + '55',
                              backgroundColor: tc.surface,
                            }}
                            onPress={() => { if (onToggleSwitch) onToggleSwitch(); onChangeFocus(focus); }}>
                            <Text style={{ fontSize: 14, fontWeight: '700', color: workoutPalette.strong }}>{focus}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>
                  )}
                </View>
              )}
              <PulseView active={isToday && !isCompleted} intensity={0.02} duration={2000}>
                <PressableScale
                  style={{ marginBottom: 14 }}
                  onPress={() => { import('../utils/feedback').then(f => f.hapticHeavy()).catch(() => {}); onStartWorkout(item.workout!); }}
                  accessibilityRole="button"
                  accessibilityLabel="Start workout">
                  <View style={[styles.startWorkoutBtn, { backgroundColor: workoutPalette.strong }]}>
                    <Ionicons name="play-circle" size={22} color="#fff" />
                    <Text style={styles.startWorkoutBtnText}>Start Workout</Text>
                  </View>
                </PressableScale>
              </PulseView>
              <WorkoutCard workout={item.workout!} themeName={themeName} />
              {isToday && (
                <TouchableOpacity style={styles.skipLink} onPress={() => onSkip(item.workout!.focus)}>
                  <Text style={[styles.skipLinkText, { color: tc.textMuted }]}>Skip today's workout</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </View>
      )}
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
    borderWidth: 1,
    padding: 14,
    marginBottom: 12,
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
  mealAccordionTitle: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  mealAccordionMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
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
