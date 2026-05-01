// Supplement Stack V1 — Today / My Stack / Recommendations sections.
//
// Principles:
//   • Cautious language throughout ("may support", "consider"). Never
//     claims ("fixes", "boosts", "treats").
//   • Evidence + risk tiers visible on every stack card.
//   • Recommendations driven by food-side gaps from the 14-day rollup,
//     not generic marketing.
//   • Warnings (late caffeine, stimulant stacking, duplicates) surface
//     as insights, not as a separate medical panel.
//
// This screen replaces the old EditProfileScreen-based Supps tab.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Alert, ActivityIndicator,
  Modal, TextInput, StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme } from '../constants/theme';
import { AppThemeName } from '../types';
import * as api from '../services/api';

interface Props {
  authToken: string;
  themeName?: AppThemeName;
}

type Section = 'today' | 'stack' | 'recommendations';

// Tier→color maps derive from theme so evidence/risk pills match the
// active palette. Built fresh per render inside components (tc is
// scoped). Blue "moderate evidence" maps to primaryLight — closest
// semantic on most themes; falls back to muted gray for "weak".
function tierColors(tc: ReturnType<typeof getTheme>['colors']) {
  return {
    evidence: {
      strong:   tc.success,
      moderate: tc.primaryLight ?? tc.primary,
      limited:  tc.warning,
      weak:     tc.textMuted,
    } as Record<string, string>,
    risk: {
      low:      tc.success,
      moderate: tc.warning,
      high:     tc.error,
    } as Record<string, string>,
  };
}

function Pill({ label, color, onDark = false }: { label: string; color: string; onDark?: boolean }) {
  return (
    <View style={{
      backgroundColor: color + (onDark ? '33' : '1A'),
      paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
      alignSelf: 'flex-start',
    }}>
      <Text style={{ fontSize: 10, fontWeight: '700', color, letterSpacing: 0.3 }}>{label}</Text>
    </View>
  );
}

export default function SupplementStackScreen({ authToken, themeName }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const tiers = useMemo(() => tierColors(tc), [tc]);

  const [section, setSection] = useState<Section>('today');
  const [loading, setLoading] = useState(false);
  const [today, setToday] = useState<api.TodayStackItem[]>([]);
  const [stack, setStack] = useState<api.StackItem[]>([]);
  const [ingredients, setIngredients] = useState<api.SupplementIngredient[]>([]);
  const [recs, setRecs] = useState<api.SupplementRecommendation[]>([]);
  const [insights, setInsights] = useState<Array<{ key: string; severity: string; title: string; body: string }>>([]);
  const [showAdd, setShowAdd] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [t, s, ing, r, ins] = await Promise.all([
        api.getTodaySupplements(authToken).catch(() => []),
        api.listStack(authToken).catch(() => []),
        api.listSupplementIngredients().catch(() => []),
        api.getSupplementRecommendations(authToken).catch(() => ({ recommendations: [], warnings: { duplicate_ingredient_ids: [] } })),
        api.getSupplementInsights(authToken).catch(() => ({ insights: [] })),
      ]);
      setToday(t); setStack(s); setIngredients(ing);
      setRecs(r.recommendations || []);
      setInsights(ins.insights || []);
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => { reload(); }, [reload]);

  const handleMarkTaken = async (item: api.TodayStackItem, skipped = false) => {
    try {
      await api.logDose(authToken, item.id, { skipped });
      reload();
    } catch (e: any) {
      Alert.alert('Could not log', String(e?.message ?? e));
    }
  };

  const [takingAll, setTakingAll] = useState(false);
  const [skippingAll, setSkippingAll] = useState(false);
  const handleTakeAll = async () => {
    // Pending = scheduled today but not yet logged (taken or skipped).
    // We only flip those so a previously-skipped item isn't silently
    // converted into a "taken" by the bulk button.
    const pending = today.filter(item => {
      const logs = item.logs_today || [];
      return !logs.find(l => !l.skipped) && !logs.find(l => l.skipped);
    });
    if (pending.length === 0) return;
    setTakingAll(true);
    try {
      // Serial so the backend's timestamps don't collide and the
      // logs_today echo back in a predictable order.
      for (const item of pending) {
        await api.logDose(authToken, item.id, { skipped: false }).catch(() => null);
      }
      import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
      reload();
    } catch (e: any) {
      Alert.alert('Could not log', String(e?.message ?? e));
    } finally {
      setTakingAll(false);
    }
  };
  const handleSkipAll = async () => {
    const pending = today.filter(item => {
      const logs = item.logs_today || [];
      return !logs.find(l => !l.skipped) && !logs.find(l => l.skipped);
    });
    if (pending.length === 0) return;
    setSkippingAll(true);
    try {
      for (const item of pending) {
        await api.logDose(authToken, item.id, { skipped: true }).catch(() => null);
      }
      import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
      reload();
    } catch (e: any) {
      Alert.alert('Could not skip', String(e?.message ?? e));
    } finally {
      setSkippingAll(false);
    }
  };

  // ── Group helpers ────────────────────────────────────────────────
  // A "group" is either the user's custom group_label OR the built-in
  // timing bucket. Items with neither fall under "Other" so the screen
  // still renders cleanly. Groups display in a stable order so morning
  // shows before evening, etc.
  const TIMING_ORDER: Record<string, number> = {
    morning: 0, pre_workout: 1, with_meal: 2, evening: 3,
  };
  const titleCase = (s: string): string =>
    s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  type GroupKey = { kind: 'custom' | 'timing' | 'other'; key: string; label: string; items: api.TodayStackItem[] };
  const buildGroups = (items: api.TodayStackItem[]): GroupKey[] => {
    const groups = new Map<string, GroupKey>();
    for (const it of items) {
      const customGroup = (it.group_label ?? '').toString().trim();
      const timingBucket = (it.timing ?? '').toString().trim();
      let kind: GroupKey['kind'];
      let key: string;
      let label: string;
      if (customGroup) {
        kind = 'custom'; key = `c:${customGroup.toLowerCase()}`; label = customGroup;
      } else if (timingBucket) {
        kind = 'timing'; key = `t:${timingBucket}`; label = titleCase(timingBucket);
      } else {
        kind = 'other'; key = 'other'; label = 'Other';
      }
      const existing = groups.get(key);
      if (existing) existing.items.push(it);
      else groups.set(key, { kind, key, label, items: [it] });
    }
    return Array.from(groups.values()).sort((a, b) => {
      // Custom groups float to top (they're more intentional).
      if (a.kind !== b.kind) {
        const order = { custom: 0, timing: 1, other: 2 };
        return order[a.kind] - order[b.kind];
      }
      if (a.kind === 'timing' && b.kind === 'timing') {
        const ka = a.key.replace('t:', '');
        const kb = b.key.replace('t:', '');
        return (TIMING_ORDER[ka] ?? 99) - (TIMING_ORDER[kb] ?? 99);
      }
      return a.label.localeCompare(b.label);
    });
  };

  const [takingGroupKey, setTakingGroupKey] = useState<string | null>(null);
  const handleTakeGroup = async (group: GroupKey) => {
    const pending = group.items.filter(i => {
      const logs = i.logs_today || [];
      return !logs.find(l => !l.skipped) && !logs.find(l => l.skipped);
    });
    if (pending.length === 0) return;
    setTakingGroupKey(group.key);
    try {
      // Use the dedicated bulk endpoint when possible — single roundtrip
      // and the backend dedupes against today's existing logs. Falls
      // through to per-item logs only if the bulk call fails.
      try {
        if (group.kind === 'custom') {
          await api.logSupplementGroup(authToken, { group_label: group.label });
        } else if (group.kind === 'timing') {
          await api.logSupplementGroup(authToken, { timing: group.key.replace('t:', '') });
        } else {
          throw new Error('use per-item fallback');
        }
      } catch {
        for (const item of pending) {
          await api.logDose(authToken, item.id, { skipped: false }).catch(() => null);
        }
      }
      import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
      reload();
    } catch (e: any) {
      Alert.alert('Could not log group', String(e?.message ?? e));
    } finally {
      setTakingGroupKey(null);
    }
  };

  const handleRemove = (item: api.StackItem) => {
    Alert.alert(
      'Remove from stack?',
      `"${item.custom_name || 'Supplement'}" will no longer appear in Today.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove', style: 'destructive', onPress: async () => {
            try { await api.deleteStackItem(authToken, item.id); reload(); }
            catch (e: any) { Alert.alert('Could not remove', String(e?.message ?? e)); }
          },
        },
      ],
    );
  };

  // ─── Section renderers ──────────────────────────────────────────────

  const renderToday = () => {
    if (today.length === 0) {
      return (
        <View style={{ padding: 20, alignItems: 'center' }}>
          <Ionicons name="medical-outline" size={32} color={tc.textMuted} style={{ marginBottom: 8 }} />
          <Text style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center' }}>
            Nothing scheduled for today.
          </Text>
          <Text style={{ fontSize: 11, color: tc.textMuted, textAlign: 'center', marginTop: 4 }}>
            Add items to your stack — daily / weekday scheduled ones will show up here.
          </Text>
        </View>
      );
    }
    const pendingCount = today.filter(item => {
      const logs = item.logs_today || [];
      return !logs.find(l => !l.skipped) && !logs.find(l => l.skipped);
    }).length;
    return (
      <View style={{ gap: 8 }}>
        {pendingCount > 1 && (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity
              onPress={handleTakeAll}
              disabled={takingAll || skippingAll}
              style={{
                flex: 2,
                flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
                paddingVertical: 12, borderRadius: 12,
                backgroundColor: tc.primary,
                opacity: takingAll || skippingAll ? 0.6 : 1,
              }}>
              {takingAll ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="checkmark-done" size={18} color="#fff" />
              )}
              <Text style={{ fontSize: 14, fontWeight: '800', color: '#fff' }}>
                {takingAll ? 'Logging…' : `Take all (${pendingCount})`}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSkipAll}
              disabled={takingAll || skippingAll}
              style={{
                flex: 1,
                flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                paddingVertical: 12, borderRadius: 12,
                backgroundColor: tc.surfaceRaised,
                borderWidth: 1, borderColor: tc.border,
                opacity: takingAll || skippingAll ? 0.6 : 1,
              }}>
              {skippingAll ? (
                <ActivityIndicator size="small" color={tc.textSecondary} />
              ) : (
                <Ionicons name="close" size={18} color={tc.textSecondary} />
              )}
              <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textSecondary }}>
                {skippingAll ? 'Skipping…' : 'Skip all'}
              </Text>
            </TouchableOpacity>
          </View>
        )}
        {buildGroups(today).map((group) => {
          const groupPending = group.items.filter(i => {
            const logs = i.logs_today || [];
            return !logs.find(l => !l.skipped) && !logs.find(l => l.skipped);
          }).length;
          const isLogging = takingGroupKey === group.key;
          return (
            <View key={group.key} style={{ gap: 6, marginTop: 4 }}>
              {/* Group header — label + (when group has 2+ items) a
                  one-tap "Take group" button so users can log a whole
                  pack at once instead of marking each. */}
              <View style={{
                flexDirection: 'row', alignItems: 'center',
                justifyContent: 'space-between',
                paddingHorizontal: 4, paddingTop: 4,
              }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={{
                    fontSize: 11, fontWeight: '800', color: tc.textMuted,
                    letterSpacing: 0.6, textTransform: 'uppercase',
                  }}>
                    {group.label}
                  </Text>
                  <Text style={{ fontSize: 10, color: tc.textMuted }}>
                    · {group.items.length}
                  </Text>
                </View>
                {group.items.length >= 2 && groupPending > 0 && (
                  <TouchableOpacity
                    onPress={() => handleTakeGroup(group)}
                    disabled={isLogging}
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: 4,
                      paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12,
                      backgroundColor: tc.primary + '1F',
                      borderWidth: 1, borderColor: tc.primary + '88',
                      opacity: isLogging ? 0.6 : 1,
                    }}
                  >
                    {isLogging
                      ? <ActivityIndicator size="small" color={tc.primary} />
                      : <Ionicons name="checkmark-done" size={12} color={tc.primary} />}
                    <Text style={{ fontSize: 10, fontWeight: '800', color: tc.primary }}>
                      {isLogging ? 'Logging…' : `Take ${groupPending}`}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
              {group.items.map(item => {
                const logs = item.logs_today || [];
                const taken = logs.find(l => !l.skipped);
                const skipped = !taken && logs.find(l => l.skipped);
                return (
                  <View key={item.id} style={{
                    backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                    borderRadius: 12, padding: 12,
                  }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <View style={{
                        width: 36, height: 36, borderRadius: 18,
                        backgroundColor: taken ? tc.success + '22' : skipped ? tc.border : tc.surfaceRaised,
                        alignItems: 'center', justifyContent: 'center',
                      }}>
                        <Ionicons
                          name={taken ? 'checkmark' : skipped ? 'close' : 'time-outline'}
                          size={18}
                          color={taken ? tc.success : skipped ? tc.textMuted : tc.textSecondary}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }} numberOfLines={1}>
                          {item.custom_name || 'Supplement'}
                        </Text>
                        <Text style={{ fontSize: 11, color: tc.textMuted }}>
                          {item.dose_amount}{item.dose_unit}
                          {item.timing ? ` · ${item.timing.replace(/_/g, ' ')}` : ''}
                          {taken ? ` · Taken ${new Date(taken.taken_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}
                        </Text>
                      </View>
                      {!taken && !skipped && (
                        <>
                          <TouchableOpacity
                            onPress={() => handleMarkTaken(item, false)}
                            style={{
                              paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8,
                              backgroundColor: tc.primary,
                            }}
                          >
                            <Text style={{ fontSize: 11, fontWeight: '700', color: '#fff' }}>Mark taken</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={() => handleMarkTaken(item, true)}
                            style={{
                              paddingVertical: 6, paddingHorizontal: 8,
                            }}
                          >
                            <Text style={{ fontSize: 11, fontWeight: '600', color: tc.textMuted }}>Skip</Text>
                          </TouchableOpacity>
                        </>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          );
        })}
        {insights.length > 0 && (
          <View style={{ marginTop: 12, gap: 8 }}>
            {insights.map(ins => (
              <View key={ins.key} style={{
                backgroundColor: ins.severity === 'warning' ? tc.warning + '1A' : tc.surface,
                borderWidth: 1,
                borderColor: ins.severity === 'warning' ? tc.warning + '55' : tc.border,
                borderRadius: 10, padding: 12, flexDirection: 'row', gap: 10,
              }}>
                <Ionicons
                  name={ins.severity === 'warning' ? 'warning-outline' : 'information-circle-outline'}
                  size={18}
                  color={ins.severity === 'warning' ? tc.warning : tc.primary}
                />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary, marginBottom: 2 }}>{ins.title}</Text>
                  <Text style={{ fontSize: 11, color: tc.textSecondary, lineHeight: 16 }}>{ins.body}</Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </View>
    );
  };

  const renderStack = () => {
    if (stack.length === 0) {
      return (
        <View style={{ padding: 20, alignItems: 'center' }}>
          <Ionicons name="medical-outline" size={32} color={tc.textMuted} style={{ marginBottom: 8 }} />
          <Text style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center' }}>Your stack is empty.</Text>
          <Text style={{ fontSize: 11, color: tc.textMuted, textAlign: 'center', marginTop: 4, marginBottom: 12 }}>
            Tap "Add supplement" to get started.
          </Text>
          <TouchableOpacity
            onPress={() => setShowAdd(true)}
            style={{ backgroundColor: tc.primary, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10 }}
          >
            <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>+ Add supplement</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View style={{ gap: 10 }}>
        {stack.map(item => (
          <View key={item.id} style={{
            backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
            borderRadius: 12, padding: 14,
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <Text style={{ fontSize: 15, fontWeight: '800', color: tc.textPrimary, flex: 1 }} numberOfLines={1}>
                {item.custom_name || 'Supplement'}
              </Text>
              <TouchableOpacity onPress={() => handleRemove(item)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="trash-outline" size={16} color={tc.textMuted} />
              </TouchableOpacity>
            </View>
            {item.goal && (
              <Text style={{ fontSize: 11, color: tc.textMuted, marginBottom: 6 }}>
                Goal: <Text style={{ color: tc.textSecondary }}>{item.goal}</Text>
              </Text>
            )}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
              <View style={{ backgroundColor: tc.surfaceRaised, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6 }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textPrimary }}>
                  {item.dose_amount}{item.dose_unit}
                </Text>
              </View>
              <View style={{ backgroundColor: tc.surfaceRaised, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6 }}>
                <Text style={{ fontSize: 11, color: tc.textSecondary }}>
                  {item.frequency.replace(/_/g, ' ')}
                </Text>
              </View>
              {item.timing && (
                <View style={{ backgroundColor: tc.surfaceRaised, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6 }}>
                  <Text style={{ fontSize: 11, color: tc.textSecondary }}>{item.timing.replace(/_/g, ' ')}</Text>
                </View>
              )}
            </View>
            <View style={{ flexDirection: 'row', gap: 6, marginBottom: item.timing_notes || item.safety_notes ? 8 : 0 }}>
              {item.evidence_tier && (
                <Pill label={`${item.evidence_tier.toUpperCase()} EVIDENCE`} color={tiers.evidence[item.evidence_tier] || tc.textMuted} />
              )}
              {item.risk_tier && (
                <Pill label={`${item.risk_tier.toUpperCase()} RISK`} color={tiers.risk[item.risk_tier] || tc.textMuted} />
              )}
            </View>
            {item.timing_notes && (
              <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 4 }}>
                ⏱ {item.timing_notes}
              </Text>
            )}
            {item.safety_notes && (
              <Text style={{ fontSize: 11, color: tc.warning, marginTop: 4 }}>
                ⚠ {item.safety_notes}
              </Text>
            )}
          </View>
        ))}
        <TouchableOpacity
          onPress={() => setShowAdd(true)}
          style={{
            borderWidth: 1.5, borderStyle: 'dashed', borderColor: tc.primary + '66',
            borderRadius: 12, padding: 14, alignItems: 'center',
            marginTop: 4,
          }}
        >
          <Text style={{ color: tc.primary, fontWeight: '700', fontSize: 13 }}>+ Add supplement</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const renderRecommendations = () => {
    if (recs.length === 0) {
      return (
        <View style={{ padding: 20, alignItems: 'center' }}>
          <Ionicons name="sparkles-outline" size={32} color={tc.textMuted} style={{ marginBottom: 8 }} />
          <Text style={{ fontSize: 13, color: tc.textSecondary, textAlign: 'center' }}>
            No recommendations right now.
          </Text>
          <Text style={{ fontSize: 11, color: tc.textMuted, textAlign: 'center', marginTop: 4 }}>
            Log a few days of meals and we'll suggest supplements tied to your actual dietary gaps.
          </Text>
        </View>
      );
    }
    return (
      <View style={{ gap: 10 }}>
        <Text style={{ fontSize: 11, color: tc.textMuted, lineHeight: 15, marginBottom: 4 }}>
          Suggestions based on your logged meals. These are educational —
          discuss supplements with a clinician, especially if you take
          medication or have a medical condition.
        </Text>
        {recs.map((r, i) => (
          <View key={`${r.slug}-${i}`} style={{
            backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
            borderRadius: 12, padding: 14,
          }}>
            <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary, marginBottom: 4 }}>
              {r.title}
            </Text>
            <Text style={{ fontSize: 11, color: tc.textMuted, marginBottom: 8 }}>{r.reason}</Text>
            <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 17, marginBottom: 10 }}>
              {r.cautious_guidance}
            </Text>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Pill label={`${r.evidence_tier.toUpperCase()} EVIDENCE`} color={tiers.evidence[r.evidence_tier] || tc.textMuted} />
              <Pill label={`${r.risk_tier.toUpperCase()} RISK`} color={tiers.risk[r.risk_tier] || tc.textMuted} />
            </View>
          </View>
        ))}
      </View>
    );
  };

  // ─── Render ─────────────────────────────────────────────────────────

  return (
    <View style={{ flex: 1, backgroundColor: tc.background, paddingHorizontal: 16, paddingTop: 8 }}>
      {/* Section picker */}
      <View style={{
        flexDirection: 'row', backgroundColor: tc.surface,
        borderRadius: 10, padding: 3, marginBottom: 12,
        borderWidth: 1, borderColor: tc.border,
      }}>
        {(['today', 'stack', 'recommendations'] as Section[]).map(s => {
          const active = section === s;
          const label = s === 'today' ? 'Today' : s === 'stack' ? 'My Stack' : 'Recs';
          return (
            <TouchableOpacity
              key={s}
              onPress={() => setSection(s)}
              style={{
                flex: 1, paddingVertical: 8,
                backgroundColor: active ? tc.primary : 'transparent',
                borderRadius: 8,
                alignItems: 'center',
              }}
            >
              <Text style={{
                fontSize: 12, fontWeight: '700',
                color: active ? '#fff' : tc.textSecondary,
              }}>{label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 90 }}>
        {loading && <ActivityIndicator color={tc.primary} style={{ marginVertical: 20 }} />}
        {!loading && section === 'today' && renderToday()}
        {!loading && section === 'stack' && renderStack()}
        {!loading && section === 'recommendations' && renderRecommendations()}

        {/* Legal / educational footer */}
        <View style={{ marginTop: 20, paddingTop: 16, borderTopWidth: 1, borderTopColor: tc.border }}>
          <Text style={{ fontSize: 10, color: tc.textMuted, lineHeight: 15, textAlign: 'center' }}>
            Thallo does not provide medical advice. Supplements aren't a
            substitute for a balanced diet or medical care. Discuss
            dosing, interactions, and medical conditions with a
            clinician before starting anything new.
          </Text>
        </View>
      </ScrollView>

      <AddSupplementModal
        visible={showAdd}
        ingredients={ingredients}
        authToken={authToken}
        onClose={() => setShowAdd(false)}
        onAdd={async (body) => {
          try {
            await api.addStackItem(authToken, body as any);
            setShowAdd(false);
            reload();
          } catch (e: any) {
            Alert.alert('Could not add', String(e?.message ?? e));
          }
        }}
        onAddMany={async (bodies) => {
          // Batch: sequentially add so a mid-failure still saves the
          // good ones. Show a consolidated result at the end.
          let added = 0;
          for (const body of bodies) {
            try {
              await api.addStackItem(authToken, body as any);
              added++;
            } catch { /* skip failed rows silently — user can retry */ }
          }
          setShowAdd(false);
          reload();
          Alert.alert(
            added === bodies.length ? 'Added' : 'Partial add',
            `${added} of ${bodies.length} supplement${bodies.length === 1 ? '' : 's'} added to your stack.`,
          );
        }}
        themeName={themeName}
      />
    </View>
  );
}


// ─── Add supplement modal ──────────────────────────────────────────────────

function AddSupplementModal({
  visible, ingredients, authToken, onClose, onAdd, onAddMany, themeName,
}: {
  visible: boolean;
  ingredients: api.SupplementIngredient[];
  authToken: string;
  onClose: () => void;
  onAdd: (body: any) => void | Promise<void>;
  onAddMany?: (bodies: any[]) => void | Promise<void>;
  themeName?: AppThemeName;
}) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [selected, setSelected] = useState<api.SupplementIngredient | null>(null);
  const [customName, setCustomName] = useState('');
  const [dose, setDose] = useState('');
  const [unit, setUnit] = useState('mg');
  const [freq, setFreq] = useState<'daily' | 'weekdays' | 'as_needed' | 'pre_workout'>('daily');
  const [timing, setTiming] = useState<'morning' | 'evening' | 'with_meal' | 'pre_workout' | ''>('');
  // Free-text user-defined group. When set, overrides `timing` for the
  // grouped Today view + the "take group" action. e.g. "Stack 1",
  // "Travel pack", "Race day".
  const [groupLabel, setGroupLabel] = useState<string>('');
  const [scanning, setScanning] = useState(false);
  const [scanHint, setScanHint] = useState<string | null>(null);
  // Multi-scan review list. Populated by handleScanMultiple; cleared
  // when user taps "Add all" or cancels. Each item is editable inline.
  const [multiReview, setMultiReview] = useState<api.ScannedSupplement[] | null>(null);
  const [multiLoading, setMultiLoading] = useState(false);
  // AI text search — keyword → lookupSupplement. Lightweight wrapper
  // around the existing `/ai/supplement-lookup` endpoint so users can
  // type "ashwagandha" and get dose + evidence without a photo.
  const [aiSearch, setAiSearch] = useState('');
  const [aiSearching, setAiSearching] = useState(false);

  useEffect(() => {
    if (!visible) {
      setSelected(null); setCustomName(''); setDose(''); setUnit('mg');
      setFreq('daily'); setTiming(''); setGroupLabel('');
      setScanning(false); setScanHint(null);
      setMultiReview(null); setMultiLoading(false);
      setAiSearch(''); setAiSearching(false);
    }
  }, [visible]);

  /** Tries to match a scanned supplement name back to a seeded
   *  ingredient (e.g. "Vitamin D3 1000 IU" → vitamin_d3). */
  const _fuzzyMatchIngredient = (name: string): api.SupplementIngredient | null => {
    const n = name.toLowerCase();
    for (const ing of ingredients) {
      const ingN = ing.name.toLowerCase();
      if (n.includes(ingN) || ingN.includes(n)) return ing;
      // Also match token-level (e.g. "D3" in "Vitamin D3").
      const tokens = ingN.split(/\s+/);
      if (tokens.some(t => t.length >= 3 && n.includes(t))) return ing;
    }
    return null;
  };

  /** Parses a dose string like "1000 IU" or "5 g" into amount + unit. */
  const _parseDose = (doseStr?: string): { amount?: number; unit?: string } => {
    if (!doseStr) return {};
    const m = doseStr.match(/(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/);
    if (!m) return {};
    return { amount: parseFloat(m[1]), unit: m[2].toLowerCase() };
  };

  const handleScanLabel = async () => {
    try {
      setScanHint(null);
      // Lazy-import so we don't pull ImagePicker when the modal isn't used.
      const ImagePicker = await import('expo-image-picker');
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Camera permission needed', 'Enable camera access in Settings to scan supplement labels.');
        return;
      }
      // Quality 0.35 keeps text readable for the AI label scan while
      // shrinking the base64 payload from ~3-5MB to ~700KB-1MB. The
      // larger payloads were the main cause of the post-scan freeze
      // — slow upload over cellular plus a 30s default request
      // timeout meant the UI sat on the spinner past the timeout.
      const result = await ImagePicker.launchCameraAsync({
        base64: true, quality: 0.35,
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
      });
      if (result.canceled || !result.assets?.[0]?.base64) return;
      setScanning(true);
      const api = await import('../services/api');
      const res = await api.lookupSupplementFromPhoto(authToken, {
        image_base64: result.assets[0].base64,
        mime_type: 'image/jpeg',
      });
      if (!res.found) {
        setScanHint("Couldn't identify the supplement. Try again with a clearer shot of the label, or type it in manually.");
        return;
      }
      // Try matching to a seeded ingredient.
      const matched = _fuzzyMatchIngredient(res.name);
      if (matched) {
        setSelected(matched);
        setUnit(matched.default_unit);
      } else {
        setCustomName(res.name);
      }
      const parsed = _parseDose(res.dose);
      if (parsed.amount) setDose(String(parsed.amount));
      if (parsed.unit) setUnit(parsed.unit);
      setScanHint(`Detected: ${res.name}${res.dose ? ` (${res.dose})` : ''}. Double-check before saving.`);
    } catch (e: any) {
      setScanHint(`Scan failed: ${String(e?.message ?? e)}`);
    } finally {
      setScanning(false);
    }
  };

  /** Multi-scan — user snaps a photo of several bottles at once.
   *  AI returns a list → we open a review sheet with each item
   *  pre-filled, inline editable, and individually removable. */
  const handleScanMultiple = async () => {
    try {
      setScanHint(null);
      const ImagePicker = await import('expo-image-picker');
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Camera permission needed', 'Enable camera access in Settings to scan.');
        return;
      }
      // Quality 0.35 keeps text readable for the AI label scan while
      // shrinking the base64 payload from ~3-5MB to ~700KB-1MB. The
      // larger payloads were the main cause of the post-scan freeze
      // — slow upload over cellular plus a 30s default request
      // timeout meant the UI sat on the spinner past the timeout.
      const result = await ImagePicker.launchCameraAsync({
        base64: true, quality: 0.35,
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
      });
      if (result.canceled || !result.assets?.[0]?.base64) return;
      setMultiLoading(true);
      const apiMod = await import('../services/api');
      const res = await apiMod.scanSupplementsMulti(authToken, {
        image_base64: result.assets[0].base64,
        mime_type: 'image/jpeg',
      });
      if (!res.supplements || res.supplements.length === 0) {
        setScanHint("Couldn't identify any supplements. Try better lighting or a clearer angle, or add one at a time.");
        return;
      }
      setMultiReview(res.supplements);
    } catch (e: any) {
      setScanHint(`Scan failed: ${String(e?.message ?? e)}`);
    } finally {
      setMultiLoading(false);
    }
  };

  /** AI text search — user types a name (e.g. "ashwagandha") and we
   *  call /ai/supplement-lookup to fill in the form. Friendly for
   *  supplements outside the seeded catalog. */
  const handleAiSearch = async () => {
    const q = aiSearch.trim();
    if (!q) return;
    try {
      setAiSearching(true);
      const apiMod = await import('../services/api');
      const res = await apiMod.lookupSupplement(authToken, q);
      if (!res.found) {
        setScanHint(`AI didn't recognize "${q}". You can still type it in as a custom supplement.`);
        setCustomName(q);
        setSelected(null);
        return;
      }
      const matched = _fuzzyMatchIngredient(res.name);
      if (matched) {
        setSelected(matched);
        setUnit(matched.default_unit);
      } else {
        setCustomName(res.name);
        setSelected(null);
      }
      const parsed = _parseDose(res.dose);
      if (parsed.amount) setDose(String(parsed.amount));
      if (parsed.unit) setUnit(parsed.unit);
      setScanHint(`Found "${res.name}"${res.dose ? ` — typical dose ${res.dose}` : ''}. Double-check before saving.`);
    } catch (e: any) {
      setScanHint(`AI search failed: ${String(e?.message ?? e)}`);
    } finally {
      setAiSearching(false);
    }
  };

  const handleSave = () => {
    if (!dose || !parseFloat(dose)) {
      Alert.alert('Dose required', 'Enter a dose amount (e.g. 5 for 5g creatine).');
      return;
    }
    onAdd({
      supplement_ingredient_id: selected?.id,
      custom_name: selected?.name || customName || 'Custom supplement',
      dose_amount: parseFloat(dose),
      dose_unit: unit,
      frequency: freq,
      timing: timing || null,
      group_label: groupLabel.trim() || null,
      category: selected?.category,
    });
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: tc.background, borderTopLeftRadius: 20, borderTopRightRadius: 20,
          padding: 16, paddingBottom: 30, maxHeight: '85%',
        }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Text style={{ fontSize: 16, fontWeight: '800', color: tc.textPrimary }}>Add supplement</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={tc.textSecondary} />
            </TouchableOpacity>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled">
            {/* Quick-add actions — three paths to skip typing:
                1. Scan ONE bottle (label OCR → pre-fill form)
                2. Scan MANY bottles (group photo → review list → add all)
                3. AI text search (type a name, AI fills the form)
                Users who prefer manual entry can ignore all three
                and scroll straight to the ingredient chips below. */}
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
              <TouchableOpacity
                onPress={handleScanLabel}
                disabled={scanning || multiLoading}
                style={{
                  flex: 1, paddingVertical: 10, paddingHorizontal: 8,
                  backgroundColor: scanning ? tc.surfaceRaised : tc.primary + '1A',
                  borderWidth: 1, borderColor: tc.primary + '55',
                  borderRadius: 10,
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}
              >
                {scanning ? (
                  <ActivityIndicator size="small" color={tc.primary} />
                ) : (
                  <Ionicons name="scan-outline" size={16} color={tc.primary} />
                )}
                <Text style={{ fontSize: 12, fontWeight: '700', color: tc.primary }}>
                  Scan label
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleScanMultiple}
                disabled={scanning || multiLoading || !onAddMany}
                style={{
                  flex: 1, paddingVertical: 10, paddingHorizontal: 8,
                  backgroundColor: multiLoading ? tc.surfaceRaised : tc.primary + '1A',
                  borderWidth: 1, borderColor: tc.primary + '55',
                  borderRadius: 10,
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}
              >
                {multiLoading ? (
                  <ActivityIndicator size="small" color={tc.primary} />
                ) : (
                  <Ionicons name="images-outline" size={16} color={tc.primary} />
                )}
                <Text style={{ fontSize: 12, fontWeight: '700', color: tc.primary }}>
                  Scan all
                </Text>
              </TouchableOpacity>
            </View>
            {/* AI search — type a name, get pre-filled form. */}
            <View style={{ flexDirection: 'row', gap: 6, marginBottom: 12 }}>
              <TextInput
                value={aiSearch}
                onChangeText={setAiSearch}
                placeholder="Or search AI: 'ashwagandha', 'ZMA'…"
                placeholderTextColor={tc.textMuted}
                onSubmitEditing={handleAiSearch}
                returnKeyType="search"
                style={{
                  flex: 1,
                  backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                  borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9,
                  color: tc.textPrimary, fontSize: 13,
                }}
              />
              <TouchableOpacity
                onPress={handleAiSearch}
                disabled={aiSearching || !aiSearch.trim()}
                style={{
                  paddingVertical: 9, paddingHorizontal: 14,
                  backgroundColor: aiSearching || !aiSearch.trim() ? tc.surface : tc.primary,
                  borderRadius: 10, alignItems: 'center', justifyContent: 'center',
                  borderWidth: 1, borderColor: aiSearching || !aiSearch.trim() ? tc.border : tc.primary,
                }}
              >
                {aiSearching ? (
                  <ActivityIndicator size="small" color={tc.textMuted} />
                ) : (
                  <Ionicons name="sparkles" size={16} color="#fff" />
                )}
              </TouchableOpacity>
            </View>
            {scanHint && (
              <Text style={{
                fontSize: 11,
                color: scanHint.startsWith('Scan failed') || scanHint.startsWith("Couldn't") ? tc.warning : tc.textSecondary,
                marginBottom: 10,
                lineHeight: 15,
              }}>
                {scanHint}
              </Text>
            )}
            <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, marginBottom: 6, letterSpacing: 0.5 }}>
              COMMON SUPPLEMENTS
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {ingredients.map(ing => {
                const active = selected?.id === ing.id;
                return (
                  <TouchableOpacity
                    key={ing.id}
                    onPress={() => {
                      setSelected(ing);
                      setUnit(ing.default_unit);
                    }}
                    style={{
                      backgroundColor: active ? tc.primary : tc.surface,
                      borderWidth: 1,
                      borderColor: active ? tc.primary : tc.border,
                      borderRadius: 14, paddingVertical: 6, paddingHorizontal: 10,
                    }}
                  >
                    <Text style={{
                      fontSize: 12, fontWeight: '700',
                      color: active ? '#fff' : tc.textPrimary,
                    }}>{ing.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {selected && selected.description && (
              <View style={{ backgroundColor: tc.surfaceRaised, borderRadius: 10, padding: 10, marginBottom: 12 }}>
                <Text style={{ fontSize: 11, color: tc.textSecondary, lineHeight: 15 }}>{selected.description}</Text>
              </View>
            )}

            {!selected && (
              <>
                <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, marginBottom: 6, letterSpacing: 0.5 }}>
                  OR CUSTOM NAME
                </Text>
                <TextInput
                  value={customName}
                  onChangeText={setCustomName}
                  placeholder="e.g. Brand X Electrolyte Mix"
                  placeholderTextColor={tc.textMuted}
                  style={{
                    backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
                    color: tc.textPrimary, fontSize: 13, marginBottom: 12,
                  }}
                />
              </>
            )}

            <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, marginBottom: 6, letterSpacing: 0.5 }}>
              DOSE
            </Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
              <TextInput
                value={dose}
                onChangeText={setDose}
                placeholder="Amount"
                placeholderTextColor={tc.textMuted}
                keyboardType="decimal-pad"
                style={{
                  flex: 2,
                  backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                  borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
                  color: tc.textPrimary, fontSize: 13,
                }}
              />
              <TextInput
                value={unit}
                onChangeText={setUnit}
                placeholder="unit"
                placeholderTextColor={tc.textMuted}
                style={{
                  flex: 1,
                  backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                  borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
                  color: tc.textPrimary, fontSize: 13,
                }}
              />
            </View>

            <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, marginBottom: 6, letterSpacing: 0.5 }}>
              FREQUENCY
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {(['daily', 'weekdays', 'pre_workout', 'as_needed'] as const).map(f => {
                const active = freq === f;
                return (
                  <TouchableOpacity
                    key={f}
                    onPress={() => setFreq(f)}
                    style={{
                      backgroundColor: active ? tc.primary : tc.surface,
                      borderWidth: 1, borderColor: active ? tc.primary : tc.border,
                      borderRadius: 14, paddingVertical: 6, paddingHorizontal: 10,
                    }}
                  >
                    <Text style={{
                      fontSize: 11, fontWeight: '700',
                      color: active ? '#fff' : tc.textSecondary,
                    }}>{f.replace(/_/g, ' ')}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, marginBottom: 6, letterSpacing: 0.5 }}>
              TIMING (OPTIONAL)
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
              {(['morning', 'evening', 'with_meal', 'pre_workout'] as const).map(t => {
                const active = timing === t;
                return (
                  <TouchableOpacity
                    key={t}
                    onPress={() => setTiming(active ? '' : t)}
                    style={{
                      backgroundColor: active ? tc.primary : tc.surface,
                      borderWidth: 1, borderColor: active ? tc.primary : tc.border,
                      borderRadius: 14, paddingVertical: 6, paddingHorizontal: 10,
                    }}
                  >
                    <Text style={{
                      fontSize: 11, fontWeight: '700',
                      color: active ? '#fff' : tc.textSecondary,
                    }}>{t.replace(/_/g, ' ')}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Custom group — overrides the timing bucket on the Today
                tab so users can name their own packs ("Stack 1",
                "Travel pack") and tap-to-take the whole group at once. */}
            <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, marginBottom: 6, letterSpacing: 0.5 }}>
              GROUP (OPTIONAL)
            </Text>
            <TextInput
              value={groupLabel}
              onChangeText={setGroupLabel}
              placeholder="e.g. Stack 1, Travel pack, Pre-bed"
              placeholderTextColor={tc.textMuted}
              maxLength={40}
              style={{
                backgroundColor: tc.surface,
                borderWidth: 1, borderColor: tc.border,
                borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12,
                color: tc.textPrimary, fontSize: 14, marginBottom: 6,
              }}
            />
            <Text style={{ fontSize: 10, color: tc.textMuted, marginBottom: 16 }}>
              Lets you tap "Take all" for this whole group on the Today tab. Leave blank to use the timing bucket above.
            </Text>

            <TouchableOpacity
              onPress={handleSave}
              style={{
                backgroundColor: tc.primary, paddingVertical: 12, borderRadius: 10,
                alignItems: 'center',
              }}
            >
              <Text style={{ color: '#fff', fontWeight: '800', fontSize: 14 }}>Add to stack</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
      {/* Multi-scan review sheet — surfaces the AI-detected list so
          the user can correct names/doses and remove false positives
          before bulk-adding. */}
      <MultiScanReviewSheet
        visible={multiReview !== null}
        items={multiReview || []}
        themeName={themeName}
        onClose={() => setMultiReview(null)}
        onAddAll={async (finalItems) => {
          if (!onAddMany) return;
          const bodies = finalItems.map(it => ({
            custom_name: it.name,
            category: it.category,
            dose_amount: it.dose_amount || 0,
            dose_unit: it.dose_unit || 'mg',
            frequency: 'daily',
            evidence_tier: it.evidence_tier,
            risk_tier: it.risk_tier,
            timing_notes: it.timing_notes,
            safety_notes: it.safety_notes,
          }));
          await onAddMany(bodies);
          setMultiReview(null);
        }}
      />
    </Modal>
  );
}


// ─── Multi-scan review sheet ──────────────────────────────────────────

function MultiScanReviewSheet({
  visible, items, themeName, onClose, onAddAll,
}: {
  visible: boolean;
  items: api.ScannedSupplement[];
  themeName?: AppThemeName;
  onClose: () => void;
  onAddAll: (finalItems: api.ScannedSupplement[]) => void | Promise<void>;
}) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [review, setReview] = useState<api.ScannedSupplement[]>([]);

  useEffect(() => { setReview(items); }, [items]);

  const updateAt = (i: number, patch: Partial<api.ScannedSupplement>) => {
    setReview(prev => prev.map((it, idx) => idx === i ? { ...it, ...patch } : it));
  };
  const removeAt = (i: number) => {
    setReview(prev => prev.filter((_, idx) => idx !== i));
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: tc.background, borderTopLeftRadius: 20, borderTopRightRadius: 20,
          padding: 16, paddingBottom: 30, maxHeight: '88%',
        }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <Text style={{ fontSize: 16, fontWeight: '800', color: tc.textPrimary }}>
              Detected {review.length} supplement{review.length === 1 ? '' : 's'}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={tc.textSecondary} />
            </TouchableOpacity>
          </View>
          <Text style={{ fontSize: 11, color: tc.textMuted, marginBottom: 12, lineHeight: 15 }}>
            Double-check names and doses — AI guesses aren't always exact. Swipe or tap the × to remove any it got wrong.
          </Text>

          <ScrollView style={{ flexGrow: 0 }}>
            {review.length === 0 ? (
              <View style={{ padding: 20, alignItems: 'center' }}>
                <Text style={{ fontSize: 12, color: tc.textMuted }}>All items removed.</Text>
              </View>
            ) : review.map((it, i) => (
              <View key={`${i}-${it.name}`} style={{
                backgroundColor: tc.surface, borderRadius: 12, padding: 12, marginBottom: 8,
                borderWidth: 1, borderColor: tc.border,
              }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <TextInput
                    value={it.name}
                    onChangeText={(t) => updateAt(i, { name: t })}
                    placeholder="Supplement name"
                    placeholderTextColor={tc.textMuted}
                    style={{
                      flex: 1,
                      backgroundColor: tc.surfaceRaised, borderRadius: 8,
                      paddingHorizontal: 10, paddingVertical: 7,
                      color: tc.textPrimary, fontSize: 13, fontWeight: '700',
                    }}
                  />
                  <TouchableOpacity
                    onPress={() => removeAt(i)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={{
                      width: 28, height: 28, borderRadius: 14,
                      backgroundColor: tc.surfaceRaised,
                      alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    <Ionicons name="close" size={14} color={tc.textSecondary} />
                  </TouchableOpacity>
                </View>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TextInput
                    value={it.dose_amount != null ? String(it.dose_amount) : ''}
                    onChangeText={(t) => updateAt(i, { dose_amount: parseFloat(t) || 0 })}
                    placeholder="Dose"
                    placeholderTextColor={tc.textMuted}
                    keyboardType="decimal-pad"
                    style={{
                      flex: 2,
                      backgroundColor: tc.surfaceRaised, borderRadius: 8,
                      paddingHorizontal: 10, paddingVertical: 7,
                      color: tc.textPrimary, fontSize: 12,
                    }}
                  />
                  <TextInput
                    value={it.dose_unit}
                    onChangeText={(t) => updateAt(i, { dose_unit: t })}
                    placeholder="unit"
                    placeholderTextColor={tc.textMuted}
                    style={{
                      flex: 1,
                      backgroundColor: tc.surfaceRaised, borderRadius: 8,
                      paddingHorizontal: 10, paddingVertical: 7,
                      color: tc.textPrimary, fontSize: 12,
                    }}
                  />
                </View>
                <View style={{ flexDirection: 'row', gap: 4, marginTop: 6 }}>
                  <Text style={{ fontSize: 10, color: tc.textMuted }}>
                    {it.category} · {it.evidence_tier} evidence · {it.risk_tier} risk
                  </Text>
                </View>
              </View>
            ))}
          </ScrollView>

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            <TouchableOpacity
              onPress={onClose}
              style={{
                flex: 1, paddingVertical: 12, borderRadius: 10,
                alignItems: 'center',
                backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
              }}
            >
              <Text style={{ color: tc.textSecondary, fontWeight: '700', fontSize: 13 }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => onAddAll(review.filter(r => (r.name || '').trim() && (r.dose_amount || 0) > 0))}
              disabled={review.length === 0}
              style={{
                flex: 2, paddingVertical: 12, borderRadius: 10,
                alignItems: 'center',
                backgroundColor: review.length === 0 ? tc.border : tc.primary,
              }}
            >
              <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>
                Add {review.length} to stack
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
