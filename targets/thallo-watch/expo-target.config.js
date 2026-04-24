/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  // `watch` = standalone watchOS app. `@bacons/apple-targets` generates
  // an Xcode app target with the WatchOS SDK and handles the pairing
  // with the parent iOS app on build.
  type: 'watch',
  name: 'ThalloWatch',
  icon: '../../assets/images/thallo-icon.png',
  // watchOS 10 gives us the modern corner navigation + TimelineView
  // stride we need for the rest timer. Anything older misses APIs.
  deploymentTarget: '10.0',
  colors: {
    // Default accent = midnight-theme teal. Live theme color is pushed
    // from the phone via WatchConnectivity and overrides at runtime,
    // but this is what the user sees before the first sync.
    $accent: '#15C7B8',
  },
  entitlements: {
    // HealthKit (heart rate during workouts) + App Group for sharing
    // scratch data with the phone (rest timer state, active workout
    // pointer). Group ID matches the iOS app's entitlement.
    'com.apple.developer.healthkit': true,
    'com.apple.developer.healthkit.access': [],
    'com.apple.security.application-groups': [
      'group.com.thallo.app',
    ],
  },
};
