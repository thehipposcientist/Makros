import {
  getHealthSummarySignalAvailability,
  hasDisplayableHealthSummaryData,
  hasHealthMetricValue,
} from '../healthSignalDisplay.ts';
import type { HealthSummary } from '../../types/index.ts';

function summary(overrides: Partial<HealthSummary> = {}): HealthSummary {
  return {
    restingHeartRate: null,
    stepsToday: null,
    avgSteps7d: null,
    workouts7d: null,
    avgSleepHours7d: null,
    lastNightSleepHours: null,
    activeEnergyToday: null,
    activeEnergy7d: null,
    hrvAvg: null,
    vo2Max: null,
    respiratoryRate: null,
    oxygenSaturation: null,
    standingHours7d: null,
    mindfulMinutes7d: null,
    basalEnergy7d: null,
    sleepScore: null,
    workoutDetails: [],
    fetchedAt: '2026-05-20T12:00:00.000Z',
    ...overrides,
  };
}

describe('health signal display helpers', () => {
  it('treats null and non-finite values as hidden', () => {
    expect(hasHealthMetricValue(null)).toBe(false);
    expect(hasHealthMetricValue(Number.NaN)).toBe(false);
    expect(hasHealthMetricValue(Infinity)).toBe(false);
  });

  it('keeps known zero values displayable', () => {
    expect(hasHealthMetricValue(0)).toBe(true);
  });

  it('only marks HealthSummary signals available when the metric has a value', () => {
    const availability = getHealthSummarySignalAvailability(summary({
      avgSteps7d: 6400,
      restingHeartRate: null,
      hrvAvg: null,
    }));
    expect(availability.avgSteps7d).toBe(true);
    expect(availability.restingHeartRate).toBe(false);
    expect(availability.hrvAvg).toBe(false);
  });

  it('counts workouts as displayable even when wearable vitals are absent', () => {
    const withWorkout = summary({
      workoutDetails: [{ activityName: 'Walk', duration: 30 } as any],
    });
    expect(getHealthSummarySignalAvailability(withWorkout).workouts).toBe(true);
    expect(hasDisplayableHealthSummaryData(withWorkout)).toBe(true);
  });

  it('returns false for an empty connected summary', () => {
    expect(hasDisplayableHealthSummaryData(summary())).toBe(false);
  });
});
