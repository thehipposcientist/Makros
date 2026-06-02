// Integration-style unit tests for the Progress page's data-shaping
// layer. Renders nothing — exercises the pure helpers in
// `../progressData.ts` against representative API payloads to verify
// what the Progress page would actually display.
//
// Why this matters: the Nutrition & Gut Facts card reuses the same
// logged-meal data users see on the Meals tab. These tests pin the
// macros-history bar denominator + sorting/slicing behavior.
//
// Pure functions only — no React, no AsyncStorage. Runs under the
// repo's `--experimental-strip-types` Node runner.

import {
  type MealAveragesShape,
  type MealHistoryEntryShape,
  aggregateDailyFromHistory,
  buildHrZoneSourceBreakdown,
  buildStrengthLoadBalance,
  buildStrengthVolumeTrend,
  dailyBarDenominator,
  hrZoneSourceLabel,
  isCardioHrZoneSource,
  macrosHeadlineFromDailyRows,
  macrosHeadlineFromAverages,
  recentLoggedDays,
  selectDailyRows,
  strengthVolumeForWindow,
} from '../progressData.ts';

const sampleAverages: MealAveragesShape = {
  window_days: 14,
  days_with_data: 5,
  avg_calories: 800,            // 5 logged days × 2240 / 14
  avg_calories_when_logged: 2240,
  avg_protein_g: 60,
  avg_protein_g_when_logged: 168,
  avg_carbs_g: 90,
  avg_carbs_g_when_logged: 252,
  avg_fat_g: 26,
  avg_fat_g_when_logged: 73,
  avg_meals_per_day: 1.07,
  total_meals_logged: 15,
  daily: [
    { date: '2026-04-25', calories: 2400, protein_g: 180, carbs_g: 260, fat_g: 80, meal_count: 3 },
    { date: '2026-04-23', calories: 2100, protein_g: 160, carbs_g: 240, fat_g: 70, meal_count: 3 },
    { date: '2026-04-20', calories: 1900, protein_g: 150, carbs_g: 220, fat_g: 65, meal_count: 3 },
    { date: '2026-04-18', calories: 2300, protein_g: 170, carbs_g: 250, fat_g: 75, meal_count: 3 },
    { date: '2026-04-15', calories: 2500, protein_g: 200, carbs_g: 280, fat_g: 85, meal_count: 3 },
  ],
};

describe('Progress data layer', () => {
  describe('macrosHeadlineFromAverages', () => {
    it('prefers the when-logged averages over the window-divided ones', () => {
      const h = macrosHeadlineFromAverages(sampleAverages);
      expect(h.calories).toBe(2240);
      expect(h.protein).toBe(168);
      expect(h.carbs).toBe(252);
      expect(h.fat).toBe(73);
    });

    it('falls back to window-divided averages when when-logged is missing', () => {
      const partial: MealAveragesShape = {
        ...sampleAverages,
        avg_calories_when_logged: undefined,
        avg_protein_g_when_logged: undefined,
        avg_carbs_g_when_logged: undefined,
        avg_fat_g_when_logged: undefined,
      };
      const h = macrosHeadlineFromAverages(partial);
      expect(h.calories).toBe(800);
      expect(h.protein).toBe(60);
      expect(h.carbs).toBe(90);
      expect(h.fat).toBe(26);
    });
  });

  describe('recentLoggedDays', () => {
    it('returns rows sorted newest-first', () => {
      const rows = recentLoggedDays(sampleAverages, 10);
      expect(rows.length).toBe(5);
      expect(rows[0].date).toBe('2026-04-25');
      expect(rows[rows.length - 1].date).toBe('2026-04-15');
    });

    it('caps the list at the limit', () => {
      const rows = recentLoggedDays(sampleAverages, 3);
      expect(rows.length).toBe(3);
      expect(rows[0].date).toBe('2026-04-25');
      expect(rows[2].date).toBe('2026-04-20');
    });

    it('returns an empty list when daily is missing', () => {
      const rows = recentLoggedDays({ ...sampleAverages, daily: undefined });
      expect(rows.length).toBe(0);
    });

    it('does not mutate the source averages.daily array', () => {
      const before = sampleAverages.daily!.map(d => d.date).join(',');
      recentLoggedDays(sampleAverages, 3);
      const after = sampleAverages.daily!.map(d => d.date).join(',');
      expect(before).toBe(after);
    });
  });

  describe('dailyBarDenominator', () => {
    it('uses the max calories observed when above the avg', () => {
      // Avg is 2240, but the highest day is 2500 — denom should be 2500
      // so the highest day fills the bar instead of clamping at 100%.
      const denom = dailyBarDenominator(2240, sampleAverages.daily!);
      expect(denom).toBe(2500);
    });

    it('falls back to the avg when no row exceeds it', () => {
      const denom = dailyBarDenominator(2240, [{ calories: 2000 }, { calories: 1800 }]);
      expect(denom).toBe(2240);
    });

    it('never returns 0 (avoids divide-by-zero in the screen)', () => {
      const denom = dailyBarDenominator(0, []);
      expect(denom).toBe(1);
    });
  });

  describe('aggregateDailyFromHistory — direct re-derivation', () => {
    const history: MealHistoryEntryShape[] = [
      // Two meals on 2026-04-25 — should sum into one row
      { id: 1, meal_date: '2026-04-25', meal_type: 'breakfast', name: 'Oatmeal', source: 'logged', items: [], totals: { calories: 600, protein_g: 25, carbs_g: 80, fat_g: 12 } },
      { id: 2, meal_date: '2026-04-25', meal_type: 'lunch', name: 'Chicken bowl', source: 'logged', items: [], totals: { calories: 900, protein_g: 65, carbs_g: 100, fat_g: 25 } },
      // One meal on 2026-04-23
      { id: 3, meal_date: '2026-04-23', meal_type: 'dinner', name: 'Pasta', source: 'logged', items: [], totals: { calories: 750, protein_g: 30, carbs_g: 110, fat_g: 18 } },
    ];

    it('sums all meals on the same date into one row', () => {
      const rows = aggregateDailyFromHistory(history);
      const apr25 = rows.find(r => r.date === '2026-04-25');
      expect(apr25?.calories).toBe(1500);
      expect(apr25?.protein_g).toBe(90);
      expect(apr25?.meal_count).toBe(2);
    });

    it('preserves single-meal days as-is', () => {
      const rows = aggregateDailyFromHistory(history);
      const apr23 = rows.find(r => r.date === '2026-04-23');
      expect(apr23?.calories).toBe(750);
      expect(apr23?.meal_count).toBe(1);
    });

    it('returns rows sorted newest-first', () => {
      const rows = aggregateDailyFromHistory(history);
      expect(rows[0].date).toBe('2026-04-25');
      expect(rows[1].date).toBe('2026-04-23');
    });

    it('handles empty input', () => {
      expect(aggregateDailyFromHistory([]).length).toBe(0);
    });

    it('skips meals with missing meal_date', () => {
      const dirty: MealHistoryEntryShape[] = [
        ...history,
        { id: 999, meal_date: '', meal_type: null, name: 'Bad', source: 'logged', items: [], totals: { calories: 9999, protein_g: 0, carbs_g: 0, fat_g: 0 } },
      ];
      const rows = aggregateDailyFromHistory(dirty);
      // The 9999-cal junk row should not have inflated any real day.
      const apr25 = rows.find(r => r.date === '2026-04-25');
      expect(apr25?.calories).toBe(1500);
    });

    it('rounds to 1 decimal so the UI does not show floating-point noise', () => {
      const noisy: MealHistoryEntryShape[] = [
        { id: 1, meal_date: '2026-04-25', meal_type: 'breakfast', name: 'A', source: 'logged', items: [], totals: { calories: 100.111, protein_g: 5.222, carbs_g: 12.333, fat_g: 3.444 } },
        { id: 2, meal_date: '2026-04-25', meal_type: 'lunch', name: 'B', source: 'logged', items: [], totals: { calories: 200.222, protein_g: 10.444, carbs_g: 24.666, fat_g: 6.888 } },
      ];
      const rows = aggregateDailyFromHistory(noisy);
      // Should round to 1 dp — no 300.33299999999997 nonsense.
      const decimals = String(rows[0].calories).split('.')[1] ?? '';
      expect(decimals.length <= 1).toBe(true);
    });
  });

  describe('macrosHeadlineFromDailyRows', () => {
    it('averages the same daily rows rendered under Recent Logged Days', () => {
      const rows = [
        { date: '2026-04-25', calories: 1500, protein_g: 90, carbs_g: 180, fat_g: 37, meal_count: 2 },
        { date: '2026-04-23', calories: 750, protein_g: 30, carbs_g: 110, fat_g: 18, meal_count: 1 },
      ];
      const h = macrosHeadlineFromDailyRows(rows);
      expect(h?.calories).toBe(1125);
      expect(h?.protein).toBe(60);
      expect(h?.carbs).toBe(145);
      expect(h?.fat).toBe(27.5);
    });

    it('returns null when no daily rows are available', () => {
      expect(macrosHeadlineFromDailyRows([])).toBe(null);
    });
  });

  describe('selectDailyRows — history takes precedence', () => {
    const history: MealHistoryEntryShape[] = [
      { id: 1, meal_date: '2026-04-25', meal_type: 'breakfast', name: 'A', source: 'logged', items: [], totals: { calories: 1500, protein_g: 90, carbs_g: 180, fat_g: 37 } },
    ];
    const averagesDaily = [
      { date: '2026-04-25', calories: 999, protein_g: 9, carbs_g: 9, fat_g: 9, meal_count: 1 },
    ];

    it('uses the history-derived rows when history is present', () => {
      const rows = selectDailyRows(history, averagesDaily);
      // History says 1500, averages.daily says 999 — history wins.
      expect(rows[0].calories).toBe(1500);
    });

    it('falls back to averages.daily when history is not loaded yet', () => {
      const rows = selectDailyRows(null, averagesDaily);
      expect(rows[0].calories).toBe(999);
    });

    it('trusts an empty loaded history over stale averages.daily rows', () => {
      const rows = selectDailyRows([], averagesDaily);
      expect(rows.length).toBe(0);
    });

    it('returns an empty array when both sources are empty', () => {
      const rows = selectDailyRows(null, undefined);
      expect(rows.length).toBe(0);
    });

    it('respects the limit', () => {
      const many: MealHistoryEntryShape[] = Array.from({ length: 10 }, (_, i) => ({
        id: i + 1,
        meal_date: `2026-04-${String(25 - i).padStart(2, '0')}`,
        meal_type: 'breakfast',
        name: `M${i}`,
        source: 'logged',
        items: [],
        totals: { calories: 1000, protein_g: 50, carbs_g: 100, fat_g: 25 },
      }));
      expect(selectDailyRows(many, undefined, 3).length).toBe(3);
    });
  });

  describe('isCardioHrZoneSource', () => {
    it('accepts explicitly cardio completion rows', () => {
      expect(isCardioHrZoneSource({
        focus_label: 'Morning Run',
        activity_category: 'cardio',
      })).toBe(true);
    });

    it('rejects explicit non-cardio categories even when HR zones exist elsewhere on the row', () => {
      expect(isCardioHrZoneSource({
        focus_label: 'Upper + Cardio',
        activity_category: 'strength',
        cardio_style: 'steady',
      })).toBe(false);
      expect(isCardioHrZoneSource({
        focus_label: 'Pickleball',
        activity_category: 'sport',
        activity_subtype: 'pickleball',
      })).toBe(false);
    });

    it('keeps legacy rows without category metadata when the focus or metrics are clearly cardio', () => {
      expect(isCardioHrZoneSource({ focus: 'Zone 2 Bike' })).toBe(true);
      expect(isCardioHrZoneSource({ focus: 'Workout', distanceMiles: 3.2 })).toBe(true);
      expect(isCardioHrZoneSource({ focus: 'Workout', routeCoords: [{ lat: 1, lon: 2 }] })).toBe(true);
    });

    it('rejects legacy strength-only focus rows', () => {
      expect(isCardioHrZoneSource({ focus: 'Push Strength' })).toBe(false);
      expect(isCardioHrZoneSource({ focus: 'Leg Day' })).toBe(false);
    });
  });

  describe('buildHrZoneSourceBreakdown', () => {
    const rows = [
      {
        id: 'planned-lift',
        date: '2026-05-13T10:00:00.000Z',
        focus: 'Upper Strength',
        sourceContext: 'planned',
        durationSeconds: 3600,
        hrZoneMinutes: [5, 18, 11, 0, 0],
      },
      {
        id: 'apple-run',
        workout_date: '2026-05-15',
        focus_label: 'Outdoor Run',
        source_context: 'apple_health',
        activity_category: 'cardio',
        duration_seconds: 2400,
        hr_summary: { zoneMinutes: [4, 30, 6, 0, 0] },
      },
      {
        id: 'old-row',
        workout_date: '2026-05-04',
        focus_label: 'Old Row',
        activity_category: 'cardio',
        hr_summary: { zoneMinutes: [0, 99, 0, 0, 0] },
      },
    ];

    it('totals HR zones for the week from all activity sources', () => {
      const breakdown = buildHrZoneSourceBreakdown(rows, '2026-05-11', '2026-05-17');
      expect(Math.round(breakdown.zoneMinutes[0])).toBe(9);
      expect(Math.round(breakdown.zoneMinutes[1])).toBe(48);
      expect(Math.round(breakdown.zoneMinutes[2])).toBe(17);
      expect(breakdown.contributors[1].map(c => c.name)).toEqual(['Outdoor Run', 'Upper Strength']);
      expect(breakdown.contributors[1][0].sourceLabel).toBe('Apple Health');
      expect(breakdown.contributors[1][1].sourceLabel).toBe('Planned workout');
    });

    it('can still reproduce cardio-only zone rollups for cardio surfaces', () => {
      const breakdown = buildHrZoneSourceBreakdown(rows, '2026-05-11', '2026-05-17', { cardioOnly: true });
      expect(Math.round(breakdown.zoneMinutes[1])).toBe(30);
      expect(breakdown.contributors[1].map(c => c.name)).toEqual(['Outdoor Run']);
    });
  });

  describe('hrZoneSourceLabel', () => {
    it('prefers import source labels when present', () => {
      expect(hrZoneSourceLabel({ import_source: 'strava', source_context: 'manual_activity' })).toBe('Strava');
    });
  });

  describe('strength volume trend', () => {
    const session = (id: string, date: string, exercises: any[], extra: Record<string, any> = {}) => ({
      id,
      date: `${date}T12:00:00.000Z`,
      completed: true,
      exercises,
      ...extra,
    });
    const exercise = (name: string, sets: Array<{ weightLbs: number; reps: number }>, extra: Record<string, any> = {}) => ({
      name,
      sets,
      ...extra,
    });

    it('counts loaded strength tonnage and excludes cardio, mobility, skipped, and zero-load rows', () => {
      const rows = [
        session('lift-1', '2026-05-15', [
          exercise('Bench Press', [
            { weightLbs: 45, reps: 10, setType: 'warmup' },
            { weightLbs: 100, reps: 10 },
            { weightLbs: 100, reps: 8 },
          ]),
          exercise('Squat', [{ weightLbs: 200, reps: 5 }]),
          exercise('Push-Up', [{ weightLbs: 0, reps: 20 }]),
        ]),
        session('run-1', '2026-05-15', [
          exercise('Treadmill Run', [{ weightLbs: 50, reps: 10 }], { primary_muscle: 'cardio' }),
        ]),
        session('mobility-1', '2026-05-16', [
          exercise('Yoga Flow', [{ weightLbs: 25, reps: 10 }], { prescription_type: 'mobility' }),
        ]),
        session('skipped-1', '2026-05-16', [
          exercise('Deadlift', [{ weightLbs: 300, reps: 5 }]),
        ], { skipped: true }),
      ];

      const volume = strengthVolumeForWindow(rows, '2026-05-11', '2026-05-17');
      expect(volume.volumeLbs).toBe(2800);
      expect(volume.loadedSets).toBe(3);
      expect(volume.sessionCount).toBe(1);
    });

    it('aggregates fixed week buckets instead of last-session rows', () => {
      const rows = [
        session('current', '2026-05-16', [
          exercise('Bench Press', [{ weightLbs: 100, reps: 10 }, { weightLbs: 100, reps: 8 }]),
        ]),
        session('prior-tiny', '2026-05-10', [
          exercise('Bench Press', [{ weightLbs: 20, reps: 5 }]),
        ]),
        session('older', '2026-05-03', [
          exercise('Squat', [{ weightLbs: 100, reps: 5 }]),
        ]),
      ];

      const trend = buildStrengthVolumeTrend(rows, { today: '2026-05-17' });
      expect(trend.weeks.length).toBe(9);
      expect(trend.bucketMode).toBe('fixed_week');
      expect(trend.current.startDate).toBe('2026-05-11');
      expect(trend.current.endDate).toBe('2026-05-17');
      expect(trend.current.volumeLbs).toBe(1800);
      expect(trend.previous?.startDate).toBe('2026-05-04');
      expect(trend.previous?.endDate).toBe('2026-05-10');
      expect(trend.previous?.volumeLbs).toBe(100);
      expect(trend.deltaPct).toBe(null);
      expect(trend.comparison).toBe('insufficient_previous');
    });

    it('compares current week-to-date against last week at the same point', () => {
      const rows = [
        session('current', '2026-05-19', [
          exercise('Bench Press', Array.from({ length: 4 }, () => ({ weightLbs: 60, reps: 5 }))),
        ]),
        session('prior-comparable', '2026-05-12', [
          exercise('Bench Press', Array.from({ length: 4 }, () => ({ weightLbs: 50, reps: 5 }))),
        ]),
        session('prior-after-comparable-point', '2026-05-16', [
          exercise('Deadlift', Array.from({ length: 4 }, () => ({ weightLbs: 500, reps: 10 }))),
        ]),
      ];

      const trend = buildStrengthVolumeTrend(rows, { today: '2026-05-19' });
      expect(trend.current.startDate).toBe('2026-05-18');
      expect(trend.current.endDate).toBe('2026-05-19');
      expect(trend.elapsedDays).toBe(2);
      expect(trend.previous?.startDate).toBe('2026-05-11');
      expect(trend.previous?.endDate).toBe('2026-05-12');
      expect(trend.current.volumeLbs).toBe(1200);
      expect(trend.previous?.volumeLbs).toBe(1000);
      expect(trend.weeks[1].endDate).toBe('2026-05-17');
      expect(trend.weeks[1].volumeLbs).toBe(21000);
      expect(trend.deltaPct).toBe(20);
      expect(trend.comparison).toBe('percent');
    });

    it('returns a percent only when the prior week has a useful baseline', () => {
      const rows = [
        session('current', '2026-05-16', [
          exercise('Bench Press', Array.from({ length: 4 }, () => ({ weightLbs: 60, reps: 5 }))),
        ]),
        session('prior', '2026-05-09', [
          exercise('Bench Press', Array.from({ length: 4 }, () => ({ weightLbs: 50, reps: 5 }))),
        ]),
      ];

      const trend = buildStrengthVolumeTrend(rows, { today: '2026-05-17' });
      expect(trend.current.volumeLbs).toBe(1200);
      expect(trend.previous?.volumeLbs).toBe(1000);
      expect(trend.deltaPct).toBe(20);
      expect(trend.deltaLbs).toBe(200);
      expect(trend.comparison).toBe('percent');
    });

    it('uses an absolute comparison instead of huge percent spikes', () => {
      const rows = [
        session('current', '2026-05-16', [
          exercise('Deadlift', Array.from({ length: 4 }, () => ({ weightLbs: 500, reps: 10 }))),
        ]),
        session('prior', '2026-05-09', [
          exercise('Deadlift', Array.from({ length: 4 }, () => ({ weightLbs: 50, reps: 5 }))),
        ]),
      ];

      const trend = buildStrengthVolumeTrend(rows, { today: '2026-05-17' });
      expect(trend.current.volumeLbs).toBe(20000);
      expect(trend.previous?.volumeLbs).toBe(1000);
      expect(trend.deltaPct).toBe(null);
      expect(trend.deltaLbs).toBe(19000);
      expect(trend.comparison).toBe('absolute');
    });
  });

  describe('strength load balance', () => {
    const session = (id: string, date: string, exercises: any[], extra: Record<string, any> = {}) => ({
      id,
      date: `${date}T12:00:00.000Z`,
      completed: true,
      exercises,
      ...extra,
    });
    const exercise = (name: string, sets: Array<Record<string, any>>, extra: Record<string, any> = {}) => ({
      name,
      sets,
      ...extra,
    });
    const sets = (count: number, weightLbs = 100, reps = 10) => (
      Array.from({ length: count }, () => ({ weightLbs, reps }))
    );

    it('credits primary muscles as 1 set and secondary muscles as 0.5 sets', () => {
      const rows = [
        session('current', '2026-05-16', [
          exercise('Bench Press', sets(8), {
            primary_muscle: 'chest',
            secondary_muscles: ['triceps', 'shoulders'],
          }),
        ]),
      ];

      const balance = buildStrengthLoadBalance(rows, { today: '2026-05-17' });
      const chest = balance.muscles.find(row => row.muscle === 'chest');
      const triceps = balance.muscles.find(row => row.muscle === 'triceps');
      const shoulders = balance.muscles.find(row => row.muscle === 'shoulders');
      expect(chest?.currentSets).toBe(8);
      expect(chest?.status).toBe('balanced');
      expect(triceps?.currentSets).toBe(4);
      expect(shoulders?.currentSets).toBe(4);
      expect(balance.activeMuscleCount).toBe(3);
      expect(balance.status).toBe('low');
      expect(balance.score).toBeGreaterThan(70);
    });

    it('counts bodyweight hard sets and infers biceps credit from pull movement names', () => {
      const rows = [
        session('current', '2026-05-16', [
          exercise('Chin-Up', [
            { weightLbs: 0, reps: 8 },
            { weightLbs: 0, reps: 7 },
          ]),
        ]),
      ];

      const balance = buildStrengthLoadBalance(rows, { today: '2026-05-17' });
      const back = balance.muscles.find(row => row.muscle === 'back');
      const biceps = balance.muscles.find(row => row.muscle === 'biceps');
      expect(balance.current.loadedSets).toBe(2);
      expect(balance.current.volumeLbs).toBe(0);
      expect(back?.currentSets).toBe(2);
      expect(biceps?.currentSets).toBe(1);
      expect(biceps?.secondarySets).toBe(1);
    });

    it('accepts camel-case completed-set fields from reconciled imports', () => {
      const rows = [
        session('current', '2026-05-16', [
          exercise('Dumbbell Curl', [
            { actualWeightLbs: 30, actualReps: 10, actualRir: 2 },
            { actualWeightLbs: 30, actualReps: 9, actualRir: 2 },
          ], { primary_muscle: 'biceps' }),
        ]),
      ];

      const balance = buildStrengthLoadBalance(rows, { today: '2026-05-17' });
      const biceps = balance.muscles.find(row => row.muscle === 'biceps');
      expect(balance.current.loadedSets).toBe(2);
      expect(balance.current.volumeLbs).toBe(570);
      expect(biceps?.currentSets).toBe(2);
    });

    it('scales weekly muscle-volume ranges when the caller asks for a 30-day window', () => {
      const rows = [
        session('current', '2026-05-16', [
          exercise('Barbell Curl', sets(12), { primary_muscle: 'biceps' }),
        ]),
      ];

      const balance = buildStrengthLoadBalance(rows, { today: '2026-05-17', windowDays: 30 });
      const biceps = balance.muscles.find(row => row.muscle === 'biceps');
      expect(balance.windowDays).toBe(30);
      expect(biceps?.targetMin).toBe(26);
      expect(biceps?.targetMax).toBe(60);
      expect(biceps?.currentSets).toBe(12);
      expect(biceps?.score).toBe(46);
    });

    it('uses prior windows to flag muscle-specific spikes', () => {
      const rows = [
        session('current', '2026-05-16', [
          exercise('Bench Press', sets(14), { primary_muscle: 'chest' }),
        ]),
        session('prior-1', '2026-05-09', [
          exercise('Bench Press', sets(8), { primary_muscle: 'chest' }),
        ]),
        session('prior-2', '2026-05-02', [
          exercise('Bench Press', sets(8), { primary_muscle: 'chest' }),
        ]),
        session('prior-3', '2026-04-25', [
          exercise('Bench Press', sets(8), { primary_muscle: 'chest' }),
        ]),
      ];

      const balance = buildStrengthLoadBalance(rows, { today: '2026-05-17' });
      const chest = balance.muscles.find(row => row.muscle === 'chest');
      expect(chest?.status).toBe('spike');
      expect(chest?.spikeRatio).toBe(1.75);
      expect(balance.status).toBe('spike');
      expect(balance.detail).toContain('chest');
    });

    it('scores only muscles with current or baseline data instead of punishing unrelated empty muscles', () => {
      const rows = [
        session('current', '2026-05-16', [
          exercise('Barbell Curl', [{ weightLbs: 100, reps: 10 }], { primary_muscle: 'biceps' }),
        ]),
      ];

      const balance = buildStrengthLoadBalance(rows, { today: '2026-05-17' });
      expect(balance.activeMuscleCount).toBe(1);
      expect(balance.muscles[0].muscle).toBe('biceps');
      expect(balance.score).toBe(17);
    });

    it('excludes non-strength rows and easy RIR sets from the balance score', () => {
      const rows = [
        session('current', '2026-05-16', [
          exercise('Treadmill Run', sets(10), { primary_muscle: 'cardio' }),
          exercise('Bench Press', [{ weightLbs: 100, reps: 10, rir: 6 }], { primary_muscle: 'chest' }),
          exercise('Bench Press', [{ weightLbs: 100, reps: 10, rir: 2 }], { primary_muscle: 'chest' }),
        ]),
      ];

      const balance = buildStrengthLoadBalance(rows, { today: '2026-05-17' });
      expect(balance.current.loadedSets).toBe(1);
      expect(balance.current.volumeLbs).toBe(1000);
      expect(balance.muscles[0].currentSets).toBe(1);
    });
  });
});
