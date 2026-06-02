import {
  DB_CANONICAL_ASYNC_STORAGE_KEYS,
  STORAGE_KEYS,
  USER_STATE_SYNC_KEYS,
  isDbCanonicalUserStateKey,
} from '../storageKeys.ts';

describe('storage policy keys', () => {
  it('does not sync canonical user data through the opaque user-state blob', () => {
    expect(USER_STATE_SYNC_KEYS).toEqual([]);
    for (const key of DB_CANONICAL_ASYNC_STORAGE_KEYS) {
      expect(USER_STATE_SYNC_KEYS.includes(key)).toBe(false);
      expect(isDbCanonicalUserStateKey(key)).toBe(true);
    }
  });

  it('keeps auth token keys out of AsyncStorage sync policy', () => {
    expect(DB_CANONICAL_ASYNC_STORAGE_KEYS.includes(STORAGE_KEYS.auth.token)).toBe(false);
    expect(DB_CANONICAL_ASYNC_STORAGE_KEYS.includes(STORAGE_KEYS.auth.tokenV2)).toBe(false);
    expect(USER_STATE_SYNC_KEYS.includes(STORAGE_KEYS.auth.token)).toBe(false);
    expect(USER_STATE_SYNC_KEYS.includes(STORAGE_KEYS.auth.tokenV2)).toBe(false);
  });

  it('uses a v2 persisted read-cache namespace after removing plaintext token cache keys', () => {
    expect(STORAGE_KEYS.cache.readCachePrefix).toBe('read_cache_v2::');
    expect(STORAGE_KEYS.cache.legacyReadCachePrefix).toBe('read_cache_v1::');
    expect(STORAGE_KEYS.cache.readCachePrefix === STORAGE_KEYS.cache.legacyReadCachePrefix).toBe(false);
  });
});
