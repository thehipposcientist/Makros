import React, { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { PanResponder, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle, Line, Polygon, Polyline, Text as SvgText } from 'react-native-svg';

import { elevations, getContrastingTextColor, getTheme, radius } from '../constants/theme';
import type { AppThemeName, DailyNutritionPlan, HealthSummary, WorkoutSession } from '../types';
import {
  getDailyStressHistory,
  upsertDailyStressSummary,
  type DailyStressHistoryResponse,
  type MealHistoryEntry,
} from '../services/api';
import { readHeartRateSamples, type HeartRateSample } from '../services/appleHealth';

type StressIntensity = 'light' | 'moderate' | 'heavy';
type StressEventKind = 'meal' | 'workout' | 'activity';

type StressEvent = {
  id: string;
  kind: StressEventKind;
  title: string;
  detail: string;
  time: Date;
  endTime?: Date | null;
  intensity: StressIntensity;
  impact: number;
  color: string;
  icon: ComponentProps<typeof Ionicons>['name'];
  source: 'logged' | 'planned' | 'detected' | 'active';
};

type StressPoint = {
  minute: number;
  score: number;
  source: 'hr' | 'estimate';
};

type LabeledStressEvent = {
  event: StressEvent;
  x: number;
  row: number;
};

type InProgressWorkoutSummary = {
  focus: string;
  setsLogged: number;
  startedAt: number;
};

interface DailyStressTimelineCardProps {
  authToken?: string | null;
  themeName?: AppThemeName;
  active?: boolean;
  healthEnabled?: boolean;
  healthSummary?: HealthSummary | null;
  mealHistory?: MealHistoryEntry[] | null;
  nutritionPlan?: DailyNutritionPlan | null;
  workoutHistory?: WorkoutSession[];
  inProgressWorkout?: InProgressWorkoutSummary | null;
  showMealProgress?: boolean;
  showWorkoutProgress?: boolean;
}

const DAY_MINUTES = 24 * 60;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function startOfLocalDay(date = new Date()): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseDate(raw: string | number | null | undefined): Date | null {
  if (raw == null || raw === '') return null;
  const date = typeof raw === 'number' ? new Date(raw) : new Date(raw);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isTodayDate(date: Date | null, todayKey: string): boolean {
  return !!date && dateKey(date) === todayKey;
}

function minuteOfDay(date: Date): number {
  return clamp(date.getHours() * 60 + date.getMinutes(), 0, DAY_MINUTES);
}

function dateAtMinute(dayStart: Date, minute: number): Date {
  return new Date(dayStart.getTime() + clamp(minute, 0, DAY_MINUTES) * 60000);
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: date.getMinutes() === 0 ? undefined : '2-digit' });
}

function formatAxisMinute(minute: number): string {
  const safeMinute = clamp(Math.round(minute), 0, DAY_MINUTES);
  const hour24 = Math.floor(safeMinute / 60) % 24;
  const minutes = safeMinute % 60;
  const hour12 = hour24 % 12 || 12;
  const suffix = hour24 < 12 ? 'a' : 'p';
  return minutes === 0 ? `${hour12}${suffix}` : `${hour12}:${String(minutes).padStart(2, '0')}${suffix}`;
}

function formatDuration(minutes: number): string | null {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const rounded = Math.max(1, Math.round(minutes));
  if (rounded < 60) return `${rounded}m`;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function humanizeToken(raw: string | null | undefined): string {
  const text = String(raw ?? '').replace(/[_-]+/g, ' ').trim();
  return text ? text.replace(/\b\w/g, c => c.toUpperCase()) : '';
}

function mealCalories(meal: MealHistoryEntry | any): number {
  const total = Number(meal?.totals?.calories ?? meal?.calories);
  if (Number.isFinite(total) && total > 0) return total;
  return (meal?.items ?? []).reduce((sum: number, item: any) => sum + Math.max(0, Number(item?.calories) || 0), 0);
}

function mealFat(meal: MealHistoryEntry | any): number {
  const total = Number(meal?.totals?.fat_g ?? meal?.fat_g ?? meal?.fat);
  if (Number.isFinite(total) && total > 0) return total;
  return (meal?.items ?? []).reduce((sum: number, item: any) => sum + Math.max(0, Number(item?.fat_g ?? item?.fat) || 0), 0);
}

function mealName(meal: MealHistoryEntry | any): string {
  return String(meal?.name ?? meal?.meal ?? meal?.meal_type ?? 'Meal').trim() || 'Meal';
}

function classifyMeal(calories: number, fatG: number): StressIntensity {
  if (calories >= 700 || fatG >= 30) return 'heavy';
  if (calories <= 320 && fatG <= 12) return 'light';
  return 'moderate';
}

function intensityLabel(intensity: StressIntensity): string {
  if (intensity === 'heavy') return 'Heavy';
  if (intensity === 'light') return 'Light';
  return 'Steady';
}

function mealImpact(intensity: StressIntensity): number {
  if (intensity === 'heavy') return 16;
  if (intensity === 'moderate') return 9;
  return 5;
}

function buildMealEvents(
  mealHistory: MealHistoryEntry[] | null | undefined,
  _nutritionPlan: DailyNutritionPlan | null | undefined,
  todayKeyValue: string,
  dayStart: Date,
  color: string,
  showMealProgress?: boolean,
): StressEvent[] {
  if (!showMealProgress) return [];
  const logged = (mealHistory ?? [])
    .map((meal): StressEvent | null => {
      if (String(meal.meal_date ?? '').slice(0, 10) !== todayKeyValue) return null;
      const time = parseDate(meal.consumed_at ?? meal.created_at ?? null) ?? dateAtMinute(dayStart, 12 * 60);
      if (!isTodayDate(time, todayKeyValue)) return null;
      const calories = mealCalories(meal);
      const fatG = mealFat(meal);
      const intensity = classifyMeal(calories, fatG);
      const detail = [
        `${Math.round(calories)} cal`,
        Number.isFinite(fatG) && fatG > 0 ? `${Math.round(fatG)}g fat` : null,
        'logged',
      ].filter(Boolean).join(' - ');
      return {
        id: `meal-${meal.id}`,
        kind: 'meal',
        title: `${intensityLabel(intensity)} meal`,
        detail: `${mealName(meal)} - ${detail}`,
        time,
        intensity,
        impact: mealImpact(intensity),
        color,
        icon: 'nutrition-outline',
        source: 'logged',
      };
    })
    .filter((event): event is StressEvent => event != null);

  return logged;
}

function workoutStart(session: WorkoutSession): Date | null {
  return parseDate((session as any).startedAt ?? (session as any).linkedAppleHealthWorkout?.startDate ?? session.date);
}

function workoutEnd(session: WorkoutSession): Date | null {
  const explicit = parseDate((session as any).endedAt ?? (session as any).linkedAppleHealthWorkout?.endDate ?? null);
  if (explicit) return explicit;
  const start = workoutStart(session);
  const seconds = Number(session.durationSeconds);
  if (!start || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(start.getTime() + seconds * 1000);
}

function workoutCalories(session: WorkoutSession): number | null {
  const value = Number((session as any).manualActivity?.caloriesBurned ?? (session as any).linkedAppleHealthWorkout?.caloriesBurned);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function workoutAvgHr(session: WorkoutSession): number | null {
  const value = Number((session as any).manualActivity?.avgHeartRate ?? (session as any).linkedAppleHealthWorkout?.avgHeartRate);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function workoutMaxHr(session: WorkoutSession): number | null {
  const value = Number((session as any).linkedAppleHealthWorkout?.maxHeartRate);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function classifyActivity(durationMin: number, calories?: number | null, avgHr?: number | null, maxHr?: number | null, focus?: string | null): StressIntensity {
  const focusText = String(focus ?? '').toLowerCase();
  const strengthLike = /\b(push|pull|legs|lower|upper|full|strength|lift|weight|hypertrophy)\b/.test(focusText);
  if (durationMin >= 60 || (calories ?? 0) >= 500 || (avgHr ?? 0) >= 150 || (maxHr ?? 0) >= 175 || (strengthLike && durationMin >= 45)) return 'heavy';
  if (durationMin >= 25 || (calories ?? 0) >= 180 || (avgHr ?? 0) >= 120 || strengthLike) return 'moderate';
  return 'light';
}

function activityImpact(intensity: StressIntensity): number {
  if (intensity === 'heavy') return 30;
  if (intensity === 'moderate') return 20;
  return 10;
}

function activityIcon(label: string): ComponentProps<typeof Ionicons>['name'] {
  const text = label.toLowerCase();
  if (text.includes('cycling') || text.includes('bike') || text.includes('ride')) return 'bicycle-outline';
  if (text.includes('run')) return 'walk-outline';
  if (text.includes('walk') || text.includes('hike')) return 'footsteps-outline';
  if (text.includes('swim')) return 'water-outline';
  if (text.includes('strength') || text.includes('weight') || text.includes('lift')) return 'barbell-outline';
  return 'fitness-outline';
}

function buildWorkoutEvents(
  history: WorkoutSession[] | null | undefined,
  healthSummary: HealthSummary | null | undefined,
  inProgressWorkout: InProgressWorkoutSummary | null | undefined,
  todayKeyValue: string,
  color: string,
  showWorkoutProgress?: boolean,
): StressEvent[] {
  if (!showWorkoutProgress) return [];
  const events: StressEvent[] = [];
  for (const session of history ?? []) {
    if (!session.completed && !session.skipped) continue;
    const start = workoutStart(session);
    if (!isTodayDate(start, todayKeyValue)) continue;
    const end = workoutEnd(session);
    const durationMin = Math.max(0, Number(session.durationSeconds || 0) / 60);
    const calories = workoutCalories(session);
    const avgHr = workoutAvgHr(session);
    const maxHr = workoutMaxHr(session);
    const label = humanizeToken((session as any).manualActivity?.subtype) || humanizeToken(session.focus) || 'Workout';
    const source = (session as any).manualActivity?.source === 'apple_health' || (session as any).importSource
      ? 'detected'
      : 'logged';
    const intensity = classifyActivity(durationMin, calories, avgHr, maxHr, label);
    const detail = [
      label,
      formatDuration(durationMin),
      calories ? `${Math.round(calories)} kcal` : null,
      avgHr ? `${Math.round(avgHr)} bpm` : null,
    ].filter(Boolean).join(' - ');
    events.push({
      id: `workout-${session.id ?? start!.toISOString()}`,
      kind: source === 'detected' ? 'activity' : 'workout',
      title: source === 'detected' ? `${intensityLabel(intensity)} activity` : `${intensityLabel(intensity)} workout`,
      detail,
      time: start!,
      endTime: end,
      intensity,
      impact: activityImpact(intensity),
      color,
      icon: activityIcon(label),
      source,
    });
  }

  const existingStarts = events.map(event => event.time.getTime());
  for (const workout of healthSummary?.workoutDetails ?? []) {
    const start = parseDate(workout.startDate);
    if (!isTodayDate(start, todayKeyValue)) continue;
    if (existingStarts.some(ms => Math.abs(ms - start!.getTime()) <= 10 * 60000)) continue;
    const durationMin = Math.max(0, Number(workout.duration) || 0);
    const calories = Number(workout.calories);
    const avgHr = Number(workout.avgHeartRate);
    const maxHr = Number(workout.maxHeartRate);
    const label = humanizeToken(workout.activityName) || 'Activity';
    const intensity = classifyActivity(durationMin, calories, avgHr, maxHr, label);
    const detail = [
      label,
      formatDuration(durationMin),
      Number.isFinite(calories) && calories > 0 ? `${Math.round(calories)} kcal` : null,
      Number.isFinite(avgHr) && avgHr > 0 ? `${Math.round(avgHr)} bpm` : null,
    ].filter(Boolean).join(' - ');
    events.push({
      id: `health-workout-${workout.startDate}`,
      kind: 'activity',
      title: `${intensityLabel(intensity)} activity`,
      detail,
      time: start!,
      endTime: parseDate(workout.endDate),
      intensity,
      impact: activityImpact(intensity),
      color,
      icon: activityIcon(label),
      source: 'detected',
    });
  }

  const activeStart = parseDate(inProgressWorkout?.startedAt ?? null);
  if (isTodayDate(activeStart, todayKeyValue)) {
    const durationMin = Math.max(1, (Date.now() - activeStart!.getTime()) / 60000);
    const intensity = classifyActivity(durationMin, null, null, null, inProgressWorkout?.focus);
    events.push({
      id: 'active-workout',
      kind: 'workout',
      title: 'Workout now',
      detail: `${humanizeToken(inProgressWorkout?.focus) || 'Workout'} - ${formatDuration(durationMin)} - ${inProgressWorkout?.setsLogged ?? 0} sets`,
      time: activeStart!,
      endTime: new Date(),
      intensity,
      impact: activityImpact(intensity),
      color,
      icon: 'play-circle-outline',
      source: 'active',
    });
  }

  return events.sort((a, b) => a.time.getTime() - b.time.getTime());
}

function baselineStress(healthSummary: HealthSummary | null | undefined): number {
  let base = 34;
  const sleepScore = healthSummary?.sleepScore?.score;
  const sleepHours = healthSummary?.lastNightSleepHours;
  if (typeof sleepScore === 'number') {
    base += clamp((72 - sleepScore) * 0.35, -8, 16);
  } else if (typeof sleepHours === 'number' && sleepHours > 0) {
    base += clamp((7 - sleepHours) * 4, -4, 12);
  }
  const rhr = healthSummary?.restingHeartRate;
  if (typeof rhr === 'number' && rhr > 0) base += clamp((rhr - 66) * 0.35, -4, 10);
  const hrv = healthSummary?.hrvAvg;
  if (typeof hrv === 'number' && hrv > 0) base += hrv < 30 ? 7 : hrv < 45 ? 3 : hrv > 75 ? -4 : 0;
  const active = healthSummary?.activeEnergyToday;
  const avgActive = healthSummary?.activeEnergy7d;
  if (typeof active === 'number' && typeof avgActive === 'number' && avgActive > 0) {
    base += clamp(((active / avgActive) - 1) * 12, -3, 10);
  }
  return clamp(base, 22, 58);
}

function heartRateBaseline(samples: HeartRateSample[], healthSummary: HealthSummary | null | undefined): number {
  const rhr = Number(healthSummary?.restingHeartRate);
  if (Number.isFinite(rhr) && rhr > 0) return rhr;
  const values = samples.map(sample => sample.value).filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (values.length === 0) return 62;
  return values[Math.max(0, Math.floor(values.length * 0.18))];
}

function heartRateLoad(avgHr: number, baseline: number): number {
  return clamp(30 + (avgHr - baseline) * 1.15, 24, 96);
}

function buildHrBins(samples: HeartRateSample[]): Map<number, number> {
  const bins = new Map<number, number[]>();
  for (const sample of samples) {
    const date = parseDate(sample.startDate);
    if (!date) continue;
    const bucket = Math.round(minuteOfDay(date) / 30) * 30;
    const values = bins.get(bucket) ?? [];
    values.push(sample.value);
    bins.set(bucket, values);
  }
  const out = new Map<number, number>();
  for (const [bucket, values] of bins) {
    out.set(bucket, values.reduce((sum, value) => sum + value, 0) / values.length);
  }
  return out;
}

function nearestHrForMinute(minute: number, bins: Map<number, number>): number | null {
  let best: { distance: number; value: number } | null = null;
  for (const [bucket, value] of bins) {
    const distance = Math.abs(bucket - minute);
    if (distance > 75) continue;
    if (!best || distance < best.distance) best = { distance, value };
  }
  return best?.value ?? null;
}

function scoreAtMinute(
  minute: number,
  events: StressEvent[],
  base: number,
  hrBins: Map<number, number>,
  hrBaseline: number,
): StressPoint {
  const dayWave = Math.sin(((minute - 8 * 60) / DAY_MINUTES) * Math.PI * 2);
  const afternoonWave = Math.sin(((minute - 13 * 60) / DAY_MINUTES) * Math.PI * 2);
  let score = base + dayWave * 4 + afternoonWave * 3;

  for (const event of events) {
    const eventMinute = minuteOfDay(event.time);
    const distanceHours = (minute - eventMinute) / 60;
    const postWeighted = distanceHours >= 0 ? distanceHours : distanceHours * 1.4;
    const spread = event.kind === 'meal'
      ? event.intensity === 'heavy' ? 1.6 : 1.1
      : event.intensity === 'heavy' ? 2.1 : 1.5;
    score += event.impact * Math.exp(-(postWeighted * postWeighted) / (2 * spread * spread));
  }

  const hr = nearestHrForMinute(minute, hrBins);
  if (hr != null) {
    score = Math.max(score, heartRateLoad(hr, hrBaseline));
  }

  return {
    minute,
    score: clamp(Math.round(score), 12, 96),
    source: hr != null ? 'hr' : 'estimate',
  };
}

function buildStressPoints(
  events: StressEvent[],
  healthSummary: HealthSummary | null | undefined,
  heartRateSamples: HeartRateSample[],
  now = new Date(),
  horizonMinute = minuteOfDay(now),
): StressPoint[] {
  const endMinute = clamp(Math.round(horizonMinute), 0, DAY_MINUTES);
  const base = baselineStress(healthSummary);
  const bins = buildHrBins(heartRateSamples);
  const hrBase = heartRateBaseline(heartRateSamples, healthSummary);
  const minuteSet = new Set<number>([0, endMinute]);
  for (let minute = 0; minute <= endMinute; minute += 30) {
    minuteSet.add(minute);
  }
  for (const bucket of bins.keys()) {
    if (bucket <= endMinute) minuteSet.add(clamp(bucket, 0, endMinute));
  }
  for (const event of events) {
    const startMinute = minuteOfDay(event.time);
    if (startMinute > endMinute) continue;
    const offsets = event.kind === 'meal'
      ? [-90, -60, -30, 0, 30, 60, 90, 120, 180]
      : [-120, -60, -30, 0, 30, 60, 90, 120, 180, 240];
    for (const offset of offsets) {
      minuteSet.add(clamp(startMinute + offset, 0, endMinute));
    }
    if (event.endTime) {
      const eventEndMinute = minuteOfDay(event.endTime);
      for (const offset of [-30, 0, 30, 60]) {
        minuteSet.add(clamp(eventEndMinute + offset, 0, endMinute));
      }
    }
  }
  const minutes = Array.from(minuteSet).sort((a, b) => a - b);
  return minutes.map(minute => scoreAtMinute(minute, events, base, bins, hrBase));
}

function nearestStressScore(minute: number, points: StressPoint[]): number {
  if (points.length === 0) return 0;
  return points.reduce((best, point) =>
    Math.abs(point.minute - minute) < Math.abs(best.minute - minute) ? point : best,
  points[0]).score;
}

function averageStressScore(points: StressPoint[], untilMinute = DAY_MINUTES): number {
  if (points.length === 0) return 0;
  const sorted = [...points].sort((a, b) => a.minute - b.minute);
  const endMinute = clamp(untilMinute, 0, DAY_MINUTES);
  if (endMinute <= sorted[0].minute) return sorted[0].score;

  let weighted = 0;
  let minutes = 0;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const start = sorted[i];
    const end = sorted[i + 1];
    if (start.minute >= endMinute) break;
    const segmentEnd = Math.min(end.minute, endMinute);
    const span = Math.max(0, segmentEnd - start.minute);
    if (span <= 0) continue;
    weighted += ((start.score + end.score) / 2) * span;
    minutes += span;
  }

  if (minutes <= 0) return nearestStressScore(endMinute, sorted);
  return Math.round(weighted / minutes);
}

function buildRunningAveragePoints(points: StressPoint[]): StressPoint[] {
  return points.map(point => ({
    minute: point.minute,
    score: averageStressScore(points, point.minute),
    source: 'estimate',
  }));
}

function nearestStressPoint(minute: number, points: StressPoint[]): StressPoint | null {
  if (points.length === 0) return null;
  return points.reduce((best, point) =>
    Math.abs(point.minute - minute) < Math.abs(best.minute - minute) ? point : best,
  points[0]);
}

function stressScoreForMinute(minute: number, points: StressPoint[]): number {
  if (points.length === 0) return 0;
  const sorted = [...points].sort((a, b) => a.minute - b.minute);
  if (minute <= sorted[0].minute) return sorted[0].score;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const start = sorted[i];
    const end = sorted[i + 1];
    if (minute > end.minute) continue;
    const span = Math.max(1, end.minute - start.minute);
    const ratio = clamp((minute - start.minute) / span, 0, 1);
    return Math.round(start.score + (end.score - start.score) * ratio);
  }
  return sorted[sorted.length - 1].score;
}

function eventDistanceFromMinute(event: StressEvent, minute: number): number {
  const start = minuteOfDay(event.time);
  const end = event.endTime ? minuteOfDay(event.endTime) : start;
  if (event.endTime && end >= start && minute >= start && minute <= end) return 0;
  if (event.endTime && end >= start) return Math.min(Math.abs(minute - start), Math.abs(minute - end));
  return Math.abs(minute - start);
}

function nearbyEventsForMinute(minute: number, events: StressEvent[]): StressEvent[] {
  return events
    .map(event => ({ event, distance: eventDistanceFromMinute(event, minute) }))
    .filter(({ event, distance }) => distance <= (event.kind === 'meal' ? 75 : 120))
    .sort((a, b) => a.distance - b.distance || a.event.time.getTime() - b.event.time.getTime())
    .slice(0, 3)
    .map(({ event }) => event);
}

function buildEventTimeLabels(events: StressEvent[], toX: (minute: number) => number, chartWidth: number): LabeledStressEvent[] {
  const labels: LabeledStressEvent[] = [];
  const candidates = events
    .filter(event => event.kind === 'meal' || event.kind === 'workout' || event.source === 'active')
    .slice(0, 10);
  for (const event of candidates) {
    const x = toX(minuteOfDay(event.time));
    const rowZeroBusy = labels.some(label => label.row === 0 && Math.abs(label.x - x) < 42);
    const rowOneBusy = labels.some(label => label.row === 1 && Math.abs(label.x - x) < 42);
    const row = rowZeroBusy && !rowOneBusy ? 1 : 0;
    if (rowZeroBusy && rowOneBusy) continue;
    labels.push({
      event,
      x: clamp(x, 24, chartWidth - 24),
      row,
    });
  }
  return labels;
}

function stressLabel(score: number): { label: string; colorKey: 'success' | 'primary' | 'warning' | 'error' } {
  if (score >= 76) return { label: 'High', colorKey: 'error' };
  if (score >= 58) return { label: 'Elevated', colorKey: 'warning' };
  if (score >= 38) return { label: 'Steady', colorKey: 'primary' };
  return { label: 'Low', colorKey: 'success' };
}

function averageDeltaText(currentScore: number, averageScore: number): string {
  const delta = currentScore - averageScore;
  if (Math.abs(delta) <= 3) return 'near avg so far';
  return `${Math.abs(delta)} ${delta > 0 ? 'above' : 'below'} avg so far`;
}

function baselineCopy(todayAverage: number, usualAverage: number | null | undefined): string | null {
  if (usualAverage == null || !Number.isFinite(usualAverage)) return null;
  const delta = todayAverage - usualAverage;
  const absDelta = Math.abs(delta);
  if (absDelta <= 5) return `About your usual ${Math.round(usualAverage)}`;
  const direction = delta > 0 ? 'above' : 'below';
  const qualifier = absDelta >= 12 ? 'much' : 'a little';
  return `${qualifier} ${direction} usual (${delta > 0 ? '+' : ''}${Math.round(delta)})`;
}

function baselineColorKey(todayAverage: number, usualAverage: number | null | undefined): 'success' | 'primary' | 'warning' | 'error' {
  if (usualAverage == null || !Number.isFinite(usualAverage)) return 'primary';
  const delta = todayAverage - usualAverage;
  if (delta >= 12) return 'error';
  if (delta >= 6) return 'warning';
  if (delta <= -6) return 'success';
  return 'primary';
}

function historyDateLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = parseDate(`${iso.slice(0, 10)}T12:00:00`);
  if (!date) return iso.slice(5, 10);
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function buildTimelineSummary(
  currentScore: number,
  averageScore: number,
  peak: StressPoint | null,
  events: StressEvent[],
  hasHr: boolean,
): string {
  const current = stressLabel(currentScore).label.toLowerCase();
  const comparison = averageDeltaText(currentScore, averageScore);
  const heaviest = events.find(event => event.intensity === 'heavy');
  if (heaviest) return `Today so far: ${current} now - ${comparison}. Biggest marker: ${heaviest.title.toLowerCase()} at ${formatTime(heaviest.time)}.`;
  if (hasHr) return `Today so far: ${current} now - ${comparison}. Heart-rate samples are shaping the curve.`;
  if (events.length > 0 && peak) return `Today so far: ${current} now - ${comparison}. Peak marker lands around ${formatTime(dateAtMinute(startOfLocalDay(), peak.minute))}.`;
  return `Today so far: ${current} now - ${comparison}. No logged meal or activity markers yet.`;
}

function markerTone(intensity: StressIntensity, tc: ReturnType<typeof getTheme>['colors']): string {
  if (intensity === 'heavy') return tc.error ?? '#EF4444';
  if (intensity === 'moderate') return tc.warning ?? '#F59E0B';
  return tc.success ?? '#22C55E';
}

function DailyStressTimelineCard({
  authToken,
  themeName,
  active = true,
  healthEnabled = false,
  healthSummary,
  mealHistory,
  nutritionPlan,
  workoutHistory = [],
  inProgressWorkout,
  showMealProgress = true,
  showWorkoutProgress = true,
}: DailyStressTimelineCardProps) {
  const tc = getTheme(themeName).colors;
  const styles = useMemo(() => createStyles(tc), [tc]);
  const { width } = useWindowDimensions();
  const chartWidth = Math.min(420, Math.max(280, Math.round(width - 56)));
  const chartHeight = 188;
  const plot = { left: 18, right: 18, top: 16, bottom: 42 };
  const plotWidth = chartWidth - plot.left - plot.right;
  const plotHeight = chartHeight - plot.top - plot.bottom;
  const [heartRateSamples, setHeartRateSamples] = useState<HeartRateSample[]>([]);
  const [now, setNow] = useState(() => new Date());
  const [selectedMinute, setSelectedMinute] = useState<number | null>(null);
  const [stressHistory, setStressHistory] = useState<DailyStressHistoryResponse | null>(null);
  const lastStressPersistRef = useRef<string>('');

  const todayKeyValue = dateKey(now);
  const dayStart = useMemo(() => startOfLocalDay(now), [todayKeyValue]);
  const nowMinute = minuteOfDay(now);
  const domainEndMinute = clamp(Math.max(nowMinute, 1), 1, DAY_MINUTES);

  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, [active]);

  useEffect(() => {
    setSelectedMinute(null);
  }, [todayKeyValue]);

  const updateSelectedMinuteFromX = useCallback((rawX: number | null | undefined) => {
    const x = Number(rawX);
    if (!Number.isFinite(x)) return;
    const ratio = clamp((x - plot.left) / plotWidth, 0, 1);
    const minute = Math.round(ratio * domainEndMinute);
    setSelectedMinute(clamp(minute, 0, nowMinute));
  }, [domainEndMinute, nowMinute, plot.left, plotWidth]);

  const chartPanResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_event, gestureState) => Math.abs(gestureState.dx) > 2 || Math.abs(gestureState.dy) > 2,
    onPanResponderGrant: event => updateSelectedMinuteFromX(event.nativeEvent.locationX),
    onPanResponderMove: event => updateSelectedMinuteFromX(event.nativeEvent.locationX),
    onPanResponderTerminationRequest: () => true,
  }), [updateSelectedMinuteFromX]);

  useEffect(() => {
    let cancelled = false;
    if (!active || !healthEnabled) {
      setHeartRateSamples([]);
      return () => { cancelled = true; };
    }
    const end = Date.now();
    const start = dayStart.getTime();
    readHeartRateSamples(start, end, 260)
      .then(samples => {
        if (!cancelled) setHeartRateSamples(samples.filter(sample => isTodayDate(parseDate(sample.startDate), todayKeyValue)));
      })
      .catch(() => {
        if (!cancelled) setHeartRateSamples([]);
      });
    return () => { cancelled = true; };
  }, [active, dayStart, healthEnabled, healthSummary?.fetchedAt, todayKeyValue]);

  const events = useMemo(() => {
    const mealEvents = buildMealEvents(mealHistory, nutritionPlan, todayKeyValue, dayStart, '#14B8A6', showMealProgress);
    const workoutEvents = buildWorkoutEvents(workoutHistory, healthSummary, inProgressWorkout, todayKeyValue, '#6366F1', showWorkoutProgress);
    return [...mealEvents, ...workoutEvents]
      .filter(event => minuteOfDay(event.time) <= nowMinute)
      .sort((a, b) => a.time.getTime() - b.time.getTime());
  }, [dayStart, healthSummary, inProgressWorkout, mealHistory, nowMinute, nutritionPlan, showMealProgress, showWorkoutProgress, todayKeyValue, workoutHistory]);

  const stressPoints = useMemo(
    () => buildStressPoints(events, healthSummary, heartRateSamples, now, nowMinute),
    [events, healthSummary, heartRateSamples, now, nowMinute],
  );
  const runningAveragePoints = useMemo(
    () => buildRunningAveragePoints(stressPoints),
    [stressPoints],
  );
  const currentPoint = stressPoints.find(point => point.minute === nowMinute)
    ?? stressPoints.reduce((best, point) =>
      Math.abs(point.minute - nowMinute) < Math.abs(best.minute - nowMinute) ? point : best,
    stressPoints[0]);
  const currentScore = currentPoint?.score ?? 0;
  const averageScore = averageStressScore(stressPoints, nowMinute);
  const peak = stressPoints.length > 0
    ? stressPoints.reduce((best, point) => point.score > best.score ? point : best, stressPoints[0])
    : null;
  const currentTone = stressLabel(currentScore);
  const currentColor = tc[currentTone.colorKey] ?? tc.primary;
  const averageTone = stressLabel(averageScore);
  const averageColor = tc[averageTone.colorKey] ?? tc.primary;
  const hasHr = stressPoints.some(point => point.source === 'hr');
  const summary = buildTimelineSummary(currentScore, averageScore, peak, events, hasHr);
  const usualAverage = stressHistory?.baseline?.avg_stress ?? null;
  const baselineText = baselineCopy(averageScore, usualAverage);
  const baselineToneKey = baselineColorKey(averageScore, usualAverage);
  const baselineColor = tc[baselineToneKey] ?? tc.primary;
  const historyRows = stressHistory?.rows ?? [];
  const historyTrendRows = historyRows.slice(-14);
  const historyValues = historyTrendRows
    .map(row => Number(row.avg_stress))
    .filter(value => Number.isFinite(value));
  const canShowHistoryTrend = historyValues.length >= 2;

  useEffect(() => {
    if (!active || !authToken) {
      setStressHistory(null);
      return undefined;
    }
    let cancelled = false;
    getDailyStressHistory(authToken, 30, 14, todayKeyValue)
      .then(data => { if (!cancelled) setStressHistory(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [active, authToken, todayKeyValue]);

  useEffect(() => {
    if (!active || !authToken || averageScore <= 0) return undefined;
    let cancelled = false;
    const bucket = Math.floor(Date.now() / (5 * 60 * 1000));
    const persistKey = `${todayKeyValue}:${bucket}`;
    if (lastStressPersistRef.current === persistKey) return undefined;
    lastStressPersistRef.current = persistKey;
    const payload = {
      summary_date: todayKeyValue,
      avg_stress: averageScore,
      max_stress: peak?.score ?? averageScore,
      latest_stress: currentScore,
      sample_count: stressPoints.length,
      source_count: events.length,
      source: hasHr ? 'hr_logs_estimate' : 'logs_estimate',
      source_details: {
        inputs: {
          heart_rate: hasHr,
          meals_or_workouts: events.length,
          points: stressPoints.length,
        },
      },
      computed_at: new Date().toISOString(),
    };
    upsertDailyStressSummary(authToken, payload)
      .then(() => getDailyStressHistory(authToken, 30, 14, todayKeyValue))
      .then(data => { if (!cancelled) setStressHistory(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [active, authToken, averageScore, currentScore, events.length, hasHr, peak?.score, stressPoints.length, todayKeyValue]);

  const toX = (minute: number) => plot.left + (clamp(minute, 0, domainEndMinute) / domainEndMinute) * plotWidth;
  const toY = (score: number) => plot.top + (1 - clamp(score, 0, 100) / 100) * plotHeight;
  const polyPoints = stressPoints.map(point => `${toX(point.minute)},${toY(point.score)}`).join(' ');
  const averagePolyPoints = runningAveragePoints.map(point => `${toX(point.minute)},${toY(point.score)}`).join(' ');
  const areaPoints = stressPoints.length > 1
    ? `${polyPoints} ${toX(stressPoints[stressPoints.length - 1].minute)},${plot.top + plotHeight} ${toX(stressPoints[0].minute)},${plot.top + plotHeight}`
    : '';
  const nowX = toX(nowMinute);
  const eventMarkers = events.slice(0, 12);
  const labeledEventMarkers = buildEventTimeLabels(eventMarkers, toX, chartWidth);
  const selectedMinuteValue = selectedMinute ?? nowMinute;
  const selectedPoint = nearestStressPoint(selectedMinuteValue, stressPoints);
  const selectedScore = stressScoreForMinute(selectedMinuteValue, stressPoints);
  const selectedTone = stressLabel(selectedScore);
  const selectedColor = tc[selectedTone.colorKey] ?? tc.primary;
  const selectedX = toX(selectedMinuteValue);
  const selectedY = toY(selectedScore);
  const selectedAverageScore = averageStressScore(stressPoints, selectedMinuteValue);
  const selectedAverageY = toY(selectedAverageScore);
  const selectedTime = dateAtMinute(dayStart, selectedMinuteValue);
  const selectedEvents = nearbyEventsForMinute(selectedMinuteValue, events);
  const selectedSource = selectedPoint?.source === 'hr'
    ? 'Heart rate sample'
    : selectedEvents.length > 0
      ? 'Logged marker'
      : 'Modeled load';
  const showNowIndicator = Math.abs(selectedMinuteValue - nowMinute) > 2;
  const axisMarks = [0, 0.25, 0.5, 0.75, 1].map(ratio => Math.round(domainEndMinute * ratio));

  return (
    <View testID="daily-stress-timeline-card" style={[styles.card, { borderColor: currentColor + '55' }]}>
      <View style={styles.header}>
        <View style={[styles.iconWrap, { backgroundColor: currentColor + '18' }]}>
          <Ionicons name="pulse-outline" size={18} color={currentColor} />
        </View>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>Today so far</Text>
          <Text style={styles.title} numberOfLines={1}>{currentTone.label}</Text>
        </View>
        <View style={[styles.scorePill, { backgroundColor: currentColor, borderColor: currentColor }]}>
          <Text style={[styles.scoreText, { color: getContrastingTextColor(currentColor) }]}>{currentScore}</Text>
        </View>
      </View>

      <Text style={styles.subtitle} numberOfLines={2}>{summary}</Text>

      <View style={styles.statRow}>
        <View style={styles.stat}>
          <Text style={styles.statLabel}>Now</Text>
          <Text style={[styles.statValue, { color: currentColor }]}>{currentScore}</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statLabel}>Avg so far</Text>
          <Text style={[styles.statValue, { color: averageColor }]}>{averageScore}</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statLabel}>Peak</Text>
          <Text style={styles.statValue}>{peak ? peak.score : '--'}</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statLabel}>Usual</Text>
          <Text style={styles.statSource} numberOfLines={1}>
            {usualAverage != null ? Math.round(usualAverage) : hasHr ? 'HR + logs' : 'Estimate'}
          </Text>
        </View>
      </View>

      {baselineText ? (
        <View style={[styles.baselinePanel, { borderColor: baselineColor + '44', backgroundColor: baselineColor + '0D' }]}>
          <View style={[styles.baselineIcon, { backgroundColor: baselineColor + '18' }]}>
            <Ionicons name="analytics-outline" size={13} color={baselineColor} />
          </View>
          <View style={styles.baselineCopy}>
            <Text style={[styles.baselineTitle, { color: baselineColor }]} numberOfLines={1}>
              {baselineText}
            </Text>
            <Text style={styles.baselineDetail} numberOfLines={1}>
              {stressHistory?.baseline?.days_with_data ?? 0} days in your {stressHistory?.baseline?.window_days ?? 14}d baseline
            </Text>
          </View>
        </View>
      ) : null}

      {canShowHistoryTrend ? (() => {
        const trendWidth = Math.min(390, Math.max(260, chartWidth - 12));
        const trendHeight = 58;
        const trendPad = { left: 8, right: 8, top: 8, bottom: 14 };
        const values = historyTrendRows.map(row => Number(row.avg_stress)).filter(value => Number.isFinite(value));
        const minValue = Math.min(...values);
        const maxValue = Math.max(...values);
        const span = Math.max(1, maxValue - minValue);
        const usableW = trendWidth - trendPad.left - trendPad.right;
        const usableH = trendHeight - trendPad.top - trendPad.bottom;
        const coords = historyTrendRows
          .map((row, index) => {
            const value = Number(row.avg_stress);
            if (!Number.isFinite(value)) return null;
            const x = trendPad.left + (historyTrendRows.length <= 1 ? 0.5 : index / (historyTrendRows.length - 1)) * usableW;
            const y = trendPad.top + (1 - (value - minValue) / span) * usableH;
            return { x, y, value, date: row.summary_date };
          })
          .filter((point): point is { x: number; y: number; value: number; date: string } => point != null);
        const points = coords.map(point => `${point.x},${point.y}`).join(' ');
        const first = coords[0];
        const last = coords[coords.length - 1];
        return (
          <View style={styles.historyTrend}>
            <View style={styles.historyTrendHeader}>
              <Text style={styles.historyTrendTitle}>Daily avg history</Text>
              <Text style={[styles.historyTrendValue, { color: baselineColor }]}>
                {last ? Math.round(last.value) : '--'} latest
              </Text>
            </View>
            <Svg width={trendWidth} height={trendHeight}>
              <Line x1={trendPad.left} y1={trendPad.top + usableH} x2={trendWidth - trendPad.right} y2={trendPad.top + usableH} stroke={tc.border} strokeWidth={1} />
              <Polyline points={points} fill="none" stroke={baselineColor} strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" />
              {coords.map((point, index) => (
                <Circle key={`${point.date}-${index}`} cx={point.x} cy={point.y} r={index === coords.length - 1 ? 4 : 2.6} fill={index === coords.length - 1 ? baselineColor : tc.textMuted} opacity={index === coords.length - 1 ? 1 : 0.7} />
              ))}
              {first ? <SvgText x={first.x} y={trendHeight - 3} fill={tc.textMuted} fontSize={9} fontWeight="800" textAnchor="start">{historyDateLabel(first.date)}</SvgText> : null}
              {last ? <SvgText x={last.x} y={trendHeight - 3} fill={tc.textMuted} fontSize={9} fontWeight="800" textAnchor="end">{historyDateLabel(last.date)}</SvgText> : null}
            </Svg>
          </View>
        );
      })() : null}

      <View style={styles.chartWrap}>
        <View style={[styles.svgStage, { width: chartWidth, height: chartHeight }]}>
          <Svg width={chartWidth} height={chartHeight}>
            {[25, 50, 75].map(value => (
              <Line
                key={value}
                x1={plot.left}
                y1={toY(value)}
                x2={chartWidth - plot.right}
                y2={toY(value)}
                stroke={tc.border}
                strokeWidth={1}
                strokeDasharray="4,5"
              />
            ))}
            {areaPoints ? <Polygon points={areaPoints} fill={currentColor + '18'} /> : null}
            {averagePolyPoints ? (
              <Polyline
                points={averagePolyPoints}
                fill="none"
                stroke={averageColor}
                strokeWidth={2}
                strokeOpacity={0.68}
                strokeDasharray="5,6"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ) : null}
            {polyPoints ? (
              <Polyline
                points={polyPoints}
                fill="none"
                stroke={currentColor}
                strokeWidth={3}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ) : null}
            {eventMarkers.map(event => {
              const minute = minuteOfDay(event.time);
              const x = toX(minute);
              const y = toY(nearestStressScore(minute, stressPoints));
              const color = markerTone(event.intensity, tc);
              return (
                <React.Fragment key={event.id}>
                  <Line
                    x1={x}
                    y1={plot.top}
                    x2={x}
                    y2={plot.top + plotHeight}
                    stroke={color + '55'}
                    strokeWidth={1}
                    strokeDasharray="3,5"
                  />
                  <Circle cx={x} cy={y} r={5.5} fill={color} stroke={tc.surface} strokeWidth={2} />
                </React.Fragment>
              );
            })}
            {labeledEventMarkers.map(({ event, x, row }) => {
              const color = markerTone(event.intensity, tc);
              return (
                <SvgText
                  key={`label-${event.id}`}
                  x={x}
                  y={chartHeight - 25 + row * 13}
                  fill={color}
                  fontSize={9}
                  fontWeight="800"
                  textAnchor="middle">
                  {formatTime(event.time)}
                </SvgText>
              );
            })}
            {showNowIndicator ? (
              <>
                <Line
                  x1={nowX}
                  y1={plot.top}
                  x2={nowX}
                  y2={plot.top + plotHeight}
                  stroke={tc.textPrimary}
                  strokeWidth={1.1}
                  strokeOpacity={0.36}
                />
                <Circle cx={nowX} cy={toY(currentScore)} r={4.2} fill={tc.textPrimary} stroke={tc.surface} strokeWidth={1.5} />
              </>
            ) : null}
            <Line
              x1={selectedX}
              y1={plot.top - 2}
              x2={selectedX}
              y2={plot.top + plotHeight + 2}
              stroke={selectedColor}
              strokeWidth={2}
              strokeOpacity={0.9}
            />
            <Circle cx={selectedX} cy={selectedAverageY} r={4} fill={averageColor} stroke={tc.surface} strokeWidth={1.5} />
            <Circle cx={selectedX} cy={selectedY} r={7} fill={selectedColor} stroke={tc.surface} strokeWidth={2.5} />
          </Svg>
          <View
            {...chartPanResponder.panHandlers}
            accessibilityRole="adjustable"
            accessibilityLabel="daily-stress-timeline-scrubber"
            style={styles.chartTouchArea}
          />
        </View>
        <View style={[styles.axisRow, { width: chartWidth }]}>
          {axisMarks.map((minute, index) => (
            <Text key={`${minute}-${index}`} style={styles.axisText}>
              {index === axisMarks.length - 1 ? formatAxisMinute(nowMinute) : formatAxisMinute(minute)}
            </Text>
          ))}
        </View>
      </View>

      <View style={[styles.selectionPanel, { borderColor: selectedColor + '44', backgroundColor: selectedColor + '0D' }]}>
        <View style={styles.selectionHeader}>
          <View style={styles.selectionTimeWrap}>
            <Text style={[styles.selectionTime, { color: selectedColor }]} numberOfLines={1}>
              {selectedMinute == null ? `Now - ${formatTime(now)}` : formatTime(selectedTime)}
            </Text>
            <Text style={styles.selectionSource} numberOfLines={1}>
              {selectedSource} - avg {selectedAverageScore} by {selectedMinute == null ? 'now' : 'then'}
            </Text>
          </View>
          <View style={[styles.selectionScore, { backgroundColor: selectedColor + '18', borderColor: selectedColor + '55' }]}>
            <Text style={[styles.selectionScoreValue, { color: selectedColor }]}>{selectedScore}</Text>
            <Text style={styles.selectionScoreLabel}>{selectedTone.label}</Text>
          </View>
        </View>
        {selectedEvents.length > 0 ? (
          <View style={styles.selectionEvents}>
            {selectedEvents.map(event => {
              const color = markerTone(event.intensity, tc);
              return (
                <View key={`selected-${event.id}`} style={styles.selectionEventRow}>
                  <View style={[styles.selectionEventIcon, { backgroundColor: color + '18' }]}>
                    <Ionicons name={event.icon} size={12} color={color} />
                  </View>
                  <Text style={[styles.selectionEventTime, { color }]} numberOfLines={1}>{formatTime(event.time)}</Text>
                  <Text style={styles.selectionEventText} numberOfLines={1}>
                    {event.title} - {event.detail}
                  </Text>
                </View>
              );
            })}
          </View>
        ) : (
          <Text style={styles.selectionEmpty} numberOfLines={1}>No meal, workout, or activity marker near this time.</Text>
        )}
      </View>

      {events.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.markerRail}>
          {events.map(event => {
            const color = markerTone(event.intensity, tc);
            return (
              <View key={event.id} style={[styles.markerChip, { borderColor: color + '44', backgroundColor: color + '10' }]}>
                <View style={[styles.markerIcon, { backgroundColor: color + '18' }]}>
                  <Ionicons name={event.icon} size={13} color={color} />
                </View>
                <View style={styles.markerCopy}>
                  <Text style={[styles.markerTime, { color }]} numberOfLines={1}>{formatTime(event.time)}</Text>
                  <Text style={styles.markerTitle} numberOfLines={1}>{event.title}</Text>
                  <Text style={styles.markerDetail} numberOfLines={1}>{event.detail}</Text>
                </View>
              </View>
            );
          })}
        </ScrollView>
      ) : (
        <View style={styles.emptyMarkers}>
          <Ionicons name="time-outline" size={14} color={tc.textMuted} />
          <Text style={styles.emptyText}>Meals, workouts, and detected activity will appear here today.</Text>
        </View>
      )}
    </View>
  );
}

function createStyles(tc: ReturnType<typeof getTheme>['colors']) {
  return StyleSheet.create({
    card: {
      backgroundColor: tc.surface,
      borderRadius: radius.lg,
      borderWidth: 1.5,
      padding: 14,
      marginBottom: 12,
      ...elevations.subtle,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    iconWrap: {
      width: 38,
      height: 38,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerCopy: {
      flex: 1,
      minWidth: 0,
    },
    eyebrow: {
      fontSize: 10,
      lineHeight: 13,
      fontWeight: '900',
      textTransform: 'uppercase',
      color: tc.textMuted,
    },
    title: {
      fontSize: 18,
      lineHeight: 22,
      fontWeight: '900',
      color: tc.textPrimary,
      marginTop: 1,
    },
    scorePill: {
      minWidth: 46,
      minHeight: 34,
      borderRadius: 12,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 10,
    },
    scoreText: {
      fontSize: 18,
      lineHeight: 22,
      fontWeight: '900',
      fontVariant: ['tabular-nums'] as any,
    },
    subtitle: {
      color: tc.textSecondary,
      fontSize: 12,
      lineHeight: 17,
      fontWeight: '700',
      marginTop: 9,
    },
    statRow: {
      flexDirection: 'row',
      gap: 8,
      marginTop: 12,
    },
    stat: {
      flex: 1,
      minHeight: 56,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: tc.border,
      backgroundColor: tc.surfaceRaised,
      paddingHorizontal: 8,
      paddingVertical: 7,
      justifyContent: 'center',
    },
    statLabel: {
      fontSize: 9,
      lineHeight: 12,
      fontWeight: '900',
      color: tc.textMuted,
      textTransform: 'uppercase',
    },
    statValue: {
      fontSize: 17,
      lineHeight: 21,
      fontWeight: '900',
      color: tc.textPrimary,
      marginTop: 2,
      fontVariant: ['tabular-nums'] as any,
    },
    statSource: {
      fontSize: 12,
      lineHeight: 15,
      fontWeight: '900',
      color: tc.textPrimary,
      marginTop: 4,
    },
    baselinePanel: {
      minHeight: 44,
      borderRadius: radius.md,
      borderWidth: 1,
      paddingHorizontal: 10,
      paddingVertical: 8,
      marginTop: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    baselineIcon: {
      width: 26,
      height: 26,
      borderRadius: 9,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    baselineCopy: {
      flex: 1,
      minWidth: 0,
    },
    baselineTitle: {
      fontSize: 12,
      lineHeight: 15,
      fontWeight: '900',
    },
    baselineDetail: {
      color: tc.textMuted,
      fontSize: 10,
      lineHeight: 13,
      fontWeight: '800',
      marginTop: 1,
    },
    historyTrend: {
      marginTop: 10,
      paddingTop: 8,
      borderTopWidth: 1,
      borderTopColor: tc.border,
      alignItems: 'center',
    },
    historyTrendHeader: {
      width: '100%',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      marginBottom: 2,
    },
    historyTrendTitle: {
      color: tc.textMuted,
      fontSize: 10,
      lineHeight: 13,
      fontWeight: '900',
      textTransform: 'uppercase',
    },
    historyTrendValue: {
      fontSize: 11,
      lineHeight: 14,
      fontWeight: '900',
    },
    chartWrap: {
      alignItems: 'center',
      marginTop: 12,
      paddingTop: 4,
    },
    svgStage: {
      position: 'relative',
    },
    chartTouchArea: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'transparent',
    },
    axisRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 10,
      marginTop: -2,
    },
    axisText: {
      color: tc.textMuted,
      fontSize: 10,
      lineHeight: 12,
      fontWeight: '800',
    },
    selectionPanel: {
      borderRadius: radius.md,
      borderWidth: 1,
      paddingHorizontal: 10,
      paddingVertical: 9,
      marginTop: 10,
    },
    selectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    selectionTimeWrap: {
      flex: 1,
      minWidth: 0,
    },
    selectionTime: {
      fontSize: 13,
      lineHeight: 16,
      fontWeight: '900',
    },
    selectionSource: {
      color: tc.textMuted,
      fontSize: 10,
      lineHeight: 13,
      fontWeight: '800',
      marginTop: 1,
      textTransform: 'uppercase',
    },
    selectionScore: {
      minWidth: 58,
      minHeight: 42,
      borderRadius: 12,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 8,
    },
    selectionScoreValue: {
      fontSize: 16,
      lineHeight: 19,
      fontWeight: '900',
      fontVariant: ['tabular-nums'] as any,
    },
    selectionScoreLabel: {
      color: tc.textMuted,
      fontSize: 9,
      lineHeight: 11,
      fontWeight: '900',
      textTransform: 'uppercase',
      marginTop: 1,
    },
    selectionEvents: {
      gap: 6,
      marginTop: 9,
    },
    selectionEventRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      minHeight: 22,
    },
    selectionEventIcon: {
      width: 22,
      height: 22,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    selectionEventTime: {
      width: 50,
      fontSize: 10,
      lineHeight: 13,
      fontWeight: '900',
      textTransform: 'uppercase',
    },
    selectionEventText: {
      flex: 1,
      minWidth: 0,
      color: tc.textPrimary,
      fontSize: 11,
      lineHeight: 14,
      fontWeight: '800',
    },
    selectionEmpty: {
      color: tc.textMuted,
      fontSize: 11,
      lineHeight: 14,
      fontWeight: '700',
      marginTop: 8,
    },
    markerRail: {
      gap: 8,
      paddingTop: 12,
      paddingRight: 4,
    },
    markerChip: {
      width: 176,
      minHeight: 74,
      borderRadius: radius.md,
      borderWidth: 1,
      padding: 9,
      flexDirection: 'row',
      gap: 8,
    },
    markerIcon: {
      width: 28,
      height: 28,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    markerCopy: {
      flex: 1,
      minWidth: 0,
    },
    markerTime: {
      fontSize: 10,
      lineHeight: 12,
      fontWeight: '900',
      textTransform: 'uppercase',
    },
    markerTitle: {
      color: tc.textPrimary,
      fontSize: 12,
      lineHeight: 15,
      fontWeight: '900',
      marginTop: 2,
    },
    markerDetail: {
      color: tc.textMuted,
      fontSize: 10,
      lineHeight: 13,
      fontWeight: '700',
      marginTop: 2,
    },
    emptyMarkers: {
      minHeight: 46,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: tc.border,
      backgroundColor: tc.surfaceRaised,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 11,
      paddingVertical: 9,
      marginTop: 12,
    },
    emptyText: {
      flex: 1,
      minWidth: 0,
      color: tc.textMuted,
      fontSize: 11,
      lineHeight: 15,
      fontWeight: '700',
    },
  });
}

export default memo(DailyStressTimelineCard);
