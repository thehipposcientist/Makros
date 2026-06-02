// Canonical modal primitives. Two flavors:
//
//   <BaseBottomSheet> — slides up from the bottom. Default. Use this
//     for almost every modal — sheets feel native on iOS and are easier
//     to dismiss one-handed. The swipe-down-to-dismiss + drag handle +
//     safe-area + backdrop press behavior is built-in.
//
//   <BaseModal> — centered card with a backdrop. Use ONLY for confirm-
//     style interruptions ("Delete this meal?", "Sign out?") where the
//     user must explicitly choose. NOT for content browsing.
//
// Both wrap React Native's Modal so they inherit hardware back behavior
// on Android. Both honor `themeName` and `onRequestClose` consistently.
// Both pass an `accessibilityViewIsModal` so VoiceOver traps focus.

import { memo, type ReactNode } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getTheme, hitSlop, radius, spacing } from '../constants/theme';
import { AppThemeName } from '../types';
import BottomSheetDismissHandle from './BottomSheetDismissHandle';

interface CommonProps {
  visible: boolean;
  onClose: () => void;
  themeName?: AppThemeName;
  /** Short text shown at the top of the sheet. Optional — omit for
   *  surfaces whose first content row IS the title. */
  title?: string;
  /** Optional supporting line under the title. */
  subtitle?: string;
  /** Pass-through children. Default container is a ScrollView; pass
   *  `scrollable={false}` to opt out and own your own layout. */
  children: ReactNode;
  testID?: string;
}

interface BottomSheetProps extends CommonProps {
  /** Cap height to a fraction of screen. Default 0.85 leaves a peek of
   *  the underlying screen so the user knows they can dismiss. */
  maxHeightFraction?: number;
  /** Wrap children in a ScrollView (default true). Disable when you
   *  manage your own scrollable list to avoid nested-scroll issues. */
  scrollable?: boolean;
  /** Show the drag handle (default true). Hide on confirmation sheets. */
  showHandle?: boolean;
}

export function BaseBottomSheetInner({
  visible,
  onClose,
  themeName,
  title,
  subtitle,
  children,
  maxHeightFraction = 0.85,
  scrollable = true,
  showHandle = true,
  testID,
}: BottomSheetProps) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      testID={testID}
    >
      <View style={styles.sheetBackdrop}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          style={StyleSheet.absoluteFillObject}
          onPress={onClose}
        />
        <View
          accessibilityViewIsModal
          style={[
            styles.sheetCard,
            {
              backgroundColor: tc.background,
              maxHeight: `${Math.round(maxHeightFraction * 100)}%` as any,
              paddingBottom: insets.bottom || spacing.lg,
            },
          ]}
        >
          {showHandle ? (
            <BottomSheetDismissHandle
              onClose={onClose}
              color={tc.border}
              containerStyle={styles.handleContainer}
            />
          ) : null}
          {title ? (
            <View style={styles.sheetHeader}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={[styles.sheetTitle, { color: tc.textPrimary }]}
                  numberOfLines={1}
                >
                  {title}
                </Text>
                {subtitle ? (
                  <Text
                    style={[styles.sheetSubtitle, { color: tc.textMuted }]}
                    numberOfLines={2}
                  >
                    {subtitle}
                  </Text>
                ) : null}
              </View>
              <TouchableOpacity
                onPress={onClose}
                hitSlop={hitSlop.icon}
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <Ionicons name="close" size={22} color={tc.textMuted} />
              </TouchableOpacity>
            </View>
          ) : null}
          {scrollable ? (
            <ScrollView
              contentContainerStyle={styles.sheetScrollContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              {children}
            </ScrollView>
          ) : (
            <View style={styles.sheetContent}>{children}</View>
          )}
        </View>
      </View>
    </Modal>
  );
}

export const BaseBottomSheet = memo(BaseBottomSheetInner);

interface ConfirmModalProps extends CommonProps {
  /** Width as a fraction of the screen. Default 0.85. */
  widthFraction?: number;
}

export function BaseModalInner({
  visible,
  onClose,
  themeName,
  title,
  subtitle,
  children,
  widthFraction = 0.85,
  testID,
}: ConfirmModalProps) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      testID={testID}
    >
      <View style={styles.modalBackdrop}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          style={StyleSheet.absoluteFillObject}
          onPress={onClose}
        />
        <View
          accessibilityViewIsModal
          style={[
            styles.modalCard,
            {
              backgroundColor: tc.background,
              borderColor: tc.border,
              width: `${Math.round(widthFraction * 100)}%` as any,
            },
          ]}
        >
          {title ? (
            <View style={styles.modalHeader}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={[styles.modalTitle, { color: tc.textPrimary }]}
                >
                  {title}
                </Text>
                {subtitle ? (
                  <Text style={[styles.modalSubtitle, { color: tc.textMuted }]}>
                    {subtitle}
                  </Text>
                ) : null}
              </View>
              <TouchableOpacity
                onPress={onClose}
                hitSlop={hitSlop.icon}
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <Ionicons name="close" size={20} color={tc.textMuted} />
              </TouchableOpacity>
            </View>
          ) : null}
          <View style={styles.modalContent}>{children}</View>
        </View>
      </View>
    </Modal>
  );
}

export const BaseModal = memo(BaseModalInner);

const styles = StyleSheet.create({
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheetCard: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing.lg,
    paddingTop: Platform.OS === 'ios' ? spacing.xs : spacing.sm,
  },
  handleContainer: {
    paddingVertical: spacing.xs,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  sheetSubtitle: {
    fontSize: 12,
    marginTop: spacing.xxs,
  },
  sheetScrollContent: {
    paddingBottom: spacing.xl,
  },
  sheetContent: {
    paddingBottom: spacing.md,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  modalCard: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    maxWidth: 480,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '800',
  },
  modalSubtitle: {
    fontSize: 12,
    marginTop: spacing.xxs,
  },
  modalContent: {
    gap: spacing.sm,
  },
});

export default BaseBottomSheet;
