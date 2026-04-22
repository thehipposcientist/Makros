import { requireOptionalNativeModule, requireNativeModule } from 'expo-modules-core';

let resolved: any = null;
try {
  if (typeof requireOptionalNativeModule === 'function') {
    resolved = requireOptionalNativeModule('ThalloHealthKitModule');
  } else {
    resolved = requireNativeModule('ThalloHealthKitModule');
  }
} catch (e) {
  console.warn('[thallo-healthkit] native module not registered:', e);
  resolved = null;
}

export default resolved;
