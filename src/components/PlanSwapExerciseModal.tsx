// Plan-view exercise swap modal. Mirrors the Active Workout swap picker —
// uses the shared scoreSwapCandidate ranking so overlap percentages match
// exactly between live workouts and plan edits.
//
// Opens from the "Swap" chip on each WorkoutCard exercise row. On select,
// the parent receives (newExerciseName, newEquipment) and persists to
// the plan (AsyncStorage + backend).

import { useEffect, useMemo, useState } from 'react';
import { View, Text, Modal, TouchableOpacity, ScrollView, Platform, Alert, ActivityIndicator, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import type { CustomExerciseItem } from '../types';
import { analyzeExercisePhoto, type AIExerciseResult } from '../services/api';
import { exerciseEquipmentLabel, isExerciseUsableWithEquipment, rankSwapCandidates, ExerciseLibraryItem } from '../utils/swapScoring';
import { matchesExerciseSearch } from '../utils/exerciseSearch';
import { exerciseThumbSmall } from '../utils/exerciseThumb';
import { customExerciseFromAiResult, customExerciseToLibraryItem, normalizeExerciseNameKey } from '../utils/customExercises';
import ExerciseThumbMedia, { hasExerciseThumbMedia } from './ExerciseThumbMedia';
import CustomExerciseModal from './CustomExerciseModal';

interface Props {
  visible: boolean;
  baseExerciseName: string | null;
  baseExercise?: ExerciseLibraryItem | null;
  library: ExerciseLibraryItem[];
  ownedEquipment?: string[];
  themeName?: AppThemeName;
  authToken?: string | null;
  injuries?: string[];
  blockedExerciseNames?: string[];
  onClose: () => void;
  onSelect: (next: ExerciseLibraryItem) => void;
  onPreview?: (next: ExerciseLibraryItem) => void;
  onCreateCustomExercise?: (exercise: CustomExerciseItem) => void | Promise<void>;
}

function planExerciseNameKey(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export default function PlanSwapExerciseModal({
  visible, baseExerciseName, baseExercise, library, ownedEquipment, themeName, authToken, injuries, blockedExerciseNames, onClose, onSelect, onPreview, onCreateCustomExercise,
}: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const onPrimary = getContrastingTextColor(tc.primary);
  const [customExerciseOpen, setCustomExerciseOpen] = useState(false);
  const [photoScanLoading, setPhotoScanLoading] = useState(false);
  const [photoScanResults, setPhotoScanResults] = useState<Array<AIExerciseResult & { match_source?: 'library' | 'ai' }>>([]);
  const [identifiedEquipment, setIdentifiedEquipment] = useState<string | null>(null);
  // Empty query → ranked best matches (default behavior). Non-empty → search
  // the FULL library by name/muscle/equipment so the user can find any exercise.
  const [searchQuery, setSearchQuery] = useState('');
  const blockedNameSet = useMemo(
    () => new Set((blockedExerciseNames ?? []).map(planExerciseNameKey).filter(Boolean)),
    [blockedExerciseNames],
  );

  const base = useMemo<ExerciseLibraryItem | null>(() => {
    const rawName = baseExercise?.name ?? baseExerciseName;
    if (!rawName) return null;
    const target = planExerciseNameKey(rawName);
    const cleanText = (value?: string | null) => {
      const trimmed = String(value ?? '').trim();
      return trimmed.length > 0 ? trimmed : undefined;
    };
    const cleanList = (value?: string[] | null) => Array.isArray(value) && value.length > 0 ? value : undefined;
    const mergeBase = (libraryRow?: ExerciseLibraryItem | null): ExerciseLibraryItem => ({
      ...(libraryRow ?? {}),
      ...(baseExercise ?? {}),
      name: libraryRow?.name ?? baseExercise?.name ?? baseExerciseName ?? rawName,
      primary_muscle: cleanText(baseExercise?.primary_muscle) ?? cleanText(libraryRow?.primary_muscle) ?? '',
      secondary_muscles: cleanList(baseExercise?.secondary_muscles) ?? cleanList(libraryRow?.secondary_muscles) ?? [],
      equipment: cleanText(baseExercise?.equipment) ?? cleanText(libraryRow?.equipment) ?? '',
      gear: baseExercise?.gear ?? libraryRow?.gear ?? null,
      movement_pattern: cleanText(baseExercise?.movement_pattern) ?? cleanText(libraryRow?.movement_pattern) ?? null,
      is_compound: baseExercise?.is_compound ?? libraryRow?.is_compound ?? null,
      description: cleanText(baseExercise?.description) ?? cleanText(libraryRow?.description) ?? '',
    });
    // Exact match → fallback to substring → fallback to the plan row metadata.
    const exact = library.find(e => planExerciseNameKey(e.name) === target);
    if (exact) return mergeBase(exact);
    const contains = library.find(
      e => planExerciseNameKey(e.name).includes(target) || target.includes(planExerciseNameKey(e.name)),
    );
    if (contains) return mergeBase(contains);
    return mergeBase(null);
  }, [baseExercise, baseExerciseName, library]);

  const candidates = useMemo(() => {
    if (!base || library.length === 0) return [];
    const candidateLibrary = library.filter(item => !blockedNameSet.has(planExerciseNameKey(item.name)));
    const ranked = rankSwapCandidates(base, candidateLibrary, ownedEquipment, 10);
    if (ranked.length > 0 || base.primary_muscle) return ranked;
    const baseName = planExerciseNameKey(base.name);
    return candidateLibrary
      .filter(item => planExerciseNameKey(item.name) !== baseName)
      .filter(item => isExerciseUsableWithEquipment(item, ownedEquipment))
      .slice(0, 10)
      .map(item => ({ ...item, _overlap: 0 }));
  }, [base, blockedNameSet, library, ownedEquipment]);

  useEffect(() => {
    if (visible) return;
    setPhotoScanLoading(false);
    setPhotoScanResults([]);
    setIdentifiedEquipment(null);
    setCustomExerciseOpen(false);
    setSearchQuery('');
  }, [visible]);

  // Active search → full-library matches by name / muscle / equipment, ignoring
  // the equipment-owned filter so users can find any exercise. Empty query
  // falls back to the ranked `candidates` (best matches by overlap).
  const searchResults = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) return null;
    const baseName = base ? planExerciseNameKey(base.name) : null;
    return library
      .filter(item => !blockedNameSet.has(planExerciseNameKey(item.name)))
      .filter(item => !baseName || planExerciseNameKey(item.name) !== baseName)
      .filter(item => matchesExerciseSearch(item, q))
      .map(item => ({ ...item, _overlap: 0 }));
  }, [searchQuery, library, blockedNameSet, base]);

  const customExerciseEquipmentOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (value: unknown) => {
      const text = String(value ?? '').trim();
      if (!text) return;
      const key = text.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
      if (seen.has(key)) return;
      seen.add(key);
      out.push(text);
    };
    (ownedEquipment ?? []).forEach(add);
    library.forEach(item => {
      add(item.equipment);
      (item.gear ?? []).forEach(gear => add(gear.name || gear.slug));
    });
    return out.sort((a, b) => a.localeCompare(b));
  }, [library, ownedEquipment]);

  const overlapColor = (pct: number) => {
    if (pct >= 80) return tc.success;
    if (pct >= 60) return tc.warning;
    return tc.error;
  };

  const handleCreateCustomExercise = async (custom: CustomExerciseItem) => {
    await onCreateCustomExercise?.(custom);
    onSelect(customExerciseToLibraryItem(custom) as ExerciseLibraryItem);
    onClose();
  };

  const handleSelectScannedExercise = async (ex: AIExerciseResult) => {
    if (blockedNameSet.has(planExerciseNameKey(ex.name))) {
      Alert.alert('Already in workout', `${ex.name} is already done or scheduled in this workout.`);
      return;
    }
    const key = normalizeExerciseNameKey(ex.name);
    const existing = library.find(item => normalizeExerciseNameKey(item.name) === key);
    if (existing) {
      onSelect(existing);
      onClose();
      return;
    }
    const custom = customExerciseFromAiResult(ex, `custom_${Date.now()}`);
    await onCreateCustomExercise?.(custom);
    onSelect(customExerciseToLibraryItem(custom) as ExerciseLibraryItem);
    onClose();
  };

  const handlePhotoExerciseScan = async (source: 'camera' | 'library') => {
    if (!authToken || photoScanLoading) return;
    setPhotoScanLoading(true);
    try {
      const ImagePicker = await import('expo-image-picker');
      const permission = source === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          source === 'camera' ? 'Camera access needed' : 'Photo access needed',
          source === 'camera'
            ? 'Allow camera access to scan gym equipment.'
            : 'Allow photo access to scan gym equipment.',
        );
        return;
      }
      const result = source === 'camera'
        ? await ImagePicker.launchCameraAsync({ base64: true, quality: 0.6, mediaTypes: 'images', exif: false, allowsEditing: false } as any)
        : await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.55, mediaTypes: 'images', exif: false, allowsEditing: false } as any);
      if (result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset?.base64) {
        Alert.alert('Could not read photo', 'Try another machine photo.');
        return;
      }
      const rawMime = String((asset as any).mimeType || '').toLowerCase();
      const mime = rawMime === 'image/png' || rawMime === 'image/webp' ? rawMime : 'image/jpeg';
      const res = await analyzeExercisePhoto(authToken, {
        image_base64: asset.base64,
        mime_type: mime,
        library_names: Array.from(new Set(library.map(item => item.name).filter(Boolean))),
        equipment: ownedEquipment,
        injuries,
      });
      const rawResults = res.results ?? [];
      const results = rawResults.filter(ex => !blockedNameSet.has(planExerciseNameKey(ex.name)));
      const equipmentName = String(res.equipment_identified ?? '').trim();
      setIdentifiedEquipment(equipmentName || null);
      setPhotoScanResults(results);
      if (results.length === 0) {
        Alert.alert(
          equipmentName ? 'No exercises returned' : 'No equipment identified',
          rawResults.length > 0
            ? 'All returned exercises are already in this workout.'
            : equipmentName
            ? `I found ${equipmentName}, but not enough exercise detail came back. Try a clearer photo.`
            : 'Try a closer photo of the machine, cable stack, or rack.',
        );
      }
    } catch (e: any) {
      Alert.alert('Photo scan failed', e?.message ?? 'Could not scan that photo.');
    } finally {
      setPhotoScanLoading(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: tc.background }}>
        <View style={{
          flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16,
          paddingTop: Platform.OS === 'ios' ? 8 : 24, paddingBottom: 12,
          borderBottomWidth: 1, borderBottomColor: tc.border,
        }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11, color: tc.textMuted, fontWeight: '700', letterSpacing: 0.5 }}>SWAP</Text>
            <Text style={{ fontSize: 17, fontWeight: '800', color: tc.textPrimary }} numberOfLines={1}>
              {baseExerciseName ?? 'Exercise'}
            </Text>
          </View>
          {authToken ? (
            <TouchableOpacity
              onPress={() => {
                Alert.alert(
                  'Scan equipment',
                  'Take a photo of a machine or rack and choose a swap it supports.',
                  [
                    { text: 'Camera', onPress: () => handlePhotoExerciseScan('camera') },
                    { text: 'Photo Library', onPress: () => handlePhotoExerciseScan('library') },
                    { text: 'Cancel', style: 'cancel' },
                  ],
                );
              }}
              disabled={photoScanLoading}
              accessibilityRole="button"
              accessibilityLabel="Scan equipment for swap"
              style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginRight: 6, opacity: photoScanLoading ? 0.65 : 1 }}>
              {photoScanLoading
                ? <ActivityIndicator size="small" color={tc.primary} />
                : <Ionicons name="camera-outline" size={20} color={tc.textSecondary} />}
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            onPress={() => setCustomExerciseOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Add custom swap"
            style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginRight: 6 }}>
            <Ionicons name="create-outline" size={20} color={tc.primary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Ionicons name="close" size={24} color={tc.textPrimary} />
          </TouchableOpacity>
        </View>

        <View style={{ paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 }}>
          <View style={{
            flexDirection: 'row', alignItems: 'center', gap: 8,
            backgroundColor: tc.surface, borderRadius: radius.sm,
            borderWidth: 1, borderColor: tc.border,
            paddingHorizontal: 10, paddingVertical: Platform.OS === 'ios' ? 8 : 4,
          }}>
            <Ionicons name="search" size={16} color={tc.textMuted} />
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search all exercises"
              placeholderTextColor={tc.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              accessibilityLabel="Search all exercises"
              style={{ flex: 1, fontSize: 14, color: tc.textPrimary, paddingVertical: 0 }}
            />
            {searchQuery.length > 0 ? (
              <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close-circle" size={16} color={tc.textMuted} />
              </TouchableOpacity>
            ) : null}
          </View>
        </View>

        {library.length === 0 && photoScanResults.length === 0 && !photoScanLoading ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20, gap: 10 }}>
            <Text style={{ fontSize: 13, color: tc.textMuted, textAlign: 'center' }}>
              Loading exercise library…
            </Text>
          </View>
        ) : (searchResults ?? candidates).length === 0 && photoScanResults.length === 0 && !photoScanLoading ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20, gap: 10 }}>
            <Text style={{ fontSize: 13, color: tc.textMuted, textAlign: 'center' }}>
              {searchResults
                ? `No matches for "${searchQuery.trim()}".`
                : 'No suitable alternatives found with your current equipment.'}
            </Text>
            <TouchableOpacity
              onPress={() => setCustomExerciseOpen(true)}
              style={{ borderRadius: radius.sm, paddingVertical: 10, paddingHorizontal: 14, backgroundColor: tc.primary + '14', borderWidth: 1, borderColor: tc.primary + '66' }}>
              <Text style={{ color: tc.primary, fontSize: 13, fontWeight: '800' }}>Add Custom Swap</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 12, gap: 8 }}>
            {photoScanLoading && photoScanResults.length === 0 ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 }}>
                <ActivityIndicator size="small" color={tc.primary} />
                <Text style={{ fontSize: 12, color: tc.textMuted }}>Scanning equipment...</Text>
              </View>
            ) : null}
            {photoScanResults.length > 0 ? (
              <View style={{ gap: 8, marginBottom: 8 }}>
                <Text style={{ fontSize: 11, color: tc.textMuted, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  {identifiedEquipment ? `Exercises for ${identifiedEquipment}` : 'Photo Results'}
                </Text>
                {photoScanResults.map((ex, i) => (
                  <View
                    key={`photo-swap-${ex.name}-${i}`}
                    style={{
                      gap: 8,
                      padding: 12,
                      borderRadius: radius.md,
                      backgroundColor: tc.surface,
                      borderWidth: 1.5,
                      borderColor: tc.primary + '66',
                    }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }} numberOfLines={1}>
                          {ex.name}
                        </Text>
                        <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }} numberOfLines={1}>
                          {[ex.primary_muscle, ex.equipment, `${ex.sets}x${ex.reps}`].filter(Boolean).join(' · ')}
                        </Text>
                      </View>
                      {ex.match_source === 'library' ? (
                        <View style={{ borderRadius: 6, backgroundColor: tc.primary + '14', paddingHorizontal: 7, paddingVertical: 3 }}>
                          <Text style={{ fontSize: 9, fontWeight: '800', color: tc.primary }}>SAVED</Text>
                        </View>
                      ) : null}
                    </View>
                    {ex.why ? (
                      <Text style={{ fontSize: 11, lineHeight: 15, color: tc.textMuted }}>{ex.why}</Text>
                    ) : null}
                    <TouchableOpacity
                      activeOpacity={0.82}
                      onPress={() => handleSelectScannedExercise(ex)}
                      accessibilityRole="button"
                      accessibilityLabel={`Swap to scanned exercise ${ex.name}`}
                      style={{ borderRadius: radius.sm, backgroundColor: tc.primary, paddingVertical: 10, alignItems: 'center' }}>
                      <Text style={{ color: onPrimary, fontSize: 13, fontWeight: '800' }}>Swap to This</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            ) : null}
            {(searchResults ?? candidates).length > 0 ? (
              <Text style={{ fontSize: 11, color: tc.textMuted, marginBottom: 6 }}>
                {searchResults
                  ? `${searchResults.length} match${searchResults.length === 1 ? '' : 'es'} in library.`
                  : 'Ranked by muscle + movement pattern overlap.'}
              </Text>
            ) : null}
            {(searchResults ?? candidates).map(c => {
              const thumbSrc = exerciseThumbSmall(c as any);
              const demoExerciseDbId = (c as any).demo_exercise_db_id ?? null;
              const hasThumb = hasExerciseThumbMedia({
                exerciseName: c.name,
                demoExerciseDbId,
                fallbackSource: thumbSrc,
                authToken,
                allowHostedFallback: true,
              });
              const equipment = exerciseEquipmentLabel(c, ownedEquipment);
              return (
              <View
                key={c.name}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 10,
                  padding: 12, borderRadius: radius.md,
                  backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                }}
              >
                {onPreview ? (
                  <TouchableOpacity
                    activeOpacity={0.85}
                    onPress={() => onPreview(c)}
                    accessibilityRole="button"
                    accessibilityLabel={`Preview ${c.name} form video`}
                    style={{
                      width: 52,
                      height: 52,
                      borderRadius: 12,
                      overflow: 'hidden',
                      backgroundColor: tc.surfaceRaised,
                      borderWidth: 1,
                      borderColor: tc.border,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {hasThumb ? (
                      <ExerciseThumbMedia
                        exerciseName={c.name}
                        demoExerciseDbId={demoExerciseDbId}
                        fallbackSource={thumbSrc}
                        authToken={authToken}
                        equipment={exerciseEquipmentLabel(c, ownedEquipment) ?? c.equipment ?? null}
                        primaryMuscle={c.primary_muscle ?? null}
                        movementPattern={(c as any).movement_pattern ?? null}
                        style={{ width: '100%', height: '100%' }}
                        shouldPlayVideo={false}
                        placeholder={(
                          <View style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
                            <Ionicons name="videocam-outline" size={19} color={tc.textMuted} />
                          </View>
                        )}
                      />
                    ) : (
                      <Ionicons name="videocam-outline" size={19} color={tc.textMuted} />
                    )}
                    <View
                      pointerEvents="none"
                      style={{
                        position: 'absolute',
                        width: 22,
                        height: 22,
                        borderRadius: 11,
                        backgroundColor: 'rgba(0,0,0,0.62)',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Ionicons name="play" size={11} color="#fff" style={{ marginLeft: 1 }} />
                    </View>
                  </TouchableOpacity>
                ) : null}

                <TouchableOpacity
                  activeOpacity={0.8}
                  onPress={() => { onSelect(c); onClose(); }}
                  accessibilityRole="button"
                  accessibilityLabel={`Swap to ${c.name}, ${c._overlap}% overlap`}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }} numberOfLines={1}>
                    {c.name}
                  </Text>
                  <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }} numberOfLines={1}>
                    {c.primary_muscle}{equipment ? ` · ${equipment}` : ''}
                  </Text>
                </TouchableOpacity>
                {searchResults ? null : (
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ fontSize: 16, fontWeight: '900', color: overlapColor(c._overlap) }}>
                      {c._overlap}%
                    </Text>
                    <Text style={{ fontSize: 9, color: tc.textMuted, fontWeight: '700', letterSpacing: 0.5 }}>
                      OVERLAP
                    </Text>
                  </View>
                )}
                <TouchableOpacity
                  activeOpacity={0.8}
                  onPress={() => { onSelect(c); onClose(); }}
                  accessibilityRole="button"
                  accessibilityLabel={`Confirm swap to ${c.name}`}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="swap-horizontal" size={20} color={tc.primary} />
                </TouchableOpacity>
              </View>
            );
            })}
          </ScrollView>
        )}
      </View>
      <CustomExerciseModal
        visible={customExerciseOpen}
        themeName={themeName}
        title="Custom Swap"
        saveLabel="Save and Swap"
        authToken={authToken}
        availableEquipment={ownedEquipment}
        equipmentOptions={customExerciseEquipmentOptions}
        injuries={injuries}
        onClose={() => setCustomExerciseOpen(false)}
        onSave={handleCreateCustomExercise}
      />
    </Modal>
  );
}
