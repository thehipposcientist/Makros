import { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Animated, Easing } from 'react-native';
import { configureExpandAnimation } from '../utils/layoutAnim';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import BodyHeatMap, { HeatRecoveryMap } from './BodyHeatMap';
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

const RECOVERY_NUMBER_ROWS: Array<{ key: string; label: string }> = [
  { key: 'chest', label: 'Chest' },
  { key: 'back', label: 'Back' },
  { key: 'shoulders', label: 'Shoulders' },
  { key: 'biceps', label: 'Biceps' },
  { key: 'triceps', label: 'Triceps' },
  { key: 'core', label: 'Core' },
  { key: 'quads', label: 'Quads' },
  { key: 'hamstrings', label: 'Hamstrings' },
  { key: 'glutes', label: 'Glutes' },
  { key: 'calves', label: 'Calves' },
  { key: 'cardio', label: 'Cardio' },
];

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
  const [numbersExpanded, setNumbersExpanded] = useState(false);

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

  // Per-muscle map drives the heat map fill colors and the optional
  // exact-number panel below the figure.
  const fatigueMap = data.muscleFatigue ?? {};
  const recoveryFor = (muscle: string): number =>
    Math.max(0, Math.min(100, 100 - Math.round((fatigueMap[muscle] ?? 0) * 100)));
  const recoveryColor = (recovery: number): string =>
    recovery >= 80 ? tc.primary :
    recovery >= 60 ? tc.success :
    recovery >= 40 ? tc.warning :
    tc.error;
  const recoveryRows = [
    ...RECOVERY_NUMBER_ROWS,
    ...Object.keys(fatigueMap)
      .filter(key => !RECOVERY_NUMBER_ROWS.some(row => row.key === key) && key !== 'systemic')
      .sort()
      .map(key => ({
        key,
        label: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      })),
  ];

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
            const heatRecovery: HeatRecoveryMap = {
              chest:      recoveryFor('chest'),
              shoulders:  recoveryFor('shoulders'),
              biceps:     recoveryFor('biceps'),
              triceps:    recoveryFor('triceps'),
              abs:        recoveryFor('core'),
              quads:      recoveryFor('quads'),
              hamstrings: recoveryFor('hamstrings'),
              glutes:     recoveryFor('glutes'),
              calves:     recoveryFor('calves'),
              upper_back: recoveryFor('back'),
              lats:       recoveryFor('back'),
            };
            return <BodyHeatMap recovery={heatRecovery} themeName={themeName} height={240} />;
          })()}

          <TouchableOpacity
            activeOpacity={0.78}
            onPress={() => {
              configureExpandAnimation(260);
              setNumbersExpanded(v => !v);
            }}
            style={{
              marginTop: 10,
              paddingHorizontal: 12,
              paddingVertical: 10,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: tc.border,
              backgroundColor: tc.surfaceRaised,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
            }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 12, fontWeight: '800', color: tc.textPrimary }}>
                Recovery numbers
              </Text>
              <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 1 }}>
                Exact percentages for each muscle group
              </Text>
            </View>
            <Ionicons name={numbersExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={tc.textMuted} />
          </TouchableOpacity>

          {numbersExpanded && (
            <FadeInView delay={0} duration={220} slideDistance={6}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                {recoveryRows.map(row => {
                  const recovery = recoveryFor(row.key);
                  const color = recoveryColor(recovery);
                  return (
                    <View
                      key={row.key}
                      style={{
                        width: '48%',
                        minWidth: 132,
                        flexGrow: 1,
                        backgroundColor: tc.surface,
                        borderRadius: radius.md,
                        borderWidth: 1,
                        borderColor: tc.border,
                        paddingHorizontal: 10,
                        paddingVertical: 9,
                        gap: 6,
                      }}>
                      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                        <Text style={{ flex: 1, fontSize: 11, fontWeight: '800', color: tc.textSecondary }} numberOfLines={1}>
                          {row.label}
                        </Text>
                        <Text style={{ fontSize: 15, fontWeight: '900', color, fontVariant: ['tabular-nums'] }}>
                          {recovery}%
                        </Text>
                      </View>
                      <View style={{ height: 4, borderRadius: 2, backgroundColor: tc.border, overflow: 'hidden' }}>
                        <View style={{ width: `${recovery}%`, height: '100%', borderRadius: 2, backgroundColor: color }} />
                      </View>
                    </View>
                  );
                })}
              </View>
            </FadeInView>
          )}

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
