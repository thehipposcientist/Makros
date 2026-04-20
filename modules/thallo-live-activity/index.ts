// Re-exports the native module registered in expo-module.config.json.
// Consumers should import from src/services/liveActivity.ts which wraps
// this with graceful fallbacks.
//
// IMPORTANT: `requireNativeModule` can throw a non-catchable fatal at
// module-load time on certain Expo SDKs if the native module isn't
// registered. We defer the resolution into a try/catch so the app can
// still run even if the module isn't compiled into the IPA yet.
import { requireOptionalNativeModule, requireNativeModule } from 'expo-modules-core';

let resolved: any = null;
try {
  // Prefer the optional variant when available — it returns null instead
  // of throwing if the module isn't registered.
  if (typeof requireOptionalNativeModule === 'function') {
    resolved = requireOptionalNativeModule('ThalloLiveActivityModule');
  } else {
    resolved = requireNativeModule('ThalloLiveActivityModule');
  }
} catch (e) {
  console.warn('[thallo-live-activity] native module not registered:', e);
  resolved = null;
}

export default resolved;
