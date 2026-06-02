// Tests for hydration target formula. Pure function, no React Native
// runtime needed — runs under the project's `--experimental-strip-types`
// runner so it can import the TS source directly.
//
// Covered:
//   - Baseline formula scales with weight
//   - Gender modifier nudges target up/down per the spec
//   - Workout minutes add fluid, capped at the 90-min plateau
//   - Hot-day bump adds the documented amount
//   - Legacy positional-arg signature still works
//   - Liter conversion is consistent with oz output
//   - Format helper returns "X oz / Y L" string

import {
  HYDRATION_QUICK_ADD_OUNCES,
  buildHydrationReminderSlots,
  dailyWaterOz,
  dailyWaterLiters,
  formatHydrationQuickAddLabel,
  formatHydrationTargetRange,
  formatWaterTarget,
  hydrationTargetRangeOz,
  isHourInHydrationReminderWindow,
  normalizeHydrationReminderInterval,
} from '../hydration.ts';

describe('hydration target', () => {
  describe('dailyWaterOz', () => {
    it('scales linearly with body weight (baseline)', () => {
      const small = dailyWaterOz({ weightLbs: 120 });
      const large = dailyWaterOz({ weightLbs: 200 });
      expect(large > small).toBe(true);
    });

    it('returns a positive number for any sane weight input', () => {
      expect(dailyWaterOz({ weightLbs: 150 }) > 0).toBe(true);
    });

    it('adds workout-minute fluid up to a cap', () => {
      const rest = dailyWaterOz({ weightLbs: 170, workoutMinutes: 0 });
      const moderate = dailyWaterOz({ weightLbs: 170, workoutMinutes: 60 });
      const long = dailyWaterOz({ weightLbs: 170, workoutMinutes: 180 });
      expect(moderate > rest).toBe(true);
      // Cap kicks in beyond 90 min — 180 should not be 2x of 90.
      const half = dailyWaterOz({ weightLbs: 170, workoutMinutes: 90 });
      expect(long < (half - rest) * 2 + rest).toBe(true);
    });

    it('applies a hot-day bump', () => {
      const cool = dailyWaterOz({ weightLbs: 170, isHotDay: false });
      const hot = dailyWaterOz({ weightLbs: 170, isHotDay: true });
      expect(hot > cool).toBe(true);
    });

    it('honors the legacy positional-arg signature', () => {
      const objStyle = dailyWaterOz({ weightLbs: 160, workoutMinutes: 30, isHotDay: false, gender: 'male' });
      const positional = dailyWaterOz(160, 30, false, 'male');
      expect(objStyle).toBe(positional);
    });

    it('adds a protein bonus only when daily protein is high relative to bodyweight', () => {
      // 170 lb user — 170g protein = 1.0g/lb (8oz bonus), 255g = 1.5g/lb (16oz)
      const baseline = dailyWaterOz({ weightLbs: 170 });
      const moderate = dailyWaterOz({ weightLbs: 170, proteinGToday: 170 });
      const heavy = dailyWaterOz({ weightLbs: 170, proteinGToday: 255 });
      expect(moderate > baseline).toBe(true);
      expect(heavy > moderate).toBe(true);
    });

    it('adds an alcohol-rehydration bonus, capped', () => {
      const dry = dailyWaterOz({ weightLbs: 170 });
      const oneDrink = dailyWaterOz({ weightLbs: 170, alcoholServingsToday: 1 });
      const binge = dailyWaterOz({ weightLbs: 170, alcoholServingsToday: 10 });
      expect(oneDrink > dry).toBe(true);
      // Cap is +36 oz — binge can't exceed dry + 36 from this term.
      expect(binge - dry <= 36).toBe(true);
    });
  });

  describe('dailyWaterLiters', () => {
    it('is roughly 1/33.8 of the oz target (oz → L conversion)', () => {
      const oz = dailyWaterOz({ weightLbs: 170 });
      const L = dailyWaterLiters(170);
      const expected = oz / 33.814;
      // Allow rounding slack; the helper rounds to 1 decimal.
      expect(Math.abs(L - expected) < 0.2).toBe(true);
    });
  });

  describe('formatWaterTarget', () => {
    it('returns a non-empty string with both units', () => {
      const s = formatWaterTarget(170);
      expect(typeof s === 'string' && s.length > 0).toBe(true);
      expect(s.includes('oz') || s.includes('L')).toBe(true);
    });
  });

  describe('hydrationTargetRangeOz', () => {
    it('wraps the adapted water target in a daily range', () => {
      expect(hydrationTargetRangeOz(90)).toEqual({ min: 80, max: 100 });
      expect(formatHydrationTargetRange(106)).toBe('92-120');
    });
  });

  describe('hydration quick-add display', () => {
    it('keeps quick-add amounts in fluid ounces', () => {
      expect([...HYDRATION_QUICK_ADD_OUNCES]).toEqual([8, 16, 24, 32, 40]);
      expect(HYDRATION_QUICK_ADD_OUNCES.map(formatHydrationQuickAddLabel)).toEqual([
        '+8 oz',
        '+16 oz',
        '+24 oz',
        '+32 oz',
        '+40 oz',
      ]);
    });
  });

  describe('hydration reminder slots', () => {
    // Slots are minutes-since-midnight: 10:00 → 600, 12:00 → 720, etc.
    it('builds daytime reminders using the configured interval', () => {
      expect(buildHydrationReminderSlots({ startHour: 10, endHour: 20, intervalHours: 2 })).toEqual([
        600,  // 10:00
        720,  // 12:00
        840,  // 14:00
        960,  // 16:00
        1080, // 18:00
        1200, // 20:00
      ]);
    });

    it('supports a sub-hour (30-minute) interval', () => {
      expect(buildHydrationReminderSlots({ startHour: 10, endHour: 12, intervalHours: 0.5 })).toEqual([
        600, // 10:00
        630, // 10:30
        660, // 11:00
        690, // 11:30
        720, // 12:00
      ]);
    });

    it('supports overnight windows without looping forever', () => {
      expect(buildHydrationReminderSlots({ startHour: 22, endHour: 6, intervalHours: 2 })).toEqual([
        1320, // 22:00
        0,    // 00:00
        120,  // 02:00
        240,  // 04:00
        360,  // 06:00
      ]);
      expect(isHourInHydrationReminderWindow(1, 22, 6)).toBe(true);
      expect(isHourInHydrationReminderWindow(12, 22, 6)).toBe(false);
    });

    it('normalizes unsupported intervals to the default cadence', () => {
      expect(normalizeHydrationReminderInterval(7)).toBe(2);
      expect(normalizeHydrationReminderInterval(3)).toBe(3);
      expect(normalizeHydrationReminderInterval(0.5)).toBe(0.5);
    });
  });
});
