import {
  buildBodyMeasurementsCheckinPayload,
  EMPTY_MEASUREMENT_FIELDS,
  optionalPositiveNumber,
  profileWeightForMeasurements,
} from '../bodyMeasurements.ts';

describe('body measurement check-in payload', () => {
  it('uses the current profile weight and opts out of profile-weight promotion', () => {
    const payload = buildBodyMeasurementsCheckinPayload({
      currentWeight: 181.5,
      date: '2026-05-02T14:30:00.000Z',
      fields: {
        ...EMPTY_MEASUREMENT_FIELDS,
        waist: '32.5',
        bodyFat: '17',
      },
    });

    expect(payload).toEqual({
      checkin_date: '2026-05-02',
      weight_lbs: 181.5,
      update_profile_weight: false,
      energy: 3,
      sleep: 3,
      adherence: 3,
      waist_in: 32.5,
      body_fat_pct: 17,
    });
  });

  it('rejects missing, non-finite, or non-positive profile weights', () => {
    expect(profileWeightForMeasurements(undefined)).toBe(null);
    expect(profileWeightForMeasurements(Number.NaN)).toBe(null);
    expect(profileWeightForMeasurements(0)).toBe(null);
    expect(profileWeightForMeasurements(-4)).toBe(null);
  });

  it('does not build a payload when Body weight is unavailable', () => {
    const payload = buildBodyMeasurementsCheckinPayload({
      currentWeight: null,
      date: '2026-05-02',
      fields: EMPTY_MEASUREMENT_FIELDS,
    });

    expect(payload).toBe(null);
  });

  it('only includes positive finite measurement fields', () => {
    const payload = buildBodyMeasurementsCheckinPayload({
      currentWeight: 180,
      date: '2026-05-02',
      fields: {
        waist: '31.75',
        chest: '',
        hips: 'not-a-number',
        bicep: '-2',
        thigh: '0',
        calf: '15',
        bodyFat: 'Infinity',
      },
    });

    expect(payload).toEqual({
      checkin_date: '2026-05-02',
      weight_lbs: 180,
      update_profile_weight: false,
      energy: 3,
      sleep: 3,
      adherence: 3,
      waist_in: 31.75,
      calf_in: 15,
    });
  });

  it('parses optional positive numbers conservatively', () => {
    expect(optionalPositiveNumber(' 12.25 ')).toBe(12.25);
    expect(optionalPositiveNumber('12abc')).toBe(undefined);
    expect(optionalPositiveNumber('')).toBe(undefined);
  });
});
