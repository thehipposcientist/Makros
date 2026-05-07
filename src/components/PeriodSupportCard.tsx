import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import type { AppThemeName, WorkoutDay } from '../types';
import { getCycleStatus, type CycleStatus } from '../services/appleHealth';
import {
  buildCycleSupportGuidance,
  cycleStartDateForLog,
  formatLocalDate,
  plannedSetTotal,
  summarizeCyclePattern,
  trimPeriodSymptomLogs,
  upsertPeriodSymptomLog,
  type CycleCramps,
  type CycleEnergy,
  type CycleFlow,
  type CycleTrainingAction,
  type PeriodSymptomLog,
} from '../utils/cycleSupport';

const STORAGE_KEY = 'periodSymptomLogs_v1';

const PHASE_INFO: Record<CycleStatus['phase'], { label: string; color: string; icon: any }> = {
  menses: { label: 'Period', color: '#EF4444', icon: 'water-outline' },
  follicular: { label: 'Follicular', color: '#22C55E', icon: 'leaf-outline' },
  ovulation: { label: 'Ovulation', color: '#EAB308', icon: 'sparkles-outline' },
  luteal: { label: 'Luteal', color: '#A78BFA', icon: 'moon-outline' },
  unknown: { label: 'Cycle', color: '#9CA3AF', icon: 'help-circle-outline' },
};

function flowFromHealth(status: CycleStatus | null): CycleFlow {
  const flow = status?.currentFlow;
  return flow === 'light' || flow === 'moderate' || flow === 'heavy' ? flow : 'moderate';
}

function flowLabel(flow: CycleFlow | null | undefined): string | null {
  if (!flow) return null;
  if (flow === 'unspecified') return 'Logged';
  return flow[0].toUpperCase() + flow.slice(1);
}

interface Props {
  themeName?: AppThemeName;
  todaysWorkout?: WorkoutDay | null;
  isWorkoutDone?: boolean;
  isWorkoutSkipped?: boolean;
  onUseLighterWorkout?: () => Promise<void> | void;
  onUseRecoveryDay?: () => Promise<void> | void;
  onAddHydration?: () => Promise<void> | void;
}

async function loadLogs(): Promise<PeriodSymptomLog[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(Boolean) as PeriodSymptomLog[] : [];
  } catch {
    return [];
  }
}

async function saveLogs(logs: PeriodSymptomLog[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(logs));
}

export default function CycleGuidanceCard({
  themeName,
  todaysWorkout,
  isWorkoutDone,
  isWorkoutSkipped,
  onUseLighterWorkout,
  onUseRecoveryDay,
  onAddHydration,
}: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const primaryText = getContrastingTextColor(tc.primary);
  const today = useMemo(() => formatLocalDate(new Date()), []);

  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<CycleStatus | null>(null);
  const [logs, setLogs] = useState<PeriodSymptomLog[]>([]);
  const [flow, setFlow] = useState<CycleFlow>('moderate');
  const [cramps, setCramps] = useState<CycleCramps>('mild');
  const [energy, setEnergy] = useState<CycleEnergy>('normal');
  const [saving, setSaving] = useState(false);
  const [pendingAction, setPendingAction] = useState<CycleTrainingAction | null>(null);
  const [savedTick, setSavedTick] = useState(0);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([getCycleStatus().catch(() => null), loadLogs()]).then(([cycle, stored]) => {
      if (!alive) return;
      setStatus(cycle);
      setLogs(stored);
      const existing = stored.find(log => log.date === today);
      if (existing) {
        setFlow(existing.flow);
        setCramps(existing.cramps);
        setEnergy(existing.energy);
      } else {
        setFlow(flowFromHealth(cycle));
      }
      setLoaded(true);
    });
    return () => { alive = false; };
  }, [today]);

  const cycleStart = useMemo(
    () => cycleStartDateForLog(today, status?.dayOfCycle ?? null),
    [status?.dayOfCycle, today],
  );

  const guidance = useMemo(() => buildCycleSupportGuidance({
    phase: status?.phase ?? 'unknown',
    dayOfCycle: status?.dayOfCycle ?? null,
    cycleLengthDays: status?.cycleLengthDays ?? null,
    flow,
    cramps,
    energy,
  }), [cramps, energy, flow, status?.cycleLengthDays, status?.dayOfCycle, status?.phase]);

  const adaptiveInsight = useMemo(
    () => summarizeCyclePattern(logs, cycleStart),
    [cycleStart, logs],
  );

  const saveCheckin = useCallback(async (action?: CycleTrainingAction | null) => {
    if (!status || status.phase !== 'menses') return;
    setSaving(true);
    const nextLog: PeriodSymptomLog = {
      date: today,
      cycleStartDate: cycleStart,
      phase: status.phase,
      dayOfCycle: status.dayOfCycle,
      cycleLengthDays: status.cycleLengthDays,
      flow,
      cramps,
      energy,
      action: action ?? logs.find(log => log.date === today)?.action ?? null,
      updatedAt: new Date().toISOString(),
    };
    const nextLogs = trimPeriodSymptomLogs(upsertPeriodSymptomLog(logs, nextLog), today);
    setLogs(nextLogs);
    try {
      await saveLogs(nextLogs);
      setSavedTick(Date.now());
    } finally {
      setSaving(false);
    }
  }, [cramps, cycleStart, energy, flow, logs, status, today]);

  const runAction = useCallback((action: CycleTrainingAction, runner?: () => Promise<void> | void) => {
    if (!runner) return;
    const copy = action === 'lighter'
      ? {
          title: 'Lighten today?',
          body: 'This reduces sets and softens loading for today only. Your 7-day plan stays on its normal schedule.',
          cta: 'Lighten today',
        }
      : {
          title: 'Make today recovery?',
          body: 'This marks today as active recovery for period symptoms. Your plan can continue from the next scheduled day.',
          cta: 'Use recovery',
        };
    Alert.alert(copy.title, copy.body, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: copy.cta,
        onPress: async () => {
          setPendingAction(action);
          try {
            await saveCheckin(action);
            await runner();
          } catch (e) {
            Alert.alert('Could not update today', 'Please try again in a moment.');
          } finally {
            setPendingAction(null);
          }
        },
      },
    ]);
  }, [saveCheckin]);

  if (!loaded) return null;
  if (!status || status.phase === 'unknown') return null;

  const isMenses = status.phase === 'menses';
  const phaseInfo = PHASE_INFO[status.phase];
  const daysUntilNext = status.nextExpectedMenses
    ? Math.max(0, Math.ceil((new Date(status.nextExpectedMenses).getTime() - Date.now()) / 86400000))
    : null;
  const subtitle = [
    'Apple Health',
    status.dayOfCycle != null ? `cycle day ${status.dayOfCycle}` : null,
    `est. ${status.cycleLengthDays}-day cycle`,
    daysUntilNext != null ? `next period in ${daysUntilNext}d` : null,
  ].filter(Boolean).join(' - ');
  const healthFlowLabel = flowLabel(status.currentFlow);

  const canAdjustWorkout = isMenses && !!todaysWorkout && !isWorkoutDone && !isWorkoutSkipped;
  const currentSets = plannedSetTotal(todaysWorkout);
  const estimatedLighterSets = todaysWorkout ? plannedSetTotal({
    ...todaysWorkout,
    exercises: todaysWorkout.exercises.map(ex => ({
      ...ex,
      sets: Math.max(1, (Number(ex.sets) || 3) >= 4 ? (Number(ex.sets) || 3) - 2 : (Number(ex.sets) || 3) - 1),
    })),
  }) : 0;

  const renderChoice = <T extends string>(
    label: string,
    value: T,
    current: string,
    setValue: (v: T) => void,
  ) => {
    const selected = value === current;
    return (
      <TouchableOpacity
        key={value}
        accessibilityRole="button"
        onPress={() => setValue(value)}
        style={{
          paddingHorizontal: 10,
          paddingVertical: 7,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: selected ? tc.primary : tc.border,
          backgroundColor: selected ? tc.primary + '1F' : tc.surfaceRaised,
        }}>
        <Text style={{ fontSize: 11, fontWeight: '800', color: selected ? tc.primary : tc.textSecondary }}>
          {label}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <View style={{
      backgroundColor: tc.surface,
      borderRadius: radius.lg,
      padding: 14,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: tc.border,
    }}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Collapse cycle guidance' : 'Expand cycle guidance'}
        activeOpacity={0.82}
        onPress={() => setExpanded(v => !v)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{
          width: 40,
          height: 40,
          borderRadius: 20,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: phaseInfo.color + '18',
        }}>
          <Ionicons name={phaseInfo.icon} size={18} color={phaseInfo.color} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.6 }}>
            CYCLE GUIDANCE
          </Text>
          <Text style={{ fontSize: 16, fontWeight: '900', color: phaseInfo.color, marginTop: 1 }}>
            {isMenses ? `Period day ${status.dayOfCycle ?? '-'}` : `${phaseInfo.label} phase`}
          </Text>
          <Text style={{ fontSize: 11, color: tc.textSecondary, marginTop: 1 }}>
            {subtitle}
          </Text>
        </View>
        {saving ? <ActivityIndicator size="small" color={tc.primary} /> : null}
        <Ionicons name={expanded ? 'chevron-up-outline' : 'chevron-down-outline'} size={18} color={tc.textMuted} />
      </TouchableOpacity>

      {expanded && (
        <>
          <View style={{ marginTop: 12, gap: 6 }}>
            <Text style={{ fontSize: 13, fontWeight: '900', color: tc.textPrimary }}>
              {guidance.phaseTitle}
            </Text>
            <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 17 }}>
              {guidance.phaseDetail}
            </Text>
          </View>

          {isMenses && (
            <View style={{ gap: 8, marginTop: 12 }}>
              {healthFlowLabel && (
                <View style={{
                  alignSelf: 'flex-start',
                  paddingHorizontal: 9,
                  paddingVertical: 5,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: phaseInfo.color + '55',
                  backgroundColor: phaseInfo.color + '10',
                }}>
                  <Text style={{ fontSize: 11, fontWeight: '800', color: phaseInfo.color }}>
                    Apple Health flow: {healthFlowLabel}
                  </Text>
                </View>
              )}
              <View>
                <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, marginBottom: 6 }}>FLOW</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {renderChoice('Light', 'light', flow, setFlow)}
                  {renderChoice('Moderate', 'moderate', flow, setFlow)}
                  {renderChoice('Heavy', 'heavy', flow, setFlow)}
                </View>
              </View>
              <View>
                <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, marginBottom: 6 }}>CRAMPS</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {renderChoice('None', 'none', cramps, setCramps)}
                  {renderChoice('Mild', 'mild', cramps, setCramps)}
                  {renderChoice('Moderate', 'moderate', cramps, setCramps)}
                  {renderChoice('Severe', 'severe', cramps, setCramps)}
                </View>
              </View>
              <View>
                <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, marginBottom: 6 }}>ENERGY</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {renderChoice('Low', 'low', energy, setEnergy)}
                  {renderChoice('Normal', 'normal', energy, setEnergy)}
                  {renderChoice('High', 'high', energy, setEnergy)}
                </View>
              </View>
            </View>
          )}

          {isMenses && (
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => saveCheckin().catch(() => {
                Alert.alert('Could not save check-in', 'Please try again in a moment.');
              })}
              style={{
                alignSelf: 'flex-start',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                marginTop: 12,
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 8,
                backgroundColor: tc.primary,
              }}>
              <Ionicons name={savedTick ? 'checkmark-circle-outline' : 'save-outline'} size={15} color={primaryText} />
              <Text style={{ fontSize: 12, fontWeight: '900', color: primaryText }}>
                {savedTick ? 'Saved' : 'Save today'}
              </Text>
            </TouchableOpacity>
          )}

          <View style={{ marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: tc.border }}>
            <Text style={{ fontSize: 13, fontWeight: '900', color: tc.textPrimary }}>
              {guidance.trainingTitle}
            </Text>
            <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 17, marginTop: 3 }}>
              {guidance.trainingDetail}
            </Text>
            {canAdjustWorkout && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                {onUseLighterWorkout && (
                  <TouchableOpacity
                    accessibilityRole="button"
                    disabled={pendingAction != null}
                    onPress={() => runAction('lighter', onUseLighterWorkout)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 6,
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: tc.warning + '88',
                      backgroundColor: tc.warning + '16',
                    }}>
                    <Ionicons name="remove-circle-outline" size={15} color={tc.warning} />
                    <Text style={{ fontSize: 12, fontWeight: '800', color: tc.warning }}>
                      Lighten today{currentSets > 0 && estimatedLighterSets > 0 ? ` (${currentSets}->${estimatedLighterSets} sets)` : ''}
                    </Text>
                  </TouchableOpacity>
                )}
                {onUseRecoveryDay && (
                  <TouchableOpacity
                    accessibilityRole="button"
                    disabled={pendingAction != null}
                    onPress={() => runAction('recovery', onUseRecoveryDay)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 6,
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: tc.primary + '88',
                      backgroundColor: tc.primary + '16',
                    }}>
                    <Ionicons name="walk-outline" size={15} color={tc.primary} />
                    <Text style={{ fontSize: 12, fontWeight: '800', color: tc.primary }}>Use recovery</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </View>

      <View style={{ marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: tc.border }}>
        <Text style={{ fontSize: 13, fontWeight: '900', color: tc.textPrimary }}>Nutrition focus</Text>
        <View style={{ gap: 8, marginTop: 8 }}>
          {guidance.nutrition.slice(0, 4).map(item => (
            <View key={item.title} style={{ flexDirection: 'row', gap: 8 }}>
              <Ionicons name={item.icon as any} size={15} color={tc.primary} style={{ marginTop: 1 }} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 12, fontWeight: '800', color: tc.textPrimary }}>{item.title}</Text>
                <Text style={{ fontSize: 11, color: tc.textSecondary, lineHeight: 16, marginTop: 1 }}>{item.detail}</Text>
              </View>
            </View>
          ))}
        </View>
        {onAddHydration && (
          <TouchableOpacity
            accessibilityRole="button"
            disabled={pendingAction != null}
            onPress={() => onAddHydration()}
            style={{
              alignSelf: 'flex-start',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              marginTop: 10,
              paddingHorizontal: 10,
              paddingVertical: 7,
              borderRadius: 8,
              backgroundColor: tc.surfaceRaised,
              borderWidth: 1,
              borderColor: tc.border,
            }}>
            <Ionicons name="water-outline" size={14} color={tc.primary} />
            <Text style={{ fontSize: 12, fontWeight: '800', color: tc.textPrimary }}>Add 16 oz water</Text>
          </TouchableOpacity>
        )}
      </View>

      {isMenses && adaptiveInsight && (
        <View style={{ marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: tc.border }}>
          <Text style={{ fontSize: 12, fontWeight: '900', color: tc.textPrimary }}>Pattern Thallo noticed</Text>
          <Text style={{ fontSize: 11, color: tc.textSecondary, lineHeight: 16, marginTop: 3 }}>
            {adaptiveInsight}
          </Text>
        </View>
      )}

      {guidance.safety.length > 0 && (
        <View style={{
          marginTop: 12,
          padding: 10,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: tc.warning + '66',
          backgroundColor: tc.warning + '12',
          gap: 6,
        }}>
          {guidance.safety.slice(0, 3).map(note => (
            <View key={note} style={{ flexDirection: 'row', gap: 7 }}>
              <Ionicons name="alert-circle-outline" size={14} color={tc.warning} style={{ marginTop: 1 }} />
              <Text style={{ flex: 1, fontSize: 11, color: tc.textSecondary, lineHeight: 16 }}>{note}</Text>
            </View>
          ))}
        </View>
      )}

      <Text style={{ fontSize: 10, color: tc.textMuted, lineHeight: 14, marginTop: 10 }}>
        Wellness guidance, not a medical diagnosis. Cycle check-ins stay on this device.
      </Text>
        </>
      )}
    </View>
  );
}
