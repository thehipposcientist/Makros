// Today-nutrition-score snapshot card.
//
// Visual twin of TrainingReadinessCard — colored score dial on the
// left, state word + gap summary on the right, expandable breakdown
// of the three sub-scores (adherence / quality / micro).
//
// Reads the same `nutritionScoreData` state HomeScreen already holds,
// so this is a pure presentational component — no new API calls, no
// duplicate compute.

import { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { getTheme, radius } from '../constants/theme';
import { configureExpandAnimation } from '../utils/layoutAnim';
import { AppThemeName } from '../types';
import type { NutritionScoreResult } from '../utils/nutritionScore';

interface Props {
  data: NutritionScoreResult | null;
  themeName?: AppThemeName;
  /** Opens the meals tab when the user taps the card CTA. */
  onOpenMeals?: () => void;
  /** Suppress the whole card on days without enough data. Default
   *  true — shows a "log meals for a score" placeholder so the card
   *  shape stays consistent with the readiness card above it. */
  showPlaceholder?: boolean;
}

function tierWord(score: number): string {
  if (score >= 85) return 'Excellent';
  if (score >= 70) return 'On Track';
  if (score >= 55) return 'OK';
  if (score >= 40) return 'Needs Work';
  return 'Off Target';
}

export default function NutritionSnapshotCard({
  data, themeName, onOpenMeals, showPlaceholder = true,
}: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [expanded, setExpanded] = useState(false);

  const labelColor = useMemo(() => {
    if (!data || data.score <= 0) return tc.textMuted;
    if (data.score >= 70) return tc.success;
    if (data.score >= 45) return tc.warning;
    return tc.error;
  }, [data, tc]);

  // Placeholder state — no logged meals yet today. Keeps the card
  // footprint the same so the layout doesn't reflow when data lands.
  if (!data || data.score <= 0) {
    if (!showPlaceholder) return null;
    return (
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={onOpenMeals}
        style={{
          backgroundColor: tc.surface,
          borderRadius: radius.lg,
          padding: 14,
          marginBottom: 12,
          borderWidth: 1,
          borderColor: tc.border,
          overflow: 'hidden',
        }}
      >
        <LinearGradient
          pointerEvents="none"
          colors={[theme.sections.meals.strong + '16', 'transparent'] as any}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
        />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{
            width: 56, height: 56, borderRadius: 28,
            borderWidth: 4, borderColor: tc.border,
            backgroundColor: tc.surface,
            alignItems: 'center', justifyContent: 'center',
          }}>
            <Ionicons name="nutrition-outline" size={22} color={tc.textMuted} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 18, fontWeight: '800', color: tc.textPrimary, lineHeight: 22 }}>
              Nutrition
            </Text>
            <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }} numberOfLines={2}>
              Log today's meals to see your nutrition score.
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={tc.textMuted} />
        </View>
      </TouchableOpacity>
    );
  }

  // Top improvement to surface as a one-liner on the collapsed card.
  const topImprovement = data.improvements?.[0];
  const topTag = data.tags?.[0];
  const subtitle = topImprovement || topTag || 'Tap for breakdown';

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={() => {
        configureExpandAnimation(320);
        setExpanded(v => !v);
      }}
      style={{
        backgroundColor: tc.surface,
        borderRadius: radius.lg,
        padding: 14,
        marginBottom: 12,
        borderWidth: 1,
        borderColor: labelColor + '55',
        overflow: 'hidden',
      }}
    >
      <LinearGradient
        pointerEvents="none"
        colors={[labelColor + '20', theme.sections.meals.strong + '12', 'transparent'] as any}
        locations={[0, 0.52, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
      />
      {/* Accent strip along the left edge — matches TrainingReadinessCard. */}
      <View style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
        backgroundColor: labelColor,
        opacity: 0.6,
      }} />

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        {/* Score dial */}
        <View style={{
          width: 56, height: 56, borderRadius: 28,
          borderWidth: 4, borderColor: labelColor,
          backgroundColor: tc.surface,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Text style={{ fontSize: 18, fontWeight: '900', color: labelColor, lineHeight: 20 }}>
            {data.score}
          </Text>
          <Text style={{ fontSize: 7, fontWeight: '700', color: labelColor + 'BB', letterSpacing: 0.4, marginTop: -1 }}>
            SCORE
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 18, fontWeight: '800', color: labelColor, lineHeight: 22 }}>
            {tierWord(data.score)}
          </Text>
          <Text style={{ fontSize: 11, color: tc.textSecondary, marginTop: 1 }}>
            Today's nutrition score
          </Text>
          {!expanded && (
            <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 3 }} numberOfLines={1}>
              {subtitle}
            </Text>
          )}
        </View>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={tc.textMuted} />
      </View>

      {expanded && (
        <View style={{ marginTop: 12 }}>
          <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 6 }}>
            BREAKDOWN
          </Text>
          <SubScoreRow label="Adherence" score={data.adherence} colors={tc} />
          <SubScoreRow label="Food quality" score={data.quality} colors={tc} />
          <SubScoreRow label="Micronutrients" score={data.micro} colors={tc} />
          {data.confidence === 'low' && (
            <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 6, fontStyle: 'italic' }}>
              Log more meals for a sharper read — today's score is low-confidence.
            </Text>
          )}
          {data.improvements && data.improvements.length > 0 && (
            <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: tc.border }}>
              <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 4 }}>
                FOCUS AREAS
              </Text>
              {data.improvements.slice(0, 3).map((imp, i) => (
                <Text key={i} style={{ fontSize: 11, color: tc.textSecondary, lineHeight: 15 }}>• {imp}</Text>
              ))}
            </View>
          )}
          {onOpenMeals && (
            <TouchableOpacity
              onPress={onOpenMeals}
              style={{
                marginTop: 10,
                paddingVertical: 8,
                borderRadius: 10,
                backgroundColor: tc.surfaceRaised,
                borderWidth: 1,
                borderColor: tc.border,
                alignItems: 'center',
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textSecondary }}>
                Open meals
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

function SubScoreRow({
  label, score, colors,
}: {
  label: string;
  score: number;
  colors: ReturnType<typeof getTheme>['colors'];
}) {
  const color =
    score >= 70 ? colors.success
    : score >= 45 ? colors.warning
    : score > 0 ? colors.error
    : colors.textMuted;
  const pct = Math.max(0, Math.min(100, score));
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 5 }}>
      <Text style={{ width: 110, fontSize: 11, fontWeight: '600', color: colors.textSecondary }}>{label}</Text>
      <View style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: colors.border, overflow: 'hidden' }}>
        <View style={{ width: `${pct}%` as any, height: 5, borderRadius: 3, backgroundColor: color }} />
      </View>
      <Text style={{ width: 32, fontSize: 10, fontWeight: '700', color, textAlign: 'right' }}>{score}</Text>
    </View>
  );
}
