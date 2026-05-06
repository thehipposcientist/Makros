// Centralized settings hub.
//
// Lives outside the Account modal so it has room for future preferences
// (notifications, units, language, accessibility) without bloating the
// Account chrome. Mounted as a full-screen modal from the existing Account
// surface — keeps the navigation graph flat.

import { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Switch, Alert, StyleSheet, Platform, Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { APP_THEMES, THEME_PICKER_ORDER, getContrastingTextColor, getTheme, radius, resolveThemeName } from '../constants/theme';
import { AppThemeName, UserProfile } from '../types';
import {
  loadReminderSettings, saveReminderSettings, type ReminderSettings,
} from '../utils/workoutReminders';
import {
  loadMealReminderSettings, saveMealReminderSettings, type MealReminderSettings,
} from '../utils/mealReminders';
import {
  loadQuietHours, saveQuietHours, type QuietHoursSettings,
} from '../utils/notificationPrefs';
import type { WeightUnit, DistanceUnit } from '../utils/units';
import { configureExpandAnimation } from '../utils/layoutAnim';

interface Props {
  visible: boolean;
  profile: UserProfile;
  themeName?: AppThemeName;
  /** Auth token — passed in so the Plan Pause section can hit the
   *  pause/resume endpoints. Optional because the Settings screen also
   *  renders correctly for anonymous / not-yet-signed-in callers. */
  authToken?: string | null;
  onClose: () => void;
  onSignOut?: () => void;
  /** Persist a partial profile update. Same signature the parent uses
   *  for other preference toggles so we don't introduce a new path. */
  onProfileUpdate: (changes: Partial<UserProfile>, skipRegen?: boolean) => void;
}

const COLLAPSED_THEME_COUNT = 9;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatTime(hour: number, minute: number): string {
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const am = hour < 12;
  return `${h12}:${pad2(minute)} ${am ? 'AM' : 'PM'}`;
}

function e2eId(value: string | number | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function openDeviceSettings() {
  try {
    if (Platform.OS === 'ios') {
      await Linking.openURL('app-settings:');
      return;
    }
    await Linking.openSettings();
  } catch {
    Alert.alert(
      'Unable to open Settings',
      Platform.OS === 'ios'
        ? 'Open iPhone Settings -> Privacy & Security -> Health -> Thallo manually.'
        : 'Open device Settings and choose Thallo manually.',
    );
  }
}

export default function SettingsScreen({ visible, profile, themeName, authToken, onClose, onSignOut, onProfileUpdate }: Props) {
  const insets = useSafeAreaInsets();
  const tc = getTheme(themeName).colors;
  const bottomNavClearance = Math.max(insets.bottom, 10) + 78;

  const [workoutReminder, setWorkoutReminder] = useState<ReminderSettings>({ enabled: false, hour: 8, minute: 0 });
  const [mealReminder, setMealReminder] = useState<MealReminderSettings>({ enabled: true, hour: 21, minute: 0 });
  const [quietHours, setQuietHours] = useState<QuietHoursSettings>({ enabled: false, startHour: 22, endHour: 7 });
  const [pausedUntil, setPausedUntil] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [themesExpanded, setThemesExpanded] = useState(false);

  // Load reminder settings on every open so toggles reflect actual stored
  // state — important because reminders can also be modified during
  // workouts (rest-timer notifs share permission state).
  useEffect(() => {
    if (!visible) return;
    (async () => {
      try {
        const [wr, mr, qh] = await Promise.all([
          loadReminderSettings(),
          loadMealReminderSettings(),
          loadQuietHours(),
        ]);
        setWorkoutReminder(wr);
        setMealReminder(mr);
        setQuietHours(qh);
      } catch {}
      // Surface the active plan's pause status, if any. Best-effort —
      // a 404 / network glitch just leaves the section showing "Not paused".
      if (authToken) {
        try {
          const { getActivePlanWeek } = await import('../services/api');
          const pw = await getActivePlanWeek(authToken);
          setPausedUntil(pw?.paused_until ?? null);
        } catch {}
      }
    })();
  }, [visible, authToken]);

  if (!visible) return null;

  const weightUnit: WeightUnit = profile.weightUnit ?? 'lbs';
  const distanceUnit: DistanceUnit = profile.distanceUnit ?? 'mi';
  const currentTheme = resolveThemeName(profile.themePreference ?? themeName);
  const collapsedThemeKeys: AppThemeName[] = [];
  for (const key of [currentTheme, ...THEME_PICKER_ORDER]) {
    if (!collapsedThemeKeys.includes(key)) collapsedThemeKeys.push(key);
    if (collapsedThemeKeys.length >= COLLAPSED_THEME_COUNT) break;
  }
  const themeKeys = themesExpanded ? THEME_PICKER_ORDER : collapsedThemeKeys;
  const canCollapseThemes = THEME_PICKER_ORDER.length > COLLAPSED_THEME_COUNT;

  const updateWorkoutReminder = async (next: ReminderSettings) => {
    setWorkoutReminder(next);
    setLoading(true);
    try {
      await saveReminderSettings(next);
    } catch (e: any) {
      Alert.alert('Could not update', e?.message ?? 'Try again.');
    } finally {
      setLoading(false);
    }
  };

  const updateMealReminder = async (next: MealReminderSettings) => {
    setMealReminder(next);
    setLoading(true);
    try {
      await saveMealReminderSettings(next);
    } catch (e: any) {
      Alert.alert('Could not update', e?.message ?? 'Try again.');
    } finally {
      setLoading(false);
    }
  };

  const updateQuietHours = async (next: QuietHoursSettings) => {
    setQuietHours(next);
    setLoading(true);
    try {
      await saveQuietHours(next);
      // Re-run the active reminder schedulers so the change takes effect
      // immediately — the schedulers consult quiet-hours when scheduling.
      if (workoutReminder.enabled) await saveReminderSettings(workoutReminder);
      if (mealReminder.enabled) await saveMealReminderSettings(mealReminder);
    } catch (e: any) {
      Alert.alert('Could not update', e?.message ?? 'Try again.');
    } finally {
      setLoading(false);
    }
  };

  // Time picker — minimal three-button hour stepper. Avoids a heavy
  // DateTimePicker dep for what's a once-off configuration. Steps in
  // 15-minute increments which matches how users describe reminder times
  // anyway ("around 8am", not "8:07am").
  const stepTime = (hour: number, minute: number, deltaMinutes: number): { hour: number; minute: number } => {
    const total = (hour * 60 + minute + deltaMinutes + 24 * 60) % (24 * 60);
    return { hour: Math.floor(total / 60), minute: total % 60 };
  };

  const toggleThemesExpanded = () => {
    configureExpandAnimation(240);
    setThemesExpanded(v => !v);
  };

  return (
    <View
      testID="settings-screen"
      accessibilityLabel="settings-screen"
      style={[styles.root, { backgroundColor: tc.background, bottom: bottomNavClearance }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 12, borderBottomColor: tc.border }]}>
        <TouchableOpacity
          testID="settings-back"
          accessibilityLabel="settings-back"
          onPress={onClose}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={26} color={tc.textPrimary} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: tc.textPrimary }]}>Settings</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>

        {/* ── Appearance ────────────────────────────────────────────── */}
        <View style={styles.sectionHeaderRow}>
          <Text style={[styles.sectionLabel, styles.sectionLabelInline, { color: tc.textMuted }]}>APPEARANCE</Text>
          {canCollapseThemes && (
            <TouchableOpacity
              testID="settings-themes-toggle"
              accessibilityLabel="settings-themes-toggle"
              onPress={toggleThemesExpanded}
              activeOpacity={0.75}
              style={[styles.themeToggle, { backgroundColor: tc.surface, borderColor: tc.border }]}>
              <Text style={[styles.themeToggleText, { color: tc.primary }]}>
                {themesExpanded ? 'Show fewer' : 'Show all'}
              </Text>
              <Ionicons
                name={themesExpanded ? 'chevron-up' : 'chevron-down'}
                size={13}
                color={tc.primary}
              />
            </TouchableOpacity>
          )}
        </View>
        <View style={[styles.card, { backgroundColor: tc.surface, borderColor: tc.border }]}>
          <View style={styles.themeGrid}>
            {themeKeys.map((key) => {
              const theme = APP_THEMES[key];
              const active = currentTheme === key;
              return (
                <TouchableOpacity
                  key={key}
                  testID={`settings-theme-${e2eId(key)}`}
                  accessibilityLabel={`settings-theme-${e2eId(key)}`}
                  onPress={() => onProfileUpdate({ themePreference: key } as Partial<UserProfile>, true)}
                  activeOpacity={0.8}
                  style={[
                    styles.themeTile,
                    {
                      backgroundColor: tc.surfaceRaised,
                      borderColor: active ? theme.colors.primary : tc.border,
                      borderWidth: active ? 2 : 1,
                    },
                  ]}>
                  <View style={[styles.themeSwatch, { borderColor: theme.colors.border }]}>
                    <View style={{ flex: 1, backgroundColor: theme.colors.background }} />
                    <View style={{ flex: 1, backgroundColor: theme.colors.surfaceRaised }} />
                    <View style={{ flex: 1, backgroundColor: theme.colors.primary }} />
                    <View style={{ flex: 1, backgroundColor: theme.colors.accent }} />
                  </View>
                  <Text numberOfLines={2} style={[styles.themeLabel, { color: tc.textPrimary }]}>
                    {theme.label}
                  </Text>
                  {active && (
                    <Ionicons
                      name="checkmark-circle"
                      size={15}
                      color={theme.colors.primary}
                      style={styles.themeCheck}
                    />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* ── Notifications ─────────────────────────────────────────── */}
        <Text style={[styles.sectionLabel, { color: tc.textMuted }]}>NOTIFICATIONS</Text>
        <View style={[styles.card, { backgroundColor: tc.surface, borderColor: tc.border }]}>
          {/* Workout reminder */}
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowTitle, { color: tc.textPrimary }]}>Workout reminders</Text>
              <Text style={[styles.rowSub, { color: tc.textMuted }]}>
                A nudge on your training days at the time you set.
              </Text>
            </View>
            <Switch
              testID="settings-workout-reminders-toggle"
              value={workoutReminder.enabled}
              onValueChange={(v) => updateWorkoutReminder({ ...workoutReminder, enabled: v })}
              disabled={loading}
              trackColor={{ false: tc.border, true: tc.primary }}
            />
          </View>
          {workoutReminder.enabled && (
            <View style={[styles.timeRow, { borderTopColor: tc.border }]}>
              <Text style={[styles.rowSub, { color: tc.textSecondary }]}>Remind me at</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <TouchableOpacity
                  testID="settings-workout-reminder-time-minus"
                  accessibilityLabel="settings-workout-reminder-time-minus"
                  onPress={() => {
                    const { hour, minute } = stepTime(workoutReminder.hour, workoutReminder.minute, -15);
                    updateWorkoutReminder({ ...workoutReminder, hour, minute });
                  }}
                  style={[styles.timeBtn, { borderColor: tc.border }]}>
                  <Ionicons name="remove" size={16} color={tc.textSecondary} />
                </TouchableOpacity>
                <Text style={[styles.timeValue, { color: tc.textPrimary }]}>
                  {formatTime(workoutReminder.hour, workoutReminder.minute)}
                </Text>
                <TouchableOpacity
                  testID="settings-workout-reminder-time-plus"
                  accessibilityLabel="settings-workout-reminder-time-plus"
                  onPress={() => {
                    const { hour, minute } = stepTime(workoutReminder.hour, workoutReminder.minute, 15);
                    updateWorkoutReminder({ ...workoutReminder, hour, minute });
                  }}
                  style={[styles.timeBtn, { borderColor: tc.border }]}>
                  <Ionicons name="add" size={16} color={tc.textSecondary} />
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Meal log reminder */}
          <View style={[styles.row, { borderTopColor: tc.border, borderTopWidth: 1, paddingTop: 14, marginTop: 6 }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowTitle, { color: tc.textPrimary }]}>Meal log reminder</Text>
              <Text style={[styles.rowSub, { color: tc.textMuted }]}>
                Evening nudge if today's meals aren't logged yet.
              </Text>
            </View>
            <Switch
              testID="settings-meal-reminder-toggle"
              value={mealReminder.enabled}
              onValueChange={(v) => updateMealReminder({ ...mealReminder, enabled: v })}
              disabled={loading}
              trackColor={{ false: tc.border, true: tc.primary }}
            />
          </View>
          {mealReminder.enabled && (
            <View style={[styles.timeRow, { borderTopColor: tc.border }]}>
              <Text style={[styles.rowSub, { color: tc.textSecondary }]}>Remind me at</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <TouchableOpacity
                  testID="settings-meal-reminder-time-minus"
                  accessibilityLabel="settings-meal-reminder-time-minus"
                  onPress={() => {
                    const { hour, minute } = stepTime(mealReminder.hour, mealReminder.minute, -15);
                    updateMealReminder({ ...mealReminder, hour, minute });
                  }}
                  style={[styles.timeBtn, { borderColor: tc.border }]}>
                  <Ionicons name="remove" size={16} color={tc.textSecondary} />
                </TouchableOpacity>
                <Text style={[styles.timeValue, { color: tc.textPrimary }]}>
                  {formatTime(mealReminder.hour, mealReminder.minute)}
                </Text>
                <TouchableOpacity
                  testID="settings-meal-reminder-time-plus"
                  accessibilityLabel="settings-meal-reminder-time-plus"
                  onPress={() => {
                    const { hour, minute } = stepTime(mealReminder.hour, mealReminder.minute, 15);
                    updateMealReminder({ ...mealReminder, hour, minute });
                  }}
                  style={[styles.timeBtn, { borderColor: tc.border }]}>
                  <Ionicons name="add" size={16} color={tc.textSecondary} />
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Quiet hours — global do-not-disturb window for workout + meal
              reminders. Rest-timer notifications stay active during a live
              workout regardless (user-initiated). When enabled, any reminder
              whose configured time falls inside the window is suppressed. */}
          <View style={[styles.row, { borderTopColor: tc.border, borderTopWidth: 1, paddingTop: 14, marginTop: 6 }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowTitle, { color: tc.textPrimary }]}>Quiet hours</Text>
              <Text style={[styles.rowSub, { color: tc.textMuted }]}>
                Silence reminders during this window. Rest-timer alerts mid-workout still fire.
              </Text>
            </View>
            <Switch
              testID="settings-quiet-hours-toggle"
              value={quietHours.enabled}
              onValueChange={(v) => updateQuietHours({ ...quietHours, enabled: v })}
              disabled={loading}
              trackColor={{ false: tc.border, true: tc.primary }}
            />
          </View>
          {quietHours.enabled && (
            <>
              <View style={[styles.timeRow, { borderTopColor: tc.border }]}>
                <Text style={[styles.rowSub, { color: tc.textSecondary }]}>Start (quiet from)</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <TouchableOpacity
                    testID="settings-quiet-start-minus"
                    accessibilityLabel="settings-quiet-start-minus"
                    onPress={() => updateQuietHours({ ...quietHours, startHour: (quietHours.startHour + 23) % 24 })}
                    style={[styles.timeBtn, { borderColor: tc.border }]}>
                    <Ionicons name="remove" size={16} color={tc.textSecondary} />
                  </TouchableOpacity>
                  <Text style={[styles.timeValue, { color: tc.textPrimary }]}>
                    {formatTime(quietHours.startHour, 0)}
                  </Text>
                  <TouchableOpacity
                    testID="settings-quiet-start-plus"
                    accessibilityLabel="settings-quiet-start-plus"
                    onPress={() => updateQuietHours({ ...quietHours, startHour: (quietHours.startHour + 1) % 24 })}
                    style={[styles.timeBtn, { borderColor: tc.border }]}>
                    <Ionicons name="add" size={16} color={tc.textSecondary} />
                  </TouchableOpacity>
                </View>
              </View>
              <View style={[styles.timeRow, { borderTopColor: tc.border }]}>
                <Text style={[styles.rowSub, { color: tc.textSecondary }]}>End (quiet until)</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <TouchableOpacity
                    testID="settings-quiet-end-minus"
                    accessibilityLabel="settings-quiet-end-minus"
                    onPress={() => updateQuietHours({ ...quietHours, endHour: (quietHours.endHour + 23) % 24 })}
                    style={[styles.timeBtn, { borderColor: tc.border }]}>
                    <Ionicons name="remove" size={16} color={tc.textSecondary} />
                  </TouchableOpacity>
                  <Text style={[styles.timeValue, { color: tc.textPrimary }]}>
                    {formatTime(quietHours.endHour, 0)}
                  </Text>
                  <TouchableOpacity
                    testID="settings-quiet-end-plus"
                    accessibilityLabel="settings-quiet-end-plus"
                    onPress={() => updateQuietHours({ ...quietHours, endHour: (quietHours.endHour + 1) % 24 })}
                    style={[styles.timeBtn, { borderColor: tc.border }]}>
                    <Ionicons name="add" size={16} color={tc.textSecondary} />
                  </TouchableOpacity>
                </View>
              </View>
            </>
          )}
        </View>

        {/* ── Units ─────────────────────────────────────────────────── */}
        <Text style={[styles.sectionLabel, { color: tc.textMuted }]}>UNITS</Text>
        <View style={[styles.card, { backgroundColor: tc.surface, borderColor: tc.border }]}>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowTitle, { color: tc.textPrimary }]}>Body weight</Text>
              <Text style={[styles.rowSub, { color: tc.textMuted }]}>
                Display preference. Storage stays in lbs internally.
              </Text>
            </View>
            <View style={[styles.toggle, { borderColor: tc.border }]}>
              {(['lbs', 'kg'] as WeightUnit[]).map((u) => {
                const active = weightUnit === u;
                return (
                  <TouchableOpacity
                    key={u}
                    testID={`settings-weight-unit-${u}`}
                    accessibilityLabel={`settings-weight-unit-${u}`}
                    onPress={() => onProfileUpdate({ weightUnit: u } as Partial<UserProfile>, true)}
                    style={[
                      styles.toggleOpt,
                      active && { backgroundColor: tc.primary },
                    ]}>
                    <Text style={[
                      styles.toggleOptText,
                      { color: active ? getContrastingTextColor(tc.primary) : tc.textSecondary },
                    ]}>{u}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={[styles.row, { borderTopColor: tc.border, borderTopWidth: 1, paddingTop: 14, marginTop: 6 }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowTitle, { color: tc.textPrimary }]}>Distance</Text>
              <Text style={[styles.rowSub, { color: tc.textMuted }]}>
                Used for cardio mileage and gear lifespan tracking.
              </Text>
            </View>
            <View style={[styles.toggle, { borderColor: tc.border }]}>
              {(['mi', 'km'] as DistanceUnit[]).map((u) => {
                const active = distanceUnit === u;
                return (
                  <TouchableOpacity
                    key={u}
                    testID={`settings-distance-unit-${u}`}
                    accessibilityLabel={`settings-distance-unit-${u}`}
                    onPress={() => onProfileUpdate({ distanceUnit: u } as Partial<UserProfile>, true)}
                    style={[
                      styles.toggleOpt,
                      active && { backgroundColor: tc.primary },
                    ]}>
                    <Text style={[
                      styles.toggleOptText,
                      { color: active ? getContrastingTextColor(tc.primary) : tc.textSecondary },
                    ]}>{u}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </View>

        <Text style={{ fontSize: 11, color: tc.textMuted, lineHeight: 16, marginTop: 4, paddingHorizontal: 4 }}>
          Unit changes apply to display only — your underlying training history isn't re-converted, so charts and PRs stay continuous.
        </Text>

        {/* ── Plan pause ─────────────────────────────────────────────── */}
        {authToken && (
          <>
            <Text style={[styles.sectionLabel, { color: tc.textMuted, marginTop: 24 }]}>PLAN</Text>
            <View style={[styles.card, { backgroundColor: tc.surface, borderColor: tc.border }]}>
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.rowTitle, { color: tc.textPrimary }]}>
                    {pausedUntil ? `Paused until ${pausedUntil}` : 'Pause plan'}
                  </Text>
                  <Text style={[styles.rowSub, { color: tc.textMuted }]}>
                    {pausedUntil
                      ? 'Auto-renew, auto-skip, and reminders are suspended. Streak protected.'
                      : 'Travel or sick? Suspend the plan so missed days don\'t mark as skipped.'}
                  </Text>
                </View>
                <TouchableOpacity
                  testID="settings-plan-pause"
                  accessibilityLabel="settings-plan-pause"
                  disabled={loading}
                  onPress={async () => {
                    setLoading(true);
                    try {
                      const api = await import('../services/api');
                      if (pausedUntil) {
                        const pw = await api.resumePlanWeek(authToken);
                        setPausedUntil(pw.paused_until ?? null);
                      } else {
                        // Quick presets — keep the modal-free UX. Default = 7 days.
                        const choice = await new Promise<number | null>((resolve) => {
                          Alert.alert(
                            'Pause plan',
                            'How long?',
                            [
                              { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
                              { text: '3 days', onPress: () => resolve(3) },
                              { text: '7 days', onPress: () => resolve(7) },
                              { text: '14 days', onPress: () => resolve(14) },
                            ],
                          );
                        });
                        if (choice == null) { setLoading(false); return; }
                        const target = new Date();
                        target.setDate(target.getDate() + choice);
                        const iso = target.toISOString().slice(0, 10);
                        const pw = await api.pausePlanWeek(authToken, { paused_until: iso, reason: 'other' });
                        setPausedUntil(pw.paused_until ?? null);
                      }
                    } catch (e: any) {
                      Alert.alert('Could not update', e?.message ?? 'Try again.');
                    } finally {
                      setLoading(false);
                    }
                  }}
                  style={{
                    paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8,
                    backgroundColor: pausedUntil ? tc.primary : tc.surface,
                    borderWidth: 1, borderColor: pausedUntil ? tc.primary : tc.border,
                  }}>
                  <Text style={{ fontSize: 12, fontWeight: '800', color: pausedUntil ? '#fff' : tc.textPrimary }}>
                    {pausedUntil ? 'Resume' : 'Pause'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </>
        )}

        {/* ── Permissions footer ────────────────────────────────────── */}
        <Text style={[styles.sectionLabel, { color: tc.textMuted, marginTop: 24 }]}>PERMISSIONS</Text>
        <View style={[styles.card, { backgroundColor: tc.surface, borderColor: tc.border }]}>
          <TouchableOpacity
            testID="settings-open-device-settings"
            accessibilityLabel="settings-open-device-settings"
            style={styles.row}
            onPress={openDeviceSettings}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowTitle, { color: tc.textPrimary }]}>Open iOS Settings</Text>
              <Text style={[styles.rowSub, { color: tc.textMuted }]}>
                Manage notifications, Apple Health, camera, microphone, and Face ID for Thallo.
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={tc.textMuted} />
          </TouchableOpacity>
        </View>

        {onSignOut && (
          <>
            <Text style={[styles.sectionLabel, { color: tc.textMuted, marginTop: 24 }]}>ACCOUNT</Text>
            <TouchableOpacity
              testID="settings-sign-out"
              accessibilityLabel="settings-sign-out"
              activeOpacity={0.82}
              onPress={() => {
                Alert.alert(
                  'Sign out?',
                  'You will need to sign back in to see your plan and progress.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Sign out',
                      style: 'destructive',
                      onPress: () => {
                        onClose();
                        onSignOut();
                      },
                    },
                  ],
                );
              }}
              style={[styles.signOutButton, { backgroundColor: tc.surface, borderColor: tc.error + '66' }]}>
              <Ionicons name="log-out-outline" size={18} color={tc.error} />
              <Text style={[styles.signOutText, { color: tc.error }]}>Sign Out</Text>
            </TouchableOpacity>
          </>
        )}

        <Text style={{ fontSize: 10, color: tc.textMuted, textAlign: 'center', marginTop: 28 }}>
          Thallo · v1.0 · {Platform.OS === 'ios' ? 'iOS' : 'Android'}
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 18, fontWeight: '800', letterSpacing: -0.3 },
  sectionLabel: {
    fontSize: 11, fontWeight: '700', letterSpacing: 1.0,
    marginTop: 12, marginBottom: 8, paddingHorizontal: 4,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  sectionLabelInline: {
    marginTop: 0,
    marginBottom: 0,
    paddingHorizontal: 0,
  },
  card: {
    borderRadius: radius.lg, borderWidth: 1, padding: 14,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: 12,
  },
  rowTitle: { fontSize: 14, fontWeight: '700' },
  rowSub: { fontSize: 11, marginTop: 2, lineHeight: 15 },
  signOutButton: {
    minHeight: 52,
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  signOutText: { fontSize: 14, fontWeight: '800' },
  timeRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 10, marginTop: 10, borderTopWidth: 1,
  },
  timeBtn: {
    width: 30, height: 30, borderRadius: 15, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  timeValue: { fontSize: 14, fontWeight: '800', minWidth: 80, textAlign: 'center' },
  toggle: {
    flexDirection: 'row', borderWidth: 1, borderRadius: 16, overflow: 'hidden',
  },
  toggleOpt: {
    paddingHorizontal: 14, paddingVertical: 7,
  },
  toggleOptText: {
    fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4,
  },
  themeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  themeToggle: {
    minHeight: 28,
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  themeToggleText: {
    fontSize: 11,
    fontWeight: '800',
  },
  themeTile: {
    width: '30.9%',
    minHeight: 92,
    borderRadius: radius.md,
    padding: 9,
    position: 'relative',
  },
  themeSwatch: {
    height: 34,
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
    flexDirection: 'row',
    marginBottom: 7,
  },
  themeLabel: {
    flexShrink: 1,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '800',
  },
  themeCheck: {
    position: 'absolute',
    top: 5,
    right: 5,
  },
});
