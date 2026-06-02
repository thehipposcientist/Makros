const USER_CACHE_OWNER_FIELD = '_authUserId';

export function normalizeAuthUserId(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

export function cachedProfileOwnerId(profile: unknown): string | null {
  if (!profile || typeof profile !== 'object') return null;
  const record = profile as Record<string, unknown>;
  return normalizeAuthUserId(
    record[USER_CACHE_OWNER_FIELD]
    ?? record.authUserId
    ?? record.userId
    ?? record.user_id,
  );
}

export function stampCachedProfileOwner<T extends object>(profile: T, userId: unknown): T {
  const normalized = normalizeAuthUserId(userId);
  if (!normalized) return profile;
  return {
    ...profile,
    [USER_CACHE_OWNER_FIELD]: normalized,
  } as T;
}

export function shouldResetUserScopedCacheForLogin(input: {
  incomingUserId: unknown;
  previousUserId: unknown;
  cachedProfileOwnerId?: unknown;
  hasUserScopedCache: boolean;
}): boolean {
  const incoming = normalizeAuthUserId(input.incomingUserId);
  if (!incoming) return false;

  const previous = normalizeAuthUserId(input.previousUserId);
  if (previous && previous !== incoming) return true;

  const cachedOwner = normalizeAuthUserId(input.cachedProfileOwnerId);
  if (cachedOwner && cachedOwner !== incoming) return true;

  return !previous && !cachedOwner && input.hasUserScopedCache;
}
