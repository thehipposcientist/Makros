import { useState } from 'react';
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
  Keyboard,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { colors, radius } from '../constants/theme';
import {
  Goal, GoalPace, Gender, UserProfile, PhysicalStats, GoalDetails, GoalSelection,
} from '../types';
import { useMetaData, pacesForGoal } from '../hooks/useMetaData';
import { scanFoodsPhoto, scanEquipmentPhoto } from '../services/api';
import { isHealthKitAvailable, requestHealthPermissions } from '../services/appleHealth';
import { setAppleHealthEnabled as persistHealthEnabled } from '../utils/workoutHistory';
import {
  LAUNCH_GOALS, PRIMARY_GOALS, GOAL_CATEGORIES, GOAL_MODIFIERS,
  modifiersForGoal, targetFocusesForGoal, goalCategory,
  GoalCategoryId, PrimaryGoalDef, GoalModifierDef, TargetFocusDef,
} from '../constants/goalConfig';

const logo = require('../../assets/images/Fitness brand logo with apple symbol darkmode.png');

// ─── Step logic ───────────────────────────────────────────────────────────────

type StepKey = 'goal' | 'goalRefine' | 'physicalStats' | 'trainingDays' | 'equipment' | 'foods' | 'supplements' | 'mealRoutine' | 'appleHealth' | 'context';

function getSteps(): StepKey[] {
  const base: StepKey[] = ['goal', 'goalRefine', 'physicalStats', 'trainingDays', 'equipment', 'foods', 'supplements', 'mealRoutine'];
  // Only show Apple Health step on iOS
  if (Platform.OS === 'ios') base.push('appleHealth');
  base.push('context');
  return base;
}

// ─── Supplement categories ────────────────────────────────────────────────────

const SUPPLEMENT_CATEGORIES = [
  {
    key: 'protein',
    icon: '🥛',
    label: 'Protein',
    items: ['Whey Protein', 'Casein Protein', 'Plant Protein', 'Egg White Protein', 'Collagen Peptides'],
  },
  {
    key: 'performance',
    icon: '⚡',
    label: 'Performance',
    items: ['Creatine Monohydrate', 'Beta-Alanine', 'L-Citrulline', 'Pre-Workout', 'Caffeine', 'HMB'],
  },
  {
    key: 'recovery',
    icon: '💪',
    label: 'Recovery & Muscle',
    items: ['BCAA', 'EAA', 'L-Glutamine', 'Tart Cherry Extract', 'Electrolytes'],
  },
  {
    key: 'health',
    icon: '❤️',
    label: 'Health & Vitamins',
    items: ['Vitamin D', 'Omega-3 / Fish Oil', 'Zinc', 'Multivitamin', 'Vitamin C', 'Iron', 'B12'],
  },
  {
    key: 'weight',
    icon: '🔥',
    label: 'Weight Management',
    items: ['L-Carnitine', 'CLA', 'Green Tea Extract', 'Psyllium Fiber', 'Thermogenic'],
  },
  {
    key: 'sleep',
    icon: '😴',
    label: 'Sleep & Stress',
    items: ['Melatonin', 'Ashwagandha', 'ZMA', 'Magnesium Glycinate', 'L-Theanine'],
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
    description: 'Dumbbells + bands',
    items: ['Dumbbells', 'Resistance bands', 'Pull-up bar', 'Yoga mat', 'Jump rope', 'Foam roller'],
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
}

export default function OnboardingScreen({ authToken, onComplete }: OnboardingScreenProps) {
  const meta = useMetaData();

  // meta.goalConfig still available for legacy pace lookups

  // Step tracking
  const [currentStep, setCurrentStep] = useState(0);

  // Step 1 — Goal selection (hierarchical)
  const [selectedGoal, setSelectedGoal] = useState('build_muscle');
  const [showAllGoals, setShowAllGoals] = useState(false);
  const [expandedCategory, setExpandedCategory] = useState<GoalCategoryId | null>(null);

  // Step 2 — Goal refinement (modifiers + target focus + pace)
  const [selectedModifiers, setSelectedModifiers] = useState<string[]>([]);
  const [selectedTargetFocus, setSelectedTargetFocus] = useState('');
  const [pace, setPace] = useState<GoalPace>('moderate');
  const [targetWeight, setTargetWeight] = useState('');
  const [targetEvent, setTargetEvent] = useState('');

  // Step 3 — Physical stats
  const [weightLbs, setWeightLbs] = useState('');
  const [heightFeet, setHeightFeet] = useState('');
  const [heightInches, setHeightInches] = useState('');
  const [age, setAge] = useState('');
  const [gender, setGender] = useState<Gender | ''>('');

  // Step 4 — Training days
  const [daysPerWeek, setDaysPerWeek] = useState('3');
  const [workoutDuration, setWorkoutDuration] = useState(60);

  // Step 5 — Equipment
  const [selectedEquipment, setSelectedEquipment] = useState<string[]>([]);
  const [equipScanLoading, setEquipScanLoading] = useState(false);
  const [scannedEquipment, setScannedEquipment] = useState<string[]>([]);
  const [showEquipScanModal, setShowEquipScanModal] = useState(false);

  // Step 6 — Foods
  const [foodsAvailable, setFoodsAvailable] = useState<string[]>([]);
  const [foodScanLoading, setFoodScanLoading] = useState(false);
  const [scannedFoods, setScannedFoods] = useState<{ name: string; selected: boolean }[]>([]);
  const [customFoodInput, setCustomFoodInput] = useState('');

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

  const selectGoal = (goalId: string) => {
    if (goalId !== selectedGoal) {
      setSelectedGoal(goalId);
      setSelectedModifiers([]); // reset modifiers when goal changes
      setSelectedTargetFocus('');
    }
  };

  const toggleModifier = (modId: string) => {
    setSelectedModifiers(prev => {
      if (prev.includes(modId)) return prev.filter(m => m !== modId);
      if (prev.length >= 2) return [prev[0], modId]; // replace second
      return [...prev, modId];
    });
  };

  const toggleEquipment = (eq: string) => {
    setSelectedEquipment(prev =>
      prev.includes(eq) ? prev.filter(e => e !== eq) : [...prev, eq]
    );
  };

  const applyTemplate = (template: EquipmentTemplate) => {
    setSelectedEquipment(template.items);
  };

  const validate = (): string | null => {
    switch (currentStepKey) {
      case 'goalRefine':
        if (targetWeight) {
          const tw = parseFloat(targetWeight);
          if (isNaN(tw) || tw < 50 || tw > 500) return 'Enter a valid target weight (50–500 lbs)';
        }
        return null;
      case 'physicalStats': {
        const w = parseFloat(weightLbs);
        const hf = parseInt(heightFeet);
        const hi = parseInt(heightInches);
        const a = parseInt(age);
        if (isNaN(w) || w < 50 || w > 600) return 'Enter a valid weight (50–600 lbs)';
        if (isNaN(hf) || hf < 3 || hf > 8) return 'Enter a valid height';
        if (isNaN(hi) || hi < 0 || hi > 11) return 'Inches must be between 0–11';
        if (isNaN(a) || a < 13 || a > 100) return 'Enter a valid age (13–100)';
        if (!gender) return 'Please select a gender option';
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
    if (error) { Alert.alert('Hold on', error); return; }

    if (currentStep < totalSteps - 1) {
      setCurrentStep(s => s + 1);
    } else {
      handleComplete();
    }
  };

  const handleBack = () => {
    if (currentStep > 0) setCurrentStep(s => s - 1);
  };

  const handleComplete = () => {
    const cat = goalCategory(selectedGoal) ?? 'lifestyle_consistency';

    const goalSel: GoalSelection = {
      primaryGoal: selectedGoal,
      category: cat,
      modifiers: selectedModifiers,
      targetFocus: selectedTargetFocus || undefined,
    };

    const goalDetails: GoalDetails = {
      pace,
      targetWeightLbs: targetWeight ? parseFloat(targetWeight) : undefined,
      targetEvent: targetEvent.trim() || undefined,
    };

    const physicalStats: PhysicalStats = {
      weightLbs:    parseFloat(weightLbs),
      heightFeet:   parseInt(heightFeet),
      heightInches: parseInt(heightInches),
      age:          parseInt(age),
      gender:       gender as Gender,
    };

    onComplete({
      goal:               selectedGoal,
      goalSelection:      goalSel,
      goalDetails,
      physicalStats,
      daysPerWeek:            parseInt(daysPerWeek),
      workoutDurationMinutes: workoutDuration,
      equipment:              selectedEquipment,
      foodsAvailable,
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
    const goalsByCategory = (catId: GoalCategoryId) => PRIMARY_GOALS.filter(g => g.category === catId && !g.launch);

    return (
      <View style={styles.stepContainer}>
        <Text style={styles.stepTitle}>What's Your Goal?</Text>
        <Text style={styles.stepDescription}>Pick one primary goal for your plan.</Text>

        {/* Launch goals — the 8 most common */}
        <View style={styles.goalGrid}>
          {LAUNCH_GOALS.map(g => {
            const catDef = GOAL_CATEGORIES.find(c => c.id === g.category);
            const active = selectedGoal === g.id;
            return (
              <TouchableOpacity
                key={g.id}
                style={[styles.goalCard, active && styles.goalCardActive]}
                onPress={() => selectGoal(g.id)}
                activeOpacity={0.75}
              >
                <Text style={styles.goalIcon}>{catDef?.icon ?? '🎯'}</Text>
                <Text style={[styles.goalLabel, active && styles.goalLabelActive]}>{g.label}</Text>
                <Text style={[styles.goalDesc, active && styles.goalDescActive]}>{g.description}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Expand to see all goals by category */}
        <TouchableOpacity
          style={{
            marginTop: 16,
            alignItems: 'center',
            paddingVertical: 12,
            paddingHorizontal: 20,
            backgroundColor: colors.primary + '15',
            borderRadius: 12,
            borderWidth: 1.5,
            borderColor: colors.primary + '40',
            flexDirection: 'row',
            justifyContent: 'center',
            gap: 8,
          }}
          onPress={() => setShowAllGoals(prev => !prev)}
          activeOpacity={0.7}
        >
          <Text style={{ fontSize: 16 }}>{showAllGoals ? '▾' : '▸'}</Text>
          <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 15 }}>
            {showAllGoals ? 'Hide Advanced Goals' : 'Explore All Goals'}
          </Text>
        </TouchableOpacity>

        {showAllGoals && GOAL_CATEGORIES.map(cat => {
          const catGoals = goalsByCategory(cat.id);
          if (catGoals.length === 0) return null;
          const isExpanded = expandedCategory === cat.id;
          return (
            <View key={cat.id} style={{ marginTop: 8 }}>
              <TouchableOpacity
                onPress={() => setExpandedCategory(isExpanded ? null : cat.id)}
                style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8 }}
              >
                <Text style={{ fontSize: 16, marginRight: 8 }}>{cat.icon}</Text>
                <Text style={{ fontSize: 14, fontWeight: '600', color: colors.textPrimary, flex: 1 }}>{cat.label}</Text>
                <Text style={{ fontSize: 12, color: colors.textMuted }}>{isExpanded ? '▲' : '▼'}</Text>
              </TouchableOpacity>
              {isExpanded && (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingLeft: 4, marginBottom: 8 }}>
                  {catGoals.map(g => {
                    const active = selectedGoal === g.id;
                    return (
                      <TouchableOpacity
                        key={g.id}
                        style={[styles.foodChip, active && styles.foodChipActive]}
                        onPress={() => selectGoal(g.id)}>
                        <Text style={[styles.foodChipText, active && styles.foodChipTextActive]}>{g.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
            </View>
          );
        })}

        {selectedDef && (
          <View style={{ marginTop: 16, backgroundColor: colors.surface, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: colors.primary + '44' }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: colors.primary }}>{selectedDef.label}</Text>
            <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>{selectedDef.description}</Text>
          </View>
        )}
      </View>
    );
  };

  const renderGoalRefineStep = () => {
    const goalDef = PRIMARY_GOALS.find(g => g.id === selectedGoal);
    const goalLabel = goalDef?.label ?? selectedGoal;
    const cat = goalCategory(selectedGoal);
    const availableModifiers = modifiersForGoal(selectedGoal);
    const availableFocuses = targetFocusesForGoal(selectedGoal);
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
          Customise how you approach {goalLabel.toLowerCase()}.
        </Text>

        {/* Modifiers — up to 2 */}
        {availableModifiers.length > 0 && (
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>
              Modifiers <Text style={styles.optional}>(pick up to 2)</Text>
            </Text>
            <View style={styles.foodChips}>
              {availableModifiers.map(mod => {
                const active = selectedModifiers.includes(mod.id);
                return (
                  <TouchableOpacity
                    key={mod.id}
                    style={[styles.foodChip, active && styles.foodChipActive]}
                    onPress={() => toggleModifier(mod.id)}>
                    <Text style={[styles.foodChipText, active && styles.foodChipTextActive]}>{mod.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={styles.hint}>These refine how your plan is generated — not required.</Text>
          </View>
        )}

        {/* Target focus */}
        {availableFocuses.length > 0 && (
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>
              Target focus <Text style={styles.optional}>(optional)</Text>
            </Text>
            <View style={styles.foodChips}>
              {availableFocuses.map(tf => {
                const active = selectedTargetFocus === tf.id;
                return (
                  <TouchableOpacity
                    key={tf.id}
                    style={[styles.foodChip, active && styles.foodChipActive]}
                    onPress={() => setSelectedTargetFocus(prev => prev === tf.id ? '' : tf.id)}>
                    <Text style={[styles.foodChipText, active && styles.foodChipTextActive]}>{tf.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={styles.hint}>AI will emphasise this area in your plan.</Text>
          </View>
        )}

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
      <Text style={styles.stepDescription}>Used to calculate your personalised calorie and macro targets</Text>

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
        <Text style={styles.fieldLabel}>Age</Text>
        <View style={styles.inlineInput}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            placeholder="e.g. 27"
            placeholderTextColor={colors.textMuted}
            keyboardType="number-pad"
            value={age}
            onChangeText={setAge}
            maxLength={3}
          />
          <Text style={styles.unit}>yrs</Text>
        </View>
      </View>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Gender</Text>
        <View style={styles.genderRow}>
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
    { value: 30,  label: '30 min', desc: 'Express' },
    { value: 45,  label: '45 min', desc: 'Standard' },
    { value: 60,  label: '60 min', desc: 'Full' },
    { value: 75,  label: '75 min', desc: 'Extended' },
    { value: 90,  label: '90 min', desc: 'Deep' },
  ];

  const renderTrainingDaysStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>Training Schedule</Text>
      <Text style={styles.stepDescription}>How many days per week can you commit?</Text>
      <View style={styles.inlineInput}>
        <TextInput
          style={[styles.input, { flex: 1 }]}
          placeholder="3"
          placeholderTextColor={colors.textMuted}
          keyboardType="number-pad"
          value={daysPerWeek}
          onChangeText={setDaysPerWeek}
          maxLength={1}
        />
        <Text style={styles.unit}>days/week</Text>
      </View>
      <Text style={styles.hint}>Recommended: 3–4 days for optimal recovery</Text>

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
    </View>
  );

  const renderEquipmentStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>Available Equipment</Text>
      <Text style={styles.stepDescription}>
        Select everything you have access to
        {selectedEquipment.length > 0 ? `  ·  ${selectedEquipment.length} selected` : ''}
      </Text>

      {/* Quick-start templates */}
      <Text style={styles.sectionHeading}>Quick select by gym type</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.templateScroll} contentContainerStyle={styles.templateScrollContent}>
        {EQUIPMENT_TEMPLATES.map(t => (
          <TouchableOpacity
            key={t.id}
            style={styles.templateChip}
            onPress={() => applyTemplate(t)}
            activeOpacity={0.75}>
            <Text style={styles.templateChipLabel}>{t.label}</Text>
            <Text style={styles.templateChipDesc}>{t.description}</Text>
          </TouchableOpacity>
        ))}
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
      {meta.loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />
      ) : (
        meta.equipmentCategories.map(category => (
          <View key={category.label} style={styles.foodCategory}>
            <Text style={styles.foodCategoryLabel}>{category.icon}  {category.label}</Text>
            <View style={styles.foodChips}>
              {category.items.map(item => {
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
        ))
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
                    <Text style={styles.scannedCheckMark}>✓</Text>
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
      <Text style={styles.stepTitle}>What's in your kitchen?</Text>
      <Text style={styles.stepDescription}>
        Select foods you have available — your meal plan will be built around these
        {foodsAvailable.length > 0 ? `  ·  ${foodsAvailable.length} selected` : ''}
      </Text>

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

      {/* Manual selection */}
      <Text style={styles.sectionHeading}>Or pick manually</Text>
      {meta.loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />
      ) : (
        meta.foodCategories.map(category => (
          <View key={category.key} style={styles.foodCategory}>
            <Text style={styles.foodCategoryLabel}>{category.icon}  {category.label}</Text>
            <View style={styles.foodChips}>
              {category.foods.map(food => {
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
        ))
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
              <Text style={[styles.foodChipText, styles.foodChipTextActive]}>{f} ✕</Text>
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
                    {f.selected && <Text style={styles.scannedCheckMark}>✓</Text>}
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
      <Text style={styles.stepTitle}>What supplements do you take?</Text>
      <Text style={styles.stepDescription}>
        Select what you already have or use — your AI trainer will factor these into your supplement recommendations
        {supplementsAvailable.length > 0 ? `  ·  ${supplementsAvailable.length} selected` : ''}
      </Text>

      {SUPPLEMENT_CATEGORIES.map(category => (
        <View key={category.key} style={styles.foodCategory}>
          <Text style={styles.foodCategoryLabel}>{category.icon}  {category.label}</Text>
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

      <Text style={styles.hint}>Skip if you don't take any — the AI will recommend what's best for your goal</Text>
    </View>
  );

  const renderMealRoutineStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>Your Meal Routine</Text>
      <Text style={styles.stepDescription}>
        Do you already follow a regular meal routine? Describe it so your AI nutritionist can plan around it.
      </Text>
      <TextInput
        style={[styles.input, { height: 120, textAlignVertical: 'top', paddingTop: 12 }]}
        placeholder={'Example: I have a protein shake every morning. I meal prep chicken and rice for lunch on weekdays. I do the same dinner routine each night.'}
        placeholderTextColor={colors.textMuted}
        value={mealRoutine}
        onChangeText={setMealRoutine}
        multiline
        numberOfLines={5}
      />
      <Text style={styles.hint}>
        You can also update this anytime by chatting with your AI Nutritionist in the app.
      </Text>
      <Text style={styles.hint}>Leave blank if you have no fixed routine — the AI will plan everything for you.</Text>
    </View>
  );

  const EXPERIENCE_OPTIONS: { value: 'beginner' | 'intermediate' | 'advanced'; label: string; desc: string }[] = [
    { value: 'beginner',     label: 'Beginner',     desc: 'New to structured training or returning after a long break' },
    { value: 'intermediate', label: 'Intermediate',  desc: 'Training consistently for 6+ months' },
    { value: 'advanced',     label: 'Advanced',      desc: 'Training seriously for 2+ years with solid technique' },
  ];

  const renderContextStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>A Little More About You</Text>
      <Text style={styles.stepDescription}>
        This helps your AI trainer personalise your first workout and avoid anything that could hurt you.
      </Text>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Experience level</Text>
        <View style={styles.paceCards}>
          {EXPERIENCE_OPTIONS.map(opt => (
            <TouchableOpacity
              key={opt.value}
              style={[styles.paceCard, experienceLevel === opt.value && styles.paceCardActive]}
              onPress={() => setExperienceLevel(opt.value)}>
              <Text style={[styles.paceLabel, experienceLevel === opt.value && styles.paceLabelActive]}>{opt.label}</Text>
              <Text style={[styles.paceDesc,  experienceLevel === opt.value && styles.paceDescActive]}>{opt.desc}</Text>
            </TouchableOpacity>
          ))}
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
        />
        <Text style={styles.hint}>Helps the AI pick the right starting weights and avoid training the same muscles back-to-back.</Text>
      </View>
    </View>
  );

  const renderAppleHealthStep = () => (
    <View>
      <Text style={styles.stepTitle}>Do you use an Apple Watch?</Text>
      <Text style={styles.hint}>Connect Apple Health to get recovery insights, a health-enhanced fitness score, and readiness tracking based on your heart rate, sleep, and activity data.</Text>

      <View style={{ gap: 12, marginTop: 16 }}>
        <TouchableOpacity
          style={[styles.chipWide, appleHealthEnabled && styles.chipWideSelected]}
          onPress={async () => {
            if (!isHealthKitAvailable()) {
              Alert.alert('Not Available', 'Apple Health is not available on this device.');
              return;
            }
            const granted = await requestHealthPermissions();
            if (granted) {
              setAppleHealthEnabled(true);
              await persistHealthEnabled(true);
            } else {
              Alert.alert('Permission Needed', 'Please enable Health access in Settings > Privacy > Health > Makros.');
            }
          }}>
          <Text style={styles.chipIcon}>⌚</Text>
          <View style={{ flex: 1 }}>
            <Text style={[styles.chipWideLabel, appleHealthEnabled && styles.chipWideLabelSelected]}>Yes, connect Apple Health</Text>
            <Text style={styles.chipWideDesc}>Reads heart rate, steps, sleep, and workouts</Text>
          </View>
          {appleHealthEnabled && <Text style={{ fontSize: 18 }}>✓</Text>}
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
            <Text style={styles.chipWideDesc}>You can enable this later in Account settings</Text>
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
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" onScrollBeginDrag={Keyboard.dismiss}>
        <View style={styles.header}>
          <Image source={logo} style={styles.logo} resizeMode="contain" />
          <Text style={styles.stepCounter}>Step {currentStep + 1} of {totalSteps}</Text>
        </View>

        <View style={styles.progressBar}>
          {Array.from({ length: totalSteps }).map((_, i) => (
            <View key={i} style={[styles.progressSegment, i <= currentStep && styles.progressSegmentActive]} />
          ))}
        </View>

        {renderStep()}

        <View style={styles.buttons}>
          <TouchableOpacity
            style={[styles.backButton, currentStep === 0 && styles.buttonDisabled]}
            onPress={handleBack}
            disabled={currentStep === 0}
          >
            <Text style={styles.backButtonText}>Back</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.nextButton, currentStep === totalSteps - 1 && styles.nextButtonFinal]}
            onPress={handleNext}>
            <Text style={[styles.nextButtonText, currentStep === totalSteps - 1 && styles.nextButtonTextFinal]}>
              {currentStep === totalSteps - 1 ? 'Get Started' : 'Next'}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 24, paddingBottom: 48 },
  header: { marginTop: 20, marginBottom: 20 },
  logo: { width: 260, height: 88 },
  stepCounter: { fontSize: 13, color: colors.textSecondary, marginTop: 8 },

  progressBar: { flexDirection: 'row', gap: 6, marginBottom: 32 },
  progressSegment: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.border },
  progressSegmentActive: { backgroundColor: colors.primary },

  stepContainer: { marginBottom: 24 },
  stepTitle: { fontSize: 26, fontWeight: '700', color: colors.textPrimary, marginBottom: 8 },
  stepDescription: { fontSize: 15, color: colors.textSecondary, lineHeight: 22, marginBottom: 24 },

  goalGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  goalCard: { width: '48%', padding: 14, borderRadius: radius.lg, borderWidth: 2, borderColor: colors.border, backgroundColor: colors.surface },
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
    backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: 1.5, borderColor: colors.border,
    paddingVertical: 10, paddingHorizontal: 14, minWidth: 110,
  },
  templateChipLabel: { fontSize: 13, fontWeight: '700', color: colors.textPrimary, marginBottom: 2 },
  templateChipDesc: { fontSize: 11, color: colors.textMuted },

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
  backButton: { flex: 1, paddingVertical: 16, borderRadius: radius.md, backgroundColor: colors.surface, alignItems: 'center', borderWidth: 1, borderColor: colors.border },
  buttonDisabled: { opacity: 0.4 },
  backButtonText: { fontSize: 16, fontWeight: '600', color: colors.textSecondary },
  nextButton: { flex: 1, paddingVertical: 16, borderRadius: radius.md, backgroundColor: colors.primary, alignItems: 'center' },
  nextButtonFinal: { flex: 2, paddingVertical: 18, shadowColor: colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 8, elevation: 5 },
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
