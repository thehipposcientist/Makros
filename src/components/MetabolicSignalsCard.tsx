import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

import {
  getMetabolicSignals,
  type MetabolicSignalEstimate,
  type MetabolicStressRhythmSegment,
  type MetabolicSignalsResponse,
} from '../services/api';
import { elevations, getContrastingTextColor, getTheme, radius, typography } from '../constants/theme';
import type { AppThemeName } from '../types';
import Svg, { Circle, Defs, Line, LinearGradient as SvgLinearGradient, Polygon, Polyline, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { TIMING_SMOOTH, useReducedMotion } from '../utils/motion';

type ThemeColors = ReturnType<typeof getTheme>['colors'];
type WindowDays = 14 | 30;
type DetailTarget =
  | { kind: 'estimate'; item: MetabolicSignalEstimate }
  | { kind: 'rhythm'; item: MetabolicStressRhythmSegment };

type SignalExplainer = {
  what: string;
  calculation: string[];
  scoreNote?: string;
};

interface Props {
  authToken: string;
  themeName?: AppThemeName;
  isActive?: boolean;
}

function scoreColor(estimate: Pick<MetabolicSignalEstimate, 'score' | 'risk_direction' | 'confidence'>, colors: ThemeColors) {
  if (estimate.confidence === 'low') return colors.textMuted;
  const favorable = favorableScore(estimate);
  if (favorable >= 76) return colors.success;
  if (favorable >= 58) return colors.primary;
  if (favorable >= 42) return colors.warning;
  return colors.error;
}

function favorableScore(estimate: Pick<MetabolicSignalEstimate, 'score' | 'risk_direction'>): number {
  return estimate.risk_direction === 'higher_is_better'
    ? estimate.score
    : 100 - estimate.score;
}

function compactTitle(title: string): string {
  return title
    .replace('Estimated ', '')
    .replace(' / reproductive-axis support', '')
    .replace(' / metabolic support', '')
    .replace('Cellular cleanup / ', '');
}

function confidenceLabel(value: string) {
  return value === 'high' ? 'High confidence' : value === 'medium' ? 'Medium confidence' : 'Building baseline';
}

function cleanList(values: Array<string | null | undefined>): string[] {
  return values.map(value => String(value ?? '').trim()).filter(Boolean);
}

function segmentRecommendations(segment: MetabolicStressRhythmSegment): string[] {
  if (segment.key === 'wake_morning') {
    return [
      'For the next 7 mornings, keep wake time within 60 min and get outdoor light or bright indoor light within the first hour.',
      'Set a 7.5-9h sleep opportunity; review sleep-breathing or low-sleep flags if they keep appearing.',
    ];
  }
  if (segment.key === 'evening_downshift') {
    return [
      'Finish hard training and large meals at least 3h before bed when possible.',
      'Use a 30-min device-off wind-down and keep the bedtime target within 60 min night to night.',
    ];
  }
  return [
    'Cap HIIT at 1-2 sessions/week, separated by at least 48h when HRV/RHR are strained.',
    'Fuel hard sessions with carbs and make the next cardio dose Zone 2/easy when stress load is elevated.',
  ];
}

const ESTIMATE_EXPLAINERS: Record<string, SignalExplainer> = {
  testosterone_support: {
    what: 'A lifestyle-support read for the recent pattern around testosterone signaling. It is not a testosterone lab value.',
    calculation: [
      'Starts from a neutral baseline and raises support for enough sleep, consistent sleep timing, progressive strength training, adequate protein, dietary fat, and energy availability.',
      'Lowers support for short sleep, low protein or fat intake, low energy availability, rapid weight loss, falling HRV, rising resting HR, sleep-breathing flags, alcohol, or very high training demand without recovery.',
      'Confidence rises when sleep, wearable recovery, nutrition, activity, profile, and optional hormone labs are present across the selected window.',
    ],
  },
  estrogen_support: {
    what: 'A reproductive-axis support read. It estimates whether recent fueling, recovery, and strain signals look supportive, not measured estrogen production.',
    calculation: [
      'Raises support for robust energy availability, adequate dietary fat, carbs that match training demand, enough sleep, stable weight trend, and reproductive context when enabled.',
      'Lowers support for low energy availability, low dietary fat, low carbs during hard training, short sleep, or rapid weight loss.',
      'Optional sex-hormone labs improve context, but the score still remains a lifestyle-support estimate.',
    ],
  },
  thyroid_metabolic_support: {
    what: 'A thyroid and metabolic-support read. It looks for patterns that tend to support metabolic hormone signaling and recovery.',
    calculation: [
      'Raises support for adequate energy availability, carbs relative to activity, steady calorie intake, sleep, micronutrient coverage, and optional thyroid labs.',
      'Lowers support for low energy availability, low carbs with training, wide calorie swings, or short sleep.',
      'Missing food logs, wearable data, or thyroid labs reduce confidence instead of being treated as automatically bad.',
    ],
  },
  cortisol_load: {
    what: 'A stress-load proxy for cortisol demand. This is the one hormone score where higher means more load, not better support.',
    calculation: [
      'Raises load for short or low-quality sleep, falling HRV, rising resting HR, high training volume, frequent HIIT, late hard workouts, low energy availability, and sleep-breathing flags.',
      'Lowers load for enough sleep, stable HRV/RHR, moderate training load, steady Zone 2, and logged recovery activity.',
      'Confidence depends on sleep, wearable recovery, nutrition, and activity coverage across the selected window.',
    ],
    scoreNote: 'For this card, lower is generally better because it means less estimated stress load.',
  },
  autophagy_opportunity: {
    what: 'Estimated from meal timing, training, sleep, carbs, and energy availability. This is not a direct measurement of autophagy.',
    calculation: [
      'Raises opportunity for current and average fasting windows, Zone 2 or steady cardio, strength training, recovery activity, and mild nutrition context.',
      'Caps or lowers opportunity when energy availability is low, sleep is short, HIIT is stacked with poor recovery, or cortisol load is high.',
      'Meal timing, nutrition, activity, and sleep coverage drive confidence.',
    ],
  },
};

const RHYTHM_EXPLAINERS: Record<string, SignalExplainer> = {
  wake_morning: {
    what: 'A morning rhythm read. It estimates whether sleep and recovery signals support a cleaner wake-time cortisol rise.',
    calculation: [
      'Raises support for enough sleep, solid sleep score, consistent bedtime, and fewer sleep-breathing disturbance flags.',
      'Lowers support for short sleep, poor sleep quality, variable bedtimes, elevated breathing flags, or low energy availability.',
      'Confidence depends mostly on sleep and wearable recovery coverage.',
    ],
  },
  daytime_load: {
    what: 'A daytime stress-load read. It estimates whether training, movement, and recovery signals are keeping daytime load manageable.',
    calculation: [
      'Raises load for frequent HIIT, heavy training, high movement stacked with hard sessions, and other stress-load drivers.',
      'Lowers load for steady cardio, recovery activity, stable HRV/RHR, and manageable training dose.',
      'Confidence depends on sleep, wearable recovery, and activity coverage.',
    ],
    scoreNote: 'Higher means more estimated daytime stress load.',
  },
  evening_downshift: {
    what: 'An evening downshift read. It estimates whether the pattern supports lower stress before sleep.',
    calculation: [
      'Raises load for late hard workouts, late logged calories, short sleep, variable bedtimes, falling HRV, rising resting HR, under-fueling, or high overall stress load.',
      'Lowers load when hard sessions are not clustered late, meal timing stops earlier, sleep is sufficient, and recovery activities appear in the evening.',
      'Confidence depends on sleep, wearable recovery, activity timing, and meal timing coverage.',
    ],
    scoreNote: 'Lower is better here because the goal is a calmer evening downshift.',
  },
};

function fallbackExplainer(item: MetabolicSignalEstimate | MetabolicStressRhythmSegment): SignalExplainer {
  return {
    what: item.summary,
    calculation: [
      item.risk_direction === 'higher_is_worse'
        ? 'The score rises when recent inputs point toward more strain or load.'
        : 'The score rises when recent inputs look more supportive.',
      'Current data used and missing inputs are listed below so confidence stays visible.',
    ],
  };
}

function explainerForDetail(detail: DetailTarget | null): SignalExplainer | null {
  if (!detail) return null;
  if (detail.kind === 'estimate') {
    return ESTIMATE_EXPLAINERS[detail.item.key] ?? fallbackExplainer(detail.item);
  }
  return RHYTHM_EXPLAINERS[detail.item.key] ?? fallbackExplainer(detail.item);
}

function DetailSection({ title, values, colors }: { title: string; values: string[]; colors: ThemeColors }) {
  if (values.length === 0) return null;
  return (
    <View style={styles.detailSection}>
      <Text style={[styles.detailSectionTitle, { color: colors.textMuted }]}>{title}</Text>
      {values.map((value, index) => (
        <View key={`${title}-${index}`} style={styles.detailBulletRow}>
          <View style={[styles.detailDot, { backgroundColor: colors.primary }]} />
          <Text style={[styles.detailBulletText, { color: colors.textSecondary }]}>{value}</Text>
        </View>
      ))}
    </View>
  );
}

function SignalInfoPanel({
  detail,
  colors,
}: {
  detail: DetailTarget;
  colors: ThemeColors;
}) {
  const info = explainerForDetail(detail);
  const used = cleanList(detail.item.data_used).slice(0, 6);
  const missing = cleanList(detail.item.missing_data).slice(0, 5);
  if (!info) return null;
  return (
    <View style={[styles.signalInfoPanel, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
      <View style={styles.signalInfoHeader}>
        <Ionicons name="information-circle-outline" size={16} color={colors.primary} />
        <Text style={[styles.signalInfoTitle, { color: colors.textPrimary }]}>About this signal</Text>
      </View>
      <Text style={[styles.detailBody, { color: colors.textSecondary }]}>{info.what}</Text>
      <Text style={[styles.signalSummary, { color: colors.textMuted }]}>{detail.item.summary}</Text>
      {info.scoreNote ? <Text style={[styles.signalSummary, { color: colors.textMuted }]}>{info.scoreNote}</Text> : null}
      <DetailSection title="How we estimate it" values={info.calculation} colors={colors} />
      <DetailSection title="Inputs used here" values={used} colors={colors} />
      <DetailSection title="Could improve confidence" values={missing} colors={colors} />
    </View>
  );
}

function coverageText(row: { label: string; days_with_data?: number; records?: number; quality: string }): string {
  const value = row.days_with_data ?? row.records ?? 0;
  const noun = row.records != null ? 'records' : 'days';
  return `${row.label}: ${value} ${noun} • ${row.quality}`;
}

function InfoPill({ label, body, colors }: { label: string; body: string; colors: ThemeColors }) {
  return (
    <View style={[styles.infoPill, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
      <Text style={[styles.infoPillLabel, { color: colors.textPrimary }]}>{label}</Text>
      <Text style={[styles.infoPillBody, { color: colors.textSecondary }]}>{body}</Text>
    </View>
  );
}

function SignalAmbientWash({
  color,
  secondaryColor,
  style,
}: {
  color: string;
  secondaryColor: string;
  style?: any;
}) {
  // Sliding ambient wash sweep removed per design. Kept as a no-op so the
  // existing call sites stay stable.
  return null;
}

function SignalScoreRail({
  score,
  color,
  trackColor,
}: {
  score: number;
  color: string;
  trackColor: string;
}) {
  const reducedMotion = useReducedMotion();
  const safeScore = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0));
  const widthAnim = useRef(new Animated.Value(reducedMotion ? safeScore : 0)).current;

  useEffect(() => {
    if (reducedMotion) {
      widthAnim.setValue(safeScore);
      return;
    }
    widthAnim.stopAnimation();
    widthAnim.setValue(0);
    Animated.timing(widthAnim, {
      toValue: safeScore,
      duration: 620,
      delay: 80,
      easing: TIMING_SMOOTH.easing,
      useNativeDriver: false,
    }).start();
  }, [reducedMotion, safeScore, widthAnim]);

  const width = widthAnim.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });

  return (
    <View style={[styles.signalRailTrack, { backgroundColor: trackColor }]}>
      <Animated.View style={[styles.signalRailFill, { width, backgroundColor: color }]}>
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(255,255,255,0.4)', 'rgba(255,255,255,0.08)', 'rgba(0,0,0,0.08)']}
          locations={[0, 0.52, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </View>
  );
}

function expectedCortisolCurve(hour: number): number {
  if (hour <= 4) return 16 + hour * 1.5;
  if (hour <= 8) return 22 + (hour - 4) * 16;
  if (hour <= 12) return 86 - (hour - 8) * 8;
  if (hour <= 18) return 54 - (hour - 12) * 5;
  return Math.max(12, 24 - (hour - 18) * 2);
}

function segmentByKey(segments: MetabolicStressRhythmSegment[], key: string): MetabolicStressRhythmSegment | null {
  return segments.find(segment => segment.key === key) ?? null;
}

function buildStressCurve(segments: MetabolicStressRhythmSegment[]) {
  const wake = segmentByKey(segments, 'wake_morning');
  const day = segmentByKey(segments, 'daytime_load');
  const evening = segmentByKey(segments, 'evening_downshift');
  const wakeSupport = wake?.confidence === 'low' ? 50 : wake?.score ?? 50;
  const dayLoad = day?.confidence === 'low' ? 45 : day?.score ?? 45;
  const eveningLoad = evening?.confidence === 'low' ? 30 : evening?.score ?? 30;

  return Array.from({ length: 13 }, (_, index) => {
    const hour = index * 2;
    const expected = expectedCortisolCurve(hour);
    let estimated = expected;
    if (hour >= 4 && hour <= 10) {
      estimated += (wakeSupport - 62) * 0.36;
    }
    if (hour >= 10 && hour <= 18) {
      estimated += (dayLoad - 42) * 0.42;
    }
    if (hour >= 18 || hour <= 4) {
      estimated += (eveningLoad - 30) * 0.48;
    }
    return {
      hour,
      expected: Math.max(8, Math.min(94, expected)),
      estimated: Math.max(8, Math.min(94, estimated)),
    };
  });
}

function StressRhythmChart({
  segments,
  selectedKey,
  colors,
}: {
  segments: MetabolicStressRhythmSegment[];
  selectedKey: string;
  colors: ThemeColors;
}) {
  const chartW = 320;
  const chartH = 170;
  const padL = 30;
  const padR = 12;
  const padT = 16;
  const padB = 28;
  const plotW = chartW - padL - padR;
  const plotH = chartH - padT - padB;
  const points = buildStressCurve(segments);
  const toX = (hour: number) => padL + (hour / 24) * plotW;
  const toY = (value: number) => padT + (1 - value / 100) * plotH;
  const estimatedLine = points.map(point => `${toX(point.hour)},${toY(point.estimated)}`).join(' ');
  const expectedLine = points.map(point => `${toX(point.hour)},${toY(point.expected)}`).join(' ');
  // Closed area under the estimated line for the gradient fill.
  const baselineY = padT + plotH;
  const estimatedArea = points.length >= 2
    ? `${estimatedLine} ${toX(points[points.length - 1].hour)},${baselineY} ${toX(points[0].hour)},${baselineY}`
    : null;
  const selectedBand = selectedKey === 'wake_morning'
    ? { start: 5, end: 10 }
    : selectedKey === 'daytime_load'
      ? { start: 10, end: 18 }
      : { start: 18, end: 24 };
  const selectedSegment = segmentByKey(segments, selectedKey);
  const selectedColor = selectedSegment ? scoreColor(selectedSegment, colors) : colors.primary;
  return (
    <View style={[styles.chartCard, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
      <View style={styles.chartHeader}>
        <Text style={[styles.chartTitle, { color: colors.textPrimary }]}>Estimated day curve</Text>
        <View style={styles.chartLegendRow}>
          <View style={[styles.chartLegendDot, { backgroundColor: selectedColor }]} />
          <Text style={[styles.chartLegendText, { color: colors.textMuted }]}>estimate</Text>
          <View style={[styles.chartLegendDot, { backgroundColor: colors.textMuted }]} />
          <Text style={[styles.chartLegendText, { color: colors.textMuted }]}>expected</Text>
        </View>
      </View>
      <Svg width="100%" height={chartH} viewBox={`0 0 ${chartW} ${chartH}`}>
        <Rect
          x={toX(selectedBand.start)}
          y={padT}
          width={Math.max(6, toX(selectedBand.end) - toX(selectedBand.start))}
          height={plotH}
          fill={selectedColor}
          opacity={0.1}
          rx={6}
        />
        {[0, 25, 50, 75, 100].map(value => {
          const y = toY(value);
          return (
            <Line
              key={`grid-${value}`}
              x1={padL}
              y1={y}
              x2={chartW - padR}
              y2={y}
              stroke={colors.border}
              strokeWidth={1}
              opacity={value === 0 ? 0.9 : 0.45}
            />
          );
        })}
        {[0, 6, 12, 18, 24].map(hour => {
          const x = toX(hour);
          const label = hour === 0 || hour === 24 ? '12a' : hour === 12 ? '12p' : `${hour}`;
          return (
            <React.Fragment key={`tick-${hour}`}>
              <Line x1={x} y1={padT} x2={x} y2={padT + plotH} stroke={colors.border} strokeWidth={1} opacity={0.28} />
              <SvgText x={x} y={chartH - 8} fontSize={9} fill={colors.textMuted} textAnchor="middle">
                {label}
              </SvgText>
            </React.Fragment>
          );
        })}
        <SvgText x={padL - 8} y={padT + 4} fontSize={9} fill={colors.textMuted} textAnchor="end">high</SvgText>
        <SvgText x={padL - 8} y={padT + plotH + 3} fontSize={9} fill={colors.textMuted} textAnchor="end">low</SvgText>
        <Polyline
          points={expectedLine}
          fill="none"
          stroke={colors.textMuted}
          strokeWidth={2}
          strokeDasharray="5,5"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.78}
        />
        {estimatedArea && (
          <>
            <Defs>
              <SvgLinearGradient id="metabolicEstimatedFill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0%" stopColor={selectedColor} stopOpacity={0.22} />
                <Stop offset="100%" stopColor={selectedColor} stopOpacity={0.02} />
              </SvgLinearGradient>
            </Defs>
            <Polygon points={estimatedArea} fill="url(#metabolicEstimatedFill)" stroke="none" />
          </>
        )}
        <Polyline
          points={estimatedLine}
          fill="none"
          stroke={selectedColor}
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {points.map(point => (
          <Circle
            key={`pt-${point.hour}`}
            cx={toX(point.hour)}
            cy={toY(point.estimated)}
            r={point.hour % 6 === 0 ? 4 : 2.5}
            fill={selectedColor}
            stroke={colors.surfaceRaised}
            strokeWidth={1.25}
          />
        ))}
      </Svg>
      <Text style={[styles.chartNote, { color: colors.textMuted }]}>
        Relative curve, not a measured cortisol lab.
      </Text>
    </View>
  );
}

function SignalPulseBubble({ score, color }: { score: number; color: string }) {
  const reducedMotion = useReducedMotion();
  const pulse = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;

  useEffect(() => {
    if (reducedMotion) {
      pulse.setValue(1);
      return;
    }
    pulse.setValue(0);
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1900,
          easing: TIMING_SMOOTH.easing,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [pulse, reducedMotion]);

  const ringOpacity = pulse.interpolate({ inputRange: [0, 0.72, 1], outputRange: [0.34, 0.08, 0] });
  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.55] });
  const bubbleScale = pulse.interpolate({ inputRange: [0, 0.42, 1], outputRange: [1, 1.06, 1] });

  return (
    <View style={styles.scoreBubbleWrap}>
      {!reducedMotion && (
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFillObject,
            styles.scorePulseRing,
            { borderColor: color, opacity: ringOpacity, transform: [{ scale: ringScale }] },
          ]}
        />
      )}
      <Animated.View
        style={[
          styles.scoreBubble,
          { backgroundColor: color + '18', borderColor: color + '66', transform: [{ scale: bubbleScale }] },
        ]}>
        <Text style={[styles.scoreText, { color }]}>{score}</Text>
      </Animated.View>
    </View>
  );
}

function EstimateRow({
  estimate,
  colors,
  onPress,
}: {
  estimate: MetabolicSignalEstimate;
  colors: ThemeColors;
  onPress: () => void;
}) {
  const color = scoreColor(estimate, colors);
  const favorable = favorableScore(estimate);
  return (
    <TouchableOpacity
      activeOpacity={0.84}
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.estimateRow, { borderTopColor: colors.border + '66' }]}>
      {/* Row gradient wash removed per design — rows stay flat; the score
          bubble pulses (matching the biometric tiles). */}
      <SignalPulseBubble score={estimate.score} color={color} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.estimateTitleRow}>
          <Text style={[styles.estimateTitle, { color: colors.textPrimary }]} numberOfLines={1}>
            {compactTitle(estimate.title)}
          </Text>
          <Text style={[styles.confidenceText, { color: estimate.confidence === 'low' ? colors.textMuted : color }]} numberOfLines={1}>
            {estimate.confidence}
          </Text>
        </View>
        <Text style={[styles.estimateLabel, { color }]} numberOfLines={1}>{estimate.label}</Text>
        <SignalScoreRail score={favorable} color={color} trackColor={colors.border + '55'} />
      </View>
      <Ionicons name="chevron-forward" size={17} color={colors.textMuted} />
    </TouchableOpacity>
  );
}

function RhythmSegment({
  segment,
  colors,
  onPress,
}: {
  segment: MetabolicStressRhythmSegment;
  colors: ThemeColors;
  onPress: () => void;
}) {
  const color = scoreColor(segment, colors);
  const favorable = favorableScore(segment);
  return (
    <TouchableOpacity
      activeOpacity={0.84}
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.rhythmSegment, { borderColor: color + '55', backgroundColor: color + '0F' }]}>
      <LinearGradient
        pointerEvents="none"
        colors={[color + '1A', colors.surfaceRaised + '00']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View style={styles.rhythmSegmentHeader}>
        <Text style={[styles.rhythmScore, { color }]}>{segment.score}</Text>
        <Text style={[styles.rhythmConfidence, { color: segment.confidence === 'low' ? colors.textMuted : color }]}>
          {segment.confidence}
        </Text>
      </View>
      <Text style={[styles.rhythmTitle, { color: colors.textPrimary }]} numberOfLines={1}>{segment.title}</Text>
      <Text style={[styles.rhythmLabel, { color }]} numberOfLines={1}>{segment.label}</Text>
      <Text style={[styles.rhythmWindow, { color: colors.textMuted }]} numberOfLines={2}>{segment.window_label}</Text>
      <SignalScoreRail score={favorable} color={color} trackColor={colors.border + '4D'} />
    </TouchableOpacity>
  );
}

export default function MetabolicSignalsCard({ authToken, themeName, isActive = true }: Props) {
  const colors = getTheme(themeName).colors;
  const [windowDays, setWindowDays] = useState<WindowDays>(30);
  const [data, setData] = useState<MetabolicSignalsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<DetailTarget | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [signalInfoOpen, setSignalInfoOpen] = useState(false);

  const load = useCallback(async () => {
    if (!authToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await getMetabolicSignals(authToken, windowDays);
      setData(result);
    } catch (err: any) {
      setError(String(err?.message ?? 'Unable to load metabolic signals'));
    } finally {
      setLoading(false);
    }
  }, [authToken, windowDays]);

  useEffect(() => {
    if (!isActive) return;
    load().catch(() => undefined);
  }, [isActive, load]);

  const primaryText = getContrastingTextColor(colors.primary);
  const coverageRows = useMemo(() => {
    const coverage = data?.data_coverage;
    if (!coverage) return [];
    return ['sleep', 'nutrition', 'health', 'activity', 'meal_timing']
      .map(key => coverage[key])
      .filter(Boolean)
      .slice(0, 5);
  }, [data]);
  const selectedColor = selectedDetail ? scoreColor(selectedDetail.item, colors) : colors.primary;
  const selectedExplainer = explainerForDetail(selectedDetail);
  const selectedIsOpportunity = selectedDetail?.kind === 'estimate' && selectedDetail.item.key === 'autophagy_opportunity';
  const selectedTitle = selectedDetail
    ? selectedDetail.kind === 'estimate'
      ? compactTitle(selectedDetail.item.title)
      : selectedDetail.item.title
    : '';
  const selectedRecommendations = selectedDetail
    ? selectedDetail.kind === 'estimate'
      ? cleanList(selectedDetail.item.recommendations)
      : segmentRecommendations(selectedDetail.item)
    : [];
  const selectedSupporting = selectedDetail
    ? selectedDetail.kind === 'estimate'
      ? cleanList(selectedDetail.item.positive_factors)
      : selectedDetail.item.risk_direction === 'higher_is_better'
        ? selectedDetail.item.score >= 58 ? cleanList(selectedDetail.item.drivers) : []
        : selectedDetail.item.score < 58 ? cleanList(selectedDetail.item.drivers) : []
    : [];
  const selectedLimits = selectedDetail
    ? selectedDetail.kind === 'estimate'
      ? cleanList(selectedDetail.item.limiting_factors)
      : selectedDetail.item.risk_direction === 'higher_is_better'
        ? selectedDetail.item.score < 58 ? cleanList(selectedDetail.item.drivers) : []
        : selectedDetail.item.score >= 58 ? cleanList(selectedDetail.item.drivers) : []
    : [];
  const limitTitle = selectedDetail?.item.risk_direction === 'higher_is_worse'
    ? "What's raising load"
    : selectedIsOpportunity ? "What's limiting opportunity" : "What's hurting support";
  const supportingTitle = selectedDetail?.item.risk_direction === 'higher_is_worse'
    ? "What's lowering load"
    : selectedIsOpportunity ? "What's raising opportunity" : "What's helping support";
  const recommendationTitle = selectedDetail?.item.risk_direction === 'higher_is_worse'
    ? 'Lower load'
    : selectedIsOpportunity ? 'Improve opportunity' : 'Raise support';
  const openDetail = useCallback((detail: DetailTarget) => {
    setSignalInfoOpen(false);
    setSelectedDetail(detail);
  }, []);
  const closeDetail = useCallback(() => {
    setSignalInfoOpen(false);
    setSelectedDetail(null);
  }, []);

  return (
    <View testID="metabolic-signals-card" style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <SignalAmbientWash color={colors.primary} secondaryColor={colors.accent} style={styles.cardAmbientWash} />
      <View style={styles.header}>
        <View style={[styles.iconCircle, { backgroundColor: colors.primary + '18', borderColor: colors.primary + '35' }]}>
          <LinearGradient
            pointerEvents="none"
            colors={[colors.primary + '24', colors.accent + '10', 'rgba(255,255,255,0)']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          <Ionicons name="analytics-outline" size={17} color={colors.primary} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.eyebrow, { color: colors.textMuted }]}>Metabolic estimate</Text>
          <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={1}>Hormone + Cellular Signals</Text>
        </View>
        <TouchableOpacity
          activeOpacity={0.82}
          accessibilityRole="button"
          accessibilityLabel="About hormone and cellular signals"
          onPress={() => setInfoOpen(true)}
          style={[styles.infoButton, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
          <Ionicons name="information-circle-outline" size={18} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={[styles.segmented, { backgroundColor: colors.surfaceRaised, borderColor: colors.border }]}>
          {([14, 30] as WindowDays[]).map(days => {
            const active = days === windowDays;
            return (
              <TouchableOpacity
                key={days}
                activeOpacity={0.82}
                onPress={() => setWindowDays(days)}
                style={[styles.segmentButton, active && { backgroundColor: colors.primary }]}>
                <Text style={[styles.segmentText, { color: active ? primaryText : colors.textSecondary }]}>
                  {days}d
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {loading && !data ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator color={colors.primary} />
          <Text style={[styles.mutedText, { color: colors.textMuted }]}>Building rolling estimates...</Text>
        </View>
      ) : error && !data ? (
        <View style={styles.emptyState}>
          <Ionicons name="cloud-offline-outline" size={22} color={colors.textMuted} />
          <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>Signals unavailable</Text>
          <Text style={[styles.emptyBody, { color: colors.textMuted }]}>{error}</Text>
        </View>
      ) : data ? (
        <>
          {data.stress_rhythm ? (
            <View style={[styles.rhythmBox, { borderTopColor: colors.border + '66' }]}>
              <View style={styles.rhythmHeader}>
                <View style={styles.rhythmTitleRow}>
                  <Ionicons name="pulse-outline" size={14} color={colors.primary} />
                  <Text style={[styles.rhythmBoxTitle, { color: colors.textPrimary }]}>Stress / cortisol rhythm</Text>
                </View>
                <Text style={[styles.confidenceText, { color: colors.textMuted }]}>{data.stress_rhythm.confidence}</Text>
              </View>
              <View style={styles.rhythmGrid}>
                {data.stress_rhythm.segments.map(segment => (
                  <RhythmSegment
                    key={segment.key}
                    segment={segment}
                    colors={colors}
                    onPress={() => openDetail({ kind: 'rhythm', item: segment })}
                  />
                ))}
              </View>
            </View>
          ) : null}

          <View style={styles.estimateList}>
            {data.hormone_support.estimates.map(estimate => (
              <EstimateRow
                key={estimate.key}
                estimate={estimate}
                colors={colors}
                onPress={() => openDetail({ kind: 'estimate', item: estimate })}
              />
            ))}
            <EstimateRow
              estimate={data.autophagy}
              colors={colors}
              onPress={() => openDetail({ kind: 'estimate', item: data.autophagy })}
            />
          </View>
          {loading ? <ActivityIndicator color={colors.primary} size="small" style={{ marginTop: 8 }} /> : null}
        </>
      ) : null}

      <Modal
        visible={!!selectedDetail}
        transparent
        animationType="fade"
        onRequestClose={closeDetail}>
        <View style={styles.modalOverlay}>
          <View style={[styles.detailSheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={styles.detailHeader}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[styles.eyebrow, { color: colors.textMuted }]}>
                  {selectedDetail?.kind === 'rhythm' ? 'Daypart rhythm' : 'Signal detail'}
                </Text>
                <Text style={[styles.detailTitle, { color: colors.textPrimary }]} numberOfLines={2}>{selectedTitle}</Text>
              </View>
              <View style={styles.detailHeaderActions}>
                {selectedExplainer ? (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={`About ${selectedTitle}`}
                    activeOpacity={0.8}
                    onPress={() => setSignalInfoOpen(value => !value)}
                    style={[
                      styles.closeButton,
                      {
                        borderColor: signalInfoOpen ? selectedColor + '66' : colors.border,
                        backgroundColor: signalInfoOpen ? selectedColor + '12' : colors.surfaceRaised,
                      },
                    ]}>
                    <Ionicons name="information-circle-outline" size={18} color={signalInfoOpen ? selectedColor : colors.textPrimary} />
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity
                  accessibilityRole="button"
                  activeOpacity={0.8}
                  onPress={closeDetail}
                  style={[styles.closeButton, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
                  <Ionicons name="close" size={18} color={colors.textPrimary} />
                </TouchableOpacity>
              </View>
            </View>

              {selectedDetail ? (
                <ScrollView style={styles.detailScroll} contentContainerStyle={styles.detailScrollContent} showsVerticalScrollIndicator={false}>
                  <View style={[styles.detailScoreBand, { borderColor: selectedColor + '55', backgroundColor: selectedColor + '10' }]}>
                    <Text style={[styles.detailScore, { color: selectedColor }]}>{selectedDetail.item.score}</Text>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={[styles.detailLabel, { color: selectedColor }]}>{selectedDetail.item.label}</Text>
                      <Text style={[styles.detailConfidence, { color: colors.textMuted }]}>
                        {confidenceLabel(selectedDetail.item.confidence)} • {selectedDetail.item.status.replace(/_/g, ' ')}
                      </Text>
                    </View>
                  </View>

                  {signalInfoOpen ? <SignalInfoPanel detail={selectedDetail} colors={colors} /> : null}

                  {selectedDetail.kind === 'rhythm' ? (
                    <>
                      <StressRhythmChart
                        segments={data?.stress_rhythm?.segments ?? [selectedDetail.item]}
                        selectedKey={selectedDetail.item.key}
                        colors={colors}
                      />
                    </>
                  ) : null}

                  <DetailSection title={supportingTitle} values={selectedSupporting} colors={colors} />
                  <DetailSection title={limitTitle} values={selectedLimits} colors={colors} />
                  <DetailSection title={recommendationTitle} values={selectedRecommendations} colors={colors} />
                </ScrollView>
            ) : null}
          </View>
        </View>
      </Modal>

      <Modal
        visible={infoOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setInfoOpen(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.detailSheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={styles.detailHeader}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[styles.eyebrow, { color: colors.textMuted }]}>How this works</Text>
                <Text style={[styles.detailTitle, { color: colors.textPrimary }]} numberOfLines={2}>
                  Hormone + Cellular Signals
                </Text>
              </View>
              <TouchableOpacity
                accessibilityRole="button"
                activeOpacity={0.8}
                onPress={() => setInfoOpen(false)}
                style={[styles.closeButton, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
                <Ionicons name="close" size={18} color={colors.textPrimary} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.detailScroll} contentContainerStyle={styles.detailScrollContent} showsVerticalScrollIndicator={false}>
              <Text style={[styles.detailBody, { color: colors.textSecondary }]}>
                These are lifestyle-support estimates. Thallo is not measuring hormone levels or autophagic flux; it is estimating whether the recent pattern looks supportive, strained, or still too sparse to call.
              </Text>
              <DetailSection
                title="What this panel uses"
                values={[
                  'Rolling 14- or 30-day sleep, wearable recovery, logged nutrition, activity, meal timing, body trend, and optional labs.',
                  'Missing inputs reduce confidence instead of being treated as automatically bad.',
                  'Most support cards are higher-is-better; cortisol load and some rhythm segments are higher-is-more-strain.',
                ]}
                colors={colors}
              />
              <View style={styles.infoGrid}>
                <InfoPill label="Sleep" body="Duration, score, bedtime consistency, HRV/RHR, SpO2, respiratory rate, and breathing disturbance flags." colors={colors} />
                <InfoPill label="Nutrition" body="Calories, protein, carbs, fat %, energy availability, micronutrient coverage, alcohol, and meal timing." colors={colors} />
                <InfoPill label="Activity" body="Heavy strength, HIIT/intervals, steady cardio, Zone 2, recovery/mobility, sport, active labor, and timing." colors={colors} />
                <InfoPill label="Body + labs" body="Body size, weight trend, sex/age context, and optional hormone, thyroid, cortisol, or metabolic labs." colors={colors} />
              </View>
              {coverageRows.length > 0 ? (
                <DetailSection
                  title="Current coverage"
                  values={coverageRows.map(coverageText)}
                  colors={colors}
                />
              ) : null}
              <DetailSection
                title="Why we say support"
                values={[
                  'Support means the inputs are favorable for normal physiology; it does not mean Thallo knows exact hormone production.',
                  'Low confidence means we either hide specificity or describe the read as a baseline-building estimate.',
                  'Individual estimates use tailored support logic rather than one universal formula.',
                ]}
                colors={colors}
              />
              <Text style={[styles.detailDisclaimer, { color: colors.textMuted }]}>
                {data?.disclaimer ?? 'Lifestyle-support estimate only. Thallo is not measuring hormone levels, autophagic flux, or diagnosing medical conditions.'}
              </Text>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 20,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    position: 'relative',
    overflow: 'hidden',
    ...elevations.card,
  },
  ambientWash: {
    position: 'absolute',
    top: -42,
    bottom: -42,
    width: 118,
  },
  cardAmbientWash: {
    right: 12,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  iconCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    overflow: 'hidden',
  },
  eyebrow: { fontSize: 10, fontWeight: '900', textTransform: 'uppercase' },
  title: { ...typography.cardTitle },
  infoButton: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  segmented: { flexDirection: 'row', borderRadius: radius.full, borderWidth: 1, padding: 2 },
  segmentButton: { minWidth: 38, minHeight: 28, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  segmentText: { fontSize: 11, fontWeight: '900' },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 14 },
  mutedText: { fontSize: 12 },
  emptyState: { alignItems: 'center', paddingVertical: 16, gap: 6 },
  emptyTitle: { fontSize: 14, fontWeight: '900' },
  emptyBody: { fontSize: 12, lineHeight: 17, textAlign: 'center' },
  rhythmBox: { borderTopWidth: 1, marginTop: 10, paddingTop: 12 },
  rhythmHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  rhythmTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 },
  rhythmBoxTitle: { fontSize: 13, lineHeight: 17, fontWeight: '900' },
  rhythmGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  rhythmSegment: { flexGrow: 1, flexBasis: '31%', minWidth: 96, borderWidth: 1, borderRadius: radius.md, padding: 9, overflow: 'hidden', position: 'relative' },
  rhythmSegmentHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 5 },
  rhythmScore: { fontSize: 17, lineHeight: 20, fontWeight: '900', fontVariant: ['tabular-nums'] as any },
  rhythmConfidence: { fontSize: 8, lineHeight: 10, fontWeight: '900', textTransform: 'uppercase' },
  rhythmTitle: { fontSize: 11, lineHeight: 14, fontWeight: '900', marginTop: 3 },
  rhythmLabel: { fontSize: 10, lineHeight: 13, fontWeight: '900', marginTop: 2 },
  rhythmWindow: { fontSize: 9, lineHeight: 12, fontWeight: '800', marginTop: 3 },
  estimateList: { marginTop: 4 },
  estimateRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, borderTopWidth: 1, position: 'relative', overflow: 'visible' },
  scoreBubbleWrap: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', overflow: 'visible' },
  scorePulseRing: { borderRadius: 22, borderWidth: 1.5 },
  scoreBubble: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 1, overflow: 'hidden' },
  scoreText: { fontSize: 17, fontWeight: '900', fontVariant: ['tabular-nums'] as any },
  estimateTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  estimateTitle: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: '900' },
  confidenceText: { fontSize: 10, fontWeight: '900', textTransform: 'uppercase' },
  estimateLabel: { fontSize: 11, fontWeight: '900', marginTop: 2, textTransform: 'uppercase' },
  signalRailTrack: { height: 4, borderRadius: radius.full, overflow: 'hidden', marginTop: 7 },
  signalRailFill: { height: '100%', borderRadius: radius.full, overflow: 'hidden' },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.46)',
  },
  detailSheet: {
    maxHeight: '86%',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    paddingTop: 16,
    paddingHorizontal: 16,
  },
  detailHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
  detailHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  detailTitle: { fontSize: 18, lineHeight: 23, fontWeight: '900' },
  closeButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailScroll: { maxHeight: '100%' },
  detailScrollContent: { paddingBottom: 28 },
  detailScoreBand: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: radius.lg, padding: 12, marginBottom: 12 },
  detailScore: { fontSize: 34, lineHeight: 38, fontWeight: '900', fontVariant: ['tabular-nums'] as any },
  detailLabel: { fontSize: 13, lineHeight: 17, fontWeight: '900', textTransform: 'uppercase' },
  detailConfidence: { fontSize: 11, lineHeight: 15, fontWeight: '800', marginTop: 2, textTransform: 'capitalize' },
  signalInfoPanel: { borderWidth: 1, borderRadius: radius.lg, padding: 12, marginBottom: 12 },
  signalInfoHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  signalInfoTitle: { fontSize: 13, lineHeight: 17, fontWeight: '900' },
  signalSummary: { fontSize: 11, lineHeight: 16, marginTop: 6 },
  chartCard: { borderWidth: 1, borderRadius: radius.lg, padding: 12, marginBottom: 12 },
  chartHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 4 },
  chartTitle: { fontSize: 13, lineHeight: 17, fontWeight: '900' },
  chartLegendRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  chartLegendDot: { width: 7, height: 7, borderRadius: 4 },
  chartLegendText: { fontSize: 9, lineHeight: 12, fontWeight: '800' },
  chartNote: { fontSize: 10, lineHeight: 14, marginTop: 2 },
  detailBody: { fontSize: 13, lineHeight: 19 },
  detailSection: { marginTop: 14, gap: 7 },
  detailSectionTitle: { fontSize: 10, lineHeight: 13, fontWeight: '900', textTransform: 'uppercase' },
  detailBulletRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  detailDot: { width: 5, height: 5, borderRadius: 3, marginTop: 7 },
  detailBulletText: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 18 },
  infoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  infoPill: { flexGrow: 1, flexBasis: '47%', minWidth: 130, borderWidth: 1, borderRadius: radius.md, padding: 10 },
  infoPillLabel: { fontSize: 12, lineHeight: 15, fontWeight: '900' },
  infoPillBody: { fontSize: 11, lineHeight: 16, marginTop: 4 },
  detailDisclaimer: { fontSize: 10, lineHeight: 15, marginTop: 16 },
});
