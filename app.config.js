const appJson = require('./app.json');

function configured(...values) {
  for (const value of values) {
    const cleaned = (value ?? '').trim();
    if (cleaned && !cleaned.startsWith('$') && !cleaned.includes('missing-google-client-id')) {
      return cleaned;
    }
  }
  return undefined;
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

  return expo;
};
