// Tests for workout-history free-text search — the matcher shared by
// the Progress screen's history search and the staleness reminders.
// Pure functions, no React Native runtime needed.

import type { WorkoutSession } from '../../types';
import {
  filterWorkoutHistory,
  sessionMatchesDateFilter,
  sessionMatchesQuery,
  sessionMatchesTypeFilter,
  lastLoggedDateForQuery,
  workoutDaysAgoLabel,
} from '../workoutHistorySearch.ts';

function session(overrides: Partial<WorkoutSession>): WorkoutSession {
  return {
    id: 's',
    date: '2026-05-01',
    focus: '',
    durationSeconds: 0,
    exercises: [],
    completed: true,
    skipped: false,
    ...overrides,
  } as WorkoutSession;
}

function exercise(name: string) {
  return { name, sets: [] } as any;
}

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('workoutHistorySearch', () => {
  describe('sessionMatchesQuery', () => {
    it('matches everything on an empty query', () => {
      expect(sessionMatchesQuery(session({ focus: 'Push' }), '')).toBe(true);
      expect(sessionMatchesQuery(session({ focus: 'Push' }), '   ')).toBe(true);
    });

    it('matches an exercise name substring', () => {
      const s = session({ exercises: [exercise('Barbell Bench Press')] });
      expect(sessionMatchesQuery(s, 'bench')).toBe(true);
      expect(sessionMatchesQuery(s, 'BENCH')).toBe(true);
      expect(sessionMatchesQuery(s, 'squat')).toBe(false);
    });

    it('matches the focus label', () => {
      expect(sessionMatchesQuery(session({ focus: 'Leg Day' }), 'leg')).toBe(true);
    });

    it('AND-matches every whitespace token', () => {
      const s = session({ exercises: [exercise('Incline Dumbbell Bench Press')] });
      expect(sessionMatchesQuery(s, 'incline bench')).toBe(true);
      expect(sessionMatchesQuery(s, 'incline squat')).toBe(false);
    });

    it('matches a manual-activity category or subtype', () => {
      const s = session({ exercises: [], manualActivity: { category: 'cardio', subtype: 'Trail Run' } as any });
      expect(sessionMatchesQuery(s, 'trail')).toBe(true);
      expect(sessionMatchesQuery(s, 'cardio')).toBe(true);
    });

    it('matches import/source labels', () => {
      const s = session({ importSource: 'Strava', manualActivity: { category: 'cardio', subtype: 'Ride', source: 'apple_health' } as any });
      expect(sessionMatchesQuery(s, 'strava')).toBe(true);
      expect(sessionMatchesQuery(s, 'apple')).toBe(true);
    });
  });

  describe('filters', () => {
    const now = new Date('2026-05-16T12:00:00');

    it('filters by recent date ranges using local calendar days', () => {
      expect(sessionMatchesDateFilter(session({ date: '2026-05-16' }), '7d', now)).toBe(true);
      expect(sessionMatchesDateFilter(session({ date: '2026-05-10' }), '7d', now)).toBe(true);
      expect(sessionMatchesDateFilter(session({ date: '2026-05-09' }), '7d', now)).toBe(false);
      expect(sessionMatchesDateFilter(session({ date: '2026-04-17' }), '30d', now)).toBe(true);
      expect(sessionMatchesDateFilter(session({ date: '2026-04-16' }), '30d', now)).toBe(false);
    });

    it('filters by manual activity category', () => {
      const cardio = session({ exercises: [], manualActivity: { category: 'cardio', subtype: 'Run' } as any });
      const mobility = session({ exercises: [], manualActivity: { category: 'mobility', subtype: 'Yoga' } as any });
      expect(sessionMatchesTypeFilter(cardio, 'cardio')).toBe(true);
      expect(sessionMatchesTypeFilter(cardio, 'strength')).toBe(false);
      expect(sessionMatchesTypeFilter(mobility, 'mobility')).toBe(true);
    });

    it('filters manually logged activities as activities', () => {
      const activity = session({ exercises: [], manualActivity: { category: 'sport', subtype: 'Pickleball' } as any });
      const planned = session({ exercises: [exercise('Bench Press')] });
      expect(sessionMatchesTypeFilter(activity, 'activities')).toBe(true);
      expect(sessionMatchesTypeFilter(planned, 'activities')).toBe(false);
    });

    it('classifies planned strength and cardio sessions without manualActivity', () => {
      const strength = session({ focus: 'Upper Body', exercises: [exercise('Barbell Bench Press')] });
      const cardio = session({ focus: 'Zone 2 Run', exercises: [exercise('Treadmill Run')] });
      expect(sessionMatchesTypeFilter(strength, 'strength')).toBe(true);
      expect(sessionMatchesTypeFilter(strength, 'cardio')).toBe(false);
      expect(sessionMatchesTypeFilter(cardio, 'cardio')).toBe(true);
      expect(sessionMatchesTypeFilter(cardio, 'strength')).toBe(false);
    });

    it('keeps imported core training under strength when it was cached as cardio', () => {
      const core = session({
        focus: 'Core Training',
        exercises: [],
        manualActivity: {
          category: 'cardio',
          subtype: 'Core Training',
          intensity: 'moderate',
          source: 'apple_health',
        } as any,
      });
      expect(sessionMatchesTypeFilter(core, 'strength')).toBe(true);
      expect(sessionMatchesTypeFilter(core, 'cardio')).toBe(false);
    });

    it('filters PR and imported sessions', () => {
      const pr = session({ prs: [{ exercise_name: 'Squat', kind: 'estimated_1rm', new_value: 250, old_value: 240 }] as any });
      const imported = session({ importSource: 'Strong' });
      expect(sessionMatchesTypeFilter(pr, 'prs')).toBe(true);
      expect(sessionMatchesTypeFilter(imported, 'imported')).toBe(true);
    });

    it('combines query, date, and type filters', () => {
      const history = [
        session({ id: 'recent-run', date: '2026-05-15', exercises: [], manualActivity: { category: 'cardio', subtype: 'Trail Run' } as any }),
        session({ id: 'old-run', date: '2026-04-01', exercises: [], manualActivity: { category: 'cardio', subtype: 'Trail Run' } as any }),
        session({ id: 'recent-lift', date: '2026-05-15', exercises: [exercise('Bench Press')] }),
      ];
      expect(filterWorkoutHistory(history, { query: 'trail', dateFilter: '30d', typeFilter: 'cardio', now }).map(s => s.id))
        .toEqual(['recent-run']);
    });
  });

  describe('lastLoggedDateForQuery', () => {
    const history = [
      session({ id: 'a', date: '2026-05-10', exercises: [exercise('Deadlift')] }),
      session({ id: 'b', date: '2026-05-08', exercises: [exercise('Bench Press')] }),
      session({ id: 'c', date: '2026-05-01', exercises: [exercise('Deadlift')] }),
    ];

    it('returns the most-recent (first) matching date', () => {
      expect(lastLoggedDateForQuery(history, 'deadlift')).toBe('2026-05-10');
      expect(lastLoggedDateForQuery(history, 'bench')).toBe('2026-05-08');
    });

    it('returns null when nothing matches', () => {
      expect(lastLoggedDateForQuery(history, 'overhead press')).toBe(null);
    });

    it('ignores skipped sessions', () => {
      const withSkip = [
        session({ id: 'x', date: '2026-05-12', skipped: true, exercises: [exercise('Deadlift')] }),
        ...history,
      ];
      expect(lastLoggedDateForQuery(withSkip, 'deadlift')).toBe('2026-05-10');
    });
  });

  describe('workoutDaysAgoLabel', () => {
    it('labels recent dates relatively', () => {
      expect(workoutDaysAgoLabel(isoDaysAgo(0))).toBe('today');
      expect(workoutDaysAgoLabel(isoDaysAgo(1))).toBe('yesterday');
      expect(workoutDaysAgoLabel(isoDaysAgo(3))).toBe('3 days ago');
      expect(workoutDaysAgoLabel(isoDaysAgo(10))).toBe('last week');
      expect(workoutDaysAgoLabel(isoDaysAgo(16))).toBe('2 weeks ago');
    });

    it('returns an empty string for missing or unparseable dates', () => {
      expect(workoutDaysAgoLabel(null)).toBe('');
      expect(workoutDaysAgoLabel(undefined)).toBe('');
      expect(workoutDaysAgoLabel('not-a-date')).toBe('');
    });
  });
});
