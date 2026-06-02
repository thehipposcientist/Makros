import {
  liveActivityQuickStartKey,
  resolveLiveActivityQuickStart,
  LIVE_ACTIVITY_QUICK_START,
} from '../liveActivityQuickStart.ts';

describe('liveActivityQuickStart', () => {
  it('resolves watch-selected cardio subtype aliases', () => {
    const ride = resolveLiveActivityQuickStart({ subtype: 'cycling' });
    expect(ride?.subtype).toBe('ride');
    expect(ride?.category).toBe('cardio');

    const hiit = resolveLiveActivityQuickStart({ subtype: 'HIIT' });
    expect(hiit?.subtype).toBe('hiit');
    expect(hiit?.cardioStyle).toBe('intervals');

    const bootcamp = resolveLiveActivityQuickStart({ subtype: 'boot camp' });
    expect(bootcamp?.subtype).toBe('hiit');
    expect(bootcamp?.cardioStyle).toBe('intervals');

    const beachVolleyball = resolveLiveActivityQuickStart({ category: 'sport', subtype: 'beach volley ball' });
    expect(beachVolleyball?.subtype).toBe('beach_volleyball');
    expect(beachVolleyball?.category).toBe('sport');
    expect(beachVolleyball?.cardioStyle).toBe('intervals');

    const martialArts = resolveLiveActivityQuickStart({ category: 'sport', subtype: 'mma' });
    expect(martialArts?.subtype).toBe('martial_arts');
    expect(martialArts?.category).toBe('sport');
    expect(martialArts?.cardioStyle).toBe('intervals');
  });

  it('uses category to disambiguate watch starts', () => {
    const lift = resolveLiveActivityQuickStart({ category: 'strength', subtype: 'lift' });
    expect(lift?.label).toBe('Strength');
    expect(lift ? liveActivityQuickStartKey(lift) : '').toBe('strength:lift');

    const pilates = resolveLiveActivityQuickStart({ category: 'mobility', subtype: 'pilates' });
    expect(pilates?.label).toBe('Pilates');
    expect(pilates ? liveActivityQuickStartKey(pilates) : '').toBe('mobility:pilates');
  });

  it('returns null for unknown watch subtypes', () => {
    expect(resolveLiveActivityQuickStart({ subtype: 'underwater-basket-weaving' })).toBe(null);
    expect(resolveLiveActivityQuickStart(null)).toBe(null);
  });

  it('offers indoor + outdoor run as one subtype with distinct venues + keys', () => {
    const runs = LIVE_ACTIVITY_QUICK_START.filter(o => o.subtype === 'run');
    expect(runs.length).toBe(2);
    const venues = runs.map(o => o.venue).sort().join(',');
    expect(venues).toBe('indoor,outdoor');
    const keys = runs.map(liveActivityQuickStartKey).sort();
    expect(keys[0]).toBe('cardio:run:indoor');
    expect(keys[1]).toBe('cardio:run:outdoor');
    // The label encodes venue so the existing label-based GPS decision works.
    expect(runs.find(o => o.venue === 'indoor')?.label).toBe('Indoor Run');
    expect(runs.find(o => o.venue === 'outdoor')?.label).toBe('Outdoor Run');
  });

  it('resolves label and explicit venue before subtype defaults', () => {
    const indoorRun = resolveLiveActivityQuickStart({ category: 'cardio', subtype: 'run', label: 'Indoor Run' });
    expect(indoorRun?.venue).toBe('indoor');
    expect(indoorRun ? liveActivityQuickStartKey(indoorRun) : '').toBe('cardio:run:indoor');

    const indoorRide = resolveLiveActivityQuickStart({ category: 'cardio', subtype: 'ride', venue: 'indoor' });
    expect(indoorRide?.label).toBe('Indoor Ride');

    const legacyRun = resolveLiveActivityQuickStart({ category: 'cardio', subtype: 'run' });
    expect(legacyRun?.label).toBe('Outdoor Run');
  });

  it('offers venue pairs for common indoor/outdoor activities', () => {
    for (const [category, subtype] of [
      ['cardio', 'walk'],
      ['cardio', 'ride'],
      ['cardio', 'swim'],
      ['cardio', 'row'],
      ['sport', 'soccer'],
      ['sport', 'basketball'],
      ['sport', 'tennis'],
      ['sport', 'pickleball'],
      ['sport', 'volleyball'],
      ['mobility', 'yoga'],
    ] as const) {
      const options = LIVE_ACTIVITY_QUICK_START.filter(o => o.category === category && o.subtype === subtype);
      expect(options.map(o => o.venue).sort().join(',')).toBe('indoor,outdoor');
      expect(new Set(options.map(liveActivityQuickStartKey)).size).toBe(2);
    }
  });

  it('keeps a stable venue-less key for single-venue activities', () => {
    const lift = LIVE_ACTIVITY_QUICK_START.find(o => o.subtype === 'lift')!;
    expect(lift.venue).toBe(undefined);
    expect(liveActivityQuickStartKey(lift)).toBe('strength:lift');
  });
});
