import { StrengthEquipmentSettings } from '../types';

export const PLATE_PAIR_OPTIONS_LBS = [55, 45, 35, 25, 10, 5, 2.5, 1.25];
export const DEFAULT_PLATE_PAIRS_LBS = [45, 35, 25, 10, 5, 2.5];

export const DEFAULT_ADJUSTABLE_DUMBBELLS = {
  type: 'adjustable' as const,
  minLbs: 5,
  maxLbs: 52.5,
  incrementLbs: 2.5,
};

function equipmentNameSet(equipment: string[]) {
  return new Set(equipment.map(e => e.toLowerCase().trim()));
}

export function hasAdjustableDumbbells(equipment: string[]): boolean {
  const names = equipmentNameSet(equipment);
  return names.has('adjustable dumbbells') || names.has('adjustable_dumbbells');
}

export function hasPlateLoadedEquipment(equipment: string[]): boolean {
  const names = equipmentNameSet(equipment);
  return [
    'barbell',
    'ez curl bar',
    'trap bar',
    'smith machine',
    'weight plates',
    'weight_plates',
  ].some(name => names.has(name));
}

function validNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function validPlatePairs(value: unknown): number[] {
  if (!Array.isArray(value)) return DEFAULT_PLATE_PAIRS_LBS;
  const cleaned = value
    .map(v => validNumber(v, 0))
    .filter(v => v > 0);
  return cleaned.length ? Array.from(new Set(cleaned)).sort((a, b) => b - a) : DEFAULT_PLATE_PAIRS_LBS;
}

export function normalizeStrengthEquipmentSettings(
  settings: StrengthEquipmentSettings | undefined,
  equipment: string[],
): StrengthEquipmentSettings | undefined {
  const next: StrengthEquipmentSettings = {};

  if (hasAdjustableDumbbells(equipment)) {
    next.dumbbells = {
      type: 'adjustable',
      minLbs: validNumber(settings?.dumbbells?.minLbs, DEFAULT_ADJUSTABLE_DUMBBELLS.minLbs),
      maxLbs: validNumber(settings?.dumbbells?.maxLbs, DEFAULT_ADJUSTABLE_DUMBBELLS.maxLbs),
      incrementLbs: validNumber(settings?.dumbbells?.incrementLbs, DEFAULT_ADJUSTABLE_DUMBBELLS.incrementLbs),
    };
  }

  if (hasPlateLoadedEquipment(equipment)) {
    next.barbell = {
      barWeightLbs: validNumber(settings?.barbell?.barWeightLbs, 45),
      platePairsLbs: validPlatePairs(settings?.barbell?.platePairsLbs),
      ...(settings?.barbell?.maxLoadLbs ? { maxLoadLbs: validNumber(settings.barbell.maxLoadLbs, 0) } : {}),
    };
  }

  return next.dumbbells || next.barbell ? next : undefined;
}
