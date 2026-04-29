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
    // Widget extensions don't need HealthKit. App Groups intentionally
    // omitted (would require registering the capability in Apple
    // Developer Portal against the widget app ID first). The "App
    // Groups warning" at prebuild is non-fatal — Live Activities
    // communicate via ActivityAttributes, not SharedDefaults.
  },
};
