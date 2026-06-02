// Canonical empty-state surface — icon + title + body + optional CTA.
//
// Use this anywhere the screen has a real "nothing to show" condition:
//   - no logged meals today
//   - friends tab before adding anyone
//   - history tab on a brand-new account
//   - a search that returned zero matches
//
// Resist the temptation to render a bare "—" or "No data". Those are
// fine for inline values inside a populated card; they are NOT okay as
// the entire content of a screen. Empty states are a UX surface — they
// teach the user what to do next, which is exactly when we need to be
// most concrete.

import { memo, type ReactNode } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius, spacing } from '../constants/theme';
import { AppThemeName } from '../types';

export interface EmptyStateProps {
  /** Ionicons name. Pick something that visually echoes the feature. */
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  /** One short line — what the user sees. */
  title: string;
  /** One paragraph — what the user does next, or why this is empty. */
  body?: string;
  /** Optional primary action. Omit to render a passive empty state. */
  ctaLabel?: string;
  onPressCta?: () => void;
  /** Optional secondary action — keep at most one of these. */
  secondaryLabel?: string;
  onPressSecondary?: () => void;
  /** Drop in a fully custom node when icon+title+body is too constrained. */
  children?: ReactNode;
  themeName?: AppThemeName;
  /** Use `compact` inside cards; `screen` at the top level of a tab. */
  variant?: 'screen' | 'compact';
}

function EmptyStateInner({
  icon = 'leaf-outline',
  title,
  body,
  ctaLabel,
  onPressCta,
  secondaryLabel,
  onPressSecondary,
  children,
  themeName,
  variant = 'screen',
}: EmptyStateProps) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const compact = variant === 'compact';

  return (
    <View
      style={[
        styles.root,
        compact && styles.rootCompact,
        { backgroundColor: 'transparent' },
      ]}
      accessibilityRole="text"
      accessibilityLabel={`${title}${body ? `. ${body}` : ''}`}
    >
      <View
        style={[
          styles.iconWrap,
          { backgroundColor: tc.surfaceRaised, borderColor: tc.border },
          compact && styles.iconWrapCompact,
        ]}
      >
        <Ionicons
          name={icon}
          size={compact ? 20 : 28}
          color={tc.textMuted}
        />
      </View>
      <Text
        style={[
          styles.title,
          { color: tc.textPrimary },
          compact && styles.titleCompact,
        ]}
        numberOfLines={2}
      >
        {title}
      </Text>
      {body ? (
        <Text
          style={[
            styles.body,
            { color: tc.textSecondary },
            compact && styles.bodyCompact,
          ]}
        >
          {body}
        </Text>
      ) : null}
      {children}
      {(ctaLabel && onPressCta) || (secondaryLabel && onPressSecondary) ? (
        <View style={styles.ctaRow}>
          {ctaLabel && onPressCta ? (
            <TouchableOpacity
              onPress={onPressCta}
              accessibilityRole="button"
              accessibilityLabel={ctaLabel}
              style={[styles.ctaPrimary, { backgroundColor: tc.primary }]}
              activeOpacity={0.85}
            >
              <Text style={[styles.ctaPrimaryLabel, { color: tc.surface }]}>
                {ctaLabel}
              </Text>
            </TouchableOpacity>
          ) : null}
          {secondaryLabel && onPressSecondary ? (
            <TouchableOpacity
              onPress={onPressSecondary}
              accessibilityRole="button"
              accessibilityLabel={secondaryLabel}
              style={[
                styles.ctaSecondary,
                { borderColor: tc.border, backgroundColor: tc.surface },
              ]}
              activeOpacity={0.85}
            >
              <Text style={[styles.ctaSecondaryLabel, { color: tc.textPrimary }]}>
                {secondaryLabel}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  rootCompact: {
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    gap: spacing.xs,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    marginBottom: spacing.xs,
  },
  iconWrapCompact: {
    width: 36,
    height: 36,
    marginBottom: spacing.xxs,
  },
  title: {
    fontSize: 16,
    fontWeight: '800',
    textAlign: 'center',
    letterSpacing: 0.2,
  },
  titleCompact: {
    fontSize: 14,
  },
  body: {
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
    maxWidth: 320,
  },
  bodyCompact: {
    fontSize: 12,
    lineHeight: 16,
    maxWidth: 260,
  },
  ctaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
    flexWrap: 'wrap',
  },
  ctaPrimary: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + spacing.xxs,
    borderRadius: radius.sm,
  },
  ctaPrimaryLabel: {
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  ctaSecondary: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + spacing.xxs,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  ctaSecondaryLabel: {
    fontSize: 13,
    fontWeight: '700',
  },
});

export const EmptyState = memo(EmptyStateInner);
export default EmptyState;
