/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  // watchOS complication / Smart Stack widget. It renders the compact
  // workout + hydration snapshot written by the watch app, then opens
  // the watch app for actions so persistence stays on the WCSession path.
  type: 'watch-widget',
  name: 'ThalloWatchComplication',
  deploymentTarget: '10.0',
  colors: {
    $accent: '#15C7B8',
  },
  entitlements: {
    'com.apple.security.application-groups': ['group.com.thallo.app'],
  },
};
