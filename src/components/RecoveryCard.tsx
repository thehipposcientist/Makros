import { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Animated, Easing } from 'react-native';
import { configureExpandAnimation } from '../utils/layoutAnim';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import BodyHeatMap, { HeatMuscleKey, HeatRecoveryMap } from './BodyHeatMap';
import FadeInView from './FadeInView';

/**
 * Per-muscle recovery bar with animated fill. Width is a layout prop so
 * the animation must run on the JS thread (useNativeDriver: false) — fine
 * at this scale since we only drive ~10 bars briefly on mount / value
 * changes. Each bar staggers its start by 40ms for a cascading reveal.
 */
function AnimatedRecoveryBar({
  recovery, color, borderColor, delay,
}: { recovery: number; color: string; borderColor: string; delay: number }) {
  const widthAnim = useRef(new Animated.Value(0)).current;
  // Track the last target we animated to so prop changes re-trigger the
  // fill animation (not just mount). Starting value zero guarantees the
  // initial render gets the 0 → target cascade.
  const lastTarget = useRef<number | null>(null);

  useEffect(() => {
    if (lastTarget.current === recovery) return;
    lastTarget.current = recovery;
    Animated.timing(widthAnim, {
      toValue: recovery,
      duration: 600,
      delay,
      // easeOutCubic — fast start, gentle settle
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [recovery, delay, widthAnim]);

  return (
    <View style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: borderColor }}>
      <Animated.View
        style={{
          width: widthAnim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
          height: 5,
          borderRadius: 3,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

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

  // Score tier colors pulled from theme semantics so the card matches
  // whatever palette the user has active (midnight/ocean/sandstone/…).
  const scoreColor = data.score >= 65 ? tc.success : data.score >= 40 ? tc.warning : tc.error;
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
        configureExpandAnimation(320);
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
        <FadeInView delay={0} duration={300} slideDistance={10}>
        <View style={{ marginTop: 10 }}>
          {/* Explainer: the bars aggregate fatigue over a decay window
              (day 0 = 100%, day 1 = 50%, day 2 = 25%, day 3 = 10%) so
              users understand the bars aren't a single-day snapshot. */}
          <Text style={{ fontSize: 10, color: tc.textMuted, marginBottom: 8, fontStyle: 'italic' }}>
            Per-muscle recovery based on training from the last ~4 days (weighted so
            today counts most, older sessions fade out).
          </Text>
          {/* Main visualization — body heat map */}
          {(() => {
            // Map backend muscle fatigue (chest/back/... as 0-1) onto the heat
            // map's muscle keys (front + back). "back" projects onto both
            // upper_back and lats since backend doesn't split them.
            const toRecovery = (muscle: string): number =>
              Math.max(0, Math.min(100, 100 - Math.round((fatigueMap[muscle] ?? 0) * 100)));
            const heatRecovery: HeatRecoveryMap = {
              chest:      toRecovery('chest'),
              shoulders:  toRecovery('shoulders'),
              biceps:     toRecovery('biceps'),
              triceps:    toRecovery('triceps'),
              abs:        toRecovery('core'),
              quads:      toRecovery('quads'),
              hamstrings: toRecovery('hamstrings'),
              glutes:     toRecovery('glutes'),
              calves:     toRecovery('calves'),
              upper_back: toRecovery('back'),
              lats:       toRecovery('back'),
            };
            return <BodyHeatMap recovery={heatRecovery} themeName={themeName} height={240} />;
          })()}

          {/* Compact exact-value list — two columns */}
          <View style={{ marginTop: 10, flexDirection: 'row', flexWrap: 'wrap' }}>
            {muscleEntries.map(([muscle, fatigue], idx) => {
              const pct = Math.round(fatigue * 100);
              const recovery = Math.max(0, Math.min(100, 100 - pct));
              const color = recovery >= 70 ? tc.success : recovery >= 40 ? tc.warning : tc.error;
              return (
                <FadeInView key={muscle} delay={120 + idx * 30} duration={220} slideDistance={0}>
                <View
                  style={{
                    width: '50%',
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 3,
                    paddingRight: 8,
                  }}
                >
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, marginRight: 6 }} />
                  <Text style={{ flex: 1, fontSize: 11, color: tc.textSecondary, textTransform: 'capitalize' }} numberOfLines={1}>
                    {muscle.replace('_', ' ')}
                  </Text>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textPrimary }}>{recovery}%</Text>
                </View>
                </FadeInView>
              );
            })}
          </View>
          {/* The animated bar helper is unused here now but kept exported for
              other consumers that still want per-muscle bars. */}
          {false && <AnimatedRecoveryBar recovery={0} color={tc.primary} borderColor={tc.border} delay={0} />}
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
            // Fatigue decay — matches the backend model (day 0 = 100%,
            // day 1 = 50%, day 2 = 25%, day 3 = 10%, older = ~0%). We
            // surface this percentage per row so "Yesterday" reads as
            // "still carrying ~50% of that workout's fatigue" instead
            // of a bare date label.
            const contributionPct = (daysAgo?: number): number | null => {
              if (typeof daysAgo !== 'number') return null;
              if (daysAgo <= 0) return 100;
              if (daysAgo === 1) return 50;
              if (daysAgo === 2) return 25;
              if (daysAgo === 3) return 10;
              return 0;
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
                        <Ionicons name="leaf-outline" size={12} color={tc.success} />
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
                        <Ionicons name="nutrition-outline" size={12} color={tc.success} />
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
                    <Text style={{ fontSize: 10, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 2 }}>
                      RECENT TRAINING
                    </Text>
                    {/* Explainer: these rows drive the per-muscle bars
                        above. The "still X%" label tells the user how
                        much of that session's fatigue is still weighing
                        on their recovery score today. */}
                    <Text style={{ fontSize: 10, color: tc.textMuted, fontStyle: 'italic', marginBottom: 6 }}>
                      Each session adds fatigue that fades over ~3 days
                      (today = 100% → yesterday = 50% → 2d = 25% → 3d = 10%).
                    </Text>
                    {training.map((a, i) => (
                      <View key={`t-${i}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 }}>
                        <Ionicons name="barbell-outline" size={12} color={tc.textSecondary} />
                        <Text style={{ fontSize: 11, color: tc.textSecondary, flex: 1 }}>
                          {activityName(a)}
                          {a.duration_minutes ? ` · ${a.duration_minutes}m` : ''}
                        </Text>
                        <Text style={{ fontSize: 10, color: tc.textMuted }}>
                          {dayLabel(a)}
                          {(() => {
                            const pct = contributionPct(a.days_ago);
                            return pct != null && pct > 0 ? ` · still ${pct}%` : '';
                          })()}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
              </>
            );
          })()}
          {data.nutritionContext?.message && (() => {
            // Protein-status → theme semantic color.
            const ps = data.nutritionContext.protein_status;
            const statusColor = (ps === 'excellent' || ps === 'good') ? tc.success
              : ps === 'low' ? tc.warning
              : ps === 'very_low' ? tc.error
              : tc.textMuted;
            return (
            <View style={{ marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: tc.border, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons
                name={ps === 'excellent' ? 'nutrition' : ps === 'good' ? 'nutrition-outline' : 'alert-circle-outline'}
                size={14}
                color={statusColor}
              />
              <Text style={{ fontSize: 10, fontWeight: '600', flex: 1, color: statusColor }}>
                {data.nutritionContext.message}
              </Text>
            </View>
            );
          })()}
        </View>
        </FadeInView>
      )}
    </TouchableOpacity>
  );
}
