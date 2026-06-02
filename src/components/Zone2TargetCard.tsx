// Zone 2 weekly target progress.
//
// Reads the weekly review endpoint (goal-specific Z2 target lives
// there) and renders the plan-week Z2 target plus an all-source
// HR-zone distribution for the week. The weekly coaching card still
// does the heavy lift; this stays glanceable for users whose goal
// weights Z2 heavily (longevity, fat loss, recomp).
//
// Uses the same /workouts/weekly-review call the coaching card
// already makes, so mounting both doesn't double-fetch (they can be
// refactored to share state via context later — for now, cheap).

import { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { getWeeklyReview } from '../services/api';
import type { HrZoneSourceContributor } from '../screens/progressData';
import { HR_ZONE_BANDS, hrZoneColorHex } from '../utils/hrZones';
import { TIMING_SMOOTH, useReducedMotion } from '../utils/motion';

interface Props {
  authToken: string;
  themeName?: AppThemeName;
  appleHealthZone2?: number | null;
  currentMinutes?: number | null;
  previousMinutes?: number | null;
  weeklyZoneMinutes?: number[] | null;
  weeklyZoneSources?: Array<HrZoneSourceContributor[]> | null;
  weekEndDate?: string | null;
  weekLabel?: string | null;
  previousWeekLabel?: string | null;
}

// Mirror of backend _CARDIO_TARGETS zone2 column so we can show the
// target number even before the server response lands. Stays in sync
// because this is just display — the backend math is authoritative.
const GOAL_ZONE2_TARGET: Record<string, number> = {
  muscle_gain: 40, strength: 40, body_recomp: 80, fat_loss: 120,
  endurance: 150, general_health: 100, longevity: 100,
  athletic_performance: 80, maintain: 80, flexibility: 40,
  stress_relief: 60,
};

const MAX_ZONE_SOURCES = 8;

// Optional debug list — when provided, lets the user tap "Why?" to see
// exactly which workouts counted (and which didn't). Helps explain
// "I did cardio Monday but Z2 isn't budging" without needing a debugger.
export interface Z2DetectedWorkout {
  name: string;
  durationMin: number;
  counted: boolean;
  reason?: string;
}

function normalizeWeeklyZones(raw?: number[] | null): number[] {
  return HR_ZONE_BANDS.map((_, index) => {
    const value = Number(raw?.[index] ?? 0);
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  });
}

function formatSourceDate(raw: string): string {
  const date = new Date(`${String(raw).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return String(raw).slice(5, 10) || raw;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

// Mix a hex color toward white (amount > 0) or black (amount < 0). Used to
// build each zone segment's gradient so the donut reads with depth instead of
// a flat fill.
function shiftHex(hex: string, amount: number): string {
  const raw = String(hex).replace('#', '');
  const full = raw.length === 3 ? raw.split('').map(ch => ch + ch).join('') : raw;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return hex;
  const target = amount >= 0 ? 255 : 0;
  const t = Math.min(1, Math.abs(amount));
  const toHex = (c: number) => clampByte(c + (target - c) * t).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function ZoneDistributionDonut({
  zoneMinutes,
  totalMinutes,
  mutedColor,
  trackColor,
  surfaceColor,
}: {
  zoneMinutes: number[];
  totalMinutes: number;
  mutedColor: string;
  trackColor: string;
  surfaceColor: string;
}) {
  const reducedMotion = useReducedMotion();
  const intro = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;
  useEffect(() => {
    if (reducedMotion) { intro.setValue(1); return; }
    intro.setValue(0);
    const anim = Animated.timing(intro, {
      toValue: 1,
      duration: 620,
      easing: TIMING_SMOOTH.easing,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [intro, reducedMotion]);
  const introScale = intro.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] });

  const size = 126;
  const stroke = 15;
  // Glow halo is a wider pass behind each segment; shrink the ring radius so
  // the halo stays inside the SVG viewport instead of clipping at the edge.
  const glowStroke = stroke + 6;
  const radiusSize = (size - glowStroke) / 2;
  const circumference = 2 * Math.PI * radiusSize;
  const activeZones = zoneMinutes.filter(min => min >= 0.5).length;
  const gap = activeZones > 1 ? 3.5 : 0;
  let cursor = 0;

  const segments = HR_ZONE_BANDS.map((zone, index) => {
    const minutes = zoneMinutes[index] ?? 0;
    const share = totalMinutes > 0 ? minutes / totalMinutes : 0;
    const rawLength = share * circumference;
    const color = hrZoneColorHex(zone.zone);
    const segment = {
      zone: zone.zone,
      minutes,
      color,
      gradientId: `zoneGrad-${zone.zone}`,
      light: shiftHex(color, 0.34),
      dark: shiftHex(color, -0.16),
      dashLength: Math.max(0, rawLength - gap),
      dashOffset: -cursor,
    };
    cursor += rawLength;
    return segment;
  }).filter(segment => segment.minutes >= 0.5 && segment.dashLength > 0);

  const totalDisplayMinutes = Math.round(totalMinutes);
  const accessibilityLabel = HR_ZONE_BANDS
    .map((zone, index) => `Z${zone.zone} ${Math.round(zoneMinutes[index] ?? 0)} minutes`)
    .join(', ');

  return (
    <Animated.View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Heart-rate zone distribution: ${accessibilityLabel}`}
      style={{
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        opacity: intro,
        transform: [{ scale: introScale }],
      }}
    >
      <Svg width={size} height={size}>
        <Defs>
          {segments.map(segment => (
            <LinearGradient key={segment.gradientId} id={segment.gradientId} x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor={segment.light} />
              <Stop offset="0.55" stopColor={segment.color} />
              <Stop offset="1" stopColor={segment.dark} />
            </LinearGradient>
          ))}
        </Defs>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radiusSize}
          stroke={trackColor}
          strokeWidth={stroke}
          fill="transparent"
        />
        {/* Soft glow halo — a wider, low-opacity pass behind each segment. */}
        {segments.map(segment => (
          <Circle
            key={`zone-glow-${segment.zone}`}
            cx={size / 2}
            cy={size / 2}
            r={radiusSize}
            stroke={segment.color}
            strokeWidth={glowStroke}
            strokeOpacity={0.22}
            strokeLinecap="round"
            strokeDasharray={`${segment.dashLength} ${circumference}`}
            strokeDashoffset={segment.dashOffset}
            rotation="-90"
            originX={size / 2}
            originY={size / 2}
            fill="transparent"
          />
        ))}
        {segments.map(segment => (
          <Circle
            key={`zone-donut-${segment.zone}`}
            cx={size / 2}
            cy={size / 2}
            r={radiusSize}
            stroke={`url(#${segment.gradientId})`}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${segment.dashLength} ${circumference}`}
            strokeDashoffset={segment.dashOffset}
            rotation="-90"
            originX={size / 2}
            originY={size / 2}
            fill="transparent"
          />
        ))}
      </Svg>
      <View style={{
        position: 'absolute',
        width: size - stroke * 2.4,
        height: size - stroke * 2.4,
        borderRadius: (size - stroke * 2.4) / 2,
        backgroundColor: surfaceColor,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <Text
          style={{ fontSize: 22, lineHeight: 26, fontWeight: '900', color: hrZoneColorHex(2) }}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.75}
        >
          {totalDisplayMinutes}m
        </Text>
        <Text style={{ fontSize: 10, lineHeight: 12, fontWeight: '900', color: mutedColor, letterSpacing: 0.5 }}>
          TOTAL
        </Text>
      </View>
    </Animated.View>
  );
}

export default function Zone2TargetCard({
  authToken,
  themeName,
  appleHealthZone2,
  currentMinutes,
  previousMinutes,
  weeklyZoneMinutes,
  weeklyZoneSources,
  weekEndDate,
  weekLabel,
  previousWeekLabel,
  detectedWorkouts,
}: Props & { detectedWorkouts?: Z2DetectedWorkout[] }) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [backendMinutes, setBackendMinutes] = useState<number>(0);
  const [target, setTarget] = useState<number>(100);
  const [, setGoal] = useState<string>('general_health');
  const [loading, setLoading] = useState(true);
  const [showWhy, setShowWhy] = useState(false);
  const [expandedZone, setExpandedZone] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await getWeeklyReview(authToken, { days: 7, endDate: weekEndDate ?? undefined });
        if (cancelled) return;
        setBackendMinutes(r.zone2_minutes ?? 0);
        setGoal(r.goal);
        setTarget(GOAL_ZONE2_TARGET[r.goal] ?? 100);
      } catch { /* endpoint optional */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [authToken, weekEndDate]);

  if (loading) return null;
  const zoneMinutes = normalizeWeeklyZones(weeklyZoneMinutes);
  const zoneTotal = zoneMinutes.reduce((sum, min) => sum + min, 0);
  const showZoneBreakdown = zoneTotal > 0;
  if (target < 60 && !showZoneBreakdown) return null;

  const minutes = currentMinutes != null
    ? Math.max(0, currentMinutes)
    : Math.max(backendMinutes, appleHealthZone2 ?? 0);
  const roundedMinutes = Math.round(minutes);
  const roundedPrevious = previousMinutes != null ? Math.round(previousMinutes) : null;
  const comparisonText = roundedPrevious != null
    ? `${roundedMinutes - roundedPrevious >= 0 ? '+' : ''}${roundedMinutes - roundedPrevious}m vs ${previousWeekLabel ?? 'previous week'}`
    : null;
  const pct = Math.max(0, Math.min(100, (minutes / target) * 100));
  const onTrack = pct >= 80;
  const color = onTrack ? tc.success : pct >= 40 ? tc.warning : tc.error;

  return (
    <View style={{
      backgroundColor: tc.surface,
      borderRadius: radius.lg,
      padding: 14,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: tc.border,
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Ionicons name="walk-outline" size={16} color={color} />
        <Text style={{ fontSize: 12, fontWeight: '800', color: tc.textPrimary, flex: 1, letterSpacing: 0.3 }}>
          Zone 2 plan week
        </Text>
        <Text style={{ fontSize: 13, fontWeight: '800', color }}>
          {roundedMinutes} / {target}m
        </Text>
      </View>
      {weekLabel ? (
        <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: -4, marginBottom: 6 }}>
          {weekLabel}
        </Text>
      ) : null}
      <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 2 }}>
        {onTrack
          ? `Aerobic base on target for this plan week.${comparisonText ? ` ${comparisonText}.` : ''}`
          : `${Math.max(0, target - roundedMinutes)} min short this plan week${comparisonText ? ` · ${comparisonText}` : ' — easy walks or bike rides count.'}`}
      </Text>

      {showZoneBreakdown && (
        <View style={{ marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: tc.border }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 7 }}>
            <Text style={{ fontSize: 10, fontWeight: '900', color: tc.textMuted, letterSpacing: 0.5 }}>
              ALL-SOURCE WEEK ZONES
            </Text>
            <Text style={{ fontSize: 10, fontWeight: '800', color: tc.textMuted }}>
              {Math.round(zoneTotal)}m total
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 13, marginTop: 4 }}>
            <ZoneDistributionDonut
              zoneMinutes={zoneMinutes}
              totalMinutes={zoneTotal}
              mutedColor={tc.textMuted}
              trackColor={tc.border}
              surfaceColor={tc.surface}
            />
            <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
              {zoneMinutes.map((min, index) => {
                const zone = HR_ZONE_BANDS[index];
                const zoneColor = hrZoneColorHex(zone.zone);
                const isEmpty = min < 0.5;
                const sharePct = zoneTotal > 0 ? Math.round((min / zoneTotal) * 100) : 0;
                const sourceRows = weeklyZoneSources?.[index] ?? [];
                const canExpand = sourceRows.length > 0;
                const expanded = expandedZone === index;
                return (
                  <View key={zone.zone}>
                    <TouchableOpacity
                      activeOpacity={canExpand ? 0.76 : 1}
                      disabled={!canExpand}
                      accessibilityRole={canExpand ? 'button' : 'text'}
                      accessibilityLabel={`Zone ${zone.zone} ${zone.label}, ${Math.round(min)} minutes${canExpand ? '. Tap to see contributing sources.' : ''}`}
                      onPress={() => setExpandedZone(expanded ? null : index)}
                      style={{
                        minHeight: 30,
                        borderRadius: 8,
                        borderWidth: 1,
                        borderColor: isEmpty ? tc.border : zoneColor + '66',
                        backgroundColor: isEmpty ? tc.surfaceRaised : zoneColor + '18',
                        paddingHorizontal: 8,
                        paddingVertical: 5,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: isEmpty ? tc.border : zoneColor }} />
                      <Text style={{ flex: 1, minWidth: 0, fontSize: 10, fontWeight: '900', color: isEmpty ? tc.textMuted : tc.textPrimary }} numberOfLines={1}>
                        Z{zone.zone} {zone.label}
                      </Text>
                      <Text style={{ fontSize: 11, fontWeight: '900', color: isEmpty ? tc.textMuted : zoneColor, fontVariant: ['tabular-nums'] as any }}>
                        {Math.round(min)}m
                      </Text>
                      <Text style={{ minWidth: 28, textAlign: 'right', fontSize: 10, fontWeight: '800', color: tc.textMuted, fontVariant: ['tabular-nums'] as any }}>
                        {sharePct}%
                      </Text>
                      <Ionicons
                        name={expanded ? 'chevron-up' : 'chevron-down'}
                        size={11}
                        color={canExpand ? tc.textMuted : 'transparent'}
                      />
                    </TouchableOpacity>
                    {expanded && (
                      <View style={{ marginTop: 6, marginBottom: 2, gap: 5 }}>
                        {sourceRows.slice(0, MAX_ZONE_SOURCES).map(source => (
                          <View
                            key={source.id}
                            style={{
                              flexDirection: 'row',
                              alignItems: 'center',
                              gap: 6,
                              paddingHorizontal: 8,
                              paddingVertical: 4,
                              borderRadius: 7,
                              backgroundColor: tc.surfaceRaised,
                              borderWidth: 1,
                              borderColor: tc.border,
                            }}
                          >
                            <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: zoneColor }} />
                            <View style={{ flex: 1, minWidth: 0 }}>
                              <Text style={{ fontSize: 10, fontWeight: '800', color: tc.textPrimary }} numberOfLines={1}>
                                {source.name}
                              </Text>
                              <Text style={{ fontSize: 9, fontWeight: '700', color: tc.textMuted }} numberOfLines={1}>
                                {source.sourceLabel} · {formatSourceDate(source.date)}
                              </Text>
                            </View>
                            <Text style={{ width: 38, textAlign: 'right', fontSize: 10, fontWeight: '900', color: zoneColor, fontVariant: ['tabular-nums'] as any }}>
                              {Math.round(source.minutes)}m
                            </Text>
                          </View>
                        ))}
                        {sourceRows.length > MAX_ZONE_SOURCES && (
                          <Text style={{ fontSize: 9, color: tc.textMuted, marginLeft: 8 }}>
                            +{sourceRows.length - MAX_ZONE_SOURCES} more source{sourceRows.length - MAX_ZONE_SOURCES === 1 ? '' : 's'}
                          </Text>
                        )}
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          </View>
          {weeklyZoneSources?.some(list => list.length > 0) ? (
            <Text style={{ fontSize: 9, color: tc.textMuted, marginTop: 8 }}>
              Tap a zone to see which sources contributed this week.
            </Text>
          ) : null}
        </View>
      )}

      {/* "Why?" expander — surfaces the per-workout breakdown so users
          can see exactly why a session they did didn't credit toward Z2.
          Most common gotcha: the workout was logged as Strength or
          HealthKit had no HR samples and the activity name wasn't a
          steady-cardio type. */}
      {detectedWorkouts && detectedWorkouts.length > 0 && (
        <TouchableOpacity
          onPress={() => setShowWhy(!showWhy)}
          activeOpacity={0.7}
          style={{ marginTop: 8, alignSelf: 'flex-start' }}
        >
          <Text style={{ fontSize: 10, color: tc.textSecondary, fontWeight: '700' }}>
            {showWhy ? '▾ Hide breakdown' : `▸ Why? · ${detectedWorkouts.length} session${detectedWorkouts.length === 1 ? '' : 's'} in this window`}
          </Text>
        </TouchableOpacity>
      )}
      {showWhy && detectedWorkouts && (
        <View style={{ marginTop: 8, gap: 4 }}>
          {detectedWorkouts.map((w, i) => (
            <View key={`${w.name}-${i}`} style={{
              flexDirection: 'row', alignItems: 'center', gap: 6,
              paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6,
              backgroundColor: w.counted ? (tc.success ?? '#22C55E') + '15' : tc.background,
              borderWidth: 1, borderColor: w.counted ? (tc.success ?? '#22C55E') + '44' : tc.border,
            }}>
              <Ionicons
                name={w.counted ? 'checkmark-circle' : 'remove-circle-outline'}
                size={12}
                color={w.counted ? (tc.success ?? '#22C55E') : tc.textMuted}
              />
              <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textPrimary, flex: 1 }} numberOfLines={1}>
                {w.name}
              </Text>
              <Text style={{ fontSize: 10, color: tc.textMuted }}>
                {Math.round(w.durationMin)}m
              </Text>
              {!w.counted && w.reason && (
                <Text style={{ fontSize: 9, color: tc.textMuted, fontStyle: 'italic' }}>
                  {w.reason}
                </Text>
              )}
            </View>
          ))}
          <Text style={{ fontSize: 9, color: tc.textMuted, marginTop: 2 }}>
            Counts toward Z2: real HR zone minutes when available; otherwise steady cardio ≥ 20 min where the activity isn't intervals/HIIT. If a session you did isn't here, log it under Cardio with a steady or easy style.
          </Text>
        </View>
      )}
    </View>
  );
}
