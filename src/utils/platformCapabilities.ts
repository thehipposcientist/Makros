export type AppPlatform = 'ios' | 'android' | 'web' | string;

export type HealthPlatformCopy = {
  platformLabel: string;
  dataLabel: string;
  deviceLabel: string;
  wearableLabel: string;
  statusCopy: string;
  proCopy: string;
  privacyCopy: string;
};

export function isAndroidPlatform(platform: AppPlatform): boolean {
  return platform === 'android';
}

export function isIosPlatform(platform: AppPlatform): boolean {
  return platform === 'ios';
}

export function supportsAppleHealth(platform: AppPlatform, nativeHealthKitAvailable: boolean): boolean {
  return isIosPlatform(platform) && nativeHealthKitAvailable;
}

export function supportsAppleWatchSync(platform: AppPlatform): boolean {
  return isIosPlatform(platform);
}

export function supportsIosLiveActivities(platform: AppPlatform): boolean {
  return isIosPlatform(platform);
}

export function supportsAndroidHealthConnect(platform: AppPlatform): boolean {
  return false;
}

export function healthPlatformCopy(platform: AppPlatform): HealthPlatformCopy {
  if (isAndroidPlatform(platform)) {
    return {
      platformLabel: 'Health Connect',
      dataLabel: 'Biometrics',
      deviceLabel: 'Android',
      wearableLabel: 'wearable',
      statusCopy: 'Health Connect support is coming soon. Thallo will keep using manual logs, in-app workouts, meal data, and recovery check-ins.',
      proCopy: 'Pro adds readiness, sleep, nutrition scoring, and Health Connect support when available.',
      privacyCopy: 'Optional. Health Connect will be used for readiness, sleep, heart-rate, activity, weight, nutrition summaries, cycle-aware guidance, and weekly check-in context when you choose to share it.',
    };
  }

  return {
    platformLabel: 'Apple Health',
    dataLabel: 'Biometrics',
    deviceLabel: 'iPhone',
    wearableLabel: 'Apple Watch',
    statusCopy: 'This build does not have HealthKit available. Thallo will keep using manual logs, in-app workouts, meal data, and recovery check-ins.',
    proCopy: 'Pro adds Apple Health, readiness, sleep, and nutrition scoring.',
    privacyCopy: 'Optional. Used for readiness, sleep, heart-rate, activity, weight, nutrition summaries, cycle-aware guidance, and weekly check-in context when you choose to share categories that have data from your iPhone, Apple Watch, or connected apps.',
  };
}
