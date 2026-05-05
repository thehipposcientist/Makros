import { buildGoalTrajectory } from '../goalTrajectory.ts';

const today = new Date('2026-05-05T12:00:00');

describe('goalTrajectory', () => {
  it('projects fat-loss pace from recent weigh-ins and logged behavior', () => {
    const result = buildGoalTrajectory({
      today,
      weightUnit: 'lbs',
      distanceUnit: 'mi',
      profile: {
        goal: 'lose_fat',
        goalSelection: { category: 'fat_loss' },
        goalDetails: { startWeightLbs: 200, targetWeightLbs: 180 },
        physicalStats: { weightLbs: 195 },
        daysPerWeek: 3,
      },
      weightEntries: [
        { date: '2026-04-15', weightLbs: 199 },
        { date: '2026-04-29', weightLbs: 196.5 },
        { date: '2026-05-05', weightLbs: 195 },
      ],
      summaries: [
        { date: '2026-05-01', totalSets: 18, durationSeconds: 3300 },
        { date: '2026-05-03', totalSets: 20, durationSeconds: 3400 },
        { date: '2026-05-05', totalSets: 14, durationSeconds: 2600 },
      ],
      mealAverages: {
        window_days: 7,
        days_with_data: 5,
        tracking_rate_pct: 71,
        avg_protein_g_when_logged: 150,
        avg_protein_g: 107,
      },
    });

    expect(result.headline).toContain('On pace to lose');
    expect(result.tone).toBe('success');
    expect(result.confidence).toBe('high');
    expect(result.progressLabel).toBe('25% to target');
  });

  it('stays honest when there is not enough data for a pace estimate', () => {
    const result = buildGoalTrajectory({
      today,
      profile: {
        goal: 'build_muscle',
        goalSelection: { category: 'muscle_physique' },
        goalDetails: { startWeightLbs: 160, targetWeightLbs: 170 },
        physicalStats: { weightLbs: 160 },
        daysPerWeek: 4,
      },
      weightEntries: [{ date: '2026-05-05', weightLbs: 160 }],
    });

    expect(result.confidence).toBe('low');
    expect(result.headline).toContain('Target:');
    expect(result.subheadline).toContain('Need more weigh-ins');
    expect(result.lever).toContain('two weigh-ins');
  });

  it('uses cardio distance for endurance goals when distance logs exist', () => {
    const result = buildGoalTrajectory({
      today,
      distanceUnit: 'mi',
      profile: {
        goal: 'improve_cardio',
        goalSelection: { category: 'cardio_endurance' },
        goalDetails: {},
        physicalStats: { weightLbs: 180 },
        daysPerWeek: 4,
      },
      summaries: [
        { date: '2026-05-01', totalSets: 4, durationSeconds: 1800 },
        { date: '2026-05-04', totalSets: 4, durationSeconds: 2100 },
      ],
      paceHistory: [
        { date: '2026-05-01', distance: 3 },
        { date: '2026-05-04', distance: 2 },
      ],
    });

    expect(result.headline).toContain('15.0 mi');
    expect(result.stats[0].detail).toBe('projected distance');
  });
});
