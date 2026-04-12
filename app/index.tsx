import React, { useState, useEffect } from 'react';
import { View, Text, Modal, TouchableOpacity, StyleSheet, ActivityIndicator, Image, Alert, Platform, Switch } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { UserProfile, WorkoutDay, WorkoutSession, UserLogEntry, SupplementItem } from '../src/types';
import { getMyProfile, getMe, syncOnboarding, getAIPlans, getAIWorkoutPlan, getAINutritionPlan, upsertDayState, parseRecentWorkouts, logWorkoutDone } from '../src/services/api';
import AuthScreen from '../src/screens/AuthScreen';
import OnboardingScreen from '../src/screens/OnboardingScreen';
import HomeScreen from '../src/screens/HomeScreen';
import EditProfileScreen from '../src/screens/EditProfileScreen';
import ActiveWorkoutScreen from '../src/screens/ActiveWorkoutScreen';
import ProgressScreen from '../src/screens/ProgressScreen';
import SupplementsScreen from '../src/screens/SupplementsScreen';
import { colors, getTheme, radius } from '../src/constants/theme';
import { recordGoalChange, loadWorkoutHistory, saveWorkoutSession, todayKey, isAppleHealthEnabled, setAppleHealthEnabled } from '../src/utils/workoutHistory';
import { isHealthKitAvailable, requestHealthPermissions } from '../src/services/appleHealth';

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
  const [editMode, setEditMode]           = useState<'goal' | 'workout' | 'mealplan' | 'theme'>('goal');
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

  /** Merge AI-returned custom foods into the user profile's customFoods list */
  const _mergeCustomFoods = async (foods: Array<{ name: string; unit?: string; calories: number; protein: number; carbs: number; fat: number }>) => {
    try {
      const raw = await AsyncStorage.getItem('userProfile');
      if (!raw) return;
      const prof = JSON.parse(raw);
      const existing: Array<{ name: string }> = prof.customFoods ?? [];
      const existingNames = new Set(existing.map(f => f.name.toLowerCase()));
      const newFoods = foods.filter(f => f.calories > 0 && !existingNames.has(f.name.toLowerCase()));
      if (!newFoods.length) return;
      prof.customFoods = [
        ...existing,
        ...newFoods.map(f => ({
          name: f.name,
          unit: f.unit ?? '1 serving',
          calories: Math.round(f.calories),
          protein: Math.round(f.protein),
          carbs: Math.round(f.carbs),
          fat: Math.round(f.fat),
        })),
      ];
      await AsyncStorage.setItem('userProfile', JSON.stringify(prof));
      console.log(`[_mergeCustomFoods] added ${newFoods.length} custom foods`);
    } catch {}
  };

  useEffect(() => { initApp(); }, []);

  const initApp = async () => {
    const CACHE_VERSION = '5';
    const storedVersion = await AsyncStorage.getItem('cacheVersion');
    if (storedVersion !== CACHE_VERSION) {
      await AsyncStorage.multiRemove([
        'userProfile', 'aiWorkoutPlan',
        'aiNutritionPlan', 'aiNutritionPlanA', 'aiNutritionPlanB', 'aiNutritionPlanC',
        'trainerNote', 'nutritionistNote', 'supplementStack',
        'workoutHistory', 'skippedWorkouts',
        'mealChecks', 'mealEdits', 'userLog',
        'weekStartDate', 'metaData_v1',
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
    let profile: UserProfile | null = null;
    const stored = await AsyncStorage.getItem('userProfile');
    if (stored) {
      profile = JSON.parse(stored);
    } else {
      const remote = await getMyProfile(token);
      if (remote) {
        await AsyncStorage.setItem('userProfile', JSON.stringify(remote));
        profile = remote;
      }
    }
    if (!profile) return;
    setUserProfile(profile);

    // If AI plans were wiped (e.g. after sign-out/sign-in), regenerate them
    const hasPlans = await AsyncStorage.getItem('aiWorkoutPlan');
    if (!hasPlans) {
      setIsWorkoutUpdating(true);
      setIsNutritionUpdating(true);
      getAIPlans(token, profile)
        .then(async (aiPlans) => {
          if (aiPlans?.workout_plan) {
            await AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(aiPlans.workout_plan));
            const tnNote = aiPlans.trainerNote ?? aiPlans.workout_plan?.trainerNote;
            if (tnNote) { await AsyncStorage.setItem('trainerNote', tnNote); setTrainerNote(tnNote); }
          }
          if (aiPlans?.nutrition_plan_a) {
            await AsyncStorage.setItem('aiNutritionPlanA', JSON.stringify(aiPlans.nutrition_plan_a));
            await AsyncStorage.setItem('aiNutritionPlan', JSON.stringify(aiPlans.nutrition_plan_a));
          }
          if (aiPlans?.nutrition_plan_b) await AsyncStorage.setItem('aiNutritionPlanB', JSON.stringify(aiPlans.nutrition_plan_b));
          if (aiPlans?.nutrition_plan_c) await AsyncStorage.setItem('aiNutritionPlanC', JSON.stringify(aiPlans.nutrition_plan_c));
          if (aiPlans?.nutritionistNote) { await AsyncStorage.setItem('nutritionistNote', aiPlans.nutritionistNote); setNutritionistNote(aiPlans.nutritionistNote); }
          if (aiPlans?.supplementStack?.length) {
            await AsyncStorage.setItem('supplementStack', JSON.stringify(aiPlans.supplementStack));
            setSupplementStack(aiPlans.supplementStack);
          }
          if (aiPlans?.custom_foods?.length) await _mergeCustomFoods(aiPlans.custom_foods);
          await AsyncStorage.setItem('weekStartDate', new Date().toISOString());
          setPlanRefreshKey(k => k + 1);
        })
        .catch(() => null)
        .finally(() => {
          setIsWorkoutUpdating(false);
          setIsNutritionUpdating(false);
        });
    }
  };

  const handleAuthenticated = async (token: string, isNewUser: boolean) => {
    setAuthToken(token);
    if (isNewUser) {
      // Wipe everything — brand new account should start with zero local state
      await AsyncStorage.multiRemove([
        'userProfile', 'aiWorkoutPlan',
        'aiNutritionPlan', 'aiNutritionPlanA', 'aiNutritionPlanB', 'aiNutritionPlanC',
        'trainerNote', 'nutritionistNote', 'supplementStack',
        'mealEdits', 'mealChecks', 'workoutHistory', 'userLog',
        'skippedWorkouts', 'weekStartDate', 'metaData_v1',
      ]);
      setUserProfile(null);
      setTrainerNote(null);
      setNutritionistNote(null);
      setSupplementStack([]);
    } else {
      await loadProfile(token);
    }
  };

  const handleProfileComplete = async (profile: UserProfile) => {
    const stamped = stampGoalStart(profile, null);
    await AsyncStorage.setItem('userProfile', JSON.stringify(stamped));
    setUserProfile(stamped);   // transition to HomeScreen — loading overlays will show

    if (!authToken) return;
    syncOnboarding(authToken, stamped).catch(() => null);

    // Generate initial plan with both loading states active
    setIsWorkoutUpdating(true);
    setIsNutritionUpdating(true);

    getAIPlans(authToken, stamped, stamped.lastWorkoutContext ? { extraContext: `Recent workout context from user: ${stamped.lastWorkoutContext}` } : undefined)
      .then(async (aiPlans) => {
        if (aiPlans?.workout_plan) {
          await AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(aiPlans.workout_plan));
          const tnNote = aiPlans.trainerNote ?? aiPlans.workout_plan?.trainerNote;
          if (tnNote) { await AsyncStorage.setItem('trainerNote', tnNote); setTrainerNote(tnNote); }
        }
        // Store 3 rotating nutrition templates
        if (aiPlans?.nutrition_plan_a) {
          await AsyncStorage.setItem('aiNutritionPlanA', JSON.stringify(aiPlans.nutrition_plan_a));
          await AsyncStorage.setItem('aiNutritionPlan', JSON.stringify(aiPlans.nutrition_plan_a)); // legacy compat
        }
        if (aiPlans?.nutrition_plan_b) await AsyncStorage.setItem('aiNutritionPlanB', JSON.stringify(aiPlans.nutrition_plan_b));
        if (aiPlans?.nutrition_plan_c) await AsyncStorage.setItem('aiNutritionPlanC', JSON.stringify(aiPlans.nutrition_plan_c));
        if (aiPlans?.nutritionistNote) { await AsyncStorage.setItem('nutritionistNote', aiPlans.nutritionistNote); setNutritionistNote(aiPlans.nutritionistNote); }
        if (aiPlans?.supplementStack?.length) {
          await AsyncStorage.setItem('supplementStack', JSON.stringify(aiPlans.supplementStack));
          setSupplementStack(aiPlans.supplementStack);
        }
        // Save any custom foods the AI used that weren't in the user's food list
        if (aiPlans?.custom_foods?.length) {
          await _mergeCustomFoods(aiPlans.custom_foods);
        }
        // Track when this week's plan started
        await AsyncStorage.setItem('weekStartDate', new Date().toISOString());
        await appendUserLog({ type: 'plan_generated', summary: `Initial plan generated for goal: ${stamped.goal.replace(/_/g, ' ')}` });
        setPlanRefreshKey(k => k + 1);

        // Parse onboarding workout context into logged sessions
        if (stamped.lastWorkoutContext && authToken) {
          try {
            const parsed = await parseRecentWorkouts(authToken, stamped.lastWorkoutContext);
            console.log('[onboarding] parseRecentWorkouts response:', JSON.stringify(parsed));
            for (const s of (parsed.sessions ?? [])) {
              const session: WorkoutSession = {
                id: `onboarding-${s.date}-${Date.now()}`,
                date: new Date(s.date + 'T12:00:00').toISOString(),
                focus: s.focus || 'General',
                durationSeconds: s.durationSeconds || 3600,
                exercises: (s.exercises ?? []).map((ex: any) => ({
                  name: ex.name,
                  targetSets: ex.sets?.length ?? 0,
                  targetReps: '',
                  targetRestSeconds: 60,
                  equipment: '',
                  sets: (ex.sets ?? []).map((set: any) => ({
                    weightLbs: set.weightLbs ?? 0,
                    reps: set.reps ?? 0,
                  })),
                })),
                completed: true,
              };
              await saveWorkoutSession(session);
              // Sync to backend so getWorkoutStatus() sees it
              const sessionDate = s.date || new Date(session.date).toISOString().slice(0, 10);
              await logWorkoutDone(authToken, sessionDate, session.focus, session.durationSeconds).catch(e =>
                console.warn('[onboarding] logWorkoutDone failed for', sessionDate, e),
              );
            }
            if (parsed.sessions?.length) {
              console.log(`[onboarding] logged ${parsed.sessions.length} workout sessions from context`);
              setPlanRefreshKey(k => k + 1); // refresh to show today as done
            }
          } catch (e) {
            console.warn('[onboarding] failed to parse workout context:', e);
          }
        }
      })
      .catch((err) => {
        Alert.alert('Plan generation failed', err?.message ?? 'Could not reach the AI server. Make sure the backend is running and try again.');
      })
      .finally(() => {
        setIsWorkoutUpdating(false);
        setIsNutritionUpdating(false);
      });
  };

  const handleSignOut = async () => {
    await AsyncStorage.multiRemove([
      'authToken', 'userProfile', 'aiWorkoutPlan',
      'aiNutritionPlan', 'aiNutritionPlanA', 'aiNutritionPlanB', 'aiNutritionPlanC',
      'trainerNote', 'nutritionistNote', 'supplementStack', 'metaData_v1',
      'weekStartDate', 'mealEdits', 'mealChecks',
      'workoutHistory', 'userLog', 'skippedWorkouts',
    ]);
    setAuthToken(null);
    setUserProfile(null);
    setIsEditing(false);
    setEditMode('goal');
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
    setEditMode('goal');
    if (authToken) {
      syncOnboarding(authToken, stamped).catch(() => null);

      // Determine what to regenerate based on what was edited
      const regenWorkout  = goalChanged || editMode === 'workout';
      const regenNutrition = goalChanged || editMode === 'mealplan';

      if (regenWorkout || regenNutrition) {
        // Preserve today's logged meals when regenerating nutrition
        if (regenNutrition) {
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

        // Build last 3 workout sessions as context
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

        await AsyncStorage.removeItem('pendingProfileChanges').catch(() => null);

        if (regenWorkout) setIsWorkoutUpdating(true);
        if (regenNutrition) setIsNutritionUpdating(true);

        const opts = { userLog, extraContext };

        // Goal change → regenerate both via single call
        // Workout-only edit → regenerate just workout plan
        // Mealplan-only edit → regenerate just nutrition plan
        const planCall = (regenWorkout && regenNutrition)
          ? getAIPlans(authToken, stamped, opts)
          : regenWorkout
            ? getAIWorkoutPlan(authToken, stamped, opts)
            : getAINutritionPlan(authToken, stamped, opts);

        planCall
          .then(async (aiPlans: any) => {
            // Save workout plan if returned
            if (aiPlans.workout_plan) {
              const tnNote = aiPlans.trainerNote || aiPlans.workout_plan?.trainerNote || null;
              await AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(aiPlans.workout_plan));
              if (tnNote) { await AsyncStorage.setItem('trainerNote', tnNote); setTrainerNote(tnNote); }
            }

            // Save nutrition plans if returned
            if (aiPlans.nutrition_plan_a) {
              const nnNote = aiPlans.nutritionistNote || null;
              await AsyncStorage.setItem('aiNutritionPlanA', JSON.stringify(aiPlans.nutrition_plan_a));
              await AsyncStorage.setItem('aiNutritionPlan', JSON.stringify(aiPlans.nutrition_plan_a));
              if (aiPlans.nutrition_plan_b) await AsyncStorage.setItem('aiNutritionPlanB', JSON.stringify(aiPlans.nutrition_plan_b));
              if (aiPlans.nutrition_plan_c) await AsyncStorage.setItem('aiNutritionPlanC', JSON.stringify(aiPlans.nutrition_plan_c));
              if (nnNote) { await AsyncStorage.setItem('nutritionistNote', nnNote); setNutritionistNote(nnNote); }
              if (aiPlans.supplementStack?.length) {
                await AsyncStorage.setItem('supplementStack', JSON.stringify(aiPlans.supplementStack));
                setSupplementStack(aiPlans.supplementStack);
              }
              // Only reset week timer on goal changes (both plans regenerated), not single-side edits
              if (regenWorkout && regenNutrition) {
                await AsyncStorage.setItem('weekStartDate', new Date().toISOString());
              }
              const todayDate = new Date();
              const tok = authToken;
              for (let i = 0; i < 3; i++) {
                const d = new Date(todayDate);
                d.setDate(todayDate.getDate() + i);
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                upsertDayState(tok, key, { nutrition_plan: aiPlans.nutrition_plan_a }).catch(() => null);
              }
            }

            if (aiPlans.custom_foods?.length) await _mergeCustomFoods(aiPlans.custom_foods);
            const what = (regenWorkout && regenNutrition) ? 'full plan' : regenWorkout ? 'workout plan' : 'nutrition plan';
            await appendUserLog({ type: 'plan_generated', summary: `${what} updated for goal: ${stamped.goal.replace(/_/g, ' ')}` });
            setPlanRefreshKey(k => k + 1);
          })
          .catch((err: any) => {
            console.error('[planCall] failed:', err?.message ?? err);
            Alert.alert('Plan generation failed', err?.message ?? 'Could not reach the AI server. Make sure the backend is running and try again.');
          })
          .finally(() => {
            setIsWorkoutUpdating(false);
            setIsNutritionUpdating(false);
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
    return <EditProfileScreen authToken={authToken} profile={userProfile} mode={editMode} onSave={handleSaveProfile} onCancel={() => { setIsEditing(false); setEditMode('goal'); }} />;
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
        onEditGoal={() => { setEditMode('goal'); setIsEditing(true); }}
        onEditWorkout={() => { setEditMode('workout'); setIsEditing(true); }}
        onEditMealPlan={() => { setEditMode('mealplan'); setIsEditing(true); }}
        onEditThemes={() => { setEditMode('theme'); setIsEditing(true); }}
        onStartWorkout={(workout) => setActiveWorkout(workout)}
        onViewProgress={() => setShowProgress(true)}
        onViewAccount={() => setShowAccount(true)}
        onProfileUpdate={async (changes, skipRegen) => {
          if (!userProfile || !authToken) return;
          const updated = { ...userProfile, ...changes };
          const stamped = changes.goal ? stampGoalStart(updated, userProfile) : updated;
          if (changes.goal) {
            await recordGoalChange(stamped.goal, stamped.goalDetails.pace, stamped.physicalStats.weightLbs);
          }
          await AsyncStorage.setItem('userProfile', JSON.stringify(stamped));
          setUserProfile(stamped);
          syncOnboarding(authToken, stamped).catch(() => null);
          // If the chat already included an updated plan, just refresh without regen
          if (skipRegen) {
            console.log('[onProfileUpdate] profile saved, skipping regen (plan already applied from chat)');
            setPlanRefreshKey(k => k + 1);
            return;
          }
          // Otherwise trigger plan regeneration
          const needsWorkout = !!changes.daysPerWeek || !!changes.workoutDurationMinutes || !!changes.equipment || !!changes.goal;
          const needsNutrition = !!changes.goal;
          if (needsWorkout || needsNutrition) {
            if (needsWorkout) setIsWorkoutUpdating(true);
            if (needsNutrition) setIsNutritionUpdating(true);
            const recentSessions = (await loadWorkoutHistory()).filter(s => !s.skipped && s.completed).slice(0, 3);
            const sessionLines = recentSessions.length
              ? 'Last 3 completed workouts:\n' + recentSessions.map(s => `  [${s.date.slice(0, 10)}] ${s.focus}`).join('\n')
              : '';
            const userLogRaw = await AsyncStorage.getItem('userLog');
            const userLog: import('../src/types').UserLogEntry[] = userLogRaw ? JSON.parse(userLogRaw) : [];
            const opts = { userLog, extraContext: sessionLines || undefined };
            const planCall = (needsWorkout && needsNutrition)
              ? getAIPlans(authToken, stamped, opts)
              : needsWorkout
                ? getAIWorkoutPlan(authToken, stamped, opts)
                : getAINutritionPlan(authToken, stamped, opts);
            planCall.then(async (aiPlans: any) => {
              if (aiPlans.workout_plan) {
                await AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(aiPlans.workout_plan));
                const tnNote = aiPlans.trainerNote || aiPlans.workout_plan?.trainerNote || null;
                if (tnNote) { await AsyncStorage.setItem('trainerNote', tnNote); setTrainerNote(tnNote); }
              }
              if (aiPlans.nutrition_plan_a) {
                await AsyncStorage.setItem('aiNutritionPlanA', JSON.stringify(aiPlans.nutrition_plan_a));
                await AsyncStorage.setItem('aiNutritionPlan', JSON.stringify(aiPlans.nutrition_plan_a));
                if (aiPlans.nutrition_plan_b) await AsyncStorage.setItem('aiNutritionPlanB', JSON.stringify(aiPlans.nutrition_plan_b));
                if (aiPlans.nutrition_plan_c) await AsyncStorage.setItem('aiNutritionPlanC', JSON.stringify(aiPlans.nutrition_plan_c));
                const nnNote = aiPlans.nutritionistNote || null;
                if (nnNote) { await AsyncStorage.setItem('nutritionistNote', nnNote); setNutritionistNote(nnNote); }
              }
              if (aiPlans.custom_foods?.length) await _mergeCustomFoods(aiPlans.custom_foods);
              setPlanRefreshKey(k => k + 1);
            }).catch((err: any) => {
              console.error('[onProfileUpdate] plan regen failed:', err?.message ?? err);
            }).finally(() => {
              setIsWorkoutUpdating(false);
              setIsNutritionUpdating(false);
            });
          } else {
            setPlanRefreshKey(k => k + 1);
          }
        }}
        onWeeklyRefresh={async (review) => {
          if (!authToken || !userProfile) return;
          await appendUserLog({
            type: 'weekly_checkin',
            summary: `Week review: adherence ${review.adherence}/5, energy ${review.energy}/5${review.notes ? `, notes: ${review.notes}` : ''}`,
          });

          // Build workout history context for AI
          const recentSessions = (await loadWorkoutHistory())
            .filter(s => !s.skipped && s.completed)
            .slice(0, 5);
          const sessionLines = recentSessions.length
            ? 'Last 5 completed workouts:\n' +
              recentSessions.map(s => {
                const muscleGroups = (s.exercises ?? []).map(e => e.name).slice(0, 5).join(', ');
                return `  [${s.date.slice(0, 10)}] ${s.focus}${muscleGroups ? `: ${muscleGroups}` : ''}`;
              }).join('\n')
            : '';

          const userLogRaw = await AsyncStorage.getItem('userLog');
          const userLog: UserLogEntry[] = userLogRaw ? JSON.parse(userLogRaw) : [];

          // Clear pending profile changes since they're being sent to AI now
          await AsyncStorage.removeItem('pendingProfileChanges').catch(() => null);

          setIsWorkoutUpdating(true);
          setIsNutritionUpdating(true);

          getAIPlans(authToken, userProfile, {
            userLog,
            extraContext: sessionLines || undefined,
            weeklyReview: review,
          })
            .then(async (aiPlans) => {
              if (aiPlans.workout_plan) {
                const tnNote = aiPlans.trainerNote || aiPlans.workout_plan?.trainerNote || null;
                await AsyncStorage.setItem('aiWorkoutPlan', JSON.stringify(aiPlans.workout_plan));
                if (tnNote) { await AsyncStorage.setItem('trainerNote', tnNote); setTrainerNote(tnNote); }
              }
              if (aiPlans.nutrition_plan_a) {
                const nnNote = aiPlans.nutritionistNote || null;
                await AsyncStorage.setItem('aiNutritionPlanA', JSON.stringify(aiPlans.nutrition_plan_a));
                await AsyncStorage.setItem('aiNutritionPlan', JSON.stringify(aiPlans.nutrition_plan_a));
                if (aiPlans.nutrition_plan_b) await AsyncStorage.setItem('aiNutritionPlanB', JSON.stringify(aiPlans.nutrition_plan_b));
                if (aiPlans.nutrition_plan_c) await AsyncStorage.setItem('aiNutritionPlanC', JSON.stringify(aiPlans.nutrition_plan_c));
                if (nnNote) { await AsyncStorage.setItem('nutritionistNote', nnNote); setNutritionistNote(nnNote); }
                if (aiPlans.supplementStack?.length) {
                  await AsyncStorage.setItem('supplementStack', JSON.stringify(aiPlans.supplementStack));
                  setSupplementStack(aiPlans.supplementStack);
                }
              }
              if (aiPlans.custom_foods?.length) await _mergeCustomFoods(aiPlans.custom_foods);
              await appendUserLog({ type: 'plan_generated', summary: `Weekly review plan refresh — adherence ${review.adherence}/5, energy ${review.energy}/5` });
              setPlanRefreshKey(k => k + 1);
            })
            .catch((err) => {
              console.error('[weeklyRefresh] failed:', err?.message ?? err);
              Alert.alert('Plan refresh failed', 'Could not generate a new plan. Your current plan is unchanged.');
            })
            .finally(() => {
              setIsWorkoutUpdating(false);
              setIsNutritionUpdating(false);
            });
        }}
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
  const [healthEnabled, setHealthEnabled] = useState(false);
  const showHealthToggle = Platform.OS === 'ios';

  useEffect(() => {
    getMe(token)
      .then((data: any) => setAccountData({ email: data.email, username: data.username }))
      .catch(() => setAccountData(null))
      .finally(() => setLoading(false));
    isAppleHealthEnabled().then(setHealthEnabled);
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

          {showHealthToggle && (
            <View style={am.healthToggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={am.healthToggleLabel}>Apple Health</Text>
                <Text style={am.healthToggleDesc}>Sync heart rate, steps, sleep, and workouts to enhance your fitness score and recovery tracking.</Text>
              </View>
              <Switch
                value={healthEnabled}
                onValueChange={async (val) => {
                  if (val) {
                    if (!isHealthKitAvailable()) {
                      // Native module not loaded — need a custom dev build
                      Alert.alert(
                        'Dev Build Required',
                        'Apple Health requires a custom Expo dev build. It is not available in Expo Go. Enable this setting once you have a dev build installed.',
                      );
                      // Still save the preference so it activates once they build
                      setHealthEnabled(true);
                      await setAppleHealthEnabled(true);
                      return;
                    }
                    const granted = await requestHealthPermissions();
                    if (!granted) {
                      Alert.alert('Permission Required', 'Please enable Health access in Settings > Privacy > Health > Makros.');
                      return;
                    }
                  }
                  setHealthEnabled(val);
                  await setAppleHealthEnabled(val);
                }}
                trackColor={{ false: tc.border, true: tc.primary + '66' }}
                thumbColor={healthEnabled ? tc.primary : tc.textMuted}
              />
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

  healthToggleRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: c.surfaceRaised, borderRadius: radius.md,
    padding: 16, borderWidth: 1, borderColor: c.border,
  },
  healthToggleLabel: { fontSize: 14, fontWeight: '700', color: c.textPrimary, marginBottom: 3 },
  healthToggleDesc: { fontSize: 11, color: c.textSecondary, lineHeight: 16 },

  signOutBtn: {
    backgroundColor: c.error + '22', borderRadius: radius.md,
    paddingVertical: 14, alignItems: 'center',
    borderWidth: 1, borderColor: c.error,
  },
  signOutText: { fontSize: 15, fontWeight: '700', color: c.error },

  closeBtn: { alignItems: 'center', paddingVertical: 8 },
  closeText: { fontSize: 15, color: c.textSecondary },
}); }
