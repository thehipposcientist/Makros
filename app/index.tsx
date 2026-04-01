import React, { useState, useEffect } from 'react';
import { View, Text, Modal, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { UserProfile, WorkoutDay, WorkoutSession } from '../src/types';
import { getMyProfile, getMe, syncOnboarding } from '../src/services/api';
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

    // Restore previous session if token exists
    const token = await AsyncStorage.getItem('authToken');
    if (token) {
      setAuthToken(token);
      await loadProfile(token);
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

  const handleAuthenticated = async (token: string, isNewUser: boolean) => {
    setAuthToken(token);
    if (isNewUser) {
      // Clear any stale profile so onboarding always runs for new accounts
      await AsyncStorage.removeItem('userProfile');
      setUserProfile(null);
    } else {
      await loadProfile(token);
    }
  };

  const handleProfileComplete = async (profile: UserProfile) => {
    const stamped = stampGoalStart(profile, null);
    await AsyncStorage.setItem('userProfile', JSON.stringify(stamped));
    setUserProfile(stamped);
    if (authToken) syncOnboarding(authToken, stamped).catch(() => null);
  };

  const handleSignOut = async () => {
    await AsyncStorage.multiRemove(['authToken', 'userProfile']);
    setAuthToken(null);
    setUserProfile(null);
    setIsEditing(false);
    setShowProgress(false);
    setShowAccount(false);
    setActiveWorkout(null);
  };

  const handleSaveProfile = async (updated: UserProfile) => {
    const stamped = stampGoalStart(updated, userProfile);
    await AsyncStorage.setItem('userProfile', JSON.stringify(stamped));
    setUserProfile(stamped);
    setIsEditing(false);
    if (authToken) syncOnboarding(authToken, stamped).catch(() => null);
  };

  const handleWorkoutFinish = (_session: WorkoutSession) => {
    setActiveWorkout(null);
  };

  if (isLoading) return <View style={{ flex: 1, backgroundColor: '#0D0D0D' }} />;
  if (!authToken) return <AuthScreen onAuthenticated={handleAuthenticated} />;
  if (!userProfile) return <OnboardingScreen onComplete={handleProfileComplete} />;

  if (isEditing) {
    return <EditProfileScreen profile={userProfile} onSave={handleSaveProfile} onCancel={() => setIsEditing(false)} />;
  }

  if (activeWorkout) {
    return (
      <ActiveWorkoutScreen
        workout={activeWorkout}
        goal={userProfile.goal}
        onFinish={handleWorkoutFinish}
        onCancel={() => setActiveWorkout(null)}
      />
    );
  }

  if (showProgress) {
    return <ProgressScreen onBack={() => setShowProgress(false)} />;
  }

  return (
    <>
      <HomeScreen
        userProfile={userProfile}
        onSignOut={handleSignOut}
        onEditProfile={() => setIsEditing(true)}
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
