import React from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { getTheme } from '../../constants/theme';
import { formatNutritionPrimaryTarget } from '../../utils/nutritionTargetRanges';

type ThemeColors = ReturnType<typeof getTheme>['colors'];

export type NutritionScoreDetailBreakdownItem = {
  label: string;
  value_pct?: number;
  raw?: number;
  target?: number | null;
  target_min?: number | null;
  target_max?: number | null;
  unit?: string;
  on_track?: boolean;
};

export type NutritionScoreDetail = {
  dayLabel: string;
  score: number;
  source?: string | null;
  confidence?: string | null;
  adherence?: number | null;
  quality?: number | null;
  micro?: number | null;
  wins: string[];
  improvements: string[];
  likelyGaps: string[];
  totals?: { calories?: number; protein_g?: number; carbs_g?: number; fat_g?: number } | null;
  targets?: { calories?: number; protein_g?: number; carbs_g?: number; fat_g?: number } | null;
  indicators?: Record<string, any> | null;
  breakdowns: Array<{ title: string; items: NutritionScoreDetailBreakdownItem[] }>;
};

function nutritionScoreTone(score: number, tc: ThemeColors) {
  if (score >= 70) return tc.success;
  if (score >= 45) return tc.warning;
  return tc.error;
}

function nutritionScoreLabel(score: number) {
  if (score >= 85) return 'Excellent';
  if (score >= 70) return 'On track';
  if (score >= 45) return 'Gaps to close';
  return 'Needs attention';
}

export default function NutritionScoreDetailSheet({
  detail,
  colors: tc,
  onClose,
}: {
  detail: NutritionScoreDetail | null;
  colors: ThemeColors;
  onClose: () => void;
}) {
  if (!detail) return null;
  const tone = nutritionScoreTone(detail.score, tc);
  const rows = [
    { label: 'Adherence', value: detail.adherence },
    { label: 'Food quality', value: detail.quality },
    { label: 'Micronutrients', value: detail.micro },
  ].filter(row => typeof row.value === 'number') as Array<{ label: string; value: number }>;
  const renderScoreBar = (label: string, value: number) => {
    const color = nutritionScoreTone(value, tc);
    return (
      <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 7 }}>
        <Text style={{ width: 104, fontSize: 11, fontWeight: '700', color: tc.textSecondary }}>{label}</Text>
        <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: tc.border, overflow: 'hidden' }}>
          <View style={{ width: `${Math.max(4, Math.min(100, value))}%` as any, height: 6, borderRadius: 3, backgroundColor: color }} />
        </View>
        <Text style={{ width: 30, fontSize: 11, fontWeight: '800', color, textAlign: 'right' }}>{value}</Text>
      </View>
    );
  };
  const renderList = (title: string, items: string[], icon: React.ComponentProps<typeof Ionicons>['name'], color: string) => {
    if (items.length === 0) return null;
    return (
      <View style={{ marginTop: 14 }}>
        <Text style={{ fontSize: 10, fontWeight: '900', color: tc.textMuted, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 7 }}>
          {title}
        </Text>
        {items.slice(0, 5).map(item => (
          <View key={item} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 7, marginBottom: 6 }}>
            <Ionicons name={icon} size={13} color={color} style={{ marginTop: 1 }} />
            <Text style={{ flex: 1, fontSize: 12, lineHeight: 17, color: tc.textSecondary }}>{item}</Text>
          </View>
        ))}
      </View>
    );
  };
  const formatBreakdownValue = (item: NutritionScoreDetailBreakdownItem) => {
    const raw = typeof item.raw === 'number' ? Math.round(item.raw * 10) / 10 : null;
    if (raw == null) return '';
    const unit = item.unit === '% cals' ? '%' : item.unit ? ` ${item.unit}` : '';
    const targetMin = typeof item.target_min === 'number' ? Math.round(item.target_min * 10) / 10 : null;
    const targetMax = typeof item.target_max === 'number' ? Math.round(item.target_max * 10) / 10 : null;
    if (typeof item.target === 'number') {
      return `${raw}${unit} / ${Math.round(item.target * 10) / 10}${unit}`;
    }
    if (targetMin != null && targetMax != null) {
      return `${raw}${unit} / ${targetMin}-${targetMax}${unit}`;
    }
    return `${raw}${unit}`;
  };
  const hasCalories =
    typeof detail.totals?.calories === 'number'
    || typeof detail.targets?.calories === 'number'
    || typeof detail.indicators?.total_calories === 'number'
    || typeof detail.indicators?.target_calories === 'number';
  const hasProtein =
    typeof detail.totals?.protein_g === 'number'
    || typeof detail.targets?.protein_g === 'number'
    || typeof detail.indicators?.total_protein === 'number'
    || typeof detail.indicators?.target_protein === 'number';
  const hasCarbs =
    typeof detail.totals?.carbs_g === 'number'
    || typeof detail.targets?.carbs_g === 'number'
    || typeof detail.indicators?.total_carbs === 'number'
    || typeof detail.indicators?.target_carbs === 'number';
  const hasFat =
    typeof detail.totals?.fat_g === 'number'
    || typeof detail.targets?.fat_g === 'number'
    || typeof detail.indicators?.total_fat === 'number'
    || typeof detail.indicators?.target_fat === 'number';
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000088' }}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={{
          maxHeight: '86%',
          backgroundColor: tc.surface,
          borderTopLeftRadius: 22,
          borderTopRightRadius: 22,
          paddingHorizontal: 16,
          paddingTop: 10,
          paddingBottom: 26,
        }}>
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: tc.border, alignSelf: 'center', marginBottom: 12 }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: tone + '18', alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="nutrition-outline" size={19} color={tone} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 10, fontWeight: '900', color: tc.textMuted, letterSpacing: 0.6, textTransform: 'uppercase' }}>
                {detail.dayLabel}
              </Text>
              <Text style={{ fontSize: 17, fontWeight: '900', color: tc.textPrimary, marginTop: 2 }}>Nutrition Score</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={21} color={tc.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 10 }}>
            <View style={{
              borderWidth: 1,
              borderColor: tc.border,
              backgroundColor: tc.surfaceRaised,
              borderRadius: 12,
              padding: 12,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
            }}>
              <View style={{ width: 58, height: 58, borderRadius: 29, backgroundColor: tone + '18', borderWidth: 1, borderColor: tone + '66', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 23, fontWeight: '900', color: tone }}>{detail.score}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: '900', color: tone }}>{nutritionScoreLabel(detail.score)}</Text>
                <Text style={{ fontSize: 12, lineHeight: 17, color: tc.textSecondary, marginTop: 2 }}>
                  {detail.source ? `${detail.source.replace(/_/g, ' ')} score` : 'Daily score'}
                  {detail.confidence ? ` · ${detail.confidence} confidence` : ''}
                </Text>
              </View>
            </View>

            {rows.length > 0 && (
              <View style={{ marginTop: 14 }}>
                <Text style={{ fontSize: 10, fontWeight: '900', color: tc.textMuted, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8 }}>
                  Breakdown
                </Text>
                {rows.map(row => renderScoreBar(row.label, row.value))}
              </View>
            )}

            {(hasCalories || hasProtein || hasCarbs || hasFat) && (
              <View style={{ marginTop: 12, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: tc.border, backgroundColor: tc.surfaceRaised }}>
                <Text style={{ fontSize: 10, fontWeight: '900', color: tc.textMuted, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8 }}>
                  Today
                </Text>
                {hasCalories ? (
                  <Text style={{ fontSize: 12, color: tc.textSecondary, marginBottom: 4 }}>
                    Calories {Math.round(detail.totals?.calories ?? detail.indicators?.total_calories ?? 0)} / {formatNutritionPrimaryTarget('calories', detail.targets?.calories ?? detail.indicators?.target_calories ?? 0)}
                  </Text>
                ) : null}
                {hasProtein ? (
                  <Text style={{ fontSize: 12, color: tc.textSecondary, marginBottom: hasCarbs || hasFat ? 4 : 0 }}>
                    Protein {Math.round(detail.totals?.protein_g ?? detail.indicators?.total_protein ?? 0)}g / {formatNutritionPrimaryTarget('protein', detail.targets?.protein_g ?? detail.indicators?.target_protein ?? 0)}
                  </Text>
                ) : null}
                {hasCarbs ? (
                  <Text style={{ fontSize: 12, color: tc.textSecondary, marginBottom: hasFat ? 4 : 0 }}>
                    Carbs {Math.round(detail.totals?.carbs_g ?? detail.indicators?.total_carbs ?? 0)}g / {formatNutritionPrimaryTarget('carbs', detail.targets?.carbs_g ?? detail.indicators?.target_carbs ?? 0)}
                  </Text>
                ) : null}
                {hasFat ? (
                  <Text style={{ fontSize: 12, color: tc.textSecondary }}>
                    Fat {Math.round(detail.totals?.fat_g ?? detail.indicators?.total_fat ?? 0)}g / {formatNutritionPrimaryTarget('fat', detail.targets?.fat_g ?? detail.indicators?.target_fat ?? 0)}
                  </Text>
                ) : null}
              </View>
            )}

            {renderList('Wins', detail.wins, 'checkmark-circle', tc.success)}
            {renderList('Focus areas', detail.improvements, 'arrow-up-circle', tc.warning)}
            {renderList('Likely gaps', detail.likelyGaps, 'alert-circle-outline', tc.error)}

            {detail.breakdowns.map(section => {
              if (!section.items.length) return null;
              return (
                <View key={section.title} style={{ marginTop: 14 }}>
                  <Text style={{ fontSize: 10, fontWeight: '900', color: tc.textMuted, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 7 }}>
                    {section.title}
                  </Text>
                  {section.items.slice(0, 6).map(item => {
                    const color = item.on_track ? tc.success : (item.value_pct ?? 0) >= 50 ? tc.warning : tc.error;
                    return (
                      <View key={`${section.title}-${item.label}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <Text style={{ width: 118, fontSize: 11, fontWeight: '700', color: tc.textSecondary }} numberOfLines={1}>{item.label}</Text>
                        <View style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: tc.border, overflow: 'hidden' }}>
                          <View style={{ width: `${Math.max(4, Math.min(100, item.value_pct ?? 0))}%` as any, height: 5, borderRadius: 3, backgroundColor: color }} />
                        </View>
                        <Text style={{ width: 66, fontSize: 10, color: tc.textMuted, textAlign: 'right' }} numberOfLines={1}>
                          {formatBreakdownValue(item)}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              );
            })}
            <Text style={{ fontSize: 10, lineHeight: 14, color: tc.textMuted, marginTop: 14 }}>
              Nutrition scoring is server-authoritative for logged meals. Planned-day scores are previews until meals are logged.
            </Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
