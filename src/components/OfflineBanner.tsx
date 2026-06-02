// Persistent offline indicator. Renders nothing when online — only
// surfaces when we genuinely can't reach the API.
//
// Mounts at the root so every screen gets the same affordance. The
// banner sits below the status bar and above all content so it doesn't
// fight with safe-area headers. When the queued-changes count is known
// (the WorkoutCompletion offline queue exposes it), we surface that
// inline so the user understands what will happen on reconnect.

import { memo, useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getTheme, radius, spacing } from '../constants/theme';
import { AppThemeName } from '../types';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

interface Props {
  themeName?: AppThemeName;
  /** Optional: number of writes waiting to sync. The offline queue layer
   *  can pipe this in so the user sees "3 changes will sync when online". */
  pendingCount?: number;
}

function OfflineBannerInner({ themeName, pendingCount }: Props) {
  const online = useOnlineStatus();
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const insets = useSafeAreaInsets();
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-12)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: online ? 0 : 1,
        duration: 220,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: online ? -12 : 0,
        duration: 220,
        useNativeDriver: true,
      }),
    ]).start();
  }, [online, opacity, translateY]);

  // After the fade-out completes, stop occupying space at all.
  if (online) {
    return null;
  }

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.root,
        {
          opacity,
          transform: [{ translateY }],
          paddingTop: (insets.top || (Platform.OS === 'ios' ? 12 : 8)) + spacing.xs,
        },
      ]}
      accessibilityRole="alert"
      accessibilityLabel={
        pendingCount && pendingCount > 0
          ? `Offline. ${pendingCount} changes will sync when you're back online.`
          : 'Offline. Changes will sync when you reconnect.'
      }
    >
      <View
        style={[
          styles.pill,
          {
            backgroundColor: tc.warning,
            // ThemeColors doesn't expose a shadow token; fall back to the
            // standard dark slate. Subtle on both light + dark themes.
            shadowColor: '#020617',
          },
        ]}
      >
        <Ionicons name="cloud-offline-outline" size={14} color="#fff" />
        <Text style={styles.label}>
          {pendingCount && pendingCount > 0
            ? `Offline · ${pendingCount} change${pendingCount === 1 ? '' : 's'} queued`
            : 'Offline · changes will sync'}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 9999,
    paddingHorizontal: spacing.md,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + spacing.xxs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + spacing.xxs,
    borderRadius: radius.pill,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 6,
  },
  label: {
    fontSize: 12,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: 0.3,
  },
});

export const OfflineBanner = memo(OfflineBannerInner);
export default OfflineBanner;
