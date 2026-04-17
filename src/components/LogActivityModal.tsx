/**
 * LogActivityModal — manual workout/activity logging.
 * Records date, focus, duration, and optional exercise details.
 * Saves to local history + backend so it appears in calendar,
 * history list, and planner rotation.
 */
import { useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, TextInput, ScrollView,
  StyleSheet, Alert, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName, WorkoutSession } from '../types';
import PressableScale from './PressableScale';

const FOCUS_OPTIONS = [
  { label: 'Push', icon: 'arrow-up-outline' },
  { label: 'Pull', icon: 'arrow-down-outline' },
  { label: 'Legs', icon: 'footsteps-outline' },
  { label: 'Upper Body', icon: 'body-outline' },
  { label: 'Lower Body', icon: 'fitness-outline' },
  { label: 'Full Body', icon: 'expand-outline' },
  { label: 'Chest', icon: 'shield-outline' },
  { label: 'Back', icon: 'layers-outline' },
  { label: 'Shoulders', icon: 'triangle-outline' },
  { label: 'Arms', icon: 'flash-outline' },
  { label: 'Cardio', icon: 'heart-outline' },
  { label: 'Recovery', icon: 'leaf-outline' },
] as const;

const DURATION_PRESETS = [30, 45, 60, 75, 90, 120];

interface Props {
  visible: boolean;
  onClose: () => void;
  onSave: (session: WorkoutSession) => Promise<void>;
  themeName?: AppThemeName;
}

export default function LogActivityModal({ visible, onClose, onSave, themeName }: Props) {
  const tc = getTheme(themeName).colors;
  const [focus, setFocus] = useState('');
  const [customFocus, setCustomFocus] = useState('');
  const [durationMin, setDurationMin] = useState(60);
  const [dateOffset, setDateOffset] = useState(0); // 0=today, -1=yesterday, etc
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const effectiveFocus = focus || customFocus.trim() || 'General';

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

  const handleSave = async () => {
    if (!effectiveFocus || effectiveFocus === 'General' && !customFocus.trim() && !focus) {
      Alert.alert('Select a focus', 'Pick what type of workout this was.');
      return;
    }
    setSaving(true);
    try {
      const date = getDateForOffset(dateOffset);
      const session: WorkoutSession = {
        id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        date: date.toISOString(),
        focus: effectiveFocus,
        durationSeconds: durationMin * 60,
        exercises: [],
        completed: true,
      };
      await onSave(session);
      // Reset form
      setFocus('');
      setCustomFocus('');
      setDurationMin(60);
      setDateOffset(0);
      setNotes('');
      onClose();
    } catch {
      Alert.alert('Error', 'Could not save the activity. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={[styles.overlay]}>
        <View style={[styles.sheet, { backgroundColor: tc.surface, borderTopColor: tc.border }]}>
          <View style={[styles.handle, { backgroundColor: tc.border }]} />

          {/* Header */}
          <View style={styles.header}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name="add-circle" size={22} color={tc.primary} />
              <Text style={[styles.title, { color: tc.textPrimary }]}>Log Activity</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={tc.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

            {/* Date picker */}
            <Text style={[styles.label, { color: tc.textPrimary }]}>When</Text>
            <View style={styles.chipRow}>
              {[0, -1, -2, -3].map(offset => {
                const active = dateOffset === offset;
                return (
                  <TouchableOpacity
                    key={offset}
                    style={[styles.chip, { borderColor: active ? tc.primary : tc.border, backgroundColor: active ? tc.primary + '18' : tc.surfaceRaised }]}
                    onPress={() => setDateOffset(offset)}>
                    <Text style={[styles.chipText, { color: active ? tc.primary : tc.textSecondary }]}>{formatDate(offset)}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Focus picker */}
            <Text style={[styles.label, { color: tc.textPrimary, marginTop: 16 }]}>What did you do?</Text>
            <View style={styles.focusGrid}>
              {FOCUS_OPTIONS.map(opt => {
                const active = focus === opt.label;
                return (
                  <TouchableOpacity
                    key={opt.label}
                    style={[styles.focusChip, { borderColor: active ? tc.primary : tc.border, backgroundColor: active ? tc.primary + '18' : tc.surfaceRaised }]}
                    onPress={() => { setFocus(active ? '' : opt.label); setCustomFocus(''); }}>
                    <Ionicons name={opt.icon as any} size={18} color={active ? tc.primary : tc.textMuted} />
                    <Text style={[styles.focusChipText, { color: active ? tc.primary : tc.textPrimary }]}>{opt.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <TextInput
              style={[styles.input, { backgroundColor: tc.surfaceRaised, borderColor: tc.border, color: tc.textPrimary }]}
              placeholder="Or type custom (e.g. Hiking, Yoga, Swimming)"
              placeholderTextColor={tc.textMuted}
              value={customFocus}
              onChangeText={t => { setCustomFocus(t); if (t.trim()) setFocus(''); }}
              returnKeyType="done"
            />

            {/* Duration */}
            <Text style={[styles.label, { color: tc.textPrimary, marginTop: 16 }]}>Duration</Text>
            <View style={styles.chipRow}>
              {DURATION_PRESETS.map(min => {
                const active = durationMin === min;
                return (
                  <TouchableOpacity
                    key={min}
                    style={[styles.chip, { borderColor: active ? tc.primary : tc.border, backgroundColor: active ? tc.primary + '18' : tc.surfaceRaised }]}
                    onPress={() => setDurationMin(min)}>
                    <Text style={[styles.chipText, { color: active ? tc.primary : tc.textSecondary }]}>{min} min</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Notes */}
            <Text style={[styles.label, { color: tc.textPrimary, marginTop: 16 }]}>Notes (optional)</Text>
            <TextInput
              style={[styles.input, styles.notesInput, { backgroundColor: tc.surfaceRaised, borderColor: tc.border, color: tc.textPrimary }]}
              placeholder="e.g. Felt strong, tried new squat variation"
              placeholderTextColor={tc.textMuted}
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={2}
            />

            {/* Save button */}
            <PressableScale
              style={{ marginTop: 20, marginBottom: 30 }}
              onPress={handleSave}
              disabled={saving}>
              <View style={[styles.saveBtn, { backgroundColor: tc.primary }]}>
                {saving ? (
                  <Text style={styles.saveBtnText}>Saving...</Text>
                ) : (
                  <>
                    <Ionicons name="checkmark-circle" size={20} color="#fff" />
                    <Text style={styles.saveBtnText}>Log {effectiveFocus} · {durationMin} min · {formatDate(dateOffset)}</Text>
                  </>
                )}
              </View>
            </PressableScale>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '90%', borderTopWidth: 1 },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 10 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 14, paddingBottom: 10 },
  title: { fontSize: 18, fontWeight: '700' },
  content: { paddingHorizontal: 20, paddingTop: 8 },
  label: { fontSize: 14, fontWeight: '700', marginBottom: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, borderWidth: 1 },
  chipText: { fontSize: 13, fontWeight: '600' },
  focusGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  focusChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1 },
  focusChipText: { fontSize: 13, fontWeight: '600' },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, marginTop: 8 },
  notesInput: { minHeight: 60, textAlignVertical: 'top' },
  saveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 16, borderRadius: 12, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.2, shadowRadius: 6, elevation: 3 },
  saveBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
