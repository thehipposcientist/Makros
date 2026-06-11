/**
 * SetEntryModal — popup weight + reps entry for inline set rows in
 * ActiveWorkoutScreen. Opens when the user taps a row's weight or reps
 * cell. Replaces the cramped per-row TextInputs with a focused modal
 * that has steppers, free-form numeric input, and a single Log action.
 *
 * Caller stays responsible for committing the values via the existing
 * handleLogSetInline path; we just return the edited weight + reps.
 */
import React, { useEffect, useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, StyleSheet, Platform, KeyboardAvoidingView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, getContrastingTextColor, radius } from '../constants/theme';
import type { AppThemeName } from '../types';

interface Props {
  visible: boolean;
  themeName?: AppThemeName;
  /** Title eyebrow (e.g. "BENCH PRESS — SET 3"). */
  exerciseName: string;
  setNumber: number;
  /** Suffix shown on the weight input (e.g. "lb", "kg", "lb each"). */
  weightSuffix?: string;
  showWeight?: boolean;
  showReps?: boolean;
  /** Current text values. */
  initialWeight: string;
  initialReps: string;
  /** Greyed placeholder text used when the user hasn't typed anything. */
  fallbackWeight?: string;
  fallbackReps?: string;
  countLabel?: string;
  /** Increments for the ± buttons in the user's chosen unit. */
  weightStep?: number;
  largeWeightStep?: number;
  /** When provided, opens a secondary action (e.g. plate calculator). */
  onOpenPlateCalc?: (currentWeight: string) => void;
  onClose: () => void;
  /** Called when the user taps the primary log button. */
  onLog: (weight: string, reps: string) => void;
}

function clampNumeric(text: string, allowDecimal: boolean): string {
  if (!text) return '';
  const filtered = allowDecimal
    ? text.replace(/[^0-9.]/g, '')
    : text.replace(/[^0-9]/g, '');
  // Allow at most one decimal point.
  if (allowDecimal) {
    const firstDot = filtered.indexOf('.');
    if (firstDot >= 0) {
      return filtered.slice(0, firstDot + 1) + filtered.slice(firstDot + 1).replace(/\./g, '');
    }
  }
  return filtered;
}

function bumpNumeric(text: string, delta: number, allowDecimal: boolean, min: number = 0): string {
  const current = parseFloat(text || '0') || 0;
  const next = Math.max(min, current + delta);
  if (allowDecimal) {
    const rounded = Math.round(next * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : String(rounded);
  }
  return String(Math.round(next));
}

export default function SetEntryModal({
  visible,
  themeName,
  exerciseName,
  setNumber,
  weightSuffix = 'lb',
  showWeight = true,
  showReps = true,
  initialWeight,
  initialReps,
  fallbackWeight,
  fallbackReps,
  countLabel = 'Reps',
  weightStep = 5,
  largeWeightStep = 10,
  onOpenPlateCalc,
  onClose,
  onLog,
}: Props) {
  const colors = getTheme(themeName).colors;
  const [weight, setWeight] = useState(initialWeight);
  const [reps, setReps] = useState(initialReps);

  // Re-seed when the modal opens for a different row.
  useEffect(() => {
    if (visible) {
      setWeight(initialWeight);
      setReps(initialReps);
    }
  }, [visible, initialWeight, initialReps]);

  const handleLog = () => {
    onLog(weight, reps);
    onClose();
  };

  const effectiveWeightText = weight || fallbackWeight || '';
  const effectiveRepsText = reps || fallbackReps || '';
  const hasAny = (effectiveWeightText && effectiveWeightText !== '0') || (effectiveRepsText && effectiveRepsText !== '0');

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity activeOpacity={1} style={StyleSheet.absoluteFill} onPress={onClose} />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          pointerEvents="box-none"
          style={styles.wrap}>
          <View
            testID="set-entry-modal"
            accessibilityLabel="set-entry-modal"
            style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={styles.header}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[styles.eyebrow, { color: colors.textMuted }]} numberOfLines={1}>
                  {exerciseName.toUpperCase()} · SET {setNumber}
                </Text>
                <Text style={[styles.title, { color: colors.textPrimary }]}>
                  Log set
                </Text>
              </View>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close" size={20} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            {showWeight && (
              <View style={styles.block}>
                <View style={styles.labelRow}>
                  <Text style={[styles.label, { color: colors.textMuted }]}>
                    Weight ({weightSuffix})
                  </Text>
                  {onOpenPlateCalc && (
                    <TouchableOpacity
                      onPress={() => onOpenPlateCalc(weight || fallbackWeight || '')}
                      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                      style={[styles.helperChip, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
                      <Ionicons name="calculator-outline" size={12} color={colors.textSecondary} />
                      <Text style={[styles.helperChipText, { color: colors.textSecondary }]}>Plates</Text>
                    </TouchableOpacity>
                  )}
                </View>
                <View style={styles.stepperRow}>
                  <TouchableOpacity
                    style={[styles.stepBtn, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}
                    onPress={() => setWeight(prev => bumpNumeric(prev || fallbackWeight || '0', -largeWeightStep, true))}
                    accessibilityLabel={`Decrease weight by ${largeWeightStep}`}>
                    <Text style={[styles.stepBtnText, { color: colors.textPrimary }]}>-{largeWeightStep}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.stepBtn, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}
                    onPress={() => setWeight(prev => bumpNumeric(prev || fallbackWeight || '0', -weightStep, true))}
                    accessibilityLabel={`Decrease weight by ${weightStep}`}>
                    <Ionicons name="remove" size={18} color={colors.textPrimary} />
                  </TouchableOpacity>
                  <TextInput
                    testID="set-entry-weight-input"
                    accessibilityLabel="set-entry-weight-input"
                    style={[styles.valueInput, {
                      borderColor: colors.primary + '66',
                      backgroundColor: colors.surfaceRaised,
                      color: colors.textPrimary,
                    }]}
                    value={weight}
                    onChangeText={t => setWeight(clampNumeric(t, true))}
                    placeholder={fallbackWeight || '0'}
                    placeholderTextColor={colors.textMuted}
                    keyboardType="decimal-pad"
                    selectTextOnFocus
                  />
                  <TouchableOpacity
                    style={[styles.stepBtn, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}
                    onPress={() => setWeight(prev => bumpNumeric(prev || fallbackWeight || '0', weightStep, true))}
                    accessibilityLabel={`Increase weight by ${weightStep}`}>
                    <Ionicons name="add" size={18} color={colors.textPrimary} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.stepBtn, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}
                    onPress={() => setWeight(prev => bumpNumeric(prev || fallbackWeight || '0', largeWeightStep, true))}
                    accessibilityLabel={`Increase weight by ${largeWeightStep}`}>
                    <Text style={[styles.stepBtnText, { color: colors.textPrimary }]}>+{largeWeightStep}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {showReps && (
              <View style={styles.block}>
                <View style={styles.labelRow}>
                  <Text style={[styles.label, { color: colors.textMuted }]}>{countLabel}</Text>
                </View>
                <View style={styles.stepperRow}>
                  <TouchableOpacity
                    style={[styles.stepBtn, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}
                    onPress={() => setReps(prev => bumpNumeric(prev || fallbackReps || '0', -1, false, 0))}
                    accessibilityLabel={`Decrease ${countLabel.toLowerCase()}`}>
                    <Ionicons name="remove" size={18} color={colors.textPrimary} />
                  </TouchableOpacity>
                  <TextInput
                    testID="set-entry-reps-input"
                    accessibilityLabel="set-entry-reps-input"
                    style={[styles.valueInput, {
                      borderColor: colors.primary + '66',
                      backgroundColor: colors.surfaceRaised,
                      color: colors.textPrimary,
                    }]}
                    value={reps}
                    onChangeText={t => setReps(clampNumeric(t, false))}
                    placeholder={fallbackReps || '0'}
                    placeholderTextColor={colors.textMuted}
                    keyboardType="number-pad"
                    selectTextOnFocus
                  />
                  <TouchableOpacity
                    style={[styles.stepBtn, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}
                    onPress={() => setReps(prev => bumpNumeric(prev || fallbackReps || '0', 1, false, 0))}
                    accessibilityLabel={`Increase ${countLabel.toLowerCase()}`}>
                    <Ionicons name="add" size={18} color={colors.textPrimary} />
                  </TouchableOpacity>
                </View>
              </View>
            )}

            <TouchableOpacity
              testID="set-entry-log"
              accessibilityLabel="set-entry-log"
              style={[styles.logBtn, { backgroundColor: colors.primary, opacity: hasAny ? 1 : 0.55 }]}
              disabled={!hasAny}
              onPress={handleLog}>
              <Ionicons name="checkmark-circle" size={18} color={getContrastingTextColor(colors.primary)} />
              <Text style={[styles.logBtnText, { color: getContrastingTextColor(colors.primary) }]}>
                Log set
              </Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: 18 },
  wrap: { width: '100%', maxWidth: 420 },
  sheet: { borderWidth: 1, borderRadius: radius.lg, padding: 16 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  eyebrow: { fontSize: 10, fontWeight: '900', letterSpacing: 0.4 },
  title: { fontSize: 18, fontWeight: '900', marginTop: 2 },
  block: { marginBottom: 14 },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  label: { fontSize: 11, fontWeight: '900', letterSpacing: 0.3, textTransform: 'uppercase' },
  helperChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  helperChipText: { fontSize: 10, fontWeight: '900' },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepBtn: {
    minWidth: 40,
    height: 44,
    paddingHorizontal: 8,
    borderRadius: radius.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnText: { fontSize: 12, fontWeight: '900' },
  valueInput: {
    flex: 1,
    minWidth: 0,
    height: 48,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    fontSize: 22,
    fontWeight: '900',
    textAlign: 'center',
    paddingHorizontal: 6,
  },
  logBtn: {
    minHeight: 48,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  logBtnText: { fontSize: 14, fontWeight: '900' },
});
