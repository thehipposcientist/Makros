import { mergeCustomExercises } from './customExercises.ts';

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

function finitePositiveNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null;
}

function timeValue(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

function latestWeightEvidence(profile: unknown): { weightLbs: number; sortMs: number } | null {
  const parsed = parseJsonIfString(profile);
  if (!isRecord(parsed)) return null;
  // SavedDatabaseEntity weight history is DB-canonical. Only the
  // backend-shaped weightEntries cache can influence profile weight;
  // legacy weightHistory blobs are ignored as local-only stale data.
  const rows = Array.isArray(parsed.weightEntries) ? parsed.weightEntries : [];
  let latest: { weightLbs: number; sortMs: number } | null = null;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const weightLbs = finitePositiveNumber(row.weight_lbs ?? row.weightLbs);
    if (weightLbs == null) continue;
    const sortMs = Math.max(timeValue(row.logged_at ?? row.loggedAt), timeValue(row.date));
    if (!latest || sortMs >= latest.sortMs) latest = { weightLbs, sortMs };
  }
  return latest;
}

function freshestWeightFromProfiles(pulledProfile: unknown, currentProfile: unknown): number | null {
  const pulled = latestWeightEvidence(pulledProfile);
  const current = latestWeightEvidence(currentProfile);
  if (pulled && current) return pulled.sortMs >= current.sortMs ? pulled.weightLbs : current.weightLbs;
  if (pulled) return pulled.weightLbs;
  if (current) return current.weightLbs;
  return null;
}

function mergedCustomExercisesIfPresent(
  pulledProfile: Record<string, any>,
  currentProfile: unknown,
): { customExercises: unknown[] } | {} {
  const pulledExercises = Array.isArray(pulledProfile.customExercises)
    ? pulledProfile.customExercises
    : null;
  const currentExercises = isRecord(currentProfile) && Array.isArray(currentProfile.customExercises)
    ? currentProfile.customExercises
    : null;
  if (!pulledExercises && !currentExercises) return {};
  return {
    customExercises: mergeCustomExercises(pulledExercises ?? [], currentExercises ?? []),
  };
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
  const freshestWeightLbs = freshestWeightFromProfiles(pulledProfile, currentProfile);
  if (!isRecord(currentProfile) || !isRecord(currentProfile.physicalStats)) {
    const merged = freshestWeightLbs == null ? pulledProfile : {
      ...pulledProfile,
      physicalStats: {
        ...(isRecord(pulledProfile.physicalStats) ? pulledProfile.physicalStats : {}),
        weightLbs: freshestWeightLbs,
      },
    };
    return preserveLocalPreferredSplitWhenRemoteMissing({
      ...merged,
      ...mergedCustomExercisesIfPresent(pulledProfile, currentProfile),
    }, currentProfile);
  }

  const mergedPhysicalStats = {
    ...(isRecord(pulledProfile.physicalStats) ? pulledProfile.physicalStats : {}),
    ...currentProfile.physicalStats,
    ...(freshestWeightLbs == null ? {} : { weightLbs: freshestWeightLbs }),
  };

  return preserveLocalPreferredSplitWhenRemoteMissing({
    ...pulledProfile,
    physicalStats: mergedPhysicalStats,
    ...mergedCustomExercisesIfPresent(pulledProfile, currentProfile),
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
