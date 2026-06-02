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
  entitlements: {},
};
