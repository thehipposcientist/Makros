import Constants from 'expo-constants';
import { Linking, Platform } from 'react-native';

const DEFAULT_ENTITLEMENT_ID = 'pro';

let configuredAppUserId: string | null = null;

function extraValue(key: string): string | undefined {
  const extra = Constants.expoConfig?.extra as Record<string, unknown> | undefined;
  const value = extra?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function revenueCatEntitlementId(): string {
  return (
    process.env.EXPO_PUBLIC_REVENUECAT_PRO_ENTITLEMENT_ID
    || extraValue('revenueCatProEntitlementId')
    || DEFAULT_ENTITLEMENT_ID
  );
}

function revenueCatApiKey(): string | undefined {
  if (Platform.OS === 'ios') {
    return process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY || extraValue('revenueCatIosApiKey');
  }
  if (Platform.OS === 'android') {
    return process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY || extraValue('revenueCatAndroidApiKey');
  }
  return undefined;
}

export async function configureRevenueCat(appUserId: string): Promise<any> {
  const trimmedAppUserId = appUserId.trim();
  if (!trimmedAppUserId) {
    throw new Error('RevenueCat app user id is missing.');
  }
  const apiKey = revenueCatApiKey();
  if (!apiKey) {
    throw new Error(`RevenueCat is not configured for ${Platform.OS}. Add the EXPO_PUBLIC_REVENUECAT_${Platform.OS === 'ios' ? 'IOS' : 'ANDROID'}_API_KEY build variable.`);
  }
  const mod = await import('react-native-purchases');
  const Purchases = mod.default ?? mod;
  Purchases.setLogLevel?.(mod.LOG_LEVEL?.WARN ?? 'WARN');

  const nativeConfigured = await Purchases.isConfigured?.().catch(() => configuredAppUserId != null);
  if (!nativeConfigured) {
    Purchases.configure({ apiKey, appUserID: trimmedAppUserId });
    configuredAppUserId = trimmedAppUserId;
    return Purchases;
  }

  const currentAppUserId = await Purchases.getAppUserID?.().catch(() => configuredAppUserId);
  if (currentAppUserId !== trimmedAppUserId) {
    await Purchases.logIn(trimmedAppUserId);
  }
  configuredAppUserId = trimmedAppUserId;
  return Purchases;
}

export function customerInfoHasPro(customerInfo: any): boolean {
  const entitlementId = revenueCatEntitlementId();
  return customerInfo?.entitlements?.active?.[entitlementId] != null;
}

function firstAvailablePackage(offerings: any): any | null {
  const currentPackages = offerings?.current?.availablePackages;
  if (Array.isArray(currentPackages) && currentPackages.length > 0) {
    return currentPackages[0];
  }
  const all = offerings?.all && typeof offerings.all === 'object' ? Object.values(offerings.all) : [];
  for (const offering of all as any[]) {
    if (Array.isArray(offering?.availablePackages) && offering.availablePackages.length > 0) {
      return offering.availablePackages[0];
    }
  }
  return null;
}

export async function getRevenueCatCustomerInfo(appUserId: string): Promise<any> {
  const Purchases = await configureRevenueCat(appUserId);
  return Purchases.getCustomerInfo();
}

export async function purchaseProSubscription(appUserId: string): Promise<{ customerInfo: any; isActive: boolean }> {
  const Purchases = await configureRevenueCat(appUserId);
  const offerings = await Purchases.getOfferings();
  const pkg = firstAvailablePackage(offerings);
  if (!pkg) {
    throw new Error('No Pro subscription offering is available yet. Check RevenueCat offerings and App Store / Play Console product setup.');
  }
  const result = await Purchases.purchasePackage(pkg);
  const customerInfo = result?.customerInfo ?? result;
  return { customerInfo, isActive: customerInfoHasPro(customerInfo) };
}

export async function restoreRevenueCatPurchases(appUserId: string): Promise<{ customerInfo: any; isActive: boolean }> {
  const Purchases = await configureRevenueCat(appUserId);
  const customerInfo = await Purchases.restorePurchases();
  return { customerInfo, isActive: customerInfoHasPro(customerInfo) };
}

export async function openRevenueCatSubscriptionManagement(appUserId: string): Promise<void> {
  const Purchases = await configureRevenueCat(appUserId);
  if (Platform.OS === 'ios' && typeof Purchases.showManageSubscriptions === 'function') {
    try {
      await Purchases.showManageSubscriptions();
      return;
    } catch {
      // Fall through to the RevenueCat/store URL path.
    }
  }

  const customerInfo = typeof Purchases.getCustomerInfo === 'function'
    ? await Purchases.getCustomerInfo().catch(() => null)
    : null;
  const managementURL = typeof customerInfo?.managementURL === 'string' ? customerInfo.managementURL.trim() : '';
  if (managementURL) {
    await Linking.openURL(managementURL);
    return;
  }

  await Linking.openURL(
    Platform.OS === 'android'
      ? 'https://play.google.com/store/account/subscriptions'
      : 'https://apps.apple.com/account/subscriptions',
  );
}
