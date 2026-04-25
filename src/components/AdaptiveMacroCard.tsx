// Weekly adaptive-TDEE check-in card.
//
// Shows the user their estimated maintenance calories from the last 14
// days of logged intake + weight trend, and suggests a new calorie
// target given their goal. Deterministic (no AI) — see
// backend/app/services/nutrition/adaptive_macros.py.
//
// Principles:
//   • Confidence gating — don't adjust without enough data; explain why.
//   • Never silently change the target — always "Accept" / "Keep current".
//   • Max ±150 kcal/wk drift unless the current target is clearly wrong.

import { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import * as api from '../services/api';

interface Props {
  authToken: string;
  themeName?: AppThemeName;
  /** {date: 'YYYY-MM-DD', weight_lbs: number}[] — user's logged weight
   *  history from client-side storage. */
  weightEntries: Array<{ date: string; weight_lbs: number }>;
  /** Called with the accepted target so parent can persist it to the
   *  user's nutrition plan. */
  onAccept?: (newTargetKcal: number) => void;
}

export default function AdaptiveMacroCard({ authToken, themeName, weightEntries, onAccept }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<api.AdaptiveMacroResult | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Stable signature for weightEntries — without this, the `.map()`
  // call site in HomeScreen passes a new array reference every render,
  // making `load` a new function every render, making the effect
  // re-fire every render. That re-fire flashed the "Checking your
  // calorie trend…" loading pill every time a meal day card expanded
  // or collapsed (any state change up the tree). Dedupe by the
  // information content of the array, not its identity.
  const weightSig = (() => {
    const arr = weightEntries || [];
    if (arr.length === 0) return 'empty';
    const last = arr[arr.length - 1];
    return `${arr.length}|${last?.date ?? ''}|${last?.weight_lbs ?? ''}`;
  })();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await api.getAdaptiveMacros(authToken, weightEntries || []);
        if (!cancelled) setData(r);
      } catch {
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken, weightSig]);

  if (loading && !data) {
    return (
      <View style={{
        backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
        borderRadius: radius.lg, padding: 14, marginBottom: 12,
        flexDirection: 'row', alignItems: 'center', gap: 10,
      }}>
        <ActivityIndicator color={tc.primary} size="small" />
        <Text style={{ fontSize: 12, color: tc.textMuted }}>Checking your calorie trend…</Text>
      </View>
    );
  }
  if (!data) return null;

  // Confidence → theme semantic:
  //   high   = success (green)
  //   medium = primary (theme's signature color)
  //   low    = textMuted (neutral gray)
  const confidenceColor = data.confidence === 'high' ? tc.success
    : data.confidence === 'medium' ? tc.primary : tc.textMuted;

  // Need-more-data state — surface what's missing so the user knows
  // how to unlock the recommendation.
  if (data.status === 'need_more_data') {
    return (
      <TouchableOpacity
        activeOpacity={0.9}
        onPress={() => setExpanded(!expanded)}
        style={{
          backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
          borderRadius: radius.lg, padding: 14, marginBottom: 12,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Ionicons name="analytics-outline" size={16} color={tc.textMuted} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>
              Need more logs for smarter recommendations
            </Text>
            <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }} numberOfLines={expanded ? undefined : 2}>
              {data.reason}
            </Text>
          </View>
          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={tc.textMuted} />
        </View>
        {expanded && (
          <View style={{ marginTop: 10, flexDirection: 'row', gap: 12 }}>
            <View>
              <Text style={{ fontSize: 10, color: tc.textMuted, letterSpacing: 0.5 }}>LOGGED DAYS</Text>
              <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary }}>{data.days_logged}/14</Text>
            </View>
            <View>
              <Text style={{ fontSize: 10, color: tc.textMuted, letterSpacing: 0.5 }}>WEIGH-INS</Text>
              <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary }}>{data.weigh_ins}/7</Text>
            </View>
          </View>
        )}
      </TouchableOpacity>
    );
  }

  const delta = data.delta ?? 0;
  const isSuggestingChange = Math.abs(delta) >= 25; // Below 25 kcal, it's noise.

  const handleAccept = () => {
    if (!data.suggested_target) return;
    Alert.alert(
      'Update calorie target?',
      `Your new target will be ${data.suggested_target} kcal/day${delta ? ` (${delta > 0 ? '+' : ''}${delta} vs current).` : '.'}\n\n${data.reason}`,
      [
        { text: 'Keep current', style: 'cancel' },
        {
          text: 'Accept', onPress: () => {
            onAccept?.(data.suggested_target!);
          },
        },
      ],
    );
  };

  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={() => setExpanded(!expanded)}
      style={{
        backgroundColor: tc.surface, borderWidth: 1,
        borderColor: isSuggestingChange ? tc.primary + '55' : tc.border,
        borderRadius: radius.lg, padding: 14, marginBottom: 12,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{
          width: 36, height: 36, borderRadius: 18,
          backgroundColor: tc.primary + '22',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Ionicons name="trending-up" size={18} color={tc.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary }}>
            Weekly calorie check-in
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: confidenceColor }} />
            <Text style={{ fontSize: 11, color: tc.textMuted }}>
              {data.confidence === 'high' ? 'High confidence'
                : data.confidence === 'medium' ? 'Medium confidence'
                : 'Low confidence'} · est. maintenance {data.estimated_tdee} kcal
            </Text>
          </View>
        </View>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={tc.textMuted} />
      </View>

      {expanded && (
        <View style={{ marginTop: 12, gap: 10 }}>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 10, color: tc.textMuted, letterSpacing: 0.5 }}>YOUR AVG INTAKE</Text>
              <Text style={{ fontSize: 15, fontWeight: '800', color: tc.textPrimary }}>
                {data.avg_daily_calories} <Text style={{ fontSize: 10, color: tc.textMuted }}>kcal/day</Text>
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 10, color: tc.textMuted, letterSpacing: 0.5 }}>WEIGHT TREND</Text>
              <Text style={{ fontSize: 15, fontWeight: '800', color: tc.textPrimary }}>
                {data.weekly_weight_change_lbs != null
                  ? `${data.weekly_weight_change_lbs > 0 ? '+' : ''}${data.weekly_weight_change_lbs.toFixed(1)}`
                  : '—'}
                <Text style={{ fontSize: 10, color: tc.textMuted }}> lb/wk</Text>
              </Text>
            </View>
          </View>

          <View style={{ paddingTop: 10, borderTopWidth: 1, borderTopColor: tc.border }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <Text style={{ fontSize: 12, color: tc.textSecondary }}>Current target</Text>
              <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>
                {data.current_target ? `${data.current_target} kcal` : '—'}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 12, color: tc.textSecondary }}>Suggested</Text>
              <Text style={{ fontSize: 13, fontWeight: '800', color: isSuggestingChange ? tc.primary : tc.textPrimary }}>
                {data.suggested_target} kcal{delta ? `  (${delta > 0 ? '+' : ''}${delta})` : ''}
              </Text>
            </View>
          </View>

          <Text style={{ fontSize: 11, color: tc.textMuted, lineHeight: 15 }}>{data.reason}</Text>

          {isSuggestingChange && onAccept && (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
              <TouchableOpacity
                onPress={handleAccept}
                style={{
                  flex: 1, backgroundColor: tc.primary,
                  paddingVertical: 10, borderRadius: 10,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>
                  Accept {data.suggested_target} kcal
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setExpanded(false)}
                style={{
                  flex: 1, backgroundColor: tc.surfaceRaised,
                  paddingVertical: 10, borderRadius: 10,
                  borderWidth: 1, borderColor: tc.border,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: tc.textSecondary, fontWeight: '700', fontSize: 13 }}>
                  Keep current
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}
