import { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  TextInput, Modal, KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { UserProfile, CustomFoodItem, Goal, GoalPace, SavedMealTemplate } from '../types';
import { useMetaData, pacesForGoal } from '../hooks/useMetaData';
import { colors, radius } from '../constants/theme';
import { analyzeFoodPhoto } from '../services/api';

interface EditProfileScreenProps {
  authToken: string;
  profile: UserProfile;
  onSave: (updated: UserProfile) => void;
  onCancel: () => void;
}

interface PhotoMealDraft {
  meal_name: string;
  items: string[];
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
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

export default function EditProfileScreen({ authToken, profile, onSave, onCancel }: EditProfileScreenProps) {
  const meta = useMetaData();

  const weightGoals   = new Set(meta.goalConfig.weight_goals);
  const timelineGoals = new Set(meta.goalConfig.timeline_goals);

  // Goal
  const [goal, setGoal]   = useState<Goal>(profile.goal);
  const [pace, setPace]   = useState<GoalPace>(profile.goalDetails.pace);
  const [targetWeight, setTargetWeight] = useState<string>(
    profile.goalDetails.targetWeightLbs ? String(profile.goalDetails.targetWeightLbs) : ''
  );

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
  const [foodSearch, setFoodSearch]   = useState('');
  const [foodCategoryFilter, setFoodCategoryFilter] = useState<string>('all');

  // Modals
  const [addFoodVisible,    setAddFoodVisible]    = useState(false);
  const [photoMealLoading,  setPhotoMealLoading]  = useState(false);
  const [photoMealDraft,    setPhotoMealDraft]    = useState<PhotoMealDraft | null>(null);
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

    onSave({
      ...profile,
      goal,
      // Preserve goal start metadata so editing current weight does not reset "initial" weight.
      goalDetails: {
        ...profile.goalDetails,
        pace,
        targetWeightLbs,
        timelineWeeks,
      },
      daysPerWeek: Math.min(7, Math.max(1, daysPerWeek)),
      workoutDurationMinutes: duration,
      equipment,
      foodsAvailable: foods,
      customFoods,
      savedMeals,
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

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onCancel} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Edit Plan</Text>
        <TouchableOpacity onPress={handleSave} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={styles.saveText}>Save</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

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

        {/* ── Equipment ── */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>
            Equipment{equipment.length > 0 ? `  ·  ${equipment.length} selected` : ''}
          </Text>
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

        {/* ── Foods ── */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>
            Foods in Kitchen{foods.length > 0 ? `  ·  ${foods.length} selected` : ''}
          </Text>
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
            <TouchableOpacity style={styles.addTriggerBtn} onPress={() => handleAnalyzeFoodPhoto('camera')} disabled={photoMealLoading}>
              <Text style={styles.addTriggerText}>{photoMealLoading ? 'Analyzing...' : '+ Scan food photo'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.addTriggerBtn} onPress={() => handleAnalyzeFoodPhoto('library')} disabled={photoMealLoading}>
              <Text style={styles.addTriggerText}>+ Choose photo</Text>
            </TouchableOpacity>
          </View>
        </View>

        <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
          <Text style={styles.saveBtnText}>Save & Update Plan</Text>
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

      <Modal visible={!!photoMealDraft} transparent animationType="slide" onRequestClose={() => setPhotoMealDraft(null)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <TouchableOpacity style={im.backdrop} activeOpacity={1} onPress={() => setPhotoMealDraft(null)}>
            <View style={im.sheet}>
              <View style={im.handle} />
              <Text style={im.title}>Confirm Photo Meal</Text>
              <Text style={im.subtitle}>Review the detected foods and save this as a reusable meal entry.</Text>

              <TextInput
                style={im.input}
                value={photoMealDraft?.meal_name ?? ''}
                onChangeText={(value) => setPhotoMealDraft(prev => prev ? { ...prev, meal_name: value } : prev)}
                placeholder="Meal name"
                placeholderTextColor={colors.textMuted}
              />

              <View style={styles.photoMealCard}>
                <Text style={styles.photoMealCardTitle}>Detected Contents</Text>
                <Text style={styles.photoMealItems}>{photoMealDraft?.items.join(', ')}</Text>
                <Text style={styles.photoMealMacros}>
                  {Math.round(photoMealDraft?.calories ?? 0)} cal · {Math.round(photoMealDraft?.protein ?? 0)}g protein · {Math.round(photoMealDraft?.carbs ?? 0)}g carbs · {Math.round(photoMealDraft?.fat ?? 0)}g fat
                </Text>
              </View>

              <TouchableOpacity style={im.confirmBtn} onPress={confirmPhotoMeal}>
                <Text style={im.confirmText}>Save as Reusable Meal</Text>
              </TouchableOpacity>
            </View>
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
  section:      { marginBottom: 28 },
  sectionLabel: { fontSize: 12, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12 },

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

  saveBtn:     { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 16, alignItems: 'center', marginTop: 8 },
  saveBtnText: { fontSize: 16, fontWeight: '700', color: colors.background },
});
