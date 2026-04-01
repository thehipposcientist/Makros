import { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  TextInput, ActivityIndicator, Modal, KeyboardAvoidingView, Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { UserProfile, CustomFoodItem, Goal, GoalPace } from '../types';
import { FOOD_CATEGORIES } from '../constants/foods';
import { EQUIPMENT_CATEGORIES } from '../constants/equipment';
import {
  GOAL_OPTIONS, GOAL_LABEL, PACE_OPTIONS, WEIGHT_GOALS, TIMELINE_GOALS, TIMELINE_WEEKS,
} from '../constants/goals';
import { lookupFoodMacros, lookupEquipmentInfo } from '../services/api';
import { colors, radius } from '../constants/theme';

interface EditProfileScreenProps {
  profile: UserProfile;
  onSave: (updated: UserProfile) => void;
  onCancel: () => void;
}

const DURATION_OPTIONS = [
  { value: 30, label: '30 min', desc: 'Express' },
  { value: 45, label: '45 min', desc: 'Standard' },
  { value: 60, label: '60 min', desc: 'Full' },
  { value: 75, label: '75 min', desc: 'Extended' },
  { value: 90, label: '90 min', desc: 'Deep' },
];

// ── Reusable input modal ──────────────────────────────────────────────────────

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
  loading?: boolean;
  error?: string;
  keyboardType?: 'default' | 'decimal-pad' | 'number-pad';
  extra?: React.ReactNode;
}

function InputModal({
  visible, title, subtitle, placeholder, value, onChange, onConfirm, onClose,
  confirmLabel = 'Confirm', loading, error, keyboardType = 'default', extra,
}: InputModalProps) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <TouchableOpacity style={im.backdrop} activeOpacity={1} onPress={onClose}>
          <View style={im.sheet}>
            <View style={im.handle} />
            <Text style={im.title}>{title}</Text>
            {subtitle ? <Text style={im.subtitle}>{subtitle}</Text> : null}
            {extra}
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
            <TouchableOpacity style={im.confirmBtn} onPress={onConfirm} disabled={loading}>
              {loading
                ? <ActivityIndicator color={colors.background} />
                : <Text style={im.confirmText}>{confirmLabel}</Text>}
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

// ─────────────────────────────────────────────────────────────────────────────

export default function EditProfileScreen({ profile, onSave, onCancel }: EditProfileScreenProps) {
  // Goal
  const [goal, setGoal] = useState<Goal>(profile.goal);
  const [pace, setPace] = useState<GoalPace>(profile.goalDetails.pace);
  const [targetWeight, setTargetWeight] = useState<string>(
    profile.goalDetails.targetWeightLbs ? String(profile.goalDetails.targetWeightLbs) : ''
  );

  // Workout prefs
  const [daysPerWeek, setDaysPerWeek]   = useState(profile.daysPerWeek);
  const [duration, setDuration]         = useState(profile.workoutDurationMinutes ?? 60);
  const [equipment, setEquipment]       = useState<string[]>(profile.equipment as string[]);
  const [foods, setFoods]               = useState<string[]>(profile.foodsAvailable);
  const [customFoods, setCustomFoods]   = useState<CustomFoodItem[]>(profile.customFoods ?? []);

  // Add food modal
  const [foodModalVisible, setFoodModalVisible]   = useState(false);
  const [newFoodName, setNewFoodName]             = useState('');
  const [foodLookupLoading, setFoodLookupLoading] = useState(false);
  const [foodLookupError, setFoodLookupError]     = useState('');

  // Manual macro fallback modal
  const [manualModalVisible, setManualModalVisible] = useState(false);
  const [manualFoodName, setManualFoodName]         = useState('');
  const [manualCalories, setManualCalories]         = useState('');
  const [manualProtein, setManualProtein]           = useState('');
  const [manualCarbs, setManualCarbs]               = useState('');
  const [manualFat, setManualFat]                   = useState('');

  // Add equipment modal
  const [equipModalVisible, setEquipModalVisible]   = useState(false);
  const [newEquipName, setNewEquipName]             = useState('');
  const [equipLookupLoading, setEquipLookupLoading] = useState(false);
  const [equipLookupError, setEquipLookupError]     = useState('');

  // Target weight modal
  const [weightModalVisible, setWeightModalVisible] = useState(false);
  const [weightInput, setWeightInput]               = useState(targetWeight);

  const toggleEquipment = (name: string) =>
    setEquipment(prev => prev.includes(name) ? prev.filter(e => e !== name) : [...prev, name]);

  const toggleFood = (name: string) =>
    setFoods(prev => prev.includes(name) ? prev.filter(f => f !== name) : [...prev, name]);

  // ── Food lookup ────────────────────────────────────────────────────────────

  const handleAddFood = async () => {
    const name = newFoodName.trim();
    if (!name) return;
    setFoodLookupError('');
    setFoodLookupLoading(true);
    try {
      const token = await AsyncStorage.getItem('authToken');
      if (!token) throw new Error('Not authenticated');
      const macros = await lookupFoodMacros(token, name);
      const item: CustomFoodItem = {
        name: macros.name || name,
        unit: macros.unit || '1 serving',
        calories: macros.calories || 0,
        protein: macros.protein || 0,
        carbs: macros.carbs || 0,
        fat: macros.fat || 0,
      };
      setCustomFoods(prev => [...prev.filter(f => f.name !== item.name), item]);
      setFoods(prev => prev.includes(item.name) ? prev : [...prev, item.name]);
      setNewFoodName('');
      setFoodModalVisible(false);
    } catch (e: any) {
      // If AI lookup fails (502/401 key issue), offer manual entry
      const msg: string = e.message ?? 'Lookup failed';
      if (msg.includes('502') || msg.includes('401') || msg.includes('API key') || msg.includes('Lookup failed')) {
        setFoodLookupError('AI lookup unavailable. Enter macros manually below.');
        setManualFoodName(name);
        setManualCalories('');
        setManualProtein('');
        setManualCarbs('');
        setManualFat('');
        setFoodModalVisible(false);
        setManualModalVisible(true);
      } else {
        setFoodLookupError(msg);
      }
    } finally {
      setFoodLookupLoading(false);
    }
  };

  const handleManualAdd = () => {
    const name = manualFoodName.trim();
    if (!name) return;
    const item: CustomFoodItem = {
      name,
      unit: '1 serving',
      calories: parseFloat(manualCalories) || 0,
      protein: parseFloat(manualProtein) || 0,
      carbs: parseFloat(manualCarbs) || 0,
      fat: parseFloat(manualFat) || 0,
    };
    setCustomFoods(prev => [...prev.filter(f => f.name !== item.name), item]);
    setFoods(prev => prev.includes(item.name) ? prev : [...prev, item.name]);
    setManualModalVisible(false);
  };

  // ── Equipment lookup ───────────────────────────────────────────────────────

  const handleAddEquipment = async () => {
    const name = newEquipName.trim();
    if (!name) return;
    setEquipLookupError('');
    setEquipLookupLoading(true);
    try {
      const token = await AsyncStorage.getItem('authToken');
      if (!token) throw new Error('Not authenticated');
      const info = await lookupEquipmentInfo(token, name);
      const finalName = info.name || name;
      setEquipment(prev => prev.includes(finalName) ? prev : [...prev, finalName]);
      setNewEquipName('');
      setEquipModalVisible(false);
    } catch {
      // Add anyway even if AI lookup fails
      if (!equipment.includes(name)) setEquipment(prev => [...prev, name]);
      setNewEquipName('');
      setEquipModalVisible(false);
    } finally {
      setEquipLookupLoading(false);
    }
  };

  // ── Save ───────────────────────────────────────────────────────────────────

  const handleSave = () => {
    const isWeightGoal    = WEIGHT_GOALS.has(goal);
    const isTimelineGoal  = TIMELINE_GOALS.has(goal);
    const timelineWeeks   = isTimelineGoal ? TIMELINE_WEEKS[goal][pace] : undefined;
    const targetWeightLbs = isWeightGoal && targetWeight ? parseFloat(targetWeight) : undefined;

    onSave({
      ...profile,
      goal,
      goalDetails: { pace, targetWeightLbs, timelineWeeks },
      daysPerWeek: Math.min(7, Math.max(1, daysPerWeek)),
      workoutDurationMinutes: duration,
      equipment,
      foodsAvailable: foods,
      customFoods,
    });
  };

  // ── Derived ────────────────────────────────────────────────────────────────

  const isWeightGoal   = WEIGHT_GOALS.has(goal);
  const isTimelineGoal = TIMELINE_GOALS.has(goal);
  const paceOptions    = PACE_OPTIONS[goal] ?? [];
  const standardEquipNames = new Set(EQUIPMENT_CATEGORIES.flatMap(c => c.items.map(i => i.name)));
  const customEquipItems   = equipment.filter(e => !standardEquipNames.has(e));
  const customFoodNames    = customFoods.map(f => f.name);

  return (
    <View style={styles.container}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onCancel} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Edit Preferences</Text>
        <TouchableOpacity onPress={handleSave} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={styles.saveText}>Save</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

        {/* ── Goal ── */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Goal</Text>
          <View style={styles.goalGrid}>
            {GOAL_OPTIONS.map(opt => {
              const selected = goal === opt.value;
              return (
                <TouchableOpacity
                  key={opt.value}
                  style={[styles.goalCard, selected && styles.goalCardActive]}
                  onPress={() => {
                    setGoal(opt.value);
                    setPace('moderate');
                  }}>
                  <Text style={styles.goalIcon}>{opt.icon}</Text>
                  <Text style={[styles.goalLabel, selected && styles.goalLabelActive]} numberOfLines={2}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* ── Pace / Timeline (depends on goal) ── */}
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
                    onPress={() => setPace(opt.value)}>
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

        {/* ── Target weight (weight goals only) ── */}
        {isWeightGoal && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Target Weight (lbs)</Text>
            <TouchableOpacity
              style={styles.targetWeightBtn}
              onPress={() => { setWeightInput(targetWeight); setWeightModalVisible(true); }}>
              <Text style={targetWeight ? styles.targetWeightValue : styles.targetWeightPlaceholder}>
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
                <Text style={[styles.durationDesc, duration === opt.value && styles.durationDescActive]}>{opt.desc}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* ── Equipment ── */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>
            Equipment{equipment.length > 0 ? `  ·  ${equipment.length} selected` : ''}
          </Text>
          {EQUIPMENT_CATEGORIES.map(category => (
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

          <TouchableOpacity
            style={styles.addTriggerBtn}
            onPress={() => { setNewEquipName(''); setEquipLookupError(''); setEquipModalVisible(true); }}>
            <Text style={styles.addTriggerText}>+ Add custom equipment</Text>
          </TouchableOpacity>
        </View>

        {/* ── Foods ── */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>
            Foods in Kitchen{foods.length > 0 ? `  ·  ${foods.length} selected` : ''}
          </Text>
          {FOOD_CATEGORIES.map(category => (
            <View key={category.label} style={styles.chipGroup}>
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

          {customFoodNames.length > 0 && (
            <View style={styles.chipGroup}>
              <Text style={styles.chipGroupLabel}>✨  Custom</Text>
              <View style={styles.chips}>
                {customFoods.map(f => {
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

          <TouchableOpacity
            style={styles.addTriggerBtn}
            onPress={() => { setNewFoodName(''); setFoodLookupError(''); setFoodModalVisible(true); }}>
            <Text style={styles.addTriggerText}>+ Add custom food</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
          <Text style={styles.saveBtnText}>Save & Update Plan</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* ── Add food modal ── */}
      <InputModal
        visible={foodModalVisible}
        title="Add Custom Food"
        subtitle="We'll look up macros from AI"
        placeholder="e.g. Greek yogurt, Ribeye steak"
        value={newFoodName}
        onChange={v => { setNewFoodName(v); setFoodLookupError(''); }}
        onConfirm={handleAddFood}
        onClose={() => setFoodModalVisible(false)}
        confirmLabel="Look Up"
        loading={foodLookupLoading}
        error={foodLookupError}
      />

      {/* ── Manual macro entry modal (fallback) ── */}
      <Modal visible={manualModalVisible} transparent animationType="slide" onRequestClose={() => setManualModalVisible(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <TouchableOpacity style={im.backdrop} activeOpacity={1} onPress={() => setManualModalVisible(false)}>
            <View style={im.sheet}>
              <View style={im.handle} />
              <Text style={im.title}>Add Manually</Text>
              <Text style={im.subtitle}>AI unavailable — enter macros for "{manualFoodName}"</Text>
              <TextInput
                style={im.input}
                value={manualFoodName}
                onChangeText={setManualFoodName}
                placeholder="Food name"
                placeholderTextColor={colors.textMuted}
              />
              <View style={styles.macroRow}>
                <View style={styles.macroField}>
                  <Text style={styles.macroLabel}>Calories</Text>
                  <TextInput style={styles.macroInput} value={manualCalories} onChangeText={setManualCalories} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={colors.textMuted} />
                </View>
                <View style={styles.macroField}>
                  <Text style={styles.macroLabel}>Protein (g)</Text>
                  <TextInput style={styles.macroInput} value={manualProtein} onChangeText={setManualProtein} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={colors.textMuted} />
                </View>
              </View>
              <View style={styles.macroRow}>
                <View style={styles.macroField}>
                  <Text style={styles.macroLabel}>Carbs (g)</Text>
                  <TextInput style={styles.macroInput} value={manualCarbs} onChangeText={setManualCarbs} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={colors.textMuted} />
                </View>
                <View style={styles.macroField}>
                  <Text style={styles.macroLabel}>Fat (g)</Text>
                  <TextInput style={styles.macroInput} value={manualFat} onChangeText={setManualFat} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={colors.textMuted} />
                </View>
              </View>
              <TouchableOpacity style={im.confirmBtn} onPress={handleManualAdd}>
                <Text style={im.confirmText}>Add Food</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Add equipment modal ── */}
      <InputModal
        visible={equipModalVisible}
        title="Add Custom Equipment"
        subtitle="AI will categorise muscle groups"
        placeholder="e.g. Resistance bands, TRX"
        value={newEquipName}
        onChange={v => { setNewEquipName(v); setEquipLookupError(''); }}
        onConfirm={handleAddEquipment}
        onClose={() => setEquipModalVisible(false)}
        confirmLabel="Add"
        loading={equipLookupLoading}
        error={equipLookupError}
      />

      {/* ── Target weight modal ── */}
      <InputModal
        visible={weightModalVisible}
        title="Target Weight"
        subtitle="How much do you want to weigh?"
        placeholder="e.g. 175"
        value={weightInput}
        onChange={setWeightInput}
        onConfirm={() => { setTargetWeight(weightInput); setWeightModalVisible(false); }}
        onClose={() => setWeightModalVisible(false)}
        confirmLabel="Set"
        keyboardType="decimal-pad"
      />
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

  content: { padding: 16, paddingBottom: 48 },
  section: { marginBottom: 28 },
  sectionLabel: {
    fontSize: 12, fontWeight: '700', color: colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12,
  },

  // Goal grid
  goalGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  goalCard: {
    width: '31%', backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: 1.5, borderColor: colors.border,
    paddingVertical: 12, paddingHorizontal: 8, alignItems: 'center', gap: 6,
  },
  goalCardActive: { borderColor: colors.primary, backgroundColor: colors.surfaceRaised },
  goalIcon:       { fontSize: 22 },
  goalLabel:      { fontSize: 11, color: colors.textSecondary, textAlign: 'center', fontWeight: '500' },
  goalLabelActive:{ color: colors.primary, fontWeight: '700' },

  // Pace
  paceList: { gap: 8 },
  paceCard: {
    backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: 1.5, borderColor: colors.border, padding: 12, gap: 4,
  },
  paceCardActive: { borderColor: colors.primary, backgroundColor: colors.surfaceRaised },
  paceTop:        { flexDirection: 'row', alignItems: 'center', gap: 10 },
  paceIcon:       { fontSize: 20 },
  paceLabel:      { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  paceLabelActive:{ color: colors.primary },
  paceRate:       { fontSize: 11, color: colors.textMuted },
  paceDesc:       { fontSize: 12, color: colors.textSecondary, marginLeft: 30 },

  // Target weight
  targetWeightBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surface, borderRadius: radius.md, padding: 14,
    borderWidth: 1, borderColor: colors.border,
  },
  targetWeightValue:      { fontSize: 16, fontWeight: '600', color: colors.textPrimary },
  targetWeightPlaceholder:{ fontSize: 15, color: colors.textMuted },
  editHint: { fontSize: 13, color: colors.primary, fontWeight: '600' },

  // Days
  daysRow:         { flexDirection: 'row', alignItems: 'center', gap: 20 },
  daysBtn:         { width: 44, height: 44, borderRadius: radius.full, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  daysBtnDisabled: { opacity: 0.3 },
  daysBtnText:     { fontSize: 22, color: colors.textPrimary, fontWeight: '300' },
  daysValue:       { fontSize: 32, fontWeight: '700', color: colors.primary, minWidth: 40, textAlign: 'center' },

  // Duration
  durationRow:        { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  durationBtn:        { paddingVertical: 10, paddingHorizontal: 12, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface, alignItems: 'center' },
  durationBtnActive:  { borderColor: colors.primary, backgroundColor: colors.surfaceRaised },
  durationLabel:      { fontSize: 13, fontWeight: '700', color: colors.textPrimary },
  durationLabelActive:{ color: colors.primary },
  durationDesc:       { fontSize: 10, color: colors.textMuted, marginTop: 2 },
  durationDescActive: { color: colors.primaryLight },

  // Chips
  chipGroup:      { marginBottom: 16 },
  chipGroupLabel: { fontSize: 12, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 },
  chips:          { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip:           { paddingVertical: 7, paddingHorizontal: 12, borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface },
  chipActive:     { borderColor: colors.primary, backgroundColor: colors.surfaceRaised },
  chipText:       { fontSize: 13, color: colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: colors.primary, fontWeight: '600' },

  // Add triggers
  addTriggerBtn:  { alignSelf: 'flex-start', marginTop: 4, paddingVertical: 8, paddingHorizontal: 14, borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface },
  addTriggerText: { fontSize: 13, color: colors.primary, fontWeight: '600' },

  // Manual macro entry
  macroRow:   { flexDirection: 'row', gap: 10 },
  macroField: { flex: 1, gap: 4 },
  macroLabel: { fontSize: 11, fontWeight: '600', color: colors.textSecondary },
  macroInput: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12, fontSize: 16, fontWeight: '600', color: colors.textPrimary, backgroundColor: colors.background, textAlign: 'center' },

  saveBtn:     { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 16, alignItems: 'center', marginTop: 8 },
  saveBtnText: { fontSize: 16, fontWeight: '700', color: colors.background },
});
