// Centralized settings hub.
//
// Lives outside the Account modal so it has room for future preferences
// (notifications, units, language, accessibility) without bloating the
// Account chrome. Mounted as a full-screen modal from the existing Account
// surface — keeps the navigation graph flat.

import { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Switch, Alert, StyleSheet, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName, UserProfile } from '../types';
import {
  loadReminderSettings, saveReminderSettings, type ReminderSettings,
} from '../utils/workoutReminders';
import {
  loadMealReminderSettings, saveMealReminderSettings, type MealReminderSettings,
} from '../utils/mealReminders';
import type { WeightUnit, DistanceUnit } from '../utils/units';

interface Props {
  visible: boolean;
  profile: UserProfile;
  themeName?: AppThemeName;
  onClose: () => void;
  /** Persist a partial profile update. Same signature the parent uses
   *  for other preference toggles so we don't introduce a new path. */
  onProfileUpdate: (changes: Partial<UserProfile>, skipRegen?: boolean) => void;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatTime(hour: number, minute: number): string {
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const am = hour < 12;
  return `${h12}:${pad2(minute)} ${am ? 'AM' : 'PM'}`;
}

export default function SettingsScreen({ visible, profile, themeName, onClose, onProfileUpdate }: Props) {
  const insets = useSafeAreaInsets();
  const tc = getTheme(themeName).colors;

  const [workoutReminder, setWorkoutReminder] = useState<ReminderSettings>({ enabled: false, hour: 8, minute: 0 });
  const [mealReminder, setMealReminder] = useState<MealReminderSettings>({ enabled: true, hour: 21, minute: 0 });
  const [loading, setLoading] = useState(false);

  // Load reminder settings on every open so toggles reflect actual stored
  // state — important because reminders can also be modified during
  // workouts (rest-timer notifs share permission state).
  useEffect(() => {
    if (!visible) return;
    (async () => {
      try {
        const [wr, mr] = await Promise.all([
          loadReminderSettings(),
          loadMealReminderSettings(),
        ]);
        setWorkoutReminder(wr);
        setMealReminder(mr);
      } catch {}
    })();
  }, [visible]);

  if (!visible) return null;

  const weightUnit: WeightUnit = profile.weightUnit ?? 'lbs';
  const distanceUnit: DistanceUnit = profile.distanceUnit ?? 'mi';

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

  // Time picker — minimal three-button hour stepper. Avoids a heavy
  // DateTimePicker dep for what's a once-off configuration. Steps in
  // 15-minute increments which matches how users describe reminder times
  // anyway ("around 8am", not "8:07am").
  const stepTime = (hour: number, minute: number, deltaMinutes: number): { hour: number; minute: number } => {
    const total = (hour * 60 + minute + deltaMinutes + 24 * 60) % (24 * 60);
    return { hour: Math.floor(total / 60), minute: total % 60 };
  };

  return (
    <View style={[styles.root, { backgroundColor: tc.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 12, borderBottomColor: tc.border }]}>
        <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={26} color={tc.textPrimary} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: tc.textPrimary }]}>Settings</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>

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
                    onPress={() => onProfileUpdate({ weightUnit: u } as Partial<UserProfile>, true)}
                    style={[
                      styles.toggleOpt,
                      active && { backgroundColor: tc.primary },
                    ]}>
                    <Text style={[
                      styles.toggleOptText,
                      { color: active ? '#fff' : tc.textSecondary },
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
                    onPress={() => onProfileUpdate({ distanceUnit: u } as Partial<UserProfile>, true)}
                    style={[
                      styles.toggleOpt,
                      active && { backgroundColor: tc.primary },
                    ]}>
                    <Text style={[
                      styles.toggleOptText,
                      { color: active ? '#fff' : tc.textSecondary },
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

        {/* ── Permissions footer ────────────────────────────────────── */}
        <Text style={[styles.sectionLabel, { color: tc.textMuted, marginTop: 24 }]}>PERMISSIONS</Text>
        <View style={[styles.card, { backgroundColor: tc.surface, borderColor: tc.border }]}>
          <TouchableOpacity
            style={styles.row}
            onPress={() => {
              import('react-native').then(({ Linking }) => Linking.openSettings()).catch(() => {});
            }}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowTitle, { color: tc.textPrimary }]}>Open iOS Settings</Text>
              <Text style={[styles.rowSub, { color: tc.textMuted }]}>
                Manage notifications, Apple Health, camera, microphone, and Face ID for Thallo.
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={tc.textMuted} />
          </TouchableOpacity>
        </View>

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
  card: {
    borderRadius: radius.lg, borderWidth: 1, padding: 14,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: 12,
  },
  rowTitle: { fontSize: 14, fontWeight: '700' },
  rowSub: { fontSize: 11, marginTop: 2, lineHeight: 15 },
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
});
