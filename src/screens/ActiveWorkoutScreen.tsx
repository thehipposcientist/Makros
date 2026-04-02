import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  TextInput, Modal, ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Vibration,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as FileSystem from 'expo-file-system';
import { WorkoutDay, WorkoutSession, SessionExercise, CompletedSet } from '../types';
import { saveWorkoutSession, getLastSetsForExercise, dateKey } from '../utils/workoutHistory';
import { getWeightRecommendation, logWorkoutDone, askWorkoutQuestion, analyzeWorkoutFormPhoto, getExercises } from '../services/api';
import { colors, radius } from '../constants/theme';
import { cancelRestNotifications, scheduleRestNotifications } from '../utils/restNotifications';

interface WorkoutCoachMessage {
  role: 'user' | 'assistant';
  content: string;
}

type SetFeedback = 'easy' | 'good' | 'grind' | 'pain';

const FEEDBACK_OPTIONS: Array<{ value: SetFeedback; label: string }> = [
  { value: 'easy', label: 'Easy' },
  { value: 'good', label: 'Good' },
  { value: 'grind', label: 'Grind' },
  { value: 'pain', label: 'Pain' },
];

const COACH_PROMPT_OPTIONS: Array<{ label: string; template: (exerciseName: string) => string }> = [
  { label: 'Form question', template: (name) => `Form check on ${name}: what 2-3 cues should I focus on next set?` },
  { label: 'Injury/pain', template: (name) => `I feel pain/discomfort during ${name}. What should I adjust right now?` },
  { label: 'Not feeling target', template: (name) => `I am not feeling ${name} in the target muscle. How should I fix setup and execution?` },
  { label: 'Lacking intensity', template: (name) => `This ${name} set feels too easy. Should I adjust reps, tempo, rest, or load?` },
];

interface ExerciseLibraryItem {
  id?: number;
  name: string;
  equipment?: string;
  primary_muscle?: string;
}

interface ActiveWorkoutScreenProps {
  authToken: string;
  workout: WorkoutDay;
  goal: string;
  onFinish: (session: WorkoutSession) => void;
  onCancel: () => void;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export default function ActiveWorkoutScreen({ authToken, workout, goal, onFinish, onCancel }: ActiveWorkoutScreenProps) {
  const startTime = useRef(Date.now());
  const restNotificationIds = useRef<{ startId?: string; warningId?: string; completeId?: string } | null>(null);
  const restDurationSeconds = useRef<number>(0);
  const [elapsed, setElapsed] = useState(0);

  const [exercises, setExercises] = useState<SessionExercise[]>(() =>
    workout.exercises.map(ex => ({
      name: ex.name,
      targetSets: ex.sets,
      targetReps: ex.reps,
      targetRestSeconds: ex.restSeconds,
      equipment: typeof ex.equipment === 'string' ? ex.equipment : String(ex.equipment),
      sets: [],
      aiRecommendation: undefined,
    }))
  );

  const [activeExIdx, setActiveExIdx] = useState<number>(0);

  // Log-set modal
  const [logModalVisible, setLogModalVisible] = useState(false);
  const [logExIdx, setLogExIdx] = useState<number>(0);
  const [logWeight, setLogWeight] = useState('');
  const [logReps, setLogReps] = useState('');

  // Auto rest timer between sets
  const [restRemaining, setRestRemaining] = useState(0);
  const [restForExercise, setRestForExercise] = useState<string | null>(null);
  const [restCue, setRestCue] = useState<string | null>(null);
  const [restNextTarget, setRestNextTarget] = useState<string | null>(null);

  // Per-exercise AI state
  const [aiLoadingIdx, setAiLoadingIdx] = useState<number | null>(null);
  const [aiErrorIdx, setAiErrorIdx]     = useState<number | null>(null);

  const [finishModalVisible, setFinishModalVisible] = useState(false);
  const [coachModalVisible, setCoachModalVisible] = useState(false);
  const [coachInput, setCoachInput] = useState('');
  const [coachLoading, setCoachLoading] = useState(false);
  const [coachPhotoLoading, setCoachPhotoLoading] = useState(false);
  const [coachChat, setCoachChat] = useState<WorkoutCoachMessage[]>([]);
  const [addExerciseModalVisible, setAddExerciseModalVisible] = useState(false);
  const [exerciseSearch, setExerciseSearch] = useState('');
  const [exerciseLibraryLoading, setExerciseLibraryLoading] = useState(false);
  const [exerciseLibrary, setExerciseLibrary] = useState<ExerciseLibraryItem[]>([]);

  // Timer
  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (restRemaining <= 0) return;
    const interval = setInterval(() => {
      setRestRemaining(prev => {
        if (prev <= 1) {
          clearInterval(interval);
          Vibration.vibrate([0, 250, 120, 250]);
          cancelRestNotifications(restNotificationIds.current).catch(() => undefined);
          restNotificationIds.current = null;
          Alert.alert('Rest Complete', `${restForExercise ?? 'Current exercise'} — ready for the next set.`);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [restRemaining, restForExercise]);

  useEffect(() => {
    return () => {
      cancelRestNotifications(restNotificationIds.current).catch(() => undefined);
    };
  }, []);

  // Pre-fill from history when modal opens
  const openLogModal = useCallback(async (exIdx: number) => {
    setLogExIdx(exIdx);
    setLogWeight('');
    setLogReps('');
    setLogModalVisible(true);

    const lastSets = await getLastSetsForExercise(exercises[exIdx].name);
    if (lastSets && lastSets.length > 0) {
      const last = lastSets[lastSets.length - 1];
      setLogWeight(String(last.weightLbs));
      setLogReps(String(last.reps));
    }
  }, [exercises]);

  const adjustRestSeconds = useCallback((exIdx: number, delta: number) => {
    setExercises(prev => prev.map((ex, i) => {
      if (i !== exIdx) return ex;
      const next = Math.max(15, Math.min(300, (ex.targetRestSeconds || 60) + delta));
      return { ...ex, targetRestSeconds: next };
    }));
  }, []);

  const openAddExerciseModal = useCallback(async () => {
    setAddExerciseModalVisible(true);
    if (exerciseLibrary.length > 0) return;
    setExerciseLibraryLoading(true);
    try {
      const rows = await getExercises();
      setExerciseLibrary(rows);
    } catch {
      setExerciseLibrary([]);
    } finally {
      setExerciseLibraryLoading(false);
    }
  }, [exerciseLibrary.length]);

  const handleAddExercise = useCallback((item: ExerciseLibraryItem) => {
    const nextExercise: SessionExercise = {
      name: item.name,
      targetSets: 3,
      targetReps: '10',
      targetRestSeconds: 60,
      equipment: item.equipment ? String(item.equipment) : 'bodyweight',
      sets: [],
      aiRecommendation: undefined,
    };
    setExercises(prev => {
      const updated = [...prev, nextExercise];
      setActiveExIdx(updated.length - 1);
      return updated;
    });
    setAddExerciseModalVisible(false);
    setExerciseSearch('');
  }, []);

  const clearRestState = useCallback(() => {
    setRestRemaining(0);
    setRestForExercise(null);
    setRestCue(null);
    setRestNextTarget(null);
    restDurationSeconds.current = 0;
    cancelRestNotifications(restNotificationIds.current).catch(() => undefined);
    restNotificationIds.current = null;
  }, []);

  const rescheduleRestNotifications = useCallback(async (params: {
    seconds: number;
    exerciseName: string;
    nextSetLabel: string;
    aiCue?: string | null;
    includeStartAlert?: boolean;
  }) => {
    cancelRestNotifications(restNotificationIds.current).catch(() => undefined);
    restNotificationIds.current = await scheduleRestNotifications(params);
  }, []);

  const handleRemoveExercise = useCallback((exIdx: number) => {
    if (exercises.length <= 1) {
      Alert.alert('Cannot remove', 'You need at least one exercise in the workout.');
      return;
    }
    const exName = exercises[exIdx]?.name ?? 'this exercise';
    Alert.alert('Remove exercise', `Remove ${exName} from this workout?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          setExercises(prev => prev.filter((_, idx) => idx !== exIdx));
          setActiveExIdx(prev => Math.max(0, prev > exIdx ? prev - 1 : Math.min(prev, exercises.length - 2)));
          if (restForExercise === exName) clearRestState();
        },
      },
    ]);
  }, [clearRestState, exercises, restForExercise]);

  const handleLogSet = async () => {
    console.log('[LOG_SET] handleLogSet called with weight:', logWeight, 'reps:', logReps, 'exercise index:', logExIdx);
    const weightNum = parseFloat(logWeight);
    const repsNum   = parseInt(logReps, 10);
    if (!logWeight || !logReps || isNaN(weightNum) || isNaN(repsNum) || repsNum <= 0) {
      console.warn('[LOG_SET] Invalid input validation failed');
      Alert.alert('Invalid Input', 'Please enter valid weight and reps.');
      return;
    }

    // Capture synchronously before any state updates
    const exIdx = logExIdx;
    const ex    = exercises[exIdx];
    console.log('[LOG_SET] Processing set for exercise:', ex.name, 'current sets:', ex.sets.length, 'target sets:', ex.targetSets);

    const newSet: CompletedSet = { setNumber: ex.sets.length + 1, reps: repsNum, weightLbs: weightNum };
    const updatedSets = [...ex.sets, newSet];
    console.log('[LOG_SET] Created new set:', newSet, 'updated sets count:', updatedSets.length);

    setExercises(prev => prev.map((e, i) => i === exIdx ? { ...e, sets: updatedSets } : e));
    console.log('[LOG_SET] Updated exercises state with new set');
    setLogModalVisible(false);
    console.log('[LOG_SET] Closed log modal');
    setActiveExIdx(exIdx);  // keep card expanded so tip appears
    console.log('[LOG_SET] Set active exercise index to:', exIdx);
    setAiErrorIdx(null);
    console.log('[LOG_SET] Cleared AI error index');

    // Start rest timer automatically if more sets remain for this exercise.
    if (updatedSets.length < ex.targetSets) {
      const restSeconds = Math.max(15, ex.targetRestSeconds || 60);
      const nextSetLabel = `Set ${updatedSets.length + 1}: ${weightNum} lbs x ${ex.targetReps}`;
      restDurationSeconds.current = restSeconds;
      setRestForExercise(ex.name);
      setRestRemaining(restSeconds);
      setRestNextTarget(nextSetLabel);
      setRestCue(null);
      await rescheduleRestNotifications({
        seconds: restSeconds,
        exerciseName: ex.name,
        nextSetLabel,
        aiCue: null,
        includeStartAlert: true,
      });
    } else {
      clearRestState();
    }

    // Fetch AI tip for the next set
    const setsLogged = updatedSets.length;
    if (setsLogged < ex.targetSets) {
      console.log('[AI] Starting AI recommendation fetch for exercise:', ex.name, 'set:', setsLogged + 1);
      setAiLoadingIdx(exIdx);
      try {
        console.log('[AI] Retrieved auth token:', authToken ? 'present' : 'missing');
        if (!authToken) {
          console.warn('[AI] No auth token found, throwing error');
          throw new Error('Not authenticated');
        }
        console.log('[AI] Calling getWeightRecommendation API...');
        const rec = await getWeightRecommendation(authToken, ex.name, goal, updatedSets, setsLogged + 1);
        console.log('[AI] API call successful, received recommendation:', rec);
        const tip = `Set ${setsLogged + 1}: try ${rec.weightLbs} lbs x ${rec.reps} reps — ${rec.tip}`;
        console.log('[AI] Formatted tip text:', tip);
        setRestNextTarget(`Set ${setsLogged + 1}: ${rec.weightLbs} lbs x ${rec.reps}`);
        setRestCue(rec.tip);
        setExercises(prev => {
          const newExercises = prev.map((e, i) => i === exIdx ? { ...e, aiRecommendation: tip } : e);
          console.log('[AI] Updated exercises state, recommendation set for exercise index:', exIdx);
          return newExercises;
        });
        if (updatedSets.length < ex.targetSets) {
          await rescheduleRestNotifications({
            seconds: restRemaining > 0 ? restRemaining : restDurationSeconds.current,
            exerciseName: ex.name,
            nextSetLabel: `Set ${setsLogged + 1}: ${rec.weightLbs} lbs x ${rec.reps}`,
            aiCue: rec.tip,
            includeStartAlert: false,
          });
        }
      } catch (error: any) {
        console.error('[AI] Failed to get recommendation - full error:', error);
        console.error('[AI] Error message:', error?.message);
        console.error('[AI] Error stack:', error?.stack);
        setAiErrorIdx(exIdx);
      } finally {
        console.log('[AI] Setting aiLoadingIdx to null');
        setAiLoadingIdx(null);
      }
    } else {
      console.log('[AI] Skipping recommendation - all sets completed for this exercise');
    }
  };

  const adjustActiveRestRemaining = useCallback(async (delta: number) => {
    if (restRemaining <= 0 || !restForExercise) return;
    const nextRemaining = Math.max(0, restRemaining + delta);
    if (nextRemaining <= 0) {
      clearRestState();
      return;
    }
    setRestRemaining(nextRemaining);
    await rescheduleRestNotifications({
      seconds: nextRemaining,
      exerciseName: restForExercise,
      nextSetLabel: restNextTarget ?? 'Next set is coming up',
      aiCue: restCue,
      includeStartAlert: false,
    });
  }, [clearRestState, rescheduleRestNotifications, restCue, restForExercise, restNextTarget, restRemaining]);

  const refreshRecommendationForExercise = useCallback(async (exIdx: number, setsForExercise: CompletedSet[]) => {
    const ex = exercises[exIdx];
    if (!ex || setsForExercise.length >= ex.targetSets || !authToken) return;

    setAiLoadingIdx(exIdx);
    try {
      const rec = await getWeightRecommendation(authToken, ex.name, goal, setsForExercise, setsForExercise.length + 1);
      const tip = `Set ${setsForExercise.length + 1}: try ${rec.weightLbs} lbs x ${rec.reps} reps — ${rec.tip}`;
      setRestNextTarget(`Set ${setsForExercise.length + 1}: ${rec.weightLbs} lbs x ${rec.reps}`);
      setRestCue(rec.tip);
      setExercises(prev => prev.map((item, i) => i === exIdx ? { ...item, aiRecommendation: tip } : item));

      if (restRemaining > 0 && restForExercise === ex.name) {
        await rescheduleRestNotifications({
          seconds: restRemaining,
          exerciseName: ex.name,
          nextSetLabel: `Set ${setsForExercise.length + 1}: ${rec.weightLbs} lbs x ${rec.reps}`,
          aiCue: rec.tip,
          includeStartAlert: false,
        });
      }
    } catch {
      setAiErrorIdx(exIdx);
    } finally {
      setAiLoadingIdx(null);
    }
  }, [authToken, exercises, goal, rescheduleRestNotifications, restForExercise, restRemaining]);

  const handleSetFeedback = useCallback(async (exIdx: number, feedback: SetFeedback) => {
    let nextSets: CompletedSet[] = [];
    setExercises(prev => prev.map((item, i) => {
      if (i !== exIdx || item.sets.length === 0) return item;
      nextSets = item.sets.map((set, setIdx) => (
        setIdx === item.sets.length - 1 ? { ...set, feedback } : set
      ));
      return { ...item, sets: nextSets };
    }));

    if (feedback === 'pain') {
      setRestCue('Pain flagged. Reduce load, shorten range if needed, and ask coach if it feels sharp or unstable.');
      setCoachModalVisible(true);
      setCoachChat(prev => prev.length > 0 ? prev : [{ role: 'assistant', content: 'Pain flagged on the last set. Tell me where you feel it and what exercise you are doing, and I will help you adjust.' }]);
    }

    if (nextSets.length > 0) {
      await refreshRecommendationForExercise(exIdx, nextSets);
    }
  }, [refreshRecommendationForExercise]);

  const handleFinish = async () => {
    const now = new Date();
    const session: WorkoutSession = {
      id: `${Date.now()}`,
      date: now.toISOString(),
      focus: workout.focus,
      durationSeconds: elapsed,
      exercises,
      completed: true,
    };
    await saveWorkoutSession(session);
    clearRestState();
    // Also persist completion to backend DB so it survives cache clears
    try {
      if (authToken) {
        await logWorkoutDone(authToken, dateKey(now), workout.focus, elapsed);
      }
    } catch {}
    onFinish(session);
  };

  const completedCount = exercises.filter(e => e.sets.length >= e.targetSets).length;

  const handleAskWorkoutCoach = useCallback(async () => {
    const q = coachInput.trim();
    if (!q) return;

    const userMsg: WorkoutCoachMessage = { role: 'user', content: q };
    setCoachChat(prev => [...prev, userMsg]);
    setCoachInput('');
    setCoachLoading(true);

    try {
      const active = exercises[activeExIdx];
      const resp = await askWorkoutQuestion(authToken, {
        question: q,
        workout,
        activeExerciseName: active?.name,
        currentSetNumber: (active?.sets?.length ?? 0) + 1,
        loggedSets: active?.sets ?? [],
      });
      const cues = (resp.quick_cues ?? []).slice(0, 3).map((x: string) => `• ${x}`).join('\n');
      const content = [
        resp.answer,
        cues ? `\n${cues}` : '',
        resp.adjustment ? `\nAdjustment: ${resp.adjustment}` : '',
        resp.safety_note ? `\nSafety: ${resp.safety_note}` : '',
      ].join('');
      setCoachChat(prev => [...prev, { role: 'assistant', content }]);
    } catch (e: any) {
      setCoachChat(prev => [...prev, { role: 'assistant', content: `Could not answer right now. ${e?.message ?? ''}` }]);
    } finally {
      setCoachLoading(false);
    }
  }, [coachInput, exercises, activeExIdx, authToken, workout]);

  const handleAnalyzeFormPhoto = useCallback(async (source: 'camera' | 'library') => {
    if (!authToken) {
      Alert.alert('Sign in required', 'You need to be signed in to analyze form photos.');
      return;
    }

    const permission = source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', `Please allow ${source === 'camera' ? 'camera' : 'photo library'} access for form analysis.`);
      return;
    }

    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync({ quality: 0.7, base64: true, mediaTypes: ['images'] as any })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.7, base64: true, mediaTypes: ['images'] as any });

    if (result.canceled || !result.assets?.[0]?.base64) return;

    const active = exercises[activeExIdx];
    const prompt = coachInput.trim();
    const lead = prompt || `Check my ${active?.name ?? 'current exercise'} form.`;
    setCoachChat(prev => [...prev, { role: 'user', content: `${lead} [form photo]` }]);
    setCoachInput('');
    setCoachPhotoLoading(true);

    try {
      const asset = result.assets[0];
      const imageBase64 = asset.base64;
      if (!imageBase64) return;
      const response = await analyzeWorkoutFormPhoto(authToken, {
        image_base64: imageBase64,
        mime_type: asset.mimeType ?? 'image/jpeg',
        exercise_name: active?.name,
        question: prompt || undefined,
      });
      const cues = (response.quick_cues ?? []).slice(0, 3).map((x: string) => `• ${x}`).join('\n');
      const redFlags = (response.red_flags ?? []).slice(0, 2).map((x: string) => `• ${x}`).join('\n');
      const content = [
        response.answer,
        response.likely_target ? `\nTarget: ${response.likely_target}` : '',
        cues ? `\n${cues}` : '',
        redFlags ? `\nRed flags:\n${redFlags}` : '',
        response.safety_note ? `\nSafety: ${response.safety_note}` : '',
      ].join('');
      setCoachChat(prev => [...prev, { role: 'assistant', content }]);
    } catch (e: any) {
      setCoachChat(prev => [...prev, { role: 'assistant', content: `Could not analyze the form photo right now. ${e?.message ?? ''}` }]);
    } finally {
      setCoachPhotoLoading(false);
    }
  }, [activeExIdx, authToken, coachInput, exercises]);

  const handleAnalyzeFormVideo = useCallback(async (source: 'camera' | 'library') => {
    if (!authToken) {
      Alert.alert('Sign in required', 'You need to be signed in to analyze form videos.');
      return;
    }

    const permission = source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', `Please allow ${source === 'camera' ? 'camera' : 'photo library'} access for video analysis.`);
      return;
    }

    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync({ quality: 0.7, mediaTypes: ['videos'] as any, videoMaxDuration: 20 })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.7, mediaTypes: ['videos'] as any });

    if (result.canceled || !result.assets?.[0]?.uri) return;

    const active = exercises[activeExIdx];
    const prompt = coachInput.trim();
    const lead = prompt || `Check my ${active?.name ?? 'current exercise'} form from this video.`;
    setCoachChat(prev => [...prev, { role: 'user', content: `${lead} [form video]` }]);
    setCoachInput('');
    setCoachPhotoLoading(true);

    try {
      const asset = result.assets[0];
      const thumbnail = await VideoThumbnails.getThumbnailAsync(asset.uri, { time: 1200 });
      const imageBase64 = await FileSystem.readAsStringAsync(thumbnail.uri, { encoding: 'base64' as any });
      const response = await analyzeWorkoutFormPhoto(authToken, {
        image_base64: imageBase64,
        mime_type: 'image/jpeg',
        exercise_name: active?.name,
        question: prompt ? `Video form check: ${prompt}` : 'Video form check',
      });

      const cues = (response.quick_cues ?? []).slice(0, 3).map((x: string) => `• ${x}`).join('\n');
      const redFlags = (response.red_flags ?? []).slice(0, 2).map((x: string) => `• ${x}`).join('\n');
      const content = [
        response.answer,
        response.likely_target ? `\nTarget: ${response.likely_target}` : '',
        cues ? `\n${cues}` : '',
        redFlags ? `\nRed flags:\n${redFlags}` : '',
        response.safety_note ? `\nSafety: ${response.safety_note}` : '',
        '\nNote: video analysis is currently based on a representative frame from your clip.',
      ].join('');
      setCoachChat(prev => [...prev, { role: 'assistant', content }]);
    } catch (e: any) {
      setCoachChat(prev => [...prev, { role: 'assistant', content: `Could not analyze the form video right now. ${e?.message ?? ''}` }]);
    } finally {
      setCoachPhotoLoading(false);
    }
  }, [activeExIdx, authToken, coachInput, exercises]);

  const filteredExerciseLibrary = exerciseLibrary.filter(item => {
    const q = exerciseSearch.trim().toLowerCase();
    if (!q) return true;
    return [item.name, item.primary_muscle ?? '', item.equipment ?? '']
      .join(' ')
      .toLowerCase()
      .includes(q);
  });

  return (
    <View style={styles.container}>

      {/* Header */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.focusLabel}>{workout.focus}</Text>
          <Text style={styles.timer}>{formatTime(elapsed)}</Text>
        </View>
        <View style={styles.headerRight}>
          <Text style={styles.progressText}>{completedCount}/{exercises.length}</Text>
          <Text style={styles.progressSub}>done</Text>
        </View>
        <TouchableOpacity style={styles.cancelBtn} onPress={() => Alert.alert(
          'Cancel Workout', 'Your progress will be lost.',
          [{ text: 'Keep Going', style: 'cancel' }, { text: 'Cancel', style: 'destructive', onPress: () => { clearRestState(); onCancel(); } }]
        )}>
          <Text style={styles.cancelBtnText}>X</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.coachBtn} onPress={() => setCoachModalVisible(true)}>
          <Text style={styles.coachBtnText}>Ask Coach</Text>
        </TouchableOpacity>
      </View>

      {/* Progress bar */}
      <View style={styles.progressBarTrack}>
        <View style={[styles.progressBarFill, {
          width: `${exercises.length ? (completedCount / exercises.length) * 100 : 0}%` as any,
        }]} />
      </View>

      {restRemaining > 0 && (
        <View style={[styles.restBanner, restRemaining <= 10 && styles.restBannerUrgent]}>
          <View style={styles.restBannerMain}>
            <View style={styles.restHeaderRow}>
              <Text style={styles.restBannerTitle}>Rest {formatTime(restRemaining)}</Text>
              <Text style={styles.restExerciseText}>{restForExercise ? `• ${restForExercise}` : ''}</Text>
            </View>
            {restNextTarget ? <Text style={styles.restTargetText}>{restNextTarget}</Text> : null}
            {restCue ? <Text style={styles.restCueText}>{restCue}</Text> : null}
          </View>
          <View style={styles.restBannerActions}>
            <TouchableOpacity style={styles.restBannerBtn} onPress={() => adjustActiveRestRemaining(15)}>
              <Text style={styles.restBannerBtnText}>+15s</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.restBannerBtn} onPress={() => adjustActiveRestRemaining(-15)}>
              <Text style={styles.restBannerBtnText}>-15s</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.restBannerBtn, styles.restBannerBtnPrimary]} onPress={clearRestState}>
              <Text style={styles.restBannerBtnPrimaryText}>Skip</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Exercise list */}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {exercises.map((ex, i) => {
          const isDone      = ex.sets.length >= ex.targetSets;
          const isActive    = activeExIdx === i;
          const isAiLoading = aiLoadingIdx === i;
          const isAiError   = aiErrorIdx === i;

          return (
            <TouchableOpacity
              key={i}
              style={[styles.exerciseCard, isDone && styles.exerciseCardDone, isActive && styles.exerciseCardActive]}
              onPress={() => setActiveExIdx(isActive ? -1 : i)}
              activeOpacity={0.8}>

              <View style={styles.exerciseHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.exerciseName, isDone && styles.exerciseNameDone]}>{ex.name}</Text>
                  <Text style={styles.exerciseMeta}>{ex.targetSets} sets x {ex.targetReps} reps</Text>
                </View>
                <View style={[styles.setsBadge, isDone && styles.setsBadgeDone]}>
                  <Text style={[styles.setsBadgeText, isDone && styles.setsBadgeTextDone]}>
                    {ex.sets.length > ex.targetSets
                      ? `${ex.targetSets}+${ex.sets.length - ex.targetSets}`
                      : `${ex.sets.length}/${ex.targetSets}`}
                  </Text>
                </View>
              </View>

              {isActive && (
                <View style={styles.exerciseDetail}>

                  <View style={styles.restAdjustRow}>
                    <Text style={styles.restAdjustLabel}>Rest target</Text>
                    <View style={styles.restAdjustControls}>
                      <TouchableOpacity style={styles.restAdjustBtn} onPress={() => adjustRestSeconds(i, -15)}>
                        <Text style={styles.restAdjustBtnText}>-15s</Text>
                      </TouchableOpacity>
                      <Text style={styles.restAdjustValue}>{Math.max(15, ex.targetRestSeconds || 60)}s</Text>
                      <TouchableOpacity style={styles.restAdjustBtn} onPress={() => adjustRestSeconds(i, 15)}>
                        <Text style={styles.restAdjustBtnText}>+15s</Text>
                      </TouchableOpacity>
                    </View>
                  </View>

                    <View style={styles.exerciseActionsRow}>
                      <TouchableOpacity style={styles.exerciseActionBtn} onPress={openAddExerciseModal}>
                        <Text style={styles.exerciseActionBtnText}>+ Add Exercise</Text>
                      </TouchableOpacity>
                      {exercises.length > 1 ? (
                        <TouchableOpacity style={[styles.exerciseActionBtn, styles.exerciseActionBtnDanger]} onPress={() => handleRemoveExercise(i)}>
                          <Text style={[styles.exerciseActionBtnText, styles.exerciseActionBtnDangerText]}>Remove Exercise</Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>

                  {ex.sets.length > 0 && (
                    <View style={styles.setsLog}>
                      {ex.sets.map((set, si) => (
                        <View key={si} style={styles.setRow}>
                          <Text style={styles.setNum}>Set {set.setNumber}</Text>
                          <Text style={styles.setData}>{set.weightLbs} lbs x {set.reps} reps</Text>
                          <Text style={styles.setCheck}>{set.feedback ? set.feedback : 'done'}</Text>
                        </View>
                      ))}
                    </View>
                  )}

                  {ex.sets.length > 0 && ex.sets.length < ex.targetSets && (
                    <View style={styles.feedbackCard}>
                      <Text style={styles.feedbackTitle}>How did that last set feel?</Text>
                      <View style={styles.feedbackRow}>
                        {FEEDBACK_OPTIONS.map((option) => {
                          const active = ex.sets[ex.sets.length - 1]?.feedback === option.value;
                          return (
                            <TouchableOpacity
                              key={option.value}
                              style={[styles.feedbackChip, active && styles.feedbackChipActive]}
                              onPress={() => handleSetFeedback(i, option.value)}>
                              <Text style={[styles.feedbackChipText, active && styles.feedbackChipTextActive]}>{option.label}</Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </View>
                  )}

                  {/* AI tip: loading state shown inside the card */}
                  {isAiLoading && (
                    <View style={styles.aiBubble}>
                      <ActivityIndicator size="small" color={colors.accent} />
                      <Text style={styles.aiLoadingText}>  Getting AI tip for next set...</Text>
                    </View>
                  )}

                  {/* AI tip: success */}
                  {!isAiLoading && ex.aiRecommendation && (
                    <View style={styles.aiBubble}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.aiLabel}>AI TIP</Text>
                        <Text style={styles.aiText}>{ex.aiRecommendation}</Text>
                      </View>
                    </View>
                  )}

                  {/* AI tip: error — visible instead of silent */}
                  {!isAiLoading && isAiError && !ex.aiRecommendation && (
                    <View style={[styles.aiBubble, styles.aiBubbleError]}>
                      <Text style={styles.aiErrorText}>
                        AI tip unavailable — check your OpenAI API key in backend/.env
                      </Text>
                    </View>
                  )}

                  {!isDone && (
                    <TouchableOpacity style={styles.logSetBtn} onPress={() => openLogModal(i)}>
                      <Text style={styles.logSetBtnText}>+ Log Set {ex.sets.length + 1}</Text>
                    </TouchableOpacity>
                  )}

                  {isDone && (
                    <View style={styles.doneRow}>
                      <Text style={styles.doneText}>All sets complete!</Text>
                      <TouchableOpacity style={styles.addSetBtn} onPress={() => openLogModal(i)}>
                        <Text style={styles.addSetBtnText}>+ Add Set</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              )}
            </TouchableOpacity>
          );
        })}

        <TouchableOpacity
          style={[styles.finishBtn, completedCount === 0 && styles.finishBtnDisabled]}
          onPress={() => {
            if (completedCount === 0) {
              Alert.alert('No sets logged', 'Log at least one set before finishing.');
              return;
            }
            setFinishModalVisible(true);
          }}>
          <Text style={styles.finishBtnText}>Finish Workout</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Log Set Modal — keyboard-aware */}
      <Modal visible={logModalVisible} transparent animationType="slide" onRequestClose={() => setLogModalVisible(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setLogModalVisible(false)}>
            <View style={styles.logModal}>
              <View style={styles.logHandle} />
              <Text style={styles.logModalTitle}>
                Set {(exercises[logExIdx]?.sets.length ?? 0) + 1} — {exercises[logExIdx]?.name}
              </Text>
              <Text style={styles.logModalSub}>Target: {exercises[logExIdx]?.targetReps} reps</Text>

              <View style={styles.logInputRow}>
                <View style={styles.logInputWrap}>
                  <Text style={styles.logInputLabel}>Weight (lbs)</Text>
                  <TextInput
                    style={styles.logInput}
                    value={logWeight}
                    onChangeText={setLogWeight}
                    keyboardType="decimal-pad"
                    placeholder="0"
                    placeholderTextColor={colors.textMuted}
                    autoFocus
                    selectTextOnFocus
                  />
                </View>
                <View style={styles.logInputWrap}>
                  <Text style={styles.logInputLabel}>Reps</Text>
                  <TextInput
                    style={styles.logInput}
                    value={logReps}
                    onChangeText={setLogReps}
                    keyboardType="number-pad"
                    placeholder="0"
                    placeholderTextColor={colors.textMuted}
                    selectTextOnFocus
                  />
                </View>
              </View>

              <TouchableOpacity style={styles.logConfirmBtn} onPress={handleLogSet}>
                <Text style={styles.logConfirmText}>Save Set</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>

      {/* Finish Modal */}
      <Modal visible={finishModalVisible} transparent animationType="fade" onRequestClose={() => setFinishModalVisible(false)}>
        <View style={styles.finishBackdrop}>
          <View style={styles.finishModal}>
            <Text style={styles.finishModalTitle}>Great Work!</Text>
            <Text style={styles.finishModalBody}>
              {formatTime(elapsed)}  |  {completedCount}/{exercises.length} exercises done
            </Text>
            <TouchableOpacity style={styles.finishConfirmBtn} onPress={handleFinish}>
              <Text style={styles.finishConfirmText}>Save and Finish</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setFinishModalVisible(false)}>
              <Text style={styles.finishCancelText}>Keep Going</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={coachModalVisible} transparent animationType="slide" onRequestClose={() => setCoachModalVisible(false)}>
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 24 : 0}
        >
          <View style={styles.coachSheet}>
            <View style={styles.coachHeader}>
              <Text style={styles.coachTitle}>Workout Coach</Text>
              <TouchableOpacity onPress={() => setCoachModalVisible(false)}>
                <Text style={styles.coachClose}>Close</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.coachHint}>This chat is for form, pain flags, and in-session adjustments.</Text>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.coachPromptRow}>
              {COACH_PROMPT_OPTIONS.map((option) => (
                <TouchableOpacity
                  key={option.label}
                  style={styles.coachPromptChip}
                  onPress={() => {
                    const activeExercise = exercises[activeExIdx]?.name ?? 'this exercise';
                    setCoachInput(option.template(activeExercise));
                  }}>
                  <Text style={styles.coachPromptChipText}>{option.label}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <View style={styles.coachActionRow}>
              <TouchableOpacity style={styles.coachActionBtn} onPress={() => handleAnalyzeFormPhoto('camera')} disabled={coachPhotoLoading}>
                <Text style={styles.coachActionText}>{coachPhotoLoading ? 'Analyzing...' : 'Snap Form Photo'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.coachActionBtn} onPress={() => handleAnalyzeFormPhoto('library')} disabled={coachPhotoLoading}>
                <Text style={styles.coachActionText}>Use Existing Photo</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.coachActionRow}>
              <TouchableOpacity style={styles.coachActionBtn} onPress={() => handleAnalyzeFormVideo('camera')} disabled={coachPhotoLoading}>
                <Text style={styles.coachActionText}>Record Form Video</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.coachActionBtn} onPress={() => handleAnalyzeFormVideo('library')} disabled={coachPhotoLoading}>
                <Text style={styles.coachActionText}>Analyze Saved Video</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.coachSubHint}>Video checks use a representative frame from your clip for now.</Text>

            <ScrollView contentContainerStyle={styles.coachChatList} keyboardShouldPersistTaps="handled">
              {coachChat.length === 0 ? (
                <Text style={styles.coachEmpty}>Example: "I feel this in my elbow not chest. What cues should I use?"</Text>
              ) : (
                coachChat.map((m, idx) => (
                  <View key={idx} style={[styles.coachBubble, m.role === 'user' ? styles.coachBubbleUser : styles.coachBubbleAssistant]}>
                    <Text style={styles.coachBubbleText}>{m.content}</Text>
                  </View>
                ))
              )}
            </ScrollView>

            <View style={styles.coachInputRow}>
              <TextInput
                value={coachInput}
                onChangeText={setCoachInput}
                placeholder="Ask about form or pain..."
                placeholderTextColor={colors.textMuted}
                style={styles.coachInput}
                multiline
              />
              <TouchableOpacity style={styles.coachSendBtn} onPress={handleAskWorkoutCoach} disabled={coachLoading || coachPhotoLoading}>
                {coachLoading ? <ActivityIndicator size="small" color={colors.background} /> : <Text style={styles.coachSendText}>Send</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={addExerciseModalVisible} transparent animationType="slide" onRequestClose={() => setAddExerciseModalVisible(false)}>
        <KeyboardAvoidingView style={styles.modalBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.coachSheet}>
            <View style={styles.coachHeader}>
              <Text style={styles.coachTitle}>Add Exercise</Text>
              <TouchableOpacity onPress={() => setAddExerciseModalVisible(false)}>
                <Text style={styles.coachClose}>Close</Text>
              </TouchableOpacity>
            </View>

            <TextInput
              value={exerciseSearch}
              onChangeText={setExerciseSearch}
              placeholder="Search exercise library..."
              placeholderTextColor={colors.textMuted}
              style={styles.addExerciseSearch}
            />

            {exerciseLibraryLoading ? (
              <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: 12 }} />
            ) : (
              <ScrollView contentContainerStyle={styles.addExerciseList} keyboardShouldPersistTaps="handled">
                {filteredExerciseLibrary.length === 0 ? (
                  <Text style={styles.coachEmpty}>No exercises match your search.</Text>
                ) : filteredExerciseLibrary.map((item) => (
                  <TouchableOpacity key={String(item.id ?? item.name)} style={styles.addExerciseItem} onPress={() => handleAddExercise(item)}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.addExerciseName}>{item.name}</Text>
                      <Text style={styles.addExerciseMeta}>{item.primary_muscle ?? 'general'} · {item.equipment ?? 'bodyweight'}</Text>
                    </View>
                    <Text style={styles.addExerciseUse}>Add</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 56, paddingBottom: 12, gap: 12 },
  focusLabel:   { fontSize: 18, fontWeight: '700', color: colors.textPrimary, marginBottom: 2 },
  timer:        { fontSize: 32, fontWeight: '800', color: colors.primary },
  headerRight:  { alignItems: 'center' },
  progressText: { fontSize: 22, fontWeight: '700', color: colors.textPrimary },
  progressSub:  { fontSize: 11, color: colors.textSecondary },
  cancelBtn:    { padding: 8, backgroundColor: colors.surface, borderRadius: radius.full, borderWidth: 1, borderColor: colors.border },
  cancelBtnText:{ fontSize: 14, color: colors.textSecondary, fontWeight: '600' },
  coachBtn: { paddingHorizontal: 10, paddingVertical: 8, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.primary },
  coachBtnText: { fontSize: 12, color: colors.primary, fontWeight: '700' },

  progressBarTrack: { height: 3, backgroundColor: colors.border, marginHorizontal: 16, borderRadius: 2, marginBottom: 16 },
  progressBarFill:  { height: 3, backgroundColor: colors.primary, borderRadius: 2 },

  restBanner: {
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 10,
    alignItems: 'stretch',
  },
  restBannerUrgent: { borderColor: colors.warning, backgroundColor: colors.warning + '12' },
  restBannerMain: { gap: 4, flex: 1, minWidth: 0 },
  restHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  restBannerTitle: { fontSize: 18, color: colors.textPrimary, fontWeight: '800' },
  restExerciseText: { fontSize: 13, color: colors.primary, fontWeight: '700' },
  restTargetText: { fontSize: 13, color: colors.textPrimary, fontWeight: '700' },
  restCueText: { fontSize: 12, color: colors.textSecondary, lineHeight: 18 },
  restBannerActions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  restBannerBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  restBannerBtnText: { fontSize: 12, color: colors.textPrimary, fontWeight: '700' },
  restBannerBtnPrimary: { borderColor: colors.primary, backgroundColor: colors.primary },
  restBannerBtnPrimaryText: { fontSize: 12, color: colors.background, fontWeight: '700' },

  scroll:        { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 40 },

  exerciseCard:       { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 14, marginBottom: 10 },
  exerciseCardDone:   { borderColor: colors.primary, opacity: 0.85 },
  exerciseCardActive: { borderColor: colors.primary },

  exerciseHeader:   { flexDirection: 'row', alignItems: 'center' },
  exerciseName:     { fontSize: 15, fontWeight: '600', color: colors.textPrimary, marginBottom: 2 },
  exerciseNameDone: { color: colors.textSecondary, textDecorationLine: 'line-through' },
  exerciseMeta:     { fontSize: 12, color: colors.textMuted },

  setsBadge:        { backgroundColor: colors.surfaceRaised, borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: colors.border },
  setsBadgeDone:    { backgroundColor: colors.primary, borderColor: colors.primary },
  setsBadgeText:    { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  setsBadgeTextDone:{ color: colors.background },

  exerciseDetail: { marginTop: 14, gap: 10 },

  restAdjustRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  restAdjustLabel: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },
  restAdjustControls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  restAdjustBtn: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  restAdjustBtnText: { fontSize: 12, fontWeight: '700', color: colors.textPrimary },
  restAdjustValue: { minWidth: 48, textAlign: 'center', fontSize: 13, fontWeight: '700', color: colors.primary },
  exerciseActionsRow: { flexDirection: 'row', gap: 8 },
  exerciseActionBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  exerciseActionBtnDanger: { borderColor: colors.error, backgroundColor: colors.error + '12' },
  exerciseActionBtnText: { fontSize: 12, color: colors.textPrimary, fontWeight: '700' },
  exerciseActionBtnDangerText: { color: colors.error },

  setsLog: { gap: 6 },
  setRow:  { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  setNum:  { fontSize: 12, color: colors.textMuted, width: 44 },
  setData: { flex: 1, fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  setCheck:{ fontSize: 12, color: colors.primary, fontWeight: '700' },
  feedbackCard: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 10,
    gap: 8,
  },
  feedbackTitle: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  feedbackRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  feedbackChip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  feedbackChipActive: { borderColor: colors.primary, backgroundColor: colors.primary + '12' },
  feedbackChipText: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  feedbackChipTextActive: { color: colors.primary },

  aiBubble:      { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surfaceRaised, borderRadius: radius.md, padding: 12, borderLeftWidth: 3, borderLeftColor: colors.accent },
  aiBubbleError: { borderLeftColor: colors.error },
  aiLabel:       { fontSize: 10, fontWeight: '700', color: colors.accent, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 3 },
  aiText:        { fontSize: 13, color: colors.textPrimary },
  aiLoadingText: { fontSize: 13, color: colors.textSecondary },
  aiErrorText:   { fontSize: 12, color: colors.error, flex: 1 },

  logSetBtn:     { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' },
  logSetBtnText: { color: colors.background, fontSize: 15, fontWeight: '700' },

  doneRow:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 8, gap: 12 },
  doneText:     { fontSize: 13, color: colors.primary, fontWeight: '600' },
  addSetBtn:    { borderWidth: 1, borderColor: colors.primary, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 6 },
  addSetBtnText:{ fontSize: 13, color: colors.primary, fontWeight: '600' },

  finishBtn:         { backgroundColor: colors.surface, borderRadius: radius.md, paddingVertical: 16, alignItems: 'center', marginTop: 8, borderWidth: 1, borderColor: colors.primary },
  finishBtnDisabled: { borderColor: colors.border, opacity: 0.5 },
  finishBtnText:     { fontSize: 16, fontWeight: '700', color: colors.primary },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  logModal: {
    backgroundColor: colors.surface, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    padding: 24, paddingBottom: 40, gap: 16, borderTopWidth: 1, borderTopColor: colors.border,
  },
  logHandle:     { width: 36, height: 4, backgroundColor: colors.border, borderRadius: 2, alignSelf: 'center', marginBottom: 4 },
  logModalTitle: { fontSize: 18, fontWeight: '700', color: colors.textPrimary },
  logModalSub:   { fontSize: 13, color: colors.textSecondary, marginTop: -8 },
  logInputRow:   { flexDirection: 'row', gap: 12 },
  logInputWrap:  { flex: 1, gap: 6 },
  logInputLabel: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  logInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 14, fontSize: 28, fontWeight: '700', color: colors.textPrimary,
    backgroundColor: colors.background, textAlign: 'center',
  },
  logConfirmBtn:  { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 16, alignItems: 'center' },
  logConfirmText: { color: colors.background, fontSize: 16, fontWeight: '700' },

  finishBackdrop:    { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center' },
  finishModal:       { backgroundColor: colors.surface, borderRadius: radius.xl, padding: 28, alignItems: 'center', gap: 12, borderWidth: 1, borderColor: colors.border, width: '85%' },
  finishModalTitle:  { fontSize: 26, fontWeight: '800', color: colors.textPrimary },
  finishModalBody:   { fontSize: 14, color: colors.textSecondary, textAlign: 'center' },
  finishConfirmBtn:  { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', width: '100%', marginTop: 8 },
  finishConfirmText: { color: colors.background, fontSize: 16, fontWeight: '700' },
  finishCancelText:  { fontSize: 14, color: colors.textMuted, marginTop: 4 },

  coachSheet: {
    maxHeight: '82%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 14,
    paddingBottom: 12,
  },
  coachHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8 },
  coachTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  coachClose: { fontSize: 14, fontWeight: '700', color: colors.primary },
  coachHint: { fontSize: 12, color: colors.textSecondary, paddingHorizontal: 16, marginBottom: 8 },
  coachPromptRow: { gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  coachPromptChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceRaised,
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  coachPromptChipText: { fontSize: 12, color: colors.textPrimary, fontWeight: '600' },
  coachActionRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, marginBottom: 8 },
  coachActionBtn: {
    flex: 1,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 10,
    alignItems: 'center',
  },
  coachActionText: { fontSize: 12, fontWeight: '700', color: colors.primary },
  coachSubHint: { fontSize: 11, color: colors.textMuted, paddingHorizontal: 16, marginBottom: 6 },
  coachChatList: { paddingHorizontal: 16, paddingBottom: 10, gap: 8 },
  coachEmpty: {
    fontSize: 12,
    color: colors.textMuted,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 10,
  },
  coachBubble: { borderRadius: radius.md, borderWidth: 1, padding: 10 },
  coachBubbleUser: { backgroundColor: colors.primary, borderColor: colors.primary, alignSelf: 'flex-end', maxWidth: '90%' },
  coachBubbleAssistant: { backgroundColor: colors.surfaceRaised, borderColor: colors.border, alignSelf: 'flex-start', maxWidth: '95%' },
  coachBubbleText: { fontSize: 13, color: colors.textPrimary },
  coachInputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 16, paddingTop: 8 },
  coachInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 10,
    paddingVertical: 8,
    maxHeight: 110,
    backgroundColor: colors.background,
    color: colors.textPrimary,
  },
  coachSendBtn: { backgroundColor: colors.primary, borderRadius: radius.md, minWidth: 64, paddingVertical: 11, alignItems: 'center', justifyContent: 'center' },
  coachSendText: { color: colors.background, fontSize: 13, fontWeight: '700' },
  addExerciseSearch: {
    marginHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.background,
    color: colors.textPrimary,
  },
  addExerciseList: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 16, gap: 8 },
  addExerciseItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
    padding: 12,
  },
  addExerciseName: { fontSize: 13, fontWeight: '700', color: colors.textPrimary, marginBottom: 2 },
  addExerciseMeta: { fontSize: 12, color: colors.textSecondary },
  addExerciseUse: { fontSize: 12, color: colors.primary, fontWeight: '700' },
});
