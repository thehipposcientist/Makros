import React from 'react';
import { View, Text } from 'react-native';
import Svg, { Polyline, Polygon, Line, Circle, Defs, LinearGradient as SvgLinearGradient, Stop, Text as SvgText } from 'react-native-svg';
import { RecompTrajectory } from '../utils/goalEstimate';

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
  trajectory: RecompTrajectory;
  colors: ChartColors;
  width?: number;
  height?: number;
};

const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 14;
const PAD_B = 26;

export function RecompTrajectoryChart({
  trajectory,
  colors,
  width = 300,
  height = 132,
}: Props) {
  const plotW = Math.max(10, width - PAD_L - PAD_R);
  const plotH = Math.max(10, height - PAD_T - PAD_B);

  const verdictColor =
    trajectory.verdict === 'ahead' ? colors.success
    : trajectory.verdict === 'behind' ? colors.warning
    : colors.primary;

  const verdictLabel =
    trajectory.verdict == null ? 'Awaiting next scan'
    : trajectory.verdict === 'on' ? 'On pace'
    : trajectory.verdict === 'ahead' ? `Ahead by ${Math.abs(trajectory.verdictDeltaPct ?? 0).toFixed(1)} pp`
    : `Behind by ${Math.abs(trajectory.verdictDeltaPct ?? 0).toFixed(1)} pp`;

  const yValues = [
    trajectory.startBodyFatPct,
    trajectory.planEndBodyFatPctLow,
    trajectory.planEndBodyFatPctHigh,
    ...trajectory.actualPoints.map(p => p.bfPct),
  ];
  if (trajectory.currentBodyFatPct != null) yValues.push(trajectory.currentBodyFatPct);
  const yMin = Math.min(...yValues);
  const yMax = Math.max(...yValues);
  const yPad = Math.max(0.5, (yMax - yMin) * 0.15);
  const yLo = yMin - yPad;
  const yHi = yMax + yPad;
  const yRange = Math.max(0.1, yHi - yLo);

  const xMax = Math.max(1, trajectory.totalPlannedDays);
  const projectX = (day: number) => PAD_L + (Math.min(day, xMax) / xMax) * plotW;
  const projectY = (bf: number) => PAD_T + plotH - ((bf - yLo) / yRange) * plotH;

  const startPt = { x: projectX(0), y: projectY(trajectory.startBodyFatPct) };
  const endLowPt = { x: projectX(xMax), y: projectY(trajectory.planEndBodyFatPctLow) };
  const endHighPt = { x: projectX(xMax), y: projectY(trajectory.planEndBodyFatPctHigh) };
  const todayX = projectX(trajectory.daysElapsed);
  const expectedPt = { x: todayX, y: projectY(trajectory.expectedBodyFatPctNow) };
  const nowBF = trajectory.currentBodyFatPct ?? trajectory.startBodyFatPct;
  const nowPt = { x: todayX, y: projectY(nowBF) };

  // Planned band as a triangle anchored at the start, fanning to the
  // low/high BF% at the end of the timeline. Low = less drop = higher %
  // (top of band); High = more drop = lower % (bottom of band).
  const bandPoints = [
    `${startPt.x},${startPt.y}`,
    `${endLowPt.x},${endLowPt.y}`,
    `${endHighPt.x},${endHighPt.y}`,
  ].join(' ');

  const actualPoly = trajectory.actualPoints
    .map(p => `${projectX(p.day)},${projectY(p.bfPct)}`)
    .join(' ');

  // Closed area polygon under the actual line for the gradient fill: the line
  // points, then drop straight down to the plot baseline at the last and first
  // x so the fill hugs the curve.
  const baselineY = PAD_T + plotH;
  const actualAreaPoly = trajectory.actualPoints.length >= 2
    ? `${actualPoly} ${projectX(trajectory.actualPoints[trajectory.actualPoints.length - 1].day)},${baselineY} ${projectX(trajectory.actualPoints[0].day)},${baselineY}`
    : null;

  const fmtBF = (n: number) => `${n.toFixed(1)}%`;
  const targetRangeLabel =
    `${fmtBF(trajectory.planEndBodyFatPctHigh)}–${fmtBF(trajectory.planEndBodyFatPctLow)}`;

  return (
    <View style={{ marginTop: 12, marginBottom: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <Text style={{ fontSize: 10, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.6 }}>
          BODY FAT TRAJECTORY
        </Text>
        <Text style={{ fontSize: 11, fontWeight: '800', color: verdictColor }}>
          {verdictLabel}
        </Text>
      </View>

      <Svg width={width} height={height}>
        <Defs>
          <SvgLinearGradient id="recompActualFill" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor={verdictColor} stopOpacity={0.26} />
            <Stop offset="100%" stopColor={verdictColor} stopOpacity={0.02} />
          </SvgLinearGradient>
        </Defs>

        {/* Planned band — shaded triangle of plausible BF% outcomes. */}
        <Polygon
          points={bandPoints}
          fill={colors.primary + '22'}
          stroke="none"
        />

        {/* Mid-pace dashed line from start → midpoint of end range. */}
        <Line
          x1={startPt.x}
          y1={startPt.y}
          x2={projectX(xMax)}
          y2={projectY((trajectory.planEndBodyFatPctLow + trajectory.planEndBodyFatPctHigh) / 2)}
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

        {/* Gradient fill under the actual scan line. */}
        {actualAreaPoly && (
          <Polygon points={actualAreaPoly} fill="url(#recompActualFill)" stroke="none" />
        )}

        {/* Actual scan polyline. Only render when there's a real second
            point past the start anchor — otherwise the line is just the
            anchor and the start-dot already conveys that. */}
        {trajectory.actualPoints.length >= 2 && (
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
          cx={startPt.x}
          cy={startPt.y}
          r={3.5}
          fill={colors.surface}
          stroke={colors.textMuted}
          strokeWidth={1.5}
        />

        {/* End-of-timeline anchors (low + high). */}
        <Circle
          cx={endLowPt.x}
          cy={endLowPt.y}
          r={3}
          fill={colors.surface}
          stroke={colors.textMuted}
          strokeWidth={1.5}
        />
        <Circle
          cx={endHighPt.x}
          cy={endHighPt.y}
          r={3}
          fill={colors.surface}
          stroke={colors.textMuted}
          strokeWidth={1.5}
        />

        {/* Expected-today marker on the mid-pace line. */}
        <Circle
          cx={expectedPt.x}
          cy={expectedPt.y}
          r={3}
          fill={colors.surfaceRaised}
          stroke={colors.textSecondary}
          strokeWidth={1.5}
        />

        {/* Now dot — sits on the actual line at today. */}
        <Circle
          cx={nowPt.x}
          cy={nowPt.y}
          r={5}
          fill={verdictColor}
          stroke={colors.surface}
          strokeWidth={2}
        />

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
          {fmtBF(trajectory.startBodyFatPct)}
        </SvgText>

        <SvgText
          x={width - PAD_R}
          y={height - 12}
          fontSize={10}
          fontWeight="700"
          fill={colors.textMuted}
          textAnchor="end">
          TARGET RANGE
        </SvgText>
        <SvgText
          x={width - PAD_R}
          y={height - 2}
          fontSize={10}
          fontWeight="700"
          fill={colors.textPrimary}
          textAnchor="end">
          {targetRangeLabel}
        </SvgText>
      </Svg>

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
        <Text style={{ fontSize: 12, fontWeight: '800', color: colors.textPrimary }}>
          {trajectory.currentBodyFatPct != null
            ? `Now ${fmtBF(trajectory.currentBodyFatPct)}`
            : `Start ${fmtBF(trajectory.startBodyFatPct)} · no scans yet`}
        </Text>
        <Text style={{ fontSize: 10, color: colors.textMuted }}>
          Day {trajectory.daysElapsed} of {trajectory.totalPlannedDays} · expected {fmtBF(trajectory.expectedBodyFatPctNow)}
        </Text>
      </View>
    </View>
  );
}
