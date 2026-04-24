// Fueling & Recovery Signals — flag-based card.
//
// Hidden when all flags are green. When 1+ flag is amber/red, a compact
// strip appears; tap to open a full drill-down modal with per-flag detail,
// action, and a "not a medical diagnosis" footer.
//
// No hormone names. No scores. Ever.

import { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, Modal, ScrollView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { getRecoveryFlags, RecoveryFlag } from '../services/api';

interface Props {
  authToken: string;
  themeName?: AppThemeName;
  thyroidOptIn?: boolean;
}

export default function FuelingRecoveryCard({ authToken, themeName, thyroidOptIn }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;

  const [flags, setFlags] = useState<RecoveryFlag[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getRecoveryFlags(authToken, { thyroid_opt_in: !!thyroidOptIn });
      setFlags(res.flags || []);
    } catch {
      setFlags([]);
    } finally {
      setLoading(false);
    }
  }, [authToken, thyroidOptIn]);

  useEffect(() => { load(); }, [load]);

  if (loading) return null;
  const actionable = flags.filter(f => f.state === 'amber' || f.state === 'red');
  if (actionable.length === 0) return null;

  const worst = actionable.find(f => f.state === 'red') ?? actionable[0];
  const badgeColor = worst.state === 'red' ? tc.error : tc.warning;

  return (
    <>
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={() => setModalOpen(true)}
        style={{
          flexDirection: 'row', alignItems: 'center', gap: 10,
          backgroundColor: tc.surface, borderRadius: radius.lg,
          paddingVertical: 10, paddingHorizontal: 12, marginBottom: 12,
          borderWidth: 1, borderColor: badgeColor + '44',
        }}
      >
        <View style={{
          width: 8, height: 8, borderRadius: 4, backgroundColor: badgeColor,
        }} />
        <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textPrimary, flex: 1 }}>
          {actionable.length === 1
            ? `${worst.label} needs attention`
            : `${actionable.length} recovery signals need attention`}
        </Text>
        <Ionicons name="chevron-forward" size={14} color={tc.textMuted} />
      </TouchableOpacity>

      <FuelingRecoveryModal
        visible={modalOpen}
        flags={flags}
        onClose={() => setModalOpen(false)}
        tc={tc}
      />
    </>
  );
}

function FuelingRecoveryModal({
  visible, flags, onClose, tc,
}: { visible: boolean; flags: RecoveryFlag[]; onClose: () => void; tc: any }) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: tc.background }}>
        <View style={{
          flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16,
          paddingTop: Platform.OS === 'ios' ? 8 : 24, paddingBottom: 12,
          borderBottomWidth: 1, borderBottomColor: tc.border,
        }}>
          <Text style={{ fontSize: 18, fontWeight: '800', color: tc.textPrimary, flex: 1 }}>
            Fueling & Recovery Signals
          </Text>
          <TouchableOpacity onPress={onClose}>
            <Ionicons name="close" size={24} color={tc.textPrimary} />
          </TouchableOpacity>
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 12 }}>
          {flags.map(f => <FlagCard key={f.key} flag={f} tc={tc} />)}
          <View style={{
            marginTop: 8, padding: 12, borderRadius: radius.md,
            backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
          }}>
            <Text style={{ fontSize: 11, color: tc.textMuted, lineHeight: 16 }}>
              These are nutrition-pattern signals, not a medical diagnosis. They flag when your
              food log suggests sustained under-fueling, low fat intake, or gaps in recovery
              nutrients — not a specific hormone level. If you have medical concerns, talk to
              your doctor.
            </Text>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

function FlagCard({ flag, tc }: { flag: RecoveryFlag; tc: any }) {
  const color =
    flag.state === 'red' ? tc.error :
    flag.state === 'amber' ? tc.warning :
    flag.state === 'green' ? tc.success :
    tc.textMuted;
  const stateLabel =
    flag.state === 'not_enough_data' ? 'Not enough data' :
    flag.state === 'green' ? 'On track' :
    flag.state === 'amber' ? 'Watch' : 'Needs attention';

  return (
    <View style={{
      padding: 14, borderRadius: radius.lg,
      backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />
        <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textPrimary, flex: 1 }}>
          {flag.label}
        </Text>
        <Text style={{ fontSize: 10, fontWeight: '700', color, letterSpacing: 0.5 }}>
          {stateLabel.toUpperCase()}
        </Text>
      </View>
      <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 17 }}>
        {flag.detail}
      </Text>
      {flag.action ? (
        <Text style={{ fontSize: 12, color: tc.textPrimary, marginTop: 8, fontWeight: '600' }}>
          → {flag.action}
        </Text>
      ) : null}
    </View>
  );
}
