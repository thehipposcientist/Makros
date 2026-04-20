// Re-exports the native module registered in expo-module.config.json.
// Consumers should import from src/services/liveActivity.ts which wraps
// this with graceful fallbacks.
import { requireNativeModule } from 'expo-modules-core';

export default requireNativeModule('ThalloLiveActivityModule');
