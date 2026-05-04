// Tests for birthday helpers — pure date math, no React.

import { ageOnBirthday, birthdayDismissKey, isBirthdayToday, pickBirthdayGreeting } from '../birthday.ts';

describe('isBirthdayToday', () => {
  it('matches when today equals the birthdate (any year)', () => {
    const today = new Date(2026, 4, 4);  // May 4 2026
    expect(isBirthdayToday('1990-05-04', today)).toBe(true);
  });

  it('does not match when today is a different MM-DD', () => {
    const today = new Date(2026, 4, 4);
    expect(isBirthdayToday('1990-05-05', today)).toBe(false);
    expect(isBirthdayToday('1990-04-04', today)).toBe(false);
  });

  it('returns false for missing or malformed birthdates', () => {
    const today = new Date(2026, 4, 4);
    expect(isBirthdayToday(null, today)).toBe(false);
    expect(isBirthdayToday(undefined, today)).toBe(false);
    expect(isBirthdayToday('', today)).toBe(false);
    expect(isBirthdayToday('not-a-date', today)).toBe(false);
    expect(isBirthdayToday('1990', today)).toBe(false);
  });

  it('matches Feb 29 birthdays on Feb 28 in non-leap years', () => {
    // 2026 is NOT a leap year — Feb 29 user celebrates Feb 28.
    const today = new Date(2026, 1, 28);
    expect(isBirthdayToday('1996-02-29', today)).toBe(true);
  });

  it('matches Feb 29 birthdays on the actual day in leap years', () => {
    // 2028 IS a leap year — Feb 29 user celebrates Feb 29.
    const today = new Date(2028, 1, 29);
    expect(isBirthdayToday('1996-02-29', today)).toBe(true);
  });

  it('does not match Feb 29 birthdays on Feb 28 of a leap year', () => {
    const today = new Date(2028, 1, 28);  // Feb 28 in a leap year
    expect(isBirthdayToday('1996-02-29', today)).toBe(false);
  });
});

describe('ageOnBirthday', () => {
  it('returns the age the user is turning today', () => {
    const today = new Date(2026, 4, 4);  // May 4 2026
    expect(ageOnBirthday('1990-05-04', today)).toBe(36);
  });

  it('returns null when today is not their birthday', () => {
    const today = new Date(2026, 4, 5);
    expect(ageOnBirthday('1990-05-04', today)).toBe(null);
  });

  it('returns null for missing birthdate', () => {
    const today = new Date(2026, 4, 4);
    expect(ageOnBirthday(null, today)).toBe(null);
  });

  it('returns null for nonsensical ages (data corruption guard)', () => {
    const today = new Date(2026, 4, 4);
    expect(ageOnBirthday('3000-05-04', today)).toBe(null);   // born in the future
    expect(ageOnBirthday('1700-05-04', today)).toBe(null);   // 326 years old
  });
});

describe('birthdayDismissKey', () => {
  it('encodes year-month-day so dismissal is per-day', () => {
    expect(birthdayDismissKey(new Date(2026, 4, 4))).toBe('birthday_dismissed_2026-05-04');
    expect(birthdayDismissKey(new Date(2027, 4, 4))).toBe('birthday_dismissed_2027-05-04');
  });

  it('zero-pads month and day', () => {
    expect(birthdayDismissKey(new Date(2026, 0, 1))).toBe('birthday_dismissed_2026-01-01');
  });
});

describe('pickBirthdayGreeting', () => {
  it('returns one of the canned greetings', () => {
    const today = new Date(2026, 4, 4);
    const allowed = ['Happy birthday', 'It\'s your day', 'Many happy returns', 'Cheers to you'];
    expect(allowed.includes(pickBirthdayGreeting('Sawyer', today))).toBe(true);
  });

  it('is stable for the same name + year', () => {
    const today = new Date(2026, 4, 4);
    const a = pickBirthdayGreeting('Sawyer', today);
    const b = pickBirthdayGreeting('Sawyer', today);
    expect(a).toBe(b);
  });

  it('handles missing name without throwing', () => {
    const today = new Date(2026, 4, 4);
    expect(typeof pickBirthdayGreeting(null, today)).toBe('string');
    expect(typeof pickBirthdayGreeting(undefined, today)).toBe('string');
  });
});
