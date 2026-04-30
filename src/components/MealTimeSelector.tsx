import { useMemo } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme } from '../constants/theme';

type ThemeColors = ReturnType<typeof getTheme>['colors'];

type Props = {
  value: Date;
  mealDate?: string;
  colors: ThemeColors;
  onChange: (next: Date) => void;
};

const PRESETS = [
  { label: 'Breakfast', time: '8:00', hour: 8, minute: 0 },
  { label: 'Lunch', time: '12:30', hour: 12, minute: 30 },
  { label: 'Snack', time: '3:30', hour: 15, minute: 30 },
  { label: 'Dinner', time: '6:30', hour: 18, minute: 30 },
];

function applyMealDate(value: Date, mealDate?: string): Date {
  const next = new Date(value);
  if (!mealDate) return next;
  const [year, month, day] = mealDate.split('-').map(Number);
  if (!year || !month || !day) return next;
  next.setFullYear(year, month - 1, day);
  return next;
}

export function defaultMealDateTime(mealDate?: string): Date {
  return applyMealDate(new Date(), mealDate);
}

export function parseMealDateTime(value?: string | null, mealDate?: string): Date {
  if (value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return applyMealDate(parsed, mealDate);
  }
  return defaultMealDateTime(mealDate);
}

function formatTime(value: Date): string {
  return value.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatDateHint(value: Date): string {
  return value.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function MealTimeSelector({ value, mealDate, colors, onChange }: Props) {
  const hour24 = value.getHours();
  const minute = value.getMinutes();
  const meridiem = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 || 12;
  const activePreset = useMemo(() => (
    PRESETS.find(p => p.hour === hour24 && p.minute === minute)?.label ?? null
  ), [hour24, minute]);

  const setPreset = (hour: number, nextMinute: number) => {
    const next = applyMealDate(value, mealDate);
    next.setHours(hour, nextMinute, 0, 0);
    onChange(next);
  };

  const adjustMinutes = (delta: number) => {
    const next = applyMealDate(value, mealDate);
    next.setMinutes(next.getMinutes() + delta);
    next.setSeconds(0, 0);
    onChange(applyMealDate(next, mealDate));
  };

  const adjustHours = (delta: number) => {
    const next = applyMealDate(value, mealDate);
    next.setHours(next.getHours() + delta);
    next.setSeconds(0, 0);
    onChange(applyMealDate(next, mealDate));
  };

  const setMeridiem = (target: 'AM' | 'PM') => {
    if (target === meridiem) return;
    const next = applyMealDate(value, mealDate);
    next.setHours(next.getHours() + (target === 'PM' ? 12 : -12));
    next.setSeconds(0, 0);
    onChange(next);
  };

  return (
    <View style={{
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      padding: 12,
      gap: 10,
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{
          width: 38,
          height: 38,
          borderRadius: 19,
          backgroundColor: colors.primary + '18',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <Ionicons name="time-outline" size={20} color={colors.primary} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontSize: 10, fontWeight: '800', letterSpacing: 0.4, color: colors.textMuted }}>
            EATEN AT
          </Text>
          <Text style={{ fontSize: 22, fontWeight: '900', color: colors.textPrimary, marginTop: 1 }}>
            {formatTime(value)}
          </Text>
          <Text style={{ fontSize: 11, fontWeight: '600', color: colors.textMuted, marginTop: 1 }}>
            {formatDateHint(value)}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => onChange(defaultMealDateTime(mealDate))}
          activeOpacity={0.8}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            borderRadius: 999,
            paddingHorizontal: 11,
            paddingVertical: 8,
            backgroundColor: colors.primary + '12',
            borderWidth: 1,
            borderColor: colors.primary + '55',
          }}>
          <Ionicons name="flash-outline" size={13} color={colors.primary} />
          <Text style={{ fontSize: 11, fontWeight: '900', color: colors.primary }}>Now</Text>
        </TouchableOpacity>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
        {PRESETS.map(p => {
          const active = activePreset === p.label;
          return (
            <TouchableOpacity
              key={p.label}
              onPress={() => setPreset(p.hour, p.minute)}
              activeOpacity={0.82}
              style={{
                flexGrow: 1,
                minWidth: '47%',
                borderRadius: 11,
                paddingVertical: 8,
                paddingHorizontal: 10,
                backgroundColor: active ? colors.primary : colors.surfaceRaised,
                borderWidth: 1,
                borderColor: active ? colors.primary : colors.border,
              }}>
              <Text style={{ fontSize: 12, fontWeight: '900', color: active ? '#fff' : colors.textPrimary }}>
                {p.label}
              </Text>
              <Text style={{ fontSize: 10, fontWeight: '700', color: active ? '#ffffffcc' : colors.textMuted, marginTop: 1 }}>
                {p.time}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'stretch' }}>
        <View style={{ flex: 1, flexDirection: 'row', gap: 6 }}>
          <TimeNudgeButton label="-1h" onPress={() => adjustHours(-1)} colors={colors} />
          <View style={{
            flex: 1,
            borderRadius: 10,
            backgroundColor: colors.surfaceRaised,
            borderWidth: 1,
            borderColor: colors.border,
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <Text style={{ fontSize: 10, fontWeight: '800', color: colors.textMuted }}>HOUR</Text>
            <Text style={{ fontSize: 16, fontWeight: '900', color: colors.textPrimary }}>{hour12}</Text>
          </View>
          <TimeNudgeButton label="+1h" onPress={() => adjustHours(1)} colors={colors} />
        </View>
        <View style={{ flex: 1, flexDirection: 'row', gap: 6 }}>
          <TimeNudgeButton label="-5" onPress={() => adjustMinutes(-5)} colors={colors} />
          <View style={{
            flex: 1,
            borderRadius: 10,
            backgroundColor: colors.surfaceRaised,
            borderWidth: 1,
            borderColor: colors.border,
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <Text style={{ fontSize: 10, fontWeight: '800', color: colors.textMuted }}>MIN</Text>
            <Text style={{ fontSize: 16, fontWeight: '900', color: colors.textPrimary }}>{String(minute).padStart(2, '0')}</Text>
          </View>
          <TimeNudgeButton label="+5" onPress={() => adjustMinutes(5)} colors={colors} />
        </View>
      </View>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        {(['AM', 'PM'] as const).map(label => {
          const active = meridiem === label;
          return (
            <TouchableOpacity
              key={label}
              onPress={() => setMeridiem(label)}
              activeOpacity={0.84}
              style={{
                flex: 1,
                minHeight: 34,
                borderRadius: 10,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: active ? colors.primary : colors.surfaceRaised,
                borderWidth: 1,
                borderColor: active ? colors.primary : colors.border,
              }}>
              <Text style={{ fontSize: 12, fontWeight: '900', color: active ? '#fff' : colors.textPrimary }}>
                {label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function TimeNudgeButton({
  label,
  colors,
  onPress,
}: {
  label: string;
  colors: ThemeColors;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.82}
      style={{
        minWidth: 38,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.surfaceRaised,
        borderWidth: 1,
        borderColor: colors.border,
      }}>
      <Text style={{ fontSize: 12, fontWeight: '900', color: colors.primary }}>{label}</Text>
    </TouchableOpacity>
  );
}
