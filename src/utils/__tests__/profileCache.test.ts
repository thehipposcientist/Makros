import {
  encodePulledStateValueForStorage,
  mergePulledUserProfileWithCurrentStats,
  preserveLocalPreferredSplitWhenRemoteMissing,
} from '../profileCache.ts';

describe('profile cache merge', () => {
  it('keeps current Body stats when a pulled userProfile contains stale cached stats', () => {
    const pulled = {
      goal: 'body_recomp',
      physicalStats: {
        weightLbs: 150,
        heightFeet: 6,
      },
      mealVariety: 4,
    };
    const current = {
      goal: 'body_recomp',
      physicalStats: {
        weightLbs: 181,
        age: 31,
      },
    };

    expect(mergePulledUserProfileWithCurrentStats(pulled, JSON.stringify(current))).toEqual({
      goal: 'body_recomp',
      physicalStats: {
        weightLbs: 181,
        heightFeet: 6,
        age: 31,
      },
      mealVariety: 4,
    });
  });

  it('uses the pulled profile unchanged when no current physicalStats exist', () => {
    const pulled = {
      goal: 'fat_loss',
      physicalStats: { weightLbs: 170 },
    };

    expect(mergePulledUserProfileWithCurrentStats(pulled, { goal: 'fat_loss' })).toEqual(pulled);
  });

  it('encodes pulled userProfile JSON strings after merging with current stats', () => {
    const encoded = encodePulledStateValueForStorage(
      'userProfile',
      JSON.stringify({ goal: 'maintain', physicalStats: { weightLbs: 140, heightFeet: 5 } }),
      JSON.stringify({ physicalStats: { weightLbs: 180 } }),
    );

    expect(JSON.parse(encoded)).toEqual({
      goal: 'maintain',
      physicalStats: {
        weightLbs: 180,
        heightFeet: 5,
      },
    });
  });

  it('keeps local preferredSplit when the pulled profile is missing it', () => {
    const encoded = encodePulledStateValueForStorage(
      'userProfile',
      { goal: 'body_recomp', physicalStats: { weightLbs: 170 } },
      JSON.stringify({ preferredSplit: 'ppl', physicalStats: { weightLbs: 180 } }),
    );

    expect(JSON.parse(encoded)).toEqual({
      goal: 'body_recomp',
      physicalStats: {
        weightLbs: 180,
      },
      preferredSplit: 'ppl',
    });
  });

  it('lets an explicit remote preferredSplit beat the local cache', () => {
    expect(
      preserveLocalPreferredSplitWhenRemoteMissing(
        { preferredSplit: 'upper_lower' },
        { preferredSplit: 'ppl' },
      ),
    ).toEqual({ preferredSplit: 'upper_lower' });
  });

  it('leaves non-profile string values untouched', () => {
    expect(encodePulledStateValueForStorage('trainerNote', 'keep me')).toBe('keep me');
  });
});
