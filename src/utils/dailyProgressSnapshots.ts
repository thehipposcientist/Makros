import AsyncStorage from '@react-native-async-storage/async-storage';
import type { GoalForecastModel } from './goalForecast';

const RECOMP_FORECAST_KEY = 'dailyRecompForecastSnapshot';

export interface DailyRecompForecastSnapshot {
  date: string;
  scopeKey: string;
  forecast: GoalForecastModel;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function getStableDailyRecompForecast(
  forecast: GoalForecastModel,
  scopeKey: string,
): Promise<DailyRecompForecastSnapshot> {
  const today = dayKey(new Date());
  try {
    const raw = await AsyncStorage.getItem(RECOMP_FORECAST_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (
      parsed
      && typeof parsed === 'object'
      && parsed.date === today
      && parsed.scopeKey === scopeKey
      && parsed.forecast
      && typeof parsed.forecast === 'object'
    ) {
      return parsed as DailyRecompForecastSnapshot;
    }
  } catch {}

  const snapshot: DailyRecompForecastSnapshot = { date: today, scopeKey, forecast };
  try {
    await AsyncStorage.setItem(RECOMP_FORECAST_KEY, JSON.stringify(snapshot));
  } catch {}
  return snapshot;
}
