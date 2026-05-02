export interface MeasurementFields {
  waist: string;
  chest: string;
  hips: string;
  bicep: string;
  thigh: string;
  calf: string;
  bodyFat: string;
}

export const EMPTY_MEASUREMENT_FIELDS: MeasurementFields = {
  waist: '',
  chest: '',
  hips: '',
  bicep: '',
  thigh: '',
  calf: '',
  bodyFat: '',
};

export interface BodyMeasurementsCheckinPayload {
  checkin_date: string;
  weight_lbs: number;
  update_profile_weight: false;
  waist_in?: number;
  chest_in?: number;
  hips_in?: number;
  bicep_in?: number;
  thigh_in?: number;
  calf_in?: number;
  body_fat_pct?: number;
  energy: number;
  sleep: number;
  adherence: number;
}

export function profileWeightForMeasurements(currentWeight: unknown): number | null {
  return typeof currentWeight === 'number' && Number.isFinite(currentWeight) && currentWeight > 0
    ? currentWeight
    : null;
}

export function optionalPositiveNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isoDate(dateInput: Date | string): string {
  return typeof dateInput === 'string' ? dateInput.slice(0, 10) : dateInput.toISOString().slice(0, 10);
}

export function buildBodyMeasurementsCheckinPayload({
  currentWeight,
  fields,
  date = new Date(),
}: {
  currentWeight: unknown;
  fields: MeasurementFields;
  date?: Date | string;
}): BodyMeasurementsCheckinPayload | null {
  const profileWeight = profileWeightForMeasurements(currentWeight);
  if (profileWeight == null) return null;

  const payload: BodyMeasurementsCheckinPayload = {
    checkin_date: isoDate(date),
    weight_lbs: profileWeight,
    update_profile_weight: false,
    energy: 3,
    sleep: 3,
    adherence: 3,
  };

  const waist = optionalPositiveNumber(fields.waist);
  const chest = optionalPositiveNumber(fields.chest);
  const hips = optionalPositiveNumber(fields.hips);
  const bicep = optionalPositiveNumber(fields.bicep);
  const thigh = optionalPositiveNumber(fields.thigh);
  const calf = optionalPositiveNumber(fields.calf);
  const bodyFat = optionalPositiveNumber(fields.bodyFat);

  if (waist !== undefined) payload.waist_in = waist;
  if (chest !== undefined) payload.chest_in = chest;
  if (hips !== undefined) payload.hips_in = hips;
  if (bicep !== undefined) payload.bicep_in = bicep;
  if (thigh !== undefined) payload.thigh_in = thigh;
  if (calf !== undefined) payload.calf_in = calf;
  if (bodyFat !== undefined) payload.body_fat_pct = bodyFat;

  return payload;
}
