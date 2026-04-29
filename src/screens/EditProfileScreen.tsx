import React, { useState, useEffect, useRef } from 'react';
import PressableScale from '../components/PressableScale';
import AsyncStorage from '@react-native-async-storage/async-storage';
import BarcodeScannerModal from '../components/BarcodeScannerModal';
import FormVideoModal from '../components/FormVideoModal';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  TextInput, Modal, KeyboardAvoidingView, Platform, ActivityIndicator, Alert, Image, Linking, Keyboard,
  LayoutAnimation, UIManager, Animated, Easing, useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import FadeInView from '../components/FadeInView';
import BirthdateInput from '../components/BirthdateInput';
import { deriveAge } from '../utils/age';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
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
import { UserProfile, CustomFoodItem, GoalPace, GoalSelection, SavedMealTemplate, AppThemeName, InjuryEntry, InjuryStatus, MealRoutineEntry, MealRoutineFood, Gender, StrengthEquipmentSettings } from '../types';
import { useMetaData, pacesForGoal } from '../hooks/useMetaData';
import { APP_THEMES, THEME_PICKER_ORDER, colors, getTheme, radius, resolveThemeName } from '../constants/theme';
import { analyzeFoodPhoto, scanFoodsPhoto, getExercises, searchFoodNutrition, searchExerciseAI, AIExerciseResult, getCalorieRanges, CalorieRanges } from '../services/api';
import {
  LAUNCH_GOALS, GOAL_CATEGORIES, goalCategory,
} from '../constants/goalConfig';
import { loadMealRoutines, saveMealRoutines } from '../utils/workoutHistory';
import { MUSCLE_LIBRARY, MuscleEntry } from '../constants/muscleLibrary';
import SearchInput from '../components/SearchInput';
import { ExerciseLibraryItem, humanizeToken, buildExerciseGuide } from '../utils/exerciseGuide';
import { tierOf } from '../utils/subscription';
import {
  DEFAULT_ADJUSTABLE_DUMBBELLS,
  DEFAULT_PLATE_PAIRS_LBS,
  PLATE_PAIR_OPTIONS_LBS,
  hasAdjustableDumbbells,
  hasPlateLoadedEquipment,
  normalizeStrengthEquipmentSettings,
} from '../utils/strengthEquipmentSettings';


interface EditProfileScreenProps {
  // Signal to parent that routines were changed so the live meal plans can
  // re-apply them without a full regen. Optional — if absent, changes take
  // effect on the next plan reload.
  onRoutinesChanged?: () => void;
  authToken: string;
  profile: UserProfile;
  onSave: (updated: UserProfile) => void;
  onCancel: () => void;
  mode?: 'goal' | 'workout' | 'mealplan' | 'theme' | 'body';
  // Initial sub-tab when opening in mealplan mode. Lets callers jump
  // straight to Foods / Supplements / Macros instead of the Foods default.
  initialMealTab?: 'foods' | 'supplements' | 'macros';
  // When true, hide the top "Cancel / TITLE / Save" header bar. Used by
  // HomeScreen when this screen is rendered inline as tab content — the
  // bottom nav already provides navigation, so the inner header is
  // redundant. Auto-saves on profile changes via the parent's onSave.
  noHeader?: boolean;
}

interface PhotoMealDraft {
  meal_name: string;
  items: string[];
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

interface ScannedFoodItem {
  name: string;
  serving: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  selected: boolean;
}

// MUSCLE_GROUPS removed — replaced by targetFocusesForGoal() from goalConfig

const DURATION_OPTIONS = [
  { value: 30, label: '20–30 min', desc: 'Express' },
  { value: 45, label: '30–45 min', desc: 'Standard' },
  { value: 60, label: '45–60 min', desc: 'Full' },
  { value: 75, label: '60–75 min', desc: 'Extended' },
  { value: 90, label: '75–90 min', desc: 'Deep' },
];

// ── Reusable single-field input modal ─────────────────────────────────────────

interface InputModalProps {
  visible: boolean;
  title: string;
  subtitle?: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onConfirm: () => void;
  onClose: () => void;
  confirmLabel?: string;
  error?: string;
  keyboardType?: 'default' | 'decimal-pad' | 'number-pad';
  themeColors: ReturnType<typeof getTheme>['colors'];
}

// AnimatedGoalCard — staggered fade + slide-up on mount, spring-scale pulse
// when `active` flips true, and press-down scale feedback. Wraps a Pressable
// so the interaction feels tactile without changing the goal-grid layout.
function AnimatedGoalCard({
  children, delay, active, style, onPress,
}: {
  children: React.ReactNode;
  delay: number;
  active: boolean;
  style: any;
  onPress: () => void;
}) {
  const mount = useRef(new Animated.Value(0)).current;   // 0 → 1 entrance
  const press = useRef(new Animated.Value(1)).current;   // 1 at rest, 0.97 pressed
  const select = useRef(new Animated.Value(1)).current;  // 1 normal, spring to 1.05 → 1 on select
  const wasActive = useRef(active);

  useEffect(() => {
    Animated.timing(mount, {
      toValue: 1,
      duration: 360,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [delay, mount]);

  useEffect(() => {
    if (active && !wasActive.current) {
      Animated.sequence([
        Animated.spring(select, { toValue: 1.04, useNativeDriver: true, damping: 10, stiffness: 220 }),
        Animated.spring(select, { toValue: 1, useNativeDriver: true, damping: 14, stiffness: 240 }),
      ]).start();
    }
    wasActive.current = active;
  }, [active, select]);

  const translateY = mount.interpolate({ inputRange: [0, 1], outputRange: [8, 0] });
  const opacity = mount;

  // Layout styles (width, padding, border) stay on the TouchableOpacity so
  // it participates correctly in the goal grid's flex layout. Only the
  // animated transform + opacity live on the inner Animated.View — those
  // can't affect layout positioning.
  return (
    <TouchableOpacity
      activeOpacity={1}
      onPressIn={() => Animated.spring(press, { toValue: 0.97, useNativeDriver: true, damping: 20, stiffness: 320 }).start()}
      onPressOut={() => Animated.spring(press, { toValue: 1, useNativeDriver: true, damping: 20, stiffness: 320 }).start()}
      onPress={onPress}
      style={style}
    >
      {/* The Animated.View must mirror goalCard's internal flex config
          (alignItems + gap) or the icon + text children collapse to the
          top-left of the card. Width 100% so the scale transform pivots
          around the visual center. */}
      <Animated.View
        style={{
          width: '100%',
          alignItems: 'center',
          gap: 6,
          opacity,
          transform: [{ translateY }, { scale: Animated.multiply(press, select) }],
        }}
      >
        {children}
      </Animated.View>
    </TouchableOpacity>
  );
}

function InputModal({
  visible, title, subtitle, placeholder, value, onChange, onConfirm, onClose,
  confirmLabel = 'Confirm', error, keyboardType = 'default', themeColors: c,
}: InputModalProps) {
  const im = createImStyles(c);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <TouchableOpacity style={im.backdrop} activeOpacity={0.7} onPress={onClose}>
          <View style={im.sheet}>
            <View style={im.handle} />
            <Text style={im.title}>{title}</Text>
            {subtitle ? <Text style={im.subtitle}>{subtitle}</Text> : null}
            <TextInput
              style={im.input}
              value={value}
              onChangeText={onChange}
              placeholder={placeholder}
              placeholderTextColor={c.textMuted}
              keyboardType={keyboardType}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={onConfirm}
            />
            {error ? <Text style={im.error}>{error}</Text> : null}
            <TouchableOpacity style={im.confirmBtn} onPress={onConfirm}>
              <Text style={im.confirmText}>{confirmLabel}</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function createImStyles(c: ReturnType<typeof getTheme>['colors']) { return StyleSheet.create({
  backdrop:    { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet:       { backgroundColor: c.surface, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: 24, paddingBottom: 40, gap: 14, borderTopWidth: 1, borderTopColor: c.border },
  handle:      { width: 36, height: 4, backgroundColor: c.border, borderRadius: 2, alignSelf: 'center', marginBottom: 4 },
  title:       { fontSize: 18, fontWeight: '700', color: c.textPrimary },
  subtitle:    { fontSize: 13, color: c.textSecondary, marginTop: -6 },
  input:       { borderWidth: 1, borderColor: c.border, borderRadius: radius.md, padding: 14, fontSize: 16, backgroundColor: c.background, color: c.textPrimary },
  error:       { fontSize: 13, color: c.error },
  confirmBtn:  { backgroundColor: c.primary, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center' },
  confirmText: { color: c.background, fontSize: 16, fontWeight: '700' },
}); }

// ── Add Food modal (manual macro entry) ───────────────────────────────────────

interface AddFoodModalProps {
  visible: boolean;
  onAdd: (item: CustomFoodItem) => void;
  onClose: () => void;
  themeColors: ReturnType<typeof getTheme>['colors'];
}

function AddFoodModal({ visible, onAdd, onClose, themeColors: c }: AddFoodModalProps) {
  const im = createImStyles(c);
  const afm = createAfmStyles(c);
  const [name,     setName]     = useState('');
  const [unit,     setUnit]     = useState('');
  const [calories, setCalories] = useState('');
  const [protein,  setProtein]  = useState('');
  const [carbs,    setCarbs]    = useState('');
  const [fat,      setFat]      = useState('');
  const [error,    setError]    = useState('');

  const reset = () => { setName(''); setUnit(''); setCalories(''); setProtein(''); setCarbs(''); setFat(''); setError(''); };
  const handleClose = () => { reset(); onClose(); };

  const handleAdd = () => {
    const trimmed = name.trim();
    if (!trimmed) { setError('Food name is required'); return; }
    if (!calories) { setError('Calories are required'); return; }
    onAdd({
      name:     trimmed,
      unit:     unit.trim() || '1 serving',
      calories: parseFloat(calories) || 0,
      protein:  parseFloat(protein)  || 0,
      carbs:    parseFloat(carbs)    || 0,
      fat:      parseFloat(fat)      || 0,
    });
    reset();
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <TouchableOpacity style={im.backdrop} activeOpacity={0.7} onPress={handleClose}>
          <View style={im.sheet}>
            <View style={im.handle} />
            <Text style={im.title}>Add Food</Text>
            <Text style={im.subtitle}>Enter the food name and its macros per serving</Text>

            <TextInput style={im.input} value={name} onChangeText={v => { setName(v); setError(''); }}
              placeholder="Food name (e.g. Greek yogurt)" placeholderTextColor={c.textMuted} autoFocus returnKeyType="next" />
            <TextInput style={im.input} value={unit} onChangeText={setUnit}
              placeholder="Serving size (e.g. 170g, 1 cup) — optional" placeholderTextColor={c.textMuted} returnKeyType="next" />

            <View style={afm.macroRow}>
              <View style={afm.macroField}>
                <Text style={afm.macroLabel}>Calories</Text>
                <TextInput style={afm.macroInput} value={calories} onChangeText={setCalories} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={c.textMuted} returnKeyType="next" />
              </View>
              <View style={afm.macroField}>
                <Text style={afm.macroLabel}>Protein (g)</Text>
                <TextInput style={afm.macroInput} value={protein} onChangeText={setProtein} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={c.textMuted} returnKeyType="next" />
              </View>
            </View>
            <View style={afm.macroRow}>
              <View style={afm.macroField}>
                <Text style={afm.macroLabel}>Carbs (g)</Text>
                <TextInput style={afm.macroInput} value={carbs} onChangeText={setCarbs} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={c.textMuted} returnKeyType="next" />
              </View>
              <View style={afm.macroField}>
                <Text style={afm.macroLabel}>Fat (g)</Text>
                <TextInput style={afm.macroInput} value={fat} onChangeText={setFat} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={c.textMuted} returnKeyType="done" onSubmitEditing={handleAdd} />
              </View>
            </View>

            {error ? <Text style={im.error}>{error}</Text> : null}
            <TouchableOpacity style={im.confirmBtn} onPress={handleAdd}>
              <Text style={im.confirmText}>Add Food</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function createAfmStyles(c: ReturnType<typeof getTheme>['colors']) { return StyleSheet.create({
  macroRow:   { flexDirection: 'row', gap: 10 },
  macroField: { flex: 1, gap: 6 },
  macroLabel: { fontSize: 12, fontWeight: '600', color: c.textSecondary },
  macroInput: { borderWidth: 1, borderColor: c.border, borderRadius: radius.md, padding: 12, fontSize: 16, fontWeight: '600', color: c.textPrimary, backgroundColor: c.background, textAlign: 'center' },
}); }

// ─────────────────────────────────────────────────────────────────────────────

export default function EditProfileScreen({ authToken, profile, onSave, onCancel, mode = 'goal', onRoutinesChanged, initialMealTab, noHeader = false }: EditProfileScreenProps) {
  const tc = getTheme(profile.themePreference).colors;
  const styles = createStyles(tc);
  const meta = useMetaData();
  const { width: screenWidth } = useWindowDimensions();

  // Goal (hierarchical)
  const [selectedGoal, setSelectedGoal] = useState<string>(profile.goalSelection?.primaryGoal ?? profile.goal);
  // Initialize the carousel index to the user's currently-selected goal
  // so the page lands on their actual goal — not the first card. Without
  // this, opening the goal editor always showed "Build muscle" at the top
  // even if the user had picked something else, which read as a bug.
  const [goalScrollIdx, setGoalScrollIdx] = useState<number>(() => {
    const idx = LAUNCH_GOALS.findIndex(g => g.id === (profile.goalSelection?.primaryGoal ?? profile.goal));
    return idx >= 0 ? idx : 0;
  });
  const goalCarouselRef = useRef<ScrollView>(null);

  // Mount-time auto-scroll. The initial state above puts the dot indicator
  // on the right card immediately, but the ScrollView still needs a manual
  // scrollTo to actually render the selected card in view (snapToInterval
  // doesn't honor initial state). 50ms gives the layout pass time to
  // resolve so the offset math is correct on first render.
  useEffect(() => {
    if (mode !== 'goal') return;
    const idx = LAUNCH_GOALS.findIndex(g => g.id === selectedGoal);
    if (idx < 0) return;
    const timer = setTimeout(() => {
      goalCarouselRef.current?.scrollTo({
        x: idx * (screenWidth * 0.82 + 12),
        animated: false,
      });
    }, 50);
    return () => clearTimeout(timer);
    // Only run on mount + when the screen first becomes the goal mode.
    // We deliberately don't depend on `selectedGoal` so user taps don't
    // re-trigger scroll-on-load logic (the tap handler already scrolls).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
  const [selectedModifiers, setSelectedModifiers] = useState<string[]>(profile.goalSelection?.modifiers ?? []);
  // Preview modal removed — matches onboarding's direct-select UX so
  // editing your goal feels the same as setting it up originally.
  // Goals are persisted on Save, so a stray tap doesn't actually
  // commit a change until the user confirms at save time anyway.
  const [goalPreviewId, setGoalPreviewId] = useState<string | null>(null);
  // AI goal matcher — same as onboarding. User types a sentence, AI
  // picks the best-fit launch goal and explains why.
  const [goalQuery, setGoalQuery] = useState('');
  const [goalMatchLoading, setGoalMatchLoading] = useState(false);
  const [goalMatchReason, setGoalMatchReason] = useState<string | null>(null);
  const selectedRegion = 'balanced';
  // Advanced-goal UI removed — only the 8 launch goals are exposed.
  const [pace, setPace] = useState<GoalPace>(profile.goalDetails.pace);
  const [targetWeight, setTargetWeight] = useState<string>(
    profile.goalDetails.targetWeightLbs ? String(profile.goalDetails.targetWeightLbs) : ''
  );
  const [targetEvent, setTargetEvent] = useState<string>(
    profile.goalDetails.targetEvent ?? ''
  );
  const [themePreference, setThemePreference] = useState<AppThemeName>(resolveThemeName(profile.themePreference));
  // Dev toggle for the free/pro tier. Missing tier defaults to free so
  // local UI cannot silently unlock Pro when the server has no billing state.
  const [subscriptionTier, setSubscriptionTier] = useState<'free' | 'pro'>(
    tierOf(profile),
  );

  // Physical stats
  const [currentWeight, setCurrentWeight] = useState<string>(
    profile.physicalStats.weightLbs ? String(profile.physicalStats.weightLbs) : ''
  );
  const [currentWeightModalVisible, setCurrentWeightModalVisible] = useState(false);
  const [currentWeightInput, setCurrentWeightInput]               = useState('');

  // Body mode fields
  const [bodyHeightFeet, setBodyHeightFeet] = useState<string>(
    profile.physicalStats.heightFeet ? String(profile.physicalStats.heightFeet) : ''
  );
  const [bodyHeightInches, setBodyHeightInches] = useState<string>(
    profile.physicalStats.heightInches != null ? String(profile.physicalStats.heightInches) : ''
  );
  // Birthdate is the source of truth. Age falls back to the cached int
  // when the user hasn't backfilled their birthday yet.
  const [bodyBirthdate, setBodyBirthdate] = useState<string | null>(
    profile.physicalStats.birthdate ?? null
  );
  const [bodyAge, setBodyAge] = useState<string>(
    profile.physicalStats.age ? String(profile.physicalStats.age) : ''
  );
  const [bodyGender, setBodyGender] = useState<Gender>(
    profile.physicalStats.gender ?? 'prefer_not_to_say'
  );
  const [bodySaving, setBodySaving] = useState(false);

  // Workout prefs
  const _defaultDays = (n: number): number[] => {
    const defaults: Record<number, number[]> = {
      1: [1], 2: [1, 4], 3: [1, 3, 5], 4: [1, 2, 4, 5],
      5: [1, 2, 3, 4, 5], 6: [1, 2, 3, 4, 5, 6], 7: [0, 1, 2, 3, 4, 5, 6],
    };
    return defaults[Math.min(7, Math.max(1, n))] ?? [1, 3, 5];
  };
  const [daysPerWeek, setDaysPerWeekRaw] = useState(profile.daysPerWeek ?? 3);
  const [trainingDays, setTrainingDays] = useState<number[]>(
    Array.isArray(profile.trainingDays) && profile.trainingDays.length === profile.daysPerWeek
      ? profile.trainingDays
      : _defaultDays(profile.daysPerWeek ?? 3)
  );
  const setDaysPerWeek = (updater: number | ((d: number) => number)) => {
    setDaysPerWeekRaw(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      setTrainingDays(_defaultDays(next));
      return next;
    });
  };
  const [duration, setDuration]       = useState(profile.workoutDurationMinutes ?? 60);
  const [preferredSplit, setPreferredSplit] = useState(profile.preferredSplit ?? 'auto');
  const [splitOptions, setSplitOptions] = useState<import('../services/api').SplitOption[]>([]);
  const [splitLoading, setSplitLoading] = useState(false);
  const [splitModalVisible, setSplitModalVisible] = useState(false);
  const [mealVariety, setMealVariety] = useState<number>(profile.mealVariety ?? 5);
  const [mealsPerDay, setMealsPerDay] = useState<number>(profile.mealsPerDay ?? 3);
  const [allergies, setAllergies] = useState<string[]>(profile.allergies ?? []);
  // Cut/maintain/bulk calorie ranges — lazy-loaded from backend when the
  // macros tab is opened so the macros section isn't waiting on an extra
  // roundtrip every time EditProfileScreen mounts.
  const [calorieRanges, setCalorieRanges] = useState<CalorieRanges | null>(null);
  const [calorieRangesLoading, setCalorieRangesLoading] = useState(false);
  const [equipment, setEquipment]     = useState<string[]>(profile.equipment as string[]);
  const [equipmentSettings, setEquipmentSettings] = useState<StrengthEquipmentSettings | undefined>(profile.equipmentSettings);
  const [foods, setFoods]             = useState<string[]>([
    ...profile.foodsAvailable,
    ...(profile.supplementsAvailable ?? []).map(s => '__supp__' + s),
  ]);
  const [customFoods, setCustomFoods] = useState<CustomFoodItem[]>(profile.customFoods ?? []);
  const [customExercises, setCustomExercises] = useState<import('../types').CustomExerciseItem[]>(profile.customExercises ?? []);
  const [savedMeals, setSavedMeals]   = useState<SavedMealTemplate[]>(profile.savedMeals ?? []);
  // Free-form meal routine prose was removed from the macros tab. The
  // value is still preserved in storage so existing users keep their text;
  // the UI is just gone. Routines are now pinned per-meal from Home.
  const mealRoutine = profile.mealRoutine ?? '';
  const [injuryEntries, setInjuryEntries] = useState<InjuryEntry[]>(profile.injuryEntries ?? []);
  const injuryMountedRef = useRef(false);
  // Auto-save injuries on every change to AsyncStorage
  useEffect(() => {
    if (!injuryMountedRef.current) { injuryMountedRef.current = true; return; }
    AsyncStorage.getItem('userProfile').then(raw => {
      if (!raw) return;
      const p = JSON.parse(raw);
      p.injuryEntries = injuryEntries.length > 0 ? injuryEntries : undefined;
      AsyncStorage.setItem('userProfile', JSON.stringify(p)).catch(() => {});
    }).catch(() => {});
  }, [injuryEntries]);
  // Re-read from profile prop only on actual prop identity change (new profile object),
  // NOT when local state differs. This prevents the sync from overwriting local edits.
  const lastProfileInjuryRef = useRef(JSON.stringify(profile.injuryEntries ?? []));
  useEffect(() => {
    const incoming = JSON.stringify(profile.injuryEntries ?? []);
    if (incoming !== lastProfileInjuryRef.current) {
      lastProfileInjuryRef.current = incoming;
      setInjuryEntries(profile.injuryEntries ?? []);
    }
  }, [profile.injuryEntries]);
  const [showAddInjury, setShowAddInjury] = useState(false);
  const [equipmentExpanded, setEquipmentExpanded] = useState(false);
  const [foodsExpanded, setFoodsExpanded] = useState(true);
  const [injuryDesc, setInjuryDesc]   = useState('');
  const [injuryBodyPart, setInjuryBodyPart] = useState('');
  const [foodSearch, setFoodSearch]   = useState('');
  const [foodCategoryFilter, setFoodCategoryFilter] = useState<string>('all');
  const [suppSearchQuery, setSuppSearchQuery] = useState('');
  const [suppSearchLoading, setSuppSearchLoading] = useState(false);
  const [suppSearchResult, setSuppSearchResult] = useState<any>(null);
  const [aiFoodSearchLoading, setAiFoodSearchLoading] = useState(false);
  const [barcodeScanVisible, setBarcodeScanVisible] = useState(false);
  const [aiFoodResults, setAiFoodResults] = useState<Array<{ name: string; serving: string; calories: number; protein: number; carbs: number; fat: number }>>([]);

  // Custom macro overrides
  const [useCustomMacros, setUseCustomMacros] = useState(!!profile.customMacros);
  const [customCalories, setCustomCalories] = useState(profile.customMacros?.calories ? String(profile.customMacros.calories) : '');
  const [customProtein, setCustomProtein]   = useState(profile.customMacros?.protein ? String(profile.customMacros.protein) : '');
  const [customCarbs, setCustomCarbs]       = useState(profile.customMacros?.carbs ? String(profile.customMacros.carbs) : '');
  const [customFat, setCustomFat]           = useState(profile.customMacros?.fat ? String(profile.customMacros.fat) : '');

  // Percentage-based macro mode. When enabled, the user enters
  // protein/carbs/fat as % of calories and we compute grams on save.
  const [macroPctMode, setMacroPctMode] = useState(!!(profile.customMacros as any)?.proteinPct);
  const [proteinPct, setProteinPct] = useState((profile.customMacros as any)?.proteinPct ? String((profile.customMacros as any).proteinPct) : '30');
  const [carbsPct, setCarbsPct]     = useState((profile.customMacros as any)?.carbsPct ? String((profile.customMacros as any).carbsPct) : '40');
  const [fatPct, setFatPct]         = useState((profile.customMacros as any)?.fatPct ? String((profile.customMacros as any).fatPct) : '30');

  // Modals
  const [addFoodVisible,    setAddFoodVisible]    = useState(false);
  const [photoMealLoading,  setPhotoMealLoading]  = useState(false);
  const [photoMealDraft,    setPhotoMealDraft]    = useState<PhotoMealDraft | null>(null);
  const [photoMealContext,  setPhotoMealContext]  = useState('');   // e.g. "split into 4 servings, I eat 3"
  const [photoMealServings, setPhotoMealServings] = useState('1');  // my portion out of total
  const [scanFoodsLoading,  setScanFoodsLoading]  = useState(false);
  const [scannedFoods,      setScannedFoods]      = useState<ScannedFoodItem[] | null>(null);
  const [pendingImages,     setPendingImages]     = useState<Array<{ image_base64: string; mime_type: string }>>([]);
  const [scanContext,       setScanContext]       = useState('');
  const [equipModalVisible, setEquipModalVisible] = useState(false);
  const [newEquipName,      setNewEquipName]      = useState('');
  const [equipError,        setEquipError]        = useState('');
  const [weightModalVisible, setWeightModalVisible] = useState(false);
  const [weightInput,        setWeightInput]        = useState(targetWeight);

  // Meal routines
  const [mealRoutines, setMealRoutinesState] = useState<MealRoutineEntry[]>([]);
  const [routineModalVisible, setRoutineModalVisible] = useState(false);
  const [editingRoutine, setEditingRoutine] = useState<MealRoutineEntry | null>(null);
  const [routineName, setRoutineName] = useState('');
  const [routineMealType, setRoutineMealType] = useState('');
  const [routineFoods, setRoutineFoods] = useState<MealRoutineFood[]>([]);
  const [routineFoodInput, setRoutineFoodInput] = useState('');
  const [routineFoodQtyInput, setRoutineFoodQtyInput] = useState('');
  const [routineNotes, setRoutineNotes] = useState('');
  const [routinePhotoUri, setRoutinePhotoUri] = useState<string | null>(null);

  // Tab state for combined modes
  const [workoutTab, setWorkoutTab] = useState<'equipment' | 'exercises'>('equipment');
  const [mealplanTab, setMealplanTab] = useState<'foods' | 'supplements' | 'macros'>(initialMealTab ?? 'foods');

  // Exercise library
  const [exerciseLibrary, setExerciseLibrary] = useState<ExerciseLibraryItem[]>([]);
  const [exerciseLibraryLoading, setExerciseLibraryLoading] = useState(false);
  const [exerciseSearch, setExerciseSearch] = useState('');
  const [aiExerciseResults, setAiExerciseResults] = useState<AIExerciseResult[]>([]);
  const [aiExerciseLoading, setAiExerciseLoading] = useState(false);
  const handleAiExerciseSearch = async () => {
    const q = exerciseSearch.trim();
    if (!q || !authToken) return;
    setAiExerciseLoading(true);
    try {
      const res = await searchExerciseAI(authToken, {
        query: q,
        equipment,
        injuries: (injuryEntries ?? [])
          .filter(i => i.status !== 'resolved')
          .map(i => i.bodyPart || i.description)
          .filter(Boolean),
        exclude: exerciseLibrary.map(e => e.name).filter(Boolean),
      });
      setAiExerciseResults(res.results ?? []);
      if ((res.results ?? []).length === 0) {
        Alert.alert('No results', `AI couldn't find a match for "${q}".`);
      }
    } catch (e: any) {
      Alert.alert('Search failed', e?.message ?? 'Could not reach the AI server.');
    } finally {
      setAiExerciseLoading(false);
    }
  };
  const handleSaveAiExerciseFromEdit = async (ex: AIExerciseResult) => {
    const existing = customExercises ?? [];
    if (existing.some(c => c.name.toLowerCase() === ex.name.toLowerCase())) {
      Alert.alert('Already saved', `${ex.name} is already in your library.`);
      return;
    }
    const newItem = {
      id: `custom_${Date.now()}`,
      name: ex.name,
      primary_muscle: ex.primary_muscle,
      equipment: ex.equipment,
      sets: ex.sets,
      reps: ex.reps,
      rest_seconds: ex.rest_seconds,
      description: ex.why,
      form_cues: ex.form_cues,
      source: 'ai' as const,
      createdAt: new Date().toISOString(),
    };
    setCustomExercises([...existing, newItem]);
    Alert.alert('Saved', `${ex.name} added to your exercise library.`);
  };
  const [exerciseMuscleFilter, setExerciseMuscleFilter] = useState<string>('all');
  const [exerciseEquipmentFilter, setExerciseEquipmentFilter] = useState<string>('all');
  const [selectedExercise, setSelectedExercise] = useState<ExerciseLibraryItem | null>(null);
  const [videoExerciseName, setVideoExerciseName] = useState<string | null>(null);
  const [selectedMuscle, setSelectedMuscle] = useState<MuscleEntry | null>(null);
  const [exerciseSubTab, setExerciseSubTab] = useState<'exercises' | 'muscles'>('exercises');
  const [muscleRegionFilter, setMuscleRegionFilter] = useState<string>('all');

  useEffect(() => {
    loadMealRoutines().then(setMealRoutinesState);
  }, []);

  // Fetch split options when days or goal change (workout mode only).
  useEffect(() => {
    if (mode !== 'workout' && mode !== 'goal') return;
    if (!authToken) return;
    let cancelled = false;
    setSplitLoading(true);
    import('../services/api').then(({ getSplitOptions }) =>
      getSplitOptions(authToken, {
        goal: selectedGoal,
        daysPerWeek,
        experienceLevel: profile.experienceLevel || 'intermediate',
        priorityRegion: selectedRegion || undefined,
      })
    ).then(res => {
      if (cancelled) return;
      setSplitOptions(res.options);
      // If current selection isn't compatible, reset to auto
      if (preferredSplit !== 'auto' && !res.options.some(o => o.id === preferredSplit)) {
        setPreferredSplit('auto');
      }
    }).catch(() => {
      if (!cancelled) setSplitOptions([]);
    }).finally(() => {
      if (!cancelled) setSplitLoading(false);
    });
    return () => { cancelled = true; };
  }, [selectedGoal, daysPerWeek, authToken, mode]);

  // Load calorie ranges when the macros tab is opened. Cached in
  // component state so switching tabs doesn't re-fetch.
  //
  // Self-healing: if the backend returns ANY error (typically 404 because
  // a previous syncOnboarding fire-and-forget call failed silently and
  // the local profile never landed in the DB), push the current profile
  // and retry. This catches the test-user case where signup happened on
  // top of a stale local profile and onboarding sync was never triggered.
  useEffect(() => {
    if (mode === 'mealplan' && (mealplanTab === 'macros' || mealplanTab === 'foods') && authToken && !calorieRanges && !calorieRangesLoading) {
      setCalorieRangesLoading(true);
      const fetchOnce = () => getCalorieRanges(authToken);
      const trySync = async () => {
        const { syncOnboarding } = await import('../services/api');
        try {
          await syncOnboarding(authToken, profile);
        } catch (e) {
          console.warn('[calorie-ranges] sync retry failed', e);
        }
      };
      fetchOnce()
        .then(setCalorieRanges)
        .catch(async () => {
          // First failure → push profile + retry once.
          await trySync();
          try {
            const ranges = await fetchOnce();
            setCalorieRanges(ranges);
          } catch (e) {
            console.warn('[calorie-ranges] still failing after sync retry', e);
            setCalorieRanges(null);
          }
        })
        .finally(() => setCalorieRangesLoading(false));
    }
  }, [mode, mealplanTab, authToken, profile]);

  // Load exercise library when exercises tab is opened. Merges user's
  // AI-saved custom exercises on top of the seeded backend library so
  // both show up in the same searches/filters.
  useEffect(() => {
    if (mode === 'workout' && workoutTab === 'exercises' && exerciseLibrary.length === 0 && !exerciseLibraryLoading) {
      setExerciseLibraryLoading(true);
      getExercises()
        .then(rows => {
          const customs = (customExercises ?? []).map(ce => ({
            id: ce.id as any,
            name: ce.name,
            primary_muscle: ce.primary_muscle,
            secondary_muscles: [] as string[],
            equipment: ce.equipment,
            description: ce.description ?? '',
            is_custom: true,
          })) as unknown as ExerciseLibraryItem[];
          setExerciseLibrary([...customs, ...(rows ?? [])]);
        })
        .catch(() => {
          const customs = (customExercises ?? []).map(ce => ({
            id: ce.id as any,
            name: ce.name,
            primary_muscle: ce.primary_muscle,
            secondary_muscles: [] as string[],
            equipment: ce.equipment,
            description: ce.description ?? '',
            is_custom: true,
          })) as unknown as ExerciseLibraryItem[];
          setExerciseLibrary(customs);
        })
        .finally(() => setExerciseLibraryLoading(false));
    }
  }, [mode, workoutTab, customExercises]);

  const exerciseMuscleOptions = Array.from(
    new Set(exerciseLibrary.map(i => i.primary_muscle).filter(Boolean) as string[])
  ).sort((a, b) => humanizeToken(a).localeCompare(humanizeToken(b)));

  const exerciseEquipmentOptions = Array.from(
    new Set(exerciseLibrary.map(i => i.equipment).filter(Boolean) as string[])
  ).sort((a, b) => humanizeToken(a).localeCompare(humanizeToken(b)));

  const filteredExerciseLibrary = exerciseLibrary.filter(item => {
    const search = exerciseSearch.trim().toLowerCase();
    const matchesSearch = !search || [
      item.name, item.description ?? '', humanizeToken(item.primary_muscle),
      humanizeToken(item.equipment), ...(item.secondary_muscles ?? []).map(humanizeToken),
    ].some(v => v.toLowerCase().includes(search));
    const matchesMuscle = exerciseMuscleFilter === 'all' || item.primary_muscle === exerciseMuscleFilter;
    const matchesEquipment = exerciseEquipmentFilter === 'all' || item.equipment === exerciseEquipmentFilter;
    return matchesSearch && matchesMuscle && matchesEquipment;
  });

  const toggleEquipment = (name: string) =>
    setEquipment(prev => prev.includes(name) ? prev.filter(e => e !== name) : [...prev, name]);

  // ── Routine handlers ──────────────────────────────────────────────────────

  const openAddRoutine = () => {
    setEditingRoutine(null);
    setRoutineName('');
    setRoutineMealType('');
    setRoutineFoods([]);
    setRoutineFoodInput('');
    setRoutineFoodQtyInput('');
    setRoutineNotes('');
    setRoutinePhotoUri(null);
    setRoutineModalVisible(true);
  };

  const openEditRoutine = (r: MealRoutineEntry) => {
    setEditingRoutine(r);
    setRoutineName(r.name);
    setRoutineMealType(r.mealType ?? '');
    setRoutineFoods([...r.foods]);
    setRoutineFoodInput('');
    setRoutineFoodQtyInput('');
    setRoutineNotes(r.notes ?? '');
    setRoutinePhotoUri(r.photoUri ?? null);
    setRoutineModalVisible(true);
  };

  /** Pick a routine photo AND run it through the AI vision scanner so the
   *  foods + macros get auto-populated. If the user already typed some
   *  foods, the scan results are merged in (no duplicate names). */
  const handleRoutinePickPhoto = async () => {
    let pickedUri: string | null = null;
    let pickedBase64: string | null = null;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (perm.granted) {
      const result = await ImagePicker.launchImageLibraryAsync({
        quality: 0.8,
        mediaTypes: ['images'] as any,
        base64: true,
      });
      if (!result.canceled && result.assets?.[0]) {
        pickedUri = result.assets[0].uri;
        pickedBase64 = result.assets[0].base64 ?? null;
      }
    }
    if (!pickedUri) {
      const cam = await ImagePicker.requestCameraPermissionsAsync();
      if (!cam.granted) { Alert.alert('Permission needed', 'Allow camera or photo library access.'); return; }
      const result = await ImagePicker.launchCameraAsync({
        quality: 0.8,
        mediaTypes: ['images'] as any,
        base64: true,
      });
      if (!result.canceled && result.assets?.[0]) {
        pickedUri = result.assets[0].uri;
        pickedBase64 = result.assets[0].base64 ?? null;
      }
    }
    if (!pickedUri) return;

    setRoutinePhotoUri(pickedUri);

    // Scan the photo against the AI to derive structured foods + macros.
    // The user can still edit afterwards, so we optimistically merge rather
    // than replace their existing list.
    if (authToken && pickedBase64) {
      try {
        const res = await scanFoodsPhoto(authToken, {
          images: [{ image_base64: pickedBase64, mime_type: 'image/jpeg' }],
        });
        if (res.foods?.length) {
          setRoutineFoods(prev => {
            const existingNames = new Set(prev.map(f => f.name.toLowerCase()));
            const additions: MealRoutineFood[] = res.foods
              .filter(f => !existingNames.has(f.name.toLowerCase()))
              .map((f, i) => ({
                id: `${Date.now()}_${i}`,
                name: f.name,
                quantity: f.serving ?? undefined,
              }));
            return [...prev, ...additions];
          });
          Alert.alert(
            'Photo analyzed',
            `Added ${res.foods.length} food${res.foods.length === 1 ? '' : 's'} to this routine. You can edit or remove them below.`,
          );
        }
      } catch (e: any) {
        console.warn('[routine-photo] AI scan failed', e?.message ?? e);
        // Fail quietly — the photo itself still saved, user can type foods manually.
      }
    }
  };

  const handleRoutineAddFood = async () => {
    const name = routineFoodInput.trim();
    if (!name) return;
    // Clear the input immediately so the user can keep typing the next food.
    const qty = routineFoodQtyInput.trim() || undefined;
    setRoutineFoodInput('');
    setRoutineFoodQtyInput('');

    const food: MealRoutineFood = { id: Date.now().toString(), name, quantity: qty };
    setRoutineFoods(prev => [...prev, food]);

    // If this food is new (not in seed library OR existing customFoods),
    // look up macros via AI and add to customFoods right now so the user
    // gets immediate feedback instead of waiting until they hit Save.
    const knownLower = new Set([
      ...meta.allFoods.map(f => f.name.toLowerCase()),
      ...customFoods.map(f => f.name.toLowerCase()),
    ]);
    if (knownLower.has(name.toLowerCase())) return;

    if (!authToken) {
      // No backend — add a zero-macro stub so the food exists in the library.
      setCustomFoods(prev => prev.some(f => f.name.toLowerCase() === name.toLowerCase())
        ? prev
        : [...prev, { name, unit: '1 serving', calories: 0, protein: 0, carbs: 0, fat: 0 }]);
      return;
    }

    try {
      const res = await searchFoodNutrition(authToken, name);
      const first = res.results?.[0];
      const item: CustomFoodItem = first ? {
        name: first.name ?? name,
        unit: first.serving ?? '1 serving',
        calories: Math.round(first.calories ?? 0),
        protein:  Math.round(first.protein  ?? 0),
        carbs:    Math.round(first.carbs    ?? 0),
        fat:      Math.round(first.fat      ?? 0),
      } : { name, unit: '1 serving', calories: 0, protein: 0, carbs: 0, fat: 0 };
      setCustomFoods(prev => prev.some(f => f.name.toLowerCase() === item.name.toLowerCase())
        ? prev
        : [...prev, item]);
    } catch {
      // AI unreachable — stub it so the food still lands in the library.
      setCustomFoods(prev => prev.some(f => f.name.toLowerCase() === name.toLowerCase())
        ? prev
        : [...prev, { name, unit: '1 serving', calories: 0, protein: 0, carbs: 0, fat: 0 }]);
    }
  };

  const handleRoutineSave = async () => {
    const name = routineName.trim();
    if (!name) { Alert.alert('Name required', 'Give this routine a name.'); return; }
    // mealType is no longer required — every meal is uniform now. We keep
    // the field as a free-form tag for back-compat but don't gate save.

    // Resolve every routine food against the merged food library so we can
    // capture per-item + total macros at pin time. Without this the routine
    // ends up with calories=0 and the backend builds a full-target plan
    // that overlays to double the user's intended calories.
    const lookupName = (n: string) => {
      const lower = n.toLowerCase();
      return meta.allFoods.find(f => f.name.toLowerCase() === lower)
          ?? customFoods.find(f => f.name.toLowerCase() === lower)
          ?? null;
    };

    // Build structured items[]. Each item carries its own macros so the
    // backend / frontend never have to look up the food again.
    const { parseAmountString, guessUnitForFood } = await import('../utils/mealItems');
    const items = routineFoods.map(rf => {
      const lib: any = lookupName(rf.name);
      const parsed = rf.quantity ? parseAmountString(rf.quantity) : null;
      const libParsed = lib?.unit ? parseAmountString(lib.unit) : null;
      const guess = guessUnitForFood(rf.name);
      let qty = parsed?.quantity ?? libParsed?.quantity ?? guess.quantity;
      let unit = parsed?.unit ?? libParsed?.unit ?? guess.unit;
      if ((unit as string) === 'serving') {
        qty = guess.quantity;
        unit = guess.unit;
      }
      // Scale macros to the actual quantity. The library entry's macros
      // are per its parsed serving (libParsed.quantity); if user typed a
      // different amount, scale by the ratio so totals match the label.
      const baseQty = libParsed?.quantity ?? 1;
      const ratio = baseQty > 0 ? qty / baseQty : 1;
      const cal = Math.round((lib?.calories ?? 0) * ratio);
      const prot = Math.round((lib?.protein ?? 0) * ratio);
      const carb = Math.round((lib?.carbs ?? 0) * ratio);
      const fat = Math.round((lib?.fat ?? 0) * ratio);
      return {
        name: rf.name,
        quantity: qty,
        unit,
        calories: cal,
        protein: prot,
        carbs: carb,
        fat: fat,
      };
    });
    const totals = items.reduce(
      (acc, it) => ({
        calories: acc.calories + it.calories,
        protein:  acc.protein  + it.protein,
        carbs:    acc.carbs    + it.carbs,
        fat:      acc.fat      + it.fat,
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0 },
    );

    const entry: MealRoutineEntry = {
      id: editingRoutine?.id ?? Date.now().toString(),
      name,
      mealType: routineMealType || 'custom',
      foods: routineFoods,
      items: items as any,
      notes: routineNotes.trim() || undefined,
      photoUri: routinePhotoUri ?? undefined,
      createdAt: editingRoutine?.createdAt ?? new Date().toISOString(),
      calories: totals.calories,
      protein:  totals.protein,
      carbs:    totals.carbs,
      fat:      totals.fat,
    };
    const next = editingRoutine
      ? mealRoutines.map(r => r.id === editingRoutine.id ? entry : r)
      : [...mealRoutines, entry];
    setMealRoutinesState(next);
    await saveMealRoutines(next);
    setRoutineModalVisible(false);
    onRoutinesChanged?.();
  };

  const handleRoutineDelete = async (id: string) => {
    Alert.alert('Delete routine?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        const next = mealRoutines.filter(r => r.id !== id);
        setMealRoutinesState(next);
        await saveMealRoutines(next);
        onRoutinesChanged?.();
      }},
    ]);
  };

  const toggleFood = (name: string) =>
    setFoods(prev => prev.includes(name) ? prev.filter(f => f !== name) : [...prev, name]);

  const handleAddCustomFood = (item: CustomFoodItem) => {
    setCustomFoods(prev => [...prev.filter(f => f.name !== item.name), item]);
    setFoods(prev => prev.includes(item.name) ? prev : [...prev, item.name]);
  };

  const handleAddEquipment = () => {
    const name = newEquipName.trim();
    if (!name) { setEquipError('Enter an equipment name'); return; }
    if (!equipment.includes(name)) setEquipment(prev => [...prev, name]);
    setNewEquipName('');
    setEquipModalVisible(false);
  };

  const renderStrengthLoadSettings = () => {
    const normalized = normalizeStrengthEquipmentSettings(equipmentSettings, equipment);
    const dumbbells = normalized?.dumbbells ?? DEFAULT_ADJUSTABLE_DUMBBELLS;
    const barbell = normalized?.barbell ?? { barWeightLbs: 45, platePairsLbs: DEFAULT_PLATE_PAIRS_LBS };
    const showDumbbells = hasAdjustableDumbbells(equipment);
    const showPlates = hasPlateLoadedEquipment(equipment);
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
      <View style={[styles.chipGroup, { marginTop: 4 }]}>
        <Text style={styles.chipGroupLabel}>Load setup</Text>
        <Text style={styles.sectionHint}>
          We use this so suggested weights match what you can actually load.
        </Text>
        {showDumbbells && (
          <View style={{ marginBottom: 12 }}>
            <Text style={[styles.sectionLabel, { marginBottom: 8 }]}>Adjustable dumbbells</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {[
                { label: 'Min', value: dumbbells.minLbs, key: 'minLbs' },
                { label: 'Max', value: dumbbells.maxLbs, key: 'maxLbs' },
                { label: 'Step', value: dumbbells.incrementLbs, key: 'incrementLbs' },
              ].map(item => (
                <View key={item.key} style={{ flex: 1 }}>
                  <Text style={{ fontSize: 11, color: tc.textMuted, marginBottom: 4 }}>{item.label}</Text>
                  <TextInput
                    style={[styles.searchInput, { marginBottom: 0, paddingVertical: 10, paddingHorizontal: 10, fontSize: 14 }]}
                    keyboardType="decimal-pad"
                    value={String(item.value ?? '')}
                    onChangeText={(text) => updateDumbbells({ [item.key]: parseFloat(text) || undefined } as any)}
                    placeholder={String(item.value ?? '')}
                    placeholderTextColor={tc.textMuted}
                  />
                </View>
              ))}
            </View>
          </View>
        )}
        {showPlates && (
          <View>
            <Text style={[styles.sectionLabel, { marginBottom: 8 }]}>Plate pairs you can load</Text>
            <View style={styles.chips}>
              {PLATE_PAIR_OPTIONS_LBS.map(plate => {
                const selected = (barbell.platePairsLbs ?? DEFAULT_PLATE_PAIRS_LBS).includes(plate);
                return (
                  <TouchableOpacity
                    key={plate}
                    style={[styles.chip, selected && styles.chipActive]}
                    onPress={() => togglePlate(plate)}>
                    <Text style={[styles.chipText, selected && styles.chipTextActive]}>{plate} lb</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}
      </View>
    );
  };

  const handleAnalyzeFoodPhoto = async (source: 'camera' | 'library') => {
    if (!authToken) {
      Alert.alert('Sign in required', 'You need to be signed in to analyze food photos.');
      return;
    }

    const permission = source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', `Please allow ${source === 'camera' ? 'camera' : 'photo library'} access to analyze meals.`);
      return;
    }

    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync({ quality: 0.7, base64: true, mediaTypes: ['images'] as any })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.7, base64: true, mediaTypes: ['images'] as any });

    if (result.canceled || !result.assets?.[0]?.base64) return;

    setPhotoMealLoading(true);
    try {
      const asset = result.assets[0];
      const imageBase64 = asset.base64;
      if (!imageBase64) return;
      // Force image/jpeg — expo-image-picker base64 path transcodes
      // HEIC/HEIF to JPEG but `asset.mimeType` sometimes still reports
      // the original. OpenAI vision rejects HEIC with a format error.
      const analysis = await analyzeFoodPhoto(authToken, {
        image_base64: imageBase64,
        mime_type: 'image/jpeg',
      });
      setPhotoMealDraft(analysis);
      setPhotoMealContext('');
      setPhotoMealServings('1');
    } catch (e: any) {
      Alert.alert('Analysis failed', e?.message ?? 'Could not analyze this food photo.');
    } finally {
      setPhotoMealLoading(false);
    }
  };

  const handleAddScanPhotos = async (source: 'camera' | 'library') => {
    if (!authToken) {
      Alert.alert('Sign in required', 'You need to be signed in to scan foods.');
      return;
    }
    const permission = source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', `Please allow ${source === 'camera' ? 'camera' : 'photo library'} access.`);
      return;
    }
    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync({ quality: 0.7, base64: true, mediaTypes: ['images'] as any })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.7, base64: true, allowsMultipleSelection: true, mediaTypes: ['images'] as any });

    if (result.canceled || !result.assets?.length) return;
    const newImages = result.assets
      .filter(a => a.base64)
      .map(a => ({ image_base64: a.base64!, mime_type: 'image/jpeg' }));
    setPendingImages(prev => [...prev, ...newImages]);
  };

  const handleScanFoods = async () => {
    if (!authToken || pendingImages.length === 0) return;
    setScanFoodsLoading(true);
    try {
      const response = await scanFoodsPhoto(authToken, {
        images: pendingImages,
        context: scanContext.trim() || undefined,
      });
      setScannedFoods((response.foods ?? []).map(f => ({ ...f, selected: true })));
      setPendingImages([]);
      setScanContext('');
    } catch (e: any) {
      Alert.alert('Scan failed', e?.message ?? 'Could not identify foods from these photos.');
    } finally {
      setScanFoodsLoading(false);
    }
  };

  const confirmScannedFoods = () => {
    if (!scannedFoods) return;
    const selected = scannedFoods.filter(f => f.selected);
    selected.forEach(f => {
      const item: CustomFoodItem = {
        name: f.name,
        unit: f.serving,
        calories: Math.round(f.calories),
        protein: Math.round(f.protein),
        carbs: Math.round(f.carbs),
        fat: Math.round(f.fat),
      };
      handleAddCustomFood(item);
    });
    setScannedFoods(null);
    if (selected.length > 0) {
      Alert.alert('Added', `${selected.length} food${selected.length > 1 ? 's' : ''} added to your list.`);
    }
  };

  const handleAiFoodSearch = async () => {
    if (!authToken || !foodSearch.trim()) return;
    setAiFoodSearchLoading(true);
    try {
      const res = await searchFoodNutrition(authToken, foodSearch.trim());
      setAiFoodResults(res.results ?? []);
      if (!res.results?.length) Alert.alert('No results', `Could not find nutrition info for "${foodSearch}".`);
    } catch (e: any) {
      Alert.alert('Search failed', e.message ?? 'Could not reach the AI server.');
    } finally {
      setAiFoodSearchLoading(false);
    }
  };

  const addAiFoodResult = (item: { name: string; serving: string; calories: number; protein: number; carbs: number; fat: number }) => {
    const customItem: CustomFoodItem = {
      name: item.name,
      unit: item.serving,
      calories: Math.round(item.calories),
      protein: Math.round(item.protein),
      carbs: Math.round(item.carbs),
      fat: Math.round(item.fat),
    };
    handleAddCustomFood(customItem);
    setAiFoodResults(prev => prev.filter(r => r.name !== item.name));
  };

  const handleBarcodeScan = async (barcode: string) => {
    if (!authToken || !barcode.trim()) return;
    setBarcodeScanVisible(false);
    try {
      const { lookupBarcode } = await import('../services/api');
      const result = await lookupBarcode(authToken, barcode.trim());
      if (result?.name) {
        addAiFoodResult({
          name: result.name,
          serving: result.serving,
          calories: result.calories,
          protein: result.protein,
          carbs: result.carbs,
          fat: result.fat,
        });
        Alert.alert('Added', `${result.name} added to your food list.`);
      }
    } catch {
      Alert.alert('Not found', `No nutrition data for barcode ${barcode}. Try searching by name.`);
    }
  };

  const confirmPhotoMeal = () => {
    if (!photoMealDraft) return;
    // Apply serving fraction — e.g. if batch makes 4 servings and user eats 3, multiply by 3/4
    const fraction = (() => {
      const parts = photoMealServings.trim().split('/');
      if (parts.length === 2) {
        const n = parseFloat(parts[0]), d = parseFloat(parts[1]);
        return (!isNaN(n) && !isNaN(d) && d > 0) ? n / d : 1;
      }
      const n = parseFloat(photoMealServings);
      return (!isNaN(n) && n > 0) ? n : 1;
    })();
    const name = photoMealDraft.meal_name.trim() || 'Saved Photo Meal';
    setSavedMeals(prev => [
      {
        id: `${Date.now()}`,
        name,
        items: photoMealDraft.items,
        calories: Math.round(photoMealDraft.calories * fraction),
        protein:  Math.round(photoMealDraft.protein  * fraction),
        carbs:    Math.round(photoMealDraft.carbs    * fraction),
        fat:      Math.round(photoMealDraft.fat      * fraction),
      },
      ...prev.filter(m => m.name !== name),
    ]);
    setPhotoMealDraft(null);
    setPhotoMealContext('');
    setPhotoMealServings('1');
  };

  /** Returns true if the form state differs from `profile` in a way that
   *  would trigger a plan regeneration. Theme / cosmetic-only changes
   *  return false and save silently without the confirmation dialog. */
  const hasPlanRelevantChanges = (): boolean => {
    const sameArr = (a?: any[], b?: any[]) =>
      JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());
    // Goal + goal details
    if (selectedGoal !== profile.goal) return true;
    if ((profile.goalDetails?.pace ?? null) !== pace) return true;
    if (String(profile.goalDetails?.targetWeightLbs ?? '') !== String(targetWeight ?? '')) return true;
    if (String(profile.goalDetails?.targetEvent ?? '') !== String(targetEvent ?? '')) return true;
    // Training shape
    if ((profile.daysPerWeek ?? 0) !== daysPerWeek) return true;
    if ((profile.workoutDurationMinutes ?? 60) !== duration) return true;
    if ((profile.preferredSplit ?? 'auto') !== preferredSplit) return true;
    if (!sameArr(profile.equipment, equipment)) return true;
    if (JSON.stringify(normalizeStrengthEquipmentSettings(profile.equipmentSettings, profile.equipment ?? [])) !== JSON.stringify(normalizeStrengthEquipmentSettings(equipmentSettings, equipment))) return true;
    // Nutrition shape
    if ((profile.mealsPerDay ?? 3) !== mealsPerDay) return true;
    if ((profile.mealVariety ?? 5) !== mealVariety) return true;
    if (!sameArr(profile.allergies ?? [], allergies)) return true;
    if (!sameArr(profile.foodsAvailable, foods.filter(f => !f.startsWith('__supp__')))) return true;
    if ((profile.mealRoutine ?? '') !== (mealRoutine ?? '').trim()) return true;
    // Bodyweight (affects macro targets)
    const cw = currentWeight ? parseFloat(currentWeight) : profile.physicalStats?.weightLbs;
    if (cw !== profile.physicalStats?.weightLbs) return true;
    // Custom macro overrides
    const nextCustom = (useCustomMacros || mode === 'mealplan') && (customCalories || customProtein || customCarbs || customFat);
    const hadCustom = !!profile.customMacros;
    if (!!nextCustom !== hadCustom) return true;
    return false;
  };

  const handleSaveBody = async () => {
    const w = parseFloat(currentWeight);
    const hf = parseInt(bodyHeightFeet, 10);
    const hi = parseInt(bodyHeightInches, 10);
    // Prefer birthdate → derive age. Fall back to the typed-in age int
    // for backward compatibility with users who haven't backfilled yet.
    const { deriveAge, validateBirthdate } = await import('../utils/age');
    let a: number;
    if (bodyBirthdate) {
      const err = validateBirthdate(bodyBirthdate);
      if (err) { Alert.alert('Invalid birthday', err); return; }
      a = deriveAge(bodyBirthdate)!;
    } else {
      a = parseInt(bodyAge, 10);
    }
    if (!w || w <= 0) { Alert.alert('Invalid weight', 'Enter a valid weight in pounds.'); return; }
    if (!hf || hf < 3 || hf > 8) { Alert.alert('Invalid height', 'Enter a valid height (feet).'); return; }
    if (isNaN(hi) || hi < 0 || hi > 11) { Alert.alert('Invalid height', 'Inches must be 0-11.'); return; }
    if (!a || a < 10 || a > 120) { Alert.alert('Invalid age', 'Enter a valid age or birthday.'); return; }

    setBodySaving(true);
    try {
      const { updatePhysicalStats } = await import('../services/api');
      await updatePhysicalStats(authToken, {
        weightLbs: w, heightFeet: hf, heightInches: hi, age: a,
        birthdate: bodyBirthdate ?? undefined, gender: bodyGender,
      });
      if (w !== profile.physicalStats.weightLbs && w > 0) {
        const { saveWeightEntry } = await import('../utils/weightHistory');
        await saveWeightEntry(w, 'manual');
      }
      onSave({
        ...profile,
        physicalStats: {
          weightLbs: w, heightFeet: hf, heightInches: hi,
          age: a, birthdate: bodyBirthdate ?? undefined, gender: bodyGender,
        },
      });
    } catch (e: any) {
      Alert.alert('Save failed', e?.message ?? 'Could not update stats. Try again.');
    } finally {
      setBodySaving(false);
    }
  };

  const handleSave = () => {
    if (mode === 'body') { handleSaveBody(); return; }
    // Validate training days match days per week
    if (trainingDays.length > 0 && trainingDays.length !== daysPerWeek) {
      Alert.alert(
        'Training days mismatch',
        `You selected ${trainingDays.length} training day${trainingDays.length !== 1 ? 's' : ''} but set ${daysPerWeek} days per week. Please select exactly ${daysPerWeek} day${daysPerWeek !== 1 ? 's' : ''}.`,
      );
      return;
    }
    // Validate target weight direction matches goal intent. A fat-loss
    // goal with a target HIGHER than current weight (or vice versa) is
    // almost certainly a typo — block it before regen burns 30-60s on
    // an inconsistent plan.
    const cutGoals  = new Set(['lose_fat', 'get_lean', 'cut', 'preserve_muscle_cutting']);
    const bulkGoals = new Set(['build_muscle', 'lean_bulk', 'gain_weight']);
    const weightGoals = new Set([...cutGoals, ...bulkGoals]);
    // Require target weight for ANY weight-change goal. Without it the
    // calorie/protein calc is a guess and the ETA on Progress is blank.
    if (weightGoals.has(selectedGoal) && !targetWeight) {
      Alert.alert(
        'Target weight required',
        `This goal needs a target weight so we can build your calorie deficit/surplus and track progress. Tap to set it below.`,
      );
      return;
    }
    if (targetWeight) {
      const tw = parseFloat(targetWeight);
      const cw = currentWeight ? parseFloat(currentWeight) : profile.physicalStats?.weightLbs;
      if (tw > 0 && cw && cw > 0) {
        if (cutGoals.has(selectedGoal) && tw >= cw) {
          Alert.alert('Target weight check', `Your goal is fat loss but the target weight (${tw} lb) isn't lower than your current weight (${cw} lb). Lower the target or change the goal.`);
          return;
        }
        if (bulkGoals.has(selectedGoal) && tw <= cw) {
          Alert.alert('Target weight check', `Your goal is to gain weight but the target weight (${tw} lb) isn't higher than your current weight (${cw} lb). Raise the target or change the goal.`);
          return;
        }
      }
    }
    // Single confirmation lives at the parent (`handleSaveProfile` in
    // app/index.tsx) — it shows a themed "Update Plan?" modal that's
    // more informative than this Alert was, and it KNOWS whether the
    // change actually triggers a regen. We just hand off here.
    doHandleSave();
  };

  const doHandleSave = async () => {
    const newWeight = currentWeight ? parseFloat(currentWeight) : profile.physicalStats.weightLbs;
    if (newWeight !== profile.physicalStats.weightLbs && newWeight > 0) {
      const { saveWeightEntry } = await import('../utils/weightHistory');
      await saveWeightEntry(newWeight, 'manual');
    }
    const cat = goalCategory(selectedGoal) ?? 'lifestyle_consistency';
    const goalSel: GoalSelection = {
      primaryGoal: selectedGoal,
      category: cat,
      modifiers: selectedModifiers,
    };

    const weightGoalIds = new Set(['lose_fat', 'get_lean', 'cut', 'preserve_muscle_cutting', 'build_muscle', 'lean_bulk', 'gain_weight']);
    const targetWeightLbs = weightGoalIds.has(selectedGoal) && targetWeight ? parseFloat(targetWeight) : undefined;
    const eventCategories = new Set(['strength', 'cardio_endurance', 'athletic_performance']);
    const targetEventVal = eventCategories.has(cat) && targetEvent.trim() ? targetEvent.trim() : undefined;

    // Extract supplement selections (tagged with __supp__ prefix in foods array)
    const suppPrefix = '__supp__';
    const actualFoods = foods.filter(f => !f.startsWith(suppPrefix));
    const selectedSupps = foods.filter(f => f.startsWith(suppPrefix)).map(f => f.slice(suppPrefix.length));
    const mergedSupps = Array.from(new Set([...(profile.supplementsAvailable ?? []), ...selectedSupps]));
    // If in mealplan mode, remove unselected supps
    const finalSupps = mode === 'mealplan'
      ? mergedSupps.filter(s => selectedSupps.includes(s) || !(profile.supplementsAvailable ?? []).includes(s))
      : profile.supplementsAvailable;

    onSave({
      ...profile,
      goal: selectedGoal,
      goalSelection: goalSel,
      priorityRegion: selectedRegion,
      themePreference,
      subscriptionTier,
      goalDetails: {
        ...profile.goalDetails,
        pace,
        targetWeightLbs,
        targetEvent: targetEventVal,
      },
      daysPerWeek: Math.min(7, Math.max(1, daysPerWeek)),
      trainingDays: trainingDays.length > 0 ? trainingDays : undefined,
      workoutDurationMinutes: duration,
      preferredSplit: preferredSplit === 'auto' ? undefined : preferredSplit,
      mealVariety: Math.min(7, Math.max(1, mealVariety)),
      mealsPerDay: Math.min(10, Math.max(1, mealsPerDay)),
      allergies,
      equipment,
      equipmentSettings: normalizeStrengthEquipmentSettings(equipmentSettings, equipment),
      foodsAvailable: actualFoods,
      customFoods,
      customExercises,
      savedMeals,
      supplementsAvailable: finalSupps,
      mealRoutine: mealRoutine.trim() || undefined,
      injuryEntries: injuryEntries.length > 0 ? injuryEntries : undefined,
      physicalStats: {
        ...profile.physicalStats,
        weightLbs: currentWeight ? parseFloat(currentWeight) : profile.physicalStats.weightLbs,
      },
      customMacros: (() => {
        // Goal changes always clear custom macros so the new goal's
        // calorie/protein targets take effect. Custom macros only persist
        // when explicitly editing from the mealplan/macros tab.
        if (mode === 'goal') return undefined;
        const hasAny = useCustomMacros || mode === 'mealplan';
        if (!hasAny) return undefined;
        // Percentage mode: convert % → grams using the calorie target.
        // When in pct mode the user sets protein/carbs/fat as percentages
        // of total calories. Grams are computed: protein_g = cal × pct / 400,
        // carb_g = cal × pct / 400, fat_g = cal × pct / 900.
        if (macroPctMode && customCalories) {
          const cal = parseInt(customCalories, 10) || 0;
          const pp = parseInt(proteinPct, 10) || 0;
          const cp = parseInt(carbsPct, 10) || 0;
          const fp = parseInt(fatPct, 10) || 0;
          return {
            calories: cal,
            protein: Math.round(cal * pp / 400),
            carbs:   Math.round(cal * cp / 400),
            fat:     Math.round(cal * fp / 900),
            // Persist the percentages so they reload correctly.
            proteinPct: pp, carbsPct: cp, fatPct: fp,
          };
        }
        if (customCalories || customProtein || customCarbs || customFat) {
          return {
            ...(customCalories ? { calories: parseInt(customCalories, 10) } : {}),
            ...(customProtein  ? { protein: parseInt(customProtein, 10) }   : {}),
            ...(customCarbs    ? { carbs: parseInt(customCarbs, 10) }       : {}),
            ...(customFat      ? { fat: parseInt(customFat, 10) }           : {}),
          };
        }
        return undefined;
      })(),
    });
  };

  // ── Derived ─────────────────────────────────────────────────────────────────

  // toggleModifier + availableModifiers removed — modifiers are gone.
  const cat = goalCategory(selectedGoal);
  // targetFocusesForGoal removed — replaced by priorityRegion 3-option picker
  const weightGoalIds = new Set(['lose_fat', 'get_lean', 'cut', 'preserve_muscle_cutting', 'build_muscle', 'lean_bulk', 'gain_weight']);
  const isWeightGoal   = weightGoalIds.has(selectedGoal);
  const eventCategories = new Set<string>(['strength', 'cardio_endurance', 'athletic_performance']);
  const showTargetEvent = cat ? eventCategories.has(cat) : false;
  const paceOptions    = pacesForGoal(selectedGoal, meta.paces);
  const standardEquipNames = new Set(meta.equipmentCategories.flatMap(c => c.items.map(i => i.name)));
  const customEquipItems   = equipment.filter(e => !standardEquipNames.has(e));
  const standardFoodNames  = new Set(meta.allFoods.map(f => f.name));
  const customFoodSelected = customFoods.filter(f => !standardFoodNames.has(f.name));
  const foodSearchLower = foodSearch.trim().toLowerCase();
  const filteredFoodCategories = meta.foodCategories
    .filter(category => foodCategoryFilter === 'all' || category.key === foodCategoryFilter)
    .map(category => ({
      ...category,
      foods: category.foods.filter(food => {
        if (!foodSearchLower) return true;
        return [food.name, food.unit ?? '', category.label]
          .join(' ')
          .toLowerCase()
          .includes(foodSearchLower);
      }),
    }))
    .filter(category => category.foods.length > 0);
  const filteredCustomFoods = customFoodSelected.filter(food => {
    if (foodCategoryFilter !== 'all' && foodCategoryFilter !== 'custom') return false;
    if (!foodSearchLower) return true;
    return `${food.name} ${food.unit ?? ''}`.toLowerCase().includes(foodSearchLower);
  });

  const screenTitle = mode === 'workout'
    ? 'Edit Workout'
    : mode === 'mealplan'
      ? 'Edit Meal Plan'
      : mode === 'theme'
        ? 'Themes'
        : mode === 'body'
          ? 'Body & Stats'
          : 'Edit Goal';
  const saveLabel = mode === 'workout'
    ? 'Save & Update Workout'
    : mode === 'mealplan'
      ? 'Save & Update Nutrition'
      : mode === 'theme'
        ? 'Save Theme'
        : mode === 'body'
          ? 'Save Stats'
          : 'Save & Update Plan';

  return (
    <View style={styles.container}>
      {/* Top header bar (Cancel / TITLE / Save) is hidden when this screen
          is rendered inline as tab content — the bottom nav handles
          navigation, and changes auto-save via the parent's onSave when
          the user navigates away. */}
      {!noHeader && (
        <View style={styles.header}>
          <TouchableOpacity onPress={onCancel} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.title}>{screenTitle}</Text>
          <TouchableOpacity
            onPress={handleSave}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            testID="edit-profile-save"
            accessibilityLabel="edit-profile-save"
          >
            <Text style={styles.saveText}>Save</Text>
          </TouchableOpacity>
        </View>
      )}

      <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.content, noHeader && { paddingBottom: 16 }]} keyboardShouldPersistTaps="handled" onScrollBeginDrag={Keyboard.dismiss}>

        {mode === 'goal' && (
        <>
        {/* ── Goal ── Matches onboarding: inline descriptions on every
            card, selected card grows to full width with smooth layout
            animation, full description visible when active. No modal.
            Each card fades + slides up with a staggered delay so the grid
            composes itself visually on mount. Selected icon does a small
            spring scale for tap feedback. */}
        <View style={styles.section}>
          <FadeInView delay={0}>
            <Text style={styles.sectionLabel}>Goal</Text>
          </FadeInView>
          {/* AI matcher — mirrors the onboarding goal screen so
              editing your goal feels like the same flow you used
              during signup. Type a sentence → AI picks the best
              launch goal + reason. */}
          <View style={{
            marginBottom: 16,
            backgroundColor: tc.primary + '10',
            borderRadius: 14,
            borderWidth: 1.5,
            borderColor: tc.primary + '55',
            padding: 14,
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <Ionicons name="sparkles-outline" size={16} color={tc.primary} />
              <Text style={{ fontSize: 12, fontWeight: '800', color: tc.primary, textTransform: 'uppercase', letterSpacing: 0.8 }}>
                Describe your goal
              </Text>
            </View>
            <Text style={{ fontSize: 12, color: tc.textSecondary, marginBottom: 10, lineHeight: 16 }}>
              Tell Thallo what you want in your own words. The AI picks the best-fit goal for you.
            </Text>
            <TextInput
              style={{
                backgroundColor: tc.surface, borderRadius: 10,
                paddingHorizontal: 14, paddingVertical: 14, fontSize: 15,
                color: tc.textPrimary, borderWidth: 1.5, borderColor: tc.primary + '88',
                minHeight: 90, textAlignVertical: 'top',
                marginBottom: 10,
              }}
              placeholder="e.g. I want to lose my belly but keep muscle, train 4 days a week, and feel athletic"
              placeholderTextColor={tc.textMuted}
              value={goalQuery}
              onChangeText={t => { setGoalQuery(t); setGoalMatchReason(null); }}
              multiline
              scrollEnabled
            />
            <TouchableOpacity
              style={{
                backgroundColor: tc.primary, borderRadius: 10,
                paddingVertical: 12, alignItems: 'center', justifyContent: 'center',
                flexDirection: 'row', gap: 6,
                opacity: goalMatchLoading || !goalQuery.trim() ? 0.5 : 1,
              }}
              disabled={goalMatchLoading || !goalQuery.trim()}
              onPress={async () => {
                if (!goalQuery.trim()) return;
                setGoalMatchLoading(true);
                try {
                  const { matchGoal } = await import('../services/api');
                  const res = await matchGoal(goalQuery.trim());
                  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                  setSelectedGoal(res.goal_id);
                  setSelectedModifiers([]);
                  setPace('moderate');
                  setGoalMatchReason(res.reason);
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
              <Text style={{ fontSize: 12, color: tc.primary, marginTop: 8, fontStyle: 'italic' }}>
                {goalMatchReason}
              </Text>
            )}
          </View>
          <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textMuted, marginBottom: 8, letterSpacing: 0.5 }}>
            OR PICK ONE DIRECTLY
          </Text>
          {/* Horizontal carousel — each card is ~80% screen width */}
          <ScrollView
            ref={goalCarouselRef}
            horizontal
            pagingEnabled={false}
            snapToInterval={screenWidth * 0.82 + 12}
            snapToAlignment="start"
            decelerationRate="fast"
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingRight: screenWidth * 0.18, gap: 12 }}
            style={{ marginHorizontal: -20, paddingHorizontal: 20, marginBottom: 6 }}
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
                  onPress={() => {
                    goalCarouselRef.current?.scrollTo({ x: gIdx * (screenWidth * 0.82 + 12), animated: true });
                    LayoutAnimation.configureNext({ duration: 220, update: { type: 'spring', springDamping: 0.75 } });
                    setGoalScrollIdx(gIdx);
                    setSelectedGoal(g.id);
                    setSelectedModifiers([]);
                    setPace('moderate');
                  }}
                  scaleDown={0.97}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    <View style={{
                      width: 38, height: 38, borderRadius: 10,
                      backgroundColor: active ? tc.primary + '22' : tc.surfaceRaised,
                      alignItems: 'center', justifyContent: 'center',
                    }}>
                      <Ionicons name={(catDef?.icon ?? 'flag-outline') as any} size={20} color={active ? tc.primary : tc.textMuted} />
                    </View>
                    <Text style={[styles.goalLabel, active && { color: tc.primary, fontWeight: '700' as const }, { flex: 1 }]}>{g.label}</Text>
                    {active && <Ionicons name="checkmark-circle" size={20} color={tc.primary} />}
                  </View>
                  <Text style={{ fontSize: 13, color: active ? tc.textSecondary : tc.textMuted, lineHeight: 18 }}>
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
                backgroundColor: goalScrollIdx === i ? tc.primary : tc.border,
              }} />
            ))}
          </View>
        </View>

        {/* Goal preview modal. Opens on any card tap; shows the full
            description and two buttons. Selection only commits on
            Confirm so a stray tap doesn't silently blow away the
            user's pace / target-weight / modifier state. */}
        <Modal
          visible={goalPreviewId != null}
          transparent
          animationType="fade"
          onRequestClose={() => setGoalPreviewId(null)}>
          <View style={{ flex: 1, backgroundColor: '#00000099', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            {(() => {
              const g = LAUNCH_GOALS.find(x => x.id === goalPreviewId);
              if (!g) return null;
              const catDef = GOAL_CATEGORIES.find(c => c.id === g.category);
              return (
                <View style={{ backgroundColor: tc.surface, borderRadius: 16, padding: 20, width: '100%', maxWidth: 420, borderWidth: 1, borderColor: tc.border }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    <Ionicons name={(catDef?.icon ?? 'flag-outline') as any} size={28} color={tc.primary} />
                    <Text style={{ fontSize: 20, fontWeight: '700', color: tc.textPrimary, flex: 1 }}>{g.label}</Text>
                  </View>
                  <Text style={{ fontSize: 14, color: tc.textSecondary, lineHeight: 20, marginBottom: 20 }}>
                    {g.description}
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <TouchableOpacity
                      style={{ flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center', backgroundColor: tc.surfaceRaised, borderWidth: 1, borderColor: tc.border }}
                      onPress={() => setGoalPreviewId(null)}>
                      <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textSecondary }}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={{ flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center', backgroundColor: tc.primary }}
                      onPress={() => {
                        setSelectedGoal(g.id);
                        setSelectedModifiers([]);
                        setPace('moderate');
                        setGoalPreviewId(null);
                      }}>
                      <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff' }}>Select this goal</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })()}
          </View>
        </Modal>

        {/* Advanced goals section removed — only the 8 launch goals are
            exposed to users now. The full PRIMARY_GOALS list is still
            defined in goalConfig.ts so profile values saved before the
            cull still resolve correctly. */}

        {/* Modifiers section removed — goals are now defined by the
            primary goal + an optional muscle/target focus only. The
            stored `selectedModifiers` array is kept on the saved profile
            shape (always empty going forward) for back-compat. */}

        {/* Priority Region picker removed — splits now control focus distribution.
           selectedRegion stays hard-defaulted to 'balanced' so save paths work. */}

        {/* ── Pace / Timeline ── */}
        {paceOptions.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>{isWeightGoal ? 'Pace' : 'Timeline'}</Text>
            <View style={styles.paceList}>
              {paceOptions.map(opt => {
                const selected = pace === opt.value;
                return (
                  <TouchableOpacity
                    key={opt.value}
                    style={[styles.paceCard, selected && styles.paceCardActive]}
                    onPress={() => setPace(opt.value as GoalPace)}>
                    <View style={styles.paceTop}>
                      {opt.icon.includes('-') ? <Ionicons name={opt.icon as any} size={20} color={colors.textPrimary} /> : <Text style={styles.paceIcon}>{opt.icon}</Text>}
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.paceLabel, selected && styles.paceLabelActive]}>{opt.label}</Text>
                        <Text style={styles.paceRate}>{opt.rate}</Text>
                      </View>
                    </View>
                    <Text style={styles.paceDesc}>{opt.description}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

        {/* ── Current weight ── */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Current Weight (lbs)</Text>
          <TouchableOpacity
            style={styles.weightBtn}
            onPress={() => { setCurrentWeightInput(currentWeight); setCurrentWeightModalVisible(true); }}>
            <Text style={currentWeight ? styles.weightValue : styles.weightPlaceholder}>
              {currentWeight ? `${currentWeight} lbs` : 'Tap to set current weight'}
            </Text>
            <Text style={styles.editHint}>Edit</Text>
          </TouchableOpacity>
        </View>

        {/* ── Target weight (weight goals only) ── */}
        {isWeightGoal && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Target Weight (lbs)</Text>
            <TouchableOpacity
              style={styles.weightBtn}
              onPress={() => { setWeightInput(targetWeight); setWeightModalVisible(true); }}>
              <Text style={targetWeight ? styles.weightValue : styles.weightPlaceholder}>
                {targetWeight ? `${targetWeight} lbs` : 'Tap to set target weight'}
              </Text>
              <Text style={styles.editHint}>Edit</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Target event (strength / endurance / athletic goals) ── */}
        {showTargetEvent && (() => {
          const label =
            cat === 'strength'              ? 'Strength Target (optional)' :
            cat === 'cardio_endurance'      ? 'Endurance Target (optional)' :
                                              'Performance Target (optional)';
          const placeholder =
            cat === 'strength'              ? 'e.g. 315lb deadlift, 225lb bench' :
            cat === 'cardio_endurance'      ? 'e.g. half marathon, 5K in 25 min' :
                                              'e.g. sub-40s 100m, dunk a basketball';
          return (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>{label}</Text>
              <TextInput
                style={styles.textField}
                value={targetEvent}
                onChangeText={setTargetEvent}
                placeholder={placeholder}
                placeholderTextColor={tc.textMuted}
                autoCapitalize="none"
                returnKeyType="done"
              />
            </View>
          );
        })()}

        </>
        )}

        {/* Add Injury Modal */}
        <Modal visible={showAddInjury} transparent animationType="slide" onRequestClose={() => setShowAddInjury(false)}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
            <TouchableOpacity style={styles.modalBackdrop} activeOpacity={0.7} onPress={() => setShowAddInjury(false)}>
              <View style={[styles.modalSheet, { backgroundColor: tc.surface, borderTopColor: tc.border }]} onStartShouldSetResponder={() => true}>
                <Text style={[styles.modalTitle, { color: tc.textPrimary }]}>Add Injury / Limitation</Text>
                <Text style={[styles.sectionHint, { marginBottom: 12 }]}>Your trainer will avoid movements that aggravate this area.</Text>
                <Text style={[styles.modalFieldLabel, { color: tc.textSecondary }]}>Description</Text>
                <TextInput
                  style={[styles.modalInput, { color: tc.textPrimary, borderColor: tc.border, backgroundColor: tc.background }]}
                  placeholder="e.g. Lower back pain when deadlifting"
                  placeholderTextColor={tc.textMuted}
                  value={injuryDesc}
                  onChangeText={setInjuryDesc}
                  autoFocus
                />
                <Text style={[styles.modalFieldLabel, { color: tc.textSecondary, marginTop: 12 }]}>Body Part</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                  {[
                    { key: 'Shoulder', muscles: ['shoulders', 'chest'] },
                    { key: 'Rotator Cuff', muscles: ['shoulders'] },
                    { key: 'Lower Back', muscles: ['back', 'core', 'hamstrings'] },
                    { key: 'Knee', muscles: ['quads', 'hamstrings'] },
                    { key: 'Hip', muscles: ['glutes', 'hamstrings'] },
                    { key: 'Ankle', muscles: ['calves'] },
                    { key: 'Elbow', muscles: ['biceps', 'triceps'] },
                    { key: 'Wrist', muscles: ['shoulders'] },
                    { key: 'Neck', muscles: ['shoulders', 'core'] },
                    { key: 'Chest', muscles: ['chest', 'triceps'] },
                  ].map(bp => (
                    <TouchableOpacity
                      key={bp.key}
                      style={{
                        paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8,
                        borderWidth: 1,
                        borderColor: injuryBodyPart === bp.key ? tc.primary : tc.border,
                        backgroundColor: injuryBodyPart === bp.key ? tc.primary + '18' : tc.background,
                      }}
                      onPress={() => setInjuryBodyPart(bp.key)}>
                      <Text style={{ fontSize: 13, fontWeight: injuryBodyPart === bp.key ? '700' : '500', color: injuryBodyPart === bp.key ? tc.primary : tc.textPrimary }}>
                        {bp.key}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <TouchableOpacity
                  style={[styles.modalConfirmBtn, { backgroundColor: tc.primary, marginTop: 20, opacity: !injuryDesc.trim() || !injuryBodyPart ? 0.5 : 1 }]}
                  disabled={!injuryDesc.trim() || !injuryBodyPart}
                  onPress={() => {
                    const desc = injuryDesc.trim();
                    const part = injuryBodyPart;
                    if (!desc) { Alert.alert('Required', 'Please enter a description.'); return; }
                    if (!part) { Alert.alert('Required', 'Please select a body part.'); return; }
                    const muscleMap: Record<string, string[]> = {
                      'Shoulder': ['shoulders', 'chest'], 'Rotator Cuff': ['shoulders'],
                      'Lower Back': ['back', 'core', 'hamstrings'], 'Knee': ['quads', 'hamstrings'],
                      'Hip': ['glutes', 'hamstrings'], 'Ankle': ['calves'],
                      'Elbow': ['biceps', 'triceps'], 'Wrist': ['shoulders'],
                      'Neck': ['shoulders', 'core'], 'Chest': ['chest', 'triceps'],
                    };
                    const newInjury: InjuryEntry = {
                      id: Date.now().toString(),
                      description: desc,
                      bodyPart: part,
                      muscleGroups: muscleMap[part] ?? [],
                      reportedAt: new Date().toISOString(),
                      status: 'active',
                    };
                    setInjuryEntries(prev => [...prev, newInjury]);
                    setShowAddInjury(false);
                  }}>
                  <Text style={[styles.modalConfirmText, { color: '#fff' }]}>Add</Text>
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          </KeyboardAvoidingView>
        </Modal>

        {/* ── WORKOUT MODE (Equipment + Exercises tabs) ── */}
        {mode === 'workout' && (
        <>
        {/* Inner sub-tab bar hidden when this screen is rendered inline
            in HomeScreen — the bottom-tab sub-tabs already provide the
            same navigation. */}
        {!noHeader && (
        <View style={styles.tabBar}>
          {([
            { key: 'equipment' as const, label: 'Equipment & Schedule' },
            { key: 'exercises' as const, label: 'Exercise Library' },
          ]).map(({ key, label }) => (
            <TouchableOpacity key={key} style={[styles.tab, workoutTab === key && styles.tabActive]} onPress={() => setWorkoutTab(key)}>
              <Text style={[styles.tabText, workoutTab === key && styles.tabTextActive]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        )}

        {workoutTab === 'equipment' && (
        <View style={styles.section}>
          {/* Settings (training days + session length) live at the TOP of
              the Equipment tab so they mirror the Meals tab layout, where
              "Meals per Day" and "Meal Variety" also sit at the top of
              the Foods sub-tab. Previously these were at the bottom and
              the inconsistency was confusing. */}
          <View style={[styles.chipGroup, { marginBottom: 20 }]}>
            <Text style={styles.chipGroupLabel}>Training Days / Week</Text>
            <View style={[styles.daysRow, { marginTop: 8 }]}>
              <TouchableOpacity
                style={[styles.daysBtn, daysPerWeek <= 1 && styles.daysBtnDisabled]}
                onPress={() => setDaysPerWeek(d => Math.max(1, d - 1))}
                disabled={daysPerWeek <= 1}>
                <Text style={styles.daysBtnText}>−</Text>
              </TouchableOpacity>
              <Text style={styles.daysValue}>{daysPerWeek}</Text>
              <TouchableOpacity
                style={[styles.daysBtn, daysPerWeek >= 7 && styles.daysBtnDisabled]}
                onPress={() => setDaysPerWeek(d => Math.min(7, d + 1))}
                disabled={daysPerWeek >= 7}>
                <Text style={styles.daysBtnText}>+</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Day-of-week selector */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16, marginTop: 4 }}>
            {(['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const).map((label, dow) => {
              const selected = trainingDays.includes(dow);
              const atLimit = trainingDays.length >= daysPerWeek && !selected;
              return (
                <TouchableOpacity
                  key={dow}
                  style={{
                    width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
                    backgroundColor: selected ? colors.primary : colors.surfaceRaised,
                    borderWidth: 1.5, borderColor: selected ? colors.primary : colors.border,
                    opacity: atLimit ? 0.4 : 1,
                  }}
                  disabled={atLimit}
                  onPress={() => {
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                    if (selected) {
                      setTrainingDays(prev => prev.filter(d => d !== dow));
                    } else if (trainingDays.length < daysPerWeek) {
                      setTrainingDays(prev => [...prev, dow].sort());
                    }
                  }}>
                  <Text style={{ fontSize: 13, fontWeight: '800', color: selected ? '#fff' : colors.textSecondary }}>{label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {trainingDays.length > 0 && trainingDays.length !== daysPerWeek && (
            <Text style={{ fontSize: 11, color: colors.warning ?? '#F59E0B', marginBottom: 8, marginTop: -8 }}>
              Select {daysPerWeek - trainingDays.length} more day{daysPerWeek - trainingDays.length !== 1 ? 's' : ''}
            </Text>
          )}

          <View style={[styles.chipGroup, { marginBottom: 20 }]}>
            <Text style={styles.chipGroupLabel}>Session Length</Text>
            <View style={[styles.durationRow, { marginTop: 8 }]}>
              {DURATION_OPTIONS.map(opt => (
                <TouchableOpacity
                  key={opt.value}
                  style={[styles.durationBtn, duration === opt.value && styles.durationBtnActive]}
                  onPress={() => setDuration(opt.value)}>
                  <Text style={[styles.durationLabel, duration === opt.value && styles.durationLabelActive]}>{opt.label}</Text>
                  <Text style={[styles.durationDesc,  duration === opt.value && styles.durationDescActive]}>{opt.desc}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* ── Training Split ── */}
          <View style={[styles.chipGroup, { marginBottom: 20 }]}>
            <Text style={styles.chipGroupLabel}>Training Split</Text>
            {(() => {
              const selected = splitOptions.find(o => o.id === preferredSplit);
              const recommended = splitOptions.find(o => o.is_recommended);
              const displayName = preferredSplit === 'auto'
                ? `Auto${recommended ? ` · ${recommended.short_name}` : ''}`
                : selected?.name ?? preferredSplit;
              const displayHint = preferredSplit === 'auto' && recommended
                ? recommended.rationale
                : selected?.rationale ?? 'Tap to choose your training split.';
              return (
                <TouchableOpacity
                  style={[styles.splitCard, { borderColor: tc.border, backgroundColor: tc.surfaceRaised, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}
                  onPress={() => setSplitModalVisible(true)}
                  activeOpacity={0.8}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }}>{displayName}</Text>
                    <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 2 }} numberOfLines={2}>{displayHint}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={tc.textMuted} style={{ marginLeft: 8 }} />
                </TouchableOpacity>
              );
            })()}
          </View>

          <TouchableOpacity
            style={[styles.sectionTopRow, { backgroundColor: tc.surfaceRaised, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: tc.border }]}
            onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setEquipmentExpanded(p => !p); }}
            activeOpacity={0.7}>
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
              <Ionicons name="barbell-outline" size={16} color={tc.textSecondary} style={{ marginRight: 8 }} />
              <Text style={[styles.sectionLabel, { marginBottom: 0 }]}>
                Equipment{equipment.length > 0 ? `  ·  ${equipment.length} selected` : ''}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <TouchableOpacity
                style={styles.sectionAddBtn}
                onPress={() => { setNewEquipName(''); setEquipError(''); setEquipModalVisible(true); }}>
                <Text style={styles.sectionAddBtnText}>+ Add</Text>
              </TouchableOpacity>
              <Ionicons name={equipmentExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={tc.textMuted} />
            </View>
          </TouchableOpacity>
          {equipmentExpanded && (meta.loading ? <ActivityIndicator color={tc.primary} /> : (
            <>
              <Text style={styles.sectionHint}>
                This is the equipment your workout plan uses for exercise selection and load targets. Adjustable dumbbells live here, not in Gear Tracker.
              </Text>
              {meta.equipmentCategories.map(category => (
                <View key={category.label} style={styles.chipGroup}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {category.icon.includes('-') ? <Ionicons name={category.icon as any} size={15} color={colors.textSecondary} /> : <Text style={{ fontSize: 15 }}>{category.icon}</Text>}
                    <Text style={styles.chipGroupLabel}>{category.label}</Text>
                  </View>
                  <View style={styles.chips}>
                    {category.items.map(item => {
                      const selected = equipment.includes(item.name);
                      return (
                        <TouchableOpacity
                          key={item.name}
                          style={[styles.chip, selected && styles.chipActive]}
                          onPress={() => toggleEquipment(item.name)}>
                          <Text style={[styles.chipText, selected && styles.chipTextActive]}>{item.name}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              ))}
              {customEquipItems.length > 0 && (
                <View style={styles.chipGroup}>
                  <Text style={styles.chipGroupLabel}>Custom</Text>
                  <View style={styles.chips}>
                    {customEquipItems.map(name => (
                      <TouchableOpacity
                        key={name}
                        style={[styles.chip, styles.chipActive]}
                        onPress={() => setEquipment(prev => prev.filter(e => e !== name))}>
                        <Text style={[styles.chipText, styles.chipTextActive]}>{name}  <Ionicons name="close" size={12} /></Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              )}
              {renderStrengthLoadSettings()}
            </>
          ))}

          {/* ── Injuries & Limitations ── */}
          <Text style={styles.sectionLabel}>Injuries & Limitations</Text>
          <Text style={styles.sectionHint}>
            Your trainer tracks these and adjusts your plan. Update status as you recover.
          </Text>
          {injuryEntries.length === 0 ? (
            <View style={[styles.injuryEmptyCard, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}>
              <Text style={[styles.injuryEmptyText, { color: tc.textMuted }]}>No injuries logged — great!</Text>
            </View>
          ) : (
            <View style={styles.injuryList}>
              {injuryEntries.map((entry, idx) => {
                const statusColors: Record<InjuryStatus, string> = {
                  active:     '#FF5555',
                  recovering: '#FFB300',
                  resolved:   '#00C488',
                };
                const statusLabels: Record<InjuryStatus, string> = {
                  active:     'Active',
                  recovering: 'Recovering',
                  resolved:   'Resolved',
                };
                return (
                  <View key={entry.id} style={[styles.injuryCard, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}>
                    <View style={styles.injuryCardTop}>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.injuryDesc, { color: tc.textPrimary }]}>{entry.description}</Text>
                        <Text style={[styles.injuryBodyPart, { color: tc.textMuted }]}>
                          {entry.bodyPart}
                          {entry.severity ? ` · ${entry.severity}` : ''}
                          {entry.estimatedRecoveryDate ? ` · est. ${entry.estimatedRecoveryDate}` : ''}
                        </Text>
                        {entry.muscleGroups?.length ? (
                          <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 2 }}>
                            Affects: {entry.muscleGroups.join(', ')}
                          </Text>
                        ) : null}
                      </View>
                      <TouchableOpacity
                        onPress={() => setInjuryEntries(prev => prev.filter((_, i) => i !== idx))}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                        <Ionicons name="close-circle" size={20} color={tc.error ?? '#EF4444'} />
                      </TouchableOpacity>
                    </View>
                    <View style={styles.statusRow}>
                      {(['active', 'recovering', 'resolved'] as InjuryStatus[]).map(s => (
                        <TouchableOpacity
                          key={s}
                          style={[
                            styles.statusBtn,
                            { borderColor: entry.status === s ? statusColors[s] : tc.border },
                            entry.status === s && { backgroundColor: statusColors[s] + '22' },
                          ]}
                          onPress={() => setInjuryEntries(prev =>
                            prev.map((e, i) => i === idx ? { ...e, status: s, statusUpdatedAt: new Date().toISOString() } : e)
                          )}>
                          <Text style={[styles.statusBtnText, { color: entry.status === s ? statusColors[s] : tc.textMuted }]}>
                            {statusLabels[s]}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                );
              })}
            </View>
          )}
          <TouchableOpacity
            activeOpacity={0.75}
            style={[styles.addInjuryBtn, { borderColor: tc.border }]}
            onPress={() => { setInjuryDesc(''); setInjuryBodyPart(''); setShowAddInjury(true); }}>
            <Text style={[styles.addInjuryBtnText, { color: tc.primary }]}>+ Add Injury / Limitation</Text>
          </TouchableOpacity>
        </View>
        )}

        {workoutTab === 'exercises' && (
        <View style={styles.section}>
          {/* Sub-tabs: Exercises / Muscles */}
          <View style={styles.subTabBar}>
            <TouchableOpacity
              style={[styles.subTab, exerciseSubTab === 'exercises' && styles.subTabActive]}
              onPress={() => setExerciseSubTab('exercises')}>
              <Text style={[styles.subTabText, exerciseSubTab === 'exercises' && styles.subTabTextActive]}>Exercises</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.subTab, exerciseSubTab === 'muscles' && styles.subTabActive]}
              onPress={() => setExerciseSubTab('muscles')}>
              <Text style={[styles.subTabText, exerciseSubTab === 'muscles' && styles.subTabTextActive]}>Muscles</Text>
            </TouchableOpacity>
          </View>

          {exerciseSubTab === 'exercises' ? (
            selectedExercise ? (
              /* ── Full exercise detail view ── */
              <View style={{ gap: 14 }}>
                {/* Back bar */}
                <TouchableOpacity
                  onPress={() => setSelectedExercise(null)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: tc.primary + '12', paddingVertical: 10, paddingHorizontal: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: tc.primary + '30' }}
                  activeOpacity={0.7}>
                  <Ionicons name="arrow-back" size={18} color={tc.primary} />
                  <Text style={{ fontSize: 14, color: tc.primary, fontWeight: '700', flex: 1 }}>Back to exercises</Text>
                  <Text style={{ fontSize: 11, color: tc.textMuted }}>Tap to close</Text>
                </TouchableOpacity>

                {(() => {
                  const guide = buildExerciseGuide(selectedExercise);
                  return (
                    <>
                      {/* Top card */}
                      <View style={[styles.exerciseDetail, { gap: 10 }]}>
                        <Text style={styles.exerciseDetailName}>{selectedExercise.name}</Text>
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                          {selectedExercise.primary_muscle && (
                            <View style={[styles.exerciseTag, { backgroundColor: tc.primary + '18' }]}>
                              <Text style={[styles.exerciseTagText, { color: tc.primary }]}>{humanizeToken(selectedExercise.primary_muscle)}</Text>
                            </View>
                          )}
                          {(selectedExercise.secondary_muscles ?? []).length > 0 && (
                            <View style={[styles.exerciseTag, { backgroundColor: tc.textMuted + '18' }]}>
                              <Text style={[styles.exerciseTagText, { color: tc.textSecondary }]}>Also: {(selectedExercise.secondary_muscles ?? []).map(humanizeToken).join(', ')}</Text>
                            </View>
                          )}
                          {selectedExercise.equipment && (
                            <View style={[styles.exerciseTag, { backgroundColor: tc.textMuted + '18' }]}>
                              <Text style={[styles.exerciseTagText, { color: tc.textSecondary }]}>{humanizeToken(selectedExercise.equipment)}</Text>
                            </View>
                          )}
                          {selectedExercise.is_compound && (
                            <View style={[styles.exerciseTag, { backgroundColor: '#FFB30018' }]}>
                              <Text style={[styles.exerciseTagText, { color: '#FFB300' }]}>Compound</Text>
                            </View>
                          )}
                        </View>
                        <TouchableOpacity
                          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: tc.primary, paddingVertical: 10, paddingHorizontal: 14, borderRadius: radius.md, alignSelf: 'flex-start', marginTop: 4 }}
                          onPress={() => setVideoExerciseName(selectedExercise.name)}
                          activeOpacity={0.8}>
                          <Text style={{ fontSize: 14, color: '#fff', fontWeight: '700' }}>▶  Watch Form Video</Text>
                        </TouchableOpacity>
                      </View>

                      <View style={styles.guideSection}>
                        <Text style={styles.guideSectionTitle}>How To Perform It</Text>
                        <Text style={styles.guideSectionBody}>{guide.howTo}</Text>
                      </View>

                      <View style={styles.guideSection}>
                        <Text style={styles.guideSectionTitle}>Setup</Text>
                        <Text style={styles.guideSectionBody}>{guide.setup}</Text>
                      </View>

                      <View style={styles.guideSection}>
                        <Text style={styles.guideSectionTitle}>Movement Cue</Text>
                        <Text style={styles.guideSectionBody}>{guide.movement}</Text>
                      </View>

                      {/* Phase breakdown */}
                      <View style={[styles.phaseBlock, { borderColor: tc.border }]}>
                        <Text style={styles.phaseBlockTitle}>Muscle Phase Breakdown</Text>
                        <View style={styles.phaseRow}>
                          <View style={[styles.phaseBadge, { backgroundColor: tc.primary + '22' }]}>
                            <Text style={[styles.phaseBadgeLabel, { color: tc.primary }]}>↑ LIFTING</Text>
                          </View>
                          <Text style={styles.phaseText}>{guide.concentric}</Text>
                        </View>
                        <View style={[styles.phaseDivider, { backgroundColor: tc.border }]} />
                        <View style={styles.phaseRow}>
                          <View style={[styles.phaseBadge, { backgroundColor: (tc.error ?? '#FF4444') + '22' }]}>
                            <Text style={[styles.phaseBadgeLabel, { color: tc.error ?? '#FF4444' }]}>↓ LOWERING</Text>
                          </View>
                          <Text style={styles.phaseText}>{guide.eccentric}</Text>
                        </View>
                      </View>

                      <View style={styles.guideSection}>
                        <Text style={styles.guideSectionTitle}>What It Hits & Why</Text>
                        <Text style={styles.guideSectionBody}>{guide.hits}</Text>
                        <Text style={[styles.guideSectionBody, { marginTop: 6 }]}>{guide.why}</Text>
                      </View>

                      <View style={styles.guideSection}>
                        <Text style={styles.guideSectionTitle}>How It Should Feel</Text>
                        <Text style={styles.guideSectionBody}>{guide.feel}</Text>
                      </View>

                      <View style={styles.guideSection}>
                        <Text style={[styles.guideSectionTitle, { color: tc.error ?? '#FF4444' }]}>Common Mistake</Text>
                        <Text style={styles.guideSectionBody}>{guide.mistake}</Text>
                      </View>
                    </>
                  );
                })()}
              </View>
            ) : (
              /* ── Exercise list with filters ── */
              <>
                {/* Search — with an AI fallback that queries an LLM when
                    the local library doesn't have what you want. Saved AI
                    results get merged into the local library on next open. */}
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                  <SearchInput
                    containerStyle={{ flex: 1 }}
                    style={[styles.searchInput, { marginBottom: 0 }]}
                    value={exerciseSearch}
                    onChangeText={(t) => { setExerciseSearch(t); if (!t) setAiExerciseResults([]); }}
                    placeholder="Search exercises..."
                    placeholderTextColor={tc.textMuted}
                    returnKeyType="search"
                    onSubmitEditing={handleAiExerciseSearch}
                  />
                  {exerciseSearch.trim().length > 1 && authToken && (
                    <TouchableOpacity
                      style={{ backgroundColor: tc.primary, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, opacity: aiExerciseLoading ? 0.6 : 1 }}
                      onPress={handleAiExerciseSearch}
                      disabled={aiExerciseLoading}>
                      {aiExerciseLoading
                        ? <ActivityIndicator size="small" color="#fff" />
                        : <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>AI Search</Text>}
                    </TouchableOpacity>
                  )}
                </View>

                {aiExerciseResults.length > 0 && (
                  <View style={{ marginTop: 12, marginBottom: 8 }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>AI Results</Text>
                    {aiExerciseResults.map((ex, i) => {
                      const alreadySaved = (customExercises ?? []).some(c => c.name.toLowerCase() === ex.name.toLowerCase());
                      return (
                        <View key={`ai-${ex.name}-${i}`} style={{ backgroundColor: tc.surfaceRaised, borderColor: tc.primary + '55', borderWidth: 1.5, borderRadius: 10, padding: 12, marginBottom: 8 }}>
                          <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }}>{ex.name}</Text>
                          <Text style={{ fontSize: 12, color: tc.primary, marginTop: 2 }}>
                            {ex.primary_muscle} · {ex.equipment} · {ex.sets}×{ex.reps}
                          </Text>
                          <Text style={{ fontSize: 12, color: tc.textSecondary, marginTop: 4 }}>{ex.why}</Text>
                          {ex.form_cues?.length > 0 && (
                            <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 4 }}>
                              Cues: {ex.form_cues.join(' · ')}
                            </Text>
                          )}
                          <TouchableOpacity
                            style={{ alignSelf: 'flex-start', marginTop: 10, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, backgroundColor: alreadySaved ? tc.border : tc.primary }}
                            onPress={() => handleSaveAiExerciseFromEdit(ex)}
                            disabled={alreadySaved}>
                            <Text style={{ color: alreadySaved ? tc.textMuted : '#fff', fontWeight: '700', fontSize: 13 }}>
                              {alreadySaved ? '✓ In Library' : '+ Save to Library'}
                            </Text>
                          </TouchableOpacity>
                        </View>
                      );
                    })}
                  </View>
                )}

                {/* Filters — single row with labeled dropdowns */}
                <View style={{ gap: 6, marginBottom: 10 }}>
                  <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textMuted, textTransform: 'uppercase', letterSpacing: 0.6 }}>Muscle Group</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingBottom: 6 }}>
                    <TouchableOpacity
                      style={[styles.filterChip, exerciseMuscleFilter === 'all' && styles.filterChipActive]}
                      onPress={() => setExerciseMuscleFilter('all')}>
                      <Text style={[styles.filterChipText, exerciseMuscleFilter === 'all' && styles.filterChipTextActive]}>All</Text>
                    </TouchableOpacity>
                    {exerciseMuscleOptions.map(m => (
                      <TouchableOpacity
                        key={m}
                        style={[styles.filterChip, exerciseMuscleFilter === m && styles.filterChipActive]}
                        onPress={() => setExerciseMuscleFilter(exerciseMuscleFilter === m ? 'all' : m)}>
                        <Text style={[styles.filterChipText, exerciseMuscleFilter === m && styles.filterChipTextActive]}>{humanizeToken(m)}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>

                  <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textMuted, textTransform: 'uppercase', letterSpacing: 0.6 }}>Equipment</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingBottom: 6 }}>
                    <TouchableOpacity
                      style={[styles.filterChip, exerciseEquipmentFilter === 'all' && styles.filterChipActive]}
                      onPress={() => setExerciseEquipmentFilter('all')}>
                      <Text style={[styles.filterChipText, exerciseEquipmentFilter === 'all' && styles.filterChipTextActive]}>All</Text>
                    </TouchableOpacity>
                    {exerciseEquipmentOptions.map(e => (
                      <TouchableOpacity
                        key={e}
                        style={[styles.filterChip, exerciseEquipmentFilter === e && styles.filterChipActive]}
                        onPress={() => setExerciseEquipmentFilter(exerciseEquipmentFilter === e ? 'all' : e)}>
                        <Text style={[styles.filterChipText, exerciseEquipmentFilter === e && styles.filterChipTextActive]}>{humanizeToken(e)}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>

                {exerciseLibraryLoading ? (
                  <ActivityIndicator color={tc.primary} style={{ marginTop: 20 }} />
                ) : filteredExerciseLibrary.length === 0 ? (
                  <View style={{ alignItems: 'center', paddingVertical: 30, gap: 6 }}>
                    <Text style={{ fontSize: 28 }}>🔍</Text>
                    <Text style={{ fontSize: 13, color: tc.textMuted }}>No exercises match your filters</Text>
                  </View>
                ) : (
                  <>
                    <Text style={{ fontSize: 11, color: tc.textMuted, marginBottom: 8 }}>
                      {filteredExerciseLibrary.length} exercise{filteredExerciseLibrary.length !== 1 ? 's' : ''}
                    </Text>
                    {filteredExerciseLibrary.slice(0, 50).map((ex, i) => (
                      <TouchableOpacity
                        key={ex.id ?? i}
                        style={styles.exerciseRow}
                        onPress={() => setSelectedExercise(ex)}
                        activeOpacity={0.7}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.exerciseRowName}>{ex.name}</Text>
                          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 3 }}>
                            {ex.primary_muscle && (
                              <View style={[styles.exerciseTag, { backgroundColor: tc.primary + '18' }]}>
                                <Text style={[styles.exerciseTagText, { color: tc.primary }]}>{humanizeToken(ex.primary_muscle)}</Text>
                              </View>
                            )}
                            {ex.equipment && (
                              <View style={[styles.exerciseTag, { backgroundColor: tc.textMuted + '18' }]}>
                                <Text style={[styles.exerciseTagText, { color: tc.textSecondary }]}>{humanizeToken(ex.equipment)}</Text>
                              </View>
                            )}
                            {ex.is_compound && (
                              <View style={[styles.exerciseTag, { backgroundColor: '#FFB30018' }]}>
                                <Text style={[styles.exerciseTagText, { color: '#FFB300' }]}>Compound</Text>
                              </View>
                            )}
                          </View>
                        </View>
                        <Ionicons name="chevron-forward" size={16} color={tc.textMuted} />
                      </TouchableOpacity>
                    ))}
                    {filteredExerciseLibrary.length > 50 && (
                      <Text style={{ fontSize: 12, color: tc.textMuted, textAlign: 'center', paddingVertical: 10 }}>
                        Showing 50 of {filteredExerciseLibrary.length} — narrow your search to see more
                      </Text>
                    )}
                  </>
                )}
              </>
            )
          ) : (
            /* ── Muscles sub-tab ── */
            <>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
                {['all', 'Arms', 'Chest', 'Back', 'Shoulders', 'Legs', 'Glutes', 'Core'].map(region => {
                  const active = muscleRegionFilter === region;
                  return (
                    <TouchableOpacity
                      key={region}
                      style={[styles.filterChip, active && styles.filterChipActive]}
                      onPress={() => setMuscleRegionFilter(region)}>
                      <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                        {region === 'all' ? 'All' : region}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>

              {selectedMuscle ? (
                /* Muscle detail view */
                <View style={{ gap: 12 }}>
                  <TouchableOpacity onPress={() => setSelectedMuscle(null)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ fontSize: 14, color: tc.primary, fontWeight: '600' }}><Ionicons name="arrow-back" size={14} /> Back</Text>
                  </TouchableOpacity>
                  <View style={{ gap: 4 }}>
                    <Text style={{ fontSize: 24 }}>{selectedMuscle.emoji}</Text>
                    <Text style={{ fontSize: 20, fontWeight: '800', color: tc.textPrimary }}>{selectedMuscle.commonName}</Text>
                    <Text style={{ fontSize: 12, color: tc.textMuted, fontStyle: 'italic' }}>{selectedMuscle.name} · {selectedMuscle.bodyRegion}</Text>
                  </View>
                  <Text style={{ fontSize: 14, color: tc.textSecondary, lineHeight: 20 }}>{selectedMuscle.shortDescription}</Text>

                  <View style={styles.muscleSection}>
                    <Text style={styles.muscleSectionTitle}>Location</Text>
                    <Text style={styles.muscleSectionBody}>{selectedMuscle.location}</Text>
                  </View>
                  <View style={styles.muscleSection}>
                    <Text style={styles.muscleSectionTitle}>Function</Text>
                    <Text style={styles.muscleSectionBody}>{selectedMuscle.primaryFunction}</Text>
                  </View>
                  <View style={styles.muscleSection}>
                    <Text style={styles.muscleSectionTitle}>Mind-Muscle Connection</Text>
                    <Text style={styles.muscleSectionBody}>{selectedMuscle.mindMuscleConnection}</Text>
                  </View>
                  <View style={styles.muscleSection}>
                    <Text style={styles.muscleSectionTitle}>Best Exercises</Text>
                    {selectedMuscle.bestExercises.map((ex, i) => (
                      <Text key={i} style={{ fontSize: 13, color: tc.textSecondary, lineHeight: 19, marginTop: 2 }}>• {ex}</Text>
                    ))}
                  </View>
                  <View style={styles.muscleSection}>
                    <Text style={styles.muscleSectionTitle}>Growth Tip</Text>
                    <Text style={styles.muscleSectionBody}>{selectedMuscle.growthTip}</Text>
                  </View>
                  <View style={styles.muscleSection}>
                    <Text style={styles.muscleSectionTitle}>Common Mistakes</Text>
                    <Text style={styles.muscleSectionBody}>{selectedMuscle.commonMistakes}</Text>
                  </View>
                  <View style={styles.muscleSection}>
                    <Text style={styles.muscleSectionTitle}>Recovery</Text>
                    <Text style={styles.muscleSectionBody}>{selectedMuscle.recoveryNote}</Text>
                  </View>
                </View>
              ) : (
                /* Muscle list */
                <>
                  {MUSCLE_LIBRARY
                    .filter(m => muscleRegionFilter === 'all' || m.bodyRegion.toLowerCase().includes(muscleRegionFilter.toLowerCase()))
                    .map(muscle => (
                      <TouchableOpacity
                        key={muscle.id}
                        style={styles.muscleCard}
                        onPress={() => setSelectedMuscle(muscle)}
                        activeOpacity={0.7}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                          <View style={[styles.muscleEmoji, { backgroundColor: muscle.tagColor + '22' }]}>
                            <Text style={{ fontSize: 20 }}>{muscle.emoji}</Text>
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.muscleCardName}>{muscle.commonName}</Text>
                            <Text style={styles.muscleCardRegion}>{muscle.bodyRegion}</Text>
                          </View>
                          <Ionicons name="chevron-forward" size={16} color={tc.textMuted} />
                        </View>
                        <Text style={styles.muscleCardDesc} numberOfLines={2}>{muscle.shortDescription}</Text>
                      </TouchableOpacity>
                    ))}
                </>
              )}
            </>
          )}
        </View>
        )}
        </>
        )}

        {mode === 'theme' && (
        <View style={styles.section}>
          {/* "Show tutorial again" — clears the AsyncStorage gate so
              the tutorial overlay re-fires the next time the user
              lands on HomeScreen. Useful for users who skipped the
              first run and want the tour after exploring. */}
          <TouchableOpacity
            onPress={async () => {
              try {
                await AsyncStorage.removeItem('tutorial_v1_completed');
                Alert.alert(
                  'Tutorial reset',
                  'Open the home tab to see the walkthrough again.',
                );
              } catch (e: any) {
                Alert.alert('Could not reset', e?.message ?? 'Try again.');
              }
            }}
            activeOpacity={0.8}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 12,
              backgroundColor: tc.surface, padding: 14, borderRadius: radius.lg,
              borderWidth: 1, borderColor: tc.border, marginBottom: 14,
            }}>
            <View style={{
              width: 36, height: 36, borderRadius: 18,
              backgroundColor: tc.primary + '22',
              alignItems: 'center', justifyContent: 'center',
            }}>
              <Ionicons name="play-circle-outline" size={20} color={tc.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }}>
                Show tutorial again
              </Text>
              <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }}>
                Re-runs the post-onboarding walkthrough on the next home tab visit.
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={tc.textMuted} />
          </TouchableOpacity>

          {/* DEV: Subscription tier toggle. Flips between free (manual tracking
              only) and pro (full AI features). Remove / hide behind a debug
              flag once the billing flow ships. */}
          <View style={{
            backgroundColor: tc.surfaceRaised, padding: 14, borderRadius: radius.lg,
            borderWidth: 1, borderColor: tc.border, marginBottom: 14,
          }}>
            <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.8, marginBottom: 8 }}>
              DEVELOPER · SUBSCRIPTION TIER
            </Text>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {(['free', 'pro'] as const).map(t => {
                const active = subscriptionTier === t;
                return (
                  <TouchableOpacity
                    key={t}
                    onPress={() => setSubscriptionTier(t)}
                    activeOpacity={0.8}
                    style={{
                      flex: 1, paddingVertical: 10, borderRadius: 10,
                      backgroundColor: active ? tc.primary : tc.surface,
                      borderWidth: 1, borderColor: active ? tc.primary : tc.border,
                      alignItems: 'center',
                    }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: '800', color: active ? tc.background : tc.textSecondary, letterSpacing: 0.6 }}>
                      {t === 'free' ? 'FREE' : 'PRO'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 8, lineHeight: 15 }}>
              {subscriptionTier === 'free'
                ? 'Free: manual tracking only. No AI plan generation, coach, food scan, or smart weight recs.'
                : 'Pro: full feature set including AI plans, coaching, and scanning.'}
            </Text>
          </View>

          <View style={styles.themeList}>
            {THEME_PICKER_ORDER.map((themeName) => {
              const theme = APP_THEMES[themeName];
              const selected = themePreference === theme.name;
              return (
                <TouchableOpacity
                  key={theme.name}
                  style={[
                    styles.themeCard,
                    {
                      backgroundColor: theme.colors.surface,
                      borderColor: selected ? theme.colors.primary : theme.colors.border,
                    },
                  ]}
                  onPress={() => setThemePreference(theme.name)}>
                  <View style={styles.themeCardTop}>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.themeName, { color: theme.colors.textPrimary }]}>{theme.label}</Text>
                      <Text style={[styles.themeDesc, { color: theme.colors.textSecondary }]}>{theme.description}</Text>
                    </View>
                    {selected && (
                      <View style={[styles.themeSelectedBadge, { backgroundColor: theme.colors.primary + '22', borderColor: theme.colors.primary }]}>
                        <Text style={[styles.themeSelectedText, { color: theme.colors.primary }]}>✓ Active</Text>
                      </View>
                    )}
                  </View>
                  <View style={styles.themeSwatches}>
                    <View style={[styles.themeSwatch, { backgroundColor: theme.colors.background, borderColor: theme.colors.border }]} />
                    <View style={[styles.themeSwatch, { backgroundColor: theme.colors.surfaceRaised, borderColor: theme.colors.border }]} />
                    <View style={[styles.themeSwatch, { backgroundColor: theme.colors.primary, borderColor: theme.colors.border }]} />
                    <View style={[styles.themeSwatch, { backgroundColor: theme.colors.accent, borderColor: theme.colors.border }]} />
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

        </View>
        )}

        {mode === 'body' && (
        <View style={styles.section}>
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Weight (lbs)</Text>
            <TextInput
              style={[styles.macroFieldInput, { textAlign: 'left', paddingHorizontal: 14 }]}
              value={currentWeight}
              onChangeText={setCurrentWeight}
              keyboardType="decimal-pad"
              placeholder="e.g. 185"
              placeholderTextColor={tc.textMuted}
            />
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Height</Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.macroFieldLabel, { marginBottom: 6 }]}>Feet</Text>
                <TextInput
                  style={styles.macroFieldInput}
                  value={bodyHeightFeet}
                  onChangeText={setBodyHeightFeet}
                  keyboardType="number-pad"
                  placeholder="5"
                  placeholderTextColor={tc.textMuted}
                  maxLength={1}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.macroFieldLabel, { marginBottom: 6 }]}>Inches</Text>
                <TextInput
                  style={styles.macroFieldInput}
                  value={bodyHeightInches}
                  onChangeText={setBodyHeightInches}
                  keyboardType="number-pad"
                  placeholder="10"
                  placeholderTextColor={tc.textMuted}
                  maxLength={2}
                />
              </View>
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Birthday</Text>
            <BirthdateInput
              value={bodyBirthdate}
              onChange={setBodyBirthdate}
              themeName={profile.themePreference}
              label=""
              hint={(() => {
                // Show a live "(age N)" preview once the three fields
                // form a valid date so users see what's actually going
                // to be saved. Falls back to the stored age when empty.
                const age = bodyBirthdate
                  ? deriveAge(bodyBirthdate)
                  : (bodyAge ? parseInt(bodyAge, 10) : null);
                return age
                  ? `Age ${age} — used for HR zones, calorie math, and readiness.`
                  : 'Used for HR zones, calorie math, and readiness.';
              })()}
            />
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Biological Sex</Text>
            <Text style={styles.sectionHint}>Used to calculate calorie and macro targets.</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {([
                { value: 'male' as const, label: 'Male' },
                { value: 'female' as const, label: 'Female' },
                { value: 'nonbinary' as const, label: 'Non-binary' },
                { value: 'prefer_not_to_say' as const, label: 'Prefer not to say' },
              ]).map(opt => (
                <TouchableOpacity
                  key={opt.value}
                  style={[styles.chip, bodyGender === opt.value && styles.chipActive]}
                  onPress={() => setBodyGender(opt.value)}
                >
                  <Text style={[styles.chipText, bodyGender === opt.value && styles.chipTextActive]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {bodySaving && <ActivityIndicator color={tc.primary} style={{ marginTop: 10 }} />}
        </View>
        )}

        {/* ── MEALPLAN MODE (Foods + Supplements + Macros tabs) ── */}
        {mode === 'mealplan' && (
        <>
        {/* Inner sub-tab bar hidden when rendered inline — the bottom-tab
            sub-tabs already provide the same Foods/Supplements/Macros nav. */}
        {!noHeader && (
        <View style={styles.tabBar}>
          {([
            { key: 'foods' as const, label: 'Foods' },
            { key: 'supplements' as const, label: 'Supplements' },
            { key: 'macros' as const, label: 'Macros' },
          ]).map(({ key, label }) => (
            <TouchableOpacity key={key} style={[styles.tab, mealplanTab === key && styles.tabActive]} onPress={() => setMealplanTab(key)}>
              <Text style={[styles.tabText, mealplanTab === key && styles.tabTextActive]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        )}

        {mealplanTab === 'foods' && (
        <View style={styles.section}>

          {/* ── Foods in Kitchen — PRIMARY, top of tab ─────────────── */}
          <View style={{ marginBottom: 20 }}>
            {/* Header row */}
            <TouchableOpacity
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 10,
                marginBottom: foodsExpanded ? 12 : 0,
              }}
              onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setFoodsExpanded(p => !p); }}
              activeOpacity={0.7}>
              <View style={{
                width: 34, height: 34, borderRadius: 10,
                backgroundColor: tc.primary + '18',
                alignItems: 'center', justifyContent: 'center',
              }}>
                <Ionicons name="nutrition-outline" size={18} color={tc.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: '700', color: tc.textPrimary }}>
                  Your Kitchen
                </Text>
                <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 1 }}>
                  {(() => { const n = foods.filter(f => !f.startsWith('__supp__')).length; return n > 0 ? `${n} food${n !== 1 ? 's' : ''} selected` : 'Tap to pick your foods'; })()}
                </Text>
              </View>
              {(() => { const n = foods.filter(f => !f.startsWith('__supp__')).length; return n > 0 ? (
                <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: tc.primary + '18', borderWidth: 1, borderColor: tc.primary + '40' }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: tc.primary }}>{n}</Text>
                </View>
              ) : null; })()}
              <Ionicons name={foodsExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={tc.textMuted} />
            </TouchableOpacity>

            {/* Add buttons — always visible so users can reach them even when list is collapsed */}
            {foodsExpanded && (
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
                <TouchableOpacity
                  style={[styles.sectionAddBtn, { flex: 1, alignItems: 'center', paddingVertical: 10 }]}
                  onPress={() => handleAddScanPhotos('camera')} disabled={scanFoodsLoading}>
                  <Ionicons name="camera-outline" size={15} color={tc.primary} />
                  <Text style={[styles.sectionAddBtnText, { marginTop: 3 }]}>Camera</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.sectionAddBtn, { flex: 1, alignItems: 'center', paddingVertical: 10 }]}
                  onPress={() => handleAddScanPhotos('library')} disabled={scanFoodsLoading}>
                  <Ionicons name="images-outline" size={15} color={tc.primary} />
                  <Text style={[styles.sectionAddBtnText, { marginTop: 3 }]}>Library</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.sectionAddBtn, { flex: 1, alignItems: 'center', paddingVertical: 10 }]}
                  onPress={() => setAddFoodVisible(true)}>
                  <Ionicons name="add-circle-outline" size={15} color={tc.primary} />
                  <Text style={[styles.sectionAddBtnText, { marginTop: 3 }]}>Manual</Text>
                </TouchableOpacity>
                {authToken && (
                  <TouchableOpacity
                    style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, borderRadius: 10, backgroundColor: tc.primary, gap: 3 }}
                    onPress={() => setBarcodeScanVisible(true)}>
                    <Ionicons name="barcode-outline" size={15} color="#fff" />
                    <Text style={{ fontSize: 11, fontWeight: '700', color: '#fff', marginTop: 3 }}>Scan</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            <View style={{ display: foodsExpanded ? 'flex' : 'none' }}>
            {pendingImages.length > 0 && (
              <View style={{ gap: 6, marginBottom: 10 }}>
                <TextInput
                  style={styles.searchInput}
                  value={scanContext}
                  onChangeText={setScanContext}
                  placeholder="Context (e.g. batch of 4, I eat 3 servings)"
                  placeholderTextColor={tc.textMuted}
                />
                <TouchableOpacity
                  style={[styles.sectionAddBtn, { alignItems: 'center', backgroundColor: tc.primary + '22', borderColor: tc.primary }]}
                  onPress={handleScanFoods}
                  disabled={scanFoodsLoading}>
                  <Text style={[styles.sectionAddBtnText, { color: tc.primary, fontWeight: '700' }]}>
                    {scanFoodsLoading ? 'Scanning…' : `Scan ${pendingImages.length} Photo${pendingImages.length > 1 ? 's' : ''}`}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => { setPendingImages([]); setScanContext(''); }}>
                  <Text style={{ fontSize: 12, color: tc.textMuted, textAlign: 'center' }}>Clear photos</Text>
                </TouchableOpacity>
              </View>
            )}
            {meta.loading ? <ActivityIndicator color={colors.primary} /> : (
              <>
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                  <SearchInput
                    containerStyle={{ flex: 1 }}
                    style={styles.searchInput}
                    value={foodSearch}
                    onChangeText={setFoodSearch}
                    placeholder="Search foods..."
                    placeholderTextColor={tc.textMuted}
                  />
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
                  <TouchableOpacity
                    style={[styles.filterChip, foodCategoryFilter === 'all' && styles.filterChipActive]}
                    onPress={() => setFoodCategoryFilter('all')}>
                    <Text style={[styles.filterChipText, foodCategoryFilter === 'all' && styles.filterChipTextActive]}>All</Text>
                  </TouchableOpacity>
                  {meta.foodCategories.map(category => (
                    <TouchableOpacity
                      key={category.key}
                      style={[styles.filterChip, foodCategoryFilter === category.key && styles.filterChipActive]}
                      onPress={() => setFoodCategoryFilter(category.key)}>
                      <Text style={[styles.filterChipText, foodCategoryFilter === category.key && styles.filterChipTextActive]}>{category.label}</Text>
                    </TouchableOpacity>
                  ))}
                  {customFoodSelected.length > 0 ? (
                    <TouchableOpacity
                      style={[styles.filterChip, foodCategoryFilter === 'custom' && styles.filterChipActive]}
                      onPress={() => setFoodCategoryFilter('custom')}>
                      <Text style={[styles.filterChipText, foodCategoryFilter === 'custom' && styles.filterChipTextActive]}>Custom</Text>
                    </TouchableOpacity>
                  ) : null}
                </ScrollView>

                {filteredFoodCategories.length === 0 && filteredCustomFoods.length === 0 && !aiFoodSearchLoading && aiFoodResults.length === 0 ? (
                  <Text style={styles.emptySearchText}>No local foods match — try AI search below.</Text>
                ) : null}

                {authToken && foodSearch.length > 1 && (
                  <TouchableOpacity
                    style={[styles.sectionAddBtn, { alignItems: 'center', marginBottom: 10, backgroundColor: tc.primary + '18', borderColor: tc.primary }]}
                    onPress={handleAiFoodSearch}
                    disabled={aiFoodSearchLoading}>
                    {aiFoodSearchLoading
                      ? <ActivityIndicator size="small" color={tc.primary} />
                      : <Text style={[styles.sectionAddBtnText, { color: tc.primary, fontWeight: '700' }]}>Search "{foodSearch}" with AI</Text>}
                  </TouchableOpacity>
                )}

                {aiFoodResults.length > 0 && (
                  <View style={{ marginBottom: 16 }}>
                    <Text style={[styles.chipGroupLabel, { marginBottom: 8 }]}>AI Results</Text>
                    {aiFoodResults.map((item, idx) => (
                      <TouchableOpacity
                        key={`${item.name}-${idx}`}
                        style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: tc.surface, borderRadius: radius.md, borderWidth: 1, borderColor: tc.primary + '44', padding: 12, marginBottom: 8 }}
                        onPress={() => addAiFoodResult(item)}>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 14, fontWeight: '600', color: tc.textPrimary }}>{item.name}</Text>
                          <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }}>{item.serving}</Text>
                          <Text style={{ fontSize: 11, color: tc.textSecondary, marginTop: 2 }}>
                            {item.calories} cal · {item.protein}g pro · {item.carbs}g carbs · {item.fat}g fat
                          </Text>
                        </View>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: tc.primary, marginLeft: 8 }}>+ Add</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                {filteredFoodCategories.map(category => (
                  <View key={category.key} style={styles.chipGroup}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      {category.icon.includes('-') ? <Ionicons name={category.icon as any} size={15} color={colors.textSecondary} /> : <Text style={{ fontSize: 15 }}>{category.icon}</Text>}
                      <Text style={styles.chipGroupLabel}>{category.label}</Text>
                    </View>
                    <View style={styles.chips}>
                      {category.foods.map(food => {
                        const selected = foods.includes(food.name);
                        return (
                          <TouchableOpacity
                            key={food.name}
                            style={[styles.chip, selected && styles.chipActive]}
                            onPress={() => toggleFood(food.name)}>
                            <Text style={[styles.chipText, selected && styles.chipTextActive]}>{food.name}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                ))}
                {filteredCustomFoods.length > 0 && (
                  <View style={styles.chipGroup}>
                    <Text style={styles.chipGroupLabel}>Custom</Text>
                    <View style={styles.chips}>
                      {filteredCustomFoods.map(f => {
                        const selected = foods.includes(f.name);
                        return (
                          <TouchableOpacity
                            key={f.name}
                            style={[styles.chip, selected && styles.chipActive]}
                            onPress={() => toggleFood(f.name)}>
                            <Text style={[styles.chipText, selected && styles.chipTextActive]}>
                              {f.name}{f.calories ? ` (${f.calories} cal)` : ''}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                )}
                {savedMeals.length > 0 && (
                  <View style={styles.chipGroup}>
                    <Text style={styles.chipGroupLabel}>Saved Meals</Text>
                    <View style={styles.savedMealsList}>
                      {savedMeals.map((meal) => (
                        <View key={meal.id} style={styles.savedMealCard}>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.savedMealName}>{meal.name}</Text>
                            <Text style={styles.savedMealMeta}>{meal.items.join(', ')}</Text>
                            <Text style={styles.savedMealMeta}>{meal.calories} cal · {meal.protein}g protein</Text>
                          </View>
                          <TouchableOpacity onPress={() => setSavedMeals(prev => prev.filter(x => x.id !== meal.id))}>
                            <Text style={styles.savedMealDelete}>Delete</Text>
                          </TouchableOpacity>
                        </View>
                      ))}
                    </View>
                  </View>
                )}
              </>
            )}
            </View>
          </View>

          {/* ── Settings divider ─────────────────────────────────────── */}
          <View style={{ height: 1, backgroundColor: tc.border, marginBottom: 20 }} />

          {/* ── Meals per day ─────────────────────────────────────────
              How many distinct meals the user eats per day. Drives the
              backend assembler's `mealsPerDay`, which in turn determines
              how many meals the algorithm generates after subtracting
              pinned routines. Range 1–10. */}
          <View style={[styles.chipGroup, { marginBottom: 20 }]}>
            <Text style={styles.chipGroupLabel}>Meals per Day</Text>
            <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 17, marginBottom: 10 }}>
              How many meals per day. Pinned routines count toward the total.
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <TouchableOpacity
                style={[styles.daysBtn, mealsPerDay <= 1 && styles.daysBtnDisabled]}
                onPress={() => setMealsPerDay(v => Math.max(1, v - 1))}
                disabled={mealsPerDay <= 1}>
                <Text style={styles.daysBtnText}>−</Text>
              </TouchableOpacity>
              <View style={{ alignItems: 'center', minWidth: 140 }}>
                <Text style={styles.daysValue}>{mealsPerDay}</Text>
                <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }}>
                  {mealsPerDay === 1 ? 'OMAD' : `${mealsPerDay} meals / day`}
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.daysBtn, mealsPerDay >= 10 && styles.daysBtnDisabled]}
                onPress={() => setMealsPerDay(v => Math.min(10, v + 1))}
                disabled={mealsPerDay >= 10}>
                <Text style={styles.daysBtnText}>+</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* ── Meal variety ──────────────────────────────────────────
              How many distinct daily meal templates the AI builds. The
              app rotates these across your week. Lower = faster plan
              generation, higher = more variety day-to-day. */}
          <View style={[styles.chipGroup, { marginBottom: 20 }]}>
            <Text style={styles.chipGroupLabel}>🔁  Meal Variety</Text>
            <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 17, marginBottom: 10 }}>
              Daily rotation. 1 = same plan every day. Every plan still hits your macros exactly.
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <TouchableOpacity
                style={[styles.daysBtn, mealVariety <= 1 && styles.daysBtnDisabled]}
                onPress={() => setMealVariety(v => Math.max(1, v - 1))}
                disabled={mealVariety <= 1}>
                <Text style={styles.daysBtnText}>−</Text>
              </TouchableOpacity>
              <View style={{ alignItems: 'center', minWidth: 140 }}>
                <Text style={styles.daysValue}>{mealVariety}</Text>
                <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }}>
                  {mealVariety === 1
                    ? 'Same plan every day (fastest)'
                    : mealVariety === 7
                      ? 'Unique plan every day (slowest)'
                      : `${mealVariety} rotating plans`}
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.daysBtn, mealVariety >= 7 && styles.daysBtnDisabled]}
                onPress={() => setMealVariety(v => Math.min(7, v + 1))}
                disabled={mealVariety >= 7}>
                <Text style={styles.daysBtnText}>+</Text>
              </TouchableOpacity>
            </View>
            <Text style={{ fontSize: 11, color: tc.textMuted, lineHeight: 15 }}>
              Example at 3: Mon/Thu/Sun use Plan A, Tue/Fri use Plan B, Wed/Sat use Plan C.
            </Text>
          </View>

          {/* ── Allergens ──────────────────────────────────────────── */}
          <View style={[styles.chipGroup, { marginBottom: 20 }]}>
            <Text style={styles.chipGroupLabel}>Allergens / Intolerances</Text>
            <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 17, marginBottom: 10 }}>
              Flagged foods will be blocked from meal plans and warned on log.
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {(['dairy', 'gluten', 'tree_nut', 'peanut', 'egg', 'soy', 'shellfish', 'fish', 'sesame', 'mustard', 'celery', 'lupin', 'sulfites', 'mollusks'] as const).map(a => {
                const selected = allergies.includes(a);
                const label = a.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
                return (
                  <TouchableOpacity
                    key={a}
                    onPress={() => setAllergies(prev => selected ? prev.filter(x => x !== a) : [...prev, a])}
                    style={{
                      paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8,
                      backgroundColor: selected ? tc.error + '20' : tc.surfaceRaised,
                      borderWidth: 1, borderColor: selected ? tc.error : tc.border,
                    }}>
                    <Text style={{ fontSize: 12, fontWeight: selected ? '700' : '500', color: selected ? tc.error : tc.textSecondary }}>
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

        </View>
        )}

        {mealplanTab === 'supplements' && (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>
            My Supplements{(profile.supplementsAvailable ?? []).length > 0 ? `  ·  ${(profile.supplementsAvailable ?? []).length} selected` : ''}
          </Text>
          <Text style={styles.sectionHint}>
            Select supplements you take or search for any supplement.
          </Text>
          {/* AI supplement search */}
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
            <TextInput
              style={{
                flex: 1, backgroundColor: tc.surface, borderRadius: 10,
                paddingHorizontal: 12, paddingVertical: 10, fontSize: 14,
                color: tc.textPrimary, borderWidth: 1, borderColor: tc.border,
              }}
              placeholder="Search supplements (e.g. ashwagandha, zinc)"
              placeholderTextColor={tc.textMuted}
              value={suppSearchQuery}
              onChangeText={setSuppSearchQuery}
              returnKeyType="search"
              onSubmitEditing={async () => {
                if (!suppSearchQuery.trim() || !authToken) return;
                setSuppSearchLoading(true);
                try {
                  const { lookupSupplement } = await import('../services/api');
                  const res = await lookupSupplement(authToken, suppSearchQuery.trim());
                  if (res.found && res.name) {
                    const tag = '__supp__' + res.name;
                    if (!foods.includes(tag)) {
                      setFoods(prev => [...prev, tag]);
                    }
                    setSuppSearchResult(res);
                  } else {
                    setSuppSearchResult(null);
                    Alert.alert('Not found', 'No supplement matched your search. Try a different name.');
                  }
                } catch { setSuppSearchResult(null); }
                setSuppSearchLoading(false);
              }}
            />
            <TouchableOpacity
              style={{
                backgroundColor: tc.primary, borderRadius: 10,
                paddingHorizontal: 14, justifyContent: 'center',
                opacity: suppSearchLoading || !suppSearchQuery.trim() ? 0.5 : 1,
              }}
              disabled={suppSearchLoading || !suppSearchQuery.trim()}
              onPress={async () => {
                if (!suppSearchQuery.trim() || !authToken) return;
                setSuppSearchLoading(true);
                try {
                  const { lookupSupplement } = await import('../services/api');
                  const res = await lookupSupplement(authToken, suppSearchQuery.trim());
                  if (res.found && res.name) {
                    const tag = '__supp__' + res.name;
                    if (!foods.includes(tag)) setFoods(prev => [...prev, tag]);
                    setSuppSearchResult(res);
                  } else {
                    setSuppSearchResult(null);
                    Alert.alert('Not found', 'No supplement matched. Try a different name.');
                  }
                } catch { setSuppSearchResult(null); }
                setSuppSearchLoading(false);
              }}>
              {suppSearchLoading
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>Add</Text>
              }
            </TouchableOpacity>
          </View>
          {suppSearchResult && suppSearchResult.found && (
            <View style={{ backgroundColor: tc.primary + '12', borderRadius: 10, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: tc.primary + '33' }}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: tc.primary }}>{suppSearchResult.name}</Text>
              {suppSearchResult.tagline ? <Text style={{ fontSize: 12, color: tc.textSecondary, marginTop: 2 }}>{suppSearchResult.tagline}</Text> : null}
              {suppSearchResult.dose ? <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 4 }}>Dose: {suppSearchResult.dose}</Text> : null}
              {suppSearchResult.timing ? <Text style={{ fontSize: 11, color: tc.textMuted }}>Timing: {suppSearchResult.timing}</Text> : null}
              <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 4, fontStyle: 'italic' }}>Added to your supplements</Text>
            </View>
          )}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
            {[
              { key: 'all', label: 'All' },
              { key: 'Performance', label: 'Performance' },
              { key: 'Protein', label: 'Protein' },
              { key: 'Recovery', label: 'Recovery' },
              { key: 'Health', label: 'Health' },
              { key: 'Sleep & Stress', label: 'Sleep' },
              { key: 'Weight Management', label: 'Weight' },
            ].map(cat => (
              <TouchableOpacity
                key={cat.key}
                style={[styles.filterChip, foodCategoryFilter === cat.key && styles.filterChipActive]}
                onPress={() => setFoodCategoryFilter(cat.key)}>
                <Text style={[styles.filterChipText, foodCategoryFilter === cat.key && styles.filterChipTextActive]}>{cat.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <View style={styles.chips}>
            {[
              { name: 'Creatine Monohydrate', category: 'Performance' },
              { name: 'Whey Protein', category: 'Protein' },
              { name: 'Casein Protein', category: 'Protein' },
              { name: 'Plant Protein Blend', category: 'Protein' },
              { name: 'Pre-Workout', category: 'Performance' },
              { name: 'BCAAs', category: 'Recovery' },
              { name: 'EAAs', category: 'Recovery' },
              { name: 'Beta-Alanine', category: 'Performance' },
              { name: 'Citrulline Malate', category: 'Performance' },
              { name: 'L-Glutamine', category: 'Recovery' },
              { name: 'Fish Oil / Omega-3', category: 'Health' },
              { name: 'Vitamin D3', category: 'Health' },
              { name: 'Multivitamin', category: 'Health' },
              { name: 'Magnesium', category: 'Health' },
              { name: 'Zinc', category: 'Health' },
              { name: 'Ashwagandha', category: 'Sleep & Stress' },
              { name: 'Melatonin', category: 'Sleep & Stress' },
              { name: 'Caffeine Pills', category: 'Performance' },
              { name: 'L-Carnitine', category: 'Weight Management' },
              { name: 'CLA', category: 'Weight Management' },
              { name: 'Collagen Peptides', category: 'Recovery' },
              { name: 'Digestive Enzymes', category: 'Health' },
              { name: 'Probiotics', category: 'Health' },
              { name: 'Turmeric / Curcumin', category: 'Health' },
              { name: 'Iron', category: 'Health' },
              { name: 'Electrolyte Mix', category: 'Recovery' },
            ]
              .filter(s => foodCategoryFilter === 'all' || s.category === foodCategoryFilter)
              .map(s => {
                const tag = '__supp__' + s.name;
                const active = foods.includes(tag);
                return (
                  <TouchableOpacity
                    key={s.name}
                    style={[styles.chip, active && styles.chipActive]}
                    onPress={() => setFoods(prev => prev.includes(tag) ? prev.filter(f => f !== tag) : [...prev, tag])}>
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{s.name}</Text>
                  </TouchableOpacity>
                );
              })}
          </View>
        </View>
        )}

        {(mealplanTab === 'macros' || mealplanTab === 'foods') && (
        <>
        {/* Reference card: cut / maintain / bulk calories at a glance.
            Informational only — doesn't change the user's actual goal.
            Lets them see where their other options would land. */}
        <View style={[styles.section, { marginBottom: 14 }]}>
          <Text style={[styles.sectionLabel, { marginBottom: 4 }]}>Your Calorie Ranges</Text>
          <Text style={styles.sectionHint}>
            Calculated from your body stats and training volume. This is informational — your current goal's target is below.
          </Text>
          {calorieRangesLoading ? (
            <ActivityIndicator color={tc.primary} style={{ marginTop: 14 }} />
          ) : calorieRanges ? (
            <View style={{ marginTop: 14, gap: 8 }}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1, backgroundColor: tc.surface, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: tc.border }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Cut</Text>
                  <Text style={{ fontSize: 22, fontWeight: '800', color: tc.textPrimary, marginTop: 4 }}>{calorieRanges.cut_calories}</Text>
                  <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }}>cal · {calorieRanges.cut_protein_g}g protein</Text>
                </View>
                <View style={{ flex: 1, backgroundColor: tc.primary + '15', padding: 12, borderRadius: radius.md, borderWidth: 1.5, borderColor: tc.primary + '55' }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: tc.primary, textTransform: 'uppercase', letterSpacing: 0.5 }}>Maintain</Text>
                  <Text style={{ fontSize: 22, fontWeight: '800', color: tc.textPrimary, marginTop: 4 }}>{calorieRanges.maintenance_calories}</Text>
                  <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }}>cal · {calorieRanges.maintain_protein_g}g protein</Text>
                </View>
                <View style={{ flex: 1, backgroundColor: tc.surface, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: tc.border }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Bulk</Text>
                  <Text style={{ fontSize: 22, fontWeight: '800', color: tc.textPrimary, marginTop: 4 }}>{calorieRanges.bulk_calories}</Text>
                  <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }}>cal · {calorieRanges.bulk_protein_g}g protein</Text>
                </View>
              </View>
              <Text style={{ fontSize: 10, color: tc.textMuted, lineHeight: 14, marginTop: 4 }}>
                BMR {calorieRanges.bmr} · activity multiplier {calorieRanges.activity_multiplier}× · ranges use a moderate pace
              </Text>
            </View>
          ) : (
            <Text style={[styles.sectionHint, { marginTop: 8 }]}>Couldn't load your calorie ranges. Open the Profile tab and re-save your stats to refresh.</Text>
          )}
        </View>

        <View style={styles.section}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <Text style={styles.sectionLabel}>Daily Macro Targets</Text>
            {/* Grams / Percentage toggle */}
            <View style={{ flexDirection: 'row', borderRadius: 8, borderWidth: 1, borderColor: tc.border, overflow: 'hidden' }}>
              <TouchableOpacity
                style={{ paddingHorizontal: 12, paddingVertical: 6, backgroundColor: !macroPctMode ? tc.primary : 'transparent' }}
                onPress={() => setMacroPctMode(false)}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: !macroPctMode ? '#fff' : tc.textMuted }}>Grams</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{ paddingHorizontal: 12, paddingVertical: 6, backgroundColor: macroPctMode ? tc.primary : 'transparent' }}
                onPress={() => setMacroPctMode(true)}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: macroPctMode ? '#fff' : tc.textMuted }}>% of Cal</Text>
              </TouchableOpacity>
            </View>
          </View>
          <Text style={styles.sectionHint}>
            {macroPctMode
              ? 'Set calories first, then split protein / carbs / fat by percentage. Grams are computed automatically.'
              : 'Leave blank to use the calculator. Filled values override.'}
          </Text>
          <View style={{ marginTop: 14, gap: 10 }}>
            {/* Calories — always shown in both modes */}
            <View>
              <Text style={styles.macroFieldLabel}>Calories</Text>
              <TextInput
                style={styles.macroFieldInput}
                value={customCalories}
                onChangeText={setCustomCalories}
                placeholder="e.g. 2400"
                placeholderTextColor={tc.textMuted}
                keyboardType="number-pad"
              />
            </View>

            {macroPctMode ? (
              <>
                {/* Percentage inputs */}
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.macroFieldLabel}>Protein %</Text>
                    <TextInput
                      style={styles.macroFieldInput}
                      value={proteinPct}
                      onChangeText={setProteinPct}
                      placeholder="30"
                      placeholderTextColor={tc.textMuted}
                      keyboardType="number-pad"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.macroFieldLabel}>Carbs %</Text>
                    <TextInput
                      style={styles.macroFieldInput}
                      value={carbsPct}
                      onChangeText={setCarbsPct}
                      placeholder="40"
                      placeholderTextColor={tc.textMuted}
                      keyboardType="number-pad"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.macroFieldLabel}>Fat %</Text>
                    <TextInput
                      style={styles.macroFieldInput}
                      value={fatPct}
                      onChangeText={setFatPct}
                      placeholder="30"
                      placeholderTextColor={tc.textMuted}
                      keyboardType="number-pad"
                    />
                  </View>
                </View>
                {/* Live preview of computed grams */}
                {customCalories ? (() => {
                  const cal = parseInt(customCalories, 10) || 0;
                  const pp = parseInt(proteinPct, 10) || 0;
                  const cp = parseInt(carbsPct, 10) || 0;
                  const fp = parseInt(fatPct, 10) || 0;
                  const totalPct = pp + cp + fp;
                  const pg = Math.round(cal * pp / 400);
                  const cg = Math.round(cal * cp / 400);
                  const fg = Math.round(cal * fp / 900);
                  const warnColor = totalPct !== 100 ? '#EF4444' : tc.textMuted;
                  return (
                    <View style={{ backgroundColor: tc.surface, borderRadius: 8, padding: 10, borderWidth: 1, borderColor: tc.border }}>
                      <Text style={{ fontSize: 12, color: tc.textSecondary }}>
                        = {pg}g protein · {cg}g carbs · {fg}g fat
                      </Text>
                      <Text style={{ fontSize: 11, color: warnColor, marginTop: 2 }}>
                        Total: {totalPct}% {totalPct !== 100 ? '(should be 100%)' : '✓'}
                      </Text>
                    </View>
                  );
                })() : null}
              </>
            ) : (
              <>
                {/* Gram inputs (original) */}
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.macroFieldLabel}>Protein (g)</Text>
                    <TextInput
                      style={styles.macroFieldInput}
                      value={customProtein}
                      onChangeText={setCustomProtein}
                      placeholder="e.g. 180"
                      placeholderTextColor={tc.textMuted}
                      keyboardType="number-pad"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.macroFieldLabel}>Carbs (g)</Text>
                    <TextInput
                      style={styles.macroFieldInput}
                      value={customCarbs}
                      onChangeText={setCustomCarbs}
                      placeholder="e.g. 250"
                      placeholderTextColor={tc.textMuted}
                      keyboardType="number-pad"
                    />
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.macroFieldLabel}>Fat (g)</Text>
                    <TextInput
                      style={styles.macroFieldInput}
                      value={customFat}
                      onChangeText={setCustomFat}
                      placeholder="e.g. 70"
                      placeholderTextColor={tc.textMuted}
                      keyboardType="number-pad"
                    />
                  </View>
                  <View style={{ flex: 1 }} />
                </View>
              </>
            )}
          </View>
        </View>

        {/* Meal routine section removed from the macros tab. Pinning a meal
            as a routine now happens directly from the Home screen meal card,
            which keeps macro snapshots in sync automatically. */}
        </>
        )}
        </>
        )}

        {noHeader && (
          <TouchableOpacity style={[styles.saveBtn, { marginTop: 20, marginBottom: 16 }]} onPress={handleSave}>
            <Text style={styles.saveBtnText}>{saveLabel}</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      {!noHeader && (
        <View style={styles.stickyBottom}>
          <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
            <Text style={styles.saveBtnText}>{saveLabel}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Split picker modal ── */}
      <Modal visible={splitModalVisible} transparent animationType="slide" onRequestClose={() => setSplitModalVisible(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: tc.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '85%', borderTopWidth: 1, borderTopColor: tc.border }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 10 }}>
              <Text style={{ fontSize: 18, fontWeight: '700', color: tc.textPrimary }}>Choose your split</Text>
              <TouchableOpacity onPress={() => setSplitModalVisible(false)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Text style={{ fontSize: 15, fontWeight: '600', color: tc.primary }}>Done</Text>
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}>
              {/* Auto option */}
              <TouchableOpacity
                style={[styles.splitCard, {
                  borderColor: preferredSplit === 'auto' ? tc.primary : tc.border,
                  backgroundColor: preferredSplit === 'auto' ? tc.primary + '12' : tc.surfaceRaised,
                  marginBottom: 8,
                }]}
                onPress={() => { setPreferredSplit('auto'); setSplitModalVisible(false); }}
                activeOpacity={0.8}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 15, fontWeight: '700', color: preferredSplit === 'auto' ? tc.primary : tc.textPrimary }}>
                    Auto (recommended)
                  </Text>
                  {preferredSplit === 'auto' && <Ionicons name="checkmark" size={18} color={tc.primary} />}
                </View>
                <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 3 }}>
                  Best split for your goal + training days.
                </Text>
              </TouchableOpacity>

              {splitOptions.map(opt => {
                const active = preferredSplit === opt.id;
                return (
                  <TouchableOpacity
                    key={opt.id}
                    style={[styles.splitCard, {
                      borderColor: active ? tc.primary : opt.is_recommended ? tc.primary + '44' : tc.border,
                      backgroundColor: active ? tc.primary + '12' : tc.surfaceRaised,
                      marginBottom: 8,
                    }]}
                    onPress={() => { setPreferredSplit(opt.id); setSplitModalVisible(false); }}
                    activeOpacity={0.8}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                        <Text style={{ fontSize: 15, fontWeight: '700', color: active ? tc.primary : tc.textPrimary }}>
                          {opt.name}
                        </Text>
                        <View style={{ backgroundColor: tc.surface, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 }}>
                          <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted }}>{opt.fit_score}%</Text>
                        </View>
                        {opt.is_recommended && (
                          <View style={{ backgroundColor: tc.primary + '18', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 }}>
                            <Text style={{ fontSize: 10, fontWeight: '800', color: tc.primary }}>BEST FIT</Text>
                          </View>
                        )}
                      </View>
                      {active && <Ionicons name="checkmark" size={18} color={tc.primary} />}
                    </View>
                    <Text style={{ fontSize: 12, color: tc.textSecondary, marginTop: 4, lineHeight: 16 }}>
                      {opt.description}
                    </Text>
                    {opt.region_warning && (
                      <View style={{ backgroundColor: '#F59E0B' + '18', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 5, marginTop: 6 }}>
                        <Text style={{ fontSize: 11, color: '#F59E0B', fontWeight: '600' }}>⚠ {opt.region_warning}</Text>
                      </View>
                    )}
                    {/* Day preview pills */}
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                      {opt.day_labels.map((label, i) => (
                        <Text key={i} style={{
                          fontSize: 10, fontWeight: '600',
                          color: active ? tc.primary : tc.textMuted,
                          backgroundColor: active ? tc.primary + '15' : tc.background,
                          paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5, overflow: 'hidden',
                        }}>
                          {label}
                        </Text>
                      ))}
                    </View>
                    {/* Stimulus detail */}
                    <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 6, lineHeight: 15 }}>
                      {opt.stimulus_note}
                    </Text>
                    {/* Pros / Cons */}
                    <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
                      <View style={{ flex: 1 }}>
                        {opt.pros.map((p, i) => (
                          <Text key={i} style={{ fontSize: 11, color: '#10B981', lineHeight: 16 }}>+ {p}</Text>
                        ))}
                      </View>
                      <View style={{ flex: 1 }}>
                        {opt.cons.map((c, i) => (
                          <Text key={i} style={{ fontSize: 11, color: tc.textMuted, lineHeight: 16 }}>− {c}</Text>
                        ))}
                      </View>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ── Modals ── */}
      <InputModal
        visible={currentWeightModalVisible}
        title="Current Weight" subtitle="Your weight right now"
        placeholder="e.g. 185" value={currentWeightInput} onChange={setCurrentWeightInput}
        onConfirm={() => { setCurrentWeight(currentWeightInput); setCurrentWeightModalVisible(false); }}
        onClose={() => setCurrentWeightModalVisible(false)}
        confirmLabel="Update" keyboardType="decimal-pad" themeColors={tc}
      />
      <InputModal
        visible={weightModalVisible}
        title="Target Weight" subtitle="How much do you want to weigh?"
        placeholder="e.g. 175" value={weightInput} onChange={setWeightInput}
        onConfirm={() => { setTargetWeight(weightInput); setWeightModalVisible(false); }}
        onClose={() => setWeightModalVisible(false)}
        confirmLabel="Set" keyboardType="decimal-pad" themeColors={tc}
      />
      <InputModal
        visible={equipModalVisible}
        title="Add Equipment" subtitle="Enter the name of your equipment"
        placeholder="e.g. Resistance bands, TRX"
        value={newEquipName} onChange={v => { setNewEquipName(v); setEquipError(''); }}
        onConfirm={handleAddEquipment}
        onClose={() => setEquipModalVisible(false)}
        confirmLabel="Add" error={equipError} themeColors={tc}
      />
      <AddFoodModal visible={addFoodVisible} onAdd={handleAddCustomFood} onClose={() => setAddFoodVisible(false)} themeColors={tc} />

      {/* ── Meal Routine modal ── */}
      <Modal visible={routineModalVisible} transparent animationType="slide" onRequestClose={() => setRoutineModalVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} activeOpacity={1} onPress={() => setRoutineModalVisible(false)} />
          <View style={{ backgroundColor: tc.surface, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, borderTopWidth: 1, borderTopColor: tc.border, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 32, maxHeight: '90%' }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: tc.border, alignSelf: 'center', marginBottom: 14 }} />
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <Text style={{ fontSize: 17, fontWeight: '800', color: tc.textPrimary }}>{editingRoutine ? 'Edit Routine' : 'New Routine'}</Text>
              <TouchableOpacity onPress={() => setRoutineModalVisible(false)}><Text style={{ fontSize: 14, color: tc.textMuted, fontWeight: '600' }}>Cancel</Text></TouchableOpacity>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {/* Photo */}
              <TouchableOpacity onPress={handleRoutinePickPhoto} activeOpacity={0.8} style={{ borderRadius: radius.lg, overflow: 'hidden', marginBottom: 14, height: 130, backgroundColor: tc.surfaceRaised, alignItems: 'center', justifyContent: 'center', borderWidth: routinePhotoUri ? 0 : 1, borderStyle: 'dashed', borderColor: tc.border }}>
                {routinePhotoUri ? (
                  <Image source={{ uri: routinePhotoUri }} style={{ width: '100%', height: 130 }} resizeMode="cover" />
                ) : (
                  <View style={{ alignItems: 'center', gap: 4 }}>
                    <Ionicons name="camera-outline" size={28} color={tc.primary} />
                    <Text style={{ fontSize: 13, color: tc.textSecondary, fontWeight: '600' }}>Add photo (optional)</Text>
                  </View>
                )}
              </TouchableOpacity>
              {/* Name */}
              <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Routine Name *</Text>
              <TextInput value={routineName} onChangeText={setRoutineName} placeholder="e.g. High Protein Breakfast" placeholderTextColor={tc.textMuted} style={{ borderWidth: 1, borderColor: tc.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: tc.textPrimary, backgroundColor: tc.surfaceRaised, marginBottom: 14 }} />
              {/* Meal type */}
              <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Meal Type (optional)</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
                {['breakfast', 'lunch', 'dinner', 'snack', 'custom'].map(t => (
                  <TouchableOpacity key={t} onPress={() => setRoutineMealType(routineMealType === t ? '' : t)} style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.full, borderWidth: 1, borderColor: routineMealType === t ? tc.primary : tc.border, backgroundColor: routineMealType === t ? tc.primary + '22' : 'transparent' }}>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: routineMealType === t ? tc.primary : tc.textSecondary, textTransform: 'capitalize' }}>{t}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              {/* Foods */}
              <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Foods</Text>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                <TextInput value={routineFoodInput} onChangeText={setRoutineFoodInput} placeholder="Food name" placeholderTextColor={tc.textMuted} style={{ flex: 2, borderWidth: 1, borderColor: tc.border, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 9, fontSize: 14, color: tc.textPrimary, backgroundColor: tc.surfaceRaised }} />
                <TextInput value={routineFoodQtyInput} onChangeText={setRoutineFoodQtyInput} placeholder="Qty" placeholderTextColor={tc.textMuted} style={{ flex: 1, borderWidth: 1, borderColor: tc.border, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 9, fontSize: 14, color: tc.textPrimary, backgroundColor: tc.surfaceRaised }} />
                <TouchableOpacity onPress={handleRoutineAddFood} style={{ backgroundColor: tc.primary, borderRadius: radius.md, paddingHorizontal: 14, justifyContent: 'center' }}>
                  <Text style={{ fontSize: 20, color: '#fff', fontWeight: '700', lineHeight: 24 }}>+</Text>
                </TouchableOpacity>
              </View>
              {routineFoods.length > 0 && (
                <View style={{ borderWidth: 1, borderColor: tc.border, borderRadius: radius.md, marginBottom: 14, overflow: 'hidden' }}>
                  {routineFoods.map((f, fi) => (
                    <View key={f.id} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: fi < routineFoods.length - 1 ? 1 : 0, borderBottomColor: tc.border }}>
                      <Text style={{ flex: 1, fontSize: 14, color: tc.textPrimary }}>{f.name}{f.quantity ? ` — ${f.quantity}` : ''}</Text>
                      <TouchableOpacity onPress={() => setRoutineFoods(prev => prev.filter(x => x.id !== f.id))} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <Text style={{ fontSize: 16, color: tc.error }}>✕</Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              )}
              {/* Notes */}
              <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Notes (optional)</Text>
              <TextInput value={routineNotes} onChangeText={setRoutineNotes} placeholder="e.g. I have this every morning before the gym" placeholderTextColor={tc.textMuted} multiline style={{ borderWidth: 1, borderColor: tc.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: tc.textPrimary, backgroundColor: tc.surfaceRaised, minHeight: 60, textAlignVertical: 'top', marginBottom: 20 }} />
              <TouchableOpacity onPress={handleRoutineSave} style={{ backgroundColor: tc.primary, borderRadius: radius.lg, paddingVertical: 14, alignItems: 'center', marginBottom: 8 }} activeOpacity={0.85}>
                <Text style={{ fontSize: 15, fontWeight: '800', color: '#fff' }}>{editingRoutine ? 'Save Changes' : 'Save Routine'}</Text>
              </TouchableOpacity>
              {editingRoutine && (
                <TouchableOpacity onPress={() => { setRoutineModalVisible(false); handleRoutineDelete(editingRoutine.id); }} style={{ paddingVertical: 12, alignItems: 'center' }} activeOpacity={0.7}>
                  <Text style={{ fontSize: 14, color: tc.error, fontWeight: '600' }}>Delete this routine</Text>
                </TouchableOpacity>
              )}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Scanned Foods Modal ── */}
      <Modal visible={!!scannedFoods} transparent animationType="slide" onRequestClose={() => setScannedFoods(null)}>
        <View style={styles.centeredBackdrop}>
          <View style={[styles.photoAssessmentModal, { maxHeight: '80%' }]}>
            <View style={styles.photoAssessmentHeader}>
              <Text style={styles.photoAssessmentEyebrow}>AI Food Scan</Text>
              <Text style={styles.photoAssessmentTitle}>Select foods to add</Text>
              <Text style={styles.photoAssessmentSubtitle}>Tap to toggle. Selected foods are added to your list with their macros.</Text>
            </View>
            <ScrollView style={{ maxHeight: 340 }} contentContainerStyle={{ gap: 8 }}>
              {(scannedFoods ?? []).map((item, idx) => (
                <TouchableOpacity
                  key={idx}
                  style={[styles.scannedFoodRow, item.selected && styles.scannedFoodRowSelected]}
                  onPress={() => setScannedFoods(prev => prev?.map((f, i) => i === idx ? { ...f, selected: !f.selected } : f) ?? null)}
                  activeOpacity={0.7}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.scannedFoodName}>{item.name}</Text>
                    <Text style={styles.scannedFoodServing}>{item.serving}</Text>
                    <Text style={styles.scannedFoodMacros}>
                      {item.calories} cal · {item.protein}g P · {item.carbs}g C · {item.fat}g F
                    </Text>
                  </View>
                  <Text style={[styles.scannedFoodCheck, item.selected && styles.scannedFoodCheckSelected]}>
                    {item.selected ? '✓' : '○'}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <View style={styles.photoAssessmentActions}>
              <TouchableOpacity style={styles.photoAssessmentSecondaryBtn} onPress={() => setScannedFoods(null)}>
                <Text style={styles.photoAssessmentSecondaryText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.photoAssessmentPrimaryBtn} onPress={confirmScannedFoods}>
                <Text style={styles.photoAssessmentPrimaryText}>
                  Add {(scannedFoods ?? []).filter(f => f.selected).length} Food{(scannedFoods ?? []).filter(f => f.selected).length !== 1 ? 's' : ''}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={!!photoMealDraft} transparent animationType="fade" onRequestClose={() => setPhotoMealDraft(null)}>
        <KeyboardAvoidingView style={styles.centeredBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <TouchableOpacity style={styles.centeredBackdrop} activeOpacity={1} onPress={() => setPhotoMealDraft(null)}>
            <TouchableOpacity activeOpacity={1} style={styles.photoAssessmentModal} onPress={() => undefined}>
              <View style={styles.photoAssessmentHeader}>
                <Text style={styles.photoAssessmentEyebrow}>Photo Assessment</Text>
                <Text style={styles.photoAssessmentTitle}>Review detected meal</Text>
                <Text style={styles.photoAssessmentSubtitle}>Clean this up if needed, then save it as a reusable meal.</Text>
              </View>

              <TextInput
                style={styles.photoAssessmentInput}
                value={photoMealDraft?.meal_name ?? ''}
                onChangeText={(value) => setPhotoMealDraft(prev => prev ? { ...prev, meal_name: value } : prev)}
                placeholder="Meal name"
                placeholderTextColor={tc.textMuted}
              />

              <View style={styles.photoMealCard}>
                <Text style={styles.photoMealCardTitle}>Detected foods</Text>
                <Text style={styles.photoMealItems}>{photoMealDraft?.items.join(' · ')}</Text>
              </View>

              {/* Servings context */}
              <View style={styles.photoServingsRow}>
                <View style={{ flex: 1, marginRight: 10 }}>
                  <Text style={styles.photoServingsLabel}>My portion</Text>
                  <TextInput
                    style={styles.photoServingsInput}
                    value={photoMealServings}
                    onChangeText={setPhotoMealServings}
                    placeholder="e.g. 3/4 or 0.75"
                    placeholderTextColor={tc.textMuted}
                    keyboardType="decimal-pad"
                  />
                </View>
                <View style={{ flex: 2 }}>
                  <Text style={styles.photoServingsLabel}>Context (optional)</Text>
                  <TextInput
                    style={styles.photoServingsInput}
                    value={photoMealContext}
                    onChangeText={setPhotoMealContext}
                    placeholder="e.g. batch of 4, I eat 3 servings"
                    placeholderTextColor={tc.textMuted}
                  />
                </View>
              </View>

              <View style={styles.photoMacroGrid}>
                <View style={styles.photoMacroTile}>
                  <Text style={styles.photoMacroValue}>{Math.round(photoMealDraft?.calories ?? 0)}</Text>
                  <Text style={styles.photoMacroLabel}>Calories</Text>
                </View>
                <View style={styles.photoMacroTile}>
                  <Text style={styles.photoMacroValue}>{Math.round(photoMealDraft?.protein ?? 0)}g</Text>
                  <Text style={styles.photoMacroLabel}>Protein</Text>
                </View>
                <View style={styles.photoMacroTile}>
                  <Text style={styles.photoMacroValue}>{Math.round(photoMealDraft?.carbs ?? 0)}g</Text>
                  <Text style={styles.photoMacroLabel}>Carbs</Text>
                </View>
                <View style={styles.photoMacroTile}>
                  <Text style={styles.photoMacroValue}>{Math.round(photoMealDraft?.fat ?? 0)}g</Text>
                  <Text style={styles.photoMacroLabel}>Fat</Text>
                </View>
              </View>

              <View style={styles.photoAssessmentActions}>
                <TouchableOpacity style={styles.photoAssessmentSecondaryBtn} onPress={() => setPhotoMealDraft(null)}>
                  <Text style={styles.photoAssessmentSecondaryText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.photoAssessmentPrimaryBtn} onPress={confirmPhotoMeal}>
                  <Text style={styles.photoAssessmentPrimaryText}>Save Meal</Text>
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>
      <BarcodeScannerModal
        visible={barcodeScanVisible}
        onClose={() => setBarcodeScanVisible(false)}
        onScan={handleBarcodeScan}
      />
      <FormVideoModal
        visible={!!videoExerciseName}
        exerciseName={videoExerciseName ?? ''}
        authToken={authToken}
        themeName={profile?.themePreference}
        onClose={() => setVideoExerciseName(null)}
      />
    </View>
  );
}

function createStyles(colors: ReturnType<typeof getTheme>['colors']) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 56, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  title:      { fontSize: 17, fontWeight: '800', color: colors.textPrimary, letterSpacing: -0.3 },
  cancelText: { fontSize: 14, color: colors.textSecondary, fontWeight: '500' },
  saveText:   { fontSize: 14, fontWeight: '700', color: colors.primary },

  // Bottom padding clears the fixed 5-tab bottom nav bar (~57 px + safe
  // area). Without this, the Save/Update button at the end of the form
  // sits under the tab bar and can't be scrolled into view.
  content:      { padding: 16, paddingBottom: 24 },
  stickyBottom: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 28, backgroundColor: colors.background, borderTopWidth: 1, borderTopColor: colors.border },
  stickyBottomInline: { paddingTop: 6, paddingBottom: 4, borderTopWidth: 0 },
  saveBtnInline: { paddingVertical: 11 },
  tabBar:       { flexDirection: 'row', marginBottom: 20, borderRadius: radius.lg, backgroundColor: colors.surface, padding: 3, gap: 2, borderWidth: 1, borderColor: colors.border },
  tab:          { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: radius.lg - 3 },
  tabActive:    { backgroundColor: colors.primary },
  tabText:      { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  tabTextActive:{ fontSize: 12, fontWeight: '700', color: '#fff' },
  section:         { marginBottom: 24 },
  sectionTopRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  sectionLabel:    { fontSize: 11, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.9, marginBottom: 6 },
  sectionAddBtn:   { backgroundColor: colors.primary + '15', borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: colors.primary + '30' },
  sectionAddBtnText: { fontSize: 12, fontWeight: '700', color: colors.primary },
  sectionHint:     { fontSize: 12, color: colors.textMuted, marginBottom: 10, lineHeight: 17 },
  mealRoutineInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 12,
    fontSize: 14,
    backgroundColor: colors.background,
    color: colors.textPrimary,
    minHeight: 100,
    textAlignVertical: 'top',
  },

  // Injury styles
  injuryEmptyCard: { borderRadius: radius.md, borderWidth: 1, padding: 14, alignItems: 'center', marginBottom: 10 },
  injuryEmptyText: { fontSize: 13 },
  injuryList: { gap: 10, marginBottom: 10 },
  injuryCard: { borderRadius: radius.md, borderWidth: 1, padding: 12, gap: 8 },
  injuryCardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  injuryDesc: { fontSize: 14, fontWeight: '600' },
  injuryBodyPart: { fontSize: 12, marginTop: 2 },
  statusRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  statusBtn: { borderRadius: radius.full, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5 },
  statusBtnText: { fontSize: 11, fontWeight: '700' },
  addInjuryBtn: { borderRadius: radius.md, borderWidth: 1, paddingVertical: 12, alignItems: 'center', borderStyle: 'dashed' as any },
  addInjuryBtnText: { fontSize: 14, fontWeight: '600' },
  // Modal styles (reused for add injury)
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalSheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderTopWidth: 1, padding: 20, paddingBottom: 40 },
  modalTitle: { fontSize: 17, fontWeight: '700', marginBottom: 6 },
  modalFieldLabel: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  modalInput: { borderWidth: 1, borderRadius: radius.md, padding: 12, fontSize: 15 },
  modalConfirmBtn: { borderRadius: radius.md, paddingVertical: 14, alignItems: 'center' },
  modalConfirmText: { fontSize: 15, fontWeight: '700' },

  goalGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  goalCard: { width: '47%', backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1.5, borderColor: colors.border, paddingVertical: 16, paddingHorizontal: 10, alignItems: 'center', gap: 6 },
  goalCardActive: { borderColor: colors.primary, backgroundColor: colors.primary + '0D' },
  goalIcon:       { fontSize: 24, marginBottom: 2 },
  goalLabel:      { fontSize: 13, color: colors.textSecondary, textAlign: 'center', fontWeight: '600' },

  paceList: { gap: 8 },
  paceCard: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1.5, borderColor: colors.border, padding: 14, gap: 4 },
  paceCardActive: { borderColor: colors.primary, backgroundColor: colors.primary + '0D' },
  paceTop:        { flexDirection: 'row', alignItems: 'center', gap: 10 },
  paceIcon:       { fontSize: 20 },
  paceLabel:      { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  paceLabelActive:{ color: colors.primary },
  paceRate:       { fontSize: 11, color: colors.textMuted },
  paceDesc:       { fontSize: 12, color: colors.textSecondary, marginLeft: 30 },

  weightBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.surface, borderRadius: radius.md, padding: 14, borderWidth: 1, borderColor: colors.border },
  weightValue:       { fontSize: 16, fontWeight: '600', color: colors.textPrimary },
  weightPlaceholder: { fontSize: 15, color: colors.textMuted },
  editHint:          { fontSize: 13, color: colors.primary, fontWeight: '600' },
  textField: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 14, fontSize: 15, backgroundColor: colors.surface, color: colors.textPrimary,
  },

  daysRow:         { flexDirection: 'row', alignItems: 'center', gap: 20 },
  daysBtn:         { width: 44, height: 44, borderRadius: radius.full, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  daysBtnDisabled: { opacity: 0.3 },
  daysBtnText:     { fontSize: 22, color: colors.textPrimary, fontWeight: '300' },
  daysValue:       { fontSize: 32, fontWeight: '700', color: colors.primary, minWidth: 40, textAlign: 'center' },

  durationRow:        { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  durationBtn:        { paddingVertical: 10, paddingHorizontal: 14, borderRadius: radius.lg, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface, alignItems: 'center' },
  durationBtnActive:  { borderColor: colors.primary, backgroundColor: colors.primary + '0D' },
  durationLabel:      { fontSize: 13, fontWeight: '700', color: colors.textPrimary },
  durationLabelActive:{ color: colors.primary },
  durationDesc:       { fontSize: 10, color: colors.textMuted, marginTop: 2 },
  durationDescActive: { color: colors.primaryLight },

  themeList: { gap: 10 },
  themeCard: {
    borderWidth: 1.5,
    borderRadius: radius.md,
    padding: 14,
    gap: 10,
  },
  themeCardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  themeName: { fontSize: 15, fontWeight: '700' },
  themeDesc: { fontSize: 12, lineHeight: 17, marginTop: 2 },
  themeSelectedBadge: { borderWidth: 1, borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'center' },
  themeSelectedText: { fontSize: 11, fontWeight: '700' },
  themeSwatches: { flexDirection: 'row', gap: 8 },
  themeSwatch: { width: 28, height: 28, borderRadius: radius.full, borderWidth: 1 },
  themePreview: {
    marginTop: 12,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 12,
    gap: 10,
  },
  themePreviewTitle: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.7 },
  themePreviewRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  themePreviewPill: {
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  themePreviewPillText: { fontSize: 12, fontWeight: '700' },

  chipGroup:      { marginBottom: 16 },
  splitCard: {
    borderWidth: 1.5,
    borderRadius: radius.md,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  chipGroupLabel: { fontSize: 12, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 },
  searchInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    fontSize: 16,
    marginBottom: 10,
  },
  filterRow: { gap: 8, paddingBottom: 12 },
  filterChip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  filterChipActive: { borderColor: colors.primary, backgroundColor: colors.primary + '12' },
  filterChipText: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },
  filterChipTextActive: { color: colors.primary },
  emptySearchText: {
    fontSize: 13,
    color: colors.textMuted,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 12,
    marginBottom: 12,
  },
  chips:          { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip:           { paddingVertical: 8, paddingHorizontal: 13, borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface },
  chipActive:     { borderColor: colors.primary, backgroundColor: colors.primary + '12' },
  chipText:       { fontSize: 13, color: colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: colors.primary, fontWeight: '700' },

  addTriggerBtn:  { alignSelf: 'flex-start', marginTop: 4, paddingVertical: 8, paddingHorizontal: 14, borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface },
  addTriggerText: { fontSize: 13, color: colors.primary, fontWeight: '600' },
  photoActionsRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 6 },
  photoMealCard: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    gap: 6,
  },
  photoMealCardTitle: { fontSize: 12, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6 },
  photoMealItems: { fontSize: 13, color: colors.textPrimary },
  photoMealMacros: { fontSize: 12, color: colors.textSecondary },
  centeredBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', justifyContent: 'center', padding: 20 },
  photoAssessmentModal: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 20,
    gap: 14,
  },
  photoAssessmentHeader: { gap: 4 },
  photoAssessmentEyebrow: { fontSize: 11, fontWeight: '700', color: colors.primary, textTransform: 'uppercase', letterSpacing: 1 },
  photoAssessmentTitle: { fontSize: 20, fontWeight: '700', color: colors.textPrimary },
  photoAssessmentSubtitle: { fontSize: 13, color: colors.textSecondary, lineHeight: 18 },
  photoAssessmentInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    backgroundColor: colors.background,
    color: colors.textPrimary,
  },
  photoServingsRow:  { flexDirection: 'row', marginTop: 12, marginBottom: 4 },
  photoServingsLabel: { fontSize: 11, fontWeight: '600', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 },
  photoServingsInput: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, backgroundColor: colors.background, color: colors.textPrimary },
  photoMacroGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  photoMacroTile: {
    width: '47%',
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 12,
    paddingHorizontal: 10,
  },
  photoMacroValue: { fontSize: 18, fontWeight: '700', color: colors.textPrimary },
  photoMacroLabel: { fontSize: 11, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 4 },
  photoAssessmentActions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  photoAssessmentSecondaryBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: colors.surfaceRaised,
  },
  photoAssessmentSecondaryText: { fontSize: 14, fontWeight: '700', color: colors.textSecondary },
  photoAssessmentPrimaryBtn: {
    flex: 1,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
  },
  photoAssessmentPrimaryText: { fontSize: 14, fontWeight: '700', color: colors.background },
  savedMealsList: { gap: 8, marginTop: 6 },
  savedMealCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
  },
  savedMealName: { fontSize: 13, fontWeight: '700', color: colors.textPrimary, marginBottom: 3 },
  savedMealMeta: { fontSize: 12, color: colors.textSecondary },
  savedMealDelete: { fontSize: 12, color: colors.error, fontWeight: '700' },

  scannedFoodRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    gap: 10,
  },
  scannedFoodRowSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primary + '12',
  },
  scannedFoodName: { fontSize: 14, fontWeight: '700', color: colors.textPrimary, marginBottom: 2 },
  scannedFoodServing: { fontSize: 12, color: colors.textSecondary, marginBottom: 2 },
  scannedFoodMacros: { fontSize: 12, color: colors.textMuted },
  scannedFoodCheck: { fontSize: 20, color: colors.textMuted, width: 24, textAlign: 'center' },
  scannedFoodCheckSelected: { color: colors.primary },

  saveBtn:     { backgroundColor: colors.primary, borderRadius: radius.lg, paddingVertical: 16, alignItems: 'center', shadowColor: colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 8, elevation: 4 },
  saveBtnText: { fontSize: 16, fontWeight: '800', color: '#FFFFFF', letterSpacing: 0.2 },

  // Toggle switch
  toggleTrack: { width: 44, height: 26, borderRadius: 13, backgroundColor: colors.border, padding: 2, justifyContent: 'center' },
  toggleTrackActive: { backgroundColor: colors.primary },
  toggleThumb: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#FFFFFF' },
  toggleThumbActive: { alignSelf: 'flex-end' as const },
  // Macro field inputs
  macroFieldLabel: { fontSize: 11, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase' as const, letterSpacing: 0.5, marginBottom: 4 },
  macroFieldInput: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 11, fontSize: 16, fontWeight: '600' as const, color: colors.textPrimary, backgroundColor: colors.background, textAlign: 'center' as const },

  // Sub-tabs (exercises/muscles within workout tab)
  subTabBar: { flexDirection: 'row', gap: 0, marginBottom: 14, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' as const },
  subTab: { flex: 1, paddingVertical: 9, alignItems: 'center' as const, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  subTabActive: { borderBottomColor: colors.primary, backgroundColor: colors.surfaceRaised },
  subTabText: { fontSize: 13, fontWeight: '600' as const, color: colors.textMuted },
  subTabTextActive: { color: colors.primary, fontWeight: '700' as const },

  // Exercise list
  exerciseRow: {
    flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10,
    backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    padding: 12, marginBottom: 6,
  },
  exerciseRowName: { fontSize: 14, fontWeight: '700' as const, color: colors.textPrimary },
  exerciseTag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full },
  exerciseTagText: { fontSize: 10, fontWeight: '700' as const, textTransform: 'uppercase' as const, letterSpacing: 0.4 },
  exerciseDetail: {
    backgroundColor: colors.surfaceRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.primary + '40',
    padding: 16, marginTop: 10, gap: 6,
  },
  exerciseDetailName: { fontSize: 17, fontWeight: '800' as const, color: colors.textPrimary },
  exerciseDetailDesc: { fontSize: 13, color: colors.textSecondary, lineHeight: 19 },

  // Exercise guide detail
  guideSection: { gap: 4 },
  guideSectionTitle: { fontSize: 12, fontWeight: '700' as const, color: colors.textPrimary, textTransform: 'uppercase' as const, letterSpacing: 0.6 },
  guideSectionBody: { fontSize: 13, color: colors.textSecondary, lineHeight: 20 },
  phaseBlock: {
    backgroundColor: colors.surfaceRaised, borderRadius: radius.lg, borderWidth: 1,
    padding: 14, gap: 12,
  },
  phaseBlockTitle: { fontSize: 13, fontWeight: '800' as const, color: colors.textPrimary, marginBottom: 2 },
  phaseRow: { gap: 6 },
  phaseBadge: { alignSelf: 'flex-start' as const, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.full },
  phaseBadgeLabel: { fontSize: 10, fontWeight: '800' as const, letterSpacing: 0.8 },
  phaseText: { fontSize: 13, color: colors.textSecondary, lineHeight: 19 },
  phaseDivider: { height: 1, marginVertical: 2 },

  // Muscle cards
  muscleCard: {
    backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    padding: 12, marginBottom: 8, gap: 8,
  },
  muscleEmoji: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center' as const, justifyContent: 'center' as const },
  muscleCardName: { fontSize: 15, fontWeight: '700' as const, color: colors.textPrimary },
  muscleCardRegion: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  muscleCardDesc: { fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  muscleSection: { gap: 4 },
  muscleSectionTitle: { fontSize: 12, fontWeight: '700' as const, color: colors.primary, textTransform: 'uppercase' as const, letterSpacing: 0.6 },
  muscleSectionBody: { fontSize: 13, color: colors.textSecondary, lineHeight: 19 },
}); }
