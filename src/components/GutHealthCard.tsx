// Gut & Plants — descriptive insight card, NO scores.
//
// Facts only: fiber, plant diversity, fermented / probiotic / omega-3 foods,
// seafood, processing mix, plant-vs-animal protein split. Today and the
// rolling 7-day window are visually separated so users can tell which
// number to act on.

import { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, LayoutAnimation, Platform, UIManager } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { getGutHealth, GutHealthToday, GutHealthWindow } from '../services/api';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface Props {
  authToken: string;
  themeName?: AppThemeName;
}

export default function GutHealthCard({ authToken, themeName }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;

  const [today, setToday] = useState<GutHealthToday | null>(null);
  const [week, setWeek] = useState<GutHealthWindow | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getGutHealth(authToken, 7);
      setToday(res.today);
      setWeek(res.window);
    } catch {
      setToday(null); setWeek(null);
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <View style={{ backgroundColor: tc.surface, borderRadius: radius.lg, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: tc.border }}>
        <Text style={{ fontSize: 12, color: tc.textMuted }}>Loading gut & plants…</Text>
      </View>
    );
  }

  if (!today || today.item_count === 0) {
    const weeklyHasData = week && week.days_with_data > 0;
    return (
      <View style={{
        backgroundColor: tc.surface, borderRadius: radius.lg, padding: 14, marginBottom: 12,
        borderWidth: 1, borderColor: tc.border,
      }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <Ionicons name="leaf-outline" size={16} color={tc.primary} />
          <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary, flex: 1 }}>
            Gut & Plants
          </Text>
        </View>
        <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 17 }}>
          Log a meal to see fiber, plant diversity, fermented and omega-3 foods, and processing mix.
        </Text>
        {weeklyHasData && (
          <View style={{ marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: tc.border + '44' }}>
            <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 6 }}>
              LAST {week!.days_with_data} DAY{week!.days_with_data === 1 ? '' : 'S'}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              <WeekFact label="Fiber" value={`${week!.avg_fiber_g}g/day`} tc={tc} />
              <WeekFact label="Plants" value={`${week!.distinct_plant_foods_week}`} tc={tc} />
              <WeekFact label="Fermented" value={`${week!.fermented_servings}`} tc={tc} />
              <WeekFact label="Plant protein" value={`${week!.plant_protein_pct ?? 0}%`} tc={tc} />
            </View>
          </View>
        )}
      </View>
    );
  }

  const coverage = today.item_count > 0 ? today.classified_item_count / today.item_count : 0;
  const low = coverage < 0.5;

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded(e => !e);
  };

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={toggle}
      style={{
        backgroundColor: tc.surface, borderRadius: radius.lg, padding: 14, marginBottom: 12,
        borderWidth: 1, borderColor: tc.border,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Ionicons name="leaf-outline" size={16} color={tc.primary} />
        <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary, flex: 1 }}>
          Gut & Plants
        </Text>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={tc.textMuted} />
      </View>

      {/* Today headline — 4 tiles so probiotic (live cultures) is visible
          without expanding the card. */}
      <View style={{ flexDirection: 'row', gap: 6 }}>
        <Headline label="Plants" value={String(today.distinct_plant_foods)} tc={tc} />
        <Headline label="Fiber" value={`${Math.round(today.fiber_total_g)}g`} tc={tc} />
        <Headline label="Fermented" value={String(Math.round(today.fermented_servings))} tc={tc} />
        <Headline label="Probiotic" value={String(Math.round(today.probiotic_servings))} tc={tc} />
      </View>

      {low && (
        <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 8, fontStyle: 'italic' }}>
          Low food-classification coverage today — numbers may be conservative.
        </Text>
      )}

      {expanded && (
        <View style={{ marginTop: 14, gap: 10 }}>
          {/* TODAY section */}
          <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5 }}>
            TODAY
          </Text>
          <FactRow label="Fiber" main={`${today.fiber_total_g}g`} aux={`${today.fiber_per_1000_kcal} per 1000 kcal`} tc={tc} />
          <FactRow label="Plant diversity" main={`${today.distinct_plant_foods} distinct`} aux="" tc={tc} />
          <FactRow label="Fermented" main={`${today.fermented_servings}`} aux="" tc={tc} />
          <FactRow label="Probiotic (live)" main={`${today.probiotic_servings}`} aux="" tc={tc} />
          <FactRow label="Omega-3 foods" main={`${today.omega3_servings}`} aux="" tc={tc} />
          <FactRow label="Seafood" main={`${today.seafood_servings}`} aux="" tc={tc} />
          <FactRow label="Added sugar" main={`${Math.round(today.added_sugar_g)}g`} aux="" tc={tc} />

          {/* Protein source split */}
          {(today.plant_protein_g + today.animal_protein_g) > 0 && (() => {
            const total = today.plant_protein_g + today.animal_protein_g;
            const plantPct = Math.round((today.plant_protein_g / total) * 100);
            return (
              <View style={{ marginTop: 4 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <Text style={{ width: 120, fontSize: 11, fontWeight: '600', color: tc.textSecondary }}>
                    Protein source
                  </Text>
                  <Text style={{ flex: 1, fontSize: 11, fontWeight: '700', color: tc.textPrimary }}>
                    {Math.round(today.plant_protein_g)}g plant · {Math.round(today.animal_protein_g)}g animal
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', height: 6, borderRadius: 3, overflow: 'hidden', backgroundColor: tc.border }}>
                  {today.plant_protein_g > 0 && <View style={{ width: `${plantPct}%` as any, backgroundColor: tc.success }} />}
                  {today.animal_protein_g > 0 && <View style={{ width: `${100 - plantPct}%` as any, backgroundColor: tc.primary }} />}
                </View>
              </View>
            );
          })()}

          {/* Processing mix */}
          {today.processing_counts && Object.keys(today.processing_counts).length > 0 && (
            <View>
              <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5, marginTop: 6, marginBottom: 4 }}>
                PROCESSING MIX
              </Text>
              {['minimally_processed', 'processed', 'ultra_processed', 'unknown'].map(b => {
                const count = today.processing_counts[b] ?? 0;
                if (count === 0) return null;
                const total = today.item_count || 1;
                const pct = Math.round(100 * count / total);
                const color = b === 'minimally_processed' ? tc.success
                  : b === 'processed' ? tc.warning
                  : b === 'ultra_processed' ? tc.error
                  : tc.textMuted;
                return (
                  <View key={b} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <Text style={{ width: 130, fontSize: 10, color: tc.textSecondary }}>{b.replace(/_/g, ' ')}</Text>
                    <View style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: tc.border }}>
                      <View style={{ width: `${Math.max(3, pct)}%` as any, height: 5, borderRadius: 3, backgroundColor: color }} />
                    </View>
                    <Text style={{ width: 48, fontSize: 10, color: tc.textSecondary, textAlign: 'right' }}>{count} ({pct}%)</Text>
                  </View>
                );
              })}
            </View>
          )}

          {/* THIS WEEK section (visually separated) */}
          {week && week.days_with_data > 0 && (
            <View style={{ marginTop: 6, paddingTop: 10, borderTopWidth: 1, borderTopColor: tc.border + '66' }}>
              <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 6 }}>
                THIS WEEK ({week.days_with_data}d logged)
              </Text>
              <FactRow label="Fiber avg" main={`${week.avg_fiber_g}g/day`} aux={`${week.pct_days_fiber_target}% days hit 28g`} tc={tc} />
              <FactRow label="Plants" main={`${week.distinct_plant_foods_week} distinct`} aux="" tc={tc} />
              <FactRow label="Fermented" main={`${week.fermented_servings}`} aux="" tc={tc} />
              <FactRow label="Omega-3 foods" main={`${week.omega3_servings}`} aux="" tc={tc} />
              <FactRow label="Seafood" main={`${week.seafood_servings}`} aux={week.seafood_servings >= 2 ? 'on target' : 'aim for 2+/wk'} tc={tc} />
              <FactRow label="Alcohol" main={`${week.alcohol_servings}`} aux="" tc={tc} />
              <FactRow label="Processed meat" main={`${week.processed_meat_servings}`} aux="" tc={tc} />
              <FactRow label="Refined grain" main={`${week.refined_grain_servings}`} aux="" tc={tc} />
              <FactRow label="Plant protein" main={`${week.plant_protein_pct}%`} aux="" tc={tc} />
            </View>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

function Headline({ label, value, tc }: { label: string; value: string; tc: any }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', backgroundColor: tc.background, borderRadius: 10, padding: 8 }}>
      <Text style={{ fontSize: 18, fontWeight: '900', color: tc.textPrimary }}>{value}</Text>
      <Text style={{ fontSize: 10, fontWeight: '600', color: tc.textMuted, marginTop: 2 }}>{label}</Text>
    </View>
  );
}

function FactRow({ label, main, aux, tc }: { label: string; main: string; aux: string; tc: any }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Text style={{ width: 120, fontSize: 11, fontWeight: '600', color: tc.textSecondary }}>{label}</Text>
      <Text style={{ flex: 1, fontSize: 11, fontWeight: '700', color: tc.textPrimary }}>{main}</Text>
      {aux ? <Text style={{ fontSize: 10, color: tc.textMuted }}>{aux}</Text> : null}
    </View>
  );
}

function WeekFact({ label, value, tc }: { label: string; value: string; tc: any }) {
  return (
    <Text style={{ fontSize: 11, color: tc.textSecondary }}>
      {label}: <Text style={{ color: tc.textPrimary, fontWeight: '700' }}>{value}</Text>
    </Text>
  );
}
