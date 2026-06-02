import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
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
  trend?: string | null;
  privacyNote?: string | null;
  onBack?: () => void;
  onHelpful?: (insight: ContextAwareInsight) => void;
  onNotHelpful?: (insight: ContextAwareInsight) => void;
  onCorrect?: (insight: ContextAwareInsight) => void;
}

export default function InsightDetailScreen({
  insight,
  themeName,
  trend,
  privacyNote,
  onBack,
  onHelpful,
  onNotHelpful,
  onCorrect,
}: Props) {
  const tc = getTheme(themeName).colors;
  const tone = contextInsightTone(insight.category);
  const icon = contextInsightCategoryIcon(insight.category);
  return (
    <View style={[styles.root, { backgroundColor: tc.background }]}>
      <View style={[styles.header, { borderBottomColor: tc.border }]}>
        {onBack ? (
          <TouchableOpacity
            testID="insight-detail-back"
            accessibilityLabel="insight-detail-back"
            onPress={onBack}
            style={[styles.iconButton, { borderColor: tc.border }]}>
            <Ionicons name="chevron-back" size={18} color={tc.textPrimary} />
          </TouchableOpacity>
        ) : <View style={styles.iconButtonSpacer} />}
        <Text style={[styles.headerTitle, { color: tc.textPrimary }]}>Insight</Text>
        <View style={styles.iconButtonSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.titleRow}>
          <View style={[styles.iconBubble, { backgroundColor: `${tone}1F` }]}>
            <Ionicons name={icon as any} size={20} color={tone} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.category, { color: tc.textMuted }]}>
              {contextInsightCategoryLabel(insight.category)}
            </Text>
            <Text style={[styles.title, { color: tc.textPrimary }]}>{insight.title}</Text>
          </View>
        </View>

        <View style={[styles.section, { borderColor: tc.border, backgroundColor: tc.surface }]}>
          <Text style={[styles.sectionTitle, { color: tc.textPrimary }]}>Recommended action</Text>
          <Text style={[styles.action, { color: tc.textPrimary }]}>{insight.recommendedAction}</Text>
          <Text style={[styles.body, { color: tc.textSecondary }]}>{insight.summary}</Text>
        </View>

        <View style={[styles.section, { borderColor: tc.border, backgroundColor: tc.surface }]}>
          <Text style={[styles.sectionTitle, { color: tc.textPrimary }]}>Why am I seeing this?</Text>
          <Text style={[styles.body, { color: tc.textSecondary }]}>{insight.why || insight.explanation}</Text>
          <View style={[styles.confidenceRow, { borderTopColor: tc.border }]}>
            <Ionicons name="analytics-outline" size={16} color={tone} />
            <Text style={[styles.confidenceText, { color: tone }]}>
              {contextInsightConfidenceLabel(insight.confidence)}
            </Text>
          </View>
        </View>

        <View style={[styles.section, { borderColor: tc.border, backgroundColor: tc.surface }]}>
          <Text style={[styles.sectionTitle, { color: tc.textPrimary }]}>Contributing data</Text>
          <Text style={[styles.body, { color: tc.textSecondary }]}>
            {insight.dataSources.length ? insight.dataSources.join(', ') : 'Recent logs'}
          </Text>
          {trend ? <Text style={[styles.body, { color: tc.textSecondary }]}>{trend}</Text> : null}
        </View>

        <View style={[styles.section, { borderColor: tc.border, backgroundColor: tc.surface }]}>
          <Text style={[styles.sectionTitle, { color: tc.textPrimary }]}>Privacy note</Text>
          <Text style={[styles.body, { color: tc.textSecondary }]}>
            {privacyNote || 'Context insights use derived facts and opt-in signals. Passive raw GPS is not stored for derived insights.'}
          </Text>
          {insight.safetyNote ? <Text style={[styles.safety, { color: tc.textMuted }]}>{insight.safetyNote}</Text> : null}
        </View>

        <View style={styles.feedbackRow}>
          {onHelpful ? (
            <TouchableOpacity
              testID="insight-feedback-helpful"
              accessibilityLabel="insight-feedback-helpful"
              onPress={() => onHelpful(insight)}
              style={[styles.feedbackButton, { borderColor: tc.border }]}>
              <Ionicons name="thumbs-up-outline" size={16} color={tc.textSecondary} />
              <Text style={[styles.feedbackText, { color: tc.textSecondary }]}>Helpful</Text>
            </TouchableOpacity>
          ) : null}
          {onNotHelpful ? (
            <TouchableOpacity
              testID="insight-feedback-not-helpful"
              accessibilityLabel="insight-feedback-not-helpful"
              onPress={() => onNotHelpful(insight)}
              style={[styles.feedbackButton, { borderColor: tc.border }]}>
              <Ionicons name="thumbs-down-outline" size={16} color={tc.textSecondary} />
              <Text style={[styles.feedbackText, { color: tc.textSecondary }]}>Not helpful</Text>
            </TouchableOpacity>
          ) : null}
          {onCorrect ? (
            <TouchableOpacity
              testID="insight-feedback-correct"
              accessibilityLabel="insight-feedback-correct"
              onPress={() => onCorrect(insight)}
              style={[styles.feedbackButton, { borderColor: tc.border }]}>
              <Ionicons name="create-outline" size={16} color={tc.textSecondary} />
              <Text style={[styles.feedbackText, { color: tc.textSecondary }]}>Correct</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { minHeight: 54, borderBottomWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14 },
  headerTitle: { fontSize: 16, fontWeight: '900' },
  iconButton: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  iconButtonSpacer: { width: 36, height: 36 },
  content: { padding: 16, gap: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconBubble: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  category: { fontSize: 10, fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0.6 },
  title: { fontSize: 22, fontWeight: '900', marginTop: 2 },
  section: { borderWidth: 1, borderRadius: radius.md, padding: 14, gap: 8 },
  sectionTitle: { fontSize: 13, fontWeight: '900' },
  action: { fontSize: 16, fontWeight: '900', lineHeight: 22 },
  body: { fontSize: 13, lineHeight: 19 },
  confidenceRow: { borderTopWidth: 1, marginTop: 4, paddingTop: 10, flexDirection: 'row', gap: 7, alignItems: 'center' },
  confidenceText: { fontSize: 12, fontWeight: '900' },
  safety: { fontSize: 12, lineHeight: 17 },
  feedbackRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  feedbackButton: { minHeight: 38, borderRadius: radius.sm, borderWidth: 1, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6 },
  feedbackText: { fontSize: 12, fontWeight: '800' },
});

