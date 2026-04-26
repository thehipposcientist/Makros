import { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  Modal,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Image,
  Alert,
  ActivityIndicator,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { getTheme, radius } from '../constants/theme';
import type { AppThemeName } from '../types';
import { createSocialPost, type WorkoutPostSummary } from '../services/api';

interface Props {
  visible: boolean;
  authToken: string;
  onClose: () => void;
  themeName?: AppThemeName;
  workoutSummary: WorkoutPostSummary | null;
}

export default function ShareWorkoutModal({ visible, authToken, onClose, themeName, workoutSummary }: Props) {
  const theme = getTheme(themeName);
  const c = theme.colors;
  const s = useMemo(() => mk(c), [c]);

  const [caption, setCaption] = useState('');
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  const pickPhoto = useCallback(async (source: 'camera' | 'library') => {
    const perm = source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', `Please allow ${source} access.`);
      return;
    }
    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync({ quality: 0.7, base64: true, mediaTypes: ['images'] as any })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.7, base64: true, mediaTypes: ['images'] as any });
    if (result.canceled || !result.assets?.[0]?.base64) return;
    setPhotoBase64(result.assets[0].base64);
    setPhotoUri(result.assets[0].uri);
  }, []);

  const handlePost = useCallback(async () => {
    if (!workoutSummary) return;
    setPosting(true);
    try {
      await createSocialPost(authToken, {
        caption: caption.trim() || undefined,
        photo_base64: photoBase64 || undefined,
        workout_summary: workoutSummary,
      });
      setCaption('');
      setPhotoBase64(null);
      setPhotoUri(null);
      onClose();
    } catch (e: any) {
      Alert.alert('Could not post', e?.message ?? 'Try again');
    } finally {
      setPosting(false);
    }
  }, [authToken, caption, photoBase64, workoutSummary, onClose]);

  const handleClose = useCallback(() => {
    setCaption('');
    setPhotoBase64(null);
    setPhotoUri(null);
    onClose();
  }, [onClose]);

  if (!workoutSummary) return null;

  const dur = Math.round(workoutSummary.duration_seconds / 60);
  const exs = workoutSummary.exercises ?? [];

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.backdrop}>
          <View style={s.sheet}>
            {/* Header */}
            <View style={s.header}>
              <TouchableOpacity onPress={handleClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={c.textSecondary} />
              </TouchableOpacity>
              <Text style={s.title}>Share Workout</Text>
              <TouchableOpacity
                style={[s.postBtn, posting && { opacity: 0.5 }]}
                onPress={handlePost}
                disabled={posting}
                activeOpacity={0.85}
              >
                {posting ? (
                  <ActivityIndicator size="small" color="#000" />
                ) : (
                  <Text style={s.postBtnText}>Post</Text>
                )}
              </TouchableOpacity>
            </View>

            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
            >
              {/* Caption — first so it's always visible */}
              <TextInput
                style={s.captionInput}
                placeholder="Add a caption..."
                placeholderTextColor={c.textMuted}
                multiline
                maxLength={500}
                value={caption}
                onChangeText={setCaption}
                returnKeyType="default"
              />

              {/* Photo */}
              {photoUri ? (
                <View style={s.photoContainer}>
                  <Image source={{ uri: photoUri }} style={s.photo} resizeMode="cover" />
                  <TouchableOpacity
                    style={s.photoRemove}
                    onPress={() => { setPhotoBase64(null); setPhotoUri(null); }}
                  >
                    <Ionicons name="close-circle" size={24} color="#fff" />
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={s.photoActions}>
                  <TouchableOpacity style={s.photoBtn} onPress={() => pickPhoto('camera')} activeOpacity={0.85}>
                    <Ionicons name="camera-outline" size={20} color={c.textSecondary} />
                    <Text style={s.photoBtnText}>Camera</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.photoBtn} onPress={() => pickPhoto('library')} activeOpacity={0.85}>
                    <Ionicons name="image-outline" size={20} color={c.textSecondary} />
                    <Text style={s.photoBtnText}>Gallery</Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* Workout summary card */}
              <View style={s.summaryCard}>
                <View style={s.summaryHeader}>
                  <Ionicons name="barbell-outline" size={18} color={c.primary} />
                  <Text style={s.summaryFocus}>{workoutSummary.focus} Day</Text>
                  {workoutSummary.training_rating && (
                    <View style={[s.ratingBadge, { backgroundColor: c.primary + '22' }]}>
                      <Text style={[s.ratingText, { color: c.primary }]}>{workoutSummary.training_rating}</Text>
                    </View>
                  )}
                </View>
                <View style={s.statsRow}>
                  <View style={s.stat}>
                    <Text style={s.statValue}>{dur}</Text>
                    <Text style={s.statLabel}>min</Text>
                  </View>
                  <View style={[s.statDivider, { backgroundColor: c.border }]} />
                  <View style={s.stat}>
                    <Text style={s.statValue}>{workoutSummary.total_sets}</Text>
                    <Text style={s.statLabel}>sets</Text>
                  </View>
                  <View style={[s.statDivider, { backgroundColor: c.border }]} />
                  <View style={s.stat}>
                    <Text style={s.statValue}>{exs.length}</Text>
                    <Text style={s.statLabel}>exercises</Text>
                  </View>
                  {workoutSummary.training_score != null && (
                    <>
                      <View style={[s.statDivider, { backgroundColor: c.border }]} />
                      <View style={s.stat}>
                        <Text style={s.statValue}>{workoutSummary.training_score}</Text>
                        <Text style={s.statLabel}>score</Text>
                      </View>
                    </>
                  )}
                </View>

                {exs.length > 0 && (
                  <View style={s.exerciseList}>
                    {exs.map((ex, i) => {
                      const bestSet = ex.sets.reduce(
                        (best, set) => (set.weight_lbs > best.weight_lbs ? set : best),
                        ex.sets[0] ?? { reps: 0, weight_lbs: 0 },
                      );
                      return (
                        <View key={i} style={s.exerciseRow}>
                          <View style={{ flex: 1 }}>
                            <Text style={s.exerciseName}>{ex.name}</Text>
                            {ex.equipment ? (
                              <Text style={s.exerciseEquip}>{ex.equipment}</Text>
                            ) : null}
                          </View>
                          <Text style={s.exerciseSets}>
                            {ex.sets.length}x{bestSet.reps}
                            {bestSet.weight_lbs > 0 ? ` @ ${bestSet.weight_lbs} lbs` : ''}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                )}
              </View>
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const mk = (c: ReturnType<typeof getTheme>['colors']) =>
  StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    sheet: {
      flex: 1, marginTop: 60,
      backgroundColor: c.background,
      borderTopLeftRadius: 20, borderTopRightRadius: 20,
    },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 16, paddingVertical: 14,
      borderBottomWidth: 1, borderBottomColor: c.border,
    },
    title: { fontSize: 17, fontWeight: '700', color: c.textPrimary },
    postBtn: {
      backgroundColor: c.primary,
      paddingHorizontal: 20, paddingVertical: 8,
      borderRadius: radius.full, minWidth: 64, alignItems: 'center',
    },
    postBtnText: { fontSize: 14, fontWeight: '800', color: '#000' },
    captionInput: {
      fontSize: 15, color: c.textPrimary,
      backgroundColor: c.surface,
      borderColor: c.border, borderWidth: 1,
      borderRadius: radius.md, padding: 14,
      minHeight: 80, marginBottom: 16,
    },
    summaryCard: {
      backgroundColor: c.surface,
      borderColor: c.border, borderWidth: 1,
      borderRadius: radius.lg, padding: 16,
    },
    summaryHeader: {
      flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14,
    },
    summaryFocus: { fontSize: 17, fontWeight: '800', color: c.textPrimary, flex: 1 },
    ratingBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.full },
    ratingText: { fontSize: 11, fontWeight: '800' },
    statsRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      paddingVertical: 12, marginBottom: 12,
      borderTopWidth: 1, borderBottomWidth: 1,
      borderColor: c.border,
    },
    stat: { alignItems: 'center', flex: 1 },
    statValue: { fontSize: 20, fontWeight: '800', color: c.textPrimary },
    statLabel: { fontSize: 11, color: c.textMuted, marginTop: 2 },
    statDivider: { width: 1, height: 28 },
    exerciseList: { gap: 8 },
    exerciseRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingVertical: 6,
    },
    exerciseName: { fontSize: 13, fontWeight: '600', color: c.textPrimary },
    exerciseEquip: { fontSize: 11, color: c.textMuted, marginTop: 1 },
    exerciseSets: { fontSize: 13, fontWeight: '700', color: c.textSecondary },
    photoContainer: { marginBottom: 16, borderRadius: radius.lg, overflow: 'hidden' },
    photo: { width: '100%', height: 240, borderRadius: radius.lg },
    photoRemove: { position: 'absolute', top: 8, right: 8 },
    photoActions: {
      flexDirection: 'row', gap: 12, marginBottom: 16,
    },
    photoBtn: {
      flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      gap: 8, paddingVertical: 14,
      backgroundColor: c.surface, borderColor: c.border, borderWidth: 1,
      borderRadius: radius.md,
    },
    photoBtnText: { fontSize: 13, fontWeight: '600', color: c.textSecondary },
  });
