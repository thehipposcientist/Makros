import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import type { AppThemeName, SunExposureCorrectionOption } from '../types';
import { correctionLabel } from '../utils/sunExposure';

interface Props {
  visible: boolean;
  themeName?: AppThemeName;
  onSelect: (option: SunExposureCorrectionOption) => void;
  onClose: () => void;
}

const OPTIONS: SunExposureCorrectionOption[] = [
  'mostly_sunny',
  'mixed',
  'mostly_shaded',
  'indoors',
  'wrong_activity',
  'dismiss',
];

function iconFor(option: SunExposureCorrectionOption): keyof typeof Ionicons.glyphMap {
  switch (option) {
    case 'mostly_sunny': return 'sunny-outline';
    case 'mixed': return 'partly-sunny-outline';
    case 'mostly_shaded': return 'cloud-outline';
    case 'indoors': return 'home-outline';
    case 'wrong_activity': return 'alert-circle-outline';
    case 'dismiss': return 'close-outline';
  }
}

export default function SunExposureCorrectionSheet({ visible, themeName, onSelect, onClose }: Props) {
  const tc = getTheme(themeName).colors;
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { backgroundColor: tc.surface, borderColor: tc.border }]}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, { color: tc.textPrimary }]}>Adjust Estimate</Text>
              <Text style={[styles.sub, { color: tc.textMuted }]}>
                Corrections tune future similar contexts without frequent prompts.
              </Text>
            </View>
            <TouchableOpacity
              testID="sun-correction-close"
              accessibilityLabel="sun-correction-close"
              onPress={onClose}
              style={[styles.close, { borderColor: tc.border }]}>
              <Ionicons name="close" size={18} color={tc.textSecondary} />
            </TouchableOpacity>
          </View>

          {OPTIONS.map((option) => {
            const destructive = option === 'indoors' || option === 'wrong_activity';
            return (
              <TouchableOpacity
                key={option}
                testID={`sun-correction-${option}`}
                accessibilityLabel={`sun-correction-${option}`}
                onPress={() => onSelect(option)}
                style={[styles.option, { borderColor: tc.border }]}>
                <Ionicons
                  name={iconFor(option)}
                  size={18}
                  color={destructive ? tc.warning : tc.primary}
                />
                <Text style={[styles.optionText, { color: tc.textPrimary }]}>
                  {correctionLabel(option)}
                </Text>
              </TouchableOpacity>
            );
          })}

          <Text style={[styles.note, { color: tc.textMuted }]}>
            This is an estimate, not medical advice or exact vitamin D production.
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheet: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    padding: 16,
    gap: 10,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 },
  title: { fontSize: 18, fontWeight: '900' },
  sub: { fontSize: 12, lineHeight: 17, marginTop: 2 },
  close: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  option: {
    minHeight: 46,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  optionText: { fontSize: 14, fontWeight: '800' },
  note: { fontSize: 11, lineHeight: 16, marginTop: 4 },
});

