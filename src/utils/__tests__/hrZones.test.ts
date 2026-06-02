// Heart-rate zone tests. The TS module is the canonical source of
// truth; the backend `compute_hr_zones` mirrors these formulas. The
// final `frontend/backend parity` block hard-codes representative
// inputs and the resulting zones — if the backend ever drifts, those
// tests fail and we pick it up before users see misaligned numbers.
//
// Method: %MHR (5 zones, Apple/Garmin/Whoop convention).

import {
  computeHrZones,
  estimateMaxHRTanaka,
  HR_ZONE_BANDS,
  HR_ZONE_COLORS,
  hrZoneColorHex,
  resolveMaxHR,
  resolveRestingHR,
  zoneForHeartRate,
} from '../hrZones.ts';

describe('estimateMaxHRTanaka', () => {
  it('30 yo → 187 bpm', () => {
    expect(estimateMaxHRTanaka(30)).toBe(187);
  });
  it('50 yo → 173 bpm', () => {
    expect(estimateMaxHRTanaka(50)).toBe(173);
  });
});

describe('resolveMaxHR — priority chain', () => {
  it('user-entered wins over observed and estimate', () => {
    const r = resolveMaxHR({ age: 30, userMaxHR: 200, observedMaxHR: 192 });
    expect(r.maxHR).toBe(200);
    expect(r.source).toBe('user_entered');
  });
  it('observed wins over estimate when no user-entered value', () => {
    const r = resolveMaxHR({ age: 30, observedMaxHR: 192 });
    expect(r.maxHR).toBe(192);
    expect(r.source).toBe('observed');
  });
  it('falls back to Tanaka estimate when only age is present', () => {
    const r = resolveMaxHR({ age: 30 });
    expect(r.maxHR).toBe(187);
    expect(r.source).toBe('estimated_tanaka');
  });
  it('falls back to 190 when age is also missing', () => {
    const r = resolveMaxHR({ age: null });
    expect(r.maxHR).toBe(190);
    expect(r.source).toBe('estimated_tanaka');
  });
  it('rejects non-positive overrides', () => {
    const r = resolveMaxHR({ age: 30, userMaxHR: 0, observedMaxHR: -5 });
    expect(r.maxHR).toBe(187);
    expect(r.source).toBe('estimated_tanaka');
  });
});

describe('resolveRestingHR — priority chain (display only)', () => {
  it('7-day Apple Health wins over 30-day and profile', () => {
    const r = resolveRestingHR({ age: 30, rhr7d: 55, rhr30d: 58, profileRHR: 62 });
    expect(r.restingHR).toBe(55);
    expect(r.source).toBe('apple_health_7d');
  });
  it('30-day wins when 7-day missing', () => {
    const r = resolveRestingHR({ age: 30, rhr30d: 58, profileRHR: 62 });
    expect(r.restingHR).toBe(58);
    expect(r.source).toBe('apple_health_30d');
  });
  it('profile RHR is used when no Apple Health data', () => {
    const r = resolveRestingHR({ age: 30, profileRHR: 62 });
    expect(r.restingHR).toBe(62);
    expect(r.source).toBe('user_profile');
  });
  it('falls back to 60 when nothing is provided', () => {
    const r = resolveRestingHR({ age: 30 });
    expect(r.restingHR).toBe(60);
    expect(r.source).toBe('fallback');
  });
});

describe('computeHrZones — canonical 30/60/190 case', () => {
  // Spec example from the audit: 30-year-old, RHR 60, MHR 190.
  // Boundaries at 50/60/70/80/90/100% of 190 land on integer bpm.
  const result = computeHrZones({ age: 30, userMaxHR: 190, profileRHR: 60 });

  it('uses %MHR and reports source metadata', () => {
    expect(result.method).toBe('pct_max_hr');
    expect(result.maxHR).toBe(190);
    expect(result.restingHR).toBe(60);
    expect(result.maxHRSource).toBe('user_entered');
    expect(result.restingHRSource).toBe('user_profile');
  });

  it('returns 5 zones (Z1..Z5) with the expected boundaries', () => {
    expect(result.zones.length).toBe(5);
    // 0.5×190 = 95, 0.6×190 = 114, 0.7×190 = 133, 0.8×190 = 152, 0.9×190 = 171.
    expect(result.zones.map(z => [z.zone, z.label, z.low, z.high])).toEqual([
      [1, 'Warm Up',   95,  114],
      [2, 'Easy',      114, 133],
      [3, 'Aerobic',   133, 152],
      [4, 'Threshold', 152, 171],
      [5, 'Maximum',   171, 190],
    ]);
  });

  it('does NOT use legacy %HRR labels', () => {
    const legacy = ['fat burn', 'recovery', 'very easy', 'aerobic base', 'tempo', 'vo₂ max'];
    for (const z of result.zones) {
      for (const label of legacy) {
        expect(z.label.toLowerCase().includes(label)).toBe(false);
      }
    }
  });
});

describe('computeHrZones — 138 bpm reads as Aerobic for the canonical user', () => {
  // The redesign's stated trigger: 138 bpm should not read as a
  // recovery / warm-up zone for an MHR-190 / RHR-60 user.
  const { zones } = computeHrZones({ age: 30, userMaxHR: 190, profileRHR: 60 });
  it('lands in Z3 "Aerobic"', () => {
    const z = zoneForHeartRate(138, zones);
    expect(z?.zone).toBe(3);
    expect(z?.label).toBe('Aerobic');
  });
});

describe('computeHrZones — fallback paths', () => {
  it('missing inputs fall through to MHR 190 / RHR 60 fallbacks', () => {
    const r = computeHrZones({ age: null });
    expect(r.maxHR).toBe(190);
    expect(r.restingHR).toBe(60);
    expect(r.restingHRSource).toBe('fallback');
    // Z1 low = 0.5 × 190 = 95.
    expect(r.zones[0].low).toBe(95);
  });

  it('user-specified maxHR overrides estimated maxHR', () => {
    const r = computeHrZones({ age: 30, userMaxHR: 200, profileRHR: 60 });
    expect(r.maxHR).toBe(200);
    expect(r.maxHRSource).toBe('user_entered');
    // Z5 low = 0.9 × 200 = 180; Z5 high closes at MHR.
    expect(r.zones[4].low).toBe(180);
    expect(r.zones[4].high).toBe(200);
  });
});

describe('zoneForHeartRate — half-open boundaries', () => {
  const { zones } = computeHrZones({ age: 30, userMaxHR: 190, profileRHR: 60 });

  it('values strictly inside a band map to that band', () => {
    expect(zoneForHeartRate(140, zones)?.zone).toBe(3);   // 73.7% MHR → Aerobic
    expect(zoneForHeartRate(160, zones)?.zone).toBe(4);   // 84.2% MHR → Threshold
  });

  it('a value sitting exactly on a boundary belongs to the higher zone', () => {
    // 133 = 0.7 × 190. With [low, high) semantics this is the start of
    // Z3, not the end of Z2.
    expect(zoneForHeartRate(133, zones)?.zone).toBe(3);
    // 114 = 0.6 × 190. Start of Z2.
    expect(zoneForHeartRate(114, zones)?.zone).toBe(2);
  });

  it('values below the lowest band snap to Z1', () => {
    expect(zoneForHeartRate(80, zones)?.zone).toBe(1);
    expect(zoneForHeartRate(50, zones)?.zone).toBe(1);
  });

  it('values above max HR snap to Z5; max HR itself is in Z5', () => {
    expect(zoneForHeartRate(190, zones)?.zone).toBe(5);
    expect(zoneForHeartRate(220, zones)?.zone).toBe(5);
  });
});

describe('hrZoneColorHex — 1-indexed zones', () => {
  it('Z1 maps to color index 0', () => {
    expect(hrZoneColorHex(1)).toBe(HR_ZONE_COLORS[0]);
  });
  it('Z5 maps to the last color', () => {
    expect(hrZoneColorHex(5)).toBe(HR_ZONE_COLORS[HR_ZONE_COLORS.length - 1]);
  });
  it('out-of-range zones clamp without throwing', () => {
    expect(hrZoneColorHex(9)).toBe(HR_ZONE_COLORS[HR_ZONE_COLORS.length - 1]);
    expect(hrZoneColorHex(0)).toBe(HR_ZONE_COLORS[0]);
    expect(hrZoneColorHex(-1)).toBe(HR_ZONE_COLORS[0]);
  });
});

describe('frontend/backend parity contract', () => {
  // These cases exist so a backend change to `compute_hr_zones` that
  // diverges from this file is caught immediately. The Python
  // implementation must produce these exact `zones` arrays for these
  // inputs. If you update the bands, update the Python tests too.

  it('parity case 1: age=30, RHR=60, MHR=190', () => {
    const r = computeHrZones({ age: 30, userMaxHR: 190, profileRHR: 60 });
    expect(r.zones.map(z => [z.zone, z.low, z.high])).toEqual([
      [1,  95, 114],
      [2, 114, 133],
      [3, 133, 152],
      [4, 152, 171],
      [5, 171, 190],
    ]);
  });

  it('parity case 2: age=40, RHR=55 (7d), no user MHR (Tanaka kicks in)', () => {
    const r = computeHrZones({ age: 40, rhr7d: 55 });
    // Tanaka(40) = 180. Boundaries: 90 / 108 / 126 / 144 / 162 / 180.
    expect(r.maxHR).toBe(180);
    expect(r.restingHR).toBe(55);
    expect(r.zones.map(z => [z.zone, z.low, z.high])).toEqual([
      [1,  90, 108],
      [2, 108, 126],
      [3, 126, 144],
      [4, 144, 162],
      [5, 162, 180],
    ]);
  });
});

describe('HR_ZONE_BANDS spec', () => {
  it('has five bands in zone-number order', () => {
    expect(HR_ZONE_BANDS.length).toBe(5);
    HR_ZONE_BANDS.forEach((band, i) => {
      expect(band.zone).toBe(i + 1);
    });
  });

  it('bands are contiguous: each band starts where the previous ended', () => {
    for (let i = 1; i < HR_ZONE_BANDS.length; i++) {
      expect(HR_ZONE_BANDS[i].lowPct).toBe(HR_ZONE_BANDS[i - 1].highPct);
    }
  });

  it('uses the consumer-fitness convention (Warm Up / Easy / Aerobic / Threshold / Maximum)', () => {
    expect(HR_ZONE_BANDS.map(b => b.label)).toEqual([
      'Warm Up', 'Easy', 'Aerobic', 'Threshold', 'Maximum',
    ]);
  });
});
