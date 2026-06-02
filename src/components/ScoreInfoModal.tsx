// Generic "How is this calculated?" modal used by cards that show
// derived scores (readiness, recovery, adherence, training, etc).
//
// Mirrors the `quickDetailSheet` look from ProgressScreen so all
// explainer modals feel like the same surface. The body is supplied
// as children so each card can describe its own inputs / weights /
// rating bands without forking the layout.
//
// Usage:
//
//   <ScoreInfoModal
//     visible={open}
//     onClose={() => setOpen(false)}
//     eyebrow="TRAINING READINESS"
//     title="How it's calculated"
//     iconName="flash-outline"
//     iconColor={tc.primary}
//     themeName={themeName}
//   >
//     <ScoreInfoSection title="What goes in">
//       <ScoreInfoRow label="Sleep" value="last night + 14d baseline" />
//       ...
//     </ScoreInfoSection>
//   </ScoreInfoModal>

import React from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import type { AppThemeName } from '../types';
import BottomSheetDismissHandle from './BottomSheetDismissHandle';

interface Props {
  visible: boolean;
  onClose: () => void;
  eyebrow: string;
  title: string;
  iconName: React.ComponentProps<typeof Ionicons>['name'];
  iconColor: string;
  themeName?: AppThemeName;
  children: React.ReactNode;
}

export function ScoreInfoModal({
  visible, onClose, eyebrow, title, iconName, iconColor, themeName, children,
}: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.backdrop, { backgroundColor: '#00000088' }]}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.sheet, { backgroundColor: tc.surface }]}>
          <BottomSheetDismissHandle
            onClose={onClose}
            color={tc.border}
            containerStyle={styles.handleHitArea}
            handleStyle={styles.handle}
          />
          <View style={styles.header}>
            <View style={[styles.iconWrap, { backgroundColor: iconColor + '22' }]}>
              <Ionicons name={iconName} size={18} color={iconColor} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.eyebrow, { color: tc.textMuted }]} numberOfLines={1}>{eyebrow}</Text>
              <Text style={[styles.title, { color: tc.textPrimary }]} numberOfLines={2}>{title}</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={20} color={tc.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.scroll} contentContainerStyle={{ paddingBottom: 8 }} showsVerticalScrollIndicator={false}>
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

interface SectionProps {
  title?: string;
  themeName?: AppThemeName;
  children: React.ReactNode;
}

export function ScoreInfoSection({ title, themeName, children }: SectionProps) {
  const tc = getTheme(themeName).colors;
  return (
    <View style={styles.section}>
      {title && <Text style={[styles.sectionTitle, { color: tc.textPrimary }]}>{title}</Text>}
      {children}
    </View>
  );
}

interface BodyProps {
  themeName?: AppThemeName;
  muted?: boolean;
  children: React.ReactNode;
}

export function ScoreInfoBody({ themeName, muted, children }: BodyProps) {
  const tc = getTheme(themeName).colors;
  return (
    <Text style={[styles.body, { color: muted ? tc.textMuted : tc.textSecondary }]}>{children}</Text>
  );
}

interface RowProps {
  label: string;
  value?: string;
  valueColor?: string;
  themeName?: AppThemeName;
}

export function ScoreInfoRow({ label, value, valueColor, themeName }: RowProps) {
  const tc = getTheme(themeName).colors;
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: tc.textSecondary }]}>{label}</Text>
      {value != null && (
        <Text style={[styles.rowValue, { color: valueColor ?? tc.textSecondary }]} numberOfLines={2}>{value}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: radius.xl ?? 20,
    borderTopRightRadius: radius.xl ?? 20,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 28,
    maxHeight: '85%',
  },
  handleHitArea: {
    minHeight: 14,
    paddingBottom: 10,
    justifyContent: 'flex-start',
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 12,
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyebrow: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    marginTop: 2,
  },
  scroll: {
    maxHeight: 480,
  },
  body: {
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 12,
  },
  section: {
    marginBottom: 14,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.4,
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 5,
    gap: 12,
  },
  rowLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  rowValue: {
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
    textAlign: 'right',
  },
});

export default ScoreInfoModal;
