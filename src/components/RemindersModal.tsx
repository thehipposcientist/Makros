// Focused reminders modal — shows just the workout reminder, just the
// meal reminder, or both. Mounted from:
//   - Profile gear → Settings (kind="both")
//   - EditProfile → Workout tab (kind="workout")
//   - EditProfile → Mealplan tab (kind="meal")
//
// Each kind renders the same controls (enable, time, schedule type,
// custom-day picker, skip-when-done) as the inline section in
// HomeScreen's Settings modal. State + persistence go straight through
// the workout/mealReminders utils, so changes here are reflected
// everywhere instantly via the next load.

import React, { useEffect, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView, Switch, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme, radius, toggleOffTrack } from '../constants/theme';
import { AppThemeName } from '../types';
import {
  loadReminderSettings,
  saveReminderSettings,
  type ReminderSettings,
  type ReminderScheduleType,
} from '../utils/workoutReminders';
import {
  loadMealReminderSettings,
  saveMealReminderSettings,
  type MealReminderSettings,
  type MealReminderScheduleType,
} from '../utils/mealReminders';

type Kind = 'workout' | 'meal' | 'both';

interface Props {
  visible: boolean;
  onClose: () => void;
  themeName?: AppThemeName;
  kind: Kind;
  /** Optional title override — default reads from `kind`. */
  title?: string;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatTime(hour: number, minute: number): string {
  const hh = ((hour + 11) % 12 + 1);
  const mm = String(minute).padStart(2, '0');
  return `${hh}:${mm} ${hour < 12 ? 'AM' : 'PM'}`;
}

function stepMinutes(hour: number, minute: number, delta: number) {
  const total = ((hour * 60 + minute + delta) + 24 * 60) % (24 * 60);
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

export default function RemindersModal({ visible, onClose, themeName, kind, title }: Props) {
  const tc = getTheme(themeName).colors;
  const [workoutR, setWorkoutR] = useState<ReminderSettings>({
    enabled: false, hour: 8, minute: 0, scheduleType: 'training_days', skipIfCompleted: true,
  });
  const [mealR, setMealR] = useState<MealReminderSettings>({
    enabled: true, hour: 21, minute: 0, scheduleType: 'every_day', skipIfAllLogged: true,
  });

  useEffect(() => {
    if (!visible) return;
    if (kind === 'workout' || kind === 'both') {
      loadReminderSettings().then(setWorkoutR).catch(() => {});
    }
    if (kind === 'meal' || kind === 'both') {
      loadMealReminderSettings().then(setMealR).catch(() => {});
    }
  }, [visible, kind]);

  const updateWorkout = async (next: ReminderSettings) => {
    setWorkoutR(next);
    await saveReminderSettings(next);
  };
  const updateMeal = async (next: MealReminderSettings) => {
    setMealR(next);
    await saveMealReminderSettings(next);
  };

  const showWorkout = kind === 'workout' || kind === 'both';
  const showMeal = kind === 'meal' || kind === 'both';
  const headerTitle = title ?? (
    kind === 'workout' ? 'Workout reminders'
    : kind === 'meal'  ? 'Meal log reminder'
    : 'Reminders'
  );

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: tc.background }}>
        <View style={{
          flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
          paddingHorizontal: 16, paddingVertical: 12,
          borderBottomWidth: 1, borderBottomColor: tc.border,
        }}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="close" size={24} color={tc.textPrimary} />
          </TouchableOpacity>
          <Text style={{ fontSize: 16, fontWeight: '800', color: tc.textPrimary }}>{headerTitle}</Text>
          <View style={{ width: 24 }} />
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
          {showWorkout && (
            <ReminderBlock
              tc={tc}
              label="Workout reminder"
              desc="Local notification at your set time"
              enabled={workoutR.enabled}
              onToggle={(v) => updateWorkout({ ...workoutR, enabled: v })}
              hour={workoutR.hour}
              minute={workoutR.minute}
              onTime={(h, m) => updateWorkout({ ...workoutR, hour: h, minute: m })}
              scheduleType={workoutR.scheduleType ?? 'training_days'}
              scheduleOptions={[
                { key: 'training_days', label: 'Training days' },
                { key: 'every_day',     label: 'Every day' },
                { key: 'weekdays',      label: 'Weekdays' },
                { key: 'weekends',      label: 'Weekends' },
                { key: 'custom',        label: 'Custom' },
              ]}
              onScheduleType={(t) => updateWorkout({ ...workoutR, scheduleType: t as ReminderScheduleType })}
              customDays={workoutR.customDays ?? []}
              onCustomDays={(days) => updateWorkout({ ...workoutR, customDays: days })}
              skipFlag={workoutR.skipIfCompleted !== false}
              onSkipToggle={(v) => updateWorkout({ ...workoutR, skipIfCompleted: v })}
              skipLabel="Skip if already done"
              skipDesc="Auto-cancel today's reminder once you complete or skip the workout."
            />
          )}

          {showMeal && (
            <ReminderBlock
              tc={tc}
              label="Meal log reminder"
              desc="Evening nudge to check off the day's meals"
              enabled={mealR.enabled}
              onToggle={(v) => updateMeal({ ...mealR, enabled: v })}
              hour={mealR.hour}
              minute={mealR.minute}
              onTime={(h, m) => updateMeal({ ...mealR, hour: h, minute: m })}
              scheduleType={mealR.scheduleType ?? 'every_day'}
              scheduleOptions={[
                { key: 'every_day', label: 'Every day' },
                { key: 'weekdays',  label: 'Weekdays' },
                { key: 'weekends',  label: 'Weekends' },
                { key: 'custom',    label: 'Custom' },
              ]}
              onScheduleType={(t) => updateMeal({ ...mealR, scheduleType: t as MealReminderScheduleType })}
              customDays={mealR.customDays ?? []}
              onCustomDays={(days) => updateMeal({ ...mealR, customDays: days })}
              skipFlag={mealR.skipIfAllLogged !== false}
              onSkipToggle={(v) => updateMeal({ ...mealR, skipIfAllLogged: v })}
              skipLabel="Skip if all meals logged"
              skipDesc="Auto-cancel today's reminder once every plan meal is checked off."
            />
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

function ReminderBlock(props: {
  tc: ReturnType<typeof getTheme>['colors'];
  label: string;
  desc: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  hour: number;
  minute: number;
  onTime: (h: number, m: number) => void;
  scheduleType: string;
  scheduleOptions: Array<{ key: string; label: string }>;
  onScheduleType: (t: string) => void;
  customDays: number[];
  onCustomDays: (days: number[]) => void;
  skipFlag: boolean;
  onSkipToggle: (v: boolean) => void;
  skipLabel: string;
  skipDesc: string;
}) {
  const { tc } = props;
  return (
    <View style={{ backgroundColor: tc.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: tc.border, overflow: 'hidden' }}>
      {/* Enable */}
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: 14 }}>
        <View style={{ flex: 1, paddingRight: 10 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: tc.textPrimary }}>{props.label}</Text>
          <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 2, lineHeight: 16 }}>{props.desc}</Text>
        </View>
        <Switch
          value={props.enabled}
          onValueChange={props.onToggle}
          trackColor={{ false: toggleOffTrack(tc), true: tc.primary + '55' }}
          thumbColor={props.enabled ? tc.primary : '#FFFFFF'}
        />
      </View>

      {props.enabled && (
        <>
          {/* Time picker */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: 1, borderTopColor: tc.border }}>
            <Text style={{ fontSize: 13, color: tc.textSecondary }}>Remind me at</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <TouchableOpacity
                onPress={() => {
                  const next = stepMinutes(props.hour, props.minute, -15);
                  props.onTime(next.hour, next.minute);
                }}
                style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: tc.border }}>
                <Ionicons name="remove" size={14} color={tc.textSecondary} />
              </TouchableOpacity>
              <Text style={{ minWidth: 64, textAlign: 'center', fontSize: 14, fontWeight: '700', color: tc.textPrimary }}>
                {formatTime(props.hour, props.minute)}
              </Text>
              <TouchableOpacity
                onPress={() => {
                  const next = stepMinutes(props.hour, props.minute, 15);
                  props.onTime(next.hour, next.minute);
                }}
                style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: tc.border }}>
                <Ionicons name="add" size={14} color={tc.textSecondary} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Schedule type */}
          <View style={{ paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: 1, borderTopColor: tc.border, gap: 8 }}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textSecondary }}>Schedule</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {props.scheduleOptions.map(opt => {
                const active = props.scheduleType === opt.key;
                return (
                  <TouchableOpacity
                    key={opt.key}
                    onPress={() => props.onScheduleType(opt.key)}
                    style={{
                      paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14,
                      backgroundColor: active ? tc.primary : tc.surface,
                      borderWidth: 1, borderColor: active ? tc.primary : tc.border,
                    }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: active ? getContrastingTextColor(tc.primary) : tc.textSecondary }}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {props.scheduleType === 'custom' && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                {DAY_LABELS.map((d, idx) => {
                  const selected = props.customDays.includes(idx);
                  return (
                    <TouchableOpacity
                      key={d}
                      onPress={() => {
                        const next = selected
                          ? props.customDays.filter(x => x !== idx)
                          : [...props.customDays, idx].sort();
                        props.onCustomDays(next);
                      }}
                      style={{
                        width: 36, height: 32, borderRadius: 8,
                        backgroundColor: selected ? tc.primary : tc.surface,
                        borderWidth: 1, borderColor: selected ? tc.primary : tc.border,
                        alignItems: 'center', justifyContent: 'center',
                      }}>
                      <Text style={{ fontSize: 11, fontWeight: '700', color: selected ? getContrastingTextColor(tc.primary) : tc.textSecondary }}>
                        {d}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </View>

          {/* Skip-when-done toggle */}
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: 14, borderTopWidth: 1, borderTopColor: tc.border }}>
            <View style={{ flex: 1, paddingRight: 10 }}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }}>{props.skipLabel}</Text>
              <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 2, lineHeight: 16 }}>
                {props.skipDesc} Off = always fire.
              </Text>
            </View>
            <Switch
              value={props.skipFlag}
              onValueChange={props.onSkipToggle}
              trackColor={{ false: toggleOffTrack(tc), true: tc.primary + '55' }}
              thumbColor={props.skipFlag ? tc.primary : '#FFFFFF'}
            />
          </View>
        </>
      )}
    </View>
  );
}
