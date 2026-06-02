/**
 * PlateCalculatorModal — given a target barbell weight in the user's
 * unit, compute the greedy per-side plate breakdown using standard gym
 * plates. Surfaced from the weight input on barbell exercises.
 *
 * The math is deterministic: start from the largest plate, count how
 * many pairs fit, subtract, repeat. Unrepresentable remainders show as
 * a residual so users see "close, but you can't make exactly this."
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, getContrastingTextColor, radius } from '../constants/theme';
import type { AppThemeName } from '../types';

type WeightUnit = 'lbs' | 'kg';

interface Props {
  visible: boolean;
  /** Current weight in lbs (canonical). Display is converted per unit. */
  weightLbs: number;
  unit: WeightUnit;
  /** Optional default bar weight in the same unit as `unit`.
   *  Defaults: 45 lb / 20 kg. */
  barWeightInUnit?: number;
  themeName?: AppThemeName;
  onClose: () => void;
  /** When set, surfaces an "Apply" button that calls back with the
   *  total weight in lbs so the caller can write it into the input. */
  onApply?: (newWeightLbs: number) => void;
}

const PLATES_LBS = [45, 35, 25, 10, 5, 2.5];
const PLATES_KG = [25, 20, 15, 10, 5, 2.5, 1.25];

const LBS_PER_KG = 2.2046226218;

function lbsToUnit(lbs: number, unit: WeightUnit): number {
  if (unit === 'kg') return lbs / LBS_PER_KG;
  return lbs;
}

function unitToLbs(value: number, unit: WeightUnit): number {
  if (unit === 'kg') return value * LBS_PER_KG;
  return value;
}

interface PlateBreakdown {
  perSide: Array<{ weight: number; count: number }>;
  loadedTotal: number;
  residual: number;
}

function computePlates(totalWeight: number, barWeight: number, plates: number[]): PlateBreakdown {
  const loadable = Math.max(0, totalWeight - barWeight);
  const perSideTarget = loadable / 2;
  let remaining = perSideTarget;
  const perSide: Array<{ weight: number; count: number }> = [];
  for (const p of plates) {
    if (remaining < p - 0.001) continue;
    const count = Math.floor((remaining + 0.001) / p);
    if (count > 0) {
      perSide.push({ weight: p, count });
      remaining -= count * p;
    }
  }
  const loadedPerSide = perSide.reduce((s, p) => s + p.weight * p.count, 0);
  const loadedTotal = barWeight + loadedPerSide * 2;
  return {
    perSide,
    loadedTotal,
    residual: Math.max(0, perSideTarget - loadedPerSide) * 2,
  };
}

export default function PlateCalculatorModal({
  visible,
  weightLbs,
  unit,
  barWeightInUnit,
  themeName,
  onClose,
  onApply,
}: Props) {
  const colors = getTheme(themeName).colors;
  const defaultBar = unit === 'kg' ? 20 : 45;
  const [barWeight, setBarWeight] = useState<number>(barWeightInUnit ?? defaultBar);
  // Live-editable target weight in the user's unit. Seed from the
  // caller, then the user can dial it with +/- so the modal works
  // even when no weight is typed in the row yet.
  const [targetWeight, setTargetWeight] = useState<number>(() => lbsToUnit(weightLbs, unit));
  // Reseed whenever the modal opens for a new set/weight.
  useEffect(() => {
    if (visible) setTargetWeight(lbsToUnit(weightLbs, unit));
  }, [visible, weightLbs, unit]);

  const plates = unit === 'kg' ? PLATES_KG : PLATES_LBS;
  // Smallest available plate adds 2× its weight to the bar total.
  const minPairStep = plates[plates.length - 1] * 2;
  const adjustTarget = (delta: number) => {
    setTargetWeight(prev => Math.max(barWeight, Math.round((prev + delta) * 100) / 100));
  };

  const breakdown = useMemo(
    () => computePlates(targetWeight, barWeight, plates),
    [targetWeight, barWeight, plates],
  );
  const exactInUnit = breakdown.residual < 0.0001;
  const loadedLbs = useMemo(() => unitToLbs(breakdown.loadedTotal, unit), [breakdown.loadedTotal, unit]);
  const unitLabel = unit === 'kg' ? 'kg' : 'lb';

  const barOptions = unit === 'kg' ? [20, 15, 10] : [45, 35, 25, 15];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.eyebrow, { color: colors.textMuted }]}>PLATE CALCULATOR</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 2 }}>
                <TouchableOpacity
                  accessibilityLabel="Decrease target weight"
                  onPress={() => adjustTarget(-minPairStep)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={[styles.stepBtn, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
                  <Ionicons name="remove" size={18} color={colors.textPrimary} />
                </TouchableOpacity>
                <Text style={[styles.title, { color: colors.textPrimary, minWidth: 92, textAlign: 'center' }]}>
                  {targetWeight.toFixed(1).replace(/\.0$/, '')} {unitLabel}
                </Text>
                <TouchableOpacity
                  accessibilityLabel="Increase target weight"
                  onPress={() => adjustTarget(minPairStep)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={[styles.stepBtn, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
                  <Ionicons name="add" size={18} color={colors.textPrimary} />
                </TouchableOpacity>
              </View>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <Text style={[styles.sectionLabel, { color: colors.textMuted }]}>BAR WEIGHT</Text>
          <View style={styles.row}>
            {barOptions.map(b => {
              const active = Math.abs(b - barWeight) < 0.01;
              return (
                <TouchableOpacity
                  key={b}
                  onPress={() => setBarWeight(b)}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: active ? colors.primary : colors.surfaceRaised,
                      borderColor: active ? colors.primary : colors.border,
                    },
                  ]}>
                  <Text style={[styles.chipText, { color: active ? getContrastingTextColor(colors.primary) : colors.textSecondary }]}>
                    {b} {unitLabel}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={[styles.sectionLabel, { color: colors.textMuted, marginTop: 14 }]}>PER SIDE</Text>
          {breakdown.perSide.length === 0 ? (
            <Text style={[styles.bodyText, { color: colors.textSecondary }]}>
              {targetWeight <= barWeight
                ? 'Bar only — target is at or below bar weight.'
                : 'Cannot load this weight with standard plates.'}
            </Text>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 4 }}>
              {breakdown.perSide.map(p => (
                <View
                  key={p.weight}
                  style={[
                    styles.plateChip,
                    { borderColor: colors.border, backgroundColor: colors.surfaceRaised },
                  ]}>
                  <Text style={[styles.plateCount, { color: colors.primary }]}>{p.count}×</Text>
                  <Text style={[styles.plateWeight, { color: colors.textPrimary }]}>
                    {p.weight} {unitLabel}
                  </Text>
                </View>
              ))}
            </ScrollView>
          )}

          <View style={[styles.totalRow, { borderColor: colors.border }]}>
            <Text style={[styles.totalLabel, { color: colors.textMuted }]}>LOADED TOTAL</Text>
            <Text style={[styles.totalValue, { color: exactInUnit ? colors.textPrimary : colors.warning ?? colors.textPrimary }]}>
              {breakdown.loadedTotal.toFixed(1).replace(/\.0$/, '')} {unitLabel}
              {!exactInUnit && (
                <Text style={[styles.residualText, { color: colors.textMuted }]}>
                  {' '}(off by {breakdown.residual.toFixed(1).replace(/\.0$/, '')})
                </Text>
              )}
            </Text>
          </View>

          {onApply && Math.abs(loadedLbs - weightLbs) > 0.01 && (
            <TouchableOpacity
              onPress={() => {
                onApply(loadedLbs);
                onClose();
              }}
              style={[styles.applyButton, { backgroundColor: colors.primary }]}>
              <Text style={[styles.applyText, { color: getContrastingTextColor(colors.primary) }]}>
                Use {breakdown.loadedTotal.toFixed(1).replace(/\.0$/, '')} {unitLabel}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 18,
  },
  sheet: {
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: 16,
  },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  stepBtn: {
    width: 32, height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyebrow: { fontSize: 10, fontWeight: '900', letterSpacing: 0.4 },
  title: { fontSize: 22, fontWeight: '900', marginTop: 2 },
  sectionLabel: { fontSize: 10, fontWeight: '900', letterSpacing: 0.4, marginBottom: 6 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: {
    minHeight: 32,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: { fontSize: 12, fontWeight: '800' },
  bodyText: { fontSize: 12, lineHeight: 17, marginTop: 4 },
  plateChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  plateCount: { fontSize: 16, fontWeight: '900' },
  plateWeight: { fontSize: 13, fontWeight: '800' },
  totalRow: {
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  totalLabel: { fontSize: 10, fontWeight: '900', letterSpacing: 0.4 },
  totalValue: { fontSize: 16, fontWeight: '900' },
  residualText: { fontSize: 11, fontWeight: '700' },
  applyButton: {
    marginTop: 14,
    minHeight: 42,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  applyText: { fontSize: 13, fontWeight: '900' },
});
