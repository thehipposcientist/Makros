// Tests for the Apple Health vitals trend classifiers. Each metric is
// covered for: improving / on-track / monitor / null. Personal-baseline
// metrics (RHR, HRV) are also covered for the "no baseline yet" fallback,
// since that's the new-user steady state until ~30 days of sleep history
// have been logged.

import {
  classifyActiveEnergy,
  classifyAvgSleepHours,
  classifyAvgSteps,
  classifyHrv,
  classifyRestingHeartRate,
} from '../vitalsTrend.ts';

describe('classifyRestingHeartRate', () => {
  it('flags improving when current is meaningfully below baseline (≥3 bpm)', () => {
    const r = classifyRestingHeartRate(56, 60);
    expect(r.trend).toBe('improving');
    expect(r.label).toContain('below');
  });

  it('returns on-track within the ±3 bpm noise floor', () => {
    // ±2 bpm is normal daily RHR variation — don't reward / flag noise.
    expect(classifyRestingHeartRate(60, 60).trend).toBe('onTrack');
    expect(classifyRestingHeartRate(58, 60).trend).toBe('onTrack');
    expect(classifyRestingHeartRate(62, 60).trend).toBe('onTrack');
  });

  it('flags monitor when current is 3+ bpm above baseline', () => {
    const r = classifyRestingHeartRate(64, 60);
    expect(r.trend).toBe('monitor');
    expect(r.label).toContain('+');
  });

  it('returns null when no baseline is available', () => {
    // No personal baseline → don't fall back to a population threshold.
    expect(classifyRestingHeartRate(75, null).trend).toBe(null);
    expect(classifyRestingHeartRate(75, 0).trend).toBe(null);
  });

  it('returns null when current value is missing', () => {
    expect(classifyRestingHeartRate(null, 60).trend).toBe(null);
    expect(classifyRestingHeartRate(0, 60).trend).toBe(null);
  });
});

describe('classifyHrv', () => {
  it('flags improving when current is ≥110% of baseline', () => {
    expect(classifyHrv(66, 60).trend).toBe('improving');
  });

  it('returns on-track within ±8% of baseline', () => {
    expect(classifyHrv(60, 60).trend).toBe('onTrack');
    expect(classifyHrv(56, 60).trend).toBe('onTrack');
  });

  it('flags monitor when below 92% of baseline', () => {
    expect(classifyHrv(50, 60).trend).toBe('monitor');
  });

  it('returns null when no baseline is available', () => {
    // HRV varies wildly across individuals + devices — population
    // thresholds would mislead more than they inform.
    expect(classifyHrv(45, null).trend).toBe(null);
  });
});

describe('classifyAvgSleepHours', () => {
  it('flags improving when in the 7–9h target range', () => {
    expect(classifyAvgSleepHours(7.5).trend).toBe('improving');
    expect(classifyAvgSleepHours(8).trend).toBe('improving');
    expect(classifyAvgSleepHours(9).trend).toBe('improving');
  });

  it('flags monitor for 6–7h sleep', () => {
    expect(classifyAvgSleepHours(6.5).trend).toBe('monitor');
  });

  it('flags monitor for very short sleep', () => {
    expect(classifyAvgSleepHours(5).trend).toBe('monitor');
  });

  it('uses on-track for long sleepers (>9h)', () => {
    // We don't flag long sleep as a problem, just note it.
    expect(classifyAvgSleepHours(9.5).trend).toBe('onTrack');
    expect(classifyAvgSleepHours(11).trend).toBe('onTrack');
  });

  it('returns null when no value', () => {
    expect(classifyAvgSleepHours(null).trend).toBe(null);
    expect(classifyAvgSleepHours(0).trend).toBe(null);
  });
});

describe('classifyAvgSteps', () => {
  it('flags improving at 10k+', () => {
    expect(classifyAvgSteps(10500).trend).toBe('improving');
  });

  it('flags on-track between 7.5k and 10k', () => {
    expect(classifyAvgSteps(8000).trend).toBe('onTrack');
  });

  it('flags monitor below 7.5k', () => {
    expect(classifyAvgSteps(6000).trend).toBe('monitor');
    expect(classifyAvgSteps(2000).trend).toBe('monitor');
  });

  it('returns null when value is missing', () => {
    expect(classifyAvgSteps(null).trend).toBe(null);
  });
});

describe('classifyActiveEnergy', () => {
  it('flags improving for high burn (≥2k kcal/day)', () => {
    expect(classifyActiveEnergy(2200).trend).toBe('improving');
    expect(classifyActiveEnergy(3000).trend).toBe('improving');
  });

  it('flags on-track between 1.2k and 2k', () => {
    expect(classifyActiveEnergy(1500).trend).toBe('onTrack');
  });

  it('flags monitor below 1.2k', () => {
    expect(classifyActiveEnergy(900).trend).toBe('monitor');
  });

  it('returns null when value is missing', () => {
    expect(classifyActiveEnergy(null).trend).toBe(null);
  });
});
