import { useState } from 'react';
import {
  View, Text, Modal, ScrollView, TouchableOpacity,
  TextInput, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { submitWeeklyCheckin } from '../services/api';
import {
  buildBodyMeasurementsCheckinPayload,
  EMPTY_MEASUREMENT_FIELDS,
} from '../utils/bodyMeasurements';
import type { MeasurementFields } from '../utils/bodyMeasurements';

interface Props {
  visible: boolean;
  authToken: string;
  currentWeight?: number;
  themeName?: AppThemeName;
  onClose: () => void;
  onSaved?: () => void;
}

const FIELDS: Array<{ key: keyof MeasurementFields; label: string; unit: string }> = [
  { key: 'waist',   label: 'Waist',     unit: 'in' },
  { key: 'chest',   label: 'Chest',     unit: 'in' },
  { key: 'hips',    label: 'Hips',      unit: 'in' },
  { key: 'bicep',   label: 'Bicep',     unit: 'in' },
  { key: 'thigh',   label: 'Thigh',     unit: 'in' },
  { key: 'calf',    label: 'Calf',      unit: 'in' },
  { key: 'bodyFat', label: 'Body fat',  unit: '%'  },
];

export default function BodyMeasurementsModal({ visible, authToken, currentWeight, themeName, onClose, onSaved }: Props) {
  const tc = getTheme(themeName).colors;
  const [fields, setFields] = useState<MeasurementFields>(EMPTY_MEASUREMENT_FIELDS);
  const [saving, setSaving] = useState(false);

  const set = (key: keyof MeasurementFields, val: string) =>
    setFields(f => ({ ...f, [key]: val }));

  const handleSave = async () => {
    const payload = buildBodyMeasurementsCheckinPayload({ currentWeight, fields });
    if (!payload) {
      Alert.alert('Weight required', 'Update your Body weight before saving measurements.');
      return;
    }
    setSaving(true);
    try {
      await submitWeeklyCheckin(authToken, payload);
      setFields(EMPTY_MEASUREMENT_FIELDS);
      onSaved?.();
      onClose();
    } catch {
      Alert.alert('Error', 'Could not save measurements. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}>
          <View style={{
            backgroundColor: tc.surface,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            paddingBottom: 32,
            maxHeight: '90%',
          }}>
            {/* Header */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 20, paddingBottom: 12 }}>
              <Text style={{ fontSize: 18, fontWeight: '700', color: tc.textPrimary }}>Body Measurements</Text>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={tc.textMuted} />
              </TouchableOpacity>
            </View>
            <Text style={{ fontSize: 13, color: tc.textMuted, paddingHorizontal: 20, marginBottom: 16 }}>
              Log your measurements to track body composition over time. All fields are optional.
            </Text>

            <ScrollView style={{ paddingHorizontal: 20 }} keyboardShouldPersistTaps="handled">
              {FIELDS.map(({ key, label, unit }) => (
                <View key={key} style={{ marginBottom: 14 }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: tc.textSecondary, marginBottom: 6 }}>{label}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <TextInput
                      style={{
                        flex: 1,
                        borderWidth: 1,
                        borderColor: tc.border,
                        borderRadius: radius.md,
                        padding: 12,
                        fontSize: 16,
                        color: tc.textPrimary,
                        backgroundColor: tc.background,
                        fontWeight: '600',
                      }}
                      value={fields[key]}
                      onChangeText={v => set(key, v)}
                      keyboardType="decimal-pad"
                      placeholder="Optional"
                      placeholderTextColor={tc.textMuted}
                    />
                    <Text style={{ fontSize: 14, color: tc.textMuted, minWidth: 24 }}>{unit}</Text>
                  </View>
                </View>
              ))}
              <View style={{ height: 16 }} />
            </ScrollView>

            <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 20, paddingTop: 12 }}>
              <TouchableOpacity
                style={{ flex: 1, paddingVertical: 14, borderRadius: radius.md, backgroundColor: tc.surfaceRaised, alignItems: 'center', borderWidth: 1, borderColor: tc.border }}
                onPress={onClose}>
                <Text style={{ fontSize: 15, fontWeight: '600', color: tc.textSecondary }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{ flex: 1, paddingVertical: 14, borderRadius: radius.md, backgroundColor: saving ? tc.primary + '80' : tc.primary, alignItems: 'center' }}
                onPress={handleSave}
                disabled={saving}>
                <Text style={{ fontSize: 15, fontWeight: '700', color: getContrastingTextColor(tc.primary) }}>{saving ? 'Saving…' : 'Save'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
