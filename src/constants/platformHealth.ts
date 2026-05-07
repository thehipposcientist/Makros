import { Platform } from 'react-native';

export const HEALTH_PLATFORM_LABEL = Platform.OS === 'android' ? 'Health Connect' : 'Apple Health';
export const HEALTH_DEVICE_LABEL = Platform.OS === 'android' ? 'Android' : 'iPhone';
export const HEALTH_WEARABLE_LABEL = Platform.OS === 'android' ? 'wearable' : 'Apple Watch';

export const HEALTH_PLATFORM_STATUS_COPY =
  Platform.OS === 'android'
    ? 'Health Connect support is coming soon. Thallo will keep using manual logs, in-app workouts, meal data, and recovery check-ins.'
    : 'This build does not have HealthKit available. Thallo will keep using manual logs, in-app workouts, meal data, and recovery check-ins.';

export const HEALTH_PLATFORM_PRO_COPY =
  Platform.OS === 'android'
    ? 'Pro adds readiness, sleep, nutrition scoring, and Health Connect support when available.'
    : 'Pro adds Apple Health, readiness, sleep, and nutrition scoring.';

export const HEALTH_PLATFORM_PRIVACY_COPY =
  Platform.OS === 'android'
    ? 'Optional. Health Connect will be used for readiness, sleep, heart-rate, activity, weight, cycle-aware guidance, and weekly check-in context when you choose to share it.'
    : 'Optional. Used for readiness, sleep, heart-rate, activity, weight, cycle-aware guidance, and weekly check-in context when you choose to share it.';

