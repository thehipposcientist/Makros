import React, { useState, useEffect, useCallback, useMemo, useRef, useDeferredValue } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Pressable, Modal, ActivityIndicator, Alert, TextInput, KeyboardAvoidingView, Platform, Linking, Image, Dimensions, Keyboard, Animated, Switch, LayoutAnimation, UIManager, Easing, FlatList } from 'react-native';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
// Lazy reference to expo-image-picker — the underlying require() only runs
// on first ImagePicker.X access. Removes the module from the cold-start
// parse pass; every callsite is already async so the one-time resolve is
// invisible. Pattern parallels GearScreen's `await import('expo-image-picker')`
// but keeps every existing callsite unchanged.
const ImagePicker: typeof import('expo-image-picker') = (() => {
  let mod: any = null;
  return new Proxy({} as any, {
    get: (_t, prop) => {
      if (!mod) mod = require('expo-image-picker');
      return mod[prop as string];
    },
  });
})();
import { Ionicons } from '@expo/vector-icons';
import FadeInView from '../components/FadeInView';
import PulseView from '../components/PulseView';
import PressableScale from '../components/PressableScale';
import ShimmerLogo from '../components/ShimmerLogo';
import LogActivityModal from '../components/LogActivityModal';
import FriendsModal from '../components/FriendsModal';
import LiveActivityTracker from '../components/LiveActivityTracker';
import WorkoutTemplateBuilderModal from '../components/WorkoutTemplateBuilderModal';
import DetectedWorkoutsCard from '../components/DetectedWorkoutsCard';
import StreakCounter from '../components/StreakCounter';
import { WorkoutDaySkeleton } from '../components/SkeletonLoader';
import CollapsibleSection from '../components/CollapsibleSection';
import SwipeableRow from '../components/SwipeableRow';
import SocialAvatar from '../components/SocialAvatar';

const { width: SCREEN_W } = Dimensions.get('window');
const WATCH_WORKOUT_COMMAND_TTL_MS = 4 * 60 * 60_000;
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import { UserProfile, WorkoutPlan, DailyNutritionPlan, WorkoutDay, WorkoutSession, SupplementItem, InjuryEntry, MealRoutineEntry, MealRoutineFood, SavedWorkoutTemplate } from '../types';
import { buildExerciseGuide, humanizeToken } from '../utils/exerciseGuide';
import { generateWorkoutPlan, generateDailyNutritionForDate } from '../utils/planGenerator';
import { getWorkoutStatus, getDayState, upsertDayState, getExercises, askTrainerQuestion, lookupSupplement, lookupSupplementFromPhoto, logWorkoutDone, enrichFoodItems, logMealChecked, unlogMealChecked, getMe, updateEmail, classifyFoods, getHydration, logHydration, logHydrationDelta, getMealHistory, getNutritionScore, updateMeal, deleteLoggedMeal, syncInProgressWorkout } from '../services/api';
import type { ApplyActionResult, HydrationStatus, MealHistoryEntry } from '../services/api';
import { useMetaData } from '../hooks/useMetaData';
import {
  isTodayWorkoutDone, todayKey, dateKey, loadWorkoutHistory, saveWorkoutSession, saveSkipToHistory, loadWorkoutSummaries, loadHealthScore,
  savePlanChange, loadMealRoutines, saveMealRoutines, applyRoutines, applyRoutinesToAll,
  loadPreservedCompletedWorkouts,
  savePreservedCompletedWorkout,
  loadManualWorkoutOverrides,
  saveManualWorkoutOverride,
  deleteWorkoutSession,
  loadWorkoutTemplates,
  deleteWorkoutTemplate,
} from '../utils/workoutHistory';
import { workoutFromTemplateForToday } from '../utils/workoutTemplates';
import { workoutSessionToLoggedPayload } from '../utils/workoutLogPayload';
import { HYDRATION_QUICK_ADD_OUNCES, formatHydrationQuickAddLabel } from '../utils/hydration';
import { applyCachedHydrationDelta, loadCachedHydration, loadHydrationCache, pendingCachedHydrationRows, removeCachedHydration, saveCachedHydration } from '../utils/hydrationCache';
import { buildUserFoodCategories } from '../utils/customFoodSearch';
import { enqueueActiveWatchCommand, hasActiveWatchCommandConsumer, isActiveWorkoutWatchCommand } from '../utils/watchCommandBacklog';
import { applyWatchLogSetToActiveWorkoutStorage } from '../utils/watchWorkoutMirror';
import { coachApplyNeedsDayStatusRefresh, skippedDayBadgeLabel, skippedDayTitle, skippedDayUndoLabel } from '../utils/coachApplyState';
import { isExtraWorkoutActivitySession } from '../utils/workoutCompletion';
import { PRIMARY_GOALS } from '../constants/goalConfig';
import { getMealChecks, saveMealChecks, MealChecks, getSavedNutritionPlan, saveNutritionPlan, getPreservedMeals, savePreservedMeal, clearPreservedMeal, clearPreservedMealBySignature, getAllSavedNutritionPlans, getAllMealChecks } from '../utils/mealTracker';
import { setMealCheckedInChecksByDate, upsertMealInPlansByDate } from '../utils/mealPlanState';
import { ensureItems, migrateNutritionPlanShape, normalizeServingUnitsInPlan } from '../utils/mealItems';
import { cleanAiText } from '../utils/aiText';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MealSuggestion } from '../types';
import WorkoutCard from '../components/WorkoutCard';
import WorkoutFocusIcon from '../components/WorkoutFocusIcon';
import NutritionCard from '../components/NutritionCard';
import FuelingRecoveryCard from '../components/FuelingRecoveryCard';
import IncompleteDayBanner from '../components/IncompleteDayBanner';
import AdaptiveMacroCard from '../components/AdaptiveMacroCard';
import SavedMealsSection from '../components/SavedMealsSection';
import PlanSwapExerciseModal from '../components/PlanSwapExerciseModal';
import { exerciseEquipmentLabel } from '../utils/swapScoring';
import ExerciseVideoCard from '../components/ExerciseVideoCard';
import { exerciseThumbSmall, primeThumbnailIndex } from '../utils/exerciseThumb';
import { configureExpandAnimation } from '../utils/layoutAnim';
import { chooseSocialWorkoutFeedItem, compactSocialSetSummaries, formatSocialDistance, formatSocialDuration, socialWorkoutDateKey } from '../utils/socialWorkoutDetails';
import AnimatedCollapsible from '../components/AnimatedCollapsible';
import MealEditModal from '../components/MealEditModal';
import FormVideoModal from '../components/FormVideoModal';
import SupplementStackScreen from '../components/SupplementStackScreen';
import RecoveryCard from '../components/RecoveryCard';
import WeeklyCheckinCard from '../components/WeeklyCheckinCard';
import TrainingReadinessCard from '../components/TrainingReadinessCard';
import BirthdateBackfillCard from '../components/BirthdateBackfillCard';
import CycleGuidanceSection from '../components/home/CycleGuidanceSection';
import GroceryListModal from '../components/GroceryListModal';
import StreakConsistencyWidget from '../components/StreakConsistencyWidget';
import BirthdayBanner from '../components/BirthdayBanner';
import RecipeModal from '../components/RecipeModal';
import SearchInput from '../components/SearchInput';
import { APP_THEMES, THEME_PICKER_ORDER, colors, elevations, getChromeColors, getContrastingTextColor, getTheme, isLightThemeName, radius, resolveThemeName, typography } from '../constants/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// Inline-rendered tab content. Goals and Progress used to be modal
// overlays via parent callbacks; they now mount inside the tab body
// so the bottom nav stays pinned and feels like a single-page app.
import ProgressScreen from './ProgressScreen';
import EditProfileScreen from './EditProfileScreen';
import GearScreen from './GearScreen';
import { aggregateDailyFromHistory } from './progressData';
import type { DailyRowShape } from './progressData';
import { computeNutritionScore } from '../utils/nutritionScore';
import ErrorBoundary from '../components/ErrorBoundary';
import { setActiveWatchSessionId } from '../utils/activeWatchSession';
import { dynamicCompactTextProps, dynamicTextProps } from '../utils/dynamicType';
import { effectiveAge } from '../utils/age';
import { reduceWorkoutForCycleSymptoms } from '../utils/cycleSupport';
import {
  recommendReadinessWorkoutAdjustment,
  reduceWorkoutForReadiness,
  type ReadinessWorkoutRecommendation,
} from '../utils/readinessWorkoutAdjustment';
import type { LiveActivityInitialActivity } from '../utils/liveActivityQuickStart';
import { workoutPlanFromPlanWeek } from '../utils/planWeekProjection';
import { useManagedInterval } from '../hooks/useManagedInterval';
import {
  FREE_MEAL_ROUTINE_LIMIT,
  FREE_SAVED_MEAL_LIMIT,
  FREE_WORKOUT_TEMPLATE_LIMIT,
  canCreateMealRoutine,
  canCreateSavedMeal,
  tierOf,
} from '../utils/subscription';
import {
  INJURY_CHECKIN_STORAGE_KEY,
  activeInjuryEntries,
  applyInjuryCheckinResponse,
  findDueInjuryCheckins,
  markInjuryCheckinsAnswered,
  markInjuryCheckinsPrompted,
  parseInjuryCheckinState,
  type InjuryCheckinResponse,
  type InjuryCheckinState,
} from '../utils/injuryCheckins';
import { formatDistance, formatWeight, resolveDistanceUnit, resolveWeightUnit } from '../utils/units';
import { estimateWorkoutMinutes } from '../utils/workoutDurationEstimate';

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
  onStartWorkout: (workout: WorkoutDay, options?: { playCountdown?: boolean }) => void;
  onViewProgress: () => void;
  onViewAccount: () => void;
  onOpenSettings?: () => void;
  onHomeTabNavigate?: () => void;
  onProfileUpdate?: (changes: Partial<UserProfile>, skipRegen?: boolean) => void;
  onUpdateWeight?: (weightLbs: number, source?: 'manual' | 'watch') => void | Promise<void>;
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
  onCancelScheduledPlanChange?: (restoredProfile: UserProfile) => Promise<void> | void;
  /** Bubble the active PlanWeek's end_date up to the app root so the
   *  pending-save confirmation modal can show the correct "applies on"
   *  date (end_date + 1 = first day of the next plan week, on the
   *  user's sign-up cadence). HomeScreen calls this whenever planWeek
   *  state changes. Null when no active week exists. */
  onActivePlanWeekEndChange?: (endDate: string | null) => void;
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
  isCompleted?: boolean;
}

interface MealDay {
  key: string;
  date: Date;
}

type WeekStripState = 'planned' | 'done' | 'logged' | 'skipped' | 'rest' | 'today';

interface WeekStripItem {
  key: string;
  date: Date;
  title: string;
  state: WeekStripState;
}

type HydrationSummary = HydrationStatus;

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
  applyResult?: ApplyActionResult | null;
  undoAction?: Record<string, any> | null;
}

interface PendingPlanUpdate {
  resp: any;
  question: string;
  coachMode: 'trainer' | 'nutritionist';
  profileChanges: Partial<UserProfile>;  // detected from plan diff
  summary: string;                       // human-readable description
}

function summarizeApplyFields(fields: Record<string, any> | undefined): string[] {
  if (!fields) return [];
  return Object.entries(fields).flatMap(([key, value]) => {
    const label = humanizeToken(key);
    if (value && typeof value === 'object' && 'from' in value && 'to' in value) {
      const from = value.from == null ? 'default' : String(value.from);
      const to = value.to == null ? 'default' : String(value.to);
      return [`${label}: ${from} -> ${to}`];
    }
    if (Array.isArray(value)) return [`${label}: ${value.length}`];
    if (value == null) return [];
    return [`${label}: ${String(value)}`];
  }).slice(0, 4);
}

function e2eId(value: string | number | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
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
  gear?: Array<{ slug: string; name: string; category?: string; required?: boolean }>;
  is_compound?: boolean;
  image_url?: string | null;
  video_id?: string | null;
  movement_pattern?: string | null;
}

const ExerciseLibraryRow = React.memo(function ExerciseLibraryRow({
  item,
  themeColors,
  workoutPalette,
  onOpen,
  onPlayVideo,
}: {
  item: ExerciseLibraryItem;
  themeColors: any;
  workoutPalette: any;
  onOpen: (item: ExerciseLibraryItem) => void;
  onPlayVideo: (item: ExerciseLibraryItem) => void;
}) {
  const thumb = exerciseThumbSmall(item as any);
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={`Open ${item.name} exercise details`}
      style={[styles.libraryItem, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border, flexDirection: 'row', gap: 12, alignItems: 'center' }]}
      activeOpacity={0.8}
      onPress={() => onOpen(item)}
    >
      {thumb ? (
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={(e) => {
            e.stopPropagation();
            onPlayVideo(item);
          }}
          accessibilityRole="button"
          accessibilityLabel={`Play form video for ${item.name}`}
        >
          <View style={{ width: 48, height: 48, borderRadius: 10, backgroundColor: themeColors.surface, overflow: 'hidden', borderWidth: 2, borderColor: themeColors.border, position: 'relative' }}>
            <Image source={{ uri: thumb }} style={{ width: 48, height: 48 }} resizeMode="cover" />
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
        <Text style={[styles.libraryItemName, { color: themeColors.textPrimary }]} numberOfLines={1}>{item.name}</Text>
        <Text style={[styles.libraryItemMeta, { color: workoutPalette.strong }]} numberOfLines={1}>
          {humanizeToken(item.primary_muscle)}
          {Array.isArray(item.secondary_muscles) && item.secondary_muscles.length
            ? ` · also hits ${item.secondary_muscles.map(humanizeToken).join(', ')}`
            : ''}
        </Text>
        {Array.isArray((item as any).gear) && (item as any).gear.length > 0 ? (
          <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }} numberOfLines={1}>
            {((item as any).gear as Array<{ name: string }>).map(g => g.name).slice(0, 2).join(', ')}
          </Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={16} color={themeColors.textMuted} />
    </TouchableOpacity>
  );
});

const DAY_NAMES   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── Structured focus → muscle-group mapping ──────────────────────────────────
// Used for fatigue readiness lookups, focus-family normalization, and
// muscle-chip filtering instead of ad-hoc regex chains.
const FOCUS_MUSCLE_MAP: Record<string, string[]> = {
  push: ['chest', 'shoulders', 'triceps'],
  chest: ['chest', 'shoulders', 'triceps'],
  pull: ['back', 'biceps'],
  back: ['back', 'biceps'],
  legs: ['quads', 'hamstrings', 'glutes', 'calves'],
  lower: ['quads', 'hamstrings', 'glutes', 'calves'],
  upper: ['chest', 'back', 'shoulders', 'biceps', 'triceps'],
  full_body: ['chest', 'back', 'shoulders', 'quads', 'glutes', 'hamstrings'],
  shoulders: ['shoulders'],
  arms: ['biceps', 'triceps'],
  cardio: ['cardio'],
};

// Stimulus values that indicate a non-lifting (easy/recovery/mobility) day.
const EASY_STIMULUS = new Set(['conditioning', 'mobility', 'recovery']);

// Focus-string keywords mapped to normalized family keys for structured lookup.
// Order matters: first match wins when scanning focus strings.
const FOCUS_KEY_PATTERNS: [string, string][] = [
  ['push', 'push'], ['chest', 'chest'], ['pressing', 'push'],
  ['pull', 'pull'], ['back', 'back'], ['bicep', 'pull'], ['lat', 'pull'],
  ['legs', 'legs'], ['quad', 'legs'], ['hamstring', 'legs'], ['glute', 'legs'], ['lower', 'lower'],
  ['upper', 'upper'],
  ['full body', 'full_body'], ['full_body', 'full_body'], ['total', 'full_body'],
  ['shoulder', 'shoulders'],
  ['arms', 'arms'], ['arm', 'arms'],
  ['cardio', 'cardio'], ['zone', 'cardio'], ['interval', 'cardio'],
];

/** Resolve a focus string to its FOCUS_MUSCLE_MAP key via keyword match. */
function resolveFocusMuscleKey(focus: string): string | null {
  const lower = focus.toLowerCase();
  for (const [keyword, key] of FOCUS_KEY_PATTERNS) {
    if (lower.includes(keyword)) return key;
  }
  return null;
}

function workoutDayCardTitleTestID(focus: string | null | undefined): string {
  const lower = String(focus || '').toLowerCase();
  if (lower.includes('recover')) return 'workout-day-card-title-recovery';
  const rawKey = resolveFocusMuscleKey(lower);
  const key = rawKey === 'back' || rawKey === 'lats'
    ? 'pull'
    : rawKey === 'chest' || rawKey === 'shoulders' || rawKey === 'arms'
      ? 'push'
      : rawKey === 'lower'
        ? 'legs'
        : rawKey;
  return `workout-day-card-title-${key || 'unknown'}`;
}

// Focus keywords for the split-inference fallback when preferredSplit is missing.
const SPLIT_FOCUS_KEYWORDS: Record<string, string[]> = {
  bro: ['chest', 'back', 'shoulders', 'arms'],
  upper_lower: ['upper', 'lower'],
  full_body: ['full body', 'full_body'],
  ppl: ['push', 'pull'],
};

const CARDIO_DOMINANT_GOALS = new Set([
  'endurance',
  'cardio_endurance',
  ...PRIMARY_GOALS.filter(g => g.category === 'cardio_endurance').map(g => g.id),
]);

function isCardioDominantGoal(goal: string | null | undefined): boolean {
  const g = String(goal || '').toLowerCase().trim();
  return CARDIO_DOMINANT_GOALS.has(g)
    || /cardio|endurance|aerobic|vo2|stamina|running|cycling|rowing|swimming|hiking|5k|10k|marathon/.test(g);
}

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
const LOGO_DARK   = require('../../assets/images/thallo-logo-white-transparent-New.png');
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
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const [history, ah] = await Promise.all([
          import('../utils/workoutHistory'),
          import('../services/appleHealth'),
        ]);
        const isAvailable = ah.isHealthKitAvailable();
        setAvailable(isAvailable);
        const stored = await history.isAppleHealthEnabled();
        if (!isAvailable && stored) {
          await history.setAppleHealthEnabled(false);
          setEnabled(false);
        } else {
          setEnabled(stored);
        }
      } catch { setEnabled(false); }
    })();
  }, []);
  const onToggle = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const ah = await import('../services/appleHealth');
      const { setAppleHealthEnabled } = await import('../utils/workoutHistory');
      if (!ah.isHealthKitAvailable()) {
        await setAppleHealthEnabled(false);
        setEnabled(false);
        setAvailable(false);
        if (next) {
          Alert.alert('Not available', 'Apple Health is iPhone-only and requires HealthKit support. Thallo still works normally with manual logs and in-app workout tracking.');
        }
        setBusy(false);
        return;
      }
      setAvailable(true);
      if (next) {
        Alert.alert(
          ah.APPLE_HEALTH_PERMISSION_COPY.title,
          ah.APPLE_HEALTH_PERMISSION_COPY.body,
          [
            { text: 'Not now', style: 'cancel', onPress: () => setBusy(false) },
            {
              text: 'Continue',
              onPress: async () => {
                const granted = await ah.requestHealthPermissions();
                await setAppleHealthEnabled(granted);
                setEnabled(granted);
                if (!granted) {
                  const err = ah.getLastHealthKitError();
                  Alert.alert(
                    'Apple Health not connected',
                    `${ah.APPLE_HEALTH_PERMISSION_COPY.denied}\n\n${err ?? ''}`.trim(),
                  );
                }
                setBusy(false);
              },
            },
          ],
        );
        return;
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
          {available === false
            ? 'Unavailable on this device. Manual logs and in-app workouts still work.'
            : enabled === null
            ? 'Checking…'
            : enabled
              ? 'Optional sync adds sleep, HRV, weight, and workout context'
              : 'Optional enhancement for sleep, readiness, and workout context'}
        </Text>
      </View>
      <Switch
        value={enabled === true}
        disabled={busy || enabled === null || available === false}
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

function ReadinessAdjustmentBanner({
  recommendation,
  themeName,
  onLighten,
  onRecovery,
  onDismiss,
}: {
  recommendation: ReadinessWorkoutRecommendation;
  themeName?: string;
  onLighten: () => void;
  onRecovery: () => void;
  onDismiss: () => void;
}) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const isLightMode = isLightThemeName(theme.name);
  const tint = recommendation.kind === 'recovery' ? tc.error : tc.warning;
  const secondaryAction = recommendation.kind === 'recovery';
  return (
    <View style={{
      marginBottom: 10,
      padding: 12,
      borderRadius: 12,
      borderWidth: isLightMode ? StyleSheet.hairlineWidth : 1,
      borderColor: tint + '66',
      backgroundColor: tint + (isLightMode ? '0F' : '16'),
      gap: 10,
    }}>
      <View style={{ flexDirection: 'row', gap: 9, alignItems: 'flex-start' }}>
        <View style={{
          width: 30, height: 30, borderRadius: 15,
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: tint + '22',
        }}>
          <Ionicons name={recommendation.kind === 'recovery' ? 'leaf-outline' : 'speedometer-outline'} size={17} color={tint} />
        </View>
        <View style={{ flex: 1 }}>
          <Text {...dynamicTextProps} style={{ fontSize: 13, fontWeight: '900', color: tc.textPrimary }}>
            {recommendation.title}
          </Text>
          <Text {...dynamicTextProps} style={{ fontSize: 11, color: tc.textSecondary, lineHeight: 16, marginTop: 2 }}>
            {recommendation.detail}
          </Text>
        </View>
        <TouchableOpacity onPress={onDismiss} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="close" size={17} color={tc.textMuted} />
        </TouchableOpacity>
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TouchableOpacity
          onPress={onLighten}
          activeOpacity={0.8}
          style={{
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            paddingVertical: 9,
            borderRadius: 8,
            backgroundColor: tint,
          }}>
          <Ionicons name="options-outline" size={15} color={getContrastingTextColor(tint)} />
          <Text {...dynamicCompactTextProps} style={{ fontSize: 11, fontWeight: '900', color: getContrastingTextColor(tint) }}>
            Lighten Today
          </Text>
        </TouchableOpacity>
        {secondaryAction && (
          <TouchableOpacity
            onPress={onRecovery}
            activeOpacity={0.8}
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              paddingVertical: 9,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: tint + '88',
              backgroundColor: tc.surface,
            }}>
            <Ionicons name="leaf-outline" size={15} color={tint} />
            <Text {...dynamicCompactTextProps} style={{ fontSize: 11, fontWeight: '900', color: tint }}>
              Recovery Day
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
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

function mealDayLabel(date: Date, _index: number): string {
  // With the PlanWeek-dated meal strip, "today" is determined by the
  // date matching todayKey() — not by position. Past/future days fall
  // back to the weekday name + date (the date strip disambiguates).
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
  if (sameDay) return 'Today';
  return `${DAY_NAMES[date.getDay()]} · ${MONTH_NAMES[date.getMonth()]} ${date.getDate()}`;
}

function defaultConsumedAtForDate(dateISO: string): string {
  const now = new Date();
  const [year, month, day] = dateISO.split('-').map(Number);
  if (!year || !month || !day) return now.toISOString();
  const eatenAt = new Date(now);
  eatenAt.setFullYear(year, month - 1, day);
  return eatenAt.toISOString();
}

function consumedAtForMealDate(meal: Partial<MealSuggestion> | Record<string, any> | null | undefined, dateISO: string): string {
  const raw = meal?._consumedAt ?? (meal as any)?.consumed_at;
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return defaultConsumedAtForDate(dateISO);
}

function savedMealToSuggestion(saved: { id?: number; name: string; items?: any[]; total_calories?: number; total_protein_g?: number; total_carbs_g?: number; total_fat_g?: number }, consumedAt?: string, mealId?: number): MealSuggestion {
  const mappedItems = (saved.items || []).map((it: any) => {
    const qty = Number(it.quantity || 1);
    const cal = Number(it.calories || 0);
    const pro = Number(it.protein_g ?? it.protein ?? 0);
    const carbs = Number(it.carbs_g ?? it.carbs ?? 0);
    const fat = Number(it.fat_g ?? it.fat ?? 0);
    return {
      name: String(it.food_name || it.name || 'Item'),
      food_id: it.food_id ?? null,
      serving_id: it.serving_id ?? null,
      serving_grams: it.serving_grams ?? null,
      quantity: qty,
      unit: String(it.unit || 'serving'),
      calories: cal,
      protein: pro,
      carbs,
      fat,
      baseQuantity: qty > 0 ? qty : 1,
      baseCalories: cal,
      baseProtein: pro,
      baseCarbs: carbs,
      baseFat: fat,
    };
  });
  const itemTotals = mappedItems.reduce(
    (acc, it) => ({
      calories: acc.calories + Number(it.calories || 0),
      protein: acc.protein + Number(it.protein || 0),
      carbs: acc.carbs + Number(it.carbs || 0),
      fat: acc.fat + Number(it.fat || 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
  const totals = mappedItems.length > 0 ? itemTotals : {
    calories: Number(saved.total_calories || 0),
    protein: Number(saved.total_protein_g || 0),
    carbs: Number(saved.total_carbs_g || 0),
    fat: Number(saved.total_fat_g || 0),
  };
  const localId = mealId ? `saved_log_${mealId}` : `saved_${saved.id ?? 'meal'}_${Date.now()}`;
  return {
    meal: saved.name || 'Saved meal',
    name: saved.name || 'Saved meal',
    items: mappedItems as any,
    foods: mappedItems.map(it => it.name),
    amounts: mappedItems.map(it => `${it.quantity} ${it.unit}`),
    calories: totals.calories,
    protein: totals.protein,
    carbs: totals.carbs,
    fat: totals.fat,
    _localId: localId,
    _consumedAt: consumedAt,
    ...(mealId ? { _loggedMealId: mealId } : {}),
  } as MealSuggestion;
}

function mealHistoryEntryToSuggestion(entry: MealHistoryEntry): MealSuggestion {
  const mappedItems = (entry.items || []).map((it) => {
    const qty = Number(it.quantity || 1);
    const cal = Number(it.calories || 0);
    const pro = Number(it.protein_g || 0);
    const carbs = Number(it.carbs_g || 0);
    const fat = Number(it.fat_g || 0);
    return {
      name: String(it.food_name || 'Item'),
      food_id: it.food_id ?? null,
      serving_id: it.serving_id ?? null,
      serving_grams: it.serving_grams ?? null,
      quantity: qty,
      unit: String(it.unit || 'serving'),
      calories: cal,
      protein: pro,
      carbs,
      fat,
      baseQuantity: qty > 0 ? qty : 1,
      baseCalories: cal,
      baseProtein: pro,
      baseCarbs: carbs,
      baseFat: fat,
    };
  });
  const itemTotals = mappedItems.reduce(
    (acc, it) => ({
      calories: acc.calories + Number(it.calories || 0),
      protein: acc.protein + Number(it.protein || 0),
      carbs: acc.carbs + Number(it.carbs || 0),
      fat: acc.fat + Number(it.fat || 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
  const totals = {
    calories: Number(entry.totals?.calories ?? 0),
    protein: Number(entry.totals?.protein_g ?? 0),
    carbs: Number(entry.totals?.carbs_g ?? 0),
    fat: Number(entry.totals?.fat_g ?? 0),
  };
  const hasHistoryTotals = totals.calories > 0 || totals.protein > 0 || totals.carbs > 0 || totals.fat > 0;
  const resolvedTotals = hasHistoryTotals ? totals : itemTotals;
  return {
    meal: entry.name || 'Logged meal',
    name: entry.name || 'Logged meal',
    items: mappedItems as any,
    foods: mappedItems.map(it => it.name),
    amounts: mappedItems.map(it => `${it.quantity} ${it.unit}`),
    calories: resolvedTotals.calories,
    protein: resolvedTotals.protein,
    carbs: resolvedTotals.carbs,
    fat: resolvedTotals.fat,
    _localId: `history_${entry.id}`,
    _consumedAt: entry.consumed_at ?? entry.created_at ?? undefined,
    _loggedMealId: entry.id,
  } as MealSuggestion;
}

function mealSuggestionToHistoryItems(meal: MealSuggestion): import('../services/api').MealHistoryItem[] {
  const withItems = ensureItems(meal);
  return (withItems.items ?? []).map((it: any) => ({
    food_name: String(it.food_name || it.name || 'Item'),
    food_id: it.food_id ?? null,
    serving_id: it.serving_id ?? null,
    serving_grams: it.serving_grams ?? null,
    source: it.source ?? null,
    fdc_id: it.fdc_id ?? it.external_id ?? null,
    external_id: it.external_id ?? it.fdc_id ?? null,
    brand: it.brand ?? null,
    is_verified: it.is_verified ?? null,
    quantity: Number(it.quantity || 1),
    unit: String(it.unit || 'serving'),
    calories: Number(it.calories || 0),
    protein_g: Number(it.protein_g ?? it.protein ?? 0),
    carbs_g: Number(it.carbs_g ?? it.carbs ?? 0),
    fat_g: Number(it.fat_g ?? it.fat ?? 0),
    micronutrients: it.micronutrients ?? null,
  }));
}

/** Build the front-page schedule directly from a persisted PlanWeek's
 *  dated days. Each PlanDay already carries its own date + workout JSON,
 *  so we surface them in chronological order — yesterday's completed
 *  session stays visible if it falls within `[start_date, end_date]`.
 *  This is the new source of truth; the legacy `get7DaySchedule` is
 *  retained only as a fallback for users who don't have a PlanWeek row
 *  yet. */
function getScheduleFromPlanWeek(
  planWeek: import('../services/api').PlanWeekResponse,
): ScheduleItem[] {
  return planWeek.days.map(d => {
    // day_date is a YYYY-MM-DD string. Construct a local-midnight Date
    // so day-of-week math + dateKey comparisons match the rest of the
    // app (which all use local-time keys).
    const [y, m, dd] = d.day_date.split('-').map(Number);
    const date = new Date(y, (m ?? 1) - 1, dd ?? 1);
    return {
      date,
      workout: (d.workout ?? null) as WorkoutDay | null,
      isRest: !!d.is_rest,
    };
  });
}

function planDayDate(dayDate: string): Date {
  const [y, m, d] = dayDate.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function resolveTodayScheduleItem(
  schedule: ScheduleItem[] | null | undefined,
  workoutPlan: WorkoutPlan | null | undefined,
  planWeek: import('../services/api').PlanWeekResponse | null | undefined,
): ScheduleItem | null {
  const todayISO = todayKey();
  const fromSchedule = (schedule ?? []).find(item => dateKey(item.date) === todayISO)
    ?? (schedule ?? [])[0]
    ?? null;
  if (fromSchedule) return fromSchedule;

  const fromPlanWeek = planWeek?.days?.find(d => d.day_date === todayISO)
    ?? planWeek?.days?.[0]
    ?? null;
  if (fromPlanWeek) {
    return {
      date: planDayDate(fromPlanWeek.day_date),
      workout: (fromPlanWeek.workout ?? null) as WorkoutDay | null,
      isRest: !!fromPlanWeek.is_rest,
    };
  }

  const firstWorkout = workoutPlan?.days?.[0] ?? null;
  return firstWorkout
    ? { date: new Date(), workout: firstWorkout, isRest: false }
    : null;
}

// humanizeToken and buildExerciseGuide imported from '../utils/exerciseGuide'

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

// Exercise-name → muscle group classification. Used as a fallback when
// exercises lack a structured `primary_muscle` field.
const INFER_GROUP_KEYWORDS: [string[], string][] = [
  [['bike', 'cycle', 'cycling', 'spin', 'run', 'running', 'jog', 'treadmill', 'cardio', 'conditioning', 'hiit'], 'Cardio'],
  [['bench', 'chest', 'press', 'fly', 'push up', 'push-up', 'pushup'], 'Chest'],
  [['row', 'pull', 'lat', 'back', 'deadlift', 'pull up', 'pull-up', 'pullup'], 'Back'],
  [['squat', 'lunge', 'leg', 'quad', 'hamstring', 'calf'], 'Legs'],
  [['shoulder', 'overhead', 'lateral raise', 'rear delt'], 'Shoulders'],
  [['bicep', 'tricep', 'curl', 'extension'], 'Arms'],
  [['core', 'ab', 'plank', 'crunch'], 'Core'],
  [['glute', 'hip thrust'], 'Glutes'],
];

function inferGroup(text: string): string {
  const blob = text.toLowerCase();
  for (const [keywords, group] of INFER_GROUP_KEYWORDS) {
    if (keywords.some(kw => blob.includes(kw))) return group;
  }
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

export default function HomeScreen({ authToken, userProfile, planRefreshKey = 0, isWorkoutUpdating = false, isNutritionUpdating = false, trainerNote: trainerNoteProp = null, nutritionistNote: nutritionistNoteProp = null, supplementStack: supplementStackProp = [], onSignOut, onEditGoal: _onEditGoal, onEditWorkout: _onEditWorkout, onEditMealPlan: _onEditMealPlan, onEditThemes, onEditBody, onStartWorkout, onViewProgress: _onViewProgress, onViewAccount, onOpenSettings, onHomeTabNavigate, onProfileUpdate, onUpdateWeight, onBackendSync, onSaveProfile, onCancelScheduledPlanChange, onActivePlanWeekEndChange, onWeeklyRefresh, onCancelPlanGen, onSwitchDayRegen: _onSwitchDayRegen }: HomeScreenProps) {
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
    return buildUserFoodCategories({
      metaCategories: meta.foodCategories as any,
      foodsAvailable: userProfile?.foodsAvailable ?? [],
      customFoods: (userProfile?.customFoods ?? []) as any,
    }) as any;
  }, [meta.foodCategories, userProfile?.foodsAvailable, userProfile?.customFoods]);
  const theme = getTheme(userProfile?.themePreference);
	  const themeColors = theme.colors;
	  const workoutPalette = theme.sections.workout;
	  const mealPalette = theme.sections.meals;
	  const plannerPalette = theme.sections.planner;
	  const weightUnit = resolveWeightUnit(userProfile);
	  const distanceUnit = resolveDistanceUnit(userProfile);
  const onUpdateWeightRef = useRef(onUpdateWeight);
  useEffect(() => {
    onUpdateWeightRef.current = onUpdateWeight;
  }, [onUpdateWeight]);

  const [workoutPlan, setWorkoutPlan]     = useState<WorkoutPlan | null>(null);
  // The persisted 7-day plan from /plans/week/active. Source of truth for
  // the front-page schedule: each PlanDay carries its own date + status,
  // so yesterday's completed workout stays visible if it falls within
  // the active week. Null while loading or for legacy users with no row.
  // The ref mirrors the state for async functions (loadPlans, etc.) that
  // need the freshest value before React commits the state update.
  const [planWeek, setPlanWeek] = useState<import('../services/api').PlanWeekResponse | null>(null);
  const planWeekRef = useRef<import('../services/api').PlanWeekResponse | null>(null);

  // Bubble the active week's end_date up to app root whenever planWeek
  // changes — used by the pending-save modal to show the user the right
  // "applies on" date. No deps on activeWeekEndChange callback identity
  // (parent's callback is stable enough; over-firing is harmless).
  useEffect(() => {
    onActivePlanWeekEndChange?.(planWeek?.end_date ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planWeek?.end_date]);
  const [nutritionPlansByDate, setNutritionPlansByDate] = useState<Record<string, DailyNutritionPlan>>({});
  const nutritionPlansByDateRef = useRef<Record<string, DailyNutritionPlan>>({});
  useEffect(() => {
    nutritionPlansByDateRef.current = nutritionPlansByDate;
  }, [nutritionPlansByDate]);
  // Bottom-tab navigation. All five tabs render inline content within
  // HomeScreen's body — true SPA behavior. The bottom nav stays pinned
  // and never disappears no matter which tab is active.
  const [activeTab, setActiveTabRaw]      = useState<'friends' | 'workout' | 'meals' | 'progress' | 'you'>('workout');
  const [progressTabMounted, setProgressTabMounted] = useState(false);
  const progressFade = useRef(new Animated.Value(0)).current;
  const bottomNavFloat = useRef(new Animated.Value(1)).current;
  const setActiveTab = useCallback((tab: typeof activeTab) => {
    onHomeTabNavigate?.();
    if (tab === activeTab) return;
    if (tab === 'progress') setProgressTabMounted(true);
    bottomNavFloat.setValue(0);
    Animated.spring(bottomNavFloat, {
      toValue: 1,
      friction: 7,
      tension: 150,
      useNativeDriver: true,
    }).start();
    setActiveTabRaw(tab);
    if (tab === 'progress') {
      progressFade.setValue(0);
      Animated.timing(progressFade, { toValue: 1, duration: 300, useNativeDriver: true }).start();
    }
    AsyncStorage.setItem('lastActiveTab', tab).catch(() => {});
  }, [activeTab, bottomNavFloat, onHomeTabNavigate, progressFade]);
  // Sub-tab inside each main tab.
  // Workouts: plan | library | equipment | history
  // Meals:    plan | foods     | supplements | macros
  const [workoutSubTab, setWorkoutSubTab] = useState<'plan' | 'library' | 'equipment' | 'history'>('plan');
  const renderedWorkoutSubTab = useDeferredValue(workoutSubTab);
  const [workoutHistoryList, setWorkoutHistoryList] = useState<WorkoutSession[]>([]);
  const [workoutHistorySummaries, setWorkoutHistorySummaries] = useState<any[]>([]);
  const [workoutTemplates, setWorkoutTemplates] = useState<SavedWorkoutTemplate[]>([]);
  const workoutHistoryBundlePromiseRef = useRef<Promise<{
    history: WorkoutSession[];
    summaries: any[];
    preserved: Awaited<ReturnType<typeof loadPreservedCompletedWorkouts>>;
    manualOverrides: Awaited<ReturnType<typeof loadManualWorkoutOverrides>>;
  }> | null>(null);
  const loadWorkoutHistoryBundle = useCallback(() => {
    if (workoutHistoryBundlePromiseRef.current) return workoutHistoryBundlePromiseRef.current;
    const promise = Promise.all([
      loadWorkoutHistory(),
      loadWorkoutSummaries(),
      loadPreservedCompletedWorkouts(),
      loadManualWorkoutOverrides(),
    ])
      .then(([history, summaries, preserved, manualOverrides]) => ({ history, summaries, preserved, manualOverrides }))
      .finally(() => {
        workoutHistoryBundlePromiseRef.current = null;
      });
    workoutHistoryBundlePromiseRef.current = promise;
    return promise;
  }, []);
  const [expandedWorkoutHistoryId, setExpandedWorkoutHistoryId] = useState<string | null>(null);
  const [mealsSubTab,   setMealsSubTab]   = useState<'plan' | 'foods' | 'supplements' | 'macros' | 'history'>('plan');
  const [viewingFriend, setViewingFriend] = useState<import('../services/api').SocialDigestFriend | null>(null);
  const [friendFeedItems, setFriendFeedItems] = useState<import('../services/api').FeedItem[]>([]);
  const [friendFeedLoading, setFriendFeedLoading] = useState(false);
  const [expandedFeedItemId, setExpandedFeedItemId] = useState<number | null>(null);
  const [expandedHistoryDate, setExpandedHistoryDate] = useState<string | null>(null);
  // gutHealthToday removed — NutritionCard now computes gut health from plan data
  const [showGroceryList, setShowGroceryList] = useState(false);
  const [feedbackSettings, setFeedbackSettings] = useState<{ hapticsEnabled: boolean; soundsEnabled: boolean; vibrationEnabled: boolean; restNotificationSoundEnabled: boolean; restTimerSound: import('../utils/feedback').RestTimerSound }>({ hapticsEnabled: true, soundsEnabled: true, vibrationEnabled: true, restNotificationSoundEnabled: false, restTimerSound: 'chime' });
  // Full reminder state — preserves the user's chosen time AND schedule
  // across toggles. The previous reminderEnabled-only state forced a
  // hardcoded hour:8/minute:0 on every save, silently clobbering
  // whatever schedule the user had set in the dedicated SettingsScreen.
  const [workoutReminder, setWorkoutReminder] = useState<import('../utils/workoutReminders').ReminderSettings>({
    enabled: false, hour: 8, minute: 0, scheduleType: 'training_days', skipIfCompleted: true,
  });
  const [mealReminder, setMealReminder] = useState<import('../utils/mealReminders').MealReminderSettings>({
    enabled: true, hour: 21, minute: 0, scheduleType: 'every_day', skipIfAllLogged: true,
  });
  const [showEmailBanner, setShowEmailBanner] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [injuryCheckinState, setInjuryCheckinState] = useState<InjuryCheckinState>({});
  const [showInjuryCheckin, setShowInjuryCheckin] = useState(false);
  const [injuryCheckinSaving, setInjuryCheckinSaving] = useState(false);
  const activeProfileInjuries = useMemo(
    () => activeInjuryEntries(userProfile?.injuryEntries),
    [userProfile?.injuryEntries],
  );
  const dueInjuryCheckins = useMemo(
    () => findDueInjuryCheckins(userProfile?.injuryEntries, injuryCheckinState),
    [userProfile?.injuryEntries, injuryCheckinState],
  );
  const injuryCheckinTargets = dueInjuryCheckins.length > 0 ? dueInjuryCheckins : activeProfileInjuries;
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
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(INJURY_CHECKIN_STORAGE_KEY);
        if (!cancelled) setInjuryCheckinState(parseInjuryCheckinState(raw));
      } catch {
        if (!cancelled) setInjuryCheckinState({});
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const persistInjuryCheckinState = useCallback(async (next: InjuryCheckinState) => {
    setInjuryCheckinState(next);
    try { await AsyncStorage.setItem(INJURY_CHECKIN_STORAGE_KEY, JSON.stringify(next)); } catch {}
  }, []);
  const handleInjuryCheckinDismiss = useCallback(async () => {
    if (injuryCheckinTargets.length > 0) {
      await persistInjuryCheckinState(markInjuryCheckinsPrompted(injuryCheckinState, injuryCheckinTargets));
    }
    setShowInjuryCheckin(false);
  }, [injuryCheckinState, injuryCheckinTargets, persistInjuryCheckinState]);
  const handleInjuryCheckinResponse = useCallback(async (response: InjuryCheckinResponse) => {
    if (!userProfile || injuryCheckinTargets.length === 0) {
      setShowInjuryCheckin(false);
      return;
    }
    setInjuryCheckinSaving(true);
    try {
      await persistInjuryCheckinState(markInjuryCheckinsAnswered(injuryCheckinState, injuryCheckinTargets));
      setShowInjuryCheckin(false);
      if (response === 'keep_protected') return;

      const nextEntries = applyInjuryCheckinResponse(
        userProfile.injuryEntries,
        injuryCheckinTargets.map(inj => inj.id),
        response,
      );
      const updatedProfile: UserProfile = { ...userProfile, injuryEntries: nextEntries };
      if (response === 'resolved' && onSaveProfile) {
        onSaveProfile(updatedProfile, 'workout');
      } else if (onProfileUpdate) {
        onProfileUpdate({ injuryEntries: nextEntries }, true);
      } else {
        await AsyncStorage.setItem('userProfile', JSON.stringify(updatedProfile));
      }
    } catch (e) {
      console.error('[injury checkin] failed:', e);
      Alert.alert('Could not save', 'Try again in a moment.');
    } finally {
      setInjuryCheckinSaving(false);
    }
  }, [injuryCheckinState, injuryCheckinTargets, onProfileUpdate, onSaveProfile, persistInjuryCheckinState, userProfile]);

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
  // gutHealthToday fetch removed — NutritionCard computes from plan data
  // menuOpen state removed — the side menu modal is gone. Profile tab handles it.
  // Cached health score for the Profile tab. Loaded once on mount;
  // re-loaded when the user changes tabs to profile so a fresh scan
  // shows up without a full reload.
  const [profileHealthScore, setProfileHealthScore] = useState<import('../types').HealthScoreResult | null>(null);
  useEffect(() => {
    if (activeTab === 'you') {
      loadHealthScore().then(setProfileHealthScore).catch(() => setProfileHealthScore(null));
      // Lightweight friend-count poll for the Profile entry row.
      if (authToken) {
        (async () => {
          try {
            const { listFriends, listSocialNotifications } = await import('../services/api');
            const [list, notifications] = await Promise.all([
              listFriends(authToken),
              listSocialNotifications(authToken),
            ]);
            setFriendCount(list.friends.length);
            setPendingFriendCount(list.pending.filter(p => p.direction === 'incoming').length);
            setSocialUnreadCount(notifications.unread_count);
          } catch {
            // silent — entry row falls back to "Friends"
          }
        })();
      }
    }
    if (activeTab === 'friends' && authToken) {
      setViewingFriend(null);
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
      profile save refresh (which bumps `planRefreshKey` after the first
      load has already started with stale cache) gets swallowed by the
      early-return guard and the UI sticks on the old plan. */
  const loadPlansRerunPendingRef = useRef(false);
  /** Latest profile seen by the effect. The post-finish rerun uses
      this so it always operates on the newest profile snapshot, even
      if several triggers queued up. */
  const loadPlansLatestProfileRef = useRef<UserProfile | null>(null);
  const [expandedDay, setExpandedDay]     = useState<number>(-2);
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
    dayKey: string;
  } | null>(null);
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
  const exerciseLibraryRef = useRef<ExerciseLibraryItem[]>([]);
  const exerciseLibraryLoadPromiseRef = useRef<Promise<ExerciseLibraryItem[]> | null>(null);
  const ensureExerciseLibraryRef = useRef<(() => Promise<ExerciseLibraryItem[]>) | null>(null);
  const [selectedExercise, setSelectedExercise] = useState<ExerciseLibraryItem | null>(null);
  const [exerciseSearch, setExerciseSearch] = useState('');
  const deferredExerciseSearch = useDeferredValue(exerciseSearch);
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
  const planProgressElapsedRef = useRef(0);
  useEffect(() => {
    if (bothUpdating) {
      setSplashMounted(true);
      Animated.timing(splashOpacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
      return undefined;
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
    planProgressElapsedRef.current = 0;
    return undefined;
  }, [isWorkoutUpdating, isNutritionUpdating]);
  useManagedInterval(() => {
    const steps = [
      { at: 0,  label: 'Analyzing your foods and macros…' },
      { at: 5,  label: 'Building your workout plan…' },
      { at: 15, label: 'Building your meal templates…' },
      { at: 40, label: 'Optimizing nutrition targets…' },
      { at: 70, label: 'Finalizing your plan — the AI is writing details…' },
      { at: 110, label: 'Almost there — this plan is a long one, hang tight…' },
    ];
    planProgressElapsedRef.current += 1;
    const elapsed = planProgressElapsedRef.current;
    // Asymptotic progress: reaches ~88% around 120s, never 95%+.
    const progress = Math.min(88, 100 * (1 - Math.exp(-elapsed / 50)));
    setPlanProgress(progress);
    const currentStep = [...steps].reverse().find(s => elapsed >= s.at);
    if (currentStep) setPlanStep(currentStep.label);
  }, 1000, isWorkoutUpdating || isNutritionUpdating);

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
  const clearInProgressWorkout = useCallback(async () => {
    await AsyncStorage.removeItem('activeWorkoutSession').catch(() => {});
    await AsyncStorage.removeItem('activeWorkoutSets').catch(() => {});
    await AsyncStorage.removeItem('activeWorkoutStartTime').catch(() => {});
    await AsyncStorage.removeItem('activeWorkoutRest').catch(() => {});
    await AsyncStorage.removeItem('activeWatchSessionId').catch(() => {});
    setResumeInfo(null);
  }, []);
  const resumeInProgressWorkout = useCallback(() => {
    const todayPlanDay = planWeek?.days?.find(d => d.day_date === todayKey());
    const workout = (todayPlanDay?.workout as WorkoutDay | undefined) ?? workoutPlan?.days?.[0] ?? null;
    if (!workout) return;
    import('../utils/feedback').then(f => f.hapticMedium()).catch(() => {});
    onStartWorkout(workout, { playCountdown: false });
  }, [onStartWorkout, planWeek, workoutPlan]);
  const [skippedDates, setSkippedDates]   = useState<Set<string>>(new Set());
  // Dropped skips = user chose "skip entirely" (don't push to tomorrow).
  // get7DaySchedule advances the workout index for these dates.
  const [droppedSkipDates, setDroppedSkipDates] = useState<Set<string>>(new Set());
  const [todaySummary, setTodaySummary]   = useState<import('../types').StoredWorkoutSummary | null>(null);
  const [preservedWorkouts, setPreservedWorkouts] = useState<Record<string, WorkoutDay>>({});
  const [manualWorkoutOverrides, setManualWorkoutOverrides] = useState<Record<string, WorkoutDay>>({});
  const [readinessScore, setReadinessScore] = useState<{
    score: number;
    label: string;
    topFatigued?: Array<{ muscle: string; value: number }>;
    muscleFatigue?: Record<string, number>;
    focusReadiness?: Record<string, number>;
    activities?: Array<{
      date: string;
      days_ago?: number;
      focus: string;
      category?: string;
      subtype?: string;
      intensity?: string;
      duration_minutes?: number;
      kind?: 'training' | 'recovery';
      muscles?: Record<string, number>;
    }>;
    nutritionContext?: { protein_avg: number; protein_status: string; message?: string | null; recovery_bonus_applied: boolean } | null;
  } | null>(null);
  const [dismissedReadinessAdjustmentDate, setDismissedReadinessAdjustmentDate] = useState<string | null>(null);
  const [recoveryExpanded, setRecoveryExpanded] = useState(false);
  const [nutritionScoreData, setNutritionScoreData] = useState<import('../utils/nutritionScore').NutritionScoreResult | import('../services/api').NutritionScoreToday | null>(null);
  const [nutritionScoreWeekly, setNutritionScoreWeekly] = useState<import('../services/api').NutritionScoreWeekly | null>(null);
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
  const checkedMealsByDateRef = useRef<Record<string, MealChecks>>({});
  useEffect(() => {
    checkedMealsByDateRef.current = checkedMealsByDate;
  }, [checkedMealsByDate]);
  const [mealLogRefreshKey, setMealLogRefreshKey] = useState(0);
  const [backendMealHistory, setBackendMealHistory] = useState<MealHistoryEntry[] | null>(null);
  const [editingMeal, setEditingMeal] = useState<{ dateKey: string; type: string; meal: MealSuggestion; historyMealId?: number } | null>(null);
  const [hydration, setHydration] = useState<HydrationSummary | null>(null);
  const [hydrationByDate, setHydrationByDate] = useState<Record<string, HydrationSummary>>({});
  const [hydrationLoading, setHydrationLoading] = useState(false);
  // Recipe modal target. Opened from the meal card's "🍳 Recipe" button.
  const [recipeTarget, setRecipeTarget] = useState<{ dateKey: string; type: string; meal: MealSuggestion } | null>(null);
  const [currentDate, setCurrentDate] = useState(todayKey());
  const [selectedWorkoutDayKey, setSelectedWorkoutDayKey] = useState(todayKey());
  const [selectedMealDayKey, setSelectedMealDayKey] = useState(todayKey());
  const [expandedMealDays, setExpandedMealDays] = useState<Set<string>>(() => new Set());
  const [availabilityItems, setAvailabilityItems] = useState<AvailabilityItem[]>([]);
  const [shufflingInfo, setShufflingInfo] = useState<{ date: string; mealKey: string } | null>(null);
  const backendMealDailyRows = useMemo(
    () => backendMealHistory == null ? [] : aggregateDailyFromHistory(backendMealHistory),
    [backendMealHistory],
  );
  const backendMealDailyByDate = useMemo(() => {
    const byDate = new Map<string, DailyRowShape>();
    for (const row of backendMealDailyRows) byDate.set(row.date, row);
    return byDate;
  }, [backendMealDailyRows]);
  const backendMealSuggestionsByDate = useMemo(() => {
    const byDate = new Map<string, MealSuggestion[]>();
    for (const entry of backendMealHistory ?? []) {
      if (!entry.meal_date) continue;
      const existing = byDate.get(entry.meal_date) ?? [];
      existing.push(mealHistoryEntryToSuggestion(entry));
      byDate.set(entry.meal_date, existing);
    }
    return byDate;
  }, [backendMealHistory]);
  const loggedNutritionScoreByDate = useMemo(() => {
    const byDate = new Map<string, import('../services/api').NutritionScoreWeeklyDay>();
    for (const day of nutritionScoreWeekly?.daily ?? []) {
      if (day.logged && typeof day.score === 'number') byDate.set(day.date, day);
    }
    return byDate;
  }, [nutritionScoreWeekly]);

  // Meal-side day list mirrors the workout PlanWeek: 7 fixed dated days
  // (Mon-Sun anchor). Past days, today, and forward days are rendered
  // in date order — same model as the workout strip, no rolling window.
  // Reads from `planWeekRef.current` so async callers (loadPlans) see
  // the latest fetched plan_week even before React commits the
  // setPlanWeek state update.
  const _activeWeekMealDays = (): MealDay[] => {
    const pw = planWeekRef.current ?? planWeek;
    if (pw?.days?.length) {
      return pw.days.map(d => {
        const [y, m, dd] = d.day_date.split('-').map(Number);
        const date = new Date(y, (m ?? 1) - 1, dd ?? 1);
        return { key: d.day_date, date };
      });
    }
    return getNextMealDays(7);
  };

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
  const [liveTrackerInitialActivity, setLiveTrackerInitialActivity] = useState<LiveActivityInitialActivity | null>(null);
  // Workout template builder modal — create a new template (or edit an
  // existing one) without having to start an active workout. Distinct
  // from the "Save as Template" button on the active-workout summary.
  const [templateBuilderOpen, setTemplateBuilderOpen] = useState(false);
  const [templateBuilderTarget, setTemplateBuilderTarget] = useState<SavedWorkoutTemplate | null>(null);
  // Weekly check-in is handled by the backend-backed WeeklyCheckinCard.
  const [showFriends, setShowFriends] = useState(false);
  const [showGoalEditor, setShowGoalEditor] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const openSettingsHub = useCallback(() => {
    if (onOpenSettings) {
      onOpenSettings();
      return;
    }
    setShowSettings(true);
  }, [onOpenSettings]);
  const [showGearScreen, setShowGearScreen] = useState(false);
  const [showReadiness, setShowReadiness] = useState(false);
  const [readinessBadge, setReadinessBadge] = useState<{ score: number; label: string } | null>(null);
  const [pendingFriendCount, setPendingFriendCount] = useState(0);
  const [friendCount, setFriendCount] = useState(0);
  const [socialUnreadCount, setSocialUnreadCount] = useState(0);

  // Next-day unlogged-meals prompt. Populated once per day when yesterday
  // had a plan with unchecked meals and the dismissal flag isn't set.
  const [unloggedPrompt, setUnloggedPrompt] = useState<{
    date: string;
    items: Array<{ mealType: string; meal: MealSuggestion }>;
    chosen: Record<string, boolean>;
  } | null>(null);
  const unloggedPromptCheckedRef = useRef(false);
  // Legacy local check-in state removed; PlanWeekCheckin is server-backed.

  const refreshHydration = useCallback(async (dateISO: string = todayKey()): Promise<HydrationSummary | null> => {
    if (!authToken) return null;
    try {
      const pendingLocal = await loadCachedHydration(dateISO).catch(() => null);
      if (pendingLocal?.pending) {
        setHydrationByDate(prev => ({ ...prev, [pendingLocal.date]: pendingLocal }));
        if (pendingLocal.date === todayKey()) setHydration(pendingLocal);
        return pendingLocal;
      }
      const result = await getHydration(authToken, dateISO);
      await saveCachedHydration(result).catch(() => {});
      setHydrationByDate(prev => ({ ...prev, [result.date]: result }));
      if (result.date === todayKey()) setHydration(result);
      return result;
    } catch {
      // Hydration is additive context; keep the last visible value if the
      // endpoint is temporarily unavailable.
      return null;
    }
  }, [authToken]);

  useEffect(() => {
    if (!authToken) {
      setHydration(null);
      setHydrationByDate({});
      return;
    }
    let alive = true;
    (async () => {
      const cachedRows = await loadHydrationCache();
      if (!alive) return;
      if (Object.keys(cachedRows).length > 0) {
        setHydrationByDate(cachedRows);
        const todayRow = cachedRows[todayKey()];
        if (todayRow) setHydration(todayRow);
      }

      const pendingRows = await pendingCachedHydrationRows();
      for (const row of pendingRows) {
        try {
          const result = await logHydration(authToken, row.ounces, row.date);
          const fresh = await getHydration(authToken, result.date).catch(() => null);
          const saved = fresh ?? {
            date: result.date,
            ounces: result.ounces,
            target_ounces: row.target_ounces ?? 64,
          };
          await saveCachedHydration(saved);
          if (!alive) continue;
          setHydrationByDate(prev => ({ ...prev, [saved.date]: saved }));
          if (saved.date === todayKey()) setHydration(saved);
        } catch {
          // Keep the pending local row; the next app open/sign-in will retry.
        }
      }

      if (alive) refreshHydration(todayKey()).catch(() => {});
    })();
    return () => { alive = false; };
  }, [authToken, refreshHydration]);

  useEffect(() => {
    if (activeTab === 'meals' && mealsSubTab === 'plan') {
      refreshHydration(selectedMealDayKey).catch(() => {});
      if (selectedMealDayKey !== todayKey()) refreshHydration().catch(() => {});
    }
  }, [activeTab, mealsSubTab, refreshHydration, selectedMealDayKey]);

  const pushHydrationSnapshotToWatch = useCallback(async (
    dateISO: string = todayKey(),
    preferred?: HydrationSummary | null,
  ) => {
    let row = preferred
      ?? hydrationByDate[dateISO]
      ?? (dateISO === todayKey() ? hydration : null);
    if (!row && authToken) {
      const result = await getHydration(authToken, dateISO);
      row = result;
      setHydrationByDate(prev => ({ ...prev, [result.date]: result }));
      if (result.date === todayKey()) setHydration(result);
    }
    const snapshot = row ?? { date: dateISO, ounces: 0, target_ounces: 64 };
    const { pushHydrationToWatch } = await import('../utils/watchSync');
    await pushHydrationToWatch({
      dateISO: snapshot.date,
      ounces: snapshot.ounces,
      targetOunces: snapshot.target_ounces,
    });
  }, [authToken, hydration, hydrationByDate]);

  const handleHydrationDelta = useCallback(async (deltaOz: number, dateISO: string = todayKey()) => {
    if (!authToken) return;
    setHydrationLoading(true);
    // Optimistic update via functional setState so rapid taps compose
    // off the LATEST state instead of a stale closure snapshot. The
    // delta itself goes to the backend, which atomically increments
    // under a row lock — concurrent +8oz taps now sum to +24oz on the
    // server even if their POSTs interleave.
    const todayISO = todayKey();
    const fallbackTarget = hydration?.target_ounces ?? 64;
    setHydrationByDate(prev => {
      const row = prev[dateISO] ?? (dateISO === todayISO ? hydration : null);
      const current = row?.ounces ?? 0;
      const next = Math.max(0, Math.round((current + deltaOz) * 10) / 10);
      const optimistic = row
        ? { ...row, ounces: next }
        : { date: dateISO, ounces: next, target_ounces: fallbackTarget };
      return { ...prev, [dateISO]: optimistic };
    });
    if (dateISO === todayISO) {
      setHydration(prev => {
        const current = prev?.ounces ?? 0;
        const next = Math.max(0, Math.round((current + deltaOz) * 10) / 10);
        return prev
          ? { ...prev, ounces: next }
          : { date: dateISO, ounces: next, target_ounces: fallbackTarget };
      });
    }
    await applyCachedHydrationDelta(dateISO, deltaOz, fallbackTarget).catch(() => null);
    try {
      const result = await logHydrationDelta(authToken, deltaOz, dateISO);
      const fresh = await getHydration(authToken, result.date).catch(() => null);
      const saved = fresh ?? {
        date: result.date,
        ounces: result.ounces,
        target_ounces: fallbackTarget,
      };
      await saveCachedHydration(saved).catch(() => null);
      setHydrationByDate(prev => ({ ...prev, [saved.date]: saved }));
      if (saved.date === todayISO) setHydration(saved);
      if (saved.date === todayISO) pushHydrationSnapshotToWatch(saved.date, saved).catch(() => {});
    } catch {
      // Revert by applying the inverse delta off whatever state the
      // user is now looking at. Safer than restoring a captured value
      // because other taps may have committed in between.
      setHydrationByDate(prev => {
        const row = prev[dateISO];
        if (!row) return prev;
        const reverted = Math.max(0, Math.round((row.ounces - deltaOz) * 10) / 10);
        return { ...prev, [dateISO]: { ...row, ounces: reverted } };
      });
      if (dateISO === todayISO) {
        setHydration(prev => prev
          ? { ...prev, ounces: Math.max(0, Math.round((prev.ounces - deltaOz) * 10) / 10) }
          : prev);
      }
      await applyCachedHydrationDelta(dateISO, -deltaOz, fallbackTarget, { pending: false }).catch(() => null);
      Alert.alert('Hydration not saved', 'Could not update water intake right now.');
    } finally {
      setHydrationLoading(false);
    }
  }, [authToken, hydration, pushHydrationSnapshotToWatch]);

  const handleHydrationSet = useCallback(async (ounces: number, dateISO: string = todayKey()) => {
    if (!authToken) return;
    const currentRow = hydrationByDate[dateISO] ?? (dateISO === todayKey() ? hydration : null);
    const current = currentRow?.ounces ?? 0;
    const next = Math.max(0, Math.round(ounces * 10) / 10);
    setHydrationLoading(true);
    const optimistic = currentRow
      ? { ...currentRow, ounces: next }
      : { date: dateISO, ounces: next, target_ounces: 64 };
    setHydrationByDate(prev => ({ ...prev, [dateISO]: optimistic }));
    if (dateISO === todayKey()) setHydration(optimistic);
    await saveCachedHydration(optimistic, { pending: true }).catch(() => null);
    try {
      const result = await logHydration(authToken, next, dateISO);
      const fresh = await getHydration(authToken, result.date).catch(() => null);
      const saved = fresh
        ? fresh
        : {
          date: result.date,
          ounces: result.ounces,
          target_ounces: currentRow?.target_ounces ?? hydration?.target_ounces ?? 64,
      };
      await saveCachedHydration(saved).catch(() => null);
      setHydrationByDate(prev => ({ ...prev, [saved.date]: saved }));
      if (saved.date === todayKey()) setHydration(saved);
      if (saved.date === todayKey()) pushHydrationSnapshotToWatch(saved.date, saved).catch(() => {});
    } catch {
      if (currentRow) {
        setHydrationByDate(prev => ({ ...prev, [dateISO]: { ...currentRow, ounces: current } }));
        if (dateISO === todayKey()) setHydration({ ...currentRow, ounces: current });
        await saveCachedHydration({ ...currentRow, ounces: current }).catch(() => null);
      } else {
        setHydrationByDate(prev => {
          const nextRows = { ...prev };
          delete nextRows[dateISO];
          return nextRows;
        });
        if (dateISO === todayKey()) setHydration(null);
        await removeCachedHydration(dateISO).catch(() => null);
      }
      Alert.alert('Hydration not saved', 'Could not update water intake right now.');
    } finally {
      setHydrationLoading(false);
    }
  }, [authToken, hydration, hydrationByDate, pushHydrationSnapshotToWatch]);

  // Authoritative daily amounts from the server — collagen + probiotic
  // CFUs. Fetched alongside the score so NutritionCard can show real
  // numbers instead of the client-side plan estimate. Refresh piggy-
  // backs on checkedMealsByDate so toggling a meal immediately
  // re-queries.
  const [todayCollagenG, setTodayCollagenG] = useState<number | null>(null);
  const [todayProbioticCfu, setTodayProbioticCfu] = useState<number | null>(null);
  const [proteinBreakdown, setProteinBreakdown] = useState<any | null>(null);
  const [todaySupplementMicros, setTodaySupplementMicros] = useState<Array<{ ingredient_slug?: string | null; ingredient_name?: string | null; custom_name?: string | null; dose_amount: number; dose_unit: string; taken_count: number }> | null>(null);
  const [adjustedDailyTarget, setAdjustedDailyTarget] = useState<import('../services/api').AdjustedDailyTarget | null>(null);
  const [activityNutritionRefreshKey, setActivityNutritionRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const applyPlanPreviewFallback = () => {
      const plan = nutritionPlansByDate[todayKey()] ?? null;
      setNutritionScoreWeekly(null);
      if (!plan) {
        setNutritionScoreData(null);
        return;
      }
      setNutritionScoreData(computeNutritionScore(plan, userProfile?.goal ?? 'body_recomp'));
    };

    if (!authToken || !userProfile || tierOf(userProfile) === 'free') {
      applyPlanPreviewFallback();
      return;
    }

    getNutritionScore(authToken, 14)
      .then((result) => {
        if (cancelled) return;
        setNutritionScoreData(result.today ?? null);
        setNutritionScoreWeekly(result.weekly ?? null);
      })
      .catch(() => {
        if (!cancelled) applyPlanPreviewFallback();
      });

    return () => { cancelled = true; };
  }, [
    authToken,
    userProfile?.goal,
    userProfile?.subscriptionTier,
    nutritionPlansByDate,
    mealLogRefreshKey,
    activityNutritionRefreshKey,
  ]);

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
  }, [authToken, checkedMealsByDate, nutritionPlansByDate, mealLogRefreshKey]);

  const refreshAdjustedDailyTarget = useCallback(async (dateISO: string = todayKey()) => {
    if (!authToken) return;
    const { getAdjustedDailyTarget } = await import('../services/api');
    const result = await getAdjustedDailyTarget(authToken, dateISO);
    setAdjustedDailyTarget(result);
  }, [authToken]);

  const refreshNutritionAfterActivity = useCallback(async (dateISO: string = todayKey()) => {
    setActivityNutritionRefreshKey(k => k + 1);
    await Promise.all([
      refreshHydration(dateISO),
      dateISO === todayKey() ? refreshAdjustedDailyTarget(dateISO).catch(() => undefined) : Promise.resolve(),
    ]);
    if (dateISO === todayKey()) {
      pushHydrationSnapshotToWatch(dateISO).catch(() => {});
    }
  }, [pushHydrationSnapshotToWatch, refreshAdjustedDailyTarget, refreshHydration]);

  // Weekly calorie budget + same-day activity bump. Re-fetches whenever
  // logged meals change; activity save paths call refreshNutritionAfterActivity
  // directly so workout/import effects are visible right away.
  useEffect(() => {
    if (!authToken) return;
    let cancelled = false;
    (async () => {
      try {
        if (!cancelled) await refreshAdjustedDailyTarget(todayKey());
      } catch { /* non-fatal — today's card falls back to static targets */ }
    })();
    return () => { cancelled = true; };
  }, [authToken, checkedMealsByDate, planRefreshKey, refreshAdjustedDailyTarget]);

  // Home history should show the same deduped meal rows Progress uses.
  // Plan/check state still powers editing, but backend rows are the
  // authority for daily logged totals.
  useEffect(() => {
    if (!authToken) {
      setBackendMealHistory(null);
      return;
    }
    let cancelled = false;
    getMealHistory(authToken, 14, 100)
      .then((result) => {
        if (!cancelled) setBackendMealHistory(result.meals ?? []);
      })
      .catch(() => {
        if (!cancelled) setBackendMealHistory(null);
      });
    return () => { cancelled = true; };
  }, [authToken, mealLogRefreshKey]);

  const persistDayState = useCallback(async (
    dayKey: string,
    patch: { skipped_focus?: string | null; skip_reason?: string | null; meal_checks?: Record<string, boolean>; nutrition_plan?: any; macro_overrides?: any },
  ) => {
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
      loadReminderSettings().then(s => setWorkoutReminder(s)).catch(() => {})
    );
    import('../utils/mealReminders').then(({ loadMealReminderSettings }) =>
      loadMealReminderSettings().then(s => setMealReminder(s)).catch(() => {})
    );
    if (userProfile) loadPlans(userProfile);
    loadDayStatus();
    // Warm the exercise library in the background so plan-view + active-
    // workout thumbnails have the name→video_id index populated even
    // for users who never visit the Library sub-tab.
    ensureExerciseLibraryRef.current?.().catch(() => {});
    // Weekly check-in prompt is handled by WeeklyCheckinCard on the Plan tab.
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
    loadWorkoutHistoryBundle()
      .then(({ history, summaries }) => { setWorkoutHistoryList(history); setWorkoutHistorySummaries(summaries); })
      .catch(() => {});
  }, [loadWorkoutHistoryBundle, planRefreshKey]);

  useEffect(() => {
    loadWorkoutTemplates().then(setWorkoutTemplates).catch(() => setWorkoutTemplates([]));
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
    ensureExerciseLibraryRef.current?.().catch(() => {});
  }, [activeTab, workoutSubTab, showExerciseLibrary]);

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
          await AsyncStorage.removeItem('activeWorkoutRest').catch(() => {});
          await AsyncStorage.removeItem('activeWatchSessionId').catch(() => {});
          setResumeInfo(null);
          return;
        }
        // Infer focus from today's PlanDay (looked up by date), falling
        // back to position 0 of the legacy plan when no PlanWeek exists.
        const todayDayDate = todayKey();
        const planDayToday = planWeek?.days?.find(d => d.day_date === todayDayDate);
        const todayFocus = planDayToday?.workout?.focus ?? workoutPlan?.days?.[0]?.focus ?? 'workout';
        setResumeInfo({ focus: todayFocus, setsLogged, startedAt });
      } catch {
        setResumeInfo(null);
      }
    })();
    return () => { cancelled = true; };
  }, [workoutPlan, planWeek, planRefreshKey]);

  // Defensive re-schedule of workout + meal reminders. Cheap: if settings
  // say disabled, helpers no-op. If already scheduled, helpers cancel +
  // re-schedule so we don't stack duplicates. This also restores repeating
  // reminders after a same-day completion/log path temporarily swapped the
  // current slot for a one-shot future reminder.
  useEffect(() => {
    (async () => {
      try {
        const { loadReminderSettings, scheduleWorkoutReminder } = await import('../utils/workoutReminders');
        const workoutSettings = await loadReminderSettings();
        if (workoutSettings.enabled) await scheduleWorkoutReminder(workoutSettings);
      } catch {}
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
    const isFree = tierOf(userProfile) === 'free';
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
      // Daily fresh-day flag removed — plan now stable for the full week.
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
        const todayISO = todayKey();
        // Find today by date in the schedule — with the PlanWeek model,
        // today may be at any index (e.g., index 1 if the week started
        // yesterday). Falls back to position 0 only if no date match.
        const todayItem = resolveTodayScheduleItem(schedule, workoutPlan, planWeek);
        // Fall back to workoutPlan.days[0] when schedule[0].workout is null —
        // happens when the schedule mapping hasn't fully resolved yet but the
        // raw plan exists. Without this fallback the watch shows "Open Thallo"
        // forever even though the user has a workout plan loaded.
        const todayWorkout = todayItem?.workout ?? workoutPlan?.days?.[0] ?? null;
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
              const { getCachedReadinessToday } = await import('../services/readinessCache');
              const { getCachedHealthDataSummary } = await import('../services/healthDataSummary');
              const { getCycleStatus } = await import('../services/appleHealth');
              const cached = await getCachedHealthDataSummary().catch(() => null);
              const sleepHours = cached?.sleepMinutes != null ? cached.sleepMinutes / 60 : null;
              const cycle = await getCycleStatus().catch(() => null);
              const prep = await getCachedReadinessToday(authToken, {
                avgSleepHours: sleepHours,
                avgRestingHr: cached?.restingHeartRate ?? null,
                avgHrvMs: cached?.hrv ?? null,
                lastNightSleepScore: cached?.raw?.sleepScore?.score ?? null,
                plannedFocus: todayItem?.workout?.focus ?? todayWorkout?.focus ?? null,
                cyclePhase: cycle?.phase ?? null,
                dayOfCycle: cycle?.dayOfCycle ?? null,
              });
              if (prep.label === '—' || prep.score <= 0) {
                unifiedPrepScore = null;
                unifiedPrepLabel = null;
                canonicalPrepRef.current = null;
              } else {
                unifiedPrepScore = prep.score;
                unifiedPrepLabel = prep.label;
                // Update the ref so subsequent syncs reuse this value.
                canonicalPrepRef.current = { score: prep.score, label: prep.label, computedAt: Date.now() };
              }
            }
          } catch { /* keep the last displayed readiness score */ }
        }
        if (status !== 'active') {
          await pushWorkoutToWatch(todayWorkout, {
            dateISO: todayISO,
            status,
            sessionId: null,
            readiness: unifiedPrepScore,
            readinessLabel: unifiedPrepLabel,
            reason: 'home_snapshot',
          });
        }
        await pushThemeToWatch(userProfile?.themePreference);
        const todayPlan = nutritionPlansByDate[todayISO]
          ?? (Object.values(nutritionPlansByDate)[0] as any);
        await pushMealsToWatch(
          todayPlan,
          checkedMealsByDate[todayISO],
          todayISO,
          nutritionScoreData?.score ?? null,
        );
        await pushHydrationSnapshotToWatch(todayISO).catch(() => {});
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
          const { pushSleepToWatch, buildWatchSleepPayloadFromSummary } = await import('../utils/watchSync');
          const { getHealthDataSummary } = await import('../services/healthDataSummary');
          // Use the fresh-fetcher (cache + auto-refresh if stale) so the
          // watch gets the same sleep score the phone's Progress card
          // sees, not whatever was last cached. Otherwise watch stays on
          // a stale value while phone refreshes silently in the background.
          const cached = await getHealthDataSummary({ age: userProfile?.physicalStats?.age ?? null });
          await pushSleepToWatch(buildWatchSleepPayloadFromSummary(cached));
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
  // flip the status between lifecycle buckets. planWeek is included
  // because loadPlans sets it and workoutPlan together — if workoutPlan
  // was already set (AsyncStorage cache) but planWeek just arrived, we
  // need to re-push the enriched schedule.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    planWeek, workoutPlan, userProfile?.themePreference, todayDone, skippedDates,
    nutritionPlansByDate, checkedMealsByDate,
    hydration, hydrationByDate, readinessScore, nutritionScoreData,
    pushHydrationSnapshotToWatch,
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
    hydration: null as HydrationSummary | null,
    hydrationByDate: {} as Record<string, HydrationSummary>,
    readinessScore: null as any,
    nutritionScoreData: null as any,
    workoutPlan: null as any,
    planWeek: null as import('../services/api').PlanWeekResponse | null,
    profileAge: null as number | null,
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
          pushHydrationToWatch, pushSleepToWatch, pushSupplementsToWatch, pushWeightToWatch,
          buildWatchSleepPayloadFromSummary,
        } = watchSync;
        const unsub = onWatchReachabilityChange((info) => {
          if (!info.reachable) return;
          const s = rePushStateRef.current;
          const todayISO = todayKey();
          // Find today by date — with the dated PlanWeek the today card
          // is no longer guaranteed to live at index 0 (e.g. it sits at
          // index 1 when the week started Monday and today is Tuesday).
          const todayItem = resolveTodayScheduleItem(s.schedule, s.workoutPlan, s.planWeek);
          const todayWorkout = todayItem?.workout ?? s.workoutPlan?.days?.[0] ?? null;

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
          // Sequential awaits so each updateApplicationContext call
          // completes before the next reads s.applicationContext.
          // Concurrent fire-and-forget causes all three to read the
          // same stale context and only the last writer's keys survive.
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
            if (status !== 'active') {
              await pushWorkoutToWatch(todayWorkout, {
                dateISO: todayISO,
                status,
                sessionId: null,
                readiness: s.readinessScore?.score ?? null,
                readinessLabel: s.readinessScore?.label ?? null,
                reason: 'reachability',
              }).catch(() => {});
            }
            await pushThemeToWatch(s.themePreference).catch(() => {});
            const todayPlan = s.nutritionPlansByDate[todayISO]
              ?? (Object.values(s.nutritionPlansByDate)[0] as any);
            await pushMealsToWatch(
              todayPlan,
              s.checkedMealsByDate[todayISO],
              todayISO,
              s.nutritionScoreData?.score ?? null,
            ).catch(() => {});
            let hydrationSnapshot: HydrationSummary | null = s.hydrationByDate?.[todayISO] ?? s.hydration ?? null;
            if (!hydrationSnapshot && authToken) {
              hydrationSnapshot = await getHydration(authToken, todayISO).catch(() => null);
            }
            await pushHydrationToWatch({
              dateISO: hydrationSnapshot?.date ?? todayISO,
              ounces: hydrationSnapshot?.ounces ?? 0,
              targetOunces: hydrationSnapshot?.target_ounces ?? 64,
            }).catch(() => {});
          })();

          // Sleep uses the canonical health summary fetcher: cached when
          // warm, refreshed only when stale/missing. That keeps watch-open
          // sync aligned with the Progress card without hammering HK.
          // Supplements pull from the API when authToken is present.
          (async () => {
            try {
              const { getHealthDataSummary } = await import('../services/healthDataSummary');
              const cached = await getHealthDataSummary({ age: s.profileAge ?? null });
              await pushSleepToWatch(buildWatchSleepPayloadFromSummary(cached));
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
              const { getCachedReadinessToday } = await import('../services/readinessCache');
              const { getCachedHealthDataSummary } = await import('../services/healthDataSummary');
              const { getCycleStatus } = await import('../services/appleHealth');
              const cached = await getCachedHealthDataSummary().catch(() => null);
              const sleepHours = cached?.sleepMinutes != null ? cached.sleepMinutes / 60 : null;
              const cycle = await getCycleStatus().catch(() => null);
              const serverResp = await getCachedReadinessToday(authToken, {
                avgSleepHours: sleepHours,
                avgRestingHr: cached?.restingHeartRate ?? null,
                avgHrvMs: cached?.hrv ?? null,
                lastNightSleepScore: cached?.raw?.sleepScore?.score ?? null,
                plannedFocus: todayItem?.workout?.focus ?? todayWorkout?.focus ?? null,
                cyclePhase: cycle?.phase ?? null,
                dayOfCycle: cycle?.dayOfCycle ?? null,
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
    start: (today: any) => { onStartWorkout?.(today, { playCountdown: false }); },
    skip: (_focus: string) => {},
    toggleMeal: (_date: string, _mealType: string) => {},
  });
  const homeWatchLogSetChainRef = useRef(Promise.resolve());
  const homeWatchHydrationCommandChainRef = useRef(Promise.resolve());
  useEffect(() => {
    watchCmdHandlersRef.current = {
      start: (today: any) => { onStartWorkout?.(today, { playCountdown: false }); },
      skip: (focus: string) => handleSkipToday(focus),
      toggleMeal: (date: string, mealType: string) => handleToggleMeal(date, mealType),
    };
  });

  // ── Hourly readiness refresh on app foreground ─────────────────────────
  // Backed by the per-process readiness TTL cache (60s) on the server, so
  // multiple foreground transitions in a short window are cheap. Cache
  // already invalidates on workout completion, meal save, and HK push, so
  // a foreground after any of those returns a fresh number.
  // Watch ordering protocol: the server's `computed_at_ms` lets the watch
  // ignore any payload older than its current value, so even rapid
  // mid-day pushes can't out-of-order each other.
  useEffect(() => {
    if (!authToken) return;
    let lastRefreshAt = 0;
    const REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 min between refreshes

    const refreshReadiness = async () => {
      const now = Date.now();
      if (now - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) return;
      lastRefreshAt = now;
      try {
        const { getCachedReadinessToday } = await import('../services/readinessCache');
        const { getCachedHealthDataSummary } = await import('../services/healthDataSummary');
        const { getCycleStatus } = await import('../services/appleHealth');
        const { pushReadinessToWatch } = await import('../utils/watchSync');
        const cached = await getCachedHealthDataSummary().catch(() => null);
        const sleepHours = cached?.sleepMinutes != null ? cached.sleepMinutes / 60 : null;
        const cycle = await getCycleStatus().catch(() => null);
        const s = rePushStateRef.current;
        const todayItem = resolveTodayScheduleItem(s.schedule, s.workoutPlan, s.planWeek);
        const todayWorkout = todayItem?.workout ?? s.workoutPlan?.days?.[0] ?? null;
        const r = await getCachedReadinessToday(authToken, {
          avgSleepHours: sleepHours,
          avgRestingHr: cached?.restingHeartRate ?? null,
          avgHrvMs: cached?.hrv ?? null,
          lastNightSleepScore: cached?.raw?.sleepScore?.score ?? null,
          plannedFocus: todayItem?.workout?.focus ?? todayWorkout?.focus ?? null,
          cyclePhase: cycle?.phase ?? null,
          dayOfCycle: cycle?.dayOfCycle ?? null,
        }).catch(() => null);
        if (!r) return;
        await pushReadinessToWatch({
          score: r.score, label: r.label, summary: r.summary,
          factors: r.factors as any, syncedAtMs: r.computed_at_ms,
        } as any).catch(() => {});
      } catch { /* non-fatal */ }
    };

    const sub = require('react-native').AppState.addEventListener('change', (next: string) => {
      if (next === 'active') refreshReadiness();
    });
    return () => sub.remove();
  }, [authToken]);
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
                if (onUpdateWeightRef.current) {
                  await onUpdateWeightRef.current(lbs, 'watch');
                  return;
                }
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
            const category = typeof payload?.category === 'string' ? payload.category : undefined;
            console.log('[watch] start_custom_workout subtype=', subtype);
            setLiveTrackerInitialActivity({ category, subtype });
            setShowLiveTracker(true);
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
                const watchSync = await import('../utils/watchSync');
                const {
                  pushWorkoutToWatch, pushThemeToWatch, pushMealsToWatch,
                  pushHydrationToWatch, pushSleepToWatch, pushSupplementsToWatch, pushWeightToWatch,
                  buildWatchSleepPayloadFromSummary,
                } = watchSync;
                const s = rePushStateRef.current;
                const todayISO = todayKey();
                const todayItem = resolveTodayScheduleItem(s.schedule, s.workoutPlan, s.planWeek);
                const todayWorkout = todayItem?.workout ?? s.workoutPlan?.days?.[0] ?? null;
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
                // SEQUENTIAL awaits — each call merges into applicationContext
                // before the next reads it. Concurrent fire-and-forget causes
                // a race where all three read the same stale applicationContext
                // and only the last writer's keys survive (dropping workout).
                if (status !== 'active') {
                  await pushWorkoutToWatch(todayWorkout, {
                    dateISO: todayISO,
                    status,
                    sessionId: null,
                    readiness: s.readinessScore?.score ?? null,
                    readinessLabel: s.readinessScore?.label ?? null,
                    reason: 'pull_state',
                  }).catch(() => {});
                }
                await pushThemeToWatch(s.themePreference).catch(() => {});
                const todayPlan = s.nutritionPlansByDate[todayISO]
                  ?? (Object.values(s.nutritionPlansByDate)[0] as any);
                await pushMealsToWatch(
                  todayPlan,
                  s.checkedMealsByDate[todayISO],
                  todayISO,
                  s.nutritionScoreData?.score ?? null,
                ).catch(() => {});
                let hydrationSnapshot: HydrationSummary | null = s.hydrationByDate?.[todayISO] ?? s.hydration ?? null;
                if (!hydrationSnapshot && authToken) {
                  hydrationSnapshot = await getHydration(authToken, todayISO).catch(() => null);
                }
                await pushHydrationToWatch({
                  dateISO: hydrationSnapshot?.date ?? todayISO,
                  ounces: hydrationSnapshot?.ounces ?? 0,
                  targetOunces: hydrationSnapshot?.target_ounces ?? 64,
                }).catch(() => {});
                // push_state also sends the full data set that the
                // reachability listener sends, so a manual sync is
                // equivalent to re-opening the watch app.
                (async () => {
                  try {
                    const { getHealthDataSummary } = await import('../services/healthDataSummary');
                    const cached = await getHealthDataSummary({ age: s.profileAge ?? null }).catch(() => null);
                    await pushSleepToWatch(buildWatchSleepPayloadFromSummary(cached));
                  } catch { /* non-fatal */ }
                })();
                (async () => {
                  try {
                    if (!authToken) return;
                    const { getTodaySupplements } = await import('../services/api');
                    const stack = await getTodaySupplements(authToken).catch(() => null);
                    if (stack) {
                      await pushSupplementsToWatch(stack.map((sup: any) => ({
                        id: sup.id, name: sup.custom_name || 'Supplement',
                        dose: `${sup.dose_amount}${sup.dose_unit}`,
                        timing: sup.timing ?? null,
                        taken: !!(sup.logs_today || []).find((l: any) => !l.skipped),
                        skipped: !!(sup.logs_today || []).find((l: any) => l.skipped),
                      })));
                    }
                  } catch { /* non-fatal */ }
                })();
                (async () => {
                  try {
                    const { loadWeightEntries } = await import('../utils/weightHistory');
                    const entries: Array<{ date: string; weight_lbs: number }> = await loadWeightEntries().catch(() => []);
                    let latest: number | null = null, daysSince: number | null = null, slope: number | null = null, ema: number | null = null;
                    if (entries.length > 0) {
                      const last = entries[entries.length - 1];
                      latest = Number(last.weight_lbs) || null;
                      try { daysSince = Math.max(0, Math.floor((Date.now() - new Date(last.date).getTime()) / 86400000)); } catch {}
                    }
                    if (entries.length >= 3) {
                      const recent = entries.slice(-7);
                      ema = recent.reduce((acc: number, e: any) => acc + Number(e.weight_lbs), 0) / recent.length;
                      const old = entries.slice(-14, -7);
                      if (old.length > 0) slope = ema - old.reduce((acc: number, e: any) => acc + Number(e.weight_lbs), 0) / old.length;
                    }
                    await pushWeightToWatch({ latestLbs: latest, daysSinceLastLog: daysSince, emaLbs: ema, slopeLbsPerWeek: slope });
                  } catch { /* non-fatal */ }
                })();
              } catch { /* bridge optional */ }
            })();
            return;
          }
          if (command === 'start_workout') {
            // Read from rePushStateRef (always current) instead of any
            // closure-captured value — the listener is registered once
            // and the ref carries the freshest schedule + plan.
            const refState = rePushStateRef.current;
            const todayScheduleItem = resolveTodayScheduleItem(refState.schedule, refState.workoutPlan, refState.planWeek);
            const today = todayScheduleItem?.workout ?? refState.workoutPlan?.days?.[0];
            console.log('[watch cmd] start_workout — todayFocus=', today?.focus);
            if (today) {
              const nowMs = Date.now();
              const commandTsMs = Number(payload?.tsMs);
              const startedAtMs = Number.isFinite(commandTsMs)
                && commandTsMs > 0
                && nowMs - commandTsMs <= WATCH_WORKOUT_COMMAND_TTL_MS
                ? commandTsMs
                : nowMs;
              // Immediately stamp active state so pull_state/reachability
              // handlers see isWorkoutInProgress = true and so the watch
              // gets an authoritative active echo before ActiveWorkoutScreen
              // has a chance to mount (which was the race causing the watch
              // to stay idle while the phone started).
              const incomingSessionId = typeof payload?.sessionId === 'string' && payload.sessionId.trim().length > 0
                ? payload.sessionId.trim()
                : null;
              const sessionId = incomingSessionId ?? `${startedAtMs}-${Math.random().toString(36).slice(2, 8)}`;
              setActiveWatchSessionId(sessionId);
              AsyncStorage.setItem('activeWatchSessionId', sessionId).catch(() => {});
              AsyncStorage.setItem('activeWorkoutStartTime', String(startedAtMs)).catch(() => {});
              // Push active status immediately — don't wait for ActiveWorkoutScreen to mount.
              (async () => {
                try {
                  const { pushWorkoutToWatch } = await import('../utils/watchSync');
                  const s = rePushStateRef.current;
                  await pushWorkoutToWatch(today, {
                    dateISO: todayKey(),
                    status: 'active',
                    sessionId,
                    readiness: s.readinessScore?.score ?? null,
                    readinessLabel: s.readinessScore?.label ?? null,
                    reason: 'start_echo',
                  }).catch(() => {});
                } catch { /* non-fatal */ }
              })();
              watchCmdHandlersRef.current.start(today);
            } else {
              console.warn('[watch cmd] start_workout: no today workout available');
            }
          } else if (command === 'skip_workout') {
            const refState = rePushStateRef.current;
            const todayScheduleItemSkip = resolveTodayScheduleItem(refState.schedule, refState.workoutPlan, refState.planWeek);
            const today = todayScheduleItemSkip?.workout ?? refState.workoutPlan?.days?.[0];
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
            const todayISO = todayKey();
            if (mealType) watchCmdHandlersRef.current.toggleMeal(todayISO, mealType);
          } else if (command === 'log_hydration') {
            // Newer watch builds send quick-adds as deltas; older builds
            // and Digital Crown "Set" still send absolute totals. Process
            // one command at a time so queued wrist taps cannot complete
            // out of order and overwrite a newer total.
            const processHydrationCommand = async () => {
              let rollbackDateISO = todayKey();
              let rollbackRow: HydrationSummary | null = null;
              try {
                if (!authToken) return;
                const commandUserId = typeof payload?.userId === 'string' && payload.userId.trim()
                  ? payload.userId.trim()
                  : null;
                const currentUserId = await AsyncStorage.getItem('last_user_id').catch(() => null);
                if (commandUserId && currentUserId && commandUserId !== currentUserId) return;
                const rawOunces = Number(payload?.ounces);
                const rawDelta = Number(payload?.deltaOz ?? payload?.delta_oz);
                const hasDelta = Number.isFinite(rawDelta) && rawDelta !== 0;
                if (hasDelta && (rawDelta < -400 || rawDelta > 400)) return;
                if (!hasDelta && (!Number.isFinite(rawOunces) || rawOunces < 0 || rawOunces > 400)) return;
                const dateISO = String(payload?.dateISO || todayKey()).slice(0, 10);
                rollbackDateISO = dateISO;
                const commandTsMs = Number(payload?.tsMs ?? 0);
                const commandOwner = currentUserId ?? commandUserId ?? 'unknown';
                const commandKey = `watch_hydration_command_ts_v1:${commandOwner}:${dateISO}`;
                if (Number.isFinite(commandTsMs) && commandTsMs > 0) {
                  const lastRaw = await AsyncStorage.getItem(commandKey).catch(() => null);
                  const lastTsMs = lastRaw ? Number(lastRaw) : 0;
                  if (Number.isFinite(lastTsMs) && commandTsMs <= lastTsMs) return;
                }
                const s = rePushStateRef.current;
                const currentRow = s.hydrationByDate?.[dateISO]
                  ?? (dateISO === todayKey() ? s.hydration : null);
                rollbackRow = currentRow;
                const next = hasDelta
                  ? Math.max(0, Math.round(((currentRow?.ounces ?? 0) + rawDelta) * 10) / 10)
                  : Math.max(0, Math.round(rawOunces * 10) / 10);
                const optimistic: HydrationSummary = {
                  date: dateISO,
                  ounces: next,
                  target_ounces: currentRow?.target_ounces ?? 64,
                };
                setHydrationByDate(prev => ({ ...prev, [dateISO]: optimistic }));
                if (dateISO === todayKey()) setHydration(optimistic);
                await saveCachedHydration(optimistic, { pending: true }).catch(() => null);
                const result = hasDelta
                  ? await logHydrationDelta(authToken, rawDelta, dateISO)
                  : await logHydration(authToken, next, dateISO);
                const fresh = await getHydration(authToken, result.date).catch(() => null);
                const saved: HydrationSummary = fresh
                  ? fresh
                  : {
                    date: result.date,
                    ounces: result.ounces,
                    target_ounces: currentRow?.target_ounces ?? 64,
                  };
                await saveCachedHydration(saved).catch(() => null);
                setHydrationByDate(prev => ({ ...prev, [saved.date]: saved }));
                if (saved.date === todayKey()) setHydration(saved);
                if (Number.isFinite(commandTsMs) && commandTsMs > 0) {
                  await AsyncStorage.setItem(commandKey, String(commandTsMs)).catch(() => {});
                }
                const { pushHydrationToWatch } = await import('../utils/watchSync');
                await pushHydrationToWatch({
                  dateISO: saved.date,
                  ounces: saved.ounces,
                  targetOunces: saved.target_ounces,
                });
              } catch {
                const restored = rollbackRow ?? await getHydration(authToken, rollbackDateISO)
                  .then(row => row)
                  .catch(() => null);
                if (restored) {
                  setHydrationByDate(prev => ({ ...prev, [restored.date]: restored }));
                  if (restored.date === todayKey()) setHydration(restored);
                  await saveCachedHydration(restored).catch(() => null);
                } else {
                  setHydrationByDate(prev => {
                    const nextRows = { ...prev };
                    delete nextRows[rollbackDateISO];
                    return nextRows;
                  });
                  if (rollbackDateISO === todayKey()) setHydration(null);
                  await removeCachedHydration(rollbackDateISO).catch(() => null);
                }
                const { pushHydrationToWatch } = await import('../utils/watchSync');
                await pushHydrationToWatch({
                  dateISO: restored?.date ?? rollbackDateISO,
                  ounces: restored?.ounces ?? 0,
                  targetOunces: restored?.target_ounces ?? 64,
                }).catch(() => {});
              }
            };
            homeWatchHydrationCommandChainRef.current = homeWatchHydrationCommandChainRef.current
              .then(processHydrationCommand, processHydrationCommand);
            homeWatchHydrationCommandChainRef.current.catch(() => undefined);
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
            (async () => {
              try {
                const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
                const keys = await AsyncStorage.getAllKeys();
                const sessionKeys = keys.filter(k => k.startsWith('workoutSessionState_') || k.startsWith('activeWorkoutLogs_'));
                if (sessionKeys.length > 0) await AsyncStorage.multiRemove(sessionKeys);
                await AsyncStorage.removeItem('activeWatchSessionId').catch(() => {});
              } catch { /* non-fatal */ }
              // Push explicit skipped status so watch exits active state immediately.
              const skipISO = todayKey();
              const skipSchedule = rePushStateRef.current.schedule as any[];
              const skipTodayItem = skipSchedule?.find((it: any) => dateKey(it.date) === skipISO) ?? skipSchedule?.[0] ?? null;
              try {
                const { pushWorkoutToWatch } = await import('../utils/watchSync');
                const skipWorkout = skipTodayItem?.workout ?? rePushStateRef.current.workoutPlan?.days?.[0] ?? null;
                await pushWorkoutToWatch(skipWorkout, {
                  dateISO: skipISO,
                  status: 'skipped',
                  sessionId: null,
                  reason: 'skip',
                });
              } catch { /* non-fatal */ }
              try {
                const focus = String(skipTodayItem?.workout?.focus || skipTodayItem?.focus || 'workout');
                watchCmdHandlersRef.current.skip(focus);
              } catch { /* non-fatal */ }
            })();
          } else if (command === 'parse_meal_speech') {
            // Watch spoke a meal description — parse it with AI and push
            // the structured preview back to the watch for review.
            (async () => {
              try {
                const text = String(payload?.text || '').trim();
                if (!text || !authToken) return;
                const { parseMealText } = await import('../services/api');
                const { WatchBridge } = await import('../../modules/thallo-watch-bridge');
                const result = await parseMealText(authToken, text).catch(() => null);
                if (!result?.items?.length) return;
                await WatchBridge.syncMealParsePreview(result.items);
              } catch { /* non-fatal */ }
            })();
          } else if (command === 'confirm_meal_speech') {
            // User reviewed parsed items on watch and confirmed — log the
            // meal to the backend and re-push meals so the watch tally updates.
            (async () => {
              try {
                if (!authToken) return;
                const items = (payload?.items as any[]) ?? [];
                if (!items.length) return;
                const todayISO = todayKey();
                const totalCal  = items.reduce((s: number, it: any) => s + Number(it.calories), 0);
                const totalPro  = items.reduce((s: number, it: any) => s + Number(it.protein),  0);
                const totalCarb = items.reduce((s: number, it: any) => s + Number(it.carbs),    0);
                const totalFat  = items.reduce((s: number, it: any) => s + Number(it.fat),      0);
                const mealObj = {
                  meal: items.length === 1
                    ? String(items[0].name)
                    : `${items[0].name} + ${items.length - 1} more`,
                  foods: items.map((it: any) => String(it.name)),
                  amounts: items.map((it: any) => String(it.serving)),
                  items: items.map((it: any) => ({
                    name: String(it.name),
                    quantity: 1,
                    unit: 'serving',
                    calories: Number(it.calories),
                    protein: Number(it.protein),
                    carbs: Number(it.carbs),
                    fat: Number(it.fat),
                    baseQuantity: 1,
                    baseCalories: Number(it.calories),
                    baseProtein: Number(it.protein),
                    baseCarbs: Number(it.carbs),
                    baseFat: Number(it.fat),
                  })),
                  calories: totalCal,
                  protein: totalPro,
                  carbs: totalCarb,
                  fat: totalFat,
                };
                const { logMealChecked } = await import('../services/api');
                await logMealChecked(authToken, {
                  meal_date: todayISO,
                  meal_type: 'extra',
                  meal: mealObj,
                  source: 'watch_speech',
                  consumed_at: consumedAtForMealDate(mealObj, todayISO),
                })
                  .then(() => setMealLogRefreshKey(k => k + 1))
                  .catch(() => null);
                // Re-push updated meals to the watch.
                const s = rePushStateRef.current;
                const todayPlan = s.nutritionPlansByDate[todayISO]
                  ?? (Object.values(s.nutritionPlansByDate)[0] as any);
                const { pushMealsToWatch } = await import('../utils/watchSync');
                await pushMealsToWatch(
                  todayPlan,
                  s.checkedMealsByDate[todayISO],
                  todayISO,
                  s.nutritionScoreData?.score ?? null,
                ).catch(() => {});
              } catch { /* non-fatal */ }
            })();
          } else if (isActiveWorkoutWatchCommand(command)) {
            if (!hasActiveWatchCommandConsumer()) {
              if (command === 'log_set') {
                const mirrorLogSet = async () => {
                  const refState = rePushStateRef.current;
                  const todayScheduleItem = resolveTodayScheduleItem(refState.schedule, refState.workoutPlan, refState.planWeek);
                  const today = todayScheduleItem?.workout ?? refState.workoutPlan?.days?.[0] ?? null;
                  const mirrored = await applyWatchLogSetToActiveWorkoutStorage(today, payload).catch(() => null);
                  if (!mirrored) {
                    await enqueueActiveWatchCommand(command, payload).catch(() => undefined);
                    return;
                  }
                  setResumeInfo({
                    focus: today?.focus ?? 'workout',
                    setsLogged: mirrored.totalSets,
                    startedAt: mirrored.startedAt,
                  });
                  if (authToken && today?.focus && mirrored.loggedPayload.length > 0) {
                    syncInProgressWorkout(
                      authToken,
                      todayKey(),
                      today.focus,
                      mirrored.loggedPayload,
                    ).catch(e => console.warn('[watch] in-progress sync failed:', e?.message ?? e));
                  }
                };
                homeWatchLogSetChainRef.current = homeWatchLogSetChainRef.current.then(mirrorLogSet, mirrorLogSet);
                homeWatchLogSetChainRef.current.catch(() => undefined);
              } else {
                enqueueActiveWatchCommand(command, payload).catch(() => undefined);
              }
            }
          }
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
      const [preserved, manualOverrides] = await Promise.all([
        loadPreservedCompletedWorkouts(),
        loadManualWorkoutOverrides(),
      ]);
      if (mounted) {
        setPreservedWorkouts(preserved);
        setManualWorkoutOverrides(manualOverrides);
      }
    })();
    return () => { mounted = false; };
  }, [workoutPlan, todayDone]);

  useManagedInterval(() => {
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

  const loadDayStatus = async () => {
    const today = todayKey();
    // Use the active PlanWeek's dates so we fetch state for past days
    // inside the visible strip (yesterday's meal checks etc.) — falls
    // back to today→+6 only when no PlanWeek exists yet.
    const mealDays = _activeWeekMealDays();
    const checkMap: Record<string, MealChecks> = {};
    const skipped = new Set<string>();
    const reasonMap: Record<string, string> = {};

    // Forward dates (strictly after today) should NEVER have meal checks —
    // you can't have eaten a meal that's still in the future. Drop any
    // checks the backend returns for those dates as a self-healing
    // measure against historical pollution. Today + past keep their
    // checks (those are the user's actual log).
    const dropForwardChecks = (dayKey: string, checks: MealChecks): MealChecks => {
      return dayKey > today ? {} : checks;
    };

    const canLoadRecoveryInsights = !!userProfile && tierOf(userProfile) === 'pro';
    if (authToken && canLoadRecoveryInsights) {
      const states = await Promise.all(mealDays.map(d => getDayState(authToken, d.key).catch(() => null)));
      mealDays.forEach((d, i) => {
        const s = states[i] as any;
        checkMap[d.key] = dropForwardChecks(d.key, s?.meal_checks ?? {});
        if (s?.skipped_focus) {
          skipped.add(d.key);
          const raw = String(s.skipped_focus);
          reasonMap[d.key] =
            raw === 'travel' ? 'Travel mode'
            : raw === 'pause' ? 'Paused'
            : raw === 'recovery' ? 'Coach swapped to recovery'
            : humanizeToken(raw);
        }
        if (s?.skip_reason) reasonMap[d.key] = s.skip_reason;
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
    checkedMealsByDateRef.current = checkMap;
    setCheckedMealsByDate(checkMap);

    // Load skip reasons, completed dates, summaries, and preserved
    // completions through one shared in-flight read so mount effects do not
    // parse the same AsyncStorage blobs several times.
    const { history, summaries, preserved, manualOverrides } = await loadWorkoutHistoryBundle();
    const completed = new Set<string>();
    for (const s of history) {
      if (s.skipped && s.skipReason && !reasonMap[s.date]) reasonMap[s.date] = s.skipReason;
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
    if (done || skipped.has(today)) {
      // Suppress today's workout reminder so the user isn't pinged after
      // training or explicitly skipping. The reminder helper preserves the
      // next future occurrence without re-firing today.
      import('../utils/workoutReminders')
        .then(({ cancelTodayWorkoutReminder }) => cancelTodayWorkoutReminder())
        .catch(() => undefined);
    }

    const todaySummaryEntry = summaries.find(s => s.date.startsWith(today)) ?? null;
    setTodaySummary(todaySummaryEntry);

    setPreservedWorkouts(preserved);
    setManualWorkoutOverrides(manualOverrides);

    if (authToken) {
      try {
        const { getFatigueScore } = await import('../services/api');
        const fs = await getFatigueScore(authToken);
        setReadinessScore({
          score: fs.readiness_score,
          label: fs.readiness_label,
          topFatigued: fs.top_fatigued ?? [],
          muscleFatigue: fs.muscle_fatigue ?? {},
          focusReadiness: fs.focus_readiness ?? {},
          activities: fs.activities ?? [],
          nutritionContext: fs.nutrition_context ?? null,
        });
        console.log(`[fatigue] readiness=${fs.readiness_score}% top=${(fs.top_fatigued ?? []).map((t: any) => t.muscle).join(',')}`);
      } catch (e) {
        console.log('[fatigue] fetch failed:', e);
        // Show fresh state so the badge always appears
        setReadinessScore({ score: 100, label: 'Fresh', topFatigued: [], focusReadiness: {} });
      }
      // Nutrition score is fetched from /meals/score; plan-preview scoring
      // is only the offline/free fallback.
      import('../services/api').then(({ getPlateaus }) =>
        getPlateaus(authToken, 4)
          .then(r => {
            const names = new Set((r.plateaus || []).map(p => p.exercise_name.toLowerCase()));
            setPlateauedExercises(names);
          })
          .catch(() => setPlateauedExercises(new Set()))
      );
    } else {
      setReadinessScore({ score: 100, label: 'Fresh', topFatigued: [], focusReadiness: {} });
      setPlateauedExercises(new Set());
    }
  };

  const loadPlans = async (profile: UserProfile) => {
    // Track the latest profile so a post-finish rerun (triggered when an
    // effect fired during our in-flight run) always sees the newest snapshot.
    loadPlansLatestProfileRef.current = profile;
    // Drop concurrent / duplicate calls, but remember that one arrived so
    // we re-fire after the current run finishes. Without this, a
    // profile-save refresh that bumps `planRefreshKey` mid-load gets
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

    // Older builds set this flag to skip backend PlanWeek hydration once.
    // That could clear the dated PlanWeek and cause a cold-open regeneration
    // if the legacy cache was the only thing rendered. Consume it as a stale
    // flag only; DB PlanWeek is the source of truth.
    const skipFlag = await AsyncStorage.getItem('_skipNextPlanHydration');
    if (skipFlag) {
      await AsyncStorage.removeItem('_skipNextPlanHydration');
      console.log('[loadPlans] removed legacy skip-hydration flag');
    }

    const tierIsFree = tierOf(profile) === 'free';
    if (tierIsFree) {
      aiWorkoutRaw = null;
      planWeekRef.current = null;
      setPlanWeek(null);
      await AsyncStorage.removeItem('aiWorkoutPlan').catch(() => {});
    }

    // Backend is the source of truth. Fetch the persisted 7-day PlanWeek;
    // if none exists yet (first run or pre-migration user), generate one
    // immediately via /plans/start-new-week. The PlanWeek's days are
    // dated and individually tracked, so the schedule below renders
    // exactly what's persisted — no daily regeneration, no rolling
    // index. On network failure we fall back to the AsyncStorage cache
    // so offline users still see their last-known plan.
    if (authToken && !tierIsFree) {
      try {
        const { getActivePlanWeek, startNewPlanWeek, autoRenewPlanWeek } = await import('../services/api');
        const cycle = await import('../services/appleHealth')
          .then(({ getCycleStatus }) => getCycleStatus())
          .catch(() => null);
        const cycleContext = cycle && cycle.phase !== 'unknown'
          ? { cyclePhase: cycle.phase, dayOfCycle: cycle.dayOfCycle }
          : null;
        let pw = await getActivePlanWeek(authToken);
        if (!pw) {
          console.log('[loadPlans] no active PlanWeek — generating a fresh 7-day plan');
          try {
            pw = await startNewPlanWeek(authToken, false, cycleContext);
          } catch (e) {
            console.log('[loadPlans] startNewPlanWeek failed (will fall back to legacy cache):', e);
          }
        } else if (pw.needs_new_week) {
          // The active week's end_date has passed — auto-renew immediately.
          // WeeklyCheckinCard separately surfaces the expired week's one-day
          // coach review window and saved recap.
          console.log(`[loadPlans] PlanWeek expired (ended ${pw.end_date}) — auto-renewing`);
          try {
            const renewed = await autoRenewPlanWeek(authToken, cycleContext);
            if ('checkin_required' in renewed && renewed.checkin_required) {
              console.log(`[loadPlans] legacy check-in-required response for plan_week_id=${renewed.plan_week_id} — using stale week`);
            } else if ((renewed as any)?.plan_week) {
              const nextPw = (renewed as any).plan_week;
              pw = nextPw;
              console.log(`[loadPlans] auto-renewed: new week ${nextPw.start_date} → ${nextPw.end_date}`);
            }
          } catch (e) {
            console.log('[loadPlans] autoRenewPlanWeek failed (using stale week):', e);
          }
        }
        if (pw?.days?.length) {
          planWeekRef.current = pw;
          setPlanWeek(pw);
          // Project the PlanWeek into a legacy WorkoutPlan shape so the
          // existing rendering code (DayCard, get7DaySchedule consumers,
          // etc.) keeps working while we migrate them off the cycling
          // model. Each PlanDay's `workout` is already WorkoutDay-shaped.
          const projected = workoutPlanFromPlanWeek(pw);
          const serialized = JSON.stringify(projected);
          await AsyncStorage.setItem('aiWorkoutPlan', serialized).catch(() => {});
          aiWorkoutRaw = serialized;
          console.log(`[loadPlans] hydrated PlanWeek ${pw.start_date} → ${pw.end_date} (${pw.days.length} days, needs_new_week=${pw.needs_new_week})`);
        } else {
          // Legacy fallback: try the old WorkoutPlan endpoint so users
          // mid-migration don't lose their cached plan.
          const { getActiveWorkoutPlan } = await import('../services/api');
          const active = await getActiveWorkoutPlan(authToken);
          if (active?.plan_json) {
            const serialized = JSON.stringify(active.plan_json);
            await AsyncStorage.setItem('aiWorkoutPlan', serialized).catch(() => {});
            aiWorkoutRaw = serialized;
            console.log('[loadPlans] hydrated from legacy WorkoutPlan endpoint');
          } else {
            console.log('[loadPlans] no PlanWeek and no legacy plan — using cache');
          }
        }
      } catch (e) {
        console.log('[loadPlans] PlanWeek fetch failed (using cache):', e);
      }
    }

    const emptyWorkoutPlan: WorkoutPlan = {
      name: 'No active plan',
      totalDays: 0,
      days: [],
    };
    if (!aiWorkoutRaw) {
      if (tierIsFree || !authToken) {
        console.warn('[loadPlans] no saved aiWorkoutPlan — using free/manual local scaffold');
      } else {
        console.warn('[loadPlans] no persisted workout plan — showing empty plan state');
      }
    }
    let baseWorkout: WorkoutPlan = aiWorkoutRaw
      ? JSON.parse(aiWorkoutRaw)
      : (tierIsFree || !authToken)
        ? generateWorkoutPlan(profile)
        : emptyWorkoutPlan;

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

    // Daily fresh-day regeneration removed (2026-04-28). The plan now
    // comes from the persisted PlanWeek (`/plans/week/active`) and stays
    // stable for the full 7 days; renewal happens explicitly via
    // `/plans/week/auto-renew` when `needs_new_week === true`. Single-day
    // regeneration on app open caused today's workout to silently change,
    // and conflicted with the dated-day model.

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
    // Free tier: skip the entire nutrition plan hydration path. Free users
    // don't get generated meals — every day starts empty and they fill it
    // via Add Meal / saved meals / routines. Skipping the fetch here means
    // no stale generated plan can re-appear if the user upgrades, then
    // downgrades. The empty-plan fallback at the day-card render handles
    // the rest.
    if (authToken && !tierIsFree) {
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

    // Free tier: never seed rotating templates from cache either. A user
    // who downgraded after generating once would otherwise keep seeing
    // their old generated meals forever. Empty array → every day-card
    // falls through to the empty-plan scaffold and the user fills it
    // manually.
    let rotatingTemplates: DailyNutritionPlan[] = [];
    if (!tierIsFree) {
      const rawPlans = await AsyncStorage.getItem('aiNutritionPlans');
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
    }

    // Use the active PlanWeek's dates (Mon-Sun anchor) so meal-plan
    // hydration covers past days inside the visible strip too.
    const mealDays = _activeWeekMealDays();

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
        const activePlanWeekForMeals = planWeekRef.current ?? planWeek;
        const planWeekTemplate = activePlanWeekForMeals?.days?.find(pd => pd.day_date === d.key)?.nutrition ?? null;
        const freshTemplate = rotatingTemplates.length > 0 ? rotatingTemplates[i % rotatingTemplates.length] : null;
        const templateHasMicros = hasLayer2Micros(freshTemplate);
        const pickedPathRef: { name: string } = { name: 'none' };

        const saved = await getSavedNutritionPlan(d.key);
        // User edits always win — only require macros + version stamp.
        // The old micros check was rejecting user edits that added foods
        // without micronutrient data (e.g. local library foods).
        const savedIsUsable = saved && hasMealMacros(saved) && stampOk(saved);
        console.log(`[loadPlans] ${d.key}: saved=${!!saved} meals=${saved?.meals?.length ?? 0} usable=${savedIsUsable} savedStamp=${(saved as any)?._templatesVersion ?? 'NONE'} currentStamp=${currentVersion ?? 'NONE'}`);
        if (!tierIsFree && savedIsUsable) {
          picked = normalize(saved);
          pickedPathRef.name = 'saved';
        }
        if (!tierIsFree && !picked && authToken) {
          const remote = await getDayState(authToken, d.key).catch(() => null) as any;
          const remoteOk = remote?.nutrition_plan && hasMealMacros(remote.nutrition_plan) && stampOk(remote.nutrition_plan);
          if (remoteOk) {
            picked = normalize(remote.nutrition_plan);
            pickedPathRef.name = 'remote';
          }
        }
        if (tierIsFree && !picked) {
          picked = {
            meals: [],
            removedMealIds: [],
            targets: { calories: 0, protein: 0, carbs: 0, fat: 0 },
          } as DailyNutritionPlan;
          pickedPathRef.name = 'free-empty';
        }
        if (!tierIsFree && !picked && planWeekTemplate && hasMealMacros(planWeekTemplate as any)) {
          picked = normalize(planWeekTemplate);
          pickedPathRef.name = 'planWeek';
        }
        if (!tierIsFree && !picked && freshTemplate && hasMealMacros(freshTemplate)) {
          picked = normalize(freshTemplate);
          pickedPathRef.name = 'template';
        }
        if (!tierIsFree && !picked) {
          picked = normalize(generateDailyNutritionForDate(profile, allFoodsWithCustom, d.key));
          pickedPathRef.name = 'fallback';
        }
        if (!picked) {
          picked = {
            meals: [],
            removedMealIds: [],
            targets: { calories: 0, protein: 0, carbs: 0, fat: 0 },
          };
          pickedPathRef.name = 'empty';
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

    nutritionPlansByDateRef.current = raw;
    setNutritionPlansByDate(raw);

    // ── Background enrichment for routine/custom meals missing micros ──
    // Routine meals are overlaid client-side and never go through the
    // server's post-assembly enrichment. Fire a background call to fill
    // in micros for any items that lack them.
    if (authToken && !tierIsFree) {
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
  // between the Library sub-tab and the plan-view
  // swap flow (warmed lazily when the user taps Swap). Returns the
  // loaded list so callers that need it synchronously (e.g. Info
  // button looking up the tapped exercise) don't have to wait for
  // state to propagate through React.
  const customExerciseLibraryItems = useCallback(() => (
    (userProfile?.customExercises ?? []).map(ce => ({
        id: ce.id as any,
        name: ce.name,
        primary_muscle: ce.primary_muscle,
        secondary_muscles: (ce.secondary_muscles ?? []) as string[],
        equipment: ce.equipment,
        movement_pattern: ce.movement_pattern ?? null,
        image_url: ce.image_url ?? null,
        video_id: ce.video_id ?? null,
        is_compound: ce.is_compound ?? null,
        description: ce.description ?? '',
        is_custom: true,
      })) as unknown as ExerciseLibraryItem[]
  ), [userProfile?.customExercises]);

  const ensureExerciseLibrary = useCallback(async (): Promise<ExerciseLibraryItem[]> => {
    const cached = exerciseLibraryRef.current;
    if (cached.length > 0) return cached;
    if (exerciseLibraryLoadPromiseRef.current) return exerciseLibraryLoadPromiseRef.current;

    const loadPromise = (async () => {
      if (exerciseLibraryRef.current.length === 0) setExerciseLibraryLoading(true);
      const customs = customExerciseLibraryItems();
      try {
        const rows = await getExercises();
        const combined = [...customs, ...rows];
        exerciseLibraryRef.current = combined;
        setExerciseLibrary(combined);
        primeThumbnailIndex(combined as any);
        return combined;
      } catch {
        exerciseLibraryRef.current = customs;
        setExerciseLibrary(customs);
        return customs;
      } finally {
        setExerciseLibraryLoading(false);
        exerciseLibraryLoadPromiseRef.current = null;
      }
    })();

    exerciseLibraryLoadPromiseRef.current = loadPromise;
    return loadPromise;
  }, [customExerciseLibraryItems]);
  ensureExerciseLibraryRef.current = ensureExerciseLibrary;

  useEffect(() => {
    exerciseLibraryRef.current = exerciseLibrary;
  }, [exerciseLibrary]);

  useEffect(() => {
    ensureExerciseLibraryRef.current = ensureExerciseLibrary;
  }, [ensureExerciseLibrary]);

  useEffect(() => {
    if (activeTab === 'workout') ensureExerciseLibraryRef.current?.().catch(() => {});
  }, [activeTab]);

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
      secondary_muscles: ex.secondary_muscles ?? [],
      equipment: ex.equipment,
      movement_pattern: ex.movement_pattern ?? null,
      image_url: ex.image_url ?? null,
      video_id: ex.video_id ?? null,
      is_compound: ex.is_compound ?? null,
      sets: ex.sets,
      reps: ex.reps,
      rest_seconds: ex.rest_seconds,
      description: ex.why,
      form_cues: ex.form_cues,
      source: 'ai',
      createdAt: new Date().toISOString(),
    };
    const nextCustoms = [...existing, newItem];
    const libraryItem = ({
      id: newItem.id as any,
      name: newItem.name,
      primary_muscle: newItem.primary_muscle,
      secondary_muscles: (newItem.secondary_muscles ?? []) as string[],
      equipment: newItem.equipment,
      movement_pattern: newItem.movement_pattern ?? null,
      image_url: newItem.image_url ?? null,
      video_id: newItem.video_id ?? null,
      is_compound: newItem.is_compound ?? null,
      description: newItem.description ?? '',
      is_custom: true,
    }) as unknown as ExerciseLibraryItem;
    const nextLibrary = [libraryItem, ...exerciseLibraryRef.current];
    exerciseLibraryRef.current = nextLibrary;
    setExerciseLibrary(nextLibrary);
    // Persist via the parent's profile-update callback. `skipRegen: true`
    // so we don't trigger a plan regeneration just from saving an exercise.
    onProfileUpdate?.({ customExercises: nextCustoms } as any, true);
    Alert.alert('Saved', `${ex.name} added to your exercise library.`);
  }, [userProfile, onProfileUpdate]);

  const exerciseMuscleOptions = useMemo(() => Array.from(
    new Set(exerciseLibrary.map((item) => item.primary_muscle).filter(Boolean) as string[])
  ).sort((a, b) => humanizeToken(a).localeCompare(humanizeToken(b))), [exerciseLibrary]);

  const exerciseEquipmentOptions = useMemo(() => Array.from(
    new Set(exerciseLibrary.map((item) => item.equipment).filter(Boolean) as string[])
  ).sort((a, b) => humanizeToken(a).localeCompare(humanizeToken(b))), [exerciseLibrary]);

  const filteredExerciseLibrary = useMemo(() => exerciseLibrary.filter((item) => {
    const search = deferredExerciseSearch.trim().toLowerCase();
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
  }), [exerciseLibrary, deferredExerciseSearch, exerciseMuscleFilter, exerciseEquipmentFilter]);

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
        readiness: readinessScore ? {
          score: readinessScore.score,
          label: readinessScore.label,
          topFatigued: readinessScore.topFatigued ?? [],
          nutritionContext: readinessScore.nutritionContext ?? null,
        } : null,
        nutritionScore: nutritionScoreData ? {
          score: nutritionScoreData.score,
          confidence: nutritionScoreData.confidence,
          improvements: nutritionScoreData.improvements?.slice(0, 3) ?? [],
          wins: nutritionScoreData.wins?.slice(0, 3) ?? [],
        } : null,
        loggedToday: {
          checkedMeals: Object.values(checkedMealsByDate[todayKey()] ?? {}).filter(Boolean).length,
          plannedMeals: todayPlan?.meals?.length ?? 0,
          hydrationOz: hydration?.ounces ?? null,
          hydrationTargetOz: hydration?.target_ounces ?? null,
        },
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

      const rawResp = await askTrainerQuestion(authToken, {
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
        // Send only prior turns; the current user message is already
        // carried as `question` and duplicating it in history muddies
        // follow-up handling.
        conversation: activeChat.slice(-6),
        image_base64: imageToSend?.base64 ?? undefined,
        mime_type: 'image/jpeg',
        userContext,
      });
      const resp: typeof rawResp = {
        ...rawResp,
        // Guardrail: chat is advisory + settings-only. Active PlanWeek
        // edits must go through deterministic app controls, not AI-
        // generated replacement plan payloads.
        needs_plan_update: false,
        updated_workout_plan: null,
        updated_nutrition_plan: null,
      };

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

      // Chat can propose settings changes, but active PlanWeek / meal-template
      // replacements are stripped above and must use deterministic app controls.
      const canUpdateWorkout   = false;
      const canUpdateNutrition = false;
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
          summaryParts.push('Meal targets changed');
        }
        // Goal changes: ONLY honor the structured `updated_goal` field from
        // the AI response. The previous loose-text-match fallback (scanning
        // the question + AI answer for any goal label like "fat loss" or
        // "muscle gain") was firing on incidental mentions — e.g. asking
        // "should I add cardio for fat loss?" would auto-stage a goal
        // change to lose_fat, then a stray Apply tap would silently flip
        // the user's goal. Strict structured field only.
        const structuredGoalRaw = typeof (resp as any).updated_goal === 'string' ? (resp as any).updated_goal.trim() : '';
        const structuredGoal = structuredGoalRaw || null;
        const matchedGoal = structuredGoal ? (PRIMARY_GOALS.find(g => g.id === structuredGoal) ?? null) : null;
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

        const summary = summaryParts.length > 0 ? summaryParts.join(' · ') : 'Settings change proposed';
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
              const exercisesPayload = workoutSessionToLoggedPayload(session);
              logWorkoutDone(
                authToken,
                w.date,
                session.focus,
                session.durationSeconds,
                exercisesPayload.length > 0 ? exercisesPayload : undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                {
                  sourceContext: 'coach_log',
                  startedAt: session.startedAt ?? session.date,
                  endedAt: session.endedAt ?? new Date(new Date(session.date).getTime() + session.durationSeconds * 1000).toISOString(),
                  externalSourceId: session.id,
                },
              ).catch(() => null);
            }
            if (w.date === today) {
              setTodayDone(true);
              import('../utils/workoutReminders')
                .then(({ cancelTodayWorkoutReminder }) => cancelTodayWorkoutReminder())
                .catch(() => undefined);
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
  }, [trainerInput, attachedImage, authToken, userProfile, workoutPlan, nutritionPlansByDate, checkedMealsByDate, hydration, readinessScore, nutritionScoreData, todayDone, skippedDates, workoutChat, workoutChat, coachMode, chatTopic, persistDayState]);

  // ── Approval flow for plan changes ───────────────────────────────────────
  const applyPendingUpdate = useCallback(async () => {
    if (!pendingUpdate) return;
    const { resp, question: q, coachMode: mode, profileChanges } = pendingUpdate;
    const setActiveChat = mode === 'trainer' ? setWorkoutChat : setWorkoutChat;
    setIsChatPlanUpdating(true);
    setPendingUpdate(null);
    try {
      const canUpdateWorkout   = false;
      const canUpdateNutrition = false;
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
          content: 'I described a change that needs a deterministic app control. Use the Workout tab for current-week edits, or ask for a future settings recommendation.',
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
      setActiveChat(prev => [...prev, { role: 'assistant', content: `Settings saved.` }]);
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
    const current = checkedMealsByDateRef.current[date] ?? {};
    const wasChecked = !!current[mealType];
    const next = { ...current, [mealType]: !wasChecked };
    checkedMealsByDateRef.current = { ...checkedMealsByDateRef.current, [date]: next };
    setCheckedMealsByDate(prev => ({ ...prev, [date]: next }));
    await saveMealChecks(date, next);
    await persistDayState(date, { meal_checks: next });

    // If this check completes today's plan, suppress the 9pm reminder
    // for today — no point nudging the user when they've already logged
    // everything. `maybeCancelTodayReminder` no-ops if reminder is off.
    try {
      if (date === todayKey()) {
        const todayPlan = nutritionPlansByDateRef.current[date];
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
    const plan = nutritionPlansByDateRef.current[date];
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
          consumed_at: consumedAtForMealDate(meal, date),
        })
          .then(() => setMealLogRefreshKey(k => k + 1))
          .catch(err => console.log('[logMealChecked] background save failed:', err.message));
      }
    } else {
      const localId = (meal as any)._localId;
      await clearPreservedMeal(date, mealType, localId);
      if (authToken && meal) {
        const payload = {
          meal_date: date,
          meal_type: mealType,
          meal: meal as Record<string, any>,
        };
        unlogMealChecked(authToken, { ...payload, source: 'plan_check' })
          .then(result => {
            if ((result?.deleted ?? 0) > 0) {
              setMealLogRefreshKey(k => k + 1);
              return null;
            }
            return unlogMealChecked(authToken, { ...payload, source: 'manual_add' })
              .then(fallback => {
                if ((fallback?.deleted ?? 0) > 0) setMealLogRefreshKey(k => k + 1);
              });
          })
          .catch(err => console.log('[unlogMealChecked] background delete failed:', err.message));
      }
    }
  }, [persistDayState, authToken]);

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
    const isNewMeal = mealType === 'new_meal' || mealType === 'new_extra';
    const mutation = upsertMealInPlansByDate(
      nutritionPlansByDateRef.current,
      date,
      mealType,
      updated,
      {
        makeLocalId: () => `manual_meal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      },
    );
    const nextPlan = mutation.plan;
    const savedMealType = mutation.mealType;
    const savedIdx = mutation.mealIndex;
    updated = mutation.meal;
    if (nextPlan) {
      nutritionPlansByDateRef.current = mutation.plansByDate;
      setNutritionPlansByDate(mutation.plansByDate);
      console.log(`[handleMealSave] built nextPlan with ${(nextPlan.meals ?? []).length} meals, stamp=${(nextPlan as any)?._templatesVersion ?? 'NONE'}`);
    } else {
      console.log(`[handleMealSave] no current plan for ${date}`);
    }
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
    const wasAlreadyChecked = !!(checkedMealsByDateRef.current[date] ?? {})[savedMealType];
    // Auto-check + auto-log are reserved for user-initiated saves only.
    // Hydration paths (routine application, plan migration) call this
    // with `userInitiated=false` and must NOT silently mark meals
    // complete on the user's behalf.
    const shouldLog = userInitiated && (isNewMeal || wasAlreadyChecked);
    if (shouldLog && authToken && savedIdx >= 0) {
      if (isNewMeal) {
        // Auto-check: persist the check state + snapshot the preserved meal.
        const checkMutation = setMealCheckedInChecksByDate(checkedMealsByDateRef.current, date, savedMealType, true);
        checkedMealsByDateRef.current = checkMutation.checksByDate as Record<string, MealChecks>;
        setCheckedMealsByDate(checkMutation.checksByDate as Record<string, MealChecks>);
        await saveMealChecks(date, checkMutation.dateChecks);
        await persistDayState(date, { meal_checks: checkMutation.dateChecks });
        try { await savePreservedMeal(date, savedMealType, updated); } catch {}
      }
      // Fire-and-forget to backend; failures don't block save.
      logMealChecked(authToken, {
        meal_date: date,
        meal_type: savedMealType,
        meal: updated as Record<string, any>,
        source: isNewMeal ? 'manual_add' : 'plan_check',
        consumed_at: consumedAtForMealDate(updated, date),
      })
        .then(() => setMealLogRefreshKey(k => k + 1))
        .catch(err => console.log('[handleMealSave] meal-log background save failed:', err?.message));
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
  }, [persistDayState, authToken]);

  const handleHistoryMealSave = useCallback(async (date: string, mealType: string, mealId: number, updated: MealSuggestion) => {
    if (!authToken) return;
    const normalized = ensureItems(updated);
    const items = mealSuggestionToHistoryItems(normalized);
    const totals = items.reduce(
      (acc, it) => ({
        calories: acc.calories + Number(it.calories || 0),
        protein_g: acc.protein_g + Number(it.protein_g || 0),
        carbs_g: acc.carbs_g + Number(it.carbs_g || 0),
        fat_g: acc.fat_g + Number(it.fat_g || 0),
      }),
      { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
    );
    const name = normalized.meal || (normalized as any).name || 'Meal';
    const consumed_at = consumedAtForMealDate(normalized, date);

    try {
      await updateMeal(authToken, mealId, { name, consumed_at, items });
      setBackendMealHistory(prev => prev?.map(entry => entry.id === mealId
        ? { ...entry, name, consumed_at, items, totals }
        : entry,
      ) ?? prev);

      let nextPlan: DailyNutritionPlan | null = null;
      setNutritionPlansByDate(prev => {
        const current = prev[date];
        if (!current) return prev;
        const meals = [...(current.meals ?? [])];
        let idx = meals.findIndex(m => (m as any)._loggedMealId === mealId);
        if (idx < 0 && mealType.startsWith('meal_')) {
          const parsed = parseInt(mealType.slice(5), 10);
          if (parsed >= 0 && parsed < meals.length) idx = parsed;
        }
        if (idx < 0) return prev;
        meals[idx] = { ...normalized, _loggedMealId: mealId } as MealSuggestion;
        nextPlan = { ...current, meals };
        return { ...prev, [date]: nextPlan as DailyNutritionPlan };
      });
      if (nextPlan) {
        await saveNutritionPlan(date, nextPlan);
        await persistDayState(date, { nutrition_plan: nextPlan });
        if (mealType.startsWith('meal_')) {
          try { await savePreservedMeal(date, mealType, { ...normalized, _loggedMealId: mealId } as MealSuggestion); } catch {}
        }
      }
      setMealLogRefreshKey(k => k + 1);
    } catch (err: any) {
      Alert.alert('Could not save meal', err?.message || 'The meal history update did not go through.');
    }
  }, [authToken, persistDayState]);

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
    const idx = mealType.startsWith('meal_') ? parseInt(mealType.slice(5), 10) : -1;
    if (idx < 0 || !userProfile) return;

    setShufflingInfo({ date, mealKey: mealType });
    try {
      const { generateMealSuggestion } = await import('../utils/planGenerator');
      const foodList = meta.foods ?? [];
      const foodMap: Record<string, any> = {};
      for (const f of foodList) foodMap[f.name.toLowerCase()] = f;
      for (const f of (userProfile.customFoods ?? [])) foodMap[f.name.toLowerCase()] = f as any;

      // Exclude the current meal's foods so the shuffle always returns
      // something different (otherwise the same seed-set can re-pick the
      // same ingredients on a small preference pool).
      const currentFoodsLower = new Set((meal.foods ?? []).map(f => f.toLowerCase()));

      const prefNames = userProfile.foodsAvailable ?? [];
      const customNames = (userProfile.customFoods ?? []).map(f => f.name);
      const catalogNames = Object.keys(foodMap).filter(n => foodMap[n]).map(n => foodMap[n].name);

      // Dedup helper preserving insertion order.
      const dedup = (names: string[]): string[] => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const n of names) {
          const k = n.toLowerCase();
          if (!seen.has(k) && foodMap[k] && !currentFoodsLower.has(k)) { seen.add(k); out.push(n); }
        }
        return out;
      };

      // Two pools: preference-only (user's chosen foods + custom) and the
      // full catalog. We use the pref pool for most candidates so the
      // shuffle stays within foods the user actually likes. The catalog
      // pool covers the minority of iterations to add variety when the
      // pref pool is thin.
      const prefPool  = dedup([...prefNames, ...customNames]);
      const widePool  = dedup([...prefNames, ...customNames, ...catalogNames]);

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

      const mealCalTarget = hasValidTargets
        ? Math.max(200, Math.round((dayTargets.calories || 0) - otherCal))
        : Math.max(200, Math.round(meal.calories || 500));
      // Cap protein at 40% of calories — unrealistic targets (e.g. after
      // eating mostly fat today) produce protein-only meals.
      const rawProTarget = hasValidTargets
        ? Math.max(10, Math.round((dayTargets.protein || 0) - otherPro))
        : Math.max(10, Math.round(meal.protein || 30));
      const mealProTarget = Math.min(rawProTarget, Math.round(mealCalTarget * 0.40 / 4));
      const mealCarbTarget = hasValidTargets
        ? Math.max(10, Math.round((dayTargets.carbs || 0) - otherCarb))
        : Math.max(10, Math.round(meal.carbs || 40));
      const mealFatTarget = hasValidTargets
        ? Math.max(5, Math.round((dayTargets.fat || 0) - otherFat))
        : Math.max(5, Math.round(meal.fat || 15));

      // Generate 20 candidates. First 15 use the preference pool (foods the
      // user actually likes); last 5 draw from the full catalog for variety.
      // Pick whichever scores best on macro proximity.
      const CANDIDATES = 20;
      const PREF_CUTOFF = 15;
      let best: { meal: MealSuggestion; score: number } | null = null;
      for (let i = 0; i < CANDIDATES; i++) {
        const pool = i < PREF_CUTOFF && prefPool.length >= 3 ? prefPool : widePool;
        const seed = `shuffle:${date}:${idx}:${Date.now()}:${i}:${Math.random()}`;
        const candidate = generateMealSuggestion(meal.meal || 'Meal', mealCalTarget, pool, foodMap, seed);

        const dCarb = Math.abs((candidate.carbs || 0) - mealCarbTarget) / Math.max(1, mealCarbTarget);
        const dFat  = Math.abs((candidate.fat  || 0) - mealFatTarget)  / Math.max(1, mealFatTarget);
        // Asymmetric protein penalty: shortfall is costly (users chronically
        // undereat protein); overage is fine and only lightly penalized.
        const proShortfall = Math.max(0, mealProTarget - (candidate.protein || 0)) / Math.max(1, mealProTarget);
        const proOverage   = Math.max(0, (candidate.protein || 0) - mealProTarget) / Math.max(1, mealProTarget);
        const dPro = proShortfall * 3.5 + proOverage * 0.3;

        const score = dPro + dCarb * 1.0 + dFat * 1.0;
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
    } finally {
      setShufflingInfo(null);
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
      if (!canCreateMealRoutine(userProfile, routines.length)) {
        Alert.alert(
          'Routine limit reached',
          `Free accounts can pin up to ${FREE_MEAL_ROUTINE_LIMIT} meal routines. Upgrade to Pro for unlimited routines.`,
        );
        return;
      }
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
  }, [nutritionPlansByDate, userProfile]);

  const handleSkipToday = useCallback((focus: string) => {
    import('../utils/feedback').then(f => f.hapticWarning()).catch(() => {});
    setSelectedSkipReason('');
    setCustomSkipReason('');
    setSkipReasonFocus(focus);
  }, []);

  const scheduleRawRef = useRef<ScheduleItem[]>([]);

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
    const todayScheduleItem = scheduleRawRef.current.find(
      item => dateKey(item.date) === today && item.workout,
    );
    if (todayScheduleItem?.workout) {
      await savePreservedCompletedWorkout(today, todayScheduleItem.workout);
      setPreservedWorkouts(prev => ({ ...prev, [today]: todayScheduleItem.workout! }));
    }
    await persistDayState(today, { skipped_focus: focus, skip_reason: reason ?? null });
    await saveSkipToHistory(today, focus, reason);
    let shouldRefreshPlanWeek = false;
    if (authToken) {
      try {
        const { skipPlanDay } = await import('../services/api');
        await skipPlanDay(authToken, today, reason ?? null);
        shouldRefreshPlanWeek = true;
      } catch (e) {
        console.log('[skipDay] backend skip failed:', e);
      }
    }
    // Suppress today's workout reminder — user explicitly opted out.
    import('../utils/workoutReminders')
      .then(({ cancelTodayWorkoutReminder }) => cancelTodayWorkoutReminder())
      .catch(() => undefined);

    // Push today's workout to tomorrow when user selects "push".
    if (type === 'push' && todayScheduleItem?.workout && authToken) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = dateKey(tomorrow);
      try {
        const { patchPlanDayWorkout } = await import('../services/api');
        await patchPlanDayWorkout(authToken, tomorrowStr, todayScheduleItem.workout);
        shouldRefreshPlanWeek = true;
        setSelectedWorkoutDayKey(tomorrowStr);
      } catch (e) {
        console.log('[skipDay] push-to-tomorrow failed:', e);
      }
    }

    if (shouldRefreshPlanWeek && authToken) {
      try {
        const { getActivePlanWeek } = await import('../services/api');
        const freshWeek = await getActivePlanWeek(authToken);
        if (freshWeek?.days?.length) {
          planWeekRef.current = freshWeek;
          setPlanWeek(freshWeek);
          const projected = workoutPlanFromPlanWeek(freshWeek);
          setWorkoutPlan(projected);
          AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(projected)).catch(() => {});
        }
      } catch (e) {
        console.log('[skipDay] plan refresh failed:', e);
      }
    }

    // When skipping due to illness, reduce today's calorie/protein targets.
    const reasonLower = (customSkipReason.trim() || selectedSkipReason || '').toLowerCase();
    const isSick = reasonLower.includes('sick') || reasonLower === 'feeling sick';
    if (isSick) {
      const todayPlan = nutritionPlansByDate[today];
      if (todayPlan?.targets) {
        const adjusted: typeof todayPlan = {
          ...todayPlan,
          targets: {
            ...todayPlan.targets,
            calories: Math.round(todayPlan.targets.calories * 0.85),
            protein: Math.round(todayPlan.targets.protein * 0.80),
          },
        };
        await persistDayState(today, { nutrition_plan: adjusted });
        setNutritionPlansByDate(prev => ({ ...prev, [today]: adjusted }));
      }
    }
  }, [skipReasonFocus, selectedSkipReason, customSkipReason, skipType, persistDayState, authToken, nutritionPlansByDate]);

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
    await persistDayState(date, { skipped_focus: null, skip_reason: null });
    if (authToken) {
      try {
        const { unskipPlanDay, getActivePlanWeek } = await import('../services/api');
        await unskipPlanDay(authToken, date);
        const freshWeek = await getActivePlanWeek(authToken);
        if (freshWeek?.days?.length) {
          planWeekRef.current = freshWeek;
          setPlanWeek(freshWeek);
          const projected = workoutPlanFromPlanWeek(freshWeek);
          setWorkoutPlan(projected);
          AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(projected)).catch(() => {});
        }
      } catch (e) {
        console.log('[skipDay] unskip failed:', e);
      }
    }
  }, [authToken, persistDayState]);

  const handlePeriodLighterWorkout = useCallback(async () => {
    const today = todayKey();
    const todayScheduleItem = scheduleRawRef.current.find(item => dateKey(item.date) === today)
      ?? resolveTodayScheduleItem(scheduleRawRef.current, workoutPlan, planWeek);
    if (!todayScheduleItem?.workout) return;

    const adjustedWorkout = reduceWorkoutForCycleSymptoms(todayScheduleItem.workout);

    if (authToken && planWeekRef.current?.days?.length) {
      const { patchPlanDayWorkout } = await import('../services/api');
      const savedDay = await patchPlanDayWorkout(authToken, today, adjustedWorkout);
      const baseWeek = planWeekRef.current;
      const nextWeek = {
        ...baseWeek,
        days: baseWeek.days.map(pd =>
          pd.day_date === today
            ? { ...pd, is_rest: savedDay.is_rest, workout: savedDay.workout, status: savedDay.status, locked: savedDay.locked }
            : pd,
        ),
      };
      planWeekRef.current = nextWeek;
      setPlanWeek(nextWeek);
      const projected = workoutPlanFromPlanWeek(nextWeek);
      setWorkoutPlan(projected);
      AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(projected)).catch(() => {});
      setSelectedWorkoutDayKey(today);
      return;
    }

    if (workoutPlan?.days?.length) {
      const idx = workoutPlan.days.indexOf(todayScheduleItem.workout as WorkoutDay);
      const nextPlan = {
        ...workoutPlan,
        days: idx >= 0
          ? workoutPlan.days.map((day, i) => i === idx ? adjustedWorkout : day)
          : [adjustedWorkout, ...workoutPlan.days.slice(1)],
      };
      setWorkoutPlan(nextPlan);
      setManualWorkoutOverrides(prev => ({ ...prev, [today]: adjustedWorkout }));
      await saveManualWorkoutOverride(today, adjustedWorkout);
      AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(nextPlan)).catch(() => {});
      setSelectedWorkoutDayKey(today);
    }
  }, [authToken, planWeek, workoutPlan]);

  const handlePeriodRecoveryDay = useCallback(async () => {
    const today = todayKey();
    const reason = 'Active recovery for period symptoms';
    const todayScheduleItem = scheduleRawRef.current.find(item => dateKey(item.date) === today)
      ?? resolveTodayScheduleItem(scheduleRawRef.current, workoutPlan, planWeek);

    setSkippedDates(prev => new Set([...prev, today]));
    setSkipReasonsByDate(prev => ({ ...prev, [today]: reason }));
    setDroppedSkipDates(prev => {
      const next = new Set(prev);
      next.delete(today);
      return next;
    });

    if (todayScheduleItem?.workout) {
      await savePreservedCompletedWorkout(today, todayScheduleItem.workout);
      setPreservedWorkouts(prev => ({ ...prev, [today]: todayScheduleItem.workout! }));
    }

    await persistDayState(today, { skipped_focus: 'recovery', skip_reason: reason });
    await saveSkipToHistory(today, todayScheduleItem?.workout?.focus ?? 'recovery', reason);

    import('../utils/workoutReminders')
      .then(({ cancelTodayWorkoutReminder }) => cancelTodayWorkoutReminder())
      .catch(() => undefined);

    if (authToken) {
      const { skipPlanDay, getActivePlanWeek } = await import('../services/api');
      await skipPlanDay(authToken, today, reason);
      const freshWeek = await getActivePlanWeek(authToken);
      if (freshWeek?.days?.length) {
        planWeekRef.current = freshWeek;
        setPlanWeek(freshWeek);
        const projected = workoutPlanFromPlanWeek(freshWeek);
        setWorkoutPlan(projected);
        AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(projected)).catch(() => {});
      }
    }
  }, [authToken, persistDayState, planWeek, workoutPlan]);

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

  const handleToggleSaveMeal = useCallback(async (_mealType: string, meal: MealSuggestion) => {
    const name = (meal.meal || '').trim();
    if (!name) return;
    const normalizedName = name.toLowerCase();
    const existing = savedMealLibrary.find(m => (m.name || '').toLowerCase().trim() === normalizedName);
    if (existing) {
      try {
        const { deleteSavedMeal } = await import('../services/api');
        await deleteSavedMeal(authToken, existing.id);
        reloadSavedMeals();
      } catch {}
    } else {
      if (!canCreateSavedMeal(userProfile, savedMealLibrary.length)) {
        Alert.alert(
          'Saved meal limit reached',
          `Free accounts can save up to ${FREE_SAVED_MEAL_LIMIT} meals. Upgrade to Pro for unlimited saved meals.`,
        );
        return;
      }
      const items = (meal.items || meal.foods?.map((f, i) => ({
        name: f, quantity: 1, unit: 'serving',
        calories: 0, protein: 0, carbs: 0, fat: 0,
      })) || []).map((it: any) => ({
        food_name: String(it.name || it.food_name || 'Item'),
        quantity: Number(it.quantity || 1),
        unit: String(it.unit || 'serving'),
        calories: Number(it.calories || 0),
        protein_g: Number(it.protein_g ?? it.protein ?? 0),
        carbs_g: Number(it.carbs_g ?? it.carbs ?? 0),
        fat_g: Number(it.fat_g ?? it.fat ?? 0),
      }));
      if (items.length === 0) return;
      try {
        const { createSavedMeal } = await import('../services/api');
        await createSavedMeal(authToken, { name, items: items as any });
        reloadSavedMeals();
      } catch {}
    }
  }, [authToken, savedMealLibrary, reloadSavedMeals, userProfile]);

  // When the add-from-saved picker fires on a day card we stash the
  // target date so the quick-log modal knows where to paste.
  const [addFromSavedFor, setAddFromSavedFor] = useState<string | null>(null);

  const mirrorLoggedSavedMealToDay = useCallback(async (
    date: string,
    saved: { id?: number; name: string; items?: any[]; total_calories?: number; total_protein_g?: number; total_carbs_g?: number; total_fat_g?: number },
    mealId: number,
    consumedAt?: string,
  ) => {
    const loggedMeal = savedMealToSuggestion(saved, consumedAt, mealId);
    const fallbackPlan = {
      meals: [],
      targets: { calories: 0, protein: 0, carbs: 0, fat: 0 },
    } as DailyNutritionPlan;
    const currentPlan = nutritionPlansByDateRef.current[date] ?? fallbackPlan;
    const existingIdx = (currentPlan.meals ?? []).findIndex(m => (m as any)._loggedMealId === mealId);
    const mutation = upsertMealInPlansByDate(
      { ...nutritionPlansByDateRef.current, [date]: currentPlan },
      date,
      existingIdx >= 0 ? `meal_${existingIdx}` : 'new_meal',
      loggedMeal,
    );
    if (!mutation.plan) return;
    const mealType = mutation.mealType;
    const nextPlan = mutation.plan;
    const checkMutation = setMealCheckedInChecksByDate(checkedMealsByDateRef.current, date, mealType, true);

    nutritionPlansByDateRef.current = mutation.plansByDate;
    checkedMealsByDateRef.current = checkMutation.checksByDate as Record<string, MealChecks>;
    setNutritionPlansByDate(mutation.plansByDate);
    setCheckedMealsByDate(checkMutation.checksByDate as Record<string, MealChecks>);
    await saveNutritionPlan(date, nextPlan);
    await saveMealChecks(date, checkMutation.dateChecks);
    await savePreservedMeal(date, mealType, loggedMeal).catch(() => {});
    await persistDayState(date, { nutrition_plan: nextPlan, meal_checks: checkMutation.dateChecks });
    setMealLogRefreshKey(k => k + 1);
  }, [persistDayState]);

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
  const openLibraryExercise = useCallback((item: ExerciseLibraryItem) => {
    setSelectedExercise(item);
  }, []);
  const playLibraryExerciseVideo = useCallback((item: ExerciseLibraryItem) => {
    openExerciseVideo(item.name, {
      equipment: (item as any).gear?.[0]?.name ?? (item as any).equipment ?? null,
      primary_muscle: (item as any).primary_muscle ?? null,
      movement_pattern: (item as any).movement_pattern ?? null,
    });
  }, [openExerciseVideo]);
  const renderExerciseLibraryItem = useCallback(({ item }: { item: ExerciseLibraryItem }) => (
    <ExerciseLibraryRow
      item={item}
      themeColors={themeColors}
      workoutPalette={workoutPalette}
      onOpen={openLibraryExercise}
      onPlayVideo={playLibraryExerciseVideo}
    />
  ), [openLibraryExercise, playLibraryExerciseVideo, themeColors, workoutPalette]);
  const exerciseLibraryKeyExtractor = useCallback((item: ExerciseLibraryItem) => String(item.id ?? item.name), []);

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
  // Full prep result from the background card — passed as initialPrep to the
  // modal card so it renders immediately without a blank → pop-in flash.
  const bgPrepDataRef = useRef<import('../services/preparedness').PreparednessResult | null>(null);
  const applyReadinessScore = useCallback((score: number, label: string) => {
    if (label === '—' || score <= 0) {
      canonicalPrepRef.current = null;
      setReadinessBadge(null);
      return;
    }
    canonicalPrepRef.current = { score, label, computedAt: Date.now() };
    setReadinessBadge({ score, label });
  }, []);

  // Prefer the persisted PlanWeek (dated, stable for 7 days). Fall back
  // to the legacy rolling-from-today schedule only for users who don't
  // have a PlanWeek row yet (network failure on first run, mid-migration).
  // Memoized — the schedule shape only changes when the underlying plan,
  // skipped/dropped/completed sets, or preserved overlay changes. Without
  // this we recompute (and create new array refs) on every parent render,
  // which cascades into DayCard re-renders even when nothing changed.
  // Pairs with the React.memo wrapper on DayCard so item-prop identity
  // is stable across re-renders.
  // MUST sit above the early return — hooks have to fire in the same
  // order every render.
  const scheduleRaw = useMemo(() => {
    if (!userProfile || !workoutPlan) return [] as ReturnType<typeof get7DaySchedule>;
    return planWeek?.days?.length
      ? getScheduleFromPlanWeek(planWeek)
      : workoutPlan?.days?.length
        ? get7DaySchedule(workoutPlan, userProfile.daysPerWeek, skippedDates, droppedSkipDates, completedDates, userProfile.trainingDays)
        : [];
  }, [planWeek, workoutPlan, userProfile?.daysPerWeek, userProfile?.trainingDays, skippedDates, droppedSkipDates, completedDates]);
  scheduleRawRef.current = scheduleRaw as ScheduleItem[];
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
  const schedule = useMemo(() => (
    scheduleRaw.map(item => {
      const k = dateKey(item.date);
      const preserved = preservedWorkouts[k];
      if (preserved) {
        return { ...item, workout: preserved, isRest: false };
      }
      const manualOverride = planWeek?.days?.length ? null : manualWorkoutOverrides[k];
      if (manualOverride) {
        return { ...item, workout: manualOverride, isRest: false };
      }
      return item;
    })
  ), [scheduleRaw, preservedWorkouts, manualWorkoutOverrides, planWeek]);

  rePushStateRef.current = {
    schedule: schedule as any[],
    themePreference: userProfile?.themePreference,
    todayDone,
    skippedDates,
    nutritionPlansByDate,
    checkedMealsByDate,
    hydration,
    hydrationByDate,
    readinessScore,
    nutritionScoreData,
    workoutPlan,
    planWeek,
    profileAge: userProfile?.physicalStats?.age ?? null,
  };

  const readinessAdjustmentRecommendation = useMemo(() => {
    const today = todayKey();
    if (todayDone || skippedDates.has(today)) return null;
    if (dismissedReadinessAdjustmentDate === today) return null;
    const todayItem = resolveTodayScheduleItem(schedule as ScheduleItem[], workoutPlan, planWeek);
    if (!todayItem?.workout || todayItem.isRest) return null;
    return recommendReadinessWorkoutAdjustment({
      workout: todayItem.workout,
      muscleFatigue: readinessScore?.muscleFatigue ?? null,
      focusReadiness: readinessScore?.focusReadiness ?? null,
    });
  }, [
    dismissedReadinessAdjustmentDate,
    planWeek,
    readinessScore?.focusReadiness,
    readinessScore?.muscleFatigue,
    schedule,
    skippedDates,
    todayDone,
    workoutPlan,
    currentDate,
  ]);

  const handleReadinessLightenWorkout = useCallback(async () => {
    const today = todayKey();
    const recommendation = readinessAdjustmentRecommendation;
    const todayScheduleItem = scheduleRawRef.current.find(item => dateKey(item.date) === today)
      ?? resolveTodayScheduleItem(scheduleRawRef.current, workoutPlan, planWeek);
    if (!recommendation || !todayScheduleItem?.workout) return;

    const adjustedWorkout = reduceWorkoutForReadiness({
      workout: todayScheduleItem.workout,
      recommendation,
    });

    if (authToken && planWeekRef.current?.days?.length) {
      const { patchPlanDayWorkout } = await import('../services/api');
      const savedDay = await patchPlanDayWorkout(authToken, today, adjustedWorkout);
      const baseWeek = planWeekRef.current;
      const nextWeek = {
        ...baseWeek,
        days: baseWeek.days.map(pd =>
          pd.day_date === today
            ? { ...pd, is_rest: savedDay.is_rest, workout: savedDay.workout, status: savedDay.status, locked: savedDay.locked }
            : pd,
        ),
      };
      planWeekRef.current = nextWeek;
      setPlanWeek(nextWeek);
      const projected = workoutPlanFromPlanWeek(nextWeek);
      setWorkoutPlan(projected);
      AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(projected)).catch(() => {});
      setSelectedWorkoutDayKey(today);
      setDismissedReadinessAdjustmentDate(today);
      setFatigueNotice('Lightened today’s workout based on current muscle readiness. You can still edit exercises manually.');
      return;
    }

    if (workoutPlan?.days?.length) {
      const idx = workoutPlan.days.indexOf(todayScheduleItem.workout as WorkoutDay);
      const nextPlan = {
        ...workoutPlan,
        days: idx >= 0
          ? workoutPlan.days.map((day, i) => i === idx ? adjustedWorkout : day)
          : [adjustedWorkout, ...workoutPlan.days.slice(1)],
      };
      setWorkoutPlan(nextPlan);
      setManualWorkoutOverrides(prev => ({ ...prev, [today]: adjustedWorkout }));
      await saveManualWorkoutOverride(today, adjustedWorkout);
      AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(nextPlan)).catch(() => {});
      setSelectedWorkoutDayKey(today);
      setDismissedReadinessAdjustmentDate(today);
      setFatigueNotice('Lightened today’s workout based on current muscle readiness. You can still edit exercises manually.');
    }
  }, [authToken, planWeek, readinessAdjustmentRecommendation, workoutPlan]);

  const handleReadinessRecoveryDay = useCallback(async () => {
    const today = todayKey();
    const reason = 'Recovery day for low readiness';
    const todayScheduleItem = scheduleRawRef.current.find(item => dateKey(item.date) === today)
      ?? resolveTodayScheduleItem(scheduleRawRef.current, workoutPlan, planWeek);

    setSkippedDates(prev => new Set([...prev, today]));
    setSkipReasonsByDate(prev => ({ ...prev, [today]: reason }));
    setDroppedSkipDates(prev => {
      const next = new Set(prev);
      next.delete(today);
      return next;
    });

    if (todayScheduleItem?.workout) {
      await savePreservedCompletedWorkout(today, todayScheduleItem.workout);
      setPreservedWorkouts(prev => ({ ...prev, [today]: todayScheduleItem.workout! }));
    }

    await persistDayState(today, { skipped_focus: 'recovery', skip_reason: reason });
    await saveSkipToHistory(today, todayScheduleItem?.workout?.focus ?? 'recovery', reason);

    import('../utils/workoutReminders')
      .then(({ cancelTodayWorkoutReminder }) => cancelTodayWorkoutReminder())
      .catch(() => undefined);

    if (authToken) {
      const { skipPlanDay, getActivePlanWeek } = await import('../services/api');
      await skipPlanDay(authToken, today, reason);
      const freshWeek = await getActivePlanWeek(authToken);
      if (freshWeek?.days?.length) {
        planWeekRef.current = freshWeek;
        setPlanWeek(freshWeek);
        const projected = workoutPlanFromPlanWeek(freshWeek);
        setWorkoutPlan(projected);
        AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(projected)).catch(() => {});
      }
    }
    setDismissedReadinessAdjustmentDate(today);
  }, [authToken, persistDayState, planWeek, workoutPlan]);

  const updateProfilePhoto = useCallback(async (mode: 'pick' | 'remove') => {
    if (!authToken || !userProfile) return;
    try {
      let avatarUrl: string | null = null;
      if (mode === 'pick') {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          Alert.alert('Photo access needed', 'Allow photo library access to choose a profile photo.');
          return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'] as any,
          allowsEditing: true,
          aspect: [1, 1],
          quality: 0.45,
          base64: true,
          maxWidth: 512,
          maxHeight: 512,
        } as any);
        if (result.canceled) return;
        const asset = result.assets?.[0];
        if (!asset?.base64) {
          Alert.alert('Could not read photo', 'Choose a different image and try again.');
          return;
        }
        const mime = (asset as any).mimeType || 'image/jpeg';
        avatarUrl = `data:${mime};base64,${asset.base64}`;
        if (avatarUrl.length > 400_000) {
          Alert.alert('Photo too large', 'Choose a smaller image or crop tighter and try again.');
          return;
        }
      }
      const { updateSocialMe } = await import('../services/api');
      const updated = await updateSocialMe(authToken, { avatar_url: avatarUrl });
      onProfileUpdate?.({ avatarUrl: updated.avatar_url ?? undefined } as any, true);
    } catch (e: any) {
      Alert.alert('Could not update photo', e?.message ?? 'Please try again.');
    }
  }, [authToken, onProfileUpdate, userProfile]);

  const openProfilePhotoActions = useCallback(() => {
    if (!userProfile?.avatarUrl) {
      updateProfilePhoto('pick');
      return;
    }
    Alert.alert('Profile photo', undefined, [
      { text: 'Change Photo', onPress: () => updateProfilePhoto('pick') },
      { text: 'Remove Photo', style: 'destructive', onPress: () => updateProfilePhoto('remove') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [updateProfilePhoto, userProfile?.avatarUrl]);

  if (!userProfile || !workoutPlan) return <View style={styles.container} />;

  const goalLabel = meta.goals.find(g => g.value === userProfile.goal)?.label
    ?? PRIMARY_GOALS.find(g => g.id === userProfile.goal)?.label
    ?? userProfile.goal;
  // Free tier — strip all generated exercises and replace each scheduled day
  // with an "Empty" shell the user can start + populate manually. Past
  // preserved/completed workouts are left untouched so the user's history
  // remains intact. When they upgrade to pro, the parent triggers a regen
  // that repopulates these days.
  const isFreeTier = tierOf(userProfile) === 'free';

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
            // Free users don't get a generated split — every forward day
            // reads as "Custom" and they fill it via Live Tracker / Log
            // Activity / one of their saved templates.
            focus: 'Custom',
            exercises: [],
            stimulus: null,
          } as any,
        };
      })
    : schedule;
  // Render-side meal day list — derives from the active PlanWeek so it
  // matches the workout strip dimension-for-dimension.
  const mealDays: MealDay[] = _activeWeekMealDays();

  const isLightTheme = isLightThemeName(userProfile.themePreference);
  const statusBarStyle = isLightTheme ? 'dark' : 'light';
  const navMutedColor = isLightTheme ? themeColors.textMuted : themeColors.textSecondary;

  const headerGradientColors: [string, string] = isLightTheme
    ? [themeColors.surface, themeColors.surface]
    : [themeColors.primary + '18', themeColors.surfaceRaised];
  const chromeColors = getChromeColors(userProfile.themePreference);
  const bottomBarGradientColors: [string, string] = isLightTheme
    ? [chromeColors.surface + 'F4', chromeColors.muted + 'E8']
    : [chromeColors.surface + 'F4', chromeColors.muted + 'E8'];

  return (
    <View style={[styles.container, { backgroundColor: themeColors.background }]}>
      <StatusBar style={statusBarStyle} />

      {/* Header — very subtle top-to-bottom primary wash */}
      <LinearGradient
        colors={headerGradientColors}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={[styles.header, { paddingTop: insets.top + 10, borderBottomColor: 'transparent' }]}>
        <Image
          source={bgIsDark(themeColors.background) ? LOGO_DARK : LOGO_LIGHT_HEADER}
          style={{ height: 50, width: 160 }}
          resizeMode="contain"
        />
        <TouchableOpacity
          testID="open-ai-coach"
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
        <LinearGradient
          colors={[headerGradientColors[1], themeColors.background]}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={[styles.fixedSubTabBar, { top: insets.top + 68, borderBottomColor: 'transparent' }]}>
          <View style={[styles.segmentedWrap, { backgroundColor: themeColors.surface, borderColor: isLightTheme ? themeColors.border + '88' : themeColors.border, borderWidth: isLightTheme ? StyleSheet.hairlineWidth : 1 }]}>
            <SubTabBtn testID="workout-subtab-plan" label="Plan"     active={workoutSubTab === 'plan'}      tint={workoutPalette.strong} mutedColor={themeColors.textSecondary} onPress={() => { setWorkoutSubTab('plan'); setShowExerciseLibrary(false); setSelectedExercise(null); }} />
            <SubTabBtn testID="workout-subtab-library" label="Library"  active={workoutSubTab === 'library'}   tint={workoutPalette.strong} mutedColor={themeColors.textSecondary} onPress={() => { setWorkoutSubTab('library'); setSelectedExercise(null); setShowExerciseLibrary(true); ensureExerciseLibrary().catch(() => {}); }} />
            <SubTabBtn testID="workout-subtab-settings" label="Settings" active={workoutSubTab === 'equipment'} tint={workoutPalette.strong} mutedColor={themeColors.textSecondary} onPress={() => { setWorkoutSubTab('equipment'); setShowExerciseLibrary(false); setSelectedExercise(null); }} />
            <SubTabBtn testID="workout-subtab-history" label="History"  active={workoutSubTab === 'history'}   tint={workoutPalette.strong} mutedColor={themeColors.textSecondary} onPress={() => { setWorkoutSubTab('history'); setShowExerciseLibrary(false); setSelectedExercise(null); requestAnimationFrame(() => { loadWorkoutHistory().then(setWorkoutHistoryList).catch(() => {}); }); }} />
          </View>
        </LinearGradient>
      )}

      {/* Fixed meals sub-tab bar — same pattern. */}
      {activeTab === 'meals' && !(isNutritionUpdating && !isWorkoutUpdating) && (
        <LinearGradient
          colors={[headerGradientColors[1], themeColors.background]}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={[styles.fixedSubTabBar, { top: insets.top + 68, borderBottomColor: 'transparent' }]}>
          <View style={[styles.segmentedWrap, { backgroundColor: themeColors.surface, borderColor: isLightTheme ? themeColors.border + '88' : themeColors.border, borderWidth: isLightTheme ? StyleSheet.hairlineWidth : 1 }]}>
            <SubTabBtn testID="meals-subtab-plan" label="Plan"    active={mealsSubTab === 'plan'}        tint={mealPalette.strong} mutedColor={themeColors.textSecondary} onPress={() => setMealsSubTab('plan')} />
            <SubTabBtn testID="meals-subtab-foods" label="Foods"   active={mealsSubTab === 'foods'}       tint={mealPalette.strong} mutedColor={themeColors.textSecondary} onPress={() => setMealsSubTab('foods')} />
            <SubTabBtn testID="meals-subtab-supplements" label="Supps" active={mealsSubTab === 'supplements'} tint={mealPalette.strong} mutedColor={themeColors.textSecondary} onPress={() => setMealsSubTab('supplements')} />
            <SubTabBtn testID="meals-subtab-history" label="History" active={mealsSubTab === 'history'}     tint={mealPalette.strong} mutedColor={themeColors.textSecondary} onPress={() => setMealsSubTab('history')} />
          </View>
        </LinearGradient>
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
            {renderedWorkoutSubTab === 'equipment' && (
              <View style={{ flex: 1, marginHorizontal: -16, marginBottom: 96, backgroundColor: themeColors.background }}>
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
            {renderedWorkoutSubTab === 'history' && (() => {
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
              // Use completedDates (history + summaries) so archived older
              // workouts still count toward the streak. allDoneSet was
              // history-only, which caused long streaks to truncate once
              // sessions aged out of the rolling history window.
              let streak = 0;
              const checkDate = new Date();
              const todayStr = toDateKey(checkDate.toISOString());
              if (!completedDates.has(todayStr)) checkDate.setDate(checkDate.getDate() - 1);
              for (let j = 0; j < 90; j++) {
                const ck = toDateKey(checkDate.toISOString());
                if (completedDates.has(ck)) { streak++; checkDate.setDate(checkDate.getDate() - 1); }
                else break;
              }

              return (
                <View testID="workout-history-screen" style={{ gap: 10, marginBottom: 80 }}>
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
                    <View style={[styles.emptyStateCard, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
                      <Ionicons name="barbell-outline" size={36} color={workoutPalette.strong} />
                      <Text {...dynamicTextProps} style={[styles.emptyStateTitle, { color: themeColors.textPrimary }]}>No workouts yet</Text>
                      <Text {...dynamicTextProps} style={[styles.emptyStateBody, { color: themeColors.textSecondary }]}>
                        Start from Workouts → Plan or log a custom session. Finished sessions, skips, and streaks will collect here automatically.
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
                        const exerciseCount = (session.exercises ?? []).length;
                        const totalSets = (session.exercises ?? []).reduce((n, ex) => n + (ex.sets?.length ?? 0), 0);
                        const isExpanded = expandedWorkoutHistoryId === (session.id ?? `s${i}`);
                        const summary = summaries.find(s => s.date && session.date && s.date.slice(0, 10) === session.date.slice(0, 10) && s.focus === session.focus);
                        const dateObj = new Date(session.date);
                        const dateLabel = dateObj.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
                        const duration = session.durationSeconds ? `${Math.round(session.durationSeconds / 60)}m` : '–';
                        const focusLabel = session.manualActivity
                          ? `${humanizeToken(session.manualActivity.category)}${session.manualActivity.subtype ? ' · ' + humanizeToken(session.manualActivity.subtype) : ''}${session.manualActivity.intensity ? ` (${session.manualActivity.intensity})` : ''}`
                          : session.focus;
                        const historyRowLabel = `workout-history-row-${i} ${focusLabel} ${dateLabel} ${exerciseCount} exercises ${totalSets} sets`;
                        return (
                          <TouchableOpacity
                            testID={`workout-history-row-${i}`}
                            accessibilityLabel={historyRowLabel}
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
                                      const exactSourceId = sid && !sid.startsWith('server') ? sid : undefined;
                                      import('../services/api').then(api => api.deleteWorkoutCompletion(authToken, dateStr, {
                                        focusLabel: session.focus,
                                        externalSourceId: exactSourceId,
                                      })).catch(() => {});
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
                              <Text style={{ fontSize: 11, color: themeColors.textSecondary }}>{exerciseCount} exercises</Text>
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
            {renderedWorkoutSubTab === 'plan' && authToken && (
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

            {/* Birthday banner — fires once on the user's MM-DD, dismissable.
                Self-gates on the birthdate so it's a no-op on every other day. */}
            {renderedWorkoutSubTab === 'plan' && (
              <BirthdayBanner
                birthdate={userProfile.physicalStats?.birthdate}
                displayName={userProfile.firstName || username || undefined}
                themeName={userProfile.themePreference}
              />
            )}

            {/* Streak + daily motto */}
            {renderedWorkoutSubTab === 'plan' && authToken && (
              <StreakConsistencyWidget authToken={authToken} themeName={userProfile.themePreference} displayName={userProfile.firstName || username || undefined} />
            )}

            {/* End-of-week coach review. Surfaces after the final day-7 workout
                or during the day-8 review window; renewal stays separate. */}
            {renderedWorkoutSubTab === 'plan' && !isFreeTier && authToken && (
              <WeeklyCheckinCard
                key={`weekly-checkin-${planWeek?.id ?? 'none'}-${planWeek?.end_date ?? 'none'}-${planRefreshKey}`}
                authToken={authToken}
                themeName={userProfile.themePreference}
                dismissibleRecap
                onCheckinCompleted={() => {
                  loadDayStatus();
                  if (userProfile) loadPlans(userProfile);
                }}
              />
            )}

            {/* Health-linked cycle guidance with period-phase advice and
                user-triggered today-only workout adjustments. */}
            <CycleGuidanceSection
              visible={renderedWorkoutSubTab === 'plan' && !isFreeTier && !!authToken}
              themeName={userProfile.themePreference}
              todaysWorkout={(schedule?.find(s => dateKey(s.date) === todayKey()) ?? schedule?.[0] ?? null)?.workout ?? null}
              todayDone={todayDone}
              todaySkipped={skippedDates.has(todayKey())}
              onUseLighterWorkout={handlePeriodLighterWorkout}
              onUseRecoveryDay={handlePeriodRecoveryDay}
              onAddHydration={() => handleHydrationDelta(16, todayKey())}
            />

            {renderedWorkoutSubTab === 'plan' && !isFreeTier && readinessAdjustmentRecommendation && (
              <ReadinessAdjustmentBanner
                recommendation={readinessAdjustmentRecommendation}
                themeName={userProfile.themePreference}
                onLighten={handleReadinessLightenWorkout}
                onRecovery={handleReadinessRecoveryDay}
                onDismiss={() => setDismissedReadinessAdjustmentDate(todayKey())}
              />
            )}

            {/* Active injuries banner */}
            {renderedWorkoutSubTab === 'plan' && (() => {
              const active = activeProfileInjuries;
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
                  {dueInjuryCheckins.length > 0 && (
                    <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: themeColors.border }}>
                      <Text style={{ fontSize: 11, fontWeight: '800', color: themeColors.textPrimary }}>
                        Injury check-in due
                      </Text>
                      <Text style={{ fontSize: 10, color: themeColors.textSecondary, lineHeight: 14, marginTop: 2 }}>
                        Confirm whether {dueInjuryCheckins.length === 1 ? 'this limitation still needs' : 'these limitations still need'} injury-aware planning.
                      </Text>
                      <TouchableOpacity
                        onPress={() => setShowInjuryCheckin(true)}
                        style={{ alignSelf: 'flex-start', marginTop: 8, paddingVertical: 7, paddingHorizontal: 12, borderRadius: 8, backgroundColor: '#F59E0B' }}
                        activeOpacity={0.8}>
                        <Text style={{ fontSize: 11, fontWeight: '800', color: '#111827' }}>Review Injury</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              );
            })()}

            {renderedWorkoutSubTab === 'plan' && showEmailBanner && (
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
                  <Text style={{ fontSize: 12, fontWeight: '700', color: getContrastingTextColor(themeColors.warning) }}>Update Email</Text>
                </TouchableOpacity>
              </View>
            )}


            {/* Readiness lives on today's plan card and opens a detail modal. */}

            {/* Resume workout banner — shown when the user force-quit
                mid-workout. Jumps straight back into ActiveWorkoutScreen
                with all logged sets intact. */}
            {renderedWorkoutSubTab === 'plan' && resumeInfo && workoutPlan?.days?.[0] && (
              <TouchableOpacity
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 10,
                  padding: 14, borderRadius: 12, marginBottom: 10,
                  backgroundColor: workoutPalette.strong + '18',
                  borderWidth: 1.5, borderColor: workoutPalette.strong + 'AA',
                }}
                onPress={() => {
                  resumeInProgressWorkout();
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
                          onPress: clearInProgressWorkout,
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
            {renderedWorkoutSubTab === 'plan' && fatigueNotice && (
              <FatigueNoticeBanner
                message={fatigueNotice}
                onDismiss={() => setFatigueNotice(null)}
              />
            )}


            {renderedWorkoutSubTab === 'plan' && !isFreeTier && scheduleForRender.length === 0 && (
              <View style={[styles.emptyStateCard, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
                <Ionicons name="calendar-clear-outline" size={34} color={workoutPalette.strong} />
                <Text {...dynamicTextProps} style={[styles.emptyStateTitle, { color: themeColors.textPrimary }]}>No active workout plan</Text>
                <Text {...dynamicTextProps} style={[styles.emptyStateBody, { color: themeColors.textSecondary }]}>
                  Your generated plan is not available yet. Generate a plan from settings when you are ready.
                </Text>
              </View>
            )}

            {renderedWorkoutSubTab === 'plan' && (() => {
              const splitRaw = (userProfile.preferredSplit || '').toLowerCase();
              const collapseUpper = ['upper_lower', 'upper lower', 'full_body', 'full body'].some(kw => splitRaw.includes(kw))
                || (!splitRaw && (workoutPlan?.days ?? []).some(d => {
                  const f = (d?.focus || '').toLowerCase();
                  return f.includes('upper') || f.includes('lower');
                }));
              // Focus-family normalizer. For U/L and full-body splits we
              // collapse push/pull/arms/shoulders into a single "upper"
              // bucket so the adjacency filter doesn't show every card
              // wrapped in an unusable option set. For PPL we keep
              // push/pull distinct since those are the split's whole point.
              const LOWER_KEYWORDS = ['legs', 'leg', 'quad', 'glute', 'hamstring', 'lower', 'squat', 'hinge', 'calves'];
              const PUSH_KEYWORDS = ['push', 'chest', 'tricep', 'press'];
              const PULL_KEYWORDS = ['pull', 'back', 'bicep', 'lat'];
              const UPPER_BROAD_KEYWORDS = ['upper', 'push', 'chest', 'tricep', 'press', 'pull', 'back', 'bicep', 'lat', 'shoulder', 'arm'];
              const UPPER_NARROW_KEYWORDS = ['upper', 'shoulder', 'arm'];
              const FULL_KEYWORDS = ['full body', 'full_body', 'total'];
              const CARDIO_KEYWORDS = ['cardio', 'zone 2', 'zone2', 'interval', 'run', 'bike', 'cycle', 'cycling', 'spin', 'swim', 'row', 'walk', 'hike', 'steady'];
              const EASY_KEYWORDS = ['recover', 'rest', 'mobil', 'stretch', 'yoga', 'flow'];
              const has = (s: string, kws: string[]) => kws.some(kw => s.includes(kw));
              const normFamily = (f?: string): string => {
                const s = (f ?? '').toLowerCase();
                if (has(s, LOWER_KEYWORDS)) return 'lower';
                if (collapseUpper) {
                  if (has(s, UPPER_BROAD_KEYWORDS)) return 'upper';
                } else {
                  if (has(s, PUSH_KEYWORDS)) return 'push';
                  if (has(s, PULL_KEYWORDS)) return 'pull';
                  if (has(s, UPPER_NARROW_KEYWORDS)) return 'upper';
                }
                if (has(s, FULL_KEYWORDS)) return 'full';
                if (has(s, CARDIO_KEYWORDS)) return 'cardio';
                if (has(s, EASY_KEYWORDS)) return 'easy';
                return s || 'unknown';
              };

              const planDays = workoutPlan?.days ?? [];
              const planHasLiftSignal = planDays.some(d => {
                const f = (d?.focus || '').toLowerCase();
                return has(f, [
                  ...SPLIT_FOCUS_KEYWORDS.bro,
                  ...SPLIT_FOCUS_KEYWORDS.upper_lower,
                  ...SPLIT_FOCUS_KEYWORDS.full_body,
                  ...SPLIT_FOCUS_KEYWORDS.ppl,
                  'legs',
                  'lower',
                ]);
              });
              const cardioLikeDays = planDays.filter(d => {
                const f = (d?.focus || '').toLowerCase();
                const stimulus = String((d as any)?.stimulus || '').toLowerCase();
                const category = String((d as any)?.category || '').toLowerCase();
                return category === 'cond'
                  || stimulus === 'conditioning'
                  || has(f, CARDIO_KEYWORDS);
              }).length;
              const isCardioDominantPlan = isCardioDominantGoal(userProfile.goal)
                || (planDays.length > 0 && cardioLikeDays >= Math.ceil(planDays.length / 2) && !planHasLiftSignal);

              const inferSplitFromPlan = (): string => {
                if (isCardioDominantPlan) return 'cardio';
                const focuses = (workoutPlan?.days ?? []).map(d => (d?.focus || '').toLowerCase()).filter(Boolean);
                const hasKeyword = (keywords: string[]) => focuses.some(f => keywords.some(kw => f.includes(kw)));
                if (hasKeyword(SPLIT_FOCUS_KEYWORDS.bro)) return 'bro';
                const hasUpper = hasKeyword(['upper']);
                const hasLower = hasKeyword(['lower']);
                if (hasUpper && hasLower && hasKeyword(SPLIT_FOCUS_KEYWORDS.ppl)) return 'ppl_upper_lower';
                if (hasUpper && hasLower) return 'upper_lower';
                if (hasKeyword(SPLIT_FOCUS_KEYWORDS.full_body)) return 'full_body';
                return planHasLiftSignal ? 'ppl' : 'cardio';
              };
              const knownSplits = new Set(['ppl', 'upper_lower', 'full_body', 'ppl_upper_lower', 'bro', 'cardio']);
              const rawSplit = userProfile.preferredSplit ?? '';
              const split = isCardioDominantPlan ? 'cardio' : (knownSplits.has(rawSplit) ? rawSplit : inferSplitFromPlan());
              const splitFocusOptions: Record<string, string[]> = {
                ppl: ['Push', 'Pull', 'Legs'],
                upper_lower: ['Upper', 'Lower'],
                full_body: ['Full Body'],
                ppl_upper_lower: ['Push', 'Pull', 'Legs', 'Upper', 'Lower'],
                bro: ['Chest', 'Back', 'Shoulders', 'Arms', 'Legs'],
                cardio: ['Cardio'],
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
                cardio: [],
              };
              const focusOptions = splitFocusOptions[split] ?? splitFocusOptions.ppl;
              const plusCardioOptions = splitPlusCardioOptions[split] ?? splitPlusCardioOptions.ppl;
              const extraOptions = split === 'cardio'
                ? ['Mobility', 'Recovery']
                : ['Cardio', 'Mobility', 'Recovery'];
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
                const it = schedule[j];
                const dk = it?.date ? dateKey(it.date) : '';
                // Today is always pinned for adjacency, regardless of
                // its position in the schedule (with PlanWeek dates,
                // today may not be index 0).
                if (dk === todayKey()) return true;
                return completedDates.has(dk) || skippedDates.has(dk);
              };

              const _weekSchedule = scheduleForRender
                .map((s, origIdx) => ({ s, origIdx }))
                .sort((a, b) => a.s.date.getTime() - b.s.date.getTime());
              const _todayWeekEntry = _weekSchedule.find(entry => dateKey(entry.s.date) === todayKey());
              const _selectedWorkoutKey = _weekSchedule.some(entry => dateKey(entry.s.date) === selectedWorkoutDayKey)
                ? selectedWorkoutDayKey
                : (_todayWeekEntry ? dateKey(_todayWeekEntry.s.date) : (_weekSchedule[0] ? dateKey(_weekSchedule[0].s.date) : todayKey()));
              const _selectedEntry = _weekSchedule.find(entry => dateKey(entry.s.date) === _selectedWorkoutKey);
              if (!_selectedEntry) return null;
              const item = _selectedEntry.s;
              const i = _selectedEntry.origIdx;
              const renderIdx = 0;
              const key = dateKey(item.date);
              // Date-based today check — the schedule now includes
              // yesterday/past days (when they're inside the active
              // PlanWeek), so position-0 is no longer guaranteed to
              // be today. This drives the "today selected" highlight.
              const isToday     = key === todayKey();
              // Completion is per-date, not per-position. Yesterday's
              // finished session shows as completed when it falls in
              // the active week.
              const isCompleted = completedDates.has(key) || (isToday && todayDone);
              const isPastUnlogged = item.date < new Date(new Date().setHours(0, 0, 0, 0)) && !item.isRest && !isCompleted;
              const isSkipped   = skippedDates.has(key) || isPastUnlogged;
              const isWorkoutCardExpanded = expandedDay === i;

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
              // Check if a schedule slot is an "easy" day (mobility/recovery/cardio)
              // via the structured stimulus field first, falling back to focus keywords
              // for past days (from history) where stimulus isn't available.
              const scheduleStimAt = (j: number): string | undefined => {
                if (j < 0 || j >= schedule.length) return undefined;
                return schedule[j]?.workout?.stimulus;
              };
              const isEasyDay = (j: number, focusStr?: string): boolean => {
                const stim = scheduleStimAt(j);
                if (stim) return EASY_STIMULUS.has(stim);
                // Fallback for past days (negative index) where only focus string is available
                const x = (focusStr || '').toLowerCase();
                return has(x, [...EASY_KEYWORDS, ...CARDIO_KEYWORDS, 'easy']);
              };
              const between = scheduleFocusAt(i - 1);
              if (isFixedNeighbor(i - 2) && (between == null || isEasyDay(i - 1, between))) {
                conflictFamilies.add(normFamily(scheduleFocusAt(i - 2)));
              }
              const betweenAfter = scheduleFocusAt(i + 1);
              if (isFixedNeighbor(i + 2) && (betweenAfter == null || isEasyDay(i + 1, betweenAfter))) {
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
                const isPlusCardio = lower.includes('+ cardio') || lower.includes('+cardio');
                const muscleKey = resolveFocusMuscleKey(focus);
                const muscles = muscleKey ? FOCUS_MUSCLE_MAP[muscleKey] : null;
                if (!muscles) return null; // no fatigue concept (mobility/recovery)
                let fatigue = avg(muscles);
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
                const optLower = opt.toLowerCase();
                const easyTie = (optLower.includes('recover') || optLower.includes('mobil')) ? 5 : 0;
                return conflictPenalty + readinessPenalty + recentPenalty + easyTie;
              };
              const sortedOptions = [...allOptions].sort((a, b) => optionRank(a) - optionRank(b));
              const workoutWeekItems: WeekStripItem[] = _weekSchedule.map(({ s }) => {
                const dayKey = dateKey(s.date);
                const done = completedDates.has(dayKey) || (dayKey === todayKey() && todayDone);
                const isPast = s.date < new Date(new Date().setHours(0, 0, 0, 0));
                const skipped = skippedDates.has(dayKey) || (isPast && !s.isRest && !done);
                const skipReason = skipReasonsByDate[dayKey];
                return {
                  key: dayKey,
                  date: s.date,
                  title: skipped
                    ? skippedDayTitle(s.workout?.focus, skipReason)
                    : s.isRest ? 'Rest day' : (s.workout?.focus ?? 'Workout'),
                  state: done ? 'done' : skipped ? 'skipped' : s.isRest ? 'rest' : dayKey === todayKey() ? 'today' : 'planned',
                };
              });

              return (
                <React.Fragment>
                  <WeekStrip
                    items={workoutWeekItems}
                    selectedKey={_selectedWorkoutKey}
                    accent={workoutPalette.strong}
                    colors={themeColors}
                    label="Workout week"
                    onSelect={(dayKey) => {
                      import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
                      setSelectedWorkoutDayKey(dayKey);
                      setSwitchDayIdx(-1);
                      // Day-strip selection no longer auto-expands the
                      // card — keep cards collapsed by default so the
                      // user can scan the week without each tap blowing
                      // the card open. Tapping the card itself still
                      // expands as before (see DayCard onPress handler).
                      setExpandedDay(-2);
                    }}
                  />
                <FadeInView key={key} delay={renderIdx * 80}>
                <DayCard
                  item={item}
                  themeName={userProfile.themePreference}
                  isToday={isToday}
                  isCompleted={isCompleted}
                  isSkipped={isSkipped}
                  skipReason={skipReasonsByDate[key] ?? (isPastUnlogged ? 'No workout logged' : undefined)}
                  // Per-date summary lookup. Past completed days in the
                  // PlanWeek (e.g. Mon when today is Wed) need their own
                  // stored summary, not today's. Falls back to the live
                  // `todaySummary` for today since it's freshest right
                  // after a workout finishes (before the summary file
                  // has been re-read).
                  completedSummary={
                    isCompleted
                      ? (workoutHistorySummaries.find((s: any) => typeof s?.date === 'string' && s.date.startsWith(key)) ?? (isToday ? todaySummary : null))
                      : null
                  }
                  expanded={isWorkoutCardExpanded}
                  onPress={() => {
                    import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
                    const collapsing = isWorkoutCardExpanded;
                    configureExpandAnimation(360);
                    setExpandedDay(collapsing ? -2 : i);
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
                  // Free tier: hide every generation surface (Switch Day,
                  // Change Focus, the readiness-vs-focus tile grid). The
                  // free flow is template-driven only — no algorithmic
                  // day rebuilds. Passing undefined here makes DayCard
                  // skip the entire switcher block (gated on
                  // `onChangeFocus && splitOptions`).
                  splitOptions={isFreeTier ? undefined : sortedOptions}
                  optionWarnings={isFreeTier ? undefined : optionWarnings}
                  showSwitchOptions={!isFreeTier && switchDayIdx === i}
                  onToggleSwitch={isFreeTier ? undefined : () => {
                    import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
                    configureExpandAnimation(280);
                    setSwitchDayIdx(switchDayIdx === i ? -1 : i);
                  }}
                  hasPlateauedExercises={plateauedExercises.size > 0 && (item.workout?.exercises ?? []).some((ex: any) => plateauedExercises.has(ex.name.toLowerCase()))}
                  isRegenerating={(() => {
                    const idx = workoutPlan ? workoutPlan.days.indexOf(item.workout as any) : -1;
                    return idx >= 0 && regeneratingDayIdxs.has(idx);
                  })()}
                  sessionMinutes={planWeek?.session_minutes ?? userProfile.workoutDurationMinutes ?? 60}
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
                    setSwapExerciseState({ workout, exerciseIndex: exIdx, exerciseName: exName, dayKey: key });
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
                    } else {
                      // No match — still route the user to Library so
                      // they can search manually rather than silently
                      // doing nothing.
                      setWorkoutSubTab('library');
                      setShowExerciseLibrary(true);
                      setExerciseSearch(exName);
                    }
                  }}
                  // Pro users get the full change-focus flow (regen via
                  // backend). Free users get a stripped-down handler that
                  // only honors 'Custom' / 'Empty' — used by the rest-day
                  // "Switch to workout" CTA. Anything else is a no-op so
                  // free users can't accidentally trigger generation.
                  onChangeFocus={isFreeTier ? ((newFocus) => {
                    if (!workoutPlan) return;
                    if (newFocus !== 'Custom' && newFocus !== 'Empty') return;
                    // Find the recipe slot for this calendar day so the
                    // edit lands on the right entry. Rest days have no
                    // workout object, so those become dated local
                    // overrides instead of recipe edits.
                    const recipeIdx = item.workout
                      ? workoutPlan.days.indexOf(item.workout as any)
                      : -1;
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                    import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
                    const newDay = {
                      ...(item.workout ?? { day: DAY_NAMES[item.date.getDay()] }),
                      focus: newFocus,
                      exercises: [],
                      stimulus: null,
                    } as WorkoutDay;
                    const updatedDays = [...workoutPlan.days];
                    if (recipeIdx >= 0) {
                      updatedDays[recipeIdx] = newDay;
                      const updatedPlan = { ...workoutPlan, days: updatedDays };
                      setWorkoutPlan(updatedPlan);
                      AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(updatedPlan)).catch(() => {});
                    } else {
                      const dayKey = dateKey(item.date);
                      setManualWorkoutOverrides(prev => ({ ...prev, [dayKey]: newDay }));
                      saveManualWorkoutOverride(dayKey, newDay).catch(() => {});
                      setSelectedWorkoutDayKey(dayKey);
                    }
                  }) : async (newFocus) => {
                    setSwitchDayIdx(-1);
                    if (!workoutPlan) return;
                    // Map the tapped schedule item back to the matching
                    // entry in workoutPlan.days. With PlanWeek hydration this
                    // is the dated calendar index; legacy fallback plans keep
                    // their recipe index. For rest days `item.workout` is
                    // null — handled below by appending a new shell instead
                    // of overwriting an existing day.
                    const recipeIdx = item.workout
                      ? workoutPlan.days.indexOf(item.workout as any)
                      : -1;
                    const dayIdx = recipeIdx >= 0 ? recipeIdx : i;

                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                    import('../utils/feedback').then(f => f.hapticMedium()).catch(() => {});

                    // 'Custom' / 'Empty' are blank-slate focuses — don't
                    // hit the generator. The day becomes "fill it yourself"
                    // and the user can use Live Tracker / templates /
                    // change-focus picker from there.
                    if (newFocus === 'Custom' || newFocus === 'Empty') {
                      const newDay = {
                        ...(item.workout ?? { day: DAY_NAMES[item.date.getDay()] }),
                        focus: newFocus,
                        exercises: [],
                        stimulus: null,
                      } as any;
                      // Update legacy workoutPlan cache for non-PlanWeek
                      // paths and offline fallback.
                      const updatedDays = [...workoutPlan.days];
                      if (item.workout && recipeIdx >= 0) {
                        updatedDays[recipeIdx] = newDay;
                      } else {
                        // Rest-day conversion: append the new shell to
                        // the legacy days list. The PlanWeek path is
                        // what actually drives rendering for Pro users
                        // (see patchPlanDayWorkout below); the legacy
                        // cache is just a safety net.
                        updatedDays.push(newDay);
                      }
                      const updatedPlan = { ...workoutPlan, days: updatedDays };
                      setWorkoutPlan(updatedPlan);
                      AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(updatedPlan)).catch(() => {});

                      // CRITICAL: persist to PlanWeek server-side so the
                      // change survives a reload. The previous version
                      // only mutated the legacy AsyncStorage cache; on
                      // next loadPlans the PlanDay would still report
                      // is_rest=true and the user's switch was lost.
                      // patchPlanDayWorkout sets is_rest=false, writes
                      // workout_json, and locks the day as manual_edit
                      // so future regens don't blow it away.
                      if (authToken && planWeek?.days?.length) {
                        try {
                          const dateISO = dateKey(item.date);
                          const { patchPlanDayWorkout } = await import('../services/api');
                          const updatedPlanDay = await patchPlanDayWorkout(authToken, dateISO, newDay);
                          // Mirror the server response into local planWeek
                          // state so the UI reflects is_rest=false + the
                          // new workout_json without waiting for the next
                          // loadPlans cycle.
                          setPlanWeek(prev => {
                            if (!prev) return prev;
                            return {
                              ...prev,
                              days: prev.days.map(pd =>
                                pd.day_date === dateISO
                                  ? { ...pd, is_rest: updatedPlanDay.is_rest, workout: updatedPlanDay.workout, status: updatedPlanDay.status, locked: updatedPlanDay.locked }
                                  : pd,
                              ),
                            };
                          });
                        } catch (e) {
                          console.warn('[switchDay] patchPlanDayWorkout failed (legacy cache still updated):', e);
                        }
                      }
                      return;
                    }

                    if (newFocus !== 'Empty') {
                      const { requirePro } = await import('../utils/subscription');
                      if (!requirePro(userProfile, 'ai_day_regenerate')) return;
                    }

                    // Show overlay
                    setRegeneratingDayIdxs(new Set(Array.from({ length: workoutPlan.days.length }, (_, k) => k)));
                    setRegenSelectedFocus(newFocus);

                    try {
                      if (!authToken) throw new Error('no auth');
                      const injuries = (userProfile.injuryEntries ?? [])
                        .filter(i => i.status !== 'resolved')
                        .map(i => `${i.bodyPart || i.description} (status: ${i.status})`);

                      // Build statuses in the same order as workoutPlan.days.
                      // With PlanWeek hydration this is calendar order, and
                      // the backend patches PlanDay.day_index accordingly.
                      const dayStatuses: string[] = workoutPlan.days.map((_, rIdx) => {
                        const si = scheduleRaw.find(s => s.workout && workoutPlan.days.indexOf(s.workout as any) === rIdx);
                        if (!si) return 'pending';
                        const dk = dateKey(si.date);
                        if (completedDates.has(dk)) return 'completed';
                        if (skippedDates.has(dk)) return 'skipped';
                        return 'pending';
                      });

                      const { generateWorkoutWeek } = await import('../services/api');
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
                        change_mode: 'smart',
                        day_statuses: dayStatuses,
                      });

                      // 2. Read back from DB — PlanWeek is the schedule source of truth
                      const { getActivePlanWeek } = await import('../services/api');
                      const freshWeek = await getActivePlanWeek(authToken);
                      if (freshWeek) {
                        planWeekRef.current = freshWeek;
                        setPlanWeek(freshWeek);
                        console.log('[switchDay] done — focuses:', freshWeek.days.map((d: any) => d.workout?.focus));
                      }
                      loadDayStatus();
                    } catch (e) {
                      console.log('[switchDay] failed:', e);
                    } finally {
                      setRegeneratingDayIdxs(new Set());
                      setRegenSelectedFocus(null);
                    }
                  }}
                  readinessBadge={isToday ? (readinessBadge ?? undefined) : undefined}
                  onReadinessTap={isToday ? () => setShowReadiness(true) : undefined}
                />
                </FadeInView>
                {isToday ? (
                  <View style={styles.todayPlanCardsWrap}>
                    {!isFreeTier && authToken && (() => {
                      // Always mount so the readiness data pipeline runs
                      // (badge inside the workout card + watch push). But
                      // pre-workout, the badge already conveys the signal —
                      // a second card with the same number below felt like
                      // duplicate noise. Hide visually until the user has
                      // trained today; then it reframes as "how is recovery
                      // going?" via the workoutDone prop.
                      const todayPlan = nutritionPlansByDate[todayKey()] ?? null;
                      const todaysFocus = item.workout?.focus ?? workoutPlan?.days?.[0]?.focus ?? null;
                      return (
                        <TrainingReadinessCard
                          authToken={authToken}
                          themeName={userProfile.themePreference}
                          age={userProfile.physicalStats?.age ?? null}
                          proteinTarget={todayPlan?.targets?.protein ?? null}
                          calorieTarget={todayPlan?.targets?.calories ?? null}
                          todaysFocus={todaysFocus}
                          workoutDone={todayDone}
                          hidden={!todayDone}
                          onScoreComputed={applyReadinessScore}
                          onDataComputed={(prep) => { bgPrepDataRef.current = prep; }}
                        />
                      );
                    })()}
                    <TodayWorkoutPlanActivityCards
                      themeName={userProfile.themePreference}
                      distanceUnit={distanceUnit}
                      sessions={workoutHistoryList.filter((s) => {
                        if (!isExtraWorkoutActivitySession(s)) return false;
                        const d = (s.startedAt ?? s.date ?? '').slice(0, 10);
                        return d === key;
                      })}
                      templates={workoutTemplates}
                      isFreeTier={isFreeTier}
                      onStartTemplate={(template) => {
                        import('../utils/feedback').then(f => f.hapticHeavy()).catch(() => {});
                        onStartWorkout(workoutFromTemplateForToday(template));
                      }}
                      onDeleteTemplate={(template) => {
                        Alert.alert('Delete template?', `Remove ${template.name}?`, [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Delete',
                            style: 'destructive',
                            onPress: async () => {
                              await deleteWorkoutTemplate(template.id);
                              const next = await loadWorkoutTemplates();
                              setWorkoutTemplates(next);
                            },
                          },
                        ]);
                      }}
                      onStartCustom={() => {
                        setLiveTrackerInitialActivity(null);
                        setShowLiveTracker(true);
                      }}
                      onLogActivity={() => setShowLogActivity(true)}
                      onEditPlan={() => setWorkoutSubTab('equipment')}
                      onNewTemplate={() => {
                        // Free-cap defense — backend helper also enforces.
                        if (isFreeTier && workoutTemplates.length >= 3) {
                          Alert.alert(
                            'Template limit reached',
                            'Free accounts can save up to 3 workout templates. Upgrade to Pro for unlimited.',
                          );
                          return;
                        }
                        setTemplateBuilderTarget(null);
                        setTemplateBuilderOpen(true);
                      }}
                      onEditTemplate={(template) => {
                        setTemplateBuilderTarget(template);
                        setTemplateBuilderOpen(true);
                      }}
                    />
                    {!isFreeTier && (
                      <DetectedWorkoutsCard
                        themeName={userProfile.themePreference}
                        authToken={authToken}
                        onAfterImport={async (sessionDate) => {
                          try {
                            const { history, summaries } = await loadWorkoutHistoryBundle();
                            setWorkoutHistoryList(history);
                            setWorkoutHistorySummaries(summaries);
                          } catch {}
                          await refreshNutritionAfterActivity(sessionDate ?? todayKey()).catch(() => {});
                          loadDayStatus();
                        }}
                      />
                    )}
                  </View>
                ) : (
                  <View style={{ gap: 6, marginBottom: 12, marginTop: -4 }}>
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      <TouchableOpacity
                        style={{
                          flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                          paddingVertical: 7, borderRadius: 10, borderWidth: 1, gap: 5,
                          borderColor: themeColors.primary + '55',
                          backgroundColor: themeColors.primary + '0E',
                        }}
                        onPress={() => {
                          setLiveTrackerInitialActivity(null);
                          setShowLiveTracker(true);
                        }}
                        activeOpacity={0.7}>
                        <Ionicons name="flash" size={14} color={themeColors.primary} />
                        <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.primary, letterSpacing: 0.3 }}>Custom</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={{
                          flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                          paddingVertical: 7, borderRadius: 10, borderWidth: 1, gap: 5,
                          borderColor: themeColors.primary + '33',
                        }}
                        onPress={() => setShowLogActivity(true)}
                        activeOpacity={0.7}>
                        <Ionicons name="add-circle" size={14} color={themeColors.primary} />
                        <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.primary, letterSpacing: 0.3 }}>Log</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={{
                          flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                          paddingVertical: 7, borderRadius: 10, borderWidth: 1, gap: 5,
                          borderColor: themeColors.border,
                        }}
                        onPress={() => setWorkoutSubTab('equipment')}
                        activeOpacity={0.7}>
                        <Ionicons name="settings-sharp" size={14} color={themeColors.textMuted} />
                        <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.textMuted, letterSpacing: 0.3 }}>Edit</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
                </React.Fragment>
              );
            })()}

            {/* Readiness detail modal — centered fade-in popup, single card */}
            <Modal
              visible={showReadiness && !isFreeTier}
              animationType="fade"
              transparent
              onRequestClose={() => setShowReadiness(false)}
            >
              <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.82)', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
                <View style={{ width: '100%', maxHeight: '85%' }} pointerEvents="box-none">
                  <ScrollView scrollEnabled showsVerticalScrollIndicator={false}>
                    {(() => {
                      const todayPlanR = nutritionPlansByDate[todayKey()] ?? null;
                      const todayScheduleItemR = schedule?.find(s => dateKey(s.date) === todayKey()) ?? schedule?.[0];
                      const todaysFocusR = todayScheduleItemR?.workout?.focus ?? workoutPlan?.days?.[0]?.focus ?? null;
                      return (
                        <View style={{ position: 'relative', paddingTop: 2 }}>
                          <TouchableOpacity
                            onPress={() => setShowReadiness(false)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            style={{
                              position: 'absolute', top: 12, right: 12, zIndex: 10,
                              width: 32, height: 32, borderRadius: 16,
                              backgroundColor: themeColors.background + 'E6',
                              borderWidth: 1, borderColor: themeColors.border + 'AA',
                              alignItems: 'center', justifyContent: 'center',
                            }}>
                            <Ionicons name="close" size={18} color={themeColors.textPrimary} />
                          </TouchableOpacity>
                          <TrainingReadinessCard
                            authToken={authToken ?? ''}
                            themeName={userProfile.themePreference}
                            age={userProfile.physicalStats?.age ?? null}
                            proteinTarget={todayPlanR?.targets?.protein ?? null}
                            calorieTarget={todayPlanR?.targets?.calories ?? null}
                            todaysFocus={todaysFocusR}
                            workoutDone={todayDone}
                            defaultExpanded
                            lockedExpanded
                            initialPrep={bgPrepDataRef.current}
                            onScoreComputed={applyReadinessScore}
                          />
                        </View>
                      );
                    })()}
                  </ScrollView>
                </View>
              </View>
            </Modal>
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
              <View style={[styles.planProtectionNotice, { borderColor: mealPalette.strong + '44', backgroundColor: mealPalette.soft }]}>
                <Ionicons name="shield-checkmark-outline" size={16} color={mealPalette.strong} />
                <View style={{ flex: 1 }}>
                  <Text {...dynamicCompactTextProps} style={[styles.planProtectionTitle, { color: themeColors.textPrimary }]}>
                    Routine and protected meals stay visible
                  </Text>
                  <Text {...dynamicTextProps} style={[styles.planProtectionBody, { color: themeColors.textSecondary }]}>
                    Pinned routines, edited meals, and logged meals are reapplied after regeneration so the new plan does not erase your choices.
                  </Text>
                </View>
              </View>
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
              <View style={{ flex: 1, marginHorizontal: -16, marginBottom: 96, backgroundColor: themeColors.background }}>
                <SupplementStackScreen
                  authToken={authToken!}
                  themeName={userProfile.themePreference}
                />
              </View>
            )}

            {(mealsSubTab !== 'plan' && mealsSubTab !== 'history' && mealsSubTab !== 'supplements') && (
              <View style={{ flex: 1, marginHorizontal: -16, marginBottom: 96, backgroundColor: themeColors.background }}>
                {mealsSubTab === 'foods' && !isFreeTier && (
                  <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
                    <TouchableOpacity
                      testID="foods-grocery-list-card"
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
                        onLogged={async (log) => {
                          await mirrorLoggedSavedMealToDay(log.meal_date, log.saved, log.mealId, log.consumed_at);
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

            {/* History — past 14 days. Backend meal history wins when it
                exists; local plan/check snapshots are only the offline
                fallback. */}
            {mealsSubTab === 'history' && (() => {
              // Build a date-ordered list of days that have either plan data
              // or meal-check data. Limited to the last 14 days.
              const days: string[] = [];
              const seen = new Set<string>();
              for (const k of Object.keys(nutritionPlansByDate).concat(Object.keys(checkedMealsByDate), backendMealDailyRows.map(row => row.date))) {
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
                  <View style={[styles.emptyStateCard, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
                    <Ionicons name="restaurant-outline" size={36} color={mealPalette.strong} />
                    <Text {...dynamicTextProps} style={[styles.emptyStateTitle, { color: themeColors.textPrimary }]}>No meal history yet</Text>
                    <Text {...dynamicTextProps} style={[styles.emptyStateBody, { color: themeColors.textSecondary }]}>
                      Check off meals on the Plan tab or log from Favorites. Past days will collect here with calories, macros, and score trends.
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
                const loggedScore = loggedNutritionScoreByDate.get(key)?.score;
                const sc = typeof loggedScore === 'number' ? loggedScore : null;
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
                <View testID="meal-history-screen" style={{ gap: 10, marginBottom: 80 }}>
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
                        const backendMeals = backendMealSuggestionsByDate.get(c.date) ?? [];
                        const checks = checkedMealsByDate[c.date] ?? {};
                        const removedSetHist = new Set((planDay?.removedMealIds ?? []) as string[]);
                        const activeKeys = (planDay?.meals ?? [])
                          .map((_, i) => `meal_${i}`)
                          .filter(k => !removedSetHist.has(k));
                        const checkedCount = Object.values(checks).filter(Boolean).length;
                        const allPlanChecked = activeKeys.length > 0 && activeKeys.every(k => !!checks[k]);
                        const fullyLogged = backendMeals.length >= 3 || allPlanChecked || checkedCount >= 3;
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
                  {sorted.map((d, historyIdx) => {
                    const plan = nutritionPlansByDate[d];
                    const planMeals = plan?.meals ?? [];
                    const backendMeals = backendMealSuggestionsByDate.get(d) ?? [];
                    // When the backend has logged Meal rows, they are the
                    // historical source of truth. Use them for both the
                    // card total and expanded rows so the user can add up
                    // what they see and land on the same number.
                    const meals = backendMeals.length > 0 ? backendMeals : planMeals;
                    const checks = checkedMealsByDate[d] ?? {};
                    const backendRow = backendMealDailyByDate.get(d);
                    const hasBackendMeals = backendMeals.length > 0;
                    const checkedCount = planMeals.reduce((n, _m, i) => n + (checks[`meal_${i}`] ? 1 : 0), 0);
                    const loggedPlanTotals = planMeals.reduce((acc, m, i) => {
                      if (!checks[`meal_${i}`]) return acc;
                      return {
                        cal: acc.cal + (m.calories ?? 0),
                        pro: acc.pro + (m.protein ?? 0),
                        carb: acc.carb + (m.carbs ?? 0),
                        fat: acc.fat + (m.fat ?? 0),
                      };
                    }, { cal: 0, pro: 0, carb: 0, fat: 0 });
                    const backendMealTotals = backendMeals.reduce((acc, m) => ({
                      cal: acc.cal + (m.calories ?? 0),
                      pro: acc.pro + (m.protein ?? 0),
                      carb: acc.carb + (m.carbs ?? 0),
                      fat: acc.fat + (m.fat ?? 0),
                    }), { cal: 0, pro: 0, carb: 0, fat: 0 });
                    const displayTotals = backendRow
                      ? {
                          cal: backendRow.calories,
                          pro: backendRow.protein_g,
                          carb: backendRow.carbs_g,
                          fat: backendRow.fat_g,
                        }
                      : hasBackendMeals
                        ? backendMealTotals
                        : loggedPlanTotals;
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
                    const _historyActiveKeys = planMeals.map((_, i) => `meal_${i}`);
                    const _historyAllChecked = _historyActiveKeys.length > 0 && _historyActiveKeys.every(k => !!checks[k]);
                    const displayLoggedCount = backendRow?.meal_count ?? (hasBackendMeals ? backendMeals.length : checkedCount);
                    const cardFullyLogged = hasBackendMeals ? displayLoggedCount >= 3 : (_historyAllChecked || displayLoggedCount >= 3);
                    return (
                      <View key={d} style={{
                        backgroundColor: cardFullyLogged ? themeColors.success + '12' : themeColors.surface,
                        borderRadius: 14, borderWidth: 1,
                        borderColor: cardFullyLogged ? themeColors.success + '55' : themeColors.border,
                      }}>
                        <TouchableOpacity
                          testID={`meal-history-row-${historyIdx}`}
                          accessibilityLabel={`meal-history-row-${historyIdx}`}
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
                                {hasBackendMeals ? `${displayLoggedCount} logged` : `${checkedCount}/${meals.length || '–'} logged`}
                              </Text>
                              <Ionicons name={isExpanded ? 'chevron-down' : 'chevron-forward'} size={14} color={themeColors.textMuted} />
                            </View>
                          </View>
                          {(backendRow || meals.length > 0) && (
                            <Text style={{ fontSize: 12, color: themeColors.textSecondary, marginTop: 4 }}>
                              {Math.round(displayTotals.cal)} cal · {Math.round(displayTotals.pro)}g P · {Math.round(displayTotals.carb)}g C · {Math.round(displayTotals.fat)}g F
                              {targets?.calories ? ` · target ${Math.round(targets.calories)} cal` : ''}
                            </Text>
                          )}
                        </TouchableOpacity>
                        {isExpanded && meals.length > 0 && (
                          <View style={{ borderTopWidth: 1, borderTopColor: themeColors.border, padding: 12, gap: 8 }}>
                            {meals.map((m, i) => {
                              const historyMealId = Number((m as any)._loggedMealId || 0) || undefined;
                              const mealType = hasBackendMeals && historyMealId ? `history_${historyMealId}` : `meal_${i}`;
                              const ate = hasBackendMeals ? true : !!checks[mealType];
                              const openMealEditor = () => setEditingMeal({ dateKey: d, type: mealType, meal: m, historyMealId });
                              return (
                                <View
                                  key={(m as any)._localId ?? `${d}-${i}`}
                                  testID={`meal-history-row-${historyIdx}-meal-${i}`}
                                  accessibilityLabel={`meal-history-row-${historyIdx}-meal-${i}`}
                                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                                  <TouchableOpacity
                                    disabled={hasBackendMeals}
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
                                    onPress={openMealEditor}>
                                    <Text style={{ fontSize: 13, fontWeight: '600', color: themeColors.textPrimary }} numberOfLines={1}>{m.meal}</Text>
                                    <Text style={{ fontSize: 10, color: themeColors.textMuted, marginTop: 1 }}>
                                      {Math.round(m.calories ?? 0)} cal · {Math.round(m.protein ?? 0)}g P · {Math.round(m.carbs ?? 0)}g C · {Math.round(m.fat ?? 0)}g F
                                    </Text>
                                  </TouchableOpacity>
                                  {(!hasBackendMeals || historyMealId) && (
                                    <TouchableOpacity
                                      onPress={openMealEditor}
                                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                      <Ionicons name="create-outline" size={18} color={mealPalette.strong} />
                                    </TouchableOpacity>
                                  )}
                                  {/* Delete from history. For backend-logged meals
                                      (have a historyMealId) we hard-delete via
                                      DELETE /meals/{id} which cascades MealItem
                                      rows + recomputes the daily metrics. For
                                      plan-checked meals without a backend row,
                                      uncheck them (effectively removes them from
                                      this day's logged set). */}
                                  <TouchableOpacity
                                    onPress={() => {
                                      Alert.alert(
                                        'Delete meal?',
                                        hasBackendMeals && historyMealId
                                          ? `Remove "${m.meal}" from this day's history? This recalculates calories, macros, and your nutrition score for ${label}.`
                                          : `Remove "${m.meal}" from this day's log? You can re-check it from the Plan tab anytime.`,
                                        [
                                          { text: 'Cancel', style: 'cancel' },
                                          {
                                            text: 'Delete',
                                            style: 'destructive',
                                            onPress: async () => {
                                              if (hasBackendMeals && historyMealId && authToken) {
                                                try {
                                                  await deleteLoggedMeal(authToken, historyMealId);
                                                  // Optimistic local strip + bump the
                                                  // refresh key so getMealHistory
                                                  // re-fires and any cards / score
                                                  // tiles re-render.
                                                  setBackendMealHistory(prev => prev?.filter(e => e.id !== historyMealId) ?? null);
                                                  setMealLogRefreshKey(k => k + 1);
                                                } catch (err: any) {
                                                  Alert.alert('Could not delete', err?.message ?? 'Try again.');
                                                }
                                              } else {
                                                // Plan-check path — uncheck so the
                                                // day no longer counts this meal as
                                                // logged. Same handler the row's
                                                // checkbox uses.
                                                handleToggleMeal(d, mealType);
                                              }
                                            },
                                          },
                                        ],
                                      );
                                    }}
                                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                    <Ionicons name="trash-outline" size={18} color={themeColors.textMuted} />
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

            {mealsSubTab === 'plan' && (() => {
              const _weekMealDays = [...mealDays].sort((a, b) => a.date.getTime() - b.date.getTime());
              const _todayMealDay = _weekMealDays.find(d => d.key === todayKey());
              const _selectedMealKey = _weekMealDays.some(d => d.key === selectedMealDayKey)
                ? selectedMealDayKey
                : (_todayMealDay?.key ?? _weekMealDays[0]?.key ?? todayKey());
              const _selectedMealDay = _weekMealDays.find(d => d.key === _selectedMealKey);
              const _orderedMealDays = _selectedMealDay ? [_selectedMealDay] : [];
              const mealWeekItems: WeekStripItem[] = _weekMealDays.map(day => {
                const checks = checkedMealsByDate[day.key] ?? {};
                const checkedCount = Object.values(checks).filter(Boolean).length;
                const isPast = day.date < new Date(new Date().setHours(0, 0, 0, 0));
                return {
                  key: day.key,
                  date: day.date,
                  title: day.key === todayKey() ? 'Today’s meals' : `${DAY_NAMES[day.date.getDay()]} meals`,
                  state: checkedCount > 0 ? 'logged' : isPast ? 'skipped' : day.key === todayKey() ? 'today' : 'planned',
                };
              });
              return (
                <React.Fragment>
                  <WeekStrip
                    items={mealWeekItems}
                    selectedKey={_selectedMealKey}
                    accent={MEALS_ACCENT}
                    colors={themeColors}
                    label="Meal week"
                    onSelect={(dayKey) => {
                      import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
                      setSelectedMealDayKey(dayKey);
                      refreshHydration(dayKey).catch(() => {});
                    }}
                  />
                  {_orderedMealDays.map((d, idx) => {
              // Prefer the locally-loaded plan (which has rich client-side
              // overlays — preserved meals, gut data, etc.). Fall back to
              // the PlanDay's persisted nutrition_json when the rolling
              // fetch didn't cover this date (e.g. yesterday).
              let plan = nutritionPlansByDate[d.key];
              if (!plan && planWeek?.days?.length) {
                const pd = planWeek.days.find(pdi => pdi.day_date === d.key);
                if (pd?.nutrition) plan = pd.nutrition as any;
              }
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
              // Date-based today check — with the dated PlanWeek, today is
              // no longer guaranteed to live at index 0 (e.g., Tue when the
              // week started Mon).
              const isToday = d.key === todayKey();
              const isPast = d.date < new Date(new Date().setHours(0, 0, 0, 0));
              // "Logged" past day: any meal checked on that date (or all checked).
              const dayChecks = checkedMealsByDate[d.key] ?? {};
              const checkedCount = Object.values(dayChecks).filter(Boolean).length;
              const isPastLogged = isPast && checkedCount > 0;
              const isPastSkipped = isPast && checkedCount === 0;
              const authoritativeNutritionScore = loggedNutritionScoreByDate.get(d.key);
              const removedSet = new Set(plan.removedMealIds ?? []);
              const meals = (plan.meals ?? []).filter((_, i) => !removedSet.has(`meal_${i}`));
              // Single-pass macro totals — was 4 separate `.reduce` calls
              // per day. With 7 day cards × ~5 meals each, that's 28
              // unnecessary iterations per parent render. The for-of
              // loop walks the array once and accumulates all four
              // values together.
              let totalCalories = 0, totalProtein = 0, totalCarbs = 0, totalFat = 0;
              for (const m of meals) {
                totalCalories += m.calories ?? 0;
                totalProtein  += m.protein ?? 0;
                totalCarbs    += m.carbs ?? 0;
                totalFat      += m.fat ?? 0;
              }
              const liveAdjustedMacros = isToday ? adjustedDailyTarget?.adjusted_macros : null;
              const planForDisplay = liveAdjustedMacros && adjustedDailyTarget
                ? {
                  ...plan,
                  targets: {
                    ...(plan.targets ?? { calories: 0, protein: 0, carbs: 0, fat: 0 }),
                    calories: adjustedDailyTarget.adjusted_calories,
                    protein: liveAdjustedMacros.protein_g,
                    carbs: liveAdjustedMacros.carbs_g,
                    fat: liveAdjustedMacros.fat_g,
                  },
                  _liveTargets: {
                    source: 'activity_and_weekly_budget',
                    activity_adjustment_kcal: adjustedDailyTarget.activity_adjustment_applied ?? 0,
                    weekly_adjustment_kcal: adjustedDailyTarget.weekly_adjustment_applied ?? adjustedDailyTarget.adjustment_applied,
                  },
                } as DailyNutritionPlan
                : plan;
              const t = planForDisplay.targets ?? { calories: 0, protein: 0, carbs: 0, fat: 0 };
              // Today highlight uses the hardcoded MEALS_ACCENT (green)
              // so it's guaranteed distinct from the workout side's
              // hardcoded WORKOUT_ACCENT (blue) regardless of which
              // theme the user has selected. Past days dim + dash to
              // visually recede, mirroring the workout-side treatment.
              const cardBg = isToday ? themeColors.surfaceRaised : themeColors.surface;
              const cardBorder = isToday
                ? MEALS_ACCENT
                : isPastLogged
                  ? MEALS_ACCENT + '55'
                  : isPastSkipped
                    ? themeColors.warning + '66'
                  : themeColors.border;
              const cardBorderWidth = isToday ? 2 : 1;
              const cardBorderStyle: 'solid' | 'dashed' = isPast && !isToday ? 'dashed' : 'solid';
              const cardOpacity = isPast && !isToday ? 0.78 : 1;
              const hydrationForDay = hydrationByDate[d.key] ?? (isToday ? hydration : null);
              const hydrationOunces = Math.round(hydrationForDay?.ounces ?? 0);
              const hydrationTarget = Math.max(1, Math.round(hydrationForDay?.target_ounces ?? 64));
              const hydrationPct = Math.min(100, Math.round((hydrationOunces / hydrationTarget) * 100));
              return (
                <React.Fragment key={d.key}>
                <FadeInView delay={idx * 70}>
                <View style={[
                  styles.mealAccordionCard,
                  isToday && { marginBottom: 16 },
                  {
                    backgroundColor: cardBg,
                    borderColor: cardBorder,
                    borderWidth: cardBorderWidth,
                    borderStyle: cardBorderStyle,
                    opacity: cardOpacity,
                  },
                ]}
                testID={isToday ? 'today-meal-card' : undefined}>
                  {(isToday || isPastLogged) && (
                    <View style={[
                      styles.dayCardTopAccent,
                      {
                        backgroundColor: MEALS_ACCENT,
                        marginBottom: 0,
                        height: isToday ? 4 : 3,
                        opacity: isPastLogged && !isToday ? 0.55 : 1,
                      },
                    ]} />
                  )}
                  <TouchableOpacity
                    testID={isToday ? 'today-meal-card-header' : undefined}
                    style={[styles.mealAccordionHeader, { backgroundColor: 'transparent' }]}
                    onPress={() => {
                      import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
                      configureExpandAnimation(360);
                      setExpandedMealDays(prev => {
                        const next = new Set(prev);
                        if (next.has(d.key)) next.delete(d.key); else next.add(d.key);
                        return next;
                      });
                    }}
                    activeOpacity={0.8}
                  >
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={[
                          styles.mealAccordionTitle,
                          {
                            color: isToday ? MEALS_ACCENT : themeColors.textPrimary,
                            fontWeight: isToday ? '900' : '700',
                            fontSize: isToday ? 22 : 18,
                          },
                        ]}>
                          {mealDayLabel(d.date, idx)}
                        </Text>
                        {isToday && (
                          <View style={{ backgroundColor: MEALS_ACCENT + '22', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}>
                            <Text style={{ fontSize: 9, fontWeight: '800', color: MEALS_ACCENT, letterSpacing: 0.4 }}>TODAY</Text>
                          </View>
                        )}
                        {isPastLogged && (
                          <View style={{
                            backgroundColor: MEALS_ACCENT + '22',
                            borderRadius: 4,
                            paddingHorizontal: 5,
                            paddingVertical: 1,
                          }}>
                            <Text style={{ fontSize: 9, fontWeight: '800', color: MEALS_ACCENT, letterSpacing: 0.4 }}>
                              ✓ {checkedCount} LOGGED
                            </Text>
                          </View>
                        )}
                        {isPastSkipped && (
                          <View style={{
                            backgroundColor: themeColors.warning + '22',
                            borderRadius: 4,
                            paddingHorizontal: 5,
                            paddingVertical: 1,
                          }}>
                            <Text style={{ fontSize: 9, fontWeight: '800', color: themeColors.warning, letterSpacing: 0.4 }}>
                              SKIPPED
                            </Text>
                          </View>
                        )}
                        {!isPast && !isToday && (
                          <View style={{ backgroundColor: themeColors.border, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}>
                            <Text style={{ fontSize: 9, fontWeight: '700', color: themeColors.textMuted, letterSpacing: 0.4 }}>PLANNED</Text>
                          </View>
                        )}
                      </View>
                      {/* Calorie progress on first line, macros with targets below. */}
                      <Text style={[styles.mealAccordionMeta, { color: themeColors.textSecondary }]}>
                        <Text style={{ fontWeight: '700', color: mealPalette.strong }}>{Math.round(totalCalories)}</Text>
                        <Text> / {t.calories} cal</Text>
                      </Text>
                      <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 1, fontWeight: '500' }}>
                        <Text style={{ fontWeight: '700', color: themeColors.textSecondary }}>{Math.round(totalProtein)}</Text>
                        {t.protein > 0 ? `/${t.protein}g P` : 'g P'}
                        {'  '}
                        <Text style={{ fontWeight: '700', color: themeColors.textSecondary }}>{Math.round(totalCarbs)}</Text>
                        {t.carbs > 0 ? `/${t.carbs}g C` : 'g C'}
                        {'  '}
                        <Text style={{ fontWeight: '700', color: themeColors.textSecondary }}>{Math.round(totalFat)}</Text>
                        {t.fat > 0 ? `/${t.fat}g F` : 'g F'}
                      </Text>
                      {/* Weekly budget adjustment — only on today's card, only
                          when the shift is >15 kcal so on-target days are quiet. */}
                      {isToday && adjustedDailyTarget && Math.abs(adjustedDailyTarget.adjustment_applied) > 15 && (
                        <Text testID="today-nutrition-target-adjustment" style={{ fontSize: 10, color: adjustedDailyTarget.adjustment_applied > 0 ? themeColors.success : themeColors.warning, marginTop: 2, fontWeight: '600' }}>
                          {adjustedDailyTarget.adjustment_applied > 0 ? '↑' : '↓'}{' '}
                          {Math.abs(Math.round(adjustedDailyTarget.adjustment_applied))} kcal {((adjustedDailyTarget.activity_adjustment_applied ?? 0) > 0) ? 'today adjustment' : 'weekly adjustment'}
                          {adjustedDailyTarget.note ? ` · ${adjustedDailyTarget.note}` : ''}
                        </Text>
                      )}
                      {isToday && authToken && !isFreeTier ? (
                        <View style={{ marginTop: 7 }}>
                          <FuelingRecoveryCard key={`fueling-${activityNutritionRefreshKey}`} authToken={authToken} themeName={userProfile.themePreference} variant="button" />
                        </View>
                      ) : null}
                    </View>
                    {/* Per-day nutrition score badge */}
                    {(() => {
                      if (isFreeTier) return null;
                      const preview = !isPast ? computeNutritionScore(planForDisplay, userProfile.goal ?? 'body_recomp') : null;
                      const score = authoritativeNutritionScore?.score ?? preview?.score ?? null;
                      if (!score || score <= 0) return null;
                      const c = score >= 70 ? themeColors.success : score >= 45 ? themeColors.warning : themeColors.error;
                      return (
                        <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: c + '18', alignItems: 'center', justifyContent: 'center', marginRight: 4 }}>
                          <Text style={{ fontSize: 13, fontWeight: '900', color: c }}>{score}</Text>
                        </View>
                      );
                    })()}
                    {/* Quick "+ Add" button — visible on the collapsed
                        header so users don't have to expand the card just
                        to log a meal. Stops propagation so the parent
                        TouchableOpacity (which toggles expand) doesn't
                        fire underneath. */}
                    {!isPastSkipped && (
                      <TouchableOpacity
                        testID={isToday ? 'today-add-meal' : undefined}
                        onPress={(e) => {
                          e.stopPropagation();
                          import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
                          handleAddSnack(d.key);
                        }}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 6 }}
                        style={{
                          flexDirection: 'row', alignItems: 'center', gap: 4,
                          paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14,
                          backgroundColor: MEALS_ACCENT + '18',
                          borderWidth: 1, borderColor: MEALS_ACCENT + '55',
                          marginRight: 6,
                        }}
                        accessibilityLabel="Add meal"
                      >
                        <Ionicons name="add" size={14} color={MEALS_ACCENT} />
                        <Text style={{ fontSize: 11, fontWeight: '800', color: MEALS_ACCENT, letterSpacing: 0.3 }}>
                          ADD
                        </Text>
                      </TouchableOpacity>
                    )}
                    <ExpandingChevron expanded={isExpanded} color={themeColors.textMuted} size={16} />
                  </TouchableOpacity>

                  {(isToday || isPast) && authToken && (
                    <HydrationTodayPanel
                      ounces={hydrationOunces}
                      target={hydrationTarget}
                      pct={hydrationPct}
                      breakdown={hydrationForDay?.breakdown}
                      guidance={hydrationForDay?.guidance}
                      loading={hydrationLoading}
                      colors={themeColors}
                      onDelta={(oz) => handleHydrationDelta(oz, d.key)}
                      onSet={(oz) => handleHydrationSet(oz, d.key)}
                    />
                  )}

                  <AnimatedCollapsible visible={isExpanded} duration={360} slideDistance={14}>
                    <View style={styles.mealExpansionRail}>
                      <NutritionCard
                        testID={d.key === todayKey() ? 'today-nutrition-card' : undefined}
                        embedded
                        themeName={userProfile.themePreference}
                        nutritionPlan={planForDisplay}
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
                        shufflingMealKey={shufflingInfo?.date === d.key ? shufflingInfo.mealKey : null}
                        onRenameMeal={(mealType, newName) => handleRenameMeal(d.key, mealType, newName)}
                        goal={userProfile.goal}
                        savedMealNames={savedMealNames}
                        onAddFromSaved={() => setAddFromSavedFor(d.key)}
                        onToggleSave={handleToggleSaveMeal}
                        dailyCollagenG={d.key === todayKey() ? todayCollagenG : null}
                        dailyProbioticCfuBillions={d.key === todayKey() ? todayProbioticCfu : null}
                        proteinBreakdown={d.key === todayKey() ? proteinBreakdown : null}
                        todaySupplements={d.key === todayKey() ? todaySupplementMicros : null}
                        authoritativeScore={typeof authoritativeNutritionScore?.score === 'number' ? {
                          score: authoritativeNutritionScore.score,
                          adherence: authoritativeNutritionScore.adherence,
                          quality: authoritativeNutritionScore.quality,
                          micro: authoritativeNutritionScore.micro,
                        } : null}
                        hidePlanScore={isPast}
                      />
                    </View>
                  </AnimatedCollapsible>
                </View>
                </FadeInView>
                {isToday && _todayMealDay && (
                  <View style={{ marginTop: -4 }}>
                    {isFreeTier ? (
                      <>
                        <FadeInView delay={20}>
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
                                Add meals yourself, use Favorites, or pin routines to auto-fill. Upgrade to Pro for AI plans.
                              </Text>
                            </View>
                          </View>
                        </FadeInView>
                        {authToken && (
                          <SavedMealsSection
                            authToken={authToken}
                            themeName={userProfile.themePreference}
                            onLogged={async (log) => {
                              await mirrorLoggedSavedMealToDay(log.meal_date, log.saved, log.mealId, log.consumed_at);
                              loadDayStatus();
                              if (userProfile) loadPlans(userProfile);
                              reloadSavedMeals();
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
                      </>
                    ) : authToken ? (
                      <>
                        <SavedMealsSection
                          authToken={authToken}
                          themeName={userProfile.themePreference}
                          onLogged={async (log) => {
                            await mirrorLoggedSavedMealToDay(log.meal_date, log.saved, log.mealId, log.consumed_at);
                            loadDayStatus();
                            if (userProfile) loadPlans(userProfile);
                            reloadSavedMeals();
                          }}
                          onEditTemplate={(sm) => {
                            setEditingSavedMeal({
                              id: sm.id,
                              name: sm.name,
                              items: sm.items || [],
                            });
                          }}
                        />
                        {(() => {
                          const todayPlanForTarget = nutritionPlansByDate[_todayMealDay.key] ?? nutritionPlansByDate[mealDays[0]?.key];
                          const target = todayPlanForTarget?.targets?.calories ?? 0;
                          if (target <= 0) return null;
                          return (
                            <IncompleteDayBanner
                              authToken={authToken}
                              themeName={userProfile.themePreference}
                              targetCalories={target}
                              onFillIn={() => setMealsSubTab('history')}
                            />
                          );
                        })()}
                        <AdaptiveMacroCard
                          authToken={authToken}
                          themeName={userProfile.themePreference}
                          weightEntries={adaptiveMacroWeightEntries}
                          onAccept={async (newTarget, result) => {
                            try {
                              if (result.action) {
                                const { applyRecommendationAction } = await import('../services/api');
                                await applyRecommendationAction(authToken, result.action, 'adaptive_macros');
                              } else {
                                onProfileUpdate?.({
                                  customMacros: {
                                    ...(userProfile.customMacros ?? {}),
                                    calories: newTarget,
                                  },
                                } as any, true);
                              }
                              Alert.alert(
                                'Target updated',
                                `Your new calorie target is ${newTarget} kcal/day. Daily targets update right away; generated meal templates refresh on your next plan.`,
                              );
                            } catch (e) {
                              Alert.alert('Could not update target', e instanceof Error ? e.message : 'Please try again.');
                            }
                          }}
                        />
                      </>
                    ) : null}
                  </View>
                )}
                </React.Fragment>
              );
            })}
                </React.Fragment>
              );
            })()}
          </>
          )
        )}
      </ScrollView>
      </ErrorBoundary>
      )}

      {/* ── Social tab — Friends + Weekly Digest ──────── */}
      {activeTab === 'friends' && (
        <ErrorBoundary>
          <View key={viewingFriend ? `friend-${viewingFriend.user_id}` : 'social-home'} style={{ flex: 1 }}>
          {viewingFriend ? (
            <ScrollView testID="social-friend-detail-screen" style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 166 }}>
              <TouchableOpacity
                testID="social-friend-detail-back"
                accessibilityLabel="social-friend-detail-back"
                onPress={() => setViewingFriend(null)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 16 }}
                activeOpacity={0.7}
              >
                <Ionicons name="arrow-back" size={20} color={themeColors.primary} />
                <Text style={{ fontSize: 14, fontWeight: '600', color: themeColors.primary }}>Back</Text>
              </TouchableOpacity>

              {/* Friend profile card */}
              <View
                testID="social-friend-profile-card"
                style={{
                  backgroundColor: themeColors.surface, borderColor: themeColors.border, borderWidth: 1,
                  borderRadius: 14, padding: 20, alignItems: 'center', marginBottom: 16,
                }}>
                <SocialAvatar
                  avatarUrl={viewingFriend.avatar_url}
                  name={viewingFriend.display_name}
                  username={viewingFriend.username}
                  size={56}
                  backgroundColor={themeColors.primary + '22'}
                  borderColor={themeColors.primary + '55'}
                  textColor={themeColors.primary}
                  textSize={22}
                  style={{ marginBottom: 12 }}
                />
                <Text style={{ fontSize: 18, fontWeight: '800', color: themeColors.textPrimary }}>
                  {viewingFriend.display_name || viewingFriend.username}
                </Text>
                <Text style={{ fontSize: 13, color: themeColors.textMuted, marginTop: 2 }}>
                  @{viewingFriend.username}
                </Text>
                {viewingFriend.goal ? (
                  <View style={{
                    marginTop: 10, paddingHorizontal: 12, paddingVertical: 4,
                    backgroundColor: themeColors.primary + '12', borderRadius: 12,
                  }}>
                    <Text style={{ fontSize: 12, fontWeight: '600', color: themeColors.primary }}>
                      {viewingFriend.goal.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                    </Text>
                  </View>
                ) : null}
              </View>

              {/* This week stats */}
              <View
                testID="social-friend-stats-card"
                style={{
                  backgroundColor: themeColors.surface, borderColor: themeColors.border, borderWidth: 1,
                  borderRadius: 14, padding: 16, marginBottom: 16,
                }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.textMuted, letterSpacing: 0.5, marginBottom: 12 }}>
                  THIS WEEK
                </Text>
                <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
                  <View style={{ alignItems: 'center' }}>
                    <Text style={{ fontSize: 24, fontWeight: '800', color: themeColors.textPrimary }}>
                      {viewingFriend.sessions}
                    </Text>
                    <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }}>Sessions</Text>
                  </View>
                  <View style={{ width: 1, backgroundColor: themeColors.border }} />
                  <View style={{ alignItems: 'center' }}>
                    <Text style={{ fontSize: 24, fontWeight: '800', color: themeColors.textPrimary }}>
                      {viewingFriend.streak}
                    </Text>
                    <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }}>Day Streak</Text>
                  </View>
                  <View style={{ width: 1, backgroundColor: themeColors.border }} />
                  <View style={{ alignItems: 'center' }}>
                    <View style={{
                      width: 12, height: 12, borderRadius: 6, marginBottom: 8, marginTop: 8,
                      backgroundColor: viewingFriend.last_active_within_48h ? themeColors.success : themeColors.border,
                    }} />
                    <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }}>
                      {viewingFriend.last_active_within_48h ? 'Active' : 'Inactive'}
                    </Text>
                  </View>
                </View>
              </View>

              {/* Streak highlight when friend has a notable streak */}
              {viewingFriend.share_enabled && viewingFriend.streak >= 3 && (
                <View style={{
                  backgroundColor: themeColors.surface, borderColor: themeColors.border, borderWidth: 1,
                  borderRadius: 14, padding: 16, marginBottom: 16, flexDirection: 'row', alignItems: 'center', gap: 12,
                }}>
                  <Ionicons name="flame" size={22} color="#F59E0B" />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: themeColors.textPrimary }}>
                      {viewingFriend.streak}-day streak
                    </Text>
                    <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }}>
                      {viewingFriend.streak >= 14 ? 'Incredibly consistent!' : viewingFriend.streak >= 7 ? 'On a roll this week.' : 'Building momentum.'}
                    </Text>
                  </View>
                </View>
              )}

              {/* Workout feed */}
              {viewingFriend.share_enabled && (
                <>
                  {friendFeedLoading && (
                    <View style={{ alignItems: 'center', paddingVertical: 20 }}>
                      <ActivityIndicator size="small" color={themeColors.primary} />
                    </View>
                  )}
                  {!friendFeedLoading && friendFeedItems.length === 0 && (
                    <View style={{
                      backgroundColor: themeColors.surface, borderColor: themeColors.border, borderWidth: 1,
                      borderRadius: 14, padding: 20, alignItems: 'center', marginBottom: 16,
                    }}>
                      <Ionicons name="barbell-outline" size={24} color={themeColors.textMuted} />
                      <Text style={{ fontSize: 12, color: themeColors.textMuted, marginTop: 8, textAlign: 'center' }}>
                        No sessions logged this week yet.
                      </Text>
                    </View>
                  )}
                  {!friendFeedLoading && friendFeedItems.map((item, index) => {
                    const p = item.payload;
                    const summary = p.workout_summary ?? p;
                    const isExpanded = expandedFeedItemId === item.id;
                    const durationLabel = formatSocialDuration(summary.duration_seconds ?? p.duration_seconds);
                    const distanceLabel = formatSocialDistance(summary.distance_miles ?? p.distance_miles);
                    const exerciseCount = p.exercise_count ?? summary.exercises?.length ?? 0;
                    const date = summary.date ?? p.date;
                    const dateLabel = date ? new Date(date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '';
                    const metaParts = [dateLabel, durationLabel, distanceLabel, exerciseCount ? `${exerciseCount} exercises` : ''].filter(Boolean);
                    return (
                      <TouchableOpacity
                        key={item.id}
                        testID={`social-friend-feed-row-${index}`}
                        accessibilityLabel={`social-friend-feed-row-${index}`}
                        accessibilityState={{ expanded: isExpanded }}
                        activeOpacity={0.85}
                        onPress={() => {
                          configureExpandAnimation(320);
                          import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
                          setExpandedFeedItemId(isExpanded ? null : item.id);
                        }}
                        style={{
                          backgroundColor: themeColors.surface, borderColor: isExpanded ? themeColors.primary + '45' : themeColors.border, borderWidth: 1,
                          borderRadius: 14, marginBottom: 10, overflow: 'hidden',
                        }}
                      >
                        <View style={{ flexDirection: 'row', alignItems: 'center', padding: 14, gap: 10 }}>
                          <View style={{
                            width: 36, height: 36, borderRadius: 10, backgroundColor: themeColors.primary + '18',
                            alignItems: 'center', justifyContent: 'center',
                          }}>
                            <Ionicons name="barbell-outline" size={18} color={themeColors.primary} />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 14, fontWeight: '800', color: themeColors.textPrimary }}>{summary.focus ?? p.focus ?? 'Workout'}</Text>
                            <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 1 }}>
                              {metaParts.join('  ·  ')}
                            </Text>
                          </View>
                          <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={themeColors.textMuted} />
                        </View>
                        {isExpanded && (() => {
                          // Exercises can live at payload.exercises (workout_completed)
                          // or payload.workout_summary.exercises (workout_post).
                          const exercises: Array<{ name: string; sets: Array<Record<string, any>> }> =
                            p.exercises ?? p.workout_summary?.exercises ?? [];
                          if (exercises.length === 0) {
                            return (
                              <View style={{ borderTopWidth: 1, borderTopColor: themeColors.border, padding: 14 }}>
                                <Text style={{ fontSize: 12, color: themeColors.textMuted }}>No exercise detail available.</Text>
                              </View>
                            );
                          }
                          return (
                            <View style={{ borderTopWidth: 1, borderTopColor: themeColors.border, paddingHorizontal: 14, paddingVertical: 10, gap: 10 }}>
                              {exercises.map((ex, ei) => {
                                const setSummaries = compactSocialSetSummaries(ex.sets as any);
                                return (
                                  <FadeInView key={ei} delay={Math.min(ei * 35, 160)} duration={220} slideDistance={6}>
                                    <View
                                      testID={`social-friend-feed-row-${index}-exercise-${ei}`}
                                      accessibilityLabel={`social-friend-feed-row-${index}-exercise-${ei}`}
                                      style={{
                                        flexDirection: 'row', gap: 10, alignItems: 'flex-start',
                                        backgroundColor: themeColors.surfaceRaised,
                                        borderWidth: 1, borderColor: themeColors.border,
                                        borderRadius: 12, padding: 10,
                                      }}>
                                    <View style={{
                                      width: 22, height: 22, borderRadius: 7,
                                      alignItems: 'center', justifyContent: 'center',
                                      backgroundColor: themeColors.primary + '12',
                                      borderWidth: 1, borderColor: themeColors.primary + '25',
                                    }}>
                                      <Text style={{ fontSize: 10, fontWeight: '800', color: themeColors.primary }}>{ei + 1}</Text>
                                    </View>
                                    <View style={{ flex: 1, gap: 7 }}>
                                      <Text style={{ fontSize: 13, fontWeight: '800', color: themeColors.textPrimary }}>{ex.name}</Text>
                                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                                        {(setSummaries.length ? setSummaries : [`${ex.sets?.length ?? 0} sets`]).map((label, si) => (
                                          <View key={`${ei}-${si}-${label}`} style={{
                                            paddingHorizontal: 8, paddingVertical: 5,
                                            borderRadius: 8,
                                            backgroundColor: themeColors.primary + '10',
                                            borderWidth: 1,
                                            borderColor: themeColors.primary + '22',
                                          }}>
                                            <Text style={{ fontSize: 11, color: themeColors.textSecondary, fontWeight: '700', lineHeight: 14 }}>
                                              {label}
                                            </Text>
                                          </View>
                                        ))}
                                      </View>
                                    </View>
                                  </View>
                                  </FadeInView>
                                );
                              })}
                            </View>
                          );
                        })()}
                      </TouchableOpacity>
                    );
                  })}
                </>
              )}

              {!viewingFriend.share_enabled ? (
                <View style={{
                  backgroundColor: themeColors.surface, borderColor: themeColors.border, borderWidth: 1,
                  borderRadius: 14, padding: 20, alignItems: 'center',
                }}>
                  <Ionicons name="eye-off-outline" size={28} color={themeColors.textMuted} />
                  <Text style={{ fontSize: 13, color: themeColors.textSecondary, marginTop: 8, textAlign: 'center' }}>
                    This friend has activity sharing turned off.
                  </Text>
                </View>
              ) : null}
            </ScrollView>
          ) : (
            <FriendsModal
              visible={false}
              authToken={authToken}
              onClose={() => {}}
              themeName={userProfile.themePreference}
              inline
              onSocialCountsChange={({ friends, pending, unread }) => {
                setFriendCount(friends);
                setPendingFriendCount(pending);
                setSocialUnreadCount(unread);
              }}
              onViewFriend={(userId, displayName, digestFriend) => {
                if (digestFriend) {
                  setViewingFriend(digestFriend);
                  setFriendFeedItems([]);
                  setExpandedFeedItemId(null);
                  if (digestFriend.share_enabled && authToken) {
                    setFriendFeedLoading(true);
                    import('../services/api').then(api =>
                      api.getUserFeed(authToken, digestFriend.user_id)
                    ).then(res => {
                      // Accept both auto-logged and manual-post events.
                      // Deduplicate by workout date — one card per day.
                      // Keep manual-post chrome when present, but preserve
                      // the richest exercise/set details for expansion.
                      const raw = res.items.filter(
                        (i: import('../services/api').FeedItem) =>
                          i.event_type === 'workout_completed' || i.event_type === 'workout_post',
                      );
                      const byDate = new Map<string, import('../services/api').FeedItem>();
                      for (const item of raw) {
                        const date = socialWorkoutDateKey(item);
                        const existing = byDate.get(date);
                        if (!existing) {
                          byDate.set(date, item);
                        } else {
                          byDate.set(date, chooseSocialWorkoutFeedItem(existing, item));
                        }
                      }
                      setFriendFeedItems(
                        Array.from(byDate.values()).sort((a, b) => b.id - a.id),
                      );
                    }).catch(() => {}).finally(() => setFriendFeedLoading(false));
                  }
                }
              }}
            />
          )}
          </View>
        </ErrorBoundary>
      )}

      {/* ── Progress tab — mounted on first visit, then kept warm without background refetches */}
      {progressTabMounted && (
        <Animated.View
          testID="progress-tab-screen"
          style={{ flex: 1, display: activeTab === 'progress' ? 'flex' : 'none', opacity: progressFade }}>
          <ErrorBoundary>
            <ProgressScreen
              authToken={authToken}
              userProfile={userProfile}
              themeName={userProfile.themePreference}
              noHeader
              isActive={activeTab === 'progress'}
              nutritionPlan={nutritionPlansByDate[todayKey()] ?? null}
              nutritionLogRefreshKey={mealLogRefreshKey + activityNutritionRefreshKey}
              planWeekWindow={planWeek ? { startDate: planWeek.start_date, endDate: planWeek.end_date } : null}
              inProgressWorkout={resumeInfo}
              onResumeInProgressWorkout={resumeInProgressWorkout}
              onDiscardInProgressWorkout={clearInProgressWorkout}
              onBack={() => setActiveTab('workout')}
              onCancelScheduledPlanChange={onCancelScheduledPlanChange}
              onUpdateWeight={(weightLbs) => {
                if (onUpdateWeight) {
                  void onUpdateWeight(weightLbs, 'manual');
                  return;
                }
                onProfileUpdate?.({ physicalStats: { ...userProfile.physicalStats, weightLbs } } as any, true);
                import('../utils/weightHistory').then(({ saveWeightEntry }) => saveWeightEntry(weightLbs, 'manual')).catch(() => {});
              }}
            />
          </ErrorBoundary>
        </Animated.View>
      )}

      {/* ── You tab ─────────────────────────────────────────────────── */}
      {activeTab === 'you' && (<ErrorBoundary>{(() => {
        const ps = userProfile.physicalStats;
        const cleanText = (value: unknown): string => {
          const text = typeof value === 'string' ? value.trim() : '';
          return text && text.toLowerCase() !== 'undefined' && text.toLowerCase() !== 'null' ? text : '';
        };
        const numberValue = (value: unknown): number | null => {
          if (typeof value === 'number' && Number.isFinite(value)) return value;
          if (typeof value === 'string' && value.trim()) {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
          }
          return null;
        };
	        const stats = ps as any;
        const details = (userProfile.goalDetails ?? {}) as any;
        // Latest weight from the weight log wins over physicalStats so the
        // hero card stays in sync after the user logs a new weight. Sort
        // by logged_at then date so a same-day re-log promotes correctly.
        const latestWeightFromLog = (() => {
          const entries = userProfile.weightEntries ?? [];
          if (!Array.isArray(entries) || entries.length === 0) return null;
          const sorted = [...entries].sort((a, b) =>
            String(b.logged_at ?? b.date ?? '').localeCompare(String(a.logged_at ?? a.date ?? '')),
          );
          const latest = numberValue(sorted[0]?.weight_lbs);
          return latest != null && latest > 0 ? latest : null;
        })();
        const weightLbs = latestWeightFromLog ?? numberValue(stats?.weightLbs ?? stats?.weight_lbs);
        const heightFeet = numberValue(stats?.heightFeet ?? stats?.height_feet);
        const heightInches = numberValue(stats?.heightInches ?? stats?.height_inches);
        const birthdate = cleanText(stats?.birthdate ?? stats?.birth_date);
        const age = effectiveAge({ birthdate: birthdate || null, age: numberValue(stats?.age) });
        const targetWeightLbs = numberValue(details?.targetWeightLbs ?? details?.target_weight_lbs);
        const profileGoalLabel = cleanText(goalLabel) || cleanText(userProfile.goal);
        const displayName = cleanText(userProfile.firstName) || cleanText(username) || 'Your Profile';
        const metaParts = [
          profileGoalLabel || null,
	          weightLbs != null && weightLbs > 0 ? formatWeight(weightLbs, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 }) : null,
	          targetWeightLbs != null && targetWeightLbs > 0 ? `goal ${formatWeight(targetWeightLbs, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 })}` : null,
          heightFeet != null && heightInches != null ? `${Math.round(heightFeet)}'${Math.round(heightInches)}"` : null,
          age != null && age > 0 ? `age ${Math.round(age)}` : null,
        ].filter((part): part is string => !!part);
        return (
        <ScrollView
          testID="you-tab-screen"
          style={styles.profileScrollView}
          contentContainerStyle={styles.scrollContent}>
          {/* User info header */}
          <View style={[styles.profileHero, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
            <TouchableOpacity
              onPress={openProfilePhotoActions}
              activeOpacity={0.78}
              accessibilityLabel="Update profile photo"
              testID="profile-avatar-button">
              <SocialAvatar
                avatarUrl={userProfile.avatarUrl}
                name={displayName}
                username={username}
                size={56}
                backgroundColor={themeColors.primary + '22'}
                borderColor={themeColors.primary + '55'}
                textColor={themeColors.primary}
                textSize={22}
                style={styles.profileAvatar}>
                <View style={[styles.profileAvatarEdit, { backgroundColor: themeColors.primary, borderColor: themeColors.surface }]}>
                  <Ionicons name="camera" size={10} color={getContrastingTextColor(themeColors.primary)} />
                </View>
              </SocialAvatar>
            </TouchableOpacity>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[styles.profileHeroName, { color: themeColors.textPrimary }]}>
                {displayName}
              </Text>
              {metaParts.length > 0 ? (
                <Text style={[styles.profileHeroMeta, { color: themeColors.textSecondary }]}>
                  {metaParts.join('  ·  ')}
                </Text>
              ) : (
                <TouchableOpacity
                  onPress={onEditBody}
                  activeOpacity={0.8}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2, alignSelf: 'flex-start' }}
                >
                  <Ionicons name="create-outline" size={13} color={themeColors.primary} />
                  <Text style={[styles.profileHeroMeta, { color: themeColors.primary, fontWeight: '800' }]}>
                    Complete profile
                  </Text>
                </TouchableOpacity>
              )}
            </View>
            <Pressable
              onPress={openSettingsHub}
              testID="profile-settings-open"
              accessibilityLabel="profile-settings-open"
              accessibilityRole="button"
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={({ pressed }) => [{ padding: 4 }, pressed && { opacity: 0.7 }]}
            >
              <Ionicons name="settings-outline" size={22} color={themeColors.textMuted} />
            </Pressable>
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
	                {weightLbs != null && weightLbs > 0 ? formatWeight(weightLbs, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0, suffix: false }) : '—'}
	              </Text>
	              <Text style={[styles.profileStatSub, { color: themeColors.textMuted }]}>{weightUnit}</Text>
            </View>
            <View style={[styles.profileStatTile, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
              <Text style={[styles.profileStatLabel, { color: themeColors.textMuted }]}>GOAL PACE</Text>
              <Text style={[styles.profileStatValue, { color: themeColors.textPrimary, fontSize: 14 }]}>
                {userProfile.goalDetails?.pace ?? '—'}
              </Text>
              <Text style={[styles.profileStatSub, { color: themeColors.textMuted }]}>
	                {targetWeightLbs != null && targetWeightLbs > 0 ? `→ ${formatWeight(targetWeightLbs, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 })}` : ''}
              </Text>
            </View>
          </View>

          {/* MY STUFF */}
          <Text style={[styles.profileSectionLabel, { color: themeColors.textMuted, marginTop: 4 }]}>MY STUFF</Text>
          <View style={[styles.profileMenuList, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
            {/* Goal */}
            <Pressable
              style={({ pressed }) => [styles.profileMenuItem, pressed && { opacity: 0.72 }]}
              onPress={() => setShowGoalEditor(true)}
              testID="profile-goal-open"
              accessibilityLabel="profile-goal-open"
              accessibilityRole="button"
            >
              <View style={[styles.profileRowIcon, { backgroundColor: themeColors.primary + '22' }]}>
                <Ionicons name="flag-outline" size={18} color={themeColors.primary} />
              </View>
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text style={[styles.profileMenuLabel, { color: themeColors.textPrimary }]}>Goal</Text>
                <Text style={{ fontSize: 11, color: themeColors.textMuted }}>{goalLabel || 'Set your training goal'}</Text>
              </View>
              <Text style={[styles.profileMenuChevron, { color: themeColors.textMuted }]}>›</Text>
            </Pressable>
            {/* Body & Stats menu row removed — weight is editable in the
                weight log; height, birthday, and biological sex are set
                during onboarding and intentionally not user-editable
                afterward. The body-editor screen still exists as a
                recovery path when a profile lands in an incomplete
                state (the "Complete profile" tap on the hero card). */}
            {/* Settings & reminders */}
            <Pressable
              style={({ pressed }) => [styles.profileMenuItem, pressed && { opacity: 0.72 }]}
              onPress={openSettingsHub}
              testID="profile-settings-row"
              accessibilityLabel="profile-settings-row"
              accessibilityRole="button">
              <View style={[styles.profileRowIcon, { backgroundColor: themeColors.primary + '22' }]}>
                <Ionicons name="notifications-outline" size={18} color={themeColors.primary} />
              </View>
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text style={[styles.profileMenuLabel, { color: themeColors.textPrimary }]}>Settings</Text>
                <Text style={{ fontSize: 11, color: themeColors.textMuted }}>Themes, notifications, units, plan pause, and permissions</Text>
              </View>
              <Text style={[styles.profileMenuChevron, { color: themeColors.textMuted }]}>›</Text>
            </Pressable>
            {/* Account */}
            <Pressable
              style={({ pressed }) => [styles.profileMenuItem, pressed && { opacity: 0.72 }]}
              onPress={onViewAccount}
              testID="profile-account-open"
              accessibilityLabel="profile-account-open"
              accessibilityRole="button">
              <View style={[styles.profileRowIcon, { backgroundColor: themeColors.primary + '22' }]}>
                <Ionicons name="id-card-outline" size={18} color={themeColors.primary} />
              </View>
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text style={[styles.profileMenuLabel, { color: themeColors.textPrimary }]}>Account</Text>
                <Text style={{ fontSize: 11, color: themeColors.textMuted }}>Name, email, password recovery, legal, and support</Text>
              </View>
              <Text style={[styles.profileMenuChevron, { color: themeColors.textMuted }]}>›</Text>
            </Pressable>
            {/* Gear */}
            <Pressable
              style={({ pressed }) => [styles.profileMenuItem, pressed && { opacity: 0.72 }]}
              onPress={() => setShowGearScreen(true)}
              testID="profile-gear-open"
              accessibilityLabel="profile-gear-open"
              accessibilityRole="button">
              <View style={[styles.profileRowIcon, { backgroundColor: themeColors.primary + '22' }]}>
                <Ionicons name="walk-outline" size={18} color={themeColors.primary} />
              </View>
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text style={[styles.profileMenuLabel, { color: themeColors.textPrimary }]}>Gear Tracker</Text>
                <Text style={{ fontSize: 11, color: themeColors.textMuted }}>Track mileage on shoes, bikes & equipment</Text>
              </View>
              <Text style={[styles.profileMenuChevron, { color: themeColors.textMuted }]}>›</Text>
            </Pressable>
          </View>
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
          const nextEquipment = exerciseEquipmentLabel(next) ?? next.equipment ?? null;
          const patch = (prev: any) => ({
            ...prev,
            name: next.name,
            equipment: nextEquipment ?? prev.equipment,
            muscles_targeted: [next.primary_muscle, ...(next.secondary_muscles ?? [])].filter(Boolean),
            primary_muscle: next.primary_muscle,
            video_id: next.video_id ?? prev.video_id,
            image_url: next.image_url ?? prev.image_url,
            _slug: next.slug ?? prev._slug,
            _primary_muscle: next.primary_muscle ?? prev._primary_muscle,
            _secondary_muscles: next.secondary_muscles ?? prev._secondary_muscles,
          });
          try {
            let patchedActiveWeek = false;
            // Primary path: planWeek is the source of truth for the DayCard
            // render. Match by day_date (stable, unique) instead of focus
            // (can duplicate across the week — e.g. two Push days).
            if (planWeek?.days?.length) {
              const pw = JSON.parse(JSON.stringify(planWeek));
              const dayIdx = pw.days.findIndex((d: any) => d.day_date === target.dayKey);
              if (dayIdx >= 0) {
                const exs = pw.days[dayIdx]?.workout?.exercises;
                if (Array.isArray(exs) && target.exerciseIndex < exs.length) {
                  exs[target.exerciseIndex] = patch(exs[target.exerciseIndex]);
                  if (authToken) {
                    try {
                      const { patchPlanDayWorkout } = await import('../services/api');
                      const savedDay = await patchPlanDayWorkout(authToken, target.dayKey, pw.days[dayIdx].workout);
                      pw.days[dayIdx] = savedDay;
                    } catch (e) {
                      console.warn('[plan-swap] backend patch failed:', e);
                      Alert.alert('Swap not saved', 'Could not update this plan day right now. Please try again.');
                      return;
                    }
                  }
                  setPlanWeek(pw);
                  planWeekRef.current = pw;
                  patchedActiveWeek = true;
                }
              }
            }
            // Legacy fallback: workoutPlan (used when planWeek is null)
            const raw = patchedActiveWeek ? null : await AsyncStorage.getItem('aiWorkoutPlan');
            if (raw) {
              const plan = JSON.parse(raw);
              if (plan && Array.isArray(plan.days)) {
                const dayIdx = plan.days.findIndex((d: any) => d?.focus === target.workout.focus);
                if (dayIdx >= 0 && Array.isArray(plan.days[dayIdx]?.exercises)) {
                  const exs = plan.days[dayIdx].exercises;
                  if (target.exerciseIndex < exs.length) {
                    exs[target.exerciseIndex] = patch(exs[target.exerciseIndex]);
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
        authToken={userProfile.subscriptionTier === 'pro' ? authToken : null}
        onSave={async (session) => {
          const { saveWorkoutSession, dateKey: dk } = await import('../utils/workoutHistory');
          await saveWorkoutSession(session);
          const sessionDate = dk(new Date(session.date));
          try {
            const [freshHistory, freshSummaries] = await Promise.all([
              loadWorkoutHistory(),
              loadWorkoutSummaries(),
            ]);
            setWorkoutHistoryList(freshHistory);
            setWorkoutHistorySummaries(freshSummaries);
          } catch { /* non-fatal; persisted history will hydrate on next load */ }
          if (sessionDate === dk(new Date())) {
            import('../utils/workoutReminders')
              .then(({ cancelTodayWorkoutReminder }) => cancelTodayWorkoutReminder())
              .catch(() => undefined);
          }
          if (authToken) {
            try {
              const { logWorkoutDone } = await import('../services/api');
              await logWorkoutDone(
                authToken,
                sessionDate,
                session.focus,
                session.durationSeconds,
                undefined,
                session.manualActivity ? {
                  category: session.manualActivity.category,
                  subtype: session.manualActivity.subtype,
                  intensity: session.manualActivity.intensity,
                  source: session.manualActivity.source,
                  cardioStyle: session.manualActivity.cardioStyle,
                  distanceMiles: session.manualActivity.distanceMiles,
                  caloriesBurned: session.manualActivity.caloriesBurned,
                  avgHeartRate: session.manualActivity.avgHeartRate,
                } : undefined,
                undefined,
                undefined,
                undefined,
                {
                  startedAt: session.startedAt ?? session.date,
                  endedAt: session.endedAt ?? null,
                  externalSourceId: session.id,
                },
              );
              await refreshNutritionAfterActivity(sessionDate);
            } catch {}
          }
          import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
        }}
      />

      {/* Live tracker — open-ended run/ride/hike/yoga timer with HR
          polling. Saves via LogActivityModal on Finish so the session
          flows through the same fatigue + history path as any other
          manual activity. */}
      {/* Workout template builder — modal flow for composing a saved
          workout ahead of time (pick exercises, set reps/sets/rest, save).
          Distinct from the active-workout "Save Template" button which
          only fires post-completion. */}
      <WorkoutTemplateBuilderModal
        visible={templateBuilderOpen}
        themeName={userProfile.themePreference}
        authToken={userProfile.subscriptionTier === 'pro' ? authToken : null}
        editTarget={templateBuilderTarget}
        onClose={() => {
          setTemplateBuilderOpen(false);
          setTemplateBuilderTarget(null);
        }}
        onSaved={async () => {
          const next = await loadWorkoutTemplates();
          setWorkoutTemplates(next);
        }}
      />

      <LiveActivityTracker
        visible={showLiveTracker}
        initialActivity={liveTrackerInitialActivity}
        onClose={() => {
          setShowLiveTracker(false);
          setLiveTrackerInitialActivity(null);
        }}
        themeName={userProfile.themePreference}
        enableHealthKit={!isFreeTier}
        onSave={async (session) => {
          await saveWorkoutSession(session);
          const sessionDate = dateKey(new Date(session.date));
          if (sessionDate === dateKey(new Date())) {
            import('../utils/workoutReminders')
              .then(({ cancelTodayWorkoutReminder }) => cancelTodayWorkoutReminder())
              .catch(() => undefined);
          }
          if (authToken) {
            try {
              await logWorkoutDone(
                authToken,
                sessionDate,
                session.focus,
                session.durationSeconds,
                undefined,
                session.manualActivity ? {
                  category: session.manualActivity.category,
                  subtype: session.manualActivity.subtype,
                  intensity: session.manualActivity.intensity,
                  source: session.manualActivity.source,
                  cardioStyle: session.manualActivity.cardioStyle,
                  distanceMiles: session.manualActivity.distanceMiles,
                  caloriesBurned: session.manualActivity.caloriesBurned,
                  avgHeartRate: session.manualActivity.avgHeartRate,
                } : undefined,
                undefined,
                undefined,
                undefined,
                {
                  startedAt: session.startedAt ?? session.date,
                  endedAt: session.endedAt ?? null,
                  externalSourceId: session.id,
                },
              );
              await refreshNutritionAfterActivity(sessionDate);
            } catch {}
          }
        }}
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
            _source_context: 'custom_strength',
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
                        const consumedAt = defaultConsumedAtForDate(dateKey);
                        const logged = await logSavedMeal(authToken, sm.id, {
                          meal_date: dateKey,
                          meal_type: mt,
                          consumed_at: consumedAt,
                        });
                        await mirrorLoggedSavedMealToDay(dateKey, sm, logged.meal_id, consumedAt);
                        loadDayStatus();
                        if (userProfile) loadPlans(userProfile);
                        reloadSavedMeals();
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
      {editingMeal && (() => {
        const modalNutritionPlan = nutritionPlansByDate[editingMeal.dateKey]
          ?? (editingMeal.historyMealId
            ? { meals: [], removedMealIds: [], targets: { calories: 0, protein: 0, carbs: 0, fat: 0 } } as DailyNutritionPlan
            : null);
        if (!modalNutritionPlan) return null;
        return (
        <MealEditModal
          visible={!!editingMeal}
          mealType={editingMeal.type}
          meal={editingMeal.meal}
          dateKey={editingMeal.dateKey}
          themeName={userProfile.themePreference}
          nutritionPlan={modalNutritionPlan}
          allFoods={allFoodsWithCustom}
          foodCategories={userFoodCategories}
          savedMeals={userProfile.savedMeals ?? []}
          authToken={authToken}
          cookingSkill={userProfile.cookingSkill}
          prepTimeMinutes={userProfile.prepTimeMinutes}
          dietaryPreference={userProfile.dietaryPreference}
          allergies={userProfile.allergies}
          onSave={(updated) => {
            if (editingMeal.historyMealId) {
              handleHistoryMealSave(editingMeal.dateKey, editingMeal.type, editingMeal.historyMealId, updated);
            } else {
              handleMealSave(editingMeal.dateKey, editingMeal.type, updated);
            }
          }}
          onSaveRoutine={editingMeal.historyMealId ? undefined : ((updated, scope) =>
            handleMealSave(editingMeal.dateKey, editingMeal.type, updated, { routineScope: scope })
          )}
          onClose={() => setEditingMeal(null)}
          onToggleRoutine={editingMeal.historyMealId ? undefined : (() => handleToggleRoutine(editingMeal.dateKey, editingMeal.type))}
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
                food_id: it.food_id ?? libMatch?.id ?? libMatch?.food_id ?? null,
                serving_id: it.serving_id ?? null,
                serving_grams: it.serving_grams ?? null,
                quantity: Number(it.quantity || it.qty || 1),
                unit: String(it.unit || 'serving'),
                calories: Number(it.calories || 0),
                protein_g: Number(it.protein_g ?? it.protein ?? 0),
                carbs_g: Number(it.carbs_g ?? it.carbs ?? 0),
                fat_g: Number(it.fat_g ?? it.fat ?? 0),
                ...(it.micronutrients ? { micronutrients: it.micronutrients } : {}),
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
            //  2. Is marked as a kitchen food for planning/search,
            //  3. Gets persisted to AsyncStorage, and
            //  4. Syncs to the backend via `pushUserStateToBackend` so it
            //     survives sign-out / cross-device.
            const existing = userProfile?.customFoods ?? [];
            const customExists = existing.some(f => f.name.toLowerCase() === item.name.toLowerCase());
            const nextCustomFoods = customExists ? existing : [...existing, item];
            const existingKitchen = userProfile?.foodsAvailable ?? [];
            const kitchenExists = existingKitchen.some(name => name.toLowerCase() === item.name.toLowerCase());
            const nextFoodsAvailable = kitchenExists ? existingKitchen : [...existingKitchen, item.name];
            if (customExists && kitchenExists) return;
            onProfileUpdate?.({
              customFoods: nextCustomFoods,
              foodsAvailable: nextFoodsAvailable,
            } as any, true); // skipRegen
          }}
        />
        );
      })()}

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
                food_id: it.food_id ?? null,
                serving_id: it.serving_id ?? null,
                serving_grams: it.serving_grams ?? null,
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
          No more Modal portal; the workout Library is now exercise-only.
          A thin back header appears when the user drills into a specific
          exercise detail. */}
      {showExerciseLibrary && renderedWorkoutSubTab === 'library' && (
        <View style={[styles.libraryInlineWrap, { top: insets.top + 70 + 52, backgroundColor: themeColors.background }]}>
          <View style={[styles.librarySheet, { backgroundColor: themeColors.surface }]}>

            {/* Back header — only when drilled into a detail view. */}
            {selectedExercise && (
              <View style={styles.libraryHeader}>
                <TouchableOpacity onPress={() => setSelectedExercise(null)}>
                  <Text style={[styles.libraryClose, { color: themeColors.primary }]}>← Back</Text>
                </TouchableOpacity>
                <Text style={[styles.libraryTitle, { color: themeColors.textPrimary, marginLeft: 12, flex: 1 }]}>
                  {selectedExercise.name}
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
                        <Text style={[styles.detailMeta, { color: workoutPalette.text }]}>
                          Primary: {humanizeToken(selectedExercise.primary_muscle)}
                        </Text>
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

                      {/* How To Do It — single collapsible covering the
                          three previously-separate sections (How To
                          Perform It / Setup / Movement Cue) which were
                          three slices of the same idea. Default-expanded
                          because this is the primary "what do I do" surface. */}
                      <CollapsibleSection
                        title="How To Do It"
                        defaultExpanded
                        surfaceColor={themeColors.surfaceRaised}
                        borderColor={themeColors.border}
                        textPrimary={themeColors.textPrimary}
                        textMuted={themeColors.textMuted}
                        accentColor={workoutPalette.strong}
                      >
                        <Text style={{ fontSize: 11, fontWeight: '800', color: workoutPalette.strong, letterSpacing: 0.6, marginBottom: 4 }}>
                          OVERVIEW
                        </Text>
                        <Text style={[styles.detailSectionText, { color: themeColors.textSecondary }]}>
                          {guide.howTo}
                        </Text>
                        <Text style={{ fontSize: 11, fontWeight: '800', color: workoutPalette.strong, letterSpacing: 0.6, marginTop: 12, marginBottom: 4 }}>
                          SETUP
                        </Text>
                        <Text style={[styles.detailSectionText, { color: themeColors.textSecondary }]}>
                          {guide.setup}
                        </Text>
                        <Text style={{ fontSize: 11, fontWeight: '800', color: workoutPalette.strong, letterSpacing: 0.6, marginTop: 12, marginBottom: 4 }}>
                          MOVEMENT CUE
                        </Text>
                        <Text style={[styles.detailSectionText, { color: themeColors.textSecondary }]}>
                          {guide.movement}
                        </Text>
                      </CollapsibleSection>

                      {/* Phase breakdown stays prominent: strength uses
                          lifting/lowering, cardio uses work/recovery or
                          pace/control. */}
                      <View style={[styles.detailPhaseBlock, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]}>
                        <Text style={[styles.detailPhaseTitle, { color: themeColors.textPrimary }]}>{guide.phaseTitle}</Text>
                        <View style={styles.detailPhaseRow}>
                          <View style={[styles.detailPhaseBadge, { backgroundColor: workoutPalette.strong + '22' }]}>
                            <Text style={[styles.detailPhaseBadgeLabel, { color: workoutPalette.strong }]}>{guide.primaryPhaseLabel}</Text>
                          </View>
                          <Text style={[styles.detailPhaseText, { color: themeColors.textSecondary }]}>{guide.concentric}</Text>
                        </View>
                        <View style={[styles.detailPhaseDivider, { backgroundColor: themeColors.border }]} />
                        <View style={styles.detailPhaseRow}>
                          <View style={[styles.detailPhaseBadge, { backgroundColor: mealPalette.strong + '22' }]}>
                            <Text style={[styles.detailPhaseBadgeLabel, { color: mealPalette.strong }]}>{guide.secondaryPhaseLabel}</Text>
                          </View>
                          <Text style={[styles.detailPhaseText, { color: themeColors.textSecondary }]}>{guide.eccentric}</Text>
                        </View>
                      </View>

                      <CollapsibleSection
                        title="What It Hits & Why"
                        surfaceColor={themeColors.surfaceRaised}
                        borderColor={themeColors.border}
                        textPrimary={themeColors.textPrimary}
                        textMuted={themeColors.textMuted}
                      >
                        <Text style={[styles.detailSectionText, { color: themeColors.textSecondary }]}>{guide.hits}</Text>
                        <Text style={[styles.detailSectionText, { color: themeColors.textSecondary, marginTop: 6 }]}>{guide.why}</Text>
                      </CollapsibleSection>

                      <CollapsibleSection
                        title="How It Should Feel"
                        surfaceColor={themeColors.surfaceRaised}
                        borderColor={themeColors.border}
                        textPrimary={themeColors.textPrimary}
                        textMuted={themeColors.textMuted}
                      >
                        <Text style={[styles.detailSectionText, { color: themeColors.textSecondary }]}>{guide.feel}</Text>
                      </CollapsibleSection>

                      <CollapsibleSection
                        title="Common Mistake"
                        titleColor={themeColors.error ?? '#FF4444'}
                        surfaceColor={themeColors.surfaceRaised}
                        borderColor={themeColors.border}
                        textPrimary={themeColors.textPrimary}
                        textMuted={themeColors.textMuted}
                      >
                        <Text style={[styles.detailSectionText, { color: themeColors.textSecondary }]}>{guide.mistake}</Text>
                      </CollapsibleSection>
                    </>
                  );
                })()}
              </ScrollView>

            /* ── EXERCISES LIST ──────────────────────────────────────────────── */
            ) : (
              exerciseLibraryLoading ? (
                <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />
              ) : (
                <FlatList
                  style={styles.libraryVirtualList}
                  contentContainerStyle={styles.libraryList}
                  data={filteredExerciseLibrary}
                  keyExtractor={exerciseLibraryKeyExtractor}
                  renderItem={renderExerciseLibraryItem}
                  keyboardShouldPersistTaps="handled"
                  initialNumToRender={14}
                  maxToRenderPerBatch={10}
                  windowSize={7}
                  removeClippedSubviews={Platform.OS !== 'web'}
                  ListHeaderComponent={(
                    <>
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
                              ? <ActivityIndicator size="small" color={getContrastingTextColor(workoutPalette.strong)} />
                              : <Text style={{ color: getContrastingTextColor(workoutPalette.strong), fontWeight: '700', fontSize: 13 }}>AI Search</Text>}
                          </TouchableOpacity>
                        )}
                      </View>

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
                                  {ex.primary_muscle} · {ex.equipment} · {ex.sets}x{ex.reps}
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
                                  <Text style={{ color: alreadySaved ? themeColors.textMuted : getContrastingTextColor(workoutPalette.strong), fontWeight: '700', fontSize: 13 }}>
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
                          accessibilityRole="button"
                          accessibilityLabel="Show all muscle filters"
                          style={[styles.libraryFilterChip, exerciseMuscleFilter === 'all' && styles.libraryFilterChipActive]}
                          onPress={() => setExerciseMuscleFilter('all')}>
                          <Text style={[styles.libraryFilterText, exerciseMuscleFilter === 'all' && styles.libraryFilterTextActive]}>All Muscles</Text>
                        </TouchableOpacity>
                        {exerciseMuscleOptions.map((muscle) => (
                          <TouchableOpacity
                            key={muscle}
                            accessibilityRole="button"
                            accessibilityLabel={`Filter exercises by ${humanizeToken(muscle)}`}
                            style={[styles.libraryFilterChip, exerciseMuscleFilter === muscle && styles.libraryFilterChipActive]}
                            onPress={() => setExerciseMuscleFilter(muscle)}>
                            <Text style={[styles.libraryFilterText, exerciseMuscleFilter === muscle && styles.libraryFilterTextActive]}>{humanizeToken(muscle)}</Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>

                      <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast" contentContainerStyle={styles.libraryFilterRow}>
                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityLabel="Show all equipment filters"
                          style={[styles.libraryFilterChip, exerciseEquipmentFilter === 'all' && styles.libraryFilterChipActive]}
                          onPress={() => setExerciseEquipmentFilter('all')}>
                          <Text style={[styles.libraryFilterText, exerciseEquipmentFilter === 'all' && styles.libraryFilterTextActive]}>All Equipment</Text>
                        </TouchableOpacity>
                        {exerciseEquipmentOptions.map((equipment) => (
                          <TouchableOpacity
                            key={equipment}
                            accessibilityRole="button"
                            accessibilityLabel={`Filter exercises by ${humanizeToken(equipment)}`}
                            style={[styles.libraryFilterChip, exerciseEquipmentFilter === equipment && styles.libraryFilterChipActive]}
                            onPress={() => setExerciseEquipmentFilter(equipment)}>
                            <Text style={[styles.libraryFilterText, exerciseEquipmentFilter === equipment && styles.libraryFilterTextActive]}>{humanizeToken(equipment)}</Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>

                      <View style={styles.libraryResultRow}>
                        <Text style={[styles.libraryResultText, { color: themeColors.textMuted }]}>
                          {filteredExerciseLibrary.length} result{filteredExerciseLibrary.length === 1 ? '' : 's'}
                          {exerciseMuscleFilter !== 'all' ? ` · ${humanizeToken(exerciseMuscleFilter)}` : ''}
                          {exerciseEquipmentFilter !== 'all' ? ` · ${humanizeToken(exerciseEquipmentFilter)}` : ''}
                        </Text>
                        {(exerciseSearch || exerciseMuscleFilter !== 'all' || exerciseEquipmentFilter !== 'all') && (
                          <TouchableOpacity
                            accessibilityRole="button"
                            accessibilityLabel="Clear exercise search and filters"
                            onPress={() => {
                              setExerciseSearch('');
                              setExerciseMuscleFilter('all');
                              setExerciseEquipmentFilter('all');
                              setAiExerciseResults([]);
                            }}>
                            <Text style={[styles.libraryResultClear, { color: workoutPalette.strong }]}>Clear</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </>
                  )}
                  ListEmptyComponent={(
                    <Text style={[styles.libraryEmptyText, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border, color: themeColors.textMuted }]}>No exercises match the current search and filters.</Text>
                  )}
                />
              )
            )}
          </View>
        </View>
      )}

      <Modal visible={showInjuryCheckin} transparent animationType="slide" onRequestClose={handleInjuryCheckinDismiss}>
        <View style={styles.noteModalBackdrop}>
          <View style={[styles.noteModalSheet, { backgroundColor: themeColors.surface, borderTopColor: '#F59E0B66' }]}>
            <View style={styles.noteModalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="bandage-outline" size={22} color="#F59E0B" />
                <View>
                  <Text style={[styles.noteModalTitle, { color: themeColors.textPrimary }]}>Injury check-in</Text>
                  <Text style={[styles.noteModalSubtitle, { color: themeColors.textMuted }]}>
                    {injuryCheckinTargets.length} active limitation{injuryCheckinTargets.length === 1 ? '' : 's'}
                  </Text>
                </View>
              </View>
              <TouchableOpacity onPress={handleInjuryCheckinDismiss} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={themeColors.textSecondary} />
              </TouchableOpacity>
            </View>
            <View style={{ paddingHorizontal: 16, paddingBottom: 18 }}>
              <Text style={{ fontSize: 13, color: themeColors.textSecondary, lineHeight: 19, marginBottom: 12 }}>
                Should your plan keep protecting {injuryCheckinTargets.length === 1 ? 'this area' : 'these areas'}?
              </Text>
              {injuryCheckinTargets.map(inj => (
                <View
                  key={inj.id}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: themeColors.border }}>
                  <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: inj.status === 'active' ? '#EF4444' : '#F59E0B' }} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: themeColors.textPrimary }} numberOfLines={1}>
                      {inj.bodyPart || inj.description}
                    </Text>
                    <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 1 }} numberOfLines={1}>
                      {inj.severity ? `${inj.severity} · ` : ''}{inj.estimatedRecoveryDate ? `est. ${inj.estimatedRecoveryDate}` : inj.status}
                    </Text>
                  </View>
                </View>
              ))}
              <View style={{ gap: 10, marginTop: 16 }}>
                <TouchableOpacity
                  disabled={injuryCheckinSaving}
                  onPress={() => handleInjuryCheckinResponse('keep_protected')}
                  style={{ backgroundColor: '#F59E0B', borderRadius: 12, paddingVertical: 13, alignItems: 'center', opacity: injuryCheckinSaving ? 0.6 : 1 }}
                  activeOpacity={0.85}>
                  <Text style={{ fontSize: 14, fontWeight: '800', color: '#111827' }}>Still hurts, keep protecting</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  disabled={injuryCheckinSaving}
                  onPress={() => handleInjuryCheckinResponse('improving')}
                  style={{ backgroundColor: themeColors.surfaceRaised, borderRadius: 12, paddingVertical: 13, alignItems: 'center', borderWidth: 1, borderColor: themeColors.border, opacity: injuryCheckinSaving ? 0.6 : 1 }}
                  activeOpacity={0.85}>
                  <Text style={{ fontSize: 14, fontWeight: '800', color: themeColors.textPrimary }}>Improving, still protect it</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  disabled={injuryCheckinSaving}
                  onPress={() => handleInjuryCheckinResponse('resolved')}
                  style={{ backgroundColor: themeColors.surfaceRaised, borderRadius: 12, paddingVertical: 13, alignItems: 'center', borderWidth: 1, borderColor: themeColors.border, opacity: injuryCheckinSaving ? 0.6 : 1 }}
                  activeOpacity={0.85}>
                  <Text style={{ fontSize: 14, fontWeight: '800', color: themeColors.textPrimary }}>Resolved, stop protecting</Text>
                </TouchableOpacity>
              </View>
            </View>
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

            {/* AI disclaimer — verbatim language from LEGAL_SECTIONS so
                what users accepted at signup is what they see at the
                surface where AI is actually doing the work. Especially
                important for nutrition / training advice where wrong
                output can compound. */}
            <Text style={{
              fontSize: 11, color: themeColors.textMuted, fontStyle: 'italic',
              paddingHorizontal: 16, paddingBottom: 6, lineHeight: 15,
            }}>
              AI replies can be wrong — review before acting on them. Not medical advice; consult a clinician for injury, illness, or significant changes.
            </Text>

            {/* Single unified chat */}

            {workoutUpdateSummary && (
              <View style={[styles.trainerSummaryCard, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]}>
                <Text style={[styles.trainerSummaryTitle, { color: themeColors.primary }]}>Settings Updated</Text>
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
                        Ask me anything about workouts, nutrition, injuries, or goals. I can suggest safe settings changes and guide current-week edits.
                      </Text>
                      <View style={{ gap: 4, marginTop: 4 }}>
                        {[
                          { icon: 'swap-horizontal-outline', text: '"What can replace bench press?"' },
                          { icon: 'nutrition-outline', text: '"Suggest lower sugar breakfast options"' },
                          { icon: 'bandage-outline', text: '"My knee hurts when squatting"' },
                          { icon: 'airplane-outline', text: '"Pause my workouts for 5 days of travel"' },
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
                    {visibleChat.map((m, idx) => {
                      const fullIndex = hiddenCount + idx;
                      const fieldLines = summarizeApplyFields(m.applyResult?.changed_fields);
                      return (
                      <View key={fullIndex} style={[styles.trainerBubble, m.role === 'user' ? [styles.trainerBubbleUser, { backgroundColor: themeColors.primary, borderColor: themeColors.primary }] : [styles.trainerBubbleAssistant, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border }]]}>
                        <Text style={[styles.trainerBubbleText, { color: m.role === 'user' ? getContrastingTextColor(themeColors.primary) : themeColors.textPrimary }]}>{m.content}</Text>
                        {m.role === 'assistant' && m.applyResult && (
                          <View style={[styles.coachActionResultCard, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                              <Ionicons
                                name={m.applyResult.applied ? 'checkmark-circle-outline' : 'information-circle-outline'}
                                size={15}
                                color={m.applyResult.applied ? themeColors.success : themeColors.textSecondary}
                              />
                              <Text style={[styles.coachActionResultTitle, { color: themeColors.textPrimary }]}>
                                {m.applyResult.applied ? 'Applied change' : 'Acknowledged'}
                              </Text>
                            </View>
                            <Text style={[styles.coachActionResultSummary, { color: themeColors.textSecondary }]}>
                              {m.applyResult.summary}
                            </Text>
                            {fieldLines.length > 0 && fieldLines.map(line => (
                              <Text key={line} style={[styles.coachActionResultMeta, { color: themeColors.textMuted }]}>
                                {line}
                              </Text>
                            ))}
                            {m.undoAction && authToken && (
                              <TouchableOpacity
                                accessibilityRole="button"
                                accessibilityLabel="Undo coach change"
                                onPress={async () => {
                                  try {
                                    const { applyRecommendationAction } = await import('../services/api');
                                    const undo = await applyRecommendationAction(authToken, m.undoAction!, `undo_${m.intent ?? 'coach_action'}`);
                                    if (coachApplyNeedsDayStatusRefresh(undo.changed_fields)) {
                                      await loadDayStatus();
                                    }
                                    setWorkoutChat(prev => prev.map((x, i) => i === fullIndex ? {
                                      ...x,
                                      undoAction: null,
                                      applyResult: undo,
                                    } : x));
                                  } catch (e: any) {
                                    Alert.alert('Could not undo', e?.message ?? 'Try again.');
                                  }
                                }}
                                style={[styles.coachActionUndoBtn, { borderColor: themeColors.border, backgroundColor: themeColors.surfaceRaised }]}>
                                <Ionicons name="arrow-undo-outline" size={13} color={themeColors.textSecondary} />
                                <Text style={[styles.coachActionUndoText, { color: themeColors.textSecondary }]}>Undo</Text>
                              </TouchableOpacity>
                            )}
                          </View>
                        )}
                        {/* Quick-intent action — when the assistant
                            response carries a structured action, show
                            an "Apply" pill that routes through the
                            same durable-state path the weekly review
                            card uses. Hidden after accept. */}
                        {m.role === 'assistant' && m.action && !m.applied && m.action.type !== 'noop' && authToken && (
                          <View style={{ flexDirection: 'row', gap: 6, marginTop: 8 }}>
                            <TouchableOpacity
                              accessibilityRole="button"
                              accessibilityLabel="Apply coach recommendation"
                              onPress={async () => {
                                try {
                                  const { applyRecommendationAction } = await import('../services/api');
                                  const r = await applyRecommendationAction(authToken, m.action!, m.intent ?? undefined);
                                  if (coachApplyNeedsDayStatusRefresh(r.changed_fields)) {
                                    await loadDayStatus();
                                  }
                                  setWorkoutChat(prev => prev.map((x, i) => i === fullIndex ? {
                                    ...x,
                                    applied: true,
                                    applyResult: r,
                                    undoAction: r.undo_action ?? null,
                                  } : x));
                                } catch (e: any) {
                                  Alert.alert('Could not apply', e?.message ?? 'Try again.');
                                }
                              }}
                              style={{
                                paddingHorizontal: 10, paddingVertical: 5,
                                borderRadius: 8,
                                backgroundColor: themeColors.primary,
                              }}>
                              <Text style={{ fontSize: 11, fontWeight: '800', color: getContrastingTextColor(themeColors.primary) }}>
                                Apply
                              </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              accessibilityRole="button"
                              accessibilityLabel="Dismiss coach recommendation"
                              onPress={() => {
                                setWorkoutChat(prev => prev.map((x, i) => i === fullIndex ? { ...x, applied: true } : x));
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
                      );
                    })}
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
                  <Text style={{ fontSize: 13, fontWeight: '800', color: themeColors.textPrimary, marginBottom: 6 }}>Proposed Settings</Text>
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
                      <Text style={{ fontSize: 13, fontWeight: '800', color: getContrastingTextColor(themeColors.primary) }}>Apply</Text>
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
                    Current and future plans can stay injury-aware; stop anything painful.
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                    <TouchableOpacity
                      onPress={async () => {
                        try {
                          const profileRaw = await AsyncStorage.getItem('userProfile');
                          const storedProfile: UserProfile | null = profileRaw
                            ? JSON.parse(profileRaw)
                            : userProfile;
                          if (storedProfile) {
                            const existing = storedProfile.injuryEntries ?? [];
                            const merged = [...existing];
                            for (const entry of pendingInjuries) {
                              const idx = merged.findIndex(e => e.id === entry.id);
                              if (idx >= 0) merged[idx] = entry;
                              else merged.push(entry);
                            }
                            const updatedProfile = { ...storedProfile, injuryEntries: merged };
                            if (onSaveProfile) {
                              onSaveProfile(updatedProfile, 'workout');
                            } else {
                              await AsyncStorage.setItem('userProfile', JSON.stringify(updatedProfile));
                              onProfileUpdate?.({ injuryEntries: merged }, true);
                            }
                          }
                        } catch (e) { console.error('[injury apply] failed:', e); }
                        setPendingInjuries(null);
                        setWorkoutChat(prev => [...prev, { role: 'assistant', content: 'Injury logged. Review the save confirmation to update the current week or keep it for the next plan.' }]);
                        setTimeout(() => {
                          setShowTrainerModal(false);
                          setWorkoutChat([]); setWorkoutChat([]);
                          setPendingUpdate(null); setPendingInjuries(null);
                          setWorkoutUpdateSummary(null); setNutritionUpdateSummary(null);
                        }, 1500);
                      }}
                      style={{ flex: 1, backgroundColor: themeColors.primary, borderRadius: 8, paddingVertical: 10, alignItems: 'center' }}>
                      <Text style={{ fontSize: 13, fontWeight: '800', color: getContrastingTextColor(themeColors.primary) }}>Add Injury</Text>
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
                testID="ai-coach-input"
                value={trainerInput}
                onChangeText={setTrainerInput}
                placeholder={coachMode === 'nutritionist' ? 'Ask nutritionist...' : 'Ask trainer...'}
                placeholderTextColor={themeColors.textMuted}
                style={[styles.trainerInput, { backgroundColor: themeColors.surfaceRaised, borderColor: themeColors.border, color: themeColors.textPrimary }]}
                multiline
              />
              <TouchableOpacity
                testID="ai-coach-send"
                accessibilityLabel="ai-coach-send"
                style={[styles.trainerSendBtn, { backgroundColor: trainerLoading ? themeColors.error : themeColors.primary }]}
                onPress={trainerLoading ? () => {
                  trainerAbortRef.current?.abort();
                  setTrainerLoading(false);
                  setWorkoutChat(prev => [...prev, { role: 'assistant', content: 'Request cancelled.' }]);
                } : handleAskTrainer}>
                <Text style={[styles.trainerSendText, { color: getContrastingTextColor(trainerLoading ? themeColors.error : themeColors.primary) }]}>
                  {trainerLoading ? 'Cancel' : 'Send'}
                </Text>
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
                  <Text style={[styles.skipReasonConfirmText, { color: getContrastingTextColor(skipType === 'drop' ? themeColors.warning : workoutPalette.strong) }]}>
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
                      // Batched save — calling handleToggleMeal in a loop
                      // captured stale `checkedMealsByDate` between iterations,
                      // so each call overwrote the previous state update and
                      // only the LAST chosen meal stuck. Build the full merged
                      // checks map once, then save it in a single pass.
                      const chosenItems = snapshot.items.filter(it => snapshot.chosen[it.mealType]);
                      const current = checkedMealsByDate[snapshot.date] ?? {};
                      const next: Record<string, boolean> = { ...current };
                      for (const it of chosenItems) next[it.mealType] = true;

                      setCheckedMealsByDate(prev => ({ ...prev, [snapshot.date]: next }));
                      await saveMealChecks(snapshot.date, next);
                      await persistDayState(snapshot.date, { meal_checks: next });

                      // Snapshot each chosen meal + log to backend history.
                      // Independent of the checks update, so a per-meal failure
                      // here doesn't lose the check state.
                      const plan = nutritionPlansByDate[snapshot.date];
                      for (const it of chosenItems) {
                        const idx = it.mealType.startsWith('meal_') ? parseInt(it.mealType.slice(5), 10) : -1;
                        const meal = idx >= 0 ? (plan?.meals ?? [])[idx] : undefined;
                        if (!meal) continue;
                        const isRoutineBacked = !!(meal as any)._routineId;
                        if (!isRoutineBacked) {
                          await savePreservedMeal(snapshot.date, it.mealType, meal).catch(() => {});
                        }
                        if (authToken) {
                          logMealChecked(authToken, {
                            meal_date: snapshot.date,
                            meal_type: it.mealType,
                            meal: meal as Record<string, any>,
                            source: 'plan_check',
                            consumed_at: consumedAtForMealDate(meal, snapshot.date),
                          })
                            .then(() => setMealLogRefreshKey(k => k + 1))
                            .catch(err => console.log('[logMealChecked] background save failed:', err.message));
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
                const { listFriends, listSocialNotifications } = await import('../services/api');
                const [list, notifications] = await Promise.all([
                  listFriends(authToken),
                  listSocialNotifications(authToken),
                ]);
                setFriendCount(list.friends.length);
                setPendingFriendCount(list.pending.filter(p => p.direction === 'incoming').length);
                setSocialUnreadCount(notifications.unread_count);
              } catch { /* silent */ }
            })();
          }
        }}
        themeName={userProfile.themePreference}
        onSocialCountsChange={({ friends, pending, unread }) => {
          setFriendCount(friends);
          setPendingFriendCount(pending);
          setSocialUnreadCount(unread);
        }}
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

      {/* Gear tracker */}
      <Modal
        visible={showGearScreen}
        animationType="slide"
        onRequestClose={() => setShowGearScreen(false)}>
        {showGearScreen && authToken && (
          <GearScreen
	            authToken={authToken}
	            themeName={userProfile.themePreference}
	            distanceUnit={distanceUnit}
	            onBack={() => setShowGearScreen(false)}
          />
        )}
      </Modal>

      {/* Settings — Theme, Reminders, Feedback & Device, Account */}
      <Modal
        visible={showSettings}
        animationType="slide"
        onRequestClose={() => setShowSettings(false)}>
        {showSettings && userProfile && (() => {
          type ThemeEntry = {
            key: import('../types').AppThemeName;
            label: string;
            swatch: string;
            background: string;
            surface: string;
            accent: string;
            border: string;
            mode: 'dark' | 'light';
          };
          const allThemes: ThemeEntry[] = THEME_PICKER_ORDER.map((key) => {
            const theme = APP_THEMES[key];
            return {
              key,
              label: theme.label,
              swatch: theme.colors.primary,
              background: theme.colors.background,
              surface: theme.colors.surfaceRaised,
              accent: theme.colors.accent,
              border: theme.colors.border,
              mode: isLightThemeName(key) ? 'light' : 'dark',
            };
          });
          const visibleThemes = showAllThemes ? allThemes : allThemes.slice(0, 8);
          const darkThemes = visibleThemes.filter(t => t.mode === 'dark');
          const lightThemes = visibleThemes.filter(t => t.mode === 'light');
          const currentTheme = resolveThemeName(userProfile.themePreference);
          return (
            <View testID="settings-screen" style={{ flex: 1, backgroundColor: themeColors.background }}>
              {/* Header */}
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: insets.top + 12, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: themeColors.border }}>
                <TouchableOpacity
                  onPress={() => setShowSettings(false)}
                  testID="settings-back"
                  accessibilityLabel="settings-back"
                  style={{ marginRight: 12 }}>
                  <Ionicons name="chevron-back" size={24} color={themeColors.textPrimary} />
                </TouchableOpacity>
                <Text style={{ fontSize: 20, fontWeight: '700', color: themeColors.textPrimary, flex: 1 }}>Settings</Text>
              </View>
              <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}>

                {/* Theme picker */}
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
                            testID={`settings-theme-${e2eId(t.key)}`}
                            accessibilityLabel={`settings-theme-${e2eId(t.key)}`}
                            style={[
                              styles.profileThemeTile,
                              { backgroundColor: themeColors.surface, borderColor: isActive ? t.swatch : themeColors.border, borderWidth: isActive ? 2 : 1 },
                            ]}
                            onPress={() => onProfileUpdate?.({ themePreference: t.key } as any, true)}
                            activeOpacity={0.8}>
                            <View style={[styles.profileThemeSwatch, { borderColor: t.border }]}>
                              <View style={{ flex: 1, backgroundColor: t.background }} />
                              <View style={{ flex: 1, backgroundColor: t.surface }} />
                              <View style={{ flex: 1, backgroundColor: t.swatch }} />
                              <View style={{ flex: 1, backgroundColor: t.accent }} />
                            </View>
                            <Text numberOfLines={2} style={[styles.profileThemeLabel, { color: themeColors.textPrimary }]}>{t.label}</Text>
                            {isActive && <Ionicons name="checkmark-circle" size={14} color={t.swatch} style={{ position: 'absolute', top: 4, right: 4 }} />}
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                ))}

                {/* Reminders — dedicated section with full schedule UI:
                    enable toggle, time picker, schedule type (training-days
                    / daily / weekdays / weekends / custom), and the
                    auto-skip-when-already-done rule. Lives here (Profile
                    gear) instead of buried in Account Details. */}
                <Text style={[styles.profileSectionLabel, { color: themeColors.textMuted, marginTop: 18 }]}>REMINDERS</Text>
                <Text style={{ fontSize: 11, color: themeColors.textMuted, marginBottom: 6, lineHeight: 15 }}>
                  Workout + meal-logging nudges. Each can fire on its own schedule and auto-skip when you've already finished for the day.
                </Text>

                {/* ── Workout reminder ─────────────────────────────────── */}
                <Text style={{ fontSize: 11, fontWeight: '800', color: themeColors.textSecondary, marginTop: 6, marginBottom: 4, letterSpacing: 0.5 }}>WORKOUT</Text>
                <View style={[styles.profileMenuList, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
                  <View style={[styles.profileMenuItem, { justifyContent: 'space-between' }]}>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.profileMenuLabel, { color: themeColors.textPrimary }]}>Workout Reminders</Text>
                      <Text style={{ fontSize: 11, color: themeColors.textMuted }}>Local notification at your set time</Text>
                    </View>
                    <Switch
                      testID="settings-workout-reminders-toggle"
                      value={workoutReminder.enabled}
                      onValueChange={async (v) => {
                        const next = { ...workoutReminder, enabled: v };
                        setWorkoutReminder(next);
                        const { saveReminderSettings } = await import('../utils/workoutReminders');
                        await saveReminderSettings(next);
                      }}
                      trackColor={{ false: themeColors.border, true: themeColors.primary + '55' }}
                      thumbColor={workoutReminder.enabled ? themeColors.primary : themeColors.textMuted}
                    />
                  </View>
                  {workoutReminder.enabled && (
                    <>
                      <View style={[styles.profileMenuItem, { justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: themeColors.border }]}>
                        <Text style={{ fontSize: 13, color: themeColors.textSecondary }}>Remind me at</Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <TouchableOpacity
                            testID="settings-workout-reminder-time-minus"
                            accessibilityLabel="settings-workout-reminder-time-minus"
                            onPress={async () => {
                              const m = workoutReminder.minute - 15;
                              const next = m < 0
                                ? { ...workoutReminder, hour: (workoutReminder.hour + 23) % 24, minute: m + 60 }
                                : { ...workoutReminder, minute: m };
                              setWorkoutReminder(next);
                              const { saveReminderSettings } = await import('../utils/workoutReminders');
                              await saveReminderSettings(next);
                            }}
                            style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: themeColors.border }}>
                            <Ionicons name="remove" size={14} color={themeColors.textSecondary} />
                          </TouchableOpacity>
                          <Text style={{ minWidth: 64, textAlign: 'center', fontSize: 14, fontWeight: '700', color: themeColors.textPrimary }}>
                            {`${((workoutReminder.hour + 11) % 12 + 1)}:${String(workoutReminder.minute).padStart(2, '0')} ${workoutReminder.hour < 12 ? 'AM' : 'PM'}`}
                          </Text>
                          <TouchableOpacity
                            testID="settings-workout-reminder-time-plus"
                            accessibilityLabel="settings-workout-reminder-time-plus"
                            onPress={async () => {
                              const m = workoutReminder.minute + 15;
                              const next = m >= 60
                                ? { ...workoutReminder, hour: (workoutReminder.hour + 1) % 24, minute: m - 60 }
                                : { ...workoutReminder, minute: m };
                              setWorkoutReminder(next);
                              const { saveReminderSettings } = await import('../utils/workoutReminders');
                              await saveReminderSettings(next);
                            }}
                            style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: themeColors.border }}>
                            <Ionicons name="add" size={14} color={themeColors.textSecondary} />
                          </TouchableOpacity>
                        </View>
                      </View>
                      <View style={[styles.profileMenuItem, { borderTopWidth: 1, borderTopColor: themeColors.border, flexDirection: 'column', alignItems: 'flex-start', gap: 8 }]}>
                        <Text style={{ fontSize: 12, fontWeight: '700', color: themeColors.textSecondary }}>Schedule</Text>
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                          {([
                            { key: 'training_days' as const, label: 'Training days' },
                            { key: 'every_day' as const, label: 'Every day' },
                            { key: 'weekdays' as const, label: 'Weekdays' },
                            { key: 'weekends' as const, label: 'Weekends' },
                            { key: 'custom' as const, label: 'Custom' },
                          ]).map(opt => {
                            const active = (workoutReminder.scheduleType ?? 'training_days') === opt.key;
                            return (
                              <TouchableOpacity
                                key={opt.key}
                                testID={`settings-workout-reminder-schedule-${e2eId(opt.key)}`}
                                accessibilityLabel={`settings-workout-reminder-schedule-${e2eId(opt.key)}`}
                                onPress={async () => {
                                  const next = { ...workoutReminder, scheduleType: opt.key };
                                  setWorkoutReminder(next);
                                  const { saveReminderSettings } = await import('../utils/workoutReminders');
                                  await saveReminderSettings(next);
                                }}
                                style={{
                                  paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14,
                                  backgroundColor: active ? themeColors.primary : themeColors.surface,
                                  borderWidth: 1, borderColor: active ? themeColors.primary : themeColors.border,
                                }}>
                                <Text style={{ fontSize: 11, fontWeight: '700', color: active ? getContrastingTextColor(themeColors.primary) : themeColors.textSecondary }}>
                                  {opt.label}
                                </Text>
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                        {(workoutReminder.scheduleType ?? 'training_days') === 'custom' && (
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                            {(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']).map((d, idx) => {
                              const selected = (workoutReminder.customDays ?? []).includes(idx);
                              return (
                                <TouchableOpacity
                                  key={d}
                                  onPress={async () => {
                                    const cur = workoutReminder.customDays ?? [];
                                    const nextDays = selected ? cur.filter(x => x !== idx) : [...cur, idx].sort();
                                    const next = { ...workoutReminder, customDays: nextDays };
                                    setWorkoutReminder(next);
                                    const { saveReminderSettings } = await import('../utils/workoutReminders');
                                    await saveReminderSettings(next);
                                  }}
                                  style={{
                                    width: 36, height: 32, borderRadius: 8,
                                    backgroundColor: selected ? themeColors.primary : themeColors.surface,
                                    borderWidth: 1, borderColor: selected ? themeColors.primary : themeColors.border,
                                    alignItems: 'center', justifyContent: 'center',
                                  }}>
                                  <Text style={{ fontSize: 11, fontWeight: '700', color: selected ? getContrastingTextColor(themeColors.primary) : themeColors.textSecondary }}>
                                    {d}
                                  </Text>
                                </TouchableOpacity>
                              );
                            })}
                          </View>
                        )}
                      </View>
                      <View style={[styles.profileMenuItem, { justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: themeColors.border }]}>
                        <View style={{ flex: 1, paddingRight: 10 }}>
                          <Text style={[styles.profileMenuLabel, { color: themeColors.textPrimary }]}>Skip if already done</Text>
                          <Text style={{ fontSize: 11, color: themeColors.textMuted, lineHeight: 15 }}>
                            Auto-cancel today's reminder once you complete or skip the workout. Off = always fire.
                          </Text>
                        </View>
                        <Switch
                          testID="settings-workout-skip-completed-toggle"
                          value={workoutReminder.skipIfCompleted !== false}
                          onValueChange={async (v) => {
                            const next = { ...workoutReminder, skipIfCompleted: v };
                            setWorkoutReminder(next);
                            const { saveReminderSettings } = await import('../utils/workoutReminders');
                            await saveReminderSettings(next);
                          }}
                          trackColor={{ false: themeColors.border, true: themeColors.primary + '55' }}
                          thumbColor={workoutReminder.skipIfCompleted !== false ? themeColors.primary : themeColors.textMuted}
                        />
                      </View>
                    </>
                  )}
                </View>

                {/* ── Meal log reminder ────────────────────────────────── */}
                <Text style={{ fontSize: 11, fontWeight: '800', color: themeColors.textSecondary, marginTop: 14, marginBottom: 4, letterSpacing: 0.5 }}>MEALS</Text>
                <View style={[styles.profileMenuList, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
                  <View style={[styles.profileMenuItem, { justifyContent: 'space-between' }]}>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.profileMenuLabel, { color: themeColors.textPrimary }]}>Meal Log Reminder</Text>
                      <Text style={{ fontSize: 11, color: themeColors.textMuted }}>Evening nudge to check off the day's meals</Text>
                    </View>
                    <Switch
                      testID="settings-meal-reminder-toggle"
                      value={mealReminder.enabled}
                      onValueChange={async (v) => {
                        const next = { ...mealReminder, enabled: v };
                        setMealReminder(next);
                        const { saveMealReminderSettings } = await import('../utils/mealReminders');
                        await saveMealReminderSettings(next);
                      }}
                      trackColor={{ false: themeColors.border, true: themeColors.primary + '55' }}
                      thumbColor={mealReminder.enabled ? themeColors.primary : themeColors.textMuted}
                    />
                  </View>
                  {mealReminder.enabled && (
                    <>
                      <View style={[styles.profileMenuItem, { justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: themeColors.border }]}>
                        <Text style={{ fontSize: 13, color: themeColors.textSecondary }}>Remind me at</Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <TouchableOpacity
                            testID="settings-meal-reminder-time-minus"
                            accessibilityLabel="settings-meal-reminder-time-minus"
                            onPress={async () => {
                              const m = mealReminder.minute - 15;
                              const next = m < 0
                                ? { ...mealReminder, hour: (mealReminder.hour + 23) % 24, minute: m + 60 }
                                : { ...mealReminder, minute: m };
                              setMealReminder(next);
                              const { saveMealReminderSettings } = await import('../utils/mealReminders');
                              await saveMealReminderSettings(next);
                            }}
                            style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: themeColors.border }}>
                            <Ionicons name="remove" size={14} color={themeColors.textSecondary} />
                          </TouchableOpacity>
                          <Text style={{ minWidth: 64, textAlign: 'center', fontSize: 14, fontWeight: '700', color: themeColors.textPrimary }}>
                            {`${((mealReminder.hour + 11) % 12 + 1)}:${String(mealReminder.minute).padStart(2, '0')} ${mealReminder.hour < 12 ? 'AM' : 'PM'}`}
                          </Text>
                          <TouchableOpacity
                            testID="settings-meal-reminder-time-plus"
                            accessibilityLabel="settings-meal-reminder-time-plus"
                            onPress={async () => {
                              const m = mealReminder.minute + 15;
                              const next = m >= 60
                                ? { ...mealReminder, hour: (mealReminder.hour + 1) % 24, minute: m - 60 }
                                : { ...mealReminder, minute: m };
                              setMealReminder(next);
                              const { saveMealReminderSettings } = await import('../utils/mealReminders');
                              await saveMealReminderSettings(next);
                            }}
                            style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: themeColors.border }}>
                            <Ionicons name="add" size={14} color={themeColors.textSecondary} />
                          </TouchableOpacity>
                        </View>
                      </View>
                      <View style={[styles.profileMenuItem, { borderTopWidth: 1, borderTopColor: themeColors.border, flexDirection: 'column', alignItems: 'flex-start', gap: 8 }]}>
                        <Text style={{ fontSize: 12, fontWeight: '700', color: themeColors.textSecondary }}>Schedule</Text>
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                          {([
                            { key: 'every_day' as const, label: 'Every day' },
                            { key: 'weekdays' as const, label: 'Weekdays' },
                            { key: 'weekends' as const, label: 'Weekends' },
                            { key: 'custom' as const, label: 'Custom' },
                          ]).map(opt => {
                            const active = (mealReminder.scheduleType ?? 'every_day') === opt.key;
                            return (
                              <TouchableOpacity
                                key={opt.key}
                                testID={`settings-meal-reminder-schedule-${e2eId(opt.key)}`}
                                accessibilityLabel={`settings-meal-reminder-schedule-${e2eId(opt.key)}`}
                                onPress={async () => {
                                  const next = { ...mealReminder, scheduleType: opt.key };
                                  setMealReminder(next);
                                  const { saveMealReminderSettings } = await import('../utils/mealReminders');
                                  await saveMealReminderSettings(next);
                                }}
                                style={{
                                  paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14,
                                  backgroundColor: active ? themeColors.primary : themeColors.surface,
                                  borderWidth: 1, borderColor: active ? themeColors.primary : themeColors.border,
                                }}>
                                <Text style={{ fontSize: 11, fontWeight: '700', color: active ? getContrastingTextColor(themeColors.primary) : themeColors.textSecondary }}>
                                  {opt.label}
                                </Text>
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                        {(mealReminder.scheduleType ?? 'every_day') === 'custom' && (
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                            {(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']).map((d, idx) => {
                              const selected = (mealReminder.customDays ?? []).includes(idx);
                              return (
                                <TouchableOpacity
                                  key={d}
                                  onPress={async () => {
                                    const cur = mealReminder.customDays ?? [];
                                    const nextDays = selected ? cur.filter(x => x !== idx) : [...cur, idx].sort();
                                    const next = { ...mealReminder, customDays: nextDays };
                                    setMealReminder(next);
                                    const { saveMealReminderSettings } = await import('../utils/mealReminders');
                                    await saveMealReminderSettings(next);
                                  }}
                                  style={{
                                    width: 36, height: 32, borderRadius: 8,
                                    backgroundColor: selected ? themeColors.primary : themeColors.surface,
                                    borderWidth: 1, borderColor: selected ? themeColors.primary : themeColors.border,
                                    alignItems: 'center', justifyContent: 'center',
                                  }}>
                                  <Text style={{ fontSize: 11, fontWeight: '700', color: selected ? getContrastingTextColor(themeColors.primary) : themeColors.textSecondary }}>
                                    {d}
                                  </Text>
                                </TouchableOpacity>
                              );
                            })}
                          </View>
                        )}
                      </View>
                      <View style={[styles.profileMenuItem, { justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: themeColors.border }]}>
                        <View style={{ flex: 1, paddingRight: 10 }}>
                          <Text style={[styles.profileMenuLabel, { color: themeColors.textPrimary }]}>Skip if all meals logged</Text>
                          <Text style={{ fontSize: 11, color: themeColors.textMuted, lineHeight: 15 }}>
                            Auto-cancel today's reminder once every plan meal is checked off. Off = always fire.
                          </Text>
                        </View>
                        <Switch
                          testID="settings-meal-skip-logged-toggle"
                          value={mealReminder.skipIfAllLogged !== false}
                          onValueChange={async (v) => {
                            const next = { ...mealReminder, skipIfAllLogged: v };
                            setMealReminder(next);
                            const { saveMealReminderSettings } = await import('../utils/mealReminders');
                            await saveMealReminderSettings(next);
                          }}
                          trackColor={{ false: themeColors.border, true: themeColors.primary + '55' }}
                          thumbColor={mealReminder.skipIfAllLogged !== false ? themeColors.primary : themeColors.textMuted}
                        />
                      </View>
                    </>
                  )}
                </View>

                {/* Feedback & Device */}
                <Text style={[styles.profileSectionLabel, { color: themeColors.textMuted, marginTop: 18 }]}>FEEDBACK & DEVICE</Text>
                <View style={[styles.profileMenuList, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
                  {([
                    { key: 'hapticsEnabled' as const, label: 'Haptic Feedback', desc: 'Vibrate on taps and actions' },
                    { key: 'soundsEnabled' as const, label: 'Sounds', desc: 'Play tone when rest timer ends while the app is open' },
                    { key: 'restNotificationSoundEnabled' as const, label: 'Background Ping Assist', desc: 'Try to keep the app awake for the rest ping. Notifications stay silent so music keeps playing.' },
                    { key: 'vibrationEnabled' as const, label: 'Vibration', desc: 'Vibrate on rest timer and alerts' },
                  ]).map(opt => (
                    <View key={opt.key} style={[styles.profileMenuItem, { justifyContent: 'space-between' }]}>
                      <View style={{ flex: 1, paddingRight: 10 }}>
                        <Text style={[styles.profileMenuLabel, { color: themeColors.textPrimary }]}>{opt.label}</Text>
                        <Text style={{ fontSize: 11, color: themeColors.textMuted, lineHeight: 15 }}>{opt.desc}</Text>
                      </View>
                      <Switch
                        testID={`settings-feedback-${e2eId(opt.key)}`}
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
                  {/* Rest timer sound picker */}
                  <View style={[styles.profileMenuItem, { flexDirection: 'column', alignItems: 'flex-start', gap: 10 }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.profileMenuLabel, { color: themeColors.textPrimary }]}>Rest Timer Sound</Text>
                        <Text style={{ fontSize: 11, color: themeColors.textMuted, lineHeight: 15 }}>
                          Tap to preview. Selected plays when your rest ends.
                        </Text>
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                      {(['chime', 'beep', 'ping', 'double'] as const).map((snd) => {
                        const active = (feedbackSettings.restTimerSound ?? 'chime') === snd;
                        const labels: Record<string, string> = { chime: 'Chime', beep: 'Beep', ping: 'Ping', double: 'Double' };
                        return (
                          <TouchableOpacity
                            key={snd}
                            testID={`settings-rest-sound-${e2eId(snd)}`}
                            accessibilityLabel={`settings-rest-sound-${e2eId(snd)}`}
                            activeOpacity={0.75}
                            onPress={async () => {
                              const { saveSettings, playRestTimerDone } = await import('../utils/feedback');
                              const updated = await saveSettings({ restTimerSound: snd });
                              setFeedbackSettings(updated);
                              playRestTimerDone();
                            }}
                            style={{
                              flexDirection: 'row', alignItems: 'center', gap: 5,
                              paddingHorizontal: 12, paddingVertical: 7,
                              borderRadius: 20, borderWidth: 1.5,
                              borderColor: active ? themeColors.primary : themeColors.border,
                              backgroundColor: active ? themeColors.primary + '18' : 'transparent',
                            }}
                          >
                            <Ionicons
                              name={active ? 'radio-button-on' : 'radio-button-off'}
                              size={14}
                              color={active ? themeColors.primary : themeColors.textMuted}
                            />
                            <Text style={{ fontSize: 13, fontWeight: active ? '700' : '400', color: active ? themeColors.primary : themeColors.textSecondary }}>
                              {labels[snd]}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                  {!isFreeTier ? (
                    <AppleHealthToggleRow themeColors={themeColors} userAge={userProfile.physicalStats?.age ?? null} />
                  ) : (
                    <View style={[styles.profileMenuItem, { justifyContent: 'space-between' }]}>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.profileMenuLabel, { color: themeColors.textPrimary }]}>Apple Health</Text>
                        <Text style={{ fontSize: 11, color: themeColors.textMuted }}>
                          Pro adds HealthKit sleep, HRV, heart-rate, weight, and workout context.
                        </Text>
                      </View>
                      <Ionicons name="lock-closed-outline" size={18} color={themeColors.textMuted} />
                    </View>
                  )}
                </View>

                {/* Account + Sign out */}
                <Text style={[styles.profileSectionLabel, { color: themeColors.textMuted, marginTop: 18 }]}>ACCOUNT</Text>
                <View style={[styles.profileMenuList, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
                  <TouchableOpacity
                    style={styles.profileMenuItem}
                    testID="settings-account-details"
                    accessibilityLabel="settings-account-details"
                    onPress={() => {
                    // Close Settings FIRST — iOS can't stack two modals,
                    // so opening Account Details while Settings is still
                    // visible renders the AccountInfoModal behind it
                    // (the user only sees it after they manually back
                    // out of Settings). 220ms is the slide-down duration.
                    setShowSettings(false);
                    setTimeout(() => onViewAccount(), 220);
                  }}>
                    <Text style={[styles.profileMenuLabel, { color: themeColors.textPrimary }]}>Account Details</Text>
                    <Text style={[styles.profileMenuChevron, { color: themeColors.textMuted }]}>›</Text>
                  </TouchableOpacity>
                </View>

                <TouchableOpacity
                  testID="settings-sign-out"
                  accessibilityLabel="settings-sign-out"
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
            </View>
          );
        })()}
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
                      <Text style={{ color: getContrastingTextColor(themeColors.primary), fontWeight: '700', fontSize: 15 }}>
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
                        <Text style={{ color: getContrastingTextColor(themeColors.primary), fontWeight: '700', fontSize: 13 }}>+ Add to My Supplements</Text>
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
                <ActivityIndicator color={getContrastingTextColor(themeColors.primary)} size="small" />
              ) : (
                <Text style={{ fontSize: 14, fontWeight: '700', color: getContrastingTextColor(themeColors.primary) }}>Save</Text>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Bottom tab bar ────────────────────────────────────────────────
          Five top-level destinations. Each tab simply sets `activeTab`
          and the screen body re-renders the matching content block. */}
      <Animated.View
        pointerEvents="box-none"
        style={[
          styles.bottomBarShell,
          {
            bottom: Math.max(insets.bottom, 10),
            shadowColor: isLightTheme ? themeColors.textMuted : '#000',
            shadowOpacity: isLightTheme ? 0.12 : 0.24,
            transform: [
              {
                translateY: bottomNavFloat.interpolate({
                  inputRange: [0, 1],
                  outputRange: [6, 0],
                }),
              },
              {
                scale: bottomNavFloat.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.985, 1],
                }),
              },
            ],
          },
        ]}>
        <LinearGradient
          colors={bottomBarGradientColors}
          style={[styles.bottomBar, { borderColor: chromeColors.border, borderWidth: isLightTheme ? StyleSheet.hairlineWidth : 1.25 }]}>
          <BottomTabButton
            testID="bottom-tab-social"
            label="Social"
            iconName="people-outline"
            active={activeTab === 'friends'}
            tint={themeColors.primary}
            mutedColor={navMutedColor}
            onPress={() => setActiveTab('friends')}
            badge={Math.max(pendingFriendCount, socialUnreadCount) > 0 ? Math.max(pendingFriendCount, socialUnreadCount) : undefined}
          />
          <BottomTabButton
            testID="bottom-tab-workouts"
            label="Workouts"
            iconName="barbell-outline"
            active={activeTab === 'workout'}
            tint={workoutPalette.strong}
            mutedColor={navMutedColor}
            onPress={() => setActiveTab('workout')}
          />
          <BottomTabButton
            testID="bottom-tab-meals"
            label="Meals"
            iconName="nutrition-outline"
            active={activeTab === 'meals'}
            tint={mealPalette.strong}
            mutedColor={navMutedColor}
            onPress={() => setActiveTab('meals')}
          />
          <BottomTabButton
            testID="bottom-tab-progress"
            label="Progress"
            iconName="trending-up-outline"
            active={activeTab === 'progress'}
            tint={themeColors.primary}
            mutedColor={navMutedColor}
            onPress={() => setActiveTab('progress')}
          />
          <BottomTabButton
            testID="bottom-tab-you"
            label="You"
            iconName="person-circle-outline"
            active={activeTab === 'you'}
            tint={themeColors.primary}
            mutedColor={navMutedColor}
            onPress={() => setActiveTab('you')}
          />
        </LinearGradient>
      </Animated.View>
    </View>
  );
}

function WeekStrip({ items, selectedKey, accent, colors: tc, label, onSelect }: {
  items: WeekStripItem[];
  selectedKey: string;
  accent: string;
  colors: ReturnType<typeof getTheme>['colors'];
  label: string;
  onSelect: (key: string) => void;
}) {
  const testPrefix = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const selected = items.find(item => item.key === selectedKey) ?? items[0];
  const isLightMode = !bgIsDark(tc.background);
  const quietTextColor = isLightMode ? tc.textMuted : tc.textSecondary;
  const quietBorderColor = isLightMode ? tc.border + '88' : tc.border;
  const statusLabel = (state: WeekStripState) => {
    if (state === 'done') return 'Done';
    if (state === 'logged') return 'Logged';
    if (state === 'skipped') return 'Skipped';
    if (state === 'rest') return 'Rest';
    if (state === 'today') return 'Today';
    return 'Planned';
  };
  const stateColor = (state: WeekStripState) => {
    if (state === 'done' || state === 'logged' || state === 'today' || state === 'planned') return accent;
    if (state === 'skipped') return tc.warning;
    if (state === 'rest') return tc.textMuted;
    return accent;
  };
  const currentDayKey = todayKey();
  const selectedDateLabel = selected
    ? `${selected.key === currentDayKey ? 'Today' : DAY_NAMES[selected.date.getDay()]} · ${MONTH_NAMES[selected.date.getMonth()]} ${selected.date.getDate()}`
    : '';
  const selectedSummary = selected
    ? [
        selectedDateLabel,
        selected.title,
        selected.key === currentDayKey && selected.state === 'today' ? null : statusLabel(selected.state),
      ].filter(Boolean).join(' · ')
    : '';

  return (
    <View testID={`${testPrefix}-strip`} style={styles.weekStripWrap}>
      <View style={styles.weekStripHeader}>
        <Text style={[styles.weekStripLabel, { color: quietTextColor }]}>{label}</Text>
        {selected ? (
          <Text style={[styles.weekStripSelection, { color: tc.textSecondary }]} numberOfLines={1}>
            {selectedSummary}
          </Text>
        ) : null}
      </View>
      <View style={styles.weekStripDays}>
        {items.map((item, index) => {
          const active = item.key === selectedKey;
          const isToday = item.key === currentDayKey;
          const color = stateColor(item.state);
          const showDot = item.state !== 'rest';
          const markerIcon = item.state === 'done' || item.state === 'logged'
            ? 'checkmark'
            : item.state === 'skipped'
              ? 'close'
              : null;
          return (
            <TouchableOpacity
              key={item.key}
              testID={`${testPrefix}-day-chip-${index}`}
              onPress={() => onSelect(item.key)}
              activeOpacity={0.82}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`${isToday ? 'Today, ' : ''}${DAY_NAMES[item.date.getDay()]} ${item.date.getDate()}, ${item.title}`}
              style={[
                styles.weekDayChip,
                {
                  backgroundColor: active ? accent + '14' : tc.surface,
                  borderColor: active ? accent : isToday ? accent + '66' : quietBorderColor,
                  borderWidth: active ? 1 : isLightMode ? StyleSheet.hairlineWidth : 1,
                },
              ]}>
              {isToday ? (
                <View
                  pointerEvents="none"
                  style={[styles.weekDayTodayMarker, { backgroundColor: accent }]}
                />
              ) : null}
              <Text style={[
                styles.weekDayName,
                { color: active ? accent : isToday ? accent : quietTextColor },
              ]}>
                {DAY_NAMES[item.date.getDay()]}
              </Text>
              <Text style={[
                styles.weekDayDate,
                { color: active ? accent : tc.textPrimary },
              ]}>
                {item.date.getDate()}
              </Text>
              <View style={[
                styles.weekDayDot,
                {
                  backgroundColor: showDot ? color : 'transparent',
                  opacity: showDot ? 1 : 0,
                },
              ]}>
                {markerIcon ? (
                  <Ionicons name={markerIcon as any} size={10} color="#fff" />
                ) : null}
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function ExpandingChevron({ expanded, color, size = 16 }: {
  expanded: boolean;
  color: string;
  size?: number;
}) {
  const rotation = useRef(new Animated.Value(expanded ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(rotation, {
      toValue: expanded ? 1 : 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [expanded, rotation]);

  const rotate = rotation.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '180deg'],
  });

  return (
    <Animated.View style={{ transform: [{ rotate }] }}>
      <Ionicons name="chevron-down" size={size} color={color} />
    </Animated.View>
  );
}

function HydrationTodayPanel({
  ounces,
  target,
  pct,
  breakdown,
  guidance,
  loading,
  colors,
  onDelta,
  onSet,
}: {
  ounces: number;
  target: number;
  pct: number;
  breakdown?: HydrationSummary['breakdown'];
  guidance?: HydrationSummary['guidance'];
  loading: boolean;
  colors: ReturnType<typeof getTheme>['colors'];
  onDelta: (deltaOz: number) => void;
  onSet: (ounces: number) => void;
}) {
  const fillAnim = useRef(new Animated.Value(pct / 100)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const rippleAnim = useRef(new Animated.Value(0)).current;
  const burstAnim = useRef(new Animated.Value(0)).current;
  const previousOunces = useRef(ounces);
  const [manualOunces, setManualOunces] = useState(String(ounces || ''));
  const [burstLabel, setBurstLabel] = useState('');

  useEffect(() => {
    setManualOunces(String(ounces || ''));
  }, [ounces]);

  useEffect(() => {
    Animated.timing(fillAnim, {
      toValue: Math.max(0, Math.min(1, pct / 100)),
      duration: 420,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [fillAnim, pct]);

  useEffect(() => {
    if (previousOunces.current === ounces) return;
    const delta = ounces - previousOunces.current;
    previousOunces.current = ounces;
    setBurstLabel(delta > 0 ? `+${Math.round(delta)} oz` : 'Updated');
    rippleAnim.setValue(0);
    burstAnim.setValue(0);
    Animated.sequence([
      Animated.parallel([
        Animated.spring(pulseAnim, { toValue: 1.16, friction: 5, tension: 190, useNativeDriver: true }),
        Animated.timing(rippleAnim, {
          toValue: 1,
          duration: 620,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.sequence([
          Animated.timing(burstAnim, {
            toValue: 1,
            duration: 180,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.timing(burstAnim, {
            toValue: 0,
            duration: 520,
            easing: Easing.in(Easing.cubic),
            useNativeDriver: true,
          }),
        ]),
      ]),
      Animated.spring(pulseAnim, { toValue: 1, friction: 6, tension: 140, useNativeDriver: true }),
    ]).start();
  }, [burstAnim, ounces, pulseAnim, rippleAnim]);

  const fillWidth = fillAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });
  const rippleScale = rippleAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.55, 2.6],
  });
  const rippleOpacity = rippleAnim.interpolate({
    inputRange: [0, 0.65, 1],
    outputRange: [0.28, 0.12, 0],
  });
  const burstTranslateY = burstAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [8, -16],
  });

  const submitManual = () => {
    const parsed = Number(manualOunces.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(parsed)) return;
    onSet(parsed);
  };
  const activityOz = Math.round(breakdown?.activity ?? 0);
  const proteinOz = Math.round(breakdown?.protein ?? 0);
  const alcoholOz = Math.round(breakdown?.alcohol ?? 0);
  const workoutMinutes = Math.round(guidance?.workout_minutes ?? 0);
  const targetReasons: string[] = [];
  if (activityOz > 0) {
    targetReasons.push(
      workoutMinutes > 0
        ? `Water goal raised ${activityOz} oz for ${workoutMinutes} min of training today.`
        : `Water goal raised ${activityOz} oz for today's training.`
    );
  }
  if (proteinOz > 0) {
    targetReasons.push(`Protein logged today added ${proteinOz} oz.`);
  }
  if (alcoholOz > 0) {
    targetReasons.push(`Alcohol logged today added ${alcoholOz} oz.`);
  }
  const targetReasonMessage = targetReasons.length > 0 ? targetReasons.join(' ') : null;
  const guidanceMessage = targetReasonMessage
    ?? guidance?.electrolytes?.message
    ?? guidance?.notes?.find(note => note.key === 'high_sodium')?.message
    ?? null;
  const guidanceTone = targetReasonMessage
    ? MEALS_ACCENT
    : guidance?.electrolytes?.status === 'covered' || guidance?.electrolytes?.status === 'planned'
    ? colors.success
    : colors.warning;

  return (
    <View testID="hydration-panel" style={[
      styles.mealHydrationPanel,
      {
        backgroundColor: MEALS_ACCENT + '0F',
        borderColor: MEALS_ACCENT + '33',
      },
    ]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Animated.View style={{
          width: 32, height: 32, borderRadius: 16,
          backgroundColor: MEALS_ACCENT + '18',
          alignItems: 'center', justifyContent: 'center',
          transform: [{ scale: pulseAnim }],
        }}>
          <Animated.View style={{
            position: 'absolute',
            width: 30,
            height: 30,
            borderRadius: 15,
            backgroundColor: MEALS_ACCENT,
            opacity: rippleOpacity,
            transform: [{ scale: rippleScale }],
          }} />
          <Ionicons name="water-outline" size={18} color={MEALS_ACCENT} />
        </Animated.View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 12, fontWeight: '900', color: colors.textPrimary }}>Hydration</Text>
          <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 1 }}>
            {ounces} / {target} oz · {pct}% complete
          </Text>
        </View>
        {loading && <ActivityIndicator size="small" color={MEALS_ACCENT} />}
      </View>
      <View style={{ position: 'relative' }}>
        <Animated.View pointerEvents="none" style={{
          position: 'absolute',
          right: 0,
          top: -12,
          opacity: burstAnim,
          transform: [{ translateY: burstTranslateY }],
        }}>
          <Text style={{ fontSize: 10, fontWeight: '900', color: MEALS_ACCENT }}>{burstLabel}</Text>
        </Animated.View>
        <View style={{
          height: 8,
          borderRadius: 999,
          backgroundColor: colors.surface,
          overflow: 'hidden',
          marginTop: 10,
        }}>
          <Animated.View style={{ width: fillWidth, height: '100%', backgroundColor: MEALS_ACCENT }} />
        </View>
      </View>
      {guidanceMessage ? (
        <View style={{
          marginTop: 10,
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: 6,
          paddingVertical: 7,
          paddingHorizontal: 8,
          borderRadius: 8,
          backgroundColor: guidanceTone + '12',
          borderWidth: 1,
          borderColor: guidanceTone + '2E',
        }}>
          <Ionicons name="information-circle-outline" size={13} color={guidanceTone} style={{ marginTop: 1 }} />
          <Text testID="hydration-guidance-message" style={{ flex: 1, fontSize: 10.5, lineHeight: 15, color: colors.textSecondary, fontWeight: '600' }}>
            {guidanceMessage}
          </Text>
        </View>
      ) : null}
      <View style={{ gap: 8, marginTop: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{
            flex: 1,
            minHeight: 32,
            borderRadius: 10,
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.border,
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 8,
          }}>
            <TextInput
              testID="hydration-ounces-input"
              value={manualOunces}
              onChangeText={setManualOunces}
              onSubmitEditing={submitManual}
              keyboardType="decimal-pad"
              returnKeyType="done"
              editable={!loading}
              selectTextOnFocus
              style={{
                flex: 1,
                minWidth: 0,
                paddingVertical: 5,
                fontSize: 12,
                fontWeight: '900',
                color: colors.textPrimary,
              }}
            />
            <Text style={{ fontSize: 9, fontWeight: '800', color: colors.textMuted }}>oz</Text>
          </View>
          <PressableScale
            testID="hydration-set"
            onPress={submitManual}
            disabled={loading}
            scaleDown={0.94}
            style={{
              minHeight: 32,
              paddingHorizontal: 10,
              borderRadius: 10,
              backgroundColor: MEALS_ACCENT,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: loading ? 0.55 : 1,
            }}>
            <Text style={{ fontSize: 10, fontWeight: '900', color: '#fff' }}>Set</Text>
          </PressableScale>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {HYDRATION_QUICK_ADD_OUNCES.map(oz => (
            <PressableScale
              key={oz}
              testID={`hydration-quick-add-${oz}`}
              onPress={() => onDelta(oz)}
              disabled={loading}
              scaleDown={0.94}
              style={{
                flex: 1,
                flexBasis: '18%',
                minWidth: 54,
                minHeight: 32,
                paddingVertical: 7,
                paddingHorizontal: 6,
                borderRadius: 10,
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: MEALS_ACCENT + '3D',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: loading ? 0.55 : 1,
              }}>
              <Text
                style={{ fontSize: 10, fontWeight: '900', color: MEALS_ACCENT }}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.85}
              >
                {formatHydrationQuickAddLabel(oz)}
              </Text>
            </PressableScale>
          ))}
        </View>
      </View>
    </View>
  );
}

// ── SubTabBtn ─────────────────────────────────────────────────────────────────
function SubTabBtn({ label, active, tint, mutedColor, onPress, testID }: {
  label: string;
  active: boolean;
  tint: string;
  mutedColor: string;
  onPress: () => void;
  testID?: string;
}) {
  const pressLock = useRef(false);
  const triggerPress = () => {
    if (pressLock.current) return;
    pressLock.current = true;
    onPress();
    setTimeout(() => { pressLock.current = false; }, 1000);
  };
  return (
    <View style={{ flex: 1 }}>
      <Pressable
        onPressIn={triggerPress}
        onPress={triggerPress}
        hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
        accessibilityRole="tab"
        accessibilityLabel={`${label} tab`}
        accessibilityState={{ selected: active }}
        testID={testID}
        style={({ pressed }) => ({
          width: '100%',
          minHeight: 40,
          transform: [{ scale: pressed ? 0.985 : 1 }],
        })}>
        <View style={{
        flex: 1,
        paddingVertical: 8,
        paddingHorizontal: 8,
        borderRadius: 999,
        backgroundColor: active ? tint + '1C' : 'transparent',
        borderWidth: active ? 1 : 0,
        borderColor: active ? tint + '33' : 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
        }}>
          <Text {...dynamicCompactTextProps} style={{
            ...typography.label,
            fontWeight: active ? '800' : '600',
            color: active ? tint : mutedColor,
            opacity: active ? 1 : 0.68,
          }} numberOfLines={2}>
            {label}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

// ── BottomTabButton ───────────────────────────────────────────────────────────
function BottomTabButton({
  label, iconName, active, tint, mutedColor, onPress, badge, testID,
}: {
  label: string;
  iconName: string;
  active: boolean;
  tint: string;
  mutedColor: string;
  onPress: () => void;
  badge?: number;
  testID?: string;
}) {
  const activeAnim = useRef(new Animated.Value(active ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(activeAnim, {
      toValue: active ? 1 : 0,
      friction: 8,
      tension: 160,
      useNativeDriver: true,
    }).start();
  }, [active, activeAnim]);

  const iconLift = activeAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -2],
  });
  const iconScale = activeAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.08],
  });
  const dotScale = activeAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.35, 1],
  });

  return (
    <View style={btStyles.slot}>
      <PressableScale
        style={btStyles.btn}
        onPress={() => {
          if (!active) import('../utils/feedback').then(f => f.hapticSelection()).catch(() => {});
          onPress();
        }}
        scaleDown={0.97}
        hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
        accessibilityRole="tab"
        accessibilityLabel={`${label} tab`}
        accessibilityState={{ selected: active }}
        testID={testID}>
        <Animated.View style={[
          btStyles.inner,
          active && {
            backgroundColor: tint + '22',
            borderColor: tint + '5A',
          },
          {
            transform: [
              { translateY: iconLift },
              { scale: activeAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.03] }) },
            ],
          },
        ]}>
          <View style={{ position: 'relative' }}>
            <Animated.View style={[
              btStyles.iconWrap,
              active && { backgroundColor: tint + '20' },
              { transform: [{ scale: iconScale }] },
            ]}>
              <Ionicons
                name={(active ? iconName.replace('-outline', '') : iconName) as any}
                size={active ? 20 : 21}
                color={active ? tint : mutedColor}
                style={{ opacity: active ? 1 : 0.68 }}
              />
            </Animated.View>
            {badge != null && badge > 0 && (
              <View style={{ position: 'absolute', top: -4, right: -8, backgroundColor: tint, borderRadius: 999, minWidth: 15, height: 15, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 }}>
                <Text style={{ fontSize: 9, fontWeight: '800', color: getContrastingTextColor(tint) }}>{badge}</Text>
              </View>
            )}
          </View>
          <Animated.View style={[
            btStyles.activeDot,
            {
              backgroundColor: tint,
              opacity: activeAnim,
              transform: [{ scale: dotScale }],
            },
          ]} />
        </Animated.View>
      </PressableScale>
    </View>
  );
}

const btStyles = StyleSheet.create({
  slot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 0,
  },
  btn: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 0,
    position: 'relative',
  },
  inner: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    width: 48,
    height: 48,
    paddingHorizontal: 0,
    paddingVertical: 0,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  iconWrap: {
    width: 34,
    height: 30,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
  },
  icon:  { fontSize: 22 },
});

// ── FocusLabelCrossfade ─────────────────────────────────────────────────────
// Small helper that fades the focus label out, swaps the text mid-fade,
// then fades back in — so changing a day's focus via the Switch Day
// picker doesn't snap to the new label. Pure animation; no logic change.
function FocusLabelCrossfade({ focus, style, testID, accessibilityLabel }: { focus: string; style?: any; testID?: string; accessibilityLabel?: string }) {
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
    <Animated.Text
      testID={testID}
      accessibilityLabel={accessibilityLabel ?? displayed}
      style={[style, { opacity }]}
    >
      {displayed}
    </Animated.Text>
  );
}

// ── Today activity cards ──────────────────────────────────────────────────────

function formatActivityDuration(seconds?: number): string {
  const total = Math.max(0, Math.round((seconds ?? 0) / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${Math.max(1, m)}m`;
}

function activityTitle(session: WorkoutSession): string {
  const activity = session.manualActivity;
  const subtype = activity?.subtype ? humanizeToken(activity.subtype) : '';
  const category = activity?.category ? humanizeToken(activity.category) : '';
  return subtype || category || session.focus || 'Workout';
}

function activitySourceLabel(source?: string): string {
  if (source === 'apple_health') return 'Imported';
  if (source === 'live_tracker') return 'Custom';
  return 'Manual';
}

function activityIcon(session: WorkoutSession): string {
  const category = session.manualActivity?.category;
  const subtype = (session.manualActivity?.subtype ?? '').toLowerCase();
  if (category === 'mobility') return 'body-outline';
  if (category === 'strength') return 'barbell-outline';
  if (category === 'sport') return subtype.includes('basket') ? 'basketball-outline' : 'tennisball-outline';
  if (subtype.includes('ride') || subtype.includes('bike') || subtype.includes('spin')) return 'bicycle-outline';
  if (subtype.includes('walk') || subtype.includes('hike')) return 'footsteps-outline';
  if (subtype.includes('swim')) return 'water-outline';
  return 'walk-outline';
}

const TodayWorkoutPlanActivityCards = React.memo(function TodayWorkoutPlanActivityCards({ themeName, distanceUnit = 'mi', sessions, onStartCustom, onLogActivity, onEditPlan, templates = [], isFreeTier = false, onStartTemplate, onDeleteTemplate, onNewTemplate, onEditTemplate }: {
  themeName?: import('../types').AppThemeName;
  distanceUnit?: import('../utils/units').DistanceUnit;
  sessions: WorkoutSession[];
  onStartCustom: () => void;
  onLogActivity: () => void;
  onEditPlan: () => void;
  templates?: SavedWorkoutTemplate[];
  isFreeTier?: boolean;
  onStartTemplate?: (template: SavedWorkoutTemplate) => void;
  onDeleteTemplate?: (template: SavedWorkoutTemplate) => void;
  /** Open the template-builder modal in create mode. */
  onNewTemplate?: () => void;
  /** Open the template-builder modal in edit mode for this template. */
  onEditTemplate?: (template: SavedWorkoutTemplate) => void;
}) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const sortedSessions = React.useMemo(() => [...sessions].sort((a, b) => {
    const aMs = new Date(a.startedAt ?? a.date ?? 0).getTime();
    const bMs = new Date(b.startedAt ?? b.date ?? 0).getTime();
    return bMs - aMs;
  }), [sessions]);

  return (
    <View style={styles.todayActivitySection}>
      <View style={styles.todayActivityHeaderRow}>
        <Text style={[styles.todayActivityHeader, { color: tc.textPrimary }]}>Extra workouts</Text>
        {sortedSessions.length > 0 ? (
          <Text style={[styles.todayActivityCount, { color: tc.textMuted }]}>
            {sortedSessions.length} logged
          </Text>
        ) : null}
      </View>

      {sortedSessions.map((session) => {
        const source = activitySourceLabel(session.manualActivity?.source as any);
        const activity = session.manualActivity;
        const pieces = [
          source,
          formatActivityDuration(session.durationSeconds),
          activity?.distanceMiles ? formatDistance(activity.distanceMiles, distanceUnit) : null,
          activity?.caloriesBurned ? `${Math.round(activity.caloriesBurned)} kcal` : null,
          activity?.avgHeartRate ? `${Math.round(activity.avgHeartRate)} bpm` : null,
        ].filter(Boolean);
        return (
          <View
            key={session.id}
            style={[
              styles.todayActivityLoggedCard,
              { backgroundColor: tc.surface, borderColor: source === 'Imported' ? tc.primary + '55' : tc.border },
            ]}>
            <View style={[styles.todayActivityIconBubble, { backgroundColor: tc.primary + '18' }]}>
              <Ionicons name={activityIcon(session) as any} size={17} color={tc.primary} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[styles.todayActivityTitle, { color: tc.textPrimary }]} numberOfLines={1}>
                {activityTitle(session)}
              </Text>
              <Text style={[styles.todayActivityMeta, { color: tc.textMuted }]} numberOfLines={1}>
                {pieces.join(' · ')}
              </Text>
            </View>
          </View>
        );
      })}

      <View style={styles.todayActivityQuickRow}>
        <TouchableOpacity
          testID="extra-workout-custom"
          accessibilityLabel="extra-workout-custom"
          style={[styles.todayActivityQuickAction, { backgroundColor: tc.primary + '10', borderColor: tc.primary + '55' }]}
          onPress={onStartCustom}
          activeOpacity={0.78}>
          <Ionicons name="flash" size={15} color={tc.primary} />
          <Text style={[styles.todayActivityQuickText, { color: tc.textPrimary }]}>Custom</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="extra-workout-log"
          accessibilityLabel="extra-workout-log"
          style={[styles.todayActivityQuickAction, { backgroundColor: tc.surface, borderColor: tc.border }]}
          onPress={onLogActivity}
          activeOpacity={0.75}>
          <Ionicons name="add-circle-outline" size={15} color={tc.primary} />
          <Text style={[styles.todayActivityQuickText, { color: tc.textPrimary }]}>Log</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="extra-workout-edit"
          accessibilityLabel="extra-workout-edit"
          style={[styles.todayActivityQuickAction, { backgroundColor: tc.surface, borderColor: tc.border }]}
          onPress={onEditPlan}
          activeOpacity={0.75}>
          <Ionicons name="settings-sharp" size={15} color={tc.textMuted} />
          <Text style={[styles.todayActivityQuickText, { color: tc.textPrimary }]}>Edit</Text>
        </TouchableOpacity>
      </View>

      {(templates.length > 0 || onNewTemplate) && (
        <View style={styles.todayTemplateBlock}>
          <View style={styles.todayActivityHeaderRow}>
            <Text style={[styles.todayActivityHeader, { color: tc.textPrimary }]}>Saved templates</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              {isFreeTier ? (
                <Text style={[styles.todayActivityCount, { color: tc.textMuted }]}>
                  {templates.length}/{FREE_WORKOUT_TEMPLATE_LIMIT}
                </Text>
              ) : null}
              {onNewTemplate && (!isFreeTier || templates.length < FREE_WORKOUT_TEMPLATE_LIMIT) && (
                <TouchableOpacity
                  testID="workout-template-new"
                  accessibilityLabel="workout-template-new"
                  onPress={onNewTemplate}
                  activeOpacity={0.7}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 4,
                    paddingVertical: 5, paddingHorizontal: 10,
                    borderRadius: 14, backgroundColor: tc.primary + '18',
                    borderWidth: 1, borderColor: tc.primary + '55',
                  }}>
                  <Ionicons name="add" size={14} color={tc.primary} />
                  <Text style={{ fontSize: 11, fontWeight: '800', color: tc.primary, letterSpacing: 0.4 }}>NEW</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
          {templates.length === 0 && onNewTemplate && (
            <View style={{
              padding: 16, borderWidth: 1, borderRadius: radius.md,
              borderColor: tc.border, backgroundColor: tc.surface,
              borderStyle: 'dashed' as any, alignItems: 'center',
            }}>
              <Text style={{ fontSize: 12, color: tc.textMuted, textAlign: 'center' }}>
                Group your favorite exercises into a template — tap NEW to start.
              </Text>
            </View>
          )}
          {templates.map((template, idx) => {
            const exerciseCount = template.workout?.exercises?.length ?? 0;
            const setCount = (template.workout?.exercises ?? []).reduce((n, ex: any) => n + (Number(ex.sets) || Number(ex.targetSets) || 0), 0);
            const meta = [
              template.workout?.focus || 'Workout',
              `${exerciseCount} exercise${exerciseCount === 1 ? '' : 's'}`,
              setCount > 0 ? `${setCount} set${setCount === 1 ? '' : 's'}` : null,
            ].filter(Boolean).join(' · ');
            return (
              <SwipeableRow
                key={template.id}
                enabled={!!(onDeleteTemplate || onEditTemplate)}
                actions={[
                  ...(onEditTemplate ? [{
                    icon: 'create-outline',
                    label: 'Edit',
                    color: '#fff',
                    bgColor: tc.primary,
                    onPress: () => onEditTemplate(template),
                  }] : []),
                  ...(onDeleteTemplate ? [{
                    icon: 'trash-outline',
                    label: 'Delete',
                    color: '#fff',
                    bgColor: tc.error ?? '#EF4444',
                    onPress: () => onDeleteTemplate(template),
                  }] : []),
                ]}>
              <View
                style={[styles.todayActivityLoggedCard, { backgroundColor: tc.surface, borderColor: tc.border }]}>
                <TouchableOpacity
                  testID={`workout-template-card-${idx}`}
                  accessibilityLabel={`workout-template-card-${idx}`}
                  style={styles.todayTemplateLaunchArea}
                  onPress={() => onStartTemplate?.(template)}
                  activeOpacity={0.78}>
                  <View style={[styles.todayActivityIconBubble, { backgroundColor: tc.primary + '18' }]}>
                    <Ionicons name="bookmark-outline" size={17} color={tc.primary} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[styles.todayActivityTitle, { color: tc.textPrimary }]} numberOfLines={1}>
                      {template.name}
                    </Text>
                    <Text style={[styles.todayActivityMeta, { color: tc.textMuted }]} numberOfLines={1}>
                      {meta}
                    </Text>
                  </View>
                </TouchableOpacity>
                {onDeleteTemplate ? (
                  <TouchableOpacity
                    testID={`workout-template-delete-${idx}`}
                    accessibilityLabel={`workout-template-delete-${idx}`}
                    style={styles.todayTemplateIconBtn}
                    onPress={() => onDeleteTemplate(template)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    activeOpacity={0.72}>
                    <Ionicons name="trash-outline" size={18} color={tc.textMuted} />
                  </TouchableOpacity>
                ) : null}
                {onEditTemplate ? (
                  <TouchableOpacity
                    testID={`workout-template-edit-${idx}`}
                    accessibilityLabel={`workout-template-edit-${idx}`}
                    style={styles.todayTemplateIconBtn}
                    onPress={() => onEditTemplate(template)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    activeOpacity={0.72}>
                    <Ionicons name="create-outline" size={18} color={tc.textMuted} />
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity
                  testID={`workout-template-start-${idx}`}
                  accessibilityLabel={`workout-template-start-${idx}`}
                  style={styles.todayTemplateIconBtn}
                  onPress={() => onStartTemplate?.(template)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  activeOpacity={0.72}>
                  <Ionicons name="play-circle" size={22} color={tc.primary} />
                </TouchableOpacity>
              </View>
              </SwipeableRow>
            );
          })}
        </View>
      )}
    </View>
  );
});

// ── DayCard ───────────────────────────────────────────────────────────────────

function DayCardImpl({ item, themeName, isToday, isCompleted, isSkipped, skipReason, completedSummary, expanded, onPress, onStartWorkout, onSkip, onUnskip, onUndoComplete, onChangeFocus, splitOptions, optionWarnings, showSwitchOptions, onToggleSwitch, hasPlateauedExercises, isRegenerating, sessionMinutes, onSwapExercise, onViewExercise, onOpenExerciseVideo, readinessBadge, onReadinessTap }: {
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
  /** Top of the user's chosen session duration range — passed to WorkoutCard
   *  to cap the estimated time display. */
  sessionMinutes?: number;
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
  readinessBadge?: { score: number; label: string };
  onReadinessTap?: () => void;
}) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const workoutPalette = theme.sections.workout;
  const isLightMode = isLightThemeName(theme.name);
  const cardMetaColor = isLightMode ? tc.textMuted : tc.textSecondary;
  const cardSecondaryColor = tc.textSecondary;
  const quietBorderColor = isLightMode ? tc.border + '88' : tc.border;
  const quietBorderWidth = isLightMode ? StyleSheet.hairlineWidth : 1;
  const cardShadow = (hero: boolean) => ({
    shadowColor: isLightMode ? '#0F172A' : '#000',
    shadowOpacity: isLightMode ? (hero ? 0.12 : 0.045) : (hero ? 0.28 : 0.16),
    shadowRadius: hero ? 22 : 12,
    shadowOffset: { width: 0, height: hero ? 12 : 5 },
    elevation: hero ? 8 : isLightMode ? 1 : 4,
  });
  // Day-of-week label. Only "Today" gets a special name — for all
  // other days the date strip already disambiguates (e.g. "Mon · Apr 27"),
  // so adding "Yesterday" / "Tomorrow" reads as redundant noise.
  const dow = isToday ? 'Today' : DAY_NAMES[item.date.getDay()];
  const dateStr = `${MONTH_NAMES[item.date.getMonth()]} ${item.date.getDate()}`;

  // Rest day — uses `workoutPalette.strong` so the today highlight
  // matches the rest of the workout tab in whatever theme the user picked.
  // (The meal side uses a hardcoded green instead so the two day cards
  // stay distinct even when a theme's workout/meal palettes are similar.)
  if (item.isRest) {
    // Rest days aren't immutable — users can convert one to a workout day
    // when life shifts (skipped a planned day, want to add a session). Pro
    // users go through the change-focus picker (with archetype options).
    // Free users get a single "Switch to Custom" CTA — there's no
    // generation surface to expose, just the option to start filling the
    // day with their own exercises / templates / live tracker.
    const canSwitchOff = !!onChangeFocus;
    const restHero = isToday;
    return (
      <View style={[
        styles.dayCard,
        {
          backgroundColor: restHero && !isLightMode ? tc.surfaceRaised : tc.surface,
          borderColor: restHero ? workoutPalette.strong + (isLightMode ? 'AA' : '') : quietBorderColor,
          borderWidth: restHero ? (isLightMode ? 1 : 1.5) : quietBorderWidth,
          paddingBottom: restHero ? 18 : 14,
          ...cardShadow(restHero),
        },
      ]}>
        {isToday && <View style={[styles.dayCardTopAccent, { backgroundColor: workoutPalette.strong, height: isLightMode ? 3 : 4, opacity: isLightMode ? 0.72 : 1 }]} />}
        <View style={[styles.dayCardRow, { paddingTop: isToday ? 0 : 16 }]}>
          <WorkoutFocusIcon
            focus="Rest Day"
            stimulus="recovery"
            color={workoutPalette.strong}
            size={restHero ? 56 : 44}
            muted={!isToday}
            style={styles.dayFocusIcon}
          />
          <View style={styles.dayCardRight}>
            <View style={styles.focusHeaderRow}>
              {isToday && (
                <View style={[styles.dayStatusPill, { backgroundColor: workoutPalette.strong + '18', borderColor: workoutPalette.strong + '55' }]}>
                  <Text style={[styles.dayStatusPillText, { color: workoutPalette.strong }]}>TODAY</Text>
                </View>
              )}
              <View style={[styles.restBadge, { backgroundColor: isLightMode ? tc.surface : tc.surfaceRaised, borderColor: quietBorderColor, borderWidth: quietBorderWidth }]}>
                <Text style={[styles.restBadgeText, { color: cardSecondaryColor }]}>Rest Day</Text>
              </View>
            </View>
          </View>
        </View>
        <Text style={[styles.restHint, { color: cardMetaColor }]}>Recovery & light stretching</Text>
        {canSwitchOff && (
          <TouchableOpacity
            onPress={() => onChangeFocus?.('Custom')}
            activeOpacity={0.75}
            testID="switch-to-workout-cta"
            accessibilityLabel="switch-to-workout-cta"
            style={[styles.secondaryActionBtn, { marginTop: 12, backgroundColor: workoutPalette.strong + '10', borderColor: workoutPalette.strong + '40' }]}>
            <View style={[styles.secondaryActionIcon, { backgroundColor: workoutPalette.strong + '18' }]}>
              <Ionicons name="swap-horizontal-outline" size={16} color={workoutPalette.strong} />
            </View>
            <View style={styles.secondaryActionCopy}>
              <Text style={[styles.secondaryActionTitle, { color: workoutPalette.strong }]}>Switch to workout</Text>
              <Text style={[styles.secondaryActionSub, { color: cardMetaColor }]} numberOfLines={1}>Choose a training focus</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={workoutPalette.strong} />
          </TouchableOpacity>
        )}
      </View>
    );
  }

  // Skipped day
  if (isSkipped) {
    const skippedTitle = skippedDayTitle(item.workout?.focus, skipReason);
    const skippedBadge = skippedDayBadgeLabel(skipReason);
    const skippedUndo = skippedDayUndoLabel(skipReason);
    return (
      <View style={[styles.dayCard, styles.dayCardSkipped, { backgroundColor: tc.surface, borderColor: quietBorderColor, borderWidth: quietBorderWidth, ...cardShadow(false) }]}>
        <View style={[styles.dayCardRow, { paddingTop: 16 }]}>
          <WorkoutFocusIcon
            focus={item.workout?.focus ?? skippedTitle}
            stimulus={item.workout?.stimulus}
            color={tc.warning}
            size={42}
            muted
            style={styles.dayFocusIcon}
          />
          <View style={styles.dayCardRight}>
            <View style={styles.skippedFocusHeaderRow}>
              {isToday && (
                <View style={[styles.dayStatusPill, { backgroundColor: tc.warning + '18', borderColor: tc.warning + '55' }]}>
                  <Text style={[styles.dayStatusPillText, { color: tc.warning }]}>TODAY</Text>
                </View>
              )}
              <Text
                testID={workoutDayCardTitleTestID(skippedTitle)}
                accessibilityLabel={skippedTitle}
                style={[styles.focusLabel, { color: tc.textPrimary }]}
                numberOfLines={2}
              >
                {skippedTitle}
              </Text>
              {(() => {
                const stim = item.workout?.stimulus || (() => {
                  // Infer stimulus from focus name for old cached plans
                  // that don't have the stimulus field yet.
                  const f = (item.workout?.focus ?? '').toLowerCase();
                  const STIM_KEYWORDS: [string[], string][] = [
                    [['heavy', 'strength'], 'strength'],
                    [['volume'], 'volume'],
                    [['power'], 'power'],
                    [['cardio', 'zone', 'interval'], 'conditioning'],
                    [['mobility', 'stretch', 'yoga'], 'mobility'],
                    [['recovery', 'easy'], 'recovery'],
                  ];
                  for (const [keywords, stim] of STIM_KEYWORDS) {
                    if (keywords.some(kw => f.includes(kw))) return stim;
                  }
                  // Default lifting days to hypertrophy if focus matches a lift family
                  if (resolveFocusMuscleKey(f)) return 'hypertrophy';
                  return null;
                })();
                if (!stim || stim === 'conditioning' || stim === 'mobility' || stim === 'recovery') return null;
                const stimLabel = stim === 'strength' ? 'HEAVY' : stim === 'hypertrophy' ? 'HYPERTROPHY' : stim === 'volume' ? 'VOLUME' : stim.toUpperCase();
                const stimColor = stim === 'strength' ? '#EF4444' : stim === 'volume' ? '#8B5CF6' : tc.primary;
                return (
                  <View style={[styles.stimulusBadge, { backgroundColor: stimColor + '18' }]}>
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
          <View
            testID="workout-day-card-skip-badge"
            accessibilityLabel={skippedBadge}
            style={[styles.skippedBadge, { backgroundColor: tc.warning + '22', borderColor: tc.warning }]}
          >
            <Text style={[styles.skippedBadgeText, { color: tc.warning }]}>{skippedBadge}</Text>
          </View>
        </View>
        <View style={styles.actionRow}>
          <TouchableOpacity
            testID="workout-day-card-unskip"
            accessibilityLabel={skippedUndo}
            style={[styles.unskipBtn, { backgroundColor: tc.primary + '10', borderColor: tc.primary + (isLightMode ? '44' : '50'), borderWidth: quietBorderWidth }]}
            onPress={onUnskip}
          >
            <View style={[styles.secondaryActionIcon, { backgroundColor: tc.primary + '18' }]}>
              <Ionicons name="refresh" size={16} color={tc.primary} />
            </View>
            <Text style={[styles.unskipBtnText, { color: tc.primary }]}>{skippedUndo}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // The active workout is the hero. Completed days keep the same visual
  // language but shrink back so the live next action stays obvious.
  const accentColor = workoutPalette.strong;
  const isHeroCard = isToday && !isCompleted;
  const isCompletedPast = isCompleted && !isToday;
  const borderColor = isToday
    ? accentColor + (isLightMode ? 'AA' : '')
    : isCompleted
      ? isLightMode ? quietBorderColor : accentColor + '44'
      : quietBorderColor;
  const cardBg = isHeroCard && !isLightMode ? tc.surfaceRaised : tc.surface;
  const todayAccentHeight = isHeroCard ? (isLightMode ? 3 : 4) : 2;
  const collapsedEstimateMinutes = estimateWorkoutMinutes(item.workout!, sessionMinutes);
  const startWorkoutTextColor = getContrastingTextColor(accentColor);
  const hasReadinessBadge = isToday && !isCompleted && readinessBadge && readinessBadge.label !== '—' && readinessBadge.score > 0;
  const showRecoveringBadge = isToday && isCompleted;
  const readinessColor = hasReadinessBadge
    ? readinessBadge.label === 'Primed' || readinessBadge.label === 'Ready'
      ? accentColor
      : readinessBadge.label === 'Moderate' ? tc.warning : tc.error
    : accentColor;

  return (
    <View
      style={[
        styles.dayCard,
        {
          backgroundColor: cardBg,
          borderColor,
          borderWidth: isHeroCard ? (isLightMode ? 1 : 1.5) : quietBorderWidth,
          borderStyle: 'solid',
          opacity: isCompletedPast ? 0.86 : 1,
          paddingBottom: isCompleted ? 12 : isHeroCard ? 18 : 16,
          ...cardShadow(isHeroCard),
        },
      ]}>
      {(isToday || isCompleted) && (
        <View style={[styles.dayCardTopAccent, { backgroundColor: accentColor, height: todayAccentHeight, marginBottom: isHeroCard ? 14 : 10, opacity: isCompletedPast ? 0.38 : isLightMode ? 0.72 : 1 }]} />
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
      <TouchableOpacity
        style={[styles.dayCardRow, isHeroCard && styles.dayCardRowToday, { paddingTop: (isToday || isCompleted) ? 0 : 16 }]}
        onPress={onPress}
        activeOpacity={0.8}
        disabled={isRegenerating}
        accessibilityRole="button"
        accessibilityLabel={`${dow} ${dateStr} ${item.workout!.focus}`}>
        <WorkoutFocusIcon
          focus={item.workout!.focus}
          stimulus={item.workout?.stimulus}
          color={accentColor}
          size={isHeroCard ? 60 : isCompleted ? 42 : 46}
          muted={isCompletedPast}
          style={[styles.dayFocusIcon, isHeroCard && styles.dayFocusIconToday]}
        />
        <View style={[styles.dayCardRight, isHeroCard && styles.dayCardRightToday]}>
          <View style={[styles.focusHeaderRow, isHeroCard && styles.focusHeaderRowToday]}>
            {isToday && (
              <View style={[styles.dayStatusPill, { backgroundColor: accentColor + '18', borderColor: accentColor + '55' }]}>
                <Text style={[styles.dayStatusPillText, { color: accentColor }]}>TODAY</Text>
              </View>
            )}
            <FocusLabelCrossfade
              focus={item.workout!.focus}
              testID={workoutDayCardTitleTestID(item.workout!.focus)}
              accessibilityLabel={item.workout!.focus}
              style={[
                styles.focusLabel,
                {
                  color: isCompletedPast ? cardSecondaryColor : tc.textPrimary,
                  textDecorationLine: 'none',
                  fontSize: isHeroCard ? 20 : isCompleted ? 15 : 16,
                  fontWeight: isHeroCard ? '900' : '800',
                  lineHeight: isHeroCard ? 24 : isCompleted ? 19 : undefined,
                },
              ]}
            />
            {hasReadinessBadge && (
              <View style={[styles.readinessHeaderChip, { backgroundColor: readinessColor + '18', borderColor: readinessColor + '55' }]}>
                <Ionicons name="battery-charging-outline" size={11} color={readinessColor} />
                <Text style={[styles.readinessHeaderText, { color: readinessColor }]}>
                  {readinessBadge.score} READY
                </Text>
              </View>
            )}
            {showRecoveringBadge && (
              <View style={[styles.recoveringHeaderChip, { backgroundColor: tc.success + '18', borderColor: tc.success + '55' }]}>
                <Ionicons name="leaf-outline" size={11} color={tc.success} />
                <Text style={[styles.readinessHeaderText, { color: tc.success }]}>
                  RECOVERING
                </Text>
              </View>
            )}
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
            const stim = item.workout?.stimulus;
            const countText = `~${collapsedEstimateMinutes} min · ${item.workout!.exercises.length} exercises`;
            // Mobility / recovery / stretch / flow days get a single
            // collapsed label instead of a list of stretched muscles.
            // Use the structured stimulus field when available, fall back
            // to focus keywords for old cached plans.
            if (stim === 'mobility' || (!stim && ['mobility', 'stretch', 'yoga', 'flow'].some(kw => focusLower.includes(kw)))) {
              return (
                <Text testID="workout-estimated-duration" style={[styles.exerciseCount, { color: cardMetaColor }]} numberOfLines={1}>
                  {countText} · Mobility
                </Text>
              );
            }
            if (stim === 'recovery' || (!stim && ['recover', 'rest'].some(kw => focusLower.includes(kw)))) {
              return (
                <Text testID="workout-estimated-duration" style={[styles.exerciseCount, { color: cardMetaColor }]} numberOfLines={1}>
                  {countText} · Recovery
                </Text>
              );
            }
            if (stim === 'conditioning' || (!stim && ['cardio', 'zone2', 'zone 2', 'interval'].some(kw => focusLower.includes(kw)))) {
              return (
                <Text testID="workout-estimated-duration" style={[styles.exerciseCount, { color: cardMetaColor }]} numberOfLines={1}>
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
              chest: 'Chest', back: 'Back', lats: 'Back', shoulders: 'Shoulders',
              rear_delt: 'Shoulders',
              biceps: 'Arms', triceps: 'Arms',
              quads: 'Legs', hamstrings: 'Legs', calves: 'Legs',
              glutes: 'Glutes', core: 'Core', cardio: 'Cardio',
              full_body: 'Full Body',
            };
            const CHIP_ALLOWED_MUSCLES: Record<string, string[]> = {
              push: ['chest', 'shoulders', 'triceps'],
              chest: ['chest', 'triceps'],
              pull: ['back', 'lats', 'biceps', 'rear_delt'],
              back: ['back', 'lats', 'biceps', 'rear_delt'],
              legs: ['quads', 'hamstrings', 'glutes', 'calves'],
              lower: ['quads', 'hamstrings', 'glutes', 'calves'],
              upper: ['chest', 'back', 'lats', 'shoulders', 'biceps', 'triceps'],
              shoulders: ['shoulders', 'rear_delt'],
              arms: ['biceps', 'triceps'],
            };
            const focusKey = resolveFocusMuscleKey(focusLower);
            const allowedForFocus: Set<string> | null =
              focusKey && CHIP_ALLOWED_MUSCLES[focusKey]
                ? new Set(CHIP_ALLOWED_MUSCLES[focusKey])
                : null; // full body, cardio, unknown — allow everything
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
              <Text testID="workout-estimated-duration" style={[styles.exerciseCount, { color: cardMetaColor }]} numberOfLines={1}>
                {countText}{muscleText}
              </Text>
            );
          })()}
        </View>
        {isCompleted ? (
          <View style={[styles.completeBadge, { backgroundColor: tc.success + '18', borderColor: tc.success + (isLightMode ? '66' : '77'), borderWidth: quietBorderWidth }]}>
            <Text style={[styles.completeBadgeText, { color: tc.success }]}>Done</Text>
          </View>
        ) : (
          <View style={styles.chevron}>
            <ExpandingChevron expanded={expanded} color={tc.textMuted} size={16} />
          </View>
        )}
      </TouchableOpacity>
      {hasReadinessBadge && (() => {
        const rc = readinessColor;
        return (
          <TouchableOpacity
            onPress={onReadinessTap}
            activeOpacity={0.8}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 10,
              paddingHorizontal: 14, paddingVertical: 13,
              marginTop: 8,
              borderTopWidth: quietBorderWidth, borderTopColor: quietBorderColor,
            }}>
            <View style={{
              width: 32, height: 32, borderRadius: 16,
              backgroundColor: rc + '18',
              alignItems: 'center', justifyContent: 'center',
            }}>
              <Text style={{ fontSize: 13, fontWeight: '900', color: rc }}>{readinessBadge.score}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textPrimary }}>Training Readiness · <Text style={{ color: rc }}>{readinessBadge.label}</Text></Text>
            </View>
            <Ionicons name="chevron-forward" size={12} color={cardMetaColor} />
          </TouchableOpacity>
        );
      })()}

      {isToday && !isCompleted && !isSkipped && (
        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingBottom: 14, paddingTop: 10 }}>
          <PulseView active intensity={0.02} duration={2000} style={{ flex: 2 }}>
            <PressableScale
              onPress={() => { import('../utils/feedback').then(f => f.hapticHeavy()).catch(() => {}); onStartWorkout(item.workout!); }}
              style={{ width: '100%' }}
              accessibilityRole="button"
              accessibilityLabel="start-workout-cta"
              testID="start-workout-cta">
              <View testID="start-workout-cta-visible" style={[styles.startWorkoutBtn, { shadowColor: accentColor }]}>
                <View style={[styles.startWorkoutBody, { backgroundColor: accentColor }]}>
                  <View style={[styles.startWorkoutIconBadge, { backgroundColor: startWorkoutTextColor + '24' }]}>
                    <Ionicons name="play" size={17} color={startWorkoutTextColor} style={{ marginLeft: 2 }} />
                  </View>
                  <View style={styles.startWorkoutCopy}>
                    <Text style={[styles.startWorkoutBtnText, { color: startWorkoutTextColor }]}>Start Workout</Text>
                  </View>
                </View>
              </View>
            </PressableScale>
          </PulseView>
          <Pressable
            style={[styles.skipSecondaryBtn, { borderColor: quietBorderColor, borderWidth: quietBorderWidth, backgroundColor: isLightMode ? tc.surface : tc.surfaceRaised }]}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            onPress={() => {
              import('../utils/feedback').then(f => f.hapticWarning()).catch(() => {});
              onSkip(item.workout!.focus);
            }}
            accessibilityRole="button"
            accessibilityLabel="Skip today's workout">
            <View style={[styles.skipActionIcon, { backgroundColor: tc.textMuted + '18' }]}>
              <Ionicons name="close" size={15} color={cardSecondaryColor} />
            </View>
            <Text style={[styles.skipSecondaryBtnText, { color: cardSecondaryColor }]}>Skip</Text>
          </Pressable>
        </View>
      )}
      <AnimatedCollapsible visible={expanded} duration={360} slideDistance={14}>
        <View style={styles.expandedContent}>
          {isCompleted ? (
            <View style={{ gap: 10 }}>
              <View style={[styles.completedBanner, { backgroundColor: tc.success + '14', borderColor: tc.success + (isLightMode ? '55' : '77'), borderWidth: quietBorderWidth }]}>
                <Text style={[styles.completedBannerText, { color: tc.success }]}>
                  {isToday
                    ? 'Completed today'
                    : `Workout completed ${DAY_NAMES[item.date.getDay()]}, ${MONTH_NAMES[item.date.getMonth()]} ${item.date.getDate()}`}
                </Text>
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
                  style={[styles.quietActionBtn, { backgroundColor: isLightMode ? tc.surface : tc.surfaceRaised, borderColor: quietBorderColor, borderWidth: quietBorderWidth }]}>
                  <Ionicons name="return-down-back-outline" size={14} color={cardSecondaryColor} />
                  <Text style={[styles.quietActionText, { color: cardSecondaryColor }]}>
                    Mark as not done
                  </Text>
                </TouchableOpacity>
              )}
              {completedSummary ? (
                <View style={[styles.completedBanner, { backgroundColor: isLightMode ? tc.surface : tc.surfaceRaised, borderColor: quietBorderColor, borderWidth: quietBorderWidth, gap: 7, alignItems: 'flex-start' }]}>
                  <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>
                      {completedSummary.totalSets} sets
                    </Text>
                    <Text style={{ fontSize: 13, color: cardMetaColor }}>·</Text>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>
                      {completedSummary.totalReps} reps
                    </Text>
                    {completedSummary.caloriesBurned > 0 && (
                      <>
                        <Text style={{ fontSize: 13, color: cardMetaColor }}>·</Text>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>
                          ~{completedSummary.caloriesBurned} kcal
                        </Text>
                      </>
                    )}
                    {completedSummary.hrAvg && completedSummary.hrAvg > 0 && (
                      <>
                        <Text style={{ fontSize: 13, color: cardMetaColor }}>·</Text>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>
                          {completedSummary.hrAvg} avg bpm
                        </Text>
                      </>
                    )}
                  </View>
                  <Text style={{ fontSize: 12, color: cardSecondaryColor, lineHeight: 18 }}>
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
                      testID="change-focus-toggle"
                      accessibilityLabel="change-focus-toggle"
                      style={[styles.secondaryActionBtn, { backgroundColor: workoutPalette.strong + '0E', borderColor: workoutPalette.strong + '40' }]}
                      onPress={onToggleSwitch}>
                      <View style={[styles.secondaryActionIcon, { backgroundColor: workoutPalette.strong + '18' }]}>
                        <Ionicons name="swap-horizontal-outline" size={16} color={workoutPalette.strong} />
                      </View>
                      <View style={styles.secondaryActionCopy}>
                        <Text style={[styles.secondaryActionTitle, { color: workoutPalette.strong }]}>Change Focus</Text>
                        <Text style={[styles.secondaryActionSub, { color: cardMetaColor }]} numberOfLines={1}>Compare readiness by muscle group</Text>
                      </View>
                      <Ionicons name="chevron-down" size={16} color={workoutPalette.strong} />
                    </TouchableOpacity>
                  ) : (
                    <View style={{ backgroundColor: isLightMode ? tc.surface : tc.surfaceRaised, borderRadius: 12, padding: 12, borderWidth: quietBorderWidth, borderColor: quietBorderColor }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>Change focus to:</Text>
                        <TouchableOpacity
                          onPress={onToggleSwitch}
                          testID="change-focus-close"
                          accessibilityLabel="change-focus-close"
                          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                          <Ionicons name="close-circle" size={20} color={cardMetaColor} />
                        </TouchableOpacity>
                      </View>
                      {/* Readiness dial grid — the circle + score is the
                          hero; the focus label is a small muted caption
                          underneath. Uses a dashed inner ring and
                          transparent background so the tiles don't
                          visually repeat the day card below. */}
                      <Text style={{ fontSize: 10, color: cardMetaColor, marginBottom: 8, fontStyle: 'italic' }}>
                        Numbers show today's readiness for that focus. Higher = fresher.
                      </Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                        {splitOptions.filter(f => f !== item.workout?.focus).map(focus => {
                          const w = optionWarnings?.[focus];
                          const hasConflict = !!w?.conflict;
                          const lowReady = w?.readiness != null && w.readiness < 40;
                          const warned = hasConflict || lowReady;
                          const tier = w?.readiness == null ? cardMetaColor
                            : w.readiness >= 70 ? tc.success
                            : w.readiness >= 40 ? tc.warning
                            : tc.error;
                          const tierLabel = w?.readiness == null ? 'Unknown'
                            : w.readiness >= 70 ? 'Fresh'
                            : w.readiness >= 40 ? 'Moderate'
                            : 'Tired';
                          const warnTitle = hasConflict && lowReady
                            ? 'Stacked stress'
                            : hasConflict
                              ? 'Adjacent overlap'
                              : lowReady
                                ? 'Low readiness'
                                : null;
                          const riskCopy = hasConflict && lowReady
                            ? 'this repeats a similar muscle family near a fixed day while readiness is low, so soreness and under-recovery are more likely'
                            : hasConflict
                              ? 'this repeats a similar muscle family too close to a completed or fixed workout'
                              : lowReady
                                ? `readiness is ${w.readiness}%, which means the target muscles are probably still recovering`
                                : null;
                          const warnMsg = warnTitle && riskCopy
                            ? `${warnTitle}: ${riskCopy}`
                            : null;
                          const handlePick = () => {
                            const apply = () => { onChangeFocus(focus); };
                            if (warned && warnMsg) {
                              Alert.alert(
                                `Switch to ${focus}?`,
                                `${warnMsg}.\n\nWhy this is risky: fatigue can stack faster than the planner expects if you override the week structure. You can still proceed if that trade-off is intentional.`,
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
                              testID={`change-focus-option-${e2eId(focus)}`}
                              accessibilityLabel={`change-focus-option-${e2eId(focus)}`}
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
                                <>
                                  <View style={{ position: 'absolute', top: 2, right: 2 }}>
                                    <Ionicons name="warning" size={12} color={tc.warning} />
                                  </View>
                                  {warnTitle && riskCopy ? (
                                    <View style={[styles.changeFocusRiskPill, { borderColor: tc.warning + '66', backgroundColor: tc.warning + '16' }]}>
                                      <Text {...dynamicCompactTextProps} style={[styles.changeFocusRiskLabel, { color: tc.warning }]}>
                                        Why risky
                                      </Text>
                                      <Text {...dynamicCompactTextProps} style={[styles.changeFocusRiskText, { color: tc.textSecondary }]} numberOfLines={3}>
                                        {riskCopy}
                                      </Text>
                                    </View>
                                  ) : null}
                                </>
                              )}
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </View>
                  )}
                </View>
              )}
              <WorkoutCard
                embedded
                workout={item.workout!}
                themeName={themeName}
                sessionMinutes={sessionMinutes}
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
    </View>
  );
}

// Memo wrap: HomeScreen has 121+ useState calls and re-renders constantly.
// Without this, every state change in the parent re-rendered every DayCard
// even when its inputs hadn't changed. Custom comparator ignores callback
// identity (those are recreated each render but behave identically) and
// compares value props by reference — `item` is now stable thanks to the
// useMemo'd `schedule` derivation. `splitOptions`/`optionWarnings` are
// expected to be stable enough; if they start re-creating per-render,
// memoize them at the call site.
const DayCard = React.memo(DayCardImpl, (prev, next) => {
  return (
    prev.item === next.item
    && prev.themeName === next.themeName
    && prev.isToday === next.isToday
    && prev.isCompleted === next.isCompleted
    && prev.isSkipped === next.isSkipped
    && prev.skipReason === next.skipReason
    && prev.completedSummary === next.completedSummary
    && prev.expanded === next.expanded
    && prev.splitOptions === next.splitOptions
    && prev.optionWarnings === next.optionWarnings
    && prev.showSwitchOptions === next.showSwitchOptions
    && prev.hasPlateauedExercises === next.hasPlateauedExercises
    && prev.isRegenerating === next.isRegenerating
    && prev.sessionMinutes === next.sessionMinutes
    && prev.readinessBadge === next.readinessBadge
  );
});

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

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 12, paddingRight: 16, paddingBottom: 10, borderBottomWidth: 1, zIndex: 40 },
  headerLogoWrap: { height: 70, justifyContent: 'center', alignItems: 'flex-start' },
  headerLogo: { width: 280, height: 70 },
  headerLogoDark: { width: 280, height: 70 },
  greeting:            { ...typography.hero, color: colors.textPrimary, marginBottom: 6 },
  headerBadgeRow:  { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 4 },
  goalBadge:       { backgroundColor: colors.surface, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.primary },
  goalBadgeText:   { fontSize: 11, color: colors.primary, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase' },
  goalSubText:     { fontSize: 11, color: colors.textSecondary, marginTop: 2, letterSpacing: 0.1 },
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
  planProtectionNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 14,
    maxWidth: 320,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 12,
  },
  planProtectionTitle: { fontSize: 12, fontWeight: '800', marginBottom: 2 },
  planProtectionBody: { fontSize: 11, lineHeight: 16 },

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

  // Bottom tab bar — split shell/inner pill so the shadow floats above
  // content instead of looking like a full-width slab behind the dock.
  bottomBarShell: {
    position: 'absolute',
    left: 14,
    right: 14,
    bottom: 0,
    height: 64,
    borderRadius: 32,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 16,
    zIndex: 50,
  },
  bottomBar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderRadius: 32,
    borderWidth: 1.5,
    overflow: 'hidden',
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
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    zIndex: 6,
  },
  // Pill segmented control. Full-radius capsule container; active
  // segments get a translucent tint fill rather than a solid fill so
  // the selection reads as a glow instead of a block.
  segmentedWrap: {
    flex: 1,
    width: '100%',
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'stretch',
    padding: 4,
    borderRadius: 999,
    borderWidth: 1,
    gap: 2,
    ...elevations.subtle,
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
  checkinLabel: { flex: 1, fontSize: 10, fontWeight: '600', letterSpacing: 1.0, textTransform: 'uppercase' },
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
    bottom: 124,     // above the floating bottom tab bar
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
    paddingBottom: 166,
  },

  weekStripWrap: {
    marginBottom: 12,
    gap: 8,
  },
  weekStripHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  weekStripLabel: {
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  weekStripSelection: {
    flex: 1,
    textAlign: 'right',
    fontSize: 11,
    fontWeight: '700',
  },
  weekStripDays: {
    flexDirection: 'row',
    gap: 6,
    paddingTop: 6,
  },
  weekDayChip: {
    flex: 1,
    minHeight: 58,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    position: 'relative',
  },
  weekDayTodayMarker: {
    position: 'absolute',
    top: -5,
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  weekDayName: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  weekDayDate: {
    fontSize: 16,
    fontWeight: '900',
    marginTop: 1,
  },
  weekDayDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    marginTop: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Sub-tab bar (Plan / Library / Settings / History) ──────────────────
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
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderRadius: radius.full,
    ...elevations.subtle,
  },
  askAiIcon: { width: 16, height: 16 },
  askAiText: { fontSize: 12, fontWeight: '800', letterSpacing: 0.3, color: '#FFFFFF' },

  // ── Profile tab ─────────────────────────────────────────────────────────
  profileHero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderRadius: 20,
    borderWidth: 1,
    padding: 16,
    marginBottom: 14,
    ...elevations.card,
  },
  profileAvatar: {
    width: 56, height: 56, borderRadius: 28,
    borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  profileAvatarEdit: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
    minHeight: 58,
    paddingVertical: 12,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  profileThemeSwatch: {
    width: 36,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
    flexDirection: 'row',
  },
  profileThemeLabel: { flex: 1, flexShrink: 1, fontSize: 12, lineHeight: 15, fontWeight: '700' },
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
    borderRadius: radius.lg,
    padding: 14,
    marginBottom: 12,
    gap: 8,
    ...elevations.subtle,
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
    borderRadius: radius.lg,
    padding: 14,
    marginBottom: 12,
    gap: 8,
    ...elevations.subtle,
  },
  warmupTitle: { fontSize: 14, fontWeight: '800' },
  warmupStep: { fontSize: 12, color: colors.textPrimary, lineHeight: 18 },

  tabs:      { flexDirection: 'row', marginHorizontal: 16, marginTop: 14, marginBottom: 14, borderRadius: radius.full, padding: 4, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  tab:       { flex: 1, paddingVertical: 10, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center' },
  tabActive: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.18, shadowRadius: 4, elevation: 3 },
  tabText:   { fontSize: 14, fontWeight: '700', letterSpacing: 0.2 },

  scrollView:    { flex: 1 },
  profileScrollView: { flex: 1, zIndex: 40 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 166 },

  dayCard:         { backgroundColor: colors.surface, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, paddingHorizontal: 16, paddingBottom: 16, paddingTop: 0, marginBottom: 16, overflow: 'hidden', ...elevations.card },
  dayCardTopAccent: { height: 3, marginBottom: 12, borderRadius: 0 },
  dayCardToday:    { borderColor: colors.primary },
  dayCardComplete: { borderColor: colors.success },
  dayCardSkipped:  { opacity: 0.74 },
  dayCardRow:      { flexDirection: 'row', alignItems: 'center' },
  dayCardRowToday: { alignItems: 'flex-start' },
  dayFocusIcon:    { marginRight: 10 },
  dayFocusIconToday: { marginTop: 1 },
  dayCardRight:    { flex: 1, minWidth: 0 },

  focusLabel:    { fontSize: 16, fontWeight: '700', color: colors.textPrimary, marginBottom: 2, flexShrink: 1 },
  dayCardRightToday: { paddingTop: 0 },
  focusHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  focusHeaderRowToday: { alignItems: 'flex-start', gap: 8 },
  skippedFocusHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 },
  stimulusBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, flexShrink: 0 },
  dayStatusPill: { borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 6, paddingVertical: 2 },
  dayStatusPillText: { fontSize: 9, fontWeight: '900', letterSpacing: 0.6 },
  readinessHeaderChip: { flexDirection: 'row', alignItems: 'center', gap: 3, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 6, paddingVertical: 2 },
  recoveringHeaderChip: { flexDirection: 'row', alignItems: 'center', gap: 3, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 6, paddingVertical: 2 },
  readinessHeaderText: { fontSize: 9, fontWeight: '900', letterSpacing: 0.4 },
  exerciseCount: { fontSize: 13, color: colors.textMuted },
  chevron:       { width: 22, height: 22, marginLeft: 8, alignItems: 'center', justifyContent: 'center' },

  completeBadge:     { backgroundColor: colors.success + '22', borderRadius: radius.full, paddingHorizontal: 8, paddingVertical: 3, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.success },
  completeBadgeText: { fontSize: 11, color: colors.success, fontWeight: '800' },

  skippedBadge:     { backgroundColor: colors.warning + '22', borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: colors.warning, flexShrink: 0, marginLeft: 8 },
  skippedBadgeText: { fontSize: 12, color: colors.warning, fontWeight: '600' },
  skippedHint:      { fontSize: 12, color: colors.textMuted, marginTop: 10 },

  restBadge:     { backgroundColor: colors.surfaceRaised, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  restBadgeText: { fontSize: 12, color: colors.textSecondary, fontWeight: '500' },
  restHint:      { fontSize: 12, color: colors.textMuted, marginTop: 8 },

  expandedContent: { marginTop: 12 },
  emptyStateCard: {
    padding: 24,
    alignItems: 'center',
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: 8,
  },
  emptyStateTitle: { fontSize: 15, fontWeight: '800', textAlign: 'center' },
  emptyStateBody: { fontSize: 12, lineHeight: 18, textAlign: 'center' },
  changeFocusRiskPill: {
    width: '100%',
    marginTop: 8,
    paddingHorizontal: 7,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  changeFocusRiskLabel: { fontSize: 8, fontWeight: '900', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 2 },
  changeFocusRiskText: { fontSize: 9, lineHeight: 12, textAlign: 'center' },

  completedBanner:     { backgroundColor: colors.success + '1A', borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 9, alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.success },
  completedBannerText: { fontSize: 12, fontWeight: '800', color: colors.success },

  todayPlanCardsWrap: { marginTop: -4, marginBottom: 12, gap: 10 },
  todayActivitySection: { gap: 8 },
  todayActivityHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  todayActivityHeader: { fontSize: 13, fontWeight: '900', letterSpacing: 0.2 },
  todayActivityCount: { fontSize: 11, fontWeight: '700' },
  todayTemplateBlock: { gap: 8, marginTop: 4 },
  todayTemplateLaunchArea: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10 },
  todayTemplateIconBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  todayActivityLoggedCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: 8,
    borderWidth: 1,
  },
  todayActivityIconBubble: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  todayActivityTitle: { fontSize: 14, fontWeight: '800' },
  todayActivityMeta: { fontSize: 11, marginTop: 2 },
  todayActivityQuickRow: { flexDirection: 'row', gap: 7 },
  todayActivityQuickAction: {
    flex: 1,
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 8,
  },
  todayActivityQuickText: { fontSize: 11, fontWeight: '900' },

  actionRow:       { flexDirection: 'row', gap: 10, marginTop: 12 },
  skipLink:        { alignSelf: 'center', paddingVertical: 8, paddingHorizontal: 4 },
  skipLinkText:    { fontSize: 12, fontWeight: '400', textDecorationLine: 'underline' },
  secondaryActionBtn: {
    minHeight: 50,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  secondaryActionIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  secondaryActionCopy: { flex: 1, minWidth: 0 },
  secondaryActionTitle: { fontSize: 13, fontWeight: '900', letterSpacing: 0.1 },
  secondaryActionSub: { fontSize: 10, fontWeight: '700', marginTop: 1 },
  quietActionBtn: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  quietActionText: { fontSize: 11, fontWeight: '800' },
  skipSecondaryBtn: {
    flex: 1,
    height: 58,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderRadius: radius.lg,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  skipActionIcon: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skipSecondaryBtnText: { fontSize: 12, fontWeight: '800', letterSpacing: 0.2 },
  unskipBtn:       { backgroundColor: colors.surface, borderRadius: radius.md, paddingVertical: 10, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.primary, flex: 1, flexDirection: 'row', gap: 9 },
  unskipBtnText:   { color: colors.primary, fontSize: 13, fontWeight: '900' },
  startWorkoutBtn: {
    width: '100%',
    borderRadius: radius.lg,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.34,
    shadowRadius: 14,
    elevation: 7,
  },
  startWorkoutBody: {
    height: 58,
    borderRadius: radius.lg,
    paddingHorizontal: 10,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    overflow: 'hidden',
  },
  startWorkoutIconBadge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  startWorkoutCopy: { flex: 1, minWidth: 0 },
  startWorkoutBtnText: { color: '#FFFFFF', fontSize: 14, fontWeight: '900', letterSpacing: 0.1 },

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
    marginBottom: 12,
    overflow: 'hidden',
  },
  mealAccordionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'transparent',
  },
  mealAccordionTitle: { fontSize: 18, fontWeight: '700', color: colors.textPrimary },
  mealAccordionMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2, fontWeight: '500' },
  mealAccordionChevron: { fontSize: 11, color: colors.textMuted, marginLeft: 8 },
  mealExpansionRail: {
    paddingHorizontal: 12,
    paddingBottom: 12,
    marginTop: -2,
  },
  mealHydrationPanel: {
    marginHorizontal: 14,
    marginTop: 0,
    marginBottom: 14,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderTopWidth: 0,
  },

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
  libraryVirtualList: { flex: 1 },
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
  libraryResultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: -2,
    marginBottom: 10,
  },
  libraryResultText: { fontSize: 11, fontWeight: '700' },
  libraryResultClear: { fontSize: 12, fontWeight: '800' },
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
  coachActionResultCard: {
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    gap: 5,
  },
  coachActionResultTitle: { fontSize: 12, fontWeight: '800' },
  coachActionResultSummary: { fontSize: 12, lineHeight: 17 },
  coachActionResultMeta: { fontSize: 11, fontWeight: '600' },
  coachActionUndoBtn: {
    marginTop: 4,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  coachActionUndoText: { fontSize: 11, fontWeight: '800' },
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
