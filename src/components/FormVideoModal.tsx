import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, ScrollView, Image, Linking,
  StyleSheet, Dimensions, Animated, ActivityIndicator,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';

import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';

interface Props {
  visible: boolean;
  exerciseName: string;
  /** Required now — we call the backend /ai/exercise-video to get a list
   *  of embeddable options (top 20 + shorts filtered to embeddable only). */
  authToken?: string | null;
  themeName?: AppThemeName;
  onClose: () => void;
}

interface VideoOption {
  video_id: string;
  title: string;
  thumbnail_url: string;
  author_name: string;
  is_short: boolean;
}

const SCREEN_W = Dimensions.get('window').width;
const PLAYER_W = SCREEN_W - 32;
const PLAYER_H = (PLAYER_W * 9) / 16;
const THUMB_W = (PLAYER_W - 8) / 2;
const THUMB_H = (THUMB_W * 9) / 16;

export default function FormVideoModal({
  visible, exerciseName, themeName, authToken, onClose,
}: Props) {
  const colors = getTheme(themeName).colors;
  const [options, setOptions] = useState<VideoOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!authToken || !exerciseName) return;
    setLoading(true);
    setError(null);
    setOptions([]);
    setSelectedId(null);
    try {
      const { getApiBaseUrl } = await import('../services/api');
      const baseUrl = getApiBaseUrl();
      const res = await fetch(`${baseUrl}/ai/exercise-video`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ exercise_name: exerciseName }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const opts: VideoOption[] = Array.isArray(data?.options) ? data.options : [];
      setOptions(opts);
      setSelectedId(opts[0]?.video_id ?? null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [authToken, exerciseName]);

  useEffect(() => {
    if (visible) load();
  }, [visible, load]);

  // Entrance animation — spring the sheet up from 0.9 → 1.0.
  const scale = useRef(new Animated.Value(0.9)).current;
  const sheetOpacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (visible) {
      scale.setValue(0.9);
      sheetOpacity.setValue(0);
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 7, tension: 80 }),
        Animated.timing(sheetOpacity, { toValue: 1, duration: 180, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, scale, sheetOpacity]);

  const searchUrl = `https://m.youtube.com/results?search_query=${encodeURIComponent(exerciseName + ' proper form')}`;

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Animated.View
          style={[
            styles.sheet,
            { backgroundColor: colors.surface, borderColor: colors.border, opacity: sheetOpacity, transform: [{ scale }] },
          ]}
        >
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={1}>
                Form Videos
              </Text>
              <Text style={[styles.subtitle, { color: colors.textSecondary }]} numberOfLines={1}>
                {exerciseName}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Primary player — plays whichever option the user selected. */}
          {selectedId ? (
            <View style={[styles.playerWrap, { backgroundColor: '#000' }]}>
              <WebView
                key={`player-${selectedId}`}
                style={{ flex: 1, backgroundColor: '#000' }}
                source={{ uri: `https://www.youtube.com/embed/${selectedId}?playsinline=1&rel=0&modestbranding=1` }}
                javaScriptEnabled
                domStorageEnabled
                allowsFullscreenVideo
                originWhitelist={['*']}
              />
            </View>
          ) : (
            <View style={[styles.playerWrap, { backgroundColor: colors.surfaceRaised, alignItems: 'center', justifyContent: 'center' }]}>
              {loading ? (
                <ActivityIndicator color={colors.primary} />
              ) : error ? (
                <View style={{ padding: 12, alignItems: 'center' }}>
                  <Text style={{ fontSize: 12, color: colors.textMuted, textAlign: 'center' }}>
                    Couldn't load videos: {error}
                  </Text>
                </View>
              ) : (
                <Text style={{ fontSize: 12, color: colors.textMuted }}>No videos found</Text>
              )}
            </View>
          )}

          {/* Thumbnail grid — all returned options are embeddable. Tap to
              swap the main player to that video. Shorts tagged visually. */}
          <ScrollView style={{ marginTop: 12, maxHeight: 320 }} showsVerticalScrollIndicator={false}>
            <View style={styles.grid}>
              {options.map(opt => {
                const isSelected = opt.video_id === selectedId;
                return (
                  <TouchableOpacity
                    key={opt.video_id}
                    activeOpacity={0.8}
                    onPress={() => setSelectedId(opt.video_id)}
                    style={[
                      styles.thumbCard,
                      {
                        backgroundColor: colors.surfaceRaised,
                        borderColor: isSelected ? colors.primary : colors.border,
                        borderWidth: isSelected ? 2 : 1,
                      },
                    ]}
                  >
                    <View style={{ width: THUMB_W - 2, height: THUMB_H, backgroundColor: '#000', borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md, overflow: 'hidden' }}>
                      {opt.thumbnail_url ? (
                        <Image source={{ uri: opt.thumbnail_url }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                      ) : null}
                      {opt.is_short ? (
                        <View style={[styles.shortBadge, { backgroundColor: colors.primary }]}>
                          <Text style={{ fontSize: 9, fontWeight: '800', color: colors.background, letterSpacing: 0.6 }}>
                            SHORT
                          </Text>
                        </View>
                      ) : null}
                      {isSelected && (
                        <View style={styles.selectedOverlay}>
                          <Ionicons name="play-circle" size={36} color="#fff" />
                        </View>
                      )}
                    </View>
                    <View style={{ padding: 8 }}>
                      <Text
                        numberOfLines={2}
                        style={{ fontSize: 11, fontWeight: '600', color: colors.textPrimary, lineHeight: 15 }}
                      >
                        {opt.title || 'Untitled'}
                      </Text>
                      {opt.author_name ? (
                        <Text numberOfLines={1} style={{ fontSize: 10, color: colors.textMuted, marginTop: 2 }}>
                          {opt.author_name}
                        </Text>
                      ) : null}
                    </View>
                  </TouchableOpacity>
                );
              })}
              {loading && options.length === 0 && (
                <View style={{ flex: 1, alignItems: 'center', padding: 20 }}>
                  <ActivityIndicator color={colors.primary} />
                  <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 8 }}>
                    Finding embeddable videos…
                  </Text>
                </View>
              )}
            </View>
          </ScrollView>

          <View style={styles.actions}>
            <TouchableOpacity
              onPress={() => Linking.openURL(searchUrl)}
              style={[styles.secondaryBtn, { backgroundColor: colors.surfaceRaised, borderColor: colors.border }]}
              activeOpacity={0.8}
            >
              <Ionicons name="open-outline" size={14} color={colors.textSecondary} />
              <Text style={[styles.secondaryBtnText, { color: colors.textSecondary }]}>More on YouTube</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onClose}
              style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
              activeOpacity={0.8}
            >
              <Text style={[styles.primaryBtnText, { color: colors.background }]}>Done</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderTopWidth: 1,
    paddingHorizontal: 16, paddingTop: 14, paddingBottom: 24,
  },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  title: { fontSize: 16, fontWeight: '800' },
  subtitle: { fontSize: 12, marginTop: 2 },
  playerWrap: {
    width: PLAYER_W, height: PLAYER_H,
    borderRadius: radius.md, overflow: 'hidden',
    alignSelf: 'center',
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between' },
  thumbCard: {
    width: THUMB_W,
    borderRadius: radius.md,
    overflow: 'hidden',
    marginBottom: 8,
  },
  shortBadge: {
    position: 'absolute', top: 6, right: 6,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
  },
  selectedOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  actions: { flexDirection: 'row', gap: 8, marginTop: 14 },
  secondaryBtn: {
    flex: 1.4, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 11, borderRadius: radius.md, borderWidth: 1,
  },
  secondaryBtnText: { fontSize: 12, fontWeight: '700' },
  primaryBtn: { flex: 1, paddingVertical: 11, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  primaryBtnText: { fontSize: 13, fontWeight: '800' },
});
