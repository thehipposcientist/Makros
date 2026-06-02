import { Platform } from 'react-native';
import { healthPlatformCopy } from '../utils/platformCapabilities';

const PLATFORM_HEALTH_COPY = healthPlatformCopy(Platform.OS);

export const HEALTH_PLATFORM_LABEL = PLATFORM_HEALTH_COPY.platformLabel;
export const HEALTH_DATA_LABEL = PLATFORM_HEALTH_COPY.dataLabel;
export const HEALTH_DEVICE_LABEL = PLATFORM_HEALTH_COPY.deviceLabel;
export const HEALTH_WEARABLE_LABEL = PLATFORM_HEALTH_COPY.wearableLabel;
export const HEALTH_PLATFORM_STATUS_COPY = PLATFORM_HEALTH_COPY.statusCopy;
export const HEALTH_PLATFORM_PRO_COPY = PLATFORM_HEALTH_COPY.proCopy;
export const HEALTH_PLATFORM_PRIVACY_COPY = PLATFORM_HEALTH_COPY.privacyCopy;
