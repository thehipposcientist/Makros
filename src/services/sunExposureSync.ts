import AsyncStorage from '@react-native-async-storage/async-storage';
import { createSunExposureSegment, getSunExposurePreferences, listSunExposureSegments } from './api';
import { getAppleHealthTimeInDaylight, isHealthKitAvailable, type AppleHealthDaylightSample } from './appleHealth';
import type { SunExposurePreferences, SunExposureSegment } from '../types';

export const SUN_EXPOSURE_SYNC_INTERVAL_MS = 5 * 60_000;

const LIVE_LOCATION_SYNC_STATE_KEY = 'sunExposure.liveLocationSyncState.v1';
const LIVE_LOCATION_MAX_WINDOW_MS = 10 * 60_000;
const LIVE_LOCATION_DEFAULT_WINDOW_MS = SUN_EXPOSURE_SYNC_INTERVAL_MS;

interface LiveLocationSyncState {
  dayISO: string;
  lastSyncMs: number;
}

interface WeatherSunContext {
  uvIndex: number | null;
  cloudCover: number | null;
  precipitation: number | null;
  isDay: boolean | null;
}

interface WeatherSunPoint extends WeatherSunContext {
  timeMs: number;
}

type WeatherSunSeries = WeatherSunPoint[];

interface ForegroundLocation {
  lat: number;
  lon: number;
  accuracyM: number | null;
  speedMps: number | null;
}

let liveLocationSyncInFlight: Promise<{ created: number; available: boolean }> | null = null;

function localDayWindow(dayISO: string): { startMs: number; endMs: number } {
  const [year, month, day] = dayISO.slice(0, 10).split('-').map(Number);
  const start = new Date(year, (month || 1) - 1, day || 1);
  return { startMs: start.getTime(), endMs: start.getTime() + 86400000 };
}

function localISODate(value = new Date()): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localMinuteOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

function timezoneOffsetMinutes(ms: number): number {
  return new Date(ms).getTimezoneOffset();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundCoord(value: number): number {
  return Math.round(value * 100) / 100;
}

function coarseLocationHash(lat: number, lon: number): string {
  const latBucket = roundCoord(lat).toFixed(2);
  const lonBucket = roundCoord(lon).toFixed(2);
  return `lat:${latBucket}:lon:${lonBucket}`;
}

async function readLiveLocationState(): Promise<LiveLocationSyncState | null> {
  try {
    const raw = await AsyncStorage.getItem(LIVE_LOCATION_SYNC_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const dayISO = String(parsed?.dayISO ?? '');
    const lastSyncMs = Number(parsed?.lastSyncMs ?? 0);
    if (!dayISO || !Number.isFinite(lastSyncMs) || lastSyncMs <= 0) return null;
    return { dayISO, lastSyncMs };
  } catch {
    return null;
  }
}

async function writeLiveLocationState(state: LiveLocationSyncState): Promise<void> {
  try {
    await AsyncStorage.setItem(LIVE_LOCATION_SYNC_STATE_KEY, JSON.stringify(state));
  } catch {}
}

function fallbackIsDaylight(date = new Date()): boolean {
  const hour = date.getHours();
  return hour >= 6 && hour < 20;
}

async function fetchWeatherSunContext(lat: number, lon: number): Promise<WeatherSunContext | null> {
  try {
    const params = new URLSearchParams({
      latitude: String(roundCoord(lat)),
      longitude: String(roundCoord(lon)),
      current: 'uv_index,cloud_cover,precipitation,is_day',
      timezone: 'auto',
      forecast_days: '1',
    });
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
    if (!response.ok) return null;
    const data = await response.json();
    const current = data?.current && typeof data.current === 'object' ? data.current : {};
    const uvIndex = finiteNumber(current.uv_index);
    const cloudCover = finiteNumber(current.cloud_cover);
    const precipitation = finiteNumber(current.precipitation);
    const isDayRaw = finiteNumber(current.is_day);
    return {
      uvIndex: uvIndex == null ? null : clamp(uvIndex, 0, 20),
      cloudCover: cloudCover == null ? null : clamp(cloudCover, 0, 100),
      precipitation: precipitation == null ? null : Math.max(0, precipitation),
      isDay: isDayRaw == null ? null : isDayRaw >= 1,
    };
  } catch {
    return null;
  }
}

function parseWeatherTimeMs(value: unknown): number | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const ms = Date.parse(raw.endsWith('Z') ? raw : `${raw}Z`);
  return Number.isFinite(ms) ? ms : null;
}

async function fetchWeatherSunSeries(lat: number, lon: number, dayISO: string): Promise<WeatherSunSeries | null> {
  try {
    const params = new URLSearchParams({
      latitude: String(roundCoord(lat)),
      longitude: String(roundCoord(lon)),
      hourly: 'uv_index,cloud_cover,precipitation,is_day',
      timezone: 'UTC',
      start_date: dayISO.slice(0, 10),
      end_date: dayISO.slice(0, 10),
    });
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
    if (!response.ok) return null;
    const data = await response.json();
    const hourly = data?.hourly && typeof data.hourly === 'object' ? data.hourly : {};
    const times = Array.isArray(hourly.time) ? hourly.time : [];
    const series: WeatherSunSeries = [];
    for (let i = 0; i < times.length; i += 1) {
      const timeMs = parseWeatherTimeMs(times[i]);
      if (timeMs == null) continue;
      const uvIndex = finiteNumber(Array.isArray(hourly.uv_index) ? hourly.uv_index[i] : null);
      const cloudCover = finiteNumber(Array.isArray(hourly.cloud_cover) ? hourly.cloud_cover[i] : null);
      const precipitation = finiteNumber(Array.isArray(hourly.precipitation) ? hourly.precipitation[i] : null);
      const isDayRaw = finiteNumber(Array.isArray(hourly.is_day) ? hourly.is_day[i] : null);
      series.push({
        timeMs,
        uvIndex: uvIndex == null ? null : clamp(uvIndex, 0, 20),
        cloudCover: cloudCover == null ? null : clamp(cloudCover, 0, 100),
        precipitation: precipitation == null ? null : Math.max(0, precipitation),
        isDay: isDayRaw == null ? null : isDayRaw >= 1,
      });
    }
    return series.length > 0 ? series : null;
  } catch {
    return null;
  }
}

function weatherForInterval(series: WeatherSunSeries | null | undefined, startTime: string, endTime: string): {
  uvAverage: number | null;
  uvMax: number | null;
  cloudCover: number | null;
  precipitation: number | null;
  isDay: boolean | null;
} | null {
  if (!series || series.length === 0) return null;
  const startMs = new Date(startTime).getTime();
  const endMs = new Date(endTime).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

  let weightMs = 0;
  let uvWeighted = 0;
  let uvMax: number | null = null;
  let cloudWeighted = 0;
  let cloudWeightMs = 0;
  let precipitationWeighted = 0;
  let precipitationWeightMs = 0;
  let dayVotes = 0;
  let dayWeightMs = 0;

  for (const point of series) {
    const pointStart = point.timeMs;
    const pointEnd = point.timeMs + 60 * 60_000;
    const overlap = Math.max(0, Math.min(endMs, pointEnd) - Math.max(startMs, pointStart));
    if (overlap <= 0) continue;
    if (point.uvIndex != null) {
      uvWeighted += point.uvIndex * overlap;
      weightMs += overlap;
      uvMax = uvMax == null ? point.uvIndex : Math.max(uvMax, point.uvIndex);
    }
    if (point.cloudCover != null) {
      cloudWeighted += point.cloudCover * overlap;
      cloudWeightMs += overlap;
    }
    if (point.precipitation != null) {
      precipitationWeighted += point.precipitation * overlap;
      precipitationWeightMs += overlap;
    }
    if (point.isDay != null) {
      dayVotes += point.isDay ? overlap : 0;
      dayWeightMs += overlap;
    }
  }

  if (weightMs <= 0 && cloudWeightMs <= 0 && precipitationWeightMs <= 0 && dayWeightMs <= 0) return null;
  return {
    uvAverage: weightMs > 0 ? Math.round((uvWeighted / weightMs) * 10) / 10 : null,
    uvMax: uvMax == null ? null : Math.round(uvMax * 10) / 10,
    cloudCover: cloudWeightMs > 0 ? Math.round((cloudWeighted / cloudWeightMs) * 10) / 10 : null,
    precipitation: precipitationWeightMs > 0 ? Math.round((precipitationWeighted / precipitationWeightMs) * 100) / 100 : null,
    isDay: dayWeightMs > 0 ? dayVotes / dayWeightMs >= 0.5 : null,
  };
}

function estimateLocationOutdoorConfidence(input: {
  accuracyM: number | null;
  speedMps: number | null;
  precipitation: number | null;
  isDaylight: boolean;
}): number {
  if (!input.isDaylight) return 0;
  if (input.accuracyM != null && input.accuracyM > 500) return 0.15;
  if (input.speedMps != null && input.speedMps >= 13) return 0.10;

  let confidence = 0.38;
  if (input.accuracyM != null && input.accuracyM <= 75) confidence += 0.07;
  if (input.speedMps != null && input.speedMps >= 0.4 && input.speedMps <= 4.5) confidence += 0.12;
  if (input.speedMps != null && input.speedMps > 4.5 && input.speedMps < 13) confidence += 0.08;
  if (input.precipitation != null && input.precipitation > 1) confidence -= 0.08;
  return clamp(confidence, 0.20, 0.60);
}

async function getCurrentForegroundLocation(): Promise<{
  lat: number;
  lon: number;
  accuracyM: number | null;
  speedMps: number | null;
} | null> {
  let Location: any;
  try {
    Location = await import('expo-location' as any);
  } catch {
    return null;
  }

  const existing = await Location.getForegroundPermissionsAsync();
  let status = String(existing?.status ?? '');
  if (status !== 'granted') {
    const requested = await Location.requestForegroundPermissionsAsync();
    status = String(requested?.status ?? '');
  }
  if (status !== 'granted') return null;

  const loc = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy?.Balanced ?? Location.LocationAccuracy?.Balanced ?? 3,
    mayShowUserSettingsDialog: true,
  });
  const lat = finiteNumber(loc?.coords?.latitude);
  const lon = finiteNumber(loc?.coords?.longitude);
  if (lat == null || lon == null) return null;
  const accuracyM = finiteNumber(loc?.coords?.accuracy);
  const speedMps = finiteNumber(loc?.coords?.speed);
  return { lat, lon, accuracyM, speedMps };
}

function normalizedDaylightSample(sample: AppleHealthDaylightSample): {
  startTime: string;
  endTime: string;
  durationMinutes: number;
  maximumLightIntensityLux: number | null;
} | null {
  const startMs = new Date(sample.startDate).getTime();
  const endMs = new Date(sample.endDate).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

  const intervalMinutes = (endMs - startMs) / 60000;
  const valueMinutes = Number(sample.value);
  const durationMinutes = Math.max(0, Math.min(
    Number.isFinite(valueMinutes) && valueMinutes > 0 ? valueMinutes : intervalMinutes,
    intervalMinutes,
  ));
  if (durationMinutes < 1) return null;

  return {
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(endMs).toISOString(),
    durationMinutes: Math.round(durationMinutes * 10) / 10,
    maximumLightIntensityLux: finiteNumber(sample.maximumLightIntensityLux),
  };
}

type NormalizedDaylightSample = NonNullable<ReturnType<typeof normalizedDaylightSample>>;

function sameMinute(a: string, b: string): boolean {
  const aMs = new Date(a).getTime();
  const bMs = new Date(b).getTime();
  return Number.isFinite(aMs) && Number.isFinite(bMs) && Math.abs(aMs - bMs) < 60000;
}

function matchingHealthDaylightSegment(
  existing: SunExposureSegment[],
  sample: NormalizedDaylightSample,
): SunExposureSegment | null {
  return existing.find((segment) => (
    segment.source === 'healthkit_daylight'
    && sameMinute(segment.startTime, sample.startTime)
    && sameMinute(segment.endTime, sample.endTime)
  )) ?? null;
}

export async function syncHealthKitDaylightSunExposure(
  token: string,
  dayISO: string,
  options: {
    location?: ForegroundLocation | null;
    weatherSeries?: WeatherSunSeries | null;
  } = {},
): Promise<{ created: number; available: boolean }> {
  if (!isHealthKitAvailable()) return { created: 0, available: false };
  const { startMs, endMs } = localDayWindow(dayISO);
  const samples = await getAppleHealthTimeInDaylight(startMs, endMs);
  if (samples.length === 0) return { created: 0, available: true };

  const existing: SunExposureSegment[] = await listSunExposureSegments(token, dayISO).catch((): SunExposureSegment[] => []);
  let created = 0;
  for (const sample of samples.map(normalizedDaylightSample).filter((x): x is NormalizedDaylightSample => !!x)) {
    const sampleStartMs = new Date(sample.startTime).getTime();
    const sampleEndMs = new Date(sample.endTime).getTime();
    const matching = matchingHealthDaylightSegment(existing, sample);
    const weather = weatherForInterval(options.weatherSeries, sample.startTime, sample.endTime);
    const uvAverage = weather?.uvAverage ?? 0;
    const uvMax = weather?.uvMax ?? uvAverage;
    const sampleHasLux = Number(sample.maximumLightIntensityLux ?? 0) > 0;
    const matchingHasLux = Number(matching?.lightIntensityLux ?? 0) > 0;
    const matchingHasUv = Number(matching?.uvIndexMax ?? 0) > 0;
    if (matching && (uvMax <= 0 || matchingHasUv) && (!sampleHasLux || matchingHasLux)) continue;
    try {
      const segment = await createSunExposureSegment(token, {
        startTime: sample.startTime,
        endTime: sample.endTime,
        durationMinutes: sample.durationMinutes,
        coarseLocationHash: options.location ? coarseLocationHash(options.location.lat, options.location.lon) : undefined,
        uvIndexAverage: uvAverage,
        uvIndexMax: uvMax,
        lightIntensityLux: sample.maximumLightIntensityLux ?? undefined,
        localStartMinute: localMinuteOfDay(sampleStartMs),
        localEndMinute: localMinuteOfDay(sampleEndMs),
        timezoneOffsetMinutes: timezoneOffsetMinutes(sampleStartMs),
        daylight: true,
        source: 'healthkit_daylight',
        areaHints: {
          healthkitDaylightMinutes: sample.durationMinutes,
          maximumLightIntensityLux: sample.maximumLightIntensityLux,
          cloudCoverPercent: weather?.cloudCover ?? null,
          precipitationMm: weather?.precipitation ?? null,
          weatherDaylight: weather?.isDay ?? null,
        },
      });
      existing.push(segment);
      if (!matching) created += 1;
    } catch {
      break;
    }
  }
  return { created, available: true };
}

export async function syncLiveLocationSunExposure(
  token: string,
  dayISO: string,
): Promise<{ created: number; available: boolean }> {
  if (liveLocationSyncInFlight) return liveLocationSyncInFlight;
  liveLocationSyncInFlight = syncLiveLocationSunExposureImpl(token, dayISO)
    .finally(() => { liveLocationSyncInFlight = null; });
  return liveLocationSyncInFlight;
}

async function syncLiveLocationSunExposureImpl(
  token: string,
  dayISO: string,
): Promise<{ created: number; available: boolean }> {
  const nowMs = Date.now();
  const { startMs: dayStartMs, endMs: dayEndMs } = localDayWindow(dayISO);
  if (nowMs < dayStartMs || nowMs > dayEndMs) return { created: 0, available: true };

  const state = await readLiveLocationState();
  const previousMs = state?.dayISO === dayISO ? state.lastSyncMs : null;
  const startMs = Math.max(
    dayStartMs,
    previousMs == null
      ? nowMs - LIVE_LOCATION_DEFAULT_WINDOW_MS
      : Math.min(previousMs, nowMs - 60_000),
    nowMs - LIVE_LOCATION_MAX_WINDOW_MS,
  );
  const durationMinutes = Math.round(((nowMs - startMs) / 60000) * 10) / 10;
  if (durationMinutes < 1) return { created: 0, available: true };

  const location = await getCurrentForegroundLocation();
  if (!location) return { created: 0, available: false };

  const weather = await fetchWeatherSunContext(location.lat, location.lon);
  const isDaylight = weather?.isDay ?? fallbackIsDaylight(new Date(nowMs));
  if (!isDaylight) {
    await writeLiveLocationState({ dayISO, lastSyncMs: nowMs });
    return { created: 0, available: true };
  }

  const outdoorConfidence = estimateLocationOutdoorConfidence({
    accuracyM: location.accuracyM,
    speedMps: location.speedMps,
    precipitation: weather?.precipitation ?? null,
    isDaylight,
  });
  if (outdoorConfidence <= 0) {
    await writeLiveLocationState({ dayISO, lastSyncMs: nowMs });
    return { created: 0, available: true };
  }

  const isLikelyVehicle = location.speedMps != null && location.speedMps >= 13;
  try {
    await createSunExposureSegment(token, {
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(nowMs).toISOString(),
      durationMinutes,
      coarseLocationHash: coarseLocationHash(location.lat, location.lon),
      uvIndexAverage: weather?.uvIndex ?? 0,
      uvIndexMax: weather?.uvIndex ?? 0,
      localStartMinute: localMinuteOfDay(startMs),
      localEndMinute: localMinuteOfDay(nowMs),
      timezoneOffsetMinutes: timezoneOffsetMinutes(startMs),
      daylight: true,
      outdoorConfidence,
      source: 'coarse_location',
      areaHints: {
        source: 'coarse_location',
        vehicle: isLikelyVehicle,
        motion: location.speedMps != null && location.speedMps >= 0.4 ? 'moving' : 'stationary',
        locationAccuracyM: location.accuracyM,
        cloudCoverPercent: weather?.cloudCover ?? null,
        precipitationMm: weather?.precipitation ?? null,
      },
    });
    await writeLiveLocationState({ dayISO, lastSyncMs: nowMs });
    return { created: 1, available: true };
  } catch {
    return { created: 0, available: true };
  }
}

export async function syncSunExposureForToday(
  token: string,
  options: {
    dayISO?: string;
    preferences?: SunExposurePreferences | null;
    includeHealthKit?: boolean;
    includeLiveLocation?: boolean;
  } = {},
): Promise<{
  healthKitCreated: number;
  liveLocationCreated: number;
  healthKitAvailable: boolean;
  liveLocationAvailable: boolean;
}> {
  const dayISO = options.dayISO ?? localISODate();
  const preferences = options.preferences ?? await getSunExposurePreferences(token).catch(() => null);
  if (!preferences?.enabled) {
    return {
      healthKitCreated: 0,
      liveLocationCreated: 0,
      healthKitAvailable: false,
      liveLocationAvailable: false,
    };
  }

  let healthKitCreated = 0;
  let liveLocationCreated = 0;
  let healthKitAvailable = false;
  let liveLocationAvailable = false;
  const needsLocation = preferences.useCoarseLocation
    && (
      (options.includeHealthKit !== false && preferences.useHealthDaylightData)
      || options.includeLiveLocation !== false
    );
  const location = needsLocation ? await getCurrentForegroundLocation().catch(() => null) : null;
  const weatherSeries = location ? await fetchWeatherSunSeries(location.lat, location.lon, dayISO).catch(() => null) : null;

  if (options.includeHealthKit !== false && preferences.useHealthDaylightData) {
    const result = await syncHealthKitDaylightSunExposure(token, dayISO, { location, weatherSeries }).catch(() => ({ created: 0, available: false }));
    healthKitCreated = result.created;
    healthKitAvailable = result.available;
  }

  if (options.includeLiveLocation !== false && preferences.useCoarseLocation) {
    const result = await syncLiveLocationSunExposure(token, dayISO).catch(() => ({ created: 0, available: false }));
    liveLocationCreated = result.created;
    liveLocationAvailable = result.available;
  }

  return {
    healthKitCreated,
    liveLocationCreated,
    healthKitAvailable,
    liveLocationAvailable,
  };
}
