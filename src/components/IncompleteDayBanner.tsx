// Soft "yesterday looks incomplete" nudge. Lives at the top of the Meals >
// Plan tab — never at login, never blocking. Shows only when yesterday's
// logged calories are under 50% of target AND the user hasn't already
// dismissed the banner for that date.
//
// Dismissal persists per-date in AsyncStorage so reopening the app doesn't
// re-prompt. "Fill in" routes to the Foods tab for manual logging.

import { useEffect, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { getMealHistory } from '../services/api';

interface Props {
  authToken: string;
  themeName?: AppThemeName;
  /** Today's plan calorie target — used as a proxy for yesterday's target.
   *  Plans rarely shift calories day-to-day, good-enough for a nudge. */
  targetCalories: number;
  /** Invoked when user taps "Fill in". Typically switches to the Foods tab. */
  onFillIn?: () => void;
}

const DISMISSED_KEY_PREFIX = 'incompleteDayDismissed_';
const INCOMPLETE_RATIO = 0.5;

function yesterdayKey(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export default function IncompleteDayBanner({
  authToken, themeName, targetCalories, onFillIn,
}: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;

  const [visible, setVisible] = useState(false);
  const [yesterdayCals, setYesterdayCals] = useState(0);

  const check = useCallback(async () => {
    if (!authToken || targetCalories <= 0) return;
    const dateKey = yesterdayKey();
    try {
      const dismissed = await AsyncStorage.getItem(DISMISSED_KEY_PREFIX + dateKey);
      if (dismissed === '1') return;

      const res = await getMealHistory(authToken, 2);
      const meals = res.meals || [];
      // Sum yesterday's totals. meal_date is "YYYY-MM-DD" from backend.
      const cals = meals
        .filter(m => m.meal_date === dateKey)
        .reduce((sum, m) => sum + (m.totals?.calories ?? 0), 0);

      const ratio = cals / targetCalories;
      // Only nudge if there's SOME signal of app activity but logs look thin.
      // A 0-calorie day could just mean they skipped — we still nudge because
      // the alternative is a silent data gap that hurts averages.
      if (ratio < INCOMPLETE_RATIO) {
        setYesterdayCals(Math.round(cals));
        setVisible(true);
      }
    } catch {
      // Silent fail — banner is a nicety, not critical.
    }
  }, [authToken, targetCalories]);

  useEffect(() => { check(); }, [check]);

  const dismiss = async (reason: 'fillIn' | 'wasRight') => {
    try {
      await AsyncStorage.setItem(DISMISSED_KEY_PREFIX + yesterdayKey(), '1');
    } catch {}
    setVisible(false);
    if (reason === 'fillIn') onFillIn?.();
  };

  if (!visible) return null;

  const pct = targetCalories > 0 ? Math.round((yesterdayCals / targetCalories) * 100) : 0;

  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 10,
      backgroundColor: tc.surface, borderRadius: radius.lg,
      padding: 12, marginBottom: 12,
      borderWidth: 1, borderColor: tc.warning + '55',
    }}>
      <Ionicons name="information-circle-outline" size={20} color={tc.warning} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textPrimary }}>
          Yesterday looks incomplete
        </Text>
        <Text style={{ fontSize: 11, color: tc.textSecondary, marginTop: 2 }}>
          Logged {yesterdayCals} cal ({pct}% of target). Fill in what you missed or mark the day right.
        </Text>
      </View>
      <View style={{ gap: 6 }}>
        <TouchableOpacity
          onPress={() => dismiss('fillIn')}
          style={{
            paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
            backgroundColor: tc.primary,
          }}
        >
          <Text style={{ fontSize: 11, fontWeight: '700', color: tc.background }}>Fill in</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => dismiss('wasRight')}
          style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: tc.border }}
        >
          <Text style={{ fontSize: 11, fontWeight: '600', color: tc.textSecondary }}>It was right</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
