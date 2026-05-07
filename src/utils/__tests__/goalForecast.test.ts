import { buildGoalForecast } from '../goalForecast.ts';

const today = new Date('2026-05-05T12:00:00');

describe('goalForecast', () => {
  it('turns body recomp execution into a body-fat-point estimate', () => {
    const result = buildGoalForecast({
      today,
      weightUnit: 'lbs',
      profile: {
        goal: 'body_recomp',
        goalDetails: { pace: 'moderate', goalStartedAt: '2026-04-21T12:00:00.000Z' },
        physicalStats: { weightLbs: 180 },
        daysPerWeek: 4,
      },
      summaries: [
        { date: '2026-04-23', totalSets: 16, durationSeconds: 3200 },
        { date: '2026-04-26', totalSets: 15, durationSeconds: 3000 },
        { date: '2026-04-29', totalSets: 18, durationSeconds: 3300 },
        { date: '2026-05-01', totalSets: 18, durationSeconds: 3300 },
        { date: '2026-05-03', totalSets: 17, durationSeconds: 3100 },
        { date: '2026-05-05', totalSets: 15, durationSeconds: 3000 },
      ],
      nutritionScoreWeekly: {
        window_days: 7,
        days_with_data: 6,
        avg_score: 84,
        days_hit_protein: 5,
        days_hit_calories: 5,
      },
      bodyScanHistory: [{ date: '2026-05-01', bodyFatPct: 22.5, weightLbs: 180 }],
    });

    expect(result.headline).toContain('fat in 4 weeks');
    expect(result.metricValue).toContain('lbs');
    expect(result.metricDetail).toContain('body-fat points');
    expect(result.tone).toBe('success');
    expect(result.drivers.join(' ')).toContain('nutrition');
  });

  it('reduces the estimate when nutrition logging is sparse', () => {
    const result = buildGoalForecast({
      today,
      weightUnit: 'lbs',
      profile: {
        goal: 'lose_fat',
        goalSelection: { category: 'fat_loss' },
        goalDetails: { pace: 'moderate', startWeightLbs: 200, targetWeightLbs: 180 },
        physicalStats: { weightLbs: 195 },
        daysPerWeek: 4,
      },
      weightEntries: [
        { date: '2026-04-15', weightLbs: 199 },
        { date: '2026-05-05', weightLbs: 195 },
      ],
      summaries: [
        { date: '2026-05-01', totalSets: 18, durationSeconds: 3300 },
        { date: '2026-05-03', totalSets: 20, durationSeconds: 3400 },
      ],
      mealAverages: {
        window_days: 7,
        days_with_data: 1,
        tracking_rate_pct: 14,
        avg_protein_g_when_logged: 80,
      },
    });

    expect(result.headline).toContain('At current pace');
    expect(result.limiters.join(' ')).toContain('nutrition');
    expect(result.updateReason).toContain('adjusted down');
    expect(result.executionPct < 75).toBe(true);
  });

  it('uses goal-specific strength output for strength goals', () => {
    const result = buildGoalForecast({
      today,
      profile: {
        goal: 'build_strength',
        goalSelection: { category: 'strength' },
        goalDetails: { pace: 'aggressive' },
        physicalStats: { weightLbs: 185 },
        daysPerWeek: 3,
      },
      summaries: [
        { date: '2026-04-25', totalSets: 18, durationSeconds: 3300 },
        { date: '2026-04-29', totalSets: 18, durationSeconds: 3300 },
        { date: '2026-05-03', totalSets: 18, durationSeconds: 3300 },
      ],
      nutritionScoreWeekly: {
        window_days: 7,
        days_with_data: 4,
        avg_score: 76,
        days_hit_protein: 3,
        days_hit_calories: 3,
      },
      oneRepMaxLifts: [{ name: 'Back Squat', oneRepMaxLbs: 315 }],
    });

    expect(result.metricLabel).toBe('Strength marker');
    expect(result.headline).toContain('strength marker');
    expect(result.metricDetail).toContain('Back Squat');
  });

  it('uses the current goal block for cardio VO2 estimates', () => {
    const result = buildGoalForecast({
      today,
      profile: {
        goal: 'improve_vo2',
        goalSelection: { category: 'cardio_endurance' },
        goalDetails: { pace: 'moderate', goalStartedAt: '2026-04-28T12:00:00.000Z' },
        physicalStats: { weightLbs: 170 },
        daysPerWeek: 4,
      },
      summaries: [
        { date: '2026-04-24', totalSets: 0, durationSeconds: 2400 },
        { date: '2026-04-27', totalSets: 0, durationSeconds: 2600 },
        { date: '2026-04-30', totalSets: 0, durationSeconds: 2500 },
        { date: '2026-05-03', totalSets: 0, durationSeconds: 2500 },
      ],
      nutritionScoreWeekly: {
        window_days: 7,
        days_with_data: 5,
        avg_score: 78,
        days_hit_protein: 4,
        days_hit_calories: 4,
      },
      vo2Max: 42.4,
    });

    expect(result.headline).toContain('VO2 Max');
    expect(result.headline).toContain('5 weeks');
    expect(result.metricLabel).toBe('VO2 estimate');
    expect(result.metricDetail).toContain('42.4');
  });
});
