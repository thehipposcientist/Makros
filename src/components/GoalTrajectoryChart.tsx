import React, { useMemo } from 'react';
import { View, Text } from 'react-native';
import Svg, { Circle, Defs, Line, LinearGradient as SvgLinearGradient, Polygon, Polyline, Stop, Text as SvgText } from 'react-native-svg';
import { GoalProgressBar } from '../utils/goalEstimate';
import { formatWeight, WeightUnit } from '../utils/units';

type WeightEntry = { date: string; weightLbs: number };

type ChartColors = {
  primary: string;
  success: string;
  warning: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  surface: string;
  surfaceRaised: string;
  border: string;
};

type Props = {
  bar: GoalProgressBar;
  weightEntries: WeightEntry[];
  goalStartedAt: string;
  weightUnit: WeightUnit;
  colors: ChartColors;
  width?: number;
  height?: number;
};

const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 14;
const PAD_B = 26;

export function GoalTrajectoryChart({
  bar,
  weightEntries,
  goalStartedAt,
  weightUnit,
  colors,
  width = 300,
  height = 132,
}: Props) {
  const plotW = Math.max(10, width - PAD_L - PAD_R);
  const plotH = Math.max(10, height - PAD_T - PAD_B);

  const verdictColor =
    bar.verdict === 'ahead' ? colors.success
    : bar.verdict === 'behind' ? colors.warning
    : colors.primary;

  const fmt = (n: number) => formatWeight(n, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 });

  const verdictLabel =
    bar.verdict === 'on' ? 'On pace'
    : bar.verdict === 'ahead' ? `Ahead by ${fmt(Math.abs(bar.deltaFromExpectedLbs))}`
    : `Behind by ${fmt(Math.abs(bar.deltaFromExpectedLbs))}`;

  const actualPoints = useMemo(() => {
    const startedMs = new Date(goalStartedAt).getTime();
    if (!Number.isFinite(startedMs)) return [];
    const points: Array<{ day: number; weight: number }> = [];
    // Anchor at goal start so the line never floats in mid-air when the
    // first weigh-in lands a few days after the goal began.
    points.push({ day: 0, weight: bar.startWeightLbs });
    const seenDays = new Set<number>([0]);
    const sorted = [...weightEntries].sort((a, b) => a.date.localeCompare(b.date));
    for (const e of sorted) {
      const ms = new Date(e.date + 'T12:00:00').getTime();
      if (!Number.isFinite(ms) || ms < startedMs) continue;
      const day = Math.round((ms - startedMs) / 86400000);
      if (day < 0 || day > bar.daysElapsed) continue;
      if (seenDays.has(day)) {
        // Replace the prior entry for that day with the later weigh-in.
        points[points.length - 1] = { day, weight: e.weightLbs };
      } else {
        points.push({ day, weight: e.weightLbs });
        seenDays.add(day);
      }
    }
    // Always end at today's known weight, so the actual line reaches the
    // "Now" dot even if the user hasn't weighed in today.
    const last = points[points.length - 1];
    if (!last || last.day < bar.daysElapsed) {
      points.push({ day: bar.daysElapsed, weight: bar.currentWeightLbs });
    }
    return points;
  }, [weightEntries, goalStartedAt, bar.startWeightLbs, bar.currentWeightLbs, bar.daysElapsed]);

  const yMin = Math.min(bar.startWeightLbs, bar.targetWeightLbs, ...actualPoints.map(p => p.weight));
  const yMax = Math.max(bar.startWeightLbs, bar.targetWeightLbs, ...actualPoints.map(p => p.weight));
  const yPad = Math.max(0.5, (yMax - yMin) * 0.12);
  const yLo = yMin - yPad;
  const yHi = yMax + yPad;
  const yRange = Math.max(0.1, yHi - yLo);

  const xMax = Math.max(1, bar.totalPlannedDays);
  const projectX = (day: number) => PAD_L + (Math.min(day, xMax) / xMax) * plotW;
  const projectY = (w: number) => PAD_T + plotH - ((w - yLo) / yRange) * plotH;

  const plannedFrom = { x: projectX(0), y: projectY(bar.startWeightLbs) };
  const plannedTo = { x: projectX(xMax), y: projectY(bar.targetWeightLbs) };

  const actualPoly = actualPoints
    .map(p => `${projectX(p.day)},${projectY(p.weight)}`)
    .join(' ');
  const actualAreaPoly = actualPoints.length >= 2
    ? [
        `${projectX(actualPoints[0].day)},${PAD_T + plotH}`,
        ...actualPoints.map(p => `${projectX(p.day)},${projectY(p.weight)}`),
        `${projectX(actualPoints[actualPoints.length - 1].day)},${PAD_T + plotH}`,
      ].join(' ')
    : '';

  const todayX = projectX(bar.daysElapsed);
  const nowPoint = { x: todayX, y: projectY(bar.currentWeightLbs) };
  const expectedPoint = { x: todayX, y: projectY(bar.expectedWeightLbs) };

  return (
    <View style={{ marginTop: 12, marginBottom: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <Text style={{ fontSize: 10, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.6 }}>
          TRAJECTORY
        </Text>
        <Text style={{ fontSize: 11, fontWeight: '800', color: verdictColor }}>
          {verdictLabel}
        </Text>
      </View>

      <Svg width={width} height={height}>
        <Defs>
          <SvgLinearGradient id="goalTrajectoryActualFill" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor={verdictColor} stopOpacity={0.26} />
            <Stop offset="100%" stopColor={verdictColor} stopOpacity={0.02} />
          </SvgLinearGradient>
        </Defs>

        {actualAreaPoly ? (
          <Polygon
            points={actualAreaPoly}
            fill="url(#goalTrajectoryActualFill)"
          />
        ) : null}

        {/* Planned pace line — dashed guideline from start to target. */}
        <Line
          x1={plannedFrom.x}
          y1={plannedFrom.y}
          x2={plannedTo.x}
          y2={plannedTo.y}
          stroke={colors.textMuted}
          strokeWidth={1.5}
          strokeDasharray="4,4"
          strokeLinecap="round"
        />

        {/* Today vertical line. */}
        <Line
          x1={todayX}
          y1={PAD_T}
          x2={todayX}
          y2={PAD_T + plotH}
          stroke={colors.border}
          strokeWidth={1}
          strokeDasharray="2,3"
        />

        {/* Actual weight curve. */}
        {actualPoints.length >= 2 && (
          <Polyline
            points={actualPoly}
            fill="none"
            stroke={verdictColor}
            strokeWidth={2.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}

        {/* Start anchor dot. */}
        <Circle
          cx={plannedFrom.x}
          cy={plannedFrom.y}
          r={3.5}
          fill={colors.surface}
          stroke={colors.textMuted}
          strokeWidth={1.5}
        />

        {/* Target anchor dot. */}
        <Circle
          cx={plannedTo.x}
          cy={plannedTo.y}
          r={3.5}
          fill={colors.surface}
          stroke={colors.textMuted}
          strokeWidth={1.5}
        />

        {/* Expected-today marker on the planned line. */}
        <Circle
          cx={expectedPoint.x}
          cy={expectedPoint.y}
          r={3}
          fill={colors.surfaceRaised}
          stroke={colors.textSecondary}
          strokeWidth={1.5}
        />

        {/* Now dot — sits on the actual line at today. */}
        <Circle
          cx={nowPoint.x}
          cy={nowPoint.y}
          r={5}
          fill={verdictColor}
          stroke={colors.surface}
          strokeWidth={2}
        />

        {/* Anchor labels. */}
        <SvgText
          x={PAD_L}
          y={height - 12}
          fontSize={10}
          fontWeight="700"
          fill={colors.textMuted}
          textAnchor="start">
          START
        </SvgText>
        <SvgText
          x={PAD_L}
          y={height - 2}
          fontSize={10}
          fontWeight="700"
          fill={colors.textPrimary}
          textAnchor="start">
          {fmt(bar.startWeightLbs)}
        </SvgText>

        <SvgText
          x={width - PAD_R}
          y={height - 12}
          fontSize={10}
          fontWeight="700"
          fill={colors.textMuted}
          textAnchor="end">
          TARGET
        </SvgText>
        <SvgText
          x={width - PAD_R}
          y={height - 2}
          fontSize={10}
          fontWeight="700"
          fill={colors.textPrimary}
          textAnchor="end">
          {fmt(bar.targetWeightLbs)}
        </SvgText>
      </Svg>

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
        <Text style={{ fontSize: 12, fontWeight: '800', color: colors.textPrimary }}>
          Now {fmt(bar.currentWeightLbs)} · {Math.round(bar.actualPct * 100)}%
        </Text>
        <Text style={{ fontSize: 10, color: colors.textMuted }}>
          Day {bar.daysElapsed} of {bar.totalPlannedDays} · expected {fmt(bar.expectedWeightLbs)}
        </Text>
      </View>
    </View>
  );
}
