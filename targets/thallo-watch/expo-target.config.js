/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  // Standalone watchOS companion. `@bacons/apple-targets` generates
  // the Xcode target during `expo prebuild` and handles the parent-app
  // pairing automatically — no manual Xcode work required.
  type: 'watch',
  name: 'ThalloWatch',
  icon: '../../assets/images/thallo-icon.png',
  // watchOS 10 — modern TabView page style + TimelineView stride the
  // active-workout view relies on. Any older would force API rewrites.
  deploymentTarget: '10.0',
  colors: {
    // Startup accent before the phone's theme sync lands. Midnight
    // theme's teal — same default as the iOS app.
    $accent: '#15C7B8',
  },
  entitlements: {
    // HealthKit for live heart rate during workouts. WatchConnectivity
    // needs NO entitlement — it's enabled for every paired watch app
    // automatically. App Groups added so the watch app can read the
    // SharedDefaults payload the iOS app writes (powers the future
    // watch-complication on the watch face, and lets the watch survive
    // a phone restart with last-known plan + readiness cached).
    'com.apple.developer.healthkit': true,
    'com.apple.security.application-groups': ['group.com.thallo.app'],
  },
};
