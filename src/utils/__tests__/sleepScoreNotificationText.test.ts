import {
  buildSleepScoreNotificationContent,
  formatReadinessSnippet,
  formatSleepDuration,
  sleepScoreRecoveryPhrase,
} from '../sleepScoreNotificationText.ts';

describe('sleep score notification copy', () => {
  it('formats sleep duration as compact hours and minutes', () => {
    expect(formatSleepDuration(7.7)).toBe('7h 42m asleep');
    expect(formatSleepDuration(8)).toBe('8h asleep');
    expect(formatSleepDuration(null)).toBeNull();
  });

  it('keeps recovery wording non-judgmental', () => {
    expect(sleepScoreRecoveryPhrase(88)).toBe('Recovery looks excellent today.');
    expect(sleepScoreRecoveryPhrase(72)).toBe('Recovery looks strong today.');
    expect(sleepScoreRecoveryPhrase(54)).toBe('Recovery looks moderate today.');
    expect(sleepScoreRecoveryPhrase(41)).toBe("Keep today's training a little lighter.");
  });

  it('builds the final local notification content', () => {
    expect(buildSleepScoreNotificationContent({ score: 82, duration: 7.5 })).toEqual({
      title: 'Sleep score 82',
      body: '7h 30m asleep. Recovery looks strong today.',
    });
  });

  it('adds canonical readiness when available', () => {
    expect(formatReadinessSnippet({ score: 74, label: 'Ready', action: 'Train as planned.' })).toBe(
      'Readiness 74 (Ready): Train as planned.',
    );
    expect(buildSleepScoreNotificationContent(
      { score: 82, duration: 7.5 },
      { score: 74, label: 'Ready', action: 'Train as planned.' },
    )).toEqual({
      title: 'Sleep score 82',
      body: '7h 30m asleep. Readiness 74 (Ready): Train as planned.',
    });
  });
});
