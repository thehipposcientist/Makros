// Gut health / longevity signals card. Reads from /meals/gut-health and shows
// the three derived scores (Gut Support / Food Quality / Longevity Signals)
// plus raw drivers (fiber, plant diversity, fermented, omega-3). Collapsed
// by default; expandable for drivers.

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
  // Default to expanded so the key longevity details (probiotic, fermented,
  // plant-vs-animal protein ratio, fiber, omega-3) are visible immediately
  // without the user having to tap to reveal. They're the whole reason the
  // card exists — hiding them behind a tap was a mistake.
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
        <Text style={{ fontSize: 12, color: tc.textMuted }}>Loading gut-health signals…</Text>
      </View>
    );
  }

  // "No meals yet" placeholder — keeps the card visible so users can see
  // the feature exists + what metrics they'll get once they log a meal.
  // Still shows any weekly context if the last N days had data.
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
            Gut & Longevity Signals
          </Text>
        </View>
        <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 17 }}>
          Log a meal to see today's fiber, plant diversity, fermented / probiotic servings, omega-3 foods, and plant-vs-animal protein ratio.
        </Text>
        {weeklyHasData && (
          <View style={{ marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: tc.border + '44' }}>
            <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 6 }}>
              LAST {week!.days_with_data} DAY{week!.days_with_data === 1 ? '' : 'S'}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              <Text style={{ fontSize: 11, color: tc.textSecondary }}>
                Avg fiber: <Text style={{ color: tc.textPrimary, fontWeight: '700' }}>{week!.avg_fiber_g}g</Text>
              </Text>
              <Text style={{ fontSize: 11, color: tc.textSecondary }}>
                Plants: <Text style={{ color: tc.textPrimary, fontWeight: '700' }}>{week!.distinct_plant_foods_week}</Text>
              </Text>
              <Text style={{ fontSize: 11, color: tc.textSecondary }}>
                Fermented: <Text style={{ color: tc.textPrimary, fontWeight: '700' }}>{week!.fermented_servings}</Text>
              </Text>
              <Text style={{ fontSize: 11, color: tc.textSecondary }}>
                Protein mix: <Text style={{ color: tc.textPrimary, fontWeight: '700' }}>{week!.plant_protein_pct ?? 0}% plant</Text>
              </Text>
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

  const scoreColor = (v: number) =>
    v >= 75 ? tc.success :
    v >= 55 ? tc.primary :
    v >= 35 ? tc.warning : tc.error;

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
          Gut & Longevity Signals
        </Text>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={tc.textMuted} />
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {[
          { label: 'Gut Support', value: today.gut_support_score },
          { label: 'Food Quality', value: today.food_quality_score },
          { label: 'Longevity', value: today.longevity_signals_score },
        ].map(s => (
          <View key={s.label} style={{
            flex: 1, alignItems: 'center',
            backgroundColor: tc.background, borderRadius: 10, padding: 8,
          }}>
            <Text style={{ fontSize: 20, fontWeight: '900', color: scoreColor(s.value) }}>
              {Math.round(s.value)}
            </Text>
            <Text style={{ fontSize: 10, fontWeight: '600', color: tc.textMuted, marginTop: 2 }}>{s.label}</Text>
          </View>
        ))}
      </View>

      {low && (
        <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 8, fontStyle: 'italic' }}>
          Low food-classification coverage today — scores may be conservative.
        </Text>
      )}

      {expanded && (
        <View style={{ marginTop: 12, gap: 6 }}>
          {[
            ['Fiber',           `${today.fiber_total_g}g`, `${today.fiber_per_1000_kcal} per 1000 kcal`],
            ['Plant diversity', `${today.distinct_plant_foods} today`, week ? `${week.distinct_plant_foods_week} this week` : ''],
            ['Fermented',       `${today.fermented_servings} today`, week ? `${week.fermented_servings} this week` : ''],
            ['Probiotic (live)',`${today.probiotic_servings ?? 0} today`, week ? `${week.probiotic_servings ?? 0} this week` : ''],
            ['Omega-3 foods',   `${today.omega3_servings} today`, week ? `${week.omega3_servings} this week` : ''],
          ].map(([label, main, detail]) => (
            <View key={label as string} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ width: 110, fontSize: 11, fontWeight: '600', color: tc.textSecondary }}>{label}</Text>
              <Text style={{ flex: 1, fontSize: 11, fontWeight: '700', color: tc.textPrimary }}>{main}</Text>
              <Text style={{ fontSize: 10, color: tc.textMuted }}>{detail as string}</Text>
            </View>
          ))}

          {/* Plant-vs-animal protein — rendered as a stacked bar so the
              ratio is immediately legible. Targets ~30%+ plant protein
              for most longevity-style diets; no hard target because it's
              goal-dependent. */}
          {(today.plant_protein_g + today.animal_protein_g) > 0 && (() => {
            const total = today.plant_protein_g + today.animal_protein_g;
            const plantPct = Math.round((today.plant_protein_g / total) * 100);
            return (
              <View style={{ marginTop: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <Text style={{ width: 110, fontSize: 11, fontWeight: '600', color: tc.textSecondary }}>
                    Protein source
                  </Text>
                  <Text style={{ flex: 1, fontSize: 11, fontWeight: '700', color: tc.textPrimary }}>
                    {today.plant_protein_g}g plant · {today.animal_protein_g}g animal
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: tc.border }}>
                  {today.plant_protein_g > 0 && (
                    <View style={{ width: `${plantPct}%` as any, backgroundColor: tc.success }} />
                  )}
                  {today.animal_protein_g > 0 && (
                    <View style={{ width: `${100 - plantPct}%` as any, backgroundColor: tc.primary }} />
                  )}
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                  <Text style={{ fontSize: 10, color: tc.success, fontWeight: '700' }}>{plantPct}% plant</Text>
                  <Text style={{ fontSize: 10, color: tc.primary, fontWeight: '700' }}>{100 - plantPct}% animal</Text>
                </View>
                {week && week.plant_protein_pct != null && (
                  <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 4 }}>
                    Weekly mix: {week.plant_protein_pct}% plant
                  </Text>
                )}
              </View>
            );
          })()}
          {today.processing_counts && Object.keys(today.processing_counts).length > 0 && (
            <View style={{ marginTop: 6, paddingTop: 8, borderTopWidth: 1, borderTopColor: tc.border + '44' }}>
              <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 4 }}>
                PROCESSING MIX TODAY
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
        </View>
      )}
    </TouchableOpacity>
  );
}
