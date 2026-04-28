// Collapsible section for the Library detail pages.
//
// Used to rein in the textbook-density of the muscle + exercise pages.
// Defaults to expanded for the first 2-3 sections; everything past that
// collapses behind a tappable header so the page reads as a clean
// summary at first paint, with the deep-dive content one tap away for
// users who want it.
//
// Animation uses LayoutAnimation (configured by `configureExpandAnimation`)
// so the parent ScrollView reflows smoothly when a section opens.

import { useState, ReactNode } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { configureExpandAnimation } from '../utils/layoutAnim';

interface Props {
  title: string;
  /** Optional decorative tint applied to the title — e.g. error red on
   *  "Common Mistakes" so the danger signal still survives collapse. */
  titleColor?: string;
  /** Tag chip rendered to the right of the title. Used for things like
   *  "Concentric ↑ / Eccentric ↓" so the user can tell what kind of
   *  section is collapsed without expanding. Optional. */
  badge?: { text: string; color: string };
  /** Theme color tokens. Caller passes them in to avoid coupling this
   *  helper to a specific theme module. */
  surfaceColor: string;
  borderColor: string;
  textPrimary: string;
  textMuted: string;
  defaultExpanded?: boolean;
  children: ReactNode;
  /** Adds a subtle left border in `accentColor` so themed sections
   *  (e.g. the workout palette on exercise pages) read coherently. */
  accentColor?: string;
}

export default function CollapsibleSection({
  title, titleColor, badge,
  surfaceColor, borderColor, textPrimary, textMuted,
  defaultExpanded = false,
  accentColor,
  children,
}: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const toggle = () => {
    configureExpandAnimation(220);
    setExpanded(v => !v);
  };

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: surfaceColor,
          borderColor,
          borderLeftColor: accentColor ?? borderColor,
          borderLeftWidth: accentColor ? 3 : 1,
        },
      ]}
    >
      <TouchableOpacity onPress={toggle} activeOpacity={0.7} style={styles.header}>
        <Text style={[styles.title, { color: titleColor ?? textPrimary }]} numberOfLines={1}>
          {title}
        </Text>
        {badge ? (
          <View style={[styles.badge, { backgroundColor: badge.color + '22' }]}>
            <Text style={[styles.badgeText, { color: badge.color }]}>{badge.text}</Text>
          </View>
        ) : null}
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={16}
          color={textMuted}
        />
      </TouchableOpacity>
      {expanded ? <View style={styles.body}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  body: {
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(127,127,127,0.12)',
  },
});
