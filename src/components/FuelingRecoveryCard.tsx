// Fueling & Recovery Signals — flag-based card.
//
// Hidden when all flags are green. When 1+ flag is amber/red, a compact
// strip appears; tap to open a full drill-down modal with per-flag detail,
// action, and a "not a medical diagnosis" footer.
//
// No hormone names. No scores. Ever.

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Modal, ScrollView, Platform, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { getRecoveryFlags, RecoveryFlag } from '../services/api';
import FadeInView from './FadeInView';

interface Props {
  authToken: string;
  themeName?: AppThemeName;
  thyroidOptIn?: boolean;
  variant?: 'card' | 'note' | 'button';
  overPhoto?: boolean;
  photoTone?: 'dark' | 'light';
}

/** 8px alert dot with a soft, looping pulse — opacity 1.0 → 0.55 → 1.0
 *  paired with a subtle 1.0 → 1.4 → 1.0 scale halo. Only shown on the
 *  fueling-recovery summary row so the eye is drawn to actionable
 *  signals without nagging when everything is green. */
function PulsingDot({ color }: { color: string }) {
  const opacity = useRef(new Animated.Value(1)).current;
  const haloScale = useRef(new Animated.Value(1)).current;
  const haloOpacity = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(opacity, { toValue: 0.55, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.parallel([
            Animated.timing(haloScale,   { toValue: 1.8, duration: 1100, easing: Easing.out(Easing.quad), useNativeDriver: true }),
            Animated.timing(haloOpacity, { toValue: 0,   duration: 1100, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          ]),
          Animated.parallel([
            Animated.timing(haloScale,   { toValue: 1,   duration: 0, useNativeDriver: true }),
            Animated.timing(haloOpacity, { toValue: 0.5, duration: 0, useNativeDriver: true }),
          ]),
          Animated.delay(300),
        ]),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, haloScale, haloOpacity]);
  return (
    <View style={{ width: 8, height: 8, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={{
        position: 'absolute', width: 8, height: 8, borderRadius: 4,
        backgroundColor: color, opacity: haloOpacity,
        transform: [{ scale: haloScale }],
      }} />
      <Animated.View style={{
        width: 8, height: 8, borderRadius: 4, backgroundColor: color, opacity,
      }} />
    </View>
  );
}

// All props are primitives, so memo fully shields this card (and its
// network fetch + animation loop) from HomeScreen's frequent re-renders.
export default memo(FuelingRecoveryCard);

function FuelingRecoveryCard({ authToken, themeName, thyroidOptIn, variant = 'card', overPhoto = false, photoTone = 'dark' }: Props) {
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
  const isNote = variant === 'note';
  const isButton = variant === 'button';
  const lightPhoto = overPhoto && photoTone === 'light';
  const photoButtonBackground = lightPhoto ? tc.surface + 'E6' : 'rgba(255,255,255,0.16)';
  const photoButtonBorder = lightPhoto ? tc.border + 'B8' : 'rgba(255,255,255,0.34)';
  const buttonBackground = isButton && overPhoto ? photoButtonBackground : isButton ? badgeColor : isNote ? badgeColor + '10' : tc.surface;
  const buttonBorder = isButton && overPhoto ? photoButtonBorder : isButton ? badgeColor : isNote ? badgeColor + '2E' : badgeColor + '44';
  const buttonTextColor = isButton ? (lightPhoto ? tc.textPrimary : '#fff') : tc.textPrimary;
  const buttonIconColor = isButton ? (lightPhoto ? badgeColor : '#fff') : badgeColor;

  return (
    <>
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={() => setModalOpen(true)}
        style={{
          flexDirection: 'row', alignItems: 'center', gap: 10,
          alignSelf: isButton ? 'flex-start' : undefined,
          backgroundColor: buttonBackground,
          borderRadius: isButton ? 999 : isNote ? radius.md : radius.lg,
          paddingVertical: isButton ? 5 : isNote ? 8 : 10,
          paddingHorizontal: isButton ? 8 : isNote ? 10 : 12,
          marginTop: isNote ? 8 : 0,
          marginBottom: isNote || isButton ? 0 : 12,
          borderWidth: 1,
          borderColor: buttonBorder,
        }}
      >
        {isButton ? (
          <Ionicons name="alert" size={10} color={buttonIconColor} />
        ) : isNote ? (
          <View style={{
            width: 18, height: 18, borderRadius: 9,
            backgroundColor: badgeColor + '18',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <Ionicons name="alert" size={12} color={buttonIconColor} />
          </View>
        ) : (
          <PulsingDot color={badgeColor} />
        )}
        <View style={{ flex: isButton ? 0 : 1 }}>
          <Text
            style={{ fontSize: isButton ? 10 : isNote ? 11 : 12, fontWeight: '800', color: buttonTextColor }}
            numberOfLines={1}
          >
            {actionable.length === 1
              ? (isButton ? 'Nutrient check' : isNote ? `${worst.label}: quick check` : `${worst.label} needs attention`)
              : (isButton ? `${actionable.length} nutrient notes` : isNote ? `${actionable.length} recovery notes to review` : `${actionable.length} recovery signals need attention`)}
          </Text>
          {!isButton && worst.detail ? (
            <Text style={{ fontSize: isNote ? 10 : 11, color: tc.textMuted, marginTop: 2 }} numberOfLines={isNote ? 2 : 1}>
              {worst.detail}
            </Text>
          ) : null}
        </View>
        {!isButton ? <Ionicons name="chevron-forward" size={isNote ? 12 : 14} color={tc.textMuted} /> : null}
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
          {flags.map((f, i) => (
            <FadeInView key={f.key} delay={i * 60} duration={260} slideDistance={8}>
              <FlagCard flag={f} tc={tc} />
            </FadeInView>
          ))}
          <View style={{
            marginTop: 8, padding: 12, borderRadius: radius.md,
            backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
          }}>
            <Text style={{ fontSize: 11, color: tc.textMuted, lineHeight: 16 }}>
              These are nutrition-pattern signals, not a medical diagnosis. They flag when your
              food log suggests sustained under-fueling, low fat intake, or gaps in recovery
              nutrients — not a specific hormone level. If you have medical concerns, talk to
              a clinician.
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
