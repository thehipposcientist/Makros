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
    // automatically. App Groups intentionally omitted: would require
    // registering the App Group capability against the watch + widget
    // app IDs in Apple Developer Portal first, otherwise EAS signing
    // fails with "provisioning profile doesn't support App Group".
    // We don't actually share data via SharedDefaults today — all
    // phone↔watch traffic is WCSession. Re-add when the watch
    // complication ships and uses SharedDefaults.
    'com.apple.developer.healthkit': true,
  },
};
