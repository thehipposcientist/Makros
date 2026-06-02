import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { getTheme } from '../constants/theme';
import { AppThemeName } from '../types';
import { overPhotoTextShadow } from './PhotoScrim';
import {
  formatNutritionPrimaryTarget,
  nutritionRangeStatusText,
  targetRangeStatus,
  type MacroTargetKey,
} from '../utils/nutritionTargetRanges';

type MacroKey = MacroTargetKey;

interface MacroStat {
  key: MacroKey;
  label: string;
  actual: number;
  target: number;
  color: string;
  unit?: string;
}

interface Props {
  themeName?: AppThemeName;
  calories: { actual: number; target: number };
  protein: { actual: number; target: number };
  carbs: { actual: number; target: number };
  fat: { actual: number; target: number };
  accent: string;
  overPhoto?: boolean;
  photoTone?: 'dark' | 'light';
  tileBackground?: string;
  tileBorder?: string;
  trackColor?: string;
  size?: 'default' | 'large' | 'compact';
  onPressMacro?: (macro: MacroKey) => void;
}

function safeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function formatWhole(value: number): string {
  return Math.round(safeNumber(value)).toLocaleString();
}

function visibleProgressPercent(actual: number, target: number): `${number}%` {
  if (target <= 0) return '0%';
  const pct = Math.min(100, Math.max(0, (safeNumber(actual) / target) * 100));
  if (pct <= 0) return '0%';
  return `${Math.max(5, pct)}%` as `${number}%`;
}

function statusText(stat: MacroStat): string {
  return nutritionRangeStatusText(stat.key, stat.actual, stat.target);
}

export default function MacroDonutRow({
  themeName,
  calories,
  protein,
  carbs,
  fat,
  accent,
  overPhoto = false,
  photoTone = 'dark',
  tileBackground: tileBackgroundOverride,
  tileBorder: tileBorderOverride,
  trackColor: trackColorOverride,
  size = 'default',
  onPressMacro,
}: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const darkPhoto = overPhoto && photoTone !== 'light';
  const lightPhoto = overPhoto && photoTone === 'light';
  const textShadow = darkPhoto ? overPhotoTextShadow : null;
  const textColor = darkPhoto ? '#FFFFFF' : tc.textPrimary;
  const mutedColor = darkPhoto ? 'rgba(255,255,255,0.72)' : lightPhoto ? tc.textSecondary : tc.textMuted;
  const tileBackground = tileBackgroundOverride
    ?? (darkPhoto ? 'rgba(2,6,23,0.38)' : lightPhoto ? tc.surface + 'E8' : tc.surfaceRaised);
  const tileBorder = tileBorderOverride
    ?? (darkPhoto ? 'rgba(255,255,255,0.18)' : lightPhoto ? tc.primary + '2E' : tc.border);
  const trackColor = trackColorOverride
    ?? (darkPhoto ? 'rgba(255,255,255,0.22)' : lightPhoto ? tc.primary + '24' : tc.border);
  const overColor = darkPhoto ? '#F87171' : tc.error;
  const closeColor = darkPhoto ? '#FBBF24' : tc.warning;
  const large = size === 'large';
  const compact = size === 'compact';

  const stats: MacroStat[] = darkPhoto
    ? [
        { key: 'calories', label: 'Cal', actual: calories.actual, target: calories.target, color: '#34D399' },
        { key: 'protein', label: 'Protein', actual: protein.actual, target: protein.target, color: '#60A5FA', unit: 'g' },
        { key: 'carbs', label: 'Carbs', actual: carbs.actual, target: carbs.target, color: '#FBBF24', unit: 'g' },
        { key: 'fat', label: 'Fat', actual: fat.actual, target: fat.target, color: '#C084FC', unit: 'g' },
      ]
    : [
        { key: 'calories', label: 'Cal', actual: calories.actual, target: calories.target, color: accent },
        { key: 'protein', label: 'Protein', actual: protein.actual, target: protein.target, color: tc.primary, unit: 'g' },
        { key: 'carbs', label: 'Carbs', actual: carbs.actual, target: carbs.target, color: '#F59E0B', unit: 'g' },
        { key: 'fat', label: 'Fat', actual: fat.actual, target: fat.target, color: '#A78BFA', unit: 'g' },
      ];

  return (
    <View style={[styles.row, large && styles.rowLarge, compact && styles.rowCompact]}>
      {stats.map(stat => (
        <MacroTile
          key={stat.key}
          stat={stat}
          textColor={textColor}
          mutedColor={mutedColor}
          tileBackground={tileBackground}
          tileBorder={tileBorder}
          trackColor={trackColor}
          overColor={overColor}
          closeColor={closeColor}
          textShadow={textShadow}
          large={large}
          compact={compact}
          onPress={onPressMacro ? () => onPressMacro(stat.key) : undefined}
        />
      ))}
    </View>
  );
}

function MacroTile({
  stat,
  textColor,
  mutedColor,
  tileBackground,
  tileBorder,
  trackColor,
  overColor,
  closeColor,
  textShadow,
  large,
  compact = false,
  onPress,
}: {
  stat: MacroStat;
  textColor: string;
  mutedColor: string;
  tileBackground: string;
  tileBorder: string;
  trackColor: string;
  overColor: string;
  closeColor: string;
  textShadow: any;
  large: boolean;
  compact?: boolean;
  onPress?: () => void;
}) {
  const status = targetRangeStatus(stat.key, stat.actual, stat.target);
  const isProblem = status === 'above';
  const fillColor = isProblem ? overColor : status === 'close' ? closeColor : stat.color;
  const targetText = stat.target > 0
    ? `/${formatNutritionPrimaryTarget(stat.key, stat.target, { includeUnit: stat.key !== 'calories' })}`
    : stat.unit ?? 'cal';
  const progressTarget = stat.target;
  const Wrapper: any = onPress ? TouchableOpacity : View;
  const wrapperProps = onPress
    ? {
        onPress,
        activeOpacity: 0.76,
        accessibilityRole: 'button',
        accessibilityLabel: `${stat.label} ${formatWhole(stat.actual)} ${targetText}. ${statusText(stat)}. Open breakdown.`,
      }
    : {};

  return (
    <Wrapper
      style={[styles.tile, large && styles.tileLarge, compact && styles.tileCompact, { backgroundColor: tileBackground, borderColor: tileBorder }]}
      {...wrapperProps}
    >
      <View style={styles.tileHeader}>
        <View style={[styles.dot, large && styles.dotLarge, { backgroundColor: fillColor }]} />
        <Text style={[styles.label, large && styles.labelLarge, { color: mutedColor }, textShadow]} numberOfLines={1}>
          {stat.label}
        </Text>
      </View>

      <View style={styles.valueBlock}>
        <Text
          style={[styles.actual, large && styles.actualLarge, { color: isProblem ? overColor : textColor }, textShadow]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.72}
        >
          {formatWhole(stat.actual)}
        </Text>
        <Text
          style={[styles.target, large && styles.targetLarge, { color: mutedColor }, textShadow]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.72}
        >
          {targetText}
        </Text>
      </View>

      <View style={[styles.track, large && styles.trackLarge, { backgroundColor: trackColor }]}>
        <View
          style={[
            styles.fill,
            {
              width: visibleProgressPercent(stat.actual, progressTarget),
              backgroundColor: fillColor,
            },
          ]}
        />
      </View>
    </Wrapper>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 8,
    paddingTop: 12,
    paddingBottom: 10,
  },
  rowLarge: {
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 14,
    paddingBottom: 12,
  },
  rowCompact: {
    gap: 5,
    paddingHorizontal: 6,
    paddingTop: 6,
    paddingBottom: 6,
  },
  tile: {
    flex: 1,
    minWidth: 0,
    minHeight: 86,
    borderRadius: 11,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 7,
    paddingVertical: 8,
    justifyContent: 'space-between',
  },
  tileLarge: {
    minHeight: 102,
    borderRadius: 13,
    paddingHorizontal: 9,
    paddingVertical: 10,
  },
  tileCompact: {
    minHeight: 64,
    borderRadius: 9,
    paddingHorizontal: 6,
    paddingVertical: 6,
  },
  tileHeader: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    flexShrink: 0,
  },
  dotLarge: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    flex: 1,
    minWidth: 0,
    fontSize: 9,
    lineHeight: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  labelLarge: {
    fontSize: 10,
    lineHeight: 12,
  },
  valueBlock: {
    minWidth: 0,
    alignItems: 'flex-start',
  },
  actual: {
    maxWidth: '100%',
    fontSize: 16,
    lineHeight: 19,
    fontWeight: '900',
    fontVariant: ['tabular-nums'] as any,
  },
  actualLarge: {
    fontSize: 21,
    lineHeight: 25,
  },
  target: {
    maxWidth: '100%',
    marginTop: -1,
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '800',
    fontVariant: ['tabular-nums'] as any,
  },
  targetLarge: {
    fontSize: 12,
    lineHeight: 15,
  },
  track: {
    height: 6,
    borderRadius: 999,
    overflow: 'hidden',
  },
  trackLarge: {
    height: 7,
  },
  fill: {
    height: '100%',
    borderRadius: 999,
  },
});
