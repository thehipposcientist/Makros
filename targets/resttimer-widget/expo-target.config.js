/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: 'widget',
  name: 'RestTimerWidget',
  icon: '../../assets/images/thallo-icon.png',
  deploymentTarget: '16.2',
  colors: {
    // Default theme color — overridden at runtime via ContentState.
    $accent: '#15C7B8',
  },
  entitlements: {
    // Widget extensions don't need HealthKit. App Groups added so the
    // widget extension and the main app can share state via SharedDefaults
    // — required for the future watch-complication target to read the
    // current rest-timer payload, and silences the prebuild warning
    // about a missing App Groups entitlement.
    'com.apple.security.application-groups': ['group.com.thallo.app'],
  },
};
