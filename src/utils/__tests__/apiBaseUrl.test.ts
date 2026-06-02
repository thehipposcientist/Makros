import { resolveApiBaseUrl } from '../apiBaseUrl.ts';

describe('api base URL resolution', () => {
  it('uses explicit dev override first', () => {
    expect(resolveApiBaseUrl({
      configured: 'https://prod.example',
      devOverride: 'http://192.168.1.20:8000',
      hostUri: '10.0.0.5:8081',
      isDev: true,
      isDevice: true,
      platform: 'ios',
    })).toBe('http://192.168.1.20:8000');
  });

  it('derives LAN backend from Expo host in normal dev sessions', () => {
    expect(resolveApiBaseUrl({
      hostUri: '10.0.0.5:8081',
      isDev: true,
      isDevice: true,
      platform: 'ios',
    })).toBe('http://10.0.0.5:8000');
  });

  it('falls back to localhost on simulator and web', () => {
    expect(resolveApiBaseUrl({
      hostUri: '',
      isDev: true,
      isDevice: false,
      platform: 'ios',
    })).toBe('http://localhost:8000');
    expect(resolveApiBaseUrl({
      hostUri: '',
      isDev: true,
      isDevice: true,
      platform: 'web',
    })).toBe('http://localhost:8000');
  });

  it('uses Android emulator loopback when no Expo host is available', () => {
    expect(resolveApiBaseUrl({
      hostUri: '',
      isDev: true,
      isDevice: false,
      platform: 'android',
    })).toBe('http://10.0.2.2:8000');
  });

  it('maps Android emulator localhost hosts to the host-machine gateway', () => {
    expect(resolveApiBaseUrl({
      hostUri: 'localhost:8081',
      isDev: true,
      isDevice: false,
      platform: 'android',
    })).toBe('http://10.0.2.2:8000');
    expect(resolveApiBaseUrl({
      hostUri: '127.0.0.1:8081',
      isDev: true,
      isDevice: false,
      platform: 'android',
    })).toBe('http://10.0.2.2:8000');
  });

  it('does not use localhost for Android physical-device dev sessions', () => {
    let message = '';
    try {
      resolveApiBaseUrl({
        hostUri: 'localhost:8081',
        isDev: true,
        isDevice: true,
        platform: 'android',
      });
    } catch (e: any) {
      message = e?.message ?? String(e);
    }
    expect(message).toContain('EXPO_PUBLIC_API_URL');
  });

  it('requires an override for physical device tunnel sessions', () => {
    let message = '';
    try {
      resolveApiBaseUrl({
        hostUri: 'abc.ngrok.io',
        isDev: true,
        isDevice: true,
        platform: 'ios',
      });
    } catch (e: any) {
      message = e?.message ?? String(e);
    }
    expect(message).toContain('EXPO_PUBLIC_API_URL');
  });

  it('requires a real configured production URL', () => {
    let message = '';
    try {
      resolveApiBaseUrl({
        configured: 'https://your-production-api.com',
        isDev: false,
        isDevice: true,
        platform: 'ios',
      });
    } catch (e: any) {
      message = e?.message ?? String(e);
    }
    expect(message).toContain('Production API URL');
    expect(resolveApiBaseUrl({
      configured: 'https://api.thallo.app',
      isDev: false,
      isDevice: true,
      platform: 'ios',
    })).toBe('https://api.thallo.app');
  });
});
