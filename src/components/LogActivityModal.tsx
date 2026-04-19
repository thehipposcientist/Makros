import { useState, useCallback } from 'react';
import {
  View, Text, Modal, TouchableOpacity, TextInput, ScrollView,
  StyleSheet, Alert, LayoutAnimation, UIManager, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme } from '../constants/theme';
import {
  AppThemeName, WorkoutSession,
  ActivityCategory, ActivityIntensity, CardioStyle,
} from '../types';
import PressableScale from './PressableScale';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ─── Category definitions ────────────────────────────────────────────────────

const CATEGORIES: { key: ActivityCategory; label: string; icon: string; desc: string }[] = [
  { key: 'strength', label: 'Strength',  icon: 'barbell-outline',    desc: 'Weights, resistance' },
  { key: 'cardio',   label: 'Cardio',    icon: 'bicycle-outline',    desc: 'Running, cycling, swim' },
  { key: 'mobility', label: 'Mobility',  icon: 'body-outline',       desc: 'Yoga, stretching' },
  { key: 'sport',    label: 'Sport',     icon: 'basketball-outline',  desc: 'Basketball, soccer, etc' },
  { key: 'recovery', label: 'Recovery',  icon: 'bed-outline',        desc: 'Sauna, ice bath, rest' },
];

type SubtypeDef = { key: string; label: string; icon: string };

const SUBTYPES: Record<ActivityCategory, SubtypeDef[]> = {
  strength: [
    { key: 'push',       label: 'Push',       icon: 'arrow-up-outline' },
    { key: 'pull',       label: 'Pull',       icon: 'arrow-down-outline' },
    { key: 'legs',       label: 'Legs',       icon: 'footsteps-outline' },
    { key: 'upper_body', label: 'Upper Body', icon: 'body-outline' },
    { key: 'lower_body', label: 'Lower Body', icon: 'fitness-outline' },
    { key: 'full_body',  label: 'Full Body',  icon: 'expand-outline' },
  ],
  cardio: [
    { key: 'walk',       label: 'Walk',       icon: 'walk-outline' },
    { key: 'run',        label: 'Run',        icon: 'footsteps-outline' },
    { key: 'ride',       label: 'Ride',       icon: 'bicycle-outline' },
    { key: 'spin',       label: 'Spin Class', icon: 'fitness-outline' },
    { key: 'hike',       label: 'Hike',       icon: 'trail-sign-outline' },
    { key: 'swim',       label: 'Swim',       icon: 'water-outline' },
    { key: 'row',        label: 'Row',        icon: 'boat-outline' },
    { key: 'stair',      label: 'Stair',      icon: 'trending-up-outline' },
    { key: 'elliptical', label: 'Elliptical', icon: 'sync-outline' },
    { key: 'bootcamp',   label: 'Bootcamp',   icon: 'flame-outline' },
    { key: 'other',      label: 'Other',      icon: 'ellipsis-horizontal-outline' },
  ],
  mobility: [
    { key: 'yoga',       label: 'Yoga',       icon: 'body-outline' },
    { key: 'stretching', label: 'Stretching', icon: 'resize-outline' },
    { key: 'foam_roll',  label: 'Foam Roll',  icon: 'ellipse-outline' },
    { key: 'pilates',    label: 'Pilates',    icon: 'flower-outline' },
  ],
  sport: [
    { key: 'basketball',   label: 'Basketball',   icon: 'basketball-outline' },
    { key: 'soccer',       label: 'Soccer',       icon: 'football-outline' },
    { key: 'tennis',       label: 'Tennis',        icon: 'tennisball-outline' },
    { key: 'golf',         label: 'Golf',          icon: 'golf-outline' },
    { key: 'climbing',     label: 'Climbing',      icon: 'trending-up-outline' },
    { key: 'boxing',       label: 'Boxing',        icon: 'hand-right-outline' },
    { key: 'kickboxing',   label: 'Kickboxing',    icon: 'hand-left-outline' },
    { key: 'martial_arts', label: 'Martial Arts',  icon: 'shield-outline' },
    { key: 'other',        label: 'Other',         icon: 'ellipsis-horizontal-outline' },
  ],
  recovery: [
    { key: 'sauna',      label: 'Sauna',      icon: 'flame-outline' },
    { key: 'ice_bath',   label: 'Ice Bath',   icon: 'snow-outline' },
    { key: 'walk',       label: 'Walk',        icon: 'walk-outline' },
    { key: 'sleep',      label: 'Sleep',       icon: 'moon-outline' },
    { key: 'meditation', label: 'Meditation',  icon: 'leaf-outline' },
    { key: 'general',    label: 'General',     icon: 'heart-outline' },
  ],
};

const INTENSITIES: { key: ActivityIntensity; label: string; icon: string; color: string }[] = [
  { key: 'easy',     label: 'Easy',     icon: 'leaf-outline',  color: '#22C55E' },
  { key: 'moderate', label: 'Moderate', icon: 'flash-outline', color: '#F59E0B' },
  { key: 'hard',     label: 'Hard',     icon: 'flame-outline', color: '#EF4444' },
];

const CARDIO_STYLES: { key: CardioStyle; label: string }[] = [
  { key: 'recovery',  label: 'Recovery' },
  { key: 'steady',    label: 'Steady State' },
  { key: 'intervals', label: 'Intervals' },
  { key: 'class',     label: 'Class / Guided' },
];

// ─── Legacy focus mapping ────────────────────────────────────────────────────

const LEGACY_FOCUS: Record<string, Record<string, string>> = {
  strength: { push: 'Push', pull: 'Pull', legs: 'Legs', upper_body: 'Upper Body', lower_body: 'Lower Body', full_body: 'Full Body' },
  cardio:   { walk: 'Walking', run: 'Running', ride: 'Cycling', spin: 'Spin Class', hike: 'Hiking', swim: 'Swimming', row: 'Rowing', stair: 'Cardio', elliptical: 'Cardio', bootcamp: 'Cardio', other: 'Cardio' },
  mobility: { yoga: 'Yoga', stretching: 'Stretching', foam_roll: 'Foam Rolling', pilates: 'Pilates' },
  sport:    { basketball: 'Cardio', soccer: 'Cardio', tennis: 'Cardio', golf: 'Cardio', climbing: 'Cardio', boxing: 'Cardio', kickboxing: 'Cardio', martial_arts: 'Cardio', other: 'Cardio' },
  recovery: { sauna: 'Recovery', ice_bath: 'Recovery', walk: 'Recovery', sleep: 'Recovery', meditation: 'Recovery', general: 'Recovery' },
};

function getLegacyFocus(category: ActivityCategory, subtype: string, custom?: string): string {
  if (custom?.trim()) return custom.trim();
  return LEGACY_FOCUS[category]?.[subtype] ?? 'General';
}

// ─── Component ───────────────────────────────────────────────────────────────

interface Props {
  visible: boolean;
  onClose: () => void;
  onSave: (session: WorkoutSession) => Promise<void>;
  themeName?: AppThemeName;
}

export default function LogActivityModal({ visible, onClose, onSave, themeName }: Props) {
  const tc = getTheme(themeName).colors;

  const [step, setStep] = useState<1 | 2>(1);
  const [category, setCategory] = useState<ActivityCategory | null>(null);
  const [subtype, setSubtype] = useState('');
  const [customSubtype, setCustomSubtype] = useState('');
  const [intensity, setIntensity] = useState<ActivityIntensity>('moderate');
  const [cardioStyle, setCardioStyle] = useState<CardioStyle | undefined>(undefined);
  const [durationMin, setDurationMin] = useState(45);
  const [dateOffset, setDateOffset] = useState(0);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [distance, setDistance] = useState('');
  const [calories, setCalories] = useState('');
  const [heartRate, setHeartRate] = useState('');

  const reset = useCallback(() => {
    setStep(1);
    setCategory(null);
    setSubtype('');
    setCustomSubtype('');
    setIntensity('moderate');
    setCardioStyle(undefined);
    setDurationMin(45);
    setDateOffset(0);
    setNotes('');
    setSaving(false);
    setShowAdvanced(false);
    setDistance('');
    setCalories('');
    setHeartRate('');
  }, []);

  const selectCategory = (cat: ActivityCategory) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setCategory(cat);
    setSubtype('');
    setCustomSubtype('');
    if (cat === 'recovery') setIntensity('easy');
    else setIntensity('moderate');
    setCardioStyle(undefined);
    setStep(2);
  };

  const goBack = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setStep(1);
  };

  const getDateForOffset = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d;
  };

  const formatDate = (offset: number) => {
    if (offset === 0) return 'Today';
    if (offset === -1) return 'Yesterday';
    const d = getDateForOffset(offset);
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  };

  const effectiveSubtype = subtype || customSubtype.trim();
  const effectiveLabel = (() => {
    if (customSubtype.trim()) return customSubtype.trim();
    if (!category || !subtype) return '';
    const def = SUBTYPES[category]?.find(s => s.key === subtype);
    return def?.label ?? subtype;
  })();

  const handleSave = async () => {
    if (!category) {
      Alert.alert('Select a category', 'Pick what type of activity this was.');
      return;
    }
    if (!effectiveSubtype) {
      Alert.alert('Select a type', 'Pick a more specific activity type.');
      return;
    }
    setSaving(true);
    try {
      const date = getDateForOffset(dateOffset);
      const legacyFocus = getLegacyFocus(category, subtype, customSubtype);
      const session: WorkoutSession = {
        id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        date: date.toISOString(),
        focus: legacyFocus,
        durationSeconds: durationMin * 60,
        exercises: [],
        completed: true,
        manualActivity: {
          category,
          subtype: effectiveSubtype,
          intensity,
          ...(category === 'cardio' && cardioStyle ? { cardioStyle } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(distance ? { distanceMiles: parseFloat(distance) } : {}),
          ...(calories ? { caloriesBurned: parseFloat(calories) } : {}),
          ...(heartRate ? { avgHeartRate: parseInt(heartRate, 10) } : {}),
        },
      };
      await onSave(session);
      reset();
      onClose();
    } catch {
      Alert.alert('Error', 'Could not save the activity. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const adjustDuration = (delta: number) => {
    setDurationMin(prev => Math.max(5, Math.min(300, prev + delta)));
  };

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={() => { reset(); onClose(); }}>
      <View style={s.overlay}>
        <View style={[s.sheet, { backgroundColor: tc.surface, borderTopColor: tc.border }]}>
          <View style={[s.handle, { backgroundColor: tc.border }]} />

          {/* Header */}
          <View style={s.header}>
            {step === 2 ? (
              <TouchableOpacity onPress={goBack} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Ionicons name="chevron-back" size={20} color={tc.primary} />
                <Text style={{ fontSize: 16, fontWeight: '600', color: tc.primary }}>
                  {CATEGORIES.find(c => c.key === category)?.label ?? 'Back'}
                </Text>
              </TouchableOpacity>
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="add-circle" size={22} color={tc.primary} />
                <Text style={[s.title, { color: tc.textPrimary }]}>Log Activity</Text>
              </View>
            )}
            <TouchableOpacity onPress={() => { reset(); onClose(); }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={tc.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

            {/* ── Step 1: Category Selection ─────────────────────────── */}
            {step === 1 && (
              <View style={s.catGrid}>
                {CATEGORIES.map(cat => (
                  <TouchableOpacity
                    key={cat.key}
                    style={[s.catCard, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}
                    onPress={() => selectCategory(cat.key)}
                    activeOpacity={0.7}>
                    <Ionicons name={cat.icon as any} size={28} color={tc.primary} />
                    <Text style={[s.catLabel, { color: tc.textPrimary }]}>{cat.label}</Text>
                    <Text style={[s.catDesc, { color: tc.textMuted }]}>{cat.desc}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* ── Step 2: Details ─────────────────────────────────────── */}
            {step === 2 && category && (
              <>
                {/* Subtype */}
                <Text style={[s.label, { color: tc.textPrimary }]}>Type</Text>
                <View style={s.chipGrid}>
                  {SUBTYPES[category].map(opt => {
                    const active = subtype === opt.key;
                    return (
                      <TouchableOpacity
                        key={opt.key}
                        style={[s.subChip, {
                          borderColor: active ? tc.primary : tc.border,
                          backgroundColor: active ? tc.primary + '18' : tc.surfaceRaised,
                        }]}
                        onPress={() => { setSubtype(active ? '' : opt.key); setCustomSubtype(''); }}>
                        <Ionicons name={opt.icon as any} size={16} color={active ? tc.primary : tc.textMuted} />
                        <Text style={{ fontSize: 13, fontWeight: '600', color: active ? tc.primary : tc.textPrimary }}>{opt.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <TextInput
                  style={[s.input, { backgroundColor: tc.surfaceRaised, borderColor: tc.border, color: tc.textPrimary }]}
                  placeholder="Or describe your own"
                  placeholderTextColor={tc.textMuted}
                  value={customSubtype}
                  onChangeText={t => { setCustomSubtype(t); if (t.trim()) setSubtype(''); }}
                  returnKeyType="done"
                />

                {/* Intensity */}
                {category !== 'recovery' && (
                  <>
                    <Text style={[s.label, { color: tc.textPrimary, marginTop: 16 }]}>Intensity</Text>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      {INTENSITIES.map(opt => {
                        const active = intensity === opt.key;
                        return (
                          <TouchableOpacity
                            key={opt.key}
                            style={[s.intensityBtn, {
                              flex: 1,
                              borderColor: active ? opt.color : tc.border,
                              backgroundColor: active ? opt.color + '18' : tc.surfaceRaised,
                            }]}
                            onPress={() => setIntensity(opt.key)}>
                            <Ionicons name={opt.icon as any} size={18} color={active ? opt.color : tc.textMuted} />
                            <Text style={{ fontSize: 13, fontWeight: '700', color: active ? opt.color : tc.textSecondary }}>{opt.label}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </>
                )}

                {/* Cardio Style */}
                {category === 'cardio' && (
                  <>
                    <Text style={[s.label, { color: tc.textPrimary, marginTop: 16 }]}>Style</Text>
                    <View style={s.chipRow}>
                      {CARDIO_STYLES.map(opt => {
                        const active = cardioStyle === opt.key;
                        return (
                          <TouchableOpacity
                            key={opt.key}
                            style={[s.chip, { borderColor: active ? tc.primary : tc.border, backgroundColor: active ? tc.primary + '18' : tc.surfaceRaised }]}
                            onPress={() => setCardioStyle(active ? undefined : opt.key)}>
                            <Text style={{ fontSize: 12, fontWeight: '600', color: active ? tc.primary : tc.textSecondary }}>{opt.label}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </>
                )}

                {/* Duration */}
                <Text style={[s.label, { color: tc.textPrimary, marginTop: 16 }]}>Duration</Text>
                <View style={s.durationRow}>
                  <TouchableOpacity
                    style={[s.durationBtn, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}
                    onPress={() => adjustDuration(-5)}>
                    <Ionicons name="remove" size={20} color={tc.textPrimary} />
                  </TouchableOpacity>
                  <View style={[s.durationDisplay, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}>
                    <TextInput
                      style={{ fontSize: 20, fontWeight: '800', color: tc.textPrimary, textAlign: 'center', minWidth: 50 }}
                      value={String(durationMin)}
                      onChangeText={t => {
                        const n = parseInt(t, 10);
                        if (!isNaN(n) && n >= 0 && n <= 300) setDurationMin(n);
                        else if (t === '') setDurationMin(0);
                      }}
                      keyboardType="number-pad"
                      selectTextOnFocus
                    />
                    <Text style={{ fontSize: 12, color: tc.textMuted, fontWeight: '600' }}>min</Text>
                  </View>
                  <TouchableOpacity
                    style={[s.durationBtn, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}
                    onPress={() => adjustDuration(5)}>
                    <Ionicons name="add" size={20} color={tc.textPrimary} />
                  </TouchableOpacity>
                </View>

                {/* Date */}
                <Text style={[s.label, { color: tc.textPrimary, marginTop: 16 }]}>When</Text>
                <View style={s.chipRow}>
                  {[0, -1, -2, -3].map(offset => {
                    const active = dateOffset === offset;
                    return (
                      <TouchableOpacity
                        key={offset}
                        style={[s.chip, { borderColor: active ? tc.primary : tc.border, backgroundColor: active ? tc.primary + '18' : tc.surfaceRaised }]}
                        onPress={() => setDateOffset(offset)}>
                        <Text style={{ fontSize: 12, fontWeight: '600', color: active ? tc.primary : tc.textSecondary }}>{formatDate(offset)}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {/* Notes */}
                <Text style={[s.label, { color: tc.textPrimary, marginTop: 16 }]}>Notes</Text>
                <TextInput
                  style={[s.input, s.notesInput, { backgroundColor: tc.surfaceRaised, borderColor: tc.border, color: tc.textPrimary }]}
                  placeholder="Optional — how it felt, what you did"
                  placeholderTextColor={tc.textMuted}
                  value={notes}
                  onChangeText={setNotes}
                  multiline
                  numberOfLines={2}
                />

                {/* Advanced toggle */}
                <TouchableOpacity
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12, alignSelf: 'flex-start' }}
                  onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setShowAdvanced(!showAdvanced); }}>
                  <Ionicons name={showAdvanced ? 'chevron-up' : 'chevron-down'} size={16} color={tc.textMuted} />
                  <Text style={{ fontSize: 12, fontWeight: '600', color: tc.textMuted }}>Advanced details</Text>
                </TouchableOpacity>

                {showAdvanced && (
                  <View style={{ gap: 10, marginTop: 10 }}>
                    {category === 'cardio' && (
                      <View style={s.advRow}>
                        <Text style={[s.advLabel, { color: tc.textSecondary }]}>Distance (mi)</Text>
                        <TextInput
                          style={[s.advInput, { backgroundColor: tc.surfaceRaised, borderColor: tc.border, color: tc.textPrimary }]}
                          value={distance} onChangeText={setDistance} keyboardType="decimal-pad" placeholder="—" placeholderTextColor={tc.textMuted}
                        />
                      </View>
                    )}
                    <View style={s.advRow}>
                      <Text style={[s.advLabel, { color: tc.textSecondary }]}>Calories burned</Text>
                      <TextInput
                        style={[s.advInput, { backgroundColor: tc.surfaceRaised, borderColor: tc.border, color: tc.textPrimary }]}
                        value={calories} onChangeText={setCalories} keyboardType="number-pad" placeholder="—" placeholderTextColor={tc.textMuted}
                      />
                    </View>
                    <View style={s.advRow}>
                      <Text style={[s.advLabel, { color: tc.textSecondary }]}>Avg heart rate</Text>
                      <TextInput
                        style={[s.advInput, { backgroundColor: tc.surfaceRaised, borderColor: tc.border, color: tc.textPrimary }]}
                        value={heartRate} onChangeText={setHeartRate} keyboardType="number-pad" placeholder="—" placeholderTextColor={tc.textMuted}
                      />
                    </View>
                  </View>
                )}

                {/* Save */}
                <PressableScale
                  style={{ marginTop: 20, marginBottom: 30 }}
                  onPress={handleSave}
                  disabled={saving || !effectiveSubtype}>
                  <View style={[s.saveBtn, { backgroundColor: (!effectiveSubtype) ? tc.textMuted : tc.primary }]}>
                    {saving ? (
                      <Text style={s.saveBtnText}>Saving...</Text>
                    ) : (
                      <>
                        <Ionicons name="checkmark-circle" size={20} color="#fff" />
                        <Text style={s.saveBtnText}>
                          Log {effectiveLabel || '...'} · {durationMin} min · {formatDate(dateOffset)}
                        </Text>
                      </>
                    )}
                  </View>
                </PressableScale>
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '92%', borderTopWidth: 1 },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 10 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 14, paddingBottom: 10 },
  title: { fontSize: 18, fontWeight: '700' },
  content: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 20 },
  label: { fontSize: 14, fontWeight: '700', marginBottom: 8 },

  // Step 1: Category cards
  catGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center', paddingTop: 8, paddingBottom: 20 },
  catCard: { width: '47%', borderRadius: 14, borderWidth: 1, padding: 16, alignItems: 'center', gap: 6 },
  catLabel: { fontSize: 15, fontWeight: '700' },
  catDesc: { fontSize: 11, textAlign: 'center' },

  // Step 2: Chips
  chipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  subChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, borderWidth: 1 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, borderWidth: 1 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, marginTop: 8 },
  notesInput: { minHeight: 50, textAlignVertical: 'top' },

  // Intensity
  intensityBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 10, borderWidth: 1.5 },

  // Duration stepper
  durationRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12 },
  durationBtn: { width: 44, height: 44, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  durationDisplay: { flexDirection: 'row', alignItems: 'baseline', gap: 4, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 12, borderWidth: 1 },

  // Advanced
  advRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  advLabel: { fontSize: 13, fontWeight: '600' },
  advInput: { width: 90, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, fontSize: 14, textAlign: 'center' },

  // Save
  saveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 16, borderRadius: 12, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.2, shadowRadius: 6, elevation: 3 },
  saveBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
