import { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  TextInput, ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { UserProfile, CustomFoodItem } from '../types';
import { FOOD_CATEGORIES } from '../constants/foods';
import { EQUIPMENT_CATEGORIES } from '../constants/equipment';
import { GOAL_LABEL } from '../constants/goals';
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

export default function EditProfileScreen({ profile, onSave, onCancel }: EditProfileScreenProps) {
  const [daysPerWeek, setDaysPerWeek] = useState(profile.daysPerWeek);
  const [duration, setDuration] = useState(profile.workoutDurationMinutes ?? 60);
  const [equipment, setEquipment] = useState<string[]>(profile.equipment as string[]);
  const [foods, setFoods] = useState<string[]>(profile.foodsAvailable);
  const [customFoods, setCustomFoods] = useState<CustomFoodItem[]>(profile.customFoods ?? []);

  // Custom add state
  const [newFoodName, setNewFoodName] = useState('');
  const [foodLookupLoading, setFoodLookupLoading] = useState(false);
  const [foodLookupError, setFoodLookupError] = useState('');
  const [newEquipName, setNewEquipName] = useState('');
  const [equipLookupLoading, setEquipLookupLoading] = useState(false);
  const [equipLookupError, setEquipLookupError] = useState('');

  const toggleEquipment = (name: string) => {
    setEquipment(prev => prev.includes(name) ? prev.filter(e => e !== name) : [...prev, name]);
  };

  const toggleFood = (name: string) => {
    setFoods(prev => prev.includes(name) ? prev.filter(f => f !== name) : [...prev, name]);
  };

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
    } catch (e: any) {
      setFoodLookupError(e.message ?? 'Lookup failed');
    } finally {
      setFoodLookupLoading(false);
    }
  };

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
    } catch {
      // Still add even if AI lookup fails
      if (!equipment.includes(name)) setEquipment(prev => [...prev, name]);
      setNewEquipName('');
    } finally {
      setEquipLookupLoading(false);
    }
  };

  const handleSave = () => {
    onSave({
      ...profile,
      daysPerWeek: Math.min(7, Math.max(1, daysPerWeek)),
      workoutDurationMinutes: duration,
      equipment,
      foodsAvailable: foods,
      customFoods,
    });
  };

  const goalLabel = GOAL_LABEL[profile.goal] ?? profile.goal;

  // Custom foods not in the standard list
  const customFoodNames = customFoods.map(f => f.name);
  // Custom equipment not in any standard category
  const standardEquipNames = new Set(EQUIPMENT_CATEGORIES.flatMap(c => c.items.map(i => i.name)));
  const customEquipItems = equipment.filter(e => !standardEquipNames.has(e));

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onCancel} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Edit Preferences</Text>
        <TouchableOpacity onPress={handleSave} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={styles.saveText}>Save</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content}>

        {/* Goal — read-only */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Current Goal</Text>
          <View style={styles.readonlyBox}>
            <Text style={styles.readonlyValue}>{goalLabel}</Text>
            <Text style={styles.readonlyHint}>Re-run onboarding to change goal</Text>
          </View>
        </View>

        {/* Days per week */}
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

        {/* Workout duration */}
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

        {/* Equipment */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>
            Equipment  {equipment.length > 0 ? `· ${equipment.length} selected` : ''}
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

          {/* Custom equipment items */}
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

          {/* Add custom equipment */}
          <View style={styles.addRow}>
            <TextInput
              style={styles.addInput}
              placeholder="Add equipment…"
              placeholderTextColor={colors.textMuted}
              value={newEquipName}
              onChangeText={t => { setNewEquipName(t); setEquipLookupError(''); }}
              onSubmitEditing={handleAddEquipment}
            />
            <TouchableOpacity style={styles.addBtn} onPress={handleAddEquipment} disabled={equipLookupLoading}>
              {equipLookupLoading
                ? <ActivityIndicator size="small" color={colors.background} />
                : <Text style={styles.addBtnText}>Add</Text>}
            </TouchableOpacity>
          </View>
          {equipLookupError ? <Text style={styles.errorText}>{equipLookupError}</Text> : null}
        </View>

        {/* Foods */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>
            Foods in Kitchen  {foods.length > 0 ? `· ${foods.length} selected` : ''}
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

          {/* Custom foods */}
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
                        {f.name} ({f.calories} cal)
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          )}

          {/* Add custom food */}
          <View style={styles.addRow}>
            <TextInput
              style={styles.addInput}
              placeholder="Add a food…"
              placeholderTextColor={colors.textMuted}
              value={newFoodName}
              onChangeText={t => { setNewFoodName(t); setFoodLookupError(''); }}
              onSubmitEditing={handleAddFood}
            />
            <TouchableOpacity style={styles.addBtn} onPress={handleAddFood} disabled={foodLookupLoading}>
              {foodLookupLoading
                ? <ActivityIndicator size="small" color={colors.background} />
                : <Text style={styles.addBtnText}>Look up</Text>}
            </TouchableOpacity>
          </View>
          {foodLookupError ? <Text style={styles.errorText}>{foodLookupError}</Text> : null}
        </View>

        <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
          <Text style={styles.saveBtnText}>Save & Update Plan</Text>
        </TouchableOpacity>
      </ScrollView>
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

  readonlyBox:   { backgroundColor: colors.surface, borderRadius: radius.md, padding: 14, borderWidth: 1, borderColor: colors.border },
  readonlyValue: { fontSize: 16, fontWeight: '600', color: colors.textPrimary, marginBottom: 4 },
  readonlyHint:  { fontSize: 12, color: colors.textMuted },

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
  chips:          { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip:           { paddingVertical: 7, paddingHorizontal: 12, borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface },
  chipActive:     { borderColor: colors.primary, backgroundColor: colors.surfaceRaised },
  chipText:       { fontSize: 13, color: colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: colors.primary, fontWeight: '600' },

  addRow:    { flexDirection: 'row', gap: 8, marginTop: 8 },
  addInput:  { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12, fontSize: 14, backgroundColor: colors.surface, color: colors.textPrimary },
  addBtn:    { backgroundColor: colors.primary, borderRadius: radius.md, paddingHorizontal: 16, justifyContent: 'center', alignItems: 'center', minWidth: 72 },
  addBtnText:{ fontSize: 13, fontWeight: '700', color: colors.background },
  errorText: { fontSize: 12, color: colors.error, marginTop: 6 },

  saveBtn:     { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 16, alignItems: 'center', marginTop: 8 },
  saveBtnText: { fontSize: 16, fontWeight: '700', color: colors.background },
});
