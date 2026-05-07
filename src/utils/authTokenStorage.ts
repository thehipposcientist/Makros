import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

export const AUTH_TOKEN_KEY = 'auth_token';
const LEGACY_AUTH_TOKEN_KEY = 'authToken';

async function clearPlaintextTokenKeys(): Promise<void> {
  try { await AsyncStorage.removeItem(AUTH_TOKEN_KEY); } catch {}
  try { await AsyncStorage.removeItem(LEGACY_AUTH_TOKEN_KEY); } catch {}
}

export async function saveAuthToken(token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(AUTH_TOKEN_KEY, token);
    await clearPlaintextTokenKeys();
  } catch (error) {
    await clearPlaintextTokenKeys();
    throw error;
  }
}

export async function loadAuthToken(): Promise<string | null> {
  await clearPlaintextTokenKeys();
  try {
    const secureToken = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
    if (secureToken) return secureToken;
  } catch {}
  return null;
}

export async function clearAuthToken(): Promise<void> {
  try { await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY); } catch {}
  await clearPlaintextTokenKeys();
}
