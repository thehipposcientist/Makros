import { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import type { AppThemeName } from '../constants/theme';
import type { ContextAwareInsight } from '../types/insights';
import {
  contextInsightCategoryIcon,
  contextInsightCategoryLabel,
  contextInsightConfidenceLabel,
  contextInsightTone,
} from '../utils/contextInsights';

interface Props {
  insight: ContextAwareInsight;
  themeName?: AppThemeName;
  onOpen?: (insight: ContextAwareInsight) => void;
  onDismiss?: (insight: ContextAwareInsight) => void;
  onSnooze?: (insight: ContextAwareInsight) => void;
}

export default function InsightCard({ insight, themeName, onOpen, onDismiss, onSnooze }: Props) {
  const [expanded, setExpanded] = useState(false);
  const tc = getTheme(themeName).colors;
  const tone = contextInsightTone(insight.category);
  const icon = contextInsightCategoryIcon(insight.category);
  return (
    <TouchableOpacity
      testID={`context-insight-card-${insight.id}`}
      accessibilityLabel={`${insight.title}. ${contextInsightConfidenceLabel(insight.confidence)}`}
      activeOpacity={0.85}
      onPress={() => onOpen?.(insight)}
      style={[styles.card, { backgroundColor: tc.surface, borderColor: tc.border }]}>
      <View style={styles.header}>
        <View style={[styles.iconBubble, { backgroundColor: `${tone}1F` }]}>
          <Ionicons name={icon as any} size={18} color={tone} />
        </View>
        <View style={styles.headerText}>
          <Text style={[styles.category, { color: tc.textMuted }]}>
            {contextInsightCategoryLabel(insight.category)}
          </Text>
          <Text style={[styles.title, { color: tc.textPrimary }]}>{insight.title}</Text>
        </View>
        <View style={[styles.confidence, { borderColor: tone, backgroundColor: `${tone}14` }]}>
          <Text style={[styles.confidenceText, { color: tone }]}>
            {contextInsightConfidenceLabel(insight.confidence)}
          </Text>
        </View>
      </View>

      <Text style={[styles.summary, { color: tc.textSecondary }]}>{insight.summary}</Text>

      <View style={[styles.actionBox, { backgroundColor: `${tone}14`, borderColor: `${tone}44` }]}>
        <Ionicons name="arrow-forward-circle-outline" size={17} color={tone} />
        <Text style={[styles.actionText, { color: tc.textPrimary }]}>{insight.recommendedAction}</Text>
      </View>

      {expanded ? (
        <View style={[styles.detail, { borderTopColor: tc.border }]}>
          <Text style={[styles.detailTitle, { color: tc.textPrimary }]}>Why am I seeing this?</Text>
          <Text style={[styles.detailBody, { color: tc.textSecondary }]}>
            {insight.why || insight.explanation}
          </Text>
          <Text style={[styles.detailTitle, { color: tc.textPrimary }]}>Data sources used</Text>
          <Text style={[styles.detailBody, { color: tc.textSecondary }]}>
            {insight.dataSources.length ? insight.dataSources.join(', ') : 'Recent logs'}
          </Text>
          {insight.safetyNote ? (
            <Text style={[styles.safety, { color: tc.textMuted, borderColor: tc.border }]}>
              {insight.safetyNote}
            </Text>
          ) : null}
        </View>
      ) : null}

      <View style={styles.footer}>
        <TouchableOpacity
          testID={`context-insight-why-${insight.id}`}
          accessibilityLabel={`why-${insight.id}`}
          onPress={() => setExpanded(v => !v)}
          style={[styles.iconButton, { borderColor: tc.border }]}>
          <Ionicons name={expanded ? 'chevron-up' : 'help-circle-outline'} size={16} color={tc.textSecondary} />
        </TouchableOpacity>
        <View style={styles.footerActions}>
          {onSnooze ? (
            <TouchableOpacity
              testID={`context-insight-snooze-${insight.id}`}
              accessibilityLabel={`snooze-${insight.id}`}
              onPress={() => onSnooze(insight)}
              style={[styles.actionButton, { borderColor: tc.border }]}>
              <Ionicons name="time-outline" size={15} color={tc.textSecondary} />
              <Text style={[styles.actionButtonText, { color: tc.textSecondary }]}>Snooze</Text>
            </TouchableOpacity>
          ) : null}
          {onDismiss ? (
            <TouchableOpacity
              testID={`context-insight-dismiss-${insight.id}`}
              accessibilityLabel={`dismiss-${insight.id}`}
              onPress={() => onDismiss(insight)}
              style={[styles.dismissButton, { backgroundColor: tone }]}>
              <Ionicons name="close" size={15} color={getContrastingTextColor(tone)} />
              <Text style={[styles.dismissText, { color: getContrastingTextColor(tone) }]}>Dismiss</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 14,
    gap: 10,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconBubble: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  headerText: { flex: 1, minWidth: 0 },
  category: { fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6 },
  title: { fontSize: 15, fontWeight: '900', marginTop: 1 },
  confidence: { borderWidth: 1, borderRadius: radius.full, paddingHorizontal: 8, paddingVertical: 4 },
  confidenceText: { fontSize: 10, fontWeight: '900' },
  summary: { fontSize: 13, lineHeight: 18 },
  actionBox: { borderWidth: 1, borderRadius: radius.sm, padding: 10, flexDirection: 'row', gap: 8, alignItems: 'center' },
  actionText: { fontSize: 13, fontWeight: '800', lineHeight: 18, flex: 1 },
  detail: { borderTopWidth: 1, paddingTop: 10, gap: 5 },
  detailTitle: { fontSize: 12, fontWeight: '900' },
  detailBody: { fontSize: 12, lineHeight: 17 },
  safety: { borderWidth: 1, borderRadius: radius.sm, padding: 9, fontSize: 11, lineHeight: 16 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  footerActions: { flexDirection: 'row', gap: 8 },
  iconButton: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  actionButton: { minHeight: 34, borderRadius: radius.sm, borderWidth: 1, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 5 },
  actionButtonText: { fontSize: 12, fontWeight: '800' },
  dismissButton: { minHeight: 34, borderRadius: radius.sm, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 5 },
  dismissText: { fontSize: 12, fontWeight: '900' },
});

