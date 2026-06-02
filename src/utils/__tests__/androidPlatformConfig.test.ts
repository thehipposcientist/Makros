import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function readJson(filePath: string): any {
  return JSON.parse(readFileSync(path.join(root, filePath), 'utf8'));
}

describe('Android platform config', () => {
  const appJson = readJson('app.json');
  const androidPermissions: string[] = appJson.expo.android.permissions ?? [];
  const androidManifest = readFileSync(path.join(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8');

  it('declares Android 13+ notification permission for local reminders', () => {
    expect(androidPermissions.includes('android.permission.POST_NOTIFICATIONS')).toBe(true);
    expect(androidManifest.includes('android.permission.POST_NOTIFICATIONS')).toBe(true);
  });

  it('keeps Android Health Connect data permissions out until the feature ships', () => {
    expect(JSON.stringify(androidPermissions).includes('android.permission.health')).toBe(false);
    expect(androidManifest.includes('android.permission.health')).toBe(false);
  });

  it('keeps iOS-only native modules off Android autolinking', () => {
    const moduleConfigs = [
      'modules/thallo-healthkit/expo-module.config.json',
      'modules/thallo-live-activity/expo-module.config.json',
      'modules/thallo-watch-bridge/expo-module.config.json',
    ];

    for (const configPath of moduleConfigs) {
      const config = readJson(configPath);
      expect(config.platforms.includes('ios')).toBe(true);
      expect(config.platforms.includes('android')).toBe(false);
    }
  });
});
