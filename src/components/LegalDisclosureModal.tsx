import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { LEGAL_SECTIONS, LEGAL_VERSION } from '../constants/legal';
import { colors, radius } from '../constants/theme';

type ThemeColors = typeof colors;

interface Props {
  visible: boolean;
  onClose: () => void;
  themeColors?: Partial<ThemeColors>;
}

export default function LegalDisclosureModal({ visible, onClose, themeColors }: Props) {
  const c = { ...colors, ...(themeColors ?? {}) };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { backgroundColor: c.surface, borderColor: c.border }]}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, { color: c.textPrimary }]}>Legal And Safety</Text>
              <Text style={[styles.version, { color: c.textMuted }]}>Version {LEGAL_VERSION}</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={[styles.closeIcon, { color: c.textMuted }]}>x</Text>
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator contentContainerStyle={styles.content}>
            {LEGAL_SECTIONS.map((section) => (
              <View key={section.title} style={[styles.section, { borderColor: c.border, backgroundColor: c.surfaceRaised }]}>
                <Text style={[styles.sectionTitle, { color: c.textPrimary }]}>{section.title}</Text>
                <Text style={[styles.sectionBody, { color: c.textSecondary }]}>{section.body}</Text>
              </View>
            ))}
            <Text style={[styles.note, { color: c.textMuted }]}>
              These in-app terms are launch-ready product copy, not a substitute for attorney-reviewed legal documents.
            </Text>
          </ScrollView>

          <TouchableOpacity style={[styles.doneBtn, { backgroundColor: c.primary }]} onPress={onClose}>
            <Text style={[styles.doneText, { color: c.background }]}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    padding: 20,
  },
  sheet: {
    borderRadius: 20,
    borderWidth: 1,
    maxHeight: '86%',
    padding: 18,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  title: { fontSize: 20, fontWeight: '800' },
  version: { fontSize: 11, marginTop: 3, fontWeight: '600' },
  closeIcon: { fontSize: 20, fontWeight: '700' },
  content: { gap: 12, paddingBottom: 10 },
  section: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 14,
  },
  sectionTitle: { fontSize: 14, fontWeight: '800', marginBottom: 6 },
  sectionBody: { fontSize: 13, lineHeight: 19 },
  note: { fontSize: 11, lineHeight: 16, fontStyle: 'italic' },
  doneBtn: {
    borderRadius: radius.md,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 12,
  },
  doneText: { fontSize: 15, fontWeight: '800' },
});
