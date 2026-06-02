import { useCallback, useEffect, useMemo, useState, type ComponentProps } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import {
  HEALTH_DEVICE_LABEL,
  HEALTH_PLATFORM_LABEL,
  HEALTH_PLATFORM_STATUS_COPY,
  HEALTH_WEARABLE_LABEL,
} from '../constants/platformHealth';
import type { AppThemeName, HealthSummary } from '../types';
import {
  PLATFORM_HEALTH_PERMISSION_COPY,
  getLastPlatformHealthError,
  getPlatformCycleStatus,
  isPlatformHealthAvailable,
  readPlatformDailyNutritionSnapshot,
  readPlatformDailySnapshot,
  readPlatformHealthSummary,
  requestPlatformHealthPermissions,
  type CycleStatus,
  type DailyNutritionSnapshot,
  type DailySnapshot,
} from '../services/platformHealth';
import {
  isAppleHealthEnabled,
  saveHealthSummary,
  setAppleHealthEnabled,
} from '../utils/workoutHistory';
import { hasHealthMetricValue } from '../utils/healthSignalDisplay';

type IconName = ComponentProps<typeof Ionicons>['name'];
type SignalStatus = 'ok' | 'missing' | 'setup' | 'unavailable';

interface Props {
  visible: boolean;
  themeName?: AppThemeName;
  age?: number | null;
  onClose: () => void;
}

interface ProbeState {
  platformAvailable: boolean;
  enabled: boolean;
  summary: HealthSummary | null;
  today: DailySnapshot | null;
  yesterday: DailySnapshot | null;
  nutritionToday: DailyNutritionSnapshot | null;
  nutritionYesterday: DailyNutritionSnapshot | null;
  cycle: CycleStatus | null;
  checkedAt: string | null;
}

interface SignalRow {
  key: string;
  label: string;
  icon: IconName;
  status: SignalStatus;
  value: string;
  detail: string;
  hint: string;
  optional?: boolean;
}

const EMPTY_PROBE: ProbeState = {
  platformAvailable: false,
  enabled: false,
  summary: null,
  today: null,
  yesterday: null,
  nutritionToday: null,
  nutritionYesterday: null,
  cycle: null,
  checkedAt: null,
};

const CORE_SIGNAL_KEYS = new Set(['sleep', 'resting_hr', 'hrv', 'activity', 'workouts', 'energy']);

function dayWindow(offsetDays = 0): { start: number; end: number } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + offsetDays);
  return { start: start.getTime(), end: start.getTime() + 86400000 };
}

function hasNumber(value: unknown): value is number {
  return hasHealthMetricValue(value);
}

function formatNumber(value: number, suffix = ''): string {
  return `${Math.round(value).toLocaleString()}${suffix}`;
}

function formatHours(value: number): string {
  return `${value.toFixed(value >= 10 ? 0 : 1)}h`;
}

function formatCheckedAt(iso: string | null): string {
  if (!iso) return 'Not checked yet';
  const d = new Date(iso);
  return `Checked ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function nutritionHasAny(snapshot: DailyNutritionSnapshot | null): boolean {
  if (!snapshot) return false;
  return [snapshot.calories, snapshot.proteinG, snapshot.carbsG, snapshot.fatG].some(v => hasNumber(v) && v > 0);
}

function latestNutrition(today: DailyNutritionSnapshot | null, yesterday: DailyNutritionSnapshot | null): DailyNutritionSnapshot | null {
  if (nutritionHasAny(today)) return today;
  if (nutritionHasAny(yesterday)) return yesterday;
  return today ?? yesterday;
}

function statusFor(probe: ProbeState, observed: boolean, optional = false): SignalStatus {
  if (!probe.platformAvailable) return 'unavailable';
  if (!probe.enabled) return 'setup';
  if (observed) return 'ok';
  return optional ? 'missing' : 'missing';
}

function statusLabel(status: SignalStatus, optional?: boolean): string {
  if (status === 'ok') return 'Receiving';
  if (status === 'setup') return 'Needs setup';
  if (status === 'unavailable') return 'Unavailable';
  return optional ? 'No recent data' : 'Check access';
}

function cycleLabel(cycle: CycleStatus | null): string {
  if (!cycle) return 'No cycle samples found';
  const phase = cycle.phase.replace(/\b\w/g, c => c.toUpperCase());
  return cycle.dayOfCycle ? `${phase} - day ${cycle.dayOfCycle}` : phase;
}

function buildSignalRows(probe: ProbeState): SignalRow[] {
  const summary = probe.summary;
  const daily = probe.today ?? probe.yesterday;
  const nutrition = latestNutrition(probe.nutritionToday, probe.nutritionYesterday);
  const workouts = Array.isArray(summary?.workoutDetails) ? summary.workoutDetails : [];

  const sleepObserved = hasNumber(summary?.lastNightSleepHours) || hasNumber(summary?.avgSleepHours7d) || hasNumber(summary?.sleepScore?.score);
  const sleepValue = hasNumber(summary?.lastNightSleepHours)
    ? `${formatHours(summary.lastNightSleepHours)} last night`
    : hasNumber(summary?.avgSleepHours7d)
      ? `${formatHours(summary.avgSleepHours7d)} 7-day avg`
      : 'No recent sleep';

  const stepsValue = hasNumber(summary?.avgSteps7d)
    ? `${formatNumber(summary.avgSteps7d)} steps/day`
    : hasNumber(daily?.steps)
      ? `${formatNumber(daily.steps)} recent steps`
      : 'No recent steps';

  const workoutMinutes = (daily?.workoutMinutes ?? 0) || workouts.reduce((sum, w: any) => sum + (Number(w?.duration ?? 0) || 0), 0);
  const workoutValue = workouts.length > 0
    ? `${workouts.length} workout${workouts.length === 1 ? '' : 's'} in 7 days`
    : workoutMinutes > 0
      ? `${Math.round(workoutMinutes)} min recent workouts`
      : 'No recent workouts';

  const activeEnergy = summary?.activeEnergy7d ?? daily?.activeEnergyKcal ?? null;
  const basalEnergy = summary?.basalEnergy7d ?? daily?.basalEnergyKcal ?? null;
  const energyValue = hasNumber(activeEnergy)
    ? `${formatNumber(activeEnergy, ' kcal')} active`
    : hasNumber(basalEnergy)
      ? `${formatNumber(basalEnergy, ' kcal')} basal`
      : 'No recent energy';

  const weight = probe.today?.weightLbs ?? probe.yesterday?.weightLbs ?? null;
  const nutritionValue = nutritionHasAny(nutrition)
    ? [
        hasNumber(nutrition?.calories) ? `${formatNumber(nutrition.calories)} kcal` : null,
        hasNumber(nutrition?.proteinG) ? `${formatNumber(nutrition.proteinG, 'g protein')}` : null,
      ].filter(Boolean).join(' - ')
    : 'No recent nutrition totals';

  const recoveryVitalsObserved = hasNumber(summary?.respiratoryRate)
    || hasNumber(summary?.oxygenSaturation)
    || hasNumber(summary?.standingHours7d)
    || hasNumber(summary?.mindfulMinutes7d);
  const recoveryVitalsValue = [
    hasNumber(summary?.respiratoryRate) ? `${Math.round(summary.respiratoryRate)} br/min` : null,
    hasNumber(summary?.oxygenSaturation) ? `${Math.round(summary.oxygenSaturation)}% SpO2` : null,
    hasNumber(summary?.standingHours7d) ? `${Math.round(summary.standingHours7d)} standing hrs` : null,
    hasNumber(summary?.mindfulMinutes7d) ? `${Math.round(summary.mindfulMinutes7d)} mindful min` : null,
  ].filter(Boolean).join(' - ') || 'No recent recovery vitals';

  return [
    {
      key: 'sleep',
      label: 'Sleep',
      icon: 'moon-outline',
      status: statusFor(probe, sleepObserved),
      value: sleepValue,
      detail: 'Used for sleep score, readiness, and weekly recovery context.',
      hint: `In ${HEALTH_PLATFORM_LABEL}, allow Sleep for Thallo and make sure your ${HEALTH_WEARABLE_LABEL} or sleep app writes sleep samples.`,
    },
    {
      key: 'resting_hr',
      label: 'Resting heart rate',
      icon: 'heart-outline',
      status: statusFor(probe, hasNumber(summary?.restingHeartRate)),
      value: hasNumber(summary?.restingHeartRate) ? `${Math.round(summary.restingHeartRate)} bpm` : 'No recent resting HR',
      detail: 'Used for readiness, recovery, and cardio-zone estimates.',
      hint: `Allow Heart and Resting Heart Rate for Thallo, then let your ${HEALTH_WEARABLE_LABEL} sync recent heart data.`,
    },
    {
      key: 'hrv',
      label: 'HRV',
      icon: 'pulse-outline',
      status: statusFor(probe, hasNumber(summary?.hrvAvg)),
      value: hasNumber(summary?.hrvAvg) ? `${Math.round(summary.hrvAvg)} ms` : 'No recent HRV',
      detail: 'Helps compare recovery against your recent baseline.',
      hint: `Allow HRV for Thallo. Your ${HEALTH_WEARABLE_LABEL} may write HRV after sleep, mindfulness, or recovery readings.`,
    },
    {
      key: 'activity',
      label: 'Steps',
      icon: 'walk-outline',
      status: statusFor(probe, hasNumber(summary?.avgSteps7d) || hasNumber(daily?.steps)),
      value: stepsValue,
      detail: 'Used for daily activity, training context, and energy estimates.',
      hint: `Allow Steps for Thallo and confirm your ${HEALTH_DEVICE_LABEL} or ${HEALTH_WEARABLE_LABEL} appears as a data source.`,
    },
    {
      key: 'workouts',
      label: 'Workouts',
      icon: 'fitness-outline',
      status: statusFor(probe, workouts.length > 0 || workoutMinutes > 0),
      value: workoutValue,
      detail: 'Used for imports, training history, and recovery load.',
      hint: `Allow Workouts for Thallo. Sessions tracked in other apps need to write workouts into ${HEALTH_PLATFORM_LABEL} first.`,
    },
    {
      key: 'energy',
      label: 'Energy',
      icon: 'flame-outline',
      status: statusFor(probe, hasNumber(activeEnergy) || hasNumber(basalEnergy)),
      value: energyValue,
      detail: 'Active and basal energy improve nutrition and recovery estimates.',
      hint: `Allow Active Energy and Basal Energy for Thallo. Activity from your ${HEALTH_WEARABLE_LABEL} usually fills these.`,
    },
    {
      key: 'weight',
      label: 'Body weight',
      icon: 'scale-outline',
      status: statusFor(probe, hasNumber(weight), true),
      value: hasNumber(weight) ? `${Math.round(weight)} lb` : 'No recent weight',
      detail: 'Keeps weight trends and macro context current.',
      hint: 'Allow Body Measurements or Body Weight for Thallo, then log weight in Health or a connected scale app.',
      optional: true,
    },
    {
      key: 'nutrition',
      label: 'Nutrition summaries',
      icon: 'restaurant-outline',
      status: statusFor(probe, nutritionHasAny(nutrition), true),
      value: nutritionValue,
      detail: 'Reads daily calories and macros from apps that write meal totals to Health.',
      hint: `Allow dietary energy, protein, carbs, and fat for Thallo. For MyFitnessPal, enable sharing to ${HEALTH_PLATFORM_LABEL} too.`,
      optional: true,
    },
    {
      key: 'vo2',
      label: 'Cardio fitness',
      icon: 'speedometer-outline',
      status: statusFor(probe, hasNumber(summary?.vo2Max), true),
      value: hasNumber(summary?.vo2Max) ? `${summary.vo2Max.toFixed(1)} VO2 max` : 'No recent VO2 max',
      detail: 'Supports cardio trends and heart-rate-zone estimates.',
      hint: `Allow VO2 Max for Thallo. Your ${HEALTH_WEARABLE_LABEL} may estimate it from outdoor walking, running, or hiking.`,
      optional: true,
    },
    {
      key: 'recovery_vitals',
      label: 'Recovery vitals',
      icon: 'medkit-outline',
      status: statusFor(probe, recoveryVitalsObserved, true),
      value: recoveryVitalsValue,
      detail: 'Respiratory rate, blood oxygen, standing hours, and mindful minutes add optional recovery context.',
      hint: 'Allow respiratory rate, blood oxygen, standing hours, and mindful minutes for Thallo if you want these signals included.',
      optional: true,
    },
    {
      key: 'cycle',
      label: 'Cycle signals',
      icon: 'calendar-outline',
      status: statusFor(probe, !!probe.cycle, true),
      value: cycleLabel(probe.cycle),
      detail: 'Optional menstrual-flow data enables cycle-aware training and readiness guidance.',
      hint: `Leave this off if it is not relevant. If it is, allow menstrual-flow data and log periods in ${HEALTH_PLATFORM_LABEL}.`,
      optional: true,
    },
  ];
}

export default function HealthPermissionsScreen({ visible, themeName, age, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const tc = getTheme(themeName).colors;
  const [loading, setLoading] = useState(false);
  const [probe, setProbe] = useState<ProbeState>(EMPTY_PROBE);

  const refresh = useCallback(async (requestAccess = false) => {
    setLoading(true);
    try {
      const platformAvailable = isPlatformHealthAvailable();
      if (!platformAvailable) {
        setProbe({ ...EMPTY_PROBE, platformAvailable: false, checkedAt: new Date().toISOString() });
        return;
      }

      let enabled = await isAppleHealthEnabled().catch(() => false);
      if (requestAccess) {
        const granted = await requestPlatformHealthPermissions();
        await setAppleHealthEnabled(granted).catch(() => undefined);
        enabled = granted;
        if (!granted) {
          const err = getLastPlatformHealthError();
          Alert.alert(`${HEALTH_PLATFORM_LABEL} not connected`, `${PLATFORM_HEALTH_PERMISSION_COPY.denied}\n\n${err ?? ''}`.trim());
        }
      }

      if (!enabled) {
        setProbe({
          ...EMPTY_PROBE,
          platformAvailable: true,
          enabled: false,
          checkedAt: new Date().toISOString(),
        });
        return;
      }

      const today = dayWindow(0);
      const yesterday = dayWindow(-1);
      const [
        summary,
        todaySnapshot,
        yesterdaySnapshot,
        nutritionToday,
        nutritionYesterday,
        cycle,
      ] = await Promise.all([
        readPlatformHealthSummary({ age: age ?? null }).catch(() => null),
        readPlatformDailySnapshot(today.start, today.end).catch(() => null),
        readPlatformDailySnapshot(yesterday.start, yesterday.end).catch(() => null),
        readPlatformDailyNutritionSnapshot(today.start, today.end).catch(() => null),
        readPlatformDailyNutritionSnapshot(yesterday.start, yesterday.end).catch(() => null),
        getPlatformCycleStatus().catch(() => null),
      ]);

      if (summary) saveHealthSummary(summary).catch(() => undefined);
      setProbe({
        platformAvailable: true,
        enabled: true,
        summary,
        today: todaySnapshot,
        yesterday: yesterdaySnapshot,
        nutritionToday,
        nutritionYesterday,
        cycle,
        checkedAt: new Date().toISOString(),
      });
    } finally {
      setLoading(false);
    }
  }, [age]);

  useEffect(() => {
    if (!visible) return;
    refresh(false).catch(() => {
      setLoading(false);
      setProbe({ ...EMPTY_PROBE, platformAvailable: isPlatformHealthAvailable(), checkedAt: new Date().toISOString() });
    });
  }, [refresh, visible]);

  const rows = useMemo(() => buildSignalRows(probe), [probe]);
  const hiddenMissingRows = probe.enabled ? rows.filter(row => row.status === 'missing') : [];
  const displayRows = probe.enabled ? rows.filter(row => row.status === 'ok') : rows;
  const missingCoreRows = rows.filter(row => CORE_SIGNAL_KEYS.has(row.key) && row.status === 'missing');
  const okCoreRows = rows.filter(row => CORE_SIGNAL_KEYS.has(row.key) && row.status === 'ok');

  if (!visible) return null;

  const successColor = tc.success ?? '#22C55E';
  const warningColor = tc.warning ?? '#F59E0B';
  const errorColor = tc.error ?? '#EF4444';
  const mutedPanel = tc.surfaceRaised ?? tc.surface;
  const connectLabel = probe.enabled ? 'Recheck Access' : `Connect ${HEALTH_PLATFORM_LABEL}`;

  const statusColor = (status: SignalStatus, optional?: boolean) => {
    if (status === 'ok') return successColor;
    if (status === 'setup') return tc.textMuted;
    if (status === 'unavailable') return tc.textMuted;
    return optional ? warningColor : errorColor;
  };

  const openDeviceSettings = () => {
    const openPromise = Platform.OS === 'ios'
      ? Linking.openURL('app-settings:')
      : Linking.openSettings();
    openPromise.catch(() => {
      Alert.alert(
        'Unable to open Settings',
        Platform.OS === 'ios'
          ? 'Open iPhone Settings -> Privacy & Security -> Health -> Thallo manually.'
          : 'Open Android Settings and choose Thallo manually.',
      );
    });
  };

  const banner = !probe.platformAvailable
    ? {
        icon: 'information-circle-outline' as IconName,
        color: tc.textMuted,
        title: `${HEALTH_PLATFORM_LABEL} unavailable`,
        body: HEALTH_PLATFORM_STATUS_COPY,
      }
    : !probe.enabled
      ? {
          icon: 'heart-outline' as IconName,
          color: tc.primary,
          title: `${HEALTH_PLATFORM_LABEL} is optional`,
          body: 'Connect when you want Thallo to use health categories that your phone, wearable, or connected apps record.',
        }
      : missingCoreRows.length > 0
        ? {
            icon: 'alert-circle-outline' as IconName,
            color: warningColor,
            title: `${missingCoreRows.length} core signal${missingCoreRows.length === 1 ? '' : 's'} waiting for data`,
            body: `Rows without recent samples stay hidden. ${HEALTH_PLATFORM_LABEL} may not have a source for that category yet, the category may be off for Thallo, or the device has not synced.`,
          }
        : {
            icon: 'checkmark-circle-outline' as IconName,
            color: successColor,
            title: 'Core signals are coming through',
            body: `${okCoreRows.length} core ${HEALTH_PLATFORM_LABEL} signal${okCoreRows.length === 1 ? '' : 's'} returned recent data.`,
          };

  return (
    <View style={[styles.root, { backgroundColor: tc.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 12, borderBottomColor: tc.border }]}>
        <TouchableOpacity
          testID="health-permissions-back"
          accessibilityLabel="health-permissions-back"
          onPress={onClose}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={26} color={tc.textPrimary} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: tc.textPrimary }]}>Health Permissions</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 36 }}>
        <View style={[styles.banner, { backgroundColor: banner.color + '14', borderColor: banner.color + '55' }]}>
          <Ionicons name={banner.icon} size={20} color={banner.color} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.bannerTitle, { color: tc.textPrimary }]}>{banner.title}</Text>
            <Text style={[styles.bannerBody, { color: tc.textSecondary }]}>{banner.body}</Text>
          </View>
        </View>

        <View style={styles.actionRow}>
          <TouchableOpacity
            testID="health-permissions-connect"
            accessibilityLabel="health-permissions-connect"
            disabled={loading || !probe.platformAvailable}
            onPress={() => refresh(true).catch(() => setLoading(false))}
            style={[
              styles.primaryButton,
              { backgroundColor: probe.platformAvailable ? tc.primary : tc.border },
            ]}>
            {loading ? (
              <ActivityIndicator color={getContrastingTextColor(tc.primary)} />
            ) : (
              <>
                <Ionicons name="sync-outline" size={17} color={getContrastingTextColor(tc.primary)} />
                <Text style={[styles.primaryButtonText, { color: getContrastingTextColor(tc.primary) }]}>{connectLabel}</Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            testID="health-permissions-open-settings"
            accessibilityLabel="health-permissions-open-settings"
            onPress={openDeviceSettings}
            style={[styles.secondaryButton, { borderColor: tc.border, backgroundColor: mutedPanel }]}>
            <Ionicons name="settings-outline" size={17} color={tc.textSecondary} />
            <Text style={[styles.secondaryButtonText, { color: tc.textPrimary }]}>
              {Platform.OS === 'ios' ? 'iOS Settings' : 'Android Settings'}
            </Text>
          </TouchableOpacity>
        </View>

        <Text style={[styles.checkedText, { color: tc.textMuted }]}>{formatCheckedAt(probe.checkedAt)}</Text>

        <Text style={[styles.sectionLabel, { color: tc.textMuted }]}>
          {probe.enabled ? 'DETECTED SIGNALS' : 'SIGNALS'}
        </Text>
        <View style={[styles.card, { backgroundColor: tc.surface, borderColor: tc.border }]}>
          {displayRows.length === 0 ? (
            <View style={styles.emptySignalState}>
              <Ionicons name="eye-off-outline" size={18} color={tc.textMuted} />
              <Text style={[styles.emptySignalTitle, { color: tc.textPrimary }]}>No displayable signals yet</Text>
              <Text style={[styles.emptySignalBody, { color: tc.textMuted }]}>
                Metrics appear here only after Apple Health returns recent samples from your iPhone, Apple Watch, or another source app.
              </Text>
            </View>
          ) : displayRows.map((row, index) => {
            const color = statusColor(row.status, row.optional);
            return (
              <View
                key={row.key}
                style={[
                  styles.signalRow,
                  index > 0 && { borderTopWidth: 1, borderTopColor: tc.border },
                ]}>
                <View style={[styles.signalIcon, { backgroundColor: color + '14' }]}>
                  <Ionicons name={row.icon} size={18} color={color} />
                </View>
                <View style={{ flex: 1 }}>
                  <View style={styles.signalTitleRow}>
                    <Text style={[styles.signalTitle, { color: tc.textPrimary }]}>{row.label}</Text>
                    <View style={[styles.statusPill, { backgroundColor: color + '14', borderColor: color + '44' }]}>
                      <Text style={[styles.statusPillText, { color }]}>{statusLabel(row.status, row.optional)}</Text>
                    </View>
                  </View>
                  <Text style={[styles.signalValue, { color: row.status === 'ok' ? color : tc.textSecondary }]}>{row.value}</Text>
                  <Text style={[styles.signalDetail, { color: tc.textMuted }]}>{row.detail}</Text>
                  {row.status === 'missing' && (
                    <Text style={[styles.signalHint, { color: tc.textSecondary }]}>{row.hint}</Text>
                  )}
                </View>
              </View>
            );
          })}
        </View>
        {probe.enabled && hiddenMissingRows.length > 0 && (
          <Text style={[styles.hiddenSignalsText, { color: tc.textMuted }]}>
            Categories without recent Apple Health samples stay hidden here until a source writes data.
          </Text>
        )}

        <Text style={[styles.sectionLabel, { color: tc.textMuted }]}>WHERE TO FIX IT</Text>
        <View style={[styles.card, { backgroundColor: tc.surface, borderColor: tc.border }]}>
          {[
            'Health app -> profile picture -> Privacy -> Apps -> Thallo -> turn on the categories you want to share.',
            'iPhone Settings -> Privacy & Security -> Health -> Thallo also shows Apple Health access for the app.',
            'For MyFitnessPal or another source app, enable its Health sharing first, then allow Thallo to read the summary categories.',
            'For Watch signals, open Health after your watch syncs; Sleep, HRV, and VO2 max may only appear after specific recordings.',
          ].map((step, index) => (
            <View
              key={step}
              style={[
                styles.fixRow,
                index > 0 && { borderTopWidth: 1, borderTopColor: tc.border },
              ]}>
              <Ionicons name="checkmark-circle-outline" size={17} color={tc.primary} />
              <Text style={[styles.fixText, { color: tc.textSecondary }]}>{step}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 120, elevation: 30 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 18, fontWeight: '800' },
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: 13,
  },
  bannerTitle: { fontSize: 14, fontWeight: '800' },
  bannerBody: { fontSize: 12, lineHeight: 17, marginTop: 3 },
  actionRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  primaryButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 12,
  },
  primaryButtonText: { flexShrink: 1, fontSize: 13, fontWeight: '800', textAlign: 'center' },
  secondaryButton: {
    minHeight: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 12,
  },
  secondaryButtonText: { flexShrink: 1, fontSize: 13, fontWeight: '700' },
  checkedText: { fontSize: 11, marginTop: 9, paddingHorizontal: 3 },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    marginTop: 20,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  card: { borderWidth: 1, borderRadius: radius.lg, paddingHorizontal: 13 },
  emptySignalState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 22,
    paddingHorizontal: 8,
  },
  emptySignalTitle: { fontSize: 13, fontWeight: '800', marginTop: 7, textAlign: 'center' },
  emptySignalBody: { fontSize: 12, lineHeight: 17, marginTop: 4, textAlign: 'center' },
  hiddenSignalsText: { fontSize: 11, lineHeight: 16, marginTop: 8, paddingHorizontal: 4 },
  signalRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 11,
    paddingVertical: 13,
  },
  signalIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  signalTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  signalTitle: { flex: 1, fontSize: 14, fontWeight: '800' },
  statusPill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  statusPillText: { fontSize: 10, fontWeight: '900', textTransform: 'uppercase' },
  signalValue: { fontSize: 12, fontWeight: '800', marginTop: 3 },
  signalDetail: { fontSize: 11, lineHeight: 15, marginTop: 2 },
  signalHint: { fontSize: 11, lineHeight: 15, marginTop: 7 },
  fixRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, paddingVertical: 12 },
  fixText: { flex: 1, fontSize: 12, lineHeight: 17 },
});
