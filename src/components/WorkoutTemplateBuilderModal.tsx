/**
 * Workout Template Builder.
 *
 * Lets the user compose a saved workout template ahead of time — pick
 * exercises from the library, configure sets/reps/rest, save with a name.
 * Distinct from the "Save as Template" button on the active workout
 * summary, which only fires after completing a session. This flow is the
 * "I want to design a workout I'll use later" path most users expect.
 *
 * Templates persist via `upsertWorkoutTemplate` (AsyncStorage), respecting
 * the free-tier template cap defense-in-depth.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, TextInput, ScrollView,
  StyleSheet, ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import { AppThemeName, SavedWorkoutTemplate, WorkoutDay, Exercise } from '../types';
import type { CustomExerciseItem } from '../types';
import { upsertWorkoutTemplate } from '../utils/workoutHistory';
import { analyzeExercisePhoto, parseWorkoutFile, parseWorkoutPhotos, type AIExerciseResult } from '../services/api';
import { isTimeBasedReps, shouldHideReps } from '../utils/exerciseDisplay';
import { matchesExerciseSearch } from '../utils/exerciseSearch';
import { estimateWorkoutMinutes } from '../utils/workoutDurationEstimate';
import { customExerciseFromAiResult, customExerciseToLibraryItem, normalizeExerciseNameKey } from '../utils/customExercises';
import NumberWheelPicker from './NumberWheelPicker';
import CustomExerciseModal from './CustomExerciseModal';

// Wheel option lists. Sets/Rest are pure numerics. REPS uses common
// rep schemes (single values + ranges) so the picker maps 1:1 onto
// the string format the planner expects ("8-12", "5", "AMRAP"). TIME
// presets cover the realistic range for templated cardio/conditioning.
const SETS_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const REPS_VALUES = [
  '1', '2', '3', '4', '5', '6', '8', '10', '12', '15', '20', '25',
  '1-3', '3-5', '4-6', '5-8', '6-8', '8-10', '8-12', '10-12', '10-15',
  '12-15', '15-20', '20-25', 'AMRAP',
] as const;
const TIME_VALUES = [
  '30s', '45s', '60s', '90s', '2 min', '3 min', '5 min', '8 min',
  '10 min', '15 min', '20 min', '25 min', '30 min', '40 min', '45 min', '60 min',
] as const;
const REST_VALUES = [0, 15, 30, 45, 60, 75, 90, 105, 120, 150, 180, 210, 240, 300] as const;

function snapToNearest<T extends string | number>(values: readonly T[], target: T): T {
  if (values.includes(target)) return target;
  // For numerics, snap to nearest; for strings, fall back to first.
  if (typeof target === 'number') {
    let best = values[0];
    let bestDelta = Math.abs((best as number) - target);
    for (const v of values) {
      const d = Math.abs((v as number) - target);
      if (d < bestDelta) { best = v; bestDelta = d; }
    }
    return best;
  }
  return values[0];
}

function formatRest(seconds: number): string {
  if (seconds <= 0) return 'None';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

// Estimate the total workout duration for the draft template. Routes
// through the canonical `estimateWorkoutMinutes` so the badge here
// matches the "~N min" the day card shows once the template is assigned.
// Previously this helper rolled its own (30s/set, no rest fudge) which
// undershot the day card's estimate (55s/set, 1.10x rest) by ~30-40%
// on a typical 6-exercise template.
function estimateTemplateMinutes(exercises: DraftExercise[]): number {
  if (exercises.length === 0) return 0;
  return estimateWorkoutMinutes({
    exercises: exercises.map(ex => ({
      name: ex.name,
      sets: ex.sets,
      reps: ex.reps,
      restSeconds: ex.restSeconds,
      primary_muscle: ex.primaryMuscle ?? undefined,
    } as any)),
  }, null);
}

function formatDurationEstimate(minutes: number): string {
  if (minutes <= 0) return '—';
  const m = Math.round(minutes);
  if (m < 60) return `~${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `~${h}h` : `~${h}h ${rem}m`;
}

interface LibraryItem {
  id?: number | string;
  name: string;
  slug?: string | null;
  aliases?: string[] | null;
  primary_muscle?: string | null;
  secondary_muscles?: string[] | null;
  equipment?: string | null;
  gear?: Array<{ slug?: string | null; name?: string | null; category?: string | null }> | null;
  movement_pattern?: string | null;
  exercise_type?: string | null;
  sets?: number;
  reps?: string;
  rest_seconds?: number;
}

type TargetType = 'reps' | 'time';

interface DraftExercise {
  name: string;
  slug?: string | null;
  primaryMuscle?: string | null;
  movementPattern?: string | null;
  exerciseType?: string | null;
  equipment: string;
  targetType: TargetType;
  sets: number;
  reps: string;
  restSeconds: number;
}

const DEFAULT_REP_TARGET = '8-12';
const DEFAULT_TIME_TARGET = '20 min';

function isTimeKind(value: unknown): boolean {
  return /cardio|conditioning|mobility|recovery|stretch|flow/i.test(String(value ?? ''));
}

function shouldUseTimeTarget(ex: Pick<DraftExercise, 'name' | 'equipment' | 'primaryMuscle' | 'movementPattern' | 'exerciseType' | 'reps'>): boolean {
  if (isTimeBasedReps(ex.reps)) return true;
  if (isTimeKind(ex.primaryMuscle) || isTimeKind(ex.movementPattern) || isTimeKind(ex.exerciseType)) return true;
  return shouldHideReps({
    name: ex.name,
    equipment: ex.equipment,
    reps: ex.reps,
    targetReps: ex.reps,
    primaryMuscle: ex.primaryMuscle,
    primary_muscle: ex.primaryMuscle,
  });
}

function targetForMode(targetType: TargetType, current: string): string {
  const trimmed = String(current ?? '').trim();
  if (targetType === 'time') return isTimeBasedReps(trimmed) ? trimmed : DEFAULT_TIME_TARGET;
  return trimmed && !isTimeBasedReps(trimmed) ? trimmed : DEFAULT_REP_TARGET;
}

function durationTargetLabel(seconds: unknown): string | null {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value < 180) return `${Math.round(value)}s`;
  return `${Math.round(value / 60)} min`;
}

interface AiTemplateCandidate {
  name: string;
  exercises: DraftExercise[];
  durationSeconds?: number;
}

function parseRestSeconds(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const text = String(value).trim().toLowerCase();
  if (!text) return null;
  const minutes = text.match(/(\d+(?:\.\d+)?)\s*(?:m|min|minute)/);
  const seconds = text.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|second)/);
  if (minutes || seconds) {
    const total = (minutes ? Number(minutes[1]) * 60 : 0) + (seconds ? Number(seconds[1]) : 0);
    return Number.isFinite(total) ? Math.max(0, Math.round(total)) : null;
  }
  const numeric = Number(text.replace(/[^\d.]/g, ''));
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : null;
}

function draftExerciseFromParsed(ex: any): DraftExercise {
  const sets = Array.isArray(ex?.sets) ? ex.sets : [];
  const firstSet = sets[0] ?? {};
  const importedDuration = durationTargetLabel(
    firstSet?.durationSeconds ?? firstSet?.duration_seconds ?? ex?.durationSeconds ?? ex?.duration_seconds,
  );
  const rawTarget = String(
    importedDuration
      ?? firstSet?.reps
      ?? ex?.reps
      ?? ex?.targetReps
      ?? ex?.target_reps
      ?? DEFAULT_REP_TARGET,
  );
  const name = String(ex?.name ?? '').trim();
  const equipment = String(ex?.equipment || ex?.equipment_label || 'Bodyweight');
  const targetType: TargetType = shouldUseTimeTarget({
    name,
    equipment,
    primaryMuscle: ex?.primary_muscle ?? ex?.primaryMuscle ?? null,
    movementPattern: ex?.movement_pattern ?? ex?.movementPattern ?? null,
    exerciseType: ex?.exercise_type ?? ex?.exerciseType ?? null,
    reps: rawTarget,
  }) ? 'time' : 'reps';
  const setCount = Number(ex?.sets_count ?? ex?.setsCount ?? ex?.set_count ?? sets.length);
  const rest = parseRestSeconds(ex?.restSeconds ?? ex?.rest_seconds ?? ex?.rest);
  return {
    name,
    slug: ex?.slug ?? null,
    primaryMuscle: ex?.primary_muscle ?? ex?.primaryMuscle ?? null,
    movementPattern: ex?.movement_pattern ?? ex?.movementPattern ?? null,
    exerciseType: ex?.exercise_type ?? ex?.exerciseType ?? null,
    equipment,
    targetType,
    sets: Math.max(1, Number.isFinite(setCount) && setCount > 0 ? Math.round(setCount) : (targetType === 'time' ? 1 : 3)),
    reps: targetForMode(targetType, rawTarget),
    restSeconds: rest ?? (targetType === 'time' ? 0 : 60),
  };
}

function templateCandidateFromSession(session: any): AiTemplateCandidate | null {
  const exercises = (Array.isArray(session?.exercises) ? session.exercises : [])
    .filter((ex: any) => String(ex?.name ?? '').trim())
    .map(draftExerciseFromParsed);
  if (exercises.length === 0) return null;
  const name = String(
    session?.name
      ?? session?.templateName
      ?? session?.template_name
      ?? session?.focus
      ?? 'Imported Template',
  ).trim() || 'Imported Template';
  return {
    name,
    exercises,
    durationSeconds: Number(session?.durationSeconds ?? session?.duration_seconds) || undefined,
  };
}

function workoutFromDraftExercises(templateName: string, exercises: DraftExercise[]): WorkoutDay {
  return {
    day: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
    focus: templateName,
    exercises: exercises.map<Exercise>(ex => ({
      name: ex.name,
      sets: ex.sets,
      reps: ex.reps,
      restSeconds: ex.restSeconds,
      equipment: ex.equipment as any,
      slug: ex.slug ?? undefined,
      primary_muscle: ex.primaryMuscle ?? undefined,
      movement_pattern: ex.movementPattern ?? undefined,
      exercise_type: ex.exerciseType ?? undefined,
    }) as Exercise),
    stimulus: null,
  } as any;
}

function savedTemplateFromCandidate(candidate: AiTemplateCandidate, now = new Date().toISOString()): SavedWorkoutTemplate {
  return {
    id: `workout_template_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: candidate.name,
    workout: workoutFromDraftExercises(candidate.name, candidate.exercises),
    createdAt: now,
    updatedAt: now,
  };
}

function e2eId(value: string | number | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

interface Props {
  visible: boolean;
  themeName?: AppThemeName;
  onClose: () => void;
  onSaved?: (template: SavedWorkoutTemplate) => void;
  /** Existing template count — used to enforce the free cap before save. */
  currentCount?: number;
  /** When set, opens the modal in edit mode for this template. */
  editTarget?: SavedWorkoutTemplate | null;
  authToken?: string | null;
  availableEquipment?: string[];
  equipmentOptions?: string[];
  injuries?: string[];
  customExercises?: CustomExerciseItem[];
  onCreateCustomExercise?: (exercise: CustomExerciseItem) => void | Promise<void>;
}

export default function WorkoutTemplateBuilderModal({
  visible,
  themeName,
  onClose,
  onSaved,
  editTarget,
  authToken,
  availableEquipment,
  equipmentOptions,
  injuries,
  customExercises = [],
  onCreateCustomExercise,
}: Props) {
  const tc = getTheme(themeName).colors;
  const onPrimary = getContrastingTextColor(tc.primary);
  const [name, setName] = useState('');
  const [draftExercises, setDraftExercises] = useState<DraftExercise[]>([]);
  const [picker, setPicker] = useState(false);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [customExerciseOpen, setCustomExerciseOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [importingPhoto, setImportingPhoto] = useState(false);
  const [aiImportContext, setAiImportContext] = useState('');
  const [aiTemplateCandidates, setAiTemplateCandidates] = useState<AiTemplateCandidate[] | null>(null);
  const [aiTemplateSelected, setAiTemplateSelected] = useState<Set<number>>(new Set());
  const [savingAiTemplates, setSavingAiTemplates] = useState(false);
  const [equipmentScanLoading, setEquipmentScanLoading] = useState(false);
  const [equipmentScanResults, setEquipmentScanResults] = useState<Array<AIExerciseResult & { match_source?: 'library' | 'ai' }>>([]);
  const [identifiedEquipment, setIdentifiedEquipment] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    if (editTarget) {
      setName(editTarget.name);
      setDraftExercises((editTarget.workout?.exercises ?? []).map((ex: any) => {
        const base = {
          name: ex.name,
          equipment: ex.equipment || 'Bodyweight',
          primaryMuscle: ex.primary_muscle ?? null,
          movementPattern: (ex as any).movement_pattern ?? null,
          exerciseType: (ex as any).exercise_type ?? null,
          reps: String(ex.reps ?? DEFAULT_REP_TARGET),
        };
        const targetType: TargetType = shouldUseTimeTarget(base) ? 'time' : 'reps';
        return {
          name: ex.name,
          slug: ex.slug ?? null,
          primaryMuscle: base.primaryMuscle,
          movementPattern: base.movementPattern,
          exerciseType: base.exerciseType,
          equipment: base.equipment,
          targetType,
          sets: Number(ex.sets) || (targetType === 'time' ? 1 : 3),
          reps: targetForMode(targetType, base.reps),
          restSeconds: Number(ex.restSeconds) || (targetType === 'time' ? 0 : 60),
        };
      }));
    } else {
      setName('');
      setDraftExercises([]);
    }
    setSearch('');
    setAiImportContext('');
    setAiTemplateCandidates(null);
    setAiTemplateSelected(new Set());
    setSavingAiTemplates(false);
    setEquipmentScanResults([]);
    setIdentifiedEquipment(null);
  }, [visible, editTarget]);

  useEffect(() => {
    if (picker) return;
    setEquipmentScanLoading(false);
    setEquipmentScanResults([]);
    setIdentifiedEquipment(null);
  }, [picker]);

  // Lazy-load the exercise library the first time the picker opens. Avoids
  // a round-trip on every modal mount; many users back out without picking.
  useEffect(() => {
    if (!picker || library.length > 0 || libraryLoading) return;
    setLibraryLoading(true);
    import('../services/api').then(({ getExercises }) =>
      getExercises()
        .then((rows: any[]) => {
          // Strength items first, then everything else. Cardio + mobility
          // technically work too but mostly off-pattern for templates.
          const customs: LibraryItem[] = (customExercises ?? [])
            .map(ce => customExerciseToLibraryItem(ce) as LibraryItem);
          const items: LibraryItem[] = (rows || []).map(r => ({
            id: r.id, name: r.name, slug: r.slug,
            aliases: r.aliases ?? [],
            primary_muscle: r.primary_muscle, equipment: r.equipment,
            secondary_muscles: r.secondary_muscles ?? [],
            gear: r.gear ?? [],
            movement_pattern: r.movement_pattern, exercise_type: r.exercise_type,
          }));
          setLibrary([...customs, ...items]);
        })
        .catch(() => setLibrary((customExercises ?? []).map(ce => customExerciseToLibraryItem(ce) as LibraryItem)))
        .finally(() => setLibraryLoading(false))
    );
  }, [picker, library.length, libraryLoading, customExercises]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return library.slice(0, 80);
    return library.filter(it => matchesExerciseSearch(it, q)).slice(0, 80);
  }, [library, search]);

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
    (availableEquipment ?? []).forEach(add);
    (equipmentOptions ?? []).forEach(add);
    library.forEach(item => {
      add(item.equipment);
      (item.gear ?? []).forEach(gear => add(gear.name || gear.slug));
    });
    return out.sort((a, b) => a.localeCompare(b));
  }, [availableEquipment, equipmentOptions, library]);

  const handleAddExercise = (lib: LibraryItem) => {
    const base = {
      name: lib.name,
      equipment: lib.equipment || 'Bodyweight',
      primaryMuscle: lib.primary_muscle ?? null,
      movementPattern: lib.movement_pattern ?? null,
      exerciseType: lib.exercise_type ?? null,
      reps: DEFAULT_REP_TARGET,
    };
    const targetType: TargetType = shouldUseTimeTarget(base) ? 'time' : 'reps';
    const libSets = Number(lib.sets);
    const libRest = Number(lib.rest_seconds);
    setDraftExercises(prev => [...prev, {
      name: lib.name,
      slug: lib.slug ?? null,
      primaryMuscle: lib.primary_muscle ?? null,
      movementPattern: lib.movement_pattern ?? null,
      exerciseType: lib.exercise_type ?? null,
      equipment: lib.equipment || 'Bodyweight',
      targetType,
      sets: Number.isFinite(libSets) && libSets > 0 ? Math.max(1, Math.floor(libSets)) : (targetType === 'time' ? 1 : 3),
      reps: targetForMode(targetType, String(lib.reps ?? (targetType === 'time' ? DEFAULT_TIME_TARGET : DEFAULT_REP_TARGET))),
      restSeconds: Number.isFinite(libRest) && libRest >= 0 ? Math.max(0, Math.round(libRest)) : (targetType === 'time' ? 0 : 60),
    }]);
    setPicker(false);
    setSearch('');
  };

  const handleCreateCustomExercise = async (custom: CustomExerciseItem) => {
    await onCreateCustomExercise?.(custom);
    const lib = customExerciseToLibraryItem(custom) as LibraryItem;
    setLibrary(prev => {
      const key = normalizeExerciseNameKey(lib.name);
      if (prev.some(item => normalizeExerciseNameKey(item.name) === key)) return prev;
      return [lib, ...prev];
    });
    handleAddExercise(lib);
  };

  const handleAddScannedExercise = async (ex: AIExerciseResult) => {
    const key = normalizeExerciseNameKey(ex.name);
    const existing = library.find(item => normalizeExerciseNameKey(item.name) === key);
    if (existing) {
      handleAddExercise(existing);
      return;
    }
    const custom = customExerciseFromAiResult(ex, `custom_${Date.now()}`);
    await onCreateCustomExercise?.(custom);
    const lib = customExerciseToLibraryItem(custom) as LibraryItem;
    setLibrary(prev => {
      if (prev.some(item => normalizeExerciseNameKey(item.name) === key)) return prev;
      return [lib, ...prev];
    });
    handleAddExercise(lib);
  };

  const openCustomExerciseFromPicker = () => {
    setPicker(false);
    setTimeout(() => setCustomExerciseOpen(true), Platform.OS === 'ios' ? 320 : 0);
  };

  const handleRemove = (idx: number) => {
    setDraftExercises(prev => prev.filter((_, i) => i !== idx));
  };

  const updateExercise = (idx: number, patch: Partial<DraftExercise>) => {
    setDraftExercises(prev => prev.map((e, i) => i === idx ? { ...e, ...patch } : e));
  };

  const updateTargetType = (idx: number, targetType: TargetType) => {
    setDraftExercises(prev => prev.map((ex, i) => {
      if (i !== idx) return ex;
      return {
        ...ex,
        targetType,
        reps: targetForMode(targetType, ex.reps),
        sets: targetType === 'time' && ex.sets > 3 ? 1 : ex.sets,
        restSeconds: targetType === 'time' ? Math.max(0, ex.restSeconds) : ex.restSeconds,
      };
    }));
  };

  const applyTemplateCandidateToEditor = (candidate: AiTemplateCandidate) => {
    setName(prev => prev.trim() ? prev : candidate.name);
    setDraftExercises(prev => [...prev, ...candidate.exercises]);
  };

  const handleParsedTemplateSessions = (sessions: any[]) => {
    const candidates = (sessions ?? [])
      .map(templateCandidateFromSession)
      .filter(Boolean) as AiTemplateCandidate[];
    if (candidates.length === 0) {
      Alert.alert('No exercises found', 'I found the file, but not enough exercise detail to build a saved template.');
      return;
    }
    if (candidates.length === 1) {
      applyTemplateCandidateToEditor(candidates[0]);
      return;
    }
    setAiTemplateCandidates(candidates);
    setAiTemplateSelected(new Set(candidates.map((_, idx) => idx)));
  };

  const handleImportPhoto = async () => {
    if (!authToken) return;
    setImportingPhoto(true);
    try {
      const ImagePicker = await import('expo-image-picker');
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Photo access needed', 'Allow photo access to import a workout screenshot.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: false,
        allowsMultipleSelection: true,
        selectionLimit: 6,
        base64: true,
        quality: 0.85,
      } as any);
      if (result.canceled) return;
      const photos = (result.assets ?? [])
        .filter(asset => !!asset?.base64)
        .map(asset => ({
          base64: String(asset.base64),
          mimeType: (asset as any).mimeType || 'image/jpeg',
        }));
      if (photos.length === 0) {
        Alert.alert('Could not read photos', 'Choose different screenshots and try again.');
        return;
      }
      const parsed = await parseWorkoutPhotos(
        authToken,
        photos,
        { userContext: aiImportContext.trim(), templateMode: true },
      );
      handleParsedTemplateSessions(parsed.sessions ?? []);
    } catch (e: any) {
      Alert.alert('Import failed', String(e?.message ?? 'Could not import those screenshots.'));
    } finally {
      setImportingPhoto(false);
    }
  };

  const handleImportFile = async () => {
    if (!authToken) return;
    setImportingPhoto(true);
    try {
      const DocumentPicker = await import('expo-document-picker');
      const FileSystem = await import('expo-file-system');
      const picked = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'image/*'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled || !picked.assets?.length) return;
      const file = picked.assets[0];
      if (file.size != null && file.size > 10_000_000) {
        Alert.alert('File too large', 'Choose a smaller PDF, screenshot, or image file.');
        return;
      }
      const base64Encoding = (FileSystem as any).EncodingType?.Base64 ?? 'base64';
      const fileBase64 = await FileSystem.readAsStringAsync(file.uri, { encoding: base64Encoding });
      if (fileBase64.length > 14_000_000) {
        Alert.alert('File too large', 'Choose a smaller PDF, screenshot, or image file.');
        return;
      }
      const parsed = await parseWorkoutFile(authToken, {
        fileBase64: fileBase64.replace(/^data:.*;base64,/, ''),
        mimeType: file.mimeType || (file.name?.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'),
        filename: file.name,
        userContext: aiImportContext.trim(),
        templateMode: true,
      });
      handleParsedTemplateSessions(parsed.sessions ?? []);
    } catch (e: any) {
      Alert.alert('Import failed', String(e?.message ?? 'Could not import that file.'));
    } finally {
      setImportingPhoto(false);
    }
  };

  const promptAiImportSource = () => {
    Alert.alert(
      'AI import',
      'Choose one screenshot, a few screenshots, an image file, or a text-based PDF.',
      [
        { text: 'Screenshots', onPress: handleImportPhoto },
        { text: 'PDF or Image File', onPress: handleImportFile },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  };

  const toggleAiTemplateCandidate = (idx: number) => {
    setAiTemplateSelected(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  const handleSaveAiTemplates = async () => {
    const candidates = aiTemplateCandidates ?? [];
    const selected = candidates.filter((_, idx) => aiTemplateSelected.has(idx));
    if (selected.length === 0) {
      Alert.alert('Pick at least one template', 'Select the templates you want to save.');
      return;
    }
    setSavingAiTemplates(true);
    let savedCount = 0;
    try {
      for (const candidate of selected) {
        const template = savedTemplateFromCandidate(candidate);
        await upsertWorkoutTemplate(template);
        savedCount += 1;
        onSaved?.(template);
      }
      setAiTemplateCandidates(null);
      setAiTemplateSelected(new Set());
      Alert.alert(
        'Templates saved',
        `Saved ${savedCount} template${savedCount === 1 ? '' : 's'} from the import.`,
      );
    } catch (e: any) {
      Alert.alert(
        savedCount > 0 ? 'Some templates saved' : 'Could not save templates',
        e?.message ?? 'Try saving fewer templates.',
      );
    } finally {
      setSavingAiTemplates(false);
    }
  };

  const handleEquipmentPhotoScan = async (source: 'camera' | 'library') => {
    if (!authToken || equipmentScanLoading) return;
    setEquipmentScanLoading(true);
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
      const mime = rawMime === 'image/png' || rawMime === 'image/webp'
        ? rawMime
        : 'image/jpeg';
      const libraryNames = [
        ...library.map(item => item.name),
        ...(customExercises ?? []).map(item => item.name),
      ].filter(Boolean);
      const res = await analyzeExercisePhoto(authToken, {
        image_base64: asset.base64,
        mime_type: mime,
        library_names: Array.from(new Set(libraryNames)),
        equipment: availableEquipment,
        injuries,
      });
      const results = res.results ?? [];
      const equipmentName = String(res.equipment_identified ?? '').trim();
      setSearch('');
      setIdentifiedEquipment(equipmentName || null);
      setEquipmentScanResults(results);
      if (results.length === 0) {
        Alert.alert(
          equipmentName ? 'No exercises returned' : 'No equipment identified',
          equipmentName
            ? `I found ${equipmentName}, but not enough exercise detail came back. Try a clearer photo.`
            : 'Try a closer photo of the machine, cable stack, or rack.',
        );
      }
    } catch (e: any) {
      Alert.alert('Photo scan failed', e?.message ?? 'Could not scan that photo.');
    } finally {
      setEquipmentScanLoading(false);
    }
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      Alert.alert('Name required', 'Give your template a name so you can recognize it later.');
      return;
    }
    if (draftExercises.length === 0) {
      Alert.alert('Add at least one exercise', 'Templates need exercises — that\'s their whole job.');
      return;
    }
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const template: SavedWorkoutTemplate = {
        id: editTarget?.id ?? `workout_template_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: trimmed,
        workout: workoutFromDraftExercises(trimmed, draftExercises),
        createdAt: editTarget?.createdAt ?? now,
        updatedAt: now,
      };
      await upsertWorkoutTemplate(template);
      onSaved?.(template);
      onClose();
    } catch (e: any) {
      Alert.alert('Could not save template', e?.message ?? 'Try again.');
    } finally {
      setSaving(false);
    }
  };

  if (!visible) return null;

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: tc.background }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* Header */}
        <View style={[s.header, { borderBottomColor: tc.border }]}>
          <TouchableOpacity onPress={onClose}>
            <Text style={[s.cancel, { color: tc.textSecondary }]}>Cancel</Text>
          </TouchableOpacity>
          <Text style={[s.title, { color: tc.textPrimary }]}>
            {editTarget ? 'Edit Template' : 'New Template'}
          </Text>
          <TouchableOpacity testID="workout-template-save" accessibilityLabel="workout-template-save" onPress={handleSave} disabled={saving}>
            {saving
              ? <ActivityIndicator size="small" color={tc.primary} />
              : <Text style={[s.save, { color: tc.primary }]}>Save</Text>}
          </TouchableOpacity>
        </View>

        <ScrollView
          contentContainerStyle={{ padding: 18, paddingBottom: 320 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag">
          <Text style={[s.label, { color: tc.textSecondary }]}>Name</Text>
          <TextInput
            testID="workout-template-name-input"
            value={name}
            onChangeText={setName}
            placeholder="e.g. Upper Body — Push"
            placeholderTextColor={tc.textMuted}
            style={[s.input, { backgroundColor: tc.surface, color: tc.textPrimary, borderColor: tc.border }]}
          />

          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 18, marginBottom: 6 }}>
            <Text style={[s.label, { color: tc.textSecondary, marginBottom: 0 }]}>
              Exercises {draftExercises.length > 0 ? `(${draftExercises.length})` : ''}
            </Text>
            {draftExercises.length > 0 ? (
              <View style={{
                flexDirection: 'row', alignItems: 'center', gap: 4,
                paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
                backgroundColor: tc.primary + '14', borderWidth: 1, borderColor: tc.primary + '33',
              }}>
                <Ionicons name="time-outline" size={11} color={tc.primary} />
                <Text style={{ fontSize: 11, fontWeight: '700', color: tc.primary }}>
                  {formatDurationEstimate(estimateTemplateMinutes(draftExercises))}
                </Text>
              </View>
            ) : null}
          </View>
          {draftExercises.length === 0 ? (
            <View style={[s.emptyExercises, { borderColor: tc.border, backgroundColor: tc.surface }]}>
              <Text style={{ fontSize: 13, color: tc.textMuted, textAlign: 'center' }}>
                No exercises yet. Tap "Add Exercise" below to start building.
              </Text>
            </View>
          ) : (
            <View style={{ gap: 10 }}>
              {draftExercises.map((ex, idx) => (
                <View key={idx} style={[s.exCard, { backgroundColor: tc.surface, borderColor: tc.border }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }}>{ex.name}</Text>
                      <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }}>
                        {ex.primaryMuscle ? `${ex.primaryMuscle} · ` : ''}{ex.equipment}
                      </Text>
                    </View>
                    <TouchableOpacity onPress={() => handleRemove(idx)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <Ionicons name="close-circle" size={20} color={tc.error ?? '#EF4444'} />
                    </TouchableOpacity>
                  </View>
                  <View style={[s.targetSwitch, { borderColor: tc.border, backgroundColor: tc.background }]}>
                    {(['reps', 'time'] as const).map(mode => {
                      const active = ex.targetType === mode;
                      return (
                        <TouchableOpacity
                          key={mode}
                          testID={`workout-template-target-${mode}-${idx}`}
                          accessibilityLabel={`workout-template-target-${mode}-${idx}`}
                          onPress={() => updateTargetType(idx, mode)}
                          style={[s.targetSwitchOption, active && { backgroundColor: tc.primary }]}
                          activeOpacity={0.75}>
                          <Ionicons
                            name={mode === 'time' ? 'timer-outline' : 'repeat-outline'}
                            size={13}
                            color={active ? onPrimary : tc.textMuted}
                          />
                          <Text style={[s.targetSwitchText, { color: active ? onPrimary : tc.textSecondary }]}>
                            {mode === 'time' ? 'Time' : 'Reps'}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                  <View style={[s.wheelRow, { backgroundColor: tc.background, borderColor: tc.border }]}>
                    <View style={s.wheelCell}>
                      <NumberWheelPicker
                        testID={`workout-template-sets-wheel-${idx}`}
                        label="Sets"
                        labelColor={tc.textMuted}
                        selectedColor={tc.textPrimary}
                        mutedColor={tc.textMuted}
                        dividerColor={tc.border}
                        values={SETS_VALUES}
                        value={snapToNearest(SETS_VALUES, Math.max(1, Math.min(10, ex.sets)))}
                        onChange={v => updateExercise(idx, { sets: v as number })}
                      />
                    </View>
                    <View style={[s.wheelDivider, { backgroundColor: tc.border }]} />
                    <View style={s.wheelCell}>
                      {ex.targetType === 'time' ? (
                        <NumberWheelPicker
                          testID={`workout-template-time-wheel-${idx}`}
                          label="Time"
                          labelColor={tc.textMuted}
                          selectedColor={tc.textPrimary}
                          mutedColor={tc.textMuted}
                          dividerColor={tc.border}
                          values={TIME_VALUES}
                          value={(TIME_VALUES as readonly string[]).includes(ex.reps) ? (ex.reps as typeof TIME_VALUES[number]) : '20 min'}
                          onChange={v => updateExercise(idx, { reps: v as string })}
                        />
                      ) : (
                        <NumberWheelPicker
                          testID={`workout-template-reps-wheel-${idx}`}
                          label="Reps"
                          labelColor={tc.textMuted}
                          selectedColor={tc.textPrimary}
                          mutedColor={tc.textMuted}
                          dividerColor={tc.border}
                          values={REPS_VALUES}
                          value={(REPS_VALUES as readonly string[]).includes(ex.reps) ? (ex.reps as typeof REPS_VALUES[number]) : '8-12'}
                          onChange={v => updateExercise(idx, { reps: v as string })}
                        />
                      )}
                    </View>
                    <View style={[s.wheelDivider, { backgroundColor: tc.border }]} />
                    <View style={s.wheelCell}>
                      <NumberWheelPicker
                        testID={`workout-template-rest-wheel-${idx}`}
                        label="Rest"
                        labelColor={tc.textMuted}
                        selectedColor={tc.textPrimary}
                        mutedColor={tc.textMuted}
                        dividerColor={tc.border}
                        values={REST_VALUES}
                        value={snapToNearest(REST_VALUES, Math.max(0, ex.restSeconds))}
                        onChange={v => updateExercise(idx, { restSeconds: v as number })}
                        formatLabel={(v) => formatRest(v as number)}
                      />
                    </View>
                  </View>
                </View>
              ))}
            </View>
          )}

          <TouchableOpacity
            testID="workout-template-add-exercise"
            accessibilityLabel="workout-template-add-exercise"
            onPress={() => setPicker(true)}
            style={[s.addBtn, { borderColor: tc.primary + '66', backgroundColor: tc.primary + '0E' }]}
            activeOpacity={0.75}>
            <Ionicons name="add" size={18} color={tc.primary} />
            <Text style={{ fontSize: 13, fontWeight: '700', color: tc.primary }}>Add Exercise</Text>
          </TouchableOpacity>
          {authToken ? (
            <View style={{ marginTop: 14, gap: 8 }}>
              <TextInput
                testID="workout-template-ai-import-context"
                value={aiImportContext}
                onChangeText={setAiImportContext}
                multiline
                placeholder="Context for AI import (optional)"
                placeholderTextColor={tc.textMuted}
                style={[s.input, {
                  minHeight: 72,
                  textAlignVertical: 'top',
                  backgroundColor: tc.surface,
                  color: tc.textPrimary,
                  borderColor: tc.border,
                }]}
              />
              <TouchableOpacity
                testID="workout-template-import-photo"
                accessibilityLabel="workout-template-import-photo"
                onPress={promptAiImportSource}
                disabled={importingPhoto}
                style={[s.addBtn, { marginTop: 0, borderColor: tc.border, backgroundColor: tc.surface, opacity: importingPhoto ? 0.65 : 1 }]}
                activeOpacity={0.75}>
                {importingPhoto ? (
                  <ActivityIndicator size="small" color={tc.primary} />
                ) : (
                  <Ionicons name="document-text-outline" size={18} color={tc.primary} />
                )}
                <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>
                  {importingPhoto ? 'Importing...' : 'AI Import Screenshots/PDF'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </ScrollView>

        {/* Exercise picker — full-screen list with search. */}
        <Modal visible={picker} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setPicker(false)}>
          <View style={{ flex: 1, backgroundColor: tc.background }}>
            <View style={[s.header, { borderBottomColor: tc.border }]}>
              <TouchableOpacity onPress={() => { setPicker(false); setSearch(''); }}>
                <Text style={[s.cancel, { color: tc.textSecondary }]}>Cancel</Text>
              </TouchableOpacity>
              <Text style={[s.title, { color: tc.textPrimary }]}>Add Exercise</Text>
              <View style={{ width: 60 }} />
            </View>
            <View style={{ padding: 14, flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <TextInput
                testID="workout-template-exercise-search"
                value={search}
                onChangeText={(text) => {
                  setSearch(text);
                  if (equipmentScanResults.length > 0 || identifiedEquipment) {
                    setEquipmentScanResults([]);
                    setIdentifiedEquipment(null);
                  }
                }}
                placeholder="Search exercises..."
                placeholderTextColor={tc.textMuted}
                style={[s.input, { flex: 1, backgroundColor: tc.surface, color: tc.textPrimary, borderColor: tc.border }]}
              />
              {authToken ? (
                <TouchableOpacity
                  testID="workout-template-equipment-photo-scan"
                  accessibilityLabel="workout-template-equipment-photo-scan"
                  disabled={equipmentScanLoading}
                  onPress={() => {
                    Alert.alert(
                      'Scan equipment',
                      'Take a photo of a machine or rack and choose one of the exercises it supports.',
                      [
                        { text: 'Camera', onPress: () => handleEquipmentPhotoScan('camera') },
                        { text: 'Photo Library', onPress: () => handleEquipmentPhotoScan('library') },
                        { text: 'Cancel', style: 'cancel' },
                      ],
                    );
                  }}
                  style={{
                    width: 46, height: 46, borderRadius: radius.sm,
                    alignItems: 'center', justifyContent: 'center',
                    backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                    opacity: equipmentScanLoading ? 0.65 : 1,
                  }}>
                  {equipmentScanLoading
                    ? <ActivityIndicator size="small" color={tc.primary} />
                    : <Ionicons name="camera-outline" size={20} color={tc.textSecondary} />}
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                testID="workout-template-custom-exercise"
                accessibilityLabel="workout-template-custom-exercise"
                onPress={openCustomExerciseFromPicker}
                style={{ width: 46, height: 46, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: tc.primary + '14', borderWidth: 1, borderColor: tc.primary + '66' }}>
                <Ionicons name="create-outline" size={20} color={tc.primary} />
              </TouchableOpacity>
            </View>
            {libraryLoading ? (
              <View style={{ padding: 30, alignItems: 'center' }}>
                <ActivityIndicator color={tc.primary} />
              </View>
            ) : (
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 30 }}>
                {equipmentScanLoading && equipmentScanResults.length === 0 ? (
                  <View style={{ paddingHorizontal: 16, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <ActivityIndicator size="small" color={tc.primary} />
                    <Text style={{ fontSize: 12, color: tc.textMuted }}>Scanning equipment...</Text>
                  </View>
                ) : null}
                {equipmentScanResults.length > 0 ? (
                  <View style={{ paddingHorizontal: 16, paddingBottom: 12, gap: 8 }}>
                    <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      {identifiedEquipment ? `Exercises for ${identifiedEquipment}` : 'Photo Results'}
                    </Text>
                    {equipmentScanResults.map((ex, i) => (
                      <View
                        key={`scan-${ex.name}-${i}`}
                        style={{ borderRadius: radius.md, borderWidth: 1.5, borderColor: tc.primary + '66', backgroundColor: tc.surface, padding: 12, gap: 8 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }} numberOfLines={1}>{ex.name}</Text>
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
                          onPress={() => handleAddScannedExercise(ex)}
                          style={{ borderRadius: radius.sm, backgroundColor: tc.primary, paddingVertical: 10, alignItems: 'center' }}>
                          <Text style={{ fontSize: 13, color: onPrimary, fontWeight: '800' }}>Add to Template</Text>
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                ) : null}
                {filtered.map((it, i) => (
                  <TouchableOpacity
                    key={`${it.id ?? it.slug ?? it.name}-${i}`}
                    testID={`workout-template-exercise-option-${e2eId(it.slug ?? it.name)}`}
                    accessibilityLabel={`workout-template-exercise-option-${e2eId(it.slug ?? it.name)}`}
                    onPress={() => handleAddExercise(it)}
                    style={[s.libRow, { borderBottomColor: tc.border }]}
                    activeOpacity={0.7}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: '600', color: tc.textPrimary }}>{it.name}</Text>
                      <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }}>
                        {[it.primary_muscle, it.equipment].filter(Boolean).join(' · ')}
                      </Text>
                    </View>
                    <Ionicons name="add-circle-outline" size={22} color={tc.primary} />
                  </TouchableOpacity>
                ))}
                {filtered.length === 0 && !libraryLoading && (
                  <View style={{ alignItems: 'center', padding: 30, gap: 10 }}>
                    <Text style={{ textAlign: 'center', color: tc.textMuted, fontSize: 13 }}>
                      {search ? 'No matches.' : 'Library is empty.'}
                    </Text>
                    <TouchableOpacity
                      onPress={openCustomExerciseFromPicker}
                      style={{ borderRadius: radius.sm, paddingVertical: 10, paddingHorizontal: 14, backgroundColor: tc.primary + '14', borderWidth: 1, borderColor: tc.primary + '66' }}>
                      <Text style={{ color: tc.primary, fontSize: 13, fontWeight: '800' }}>Add Custom Exercise</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </ScrollView>
            )}
          </View>
        </Modal>

        <Modal
          visible={!!aiTemplateCandidates}
          transparent
          animationType="fade"
          onRequestClose={() => setAiTemplateCandidates(null)}>
          <View style={{
            flex: 1, backgroundColor: '#0009',
            justifyContent: 'center', padding: 20,
          }}>
            <View style={{
              backgroundColor: tc.background, borderRadius: radius.lg,
              borderWidth: 1, borderColor: tc.border, padding: 18, gap: 12,
              maxHeight: '86%',
            }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <Text style={{ flex: 1, fontSize: 17, fontWeight: '800', color: tc.textPrimary }}>
                  Review Imported Templates
                </Text>
                <TouchableOpacity
                  onPress={() => setAiTemplateCandidates(null)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="close" size={22} color={tc.textMuted} />
                </TouchableOpacity>
              </View>

              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textSecondary }}>
                  {aiTemplateSelected.size} of {aiTemplateCandidates?.length ?? 0} selected
                </Text>
                <TouchableOpacity
                  onPress={() => {
                    const count = aiTemplateCandidates?.length ?? 0;
                    if (aiTemplateSelected.size === count) setAiTemplateSelected(new Set());
                    else setAiTemplateSelected(new Set((aiTemplateCandidates ?? []).map((_, idx) => idx)));
                  }}>
                  <Text style={{ fontSize: 12, fontWeight: '800', color: tc.primary }}>
                    {aiTemplateSelected.size === (aiTemplateCandidates?.length ?? 0) ? 'Clear all' : 'Select all'}
                  </Text>
                </TouchableOpacity>
              </View>

              <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ gap: 8 }}>
                {(aiTemplateCandidates ?? []).map((candidate, idx) => {
                  const selected = aiTemplateSelected.has(idx);
                  return (
                    <TouchableOpacity
                      key={`${candidate.name}-${idx}`}
                      onPress={() => toggleAiTemplateCandidate(idx)}
                      activeOpacity={0.75}
                      style={{
                        flexDirection: 'row', alignItems: 'center', gap: 10,
                        padding: 12, borderRadius: radius.md, borderWidth: 1,
                        borderColor: selected ? tc.primary : tc.border,
                        backgroundColor: selected ? tc.primary + '12' : tc.surface,
                      }}>
                      <Ionicons
                        name={selected ? 'checkbox' : 'square-outline'}
                        size={20}
                        color={selected ? tc.primary : tc.textMuted}
                      />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary }} numberOfLines={1}>
                          {candidate.name}
                        </Text>
                        <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }} numberOfLines={1}>
                          {candidate.exercises.length} exercise{candidate.exercises.length === 1 ? '' : 's'} · {formatDurationEstimate(estimateTemplateMinutes(candidate.exercises))}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>

              <View style={{ flexDirection: 'row', gap: 10 }}>
                <TouchableOpacity
                  disabled={savingAiTemplates || (aiTemplateCandidates?.length ?? 0) === 0}
                  onPress={() => {
                    const idx = Array.from(aiTemplateSelected).sort((a, b) => a - b)[0] ?? 0;
                    const candidate = aiTemplateCandidates?.[idx];
                    if (!candidate) return;
                    applyTemplateCandidateToEditor(candidate);
                    setAiTemplateCandidates(null);
                  }}
                  style={{
                    flex: 1, borderRadius: radius.md, borderWidth: 1,
                    borderColor: tc.border, backgroundColor: tc.surface,
                    paddingVertical: 12, alignItems: 'center',
                  }}>
                  <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textPrimary }}>Edit First</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  disabled={savingAiTemplates || aiTemplateSelected.size === 0}
                  onPress={handleSaveAiTemplates}
                  style={{
                    flex: 1, borderRadius: radius.md,
                    backgroundColor: aiTemplateSelected.size > 0 ? tc.primary : tc.primary + '55',
                    paddingVertical: 12, alignItems: 'center', justifyContent: 'center',
                    flexDirection: 'row', gap: 6,
                  }}>
                  {savingAiTemplates ? <ActivityIndicator size="small" color={onPrimary} /> : null}
                  <Text style={{ fontSize: 13, fontWeight: '800', color: onPrimary }}>Save Selected</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        <CustomExerciseModal
          visible={customExerciseOpen}
          themeName={themeName}
          initialName={search.trim()}
          saveLabel="Save and Add"
          authToken={authToken}
          availableEquipment={availableEquipment}
          equipmentOptions={customExerciseEquipmentOptions}
          injuries={injuries}
          onClose={() => setCustomExerciseOpen(false)}
          onSave={handleCreateCustomExercise}
        />
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: 16, borderBottomWidth: 1,
  },
  title: { fontSize: 17, fontWeight: '700' },
  cancel: { fontSize: 16 },
  save: { fontSize: 16, fontWeight: '700' },
  label: { fontSize: 11, fontWeight: '700', letterSpacing: 0, marginBottom: 6 },
  input: { borderWidth: 1, borderRadius: radius.sm, padding: 12, fontSize: 15 },
  emptyExercises: {
    borderWidth: 1, borderRadius: radius.md, padding: 22,
    borderStyle: 'dashed' as any,
  },
  exCard: {
    borderRadius: radius.md, borderWidth: 1, padding: 12,
  },
  targetSwitch: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    borderWidth: 1,
    borderRadius: 8,
    marginTop: 10,
    padding: 2,
  },
  targetSwitchOption: {
    minWidth: 74,
    height: 30,
    borderRadius: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  targetSwitchText: {
    fontSize: 12,
    fontWeight: '800',
  },
  fieldGroup: { flex: 1 },
  fieldLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 0, marginBottom: 4 },
  wheelRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderWidth: 1,
    borderRadius: 8,
    marginTop: 10,
    paddingVertical: 6,
  },
  wheelCell: { flex: 1, paddingHorizontal: 4 },
  wheelDivider: { width: 1, marginVertical: 6 },
  addBtn: {
    marginTop: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 12, borderRadius: radius.md, borderWidth: 1.5,
    borderStyle: 'dashed' as any,
  },
  libRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 12, paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
