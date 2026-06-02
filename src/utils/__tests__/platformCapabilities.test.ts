import {
  healthPlatformCopy,
  supportsAndroidHealthConnect,
  supportsAppleHealth,
  supportsAppleWatchSync,
  supportsIosLiveActivities,
} from '../platformCapabilities.ts';

describe('platform capability matrix', () => {
  it('keeps Android on the manual/Health Connect planned path', () => {
    const copy = healthPlatformCopy('android');
    expect(copy.platformLabel).toBe('Health Connect');
    expect(copy.deviceLabel).toBe('Android');
    expect(copy.wearableLabel).toBe('wearable');
    expect(copy.statusCopy).toContain('coming soon');
    expect(supportsAppleHealth('android', true)).toBe(false);
    expect(supportsAppleWatchSync('android')).toBe(false);
    expect(supportsIosLiveActivities('android')).toBe(false);
    expect(supportsAndroidHealthConnect('android')).toBe(false);
  });

  it('keeps iOS on Apple Health, Apple Watch, and Live Activity paths', () => {
    const copy = healthPlatformCopy('ios');
    expect(copy.platformLabel).toBe('Apple Health');
    expect(copy.deviceLabel).toBe('iPhone');
    expect(copy.wearableLabel).toBe('Apple Watch');
    expect(supportsAppleHealth('ios', true)).toBe(true);
    expect(supportsAppleHealth('ios', false)).toBe(false);
    expect(supportsAppleWatchSync('ios')).toBe(true);
    expect(supportsIosLiveActivities('ios')).toBe(true);
    expect(supportsAndroidHealthConnect('ios')).toBe(false);
  });
});
