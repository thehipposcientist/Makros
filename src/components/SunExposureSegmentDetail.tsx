import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import type { AppThemeName, SunExposureSegment } from '../types';
import { areaSunLabel, formatLux, formatSunMinutes } from '../utils/sunExposure';

interface Props {
  segment: SunExposureSegment;
  themeName?: AppThemeName;
  onAdjust?: (segment: SunExposureSegment) => void;
}

function formatTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function splitTimePeriod(label: string): { time: string; period: string } {
  const match = label.match(/^(.+?)\s*([AP]M)$/i);
  return match
    ? { time: match[1].trim(), period: match[2].toUpperCase() }
    : { time: label, period: '' };
}

function compactTimeRange(startValue: string, endValue: string): string {
  const start = splitTimePeriod(formatTime(startValue));
  const end = splitTimePeriod(formatTime(endValue));
  if (start.period && start.period === end.period) {
    return `${start.time}-${end.time} ${end.period}`;
  }
  return `${start.time}${start.period ? ` ${start.period}` : ''}-${end.time}${end.period ? ` ${end.period}` : ''}`;
}

function sourceLabel(source: SunExposureSegment['source']): string {
  switch (source) {
    case 'healthkit_daylight': return 'Apple Watch / HealthKit';
    case 'workout_route': return 'Workout route estimate';
    case 'activity_recognition': return 'Phone activity fallback';
    case 'manual': return 'Manual correction';
    default: return 'Phone coarse location fallback';
  }
}

function segmentUvRiskLabel(maxUv: number): string {
  if (maxUv >= 11) return 'Extreme UV';
  if (maxUv >= 8) return 'Very high UV';
  if (maxUv >= 6) return 'High UV';
  if (maxUv >= 3) return 'Moderate UV';
  return 'Low UV';
}

function formatUv(value: number): string {
  const uv = Number(value);
  return Number.isFinite(uv) && uv > 0 ? uv.toFixed(1) : '-';
}

export default function SunExposureSegmentDetail({ segment, themeName, onAdjust }: Props) {
  const tc = getTheme(themeName).colors;
  const context = segment.areaContext;
  const uvRisk = segmentUvRiskLabel(segment.uvIndexMax);
  const riskColor = segment.uvIndexMax >= 6
    ? '#EF4444'
    : segment.uvIndexMax >= 3
      ? tc.warning
      : tc.textMuted;
  return (
    <View style={[styles.card, { backgroundColor: tc.surface, borderColor: tc.border }]}>
      <View style={styles.header}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.time, { color: tc.textPrimary }]}>
            {compactTimeRange(segment.startTime, segment.endTime)}
          </Text>
          <Text style={[styles.sub, { color: tc.textMuted }]}>
            {sourceLabel(segment.source)} · {areaSunLabel(context)}
          </Text>
        </View>
        {onAdjust ? (
          <TouchableOpacity
            testID={`sun-segment-adjust-${segment.id}`}
            accessibilityLabel={`sun-segment-adjust-${segment.id}`}
            onPress={() => onAdjust(segment)}
            style={[styles.iconButton, { borderColor: tc.border }]}>
            <Ionicons name="options-outline" size={16} color={tc.textSecondary} />
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.metricRow}>
        <View style={[styles.metricPill, { backgroundColor: tc.surfaceRaised }]}>
          <Ionicons name="time-outline" size={14} color={tc.textMuted} />
          <Text style={[styles.metricText, { color: tc.textPrimary }]}>{formatSunMinutes(segment.durationMinutes)}</Text>
        </View>
        <View style={[styles.metricPill, { backgroundColor: tc.surfaceRaised }]}>
          <Ionicons name="sunny-outline" size={14} color={riskColor} />
          <Text style={[styles.metricText, { color: tc.textPrimary }]}>
            UV {formatUv(segment.uvIndexAverage)} avg / {formatUv(segment.uvIndexMax)} max
          </Text>
        </View>
      </View>

      <View style={[styles.riskRow, { borderColor: tc.border }]}>
        <Text style={[styles.riskLabel, { color: riskColor }]}>{uvRisk}</Text>
        <Text style={[styles.riskDetail, { color: tc.textMuted }]}>
          {Math.round(segment.outdoorConfidence * 100)}% signal · {formatLux(segment.lightIntensityLux)} max lux · {segment.confidence} confidence
        </Text>
      </View>
      {segment.uvIndexMax >= 3 ? (
        <Text style={[styles.safety, { color: tc.textSecondary }]}>
          Protection recommended during this window.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.md, padding: 12, gap: 9 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  time: { fontSize: 15, fontWeight: '900' },
  sub: { fontSize: 11, lineHeight: 15, marginTop: 2 },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  metricRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  metricPill: {
    minHeight: 30,
    borderRadius: radius.sm,
    paddingHorizontal: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  metricText: { fontSize: 11, fontWeight: '800' },
  riskRow: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 2,
  },
  riskLabel: { fontSize: 12, fontWeight: '900' },
  riskDetail: { fontSize: 11, lineHeight: 15 },
  safety: { fontSize: 11, lineHeight: 15 },
});
