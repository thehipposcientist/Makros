import {
  assertContextInsightCopyIsSafe,
  contextInsightConfidenceLabel,
  normalizeUserInsightPreferences,
} from '../contextInsights.ts';

describe('context insight utilities', () => {
  it('displays low confidence clearly', () => {
    expect(contextInsightConfidenceLabel('low')).toBe('Low confidence');
  });

  it('keeps environment data disabled without location inputs', () => {
    const prefs = normalizeUserInsightPreferences({
      enableEnvironmentInsights: true,
      useWeatherEnvironmentData: true,
      useCoarseLocation: false,
      useWorkoutRoutes: false,
    });
    expect(prefs.useWeatherEnvironmentData).toBe(false);
  });

  it('keeps social context off when social insights are off', () => {
    const prefs = normalizeUserInsightPreferences({
      enableSocialInsights: false,
      useSocialContext: true,
    });
    expect(prefs.useSocialContext).toBe(false);
  });

  it('guards unsafe context insight copy', () => {
    expect(assertContextInsightCopyIsSafe('Estimated daylight pattern with low confidence.')).toBe(true);
    expect(assertContextInsightCopyIsSafe('Your bone density score improved.')).toBe(false);
    expect(assertContextInsightCopyIsSafe('You are lonely.')).toBe(false);
  });
});

