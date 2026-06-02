import React from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme } from '../constants/theme';
import type { AppThemeName, MealSuggestion } from '../types';
import {
  macroContributionsFromMeals,
  proteinSourceTotalsFromMeals,
  sumNutrientFromMeals,
  type MacroKey,
} from '../utils/macroBreakdown';
import {
  formatNutritionPrimaryTarget,
  formatNutritionTargetZones,
  nutritionRangeStatusText,
} from '../utils/nutritionTargetRanges';

export type { MacroKey } from '../utils/macroBreakdown';

interface Props {
  macro: MacroKey | null;
  meals: MealSuggestion[];
  totals: { calories: number; protein: number; carbs: number; fat: number };
  targets: { calories: number; protein: number; carbs: number; fat: number };
  accent?: string;
  themeName?: AppThemeName;
  onClose: () => void;
}

const PLANT_COLOR = '#22C55E';
const MEAT_COLOR = '#E07830';

function StatRow({
  label, value, pct, color, tc, sub,
}: {
  label: string; value: string; pct: number; color: string; tc: any; sub?: string;
}) {
  return (
    <View style={{ marginBottom: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 5 }}>
        <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: tc.textPrimary }}>{label}</Text>
        <Text style={{ fontSize: 13, fontWeight: '800', color }}>{value}</Text>
      </View>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: tc.border, overflow: 'hidden' }}>
        <View style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: '100%', backgroundColor: color }} />
      </View>
      {sub ? <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 4 }}>{sub}</Text> : null}
    </View>
  );
}

function EmptyNote({ text, tc }: { text: string; tc: any }) {
  return <Text style={{ fontSize: 13, color: tc.textMuted, paddingVertical: 8 }}>{text}</Text>;
}

function formatAmount(value: number, unit: string): string {
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${unit}`;
}

function formatActualTarget(macro: MacroKey, actual: number, target: number): string {
  const actualLabel = macro === 'calories'
    ? `${actual.toLocaleString()} kcal`
    : `${actual.toLocaleString()}g`;
  const targetLabel = formatNutritionPrimaryTarget(macro, target);
  return targetLabel ? `${actualLabel} / ${targetLabel}` : actualLabel;
}

export default function MacroBreakdownSheet({
  macro, meals, totals, targets, accent, themeName, onClose,
}: Props) {
  const tc = getTheme(themeName).colors;

  const META: Record<MacroKey, { title: string; unit: string; color: string }> = {
    calories: { title: 'Calories', unit: 'kcal', color: accent || tc.primary },
    protein: { title: 'Protein', unit: 'g', color: tc.primary },
    carbs: { title: 'Carbs', unit: 'g', color: '#F59E0B' },
    fat: { title: 'Fat', unit: 'g', color: '#A78BFA' },
  };

  const meta = macro ? META[macro] : null;
  const actual = macro ? Math.round(totals[macro]) : 0;
  const target = macro ? Math.round(targets[macro]) : 0;
  const targetZoneLabel = macro && target > 0 ? formatNutritionTargetZones(macro, target) : '';
  const sourceRows = macro ? macroContributionsFromMeals(meals, macro) : [];
  const sourceDenom = Math.max(1, actual);
  const showTopSources = !!meta;

  return (
    <Modal visible={macro != null} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} style={styles.overlay} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={[styles.sheet, { backgroundColor: tc.surface }]}>
          {meta && (
            <>
              <View style={styles.header}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.title, { color: tc.textPrimary }]}>{meta.title} breakdown</Text>
                  <Text style={{ fontSize: 13, color: tc.textSecondary, marginTop: 2 }}>
                    {macro ? formatActualTarget(macro, actual, target) : `${actual} ${meta.unit}`}
                  </Text>
                  {macro && target > 0 ? (
                    <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }}>
                      {nutritionRangeStatusText(macro, actual, target)}
                      {targetZoneLabel ? ` · ${targetZoneLabel}` : ''}
                    </Text>
                  ) : null}
                </View>
                <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                  <Ionicons name="close" size={22} color={tc.textMuted} />
                </TouchableOpacity>
              </View>

              <ScrollView style={{ maxHeight: 380 }} showsVerticalScrollIndicator={false}>
                {showTopSources && (
                  <>
                    {sourceRows.length === 0 ? (
                      <EmptyNote text={`No ${meta.title.toLowerCase()} logged yet today.`} tc={tc} />
                    ) : (
                      <>
                        <Text style={[styles.subhead, { color: tc.textMuted }]}>TOP SOURCES</Text>
                        {sourceRows.slice(0, 12).map((row, i) => (
                          <SourceRow
                            key={`${row.name}-${i}`}
                            name={row.name}
                            detail={row.meal}
                            amount={formatAmount(row.amount, meta.unit)}
                            pct={(row.amount / sourceDenom) * 100}
                            color={meta.color}
                            tc={tc}
                          />
                        ))}
                      </>
                    )}
                  </>
                )}

                {macro === 'calories' && (() => {
                  const pK = Math.round(totals.protein * 4);
                  const cK = Math.round(totals.carbs * 4);
                  const fK = Math.round(totals.fat * 9);
                  const sum = pK + cK + fK;
                  if (sum <= 0) return null;
                  const rows: Array<[string, number, string]> = [
                    ['Protein', pK, tc.primary],
                    ['Carbs', cK, '#F59E0B'],
                    ['Fat', fK, '#A78BFA'],
                  ];
                  return (
                    <>
                      <Text style={[styles.subhead, { color: tc.textMuted }]}>ENERGY BY MACRO</Text>
                      {rows.map(([label, kcal, color]) => (
                        <StatRow
                          key={label}
                          label={label}
                          value={`${kcal} kcal`}
                          pct={(kcal / sum) * 100}
                          color={color}
                          tc={tc}
                          sub={`${Math.round((kcal / sum) * 100)}% of calories`}
                        />
                      ))}
                    </>
                  );
                })()}

                {macro === 'protein' && (() => {
                  const pb = proteinSourceTotalsFromMeals(meals);
                  if (!pb) return <EmptyNote text="No protein sources logged yet today." tc={tc} />;
                  const total = pb.plant_total_g + pb.animal_total_g + pb.unclassified_total_g;
                  return (
                    <>
                      <Text style={[styles.subhead, { color: tc.textMuted }]}>PROTEIN TYPE</Text>
                      <StatRow
                        label="Plant"
                        value={`${pb.plant_total_g} g`}
                        pct={total > 0 ? (pb.plant_total_g / total) * 100 : 0}
                        color={PLANT_COLOR}
                        tc={tc}
                        sub={`${pb.plant_pct}% of protein`}
                      />
                      <StatRow
                        label="Meat / animal"
                        value={`${pb.animal_total_g} g`}
                        pct={total > 0 ? (pb.animal_total_g / total) * 100 : 0}
                        color={MEAT_COLOR}
                        tc={tc}
                        sub={`${pb.animal_pct}% of protein`}
                      />
                      {pb.unclassified_total_g > 0 && (
                        <StatRow
                          label="Unclassified"
                          value={`${pb.unclassified_total_g} g`}
                          pct={total > 0 ? (pb.unclassified_total_g / total) * 100 : 0}
                          color={tc.textMuted}
                          tc={tc}
                          sub={`${pb.unclassified_pct}% of protein`}
                        />
                      )}
                      {(pb.plant.length > 0 || pb.animal.length > 0) && (
                        <Text style={[styles.subhead, { color: tc.textMuted }]}>PER-FOOD SOURCES</Text>
                      )}
                      {pb.plant.map((it, i) => (
                        <SourceRow key={`p${i}`} name={it.name} amount={formatAmount(it.protein_g, 'g')} color={PLANT_COLOR} tc={tc} />
                      ))}
                      {pb.animal.map((it, i) => (
                        <SourceRow key={`a${i}`} name={it.name} amount={formatAmount(it.protein_g, 'g')} color={MEAT_COLOR} tc={tc} />
                      ))}
                      {pb.unclassified.length > 0 && (
                        <>
                          <Text style={[styles.subhead, { color: tc.textMuted }]}>UNCLASSIFIED</Text>
                          {pb.unclassified.map((it, i) => (
                            <SourceRow key={`u${i}`} name={it.name} amount={formatAmount(it.protein_g, 'g')} color={tc.textMuted} tc={tc} />
                          ))}
                        </>
                      )}
                    </>
                  );
                })()}

                {macro === 'carbs' && (() => {
                  const totalCarbs = Math.round(totals.carbs);
                  const fiber = sumNutrientFromMeals(meals, ['fiber_g', 'fiber'], 'fiber');
                  const sugar = sumNutrientFromMeals(meals, ['sugar_g', 'sugar']);
                  const addedSugar = sumNutrientFromMeals(meals, ['added_sugar_g', 'added_sugar', 'addedSugar']);
                  if (totalCarbs <= 0 && fiber + sugar + addedSugar <= 0) {
                    return null;
                  }
                  const denom = totalCarbs > 0 ? totalCarbs : Math.max(fiber, sugar, 1);
                  return (
                    <>
                      <Text style={[styles.subhead, { color: tc.textMuted }]}>CARB QUALITY</Text>
                      <StatRow label="Fiber" value={`${fiber} g`} pct={(fiber / denom) * 100} color="#10B981" tc={tc} />
                      <StatRow label="Total sugar" value={`${sugar} g`} pct={(sugar / denom) * 100} color="#F59E0B" tc={tc} />
                      <StatRow
                        label="Added sugar"
                        value={`${addedSugar} g`}
                        pct={(addedSugar / denom) * 100}
                        color="#EF4444"
                        tc={tc}
                        sub={sugar > 0 ? `${Math.round((addedSugar / sugar) * 100)}% of total sugar` : undefined}
                      />
                    </>
                  );
                })()}

                {macro === 'fat' && (() => {
                  const totalFat = Math.round(totals.fat);
                  const sat = sumNutrientFromMeals(meals, ['saturated_fat_g', 'saturated_fat', 'saturatedFat']);
                  const mono = sumNutrientFromMeals(meals, ['monounsaturated_fat_g', 'monounsaturated_fat', 'monounsaturatedFat']);
                  const poly = sumNutrientFromMeals(meals, ['polyunsaturated_fat_g', 'polyunsaturated_fat', 'polyunsaturatedFat']);
                  if (totalFat <= 0 && sat + mono + poly <= 0) {
                    return null;
                  }
                  const denom = totalFat > 0 ? totalFat : Math.max(sat, mono, poly, 1);
                  return (
                    <>
                      <Text style={[styles.subhead, { color: tc.textMuted }]}>FAT TYPES</Text>
                      <StatRow label="Saturated" value={`${sat} g`} pct={(sat / denom) * 100} color="#EF4444" tc={tc} />
                      <StatRow label="Monounsaturated" value={`${mono} g`} pct={(mono / denom) * 100} color="#34D399" tc={tc} />
                      <StatRow label="Polyunsaturated" value={`${poly} g`} pct={(poly / denom) * 100} color="#60A5FA" tc={tc} />
                      {sat + mono + poly === 0 && (
                        <EmptyNote text="Fat-type detail isn't available for today's foods yet." tc={tc} />
                      )}
                    </>
                  );
                })()}
              </ScrollView>
            </>
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

function SourceRow({
  name, amount, color, tc, detail, pct,
}: {
  name: string;
  amount: string;
  color: string;
  tc: any;
  detail?: string;
  pct?: number;
}) {
  return (
    <View style={{ paddingVertical: 5 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color, marginRight: 8 }} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontSize: 13, color: tc.textPrimary }} numberOfLines={1}>{name}</Text>
          {detail ? <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 1 }} numberOfLines={1}>{detail}</Text> : null}
        </View>
        <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textSecondary }}>{amount}</Text>
      </View>
      {pct != null && (
        <View style={{ height: 4, borderRadius: 2, backgroundColor: tc.border, overflow: 'hidden', marginTop: 5, marginLeft: 15 }}>
          <View style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: '100%', backgroundColor: color }} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 36,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  title: { fontSize: 17, fontWeight: '800' },
  subhead: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginTop: 6,
    marginBottom: 6,
  },
});
