import React, { useState, useEffect } from 'react';
import { View, Text, Modal, TouchableOpacity, StyleSheet, ActivityIndicator, Image } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { UserProfile, WorkoutDay, WorkoutSession } from '../src/types';
import { getMyProfile, getMe, syncOnboarding, getAIPlans, upsertDayState } from '../src/services/api';
import AuthScreen from '../src/screens/AuthScreen';
import OnboardingScreen from '../src/screens/OnboardingScreen';
import HomeScreen from '../src/screens/HomeScreen';
import EditProfileScreen from '../src/screens/EditProfileScreen';
import ActiveWorkoutScreen from '../src/screens/ActiveWorkoutScreen';
import ProgressScreen from '../src/screens/ProgressScreen';
import { colors, radius } from '../src/constants/theme';

/** Stamp startWeightLbs + goalStartedAt when a goal is first set or changes. */
function stampGoalStart(profile: UserProfile, previous: UserProfile | null): UserProfile {
  const goalChanged = !previous || previous.goal !== profile.goal;
  if (goalChanged || !profile.goalDetails.goalStartedAt) {
    return {
      ...profile,
      goalDetails: {
        ...profile.goalDetails,
        startWeightLbs: profile.physicalStats.weightLbs,
        goalStartedAt: new Date().toISOString(),
      },
    };
  }
  return profile;
}

export default function Index() {
  const [isLoading, setIsLoading]         = useState(true);
  const [authToken, setAuthToken]         = useState<string | null>(null);
  const [userProfile, setUserProfile]     = useState<UserProfile | null>(null);
  const [isEditing, setIsEditing]         = useState(false);
  const [editMode, setEditMode]           = useState<'plan' | 'equipment' | 'foods' | 'theme'>('plan');
  const [planRefreshKey, setPlanRefreshKey] = useState(0);
  const [isPlanUpdating, setIsPlanUpdating] = useState(false);
  const [showProgress, setShowProgress]   = useState(false);
  const [showAccount, setShowAccount]     = useState(false);
  const [activeWorkout, setActiveWorkout] = useState<WorkoutDay | null>(null);

  useEffect(() => { initApp(); }, []);

  const initApp = async () => {
    // Clear stale local caches that should come from the backend
    const CACHE_VERSION = '3';
    const storedVersion = await AsyncStorage.getItem('cacheVersion');
    if (storedVersion !== CACHE_VERSION) {
      await AsyncStorage.multiRemove([
        'workoutHistory', 'skippedWorkouts',
        'mealChecks', 'mealEdits',
        'metaData_v1',
      ]);
      await AsyncStorage.setItem('cacheVersion', CACHE_VERSION);
    }

    // Biometric auto-login: SecureStore is the single source of truth.
    // If a token is stored there, the user opted in — prompt Face ID.
    try {
      const savedToken = await SecureStore.getItemAsync('authToken');
      if (savedToken) {
        const hasHardware = await LocalAuthentication.hasHardwareAsync();
        const isEnrolled  = await LocalAuthentication.isEnrolledAsync();
        if (hasHardware && isEnrolled) {
          const result = await LocalAuthentication.authenticateAsync({
            promptMessage: 'Log in to Makros',
            cancelLabel: 'Use Password Instead',
            disableDeviceFallback: true,
          });
          if (result.success) {
            setAuthToken(savedToken);
            await loadProfile(savedToken);
            setIsLoading(false);
            return;
          }
          // Face ID cancelled or failed — fall through to login screen
        }
      }
    } catch {
      // SecureStore or biometric unavailable — fall through to manual login
    }

    setIsLoading(false);
  };

  const loadProfile = async (token: string) => {
    const stored = await AsyncStorage.getItem('userProfile');
    if (stored) {
      setUserProfile(JSON.parse(stored));
      return;
    }
    const remote = await getMyProfile(token);
    if (remote) {
      await AsyncStorage.setItem('userProfile', JSON.stringify(remote));
      setUserProfile(remote);
    }
  };

  const handleAuthenticated = async (token: string, isNewUser: boolean, offerBiometric?: boolean) => {
    setAuthToken(token);
    if (isNewUser) {
      await AsyncStorage.removeItem('userProfile');
      setUserProfile(null);
    } else {
      await loadProfile(token);
    }

    if (offerBiometric) {
      // Store token in hardware-backed SecureStore — this IS the biometric-enabled flag.
      // Presence of the token in SecureStore = biometric login is active.
      try {
        await SecureStore.setItemAsync('authToken', token);
      } catch {
        // SecureStore unavailable on this device — silently skip
      }
    }
  };

  const handleProfileComplete = async (profile: UserProfile) => {
    const stamped = stampGoalStart(profile, null);
    await AsyncStorage.setItem('userProfile', JSON.stringify(stamped));
    setUserProfile(stamped);
    if (authToken) syncOnboarding(authToken, stamped).catch(() => null);
  };

  const handleSignOut = async () => {
    await AsyncStorage.multiRemove(['authToken', 'userProfile', 'aiWorkoutPlan', 'aiNutritionPlan', 'metaData_v1']);
    try { await SecureStore.deleteItemAsync('authToken'); } catch {};
    setAuthToken(null);
    setUserProfile(null);
    setIsEditing(false);
    setEditMode('plan');
    setShowProgress(false);
    setShowAccount(false);
    setActiveWorkout(null);
  };

  const handleSaveProfile = async (updated: UserProfile) => {
    const stamped = stampGoalStart(updated, userProfile);
    await AsyncStorage.setItem('userProfile', JSON.stringify(stamped));
    setUserProfile(stamped);
    setIsEditing(false);
    setEditMode('plan');
    if (authToken) {
      syncOnboarding(authToken, stamped).catch(() => null);

      const shouldRegen = editMode === 'plan' || editMode === 'foods' || editMode === 'equipment';
      if (shouldRegen) {
        if (editMode !== 'equipment') await AsyncStorage.removeItem('mealEdits');
        setIsPlanUpdating(true);
        getAIPlans(authToken, stamped)
          .then(async (aiPlans) => {
            const updateWorkout  = editMode === 'plan' || editMode === 'equipment';
            const updateNutrition = editMode === 'plan' || editMode === 'foods';

            if (updateWorkout) {
              await AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(aiPlans.workout_plan));
            }
            if (updateNutrition) {
              await AsyncStorage.setItem('aiNutritionPlan', JSON.stringify(aiPlans.nutrition_plan));
              const today = new Date();
              const token = authToken;
              for (let i = 0; i < 3; i++) {
                const d = new Date(today);
                d.setDate(today.getDate() + i);
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                upsertDayState(token, key, { nutrition_plan: aiPlans.nutrition_plan }).catch(() => null);
              }
            }
            setPlanRefreshKey(k => k + 1);
          })
          .catch(() => null)
          .finally(() => setIsPlanUpdating(false));
      }
    }
  };

  const handleWorkoutFinish = (_session: WorkoutSession) => {
    setActiveWorkout(null);
  };

  const handleUpdateWeight = async (weightLbs: number) => {
    if (!userProfile) return;
    const updated: UserProfile = {
      ...userProfile,
      physicalStats: { ...userProfile.physicalStats, weightLbs },
    };
    await AsyncStorage.setItem('userProfile', JSON.stringify(updated));
    setUserProfile(updated);
    if (authToken) syncOnboarding(authToken, updated).catch(() => null);
  };

  if (isLoading) return (
    <View style={{ flex: 1, backgroundColor: '#0D0F14', alignItems: 'center', justifyContent: 'center' }}>
      <Image
        source={require('../assets/images/Apple dumbbell logo with _MAKROS_ text.png')}
        style={{ width: 260, height: 104 }}
        resizeMode="contain"
      />
      <ActivityIndicator color="#15C7B8" style={{ marginTop: 32 }} />
    </View>
  );
  if (!authToken) return <AuthScreen onAuthenticated={handleAuthenticated} />;
  if (!userProfile) return <OnboardingScreen authToken={authToken ?? ''} onComplete={handleProfileComplete} />;

  if (isEditing) {
    return <EditProfileScreen authToken={authToken} profile={userProfile} mode={editMode} onSave={handleSaveProfile} onCancel={() => { setIsEditing(false); setEditMode('plan'); }} />;
  }

  if (activeWorkout) {
    return (
      <ActiveWorkoutScreen
        authToken={authToken}
        workout={activeWorkout}
        goal={userProfile.goal}
        themeName={userProfile.themePreference}
        weightLbs={userProfile.physicalStats.weightLbs}
        onFinish={handleWorkoutFinish}
        onCancel={() => setActiveWorkout(null)}
      />
    );
  }

  if (showProgress) {
    return <ProgressScreen authToken={authToken} userProfile={userProfile} onBack={() => setShowProgress(false)} onUpdateWeight={handleUpdateWeight} />;
  }

  return (
    <>
      <HomeScreen
        authToken={authToken}
        userProfile={userProfile}
        planRefreshKey={planRefreshKey}
        isPlanUpdating={isPlanUpdating}
        onSignOut={handleSignOut}
        onEditProfile={() => { setEditMode('plan'); setIsEditing(true); }}
        onEditEquipment={() => { setEditMode('equipment'); setIsEditing(true); }}
        onEditFoods={() => { setEditMode('foods'); setIsEditing(true); }}
        onEditThemes={() => { setEditMode('theme'); setIsEditing(true); }}
        onStartWorkout={(workout) => setActiveWorkout(workout)}
        onViewProgress={() => setShowProgress(true)}
        onViewAccount={() => setShowAccount(true)}
      />
      {showAccount && authToken && (
        <AccountInfoModal
          token={authToken}
          profile={userProfile}
          onClose={() => setShowAccount(false)}
          onSignOut={handleSignOut}
        />
      )}
    </>
  );
}

// ── Account Info Modal ────────────────────────────────────────────────────────

function AccountInfoModal({
  token, profile, onClose, onSignOut,
}: {
  token: string;
  profile: UserProfile;
  onClose: () => void;
  onSignOut: () => void;
}) {
  const [accountData, setAccountData] = useState<{ email: string; username: string } | null>(null);
  const [loading, setLoading]         = useState(true);

  useEffect(() => {
    getMe(token)
      .then((data: any) => setAccountData({ email: data.email, username: data.username }))
      .catch(() => setAccountData(null))
      .finally(() => setLoading(false));
  }, [token]);

  const Row = ({ label, value }: { label: string; value: string }) => (
    <View style={am.row}>
      <Text style={am.rowLabel}>{label}</Text>
      <Text style={am.rowValue}>{value}</Text>
    </View>
  );

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <TouchableOpacity style={am.backdrop} activeOpacity={1} onPress={onClose}>
        <View style={am.sheet}>
          <View style={am.handle} />
          <Text style={am.title}>Account</Text>

          {loading ? (
            <ActivityIndicator color={colors.primary} style={{ marginVertical: 24 }} />
          ) : (
            <View style={am.infoSection}>
              {accountData ? (
                <>
                  <Row label="Email"    value={accountData.email} />
                  <Row label="Username" value={accountData.username} />
                </>
              ) : (
                <Text style={am.errorText}>Could not load account info</Text>
              )}
              <Row label="Goal"   value={profile.goal.replace(/_/g, ' ')} />
              <Row label="Weight" value={`${profile.physicalStats.weightLbs} lbs`} />
              <Row label="Age"    value={String(profile.physicalStats.age)} />
            </View>
          )}

          <TouchableOpacity
            style={am.signOutBtn}
            onPress={() => { onClose(); onSignOut(); }}>
            <Text style={am.signOutText}>Sign Out</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={onClose} style={am.closeBtn}>
            <Text style={am.closeText}>Close</Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const am = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    padding: 24, paddingBottom: 48,
    borderTopWidth: 1, borderTopColor: colors.border,
    gap: 16,
  },
  handle:  { width: 36, height: 4, backgroundColor: colors.border, borderRadius: 2, alignSelf: 'center' },
  title:   { fontSize: 20, fontWeight: '700', color: colors.textPrimary },

  infoSection: {
    backgroundColor: colors.surfaceRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
  },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 13,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  rowLabel: { fontSize: 14, color: colors.textSecondary, fontWeight: '500' },
  rowValue: { fontSize: 14, color: colors.textPrimary,   fontWeight: '600', textTransform: 'capitalize' },

  errorText: { fontSize: 13, color: colors.error, padding: 16 },

  signOutBtn: {
    backgroundColor: colors.error + '22', borderRadius: radius.md,
    paddingVertical: 14, alignItems: 'center',
    borderWidth: 1, borderColor: colors.error,
  },
  signOutText: { fontSize: 15, fontWeight: '700', color: colors.error },

  closeBtn: { alignItems: 'center', paddingVertical: 8 },
  closeText: { fontSize: 15, color: colors.textSecondary },
});
