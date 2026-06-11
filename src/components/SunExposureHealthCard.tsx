import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Modal, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AppThemeName, SunExposureCorrectionOption, SunExposureDailySummary, SunExposurePreferences, SunExposureSegment } from '../types';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import {
  correctSunExposureSegment,
  getSunExposureHistory,
  getSunExposurePreferences,
  getSunExposureSummary,
  listSunExposureSegments,
  updateSunExposurePreferences,
} from '../services/api';
import { syncSunExposureForToday } from '../services/sunExposureSync';
import {
  DEFAULT_SUN_EXPOSURE_PREFERENCES,
  currentUvGuidanceFromSegments,
  estimatedOutdoorDaylightMinutes,
  formatLux,
  formatSunMinutes,
  hasSunExposureSummaryData,
  normalizeSunExposurePreferences,
  sunExposureScore,
  sunExposureScoreColor,
  summaryCopy,
  uvRiskLabel,
  uvRiskScore,
  uvRiskScoreColor,
} from '../utils/sunExposure';
import BottomSheetDismissHandle from './BottomSheetDismissHandle';
import SunExposureCorrectionSheet from './SunExposureCorrectionSheet';
import SunExposureEstimateCard from './SunExposureEstimateCard';
import AnimatedNumber from './AnimatedNumber';
import { useReducedMotion } from '../utils/motion';

interface Props {
  authToken: string;
  themeName?: AppThemeName;
  isActive?: boolean;
  /** Half-width two-up variant (speedometer + icon-only actions). */
  compact?: boolean;
}

const SUN_EXPOSURE_HISTORY_DAYS = 62;
const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
type SunExposureSheetMode = 'details' | 'history' | 'settings';

function localISODate(value = new Date()): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function sunExposureErrorMessage(err: unknown, fallback: string): string {
  const message = String((err as { message?: unknown } | null)?.message ?? fallback);
  if (/not found|http 404/i.test(message)) {
    return 'Sun exposure support is not available from this backend yet.';
  }
  return message;
}

function parseLocalDay(dayISO: string): Date {
  const d = new Date(`${dayISO.slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function monthLabel(value: Date): string {
  return value.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function dayDetailLabel(dayISO: string): string {
  return parseLocalDay(dayISO).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function dayPhrase(dayISO: string): string {
  return dayISO === localISODate() ? 'today' : `on ${dayDetailLabel(dayISO)}`;
}

function dayKeyFromTimestamp(value: string): string | null {
  const direct = value.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : localISODate(parsed);
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfWeek(value: Date): Date {
  return addDays(value, -value.getDay());
}

function endOfWeek(value: Date): Date {
  return addDays(value, 6 - value.getDay());
}

function buildCalendarWeeks(history: SunExposureDailySummary[]) {
  const today = parseLocalDay(localISODate());
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1, 12);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0, 12);
  const gridStart = startOfWeek(monthStart);
  const gridEnd = endOfWeek(monthEnd);
  const byDate = new Map(history.map(row => [row.date.slice(0, 10), row]));
  const cells: Array<{
    key: string;
    dayNumber: number;
    isCurrentMonth: boolean;
    isToday: boolean;
    isFuture: boolean;
    summary: SunExposureDailySummary | null;
  }> = [];
  for (let cursor = gridStart; cursor <= gridEnd; cursor = addDays(cursor, 1)) {
    const key = localISODate(cursor);
    cells.push({
      key,
      dayNumber: cursor.getDate(),
      isCurrentMonth: cursor.getMonth() === today.getMonth(),
      isToday: key === localISODate(today),
      isFuture: cursor > today,
      summary: byDate.get(key) ?? null,
    });
  }
  const weeks: typeof cells[] = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }
  return { label: monthLabel(today), weeks };
}

function PreferenceToggle({
  title,
  subtitle,
  value,
  disabled,
  colors,
  onValueChange,
}: {
  title: string;
  subtitle: string;
  value: boolean;
  disabled?: boolean;
  colors: ReturnType<typeof getTheme>['colors'];
  onValueChange: (value: boolean) => void;
}) {
  return (
    <View style={[styles.preferenceRow, { borderTopColor: colors.border }]}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.preferenceTitle, { color: colors.textPrimary }]}>{title}</Text>
        <Text style={[styles.preferenceSubtitle, { color: colors.textMuted }]}>{subtitle}</Text>
      </View>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
        trackColor={{ false: colors.border, true: colors.primary }}
        thumbColor={value ? getContrastingTextColor(colors.primary) : colors.textMuted}
      />
    </View>
  );
}

function SunExposureHistoryCalendar({
  history,
  colors,
  saving,
  selectedDate,
  onSelectDay,
  onRefresh,
}: {
  history: SunExposureDailySummary[];
  colors: ReturnType<typeof getTheme>['colors'];
  saving: boolean;
  selectedDate: string | null;
  onSelectDay: (dayISO: string) => void;
  onRefresh: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const { label, weeks } = buildCalendarWeeks(history);
  const monthRows = weeks
    .flatMap(week => week)
    .filter(cell => cell.isCurrentMonth && !cell.isFuture && cell.summary && hasSunExposureSummaryData(cell.summary))
    .map(cell => cell.summary as SunExposureDailySummary);
  const divisor = Math.max(monthRows.length, 1);
  const monthStats = {
    daysWithData: monthRows.length,
    avgMinutes: monthRows.reduce((sum, row) => sum + estimatedOutdoorDaylightMinutes(row), 0) / divisor,
    avgScore: Math.round(monthRows.reduce((sum, row) => sum + sunExposureScore(row), 0) / divisor),
  };
  const legend = [
    { label: '70+', color: sunExposureScoreColor(80) },
    { label: '45-69', color: sunExposureScoreColor(60) },
    { label: '25-44', color: sunExposureScoreColor(35) },
    { label: '1-24', color: sunExposureScoreColor(10) },
  ];

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.title, { color: colors.textPrimary }]}>Sun Exposure History</Text>
          <Text style={[styles.subtitle, { color: colors.textMuted }]}>{label} · daily daylight score</Text>
        </View>
        <TouchableOpacity
          onPress={onRefresh}
          disabled={saving}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={styles.iconButton}>
          <Ionicons name="refresh" size={18} color={colors.textMuted} />
        </TouchableOpacity>
      </View>

      <View style={styles.statGrid}>
        {[
          { label: 'Days', value: `${monthStats.daysWithData}` },
          { label: 'Avg daylight', value: formatSunMinutes(monthStats.avgMinutes) },
          { label: 'Avg score', value: String(monthStats.avgScore) },
        ].map(item => (
          <View key={item.label} style={[styles.statTile, { backgroundColor: colors.surfaceRaised }]}>
            <Text style={[styles.statValue, { color: colors.textPrimary }]}>{item.value}</Text>
            <Text style={[styles.statLabel, { color: colors.textMuted }]}>{item.label}</Text>
          </View>
        ))}
      </View>

      <View style={styles.weekdayRow}>
        {WEEKDAY_LABELS.map((day, index) => (
          <Text key={`${day}-${index}`} style={[styles.weekdayText, { color: colors.textMuted }]}>{day}</Text>
        ))}
      </View>

      <View style={styles.calendarGrid}>
        {weeks.map((week, weekIndex) => (
          <View key={`week-${weekIndex}`} style={styles.calendarWeekRow}>
            {week.map(cell => {
              const hasData = Boolean(cell.summary && hasSunExposureSummaryData(cell.summary) && !cell.isFuture);
              const score = hasData ? sunExposureScore(cell.summary) : null;
              const scoreColor = score !== null ? sunExposureScoreColor(score) : colors.textMuted;
              const selected = selectedDate === cell.key;
              const cellBorderColor = cell.isToday
                ? colors.primary
                : hasData
                  ? `${scoreColor}66`
                  : colors.border;
              const cellBackground = hasData ? `${scoreColor}18` : colors.surfaceRaised;
              return (
                <TouchableOpacity
                  key={cell.key}
                  testID={`sun-history-day-${cell.key}`}
                  accessibilityLabel={`sun-history-day-${cell.key}`}
                  activeOpacity={0.78}
                  disabled={!hasData}
                  onPress={() => onSelectDay(cell.key)}
                  style={[
                    styles.calendarCell,
                    {
                      backgroundColor: cell.isCurrentMonth ? cellBackground : `${colors.surfaceRaised}99`,
                      borderColor: selected ? colors.primary : cellBorderColor,
                      borderWidth: selected ? 2 : 1,
                      opacity: cell.isFuture ? 0.45 : 1,
                    },
                  ]}>
                  <Text
                    style={[
                      styles.calendarDay,
                      { color: cell.isCurrentMonth ? colors.textPrimary : colors.textMuted },
                    ]}>
                    {cell.dayNumber}
                  </Text>
                  {score !== null ? (
                    <AnimatedNumber
                      value={score}
                      from={0}
                      animateOnMount={!reducedMotion}
                      duration={520}
                      style={[styles.calendarScore, { color: scoreColor }]}
                    />
                  ) : (
                    <Text style={[styles.calendarScore, { color: scoreColor }]}>-</Text>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </View>

      <View style={styles.calendarLegend}>
        {legend.map(item => (
          <View key={item.label} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: item.color }]} />
            <Text style={[styles.legendText, { color: colors.textMuted }]}>{item.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function DetailMetric({
  label,
  value,
  colors,
  valueColor,
  animatedValue,
}: {
  label: string;
  value: string;
  colors: ReturnType<typeof getTheme>['colors'];
  valueColor?: string;
  animatedValue?: number;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <View style={[styles.detailMetricTile, { backgroundColor: colors.surfaceRaised }]}>
      {animatedValue != null ? (
        <AnimatedNumber
          value={animatedValue}
          from={0}
          animateOnMount={!reducedMotion}
          duration={640}
          style={[styles.detailMetricValue, { color: valueColor ?? colors.textPrimary }]}
        />
      ) : (
        <Text style={[styles.detailMetricValue, { color: valueColor ?? colors.textPrimary }]}>{value}</Text>
      )}
      <Text style={[styles.detailMetricLabel, { color: colors.textMuted }]}>{label}</Text>
    </View>
  );
}

function SunExposureSummaryDetails({
  summary,
  colors,
}: {
  summary: SunExposureDailySummary;
  colors: ReturnType<typeof getTheme>['colors'];
}) {
  const score = sunExposureScore(summary);
  const scoreColor = sunExposureScoreColor(score);
  const riskScore = uvRiskScore(summary);
  const riskColor = uvRiskScoreColor(riskScore);
  const averageUv = Number(summary.uvIndexAverage ?? 0);
  const maxUv = Number(summary.uvIndexMax ?? 0);
  return (
    <View style={styles.detailMetricGrid}>
      <DetailMetric label="Daylight score" value={String(score)} animatedValue={score} valueColor={scoreColor} colors={colors} />
      <DetailMetric label="Daylight" value={formatSunMinutes(estimatedOutdoorDaylightMinutes(summary))} colors={colors} />
      <DetailMetric label="Avg lux" value={formatLux(summary.lightIntensityLuxAverage)} colors={colors} />
      <DetailMetric label="UV risk" value={uvRiskLabel(summary)} valueColor={riskColor} colors={colors} />
      <DetailMetric
        label="Avg / max UV"
        value={`${averageUv > 0 ? averageUv.toFixed(1) : '-'} / ${maxUv > 0 ? maxUv.toFixed(1) : '-'}`}
        colors={colors}
      />
    </View>
  );
}

function SunExposureHistoryDayDetails({
  summary,
  segments,
  loading,
  error,
  colors,
  themeName,
  onAdjust,
}: {
  summary: SunExposureDailySummary | null;
  segments: SunExposureSegment[];
  loading: boolean;
  error: string | null;
  colors: ReturnType<typeof getTheme>['colors'];
  themeName?: AppThemeName;
  onAdjust: (segment: SunExposureSegment) => void;
}) {
  const reducedMotion = useReducedMotion();
  if (!summary) return null;
  const dayISO = summary.date.slice(0, 10);
  const score = sunExposureScore(summary);
  const scoreColor = sunExposureScoreColor(score);
  return (
    <View style={styles.segmentList}>
      <View style={styles.historyDetailHeader}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.detailsTitle, { color: colors.textMuted }]}>HISTORY DETAILS</Text>
          <Text style={[styles.historyDetailTitle, { color: colors.textPrimary }]}>{dayDetailLabel(dayISO)}</Text>
          <Text style={[styles.detailLine, { color: colors.textSecondary }]}>{summary.sunScoreLabel ?? 'Daylight score'}</Text>
        </View>
        <View style={[styles.historyScorePill, { backgroundColor: `${scoreColor}16`, borderColor: `${scoreColor}55` }]}>
          <AnimatedNumber
            value={score}
            from={0}
            animateOnMount={!reducedMotion}
            duration={680}
            style={[styles.historyScoreValue, { color: scoreColor }]}
          />
          <Text style={[styles.historyScoreLabel, { color: colors.textMuted }]}>Score</Text>
        </View>
      </View>

      <SunExposureSummaryDetails summary={summary} colors={colors} />

      {summaryCopy(summary, { dayPhrase: dayPhrase(dayISO) }).map((line, index) => (
        <Text key={`history-summary-${dayISO}-${index}`} style={[styles.detailLine, { color: colors.textSecondary }]}>
          {line}
        </Text>
      ))}
    </View>
  );
}

function SunExposurePanelSheet({
  visible,
  title,
  subtitle,
  icon,
  colors,
  headerAccessory,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  subtitle: string;
  icon: keyof typeof Ionicons.glyphMap;
  colors: ReturnType<typeof getTheme>['colors'];
  headerAccessory?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.panelSheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <BottomSheetDismissHandle
            onClose={onClose}
            color={colors.border}
            containerStyle={styles.sheetHandleTap}
            handleStyle={styles.sheetHandle}
          />
          <View style={styles.headerRow}>
            <View style={[styles.iconBubble, { backgroundColor: colors.primary + '18' }]}>
              <Ionicons name={icon} size={18} color={colors.primary} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text>
              <Text style={[styles.subtitle, { color: colors.textMuted }]}>{subtitle}</Text>
            </View>
            {headerAccessory}
            <TouchableOpacity
              onPress={onClose}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={styles.iconButton}>
              <Ionicons name="close" size={21} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.sheetContent}>
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export default function SunExposureHealthCard({ authToken, themeName, isActive = true, compact = false }: Props) {
  const colors = getTheme(themeName).colors;
  const mountedRef = useRef(true);
  const historyDetailRequestRef = useRef(0);
  const [preferences, setPreferences] = useState<SunExposurePreferences | null>(null);
  const [summary, setSummary] = useState<SunExposureDailySummary | null>(null);
  const [segments, setSegments] = useState<SunExposureSegment[]>([]);
  const [history, setHistory] = useState<SunExposureDailySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetMode, setSheetMode] = useState<SunExposureSheetMode | null>(null);
  const [adjustSegment, setAdjustSegment] = useState<SunExposureSegment | null>(null);
  const [historyDetailDay, setHistoryDetailDay] = useState<string | null>(null);
  const [historyDetailSegments, setHistoryDetailSegments] = useState<SunExposureSegment[]>([]);
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false);
  const [historyDetailError, setHistoryDetailError] = useState<string | null>(null);
  const detailsOpen = sheetMode === 'details';
  const historyOpen = sheetMode === 'history';
  const settingsOpen = sheetMode === 'settings';
  const closeSheet = useCallback(() => setSheetMode(null), []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setLoading(true);
    setError(null);
    const dayISO = localISODate();
    try {
      const loadedPreferences = await getSunExposurePreferences(authToken);
      if (!mountedRef.current) return;
      setPreferences(loadedPreferences);
      if (loadedPreferences.enabled) {
        await syncSunExposureForToday(authToken, { dayISO, preferences: loadedPreferences }).catch(() => null);
      }
      const [summaryResult, segmentsResult, historyResult] = await Promise.allSettled([
        getSunExposureSummary(authToken, dayISO),
        listSunExposureSegments(authToken, dayISO),
        getSunExposureHistory(authToken, SUN_EXPOSURE_HISTORY_DAYS),
      ]);
      if (!mountedRef.current) return;
      setSummary(summaryResult.status === 'fulfilled' ? summaryResult.value : null);
      setSegments(segmentsResult.status === 'fulfilled' ? segmentsResult.value : []);
      setHistory(historyResult.status === 'fulfilled' ? historyResult.value : []);
      const failed = [summaryResult, segmentsResult, historyResult].find(result => result.status === 'rejected') as PromiseRejectedResult | undefined;
      setError(failed ? sunExposureErrorMessage(failed.reason, 'Unable to load sun exposure history') : null);
    } catch (err) {
      if (!mountedRef.current) return;
      setPreferences(prev => prev ?? normalizeSunExposurePreferences(DEFAULT_SUN_EXPOSURE_PREFERENCES));
      setError(sunExposureErrorMessage(err, 'Unable to load sun exposure settings'));
    } finally {
      if (mountedRef.current && !options.silent) setLoading(false);
    }
  }, [authToken]);

  useEffect(() => {
    if (!isActive) return undefined;
    load();
    const sub = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') load({ silent: true });
    });
    return () => sub.remove();
  }, [isActive, load]);

  const handlePreferenceUpdate = useCallback(async (changes: Partial<SunExposurePreferences>) => {
    const previous = preferences ?? normalizeSunExposurePreferences(DEFAULT_SUN_EXPOSURE_PREFERENCES);
    const next = normalizeSunExposurePreferences({ ...previous, ...changes });
    setPreferences(next);
    setSaving(true);
    setError(null);
    try {
      const updated = await updateSunExposurePreferences(authToken, next);
      if (!mountedRef.current) return;
      setPreferences(updated);
      await load({ silent: true });
    } catch (err) {
      if (!mountedRef.current) return;
      setPreferences(previous);
      setError(sunExposureErrorMessage(err, 'Could not update sun exposure settings.'));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [authToken, load, preferences]);

  const loadHistoryDetail = useCallback(async (dayISO: string) => {
    const normalizedDay = dayISO.slice(0, 10);
    const requestId = historyDetailRequestRef.current + 1;
    historyDetailRequestRef.current = requestId;
    setHistoryDetailDay(normalizedDay);
    setHistoryDetailLoading(true);
    setHistoryDetailError(null);
    if (normalizedDay === localISODate()) {
      setHistoryDetailSegments(segments);
    } else {
      setHistoryDetailSegments([]);
    }

    try {
      const loadedSegments = await listSunExposureSegments(authToken, normalizedDay);
      if (!mountedRef.current || historyDetailRequestRef.current !== requestId) return;
      setHistoryDetailSegments(loadedSegments);
    } catch (err) {
      if (!mountedRef.current || historyDetailRequestRef.current !== requestId) return;
      setHistoryDetailError(sunExposureErrorMessage(err, 'Unable to load sun exposure details for this day.'));
    } finally {
      if (mountedRef.current && historyDetailRequestRef.current === requestId) {
        setHistoryDetailLoading(false);
      }
    }
  }, [authToken, segments]);

  const handleCorrection = useCallback(async (option: SunExposureCorrectionOption) => {
    if (!adjustSegment) return;
    const segmentId = Number(adjustSegment.id);
    if (!Number.isFinite(segmentId)) {
      setError('Could not adjust this sun exposure segment.');
      setAdjustSegment(null);
      return;
    }
    const adjustedDay = dayKeyFromTimestamp(adjustSegment.startTime);
    setSaving(true);
    setError(null);
    try {
      await correctSunExposureSegment(authToken, { segmentId, correctionType: option });
      setAdjustSegment(null);
      await load({ silent: true });
      if (historyOpen && adjustedDay) {
        await loadHistoryDetail(adjustedDay);
      }
    } catch (err) {
      setError(String((err as { message?: unknown } | null)?.message ?? 'Could not adjust sun exposure estimate.'));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [adjustSegment, authToken, historyOpen, load, loadHistoryDetail]);

  const historyStats = useMemo(() => {
    const daysWithData = history.filter(hasSunExposureSummaryData);
    const divisor = Math.max(daysWithData.length, 1);
    const avgMinutes = daysWithData.reduce((sum, row) => sum + estimatedOutdoorDaylightMinutes(row), 0) / divisor;
    const avgScore = daysWithData.reduce((sum, row) => sum + sunExposureScore(row), 0) / divisor;
    return {
      daysWithData: daysWithData.length,
      avgMinutes,
      avgScore: Math.round(avgScore),
    };
  }, [history]);
  const historyByDate = useMemo(() => new Map(history.map(row => [row.date.slice(0, 10), row])), [history]);
  const selectedHistorySummary = historyDetailDay ? historyByDate.get(historyDetailDay) ?? null : null;
  const currentUvGuidance = useMemo(
    () => preferences?.useCoarseLocation && preferences?.highUvRemindersEnabled !== false
      ? currentUvGuidanceFromSegments(segments)
      : null,
    [preferences?.highUvRemindersEnabled, preferences?.useCoarseLocation, segments],
  );
  const latestHistoryDay = useMemo(() => {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const row = history[index];
      const key = row.date.slice(0, 10);
      if (hasSunExposureSummaryData(row) && key <= localISODate()) return key;
    }
    return null;
  }, [history]);

  useEffect(() => {
    if (!historyOpen || historyDetailDay || !latestHistoryDay) return;
    void loadHistoryDetail(latestHistoryDay);
  }, [historyDetailDay, historyOpen, latestHistoryDay, loadHistoryDetail]);
  const handleHistoryRefresh = useCallback(async () => {
    await load({ silent: true });
    if (historyDetailDay) {
      await loadHistoryDetail(historyDetailDay);
    }
  }, [historyDetailDay, load, loadHistoryDetail]);

  const hasTodaySummary = hasSunExposureSummaryData(summary);
  const enabled = Boolean(preferences?.enabled);
  const canShowMainCard = enabled || hasTodaySummary || historyStats.daysWithData > 0;
  const settingsDisabled = saving || !preferences;
  const dependentSettingsDisabled = settingsDisabled || !enabled;
  const todayDetailsSheet = (
    <SunExposurePanelSheet
      visible={detailsOpen}
      title="Today Details"
      subtitle="Daylight, light intensity, and UV"
      icon="list-outline"
      colors={colors}
      onClose={closeSheet}>
      <View style={styles.segmentList}>
        <Text style={[styles.detailsTitle, { color: colors.textMuted }]}>TODAY DETAILS</Text>
        {summary ? (
          <>
            <SunExposureSummaryDetails summary={summary} colors={colors} />
            {summaryCopy(summary).map((line, index) => (
              <Text key={`summary-${index}`} style={[styles.detailLine, { color: colors.textSecondary }]}>
                {line}
              </Text>
            ))}
          </>
        ) : (
          <Text style={[styles.detailLine, { color: colors.textSecondary }]}>
            No sun exposure estimate is available for today yet.
          </Text>
        )}
      </View>
    </SunExposurePanelSheet>
  );
  const historySheet = (
    <SunExposurePanelSheet
      visible={historyOpen}
      title="Sun Exposure History"
      subtitle="Calendar and saved day details"
      icon="calendar-outline"
      colors={colors}
      onClose={closeSheet}>
      <SunExposureHistoryCalendar
        history={history}
        colors={colors}
        saving={saving}
        selectedDate={historyDetailDay}
        onSelectDay={loadHistoryDetail}
        onRefresh={handleHistoryRefresh}
      />
      <SunExposureHistoryDayDetails
        summary={selectedHistorySummary}
        segments={historyDetailSegments}
        loading={historyDetailLoading}
        error={historyDetailError}
        colors={colors}
        themeName={themeName}
        onAdjust={setAdjustSegment}
      />
    </SunExposurePanelSheet>
  );
  const settingsSheet = (
    <SunExposurePanelSheet
      visible={settingsOpen}
      title="Sun Exposure Settings"
      subtitle="Data sources and estimate controls"
      icon="settings-outline"
      colors={colors}
      headerAccessory={saving ? <ActivityIndicator size="small" color={colors.primary} /> : null}
      onClose={closeSheet}>
      {loading && !preferences ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator color={colors.primary} />
          <Text style={[styles.muted, { color: colors.textMuted }]}>Loading sun exposure settings...</Text>
        </View>
      ) : (
        <View style={[styles.settingsBlock, { borderTopColor: colors.border }]}>
          <PreferenceToggle
            title="Enable estimates"
            subtitle="Health daylight and activity context."
            value={enabled}
            disabled={settingsDisabled}
            colors={colors}
            onValueChange={(value) => handlePreferenceUpdate({ enabled: value })}
          />
          <PreferenceToggle
            title="Apple Health daylight"
            subtitle="Use Time in Daylight samples."
            value={Boolean(preferences?.useHealthDaylightData)}
            disabled={dependentSettingsDisabled}
            colors={colors}
            onValueChange={(value) => handlePreferenceUpdate({ useHealthDaylightData: value })}
          />
          <PreferenceToggle
            title="Workout routes"
            subtitle="Tracked outdoor routes only."
            value={Boolean(preferences?.useWorkoutRoutes)}
            disabled={dependentSettingsDisabled}
            colors={colors}
            onValueChange={(value) => handlePreferenceUpdate({
              useWorkoutRoutes: value,
              locationMode: value ? 'workout_routes_only' : (preferences?.useCoarseLocation ? 'coarse_location' : 'off'),
            })}
          />
          <PreferenceToggle
            title="Right-now UV"
            subtitle="Use coarse location while the app is open."
            value={Boolean(preferences?.useCoarseLocation)}
            disabled={dependentSettingsDisabled}
            colors={colors}
            onValueChange={(value) => handlePreferenceUpdate({
              useCoarseLocation: value,
              highUvRemindersEnabled: value ? preferences?.highUvRemindersEnabled ?? true : false,
              locationMode: value ? 'coarse_location' : (preferences?.useWorkoutRoutes ? 'workout_routes_only' : 'off'),
            })}
          />
          <PreferenceToggle
            title="High UV guidance"
            subtitle="Show shade/protection guidance on the card."
            value={Boolean(preferences?.useCoarseLocation && preferences?.highUvRemindersEnabled)}
            disabled={dependentSettingsDisabled || !preferences?.useCoarseLocation}
            colors={colors}
            onValueChange={(value) => handlePreferenceUpdate({ highUvRemindersEnabled: value })}
          />
        </View>
      )}

      {error ? <Text style={[styles.error, { color: colors.textSecondary }]}>{error}</Text> : null}
      <Text style={[styles.footnote, { color: colors.textMuted }]}>
        Wellness estimate only.
      </Text>
    </SunExposurePanelSheet>
  );
  const sunExposureSheets = (
    <>
      {todayDetailsSheet}
      {historySheet}
      {settingsSheet}
      <SunExposureCorrectionSheet
        visible={Boolean(adjustSegment)}
        themeName={themeName}
        onSelect={handleCorrection}
        onClose={() => setAdjustSegment(null)}
      />
    </>
  );

  if (loading && !preferences && history.length === 0) {
    return (
      <>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[styles.muted, { color: colors.textMuted }]}>Loading sun exposure history...</Text>
          </View>
        </View>
        {sunExposureSheets}
      </>
    );
  }

  if (!canShowMainCard) {
    return (
      <>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.headerRow}>
            <View style={[styles.iconBubble, { backgroundColor: colors.primary + '18' }]}>
              <Ionicons name="partly-sunny-outline" size={19} color={colors.primary} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[styles.title, { color: colors.textPrimary }]}>Sun Exposure</Text>
              <Text style={[styles.subtitle, { color: colors.textMuted }]}>Daylight score and details</Text>
            </View>
            {saving ? <ActivityIndicator size="small" color={colors.primary} /> : null}
          </View>
          <Text style={[styles.body, { color: colors.textSecondary }]}>
            Track one daily daylight score from Apple Health daylight, light intensity, and UV context.
          </Text>
          {error ? <Text style={[styles.error, { color: colors.textSecondary }]}>{error}</Text> : null}
          <TouchableOpacity
            testID="sun-exposure-settings-empty"
            accessibilityLabel="sun-exposure-settings"
            activeOpacity={0.85}
            disabled={saving}
            onPress={() => setSheetMode('settings')}
            style={[styles.primaryButton, { backgroundColor: colors.primary }]}>
            <Ionicons name="settings-outline" size={16} color={getContrastingTextColor(colors.primary)} />
            <Text style={[styles.primaryButtonText, { color: getContrastingTextColor(colors.primary) }]}>Settings</Text>
          </TouchableOpacity>
        </View>
        {sunExposureSheets}
      </>
    );
  }

  return (
    <>
      <SunExposureEstimateCard
        summary={hasTodaySummary ? summary : null}
        themeName={themeName}
        loading={loading}
        compact={compact}
        currentUvGuidance={currentUvGuidance}
        detailsOpen={detailsOpen}
        historyOpen={historyOpen}
        onOpenDetails={() => setSheetMode(detailsOpen ? null : 'details')}
        onOpenHistory={() => setSheetMode(historyOpen ? null : 'history')}
        onOpenSettings={() => setSheetMode('settings')}
      />

      {sunExposureSheets}
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 14,
    gap: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconBubble: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: 15, fontWeight: '900' },
  subtitle: { fontSize: 11, lineHeight: 15, fontWeight: '700', marginTop: 2 },
  body: { fontSize: 12, lineHeight: 18 },
  muted: { fontSize: 12, lineHeight: 17 },
  error: { fontSize: 11, lineHeight: 16 },
  loadingRow: { minHeight: 74, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  primaryButton: {
    minHeight: 40,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  primaryButtonText: { fontSize: 13, fontWeight: '900' },
  statGrid: { flexDirection: 'row', gap: 8 },
  statTile: {
    flex: 1,
    borderRadius: radius.sm,
    paddingVertical: 8,
    paddingHorizontal: 6,
    alignItems: 'center',
  },
  statValue: { fontSize: 16, fontWeight: '900' },
  statLabel: { fontSize: 9, fontWeight: '800', marginTop: 2 },
  weekdayRow: {
    flexDirection: 'row',
    gap: 5,
  },
  weekdayText: {
    flex: 1,
    textAlign: 'center',
    fontSize: 10,
    fontWeight: '900',
  },
  calendarGrid: { gap: 5 },
  calendarWeekRow: { flexDirection: 'row', gap: 5 },
  calendarCell: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: radius.sm,
    borderWidth: 1,
    padding: 6,
    justifyContent: 'space-between',
  },
  calendarDay: { fontSize: 11, fontWeight: '800' },
  calendarScore: { fontSize: 15, fontWeight: '900', textAlign: 'right' },
  calendarLegend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 10, fontWeight: '800' },
  segmentList: { gap: 10 },
  detailsTitle: { fontSize: 10, fontWeight: '900', letterSpacing: 0 },
  detailLine: { fontSize: 12, lineHeight: 17 },
  detailMetricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  detailMetricTile: {
    flexGrow: 1,
    flexBasis: '31%',
    minWidth: 96,
    borderRadius: radius.sm,
    paddingVertical: 9,
    paddingHorizontal: 10,
  },
  detailMetricValue: { fontSize: 16, fontWeight: '900' },
  detailMetricLabel: { fontSize: 9.5, fontWeight: '800', marginTop: 2 },
  historyDetailHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  historyDetailTitle: { fontSize: 16, fontWeight: '900', marginTop: 2 },
  historyScorePill: {
    minWidth: 78,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingVertical: 8,
    paddingHorizontal: 10,
    alignItems: 'center',
  },
  historyScoreValue: { fontSize: 24, lineHeight: 28, fontWeight: '900' },
  historyScoreLabel: { fontSize: 9, fontWeight: '900', marginTop: 1 },
  settingsBlock: {
    borderTopWidth: 1,
    paddingTop: 4,
  },
  preferenceRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 8,
  },
  preferenceTitle: { fontSize: 12, fontWeight: '900' },
  preferenceSubtitle: { fontSize: 10, lineHeight: 14, fontWeight: '700', marginTop: 2 },
  footnote: { fontSize: 10, lineHeight: 14 },
  sheetBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
  panelSheet: {
    maxHeight: '88%',
    borderWidth: 1,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: 8,
    paddingHorizontal: 14,
    paddingBottom: 18,
    gap: 10,
  },
  sheetHandleTap: {
    minHeight: 24,
    marginBottom: -2,
  },
  sheetHandle: {
    width: 42,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 4,
  },
  sheetContent: {
    paddingTop: 4,
    paddingBottom: 12,
    gap: 12,
  },
});
