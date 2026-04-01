import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  TextInput, Modal, ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WorkoutDay, WorkoutSession, SessionExercise, CompletedSet } from '../types';
import { saveWorkoutSession, getLastSetsForExercise, dateKey } from '../utils/workoutHistory';
import { getWeightRecommendation, logWorkoutDone } from '../services/api';
import { colors, radius } from '../constants/theme';

interface ActiveWorkoutScreenProps {
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

export default function ActiveWorkoutScreen({ workout, goal, onFinish, onCancel }: ActiveWorkoutScreenProps) {
  const startTime = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  const [exercises, setExercises] = useState<SessionExercise[]>(() =>
    workout.exercises.map(ex => ({
      name: ex.name,
      targetSets: ex.sets,
      targetReps: ex.reps,
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

  // Per-exercise AI state
  const [aiLoadingIdx, setAiLoadingIdx] = useState<number | null>(null);
  const [aiErrorIdx, setAiErrorIdx]     = useState<number | null>(null);

  const [finishModalVisible, setFinishModalVisible] = useState(false);

  // Timer
  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
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

    // Fetch AI tip for the next set
    const setsLogged = updatedSets.length;
    if (setsLogged < ex.targetSets) {
      console.log('[AI] Starting AI recommendation fetch for exercise:', ex.name, 'set:', setsLogged + 1);
      setAiLoadingIdx(exIdx);
      try {
        const token = await AsyncStorage.getItem('authToken');
        console.log('[AI] Retrieved auth token:', token ? 'present' : 'missing');
        if (!token) {
          console.warn('[AI] No auth token found, throwing error');
          throw new Error('Not authenticated');
        }
        console.log('[AI] Calling getWeightRecommendation API...');
        const rec = await getWeightRecommendation(token, ex.name, goal, updatedSets, setsLogged + 1);
        console.log('[AI] API call successful, received recommendation:', rec);
        const tip = `Set ${setsLogged + 1}: try ${rec.weightLbs} lbs x ${rec.reps} reps — ${rec.tip}`;
        console.log('[AI] Formatted tip text:', tip);
        setExercises(prev => {
          const newExercises = prev.map((e, i) => i === exIdx ? { ...e, aiRecommendation: tip } : e);
          console.log('[AI] Updated exercises state, recommendation set for exercise index:', exIdx);
          return newExercises;
        });
      } catch (error) {
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
    // Also persist completion to backend DB so it survives cache clears
    try {
      const token = await AsyncStorage.getItem('authToken');
      if (token) {
        await logWorkoutDone(token, dateKey(now), workout.focus, elapsed);
      }
    } catch {}
    onFinish(session);
  };

  const completedCount = exercises.filter(e => e.sets.length >= e.targetSets).length;

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
          [{ text: 'Keep Going', style: 'cancel' }, { text: 'Cancel', style: 'destructive', onPress: onCancel }]
        )}>
          <Text style={styles.cancelBtnText}>X</Text>
        </TouchableOpacity>
      </View>

      {/* Progress bar */}
      <View style={styles.progressBarTrack}>
        <View style={[styles.progressBarFill, {
          width: `${exercises.length ? (completedCount / exercises.length) * 100 : 0}%` as any,
        }]} />
      </View>

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

                  {ex.sets.length > 0 && (
                    <View style={styles.setsLog}>
                      {ex.sets.map((set, si) => (
                        <View key={si} style={styles.setRow}>
                          <Text style={styles.setNum}>Set {set.setNumber}</Text>
                          <Text style={styles.setData}>{set.weightLbs} lbs x {set.reps} reps</Text>
                          <Text style={styles.setCheck}>done</Text>
                        </View>
                      ))}
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

  progressBarTrack: { height: 3, backgroundColor: colors.border, marginHorizontal: 16, borderRadius: 2, marginBottom: 16 },
  progressBarFill:  { height: 3, backgroundColor: colors.primary, borderRadius: 2 },

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

  setsLog: { gap: 6 },
  setRow:  { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  setNum:  { fontSize: 12, color: colors.textMuted, width: 44 },
  setData: { flex: 1, fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  setCheck:{ fontSize: 12, color: colors.primary, fontWeight: '700' },

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
});
