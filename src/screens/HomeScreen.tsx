import { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Modal, ActivityIndicator, Alert, TextInput, KeyboardAvoidingView, Platform, Linking, Image, Dimensions } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

const { width: SCREEN_W } = Dimensions.get('window');
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import { UserProfile, WorkoutPlan, DailyNutritionPlan, WorkoutDay, WorkoutSession, SupplementItem, InjuryEntry } from '../types';
import { generateWorkoutPlan, generateDailyNutritionForDate } from '../utils/planGenerator';
import { getWorkoutStatus, getDayState, upsertDayState, getExercises, askTrainerQuestion, lookupSupplement, lookupSupplementFromPhoto } from '../services/api';
import { useMetaData } from '../hooks/useMetaData';
import {
  isTodayWorkoutDone, todayKey, dateKey, loadWorkoutHistory, saveWorkoutSession, saveSkipToHistory, loadWorkoutSummaries,
  savePlanChange,
} from '../utils/workoutHistory';
import { PRIMARY_GOALS } from '../constants/goalConfig';
import { getMealChecks, saveMealChecks, MealChecks, getSavedNutritionPlan, saveNutritionPlan } from '../utils/mealTracker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MealSuggestion } from '../types';
import WorkoutCard from '../components/WorkoutCard';
import NutritionCard from '../components/NutritionCard';
import MealEditModal from '../components/MealEditModal';
import { colors, getTheme, radius } from '../constants/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MUSCLE_LIBRARY, MuscleEntry } from '../constants/muscleLibrary';

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
  onEditMealPlan: () => void;
  onEditThemes: () => void;
  onStartWorkout: (workout: WorkoutDay) => void;
  onViewProgress: () => void;
  onViewAccount: () => void;
  onWeeklyRefresh?: (review: { adherence: number; energy: number; notes?: string; pendingChanges?: any[] }) => void;
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
const LOGO_DARK   = require('../../assets/images/Fitness brand logo with apple symbol darkmode.png');
const LOGO_LIGHT_HEADER = require('../../assets/images/main_logo_header-removebg-preview.png');

function bgIsDark(hex: string): boolean {
  const h = hex.replace('#', '');
  if (h.length < 6) return true;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) < 0.5;
}

const SKIP_REASONS = [
  { emoji: '😴', label: 'Too tired' },
  { emoji: '🤕', label: 'Injury / Pain' },
  { emoji: '🤒', label: 'Feeling sick' },
  { emoji: '⏰', label: 'No time today' },
  { emoji: '✈️', label: 'Travelling' },
  { emoji: '🧘', label: 'Need more rest' },
  { emoji: '💼', label: 'Work conflict' },
  { emoji: '🌤️', label: 'Did something else' },
];

const TRAINING_DAY_SETS: Record<number, number[]> = {
  1: [1],
  2: [1, 4],
  3: [1, 3, 5],
  4: [1, 2, 4, 5],
  5: [1, 2, 3, 4, 5],
  6: [1, 2, 3, 4, 5, 6],
  7: [0, 1, 2, 3, 4, 5, 6],
};

function get7DaySchedule(workoutPlan: WorkoutPlan, daysPerWeek: number, skippedDates?: Set<string>): ScheduleItem[] {
  if (!workoutPlan?.days?.length) return [];
  const trainingSet = new Set(TRAINING_DAY_SETS[Math.min(Math.max(daysPerWeek, 1), 7)] ?? [1, 3, 5]);
  const today = new Date();
  const todayDow = today.getDay();
  const daysFromMon = todayDow === 0 ? 6 : todayDow - 1;

  // Count training days earlier this week that were NOT skipped
  let weekOffset = 0;
  for (let i = 0; i < daysFromMon; i++) {
    const dow = (i + 1) % 7;
    if (trainingSet.has(dow)) {
      const pastDate = new Date(today);
      pastDate.setDate(today.getDate() - (daysFromMon - i));
      if (!skippedDates?.has(dateKey(pastDate))) {
        weekOffset++;
      }
    }
  }

  const schedule: ScheduleItem[] = [];
  let workoutIdx = weekOffset;
  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    const dow = date.getDay();
    if (trainingSet.has(dow)) {
      schedule.push({ date, workout: workoutPlan.days[workoutIdx % workoutPlan.days.length], isRest: false });
      // Only advance the workout index if this day isn't skipped —
      // skipping pushes the workout to the next training day
      if (!skippedDates?.has(dateKey(date))) {
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

export default function HomeScreen({ authToken, userProfile, planRefreshKey = 0, isWorkoutUpdating = false, isNutritionUpdating = false, trainerNote: trainerNoteProp = null, nutritionistNote: nutritionistNoteProp = null, supplementStack: supplementStackProp = [], onSignOut, onEditGoal, onEditWorkout, onEditMealPlan, onEditThemes, onStartWorkout, onViewProgress, onViewAccount, onWeeklyRefresh }: HomeScreenProps) {
  const insets = useSafeAreaInsets();
  const meta = useMetaData();
  const theme = getTheme(userProfile?.themePreference);
  const themeColors = theme.colors;
  const workoutPalette = theme.sections.workout;
  const mealPalette = theme.sections.meals;
  const plannerPalette = theme.sections.planner;
  const aiPalette = theme.sections.ai;

  const [workoutPlan, setWorkoutPlan]     = useState<WorkoutPlan | null>(null);
  const [nutritionPlansByDate, setNutritionPlansByDate] = useState<Record<string, DailyNutritionPlan>>({});
  const [activeTab, setActiveTab]         = useState<'workout' | 'meals'>('workout');
  const [menuOpen, setMenuOpen]           = useState(false);
  const [expandedDay, setExpandedDay]     = useState<number>(-1);
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
  const [exerciseMuscleFilter, setExerciseMuscleFilter] = useState<string>('all');
  const [exerciseEquipmentFilter, setExerciseEquipmentFilter] = useState<string>('all');
  const [showTrainerModal, setShowTrainerModal] = useState(false);
  const [coachMode, setCoachMode] = useState<'trainer' | 'nutritionist'>('trainer');
  const [trainerInput, setTrainerInput] = useState('');
  const [trainerLoading, setTrainerLoading] = useState(false);
  const [isChatPlanUpdating, setIsChatPlanUpdating] = useState(false);
  const [attachedImage, setAttachedImage] = useState<{ base64: string; uri: string } | null>(null);
  const [workoutChat, setWorkoutChat] = useState<TrainerChatMessage[]>([]);
  const [nutritionChat, setNutritionChat] = useState<TrainerChatMessage[]>([]);
  const [workoutUpdateSummary, setWorkoutUpdateSummary] = useState<string | null>(null);
  const [nutritionUpdateSummary, setNutritionUpdateSummary] = useState<string | null>(null);

  // Completion + skip state
  const [todayDone, setTodayDone]         = useState(false);
  const [skippedDates, setSkippedDates]   = useState<Set<string>>(new Set());
  const [todaySummary, setTodaySummary]   = useState<import('../types').StoredWorkoutSummary | null>(null);

  // Skip reason modal
  const [skipReasonFocus, setSkipReasonFocus]         = useState<string | null>(null);
  const [selectedSkipReason, setSelectedSkipReason]   = useState('');
  const [customSkipReason, setCustomSkipReason]       = useState('');
  const [skipReasonsByDate, setSkipReasonsByDate]     = useState<Record<string, string>>({});

  // Meal tracking
  const [checkedMealsByDate, setCheckedMealsByDate] = useState<Record<string, MealChecks>>({});
  const [editingMeal, setEditingMeal] = useState<{ dateKey: string; type: string; meal: MealSuggestion } | null>(null);
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
  const [showTrainerNote, setShowTrainerNote] = useState(false);
  const [showWeeklyCheckin, setShowWeeklyCheckin] = useState(false);
  const [checkinAdherence, setCheckinAdherence] = useState(3); // 1-5
  const [checkinEnergy, setCheckinEnergy] = useState(3);       // 1-5
  const [checkinNotes, setCheckinNotes] = useState('');
  const [checkinInjuryStatuses, setCheckinInjuryStatuses] = useState<Record<string, InjuryEntry['status']>>({});

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
    if (userProfile) loadPlans(userProfile);
    loadDayStatus();
    // Check if a weekly review is due
    AsyncStorage.getItem('weekStartDate').then(async raw => {
      if (!raw) return;
      const daysSince = (Date.now() - new Date(raw).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince >= 7) {
        // Pre-populate injury statuses from current profile
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
  }, [userProfile, authToken, meta.allFoods.length, planRefreshKey]);

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
  }, [currentDate, userProfile, authToken, meta.allFoods.length]);

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

    // Load skip reasons from local history
    const history = await loadWorkoutHistory();
    const reasonMap: Record<string, string> = {};
    for (const s of history) {
      if (s.skipped && s.skipReason) reasonMap[s.date] = s.skipReason;
    }
    setSkipReasonsByDate(reasonMap);

    // Check workout completion from backend DB (not AsyncStorage)
    try {
      if (authToken) {
        const status = await getWorkoutStatus(authToken, today);
        setTodayDone(status.done);
      } else {
        // Fallback to local if no token
        setTodayDone(await isTodayWorkoutDone());
      }
    } catch {
      setTodayDone(await isTodayWorkoutDone());
    }

    // Load today's stored workout summary
    const summaries = await loadWorkoutSummaries();
    const todaySummaryEntry = summaries.find(s => s.date.startsWith(today)) ?? null;
    setTodaySummary(todaySummaryEntry);
  };

  const loadPlans = async (profile: UserProfile) => {
    // Check for an AI-generated plan saved after user saves plan settings
    const aiWorkoutRaw = await AsyncStorage.getItem('aiWorkoutPlan');
    const baseWorkout = aiWorkoutRaw ? JSON.parse(aiWorkoutRaw) : generateWorkoutPlan(profile);
    setWorkoutPlan(baseWorkout);

    // Load 3 rotating nutrition templates (A/B/C)
    const [rawA, rawB, rawC] = await Promise.all([
      AsyncStorage.getItem('aiNutritionPlanA'),
      AsyncStorage.getItem('aiNutritionPlanB'),
      AsyncStorage.getItem('aiNutritionPlanC'),
    ]);
    const templateA: DailyNutritionPlan | null = rawA ? JSON.parse(rawA) : null;
    const templateB: DailyNutritionPlan | null = rawB ? JSON.parse(rawB) : null;
    const templateC: DailyNutritionPlan | null = rawC ? JSON.parse(rawC) : null;
    const rotatingTemplates = [templateA, templateB, templateC].filter(Boolean) as DailyNutritionPlan[];

    const mealDays = getNextMealDays(7);

    /** Returns true only if meals carry real per-meal calorie data. */
    const hasMealMacros = (plan: DailyNutritionPlan | null | undefined): boolean => {
      if (!plan) return false;
      const meals = [plan.breakfast, plan.lunch, plan.dinner].filter(Boolean);
      return meals.length > 0 && meals.every(m => (m?.calories ?? 0) > 0);
    };

    const localEntries = await Promise.all(
      mealDays.map(async (d, i) => {
        // 1. Try backend day-state — only trust it if macros are present
        if (authToken) {
          const remote = await getDayState(authToken, d.key).catch(() => null) as any;
          if (remote?.nutrition_plan && hasMealMacros(remote.nutrition_plan)) {
            return [d.key, remote.nutrition_plan as DailyNutritionPlan] as const;
          }
        }
        // 2. Try locally saved plan (user's day-specific edits) — only if macros valid
        const saved = await getSavedNutritionPlan(d.key);
        if (saved && hasMealMacros(saved)) return [d.key, saved] as const;

        // 3. Rotate through AI templates A→B→C (i % 3)
        if (rotatingTemplates.length > 0) {
          const template = rotatingTemplates[i % rotatingTemplates.length];
          if (hasMealMacros(template)) return [d.key, template] as const;
        }

        // 4. Local generator fallback
        return [d.key, generateDailyNutritionForDate(profile, meta.allFoods, d.key)] as const;
      })
    );
    setNutritionPlansByDate(Object.fromEntries(localEntries));

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
    const result = await ImagePicker.launchCameraAsync({ quality: 0.7, base64: true, mediaTypes: ['images'] as any });
    if (result.canceled || !result.assets?.[0]?.base64) return;
    const asset = result.assets[0];
    setSuppAiLoading(true);
    setSuppAiResult(null);
    setSuppAiNotFound(false);
    setSuppAiQuery('');
    try {
      const res = await lookupSupplementFromPhoto(authToken, { image_base64: asset.base64!, mime_type: asset.mimeType ?? 'image/jpeg' });
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
      setExerciseLibrary(rows);
    } catch {
      setExerciseLibrary([]);
    } finally {
      setExerciseLibraryLoading(false);
    }
  }, [exerciseLibrary.length]);

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
      const recentHistory = workoutHistory.slice(0, 5).map((s) => ({
        date: s.date,
        focus: s.focus,
        durationSeconds: s.durationSeconds,
        completed: s.completed,
        skipped: s.skipped ?? false,
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
      const currentPlanContext = {
        workoutDays: (workoutPlan?.days ?? []).map(d => ({
          focus: d.focus,
          exercises: (d.exercises ?? []).map(e => ({ name: e.name, sets: e.sets, reps: e.reps })),
        })),
        todayMeals: todayPlan
          ? (['breakfast', 'lunch', 'dinner', 'snack'] as const)
              .map(type => {
                const m = todayPlan[type];
                return m ? { type, meal: m.meal, foods: m.foods ?? [], calories: m.calories ?? 0, protein: m.protein ?? 0 } : null;
              })
              .filter(Boolean) as Array<{ type: string; meal: string; foods: string[]; calories: number; protein: number }>
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
        equipment: userProfile.equipment,
        mealRoutine: userProfile.mealRoutine,
        injuries: userProfile.injuries,
        injuryEntries: userProfile.injuryEntries ?? [],
        experienceLevel: userProfile.experienceLevel,
      };

      const resp = await askTrainerQuestion(authToken, {
        question: q,
        mode: coachMode,
        profile: slimProfile,
        // Pass full workout plan so AI returns the correct structure (with 'days' key, not 'workoutDays')
        workoutPlan: coachMode === 'trainer' ? (workoutPlan ?? undefined) : undefined,
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

      // Enforce mode boundary — trainer can only update workout, nutritionist can only update nutrition
      const canUpdateWorkout   = coachMode === 'trainer';
      const canUpdateNutrition = coachMode === 'nutritionist';
      const hasUpdate = (canUpdateWorkout && !!resp.updated_workout_plan) || (canUpdateNutrition && !!resp.updated_nutrition_plan);
      console.log('[handleAskTrainer] plan update check:', { needs: resp.needs_plan_update, hasUpdate, canW: canUpdateWorkout, canN: canUpdateNutrition, hasWP: !!resp.updated_workout_plan, hasNP: !!resp.updated_nutrition_plan });
      if (resp.needs_plan_update && hasUpdate) {
        // Apply plan update asynchronously — answer is already visible
        setIsChatPlanUpdating(true);
        console.log('[handleAskTrainer] applying plan update...');
        try {
          const prevWorkout = workoutPlan;
          const nextWorkout = (canUpdateWorkout && resp.updated_workout_plan) ? resp.updated_workout_plan as WorkoutPlan : null;
          let appliedNutrition: DailyNutritionPlan | null = null;

          if (canUpdateWorkout && resp.updated_workout_plan) {
            const updatedPlan = resp.updated_workout_plan as WorkoutPlan;
            const prevDay1 = prevWorkout?.days?.[0]?.exercises?.map((e: any) => e.name).join(', ') ?? 'none';
            const nextDay1 = updatedPlan?.days?.[0]?.exercises?.map((e: any) => e.name).join(', ') ?? 'none';
            console.log('[handleAskTrainer] setting workout plan, days:', updatedPlan?.days?.length ?? 'no days key', 'prev day1:', prevDay1, 'next day1:', nextDay1);
            setWorkoutPlan(updatedPlan);
            await AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(updatedPlan));
            console.log('[handleAskTrainer] updated workout plan saved to AsyncStorage');
          }
          if (canUpdateNutrition && resp.updated_nutrition_plan) {
            const today = todayKey();
            // Merge partial update into existing plan — AI may only return changed meals
            const existingPlan = nutritionPlansByDate[today] ?? null;
            const partial = resp.updated_nutrition_plan as Partial<DailyNutritionPlan>;
            // Build merged plan — AI update takes precedence except for routine meals
            const baseMerge: DailyNutritionPlan = existingPlan
              ? { ...existingPlan, ...partial, targets: partial.targets ?? existingPlan.targets }
              : resp.updated_nutrition_plan as DailyNutritionPlan;
            // Re-stamp isRoutine from the existing plan so AI can't accidentally clear them
            const mealKeys = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
            const mergedPlan: DailyNutritionPlan = { ...baseMerge };
            if (existingPlan) {
              for (const k of mealKeys) {
                const existing = existingPlan[k] as any;
                const updated  = baseMerge[k] as any;
                if (existing?.isRoutine && updated) {
                  (mergedPlan as any)[k] = { ...updated, isRoutine: true };
                } else if (existing?.isRoutine && !updated) {
                  // AI removed a routine meal — restore it
                  (mergedPlan as any)[k] = existing;
                }
              }
            }
            appliedNutrition = mergedPlan;
            setNutritionPlansByDate(prev => ({ ...prev, [today]: mergedPlan }));
            await saveNutritionPlan(today, mergedPlan);
            await persistDayState(today, { nutrition_plan: mergedPlan });
            // Auto-reveal the updated plan
            setActiveTab('meals');
            setExpandedMealDays(prev => { const next = new Set(prev); next.add(today); return next; });
            console.log('[handleAskTrainer] updated nutrition plan saved to AsyncStorage (merged)');
          }
          if (resp.updated_workout_plan && !resp.updated_nutrition_plan) {
            setActiveTab('workout');
          }
          const changeSummary = summarizeTrainerUpdate(prevWorkout, nextWorkout, todayPlan, appliedNutrition);
          setUpdateSummary(changeSummary);
          const planLabel = coachMode === 'trainer' ? 'workout' : 'meal';
          setActiveChat(prev => [...prev, { role: 'assistant', content: `✅ Done! Your ${planLabel} plan has been updated. Close this chat to see the changes on your home screen.` }]);
          // Save to plan change history so user can review it in Progress
          await savePlanChange({
            id: Date.now().toString(),
            changedAt: new Date().toISOString(),
            changedBy: coachMode === 'trainer' ? 'trainer' : 'nutritionist',
            summary: changeSummary,
            question: q,
          });
        } catch (planErr: any) {
          console.error('[handleAskTrainer] plan application error:', planErr);
          setActiveChat(prev => [...prev, { role: 'assistant', content: 'I understood your request, but had trouble applying the plan changes. You can try asking again or edit your plan from the menu.' }]);
        } finally {
          setIsChatPlanUpdating(false);
        }
      }

      // Handle injury updates (trainer mode only)
      if (coachMode === 'trainer' && resp.updated_injuries && Array.isArray(resp.updated_injuries) && resp.updated_injuries.length > 0) {
        try {
          const profileRaw = await AsyncStorage.getItem('userProfile');
          if (profileRaw) {
            const storedProfile: UserProfile = JSON.parse(profileRaw);
            const existingEntries: InjuryEntry[] = storedProfile.injuryEntries ?? [];
            const incoming: InjuryEntry[] = resp.updated_injuries.map((inj: any) => ({
              id: inj.id || Date.now().toString() + Math.random().toString(36).slice(2),
              description: inj.description ?? '',
              bodyPart: inj.bodyPart ?? '',
              reportedAt: new Date().toISOString(),
              status: inj.status ?? 'active',
              notes: inj.notes,
            }));
            // Merge: replace entry if same id exists, otherwise append
            const merged = [...existingEntries];
            for (const entry of incoming) {
              const idx = merged.findIndex(e => e.id === entry.id);
              if (idx >= 0) merged[idx] = entry;
              else merged.push(entry);
            }
            const updatedProfile = { ...storedProfile, injuryEntries: merged };
            await AsyncStorage.setItem('userProfile', JSON.stringify(updatedProfile));
            console.log('[handleAskTrainer] updated injuryEntries saved:', merged.length, 'entries');
          }
        } catch (injErr) {
          console.error('[handleAskTrainer] failed to save injury update:', injErr);
        }
      }

      // Handle workout logging (trainer mode only)
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
            // If the logged workout is today, mark today as done
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
  }, [trainerInput, attachedImage, authToken, userProfile, workoutPlan, nutritionPlansByDate, todayDone, skippedDates, workoutChat, nutritionChat, coachMode, persistDayState]);

  const handleToggleMeal = useCallback(async (date: string, mealType: string) => {
    const current = checkedMealsByDate[date] ?? {};
    const next = { ...current, [mealType]: !current[mealType] };
    setCheckedMealsByDate(prev => ({ ...prev, [date]: next }));
    await saveMealChecks(date, next);
    await persistDayState(date, { meal_checks: next });
  }, [checkedMealsByDate, persistDayState]);

  const handleMealSave = useCallback(async (date: string, mealType: string, updated: MealSuggestion) => {
    let nextPlan: DailyNutritionPlan | null = null;
    setNutritionPlansByDate(prev => {
      const current = prev[date];
      if (!current) return prev;
      if (mealType === 'new_extra') {
        nextPlan = { ...current, extraMeals: [...(current.extraMeals ?? []), updated] };
      } else if (mealType.startsWith('extra_')) {
        const idx = parseInt(mealType.slice(6), 10);
        const extras = [...(current.extraMeals ?? [])];
        extras[idx] = updated;
        nextPlan = { ...current, extraMeals: extras };
      } else {
        nextPlan = { ...current, [mealType]: updated } as DailyNutritionPlan;
      }
      return { ...prev, [date]: nextPlan as DailyNutritionPlan };
    });
    if (nextPlan) await saveNutritionPlan(date, nextPlan);
    if (nextPlan) await persistDayState(date, { nutrition_plan: nextPlan });
  }, [persistDayState]);

  const handleAddSnack = useCallback((date: string) => {
    const emptyMeal: MealSuggestion = { meal: 'Extra Meal', foods: [], calories: 0, protein: 0, carbs: 0, fat: 0 };
    setEditingMeal({ dateKey: date, type: 'new_extra', meal: emptyMeal });
  }, []);

  const handleRemoveMeal = useCallback(async (date: string, mealType: string) => {
    let nextPlan: DailyNutritionPlan | null = null;
    setNutritionPlansByDate(prev => {
      const current = prev[date];
      if (!current) return prev;
      if (mealType.startsWith('extra_')) {
        const idx = parseInt(mealType.slice(6), 10);
        const extras = (current.extraMeals ?? []).filter((_, i) => i !== idx);
        nextPlan = { ...current, extraMeals: extras };
      } else {
        const removed = new Set(current.removedMeals ?? []);
        removed.add(mealType);
        nextPlan = { ...current, removedMeals: Array.from(removed) };
      }
      return { ...prev, [date]: nextPlan as DailyNutritionPlan };
    });
    if (nextPlan) await saveNutritionPlan(date, nextPlan);
    if (nextPlan) await persistDayState(date, { nutrition_plan: nextPlan });
  }, [persistDayState]);

  const handleRestoreMeal = useCallback(async (date: string, mealType: string) => {
    let nextPlan: DailyNutritionPlan | null = null;
    setNutritionPlansByDate(prev => {
      const current = prev[date];
      if (!current) return prev;
      const removed = (current.removedMeals ?? []).filter(m => m !== mealType);
      nextPlan = { ...current, removedMeals: removed };
      return { ...prev, [date]: nextPlan as DailyNutritionPlan };
    });
    if (nextPlan) await saveNutritionPlan(date, nextPlan);
    if (nextPlan) await persistDayState(date, { nutrition_plan: nextPlan });
  }, [persistDayState]);


  const handleToggleRoutine = useCallback(async (date: string, mealType: string) => {
    let nextPlan: DailyNutritionPlan | null = null;
    setNutritionPlansByDate(prev => {
      const current = prev[date];
      if (!current) return prev;
      const meal = (current as any)[mealType] as MealSuggestion | undefined;
      if (!meal) return prev;
      nextPlan = { ...current, [mealType]: { ...meal, isRoutine: !meal.isRoutine } } as DailyNutritionPlan;
      return { ...prev, [date]: nextPlan as DailyNutritionPlan };
    });
    if (nextPlan) await saveNutritionPlan(date, nextPlan);
    if (nextPlan) await persistDayState(date, { nutrition_plan: nextPlan });
  }, [persistDayState]);

  const handleSkipToday = useCallback((focus: string) => {
    setSelectedSkipReason('');
    setCustomSkipReason('');
    setSkipReasonFocus(focus);
  }, []);

  const confirmSkip = useCallback(async () => {
    const focus = skipReasonFocus;
    if (!focus) return;
    const reason = customSkipReason.trim() || selectedSkipReason || undefined;
    setSkipReasonFocus(null);
    setSelectedSkipReason('');
    setCustomSkipReason('');
    const today = todayKey();
    setSkippedDates(prev => new Set([...prev, today]));
    if (reason) setSkipReasonsByDate(prev => ({ ...prev, [today]: reason }));
    await persistDayState(today, { skipped_focus: focus });
    await saveSkipToHistory(today, focus, reason);
  }, [skipReasonFocus, selectedSkipReason, customSkipReason, persistDayState]);

  const handleUnskipDay = useCallback(async (date: string) => {
    setSkippedDates(prev => {
      const next = new Set(prev);
      next.delete(date);
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
  const schedule  = workoutPlan?.days?.length ? get7DaySchedule(workoutPlan, userProfile.daysPerWeek, skippedDates) : [];
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
        <View style={styles.headerLogoWrap}>
          <Image
            source={bgIsDark(themeColors.background) ? LOGO_DARK : LOGO_LIGHT_HEADER}
            style={bgIsDark(themeColors.background) ? styles.headerLogoDark : styles.headerLogo}
            resizeMode="contain"
          />
        </View>
        <View style={{ flex: 1 }} />
        <TouchableOpacity style={styles.menuBtn} onPress={() => setMenuOpen(true)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <View style={[styles.menuBar, { backgroundColor: themeColors.textPrimary }]} />
          <View style={[styles.menuBar, { backgroundColor: themeColors.textPrimary }]} />
          <View style={[styles.menuBar, { backgroundColor: themeColors.textPrimary }]} />
        </TouchableOpacity>
      </LinearGradient>

      {/* AI plan updating — full overlay only when both sides regenerate simultaneously */}
      {isWorkoutUpdating && isNutritionUpdating ? (
        <View style={[styles.planLoadingOverlay, { backgroundColor: themeColors.background }]}>
          <ActivityIndicator size="large" color={themeColors.primary} />
          <Text style={[styles.planLoadingTitle, { color: themeColors.textPrimary }]}>Building your new plan</Text>
          <Text style={[styles.planLoadingSubtitle, { color: themeColors.textSecondary }]}>
            AI is generating a personalized workout and meal plan based on your settings…
          </Text>
        </View>
      ) : null}

      {/* Chat-triggered plan update — slim inline banner */}
      {isChatPlanUpdating && !isWorkoutUpdating && !isNutritionUpdating ? (
        <View style={[styles.chatPlanUpdateBanner, { backgroundColor: themeColors.primary + '18', borderBottomColor: themeColors.primary + '33' }]}>
          <ActivityIndicator size="small" color={themeColors.primary} />
          <Text style={[styles.chatPlanUpdateText, { color: themeColors.primary }]}>Applying plan updates…</Text>
        </View>
      ) : null}

      {/* Tab toggle — pill style */}
      {!(isWorkoutUpdating && isNutritionUpdating) && <View style={[styles.tabs, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'workout' && [styles.tabActive, { backgroundColor: workoutPalette.strong }]]}
          onPress={() => setActiveTab('workout')}
          activeOpacity={0.8}>
          <Text style={[styles.tabText, { color: activeTab === 'workout' ? '#FFFFFF' : themeColors.textMuted }]}>
            Workout{workoutUpdateSummary ? '  •' : ''}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'meals' && [styles.tabActive, { backgroundColor: mealPalette.strong }]]}
          onPress={() => setActiveTab('meals')}
          activeOpacity={0.8}>
          <Text style={[styles.tabText, { color: activeTab === 'meals' ? '#FFFFFF' : themeColors.textMuted }]}>
            Meals{nutritionUpdateSummary ? '  •' : ''}
          </Text>
        </TouchableOpacity>
      </View>}

      {/* Tab content */}
      {!(isWorkoutUpdating && isNutritionUpdating) && <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {activeTab === 'workout' ? (
          isWorkoutUpdating ? (
            <View style={[styles.tabPlanLoadingFull, { backgroundColor: themeColors.background }]}>
              <ActivityIndicator size="large" color={workoutPalette.strong} />
              <Text style={[styles.planLoadingTitle, { color: themeColors.textPrimary }]}>Rebuilding your workout plan</Text>
              <Text style={[styles.planLoadingSubtitle, { color: themeColors.textSecondary }]}>Generating a new schedule based on your updated equipment…</Text>
            </View>
          ) : (
          <>
            <SectionBar
              icon="🏋️"
              label="This Week"
              subtitle={`${schedule.filter(s => !s.isRest).length} workouts planned`}
              palette={workoutPalette}
            />

            {/* Trainer plan note — only shown when a note exists */}
            {trainerNote ? (
              <TouchableOpacity
                style={[styles.planNoteRow, { backgroundColor: workoutPalette.soft, borderColor: workoutPalette.strong + '55' }]}
                onPress={() => setShowTrainerNote(true)}
                activeOpacity={0.75}>
                <View style={[styles.planNoteIconWrap, { backgroundColor: workoutPalette.strong + '22' }]}>
                  <Text style={styles.planNoteIcon}>📋</Text>
                </View>
                <View style={styles.planNoteBody}>
                  <Text style={[styles.planNoteTitle, { color: workoutPalette.text }]}>Trainer's Plan Explanation</Text>
                  <Text style={[styles.planNoteSub, { color: workoutPalette.text + 'AA' }]}>Why your trainer built this workout structure</Text>
                </View>
                <Text style={[styles.planNoteChevron, { color: workoutPalette.strong }]}>›</Text>
              </TouchableOpacity>
            ) : null}

            {(availabilityItems.length > 0 || cardioProfile) && (
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
            {schedule.map((item, i) => {
              const key = dateKey(item.date);
              const isToday     = i === 0;
              const isCompleted = isToday && todayDone;
              const isSkipped   = skippedDates.has(key);
              return (
                <DayCard
                  key={i}
                  item={item}
                  themeName={userProfile.themePreference}
                  isToday={isToday}
                  isCompleted={isCompleted}
                  isSkipped={isSkipped}
                  skipReason={skipReasonsByDate[key]}
                  completedSummary={isCompleted ? todaySummary : null}
                  expanded={expandedDay === i}
                  onPress={() => setExpandedDay(expandedDay === i ? -1 : i)}
                  onStartWorkout={onStartWorkout}
                  onSkip={handleSkipToday}
                  onUnskip={() => handleUnskipDay(key)}
                />
              );
            })}
          </>
          )
        ) : (
          isNutritionUpdating ? (
            <View style={[styles.tabPlanLoadingFull, { backgroundColor: themeColors.background }]}>
              <ActivityIndicator size="large" color={mealPalette.strong} />
              <Text style={[styles.planLoadingTitle, { color: themeColors.textPrimary }]}>Rebuilding your meal plan</Text>
              <Text style={[styles.planLoadingSubtitle, { color: themeColors.textSecondary }]}>Generating a new meal plan based on your updated foods…</Text>
            </View>
          ) : (
          <>
            <SectionBar
              icon="🥗"
              label="Meal Plan"
              subtitle="7 days"
              palette={mealPalette}
            />

            {/* Nutritionist plan note — only shown when a note exists */}
            {nutritionistNote ? (
              <TouchableOpacity
                style={[styles.planNoteRow, { backgroundColor: mealPalette.soft, borderColor: mealPalette.strong + '55' }]}
                onPress={() => setShowNutritionistNote(true)}
                activeOpacity={0.75}>
                <View style={[styles.planNoteIconWrap, { backgroundColor: mealPalette.strong + '22' }]}>
                  <Text style={styles.planNoteIcon}>🥗</Text>
                </View>
                <View style={styles.planNoteBody}>
                  <Text style={[styles.planNoteTitle, { color: mealPalette.text }]}>Nutritionist's Plan Explanation</Text>
                  <Text style={[styles.planNoteSub, { color: mealPalette.text + 'AA' }]}>Why your nutritionist chose this calorie & macro strategy</Text>
                </View>
                <Text style={[styles.planNoteChevron, { color: mealPalette.strong }]}>›</Text>
              </TouchableOpacity>
            ) : null}

            {mealDays.map((d, idx) => {
              const plan = nutritionPlansByDate[d.key];
              if (!plan) return null;
              const isExpanded = expandedMealDays.has(d.key);
              const meals = [plan.breakfast, plan.lunch, plan.dinner, plan.snack].filter(Boolean) as MealSuggestion[];
              const totalCalories = meals.reduce((sum, m) => sum + (m.calories ?? 0), 0);
              const mealPreview = [
                plan.breakfast ? '🌅' : null,
                plan.lunch     ? '🥗' : null,
                plan.dinner    ? '🍽️' : null,
                plan.snack     ? '🥜' : null,
              ].filter(Boolean).join('  ');
              return (
                <View key={d.key} style={[styles.mealAccordionCard, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
                  <TouchableOpacity
                    style={[styles.mealAccordionHeader, { backgroundColor: mealPalette.soft, borderBottomColor: mealPalette.strong + '30' }]}
                    onPress={() => setExpandedMealDays(prev => {
                      const next = new Set(prev);
                      if (next.has(d.key)) next.delete(d.key); else next.add(d.key);
                      return next;
                    })}
                    activeOpacity={0.8}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.mealAccordionTitle, { color: themeColors.textPrimary }]}>{mealDayLabel(d.date, idx)}</Text>
                      <Text style={[styles.mealAccordionMeta, { color: themeColors.textSecondary }]}>
                        {Math.round(totalCalories)} cal  ·  {mealPreview}
                      </Text>
                    </View>
                    <Text style={[styles.mealAccordionChevron, { color: themeColors.textMuted }]}>{isExpanded ? '▲' : '▼'}</Text>
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
                      onToggleRoutine={(mealType) => handleToggleRoutine(d.key, mealType)}
                    />
                  )}
                </View>
              );
            })}
          </>
          )
        )}
      </ScrollView>}

      {/* Meal edit modal */}
      {editingMeal && nutritionPlansByDate[editingMeal.dateKey] && (
        <MealEditModal
          visible={!!editingMeal}
          mealType={editingMeal.type}
          meal={editingMeal.meal}
          nutritionPlan={nutritionPlansByDate[editingMeal.dateKey]}
          allFoods={meta.allFoods}
          foodCategories={meta.foodCategories}
          savedMeals={userProfile.savedMeals ?? []}
          authToken={authToken}
          onSave={(updated) => handleMealSave(editingMeal.dateKey, editingMeal.type, updated)}
          onClose={() => setEditingMeal(null)}
        />
      )}

      {/* Settings modal */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setMenuOpen(false)}>
          <View style={[styles.menuDropdown, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
            <View style={[styles.menuHeadingRow, { borderBottomColor: themeColors.border }]}>
              <Text style={[styles.menuHeading, { color: themeColors.textMuted }]}>MENU</Text>
            </View>
            {[
              { label: 'Account',          onPress: onViewAccount },
              { label: 'View Progress',    onPress: onViewProgress },
              { label: 'Edit Goal',        onPress: onEditGoal },
              { label: 'Edit Workout',     onPress: onEditWorkout },
              { label: 'Edit Meal Plan',   onPress: onEditMealPlan },
              { label: 'Themes',           onPress: onEditThemes },
            ].map((item, idx, arr) => (
              <View key={item.label}>
                <TouchableOpacity style={styles.menuItem} onPress={() => { setMenuOpen(false); item.onPress(); }}>
                  <Text style={[styles.menuItemText, { color: themeColors.textPrimary }]}>{item.label}</Text>
                  <Text style={[styles.menuItemChevron, { color: themeColors.textMuted }]}>›</Text>
                </TouchableOpacity>
                {idx < arr.length - 1 && <View style={[styles.menuDivider, { backgroundColor: themeColors.border }]} />}
              </View>
            ))}
            <View style={[styles.menuDivider, { backgroundColor: themeColors.border }]} />
            <TouchableOpacity style={styles.menuItem} onPress={() => { setMenuOpen(false); onSignOut(); }}>
              <Text style={[styles.menuItemText, { color: themeColors.error }]}>Sign Out</Text>
              <Text style={[styles.menuItemChevron, { color: themeColors.error + '80' }]}>›</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal visible={showExerciseLibrary} transparent animationType="slide" onRequestClose={() => {
        if (selectedExercise) { setSelectedExercise(null); return; }
        if (selectedMuscle) { setSelectedMuscle(null); return; }
        setShowExerciseLibrary(false);
      }}>
        <View style={styles.libraryBackdrop}>
          <View style={[styles.librarySheet, { backgroundColor: themeColors.surface, borderTopColor: themeColors.border }]}>

            {/* Header */}
            <View style={styles.libraryHeader}>
              <Text style={[styles.libraryTitle, { color: themeColors.textPrimary }]}>
                {selectedExercise ? selectedExercise.name : selectedMuscle ? selectedMuscle.name : 'Library'}
              </Text>
              <TouchableOpacity onPress={() => {
                if (selectedExercise) { setSelectedExercise(null); return; }
                if (selectedMuscle) { setSelectedMuscle(null); return; }
                setShowExerciseLibrary(false);
              }}>
                <Text style={[styles.libraryClose, { color: themeColors.primary }]}>
                  {selectedExercise || selectedMuscle ? '← Back' : 'Close'}
                </Text>
              </TouchableOpacity>
            </View>

            {/* Tab bar — only show when not in detail view */}
            {!selectedExercise && !selectedMuscle && (
              <View style={[styles.libTabBar, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]}>
                <TouchableOpacity
                  style={[styles.libTab, libraryActiveTab === 'exercises' && { borderBottomColor: workoutPalette.strong }]}
                  onPress={() => setLibraryActiveTab('exercises')}>
                  <Text style={[styles.libTabText, { color: libraryActiveTab === 'exercises' ? workoutPalette.strong : themeColors.textMuted }]}>Exercises</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.libTab, libraryActiveTab === 'muscles' && { borderBottomColor: aiPalette.strong }]}
                  onPress={() => setLibraryActiveTab('muscles')}>
                  <Text style={[styles.libTabText, { color: libraryActiveTab === 'muscles' ? aiPalette.strong : themeColors.textMuted }]}>Muscles</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* ── EXERCISE DETAIL ──────────────────────────────────────────────── */}
            {selectedExercise ? (
              <ScrollView contentContainerStyle={styles.detailContent}>
                {(() => {
                  const guide = buildExerciseGuide(selectedExercise);
                  return (
                    <>
                      <View style={[styles.detailTopCard, { backgroundColor: workoutPalette.soft, borderColor: workoutPalette.strong + '40' }]}>
                        <Text style={[styles.detailMeta, { color: workoutPalette.text }]}>Primary: {humanizeToken(selectedExercise.primary_muscle)}</Text>
                        {selectedExercise.secondary_muscles?.length ? (
                          <Text style={[styles.detailMeta, { color: workoutPalette.text + 'BB' }]}>Also hits: {selectedExercise.secondary_muscles.map(humanizeToken).join(', ')}</Text>
                        ) : null}
                        {selectedExercise.equipment ? <Text style={[styles.detailMeta, { color: workoutPalette.text + 'BB' }]}>Equipment: {humanizeToken(selectedExercise.equipment)}</Text> : null}
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
                <View style={[styles.detailTopCard, { backgroundColor: selectedMuscle.tagColor + '22', borderColor: selectedMuscle.tagColor + '55' }]}>
                  <Text style={{ fontSize: 40, textAlign: 'center', marginBottom: 6 }}>{selectedMuscle.emoji}</Text>
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
                  <TextInput
                    value={exerciseSearch}
                    onChangeText={setExerciseSearch}
                    placeholder="Search exercises, muscles, or equipment"
                    placeholderTextColor={themeColors.textMuted}
                    style={[styles.librarySearchInput, { backgroundColor: themeColors.background, borderColor: themeColors.border, color: themeColors.textPrimary }]}
                  />

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
                  ) : filteredExerciseLibrary.map((ex) => (
                    <TouchableOpacity key={String(ex.id ?? ex.name)} style={[styles.libraryItem, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]} activeOpacity={0.8} onPress={() => setSelectedExercise(ex)}>
                      <Text style={[styles.libraryItemName, { color: themeColors.textPrimary }]}>{ex.name}</Text>
                      <Text style={[styles.libraryItemMeta, { color: workoutPalette.strong }]}>
                        {String(ex.primary_muscle ?? '').replace(/_/g, ' ')}
                        {Array.isArray(ex.secondary_muscles) && ex.secondary_muscles.length ? ` · ${ex.secondary_muscles.join(', ')}` : ''}
                      </Text>
                      {ex.description ? <Text style={[styles.libraryItemDesc, { color: themeColors.textSecondary }]}>{ex.description}</Text> : null}
                      <Text style={[styles.libraryItemLink, { color: themeColors.accent }]}>Tap for form guide →</Text>
                    </TouchableOpacity>
                  ))}
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
                        <View style={[styles.muscleItemEmoji, { backgroundColor: muscle.tagColor + '22' }]}>
                          <Text style={{ fontSize: 22 }}>{muscle.emoji}</Text>
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
      </Modal>

      <Modal visible={showTrainerModal} animationType="slide" transparent onRequestClose={() => setShowTrainerModal(false)}>
        <KeyboardAvoidingView
          style={styles.trainerFullScreen}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
        >
          <View style={[styles.trainerSheet, { backgroundColor: themeColors.surface, borderTopColor: themeColors.border }]}>
            <View style={[styles.sheetHandle, { backgroundColor: themeColors.border }]} />
            <View style={styles.libraryHeader}>
              <Text style={[styles.libraryTitle, { color: themeColors.textPrimary }]}>AI Coach</Text>
              <TouchableOpacity onPress={() => setShowTrainerModal(false)}>
                <Text style={[styles.libraryClose, { color: themeColors.primary }]}>Close</Text>
              </TouchableOpacity>
            </View>

            {/* Mode picker */}
            <View style={[styles.coachModePicker, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]}>
              <TouchableOpacity
                style={[styles.coachModeBtn, coachMode === 'trainer' && { backgroundColor: workoutPalette.strong }]}
                onPress={() => setCoachMode('trainer')}
                activeOpacity={0.8}>
                <Text style={[styles.coachModeBtnText, { color: coachMode === 'trainer' ? '#FFFFFF' : themeColors.textSecondary }]}>
                  Workout Plan
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.coachModeBtn, coachMode === 'nutritionist' && { backgroundColor: mealPalette.strong }]}
                onPress={() => setCoachMode('nutritionist')}
                activeOpacity={0.8}>
                <Text style={[styles.coachModeBtnText, { color: coachMode === 'nutritionist' ? '#FFFFFF' : themeColors.textSecondary }]}>
                  Meal Plan
                </Text>
              </TouchableOpacity>
            </View>

            <Text style={[styles.trainerHint, { color: themeColors.textSecondary }]}>
              {coachMode === 'nutritionist'
                ? 'Your full meal plan is loaded. Say things like "swap my lunch for something lighter" or "I had a shake this morning — update breakfast." Changes apply immediately.'
                : 'Your full workout plan is loaded. Say things like "remove squats, my knee hurts" or "add more back work." Changes apply immediately.'}
            </Text>

            {(coachMode === 'trainer' ? workoutUpdateSummary : nutritionUpdateSummary) && (
              <View style={[styles.trainerSummaryCard, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]}>
                <Text style={[styles.trainerSummaryTitle, { color: themeColors.primary }]}>{coachMode === 'nutritionist' ? 'Meal Plan Updated' : 'Workout Plan Updated'}</Text>
                <Text style={[styles.trainerSummaryText, { color: themeColors.textSecondary }]}>{coachMode === 'trainer' ? workoutUpdateSummary : nutritionUpdateSummary}</Text>
              </View>
            )}

            <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.trainerChatList} keyboardShouldPersistTaps="handled">
              {(coachMode === 'trainer' ? workoutChat : nutritionChat).length === 0 ? (
                <Text style={[styles.trainerEmpty, { color: themeColors.textMuted }]}>
                  {coachMode === 'nutritionist'
                    ? 'Try: "Replace dinner with a high-protein option under 500 calories."'
                    : 'Try: "My shoulder hurts on pressing — can you swap the bench press for something safer?"'}
                </Text>
              ) : (
                (coachMode === 'trainer' ? workoutChat : nutritionChat).map((m, idx) => (
                  <View key={idx} style={[styles.trainerBubble, m.role === 'user' ? [styles.trainerBubbleUser, { backgroundColor: themeColors.primary, borderColor: themeColors.primary }] : [styles.trainerBubbleAssistant, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]]}>
                    <Text style={[styles.trainerBubbleText, { color: m.role === 'user' ? '#FFFFFF' : themeColors.textPrimary }]}>{m.content}</Text>
                  </View>
                ))
              )}
              {trainerLoading && (
                <View style={[styles.trainerBubble, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border, alignSelf: 'flex-start', maxWidth: '95%' }]}>
                  <ActivityIndicator size="small" color={themeColors.primary} />
                  <Text style={[styles.trainerBubbleText, { color: themeColors.textMuted, marginTop: 4 }]}>Thinking…</Text>
                </View>
              )}
              {isChatPlanUpdating && (
                <View style={[styles.trainerBubble, { backgroundColor: themeColors.primary + '22', borderColor: themeColors.primary + '55', alignSelf: 'flex-start', maxWidth: '95%', flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
                  <ActivityIndicator size="small" color={themeColors.primary} />
                  <Text style={[styles.trainerBubbleText, { color: themeColors.primary }]}>
                    Updating your {coachMode === 'trainer' ? 'workout' : 'meal'} plan…
                  </Text>
                </View>
              )}
            </ScrollView>

            {attachedImage && (
              <View style={styles.attachPreviewRow}>
                <Image source={{ uri: attachedImage.uri }} style={styles.attachPreview} />
                <TouchableOpacity onPress={() => setAttachedImage(null)} style={styles.attachRemoveBtn}>
                  <Text style={styles.attachRemoveText}>✕</Text>
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
                        const res = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.6, mediaTypes: ['images'] as any });
                        if (!res.canceled && res.assets?.[0]?.base64) {
                          setAttachedImage({ base64: res.assets[0].base64!, uri: res.assets[0].uri });
                        }
                      },
                    },
                    {
                      text: 'Photo Library', onPress: async () => {
                        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
                        if (!perm.granted) return;
                        const res = await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.6, mediaTypes: ['images'] as any });
                        if (!res.canceled && res.assets?.[0]?.base64) {
                          setAttachedImage({ base64: res.assets[0].base64!, uri: res.assets[0].uri });
                        }
                      },
                    },
                  ]);
                }}>
                <Text style={styles.trainerAttachIcon}>📷</Text>
              </TouchableOpacity>
              <TextInput
                value={trainerInput}
                onChangeText={setTrainerInput}
                placeholder={coachMode === 'nutritionist' ? 'Ask nutritionist...' : 'Ask trainer...'}
                placeholderTextColor={themeColors.textMuted}
                style={[styles.trainerInput, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border, color: themeColors.textPrimary }]}
                multiline
              />
              <TouchableOpacity style={[styles.trainerSendBtn, { backgroundColor: themeColors.primary }]} onPress={handleAskTrainer} disabled={trainerLoading}>
                {trainerLoading ? <ActivityIndicator size="small" color={themeColors.background} /> : <Text style={styles.trainerSendText}>Send</Text>}
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
                      <Text style={[styles.skipReasonChipText, { color: active ? themeColors.warning : themeColors.textSecondary }]}>
                        {r.emoji}  {r.label}
                      </Text>
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

              <View style={styles.skipReasonBtns}>
                <TouchableOpacity
                  style={[styles.skipReasonCancel, { borderColor: themeColors.border, backgroundColor: themeColors.surfaceRaised }]}
                  onPress={() => { setSkipReasonFocus(null); setSelectedSkipReason(''); setCustomSkipReason(''); }}>
                  <Text style={[styles.skipReasonCancelText, { color: themeColors.textSecondary }]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.skipReasonConfirm, { backgroundColor: themeColors.warning }]}
                  onPress={confirmSkip}>
                  <Text style={styles.skipReasonConfirmText}>Skip Workout</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>

      {/* Weekly Check-in Modal */}
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
                          ? { ...inj, status: checkinInjuryStatuses[inj.id] }
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
                    <TextInput
                      style={[styles.libSearch, { flex: 1, marginHorizontal: 0, marginBottom: 0, backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border, color: themeColors.textPrimary }]}
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
                      <Text style={{ fontSize: 18 }}>📷</Text>
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
                      <Text style={{ fontSize: 26 }}>💊</Text>
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
                      <Text style={{ fontSize: 12, color: themeColors.textMuted }}>⏱ <Text style={{ color: themeColors.textPrimary, fontWeight: '600' }}>{suppAiResult.timing}</Text></Text>
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
                    { key: 'all', label: 'All' },
                    { key: 'Protein', label: '🥛 Protein' },
                    { key: 'Performance', label: '⚡ Performance' },
                    { key: 'Recovery', label: '💪 Recovery' },
                    { key: 'Health', label: '❤️ Health' },
                    { key: 'Weight Management', label: '🔥 Weight' },
                    { key: 'Sleep & Stress', label: '😴 Sleep' },
                  ].map(({ key, label }) => (
                    <TouchableOpacity
                      key={key}
                      style={{
                        paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.full,
                        borderWidth: 1,
                        borderColor: suppLibCategory === key ? themeColors.primary : themeColors.border,
                        backgroundColor: suppLibCategory === key ? themeColors.primary + '22' : themeColors.surfaceRaised,
                      }}
                      onPress={() => setSuppLibCategory(key)}>
                      <Text style={{ fontSize: 12, fontWeight: '600', color: suppLibCategory === key ? themeColors.primary : themeColors.textMuted }}>
                        {label}
                      </Text>
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
              <Text style={[styles.noteModalIcon]}>🥗</Text>
              <View style={{ flex: 1 }}>
                <Text style={[styles.noteModalTitle, { color: themeColors.textPrimary }]}>From Your Nutritionist</Text>
                <Text style={[styles.noteModalSubtitle, { color: themeColors.textMuted }]}>Why this meal plan was chosen</Text>
              </View>
              <TouchableOpacity onPress={() => setShowNutritionistNote(false)}>
                <Text style={[styles.noteModalClose, { color: mealPalette.strong }]}>Done</Text>
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.noteModalBody}>
              {nutritionistNote ? (
                <Text style={[styles.noteModalText, { color: themeColors.textSecondary }]}>{nutritionistNote}</Text>
              ) : (
                <View style={[styles.noteModalEmpty, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]}>
                  <Text style={styles.noteModalEmptyIcon}>🌱</Text>
                  <Text style={[styles.noteModalEmptyTitle, { color: themeColors.textPrimary }]}>No note yet</Text>
                  <Text style={[styles.noteModalEmptyText, { color: themeColors.textSecondary }]}>
                    Once you generate an AI meal plan, your nutritionist will leave a note here explaining the calorie strategy and macro split rationale for your specific goal.
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
              <Text style={[styles.noteModalIcon]}>🏋️</Text>
              <View style={{ flex: 1 }}>
                <Text style={[styles.noteModalTitle, { color: themeColors.textPrimary }]}>From Your Trainer</Text>
                <Text style={[styles.noteModalSubtitle, { color: themeColors.textMuted }]}>Why this workout plan was built this way</Text>
              </View>
              <TouchableOpacity onPress={() => setShowTrainerNote(false)}>
                <Text style={[styles.noteModalClose, { color: workoutPalette.strong }]}>Done</Text>
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.noteModalBody}>
              {trainerNote ? (
                <Text style={[styles.noteModalText, { color: themeColors.textSecondary }]}>{trainerNote}</Text>
              ) : (
                <View style={[styles.noteModalEmpty, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]}>
                  <Text style={styles.noteModalEmptyIcon}>🏗️</Text>
                  <Text style={[styles.noteModalEmptyTitle, { color: themeColors.textPrimary }]}>No note yet</Text>
                  <Text style={[styles.noteModalEmptyText, { color: themeColors.textSecondary }]}>
                    Once you generate an AI workout plan, your trainer will leave a note here explaining the structure, why they picked these exercises, and how it targets your specific goal.
                  </Text>
                </View>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Floating AI chat button — purple/teal for AI identity */}
      <TouchableOpacity
        style={[styles.fab, { backgroundColor: aiPalette.strong }]}
        onPress={() => setShowTrainerModal(true)}
        activeOpacity={0.85}>
        <Image
          source={require('../../assets/images/Brain and speech bubble icon white.png')}
          style={styles.fabIcon}
          resizeMode="contain"
        />
      </TouchableOpacity>
    </LinearGradient>
  );
}

// ── SectionBar ────────────────────────────────────────────────────────────────

function SectionBar({
  icon, label, subtitle, palette,
}: {
  icon: string;
  label: string;
  subtitle?: string;
  palette: { soft: string; strong: string; text: string };
}) {
  return (
    <View style={[sbStyles.bar, { backgroundColor: palette.soft, borderColor: palette.strong + '40' }]}>
      <Text style={sbStyles.icon}>{icon}</Text>
      <Text style={[sbStyles.label, { color: palette.text }]}>{label}</Text>
      {subtitle && (
        <Text style={[sbStyles.subtitle, { color: palette.text + 'BB' }]}>{subtitle}</Text>
      )}
    </View>
  );
}

const sbStyles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginBottom: 10,
    borderWidth: 1,
  },
  icon:     { fontSize: 16 },
  label:    { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.8 },
  subtitle: { fontSize: 12, fontWeight: '500', flex: 1, textAlign: 'right' },
});

// ── DayCard ───────────────────────────────────────────────────────────────────

function DayCard({ item, themeName, isToday, isCompleted, isSkipped, skipReason, completedSummary, expanded, onPress, onStartWorkout, onSkip, onUnskip }: {
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
}) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const workoutPalette = theme.sections.workout;
  const dow     = isToday ? 'Today' : DAY_NAMES[item.date.getDay()];
  const dateStr = `${MONTH_NAMES[item.date.getMonth()]} ${item.date.getDate()}`;

  // Rest day
  if (item.isRest) {
    return (
      <View style={[styles.dayCard, { backgroundColor: tc.surface, borderColor: isToday ? tc.primary + '88' : tc.border }]}>
        {isToday && <View style={[styles.dayCardTopAccent, { backgroundColor: tc.primary }]} />}
        <View style={[styles.dayCardRow, { paddingTop: isToday ? 0 : 14 }]}>
          <View style={styles.dayCardLeft}>
            <Text style={[styles.dayCardDow, { color: isToday ? tc.primary : tc.textSecondary }]}>{dow}</Text>
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
            <Text style={[styles.focusLabel, { color: tc.textPrimary }]}>{item.workout!.focus}</Text>
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

  // Accent color for today vs completed
  const accentColor = isCompleted ? tc.success : workoutPalette.strong;
  const borderColor = isCompleted ? tc.success + '88' : isToday ? workoutPalette.strong + '88' : tc.border;

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
          <Text style={[styles.focusLabel, { color: tc.textPrimary }]}>{item.workout!.focus}</Text>
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
              <View style={[styles.actionRow, { marginBottom: 14 }]}>
                <TouchableOpacity
                  style={[styles.startWorkoutBtn, { backgroundColor: workoutPalette.strong }]}
                  onPress={() => onStartWorkout(item.workout!)}>
                  <Text style={styles.startWorkoutBtnText}>▶  Start Workout</Text>
                </TouchableOpacity>
              </View>
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

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 8, paddingRight: 16, paddingBottom: 0, borderBottomWidth: 1 },
  headerLogoWrap: { width: 200, height: 60, justifyContent: 'center', alignItems: 'center', overflow: 'hidden' },
  headerLogo: { width: 200, height: 60 },
  headerLogoDark: { width: 270, height: 90 },
  greeting:            { fontSize: 26, fontWeight: '700', color: colors.textPrimary, marginBottom: 6 },
  headerBadgeRow:  { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 4 },
  goalBadge:       { backgroundColor: colors.surface, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 4, borderWidth: 1, borderColor: colors.primary },
  goalBadgeText:   { fontSize: 12, color: colors.primary, fontWeight: '600' },
  goalSubText:     { fontSize: 11, color: colors.textSecondary, marginTop: 2 },
  planLoadingOverlay: {
    flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, paddingHorizontal: 40,
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

  fab: {
    position: 'absolute',
    bottom: 28,
    right: 20,
    width: 76,
    height: 76,
    borderRadius: 38,
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
  scrollContent: { paddingHorizontal: 16, paddingBottom: 40 },

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
  startWorkoutBtn: { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', flex: 1 },
  startWorkoutBtnText: { color: colors.background, fontSize: 15, fontWeight: '700', letterSpacing: 0.3 },

  exerciseSummaryList:   { gap: 8 },
  exerciseSummaryRow:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  exerciseSummaryName:   { fontSize: 13, color: colors.textPrimary, fontWeight: '500', flex: 1 },
  exerciseSummaryDetail: { fontSize: 12, color: colors.primary, fontWeight: '600' },

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
    maxHeight: '78%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 14,
  },
  libraryHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 10 },
  libraryTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  libraryClose: { fontSize: 14, fontWeight: '700', color: colors.primary },
  libraryList: { paddingHorizontal: 16, paddingBottom: 28 },
  librarySearchInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.background,
    color: colors.textPrimary,
    marginBottom: 10,
  },
  libraryFilterRow: { gap: 8, paddingBottom: 10 },
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
