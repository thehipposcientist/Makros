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
  authToken?: string | null;
  themeName?: AppThemeName;
  /** Optional context passed to the backend so results stay tight to
   *  the exact exercise variant. Example: "Band Chest Press" with
   *  equipment="resistance_bands" so the backend can filter out
   *  "Machine Chest Press" tutorials. */
  equipment?: string | null;
  primaryMuscle?: string | null;
  movementPattern?: string | null;
  onClose: () => void;
}

interface VideoOption {
  video_id: string;
  title: string;
  thumbnail_url: string;
  author_name: string;
  is_short: boolean;
  recommended?: boolean;
}

const SCREEN_W = Dimensions.get('window').width;
const PLAYER_W = SCREEN_W - 32;
const PLAYER_H = (PLAYER_W * 9) / 16;
const THUMB_W = (PLAYER_W - 8) / 2;
const THUMB_H = (THUMB_W * 9) / 16;

export default function FormVideoModal({
  visible, exerciseName, themeName, authToken, equipment, primaryMuscle, movementPattern, onClose,
}: Props) {
  const colors = getTheme(themeName).colors;
  const [options, setOptions] = useState<VideoOption[]>([]);
  const [activeVideo, setActiveVideo] = useState<VideoOption | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emptyReason, setEmptyReason] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!authToken || !exerciseName) return;
    setLoading(true);
    setError(null);
    setEmptyReason(null);
    setOptions([]);
    setActiveVideo(null);
    try {
      const { getApiBaseUrl } = await import('../services/api');
      const baseUrl = getApiBaseUrl();
      const res = await fetch(`${baseUrl}/ai/exercise-video`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          exercise_name: exerciseName,
          equipment: equipment ?? undefined,
          primary_muscle: primaryMuscle ?? undefined,
          movement_pattern: movementPattern ?? undefined,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const opts: VideoOption[] = Array.isArray(data?.options) ? data.options : [];
      setOptions(opts);
      if (opts.length === 0) setEmptyReason(data?.empty_reason || 'no_results');
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [authToken, exerciseName, equipment, primaryMuscle, movementPattern]);

  useEffect(() => {
    if (visible) load();
    if (!visible) setActiveVideo(null);
  }, [visible, load]);

  const scale = useRef(new Animated.Value(0.9)).current;
  const sheetOpacity = useRef(new Animated.Value(0)).current;
  const playerSlide = useRef(new Animated.Value(0)).current;
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

  useEffect(() => {
    Animated.spring(playerSlide, {
      toValue: activeVideo ? 1 : 0,
      useNativeDriver: true,
      friction: 8,
      tension: 65,
    }).start();
  }, [activeVideo, playerSlide]);

  const searchUrl = `https://m.youtube.com/results?search_query=${encodeURIComponent(exerciseName + ' proper form')}`;

  const handleBack = () => setActiveVideo(null);
  const handleClose = () => { setActiveVideo(null); onClose(); };

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={handleClose}>
      <View style={styles.backdrop}>
        <Animated.View
          style={[
            styles.sheet,
            { backgroundColor: colors.surface, borderColor: colors.border, opacity: sheetOpacity, transform: [{ scale }] },
          ]}
        >
          {/* Header */}
          <View style={styles.header}>
            {activeVideo ? (
              <TouchableOpacity
                onPress={handleBack}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginRight: 8 }}>
                <Ionicons name="arrow-back" size={20} color={colors.primary} />
              </TouchableOpacity>
            ) : null}
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={1}>
                {activeVideo ? activeVideo.title : 'YouTube form demos'}
              </Text>
              <Text style={[styles.subtitle, { color: colors.textSecondary }]} numberOfLines={1}>
                {activeVideo
                  ? (activeVideo.author_name ? `by ${activeVideo.author_name}` : 'YouTube')
                  : exerciseName}
              </Text>
            </View>
            <TouchableOpacity onPress={handleClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Active video player — shown when a video is selected */}
          {activeVideo ? (
            <Animated.View style={{ opacity: playerSlide }}>
              <View style={[styles.playerWrap, { backgroundColor: '#000' }]}>
                <WebView
                  key={`player-${activeVideo.video_id}`}
                  style={{ flex: 1, backgroundColor: '#000' }}
                  source={{
                    html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{margin:0;padding:0}body{background:#000}iframe{width:100%;height:100%;border:0}</style></head><body><iframe src="https://www.youtube-nocookie.com/embed/${activeVideo.video_id}?playsinline=1&rel=0&modestbranding=1&autoplay=1&origin=https://www.youtube-nocookie.com" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture" allowfullscreen></iframe></body></html>`,
                    baseUrl: 'https://www.youtube-nocookie.com',
                  }}
                  javaScriptEnabled
                  domStorageEnabled
                  allowsFullscreenVideo
                  allowsInlineMediaPlayback
                  mediaPlaybackRequiresUserAction={false}
                  originWhitelist={['*']}
                />
              </View>
              {/* Channel attribution row — always visible so users
                  understand the video is third-party. */}
              {activeVideo.author_name ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}>
                  <Ionicons name="logo-youtube" size={12} color="#FF0000" />
                  <Text style={{ fontSize: 11, color: colors.textMuted }} numberOfLines={1}>
                    Form demo by {activeVideo.author_name} on YouTube
                  </Text>
                </View>
              ) : null}
              <View style={styles.actions}>
                <TouchableOpacity
                  onPress={handleBack}
                  style={[styles.secondaryBtn, { backgroundColor: colors.surfaceRaised, borderColor: colors.border }]}
                  activeOpacity={0.8}
                >
                  <Ionicons name="arrow-back" size={14} color={colors.textSecondary} />
                  <Text style={[styles.secondaryBtnText, { color: colors.textSecondary }]}>All Videos</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => Linking.openURL(`https://www.youtube.com/watch?v=${activeVideo.video_id}`)}
                  style={[styles.secondaryBtn, { backgroundColor: colors.surfaceRaised, borderColor: colors.border }]}
                  activeOpacity={0.8}
                >
                  <Ionicons name="open-outline" size={14} color={colors.textSecondary} />
                  <Text style={[styles.secondaryBtnText, { color: colors.textSecondary }]}>YouTube</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleClose}
                  style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.primaryBtnText, { color: colors.background }]}>Done</Text>
                </TouchableOpacity>
              </View>
            </Animated.View>
          ) : (
            /* Video selection grid — default view */
            <>
              {loading && options.length === 0 && (
                <View style={{ alignItems: 'center', paddingVertical: 30 }}>
                  <ActivityIndicator color={colors.primary} />
                  <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 8 }}>
                    Finding form videos…
                  </Text>
                </View>
              )}
              {error && options.length === 0 && (
                <View style={{ alignItems: 'center', paddingVertical: 20 }}>
                  <Text style={{ fontSize: 12, color: colors.textMuted, textAlign: 'center' }}>
                    Couldn't load videos: {error}
                  </Text>
                </View>
              )}
              {/* Empty state — NO curated/well-ranked results came back.
                  We don't dump raw YouTube results into the UI; instead
                  we tell the user so they can open a search themselves. */}
              {!loading && !error && options.length === 0 && (
                <View style={{ alignItems: 'center', paddingVertical: 28, paddingHorizontal: 20 }}>
                  <View style={{
                    width: 52, height: 52, borderRadius: 26,
                    backgroundColor: colors.surfaceRaised,
                    alignItems: 'center', justifyContent: 'center', marginBottom: 10,
                  }}>
                    <Ionicons name="videocam-off-outline" size={22} color={colors.textMuted} />
                  </View>
                  <Text style={{ fontSize: 13, fontWeight: '800', color: colors.textPrimary, textAlign: 'center' }}>
                    No curated videos yet
                  </Text>
                  <Text style={{ fontSize: 11, color: colors.textMuted, textAlign: 'center', marginTop: 4, lineHeight: 16 }}>
                    We couldn't find a tutorial that matches this exercise
                    closely enough. You can open YouTube to search manually.
                  </Text>
                </View>
              )}
              {options.length > 0 && (
                <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
                  <View style={styles.grid}>
                    {options.map((opt) => (
                      <Animated.View
                        key={opt.video_id}
                        style={{ opacity: 1, transform: [{ translateY: 0 }] }}
                      >
                        <TouchableOpacity
                          activeOpacity={0.8}
                          onPress={() => setActiveVideo(opt)}
                          style={[
                            styles.thumbCard,
                            {
                              backgroundColor: colors.surfaceRaised,
                              borderColor: opt.recommended ? colors.primary : colors.border,
                              borderWidth: opt.recommended ? 1.5 : 1,
                            },
                          ]}
                        >
                          <View style={{ width: THUMB_W - 2, height: THUMB_H, backgroundColor: '#000', borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md, overflow: 'hidden' }}>
                            {opt.thumbnail_url ? (
                              <Image source={{ uri: opt.thumbnail_url }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                            ) : null}
                            {opt.recommended ? (
                              <View style={[styles.recommendedBadge, { backgroundColor: colors.primary }]}>
                                <Ionicons name="checkmark-circle" size={9} color={colors.background} />
                                <Text style={{ fontSize: 9, fontWeight: '800', color: colors.background, letterSpacing: 0.4 }}>RECOMMENDED</Text>
                              </View>
                            ) : opt.is_short ? (
                              <View style={[styles.shortBadge, { backgroundColor: colors.primary }]}>
                                <Text style={{ fontSize: 9, fontWeight: '800', color: colors.background, letterSpacing: 0.6 }}>SHORT</Text>
                              </View>
                            ) : null}
                            <View style={styles.playOverlay}>
                              <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons name="play" size={18} color="#fff" style={{ marginLeft: 2 }} />
                              </View>
                            </View>
                          </View>
                          <View style={{ padding: 8 }}>
                            <Text numberOfLines={2} style={{ fontSize: 11, fontWeight: '600', color: colors.textPrimary, lineHeight: 15 }}>
                              {opt.title || 'Untitled'}
                            </Text>
                            {opt.author_name ? (
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 3 }}>
                                <Ionicons name="logo-youtube" size={9} color="#FF0000" />
                                <Text numberOfLines={1} style={{ fontSize: 10, color: colors.textMuted }}>
                                  {opt.author_name}
                                </Text>
                              </View>
                            ) : null}
                          </View>
                        </TouchableOpacity>
                      </Animated.View>
                    ))}
                  </View>
                </ScrollView>
              )}
              <View style={styles.actions}>
                <TouchableOpacity
                  onPress={() => Linking.openURL(searchUrl)}
                  style={[styles.secondaryBtn, { backgroundColor: colors.surfaceRaised, borderColor: colors.border }]}
                  activeOpacity={0.8}
                >
                  <Ionicons name="open-outline" size={14} color={colors.textSecondary} />
                  <Text style={[styles.secondaryBtnText, { color: colors.textSecondary }]}>
                    {options.length === 0 ? 'Search YouTube' : 'More on YouTube'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleClose}
                  style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.primaryBtnText, { color: colors.background }]}>Done</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
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
  recommendedBadge: {
    position: 'absolute', top: 6, left: 6,
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4,
  },
  playOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  actions: { flexDirection: 'row', gap: 8, marginTop: 14 },
  secondaryBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 11, borderRadius: radius.md, borderWidth: 1,
  },
  secondaryBtnText: { fontSize: 12, fontWeight: '700' },
  primaryBtn: { flex: 1, paddingVertical: 11, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  primaryBtnText: { fontSize: 13, fontWeight: '800' },
});
