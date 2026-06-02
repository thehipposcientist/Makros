import { buildTodayReadinessDecision } from '../todayReadinessDecision.ts';

const basePillars = {
  sleep: 24,
  hrv: 16,
  fatigue: 16,
  nutrition: 12,
  restingHr: 8,
  yesterdayStrain: 4,
};

describe('today readiness decision', () => {
  it('trains as planned when readiness is strong', () => {
    const decision = buildTodayReadinessDecision({
      score: 78,
      label: 'Ready',
      pillars: basePillars,
      missing: [],
      signalsPresent: 6,
      signalsTotal: 7,
      todaysFocus: 'push',
    });

    expect(decision.kind).toBe('train');
    expect(decision.title).toBe('Train as planned');
    expect(decision.chips).toContain('Push focus');
  });

  it('prioritizes fueling when nutrition is the weak signal', () => {
    const decision = buildTodayReadinessDecision({
      score: 58,
      label: 'Moderate',
      pillars: { ...basePillars, nutrition: 4 },
      missing: [],
      signalsPresent: 6,
      signalsTotal: 7,
    });

    expect(decision.kind).toBe('fuel_first');
    expect(decision.action).toBe('Protein and easy carbs before training.');
  });

  it('keeps GLP-1 support lifestyle-only and appetite-aware', () => {
    const decision = buildTodayReadinessDecision({
      score: 61,
      label: 'Moderate',
      pillars: basePillars,
      missing: [],
      signalsPresent: 5,
      signalsTotal: 7,
      glp1Support: {
        enabled: true,
        appetite: 'very_low',
        sideEffects: ['nausea'],
      },
    });

    expect(decision.kind).toBe('fuel_first');
    expect(decision.action).toBe('Small protein-first meal, fluids, then train.');
    expect(decision.chips).toContain('Small portions');
    expect(decision.chips).toContain('GI-friendly');
  });

  it('switches to recovery for very low readiness', () => {
    const decision = buildTodayReadinessDecision({
      score: 22,
      label: 'Fatigued',
      pillars: { ...basePillars, sleep: 8, hrv: 4, fatigue: 4 },
      missing: [],
      signalsPresent: 5,
      signalsTotal: 7,
    });

    expect(decision.kind).toBe('recovery');
    expect(decision.title).toBe('Recovery fits better');
  });
});
