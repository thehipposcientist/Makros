const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

function removeToolsReplace(existing, value) {
  return String(existing ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && part !== value)
    .join(',');
}

module.exports = function withAndroidBackupDisabled(config) {
  return withAndroidManifest(config, (config) => {
    const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
    mainApplication.$['android:allowBackup'] = 'false';
    delete mainApplication.$['android:fullBackupContent'];
    delete mainApplication.$['android:dataExtractionRules'];
    const toolsReplace = removeToolsReplace(
      mainApplication.$['tools:replace'],
      'android:allowBackup',
    );
    if (toolsReplace) {
      mainApplication.$['tools:replace'] = toolsReplace;
    } else {
      delete mainApplication.$['tools:replace'];
    }
    return config;
  });
};
