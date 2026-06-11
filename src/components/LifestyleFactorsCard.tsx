import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ImageBackground,
  Modal,
  ScrollView,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { ImageSourcePropType } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme, radius, type AppThemeName } from '../constants/theme';
import type {
  AppetiteLevel,
  BowelConsistency,
  DailyLifestyleLog,
  DailyLifestyleLogPayload,
  IllnessState,
  LifestyleDoseLevel,
  LifestyleStressLevel,
  LifestyleTiming,
} from '../services/api';
import { useLifestyleLog } from '../hooks/useLifestyleLog';

type Props = {
  authToken: string;
  dateISO: string;
  themeName?: AppThemeName;
  title?: string;
  subtitle?: string;
  compact?: boolean;
  variant?: 'card' | 'inline' | 'photo';
  entryImage?: ImageSourcePropType;
};

type Choice<T extends string | null> = { label: string; value: T };
type FactorKey = 'alcohol' | 'cannabis' | 'caffeine' | 'digestion' | 'stress' | 'illness' | 'appetite';
type FactorDefinition = {
  key: FactorKey;
  label: string;
  desc: string;
  icon: keyof typeof Ionicons.glyphMap;
  image: ImageSourcePropType;
};

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

const DOSE_CHOICES: Choice<LifestyleDoseLevel>[] = [
  { label: 'None', value: 'none' },
  { label: 'Light', value: 'light' },
  { label: 'Mod', value: 'moderate' },
  { label: 'Heavy', value: 'heavy' },
];
const TIMING_CHOICES: Choice<LifestyleTiming | null>[] = [
  { label: 'AM', value: 'morning' },
  { label: 'PM', value: 'afternoon' },
  { label: 'Eve', value: 'evening' },
  { label: 'Late', value: 'late' },
];
const CAFFEINE_CHOICES: Choice<LifestyleTiming | null>[] = [
  { label: 'None', value: null },
  { label: 'AM', value: 'morning' },
  { label: 'PM', value: 'afternoon' },
  { label: 'Late', value: 'late' },
];
const BOWEL_CHOICES: Choice<BowelConsistency | null>[] = [
  { label: 'Normal', value: 'normal' },
  { label: 'Hard', value: 'hard' },
  { label: 'Loose', value: 'loose' },
  { label: 'Mixed', value: 'mixed' },
];
const STRESS_CHOICES: Choice<LifestyleStressLevel | null>[] = [
  { label: 'Skip', value: null },
  { label: 'Low', value: 'low' },
  { label: 'Mod', value: 'moderate' },
  { label: 'High', value: 'high' },
];
const ILLNESS_CHOICES: Choice<IllnessState | null>[] = [
  { label: 'Skip', value: null },
  { label: 'Healthy', value: 'healthy' },
  { label: 'Run down', value: 'rundown' },
  { label: 'Sick', value: 'sick' },
];
const APPETITE_CHOICES: Choice<AppetiteLevel | null>[] = [
  { label: 'Skip', value: null },
  { label: 'Low', value: 'low' },
  { label: 'Normal', value: 'normal' },
  { label: 'High', value: 'high' },
];

const LIFESTYLE_FACTORS: FactorDefinition[] = [
  {
    key: 'alcohol',
    label: 'Alcohol',
    desc: 'Dose + timing',
    icon: 'wine-outline',
    image: require('../../assets/images/card-backgrounds/lifestyle-card-alcohol-wine.jpg'),
  },
  {
    key: 'cannabis',
    label: 'Cannabis',
    desc: 'Dose + timing',
    icon: 'leaf-outline',
    image: require('../../assets/images/card-backgrounds/lifestyle-card-cannabis-plant.jpg'),
  },
  {
    key: 'caffeine',
    label: 'Caffeine',
    desc: 'Timing + mg',
    icon: 'cafe-outline',
    image: require('../../assets/images/card-backgrounds/lifestyle-card-caffeine-coffee.jpg'),
  },
  {
    key: 'digestion',
    label: 'Bowel',
    desc: 'Bowel + gut feel',
    icon: 'pulse-outline',
    image: require('../../assets/images/card-backgrounds/lifestyle-card-bowel-bathroom.jpg'),
  },
  {
    key: 'stress',
    label: 'Stress',
    desc: 'Daily load',
    icon: 'speedometer-outline',
    image: require('../../assets/images/card-backgrounds/workout-card-meditation-day.jpg'),
  },
  {
    key: 'illness',
    label: 'Illness',
    desc: 'Body status',
    icon: 'thermometer-outline',
    image: require('../../assets/images/card-backgrounds/lifestyle-card-illness-chicken-soup.jpg'),
  },
  {
    key: 'appetite',
    label: 'Appetite',
    desc: 'Hunger signal',
    icon: 'restaurant-outline',
    image: require('../../assets/images/card-backgrounds/meal-card-high-protein-meal-prep-day.jpg'),
  },
];

function levelLabel(value?: string | null): string | null {
  if (!value || value === 'none') return null;
  return value === 'moderate' ? 'moderate' : value;
}

function summaryChips(log: DailyLifestyleLog | null): string[] {
  if (!log) return [];
  const chips: string[] = [];
  const alcohol = levelLabel(log.alcoholLevel);
  if (alcohol) chips.push(`Alcohol ${alcohol}`);
  const cannabis = levelLabel(log.cannabisLevel);
  if (cannabis) chips.push(`Cannabis ${cannabis}`);
  if (log.stressLevel) chips.push(`Stress ${log.stressLevel}`);
  if (log.illnessState && log.illnessState !== 'healthy') chips.push(log.illnessState === 'sick' ? 'Sick' : 'Run down');
  if (log.lateCaffeine || log.caffeineTiming === 'late') chips.push('Late caffeine');
  if (log.appetite) chips.push(`Appetite ${log.appetite}`);
  if (log.bowelMovementCount != null || log.bowelConsistency) chips.push('Bowel');
  return chips.slice(0, 4);
}

function formFromLog(log: DailyLifestyleLog | null): DailyLifestyleLogPayload {
  return {
    alcoholLevel: log?.alcoholLevel ?? undefined,
    alcoholDrinks: log?.alcoholDrinks ?? undefined,
    alcoholTiming: log?.alcoholTiming ?? undefined,
    cannabisLevel: log?.cannabisLevel ?? undefined,
    cannabisTiming: log?.cannabisTiming ?? undefined,
    bowelMovementCount: log?.bowelMovementCount ?? undefined,
    bowelConsistency: log?.bowelConsistency ?? undefined,
    stressLevel: log?.stressLevel ?? undefined,
    illnessState: log?.illnessState ?? undefined,
    caffeineMg: log?.caffeineMg ?? undefined,
    caffeineTiming: log?.caffeineTiming ?? undefined,
    lateCaffeine: log?.lateCaffeine ?? undefined,
    appetite: log?.appetite ?? undefined,
    notes: log?.notes ?? undefined,
  };
}

function countLabel(value: number | null | undefined): string {
  if (value == null) return '-';
  return value >= 3 ? '3+' : String(value);
}

function activeFactorFromLog(log: DailyLifestyleLog | null): FactorKey {
  if (log?.stressLevel) return 'stress';
  if (log?.lateCaffeine || log?.caffeineTiming || log?.caffeineMg) return 'caffeine';
  if (log?.alcoholLevel || log?.alcoholDrinks || log?.alcoholTiming) return 'alcohol';
  if (log?.bowelMovementCount != null || log?.bowelConsistency) return 'digestion';
  if (log?.illnessState) return 'illness';
  if (log?.appetite) return 'appetite';
  if (log?.cannabisLevel || log?.cannabisTiming) return 'cannabis';
  return 'stress';
}

function factorSummary(key: FactorKey, form: DailyLifestyleLogPayload): string {
  switch (key) {
    case 'alcohol': {
      const level = levelLabel(form.alcoholLevel);
      if (!level && !form.alcoholDrinks) return 'None logged';
      const drinks = form.alcoholDrinks ? ` · ${form.alcoholDrinks} drink${form.alcoholDrinks === 1 ? '' : 's'}` : '';
      return `${level ?? 'Alcohol'}${drinks}`;
    }
    case 'cannabis':
      return levelLabel(form.cannabisLevel) ?? 'None logged';
    case 'caffeine':
      if (!form.caffeineTiming && !form.caffeineMg) return 'None logged';
      return `${form.caffeineTiming ?? 'timing'}${form.caffeineMg ? ` · ${form.caffeineMg}mg` : ''}`;
    case 'digestion':
      if (form.bowelMovementCount == null && !form.bowelConsistency) return 'Not logged';
      return `${countLabel(form.bowelMovementCount)} BM${form.bowelConsistency ? ` · ${form.bowelConsistency}` : ''}`;
    case 'stress':
      return form.stressLevel ?? 'Not logged';
    case 'illness':
      return form.illnessState ? form.illnessState.replace('_', ' ') : 'Not logged';
    case 'appetite':
      return form.appetite ?? 'Not logged';
    default:
      return 'Not logged';
  }
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function todayKey(): string {
  return dateKey(new Date());
}

function normalizeDateKey(value: string | null | undefined): string {
  const key = String(value ?? '').slice(0, 10);
  return DATE_KEY_RE.test(key) ? key : todayKey();
}

function dateFromKey(key: string): Date {
  const [year, month, day] = key.split('-').map(part => Number(part));
  return new Date(year, month - 1, day, 12);
}

function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1, 12);
}

function shiftDateKey(key: string, delta: number): string {
  const date = dateFromKey(key);
  date.setDate(date.getDate() + delta);
  return dateKey(date);
}

function formatDateLabel(key: string): string {
  const today = todayKey();
  if (key === today) return 'Today';
  if (key === shiftDateKey(today, -1)) return 'Yesterday';
  const date = dateFromKey(key);
  const includeYear = date.getFullYear() !== new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(includeYear ? { year: 'numeric' as const } : {}),
  });
}

export default function LifestyleFactorsCard({
  authToken,
  dateISO,
  themeName,
  title = 'Log life events',
  subtitle,
  compact,
  variant = 'card',
  entryImage,
}: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const onPrimary = getContrastingTextColor(tc.primary);
  const baseDateKey = normalizeDateKey(dateISO);
  const [editorDateKey, setEditorDateKey] = useState(baseDateKey);
  const [dateCalendarOpen, setDateCalendarOpen] = useState(false);
  const [datePickerMonth, setDatePickerMonth] = useState(() => monthStart(dateFromKey(baseDateKey)));
  const [open, setOpen] = useState(false);
  const {
    log: baseLog,
    loading: baseLoading,
    pending: basePending,
    reload: reloadBaseLog,
  } = useLifestyleLog(authToken, baseDateKey);
  const {
    log: editorLog,
    saving,
    pending: editorPending,
    save,
  } = useLifestyleLog(authToken, editorDateKey, open);
  const [selectedFactor, setSelectedFactor] = useState<FactorKey>('stress');
  const [form, setForm] = useState<DailyLifestyleLogPayload>({});
  const chips = useMemo(() => summaryChips(baseLog), [baseLog]);
  const editorLogForDate = editorLog?.localDate?.slice(0, 10) === editorDateKey ? editorLog : null;
  const selectedDefinition = useMemo(
    () => LIFESTYLE_FACTORS.find(item => item.key === selectedFactor) ?? LIFESTYLE_FACTORS[0],
    [selectedFactor],
  );
  const dateCalendar = useMemo(() => {
    const today = todayKey();
    const currentMonth = monthStart(dateFromKey(today));
    const activeMonth = monthStart(datePickerMonth);
    const gridStart = new Date(activeMonth);
    gridStart.setDate(activeMonth.getDate() - activeMonth.getDay());
    const cells = Array.from({ length: 42 }, (_, index) => {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + index);
      const key = dateKey(date);
      return {
        date,
        dateKey: key,
        disabled: key > today,
        inMonth: date.getMonth() === activeMonth.getMonth(),
      };
    });
    return {
      cells,
      monthLabel: activeMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
      canGoNext: activeMonth.getTime() < currentMonth.getTime(),
    };
  }, [datePickerMonth]);

  useEffect(() => {
    setEditorDateKey(baseDateKey);
    setDatePickerMonth(monthStart(dateFromKey(baseDateKey)));
  }, [baseDateKey]);

  useEffect(() => {
    if (open) {
      setForm(formFromLog(editorLogForDate));
      setSelectedFactor(activeFactorFromLog(editorLogForDate));
    }
  }, [open, editorDateKey, editorLogForDate]);

  const setField = <K extends keyof DailyLifestyleLogPayload>(key: K, value: DailyLifestyleLogPayload[K]) => {
    setForm(current => {
      const next = { ...current, [key]: value };
      if (key === 'caffeineTiming') {
        next.lateCaffeine = value === 'late' || value === 'evening';
        if (value == null) {
          next.caffeineMg = null;
          next.lateCaffeine = false;
        }
      }
      return next;
    });
  };

  const adjustNumber = (key: 'alcoholDrinks' | 'caffeineMg' | 'bowelMovementCount', delta: number, max: number) => {
    setForm(current => {
      const raw = Number(current[key] ?? 0);
      const next = Math.max(0, Math.min(max, raw + delta));
      return { ...current, [key]: next };
    });
  };

  const selectEditorDate = (key: string) => {
    const today = todayKey();
    const next = normalizeDateKey(key);
    const clamped = next > today ? today : next;
    setEditorDateKey(clamped);
    setDatePickerMonth(monthStart(dateFromKey(clamped)));
  };

  const closeSheet = () => {
    setOpen(false);
    setDateCalendarOpen(false);
    selectEditorDate(baseDateKey);
  };

  const submit = async () => {
    const saved = await save(form);
    if (saved) {
      if (editorDateKey === baseDateKey) {
        await reloadBaseLog().catch(() => undefined);
      }
      if (editorDateKey === todayKey()) {
        const { pushLifestyleToWatch } = await import('../utils/watchSync');
        await pushLifestyleToWatch(saved, { dateISO: editorDateKey, force: true }).catch(() => {});
      }
    }
    closeSheet();
  };

  const photoEntry = variant === 'photo';

  return (
    <>
      <TouchableOpacity
        activeOpacity={0.86}
        onPress={() => {
          selectEditorDate(baseDateKey);
          setOpen(true);
        }}
        style={[
          styles.card,
          variant === 'inline' && styles.inline,
          photoEntry && styles.photoCard,
          compact && styles.compact,
          {
            backgroundColor: variant === 'inline' ? tc.surfaceRaised : tc.surface,
            borderColor: variant === 'inline' ? 'transparent' : tc.border,
          },
        ]}
      >
        {photoEntry ? (
          <ImageBackground
            source={entryImage ?? require('../../assets/images/card-backgrounds/lifestyle-card-caffeine-coffee.jpg')}
            style={styles.photoImage}
            imageStyle={styles.photoImageStyle}
            resizeMode="cover">
            <View style={styles.photoOverlay} />
            <View style={styles.photoContent}>
              <View style={styles.photoIconBubble}>
                <Ionicons name="sparkles-outline" size={18} color="#fff" />
              </View>
              <Text style={styles.photoTitle}>{title}</Text>
              {subtitle ? <Text style={styles.photoSubtitle} numberOfLines={1}>{subtitle}</Text> : null}
              <View style={styles.photoChipRow}>
                {baseLoading ? (
                  <ActivityIndicator size="small" color="rgba(255,255,255,0.86)" />
                ) : chips.length > 0 ? (
                  chips.map(chip => (
                    <View key={chip} style={styles.photoChip}>
                      <Text style={styles.photoChipText} numberOfLines={1}>{chip}</Text>
                    </View>
                  ))
                ) : (
                  <Text style={styles.photoEmpty}>No life events logged</Text>
                )}
                {basePending ? (
                  <View style={styles.photoChip}>
                    <Text style={styles.photoChipText}>Pending</Text>
                  </View>
                ) : null}
              </View>
            </View>
          </ImageBackground>
        ) : (
          <View style={styles.cardHeader}>
            <View style={[styles.iconBubble, { backgroundColor: tc.primary + '18' }]}>
              <Ionicons name="sparkles-outline" size={16} color={tc.primary} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[styles.title, { color: tc.textPrimary }]}>{title}</Text>
              <View style={styles.chipRow}>
                {baseLoading ? (
                  <ActivityIndicator size="small" color={tc.textMuted} />
                ) : chips.length > 0 ? (
                  chips.map(chip => (
                    <View key={chip} style={[styles.chip, { backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}>
                      <Text style={[styles.chipText, { color: tc.textSecondary }]} numberOfLines={1}>{chip}</Text>
                    </View>
                  ))
                ) : (
                  <Text style={[styles.empty, { color: tc.textMuted }]}>No life events logged</Text>
                )}
                {basePending ? (
                  <View style={[styles.chip, { backgroundColor: tc.warning + '18', borderColor: tc.warning + '44' }]}>
                    <Text style={[styles.chipText, { color: tc.warning }]}>Pending</Text>
                  </View>
                ) : null}
              </View>
            </View>
            <Ionicons name="add-circle-outline" size={20} color={tc.primary} />
          </View>
        )}
      </TouchableOpacity>

      <Modal visible={open} animationType="slide" onRequestClose={closeSheet}>
        <SafeAreaView style={[styles.screen, { backgroundColor: tc.background }]}>
          <View style={[styles.screenHeader, { borderBottomColor: tc.border }]}>
            <TouchableOpacity onPress={closeSheet} style={styles.headerIconButton} accessibilityLabel="Close life events">
              <Ionicons name="close" size={22} color={tc.textSecondary} />
            </TouchableOpacity>
            <View style={styles.screenTitleBlock}>
              <Text style={[styles.sheetTitle, { color: tc.textPrimary }]}>{title}</Text>
              <Text style={[styles.screenSubtitle, { color: tc.textMuted }]}>{formatDateLabel(editorDateKey)} · {editorDateKey}</Text>
            </View>
            <TouchableOpacity disabled={saving} onPress={submit} style={[styles.saveButton, { backgroundColor: tc.primary }]}>
              {saving ? (
                <ActivityIndicator size="small" color={onPrimary} />
              ) : (
                <Text style={[styles.saveButtonText, { color: onPrimary }]}>Save</Text>
              )}
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.screenBody} showsVerticalScrollIndicator={false}>
            <View style={[styles.dateSelector, { backgroundColor: tc.surface, borderColor: tc.border }]}>
              <TouchableOpacity
                onPress={() => selectEditorDate(shiftDateKey(editorDateKey, -1))}
                style={[styles.dateArrowButton, { borderColor: tc.border, backgroundColor: tc.surfaceRaised }]}
                accessibilityLabel="Previous day"
              >
                <Ionicons name="chevron-back" size={18} color={tc.textPrimary} />
              </TouchableOpacity>
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={() => setDateCalendarOpen(open => !open)}
                style={[styles.datePill, { borderColor: tc.border, backgroundColor: tc.surfaceRaised }]}
                accessibilityLabel={dateCalendarOpen ? 'Hide life event calendar' : 'Open life event calendar'}
                accessibilityState={{ expanded: dateCalendarOpen }}
              >
                <Ionicons name={dateCalendarOpen ? 'calendar' : 'calendar-outline'} size={16} color={tc.primary} />
                <View style={styles.datePillText}>
                  <Text style={[styles.datePillLabel, { color: tc.textPrimary }]} numberOfLines={1}>{formatDateLabel(editorDateKey)}</Text>
                  <Text style={[styles.datePillSubLabel, { color: tc.textMuted }]} numberOfLines={1}>{editorDateKey}</Text>
                </View>
                {editorPending ? (
                  <View style={[styles.datePendingDot, { backgroundColor: tc.warning }]} />
                ) : null}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => selectEditorDate(shiftDateKey(editorDateKey, 1))}
                style={[
                  styles.dateArrowButton,
                  {
                    borderColor: tc.border,
                    backgroundColor: tc.surfaceRaised,
                    opacity: editorDateKey >= todayKey() ? 0.35 : 1,
                  },
                ]}
                accessibilityLabel="Next day"
                disabled={editorDateKey >= todayKey()}
              >
                <Ionicons name="chevron-forward" size={18} color={tc.textPrimary} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => selectEditorDate(todayKey())}
                disabled={editorDateKey === todayKey()}
                style={[
                  styles.todayButton,
                  {
                    borderColor: tc.border,
                    backgroundColor: editorDateKey === todayKey() ? tc.primary + '18' : tc.surfaceRaised,
                    opacity: editorDateKey === todayKey() ? 0.7 : 1,
                  },
                ]}
                accessibilityLabel="Today"
              >
                <Text style={[styles.todayButtonText, { color: editorDateKey === todayKey() ? tc.primary : tc.textSecondary }]}>Today</Text>
              </TouchableOpacity>
            </View>

            {dateCalendarOpen ? (
              <View style={[styles.dateCalendar, { backgroundColor: tc.surface, borderColor: tc.border }]}>
                <View style={styles.dateCalendarHeader}>
                  <TouchableOpacity
                    style={[styles.dateCalendarNav, { borderColor: tc.border }]}
                    onPress={() => setDatePickerMonth(prev => monthStart(new Date(prev.getFullYear(), prev.getMonth() - 1, 1, 12)))}
                    accessibilityLabel="Previous month"
                  >
                    <Ionicons name="chevron-back" size={18} color={tc.textPrimary} />
                  </TouchableOpacity>
                  <View style={styles.dateCalendarTitle}>
                    <Text style={[styles.dateCalendarMonth, { color: tc.textPrimary }]} numberOfLines={1}>
                      {dateCalendar.monthLabel}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={[styles.dateCalendarNav, { borderColor: tc.border, opacity: dateCalendar.canGoNext ? 1 : 0.35 }]}
                    onPress={() => setDatePickerMonth(prev => monthStart(new Date(prev.getFullYear(), prev.getMonth() + 1, 1, 12)))}
                    disabled={!dateCalendar.canGoNext}
                    accessibilityLabel="Next month"
                  >
                    <Ionicons name="chevron-forward" size={18} color={tc.textPrimary} />
                  </TouchableOpacity>
                </View>
                <View style={styles.dateCalendarWeekdays}>
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
                    <Text key={day} style={[styles.dateCalendarWeekday, { color: tc.textMuted }]}>
                      {day}
                    </Text>
                  ))}
                </View>
                <View style={styles.dateCalendarGrid}>
                  {dateCalendar.cells.map(({ date, dateKey: cellKey, disabled, inMonth }) => {
                    const active = cellKey === editorDateKey;
                    return (
                      <TouchableOpacity
                        key={cellKey}
                        style={[
                          styles.dateCalendarCell,
                          {
                            borderColor: active ? tc.primary : tc.border,
                            backgroundColor: active ? tc.primary + '18' : 'transparent',
                            opacity: disabled ? 0.25 : inMonth ? 1 : 0.48,
                          },
                        ]}
                        onPress={() => {
                          selectEditorDate(cellKey);
                          setDateCalendarOpen(false);
                        }}
                        disabled={disabled}
                        activeOpacity={0.76}
                        accessibilityLabel={`Life event date ${cellKey}`}
                      >
                        <Text style={[styles.dateCalendarDay, { color: active ? tc.primary : tc.textPrimary }]}>
                          {date.getDate()}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            ) : null}

            <View style={styles.factorGrid}>
              {LIFESTYLE_FACTORS.map(item => {
                const selected = item.key === selectedFactor;
                return (
                  <TouchableOpacity
                    key={item.key}
                    activeOpacity={0.88}
                    onPress={() => setSelectedFactor(item.key)}
                    style={[
                      styles.factorCard,
                      { borderColor: selected ? tc.primary : tc.border },
                    ]}
                  >
                    <ImageBackground source={item.image} style={styles.factorImage} imageStyle={styles.factorImageStyle}>
                      <View style={styles.factorImageOverlay} />
                      <View style={styles.factorCardContent}>
                        <View style={styles.factorCardTop}>
                          <View style={[styles.factorIcon, { backgroundColor: selected ? tc.primary : 'rgba(255,255,255,0.18)' }]}>
                            <Ionicons name={item.icon} size={15} color={selected ? onPrimary : '#fff'} />
                          </View>
                          {selected ? <Ionicons name="checkmark-circle" size={18} color="#fff" /> : null}
                        </View>
                        <View>
                          <Text style={styles.factorLabel} numberOfLines={1}>{item.label}</Text>
                          <Text style={styles.factorDesc} numberOfLines={1}>{item.desc}</Text>
                          <Text style={styles.factorSummary} numberOfLines={1}>{factorSummary(item.key, form)}</Text>
                        </View>
                      </View>
                    </ImageBackground>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={[styles.detailPanel, { backgroundColor: tc.surface, borderColor: tc.border }]}>
              <View style={styles.detailHeader}>
                <View style={[styles.iconBubble, { backgroundColor: tc.primary + '18' }]}>
                  <Ionicons name={selectedDefinition.icon} size={16} color={tc.primary} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[styles.detailTitle, { color: tc.textPrimary }]}>{selectedDefinition.label}</Text>
                  <Text style={[styles.detailSubtitle, { color: tc.textMuted }]}>{factorSummary(selectedFactor, form)}</Text>
                </View>
              </View>

              {selectedFactor === 'alcohol' ? (
                <Section title="Alcohol" icon="wine-outline" color={tc.primary} textColor={tc.textPrimary}>
                  <ChoiceGroup choices={DOSE_CHOICES} value={form.alcoholLevel ?? 'none'} onChange={(value) => setField('alcoholLevel', value)} colors={tc} />
                  <Stepper label="Drinks" value={form.alcoholDrinks ?? null} onMinus={() => adjustNumber('alcoholDrinks', -1, 30)} onPlus={() => adjustNumber('alcoholDrinks', 1, 30)} colors={tc} />
                  <ChoiceGroup choices={TIMING_CHOICES} value={form.alcoholTiming ?? null} onChange={(value) => setField('alcoholTiming', value)} colors={tc} />
                </Section>
              ) : null}

              {selectedFactor === 'cannabis' ? (
                <Section title="Cannabis" icon="leaf-outline" color={tc.primary} textColor={tc.textPrimary}>
                  <ChoiceGroup choices={DOSE_CHOICES} value={form.cannabisLevel ?? 'none'} onChange={(value) => setField('cannabisLevel', value)} colors={tc} />
                  <ChoiceGroup choices={TIMING_CHOICES} value={form.cannabisTiming ?? null} onChange={(value) => setField('cannabisTiming', value)} colors={tc} />
                </Section>
              ) : null}

              {selectedFactor === 'caffeine' ? (
                <Section title="Caffeine" icon="cafe-outline" color={tc.primary} textColor={tc.textPrimary}>
                  <ChoiceGroup choices={CAFFEINE_CHOICES} value={form.caffeineTiming ?? null} onChange={(value) => setField('caffeineTiming', value)} colors={tc} />
                  <Stepper label="mg" value={form.caffeineMg ?? null} onMinus={() => adjustNumber('caffeineMg', -50, 1200)} onPlus={() => adjustNumber('caffeineMg', 50, 1200)} colors={tc} />
                </Section>
              ) : null}

              {selectedFactor === 'digestion' ? (
                <Section title="Bowel" icon="pulse-outline" color={tc.primary} textColor={tc.textPrimary}>
                  <Stepper label="Bowel movements" value={form.bowelMovementCount ?? null} formatter={countLabel} onMinus={() => adjustNumber('bowelMovementCount', -1, 10)} onPlus={() => adjustNumber('bowelMovementCount', 1, 10)} colors={tc} />
                  <ChoiceGroup choices={BOWEL_CHOICES} value={form.bowelConsistency ?? null} onChange={(value) => setField('bowelConsistency', value)} colors={tc} />
                </Section>
              ) : null}

              {selectedFactor === 'stress' ? (
                <Section title="Stress" icon="speedometer-outline" color={tc.primary} textColor={tc.textPrimary}>
                  <ChoiceGroup choices={STRESS_CHOICES} value={form.stressLevel ?? null} onChange={(value) => setField('stressLevel', value)} colors={tc} />
                </Section>
              ) : null}

              {selectedFactor === 'illness' ? (
                <Section title="Illness" icon="thermometer-outline" color={tc.primary} textColor={tc.textPrimary}>
                  <ChoiceGroup choices={ILLNESS_CHOICES} value={form.illnessState ?? null} onChange={(value) => setField('illnessState', value)} colors={tc} />
                </Section>
              ) : null}

              {selectedFactor === 'appetite' ? (
                <Section title="Appetite" icon="restaurant-outline" color={tc.primary} textColor={tc.textPrimary}>
                  <ChoiceGroup choices={APPETITE_CHOICES} value={form.appetite ?? null} onChange={(value) => setField('appetite', value)} colors={tc} />
                </Section>
              ) : null}

              <TextInput
                value={form.notes ?? ''}
                onChangeText={(value) => setField('notes', value)}
                placeholder="Optional note"
                placeholderTextColor={tc.textMuted}
                multiline
                maxLength={500}
                style={[styles.notes, { borderColor: tc.border, color: tc.textPrimary, backgroundColor: tc.surfaceRaised }]}
              />
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </>
  );
}

function Section({
  title,
  icon,
  color,
  textColor,
  children,
}: {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  textColor: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Ionicons name={icon} size={15} color={color} />
        <Text style={[styles.sectionTitle, { color: textColor }]}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

function ChoiceGroup<T extends string | null>({
  choices,
  value,
  onChange,
  colors,
}: {
  choices: Choice<T>[];
  value: T;
  onChange: (value: T) => void;
  colors: ReturnType<typeof getTheme>['colors'];
}) {
  const onPrimary = getContrastingTextColor(colors.primary);
  return (
    <View style={styles.segmented}>
      {choices.map(choice => {
        const active = choice.value === value;
        return (
          <TouchableOpacity
            key={`${choice.label}:${choice.value ?? 'null'}`}
            onPress={() => onChange(choice.value)}
            style={[
              styles.segment,
              {
                backgroundColor: active ? colors.primary : colors.surfaceRaised,
                borderColor: active ? colors.primary : colors.border,
              },
            ]}
          >
            <Text style={[styles.segmentText, { color: active ? onPrimary : colors.textSecondary }]} numberOfLines={1}>
              {choice.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function Stepper({
  label,
  value,
  onMinus,
  onPlus,
  colors,
  formatter,
}: {
  label: string;
  value: number | null;
  onMinus: () => void;
  onPlus: () => void;
  colors: ReturnType<typeof getTheme>['colors'];
  formatter?: (value: number | null | undefined) => string;
}) {
  return (
    <View style={[styles.stepper, { borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
      <Text style={[styles.stepperLabel, { color: colors.textMuted }]}>{label}</Text>
      <View style={styles.stepperControls}>
        <TouchableOpacity onPress={onMinus} style={[styles.stepperButton, { borderColor: colors.border }]} accessibilityLabel={`${label} decrease`}>
          <Ionicons name="remove" size={15} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={[styles.stepperValue, { color: colors.textPrimary }]}>{formatter ? formatter(value) : value ?? '-'}</Text>
        <TouchableOpacity onPress={onPlus} style={[styles.stepperButton, { borderColor: colors.border }]} accessibilityLabel={`${label} increase`}>
          <Ionicons name="add" size={15} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: 12,
    marginBottom: 12,
  },
  inline: {
    marginBottom: 10,
    borderWidth: 0,
  },
  compact: {
    padding: 10,
  },
  photoCard: {
    padding: 0,
    minHeight: 124,
    overflow: 'hidden',
    borderRadius: 14,
  },
  photoImage: {
    minHeight: 124,
    justifyContent: 'center',
  },
  photoImageStyle: {
    borderRadius: 13,
  },
  photoOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.48)',
  },
  photoContent: {
    minHeight: 124,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14,
    gap: 6,
  },
  photoIconBubble: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  photoTitle: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '900',
  },
  photoSubtitle: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 11,
    fontWeight: '700',
  },
  photoChipRow: {
    minHeight: 20,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  photoChip: {
    maxWidth: '100%',
    borderWidth: 1,
    borderRadius: 7,
    paddingHorizontal: 7,
    paddingVertical: 3,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderColor: 'rgba(255,255,255,0.24)',
  },
  photoChipText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
  },
  photoEmpty: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 10,
    fontWeight: '800',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconBubble: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 13,
    fontWeight: '900',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 5,
    marginTop: 5,
  },
  chip: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  chipText: {
    fontSize: 10,
    fontWeight: '800',
  },
  empty: {
    fontSize: 11,
    fontWeight: '600',
  },
  screen: {
    flex: 1,
  },
  screenHeader: {
    minHeight: 58,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerIconButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  screenTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  screenSubtitle: {
    fontSize: 11,
    fontWeight: '700',
    marginTop: 2,
  },
  saveButton: {
    minWidth: 70,
    minHeight: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  saveButtonText: {
    fontSize: 13,
    fontWeight: '900',
  },
  screenBody: {
    padding: 14,
    paddingBottom: 28,
    gap: 14,
  },
  dateSelector: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dateArrowButton: {
    width: 38,
    height: 40,
    borderWidth: 1,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  datePill: {
    flex: 1,
    minWidth: 0,
    minHeight: 40,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  datePillText: {
    flex: 1,
    minWidth: 0,
  },
  datePillLabel: {
    fontSize: 12,
    fontWeight: '900',
  },
  datePillSubLabel: {
    fontSize: 10,
    fontWeight: '700',
    marginTop: 1,
  },
  datePendingDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  todayButton: {
    minWidth: 58,
    height: 40,
    borderWidth: 1,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 9,
  },
  todayButtonText: {
    fontSize: 11,
    fontWeight: '900',
  },
  dateCalendar: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    gap: 9,
  },
  dateCalendarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  dateCalendarNav: {
    width: 36,
    height: 36,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dateCalendarTitle: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
  },
  dateCalendarMonth: {
    fontSize: 14,
    fontWeight: '900',
  },
  dateCalendarWeekdays: {
    flexDirection: 'row',
  },
  dateCalendarWeekday: {
    width: '14.2857%',
    textAlign: 'center',
    fontSize: 10,
    fontWeight: '900',
  },
  dateCalendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  dateCalendarCell: {
    width: '14.2857%',
    aspectRatio: 1,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dateCalendarDay: {
    fontSize: 13,
    fontWeight: '900',
  },
  factorGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  factorCard: {
    width: '48%',
    minHeight: 132,
    borderWidth: 2,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#111',
  },
  factorImage: {
    flex: 1,
    minHeight: 132,
  },
  factorImageStyle: {
    borderRadius: 6,
  },
  factorImageOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
  factorCardContent: {
    flex: 1,
    minHeight: 132,
    padding: 10,
    justifyContent: 'space-between',
  },
  factorCardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  factorIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  factorLabel: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '900',
  },
  factorDesc: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 10,
    fontWeight: '800',
    marginTop: 2,
  },
  factorSummary: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '900',
    marginTop: 7,
  },
  detailPanel: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    gap: 12,
  },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  detailTitle: {
    fontSize: 15,
    fontWeight: '900',
  },
  detailSubtitle: {
    fontSize: 11,
    fontWeight: '700',
    marginTop: 2,
    textTransform: 'capitalize',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    maxHeight: '88%',
    borderTopLeftRadius: radius.sm,
    borderTopRightRadius: radius.sm,
    borderWidth: 1,
    overflow: 'hidden',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: '900',
  },
  closeButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetBody: {
    paddingHorizontal: 16,
    paddingBottom: 14,
    gap: 13,
  },
  section: {
    gap: 8,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '900',
  },
  segmented: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
  },
  segment: {
    minHeight: 34,
    minWidth: 62,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentText: {
    fontSize: 11,
    fontWeight: '900',
  },
  stepper: {
    borderWidth: 1,
    borderRadius: 6,
    minHeight: 40,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  stepperLabel: {
    fontSize: 11,
    fontWeight: '800',
  },
  stepperControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  stepperButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperValue: {
    width: 42,
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '900',
  },
  notes: {
    minHeight: 56,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 12,
    fontWeight: '600',
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 10,
    padding: 12,
  },
  footerButton: {
    flex: 1,
    minHeight: 42,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButton: {
    borderWidth: 1,
  },
  footerButtonText: {
    fontSize: 13,
    fontWeight: '900',
  },
});
