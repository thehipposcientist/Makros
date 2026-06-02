import {
  assertSunExposureCopyIsSafe,
  coefficientCopy,
  estimateSunVitaminD,
  estimatedOutdoorDaylightMinutes,
  normalizeSunExposurePreferences,
  sunVitaminDEstimateLabel,
  sunExposureDisplayColor,
  sunExposureScoreHelp,
  sunExposureScoreMeaning,
  sunExposureScoreStatus,
  sunExposureScoreTitle,
  summaryCopy,
} from '../sunExposure.ts';

describe('sun exposure copy and preferences', () => {
  it('normalizes location off to disable location-derived estimates', () => {
    const prefs = normalizeSunExposurePreferences({
      enabled: true,
      useWorkoutRoutes: true,
      useCoarseLocation: true,
      locationMode: 'off',
    });
    expect(prefs.enabled).toBe(true);
    expect(prefs.useWorkoutRoutes).toBe(false);
    expect(prefs.useCoarseLocation).toBe(false);
  });

  it('uses partial-sun copy for unknown area context', () => {
    const copy = coefficientCopy(null);
    expect(copy.toLowerCase().includes('partial sun')).toBe(true);
    expect(assertSunExposureCopyIsSafe(copy)).toBe(true);
  });

  it('includes UV protection language without claiming certainty', () => {
    const copy = summaryCopy({
      date: '2026-05-19',
      likelyOutdoorDaylightMinutes: 46,
      confirmedOutdoorDaylightMinutes: 0,
      possibleOutdoorDaylightMinutes: 0,
      mostlyShadedMinutes: 24,
      mostlyOpenSkyMinutes: 22,
      highUvMinutes: 18,
      veryHighUvMinutes: 0,
      effectiveUvMinutes: 132,
      openSkyEquivalentMinutes: 22,
      confidence: 'medium',
      explanation: 'This is an estimate based on your workout route, coarse area type, and UV Index.',
      safetyMessage: 'Sun protection would be recommended if you were outside.',
    }).join(' ');
    expect(copy).toContain('daylight');
    expect(copy).toContain('light-intensity metadata');
    expect(copy.includes('open-sky equivalent')).toBe(false);
    expect(copy).toContain('Sun protection would be recommended if you were outside.');
    expect(assertSunExposureCopyIsSafe(copy)).toBe(true);
  });

  it('uses the single daylight number when present', () => {
    expect(estimatedOutdoorDaylightMinutes({
      date: '2026-05-19',
      daylightMinutes: 24,
      likelyOutdoorDaylightMinutes: 8,
      confirmedOutdoorDaylightMinutes: 22,
      possibleOutdoorDaylightMinutes: 15,
      mostlyShadedMinutes: 18,
      mostlyOpenSkyMinutes: 12,
      highUvMinutes: 0,
      veryHighUvMinutes: 0,
      effectiveUvMinutes: 0,
      openSkyEquivalentMinutes: 15,
      confidence: 'high',
      explanation: 'This is an estimate.',
      safetyMessage: null,
    })).toBe(24);
  });

  it('keeps timing detail minutes aligned with the displayed daylight total', () => {
    const copy = summaryCopy({
      date: '2026-05-19',
      daylightMinutes: 67,
      likelyOutdoorDaylightMinutes: 122,
      confirmedOutdoorDaylightMinutes: 0,
      possibleOutdoorDaylightMinutes: 0,
      mostlyShadedMinutes: 0,
      mostlyOpenSkyMinutes: 122,
      highUvMinutes: 90,
      veryHighUvMinutes: 0,
      effectiveUvMinutes: 0,
      openSkyEquivalentMinutes: 122,
      morningDaylightMinutes: 122,
      middayDaylightMinutes: 0,
      afternoonDaylightMinutes: 0,
      confidence: 'medium',
      explanation: 'This is an estimate.',
    }).join(' ');

    expect(copy).toContain('You had 67 min daylight today.');
    expect(copy).toContain('Most of your recorded daylight was in the morning (67 min).');
    expect(copy).toContain('Your recorded daylight included 67 min at UV 3 or higher.');
    expect(copy.includes('122 min')).toBe(false);
    expect(copy.includes('90 min')).toBe(false);
  });

  it('keeps daylight score labels separate from UV risk labels', () => {
    const balancedSummary = {
      date: '2026-05-19',
      daylightMinutes: 31,
      likelyOutdoorDaylightMinutes: 0,
      confirmedOutdoorDaylightMinutes: 31,
      possibleOutdoorDaylightMinutes: 0,
      mostlyShadedMinutes: 0,
      mostlyOpenSkyMinutes: 31,
      highUvMinutes: 0,
      veryHighUvMinutes: 0,
      effectiveUvMinutes: 0,
      openSkyEquivalentMinutes: 31,
      sunScore: 82,
      sunScoreLabel: 'Balanced',
      uvRiskScore: 8,
      uvRiskLabel: 'Low',
      confidence: 'high',
      explanation: 'This is an estimate.',
    } as const;
    expect(sunExposureScoreTitle(balancedSummary)).toBe('Daylight Score');
    expect(sunExposureScoreStatus(balancedSummary)).toBe('Good Daylight');
    expect(sunExposureScoreMeaning(balancedSummary)).toBe('Useful daylight kept this score high.');
    const highUvSummary = {
      date: '2026-05-19',
      daylightMinutes: 55,
      likelyOutdoorDaylightMinutes: 0,
      confirmedOutdoorDaylightMinutes: 55,
      possibleOutdoorDaylightMinutes: 0,
      mostlyShadedMinutes: 0,
      mostlyOpenSkyMinutes: 55,
      highUvMinutes: 50,
      veryHighUvMinutes: 12,
      effectiveUvMinutes: 200,
      openSkyEquivalentMinutes: 55,
      sunScore: 61,
      sunScoreLabel: 'High UV',
      uvRiskScore: 67,
      uvRiskLabel: 'High',
      confidence: 'high',
      explanation: 'This is an estimate.',
    } as const;
    expect(sunExposureScoreTitle(highUvSummary)).toBe('Daylight Score');
    expect(sunExposureScoreStatus(highUvSummary)).toBe('Some Daylight');
    expect(sunExposureScoreMeaning(highUvSummary)).toBe('Some useful daylight; more low-UV time could score higher. UV risk was high.');
    expect(sunExposureScoreHelp(highUvSummary)).toContain('UV risk was high');
    expect(sunExposureDisplayColor(highUvSummary)).toBe('#F59E0B');
    const highScoreModerateUvSummary = {
      ...balancedSummary,
      sunScore: 96,
      sunScoreLabel: 'Moderate UV exposure',
      uvRiskScore: 31,
      uvRiskLabel: 'Moderate',
    } as const;
    expect(sunExposureScoreStatus(highScoreModerateUvSummary)).toBe('Strong Daylight');
    expect(sunExposureScoreMeaning(highScoreModerateUvSummary)).toBe('Excellent daylight signal. UV risk was moderate.');
    expect(sunExposureDisplayColor(highScoreModerateUvSummary)).toBe('#22C55E');
  });

  it('estimates a cautious sunlight vitamin D signal from daylight and UV', () => {
    const estimate = estimateSunVitaminD({
      date: '2026-05-19',
      likelyOutdoorDaylightMinutes: 48,
      confirmedOutdoorDaylightMinutes: 0,
      possibleOutdoorDaylightMinutes: 0,
      mostlyShadedMinutes: 18,
      mostlyOpenSkyMinutes: 30,
      highUvMinutes: 20,
      veryHighUvMinutes: 0,
      effectiveUvMinutes: 80,
      openSkyEquivalentMinutes: 30,
      uvIndexAverage: 6,
      uvIndexMax: 8,
      confidence: 'medium',
      explanation: 'This is an estimate.',
    });
    expect(estimate?.iuEquivalent).toBeGreaterThan(0);
    expect(sunVitaminDEstimateLabel(estimate)).toContain('IU-eq');
    expect(assertSunExposureCopyIsSafe(estimate?.detail ?? '')).toBe(true);
  });
});
