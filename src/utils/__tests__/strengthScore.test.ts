// Tests for the comprehensive strength score. 0–100 scale, with the
// practical recreational bw-ratio benchmark anchored at 70 (top of
// Intermediate). Bands: <40 Novice / 40–59 Developing /
// 60–79 Intermediate / 80–94 Advanced / 95–100 Elite. The matcher
// is the fragile piece — name patterns can collide ("front squat"
// inside "back squat" once a pattern is loose) — so coverage focuses
// on disambiguation alongside the math, band thresholds, confidence,
// and movement-pattern aggregation.

import {
  computeStrengthScore,
  strengthBandLabel,
  strengthConfidenceLabel,
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
    expect(r.confidence).toBe('unknown');
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
    expect(r.confidence).toBe('unknown');
    expect(r.loggedLiftCount).toBe(0);
    expect(r.totalLiftCount).toBe(STRENGTH_LIFTS.length);
    expect(r.rows.length).toBe(0);
    expect(r.missing.length).toBe(STRENGTH_LIFTS.length);
    expect(r.patternScores.length).toBe(0);
  });

  it('handles undefined bulkE1RMMap', () => {
    const r = computeStrengthScore({ bodyweightLbs: 180 });
    expect(r.score).toBe(0);
    expect(r.confidence).toBe('unknown');
    expect(r.missing.length).toBe(STRENGTH_LIFTS.length);
  });
});

describe('computeStrengthScore — math', () => {
  it('hitting the target bw-ratio anchors at 70 (top of Intermediate)', () => {
    // 1.5x bodyweight squat with bw=200 → 300 lb 1RM → score 70.
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: { 'barbell back squat': 300 },
    });
    const squat = r.rows.find(x => x.key === 'squat')!;
    expect(squat.score).toBe(70);
    expect(squat.band).toBe('intermediate');
    expect(squat.ratio).toBe(1.5);
  });

  it('half the target ⇒ score 35', () => {
    // 0.5 × 70 = 35 (Novice).
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: { 'bench press': 125 }, // 0.5 × 1.25-target ratio
    });
    expect(r.rows[0].score).toBe(35);
    expect(r.rows[0].band).toBe('novice');
  });

  it('caps individual lift at 100 even for monster lifts', () => {
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: { 'barbell deadlift': 1000 }, // 5× bw, way past 2× target
    });
    expect(r.rows[0].score).toBe(100);
    expect(r.rows[0].band).toBe('elite');
  });
});

describe('computeStrengthScore — band thresholds', () => {
  // 0–100 scale. Boundaries: < 40 / 40–59 / 60–79 / 80–94 / 95+.
  // Test both sides of every boundary.
  function rowAt(score: number) {
    // Construct a back-squat 1RM that produces exactly `score` for
    // bw=200 with the 70-anchor formula:
    //   score = (ratio / 1.5) × 70  ⇒  ratio = score × 1.5 / 70
    //   1RM   = ratio × 200          ⇒  1RM = score × 1.5 / 70 × 200
    //                                       = score × 300 / 70
    // Pre-rounded to keep the round-trip clean.
    const lbs = Math.round((score * 300) / 70);
    return computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: { 'barbell back squat': lbs },
    }).rows[0];
  }

  it('score 39 → Novice', () => { expect(rowAt(39).band).toBe('novice'); });
  it('score 40 → Developing', () => { expect(rowAt(40).band).toBe('developing'); });
  it('score 59 → Developing', () => { expect(rowAt(59).band).toBe('developing'); });
  it('score 60 → Intermediate', () => { expect(rowAt(60).band).toBe('intermediate'); });
  it('score 70 → Intermediate (the benchmark anchor)', () => {
    expect(rowAt(70).band).toBe('intermediate');
  });
  it('score 79 → Intermediate', () => { expect(rowAt(79).band).toBe('intermediate'); });
  it('score 80 → Advanced', () => { expect(rowAt(80).band).toBe('advanced'); });
  it('score 94 → Advanced', () => { expect(rowAt(94).band).toBe('advanced'); });
  it('score 95 → Elite', () => { expect(rowAt(95).band).toBe('elite'); });
  it('score 100 → Elite (cap)', () => { expect(rowAt(100).band).toBe('elite'); });
});

describe('computeStrengthScore — confidence thresholds', () => {
  // Build N-lift inputs all hitting their targets exactly.
  function buildLifts(count: number): Record<string, number> {
    const orderedAtBenchmark: Array<[string, number]> = [
      ['barbell back squat', 300],   // 1.5 × 200
      ['bench press', 250],           // 1.25 × 200
      ['barbell deadlift', 400],      // 2.0 × 200
      ['overhead press', 150],        // 0.75 × 200
      ['barbell row', 200],           // 1.0 × 200
      ['front squat', 250],           // 1.25 × 200
      ['romanian deadlift', 300],     // 1.5 × 200
      ['lat pulldown', 200],          // 1.0 × 200
    ];
    return Object.fromEntries(orderedAtBenchmark.slice(0, count));
  }

  it('0 lifts → unknown', () => {
    const r = computeStrengthScore({ bodyweightLbs: 200, bulkE1RMMap: {} });
    expect(r.confidence).toBe('unknown');
  });
  it('1 lift → partial', () => {
    expect(computeStrengthScore({ bodyweightLbs: 200, bulkE1RMMap: buildLifts(1) }).confidence).toBe('partial');
  });
  it('2 lifts → partial', () => {
    expect(computeStrengthScore({ bodyweightLbs: 200, bulkE1RMMap: buildLifts(2) }).confidence).toBe('partial');
  });
  it('3 lifts → low', () => {
    expect(computeStrengthScore({ bodyweightLbs: 200, bulkE1RMMap: buildLifts(3) }).confidence).toBe('low');
  });
  it('4 lifts → low', () => {
    expect(computeStrengthScore({ bodyweightLbs: 200, bulkE1RMMap: buildLifts(4) }).confidence).toBe('low');
  });
  it('5 lifts → medium', () => {
    expect(computeStrengthScore({ bodyweightLbs: 200, bulkE1RMMap: buildLifts(5) }).confidence).toBe('medium');
  });
  it('6 lifts → medium', () => {
    expect(computeStrengthScore({ bodyweightLbs: 200, bulkE1RMMap: buildLifts(6) }).confidence).toBe('medium');
  });
  it('7 lifts → high', () => {
    expect(computeStrengthScore({ bodyweightLbs: 200, bulkE1RMMap: buildLifts(7) }).confidence).toBe('high');
  });
  it('8 lifts → high', () => {
    expect(computeStrengthScore({ bodyweightLbs: 200, bulkE1RMMap: buildLifts(8) }).confidence).toBe('high');
  });
});

describe('computeStrengthScore — missing lifts unpenalized', () => {
  it('only bench + squat logged → average across those two only, confidence partial', () => {
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: {
        'barbell back squat': 300,    // ratio 1.5 = target → 70
        'bench press': 125,            // ratio 0.625 = 0.5 × target → 35
      },
    });
    expect(r.loggedLiftCount).toBe(2);
    expect(r.confidence).toBe('partial');
    // Bench (horizontal_push) = 35 and squat (squat) = 70 — different
    // patterns, so both contribute. Average = (35 + 70) / 2 = 52.5 → 53.
    expect(r.score).toBe(53);
    expect(r.missing.length).toBe(STRENGTH_LIFTS.length - 2);
    expect(r.missing.find(m => m.key === 'bench')).toBe(undefined);
    expect(r.missing.find(m => m.key === 'squat')).toBe(undefined);
  });

  it('a strong single lift does NOT get diluted by missing slots', () => {
    // Just deadlift at the benchmark (score 70). Aggregate must = 70,
    // not (70 + 0 × 7) / 8 = ~9.
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: { 'barbell deadlift': 400 },
    });
    expect(r.score).toBe(70);
    expect(r.confidence).toBe('partial');
    expect(r.loggedLiftCount).toBe(1);
  });
});

describe('computeStrengthScore — movement-pattern aggregation', () => {
  it('back squat + front squat collapse to one squat-pattern score (best wins)', () => {
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: {
        'barbell back squat': 300,    // squat pattern, score 70 (at target)
        'front squat': 200,            // squat pattern, score 56 (200 / (1.25*200) × 70)
      },
    });
    expect(r.loggedLiftCount).toBe(2);
    // patternScores has ONE entry for `squat`, taking the best (70).
    expect(r.patternScores.length).toBe(1);
    expect(r.patternScores[0].pattern).toBe('squat');
    expect(r.patternScores[0].score).toBe(70);
    expect(r.patternScores[0].bestLiftKey).toBe('squat');
    // Aggregate = mean of pattern scores = 70, NOT (70+56)/2=63.
    expect(r.score).toBe(70);
  });

  it('deadlift + RDL collapse to one hinge-pattern score', () => {
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: {
        'barbell deadlift': 400,       // hinge, score 70 (at target)
        'romanian deadlift': 240,      // hinge, score 56 (240 / (1.5*200) × 70)
      },
    });
    expect(r.patternScores.length).toBe(1);
    expect(r.patternScores[0].pattern).toBe('hinge');
    expect(r.patternScores[0].score).toBe(70);
  });

  it('lower-body bias is corrected — 4 lower-body lifts + 1 upper-body lift', () => {
    // Without pattern aggregation this would be (70+70+70+70+35)/5 = 63.
    // With pattern aggregation: squat=70, hinge=70, push=35,
    // average = (70+70+35)/3 = 58.33 → 58.
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: {
        'barbell back squat': 300,    // squat → 70
        'front squat': 250,            // squat → 70 (collapsed with above)
        'barbell deadlift': 400,       // hinge → 70
        'romanian deadlift': 300,      // hinge → 70 (collapsed)
        'bench press': 125,            // horizontal_push → 35
      },
    });
    expect(r.patternScores.length).toBe(3);
    expect(r.score).toBe(58);
  });

  it('all 8 lifts at benchmark → score 70, all 6 patterns covered', () => {
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: {
        'barbell back squat': 300,
        'bench press': 250,
        'barbell deadlift': 400,
        'overhead press': 150,
        'barbell row': 200,
        'front squat': 250,
        'romanian deadlift': 300,
        'lat pulldown': 200,
      },
    });
    expect(r.loggedLiftCount).toBe(8);
    expect(r.confidence).toBe('high');
    expect(r.patternScores.length).toBe(6);
    expect(r.score).toBe(70);
    expect(r.band).toBe('intermediate');  // benchmark anchor lives at 70
    expect(r.missing.length).toBe(0);
  });

  it('all 8 lifts at ~1.43× benchmark → score 100, Elite (cap)', () => {
    // Each lift's 1RM is target_ratio × bw × 1.43, which gives a per-
    // lift score of 1.43 × 70 = 100.1 → capped at 100.
    const k = 1.43;
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: {
        'barbell back squat':  Math.round(1.5  * 200 * k),
        'bench press':         Math.round(1.25 * 200 * k),
        'barbell deadlift':    Math.round(2.0  * 200 * k),
        'overhead press':      Math.round(0.75 * 200 * k),
        'barbell row':         Math.round(1.0  * 200 * k),
        'front squat':         Math.round(1.25 * 200 * k),
        'romanian deadlift':   Math.round(1.5  * 200 * k),
        'lat pulldown':        Math.round(1.0  * 200 * k),
      },
    });
    expect(r.score).toBe(100);
    expect(r.band).toBe('elite');
  });
});

describe('computeStrengthScore — name matching (regression suite)', () => {
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
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: { 'dumbbell shoulder press': 60 },
    });
    expect(r.rows.length).toBe(0);
  });

  it('"machine shoulder press" / "smith shoulder press" do NOT match overhead_press', () => {
    expect(computeStrengthScore({
      bodyweightLbs: 200, bulkE1RMMap: { 'machine shoulder press': 100 },
    }).rows.length).toBe(0);
    expect(computeStrengthScore({
      bodyweightLbs: 200, bulkE1RMMap: { 'smith shoulder press': 100 },
    }).rows.length).toBe(0);
  });

  it('"OHP" matches overhead_press', () => {
    const r = computeStrengthScore({
      bodyweightLbs: 200,
      bulkE1RMMap: { 'ohp': 150 },
    });
    expect(r.rows.find(x => x.key === 'overhead_press') !== undefined).toBe(true);
  });

  it('cable / seated / machine rows do NOT match barbell row slot', () => {
    expect(computeStrengthScore({
      bodyweightLbs: 200, bulkE1RMMap: { 'seated cable row': 200 },
    }).rows.length).toBe(0);
    expect(computeStrengthScore({
      bodyweightLbs: 200, bulkE1RMMap: { 'machine row': 200 },
    }).rows.length).toBe(0);
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

  it('takes the heaviest match when multiple variants exist (within same lift slot)', () => {
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
        { name: 'Bench Press', oneRepMaxLbs: 250 },  // ratio 1.0 = at target → 70
      ],
    });
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].score).toBe(70);
  });

  it('uses whichever source has the higher number', () => {
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

describe('strengthBandLabel + strengthConfidenceLabel', () => {
  it('band labels', () => {
    expect(strengthBandLabel('novice')).toBe('Novice');
    expect(strengthBandLabel('developing')).toBe('Developing');
    expect(strengthBandLabel('intermediate')).toBe('Intermediate');
    expect(strengthBandLabel('advanced')).toBe('Advanced');
    expect(strengthBandLabel('elite')).toBe('Elite');
    expect(strengthBandLabel('unknown')).toBe('—');
  });

  it('confidence labels', () => {
    expect(strengthConfidenceLabel('unknown')).toBe('—');
    expect(strengthConfidenceLabel('partial')).toBe('Partial');
    expect(strengthConfidenceLabel('low')).toBe('Low');
    expect(strengthConfidenceLabel('medium')).toBe('Medium');
    expect(strengthConfidenceLabel('high')).toBe('High');
  });
});
