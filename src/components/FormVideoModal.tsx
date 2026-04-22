import { useEffect, useRef, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity,
  StyleSheet, Dimensions, Animated,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';

import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';

interface Props {
  visible: boolean;
  exerciseName: string;
  // Kept in the prop shape for call-site compatibility but unused since
  // we skip the backend video lookup and go straight to YouTube search.
  authToken?: string | null;
  themeName?: AppThemeName;
  onClose: () => void;
}

const SCREEN_W = Dimensions.get('window').width;
const PLAYER_W = SCREEN_W - 32;
const PLAYER_H = (PLAYER_W * 9) / 16;
const SEARCH_H = PLAYER_H * 2.4;

export default function FormVideoModal({
  visible, exerciseName, themeName, onClose,
}: Props) {
  const colors = getTheme(themeName).colors;
  const [searchKey, setSearchKey] = useState(0);

  // Force the WebView to remount every time the modal opens with a new
  // exercise so stale search results don't flash.
  useEffect(() => {
    if (visible) setSearchKey(k => k + 1);
  }, [visible, exerciseName]);

  // App-native presentation: fade the Modal and spring the inner sheet
  // from 0.9 → 1.0 on open. Feels softer than the default slide-up.
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
          ]}>
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

          <View style={[styles.playerWrap, { backgroundColor: '#fff', height: SEARCH_H }]}>
            {visible && (
              <WebView
                key={`search-${searchKey}`}
                style={{ flex: 1, backgroundColor: '#fff' }}
                source={{ uri: searchUrl }}
                javaScriptEnabled
                domStorageEnabled
                allowsFullscreenVideo
                originWhitelist={['*']}
                userAgent="Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"
              />
            )}
          </View>

          <Text style={{ fontSize: 11, color: colors.textMuted, textAlign: 'center', marginTop: 8 }}>
            Tap any video to play it in this window.
          </Text>

          <View style={styles.actions}>
            <TouchableOpacity
              onPress={onClose}
              style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
              activeOpacity={0.8}>
              <Text style={styles.primaryBtnText}>Done</Text>
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
    width: PLAYER_W,
    borderRadius: radius.md, overflow: 'hidden',
    alignSelf: 'center',
  },
  actions: { flexDirection: 'row', gap: 8, marginTop: 14 },
  secondaryBtn: {
    flex: 1.6, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 11, borderRadius: radius.md, borderWidth: 1,
  },
  secondaryBtnText: { fontSize: 12, fontWeight: '700' },
  primaryBtn: { flex: 1, paddingVertical: 11, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  primaryBtnText: { color: '#fff', fontSize: 13, fontWeight: '800' },
});
