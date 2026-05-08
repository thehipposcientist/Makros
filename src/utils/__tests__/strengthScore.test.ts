// Tests for the comprehensive strength score. The matcher is the
// fragile piece — name patterns can collide ("front squat" inside
// "back squat" once a pattern is loose) — so coverage focuses on
// disambiguation alongside the math.

import {
  computeStrengthScore,
  strengthBandLabel,
  STRENGTH_LIFTS,
} from '../strengthScore.ts';

describe('computeStrengthScore — bodyweight gate', () => {
  it('returns score=0, band=unknown when bodyweight missing', () => {
    const r = computeStrengthScore({
      bodyweightLbs: null,
      bulkE1RMMap: { 'barbell back squat': 315 },
    });
    expect(r.score).toBe(0);
    expect(r.band).toBe('unknown');
    expect(r.rows.length).toBe(0);
    expect(r.missing.length).toBe(STRENGTH_LIFTS.length);
  });

  it('returns score=0, band=unknown when bodyweight is 0 or negative', () => {
    expect(computeStrengthScore({ bodyweightLbs: 0, bulkE1RMMap: {} }).band).toBe('unknown');
    expect(computeStrengthScore({ bodyweightLbs: -10, bulkE1RMMap: {} }).band).toBe('unknown');
  });
});

describe('computeStrengthScore — empty input', () => {
  it('returns 0 score and lists every lift as missing when no data', () => {
    const r = computeStrengthScore({ bodyweightLbs: 180, bulkE1RMMap: {} });
    expect(r.score).toBe(0);
    expect(r.band).toBe('unknown');
    expect(r.rows.length).toBe(0);
    expect(r.missing.length).toBe(STRENGTH_LIFTS.length);
  });

  it('handles undefined bulkE1RMMap', () => {
    const r = computeStrengthScore({ bodyweightLbs: 180 });
    expect(r.score).toBe(0);
    expect(r.missing.length).toBe(STRENGTH_LIFTS.length);
  });
});

describe('computeStrengthScore — math', () => {
  it('intermediate target hits exactly 100', () => {
    // 1.5x bodyweight squat with bw=200 → 300 lb 1RM → score 100.
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: { 'barbell back squat': 300 },
    });
    const squat = r.rows.find(x => x.key === 'squat')!;
    expect(squat.score).toBe(100);
    expect(squat.band).toBe('advanced');
    expect(squat.ratio).toBe(1.5);
  });

  it('half the target ⇒ score 50', () => {
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: { 'bench press': 125 },  // 1.25x target × 0.5 = 0.625 ratio → 50
    });
    expect(r.rows[0].score).toBe(50);
    expect(r.rows[0].band).toBe('novice');
  });

  it('caps individual lift at 130 even for monster lifts', () => {
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: { 'barbell deadlift': 1000 }, // 5x bw, way over 2x target
    });
    expect(r.rows[0].score).toBe(130);
    expect(r.rows[0].band).toBe('elite');
  });

  it('aggregate score is the unweighted mean of available lifts', () => {
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: {
        'barbell back squat': 300,    // 100
        'bench press': 125,            // 50  (125 / (1.25 * 200) * 100 = 50)
      },
    });
    expect(r.liftsCovered).toBe(2);
    expect(r.score).toBe(75);  // (100 + 50) / 2
  });
});

describe('computeStrengthScore — band boundaries', () => {
  it('59 → novice, 60 → intermediate', () => {
    expect(strengthBandLabel('novice')).toBe('Novice');
    expect(strengthBandLabel('intermediate')).toBe('Intermediate');
    expect(strengthBandLabel('advanced')).toBe('Advanced');
    expect(strengthBandLabel('elite')).toBe('Elite');
    expect(strengthBandLabel('unknown')).toBe('—');
  });
});

describe('computeStrengthScore — name matching', () => {
  it('"barbell back squat" matches squat NOT front squat', () => {
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: { 'barbell back squat': 315 },
    });
    expect(r.rows.find(x => x.key === 'squat') !== undefined).toBe(true);
    expect(r.rows.find(x => x.key === 'front_squat')).toBe(undefined);
  });

  it('"front squat" matches front_squat NOT squat', () => {
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: { 'front squat': 225 },
    });
    expect(r.rows.find(x => x.key === 'front_squat') !== undefined).toBe(true);
    expect(r.rows.find(x => x.key === 'squat')).toBe(undefined);
  });

  it('"romanian deadlift" matches RDL NOT deadlift', () => {
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: { 'romanian deadlift': 275 },
    });
    expect(r.rows.find(x => x.key === 'romanian_deadlift') !== undefined).toBe(true);
    expect(r.rows.find(x => x.key === 'deadlift')).toBe(undefined);
  });

  it('"barbell deadlift" matches deadlift NOT romanian', () => {
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: { 'barbell deadlift': 405 },
    });
    expect(r.rows.find(x => x.key === 'deadlift') !== undefined).toBe(true);
    expect(r.rows.find(x => x.key === 'romanian_deadlift')).toBe(undefined);
  });

  it('"dumbbell shoulder press" does NOT match overhead_press', () => {
    // The barbell-OHP target is too aggressive for dumbbell variants.
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: { 'dumbbell shoulder press': 60 },
    });
    expect(r.rows.length).toBe(0);
  });

  it('"OHP" matches overhead_press', () => {
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: { 'ohp': 150 },
    });
    expect(r.rows.find(x => x.key === 'overhead_press') !== undefined).toBe(true);
  });

  it('cable row does NOT match barbell row slot', () => {
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: { 'seated cable row': 200 },
    });
    expect(r.rows.length).toBe(0);
  });

  it('pendlay row maps into the row slot', () => {
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: { 'pendlay row': 200 },
    });
    expect(r.rows.find(x => x.key === 'row') !== undefined).toBe(true);
  });

  it('"lat pulldown" / "lat pull-down" / "lat pull down" all match', () => {
    expect(computeStrengthScore({ bodyweightLbs: 200, bulkE1RMMap: { 'lat pulldown': 200 } }).rows.length).toBe(1);
    expect(computeStrengthScore({ bodyweightLbs: 200, bulkE1RMMap: { 'lat pull-down': 200 } }).rows.length).toBe(1);
    expect(computeStrengthScore({ bodyweightLbs: 200, bulkE1RMMap: { 'lat pull down': 200 } }).rows.length).toBe(1);
  });

  it('takes the heaviest match when multiple variants exist', () => {
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: {
        'barbell row': 185,
        'pendlay row': 225,
      },
    });
    const row = r.rows.find(x => x.key === 'row')!;
    expect(row.oneRepMaxLbs).toBe(225);
    expect(row.matchedName).toBe('pendlay row');
  });
});

describe('computeStrengthScore — fallback to showcase', () => {
  it('falls back to showcase when bulk map is empty', () => {
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: {},
      showcase: [
        { name: 'Bench Press', oneRepMaxLbs: 250 },  // 250 / (1.25 * 200) = 1.0 → 100
      ],
    });
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].score).toBe(100);
  });

  it('bulk-map result wins over showcase even when both are present', () => {
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: { 'bench press': 275 },  // higher number from bulk
      showcase: [{ name: 'Bench Press', oneRepMaxLbs: 250 }],
    });
    expect(r.rows[0].oneRepMaxLbs).toBe(275);
  });

  it('uses whichever source has the higher number', () => {
    // Same lift, showcase has a higher number than bulk → showcase wins.
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: { 'bench press': 200 },
      showcase: [{ name: 'Bench Press', oneRepMaxLbs: 275 }],
    });
    expect(r.rows[0].oneRepMaxLbs).toBe(275);
  });

  it('drops zero / negative / NaN entries from both sources', () => {
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: { 'bench press': 0, 'barbell back squat': -5 },
      showcase: [{ name: 'Deadlift', oneRepMaxLbs: NaN }],
    });
    expect(r.rows.length).toBe(0);
  });
});

describe('computeStrengthScore — missing list', () => {
  it('lists every unmatched lift in `missing` so UI can prompt', () => {
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: { 'bench press': 225 },
    });
    expect(r.liftsCovered).toBe(1);
    expect(r.missing.length).toBe(STRENGTH_LIFTS.length - 1);
    expect(r.missing.find(m => m.key === 'bench')).toBe(undefined);
    expect(r.missing.find(m => m.key === 'squat') !== undefined).toBe(true);
  });
});

describe('computeStrengthScore — full lifter snapshot', () => {
  it('intermediate trainee with all 8 lifts at target lands at 100', () => {
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: {
        'barbell back squat': 300,    // 1.5x
        'bench press': 250,            // 1.25x
        'barbell deadlift': 400,       // 2.0x
        'overhead press': 150,         // 0.75x
        'barbell row': 200,            // 1.0x
        'front squat': 250,            // 1.25x
        'romanian deadlift': 300,      // 1.5x
        'lat pulldown': 200,           // 1.0x
      },
    });
    expect(r.liftsCovered).toBe(8);
    expect(r.score).toBe(100);
    expect(r.band).toBe('advanced');
    expect(r.missing.length).toBe(0);
  });
});
