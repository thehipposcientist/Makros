export interface ApiBaseUrlInput {
  configured?: string | null;
  devOverride?: string | null;
  hostUri?: string | null;
  isDev: boolean;
  isDevice: boolean;
  platform: string;
}

const PLACEHOLDER_API_HOSTS = [
  'your-production-api.com',
  'example.com',
  'localhost',
];

export function isPlaceholderApiUrl(url: string): boolean {
  return PLACEHOLDER_API_HOSTS.some(p => url.includes(p));
}

export function resolveApiBaseUrl(input: ApiBaseUrlInput): string {
  const configured = input.configured?.trim() || '';

  if (!input.isDev) {
    if (!configured || isPlaceholderApiUrl(configured)) {
      throw new Error(
        '[Thallo] Production API URL is missing or set to a placeholder. ' +
        'Set expo.extra.apiBaseUrl in app.json or via EAS build secrets.',
      );
    }
    return configured;
  }

  const devOverride = input.devOverride?.trim() || '';
  if (devOverride.startsWith('http')) return devOverride;

  const hostUri = input.hostUri ?? '';
  const isTunnel = hostUri.includes('ngrok') || hostUri.includes('exp.direct');
  const host = !isTunnel ? hostUri.split(':')[0] : '';
  if (host) return `http://${host}:8000`;

  if (input.platform === 'web' || !input.isDevice) return 'http://localhost:8000';

  throw new Error(
    '[Thallo] Dev API URL is missing for a physical device/tunnel session. ' +
    'Set EXPO_PUBLIC_API_URL to your LAN or remote backend URL.',
  );
}
