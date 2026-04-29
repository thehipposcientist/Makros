import { useState } from 'react';
import {
  View, Text, Modal, ScrollView, TouchableOpacity,
  TextInput, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { submitWeeklyCheckin } from '../services/api';

interface Props {
  visible: boolean;
  authToken: string;
  currentWeight?: number;
  themeName?: AppThemeName;
  onClose: () => void;
  onSaved?: () => void;
}

interface MeasurementFields {
  waist: string;
  chest: string;
  hips: string;
  bicep: string;
  thigh: string;
  calf: string;
  bodyFat: string;
}

const EMPTY: MeasurementFields = {
  waist: '', chest: '', hips: '',
  bicep: '', thigh: '', calf: '', bodyFat: '',
};

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
  const [fields, setFields] = useState<MeasurementFields>(EMPTY);
  const [saving, setSaving] = useState(false);

  const set = (key: keyof MeasurementFields, val: string) =>
    setFields(f => ({ ...f, [key]: val }));

  const handleSave = async () => {
    setSaving(true);
    try {
      const parse = (v: string) => { const n = parseFloat(v); return isNaN(n) ? undefined : n; };
      await submitWeeklyCheckin(authToken, {
        checkin_date: new Date().toISOString().slice(0, 10),
        weight_lbs: currentWeight ?? 0,
        waist_in: parse(fields.waist),
        chest_in: parse(fields.chest),
        hips_in: parse(fields.hips),
        bicep_in: parse(fields.bicep),
        thigh_in: parse(fields.thigh),
        calf_in: parse(fields.calf),
        body_fat_pct: parse(fields.bodyFat),
        energy: 3,
        sleep: 3,
        adherence: 3,
      });
      setFields(EMPTY);
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
                <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>{saving ? 'Saving…' : 'Save'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
