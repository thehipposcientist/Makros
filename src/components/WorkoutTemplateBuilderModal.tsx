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
 * the free-tier 3-template cap defense-in-depth.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, TextInput, ScrollView,
  StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName, SavedWorkoutTemplate, WorkoutDay, Exercise } from '../types';
import { upsertWorkoutTemplate } from '../utils/workoutHistory';
import { parseWorkoutPhoto } from '../services/api';

interface LibraryItem {
  id?: number | string;
  name: string;
  slug?: string | null;
  primary_muscle?: string | null;
  equipment?: string | null;
}

interface DraftExercise {
  name: string;
  slug?: string | null;
  primaryMuscle?: string | null;
  equipment: string;
  sets: number;
  reps: string;
  restSeconds: number;
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
}

export default function WorkoutTemplateBuilderModal({ visible, themeName, onClose, onSaved, editTarget, authToken }: Props) {
  const tc = getTheme(themeName).colors;
  const [name, setName] = useState('');
  const [draftExercises, setDraftExercises] = useState<DraftExercise[]>([]);
  const [picker, setPicker] = useState(false);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [importingPhoto, setImportingPhoto] = useState(false);

  useEffect(() => {
    if (!visible) return;
    if (editTarget) {
      setName(editTarget.name);
      setDraftExercises((editTarget.workout?.exercises ?? []).map((ex: any) => ({
        name: ex.name,
        slug: ex.slug ?? null,
        primaryMuscle: ex.primary_muscle ?? null,
        equipment: ex.equipment || 'Bodyweight',
        sets: Number(ex.sets) || 3,
        reps: String(ex.reps ?? '8-12'),
        restSeconds: Number(ex.restSeconds) || 60,
      })));
    } else {
      setName('');
      setDraftExercises([]);
    }
    setSearch('');
  }, [visible, editTarget]);

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
          const items: LibraryItem[] = (rows || []).map(r => ({
            id: r.id, name: r.name, slug: r.slug,
            primary_muscle: r.primary_muscle, equipment: r.equipment,
          }));
          setLibrary(items);
        })
        .catch(() => setLibrary([]))
        .finally(() => setLibraryLoading(false))
    );
  }, [picker, library.length, libraryLoading]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return library.slice(0, 80);
    return library.filter(it =>
      it.name.toLowerCase().includes(q)
      || (it.primary_muscle ?? '').toLowerCase().includes(q)
      || (it.equipment ?? '').toLowerCase().includes(q),
    ).slice(0, 80);
  }, [library, search]);

  const handleAddExercise = (lib: LibraryItem) => {
    setDraftExercises(prev => [...prev, {
      name: lib.name,
      slug: lib.slug ?? null,
      primaryMuscle: lib.primary_muscle ?? null,
      equipment: lib.equipment || 'Bodyweight',
      sets: 3,
      reps: '8-12',
      restSeconds: 60,
    }]);
    setPicker(false);
    setSearch('');
  };

  const handleRemove = (idx: number) => {
    setDraftExercises(prev => prev.filter((_, i) => i !== idx));
  };

  const updateExercise = (idx: number, patch: Partial<DraftExercise>) => {
    setDraftExercises(prev => prev.map((e, i) => i === idx ? { ...e, ...patch } : e));
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
        base64: true,
        quality: 0.85,
      });
      if (result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset?.base64) {
        Alert.alert('Could not read photo', 'Choose a different screenshot and try again.');
        return;
      }
      const parsed = await parseWorkoutPhoto(authToken, asset.base64, (asset as any).mimeType || 'image/jpeg');
      const session = (parsed.sessions ?? []).find(s => Array.isArray(s.exercises) && s.exercises.length > 0) ?? parsed.sessions?.[0];
      const imported = (session?.exercises ?? []).filter((ex: any) => String(ex?.name ?? '').trim());
      if (!session || imported.length === 0) {
        Alert.alert('No exercises found', 'I found the workout, but not enough exercise detail to build a saved template.');
        return;
      }
      setName(prev => prev.trim() ? prev : String(session.focus || 'Imported Template'));
      setDraftExercises(prev => [
        ...prev,
        ...imported.map((ex: any): DraftExercise => {
          const sets = Array.isArray(ex.sets) ? ex.sets : [];
          const reps = sets.length > 0
            ? String(sets[0]?.reps ?? '8-12')
            : '8-12';
          return {
            name: String(ex.name).trim(),
            slug: null,
            primaryMuscle: null,
            equipment: String(ex.equipment || 'Bodyweight'),
            sets: Math.max(1, Number(ex.sets_count ?? sets.length) || 3),
            reps,
            restSeconds: Math.max(0, Number(ex.restSeconds) || 60),
          };
        }),
      ]);
    } catch (e: any) {
      Alert.alert('Import failed', String(e?.message ?? 'Could not import that screenshot.'));
    } finally {
      setImportingPhoto(false);
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
      const workout: WorkoutDay = {
        day: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
        focus: trimmed,
        exercises: draftExercises.map<Exercise>(ex => ({
          name: ex.name,
          sets: ex.sets,
          reps: ex.reps,
          restSeconds: ex.restSeconds,
          equipment: ex.equipment as any,
          slug: ex.slug ?? undefined,
          primary_muscle: ex.primaryMuscle ?? undefined,
        }) as Exercise),
        stimulus: null,
      } as any;
      const template: SavedWorkoutTemplate = {
        id: editTarget?.id ?? `workout_template_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: trimmed,
        workout,
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
      <View style={{ flex: 1, backgroundColor: tc.background }}>
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

        <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 60 }}>
          <Text style={[s.label, { color: tc.textSecondary }]}>NAME</Text>
          <TextInput
            testID="workout-template-name-input"
            value={name}
            onChangeText={setName}
            placeholder="e.g. Upper Body — Push"
            placeholderTextColor={tc.textMuted}
            style={[s.input, { backgroundColor: tc.surface, color: tc.textPrimary, borderColor: tc.border }]}
          />

          <Text style={[s.label, { color: tc.textSecondary, marginTop: 18 }]}>
            EXERCISES {draftExercises.length > 0 ? `(${draftExercises.length})` : ''}
          </Text>
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
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                    <View style={s.fieldGroup}>
                      <Text style={[s.fieldLabel, { color: tc.textMuted }]}>SETS</Text>
                      <TextInput
                        value={String(ex.sets)}
                        onChangeText={t => updateExercise(idx, { sets: Math.max(1, parseInt(t) || 1) })}
                        keyboardType="number-pad"
                        style={[s.fieldInput, { color: tc.textPrimary, borderColor: tc.border, backgroundColor: tc.background }]}
                      />
                    </View>
                    <View style={s.fieldGroup}>
                      <Text style={[s.fieldLabel, { color: tc.textMuted }]}>REPS</Text>
                      <TextInput
                        value={ex.reps}
                        onChangeText={t => updateExercise(idx, { reps: t })}
                        placeholder="8-12"
                        placeholderTextColor={tc.textMuted}
                        style={[s.fieldInput, { color: tc.textPrimary, borderColor: tc.border, backgroundColor: tc.background }]}
                      />
                    </View>
                    <View style={s.fieldGroup}>
                      <Text style={[s.fieldLabel, { color: tc.textMuted }]}>REST (s)</Text>
                      <TextInput
                        value={String(ex.restSeconds)}
                        onChangeText={t => updateExercise(idx, { restSeconds: Math.max(0, parseInt(t) || 0) })}
                        keyboardType="number-pad"
                        style={[s.fieldInput, { color: tc.textPrimary, borderColor: tc.border, backgroundColor: tc.background }]}
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
            <TouchableOpacity
              testID="workout-template-import-photo"
              accessibilityLabel="workout-template-import-photo"
              onPress={handleImportPhoto}
              disabled={importingPhoto}
              style={[s.addBtn, { borderColor: tc.border, backgroundColor: tc.surface, opacity: importingPhoto ? 0.65 : 1 }]}
              activeOpacity={0.75}>
              {importingPhoto ? (
                <ActivityIndicator size="small" color={tc.primary} />
              ) : (
                <Ionicons name="image-outline" size={18} color={tc.primary} />
              )}
              <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>
                {importingPhoto ? 'Importing...' : 'Import Screenshot'}
              </Text>
            </TouchableOpacity>
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
            <View style={{ padding: 14 }}>
              <TextInput
                testID="workout-template-exercise-search"
                value={search}
                onChangeText={setSearch}
                placeholder="Search exercises..."
                placeholderTextColor={tc.textMuted}
                style={[s.input, { backgroundColor: tc.surface, color: tc.textPrimary, borderColor: tc.border }]}
              />
            </View>
            {libraryLoading ? (
              <View style={{ padding: 30, alignItems: 'center' }}>
                <ActivityIndicator color={tc.primary} />
              </View>
            ) : (
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 30 }}>
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
                  <Text style={{ textAlign: 'center', color: tc.textMuted, padding: 30, fontSize: 13 }}>
                    {search ? 'No matches.' : 'Library is empty.'}
                  </Text>
                )}
              </ScrollView>
            )}
          </View>
        </Modal>
      </View>
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
  label: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginBottom: 6 },
  input: { borderWidth: 1, borderRadius: radius.sm, padding: 12, fontSize: 15 },
  emptyExercises: {
    borderWidth: 1, borderRadius: radius.md, padding: 22,
    borderStyle: 'dashed' as any,
  },
  exCard: {
    borderRadius: radius.md, borderWidth: 1, padding: 12,
  },
  fieldGroup: { flex: 1 },
  fieldLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 0.5, marginBottom: 4 },
  fieldInput: {
    borderWidth: 1, borderRadius: 8, padding: 8, fontSize: 13, textAlign: 'center',
  },
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
