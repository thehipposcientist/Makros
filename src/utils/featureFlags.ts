import Constants from 'expo-constants';

declare const __DEV__: boolean | undefined;

export type FeatureFlagKey =
  | 'billing.revenueCat'
  | 'billing.dummyPayment'
  | 'healthInsights.riskSignals';

function isDevRuntime(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ === true;
}

const DEFAULT_FLAGS: Record<FeatureFlagKey, boolean> = {
  'billing.revenueCat': false,
  // Dummy upgrade/downgrade is available in local/dev builds. The backend
  // endpoints it calls are independently gated by DUMMY_BILLING_ENABLED.
  'billing.dummyPayment': isDevRuntime(),
  'healthInsights.riskSignals': true,
};

function extraFeatureFlags(): Record<string, any> {
  const extra = Constants.expoConfig?.extra as Record<string, any> | undefined;
  return (extra?.featureFlags && typeof extra.featureFlags === 'object')
    ? extra.featureFlags
    : {};
}

function nestedFlag(flags: Record<string, any>, key: FeatureFlagKey): boolean | undefined {
  const parts = key.split('.');
  let cursor: any = flags;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object' || !(part in cursor)) return undefined;
    cursor = cursor[part];
  }
  return typeof cursor === 'boolean' ? cursor : undefined;
}

export function isFeatureEnabled(key: FeatureFlagKey): boolean {
  const envKey = `EXPO_PUBLIC_${key.replace(/\./g, '_').toUpperCase()}`;
  const envValue = process.env[envKey];
  if (envValue === '0' || envValue === 'false') return false;
  if (envValue === '1' || envValue === 'true') return true;
  return nestedFlag(extraFeatureFlags(), key) ?? DEFAULT_FLAGS[key];
}
