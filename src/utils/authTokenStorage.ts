import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

export const AUTH_TOKEN_KEY = 'auth_token';
const LEGACY_AUTH_TOKEN_KEY = 'authToken';

export async function saveAuthToken(token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(AUTH_TOKEN_KEY, token);
    return;
  } catch {}
  try { await AsyncStorage.setItem(AUTH_TOKEN_KEY, token); } catch {}
}

export async function loadAuthToken(): Promise<string | null> {
  try {
    const secureToken = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
    if (secureToken) return secureToken;
  } catch {}
  try {
    const storedToken = await AsyncStorage.getItem(AUTH_TOKEN_KEY);
    if (storedToken) return storedToken;
  } catch {}
  try {
    return await AsyncStorage.getItem(LEGACY_AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function clearAuthToken(): Promise<void> {
  try { await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY); } catch {}
  try { await AsyncStorage.removeItem(AUTH_TOKEN_KEY); } catch {}
  try { await AsyncStorage.removeItem(LEGACY_AUTH_TOKEN_KEY); } catch {}
}
