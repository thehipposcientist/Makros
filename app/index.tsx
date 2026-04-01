import React, { useState, useEffect } from 'react';
import { View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { UserProfile } from '../src/types';
import { getMe, syncOnboarding } from '../src/services/api';
import AuthScreen from '../src/screens/AuthScreen';
import OnboardingScreen from '../src/screens/OnboardingScreen';
import HomeScreen from '../src/screens/HomeScreen';

export default function Index() {
  const [isLoading, setIsLoading] = useState(true);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);

  useEffect(() => {
    initApp();
  }, []);

  const initApp = async () => {
    try {
      const token = await AsyncStorage.getItem('authToken');
      if (token) {
        // Verify token is still valid
        await getMe(token);
        setAuthToken(token);

        const stored = await AsyncStorage.getItem('userProfile');
        if (stored) setUserProfile(JSON.parse(stored));
      }
    } catch {
      // Token invalid or expired — clear it and show login
      await AsyncStorage.removeItem('authToken');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAuthenticated = async (token: string) => {
    setAuthToken(token);
    // Check if they already have a profile from a previous session
    const stored = await AsyncStorage.getItem('userProfile');
    if (stored) setUserProfile(JSON.parse(stored));
  };

  const handleProfileComplete = async (profile: UserProfile) => {
    await AsyncStorage.setItem('userProfile', JSON.stringify(profile));
    setUserProfile(profile);
    // Sync to backend (best-effort — don't block the user if it fails)
    if (authToken) {
      syncOnboarding(authToken, profile).catch(() => null);
    }
  };

  if (isLoading) {
    return <View style={{ flex: 1, backgroundColor: '#ffffff' }} />;
  }

  if (!authToken) {
    return <AuthScreen onAuthenticated={handleAuthenticated} />;
  }

  if (!userProfile) {
    return <OnboardingScreen onComplete={handleProfileComplete} />;
  }

  return <HomeScreen userProfile={userProfile} />;
}
