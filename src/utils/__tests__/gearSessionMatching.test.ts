import { findMatchingGearForSession } from '../gearSessionMatching.ts';
import type { GearItem } from '../../services/api';

function gear(id: number, name: string, keywords: string[]): GearItem {
  return {
    id,
    name,
    gear_type: 'running_shoe',
    purchase_date: null,
    starting_miles: 0,
    accumulated_miles: 0,
    accumulated_sessions: 0,
    retirement_threshold_miles: 400,
    retirement_threshold_sessions: null,
    total_miles: 0,
    pct_used: 0,
    recommendation: null,
    last_used_at: null,
    notes: null,
    auto_track_keywords: keywords,
    photos: [],
    is_active: true,
    created_at: '2026-05-04T00:00:00Z',
  };
}

describe('findMatchingGearForSession', () => {
  it('returns every active gear keyword match so the UI can disambiguate', () => {
    const matches = findMatchingGearForSession(
      [
        gear(1, 'Daily Trainers', ['run']),
        gear(2, 'Race Shoes', ['run']),
        gear(3, 'Bike', ['ride']),
      ],
      'Run',
      ['Outdoor Run'],
    );
    expect(matches.map(item => item.id)).toEqual([1, 2]);
  });

  it('matches exercise names for strength gear and ignores blank keywords', () => {
    const matches = findMatchingGearForSession(
      [
        gear(1, 'Lifting Belt', ['deadlift', '']),
        gear(2, 'Running Shoes', ['run']),
      ],
      'Pull',
      ['Romanian Deadlift'],
    );
    expect(matches.map(item => item.id)).toEqual([1]);
  });
});
