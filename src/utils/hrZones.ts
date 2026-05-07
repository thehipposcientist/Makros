import type { HRZone } from '../services/api';

export const HR_ZONE_COLORS = ['#38BDF8', '#22C55E', '#EAB308', '#F97316', '#EF4444'] as const;

export function hrZoneColorHex(zone: number | null | undefined, fallback = '#38BDF8'): string {
  if (!Number.isFinite(Number(zone))) return fallback;
  const idx = Math.max(0, Math.min(4, Math.round(Number(zone)) - 1));
  return HR_ZONE_COLORS[idx] ?? fallback;
}

export function zoneForHeartRate(bpm: number | null | undefined, zones: HRZone[] | null | undefined): HRZone | null {
  const value = Number(bpm);
  if (!Number.isFinite(value) || value <= 0 || !Array.isArray(zones) || zones.length === 0) return null;
  const sorted = zones
    .filter(z => Number.isFinite(Number(z.zone)) && Number.isFinite(Number(z.low)) && Number.isFinite(Number(z.high)))
    .sort((a, b) => Number(a.zone) - Number(b.zone));
  if (sorted.length === 0) return null;
  const match = sorted.find(z => value >= Number(z.low) && value <= Number(z.high));
  if (match) return match;
  if (value < Number(sorted[0].low)) return sorted[0];
  return sorted[sorted.length - 1];
}

export function hrZoneRangeText(zone: HRZone | null | undefined): string | null {
  if (!zone) return null;
  const low = Math.round(Number(zone.low));
  const high = Math.round(Number(zone.high));
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return `${low}-${high} bpm`;
}

export function liveActivityHrZoneFields(
  bpm: number | null | undefined,
  zones: HRZone[] | null | undefined,
): {
  heartRate?: number;
  hrZone?: number;
  hrZoneLabel?: string;
  hrZoneLow?: number;
  hrZoneHigh?: number;
  hrZoneColorHex?: string;
} {
  const heartRate = Number(bpm);
  if (!Number.isFinite(heartRate) || heartRate <= 0) return {};
  const zone = zoneForHeartRate(heartRate, zones);
  if (!zone) return { heartRate: Math.round(heartRate) };
  return {
    heartRate: Math.round(heartRate),
    hrZone: Math.round(Number(zone.zone)),
    hrZoneLabel: zone.label,
    hrZoneLow: Math.round(Number(zone.low)),
    hrZoneHigh: Math.round(Number(zone.high)),
    hrZoneColorHex: hrZoneColorHex(zone.zone),
  };
}
