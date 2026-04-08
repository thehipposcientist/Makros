import { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  TextInput, Modal, KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { UserProfile, CustomFoodItem, Goal, GoalPace, SavedMealTemplate, AppThemeName } from '../types';
import { useMetaData, pacesForGoal } from '../hooks/useMetaData';
import { APP_THEMES, colors, getTheme, radius } from '../constants/theme';
import { analyzeFoodPhoto, scanFoodsPhoto } from '../services/api';

interface EditProfileScreenProps {
  authToken: string;
  profile: UserProfile;
  onSave: (updated: UserProfile) => void;
  onCancel: () => void;
  mode?: 'plan' | 'equipment' | 'foods' | 'theme';
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

const DURATION_OPTIONS = [
  { value: 30, label: '30 min', desc: 'Express' },
  { value: 45, label: '45 min', desc: 'Standard' },
  { value: 60, label: '60 min', desc: 'Full' },
  { value: 75, label: '75 min', desc: 'Extended' },
  { value: 90, label: '90 min', desc: 'Deep' },
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
}

function InputModal({
  visible, title, subtitle, placeholder, value, onChange, onConfirm, onClose,
  confirmLabel = 'Confirm', error, keyboardType = 'default',
}: InputModalProps) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <TouchableOpacity style={im.backdrop} activeOpacity={1} onPress={onClose}>
          <View style={im.sheet}>
            <View style={im.handle} />
            <Text style={im.title}>{title}</Text>
            {subtitle ? <Text style={im.subtitle}>{subtitle}</Text> : null}
            <TextInput
              style={im.input}
              value={value}
              onChangeText={onChange}
              placeholder={placeholder}
              placeholderTextColor={colors.textMuted}
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

const im = StyleSheet.create({
  backdrop:    { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet:       { backgroundColor: colors.surface, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: 24, paddingBottom: 40, gap: 14, borderTopWidth: 1, borderTopColor: colors.border },
  handle:      { width: 36, height: 4, backgroundColor: colors.border, borderRadius: 2, alignSelf: 'center', marginBottom: 4 },
  title:       { fontSize: 18, fontWeight: '700', color: colors.textPrimary },
  subtitle:    { fontSize: 13, color: colors.textSecondary, marginTop: -6 },
  input:       { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 14, fontSize: 16, backgroundColor: colors.background, color: colors.textPrimary },
  error:       { fontSize: 13, color: colors.error },
  confirmBtn:  { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center' },
  confirmText: { color: colors.background, fontSize: 16, fontWeight: '700' },
});

// ── Add Food modal (manual macro entry) ───────────────────────────────────────

interface AddFoodModalProps {
  visible: boolean;
  onAdd: (item: CustomFoodItem) => void;
  onClose: () => void;
}

function AddFoodModal({ visible, onAdd, onClose }: AddFoodModalProps) {
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
        <TouchableOpacity style={im.backdrop} activeOpacity={1} onPress={handleClose}>
          <View style={im.sheet}>
            <View style={im.handle} />
            <Text style={im.title}>Add Food</Text>
            <Text style={im.subtitle}>Enter the food name and its macros per serving</Text>

            <TextInput style={im.input} value={name} onChangeText={v => { setName(v); setError(''); }}
              placeholder="Food name (e.g. Greek yogurt)" placeholderTextColor={colors.textMuted} autoFocus returnKeyType="next" />
            <TextInput style={im.input} value={unit} onChangeText={setUnit}
              placeholder="Serving size (e.g. 170g, 1 cup) — optional" placeholderTextColor={colors.textMuted} returnKeyType="next" />

            <View style={afm.macroRow}>
              <View style={afm.macroField}>
                <Text style={afm.macroLabel}>Calories</Text>
                <TextInput style={afm.macroInput} value={calories} onChangeText={setCalories} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={colors.textMuted} returnKeyType="next" />
              </View>
              <View style={afm.macroField}>
                <Text style={afm.macroLabel}>Protein (g)</Text>
                <TextInput style={afm.macroInput} value={protein} onChangeText={setProtein} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={colors.textMuted} returnKeyType="next" />
              </View>
            </View>
            <View style={afm.macroRow}>
              <View style={afm.macroField}>
                <Text style={afm.macroLabel}>Carbs (g)</Text>
                <TextInput style={afm.macroInput} value={carbs} onChangeText={setCarbs} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={colors.textMuted} returnKeyType="next" />
              </View>
              <View style={afm.macroField}>
                <Text style={afm.macroLabel}>Fat (g)</Text>
                <TextInput style={afm.macroInput} value={fat} onChangeText={setFat} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={colors.textMuted} returnKeyType="done" onSubmitEditing={handleAdd} />
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

const afm = StyleSheet.create({
  macroRow:   { flexDirection: 'row', gap: 10 },
  macroField: { flex: 1, gap: 6 },
  macroLabel: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  macroInput: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12, fontSize: 16, fontWeight: '600', color: colors.textPrimary, backgroundColor: colors.background, textAlign: 'center' },
});

// ─────────────────────────────────────────────────────────────────────────────

export default function EditProfileScreen({ authToken, profile, onSave, onCancel, mode = 'plan' }: EditProfileScreenProps) {
  const meta = useMetaData();

  const weightGoals   = new Set(meta.goalConfig.weight_goals);
  const timelineGoals = new Set(meta.goalConfig.timeline_goals);

  // Goal
  const [goal, setGoal]   = useState<Goal>(profile.goal);
  const [pace, setPace]   = useState<GoalPace>(profile.goalDetails.pace);
  const [targetWeight, setTargetWeight] = useState<string>(
    profile.goalDetails.targetWeightLbs ? String(profile.goalDetails.targetWeightLbs) : ''
  );
  const [targetEvent, setTargetEvent] = useState<string>(
    profile.goalDetails.targetEvent ?? ''
  );
  const [themePreference, setThemePreference] = useState<AppThemeName>(profile.themePreference ?? 'midnight');

  // Physical stats
  const [currentWeight, setCurrentWeight] = useState<string>(
    profile.physicalStats.weightLbs ? String(profile.physicalStats.weightLbs) : ''
  );
  const [currentWeightModalVisible, setCurrentWeightModalVisible] = useState(false);
  const [currentWeightInput, setCurrentWeightInput]               = useState('');

  // Workout prefs
  const [daysPerWeek, setDaysPerWeek] = useState(profile.daysPerWeek);
  const [duration, setDuration]       = useState(profile.workoutDurationMinutes ?? 60);
  const [equipment, setEquipment]     = useState<string[]>(profile.equipment as string[]);
  const [foods, setFoods]             = useState<string[]>(profile.foodsAvailable);
  const [customFoods, setCustomFoods] = useState<CustomFoodItem[]>(profile.customFoods ?? []);
  const [savedMeals, setSavedMeals]   = useState<SavedMealTemplate[]>(profile.savedMeals ?? []);
  const [mealRoutine, setMealRoutine] = useState(profile.mealRoutine ?? '');
  const [foodSearch, setFoodSearch]   = useState('');
  const [foodCategoryFilter, setFoodCategoryFilter] = useState<string>('all');

  // Modals
  const [addFoodVisible,    setAddFoodVisible]    = useState(false);
  const [photoMealLoading,  setPhotoMealLoading]  = useState(false);
  const [photoMealDraft,    setPhotoMealDraft]    = useState<PhotoMealDraft | null>(null);
  const [scanFoodsLoading,  setScanFoodsLoading]  = useState(false);
  const [scannedFoods,      setScannedFoods]      = useState<ScannedFoodItem[] | null>(null);
  const [equipModalVisible, setEquipModalVisible] = useState(false);
  const [newEquipName,      setNewEquipName]      = useState('');
  const [equipError,        setEquipError]        = useState('');
  const [weightModalVisible, setWeightModalVisible] = useState(false);
  const [weightInput,        setWeightInput]        = useState(targetWeight);

  const toggleEquipment = (name: string) =>
    setEquipment(prev => prev.includes(name) ? prev.filter(e => e !== name) : [...prev, name]);

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
      const analysis = await analyzeFoodPhoto(authToken, {
        image_base64: imageBase64,
        mime_type: asset.mimeType ?? 'image/jpeg',
      });
      setPhotoMealDraft(analysis);
    } catch (e: any) {
      Alert.alert('Analysis failed', e?.message ?? 'Could not analyze this food photo.');
    } finally {
      setPhotoMealLoading(false);
    }
  };

  const handleScanFoods = async (source: 'camera' | 'library') => {
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
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.7, base64: true, mediaTypes: ['images'] as any });

    if (result.canceled || !result.assets?.[0]?.base64) return;

    setScanFoodsLoading(true);
    try {
      const asset = result.assets[0];
      const imageBase64 = asset.base64;
      if (!imageBase64) return;
      const response = await scanFoodsPhoto(authToken, {
        image_base64: imageBase64,
        mime_type: asset.mimeType ?? 'image/jpeg',
      });
      setScannedFoods((response.foods ?? []).map(f => ({ ...f, selected: true })));
    } catch (e: any) {
      Alert.alert('Scan failed', e?.message ?? 'Could not identify foods from this photo.');
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

  const confirmPhotoMeal = () => {
    if (!photoMealDraft) return;
    setSavedMeals(prev => [
      {
        id: `${Date.now()}`,
        name: photoMealDraft.meal_name.trim() || 'Saved Photo Meal',
        items: photoMealDraft.items,
        calories: Math.round(photoMealDraft.calories),
        protein: Math.round(photoMealDraft.protein),
        carbs: Math.round(photoMealDraft.carbs),
        fat: Math.round(photoMealDraft.fat),
      },
      ...prev.filter(m => m.name !== (photoMealDraft.meal_name.trim() || 'Saved Photo Meal')),
    ]);
    setPhotoMealDraft(null);
  };

  const handleSave = () => {
    const isWeightGoal   = weightGoals.has(goal);
    const isTimelineGoal = timelineGoals.has(goal);
    const timelineWeeks  = isTimelineGoal ? (meta.goalConfig.timeline_weeks[goal]?.[pace] ?? undefined) : undefined;
    const targetWeightLbs = isWeightGoal && targetWeight ? parseFloat(targetWeight) : undefined;
    const eventGoals = new Set(['strength', 'endurance', 'athletic_performance']);
    const targetEventVal = eventGoals.has(goal) && targetEvent.trim() ? targetEvent.trim() : undefined;

    onSave({
      ...profile,
      goal,
      themePreference,
      // Preserve goal start metadata so editing current weight does not reset "initial" weight.
      goalDetails: {
        ...profile.goalDetails,
        pace,
        targetWeightLbs,
        targetEvent: targetEventVal,
        timelineWeeks,
      },
      daysPerWeek: Math.min(7, Math.max(1, daysPerWeek)),
      workoutDurationMinutes: duration,
      equipment,
      foodsAvailable: foods,
      customFoods,
      savedMeals,
      mealRoutine: mealRoutine.trim() || undefined,
      physicalStats: {
        ...profile.physicalStats,
        weightLbs: currentWeight ? parseFloat(currentWeight) : profile.physicalStats.weightLbs,
      },
    });
  };

  // ── Derived ─────────────────────────────────────────────────────────────────

  const isWeightGoal   = weightGoals.has(goal);
  const paceOptions    = pacesForGoal(goal, meta.paces);
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

  const screenTitle = mode === 'equipment'
    ? 'Edit Equipment'
    : mode === 'foods'
      ? 'Edit Food Options'
      : mode === 'theme'
        ? 'Themes'
        : 'Edit Plan';
  const saveLabel = mode === 'equipment'
    ? 'Save Equipment'
    : mode === 'foods'
      ? 'Save Foods'
      : mode === 'theme'
        ? 'Save Theme'
        : 'Save & Update Plan';
  const previewTheme = getTheme(themePreference);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onCancel} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{screenTitle}</Text>
        <TouchableOpacity onPress={handleSave} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={styles.saveText}>Save</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

        {mode === 'plan' && (
        <>
        {/* ── Goal ── */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Goal</Text>
          {meta.loading ? <ActivityIndicator color={colors.primary} /> : (
            <View style={styles.goalGrid}>
              {meta.goals.map(opt => {
                const selected = goal === opt.value;
                return (
                  <TouchableOpacity
                    key={opt.value}
                    style={[styles.goalCard, selected && styles.goalCardActive]}
                    onPress={() => { setGoal(opt.value as Goal); setPace('moderate'); }}>
                    <Text style={styles.goalIcon}>{opt.icon}</Text>
                    <Text style={[styles.goalLabel, selected && styles.goalLabelActive]} numberOfLines={2}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </View>

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
                      <Text style={styles.paceIcon}>{opt.icon}</Text>
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
        {(() => {
          const eventGoals = new Set(['strength', 'endurance', 'athletic_performance']);
          if (!eventGoals.has(goal)) return null;
          const label =
            goal === 'strength'             ? 'Strength Target (optional)' :
            goal === 'endurance'            ? 'Endurance Target (optional)' :
                                              'Performance Target (optional)';
          const placeholder =
            goal === 'strength'             ? 'e.g. 315lb deadlift, 225lb bench' :
            goal === 'endurance'            ? 'e.g. half marathon, 5K in 25 min' :
                                              'e.g. sub-40s 100m, dunk a basketball';
          return (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>{label}</Text>
              <TextInput
                style={styles.textField}
                value={targetEvent}
                onChangeText={setTargetEvent}
                placeholder={placeholder}
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                returnKeyType="done"
              />
            </View>
          );
        })()}

        {/* ── Training days ── */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Training Days / Week</Text>
          <View style={styles.daysRow}>
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

        {/* ── Workout duration ── */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Session Length</Text>
          <View style={styles.durationRow}>
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

        {/* ── Meal Routine ── */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>My Meal Routine</Text>
          <Text style={styles.sectionHint}>
            Describe any fixed eating habits. Your AI nutritionist will build around these.
          </Text>
          <TextInput
            style={[styles.mealRoutineInput]}
            value={mealRoutine}
            onChangeText={setMealRoutine}
            placeholder={'Example: I have a protein shake every morning. I meal prep chicken and rice for lunch on weekdays.'}
            placeholderTextColor={colors.textMuted}
            multiline
            numberOfLines={4}
          />
        </View>
        </>
        )}

        {mode === 'theme' && (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Theme</Text>
          <View style={styles.themeList}>
            {(Object.values(APP_THEMES) as Array<(typeof APP_THEMES)[keyof typeof APP_THEMES]>).map((theme) => {
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
                    <View>
                      <Text style={[styles.themeName, { color: theme.colors.textPrimary }]}>{theme.label}</Text>
                      <Text style={[styles.themeDesc, { color: theme.colors.textSecondary }]}>{theme.description}</Text>
                    </View>
                    {selected ? <Text style={[styles.themeSelected, { color: theme.colors.primary }]}>Selected</Text> : null}
                  </View>
                  <View style={styles.themeSwatches}>
                    <View style={[styles.themeSwatch, { backgroundColor: theme.sections.workout.strong }]} />
                    <View style={[styles.themeSwatch, { backgroundColor: theme.sections.meals.strong }]} />
                    <View style={[styles.themeSwatch, { backgroundColor: theme.sections.planner.strong }]} />
                    <View style={[styles.themeSwatch, { backgroundColor: theme.colors.surfaceRaised }]} />
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={[styles.themePreview, { backgroundColor: previewTheme.colors.surface, borderColor: previewTheme.colors.border }]}>
            <Text style={[styles.themePreviewTitle, { color: previewTheme.colors.textPrimary }]}>Preview</Text>
            <View style={styles.themePreviewRow}>
              <View style={[styles.themePreviewPill, { backgroundColor: previewTheme.sections.workout.soft, borderColor: previewTheme.sections.workout.strong }]}>
                <Text style={[styles.themePreviewPillText, { color: previewTheme.sections.workout.text }]}>Workout</Text>
              </View>
              <View style={[styles.themePreviewPill, { backgroundColor: previewTheme.sections.meals.soft, borderColor: previewTheme.sections.meals.strong }]}>
                <Text style={[styles.themePreviewPillText, { color: previewTheme.sections.meals.text }]}>Meals</Text>
              </View>
              <View style={[styles.themePreviewPill, { backgroundColor: previewTheme.sections.planner.soft, borderColor: previewTheme.sections.planner.strong }]}>
                <Text style={[styles.themePreviewPillText, { color: previewTheme.sections.planner.text }]}>Planning</Text>
              </View>
            </View>
          </View>
        </View>
        )}

        {mode === 'equipment' && (
        <View style={styles.section}>
          <View style={styles.sectionTopRow}>
            <Text style={styles.sectionLabel}>
              Equipment{equipment.length > 0 ? `  ·  ${equipment.length} selected` : ''}
            </Text>
            <TouchableOpacity
              style={styles.sectionAddBtn}
              onPress={() => { setNewEquipName(''); setEquipError(''); setEquipModalVisible(true); }}>
              <Text style={styles.sectionAddBtnText}>+ Add</Text>
            </TouchableOpacity>
          </View>
          {meta.loading ? <ActivityIndicator color={colors.primary} /> : (
            <>
              {meta.equipmentCategories.map(category => (
                <View key={category.label} style={styles.chipGroup}>
                  <Text style={styles.chipGroupLabel}>{category.icon}  {category.label}</Text>
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
                  <Text style={styles.chipGroupLabel}>⚙️  Custom</Text>
                  <View style={styles.chips}>
                    {customEquipItems.map(name => (
                      <TouchableOpacity
                        key={name}
                        style={[styles.chip, styles.chipActive]}
                        onPress={() => setEquipment(prev => prev.filter(e => e !== name))}>
                        <Text style={[styles.chipText, styles.chipTextActive]}>{name}  ✕</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              )}
            </>
          )}
          <TouchableOpacity
            style={styles.addTriggerBtn}
            onPress={() => { setNewEquipName(''); setEquipError(''); setEquipModalVisible(true); }}>
            <Text style={styles.addTriggerText}>+ Add equipment</Text>
          </TouchableOpacity>
        </View>
        )}

        {mode === 'foods' && (
        <View style={styles.section}>
          <View style={styles.sectionTopRow}>
            <Text style={styles.sectionLabel}>
              Foods in Kitchen{foods.length > 0 ? `  ·  ${foods.length} selected` : ''}
            </Text>
            <TouchableOpacity style={styles.sectionAddBtn} onPress={() => setAddFoodVisible(true)}>
              <Text style={styles.sectionAddBtnText}>+ Add food</Text>
            </TouchableOpacity>
          </View>
          {meta.loading ? <ActivityIndicator color={colors.primary} /> : (
            <>
              <TextInput
                style={styles.searchInput}
                value={foodSearch}
                onChangeText={setFoodSearch}
                placeholder="Search foods or serving types"
                placeholderTextColor={colors.textMuted}
              />
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

              {filteredFoodCategories.length === 0 && filteredCustomFoods.length === 0 ? (
                <Text style={styles.emptySearchText}>No foods match the current search and category filter.</Text>
              ) : null}

              {filteredFoodCategories.map(category => (
                <View key={category.key} style={styles.chipGroup}>
                  <Text style={styles.chipGroupLabel}>{category.icon}  {category.label}</Text>
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
                  <Text style={styles.chipGroupLabel}>✨  Custom</Text>
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
                  <Text style={styles.chipGroupLabel}>📸  Saved Meals</Text>
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
          <TouchableOpacity style={styles.addTriggerBtn} onPress={() => setAddFoodVisible(true)}>
            <Text style={styles.addTriggerText}>+ Add food</Text>
          </TouchableOpacity>
          <View style={styles.photoActionsRow}>
            <TouchableOpacity style={styles.addTriggerBtn} onPress={() => handleScanFoods('camera')} disabled={scanFoodsLoading}>
              <Text style={styles.addTriggerText}>{scanFoodsLoading ? 'Scanning...' : '📷 Scan foods (camera)'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.addTriggerBtn} onPress={() => handleScanFoods('library')} disabled={scanFoodsLoading}>
              <Text style={styles.addTriggerText}>🖼 Scan foods (library)</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.addTriggerBtn, { opacity: 0.7 }]} onPress={() => handleAnalyzeFoodPhoto('camera')} disabled={photoMealLoading}>
              <Text style={styles.addTriggerText}>{photoMealLoading ? 'Analyzing...' : '+ Scan meal photo'}</Text>
            </TouchableOpacity>
          </View>
        </View>
        )}

        <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
          <Text style={styles.saveBtnText}>{saveLabel}</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* ── Modals ── */}
      <InputModal
        visible={currentWeightModalVisible}
        title="Current Weight" subtitle="Your weight right now"
        placeholder="e.g. 185" value={currentWeightInput} onChange={setCurrentWeightInput}
        onConfirm={() => { setCurrentWeight(currentWeightInput); setCurrentWeightModalVisible(false); }}
        onClose={() => setCurrentWeightModalVisible(false)}
        confirmLabel="Update" keyboardType="decimal-pad"
      />
      <InputModal
        visible={weightModalVisible}
        title="Target Weight" subtitle="How much do you want to weigh?"
        placeholder="e.g. 175" value={weightInput} onChange={setWeightInput}
        onConfirm={() => { setTargetWeight(weightInput); setWeightModalVisible(false); }}
        onClose={() => setWeightModalVisible(false)}
        confirmLabel="Set" keyboardType="decimal-pad"
      />
      <InputModal
        visible={equipModalVisible}
        title="Add Equipment" subtitle="Enter the name of your equipment"
        placeholder="e.g. Resistance bands, TRX"
        value={newEquipName} onChange={v => { setNewEquipName(v); setEquipError(''); }}
        onConfirm={handleAddEquipment}
        onClose={() => setEquipModalVisible(false)}
        confirmLabel="Add" error={equipError}
      />
      <AddFoodModal visible={addFoodVisible} onAdd={handleAddCustomFood} onClose={() => setAddFoodVisible(false)} />

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
                placeholderTextColor={colors.textMuted}
              />

              <View style={styles.photoMealCard}>
                <Text style={styles.photoMealCardTitle}>Detected foods</Text>
                <Text style={styles.photoMealItems}>{photoMealDraft?.items.join(' · ')}</Text>
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 56, paddingBottom: 14,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  title:      { fontSize: 16, fontWeight: '700', color: colors.textPrimary },
  cancelText: { fontSize: 15, color: colors.textSecondary },
  saveText:   { fontSize: 15, fontWeight: '700', color: colors.primary },

  content:      { padding: 16, paddingBottom: 48 },
  section:         { marginBottom: 28 },
  sectionTopRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  sectionLabel:    { fontSize: 12, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.8 },
  sectionAddBtn:   { backgroundColor: colors.primary, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 6 },
  sectionAddBtnText: { fontSize: 12, fontWeight: '700', color: colors.background },
  sectionHint:     { fontSize: 12, color: colors.textMuted, marginBottom: 10 },
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

  goalGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  goalCard: { width: '31%', backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, paddingVertical: 12, paddingHorizontal: 8, alignItems: 'center', gap: 6 },
  goalCardActive: { borderColor: colors.primary, backgroundColor: colors.surfaceRaised },
  goalIcon:       { fontSize: 22 },
  goalLabel:      { fontSize: 11, color: colors.textSecondary, textAlign: 'center', fontWeight: '500' },
  goalLabelActive:{ color: colors.primary, fontWeight: '700' },

  paceList: { gap: 8 },
  paceCard: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, padding: 12, gap: 4 },
  paceCardActive: { borderColor: colors.primary, backgroundColor: colors.surfaceRaised },
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
  durationBtn:        { paddingVertical: 10, paddingHorizontal: 12, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface, alignItems: 'center' },
  durationBtnActive:  { borderColor: colors.primary, backgroundColor: colors.surfaceRaised },
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
  themeCardTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  themeName: { fontSize: 15, fontWeight: '700' },
  themeDesc: { fontSize: 12, lineHeight: 17, marginTop: 2 },
  themeSelected: { fontSize: 12, fontWeight: '700' },
  themeSwatches: { flexDirection: 'row', gap: 8 },
  themeSwatch: { width: 28, height: 28, borderRadius: radius.full },
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
  chipGroupLabel: { fontSize: 12, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 },
  searchInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
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
  filterChipActive: { borderColor: colors.primary, backgroundColor: colors.surfaceRaised },
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
  chip:           { paddingVertical: 7, paddingHorizontal: 12, borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface },
  chipActive:     { borderColor: colors.primary, backgroundColor: colors.surfaceRaised },
  chipText:       { fontSize: 13, color: colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: colors.primary, fontWeight: '600' },

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

  saveBtn:     { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 16, alignItems: 'center', marginTop: 8 },
  saveBtnText: { fontSize: 16, fontWeight: '700', color: colors.background },
});
