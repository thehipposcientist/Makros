import { Platform } from 'react-native';
import type { HealthSummary } from '../types';
import { HEALTH_PLATFORM_STATUS_COPY } from '../constants/platformHealth';
import * as appleHealth from './appleHealth';
import type {
  CycleStatus,
  DailyNutritionSnapshot,
  DailySnapshot,
  NightRecord,
  WorkoutZone2Summary,
} from './appleHealth';

export type {
  CycleStatus,
  DailyNutritionSnapshot,
  DailySnapshot,
  NightRecord,
  WorkoutZone2Summary,
};

export type PlatformHealthProvider = 'apple_health' | 'health_connect' | 'none';

export const PLATFORM_HEALTH_PERMISSION_COPY = Platform.OS === 'android'
  ? {
      title: 'Connect Health Connect?',
      body:
        'Health Connect is optional.\n\n' +
        'When Android health sync is available, Thallo will ask only for health categories used in the app: sleep, heart rate, HRV, steps, workouts, body weight, energy, VO2 max, respiratory rate, blood oxygen, mobility trends, nutrition summaries, and cycle data when you choose to share it.\n\n' +
        'This build does not include the native Health Connect reader yet. Thallo will keep using manual logs, in-app workouts, meal data, and recovery check-ins.',
      denied: HEALTH_PLATFORM_STATUS_COPY,
    }
  : appleHealth.APPLE_HEALTH_PERMISSION_COPY;

export function platformHealthProvider(): PlatformHealthProvider {
  if (Platform.OS === 'ios') return 'apple_health';
  if (Platform.OS === 'android') return 'health_connect';
  return 'none';
}

export function platformHealthSource(): 'apple_health' | 'health_connect' {
  return Platform.OS === 'android' ? 'health_connect' : 'apple_health';
}

export function isPlatformHealthImplemented(): boolean {
  return Platform.OS === 'ios';
}

export function isPlatformHealthAvailable(): boolean {
  if (Platform.OS === 'ios') return appleHealth.isHealthKitAvailable();
  return false;
}

export function getLastPlatformHealthError(): string | null {
  if (Platform.OS === 'ios') return appleHealth.getLastHealthKitError();
  return null;
}

export async function requestPlatformHealthPermissions(): Promise<boolean> {
  if (Platform.OS === 'ios') return appleHealth.requestHealthPermissions();
  return false;
}

export async function readPlatformHealthSummary(
  opts: Parameters<typeof appleHealth.readHealthSummary>[0] = {},
): Promise<HealthSummary | null> {
  if (Platform.OS === 'ios') return appleHealth.readHealthSummary(opts);
  return null;
}

export async function readPlatformDailySnapshot(
  dayStartMs: number,
  dayEndMs: number,
): Promise<DailySnapshot | null> {
  if (Platform.OS === 'ios') return appleHealth.readDailySnapshot(dayStartMs, dayEndMs);
  return null;
}

export async function readPlatformDailyNutritionSnapshot(
  dayStartMs: number,
  dayEndMs: number,
): Promise<DailyNutritionSnapshot | null> {
  if (Platform.OS === 'ios') return appleHealth.readDailyNutritionSnapshot(dayStartMs, dayEndMs);
  return null;
}

export async function getPlatformCycleStatus(): Promise<CycleStatus | null> {
  if (Platform.OS === 'ios') return appleHealth.getCycleStatus();
  return null;
}

export async function loadPlatformSleepHistory(): Promise<NightRecord[]> {
  if (Platform.OS === 'ios') return appleHealth.loadSleepHistory();
  return [];
}

export async function summarizePlatformWorkoutZone2(
  workout: any,
  age: number | null = null,
): Promise<WorkoutZone2Summary | null> {
  if (Platform.OS === 'ios') return appleHealth.summarizeWorkoutZone2(workout, age);
  return null;
}
