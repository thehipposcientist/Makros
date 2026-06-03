import type {
  AreaSunContext,
  SunExposureCorrectionOption,
  SunExposureDailySummary,
  SunExposurePreferences,
} from '../types';

export const DEFAULT_SUN_EXPOSURE_PREFERENCES: SunExposurePreferences = {
  enabled: false,
  useWorkoutRoutes: true,
  useCoarseLocation: false,
  useHealthDaylightData: true,
  useAreaCoefficients: true,
  allowCorrectionPrompts: true,
  highUvRemindersEnabled: true,
  locationMode: 'workout_routes_only',
};

const VALID_LOCATION_MODES = new Set([
  'off',
  'workout_routes_only',
  'coarse_location',
  'precise_during_active_workout',
]);

export function normalizeSunExposurePreferences(value: Partial<SunExposurePreferences> | null | undefined): SunExposurePreferences {
  const incoming = value && typeof value === 'object' ? value : {};
  const next: SunExposurePreferences = {
    ...DEFAULT_SUN_EXPOSURE_PREFERENCES,
    ...incoming,
  };
  if (!VALID_LOCATION_MODES.has(next.locationMode)) {
    next.locationMode = 'workout_routes_only';
  }
  if (next.locationMode === 'off') {
    next.useWorkoutRoutes = false;
    next.useCoarseLocation = false;
  }
  return next;
}

export function formatSunMinutes(value: number | null | undefined): string {
  const minutes = Math.max(0, Math.round(Number(value ?? 0)));
  return `${minutes} min`;
}

export function formatLux(value: number | null | undefined): string {
  const lux = Number(value ?? 0);
  if (!Number.isFinite(lux) || lux <= 0) return '-';
  if (lux >= 1000) return `${Math.round(lux / 100) / 10}k lux`;
  return `${Math.round(lux)} lux`;
}

export function estimatedOutdoorDaylightMinutes(summary: SunExposureDailySummary | null | undefined): number {
  if (!summary) return 0;
  const daylight = Number(summary.daylightMinutes);
  if (Number.isFinite(daylight) && daylight > 0) return daylight;
  return Math.max(0, Number(summary.confirmedOutdoorDaylightMinutes ?? 0))
    + Math.max(0, Number(summary.likelyOutdoorDaylightMinutes ?? 0));
}

export function hasSunExposureSummaryData(summary: SunExposureDailySummary | null | undefined): boolean {
  if (!summary) return false;
  return [
    summary.likelyOutdoorDaylightMinutes,
    summary.confirmedOutdoorDaylightMinutes,
    summary.possibleOutdoorDaylightMinutes,
    summary.mostlyShadedMinutes,
    summary.mostlyOpenSkyMinutes,
    summary.highUvMinutes,
    summary.veryHighUvMinutes,
    summary.effectiveUvMinutes,
    summary.openSkyEquivalentMinutes,
    summary.daylightMinutes,
    summary.appleHealthDaylightMinutes,
    summary.lightIntensityLuxAverage,
    summary.lightIntensityLuxMax,
  ].some(value => Number(value ?? 0) > 0);
}

export function sunExposureScore(summary: SunExposureDailySummary | null | undefined): number {
  const raw = Number(summary?.sunScore ?? 0);
  return Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : 0;
}

export function sunExposureScoreColor(score: number): string {
  if (score >= 70) return '#22C55E';
  if (score >= 45) return '#F59E0B';
  if (score > 0) return '#EF4444';
  return '#94A3B8';
}

export function sunExposureScoreTitle(summary: SunExposureDailySummary | null | undefined): string {
  const score = sunExposureScore(summary);
  if (!summary || score <= 0) return 'No Daylight Yet';
  return 'Daylight Score';
}

export function sunExposureScoreStatus(summary: SunExposureDailySummary | null | undefined): string {
  const score = sunExposureScore(summary);
  const label = String(summary?.sunScoreLabel ?? '').toLowerCase();
  if (!summary || score <= 0) return 'No Daylight Yet';
  if (label.includes('morning') && score >= 70) return 'Morning Daylight';
  if (score >= 85) return 'Strong Daylight';
  if (score >= 70) return 'Good Daylight';
  if (score >= 45) return 'Some Daylight';
  return 'Low Daylight';
}

export function sunExposureDisplayColor(summary: SunExposureDailySummary | null | undefined): string {
  return sunExposureScoreColor(sunExposureScore(summary));
}

export function sunExposureScoreMeaning(summary: SunExposureDailySummary | null | undefined): string {
  const score = sunExposureScore(summary);
  if (!summary || score <= 0) return 'No daylight detected yet.';
  const risk = uvRiskLabel(summary).toLowerCase();
  const riskNote = risk !== 'low' ? ` UV risk was ${risk}.` : '';
  const label = String(summary.sunScoreLabel ?? '').toLowerCase();
  if (label.includes('morning') && score >= 70) return `Strong morning daylight signal.${riskNote}`;
  if (score >= 85) return `Excellent daylight signal.${riskNote}`;
  if (score >= 70) return `Useful daylight kept this score high.${riskNote}`;
  if (score >= 45) return `Some useful daylight; more low-UV time could score higher.${riskNote}`;
  return 'Low score: not much useful daylight yet.';
}

export function sunExposureScoreHelp(summary: SunExposureDailySummary | null | undefined): string {
  const score = sunExposureScore(summary);
  const risk = uvRiskLabel(summary).toLowerCase();
  if (risk === 'very high' || risk === 'high') {
    return `Higher daylight is better, but sustained high UV can cap or lower the score. UV risk was ${risk}, so protection guidance is shown separately.`;
  }
  if (risk === 'moderate') {
    return 'Higher daylight is better, with moderate UV risk tracked separately from the score color.';
  }
  if (score >= 70) return 'Useful low-UV daylight keeps this score high.';
  return 'Useful daylight raises this score; sustained high UV can cap or lower it.';
}

export function uvRiskScore(summary: SunExposureDailySummary | null | undefined): number {
  const raw = Number(summary?.uvRiskScore);
  if (Number.isFinite(raw)) return Math.max(0, Math.min(100, Math.round(raw)));

  const effectiveUv = Math.max(0, Number(summary?.effectiveUvMinutes ?? 0));
  const maxUv = Math.max(0, Number(summary?.uvIndexMax ?? 0));
  const highUv = Math.max(0, Number(summary?.highUvMinutes ?? 0));
  const veryHighUv = Math.max(0, Number(summary?.veryHighUvMinutes ?? 0));
  if (effectiveUv <= 0 && maxUv < 3 && highUv <= 0) return 0;
  const uvDosePoints = Math.min(70, (effectiveUv / 180) * 70);
  const peakPoints = Math.min(20, Math.max(0, maxUv - 3) / 8 * 20);
  const durationPoints = Math.min(10, highUv / 60 * 6 + veryHighUv / 30 * 4);
  return Math.max(0, Math.min(100, Math.round(uvDosePoints + peakPoints + durationPoints)));
}

export function uvRiskLabel(summary: SunExposureDailySummary | null | undefined): string {
  if (summary?.uvRiskLabel) return summary.uvRiskLabel;
  const score = uvRiskScore(summary);
  if (score >= 75) return 'Very high';
  if (score >= 50) return 'High';
  if (score >= 25) return 'Moderate';
  return 'Low';
}

export function uvRiskScoreColor(score: number): string {
  if (score >= 75) return '#DC2626';
  if (score >= 50) return '#EF4444';
  if (score >= 25) return '#F59E0B';
  if (score > 0) return '#22C55E';
  return '#94A3B8';
}

export interface SunVitaminDEstimate {
  iuEquivalent: number;
  label: 'none' | 'low' | 'moderate' | 'high';
  confidence: SunExposureDailySummary['confidence'];
  detail: string;
}

function roundToNearest(value: number, step: number): number {
  if (!Number.isFinite(value) || step <= 0) return 0;
  return Math.round(value / step) * step;
}

export function estimateSunVitaminD(summary: SunExposureDailySummary | null | undefined): SunVitaminDEstimate | null {
  if (!summary || !hasSunExposureSummaryData(summary)) return null;
  const openSkyMinutes = Math.max(0, Number(summary.openSkyEquivalentMinutes ?? 0));
  const effectiveUvMinutes = Math.max(0, Number(summary.effectiveUvMinutes ?? 0));
  const uvIndex = Math.max(
    0,
    Number(summary.uvIndexAverage ?? 0),
    Number(summary.uvIndexMax ?? 0) * 0.65,
  );
  if (openSkyMinutes <= 0 || uvIndex < 2.5) {
    return {
      iuEquivalent: 0,
      label: 'none',
      confidence: summary.confidence,
      detail: uvIndex < 2.5 ? 'UVB signal was too low for a meaningful estimate.' : 'No daylight exposure estimate was detected.',
    };
  }
  const uvEfficiency = Math.max(0.25, Math.min(1.15, uvIndex / 6));
  const confidenceMultiplier = summary.confidence === 'high' ? 1 : summary.confidence === 'medium' ? 0.72 : 0.48;
  const shadeAdjustedMinutes = Math.max(openSkyMinutes * uvEfficiency, effectiveUvMinutes * 0.45);
  const iuEquivalent = Math.max(0, Math.min(1200, roundToNearest(shadeAdjustedMinutes * 18 * confidenceMultiplier, 50)));
  const label: SunVitaminDEstimate['label'] = iuEquivalent >= 800 ? 'high'
    : iuEquivalent >= 400 ? 'moderate'
      : iuEquivalent > 0 ? 'low'
        : 'none';
  return {
    iuEquivalent,
    label,
    confidence: summary.confidence,
    detail: `${formatSunMinutes(estimatedOutdoorDaylightMinutes(summary))} daylight, adjusted by UV Index and estimate confidence.`,
  };
}

export function sunVitaminDEstimateLabel(estimate: SunVitaminDEstimate | null | undefined): string {
  if (!estimate) return 'No estimate';
  if (estimate.iuEquivalent <= 0) return 'Minimal';
  return `~${estimate.iuEquivalent} IU-eq`;
}

export function areaSunLabel(context: AreaSunContext | null | undefined): string {
  const type = context?.areaType ?? 'unknown';
  switch (type) {
    case 'indoor': return 'likely indoor';
    case 'vehicle': return 'vehicle';
    case 'dense_forest': return 'dense forest';
    case 'wooded_trail': return 'wooded trail';
    case 'park_mixed': return 'mixed park';
    case 'open_grass': return 'open grass';
    case 'beach': return 'beach';
    case 'snow': return 'snow';
    case 'water_edge': return 'water edge';
    case 'urban_street': return 'urban street';
    case 'sports_field': return 'sports field';
    default: return 'unknown area';
  }
}

export function coefficientCopy(context: AreaSunContext | null | undefined): string {
  if (!context) return 'Area context was unknown, so the estimate used partial sun rather than full sun.';
  const skyPct = Math.round(context.skyExposureCoefficient * 100);
  const reflectionPct = Math.round((context.reflectionCoefficient - 1) * 100);
  const shadeCopy = context.skyExposureCoefficient < 0.5
    ? 'mostly shaded'
    : context.skyExposureCoefficient >= 0.75
      ? 'mostly bright'
      : 'partial sun';
  const reflectionCopy = reflectionPct > 0
    ? ` with about ${reflectionPct}% reflective surface adjustment`
    : '';
  return `Estimated ${shadeCopy} context (${skyPct}% light coefficient${reflectionCopy}).`;
}

export function summaryCopy(summary: SunExposureDailySummary, options: { dayPhrase?: string } = {}): string[] {
  const estimatedDaylight = estimatedOutdoorDaylightMinutes(summary);
  const dayPhrase = options.dayPhrase ?? 'today';
  const morning = Math.max(0, Number(summary.morningDaylightMinutes ?? 0));
  const midday = Math.max(0, Number(summary.middayDaylightMinutes ?? 0));
  const afternoon = Math.max(0, Number(summary.afternoonDaylightMinutes ?? 0));
  const timingTotal = morning + midday + afternoon;
  const timingScale = estimatedDaylight > 0 && timingTotal > estimatedDaylight
    ? estimatedDaylight / timingTotal
    : 1;
  const displayMorning = morning * timingScale;
  const displayMidday = midday * timingScale;
  const displayAfternoon = afternoon * timingScale;
  const highUvRaw = Math.max(0, Number(summary.highUvMinutes ?? 0));
  const veryHighUvRaw = Math.max(0, Number(summary.veryHighUvMinutes ?? 0));
  const highUv = estimatedDaylight > 0 ? Math.min(highUvRaw, estimatedDaylight) : highUvRaw;
  const veryHighUv = estimatedDaylight > 0 ? Math.min(veryHighUvRaw, estimatedDaylight) : veryHighUvRaw;
  const timingLine = displayMorning >= displayMidday && displayMorning >= displayAfternoon && displayMorning >= 10
    ? `Most of your recorded daylight was in the morning (${formatSunMinutes(displayMorning)}).`
    : displayMidday >= displayMorning && displayMidday >= displayAfternoon && displayMidday >= 10
      ? `Most of your recorded daylight was around midday (${formatSunMinutes(displayMidday)}).`
      : displayAfternoon >= 10
        ? `Most of your recorded daylight was later in the day (${formatSunMinutes(displayAfternoon)}).`
        : null;
  const uvLine = veryHighUv >= 10
    ? `Your recorded daylight included ${formatSunMinutes(veryHighUv)} at very high UV.`
    : highUv >= 20
      ? `Your recorded daylight included ${formatSunMinutes(highUv)} at UV 3 or higher.`
      : null;
  const lines = [
    `You had ${formatSunMinutes(estimatedDaylight)} daylight ${dayPhrase}.`,
    sunExposureScoreHelp(summary),
    'It is not a raw UV risk score: too little daylight scores low, while longer high-UV windows can cap or lower an otherwise useful daylight score.',
    'The score uses daylight time, Apple light-intensity metadata when available, and UV Index.',
  ];
  if (timingLine) {
    lines.splice(1, 0, timingLine);
  }
  if (uvLine) {
    lines.splice(timingLine ? 2 : 1, 0, uvLine);
  }
  if (summary.safetyMessage) {
    lines.splice(1, 0, summary.safetyMessage);
  }
  return lines;
}

export function correctionLabel(option: SunExposureCorrectionOption): string {
  switch (option) {
    case 'mostly_sunny': return 'Mostly sunny';
    case 'mixed': return 'Mixed';
    case 'mostly_shaded': return 'Mostly shaded';
    case 'indoors': return 'I was indoors';
    case 'wrong_activity': return 'This activity is wrong';
    case 'dismiss': return 'Dismiss';
  }
}

export function assertSunExposureCopyIsSafe(copy: string): boolean {
  const lowered = copy.toLowerCase();
  return !lowered.includes('we know you were outside')
    && !lowered.includes('knows you were outside')
    && !lowered.includes('vitamin d dose')
    && !lowered.includes('safe sun exposure');
}
