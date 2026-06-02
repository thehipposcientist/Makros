import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { STORAGE_KEYS } from './storageKeys.ts';

export const AUTH_TOKEN_KEY = STORAGE_KEYS.auth.token;
const BACKGROUND_AUTH_TOKEN_KEY = STORAGE_KEYS.auth.tokenV2;
const LEGACY_AUTH_TOKEN_KEY = STORAGE_KEYS.auth.legacyToken;

const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

async function clearPlaintextTokenKeys(): Promise<void> {
  if (Platform.OS !== 'web') {
    try { await AsyncStorage.removeItem(BACKGROUND_AUTH_TOKEN_KEY); } catch {}
  }
  try { await AsyncStorage.removeItem(AUTH_TOKEN_KEY); } catch {}
  try { await AsyncStorage.removeItem(LEGACY_AUTH_TOKEN_KEY); } catch {}
}

export async function saveAuthToken(token: string): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.setItem(BACKGROUND_AUTH_TOKEN_KEY, token);
    await clearPlaintextTokenKeys();
    return;
  }

  try {
    await SecureStore.setItemAsync(BACKGROUND_AUTH_TOKEN_KEY, token, SECURE_STORE_OPTIONS);
    try { await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY); } catch {}
    await clearPlaintextTokenKeys();
  } catch (error) {
    await clearPlaintextTokenKeys();
    throw error;
  }
}

export async function loadAuthToken(): Promise<string | null> {
  if (Platform.OS === 'web') {
    const token = await AsyncStorage.getItem(BACKGROUND_AUTH_TOKEN_KEY);
    if (token) return token;

    const legacyToken =
      await AsyncStorage.getItem(AUTH_TOKEN_KEY)
      ?? await AsyncStorage.getItem(LEGACY_AUTH_TOKEN_KEY);
    if (legacyToken) {
      try { await saveAuthToken(legacyToken); } catch {}
      return legacyToken;
    }
    return null;
  }

  await clearPlaintextTokenKeys();
  const backgroundToken = await SecureStore.getItemAsync(BACKGROUND_AUTH_TOKEN_KEY, SECURE_STORE_OPTIONS);
  if (backgroundToken) return backgroundToken;

  const legacySecureToken = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
  if (legacySecureToken) {
    try { await saveAuthToken(legacySecureToken); } catch {}
    return legacySecureToken;
  }
  return null;
}

export async function clearAuthToken(): Promise<void> {
  if (Platform.OS === 'web') {
    try { await AsyncStorage.removeItem(BACKGROUND_AUTH_TOKEN_KEY); } catch {}
  } else {
    try { await SecureStore.deleteItemAsync(BACKGROUND_AUTH_TOKEN_KEY, SECURE_STORE_OPTIONS); } catch {}
    try { await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY); } catch {}
  }
  await clearPlaintextTokenKeys();
}
