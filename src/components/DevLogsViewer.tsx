// On-device log viewer. Shows the ring buffer from devLogs.ts with
// level filtering, substring search, copy-all, and clear. Mounted as
// a full-screen modal from wherever you put the hidden trigger
// (e.g. 5-tap on a version number in Settings).

import { useEffect, useMemo, useState } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Share,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { getTheme } from '../constants/theme';
import { AppThemeName } from '../types';
import {
  DevLogEntry, getDevLogs, subscribeDevLogs, clearDevLogs, formatDevLogs,
} from '../utils/devLogs';

interface Props {
  visible: boolean;
  onClose: () => void;
  themeName?: AppThemeName;
}

export default function DevLogsViewer({ visible, onClose, themeName }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const insets = useSafeAreaInsets();
  // Theme-aware per-level colors. Hardcoded hex earlier was unreadable
  // on light themes (light text on light bg). Now log = textPrimary,
  // info = primary, warn/error = theme tokens, debug = muted — all of
  // which the theme already calibrates for contrast on each background.
  const LEVEL_FG: Record<string, string> = {
    log:   tc.textPrimary,
    info:  tc.primary,
    warn:  tc.warning,
    error: tc.error,
    debug: tc.textMuted,
  };
  const [entries, setEntries] = useState<DevLogEntry[]>(() => getDevLogs());
  const [filter, setFilter] = useState<string>('');
  const [level, setLevel] = useState<'all' | 'log' | 'warn' | 'error'>('all');

  useEffect(() => {
    if (!visible) return;
    setEntries(getDevLogs());
    const unsub = subscribeDevLogs(setEntries);
    return () => unsub();
  }, [visible]);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return entries.filter(e => {
      if (level !== 'all' && e.level !== level) return false;
      if (!needle) return true;
      return e.message.toLowerCase().includes(needle);
    });
  }, [entries, filter, level]);

  // Using Share for both — the iOS share sheet has a "Copy" action so
  // users can still grab the text without a Clipboard dep. Keeping
  // the module dependency footprint small for TestFlight builds.
  const handleShare = async () => {
    const text = formatDevLogs(filtered);
    try { await Share.share({ message: text }); } catch { /* user bailed */ }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.root, { backgroundColor: tc.background, paddingTop: insets.top }]}>
        <View style={[styles.header, { borderBottomColor: tc.border }]}>
          <TouchableOpacity onPress={onClose} style={styles.headerBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Ionicons name="close" size={22} color={tc.textPrimary} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 16, fontWeight: '800', color: tc.textPrimary }}>
              Developer logs
            </Text>
            <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 1 }}>
              {filtered.length} / {entries.length} entries
            </Text>
          </View>
          <TouchableOpacity onPress={handleShare} style={styles.headerBtn}>
            <Ionicons name="share-outline" size={20} color={tc.textPrimary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={clearDevLogs} style={styles.headerBtn}>
            <Ionicons name="trash-outline" size={20} color={tc.error} />
          </TouchableOpacity>
        </View>

        <View style={{ padding: 10, gap: 8 }}>
          <TextInput
            value={filter}
            onChangeText={setFilter}
            placeholder="Filter (e.g. watchSync, watch, [meals])"
            placeholderTextColor={tc.textMuted}
            style={{
              backgroundColor: tc.surface, borderRadius: 10, borderWidth: 1, borderColor: tc.border,
              color: tc.textPrimary, paddingHorizontal: 12, paddingVertical: 8, fontSize: 13,
            }}
            autoCorrect={false}
            autoCapitalize="none"
          />
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {(['all', 'log', 'warn', 'error'] as const).map(l => (
              <TouchableOpacity
                key={l}
                onPress={() => setLevel(l)}
                style={{
                  paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
                  backgroundColor: level === l ? tc.primary : tc.surface,
                  borderWidth: 1, borderColor: level === l ? tc.primary : tc.border,
                }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: level === l ? tc.background : tc.textSecondary }}>
                  {l.toUpperCase()}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 10, paddingBottom: 60 }}>
          {filtered.length === 0 ? (
            <Text style={{ color: tc.textMuted, fontSize: 12, textAlign: 'center', marginTop: 30 }}>
              No logs match. {entries.length === 0 ? 'Try starting a workout or toggling a meal.' : 'Change the filter or level.'}
            </Text>
          ) : filtered.map((e, i) => {
            const t = new Date(e.ts).toISOString().slice(11, 23);
            const fg = LEVEL_FG[e.level] ?? tc.textPrimary;
            return (
              <View key={`${e.ts}-${i}`} style={{
                paddingVertical: 6,
                borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tc.border + '66',
              }}>
                <Text style={{ fontSize: 10, color: tc.textMuted, fontFamily: 'Menlo' }}>
                  {t} · {e.level.toUpperCase()}
                </Text>
                <Text style={{ fontSize: 12, color: fg, fontFamily: 'Menlo', marginTop: 2 }} selectable>
                  {e.message}
                </Text>
              </View>
            );
          })}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 6, paddingVertical: 8,
    borderBottomWidth: 1,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
});
