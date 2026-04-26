// Weekly check-in — the BIG once-a-week moment.
//
// Shows on Sunday/Monday morning automatically (HomeScreen handles
// the auto-show gate via AsyncStorage). Pulls Apple Health signals
// from the cached health summary, hands them to the backend, and
// renders the gpt-5-mini-composed narrative on top of the
// deterministic weekly review.
//
// Sections (top to bottom):
//   1. Hero — AI-written 2-3 sentence read of the week
//   2. Apple Health pulse — sleep / RHR / HRV / steps if available
//   3. Wins (1-3 cards)
//   4. Needs attention (1-3 cards)
//   5. Recommendations as checkboxes (warn pre-checked, suggest opt-in)
//   6. Single CTA: "Apply N changes & rebuild plan"
//
// The whole thing is wrapped in a dark-overlay sheet that takes
// ~85% of the screen height — feels premium, not like a popup.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Modal,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Animated,
  Dimensions,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { getTheme, radius } from '../constants/theme';
import type { AppThemeName } from '../types';
import {
  getWeeklyCheckinNarrative,
  applyBulkRecommendations,
  WeeklyCheckinNarrative,
  WeeklyNarrativeRec,
} from '../services/api';
import { getCachedHealthDataSummary } from '../services/healthDataSummary';

interface Props {
  visible: boolean;
  authToken: string;
  themeName?: AppThemeName;
  /** Called after the user taps Apply (or skips). The parent should
   *  kick a plan regen if `applied=true && needs_regen=true`. */
  onClose: (result?: { applied: boolean; needsRegen: boolean }) => void;
}

const { height: SCREEN_H } = Dimensions.get('window');

export default function WeeklyCheckinModal({ visible, authToken, themeName, onClose }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const styles = useMemo(() => createStyles(tc), [tc]);

  const [loading, setLoading] = useState(true);
  const [narrative, setNarrative] = useState<WeeklyCheckinNarrative | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  // Per-rec checked state keyed by rec.key. Defaults set when the
  // narrative loads: warn pre-checked, suggest unchecked, info also
  // unchecked (info recs are usually advice-only with noop actions).
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  // Slide-up enter animation. Cinematic for a once-a-week moment.
  const slideAnim = useRef(new Animated.Value(SCREEN_H)).current;
  useEffect(() => {
    if (visible) {
      Animated.spring(slideAnim, {
        toValue: 0, useNativeDriver: true, tension: 50, friction: 10,
      }).start();
    } else {
      slideAnim.setValue(SCREEN_H);
    }
  }, [visible, slideAnim]);

  // Fetch narrative the moment we become visible. Pulls Apple Health
  // from the cached aggregator — no extra HK reads.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNarrative(null);
    (async () => {
      try {
        const cached = await getCachedHealthDataSummary().catch(() => null);
        const sleepHours = cached?.sleepMinutes != null ? cached.sleepMinutes / 60 : null;
        const ah = {
          avgSleepHours: sleepHours,
          avgRestingHr: cached?.restingHeartRate ?? null,
          avgHrvMs: cached?.hrv ?? null,
          avgSteps: cached?.steps ?? null,
          vo2Max: cached?.vo2Max ?? null,
        };
        const data = await getWeeklyCheckinNarrative(authToken, ah);
        if (cancelled) return;
        setNarrative(data);
        // Pre-check warn-priority recs. Suggest/info opt-in.
        const initial: Record<string, boolean> = {};
        for (const r of data.recommendations) {
          initial[r.key] = r.priority === 'warn' && !!r.action?.type && r.action.type !== 'noop';
        }
        setChecked(initial);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'Could not load your check-in.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [visible, authToken]);

  const checkedRecs = useMemo<WeeklyNarrativeRec[]>(() => {
    if (!narrative) return [];
    return narrative.recommendations.filter(r => checked[r.key] && r.action?.type && r.action.type !== 'noop');
  }, [narrative, checked]);

  const dismissNoApply = () => {
    onClose({ applied: false, needsRegen: false });
  };

  const handleApply = async () => {
    if (checkedRecs.length === 0) {
      // Nothing checked — treat as a soft "stay the course" close.
      try { Haptics.selectionAsync(); } catch {}
      onClose({ applied: false, needsRegen: false });
      return;
    }
    setApplying(true);
    try {
      const result = await applyBulkRecommendations(
        authToken,
        checkedRecs.map(r => ({ action: r.action, rec_key: r.key })),
      );
      try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
      Alert.alert(
        result.failed_count > 0 ? 'Mostly applied' : 'Applied',
        result.summary,
        [{ text: 'OK', onPress: () => onClose({ applied: result.applied_count > 0, needsRegen: result.needs_regen }) }],
      );
    } catch (e: any) {
      try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); } catch {}
      Alert.alert('Could not apply', e?.message ?? 'Try again in a moment.');
    } finally {
      setApplying(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────────

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={dismissNoApply}>
      <View style={styles.backdrop}>
        <Animated.View style={[styles.sheet, { transform: [{ translateY: slideAnim }] }]}>
          <View style={styles.handle} />
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.eyebrow}>WEEKLY CHECK-IN</Text>
              <Text style={styles.title}>Your week, read by the coach</Text>
            </View>
            <TouchableOpacity onPress={dismissNoApply} hitSlop={12} style={styles.closeBtn}>
              <Ionicons name="close" size={22} color={tc.textSecondary} />
            </TouchableOpacity>
          </View>

          {loading ? (
            <View style={styles.loadingBlock}>
              <ActivityIndicator size="large" color={tc.primary} />
              <Text style={styles.loadingText}>Composing your week…</Text>
            </View>
          ) : error ? (
            <View style={styles.errorBlock}>
              <Ionicons name="cloud-offline-outline" size={28} color={tc.textMuted} />
              <Text style={styles.errorText}>{error}</Text>
              <TouchableOpacity style={styles.secondaryBtn} onPress={dismissNoApply}>
                <Text style={styles.secondaryBtnText}>Dismiss</Text>
              </TouchableOpacity>
            </View>
          ) : narrative ? (
            <>
              <ScrollView
                style={styles.scroll}
                contentContainerStyle={{ paddingBottom: 16 }}
                showsVerticalScrollIndicator={false}>
                {/* Hero summary — the personalized read */}
                <View style={styles.heroBlock}>
                  <Text style={styles.heroText}>{narrative.hero_summary || narrative.headline}</Text>
                  {narrative.narrative_source === 'fallback' && (
                    <Text style={styles.fallbackHint}>
                      Coach is offline — showing the deterministic read.
                    </Text>
                  )}
                </View>

                {/* Apple Health pulse */}
                <HealthPulse metrics={narrative.metrics} tc={tc} styles={styles} />

                {/* Wins */}
                {narrative.wins.length > 0 && (
                  <View style={styles.section}>
                    <Text style={styles.sectionLabel}>WHAT WORKED</Text>
                    {narrative.wins.map((w, i) => (
                      <View key={i} style={[styles.factCard, { borderLeftColor: tc.success }]}>
                        <Text style={styles.factTitle}>{w.title}</Text>
                        {w.detail ? <Text style={styles.factDetail}>{w.detail}</Text> : null}
                      </View>
                    ))}
                  </View>
                )}

                {/* Needs attention */}
                {narrative.needs_attention.length > 0 && (
                  <View style={styles.section}>
                    <Text style={styles.sectionLabel}>WHAT NEEDS ATTENTION</Text>
                    {narrative.needs_attention.map((n, i) => (
                      <View key={i} style={[styles.factCard, { borderLeftColor: tc.warning }]}>
                        <Text style={styles.factTitle}>{n.title}</Text>
                        {n.detail ? <Text style={styles.factDetail}>{n.detail}</Text> : null}
                      </View>
                    ))}
                  </View>
                )}

                {/* Recommendations as checkboxes */}
                {narrative.recommendations.length > 0 && (
                  <View style={styles.section}>
                    <Text style={styles.sectionLabel}>
                      RECOMMENDED CHANGES · TAP TO TOGGLE
                    </Text>
                    {narrative.recommendations.map(rec => {
                      const isApplyable = !!rec.action?.type && rec.action.type !== 'noop';
                      const isChecked = !!checked[rec.key];
                      const priorityColor =
                        rec.priority === 'warn' ? tc.error
                        : rec.priority === 'suggest' ? tc.warning
                        : tc.primary;
                      return (
                        <TouchableOpacity
                          key={rec.key}
                          activeOpacity={isApplyable ? 0.75 : 1}
                          onPress={() => {
                            if (!isApplyable) return;
                            try { Haptics.selectionAsync(); } catch {}
                            setChecked(prev => ({ ...prev, [rec.key]: !prev[rec.key] }));
                          }}
                          style={[
                            styles.recRow,
                            isChecked && styles.recRowChecked,
                            !isApplyable && { opacity: 0.6 },
                          ]}>
                          <View style={[
                            styles.checkbox,
                            isChecked && { backgroundColor: priorityColor, borderColor: priorityColor },
                          ]}>
                            {isChecked && <Ionicons name="checkmark" size={14} color="#fff" />}
                          </View>
                          <View style={{ flex: 1 }}>
                            <View style={styles.recTitleRow}>
                              <Text style={[styles.recPriority, { color: priorityColor }]}>
                                {rec.priority.toUpperCase()}
                                {rec.personalized ? ' · TAILORED' : ''}
                              </Text>
                              {!isApplyable && (
                                <Text style={styles.adviceTag}>ADVICE</Text>
                              )}
                            </View>
                            <Text style={styles.recTitle}>{rec.title}</Text>
                            {rec.detail ? (
                              <Text style={styles.recDetail}>{rec.detail}</Text>
                            ) : null}
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}

                {/* Closer */}
                {narrative.closer ? (
                  <View style={styles.closerBlock}>
                    <Text style={styles.closerText}>{narrative.closer}</Text>
                  </View>
                ) : null}
              </ScrollView>

              {/* Sticky CTA */}
              <View style={styles.ctaBar}>
                <TouchableOpacity
                  style={styles.skipBtn}
                  onPress={dismissNoApply}
                  disabled={applying}>
                  <Text style={styles.skipBtnText}>Skip</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.applyBtn,
                    { backgroundColor: checkedRecs.length > 0 ? tc.primary : tc.surfaceRaised },
                  ]}
                  onPress={handleApply}
                  disabled={applying}
                  activeOpacity={0.85}>
                  {applying ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={[
                      styles.applyBtnText,
                      { color: checkedRecs.length > 0 ? '#fff' : tc.textSecondary },
                    ]}>
                      {checkedRecs.length === 0
                        ? 'Stay the course'
                        : `Apply ${checkedRecs.length} change${checkedRecs.length === 1 ? '' : 's'} & rebuild plan`}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            </>
          ) : null}
        </Animated.View>
      </View>
    </Modal>
  );
}


// ── Apple Health pulse strip ─────────────────────────────────────

function HealthPulse({
  metrics, tc, styles,
}: { metrics: any; tc: any; styles: any }) {
  const pulses: Array<{ icon: any; label: string; value: string }> = [];
  if (metrics?.avg_sleep_hours != null) {
    pulses.push({ icon: 'moon-outline', label: 'Sleep avg',
                  value: `${metrics.avg_sleep_hours.toFixed(1)}h` });
  }
  if (metrics?.avg_resting_hr != null) {
    pulses.push({ icon: 'heart-outline', label: 'RHR',
                  value: `${Math.round(metrics.avg_resting_hr)} bpm` });
  }
  if (metrics?.avg_hrv_ms != null) {
    pulses.push({ icon: 'pulse-outline', label: 'HRV',
                  value: `${Math.round(metrics.avg_hrv_ms)} ms` });
  }
  if (metrics?.weight_trend?.slope_lbs_per_week != null) {
    const s = metrics.weight_trend.slope_lbs_per_week;
    const sign = s > 0 ? '+' : '';
    pulses.push({ icon: 'scale-outline', label: 'Weight / wk',
                  value: `${sign}${s.toFixed(1)} lb` });
  }
  if (pulses.length === 0) return null;
  return (
    <View style={styles.pulseRow}>
      {pulses.map((p, i) => (
        <View key={i} style={styles.pulseTile}>
          <Ionicons name={p.icon} size={14} color={tc.primary} />
          <Text style={styles.pulseLabel}>{p.label}</Text>
          <Text style={styles.pulseValue}>{p.value}</Text>
        </View>
      ))}
    </View>
  );
}


// ── Styles ───────────────────────────────────────────────────────

function createStyles(tc: any) {
  return StyleSheet.create({
    backdrop: {
      flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: tc.background,
      borderTopLeftRadius: 28, borderTopRightRadius: 28,
      maxHeight: SCREEN_H * 0.92,
      paddingBottom: 0,
    },
    handle: {
      width: 40, height: 4, borderRadius: 2,
      backgroundColor: tc.border,
      alignSelf: 'center', marginTop: 10, marginBottom: 4,
    },
    headerRow: {
      flexDirection: 'row', alignItems: 'flex-start',
      paddingHorizontal: 22, paddingTop: 8, paddingBottom: 4,
    },
    eyebrow: {
      fontSize: 10, fontWeight: '800', letterSpacing: 1.4,
      color: tc.primary, marginBottom: 4,
    },
    title: {
      fontSize: 22, fontWeight: '900',
      color: tc.textPrimary, lineHeight: 28,
    },
    closeBtn: {
      width: 32, height: 32, borderRadius: 16,
      backgroundColor: tc.surface,
      alignItems: 'center', justifyContent: 'center',
    },
    loadingBlock: {
      paddingVertical: 60, alignItems: 'center',
    },
    loadingText: {
      marginTop: 14, color: tc.textSecondary, fontSize: 13,
    },
    errorBlock: {
      paddingVertical: 50, alignItems: 'center',
    },
    errorText: {
      marginTop: 12, color: tc.textSecondary, fontSize: 13,
      textAlign: 'center', paddingHorizontal: 30,
    },
    secondaryBtn: {
      marginTop: 16, paddingHorizontal: 20, paddingVertical: 10,
      backgroundColor: tc.surface, borderRadius: 10,
    },
    secondaryBtnText: {
      color: tc.textSecondary, fontWeight: '600', fontSize: 13,
    },

    scroll: {
      paddingHorizontal: 18,
    },

    // Hero
    heroBlock: {
      paddingVertical: 16,
      paddingHorizontal: 4,
    },
    heroText: {
      fontSize: 17, fontWeight: '600',
      color: tc.textPrimary, lineHeight: 24,
    },
    fallbackHint: {
      marginTop: 8, fontSize: 11,
      color: tc.textMuted, fontStyle: 'italic',
    },

    // Apple Health pulse
    pulseRow: {
      flexDirection: 'row', flexWrap: 'wrap', gap: 8,
      marginBottom: 16,
    },
    pulseTile: {
      flexBasis: '47%', flexGrow: 1,
      backgroundColor: tc.surface,
      borderRadius: 12, padding: 10,
      borderWidth: 1, borderColor: tc.border,
    },
    pulseLabel: {
      fontSize: 9, fontWeight: '800', letterSpacing: 0.6,
      color: tc.textMuted, marginTop: 4,
    },
    pulseValue: {
      fontSize: 16, fontWeight: '900',
      color: tc.textPrimary, marginTop: 2,
    },

    // Section
    section: { marginBottom: 18 },
    sectionLabel: {
      fontSize: 10, fontWeight: '800', letterSpacing: 0.8,
      color: tc.textSecondary, marginBottom: 8,
    },

    // Wins / Gaps
    factCard: {
      backgroundColor: tc.surface,
      borderLeftWidth: 4, borderRadius: 10,
      padding: 12, marginBottom: 8,
    },
    factTitle: {
      fontSize: 14, fontWeight: '800',
      color: tc.textPrimary,
    },
    factDetail: {
      marginTop: 4, fontSize: 12, lineHeight: 17,
      color: tc.textSecondary,
    },

    // Rec checkbox row
    recRow: {
      flexDirection: 'row', alignItems: 'flex-start', gap: 10,
      backgroundColor: tc.surface,
      borderRadius: 12, padding: 12, marginBottom: 8,
      borderWidth: 1, borderColor: tc.border,
    },
    recRowChecked: {
      borderColor: tc.primary,
    },
    checkbox: {
      width: 22, height: 22, borderRadius: 6,
      borderWidth: 1.5, borderColor: tc.border,
      alignItems: 'center', justifyContent: 'center',
      marginTop: 2,
    },
    recTitleRow: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
    },
    recPriority: {
      fontSize: 9, fontWeight: '800', letterSpacing: 0.6,
    },
    adviceTag: {
      fontSize: 9, fontWeight: '700', letterSpacing: 0.6,
      color: tc.textMuted,
      backgroundColor: tc.surfaceRaised,
      paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4,
    },
    recTitle: {
      marginTop: 3, fontSize: 14, fontWeight: '700',
      color: tc.textPrimary,
    },
    recDetail: {
      marginTop: 3, fontSize: 12, lineHeight: 17,
      color: tc.textSecondary,
    },

    // Closer
    closerBlock: {
      backgroundColor: tc.surface,
      padding: 14, borderRadius: 12,
      marginTop: 4,
    },
    closerText: {
      fontSize: 13, lineHeight: 19, fontStyle: 'italic',
      color: tc.textSecondary,
    },

    // Sticky CTA bar
    ctaBar: {
      flexDirection: 'row', gap: 10,
      paddingHorizontal: 18,
      paddingTop: 12, paddingBottom: 22,
      borderTopWidth: 1, borderTopColor: tc.border,
      backgroundColor: tc.background,
    },
    skipBtn: {
      paddingHorizontal: 16, paddingVertical: 14,
      borderRadius: 12, backgroundColor: tc.surface,
      borderWidth: 1, borderColor: tc.border,
    },
    skipBtnText: {
      color: tc.textSecondary, fontWeight: '700', fontSize: 14,
    },
    applyBtn: {
      flex: 1, paddingVertical: 14,
      borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    },
    applyBtnText: {
      fontSize: 14, fontWeight: '800', letterSpacing: 0.3,
    },
  });
}
