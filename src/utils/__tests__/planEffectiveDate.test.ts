// Tests for plan-effective-date helper. Pure date math — no RN.

import { nextPlanWeekStart } from '../planEffectiveDate.ts';

describe('nextPlanWeekStart', () => {
  it('returns next Monday when called on a Wednesday', () => {
    const wed = new Date('2026-04-29T10:00:00');  // 2026-04-29 is a Wednesday
    expect(nextPlanWeekStart(wed)).toBe('2026-05-04');
  });

  it('returns next Monday when called on a Sunday', () => {
    const sun = new Date('2026-05-03T10:00:00');  // 2026-05-03 is a Sunday
    expect(nextPlanWeekStart(sun)).toBe('2026-05-04');
  });

  it('returns the FOLLOWING Monday when called on a Monday', () => {
    // The active week's plan is already in flight on Monday — the
    // change applies to the week after this one.
    const mon = new Date('2026-05-04T10:00:00');  // Monday
    expect(nextPlanWeekStart(mon)).toBe('2026-05-11');
  });

  it('returns Monday when called on a Saturday', () => {
    const sat = new Date('2026-05-02T10:00:00');  // Saturday
    expect(nextPlanWeekStart(sat)).toBe('2026-05-04');
  });

  it('handles year boundary (Dec → Jan)', () => {
    const fri = new Date('2025-12-26T10:00:00');  // Friday
    expect(nextPlanWeekStart(fri)).toBe('2025-12-29');
  });

  it('returns YYYY-MM-DD (zero-padded)', () => {
    const wed = new Date('2026-04-29T10:00:00');
    const result = nextPlanWeekStart(wed);
    expect(result.length).toBe(10);
    expect(result.charAt(4)).toBe('-');
    expect(result.charAt(7)).toBe('-');
  });
});
