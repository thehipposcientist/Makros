import { useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { LEGAL_SECTIONS, LEGAL_VERSION } from '../constants/legal';
import { colors, radius } from '../constants/theme';

type ThemeColors = typeof colors;

interface Props {
  visible: boolean;
  onClose: () => void;
  themeColors?: Partial<ThemeColors>;
  /** When set, the modal renders in re-acceptance mode:
   *  - The dismiss "x" is hidden so the user can't bypass review.
   *  - The button reads "I Agree" instead of "Done".
   *  - Tapping the button calls `onAccept`, which is expected to POST
   *    to /auth/accept-legal. While the POST is in flight the button
   *    shows a spinner.
   *  When unset, the modal is read-only with a "Done" button — the
   *  legacy "review what I accepted at signup" view from Settings.
   */
  onAccept?: () => Promise<void> | void;
  /** Bumped to >0 means the user already accepted some prior version
   *  but a section's body changed. We surface a small "Updated" banner
   *  at the top so users know this isn't a first-time prompt. */
  isReAcceptance?: boolean;
}

export default function LegalDisclosureModal({ visible, onClose, themeColors, onAccept, isReAcceptance }: Props) {
  const c = { ...colors, ...(themeColors ?? {}) };
  const [submitting, setSubmitting] = useState(false);
  const mustAccept = !!onAccept;
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      // Re-acceptance: hardware-back / system close should NOT dismiss
      // the modal — the user has to actually tap "I Agree". Pass a
      // no-op handler instead of `onClose` so the OS can't bypass it.
      onRequestClose={mustAccept ? () => undefined : onClose}
    >
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { backgroundColor: c.surface, borderColor: c.border }]}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, { color: c.textPrimary }]}>Legal And Safety</Text>
              <Text style={[styles.version, { color: c.textMuted }]}>Version {LEGAL_VERSION}</Text>
            </View>
            {!mustAccept && (
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={[styles.closeIcon, { color: c.textMuted }]}>x</Text>
              </TouchableOpacity>
            )}
          </View>

          {isReAcceptance && (
            <View style={[styles.updatedBanner, { backgroundColor: c.primary + '18', borderColor: c.primary + '55' }]}>
              <Text style={[styles.updatedTitle, { color: c.primary }]}>
                We updated our terms.
              </Text>
              <Text style={[styles.updatedBody, { color: c.textSecondary }]}>
                Please review the latest version of our Terms, Privacy Policy, Health Disclaimer, and AI Disclosure. Continued use requires re-acceptance.
              </Text>
            </View>
          )}

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

          <TouchableOpacity
            style={[styles.doneBtn, { backgroundColor: c.primary, opacity: submitting ? 0.6 : 1 }]}
            disabled={submitting}
            onPress={async () => {
              if (!mustAccept) { onClose(); return; }
              setSubmitting(true);
              try { await onAccept(); }
              finally { setSubmitting(false); }
            }}
          >
            {submitting
              ? <ActivityIndicator color={c.background} />
              : <Text style={[styles.doneText, { color: c.background }]}>{mustAccept ? 'I Agree' : 'Done'}</Text>}
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
  updatedBanner: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 12,
    marginBottom: 12,
  },
  updatedTitle: { fontSize: 13, fontWeight: '800', marginBottom: 4 },
  updatedBody: { fontSize: 12, lineHeight: 17 },
  doneBtn: {
    borderRadius: radius.md,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 12,
  },
  doneText: { fontSize: 15, fontWeight: '800' },
});
