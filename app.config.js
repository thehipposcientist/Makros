const appJson = require('./app.json');

const GOOGLE_CLIENT_ID_RE = /^\d+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/;

function configured(...values) {
  for (const value of values) {
    const cleaned = (value ?? '').trim();
    if (GOOGLE_CLIENT_ID_RE.test(cleaned)) {
      return cleaned;
    }
  }
  return undefined;
}

function envBoolean(value) {
  const cleaned = (value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(cleaned)) return true;
  if (['0', 'false', 'no', 'off'].includes(cleaned)) return false;
  return undefined;
}

function setBillingFeatureFlag(expo, flagName, envValue) {
  const parsed = envBoolean(envValue);
  if (parsed === undefined) return;
  expo.extra.featureFlags = {
    ...(expo.extra.featureFlags ?? {}),
    billing: {
      ...((expo.extra.featureFlags ?? {}).billing ?? {}),
      [flagName]: parsed,
    },
  };
}

module.exports = ({ config }) => {
  const expo = {
    ...appJson.expo,
    ...config,
    extra: {
      ...(appJson.expo.extra ?? {}),
      ...(config.extra ?? {}),
    },
  };

  const googleWebClientId = configured(
    process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
    process.env.GOOGLE_WEB_CLIENT_ID,
    process.env.GOOGLE_CLIENT_ID,
  );
  const googleIosClientId = configured(
    process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
    process.env.GOOGLE_IOS_CLIENT_ID,
  );
  const googleAndroidClientId = configured(
    process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID,
    process.env.GOOGLE_ANDROID_CLIENT_ID,
  );

  if (googleWebClientId) expo.extra.googleWebClientId = googleWebClientId;
  if (googleIosClientId) expo.extra.googleIosClientId = googleIosClientId;
  if (googleAndroidClientId) expo.extra.googleAndroidClientId = googleAndroidClientId;

  if (process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY) {
    expo.extra.revenueCatIosApiKey = process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
  }
  if (process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY) {
    expo.extra.revenueCatAndroidApiKey = process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY;
  }
  if (process.env.EXPO_PUBLIC_REVENUECAT_PRO_ENTITLEMENT_ID) {
    expo.extra.revenueCatProEntitlementId = process.env.EXPO_PUBLIC_REVENUECAT_PRO_ENTITLEMENT_ID;
  }
  setBillingFeatureFlag(expo, 'revenueCat', process.env.EXPO_PUBLIC_BILLING_REVENUECAT);
  setBillingFeatureFlag(expo, 'dummyPayment', process.env.EXPO_PUBLIC_BILLING_DUMMY_PAYMENT);

  return expo;
};
