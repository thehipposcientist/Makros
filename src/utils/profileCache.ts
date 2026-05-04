function parseJsonIfString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const VALID_PREFERRED_SPLITS = new Set([
  'full_body',
  'upper_lower',
  'ppl',
  'ppl_upper_lower',
  'bro',
]);

export function validPreferredSplit(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return VALID_PREFERRED_SPLITS.has(normalized) ? normalized : undefined;
}

export function preserveLocalPreferredSplitWhenRemoteMissing<T extends Record<string, any>>(
  remoteProfile: T,
  currentProfile: unknown,
): T {
  if (validPreferredSplit(remoteProfile.preferredSplit)) return remoteProfile;
  const current = parseJsonIfString(currentProfile);
  if (!isRecord(current)) return remoteProfile;
  const localSplit = validPreferredSplit(current.preferredSplit);
  return localSplit ? { ...remoteProfile, preferredSplit: localSplit } : remoteProfile;
}

export function mergePulledUserProfileWithCurrentStats(
  pulledValue: unknown,
  currentStoredValue: unknown,
): unknown {
  const pulledProfile = parseJsonIfString(pulledValue);
  if (!isRecord(pulledProfile)) return pulledValue;

  const currentProfile = parseJsonIfString(currentStoredValue);
  if (!isRecord(currentProfile) || !isRecord(currentProfile.physicalStats)) {
    return preserveLocalPreferredSplitWhenRemoteMissing(pulledProfile, currentProfile);
  }

  return preserveLocalPreferredSplitWhenRemoteMissing({
    ...pulledProfile,
    physicalStats: {
      ...(isRecord(pulledProfile.physicalStats) ? pulledProfile.physicalStats : {}),
      ...currentProfile.physicalStats,
    },
  }, currentProfile);
}

export function encodePulledStateValueForStorage(
  key: string,
  value: unknown,
  currentStoredValue?: unknown,
): string {
  if (key === 'userProfile') {
    const merged = mergePulledUserProfileWithCurrentStats(value, currentStoredValue);
    if (isRecord(merged)) return JSON.stringify(merged);
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}
