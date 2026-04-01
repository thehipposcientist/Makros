import React, { useState, useEffect } from 'react';
import { View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { UserProfile } from '../src/types';
import { getMe, getMyProfile, syncOnboarding } from '../src/services/api';
import AuthScreen from '../src/screens/AuthScreen';
import OnboardingScreen from '../src/screens/OnboardingScreen';
import HomeScreen from '../src/screens/HomeScreen';
import EditProfileScreen from '../src/screens/EditProfileScreen';

export default function Index() {
  const [isLoading, setIsLoading] = useState(true);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    initApp();
  }, []);

  const initApp = async () => {
    // Always show login on app open — never auto-login from stored token
    setIsLoading(false);
  };

  const loadProfile = async (token: string) => {
    // 1. Try local cache first (instant)
    const stored = await AsyncStorage.getItem('userProfile');
    if (stored) {
      setUserProfile(JSON.parse(stored));
      return;
    }
    // 2. Fall back to backend (user signed out then back in)
    const remote = await getMyProfile(token);
    if (remote) {
      await AsyncStorage.setItem('userProfile', JSON.stringify(remote));
      setUserProfile(remote);
    }
  };

  const handleAuthenticated = async (token: string) => {
    setAuthToken(token);
    await loadProfile(token);
  };

  const handleProfileComplete = async (profile: UserProfile) => {
    await AsyncStorage.setItem('userProfile', JSON.stringify(profile));
    setUserProfile(profile);
    // Sync to backend (best-effort — don't block the user if it fails)
    if (authToken) {
      syncOnboarding(authToken, profile).catch(() => null);
    }
  };

  const handleSignOut = async () => {
    await AsyncStorage.multiRemove(['authToken', 'userProfile']);
    setAuthToken(null);
    setUserProfile(null);
  };

  const handleEditProfile = () => setIsEditing(true);

  const handleSaveProfile = async (updated: UserProfile) => {
    await AsyncStorage.setItem('userProfile', JSON.stringify(updated));
    setUserProfile(updated);
    setIsEditing(false);
    if (authToken) syncOnboarding(authToken, updated).catch(() => null);
  };

  if (isLoading) {
    return <View style={{ flex: 1, backgroundColor: '#0D0D0D' }} />;
  }

  if (!authToken) {
    return <AuthScreen onAuthenticated={handleAuthenticated} />;
  }

  if (!userProfile) {
    return <OnboardingScreen onComplete={handleProfileComplete} />;
  }

  if (isEditing) {
    return <EditProfileScreen profile={userProfile} onSave={handleSaveProfile} onCancel={() => setIsEditing(false)} />;
  }

  return <HomeScreen userProfile={userProfile} onSignOut={handleSignOut} onEditProfile={handleEditProfile} />;
}
