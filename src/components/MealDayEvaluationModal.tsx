/**
 * MealDayEvaluationModal — shows the AI's critique of one logged
 * meal day. Triggered by the "Evaluate this day" button on the meal
 * card. Pro-only on the backend; the parent should hide the trigger
 * for free users.
 *
 * Calls /coach/evaluate-meal-day on open and renders three sections:
 *   - Headline + summary
 *   - Observations (wins / gaps / notes, color-coded)
 *   - Suggestions (concrete next-day actions)
 */
import { useEffect, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, ScrollView, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import {
  evaluateMealDay,
  type MealDayEvaluation,
} from '../services/api';


interface Props {
  visible: boolean;
  themeName?: AppThemeName;
  authToken: string | null;
  /** YYYY-MM-DD — the day to evaluate. */
  targetDate: string | null;
  /** Optional: pass the user's currently displayed daily targets so the
   *  AI sees exactly what's on screen and the critique can't drift. */
  targets?: { calories: number; protein_g: number; carbs_g: number; fat_g: number } | null;
  onClose: () => void;
}

export default function MealDayEvaluationModal({
  visible, themeName, authToken, targetDate, targets, onClose,
}: Props) {
  const tc = getTheme(themeName).colors;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MealDayEvaluation | null>(null);

  useEffect(() => {
    if (!visible) {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (!authToken || !targetDate) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    evaluateMealDay(authToken, {
      target_date: targetDate,
      targets: targets ?? undefined,
    })
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.message ?? 'Could not evaluate. Try again later.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [visible, authToken, targetDate, targets]);

  const obsColor = (kind: string): string => {
    if (kind === 'win') return '#10B981';      // green
    if (kind === 'gap') return tc.error ?? '#EF4444';
    return tc.textMuted;
  };
  const obsIcon = (kind: string): string => {
    if (kind === 'win') return 'checkmark-circle';
    if (kind === 'gap') return 'alert-circle';
    return 'information-circle';
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#0009', justifyContent: 'center', padding: 20 }}>
        <View style={{
          backgroundColor: tc.background, borderRadius: radius.lg,
          borderWidth: 1, borderColor: tc.border, maxHeight: '85%',
        }}>
          <View style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            padding: 18, borderBottomWidth: 1, borderBottomColor: tc.border,
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name="sparkles-outline" size={18} color={tc.primary} />
              <Text style={{ fontSize: 16, fontWeight: '800', color: tc.textPrimary }}>
                AI day evaluation
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={22} color={tc.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={{ padding: 18, gap: 14 }}>
            {loading && (
              <View style={{ alignItems: 'center', paddingVertical: 30, gap: 10 }}>
                <ActivityIndicator color={tc.primary} />
                <Text style={{ fontSize: 12, color: tc.textMuted }}>Reading your day…</Text>
              </View>
            )}

            {error && !loading && (
              <View style={{
                padding: 14, borderRadius: radius.md, borderWidth: 1,
                borderColor: (tc.error ?? '#EF4444') + '55',
                backgroundColor: (tc.error ?? '#EF4444') + '10',
              }}>
                <Text style={{ fontSize: 13, color: tc.error ?? '#EF4444' }}>{error}</Text>
              </View>
            )}

            {result && !loading && (
              <>
                <View>
                  <Text style={{ fontSize: 15, fontWeight: '800', color: tc.textPrimary }}>
                    {result.headline}
                  </Text>
                  {result.summary ? (
                    <Text style={{ fontSize: 13, color: tc.textSecondary, marginTop: 8, lineHeight: 19 }}>
                      {result.summary}
                    </Text>
                  ) : null}
                </View>

                {result._payload && (
                  <View style={{
                    flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingTop: 4,
                  }}>
                    {(['calories', 'protein_g', 'carbs_g', 'fat_g'] as const).map((k) => {
                      const target = result._payload!.targets[k] ?? 0;
                      const actual = result._payload!.actuals[k] ?? 0;
                      const label = k === 'calories' ? 'cal'
                        : k === 'protein_g' ? 'P'
                        : k === 'carbs_g' ? 'C' : 'F';
                      const pct = target > 0 ? Math.round((actual / target) * 100) : null;
                      return (
                        <View key={k} style={{
                          paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12,
                          backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                        }}>
                          <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textPrimary }}>
                            {label} {Math.round(actual)}/{Math.round(target)}{pct != null ? ` · ${pct}%` : ''}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                )}

                {result.observations.length > 0 && (
                  <View style={{ gap: 6 }}>
                    <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.5 }}>
                      OBSERVATIONS
                    </Text>
                    {result.observations.map((o, idx) => (
                      <View key={idx} style={{
                        flexDirection: 'row', gap: 8, alignItems: 'flex-start',
                        padding: 10, borderRadius: radius.md,
                        backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                      }}>
                        <Ionicons name={obsIcon(o.kind) as any} size={16} color={obsColor(o.kind)} />
                        <Text style={{ flex: 1, fontSize: 13, color: tc.textPrimary, lineHeight: 18 }}>
                          {o.text}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}

                {result.suggestions.length > 0 && (
                  <View style={{ gap: 6 }}>
                    <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.5 }}>
                      FOR TOMORROW
                    </Text>
                    {result.suggestions.map((s, idx) => (
                      <View key={idx} style={{
                        flexDirection: 'row', gap: 8, alignItems: 'flex-start',
                        padding: 10, borderRadius: radius.md,
                        backgroundColor: tc.primary + '0E', borderWidth: 1, borderColor: tc.primary + '44',
                      }}>
                        <Ionicons name="arrow-forward-circle-outline" size={16} color={tc.primary} />
                        <Text style={{ flex: 1, fontSize: 13, color: tc.textPrimary, lineHeight: 18 }}>
                          {s}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
