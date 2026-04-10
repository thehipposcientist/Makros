import React, { useState, useEffect } from 'react';
import { View, Text, Modal, TouchableOpacity, StyleSheet, ActivityIndicator, Image, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { UserProfile, WorkoutDay, WorkoutSession, UserLogEntry, SupplementItem } from '../src/types';
import { getMyProfile, getMe, syncOnboarding, getAIPlans, getAIWorkoutPlan, getAINutritionPlan, upsertDayState } from '../src/services/api';
import AuthScreen from '../src/screens/AuthScreen';
import OnboardingScreen from '../src/screens/OnboardingScreen';
import HomeScreen from '../src/screens/HomeScreen';
import EditProfileScreen from '../src/screens/EditProfileScreen';
import ActiveWorkoutScreen from '../src/screens/ActiveWorkoutScreen';
import ProgressScreen from '../src/screens/ProgressScreen';
import SupplementsScreen from '../src/screens/SupplementsScreen';
import { colors, getTheme, radius } from '../src/constants/theme';
import { recordGoalChange, loadWorkoutHistory, todayKey } from '../src/utils/workoutHistory';

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

async function appendUserLog(entry: Omit<UserLogEntry, 'id' | 'date'>) {
  try {
    const raw = await AsyncStorage.getItem('userLog');
    const log: UserLogEntry[] = raw ? JSON.parse(raw) : [];
    const newEntry: UserLogEntry = {
      id: Date.now().toString(),
      date: new Date().toISOString(),
      ...entry,
    };
    // Keep last 50 entries
    const trimmed = [newEntry, ...log].slice(0, 50);
    await AsyncStorage.setItem('userLog', JSON.stringify(trimmed));
  } catch {}
}

export default function Index() {
  const [isLoading, setIsLoading]         = useState(true);
  const [authToken, setAuthToken]         = useState<string | null>(null);
  const [userProfile, setUserProfile]     = useState<UserProfile | null>(null);
  const [isEditing, setIsEditing]         = useState(false);
  const [editMode, setEditMode]           = useState<'plan' | 'equipment' | 'foods' | 'theme'>('plan');
  const [planRefreshKey, setPlanRefreshKey] = useState(0);
  const [isWorkoutUpdating, setIsWorkoutUpdating] = useState(false);
  const [isNutritionUpdating, setIsNutritionUpdating] = useState(false);
  const [showProgress, setShowProgress]   = useState(false);
  const [showAccount, setShowAccount]     = useState(false);
  const [showSupplements, setShowSupplements] = useState(false);
  const [activeWorkout, setActiveWorkout] = useState<WorkoutDay | null>(null);
  const [trainerNote, setTrainerNote]     = useState<string | null>(null);
  const [nutritionistNote, setNutritionistNote] = useState<string | null>(null);
  const [supplementStack, setSupplementStack] = useState<SupplementItem[]>([]);

  useEffect(() => { initApp(); }, []);

  const initApp = async () => {
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
    // Load persisted coach notes
    const [tn, nn, ss] = await Promise.all([
      AsyncStorage.getItem('trainerNote'),
      AsyncStorage.getItem('nutritionistNote'),
      AsyncStorage.getItem('supplementStack'),
    ]);
    if (tn) setTrainerNote(tn);
    if (nn) setNutritionistNote(nn);
    if (ss) { try { setSupplementStack(JSON.parse(ss)); } catch {} }
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
    await AsyncStorage.multiRemove([
      'authToken', 'userProfile', 'aiWorkoutPlan', 'aiNutritionPlan',
      'trainerNote', 'nutritionistNote', 'supplementStack', 'metaData_v1',
    ]);
    setAuthToken(null);
    setUserProfile(null);
    setIsEditing(false);
    setEditMode('plan');
    setShowProgress(false);
    setShowAccount(false);
    setShowSupplements(false);
    setActiveWorkout(null);
    setTrainerNote(null);
    setNutritionistNote(null);
    setSupplementStack([]);
  };

  const handleSaveProfile = async (updated: UserProfile) => {
    const stamped = stampGoalStart(updated, userProfile);
    // Record goal history when goal or pace changes
    const goalChanged = !userProfile || userProfile.goal !== updated.goal || userProfile.goalDetails.pace !== updated.goalDetails.pace;
    if (goalChanged) {
      await recordGoalChange(updated.goal, updated.goalDetails.pace, updated.physicalStats.weightLbs);
    }
    await AsyncStorage.setItem('userProfile', JSON.stringify(stamped));
    setUserProfile(stamped);
    setIsEditing(false);
    setEditMode('plan');
    if (authToken) {
      syncOnboarding(authToken, stamped).catch(() => null);

      const shouldRegen = editMode === 'plan' || editMode === 'foods' || editMode === 'equipment';
      if (shouldRegen) {
        // Preserve today's logged meals — only clear future/past edits
        if (editMode !== 'equipment') {
          const today = todayKey();
          const rawEdits = await AsyncStorage.getItem('mealEdits');
          if (rawEdits) {
            try {
              const allEdits = JSON.parse(rawEdits);
              const todayEdit = allEdits[today];
              if (todayEdit) {
                await AsyncStorage.setItem('mealEdits', JSON.stringify({ [today]: todayEdit }));
              } else {
                await AsyncStorage.removeItem('mealEdits');
              }
            } catch { await AsyncStorage.removeItem('mealEdits'); }
          }
        }

        const userLogRaw = await AsyncStorage.getItem('userLog');
        const userLog: import('../src/types').UserLogEntry[] = userLogRaw ? JSON.parse(userLogRaw) : [];

        // Build last 3 workout sessions as context — AI uses this to assess muscle recovery
        // and avoid scheduling the same muscles back-to-back
        const recentSessions = (await loadWorkoutHistory())
          .filter(s => !s.skipped && s.completed)
          .slice(0, 3);
        const sessionLines = recentSessions.length
          ? 'Last 3 completed workouts (use to assess muscle recovery and schedule accordingly):\n' +
            recentSessions.map(s => {
              const muscleGroups = (s.exercises ?? [])
                .map(e => e.name)
                .slice(0, 5)
                .join(', ');
              return `  [${s.date.slice(0, 10)}] ${s.focus}${muscleGroups ? `: ${muscleGroups}` : ''}`;
            }).join('\n')
          : '';
        const extraContext = sessionLines || undefined;

        const updatesWorkout   = editMode === 'equipment' || editMode === 'plan';
        const updatesNutrition = editMode === 'foods'     || editMode === 'plan';

        if (updatesWorkout)   setIsWorkoutUpdating(true);
        if (updatesNutrition) setIsNutritionUpdating(true);

        const planCall =
          (updatesWorkout && !updatesNutrition) ? getAIWorkoutPlan(authToken, stamped, { userLog, extraContext }) :
          (updatesNutrition && !updatesWorkout)  ? getAINutritionPlan(authToken, stamped, { userLog, extraContext }) :
          getAIPlans(authToken, stamped, { userLog, extraContext });

        planCall
          .then(async (aiPlans) => {

            if (updatesWorkout && aiPlans.workout_plan) {
              const tnNote = aiPlans.trainerNote || aiPlans.workout_plan?.trainerNote || null;
              await AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(aiPlans.workout_plan));
              if (tnNote) { await AsyncStorage.setItem('trainerNote', tnNote); setTrainerNote(tnNote); }
            }

            if (updatesNutrition && aiPlans.nutrition_plan) {
              const nnNote = aiPlans.nutritionistNote || aiPlans.nutrition_plan?.nutritionistNote || null;
              await AsyncStorage.setItem('aiNutritionPlan', JSON.stringify(aiPlans.nutrition_plan));
              if (nnNote) { await AsyncStorage.setItem('nutritionistNote', nnNote); setNutritionistNote(nnNote); }
              if (aiPlans.nutrition_plan?.supplementStack?.length) {
                await AsyncStorage.setItem('supplementStack', JSON.stringify(aiPlans.nutrition_plan.supplementStack));
                setSupplementStack(aiPlans.nutrition_plan.supplementStack);
              }
              const today = new Date();
              const tok = authToken;
              for (let i = 0; i < 3; i++) {
                const d = new Date(today);
                d.setDate(today.getDate() + i);
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                upsertDayState(tok, key, { nutrition_plan: aiPlans.nutrition_plan }).catch(() => null);
              }
            }

            await appendUserLog({ type: 'plan_generated', summary: `Plan updated for goal: ${stamped.goal.replace(/_/g, ' ')}` });
            setPlanRefreshKey(k => k + 1);
          })
          .catch((err) => {
            console.error('[planCall] failed:', err?.message ?? err);
            Alert.alert('Plan generation failed', err?.message ?? 'Could not reach the AI server. Make sure the backend is running and try again.');
          })
          .finally(() => {
            if (updatesWorkout)   setIsWorkoutUpdating(false);
            if (updatesNutrition) setIsNutritionUpdating(false);
          });
      }
    }
  };

  const handleSaveSupplements = async (updated: UserProfile) => {
    await AsyncStorage.setItem('userProfile', JSON.stringify(updated));
    setUserProfile(updated);
    setShowSupplements(false);
    if (authToken) syncOnboarding(authToken, updated).catch(() => null);
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
    await appendUserLog({ type: 'weight_updated', summary: `Weight updated to ${weightLbs} lbs` });
  };

  if (isLoading) return (
    <View style={{ flex: 1, backgroundColor: '#0D0F14', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
      <Image
        source={require('../assets/images/Fitness brand logo with apple symbol darkmode.png')}
        style={{ width: 300, height: 300 * 0.58, marginBottom: 48 }}
        resizeMode="contain"
      />
      <ActivityIndicator color="#15C7B8" size="large" />
      <Text style={{ color: '#15C7B8', fontSize: 13, fontWeight: '600', marginTop: 16, letterSpacing: 0.5 }}>
        Loading your plan…
      </Text>
      <Text style={{ color: '#4A5060', fontSize: 12, marginTop: 6, textAlign: 'center' }}>
        Train smart. Fuel better. Get stronger.
      </Text>
    </View>
  );
  if (!authToken) return <AuthScreen onAuthenticated={handleAuthenticated} />;
  if (!userProfile) return <OnboardingScreen authToken={authToken ?? ''} onComplete={handleProfileComplete} />;

  if (showSupplements) {
    return (
      <SupplementsScreen
        userProfile={userProfile}
        themeName={userProfile.themePreference}
        onSave={handleSaveSupplements}
        onBack={() => setShowSupplements(false)}
      />
    );
  }

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
    return <ProgressScreen authToken={authToken} userProfile={userProfile} themeName={userProfile.themePreference} onBack={() => setShowProgress(false)} onUpdateWeight={handleUpdateWeight} />;
  }

  return (
    <>
      <HomeScreen
        authToken={authToken}
        userProfile={userProfile}
        planRefreshKey={planRefreshKey}
        isWorkoutUpdating={isWorkoutUpdating}
        isNutritionUpdating={isNutritionUpdating}
        trainerNote={trainerNote}
        nutritionistNote={nutritionistNote}
        supplementStack={supplementStack}
        onSignOut={handleSignOut}
        onEditProfile={() => { setEditMode('plan'); setIsEditing(true); }}
        onEditEquipment={() => { setEditMode('equipment'); setIsEditing(true); }}
        onEditFoods={() => { setEditMode('foods'); setIsEditing(true); }}
        onEditSupplements={() => setShowSupplements(true)}
        onAddSupplement={async (name: string) => {
          if (!userProfile) return;
          const current = userProfile.supplementsAvailable ?? [];
          if (current.includes(name)) return;
          const updated = { ...userProfile, supplementsAvailable: [...current, name] };
          await AsyncStorage.setItem('userProfile', JSON.stringify(updated));
          setUserProfile(updated);
          if (authToken) syncOnboarding(authToken, updated).catch(() => null);
        }}
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
  const tc = getTheme(profile.themePreference).colors;
  const am = createAmStyles(tc);
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
            <ActivityIndicator color={tc.primary} style={{ marginVertical: 24 }} />
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

function createAmStyles(c: ReturnType<typeof getTheme>['colors']) { return StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: c.surface,
    borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    padding: 24, paddingBottom: 48,
    borderTopWidth: 1, borderTopColor: c.border,
    gap: 16,
  },
  handle:  { width: 36, height: 4, backgroundColor: c.border, borderRadius: 2, alignSelf: 'center' },
  title:   { fontSize: 20, fontWeight: '700', color: c.textPrimary },

  infoSection: {
    backgroundColor: c.surfaceRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: c.border, overflow: 'hidden',
  },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 13,
    borderBottomWidth: 1, borderBottomColor: c.border,
  },
  rowLabel: { fontSize: 14, color: c.textSecondary, fontWeight: '500' },
  rowValue: { fontSize: 14, color: c.textPrimary,   fontWeight: '600', textTransform: 'capitalize' },

  errorText: { fontSize: 13, color: c.error, padding: 16 },

  signOutBtn: {
    backgroundColor: c.error + '22', borderRadius: radius.md,
    paddingVertical: 14, alignItems: 'center',
    borderWidth: 1, borderColor: c.error,
  },
  signOutText: { fontSize: 15, fontWeight: '700', color: c.error },

  closeBtn: { alignItems: 'center', paddingVertical: 8 },
  closeText: { fontSize: 15, color: c.textSecondary },
}); }
