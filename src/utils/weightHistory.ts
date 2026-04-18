import AsyncStorage from '@react-native-async-storage/async-storage';
import { WeightEntry } from '../types';

const KEY = 'weightHistory';

export async function loadWeightHistory(): Promise<WeightEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveWeightEntry(
  weightLbs: number,
  source: WeightEntry['source'] = 'manual',
): Promise<WeightEntry[]> {
  const history = await loadWeightHistory();
  const today = new Date().toISOString().slice(0, 10);
  const existing = history.findIndex(e => e.date === today);
  const entry: WeightEntry = { date: today, weightLbs: Math.round(weightLbs * 10) / 10, source };
  if (existing >= 0) {
    history[existing] = entry;
  } else {
    history.push(entry);
  }
  history.sort((a, b) => a.date.localeCompare(b.date));
  // Keep last 365 entries
  const trimmed = history.slice(-365);
  await AsyncStorage.setItem(KEY, JSON.stringify(trimmed));
  return trimmed;
}

export function weightChange(history: WeightEntry[], days: number): { change: number; startWeight: number; endWeight: number } | null {
  if (history.length < 2) return null;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const recent = history.filter(e => e.date >= cutoffStr);
  if (recent.length < 2) {
    const start = history[0];
    const end = history[history.length - 1];
    return { change: end.weightLbs - start.weightLbs, startWeight: start.weightLbs, endWeight: end.weightLbs };
  }
  return { change: recent[recent.length - 1].weightLbs - recent[0].weightLbs, startWeight: recent[0].weightLbs, endWeight: recent[recent.length - 1].weightLbs };
}
