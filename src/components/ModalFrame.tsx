/**
 * ModalFrame — shared wrapper for the 28+ modal surfaces in the app
 * that were each drifting on backdrop opacity, safe-area handling,
 * title styling, and dismiss affordances.
 *
 * Two variants:
 *   - `sheet`    — rises from the bottom; rounded top corners. Use for
 *                  contextual editors (meal, set notes, plate calculator).
 *   - `centered` — fades in centered on screen with a dialog look. Use
 *                  for confirms, info panels, picker prompts.
 *
 * Migration: pass `<ModalFrame visible title="..." onClose={...}>` around
 * existing JSX bodies and remove the per-modal backdrop / header
 * boilerplate. Existing modals can stay as-is — this is an
 * additive primitive, not a forced refactor.
 */
import React from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, ScrollView, KeyboardAvoidingView, Platform, StyleProp, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getTheme, radius } from '../constants/theme';
import type { AppThemeName } from '../types';
import BottomSheetDismissHandle from './BottomSheetDismissHandle';

type Variant = 'sheet' | 'centered';

interface Props {
  visible: boolean;
  themeName?: AppThemeName;
  variant?: Variant;
  title?: string;
  subtitle?: string;
  onClose: () => void;
  /** Show the default close (×) button in the header. Defaults to true. */
  showClose?: boolean;
  /** Wrap children in a vertical ScrollView. Use for tall content
   *  (forms, lists). Defaults to false. */
  scrollable?: boolean;
  /** Tap-outside-to-dismiss. Defaults to true. */
  dismissOnBackdrop?: boolean;
  /** Inset the inner content. Pass `0` for full-bleed (e.g. media). */
  contentPadding?: number;
  /** Override the body container style. */
  bodyStyle?: StyleProp<ViewStyle>;
  /** Optional right-side action in the header (e.g. "Save"). */
  headerRight?: React.ReactNode;
  testID?: string;
  children: React.ReactNode;
}

export default function ModalFrame({
  visible,
  themeName,
  variant = 'sheet',
  title,
  subtitle,
  onClose,
  showClose = true,
  scrollable = false,
  dismissOnBackdrop = true,
  contentPadding = 16,
  bodyStyle,
  headerRight,
  testID,
  children,
}: Props) {
  const insets = useSafeAreaInsets();
  const colors = getTheme(themeName).colors;
  const isSheet = variant === 'sheet';

  const Container: any = scrollable ? ScrollView : View;
  const containerProps = scrollable
    ? { showsVerticalScrollIndicator: false, contentContainerStyle: [{ padding: contentPadding }, bodyStyle] }
    : { style: [{ padding: contentPadding }, bodyStyle] };

  const sheetPaddingBottom = isSheet ? Math.max(insets.bottom, 12) : 0;

  return (
    <Modal
      visible={visible}
      transparent
      animationType={isSheet ? 'slide' : 'fade'}
      onRequestClose={onClose}
      testID={testID}>
      <View style={[styles.backdrop, !isSheet && styles.backdropCentered]}>
        <TouchableOpacity
          activeOpacity={1}
          style={StyleSheet.absoluteFill}
          onPress={dismissOnBackdrop ? onClose : undefined}
          accessible={false}
          importantForAccessibility="no"
        />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          pointerEvents="box-none"
          style={isSheet ? styles.sheetWrap : styles.centeredWrap}>
          <View
            style={[
              isSheet ? styles.sheet : styles.centered,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
                paddingBottom: sheetPaddingBottom,
              },
            ]}
            accessibilityViewIsModal
            importantForAccessibility="yes">
            {isSheet && (
              <BottomSheetDismissHandle
                onClose={onClose}
                color={colors.border}
                containerStyle={styles.handleHitArea}
                handleStyle={styles.handle}
              />
            )}
            {(title || showClose || headerRight) && (
              <View style={[styles.header, { borderBottomColor: colors.border }]}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  {title && (
                    <Text accessibilityRole="header" style={[styles.title, { color: colors.textPrimary }]} numberOfLines={1}>
                      {title}
                    </Text>
                  )}
                  {subtitle && (
                    <Text style={[styles.subtitle, { color: colors.textMuted }]} numberOfLines={1}>
                      {subtitle}
                    </Text>
                  )}
                </View>
                {headerRight}
                {showClose && (
                  <TouchableOpacity
                    onPress={onClose}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel="Close"
                    style={styles.closeButton}>
                    <Ionicons name="close" size={20} color={colors.textMuted} />
                  </TouchableOpacity>
                )}
              </View>
            )}
            <Container {...containerProps}>{children}</Container>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  backdropCentered: { justifyContent: 'center', alignItems: 'center', padding: 18 },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  centeredWrap: { width: '100%', maxWidth: 460 },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 0,
    maxHeight: '92%',
  },
  centered: {
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingHorizontal: 0,
    maxHeight: '88%',
  },
  handleHitArea: {
    minHeight: 16,
    paddingTop: 8,
    paddingBottom: 4,
    justifyContent: 'flex-start',
  },
  handle: {
    width: 38,
    height: 4,
    borderRadius: 2,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 16, fontWeight: '900' },
  subtitle: { fontSize: 11, fontWeight: '700', marginTop: 2 },
  closeButton: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
});
