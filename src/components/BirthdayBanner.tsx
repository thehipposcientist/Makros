// One-day "happy birthday" banner for the workout tab.
//
// Behavior:
//   - Renders only when today's MM-DD matches the user's birthdate.
//   - Dismissable. Dismissal is persisted under a year-specific key so
//     it reappears next year automatically.
//   - Subtle confetti-style icon row + theme-tinted card. Designed to
//     feel celebratory without being intrusive — fitness apps that
//     overdo this veer into cringey territory fast.
//   - No push notification, no email — surface-level only.
//
// Reads UserProfile.physicalStats.birthdate (YYYY-MM-DD) directly.

import { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import {
  ageOnBirthday,
  birthdayDismissKey,
  isBirthdayToday,
  pickBirthdayGreeting,
} from '../utils/birthday';

interface Props {
  birthdate?: string | null;
  displayName?: string | null;
  themeName?: AppThemeName;
}

export default function BirthdayBanner({ birthdate, displayName, themeName }: Props) {
  const tc = getTheme(themeName).colors;
  const [dismissed, setDismissed] = useState<boolean | null>(null);  // null = checking
  const fade = useState(new Animated.Value(0))[0];

  const isToday = isBirthdayToday(birthdate ?? null);
  const age = ageOnBirthday(birthdate ?? null);

  // Hydrate dismissal state from AsyncStorage on first show.
  useEffect(() => {
    if (!isToday) { setDismissed(true); return; }
    let cancelled = false;
    (async () => {
      try {
        const flag = await AsyncStorage.getItem(birthdayDismissKey());
        if (!cancelled) setDismissed(flag === '1');
      } catch {
        if (!cancelled) setDismissed(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isToday]);

  // Fade in once we know the banner should render.
  useEffect(() => {
    if (dismissed === false) {
      Animated.timing(fade, {
        toValue: 1, duration: 420, easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
  }, [dismissed, fade]);

  const handleDismiss = useCallback(async () => {
    Animated.timing(fade, {
      toValue: 0, duration: 240, easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(() => setDismissed(true));
    try { await AsyncStorage.setItem(birthdayDismissKey(), '1'); } catch {}
  }, [fade]);

  if (!isToday || dismissed !== false) return null;

  const greeting = pickBirthdayGreeting(displayName);
  const subtitle = displayName
    ? `${greeting}, ${displayName}!`
    : `${greeting}!`;
  const ageLine = age != null
    ? `You're ${age} today — strongest version yet.`
    : 'Strongest version yet.';

  return (
    <Animated.View style={{ opacity: fade, transform: [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] }) }] }}>
      <View
        accessibilityRole="text"
        accessibilityLabel={`${subtitle} ${ageLine}`}
        style={{
          marginHorizontal: 16,
          marginTop: 12,
          marginBottom: 8,
          padding: 14,
          borderRadius: radius.lg,
          backgroundColor: tc.primary + '14',
          borderWidth: 1,
          borderColor: tc.primary + '55',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
        }}
      >
        {/* Iconography — three small symbols beat one giant cake. The
            offset keeps them from looking like a stamp. */}
        <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: tc.primary + '22', alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="gift-outline" size={18} color={tc.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Text style={{ fontSize: 15, fontWeight: '800', color: tc.textPrimary }}>{subtitle}</Text>
            <Ionicons name="sparkles" size={13} color={tc.primary} />
          </View>
          <Text style={{ fontSize: 12, color: tc.textSecondary, marginTop: 2, lineHeight: 16 }}>
            {ageLine}
          </Text>
        </View>
        <TouchableOpacity
          onPress={handleDismiss}
          accessibilityLabel="Dismiss birthday banner"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          style={{ padding: 4 }}>
          <Ionicons name="close" size={18} color={tc.textMuted} />
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}
