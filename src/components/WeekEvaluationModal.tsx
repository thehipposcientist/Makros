/**
 * WeekEvaluationModal — AI critique of the current/most-recent workout
 * week. Mirrors MealDayEvaluationModal in structure: headline + summary
 * + color-coded observations + concrete suggestions for next week.
 *
 * Pro-only on the backend; the parent should hide the trigger for
 * free users. Read-only: any state changes flow through
 * /coach/apply-action.
 */
import { useEffect, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, ScrollView, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import {
  evaluateWeek,
  type WeekEvaluation,
} from '../services/api';


interface Props {
  visible: boolean;
  themeName?: AppThemeName;
  authToken: string | null;
  /** Optional ISO end-date (YYYY-MM-DD) — defaults to today on the
   *  backend so most callers omit it. Pass when evaluating a specific
   *  past week (e.g. an old PlanWeek's end_date). */
  endDate?: string | null;
  onClose: () => void;
}

export default function WeekEvaluationModal({
  visible, themeName, authToken, endDate, onClose,
}: Props) {
  const tc = getTheme(themeName).colors;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WeekEvaluation | null>(null);

  useEffect(() => {
    if (!visible) {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (!authToken) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    evaluateWeek(authToken, endDate ? { end_date: endDate } : {})
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.message ?? 'Could not evaluate. Try again later.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [visible, authToken, endDate]);

  const obsColor = (kind: string): string => {
    if (kind === 'win') return '#10B981';
    if (kind === 'gap') return tc.error ?? '#EF4444';
    return tc.textMuted;
  };
  const obsIcon = (kind: string): string => {
    if (kind === 'win') return 'checkmark-circle';
    if (kind === 'gap') return 'alert-circle';
    return 'information-circle';
  };

  const review = result?._payload?.review;
  const isManual = result?._payload?.mode === 'manual';

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
                AI week evaluation
              </Text>
              {isManual && (
                <View style={{
                  paddingVertical: 1, paddingHorizontal: 6, borderRadius: 6,
                  backgroundColor: tc.primary + '22',
                }}>
                  <Text style={{ fontSize: 9, fontWeight: '800', color: tc.primary, letterSpacing: 0.3 }}>
                    MANUAL
                  </Text>
                </View>
              )}
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={22} color={tc.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={{ padding: 18, gap: 14 }}>
            {loading && (
              <View style={{ alignItems: 'center', paddingVertical: 30, gap: 10 }}>
                <ActivityIndicator color={tc.primary} />
                <Text style={{ fontSize: 12, color: tc.textMuted }}>Reading your week…</Text>
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

                {review && (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    <View style={{
                      paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12,
                      backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                    }}>
                      <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textPrimary }}>
                        {review.sessions_completed ?? 0}/{review.sessions_planned ?? 0} sessions
                      </Text>
                    </View>
                    {typeof review.adherence_pct === 'number' && (
                      <View style={{
                        paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12,
                        backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                      }}>
                        <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textPrimary }}>
                          {Math.round(review.adherence_pct)}% adherence
                        </Text>
                      </View>
                    )}
                    {typeof review.cardio_minutes === 'number' && review.cardio_minutes > 0 && (
                      <View style={{
                        paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12,
                        backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                      }}>
                        <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textPrimary }}>
                          {Math.round(review.cardio_minutes)} min cardio
                        </Text>
                      </View>
                    )}
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
                      FOR NEXT WEEK
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
