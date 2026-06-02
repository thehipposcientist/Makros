import { useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform,
  ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AppThemeName } from '../types';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import { mockCheckout, type BillingEntitlement } from '../services/api';

interface Props {
  visible: boolean;
  token: string | null;
  themeName?: AppThemeName;
  onClose: () => void;
  onSuccess: (entitlement: BillingEntitlement) => void | Promise<void>;
}

const PLANS = [
  { id: 'annual', label: 'Annual', price: '$59.99/yr', sub: 'Best value · ~$5/mo' },
  { id: 'monthly', label: 'Monthly', price: '$9.99/mo', sub: 'Cancel anytime' },
] as const;

function formatCardNumber(v: string): string {
  return v.replace(/\D/g, '').slice(0, 16).replace(/(.{4})/g, '$1 ').trim();
}
function formatExpiry(v: string): string {
  const d = v.replace(/\D/g, '').slice(0, 4);
  return d.length <= 2 ? d : `${d.slice(0, 2)}/${d.slice(2)}`;
}

// DUMMY payment form for testing the free→Pro flow. Card inputs are NOT sent
// anywhere — on submit it calls the gated /billing/mock-checkout endpoint,
// which grants Pro with no real charge.
export default function DummyPaymentModal({ visible, token, themeName, onClose, onSuccess }: Props) {
  const tc = getTheme(themeName).colors;
  const onPrimary = getContrastingTextColor(tc.primary);
  const [plan, setPlan] = useState<'annual' | 'monthly'>('annual');
  const [name, setName] = useState('');
  const [card, setCard] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvc, setCvc] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canSubmit =
    card.replace(/\D/g, '').length >= 15 &&
    expiry.replace(/\D/g, '').length === 4 &&
    cvc.replace(/\D/g, '').length >= 3 &&
    !!name.trim() && !submitting && !!token;

  const handleSubscribe = async () => {
    if (!token) return;
    setSubmitting(true);
    try {
      const entitlement = await mockCheckout(token);
      await onSuccess(entitlement);
      onClose();
      Alert.alert('Pro active (test)', 'Dummy checkout complete — you now have Pro. No real charge was made.');
    } catch (e: any) {
      Alert.alert(
        'Test checkout failed',
        e?.message ?? 'Could not complete the dummy checkout. Make sure DUMMY_BILLING_ENABLED is set on the backend.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ width: '100%' }}>
          <View style={[styles.sheet, { backgroundColor: tc.surface, borderColor: tc.border }]}>
            <View style={styles.header}>
              <Text style={[styles.title, { color: tc.textPrimary }]}>Upgrade to Pro</Text>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={tc.textMuted} />
              </TouchableOpacity>
            </View>

            <View style={[styles.testBanner, { backgroundColor: tc.warning + '1A', borderColor: tc.warning + '55' }]}>
              <Ionicons name="flask-outline" size={14} color={tc.warning} />
              <Text style={[styles.testBannerText, { color: tc.warning }]}>Test mode — no real charge. Card details are ignored.</Text>
            </View>

            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <View style={styles.planRow}>
                {PLANS.map(p => {
                  const active = plan === p.id;
                  return (
                    <TouchableOpacity
                      key={p.id}
                      activeOpacity={0.85}
                      onPress={() => setPlan(p.id)}
                      style={[styles.planCard, { borderColor: active ? tc.primary : tc.border, backgroundColor: active ? tc.primary + '14' : tc.surfaceRaised }]}>
                      <Text style={[styles.planLabel, { color: tc.textPrimary }]}>{p.label}</Text>
                      <Text style={[styles.planPrice, { color: active ? tc.primary : tc.textPrimary }]}>{p.price}</Text>
                      <Text style={[styles.planSub, { color: tc.textMuted }]}>{p.sub}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={[styles.fieldLabel, { color: tc.textMuted }]}>Cardholder name</Text>
              <TextInput
                value={name} onChangeText={setName}
                placeholder="Jane Appleseed" placeholderTextColor={tc.textMuted}
                style={[styles.input, { color: tc.textPrimary, backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}
              />
              <Text style={[styles.fieldLabel, { color: tc.textMuted }]}>Card number</Text>
              <TextInput
                value={card} onChangeText={t => setCard(formatCardNumber(t))}
                placeholder="4242 4242 4242 4242" placeholderTextColor={tc.textMuted} keyboardType="number-pad"
                style={[styles.input, { color: tc.textPrimary, backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}
              />
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.fieldLabel, { color: tc.textMuted }]}>Expiry</Text>
                  <TextInput
                    value={expiry} onChangeText={t => setExpiry(formatExpiry(t))}
                    placeholder="MM/YY" placeholderTextColor={tc.textMuted} keyboardType="number-pad"
                    style={[styles.input, { color: tc.textPrimary, backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.fieldLabel, { color: tc.textMuted }]}>CVC</Text>
                  <TextInput
                    value={cvc} onChangeText={t => setCvc(t.replace(/\D/g, '').slice(0, 4))}
                    placeholder="123" placeholderTextColor={tc.textMuted} keyboardType="number-pad" secureTextEntry
                    style={[styles.input, { color: tc.textPrimary, backgroundColor: tc.surfaceRaised, borderColor: tc.border }]}
                  />
                </View>
              </View>

              <TouchableOpacity
                disabled={!canSubmit}
                onPress={handleSubscribe}
                activeOpacity={0.85}
                style={[styles.payBtn, { backgroundColor: canSubmit ? tc.primary : tc.border }]}>
                {submitting ? <ActivityIndicator color={onPrimary} /> : <Text style={[styles.payBtnText, { color: onPrimary }]}>Subscribe (test)</Text>}
              </TouchableOpacity>
              <Text style={[styles.disclaimer, { color: tc.textMuted }]}>
                This is a placeholder checkout for testing. Real billing is not connected.
              </Text>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1,
    paddingHorizontal: 18, paddingTop: 14, paddingBottom: 24, maxHeight: '88%',
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  title: { fontSize: 20, fontWeight: '900' },
  testBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 14,
  },
  testBannerText: { fontSize: 11, fontWeight: '800', flex: 1 },
  planRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  planCard: { flex: 1, borderWidth: 1.5, borderRadius: radius.md, padding: 12 },
  planLabel: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4 },
  planPrice: { fontSize: 18, fontWeight: '900', marginTop: 4 },
  planSub: { fontSize: 10.5, fontWeight: '600', marginTop: 2 },
  fieldLabel: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 5, marginTop: 10 },
  input: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 11, fontSize: 15, fontWeight: '600' },
  payBtn: { borderRadius: radius.md, paddingVertical: 15, alignItems: 'center', marginTop: 20 },
  payBtnText: { fontSize: 16, fontWeight: '900' },
  disclaimer: { fontSize: 10.5, lineHeight: 14, textAlign: 'center', marginTop: 12 },
});
