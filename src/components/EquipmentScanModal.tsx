/**
 * Equipment scan modal — "Verify or add with photo".
 *
 * Lets the user walk around their gym snapping 1-6 photos. The AI
 * (`/ai/scan-equipment`) returns names matching the seed equipment
 * library; the user toggles which to keep, then taps Add. Selected
 * items are merged into the caller's equipment list — already-selected
 * items stay selected, newly-confirmed items get added.
 *
 * Used in two places:
 *   - OnboardingScreen equipment step (existing single-photo flow can
 *     migrate to this when it's convenient)
 *   - EditProfileScreen Equipment tab (the "Verify with photo" button
 *     this component was built for)
 *
 * Multi-photo lift: a single shot of one corner of the gym misses most
 * machines. Even 3-4 photos around the floor catches the squat rack,
 * cable stack, leg press, and the dumbbell rack — ~80% of what a real
 * commercial gym surfaces. Cap at 6 to control AI cost.
 */
import { useEffect, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, ScrollView, Image,
  StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { scanEquipmentPhoto } from '../services/api';

const MAX_PHOTOS = 6;

interface Props {
  visible: boolean;
  authToken: string;
  themeName?: AppThemeName;
  /** Equipment names already on the user's profile. Pre-checked in the
   *  confirmation step + flagged as "already in your list" so users
   *  don't worry about duplicates. */
  alreadySelected: string[];
  onClose: () => void;
  /** Called with the final list (already-selected + newly-confirmed). */
  onAdd: (names: string[]) => void;
}

export default function EquipmentScanModal({ visible, authToken, themeName, alreadySelected, onClose, onAdd }: Props) {
  const tc = getTheme(themeName).colors;
  const [photos, setPhotos] = useState<string[]>([]); // data URIs for preview
  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState<{ name: string; selected: boolean; alreadyIn: boolean }[]>([]);
  const [errorNote, setErrorNote] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setPhotos([]);
      setResults([]);
      setErrorNote(null);
    }
  }, [visible]);

  const handleAddPhoto = async (source: 'camera' | 'library') => {
    if (photos.length >= MAX_PHOTOS) return;
    try {
      const ImagePicker = await import('expo-image-picker');
      const perm = source === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          source === 'camera' ? 'Camera permission needed' : 'Photo library permission needed',
          'Allow access in iOS Settings to scan your gym.',
        );
        return;
      }
      const result = source === 'camera'
        ? await ImagePicker.launchCameraAsync({ quality: 0.5, base64: true, exif: false, mediaTypes: ['images'] as any, maxWidth: 1024, maxHeight: 1024 } as any)
        : await ImagePicker.launchImageLibraryAsync({ quality: 0.5, base64: true, exif: false, mediaTypes: ['images'] as any, maxWidth: 1024, maxHeight: 1024 } as any);
      if (result.canceled || !result.assets?.[0]?.base64) return;
      setPhotos(prev => [...prev, `data:image/jpeg;base64,${result.assets![0].base64}`]);
    } catch {
      Alert.alert('Photo error', 'Could not capture or pick an image.');
    }
  };

  const handleScan = async () => {
    if (photos.length === 0 || !authToken) return;
    setScanning(true);
    setErrorNote(null);
    try {
      // Strip data URI prefix so the backend sees raw base64.
      const b64List = photos.map(p => p.includes(',') ? p.split(',')[1] : p);
      const resp = await scanEquipmentPhoto(authToken, { images: b64List });
      const names = (resp.equipment ?? []).filter(Boolean);
      if (names.length === 0) {
        setErrorNote('Nothing recognized — try a clearer wide shot of the gym floor or a closer shot of one machine.');
        setResults([]);
        return;
      }
      const alreadySet = new Set((alreadySelected ?? []).map(n => n.toLowerCase()));
      const next = names.map(name => ({
        name,
        selected: true,                  // default everything checked
        alreadyIn: alreadySet.has(name.toLowerCase()),
      }));
      setResults(next);
    } catch (e: any) {
      setErrorNote(e?.message ?? 'Scan failed. Try again.');
      setResults([]);
    } finally {
      setScanning(false);
    }
  };

  const toggleResult = (name: string) => {
    setResults(prev => prev.map(r => r.name === name ? { ...r, selected: !r.selected } : r));
  };

  const handleConfirm = () => {
    const picked = results.filter(r => r.selected).map(r => r.name);
    // Merge: keep everything already selected + add new picks. Set dedup
    // is case-insensitive against the user's existing list so we don't
    // create duplicate entries when the seed name capitalization differs.
    const lowerExisting = new Map((alreadySelected ?? []).map(n => [n.toLowerCase(), n]));
    for (const p of picked) {
      if (!lowerExisting.has(p.toLowerCase())) lowerExisting.set(p.toLowerCase(), p);
    }
    onAdd(Array.from(lowerExisting.values()));
    onClose();
  };

  if (!visible) return null;

  const newCount = results.filter(r => r.selected && !r.alreadyIn).length;
  const inListCount = results.filter(r => r.selected && r.alreadyIn).length;

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: tc.background }}>
        <View style={[s.header, { borderBottomColor: tc.border }]}>
          <TouchableOpacity onPress={onClose}>
            <Text style={[s.cancel, { color: tc.textSecondary }]}>Cancel</Text>
          </TouchableOpacity>
          <Text style={[s.title, { color: tc.textPrimary }]}>Scan Your Gym</Text>
          {results.length > 0 ? (
            <TouchableOpacity onPress={handleConfirm}>
              <Text style={[s.save, { color: tc.primary }]}>Add</Text>
            </TouchableOpacity>
          ) : <View style={{ width: 50 }} />}
        </View>

        <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 60 }}>
          {/* Step 1: photo capture */}
          {results.length === 0 && (
            <>
              <Text style={[s.intro, { color: tc.textSecondary }]}>
                Take 2–{MAX_PHOTOS} photos around your gym. Wide shots of the floor work best — we'll deduplicate machines that show up in more than one photo.
              </Text>

              <View style={s.photoGrid}>
                {photos.map((uri, idx) => (
                  <View key={idx} style={s.photoTile}>
                    <Image source={{ uri }} style={s.photoImg} resizeMode="cover" />
                    <TouchableOpacity
                      style={s.photoRemove}
                      onPress={() => setPhotos(prev => prev.filter((_, i) => i !== idx))}
                      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                      <Ionicons name="close" size={12} color="#fff" />
                    </TouchableOpacity>
                  </View>
                ))}
                {photos.length < MAX_PHOTOS && (
                  <TouchableOpacity
                    onPress={() => handleAddPhoto('camera')}
                    activeOpacity={0.75}
                    style={[s.photoTile, s.photoAdd, { borderColor: tc.primary + '66', backgroundColor: tc.primary + '0E' }]}>
                    <Ionicons name="camera-outline" size={22} color={tc.primary} />
                    <Text style={{ fontSize: 10, fontWeight: '700', color: tc.primary, marginTop: 2 }}>CAMERA</Text>
                  </TouchableOpacity>
                )}
                {photos.length < MAX_PHOTOS && (
                  <TouchableOpacity
                    onPress={() => handleAddPhoto('library')}
                    activeOpacity={0.75}
                    style={[s.photoTile, s.photoAdd, { borderColor: tc.border, backgroundColor: tc.surface }]}>
                    <Ionicons name="images-outline" size={22} color={tc.textSecondary} />
                    <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textSecondary, marginTop: 2 }}>LIBRARY</Text>
                  </TouchableOpacity>
                )}
              </View>

              {photos.length > 0 && (
                <TouchableOpacity
                  onPress={handleScan}
                  disabled={scanning}
                  style={[s.primaryBtn, { backgroundColor: tc.primary }]}
                  activeOpacity={0.85}>
                  {scanning
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <>
                        <Ionicons name="sparkles-outline" size={16} color="#fff" />
                        <Text style={{ fontSize: 14, fontWeight: '800', color: '#fff' }}>
                          Identify equipment ({photos.length} photo{photos.length === 1 ? '' : 's'})
                        </Text>
                      </>}
                </TouchableOpacity>
              )}
              {errorNote && (
                <Text style={{ marginTop: 12, fontSize: 12, color: tc.error ?? '#EF4444', lineHeight: 17 }}>
                  {errorNote}
                </Text>
              )}
            </>
          )}

          {/* Step 2: confirm results */}
          {results.length > 0 && (
            <>
              <Text style={[s.intro, { color: tc.textSecondary }]}>
                {newCount} new · {inListCount} already in your list. Uncheck anything that isn't actually at your gym.
              </Text>
              <View style={{ gap: 8, marginTop: 6 }}>
                {results.map((r) => (
                  <TouchableOpacity
                    key={r.name}
                    onPress={() => toggleResult(r.name)}
                    activeOpacity={0.7}
                    style={[
                      s.resultRow,
                      {
                        borderColor: r.selected ? tc.primary : tc.border,
                        backgroundColor: r.selected ? tc.primary + '10' : tc.surface,
                      },
                    ]}>
                    <View style={[
                      s.checkbox,
                      {
                        borderColor: r.selected ? tc.primary : tc.border,
                        backgroundColor: r.selected ? tc.primary : 'transparent',
                      },
                    ]}>
                      {r.selected && <Ionicons name="checkmark" size={14} color="#fff" />}
                    </View>
                    <Text style={[s.resultName, { color: tc.textPrimary, flex: 1 }]}>{r.name}</Text>
                    {r.alreadyIn && (
                      <View style={[s.badge, { backgroundColor: tc.success + '22' }]}>
                        <Text style={{ fontSize: 9, fontWeight: '800', color: tc.success, letterSpacing: 0.5 }}>
                          IN LIST
                        </Text>
                      </View>
                    )}
                  </TouchableOpacity>
                ))}
              </View>
              <TouchableOpacity
                onPress={() => { setResults([]); setPhotos([]); }}
                style={{ marginTop: 18, alignSelf: 'center' }}>
                <Text style={{ fontSize: 12, color: tc.textMuted }}>← Start over with new photos</Text>
              </TouchableOpacity>
            </>
          )}
        </ScrollView>
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
  intro: { fontSize: 13, lineHeight: 18, marginBottom: 14 },
  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  photoTile: {
    width: 90, height: 90, borderRadius: 10, overflow: 'hidden',
    position: 'relative',
  },
  photoImg: { width: '100%', height: '100%' },
  photoAdd: {
    borderWidth: 1.5, borderStyle: 'dashed' as any,
    alignItems: 'center', justifyContent: 'center',
  },
  photoRemove: {
    position: 'absolute', top: 4, right: 4,
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },
  primaryBtn: {
    marginTop: 4, paddingVertical: 13, borderRadius: radius.md,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  resultRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 12, borderRadius: 10, borderWidth: 1,
  },
  checkbox: {
    width: 22, height: 22, borderRadius: 11, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  resultName: { fontSize: 14, fontWeight: '600' },
  badge: { paddingHorizontal: 6, paddingVertical: 3, borderRadius: 6 },
});
