/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  // watchOS complication / Smart Stack widget. Surfaces today's
  // workout focus + readiness score on the watch face. Tapping
  // launches the Thallo watch app — which is the secondary win,
  // because watchOS gives the host app a much larger background
  // refresh budget when a complication is on the active face.
  // That budget keeps the Thallo watch app warmer, which closes the
  // "phone-started workout doesn't reach watch" gap noted in CLAUDE.md.
  type: 'widget',
  name: 'ThalloWatchComplication',
  icon: '../../assets/images/thallo-icon.png',
  // watchOS 10 — required for `accessoryCircular` / `accessoryRectangular`
  // accessoryWidgetGroup styles + the Smart Stack auto-surface flow.
  deploymentTarget: '10.0',
  colors: {
    $accent: '#15C7B8',
  },
  entitlements: {
    // No HealthKit / App Groups needed — the complication reads its
    // payload via WCSession's already-paired session (the main watch
    // target shares it) so we don't need to add a SharedDefaults
    // app group here. If we later add cross-target shared state
    // beyond what the watch app already pushes, add an App Group.
  },
};
