const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Keep Metro out of large on-disk artifacts at the PROJECT ROOT that have
// no JS for it to bundle. The patterns are anchored to `__dirname` so we
// don't accidentally block `node_modules/<dep>/android/...` or
// `node_modules/<dep>/ios/build/...` (most native modules ship those
// directories — blocking them breaks resolution of expo-router et al).
//   - build-*.ipa             : EAS local-build outputs (~600 MB each)
//   - assets/full-library.zip : input zip for sync-move-kit-demos.mjs
//   - ios/build, ios/DerivedData : Xcode archive/build output
//   - android/                : Gradle build cache (we're iOS-first)
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const root = escapeRegExp(__dirname);

config.resolver.blockList = [
  new RegExp(`^${root}/build-.*\\.ipa$`),
  new RegExp(`^${root}/assets/full-library\\.zip$`),
  new RegExp(`^${root}/ios/build/`),
  new RegExp(`^${root}/ios/DerivedData/`),
  new RegExp(`^${root}/android/`),
];

module.exports = config;
