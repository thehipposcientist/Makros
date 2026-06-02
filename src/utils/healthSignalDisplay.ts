import type { HealthSummary } from '../types';

export type HealthSummarySignalAvailability = {
  restingHeartRate: boolean;
  hrvAvg: boolean;
  avgSteps7d: boolean;
  activeEnergy7d: boolean;
  avgSleepHours7d: boolean;
  vo2Max: boolean;
  respiratoryRate: boolean;
  oxygenSaturation: boolean;
  standingHours7d: boolean;
  mindfulMinutes7d: boolean;
  basalEnergy7d: boolean;
  workouts: boolean;
};

export function hasHealthMetricValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function getHealthSummarySignalAvailability(
  summary: HealthSummary | null | undefined,
): HealthSummarySignalAvailability {
  return {
    restingHeartRate: hasHealthMetricValue(summary?.restingHeartRate),
    hrvAvg: hasHealthMetricValue(summary?.hrvAvg),
    avgSteps7d: hasHealthMetricValue(summary?.avgSteps7d),
    activeEnergy7d: hasHealthMetricValue(summary?.activeEnergy7d),
    avgSleepHours7d: hasHealthMetricValue(summary?.avgSleepHours7d),
    vo2Max: hasHealthMetricValue(summary?.vo2Max),
    respiratoryRate: hasHealthMetricValue(summary?.respiratoryRate),
    oxygenSaturation: hasHealthMetricValue(summary?.oxygenSaturation),
    standingHours7d: hasHealthMetricValue(summary?.standingHours7d),
    mindfulMinutes7d: hasHealthMetricValue(summary?.mindfulMinutes7d),
    basalEnergy7d: hasHealthMetricValue(summary?.basalEnergy7d),
    workouts: Array.isArray(summary?.workoutDetails) && summary.workoutDetails.length > 0,
  };
}

export function hasDisplayableHealthSummaryData(summary: HealthSummary | null | undefined): boolean {
  const availability = getHealthSummarySignalAvailability(summary);
  return Object.values(availability).some(Boolean);
}
