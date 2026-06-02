import {
  cachedProfileOwnerId,
  shouldResetUserScopedCacheForLogin,
  stampCachedProfileOwner,
} from '../authCacheIsolation.ts';

describe('auth cache isolation', () => {
  it('resets when the stored last user differs from the incoming account', () => {
    expect(shouldResetUserScopedCacheForLogin({
      incomingUserId: 2,
      previousUserId: 1,
      hasUserScopedCache: true,
    })).toBe(true);
  });

  it('resets unowned user-scoped cache when no last user id exists', () => {
    expect(shouldResetUserScopedCacheForLogin({
      incomingUserId: 2,
      previousUserId: null,
      cachedProfileOwnerId: null,
      hasUserScopedCache: true,
    })).toBe(true);
  });

  it('keeps cache when the previous user id matches', () => {
    expect(shouldResetUserScopedCacheForLogin({
      incomingUserId: '7',
      previousUserId: 7,
      hasUserScopedCache: true,
    })).toBe(false);
  });

  it('resets when a stamped cached profile belongs to a different user', () => {
    expect(shouldResetUserScopedCacheForLogin({
      incomingUserId: 'new-user',
      previousUserId: null,
      cachedProfileOwnerId: 'old-user',
      hasUserScopedCache: true,
    })).toBe(true);
  });

  it('stamps cached profiles with the auth owner id', () => {
    const stamped = stampCachedProfileOwner({ goal: 'maintain' }, 42);
    expect(cachedProfileOwnerId(stamped)).toBe('42');
  });
});

