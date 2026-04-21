import { useState } from 'react';
import { View, Text, TouchableOpacity, LayoutAnimation } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';

export interface RecoveryCardData {
  score: number;
  label: string;
  topFatigued?: Array<{ muscle: string; value: number }>;
  muscleFatigue?: Record<string, number>;
  activities?: Array<{
    date: string;
    days_ago?: number;
    focus: string;
    category?: string;
    subtype?: string;
    intensity?: string;
    duration_minutes?: number;
    kind?: 'training' | 'recovery';
    muscles: Record<string, number>;
  }>;
  nutritionContext?: {
    protein_avg: number;
    protein_status: string;
    message: string | null;
    recovery_bonus_applied: boolean;
  } | null;
}

interface Props {
  data: RecoveryCardData | null;
  themeName?: AppThemeName;
  /** When true, card renders expanded without needing a tap. Used on the
   *  Progress tab where we have vertical real estate. */
  defaultExpanded?: boolean;
  /** Compact mode uses a smaller icon and less padding for dashboard
   *  placement (HomeScreen workout plan header). */
  compact?: boolean;
}

/**
 * Shared recovery / readiness card. Single source of truth for every
 * readiness-related surface in the app — the workout tab header, the
 * Progress tab, and future placements all render the same component so
 * the data stays consistent.
 *
 * `data` comes from `GET /workouts/fatigue` (via `getFatigueScore`). The
 * caller is responsible for fetching and passing it down.
 */
export default function RecoveryCard({ data, themeName, defaultExpanded, compact }: Props) {
  const tc = getTheme(themeName).colors;
  const [expanded, setExpanded] = useState(!!defaultExpanded);

  if (!data) return null;

  const scoreColor = data.score >= 65 ? '#22C55E' : data.score >= 40 ? '#F59E0B' : '#EF4444';
  // Fitness-themed iconography instead of battery. Flash = energized,
  // pulse = steady, hourglass = depleted (needs time).
  const iconName: any =
    data.score >= 65 ? 'flash' : data.score >= 40 ? 'pulse' : 'hourglass-outline';

  const iconSize = compact ? 20 : 22;
  const pad = compact ? 10 : 16;
  const titleSize = compact ? 13 : 17;
  const titleWeight: '700' | '800' = compact ? '700' : '800';

  // Show every tracked muscle group regardless of fatigue level — even 100%
  // recovered ones render (useful for "nothing is fatigued right now" read).
  // Canonical order matches MuscleGroup enum so the list is stable run-to-run.
  const MUSCLE_ORDER = ['chest', 'back', 'shoulders', 'biceps', 'triceps', 'quads', 'hamstrings', 'glutes', 'calves', 'core'];
  const fatigueMap = data.muscleFatigue ?? {};
  const muscleEntries: [string, number][] = MUSCLE_ORDER.map(m => [m, fatigueMap[m] ?? 0]);

  return (
    <TouchableOpacity
      activeOpacity={defaultExpanded ? 1 : 0.7}
      onPress={() => {
        if (defaultExpanded) return;
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setExpanded(v => !v);
      }}
      style={{
        marginBottom: compact ? 8 : 14,
        backgroundColor: compact ? tc.surfaceRaised : tc.surface,
        borderRadius: compact ? 10 : radius.lg,
        padding: pad,
        borderWidth: 1,
        borderColor: tc.border,
      }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Ionicons name={iconName} size={iconSize} color={scoreColor} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: titleSize, fontWeight: titleWeight, color: tc.textPrimary }}>
            Recovery: {data.label} ({data.score}%)
          </Text>
          {!expanded && (data.topFatigued?.length ?? 0) > 0 && (
            <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }} numberOfLines={1}>
              Most fatigued: {data.topFatigued!.slice(0, 3).map(t => t.muscle.replace('_', ' ')).join(', ')}
            </Text>
          )}
          {!expanded && (data.topFatigued?.length ?? 0) === 0 && (
            <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }}>All muscle groups fresh</Text>
          )}
        </View>
        {!defaultExpanded && (
          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={tc.textMuted} />
        )}
      </View>

      {expanded && (
        <View style={{ marginTop: 10, gap: 4 }}>
          {muscleEntries.map(([muscle, fatigue]) => {
            const pct = Math.round(fatigue * 100);
            const recovery = Math.max(0, 100 - pct);
            const color = recovery >= 70 ? '#22C55E' : recovery >= 40 ? '#F59E0B' : '#EF4444';
            return (
              <View key={muscle} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontSize: 11, fontWeight: '600', color: tc.textSecondary, width: 75, textTransform: 'capitalize' }}>
                  {muscle.replace('_', ' ')}
                </Text>
                <View style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: tc.border }}>
                  <View style={{ width: `${Math.min(100, recovery)}%` as any, height: 5, borderRadius: 3, backgroundColor: color }} />
                </View>
                <Text style={{ fontSize: 10, fontWeight: '700', color, width: 32, textAlign: 'right' }}>{recovery}%</Text>
              </View>
            );
          })}
          {/* Overall Load / systemic bar removed per request — the per-muscle
              bars above cover the useful signal. Users found the aggregate
              redundant with the headline readiness score. */}
          {(() => {
            const acts = data.activities ?? [];
            if (acts.length === 0) return null;
            const training = acts.filter(a => a.kind !== 'recovery');
            const recovery = acts.filter(a => a.kind === 'recovery');
            const humanize = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            const dayLabel = (a: { date: string; days_ago?: number }) => {
              if (a.days_ago === 0) return 'Today';
              if (a.days_ago === 1) return 'Yesterday';
              if (typeof a.days_ago === 'number' && a.days_ago > 1) return `${a.days_ago}d ago`;
              return a.date;
            };
            const activityName = (a: { focus: string; category?: string; subtype?: string }) => {
              // Prefer the specific subtype (Sauna / Yoga / Walk) when present;
              // fall back to category then raw focus.
              if (a.subtype) return humanize(a.subtype);
              if (a.category) return humanize(a.category);
              return a.focus || 'Activity';
            };
            const proteinBonusOn = data.nutritionContext?.recovery_bonus_applied;
            const hasAnyRecovery = recovery.length > 0 || proteinBonusOn;
            return (
              <>
                {hasAnyRecovery && (
                  <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: tc.border }}>
                    <Text style={{ fontSize: 10, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 6 }}>
                      AIDING RECOVERY
                    </Text>
                    {recovery.map((a, i) => (
                      <View key={`r-${i}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 }}>
                        <Ionicons name="leaf-outline" size={12} color="#22C55E" />
                        <Text style={{ fontSize: 11, color: tc.textPrimary, flex: 1 }}>
                          {activityName(a)}
                          {a.duration_minutes ? ` · ${a.duration_minutes}m` : ''}
                          {a.intensity ? ` · ${a.intensity}` : ''}
                        </Text>
                        <Text style={{ fontSize: 10, color: tc.textMuted }}>{dayLabel(a)}</Text>
                      </View>
                    ))}
                    {proteinBonusOn && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 }}>
                        <Ionicons name="nutrition-outline" size={12} color="#22C55E" />
                        <Text style={{ fontSize: 11, color: tc.textPrimary, flex: 1 }}>
                          Protein intake ({data.nutritionContext!.protein_avg}g/day avg)
                        </Text>
                        <Text style={{ fontSize: 10, color: tc.textMuted }}>Today</Text>
                      </View>
                    )}
                  </View>
                )}
                {training.length > 0 && (
                  <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: tc.border }}>
                    <Text style={{ fontSize: 10, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 6 }}>
                      RECENT TRAINING
                    </Text>
                    {training.map((a, i) => (
                      <View key={`t-${i}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 }}>
                        <Ionicons name="barbell-outline" size={12} color={tc.textSecondary} />
                        <Text style={{ fontSize: 11, color: tc.textSecondary, flex: 1 }}>
                          {activityName(a)}
                          {a.duration_minutes ? ` · ${a.duration_minutes}m` : ''}
                        </Text>
                        <Text style={{ fontSize: 10, color: tc.textMuted }}>{dayLabel(a)}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </>
            );
          })()}
          {data.nutritionContext?.message && (
            <View style={{ marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: tc.border, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons
                name={data.nutritionContext.protein_status === 'excellent' ? 'nutrition' : data.nutritionContext.protein_status === 'good' ? 'nutrition-outline' : 'alert-circle-outline'}
                size={14}
                color={data.nutritionContext.protein_status === 'excellent' || data.nutritionContext.protein_status === 'good' ? '#22C55E' : data.nutritionContext.protein_status === 'low' ? '#F59E0B' : data.nutritionContext.protein_status === 'very_low' ? '#EF4444' : tc.textMuted}
              />
              <Text style={{
                fontSize: 10, fontWeight: '600', flex: 1,
                color: data.nutritionContext.protein_status === 'excellent' || data.nutritionContext.protein_status === 'good' ? '#22C55E' : data.nutritionContext.protein_status === 'low' ? '#F59E0B' : data.nutritionContext.protein_status === 'very_low' ? '#EF4444' : tc.textMuted,
              }}>
                {data.nutritionContext.message}
              </Text>
            </View>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}
