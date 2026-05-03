// Integration-style unit tests for the Progress page's data-shaping
// layer. Renders nothing — exercises the pure helpers in
// `../progressData.ts` against representative API payloads to verify
// what the Progress page would actually display.
//
// Why this matters: the Nutrition Trend card and the Nutrition & Gut
// Facts card share a "Logged cal" label but used to disagree because
// they pulled from different aggregation windows. These tests pin that
// invariant + the macros-history bar denominator + sorting/slicing.
//
// Pure functions only — no React, no AsyncStorage. Runs under the
// repo's `--experimental-strip-types` Node runner.

import {
  type MealAveragesShape,
  type AdherenceTrendsShape,
  type MealHistoryEntryShape,
  aggregateDailyFromHistory,
  calorieDeltaLabel,
  dailyBarDenominator,
  headlineLoggedCalories,
  macrosHeadlineFromDailyRows,
  macrosHeadlineFromAverages,
  recentLoggedDays,
  selectDailyRows,
  trendDirectionInfo,
  trendFactsCalorieDiff,
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

const sampleTrends: AdherenceTrendsShape = {
  direction: 'improving',
  recent: {
    avg_calories: 1100,
    avg_calories_when_logged: 2300,
    tracking_rate_pct: 60,
    protein_hit_pct: 70,
  },
  tracking_delta_pct: 15,
  protein_hit_delta_pct: 12,
  calorie_delta: 200,
  calorie_delta_when_logged: 100,
  current_logging_streak_days: 3,
  current_protein_streak_days: 2,
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

  describe('headlineLoggedCalories — Trend ↔ Facts agreement', () => {
    it('returns the same number for both cards when averages is present', () => {
      // The whole point of this helper: BOTH cards source from the same
      // place. If the headline disagrees with itself, the test fails.
      const factsHeadline = headlineLoggedCalories(sampleAverages, null);
      const trendHeadline = headlineLoggedCalories(sampleAverages, sampleTrends);
      expect(factsHeadline).toBe(trendHeadline);
      expect(factsHeadline).toBe(2240);
    });

    it('falls back to recent.avg when averages is null (loading state)', () => {
      const v = headlineLoggedCalories(null, sampleTrends);
      expect(v).toBe(2300);
    });

    it('returns 0 when both inputs are missing', () => {
      expect(headlineLoggedCalories(null, null)).toBe(0);
    });
  });

  describe('trendFactsCalorieDiff (regression guard)', () => {
    it('reports the gap that motivated the alignment fix', () => {
      // averages.avg_cal_when_logged = 2240
      // trends.recent.avg_cal_when_logged = 2300
      // → diff = 60. The screen's Trend card now uses headline (2240),
      // so the displayed value matches Facts even though `recent` is 2300.
      const diff = trendFactsCalorieDiff(sampleAverages, sampleTrends);
      expect(diff).toBe(60);
    });

    it('is zero when the two sources agree (e.g. all-logged-days window)', () => {
      const aligned: AdherenceTrendsShape = {
        ...sampleTrends,
        recent: { ...sampleTrends.recent, avg_calories_when_logged: 2240 },
      };
      expect(trendFactsCalorieDiff(sampleAverages, aligned)).toBe(0);
    });
  });

  describe('calorieDeltaLabel', () => {
    it('formats positive deltas with a plus sign', () => {
      expect(calorieDeltaLabel({ calorie_delta_when_logged: 250 })).toBe('+250');
    });

    it('formats negative deltas with the minus sign baked in', () => {
      expect(calorieDeltaLabel({ calorie_delta_when_logged: -120 })).toBe('-120');
    });

    it('falls back to calorie_delta when the when_logged variant is missing', () => {
      expect(calorieDeltaLabel({ calorie_delta: 80 })).toBe('+80');
    });

    it('rounds the delta to a whole number', () => {
      expect(calorieDeltaLabel({ calorie_delta_when_logged: 12.7 })).toBe('+13');
    });
  });

  describe('trendDirectionInfo', () => {
    it('maps known directions to the right bucket', () => {
      expect(trendDirectionInfo('improving').bucket).toBe('success');
      expect(trendDirectionInfo('slipping').bucket).toBe('warning');
      expect(trendDirectionInfo('steady').bucket).toBe('neutral');
    });

    it('treats unknown values as steady', () => {
      expect(trendDirectionInfo(undefined).bucket).toBe('neutral');
      expect(trendDirectionInfo('garbage').bucket).toBe('neutral');
    });

    it('returns a user-facing label', () => {
      expect(trendDirectionInfo('improving').label).toBe('Improving');
      expect(trendDirectionInfo('slipping').label).toBe('Slipping');
      expect(trendDirectionInfo('steady').label).toBe('Steady');
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
});
