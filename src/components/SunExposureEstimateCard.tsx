import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { ActivityIndicator, Animated, ImageBackground, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import PhotoScrim, { overPhotoTextShadow } from './PhotoScrim';
import Svg, { Circle, G } from 'react-native-svg';
import { getTheme, radius } from '../constants/theme';
import type { AppThemeName, SunExposureDailySummary } from '../types';
import { TIMING_SMOOTH, useReducedMotion } from '../utils/motion';
import AnimatedNumber from './AnimatedNumber';
import {
  type CurrentUvGuidance,
  estimatedOutdoorDaylightMinutes,
  formatLux,
  formatSunMinutes,
  sunExposureScore,
  sunExposureDisplayColor,
  sunExposureScoreHelp,
  sunExposureScoreMeaning,
  sunExposureScoreStatus,
  sunExposureScoreTitle,
  uvRiskLabel,
  uvRiskScore,
  uvRiskScoreColor,
} from '../utils/sunExposure';

interface Props {
  summary: SunExposureDailySummary | null;
  themeName?: AppThemeName;
  loading?: boolean;
  onOpenDetails?: () => void;
  onOpenHistory?: () => void;
  onOpenSettings?: () => void;
  detailsOpen?: boolean;
  historyOpen?: boolean;
  currentUvGuidance?: CurrentUvGuidance | null;
  /** Half-width two-up variant: speedometer gauge + icon-only actions. */
  compact?: boolean;
}

const SUN_EXPOSURE_HEADER_SOURCE = require('../../assets/images/card-backgrounds/sun-exposure-card-beach.jpg');

function ConfidenceBadge({ confidence, color }: { confidence: string; color: string }) {
  return (
    <View style={[styles.badge, { backgroundColor: `${color}18`, borderColor: `${color}55` }]}>
      <Text style={[styles.badgeText, { color }]}>DATA: {confidence.toUpperCase()}</Text>
    </View>
  );
}

// 270° "speedometer" dial (open at the bottom). Drawn with a dashed full
// circle rotated so the gap sits at the bottom — robust vs. hand-computed
// arc paths, and visually distinct from the Thallo Score donut.
function SunSpeedometer({
  score, color, trackColor, mutedColor, size = 94,
}: {
  score: number; color: string; trackColor: string; mutedColor: string; size?: number;
}) {
  const reducedMotion = useReducedMotion();
  const stroke = 9;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const sweep = 0.75; // 270°
  const arcLen = circumference * sweep;
  const frac = Math.max(0, Math.min(1, (Number.isFinite(score) ? score : 0) / 100));
  const revealAnim = useRef(new Animated.Value(reducedMotion ? frac : 0)).current;
  const [animatedFrac, setAnimatedFrac] = useState(reducedMotion ? frac : 0);

  useEffect(() => {
    const listener = revealAnim.addListener(({ value }) => {
      setAnimatedFrac(Math.max(0, Math.min(1, value)));
    });
    if (reducedMotion) {
      revealAnim.setValue(frac);
      setAnimatedFrac(frac);
      return () => revealAnim.removeListener(listener);
    }
    revealAnim.stopAnimation();
    revealAnim.setValue(0);
    setAnimatedFrac(0);
    Animated.timing(revealAnim, {
      toValue: frac,
      duration: 780,
      easing: TIMING_SMOOTH.easing,
      useNativeDriver: false,
    }).start();
    return () => revealAnim.removeListener(listener);
  }, [frac, reducedMotion, revealAnim]);

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size}>
        <G rotation={135} origin={`${cx}, ${cy}`}>
          <Circle
            cx={cx} cy={cy} r={r} fill="none"
            stroke={trackColor} strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={`${arcLen} ${circumference}`}
          />
          <Circle
            cx={cx} cy={cy} r={r} fill="none"
            stroke={color} strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={`${arcLen * animatedFrac} ${circumference}`}
          />
        </G>
      </Svg>
      <View style={{ position: 'absolute', alignItems: 'center' }}>
        <AnimatedNumber
          value={score}
          from={0}
          animateOnMount={!reducedMotion}
          duration={780}
          style={{ fontSize: 28, lineHeight: 30, fontWeight: '900', color }}
        />
        <Text style={{ fontSize: 9, fontWeight: '800', color: mutedColor }}>/ 100</Text>
      </View>
    </View>
  );
}

function SunScoreRail({
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
      duration: 760,
      delay: 90,
      easing: TIMING_SMOOTH.easing,
      useNativeDriver: false,
    }).start();
  }, [reducedMotion, safeScore, widthAnim]);

  const width = widthAnim.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });

  return (
    <View style={[styles.scoreRailTrack, { backgroundColor: trackColor }]}>
      <Animated.View style={[styles.scoreRailFill, { width, backgroundColor: color }]}>
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(255,255,255,0.42)', 'rgba(255,255,255,0.08)', 'rgba(0,0,0,0.08)']}
          locations={[0, 0.5, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFillObject}
        />
      </Animated.View>
    </View>
  );
}

function AnimatedSunWash({
  color,
  style,
  opacity = 0.34,
}: {
  color: string;
  style?: any;
  opacity?: number;
}) {
  // Sliding sun-wash sweep removed per design. Kept as a no-op so the existing
  // call sites stay stable.
  return null;
}

function SunMetricTile({
  value,
  label,
  color,
  colors,
}: {
  value: string;
  label: string;
  color: string;
  colors: ReturnType<typeof getTheme>['colors'];
}) {
  return (
    <View style={[styles.metricTile, { backgroundColor: colors.surfaceRaised, borderColor: color + '30' }]}>
      <LinearGradient
        pointerEvents="none"
        colors={[color + '1C', color + '08', 'rgba(255,255,255,0)']}
        locations={[0, 0.58, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Text style={[styles.metricValue, { color: colors.textPrimary }]}>{value}</Text>
      <Text style={[styles.metricLabel, { color: colors.textMuted }]}>{label}</Text>
    </View>
  );
}

function currentUvGuidanceColor(guidance: CurrentUvGuidance): string {
  if (guidance.level === 'very_high') return '#DC2626';
  if (guidance.level === 'high') return '#EF4444';
  if (guidance.level === 'moderate') return '#F59E0B';
  return '#22C55E';
}

function currentUvGuidanceIcon(guidance: CurrentUvGuidance): ComponentProps<typeof Ionicons>['name'] {
  if (guidance.level === 'very_high' || guidance.level === 'high') return 'warning-outline';
  if (guidance.level === 'moderate') return 'partly-sunny-outline';
  return 'sunny-outline';
}

function compactUvGuidanceCopy(guidance: CurrentUvGuidance): string {
  if (guidance.level === 'very_high') return `${guidance.title} · avoid direct sun`;
  if (guidance.level === 'high') return `${guidance.title} · shade or go later`;
  if (guidance.level === 'moderate') return `${guidance.title} · use protection`;
  return `${guidance.title} · good daylight window`;
}

function CurrentUvGuidanceCard({
  guidance,
  colors,
}: {
  guidance: CurrentUvGuidance;
  colors: ReturnType<typeof getTheme>['colors'];
}) {
  const color = currentUvGuidanceColor(guidance);
  return (
    <View style={[styles.currentUvCard, { backgroundColor: `${color}12`, borderColor: `${color}45` }]}>
      <View style={[styles.currentUvIconBubble, { backgroundColor: `${color}18` }]}>
        <Ionicons name={currentUvGuidanceIcon(guidance)} size={17} color={color} />
      </View>
      <View style={styles.currentUvTextBlock}>
        <Text style={[styles.currentUvTitle, { color }]}>{guidance.title}</Text>
        <Text style={[styles.currentUvDetail, { color: colors.textSecondary }]}>{guidance.detail}</Text>
      </View>
    </View>
  );
}

export default function SunExposureEstimateCard({
  summary,
  themeName,
  loading,
  onOpenDetails,
  onOpenHistory,
  onOpenSettings,
  detailsOpen,
  historyOpen,
  currentUvGuidance,
  compact,
}: Props) {
  const tc = getTheme(themeName).colors;
  const reducedMotion = useReducedMotion();
  const exposureScore = sunExposureScore(summary);
  const scoreTitle = sunExposureScoreTitle(summary);
  const scoreStatus = sunExposureScoreStatus(summary);
  const scoreColor = sunExposureDisplayColor(summary);
  const scoreMeaning = sunExposureScoreMeaning(summary);
  const scoreHelp = sunExposureScoreHelp(summary);
  const daylightMinutes = estimatedOutdoorDaylightMinutes(summary);
  const riskScore = uvRiskScore(summary);
  const riskLabel = uvRiskLabel(summary);
  const riskColor = uvRiskScoreColor(riskScore);
  const normalizedScoreStatus = scoreStatus.toLowerCase();
  const scoreIcon: ComponentProps<typeof Ionicons>['name'] =
    normalizedScoreStatus.includes('low')
      ? 'warning-outline'
      : exposureScore >= 70
        ? 'checkmark-circle-outline'
        : 'information-circle-outline';
  const actions = onOpenDetails || onOpenHistory || onOpenSettings ? (
    <View style={styles.actions}>
      {onOpenDetails ? (
        <TouchableOpacity
          testID="sun-exposure-details"
          accessibilityLabel="sun-exposure-details"
          onPress={onOpenDetails}
          style={[
            styles.secondaryButton,
            { borderColor: detailsOpen ? tc.primary : tc.border },
            detailsOpen ? { backgroundColor: `${tc.primary}16` } : null,
          ]}>
          <Ionicons name="list-outline" size={15} color={tc.textSecondary} />
          <Text style={[styles.secondaryButtonText, { color: tc.textSecondary }]}>Details</Text>
        </TouchableOpacity>
      ) : null}
      {onOpenHistory ? (
        <TouchableOpacity
          testID="sun-exposure-history"
          accessibilityLabel="sun-exposure-history"
          onPress={onOpenHistory}
          style={[
            styles.secondaryButton,
            { borderColor: historyOpen ? tc.primary : tc.border },
            historyOpen ? { backgroundColor: `${tc.primary}16` } : null,
          ]}>
          <Ionicons name="calendar-outline" size={15} color={tc.textSecondary} />
          <Text style={[styles.secondaryButtonText, { color: tc.textSecondary }]}>History</Text>
        </TouchableOpacity>
      ) : null}
      {onOpenSettings ? (
        <TouchableOpacity
          testID="sun-exposure-settings"
          accessibilityLabel="sun-exposure-settings"
          onPress={onOpenSettings}
          style={[styles.secondaryButton, { borderColor: tc.border }]}>
          <Ionicons name="settings-outline" size={15} color={tc.textSecondary} />
          <Text style={[styles.secondaryButtonText, { color: tc.textSecondary }]}>Settings</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  ) : null;

  if (compact) {
    return (
      <TouchableOpacity
        activeOpacity={onOpenDetails ? 0.85 : 1}
        onPress={onOpenDetails}
        testID="sun-exposure-compact"
        accessibilityRole="button"
        accessibilityLabel={`Sun exposure score ${exposureScore}. ${scoreTitle}. ${scoreStatus}. ${scoreMeaning}${currentUvGuidance ? ` ${currentUvGuidance.title}. ${currentUvGuidance.detail}` : ''}`}
        style={[styles.card, styles.compactCard, { backgroundColor: tc.surface, borderColor: tc.border }]}>
        <ImageBackground
          source={SUN_EXPOSURE_HEADER_SOURCE}
          resizeMode="cover"
          imageStyle={styles.compactPhotoImage}
          style={styles.compactPhotoHeader}>
          <View style={styles.compactPhotoShade} />
          <AnimatedSunWash color={scoreColor} opacity={0.24} style={styles.compactSunWash} />
          <PhotoScrim strength="soft" />
          <View style={styles.compactPhotoRow}>
            <View style={styles.compactTitleRow}>
              <Ionicons name="partly-sunny-outline" size={14} color="#FFFFFF" />
              <Text style={styles.compactPhotoTitle} numberOfLines={1}>{summary ? scoreTitle : 'Sun Exposure'}</Text>
            </View>
            <View style={styles.compactIconRow}>
              {onOpenHistory ? (
                <TouchableOpacity
                  testID="sun-exposure-history"
                  accessibilityLabel="sun-exposure-history"
                  onPress={onOpenHistory}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={[styles.compactPhotoIconBtn, historyOpen ? { backgroundColor: 'rgba(255,255,255,0.34)' } : null]}>
                  <Ionicons name="calendar-outline" size={13} color="#FFFFFF" />
                </TouchableOpacity>
              ) : null}
              {onOpenSettings ? (
                <TouchableOpacity
                  testID="sun-exposure-settings"
                  accessibilityLabel="sun-exposure-settings"
                  onPress={onOpenSettings}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={styles.compactPhotoIconBtn}>
                  <Ionicons name="settings-outline" size={13} color="#FFFFFF" />
                </TouchableOpacity>
              ) : null}
            </View>
          </View>
        </ImageBackground>
        <View style={styles.compactBody}>
          {loading ? (
            <ActivityIndicator size="small" color={tc.primary} />
          ) : (
            <>
              <Text style={[styles.compactEyebrow, { color: tc.textMuted }]} numberOfLines={1}>DAYLIGHT SCORE</Text>
              <SunSpeedometer score={exposureScore} color={scoreColor} trackColor={tc.border} mutedColor={tc.textMuted} />
              <Text style={[styles.compactScoreLabel, { color: scoreColor }]} numberOfLines={1}>{scoreStatus}</Text>
              <Text style={[styles.compactDaylight, { color: tc.textMuted }]} numberOfLines={2}>
                {summary ? `${scoreMeaning} ${formatSunMinutes(daylightMinutes)} daylight` : 'No daylight yet'}
              </Text>
              {currentUvGuidance ? (
                <View style={[
                  styles.compactUvPill,
                  {
                    backgroundColor: `${currentUvGuidanceColor(currentUvGuidance)}12`,
                    borderColor: `${currentUvGuidanceColor(currentUvGuidance)}45`,
                  },
                ]}>
                  <Ionicons
                    name={currentUvGuidanceIcon(currentUvGuidance)}
                    size={12}
                    color={currentUvGuidanceColor(currentUvGuidance)}
                  />
                  <Text
                    style={[styles.compactUvText, { color: currentUvGuidanceColor(currentUvGuidance) }]}
                    numberOfLines={2}>
                    {compactUvGuidanceCopy(currentUvGuidance)}
                  </Text>
                </View>
              ) : null}
            </>
          )}
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <View style={[styles.card, { backgroundColor: tc.surface, borderColor: tc.border }]}>
      <ImageBackground
        source={SUN_EXPOSURE_HEADER_SOURCE}
        resizeMode="cover"
        imageStyle={styles.photoHeaderImage}
        style={styles.photoHeader}>
        <View style={styles.photoShade} />
        <LinearGradient
          pointerEvents="none"
          colors={[scoreColor + '22', 'rgba(255,255,255,0)', 'rgba(0,0,0,0.16)']}
          locations={[0, 0.52, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <AnimatedSunWash color={scoreColor} opacity={0.28} style={styles.photoSunWash} />
        <PhotoScrim strength="soft" />
        <View style={styles.photoHeaderContent}>
          <View style={styles.titleRow}>
            <Ionicons name="partly-sunny-outline" size={18} color="#FFFFFF" />
            <Text style={styles.photoTitle} numberOfLines={1}>{summary ? scoreTitle : 'Sun Exposure'}</Text>
          </View>
          {summary ? <ConfidenceBadge confidence={summary.confidence} color="#FFFFFF" /> : null}
        </View>
      </ImageBackground>

      <View style={styles.bodyContent}>
        {loading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator size="small" color={tc.primary} />
            <Text style={[styles.muted, { color: tc.textMuted }]}>Loading daylight score...</Text>
          </View>
        ) : summary ? (
          <>
            <View style={[styles.scorePanel, { backgroundColor: `${scoreColor}14`, borderColor: `${scoreColor}55` }]}>
              <LinearGradient
                pointerEvents="none"
                colors={[`${scoreColor}22`, `${tc.primary}10`, 'rgba(255,255,255,0)']}
                locations={[0, 0.58, 1]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFillObject}
              />
              <AnimatedSunWash color={scoreColor} opacity={0.2} style={styles.scorePanelSunWash} />
              <View style={styles.scoreTextBlock}>
                <Text style={[styles.scoreEyebrow, { color: tc.textMuted }]}>Daylight score · UV risk separate</Text>
                <View style={styles.scoreDescriptorRow}>
                  <Ionicons name={scoreIcon} size={17} color={scoreColor} />
                  <Text style={[styles.scoreDescriptor, { color: scoreColor }]} numberOfLines={2}>
                    {scoreStatus}
                  </Text>
                </View>
                <Text style={[styles.scoreMeaning, { color: scoreColor }]}>
                  {scoreMeaning}
                </Text>
                <SunScoreRail score={exposureScore} color={scoreColor} trackColor={tc.border} />
              </View>
              <View style={styles.scoreValueWrap}>
                <AnimatedNumber
                  value={exposureScore}
                  from={0}
                  animateOnMount={!reducedMotion}
                  duration={760}
                  style={[styles.scoreValue, { color: scoreColor }]}
                />
                <Text style={[styles.scoreScale, { color: tc.textMuted }]}>/100</Text>
              </View>
            </View>
            <Text style={[styles.scoreNote, { color: tc.textSecondary }]}>
              {scoreHelp} Too little daylight scores low; sustained high UV can cap the score instead of being treated as more is always better. Based on Apple Health daylight, light intensity when available, and UV Index.
            </Text>
            {currentUvGuidance ? (
              <CurrentUvGuidanceCard guidance={currentUvGuidance} colors={tc} />
            ) : null}
            <View style={styles.metricGrid}>
              <SunMetricTile
                value={formatSunMinutes(daylightMinutes)}
                label="Daylight"
                color={scoreColor}
                colors={tc}
              />
              <SunMetricTile
                value={formatLux(summary.lightIntensityLuxAverage)}
                label="Avg lux"
                color={tc.primary}
                colors={tc}
              />
              <SunMetricTile
                value={riskLabel}
                label="UV risk"
                color={riskColor}
                colors={tc}
              />
            </View>
            {actions}
          </>
        ) : (
          <>
            <Text style={[styles.muted, { color: tc.textMuted }]}>
              No daylight score yet.
            </Text>
            {actions}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.md,
    borderWidth: 1,
    overflow: 'hidden',
  },
  photoHeader: {
    height: 118,
    justifyContent: 'flex-end',
  },
  photoHeaderImage: {
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
  },
  photoShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sunWash: {
    position: 'absolute',
    top: -38,
    bottom: -38,
    width: 86,
  },
  photoSunWash: {
    left: 18,
  },
  compactSunWash: {
    left: -12,
    top: -28,
    bottom: -28,
    width: 64,
  },
  scorePanelSunWash: {
    right: 4,
    top: -32,
    bottom: -32,
    width: 76,
  },
  photoHeaderContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    padding: 14,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 },
  photoTitle: { flex: 1, minWidth: 0, color: '#FFFFFF', fontSize: 18, fontWeight: '900', ...overPhotoTextShadow },
  bodyContent: { padding: 14, gap: 10 },
  badge: { borderWidth: 1, borderRadius: radius.full, paddingHorizontal: 8, paddingVertical: 4 },
  badgeText: { fontSize: 9, fontWeight: '800' },
  scorePanel: {
    minHeight: 96,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    overflow: 'hidden',
  },
  scoreTextBlock: { flex: 1, minWidth: 0 },
  scoreEyebrow: { fontSize: 11, fontWeight: '900', textTransform: 'uppercase' },
  scoreDescriptorRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4 },
  scoreDescriptor: { flex: 1, minWidth: 0, fontSize: 18, lineHeight: 23, fontWeight: '900' },
  scoreMeaning: { fontSize: 12, lineHeight: 16, fontWeight: '800', marginTop: 3 },
  scoreRailTrack: { height: 6, borderRadius: radius.full, overflow: 'hidden', marginTop: 9 },
  scoreRailFill: { height: '100%', borderRadius: radius.full, overflow: 'hidden' },
  scoreValueWrap: { flexDirection: 'row', alignItems: 'baseline', flexShrink: 0 },
  scoreValue: { fontSize: 46, lineHeight: 50, fontWeight: '900' },
  scoreScale: { fontSize: 14, fontWeight: '900', marginLeft: 2 },
  scoreNote: { fontSize: 12, lineHeight: 17 },
  currentUvCard: {
    minHeight: 58,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  currentUvIconBubble: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  currentUvTextBlock: { flex: 1, minWidth: 0 },
  currentUvTitle: { fontSize: 13, lineHeight: 17, fontWeight: '900' },
  currentUvDetail: { fontSize: 11, lineHeight: 15, fontWeight: '700', marginTop: 1 },
  metricGrid: {
    flexDirection: 'row',
    gap: 8,
  },
  metricTile: {
    flex: 1,
    minHeight: 52,
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 8,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  metricValue: { fontSize: 13, lineHeight: 17, fontWeight: '900' },
  metricLabel: { fontSize: 9, lineHeight: 12, fontWeight: '900', marginTop: 2, textTransform: 'uppercase' },
  muted: { fontSize: 12, lineHeight: 17 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, marginTop: 2 },
  secondaryButton: {
    minHeight: 36,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  secondaryButtonText: { fontSize: 12, fontWeight: '800' },
  compactCard: { minHeight: 210 },
  compactPhotoHeader: {
    height: 46,
    justifyContent: 'center',
  },
  compactPhotoImage: {
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
  },
  compactPhotoShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.32)',
  },
  compactPhotoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    paddingHorizontal: 10,
  },
  compactTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 },
  compactPhotoTitle: { color: '#FFFFFF', fontSize: 13, fontWeight: '900', ...overPhotoTextShadow },
  compactIconRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  compactPhotoIconBtn: {
    width: 26,
    height: 26,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  compactBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 14,
  },
  compactEyebrow: { fontSize: 9, fontWeight: '900', letterSpacing: 0, textAlign: 'center', marginBottom: 2 },
  compactScoreLabel: { fontSize: 13, fontWeight: '900', textAlign: 'center' },
  compactDaylight: { fontSize: 10, lineHeight: 13, fontWeight: '700', textAlign: 'center' },
  compactUvPill: {
    minHeight: 30,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 7,
    paddingVertical: 5,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    alignSelf: 'stretch',
  },
  compactUvText: { flex: 1, minWidth: 0, fontSize: 9.5, lineHeight: 12, fontWeight: '900', textAlign: 'center' },
});
