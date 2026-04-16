import { View, Text, StyleSheet } from 'react-native';
import { FIX_SUGGESTIONS, NutrientInsight } from '../utils/nutritionLayers';

interface Props {
  insight: NutrientInsight;
  themeColors: { textPrimary: string; textSecondary: string; textMuted: string; border: string; surface: string };
}

/**
 * Compact actionable card for a single nutrition insight. Critical
 * insights use a red accent; notable use amber; info uses neutral.
 * Every card cites the actual number + target and includes a one-line
 * concrete fix when one exists in `FIX_SUGGESTIONS`.
 */
export default function NutritionInsightCard({ insight, themeColors }: Props) {
  const accent =
    insight.severity === 'critical' ? '#EF4444' :
    insight.severity === 'notable'  ? '#F59E0B' :
    '#6B7280';
  const fix = FIX_SUGGESTIONS[insight.key];
  const directionWord = insight.direction === 'min' ? 'low' : 'high';
  const actual = Math.round(insight.actual);
  const target = insight.target;

  return (
    <View style={[styles.card, { backgroundColor: themeColors.surface, borderLeftColor: accent, borderColor: themeColors.border }]}>
      <View style={styles.header}>
        <Text style={[styles.label, { color: themeColors.textPrimary }]}>
          {insight.label} is {directionWord}
        </Text>
        <Text style={[styles.severity, { color: accent }]}>
          {insight.severity === 'critical' ? 'FIX THIS' : 'HEADS UP'}
        </Text>
      </View>
      <Text style={[styles.numbers, { color: themeColors.textSecondary }]}>
        {actual}{insight.unit} vs {insight.direction === 'min' ? 'target' : 'limit'} {target}{insight.unit}
        {'  '}({Math.round(insight.ratio * 100)}%)
      </Text>
      {fix ? (
        <Text style={[styles.fix, { color: themeColors.textMuted }]}>{fix}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderLeftWidth: 3,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  label: { fontSize: 14, fontWeight: '700' },
  severity: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  numbers: { fontSize: 12, marginBottom: 4 },
  fix: { fontSize: 12, fontStyle: 'italic' },
});
