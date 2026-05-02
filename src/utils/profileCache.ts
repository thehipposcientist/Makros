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

export function mergePulledUserProfileWithCurrentStats(
  pulledValue: unknown,
  currentStoredValue: unknown,
): unknown {
  const pulledProfile = parseJsonIfString(pulledValue);
  if (!isRecord(pulledProfile)) return pulledValue;

  const currentProfile = parseJsonIfString(currentStoredValue);
  if (!isRecord(currentProfile) || !isRecord(currentProfile.physicalStats)) {
    return pulledProfile;
  }

  return {
    ...pulledProfile,
    physicalStats: {
      ...(isRecord(pulledProfile.physicalStats) ? pulledProfile.physicalStats : {}),
      ...currentProfile.physicalStats,
    },
  };
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
