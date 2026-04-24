// Soft prompt for existing users who signed up before birthday
// collection existed. Sits quietly at the top of the Workout tab until
// the user either fills it in or dismisses.
//
// Dismissal is PERMANENT (persisted per-user key in AsyncStorage) — we
// don't want to nag. If the user doesn't want to share their birthday
// that's fine; the app keeps working off the cached `age` int. Over
// time, as users upgrade or re-onboard, they'll naturally migrate.
//
// Hides itself when `profile.birthdate` is already set.

import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import BirthdateInput from './BirthdateInput';
import { validateBirthdate } from '../utils/age';
import { updateBirthdate } from '../services/api';

interface Props {
  authToken: string;
  /** Current profile.birthdate (ISO). When set, the card hides. */
  existingBirthdate?: string | null;
  themeName?: AppThemeName;
  /** Called after successful save with the derived age so the parent
   *  can update its local profile state without a round-trip. */
  onSaved?: (birthdate: string, age: number) => void;
}

const DISMISS_KEY = 'birthdateBackfill_dismissed_v1';

export default function BirthdateBackfillCard({ authToken, existingBirthdate, themeName, onSaved }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [birthdate, setBirthdate] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(DISMISS_KEY)
      .then(v => setDismissed(v === '1'))
      .catch(() => setDismissed(false));
  }, []);

  // Short-circuit: already have birthdate on file, dismissed, or still
  // loading the dismiss flag. Returning null keeps the surrounding
  // layout clean (no spinner / no placeholder).
  if (existingBirthdate) return null;
  if (dismissed == null || dismissed) return null;

  const handleSave = async () => {
    const err = validateBirthdate(birthdate);
    if (err) { Alert.alert('Invalid birthday', err); return; }
    setSaving(true);
    try {
      const res = await updateBirthdate(authToken, birthdate!);
      onSaved?.(birthdate!, res.age);
      await AsyncStorage.setItem(DISMISS_KEY, '1').catch(() => {});
      setDismissed(true);
    } catch (e: any) {
      Alert.alert('Save failed', e?.message ?? 'Could not save your birthday. Try again later.');
    } finally {
      setSaving(false);
    }
  };

  const handleDismiss = async () => {
    await AsyncStorage.setItem(DISMISS_KEY, '1').catch(() => {});
    setDismissed(true);
  };

  return (
    <View style={{
      backgroundColor: tc.surface,
      borderRadius: radius.lg,
      padding: 14,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: tc.primary + '55',
      overflow: 'hidden',
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{
          width: 36, height: 36, borderRadius: 18,
          backgroundColor: tc.primary + '20',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Ionicons name="gift-outline" size={18} color={tc.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary }}>
            Add your birthday
          </Text>
          <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }} numberOfLines={2}>
            Keeps your HR zones + calorie math accurate as you age — takes 5 seconds.
          </Text>
        </View>
        {!expanded && (
          <TouchableOpacity
            onPress={() => setExpanded(true)}
            style={{
              paddingHorizontal: 10, paddingVertical: 6,
              borderRadius: 8, backgroundColor: tc.primary,
            }}>
            <Text style={{ fontSize: 12, fontWeight: '800', color: tc.background }}>Add</Text>
          </TouchableOpacity>
        )}
      </View>
      {expanded && (
        <View style={{ marginTop: 12 }}>
          <BirthdateInput value={birthdate} onChange={setBirthdate} themeName={themeName} label="" />
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            <TouchableOpacity
              onPress={handleDismiss}
              disabled={saving}
              style={{
                flex: 1, paddingVertical: 10, borderRadius: 10,
                backgroundColor: tc.surfaceRaised, borderWidth: 1, borderColor: tc.border,
                alignItems: 'center',
              }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textSecondary }}>Not now</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSave}
              disabled={saving || !birthdate}
              style={{
                flex: 1, paddingVertical: 10, borderRadius: 10,
                backgroundColor: birthdate ? tc.primary : tc.surfaceRaised,
                alignItems: 'center', opacity: saving ? 0.6 : 1,
              }}>
              <Text style={{ fontSize: 13, fontWeight: '800', color: birthdate ? tc.background : tc.textMuted }}>
                {saving ? 'Saving…' : 'Save'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}
