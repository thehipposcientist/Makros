import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import type { AppThemeName } from '../constants/theme';
import type { DailyInsightAction } from '../types/insights';

interface Props {
  action: DailyInsightAction;
  themeName?: AppThemeName;
}

export default function DailyActionCard({ action, themeName }: Props) {
  const tc = getTheme(themeName).colors;
  return (
    <View
      testID="daily-context-action-card"
      accessibilityLabel={action.primaryAction}
      style={[styles.card, { backgroundColor: tc.surface, borderColor: tc.border }]}>
      <View style={styles.header}>
        <Ionicons name="navigate-circle-outline" size={20} color={tc.primary} />
        <Text style={[styles.label, { color: tc.textMuted }]}>Today</Text>
      </View>
      <Text style={[styles.action, { color: tc.textPrimary }]}>{action.primaryAction}</Text>
      <View style={styles.row}>
        <Ionicons name="information-circle-outline" size={16} color={tc.textMuted} />
        <Text style={[styles.body, { color: tc.textSecondary }]}>{action.reason}</Text>
      </View>
      <View style={styles.row}>
        <Ionicons name="trending-up-outline" size={16} color={tc.textMuted} />
        <Text style={[styles.body, { color: tc.textSecondary }]}>{action.expectedBenefit}</Text>
      </View>
      {action.secondaryAction ? (
        <View style={[styles.alternative, { borderTopColor: tc.border }]}>
          <Text style={[styles.altLabel, { color: tc.textMuted }]}>Alternative</Text>
          <Text style={[styles.body, { color: tc.textSecondary }]}>{action.secondaryAction}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.md, padding: 14, gap: 10 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  label: { fontSize: 11, fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0.6 },
  action: { fontSize: 18, fontWeight: '900', lineHeight: 24 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 7 },
  body: { fontSize: 13, lineHeight: 18, flex: 1 },
  alternative: { borderTopWidth: 1, paddingTop: 10, gap: 3 },
  altLabel: { fontSize: 10, fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0.5 },
});

