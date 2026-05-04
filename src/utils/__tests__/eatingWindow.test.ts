// Tests for the eating-window / time-restricted eating helper. The
// pure functions (computeEatingWindow, weeklyAverageWindow,
// windowInsightFor) are independent of AsyncStorage so we exercise
// them directly with fixture maps.

import {
  computeEatingWindow,
  weeklyAverageWindow,
  windowInsightFor,
} from '../eatingWindow.ts';

describe('computeEatingWindow — empty / missing data', () => {
  it('returns nulls when the date has no entries', () => {
    const r = computeEatingWindow({}, '2026-04-26');
    expect(r.firstMealTime).toBe(null);
    expect(r.lastMealTime).toBe(null);
    expect(r.windowHours).toBe(null);
    expect(r.fastingHours).toBe(null);
  });

  it('returns nulls when the date entry is empty', () => {
    const r = computeEatingWindow({ '2026-04-26': {} }, '2026-04-26');
    expect(r.windowHours).toBe(null);
  });

  it('ignores garbage time strings', () => {
    const r = computeEatingWindow(
      { '2026-04-26': { meal_0: 'not a time', meal_1: '10' } },
      '2026-04-26',
    );
    expect(r.windowHours).toBe(null);
  });
});

describe('computeEatingWindow — happy path', () => {
  it('first / last / window from sorted check times', () => {
    const r = computeEatingWindow(
      { '2026-04-26': { meal_0: '07:30', meal_1: '12:00', meal_2: '19:30' } },
      '2026-04-26',
    );
    expect(r.firstMealTime).toBe('07:30');
    expect(r.lastMealTime).toBe('19:30');
    expect(r.windowHours).toBe(12);
  });

  it('handles meals checked out of order', () => {
    const r = computeEatingWindow(
      { '2026-04-26': { meal_0: '19:30', meal_1: '07:30', meal_2: '12:00' } },
      '2026-04-26',
    );
    expect(r.firstMealTime).toBe('07:30');
    expect(r.lastMealTime).toBe('19:30');
  });

  it('rounds windowHours to 1 decimal', () => {
    const r = computeEatingWindow(
      { '2026-04-26': { meal_0: '08:15', meal_1: '20:00' } },  // 11h45m = 11.75
      '2026-04-26',
    );
    expect(r.windowHours).toBe(11.8);
  });

  it('single check returns 0-hour window (one timestamp = both endpoints)', () => {
    const r = computeEatingWindow(
      { '2026-04-26': { meal_0: '12:00' } },
      '2026-04-26',
    );
    expect(r.windowHours).toBe(0);
    expect(r.firstMealTime).toBe('12:00');
    expect(r.lastMealTime).toBe('12:00');
  });
});

describe('computeEatingWindow — fasting hours', () => {
  it('computes fasting from prior-day last meal to today first meal', () => {
    // 2026-04-25 last meal 21:00 → 2026-04-26 first meal 07:00.
    // Fasting = (24-21) + 7 = 10 hours.
    const r = computeEatingWindow(
      {
        '2026-04-25': { d: '21:00' },
        '2026-04-26': { b: '07:00', l: '12:00' },
      },
      '2026-04-26',
    );
    expect(r.fastingHours).toBe(10);
  });

  it('null when prior day has no entries', () => {
    const r = computeEatingWindow(
      { '2026-04-26': { b: '07:00' } },
      '2026-04-26',
    );
    expect(r.fastingHours).toBe(null);
  });

  it('null when prior day key exists but is empty', () => {
    const r = computeEatingWindow(
      { '2026-04-25': {}, '2026-04-26': { b: '07:00' } },
      '2026-04-26',
    );
    expect(r.fastingHours).toBe(null);
  });

  it('handles cross-month boundary', () => {
    const r = computeEatingWindow(
      {
        '2026-03-31': { d: '20:00' },
        '2026-04-01': { b: '08:00' },
      },
      '2026-04-01',
    );
    // (24-20) + 8 = 12h
    expect(r.fastingHours).toBe(12);
  });

  it('handles cross-year boundary', () => {
    const r = computeEatingWindow(
      {
        '2025-12-31': { d: '22:00' },
        '2026-01-01': { b: '06:00' },
      },
      '2026-01-01',
    );
    // (24-22) + 6 = 8h
    expect(r.fastingHours).toBe(8);
  });
});

describe('weeklyAverageWindow', () => {
  it('returns null when fewer than 3 days of data', () => {
    const r = weeklyAverageWindow(
      { '2026-04-26': { b: '08:00', d: '20:00' } },
      '2026-04-26',
    );
    expect(r.avgHours).toBe(null);
    expect(r.daysWithData).toBe(1);
  });

  it('averages over the 7-day window when 3+ days exist', () => {
    const map: Record<string, Record<string, string>> = {};
    for (let i = 0; i < 5; i++) {
      const dt = new Date(2026, 3, 26 - i);  // April is month 3 (0-indexed)
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      map[key] = { b: '08:00', d: '18:00' };  // 10h window
    }
    const r = weeklyAverageWindow(map, '2026-04-26');
    expect(r.avgHours).toBe(10);
    expect(r.daysWithData).toBe(5);
  });

  it('respects a custom window length', () => {
    const map: Record<string, Record<string, string>> = {};
    for (let i = 0; i < 14; i++) {
      const dt = new Date(2026, 3, 26 - i);
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      map[key] = { b: '08:00', d: '18:00' };
    }
    const r = weeklyAverageWindow(map, '2026-04-26', 14);
    expect(r.daysWithData).toBe(14);
  });

  it('skips days with null windowHours but still averages others', () => {
    const map: Record<string, Record<string, string>> = {
      '2026-04-26': { b: '08:00', d: '18:00' },  // 10h
      '2026-04-25': {},                            // null
      '2026-04-24': { b: '07:00', d: '21:00' },  // 14h
      '2026-04-23': { b: '08:00', d: '20:00' },  // 12h
    };
    const r = weeklyAverageWindow(map, '2026-04-26');
    // (10 + 14 + 12) / 3 = 12
    expect(r.avgHours).toBe(12);
    expect(r.daysWithData).toBe(3);
  });
});

describe('windowInsightFor', () => {
  const todayDay = {
    date: '2026-04-26',
    firstMealTime: '08:00',
    lastMealTime: '20:00',
    windowHours: 12,
    fastingHours: 12,
  };

  it('"within" when current window <= target + 0.5h', () => {
    const r = windowInsightFor(todayDay, 12);
    expect(r.status).toBe('within');
    expect(r.message.includes('12')).toBe(true);
  });

  it('"within" with the half-hour tolerance', () => {
    const r = windowInsightFor({ ...todayDay, windowHours: 12.4 }, 12);
    expect(r.status).toBe('within');
  });

  it('"over" when current window > target + 0.5h', () => {
    const r = windowInsightFor({ ...todayDay, windowHours: 14 }, 10);
    expect(r.status).toBe('over');
    expect(r.message.includes('14')).toBe(true);
    expect(r.message.includes('10')).toBe(true);
  });

  it('"unknown" when windowHours is null', () => {
    const r = windowInsightFor({ ...todayDay, windowHours: null }, 12);
    expect(r.status).toBe('unknown');
    expect(r.message.includes('Check meals')).toBe(true);
  });

  it('"unknown" when targetHours is null even if windowHours exists', () => {
    const r = windowInsightFor(todayDay, null);
    expect(r.status).toBe('unknown');
    // Falls into the "we know window but no target" branch.
    expect(r.message.includes('window today')).toBe(true);
  });
});
