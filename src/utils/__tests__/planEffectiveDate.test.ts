// Tests for plan-effective-date helper. Pure date math — no RN.
//
// `nextPlanWeekStart(activePlanWeekEnd, from?)` answers "when does my
// new setting kick in?". Two paths:
//   1. Active plan-week known → returns end_date + 1 (sign-up cadence).
//   2. No plan-week → falls back to today + 7.

import { nextPlanWeekStart } from '../planEffectiveDate.ts';

describe('nextPlanWeekStart — with active plan week', () => {
  it('returns end_date + 1 when an active week is known', () => {
    // User signed up Friday Apr 11; week ends Thu Apr 17.
    expect(nextPlanWeekStart('2026-04-17')).toBe('2026-04-18');
  });

  it('handles month boundary correctly', () => {
    // Week ending Apr 30 → next week starts May 1.
    expect(nextPlanWeekStart('2026-04-30')).toBe('2026-05-01');
  });

  it('handles year boundary correctly', () => {
    expect(nextPlanWeekStart('2025-12-31')).toBe('2026-01-01');
  });

  it('handles leap-year Feb correctly', () => {
    // 2028 is a leap year — Feb 29 should advance to Mar 1.
    expect(nextPlanWeekStart('2028-02-29')).toBe('2028-03-01');
  });

  it('preserves the day-of-week cadence across multiple cycles', () => {
    // Whatever weekday a week ENDS on, end+1 lands on the next-week
    // start, and end+8 lands on the SAME next-next-start. The function
    // must be cadence-preserving so a Friday-Thursday user keeps that
    // rhythm forever.
    const cycle1 = nextPlanWeekStart('2026-04-17');  // end Apr 17 → start Apr 18
    const cycle2 = nextPlanWeekStart('2026-04-24');  // end Apr 24 → start Apr 25
    const d1 = new Date(`${cycle1}T12:00:00`);
    const d2 = new Date(`${cycle2}T12:00:00`);
    expect(d1.getDay()).toBe(d2.getDay());
  });

  it('always advances exactly one day past the given end date', () => {
    // Regression: previously hard-coded to Monday — broke any user
    // whose plan week ended on a non-Sunday. Verify the result is
    // exactly end+1, not snapped to a calendar weekday.
    expect(nextPlanWeekStart('2026-04-17')).toBe('2026-04-18');
  });
});

describe('nextPlanWeekStart — fallback (no active plan week)', () => {
  it('returns today + 7 when no end date is provided', () => {
    const today = new Date('2026-04-29T10:00:00');  // Wed
    const result = nextPlanWeekStart(undefined, today);
    expect(result).toBe('2026-05-06');               // Wed + 7 = next Wed
  });

  it('falls back when end date is null', () => {
    const today = new Date('2026-04-29T10:00:00');
    expect(nextPlanWeekStart(null, today)).toBe('2026-05-06');
  });

  it('falls back when end date is empty string', () => {
    const today = new Date('2026-04-29T10:00:00');
    expect(nextPlanWeekStart('', today)).toBe('2026-05-06');
  });

  it('falls back when end date is malformed', () => {
    const today = new Date('2026-04-29T10:00:00');
    expect(nextPlanWeekStart('not-a-date', today)).toBe('2026-05-06');
  });
});

describe('nextPlanWeekStart — output format', () => {
  it('always returns YYYY-MM-DD', () => {
    const result = nextPlanWeekStart('2026-04-17');
    expect(result.length).toBe(10);
    expect(result.charAt(4)).toBe('-');
    expect(result.charAt(7)).toBe('-');
  });

  it('zero-pads single-digit months', () => {
    // Week ending Jan 8 → start Jan 9.
    expect(nextPlanWeekStart('2026-01-08')).toBe('2026-01-09');
  });

  it('zero-pads single-digit days', () => {
    // Week ending Mar 4 → start Mar 5.
    expect(nextPlanWeekStart('2026-03-04')).toBe('2026-03-05');
  });
});
