// Tests for the modular Thallo Score (calculateHealthScore in
// src/utils/healthScore.ts). Focus is on the contract that the rest of
// the app depends on: missing pillars don't zero out the score, the
// returned object surfaces enough metadata for the explainer modal,
// and legacy fields stay populated. We do not test exact pillar
// numbers — those bands are covered implicitly by sub-score tests
// elsewhere and would be brittle here.

import { calculateHealthScore, THALLO_SCORE_LABEL } from '../healthScore.ts';
import type { ScoreContext } from '../healthScore.ts';

function baseCtx(overrides: Partial<ScoreContext> = {}): ScoreContext {
  return {
    appWorkouts14d: 6,
    targetDaysPerWeek: 4,
    health: null,
    ...overrides,
  };
}

describe('calculateHealthScore — weight renormalization', () => {
  it('produces a score from only the training pillar when nothing else is available', () => {
    const r = calculateHealthScore(baseCtx());
    // Training is always available (count + target are required), so
    // even with zero optional inputs we still get a number.
    expect(typeof r.overallScore).toBe('number');
    expect(r.overallScore != null && r.overallScore > 0).toBe(true);
    // Only the training pillar should appear in subScores.
    expect(Object.keys(r.subScores)).toEqual(['training']);
  });

  it('does not penalize missing data — overall equals the only available pillar', () => {
    const r = calculateHealthScore(baseCtx());
    const training = r.subScores.training!;
    // When only one pillar is available, renormalization gives it the
    // entire weight, so overall equals that pillar (within rounding).
    const delta = Math.abs((r.overallScore ?? 0) - training);
    expect(delta <= 1).toBe(true);
  });

  it('reports low confidence when pillar coverage is small', () => {
    const r = calculateHealthScore(baseCtx());
    // Training alone is 20/100 of total weight → < 40% → low.
    expect(r.confidence).toBe('low');
    expect(r.dataCoverage < 0.4).toBe(true);
  });

  it('reports high confidence when most pillars have data', () => {
    const r = calculateHealthScore(baseCtx({
      health: {
        sleepScore: { score: 82 } as any,
        restingHeartRate: 58,
        hrvAvg: 60,
        avgSteps7d: 9000,
        activeEnergy7d: 2500,
        vo2Max: 45,
        workouts7d: 4,
      } as any,
      nutrition: { weeklyNutritionScore: 78, weeklyDaysWithData: 6 },
      gutSupport: { fiberGramsPerDay: 28, plantVariety7d: 22, hydrationOzPerDay: 80, fermentedFoodDays7d: 3 },
      strength: { hasRecentStrengthWork: true, e1rmPrs28d: 2, tonnageTrend4wRatio: 1.02 },
      baselines: { rhrMedian30d: 60, hrvMedian30d: 58 },
    }));
    expect(r.dataCoverage > 0.7).toBe(true);
    expect(r.confidence === 'high' || r.confidence === 'medium').toBe(true);
  });
});

describe('calculateHealthScore — pillar source metadata', () => {
  it('reports nutrition source as "server" when weekly score is provided', () => {
    const r = calculateHealthScore(baseCtx({
      nutrition: { weeklyNutritionScore: 75, weeklyDaysWithData: 5 },
    }));
    expect(r.pillarSources.nutritionScoreSource).toBe('server');
  });

  it('reports nutrition source as "clientFallback" when ratios are used', () => {
    const r = calculateHealthScore(baseCtx({
      nutrition: {
        calorieAdherence7d: 0.95,
        proteinAdherence7d: 0.9,
        fiberGramsPerDay: 25,
      },
    }));
    expect(r.pillarSources.nutritionScoreSource).toBe('clientFallback');
  });

  it('reports nutrition source as "unavailable" when no nutrition input is given', () => {
    const r = calculateHealthScore(baseCtx());
    expect(r.pillarSources.nutritionScoreSource).toBe('unavailable');
  });

  it('lists which recovery signals were used', () => {
    const r = calculateHealthScore(baseCtx({
      health: { sleepScore: { score: 80 } as any, restingHeartRate: 58 } as any,
      baselines: { rhrMedian30d: 60 },
    }));
    expect(r.pillarSources.recoverySignalsUsed).toContain('sleep');
    expect(r.pillarSources.recoverySignalsUsed).toContain('rhr');
    expect(r.pillarSources.recoverySignalsUsed).toContain('load');
  });

  it('lists cardio signals when cardio data is present', () => {
    const r = calculateHealthScore(baseCtx({
      cardio: { vo2Max: 42, zone2Minutes7d: 100, cardioSessions7d: 3 },
    }));
    expect(r.pillarSources.cardioSignalsUsed).toContain('vo2Max');
    expect(r.pillarSources.cardioSignalsUsed).toContain('zone2Minutes');
    expect(r.pillarSources.cardioSignalsUsed).toContain('cardioSessions');
  });

  it('caps cardio when session count is the only signal', () => {
    const r = calculateHealthScore(baseCtx({
      cardio: { cardioSessions7d: 4 },
    }));
    expect((r.subScores.cardio ?? 0) <= 55).toBe(true);
    expect(r.explanation.some(line => line.includes('session count only'))).toBe(true);
  });

  it('lets VO2 max carry the cardio pillar when available', () => {
    const r = calculateHealthScore(baseCtx({
      cardio: { vo2Max: 50 },
    }));
    expect((r.subScores.cardio ?? 0) >= 85).toBe(true);
    expect(r.pillarSources.cardioSignalsUsed).toContain('vo2Max');
  });
});

describe('calculateHealthScore — explainer metadata', () => {
  it('exposes the user-facing score label as "Thallo Score"', () => {
    const r = calculateHealthScore(baseCtx());
    expect(r.scoreLabel).toBe('Thallo Score');
    expect(THALLO_SCORE_LABEL).toBe('Thallo Score');
  });

  it('groups missing signals by pillar so the modal can render sections', () => {
    const r = calculateHealthScore(baseCtx());
    // Recovery and cardio at minimum should report missing data for
    // an empty context — they're optional pillars with no inputs.
    expect(typeof r.missingByPillar).toBe('object');
    // Missing entries are populated for unavailable pillars.
    const allMissing = Object.values(r.missingByPillar).flat();
    expect(allMissing.length > 0).toBe(true);
    // Flat list mirrors grouped list (deduped); both should be non-empty
    // when pillars are unavailable.
    expect(r.missingSignals.length > 0).toBe(true);
  });

  it('produces top positive factors when pillars score high', () => {
    const r = calculateHealthScore(baseCtx({
      appWorkouts14d: 8,        // 8/8 → adherence 1.0 → strong training
      targetDaysPerWeek: 4,
      nutrition: { weeklyNutritionScore: 92, weeklyDaysWithData: 7 },
    }));
    expect(r.topPositiveFactors.length > 0).toBe(true);
  });

  it('produces top negative factors when pillars score low', () => {
    const r = calculateHealthScore(baseCtx({
      appWorkouts14d: 1,        // way below target → low training
      targetDaysPerWeek: 5,
    }));
    expect(r.topNegativeFactors.length > 0).toBe(true);
  });
});

describe('calculateHealthScore — legacy field preservation', () => {
  it('keeps fitnessScore as an alias for overallScore', () => {
    const r = calculateHealthScore(baseCtx());
    expect(r.fitnessScore).toBe(r.overallScore ?? 0);
  });

  it('still populates recoveryMarker, scoreInputs, recoveryInputs', () => {
    const r = calculateHealthScore(baseCtx());
    expect(r.recoveryMarker === 'green' || r.recoveryMarker === 'yellow' || r.recoveryMarker === 'red').toBe(true);
    expect(typeof r.scoreInputs.workoutPoints).toBe('number');
    expect(typeof r.scoreInputs.sleepPoints).toBe('number');
    expect(r.recoveryInputs.rhrStatus === 'normal' || r.recoveryInputs.rhrStatus === 'elevated' || r.recoveryInputs.rhrStatus === 'unknown').toBe(true);
  });
});
