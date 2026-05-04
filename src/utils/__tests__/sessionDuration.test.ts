import {
  clampDisplayedSessionMinutes,
  sessionDurationRange,
} from '../sessionDuration.ts';

describe('session duration display range', () => {
  it('treats duration picker values as the top of a 15-minute range', () => {
    expect(sessionDurationRange(45)).toEqual({ min: 30, max: 45 });
    expect(sessionDurationRange(60)).toEqual({ min: 45, max: 60 });
    expect(sessionDurationRange(75)).toEqual({ min: 60, max: 75 });
  });

  it('does not show a workout below the selected range', () => {
    expect(clampDisplayedSessionMinutes(42, 60)).toBe(45);
  });

  it('still caps unusually long estimates at the selected range max', () => {
    expect(clampDisplayedSessionMinutes(76, 60)).toBe(60);
  });

  it('leaves raw estimates alone when no session range is available', () => {
    expect(clampDisplayedSessionMinutes(42, null)).toBe(42);
  });
});
