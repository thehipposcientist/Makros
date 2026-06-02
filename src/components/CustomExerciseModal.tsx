import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ImageBackground,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { ImageSourcePropType } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AppThemeName, CustomExerciseItem } from '../types';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import {
  createManualCustomExercise,
  customExerciseTagLabel,
  CUSTOM_EXERCISE_PRIMARY_MUSCLES,
  CUSTOM_EXERCISE_PROGRAMMING_TAGS,
  normalizeCustomExerciseProgrammingTags,
} from '../utils/customExercises';
import { humanizeToken } from '../utils/exerciseGuide';
import { searchExerciseAI, type AIExerciseResult } from '../services/api';
import NumberWheelPicker from './NumberWheelPicker';

const COMMON_CUSTOM_EQUIPMENT_OPTIONS = [
  'Bodyweight',
  'Dumbbells',
  'Barbell',
  'Kettlebell',
  'Cable Machine',
  'Single Cable Station',
  'Dual Cable Station',
  'Smith Machine',
  'Resistance Bands',
  'Plate-Loaded Machine',
  'Selectorized Machine',
  'Chest Press Machine',
  'Shoulder Press Machine',
  'Row Machine',
  'Lat Pulldown Machine',
  'Leg Press Machine',
  'Hack Squat Machine',
  'Belt Squat Machine',
  'Hip Thrust Machine',
  'Glute Kickback Machine',
  'Preacher Curl Machine',
  'Sled',
] as const;

const CUSTOM_EXERCISE_SETS_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const CUSTOM_EXERCISE_REPS_VALUES = [
  '1', '2', '3', '4', '5', '6', '8', '10', '12', '15', '20', '25',
  '1-3', '3-5', '4-6', '5-8', '6-8', '8-10', '8-12', '10-12', '10-15',
  '12-15', '15-20', '20-25', 'AMRAP',
] as const;
const CUSTOM_EXERCISE_TIME_VALUES = [
  '15s', '20s', '30s', '45s', '60s', '90s', '2 min', '3 min',
  '5 min', '8 min', '10 min', '15 min', '20 min', '25 min', '30 min',
] as const;
const CUSTOM_EXERCISE_REST_VALUES = [0, 15, 30, 45, 60, 75, 90, 105, 120, 150, 180, 210, 240, 300] as const;
const NO_SECONDARY_MUSCLE = 'none';

const CUSTOM_EXERCISE_HEADER_IMAGE: ImageSourcePropType = require('../../assets/images/card-backgrounds/workout-card-generic-gym-day-neutral.jpg');

function splitListText(value: string): string[] {
  return value
    .split(/[,\n]+/)
    .map(item => item.trim())
    .filter((item, idx, arr) => !!item && arr.indexOf(item) === idx);
}

function snapToNearest<T extends string | number>(values: readonly T[], target: T): T {
  if (values.includes(target)) return target;
  if (typeof target === 'number') {
    let best = values[0];
    let bestDelta = Math.abs((best as number) - target);
    for (const value of values) {
      const delta = Math.abs((value as number) - target);
      if (delta < bestDelta) {
        best = value;
        bestDelta = delta;
      }
    }
    return best;
  }
  return values[0];
}

function formatRest(seconds: number): string {
  if (seconds <= 0) return 'None';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function numberOrFallback(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function withCurrentOption(values: readonly string[], current: string): string[] {
  const trimmed = current.trim();
  if (!trimmed || values.includes(trimmed)) return [...values];
  return [trimmed, ...values];
}

function looksTimedTarget(value: unknown): boolean {
  return /(\b\d+\s*-?\s*\d*\s*s(ec|econds?)?\b)|(\b\d+\s*-?\s*\d*\s*m(in(ute)?s?)?\b)|flow|hold|each side|per side/i
    .test(String(value ?? '').trim());
}

function normalizeEquipmentKey(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function splitEquipmentText(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.replace(/[|/;]/g, ',').split(/[,\n]+/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = normalizeEquipmentKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function mergeEquipmentText(value: string, additions: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...splitEquipmentText(value), ...additions]) {
    const trimmed = String(item ?? '').trim();
    const key = normalizeEquipmentKey(trimmed);
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out.join(', ');
}

function removeEquipmentText(value: string, option: string): string {
  const optionKey = normalizeEquipmentKey(option);
  return splitEquipmentText(value)
    .filter(item => normalizeEquipmentKey(item) !== optionKey)
    .join(', ');
}

function uniqueEquipmentOptions(...lists: Array<readonly string[] | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const item of list ?? []) {
      for (const trimmed of splitEquipmentText(String(item ?? ''))) {
        const key = normalizeEquipmentKey(trimmed);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
      }
    }
  }
  return out;
}

interface Props {
  visible: boolean;
  themeName?: AppThemeName;
  initialName?: string;
  initialExercise?: CustomExerciseItem | null;
  title?: string;
  saveLabel?: string;
  authToken?: string | null;
  availableEquipment?: string[];
  equipmentOptions?: string[];
  injuries?: string[];
  onClose: () => void;
  onSave: (exercise: CustomExerciseItem) => void | Promise<void>;
}

export default function CustomExerciseModal({
  visible,
  themeName,
  initialName,
  initialExercise,
  title = 'Custom Exercise',
  saveLabel = 'Save Exercise',
  authToken,
  availableEquipment,
  equipmentOptions,
  injuries,
  onClose,
  onSave,
}: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [name, setName] = useState('');
  const [equipment, setEquipment] = useState('');
  const [equipmentQuery, setEquipmentQuery] = useState('');
  const [primaryMuscle, setPrimaryMuscle] = useState<string>('chest');
  const [secondaryMuscles, setSecondaryMuscles] = useState<string[]>([]);
  const [trackingMode, setTrackingMode] = useState<'reps' | 'time'>('reps');
  const [sets, setSets] = useState('3');
  const [reps, setReps] = useState('8-12');
  const [restSeconds, setRestSeconds] = useState('60');
  const [isCompound, setIsCompound] = useState<boolean | null>(null);
  const [primaryMuscleTouched, setPrimaryMuscleTouched] = useState(false);
  const [movementPattern, setMovementPattern] = useState<string | null>(null);
  const [programmingTags, setProgrammingTags] = useState<string[]>([]);
  const [description, setDescription] = useState('');
  const [formCuesText, setFormCuesText] = useState('');
  const [aliasesText, setAliasesText] = useState('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [demoExerciseDbId, setDemoExerciseDbId] = useState<string | null>(null);
  const [aiEnriched, setAiEnriched] = useState(false);
  const [aiFilling, setAiFilling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (!visible) return;
    const initialProgrammingTags = normalizeCustomExerciseProgrammingTags(initialExercise?.programming_tags);
    setName(String(initialExercise?.name ?? initialName ?? '').trim());
    setEquipment(String(initialExercise?.equipment ?? ''));
    setEquipmentQuery('');
    setPrimaryMuscle(String(initialExercise?.primary_muscle ?? 'chest'));
    setSecondaryMuscles((initialExercise?.secondary_muscles ?? []).slice(0, 1));
    setTrackingMode(initialExercise?.default_tracking_mode === 'time' ? 'time' : 'reps');
    setSets(String(initialExercise?.sets ?? 3));
    setReps(String(initialExercise?.reps ?? '8-12'));
    setRestSeconds(String(initialExercise?.rest_seconds ?? 60));
    setIsCompound(initialExercise?.is_compound ?? null);
    setPrimaryMuscleTouched(false);
    setMovementPattern(initialExercise?.movement_pattern ?? null);
    setProgrammingTags(initialProgrammingTags);
    setDescription(initialExercise?.description ?? '');
    setFormCuesText((initialExercise?.form_cues ?? []).join(', '));
    setAliasesText((initialExercise?.aliases ?? []).join(', '));
    setImageUrl(initialExercise?.image_url ?? null);
    setVideoId(initialExercise?.video_id ?? null);
    setDemoExerciseDbId(initialExercise?.demo_exercise_db_id ?? null);
    setAiEnriched(initialExercise?.source === 'ai');
    setAiFilling(false);
    setSaving(false);
    setShowAdvanced(Boolean(
      initialExercise
      && (
        initialExercise.is_compound != null
        || initialProgrammingTags.length > 0
        || String(initialExercise.description ?? '').trim().length > 0
      ),
    ));
  }, [initialExercise, initialName, visible]);

  const muscleOptions = useMemo(() => [...CUSTOM_EXERCISE_PRIMARY_MUSCLES], []);
  const secondaryMuscleOptions = useMemo(
    () => [NO_SECONDARY_MUSCLE, ...muscleOptions.filter(muscle => muscle !== primaryMuscle)],
    [muscleOptions, primaryMuscle],
  );
  const secondaryMuscleValue = secondaryMuscleOptions.find(muscle => secondaryMuscles.includes(muscle))
    ?? NO_SECONDARY_MUSCLE;
  const formCues = useMemo(() => splitListText(formCuesText).slice(0, 5), [formCuesText]);
  const aliases = useMemo(() => splitListText(aliasesText).slice(0, 5), [aliasesText]);
  const equipmentChoices = useMemo(() => uniqueEquipmentOptions(
    availableEquipment,
    equipmentOptions,
    COMMON_CUSTOM_EQUIPMENT_OPTIONS,
  ).slice(0, 36), [availableEquipment, equipmentOptions]);
  const selectedEquipment = useMemo(() => splitEquipmentText(equipment), [equipment]);
  const selectedEquipmentKeys = useMemo(
    () => new Set(selectedEquipment.map(normalizeEquipmentKey)),
    [selectedEquipment],
  );
  const equipmentQueryKey = normalizeEquipmentKey(equipmentQuery);
  const filteredEquipmentChoices = useMemo(() => {
    if (!equipmentQueryKey) return [];
    return equipmentChoices
      .filter(option => {
        const optionKey = normalizeEquipmentKey(option);
        return !selectedEquipmentKeys.has(optionKey)
          && (optionKey.includes(equipmentQueryKey) || equipmentQueryKey.includes(optionKey));
      })
      .slice(0, 10);
  }, [equipmentChoices, equipmentQueryKey, selectedEquipmentKeys]);
  const currentEquipmentParts = useMemo(
    () => uniqueEquipmentOptions(selectedEquipment, splitEquipmentText(equipmentQuery)),
    [equipmentQuery, selectedEquipment],
  );
  const isEditing = !!initialExercise;
  const targetWheelValues = useMemo(() => withCurrentOption(
    trackingMode === 'time' ? CUSTOM_EXERCISE_TIME_VALUES : CUSTOM_EXERCISE_REPS_VALUES,
    reps,
  ), [reps, trackingMode]);
  const targetWheelValue = targetWheelValues.includes(reps.trim())
    ? reps.trim()
    : targetWheelValues[0];
  const headerTitle = name.trim() || title;
  const headerSubtitle = useMemo(() => {
    const firstEquipment = currentEquipmentParts[0];
    return [
      humanizeToken(primaryMuscle),
      trackingMode === 'time' ? 'Timed' : 'Reps',
      firstEquipment ? humanizeToken(firstEquipment) : null,
    ].filter(Boolean).join(' · ');
  }, [currentEquipmentParts, primaryMuscle, trackingMode]);

  const handleTrackingModeChange = (mode: 'reps' | 'time') => {
    setTrackingMode(mode);
    setReps(prev => {
      const trimmed = prev.trim();
      if (mode === 'time') return looksTimedTarget(trimmed) ? trimmed : '30s';
      return looksTimedTarget(trimmed) ? '8-12' : (trimmed || '8-12');
    });
  };

  const handleEquipmentQueryChange = (text: string) => {
    if (!/[,\n|\/;]/.test(text)) {
      setEquipmentQuery(text);
      return;
    }
    const endsWithSeparator = /[,\n|\/;]\s*$/.test(text);
    const chunks = text.replace(/[|\/;]/g, ',').split(/[,\n]+/);
    const committed = endsWithSeparator ? chunks : chunks.slice(0, -1);
    const nextQuery = endsWithSeparator ? '' : String(chunks[chunks.length - 1] ?? '');
    const additions = committed.map(item => item.trim()).filter(Boolean);
    if (additions.length > 0) {
      setEquipment(prev => mergeEquipmentText(prev, additions));
    }
    setEquipmentQuery(nextQuery.replace(/^\s+/, ''));
  };

  const commitEquipmentQuery = () => {
    const additions = splitEquipmentText(equipmentQuery);
    if (additions.length === 0) return;
    setEquipment(prev => mergeEquipmentText(prev, additions));
    setEquipmentQuery('');
  };

  const addEquipmentOption = (option: string) => {
    const query = equipmentQuery.trim();
    setEquipment(prev => mergeEquipmentText(query ? removeEquipmentText(prev, query) : prev, [option]));
    setEquipmentQuery('');
  };

  const removeSelectedEquipment = (option: string) => {
    setEquipment(prev => removeEquipmentText(prev, option));
  };

  const toggleProgrammingTag = (tag: string) => {
    setProgrammingTags(prev => (
      prev.includes(tag)
        ? prev.filter(item => item !== tag)
        : [...prev, tag]
    ));
  };

  const normalizeMuscle = (value: unknown): string | null => {
    const raw = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '_');
    if (raw === 'abs' || raw === 'obliques') return 'core';
    return muscleOptions.includes(raw as any) ? raw : null;
  };

  const applyAiResult = (result: AIExerciseResult) => {
    const nextPrimary = normalizeMuscle(result.primary_muscle) ?? primaryMuscle;
    const nextSecondary = (result.secondary_muscles ?? [])
      .map(normalizeMuscle)
      .filter((muscle): muscle is string => !!muscle && muscle !== nextPrimary)
      .filter((muscle, idx, arr) => arr.indexOf(muscle) === idx);
    const nextSets = Number(result.sets);
    const nextRest = Number(result.rest_seconds);

    if (currentEquipmentParts.length === 0 && result.equipment) {
      setEquipment(humanizeToken(result.equipment));
      setEquipmentQuery('');
    }
    setPrimaryMuscle(nextPrimary);
    setPrimaryMuscleTouched(true);
    setSecondaryMuscles(nextSecondary.slice(0, 1));
    if (Number.isFinite(nextSets) && nextSets > 0) setSets(String(Math.max(1, Math.floor(nextSets))));
    if (String(result.reps ?? '').trim()) setReps(String(result.reps).trim());
    setTrackingMode(looksTimedTarget(result.reps) ? 'time' : 'reps');
    if (Number.isFinite(nextRest) && nextRest >= 0) setRestSeconds(String(Math.max(0, Math.round(nextRest))));
    if (typeof result.is_compound === 'boolean') setIsCompound(result.is_compound);
    setMovementPattern(result.movement_pattern ?? null);
    setDescription(String(result.why ?? '').trim());
    setFormCuesText((result.form_cues ?? []).map(cue => String(cue ?? '').trim()).filter(Boolean).slice(0, 5).join(', '));
    setAliasesText((result.aliases ?? []).map(alias => String(alias ?? '').trim()).filter(Boolean).slice(0, 5).join(', '));
    setImageUrl(result.image_url ?? null);
    setVideoId(result.video_id ?? null);
    setDemoExerciseDbId(result.demo_exercise_db_id ?? null);
    setAiEnriched(true);
  };

  const handleAiFill = async () => {
    const trimmedName = name.trim();
    const equipmentParts = currentEquipmentParts;
    const trimmedEquipment = equipmentParts.join(', ');
    if (!authToken) {
      Alert.alert('AI unavailable', 'Sign in with a Pro account to use AI Fill.');
      return;
    }
    if (!trimmedName) {
      Alert.alert('Exercise name needed', 'Add a name before using AI Fill.');
      return;
    }

    const query = [
      trimmedName,
      trimmedEquipment ? `using ${trimmedEquipment}` : '',
      primaryMuscleTouched ? `targeting ${humanizeToken(primaryMuscle)}` : '',
    ].filter(Boolean).join(' ');
    const equipmentHints = Array.from(new Set([
      ...equipmentParts,
      ...(availableEquipment ?? []),
    ].map(item => String(item ?? '').trim()).filter(Boolean)));

    setAiFilling(true);
    try {
      const res = await searchExerciseAI(authToken, {
        query,
        equipment: equipmentHints.length > 0 ? equipmentHints : undefined,
        muscle_group: primaryMuscleTouched ? primaryMuscle : undefined,
        injuries: (injuries ?? []).filter(Boolean),
      });
      const result = (res.results ?? [])[0];
      if (!result) {
        Alert.alert('Nothing found', 'AI could not fill this exercise yet.');
        return;
      }
      applyAiResult(result);
    } catch (e: any) {
      Alert.alert('AI Fill failed', e?.message ?? 'Could not reach the AI server.');
    } finally {
      setAiFilling(false);
    }
  };

  const handleSave = async () => {
    const trimmedName = name.trim();
    const trimmedEquipment = currentEquipmentParts.join(', ');
    if (!trimmedName) {
      Alert.alert('Exercise name needed', 'Add a name for this exercise.');
      return;
    }
    if (!trimmedEquipment) {
      Alert.alert('Equipment needed', 'Add the machine or equipment this uses.');
      return;
    }
    const parsedSets = Number(sets);
    const parsedRest = Number(restSeconds);
    setSaving(true);
    try {
      const created = createManualCustomExercise({
        name: trimmedName,
        equipment: trimmedEquipment,
        primaryMuscle,
        secondaryMuscles,
        sets: Number.isFinite(parsedSets) ? parsedSets : 3,
        reps,
        restSeconds: Number.isFinite(parsedRest) ? parsedRest : 60,
        defaultTrackingMode: trackingMode,
        isCompound,
        movementPattern,
        programmingTags,
        description,
        formCues,
        aliases,
        imageUrl,
        videoId,
        demoExerciseDbId,
        source: aiEnriched ? 'ai' : (initialExercise?.source ?? 'manual'),
        planEligible: aiEnriched ? true : initialExercise?.plan_eligible,
        aiConfidence: aiEnriched ? (initialExercise?.ai_confidence ?? 'medium') : (initialExercise?.ai_confidence ?? 'user_confirmed'),
        validationStatus: aiEnriched ? (initialExercise?.validation_status ?? 'planner_ready') : (initialExercise?.validation_status ?? 'needs_review'),
      });
      await onSave(isEditing ? {
        ...created,
        id: initialExercise.id,
        server_id: initialExercise.server_id,
        createdAt: initialExercise.createdAt,
        updatedAt: new Date().toISOString(),
      } : created);
      onClose();
    } catch (e: any) {
      Alert.alert('Could not save', e?.message ?? 'Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={[styles.wrap, { backgroundColor: tc.background }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.header, { borderBottomColor: tc.border }]}>
          <TouchableOpacity onPress={onClose} disabled={saving}>
            <Text style={[styles.headerAction, { color: tc.textSecondary }]}>Cancel</Text>
          </TouchableOpacity>
          <Text style={[styles.title, { color: tc.textPrimary }]}>{title}</Text>
          <TouchableOpacity onPress={handleSave} disabled={saving}>
            <Text style={[styles.headerAction, { color: saving ? tc.textMuted : tc.primary, fontWeight: '800' }]}>
              Save
            </Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>
          <ImageBackground
            source={CUSTOM_EXERCISE_HEADER_IMAGE}
            style={styles.hero}
            imageStyle={styles.heroImage}
            resizeMode="cover">
            <View style={styles.heroOverlay} />
            <View style={styles.heroContent}>
              <View style={styles.heroTopRow}>
                <View style={styles.heroIconBubble}>
                  <Ionicons name={trackingMode === 'time' ? 'timer-outline' : 'barbell-outline'} size={19} color="#FFFFFF" />
                </View>
                {aiEnriched ? (
                  <View style={styles.heroPill}>
                    <Ionicons name="sparkles-outline" size={12} color="#FFFFFF" />
                    <Text style={styles.heroPillText}>AI FILLED</Text>
                  </View>
                ) : null}
              </View>
              <View>
                <Text style={styles.heroTitle} numberOfLines={2}>{headerTitle}</Text>
                <Text style={styles.heroSubtitle} numberOfLines={1}>{headerSubtitle}</Text>
              </View>
            </View>
          </ImageBackground>

          <View style={styles.field}>
            <Text style={[styles.label, { color: tc.textMuted }]}>Name</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Hammer Strength Incline Press"
              placeholderTextColor={tc.textMuted}
              style={[styles.input, { backgroundColor: tc.surface, borderColor: tc.border, color: tc.textPrimary }]}
              autoCapitalize="words"
              returnKeyType="next"
            />
          </View>

          <View style={styles.field}>
            <Text style={[styles.label, { color: tc.textMuted }]}>Equipment</Text>
            <TextInput
              value={equipmentQuery}
              onChangeText={handleEquipmentQueryChange}
              onSubmitEditing={commitEquipmentQuery}
              onBlur={commitEquipmentQuery}
              placeholder={selectedEquipment.length > 0 ? 'Add another' : 'Dumbbells, bench'}
              placeholderTextColor={tc.textMuted}
              style={[styles.input, { backgroundColor: tc.surface, borderColor: tc.border, color: tc.textPrimary }]}
              autoCapitalize="words"
              returnKeyType="done"
            />
            {selectedEquipment.length > 0 ? (
              <View style={styles.selectedEquipmentGrid}>
                {selectedEquipment.map(option => (
                  <TouchableOpacity
                    key={option}
                    onPress={() => removeSelectedEquipment(option)}
                    activeOpacity={0.75}
                    style={[styles.selectedEquipmentChip, { backgroundColor: tc.primary + '1F', borderColor: tc.primary + '66' }]}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${option}`}>
                    <Text style={[styles.selectedEquipmentText, { color: tc.primary }]} numberOfLines={1}>
                      {humanizeToken(option)}
                    </Text>
                    <Ionicons name="close" size={13} color={tc.primary} />
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}
            {filteredEquipmentChoices.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.equipmentChipRow}>
                {filteredEquipmentChoices.map(option => (
                  <TouchableOpacity
                    key={option}
                    onPress={() => addEquipmentOption(option)}
                    style={[
                      styles.equipmentChip,
                      { borderColor: tc.border, backgroundColor: tc.surface },
                    ]}>
                    <Text style={[styles.equipmentChipText, { color: tc.textSecondary }]}>
                      {humanizeToken(option)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            ) : null}
          </View>

          {authToken ? (
            <TouchableOpacity
              onPress={handleAiFill}
              disabled={aiFilling || saving}
              activeOpacity={0.8}
              style={[
                styles.aiFillButton,
                {
                  backgroundColor: tc.primary + '14',
                  borderColor: tc.primary + '66',
                  opacity: aiFilling || saving ? 0.65 : 1,
                },
              ]}>
              {aiFilling ? (
                <ActivityIndicator size="small" color={tc.primary} />
              ) : (
                <Ionicons name="sparkles-outline" size={17} color={tc.primary} />
              )}
              <Text style={[styles.aiFillText, { color: tc.primary }]}>
                {aiFilling ? 'Filling...' : 'AI Fill'}
              </Text>
            </TouchableOpacity>
          ) : null}

          <View style={styles.field}>
            <Text style={[styles.label, { color: tc.textMuted }]}>Muscles</Text>
            <View style={[styles.wheelRow, { backgroundColor: tc.surface, borderColor: tc.border }]}>
              <View style={styles.wheelCell}>
                <NumberWheelPicker
                  label="Primary"
                  labelColor={tc.textMuted}
                  selectedColor={tc.textPrimary}
                  mutedColor={tc.textMuted}
                  dividerColor={tc.border}
                  values={muscleOptions}
                  value={muscleOptions.includes(primaryMuscle as any) ? primaryMuscle : 'chest'}
                  onChange={value => {
                    const next = String(value);
                    setPrimaryMuscle(next);
                    setPrimaryMuscleTouched(true);
                    setSecondaryMuscles(prev => prev.filter(muscle => muscle !== next).slice(0, 1));
                  }}
                  formatLabel={value => humanizeToken(value)}
                  testID="custom-exercise-primary-muscle-wheel"
                />
              </View>
              <View style={[styles.wheelDivider, { backgroundColor: tc.border }]} />
              <View style={styles.wheelCell}>
                <NumberWheelPicker
                  label="Secondary"
                  labelColor={tc.textMuted}
                  selectedColor={tc.textPrimary}
                  mutedColor={tc.textMuted}
                  dividerColor={tc.border}
                  values={secondaryMuscleOptions}
                  value={secondaryMuscleValue}
                  onChange={value => setSecondaryMuscles(value === NO_SECONDARY_MUSCLE ? [] : [String(value)])}
                  formatLabel={value => value === NO_SECONDARY_MUSCLE ? 'None' : humanizeToken(value)}
                  testID="custom-exercise-secondary-muscle-wheel"
                />
              </View>
            </View>
          </View>

          <View style={styles.field}>
            <Text style={[styles.label, { color: tc.textMuted }]}>Tracking</Text>
            <View style={styles.typeRow}>
              {[
                { label: 'Reps', value: 'reps' as const, icon: 'repeat-outline' as const },
                { label: 'Timed', value: 'time' as const, icon: 'timer-outline' as const },
              ].map(opt => {
                const active = trackingMode === opt.value;
                return (
                  <TouchableOpacity
                    key={opt.value}
                    onPress={() => handleTrackingModeChange(opt.value)}
                    style={[
                      styles.typeButton,
                      { backgroundColor: active ? tc.primary + '1F' : tc.surface, borderColor: active ? tc.primary : tc.border },
                    ]}>
                    <Ionicons name={opt.icon} size={16} color={active ? tc.primary : tc.textMuted} />
                    <Text style={[styles.typeText, { color: active ? tc.primary : tc.textPrimary }]}>{opt.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={[styles.wheelRow, { backgroundColor: tc.surface, borderColor: tc.border }]}>
            <View style={styles.wheelCell}>
              <NumberWheelPicker
                label="Sets"
                labelColor={tc.textMuted}
                selectedColor={tc.textPrimary}
                mutedColor={tc.textMuted}
                dividerColor={tc.border}
                values={CUSTOM_EXERCISE_SETS_VALUES}
                value={snapToNearest(CUSTOM_EXERCISE_SETS_VALUES, Math.max(1, Math.min(10, numberOrFallback(sets, 3))))}
                onChange={value => setSets(String(value))}
                testID="custom-exercise-sets-wheel"
              />
            </View>
            <View style={[styles.wheelDivider, { backgroundColor: tc.border }]} />
            <View style={styles.wheelCell}>
              <NumberWheelPicker
                label={trackingMode === 'time' ? 'Duration' : 'Reps'}
                labelColor={tc.textMuted}
                selectedColor={tc.textPrimary}
                mutedColor={tc.textMuted}
                dividerColor={tc.border}
                values={targetWheelValues}
                value={targetWheelValue}
                onChange={value => setReps(String(value))}
                testID={trackingMode === 'time' ? 'custom-exercise-time-wheel' : 'custom-exercise-reps-wheel'}
              />
            </View>
            <View style={[styles.wheelDivider, { backgroundColor: tc.border }]} />
            <View style={styles.wheelCell}>
              <NumberWheelPicker
                label="Rest"
                labelColor={tc.textMuted}
                selectedColor={tc.textPrimary}
                mutedColor={tc.textMuted}
                dividerColor={tc.border}
                values={CUSTOM_EXERCISE_REST_VALUES}
                value={snapToNearest(CUSTOM_EXERCISE_REST_VALUES, Math.max(0, numberOrFallback(restSeconds, 60)))}
                onChange={value => setRestSeconds(String(value))}
                formatLabel={value => formatRest(value as number)}
                testID="custom-exercise-rest-wheel"
              />
            </View>
          </View>

          <TouchableOpacity
            onPress={() => setShowAdvanced(prev => !prev)}
            activeOpacity={0.75}
            style={[styles.advancedToggle, { backgroundColor: tc.surface, borderColor: tc.border }]}>
            <View>
              <Text style={[styles.advancedTitle, { color: tc.textPrimary }]}>Advanced</Text>
              <Text style={[styles.advancedSubtitle, { color: tc.textMuted }]}>Type, tags, notes</Text>
            </View>
            <Ionicons name={showAdvanced ? 'chevron-up' : 'chevron-down'} size={18} color={tc.textMuted} />
          </TouchableOpacity>

          {showAdvanced ? (
            <>
              <View style={styles.field}>
                <Text style={[styles.label, { color: tc.textMuted }]}>Type</Text>
                <View style={styles.typeRow}>
                  {[
                    { label: 'Compound', value: true, icon: 'barbell-outline' as const },
                    { label: 'Isolation', value: false, icon: 'ellipse-outline' as const },
                  ].map(opt => {
                    const active = isCompound === opt.value;
                    return (
                      <TouchableOpacity
                        key={opt.label}
                        onPress={() => setIsCompound(prev => prev === opt.value ? null : opt.value)}
                        style={[
                          styles.typeButton,
                          { backgroundColor: active ? tc.primary + '1F' : tc.surface, borderColor: active ? tc.primary : tc.border },
                        ]}>
                        <Ionicons name={opt.icon} size={16} color={active ? tc.primary : tc.textMuted} />
                        <Text style={[styles.typeText, { color: active ? tc.primary : tc.textPrimary }]}>{opt.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              <View style={styles.field}>
                <Text style={[styles.label, { color: tc.textMuted }]}>Tags</Text>
                <View style={styles.chipGrid}>
                  {CUSTOM_EXERCISE_PROGRAMMING_TAGS.map(tag => {
                    const active = programmingTags.includes(tag);
                    return (
                      <TouchableOpacity
                        key={tag}
                        onPress={() => toggleProgrammingTag(tag)}
                        style={[
                          styles.chip,
                          { borderColor: active ? tc.primary : tc.border, backgroundColor: active ? tc.primary + '22' : tc.surface },
                        ]}>
                        <Text style={[styles.chipText, { color: active ? tc.primary : tc.textSecondary }]}>
                          {customExerciseTagLabel(tag)}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              <View style={styles.field}>
                <Text style={[styles.label, { color: tc.textMuted }]}>Notes</Text>
                <TextInput
                  value={description}
                  onChangeText={setDescription}
                  placeholder="Setup notes, machine adjustments, or anything to remember"
                  placeholderTextColor={tc.textMuted}
                  style={[styles.input, styles.multilineInput, { backgroundColor: tc.surface, borderColor: tc.border, color: tc.textPrimary }]}
                  multiline
                  textAlignVertical="top"
                />
              </View>
            </>
          ) : null}

          <TouchableOpacity
            onPress={handleSave}
            disabled={saving}
            activeOpacity={0.8}
            style={[styles.saveButton, { backgroundColor: tc.primary, opacity: saving ? 0.65 : 1 }]}>
            <Text style={[styles.saveButtonText, { color: getContrastingTextColor(tc.primary) }]}>
              {saving ? 'Saving...' : saveLabel}
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  header: {
    minHeight: 56,
    borderBottomWidth: 1,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerAction: { fontSize: 15, fontWeight: '700' },
  title: { fontSize: 17, fontWeight: '800' },
  content: { padding: 16, paddingBottom: 34, gap: 16 },
  hero: {
    minHeight: 142,
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: '#111827',
  },
  heroImage: { borderRadius: radius.sm },
  heroOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.46)' },
  heroContent: {
    minHeight: 142,
    padding: 14,
    justifyContent: 'space-between',
  },
  heroTopRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  heroIconBubble: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.17)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.27)',
  },
  heroPill: {
    minHeight: 25,
    borderRadius: radius.sm,
    paddingHorizontal: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  heroPillText: { fontSize: 10, fontWeight: '900', color: '#FFFFFF', letterSpacing: 0 },
  heroTitle: { fontSize: 22, lineHeight: 26, fontWeight: '900', color: '#FFFFFF' },
  heroSubtitle: { marginTop: 4, fontSize: 12, fontWeight: '800', color: 'rgba(255,255,255,0.78)' },
  field: { gap: 7 },
  label: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0 },
  input: {
    borderWidth: 1,
    borderRadius: radius.sm,
    minHeight: 46,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  multilineInput: {
    minHeight: 78,
    paddingTop: 11,
    paddingBottom: 11,
  },
  equipmentChipRow: {
    gap: 8,
    paddingTop: 2,
    paddingRight: 8,
  },
  selectedEquipmentGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  selectedEquipmentChip: {
    maxWidth: '100%',
    minHeight: 32,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 9,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  selectedEquipmentText: { flexShrink: 1, fontSize: 12, fontWeight: '900' },
  equipmentChip: {
    minHeight: 34,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 7,
    justifyContent: 'center',
  },
  equipmentChipText: { fontSize: 12, fontWeight: '800' },
  chipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  chipText: { fontSize: 12, fontWeight: '800' },
  aiFillButton: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: radius.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
  },
  aiFillText: { fontSize: 13, fontWeight: '900' },
  cueChip: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  cueText: { fontSize: 12, fontWeight: '700' },
  typeRow: { flexDirection: 'row', gap: 10 },
  typeButton: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: radius.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
  },
  typeText: { fontSize: 13, fontWeight: '800' },
  wheelRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingVertical: 6,
  },
  wheelCell: { flex: 1, paddingHorizontal: 4 },
  wheelDivider: { width: 1, marginVertical: 6 },
  advancedToggle: {
    minHeight: 52,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  advancedTitle: { fontSize: 14, fontWeight: '900' },
  advancedSubtitle: { marginTop: 2, fontSize: 11, fontWeight: '700' },
  saveButton: {
    minHeight: 48,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  saveButtonText: { fontSize: 15, fontWeight: '900' },
});
