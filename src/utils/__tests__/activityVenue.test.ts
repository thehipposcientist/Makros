// Tests for the activity venue helper — the single source of truth for which
// activities are indoor/outdoor-ambiguous, their default venue, and whether a
// venue should drive GPS. This is what lets us keep ONE activity type per sport
// (with a venue attribute) instead of duplicating the catalog.

import {
  isVenueAmbiguous,
  defaultVenueForActivity,
  venueImpliesGps,
} from '../activityVenue.ts';

describe('isVenueAmbiguous', () => {
  it('flags genuinely-both activities (and their aliases)', () => {
    for (const s of ['run', 'walk', 'ride', 'bike', 'cycling', 'swim', 'row', 'soccer', 'basketball', 'tennis', 'pickleball', 'volleyball', 'climbing', 'yoga', 'moving', 'construction', 'playing']) {
      expect(isVenueAmbiguous('cardio', s)).toBe(true);
    }
  });
  it('does NOT flag inherently single-venue activities', () => {
    for (const s of ['hike', 'golf', 'surfing', 'skiing', 'beach_volleyball', 'yard_work', 'gardening', 'spin', 'treadmill', 'pilates', 'cleaning']) {
      expect(isVenueAmbiguous('cardio', s)).toBe(false);
    }
  });
});

describe('defaultVenueForActivity', () => {
  it('returns the only venue for fixed activities', () => {
    expect(defaultVenueForActivity('cardio', 'spin')).toBe('indoor');
    expect(defaultVenueForActivity('cardio', 'treadmill')).toBe('indoor');
    expect(defaultVenueForActivity('sport', 'beach_volleyball')).toBe('outdoor');
    expect(defaultVenueForActivity('cardio', 'hike')).toBe('outdoor');
    expect(defaultVenueForActivity('active', 'yard_work')).toBe('outdoor');
    expect(defaultVenueForActivity('active', 'cleaning')).toBe('indoor');
  });
  it('returns the common default for ambiguous activities', () => {
    expect(defaultVenueForActivity('cardio', 'run')).toBe('outdoor');
    expect(defaultVenueForActivity('cardio', 'ride')).toBe('outdoor');
    expect(defaultVenueForActivity('cardio', 'swim')).toBe('indoor');
    expect(defaultVenueForActivity('sport', 'basketball')).toBe('indoor');
    expect(defaultVenueForActivity('sport', 'climbing')).toBe('indoor');
    expect(defaultVenueForActivity('active', 'construction')).toBe('outdoor');
  });
  it('normalizes aliases (bike → ride)', () => {
    expect(defaultVenueForActivity('cardio', 'cycling')).toBe('outdoor');
    expect(defaultVenueForActivity('cardio', 'Bike')).toBe('outdoor');
  });
  it('falls back to outdoor for unknown subtypes', () => {
    expect(defaultVenueForActivity('cardio', 'kayaking')).toBe('outdoor');
  });
});

describe('venueImpliesGps', () => {
  it('never GPS-tracks indoors', () => {
    expect(venueImpliesGps('indoor', 'cardio', 'run')).toBe(false);
    expect(venueImpliesGps('indoor', 'cardio', 'ride')).toBe(false);
  });
  it('GPS-tracks outdoor distance activities', () => {
    expect(venueImpliesGps('outdoor', 'cardio', 'run')).toBe(true);
    expect(venueImpliesGps('outdoor', 'cardio', 'ride')).toBe(true);
    expect(venueImpliesGps('outdoor', 'cardio', 'hike')).toBe(true);
  });
  it('does not GPS-track outdoor stationary/sport activities', () => {
    expect(venueImpliesGps('outdoor', 'sport', 'tennis')).toBe(false);
    expect(venueImpliesGps('outdoor', 'cardio', 'swim')).toBe(false);
  });
});
