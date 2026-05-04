import {
  liveActivityQuickStartKey,
  resolveLiveActivityQuickStart,
} from '../liveActivityQuickStart.ts';

describe('liveActivityQuickStart', () => {
  it('resolves watch-selected cardio subtype aliases', () => {
    const ride = resolveLiveActivityQuickStart({ subtype: 'cycling' });
    expect(ride?.subtype).toBe('ride');
    expect(ride?.category).toBe('cardio');

    const hiit = resolveLiveActivityQuickStart({ subtype: 'HIIT' });
    expect(hiit?.subtype).toBe('bootcamp');
    expect(hiit?.cardioStyle).toBe('intervals');
  });

  it('uses category to disambiguate watch starts', () => {
    const lift = resolveLiveActivityQuickStart({ category: 'strength', subtype: 'lift' });
    expect(lift?.label).toBe('Strength');
    expect(lift ? liveActivityQuickStartKey(lift) : '').toBe('strength:lift');
  });

  it('returns null for unknown watch subtypes', () => {
    expect(resolveLiveActivityQuickStart({ subtype: 'underwater-basket-weaving' })).toBe(null);
    expect(resolveLiveActivityQuickStart(null)).toBe(null);
  });
});
